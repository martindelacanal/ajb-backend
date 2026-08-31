"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

const catalogo = require("../api/data/turismo-catalogo-inicial");

const MIGRATION_ID = "20260830_turismo_catalogo_v1";
const MIGRATION_REVISION = 3;
const CHECKSUMS_ANTERIORES_PERMITIDOS = new Set([
  "c5475153f26222c46c3f062bf66a2e2fa755564267e56e5e3dd71460419ae4ef",
]);
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const CONFIRMACIONES = Object.freeze({
  develop: "APLICAR_CATALOGO_TURISMO_DEVELOP",
  production: "APLICAR_CATALOGO_TURISMO_PRODUCTION",
});
const TARGETS = new Set(Object.keys(CONFIRMACIONES));
const IDENTIDADES_LEGACY_PERMITIDAS = Object.freeze({
  servicios: Object.freeze({
    1: Object.freeze(["Parador de la Montaña"]),
    2: Object.freeze(["Hotel Solís"]),
    3: Object.freeze(["Cabañas", "Miramar Cabañas"]),
    4: Object.freeze(["Camping"]),
  }),
  recursos: Object.freeze({
    1: Object.freeze(["Parcela"]),
    2: Object.freeze(["Cabaña 12", "Cabaña Nro 12 - Nueva"]),
    3: Object.freeze(["Cabaña 11", "Cabaña Nro 11 - Nueva"]),
  }),
});
const TARIFA_COLUMNAS_LEGACY = Object.freeze([
  "id", "recurso_id", "tipo_persona_id", "regimen_id", "temporada_tarifa_id",
  "edad_minima", "edad_maxima", "precio", "fecha_inicio", "fecha_fin",
  "precio_por_persona", "usa_porcentaje", "porcentaje_descuento",
  "parcelas_disponibles", "fecha_creacion", "fecha_modificacion",
]);

