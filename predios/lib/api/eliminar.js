"use strict";

// Eliminar productos y proveedores, de a uno o varios juntos (los elegidos en la tabla o todos
// los que coinciden con un filtro). Lo que nunca se usó se borra del todo; lo que ya tiene
// ventas, compras, solicitudes o movimientos se da de baja para no romper el historial.

const U = require("../util");
const N = require("../negocio");
const { construirWhere, LISTADOS, traducir } = require("../listados");
const { exigirAdmin } = require("./comun");

const MAXIMO = 5000;
const TAM_LOTE = 400;

const ENTIDADES = {
  productos: {
    tabla: "predio_producto",
    alias: "p",
    campoNombre: "nombre",
    campoCodigo: "codigo",
    singular: "producto",
    plural: "productos",
    // Si aparece en alguna de estas tablas, se da de baja en lugar de borrarse.
    usos: [
      { tabla: "predio_venta_item", col: "producto_id", texto: "ventas" },
      { tabla: "predio_compra_item", col: "producto_id", texto: "compras" },
      { tabla: "predio_solicitud", col: "producto_id", texto: "solicitudes" },
      { tabla: "predio_baja", col: "producto_id", texto: "bajas" },
      { tabla: "predio_movimiento", col: "producto_id", texto: "movimientos", extra: "AND tipo NOT IN ('ALTA_INICIAL', 'AJUSTE')" },
    ],
    // Filas propias del producto que se borran con él (precios, stock cargado a mano).
    dependientes: [
      { tabla: "predio_precio_historial", col: "producto_id" },
      { tabla: "predio_movimiento", col: "producto_id" },
      { tabla: "predio_stock", col: "producto_id" },
    ],
  },
  proveedores: {
    tabla: "predio_proveedor",
    alias: "pr",
    campoNombre: "razon_social",
    campoCodigo: "codigo",
    singular: "proveedor",
    plural: "proveedores",
    usos: [{ tabla: "predio_compra", col: "proveedor_id", texto: "compras" }],
    dependientes: [],
  },
};

function lotes(lista) {
  const salida = [];
  for (let i = 0; i < lista.length; i += TAM_LOTE) salida.push(lista.slice(i, i + TAM_LOTE));
  return salida;
}

function marcas(n) {
  return Array(n).fill("?").join(", ");
}

