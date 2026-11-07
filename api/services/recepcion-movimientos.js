"use strict";

const U = require("../../predios/lib/util");
const { opcionesFiltros } = require("./recepcion-filtros");

const TAM = 40;
const ORIGENES = ["RECEPCION", "TURISMO", "CUENTA"];

// Turismo y la réplica del predio pueden tener colaciones distintas.
const textoSql = expr => `CONVERT(${expr} USING utf8mb4) COLLATE utf8mb4_0900_ai_ci`;
const textoJson = (doc, campo) => `JSON_UNQUOTE(JSON_EXTRACT(${doc}, '$.${campo}'))`;
function contieneId(doc, lista, campo) {
  return `EXISTS (
    SELECT 1 FROM JSON_TABLE(COALESCE(${doc}, '{}'), '$.${lista}[*]' COLUMNS (
      elemento_id BIGINT PATH '$.${campo}')) filtro WHERE filtro.elemento_id=?
  )`;
}

function filtrosReserva(f, doc) {
  const cond = [], params = [];
  if (f.servicio) {
    cond.push(doc ? `${textoJson(doc, "servicio_id")}=?` : "r.servicio_id=?");
    params.push(doc ? String(f.servicio) : f.servicio);
  }
  if (f.recurso) {
    cond.push(doc ? `(${textoJson(doc, "recurso_id")}=? OR ${contieneId(doc, "recursos", "id")})` :
      "(r.recurso_id=? OR EXISTS (SELECT 1 FROM recepcion_reserva_recurso rr WHERE rr.reserva_id=r.id AND rr.recurso_id=?))");
    params.push(doc ? String(f.recurso) : f.recurso, f.recurso);
  }
  if (f.adicional) {
    cond.push(doc ? contieneId(doc, "adicionales", "adicional_id") :
      "EXISTS (SELECT 1 FROM reserva_adicional ra WHERE ra.reserva_id=r.id AND ra.adicional_id=?)");
    params.push(f.adicional);
  }
  return { sql: cond.join(" AND "), params };
}

function operacionRecepcion(antes, despues, cambios) {
  if (!antes) return "Alta de reserva";
  const previos = new Map((antes.personas || []).map(p => [String(p.dni), p]));
  const operaciones = new Set();
  for (const p of despues.personas || []) {
    const previo = previos.get(String(p.dni));
    if (p.entrada && p.entrada !== previo?.entrada) operaciones.add("Ingreso");
    if (p.salida && p.salida !== previo?.salida) operaciones.add("Salida");
  }
  if (cambios.some(([campo]) => campo === "Traslado")) operaciones.add("Traslado");
  if (cambios.some(([campo]) => campo === "Adicional")) operaciones.add("Cambio de adicionales");
  return [...operaciones].join(" · ") || "Cambio de reserva";
}

function contextoHistorico(antes, despues, fila) {
  const nombres = (xs, obtener) => xs.map(obtener).filter(Boolean).join(", ");
  const transicion = (a, b) => a && a !== b && b ? a + " → " + b : b || a;
  const recursos = r => r && (nombres(r.recursos || [], x => x.nombre) || r.recurso);
  const adicionales = r => r?.adicionales && nombres(r.adicionales, a => a.nombre);
  return {
    servicio: transicion(antes?.servicio, despues.servicio) || fila.servicio,
    recurso: transicion(recursos(antes), recursos(despues)) || fila.recurso,
    adicionales: transicion(adicionales(antes), adicionales(despues)) || null
  };
}

