// Migración "Noticias por departamental" (2026-10-08).
//
// Prensa / admin eligen en qué portales departamentales se ve cada noticia: en todas las
// departamentales o en una lista de ellas. El afiliado ve, en /departamental, las noticias
// de SU departamental más las que van a todas.
//
// 1. Agrega noticia.alcance_todas TINYINT(1) NOT NULL DEFAULT 1 (después de departamental_id).
//    1 = la noticia se ve en el portal de todas las departamentales.
//    Carga inicial: las noticias que ya tenían una departamental pasan a alcance_todas = 0
//    (sólo esa departamental); las de departamental NULL quedan en 1 ("todas").
//    La carga inicial corre únicamente mientras la migración no completó su primera corrida
//    (columna recién creada o tabla puente todavía inexistente): si se vuelve a correr
//    después, no pisa lo que la redacción haya decidido. Que la condición mire también la
//    tabla puente hace que un corte entre el ALTER y el UPDATE no deje la carga a medias.
// 2. Crea la tabla puente noticia_departamental (noticia_id, departamental_id).
// 3. Rellena la tabla puente para las noticias con alcance_todas = 0 y departamental_id
//    cargado que todavía no tengan filas puente.
// 4. Otorga SELECT, INSERT, UPDATE, DELETE sobre noticia_departamental al usuario runtime
//    (miajb_runtime) en todos los hosts que figuren en mysql.user ('localhost' y
//    '127.0.0.1' en develop, la IP privada del EC2 en la RDS) + FLUSH PRIVILEGES. La columna
//    nueva no necesita GRANT: el runtime ya tiene DML a nivel tabla sobre noticia.
// 5. Informa (sin corregir) noticias inconsistentes: alcance_todas = 0 sin filas puente, o
//    alcance_todas = 1 con departamental_id cargado (las escribiría el backend VIEJO si se
//    edita una noticia entre esta migración y el deploy del backend nuevo).
//
// La columna heredada noticia.departamental_id se mantiene: el backend nuevo la sincroniza
// con el id cuando hay EXACTAMENTE una departamental elegida (y alcance_todas = 0) y la deja
// en NULL en cualquier otro caso.
//
// Es idempotente: se puede correr las veces que haga falta.
//
// Uso:
//   node scripts/migrar-noticias-departamentales.js                     → esquema + GRANTs (develop)
//   node scripts/migrar-noticias-departamentales.js --skip-grants       → esquema, sin intentar los GRANTs
//   node scripts/migrar-noticias-departamentales.js --allow-production  → obligatorio si DB_HOST no es localhost
//
// Develop (dotenv no pisa variables ya definidas; el bloque activo del .env apunta a la RDS):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb npm run migrate:noticias-departamentales
// Producción (con la cuenta administrativa de la RDS, que es la del bloque activo del .env):
//   npm run migrate:noticias-departamentales -- --allow-production
//
// Orden de deploy: correr esta migración ANTES de desplegar el backend nuevo. Todas las
// consultas de noticias (también las de la portada pública) leen alcance_todas y
// noticia_departamental: sin la migración, esos endpoints responden 500.

require("dotenv").config();
const mysql = require("mysql2/promise");

const USUARIO_RUNTIME = "miajb_runtime";
const HOST_RUNTIME = "localhost";

const TABLAS_CON_GRANT = ["noticia_departamental"];

const DDL_ALCANCE_TODAS = `
ALTER TABLE noticia
  ADD COLUMN alcance_todas TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1 = se ve en el portal de todas las departamentales; 0 = sólo en las de noticia_departamental'
  AFTER departamental_id
`;

// Carga inicial: las noticias con una departamental quedan sólo para esa departamental.
// fecha_modificacion se asigna a sí misma para que el ON UPDATE CURRENT_TIMESTAMP no la
// pise: la migración no es una edición de la redacción.
const SQL_ALCANCE_INICIAL = `
UPDATE noticia
SET alcance_todas = 0, fecha_modificacion = fecha_modificacion
WHERE departamental_id IS NOT NULL AND alcance_todas <> 0
`;

const DDL_NOTICIA_DEPARTAMENTAL = `
CREATE TABLE IF NOT EXISTS noticia_departamental (
  noticia_id INT NOT NULL,
  departamental_id INT NOT NULL,
  PRIMARY KEY (noticia_id, departamental_id),
  KEY idx_noticia_departamental_dep (departamental_id, noticia_id),
  CONSTRAINT fk_noticia_departamental_noticia FOREIGN KEY (noticia_id)
    REFERENCES noticia (id) ON DELETE CASCADE,
  CONSTRAINT fk_noticia_departamental_departamental FOREIGN KEY (departamental_id)
    REFERENCES departamental (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Portales departamentales en los que se ve una noticia con alcance_todas = 0'
`;

