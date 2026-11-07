"use strict";

// La reserva, sus tarifas, su historial y el recibo de reintento se confirman juntos en Turismo.
const U = require("../../predios/lib/util");
const { recursoUnico, MENSAJE_RECURSO_UNICO } = require("./reserva-recurso-unico");
const { crearAdicional, seleccionArticulos, cotizarAlquileres } = require("./recepcion-alquileres");
const VEHICULOS = require("./recepcion-vehiculos");
const { repartir } = require("../../predios/lib/cuenta-estadia");
const {
  serviciosDe
} = require("./predios-central");
const {
  jsonCanonico
} = require("./reserva-version-archivo");
const todos = async (c, sql, p = []) => (await c.query(sql, p))[0];
const uno = async (c, sql, p) => (await todos(c, sql, p))[0];
const dinero = v => U.numero(v, {
  min: 0,
  max: 999999999,
  campo: "El precio"
});
const fecha = v => U.fecha(v, {
  requerido: true
});
const tipos = ["GENERAL", "PASA_EL_DIA", "CONTINGENTE", "FEDERACION"];
// Las visitas sin noche ocupan el día entero para la disponibilidad. En las
// pantallas y sus filtros se usa la fecha de salida que registró recepción.
const fechaFinVisibleSql = (evento) => `CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(${evento}.actual,'$.dia_sin_noche')) = 'true' AND DATEDIFF(r.fecha_fin,r.fecha_inicio)=1 THEN r.fecha_inicio ELSE r.fecha_fin END`;
const personaCols = "u.id,u.documento AS dni,u.nombre,u.apellido,u.fecha_nacimiento,u.tipo_persona_id,u.parentesco_id,u.legajo";
const firma = d => U.sha256(jsonCanonico(d));
const nombre = p => [p.apellido, p.nombre].filter(Boolean).join(", ");
// Los eventos son inmutables y el runtime sólo los lee e inserta. Con la
// cabecera bloqueada, FOR SHARE obtiene la revisión actual sin pedir UPDATE.
const ultimo = (c, id, lock) => uno(c, "SELECT * FROM recepcion_reserva_evento WHERE reserva_id=? ORDER BY id DESC LIMIT 1" + (lock ? " FOR SHARE" : ""), [id]);
async function cargarRecursos(c, filas, lock = false) {
  if (!filas.length) return;
  const otros = await todos(c, `SELECT rr.reserva_id, rc.id, rc.nombre FROM recepcion_reserva_recurso rr
    JOIN recurso rc ON rc.id=rr.recurso_id WHERE rr.reserva_id IN (?) ORDER BY rc.id${lock ? " FOR SHARE" : ""}`, [filas.map(r => r.id)]);
  for (const r of filas) {
    r.recursos = r.recurso_id ? [{ id: r.recurso_id, nombre: r.recurso }] : [];
    for (const o of otros) if (Number(o.reserva_id) === Number(r.id)) r.recursos.push({ id: o.id, nombre: o.nombre });
  }
}
async function opciones(c, codigos) {
  const servicios = await todos(c, "SELECT s.id,s.nombre,s.codigo,s.modelo_tarifa,ts.codigo AS tipo_codigo FROM servicio s JOIN tipo_servicio ts ON ts.id=s.tipo_servicio_id WHERE s.activo=1 AND s.estado_aprobacion='APROBADO' AND s.codigo IN (?) ORDER BY s.nombre", [codigos]);
  const ids = servicios.map(s => s.id);
  const recursos = ids.length ? await todos(c, "SELECT id,nombre,servicio_id FROM recurso WHERE activo=1 AND servicio_id IN (?) ORDER BY orden,nombre", [ids]) : [];
  const adicionales = ids.length ? await todos(c, `SELECT DISTINCT a.id,a.nombre,ta.recurso_id,ta.regimen_id,ta.precio,
    ta.fecha_inicio AS fecha_desde,ta.fecha_fin AS fecha_hasta FROM tarifa_adicional ta
    JOIN adicional a ON a.id=ta.adicional_id JOIN recurso r ON r.id=ta.recurso_id
    WHERE ta.activo=1 AND r.activo=1 AND r.servicio_id IN (?) ORDER BY nombre,fecha_desde DESC`, [ids]) : [];
  return {
    servicios,
    recursos,
    adicionales,
    regimenes: await todos(c, "SELECT id,nombre FROM regimen"),
    parentescos: await todos(c, "SELECT id,nombre FROM parentesco")
  };
}
async function familia(c, q, pid, soloDni = false) {
  q = U.texto(q, {
    requerido: true,
    max: 30
  });
  const t = await uno(c, `SELECT ${personaCols},u.departamental_id, (rp.usuario_id IS NULL) AS afiliado FROM usuario u
    LEFT JOIN recepcion_particular rp ON rp.usuario_id=u.id
    WHERE (u.documento=?${soloDni ? "" : " OR u.legajo=?"}) AND ((u.rol_id=2 AND u.habilitado='Y' AND u.usuario_familiar_id IS NULL) OR rp.predio_id=?)
    ORDER BY (u.documento=?) DESC LIMIT 1`, [...(soloDni ? [q] : [q, q]), pid, q]);
  if (!t) return {
    titular: null,
    personas: []
  };
  const personas = await todos(c, `SELECT ${personaCols} FROM usuario u WHERE u.id=? OR u.usuario_familiar_id=? ORDER BY u.id=? DESC,u.apellido,u.nombre`, [t.id, t.id, t.id]);
  return {
    titular: t,
    personas
  };
}
async function detalle(c, codigos, id, lock = false) {
  const r = await uno(c, `SELECT r.id,r.usuario_id,r.servicio_id,r.recurso_id,r.regimen_id,r.fecha_inicio,r.fecha_fin,r.precio_total,r.observaciones,r.numero_parcela,r.bloque_fecha_id,r.sorteo_id,r.estado_reserva_id,er.nombre AS estado,s.nombre AS servicio,rec.nombre AS recurso,
    u.documento AS titular_dni,CONCAT_WS(', ',u.apellido,u.nombre) AS titular_nombre,u.legajo AS titular_legajo,(u.rol_id=2 AND u.habilitado='Y') AS afiliado
    FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id LEFT JOIN recurso rec ON rec.id=r.recurso_id
    JOIN estado_reserva er ON er.id=r.estado_reserva_id WHERE r.id=? AND s.codigo IN (?)${lock ? " FOR UPDATE OF r" : ""}`, [id, codigos]);
  if (!r) throw U.error("No se encontró esa reserva entre los servicios asignados al predio.", 404);
  await cargarRecursos(c, [r], lock);
  const ev = await ultimo(c, id, lock),
    ext = ev ? JSON.parse(ev.actual) : {};
  if (ext.dia_sin_noche && r.fecha_fin === U.sumarDias(r.fecha_inicio, 1)) r.fecha_fin = r.fecha_inicio;
  const personas = await todos(c, `SELECT ${personaCols},rf.parentesco_id,rf.tipo_persona_id,rf.precio FROM reserva_familiar rf JOIN usuario u ON u.id=rf.usuario_id WHERE rf.reserva_id=? ORDER BY rf.id`, [id]);
  for (const p of personas) {
    const prev = (ext.personas || []).find(x => String(x.dni) === String(p.dni));
    p.entrada = prev?.entrada || null;
    p.salida = prev?.salida || null;
    p.salida_prevista = prev?.salida_prevista || null;
  }
  const adicionales = await todos(c, `SELECT adicional_id,cantidad,nombre_adicional AS nombre,dias,subtotal
    FROM reserva_adicional WHERE reserva_id=? ORDER BY id`, [id]);
  if (ext.alquileres?.length && Number(ext.servicio_id) === Number(r.servicio_id)) {
    // Turismo también puede editar la reserva: los días facturados vienen de sus renglones vigentes.
    const periodos = await todos(c, `SELECT a.adicional_id,MIN(d.fecha) AS fecha_desde,MAX(d.fecha) AS fecha_hasta
      FROM reserva_adicional a JOIN reserva_adicional_detalle d ON d.reserva_adicional_id=a.id
      WHERE a.reserva_id=? GROUP BY a.adicional_id`, [id]);
    for (const a of adicionales) {
      const alquiler = ext.alquileres.find(x => Number(x.adicional_id) === Number(a.adicional_id));
      const periodo = periodos.find(x => Number(x.adicional_id) === Number(a.adicional_id));
      if (alquiler && periodo) Object.assign(a, periodo, { recurso_tarifa_id: alquiler.recurso_tarifa_id, regimen_tarifa_id: alquiler.regimen_tarifa_id });
    }
  }
  const tramos = Array.isArray(ext.tramos) && Number(ext.tramos.at(-1)?.recurso_id) === Number(r.recurso_id) ? ext.tramos : [];
  const seleccion = tramos.at(-1)?.adicionales;
  const datos = {
    ...r,
    fecha_fin_acordada: ext.fecha_fin_acordada || r.fecha_fin,
    tipo: ext.tipo || "GENERAL",
    entidad: ext.entidad || null,
    cantidad: ext.cantidad || personas.length,
    vehiculo: ext.vehiculo || {},
    manual: ext.manual ?? null,
    automatico: ext.automatico ?? r.precio_total,
    cuotas_alojamiento: ext.cuotas_alojamiento || null,
    tramos,
    personas,
    adicionales,
    adicionales_vigentes: Array.isArray(seleccion)
      ? adicionales.filter(a => a.fecha_desde || seleccion.some(x => Number(x.adicional_id) === Number(a.adicional_id)))
      : adicionales,
    revision: ev ? Number(ev.id) : 0
  };
  return {
    ...datos,
    version: firma(datos)
  };
}
function resumenCambios(a, b) {
  const cambios = [];
  const otros = r => (r?.recursos || []).slice(1).map(x => x.nombre).join(", ");
  if (otros(a) !== otros(b)) cambios.push(["Otros recursos", otros(a) || null, otros(b) || null]);
  for (const [k, l] of Object.entries({
    estado: "Estado",
    servicio: "Servicio",
    recurso: "Recurso",
    regimen_id: "Régimen",
    fecha_inicio: "Desde",
    fecha_fin: "Hasta",
    tipo: "Tipo",
    cantidad: "Integrantes",
    entidad: "Entidad",
    precio_total: "Precio final",
    manual: "Precio manual",
    observaciones: "Observaciones"
  })) {
    if (String(a?.[k] ?? "") !== String(b[k] ?? "")) cambios.push([l, a?.[k], b[k]]);
  }
  for (const k of ["marca", "color", "patente", "sector"]) {
    if ((a?.vehiculo?.[k] || "") !== (b.vehiculo[k] || "")) cambios.push([k, a?.vehiculo?.[k], b.vehiculo[k]]);
  }
  const mapa = (xs, fn) => new Map((xs || []).map(x => [String(fn(x)), x]));
  for (const [key, id, describe] of [["personas", "dni", p => nombre(p) + " · DNI " + p.dni + " · " + (p.entrada || "sin ingreso") + " / " + (p.salida || "sin salida") + (p.salida_prevista ? " · Prevista " + p.salida_prevista : "") + " · $" + Number(p.precio || 0)], ["adicionales", "adicional_id", p => p.nombre + " × " + p.cantidad + (p.fecha_desde ? " · " + p.fecha_desde + " a " + p.fecha_hasta : "") + " · $" + Number(p.subtotal)]]) {
    const ant = mapa(a?.[key], p => p[id]),
      sig = mapa(b[key], p => p[id]);
    for (const k of new Set([...ant.keys(), ...sig.keys()])) {
      const x = ant.has(k) ? describe(ant.get(k)) : null,
        y = sig.has(k) ? describe(sig.get(k)) : null;
      if (x !== y) cambios.push([key === "personas" ? "Pasajero" : "Adicional", x, y]);
    }
  }
  if (b.plan_salida) {
    if (b.plan_salida.vehiculo) cambios.push(["Vehículo", null, b.plan_salida.vehiculo === "SALE" ? "Salida registrada" : "Permanece en el predio"]);
    if (b.plan_salida.accion) cambios.push(["Cuenta de la salida", null,
      (b.plan_salida.accion === "TRASLADAR" ? "Trasladada a quienes permanecen" : "Saldada") +
      " · Alojamiento $" + b.plan_salida.alojamiento + " · Consumos $" + b.plan_salida.consumos]);
  }
  if (a && Number(a.recurso_id) !== Number(b.recurso_id) && b.tramos.length) {
    const desde = b.tramos.at(-1).desde;
    const presentes = b.personas.filter(p => p.entrada && p.entrada <= desde && (!p.salida || p.salida > desde));
    cambios.push(["Traslado", a.recurso, [b.recurso, desde, presentes.map(nombre).join("; ")].filter(Boolean).join(" · ")]);
  }
  return cambios;
}
// La fecha prevista es inclusiva para esta alerta: quien sale hoy aún está en plazo.
// El evento central se confirma antes de replicar los huéspedes de la notebook.
// Así una salida recién guardada retira el aviso incluso entre sincronizaciones.
const condicionVencida = `er.nombre IN ('Iniciada','Verificada','Aprobada','Adjudicada')
  AND CASE WHEN e.predio_id=? AND JSON_TYPE(JSON_EXTRACT(e.actual,'$.personas'))='ARRAY' THEN EXISTS(
    SELECT 1 FROM JSON_TABLE(COALESCE(e.actual,'{}'), '$.personas[*]' COLUMNS(
      entrada VARCHAR(10) PATH '$.entrada', salida VARCHAR(10) PATH '$.salida',
      salida_prevista VARCHAR(10) PATH '$.salida_prevista')) p
      WHERE p.entrada IS NOT NULL AND p.salida IS NULL AND COALESCE(p.salida_prevista,${fechaFinVisibleSql("e")}) < ?)
    ELSE ${fechaFinVisibleSql("e")} < ? AND EXISTS (SELECT 1 FROM predio_huesped hp WHERE hp.reserva_id=r.id AND hp.predio_id=?
      AND hp.entrada IS NOT NULL AND hp.salida IS NULL) END`;
