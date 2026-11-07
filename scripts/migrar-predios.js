// Migración de Predios (sistemas locales de los campings: Camping Miramar, y después el
// Parador de la Montaña).
//
// Crea de forma idempotente:
//   - predio, predio_instalacion, predio_comando, predio_evento, predio_secuencia
//   - las tablas réplica del sistema local (predio_boca, predio_producto, predio_venta…),
//     generadas desde predios/lib/esquema.js: mismas columnas que la base SQLite del camping.
//   - el predio MIRAMAR con sus 14 bocas de expendio y cajas iniciales.
//   - GRANT DML al usuario de la aplicación (miajb_runtime) en cada host que tenga.
//
// Uso:
//   node scripts/migrar-predios.js                     → develop (DB_* del .env)
//   node scripts/migrar-predios.js --check             → sólo informa qué falta
//   node scripts/migrar-predios.js --allow-production  → obligatorio si DB_HOST no es localhost
// Las credenciales pueden venir por entorno (dotenv no pisa lo ya definido):
//   DB_HOST=… DB_USER=admin DB_PASSWORD=… node scripts/migrar-predios.js --allow-production

require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("node:fs");
const { TABLAS, NOMBRES_TABLAS, columnasDe, tipoSql, ddlTabla } = require("../predios/lib/esquema");
const { crearMysql } = require("../predios/lib/db-mysql");
const { sembrarPredio, PREDIOS } = require("../predios/lib/semilla");

const args = process.argv.slice(2);
const soloRevisar = args.includes("--check");
const permiteProduccion = args.includes("--allow-production");
const USUARIO_RUNTIME = "miajb_runtime";

