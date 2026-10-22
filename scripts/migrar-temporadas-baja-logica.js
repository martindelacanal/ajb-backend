"use strict";

// Baja lógica de tarifas al editar temporadas (2026-10-21).
//
// Hasta ahora PUT /temporada/:id borraba las tarifas de la temporada (DELETE FROM
// tarifa) y las volvía a insertar, y PUT /admin/bloques/:id borraba la temporada
// anterior del bloque. Desde este cambio no se borra nada: lo que se quita o se
// reemplaza queda dado de baja para auditarlo o rehabilitarlo
// (scripts/rehabilitar-tarifas-temporada.js). Esta migración agrega:
//
//   tarifa            eliminado TINYINT(1) NOT NULL DEFAULT 0, fecha_eliminacion,
//                     eliminado_usuario_id, eliminado_motivo ('QUITADO','REEMPLAZADO'),
//                     eliminado_lote CHAR(36) (un UUID por guardado);
//                     índices (temporada_tarifa_id, eliminado) y (eliminado_lote).
//   tarifa_adicional  las mismas salvo eliminado (la baja sigue siendo activo = 0);
//                     índice (eliminado_lote).
//
// No reescribe filas: todas las tarifas quedan vigentes (eliminado = 0) y los
// adicionales que ya estaban inactivos quedan sin motivo ni fecha (legado). Sin CHECK:
// las columnas las escribe sólo el backend. No necesita GRANT: no hay tablas nuevas y
// el usuario de la API tiene DML por tabla sobre tarifa y tarifa_adicional.
//
// Idempotente: cada columna e índice se agrega sólo si falta (information_schema). Si
// una columna ya existe con otro tipo, o el nombre de un índice está tomado por otras
// columnas, frena sin tocar nada. Registra la corrida en ajb_schema_migration.
//
// Uso:
//   node scripts/migrar-temporadas-baja-logica.js --check             → sólo informa (sin DDL)
//   node scripts/migrar-temporadas-baja-logica.js                     → aplica en develop (DB_HOST local)
//   node scripts/migrar-temporadas-baja-logica.js --allow-production  → obligatorio si DB_HOST no es local
//
// Develop (dotenv no pisa variables ya definidas; el bloque activo del .env apunta a la RDS):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb npm run migrate:temporadas-baja-logica
// Producción (cuenta administrativa de la RDS, con ALTER e INDEX):
//   npm run migrate:temporadas-baja-logica:check
//   npm run migrate:temporadas-baja-logica -- --allow-production
//
// Orden de deploy: correrla en develop y en producción ANTES de desplegar el backend
// nuevo (las consultas de tarifas leen eliminado: sin la columna responden 500).
// Vuelta atrás del backend: el código viejo no filtra eliminado y volvería a cotizar lo
// dado de baja (TARIFA_AMBIGUA). Antes hay que pasar las filas con eliminado = 1 a una
// tabla de respaldo y sacarlas de tarifa.
//
// TLS: si DB_SSL_MODE es verify-ca o verify-full se conecta con DB_SSL_CA_PATH.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MIGRATION_ID = "20261021_temporadas_baja_logica_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;

// Columnas comunes de auditoría de la baja (las dos tablas).
const COLUMNAS_AUDITORIA = Object.freeze([
  Object.freeze({
    nombre: "fecha_eliminacion",
    dataType: "datetime",
    nulable: true,
    definicion: "DATETIME NULL DEFAULT NULL",
  }),
  Object.freeze({
    nombre: "eliminado_usuario_id",
    dataType: "int",
    nulable: true,
    // Sin FK: la baja de un usuario no tiene que arrastrar ni frenar la auditoría.
    definicion: "INT NULL DEFAULT NULL",
  }),
  Object.freeze({
    nombre: "eliminado_motivo",
    dataType: "enum",
    columnType: "enum('QUITADO','REEMPLAZADO')",
    nulable: true,
    definicion: "ENUM('QUITADO','REEMPLAZADO') NULL DEFAULT NULL",
  }),
  Object.freeze({
    nombre: "eliminado_lote",
    dataType: "char",
    columnType: "char(36)",
    nulable: true,
    definicion: "CHAR(36) NULL DEFAULT NULL",
  }),
]);