const ultimoEventoSql = " LEFT JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev WHERE ev.reserva_id=r.id)";
async function contarVencidas(c, codigos, pid, hoy) {
  return uno(c, `SELECT COUNT(*) AS cantidad FROM reserva r JOIN servicio s ON s.id=r.servicio_id
    JOIN estado_reserva er ON er.id=r.estado_reserva_id ${ultimoEventoSql}
    WHERE s.codigo IN (?) AND ${condicionVencida}`, [codigos, pid, hoy, hoy, pid]);
}
async function listar(c, codigos, b) {
  const cond = ["s.codigo IN (?)"],
    p = [codigos];
  const hoy = U.hoy(), pid = U.id(b.predioId);
  if (b.ocupacion === "VENCIDA") {
    cond.push(condicionVencida);
    p.push(pid, hoy, hoy, pid);
  }
  if (b.ocupacion === "PRESENTE" || b.ocupacion === "SALIDA") {
    const modo = b.ocupacion === "PRESENTE" ? "hp.salida IS NULL" : "hp.salida IS NOT NULL";
    cond.push("EXISTS (SELECT 1 FROM predio_huesped hp WHERE hp.reserva_id=r.id AND hp.predio_id=? AND hp.entrada IS NOT NULL AND " + modo + ")");
    p.push(U.id(b.predioId));
  }
  const busqueda = U.texto(b.q || "", { max: 80 }) || "";
  if (busqueda) {
    const reserva = /^(?:T-)?(\d+)$/i.exec(busqueda);
    // El titular figura como "Apellido, Nombre" y la reserva como "T-123" en la tabla.
    cond.push("(r.id=? OR u.documento LIKE ? OR CONCAT_WS(' ',u.apellido,u.nombre) LIKE ? OR CONCAT_WS(' ',u.nombre,u.apellido) LIKE ?)");
    const nombre = "%" + busqueda.replace(/,\s*/g, " ") + "%";
    p.push(reserva ? Number(reserva[1]) : 0, busqueda + "%", nombre, nombre);
  }
  if (b.desde) {
    cond.push(fechaFinVisibleSql("e") + ">=?");
    p.push(fecha(b.desde));
  }
  if (b.hasta) {
    cond.push("r.fecha_inicio<=?");
    p.push(fecha(b.hasta));
  }
  if (b.tipo) {
    cond.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.tipo')),'GENERAL')=?");
    p.push(U.opcion(b.tipo, tipos));
  }
  if (b.atipicas === "1") {
    cond.push("e.id IS NOT NULL");
  }
  if (b.servicio_id) {
    cond.push("s.id=?");
    p.push(U.id(b.servicio_id));
  }
  const from = ` FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id JOIN estado_reserva er ON er.id=r.estado_reserva_id LEFT JOIN recurso rec ON rec.id=r.recurso_id
    ${ultimoEventoSql} WHERE ${cond.join(" AND ")}`;
  const pagina = U.entero(b.pagina || 1, {
    min: 1,
    max: 999999
  });
  const filas = await todos(c, `SELECT r.id,r.fecha_inicio,${fechaFinVisibleSql("e")} AS fecha_fin,r.precio_total,s.nombre AS servicio,r.recurso_id,rec.nombre AS recurso,er.nombre AS estado,CONCAT_WS(', ',u.apellido,u.nombre) AS titular,JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.tipo')) AS tipo,(${condicionVencida}) AS vencida,
    CASE WHEN e.predio_id=? THEN JSON_EXTRACT(e.actual,'$.personas') END AS pasajeros_evento${from}
    ORDER BY r.fecha_inicio DESC,r.id DESC LIMIT 40 OFFSET ${(pagina - 1) * 40}`, [pid, hoy, hoy, pid, pid, ...p]);
  await cargarRecursos(c, filas);
  const vencidas = [];
  for (const r of filas) {
    const pasajeros = typeof r.pasajeros_evento === "string" ? JSON.parse(r.pasajeros_evento) : r.pasajeros_evento;
    delete r.pasajeros_evento;
    if (!Number(r.vencida)) continue;
    if (Array.isArray(pasajeros)) r.huespedes_pendientes = pasajeros.filter(p => p.entrada && !p.salida && (p.salida_prevista || r.fecha_fin) < hoy).map(nombre);
    else vencidas.push(r);
  }
  if (vencidas.length) {
    const presentes = await todos(c, `SELECT reserva_id,nombre FROM predio_huesped
      WHERE predio_id=? AND reserva_id IN (?) AND entrada IS NOT NULL AND salida IS NULL ORDER BY nombre`,
      [pid, vencidas.map(r => r.id)]);
    for (const r of vencidas) r.huespedes_pendientes = presentes.filter(p => Number(p.reserva_id) === Number(r.id)).map(p => p.nombre);
  }
  return {
    filas,
    pagina,
    vencidas: Number((await contarVencidas(c, codigos, pid, hoy)).cantidad),
    ...(await uno(c, "SELECT COUNT(*) AS cantidad,COALESCE(SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(e.actual,\'$.cantidad\')) AS UNSIGNED),(SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id=r.id))),0) AS viajeros,COALESCE(SUM(r.precio_total),0) AS importe" + from, p))
  };
}
// Turismo guarda el recurso actual en la cabecera. Para fechas pasadas,
// reconstruir la ocupación de cada tramo evita asignar la misma cabaña o
// parcela dos veces y evita bloquear el recurso nuevo antes del traslado.
async function ocupacionesHistoricas(c, servicioId, recursoId, inicio, fin, excluir) {
  if (inicio >= U.hoy()) return null;
  const reservas = await todos(c, `SELECT r.id,r.recurso_id,r.numero_parcela,r.fecha_inicio,r.fecha_fin,
        rr.recurso_id AS secundario,
        JSON_EXTRACT(e.actual,'$.tramos') AS tramos
      FROM reserva r JOIN estado_reserva er ON er.id=r.estado_reserva_id
      LEFT JOIN recepcion_reserva_recurso rr ON rr.reserva_id=r.id AND rr.recurso_id=?
      LEFT JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev WHERE ev.reserva_id=r.id)
      WHERE r.servicio_id=? AND r.fecha_inicio<? AND r.fecha_fin>? AND r.id<>?
        AND er.nombre NOT IN ('Cancelada','Rechazada','No adjudicada') FOR UPDATE OF r`, [recursoId, servicioId, fin, inicio, excluir || 0]);
  const ocupadas = [];
  for (const r of reservas) {
    if (Number(r.secundario)) {
      ocupadas.push({ id: r.id, numero_parcela: null });
      continue;
    }
    const tramos = typeof r.tramos === "string" ? JSON.parse(r.tramos) : r.tramos;
    if (!tramos?.length || Number(tramos.at(-1).recurso_id) !== Number(r.recurso_id)) {
      if (Number(r.recurso_id) === recursoId) ocupadas.push({ id: r.id, numero_parcela: r.numero_parcela });
      continue;
    }
    for (let i = 0; i < tramos.length; i++) {
      const tramo = tramos[i];
      const desde = i ? tramo.desde : r.fecha_inicio;
      const hasta = tramos[i + 1]?.desde || r.fecha_fin;
      if (Number(tramo.recurso_id) !== recursoId || desde >= hasta || desde >= fin || hasta <= inicio) continue;
      let parcela = i === tramos.length - 1 ? r.numero_parcela : tramo.numero_parcela;
      if (parcela === undefined && r.numero_parcela) {
        // Las primeras versiones registraban la parcela anterior en el
        // comprobante del traslado, antes de añadirla al objeto del tramo.
        const previo = await uno(c, `SELECT JSON_UNQUOTE(JSON_EXTRACT(anterior,'$.numero_parcela')) AS parcela
          FROM recepcion_reserva_evento WHERE reserva_id=? AND JSON_LENGTH(actual,'$.tramos')=?
          AND JSON_UNQUOTE(JSON_EXTRACT(anterior,'$.recurso_id'))=? ORDER BY id LIMIT 1`,
          [r.id, i + 2, String(recursoId)]);
        parcela = previo?.parcela;
      }
      ocupadas.push({ id: r.id, numero_parcela: parcela });
    }
  }
  return ocupadas;
}
async function validarBloqueTurismo(c, recursoId, inicio, fin, anterior) {
  const bloque = await uno(c, `SELECT bf.id FROM bloque_fecha bf JOIN bloque_fecha_recurso br ON br.bloque_fecha_id=bf.id
    WHERE br.recurso_id=? AND bf.estado='ACTIVO' AND bf.fecha_inicio<? AND bf.fecha_fin>? AND (br.reserva_id IS NULL OR br.reserva_id<>?) AND bf.id<>? LIMIT 1 FOR UPDATE`,
    [recursoId, fin, inicio, anterior?.id || 0, anterior?.bloque_fecha_id || 0]);
  if (bloque) throw U.error("El recurso está reservado para un bloque de Turismo en esas fechas.", 409);
}
async function cotizar(c, T, {
  tipo,
  servicio,
  recursoId,
  recursos = [],
  regimenId,
  personas,
  inicio,
  fin,
  adicionales,
  preciosPrevios = [],
  tramos,
  temporada,
  departamentalId
}) {
  if (recursos.length > 1) throw U.error(MENSAJE_RECURSO_UNICO);
  const pasajeros = personas.map(p => ({
    ...p,
    tarifa_individual: 0,
    tarifa_original_individual: 0,
    peso_alojamiento: 0,
    tarifas_por_fecha: []
  }));
  const alquileres = adicionales.filter(a => a.fecha_desde);
  const alquilerIds = new Set(alquileres.map(a => Number(a.adicional_id)));
  const itemsAlquiler = await cotizarAlquileres(c, T, alquileres, pasajeros, temporada, preciosPrevios);
  const totalAlquileres = U.redondear(itemsAlquiler.reduce((s, a) => s + a.subtotal, 0));
  if (tipo !== "GENERAL") return { personas: pasajeros, total: 0,
    extras: { total: totalAlquileres, alquileres: totalAlquileres, items: itemsAlquiler } };
  let total = 0;
  const itemsExtra = new Map();
  const segmentos = tramos.length ? tramos : [{
    desde: inicio,
    recurso_id: recursoId
  }];
  for (let i = 0; i < segmentos.length; i++) {
    const seg = segmentos[i],
      a = i === 0 ? inicio : seg.desde,
      z = segmentos[i + 1]?.desde || fin;
    if (a >= z) continue;
    const fijo = servicio.modelo_tarifa === "PRECIO_UNICO" || servicio.unidad_cobro === "POR_ESTADIA" || ["POR_RECURSO_NOCHE", "POR_RECURSO_DIA"].includes(servicio.unidad_cobro);
    const cot = await T.calcularTarifaBaseReserva(c, {
      recursoId: seg.recurso_id,
      regimenId,
      personas: servicio.modelo_tarifa === "PRECIO_UNICO" ? pasajeros.slice(0, 1) : pasajeros,
      fechaInicio: a,
      fechaFin: z,
      temporadaTarifaId: temporada,
      departamentalId,
      recepcion: true
    });
    for (const row of cot.personas) {
      const p = pasajeros.find(x => String(x.dni) === String(row.dni));
      for (const noche of row.tarifas_por_fecha) {
        const porNochePersonal = servicio.unidad_cobro !== "POR_ESTADIA" && (noche.por_persona ?? !fijo);
        if (porNochePersonal && (noche.fecha < (p.entrada || inicio) || noche.fecha >= (p.salida || p.salida_prevista || fin))) continue;
        if (porNochePersonal) {
          p.peso_alojamiento += Number(noche.precio);
        } else {
          // El costo del recurso se conserva. Entre huéspedes se asigna a
          // quienes ocupan esa noche, incluida una prórroga de una sola persona.
          const ocupantes = pasajeros.filter(h => noche.fecha >= (h.entrada || inicio) &&
            noche.fecha < (h.salida || h.salida_prevista || fin));
          const grupo = ocupantes.length ? ocupantes : pasajeros;
          const cuotas = repartir(Number(noche.precio), grupo.map(() => 1));
          grupo.forEach((h, i) => { h.peso_alojamiento += cuotas[i]; });
        }
        p.tarifas_por_fecha.push({ ...noche, recurso_id: seg.recurso_id });
        p.tarifa_individual = U.redondear(p.tarifa_individual + Number(noche.precio));
        p.tarifa_original_individual = U.redondear(p.tarifa_original_individual + Number(noche.precio_original ?? noche.precio));
        total += Number(noche.precio);
      }
    }
    const seleccionExtras = (i === segmentos.length - 1 ? adicionales : (seg.adicionales ?? adicionales))
      .filter(a => !alquilerIds.has(Number(a.adicional_id)));
    const extrasTramo = await T.calcularAdicionalesReserva(c, seleccionExtras, seg.recurso_id, regimenId, a, z, pasajeros, temporada, { recepcion: true });
    for (const item of extrasTramo.items) {
      const previo = itemsExtra.get(item.adicional_id);
      if (!previo) {
        itemsExtra.set(item.adicional_id, item);
        continue;
      }
      previo.dias += item.dias;
      previo.cantidad = item.cantidad;
      previo.subtotal = U.redondear(previo.subtotal + item.subtotal);
      previo.subtotal_original = U.redondear(previo.subtotal_original + item.subtotal_original);
      previo.detalles.push(...item.detalles);
    }
  }
  const items = [...itemsExtra.values(), ...itemsAlquiler];
  return {
    personas: pasajeros,
    total: U.redondear(total),
    extras: { total: U.redondear(items.reduce((s, item) => s + item.subtotal, 0)), alquileres: totalAlquileres, items }
  };
}