const CREATE_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ajb_schema_migration (
    migration_id VARCHAR(100) NOT NULL,
    checksum CHAR(64) NOT NULL,
    revision INT UNSIGNED NOT NULL,
    estado ENUM('APLICANDO','APLICADA','FALLIDA') NOT NULL,
    etapa VARCHAR(100) NULL,
    detalle TEXT NULL,
    trigger_definer VARCHAR(255) NOT NULL DEFAULT '',
    trigger_sql_mode TEXT NOT NULL,
    iniciada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    finalizada_en DATETIME NULL,
    PRIMARY KEY (migration_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
`;

const CREATE_BACKUP_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ajb_turismo_catalogo_backup (
    migration_id VARCHAR(100) NOT NULL,
    tabla VARCHAR(80) NOT NULL,
    fila_id VARCHAR(160) NOT NULL,
    datos JSON NOT NULL,
    checksum CHAR(64) NOT NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (migration_id, tabla, fila_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
`;

const COLUMNAS_A_AGREGAR = Object.freeze({
  tipo_servicio: Object.freeze({
    codigo: "VARCHAR(60) NULL",
    descripcion: "TEXT NULL",
    activo: "TINYINT(1) NOT NULL DEFAULT 1",
    orden: "INT UNSIGNED NOT NULL DEFAULT 0",
  }),
  servicio: Object.freeze({
    codigo: "VARCHAR(80) NULL",
    descripcion: "TEXT NULL",
    provincia: "VARCHAR(120) NULL",
    direccion: "VARCHAR(255) NULL",
    tarifario_pdf_url: "VARCHAR(1000) NULL",
    motivo_revision: "VARCHAR(1000) NULL",
    anticipacion_minima_dias: "INT UNSIGNED NOT NULL DEFAULT 0",
    propietario_departamental_id: "INT NULL",
    creado_por_usuario_id: "INT NULL",
    estado_aprobacion: "ENUM('BORRADOR','PENDIENTE','APROBADO','RECHAZADO') NOT NULL DEFAULT 'APROBADO'",
    activo: "TINYINT(1) NOT NULL DEFAULT 1",
    alcance_departamental: "ENUM('TODAS','PROPIA','SELECCIONADAS') NOT NULL DEFAULT 'TODAS'",
    modelo_tarifa: "ENUM('TEMPORADAS','PRECIO_UNICO') NOT NULL DEFAULT 'TEMPORADAS'",
    unidad_cobro: "ENUM('POR_PERSONA_NOCHE','POR_RECURSO_NOCHE','POR_RECURSO_DIA','POR_ESTADIA') NOT NULL DEFAULT 'POR_PERSONA_NOCHE'",
    permite_acompanantes: "TINYINT(1) NOT NULL DEFAULT 1",
    max_personas_reserva: "INT UNSIGNED NULL",
    etiqueta_identificador: "VARCHAR(80) NULL",
    condiciones: "TEXT NULL",
    formulario_adhesion_url: "VARCHAR(1000) NULL",
    orden: "INT UNSIGNED NOT NULL DEFAULT 0",
    fecha_creacion: "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
    fecha_modificacion: "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    version: "INT UNSIGNED NOT NULL DEFAULT 1",
  }),
  recurso: Object.freeze({
    codigo: "VARCHAR(80) NULL",
    categoria: "VARCHAR(80) NULL",
    descripcion: "TEXT NULL",
    activo: "TINYINT(1) NOT NULL DEFAULT 1",
    orden: "INT UNSIGNED NOT NULL DEFAULT 0",
    cupo_maximo: "INT UNSIGNED NULL",
    es_recurso_principal: "TINYINT(1) NOT NULL DEFAULT 0",
    fecha_creacion: "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
    fecha_modificacion: "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    version: "INT UNSIGNED NOT NULL DEFAULT 1",
  }),
  filtro: Object.freeze({
    codigo: "VARCHAR(80) NULL",
    tipo_valor: "ENUM('NUMERO','BOOLEANO','TEXTO','OPCION') NOT NULL DEFAULT 'NUMERO'",
    categoria: "VARCHAR(80) NULL",
    unidad: "VARCHAR(40) NULL",
    ayuda: "VARCHAR(500) NULL",
    opciones: "JSON NULL",
    activo: "TINYINT(1) NOT NULL DEFAULT 1",
    orden: "INT UNSIGNED NOT NULL DEFAULT 0",
  }),
  filtro_recurso: Object.freeze({
    valor_numero: "DECIMAL(12,2) NULL",
    valor_booleano: "TINYINT(1) NULL",
    valor_texto: "VARCHAR(500) NULL",
  }),
  tarifa: Object.freeze({
    audiencia_departamental: "ENUM('TODAS','PROPIA','OTRAS') NOT NULL DEFAULT 'TODAS'",
    turismo_tarifa_regla_id: "BIGINT UNSIGNED NULL",
  }),
  convenio_hotel: Object.freeze({
    servicio_id: "INT NULL",
  }),
});

// Columnas legacy cuyo tamaño quedó por debajo del contrato actual de la API.
// Se mantienen sus reglas de nulabilidad originales para que el cambio sea
// aditivo y no invalide datos históricos.
const COLUMNAS_A_ALINEAR = Object.freeze({
  servicio: Object.freeze({
    nombre: "VARCHAR(120) NULL",
    lugar: "VARCHAR(160) NULL",
  }),
  recurso: Object.freeze({
    nombre: "VARCHAR(120) NULL",
  }),
  filtro: Object.freeze({
    nombre: "VARCHAR(120) NULL",
  }),
  convenio_hotel: Object.freeze({
    nombre: "VARCHAR(160) NOT NULL",
    ciudad: "VARCHAR(120) NOT NULL",
    provincia: "VARCHAR(120) NOT NULL",
    coordenadas_maps: "VARCHAR(1000) NULL",
  }),
});

const CREATE_NUEVAS_TABLAS_SQL = Object.freeze({
  servicio_departamental_visible: `
    CREATE TABLE IF NOT EXISTS servicio_departamental_visible (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      servicio_id INT NOT NULL,
      departamental_id INT NOT NULL,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_sdv_servicio_departamental (servicio_id, departamental_id),
      KEY idx_sdv_departamental (departamental_id, servicio_id),
      CONSTRAINT fk_sdv_servicio FOREIGN KEY (servicio_id) REFERENCES servicio (id) ON DELETE CASCADE,
      CONSTRAINT fk_sdv_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `,
  servicio_filtro: `
    CREATE TABLE IF NOT EXISTS servicio_filtro (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      servicio_id INT NOT NULL,
      filtro_id INT NOT NULL,
      mostrar_en_busqueda TINYINT(1) NOT NULL DEFAULT 1,
      orden INT UNSIGNED NOT NULL DEFAULT 0,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_sf_servicio_filtro (servicio_id, filtro_id),
      KEY idx_sf_filtro (filtro_id, servicio_id),
      CONSTRAINT fk_sf_servicio FOREIGN KEY (servicio_id) REFERENCES servicio (id) ON DELETE CASCADE,
      CONSTRAINT fk_sf_filtro FOREIGN KEY (filtro_id) REFERENCES filtro (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `,
  recurso_cupo_periodo: `
    CREATE TABLE IF NOT EXISTS recurso_cupo_periodo (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      recurso_id INT NOT NULL,
      fecha_inicio DATE NOT NULL,
      fecha_fin DATE NOT NULL,
      cupo_total INT UNSIGNED NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      version INT UNSIGNED NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      UNIQUE KEY uq_rcp_recurso_fechas (recurso_id, fecha_inicio, fecha_fin),
      KEY idx_rcp_periodo (fecha_inicio, fecha_fin, activo),
      CONSTRAINT fk_rcp_recurso FOREIGN KEY (recurso_id) REFERENCES recurso (id) ON DELETE CASCADE,
      CONSTRAINT chk_rcp_fechas CHECK (fecha_fin >= fecha_inicio),
      CONSTRAINT chk_rcp_cupo CHECK (cupo_total > 0)
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `,
  turismo_tarifa_regla: `
    CREATE TABLE IF NOT EXISTS turismo_tarifa_regla (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      servicio_id INT NOT NULL,
      recurso_id INT NULL,
      nombre VARCHAR(120) NOT NULL,
      temporada ENUM('ALTA','BAJA','UNICA','PERSONALIZADA') NOT NULL DEFAULT 'PERSONALIZADA',
      fecha_inicio DATE NOT NULL,
      fecha_fin DATE NOT NULL,
      audiencia_departamental ENUM('TODAS','PROPIA','OTRAS') NOT NULL DEFAULT 'TODAS',
      precio DECIMAL(12,2) NOT NULL,
      porcentaje_descuento DECIMAL(5,2) NOT NULL DEFAULT 0,
      precio_por_persona TINYINT(1) NOT NULL DEFAULT 0,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      creado_por_usuario_id INT NULL,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      version INT UNSIGNED NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      KEY idx_ttr_servicio_periodo (servicio_id, activo, fecha_inicio, fecha_fin),
      KEY idx_ttr_recurso (recurso_id, activo),
      KEY idx_ttr_creador (creado_por_usuario_id),
      CONSTRAINT fk_ttr_servicio FOREIGN KEY (servicio_id) REFERENCES servicio (id) ON DELETE CASCADE,
      CONSTRAINT fk_ttr_recurso FOREIGN KEY (recurso_id) REFERENCES recurso (id) ON DELETE CASCADE,
      CONSTRAINT fk_ttr_creador FOREIGN KEY (creado_por_usuario_id) REFERENCES usuario (id) ON DELETE SET NULL,
      CONSTRAINT chk_ttr_fechas CHECK (fecha_fin >= fecha_inicio),
      CONSTRAINT chk_ttr_precio CHECK (precio >= 0),
      CONSTRAINT chk_ttr_descuento CHECK (porcentaje_descuento >= 0 AND porcentaje_descuento <= 100)
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `,
  turismo_historial: `
    CREATE TABLE IF NOT EXISTS turismo_historial (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      servicio_id INT NULL,
      recurso_id INT NULL,
      entidad_tipo VARCHAR(40) NOT NULL,
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
      KEY idx_th_servicio_fecha (servicio_id, fecha_creacion, id),
      KEY idx_th_recurso_fecha (recurso_id, fecha_creacion, id),
      KEY idx_th_entidad (entidad_tipo, entidad_id, fecha_creacion),
      KEY idx_th_usuario (usuario_id, fecha_creacion),
      CONSTRAINT fk_th_servicio FOREIGN KEY (servicio_id) REFERENCES servicio (id) ON DELETE SET NULL,
      CONSTRAINT fk_th_recurso FOREIGN KEY (recurso_id) REFERENCES recurso (id) ON DELETE SET NULL,
      CONSTRAINT fk_th_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `,
});

const INDICES_A_AGREGAR = Object.freeze([
  ["tipo_servicio", "uq_tipo_servicio_codigo", true, ["codigo"]],
  ["servicio", "uq_servicio_codigo", true, ["codigo"]],
  ["servicio", "idx_servicio_gestion", false, ["tipo_servicio_id", "estado_aprobacion", "activo", "orden"]],
  ["servicio", "idx_servicio_propietario", false, ["propietario_departamental_id", "estado_aprobacion", "activo"]],
  ["recurso", "uq_recurso_servicio_codigo", true, ["servicio_id", "codigo"]],
  ["recurso", "idx_recurso_catalogo", false, ["servicio_id", "activo", "categoria", "orden"]],
  ["filtro", "uq_filtro_codigo", true, ["codigo"]],
  ["filtro_recurso", "uq_filtro_recurso", true, ["recurso_id", "filtro_id"]],
  ["tarifa", "idx_tarifa_audiencia_regla", false, ["audiencia_departamental", "turismo_tarifa_regla_id"]],
  ["convenio_hotel", "uq_convenio_hotel_servicio", true, ["servicio_id"]],
]);

const FOREIGN_KEYS_A_AGREGAR = Object.freeze([
  ["servicio", "fk_servicio_propietario_departamental", "propietario_departamental_id", "departamental", "id", "SET NULL"],
  ["servicio", "fk_servicio_creador", "creado_por_usuario_id", "usuario", "id", "SET NULL"],
  ["tarifa", "fk_tarifa_regla_turismo", "turismo_tarifa_regla_id", "turismo_tarifa_regla", "id", "SET NULL"],
  ["convenio_hotel", "fk_convenio_hotel_servicio", "servicio_id", "servicio", "id", "SET NULL"],
]);

const TABLAS_BACKUP = Object.freeze([
  "tipo_servicio",
  "servicio",
  "servicio_regimen",
  "recurso",
  "filtro",
  "filtro_recurso",
  "tarifa",
  "imagen_servicio",
  "imagen_recurso",
  "convenio_hotel",
  "convenio_hotel_imagen",
]);

const COLUMNAS_REQUERIDAS = Object.freeze(Object.fromEntries(
  Object.entries(COLUMNAS_A_AGREGAR).map(([tabla, columnas]) => [tabla, Object.keys(columnas)])
));
const TABLAS_REQUERIDAS = Object.freeze(Object.keys(CREATE_NUEVAS_TABLAS_SQL));
function columnaNueva(tipo, nullable, defaultValue = null, extra = {}) {
  return Object.freeze({
    tipo,
    nullable: nullable ? "YES" : "NO",
    defaultValue,
    autoIncrement: Boolean(extra.autoIncrement),
    onUpdateCurrentTimestamp: Boolean(extra.onUpdateCurrentTimestamp),
  });
}

// Contrato deliberadamente explicito: evita inferir el esquema con un parser
// de DDL y permite reportar drift aun cuando CREATE TABLE IF NOT EXISTS no lo
// corregiria. Los valores reflejan information_schema.COLUMNS de MySQL 8.
const CONTRATO_COLUMNAS_NUEVAS_TABLAS = Object.freeze({
  servicio_departamental_visible: Object.freeze({
    id: columnaNueva("bigint unsigned", false, null, { autoIncrement: true }),
    servicio_id: columnaNueva("int", false),
    departamental_id: columnaNueva("int", false),
    fecha_creacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP"),
  }),
  servicio_filtro: Object.freeze({
    id: columnaNueva("bigint unsigned", false, null, { autoIncrement: true }),
    servicio_id: columnaNueva("int", false),
    filtro_id: columnaNueva("int", false),
    mostrar_en_busqueda: columnaNueva("tinyint(1)", false, "1"),
    orden: columnaNueva("int unsigned", false, "0"),
    fecha_creacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP"),
    fecha_modificacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP", { onUpdateCurrentTimestamp: true }),
  }),
  recurso_cupo_periodo: Object.freeze({
    id: columnaNueva("bigint unsigned", false, null, { autoIncrement: true }),
    recurso_id: columnaNueva("int", false),
    fecha_inicio: columnaNueva("date", false),
    fecha_fin: columnaNueva("date", false),
    cupo_total: columnaNueva("int unsigned", false),
    activo: columnaNueva("tinyint(1)", false, "1"),
    fecha_creacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP"),
    fecha_modificacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP", { onUpdateCurrentTimestamp: true }),
    version: columnaNueva("int unsigned", false, "1"),
  }),
  turismo_tarifa_regla: Object.freeze({
    id: columnaNueva("bigint unsigned", false, null, { autoIncrement: true }),
    servicio_id: columnaNueva("int", false),
    recurso_id: columnaNueva("int", true),
    nombre: columnaNueva("varchar(120)", false),
    temporada: columnaNueva("enum('ALTA','BAJA','UNICA','PERSONALIZADA')", false, "PERSONALIZADA"),
    fecha_inicio: columnaNueva("date", false),
    fecha_fin: columnaNueva("date", false),
    audiencia_departamental: columnaNueva("enum('TODAS','PROPIA','OTRAS')", false, "TODAS"),
    precio: columnaNueva("decimal(12,2)", false),
    porcentaje_descuento: columnaNueva("decimal(5,2)", false, "0"),
    precio_por_persona: columnaNueva("tinyint(1)", false, "0"),
    activo: columnaNueva("tinyint(1)", false, "1"),
    creado_por_usuario_id: columnaNueva("int", true),
    fecha_creacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP"),
    fecha_modificacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP", { onUpdateCurrentTimestamp: true }),
    version: columnaNueva("int unsigned", false, "1"),
  }),
  turismo_historial: Object.freeze({
    id: columnaNueva("bigint unsigned", false, null, { autoIncrement: true }),
    servicio_id: columnaNueva("int", true),
    recurso_id: columnaNueva("int", true),
    entidad_tipo: columnaNueva("varchar(40)", false),
    entidad_id: columnaNueva("bigint unsigned", true),
    operacion: columnaNueva("varchar(30)", false),
    resumen: columnaNueva("varchar(255)", false),
    valor_anterior: columnaNueva("json", true),
    valor_nuevo: columnaNueva("json", true),
    usuario_id: columnaNueva("int", true),
    ip_address: columnaNueva("varchar(64)", true),
    user_agent: columnaNueva("varchar(500)", true),
    fecha_creacion: columnaNueva("datetime", false, "CURRENT_TIMESTAMP"),
  }),
});
const COLUMNAS_NUEVAS_TABLAS_REQUERIDAS = Object.freeze(Object.fromEntries(
  Object.entries(CONTRATO_COLUMNAS_NUEVAS_TABLAS)
    .map(([tabla, columnas]) => [tabla, Object.freeze(Object.keys(columnas))])
));
const INDICES_NUEVAS_TABLAS_REQUERIDOS = Object.freeze([
  ["servicio_departamental_visible", "uq_sdv_servicio_departamental", true, ["servicio_id", "departamental_id"]],
  ["servicio_departamental_visible", "idx_sdv_departamental", false, ["departamental_id", "servicio_id"]],
  ["servicio_filtro", "uq_sf_servicio_filtro", true, ["servicio_id", "filtro_id"]],
  ["servicio_filtro", "idx_sf_filtro", false, ["filtro_id", "servicio_id"]],
  ["recurso_cupo_periodo", "uq_rcp_recurso_fechas", true, ["recurso_id", "fecha_inicio", "fecha_fin"]],
  ["recurso_cupo_periodo", "idx_rcp_periodo", false, ["fecha_inicio", "fecha_fin", "activo"]],
  ["turismo_tarifa_regla", "idx_ttr_servicio_periodo", false, ["servicio_id", "activo", "fecha_inicio", "fecha_fin"]],
  ["turismo_tarifa_regla", "idx_ttr_recurso", false, ["recurso_id", "activo"]],
  ["turismo_tarifa_regla", "idx_ttr_creador", false, ["creado_por_usuario_id"]],
  ["turismo_historial", "idx_th_servicio_fecha", false, ["servicio_id", "fecha_creacion", "id"]],
  ["turismo_historial", "idx_th_recurso_fecha", false, ["recurso_id", "fecha_creacion", "id"]],
  ["turismo_historial", "idx_th_entidad", false, ["entidad_tipo", "entidad_id", "fecha_creacion"]],
  ["turismo_historial", "idx_th_usuario", false, ["usuario_id", "fecha_creacion"]],
]);
const FOREIGN_KEYS_NUEVAS_TABLAS_REQUERIDAS = Object.freeze([
  ["servicio_departamental_visible", "fk_sdv_servicio", "servicio_id", "servicio", "id", "CASCADE"],
  ["servicio_departamental_visible", "fk_sdv_departamental", "departamental_id", "departamental", "id", "CASCADE"],
  ["servicio_filtro", "fk_sf_servicio", "servicio_id", "servicio", "id", "CASCADE"],
  ["servicio_filtro", "fk_sf_filtro", "filtro_id", "filtro", "id", "CASCADE"],
  ["recurso_cupo_periodo", "fk_rcp_recurso", "recurso_id", "recurso", "id", "CASCADE"],
  ["turismo_tarifa_regla", "fk_ttr_servicio", "servicio_id", "servicio", "id", "CASCADE"],
  ["turismo_tarifa_regla", "fk_ttr_recurso", "recurso_id", "recurso", "id", "CASCADE"],
  ["turismo_tarifa_regla", "fk_ttr_creador", "creado_por_usuario_id", "usuario", "id", "SET NULL"],
  ["turismo_historial", "fk_th_servicio", "servicio_id", "servicio", "id", "SET NULL"],
  ["turismo_historial", "fk_th_recurso", "recurso_id", "recurso", "id", "SET NULL"],
  ["turismo_historial", "fk_th_usuario", "usuario_id", "usuario", "id", "SET NULL"],
]);
const CHECKS_NUEVAS_TABLAS_REQUERIDOS = Object.freeze([
  ["recurso_cupo_periodo", "chk_rcp_fechas", "fecha_fin >= fecha_inicio"],
  ["recurso_cupo_periodo", "chk_rcp_cupo", "cupo_total > 0"],
  ["turismo_tarifa_regla", "chk_ttr_fechas", "fecha_fin >= fecha_inicio"],
  ["turismo_tarifa_regla", "chk_ttr_precio", "precio >= 0"],
  ["turismo_tarifa_regla", "chk_ttr_descuento", "porcentaje_descuento >= 0 AND porcentaje_descuento <= 100"],
]);
const TODOS_LOS_INDICES_REQUERIDOS = Object.freeze([
  ...INDICES_A_AGREGAR,
  ...INDICES_NUEVAS_TABLAS_REQUERIDOS,
]);
const TODAS_LAS_FOREIGN_KEYS_REQUERIDAS = Object.freeze([
  ...FOREIGN_KEYS_A_AGREGAR,
  ...FOREIGN_KEYS_NUEVAS_TABLAS_REQUERIDAS,
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

const MIGRATION_CHECKSUM = crypto.createHash("sha256").update(stableStringify({
  id: MIGRATION_ID,
  revision: MIGRATION_REVISION,
  algoritmo: "catalogo-v3-cupos-convenio-postflight-estricto",
  identidadesLegacy: IDENTIDADES_LEGACY_PERMITIDAS,
  columnas: COLUMNAS_A_AGREGAR,
  columnasAlinear: COLUMNAS_A_ALINEAR,
  tablas: CREATE_NUEVAS_TABLAS_SQL,
  indices: INDICES_A_AGREGAR,
  foreignKeys: FOREIGN_KEYS_A_AGREGAR,
  checks: CHECKS_NUEVAS_TABLAS_REQUERIDOS,
  catalogo: {
    tipos: catalogo.TIPOS_SERVICIO,
    filtros: catalogo.FILTROS,
    servicios: catalogo.SERVICIOS,
    convenios: catalogo.CONVENIOS_A_MIGRAR,
    resumen: catalogo.RESUMEN_ESPERADO,
  },
})).digest("hex");

function parsearArgumentos(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  if (apply === check) throw new Error("Indica exactamente uno de --check o --apply");
  const targetArg = argv.find((arg) => arg.startsWith("--target="));
  if (!targetArg) throw new Error("El target es obligatorio: --target=develop o --target=production");
  const target = targetArg.slice("--target=".length).trim().toLowerCase();
  if (!TARGETS.has(target)) throw new Error("--target debe ser develop o production; no se permite un target implicito o masivo");
  return {
    apply,
    checkOnly: check,
    target,
    allowProduction: argv.includes("--allow-production"),
    confirmacion: argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) || null,
    envFile: path.resolve(argv.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length)
      || path.resolve(__dirname, "..", ".env")),
  };
}

function parsearValorEnv(nombre, valor) {
  const parsed = dotenv.parse(Buffer.from(`${nombre}=${valor}`));
  return parsed[nombre] ?? "";
}

function parsearBloquesEnv(contenido) {
  const bloques = { develop: {}, production: {} };
  let bloque = null;
  for (const linea of String(contenido || "").split(/\r?\n/)) {
    if (/^\s*#\s*PRODUCCION\b/i.test(linea)) { bloque = "production"; continue; }
    if (/^\s*#\s*DEVELOP\b/i.test(linea)) { bloque = "develop"; continue; }
    if (!bloque) continue;
    const match = /^\s*(?:#\s*)?(DB_HOST|DB_USER|DB_PASSWORD|DB_DATABASE|DB_PORT|DB_SSL_MODE|DB_SSL_CA_PATH|NODE_ENV)\s*=\s*(.*)$/.exec(linea);
    if (match) bloques[bloque][match[1]] = parsearValorEnv(match[1], match[2]);
  }
  return bloques;
}

const DB_ENV_KEYS = Object.freeze([
  "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE", "DB_PORT", "DB_SSL_MODE", "DB_SSL_CA_PATH", "NODE_ENV",
]);

function seleccionarConfiguracion(opciones, contenidoEnv, processEnv = process.env) {
  const parsedActivo = dotenv.parse(Buffer.from(contenidoEnv));
  if (opciones.target === "develop") {
    const config = { ...parsearBloquesEnv(contenidoEnv).develop };
    validarConfiguracion("develop", config);
    return config;
  }
  const config = {};
  for (const key of DB_ENV_KEYS) config[key] = String(processEnv[key] || parsedActivo[key] || "").trim();
  validarConfiguracion("production", config);
  if (String(config.NODE_ENV).toLowerCase() !== "production") {
    throw new Error("Production exige NODE_ENV=production en el entorno activo");
  }
  return config;
}

function validarConfiguracion(target, config) {
  const faltantes = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE", "DB_PORT"]
    .filter((key) => !String(config?.[key] || "").trim());
  if (faltantes.length) throw new Error(`Configuracion ${target} incompleta: faltan ${faltantes.join(", ")}`);
  if (!/^\d+$/.test(String(config.DB_PORT)) || Number(config.DB_PORT) < 1 || Number(config.DB_PORT) > 65535) {
    throw new Error(`DB_PORT invalido para ${target}`);
  }
  if (target === "production") {
    if (String(config.DB_SSL_MODE).toLowerCase() !== "verify-full") {
      throw new Error("Production exige DB_SSL_MODE=verify-full");
    }
    if (!String(config.DB_SSL_CA_PATH || "").trim()) throw new Error("Production exige DB_SSL_CA_PATH");
  }
}

function validarAutorizacion(opciones) {
  if (opciones.target === "production" && !opciones.allowProduction) {
    throw new Error("Production exige --allow-production incluso en modo check");
  }
  if (opciones.apply && opciones.confirmacion !== CONFIRMACIONES[opciones.target]) {
    throw new Error(`Apply en ${opciones.target} exige --confirm=${CONFIRMACIONES[opciones.target]}`);
  }
}

function crearOpcionesConexion(config, target) {
  const mode = String(config.DB_SSL_MODE || "disabled").toLowerCase();
  if (!new Set(["disabled", "verify-ca", "verify-full"]).has(mode)) throw new Error("DB_SSL_MODE invalido");
  let ssl;
  if (mode !== "disabled") {
    const caPath = path.resolve(config.DB_SSL_CA_PATH || "");
    if (!config.DB_SSL_CA_PATH || !fs.existsSync(caPath)) throw new Error("No se encontro DB_SSL_CA_PATH");
    ssl = { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
  }
  if (target === "production" && !ssl) throw new Error("Production no puede conectarse sin TLS verificado");
  return {
    host: config.DB_HOST,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_DATABASE,
    port: Number(config.DB_PORT),
    ssl,
    timezone: "-03:00",
    dateStrings: ["DATE", "DATETIME"],
    decimalNumbers: false,
    multipleStatements: false,
  };
}

async function tablaExiste(connection, tabla) {
  const [rows] = await connection.query(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1",
    [tabla]
  );
  return rows.length > 0;
}

async function columnasTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [tabla]
  );
  return rows;
}

async function indicesTabla(connection, tabla) {
  const [rows] = await connection.query(
    "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    [tabla]
  );
  return rows;
}

async function foreignKeysTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    [tabla]
  );
  return rows;
}

async function checksTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
       FROM information_schema.TABLE_CONSTRAINTS tc
       INNER JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    [tabla]
  );
  return rows;
}

