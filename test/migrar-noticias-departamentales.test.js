"use strict";

// scripts/migrar-noticias-departamentales.js: noticia.alcance_todas + tabla puente
// noticia_departamental + GRANTs al runtime. Idempotente.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DDL_ALCANCE_TODAS,
  DDL_NOTICIA_DEPARTAMENTAL,
  SQL_ALCANCE_INICIAL,
  SQL_RELLENAR_PUENTE,
  TABLAS_CON_GRANT,
  ejecutarMigracion,
  main,
  parsearArgumentos,
  sqlGrants,
  validarEntorno,
} = require("../scripts/migrar-noticias-departamentales");

const ENV_DEVELOP = Object.freeze({
  DB_HOST: "localhost",
  DB_USER: "root",
  DB_PASSWORD: "secreto",
  DB_DATABASE: "db_miajb",
});

const CUENTAS_DEVELOP = [
  { user: "miajb_runtime", host: "127.0.0.1" },
  { user: "miajb_runtime", host: "localhost" },
];

const CONSISTENTE = { todas: 12, especificas: 3, filas_puente: 3, especificas_sin_departamental: 0, todas_con_departamental: 0 };

function errorMysql(code) {
  const error = new Error(`falla ${code}`);
  error.code = code;
  return error;
}

// Conexión falsa: `estado` ({ columna, tabla }) se actualiza con el ALTER y el CREATE,
// así dos corridas sobre el mismo estado prueban la idempotencia.
function conexionFalsa({
  estado = { columna: false, tabla: false },
  cuentas = CUENTAS_DEVELOP,
  consistencia = CONSISTENTE,
  cargaInicial = 3,
  relleno = 3,
  errorGrant = null,
  errorCuentas = null,
} = {}) {
  const consultas = [];
  return {
    estado,
    consultas,
    async query(sql, params = []) {
      const texto = String(sql).replace(/\s+/g, " ").trim();
      consultas.push({ sql: texto, params });
      if (/FROM information_schema\.COLUMNS/.test(texto)) {
        assert.deepEqual(params, ["noticia", "alcance_todas"]);
        return [estado.columna ? [{ 1: 1 }] : []];
      }
      if (/FROM information_schema\.TABLES/.test(texto)) {
        assert.deepEqual(params, ["noticia_departamental"]);
        return [estado.tabla ? [{ 1: 1 }] : []];
      }
      if (/^ALTER TABLE noticia ADD COLUMN alcance_todas/.test(texto)) {
        assert.equal(estado.columna, false, "no debe agregar la columna dos veces");
        estado.columna = true;
        return [{ affectedRows: 0 }];
      }
      if (/^UPDATE noticia SET alcance_todas = 0/.test(texto)) return [{ affectedRows: cargaInicial }];
      if (/^CREATE TABLE IF NOT EXISTS noticia_departamental/.test(texto)) {
        estado.tabla = true;
        return [{ affectedRows: 0 }];
      }
      if (/^INSERT INTO noticia_departamental/.test(texto)) return [{ affectedRows: relleno }];
      if (/AS todas_con_departamental$/.test(texto)) return [[consistencia]];
      if (/FROM mysql\.user/.test(texto)) {
        if (errorCuentas) throw errorCuentas;
        return [cuentas];
      }
      if (/^GRANT /.test(texto)) {
        if (errorGrant) throw errorGrant;
        return [{}];
      }
      if (texto === "FLUSH PRIVILEGES") return [{}];
      throw new Error(`SQL inesperado: ${texto}`);
    },
    async end() {
      consultas.push({ sql: "END", params: [] });
    },
  };
}

function tipo(sql) {
  if (/information_schema\.COLUMNS/.test(sql)) return "columna?";
  if (/information_schema\.TABLES/.test(sql)) return "tabla?";
  if (/^ALTER TABLE/.test(sql)) return "alter";
  if (/^UPDATE noticia/.test(sql)) return "carga_inicial";
  if (/^CREATE TABLE/.test(sql)) return "create";
  if (/^INSERT INTO noticia_departamental/.test(sql)) return "relleno";
  if (/todas_con_departamental$/.test(sql)) return "consistencia";
  if (/mysql\.user/.test(sql)) return "cuentas";
  if (/^GRANT/.test(sql)) return "grant";
  if (/^FLUSH/.test(sql)) return "flush";
  return sql;
}

