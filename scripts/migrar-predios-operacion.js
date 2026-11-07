"use strict";

const { columnasDe, tipoSql } = require("../predios/lib/esquema");

const DDL_ENVIOS = `CREATE TABLE IF NOT EXISTS predio_inventario_envio (
  clave VARCHAR(100) CHARACTER SET ascii NOT NULL, usuario_id INT NOT NULL,
  enviado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (clave, usuario_id)
) ENGINE=InnoDB`;
const COLUMNAS = {
  predio_producto: ["dias_aviso_vencimiento"],
  predio_usuario: ["puede_cerrar_caja", "puede_anular_ticket", "debe_cambiar_clave"],
};
const INDICE = "ix_predio_permiso_tipo_referencia_id_estado";

async function revisar(c, aplicar) {
  for (const [tabla, nombres] of Object.entries(COLUMNAS)) {
    const [columnas] = await c.query(`SELECT COLUMN_NAME AS nombre, COLUMN_TYPE AS tipo, IS_NULLABLE AS anulable, COLUMN_DEFAULT AS defecto
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [tabla]);
    if (!columnas.length) throw Error("Falta la tabla " + tabla);
    const faltantes = [];
    for (const nombre of nombres) {
      const tipo = tipoSql(columnasDe(tabla)[nombre], "mysql");
      const col = columnas.find(f => f.nombre === nombre);
      if (!col) {
        if (!aplicar) throw Error(`Falta ${tabla}.${nombre}`);
        faltantes.push(`ADD COLUMN \`${nombre}\` ${tipo}`);
      } else if (col.tipo.toUpperCase().replace(/^INT\(\d+\)$/, "INT") !== tipo.split(" ")[0] ||
        col.anulable !== (tipo.includes("NOT NULL") ? "NO" : "YES") ||
        (tipo.includes("DEFAULT 0") ? String(col.defecto) !== "0" : col.defecto !== null)) {
        throw Error(`Definición incompatible de ${tabla}.${nombre}`);
      }
    }
    if (faltantes.length) await c.query(`ALTER TABLE \`${tabla}\` ${faltantes.join(", ")}`);
  }
  if (aplicar) await c.query(DDL_ENVIOS);
  const [indices] = await c.query(`SELECT TABLE_NAME AS tabla, INDEX_NAME AS nombre, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnas
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('predio_permiso','predio_inventario_envio')
    GROUP BY TABLE_NAME,INDEX_NAME`);
  if (!indices.some(i => i.tabla === "predio_inventario_envio" && i.nombre === "PRIMARY" && i.columnas === "clave,usuario_id")) {
    throw Error("Falta la clave única de entregas de inventario");
  }
  if (!indices.some(i => i.tabla === "predio_permiso" && i.columnas === "predio_id,tipo,referencia_id,estado")) {
    if (!aplicar) throw Error("Falta índice de solicitudes de anulación");
    await c.query(`CREATE INDEX ${INDICE} ON predio_permiso (predio_id,tipo,referencia_id,estado)`);
  }
}

async function verificarEsquema(c) { await revisar(c, false); }

async function aplicarMigracion(c) {
  const [[lock]] = await c.query("SELECT GET_LOCK('ajb:predios-operacion',15) AS tomado, DATABASE() AS base");
  if (Number(lock.tomado) !== 1) throw Error("Otra migración está en curso");
  try {
    await revisar(c, true);
    await verificarEsquema(c);
    await c.query(require("../predios/lib/claves-usuario").SQL_MARCAR_TEMPORALES);
    const [cuentas] = await c.query("SELECT Host AS host FROM mysql.user WHERE User='miajb_runtime'");
    if (!cuentas.length) throw Error("No se encontró la cuenta del runtime");
    for (const { host } of cuentas) await c.query("GRANT SELECT, INSERT ON ??.predio_inventario_envio TO 'miajb_runtime'@?", [lock.base, host]);
  } finally { await c.query("SELECT RELEASE_LOCK('ajb:predios-operacion')"); }
}

module.exports = { DDL_ENVIOS, aplicarMigracion, verificarEsquema };
