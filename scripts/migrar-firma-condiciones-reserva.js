"use strict";

// Firma de las condiciones de cancelación y «Pendiente de firma» (2026-10-22).
//
// Una sola migración para toda la funcionalidad (carga del staff, envío a firmar, baja a
// pedido y constancia):
//
//   reserva                       creado_por_usuario_id INT NULL + idx_reserva_creado_por.
//                                 Quién cargó la reserva (el propio afiliado o el staff).
//   reserva_politica_cancelacion  modo, canal, firma_por, firma_archivo, firmada_en: cómo se
//                                 aceptaron las condiciones y la copia inmutable de la firma
//                                 tomada con la aceptación (una edición posterior no la pisa).
//   reserva_cancelacion_politica  origen, canal, cancelada_por_rol, motivo y regla
//                                 ('POLITICA' | 'SIN_FIRMA'): quién pidió la baja y por qué medio.
//   estado_reserva                (15, 'Pendiente de firma'). Id fijo como 'Cancelada' (13): si el
//                                 15 ya es otro estado, o el nombre existe con otro id, FRENA sin
//                                 tocar nada. El backend lo busca por nombre.
//   reserva_firma_afiliado        (nueva) la reserva que el staff le envió a firmar a la persona
//                                 afiliada, con la política que se le envió (vale ésa aunque la
//                                 vigente cambie), el vencimiento y la respuesta.
//   reserva_constancia_archivo    (nueva) la constancia firmada escaneada (opcional), con baja lógica.
//
// Datos que completa (sólo donde está vacío; no inventa):
//   · reserva.creado_por_usuario_id ← el autor del primer CREATE de historial_reserva (sin
//     mover fecha_modificacion). Sin CREATE en el historial, queda NULL.
//   · reserva_politica_cancelacion: modo='AFILIADO', canal='APP' si aceptó el dueño de la reserva
//     (o un familiar de su grupo desde su cuenta); modo='CARGA_ADMINISTRATIVA' si aceptó el staff
//     (el canal de esas cargas viejas queda NULL: no se sabe). La firma de la aceptación es la
//     que se tomó al crear (la original, aunque una edición la haya reemplazado), con su fecha;
//     firma_por='AFILIADO' sólo cuando aceptó el propio afiliado.
//   · reserva_cancelacion_politica: origen='AFILIADO', canal='APP', cancelada_por_rol='afiliado'
//     donde canceló el dueño. Las demás quedan NULL. regla='POLITICA' para todas (DEFAULT).
//
// Permisos: GRANT SELECT, INSERT, UPDATE, DELETE a todas las cuentas 'miajb_runtime' de
// mysql.user sobre las dos tablas nuevas, en la base donde corre (las columnas nuevas de tablas
// existentes no piden GRANT). Si la cuenta conectada no puede otorgarlos, avisa e imprime las
// sentencias. Al final verifica con SHOW GRANTS e informa también si al runtime le falta lo
// mínimo que el circuito usa en las tablas existentes (PRIVILEGIOS_TABLAS_EXISTENTES: sólo
// informa, sin sugerir más). Con --check, los GRANT que SHOW GRANTS ya muestra no salen como
// pendientes; los que faltan sí, y cuentan en el total de cambios pendientes. Si al aplicar los
// permisos del runtime sobre las tablas nuevas no quedan confirmados (GRANT que fallaron, o
// mysql.user o SHOW GRANTS que no se pudieron leer), la corrida queda APLICADA pero lo dice al
// final y el comando sale con código 2.
//
// Espera como mucho 10 s por un lock (lock_wait_timeout): si una transacción abierta traba
// `reserva`, la corrida queda FALLIDA en vez de encolar detrás todas las consultas a esa tabla,
// y se vuelve a correr. Conviene correrla en un horario tranquilo.
//
// Idempotente (information_schema): cada columna, índice y tabla se crea sólo si falta y se
// verifica después. Si algo ya existe con otra definición, frena sin tocar nada. Registra la
// corrida en ajb_schema_migration. La definición (estado, COLUMNAS, INDICES, TABLAS_NUEVAS y
// BACKFILL) entra en el checksum y develop ya la registró: no se cambia acá. Un cambio de
// definición va en una migración nueva (otro MIGRATION_ID); si no, develop rechaza la corrida
// con «ya fue registrada con otro checksum».
//
// Uso:
//   node scripts/migrar-firma-condiciones-reserva.js --check             → sólo informa (no escribe nada)
//   node scripts/migrar-firma-condiciones-reserva.js                     → aplica en develop (DB_HOST local)
//   node scripts/migrar-firma-condiciones-reserva.js --allow-production  → obligatorio si DB_HOST no es local
//
// Develop (dotenv no pisa variables ya definidas; el bloque activo del .env apunta a la RDS):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb npm run migrate:firma-condiciones
// Producción (cuenta administrativa de la RDS, con ALTER, CREATE, REFERENCES y GRANT OPTION):
//   npm run migrate:firma-condiciones:check
//   npm run migrate:firma-condiciones -- --allow-production
//
// Orden de deploy: migración en develop y en producción → backend → frontend, seguidos. El
// backend nuevo sin la migración (o sin los GRANT) responde 500 en las altas, el detalle y la
// edición de reservas, y el mantenimiento de 72 h no corre. Compuerta antes de desplegar el
// backend en producción (allí la API corre como miajb_runtime): `npm run
// migrate:firma-condiciones:check` tiene que decir «0 cambio(s) pendiente(s)» y «✔ SHOW GRANTS …
// tiene lo necesario» para cada cuenta de miajb_runtime (si no pudo leer mysql.user o SHOW
// GRANTS, verificarlo a mano). Apenas esté arriba el backend nuevo, volver a
// correr la migración (mismo comando): es idempotente y sólo completa lo vacío, así las
// reservas que el backend viejo creó entre la migración y el deploy quedan con quién las cargó
// (creado_por_usuario_id) y cómo se aceptaron las condiciones (modo, canal).
//
// Volver atrás el backend: el viejo no conoce «Pendiente de firma» (no la vence, ninguna pantalla
// tiene acciones para ese estado y la unidad sigue ocupada). Antes, con el backend nuevo todavía
// andando, resolver desde la app cada `SELECT id, modalidad FROM reserva WHERE estado_reserva_id = 15`:
// «Firmar ahora en pantalla» llamando a la persona (queda Iniciada o Verificada) o «Cancelar a
// pedido de la persona afiliada» (libera el lugar, deja la solicitud CANCELADA y le avisa). Si se
// puede, mejor corregir hacia adelante. La migración no hace falta revertirla: al backend viejo
// no le molesta. Por SQL, además de pasar la reserva a 4 y la solicitud a decision='CANCELADA',
// hay que liberar su fila de bloque_fecha_recurso si es de un bloque (reserva_id = NULL y el
// estado disponible que corresponda), dejar historial y avisarle a la persona.
//
// TLS: si DB_SSL_MODE es verify-ca o verify-full se conecta con DB_SSL_CA_PATH.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MIGRATION_ID = "20261022_firma_condiciones_reserva_v1";
const MIGRATION_REVISION = 1;
const MIGRATION_LOCK = `ajb:migration:${MIGRATION_ID}`;
const USUARIO_RUNTIME = "miajb_runtime";
const ROLES_STAFF = Object.freeze(["admin", "departamental", "admin-central"]);

