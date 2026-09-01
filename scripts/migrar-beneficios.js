// Migración del módulo Beneficios (convenios con empresas para afiliados).
//
// Crea de forma idempotente las 11 tablas del módulo (catálogos de estado, rubros,
// beneficio, segmentación por departamentales, sucursales, galería, imágenes del editor,
// chat de aprobación, historial e inscripciones) y siembra los catálogos fijos.
// Espejo de BD/MIGRACION_BENEFICIOS.md: el SQL de acá y el del doc son el mismo.
//
// Uso:
//   node scripts/migrar-beneficios.js                     → esquema + seeds + GRANTs a miajb_runtime (develop)
//   node scripts/migrar-beneficios.js --skip-grants       → esquema + seeds, sin intentar los GRANTs
//   node scripts/migrar-beneficios.js --allow-production  → obligatorio si DB_HOST no es localhost (no hace GRANTs)
//
// En develop el backend corre como miajb_runtime, que no tiene CREATE: correr con la cuenta
// administrativa local pasando las credenciales por entorno (dotenv no pisa lo ya definido):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb npm run migrate:beneficios

require("dotenv").config();
const mysql = require("mysql2/promise");

function assertEnvVar(value, name) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

const args = process.argv.slice(2);
const permiteProduccion = args.includes("--allow-production");
const omiteGrants = args.includes("--skip-grants");

// Usuario endurecido de develop (ver scripts/configurar-usuario-runtime.js).
const USUARIO_RUNTIME = "miajb_runtime";
const HOST_RUNTIME = "localhost";

// Orden de creación: respeta las FKs (catálogos → beneficio → dependientes).
const TABLAS = [
  "beneficio_estado",
  "beneficio_inscripcion_estado",
  "beneficio_rubro",
  "beneficio",
  "beneficio_departamental",
  "beneficio_sucursal",
  "beneficio_imagen",
  "beneficio_editor_imagen",
  "beneficio_observacion",
  "beneficio_historial",
  "beneficio_inscripcion",
];

const DDL_BENEFICIO_ESTADO = `
CREATE TABLE IF NOT EXISTS beneficio_estado (
  id INT NOT NULL,
  nombre VARCHAR(60) NOT NULL,
  color VARCHAR(9) NOT NULL,
  color_texto VARCHAR(9) NOT NULL,
  orden INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const SEED_BENEFICIO_ESTADO = `
