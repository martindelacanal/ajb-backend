"use strict";

// Adaptador MySQL para el sistema general (réplica central de los predios).
// Recibe el pool de mysql2 del backend y expone la misma interfaz que db-sqlite.js.

const { fechaHora } = require("./util");

function normalizarFila(fila) {
  if (!fila) return fila;
  const salida = {};
  for (const [k, v] of Object.entries(fila)) {
    salida[k] = v instanceof Date ? fechaHora(v) : v;
  }
  return salida;
}

function valorMysql(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

function envolver(conexionPromesa, comunes) {
  return {
    ...comunes,
    conexionTurismo: conexionPromesa,
    async all(sql, params = []) {
      const [filas] = await conexionPromesa.query(sql, params.map(valorMysql));
      return filas.map(normalizarFila);
    },
    async get(sql, params = []) {
      const [filas] = await conexionPromesa.query(sql, params.map(valorMysql));
      return normalizarFila(filas[0]);
    },
    async run(sql, params = []) {
      const [r] = await conexionPromesa.query(sql, params.map(valorMysql));
      return { cambios: Number(r.affectedRows || 0), insertId: Number(r.insertId || 0) };
    },
  };
}

function crearMysql(poolPromesa, { predioId }) {
  const comunes = {
    dialecto: "mysql",
    predioId,
    forUpdate: " FOR UPDATE",
    insertIgnore: "INSERT IGNORE",
    buscar: (expr) => expr,
    normParam: (v) => String(v ?? ""),
    lista: (n) => new Array(Math.max(1, n)).fill("?").join(", "),
  };
  const base = envolver(poolPromesa, comunes);
  return {
    ...base,
    async tx(trabajo) {
      const conexion = await poolPromesa.getConnection();
      const t = envolver(conexion, comunes);
      t.tx = async (otro) => otro(t);
      try {
        await conexion.beginTransaction();
        const r = await trabajo(t);
        await conexion.commit();
        return r;
      } catch (e) {
        try { await conexion.rollback(); } catch (_e) { /* sin conexión */ }
        throw e;
      } finally {
        conexion.release();
      }
    },
  };
}

module.exports = { crearMysql, normalizarFila };