const SQL_RELLENAR_PUENTE = `
INSERT INTO noticia_departamental (noticia_id, departamental_id)
SELECT n.id, n.departamental_id
FROM noticia n
WHERE n.alcance_todas = 0
  AND n.departamental_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM noticia_departamental nd WHERE nd.noticia_id = n.id)
`;

const SQL_REVISAR_CONSISTENCIA = `
SELECT
  (SELECT COUNT(*) FROM noticia WHERE alcance_todas = 1) AS todas,
  (SELECT COUNT(*) FROM noticia WHERE alcance_todas = 0) AS especificas,
  (SELECT COUNT(*) FROM noticia_departamental) AS filas_puente,
  (SELECT COUNT(*) FROM noticia n
     WHERE n.alcance_todas = 0
       AND NOT EXISTS (SELECT 1 FROM noticia_departamental nd WHERE nd.noticia_id = n.id)) AS especificas_sin_departamental,
  (SELECT COUNT(*) FROM noticia WHERE alcance_todas = 1 AND departamental_id IS NOT NULL) AS todas_con_departamental
`;

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

function parsearArgumentos(args = []) {
  return {
    permiteProduccion: args.includes("--allow-production"),
    omiteGrants: args.includes("--skip-grants"),
  };
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

async function existeTabla(connection, tabla) {
  const [filas] = await connection.query(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1",
    [tabla]
  );
  return filas.length > 0;
}

async function existeColumna(connection, tabla, columna) {
  const [filas] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tabla, columna]
  );
  return filas.length > 0;
}

// El runtime existe en las dos bases con hosts distintos: se buscan en mysql.user
// para no adivinarlos.
async function cuentasRuntime(connection) {
  try {
    const [filas] = await connection.query("SELECT user, host FROM mysql.user WHERE user = ?", [USUARIO_RUNTIME]);
    if (filas.length > 0) return filas.map((fila) => ({ user: fila.user, host: fila.host }));
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
  }
  return [{ user: USUARIO_RUNTIME, host: HOST_RUNTIME }];
}

