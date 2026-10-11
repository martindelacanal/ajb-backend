"use strict";

const fs = require("fs");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const COLUMNAS = { primer_ingreso: "DATETIME(6) NULL", ultimo_ingreso: "DATETIME(6) NULL" };
const SQL = `CREATE TABLE IF NOT EXISTS correo_bienvenida (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  usuario_id INT NOT NULL,
  email VARCHAR(254) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  estado ENUM('pendiente','enviado','entregado','rebotado','error','queja') NOT NULL DEFAULT 'pendiente',
  detalle VARCHAR(500) NULL,
  message_id VARCHAR(255) NULL,
  creada_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  procesando_en DATETIME(6) NULL,
  enviada_en DATETIME(6) NULL,
  evento_en DATETIME(6) NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_bienvenida_usuario (usuario_id),
  KEY idx_bienvenida_pendiente (estado, procesando_en, creada_en),
  KEY idx_bienvenida_message (message_id),
  CONSTRAINT fk_bienvenida_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function verificarEsquema(db) {
  const [columnas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usuario'");
  for (const nombre of Object.keys(COLUMNAS)) if (!columnas.some(c => c.COLUMN_NAME === nombre)) throw new Error(`Falta usuario.${nombre}`);
  await db.query("SELECT id, usuario_id, email, nombre, estado, detalle, message_id, creada_en, procesando_en, enviada_en, evento_en FROM correo_bienvenida LIMIT 0");
  const [indices] = await db.query("SHOW INDEX FROM correo_bienvenida");
  if (!indices.some(i => i.Key_name === 'uq_bienvenida_usuario' && Number(i.Non_unique) === 0)) throw new Error('Falta unicidad de bienvenida por usuario');
}

async function aplicarMigracion(db) {
  const [locks] = await db.query("SELECT GET_LOCK('ajb:usuarios-alta-v1', 15) AS tomado");
  if (Number(locks[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración");
  try {
    const [columnas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usuario'");
    for (const [nombre, tipo] of Object.entries(COLUMNAS)) if (!columnas.some(c => c.COLUMN_NAME === nombre)) await db.query(`ALTER TABLE usuario ADD COLUMN ${nombre} ${tipo}`);
    await db.query(SQL);
    // Conserva evidencia anterior: incluye sesiones cerradas y claves de acceso.
    await db.query(`UPDATE usuario u INNER JOIN (
      SELECT usuario_id, MIN(creada_en) primero, MAX(creada_en) ultimo FROM auth_sesion GROUP BY usuario_id
    ) s ON s.usuario_id=u.id SET u.primer_ingreso=COALESCE(u.primer_ingreso,s.primero),
      u.ultimo_ingreso=GREATEST(COALESCE(u.ultimo_ingreso,s.ultimo),s.ultimo)`);
    await db.query(`UPDATE usuario u INNER JOIN (
      SELECT usuario_id, MIN(fecha_ultimo_uso) primero, MAX(fecha_ultimo_uso) ultimo
      FROM webauthn_credencial WHERE fecha_ultimo_uso IS NOT NULL GROUP BY usuario_id
    ) w ON w.usuario_id=u.id SET u.primer_ingreso=LEAST(COALESCE(u.primer_ingreso,w.primero),w.primero),
      u.ultimo_ingreso=GREATEST(COALESCE(u.ultimo_ingreso,w.ultimo),w.ultimo)`);
    await verificarEsquema(db);
  } finally { await db.query("SELECT RELEASE_LOCK('ajb:usuarios-alta-v1')"); }
}

async function main() {
  const opciones = parsearArgumentos(process.argv.slice(2));
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "APLICAR_USUARIOS_ALTA") throw new Error("Aplicar requiere --confirm=APLICAR_USUARIOS_ALTA");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      if (opciones.apply) await aplicarMigracion(db); else await verificarEsquema(db);
      console.log(`[usuarios-alta] ${entorno.nombre}: verificada`);
    } finally { await db.end(); }
  }
}
if (require.main === module) main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
module.exports = { COLUMNAS, SQL, aplicarMigracion, verificarEsquema };