const silencio = () => {};
const opcionesSilenciosas = { env: ENV_DEVELOP, log: silencio, warn: silencio };

test("el esquema respeta el contrato: columna, tabla puente, índices y claves foráneas", () => {
  assert.match(DDL_ALCANCE_TODAS, /ADD COLUMN alcance_todas TINYINT\(1\) NOT NULL DEFAULT 1/);
  assert.match(DDL_ALCANCE_TODAS, /AFTER departamental_id/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /CREATE TABLE IF NOT EXISTS noticia_departamental/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /noticia_id INT NOT NULL,\s+departamental_id INT NOT NULL/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /PRIMARY KEY \(noticia_id, departamental_id\)/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /KEY idx_noticia_departamental_dep \(departamental_id, noticia_id\)/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /FOREIGN KEY \(noticia_id\)\s+REFERENCES noticia \(id\) ON DELETE CASCADE/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /FOREIGN KEY \(departamental_id\)\s+REFERENCES departamental \(id\)/);
  assert.match(DDL_NOTICIA_DEPARTAMENTAL, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci/);
  assert.match(SQL_ALCANCE_INICIAL, /SET alcance_todas = 0, fecha_modificacion = fecha_modificacion\s+WHERE departamental_id IS NOT NULL/);
  assert.match(SQL_RELLENAR_PUENTE, /SELECT n\.id, n\.departamental_id/);
  assert.match(SQL_RELLENAR_PUENTE, /WHERE n\.alcance_todas = 0\s+AND n\.departamental_id IS NOT NULL/);
  assert.match(SQL_RELLENAR_PUENTE, /AND NOT EXISTS \(SELECT 1 FROM noticia_departamental nd WHERE nd\.noticia_id = n\.id\)/);
  assert.deepEqual(TABLAS_CON_GRANT, ["noticia_departamental"]);
});

test("la primera corrida crea la columna con la carga inicial, la tabla, el relleno y los GRANTs", async () => {
  const conexion = conexionFalsa();
  const resultado = await ejecutarMigracion(conexion, opcionesSilenciosas);

  assert.deepEqual(conexion.consultas.map(({ sql }) => tipo(sql)), [
    "columna?", "tabla?", "alter", "carga_inicial", "create", "tabla?", "relleno", "consistencia",
    "cuentas", "grant", "grant", "flush",
  ]);
  assert.equal(resultado.columnaCreada, true);
  assert.equal(resultado.cargaInicial, 3);
  assert.equal(resultado.tablaCreada, true);
  assert.equal(resultado.filasPuenteAgregadas, 3);
  assert.deepEqual(resultado.consistencia, CONSISTENTE);
  assert.deepEqual(resultado.grants.otorgados, [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`noticia_departamental` TO 'miajb_runtime'@'127.0.0.1'",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`noticia_departamental` TO 'miajb_runtime'@'localhost'",
  ]);
  // La carga inicial corre ANTES de crear la tabla puente (y del relleno).
  const orden = conexion.consultas.map(({ sql }) => tipo(sql));
  assert.ok(orden.indexOf("carga_inicial") < orden.indexOf("create"));
  assert.ok(orden.indexOf("create") < orden.indexOf("relleno"));
});

