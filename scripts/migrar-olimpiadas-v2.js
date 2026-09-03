// Migración v2 del módulo Olimpiadas: bonos contribución, contenido del evento y flujo de aprobación.
//
// Idempotente: CREATE TABLE IF NOT EXISTS, ALTER TABLE guardado por information_schema y seeds con
// guarda. Espejo de BD/MIGRACION_OLIMPIADAS_V2.md.
//
// Qué agrega:
//  - olimpiada: valor del bono, bonos por afiliado, rango de numeración, exigencia de bonos para validar,
//    aprobación de inscripciones, datos del sorteo y puntos del medallero.
//  - olimpiada_inscripcion: estado PENDIENTE, categoría del inscripto, planilla de descuento, validación.
//  - olimpiada_disciplina_config: sede, veedor y reglamento por disciplina y edición.
//  - Tablas nuevas: olimpiada_bono_tramo, olimpiada_inscripcion_acompaniante, olimpiada_bono_bloque,
//    olimpiada_bono, olimpiada_premio, olimpiada_novedad, olimpiada_evento, olimpiada_sede,
//    olimpiada_sede_departamental, olimpiada_partido, olimpiada_medalla, olimpiada_contacto,
//    olimpiada_seccion, olimpiada_foto, olimpiada_enlace.
//  - GRANT SELECT/INSERT/UPDATE/DELETE sobre TODAS las tablas olimpiada_* al usuario runtime.
//
// Uso:
//   node scripts/migrar-olimpiadas-v2.js                     → develop (DB_HOST localhost)
//   node scripts/migrar-olimpiadas-v2.js --allow-production  → obligatorio si DB_HOST no es localhost
//   node scripts/migrar-olimpiadas-v2.js --skip-grants       → sin GRANTs
//
// En develop el backend corre como miajb_runtime (sin CREATE): pasar la cuenta administrativa por
// entorno (dotenv no pisa lo ya definido):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb node scripts/migrar-olimpiadas-v2.js

require("dotenv").config();
const mysql = require("mysql2/promise");
const { TRAMOS_BONOS_INICIALES, SECCIONES_INICIALES } = require("../api/data/olimpiadas-plantillas");

function assertEnvVar(value, name) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

const args = process.argv.slice(2);
const permiteProduccion = args.includes("--allow-production");
const omiteGrants = args.includes("--skip-grants");

const USUARIO_RUNTIME = "miajb_runtime";
const HOST_RUNTIME = "localhost";

const TABLAS_NUEVAS = [
  "olimpiada_bono_tramo",
  "olimpiada_inscripcion_acompaniante",
  "olimpiada_bono_bloque",
  "olimpiada_bono",
  "olimpiada_premio",
  "olimpiada_novedad",
  "olimpiada_sede",
  "olimpiada_sede_departamental",
  "olimpiada_evento",
  "olimpiada_partido",
  "olimpiada_medalla",
  "olimpiada_contacto",
  "olimpiada_seccion",
  "olimpiada_foto",
  "olimpiada_enlace",
];