const ESTADO_PENDIENTE_FIRMA = Object.freeze({ id: 15, nombre: "Pendiente de firma" });

// Tablas que tienen que existir antes de empezar.
const TABLAS_REQUERIDAS = Object.freeze([
  "reserva",
  "estado_reserva",
  "historial_reserva",
  "usuario",
  "rol",
  "politica_cancelacion",
  "reserva_politica_cancelacion",
  "reserva_cancelacion_politica",
]);

const columnaNula = (nombre, dataType, columnType, definicion, extra = {}) =>
  Object.freeze({ nombre, dataType, columnType, nulable: true, definicion, ...extra });

// Columnas nuevas en tablas existentes. Cada una va AFTER su `despues` o, si no tiene,
// después de la anterior de la misma tabla.
const COLUMNAS = Object.freeze([
  Object.freeze({
    tabla: "reserva",
    requeridas: Object.freeze(["id", "usuario_id", "fecha_modificacion"]),
    columnas: Object.freeze([
      columnaNula("creado_por_usuario_id", "int", "int",
        "INT NULL DEFAULT NULL COMMENT 'Quién cargó la reserva: el propio afiliado o el staff (carga administrativa)'",
        { despues: "usuario_id" }),
    ]),
  }),
  Object.freeze({
    tabla: "reserva_politica_cancelacion",
    requeridas: Object.freeze(["reserva_id", "aceptada_por", "aceptada_en"]),
    columnas: Object.freeze([
      columnaNula("modo", "enum", "enum('AFILIADO','CARGA_ADMINISTRATIVA')",
        "ENUM('AFILIADO','CARGA_ADMINISTRATIVA') NULL DEFAULT NULL COMMENT 'NULL = anterior al registro'",
        { despues: "aceptada_en" }),
      columnaNula("canal", "enum", "enum('APP','PRESENCIAL','TELEFONO','ENVIO')",
        "ENUM('APP','PRESENCIAL','TELEFONO','ENVIO') NULL DEFAULT NULL COMMENT 'Cómo se informaron las condiciones'"),
      columnaNula("firma_por", "enum", "enum('AFILIADO','ADMINISTRATIVO')",
        "ENUM('AFILIADO','ADMINISTRATIVO') NULL DEFAULT NULL COMMENT 'Quién firmó: la persona afiliada o el administrativo (reserva telefónica)'"),
      columnaNula("firma_archivo", "varchar", "varchar(260)",
        "VARCHAR(260) NULL DEFAULT NULL COMMENT 'Clave S3 de la firma tomada con la aceptación: copia inmutable'"),
      columnaNula("firmada_en", "datetime", "datetime", "DATETIME NULL DEFAULT NULL"),
    ]),
  }),
  Object.freeze({
    tabla: "reserva_cancelacion_politica",
    requeridas: Object.freeze(["reserva_id", "cancelada_por", "tipo_base"]),
    columnas: Object.freeze([
      columnaNula("origen", "enum", "enum('AFILIADO','STAFF_A_PEDIDO')",
        "ENUM('AFILIADO','STAFF_A_PEDIDO') NULL DEFAULT NULL COMMENT 'Quién pidió la baja'",
        { despues: "cancelada_por" }),
      columnaNula("canal", "enum", "enum('APP','PRESENCIAL','TELEFONO','ESCRITO')",
        "ENUM('APP','PRESENCIAL','TELEFONO','ESCRITO') NULL DEFAULT NULL COMMENT 'Por qué medio la pidió'"),
      columnaNula("cancelada_por_rol", "varchar", "varchar(30)",
        "VARCHAR(30) NULL DEFAULT NULL COMMENT 'Rol de quien la cargó al momento de cancelar'"),
      columnaNula("motivo", "varchar", "varchar(1000)", "VARCHAR(1000) NULL DEFAULT NULL"),
      Object.freeze({
        nombre: "regla",
        dataType: "enum",
        columnType: "enum('POLITICA','SIN_FIRMA')",
        nulable: false,
        predeterminado: "POLITICA",
        despues: "tipo_base",
        definicion: "ENUM('POLITICA','SIN_FIRMA') NOT NULL DEFAULT 'POLITICA' COMMENT 'SIN_FIRMA = baja antes de firmar: sin penalidad'",
      }),
    ]),
  }),
]);

const INDICES = Object.freeze([
  Object.freeze({ tabla: "reserva", nombre: "idx_reserva_creado_por", columnas: Object.freeze(["creado_por_usuario_id"]) }),
]);

const col = (nombre, dataType, columnType, nulable, predeterminado) => Object.freeze({
  nombre, dataType, columnType, nulable, ...(predeterminado === undefined ? {} : { predeterminado }),
});

