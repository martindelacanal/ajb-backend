"use strict";

// Operaciones de bajo nivel compartidas por todos los módulos: identificadores,
// altas/modificaciones con auditoría, movimientos de stock y configuración.

const { columnasDe, TABLAS } = require("./esquema");
const { fechaHora, redondear, error } = require("./util");

async function nuevoId(t, tabla, pid) {
  if (!TABLAS[tabla]) throw new Error(`Tabla desconocida ${tabla}`);
  await t.run(
    `${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo)
     SELECT ?, ?, COALESCE(MAX(id), 0) FROM ${tabla} WHERE predio_id = ?`,
    [pid, tabla, pid]
  );
  await t.run("UPDATE predio_secuencia SET ultimo = ultimo + 1 WHERE predio_id = ? AND tabla = ?", [pid, tabla]);
  const fila = await t.get("SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = ?", [pid, tabla]);
  return Number(fila.ultimo);
}

function nombreActor(ctx) {
  const u = ctx.usuario;
  if (!u) return "Sistema";
  return u.nombre || u.usuario || "Usuario";
}

function filtrarColumnas(tabla, datos) {
  const cols = columnasDe(tabla);
  const salida = {};
  for (const [k, v] of Object.entries(datos)) {
    if (k in cols && k !== "predio_id" && k !== "id") salida[k] = v;
  }
  return salida;
}

async function insertar(t, ctx, tabla, datos) {
  const id = await nuevoId(t, tabla, ctx.pid);
  const fila = { ...filtrarColumnas(tabla, datos), predio_id: ctx.pid, id };
  if (TABLAS[tabla].auditoria) {
    const ahora = fechaHora();
    fila.fecha_creacion = fila.fecha_creacion || ahora;
    fila.fecha_modificacion = ahora;
    fila.creado_por = fila.creado_por || nombreActor(ctx);
    fila.modificado_por = nombreActor(ctx);
  }
  const cols = Object.keys(fila);
  await t.run(
    `INSERT INTO ${tabla} (${cols.join(", ")}) VALUES (${t.lista(cols.length)})`,
    cols.map((c) => fila[c])
  );
  return id;
}

async function actualizar(t, ctx, tabla, id, datos) {
  const fila = filtrarColumnas(tabla, datos);
  if (TABLAS[tabla].auditoria) {
    fila.fecha_modificacion = fechaHora();
    fila.modificado_por = nombreActor(ctx);
  }
  const cols = Object.keys(fila);
  if (!cols.length) return 0;
  const r = await t.run(
    `UPDATE ${tabla} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE predio_id = ? AND id = ?`,
    [...cols.map((c) => fila[c]), ctx.pid, id]
  );
  return r.cambios;
}

async function obtener(t, ctx, tabla, id, { bloquear = false } = {}) {
  return t.get(`SELECT * FROM ${tabla} WHERE predio_id = ? AND id = ?${bloquear ? t.forUpdate : ""}`, [ctx.pid, id]);
}

async function exigir(t, ctx, tabla, id, mensaje = "No encontramos el registro", opciones) {
  const fila = await obtener(t, ctx, tabla, id, opciones);
  if (!fila) throw error(mensaje, 404);
  return fila;
}

// Diferencias legibles entre dos versiones de una fila (para la auditoría).
function diferencias(antes, despues, ignorar = ["fecha_modificacion", "modificado_por", "password_hash"]) {
  const cambios = {};
  for (const k of Object.keys(despues || {})) {
    if (ignorar.includes(k)) continue;
    const a = antes ? antes[k] : undefined;
    const d = despues[k];
    const iguales = (a === null || a === undefined ? null : String(a)) === (d === null || d === undefined ? null : String(d))
      || (a !== null && d !== null && a !== undefined && d !== undefined && !Number.isNaN(Number(a)) && Number(a) === Number(d) && String(a).trim() !== "" && String(d).trim() !== "");
    if (!iguales) cambios[k] = { antes: a === undefined ? null : a, despues: d === undefined ? null : d };
  }
  return cambios;
}

async function auditar(t, ctx, accion, entidad, entidadId, detalle) {
  await insertar(t, ctx, "predio_auditoria", {
    fecha: fechaHora(),
    usuario_id: ctx.usuario?.id || null,
    usuario_nombre: nombreActor(ctx),
    accion,
    entidad: entidad || null,
    entidad_id: entidadId || null,
    detalle: detalle === undefined || detalle === null ? null : (typeof detalle === "string" ? detalle : JSON.stringify(detalle)),
    origen: ctx.origen || "LOCAL",
    ip: ctx.ip ? String(ctx.ip).slice(0, 45) : null,
  });
}

async function bloquearSaldoStock(t, ctx, bocaId, productoId) {
  // Una consulta previa puede ver una instantánea vieja en MySQL. Sólo se usa
  // para evitar altas innecesarias; el saldo válido sale de la lectura bloqueada.
  const fila = await t.get("SELECT id FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?", [ctx.pid, bocaId, productoId]);
  if (!fila) {
    const id = await nuevoId(t, "predio_stock", ctx.pid);
    // Si otra operación creó la fila mientras esperábamos, se conserva su saldo.
    await t.run(`${t.insertIgnore} INTO predio_stock (predio_id, id, boca_id, producto_id, cantidad, fecha_modificacion) VALUES (?, ?, ?, ?, 0, ?)`,
      [ctx.pid, id, bocaId, productoId, fechaHora()]);
  }
  const actual = await t.get(`SELECT cantidad FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?${t.forUpdate}`, [ctx.pid, bocaId, productoId]);
  if (!actual) throw error("No pudimos comprobar el stock del producto. Volvé a intentar.", 409);
  return Number(actual.cantidad);
}