function prepararFechas(b, anterior, tipo, inicio, finSolicitado) {
  const viajeros = b.personas;
  if (!Array.isArray(viajeros) || !viajeros.length || viajeros.length > 100) throw U.error("Indicá entre uno y cien pasajeros identificados.");
  const periodoFijo = tipo === "PASA_EL_DIA" || anterior?.bloque_fecha_id;
  const conservaAcuerdo = !periodoFijo && anterior?.fecha_fin === finSolicitado && anterior.fecha_fin_acordada >= inicio;
  const finAcordado = conservaAcuerdo ? anterior.fecha_fin_acordada : finSolicitado;
  const fechas = viajeros.map(p => {
    const previo = anterior?.personas.find(x => String(x.dni) === String(p.dni));
    const entrada = U.fecha(p.entrada), salida = U.fecha(p.salida);
    const prevista = p.salida_prevista === undefined ? previo?.salida_prevista || null : U.fecha(p.salida_prevista);
    if (previo?.salida && prevista !== (previo.salida_prevista || null)) {
      throw U.error("La fecha prevista no puede cambiar después de registrar la salida.");
    }
    if (prevista && (prevista < (entrada || inicio) || periodoFijo && prevista > finSolicitado)) {
      throw U.error("Revisá la salida prevista de " + nombre(p) + ": debe corresponder al período de su estadía.");
    }
    return { entrada, salida, salida_prevista: prevista };
  });
  const fin = periodoFijo ? finSolicitado : [finAcordado, ...fechas.flatMap(p => [p.salida || "", p.salida_prevista || ""])].sort().at(-1);
  if (fin > finAcordado) {
    for (const p of fechas) {
      if (!p.salida_prevista && (!p.entrada || p.entrada <= finAcordado)) p.salida_prevista = finAcordado;
    }
  }
  return { fechas, fin, finAcordado };
}