function contratoDefinicionColumna(definicion) {
  const match = /^(.+?)\s+(NOT NULL|NULL)(?:\s|$)/i.exec(String(definicion).trim());
  if (!match) throw new Error(`Definicion de columna no soportada: ${definicion}`);
  return {
    tipo: match[1].replace(/\s+/g, " ").toLowerCase(),
    nullable: match[2].toUpperCase() === "NULL" ? "YES" : "NO",
  };
}

function normalizarTipoColumna(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizarDefaultColumna(value) {
  if (value == null) return null;
  const texto = String(value).trim();
  if (/^current_timestamp(?:\(\))?$/i.test(texto)) return "CURRENT_TIMESTAMP";
  if (/^-?\d+(?:\.\d+)?$/.test(texto)) return String(Number(texto));
  return texto;
}

function analizarExtraColumna(value) {
  const original = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const autoIncrement = /(?:^|\s)auto_increment(?:\s|$)/.test(original);
  const onUpdateCurrentTimestamp = /on update current_timestamp(?:\(\))?/.test(original);
  const desconocido = original
    .replace(/(?:^|\s)default_generated(?:\s|$)/g, " ")
    .replace(/(?:^|\s)auto_increment(?:\s|$)/g, " ")
    .replace(/on update current_timestamp(?:\(\))?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { autoIncrement, onUpdateCurrentTimestamp, desconocido };
}

function evaluarContratoColumnasNuevaTabla(tabla, filasColumnas) {
  const contrato = CONTRATO_COLUMNAS_NUEVAS_TABLAS[tabla];
  if (!contrato) throw new Error(`No existe contrato de columnas para ${tabla}`);
  const actuales = new Map(filasColumnas.map((row) => [row.COLUMN_NAME, row]));
  const faltantes = Object.keys(contrato).filter((columna) => !actuales.has(columna));
  const extras = filasColumnas
    .map((row) => row.COLUMN_NAME)
    .filter((columna) => !Object.prototype.hasOwnProperty.call(contrato, columna));
  const incompatibles = [];
  for (const [columna, esperado] of Object.entries(contrato)) {
    const actual = actuales.get(columna);
    if (!actual) continue;
    const diferencias = [];
    const tipoActual = normalizarTipoColumna(actual.COLUMN_TYPE);
    const tipoEsperado = normalizarTipoColumna(esperado.tipo);
    if (tipoActual !== tipoEsperado) diferencias.push({ campo: "tipo", esperado: tipoEsperado, actual: tipoActual });
    if (actual.IS_NULLABLE !== esperado.nullable) {
      diferencias.push({ campo: "nullable", esperado: esperado.nullable, actual: actual.IS_NULLABLE });
    }
    const defaultActual = normalizarDefaultColumna(actual.COLUMN_DEFAULT);
    const defaultEsperado = normalizarDefaultColumna(esperado.defaultValue);
    if (defaultActual !== defaultEsperado) {
      diferencias.push({ campo: "default", esperado: defaultEsperado, actual: defaultActual });
    }
    const extraActual = analizarExtraColumna(actual.EXTRA);
    if (extraActual.autoIncrement !== esperado.autoIncrement) {
      diferencias.push({ campo: "auto_increment", esperado: esperado.autoIncrement, actual: extraActual.autoIncrement });
    }
    if (extraActual.onUpdateCurrentTimestamp !== esperado.onUpdateCurrentTimestamp) {
      diferencias.push({ campo: "on_update_current_timestamp", esperado: esperado.onUpdateCurrentTimestamp, actual: extraActual.onUpdateCurrentTimestamp });
    }
    if (extraActual.desconocido) {
      diferencias.push({ campo: "extra_desconocido", esperado: "", actual: extraActual.desconocido });
    }
    if (diferencias.length) incompatibles.push({ tabla, columna, diferencias });
  }
  return { faltantes, extras, incompatibles };
}

function normalizarCheck(value) {
  return String(value || "")
    .replace(/`/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function agruparIndices(rows) {
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.INDEX_NAME)) result.set(row.INDEX_NAME, { unique: Number(row.NON_UNIQUE) === 0, columns: [] });
    result.get(row.INDEX_NAME).columns.push(row.COLUMN_NAME);
  }
  return result;
}

async function reporteCheck(connection) {
  const faltanTablas = [];
  const faltanColumnas = [];
  const columnasIncompatibles = [];
  const detalleColumnasIncompatibles = [];
  const columnasExtra = [];
  for (const tabla of TABLAS_REQUERIDAS) if (!(await tablaExiste(connection, tabla))) faltanTablas.push(tabla);
  const columnasContrato = COLUMNAS_REQUERIDAS;
  for (const [tabla, columnas] of Object.entries(columnasContrato)) {
    if (!(await tablaExiste(connection, tabla))) {
      faltanColumnas.push(...columnas.map((columna) => `${tabla}.${columna}`));
      continue;
    }
    const filasColumnas = await columnasTabla(connection, tabla);
    const presentes = new Set(filasColumnas.map((row) => row.COLUMN_NAME));
    faltanColumnas.push(...columnas.filter((columna) => !presentes.has(columna)).map((columna) => `${tabla}.${columna}`));
    const definiciones = COLUMNAS_A_AGREGAR[tabla];
    if (definiciones) {
      for (const [columna, definicion] of Object.entries(definiciones)) {
        const actual = filasColumnas.find((row) => row.COLUMN_NAME === columna);
        if (!actual) continue;
        const esperado = contratoDefinicionColumna(definicion);
        if (normalizarTipoColumna(actual.COLUMN_TYPE) !== esperado.tipo || actual.IS_NULLABLE !== esperado.nullable) {
          columnasIncompatibles.push(`${tabla}.${columna}`);
        }
      }
    }
  }
  for (const [tabla, columnas] of Object.entries(COLUMNAS_NUEVAS_TABLAS_REQUERIDAS)) {
    if (!(await tablaExiste(connection, tabla))) {
      faltanColumnas.push(...columnas.map((columna) => `${tabla}.${columna}`));
      continue;
    }
    const evaluacion = evaluarContratoColumnasNuevaTabla(tabla, await columnasTabla(connection, tabla));
    faltanColumnas.push(...evaluacion.faltantes.map((columna) => `${tabla}.${columna}`));
    columnasExtra.push(...evaluacion.extras.map((columna) => `${tabla}.${columna}`));
    detalleColumnasIncompatibles.push(...evaluacion.incompatibles);
    columnasIncompatibles.push(...evaluacion.incompatibles.map(({ columna }) => `${tabla}.${columna}`));
  }
  for (const [tabla, columnas] of Object.entries(COLUMNAS_A_ALINEAR)) {
    if (!(await tablaExiste(connection, tabla))) {
      columnasIncompatibles.push(...Object.keys(columnas).map((columna) => `${tabla}.${columna}`));
      continue;
    }
    const filasColumnas = await columnasTabla(connection, tabla);
    for (const [columna, definicion] of Object.entries(columnas)) {
      const actual = filasColumnas.find((row) => row.COLUMN_NAME === columna);
      const esperado = contratoDefinicionColumna(definicion);
      if (!actual || normalizarTipoColumna(actual.COLUMN_TYPE) !== esperado.tipo || actual.IS_NULLABLE !== esperado.nullable) {
        columnasIncompatibles.push(`${tabla}.${columna}`);
      }
    }
  }
  const faltanIndices = [];
  for (const [tabla, nombre, unique, columns] of TODOS_LOS_INDICES_REQUERIDOS) {
    if (!(await tablaExiste(connection, tabla))) { faltanIndices.push(`${tabla}.${nombre}`); continue; }
    const actual = agruparIndices(await indicesTabla(connection, tabla)).get(nombre);
    if (!actual || actual.unique !== unique || actual.columns.join(",") !== columns.join(",")) faltanIndices.push(`${tabla}.${nombre}`);
  }
  const faltanForeignKeys = [];
  for (const [tabla, nombre, columna, tablaReferida, columnaReferida, reglaBorrado] of TODAS_LAS_FOREIGN_KEYS_REQUERIDAS) {
    if (!(await tablaExiste(connection, tabla))) { faltanForeignKeys.push(`${tabla}.${nombre}`); continue; }
    const actual = (await foreignKeysTabla(connection, tabla)).find((row) => row.CONSTRAINT_NAME === nombre);
    if (!actual
      || actual.COLUMN_NAME !== columna
      || actual.REFERENCED_TABLE_NAME !== tablaReferida
      || actual.REFERENCED_COLUMN_NAME !== columnaReferida
      || actual.DELETE_RULE !== reglaBorrado) {
      faltanForeignKeys.push(`${tabla}.${nombre}`);
    }
  }
  const faltanChecks = [];
  for (const [tabla, nombre, expresion] of CHECKS_NUEVAS_TABLAS_REQUERIDOS) {
    if (!(await tablaExiste(connection, tabla))) { faltanChecks.push(`${tabla}.${nombre}`); continue; }
    const actual = (await checksTabla(connection, tabla)).find((row) => row.CONSTRAINT_NAME === nombre);
    if (!actual || normalizarCheck(actual.CHECK_CLAUSE) !== normalizarCheck(expresion)) {
      faltanChecks.push(`${tabla}.${nombre}`);
    }
  }
  let ledger = null;
  if (await tablaExiste(connection, "ajb_schema_migration")) {
    const [rows] = await connection.query(
      "SELECT checksum, revision, estado, etapa, finalizada_en FROM ajb_schema_migration WHERE migration_id = ? LIMIT 1",
      [MIGRATION_ID]
    );
    ledger = rows[0] || null;
  }
  const conteos = {};
  for (const tabla of ["servicio", "recurso", "filtro", "filtro_recurso", "tarifa", "convenio_hotel"]) {
    if (await tablaExiste(connection, tabla)) {
      const [[row]] = await connection.query(`SELECT COUNT(*) AS total FROM \`${tabla}\``);
      conteos[tabla] = Number(row.total);
    }
  }
  const aplicado = !faltanTablas.length && !faltanColumnas.length && !columnasIncompatibles.length && !columnasExtra.length
    && !faltanIndices.length && !faltanForeignKeys.length && !faltanChecks.length
    && ledger?.estado === "APLICADA" && ledger?.checksum === MIGRATION_CHECKSUM;
  return {
    aplicado,
    faltanTablas,
    faltanColumnas,
    columnasIncompatibles,
    detalleColumnasIncompatibles,
    columnasExtra,
    faltanIndices,
    faltanForeignKeys,
    faltanChecks,
    ledger,
    conteos,
  };
}

function normalizarIdentidad(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es");
}

async function seleccionarTarifasLegacy(connection) {
  if (await tablaExiste(connection, "ajb_turismo_catalogo_backup")) {
    const [[backup]] = await connection.query(
      "SELECT COUNT(*) AS total FROM ajb_turismo_catalogo_backup WHERE migration_id=? AND tabla='tarifa'",
      [MIGRATION_ID]
    );
    if (Number(backup.total) > 0) {
      const [tarifas] = await connection.query(
        `SELECT ${TARIFA_COLUMNAS_LEGACY.map((column) => `t.\`${column}\``).join(", ")}
           FROM tarifa t INNER JOIN ajb_turismo_catalogo_backup b
             ON b.migration_id=? AND b.tabla='tarifa' AND CAST(b.fila_id AS UNSIGNED)=t.id
          ORDER BY t.id`,
        [MIGRATION_ID]
      );
      return tarifas;
    }
  }
  const columnas = new Set((await columnasTabla(connection, "tarifa")).map((row) => row.COLUMN_NAME));
  const filtroLegacy = columnas.has("turismo_tarifa_regla_id")
    ? " WHERE turismo_tarifa_regla_id IS NULL"
    : "";
  const [tarifas] = await connection.query(
    `SELECT ${TARIFA_COLUMNAS_LEGACY.map((column) => `\`${column}\``).join(", ")} FROM tarifa${filtroLegacy} ORDER BY id`
  );
  return tarifas;
}

async function validarPreflight(connection) {
  catalogo.validarCatalogoInicial();
  for (const tabla of ["tipo_servicio", "servicio", "recurso", "filtro", "filtro_recurso", "tarifa", "convenio_hotel", "imagen_servicio", "imagen_recurso", "departamental", "usuario"]) {
    if (!(await tablaExiste(connection, tabla))) throw new Error(`Preflight: falta la tabla legacy ${tabla}`);
  }
  const [servicios] = await connection.query("SELECT id, nombre FROM servicio WHERE id IN (1,2,3,4) ORDER BY id");
  if (servicios.length !== 4 || servicios.map((row) => Number(row.id)).join(",") !== "1,2,3,4") {
    throw new Error("Preflight: deben existir los servicios legacy 1,2,3,4");
  }
  for (const servicio of servicios) {
    const permitidos = IDENTIDADES_LEGACY_PERMITIDAS.servicios[Number(servicio.id)] || [];
    if (!permitidos.some((nombre) => normalizarIdentidad(servicio.nombre) === normalizarIdentidad(nombre))) {
      throw new Error(`Preflight: el servicio legacy ${servicio.id} no conserva la identidad esperada`);
    }
  }
  const [recursos] = await connection.query("SELECT id, servicio_id, nombre FROM recurso WHERE id IN (1,2,3) ORDER BY id");
  if (recursos.length !== 3 || recursos.map((row) => Number(row.id)).join(",") !== "1,2,3") {
    throw new Error("Preflight: deben existir los recursos legacy 1,2,3");
  }
  if (Number(recursos[0].servicio_id) !== 4 || Number(recursos[1].servicio_id) !== 3 || Number(recursos[2].servicio_id) !== 3) {
    throw new Error("Preflight: los recursos legacy 1,2,3 no conservan su relacion esperada");
  }
  for (const recurso of recursos) {
    const permitidos = IDENTIDADES_LEGACY_PERMITIDAS.recursos[Number(recurso.id)] || [];
    if (!permitidos.some((nombre) => normalizarIdentidad(recurso.nombre) === normalizarIdentidad(nombre))) {
      throw new Error(`Preflight: el recurso legacy ${recurso.id} no conserva la identidad esperada`);
    }
  }
  const [[duplicados]] = await connection.query(
    "SELECT COUNT(*) AS total FROM (SELECT recurso_id, filtro_id FROM filtro_recurso GROUP BY recurso_id, filtro_id HAVING COUNT(*) > 1) d"
  );
  if (Number(duplicados.total) !== 0) throw new Error("Preflight: filtro_recurso contiene pares duplicados");
  const tarifas = await seleccionarTarifasLegacy(connection);
  if (tarifas.length !== 181) throw new Error(`Preflight: se esperaban 181 tarifas legacy y hay ${tarifas.length}`);
  const [convenios] = await connection.query("SELECT id, nombre FROM convenio_hotel WHERE id = 1 LIMIT 1");
  if (!convenios.length || String(convenios[0].nombre).trim().toLocaleLowerCase("es") !== "hotel linz") {
    throw new Error("Preflight: no se encontro el convenio legacy Hotel Linz con id 1");
  }
  return {
    tarifas,
    tarifaChecksum: checksumFilas(tarifas),
    tarifaCount: tarifas.length,
  };
}

function normalizarParaChecksum(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(normalizarParaChecksum);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizarParaChecksum(item)]));
  }
  return value;
}

function checksumFilas(rows) {
  return crypto.createHash("sha256").update(stableStringify(normalizarParaChecksum(rows))).digest("hex");
}

async function asegurarColumna(connection, tabla, columna, definicion) {
  const presentes = new Set((await columnasTabla(connection, tabla)).map((row) => row.COLUMN_NAME));
  if (!presentes.has(columna)) await connection.query(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${columna}\` ${definicion}`);
}

async function asegurarEsquemaBase(connection) {
  for (const [tabla, columnas] of Object.entries(COLUMNAS_A_AGREGAR)) {
    for (const [columna, definicion] of Object.entries(columnas)) await asegurarColumna(connection, tabla, columna, definicion);
  }
  for (const [tabla, columnas] of Object.entries(COLUMNAS_A_ALINEAR)) {
    for (const [columna, definicion] of Object.entries(columnas)) {
      await connection.query(`ALTER TABLE \`${tabla}\` MODIFY COLUMN \`${columna}\` ${definicion}`);
    }
  }
  for (const sql of Object.values(CREATE_NUEVAS_TABLAS_SQL)) await connection.query(sql);
}

