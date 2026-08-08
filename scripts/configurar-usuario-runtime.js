"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");
const { parseArguments, redactError } = require("./integridad-financiera-common");

const CONFIRMACION = "CONFIGURAR_USUARIO_RUNTIME";
const TABLA_ARCHIVO = "ajb_reserva_version_archivo";
const TABLA_GUARDIA = "ajb_reserva_mutacion_guard";
const TABLAS_SOLO_LECTURA = new Set([
  "ajb_schema_migration",
  "ajb_reserva_precio_backup",
]);

function validarNombreUsuario(valor) {
  const texto = String(valor || "").trim();
  return /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(texto) ? texto : null;
}

function validarHosts(valor) {
  const hosts = String(valor || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    hosts.length === 0 ||
    hosts.length > 4 ||
    hosts.some((host) => !/^(?:localhost|%|[A-Za-z0-9_.:-]+)$/.test(host))
  ) {
    return null;
  }
  return [...new Set(hosts)];
}

function cargarEntorno(rutaEnv) {
  const contenido = fs.readFileSync(rutaEnv, "utf8");
  const variables = dotenv.parse(contenido);
  for (const nombre of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!variables[nombre]) throw new Error(`Falta ${nombre} en el archivo de entorno`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(variables.DB_DATABASE)) {
    throw new Error("DB_DATABASE contiene caracteres no permitidos");
  }
  return { contenido, variables };
}

function configuracionConexion(variables, credenciales = {}) {
  const modoTls = String(process.env.DB_SSL_MODE || variables.DB_SSL_MODE || "disabled")
    .trim()
    .toLowerCase();
  let ssl;
  if (modoTls !== "disabled") {
    if (!new Set(["verify-ca", "verify-full"]).has(modoTls)) {
      throw new Error("DB_SSL_MODE no es valido");
    }
    const rutaCa = String(process.env.DB_SSL_CA_PATH || variables.DB_SSL_CA_PATH || "").trim();
    if (!rutaCa) throw new Error("DB_SSL_CA_PATH es obligatorio con TLS");
    ssl = { ca: fs.readFileSync(rutaCa), rejectUnauthorized: true };
  }
  return {
    host: variables.DB_HOST,
    port: Number(variables.DB_PORT || 3306),
    user: credenciales.user || variables.DB_USER,
    password: credenciales.password || variables.DB_PASSWORD,
    database: variables.DB_DATABASE,
    connectTimeout: 10000,
    multipleStatements: false,
    ssl,
  };
}

function cuentaSql(connection, usuario, host) {
  return `${connection.escape(usuario)}@${connection.escape(host)}`;
}

function privilegiosTabla(nombre, tipo) {
  if (nombre === TABLA_ARCHIVO) return "SELECT, INSERT";
  if (nombre === TABLA_GUARDIA) return "SELECT, INSERT, DELETE";
  if (TABLAS_SOLO_LECTURA.has(nombre) || tipo === "VIEW") return "SELECT";
  return "SELECT, INSERT, UPDATE, DELETE";
}

function actualizarVariable(contenido, nombre, valor) {
  const linea = `${nombre}=${valor}`;
  const patron = new RegExp(`^\\s*${nombre}\\s*=.*$`, "m");
  if (patron.test(contenido)) return contenido.replace(patron, linea);
  return `${contenido.replace(/\s*$/, "")}\n${linea}\n`;
}

function respaldarYActualizarEnv(rutaEnv, rutaBackup, contenido, variablesNuevas) {
  if (!path.isAbsolute(rutaBackup)) {
    throw new Error("--admin-env-backup debe ser una ruta absoluta");
  }
  fs.mkdirSync(path.dirname(rutaBackup), { recursive: true, mode: 0o700 });
  fs.writeFileSync(rutaBackup, contenido, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(rutaBackup, 0o600);
  } catch (_) {
    // En Windows se preservan las ACL del directorio; chmod puede no mapearse.
  }

  let siguiente = contenido;
  for (const [nombre, valor] of Object.entries(variablesNuevas)) {
    siguiente = actualizarVariable(siguiente, nombre, valor);
  }
  const temporal = `${rutaEnv}.runtime-${process.pid}-${Date.now()}.tmp`;
  const modo = fs.statSync(rutaEnv).mode;
  fs.writeFileSync(temporal, siguiente, { encoding: "utf8", mode: modo });
  try {
    fs.renameSync(temporal, rutaEnv);
  } catch (error) {
    fs.rmSync(temporal, { force: true });
    throw error;
  }
}

