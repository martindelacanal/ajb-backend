"use strict";

const fs = require("node:fs");
const net = require("node:net");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const { claveNombre } = require("../api/services/olimpiadas-visibilidad-veedores");

function candidatosMiramar(cuentas, asignados) {
  const objetivos = [{ nombre: "Nahuel Staffa", requiereAsignacion: true }, { nombre: "Lucas Profeta", requiereAsignacion: false }];
  return objetivos.map(({ nombre, requiereAsignacion }) => {
    const buscado = claveNombre(nombre);
    const coincidencias = cuentas.filter(v =>
      [v.nombre, v.nombre_vinculado].some(n => claveNombre(n) === buscado)
      && (!requiereAsignacion || asignados.has(Number(v.id))));
    if (coincidencias.length !== 1) throw new Error(`Se esperaba un único veedor para ${nombre} y se encontraron ${coincidencias.length}`);
    return { id: Number(coincidencias[0].id), nombre, visible: Number(coincidencias[0].visible_publico) === 1 };
  });
}

async function buscarMiramar(db, columna, bloquear) {
  const lock = bloquear ? " FOR UPDATE" : "";
  const [[edicion]] = await db.query(`SELECT id FROM olimpiada WHERE id = 2 AND ruta_publica = 'olimpiadas2026'
    AND fecha_inicio = '2026-11-26' AND fecha_fin = '2026-11-29' AND eliminado = 0` + lock);
  if (!edicion) throw new Error("La edición 2 no corresponde a Miramar 2026");
  const [cuentas] = await db.query(`SELECT v.id, v.nombre, CONCAT_WS(' ',u.nombre,u.apellido) AS nombre_vinculado,
    ${columna ? "v.visible_publico" : "1 AS visible_publico"} FROM olimpiada_voluntario v LEFT JOIN usuario u ON u.id = v.usuario_sistema_id` + lock);
  const [asignaciones] = await db.query("SELECT voluntario_id FROM olimpiada_voluntario_disciplina WHERE olimpiada_id = 2" + lock);
  const candidatas = candidatosMiramar(cuentas, new Set(asignaciones.map(a => Number(a.voluntario_id))));
  if (candidatas[0].id === candidatas[1].id) throw new Error("Los dos nombres apuntan a la misma cuenta");
  return candidatas;
}

async function migrar(db, { apply = false, ocultarMiramar = false } = {}) {
  const [[columna]] = await db.query(`SELECT DATA_TYPE AS tipo, IS_NULLABLE AS anulable, COLUMN_DEFAULT AS defecto
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olimpiada_voluntario' AND COLUMN_NAME = 'visible_publico'`);
  if (columna && (columna.tipo !== "tinyint" || columna.anulable !== "NO" || String(columna.defecto) !== "1")) {
    throw new Error("La columna de visibilidad existente difiere de la esperada");
  }
  let cuentas = ocultarMiramar ? await buscarMiramar(db, !!columna, false) : [];
  if (apply && !columna) await db.query("ALTER TABLE olimpiada_voluntario ADD COLUMN visible_publico TINYINT(1) NOT NULL DEFAULT 1");
  if (apply && ocultarMiramar) {
    await db.beginTransaction();
    try {
      cuentas = await buscarMiramar(db, true, true);
      for (const cuenta of cuentas.filter(v => v.visible)) {
        await db.query("UPDATE olimpiada_voluntario SET visible_publico = 0 WHERE id = ?", [cuenta.id]);
        await db.query(`INSERT INTO olimpiada_historial (entidad, entidad_id, olimpiada_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, observacion)
          VALUES ('VOLUNTARIO', ?, 2, 'UPDATE', 'visible_publico', '1', '0', 'Visibilidad de veedores de Miramar 2026')`, [cuenta.id]);
        cuenta.visible = false;
      }
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
  }
  return { agregarColumna: !columna, cuentas };
}

async function main() {
  const opciones = parsearArgumentos();
  if (opciones.target !== "develop" && !opciones.allowProduction) throw new Error("Producción requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "OLIMPIADAS_VISIBILIDAD_VEEDORES") throw new Error("Aplicar requiere --confirm=OLIMPIADAS_VISIBILIDAD_VEEDORES");
  const ocultarMiramar = process.argv.includes("--ocultar-miramar-2026");
  if (ocultarMiramar && opciones.target !== "production") throw new Error("La asignación de Miramar corresponde a producción");
  const puerto = process.argv.find(arg => arg.startsWith("--puerto-tunel="))?.slice("--puerto-tunel=".length);
  if (puerto !== undefined && (!/^\d{1,5}$/.test(puerto) || Number(puerto) < 1 || Number(puerto) > 65535)) throw new Error("El puerto del túnel es inválido");
  for (const e of obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))) {
    const conexion = crearOpcionesConexion(e.config);
    if (puerto) conexion.stream = () => net.connect({ host: "127.0.0.1", port: Number(puerto) });
    if (conexion.ssl && e.config.DB_SSL_MODE === "verify-full") conexion.ssl.verifyIdentity = true;
    const db = await mysql.createConnection(conexion);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-visibilidad-veedores', 15) AS adquirido");
      if (!Number(lock.adquirido)) throw new Error("Hay otra migración de visibilidad en curso");
      console.log(JSON.stringify({ entorno: e.nombre, modo: opciones.apply ? "apply" : "check", ...await migrar(db, { apply: opciones.apply, ocultarMiramar }) }));
    } finally { await db.end(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { migrar, candidatosMiramar };