// Tablas nuevas. `columnas` sirve para verificar una tabla que ya exista (corrida anterior).
// `{{COLLATE}}` se reemplaza por la collation de reserva (las comparaciones entre tablas no
// mezclan collations).
const TABLAS_NUEVAS = Object.freeze([
  Object.freeze({
    tabla: "reserva_firma_afiliado",
    columnas: Object.freeze([
      col("reserva_id", "int", "int", false),
      col("afiliado_usuario_id", "int", "int", false),
      col("solicitada_por_usuario_id", "int", "int", false),
      col("estado_destino", "varchar", "varchar(50)", false),
      col("politica_id", "bigint", "bigint unsigned", false),
      col("politica_version", "int", "int unsigned", false),
      col("politica_snapshot_json", "json", "json", false),
      col("decision", "enum", "enum('PENDIENTE','FIRMADA','RECHAZADA','CANCELADA','VENCIDA')", false, "PENDIENTE"),
      col("fecha_solicitud", "datetime", "datetime", false),
      col("vence_en", "datetime", "datetime", false),
      col("fecha_respuesta", "datetime", "datetime", true),
      col("respondida_por_usuario_id", "int", "int", true),
      col("firma_ip", "varchar", "varchar(45)", true),
      col("firma_user_agent", "varchar", "varchar(255)", true),
      col("motivo", "varchar", "varchar(500)", true),
      col("avisos_enviados", "tinyint", "tinyint unsigned", false, "1"),
      col("ultimo_aviso_en", "datetime", "datetime", false),
    ]),
    ddl: `CREATE TABLE IF NOT EXISTS reserva_firma_afiliado (
  reserva_id INT NOT NULL,
  afiliado_usuario_id INT NOT NULL COMMENT 'reserva.usuario_id al enviar: quien tiene que firmar',
  solicitada_por_usuario_id INT NOT NULL COMMENT 'staff que la envió a firmar',
  estado_destino VARCHAR(50) NOT NULL COMMENT 'Estado al firmar: Iniciada (carga de administración) o Verificada (carga departamental)',
  politica_id BIGINT UNSIGNED NOT NULL,
  politica_version INT UNSIGNED NOT NULL,
  politica_snapshot_json JSON NOT NULL COMMENT 'La política que se le envió: vale ésa aunque la vigente cambie',
  decision ENUM('PENDIENTE','FIRMADA','RECHAZADA','CANCELADA','VENCIDA') NOT NULL DEFAULT 'PENDIENTE',
  fecha_solicitud DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  vence_en DATETIME NOT NULL,
  fecha_respuesta DATETIME NULL DEFAULT NULL,
  respondida_por_usuario_id INT NULL DEFAULT NULL COMMENT 'Afiliado (su cuenta) o staff (firma en pantalla o baja); NULL si venció',
  firma_ip VARCHAR(45) NULL DEFAULT NULL,
  firma_user_agent VARCHAR(255) NULL DEFAULT NULL,
  motivo VARCHAR(500) NULL DEFAULT NULL COMMENT 'Por qué no la quiso o por qué se dio de baja',
  avisos_enviados TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ultimo_aviso_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reserva_id),
  KEY idx_rfa_afiliado (afiliado_usuario_id, decision, vence_en),
  KEY idx_rfa_vence (decision, vence_en),
  KEY idx_rfa_solicitante (solicitada_por_usuario_id, decision),
  KEY idx_rfa_politica (politica_id),
  CONSTRAINT fk_rfa_reserva FOREIGN KEY (reserva_id) REFERENCES reserva (id) ON DELETE CASCADE,
  CONSTRAINT fk_rfa_politica FOREIGN KEY (politica_id) REFERENCES politica_cancelacion (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE={{COLLATE}}`,
  }),
  Object.freeze({
    tabla: "reserva_constancia_archivo",
    columnas: Object.freeze([
      col("id", "int", "int", false),
      col("reserva_id", "int", "int", false),
      col("archivo", "varchar", "varchar(260)", false),
      col("nombre_original", "varchar", "varchar(260)", true),
      col("mime", "varchar", "varchar(100)", true),
      col("tamanio", "int", "int", true),
      col("subido_por_usuario_id", "int", "int", true),
      col("fecha_creacion", "datetime", "datetime", false),
      col("eliminado", "tinyint", "tinyint(1)", false, "0"),
      col("eliminado_por_usuario_id", "int", "int", true),
      col("eliminado_en", "datetime", "datetime", true),
    ]),
    ddl: `CREATE TABLE IF NOT EXISTS reserva_constancia_archivo (
  id INT NOT NULL AUTO_INCREMENT,
  reserva_id INT NOT NULL,
  archivo VARCHAR(260) NOT NULL COMMENT 'Clave S3 (prefijo turismo/constancias/)',
  nombre_original VARCHAR(260) NULL DEFAULT NULL,
  mime VARCHAR(100) NULL DEFAULT NULL,
  tamanio INT NULL DEFAULT NULL,
  subido_por_usuario_id INT NULL DEFAULT NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  eliminado TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Baja lógica: es prueba, el objeto de S3 queda',
  eliminado_por_usuario_id INT NULL DEFAULT NULL,
  eliminado_en DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_rca_reserva (reserva_id, eliminado),
  CONSTRAINT fk_rca_reserva FOREIGN KEY (reserva_id) REFERENCES reserva (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE={{COLLATE}}`,
  }),
]);

// Tablas existentes que el circuito usa con el usuario de la API y lo mínimo que necesita en
// cada una: sólo se informa si falta (el GRANT de tablas viejas no es parte de esta
// migración). Las aceptaciones y las cancelaciones son registros inmutables (SELECT, INSERT,
// como dice README-politicas-cancelacion.md) y el historial sólo se agrega: no se pide más.
const PRIVILEGIOS_TABLAS_EXISTENTES = Object.freeze({
  reserva: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  reserva_politica_cancelacion: Object.freeze(["SELECT", "INSERT"]),
  reserva_cancelacion_politica: Object.freeze(["SELECT", "INSERT"]),
  historial_reserva: Object.freeze(["SELECT", "INSERT"]),
  notificacion: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
});
const TABLAS_EXISTENTES_RUNTIME = Object.freeze(Object.keys(PRIVILEGIOS_TABLAS_EXISTENTES));
const PRIVILEGIOS_DML = Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]);

/** Lo que el runtime necesita en `tabla`: DML completo en las nuevas, el mínimo en las existentes. */
function privilegiosRequeridos(tabla) {
  return PRIVILEGIOS_TABLAS_EXISTENTES[tabla] || PRIVILEGIOS_DML;
}

// --- Backfill (todo con «sólo donde está vacío») ------------------------------
const SQL_PRIMER_CREATE = `
  SELECT reserva_id, MIN(id) AS primer_id
    FROM historial_reserva
   WHERE tipo_operacion = 'CREATE'
   GROUP BY reserva_id`;

// fecha_modificacion = fecha_modificacion: asignarla explícitamente evita que el ON UPDATE
// CURRENT_TIMESTAMP la mueva. ajb_reserva_guard_bu sólo mira importes y fechas.
const SQL_BACKFILL_CREADO_POR = `
  UPDATE reserva r
   INNER JOIN (${SQL_PRIMER_CREATE}) c ON c.reserva_id = r.id
   INNER JOIN historial_reserva h ON h.id = c.primer_id
     SET r.creado_por_usuario_id = h.usuario_modificador_id,
         r.fecha_modificacion = r.fecha_modificacion
   WHERE r.creado_por_usuario_id IS NULL
     AND h.usuario_modificador_id IS NOT NULL`;

// Aceptó el dueño, o un familiar de su grupo desde su propia cuenta (nunca el staff).
const SQL_ACEPTO_AFILIADO = `(
      pc.aceptada_por = r.usuario_id
      OR (ro.nombre NOT IN (${ROLES_STAFF.map((rol) => `'${rol}'`).join(", ")})
          AND (ua.usuario_familiar_id = r.usuario_id
               OR ua.id = (SELECT d.usuario_familiar_id FROM usuario d WHERE d.id = r.usuario_id)))
    )`;

const SQL_BACKFILL_MODO_AFILIADO = `
  UPDATE reserva_politica_cancelacion pc
   INNER JOIN reserva r ON r.id = pc.reserva_id
   INNER JOIN usuario ua ON ua.id = pc.aceptada_por
   INNER JOIN rol ro ON ro.id = ua.rol_id
     SET pc.modo = 'AFILIADO', pc.canal = 'APP'
   WHERE pc.modo IS NULL
     AND ${SQL_ACEPTO_AFILIADO}`;

// El canal de las cargas viejas del staff queda NULL: no se sabe si fue en la oficina o por teléfono.
const SQL_BACKFILL_MODO_STAFF = `
  UPDATE reserva_politica_cancelacion pc
   INNER JOIN usuario ua ON ua.id = pc.aceptada_por
   INNER JOIN rol ro ON ro.id = ua.rol_id
     SET pc.modo = 'CARGA_ADMINISTRATIVA'
   WHERE pc.modo IS NULL
     AND ro.nombre IN (${ROLES_STAFF.map((rol) => `'${rol}'`).join(", ")})`;

