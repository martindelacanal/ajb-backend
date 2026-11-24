"use strict";
const fs = require("node:fs");
const net = require("node:net");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

async function migrar(db, apply) {
  if (apply) {
    await db.query(`CREATE TABLE IF NOT EXISTS olimpiada_prensa (
      olimpiada_id INT NOT NULL,
      usuario_id INT NOT NULL,
      PRIMARY KEY (olimpiada_id, usuario_id),
      KEY idx_oli_prensa_usuario (usuario_id),
      CONSTRAINT fk_oli_prensa_edicion FOREIGN KEY (olimpiada_id) REFERENCES olimpiada(id) ON DELETE CASCADE,
      CONSTRAINT fk_oli_prensa_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
  }
  const [indices] = await db.query(`SELECT COLUMN_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada_prensa' AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`);
  const [[esquema]] = await db.query("SELECT DATABASE() AS nombre");
  const [cuentas] = await db.query("SELECT User, Host FROM mysql.user WHERE User = 'miajb_runtime'");
  if (!indices.length && !apply) return { tabla: "pendiente", cuentasRuntime: cuentas.length };
  if (indices.map(fila => fila.COLUMN_NAME).join(",") !== "olimpiada_id,usuario_id") {
    throw new Error("Falta la tabla de asignaciones olimpiada_prensa con su clave compuesta");
  }
  const permisos = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  let pendientes = 0;
  for (const cuenta of cuentas) {
    const usuarioSql = db.escape(cuenta.User) + "@" + db.escape(cuenta.Host);
    const [actuales] = await db.query(`SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada_prensa' AND GRANTEE = ?`, [usuarioSql]);
    const faltan = permisos.filter(permiso => !actuales.some(fila => fila.PRIVILEGE_TYPE === permiso));
    if (faltan.length && apply) {
      await db.query(`GRANT ${faltan.join(", ")} ON ${db.escapeId(esquema.nombre)}.olimpiada_prensa TO ${usuarioSql}`);
    } else if (faltan.length) {
      pendientes++;
    }
  }
  return { tabla: "verificada", cuentasRuntime: cuentas.length, permisosPendientes: pendientes };
}

async function main() {
  const opciones = parsearArgumentos();
  if (opciones.target !== "develop" && !opciones.allowProduction) throw new Error("Producción requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "OLIMPIADAS_PRENSA") throw new Error("Aplicar requiere --confirm=OLIMPIADAS_PRENSA");
  const puerto = process.argv.find(arg => arg.startsWith("--puerto-tunel="))?.split("=")[1];
  if (puerto !== undefined && (!/^\d{1,5}$/.test(puerto) || Number(puerto) < 1 || Number(puerto) > 65535)) throw new Error("Puerto de túnel inválido");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const config = crearOpcionesConexion(entorno.config);
    if (puerto) config.stream = () => net.connect({ host: "127.0.0.1", port: Number(puerto) });
    if (config.ssl && entorno.config.DB_SSL_MODE === "verify-full") config.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(config);
    try {
      const resultado = await migrar(db, opciones.apply);
      console.log(JSON.stringify({ migracion: "olimpiadas-prensa", entorno: entorno.nombre, ...resultado }));
    } finally { await db.end(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar };
