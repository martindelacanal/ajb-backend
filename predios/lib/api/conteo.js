"use strict";

// Conteo de stock a ciegas al cerrar la caja.
//
// Si Administración lo activa (Sistema → Configuración), antes del cierre temporal el
// cajero cuenta un porcentaje de los productos con stock en su boca. No ve lo que dice el
// sistema: la lista sólo trae nombre, código y unidad, y mientras el conteo está abierto no
// puede consultar el stock (exigirSinConteo). Cada boca recorre todo su stock en «rondas»:
// un producto no se vuelve a pedir hasta que se contaron todos los demás.
//
// Al enviar, el servidor compara con el stock de ese momento. Lo que no coincide (en los
// pesables, fuera de la tolerancia configurada) avisa a Supervisión de la boca y a
// Administración, que deciden por cada producto: ajustar el stock a lo contado (movimiento
// AJUSTE_CONTEO por la diferencia) o mantenerlo. Todo queda en la auditoría.

const crypto = require("node:crypto");
const U = require("../util");
const N = require("../negocio");
const { emitirAviso } = require("../avisos");
const { turnoAbierto, verificarOperador } = require("../turnos-caja");
const { esAdmin, puedeGestionarCajas, bocasDe, exigirBoca, ROLES_GESTION_CAJA } = require("./comun");

const ESTADOS = [
  { valor: "PENDIENTE", texto: "En curso" },
  { valor: "COMPLETO", texto: "Sin diferencias" },
  { valor: "CON_DIFERENCIAS", texto: "Con diferencias para revisar" },
  { valor: "REVISADO", texto: "Revisado" },
  { valor: "ANULADO", texto: "Sin contar (turno cerrado)" },
];

function opcionesConteo(config) {
  const porcentaje = Number(config.conteo_cierre_porcentaje);
  const tolerancia = Number(config.conteo_tolerancia_peso);
  return {
    activo: String(config.conteo_cierre_activo || "0") === "1",
    porcentaje: Number.isFinite(porcentaje) && porcentaje >= 1 ? Math.min(100, porcentaje) : 10,
    tolerancia: Number.isFinite(tolerancia) && tolerancia >= 0 ? Math.min(50, tolerancia) : 2,
  };
}