// La firma de la aceptación es la del alta: si una edición la reemplazó, la original quedó
// como valor_anterior del primer cambio de firma_archivo en el historial.
const SQL_BACKFILL_FIRMA_ARCHIVO = `
  UPDATE reserva_politica_cancelacion pc
   INNER JOIN reserva r ON r.id = pc.reserva_id
     SET pc.firma_archivo = CASE
           WHEN EXISTS (SELECT 1 FROM historial_reserva h
                         WHERE h.reserva_id = r.id AND h.campo_modificado = 'firma_archivo')
           THEN (SELECT NULLIF(TRIM(h.valor_anterior), '') FROM historial_reserva h
                  WHERE h.reserva_id = r.id AND h.campo_modificado = 'firma_archivo'
                  ORDER BY h.id LIMIT 1)
           ELSE NULLIF(TRIM(r.firma_archivo), '')
         END
   WHERE pc.modo IS NOT NULL
     AND pc.firma_archivo IS NULL
     AND pc.firmada_en IS NULL`;

// La firma del alta se subió en la misma transacción que la aceptación: misma fecha. Quién
// firmó sólo se sabe cuando aceptó el propio afiliado.
const SQL_BACKFILL_FIRMA_POR = `
  UPDATE reserva_politica_cancelacion pc
     SET pc.firmada_en = pc.aceptada_en,
         pc.firma_por = CASE WHEN pc.modo = 'AFILIADO' THEN 'AFILIADO' ELSE NULL END
   WHERE pc.firma_archivo IS NOT NULL
     AND pc.firmada_en IS NULL
     AND pc.modo IS NOT NULL`;

// Hasta hoy el front sólo ofrecía cancelar al dueño: esas son del afiliado desde la app.
const SQL_BACKFILL_CANCELACION = `
  UPDATE reserva_cancelacion_politica rcp
   INNER JOIN reserva r ON r.id = rcp.reserva_id
     SET rcp.origen = 'AFILIADO', rcp.canal = 'APP', rcp.cancelada_por_rol = 'afiliado'
   WHERE rcp.origen IS NULL
     AND rcp.cancelada_por = r.usuario_id`;

const BACKFILL = Object.freeze([
  Object.freeze({ clave: "creado_por", descripcion: "reserva.creado_por_usuario_id desde el primer CREATE del historial", sql: SQL_BACKFILL_CREADO_POR }),
  Object.freeze({ clave: "aceptacion_afiliado", descripcion: "aceptaciones del afiliado (AFILIADO / APP)", sql: SQL_BACKFILL_MODO_AFILIADO }),
  Object.freeze({ clave: "aceptacion_staff", descripcion: "aceptaciones del staff (CARGA_ADMINISTRATIVA, canal sin dato)", sql: SQL_BACKFILL_MODO_STAFF }),
  Object.freeze({ clave: "firma_archivo", descripcion: "firma tomada con la aceptación", sql: SQL_BACKFILL_FIRMA_ARCHIVO }),
  Object.freeze({ clave: "firma_por", descripcion: "fecha de la firma y quién firmó (sólo el afiliado)", sql: SQL_BACKFILL_FIRMA_POR }),
  Object.freeze({ clave: "cancelacion_afiliado", descripcion: "cancelaciones del dueño (AFILIADO / APP)", sql: SQL_BACKFILL_CANCELACION }),
]);

const MIGRATION_CHECKSUM = crypto
  .createHash("sha256")
  .update(JSON.stringify({
    revision: MIGRATION_REVISION,
    estado: ESTADO_PENDIENTE_FIRMA,
    columnas: COLUMNAS,
    indices: INDICES,
    tablas: TABLAS_NUEVAS,
    backfill: BACKFILL,
  }))
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

// --- Lectura del esquema -------------------------------------------------------
async function existeTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  return Number(rows[0]?.total) > 0;
}

async function collationDeTabla(connection, tabla) {
  const [rows] = await connection.query(
    `SELECT TABLE_COLLATION
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla]
  );
  const collation = String(rows[0]?.TABLE_COLLATION || "").toLowerCase();
  // Sólo collations utf8mb4: el valor va dentro del DDL.
  return /^utf8mb4_[a-z0-9_]+$/.test(collation) ? collation : "utf8mb4_0900_ai_ci";
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
  if (esperada.predeterminado !== undefined) {
    const actual = String(existente.COLUMN_DEFAULT ?? "").replace(/^'(.*)'$/, "$1");
    if (actual !== esperada.predeterminado) {
      diferencias.push(`DEFAULT ${existente.COLUMN_DEFAULT ?? "NULL"} (se esperaba ${esperada.predeterminado})`);
    }
  }
  return diferencias;
}

/**
 * Plan de columnas de una tabla: { faltantes, existentes, ddl }. Lanza si falta una
 * columna requerida o si una de las nuevas ya existe con otra definición.
 */
function planColumnas(definicion, columnas) {
  for (const requerida of definicion.requeridas) {
    if (!columnas.has(requerida)) throw new Error(`Falta la columna ${definicion.tabla}.${requerida}`);
  }
  const conflictos = [];
  const faltantes = [];
  const existentes = [];
  const clausulas = [];
  let anterior = null;
  for (const columna of definicion.columnas) {
    const actual = columnas.get(columna.nombre);
    if (actual) {
      const diferencias = diferenciasColumna(actual, columna);
      if (diferencias.length > 0) conflictos.push(`${definicion.tabla}.${columna.nombre}: ${diferencias.join(", ")}`);
      existentes.push(columna.nombre);
    } else {
      const ancla = columna.despues || anterior;
      const posicion = ancla && (columnas.has(ancla) || faltantes.includes(ancla)) ? ` AFTER ${ancla}` : "";
      clausulas.push(`ADD COLUMN ${columna.nombre} ${columna.definicion}${posicion}`);
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

/** Una tabla nueva que ya existe (corrida anterior) tiene que tener todas sus columnas. */
function verificarTablaExistente(definicion, columnas) {
  const conflictos = [];
  for (const columna of definicion.columnas) {
    const actual = columnas.get(columna.nombre);
    if (!actual) {
      conflictos.push(`falta ${definicion.tabla}.${columna.nombre}`);
      continue;
    }
    const diferencias = diferenciasColumna(actual, columna);
    if (diferencias.length > 0) conflictos.push(`${definicion.tabla}.${columna.nombre}: ${diferencias.join(", ")}`);
  }
  if (conflictos.length > 0) {
    throw new Error(`La tabla ${definicion.tabla} ya existe con otra definición. Revisala a mano: ${conflictos.join("; ")}`);
  }
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

/** Las claves foráneas nuevas apuntan a reserva.id (INT) y politica_cancelacion.id (BIGINT UNSIGNED). */
function verificarTiposReferenciados(columnasReserva, columnasPolitica) {
  const idReserva = String(columnasReserva.get("id")?.COLUMN_TYPE || "").toLowerCase();
  if (idReserva !== "int") {
    throw new Error(`reserva.id es ${idReserva || "desconocido"} y las tablas nuevas esperan int. Revisalo a mano.`);
  }
  const idPolitica = String(columnasPolitica.get("id")?.COLUMN_TYPE || "").toLowerCase();
  if (idPolitica !== "bigint unsigned") {
    throw new Error(`politica_cancelacion.id es ${idPolitica || "desconocido"} y se esperaba bigint unsigned. Revisalo a mano.`);
  }
}

/**
 * 'EXISTE' si (15, 'Pendiente de firma') ya está, 'FALTA' si hay que insertarlo. Lanza si el
 * 15 es otro estado o si el nombre existe con otro id: en ese caso no se toca nada.
 */
async function revisarCatalogo(connection, { bloquear = false } = {}) {
  const [rows] = await connection.query(
    `SELECT id, nombre FROM estado_reserva WHERE id = ? OR nombre = ?${bloquear ? " FOR UPDATE" : ""}`,
    [ESTADO_PENDIENTE_FIRMA.id, ESTADO_PENDIENTE_FIRMA.nombre]
  );
  const porNombre = rows.find((fila) => String(fila.nombre) === ESTADO_PENDIENTE_FIRMA.nombre);
  const porId = rows.find((fila) => Number(fila.id) === ESTADO_PENDIENTE_FIRMA.id);
  if (porNombre && Number(porNombre.id) !== ESTADO_PENDIENTE_FIRMA.id) {
    throw new Error(
      `'${ESTADO_PENDIENTE_FIRMA.nombre}' ya existe con id ${porNombre.id}, pero el backend espera el ${ESTADO_PENDIENTE_FIRMA.id}. Revisalo a mano.`
    );
  }
  if (porId && String(porId.nombre) !== ESTADO_PENDIENTE_FIRMA.nombre) {
    throw new Error(
      `El id ${ESTADO_PENDIENTE_FIRMA.id} de estado_reserva ya es '${porId.nombre}'. La migración frena sin tocar nada: revisalo a mano.`
    );
  }
  return porId ? "EXISTE" : "FALTA";
}

// --- Conteos informativos (se adaptan a las columnas que existan) ----------------
async function contarEstado(connection) {
  const columnasReserva = await leerColumnas(connection, "reserva");
  const columnasPolitica = await leerColumnas(connection, "reserva_politica_cancelacion");
  const columnasCancelacion = await leerColumnas(connection, "reserva_cancelacion_politica");
  const conCreador = columnasReserva.has("creado_por_usuario_id");
  const conModo = columnasPolitica.has("modo");
  const conOrigen = columnasCancelacion.has("origen");

  const [[creador]] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM reserva r
      INNER JOIN (${SQL_PRIMER_CREATE}) c ON c.reserva_id = r.id
      INNER JOIN historial_reserva h ON h.id = c.primer_id
      WHERE h.usuario_modificador_id IS NOT NULL${conCreador ? " AND r.creado_por_usuario_id IS NULL" : ""}`
  );
  const [[sinCreate]] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM reserva r
      WHERE NOT EXISTS (SELECT 1 FROM historial_reserva h WHERE h.reserva_id = r.id AND h.tipo_operacion = 'CREATE')`
  );
  const [[aceptaciones]] = await connection.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${SQL_ACEPTO_AFILIADO} THEN 1 ELSE 0 END), 0) AS afiliado,
            COALESCE(SUM(CASE WHEN NOT ${SQL_ACEPTO_AFILIADO}
                               AND ro.nombre IN (${ROLES_STAFF.map((rol) => `'${rol}'`).join(", ")}) THEN 1 ELSE 0 END), 0) AS staff
       FROM reserva_politica_cancelacion pc
      INNER JOIN reserva r ON r.id = pc.reserva_id
      INNER JOIN usuario ua ON ua.id = pc.aceptada_por
      INNER JOIN rol ro ON ro.id = ua.rol_id${conModo ? "\n      WHERE pc.modo IS NULL" : ""}`
  );
  const [[cancelaciones]] = await connection.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN rcp.cancelada_por = r.usuario_id THEN 1 ELSE 0 END), 0) AS del_duenio
       FROM reserva_cancelacion_politica rcp
      INNER JOIN reserva r ON r.id = rcp.reserva_id${conOrigen ? "\n      WHERE rcp.origen IS NULL" : ""}`
  );
  const totalAceptaciones = Number(aceptaciones?.total || 0);
  const afiliado = Number(aceptaciones?.afiliado || 0);
  const staff = Number(aceptaciones?.staff || 0);
  const totalCancelaciones = Number(cancelaciones?.total || 0);
  const delDuenio = Number(cancelaciones?.del_duenio || 0);
  return {
    reservas_creador_a_completar: Number(creador?.total || 0),
    reservas_sin_create_en_historial: Number(sinCreate?.total || 0),
    aceptaciones_sin_modo: totalAceptaciones,
    aceptaciones_afiliado: afiliado,
    aceptaciones_staff: staff,
    aceptaciones_sin_dato: Math.max(0, totalAceptaciones - afiliado - staff),
    cancelaciones_sin_origen: totalCancelaciones,
    cancelaciones_del_duenio: delDuenio,
    cancelaciones_sin_dato: Math.max(0, totalCancelaciones - delDuenio),
  };
}

// --- Permisos del runtime -------------------------------------------------------
// Códigos con los que MySQL responde cuando la cuenta conectada no puede otorgar o leer
// permisos, o el usuario runtime no existe: no son un error de la migración en sí.
const CODIGOS_SIN_PERMISO_GRANT = new Set([
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
  "ER_CANT_CREATE_USER_WITH_GRANT",
  "ER_NONEXISTING_GRANT",
  "ER_PASSWORD_NO_MATCH",
]);

const citarIdentificador = (valor) => `\`${String(valor).replace(/`/g, "``")}\``;
const citarTexto = (valor) => `'${String(valor).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

// El runtime existe en las dos bases con hosts distintos ('localhost' y '127.0.0.1' en develop,
// la IP privada del EC2 en la RDS): se buscan en mysql.user para no adivinarlos.
async function cuentasRuntime(connection) {
  try {
    const [filas] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ? ORDER BY host", [USUARIO_RUNTIME]);
    return { cuentas: filas.map((fila) => ({ user: String(fila.user), host: String(fila.host) })), visibles: true };
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    return { cuentas: [], visibles: false };
  }
}

function sentenciaGrant(baseDatos, cuenta, tabla, privilegios = PRIVILEGIOS_DML) {
  return `GRANT ${privilegios.join(", ")} ON ${citarIdentificador(baseDatos)}.${citarIdentificador(tabla)} ` +
    `TO ${citarTexto(cuenta.user)}@${citarTexto(cuenta.host)}`;
}

function sqlGrants(baseDatos, cuentas, tablas = TABLAS_NUEVAS.map((definicion) => definicion.tabla)) {
  const sentencias = [];
  for (const cuenta of cuentas) {
    for (const tabla of tablas) sentencias.push(sentenciaGrant(baseDatos, cuenta, tabla));
  }
  return sentencias;
}

/**
 * --check: los GRANT de las tablas nuevas que le faltan a cada cuenta, con sólo los
 * privilegios que faltan según SHOW GRANTS (`permisos`, en el orden de `cuentas`). Si no se
 * pudo leer SHOW GRANTS de una cuenta, queda todo pendiente: no se puede saber.
 */
function grantsFaltantes(baseDatos, cuentas, permisos, tablasNuevas) {
  const sentencias = [];
  cuentas.forEach((cuenta, indice) => {
    const permiso = permisos[indice];
    for (const tabla of tablasNuevas) {
      const faltan = permiso?.verificada ? permiso.faltantes[tabla] : PRIVILEGIOS_DML;
      if (faltan?.length) sentencias.push(sentenciaGrant(baseDatos, cuenta, tabla, faltan));
    }
  });
  return sentencias;
}

// Esquema de un GRANT («`db\_miajb`», «*», «`db%`») → ¿aplica a la base actual?
function esquemaCoincide(patron, baseDatos) {
  const limpio = String(patron).trim().replace(/^`(.*)`$/, "$1");
  if (limpio === "*") return true;
  let expresion = "";
  for (let i = 0; i < limpio.length; i += 1) {
    const caracter = limpio[i];
    if (caracter === "\\" && i + 1 < limpio.length) {
      expresion += limpio[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    } else if (caracter === "%") expresion += ".*";
    else if (caracter === "_") expresion += ".";
    else expresion += caracter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expresion}$`, "i").test(baseDatos);
}

