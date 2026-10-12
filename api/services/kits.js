"use strict";

const { exigirAltaParaUsuario } = require("../security/restricciones-cuenta");
const { crearNotificacion } = require("./notificaciones");

const ESTADOS = Object.freeze([
  { id: 1, codigo: "PENDIENTE", nombre: "En revisión", color: "#fff4d6", color_texto: "#755500" },
  { id: 2, codigo: "APROBADA", nombre: "Aprobada", color: "#e2f1ff", color_texto: "#175c91" },
  { id: 3, codigo: "LISTA_RETIRO", nombre: "Lista para retirar", color: "#e2f5ec", color_texto: "#176344" },
  { id: 4, codigo: "ENTREGADA", nombre: "Entregada", color: "#e2f5ec", color_texto: "#176344" },
  { id: 5, codigo: "RECHAZADA", nombre: "Rechazada", color: "#fde8e8", color_texto: "#a12727" },
  { id: 6, codigo: "CANCELADA", nombre: "Cancelada", color: "#edf0f4", color_texto: "#526075" },
]);
const TRANSICIONES = Object.freeze({
  PENDIENTE: ["APROBADA", "RECHAZADA", "CANCELADA"],
  APROBADA: ["LISTA_RETIRO", "ENTREGADA", "RECHAZADA", "CANCELADA"],
  LISTA_RETIRO: ["ENTREGADA", "CANCELADA"], ENTREGADA: [], RECHAZADA: [], CANCELADA: [],
});
const STAFF = new Set(["admin", "admin-central", "departamental"]);
function error(mensaje, statusCode = 400) { return Object.assign(new Error(mensaje), { statusCode }); }
function idValido(valor) { const id = Number(valor); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function texto(valor, max, obligatorio = false) {
  if (valor != null && typeof valor !== "string") throw error("Hay un texto inválido en el formulario");
  const result = String(valor || "").trim();
  if ((obligatorio && !result) || result.length > max) throw error(`Completá los campos requeridos y respetá el límite de ${max} caracteres`);
  return result || null;
}
function booleano(valor, defecto = false) {
  if (valor === undefined || valor === null || valor === "") return defecto;
  if ([true, 1, "1", "true"].includes(valor)) return true;
  if ([false, 0, "0", "false"].includes(valor)) return false;
  throw error("El valor de publicación es inválido");
}
function fecha(valor, obligatorio = false) {
  if (!valor && !obligatorio) return null;
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || Number.isNaN(Date.parse(valor))
    || new Date(`${valor}T12:00:00Z`).toISOString().slice(0, 10) !== valor) throw error("Ingresá una fecha válida");
  return valor;
}
function hoyArgentina(ahora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}
function periodoCampania(campania, hoy = hoyArgentina()) {
  if (!Number(campania.publicado)) return "BORRADOR";
  if (hoy < campania.inscripcion_desde) return "PROXIMAMENTE";
  if (hoy > campania.inscripcion_hasta) return "CERRADA";
  return "ABIERTA";
}
function exigirStaff(actor) { if (!STAFF.has(actor?.rol)) throw error("No tenés permiso para administrar kits", 403); }
function exigirPropietario(actor, campania) {
  exigirStaff(actor);
  if (actor.rol === "departamental" && Number(actor.departamental_id) !== Number(campania.departamental_id)) throw error("Esta campaña pertenece a otra departamental", 403);
}
function exigirAfiliado(actor) { if (actor?.rol !== "afiliado" || actor.acceso_familiar_turismo) throw error("Esta gestión está disponible para afiliados titulares", 403); }
function normalizarCampania(body, actor) {
  exigirStaff(actor);
  const departamentalId = actor.rol === "departamental" ? idValido(actor.departamental_id) : idValido(body.departamental_id);
  if (!departamentalId) throw error("Elegí una departamental");
  if (actor.rol === "departamental" && body.departamental_id && Number(body.departamental_id) !== departamentalId) throw error("Solo podés administrar kits de tu departamental", 403);
  let opciones = body.opciones;
  if (typeof opciones === "string") { try { opciones = JSON.parse(opciones); } catch (_) { throw error("Las opciones de kits son inválidas"); } }
  if (!Array.isArray(opciones) || opciones.length < 1 || opciones.length > 30) throw error("Agregá entre 1 y 30 opciones de kits");
  const ids = new Set();
  opciones = opciones.map((opcion) => {
    if (!opcion || typeof opcion !== "object" || !["HIJO", "TITULAR"].includes(opcion.destinatario)) throw error("Indicá si cada kit es para un hijo o para el titular");
    const id = opcion.id == null ? null : idValido(opcion.id);
    if ((opcion.id != null && !id) || (id && ids.has(id))) throw error("Las opciones de kits son inválidas");
    if (id) ids.add(id);
    return { id, nombre: texto(opcion.nombre, 180, true), descripcion: texto(opcion.descripcion, 3000), destinatario: opcion.destinatario, activo: booleano(opcion.activo, true) };
  });
  const result = { departamental_id: departamentalId, titulo: texto(body.titulo, 180, true), descripcion: texto(body.descripcion, 10000),
    inscripcion_desde: fecha(body.inscripcion_desde, true), inscripcion_hasta: fecha(body.inscripcion_hasta, true),
    entrega_desde: fecha(body.entrega_desde), entrega_hasta: fecha(body.entrega_hasta), lugar_entrega: texto(body.lugar_entrega, 500),
    publicado: booleano(body.publicado), opciones };
  if (result.inscripcion_desde > result.inscripcion_hasta) throw error("El cierre de inscripción debe ser posterior al inicio");
  if (result.entrega_hasta && !result.entrega_desde) throw error("Indicá el inicio estimado de la entrega");
  if (result.entrega_desde && result.entrega_hasta && result.entrega_desde > result.entrega_hasta) throw error("Revisá el período de entrega");
  if (result.publicado && !opciones.some((opcion) => opcion.activo)) throw error("Activá al menos una opción para publicar la campaña");
  return result;
}
function validarArchivo(file, imagen = false) {
  if (!file) return;
  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 10 * 1024 * 1024) throw error("El archivo debe pesar hasta 10 MB");
  const formato = {
    "image/jpeg": buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    "image/png": buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/webp": buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP",
    "application/pdf": !imagen && buffer.subarray(0, 5).toString() === "%PDF-",
  };
  if (!formato[file.mimetype]) throw error(imagen ? "Elegí una imagen JPG, PNG o WebP válida" : "Elegí un PDF o una imagen JPG, PNG o WebP válida");
}
const SELECT_CAMPANIA = `SELECT k.*, d.nombre AS departamental_nombre FROM kit_campania k INNER JOIN departamental d ON d.id = k.departamental_id`;
async function buscarCampania(db, id, bloquear = false) {
  if (!idValido(id)) throw error("Campaña inválida");
  const [rows] = await db.query(`${SELECT_CAMPANIA} WHERE k.id = ?${bloquear ? " FOR UPDATE" : ""}`, [Number(id)]);
  if (!rows.length) throw error("No encontramos esta campaña", 404);
  return rows[0];
}
async function serializarCampania(db, campania, actor, media) {
  const [opciones] = await db.query(`SELECT id, nombre, descripcion, destinatario, activo FROM kit_opcion WHERE campania_id = ?${actor.rol === "afiliado" ? " AND activo = 1" : ""} ORDER BY orden, id`, [campania.id]);
  const estadoPeriodo = periodoCampania(campania);
  const { imagen_archivo, ...result } = campania;
  return { ...result, publicado: !!Number(campania.publicado), opciones: opciones.map((o) => ({ ...o, activo: !!Number(o.activo) })), estado_periodo: estadoPeriodo,
    inscripcion_abierta: estadoPeriodo === "ABIERTA" && (actor.rol !== "afiliado" || Number(campania.departamental_id) === Number(actor.departamental_id)),
    imagen_url: imagen_archivo ? await media.firmar(imagen_archivo) : null };
}
async function listarCampanias(db, actor, media) {
  const params = [];
  let where = "";
  if (actor.rol === "afiliado") { exigirAfiliado(actor); where = " WHERE k.departamental_id = ? AND k.publicado = 1"; params.push(actor.departamental_id || 0); }
  else { exigirStaff(actor); if (actor.rol === "departamental") { where = " WHERE k.departamental_id = ?"; params.push(actor.departamental_id || 0); } }
  const [rows] = await db.query(`${SELECT_CAMPANIA}${where} ORDER BY k.inscripcion_hasta DESC, k.id DESC LIMIT 200`, params);
  return Promise.all(rows.map((campania) => serializarCampania(db, campania, actor, media)));
}
async function detalleCampania(db, actor, id, media) {
  const campania = await buscarCampania(db, id);
  if (actor.rol === "afiliado") {
    exigirAfiliado(actor);
    if (Number(campania.departamental_id) !== Number(actor.departamental_id) || !Number(campania.publicado)) {
      // Una campaña retirada sigue siendo consultable por quien ya se inscribió,
      // incluso después de trasladarse a otra departamental. No habilita nuevas altas.
      const [propias] = await db.query("SELECT id FROM kit_inscripcion WHERE campania_id = ? AND usuario_id = ? LIMIT 1", [campania.id, actor.id]);
      if (!propias.length) throw error("No encontramos esta campaña", 404);
    }
  } else exigirPropietario(actor, campania);
  const result = await serializarCampania(db, campania, actor, media);
  if (actor.rol === "afiliado") result.mis_inscripciones = await listarInscripciones(db, actor, { campania_id: campania.id });
  return result;
}
async function guardarCampania(db, actor, body, id, file, media) {
  const datos = normalizarCampania(body, actor);
  validarArchivo(file, true);
  const anterior = id ? await buscarCampania(db, id, true) : null;
  if (anterior) {
    exigirPropietario(actor, anterior);
    if (Number(anterior.departamental_id) !== datos.departamental_id) throw error("La departamental de una campaña creada no se puede cambiar");
  }
  const [departamentales] = await db.query("SELECT id FROM departamental WHERE id = ?", [datos.departamental_id]);
  if (!departamentales.length) throw error("La departamental no existe");
  let imagen = anterior?.imagen_archivo || null;
  if (booleano(body.quitar_imagen)) imagen = null;
  if (file) imagen = await media.guardar(file, "imagenes");
  const campos = { ...datos, imagen_archivo: imagen };
  delete campos.opciones;
  if (anterior) await db.query("UPDATE kit_campania SET ? WHERE id = ?", [campos, anterior.id]);
  else { const [result] = await db.query("INSERT INTO kit_campania SET ?", [{ ...campos, creado_por: actor.id }]); id = result.insertId; }
  if (anterior) await db.query("UPDATE kit_opcion SET activo = 0 WHERE campania_id = ?", [id]);
  for (const [orden, opcion] of datos.opciones.entries()) {
    const { id: opcionId, ...camposOpcion } = opcion;
    if (opcionId) {
      if (!anterior) throw error("No se puede reutilizar una opción de otra campaña");
      const [opciones] = await db.query("SELECT id, destinatario FROM kit_opcion WHERE id = ? AND campania_id = ?", [opcionId, id]);
      if (!opciones.length) throw error("Una opción no pertenece a esta campaña");
      if (opciones[0].destinatario !== opcion.destinatario) {
        const [inscriptos] = await db.query("SELECT id FROM kit_inscripcion WHERE opcion_id = ? LIMIT 1", [opcionId]);
        if (inscriptos.length) throw error("No se puede cambiar el destinatario de una opción con inscripciones; creá otra opción");
      }
      await db.query("UPDATE kit_opcion SET ? WHERE id = ? AND campania_id = ?", [{ ...camposOpcion, orden }, opcionId, id]);
    } else await db.query("INSERT INTO kit_opcion SET ?", [{ ...camposOpcion, orden, campania_id: id }]);
  }
  return { id: Number(id), anterior_imagen: anterior?.imagen_archivo && anterior.imagen_archivo !== imagen ? anterior.imagen_archivo : null };
}
function normalizarInscripcion(body, opcion, usuario) {
  if (body.vinculo && body.vinculo !== opcion.destinatario) throw error("La persona elegida no corresponde a esta opción de kit");
  let nombre = texto(body.nombre_beneficiario, 180, opcion.destinatario !== "TITULAR");
  let dni = String(body.dni_beneficiario || "").replace(/[.\s-]/g, "");
  const documentoTitular = String(usuario.documento || "").replace(/[.\s-]/g, "");
  if (opcion.destinatario === "TITULAR") {
    if (dni && dni !== documentoTitular) throw error("El kit para el titular debe solicitarse con tu propio DNI");
    dni = documentoTitular; nombre = `${usuario.nombre || ""} ${usuario.apellido || ""}`.trim();
  } else if (dni === documentoTitular) throw error("Para un kit escolar ingresá el DNI de tu hijo o hija");
  if (!/^\d{6,9}$/.test(dni)) throw error("Ingresá un DNI válido de 6 a 9 dígitos");
  if (!nombre) throw error("Completá el nombre de la persona beneficiaria");
  return { nombre_beneficiario: nombre, dni_beneficiario: dni, anio_cursada: texto(body.anio_cursada, 80, true),
    observaciones: texto(body.observaciones, 3000), vinculo: opcion.destinatario };
}
async function inscribir(db, actor, id, body, file, media) {
  exigirAfiliado(actor);
  exigirAltaParaUsuario(actor, "beneficios");
  validarArchivo(file);
  const campania = await buscarCampania(db, id, true);
  if (Number(campania.departamental_id) !== Number(actor.departamental_id)) throw error("Esta campaña es para afiliados de otra departamental", 403);
  if (periodoCampania(campania) !== "ABIERTA") throw error("La inscripción a esta campaña no está abierta", 409);
  const [opciones] = await db.query("SELECT * FROM kit_opcion WHERE id = ? AND campania_id = ? AND activo = 1", [idValido(body.opcion_id) || 0, campania.id]);
  if (!opciones.length) throw error("Elegí una opción disponible de esta campaña");
  const [usuarios] = await db.query("SELECT nombre, apellido, documento FROM usuario WHERE id = ?", [actor.id]);
  if (!usuarios.length) throw error("No encontramos tu usuario", 404);
  const datos = normalizarInscripcion(body, opciones[0], usuarios[0]);
  const [existentes] = await db.query("SELECT id FROM kit_inscripcion WHERE campania_id = ? AND dni_beneficiario = ? AND estado NOT IN ('RECHAZADA', 'CANCELADA') LIMIT 1", [campania.id, datos.dni_beneficiario]);
  if (existentes.length) throw error("Ya existe una inscripción para este DNI en la campaña", 409);
  const documento = file ? await media.guardar(file, "documentos") : null;
  const [result] = await db.query("INSERT INTO kit_inscripcion SET ?", [{ ...datos, campania_id: campania.id, opcion_id: opciones[0].id, usuario_id: actor.id,
    documento_archivo: documento, documento_nombre: file ? texto(file.originalname, 255, true) : null, documento_mime: file?.mimetype || null }]);
  await db.query("INSERT INTO kit_inscripcion_historial (inscripcion_id, estado, usuario_id) VALUES (?, 'PENDIENTE', ?)", [result.insertId, actor.id]);
  return { id: result.insertId, codigo: `K-${result.insertId}` };
}
const SELECT_INSCRIPCION = `SELECT i.*, k.titulo AS campania_titulo, k.departamental_id, k.entrega_desde, k.entrega_hasta, k.lugar_entrega,
  d.nombre AS departamental_nombre, o.nombre AS opcion_nombre, CONCAT(u.nombre, ' ', u.apellido) AS afiliado_nombre,
  u.documento AS afiliado_dni FROM kit_inscripcion i INNER JOIN kit_campania k ON k.id = i.campania_id
  INNER JOIN kit_opcion o ON o.id = i.opcion_id INNER JOIN departamental d ON d.id = k.departamental_id INNER JOIN usuario u ON u.id = i.usuario_id`;