const DDL_CENTRALES = {
  recepcion_reserva_recurso: require("./migrar-recepcion-recursos").DDL_RECURSOS,
  recepcion_vehiculo: require("./migrar-recepcion-vehiculos").DDL_VEHICULOS,
  recepcion_reserva_qr: require("./migrar-recepcion-qr").DDL_QR,
  predio_inventario_envio: require("./migrar-predios-operacion").DDL_ENVIOS,
  recepcion_particular: `CREATE TABLE IF NOT EXISTS recepcion_particular (usuario_id INT NOT NULL PRIMARY KEY, predio_id INT NOT NULL, creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
  recepcion_reserva_evento: `CREATE TABLE IF NOT EXISTS recepcion_reserva_evento (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, predio_id INT NOT NULL, reserva_id INT NOT NULL,
    operacion VARCHAR(64) NOT NULL, huella CHAR(64) NOT NULL, actor VARCHAR(140) NOT NULL,
    empleado_id INT NULL, fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    anterior MEDIUMTEXT, actual MEDIUMTEXT NOT NULL, motivo VARCHAR(255),
    UNIQUE KEY uq_recepcion_peticion(predio_id,operacion), KEY ix_recepcion_reserva(reserva_id,id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  predio: `CREATE TABLE IF NOT EXISTS predio (
    id INT NOT NULL AUTO_INCREMENT,
    codigo VARCHAR(30) NOT NULL,
    nombre VARCHAR(120) NOT NULL,
    tipo VARCHAR(30) NOT NULL DEFAULT 'CAMPING',
    servicio_codigos VARCHAR(500) NULL COMMENT 'JSON con los códigos de servicio de turismo del predio',
    activo TINYINT(1) NOT NULL DEFAULT 1,
    escritor ENUM('CENTRAL','LOCAL') NOT NULL DEFAULT 'CENTRAL' COMMENT 'Quién es dueño de los datos: el sistema general hasta que se instala la notebook',
    instancia_id VARCHAR(64) NULL,
    equipo_id VARCHAR(64) NULL,
    version_local VARCHAR(60) NULL,
    equipo VARCHAR(120) NULL,
    ultima_conexion DATETIME NULL,
    ultimo_push DATETIME NULL,
    ultimo_seq BIGINT NOT NULL DEFAULT 0,
    pendientes_local INT NOT NULL DEFAULT 0,
    ultima_escritura_central DATETIME NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_predio_codigo (codigo)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  predio_instalacion: `CREATE TABLE IF NOT EXISTS predio_instalacion (
    id INT NOT NULL AUTO_INCREMENT,
    predio_id INT NOT NULL,
    nombre VARCHAR(120) NULL,
    token_hash CHAR(64) NOT NULL,
    creado_por INT NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ultimo_uso DATETIME NULL,
    ultima_ip VARCHAR(45) NULL,
    instancia_id VARCHAR(64) NULL,
    revocado_en DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_predio_instalacion_token (token_hash),
    KEY ix_predio_instalacion_predio (predio_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  predio_comando: `CREATE TABLE IF NOT EXISTS predio_comando (
    id INT NOT NULL AUTO_INCREMENT,
    predio_id INT NOT NULL,
    tipo ENUM('API','SISTEMA') NOT NULL DEFAULT 'API',
    metodo VARCHAR(10) NULL,
    ruta VARCHAR(255) NOT NULL,
    cuerpo MEDIUMTEXT NULL,
    query TEXT NULL,
    actor TEXT NULL,
    descripcion VARCHAR(255) NULL,
    estado ENUM('PENDIENTE','ENTREGADO','OK','ERROR','CANCELADO') NOT NULL DEFAULT 'PENDIENTE',
    intentos INT NOT NULL DEFAULT 0,
    resultado MEDIUMTEXT NULL,
    status INT NULL,
    creado_por INT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    entregado_en DATETIME NULL,
    resuelto_en DATETIME NULL,
    PRIMARY KEY (id),
    KEY ix_predio_comando_estado (predio_id, estado, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  predio_evento: `CREATE TABLE IF NOT EXISTS predio_evento (
    id INT NOT NULL AUTO_INCREMENT,
    predio_id INT NOT NULL,
    fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tipo VARCHAR(40) NOT NULL,
    detalle TEXT NULL,
    usuario_id INT NULL,
    PRIMARY KEY (id),
    KEY ix_predio_evento (predio_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  predio_secuencia: `CREATE TABLE IF NOT EXISTS predio_secuencia (
    predio_id INT NOT NULL,
    tabla VARCHAR(64) NOT NULL,
    ultimo INT NOT NULL,
    PRIMARY KEY (predio_id, tabla)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
};

const TODAS = [...Object.keys(DDL_CENTRALES), ...NOMBRES_TABLAS];

async function tablaExiste(c, tabla) {
  const [r] = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [tabla]);
  return r.length > 0;
}

async function columnasExistentes(c, tabla) {
  const [r] = await c.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [tabla]);
  return new Set(r.map((f) => f.c || f.C || f.COLUMN_NAME));
}

async function hostsRuntime(c) {
  try {
    const [r] = await c.query("SELECT host FROM mysql.user WHERE user = ?", [USUARIO_RUNTIME]);
    return r.map((f) => f.host);
  } catch (_e) {
    return [];
  }
}

async function main() {
  const host = String(process.env.DB_HOST || "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !permiteProduccion) {
    throw new Error(`DB_HOST=${host} no es local. Para correr contra producción agregá --allow-production.`);
  }
  const c = await mysql.createConnection({
    host, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
    port: Number(process.env.DB_PORT || 3306), timezone: "-03:00", dateStrings: true, decimalNumbers: true,
    ssl: String(process.env.DB_SSL_MODE || "disabled").toLowerCase() === "disabled" ? undefined
      : { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true },
  });
  await c.query("SET SESSION time_zone = '-03:00'");
  console.log(`Base: ${process.env.DB_DATABASE} en ${host} (usuario ${process.env.DB_USER})`);
  const faltantes = [];
  for (const t of TODAS) if (!(await tablaExiste(c, t))) faltantes.push(t);
  const columnasFaltantes = [];
  if (!faltantes.includes("predio") && !(await columnasExistentes(c, "predio")).has("equipo_id")) columnasFaltantes.push("predio.equipo_id");
  for (const t of NOMBRES_TABLAS) {
    if (faltantes.includes(t)) continue;
    const existentes = await columnasExistentes(c, t);
    for (const col of Object.keys(columnasDe(t))) if (!existentes.has(col)) columnasFaltantes.push(`${t}.${col}`);
  }
  console.log(`Tablas faltantes: ${faltantes.length ? faltantes.join(", ") : "ninguna"}`);
  console.log(`Columnas faltantes: ${columnasFaltantes.length ? columnasFaltantes.join(", ") : "ninguna"}`);
  if (soloRevisar) { await c.end(); return; }

  for (const [t, ddl] of Object.entries(DDL_CENTRALES)) await c.query(ddl);
  // QR por reserva: las etiquetas de vehículo ya impresas apuntan a su reserva.
  const etiquetas = await require("./migrar-recepcion-qr").copiarEtiquetas(c);
  if (etiquetas) console.log(`  + ${etiquetas} etiquetas QR anteriores pasan a su reserva`);
  // Precios de adicionales por reglas (catálogo del predio y temporadas): ver migrar-adicionales-precios.js.
  await require("./migrar-adicionales-precios").aplicarEsquema(c);
  if (!(await columnasExistentes(c, "predio")).has("equipo_id")) await c.query("ALTER TABLE predio ADD COLUMN equipo_id VARCHAR(64) NULL");
  for (const t of NOMBRES_TABLAS) {
    await c.query(ddlTabla(t, "mysql"));
    const existentes = await columnasExistentes(c, t);
    for (const [col, tipo] of Object.entries(columnasDe(t))) {
      if (!existentes.has(col)) {
        await c.query(`ALTER TABLE \`${t}\` ADD COLUMN \`${col}\` ${tipoSql(tipo, "mysql")}`);
        console.log(`  + ${t}.${col}`);
      }
    }
  }
  console.log(`✔ ${TODAS.length} tablas listas`);

  // Predio Miramar
  const [existe] = await c.query("SELECT id FROM predio WHERE codigo = 'MIRAMAR'");
  let predioId = existe[0]?.id;
  if (!predioId) {
    const [r] = await c.query(
      "INSERT INTO predio (codigo, nombre, tipo, servicio_codigos, escritor) VALUES ('MIRAMAR', ?, 'CAMPING', ?, 'CENTRAL')",
      [PREDIOS.MIRAMAR.nombre, JSON.stringify(PREDIOS.MIRAMAR.servicios)]);
    predioId = r.insertId;
    await c.query("INSERT INTO predio_evento (predio_id, tipo, detalle) VALUES (?, 'ALTA', 'Predio creado por la migración')", [predioId]);
    console.log(`✔ Predio MIRAMAR creado (id ${predioId})`);
  }
  // Las semillas usan la misma lógica de negocio que el camping (adaptador MySQL).
  const poolFalso = {
    query: (...a) => c.query(...a),
    getConnection: async () => ({ query: (...a) => c.query(...a), beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(), release: () => {} }),
  };
  const db = crearMysql(poolFalso, { predioId });
  const resumen = await db.tx((t) => sembrarPredio(t, { db: t, pid: predioId }, "MIRAMAR"));
  console.log(`✔ Semilla MIRAMAR: ${resumen.bocas} bocas y ${resumen.cajas} cajas nuevas`);
  if (resumen.bocas || resumen.cajas) await c.query("UPDATE predio SET ultima_escritura_central = NOW() WHERE id = ?", [predioId]);

  // Permisos del usuario de la aplicación.
  const hosts = await hostsRuntime(c);
  if (!hosts.length) console.log(`(No se encontró ${USUARIO_RUNTIME} en mysql.user: se omiten los GRANT)`);
  for (const h of hosts) {
    for (const t of TODAS) {
      await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${process.env.DB_DATABASE}\`.\`${t}\` TO ?@?`, [USUARIO_RUNTIME, h]);
    }
    console.log(`✔ GRANT DML sobre ${TODAS.length} tablas a ${USUARIO_RUNTIME}@${h}`);
  }
  if (hosts.length) await c.query("FLUSH PRIVILEGES");
  await c.end();
}

if (require.main === module) main().catch((e) => {
  console.error("✘", e.message);
  process.exit(1);
});

module.exports = { TODAS, TABLAS, DDL_CENTRALES };
