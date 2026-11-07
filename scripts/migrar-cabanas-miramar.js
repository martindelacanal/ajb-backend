"use strict";

// Corrección acotada de la presentación instalada en Miramar. Las tablas del
// escritor local se actualizan por eventos de recepción y su sincronización.
const assert = require("node:assert/strict");
const U = require("../predios/lib/util");
const A = require("../api/services/reserva-version-archivo");
const ORIGEN = "DEMO_RECEPCION_CABANAS";
const DESTINO = "MIRAMAR_CABANAS";
const MIGRACION = "cabanas-miramar-unico-20261107";
const ACTOR = "Corrección de servicios de Miramar";
const MOTIVO = "Unificación de cabañas y corrección a un recurso por reserva solicitadas por administración.";
const IDS = [52, 53, 54, 55, 56];
const tablasTrasladables = new Set([
  "recurso", "reserva", "servicio_regimen", "imagen_servicio",
  "servicio_observacion", "turismo_tarifa_regla", "turismo_historial",
  "reserva_descuento", "descuento_historial"
]);
const filas = async (c, sql, p = []) => (await c.query(sql, p))[0];
const uno = async (c, sql, p = []) => (await filas(c, sql, p))[0];
const identificador = s => {
  assert.match(s, /^[a-zA-Z0-9_]+$/);
  return "`" + s + "`";
};
const json = v => typeof v === "string" ? JSON.parse(v) : v;
const copia = v => JSON.parse(JSON.stringify(v));

function normalizarReserva(actual, destino, secundarios = []) {
  const r = copia(actual);
  r.servicio_id = Number(destino.id);
  r.servicio = "Cabañas";
  r.diferencia = 0;
  r.cambios = [["Servicio", actual.servicio, "Cabañas"]];
  delete r.evento_id;
  delete r.version;
  delete r.revision;
  delete r.historial_ids;
  if (!secundarios.length) return r;
  // La única reserva múltiple creada por esta presentación tenía una pasajera
  // y dos unidades. Retiene su cabaña principal y todos los alquileres.
  assert.equal(Number(actual.id), 52, "Hay otra reserva múltiple que necesita revisión");
  assert.equal(String(actual.titular_dni), "99067310");
  assert.equal(Number(actual.recurso_id), 86);
  assert.deepEqual(secundarios.map(Number), [87]);
  assert.equal(Number(actual.precio_total), 204200, "Cambió el importe de T-52");
  assert.equal(actual.manual, null, "T-52 tiene un precio manual");
  assert.equal(actual.personas.length, 1);
  assert.equal(Number(actual.personas[0].precio), 190000);
  assert.equal(actual.tramos.length, 0, "T-52 tiene traslados posteriores");
  const noches = actual.tarifas_recursos?.[0]?.noches;
  assert.equal(actual.tarifas_recursos?.length, 1);
  assert.equal(noches?.length, 10);
  const principal = noches.filter(n => Number(n.recurso_id) === Number(actual.recurso_id));
  const quitadas = noches.filter(n => secundarios.includes(Number(n.recurso_id)));
  assert.equal(principal.length, 5);
  assert.equal(quitadas.length, 5);
  assert.equal(U.redondear(principal.reduce((s, n) => s + Number(n.precio), 0)), 90000);
  assert.equal(U.redondear(quitadas.reduce((s, n) => s + Number(n.precio), 0)), 100000);
  assert.equal(U.redondear(actual.adicionales.reduce((s, a) => s + Number(a.subtotal), 0)), 14200);
  r.precio_total = 104200;
  r.automatico = 104200;
  r.diferencia = -100000;
  r.personas[0].precio = 90000;
  r.recursos = r.recursos.filter(rec => Number(rec.id) === Number(r.recurso_id));
  delete r.tarifas_recursos;
  if (r.observaciones === "Una huésped, dos cabañas y artículos con distintos días de uso.") {
    r.observaciones = "Una huésped, una cabaña y artículos con distintos días de uso.";
  }
  r.cambios.push(["Otros recursos", actual.recursos.slice(1).map(rec => rec.nombre).join(", "), null]);
  r.cambios.push(["Precio final", Number(actual.precio_total), r.precio_total]);
  return r;
}

async function referenciasServicio(c, id) {
  // También se revisan las columnas sin FK, presentes en módulos anteriores.
  const columnas = await filas(c, `SELECT DISTINCT c.TABLE_NAME AS tabla,c.COLUMN_NAME AS columna
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
    WHERE c.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE='BASE TABLE' AND c.COLUMN_NAME='servicio_id'
    UNION SELECT TABLE_NAME AS tabla,COLUMN_NAME AS columna FROM information_schema.key_column_usage
    WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE()
      AND REFERENCED_TABLE_NAME='servicio' AND REFERENCED_COLUMN_NAME='id'`);
  const refs = [];
  for (const col of columnas) {
    const row = await uno(c, `SELECT COUNT(*) AS cantidad FROM ${identificador(col.tabla)} WHERE ${identificador(col.columna)}=?`, [id]);
    if (Number(row.cantidad)) refs.push({ ...col, cantidad: Number(row.cantidad) });
  }
  return refs;
}

