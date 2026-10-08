"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { TIPOS, GRUPOS, normalizarCicCodigo } = require("../api/data/coseguro-catalogo-631");
const { parsearBloquesEnv, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const TABLAS_SNAPSHOT = ["coseguro_imputacion", "coseguro_tipo_reintegro", "coseguro_concepto", "coseguro_solicitud", "coseguro_archivo", "coseguro_historial", "coseguro_observacion", "coseguro_solicitud_concepto", "coseguro_comprobante_claim"];
const normalizarNombre = (valor) => String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

async function existeTabla(db, tabla) {
  const [filas] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [tabla]);
  return filas.length > 0;
}

async function obtenerSnapshot(db) {
  const snapshot = {};
  for (const tabla of TABLAS_SNAPSHOT) {
    if (await existeTabla(db, tabla)) [snapshot[tabla]] = await db.query(`SELECT * FROM ${tabla} ORDER BY ${tabla === "coseguro_solicitud_concepto" ? "solicitud_id, concepto_id" : "id"}`);
  }
  return snapshot;
}

async function asegurarColumna(db, tabla, nombre, definicion) {
  const [filas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [tabla, nombre]);
  if (!filas.length) await db.query(`ALTER TABLE ${tabla} ADD COLUMN ${nombre} ${definicion}`);
}

async function ampliarCodigo(db, tabla, columna) {
  const [filas] = await db.query("SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [tabla, columna]);
  if (Number(filas[0]?.CHARACTER_MAXIMUM_LENGTH) < 20) await db.query(`ALTER TABLE ${tabla} MODIFY COLUMN ${columna} VARCHAR(20) NULL`);
}

// Los triggers de integridad originales liberaban comprobantes sólo en estados 5/6.
// Conservar su definer y sql_mode evita cambiar las garantías del despliegue.
async function actualizarTriggersRechazo(db) {
  const [triggers] = await db.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('ajb_cos_claim_ai', 'ajb_cos_claim_au')");
  for (const { TRIGGER_NAME: nombre } of triggers) {
    const [filas] = await db.query(`SHOW CREATE TRIGGER \`${nombre}\``);
    const fila = filas[0];
    const original = fila["SQL Original Statement"];
    const nuevo = original.replace(/NOT IN\s*\(5,\s*6\)/gi, "NOT IN (5, 6, 11)");
    if (original === nuevo) continue;
    const [[sesion]] = await db.query("SELECT @@SESSION.sql_mode AS modo");
    await db.query("SET SESSION sql_mode = ?", [fila.sql_mode]);
    await db.query(`DROP TRIGGER \`${nombre}\``);
    try { await db.query(nuevo); }
    catch (error) { await db.query(original); throw error; }
    finally { await db.query("SET SESSION sql_mode = ?", [sesion.modo]); }
  }
}

async function verificarCatalogo(db) {
  const columnas = [
    ["coseguro_tipo_reintegro", "grupo_codigo"], ["coseguro_tipo_reintegro", "grupo_nombre"],
    ["coseguro_tipo_reintegro", "grupo_icono"], ["coseguro_concepto", "tipo_reintegro_id"],
  ];
  const faltantes = [];
  for (const [tabla, columna] of columnas) {
    const [filas] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [tabla, columna]);
    if (!filas.length) faltantes.push(`${tabla}.${columna}`);
  }
  if (!await existeTabla(db, "coseguro_solicitud_concepto")) faltantes.push("coseguro_solicitud_concepto");
  if (faltantes.length) return { completo: false, faltantes };
  const [tipos] = await db.query("SELECT t.id, t.nombre, t.grupo_codigo, t.grupo_nombre, t.grupo_icono, i.codigo FROM coseguro_tipo_reintegro t LEFT JOIN coseguro_imputacion i ON i.id = t.imputacion_id WHERE t.activo = 1 ORDER BY i.codigo");
  const [conceptos] = await db.query("SELECT c.nombre, i.codigo FROM coseguro_concepto c JOIN coseguro_tipo_reintegro t ON t.id = c.tipo_reintegro_id JOIN coseguro_imputacion i ON i.id = t.imputacion_id WHERE c.activo = 1 AND t.activo = 1 ORDER BY i.codigo, c.nombre");
  const esperados = TIPOS.flatMap((tipo) => tipo.conceptos.map((nombre) => `${tipo.codigo}|${nombre}`)).sort();
  const actuales = conceptos.map((concepto) => `${concepto.codigo}|${concepto.nombre}`).sort();
  const [[inconsistencias]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM coseguro_solicitud s LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id WHERE t.id IS NULL OR t.activo = 0) AS tipos_inactivos,
    (SELECT COUNT(*) FROM coseguro_solicitud_concepto sc JOIN coseguro_solicitud s ON s.id = sc.solicitud_id JOIN coseguro_concepto c ON c.id = sc.concepto_id WHERE c.activo = 0 OR c.tipo_reintegro_id <> s.tipo_reintegro_id) AS conceptos_ajenos,
    (SELECT COUNT(*) FROM coseguro_solicitud s WHERE s.concepto_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM coseguro_solicitud_concepto sc WHERE sc.solicitud_id = s.id AND sc.concepto_id = s.concepto_id)) AS legado_inconsistente,
    (SELECT COUNT(*) FROM coseguro_solicitud s JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id WHERE EXISTS (SELECT 1 FROM coseguro_concepto c WHERE c.tipo_reintegro_id = t.id AND c.activo = 1) AND NOT EXISTS (SELECT 1 FROM coseguro_solicitud_concepto sc WHERE sc.solicitud_id = s.id)) AS conceptos_faltantes,
    (SELECT COUNT(*) FROM coseguro_solicitud s WHERE s.cic_codigo IS NULL OR s.cic_codigo = '') AS cic_faltantes,
    (SELECT COUNT(*) FROM coseguro_solicitud s JOIN coseguro_imputacion i ON i.id = s.imputacion_id WHERE s.cic_codigo <> i.codigo OR i.activo = 0) AS cic_inconsistente,
    (SELECT COUNT(*) FROM coseguro_solicitud s WHERE s.imputacion_detalle_id IS NOT NULL) AS detalles_obsoletos`);
  const catalogoCorrecto = tipos.length === TIPOS.length && TIPOS.every((tipo) => tipos.some((t) => t.codigo === tipo.codigo && t.nombre === tipo.nombre && t.grupo_codigo === tipo.grupo_codigo && t.grupo_nombre === tipo.grupo_nombre && t.grupo_icono === tipo.grupo_icono)) && JSON.stringify(esperados) === JSON.stringify(actuales);
  const [[estado]] = await db.query("SELECT COUNT(*) AS cantidad FROM coseguro_estado WHERE id = 11 AND nombre = 'Rechazado por Servicios Sociales'");
  const [triggersViejos] = await db.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('ajb_cos_claim_ai', 'ajb_cos_claim_au') AND ACTION_STATEMENT REGEXP 'NOT IN[[:space:]]*[(]5,[[:space:]]*6[)]'");
  return { completo: catalogoCorrecto && Number(estado.cantidad) === 1 && !triggersViejos.length && Object.values(inconsistencias).every((n) => Number(n) === 0), tipos: tipos.length, conceptos: conceptos.length, inconsistencias, triggers_pendientes: triggersViejos.length };
}

function seleccionarTipoLegado(solicitud, tiposViejos, conceptosViejos) {
  const tipoViejo = tiposViejos.find((t) => t.id === solicitud.tipo_reintegro_id);
  const conceptoViejo = conceptosViejos.find((c) => c.id === solicitud.concepto_id);
  let codigo = normalizarCicCodigo(tipoViejo?.codigo);
  if (tipoViejo?.grupo_codigo) return TIPOS.find((t) => t.codigo === codigo) || TIPOS.find((t) => t.codigo === "631.611");
  // «Otros» era el único tipo genérico: rescatar la prestación declarada en el concepto.
  if (codigo === "631.611" && conceptoViejo?.codigo) codigo = normalizarCicCodigo(conceptoViejo.codigo);
  if (normalizarNombre(conceptoViejo?.nombre) === "marcos" && codigo === "631.604") codigo = "631.605";
  return TIPOS.find((t) => t.codigo === codigo) || TIPOS.find((t) => t.codigo === "631.611");
}

function seleccionarConceptosLegados(tipo, solicitud, tipoViejo, conceptoViejo, conceptos) {
  if (!tipo.conceptos.length) return [];
  const nombres = { instrumentista: "Instrumentación quirúrgica", psicologia: "Terapia individual", "practicas quirurgicas": "Otros" };
  let nombre = nombres[normalizarNombre(conceptoViejo?.nombre)] || conceptoViejo?.nombre;
  if (tipo.codigo === "631.206") nombre = /sin cobertura/i.test(tipoViejo?.nombre || "") ? "Sin cobertura IOMA" : "Con cobertura IOMA";
  const elegido = conceptos.find((c) => c.tipo_reintegro_id === tipo.id && normalizarNombre(c.nombre) === normalizarNombre(nombre));
  return [elegido?.id || conceptos.find((c) => c.tipo_reintegro_id === tipo.id).id];
}

function resolverImputacionMigrada(solicitud, tipoViejo, tipo, tiposNuevos) {
  const previo = normalizarCicCodigo(solicitud.cic_codigo);
  const yaMigrado = Boolean(tipoViejo?.grupo_codigo);
  const personalizado = previo && !TIPOS.some((t) => t.codigo === previo);
  // Una vez normalizado el catálogo, las decisiones contables del personal son
  // válidas aunque elijan otra cuenta existente; reejecutar no debe deshacerlas.
  const codigo = previo && (yaMigrado || personalizado) ? previo : tipo.codigo;
  return { codigo, imputacionId: tiposNuevos.find((t) => t.codigo === codigo)?.imputacion_id || null };
}

async function ejecutarMigracion(db, { checkOnly = false } = {}) {
  if (checkOnly) return verificarCatalogo(db);
  const [[lock]] = await db.query("SELECT GET_LOCK('ajb:coseguro:catalogo631:v1', 15) AS adquirido");
  if (Number(lock.adquirido) !== 1) throw new Error("No se pudo bloquear la migración del catálogo");
  try {
    // DDL se confirma implícitamente en MySQL; cada paso puede retomarse sin duplicar datos.
    await asegurarColumna(db, "coseguro_tipo_reintegro", "grupo_codigo", "VARCHAR(20) NULL");
    await asegurarColumna(db, "coseguro_tipo_reintegro", "grupo_nombre", "VARCHAR(80) NULL");
    await asegurarColumna(db, "coseguro_tipo_reintegro", "grupo_icono", "VARCHAR(40) NULL");
    await asegurarColumna(db, "coseguro_concepto", "tipo_reintegro_id", "INT NULL");
    await ampliarCodigo(db, "coseguro_solicitud", "cic_codigo");
    await ampliarCodigo(db, "coseguro_imputacion", "codigo");
    await db.query(`CREATE TABLE IF NOT EXISTS coseguro_solicitud_concepto (
      solicitud_id INT NOT NULL, concepto_id INT NOT NULL,
      PRIMARY KEY (solicitud_id, concepto_id), KEY idx_cos_sc_concepto (concepto_id),
      CONSTRAINT fk_cos_sc_solicitud FOREIGN KEY (solicitud_id) REFERENCES coseguro_solicitud(id) ON DELETE CASCADE,
      CONSTRAINT fk_cos_sc_concepto FOREIGN KEY (concepto_id) REFERENCES coseguro_concepto(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await actualizarTriggersRechazo(db);
    await db.beginTransaction();
    try {
      const [tiposViejos] = await db.query("SELECT t.*, i.codigo FROM coseguro_tipo_reintegro t LEFT JOIN coseguro_imputacion i ON i.id = t.imputacion_id");
      const [conceptosViejos] = await db.query("SELECT c.*, i.codigo FROM coseguro_concepto c LEFT JOIN coseguro_imputacion i ON i.id = c.imputacion_id");
      const [solicitudes] = await db.query("SELECT * FROM coseguro_solicitud FOR UPDATE");
      const [asociaciones] = await db.query("SELECT solicitud_id, concepto_id FROM coseguro_solicitud_concepto");
      const [archivos] = await db.query("SELECT id, solicitud_id, tipo_adjunto FROM coseguro_archivo ORDER BY id");
      const [historialViejo] = await db.query("SELECT * FROM coseguro_historial ORDER BY solicitud_id, id");
      const rechazosCentrales = new Set(historialViejo.filter((h) => h.estado_nuevo_id === 5 && (h.usuario_rol === 'admin-central' || (h.usuario_rol === 'admin' && h.estado_anterior_id === 4))).map((h) => h.id));
      await db.query("INSERT INTO coseguro_estado (id, nombre, nombre_afiliado, color, color_texto, orden) VALUES (11, 'Rechazado por Servicios Sociales', NULL, '#FFCDD2', '#B71C1C', 11) ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), color = VALUES(color), color_texto = VALUES(color_texto), orden = VALUES(orden)");
      await db.query("UPDATE coseguro_imputacion SET activo = 0");
      await db.query("INSERT INTO coseguro_imputacion (codigo, descripcion, tipo, activo, orden) VALUES ('631.000', 'Gastos en prestaciones', 'RUBRO', 1, 0) ON DUPLICATE KEY UPDATE descripcion = VALUES(descripcion), activo = 1");
      const [[raiz]] = await db.query("SELECT id FROM coseguro_imputacion WHERE codigo = '631.000'");
      for (const grupo of GRUPOS.filter((g) => g.codigo.startsWith("631.") && g.codigo !== "631.000")) {
        await db.query("INSERT INTO coseguro_imputacion (codigo, descripcion, tipo, parent_id, activo, orden) VALUES (?, ?, 'RUBRO', ?, 1, ?) ON DUPLICATE KEY UPDATE descripcion = VALUES(descripcion), parent_id = VALUES(parent_id), activo = 1", [grupo.codigo, grupo.nombre, raiz.id, Number(grupo.codigo.replace('.', ''))]);
      }
      const [rubros] = await db.query("SELECT id, codigo FROM coseguro_imputacion WHERE codigo IN ('631.000','631.100','631.200','631.300','631.400','631.500','631.600')");
      const tiposNuevos = [];
      const usados = new Set();
      for (const [orden, tipo] of TIPOS.entries()) {
        const parentId = tipo.codigo === "631.000" ? null
          : tipo.codigo === tipo.grupo_codigo ? raiz.id
          : rubros.find((r) => r.codigo === tipo.grupo_codigo)?.id || null;
        await db.query("INSERT INTO coseguro_imputacion (codigo, descripcion, tipo, parent_id, activo, orden) VALUES (?, ?, 'CUENTA', ?, 1, ?) ON DUPLICATE KEY UPDATE descripcion = VALUES(descripcion), tipo = 'CUENTA', parent_id = VALUES(parent_id), activo = 1, orden = VALUES(orden)", [tipo.codigo, tipo.nombre, parentId, Number(tipo.codigo.replace('.', ''))]);
        const [[cuenta]] = await db.query("SELECT id FROM coseguro_imputacion WHERE codigo = ?", [tipo.codigo]);
        const anterior = tiposViejos.find((t) => t.codigo === tipo.codigo && !usados.has(t.id))
          || tiposViejos.find((t) => t.nombre === tipo.nombre && !usados.has(t.id));
        const parametros = [tipo.nombre, tipo.icono, cuenta.id, tipo.requiere_pto_venta, JSON.stringify(tipo.adjuntos), orden + 1, tipo.grupo_codigo, tipo.grupo_nombre, tipo.grupo_icono, ["631.503", "631.504", "631.613", "631.614", "511.701"].includes(tipo.codigo) ? 1 : 0];
        let id;
        if (anterior) {
          id = anterior.id;
          // Mantener la cobertura y la clasificación de subsidio configuradas por el personal.
          await db.query("UPDATE coseguro_tipo_reintegro SET nombre=?, icono=?, imputacion_id=?, imputacion_detalle_id=NULL, requiere_pto_venta=?, adjuntos_config=?, orden=?, grupo_codigo=?, grupo_nombre=?, grupo_icono=?, activo=1 WHERE id=?", [...parametros.slice(0, 9), id]);
        } else {
          const [resultado] = await db.query("INSERT INTO coseguro_tipo_reintegro (nombre, icono, imputacion_id, requiere_pto_venta, adjuntos_config, orden, grupo_codigo, grupo_nombre, grupo_icono, es_subsidio, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)", parametros);
          id = resultado.insertId;
        }
        usados.add(id);
        tiposNuevos.push({ ...tipo, id, imputacion_id: cuenta.id });
      }
      await db.query(`UPDATE coseguro_tipo_reintegro SET activo=0 WHERE id NOT IN (${[...usados].map(() => '?').join(',')})`, [...usados]);
      const conceptosNuevos = [];
      for (const tipo of tiposNuevos) {
        for (const [orden, nombre] of tipo.conceptos.entries()) {
          await db.query("INSERT INTO coseguro_imputacion (codigo, descripcion, tipo, parent_id, activo, orden) SELECT NULL, ?, 'DETALLE', ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM coseguro_imputacion WHERE tipo = 'DETALLE' AND parent_id = ? AND descripcion = ?)", [nombre, tipo.imputacion_id, orden + 1, tipo.imputacion_id, nombre]);
          const [[detalle]] = await db.query("SELECT id FROM coseguro_imputacion WHERE tipo = 'DETALLE' AND parent_id = ? AND descripcion = ? ORDER BY id LIMIT 1", [tipo.imputacion_id, nombre]);
          await db.query("UPDATE coseguro_imputacion SET activo=1 WHERE id=?", [detalle.id]);
          await db.query("INSERT INTO coseguro_concepto (nombre, tipo_reintegro_id, imputacion_id, imputacion_detalle_id, activo, orden) VALUES (?, ?, ?, ?, 1, ?) ON DUPLICATE KEY UPDATE tipo_reintegro_id=VALUES(tipo_reintegro_id), imputacion_id=VALUES(imputacion_id), imputacion_detalle_id=VALUES(imputacion_detalle_id), activo=1, orden=VALUES(orden)", [nombre, tipo.id, tipo.imputacion_id, detalle.id, orden + 1]);
          const [[concepto]] = await db.query("SELECT id FROM coseguro_concepto WHERE nombre = ?", [nombre]);
          conceptosNuevos.push({ id: concepto.id, nombre, tipo_reintegro_id: tipo.id });
        }
      }
      await db.query(`UPDATE coseguro_concepto SET activo=0 WHERE id NOT IN (${conceptosNuevos.map(() => '?').join(',')})`, conceptosNuevos.map((c) => c.id));
      const mapeoTipos = new Map(tiposViejos.map((t) => [t.id, tiposNuevos.find((nuevo) => nuevo.codigo === t.codigo)?.id || tiposNuevos.find((nuevo) => nuevo.codigo === "631.611").id]));
      const mapeoConceptos = new Map(conceptosViejos.map((c) => [c.id, conceptosNuevos.find((nuevo) => normalizarNombre(nuevo.nombre) === normalizarNombre(c.nombre))?.id || null]));
      let corregidas = 0;
      for (const solicitud of solicitudes) {
        const tipoCatalogo = seleccionarTipoLegado(solicitud, tiposViejos, conceptosViejos);
        const tipo = tiposNuevos.find((t) => t.codigo === tipoCatalogo.codigo);
        const tipoViejo = tiposViejos.find((t) => t.id === solicitud.tipo_reintegro_id);
        const conceptoViejo = conceptosViejos.find((c) => c.id === solicitud.concepto_id);
        let ids = asociaciones.filter((sc) => sc.solicitud_id === solicitud.id).map((sc) => sc.concepto_id).filter((id) => conceptosNuevos.some((c) => c.id === id && c.tipo_reintegro_id === tipo.id));
        if (!ids.length) ids = seleccionarConceptosLegados(tipo, solicitud, tipoViejo, conceptoViejo, conceptosNuevos);
        ids.sort((a,b) => conceptosNuevos.find((c) => c.id === a).nombre.localeCompare(conceptosNuevos.find((c) => c.id === b).nombre, 'es'));
        const { codigo, imputacionId } = resolverImputacionMigrada(solicitud, tipoViejo, tipo, tiposNuevos);
        const ultimoCambio = historialViejo.filter((h) => h.solicitud_id === solicitud.id && h.tipo_operacion === 'CAMBIO_ESTADO').at(-1);
        const estado = solicitud.estado_id === 5 && rechazosCentrales.has(ultimoCambio?.id) ? 11 : solicitud.estado_id;
        if (solicitud.tipo_reintegro_id !== tipo.id || solicitud.concepto_id !== (ids[0] || null) || solicitud.cic_codigo !== codigo || solicitud.imputacion_id !== imputacionId || solicitud.imputacion_detalle_id !== null || estado !== solicitud.estado_id) {
          await db.query("UPDATE coseguro_solicitud SET tipo_reintegro_id=?, concepto_id=?, imputacion_id=?, imputacion_detalle_id=NULL, cic_codigo=?, estado_id=? WHERE id=?", [tipo.id, ids[0] || null, imputacionId, codigo, estado, solicitud.id]);
          corregidas++;
        }
        const previos = asociaciones.filter((sc) => sc.solicitud_id === solicitud.id).map((sc) => sc.concepto_id).sort((a,b) => a-b);
        if (JSON.stringify(previos) !== JSON.stringify([...ids].sort((a,b) => a-b))) {
          await db.query("DELETE FROM coseguro_solicitud_concepto WHERE solicitud_id=?", [solicitud.id]);
          for (const id of ids) await db.query("INSERT INTO coseguro_solicitud_concepto (solicitud_id, concepto_id) VALUES (?, ?)", [solicitud.id, id]);
        }
        // Los comprobantes genéricos anteriores siguen siendo el mismo archivo válido.
        const principal = tipo.adjuntos.find((a) => a.requerido)?.key;
        const actuales = archivos.filter((a) => a.solicitud_id === solicitud.id);
        if (principal === 'FACTURA' && !actuales.some((a) => a.tipo_adjunto === 'FACTURA')) {
          const evidencia = actuales.find((a) => ['COMPROBANTE','TICKET_FISCAL','BONO_FRENTE'].includes(a.tipo_adjunto));
          if (evidencia) await db.query("UPDATE coseguro_archivo SET tipo_adjunto='FACTURA' WHERE id=?", [evidencia.id]);
        }
      }
      // Reclasificar rechazos históricos emitidos por Servicios Sociales.
      const estadoPrevio = new Map();
      for (const h of historialViejo) {
        const anterior = h.estado_anterior_id === 5 && estadoPrevio.get(h.solicitud_id) === 11 ? 11 : h.estado_anterior_id;
        const nuevo = rechazosCentrales.has(h.id) ? 11 : h.estado_nuevo_id;
        if (anterior !== h.estado_anterior_id || nuevo !== h.estado_nuevo_id) await db.query("UPDATE coseguro_historial SET estado_anterior_id=?, estado_nuevo_id=? WHERE id=?", [anterior, nuevo, h.id]);
        if (nuevo !== null) estadoPrevio.set(h.solicitud_id, nuevo);
      }
      await db.query("UPDATE coseguro_observacion SET estado_id=11 WHERE estado_id=5 AND usuario_rol IN ('admin-central','admin') AND solicitud_id IN (SELECT id FROM coseguro_solicitud WHERE estado_id=11)");
      // Conservar historial ya existente con los IDs remapeados; no generar auditoría nueva.
      const [historial] = await db.query("SELECT id, campo_modificado, valor_anterior, valor_nuevo FROM coseguro_historial WHERE campo_modificado IN ('Tipo de reintegro','Concepto','tipo_reintegro_id','concepto_id')");
      for (const fila of historial) {
        const mapa = /concepto/i.test(fila.campo_modificado) ? mapeoConceptos : mapeoTipos;
        const remap = (valor) => {
          if (/^\d+$/.test(String(valor || '')) && mapa.has(Number(valor))) return mapa.get(Number(valor));
          if (/tipo/i.test(fila.campo_modificado)) {
            const previo = tiposViejos.find((t) => normalizarNombre(t.nombre) === normalizarNombre(valor));
            const nuevo = previo && tiposNuevos.find((t) => t.id === mapeoTipos.get(previo.id));
            if (nuevo) return nuevo.nombre;
          }
          return valor;
        };
        const anterior = remap(fila.valor_anterior), nuevo = remap(fila.valor_nuevo);
        if (anterior !== fila.valor_anterior || nuevo !== fila.valor_nuevo) await db.query("UPDATE coseguro_historial SET valor_anterior=?, valor_nuevo=? WHERE id=?", [anterior, nuevo, fila.id]);
      }
      const resultado = await verificarCatalogo(db);
      if (!resultado.completo) throw new Error(`Verificación del catálogo falló: ${JSON.stringify(resultado)}`);
      await db.commit();
      return { ...resultado, solicitudes_corregidas: corregidas };
    } catch (error) { await db.rollback(); throw error; }
  } finally { await db.query("SELECT RELEASE_LOCK('ajb:coseguro:catalogo631:v1')"); }
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => a.startsWith('--target='))?.split('=')[1] || 'develop';
  if (!['develop','production','all'].includes(target)) throw new Error('Target inválido');
  const checkOnly = !args.includes('--apply');
  const envPath = args.find((a) => a.startsWith('--env-file='))?.slice(11) || path.resolve(__dirname,'../.env');
  const bloques = parsearBloquesEnv(fs.readFileSync(envPath, 'utf8'));
  for (const nombre of target === 'all' ? ['develop','production'] : [target]) {
    const config = { ...bloques[nombre] };
    for (const key of ['DB_SSL_MODE','DB_SSL_CA_PATH']) if (process.env[key]) config[key] = process.env[key];
    const db = await mysql.createConnection(crearOpcionesConexion(config));
    try { console.log(JSON.stringify({ target: nombre, ...await ejecutarMigracion(db, {checkOnly}) })); }
    finally { await db.end(); }
  }
}

if (require.main === module) main().catch((error) => { console.error(error.code || error.message); process.exitCode=1; });
module.exports = { ejecutarMigracion, verificarCatalogo, obtenerSnapshot, seleccionarTipoLegado, seleccionarConceptosLegados, resolverImputacionMigrada };