/** Privilegios DML que una línea de SHOW GRANTS otorga sobre `tabla` de `baseDatos`. */
function privilegiosDeGrant(linea, baseDatos, tabla) {
  const coincidencia = /^GRANT\s+(.+?)\s+ON\s+(?:TABLE\s+)?(\S+?)\.(\S+?)\s+TO\s/i.exec(String(linea).trim());
  if (!coincidencia) return new Set();
  const [, lista, esquema, objeto] = coincidencia;
  const objetoLimpio = objeto.replace(/^`(.*)`$/, "$1");
  if (!esquemaCoincide(esquema, baseDatos)) return new Set();
  if (objetoLimpio !== "*" && objetoLimpio.toLowerCase() !== tabla.toLowerCase()) return new Set();
  // Los privilegios por columna («SELECT (a, b)») no alcanzan a toda la tabla: se descartan.
  const privilegios = [];
  let profundidad = 0;
  let actual = "";
  for (const caracter of `${lista},`) {
    if (caracter === "(") profundidad += 1;
    if (caracter === ")") profundidad -= 1;
    if (caracter === "," && profundidad === 0) {
      if (!actual.includes("(")) privilegios.push(actual.trim().toUpperCase());
      actual = "";
    } else {
      actual += caracter;
    }
  }
  if (privilegios.includes("ALL") || privilegios.includes("ALL PRIVILEGES")) return new Set(PRIVILEGIOS_DML);
  return new Set(privilegios.filter((privilegio) => PRIVILEGIOS_DML.includes(privilegio)));
}

/**
 * SHOW GRANTS de cada cuenta del runtime: qué le falta de lo que necesita en cada tabla
 * (privilegiosRequeridos). Devuelve [{ cuenta, verificada, faltantes: { tabla: [privilegios] } }].
 */
async function revisarPermisosRuntime(connection, { baseDatos, cuentas, tablas }) {
  const resultado = [];
  for (const cuenta of cuentas) {
    const etiqueta = `'${cuenta.user}'@'${cuenta.host}'`;
    let lineas;
    try {
      const [filas] = await connection.query(`SHOW GRANTS FOR ${citarTexto(cuenta.user)}@${citarTexto(cuenta.host)}`);
      lineas = filas.map((fila) => String(Object.values(fila)[0] || ""));
    } catch (error) {
      if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
      resultado.push({ cuenta: etiqueta, verificada: false, faltantes: {} });
      continue;
    }
    const faltantes = {};
    for (const tabla of tablas) {
      const otorgados = new Set();
      for (const linea of lineas) {
        for (const privilegio of privilegiosDeGrant(linea, baseDatos, tabla)) otorgados.add(privilegio);
      }
      const faltan = privilegiosRequeridos(tabla).filter((privilegio) => !otorgados.has(privilegio));
      if (faltan.length > 0) faltantes[tabla] = faltan;
    }
    resultado.push({ cuenta: etiqueta, verificada: true, faltantes });
  }
  return resultado;
}

async function otorgarGrantsRuntime(connection, { baseDatos, usuarioConectado, checkOnly, log }) {
  const resumen = { otorgados: [], sentenciasPendientes: [], cuentas: [], permisos: [], aviso: null };
  const tablasNuevas = TABLAS_NUEVAS.map((definicion) => definicion.tabla);
  const tablas = [...tablasNuevas, ...TABLAS_EXISTENTES_RUNTIME];
  const { cuentas, visibles } = await cuentasRuntime(connection);
  // false = no se pudo leer mysql.user (distinto de «no existe el runtime en esta base»).
  resumen.cuentasVisibles = visibles;
  resumen.cuentas = cuentas.map((cuenta) => `'${cuenta.user}'@'${cuenta.host}'`);
  if (!visibles) {
    resumen.aviso = `No se pudo leer mysql.user: corré los GRANT de ${USUARIO_RUNTIME} sobre ${tablasNuevas.join(", ")} con la cuenta administrativa.`;
    log(`  · Aviso: ${resumen.aviso}`);
    return resumen;
  }
  if (cuentas.length === 0) {
    resumen.aviso = `No existe la cuenta ${USUARIO_RUNTIME} en esta base: no hay permisos que otorgar.`;
    log(`  · ${resumen.aviso}`);
    return resumen;
  }
  const sentencias = sqlGrants(baseDatos, cuentas, tablasNuevas);
  const etiqueta = resumen.cuentas.join(", ");
  if (checkOnly) {
    // Sólo lo que falta: SHOW GRANTS dice qué tiene ya cada cuenta (en una base ya migrada los
    // GRANT de las tablas nuevas están; antes de migrar, si nada los cubre, faltan todos).
    resumen.permisos = await revisarPermisosRuntime(connection, { baseDatos, cuentas, tablas });
    resumen.sentenciasPendientes = grantsFaltantes(baseDatos, cuentas, resumen.permisos, tablasNuevas);
    for (const sentencia of resumen.sentenciasPendientes) log(`  [PENDIENTE] ${sentencia}`);
  } else if (String(usuarioConectado || "") === USUARIO_RUNTIME) {
    resumen.aviso = `Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo.`;
    resumen.sentenciasPendientes = sentencias;
    log(
      `  · Aviso: ${resumen.aviso} Corré con la cuenta administrativa:\n` +
        sentencias.map((sentencia) => `      ${sentencia};`).join("\n") +
        "\n      FLUSH PRIVILEGES;"
    );
  } else {
    try {
      for (const sentencia of sentencias) {
        await connection.query(sentencia);
        resumen.otorgados.push(sentencia);
      }
      await connection.query("FLUSH PRIVILEGES");
      log(`  ✔ GRANT ${PRIVILEGIOS_DML.join(", ")} sobre ${tablasNuevas.join(", ")} a ${etiqueta} + FLUSH PRIVILEGES`);
    } catch (error) {
      if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
      resumen.aviso = `No se pudieron otorgar los permisos a ${etiqueta} (${error.code}: ${error.message}).`;
      resumen.sentenciasPendientes = sentencias.filter((sentencia) => !resumen.otorgados.includes(sentencia));
      log(
        `  · Aviso: ${resumen.aviso}\n` +
          "    El esquema quedó creado igual. Corré con la cuenta administrativa:\n" +
          resumen.sentenciasPendientes.map((sentencia) => `      ${sentencia};`).join("\n") +
          "\n      FLUSH PRIVILEGES;"
      );
    }
  }

  // Verificación (SHOW GRANTS) después de otorgar: tablas nuevas y existentes del circuito.
  if (!checkOnly) resumen.permisos = await revisarPermisosRuntime(connection, { baseDatos, cuentas, tablas });
  for (const permiso of resumen.permisos) {
    if (!permiso.verificada) {
      log(`  · No se pudo leer SHOW GRANTS de ${permiso.cuenta}: verificalo a mano.`);
      continue;
    }
    const faltantes = Object.entries(permiso.faltantes);
    if (faltantes.length === 0) {
      log(`  ✔ SHOW GRANTS ${permiso.cuenta}: tiene lo necesario sobre ${tablas.join(", ")}`);
      continue;
    }
    for (const [tabla, privilegios] of faltantes) {
      if (!tablasNuevas.includes(tabla)) {
        // Sólo informa: el mínimo que usa el circuito, sin sugerir más (las aceptaciones y las
        // cancelaciones son inmutables).
        log(
          `  · Aviso: ${permiso.cuenta} no tiene ${privilegios.join(", ")} sobre ${tabla}; el circuito necesita al menos ` +
            `${privilegiosRequeridos(tabla).join(", ")} (tabla existente: importa si en esta base la API corre como runtime)`
        );
      } else if (!checkOnly) {
        // En --check, lo que falta en las tablas nuevas ya salió como GRANT pendiente.
        log(`  · Falta ${privilegios.join(", ")} sobre ${tabla} para ${permiso.cuenta}`);
      }
    }
  }
  return resumen;
}