async function listarMovimientos(c, codigos, predioId, b, resumenCambios) {
  const pagina = U.id(b.pagina || 1, "La página");
  if (pagina > 999999) throw U.error("La página no es válida.");
  const desde = U.fecha(b.desde, { campo: "La fecha desde" });
  const hasta = U.fecha(b.hasta, { campo: "La fecha hasta" });
  if (desde && hasta && desde > hasta) throw U.error("La fecha desde tiene que ser anterior o igual a la fecha hasta.");

  const condiciones = ["1=1"], params = [codigos, predioId, predioId];
  if (desde) { condiciones.push("m.fecha>=?"); params.push(desde); }
  if (hasta) { condiciones.push("m.fecha<?"); params.push(U.sumarDias(hasta, 1)); }
  if (b.origen) {
    condiciones.push("m.origen=?");
    params.push(U.opcion(b.origen, ORIGENES, "El origen"));
  }
  const q = U.texto(b.q, { max: 80 });
  if (q) {
    const id = /^(?:T-)?(\d+)$/i.exec(q);
    const like = "%" + q.replace(/,\s*/g, " ").replace(/[!%_]/g, "!$&") + "%";
    condiciones.push(`(r.id=? OR CONCAT_WS(' ',u.apellido,u.nombre) LIKE ? ESCAPE '!'
      OR CONCAT_WS(' ',u.nombre,u.apellido) LIKE ? ESCAPE '!' OR m.actor LIKE ? ESCAPE '!')`);
    params.push(id ? Number(id[1]) : 0, like, like, like);
  }
  const filtros = {
    servicio: U.id(b.servicio_id, "El servicio", false),
    recurso: U.id(b.recurso_id, "El recurso", false),
    adicional: U.id(b.adicional_id, "El adicional", false)
  };
  const vigente = filtrosReserva(filtros);
  if (vigente.sql) {
    const actual = filtrosReserva(filtros, "m.actual");
    const anterior = filtrosReserva(filtros, "m.anterior");
    condiciones.push(`((m.origen<>'RECEPCION' AND (${vigente.sql}))
      OR (m.origen='RECEPCION' AND ((${actual.sql}) OR (${anterior.sql}))))`);
    params.push(...vigente.params, ...actual.params, ...anterior.params);
  }

  const [filas] = await c.query(`WITH reservas_predio AS (
    SELECT r.id,r.usuario_id,r.servicio_id,r.recurso_id,s.nombre AS servicio
    FROM reserva r JOIN servicio s ON s.id=r.servicio_id WHERE s.codigo IN (?)
  ), movimientos AS (
    SELECT e.id,e.reserva_id,e.fecha,'RECEPCION' AS origen,NULL AS concepto,${textoSql("e.actor")} AS actor,
      ${textoSql("e.motivo")} AS detalle,NULL AS valor_anterior,NULL AS valor_nuevo,e.anterior,e.actual,NULL AS importe,NULL AS medio
      FROM recepcion_reserva_evento e JOIN reservas_predio r ON r.id=e.reserva_id WHERE e.predio_id=?
    UNION ALL
    SELECT h.id,h.reserva_id,h.fecha_modificacion,'TURISMO',${textoSql("h.campo_modificado")},
      ${textoSql("NULLIF(CONCAT_WS(' ',modificador.nombre,modificador.apellido),'')")},
      ${textoSql("h.observaciones")},h.valor_anterior,h.valor_nuevo,NULL,NULL,NULL,NULL
      FROM historial_reserva h JOIN reservas_predio r ON r.id=h.reserva_id
      LEFT JOIN usuario modificador ON modificador.id=h.usuario_modificador_id
      WHERE COALESCE(h.observaciones,'') NOT LIKE 'Operación atípica · %'
    UNION ALL
    SELECT p.id,p.reserva_id,p.fecha,'CUENTA',${textoSql("p.concepto")},${textoSql("p.usuario_nombre")},
      ${textoSql("NULLIF(CONCAT_WS(' · ',hp.nombre,p.detalle),'')")},NULL,NULL,NULL,NULL,p.importe,p.medio
      FROM predio_estadia_mov p JOIN reservas_predio r ON r.id=p.reserva_id LEFT JOIN predio_huesped hp
        ON hp.predio_id=p.predio_id AND hp.reserva_id=p.reserva_id AND hp.id=p.huesped_id
      WHERE p.predio_id=?
  )
  SELECT m.*,DATE_FORMAT(m.fecha,'%Y-%m-%d %H:%i:%s') AS fecha_local,
    CONCAT_WS(', ',u.apellido,u.nombre) AS titular,r.servicio,
    NULLIF(CONCAT_WS(', ',rc.nombre,(SELECT GROUP_CONCAT(otro.nombre ORDER BY otro.nombre SEPARATOR ', ')
      FROM recepcion_reserva_recurso rr JOIN recurso otro ON otro.id=rr.recurso_id WHERE rr.reserva_id=r.id)),'') AS recurso,
    (SELECT GROUP_CONCAT(DISTINCT ra.nombre_adicional ORDER BY ra.nombre_adicional SEPARATOR ', ')
      FROM reserva_adicional ra WHERE ra.reserva_id=r.id) AS adicionales
  FROM movimientos m JOIN reservas_predio r ON r.id=m.reserva_id
    JOIN usuario u ON u.id=r.usuario_id LEFT JOIN recurso rc ON rc.id=r.recurso_id
  WHERE ${condiciones.join(" AND ")}
  ORDER BY m.fecha DESC,m.origen ASC,m.id DESC LIMIT ? OFFSET ?`, [...params, TAM + 1, (pagina - 1) * TAM]);

  const respuesta = {
    pagina,
    siguiente: filas.length > TAM,
    filas: filas.slice(0, TAM).map(({ fecha_local, fecha, actual, anterior, valor_anterior, valor_nuevo, ...f }) => {
      f.fecha = fecha_local;
      if (f.origen === "CUENTA") return f;
      if (f.origen === "TURISMO") {
        return { ...f, concepto: f.concepto || "Cambio de reserva", cambios: [[f.concepto || "Reserva", valor_anterior, valor_nuevo]] };
      }
      const antes = JSON.parse(anterior), despues = JSON.parse(actual);
      const cambios = resumenCambios(antes, despues);
      return { ...f, ...contextoHistorico(antes, despues, f), concepto: operacionRecepcion(antes, despues, cambios), cambios };
    })
  };
  if (b.filtros === "1") respuesta.filtros = await opcionesFiltros(c, codigos);
  return respuesta;
}

module.exports = { listarMovimientos };