INSERT INTO beneficio_estado (id, nombre, color, color_texto, orden) VALUES
  (1, 'Pendiente de aprobación', '#FFF6E0', '#8A5B00', 1),
  (2, 'Observado',               '#EDE9FE', '#5B21B6', 2),
  (3, 'Aprobado',                '#D1FAE5', '#047857', 3),
  (4, 'Rechazado',               '#FFE4E6', '#BE123C', 4)
ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), color = VALUES(color), color_texto = VALUES(color_texto), orden = VALUES(orden);
`;

const DDL_BENEFICIO_INSCRIPCION_ESTADO = `
CREATE TABLE IF NOT EXISTS beneficio_inscripcion_estado (
  id INT NOT NULL,
  nombre VARCHAR(60) NOT NULL,
  color VARCHAR(9) NOT NULL,
  color_texto VARCHAR(9) NOT NULL,
  orden INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const SEED_BENEFICIO_INSCRIPCION_ESTADO = `
INSERT INTO beneficio_inscripcion_estado (id, nombre, color, color_texto, orden) VALUES
  (1, 'Inscripto', '#D1FAE5', '#047857', 1),
  (2, 'Cancelada', '#FFE4E6', '#BE123C', 2)
ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), color = VALUES(color), color_texto = VALUES(color_texto), orden = VALUES(orden);
`;

const DDL_BENEFICIO_RUBRO = `
CREATE TABLE IF NOT EXISTS beneficio_rubro (
  id INT NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(80) NOT NULL,
  habilitado TINYINT(1) NOT NULL DEFAULT 1,
  creado_por_usuario_id INT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ben_rubro_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// El front siempre ordena alfabéticamente; acá el orden es solo documental.
const SEED_BENEFICIO_RUBRO = `
INSERT INTO beneficio_rubro (nombre) VALUES
  ('Bebés y Niños'),
  ('Belleza y Bienestar'),
  ('Capacitación'),
  ('Deportes'),
  ('Electrodomésticos'),
  ('Entretenimiento'),
  ('Juguetería'),
  ('Ópticas'),
  ('Seguros'),
  ('Servicios'),
  ('Supermercado'),
  ('Transportes'),
  ('Turismo')
ON DUPLICATE KEY UPDATE nombre = VALUES(nombre);
`;

const DDL_BENEFICIO = `
CREATE TABLE IF NOT EXISTS beneficio (
  id INT NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(160) NOT NULL,
  razon_social VARCHAR(160) NULL COMMENT 'Interno, nunca visible al afiliado',
  rubro_id INT NOT NULL,
  descripcion_corta VARCHAR(300) NULL COMMENT 'Bajada breve para la tarjeta',
  promocion_html MEDIUMTEXT NULL COMMENT 'HTML saneado del texto enriquecido de la promoción',
  telefono VARCHAR(30) NULL,
  telefono_visible TINYINT(1) NOT NULL DEFAULT 0,
  sitio_web VARCHAR(300) NULL,
  sitio_web_visible TINYINT(1) NOT NULL DEFAULT 1,
  email_contacto VARCHAR(120) NULL,
  email_contacto_visible TINYINT(1) NOT NULL DEFAULT 0,
  dni_titulares VARCHAR(200) NULL COMMENT 'Interno. DNI del titular o titulares, texto libre normalizado',
  cupo_maximo INT NULL COMMENT 'NULL = sin cupo',
  mostrar_mapa TINYINT(1) NOT NULL DEFAULT 0,
  fecha_vigencia_desde DATE NULL,
  fecha_vigencia_hasta DATE NULL,
  habilitado TINYINT(1) NOT NULL DEFAULT 1,
  tarjeta_usa_logo TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = la tarjeta muestra el logo; 0 = galería de la promoción',
  logo_archivo VARCHAR(260) NULL COMMENT 'Key S3',
  convenio_archivo VARCHAR(260) NULL COMMENT 'Key S3 del convenio firmado (PDF/DOCX). Interno',
  convenio_nombre_original VARCHAR(260) NULL,
  convenio_mime VARCHAR(100) NULL,
  email_aviso_inscripcion VARCHAR(120) NULL COMMENT 'Si está: correo a la entidad con los datos del afiliado al inscribirse',
  mensaje_inscripcion_html MEDIUMTEXT NULL COMMENT 'HTML saneado del mensaje automático al afiliado (email + notificación)',
  alcance_todas TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = todas las departamentales; 0 = las de beneficio_departamental',
  departamental_id INT NULL COMMENT 'Departamental dueña (NULL si lo creó admin/admin-central)',
  creado_por_usuario_id INT NOT NULL,
  estado_id INT NOT NULL DEFAULT 1,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ben_estado (estado_id, eliminado),
  KEY idx_ben_rubro (rubro_id),
  KEY idx_ben_departamental (departamental_id),
  KEY idx_ben_publicable (eliminado, estado_id, habilitado, fecha_vigencia_desde, fecha_vigencia_hasta),
  CONSTRAINT fk_ben_estado FOREIGN KEY (estado_id) REFERENCES beneficio_estado (id),
  CONSTRAINT fk_ben_rubro FOREIGN KEY (rubro_id) REFERENCES beneficio_rubro (id),
  CONSTRAINT fk_ben_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id),
  CONSTRAINT fk_ben_creador FOREIGN KEY (creado_por_usuario_id) REFERENCES usuario (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// Segmentación N a N. Si alcance_todas = 1 se ignora la tabla; si es 0, el beneficio
// es visible para las departamentales listadas. Al crear por rol departamental el
// backend agrega SIEMPRE la propia departamental si falta.
const DDL_BENEFICIO_DEPARTAMENTAL = `
CREATE TABLE IF NOT EXISTS beneficio_departamental (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NOT NULL,
  departamental_id INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ben_dep (beneficio_id, departamental_id),
  KEY idx_ben_dep_departamental (departamental_id),
  CONSTRAINT fk_ben_dep_beneficio FOREIGN KEY (beneficio_id)
    REFERENCES beneficio (id) ON DELETE CASCADE,
  CONSTRAINT fk_ben_dep_departamental FOREIGN KEY (departamental_id)
    REFERENCES departamental (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const DDL_BENEFICIO_SUCURSAL = `
CREATE TABLE IF NOT EXISTS beneficio_sucursal (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NOT NULL,
  direccion VARCHAR(200) NOT NULL,
  latitud DECIMAL(10,8) NULL,
  longitud DECIMAL(11,8) NULL,
  etiqueta VARCHAR(160) NULL COMMENT 'Texto propio del pin (opcional)',
  imagen_archivo VARCHAR(260) NULL COMMENT 'Key S3: mini imagen/logo mostrada EN el pin (opcional)',
  orden INT NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ben_suc_beneficio (beneficio_id, orden),
  CONSTRAINT fk_ben_suc_beneficio FOREIGN KEY (beneficio_id) REFERENCES beneficio (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const DDL_BENEFICIO_IMAGEN = `
CREATE TABLE IF NOT EXISTS beneficio_imagen (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NOT NULL,
  archivo VARCHAR(260) NOT NULL COMMENT 'Key S3',
  orden INT NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ben_img (beneficio_id, orden),
  CONSTRAINT fk_ben_img_beneficio FOREIGN KEY (beneficio_id)
    REFERENCES beneficio (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// Imágenes embebidas en el texto enriquecido. beneficio_id queda NULL hasta que se guarda
// el beneficio; el backend lo refresca al guardar leyendo los data-archivo presentes en
// los HTML (no borra agresivamente). Sin FK a propósito: la fila sobrevive al beneficio
// para poder limpiar huérfanas en S3 a futuro.
const DDL_BENEFICIO_EDITOR_IMAGEN = `
CREATE TABLE IF NOT EXISTS beneficio_editor_imagen (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NULL COMMENT 'NULL hasta que se guarde el beneficio',
  usuario_id INT NOT NULL,
  archivo VARCHAR(260) NOT NULL COMMENT 'Key S3',
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ben_edimg_beneficio (beneficio_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const DDL_BENEFICIO_OBSERVACION = `
CREATE TABLE IF NOT EXISTS beneficio_observacion (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NOT NULL,
  usuario_id INT NOT NULL,
  usuario_rol VARCHAR(30) NOT NULL,
  mensaje TEXT NOT NULL,
  estado_id INT NULL COMMENT 'Estado del beneficio al momento del mensaje',
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ben_obs_beneficio (beneficio_id),
  CONSTRAINT fk_ben_obs_beneficio FOREIGN KEY (beneficio_id)
    REFERENCES beneficio (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const DDL_BENEFICIO_HISTORIAL = `
CREATE TABLE IF NOT EXISTS beneficio_historial (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NOT NULL,
  inscripcion_id INT NULL COMMENT 'Si el evento pertenece a una inscripción',
  usuario_id INT NULL,
  usuario_rol VARCHAR(30) NULL,
  tipo_operacion ENUM('CREATE','UPDATE','CAMBIO_ESTADO','OBSERVACION','ARCHIVO','DELETE','INSCRIPCION','AVISO') NOT NULL,
  estado_anterior_id INT NULL,
  estado_nuevo_id INT NULL,
  campo_modificado VARCHAR(100) NULL,
  valor_anterior TEXT NULL,
  valor_nuevo TEXT NULL,
  observacion TEXT NULL,
  fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ben_hist_beneficio (beneficio_id),
  KEY idx_ben_hist_fecha (fecha),
  CONSTRAINT fk_ben_hist_beneficio FOREIGN KEY (beneficio_id) REFERENCES beneficio (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// Invariante "una sola inscripción activa por afiliado y beneficio" respaldado a nivel
// motor: la columna generada vale 1 solo cuando la inscripción está activa (NULL no viola
// la unicidad), así el doble submit concurrente falla con ER_DUP_ENTRY, que el endpoint
// traduce a 409. Cancelar (estado 2) libera el cupo y permite reinscribirse.
const DDL_BENEFICIO_INSCRIPCION = `
CREATE TABLE IF NOT EXISTS beneficio_inscripcion (
  id INT NOT NULL AUTO_INCREMENT,
  beneficio_id INT NOT NULL,
  usuario_id INT NOT NULL,
  estado_id INT NOT NULL DEFAULT 1,
  mensaje_afiliado TEXT NULL COMMENT 'Mensaje opcional del afiliado a la empresa',
  correo_afiliado_enviado TINYINT(1) NOT NULL DEFAULT 0,
  correo_afiliado_motivo VARCHAR(120) NULL,
  aviso_entidad_estado ENUM('NO_APLICA','ENVIADO','ERROR','RESUELTO') NOT NULL DEFAULT 'NO_APLICA',
  aviso_entidad_error VARCHAR(300) NULL,
  aviso_entidad_fecha DATETIME NULL,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  activa TINYINT GENERATED ALWAYS AS (CASE WHEN eliminado = 0 AND estado_id = 1 THEN 1 ELSE NULL END) STORED,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ben_insc_activa (usuario_id, beneficio_id, activa),
  KEY idx_ben_insc_beneficio (beneficio_id, estado_id),
  KEY idx_ben_insc_usuario (usuario_id),
  KEY idx_ben_insc_aviso (aviso_entidad_estado),
  CONSTRAINT fk_ben_insc_beneficio FOREIGN KEY (beneficio_id) REFERENCES beneficio (id),
  CONSTRAINT fk_ben_insc_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id),
  CONSTRAINT fk_ben_insc_estado FOREIGN KEY (estado_id) REFERENCES beneficio_inscripcion_estado (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// Sentencias en el orden exacto del doc (las FKs exigen crear antes las referenciadas).
const SENTENCIAS = [
  { descripcion: "Creando tabla beneficio_estado (si no existe)...", sql: DDL_BENEFICIO_ESTADO },
  { descripcion: "Sembrando beneficio_estado (4 estados)...", sql: SEED_BENEFICIO_ESTADO },
  { descripcion: "Creando tabla beneficio_inscripcion_estado (si no existe)...", sql: DDL_BENEFICIO_INSCRIPCION_ESTADO },
  { descripcion: "Sembrando beneficio_inscripcion_estado (2 estados)...", sql: SEED_BENEFICIO_INSCRIPCION_ESTADO },
  { descripcion: "Creando tabla beneficio_rubro (si no existe)...", sql: DDL_BENEFICIO_RUBRO },
  { descripcion: "Sembrando beneficio_rubro (13 rubros)...", sql: SEED_BENEFICIO_RUBRO },
  { descripcion: "Creando tabla beneficio (si no existe)...", sql: DDL_BENEFICIO },
  { descripcion: "Creando tabla beneficio_departamental (si no existe)...", sql: DDL_BENEFICIO_DEPARTAMENTAL },
  { descripcion: "Creando tabla beneficio_sucursal (si no existe)...", sql: DDL_BENEFICIO_SUCURSAL },
  { descripcion: "Creando tabla beneficio_imagen (si no existe)...", sql: DDL_BENEFICIO_IMAGEN },
  { descripcion: "Creando tabla beneficio_editor_imagen (si no existe)...", sql: DDL_BENEFICIO_EDITOR_IMAGEN },
  { descripcion: "Creando tabla beneficio_observacion (si no existe)...", sql: DDL_BENEFICIO_OBSERVACION },
  { descripcion: "Creando tabla beneficio_historial (si no existe)...", sql: DDL_BENEFICIO_HISTORIAL },
  { descripcion: "Creando tabla beneficio_inscripcion (si no existe)...", sql: DDL_BENEFICIO_INSCRIPCION },
];

async function tablasExistentes(connection) {
  const [filas] = await connection.query(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'beneficio%'`
  );
  return new Set(filas.map((fila) => fila.TABLE_NAME));
}

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

function sqlGrants(connection) {
  const esquema = connection.escapeId(process.env.DB_DATABASE);
  const cuenta = `${connection.escape(USUARIO_RUNTIME)}@${connection.escape(HOST_RUNTIME)}`;
  return TABLAS.map(
    (tabla) => `GRANT SELECT, INSERT, UPDATE, DELETE ON ${esquema}.${connection.escapeId(tabla)} TO ${cuenta}`
  );
}

async function otorgarGrantsRuntime(connection) {
  if (process.env.DB_USER === USUARIO_RUNTIME) {
    console.warn(
      `Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo. ` +
        "Corré los GRANTs de BD/MIGRACION_BENEFICIOS.md con la cuenta administrativa local."
    );
    return;
  }
  const sentencias = sqlGrants(connection);
  try {
    for (const sentencia of sentencias) {
      await connection.query(sentencia);
    }
    await connection.query("FLUSH PRIVILEGES");
    console.log(`  ✔ GRANT SELECT, INSERT, UPDATE, DELETE sobre ${TABLAS.length} tablas a '${USUARIO_RUNTIME}'@'${HOST_RUNTIME}' + FLUSH PRIVILEGES`);
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    console.warn(
      `  · Aviso: no se pudieron otorgar los permisos a '${USUARIO_RUNTIME}'@'${HOST_RUNTIME}' ` +
        `(${error.code}: ${error.message}).\n` +
        "    El esquema quedó creado igual. Corré con la cuenta administrativa local:\n" +
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
    throw new Error(
      `DB_HOST=${process.env.DB_HOST} no es localhost. Para correr contra producción agregá --allow-production.`
    );
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

    for (const sentencia of SENTENCIAS) {
      console.log(sentencia.descripcion);
      await connection.query(sentencia.sql);
    }

    const actuales = await tablasExistentes(connection);
    const faltantes = TABLAS.filter((tabla) => !actuales.has(tabla));
    if (faltantes.length > 0) {
      throw new Error(`No se pudieron verificar las tablas: ${faltantes.join(", ")}`);
    }
    for (const tabla of TABLAS) {
      console.log(`  ✔ ${tabla}${previas.has(tabla) ? " (ya existía)" : " (creada)"}`);
    }
    console.log("Esquema listo.");

    if (esProduccion) {
      console.log("Producción: el backend usa la cuenta admin del RDS, no se otorgan GRANTs.");
      return;
    }
    if (omiteGrants) {
      console.log("Se omite el intento de GRANTs (--skip-grants).");
      return;
    }
    console.log(`Otorgando DML sobre las tablas nuevas a '${USUARIO_RUNTIME}'@'${HOST_RUNTIME}'...`);
    await otorgarGrantsRuntime(connection);
  } finally {
    await connection.end();
  }
}

main()
  .then(() => {
    console.log("Migración de beneficios finalizada.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error en la migración de beneficios:", error.message);
    process.exit(1);
  });
