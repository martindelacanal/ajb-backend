"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validarReglas, mapearPolitica } = require("../api/services/politica-cancelacion");
const base = require("./migrar-politicas-cancelacion");

const MIGRATION_ID = "20261015_reinicio_historial_politicas_cancelacion_v1";
const MIGRATION_LOCK = "ajb:migration:20261015_reinicio_politicas_v1";
const TABLAS = Object.freeze({
  politica_cancelacion_vigente: "id",
  politica_cancelacion_servicio_vigente: "servicio_id",
  politica_cancelacion: "id",
  politica_cancelacion_servicio: "politica_id, servicio_id",
  politica_cancelacion_autoria_auditoria: "id",
  reserva_politica_cancelacion: "reserva_id",
  reserva_politica_cancelacion_historica: "reserva_id",
  reserva_cancelacion_politica: "reserva_id",
  politica_cancelacion_migracion: "id",
});

async function leerEstado(connection, bloquear = false) {
  const tablas = {};
  const [historica] = await connection.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reserva_politica_cancelacion_historica'"
  );
  const tablaHistoricaExiste = historica.length > 0;
  // El puntero global serializa publicaciones; los punteros por servicio
  // bloquean nuevas aceptaciones hasta terminar esta inspección/transacción.
  for (const [tabla, orden] of Object.entries(TABLAS)) {
    if (tabla === "reserva_politica_cancelacion_historica" && !tablaHistoricaExiste) { tablas[tabla] = []; continue; }
    [tablas[tabla]] = await connection.query(`SELECT * FROM ${tabla} ORDER BY ${orden}${bloquear ? " FOR UPDATE" : ""}`);
  }
  const [reservasSinAceptacion] = await connection.query(
    `SELECT r.id AS reserva_id, COALESCE(r.servicio_id, rec.servicio_id, ch.servicio_id) AS servicio_id,
       (SELECT p.id FROM politica_cancelacion p
          INNER JOIN politica_cancelacion_servicio ps ON ps.politica_id = p.id
          WHERE ps.servicio_id = COALESCE(r.servicio_id, rec.servicio_id, ch.servicio_id)
            AND r.fecha_creacion IS NOT NULL
          ORDER BY CASE WHEN p.creada_en < r.fecha_creacion THEN 0 ELSE 1 END,
            CASE WHEN p.creada_en < r.fecha_creacion THEN p.creada_en END DESC,
            p.creada_en ASC, p.version ASC, p.id ASC LIMIT 1) AS politica_historica_id,
       (SELECT v.politica_id FROM politica_cancelacion_servicio_vigente v
          WHERE v.servicio_id = COALESCE(r.servicio_id, rec.servicio_id, ch.servicio_id)
            AND r.fecha_creacion IS NOT NULL) AS politica_reinicio_id
       FROM reserva r
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
       LEFT JOIN reserva_politica_cancelacion aceptacion ON aceptacion.reserva_id = r.id
       WHERE aceptacion.reserva_id IS NULL ORDER BY r.id${bloquear ? " FOR UPDATE" : ""}`
  );
  return { tablas, reservasSinAceptacion, tablaHistoricaExiste };
}

function huella(estado) {
  return crypto.createHash("sha256").update(JSON.stringify({ tablas: estado.tablas, reservasSinAceptacion: estado.reservasSinAceptacion })).digest("hex");
}

function reglasDe(politica) {
  const reglas = typeof politica.reglas_json === "string" ? JSON.parse(politica.reglas_json) : politica.reglas_json;
  return JSON.stringify(validarReglas(reglas));
}

