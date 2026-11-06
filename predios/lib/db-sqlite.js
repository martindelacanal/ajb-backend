"use strict";

// Adaptador SQLite (node:sqlite, incluido en Node 22) para la notebook del predio.
// Interfaz común con db-mysql.js: all/get/run/tx + pequeños ayudantes de dialecto.

const fs = require("node:fs");
const path = require("node:path");
const { TABLAS, NOMBRES_TABLAS, columnasDe, tipoSql, ddlTabla, indicesSqlite } = require("./esquema");
const { normalizarBusqueda } = require("./util");

let DatabaseSync;
function cargarSqlite() {
  if (!DatabaseSync) {
    // Silencia el aviso "SQLite is an experimental feature": en Node 22 la API es estable para este uso.
    const emitirOriginal = process.emitWarning;
    process.emitWarning = (aviso, ...resto) => {
      const texto = typeof aviso === "string" ? aviso : aviso?.message;
      if (/SQLite is an experimental feature/i.test(String(texto))) return;
      return emitirOriginal.call(process, aviso, ...resto);
    };
    ({ DatabaseSync } = require("node:sqlite"));
  }
  return DatabaseSync;
}

function valorSqlite(v) {
  if (v === undefined || v === null) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

function plano(fila) {
  return fila ? { ...fila } : fila;
}

class Candado {
  constructor() {
    this.cola = Promise.resolve();
  }
  async con(trabajo) {
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const anterior = this.cola;
    this.cola = anterior.then(() => espera);
    await anterior;
    try {
      return await trabajo();
    } finally {
      liberar();
    }
  }
}

// Tablas sólo locales (no se replican).
const TABLAS_LOCALES = [
  `CREATE TABLE IF NOT EXISTS predio_meta (clave TEXT PRIMARY KEY, valor TEXT)`,
  `CREATE TABLE IF NOT EXISTS predio_outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     tabla TEXT NOT NULL,
     fila_id INTEGER NOT NULL,
     op TEXT NOT NULL,
     fecha TEXT DEFAULT (datetime('now','-3 hours'))
   )`,
  `CREATE TABLE IF NOT EXISTS predio_secuencia (predio_id INTEGER NOT NULL, tabla TEXT NOT NULL, ultimo INTEGER NOT NULL, PRIMARY KEY (predio_id, tabla))`,
  `CREATE TABLE IF NOT EXISTS predio_sesion (
     token_hash TEXT PRIMARY KEY,
     usuario_id INTEGER NOT NULL,
     recordar INTEGER NOT NULL DEFAULT 0,
     creada TEXT NOT NULL,
     vence TEXT,
     ultimo_uso TEXT,
     ip TEXT,
     agente TEXT,
     boca_id INTEGER,
     caja_id INTEGER,
     turno_id INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS predio_admin_cache (
     documento TEXT PRIMARY KEY,
     hash TEXT NOT NULL,
     nombre TEXT,
     general_id INTEGER,
     actualizado TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS predio_acceso_control (
     clave TEXT PRIMARY KEY, fallos INTEGER NOT NULL, inicio_ms INTEGER NOT NULL,
     ultimo_ms INTEGER NOT NULL, bloqueado_hasta_ms INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS predio_acceso_intento (
     id INTEGER PRIMARY KEY AUTOINCREMENT, cuenta_clave TEXT NOT NULL,
     fecha_ms INTEGER NOT NULL, detalle TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_acceso_intento_cuenta ON predio_acceso_intento (cuenta_clave, fecha_ms)`,
  `CREATE TABLE IF NOT EXISTS predio_dispositivo (
     id TEXT PRIMARY KEY, boca_id INTEGER, caja_id INTEGER, actualizado TEXT,
     ip TEXT, agente TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS predio_comando_ejecutado (
     comando_id INTEGER PRIMARY KEY,
     fecha TEXT,
     ok INTEGER,
     status INTEGER,
     respuesta TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS predio_peticion (
     operacion_id TEXT NOT NULL,
     usuario_id INTEGER NOT NULL,
     peticion_sha256 TEXT NOT NULL,
     fecha TEXT NOT NULL,
     status INTEGER NOT NULL,
     respuesta TEXT NOT NULL,
     PRIMARY KEY (usuario_id, operacion_id)
   )`,
];

function crearSqlite(archivo, { predioId }) {
  const Database = cargarSqlite();
  if (archivo !== ":memory:") fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const conexion = new Database(archivo);
  conexion.exec("PRAGMA journal_mode = WAL");
  conexion.exec("PRAGMA synchronous = NORMAL");
  conexion.exec("PRAGMA busy_timeout = 5000");
  conexion.exec("PRAGMA foreign_keys = OFF");
  conexion.function("norm", { deterministic: true }, (s) => (s === null || s === undefined ? null : normalizarBusqueda(s)));

  const sentencias = new Map();
  function preparar(sql) {
    let s = sentencias.get(sql);
    if (!s) {
      s = conexion.prepare(sql);
      sentencias.set(sql, s);
      if (sentencias.size > 500) sentencias.delete(sentencias.keys().next().value);
    }
    return s;
  }

  const candado = new Candado();
  let enTransaccion = false;
  let controlTransacciones = null;

  const ejecutor = {
    all(sql, params = []) {
      return preparar(sql).all(...params.map(valorSqlite)).map(plano);
    },
    get(sql, params = []) {
      return plano(preparar(sql).get(...params.map(valorSqlite)));
    },
    run(sql, params = []) {
      const r = preparar(sql).run(...params.map(valorSqlite));
      return { cambios: Number(r.changes), insertId: Number(r.lastInsertRowid) };
    },
  };

  const comunes = {
    dialecto: "sqlite",
    predioId,
    forUpdate: "",
    insertIgnore: "INSERT OR IGNORE",
    buscar: (expr) => `norm(${expr})`,
    normParam: (v) => normalizarBusqueda(v),
    lista: (n) => new Array(Math.max(1, n)).fill("?").join(", "),
  };

  const transaccional = {
    ...comunes,
    async all(sql, params) { return ejecutor.all(sql, params); },
    async get(sql, params) { return ejecutor.get(sql, params); },
    async run(sql, params) { return ejecutor.run(sql, params); },
    async tx(trabajo) { return trabajo(transaccional); },
  };

  const db = {
    ...comunes,
    conexion,
    archivo,
    async all(sql, params) { return candado.con(async () => ejecutor.all(sql, params)); },
    async get(sql, params) { return candado.con(async () => ejecutor.get(sql, params)); },
    async run(sql, params) {
      if (controlTransacciones) return db.tx(t => t.run(sql, params));
      return candado.con(async () => ejecutor.run(sql, params));
    },
    async tx(trabajo) {
      return candado.con(async () => {
        if (controlTransacciones) await controlTransacciones.antesTransaccion();
        enTransaccion = true;
        let confirmado = false;
        try {
          conexion.exec("BEGIN IMMEDIATE");
          const r = await trabajo(transaccional);
          if (controlTransacciones) await controlTransacciones.antesCommit();
          conexion.exec("COMMIT");
          confirmado = true;
          enTransaccion = false;
          if (controlTransacciones) await controlTransacciones.despuesTransaccion();
          return r;
        } catch (e) {
          if (!confirmado) {
            try { conexion.exec("ROLLBACK"); } catch (_e) { /* ya revertida */ }
            if (controlTransacciones) await controlTransacciones.abortarTransaccion();
          }
          throw e;
        } finally {
          enTransaccion = false;
        }
      });
    },
    configurarTransacciones(control) { controlTransacciones = control || null; },
    // Trabajo sincrónico exclusivo: nunca corre en medio de una transacción abierta.
    async exclusivo(trabajo) {
      return candado.con(async () => trabajo());
    },
    exec(sql) { conexion.exec(sql); },
    cerrar() { try { conexion.close(); } catch (_e) { /* cerrada */ } },
  };

  return db;
}

function columnasExistentes(db, tabla) {
  return new Set(db.conexion.prepare(`PRAGMA table_info("${tabla}")`).all().map((c) => c.name));
}

// Crea o completa el esquema (idempotente): tablas, columnas nuevas, índices y disparadores
// que anotan cada cambio en la bandeja de salida (outbox) para sincronizar.
function asegurarEsquema(db) {
  for (const sql of TABLAS_LOCALES) db.exec(sql);
  for (const tabla of NOMBRES_TABLAS) {
    db.exec(ddlTabla(tabla, "sqlite"));
    const existentes = columnasExistentes(db, tabla);
    for (const [col, tipo] of Object.entries(columnasDe(tabla))) {
      if (!existentes.has(col)) {
        const def = tipoSql(tipo, "sqlite").replace(" NOT NULL", "");
        db.exec(`ALTER TABLE "${tabla}" ADD COLUMN "${col}" ${def}`);
      }
    }
    for (const sql of indicesSqlite(tabla)) db.exec(sql);
    db.exec(`CREATE TRIGGER IF NOT EXISTS "trg_${tabla}_ai" AFTER INSERT ON "${tabla}" BEGIN INSERT INTO predio_outbox (tabla, fila_id, op) VALUES ('${tabla}', NEW.id, 'U'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS "trg_${tabla}_au" AFTER UPDATE ON "${tabla}" BEGIN INSERT INTO predio_outbox (tabla, fila_id, op) VALUES ('${tabla}', NEW.id, 'U'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS "trg_${tabla}_ad" AFTER DELETE ON "${tabla}" BEGIN INSERT INTO predio_outbox (tabla, fila_id, op) VALUES ('${tabla}', OLD.id, 'D'); END`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS ix_outbox_tabla_fila ON predio_outbox (tabla, fila_id)");
}

function leerMeta(db, clave) {
  const fila = db.conexion.prepare("SELECT valor FROM predio_meta WHERE clave = ?").get(clave);
  return fila ? fila.valor : null;
}

function escribirMeta(db, clave, valor) {
  db.conexion.prepare("INSERT INTO predio_meta (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
    .run(clave, valor === null || valor === undefined ? null : String(valor));
}

module.exports = {
  crearSqlite,
  asegurarEsquema,
  leerMeta,
  escribirMeta,
  TABLAS,
};
