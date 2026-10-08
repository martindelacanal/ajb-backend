// Migración "Portada de gestión" (2026-10-07).
//
// 1. Crea la tabla turismo_placa: placas/flyers de ofertas de turismo (convenios con
//    agencias, promos de temporada) que el admin carga desde /turismo/placas y que se
//    muestran en el carrusel de /turismo y en la página pública de turismo.
// 2. Agrega coseguro_tipo_reintegro.es_subsidio (TINYINT 0/1). Sólo al CREAR la columna
//    marca con 1 los tipos cuyo nombre contiene "nacimiento" (Obsequio por nacimiento):
//    si se vuelve a correr, no pisa lo que Servicios Sociales haya configurado después.
// 3. Otorga SELECT, INSERT, UPDATE, DELETE sobre turismo_placa al usuario runtime
//    (miajb_runtime) en todos los hosts que figuren en mysql.user ('localhost' y
//    '127.0.0.1' en develop, la IP privada del EC2 en la RDS). La columna nueva no
//    necesita GRANT: el runtime ya tiene DML a nivel tabla sobre coseguro_tipo_reintegro.
//
// Es idempotente: se puede correr las veces que haga falta.
//
// Uso:
//   node scripts/migrar-portada-gestion.js                     → esquema + GRANTs (develop)
//   node scripts/migrar-portada-gestion.js --skip-grants       → esquema, sin intentar los GRANTs
//   node scripts/migrar-portada-gestion.js --allow-production  → obligatorio si DB_HOST no es localhost
//
// Develop (dotenv no pisa variables ya definidas; el bloque activo del .env apunta a la RDS):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb npm run migrate:portada-gestion
// Producción (con la cuenta administrativa de la RDS, que es la del bloque activo del .env):
//   npm run migrate:portada-gestion -- --allow-production
//
// Orden de deploy: correr esta migración ANTES de desplegar el backend nuevo (los GET de
// /coseguro/cobertura y de /publico/* leen es_subsidio y turismo_placa).

require("dotenv").config();
const mysql = require("mysql2/promise");

const USUARIO_RUNTIME = "miajb_runtime";
const HOST_RUNTIME = "localhost";

const TABLAS_CON_GRANT = ["turismo_placa"];

const DDL_TURISMO_PLACA = `
CREATE TABLE IF NOT EXISTS turismo_placa (
  id INT NOT NULL AUTO_INCREMENT,
  titulo VARCHAR(140) NOT NULL,
  descripcion VARCHAR(300) NULL COMMENT 'Texto alternativo: lo que dice la placa',
  imagen_archivo VARCHAR(260) NOT NULL COMMENT 'Key S3 (turismo/placas/<uuid>.webp)',
  imagen_ancho INT NULL,
  imagen_alto INT NULL,
  enlace_url VARCHAR(500) NULL COMMENT 'https://… o ruta interna que empieza con /',
  enlace_texto VARCHAR(60) NULL,
  vigencia_desde DATE NULL,
  vigencia_hasta DATE NULL,
  publicado TINYINT(1) NOT NULL DEFAULT 1,
  orden INT NOT NULL DEFAULT 0,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  creado_por_usuario_id INT NULL,
  modificado_por_usuario_id INT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_turismo_placa_listado (eliminado, publicado, orden)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const DDL_ES_SUBSIDIO = `
ALTER TABLE coseguro_tipo_reintegro
  ADD COLUMN es_subsidio TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1 = subsidio/obsequio (p. ej. nacimiento): se publica aparte en la portada'
  AFTER tope_reintegro
`;

const SQL_MARCAR_SUBSIDIOS_INICIALES = `
UPDATE coseguro_tipo_reintegro SET es_subsidio = 1 WHERE LOWER(nombre) LIKE '%nacimiento%'
`;

// Códigos con los que MySQL responde cuando la cuenta conectada no puede otorgar
// permisos o el usuario runtime no existe: no son un error de la migración en sí.
const CODIGOS_SIN_PERMISO_GRANT = new Set([
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
  "ER_CANT_CREATE_USER_WITH_GRANT",
  "ER_NONEXISTING_GRANT",
  "ER_PASSWORD_NO_MATCH",
]);

function assertEnvVar(value, name) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

async function existeTabla(connection, tabla) {
  const [filas] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tabla]
  );
  return filas.length > 0;
}

async function existeColumna(connection, tabla, columna) {
  const [filas] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tabla, columna]
  );
  return filas.length > 0;
}

// El runtime existe en las dos bases con hosts distintos: se buscan en mysql.user
// para no adivinarlos.
async function cuentasRuntime(connection) {
  try {
    const [filas] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", [USUARIO_RUNTIME]);
    if (filas.length > 0) return filas.map((fila) => ({ user: fila.user, host: fila.host }));
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
  }
  return [{ user: USUARIO_RUNTIME, host: HOST_RUNTIME }];
}

function sqlGrants(connection, cuentas, database) {
  const esquema = connection.escapeId(database);
  const sentencias = [];
  for (const cuenta of cuentas) {
    const destino = `${connection.escape(cuenta.user)}@${connection.escape(cuenta.host)}`;
    for (const tabla of TABLAS_CON_GRANT) {
      sentencias.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${esquema}.${connection.escapeId(tabla)} TO ${destino}`);
    }
  }
  return sentencias;
}