// Por tabla: columna de referencia que tiene que existir y columnas a agregar, en
// orden (cada una va AFTER la anterior; la primera, AFTER `despues` si existe).
const TABLAS = Object.freeze([
  Object.freeze({
    tabla: "tarifa",
    requeridas: Object.freeze(["temporada_tarifa_id"]),
    despues: "turismo_tarifa_regla_id",
    columnas: Object.freeze([
      Object.freeze({
        nombre: "eliminado",
        dataType: "tinyint",
        nulable: false,
        predeterminado: "0",
        definicion:
          "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = dada de baja al editar la temporada: no cotiza ni se muestra'",
      }),
      ...COLUMNAS_AUDITORIA,
    ]),
  }),
  Object.freeze({
    tabla: "tarifa_adicional",
    requeridas: Object.freeze(["temporada_tarifa_id", "activo"]),
    despues: "activo",
    columnas: COLUMNAS_AUDITORIA,
  }),
]);

const INDICES = Object.freeze([
  Object.freeze({
    tabla: "tarifa",
    nombre: "idx_tarifa_temporada_eliminado",
    columnas: Object.freeze(["temporada_tarifa_id", "eliminado"]),
  }),
  Object.freeze({ tabla: "tarifa", nombre: "idx_tarifa_eliminado_lote", columnas: Object.freeze(["eliminado_lote"]) }),
  Object.freeze({
    tabla: "tarifa_adicional",
    nombre: "idx_tarifa_adicional_lote",
    columnas: Object.freeze(["eliminado_lote"]),
  }),
]);

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({ revision: MIGRATION_REVISION, tablas: TABLAS, indices: INDICES }))
  .digest("hex");

function parsearArgumentos(argv = process.argv.slice(2)) {
  const desconocidos = argv.filter((arg) => !["--check", "--allow-production"].includes(arg));
  if (desconocidos.length > 0) {
    throw new Error(`Argumentos desconocidos: ${desconocidos.join(" ")}`);
  }
  return {
    checkOnly: argv.includes("--check"),
    allowProduction: argv.includes("--allow-production"),
  };
}

function esHostLocal(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host || "").trim().toLowerCase());
}

function validarDestino(opciones, env = process.env) {
  for (const variable of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[variable]) throw new Error(`Falta la variable de entorno ${variable}`);
  }
  const remoto = !esHostLocal(env.DB_HOST);
  const produccion = String(env.NODE_ENV || "").trim().toLowerCase() === "production";
  if ((remoto || produccion) && !opciones.checkOnly && !opciones.allowProduction) {
    throw new Error(
      `DB_HOST=${env.DB_HOST} no es local. Para aplicar contra producción agregá --allow-production.`
    );
  }
  return { remoto, produccion };
}

function configuracionTls(env = process.env) {
  const modo = String(env.DB_SSL_MODE || "disabled").trim().toLowerCase();
  if (modo === "disabled") return undefined;
  if (!["verify-ca", "verify-full"].includes(modo)) {
    throw new Error("DB_SSL_MODE debe ser disabled, verify-ca o verify-full");
  }
  const caPath = String(env.DB_SSL_CA_PATH || "").trim();
  if (!caPath || !fs.existsSync(caPath)) {
    throw new Error("DB_SSL_CA_PATH debe apuntar a un certificado existente cuando TLS está habilitado");
  }
  return { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
}

async function existeTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  return Number(rows[0]?.total) > 0;
}

/** Columnas de la tabla: Map<nombre en minúsculas, fila de information_schema.COLUMNS>. */
async function leerColumnas(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  return new Map(rows.map((fila) => [String(fila.COLUMN_NAME).toLowerCase(), fila]));
}

/** Índices de la tabla agrupados por nombre: Map<nombre, columnas en orden>. */
async function leerIndices(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [tabla]
  );
  const indices = new Map();
  for (const fila of rows) {
    const nombre = String(fila.INDEX_NAME);
    if (!indices.has(nombre)) indices.set(nombre, []);
    indices.get(nombre)[Number(fila.SEQ_IN_INDEX) - 1] = String(fila.COLUMN_NAME || "").toLowerCase();
  }
  return indices;
}

/** Diferencias entre una columna existente y la esperada (lista vacía si coincide). */
function diferenciasColumna(existente, esperada) {
  const diferencias = [];
  const dataType = String(existente.DATA_TYPE || "").toLowerCase();
  if (dataType !== esperada.dataType) diferencias.push(`tipo ${dataType} (se esperaba ${esperada.dataType})`);
  const columnType = String(existente.COLUMN_TYPE || "").toLowerCase();
  if (esperada.columnType && columnType !== esperada.columnType.toLowerCase()) {
    diferencias.push(`${columnType} (se esperaba ${esperada.columnType})`);
  }
  const nulable = String(existente.IS_NULLABLE || "").toUpperCase() === "YES";
  if (nulable !== esperada.nulable) diferencias.push(esperada.nulable ? "NOT NULL (se esperaba NULL)" : "NULL (se esperaba NOT NULL)");
  if (esperada.predeterminado !== undefined && String(existente.COLUMN_DEFAULT ?? "") !== esperada.predeterminado) {
    diferencias.push(`DEFAULT ${existente.COLUMN_DEFAULT ?? "NULL"} (se esperaba ${esperada.predeterminado})`);
  }
  return diferencias;
}