function prepararReinicio(estado) {
  const tablas = estado.tablas;
  const politicas = new Map(tablas.politica_cancelacion.map(p => [Number(p.id), p]));
  const vigentes = tablas.politica_cancelacion_servicio_vigente;
  const ids = [...new Set(vigentes.map(v => Number(v.politica_id)))].sort((a, b) => a - b);
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || !politicas.has(id))) {
    throw new Error("Faltan políticas vigentes válidas por servicio");
  }
  const global = tablas.politica_cancelacion_vigente;
  if (global.length !== 1 || Number(global[0].id) !== 1 || !ids.includes(Number(global[0].politica_id))) {
    throw new Error("El puntero global no coincide con una política vigente");
  }
  for (const vigente of vigentes) {
    if (!tablas.politica_cancelacion_servicio.some(p => Number(p.politica_id) === Number(vigente.politica_id)
      && Number(p.servicio_id) === Number(vigente.servicio_id))) {
      throw new Error(`Falta la asignación original del servicio ${vigente.servicio_id}`);
    }
  }
  // Mantener ID y contenido de los snapshots permite conservar condiciones
  // ya aceptadas; una FK a una política que sería eliminada impide el reset.
  for (const tabla of ["reserva_politica_cancelacion", "reserva_cancelacion_politica"]) {
    if (tablas[tabla].some(r => !ids.includes(Number(r.politica_id)))) {
      throw new Error(`${tabla} referencia políticas que serían eliminadas; no se alteran snapshots históricos`);
    }
  }
  const reglas = new Map([...politicas].map(([id, politica]) => [id, reglasDe(politica)]));
  const congeladas = new Map(tablas.reserva_politica_cancelacion_historica.map(r => {
    const snapshot = typeof r.snapshot_json === "string" ? JSON.parse(r.snapshot_json) : r.snapshot_json;
    if (!ids.includes(Number(snapshot?.id))) throw new Error(`La reserva histórica ${r.reserva_id} referencia una política que sería eliminada`);
    validarReglas(snapshot.reglas);
    return [Number(r.reserva_id), snapshot];
  }));
  const congelar = [];
  const afectadas = [];
  for (const r of estado.reservasSinAceptacion) {
    if (congeladas.has(Number(r.reserva_id))) continue;
    const antes = r.politica_historica_id == null ? null : reglas.get(Number(r.politica_historica_id));
    const despues = r.politica_reinicio_id == null ? null : reglas.get(Number(r.politica_reinicio_id));
    if (antes === despues) continue;
    const politicaId = Number(r.politica_historica_id);
    // No registrar consentimiento: este snapshot sólo congela el fallback
    // histórico que la reserva ya tenía. El ID debe seguir existiendo para
    // que una futura confirmación pueda conservar su FK de cancelación.
    if (antes && ids.includes(politicaId) && Number.isSafeInteger(Number(r.servicio_id)) && Number(r.servicio_id) > 0) {
      congelar.push({ reserva_id: Number(r.reserva_id), politica_id: politicaId,
        snapshot: { ...mapearPolitica(politicas.get(politicaId)), servicio_id: Number(r.servicio_id) } });
    } else afectadas.push(Number(r.reserva_id));
  }
  if (afectadas.length) {
    throw new Error(`El reinicio cambiaría condiciones de reservas sin aceptación: ${afectadas.join(", ")}`);
  }
  return {
    politicasConservadas: ids.map(id => ({ id, versionAnterior: Number(politicas.get(id).version), version: 1 })),
    politicasEliminadas: [...politicas.keys()].filter(id => !ids.includes(id)),
    servicios: vigentes.map(v => ({ servicio_id: Number(v.servicio_id), politica_id: Number(v.politica_id) })),
    reservasSinAceptacionVerificadas: estado.reservasSinAceptacion.length,
    reservasHistoricasACongelar: congelar,
    reservasHistoricasConservadas: congeladas.size,
    aceptacionesConservadas: tablas.reserva_politica_cancelacion.length,
    cancelacionesConservadas: tablas.reserva_cancelacion_politica.length,
  };
}

function indicesUnicosVersion(indices) {
  const grupos = new Map();
  for (const indice of indices) {
    if (!grupos.has(indice.Key_name)) grupos.set(indice.Key_name, []);
    grupos.get(indice.Key_name).push(indice);
  }
  return [...grupos].filter(([, filas]) => filas.length === 1
    && Number(filas[0].Non_unique) === 0 && filas[0].Column_name === "version").map(([nombre]) => nombre);
}

