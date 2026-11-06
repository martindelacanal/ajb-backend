"use strict";

// Migración aditiva: no modifica reservas existentes ni datos comerciales del predio.
const fs = require("node:fs"),
  mysql = require("mysql2/promise");
const {
  parsearArgumentos,
  obtenerEntornos,
  crearOpcionesConexion
} = require("./migrar-webauthn-v1");
const {
  DDL_CENTRALES
} = require("./migrar-predios");
const {
  ddlTabla,
  tipoSql,
  columnasDe
} = require("../predios/lib/esquema");
const nuevas = ["predio_recepcion_recibo", "predio_huesped", "predio_estadia_mov", "predio_venta_pago"];
const centrales = ["recepcion_particular", "recepcion_reserva_evento"];
async function aplicar(c, {
  soloRevisar = false
} = {}) {
  const [[db]] = await c.query("SELECT DATABASE() AS nombre");
  if (!/^[a-zA-Z0-9_]+$/.test(db.nombre)) throw Error("Base no válida");
  const faltantes = [];
  const ddl = async (nombre, sql) => {
    faltantes.push(nombre);
    if (!soloRevisar) await c.query(sql);
  };
  for (const tabla of [...centrales, ...nuevas]) {
    const [rs] = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?", [tabla]);
    if (!rs.length) await ddl(tabla, DDL_CENTRALES[tabla] || ddlTabla(tabla, "mysql"));
  }
  for (const [tabla, nombres] of [["predio_usuario", ["gestionar_reservas"]], ["predio_venta", ["importe_haberes"]], ["predio_huesped", ["ultima_revision"]], ["predio_estadia_mov", ["liquidacion_id"]]]) {
    if (soloRevisar && faltantes.includes(tabla)) continue;
    for (const nombre of nombres) {
      const [rs] = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?", [tabla, nombre]);
      if (!rs.length) await ddl(tabla + "." + nombre, "ALTER TABLE " + tabla + " ADD COLUMN " + nombre + " " + tipoSql(columnasDe(tabla)[nombre], "mysql"));
    }
  }
  if (!soloRevisar) {
    const [hosts] = await c.query("SELECT Host AS host FROM mysql.user WHERE User='miajb_runtime'");
    if (!hosts.length) throw Error("No se encontró la cuenta runtime; verificá los permisos antes de activar.");
    for (const {
      host
    } of hosts) for (const t of [...centrales, ...nuevas]) await c.query("GRANT " + (centrales.includes(t) ? "SELECT,INSERT" : "SELECT,INSERT,UPDATE,DELETE") + " ON `" + db.nombre + "`.`" + t + "` TO ?@?", ["miajb_runtime", host]);
  }
  return {
    faltantes
  };
}
async function main() {
  const opts = parsearArgumentos(process.argv.slice(2));
  const aplicarAhora = process.argv.includes("--apply");
  for (const e of obtenerEntornos(opts, fs.readFileSync(opts.envFile, "utf8"))) {
    if (e.nombre === "production" && aplicarAhora && !process.argv.includes("--allow-production")) throw Error("Falta --allow-production");
    const c = await mysql.createConnection(crearOpcionesConexion(e.config));
    try {
      console.log(JSON.stringify(await aplicar(c, {
        soloRevisar: !aplicarAhora
      })));
    } finally {
      await c.end();
    }
  }
}
if (require.main === module) main().catch(e => {
  console.error(e.code || e.message);
  process.exitCode = 1;
});
module.exports = {
  aplicar
};