/**
 * Plan de columnas de una tabla: { faltantes, existentes, ddl }. Lanza si falta una
 * columna requerida o si una de las nuevas ya existe con otro tipo.
 */
function planColumnas(definicion, columnas) {
  for (const requerida of definicion.requeridas) {
    if (!columnas.has(requerida)) throw new Error(`Falta la columna ${definicion.tabla}.${requerida}`);
  }
  const conflictos = [];
  const faltantes = [];
  const existentes = [];
  const clausulas = [];
  let anterior = definicion.despues;
  for (const columna of definicion.columnas) {
    const actual = columnas.get(columna.nombre);
    if (actual) {
      const diferencias = diferenciasColumna(actual, columna);
      if (diferencias.length > 0) conflictos.push(`${definicion.tabla}.${columna.nombre}: ${diferencias.join(", ")}`);
      existentes.push(columna.nombre);
    } else {
      const ancla = columnas.has(anterior) || faltantes.includes(anterior) ? ` AFTER ${anterior}` : "";
      clausulas.push(`ADD COLUMN ${columna.nombre} ${columna.definicion}${ancla}`);
      faltantes.push(columna.nombre);
    }
    anterior = columna.nombre;
  }
  if (conflictos.length > 0) {
    throw new Error(`Hay columnas que ya existen con otra definición. Revisalas a mano: ${conflictos.join("; ")}`);
  }
  return {
    faltantes,
    existentes,
    ddl: clausulas.length > 0 ? `ALTER TABLE ${definicion.tabla} ${clausulas.join(", ")}` : null,
  };
}

/**
 * ¿Ya hay un índice que sirva? Uno cuyas primeras columnas sean las buscadas, con el
 * nombre que sea. Si el nombre que queremos usar está tomado por otras columnas, lanza.
 */
function buscarIndiceEquivalente(indices, definicion) {
  const buscadas = definicion.columnas.map((columna) => columna.toLowerCase());
  for (const [nombre, columnas] of indices) {
    if (buscadas.every((columna, posicion) => columnas[posicion] === columna)) return { nombre, columnas };
  }
  if (indices.has(definicion.nombre)) {
    throw new Error(
      `${definicion.tabla} ya tiene un índice ${definicion.nombre} sobre (${indices.get(definicion.nombre).join(", ")}), ` +
        `no sobre (${definicion.columnas.join(", ")}). Revisalo a mano antes de seguir.`
    );
  }
  return null;
}

function ddlIndice(definicion) {
  return `ALTER TABLE ${definicion.tabla} ADD INDEX ${definicion.nombre} (${definicion.columnas.join(", ")}), ALGORITHM=INPLACE, LOCK=NONE`;
}

/** Conteos informativos (se adaptan a las columnas que existan en ese momento). */
async function contarEstado(connection) {
  const columnasTarifa = await leerColumnas(connection, "tarifa");
  const columnasAdicional = await leerColumnas(connection, "tarifa_adicional");
  const [porOrigen] = await connection.query(
    `SELECT COALESCE(tt.origen, 'SIN TEMPORADA') AS origen, COUNT(*) AS filas
       FROM tarifa t
       LEFT JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
      GROUP BY COALESCE(tt.origen, 'SIN TEMPORADA')
      ORDER BY origen`
  );
  const [[conReservas]] = await connection.query(
    `SELECT COUNT(DISTINCT t.temporada_tarifa_id) AS temporadas
       FROM tarifa t
       INNER JOIN reserva_familiar_tarifa rft ON rft.tarifa_id = t.id
      WHERE t.temporada_tarifa_id IS NOT NULL`
  );
  const [[adicionalesLegado]] = await connection.query(
    `SELECT COUNT(*) AS filas FROM tarifa_adicional
      WHERE activo = 0${columnasAdicional.has("fecha_eliminacion") ? " AND fecha_eliminacion IS NULL" : ""}`
  );
  let tarifasDadasDeBaja = null;
  if (columnasTarifa.has("eliminado")) {
    const [[fila]] = await connection.query("SELECT COUNT(*) AS filas FROM tarifa WHERE eliminado = 1");
    tarifasDadasDeBaja = Number(fila?.filas || 0);
  }
  return {
    tarifas_por_origen: Object.fromEntries(porOrigen.map((fila) => [String(fila.origen), Number(fila.filas || 0)])),
    temporadas_con_reservas: Number(conReservas?.temporadas || 0),
    adicionales_inactivos_legado: Number(adicionalesLegado?.filas || 0),
    tarifas_dadas_de_baja: tarifasDadasDeBaja,
  };
}