async function stockActual(t, ctx, bocaId, productoId) {
  const fila = await t.get(
    "SELECT cantidad FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?",
    [ctx.pid, bocaId, productoId]
  );
  return fila ? Number(fila.cantidad) : 0;
}

// Suma (o resta, con cantidad negativa) stock en una boca y deja el movimiento en el kardex.
async function moverStock(t, ctx, { bocaId, productoId, cantidad, tipo, referenciaTipo, referenciaId, motivo, detalle }) {
  const delta = redondear(cantidad, 3);
  if (!delta) return null;
  const fila = await t.get(
    `SELECT id, cantidad FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?${t.forUpdate}`,
    [ctx.pid, bocaId, productoId]
  );
  const ahora = fechaHora();
  let saldo;
  if (fila) {
    saldo = redondear(Number(fila.cantidad) + delta, 3);
    await t.run("UPDATE predio_stock SET cantidad = ?, fecha_modificacion = ? WHERE predio_id = ? AND id = ?",
      [saldo, ahora, ctx.pid, fila.id]);
  } else {
    saldo = delta;
    await insertar(t, ctx, "predio_stock", { boca_id: bocaId, producto_id: productoId, cantidad: saldo, fecha_modificacion: ahora });
  }
  await insertar(t, ctx, "predio_movimiento", {
    fecha: ahora,
    tipo,
    boca_id: bocaId,
    producto_id: productoId,
    cantidad: delta,
    saldo,
    referencia_tipo: referenciaTipo || null,
    referencia_id: referenciaId || null,
    motivo: motivo || null,
    detalle: detalle ? String(detalle).slice(0, 255) : null,
    usuario_id: ctx.usuario?.id || null,
    usuario_nombre: nombreActor(ctx),
  });
  await require("./stock-minimo").revisarPar(t, ctx, bocaId, productoId);
  return saldo;
}

async function bocaAlmacen(t, ctx) {
  const fila = await t.get(
    "SELECT * FROM predio_boca WHERE predio_id = ? AND es_almacen = 1 AND activo = 1 ORDER BY id LIMIT 1",
    [ctx.pid]
  );
  return fila || null;
}

const CONFIG_POR_DEFECTO = {
  nombre_predio: "Camping Miramar",
  razon_social: "Asociación Judicial Bonaerense",
  cuit: "30-57416579-9",
  direccion: "Miramar, Provincia de Buenos Aires",
  // Datos del emisor en recibos y notas de crédito (los del talonario en papel del camping).
  iibb: "902-316676-5",
  inicio_actividades: "01/12/1992",
  condicion_iva: "IVA y Ganancias: exento",
  domicilio_legal: "Sede provincial: calle 50 N° 712, (B1900APT) La Plata",
  telefono: "(0221) 422-8594",
  correo: "",
  leyenda_comprobante: "Documento no válido como factura. Exceptuado de emitir comprobantes: RG 1415, art. 5°, anexo I, apartado A.",
  leyenda_ticket: "¡Gracias por tu visita! Comprobante no válido como factura.",
  texto_autorizacion: "Me dirijo a ustedes a efectos de autorizar expresamente a la Asociación Judicial Bonaerense a retener de mi sueldo la suma indicada, en las cuotas detalladas, de acuerdo al sistema de descuento vigente.",
  vender_sin_stock: "0",
  minutos_permiso: "30",
  // Conteo de stock a ciegas al cerrar la caja (lib/api/conteo.js): apagado hasta que
  // Administración lo active. Porcentaje del stock de la boca por cierre y tolerancia (%) en pesables.
  conteo_cierre_activo: "0",
  conteo_cierre_porcentaje: "10",
  conteo_tolerancia_peso: "2",
  // Etiquetas de balanza (public/js/balanza.js): prefijo y largo del código del producto.
  balanza_activa: "1",
  balanza_prefijo: "2",
  balanza_digitos_codigo: "7",
};

async function leerConfig(t, ctx) {
  const filas = await t.all("SELECT clave, valor FROM predio_config WHERE predio_id = ? AND clave NOT LIKE 'porcion.%' AND clave <> 'vender_sin_stock'", [ctx.pid]);
  const config = { ...CONFIG_POR_DEFECTO };
  for (const f of filas) config[f.clave] = f.valor;
  return config;
}

async function guardarConfig(t, ctx, clave, valor) {
  const fila = await t.get("SELECT id FROM predio_config WHERE predio_id = ? AND clave = ?", [ctx.pid, clave]);
  if (fila) await actualizar(t, ctx, "predio_config", fila.id, { valor });
  else await insertar(t, ctx, "predio_config", { clave, valor });
}

module.exports = {
  nuevoId,
  nombreActor,
  insertar,
  actualizar,
  obtener,
  exigir,
  diferencias,
  auditar,
  stockActual,
  bloquearSaldoStock,
  moverStock,
  bocaAlmacen,
  leerConfig,
  guardarConfig,
  CONFIG_POR_DEFECTO,
};