function textoCantidad(valor, unidad) {
  const n = Number(valor || 0);
  if (unidad === "KG") return `${n.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
  return `${n.toLocaleString("es-AR", { maximumFractionDigits: 3 })} u.`;
}

// Productos con stock (o stock negativo, que también hay que mirar) en la boca. Los
// alquileres quedan afuera: las unidades alquiladas no están en la boca mientras se cuenta.
function universo(t, ctx, bocaId) {
  return t.all(`SELECT p.id, p.nombre, p.codigo, p.unidad FROM predio_stock s
    JOIN predio_producto p ON p.predio_id = s.predio_id AND p.id = s.producto_id
    WHERE s.predio_id = ? AND s.boca_id = ? AND p.activo = 1 AND p.destino <> 'ALQUILER' AND s.cantidad <> 0
    ORDER BY p.id`, [ctx.pid, bocaId]);
}

async function estadoRonda(t, ctx, bocaId) {
  const f = await t.get(`SELECT MAX(i.ronda) AS ronda FROM predio_conteo_item i
    JOIN predio_conteo c ON c.predio_id = i.predio_id AND c.id = i.conteo_id
    WHERE i.predio_id = ? AND i.boca_id = ? AND c.estado <> 'ANULADO'`, [ctx.pid, bocaId]);
  const ronda = Number(f?.ronda) || 1;
  const filas = await t.all(`SELECT DISTINCT i.producto_id FROM predio_conteo_item i
    JOIN predio_conteo c ON c.predio_id = i.predio_id AND c.id = i.conteo_id
    WHERE i.predio_id = ? AND i.boca_id = ? AND i.ronda = ? AND c.estado <> 'ANULADO'`, [ctx.pid, bocaId, ronda]);
  return { ronda, contados: new Set(filas.map((x) => Number(x.producto_id))) };
}

function mezclar(lista) {
  for (let i = lista.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [lista[i], lista[j]] = [lista[j], lista[i]];
  }
  return lista;
}

// Elige al azar el porcentaje pedido entre lo que todavía no se contó en la ronda. Si la
// ronda se completa, lo que falta para llegar al porcentaje abre la ronda siguiente.
function elegir(todos, { ronda, contados }, porcentaje) {
  const cantidad = Math.min(todos.length, Math.max(1, Math.ceil(todos.length * porcentaje / 100)));
  const elegidos = mezclar(todos.filter((p) => !contados.has(Number(p.id)))).slice(0, cantidad).map((p) => ({ ...p, ronda }));
  if (elegidos.length < cantidad) {
    const ya = new Set(elegidos.map((p) => Number(p.id)));
    const siguiente = mezclar(todos.filter((p) => !ya.has(Number(p.id)))).slice(0, cantidad - elegidos.length);
    elegidos.push(...siguiente.map((p) => ({ ...p, ronda: ronda + 1 })));
  }
  return elegidos;
}

async function bloquearBoca(t, ctx, bocaId) {
  const clave = `conteo_boca_${Number(bocaId)}`;
  await t.run(`${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo) VALUES (?, ?, 0)`, [ctx.pid, clave]);
  await t.get(`SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = ?${t.forUpdate}`, [ctx.pid, clave]);
}

// Un cajero con un conteo abierto en su turno no puede consultar el stock.
async function conteoEnCurso(db, ctx) {
  if (!ctx.usuario || ctx.usuario.rol !== "CAJERO") return null;
  return db.get(`SELECT c.id FROM predio_conteo c JOIN predio_turno tu ON tu.predio_id = c.predio_id AND tu.id = c.turno_id
    WHERE c.predio_id = ? AND c.usuario_id = ? AND c.estado = 'PENDIENTE' AND tu.estado = 'ABIERTO' LIMIT 1`, [ctx.pid, ctx.usuario.id]);
}

async function exigirSinConteo(db, ctx) {
  if (await conteoEnCurso(db, ctx)) {
    throw U.error("Tenés un conteo de stock en curso. Terminá de contar y envialo para volver a consultar el stock.", 423, { codigo: "CONTEO_EN_CURSO" });
  }
}

function itemsParaCajero(t, ctx, conteoId) {
  return t.all(`SELECT i.id, i.producto_id, i.unidad, i.orden, p.nombre, p.codigo FROM predio_conteo_item i
    JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id
    WHERE i.predio_id = ? AND i.conteo_id = ? ORDER BY i.orden, i.id`, [ctx.pid, conteoId]);
}

// El cajero pide la lista al empezar el cierre temporal. Si ya la había pedido en este
// turno, recibe la misma: volver a abrir el cierre no cambia los productos.
async function iniciarDeCierre(ctx) {
  if (puedeGestionarCajas(ctx) || ctx.usuario?.rol !== "CAJERO") return { requerido: false };
  const cajaId = U.id(ctx.body.caja_id ?? ctx.sesion?.caja_id, "La caja");
  return ctx.db.tx(async (t) => {
    const config = opcionesConteo(await N.leerConfig(t, ctx));
    if (!config.activo) return { requerido: false };
    const turno = await turnoAbierto(t, ctx.pid, cajaId);
    if (!turno || Number(ctx.sesion?.caja_id) !== cajaId || Number(turno.id) !== Number(ctx.sesion?.turno_id)) {
      throw U.error("El conteo lo hace quien está atendiendo la caja, desde su turno.", 403, { codigo: "SIN_TURNO" });
    }
    await verificarOperador(t, ctx, cajaId);
    let conteo = await t.get(`SELECT * FROM predio_conteo WHERE predio_id = ? AND turno_id = ? AND estado <> 'ANULADO' ORDER BY id DESC LIMIT 1`,
      [ctx.pid, turno.id]);
    if (conteo && conteo.estado !== "PENDIENTE") return { requerido: true, completo: true, conteo: { id: conteo.id, estado: conteo.estado } };
    const boca = await N.obtener(t, ctx, "predio_boca", turno.boca_id);
    const caja = await N.obtener(t, ctx, "predio_caja", cajaId);
    if (!conteo) {
      await bloquearBoca(t, ctx, turno.boca_id);
      const todos = await universo(t, ctx, turno.boca_id);
      if (!todos.length) return { requerido: false, sin_stock: true };
      const elegidos = elegir(todos, await estadoRonda(t, ctx, turno.boca_id), config.porcentaje);
      const id = await N.insertar(t, ctx, "predio_conteo", {
        boca_id: turno.boca_id, caja_id: cajaId, turno_id: turno.id, usuario_id: ctx.usuario.id, usuario_nombre: N.nombreActor(ctx),
        fecha_inicio: U.fechaHora(), estado: "PENDIENTE", porcentaje: config.porcentaje, universo: todos.length,
        productos: elegidos.length, diferencias: 0,
      });
      let orden = 0;
      for (const p of elegidos) {
        await N.insertar(t, ctx, "predio_conteo_item", {
          conteo_id: id, boca_id: turno.boca_id, producto_id: p.id, ronda: p.ronda, orden: ++orden,
          unidad: p.unidad === "KG" ? "KG" : null, estado: "PENDIENTE",
        });
      }
      await N.auditar(t, ctx, "Conteo de stock pedido al cerrar", "conteo", id, {
        boca: boca?.nombre, caja: caja?.nombre, turno_id: turno.id, porcentaje: config.porcentaje, universo: todos.length,
        productos: elegidos.map((p) => ({ id: p.id, nombre: p.nombre, ronda: p.ronda })),
      });
      conteo = await N.obtener(t, ctx, "predio_conteo", id);
    }
    return {
      requerido: true,
      conteo: {
        id: conteo.id, estado: conteo.estado, boca: boca?.nombre, caja: caja?.nombre, fecha_inicio: conteo.fecha_inicio,
        productos: Number(conteo.productos), items: await itemsParaCajero(t, ctx, conteo.id),
      },
    };
  });
}

async function destinatariosBoca(t, ctx, bocaId) {
  const supervisores = await t.all(`SELECT u.id FROM predio_usuario u
    JOIN predio_usuario_boca ub ON ub.predio_id = u.predio_id AND ub.usuario_id = u.id
    WHERE u.predio_id = ? AND u.activo = 1 AND u.rol = 'SUPERVISOR' AND ub.boca_id = ? ORDER BY u.id`, [ctx.pid, bocaId]);
  // Sin destinatario = para todos los administradores (también los de Mi AJB).
  return [null, ...supervisores.map((s) => Number(s.id))];
}

async function avisarDiferencias(t, ctx, conteo, diferencias, total) {
  const boca = await N.obtener(t, ctx, "predio_boca", conteo.boca_id);
  const caja = conteo.caja_id ? await N.obtener(t, ctx, "predio_caja", conteo.caja_id) : null;
  const lugar = [boca?.nombre, caja?.nombre].filter(Boolean).join(" · ");
  const lineas = diferencias.slice(0, 6).map((d) => `${d.producto}: contó ${textoCantidad(d.contado, d.unidad)} y el sistema tenía ${textoCantidad(d.sistema, d.unidad)}`);
  const resto = diferencias.length > 6 ? ` y ${diferencias.length - 6} más` : "";
  const mensaje = `${conteo.usuario_nombre} contó ${total} productos al cerrar ${lugar} y ${diferencias.length === 1 ? "uno no coincide" : `${diferencias.length} no coinciden`} con el sistema. ${lineas.join("; ")}${resto}. Revisalo en Gestión → Conteos de stock para ajustar el stock a lo contado o mantenerlo.`;
  const detalle = {
    conteo_clave: `conteo-${conteo.id}`, conteo_id: Number(conteo.id), boca_id: Number(conteo.boca_id), boca: boca?.nombre || null,
    caja_id: conteo.caja_id ? Number(conteo.caja_id) : null, caja: caja?.nombre || null, cajero: conteo.usuario_nombre,
    diferencias: diferencias.slice(0, 20),
  };
  for (const usuarioId of await destinatariosBoca(t, ctx, conteo.boca_id)) {
    await emitirAviso(t, ctx, {
      tipo: "CONTEO_DIFERENCIA", usuarioId,
      titulo: `Diferencias en el conteo N° ${conteo.id} · ${lugar}`.slice(0, 180),
      mensaje: mensaje.slice(0, 2000), detalle,
    });
  }
}

// El cajero envía lo que contó. La respuesta no revela lo que dice el sistema.
async function enviar(ctx) {
  const id = U.id(ctx.params.id, "El conteo");
  const lista = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  return ctx.db.tx(async (t) => {
    const c = await N.exigir(t, ctx, "predio_conteo", id, "No encontramos el conteo", { bloquear: true });
    if (Number(c.usuario_id) !== Number(ctx.usuario.id)) throw U.error("Este conteo lo completa quien lo empezó.", 403);
    if (c.estado !== "PENDIENTE") throw U.error("Este conteo ya se envió.", 409, { codigo: "CONTEO_ENVIADO" });
    const turno = c.turno_id ? await N.obtener(t, ctx, "predio_turno", c.turno_id) : null;
    if (!turno || turno.estado !== "ABIERTO") throw U.error("El turno de este conteo ya se cerró.", 409, { codigo: "SIN_TURNO" });
    const config = opcionesConteo(await N.leerConfig(t, ctx));
    const items = await t.all(`SELECT i.*, p.nombre, p.codigo FROM predio_conteo_item i
      JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id
      WHERE i.predio_id = ? AND i.conteo_id = ? ORDER BY i.producto_id`, [ctx.pid, id]);
    const porId = new Map();
    for (const x of lista) if (x && typeof x === "object") porId.set(Number(x.id), x);
    const faltan = items.filter((i) => !porId.has(Number(i.id)) || porId.get(Number(i.id)).cantidad === null
      || porId.get(Number(i.id)).cantidad === undefined || porId.get(Number(i.id)).cantidad === "");
    if (faltan.length) throw U.error(`Completá la cantidad de «${faltan[0].nombre}». Si no hay, poné 0.`, 400, { codigo: "CONTEO_INCOMPLETO" });
    const ahora = U.fechaHora();
    const diferencias = [];
    const resumen = [];
    for (const i of items) {
      const x = porId.get(Number(i.id));
      const contada = U.numero(x.cantidad, { min: 0, max: 9999999, decimales: 3, campo: `La cantidad de «${i.nombre}»` });
      const ingreso = U.texto(x.ingreso, { max: 40 });
      const fila = await t.get(`SELECT cantidad FROM predio_stock WHERE predio_id = ? AND boca_id = ? AND producto_id = ?${t.forUpdate}`,
        [ctx.pid, c.boca_id, i.producto_id]);
      const sistema = U.redondear(Number(fila?.cantidad || 0), 3);
      const diferencia = U.redondear(contada - sistema, 3);
      const tolerancia = i.unidad === "KG" ? Math.abs(sistema) * config.tolerancia / 100 : 0;
      const coincide = Math.abs(diferencia) <= tolerancia + 0.0005;
      await N.actualizar(t, ctx, "predio_conteo_item", i.id, {
        cantidad_sistema: sistema, cantidad_contada: contada, diferencia, ingreso, estado: coincide ? "OK" : "DIFERENCIA",
      });
      const linea = { producto_id: Number(i.producto_id), producto: i.nombre, unidad: i.unidad || null, sistema, contado: contada, diferencia };
      resumen.push({ ...linea, coincide });
      if (!coincide) diferencias.push(linea);
    }
    await N.actualizar(t, ctx, "predio_conteo", id, {
      estado: diferencias.length ? "CON_DIFERENCIAS" : "COMPLETO", fecha_fin: ahora, diferencias: diferencias.length,
    });
    await N.auditar(t, ctx, "Conteo de stock al cierre", "conteo", id, {
      boca_id: Number(c.boca_id), caja_id: c.caja_id ? Number(c.caja_id) : null, turno_id: Number(c.turno_id),
      tolerancia_peso: config.tolerancia, items: resumen,
    });
    if (diferencias.length) await avisarDiferencias(t, ctx, c, diferencias, items.length);
    return {
      id, productos: items.length, diferencias: diferencias.length,
      mensaje: diferencias.length
        ? `Conteo registrado. ${diferencias.length === 1 ? "Un producto no coincide" : `${diferencias.length} productos no coinciden`} con el sistema: Supervisión lo va a revisar.`
        : "Conteo registrado. ¡Gracias!",
    };
  });
}

// Antes del cierre temporal, el conteo del turno tiene que estar enviado.
async function exigirConteoDelTurno(t, ctx, turno) {
  if (!turno || puedeGestionarCajas(ctx) || ctx.usuario?.rol !== "CAJERO") return;
  if (!opcionesConteo(await N.leerConfig(t, ctx)).activo) return;
  const c = await t.get("SELECT estado FROM predio_conteo WHERE predio_id = ? AND turno_id = ? AND estado <> 'ANULADO' ORDER BY id DESC LIMIT 1",
    [ctx.pid, turno.id]);
  if (c && c.estado !== "PENDIENTE") return;
  if (!c && !(await universo(t, ctx, turno.boca_id)).length) return;
  throw U.error("Antes del cierre temporal contá los productos que te pide el sistema.", 409, { codigo: "CONTEO_PENDIENTE" });
}

// Al cerrar o liberar un turno, el conteo que quedó sin enviar ya no se puede hacer.
async function anularPendientes(t, ctx, { cajaId, turnoId }) {
  const filas = await t.all(`SELECT id FROM predio_conteo WHERE predio_id = ? AND estado = 'PENDIENTE' AND ${turnoId ? "turno_id = ?" : "caja_id = ?"}`,
    [ctx.pid, turnoId || cajaId]);
  for (const f of filas) {
    await N.actualizar(t, ctx, "predio_conteo", f.id, { estado: "ANULADO", fecha_fin: U.fechaHora() });
    await N.auditar(t, ctx, "Conteo de stock sin enviar", "conteo", f.id, { motivo: "Se cerró el turno antes de enviar el conteo" });
  }
}

function exigirGestion(ctx, bocaId) {
  if (!puedeGestionarCajas(ctx)) throw U.error("Los conteos los revisa Supervisión o Administración", 403);
  exigirBoca(ctx, bocaId, "No tenés asignada la boca de este conteo");
}

async function detalle(ctx) {
  const id = U.id(ctx.params.id, "El conteo");
  const c = await ctx.db.get(`SELECT c.*, b.nombre AS boca, ca.nombre AS caja FROM predio_conteo c
    JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
    LEFT JOIN predio_caja ca ON ca.predio_id = c.predio_id AND ca.id = c.caja_id
    WHERE c.predio_id = ? AND c.id = ?`, [ctx.pid, id]);
  if (!c) throw U.error("No encontramos el conteo", 404);
  exigirGestion(ctx, c.boca_id);
  const costo = esAdmin(ctx);
  const items = await ctx.db.all(`SELECT i.*, p.nombre, p.codigo, p.precio_compra FROM predio_conteo_item i
    JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id
    WHERE i.predio_id = ? AND i.conteo_id = ? ORDER BY CASE WHEN i.estado = 'DIFERENCIA' THEN 0 ELSE 1 END, i.orden, i.id`, [ctx.pid, id]);
  return {
    conteo: c,
    items: items.map((i) => ({
      id: i.id, producto_id: i.producto_id, nombre: i.nombre, codigo: i.codigo, unidad: i.unidad, ronda: Number(i.ronda),
      estado: i.estado, ingreso: i.ingreso,
      sistema: i.cantidad_sistema == null ? null : Number(i.cantidad_sistema),
      contado: i.cantidad_contada == null ? null : Number(i.cantidad_contada),
      diferencia: i.diferencia == null ? null : Number(i.diferencia),
      valor: costo && i.diferencia != null ? U.redondear(Number(i.diferencia) * Number(i.precio_compra || 0), 2) : undefined,
      resuelto_por: i.resuelto_por, resuelto_fecha: i.resuelto_fecha, resolucion_motivo: i.resolucion_motivo,
    })),
  };
}

// Supervisión o Administración decide qué hacer con cada diferencia.
async function resolver(ctx) {
  const id = U.id(ctx.params.id, "El conteo");
  const pedidos = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!pedidos.length) throw U.error("Elegí qué hacer con cada diferencia");
  const motivo = U.texto(ctx.body.motivo, { max: 255, campo: "El motivo" });
  return ctx.db.tx(async (t) => {
    const c = await N.exigir(t, ctx, "predio_conteo", id, "No encontramos el conteo", { bloquear: true });
    exigirGestion(ctx, c.boca_id);
    if (c.estado !== "CON_DIFERENCIAS") throw U.error("Este conteo no tiene diferencias pendientes de revisar.", 409);
    const items = await t.all(`SELECT i.*, p.nombre FROM predio_conteo_item i
      JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id
      WHERE i.predio_id = ? AND i.conteo_id = ? ORDER BY i.producto_id${t.forUpdate}`, [ctx.pid, id]);
    const porId = new Map(items.map((i) => [Number(i.id), i]));
    const ahora = U.fechaHora();
    const hechos = [];
    const vistos = new Set();
    const ordenados = pedidos.map((p) => ({ id: U.id(p?.id, "El producto del conteo"), accion: p?.accion }))
      .sort((a, b) => Number(porId.get(a.id)?.producto_id || 0) - Number(porId.get(b.id)?.producto_id || 0));
    for (const p of ordenados) {
      const i = porId.get(p.id);
      if (!i || vistos.has(p.id)) throw U.error("Revisá los productos elegidos", 409);
      vistos.add(p.id);
      if (i.estado !== "DIFERENCIA") throw U.error(`La diferencia de «${i.nombre}» ya se resolvió.`, 409);
      const accion = U.opcion(p.accion, ["AJUSTAR", "MANTENER"], "La decisión");
      if (accion === "MANTENER" && !motivo) throw U.error("Contá por qué se mantiene el stock del sistema");
      if (accion === "AJUSTAR") {
        await N.moverStock(t, ctx, {
          bocaId: c.boca_id, productoId: i.producto_id, cantidad: Number(i.diferencia), tipo: "AJUSTE_CONTEO", motivo: "CONTEO",
          referenciaTipo: "conteo", referenciaId: id,
          detalle: `Conteo N° ${id}: ${c.usuario_nombre} contó ${textoCantidad(i.cantidad_contada, i.unidad)} y el sistema tenía ${textoCantidad(i.cantidad_sistema, i.unidad)}${motivo ? ` · ${motivo}` : ""}`,
        });
      }
      await N.actualizar(t, ctx, "predio_conteo_item", i.id, {
        estado: accion === "AJUSTAR" ? "AJUSTADO" : "DESCARTADO", resuelto_fecha: ahora, resuelto_por: N.nombreActor(ctx), resolucion_motivo: motivo,
      });
      i.estado = accion === "AJUSTAR" ? "AJUSTADO" : "DESCARTADO";
      hechos.push({ producto: i.nombre, accion, diferencia: Number(i.diferencia), unidad: i.unidad || null });
    }
    const quedan = items.filter((i) => i.estado === "DIFERENCIA").length;
    if (!quedan) {
      await N.actualizar(t, ctx, "predio_conteo", id, { estado: "REVISADO", revisado_fecha: ahora, revisado_por: N.nombreActor(ctx) });
      const avisos = await t.all(`SELECT id FROM predio_aviso WHERE predio_id = ? AND tipo = 'CONTEO_DIFERENCIA' AND resuelto_fecha IS NULL AND detalle LIKE ?`,
        [ctx.pid, `%"conteo_clave":"conteo-${id}"%`]);
      for (const a of avisos) await N.actualizar(t, ctx, "predio_aviso", a.id, { resuelto_fecha: ahora });
    }
    await N.auditar(t, ctx, "Revisión de conteo de stock", "conteo", id, { decisiones: hechos, motivo, quedan });
    const ajustados = hechos.filter((h) => h.accion === "AJUSTAR").length;
    return {
      id, quedan,
      mensaje: `${ajustados ? `Stock ajustado en ${ajustados} producto${ajustados === 1 ? "" : "s"}` : "Se mantuvo el stock del sistema"}${quedan ? `. Quedan ${quedan} diferencia${quedan === 1 ? "" : "s"} por revisar.` : ". Conteo revisado."}`,
    };
  });
}

// Cuánto lleva cada boca de su vuelta completa (para la pantalla de conteos).
async function progreso(ctx) {
  const config = opcionesConteo(await N.leerConfig(ctx.db, ctx));
  const bocas = await ctx.db.all(`SELECT b.id, b.nombre FROM predio_boca b WHERE b.predio_id = ? AND b.activo = 1
    AND EXISTS (SELECT 1 FROM predio_caja c WHERE c.predio_id = b.predio_id AND c.boca_id = b.id AND c.activo = 1) ORDER BY b.nombre`, [ctx.pid]);
  const visibles = esAdmin(ctx) ? bocas : bocas.filter((b) => bocasDe(ctx).includes(Number(b.id)));
  const salida = [];
  for (const b of visibles) {
    const todos = await universo(ctx.db, ctx, b.id);
    const r = await estadoRonda(ctx.db, ctx, b.id);
    const actuales = new Set(todos.map((p) => Number(p.id)));
    const contados = [...r.contados].filter((pid) => actuales.has(pid)).length;
    const ultimo = await ctx.db.get(`SELECT MAX(fecha_fin) AS fecha FROM predio_conteo WHERE predio_id = ? AND boca_id = ? AND estado IN ('COMPLETO', 'CON_DIFERENCIAS', 'REVISADO')`,
      [ctx.pid, b.id]);
    const revisar = await ctx.db.get("SELECT COUNT(*) AS n FROM predio_conteo WHERE predio_id = ? AND boca_id = ? AND estado = 'CON_DIFERENCIAS'", [ctx.pid, b.id]);
    salida.push({
      boca_id: b.id, boca: b.nombre, ronda: r.ronda, productos: todos.length, contados_ronda: contados,
      por_cierre: todos.length ? Math.min(todos.length, Math.max(1, Math.ceil(todos.length * config.porcentaje / 100))) : 0,
      ultimo_conteo: ultimo?.fecha || null, por_revisar: Number(revisar?.n || 0),
    });
  }
  return { config, bocas: salida };
}

module.exports = {
  ESTADOS,
  opcionesConteo,
  conteoEnCurso,
  exigirSinConteo,
  exigirConteoDelTurno,
  anularPendientes,
  elegir,
  textoCantidad,
  rutas: [
    { m: "POST", p: "/conteos/cierre", h: iniciarDeCierre, escritura: true, soloLocal: true },
    { m: "POST", p: "/conteos/:id/enviar", h: enviar, escritura: true, soloLocal: true },
    { m: "GET", p: "/conteos/progreso", h: progreso, roles: ROLES_GESTION_CAJA },
    { m: "GET", p: "/conteos/:id", h: detalle, roles: ROLES_GESTION_CAJA },
    { m: "POST", p: "/conteos/:id/resolver", h: resolver, escritura: true, roles: ROLES_GESTION_CAJA },
  ],
};