// Todo el trabajo sobre una conexión ya abierta (las pruebas pasan una conexión falsa).
// Primero valida todo y recién después ejecuta DDL: si algo no cuadra, no toca nada.
async function ejecutarMigracion(connection, { checkOnly = false, log = console.log } = {}) {
  const resultado = {
    columnasCreadas: [],
    columnasExistentes: [],
    indicesCreados: [],
    indicesExistentes: [],
    pendientes: [],
    conteos: null,
  };

  const planes = [];
  for (const definicion of TABLAS) {
    if (!(await existeTabla(connection, definicion.tabla))) throw new Error(`Falta la tabla ${definicion.tabla}`);
    const plan = planColumnas(definicion, await leerColumnas(connection, definicion.tabla));
    planes.push({ definicion, plan });
  }
  const indicesPorTabla = new Map();
  for (const definicion of TABLAS) {
    indicesPorTabla.set(definicion.tabla, await leerIndices(connection, definicion.tabla));
  }
  const indicesFaltantes = [];
  for (const indice of INDICES) {
    const equivalente = buscarIndiceEquivalente(indicesPorTabla.get(indice.tabla), indice);
    if (equivalente) {
      log(`  · ${indice.tabla}(${indice.columnas.join(", ")}) ya tiene índice: ${equivalente.nombre}`);
      resultado.indicesExistentes.push(`${indice.tabla}.${equivalente.nombre}`);
    } else {
      indicesFaltantes.push(indice);
    }
  }

  for (const { definicion, plan } of planes) {
    for (const nombre of plan.existentes) {
      log(`  · ${definicion.tabla}.${nombre} ya existe`);
      resultado.columnasExistentes.push(`${definicion.tabla}.${nombre}`);
    }
    if (!plan.ddl) continue;
    if (checkOnly) {
      log(`  [PENDIENTE] ${plan.ddl}`);
      resultado.pendientes.push(...plan.faltantes.map((nombre) => `${definicion.tabla}.${nombre}`));
      continue;
    }
    await connection.query(plan.ddl);
    const verificadas = await leerColumnas(connection, definicion.tabla);
    const sinCrear = plan.faltantes.filter((nombre) => !verificadas.has(nombre));
    if (sinCrear.length > 0) {
      throw new Error(`No se pudieron verificar las columnas ${sinCrear.join(", ")} en ${definicion.tabla}`);
    }
    log(`  ✔ ${definicion.tabla}: ${plan.faltantes.join(", ")} agregada(s)`);
    resultado.columnasCreadas.push(...plan.faltantes.map((nombre) => `${definicion.tabla}.${nombre}`));
  }

  for (const indice of indicesFaltantes) {
    if (checkOnly) {
      log(`  [PENDIENTE] ${ddlIndice(indice)}`);
      resultado.pendientes.push(`${indice.tabla}.${indice.nombre}`);
      continue;
    }
    await connection.query(ddlIndice(indice));
    if (!buscarIndiceEquivalente(await leerIndices(connection, indice.tabla), indice)) {
      throw new Error(`No se pudo verificar el índice ${indice.nombre} en ${indice.tabla}`);
    }
    log(`  ✔ ${indice.tabla}.${indice.nombre} (${indice.columnas.join(", ")}) creado`);
    resultado.indicesCreados.push(`${indice.tabla}.${indice.nombre}`);
  }

  resultado.conteos = await contarEstado(connection);
  const c = resultado.conteos;
  const origenes = Object.entries(c.tarifas_por_origen).map(([origen, filas]) => `${origen} ${filas}`).join(", ");
  log(`  · Tarifas por origen: ${origenes || "ninguna"}`);
  log(`  · Temporadas usadas en reservas (sus precios no se pueden reemplazar): ${c.temporadas_con_reservas}`);
  log(`  · Adicionales inactivos de antes de la migración (sin fecha ni motivo): ${c.adicionales_inactivos_legado}`);
  log(`  · Tarifas dadas de baja: ${c.tarifas_dadas_de_baja === null ? "- (falta la columna eliminado)" : c.tarifas_dadas_de_baja}`);
  return resultado;
}

