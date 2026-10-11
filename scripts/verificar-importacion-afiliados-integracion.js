"use strict";

// MySQL local con esquema aislado: copia solamente estructuras, nunca datos personales.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const { obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

async function main() {
  const config = obtenerEntornos({ target: "develop" }, fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8"))[0].config;
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(config.DB_HOST), "Solo se permite MySQL local");
  const schema = `ajb_test_importacion_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const opciones = crearOpcionesConexion(config);
  let admin, db, creado = false;
  try {
    admin = await mysql.createConnection(opciones);
    await admin.query(`CREATE DATABASE ${admin.escapeId(schema)}`);
    creado = true;
    db = mysql.createPool({ ...opciones, database: schema, connectionLimit: 4 });
    db.on("connection", (connection) => connection.query("SET SESSION time_zone='-03:00'"));
    for (const tabla of ["usuario", "rol", "departamental", "tipo_persona", "historial_usuario", "correo_bienvenida", "auth_limite", "auth_recuperacion", "auth_sesion", "webauthn_credencial"]) {
      await db.query(`CREATE TABLE ${db.escapeId(tabla)} LIKE ${db.escapeId(config.DB_DATABASE)}.${db.escapeId(tabla)}`);
    }
    const conexionMigracion = await db.getConnection();
    try { await require("./migrar-acceso-usuarios-v1").aplicarMigracion(conexionMigracion); }
    finally { conexionMigracion.release(); }
    await db.query("INSERT INTO rol (id,nombre) VALUES (1,'admin'),(2,'afiliado'),(3,'departamental'),(5,'admin-central'),(6,'auditor')");
    await db.query("INSERT INTO departamental (id,nombre,habilitado) VALUES (1,'Sede de prueba','Y'),(2,'Otra sede','Y')");
    await db.query("INSERT INTO tipo_persona (id,nombre) VALUES (1,'Afiliado')");
    await db.query(`INSERT INTO usuario (id,rol_id,departamental_id,nombre,apellido,documento,email,password,habilitado)
      VALUES (1,3,1,'Operador','Prueba',99990000,'operador@example.invalid','!sin-acceso','Y')`);
    process.env.MAIL_ENABLED = "false";
    const { crearServicioImportacionUsuarios } = require("../api/services/usuarios-importacion");
    const { crearServicioRecuperacion } = require("../api/security/recuperacion-password");
    const secreto = crypto.randomBytes(64).toString("hex");
    const servicio = crearServicioImportacionUsuarios({ db, jwtSecret: secreto });
    const archivo = { originalname: "prueba.csv", buffer: Buffer.from("nombre,apellido,documento,email,fecha_nacimiento\nPersona,Prueba,99990001,afiliado@example.invalid,1990-02-28") };
    const preview = await servicio.preview({ actorId: 1, archivo });
    assert.equal(preview.validos, 1);
    const [[antes]] = await db.query("SELECT COUNT(*) total FROM usuario");
    assert.equal(Number(antes.total), 1, "preview no crea usuarios");
    const args = { actorId: 1, archivo, token: preview.token, enviarBienvenida: true };
    const resultado = await servicio.confirmar(args);
    assert.equal(resultado.creados, 1);
    assert.equal(resultado.emailsPendientes, 1);
    const [[afiliado]] = await db.query("SELECT * FROM usuario WHERE documento=99990001");
    assert.equal(afiliado.rol_id, 2);
    assert.equal(afiliado.departamental_id, 1);
    assert.equal(afiliado.requiere_cambio_clave, 0);
    assert.equal(await bcrypt.compare(afiliado.password, afiliado.password), false);
    const [[historial]] = await db.query("SELECT * FROM historial_usuario WHERE usuario_id=?", [afiliado.id]);
    assert.equal(historial.tipo_operacion, "CREATE");
    assert.equal(historial.usuario_modificador_id, 1);
    const [[bienvenida]] = await db.query("SELECT * FROM correo_bienvenida WHERE usuario_id=?", [afiliado.id]);
    assert.equal(bienvenida.estado, "pendiente");
    assert.equal(bienvenida.email, "afiliado@example.invalid");
    assert.equal(bienvenida.procesando_en, null);
    await assert.rejects(servicio.confirmar(args), { statusCode: 409 });
    const [[cantidad]] = await db.query("SELECT COUNT(*) total FROM correo_bienvenida");
    assert.equal(Number(cantidad.total), 1, "reintentar no duplica bienvenidas");

    // Se entrega el código solamente al test, sin llamar entregar ni iniciar trabajadores.
    const recuperacion = crearServicioRecuperacion({ db, jwtSecret: secreto, enviarCodigo: async () => { throw new Error("SMTP prohibido en integración"); } });
    const solicitud = await recuperacion.solicitar({ identificador: "99990001", ip: "127.0.0.1" });
    assert.equal(solicitud.usuarioId, afiliado.id);
    const verificado = await recuperacion.verificar({ identificador: "99990001", codigo: solicitud.codigo, ip: "127.0.0.1" });
    const password = "Mi contraseña de prueba 2026";
    await recuperacion.restablecer({ resetToken: verificado.resetToken, password, ip: "127.0.0.1" });
    const [[recuperado]] = await db.query("SELECT password, requiere_cambio_clave FROM usuario WHERE id=?", [afiliado.id]);
    assert.equal(await bcrypt.compare(password, recuperado.password), true);
    assert.equal(recuperado.requiere_cambio_clave, 0);

    // Una falla real después del INSERT debe revertir usuario e historial.
    const sinCola = crearServicioImportacionUsuarios({ db, jwtSecret: secreto, encolar: async () => { throw new Error("Falla de prueba al encolar"); } });
    const archivoFallido = { ...archivo, buffer: Buffer.from(archivo.buffer.toString().replaceAll("99990001", "99990002").replaceAll("afiliado@example.invalid", "rollback@example.invalid")) };
    const previoFallido = await sinCola.preview({ actorId: 1, archivo: archivoFallido });
    await assert.rejects(sinCola.confirmar({ actorId: 1, archivo: archivoFallido, token: previoFallido.token, enviarBienvenida: true }), /Falla de prueba/);
    const [[sinAlta]] = await db.query("SELECT COUNT(*) total FROM usuario WHERE documento=99990002");
    assert.equal(Number(sinAlta.total), 0);
    const [[totalHistorial]] = await db.query("SELECT COUNT(*) total FROM historial_usuario");
    assert.equal(Number(totalHistorial.total), 1);

    console.log(JSON.stringify({ ok: true, checks: ["preview sin escrituras", "confirmación con rol y sede correctos", "historial CREATE aceptado", "bienvenida persistida sin envío", "reintento sin duplicados", "recuperación completa y bcrypt válido", "rollback real de usuario e historial"] }, null, 2));
  } finally {
    if (db) await db.end();
    if (admin) {
      try {
        if (creado) {
          assert.match(schema, /^ajb_test_importacion_\d+_[a-f0-9]{8}$/);
          await admin.query(`DROP DATABASE ${admin.escapeId(schema)}`);
        }
      } finally { await admin.end(); }
    }
  }
}

if (require.main === module) main().catch((error) => { console.error(error.code || "INTEGRACION_ERROR", error.sqlMessage || error.message); process.exitCode = 1; });
module.exports = { main };