async function ejecutarReinicio(connection, { checkOnly = true, backupPath, log = console.log } = {}) {
  let lock = false;
  let transaccion = false;
  try {
    if (!checkOnly) {
      const [locks] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [MIGRATION_LOCK]);
      lock = Number(locks[0]?.adquirido) === 1;
      if (!lock) throw new Error("Otro reinicio de políticas está ejecutándose");
      await connection.beginTransaction();
      transaccion = true;
    }
    const antes = await leerEstado(connection, !checkOnly);
    if (antes.tablas.politica_cancelacion_migracion.some(m => m.id === MIGRATION_ID)) {
      if (transaccion) { await connection.commit(); transaccion = false; }
      const resultado = { migration: MIGRATION_ID, aplicada: true, yaAplicada: true };
      log(JSON.stringify(resultado));
      return resultado;
    }
    const plan = prepararReinicio(antes);
    const [indices] = await connection.query("SHOW INDEX FROM politica_cancelacion");
    const unicos = indicesUnicosVersion(indices);
    if (checkOnly) {
      const resultado = { migration: MIGRATION_ID, aplicada: false, modo: "check", ...plan, indicesUnicosAEliminar: unicos };
      log(JSON.stringify(resultado));
      return resultado;
    }
    if (typeof backupPath !== "string" || !path.isAbsolute(backupPath)) {
      throw new Error("--apply requiere una ruta absoluta de backup nueva");
    }
    const [destino] = await connection.query("SELECT DATABASE() AS base_de_datos");
    const backup = { migration: MIGRATION_ID, creada_en: new Date().toISOString(),
      base_de_datos: destino[0]?.base_de_datos, indices, ...antes };
    // wx impide sobrescribir una copia anterior. El operador debe guardar
    // este archivo fuera del repositorio y con acceso restringido.
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { flag: "wx", mode: 0o600 });
    const huellaAntes = huella(antes);
    await connection.commit();
    transaccion = false;

    // MySQL confirma DDL implícitamente: se hace después del backup y antes
    // de la transacción de datos. Reintentar tras una interrupción es seguro.
    const alteraciones = unicos.map(nombre => `DROP INDEX ${connection.escapeId(nombre)}`);
    if (!indices.some(i => i.Key_name === "idx_politica_cancelacion_version") || unicos.includes("idx_politica_cancelacion_version")) {
      alteraciones.push("ADD INDEX idx_politica_cancelacion_version (version, id)");
    }
    if (alteraciones.length) await connection.query(`ALTER TABLE politica_cancelacion ${alteraciones.join(", ")}`);
    if (!antes.tablaHistoricaExiste) await connection.query(
      `CREATE TABLE IF NOT EXISTS reserva_politica_cancelacion_historica (
        reserva_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        snapshot_json JSON NOT NULL,
        registrada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    await connection.beginTransaction();
    transaccion = true;
    const actual = await leerEstado(connection, true);
    if (huella(actual) !== huellaAntes) {
      throw new Error("Hubo actividad durante el cambio de índice. No se modificaron datos; reintentar con un backup nuevo y el backend detenido");
    }
    prepararReinicio(actual);
    const ids = plan.politicasConservadas.map(p => p.id);
    for (const reserva of plan.reservasHistoricasACongelar) {
      await connection.query("INSERT INTO reserva_politica_cancelacion_historica (reserva_id, snapshot_json) VALUES (?, ?)",
        [reserva.reserva_id, JSON.stringify(reserva.snapshot)]);
    }
    await connection.query("DELETE FROM politica_cancelacion_autoria_auditoria");
    await connection.query(
      `DELETE ps FROM politica_cancelacion_servicio ps
       LEFT JOIN politica_cancelacion_servicio_vigente v
         ON v.servicio_id = ps.servicio_id AND v.politica_id = ps.politica_id
       WHERE v.servicio_id IS NULL`
    );
    await connection.query("DELETE FROM politica_cancelacion WHERE id NOT IN (?)", [ids]);
    await connection.query("UPDATE politica_cancelacion SET version = 1 WHERE id IN (?)", [ids]);
    const detalle = { ...plan, backup_sha256: crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex") };
    await connection.query("INSERT INTO politica_cancelacion_migracion (id, detalle_json) VALUES (?, ?)", [MIGRATION_ID, JSON.stringify(detalle)]);
    await connection.commit();
    transaccion = false;
    const resultado = { migration: MIGRATION_ID, aplicada: true, yaAplicada: false, backupPath, ...plan };
    log(JSON.stringify(resultado));
    return resultado;
  } catch (error) {
    if (transaccion) await connection.rollback();
    throw error;
  } finally {
    if (lock) await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
  }
}

async function main(argv = process.argv.slice(2)) {
  const backupArgumentos = argv.filter(arg => arg.startsWith("--backup="));
  if (backupArgumentos.length > 1) throw new Error("Usá una única ruta --backup=RUTA_ABSOLUTA");
  const opciones = base.parsearArgumentos(argv.filter(arg => !arg.startsWith("--backup=")));
  opciones.backupPath = backupArgumentos[0]?.slice("--backup=".length);
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
  const { remoto } = base.validarDestino(opciones);
  const modoTls = String(process.env.DB_SSL_MODE || "disabled").toLowerCase();
  if (!["disabled", "verify-ca", "verify-full"].includes(modoTls)) throw new Error("DB_SSL_MODE inválido");
  if (remoto && process.env.NODE_ENV === "production" && modoTls === "disabled") throw new Error("TLS es obligatorio en producción remota");
  const connection = await require("mysql2/promise").createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, port: Number(process.env.DB_PORT || 3306),
    timezone: "-03:00", dateStrings: ["DATE"], multipleStatements: false,
    ssl: modoTls === "disabled" ? undefined : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true },
  });
  try {
    await connection.query("SET SESSION time_zone = '-03:00'");
    await ejecutarReinicio(connection, opciones);
  } finally { await connection.end(); }
}

if (require.main === module) main().catch(error => {
  console.error("Error reiniciando historial de políticas:", error.message);
  process.exitCode = 1;
});

module.exports = { MIGRATION_ID, MIGRATION_LOCK, TABLAS, leerEstado, prepararReinicio, indicesUnicosVersion, ejecutarReinicio };
