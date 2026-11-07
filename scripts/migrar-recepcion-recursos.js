"use strict";

const DDL_RECURSOS = `CREATE TABLE IF NOT EXISTS recepcion_reserva_recurso (
  reserva_id INT NOT NULL,
  recurso_id INT NOT NULL,
  PRIMARY KEY (reserva_id,recurso_id),
  KEY ix_recepcion_recurso_reserva (recurso_id,reserva_id),
  CONSTRAINT fk_recepcion_rr_reserva FOREIGN KEY (reserva_id) REFERENCES reserva(id) ON DELETE CASCADE,
  CONSTRAINT fk_recepcion_rr_recurso FOREIGN KEY (recurso_id) REFERENCES recurso(id)
) ENGINE=InnoDB`;

async function aplicar(c) {
  await c.query(DDL_RECURSOS);
  const [[{ base }]] = await c.query("SELECT DATABASE() AS base");
  const [cuentas] = await c.query("SELECT Host AS host FROM mysql.user WHERE User='miajb_runtime'");
  if (!cuentas.length) throw Error("No se encontró la cuenta del runtime");
  for (const { host } of cuentas) {
    await c.query("GRANT SELECT, INSERT, DELETE ON ??.recepcion_reserva_recurso TO 'miajb_runtime'@?", [base, host]);
  }
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
      if (opciones.apply) await aplicar(c);
      await c.query("SELECT reserva_id,recurso_id FROM recepcion_reserva_recurso LIMIT 0");
      console.log(`[recepcion-recursos] ${nombre}: esquema verificado`);
    } finally { await c.end(); }
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { DDL_RECURSOS, aplicar };