function diferencialesPorPersona(anterior, personas, total, manual, tarifaFija) {
  const previas = anterior?.personas || [];
  const cuotasPrevias = repartir(Number(anterior?.precio_total || 0), previas.map(p => manual || tarifaFija ? 1 : Number(p.precio ?? 0)));
  const anteriores = new Map(previas.map((p, i) => [String(p.dni), p.salida ? null : (anterior.cuotas_alojamiento?.[p.dni] ?? cuotasPrevias[i])]));
  const actuales = repartir(total, personas.map(p => manual ? 1 : p.peso_alojamiento));
  const cuotas = Object.fromEntries(personas.map((p, i) => [String(p.dni), actuales[i]]));
  const items = personas.flatMap(p => {
    const dni = String(p.dni), anterior = anteriores.get(dni);
    const importe = U.redondear(cuotas[dni] - (anterior || 0));
    return anterior === null || !importe ? [] : [{ dni, importe }];
  });
  const remanente = U.redondear(total - Number(anterior?.precio_total || 0) - items.reduce((s, p) => s + p.importe, 0));
  if (remanente) items.push({ dni: null, importe: remanente });
  return { items, cuotas };
}

function validarPlanSalida(salida, plan) {
  const error = () => U.error("Revisá y confirmá la liquidación para registrar la salida.", 409);
  const coincide = campo => Array.isArray(plan?.[campo]) && plan[campo].length === salida[campo].length &&
    salida[campo].every((p, i) => plan[campo][i]?.dni === p.dni);
  if (!coincide("personas") || !coincide("presentes")) throw error();
  const haySaldo = plan.alojamiento || plan.consumos;
  for (const rubro of ["alojamiento", "consumos"]) {
    if (!plan.personas.every(p => Number.isFinite(p[rubro])) ||
      U.redondear(plan.personas.reduce((s, p) => s + p[rubro], 0)) !== plan[rubro]) throw error();
  }
  if (U.redondear(plan.alojamiento + plan.consumos) !== plan.total) throw error();
  if (haySaldo || plan.accion) U.opcion(plan.accion, salida.presentes.length ? ["COBRAR", "TRASLADAR"] : ["COBRAR"], "La liquidación");
  if (plan.accion === "COBRAR" && plan.total) U.opcion(plan.medio, ["EFECTIVO", "TRANSFERENCIA"], "El medio de pago");
  if (plan.medio === "EFECTIVO" && (!plan.caja?.caja_id || !plan.caja?.boca_id || !plan.caja?.fecha)) throw error();
  if (salida.vehiculo_pendiente) U.opcion(plan.vehiculo, salida.presentes.length ? ["SALE", "PERMANECE"] : ["SALE"], "La salida del vehículo");
  else if (plan.vehiculo) throw error();
}