async function configurar() {
  const args = parseArguments();
  const aplicar = args.apply === true;
  const rutaEnv = path.resolve(__dirname, "../.env");
  const usuarioRuntime = validarNombreUsuario(args["runtime-user"] || "miajb_runtime");
  const hostsRuntime = validarHosts(args["runtime-host"]);
  const rutaBackup = args["admin-env-backup"]
    ? path.resolve(String(args["admin-env-backup"]))
    : null;
  const endurecerProduccion = args["production-hardening"] === true;
  const origenCors = String(args["cors-origin"] || "").trim();
  const rutaCaProduccion = args["db-ca-path"]
    ? path.resolve(String(args["db-ca-path"]))
    : null;

  if (!usuarioRuntime) throw new Error("--runtime-user no es valido");
  if (!hostsRuntime) throw new Error("--runtime-host es obligatorio y no es valido");
  if (aplicar && args.confirm !== CONFIRMACION) {
    throw new Error(`La escritura exige --confirm=${CONFIRMACION}`);
  }
  if (aplicar && !rutaBackup) {
    throw new Error("La escritura exige --admin-env-backup=<ruta-absoluta>");
  }
  if (endurecerProduccion) {
    let urlCors;
    try {
      urlCors = new URL(origenCors);
    } catch (_) {
      throw new Error("--cors-origin no es una URL valida");
    }
    if (
      urlCors.protocol !== "https:" ||
      urlCors.origin !== origenCors ||
      urlCors.username ||
      urlCors.password
    ) {
      throw new Error("--cors-origin debe ser un origen HTTPS exacto");
    }
    if (!rutaCaProduccion || !fs.existsSync(rutaCaProduccion)) {
      throw new Error("--db-ca-path debe apuntar a un bundle CA existente");
    }
    const contenidoCa = fs.readFileSync(rutaCaProduccion, "utf8");
    if (!contenidoCa.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("--db-ca-path no contiene certificados PEM");
    }
    process.env.DB_SSL_MODE = "verify-full";
    process.env.DB_SSL_CA_PATH = rutaCaProduccion;
  }

  const { contenido, variables } = cargarEntorno(rutaEnv);
  const connection = await mysql.createConnection(configuracionConexion(variables));
  let runtimeConnection;
  try {
    if (endurecerProduccion) {
      const [estadoTls] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      if (!String(estadoTls[0]?.Value || "").trim()) {
        throw new Error("La conexion administrativa no negocio TLS");
      }
    }
    const [filas] = await connection.query("SHOW FULL TABLES");
    const columnaNombre = `Tables_in_${variables.DB_DATABASE}`;
    const tablas = filas.map((fila) => ({
      nombre: fila[columnaNombre],
      tipo: String(fila.Table_type || "BASE TABLE").toUpperCase(),
    }));
    if (tablas.length === 0 || tablas.some((tabla) => !/^[A-Za-z0-9_]+$/.test(tabla.nombre))) {
      throw new Error("No se pudo inventariar el esquema de forma segura");
    }
    for (const requerida of [TABLA_ARCHIVO, TABLA_GUARDIA]) {
      if (!tablas.some((tabla) => tabla.nombre === requerida)) {
        throw new Error(`Falta la tabla migrada ${requerida}`);
      }
    }

    const plan = {
      mode: aplicar ? "apply" : "dry-run-read-only",
      runtime_user: usuarioRuntime,
      runtime_hosts: hostsRuntime,
      tables: tablas.length,
      archive_privileges: privilegiosTabla(TABLA_ARCHIVO, "BASE TABLE"),
      guard_privileges: privilegiosTabla(TABLA_GUARDIA, "BASE TABLE"),
      env_will_be_updated: aplicar,
      production_hardening: endurecerProduccion,
    };
    if (!aplicar) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    const passwordRuntime = crypto.randomBytes(48).toString("base64url");
    const esquema = connection.escapeId(variables.DB_DATABASE);
    const requisitoTls = endurecerProduccion ? " REQUIRE SSL" : "";
    for (const host of hostsRuntime) {
      const cuenta = cuentaSql(connection, usuarioRuntime, host);
      await connection.query(
        `CREATE USER IF NOT EXISTS ${cuenta} IDENTIFIED BY ${connection.escape(passwordRuntime)}${requisitoTls}`
      );
      await connection.query(
        `ALTER USER ${cuenta} IDENTIFIED BY ${connection.escape(passwordRuntime)}${requisitoTls}`
      );
      await connection.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${cuenta}`);
      for (const tabla of tablas) {
        const privilegios = privilegiosTabla(tabla.nombre, tabla.tipo);
        await connection.query(
          `GRANT ${privilegios} ON ${esquema}.${connection.escapeId(tabla.nombre)} TO ${cuenta}`
        );
      }
      const [grants] = await connection.query(`SHOW GRANTS FOR ${cuenta}`);
      const lineasGrants = grants.map((fila) => Object.values(fila).join(" "));
      const globalInesperado = lineasGrants.some((linea) =>
        /GRANT\s+ALL/i.test(linea) ||
        (/ON\s+\*\.\*/i.test(linea) && !/^GRANT\s+USAGE\s+ON\s+\*\.\*/i.test(linea))
      );
      if (globalInesperado) {
        throw new Error("La cuenta runtime recibio privilegios globales inesperados");
      }
    }

    runtimeConnection = await mysql.createConnection(
      configuracionConexion(variables, { user: usuarioRuntime, password: passwordRuntime })
    );
    await runtimeConnection.query("SELECT 1");
    if (endurecerProduccion) {
      const [estadoTls] = await runtimeConnection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      if (!String(estadoTls[0]?.Value || "").trim()) {
        throw new Error("La cuenta runtime no negocio TLS");
      }
    }
    let actualizacionArchivoDenegada = false;
    try {
      await runtimeConnection.query(
        `UPDATE ${connection.escapeId(TABLA_ARCHIVO)} SET id = id WHERE 1 = 0`
      );
    } catch (error) {
      actualizacionArchivoDenegada = new Set([
        "ER_TABLEACCESS_DENIED_ERROR",
        "ER_COLUMNACCESS_DENIED_ERROR",
      ]).has(error.code);
    }
    if (!actualizacionArchivoDenegada) {
      throw new Error("La cuenta runtime puede modificar el archivo inmutable");
    }

    const secretoJwtAnterior = String(variables.JWT_SECRET || "");
    const secretoJwt = endurecerProduccion && secretoJwtAnterior.length < 64
      ? crypto.randomBytes(64).toString("base64url")
      : secretoJwtAnterior;
    const variablesNuevas = {
      DB_USER: usuarioRuntime,
      DB_PASSWORD: passwordRuntime,
    };
    if (endurecerProduccion) {
      Object.assign(variablesNuevas, {
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: origenCors,
        DB_SSL_MODE: "verify-full",
        DB_SSL_CA_PATH: rutaCaProduccion,
        JWT_SECRET: secretoJwt,
        TRUST_PROXY: "loopback",
        TZ: "America/Argentina/Buenos_Aires",
      });
    }

    respaldarYActualizarEnv(
      rutaEnv,
      rutaBackup,
      contenido,
      variablesNuevas
    );
    console.log(JSON.stringify({
      ...plan,
      backup_env: rutaBackup,
      connection_verified: true,
      immutable_archive_verified: true,
      jwt_rotated: endurecerProduccion && secretoJwt !== secretoJwtAnterior,
      password_printed: false,
    }, null, 2));
  } finally {
    if (runtimeConnection) await runtimeConnection.end();
    await connection.end();
  }
}

configurar().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: redactError(error) }, null, 2));
  process.exitCode = 1;
});