// --- Migración ------------------------------------------------------------------
// Todo el trabajo sobre una conexión ya abierta (las pruebas pasan una conexión falsa).
// Primero valida todo y recién después escribe: si algo no cuadra, no toca nada.
async function ejecutarMigracion(connection, {
  checkOnly = false,
  log = console.log,
  usuarioConectado = null,
} = {}) {
  const resultado = {
    columnasCreadas: [],
    columnasExistentes: [],
    indicesCreados: [],
    indicesExistentes: [],
    tablasCreadas: [],
    tablasExistentes: [],
    catalogo: null,
    estadoCreado: false,
    backfill: {},
    pendientes: [],
    grants: null,
    conteos: null,
  };

  // 1) Validación (sólo lectura).
  for (const tabla of TABLAS_REQUERIDAS) {
    if (!(await existeTabla(connection, tabla))) throw new Error(`Falta la tabla ${tabla}`);
  }
  const [[baseActual]] = await connection.query("SELECT DATABASE() AS base");
  const baseDatos = String(baseActual?.base || "");
  if (!baseDatos) throw new Error("No hay una base seleccionada");

  const columnasPorTabla = new Map();
  for (const definicion of COLUMNAS) {
    columnasPorTabla.set(definicion.tabla, await leerColumnas(connection, definicion.tabla));
  }
  verificarTiposReferenciados(columnasPorTabla.get("reserva"), await leerColumnas(connection, "politica_cancelacion"));
  const collation = await collationDeTabla(connection, "reserva");

  const planes = COLUMNAS.map((definicion) => ({ definicion, plan: planColumnas(definicion, columnasPorTabla.get(definicion.tabla)) }));

  const indicesFaltantes = [];
  for (const indice of INDICES) {
    const equivalente = buscarIndiceEquivalente(await leerIndices(connection, indice.tabla), indice);
    if (equivalente) {
      log(`  · ${indice.tabla}(${indice.columnas.join(", ")}) ya tiene índice: ${equivalente.nombre}`);
      resultado.indicesExistentes.push(`${indice.tabla}.${equivalente.nombre}`);
    } else {
      indicesFaltantes.push(indice);
    }
  }

  const tablasFaltantes = [];
  for (const definicion of TABLAS_NUEVAS) {
    if (await existeTabla(connection, definicion.tabla)) {
      verificarTablaExistente(definicion, await leerColumnas(connection, definicion.tabla));
      log(`  · ${definicion.tabla} ya existe`);
      resultado.tablasExistentes.push(definicion.tabla);
    } else {
      tablasFaltantes.push(definicion);
    }
  }

  // Si el 15 es otro estado, frena acá: todavía no se escribió nada.
  resultado.catalogo = await revisarCatalogo(connection);
  if (resultado.catalogo === "EXISTE") {
    log(`  · estado_reserva (${ESTADO_PENDIENTE_FIRMA.id}, '${ESTADO_PENDIENTE_FIRMA.nombre}') ya existe`);
  }

  for (const { definicion, plan } of planes) {
    for (const nombre of plan.existentes) {
      log(`  · ${definicion.tabla}.${nombre} ya existe`);
      resultado.columnasExistentes.push(`${definicion.tabla}.${nombre}`);
    }
  }

  if (checkOnly) {
    for (const { definicion, plan } of planes) {
      if (!plan.ddl) continue;
      log(`  [PENDIENTE] ${plan.ddl}`);
      resultado.pendientes.push(...plan.faltantes.map((nombre) => `${definicion.tabla}.${nombre}`));
    }
    for (const indice of indicesFaltantes) {
      log(`  [PENDIENTE] ${ddlIndice(indice)}`);
      resultado.pendientes.push(`${indice.tabla}.${indice.nombre}`);
    }
    for (const definicion of tablasFaltantes) {
      log(`  [PENDIENTE] CREATE TABLE ${definicion.tabla} (COLLATE=${collation})`);
      resultado.pendientes.push(definicion.tabla);
    }
    if (resultado.catalogo === "FALTA") {
      log(`  [PENDIENTE] INSERT INTO estado_reserva (id, nombre) VALUES (${ESTADO_PENDIENTE_FIRMA.id}, '${ESTADO_PENDIENTE_FIRMA.nombre}')`);
      resultado.pendientes.push(`estado_reserva.${ESTADO_PENDIENTE_FIRMA.id}`);
    }
  } else {
    // 2) Esquema (cada DDL hace su propio commit implícito; se verifica uno por uno).
    for (const { definicion, plan } of planes) {
      if (!plan.ddl) continue;
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
      await connection.query(ddlIndice(indice));
      if (!buscarIndiceEquivalente(await leerIndices(connection, indice.tabla), indice)) {
        throw new Error(`No se pudo verificar el índice ${indice.nombre} en ${indice.tabla}`);
      }
      log(`  ✔ ${indice.tabla}.${indice.nombre} (${indice.columnas.join(", ")}) creado`);
      resultado.indicesCreados.push(`${indice.tabla}.${indice.nombre}`);
    }
    for (const definicion of tablasFaltantes) {
      await connection.query(definicion.ddl.replace("{{COLLATE}}", collation));
      if (!(await existeTabla(connection, definicion.tabla))) {
        throw new Error(`No se pudo verificar la tabla ${definicion.tabla}`);
      }
      verificarTablaExistente(definicion, await leerColumnas(connection, definicion.tabla));
      log(`  ✔ ${definicion.tabla} creada`);
      resultado.tablasCreadas.push(definicion.tabla);
    }

    // 3) Catálogo y datos, en una transacción.
    await connection.beginTransaction();
    try {
      const catalogo = await revisarCatalogo(connection, { bloquear: true });
      if (catalogo === "FALTA") {
        await connection.query(
          "INSERT INTO estado_reserva (id, nombre) VALUES (?, ?)",
          [ESTADO_PENDIENTE_FIRMA.id, ESTADO_PENDIENTE_FIRMA.nombre]
        );
        resultado.estadoCreado = true;
        log(`  ✔ estado_reserva (${ESTADO_PENDIENTE_FIRMA.id}, '${ESTADO_PENDIENTE_FIRMA.nombre}') creado`);
      }
      for (const paso of BACKFILL) {
        const [respuesta] = await connection.query(paso.sql);
        const filas = Number(respuesta?.affectedRows || 0);
        resultado.backfill[paso.clave] = filas;
        log(`  ${filas > 0 ? "✔" : "·"} ${paso.descripcion}: ${filas} fila(s)`);
      }
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch (_) {
        // Se conserva el error original.
      }
      throw error;
    }
  }

  // 4) Permisos del runtime (en --check sólo informa lo que falta, y cuenta como pendiente).
  resultado.grants = await otorgarGrantsRuntime(connection, { baseDatos, usuarioConectado, checkOnly, log });
  if (checkOnly) resultado.pendientes.push(...resultado.grants.sentenciasPendientes);

  // 5) Conteos.
  resultado.conteos = await contarEstado(connection);
  const c = resultado.conteos;
  log(`  · Reservas ${checkOnly ? "a completar" : "que siguen"} sin quién las cargó (con CREATE en el historial): ${c.reservas_creador_a_completar}`);
  log(`  · Reservas sin CREATE en el historial (quedan sin dato): ${c.reservas_sin_create_en_historial}`);
  log(`  · Aceptaciones sin modo: ${c.aceptaciones_sin_modo} (afiliado ${c.aceptaciones_afiliado}, staff ${c.aceptaciones_staff}, sin dato ${c.aceptaciones_sin_dato})`);
  log(`  · Cancelaciones sin origen: ${c.cancelaciones_sin_origen} (del dueño ${c.cancelaciones_del_duenio}, de otro usuario: quedan sin dato ${c.cancelaciones_sin_dato})`);
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

function detalleRegistro(resultado) {
  const backfill = Object.entries(resultado.backfill).map(([clave, filas]) => `${clave}=${filas}`).join(", ");
  return [
    `columnas: ${resultado.columnasCreadas.join(", ") || "-"}`,
    `índices: ${resultado.indicesCreados.join(", ") || "-"}`,
    `tablas: ${resultado.tablasCreadas.join(", ") || "-"}`,
    `estado 15: ${resultado.estadoCreado ? "creado" : "ya existía"}`,
    `backfill: ${backfill || "-"}`,
    `grants: ${resultado.grants?.otorgados?.length || 0}${resultado.grants?.sentenciasPendientes?.length ? " (con pendientes)" : ""}`,
  ].join("; ");
}

/**
 * Sin --check: los permisos del runtime sobre las tablas nuevas no quedaron confirmados (GRANT
 * que fallaron o que no se pudieron dar, mysql.user o SHOW GRANTS ilegibles, o algo que falta).
 * El backend nuevo lee reserva_firma_afiliado en el detalle, la lista y las altas: sin SELECT,
 * todo eso responde 500. Si en la base no existe la cuenta runtime, no hay nada que confirmar.
 */
function grantsIncompletos(grants) {
  if (!grants) return false;
  if (grants.cuentasVisibles === false || (grants.sentenciasPendientes || []).length > 0) return true;
  const tablasNuevas = TABLAS_NUEVAS.map((definicion) => definicion.tabla);
  return (grants.permisos || []).some((permiso) => !permiso.verificada
    || tablasNuevas.some((tabla) => (permiso.faltantes?.[tabla] || []).length > 0));
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
    // Un DDL que espera el metadata lock de `reserva` (una transacción abierta) encola detrás
    // TODA consulta nueva a esa tabla: mejor fallar a los 10 s (queda FALLIDA y se vuelve a
    // correr, es idempotente) que esperar el año que trae MySQL por defecto.
    await connection.query("SET SESSION lock_wait_timeout = 10, innodb_lock_wait_timeout = 10");

    if (!opciones.checkOnly) {
      await asegurarRegistroMigraciones(connection);
      migracionRegistrada = true;
    }
    log("Firma de las condiciones de cancelación y «Pendiente de firma»");
    const resultado = await ejecutarMigracion(connection, {
      checkOnly: opciones.checkOnly,
      log,
      usuarioConectado: env.DB_USER,
    });
    // El esquema sí quedó aplicado (APLICADA), pero sin los permisos no se despliega el backend:
    // el bloque de abajo (require.main) sale con código 2.
    if (!opciones.checkOnly) resultado.grantsIncompletos = grantsIncompletos(resultado.grants);
    if (migracionRegistrada) {
      await marcarMigracion(connection, "APLICADA", detalleRegistro(resultado).slice(0, 2000));
    }
    if (opciones.checkOnly) {
      log(`Chequeo completado sin cambios (${resultado.pendientes.length} cambio(s) pendiente(s)).`);
    } else if (resultado.grantsIncompletos) {
      log(`Migracion ${MIGRATION_ID} aplicada, PERO los permisos de ${USUARIO_RUNTIME} sobre las tablas nuevas no quedaron ` +
        "confirmados (ver los avisos de arriba). Sin ellos el backend nuevo responde 500: corré los GRANT con la cuenta " +
        "administrativa y confirmalos con SHOW GRANTS antes de desplegar el backend.");
    } else {
      log(`Migracion ${MIGRATION_ID} aplicada.`);
    }
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
  main()
    .then((resultado) => {
      // Aplicada sin los permisos del runtime confirmados: que el operador no siga de largo.
      if (resultado?.grantsIncompletos) process.exitCode = 2;
    })
    .catch((error) => {
      console.error("Error en la migracion de la firma de condiciones:", error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  BACKFILL,
  COLUMNAS,
  ESTADO_PENDIENTE_FIRMA,
  INDICES,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_LOCK,
  PRIVILEGIOS_TABLAS_EXISTENTES,
  TABLAS_EXISTENTES_RUNTIME,
  TABLAS_NUEVAS,
  USUARIO_RUNTIME,
  ejecutarMigracion,
  esquemaCoincide,
  main,
  parsearArgumentos,
  planColumnas,
  privilegiosDeGrant,
  revisarCatalogo,
  sqlGrants,
  validarDestino,
};