async function guardar(c, predio, actor, b, codigos, previa) {
  const recursoId = recursoUnico(b, (b.tipo || "GENERAL") === "GENERAL");
  const T = require("../routes/user").negocioRecepcion;
  const actorId = actor.general_usuario_id || null;
  const req = {
    ip: "",
    connection: {
      remoteAddress: ""
    },
    socket: {
      remoteAddress: ""
    },
    headers: {},
    get: () => null
  };
  const { _salida_plan: planSalida, ...solicitud } = b;
  const operacion = String(b.operacion || ""),
    huella = firma({
      actor: actor.id,
      datos: b
    });
  if (!previa) {
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(operacion)) throw U.error("Falta identificar la operación.");
    const recibo = await uno(c, "SELECT id,huella,actual FROM recepcion_reserva_evento WHERE predio_id=? AND operacion=?", [predio.id, operacion]);
    if (recibo) {
      if (recibo.huella !== huella) throw U.error("El comprobante corresponde a otro cambio.", 409);
      return {
        ...JSON.parse(recibo.actual),
        evento_id: Number(recibo.id)
      };
    }
  }
  const anterior = b.id ? await detalle(c, codigos, U.id(b.id), true) : null;
  if (anterior && anterior.version !== b.version) throw U.error("Otra persona modificó la reserva. Volvé a abrirla antes de guardar.", 409);
  if (anterior && !["Aprobada", "Verificada", "Iniciada", "Adjudicada"].includes(anterior.estado)) throw U.error("El estado de esta reserva no permite modificar la estadía.", 409);
  const servicio = await uno(c, "SELECT s.*,ts.codigo AS tipo_codigo FROM servicio s JOIN tipo_servicio ts ON ts.id=s.tipo_servicio_id WHERE s.id=? AND s.codigo IN (?) AND s.activo=1 AND s.estado_aprobacion='APROBADO' FOR UPDATE", [U.id(b.servicio_id), codigos]);
  if (!servicio) throw U.error("El servicio no está asignado a este predio.", 403);
  const tipo = U.opcion(b.tipo || "GENERAL", tipos),
    inicio = fecha(b.fecha_inicio),
    finSolicitado = fecha(b.fecha_fin);
  if (finSolicitado < inicio) throw U.error("La fecha de salida debe ser igual o posterior al ingreso.");
  const { fechas, fin, finAcordado } = prepararFechas(b, anterior, tipo, inicio, finSolicitado);
  if (fin < inicio || tipo === "GENERAL" && fin === inicio || fin > U.sumarDias(inicio, 366)) throw U.error("Revisá las fechas de la estadía (hasta un año).");
  if (tipo === "PASA_EL_DIA" && fin !== inicio) throw U.error("En Pasa el día, el ingreso y la salida deben ser el mismo día.");
  const hasta = fin === inicio ? U.sumarDias(inicio, 1) : fin;
  const regimenId = U.id(b.regimen_id, "El régimen", tipo === "GENERAL" && servicio.modelo_tarifa !== "PRECIO_UNICO");
  if (anterior?.recursos?.length > 1) throw U.error("Esta reserva conserva varios recursos anteriores. Separá sus recursos en reservas individuales antes de modificarla.", 409);
  const ids = recursoId ? [recursoId] : [];
  const cambiaRecurso = Number(anterior?.recurso_id || 0) !== Number(recursoId || 0);
  if (anterior?.bloque_fecha_id && (cambiaRecurso || anterior.fecha_inicio !== inicio || anterior.fecha_fin !== fin)) throw U.error("Para cambiar un bloque adjudicado primero liberalo en Turismo.", 409);
  const catalogo = ids.length ? await todos(c, "SELECT * FROM recurso WHERE id IN (?) AND servicio_id=? AND activo=1 ORDER BY id FOR UPDATE", [ids, servicio.id]) : [];
  if (catalogo.length !== ids.length) throw U.error("El recurso debe pertenecer al servicio y estar activo.", 422);
  const recurso = catalogo[0];
  const tramos = (anterior?.tramos || []).map(x => ({
    ...x
  }));
  if (anterior && Number(anterior.recurso_id) !== Number(recursoId) && anterior.personas.some(p => p.entrada)) {
    if (!anterior.recurso_id || !recursoId || anterior.servicio_id !== servicio.id) throw U.error("Un traslado durante la estadía requiere dos recursos del mismo servicio.");
    const desde = fecha(b.traslado || U.hoy());
    if (desde < inicio || desde >= hasta || desde > U.hoy() || tramos.length && desde < tramos.at(-1).desde) throw U.error("La fecha del traslado debe estar dentro de la estadía, en orden y no ser futura.");
    if (!tramos.length) tramos.push({ desde: inicio, recurso_id: anterior.recurso_id });
    tramos.at(-1).numero_parcela = anterior.numero_parcela;
    tramos.at(-1).adicionales = anterior.adicionales_vigentes.filter(a => !a.fecha_desde).map(a => ({adicional_id: a.adicional_id, cantidad: a.cantidad}));
    tramos.push({
      desde,
      recurso_id: recursoId
    });
  }
  if (tramos.length && inicio > tramos[1].desde) throw U.error("El inicio no puede ser posterior al primer traslado registrado.");
  if (tramos.length) tramos[0].desde = inicio;
  const ocupacionDesde = tramos.length ? tramos.at(-1).desde : inicio;
  if (ocupacionDesde >= hasta) throw U.error("La salida debe ser posterior al último traslado registrado.");
  let ocupaciones = null;
  if (recurso) {
    ocupaciones = await ocupacionesHistoricas(c, servicio.id, recursoId, ocupacionDesde, hasta, anterior?.id);
    await T.bloquearYValidarDisponibilidadReserva(c, {
      servicioId: servicio.id,
      recursoId,
      fechaInicio: ocupacionDesde,
      fechaFin: hasta,
      reservaIdExcluir: anterior?.id,
      ocupaciones
    });
    await validarBloqueTurismo(c, recursoId, ocupacionDesde, hasta, anterior);
  }
  if (tramos.length && inicio < anterior.fecha_inicio) {
    // La ampliación hacia atrás corresponde al primer recurso, no al actual.
    const primero = tramos[0];
    const rango = {
      servicioId: servicio.id, recursoId: Number(primero.recurso_id), fechaInicio: inicio,
      fechaFin: anterior.fecha_inicio, reservaIdExcluir: anterior.id
    };
    rango.ocupaciones = await ocupacionesHistoricas(c, servicio.id, rango.recursoId, inicio, rango.fechaFin, anterior.id);
    await T.bloquearYValidarDisponibilidadReserva(c, rango);
    if (servicio.tipo_codigo === "CUPO_NUMERADO") {
      if (!primero.numero_parcela) throw U.error("Falta la parcela del primer tramo para ampliar la estadía.", 409);
      await T.validarNumeroParcelaCampingExistente(c, { ...rango, reservaId: anterior.id, numeroParcela: primero.numero_parcela });
    }
    await validarBloqueTurismo(c, rango.recursoId, inicio, rango.fechaFin, anterior);
  }
  let titular;
  if (anterior) {
    titular = await uno(c, `SELECT ${personaCols},u.departamental_id, (u.rol_id=2 AND u.habilitado='Y') AS afiliado FROM usuario u WHERE u.id=?`, [anterior.usuario_id]);
  } else {
    const d = String(b.titular_dni || "");
    if (!/^\d{6,10}$/.test(d)) throw U.error("Ingresá el DNI del titular.");
    titular = (await familia(c, d, predio.id, true)).titular;
    if (!titular) {
      if (!b.particular) throw U.error("Buscá el afiliado por DNI o elegí registrar un particular.");
      const p = b.particular,
        nom = U.texto(p.nombre, {
          requerido: true,
          max: 70
        }),
        ape = U.texto(p.apellido, {
          requerido: true,
          max: 70
        }),
        nac = fecha(p.fecha_nacimiento);
      if (nac > U.hoy()) throw U.error("El nacimiento del titular no puede ser futuro.");
      if (await uno(c, "SELECT id FROM usuario WHERE documento=?", [d])) throw U.error("Ya hay una ficha con ese DNI. Revisá los datos del titular.", 409);
      const [res] = await c.query("INSERT INTO usuario (rol_id,tipo_persona_id,parentesco_id,documento,nombre,apellido,fecha_nacimiento,password,habilitado,modulo_turismo,modulo_coseguro,modulo_olimpiadas) VALUES (4,4,1,?,?,?,?,NULL,'N',0,0,0)", [d, nom, ape, nac]);
      await c.query("INSERT INTO recepcion_particular(usuario_id,predio_id) VALUES(?,?)", [res.insertId, predio.id]);
      titular = {
        id: res.insertId,
        dni: d,
        nombre: nom,
        apellido: ape,
        departamental_id: null,
        afiliado: 0
      };
    }
  }
  const viajeros = b.personas;
  const grupo = await T.obtenerUsuarioPrincipalFamilia(c, titular.id);
  const existentesParticular = Number(titular.afiliado) ? null : new Set((await todos(c, "SELECT documento FROM usuario WHERE documento IN (?)", [viajeros.map(p => String(p.dni))])).map(x => String(x.documento)));
  const personas = await T.crearOBuscarUsuariosReserva(c, viajeros.map(p => ({
    dni: p.dni,
    nombre: p.nombre,
    apellido: p.apellido,
    fecha_nacimiento: p.fecha_nacimiento,
    parentesco_id: p.parentesco_id || 5,
    tipo_persona_id: !Number(titular.afiliado) && p.tipo_persona_id !== 5 ? 4 : p.tipo_persona_id
  })), {
    ...grupo,
    usuarioModificadorId: actorId,
    fechaIngreso: inicio,
    req
  });
  for (let i = 0; i < personas.length; i++) {
    const a = personas[i],
      p = viajeros[i];
    if (existentesParticular && !existentesParticular.has(String(a.dni))) await c.query("UPDATE usuario SET habilitado=\'N\',modulo_turismo=0,modulo_coseguro=0,modulo_olimpiadas=0 WHERE id=? AND password IS NULL AND rol_id=4", [a.usuario_id]);
    Object.assign(a, fechas[i]);
    if (a.entrada && (a.entrada < inicio || a.entrada > fin || a.entrada > U.hoy())) throw U.error("Revisá el ingreso de " + nombre(a) + ": debe estar dentro de la estadía y no ser futuro.");
    if (a.salida && (!a.entrada || a.salida < a.entrada || a.salida > U.hoy())) throw U.error("Revisá la salida de " + nombre(a) + ": debe seguir al ingreso y no ser futura.");
  }
  for (const previo of anterior?.personas || []) {
    const actual = personas.find(p => String(p.dni) === String(previo.dni));
    if (previo.entrada && !actual?.entrada) throw U.error("Conservá el ingreso de quienes ya hicieron check-in y registrá su salida.");
    if (previo.salida && !actual?.salida) throw U.error("Podés corregir la fecha de salida registrada, pero no borrarla.");
  }
  const cantidad = tipo === "CONTINGENTE" ? U.id(b.cantidad, "La cantidad total del contingente") : personas.length;
  if (cantidad < personas.length || cantidad > 10000) throw U.error("La cantidad total debe incluir a las personas identificadas (máximo 10.000).");
  if (tipo === "CONTINGENTE" && !personas.some(p => p.edad >= 18)) throw U.error("El contingente requiere al menos un responsable adulto identificado.");
  if (tipo === "GENERAL" && Number(recurso?.cupo_maximo) > 0 && servicio.tipo_codigo !== "CUPO_NUMERADO"
      && cantidad > Number(recurso.cupo_maximo)) throw U.error("La cantidad supera la capacidad del recurso.");
  if (tipo === "GENERAL" && servicio.max_personas_reserva && cantidad > servicio.max_personas_reserva) throw U.error("La cantidad supera el máximo del servicio.");
  const entidad = tipo === "CONTINGENTE" ? U.texto(b.entidad, {
    max: 120
  }) : null;
  const vehiculo = {};
  for (const k of ["marca", "color", "patente", "sector"]) vehiculo[k] = U.texto(b.vehiculo?.[k], {
    max: 50
  });
  if (vehiculo.patente) {
    vehiculo.patente = anterior?.vehiculo?.patente?.toUpperCase() === vehiculo.patente.toUpperCase()
      ? anterior.vehiculo.patente : vehiculo.patente.toUpperCase();
  }
  if (Object.values(vehiculo).some(Boolean) && Object.values(vehiculo).some(v => !v)) throw U.error("Completá marca, color, patente y sector, o dejalos vacíos si no hay vehículo.");
  const nuevasSalidas = personas.filter(p => p.salida && !anterior?.personas.some(a => String(a.dni) === String(p.dni) && a.salida));
  const presentes = personas.filter(p => p.entrada && !p.salida);
  let salida = null;
  if (nuevasSalidas.length) {
    const antesDeSalir = { ...anterior, vehiculo, personas: [...nuevasSalidas.map(p => ({ ...p, salida: null })), ...presentes] };
    const estadoAnterior = anterior && await VEHICULOS.estadoVehiculo(c, predio, anterior, { bloquear: true });
    if (estadoAnterior?.presente && String(anterior.vehiculo.patente).trim().toUpperCase() !== String(vehiculo.patente || "").trim().toUpperCase()) {
      throw U.error("Registrá primero la salida del vehículo que estaba en el predio.");
    }
    const estadoVehiculo = anterior?.id && vehiculo.patente ? await VEHICULOS.estadoVehiculo(c, predio, antesDeSalir, { bloquear: true }) : { presente: Boolean(vehiculo.patente) };
    const ref = p => ({ dni: String(p.dni), nombre: nombre(p) });
    salida = { personas: nuevasSalidas.map(ref), presentes: presentes.map(ref),
      elegibles: personas.filter(p => !p.salida || nuevasSalidas.includes(p)).map(ref),
      vehiculo_pendiente: estadoVehiculo.presente };
  }
  const extrasAnteriores = Number(anterior?.servicio_id) === Number(servicio.id) ? anterior.adicionales_vigentes : [];
  const ad = seleccionArticulos(b.adicionales ?? [], { inicio, fin, tipo, personas, recursoId, regimenId, anteriores: extrasAnteriores });
  if (tramos.length) tramos.at(-1).adicionales = ad.filter(a => !a.fecha_desde);
  const conservarPrecios = ad.filter(a => a.fecha_desde && extrasAnteriores.some(p => p.fecha_desde && Number(p.adicional_id) === a.adicional_id)).map(a => a.adicional_id);
  const preciosPrevios = conservarPrecios.length ? await todos(c, `SELECT ra.adicional_id,ra.nombre_adicional,d.fecha,d.precio_unitario,
    d.tarifa_adicional_id,d.porcentaje_descuento,d.tarifa_id FROM reserva_adicional ra
    JOIN reserva_adicional_detalle d ON d.reserva_adicional_id=ra.id
    WHERE ra.reserva_id=? AND ra.adicional_id IN (?)`, [anterior.id, conservarPrecios]) : [];
  const temporada = anterior?.bloque_fecha_id ? (await uno(c, "SELECT temporada_tarifa_id FROM bloque_fecha WHERE id=?", [anterior.bloque_fecha_id]))?.temporada_tarifa_id : null;
  const cot = await cotizar(c, T, {
    tipo,
    servicio,
    recursoId,
    regimenId,
    personas,
    inicio,
    fin,
    adicionales: ad,
    preciosPrevios,
    tramos,
    temporada,
    departamentalId: titular.departamental_id
  });
  const descuentos = await T.aplicarDescuentosReserva(c, {
    cabecera: {
      rol: "predio"
    },
    servicioId: servicio.id,
    usuarioTitular: titular,
    tarifaBase: cot,
    adicionalesTotal: cot.extras.total,
    reservaId: anterior?.id
  });
  const subtotalAutomatico = cot.total + cot.extras.total - Number(descuentos.total_descuento || 0);
  const automatico = Math.max(0, cot.extras.alquileres ? U.redondear(subtotalAutomatico) : Math.round(subtotalAutomatico));
  const manual = b.manual == null || b.manual === "" ? null : dinero(b.manual);
  const motivo = U.texto(b.motivo, {
    max: 255
  });
  if (tipo !== "GENERAL" && manual === null) throw U.error("Indicá el precio acordado. Puede ser cero.");
  const total = manual === null ? automatico : U.redondear(manual + cot.extras.alquileres);
  if (tipo === "GENERAL" && manual !== null && total !== automatico && !motivo && (anterior?.manual == null || Number(anterior.manual) !== manual)) throw U.error("Justificá el cambio de precio en la observación.");
  const diferencia = U.redondear(total - Number(anterior?.precio_total || 0));
  const tarifaFija = servicio.modelo_tarifa === "PRECIO_UNICO" ||
    ["POR_ESTADIA", "POR_RECURSO_NOCHE", "POR_RECURSO_DIA"].includes(servicio.unidad_cobro);
  const { items: diferenciales, cuotas: cuotasAlojamiento } = diferencialesPorPersona(anterior, cot.personas, total, manual !== null, tarifaFija);
  const cotizacion = {
    automatico,
    total,
    diferencia,
    fecha_fin: fin,
    personas: cot.personas.map(p => ({
      dni: p.dni,
      nombre: nombre(p),
      precio: p.tarifa_individual
    })),
    adicionales: cot.extras.total,
    alquileres: cot.extras.alquileres,
    detalle_alquileres: ad.filter(a => a.fecha_desde).map(a => {
      const item = cot.extras.items.find(i => i.adicional_id === a.adicional_id);
      return { adicional_id: a.adicional_id, nombre: item.nombre_adicional, cantidad: a.cantidad,
        dias: item.dias, fecha_desde: a.fecha_desde, fecha_hasta: a.fecha_hasta, subtotal: item.subtotal };
    }),
    descuentos: descuentos.total_descuento
  };
  if (salida) {
    cotizacion.salida = salida;
    cotizacion.diferenciales = diferenciales;
  }
  const huellaCotizacion = firma(cotizacion);
  if (!previa && b.cotizacion_esperada != null && b.cotizacion_esperada !== huellaCotizacion) {
    throw U.error("El importe cambió desde la revisión. Volvé a revisar la cotización antes de guardar.", 409);
  }
  if (!previa && salida) {
    if (b.cotizacion_esperada !== huellaCotizacion) throw U.error("Revisá la cotización antes de registrar la salida.", 409);
    validarPlanSalida(salida, planSalida);
  }
  let id = anterior?.id,
    parcela = null;
  if (recurso && servicio.tipo_codigo === "CUPO_NUMERADO") {
    if (anterior?.numero_parcela && anterior.recurso_id === recursoId) {
      parcela = anterior.numero_parcela;
      await T.validarNumeroParcelaCampingExistente(c, {
        reservaId: id,
        recursoId,
        fechaInicio: ocupacionDesde,
        fechaFin: hasta,
        numeroParcela: parcela,
        ocupaciones
      });
    } else parcela = await T.asignarNumeroParcelaCamping(c, {
      recursoId,
      fechaInicio: ocupacionDesde,
      fechaFin: hasta,
      reservaIdExcluir: id,
      ocupaciones
    });
  }
  if (tramos.length) tramos.at(-1).numero_parcela = parcela;
  if (previa) return { ...cotizacion, cotizacion_esperada: huellaCotizacion };
  const obs = U.texto(b.observaciones, {
    max: 250
  });
  const args = [servicio.id, recursoId, regimenId, parcela, inicio, hasta, total, cot.extras.total, descuentos.total_descuento || 0, obs];
  if (id) {
    await T.archivarVersionReservaAntesDeReemplazo(c, id, {
      id: actorId,
      rol: "predio"
    });
    await c.query("UPDATE reserva SET servicio_id=?,recurso_id=?,regimen_id=?,numero_parcela=?,fecha_inicio=?,fecha_fin=?,precio_total=?,monto_adicionales=?,monto_descuentos=?,observaciones=?,fecha_modificacion=NOW() WHERE id=?", [...args, id]);
    await c.query("DELETE rft FROM reserva_familiar_tarifa rft JOIN reserva_familiar rf ON rf.id=rft.reserva_familiar_id WHERE rf.reserva_id=?", [id]);
    await c.query("DELETE FROM reserva_familiar WHERE reserva_id=?", [id]);
    await c.query("DELETE FROM reserva_adicional WHERE reserva_id=?", [id]);
  } else {
    const [r] = await c.query("INSERT INTO reserva (servicio_id,recurso_id,regimen_id,numero_parcela,fecha_inicio,fecha_fin,precio_total,monto_adicionales,monto_descuentos,observaciones,estado_reserva_id,modalidad,usuario_id,creado_por_usuario_id) VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT id FROM estado_reserva WHERE nombre='Aprobada'),'FECHA_LIBRE',?,?)", [...args, titular.id, actorId]);
    id = r.insertId;
  }
  for (const p of cot.personas) {
    const [r] = await c.query("INSERT INTO reserva_familiar(reserva_id,usuario_id,tipo_persona_id,parentesco_id,edad,precio) VALUES(?,?,?,?,?,?)", [id, p.usuario_id, p.tipo_persona_id, p.parentesco_id, p.edad, p.tarifa_individual]);
    // Turismo conserva una tarifa por pasajero y noche, también en los traslados.
    const noches = new Map();
    for (const t of p.tarifas_por_fecha) if (!noches.has(t.fecha)) noches.set(t.fecha, t);
    if (noches.size) await T.insertarTarifasFamiliaresCalculadas(c, [{
      ...p,
      tarifas_por_fecha: [...noches.values()],
      reserva_familiar_id: r.insertId
    }]);
  }
  await T.guardarAdicionalesReserva(c, id, cot.extras.items);
  if (descuentos.total_descuento || anterior) await T.guardarReservaDescuentos(c, {
    reservaId: id,
    usuarioId: titular.id,
    departamentalId: titular.departamental_id,
    servicioId: servicio.id,
    resultado: descuentos,
    actorId,
    req,
    registrarHistorialReserva: async () => {}
  });
  if (anterior && ["Iniciada", "Verificada"].includes(anterior.estado) && personas.some(p => p.entrada)) await c.query("UPDATE reserva SET estado_reserva_id=(SELECT id FROM estado_reserva WHERE nombre='Aprobada') WHERE id=?", [id]);
  const actual = await detalle(c, codigos, id);
  Object.assign(actual, {
    fecha_fin: fin,
    fecha_fin_acordada: finAcordado,
    dia_sin_noche: fin === inicio,
    tipo,
    cantidad,
    entidad,
    vehiculo,
    tramos,
    manual,
    automatico,
    diferencia,
    diferenciales,
    cuotas_alojamiento: cuotasAlojamiento
  });
  actual.alquileres = ad.filter(a => a.fecha_desde);
  for (const a of actual.adicionales) {
    for (const k of ["fecha_desde", "fecha_hasta", "recurso_tarifa_id", "regimen_tarifa_id"]) delete a[k];
    const item = actual.alquileres.find(x => x.adicional_id === Number(a.adicional_id));
    if (item) Object.assign(a, item);
  }
  actual.adicionales_vigentes = actual.adicionales.filter(a => ad.some(x => Number(x.adicional_id) === Number(a.adicional_id)));
  for (const p of actual.personas) {
    const a = personas.find(x => String(x.dni) === String(p.dni));
    p.entrada = a.entrada;
    p.salida = a.salida;
    p.salida_prevista = a.salida_prevista;
  }
  await VEHICULOS.limpiarCambioVehiculo(c, predio, anterior, actual);
  if (salida) {
    actual.plan_salida = planSalida;
    if (planSalida.vehiculo === "SALE") {
      await VEHICULOS.registrarSalida(c, predio, actor, actual, nuevasSalidas.map(p => p.salida).sort().at(-1));
    }
  }
  const cambios = resumenCambios(anterior, actual);
  actual.cambios = cambios;
  actual.huella_local = U.sha256(JSON.stringify([actor.id, solicitud]));
  const nota = ("Operación atípica · " + predio.nombre + " · " + actor.nombre + (motivo ? " · " + motivo : "")).slice(0, 500);
  actual.historial_ids = [];
  for (const [campo, antes, despues] of cambios.length ? cambios : [["Recepción", null, "Actualización"]]) {
    const [fila] = await c.query(
      "INSERT INTO historial_reserva(reserva_id,tipo_operacion,campo_modificado,valor_anterior,valor_nuevo,usuario_modificador_id,observaciones) VALUES(?,?,?,?,?,?,?)",
      [id, anterior ? "UPDATE" : "CREATE", campo, antes == null ? null : String(antes), despues == null ? null : String(despues), actorId, nota]
    );
    actual.historial_ids.push(Number(fila.insertId));
  }
  const [evento] = await c.query("INSERT INTO recepcion_reserva_evento(predio_id,reserva_id,operacion,huella,actor,empleado_id,anterior,actual,motivo) VALUES(?,?,?,?,?,?,?,?,?)", [predio.id, id, operacion, huella, actor.nombre, actor.id || null, anterior ? JSON.stringify(anterior) : null, JSON.stringify(actual), motivo]);
  actual.evento_id = Number(evento.insertId);
  if (anterior) await T.cerrarGuardiaArchivoReserva(c, id);
  return actual;
}
async function operar(c, predio, actor, accion, b) {
  if (VEHICULOS.acciones.has(accion)) return VEHICULOS.operar(c, predio, actor, accion, b);
  if (!actor || actor.rol !== "ADMIN" && !Number(actor.gestionar_reservas)) throw U.error("No tenés permiso de recepción.", 403);
  const codigos = serviciosDe(predio);
  if (!codigos.length) throw U.error("Este predio no tiene servicios asignados.", 403);
  try {
    if (accion === "opciones") return opciones(c, codigos);
    if (accion === "crearAdicional") return crearAdicional(c, codigos, actor, b);
    if (accion === "familia") return familia(c, b.q, predio.id);
    if (accion === "vencidas") return contarVencidas(c, codigos, predio.id, U.hoy());
    if (accion === "listar") return listar(c, codigos, {
      ...b,
      predioId: predio.id
    });
    if (accion === "detalle") {
      const r = await detalle(c, codigos, U.id(b.id));
      const vehiculo = await VEHICULOS.estadoVehiculo(c, predio, r);
      Object.assign(r.vehiculo, { en_predio: vehiculo.presente, salida: vehiculo.salida });
      const eventos = await todos(c, "SELECT DATE_FORMAT(fecha,'%Y-%m-%d %H:%i:%s') AS fecha,actor,anterior,actual,motivo FROM recepcion_reserva_evento WHERE reserva_id=? ORDER BY id DESC", [r.id]);
      return {
        reserva: r,
        historial: eventos.map(e => ({
          fecha: e.fecha,
          actor: e.actor,
          motivo: e.motivo,
          cambios: resumenCambios(JSON.parse(e.anterior), JSON.parse(e.actual))
        }))
      };
    }
    if (accion === "confirmacion") {
      const operacion = String(b.operacion || "");
      if (!/^[a-zA-Z0-9_-]{16,64}$/.test(operacion)) throw U.error("Falta identificar la operación.");
      const recibo = await uno(c, "SELECT id,actual FROM recepcion_reserva_evento WHERE predio_id=? AND operacion=?", [predio.id, operacion]);
      if (!recibo) return null;
      const actual = JSON.parse(recibo.actual);
      if (actual.huella_local !== U.sha256(JSON.stringify([actor.id, b]))) throw U.error("El comprobante corresponde a otro cambio.", 409);
      return { ...actual, evento_id: Number(recibo.id) };
    }
    if (accion === "cotizar") {
      await c.query("SAVEPOINT recepcion_previa");
      try {
        return await guardar(c, predio, actor, b, codigos, true);
      } finally {
        await c.query("ROLLBACK TO SAVEPOINT recepcion_previa");
        await c.query("RELEASE SAVEPOINT recepcion_previa");
      }
    }
    if (accion === "guardar") return await guardar(c, predio, actor, b, codigos, false);
    throw U.error("Operación de recepción desconocida.", 404);
  } catch (e) {
    if (e.statusCode) throw U.error(e.message, e.statusCode);
    throw e;
  }
}
module.exports = {
  operar,
  detalle,
  resumenCambios,
  cotizar,
  fechaFinVisibleSql
};
