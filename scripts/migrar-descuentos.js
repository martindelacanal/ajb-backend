// Migración del módulo Descuentos de turismo (cupones, tipos de viaje y
// descuento médico por servicio).
//
// Crea de forma idempotente las tablas descuento_regla (+ departamental,
// servicio, tipo_persona), reserva_descuento, reserva_descuento_archivo y
// descuento_historial; agrega reserva.monto_descuentos y las columnas
// servicio.descuento_salud_*; siembra los tipos de viaje pedidos; habilita el
// descuento médico SOLO en "Hotel Solís"; y otorga los GRANTs DML al usuario
// runtime. Espejo de BD/MIGRACION_DESCUENTOS.md.
//
// Uso:
//   node scripts/migrar-descuentos.js                     → develop (DB_HOST localhost)
//   node scripts/migrar-descuentos.js --allow-production  → obligatorio si DB_HOST no es localhost
//   node scripts/migrar-descuentos.js --skip-grants       → sin intentar GRANTs
//   node scripts/migrar-descuentos.js --seed-cupones      → además siembra cupones de ejemplo (solo pensado para develop)
//
// En develop el backend corre como miajb_runtime (sin CREATE): correr con la cuenta
// administrativa pasando las credenciales por entorno (dotenv no pisa lo definido):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb node scripts/migrar-descuentos.js

require("dotenv").config();
const mysql = require("mysql2/promise");

const args = process.argv.slice(2);
const permiteProduccion = args.includes("--allow-production");
const omiteGrants = args.includes("--skip-grants");
const siembraCupones = args.includes("--seed-cupones");

const USUARIO_RUNTIME = "miajb_runtime";

const TABLAS_NUEVAS = [
  "descuento_regla",
  "descuento_regla_departamental",
  "descuento_regla_servicio",
  "descuento_regla_tipo_persona",
  "reserva_descuento",
  "reserva_descuento_archivo",
  "descuento_historial",
];