async function asegurarIndice(connection, tabla, nombre, unique, columns) {
  const grouped = agruparIndices(await indicesTabla(connection, tabla));
  const actual = grouped.get(nombre);
  if (actual) {
    if (actual.unique !== unique || actual.columns.join(",") !== columns.join(",")) {
      throw new Error(`El indice existente ${tabla}.${nombre} no coincide con el contrato`);
    }
    return;
  }
  const keyword = unique ? "UNIQUE INDEX" : "INDEX";
  await connection.query(`ALTER TABLE \`${tabla}\` ADD ${keyword} \`${nombre}\` (${columns.map((c) => `\`${c}\``).join(", ")})`);
}

async function asegurarForeignKey(connection, tabla, nombre, column, refTable, refColumn, deleteRule) {
  const existing = (await foreignKeysTabla(connection, tabla)).find((row) => row.CONSTRAINT_NAME === nombre);
  if (existing) {
    if (existing.COLUMN_NAME !== column || existing.REFERENCED_TABLE_NAME !== refTable
      || existing.REFERENCED_COLUMN_NAME !== refColumn || existing.DELETE_RULE !== deleteRule) {
      throw new Error(`La foreign key existente ${tabla}.${nombre} no coincide con el contrato`);
    }
    return;
  }
  await connection.query(
    `ALTER TABLE \`${tabla}\` ADD CONSTRAINT \`${nombre}\` FOREIGN KEY (\`${column}\`) REFERENCES \`${refTable}\` (\`${refColumn}\`) ON DELETE ${deleteRule}`
  );
}

async function asegurarCheck(connection, tabla, nombre, expresion) {
  const existente = (await checksTabla(connection, tabla)).find((row) => row.CONSTRAINT_NAME === nombre);
  if (existente) {
    if (normalizarCheck(existente.CHECK_CLAUSE) !== normalizarCheck(expresion)) {
      throw new Error(`El CHECK existente ${tabla}.${nombre} no coincide con el contrato`);
    }
    return;
  }
  await connection.query(`ALTER TABLE \`${tabla}\` ADD CONSTRAINT \`${nombre}\` CHECK (${expresion})`);
}

async function asegurarRestricciones(connection) {
  for (const item of TODOS_LOS_INDICES_REQUERIDOS) await asegurarIndice(connection, ...item);
  for (const item of TODAS_LAS_FOREIGN_KEYS_REQUERIDAS) await asegurarForeignKey(connection, ...item);
  for (const item of CHECKS_NUEVAS_TABLAS_REQUERIDOS) await asegurarCheck(connection, ...item);
}

async function registrarInicio(connection) {
  await connection.query(CREATE_MIGRATION_TABLE_SQL);
  const [rows] = await connection.query(
    "SELECT checksum, revision, estado FROM ajb_schema_migration WHERE migration_id = ? LIMIT 1",
    [MIGRATION_ID]
  );
  const esRevisionAnteriorPermitida = rows.length &&
    CHECKSUMS_ANTERIORES_PERMITIDOS.has(rows[0].checksum) &&
    Number(rows[0].revision) < MIGRATION_REVISION;
  if (rows.length && rows[0].checksum !== MIGRATION_CHECKSUM && !esRevisionAnteriorPermitida) {
    throw new Error("El ledger contiene esta migracion con otro checksum");
  }
  if (rows[0]?.estado === "APLICADA" && rows[0].checksum === MIGRATION_CHECKSUM) return "APLICADA";
  await connection.query(
    `INSERT INTO ajb_schema_migration
       (migration_id, checksum, revision, estado, etapa, detalle, trigger_definer, trigger_sql_mode)
     VALUES (?, ?, ?, 'APLICANDO', 'preflight', NULL, '', '')
     ON DUPLICATE KEY UPDATE checksum=VALUES(checksum), revision=VALUES(revision),
       estado='APLICANDO', etapa='preflight', detalle=NULL, finalizada_en=NULL`,
    [MIGRATION_ID, MIGRATION_CHECKSUM, MIGRATION_REVISION]
  );
  return "APLICANDO";
}

async function marcarLedger(connection, estado, etapa, detalle = null) {
  await connection.query(
    `UPDATE ajb_schema_migration SET estado=?, etapa=?, detalle=?,
       finalizada_en=CASE WHEN ?='APLICADA' THEN NOW() ELSE finalizada_en END
     WHERE migration_id=?`,
    [estado, etapa, detalle, estado, MIGRATION_ID]
  );
}

function claveBackup(tabla, row, index) {
  if (row.id != null) return String(row.id);
  if (tabla === "filtro_recurso") return `${row.recurso_id}:${row.filtro_id}`;
  if (tabla === "servicio_regimen") return `${row.servicio_id}:${row.regimen_id}`;
  return String(index + 1);
}

async function crearBackupsLogicos(connection) {
  await connection.query(CREATE_BACKUP_TABLE_SQL);
  let total = 0;
  for (const tabla of TABLAS_BACKUP) {
    if (!(await tablaExiste(connection, tabla))) continue;
    const [rows] = await connection.query(`SELECT * FROM \`${tabla}\` ORDER BY 1`);
    for (let index = 0; index < rows.length; index += 1) {
      const datos = JSON.stringify(normalizarParaChecksum(rows[index]));
      const checksum = crypto.createHash("sha256").update(datos).digest("hex");
      await connection.query(
        `INSERT INTO ajb_turismo_catalogo_backup (migration_id, tabla, fila_id, datos, checksum)
         VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE checksum=checksum`,
        [MIGRATION_ID, tabla, claveBackup(tabla, rows[index], index), datos, checksum]
      );
      total += 1;
    }
  }
  return total;
}

async function mapaPorCodigo(connection, tabla) {
  const [rows] = await connection.query(`SELECT id, codigo FROM \`${tabla}\` WHERE codigo IS NOT NULL`);
  return new Map(rows.map((row) => [row.codigo, Number(row.id)]));
}

async function sembrarTipos(connection) {
  for (const tipo of catalogo.TIPOS_SERVICIO) {
    if (tipo.legacyId) {
      await connection.query(
        "UPDATE tipo_servicio SET codigo=?, nombre=?, descripcion=?, activo=?, orden=? WHERE id=?",
        [tipo.codigo, tipo.nombre, tipo.descripcion, tipo.activo, tipo.orden, tipo.legacyId]
      );
    } else {
      const [rows] = await connection.query("SELECT id FROM tipo_servicio WHERE codigo=? LIMIT 1", [tipo.codigo]);
      if (rows.length) {
        await connection.query("UPDATE tipo_servicio SET nombre=?, descripcion=?, activo=?, orden=? WHERE id=?", [tipo.nombre, tipo.descripcion, tipo.activo, tipo.orden, rows[0].id]);
      } else {
        await connection.query("INSERT INTO tipo_servicio (codigo,nombre,descripcion,activo,orden) VALUES (?,?,?,?,?)", [tipo.codigo, tipo.nombre, tipo.descripcion, tipo.activo, tipo.orden]);
      }
    }
  }
  return mapaPorCodigo(connection, "tipo_servicio");
}

async function sembrarServicios(connection, tipos) {
  for (const servicio of catalogo.SERVICIOS) {
    const tipoId = tipos.get(servicio.tipoServicioCodigo);
    if (!tipoId) throw new Error(`No se encontro tipo ${servicio.tipoServicioCodigo}`);
    await connection.query(
      `UPDATE servicio SET tipo_servicio_id=?, codigo=?, nombre=?, lugar=?, rating=?, descripcion=?,
         propietario_departamental_id=NULL, creado_por_usuario_id=NULL, estado_aprobacion=?, activo=?,
         alcance_departamental=?, modelo_tarifa=?, unidad_cobro=?, permite_acompanantes=?,
         max_personas_reserva=?, etiqueta_identificador=?, condiciones=?, formulario_adhesion_url=?, orden=?
       WHERE id=?`,
      [tipoId, servicio.codigo, servicio.nombre, servicio.lugar, servicio.rating, servicio.descripcion,
        servicio.estadoAprobacion, servicio.activo, servicio.alcanceDepartamental, servicio.modeloTarifa,
        servicio.unidadCobro, servicio.permiteAcompanantes, servicio.maxPersonasReserva,
        servicio.etiquetaIdentificador, servicio.condiciones, servicio.formularioAdhesionUrl,
        servicio.orden, servicio.legacyId]
    );
  }
  return mapaPorCodigo(connection, "servicio");
}

async function sembrarFiltros(connection) {
  for (const filtro of catalogo.FILTROS) {
    const params = [filtro.codigo, filtro.nombre, filtro.tipoValor, filtro.categoria, filtro.unidad,
      filtro.ayuda, filtro.opciones == null ? null : JSON.stringify(filtro.opciones), filtro.activo, filtro.orden];
    if (filtro.legacyId) {
      await connection.query(
        "UPDATE filtro SET codigo=?, nombre=?, tipo_valor=?, categoria=?, unidad=?, ayuda=?, opciones=?, activo=?, orden=? WHERE id=?",
        [...params, filtro.legacyId]
      );
    } else {
      const [rows] = await connection.query("SELECT id FROM filtro WHERE codigo=? LIMIT 1", [filtro.codigo]);
      if (rows.length) {
        await connection.query(
          "UPDATE filtro SET nombre=?, tipo_valor=?, categoria=?, unidad=?, ayuda=?, opciones=?, activo=?, orden=? WHERE id=?",
          [filtro.nombre, filtro.tipoValor, filtro.categoria, filtro.unidad, filtro.ayuda,
            filtro.opciones == null ? null : JSON.stringify(filtro.opciones), filtro.activo, filtro.orden, rows[0].id]
        );
      } else {
        await connection.query(
          "INSERT INTO filtro (codigo,nombre,tipo_valor,categoria,unidad,ayuda,opciones,activo,orden) VALUES (?,?,?,?,?,?,?,?,?)",
          params
        );
      }
    }
  }
  return mapaPorCodigo(connection, "filtro");
}

function filaFiltroTipado(definicion, valor) {
  if (definicion.tipoValor === "NUMERO") {
    return { cantidad: valor, habilitado: "Y", valorNumero: valor, valorBooleano: null, valorTexto: null };
  }
  if (definicion.tipoValor === "BOOLEANO") {
    return { cantidad: 0, habilitado: valor ? "Y" : "N", valorNumero: null, valorBooleano: valor ? 1 : 0, valorTexto: null };
  }
  return { cantidad: 0, habilitado: "Y", valorNumero: null, valorBooleano: null, valorTexto: String(valor) };
}

async function asegurarImagenSiFalta(connection, tabla, fk, id, archivo) {
  const [[row]] = await connection.query(`SELECT COUNT(*) AS total FROM \`${tabla}\` WHERE \`${fk}\`=?`, [id]);
  if (Number(row.total) === 0) await connection.query(`INSERT INTO \`${tabla}\` (\`${fk}\`, archivo) VALUES (?, ?)`, [id, archivo]);
}

