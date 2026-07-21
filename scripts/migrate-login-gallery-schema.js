const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

const envPath = path.join(__dirname, "..", ".env");
const dbKeys = new Set(["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE", "DB_PORT"]);

function normalizarSeccion(linea) {
  return linea
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
}

function leerConfiguraciones() {
  const configuraciones = { production: {}, develop: {} };
  let seccion = null;

  for (const linea of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const seccionDetectada = normalizarSeccion(linea);
    if (seccionDetectada === "PRODUCCION") {
      seccion = "production";
      continue;
    }
    if (seccionDetectada === "DEVELOP") {
      seccion = "develop";
      continue;
    }
    if (!seccion) continue;

    const lineaVariable = linea.replace(/^\s*#\s*/, "");
    const parsed = dotenv.parse(lineaVariable);
    for (const [key, value] of Object.entries(parsed)) {
      if (dbKeys.has(key)) configuraciones[seccion][key] = value;
    }
  }

  for (const [nombre, config] of Object.entries(configuraciones)) {
    const faltantes = [...dbKeys].filter((key) => !config[key]);
    if (faltantes.length > 0) {
      throw new Error(`Faltan credenciales de ${nombre}: ${faltantes.join(", ")}`);
    }
  }
  return configuraciones;
}

async function inspeccionar(connection) {
  const [[databaseRow]] = await connection.query("SELECT DATABASE() AS database_name");
  const [tableRows] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_imagen'`
  );
  if (Number(tableRows[0].total) !== 1) {
    throw new Error(`La tabla login_imagen no existe en ${databaseRow.database_name}`);
  }
  const [columnRows] = await connection.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'login_imagen'
        AND COLUMN_NAME IN ('titulo', 'texto_alternativo')
      ORDER BY ORDINAL_POSITION`
  );
  return {
    database: databaseRow.database_name,
    columns: columnRows.map((row) => row.COLUMN_NAME),
  };
}

async function ejecutarEnEntorno(nombre, config, checkOnly) {
  const connection = await mysql.createConnection({
    host: config.DB_HOST,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_DATABASE,
    port: Number(config.DB_PORT),
  });

  try {
    const antes = await inspeccionar(connection);
    if (!checkOnly && antes.columns.length > 0) {
      const drops = antes.columns.map((column) => `DROP COLUMN \`${column}\``).join(", ");
      await connection.query(`ALTER TABLE login_imagen ${drops}`);
    }
    const despues = checkOnly ? antes : await inspeccionar(connection);
    return { environment: nombre, database: despues.database, columns: despues.columns };
  } finally {
    await connection.end();
  }
}

async function run() {
  const checkOnly = process.argv.includes("--check");
  const configuraciones = leerConfiguraciones();
  const results = [];

  for (const nombre of ["develop", "production"]) {
    results.push(await ejecutarEnEntorno(nombre, configuraciones[nombre], checkOnly));
  }

  console.log(JSON.stringify({ success: true, mode: checkOnly ? "check" : "migrate", results }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ success: false, code: error.code || error.name, message: error.message }));
  process.exit(1);
});