function serializarInscripcion(fila) {
  const { documento_archivo, ...result } = fila;
  const estado = ESTADOS.find((e) => e.codigo === fila.estado) || ESTADOS[0];
  return { ...result, codigo: `K-${fila.id}`, tiene_documento: !!documento_archivo, estado_id: estado.id, estado_nombre: estado.nombre,
    estado_color: estado.color, estado_color_texto: estado.color_texto };
}
async function listarInscripciones(db, actor, filtros = {}) {
  const condiciones = [], params = [];
  if (actor.rol === "afiliado") { exigirAfiliado(actor); condiciones.push("i.usuario_id = ?"); params.push(actor.id); }
  else { exigirStaff(actor); if (actor.rol === "departamental") { condiciones.push("k.departamental_id = ?"); params.push(actor.departamental_id || 0); } }
  if (filtros.campania_id) { if (!idValido(filtros.campania_id)) throw error("Campaña inválida"); condiciones.push("i.campania_id = ?"); params.push(Number(filtros.campania_id)); }
  if (filtros.estado) { if (!ESTADOS.some((e) => e.codigo === filtros.estado)) throw error("Estado inválido"); condiciones.push("i.estado = ?"); params.push(filtros.estado); }
  const [rows] = await db.query(`${SELECT_INSCRIPCION}${condiciones.length ? ` WHERE ${condiciones.join(" AND ")}` : ""} ORDER BY i.fecha_creacion DESC, i.id DESC`, params);
  return rows.map(serializarInscripcion);
}
async function buscarInscripcion(db, actor, id, bloquear = false) {
  if (!idValido(id)) throw error("Inscripción inválida");
  const [rows] = await db.query(`${SELECT_INSCRIPCION} WHERE i.id = ?${bloquear ? " FOR UPDATE" : ""}`, [Number(id)]);
  if (!rows.length) throw error("No encontramos la inscripción", 404);
  const row = rows[0];
  if (actor.rol === "afiliado") { exigirAfiliado(actor); if (Number(row.usuario_id) !== Number(actor.id)) throw error("No encontramos la inscripción", 404); }
  else exigirPropietario(actor, row);
  return row;
}
async function detalleInscripcion(db, actor, id) {
  const row = await buscarInscripcion(db, actor, id);
  const [historial] = await db.query("SELECT estado, observacion, fecha_creacion FROM kit_inscripcion_historial WHERE inscripcion_id = ? ORDER BY id", [row.id]);
  return { ...serializarInscripcion(row), historial };
}
function validarTransicion(actor, actual, siguiente, observacion) {
  if (!TRANSICIONES[actual]?.includes(siguiente)) throw error("El cambio de estado no está permitido", 409);
  if (actor.rol === "afiliado" && (siguiente !== "CANCELADA" || !["PENDIENTE", "APROBADA"].includes(actual))) throw error("Solo podés cancelar una inscripción pendiente o aprobada", 403);
  if (siguiente === "RECHAZADA" && !observacion) throw error("Indicá el motivo del rechazo para que el afiliado pueda consultarlo");
}
async function cambiarEstado(db, actor, id, body) {
  const row = await buscarInscripcion(db, actor, id, true);
  const observacion = texto(body.observacion_estado, 3000);
  validarTransicion(actor, row.estado, body.estado, observacion);
  await db.query("UPDATE kit_inscripcion SET estado = ?, observacion_estado = ?, resuelto_por = ? WHERE id = ?", [body.estado, observacion, actor.id, row.id]);
  await db.query("INSERT INTO kit_inscripcion_historial (inscripcion_id, estado, observacion, usuario_id) VALUES (?, ?, ?, ?)", [row.id, body.estado, observacion, actor.id]);
  if (actor.rol !== "afiliado") await crearNotificacion(db, { usuarioId: row.usuario_id, tipo: "KIT_ESTADO", titulo: `Tu kit: ${ESTADOS.find((e) => e.codigo === body.estado).nombre}`,
    mensaje: `${row.campania_titulo}. ${observacion || "Podés consultar el detalle en Mis gestiones."}`, payload: { inscripcion_id: row.id, url: "/mis-gestiones?tipo=kit" } });
  return { id: row.id, estado: body.estado };
}
module.exports = { ESTADOS, TRANSICIONES, STAFF, error, fecha, hoyArgentina, periodoCampania, exigirStaff, exigirPropietario, exigirAfiliado,
  normalizarCampania, validarArchivo, normalizarInscripcion, validarTransicion, listarCampanias, detalleCampania, guardarCampania,
  inscribir, listarInscripciones, buscarInscripcion, detalleInscripcion, cambiarEstado };
