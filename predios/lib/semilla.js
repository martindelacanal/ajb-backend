"use strict";

// Datos iniciales de cada predio. Miramar: las bocas de expendio pedidas por el camping.
// Una boca de origen entrega productos (tiene stock); una de destino los recibe o consume.

const N = require("./negocio");

const PREDIOS = {
  MIRAMAR: {
    nombre: "Camping Miramar",
    servicios: ["MIRAMAR_CAMPING", "MIRAMAR_CABANAS"],
    bocas: [
      { nombre: "Almacén", origen: 1, destino: 1, almacen: 1 },
      { nombre: "Comedor", origen: 1, destino: 1, cajas: ["Caja 1"] },
      { nombre: "Confitería", origen: 1, destino: 1, cajas: ["Caja 1"] },
      { nombre: "Eventos", origen: 1, destino: 1, cajas: ["Caja 1"] },
      { nombre: "Proveeduría", origen: 1, destino: 1, cajas: ["Caja 1", "Caja 2"] },
      { nombre: "Recepción", origen: 1, destino: 1, cajas: ["Caja 1"] },
      { nombre: "Administración y dirigencia", origen: 0, destino: 1 },
      { nombre: "Cabañas", origen: 0, destino: 1 },
      { nombre: "Colonia", origen: 0, destino: 1 },
      { nombre: "Depósito de cables", origen: 0, destino: 1 },
      { nombre: "Eventos varios", origen: 0, destino: 1 },
      { nombre: "Galpón", origen: 0, destino: 1 },
      { nombre: "Invierno multiboca", origen: 0, destino: 1 },
      { nombre: "Limpieza", origen: 0, destino: 1 },
    ],
    config: {
      nombre_predio: "Camping Miramar",
      direccion: "Camping AJB · Miramar, Provincia de Buenos Aires",
    },
  },
  PARADOR: {
    nombre: "Parador de la Montaña",
    servicios: ["PARADOR_MONTANA"],
    bocas: [
      { nombre: "Almacén", origen: 1, destino: 1, almacen: 1 },
      { nombre: "Recepción", origen: 1, destino: 1, cajas: ["Caja 1"] },
    ],
    config: { nombre_predio: "Parador de la Montaña", direccion: "Córdoba" },
  },
};

// Inserta lo que falte (idempotente). `t` es una transacción del adaptador de base.
async function sembrarPredio(t, ctx, codigo) {
  const def = PREDIOS[codigo];
  if (!def) return { bocas: 0, cajas: 0 };
  const actor = { ...ctx, usuario: { id: null, nombre: "Instalación" }, origen: "SISTEMA" };
  let bocas = 0;
  let cajas = 0;
  let orden = 0;
  for (const b of def.bocas) {
    orden++;
    let fila = await t.get("SELECT id FROM predio_boca WHERE predio_id = ? AND LOWER(nombre) = LOWER(?)", [ctx.pid, b.nombre]);
    let id = fila ? fila.id : null;
    if (!id) {
      id = await N.insertar(t, actor, "predio_boca", {
        nombre: b.nombre, es_origen: b.origen, es_destino: b.destino, es_almacen: b.almacen ? 1 : 0, activo: 1, orden,
      });
      bocas++;
    }
    for (const c of b.cajas || []) {
      fila = await t.get("SELECT id FROM predio_caja WHERE predio_id = ? AND boca_id = ? AND LOWER(nombre) = LOWER(?)", [ctx.pid, id, c]);
      if (!fila) {
        await N.insertar(t, actor, "predio_caja", { boca_id: id, nombre: c, ancho_ticket: 80, impresion_automatica: 1, activo: 1 });
        cajas++;
      }
    }
  }
  for (const [clave, valor] of Object.entries(def.config || {})) {
    const fila = await t.get("SELECT id FROM predio_config WHERE predio_id = ? AND clave = ?", [ctx.pid, clave]);
    if (!fila) await N.guardarConfig(t, actor, clave, valor);
  }
  return { bocas, cajas };
}

module.exports = { PREDIOS, sembrarPredio };