async function sembrarRecursosYFiltros(connection, servicios, filtros) {
  const filtrosDef = new Map(catalogo.FILTROS.map((filtro) => [filtro.codigo, filtro]));
  const recursosPorClave = new Map();
  for (const servicio of catalogo.SERVICIOS) {
    const servicioId = servicios.get(servicio.codigo);
    if (!servicioId) throw new Error(`No se encontro servicio ${servicio.codigo}`);
    await asegurarImagenSiFalta(connection, "imagen_servicio", "servicio_id", servicioId, servicio.imagenMuestra);
    // El manifiesto es la fuente de verdad para los filtros visibles de los
    // servicios iniciales. Evita conservar asociaciones obsoletas al subir de
    // revision sin afectar filtros de servicios creados por usuarios.
    await connection.query("DELETE FROM servicio_filtro WHERE servicio_id=?", [servicioId]);
    const filtrosServicio = new Set();
    for (const item of servicio.recursos) {
      let recursoId;
      if (item.legacyId) {
        recursoId = item.legacyId;
        await connection.query(
          `UPDATE recurso SET servicio_id=?, codigo=?, categoria=?, nombre=?, descripcion=?, activo=?, orden=?,
             cupo_maximo=?, es_recurso_principal=? WHERE id=?`,
          [servicioId, item.codigo, item.categoria, item.nombre, item.descripcion, item.activo,
            item.orden, item.cupoMaximo, item.esRecursoPrincipal, recursoId]
        );
      } else {
        const [existentes] = await connection.query(
          "SELECT id FROM recurso WHERE servicio_id=? AND codigo=? LIMIT 1",
          [servicioId, item.codigo]
        );
        if (existentes.length) {
          recursoId = Number(existentes[0].id);
          await connection.query(
            `UPDATE recurso SET categoria=?, nombre=?, descripcion=?, activo=?, orden=?, cupo_maximo=?,
               es_recurso_principal=? WHERE id=?`,
            [item.categoria, item.nombre, item.descripcion, item.activo, item.orden,
              item.cupoMaximo, item.esRecursoPrincipal, recursoId]
          );
        } else {
          const [insert] = await connection.query(
            `INSERT INTO recurso
               (servicio_id,codigo,categoria,nombre,descripcion,activo,orden,cupo_maximo,es_recurso_principal)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [servicioId, item.codigo, item.categoria, item.nombre, item.descripcion, item.activo,
              item.orden, item.cupoMaximo, item.esRecursoPrincipal]
          );
          recursoId = Number(insert.insertId);
        }
      }
      recursosPorClave.set(`${servicio.codigo}:${item.codigo}`, recursoId);
      await asegurarImagenSiFalta(connection, "imagen_recurso", "recurso_id", recursoId, catalogo.IMAGEN_MUESTRA_RECURSO);
      await connection.query("DELETE FROM filtro_recurso WHERE recurso_id=?", [recursoId]);
      for (const [filtroCodigo, valor] of Object.entries(item.valores)) {
        const filtroId = filtros.get(filtroCodigo);
        const definicion = filtrosDef.get(filtroCodigo);
        if (!filtroId || !definicion) throw new Error(`Filtro ${filtroCodigo} sin definicion`);
        const typed = filaFiltroTipado(definicion, valor);
        await connection.query(
          `INSERT INTO filtro_recurso
             (recurso_id,filtro_id,cantidad,habilitado,valor_numero,valor_booleano,valor_texto)
           VALUES (?,?,?,?,?,?,?)`,
          [recursoId, filtroId, typed.cantidad, typed.habilitado, typed.valorNumero, typed.valorBooleano, typed.valorTexto]
        );
        filtrosServicio.add(filtroCodigo);
      }
    }
    for (const filtroCodigo of filtrosServicio) {
      const filtroId = filtros.get(filtroCodigo);
      const definicion = filtrosDef.get(filtroCodigo);
      await connection.query(
        `INSERT INTO servicio_filtro (servicio_id,filtro_id,mostrar_en_busqueda,orden)
         VALUES (?,?,1,?) ON DUPLICATE KEY UPDATE mostrar_en_busqueda=1, orden=VALUES(orden)`,
        [servicioId, filtroId, definicion.orden]
      );
    }
  }
  return recursosPorClave;
}

async function migrarCuposCampingLegacy(connection, recursos) {
  const recursoId = recursos.get("MIRAMAR_CAMPING:CAMP-PARCELA");
  if (!recursoId) throw new Error("No se encontro el recurso principal de Camping para migrar cupos");
  const [[origen]] = await connection.query(
    `SELECT COUNT(*) AS periodos
       FROM (
         SELECT fecha_inicio, fecha_fin
           FROM tarifa
          WHERE recurso_id = ? AND parcelas_disponibles IS NOT NULL AND parcelas_disponibles > 0
          GROUP BY fecha_inicio, fecha_fin
       ) periodos`,
    [recursoId]
  );
  if (Number(origen.periodos) < 1) {
    throw new Error("No hay cupos legacy positivos de Camping para materializar");
  }
  await connection.query("DELETE FROM recurso_cupo_periodo WHERE recurso_id = ?", [recursoId]);
  await connection.query(
    `INSERT INTO recurso_cupo_periodo
       (recurso_id, fecha_inicio, fecha_fin, cupo_total, activo)
     SELECT recurso_id, fecha_inicio, fecha_fin, MIN(parcelas_disponibles), 1
       FROM tarifa
      WHERE recurso_id = ? AND parcelas_disponibles IS NOT NULL AND parcelas_disponibles > 0
      GROUP BY recurso_id, fecha_inicio, fecha_fin
     ON DUPLICATE KEY UPDATE cupo_total = VALUES(cupo_total), activo = 1`,
    [recursoId]
  );
}

async function migrarConvenios(connection, tipos) {
  for (const convenioManifest of catalogo.CONVENIOS_A_MIGRAR) {
    const [rows] = await connection.query("SELECT * FROM convenio_hotel WHERE id=? LIMIT 1", [convenioManifest.legacyConvenioId]);
    if (!rows.length) throw new Error(`No se encontro convenio ${convenioManifest.legacyConvenioId}`);
    const convenio = rows[0];
    const tipoId = tipos.get(convenioManifest.tipoServicioCodigo);
    let servicioId;
    const [servicios] = await connection.query("SELECT id FROM servicio WHERE codigo=? LIMIT 1", [convenioManifest.codigoServicio]);
    if (servicios.length) {
      servicioId = Number(servicios[0].id);
      await connection.query(
        `UPDATE servicio SET tipo_servicio_id=?, nombre=?, lugar=?, rating=?, descripcion=?, estado_aprobacion=?, activo=?,
           alcance_departamental=?, modelo_tarifa=?, unidad_cobro=?, permite_acompanantes=?, etiqueta_identificador=?, orden=? WHERE id=?`,
        [tipoId, convenio.nombre, convenio.ciudad || convenio.localidad || convenio.lugar || "", convenio.rating || null,
          convenio.descripcion || convenio.detalle || null, convenioManifest.estadoAprobacion,
          convenio.activo == null ? 1 : convenio.activo, convenioManifest.alcanceDepartamental,
          convenioManifest.modeloTarifa, convenioManifest.unidadCobro, convenioManifest.permiteAcompanantes,
          convenioManifest.etiquetaIdentificador, convenioManifest.orden, servicioId]
      );
    } else {
      const [insert] = await connection.query(
        `INSERT INTO servicio
           (tipo_servicio_id,codigo,nombre,lugar,rating,descripcion,estado_aprobacion,activo,alcance_departamental,
            modelo_tarifa,unidad_cobro,permite_acompanantes,etiqueta_identificador,orden)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tipoId, convenioManifest.codigoServicio, convenio.nombre, convenio.ciudad || convenio.localidad || convenio.lugar || "",
          convenio.rating || null, convenio.descripcion || convenio.detalle || null,
          convenioManifest.estadoAprobacion, convenio.activo == null ? 1 : convenio.activo,
          convenioManifest.alcanceDepartamental, convenioManifest.modeloTarifa,
          convenioManifest.unidadCobro, convenioManifest.permiteAcompanantes,
          convenioManifest.etiquetaIdentificador, convenioManifest.orden]
      );
      servicioId = Number(insert.insertId);
    }
    await connection.query("UPDATE convenio_hotel SET servicio_id=? WHERE id=?", [servicioId, convenioManifest.legacyConvenioId]);
    if (await tablaExiste(connection, "convenio_hotel_imagen")) {
      const [imagenes] = await connection.query("SELECT archivo FROM convenio_hotel_imagen WHERE convenio_hotel_id=?", [convenioManifest.legacyConvenioId]);
      for (const imagen of imagenes) {
        const [[existe]] = await connection.query("SELECT COUNT(*) AS total FROM imagen_servicio WHERE servicio_id=? AND archivo=?", [servicioId, imagen.archivo]);
        if (Number(existe.total) === 0) await connection.query("INSERT INTO imagen_servicio (servicio_id,archivo) VALUES (?,?)", [servicioId, imagen.archivo]);
      }
    }
    await asegurarImagenSiFalta(connection, "imagen_servicio", "servicio_id", servicioId, catalogo.IMAGEN_MUESTRA_SERVICIO);
  }
}

async function registrarHistorialSeed(connection, servicios, recursos) {
  // Una reanudacion posterior a un fallo entre COMMIT y postflight reemplaza
  // solamente las entradas tecnicas de esta migracion; no duplica ni toca el
  // historial creado luego por usuarios.
  await connection.query(
    `DELETE FROM turismo_historial
      WHERE operacion='MIGRATE'
        AND JSON_UNQUOTE(JSON_EXTRACT(valor_nuevo, '$.migration_id'))=?`,
    [MIGRATION_ID]
  );
  for (const servicio of catalogo.SERVICIOS) {
    const servicioId = servicios.get(servicio.codigo);
    await connection.query(
      `INSERT INTO turismo_historial
         (servicio_id,entidad_tipo,entidad_id,operacion,resumen,valor_nuevo)
       VALUES (?,'SERVICIO',?,'MIGRATE',?,?)`,
      [servicioId, servicioId, `Catalogo inicial migrado: ${servicio.nombre}`,
        JSON.stringify({ migration_id: MIGRATION_ID, codigo: servicio.codigo })]
    );
    for (const item of servicio.recursos) {
      const recursoId = recursos.get(`${servicio.codigo}:${item.codigo}`);
      await connection.query(
        `INSERT INTO turismo_historial
           (servicio_id,recurso_id,entidad_tipo,entidad_id,operacion,resumen,valor_nuevo)
         VALUES (?,?,'RECURSO',?,'MIGRATE',?,?)`,
        [servicioId, recursoId, recursoId, `Recurso inicial migrado: ${item.nombre}`,
          JSON.stringify({ migration_id: MIGRATION_ID, codigo: item.codigo, activo: item.activo, valores: item.valores })]
      );
    }
  }
  for (const convenio of catalogo.CONVENIOS_A_MIGRAR) {
    const [rows] = await connection.query(
      `SELECT s.id, s.nombre FROM convenio_hotel ch
        INNER JOIN servicio s ON s.id=ch.servicio_id
        WHERE ch.id=? AND s.codigo=? LIMIT 1`,
      [convenio.legacyConvenioId, convenio.codigoServicio]
    );
    if (!rows.length) throw new Error(`No se pudo auditar el convenio ${convenio.codigoServicio}`);
    await connection.query(
      `INSERT INTO turismo_historial
         (servicio_id,entidad_tipo,entidad_id,operacion,resumen,valor_nuevo)
       VALUES (?,'SERVICIO',?,'MIGRATE',?,?)`,
      [rows[0].id, rows[0].id, `Convenio migrado al catalogo: ${rows[0].nombre}`,
        JSON.stringify({ migration_id: MIGRATION_ID, codigo: convenio.codigoServicio, convenio_hotel_id: convenio.legacyConvenioId })]
    );
  }
}

async function sembrarCatalogo(connection) {
  const tipos = await sembrarTipos(connection);
  const servicios = await sembrarServicios(connection, tipos);
  const filtros = await sembrarFiltros(connection);
  const recursos = await sembrarRecursosYFiltros(connection, servicios, filtros);
  await migrarCuposCampingLegacy(connection, recursos);
  await migrarConvenios(connection, tipos);
  await registrarHistorialSeed(connection, servicios, recursos);
}

function normalizarOpcionesFiltro(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return { json_invalido: value };
  }
}

