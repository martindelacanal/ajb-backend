/**
 * Migración del módulo COSEGURO MÉDICO (reintegros).
 *
 * Crea (si no existen):
 *  - Roles nuevos: admin-central, auditor
 *  - Columnas usuario.cuil / usuario.cbu
 *  - Tablas: coseguro_estado, coseguro_imputacion, coseguro_tipo_reintegro,
 *            coseguro_concepto, coseguro_solicitud, coseguro_archivo,
 *            coseguro_historial, coseguro_observacion
 *  - Seed del plan de cuentas (BD/Plan_de_Cuentas_631.xlsx) con los códigos C.I.C.
 *  - Usuarios de prueba para los roles nuevos (documento 444 y 555, password "Coseguro2026!")
 *
 * Es IDEMPOTENTE: se puede correr varias veces sin duplicar datos.
 *
 * Uso:  node scripts/migrar-coseguro.js   (desde la carpeta BACKEND)
 */
require("dotenv").config({ path: __dirname + "/../.env" });
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

const ESTADOS = [
  // [id, nombre, nombre_afiliado (lo que ve el afiliado), color fondo, color texto, orden]
  [1, "Solicitud iniciada", null, "#E3F2FD", "#1565C0", 1],
  [2, "Revisar solicitud", null, "#FFF1DB", "#B45309", 2],
  [3, "Solicitud revisada", null, "#E0E7FF", "#4338CA", 3],
  [4, "Aprobado por departamental", null, "#FEF9C3", "#A16207", 4],
  [5, "Rechazado por departamental", null, "#FEE2E2", "#B91C1C", 5],
  [6, "Solicitud cancelada", null, "#FFE4E6", "#BE123C", 6],
  [7, "Aprobado por servicios sociales", null, "#D1FAE5", "#047857", 7],
  [8, "Exportado para liquidar", "Pendiente de acreditación", "#F3F4F6", "#4B5563", 8],
  [9, "Pendiente de acreditación", null, "#E2E8F0", "#475569", 9],
  [10, "Liquidado", null, "#E5E7EB", "#374151", 10],
];