test("una segunda corrida no vuelve a agregar la columna ni pisa el alcance elegido", async () => {
  const estado = { columna: false, tabla: false };
  await ejecutarMigracion(conexionFalsa({ estado }), opcionesSilenciosas);
  assert.deepEqual(estado, { columna: true, tabla: true });

  const segunda = conexionFalsa({ estado, relleno: 0 });
  const resultado = await ejecutarMigracion(segunda, opcionesSilenciosas);

  const tipos = segunda.consultas.map(({ sql }) => tipo(sql));
  assert.equal(tipos.includes("alter"), false);
  assert.equal(tipos.includes("carga_inicial"), false);
  assert.deepEqual(tipos, [
    "columna?", "tabla?", "create", "tabla?", "relleno", "consistencia", "cuentas", "grant", "grant", "flush",
  ]);
  assert.equal(resultado.columnaCreada, false);
  assert.equal(resultado.cargaInicial, null);
  assert.equal(resultado.tablaCreada, false);
  assert.equal(resultado.filasPuenteAgregadas, 0);
});

test("si una corrida se cortó después del ALTER, la siguiente completa la carga inicial", async () => {
  const conexion = conexionFalsa({ estado: { columna: true, tabla: false }, cargaInicial: 2 });
  const resultado = await ejecutarMigracion(conexion, opcionesSilenciosas);

  const tipos = conexion.consultas.map(({ sql }) => tipo(sql));
  assert.equal(tipos.includes("alter"), false);
  assert.equal(tipos.includes("carga_inicial"), true);
  assert.equal(resultado.cargaInicial, 2);
  assert.equal(resultado.tablaCreada, true);
});

test("--skip-grants deja el esquema listo sin intentar permisos", async () => {
  const conexion = conexionFalsa();
  const resultado = await ejecutarMigracion(conexion, { ...opcionesSilenciosas, omiteGrants: true });

  const tipos = conexion.consultas.map(({ sql }) => tipo(sql));
  assert.equal(tipos.some((t) => ["cuentas", "grant", "flush"].includes(t)), false);
  assert.equal(resultado.grants, null);
  assert.deepEqual(parsearArgumentos(["--skip-grants"]), { permiteProduccion: false, omiteGrants: true });
  assert.deepEqual(parsearArgumentos(["--allow-production"]), { permiteProduccion: true, omiteGrants: false });
});

test("conectado como el runtime no intenta otorgarse permisos a sí mismo", async () => {
  const avisos = [];
  const conexion = conexionFalsa();
  const resultado = await ejecutarMigracion(conexion, {
    env: { ...ENV_DEVELOP, DB_USER: "miajb_runtime" },
    log: silencio,
    warn: (mensaje) => avisos.push(mensaje),
  });

  assert.deepEqual(resultado.grants, { otorgados: [], omitidos: true });
  assert.equal(conexion.consultas.some(({ sql }) => /^GRANT|mysql\.user/.test(sql)), false);
  assert.match(avisos.join("\n"), /no puede otorgarse permisos a sí mismo/);
});

test("sin permiso para otorgar avisa con las sentencias a correr y no corta la migración", async () => {
  const avisos = [];
  const conexion = conexionFalsa({ errorGrant: errorMysql("ER_TABLEACCESS_DENIED_ERROR") });
  const resultado = await ejecutarMigracion(conexion, {
    env: ENV_DEVELOP,
    log: silencio,
    warn: (mensaje) => avisos.push(mensaje),
  });

  assert.deepEqual(resultado.grants, { otorgados: [], omitidos: true });
  assert.match(avisos.join("\n"), /GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`\.`noticia_departamental` TO 'miajb_runtime'@'localhost';/);
  assert.match(avisos.join("\n"), /FLUSH PRIVILEGES;/);

  await assert.rejects(
    ejecutarMigracion(conexionFalsa({ errorGrant: errorMysql("ER_PARSE_ERROR") }), opcionesSilenciosas),
    /falla ER_PARSE_ERROR/
  );
});

test("si no puede leer mysql.user otorga al runtime en localhost", async () => {
  const conexion = conexionFalsa({ errorCuentas: errorMysql("ER_TABLEACCESS_DENIED_ERROR") });
  const resultado = await ejecutarMigracion(conexion, opcionesSilenciosas);
  assert.deepEqual(resultado.grants.otorgados, [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`noticia_departamental` TO 'miajb_runtime'@'localhost'",
  ]);

  const vacia = await ejecutarMigracion(conexionFalsa({ cuentas: [] }), opcionesSilenciosas);
  assert.equal(vacia.grants.otorgados.length, 1);
});

test("los GRANTs escapan base, tabla y cuentas (IP privada del EC2 en la RDS)", () => {
  assert.deepEqual(sqlGrants([{ user: "miajb_runtime", host: "172.30.0.159" }], "db_miajb"), [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`noticia_departamental` TO 'miajb_runtime'@'172.30.0.159'",
  ]);
  assert.deepEqual(sqlGrants([{ user: "o'x", host: "%" }], "db`raro"), [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db``raro`.`noticia_departamental` TO 'o\\'x'@'%'",
  ]);
});