function sqlGrants(cuentas, database) {
  const esquema = mysql.escapeId(database);
  const sentencias = [];
  for (const cuenta of cuentas) {
    const destino = `${mysql.escape(cuenta.user)}@${mysql.escape(cuenta.host)}`;
    for (const tabla of TABLAS_CON_GRANT) {
      sentencias.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${esquema}.${mysql.escapeId(tabla)} TO ${destino}`);
    }
  }
  return sentencias;
}

async function otorgarGrantsRuntime(connection, env, { log = console.log, warn = console.warn } = {}) {
  if (env.DB_USER === USUARIO_RUNTIME) {
    warn(
      `  · Conectado como ${USUARIO_RUNTIME}: no puede otorgarse permisos a sí mismo. ` +
        "Corré la migración con la cuenta administrativa (root local / admin de la RDS)."
    );
    return { otorgados: [], omitidos: true };
  }
  const cuentas = await cuentasRuntime(connection);
  const etiqueta = cuentas.map((cuenta) => `'${cuenta.user}'@'${cuenta.host}'`).join(", ");
  const sentencias = sqlGrants(cuentas, env.DB_DATABASE);
  try {
    for (const sentencia of sentencias) {
      await connection.query(sentencia);
    }
    await connection.query("FLUSH PRIVILEGES");
    log(`  ✔ GRANT SELECT, INSERT, UPDATE, DELETE sobre ${TABLAS_CON_GRANT.join(", ")} a ${etiqueta} + FLUSH PRIVILEGES`);
    return { otorgados: sentencias, omitidos: false };
  } catch (error) {
    if (!CODIGOS_SIN_PERMISO_GRANT.has(error.code)) throw error;
    warn(
      `  · Aviso: no se pudieron otorgar los permisos a ${etiqueta} (${error.code}: ${error.message}).\n` +
        "    El esquema quedó creado igual. Corré con la cuenta administrativa:\n" +
        sentencias.map((sentencia) => `      ${sentencia};`).join("\n") +
        "\n      FLUSH PRIVILEGES;"
    );
    return { otorgados: [], omitidos: true };
  }
}

// Todo el trabajo sobre una conexión ya abierta (las pruebas pasan una conexión falsa).
async function ejecutarMigracion(connection, {
  env = process.env,
  omiteGrants = false,
  log = console.log,
  warn = console.warn,
} = {}) {
  const resultado = {
    columnaCreada: false,
    cargaInicial: null,
    tablaCreada: false,
    filasPuenteAgregadas: 0,
    consistencia: null,
    grants: null,
  };

  // 1. noticia.alcance_todas (+ carga inicial sólo en la primera corrida)
  const habiaColumna = await existeColumna(connection, "noticia", "alcance_todas");
  const habiaTabla = await existeTabla(connection, "noticia_departamental");
  log("Agregando noticia.alcance_todas (si no existe)...");
  if (habiaColumna) {
    log("  ✔ alcance_todas (ya existía)");
  } else {
    await connection.query(DDL_ALCANCE_TODAS);
    resultado.columnaCreada = true;
    log("  ✔ alcance_todas (creada)");
  }
  if (!habiaColumna || !habiaTabla) {
    const [actualizacion] = await connection.query(SQL_ALCANCE_INICIAL);
    resultado.cargaInicial = Number(actualizacion?.affectedRows || 0);
    log(`  ✔ Carga inicial: ${resultado.cargaInicial} noticia(s) con departamental pasan a verse sólo en esa departamental`);
  } else {
    log("  · Sin carga inicial: la migración ya había corrido (no se pisa el alcance elegido por la redacción)");
  }

  // 2. noticia_departamental
  log("Creando tabla noticia_departamental (si no existe)...");
  await connection.query(DDL_NOTICIA_DEPARTAMENTAL);
  if (!(await existeTabla(connection, "noticia_departamental"))) {
    throw new Error("No se pudo verificar la tabla noticia_departamental");
  }
  resultado.tablaCreada = !habiaTabla;
  log(`  ✔ noticia_departamental${habiaTabla ? " (ya existía)" : " (creada)"}`);

  // 3. Relleno de la tabla puente
  const [relleno] = await connection.query(SQL_RELLENAR_PUENTE);
  resultado.filasPuenteAgregadas = Number(relleno?.affectedRows || 0);
  log(`  ✔ Tabla puente: ${resultado.filasPuenteAgregadas} fila(s) agregada(s) desde departamental_id`);

  // 4. Revisión de consistencia (sólo informa)
  const [[consistencia]] = await connection.query(SQL_REVISAR_CONSISTENCIA);
  resultado.consistencia = {
    todas: Number(consistencia?.todas || 0),
    especificas: Number(consistencia?.especificas || 0),
    filas_puente: Number(consistencia?.filas_puente || 0),
    especificas_sin_departamental: Number(consistencia?.especificas_sin_departamental || 0),
    todas_con_departamental: Number(consistencia?.todas_con_departamental || 0),
  };
  const c = resultado.consistencia;
  log(`  · Noticias para todas las departamentales: ${c.todas} · para algunas: ${c.especificas} · filas puente: ${c.filas_puente}`);
  if (c.especificas_sin_departamental > 0) {
    warn(
      `  · Aviso: ${c.especificas_sin_departamental} noticia(s) con alcance_todas = 0 no tienen departamentales: ` +
        "no se ven en ningún portal departamental. Revisalas desde el editor."
    );
  }
  if (c.todas_con_departamental > 0) {
    warn(
      `  · Aviso: ${c.todas_con_departamental} noticia(s) con alcance_todas = 1 conservan departamental_id ` +
        "(probablemente editadas con el backend anterior). Se ven en todas las departamentales; si la intención era " +
        "una sola, corregilas desde el editor."
    );
  }
  log("Esquema listo.");

  // 5. GRANTs al runtime. En producción el backend TAMBIÉN corre como miajb_runtime
  // (desde la IP privada del EC2): sin estos permisos los endpoints de noticias dan 500.
  if (omiteGrants) {
    log("Se omite el intento de GRANTs (--skip-grants).");
    return resultado;
  }
  log(`Otorgando DML sobre las tablas nuevas a '${USUARIO_RUNTIME}'...`);
  resultado.grants = await otorgarGrantsRuntime(connection, env, { log, warn });
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
    return await ejecutarMigracion(connection, { env, omiteGrants: opciones.omiteGrants, log, warn });
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("Migración de noticias por departamental finalizada.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Error en la migración de noticias por departamental:", error.message);
      process.exit(1);
    });
}

module.exports = {
  CODIGOS_SIN_PERMISO_GRANT,
  DDL_ALCANCE_TODAS,
  DDL_NOTICIA_DEPARTAMENTAL,
  SQL_ALCANCE_INICIAL,
  SQL_RELLENAR_PUENTE,
  SQL_REVISAR_CONSISTENCIA,
  TABLAS_CON_GRANT,
  USUARIO_RUNTIME,
  ejecutarMigracion,
  main,
  parsearArgumentos,
  sqlGrants,
  validarEntorno,
};