async function planificar(c, { bloquear = false } = {}) {
  const lock = bloquear ? " FOR UPDATE" : "";
  const servicios = await filas(c, "SELECT * FROM servicio WHERE codigo IN (?,?,?) ORDER BY id" + lock, [ORIGEN, DESTINO, "MIRAMAR_CAMPING"]);
  const origen = servicios.find(s => s.codigo === ORIGEN);
  const destino = servicios.find(s => s.codigo === DESTINO);
  const camping = servicios.find(s => s.codigo === "MIRAMAR_CAMPING");
  assert.ok(destino && camping, "Faltan los servicios originales de Miramar");
  const predio = await uno(c, "SELECT * FROM predio WHERE codigo='MIRAMAR'" + lock);
  assert.ok(predio && Number(predio.id) === 1, "No se encontró el predio Miramar esperado");
  const codigos = json(predio.servicio_codigos || "[]");
  assert.ok(codigos.includes(DESTINO));
  if (!origen) return { aplicada: true, destino, camping, predio, recursos: [], reservas: [], referencias: [], bloqueos: [] };
  assert.equal(Number(origen.id), 11, "El servicio de demostración tiene otra identidad");
  assert.ok(codigos.includes(ORIGEN), "El servicio de demostración no está asignado a Miramar");
  const recursos = await filas(c, "SELECT * FROM recurso WHERE servicio_id=? ORDER BY id" + lock, [origen.id]);
  assert.deepEqual(recursos.map(r => r.codigo).sort(), ["DEMO_CAB_1", "DEMO_CAB_2", "DEMO_CAB_3"]);
  const colisiones = await filas(c, "SELECT id,codigo FROM recurso WHERE servicio_id=? AND codigo IN (?)", [destino.id, recursos.map(r => r.codigo)]);
  assert.equal(colisiones.length, 0, "Los códigos de las cabañas ya existen en el destino");
  const cabeceras = await filas(c, "SELECT * FROM reserva WHERE servicio_id=? ORDER BY id" + lock, [origen.id]);
  assert.deepEqual(cabeceras.map(r => Number(r.id)), IDS, "Cambió el conjunto de reservas de demostración");
  const referencias = await referenciasServicio(c, origen.id);
  const bloqueos = referencias.filter(r => r.columna !== "servicio_id" || !tablasTrasladables.has(r.tabla));
  const reservas = [];
  const { operar } = require("../api/services/recepcion");
  for (const cabecera of cabeceras) {
    const evento = await uno(c, "SELECT * FROM recepcion_reserva_evento WHERE reserva_id=? ORDER BY id DESC LIMIT 1", [cabecera.id]);
    assert.ok(evento && Number(evento.predio_id) === Number(predio.id));
    const extra = json(evento.actual);
    const { reserva } = await operar(c, predio, { rol: "ADMIN", id: null, nombre: ACTOR }, "detalle", { id: cabecera.id });
    const anterior = { ...extra, ...reserva };
    assert.equal(Number(extra.precio_total), Number(cabecera.precio_total), "Cambió el precio fuera de recepción");
    const secundarios = (await filas(c, "SELECT recurso_id FROM recepcion_reserva_recurso WHERE reserva_id=? ORDER BY recurso_id", [cabecera.id])).map(r => Number(r.recurso_id));
    const actual = normalizarReserva(anterior, destino, secundarios);
    reservas.push({ cabecera, anterior, actual, secundarios, evento_id: Number(evento.id) });
  }
  return { aplicada: false, origen, destino, camping, predio, recursos, reservas, referencias, bloqueos };
}

function resumir(p) {
  return { aplicada: p.aplicada, origen_id: p.origen?.id || null, destino_id: p.destino.id,
    recursos: p.recursos.map(r => ({ id: r.id, nombre: r.nombre })),
    reservas: p.reservas.map(r => ({ id: r.actual.id, antes: Number(r.anterior.precio_total), despues: Number(r.actual.precio_total), diferencia: r.actual.diferencia })),
    referencias: p.referencias, bloqueos: p.bloqueos };
}

