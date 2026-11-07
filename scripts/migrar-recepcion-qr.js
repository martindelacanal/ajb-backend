"use strict";

// QR de la reserva del predio: un código por reserva (antes era uno por vehículo, en
// recepcion_vehiculo.token). Las etiquetas ya impresas siguen sirviendo: sus códigos
// se copian a la tabla nueva y apuntan a la misma reserva.
const DDL_QR = `CREATE TABLE IF NOT EXISTS recepcion_reserva_qr (
  predio_id INT NOT NULL,
  reserva_id INT NOT NULL,
  token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (predio_id,reserva_id),
  UNIQUE KEY uq_recepcion_reserva_qr_token (token),
  CONSTRAINT fk_recepcion_reserva_qr_reserva FOREIGN KEY (reserva_id) REFERENCES reserva(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

async function verificar(c) {
  await c.query("SELECT predio_id,reserva_id,token,creado FROM recepcion_reserva_qr LIMIT 0");
}

async function copiarEtiquetas(c) {
  const [r] = await c.query(`INSERT IGNORE INTO recepcion_reserva_qr(predio_id,reserva_id,token)
    SELECT predio_id,reserva_id,token FROM recepcion_vehiculo WHERE token IS NOT NULL`);
  return Number(r.affectedRows || 0);
}

async function aplicar(c) {
  await c.query(DDL_QR);
  const copiadas = await copiarEtiquetas(c);
  const [[{ base }]] = await c.query("SELECT DATABASE() AS base");
  const [cuentas] = await c.query("SELECT Host AS host FROM mysql.user WHERE User='miajb_runtime'");
  for (const { host } of cuentas) {
    await c.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ??.recepcion_reserva_qr TO 'miajb_runtime'@?", [base, host]);
  }
  await verificar(c);
  return { copiadas, cuentas: cuentas.length };
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
      if (opciones.apply) {
        const r = await aplicar(c);
        console.log(`[recepcion-qr] ${nombre}: tabla lista, ${r.copiadas} etiquetas anteriores copiadas, GRANT en ${r.cuentas} cuenta(s)`);
      } else {
        await verificar(c);
        console.log(`[recepcion-qr] ${nombre}: esquema verificado`);
      }
    } finally { await c.end(); }
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { DDL_QR, aplicar, verificar, copiarEtiquetas };
