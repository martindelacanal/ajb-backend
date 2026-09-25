// Migración de "Cambios de familiares": los datos que un afiliado modifica de
// sus familiares y acompañantes quedan en una solicitud PENDIENTE hasta que la
// departamental (o admin / admin-central) la aprueba o la rechaza.
//
// Crea de forma idempotente la tabla familiar_cambio_solicitud y otorga los
// GRANTs DML al usuario runtime (miajb_runtime, en todos sus hosts de
// mysql.user). Espejo de BD/MIGRACION_FAMILIARES_CAMBIOS.md.
//
// Uso:
//   node scripts/migrar-familiares-cambios.js                     → develop (DB_HOST localhost)
//   node scripts/migrar-familiares-cambios.js --allow-production  → obligatorio si DB_HOST no es localhost
//   node scripts/migrar-familiares-cambios.js --skip-grants       → sin intentar GRANTs
//
// El backend corre como miajb_runtime (sin CREATE): correr con la cuenta
// administrativa pasando las credenciales por entorno (dotenv no pisa lo definido):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb node scripts/migrar-familiares-cambios.js

require("dotenv").config();
const mysql = require("mysql2/promise");

const args = process.argv.slice(2);
const permiteProduccion = args.includes("--allow-production");
const omiteGrants = args.includes("--skip-grants");

const USUARIO_RUNTIME = "miajb_runtime";

const TABLAS_NUEVAS = ["familiar_cambio_solicitud"];

const DDL = [
  {
    descripcion: "Tabla familiar_cambio_solicitud (cambios de datos de familiares pedidos por el afiliado)",
    sql: `
CREATE TABLE IF NOT EXISTS familiar_cambio_solicitud (
  id INT NOT NULL AUTO_INCREMENT,
  persona_usuario_id INT NOT NULL COMMENT 'Familiar o acompañante cuyos datos se quieren cambiar',
  solicitante_usuario_id INT NOT NULL COMMENT 'Afiliado que pidió el cambio',
  departamental_id INT NOT NULL COMMENT 'Foto de la departamental del titular al pedir: define quién lo aprueba',
  estado ENUM('PENDIENTE','APROBADA','RECHAZADA','CANCELADA') NOT NULL DEFAULT 'PENDIENTE',
  datos_anteriores JSON NOT NULL COMMENT 'Valores de la ficha al pedir, sólo de los campos que cambian',
  datos_propuestos JSON NOT NULL COMMENT 'Sólo campos que cambian: nombre, apellido, documento, fecha_nacimiento, telefono, tipo_persona_id, parentesco_id',
  motivo_rechazo VARCHAR(1000) NULL,
  resuelto_usuario_id INT NULL COMMENT 'Quién aprobó / rechazó (o el afiliado, si la retiró)',
  fecha_resolucion DATETIME NULL,
  pendiente_persona INT GENERATED ALWAYS AS (CASE WHEN estado = 'PENDIENTE' THEN persona_usuario_id ELSE NULL END) STORED
    COMMENT 'Una sola solicitud PENDIENTE por persona (UNIQUE)',
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fcs_pendiente_persona (pendiente_persona),
  KEY idx_fcs_estado_dep (estado, departamental_id, fecha_creacion),
  KEY idx_fcs_solicitante (solicitante_usuario_id, estado),
  KEY idx_fcs_persona (persona_usuario_id, fecha_creacion),
  KEY fk_fcs_resuelto (resuelto_usuario_id),
  KEY fk_fcs_departamental (departamental_id),
  -- persona_usuario_id es la columna base de pendiente_persona (generada STORED):
  -- MySQL no admite CASCADE / SET NULL en esa FK, así que queda RESTRICT.
  CONSTRAINT fk_fcs_persona FOREIGN KEY (persona_usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fcs_solicitante FOREIGN KEY (solicitante_usuario_id) REFERENCES usuario (id) ON DELETE CASCADE,
  CONSTRAINT fk_fcs_resuelto FOREIGN KEY (resuelto_usuario_id) REFERENCES usuario (id) ON DELETE SET NULL,
  CONSTRAINT fk_fcs_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
];

// Columnas que la verificación exige (si la tabla ya existía con otra forma, se avisa).
const COLUMNAS_ESPERADAS = [
  "id",
  "persona_usuario_id",
  "solicitante_usuario_id",
  "departamental_id",
  "estado",
  "datos_anteriores",
  "datos_propuestos",
  "motivo_rechazo",
  "resuelto_usuario_id",
  "fecha_resolucion",
  "pendiente_persona",
  "fecha_creacion",
  "fecha_modificacion",
];

function assertEnvVar(value, name) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

async function tablasExistentes(connection) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${TABLAS_NUEVAS.map(() => "?").join(",")})`,
    TABLAS_NUEVAS
  );
  return new Set(rows.map((row) => row.nombre));
}

