// Migración "Noticias fuera de la portada pública" (2026-10-08).
//
// Una noticia dirigida a algunas departamentales puede quedar sólo en el portal de esas
// departamentales, sin salir en la portada pública. Lo que va a todas las departamentales
// sale siempre en la portada.
//
// 1. Agrega noticia.en_portada_publica TINYINT(1) NOT NULL DEFAULT 1 (después de
//    alcance_todas). Todas las noticias existentes quedan en 1: la portada no cambia.
//    No necesita GRANT: el runtime ya tiene DML a nivel tabla sobre noticia.
// 2. Informa (sin corregir) noticias inconsistentes: fuera de la portada pero destacadas,
//    o fuera de la portada con alcance a todas las departamentales.
//
// Requiere la migración de noticias por departamental (noticia.alcance_todas).
// Es idempotente: se puede correr las veces que haga falta.
//
// Uso:
//   node scripts/migrar-noticias-portada-publica.js                     → develop
//   node scripts/migrar-noticias-portada-publica.js --allow-production  → obligatorio si DB_HOST no es localhost
//
// Develop (dotenv no pisa variables ya definidas; el bloque activo del .env apunta a la RDS):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb npm run migrate:noticias-portada-publica
// Producción (con la cuenta administrativa de la RDS, que es la del bloque activo del .env):
//   npm run migrate:noticias-portada-publica -- --allow-production
//
// Orden de deploy: correr esta migración ANTES de desplegar el backend nuevo (todas las
// consultas de noticias leen en_portada_publica: sin la columna responden 500).

require("dotenv").config();
const mysql = require("mysql2/promise");

const DDL_EN_PORTADA_PUBLICA = `
ALTER TABLE noticia
  ADD COLUMN en_portada_publica TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1 = sale en la portada pública; 0 = sólo en el portal de sus departamentales'
  AFTER alcance_todas
`;

const SQL_REVISAR_CONSISTENCIA = `
SELECT
  (SELECT COUNT(*) FROM noticia WHERE en_portada_publica = 0) AS fuera_de_portada,
  (SELECT COUNT(*) FROM noticia WHERE en_portada_publica = 0 AND destacada = 1) AS fuera_destacadas,
  (SELECT COUNT(*) FROM noticia WHERE en_portada_publica = 0 AND alcance_todas = 1) AS fuera_para_todas
`;

function parsearArgumentos(args = []) {
  return { permiteProduccion: args.includes("--allow-production") };
}

function validarEntorno(env, { permiteProduccion = false } = {}) {
  for (const nombre of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[nombre]) throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  const esProduccion = !["localhost", "127.0.0.1"].includes(env.DB_HOST);
  if (esProduccion && !permiteProduccion) {
    throw new Error(`DB_HOST=${env.DB_HOST} no es localhost. Para correr contra producción agregá --allow-production.`);
  }
  return { esProduccion };
}

async function existeColumna(connection, tabla, columna) {
  const [filas] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tabla, columna]
  );
  return filas.length > 0;
}

// Todo el trabajo sobre una conexión ya abierta (las pruebas pasan una conexión falsa).
async function ejecutarMigracion(connection, { log = console.log, warn = console.warn } = {}) {
  if (!(await existeColumna(connection, "noticia", "alcance_todas"))) {
    throw new Error("Falta noticia.alcance_todas: corré antes npm run migrate:noticias-departamentales");
  }

  const resultado = { columnaCreada: false, consistencia: null };
  log("Agregando noticia.en_portada_publica (si no existe)...");
  if (await existeColumna(connection, "noticia", "en_portada_publica")) {
    log("  ✔ en_portada_publica (ya existía: no se tocan las noticias)");
  } else {
    await connection.query(DDL_EN_PORTADA_PUBLICA);
    resultado.columnaCreada = true;
    log("  ✔ en_portada_publica (creada; todas las noticias siguen en la portada)");
  }

  const [[fila]] = await connection.query(SQL_REVISAR_CONSISTENCIA);
  resultado.consistencia = {
    fuera_de_portada: Number(fila?.fuera_de_portada || 0),
    fuera_destacadas: Number(fila?.fuera_destacadas || 0),
    fuera_para_todas: Number(fila?.fuera_para_todas || 0),
  };
  const c = resultado.consistencia;
  log(`  · Noticias fuera de la portada pública: ${c.fuera_de_portada}`);
  if (c.fuera_destacadas > 0) {
    warn(`  · Aviso: ${c.fuera_destacadas} noticia(s) fuera de la portada siguen destacadas: no se ven en el carrusel.`);
  }
  if (c.fuera_para_todas > 0) {
    warn(`  · Aviso: ${c.fuera_para_todas} noticia(s) para todas las departamentales están fuera de la portada.`);
  }
  log("Esquema listo.");
  return resultado;
}

async function main({
  argv = process.argv,
  env = process.env,
  conectar = (config) => mysql.createConnection(config),
  log = console.log,
  warn = console.warn,
} = {}) {
  const opciones = parsearArgumentos(argv.slice(2));
  validarEntorno(env, opciones);

  log(`Conectando a ${env.DB_HOST}/${env.DB_DATABASE} como ${env.DB_USER}...`);
  const connection = await conectar({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    port: env.DB_PORT || 3306,
    timezone: "-03:00",
  });

  try {
    return await ejecutarMigracion(connection, { log, warn });
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("Migración de noticias fuera de la portada pública finalizada.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Error en la migración de noticias fuera de la portada pública:", error.message);
      process.exit(1);
    });
}

module.exports = {
  DDL_EN_PORTADA_PUBLICA,
  SQL_REVISAR_CONSISTENCIA,
  ejecutarMigracion,
  main,
  parsearArgumentos,
  validarEntorno,
};