function compararTextoOrdenable(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

function erroresDefinicionesIniciales({ tiposRows = [], filtrosRows = [], asociacionesRows = [] }) {
  const errores = [];
  const codigosTipos = new Set(catalogo.TIPOS_SERVICIO.map((tipo) => tipo.codigo));
  const tiposAcotados = tiposRows.filter((row) => codigosTipos.has(row.codigo));
  if (tiposAcotados.length !== catalogo.TIPOS_SERVICIO.length) {
    errores.push("El conjunto de tipos de servicio iniciales no coincide con el manifiesto");
  }
  const tiposPorCodigo = new Map(tiposAcotados.map((row) => [row.codigo, row]));
  for (const tipo of catalogo.TIPOS_SERVICIO) {
    const row = tiposPorCodigo.get(tipo.codigo);
    if (!row) {
      errores.push(`Falta tipo de servicio inicial ${tipo.codigo}`);
      continue;
    }
    const esperado = {
      ...(tipo.legacyId == null ? {} : { id: Number(tipo.legacyId) }),
      codigo: tipo.codigo,
      nombre: tipo.nombre,
      descripcion: tipo.descripcion,
      activo: Number(tipo.activo),
      orden: Number(tipo.orden),
    };
    const actual = {
      ...(tipo.legacyId == null ? {} : { id: Number(row.id) }),
      codigo: row.codigo,
      nombre: row.nombre,
      descripcion: row.descripcion,
      activo: Number(row.activo),
      orden: Number(row.orden),
    };
    if (stableStringify(actual) !== stableStringify(esperado)) {
      errores.push(`Tipo de servicio ${tipo.codigo} no coincide con el manifiesto`);
    }
  }

  const codigosFiltros = new Set(catalogo.FILTROS.map((filtro) => filtro.codigo));
  const filtrosAcotados = filtrosRows.filter((row) => codigosFiltros.has(row.codigo));
  if (filtrosAcotados.length !== catalogo.FILTROS.length) {
    errores.push("El conjunto de filtros iniciales no coincide con el manifiesto");
  }
  const filtrosPorCodigo = new Map(filtrosAcotados.map((row) => [row.codigo, row]));
  for (const filtro of catalogo.FILTROS) {
    const row = filtrosPorCodigo.get(filtro.codigo);
    if (!row) {
      errores.push(`Falta filtro inicial ${filtro.codigo}`);
      continue;
    }
    const esperado = {
      ...(filtro.legacyId == null ? {} : { id: Number(filtro.legacyId) }),
      codigo: filtro.codigo,
      nombre: filtro.nombre,
      tipo_valor: filtro.tipoValor,
      categoria: filtro.categoria,
      unidad: filtro.unidad,
      ayuda: filtro.ayuda,
      opciones: filtro.opciones,
      activo: Number(filtro.activo),
      orden: Number(filtro.orden),
    };
    const actual = {
      ...(filtro.legacyId == null ? {} : { id: Number(row.id) }),
      codigo: row.codigo,
      nombre: row.nombre,
      tipo_valor: row.tipo_valor,
      categoria: row.categoria,
      unidad: row.unidad,
      ayuda: row.ayuda,
      opciones: normalizarOpcionesFiltro(row.opciones),
      activo: Number(row.activo),
      orden: Number(row.orden),
    };
    if (stableStringify(actual) !== stableStringify(esperado)) {
      errores.push(`Filtro ${filtro.codigo} no coincide con el manifiesto`);
    }
  }

  const codigosServicios = new Set(catalogo.SERVICIOS.map((servicio) => servicio.codigo));
  const asociacionesAcotadas = asociacionesRows.filter((row) => codigosServicios.has(row.servicio_codigo));
  for (const servicio of catalogo.SERVICIOS) {
    const codigosEsperados = new Set();
    for (const recurso of servicio.recursos) {
      for (const codigo of Object.keys(recurso.valores)) codigosEsperados.add(codigo);
    }
    const esperado = [...codigosEsperados]
      .map((codigo) => ({
        servicio_codigo: servicio.codigo,
        filtro_codigo: codigo,
        mostrar_en_busqueda: 1,
        orden: Number(catalogo.FILTROS.find((filtro) => filtro.codigo === codigo)?.orden),
      }))
      .sort((a, b) => compararTextoOrdenable(a.filtro_codigo, b.filtro_codigo));
    const actual = asociacionesAcotadas
      .filter((row) => row.servicio_codigo === servicio.codigo)
      .map((row) => ({
        servicio_codigo: row.servicio_codigo,
        filtro_codigo: row.filtro_codigo,
        mostrar_en_busqueda: Number(row.mostrar_en_busqueda),
        orden: Number(row.orden),
      }))
      .sort((a, b) => compararTextoOrdenable(a.filtro_codigo, b.filtro_codigo));
    if (stableStringify(actual) !== stableStringify(esperado)) {
      errores.push(`Filtros visibles de ${servicio.codigo} no coinciden con el manifiesto`);
    }
  }
  return errores;
}

async function verificarPostflight(connection, snapshotTarifa = null) {
  const errores = [];
  const codigosTipos = catalogo.TIPOS_SERVICIO.map((tipo) => tipo.codigo);
  const codigosFiltros = catalogo.FILTROS.map((filtro) => filtro.codigo);
  const codigosServicios = catalogo.SERVICIOS.map((servicio) => servicio.codigo);
  const [tiposIniciales] = await connection.query(
    `SELECT id,codigo,nombre,descripcion,activo,orden
       FROM tipo_servicio WHERE codigo IN (?) ORDER BY codigo`,
    [codigosTipos]
  );
  const [filtrosIniciales] = await connection.query(
    `SELECT id,codigo,nombre,tipo_valor,categoria,unidad,ayuda,opciones,activo,orden
       FROM filtro WHERE codigo IN (?) ORDER BY codigo`,
    [codigosFiltros]
  );
  const [asociacionesIniciales] = await connection.query(
    `SELECT s.codigo AS servicio_codigo,f.codigo AS filtro_codigo,
            sf.mostrar_en_busqueda,sf.orden
       FROM servicio_filtro sf
       INNER JOIN servicio s ON s.id=sf.servicio_id
       INNER JOIN filtro f ON f.id=sf.filtro_id
      WHERE s.codigo IN (?)
      ORDER BY s.codigo,f.codigo`,
    [codigosServicios]
  );
  errores.push(...erroresDefinicionesIniciales({
    tiposRows: tiposIniciales,
    filtrosRows: filtrosIniciales,
    asociacionesRows: asociacionesIniciales,
  }));
  const [servicios] = await connection.query(
    `SELECT s.id,s.codigo,s.nombre,s.lugar,s.rating,s.descripcion,s.propietario_departamental_id,
            s.creado_por_usuario_id,s.estado_aprobacion,s.activo,s.alcance_departamental,
            s.modelo_tarifa,s.unidad_cobro,s.permite_acompanantes,s.max_personas_reserva,
            s.etiqueta_identificador,s.condiciones,s.formulario_adhesion_url,s.orden,
            ts.codigo AS tipo_codigo
       FROM servicio s INNER JOIN tipo_servicio ts ON ts.id=s.tipo_servicio_id
      WHERE s.codigo IN (?)`,
    [codigosServicios]
  );
  const serviceByCode = new Map(servicios.map((row) => [row.codigo, row]));
  for (const servicio of catalogo.SERVICIOS) {
    const dbServicio = serviceByCode.get(servicio.codigo);
    if (!dbServicio) { errores.push(`Falta servicio ${servicio.codigo}`); continue; }
    const servicioEsperado = {
      id: servicio.legacyId,
      tipo_codigo: servicio.tipoServicioCodigo,
      nombre: servicio.nombre,
      lugar: servicio.lugar,
      rating: servicio.rating,
      descripcion: servicio.descripcion,
      propietario_departamental_id: null,
      creado_por_usuario_id: null,
      estado_aprobacion: servicio.estadoAprobacion,
      activo: servicio.activo,
      alcance_departamental: servicio.alcanceDepartamental,
      modelo_tarifa: servicio.modeloTarifa,
      unidad_cobro: servicio.unidadCobro,
      permite_acompanantes: servicio.permiteAcompanantes,
      max_personas_reserva: servicio.maxPersonasReserva,
      etiqueta_identificador: servicio.etiquetaIdentificador,
      condiciones: servicio.condiciones,
      formulario_adhesion_url: servicio.formularioAdhesionUrl,
      orden: servicio.orden,
    };
    const servicioActual = {
      id: Number(dbServicio.id),
      tipo_codigo: dbServicio.tipo_codigo,
      nombre: dbServicio.nombre,
      lugar: dbServicio.lugar,
      rating: dbServicio.rating == null ? null : Number(dbServicio.rating),
      descripcion: dbServicio.descripcion,
      propietario_departamental_id: dbServicio.propietario_departamental_id == null ? null : Number(dbServicio.propietario_departamental_id),
      creado_por_usuario_id: dbServicio.creado_por_usuario_id == null ? null : Number(dbServicio.creado_por_usuario_id),
      estado_aprobacion: dbServicio.estado_aprobacion,
      activo: Number(dbServicio.activo),
      alcance_departamental: dbServicio.alcance_departamental,
      modelo_tarifa: dbServicio.modelo_tarifa,
      unidad_cobro: dbServicio.unidad_cobro,
      permite_acompanantes: Number(dbServicio.permite_acompanantes),
      max_personas_reserva: dbServicio.max_personas_reserva == null ? null : Number(dbServicio.max_personas_reserva),
      etiqueta_identificador: dbServicio.etiqueta_identificador,
      condiciones: dbServicio.condiciones,
      formulario_adhesion_url: dbServicio.formulario_adhesion_url,
      orden: Number(dbServicio.orden),
    };
    if (stableStringify(servicioActual) !== stableStringify(servicioEsperado)) {
      errores.push(`${servicio.codigo} no coincide con el manifiesto`);
    }
    const [[counts]] = await connection.query(
      "SELECT COUNT(*) AS total, COALESCE(SUM(activo=1),0) AS activos, COALESCE(SUM(activo=0),0) AS inactivos FROM recurso WHERE servicio_id=? AND codigo IS NOT NULL",
      [dbServicio.id]
    );
    const expected = catalogo.RESUMEN_ESPERADO.porServicio[servicio.codigo];
    if (Number(counts.total) !== expected.total || Number(counts.activos) !== expected.activos || Number(counts.inactivos) !== expected.inactivos) {
      errores.push(`Conteos invalidos para ${servicio.codigo}`);
    }
    const [[imagenesServicio]] = await connection.query(
      "SELECT COUNT(*) AS total FROM imagen_servicio WHERE servicio_id=?",
      [dbServicio.id]
    );
    if (Number(imagenesServicio.total) < 1) errores.push(`${servicio.codigo} no tiene imagen de muestra`);
    for (const item of servicio.recursos) {
      const [recursos] = await connection.query(
        `SELECT id,nombre,categoria,descripcion,activo,orden,cupo_maximo,es_recurso_principal
           FROM recurso WHERE servicio_id=? AND codigo=? LIMIT 1`,
        [dbServicio.id, item.codigo]
      );
      const recurso = recursos[0];
      if (!recurso
         || recurso.nombre !== item.nombre
         || recurso.categoria !== item.categoria
        || recurso.descripcion !== item.descripcion
        || Number(recurso.activo) !== Number(item.activo)
        || Number(recurso.orden) !== Number(item.orden)
        || (recurso.cupo_maximo == null ? null : Number(recurso.cupo_maximo)) !== item.cupoMaximo
        || Number(recurso.es_recurso_principal) !== Number(item.esRecursoPrincipal)) {
        errores.push(`Recurso ${servicio.codigo}/${item.codigo} no coincide con el manifiesto`);
        continue;
      }
      const [[imagenesRecurso]] = await connection.query(
        "SELECT COUNT(*) AS total FROM imagen_recurso WHERE recurso_id=?",
        [recurso.id]
      );
      if (Number(imagenesRecurso.total) < 1) errores.push(`${item.codigo} no tiene imagen de muestra`);
      const [valores] = await connection.query(
        `SELECT f.codigo,f.tipo_valor,fr.valor_numero,fr.valor_booleano,fr.valor_texto
           FROM filtro_recurso fr INNER JOIN filtro f ON f.id=fr.filtro_id
          WHERE fr.recurso_id=? ORDER BY f.codigo`,
        [recurso.id]
      );
      const actuales = Object.fromEntries(valores.map((valor) => {
        let normalizado;
        if (valor.tipo_valor === "NUMERO") normalizado = Number(valor.valor_numero);
        else if (valor.tipo_valor === "BOOLEANO") normalizado = Number(valor.valor_booleano) === 1;
        else normalizado = String(valor.valor_texto);
        return [valor.codigo, normalizado];
      }));
      if (stableStringify(actuales) !== stableStringify(item.valores)) {
        errores.push(`Caracteristicas de ${item.codigo} no coinciden con el manifiesto`);
      }
    }
  }
  const [legacy] = await connection.query("SELECT id,codigo,servicio_id FROM recurso WHERE id IN (1,2,3) ORDER BY id");
  if (legacy.map((row) => `${row.id}:${row.codigo}:${row.servicio_id}`).join("|")
    !== "1:CAMP-PARCELA:4|2:MIR-CAB-012-NUEVA:3|3:MIR-CAB-011-NUEVA:3") {
    errores.push("Los recursos legacy 1,2,3 no quedaron preservados");
  }
  const [[camping]] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM recurso WHERE id=1 AND servicio_id=4 AND activo=1 AND es_recurso_principal=1) AS principal,
        (SELECT COUNT(*) FROM recurso_cupo_periodo WHERE recurso_id=1 AND activo=1) AS cupos_materializados`
  );
  if (Number(camping.principal) !== 1) errores.push("Camping no conserva una unica Parcela principal activa");
  const [cuposLegacy] = await connection.query(
    `SELECT DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS fecha_fin,
            MIN(parcelas_disponibles) AS cupo_total, 1 AS activo
       FROM tarifa
      WHERE recurso_id=1 AND parcelas_disponibles IS NOT NULL AND parcelas_disponibles > 0
      GROUP BY fecha_inicio,fecha_fin ORDER BY fecha_inicio,fecha_fin`
  );
  const [cuposActuales] = await connection.query(
    `SELECT DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS fecha_fin,
            cupo_total,activo
       FROM recurso_cupo_periodo WHERE recurso_id=1 ORDER BY fecha_inicio,fecha_fin`
  );
  const normalizarCupos = (rows) => rows.map((row) => ({
    fecha_inicio: row.fecha_inicio,
    fecha_fin: row.fecha_fin,
    cupo_total: Number(row.cupo_total),
    activo: Number(row.activo),
  }));
  if (Number(camping.cupos_materializados) < 1
    || stableStringify(normalizarCupos(cuposActuales)) !== stableStringify(normalizarCupos(cuposLegacy))) {
    errores.push("Los cupos legacy de Camping no quedaron materializados");
  }
  const [[global]] = await connection.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(r.activo=1),0) AS activos, COALESCE(SUM(r.activo=0),0) AS inactivos
       FROM recurso r INNER JOIN servicio s ON s.id=r.servicio_id WHERE s.codigo IN (?)`,
    [catalogo.SERVICIOS.map((servicio) => servicio.codigo)]
  );
  if (Number(global.total) !== catalogo.RESUMEN_ESPERADO.recursosIncluyendoCamping
    || Number(global.activos) !== catalogo.RESUMEN_ESPERADO.recursosActivosIncluyendoCamping
    || Number(global.inactivos) !== catalogo.RESUMEN_ESPERADO.recursosInactivosIncluyendoCamping) {
    errores.push("El total global de recursos no coincide con 59 activos y 11 inactivos");
  }
  const [convenios] = await connection.query(
    `SELECT s.id,s.estado_aprobacion,s.activo,s.alcance_departamental,s.modelo_tarifa,
            s.unidad_cobro,s.permite_acompanantes,s.etiqueta_identificador,s.orden,
            (SELECT COUNT(*) FROM imagen_servicio i WHERE i.servicio_id=s.id) AS imagenes
       FROM convenio_hotel ch INNER JOIN servicio s ON s.id=ch.servicio_id
      INNER JOIN tipo_servicio ts ON ts.id=s.tipo_servicio_id
      WHERE ch.id=1 AND s.codigo='CONVENIO_HOTEL_LINZ' AND ts.codigo='CONVENIO_HOTELERO'`
  );
  const convenioManifest = catalogo.CONVENIOS_A_MIGRAR.find((item) => item.legacyConvenioId === 1);
  const convenio = convenios[0];
  if (!convenio
    || convenio.estado_aprobacion !== convenioManifest.estadoAprobacion
    || convenio.alcance_departamental !== convenioManifest.alcanceDepartamental
    || convenio.modelo_tarifa !== convenioManifest.modeloTarifa
    || convenio.unidad_cobro !== convenioManifest.unidadCobro
    || Number(convenio.permite_acompanantes) !== Number(convenioManifest.permiteAcompanantes)
    || convenio.etiqueta_identificador !== convenioManifest.etiquetaIdentificador
    || Number(convenio.orden) !== Number(convenioManifest.orden)
    || Number(convenio.imagenes) < 1) {
    errores.push("Hotel Linz no coincide con el manifiesto de convenio hotelero");
  }
  if (snapshotTarifa) {
    const tarifas = await seleccionarTarifasLegacy(connection);
    if (tarifas.length !== snapshotTarifa.tarifaCount || checksumFilas(tarifas) !== snapshotTarifa.tarifaChecksum) {
      errores.push("Las tarifas legacy fueron alteradas; se aborta la migracion");
    }
  }
  const check = await reporteCheck(connection);
  if (check.faltanTablas.length || check.faltanColumnas.length || check.columnasIncompatibles.length
    || check.columnasExtra.length || check.faltanIndices.length || check.faltanForeignKeys.length || check.faltanChecks.length) {
    errores.push("El esquema final esta incompleto");
  }
  if (errores.length) throw new Error(`Postflight: ${errores.join("; ")}`);
  return {
    recursos: Number(global.total),
    activos: Number(global.activos),
    inactivos: Number(global.inactivos),
    tarifas: snapshotTarifa?.tarifaCount ?? null,
  };
}