// --- Registro en ajb_schema_migration (mismo esquema que las demás) --------
async function asegurarRegistroMigraciones(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ajb_schema_migration (
      migration_id VARCHAR(100) NOT NULL,
      checksum CHAR(64) NOT NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      estado ENUM('APLICANDO','APLICADA','FALLIDA') NOT NULL,
      etapa VARCHAR(100) DEFAULT NULL,
      detalle TEXT DEFAULT NULL,
      trigger_definer VARCHAR(255) NOT NULL DEFAULT '',
      trigger_sql_mode TEXT NOT NULL DEFAULT (''),
      iniciada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      finalizada_en DATETIME DEFAULT NULL,
      PRIMARY KEY (migration_id)
    ) ENGINE=InnoDB
  `);
  const [rows] = await connection.query(
    "SELECT checksum FROM ajb_schema_migration WHERE migration_id = ?",
    [MIGRATION_ID]
  );
  if (rows.length > 0 && rows[0].checksum !== MIGRATION_CHECKSUM) {
    throw new Error(`La migracion ${MIGRATION_ID} ya fue registrada con otro checksum`);
  }
  await connection.query(
    `INSERT INTO ajb_schema_migration
       (migration_id, checksum, revision, estado, etapa, detalle, trigger_definer, trigger_sql_mode)
     VALUES (?, ?, ?, 'APLICANDO', 'esquema', NULL, '', '')
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), estado = 'APLICANDO', etapa = 'esquema',
       detalle = NULL, finalizada_en = NULL`,
    [MIGRATION_ID, MIGRATION_CHECKSUM, MIGRATION_REVISION]
  );
}

async function marcarMigracion(connection, estado, detalle = null) {
  await connection.query(
    `UPDATE ajb_schema_migration
        SET estado = ?, etapa = ?, detalle = ?,
            finalizada_en = CASE WHEN ? = 'APLICADA' THEN NOW() ELSE NULL END
      WHERE migration_id = ?`,
    [estado, estado === "APLICADA" ? "completa" : "esquema", detalle, estado, MIGRATION_ID]
  );
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  conectar = null,
  log = console.log,
} = {}) {
  const opciones = parsearArgumentos(argv);
  validarDestino(opciones, env);
  log(`${opciones.checkOnly ? "Chequeando" : "Migrando"} ${env.DB_HOST}/${env.DB_DATABASE} como ${env.DB_USER}...`);
  const configuracion = {
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    port: Number(env.DB_PORT || 3306),
    timezone: "-03:00",
  };
  const connection = conectar
    ? await conectar(configuracion)
    : await require("mysql2/promise").createConnection({ ...configuracion, ssl: configuracionTls(env) });
  let lockTomado = false;
  let migracionRegistrada = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 10) AS adquirido", [MIGRATION_LOCK]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) throw new Error("No se pudo obtener el lock de migracion");

    if (!opciones.checkOnly) {
      await asegurarRegistroMigraciones(connection);
      migracionRegistrada = true;
    }
    log("Baja lógica de tarifas de temporada");
    const resultado = await ejecutarMigracion(connection, { checkOnly: opciones.checkOnly, log });
    if (migracionRegistrada) {
      await marcarMigracion(
        connection,
        "APLICADA",
        `columnas: ${resultado.columnasCreadas.join(", ") || "-"}; índices: ${resultado.indicesCreados.join(", ") || "-"}`
      );
    }
    log(opciones.checkOnly
      ? `Chequeo completado sin cambios (${resultado.pendientes.length} cambio(s) pendiente(s)).`
      : `Migracion ${MIGRATION_ID} aplicada.`);
    return resultado;
  } catch (error) {
    if (migracionRegistrada) {
      try {
        await marcarMigracion(connection, "FALLIDA", String(error.message || error).slice(0, 2000));
      } catch (_) {
        // Se conserva el error original.
      }
    }
    throw error;
  } finally {
    if (lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
      } catch (_) {
        // Cerrar la conexión también libera el advisory lock.
      }
    }
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error en la migracion de baja lógica de tarifas:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  INDICES,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_LOCK,
  TABLAS,
  buscarIndiceEquivalente,
  ejecutarMigracion,
  main,
  parsearArgumentos,
  planColumnas,
  validarDestino,
};