async function verificarColumnas(connection) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME AS nombre FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'familiar_cambio_solicitud'`
  );
  const actuales = new Set(rows.map((row) => row.nombre));
  const faltantes = COLUMNAS_ESPERADAS.filter((columna) => !actuales.has(columna));
  if (faltantes.length) {
    throw new Error(`familiar_cambio_solicitud existe pero le faltan columnas: ${faltantes.join(", ")}`);
  }
  const [indices] = await connection.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'familiar_cambio_solicitud'
        AND INDEX_NAME = 'uq_fcs_pendiente_persona' AND NON_UNIQUE = 0 LIMIT 1`
  );
  if (!indices.length) {
    throw new Error("familiar_cambio_solicitud no tiene el índice único uq_fcs_pendiente_persona (una sola pendiente por persona)");
  }
}

// --- GRANTs al runtime -------------------------------------------------------
const CODIGOS_SIN_PERMISO_GRANT = new Set([
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
  "ER_CANT_CREATE_USER_WITH_GRANT",
  "ER_NONEXISTING_GRANT",
  "ER_PASSWORD_NO_MATCH",
]);

async function cuentasRuntime(connection) {
  try {
    const [rows] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", [USUARIO_RUNTIME]);
    if (rows.length) return rows;
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
  }
  return [{ user: USUARIO_RUNTIME, host: "localhost" }];
}

function sqlGrants(connection, cuentas) {
  const esquema = connection.escapeId(process.env.DB_DATABASE);
  const sentencias = [];
  for (const cuenta of cuentas) {
    const destino = `'${cuenta.user}'@'${cuenta.host}'`;
    for (const tabla of TABLAS_NUEVAS) {
      sentencias.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${esquema}.${connection.escapeId(tabla)} TO ${destino}`);
    }
  }
  return sentencias;
}

async function otorgarGrantsRuntime(connection) {
  if (process.env.DB_USER === USUARIO_RUNTIME) {
    console.warn(`Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo. Corré los GRANTs de BD/MIGRACION_FAMILIARES_CAMBIOS.md con la cuenta administrativa.`);
    return;
  }
  const cuentas = await cuentasRuntime(connection);
  const etiqueta = cuentas.map((cuenta) => `'${cuenta.user}'@'${cuenta.host}'`).join(", ");
  const sentencias = sqlGrants(connection, cuentas);
  try {
    for (const sentencia of sentencias) await connection.query(sentencia);
    await connection.query("FLUSH PRIVILEGES");
    console.log(`  ✔ GRANT SELECT, INSERT, UPDATE, DELETE sobre ${TABLAS_NUEVAS.join(", ")} a ${etiqueta} + FLUSH PRIVILEGES`);
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    console.warn(
      `  · Aviso: no se pudieron otorgar los permisos a ${etiqueta} (${error.code}: ${error.message}).\n` +
        "    Corré con la cuenta administrativa:\n" +
        sentencias.map((sentencia) => `      ${sentencia};`).join("\n") +
        "\n      FLUSH PRIVILEGES;"
    );
  }
}

async function main() {
  assertEnvVar(process.env.DB_HOST, "DB_HOST");
  assertEnvVar(process.env.DB_USER, "DB_USER");
  assertEnvVar(process.env.DB_PASSWORD, "DB_PASSWORD");
  assertEnvVar(process.env.DB_DATABASE, "DB_DATABASE");

  const esProduccion = !["localhost", "127.0.0.1"].includes(process.env.DB_HOST);
  if (esProduccion && !permiteProduccion) {
    throw new Error(`DB_HOST=${process.env.DB_HOST} no es localhost. Para correr contra producción agregá --allow-production.`);
  }

  console.log(`Conectando a ${process.env.DB_HOST}/${process.env.DB_DATABASE} como ${process.env.DB_USER}...`);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    timezone: "-03:00",
  });

  try {
    const previas = await tablasExistentes(connection);
    for (const sentencia of DDL) {
      console.log(sentencia.descripcion);
      await connection.query(sentencia.sql);
    }
    const actuales = await tablasExistentes(connection);
    const faltantes = TABLAS_NUEVAS.filter((tabla) => !actuales.has(tabla));
    if (faltantes.length) throw new Error(`No se pudieron verificar las tablas: ${faltantes.join(", ")}`);
    await verificarColumnas(connection);
    for (const tabla of TABLAS_NUEVAS) {
      console.log(`  ✔ ${tabla}${previas.has(tabla) ? " (ya existía)" : " (creada)"}`);
    }

    if (omiteGrants) {
      console.log("Se omite el intento de GRANTs (--skip-grants).");
      return;
    }
    console.log(`Otorgando DML sobre las tablas nuevas a '${USUARIO_RUNTIME}'...`);
    await otorgarGrantsRuntime(connection);
  } finally {
    await connection.end();
  }
}

main()
  .then(() => {
    console.log("Migración de cambios de familiares finalizada.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error en la migración de cambios de familiares:", error.message);
    process.exit(1);
  });