test("la revisión de consistencia avisa noticias sin departamentales o con departamental_id huérfano", async () => {
  const avisos = [];
  await ejecutarMigracion(
    conexionFalsa({ consistencia: { ...CONSISTENTE, especificas_sin_departamental: 1, todas_con_departamental: 2 } }),
    { env: ENV_DEVELOP, log: silencio, warn: (mensaje) => avisos.push(mensaje), omiteGrants: true }
  );
  assert.equal(avisos.length, 2);
  assert.match(avisos[0], /1 noticia\(s\) con alcance_todas = 0 no tienen departamentales/);
  assert.match(avisos[1], /2 noticia\(s\) con alcance_todas = 1 conservan departamental_id/);

  const sinAvisos = [];
  await ejecutarMigracion(conexionFalsa(), { env: ENV_DEVELOP, log: silencio, warn: (m) => sinAvisos.push(m), omiteGrants: true });
  assert.deepEqual(sinAvisos, []);
});

test("main exige las variables y --allow-production fuera de localhost, sin conectarse", async () => {
  let conexiones = 0;
  const conectar = async () => {
    conexiones += 1;
    return conexionFalsa();
  };

  await assert.rejects(
    main({ argv: ["node", "script"], env: { ...ENV_DEVELOP, DB_HOST: "miajb.xxxx.us-east-1.rds.amazonaws.com" }, conectar, log: silencio }),
    /--allow-production/
  );
  await assert.rejects(
    main({ argv: ["node", "script"], env: { ...ENV_DEVELOP, DB_PASSWORD: "" }, conectar, log: silencio }),
    /Falta la variable de entorno DB_PASSWORD/
  );
  assert.equal(conexiones, 0);

  assert.deepEqual(validarEntorno(ENV_DEVELOP), { esProduccion: false });
  assert.deepEqual(validarEntorno({ ...ENV_DEVELOP, DB_HOST: "127.0.0.1" }), { esProduccion: false });
  assert.deepEqual(
    validarEntorno({ ...ENV_DEVELOP, DB_HOST: "rds.example" }, { permiteProduccion: true }),
    { esProduccion: true }
  );
});

test("main se conecta con la configuración del entorno y cierra la conexión aunque falle", async () => {
  let configuracion;
  const conexion = conexionFalsa();
  const resultado = await main({
    argv: ["node", "script", "--skip-grants"],
    env: { ...ENV_DEVELOP, DB_PORT: "3306" },
    conectar: async (config) => {
      configuracion = config;
      return conexion;
    },
    log: silencio,
    warn: silencio,
  });
  assert.deepEqual(configuracion, {
    host: "localhost",
    user: "root",
    password: "secreto",
    database: "db_miajb",
    port: "3306",
    timezone: "-03:00",
  });
  assert.equal(resultado.grants, null);
  assert.equal(conexion.consultas.at(-1).sql, "END");

  const rota = conexionFalsa();
  rota.query = async () => {
    throw new Error("se cayó la base");
  };
  await assert.rejects(
    main({ argv: ["node", "script"], env: ENV_DEVELOP, conectar: async () => rota, log: silencio, warn: silencio }),
    /se cayó la base/
  );
  assert.equal(rota.consultas.at(-1).sql, "END");
});
