"use strict";

// node scripts/migrar-educacion.js --apply --target=develop --seed-test-user
// Producción: --target=production --allow-production. Sin --apply sólo verifica.
const fs = require("fs");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const { RUBROS_EDUCATIVOS } = require("../api/services/beneficios-educacion");
const ROL_ID = 8;
const DOCUMENTO_TEST = "99000801";
const EMAIL_TEST = "educacion.test@example.invalid";

async function verificar(connection, { seedTestUser = false } = {}) {
  const [roles] = await connection.query("SELECT id, nombre FROM rol WHERE id = ? OR nombre = 'educacion'", [ROL_ID]);
  if (roles.length !== 1 || Number(roles[0].id) !== ROL_ID || roles[0].nombre !== "educacion") throw new Error("Falta el rol educativo o existe una colisión de ID");
  for (const nombre of RUBROS_EDUCATIVOS) {
    const [rows] = await connection.query("SELECT id FROM beneficio_rubro WHERE nombre = ? AND habilitado = 1", [nombre]);
    if (rows.length !== 1) throw new Error(`Falta rubro habilitado: ${nombre}`);
  }
  if (seedTestUser) {
    const [users] = await connection.query("SELECT rol_id, email, habilitado, password FROM usuario WHERE documento = ?", [DOCUMENTO_TEST]);
    if (users.length !== 1 || Number(users[0].rol_id) !== ROL_ID || users[0].email !== EMAIL_TEST || users[0].habilitado !== "Y" || !await bcrypt.compare("test", users[0].password || "")) throw new Error("El usuario de prueba educativo no coincide con la configuración solicitada");
  }
}

async function aplicar(connection, { seedTestUser = false } = {}) {
  const [locks] = await connection.query("SELECT GET_LOCK('ajb:educacion-v1', 15) AS tomado");
  if (Number(locks[0]?.tomado) !== 1) throw new Error("No se pudo bloquear la migración educativa");
  try {
    await connection.beginTransaction();
    const [roles] = await connection.query("SELECT id, nombre FROM rol WHERE id = ? OR nombre = 'educacion' FOR UPDATE", [ROL_ID]);
    if (roles.some((r) => Number(r.id) !== ROL_ID || r.nombre !== "educacion")) throw new Error("El rol educativo colisiona con un rol existente; no se modificó");
    if (!roles.length) await connection.query("INSERT INTO rol (id, nombre) VALUES (?, 'educacion')", [ROL_ID]);
    for (const nombre of RUBROS_EDUCATIVOS) {
      await connection.query("INSERT INTO beneficio_rubro (nombre) VALUES (?) ON DUPLICATE KEY UPDATE habilitado = 1", [nombre]);
    }
    if (seedTestUser) {
      const [users] = await connection.query("SELECT id, rol_id, email FROM usuario WHERE documento = ? FOR UPDATE", [DOCUMENTO_TEST]);
      if (users.length > 1 || users.some((u) => Number(u.rol_id) !== ROL_ID || u.email !== EMAIL_TEST)) throw new Error("El documento de prueba ya pertenece a otra cuenta; no se modificó");
      const hash = await bcrypt.hash("test", 12);
      if (users.length) {
        await connection.query("UPDATE usuario SET password = ?, habilitado = 'Y', requiere_cambio_clave = 0, bloqueo_tipo = NULL, bloqueo_modulos = NULL, auth_revocado_desde = NOW(6) WHERE id = ?", [hash, users[0].id]);
      } else {
        await connection.query(`INSERT INTO usuario
          (nombre, apellido, documento, email, password, rol_id, habilitado, es_familiar,
           area_turismo, area_coseguro, modulo_turismo, modulo_coseguro, modulo_olimpiadas, requiere_cambio_clave)
          VALUES ('Educación', 'Prueba', ?, ?, ?, ?, 'Y', 'N', 0, 0, 0, 0, 0, 0)`,
        [DOCUMENTO_TEST, EMAIL_TEST, hash, ROL_ID]);
      }
    }
    await verificar(connection, { seedTestUser });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { await connection.query("SELECT RELEASE_LOCK('ajb:educacion-v1')"); }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (["production", "all"].includes(opciones.target) && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  const seedTestUser = argv.includes("--seed-test-user");
  for (const entorno of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const connection = await mysql.createConnection(crearOpcionesConexion(entorno.config));
    try {
      if (opciones.apply) await aplicar(connection, { seedTestUser }); else await verificar(connection, { seedTestUser });
      console.log(`[educacion] ${entorno.nombre}: rol y rubros verificados${seedTestUser ? `; usuario de prueba DNI ${DOCUMENTO_TEST}` : ""}`);
    } finally { await connection.end(); }
  }
}
if (require.main === module) main().catch((error) => { console.error(`[educacion] ${error.code || error.message}`); process.exitCode = 1; });
module.exports = { aplicar, verificar, ROL_ID, DOCUMENTO_TEST };
