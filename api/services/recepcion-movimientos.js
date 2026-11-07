"use strict";

const U = require("../../predios/lib/util");
const { opcionesFiltros } = require("./recepcion-filtros");

// Sin `tam` se pagina de a 40, como antes: un cliente anterior sólo mira `siguiente`.
const TAM = 40;
const TAM_MAX = 200;
const ORIGENES = ["RECEPCION", "TURISMO", "CUENTA"];

// Turismo y la réplica del predio pueden tener colaciones distintas.
const textoSql = expr => `CONVERT(${expr} USING utf8mb4) COLLATE utf8mb4_0900_ai_ci`;
const textoJson = (doc, campo) => `JSON_UNQUOTE(JSON_EXTRACT(${doc}, '$.${campo}'))`;
const literal = s => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
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

// Campo de `cambios` que da nombre a una operación de recepción, en el orden en que se nombran.
const OPERACIONES_POR_CAMPO = [
  ["Traslado", "Traslado"],
  ["Adicional", "Cambio de adicionales"],
  ["Vehículo", "Vehículos"],
  ["Salida de vehículos", "Vehículos"],
  ["Ubicación", "Ubicación"]
];

function operacionRecepcion(antes, despues, cambios) {
  if (!antes) return "Alta de reserva";
  const previos = new Map((antes.personas || []).map(p => [String(p.dni), p]));
  const operaciones = new Set();
  for (const p of despues.personas || []) {
    const previo = previos.get(String(p.dni));
    if (p.entrada && p.entrada !== previo?.entrada) operaciones.add("Ingreso");
    if (p.salida && p.salida !== previo?.salida) operaciones.add("Salida");
  }
  for (const [campo, operacion] of OPERACIONES_POR_CAMPO) {
    if (cambios.some(([c]) => c === campo)) operaciones.add(operacion);
  }
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

// ------------------------------------------------------------------ orden por columna
// Las claves se ordenan como se ven en la tabla: en los eventos de recepción servicio, recurso,
// adicionales y movimiento salen del evento (contextoHistorico y operacionRecepcion), no de la reserva.
// Un texto vacío o un null de JSON (JSON_UNQUOTE lo devuelve como 'null') no cuentan.
const datoEvento = (doc, campo) => `NULLIF(NULLIF(${textoSql(textoJson(doc, campo))},'null'),'')`;
const primerDato = (campos, respaldo) => `COALESCE(${["l.anterior", "l.actual"]
  .flatMap(doc => campos.map(campo => datoEvento(doc, campo))).concat(respaldo || []).join(",")})`;

// Mismos rótulos que la pantalla para los conceptos de la cuenta de estadía.
const CONCEPTOS_CUENTA = {
  CARGA: "Carga de saldo", RETIRO: "Retiro de saldo", REPARTO: "Reparto de saldo",
  COMPRA: "Compra", ANULACION: "Anulación de compra", SALDAR_CONSUMOS: "Liquidación de consumos",
  PAGO_RESERVA: "Pago de diferencia", PAGO_ADICIONAL: "Pago de artículo", DIFERENCIAL: "Diferencia de precio",
  CIERRE_SALIDA: "Cierre de cuenta por salida", PAGO_SALIDA_CONSUMOS: "Consumos liquidados al salir",
  TRASPASO_ALOJAMIENTO: "Traslado de deuda de alojamiento", TRASPASO_CONSUMOS: "Traslado de deuda de consumos"
};
const personasEvento = (doc, campo, alias) => `JSON_TABLE(COALESCE(${doc},'{}'),'$.personas[*]' COLUMNS(
  dni VARCHAR(64) PATH '$.dni', ${campo} VARCHAR(64) PATH '$.${campo}')) ${alias}`;
// Alguien con una fecha de ingreso (o de salida) distinta de la que tenía, como en operacionRecepcion.
const fechaNuevaSql = campo => `EXISTS (SELECT 1 FROM ${personasEvento("l.actual", campo, "ahora")}
  WHERE COALESCE(ahora.${campo},'')<>'' AND NOT EXISTS (SELECT 1 FROM ${personasEvento("l.anterior", campo, "previo")}
    WHERE previo.dni=ahora.dni AND previo.${campo}=ahora.${campo}))`;
// El evento guarda en `actual.cambios` los cambios que registró.
const cambioSql = campo => `JSON_CONTAINS(COALESCE(JSON_EXTRACT(l.actual,'$.cambios[*][0]'),JSON_ARRAY()),${literal(JSON.stringify(campo))})`;
const operacionSql = `CASE WHEN l.anterior IS NULL THEN 'Alta de reserva' ELSE COALESCE(NULLIF(CONCAT_WS(' · ',
    IF(${fechaNuevaSql("entrada")},'Ingreso',NULL),
    IF(${fechaNuevaSql("salida")},'Salida',NULL),
    ${OPERACIONES_POR_CAMPO.map(([campo, nombre]) => `IF(${cambioSql(campo)},${literal(nombre)},NULL)`).join(",\n    ")}),''),
    'Cambio de reserva') END`;
const movimientoSql = `CASE l.origen
    WHEN 'CUENTA' THEN ${textoSql(`CASE l.concepto ${Object.entries(CONCEPTOS_CUENTA)
    .map(([codigo, nombre]) => `WHEN ${literal(codigo)} THEN ${literal(nombre)}`).join(" ")} ELSE l.concepto END`)}
    WHEN 'TURISMO' THEN ${textoSql("COALESCE(l.concepto,'Cambio de reserva')")}
    ELSE ${textoSql(operacionSql)} END`;

// Lista blanca: clave de la columna → [expresión sobre el listado, puede quedar vacía]. Los vacíos van al final.
const ORDEN = {
  reserva_id: ["l.reserva_id", false],
  titular: [textoSql("l.titular"), true],
  servicio: [primerDato(["servicio"], textoSql("l.servicio")), true],
  recurso: [primerDato(["recursos[0].nombre", "recurso"], textoSql("l.recurso")), true],
  adicionales: [`CASE WHEN l.origen='RECEPCION' THEN ${primerDato(["adicionales[0].nombre"])} ELSE ${textoSql("l.adicionales")} END`, true],
  concepto: [movimientoSql, false],
  origen: ["l.origen", false],
  actor: ["l.actor", true],
  importe: ["l.importe", true]
};

function ordenSql(b) {
  const dir = b.dir ? U.opcion(b.dir, ["ASC", "DESC"], "El sentido del orden") : "DESC";
  const columna = typeof b.orden === "string" && Object.hasOwn(ORDEN, b.orden) ? ORDEN[b.orden] : null;
  // Desempate estable: el mismo instante puede tener movimientos de los tres orígenes.
  if (!columna) return `l.fecha ${dir},l.origen ASC,l.id ${dir}`;
  const [expr, vacios] = columna;
  return (vacios ? `(${expr}) IS NULL,` : "") + `${expr} ${dir},l.fecha DESC,l.origen ASC,l.id DESC`;
}

const leerJson = v => typeof v === "string" ? JSON.parse(v) : v ?? null;

async function listarMovimientos(c, codigos, predioId, b, resumenCambios) {
  // Opciones de los filtros sin consultar movimientos (la tabla las pide antes de la primera página).
  if (b.solo_filtros === "1") return { filtros: await opcionesFiltros(c, codigos) };
  const pedida = U.id(b.pagina || 1, "La página");
  if (pedida > 999999) throw U.error("La página no es válida.");
  const tam = U.entero(b.tam || TAM, { min: 1, max: TAM_MAX, campo: "La cantidad por página" });
  const orden = ordenSql(b);
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

  // El conteo y la página usan el mismo CTE (`listado`), con las mismas condiciones y parámetros.
  const consulta = `WITH reservas_predio AS (
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
  ), listado AS (
    SELECT m.*,DATE_FORMAT(m.fecha,'%Y-%m-%d %H:%i:%s') AS fecha_local,
      CONCAT_WS(', ',u.apellido,u.nombre) AS titular,r.servicio,
      NULLIF(CONCAT_WS(', ',rc.nombre,(SELECT GROUP_CONCAT(otro.nombre ORDER BY otro.nombre SEPARATOR ', ')
        FROM recepcion_reserva_recurso rr JOIN recurso otro ON otro.id=rr.recurso_id WHERE rr.reserva_id=r.id)),'') AS recurso,
      (SELECT GROUP_CONCAT(DISTINCT ra.nombre_adicional ORDER BY ra.nombre_adicional SEPARATOR ', ')
        FROM reserva_adicional ra WHERE ra.reserva_id=r.id) AS adicionales
    FROM movimientos m JOIN reservas_predio r ON r.id=m.reserva_id
      JOIN usuario u ON u.id=r.usuario_id LEFT JOIN recurso rc ON rc.id=r.recurso_id
    WHERE ${condiciones.join(" AND ")}
  )`;

  const [[conteo]] = await c.query(`${consulta}\n  SELECT COUNT(*) AS total FROM listado`, params);
  const total = Number(conteo?.total) || 0;
  const paginas = Math.max(1, Math.ceil(total / tam));
  // Una página recordada que ya no existe (otros filtros, movimientos borrados) muestra la última.
  const pagina = Math.min(pedida, paginas);
  const [filas] = total ? await c.query(`${consulta}\n  SELECT * FROM listado l ORDER BY ${orden} LIMIT ? OFFSET ?`,
    [...params, tam, (pagina - 1) * tam]) : [[]];

  const respuesta = {
    pagina,
    tam,
    total,
    paginas,
    siguiente: pagina < paginas,
    filas: filas.map(({ fecha_local, fecha, actual, anterior, valor_anterior, valor_nuevo, ...f }) => {
      f.fecha = fecha_local;
      if (f.origen === "CUENTA") return f;
      if (f.origen === "TURISMO") {
        return { ...f, concepto: f.concepto || "Cambio de reserva", cambios: [[f.concepto || "Reserva", valor_anterior, valor_nuevo]] };
      }
      const antes = leerJson(anterior), despues = leerJson(actual);
      const cambios = resumenCambios(antes, despues);
      return { ...f, ...contextoHistorico(antes, despues, f), concepto: operacionRecepcion(antes, despues, cambios), cambios };
    })
  };
  if (b.filtros === "1") respuesta.filtros = await opcionesFiltros(c, codigos);
  return respuesta;
}

module.exports = { listarMovimientos };