async function aplicar(c, { simulacion = true } = {}) {
  await c.beginTransaction();
  try {
    const plan = await planificar(c, { bloquear: true });
    assert.equal(plan.bloqueos.length, 0, "Hay referencias del servicio pendientes de revisar: " + JSON.stringify(plan.bloqueos));
    if (plan.aplicada) {
      await c.rollback();
      return resumir(plan);
    }
    const { origen, destino, predio } = plan;
    await c.query("UPDATE servicio SET nombre='Cabañas',lugar='Miramar' WHERE id=?", [destino.id]);
    await c.query("UPDATE servicio SET nombre='Camping',lugar='Miramar' WHERE id=?", [plan.camping.id]);
    const regimenes = await filas(c, "SELECT regimen_id FROM servicio_regimen WHERE servicio_id=?", [origen.id]);
    for (const { regimen_id } of regimenes) {
      if (!await uno(c, "SELECT 1 FROM servicio_regimen WHERE servicio_id=? AND regimen_id=?", [destino.id, regimen_id])) {
        await c.query("INSERT INTO servicio_regimen(servicio_id,regimen_id) VALUES (?,?)", [destino.id, regimen_id]);
      }
    }
    await c.query("DELETE FROM servicio_regimen WHERE servicio_id=?", [origen.id]);
    for (const ref of plan.referencias.filter(r => !["reserva", "servicio_regimen"].includes(r.tabla))) {
      await c.query(`UPDATE ${identificador(ref.tabla)} SET servicio_id=? WHERE servicio_id=?`, [destino.id, origen.id]);
    }
    for (const item of plan.reservas) {
      const { anterior, actual } = item;
      await A.archivarVersionReservaAntesDeReemplazo(c, actual.id, { id: null, rol: "SISTEMA" }, "CORRECCION");
      await c.query("UPDATE reserva SET servicio_id=?,precio_total=?,observaciones=?,fecha_modificacion=NOW() WHERE id=? AND servicio_id=?",
        [destino.id, actual.precio_total, actual.observaciones, actual.id, origen.id]);
      if (item.secundarios.length) {
        await c.query("DELETE FROM recepcion_reserva_recurso WHERE reserva_id=?", [actual.id]);
        const [familiar] = await c.query("UPDATE reserva_familiar SET precio=? WHERE reserva_id=? AND usuario_id=? AND precio=?",
          [actual.personas[0].precio, actual.id, actual.usuario_id, anterior.personas[0].precio]);
        assert.equal(familiar.affectedRows, 1, "Cambió el precio de la pasajera de T-52");
      }
      const operacion = `${MIGRACION}-r${actual.id}`;
      const huella = U.sha256(A.jsonCanonico({ operacion, anterior, actual }));
      actual.huella_local = huella;
      actual.historial_ids = [];
      for (const [campo, antes, despues] of actual.cambios) {
        const [h] = await c.query(`INSERT INTO historial_reserva
          (reserva_id,tipo_operacion,campo_modificado,valor_anterior,valor_nuevo,usuario_modificador_id,observaciones)
          VALUES (?,'UPDATE',?,?,?,?,?)`, [actual.id, campo, antes == null ? null : String(antes), despues == null ? null : String(despues), null, MOTIVO]);
        actual.historial_ids.push(Number(h.insertId));
      }
      const [evento] = await c.query(`INSERT INTO recepcion_reserva_evento
        (predio_id,reserva_id,operacion,huella,actor,empleado_id,anterior,actual,motivo) VALUES (?,?,?,?,?,NULL,?,?,?)`,
        [predio.id, actual.id, operacion, huella, ACTOR, JSON.stringify(anterior), JSON.stringify(actual), MOTIVO]);
      item.evento_nuevo = Number(evento.insertId);
      await A.cerrarGuardiaArchivoReserva(c, actual.id);
    }
    const codigos = json(predio.servicio_codigos).filter(codigo => codigo !== ORIGEN);
    await c.query("UPDATE predio SET servicio_codigos=? WHERE id=?", [JSON.stringify(codigos), predio.id]);
    assert.deepEqual(await referenciasServicio(c, origen.id), [], "Quedaron referencias al servicio de demostración");
    const [borrado] = await c.query("DELETE FROM servicio WHERE id=? AND codigo=?", [origen.id, ORIGEN]);
    assert.equal(borrado.affectedRows, 1);
    if (simulacion) await c.rollback(); else await c.commit();
    return { ...resumir(plan), simulacion, eventos: plan.reservas.map(r => ({ reserva_id: r.actual.id, evento_id: r.evento_nuevo })) };
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    await A.limpiarTokenGuardiaArchivoReserva(c);
  }
}

if (require.main === module) (async () => {
  require("dotenv").config();
  const confirmar = process.argv.includes("--apply");
  if (confirmar && !process.argv.includes("--confirm=UNIFICAR_CABANAS_MIRAMAR")) throw Error("Falta --confirm=UNIFICAR_CABANAS_MIRAMAR");
  const pool = require("../api/connection/connection").promise();
  const c = await pool.getConnection();
  try {
    console.log(JSON.stringify(process.argv.includes("--simulate") || confirmar
      ? await aplicar(c, { simulacion: !confirmar }) : resumir(await planificar(c)), null, 2));
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error(e.code || "", e.message); process.exitCode = 1; });

module.exports = { planificar, aplicar, resumir, normalizarReserva, referenciasServicio };