// ---------------------------------------------------------------------------
// Columnas nuevas en tablas existentes (se agregan sólo si faltan)
// ---------------------------------------------------------------------------
const COLUMNAS_NUEVAS = [
  // olimpiada: bonos contribución + sorteo + medallero + flujo
  ["olimpiada", "valor_bono", "DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Valor unitario del bono contribución'"],
  ["olimpiada", "bonos_afiliado", "INT NOT NULL DEFAULT 8 COMMENT 'Bonos que paga cada afiliado participante'"],
  ["olimpiada", "bono_numero_desde", "INT NOT NULL DEFAULT 0 COMMENT 'Primer número de bono emitido'"],
  ["olimpiada", "bono_numero_hasta", "INT NOT NULL DEFAULT 9999 COMMENT 'Último número de bono emitido'"],
  ["olimpiada", "exigir_bonos_para_validar", "TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 = para validar hay que cubrir los bonos (o planilla de descuento)'"],
  ["olimpiada", "requiere_aprobacion", "TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 = las inscripciones del afiliado nacen PENDIENTE hasta que la departamental las apruebe'"],
  ["olimpiada", "fecha_sorteo", "DATE NULL"],
  ["olimpiada", "sorteo_detalle", "VARCHAR(300) NULL COMMENT 'Ej: Quiniela Provincial Nocturna (premios 1-20) y Nacional Nocturna (21-40)'"],
  ["olimpiada", "sorteo_publicado", "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = los afiliados ven los ganadores'"],
  ["olimpiada", "puntos_oro", "INT NOT NULL DEFAULT 10"],
  ["olimpiada", "puntos_plata", "INT NOT NULL DEFAULT 5"],
  ["olimpiada", "puntos_bronce", "INT NOT NULL DEFAULT 4"],
  // olimpiada_inscripcion: categoría, planilla de descuento, validación
  ["olimpiada_inscripcion", "categoria_tipo_id", "INT NULL COMMENT 'FK olimpiada_disciplina_tipo: Atleta, Coordinación, Cultura, Organización, Prensa, Acompañante'"],
  ["olimpiada_inscripcion", "bonos_requeridos_manual", "INT NULL COMMENT 'Si no es NULL pisa el cálculo automático de bonos requeridos'"],
  ["olimpiada_inscripcion", "planilla_descuento", "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = firmó planilla de descuento por los bonos faltantes'"],
  ["olimpiada_inscripcion", "planilla_monto", "DECIMAL(12,2) NULL"],
  ["olimpiada_inscripcion", "planilla_cuotas", "INT NULL"],
  ["olimpiada_inscripcion", "planilla_observacion", "VARCHAR(300) NULL"],
  ["olimpiada_inscripcion", "fecha_validacion", "DATETIME NULL"],
  ["olimpiada_inscripcion", "validado_por_usuario_id", "INT NULL"],
  // olimpiada_disciplina_config: info por disciplina y edición
  ["olimpiada_disciplina_config", "sede_id", "INT NULL COMMENT 'FK olimpiada_sede (sede deportiva)'"],
  ["olimpiada_disciplina_config", "veedor", "VARCHAR(160) NULL"],
  ["olimpiada_disciplina_config", "reglamento", "MEDIUMTEXT NULL COMMENT 'Reglamento particular de la disciplina para esta edición'"],
  ["olimpiada_disciplina_config", "fecha_modificacion", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"],
];

// ---------------------------------------------------------------------------
// DDL de tablas nuevas (orden respetando FKs)
// ---------------------------------------------------------------------------
const DDL = {
  olimpiada_bono_tramo: `
CREATE TABLE IF NOT EXISTS olimpiada_bono_tramo (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  edad_desde INT NOT NULL,
  edad_hasta INT NULL COMMENT 'NULL = sin tope (18 años o más)',
  bonos INT NOT NULL DEFAULT 0,
  etiqueta VARCHAR(60) NULL,
  orden INT NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_tramo_olimpiada (olimpiada_id, edad_desde),
  CONSTRAINT fk_oli_tramo_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_inscripcion_acompaniante: `
CREATE TABLE IF NOT EXISTS olimpiada_inscripcion_acompaniante (
  id INT NOT NULL AUTO_INCREMENT,
  inscripcion_id INT NOT NULL,
  nombre VARCHAR(80) NOT NULL,
  apellido VARCHAR(80) NOT NULL,
  documento VARCHAR(20) NULL,
  fecha_nacimiento DATE NULL,
  vinculo VARCHAR(40) NULL COMMENT 'Pareja, Hijo/a, DT externo, Otro',
  es_afiliado TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = paga como afiliado (ej. DT judicial afiliado)',
  bonos INT NOT NULL DEFAULT 0 COMMENT 'Bonos que paga este acompañante (calculado por edad o manual)',
  bonos_manual TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = el staff fijó los bonos a mano',
  observacion VARCHAR(200) NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_acomp_inscripcion (inscripcion_id),
  CONSTRAINT fk_oli_acomp_inscripcion FOREIGN KEY (inscripcion_id) REFERENCES olimpiada_inscripcion (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_bono_bloque: `
CREATE TABLE IF NOT EXISTS olimpiada_bono_bloque (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  departamental_id INT NOT NULL,
  numero_desde INT NOT NULL,
  numero_hasta INT NOT NULL,
  observacion VARCHAR(200) NULL,
  usuario_id INT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_bloque_olimpiada (olimpiada_id, numero_desde),
  KEY idx_oli_bloque_departamental (departamental_id),
  CONSTRAINT fk_oli_bloque_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_bloque_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  // Sólo existen filas para bonos vendidos: un número sin fila está disponible.
  // Anular una venta = borrar la fila (queda registrada en olimpiada_historial).
  olimpiada_bono: `
CREATE TABLE IF NOT EXISTS olimpiada_bono (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  numero INT NOT NULL,
  departamental_id INT NULL COMMENT 'Departamental que lo vendió (dueña del bloque)',
  inscripcion_id INT NULL COMMENT 'Inscripción a la que se imputa (opcional)',
  comprador_nombre VARCHAR(160) NOT NULL,
  comprador_documento VARCHAR(20) NULL,
  comprador_email VARCHAR(120) NULL,
  comprador_telefono VARCHAR(30) NULL,
  a_nombre_departamental TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = lo absorbe la departamental (si sale premiado, es de ella)',
  observacion VARCHAR(200) NULL,
  usuario_id INT NULL COMMENT 'Quien cargó la venta',
  fecha_venta DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oli_bono_numero (olimpiada_id, numero),
  KEY idx_oli_bono_departamental (olimpiada_id, departamental_id),
  KEY idx_oli_bono_inscripcion (inscripcion_id),
  KEY idx_oli_bono_documento (olimpiada_id, comprador_documento),
  CONSTRAINT fk_oli_bono_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_bono_inscripcion FOREIGN KEY (inscripcion_id) REFERENCES olimpiada_inscripcion (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_premio: `
CREATE TABLE IF NOT EXISTS olimpiada_premio (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  orden INT NOT NULL DEFAULT 1 COMMENT 'Puesto del premio (1º, 2º, ...)',
  descripcion VARCHAR(600) NOT NULL,
  sorteo VARCHAR(80) NULL COMMENT 'Ej: Quiniela Provincial Nocturna',
  numero_ganador INT NULL COMMENT 'Número sorteado; NULL hasta que se cargue el resultado',
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_premio_olimpiada (olimpiada_id, orden),
  CONSTRAINT fk_oli_premio_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_novedad: `
CREATE TABLE IF NOT EXISTS olimpiada_novedad (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  cuerpo TEXT NOT NULL,
  imagen_archivo VARCHAR(260) NULL COMMENT 'Key S3',
  publicada TINYINT(1) NOT NULL DEFAULT 1,
  fijada TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = se muestra primero',
  notificada TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = ya se avisó a los inscriptos por notificación',
  usuario_id INT NULL,
  fecha_publicacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_novedad_olimpiada (olimpiada_id, eliminado, publicada, fecha_publicacion),
  CONSTRAINT fk_oli_novedad_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_sede: `
CREATE TABLE IF NOT EXISTS olimpiada_sede (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  tipo ENUM('HOTEL','DEPORTIVA','OTRA') NOT NULL DEFAULT 'DEPORTIVA',
  nombre VARCHAR(160) NOT NULL,
  direccion VARCHAR(200) NULL,
  telefono VARCHAR(60) NULL,
  descripcion VARCHAR(400) NULL,
  url_mapa VARCHAR(400) NULL,
  orden INT NOT NULL DEFAULT 0,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_sede_olimpiada (olimpiada_id, tipo, eliminado, orden),
  CONSTRAINT fk_oli_sede_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_sede_departamental: `
CREATE TABLE IF NOT EXISTS olimpiada_sede_departamental (
  id INT NOT NULL AUTO_INCREMENT,
  sede_id INT NOT NULL,
  departamental_id INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oli_sede_dep (sede_id, departamental_id),
  KEY idx_oli_sede_dep_departamental (departamental_id),
  CONSTRAINT fk_oli_sede_dep_sede FOREIGN KEY (sede_id) REFERENCES olimpiada_sede (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_sede_dep_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_evento: `
CREATE TABLE IF NOT EXISTS olimpiada_evento (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  tipo ENUM('GENERAL','ACTIVIDAD') NOT NULL DEFAULT 'GENERAL' COMMENT 'GENERAL = cronograma (check in, comidas); ACTIVIDAD = actividad programada con descripción/imagen',
  fecha DATE NOT NULL,
  hora_inicio TIME NULL,
  hora_fin TIME NULL,
  titulo VARCHAR(160) NOT NULL,
  descripcion TEXT NULL,
  lugar VARCHAR(160) NULL,
  sede_id INT NULL,
  imagen_archivo VARCHAR(260) NULL COMMENT 'Key S3',
  orden INT NOT NULL DEFAULT 0,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_evento_olimpiada (olimpiada_id, eliminado, fecha, hora_inicio),
  KEY idx_oli_evento_sede (sede_id),
  CONSTRAINT fk_oli_evento_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_evento_sede FOREIGN KEY (sede_id) REFERENCES olimpiada_sede (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_partido: `
CREATE TABLE IF NOT EXISTS olimpiada_partido (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  disciplina_id INT NOT NULL,
  fecha DATE NULL,
  hora_inicio TIME NULL,
  hora_fin TIME NULL,
  etiqueta VARCHAR(40) NULL COMMENT 'Ej: A, B, Final, Tercer puesto',
  fase VARCHAR(60) NULL COMMENT 'Ej: Clasificación, Cuartos de final, Semifinal',
  participante1 VARCHAR(120) NOT NULL,
  participante2 VARCHAR(120) NOT NULL,
  departamental1_id INT NULL,
  departamental2_id INT NULL,
  resultado1 VARCHAR(20) NULL,
  resultado2 VARCHAR(20) NULL,
  ganador TINYINT NULL COMMENT '1 = participante1, 2 = participante2, 0 = empate, NULL = sin definir',
  estado ENUM('PROGRAMADO','EN_JUEGO','FINALIZADO','SUSPENDIDO') NOT NULL DEFAULT 'PROGRAMADO',
  sede_id INT NULL,
  observacion VARCHAR(300) NULL,
  orden INT NOT NULL DEFAULT 0,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_partido_olimpiada (olimpiada_id, eliminado, disciplina_id, fecha, hora_inicio),
  KEY idx_oli_partido_estado (olimpiada_id, estado, fecha_modificacion),
  KEY idx_oli_partido_disciplina (disciplina_id),
  KEY idx_oli_partido_sede (sede_id),
  CONSTRAINT fk_oli_partido_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_partido_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id),
  CONSTRAINT fk_oli_partido_sede FOREIGN KEY (sede_id) REFERENCES olimpiada_sede (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_medalla: `
CREATE TABLE IF NOT EXISTS olimpiada_medalla (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  disciplina_id INT NOT NULL,
  puesto TINYINT NOT NULL COMMENT '1 = oro, 2 = plata, 3 = bronce',
  departamental_id INT NOT NULL,
  observacion VARCHAR(200) NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oli_medalla (olimpiada_id, disciplina_id, puesto, departamental_id),
  KEY idx_oli_medalla_departamental (departamental_id),
  KEY idx_oli_medalla_disciplina (disciplina_id),
  CONSTRAINT fk_oli_medalla_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_medalla_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id),
  CONSTRAINT fk_oli_medalla_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_contacto: `
CREATE TABLE IF NOT EXISTS olimpiada_contacto (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  grupo VARCHAR(80) NOT NULL DEFAULT 'Organización' COMMENT 'Ej: Atención médica, Organización',
  nombre VARCHAR(120) NOT NULL,
  cargo VARCHAR(120) NULL,
  telefono VARCHAR(60) NULL,
  email VARCHAR(120) NULL,
  orden INT NOT NULL DEFAULT 0,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_contacto_olimpiada (olimpiada_id, eliminado, grupo, orden),
  CONSTRAINT fk_oli_contacto_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_seccion: `
CREATE TABLE IF NOT EXISTS olimpiada_seccion (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  clave VARCHAR(40) NULL COMMENT 'Identificador de plantilla (regulaciones_generales, gafete, ...); NULL para secciones libres',
  ubicacion ENUM('INFO','REGLAMENTO','BONOS','DATOS_UTILES') NOT NULL DEFAULT 'INFO' COMMENT 'Pestaña del portal donde se muestra',
  titulo VARCHAR(160) NOT NULL,
  contenido MEDIUMTEXT NOT NULL,
  orden INT NOT NULL DEFAULT 0,
  visible TINYINT(1) NOT NULL DEFAULT 1,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_seccion_olimpiada (olimpiada_id, eliminado, ubicacion, orden),
  CONSTRAINT fk_oli_seccion_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_foto: `
CREATE TABLE IF NOT EXISTS olimpiada_foto (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  archivo VARCHAR(260) NOT NULL COMMENT 'Key S3 de la versión web (máx 1600px)',
  miniatura_archivo VARCHAR(260) NOT NULL COMMENT 'Key S3 de la miniatura (máx 420px)',
  ancho INT NULL,
  alto INT NULL,
  mime VARCHAR(40) NULL,
  epigrafe VARCHAR(200) NULL,
  disciplina_id INT NULL,
  fecha DATE NULL COMMENT 'Día del evento al que pertenece',
  etiqueta VARCHAR(60) NULL COMMENT 'Etiqueta libre para filtrar (Inauguración, Fiesta, ...)',
  orden INT NOT NULL DEFAULT 0,
  usuario_id INT NULL,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_foto_olimpiada (olimpiada_id, eliminado, fecha, id),
  KEY idx_oli_foto_disciplina (disciplina_id),
  CONSTRAINT fk_oli_foto_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
  CONSTRAINT fk_oli_foto_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,

  olimpiada_enlace: `
CREATE TABLE IF NOT EXISTS olimpiada_enlace (
  id INT NOT NULL AUTO_INCREMENT,
  olimpiada_id INT NOT NULL,
  tipo ENUM('VIDEOS','OTRO') NOT NULL DEFAULT 'OTRO' COMMENT 'VIDEOS = carpeta compartida (Drive) que se abre en pestaña nueva',
  titulo VARCHAR(160) NOT NULL,
  url VARCHAR(600) NOT NULL,
  descripcion VARCHAR(300) NULL,
  orden INT NOT NULL DEFAULT 0,
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oli_enlace_olimpiada (olimpiada_id, eliminado, orden),
  CONSTRAINT fk_oli_enlace_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
};

// ---------------------------------------------------------------------------
// Helpers de esquema
// ---------------------------------------------------------------------------
async function columnaExiste(connection, tabla, columna) {
  const [filas] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tabla, columna]
  );
  return filas.length > 0;
}

async function tipoColumna(connection, tabla, columna) {
  const [filas] = await connection.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tabla, columna]
  );
  return filas[0]?.COLUMN_TYPE || null;
}

async function indiceExiste(connection, tabla, indice) {
  const [filas] = await connection.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tabla, indice]
  );
  return filas.length > 0;
}

async function tablasOlimpiadas(connection) {
  const [filas] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'olimpiada%'`
  );
  return filas.map((fila) => fila.TABLE_NAME).sort();
}

async function agregarColumnasFaltantes(connection) {
  for (const [tabla, columna, definicion] of COLUMNAS_NUEVAS) {
    if (await columnaExiste(connection, tabla, columna)) {
      console.log(`  · ${tabla}.${columna} ya existía`);
      continue;
    }
    await connection.query(`ALTER TABLE ${connection.escapeId(tabla)} ADD COLUMN ${connection.escapeId(columna)} ${definicion}`);
    console.log(`  ✔ ${tabla}.${columna} agregada`);
  }

  // Estado PENDIENTE en el ENUM de inscripciones (aprobación por la departamental)
  const tipoEstado = await tipoColumna(connection, "olimpiada_inscripcion", "estado");
  if (tipoEstado && !/PENDIENTE/i.test(tipoEstado)) {
    await connection.query(
      `ALTER TABLE olimpiada_inscripcion
       MODIFY COLUMN estado ENUM('PENDIENTE','VALIDADO','CANCELADO') NOT NULL DEFAULT 'VALIDADO'`
    );
    console.log("  ✔ olimpiada_inscripcion.estado ahora admite PENDIENTE");
  } else {
    console.log("  · olimpiada_inscripcion.estado ya admitía PENDIENTE");
  }

  // FK de categoría e índice de sede (guardados)
  if (!(await indiceExiste(connection, "olimpiada_inscripcion", "fk_oli_insc_categoria"))) {
    await connection.query(
      `ALTER TABLE olimpiada_inscripcion
       ADD CONSTRAINT fk_oli_insc_categoria FOREIGN KEY (categoria_tipo_id) REFERENCES olimpiada_disciplina_tipo (id)`
    );
    console.log("  ✔ FK olimpiada_inscripcion.categoria_tipo_id → olimpiada_disciplina_tipo");
  }
  if (!(await indiceExiste(connection, "olimpiada_disciplina_config", "idx_oli_disc_cfg_sede"))) {
    await connection.query(`ALTER TABLE olimpiada_disciplina_config ADD KEY idx_oli_disc_cfg_sede (sede_id)`);
    console.log("  ✔ índice olimpiada_disciplina_config.sede_id");
  }
}

// ---------------------------------------------------------------------------
// Seeds: tramos de bonos y secciones de base para cada olimpiada que no los tenga
// ---------------------------------------------------------------------------
async function sembrarContenidoBase(connection) {
  const [olimpiadas] = await connection.query("SELECT id, nombre FROM olimpiada WHERE eliminado = 0");
  for (const olimpiada of olimpiadas) {
    const [[tramos]] = await connection.query(
      "SELECT COUNT(*) AS total FROM olimpiada_bono_tramo WHERE olimpiada_id = ?",
      [olimpiada.id]
    );
    if (Number(tramos.total) === 0) {
      for (const [indice, tramo] of TRAMOS_BONOS_INICIALES.entries()) {
        await connection.query(
          `INSERT INTO olimpiada_bono_tramo (olimpiada_id, edad_desde, edad_hasta, bonos, etiqueta, orden)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [olimpiada.id, tramo.edad_desde, tramo.edad_hasta, tramo.bonos, tramo.etiqueta, indice + 1]
        );
      }
      console.log(`  ✔ Olimpiada #${olimpiada.id} "${olimpiada.nombre}": ${TRAMOS_BONOS_INICIALES.length} tramos de bonos sembrados`);
    } else {
      console.log(`  · Olimpiada #${olimpiada.id}: ya tenía tramos de bonos`);
    }

    const [[secciones]] = await connection.query(
      "SELECT COUNT(*) AS total FROM olimpiada_seccion WHERE olimpiada_id = ?",
      [olimpiada.id]
    );
    if (Number(secciones.total) === 0) {
      for (const seccion of SECCIONES_INICIALES) {
        await connection.query(
          `INSERT INTO olimpiada_seccion (olimpiada_id, clave, ubicacion, titulo, contenido, orden)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [olimpiada.id, seccion.clave, seccion.ubicacion, seccion.titulo, seccion.contenido, seccion.orden]
        );
      }
      console.log(`  ✔ Olimpiada #${olimpiada.id}: ${SECCIONES_INICIALES.length} secciones informativas sembradas`);
    } else {
      console.log(`  · Olimpiada #${olimpiada.id}: ya tenía secciones`);
    }
  }
}

// ---------------------------------------------------------------------------
// GRANTs al runtime (mismo patrón que migrar-beneficios.js)
// ---------------------------------------------------------------------------
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
    const [filas] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", [USUARIO_RUNTIME]);
    if (filas.length > 0) return filas.map((fila) => ({ user: fila.user, host: fila.host }));
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
  }
  return [{ user: USUARIO_RUNTIME, host: HOST_RUNTIME }];
}

function sqlGrants(connection, cuentas, tablas) {
  const esquema = connection.escapeId(process.env.DB_DATABASE);
  const sentencias = [];
  for (const cuenta of cuentas) {
    const destino = `${connection.escape(cuenta.user)}@${connection.escape(cuenta.host)}`;
    for (const tabla of tablas) {
      sentencias.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${esquema}.${connection.escapeId(tabla)} TO ${destino}`);
    }
  }
  return sentencias;
}

async function otorgarGrantsRuntime(connection, tablas) {
  if (process.env.DB_USER === USUARIO_RUNTIME) {
    console.warn(`Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo. Corré los GRANTs con la cuenta administrativa.`);
    return;
  }
  const cuentas = await cuentasRuntime(connection);
  const etiqueta = cuentas.map((cuenta) => `'${cuenta.user}'@'${cuenta.host}'`).join(", ");
  const sentencias = sqlGrants(connection, cuentas, tablas);
  try {
    for (const sentencia of sentencias) await connection.query(sentencia);
    await connection.query("FLUSH PRIVILEGES");
    console.log(`  ✔ GRANT SELECT, INSERT, UPDATE, DELETE sobre ${tablas.length} tablas olimpiada_* a ${etiqueta} + FLUSH PRIVILEGES`);
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

// ---------------------------------------------------------------------------
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
    const previas = new Set(await tablasOlimpiadas(connection));
    if (!previas.has("olimpiada") || !previas.has("olimpiada_inscripcion")) {
      throw new Error("Falta la migración base del módulo (BD/migracion_olimpiadas.sql). Aplicala antes de la v2.");
    }

    console.log("Columnas nuevas en olimpiada / olimpiada_inscripcion / olimpiada_disciplina_config...");
    await agregarColumnasFaltantes(connection);

    console.log("Tablas nuevas...");
    for (const tabla of TABLAS_NUEVAS) {
      await connection.query(DDL[tabla]);
      console.log(`  ✔ ${tabla}${previas.has(tabla) ? " (ya existía)" : " (creada)"}`);
    }

    // FK diferida: olimpiada_disciplina_config.sede_id → olimpiada_sede (la tabla recién existe acá)
    if (!(await indiceExiste(connection, "olimpiada_disciplina_config", "fk_oli_disc_cfg_sede"))) {
      await connection.query(
        `ALTER TABLE olimpiada_disciplina_config
         ADD CONSTRAINT fk_oli_disc_cfg_sede FOREIGN KEY (sede_id) REFERENCES olimpiada_sede (id) ON DELETE SET NULL`
      );
      console.log("  ✔ FK olimpiada_disciplina_config.sede_id → olimpiada_sede");
    }

    const actuales = await tablasOlimpiadas(connection);
    const faltantes = TABLAS_NUEVAS.filter((tabla) => !actuales.includes(tabla));
    if (faltantes.length > 0) throw new Error(`No se pudieron verificar las tablas: ${faltantes.join(", ")}`);

    console.log("Seeds (tramos de bonos + secciones base por olimpiada)...");
    await sembrarContenidoBase(connection);
    console.log("Esquema listo.");

    if (omiteGrants) {
      console.log("Se omite el intento de GRANTs (--skip-grants).");
      return;
    }
    console.log(`Otorgando DML sobre todas las tablas olimpiada_* a '${USUARIO_RUNTIME}'...`);
    await otorgarGrantsRuntime(connection, actuales);
  } finally {
    await connection.end();
  }
}

main()
  .then(() => {
    console.log("Migración de olimpiadas v2 finalizada.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error en la migración de olimpiadas v2:", error.message);
    process.exit(1);
  });