async function ejecutarApply(connection) {
  const [locks] = await connection.query("SELECT GET_LOCK(?, 30) AS adquirido", [MIGRATION_LOCK]);
  if (Number(locks[0]?.adquirido) !== 1) throw new Error("No se pudo tomar GET_LOCK para la migracion");
  let ledgerIniciado = false;
  try {
    const estado = await registrarInicio(connection);
    ledgerIniciado = true;
    if (estado === "APLICADA") {
      const snapshot = await validarPreflight(connection);
      await verificarPostflight(connection, snapshot);
      return { yaAplicada: true };
    }
    const snapshot = await validarPreflight(connection);
    const backups = await crearBackupsLogicos(connection);
    await marcarLedger(connection, "APLICANDO", "ddl", `backup_logico_filas=${backups}`);
    await asegurarEsquemaBase(connection);
    await marcarLedger(connection, "APLICANDO", "seed");
    await connection.beginTransaction();
    try {
      await sembrarCatalogo(connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    await marcarLedger(connection, "APLICANDO", "restricciones");
    await asegurarRestricciones(connection);
    const result = await verificarPostflight(connection, snapshot);
    await marcarLedger(connection, "APLICADA", "postflight", JSON.stringify(result));
    return { yaAplicada: false, backups, ...result };
  } catch (error) {
    if (ledgerIniciado) {
      try { await marcarLedger(connection, "FALLIDA", "error", String(error.message || error).slice(0, 2000)); } catch (_) { /* best effort */ }
    }
    throw error;
  } finally {
    try { await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]); } catch (_) { /* cerrar tambien libera */ }
  }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  validarAutorizacion(opciones);
  if (!fs.existsSync(opciones.envFile)) throw new Error("No se encontro el archivo .env indicado");
  const contenidoEnv = fs.readFileSync(opciones.envFile, "utf8");
  const config = seleccionarConfiguracion(opciones, contenidoEnv);
  const connection = await mysql.createConnection(crearOpcionesConexion(config, opciones.target));
  try {
    const identificacion = await connection.query("SELECT DATABASE() AS base, @@hostname AS servidor").then(([rows]) => rows[0]);
    console.log(`[turismo-catalogo] modo=${opciones.checkOnly ? "check" : "apply"}; target=${opciones.target}; base=${identificacion.base}; servidor=${identificacion.servidor}`);
    if (opciones.checkOnly) {
      const report = await reporteCheck(connection);
      let preflight = null;
      let postflight = null;
      const snapshot = await validarPreflight(connection);
      preflight = {
        identidadesLegacyValidas: true,
        tarifasLegacy: snapshot.tarifaCount,
        tarifaChecksum: snapshot.tarifaChecksum,
      };
      if (report.aplicado) postflight = await verificarPostflight(connection, snapshot);
      const result = { migrationId: MIGRATION_ID, checksum: MIGRATION_CHECKSUM, preflight, postflight, ...report };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const result = await ejecutarApply(connection);
    console.log(`[turismo-catalogo] aplicado y verificado: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[turismo-catalogo] fallo: ${error?.code || error?.message || "error desconocido"}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLUMNAS_A_AGREGAR,
  COLUMNAS_A_ALINEAR,
  COLUMNAS_NUEVAS_TABLAS_REQUERIDAS,
  COLUMNAS_REQUERIDAS,
  CONTRATO_COLUMNAS_NUEVAS_TABLAS,
  CONFIRMACIONES,
  CHECKS_NUEVAS_TABLAS_REQUERIDOS,
  CREATE_BACKUP_TABLE_SQL,
  CREATE_MIGRATION_TABLE_SQL,
  CREATE_NUEVAS_TABLAS_SQL,
  FOREIGN_KEYS_A_AGREGAR,
  FOREIGN_KEYS_NUEVAS_TABLAS_REQUERIDAS,
  INDICES_A_AGREGAR,
  INDICES_NUEVAS_TABLAS_REQUERIDOS,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_REVISION,
  TARIFA_COLUMNAS_LEGACY,
  TABLAS_REQUERIDAS,
  checksumFilas,
  crearOpcionesConexion,
  erroresDefinicionesIniciales,
  evaluarContratoColumnasNuevaTabla,
  filaFiltroTipado,
  normalizarDefaultColumna,
  normalizarOpcionesFiltro,
  parsearArgumentos,
  parsearBloquesEnv,
  reporteCheck,
  seleccionarConfiguracion,
  stableStringify,
  validarAutorizacion,
  validarConfiguracion,
  verificarPostflight,
};
