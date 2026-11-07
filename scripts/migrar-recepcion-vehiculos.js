"use strict";

const DDL_VEHICULOS = `CREATE TABLE IF NOT EXISTS recepcion_vehiculo (
  predio_id INT NOT NULL,
  reserva_id INT NOT NULL,
  patente VARCHAR(50) COLLATE utf8mb4_bin NOT NULL,
  token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  salida DATE NULL,
  salida_actor VARCHAR(140) NULL,
  PRIMARY KEY (predio_id,reserva_id),
  UNIQUE KEY uq_recepcion_vehiculo_token (token),
  CONSTRAINT fk_recepcion_vehiculo_reserva FOREIGN KEY (reserva_id) REFERENCES reserva(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

async function verificar(c) {
  await c.query("SELECT predio_id,reserva_id,patente,token,salida,salida_actor FROM recepcion_vehiculo LIMIT 0");
}

async function aplicar(c) {
  await c.query(DDL_VEHICULOS);
  const [[{ base }]] = await c.query("SELECT DATABASE() AS base");
  const [cuentas] = await c.query("SELECT Host AS host FROM mysql.user WHERE User='miajb_runtime'");
  if (!cuentas.length) throw Error("No se encontró la cuenta del runtime");
  for (const { host } of cuentas) {
    await c.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ??.recepcion_vehiculo TO 'miajb_runtime'@?", [base, host]);
  }
  await verificar(c);
}

async function main() {
  const fs = require("node:fs");
  const mysql = require("mysql2/promise");
  const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
  const opciones = parsearArgumentos();
  for (const { nombre, config } of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    if (opciones.apply && !["localhost", "127.0.0.1", "::1"].includes(config.DB_HOST) && !opciones.allowProduction) throw Error("Un host remoto requiere --allow-production");
    const c = await mysql.createConnection(crearOpcionesConexion(config));
    try {
      if (opciones.apply) await aplicar(c); else await verificar(c);
      console.log(`[recepcion-vehiculos] ${nombre}: esquema verificado`);
    } finally { await c.end(); }
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { DDL_VEHICULOS, aplicar, verificar };