const DDL = [
  {
    descripcion: "Tabla descuento_regla (cupones y tipos de viaje)",
    sql: `
CREATE TABLE IF NOT EXISTS descuento_regla (
  id INT NOT NULL AUTO_INCREMENT,
  tipo ENUM('CUPON','TIPO_VIAJE') NOT NULL,
  codigo VARCHAR(60) NOT NULL COMMENT 'Cupón: hashtag sin # en mayúsculas. Tipo de viaje: código interno',
  nombre VARCHAR(120) NOT NULL,
  descripcion VARCHAR(500) NULL COMMENT 'Explicación visible para el afiliado',
  porcentaje_descuento DECIMAL(5,2) NOT NULL,
  base_calculo ENUM('PRECIO_FINAL','PRECIO_LISTA') NOT NULL DEFAULT 'PRECIO_FINAL',
  incluye_adicionales TINYINT(1) NOT NULL DEFAULT 0,
  acumulable TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = se suma al otro descuento de la reserva',
  requiere_comprobante TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = el formulario ofrece cargar comprobante (opcional)',
  oculto TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Cupón administrativo: no se publica, solo funciona si se escribe',
  alcance_departamental ENUM('TODAS','SELECCIONADAS') NOT NULL DEFAULT 'TODAS',
  alcance_servicio ENUM('TODOS','SELECCIONADOS') NOT NULL DEFAULT 'TODOS',
  alcance_persona ENUM('TODAS','SELECCIONADAS') NOT NULL DEFAULT 'TODAS',
  edad_minima INT NULL,
  edad_maxima INT NULL,
  vigencia_desde DATE NULL,
  vigencia_hasta DATE NULL,
  usos_maximos INT NULL COMMENT 'NULL = sin límite',
  usos_por_afiliado INT NULL COMMENT 'NULL = sin límite',
  habilitado TINYINT(1) NOT NULL DEFAULT 1,
  orden INT NOT NULL DEFAULT 0,
  creado_por_usuario_id INT NULL,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  codigo_activo VARCHAR(60) GENERATED ALWAYS AS (CASE WHEN eliminado = 0 THEN codigo ELSE NULL END) STORED,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_descuento_regla_codigo (tipo, codigo_activo),
  KEY idx_descuento_regla_listado (tipo, eliminado, habilitado, orden),
  KEY fk_descuento_regla_creador (creado_por_usuario_id),
  CONSTRAINT fk_descuento_regla_creador FOREIGN KEY (creado_por_usuario_id) REFERENCES usuario (id) ON DELETE SET NULL,
  CONSTRAINT chk_descuento_regla_pct CHECK (porcentaje_descuento >= 0 AND porcentaje_descuento <= 100),
  CONSTRAINT chk_descuento_regla_edad CHECK (
    (edad_minima IS NULL OR edad_minima BETWEEN 0 AND 130)
    AND (edad_maxima IS NULL OR edad_maxima BETWEEN 0 AND 130)
    AND (edad_minima IS NULL OR edad_maxima IS NULL OR edad_minima <= edad_maxima)),
  CONSTRAINT chk_descuento_regla_vigencia CHECK (vigencia_desde IS NULL OR vigencia_hasta IS NULL OR vigencia_desde <= vigencia_hasta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
  {
    descripcion: "Tabla descuento_regla_departamental (alcance y % por departamental)",
    sql: `
CREATE TABLE IF NOT EXISTS descuento_regla_departamental (
  id INT NOT NULL AUTO_INCREMENT,
  regla_id INT NOT NULL,
  departamental_id INT NOT NULL,
  habilitado TINYINT(1) NOT NULL DEFAULT 1,
  porcentaje_descuento DECIMAL(5,2) NULL COMMENT 'NULL = usa el porcentaje general de la regla',
  PRIMARY KEY (id),
  UNIQUE KEY uq_descuento_regla_departamental (regla_id, departamental_id),
  KEY fk_drd_departamental (departamental_id),
  CONSTRAINT fk_drd_regla FOREIGN KEY (regla_id) REFERENCES descuento_regla (id) ON DELETE CASCADE,
  CONSTRAINT fk_drd_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id) ON DELETE CASCADE,
  CONSTRAINT chk_drd_pct CHECK (porcentaje_descuento IS NULL OR (porcentaje_descuento >= 0 AND porcentaje_descuento <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
  {
    descripcion: "Tabla descuento_regla_servicio (alcance por servicio)",
    sql: `
CREATE TABLE IF NOT EXISTS descuento_regla_servicio (
  id INT NOT NULL AUTO_INCREMENT,
  regla_id INT NOT NULL,
  servicio_id INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_descuento_regla_servicio (regla_id, servicio_id),
  KEY fk_drs_servicio (servicio_id),
  CONSTRAINT fk_drs_regla FOREIGN KEY (regla_id) REFERENCES descuento_regla (id) ON DELETE CASCADE,
  CONSTRAINT fk_drs_servicio FOREIGN KEY (servicio_id) REFERENCES servicio (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
  {
    descripcion: "Tabla descuento_regla_tipo_persona (alcance por tipo de persona)",
    sql: `
CREATE TABLE IF NOT EXISTS descuento_regla_tipo_persona (
  id INT NOT NULL AUTO_INCREMENT,
  regla_id INT NOT NULL,
  tipo_persona_id INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_descuento_regla_tipo_persona (regla_id, tipo_persona_id),
  KEY fk_drtp_tipo_persona (tipo_persona_id),
  CONSTRAINT fk_drtp_regla FOREIGN KEY (regla_id) REFERENCES descuento_regla (id) ON DELETE CASCADE,
  CONSTRAINT fk_drtp_tipo_persona FOREIGN KEY (tipo_persona_id) REFERENCES tipo_persona (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
  {
    descripcion: "Tabla reserva_descuento (descuento aplicado a una reserva, con snapshot)",
    sql: `
CREATE TABLE IF NOT EXISTS reserva_descuento (
  id INT NOT NULL AUTO_INCREMENT,
  reserva_id INT NOT NULL,
  regla_id INT NULL,
  tipo ENUM('CUPON','TIPO_VIAJE') NOT NULL,
  codigo VARCHAR(60) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  porcentaje_aplicado DECIMAL(5,2) NOT NULL,
  base_calculo ENUM('PRECIO_FINAL','PRECIO_LISTA') NOT NULL,
  importe_base DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  importe_descuento DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  usuario_id INT NOT NULL COMMENT 'Afiliado titular de la reserva',
  departamental_id INT NULL COMMENT 'Departamental del titular al momento de reservar',
  servicio_id INT NULL,
  requiere_comprobante TINYINT(1) NOT NULL DEFAULT 0,
  detalle_json JSON NULL COMMENT 'Desglose por persona y parámetros de la regla al aplicarse',
  aplicado_por_usuario_id INT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reserva_descuento_tipo (reserva_id, tipo),
  KEY idx_reserva_descuento_regla (regla_id, fecha_creacion),
  KEY idx_reserva_descuento_departamental (departamental_id, fecha_creacion),
  KEY idx_reserva_descuento_servicio (servicio_id, fecha_creacion),
  KEY idx_reserva_descuento_usuario (usuario_id),
  CONSTRAINT fk_rdesc_reserva FOREIGN KEY (reserva_id) REFERENCES reserva (id) ON DELETE CASCADE,
  CONSTRAINT fk_rdesc_regla FOREIGN KEY (regla_id) REFERENCES descuento_regla (id) ON DELETE SET NULL,
  CONSTRAINT chk_rdesc_importes CHECK (importe_base >= 0 AND importe_descuento >= 0 AND porcentaje_aplicado BETWEEN 0 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
  {
    descripcion: "Tabla reserva_descuento_archivo (comprobantes en S3)",
    sql: `
CREATE TABLE IF NOT EXISTS reserva_descuento_archivo (
  id INT NOT NULL AUTO_INCREMENT,
  reserva_descuento_id INT NOT NULL,
  archivo VARCHAR(260) NOT NULL COMMENT 'Key S3 (prefijo turismo/descuentos/)',
  nombre_original VARCHAR(260) NULL,
  mime VARCHAR(100) NULL,
  tamanio INT NULL,
  subido_por_usuario_id INT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rdarchivo_descuento (reserva_descuento_id),
  CONSTRAINT fk_rdarchivo_descuento FOREIGN KEY (reserva_descuento_id) REFERENCES reserva_descuento (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
  {
    descripcion: "Tabla descuento_historial (auditoría de reglas, usos, comprobantes y descuento médico)",
    sql: `
CREATE TABLE IF NOT EXISTS descuento_historial (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  regla_id INT NULL,
  reserva_id INT NULL,
  servicio_id INT NULL,
  entidad_tipo VARCHAR(40) NOT NULL COMMENT 'REGLA | USO | COMPROBANTE | SERVICIO_SALUD',
  entidad_id BIGINT UNSIGNED NULL,
  operacion VARCHAR(30) NOT NULL,
  resumen VARCHAR(255) NOT NULL,
  valor_anterior JSON NULL,
  valor_nuevo JSON NULL,
  usuario_id INT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dh_regla (regla_id, fecha_creacion),
  KEY idx_dh_reserva (reserva_id, fecha_creacion),
  KEY idx_dh_servicio (servicio_id, fecha_creacion),
  KEY idx_dh_entidad (entidad_tipo, entidad_id, fecha_creacion),
  KEY idx_dh_usuario (usuario_id, fecha_creacion),
  CONSTRAINT fk_dh_regla FOREIGN KEY (regla_id) REFERENCES descuento_regla (id) ON DELETE SET NULL,
  CONSTRAINT fk_dh_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  },
];

// Columnas nuevas en tablas existentes (MySQL no soporta ADD COLUMN IF NOT EXISTS).
const COLUMNAS = [
  {
    tabla: "reserva",
    columna: "monto_descuentos",
    sql: "ALTER TABLE reserva ADD COLUMN monto_descuentos DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Suma de descuentos aplicados (cupones y tipos de viaje). precio_total ya los descuenta' AFTER monto_adicionales",
  },
  {
    tabla: "servicio",
    columna: "descuento_salud_estado",
    sql: "ALTER TABLE servicio ADD COLUMN descuento_salud_estado ENUM('DESHABILITADO','PENDIENTE','HABILITADO') NOT NULL DEFAULT 'DESHABILITADO' COMMENT 'Subsidio por salud (100%) ofrecido al reservar este servicio' AFTER orden",
  },
  {
    tabla: "servicio",
    columna: "descuento_salud_solicitado_por_usuario_id",
    sql: "ALTER TABLE servicio ADD COLUMN descuento_salud_solicitado_por_usuario_id INT NULL AFTER descuento_salud_estado",
  },
  {
    tabla: "servicio",
    columna: "descuento_salud_fecha_solicitud",
    sql: "ALTER TABLE servicio ADD COLUMN descuento_salud_fecha_solicitud DATETIME NULL AFTER descuento_salud_solicitado_por_usuario_id",
  },
  {
    tabla: "servicio",
    columna: "descuento_salud_motivo",
    sql: "ALTER TABLE servicio ADD COLUMN descuento_salud_motivo VARCHAR(1000) NULL COMMENT 'Última observación de la revisión (rechazo)' AFTER descuento_salud_fecha_solicitud",
  },
];

const CONSTRAINTS = [
  {
    tabla: "reserva",
    nombre: "ajb_chk_reserva_descuentos",
    sql: "ALTER TABLE reserva ADD CONSTRAINT ajb_chk_reserva_descuentos CHECK (monto_descuentos >= 0)",
  },
];

// Tipos de viaje pedidos. Porcentajes provisorios (random) hasta que el área los defina.
const TIPOS_VIAJE = [
  { codigo: "SUBSIDIO_DISCAPACIDAD", nombre: "Subsidio por discapacidad", porcentaje: 35, descripcion: "Para afiliados o familiares con certificado único de discapacidad (CUD). Podés adjuntar el certificado ahora o acercarlo a tu departamental.", orden: 1 },
  { codigo: "VIAJE_BODAS", nombre: "Viaje de bodas / Unión civil", porcentaje: 20, descripcion: "Luna de miel dentro de los 6 meses del casamiento o unión civil. Comprobante: acta o libreta.", orden: 2 },
  { codigo: "ANIVERSARIO_25", nombre: "Viaje de aniversario de 25 años", porcentaje: 15, descripcion: "Bodas de plata: 25 años de casados. Comprobante: acta de matrimonio.", orden: 3 },
  { codigo: "JUBILADO_AJB", nombre: "Jubilado afiliado a AJB", porcentaje: 10, descripcion: "Afiliados jubilados del Poder Judicial que mantienen su afiliación a AJB.", orden: 4 },
  { codigo: "JUBILADO_SUBSECRETARIA", nombre: "Jubilado afiliado a AJB y adherido a la Subsecretaría de Jubilados", porcentaje: 25, descripcion: "Jubilados afiliados que además adhirieron a la Subsecretaría de Jubilados de AJB. Comprobante: constancia de adhesión.", orden: 5 },
];

// Cupones de ejemplo (solo con --seed-cupones; pensados para develop).
const CUPONES_EJEMPLO = [
  { codigo: "JUBILADO", nombre: "Cupón jubilados", porcentaje: 15, descripcion: "Cupón de ejemplo publicado para jubilados.", oculto: 0 },
  { codigo: "AJB2026", nombre: "Cupón administrativo 2026", porcentaje: 10, descripcion: "Cupón administrativo oculto de ejemplo.", oculto: 1 },
];

function assertEnvVar(value, name) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

async function columnaExiste(connection, tabla, columna) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tabla, columna]
  );
  return rows.length > 0;
}

async function constraintExiste(connection, tabla, nombre) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [tabla, nombre]
  );
  return rows.length > 0;
}

async function tablasExistentes(connection) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${TABLAS_NUEVAS.map(() => "?").join(",")})`,
    TABLAS_NUEVAS
  );
  return new Set(rows.map((row) => row.nombre));
}

async function sembrarTiposViaje(connection) {
  for (const tipo of TIPOS_VIAJE) {
    // Se busca también entre los eliminados: si el administrador dio de baja un
    // tipo sembrado, volver a correr la migración no debe resucitarlo.
    const [existentes] = await connection.query(
      "SELECT id, eliminado FROM descuento_regla WHERE tipo = 'TIPO_VIAJE' AND codigo = ? ORDER BY eliminado ASC, id ASC LIMIT 1",
      [tipo.codigo]
    );
    if (existentes.length) {
      console.log(`  · Tipo de viaje ${tipo.codigo} ya existía (id ${existentes[0].id}${Number(existentes[0].eliminado) === 1 ? ", eliminado por el administrador" : ""}); no se modifica`);
      continue;
    }
    const [resultado] = await connection.query(
      `INSERT INTO descuento_regla
         (tipo, codigo, nombre, descripcion, porcentaje_descuento, base_calculo, incluye_adicionales, acumulable,
          requiere_comprobante, oculto, alcance_departamental, alcance_servicio, alcance_persona, habilitado, orden)
       VALUES ('TIPO_VIAJE', ?, ?, ?, ?, 'PRECIO_FINAL', 0, 0, 1, 0, 'TODAS', 'TODOS', 'TODAS', 1, ?)`,
      [tipo.codigo, tipo.nombre, tipo.descripcion, tipo.porcentaje, tipo.orden]
    );
    await connection.query(
      `INSERT INTO descuento_historial (regla_id, entidad_tipo, entidad_id, operacion, resumen, valor_nuevo)
       VALUES (?, 'REGLA', ?, 'CREATE', ?, ?)`,
      [
        resultado.insertId,
        resultado.insertId,
        `Tipo de viaje “${tipo.nombre}” creado por la migración (${tipo.porcentaje}% provisorio)`,
        JSON.stringify({ codigo: tipo.codigo, nombre: tipo.nombre, porcentaje_descuento: tipo.porcentaje, origen: "migracion" }),
      ]
    );
    console.log(`  ✔ Tipo de viaje ${tipo.codigo} creado (${tipo.porcentaje}%)`);
  }
}

async function sembrarCupones(connection) {
  for (const cupon of CUPONES_EJEMPLO) {
    const [existentes] = await connection.query(
      "SELECT id FROM descuento_regla WHERE tipo = 'CUPON' AND codigo = ? LIMIT 1",
      [cupon.codigo]
    );
    if (existentes.length) {
      console.log(`  · Cupón #${cupon.codigo} ya existía`);
      continue;
    }
    const [resultado] = await connection.query(
      `INSERT INTO descuento_regla
         (tipo, codigo, nombre, descripcion, porcentaje_descuento, base_calculo, incluye_adicionales, acumulable,
          requiere_comprobante, oculto, alcance_departamental, alcance_servicio, alcance_persona, habilitado, orden)
       VALUES ('CUPON', ?, ?, ?, ?, 'PRECIO_FINAL', 0, 0, 0, ?, 'TODAS', 'TODOS', 'TODAS', 1, 0)`,
      [cupon.codigo, cupon.nombre, cupon.descripcion, cupon.porcentaje, cupon.oculto]
    );
    await connection.query(
      `INSERT INTO descuento_historial (regla_id, entidad_tipo, entidad_id, operacion, resumen, valor_nuevo)
       VALUES (?, 'REGLA', ?, 'CREATE', ?, ?)`,
      [resultado.insertId, resultado.insertId, `Cupón #${cupon.codigo} creado por la migración (ejemplo)`, JSON.stringify(cupon)]
    );
    console.log(`  ✔ Cupón #${cupon.codigo} creado (${cupon.porcentaje}%)`);
  }
}

async function habilitarHotelSolis(connection) {
  const [servicios] = await connection.query(
    "SELECT id, nombre, descuento_salud_estado FROM servicio WHERE LOWER(nombre) LIKE 'hotel sol_s%' ORDER BY id LIMIT 1"
  );
  if (!servicios.length) {
    console.warn("  · No se encontró el servicio Hotel Solís: el descuento médico no se habilitó en ningún servicio");
    return;
  }
  const servicio = servicios[0];
  if (servicio.descuento_salud_estado === "HABILITADO") {
    console.log(`  · ${servicio.nombre} (id ${servicio.id}) ya tenía el descuento médico habilitado`);
    return;
  }
  await connection.query(
    "UPDATE servicio SET descuento_salud_estado = 'HABILITADO', descuento_salud_motivo = NULL WHERE id = ?",
    [servicio.id]
  );
  await connection.query(
    `INSERT INTO descuento_historial (servicio_id, entidad_tipo, entidad_id, operacion, resumen, valor_anterior, valor_nuevo)
     VALUES (?, 'SERVICIO_SALUD', ?, 'ENABLE', ?, ?, ?)`,
    [
      servicio.id,
      servicio.id,
      `Descuento médico habilitado en “${servicio.nombre}” por la migración`,
      JSON.stringify({ descuento_salud_estado: servicio.descuento_salud_estado }),
      JSON.stringify({ descuento_salud_estado: "HABILITADO" }),
    ]
  );
  console.log(`  ✔ Descuento médico habilitado SOLO en ${servicio.nombre} (id ${servicio.id})`);
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
    console.warn(`Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo. Corré los GRANTs de BD/MIGRACION_DESCUENTOS.md con la cuenta administrativa.`);
    return;
  }
  const cuentas = await cuentasRuntime(connection);
  const etiqueta = cuentas.map((cuenta) => `'${cuenta.user}'@'${cuenta.host}'`).join(", ");
  const sentencias = sqlGrants(connection, cuentas);
  try {
    for (const sentencia of sentencias) await connection.query(sentencia);
    await connection.query("FLUSH PRIVILEGES");
    console.log(`  ✔ GRANT SELECT, INSERT, UPDATE, DELETE sobre ${TABLAS_NUEVAS.length} tablas a ${etiqueta} + FLUSH PRIVILEGES`);
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
  if (esProduccion && siembraCupones) {
    throw new Error("--seed-cupones está pensado para develop: en producción los cupones los crea el administrador.");
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
    for (const tabla of TABLAS_NUEVAS) {
      console.log(`  ✔ ${tabla}${previas.has(tabla) ? " (ya existía)" : " (creada)"}`);
    }

    console.log("Columnas nuevas en reserva y servicio");
    for (const columna of COLUMNAS) {
      if (await columnaExiste(connection, columna.tabla, columna.columna)) {
        console.log(`  · ${columna.tabla}.${columna.columna} ya existía`);
        continue;
      }
      await connection.query(columna.sql);
      console.log(`  ✔ ${columna.tabla}.${columna.columna} agregada`);
    }
    for (const constraint of CONSTRAINTS) {
      if (await constraintExiste(connection, constraint.tabla, constraint.nombre)) {
        console.log(`  · ${constraint.nombre} ya existía`);
        continue;
      }
      await connection.query(constraint.sql);
      console.log(`  ✔ ${constraint.nombre} agregada`);
    }

    console.log("Tipos de viaje");
    await sembrarTiposViaje(connection);
    if (siembraCupones) {
      console.log("Cupones de ejemplo");
      await sembrarCupones(connection);
    }
    console.log("Descuento médico por servicio");
    await habilitarHotelSolis(connection);

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
    console.log("Migración de descuentos finalizada.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error en la migración de descuentos:", error.message);
    process.exit(1);
  });
