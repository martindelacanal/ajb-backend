"use strict";

// --check (por defecto) sólo lee el esquema. --apply requiere una conexión DBA.
const { TABLAS, columnasDe, ddlTabla, tipoSql } = require("../predios/lib/esquema");

const NUEVA = "predio_producto_margen_boca";
const ANEXOS = {
  predio_boca: ["margen_venta"],
  predio_precio_historial: ["boca_id"],
  predio_compra_item: ["venta_anterior", "historial_anterior_id"],
};
const TABLAS_OBJETIVO = [NUEVA, ...Object.keys(ANEXOS)];
const RUNTIME = "miajb_runtime";
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];

async function columnasActuales(c) {
  const [filas] = await c.query(
    `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, COLUMN_TYPE AS tipo, IS_NULLABLE AS anulable
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)`, [TABLAS_OBJETIVO]);
  const tablas = new Map();
  for (const f of filas) {
    if (!tablas.has(f.tabla)) tablas.set(f.tabla, new Map());
    tablas.get(f.tabla).set(f.columna, f);
  }
  return tablas;
}

function verificarColumna(tabla, columna, fila) {
  if (!fila) throw new Error(`Falta ${tabla}.${columna}`);
  const tipo = columnasDe(tabla)[columna];
  const esperado = tipoSql(tipo, "mysql").split(" ")[0].toLowerCase();
  const actual = fila.tipo.toLowerCase().replace(/^int\(\d+\)$/, "int");
  if (actual !== esperado || fila.anulable !== (tipo.endsWith("!") ? "NO" : "YES")) {
    throw new Error(`Definición incompatible en ${tabla}.${columna}: ${fila.tipo}, IS_NULLABLE=${fila.anulable}`);
  }
}

async function verificarTablaNueva(c, columnas) {
  for (const col of Object.keys(columnasDe(NUEVA))) verificarColumna(NUEVA, col, columnas?.get(col));
  const [indices] = await c.query(
    `SELECT INDEX_NAME AS nombre, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnas
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND NON_UNIQUE=0
     GROUP BY INDEX_NAME`, [NUEVA]);
  if (!indices.some(i => i.nombre === "PRIMARY" && i.columnas === "predio_id,id")) throw new Error(`Clave primaria incorrecta en ${NUEVA}`);
  for (const clave of TABLAS[NUEVA].unicos) {
    const columnasUnicas = ["predio_id", ...clave].join(",");
    if (!indices.some(i => i.columnas === columnasUnicas)) throw new Error(`Falta índice único ${NUEVA}(${columnasUnicas})`);
  }
}

async function verificarEsquema(c) {
  const tablas = await columnasActuales(c);
  await verificarTablaNueva(c, tablas.get(NUEVA));
  for (const [tabla, anexos] of Object.entries(ANEXOS)) {
    for (const col of anexos) verificarColumna(tabla, col, tablas.get(tabla)?.get(col));
  }
}

async function aplicarMigracion(c) {
  const [[bloqueo]] = await c.query("SELECT GET_LOCK('ajb:migrar-predios-precios',15) AS tomado, DATABASE() AS base");
  if (Number(bloqueo.tomado) !== 1) throw new Error("Otra migración de precios está en curso");
  try {
    if (!bloqueo.base) throw new Error("La conexión no tiene una base seleccionada");
    const [cuentas] = await c.query("SELECT Host AS host FROM mysql.user WHERE User=?", [RUNTIME]);
    if (!cuentas.length) throw new Error(`No hay cuentas existentes de ${RUNTIME} para otorgar DML`);
    const tablas = await columnasActuales(c);
    const cambios = [];
    if (tablas.has(NUEVA)) await verificarTablaNueva(c, tablas.get(NUEVA));
    for (const [tabla, anexos] of Object.entries(ANEXOS)) {
      if (!tablas.has(tabla)) throw new Error(`Falta la tabla base ${tabla}`);
      const faltantes = [];
      for (const col of anexos) {
        const fila = tablas.get(tabla).get(col);
        if (fila) verificarColumna(tabla, col, fila);
        else faltantes.push(`ADD COLUMN \`${col}\` ${tipoSql(columnasDe(tabla)[col], "mysql")}`);
      }
      if (faltantes.length) cambios.push(`ALTER TABLE \`${tabla}\` ${faltantes.join(", ")}`);
    }
    if (!tablas.has(NUEVA)) cambios.unshift(ddlTabla(NUEVA, "mysql"));
    for (const sql of cambios) await c.query(sql);
    await verificarEsquema(c);
    let permisosAgregados = 0;
    for (const { host } of cuentas) {
      const [permisos] = await c.query(
        `SELECT PRIVILEGE_TYPE AS permiso FROM information_schema.TABLE_PRIVILEGES
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?))`, [NUEVA, RUNTIME, host]);
      const faltantes = DML.filter(p => !permisos.some(f => f.permiso === p));
      if (faltantes.length) {
        await c.query(`GRANT ${faltantes.join(", ")} ON ??.?? TO ?@?`, [bloqueo.base, NUEVA, RUNTIME, host]);
        permisosAgregados += faltantes.length;
      }
    }
    return { sentenciasDDL: cambios.length, cuentas: cuentas.length, permisosAgregados };
  } finally {
    await c.query("SELECT RELEASE_LOCK('ajb:migrar-predios-precios')");
  }
}

async function main() {
  const fs = require("node:fs");
  const mysql = require("mysql2/promise");
  const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
  const opciones = parsearArgumentos();
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const host = entorno.config.DB_HOST.toLowerCase();
    if (!["localhost", "127.0.0.1", "::1"].includes(host) && !opciones.allowProduction) throw new Error("Un host remoto requiere --allow-production");
    const c = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      if (opciones.apply) console.log(await aplicarMigracion(c));
      else await verificarEsquema(c);
      console.log(`[predios-precios] ${entorno.nombre}: esquema verificado`);
    } finally { await c.end(); }
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { aplicarMigracion, verificarEsquema };