// Los elegidos: una lista de IDs o la consulta de la tabla (búsqueda + filtros).
async function elegidos(t, ctx, clave) {
  const ent = ENTIDADES[clave];
  const b = ctx.body || {};
  const columnas = `${ent.alias}.id AS id, ${ent.alias}.${ent.campoNombre} AS nombre, ${ent.alias}.${ent.campoCodigo} AS codigo, ${ent.alias}.activo AS activo`;
  if (Array.isArray(b.ids)) {
    const ids = [...new Set(b.ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    if (!ids.length) throw U.error(`No elegiste ningún ${ent.singular}`);
    if (ids.length > MAXIMO) throw U.error(`Se pueden eliminar hasta ${MAXIMO} por vez`);
    const filas = [];
    for (const l of lotes(ids)) {
      filas.push(...await t.all(
        `SELECT ${columnas} FROM ${ent.tabla} ${ent.alias} WHERE ${ent.alias}.predio_id = ? AND ${ent.alias}.id IN (${marcas(l.length)})`,
        [ctx.pid, ...l]));
    }
    return filas;
  }
  if (b.consulta && typeof b.consulta === "object") {
    const consulta = {};
    for (const [k, v] of Object.entries(b.consulta)) {
      if ((k === "q" || /^f_[a-z_]+$/.test(k)) && v !== null && v !== undefined) consulta[k] = String(v).slice(0, 120);
    }
    if (clave === "productos") {
      const almacen = await N.bocaAlmacen(t, ctx);
      ctx.almacenId = almacen ? almacen.id : null;
    }
    const def = LISTADOS[clave];
    const { sql, valores, nombres } = construirWhere(def, ctx, consulta, t);
    const valoresFrom = [];
    const from = traducir(def.from, valoresFrom, nombres);
    const filas = await t.all(
      `SELECT ${columnas} FROM ${from} WHERE ${sql} ORDER BY ${ent.alias}.${ent.campoNombre} LIMIT ${MAXIMO + 1}`,
      [...valoresFrom, ...valores]);
    if (filas.length > MAXIMO) throw U.error(`Son más de ${MAXIMO}: ajustá los filtros y eliminá por partes`);
    return filas;
  }
  throw U.error(`No elegiste ningún ${ent.singular}`);
}

async function clasificar(t, ctx, clave, filas) {
  const ent = ENTIDADES[clave];
  const ids = filas.map((f) => Number(f.id));
  const usos = new Map();
  for (const u of ent.usos) {
    for (const l of lotes(ids)) {
      const encontrados = await t.all(
        `SELECT DISTINCT ${u.col} AS id FROM ${u.tabla} WHERE predio_id = ? AND ${u.col} IN (${marcas(l.length)}) ${u.extra || ""}`,
        [ctx.pid, ...l]);
      for (const x of encontrados) {
        const id = Number(x.id);
        if (!usos.has(id)) usos.set(id, []);
        usos.get(id).push(u.texto);
      }
    }
  }
  const borrar = [];
  const baja = [];
  const sinCambios = [];
  for (const f of filas) {
    const fila = { id: Number(f.id), nombre: f.nombre, codigo: f.codigo || null };
    const u = usos.get(fila.id);
    if (!u) borrar.push(fila);
    else if (Number(f.activo)) baja.push({ ...fila, usos: u });
    else sinCambios.push({ ...fila, usos: u });
  }
  return { borrar, baja, sinCambios };
}

function resumen(c) {
  const muestra = (lista) => lista.slice(0, 8).map((f) => ({ id: f.id, nombre: f.nombre, codigo: f.codigo, usos: f.usos }));
  return {
    cantidad: c.borrar.length + c.baja.length + c.sinCambios.length,
    se_borran: c.borrar.length,
    se_dan_de_baja: c.baja.length,
    sin_cambios: c.sinCambios.length,
    muestra_borrar: muestra(c.borrar),
    muestra_baja: muestra(c.baja),
    muestra_sin_cambios: muestra(c.sinCambios),
  };
}

function previa(clave) {
  return async (ctx) => {
    exigirAdmin(ctx);
    const filas = await elegidos(ctx.db, ctx, clave);
    return resumen(await clasificar(ctx.db, ctx, clave, filas));
  };
}

function eliminar(clave) {
  const ent = ENTIDADES[clave];
  return async (ctx) => {
    exigirAdmin(ctx);
    return ctx.db.tx(async (t) => {
      const filas = await elegidos(t, ctx, clave);
      const c = await clasificar(t, ctx, clave, filas);
      for (const l of lotes(c.borrar.map((f) => f.id))) {
        for (const d of ent.dependientes) {
          await t.run(`DELETE FROM ${d.tabla} WHERE predio_id = ? AND ${d.col} IN (${marcas(l.length)})`, [ctx.pid, ...l]);
        }
        await t.run(`DELETE FROM ${ent.tabla} WHERE predio_id = ? AND id IN (${marcas(l.length)})`, [ctx.pid, ...l]);
      }
      for (const f of c.baja) await N.actualizar(t, ctx, ent.tabla, f.id, { activo: 0 });
      for (const f of c.borrar) {
        await N.auditar(t, ctx, `Eliminación de ${ent.singular}`, ent.singular, f.id, { nombre: f.nombre, codigo: f.codigo });
      }
      for (const f of c.baja) {
        await N.auditar(t, ctx, `Baja de ${ent.singular} al eliminar (tiene ${f.usos.join(", ")})`, ent.singular, f.id, { nombre: f.nombre, codigo: f.codigo });
      }
      const partes = [];
      const n = (k, sing, plur) => `${k} ${k === 1 ? sing : plur}`;
      if (c.borrar.length) partes.push(`Se ${c.borrar.length === 1 ? "eliminó" : "eliminaron"} ${n(c.borrar.length, ent.singular, ent.plural)}`);
      if (c.baja.length) {
        partes.push(`${partes.length ? "y se" : "Se"} ${c.baja.length === 1 ? "dio" : "dieron"} de baja ${n(c.baja.length, ent.singular, ent.plural)} con historial`);
      }
      return {
        eliminados: c.borrar.length,
        dados_de_baja: c.baja.length,
        sin_cambios: c.sinCambios.length,
        mensaje: partes.length ? partes.join(" ") : "No había nada para eliminar",
      };
    });
  };
}

module.exports = {
  ENTIDADES,
  rutas: [
    { m: "POST", p: "/productos/eliminar/previa", h: previa("productos"), roles: ["ADMIN"] },
    { m: "POST", p: "/productos/eliminar", h: eliminar("productos"), escritura: true, roles: ["ADMIN"] },
    { m: "POST", p: "/proveedores/eliminar/previa", h: previa("proveedores"), roles: ["ADMIN"] },
    { m: "POST", p: "/proveedores/eliminar", h: eliminar("proveedores"), escritura: true, roles: ["ADMIN"] },
  ],
};