// Plan de cuentas 631 (Excel del cliente). tipo: RUBRO (agrupador), CUENTA (código imputable = C.I.C.),
// DETALLE (subcategoría de una cuenta, sin código propio).
// Los códigos sin descripción vienen del Excel ("por ahora no los usamos, pero seguramente los necesitemos") -> activo = 0.
const PLAN_CUENTAS = [
  { codigo: "631.000", descripcion: "GASTOS EN PRESTACIONES", tipo: "RUBRO", parent: null, activo: 1 },

  { codigo: "631.100", descripcion: "INTERNACIONES Y GASTOS SANATORIALES", tipo: "RUBRO", parent: "631.000", activo: 1 },
  { codigo: "631.101", descripcion: null, tipo: "CUENTA", parent: "631.100", activo: 0 },
  { codigo: "631.102", descripcion: null, tipo: "CUENTA", parent: "631.100", activo: 0 },
  { codigo: "631.103", descripcion: "REINTEGROS INTERNACIONES", tipo: "CUENTA", parent: "631.100", activo: 1 },
  { codigo: null, descripcion: "Internación Geriátrica", tipo: "DETALLE", parent: "631.103", activo: 1 },
  { codigo: null, descripcion: "Otros", tipo: "DETALLE", parent: "631.103", activo: 1 },
  { codigo: "631.105", descripcion: "ACOMPAÑANTE TERAPEUTICO", tipo: "CUENTA", parent: "631.100", activo: 1 },
  { codigo: "631.106", descripcion: null, tipo: "CUENTA", parent: "631.100", activo: 0 },

  { codigo: "631.200", descripcion: "SERVICIOS MEDICOS", tipo: "RUBRO", parent: "631.000", activo: 1 },
  { codigo: "631.201", descripcion: null, tipo: "CUENTA", parent: "631.200", activo: 0 },
  { codigo: "631.202", descripcion: "BONO DE CONSULTA", tipo: "CUENTA", parent: "631.200", activo: 1 },
  { codigo: "631.203", descripcion: "HONORARIOS MEDICOS PARTICULARES/EXCEPCIONES", tipo: "CUENTA", parent: "631.200", activo: 1 },
  { codigo: "631.204", descripcion: null, tipo: "CUENTA", parent: "631.200", activo: 0 },
  { codigo: "631.205", descripcion: "MEDICOS COORDINADORES DE ZONA", tipo: "CUENTA", parent: "631.200", activo: 1 },
  { codigo: "631.206", descripcion: "PRACTICAS MEDICAS", tipo: "CUENTA", parent: "631.200", activo: 1 },
  { codigo: null, descripcion: "Con cobertura IOMA", tipo: "DETALLE", parent: "631.206", activo: 1 },
  { codigo: null, descripcion: "Sin cobertura IOMA", tipo: "DETALLE", parent: "631.206", activo: 1 },

  { codigo: "631.300", descripcion: "PRESTACIONES BIOQUIMICAS", tipo: "RUBRO", parent: "631.000", activo: 1 },
  { codigo: "631.301", descripcion: "PRESTACIONES PRACTICAS BIOQUIMICAS", tipo: "CUENTA", parent: "631.300", activo: 1 },
  { codigo: null, descripcion: "Bono bioquímico", tipo: "DETALLE", parent: "631.301", activo: 1 },
  { codigo: null, descripcion: "Prácticas no autorizadas IOMA", tipo: "DETALLE", parent: "631.301", activo: 1 },
  { codigo: "631.302", descripcion: null, tipo: "CUENTA", parent: "631.300", activo: 0 },

  { codigo: "631.400", descripcion: "MEDICAMENTOS AMBULATORIOS", tipo: "RUBRO", parent: "631.000", activo: 1 },
  { codigo: "631.401", descripcion: "PAGO A FARMACIA SINDICAL", tipo: "CUENTA", parent: "631.400", activo: 1 },
  { codigo: "631.402", descripcion: "PAGO A OTRAS FARMACIAS", tipo: "CUENTA", parent: "631.400", activo: 1 },
  { codigo: "631.403", descripcion: "REINTEGRO DE MEDICAMENTOS", tipo: "CUENTA", parent: "631.400", activo: 1 },

  { codigo: "631.500", descripcion: "PRACTICAS ODONTOLOGICAS", tipo: "RUBRO", parent: "631.000", activo: 1 },
  { codigo: "631.501", descripcion: "REINTEGROS ODONTOLOGICOS POR EXCEPCION", tipo: "CUENTA", parent: "631.500", activo: 1 },
  { codigo: "631.502", descripcion: "REINTEGROS ODONTOLOGICOS", tipo: "CUENTA", parent: "631.500", activo: 1 },
  { codigo: "631.503", descripcion: "SUBSIDIOS PROTESIS ODONTOLOGICAS", tipo: "CUENTA", parent: "631.500", activo: 1 },
  { codigo: "631.504", descripcion: "SUBSIDIOS POR TRATAMIENTO DE ORTODONCIA", tipo: "CUENTA", parent: "631.500", activo: 1 },
  { codigo: "631.505", descripcion: "AUDITORIA ODONTOLOGICA", tipo: "CUENTA", parent: "631.500", activo: 1 },

  { codigo: "631.600", descripcion: "PRESTACIONES VARIAS", tipo: "RUBRO", parent: "631.000", activo: 1 },
  { codigo: "631.601", descripcion: "REINTEGROS POR PSIQUIATRIA", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.602", descripcion: "REINTEGROS POR PSICOLOGIA", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: null, descripcion: "Terapia individual", tipo: "DETALLE", parent: "631.602", activo: 1 },
  { codigo: null, descripcion: "Terapia familiar y otras", tipo: "DETALLE", parent: "631.602", activo: 1 },
  { codigo: "631.603", descripcion: "PRESTACIONES PARAMEDICAS", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: null, descripcion: "Enfermería", tipo: "DETALLE", parent: "631.603", activo: 1 },
  { codigo: null, descripcion: "Instrumentación Quirúrgica", tipo: "DETALLE", parent: "631.603", activo: 1 },
  { codigo: null, descripcion: "Curso preparto", tipo: "DETALLE", parent: "631.603", activo: 1 },
  { codigo: null, descripcion: "Anestesista", tipo: "DETALLE", parent: "631.603", activo: 1 },
  { codigo: null, descripcion: "Fonoaudiología", tipo: "DETALLE", parent: "631.603", activo: 1 },
  { codigo: null, descripcion: "Terapia Ocupacional", tipo: "DETALLE", parent: "631.603", activo: 1 },
  { codigo: "631.604", descripcion: "REINTEGRO POR CRISTALES", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.605", descripcion: "REINTEGRO POR AMAZON", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.606", descripcion: "HOSPEDAJE", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: null, descripcion: "Reintegros por hospedaje salud", tipo: "DETALLE", parent: "631.606", activo: 1 },
  { codigo: null, descripcion: "Convenios por hospedaje", tipo: "DETALLE", parent: "631.606", activo: 1 },
  { codigo: "631.607", descripcion: "REINTEGRO POR MATERIAL DESCARTABLE", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.608", descripcion: "REINTEGRO ORTOPEDIA", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.609", descripcion: "REINTEGRO KINESIOLOGIA", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.610", descripcion: null, tipo: "CUENTA", parent: "631.600", activo: 0 },
  { codigo: "631.611", descripcion: "OTRAS PRESTACIONES", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.612", descripcion: "REINTEGROS POR REHABILITACION", tipo: "CUENTA", parent: "631.600", activo: 1 },
  { codigo: "631.613", descripcion: "SUBSIDIOS FALLECIMIENTOS", tipo: "CUENTA", parent: "631.600", activo: 1 },
  // El Excel dice "631,614" (coma): se normaliza a punto.
  { codigo: "631.614", descripcion: "SUBSIDIOS CELIAQUIA", tipo: "CUENTA", parent: "631.600", activo: 1 },

  { codigo: "511.701", descripcion: "SUBSIDIO POR NACIMIENTO - ADOPCION", tipo: "CUENTA", parent: null, activo: 1 },
];

// Tipos de reintegro que ve el afiliado. Cada uno define sus casillas de adjuntos
// (nombradas según el tipo, para que no suban la misma foto en todos los campos)
// y la cuenta C.I.C. sugerida (automática, editable por servicios sociales).
const TIPOS_REINTEGRO = [
  {
    nombre: "Medicamentos con cobertura del IOMA", icono: "medication", cic: "631.403", requiere_pto_venta: 1,
    adjuntos: [
      { key: "RECETA", label: "Receta médica", requerido: 1 },
      { key: "TICKET_FISCAL", label: "Ticket fiscal de la farmacia", requerido: 1 },
      { key: "TROQUEL", label: "Troquel del medicamento", requerido: 1 },
      { key: "DETALLE_COMPRA", label: "Detalle de la compra", requerido: 0 },
    ],
  },
  {
    nombre: "Medicamentos sin cobertura del IOMA", icono: "medication_liquid", cic: "631.403", requiere_pto_venta: 1,
    adjuntos: [
      { key: "RECETA", label: "Receta médica", requerido: 1 },
      { key: "TICKET_FISCAL", label: "Ticket fiscal de la farmacia", requerido: 1 },
      { key: "TROQUEL", label: "Troquel del medicamento", requerido: 0 },
      { key: "DETALLE_COMPRA", label: "Detalle de la compra", requerido: 0 },
    ],
  },
  {
    nombre: "Prácticas con cobertura del IOMA", icono: "biotech", cic: "631.206", detalle: "Con cobertura IOMA", requiere_pto_venta: 1,
    adjuntos: [
      { key: "PRESCRIPCION", label: "Prescripción médica", requerido: 1 },
      { key: "FACTURA", label: "Factura / ticket fiscal", requerido: 1 },
      { key: "DETALLE_COMPRA", label: "Detalle de la práctica", requerido: 0 },
    ],
  },
  {
    nombre: "Prácticas sin cobertura del IOMA", icono: "science", cic: "631.206", detalle: "Sin cobertura IOMA", requiere_pto_venta: 1,
    adjuntos: [
      { key: "PRESCRIPCION", label: "Prescripción médica", requerido: 1 },
      { key: "FACTURA", label: "Factura / ticket fiscal", requerido: 1 },
      { key: "DETALLE_COMPRA", label: "Detalle de la práctica", requerido: 0 },
    ],
  },
  {
    nombre: "Consultas médicas", icono: "stethoscope", cic: "631.203", requiere_pto_venta: 1,
    adjuntos: [
      { key: "FACTURA", label: "Factura / recibo de la consulta", requerido: 1 },
      { key: "PRESCRIPCION", label: "Orden / prescripción médica", requerido: 0 },
    ],
  },
  {
    nombre: "Bono", icono: "confirmation_number", cic: "631.202", requiere_pto_venta: 0,
    adjuntos: [
      { key: "BONO_FRENTE", label: "Foto del bono (frente)", requerido: 1 },
      { key: "BONO_DORSO", label: "Foto del bono (dorso)", requerido: 0 },
    ],
  },
  {
    nombre: "Obsequio por nacimiento", icono: "child_care", cic: "511.701", requiere_pto_venta: 0,
    adjuntos: [
      { key: "PARTIDA_NACIMIENTO", label: "Partida / certificado de nacimiento", requerido: 1 },
      { key: "DNI_RECIEN_NACIDO", label: "DNI del recién nacido", requerido: 0 },
    ],
  },
  {
    nombre: "Psicología", icono: "psychology", cic: "631.602", requiere_pto_venta: 1,
    adjuntos: [
      { key: "FACTURA", label: "Factura / recibo del profesional", requerido: 1 },
      { key: "PRESCRIPCION", label: "Prescripción / derivación médica", requerido: 0 },
    ],
  },
  {
    nombre: "Odontología", icono: "dentistry", cic: "631.502", requiere_pto_venta: 1,
    adjuntos: [
      { key: "FACTURA", label: "Factura / recibo del odontólogo", requerido: 1 },
      { key: "DETALLE_COMPRA", label: "Detalle del tratamiento", requerido: 0 },
    ],
  },
  {
    nombre: "Otros", icono: "receipt_long", cic: "631.611", requiere_pto_venta: 0,
    adjuntos: [
      { key: "COMPROBANTE", label: "Comprobante del gasto", requerido: 1 },
      { key: "DOCUMENTACION", label: "Documentación respaldatoria", requerido: 0 },
    ],
  },
];

// Conceptos (lista del cliente) con su cuenta C.I.C. sugerida para autocompletar la imputación.
const CONCEPTOS = [
  { nombre: "Odontología", cic: "631.502" },
  { nombre: "Psicología", cic: "631.602" },
  { nombre: "Enfermería", cic: "631.603", detalle: "Enfermería" },
  { nombre: "Fonoaudiología", cic: "631.603", detalle: "Fonoaudiología" },
  { nombre: "Prácticas médicas", cic: "631.206" },
  { nombre: "Medicamentos", cic: "631.403" },
  { nombre: "Kinesiología", cic: "631.609" },
  { nombre: "Instrumentista", cic: "631.603", detalle: "Instrumentación Quirúrgica" },
  { nombre: "Prácticas quirúrgicas", cic: "631.103" },
  { nombre: "Cristales", cic: "631.604" },
  { nombre: "Marcos", cic: "631.604" },
  { nombre: "Prácticas bioquímicas", cic: "631.301" },
  { nombre: "Consultas", cic: "631.203" },
  { nombre: "Otros", cic: "631.611" },
  { nombre: "Fallecimiento", cic: "631.613" },
  { nombre: "Marcos y Cristales", cic: "631.604" },
  { nombre: "Subsidio para celíacos", cic: "631.614" },
];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    multipleStatements: true,
  });
  console.log("Conectado a", process.env.DB_DATABASE, "en", process.env.DB_HOST);

  // ---------- 1. Roles nuevos ----------
  for (const rol of ["admin-central", "auditor"]) {
    const [r] = await conn.query("SELECT id FROM rol WHERE nombre = ?", [rol]);
    if (r.length === 0) {
      await conn.query("INSERT INTO rol (nombre) VALUES (?)", [rol]);
      console.log(`Rol creado: ${rol}`);
    }
  }

  // ---------- 2. Columnas cuil / cbu en usuario ----------
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'usuario' AND COLUMN_NAME IN ('cuil','cbu')`,
    [process.env.DB_DATABASE]
  );
  const existentes = cols.map((c) => c.COLUMN_NAME);
  if (!existentes.includes("cuil")) {
    await conn.query("ALTER TABLE usuario ADD COLUMN cuil VARCHAR(11) NULL AFTER legajo");
    console.log("Columna usuario.cuil creada");
  }
  if (!existentes.includes("cbu")) {
    await conn.query("ALTER TABLE usuario ADD COLUMN cbu VARCHAR(22) NULL AFTER cuil");
    console.log("Columna usuario.cbu creada");
  }

  // ---------- 3. Tablas ----------
  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_estado (
      id INT NOT NULL PRIMARY KEY,
      nombre VARCHAR(60) NOT NULL,
      nombre_afiliado VARCHAR(60) NULL COMMENT 'Nombre que ve el afiliado (si difiere del interno)',
      color VARCHAR(9) NOT NULL,
      color_texto VARCHAR(9) NOT NULL,
      orden INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_imputacion (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      codigo VARCHAR(12) NULL COMMENT 'C.I.C. codigo de imputacion contable (NULL para DETALLE)',
      descripcion VARCHAR(120) NULL,
      tipo ENUM('RUBRO','CUENTA','DETALLE') NOT NULL,
      parent_id INT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      orden INT NOT NULL DEFAULT 0,
      UNIQUE KEY uk_imputacion_codigo (codigo),
      KEY idx_imputacion_parent (parent_id),
      CONSTRAINT fk_imputacion_parent FOREIGN KEY (parent_id) REFERENCES coseguro_imputacion(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_tipo_reintegro (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(80) NOT NULL,
      icono VARCHAR(40) NULL,
      imputacion_id INT NULL COMMENT 'Cuenta C.I.C. sugerida',
      imputacion_detalle_id INT NULL COMMENT 'Detalle sugerido',
      requiere_pto_venta TINYINT(1) NOT NULL DEFAULT 1,
      adjuntos_config JSON NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      orden INT NOT NULL DEFAULT 0,
      UNIQUE KEY uk_tipo_reintegro_nombre (nombre),
      CONSTRAINT fk_tipo_imputacion FOREIGN KEY (imputacion_id) REFERENCES coseguro_imputacion(id),
      CONSTRAINT fk_tipo_imputacion_detalle FOREIGN KEY (imputacion_detalle_id) REFERENCES coseguro_imputacion(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_concepto (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(80) NOT NULL,
      imputacion_id INT NULL COMMENT 'Cuenta C.I.C. sugerida',
      imputacion_detalle_id INT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      orden INT NOT NULL DEFAULT 0,
      UNIQUE KEY uk_concepto_nombre (nombre),
      CONSTRAINT fk_concepto_imputacion FOREIGN KEY (imputacion_id) REFERENCES coseguro_imputacion(id),
      CONSTRAINT fk_concepto_imputacion_detalle FOREIGN KEY (imputacion_detalle_id) REFERENCES coseguro_imputacion(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_solicitud (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL COMMENT 'Afiliado titular',
      familiar_usuario_id INT NULL COMMENT 'Familiar a cargo que recibio la prestacion (NULL = titular)',
      departamental_id INT NULL,
      creado_por_usuario_id INT NOT NULL,
      estado_id INT NOT NULL DEFAULT 1,
      tipo_reintegro_id INT NOT NULL,
      concepto_id INT NULL,
      fecha_comprobante DATE NOT NULL,
      comprobante_pto_venta VARCHAR(5) NULL,
      comprobante_numero VARCHAR(20) NOT NULL,
      emisor_nombre VARCHAR(120) NOT NULL,
      emisor_cuit VARCHAR(11) NULL,
      importe DECIMAL(12,2) NOT NULL,
      cuil_afiliado VARCHAR(11) NULL,
      cbu VARCHAR(22) NULL,
      observaciones TEXT NULL,
      cantidad_sesiones INT NULL COMMENT 'Cantidad de sesiones/prestaciones (ej: psicologia 4 sesiones)',
      periodo_prestacion CHAR(7) NULL COMMENT 'Mes de la prestacion YYYY-MM (ej: internacion geriatrica)',
      firma_archivo VARCHAR(260) NULL,
      importe_autorizado DECIMAL(12,2) NULL,
      imputacion_id INT NULL COMMENT 'Cuenta C.I.C. asignada por servicios sociales',
      imputacion_detalle_id INT NULL,
      cic_codigo VARCHAR(12) NULL COMMENT 'C.I.C. denormalizado',
      extraccion_ia JSON NULL COMMENT 'Resultado de la extraccion automatica del comprobante',
      verificacion JSON NULL COMMENT 'Resultado de validaciones (CUIT, duplicados, antiguedad)',
      fecha_aprobacion_departamental DATETIME NULL,
      aprobado_departamental_usuario_id INT NULL,
      fecha_aprobacion_central DATETIME NULL,
      aprobado_central_usuario_id INT NULL,
      fecha_exportacion DATETIME NULL,
      exportado_usuario_id INT NULL,
      fecha_pago DATETIME NULL COMMENT 'Fecha de acreditacion bancaria (CSV del auditor)',
      eliminado TINYINT(1) NOT NULL DEFAULT 0,
      eliminado_usuario_id INT NULL,
      fecha_eliminacion DATETIME NULL,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_cos_sol_usuario (usuario_id),
      KEY idx_cos_sol_departamental (departamental_id),
      KEY idx_cos_sol_estado (estado_id),
      KEY idx_cos_sol_fecha (fecha_comprobante),
      KEY idx_cos_sol_comprobante (emisor_cuit, comprobante_pto_venta, comprobante_numero),
      CONSTRAINT fk_cos_sol_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id),
      CONSTRAINT fk_cos_sol_estado FOREIGN KEY (estado_id) REFERENCES coseguro_estado(id),
      CONSTRAINT fk_cos_sol_tipo FOREIGN KEY (tipo_reintegro_id) REFERENCES coseguro_tipo_reintegro(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_archivo (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      solicitud_id INT NOT NULL,
      tipo_adjunto VARCHAR(30) NOT NULL COMMENT 'RECETA, TICKET_FISCAL, TROQUEL, BONO_FRENTE, etc.',
      archivo VARCHAR(260) NOT NULL COMMENT 'Key S3',
      nombre_original VARCHAR(260) NULL,
      mime VARCHAR(100) NULL,
      tamanio INT NULL,
      sha256 CHAR(64) NULL COMMENT 'Hash para deteccion de archivos duplicados',
      phash VARCHAR(600) NULL COMMENT 'Hashes perceptuales de las 8 orientaciones (JSON, detecta imagenes rotadas/espejadas)',
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_cos_arch_solicitud (solicitud_id),
      KEY idx_cos_arch_sha (sha256),
      CONSTRAINT fk_cos_arch_solicitud FOREIGN KEY (solicitud_id) REFERENCES coseguro_solicitud(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Columna phash para bases migradas con una versión anterior del script
  const [colsArchivo] = await conn.query(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'coseguro_archivo' AND COLUMN_NAME = 'phash'`,
    [process.env.DB_DATABASE]
  );
  if (colsArchivo.length === 0) {
    await conn.query(
      "ALTER TABLE coseguro_archivo ADD COLUMN phash VARCHAR(600) NULL COMMENT 'Hashes perceptuales de las 8 orientaciones (JSON, detecta imagenes rotadas/espejadas)' AFTER sha256"
    );
    console.log("Columna coseguro_archivo.phash creada");
  } else if (colsArchivo[0].DATA_TYPE !== "varchar") {
    await conn.query("ALTER TABLE coseguro_archivo MODIFY phash VARCHAR(600) NULL COMMENT 'Hashes perceptuales de las 8 orientaciones (JSON)'");
    console.log("Columna coseguro_archivo.phash convertida a VARCHAR(600)");
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_historial (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      solicitud_id INT NOT NULL,
      usuario_id INT NULL,
      usuario_rol VARCHAR(30) NULL,
      tipo_operacion ENUM('CREATE','UPDATE','CAMBIO_ESTADO','OBSERVACION','DELETE','EXPORT','LIQUIDACION') NOT NULL,
      estado_anterior_id INT NULL,
      estado_nuevo_id INT NULL,
      campo_modificado VARCHAR(100) NULL,
      valor_anterior TEXT NULL,
      valor_nuevo TEXT NULL,
      observacion TEXT NULL,
      fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_cos_hist_solicitud (solicitud_id),
      KEY idx_cos_hist_fecha (fecha),
      CONSTRAINT fk_cos_hist_solicitud FOREIGN KEY (solicitud_id) REFERENCES coseguro_solicitud(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS coseguro_observacion (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      solicitud_id INT NOT NULL,
      usuario_id INT NOT NULL,
      usuario_rol VARCHAR(30) NULL,
      mensaje TEXT NOT NULL,
      estado_id INT NULL COMMENT 'Estado de la solicitud al momento del mensaje',
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_cos_obs_solicitud (solicitud_id),
      CONSTRAINT fk_cos_obs_solicitud FOREIGN KEY (solicitud_id) REFERENCES coseguro_solicitud(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log("Tablas creadas/verificadas");

  // ---------- 4. Seed estados ----------
  for (const [id, nombre, nombreAfiliado, color, colorTexto, orden] of ESTADOS) {
    await conn.query(
      `INSERT INTO coseguro_estado (id, nombre, nombre_afiliado, color, color_texto, orden)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), nombre_afiliado = VALUES(nombre_afiliado),
         color = VALUES(color), color_texto = VALUES(color_texto), orden = VALUES(orden)`,
      [id, nombre, nombreAfiliado, color, colorTexto, orden]
    );
  }
  console.log(`Estados: ${ESTADOS.length}`);

  // ---------- 5. Seed plan de cuentas ----------
  const idPorCodigo = new Map(); // codigo -> id
  const idDetalle = new Map(); // parentCodigo::descripcion -> id
  let orden = 0;
  for (const cuenta of PLAN_CUENTAS) {
    orden += 1;
    const parentId = cuenta.parent ? idPorCodigo.get(cuenta.parent) || null : null;
    if (cuenta.codigo) {
      const [existe] = await conn.query("SELECT id FROM coseguro_imputacion WHERE codigo = ?", [cuenta.codigo]);
      let id;
      if (existe.length > 0) {
        id = existe[0].id;
        await conn.query(
          "UPDATE coseguro_imputacion SET descripcion = ?, tipo = ?, parent_id = ?, activo = ?, orden = ? WHERE id = ?",
          [cuenta.descripcion, cuenta.tipo, parentId, cuenta.activo, orden, id]
        );
      } else {
        const [res] = await conn.query(
          "INSERT INTO coseguro_imputacion (codigo, descripcion, tipo, parent_id, activo, orden) VALUES (?, ?, ?, ?, ?, ?)",
          [cuenta.codigo, cuenta.descripcion, cuenta.tipo, parentId, cuenta.activo, orden]
        );
        id = res.insertId;
      }
      idPorCodigo.set(cuenta.codigo, id);
    } else {
      // DETALLE sin código: se identifica por (parent, descripcion)
      const [existe] = await conn.query(
        "SELECT id FROM coseguro_imputacion WHERE parent_id = ? AND descripcion = ? AND tipo = 'DETALLE'",
        [parentId, cuenta.descripcion]
      );
      let id;
      if (existe.length > 0) {
        id = existe[0].id;
        await conn.query("UPDATE coseguro_imputacion SET activo = ?, orden = ? WHERE id = ?", [cuenta.activo, orden, id]);
      } else {
        const [res] = await conn.query(
          "INSERT INTO coseguro_imputacion (codigo, descripcion, tipo, parent_id, activo, orden) VALUES (NULL, ?, 'DETALLE', ?, ?, ?)",
          [cuenta.descripcion, parentId, cuenta.activo, orden]
        );
        id = res.insertId;
      }
      idDetalle.set(`${cuenta.parent}::${cuenta.descripcion}`, id);
    }
  }
  console.log(`Plan de cuentas: ${PLAN_CUENTAS.length} filas`);

  // ---------- 6. Seed tipos de reintegro ----------
  orden = 0;
  for (const tipo of TIPOS_REINTEGRO) {
    orden += 1;
    const imputacionId = tipo.cic ? idPorCodigo.get(tipo.cic) || null : null;
    const detalleId = tipo.detalle ? idDetalle.get(`${tipo.cic}::${tipo.detalle}`) || null : null;
    await conn.query(
      `INSERT INTO coseguro_tipo_reintegro (nombre, icono, imputacion_id, imputacion_detalle_id, requiere_pto_venta, adjuntos_config, orden)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE icono = VALUES(icono), imputacion_id = VALUES(imputacion_id),
         imputacion_detalle_id = VALUES(imputacion_detalle_id), requiere_pto_venta = VALUES(requiere_pto_venta),
         adjuntos_config = VALUES(adjuntos_config), orden = VALUES(orden)`,
      [tipo.nombre, tipo.icono, imputacionId, detalleId, tipo.requiere_pto_venta, JSON.stringify(tipo.adjuntos), orden]
    );
  }
  console.log(`Tipos de reintegro: ${TIPOS_REINTEGRO.length}`);

  // ---------- 7. Seed conceptos ----------
  orden = 0;
  for (const concepto of CONCEPTOS) {
    orden += 1;
    const imputacionId = concepto.cic ? idPorCodigo.get(concepto.cic) || null : null;
    const detalleId = concepto.detalle ? idDetalle.get(`${concepto.cic}::${concepto.detalle}`) || null : null;
    await conn.query(
      `INSERT INTO coseguro_concepto (nombre, imputacion_id, imputacion_detalle_id, orden)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE imputacion_id = VALUES(imputacion_id),
         imputacion_detalle_id = VALUES(imputacion_detalle_id), orden = VALUES(orden)`,
      [concepto.nombre, imputacionId, detalleId, orden]
    );
  }
  console.log(`Conceptos: ${CONCEPTOS.length}`);

  // ---------- 8. Usuarios de prueba para los roles nuevos ----------
  const [rolesRows] = await conn.query("SELECT id, nombre FROM rol");
  const rolId = (nombre) => rolesRows.find((r) => r.nombre === nombre)?.id;
  const passwordHash = await bcrypt.hash("Coseguro2026!", 10);
  const usuariosPrueba = [
    { documento: 444, nombre: "Servicios", apellido: "Sociales", email: "central@test.com", rol: "admin-central" },
    { documento: 555, nombre: "Auditor", apellido: "Tesoreria", email: "auditor@test.com", rol: "auditor" },
  ];
  for (const u of usuariosPrueba) {
    const [existe] = await conn.query("SELECT id FROM usuario WHERE documento = ?", [u.documento]);
    if (existe.length === 0) {
      await conn.query(
        `INSERT INTO usuario (rol_id, nombre, apellido, documento, password, email, habilitado)
         VALUES (?, ?, ?, ?, ?, ?, 'Y')`,
        [rolId(u.rol), u.nombre, u.apellido, u.documento, passwordHash, u.email]
      );
      console.log(`Usuario de prueba creado: ${u.rol} (documento ${u.documento}, password Coseguro2026!)`);
    }
  }

  await conn.end();
  console.log("Migración de coseguro completada OK");
}

main().catch((err) => {
  console.error("Error en la migración:", err);
  process.exit(1);
});