async function otorgarGrantsRuntime(connection, env) {
  if (env.DB_USER === USUARIO_RUNTIME) {
    console.warn(
      `  · Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo. ` +
        "Corré la migración con la cuenta administrativa (root local / admin de la RDS)."
    );
    return;
  }
  const cuentas = await cuentasRuntime(connection);
  const etiqueta = cuentas.map((cuenta) => `'${cuenta.user}'@'${cuenta.host}'`).join(", ");
  const sentencias = sqlGrants(connection, cuentas, env.DB_DATABASE);
  try {
    for (const sentencia of sentencias) {
      await connection.query(sentencia);
    }
    await connection.query("FLUSH PRIVILEGES");
    console.log(`  ✔ GRANT SELECT, INSERT, UPDATE, DELETE sobre ${TABLAS_CON_GRANT.join(", ")} a ${etiqueta} + FLUSH PRIVILEGES`);
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    console.warn(
      `  · Aviso: no se pudieron otorgar los permisos a ${etiqueta} (${error.code}: ${error.message}).\n` +
        "    El esquema quedó creado igual. Corré con la cuenta administrativa:\n" +
        sentencias.map((sentencia) => `      ${sentencia};`).join("\n") +
        "\n      FLUSH PRIVILEGES;"
    );
  }
}

async function main({ argv = process.argv, env = process.env } = {}) {
  const args = argv.slice(2);
  const permiteProduccion = args.includes("--allow-production");
  const omiteGrants = args.includes("--skip-grants");

  assertEnvVar(env.DB_HOST, "DB_HOST");
  assertEnvVar(env.DB_USER, "DB_USER");
  assertEnvVar(env.DB_PASSWORD, "DB_PASSWORD");
  assertEnvVar(env.DB_DATABASE, "DB_DATABASE");

  const esProduccion = !["localhost", "127.0.0.1"].includes(env.DB_HOST);
  if (esProduccion && !permiteProduccion) {
    throw new Error(`DB_HOST=${env.DB_HOST} no es localhost. Para correr contra producción agregá --allow-production.`);
  }

  console.log(`Conectando a ${env.DB_HOST}/${env.DB_DATABASE} como ${env.DB_USER}...`);
  const connection = await mysql.createConnection({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    port: env.DB_PORT || 3306,
    timezone: "-03:00",
  });

  try {
    // 1. turismo_placa
    const habiaTabla = await existeTabla(connection, "turismo_placa");
    console.log("Creando tabla turismo_placa (si no existe)...");
    await connection.query(DDL_TURISMO_PLACA);
    if (!(await existeTabla(connection, "turismo_placa"))) {
      throw new Error("No se pudo verificar la tabla turismo_placa");
    }
    console.log(`  ✔ turismo_placa${habiaTabla ? " (ya existía)" : " (creada)"}`);

    // 2. coseguro_tipo_reintegro.es_subsidio
    console.log("Agregando coseguro_tipo_reintegro.es_subsidio (si no existe)...");
    if (await existeColumna(connection, "coseguro_tipo_reintegro", "es_subsidio")) {
      console.log("  ✔ es_subsidio (ya existía: no se tocan las marcas actuales)");
    } else {
      await connection.query(DDL_ES_SUBSIDIO);
      const [resultado] = await connection.query(SQL_MARCAR_SUBSIDIOS_INICIALES);
      console.log(`  ✔ es_subsidio (creada; ${resultado.affectedRows} tipo(s) con "nacimiento" marcados como subsidio)`);
    }
    const [marcados] = await connection.query(
      "SELECT id, nombre FROM coseguro_tipo_reintegro WHERE es_subsidio = 1 ORDER BY orden, id"
    );
    console.log(`  · Tipos marcados como subsidio: ${marcados.map((t) => `${t.id} ${t.nombre}`).join(", ") || "(ninguno)"}`);
    console.log("Esquema listo.");

    // 3. GRANTs al runtime. En producción el backend TAMBIÉN corre como miajb_runtime
    // (desde la IP privada del EC2): sin estos permisos los endpoints nuevos dan 500.
    if (omiteGrants) {
      console.log("Se omite el intento de GRANTs (--skip-grants).");
      return;
    }
    console.log(`Otorgando DML sobre las tablas nuevas a '${USUARIO_RUNTIME}'...`);
    await otorgarGrantsRuntime(connection, env);
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("Migración de la portada de gestión finalizada.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Error en la migración de la portada de gestión:", error.message);
      process.exit(1);
    });
}

module.exports = {
  DDL_ES_SUBSIDIO,
  DDL_TURISMO_PLACA,
  SQL_MARCAR_SUBSIDIOS_INICIALES,
  TABLAS_CON_GRANT,
  main,
  sqlGrants,
};
