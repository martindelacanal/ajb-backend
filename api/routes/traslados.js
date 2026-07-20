/**
 * MÓDULO SOLICITUD DE TRASLADO
 *
 * Centraliza los pedidos de traslado de afiliados a otra dependencia, localidad o
 * departamento judicial, y detecta posibles coincidencias entre pedidos cruzados
 * (origen X → destino Y con origen Y → destino X) para facilitar la gestión gremial.
 *
 * Flujo de estados:
 *  1 Iniciada    -> el afiliado (o la departamental/admin en su nombre) carga el formulario
 *  2 Concretada  -> el traslado se concretó
 *  3 Cancelada   -> el pedido se dio de baja (por el afiliado o por el staff)
 */
const express = require("express");
const router = express.Router();
const mysqlConnection = require("../connection/connection");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------
const bucketName = process.env.BUCKET_NAME;
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.parseInt(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600", 10);

async function uploadBufferToS3({ key, buffer, contentType }) {
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: buffer, ContentType: contentType }));
}

async function getObjectBufferFromS3(key) {
  try {
    const respuesta = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const chunks = [];
    for await (const chunk of respuesta.Body) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: respuesta.ContentType || "application/octet-stream" };
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") return null;
    throw error;
  }
}

async function getSignedFileUrlFromS3(key) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: key }), {
    expiresIn: Number.isFinite(S3_SIGNED_URL_EXPIRES_SECONDS) ? S3_SIGNED_URL_EXPIRES_SECONDS : 3600,
  });
}

const EXTENSION_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.oasis.opendocument.text": "odt",
};

function extensionSegura(nombre, mime) {
  if (EXTENSION_POR_MIME[mime]) return EXTENSION_POR_MIME[mime];
  const partes = String(nombre || "").split(".");
  const ext = partes.length > 1 ? partes.pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return ext || "bin";
}

async function subirArchivoTraslado(file, prefijo) {
  const extension = extensionSegura(file.originalname, file.mimetype);
  const key = `traslados/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
  return key;
}

// ---------------------------------------------------------------------------
// Multer (memoria). fieldname = slot del adjunto: CURRICULUM o DOCUMENTACION.
// Se aceptan documentos (PDF/Word/ODT) e imágenes.
// ---------------------------------------------------------------------------
const SLOTS_VALIDOS = ["CURRICULUM", "DOCUMENTACION"];

const uploadTraslados = multer({
  storage: multer.memoryStorage(),
  limits: { files: 12, fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const esImagen = file.mimetype?.startsWith("image/");
    const esDocumento = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.text",
    ].includes(file.mimetype);
    if (!esImagen && !esDocumento) return cb(new Error("Solo se permiten documentos (PDF, Word, ODT) o imágenes"));
    return cb(null, true);
  },
});

function manejarUploadTraslados(req, res, next) {
  uploadTraslados.any()(req, res, (error) => {
    if (error) return res.status(400).json(error.message || "No se pudieron procesar los archivos");
    return next();
  });
}

function archivosPorSlot(files) {
  const slots = new Map();
  for (const file of files || []) {
    const slot = String(file.fieldname || "").toUpperCase().replace(/\[\d*\]$/, "");
    const key = SLOTS_VALIDOS.includes(slot) ? slot : "DOCUMENTACION";
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(file);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function verifyToken(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json("No autorizado");
  const token = req.headers.authorization.substr(7);
  if (token !== "") {
    jwt.verify(token, process.env.JWT_SECRET, (error, authData) => {
      if (error) {
        res.status(403).json("Error en el token");
      } else {
        req.data = authData;
        next();
      }
    });
  } else {
    res.status(401).json("Token vacio");
  }
}

function getCabecera(req) {
  return JSON.parse(req.data.data);
}

const ROLES_STAFF = ["admin", "departamental", "admin-central"];

// ---------------------------------------------------------------------------
// Catálogos fijos (espejados en FRONTEND/src/app/components/traslados/traslados-catalogos.ts)
// ---------------------------------------------------------------------------
const LUGARES_TRABAJO = ["Corte", "Ministerio Público", "Otro"];

const ACTIVIDADES_LABORALES = [
  "Servicios Generales (Ordenanzas)",
  "Obrero (Mantenimiento)",
  "Administrativo",
  "Técnico",
  "Profesional",
];

const NIVELES_ESCALAFON = [
  "Categoría sin denominación (Leyes 12.060 y 13.513)",
  "Secretario de Cámara de Apelación",
  "Consejero de Familia",
  "Abogado Inspector de la Suprema Corte de Justicia",
  "Prosecretario de la Suprema Corte de Justicia",
  "Auxiliar Letrado Relator de Tribunal de Casación Penal",
  "Secretario de Juzgado",
  "Secretario de Exhortos Penales",
  "Abogado Adscriptos de la Suprema Corte de Justicia",
  "Abogado Auxiliar de la Suprema Corte de Justicia",
  "Auxiliar Letrado de la Cámara de Apelación",
  "Inspector Juzgado Notarial",
  "Asesor Técnico",
  "Auxiliar Letrado de Primera o Única Instancia",
  "Jefe de Despacho de la Suprema Corte de Justicia",
  "Perito I",
  "Perito II",
  "Encargado del Despacho de la Casación",
  "Subjefe de Despacho de la Suprema Corte de Justicia",
  "Oficial Mayor",
  "Perito III",
  "Ujier",
  "Relator de Secretaría",
  "Oficial 1ro",
  "Perito IV y V",
  "Categoría sin denominación (art. 1° Decreto 209/11)",
  "Sub-relator de Secretaría",
  "Oficial de Servicios Generales",
  "Oficial 2do",
  "Oficial 4to",
  "Auxiliar 1ro",
  "Auxiliar 3ro",
];

const FUEROS = [
  "Familia",
  "Civil",
  "Laboral",
  "Penal",
  "Oficinas de Corte",
  "Oficinas de Procuración",
  "Juzgado de Paz",
  "Contencioso Administrativo",
];

// ---------------------------------------------------------------------------
// Estados y permisos
// ---------------------------------------------------------------------------
const ESTADO = {
  INICIADA: 1,
  CONCRETADA: 2,
  CANCELADA: 3,
};

function esDepartamentalInvolucrada(cabecera, solicitud) {
  const propia = Number(cabecera.departamental_id);
  return (
    Number(solicitud.departamental_origen_id) === propia ||
    Number(solicitud.departamental_destino_id) === propia
  );
}

function puedeVerSolicitud(cabecera, solicitud) {
  switch (cabecera.rol) {
    case "admin":
    case "admin-central":
      return true;
    case "departamental":
      return esDepartamentalInvolucrada(cabecera, solicitud);
    case "afiliado":
      return Number(solicitud.usuario_id) === Number(cabecera.id);
    default:
      return false;
  }
}

function puedeEditarSolicitud(cabecera, solicitud) {
  if (solicitud.estado_id !== ESTADO.INICIADA) return false;
  switch (cabecera.rol) {
    case "admin":
    case "admin-central":
      return true;
    case "departamental":
      return esDepartamentalInvolucrada(cabecera, solicitud);
    case "afiliado":
      return Number(solicitud.usuario_id) === Number(cabecera.id);
    default:
      return false;
  }
}

function puedeEliminarSolicitud(cabecera, solicitud) {
  switch (cabecera.rol) {
    case "admin":
    case "admin-central":
      return true;
    case "departamental":
      return esDepartamentalInvolucrada(cabecera, solicitud);
    default:
      return false;
  }
}

function transicionesDisponibles(cabecera, estadoId, esPropia) {
  switch (cabecera.rol) {
    case "afiliado":
      return esPropia && estadoId === ESTADO.INICIADA ? [ESTADO.CANCELADA] : [];
    case "departamental":
    case "admin-central":
    case "admin":
      return ({
        [ESTADO.INICIADA]: [ESTADO.CONCRETADA, ESTADO.CANCELADA],
        [ESTADO.CONCRETADA]: [ESTADO.INICIADA],
        [ESTADO.CANCELADA]: [ESTADO.INICIADA],
      })[estadoId] || [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizarTexto(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto.length > 0 ? texto : null;
}

function normalizarBooleano(valor) {
  return valor === true || valor === 1 || String(valor) === "1" || String(valor).toLowerCase() === "true" ? 1 : 0;
}

function normalizarFecha(texto) {
  const valor = normalizarTexto(texto);
  if (!valor) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseJsonSeguro(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "object") return valor;
  try {
    return JSON.parse(valor);
  } catch (e) {
    return null;
  }
}

// Normaliza una lista de fueros contra el catálogo fijo (array de strings)
function normalizarFueros(valor) {
  const lista = Array.isArray(valor) ? valor : parseJsonSeguro(valor);
  if (!Array.isArray(lista)) return null;
  const limpios = [...new Set(lista.map((f) => normalizarTexto(f)).filter(Boolean))];
  if (limpios.length === 0) return null;
  if (limpios.some((f) => !FUEROS.includes(f))) return null;
  return limpios;
}

function hayInterseccion(a, b) {
  const setB = new Set(b || []);
  return (a || []).some((x) => setB.has(x));
}

// ---------------------------------------------------------------------------
// Historial y notificaciones
// ---------------------------------------------------------------------------
async function registrarHistorial(connection, datos) {
  await connection.query(
    `INSERT INTO traslado_historial
       (solicitud_id, usuario_id, usuario_rol, tipo_operacion, estado_anterior_id, estado_nuevo_id,
        campo_modificado, valor_anterior, valor_nuevo, observacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      datos.solicitud_id,
      datos.usuario_id || null,
      datos.usuario_rol || null,
      datos.tipo_operacion,
      datos.estado_anterior_id || null,
      datos.estado_nuevo_id || null,
      datos.campo_modificado || null,
      datos.valor_anterior !== undefined && datos.valor_anterior !== null ? String(datos.valor_anterior) : null,
      datos.valor_nuevo !== undefined && datos.valor_nuevo !== null ? String(datos.valor_nuevo) : null,
      datos.observacion || null,
    ]
  );
}

async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, tipo, titulo, mensaje, JSON.stringify(payload || {})]
  );
}

async function notificarUsuariosDepartamental(connection, departamentalId, tipo, titulo, mensaje, payload, excluirUsuarioId) {
  if (!departamentalId) return;
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE r.nombre = 'departamental' AND u.departamental_id = ? AND u.habilitado = 'Y'`,
    [departamentalId]
  );
  for (const u of usuarios) {
    if (excluirUsuarioId && Number(u.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
  }
}

// Avisa a todos los perfiles involucrados en la solicitud (afiliado + departamental
// origen + departamental destino), salvo al autor de la acción.
async function notificarInvolucrados(connection, solicitud, autor, tipo, tituloStaff, tituloAfiliado, mensaje) {
  const payload = { solicitud_id: solicitud.id, estado_id: solicitud.estado_id };
  if (Number(solicitud.usuario_id) !== Number(autor.id)) {
    await insertarNotificacion(connection, solicitud.usuario_id, tipo, tituloAfiliado, mensaje, payload);
  }
  const departamentales = [...new Set([solicitud.departamental_origen_id, solicitud.departamental_destino_id].filter(Boolean))];
  for (const depId of departamentales) {
    if (autor.rol === "departamental" && Number(autor.departamental_id) === Number(depId)) continue;
    await notificarUsuariosDepartamental(connection, depId, tipo, tituloStaff, mensaje, payload, autor.id);
  }
}

// ---------------------------------------------------------------------------
// Coincidencias: pedidos cruzados (origen X → destino Y contra origen Y → destino X).
// Si alguna de las dos solicitudes marcó "fueros excluyentes", además tiene que haber
// intersección entre los fueros de destino de una y los de origen de la otra.
// ---------------------------------------------------------------------------
function sonCoincidentes(a, b) {
  if (Number(a.departamental_origen_id) !== Number(b.departamental_destino_id)) return false;
  if (Number(a.departamental_destino_id) !== Number(b.departamental_origen_id)) return false;
  if (Number(a.usuario_id) === Number(b.usuario_id)) return false;
  const fuerosA = { origen: parseJsonSeguro(a.fueros_origen) || [], destino: parseJsonSeguro(a.fueros_destino) || [] };
  const fuerosB = { origen: parseJsonSeguro(b.fueros_origen) || [], destino: parseJsonSeguro(b.fueros_destino) || [] };
  if (normalizarBooleano(a.fueros_excluyentes) && !hayInterseccion(fuerosB.destino, fuerosA.origen)) return false;
  if (normalizarBooleano(b.fueros_excluyentes) && !hayInterseccion(fuerosA.destino, fuerosB.origen)) return false;
  return true;
}

// Todas las solicitudes activas con lo mínimo para evaluar coincidencias
async function obtenerSolicitudesActivas(db) {
  const [rows] = await db.query(
    `SELECT s.id, s.usuario_id, s.departamental_origen_id, s.departamental_destino_id,
            CAST(s.fueros_origen AS CHAR) AS fueros_origen, CAST(s.fueros_destino AS CHAR) AS fueros_destino,
            s.fueros_excluyentes
     FROM traslado_solicitud s
     WHERE s.eliminado = 0 AND s.estado_id = ${ESTADO.INICIADA}`
  );
  return rows;
}

// ---------------------------------------------------------------------------
// GET /traslados/catalogos — listas fijas + estados + departamentales con localidades
// ---------------------------------------------------------------------------
router.get("/traslados/catalogos", verifyToken, async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [estados] = await db.query("SELECT id, nombre, color, color_texto, orden FROM traslado_estado ORDER BY orden");
    const [departamentales] = await db.query(
      "SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre"
    );
    const [localidades] = await db.query(
      "SELECT id, departamental_id, nombre FROM departamental_localidad WHERE habilitado = 'Y' ORDER BY nombre"
    );
    res.status(200).json({
      lugares_trabajo: LUGARES_TRABAJO,
      actividades_laborales: ACTIVIDADES_LABORALES,
      niveles_escalafon: NIVELES_ESCALAFON,
      fueros: FUEROS,
      estados,
      departamentales: departamentales.map((d) => ({
        ...d,
        localidades: localidades.filter((l) => l.departamental_id === d.id),
      })),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los catálogos de traslados");
  }
});

// ---------------------------------------------------------------------------
// Localidades por departamental (el admin gestiona todas; el rol departamental,
// solo las de su propia departamental)
// ---------------------------------------------------------------------------
function puedeGestionarLocalidades(cabecera, departamentalId) {
  if (["admin", "admin-central"].includes(cabecera.rol)) return true;
  if (cabecera.rol === "departamental") return Number(cabecera.departamental_id) === Number(departamentalId);
  return false;
}

// Vista de gestión (incluye deshabilitadas y conteo de solicitudes asociadas):
// solo staff. El formulario del afiliado usa las localidades de /traslados/catalogos.
router.get("/traslados/departamentales/:id/localidades", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const departamentalId = Number(req.params.id);
    if (!departamentalId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT l.id, l.departamental_id, l.nombre, l.habilitado, l.fecha_creacion,
              (SELECT COUNT(*) FROM traslado_solicitud_localidad sl
               INNER JOIN traslado_solicitud s ON s.id = sl.solicitud_id AND s.eliminado = 0
               WHERE sl.localidad_id = l.id) AS solicitudes_asociadas
       FROM departamental_localidad l
       WHERE l.departamental_id = ?
       ORDER BY l.habilitado DESC, l.nombre`,
      [departamentalId]
    );
    res.status(200).json(rows);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las localidades");
  }
});

router.post("/traslados/departamentales/:id/localidades", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const departamentalId = Number(req.params.id);
    const nombre = normalizarTexto(req.body.nombre);
    if (!departamentalId || !nombre) return res.status(400).json("El nombre de la localidad es obligatorio");
    if (nombre.length > 120) return res.status(400).json("El nombre es demasiado largo (máximo 120 caracteres)");
    if (!puedeGestionarLocalidades(cabecera, departamentalId)) return res.status(401).json("No autorizado");

    const db = mysqlConnection.promise();
    const [existentes] = await db.query(
      "SELECT id, habilitado FROM departamental_localidad WHERE departamental_id = ? AND nombre = ?",
      [departamentalId, nombre]
    );
    if (existentes.length > 0) {
      if (existentes[0].habilitado === "Y") return res.status(409).json("Esa localidad ya existe en la departamental");
      await db.query("UPDATE departamental_localidad SET habilitado = 'Y' WHERE id = ?", [existentes[0].id]);
      return res.status(200).json({ success: true, id: existentes[0].id, message: "Localidad rehabilitada" });
    }
    const [resultado] = await db.query(
      "INSERT INTO departamental_localidad (departamental_id, nombre) VALUES (?, ?)",
      [departamentalId, nombre]
    );
    res.status(201).json({ success: true, id: resultado.insertId, message: "Localidad agregada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al agregar la localidad");
  }
});

router.put("/traslados/localidades/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const localidadId = Number(req.params.id);
    const nombre = normalizarTexto(req.body.nombre);
    if (!localidadId || !nombre) return res.status(400).json("El nombre de la localidad es obligatorio");
    if (nombre.length > 120) return res.status(400).json("El nombre es demasiado largo (máximo 120 caracteres)");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM departamental_localidad WHERE id = ?", [localidadId]);
    if (rows.length === 0) return res.status(404).json("Localidad no encontrada");
    if (!puedeGestionarLocalidades(cabecera, rows[0].departamental_id)) return res.status(401).json("No autorizado");

    const [duplicadas] = await db.query(
      "SELECT id FROM departamental_localidad WHERE departamental_id = ? AND nombre = ? AND id <> ?",
      [rows[0].departamental_id, nombre, localidadId]
    );
    if (duplicadas.length > 0) return res.status(409).json("Ya existe otra localidad con ese nombre en la departamental");

    await db.query("UPDATE departamental_localidad SET nombre = ? WHERE id = ?", [nombre, localidadId]);
    res.status(200).json({ success: true, message: "Localidad actualizada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al actualizar la localidad");
  }
});

// Elimina si no está referenciada por ninguna solicitud; si lo está, la deshabilita
router.delete("/traslados/localidades/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const localidadId = Number(req.params.id);
    if (!localidadId) return res.status(400).json("ID inválido");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM departamental_localidad WHERE id = ?", [localidadId]);
    if (rows.length === 0) return res.status(404).json("Localidad no encontrada");
    if (!puedeGestionarLocalidades(cabecera, rows[0].departamental_id)) return res.status(401).json("No autorizado");

    const [usos] = await db.query(
      "SELECT COUNT(*) AS total FROM traslado_solicitud_localidad WHERE localidad_id = ?",
      [localidadId]
    );
    if (Number(usos[0].total) > 0) {
      await db.query("UPDATE departamental_localidad SET habilitado = 'N' WHERE id = ?", [localidadId]);
      return res.status(200).json({
        success: true,
        deshabilitada: true,
        message: "La localidad está usada por solicitudes existentes: se deshabilitó para nuevas solicitudes",
      });
    }
    await db.query("DELETE FROM departamental_localidad WHERE id = ?", [localidadId]);
    res.status(200).json({ success: true, deshabilitada: false, message: "Localidad eliminada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al eliminar la localidad");
  }
});

// ---------------------------------------------------------------------------
// GET /traslados/afiliados-buscar — búsqueda de afiliados (staff, para asignar solicitud)
// ---------------------------------------------------------------------------
router.get("/traslados/afiliados-buscar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_STAFF.includes(cabecera.rol)) return res.status(401).json("No autorizado");

    const q = normalizarTexto(req.query.q);
    if (!q || q.length < 2) return res.status(200).json([]);

    const condiciones = [
      "r.nombre = 'afiliado'",
      "u.habilitado = 'Y'",
      "u.usuario_familiar_id IS NULL",
      "(u.es_familiar IS NULL OR u.es_familiar <> 'S')",
    ];
    const params = [];
    if (cabecera.rol === "departamental") {
      condiciones.push("u.departamental_id = ?");
      params.push(cabecera.departamental_id);
    }
    condiciones.push("(u.nombre LIKE ? OR u.apellido LIKE ? OR CAST(u.documento AS CHAR) LIKE ? OR CONCAT(u.apellido, ' ', u.nombre) LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);

    const [rows] = await mysqlConnection.promise().query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.departamental_id, d.nombre AS departamental_nombre
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
       LEFT JOIN departamental d ON d.id = u.departamental_id
       WHERE ${condiciones.join(" AND ")}
       ORDER BY u.apellido, u.nombre
       LIMIT 15`,
      params
    );
    res.status(200).json(rows);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al buscar afiliados");
  }
});

// ---------------------------------------------------------------------------
// Validación del formulario de solicitud
// ---------------------------------------------------------------------------
async function validarDatosSolicitud(db, body, usuarioId) {
  const errores = [];
  const datos = {};

  datos.lugar_trabajo = normalizarTexto(body.lugar_trabajo);
  if (!datos.lugar_trabajo || !LUGARES_TRABAJO.includes(datos.lugar_trabajo)) {
    errores.push("Elegí un lugar de trabajo válido");
  }

  datos.actividad_laboral = normalizarTexto(body.actividad_laboral);
  if (!datos.actividad_laboral || !ACTIVIDADES_LABORALES.includes(datos.actividad_laboral)) {
    errores.push("Elegí una actividad laboral válida");
  }

  datos.nivel_escalafon = normalizarTexto(body.nivel_escalafon);
  if (!datos.nivel_escalafon || !NIVELES_ESCALAFON.includes(datos.nivel_escalafon)) {
    errores.push("Elegí un nivel del escalafón salarial válido");
  }

  datos.fueros_origen = normalizarFueros(body.fueros_origen);
  if (!datos.fueros_origen) errores.push("Elegí al menos un fuero de origen");

  datos.fueros_destino = normalizarFueros(body.fueros_destino);
  if (!datos.fueros_destino) errores.push("Elegí al menos un fuero de destino");

  datos.disponibilidad_cargo = normalizarBooleano(body.disponibilidad_cargo);
  datos.fueros_excluyentes = normalizarBooleano(body.fueros_excluyentes);
  datos.observaciones = normalizarTexto(body.observaciones);

  datos.departamental_destino_id = Number(body.departamental_destino_id) || null;
  if (!datos.departamental_destino_id) {
    errores.push("Elegí la departamental de destino");
  } else {
    const [deps] = await db.query("SELECT id FROM departamental WHERE id = ? AND habilitado = 'Y'", [datos.departamental_destino_id]);
    if (deps.length === 0) errores.push("La departamental de destino no existe");
  }

  // Localidades: opcionales, pero si vienen deben pertenecer a la departamental
  // destino y estar habilitadas (el DELETE las deshabilita para nuevas solicitudes)
  const localidadesIds = (parseJsonSeguro(body.localidades) || [])
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
  datos.localidades = [...new Set(localidadesIds)];
  if (datos.localidades.length > 0 && datos.departamental_destino_id) {
    const [localidades] = await db.query(
      `SELECT id FROM departamental_localidad
       WHERE departamental_id = ? AND habilitado = 'Y' AND id IN (${datos.localidades.map(() => "?").join(",")})`,
      [datos.departamental_destino_id, ...datos.localidades]
    );
    if (localidades.length !== datos.localidades.length) {
      errores.push("Alguna de las localidades elegidas no pertenece a la departamental de destino o ya no está disponible");
    }
  }

  return { errores, datos };
}

// ---------------------------------------------------------------------------
// POST /traslados/solicitudes — crear solicitud
// El afiliado la carga para sí mismo; admin/departamental la asignan a un afiliado.
// ---------------------------------------------------------------------------
router.post("/traslados/solicitudes", verifyToken, manejarUploadTraslados, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!["afiliado", ...ROLES_STAFF].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const usuarioId = cabecera.rol === "afiliado" ? Number(cabecera.id) : Number(req.body.usuario_id);
    if (!usuarioId) return res.status(400).json("Indicá el afiliado para el que se carga la solicitud");

    const [titulares] = await db.query(
      `SELECT u.id, u.departamental_id, u.nombre, u.apellido, r.nombre AS rol
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
       WHERE u.id = ? AND u.habilitado = 'Y' AND (u.es_familiar IS NULL OR u.es_familiar <> 'S')`,
      [usuarioId]
    );
    if (titulares.length === 0) return res.status(404).json("Afiliado no encontrado");
    const titular = titulares[0];
    if (titular.rol !== "afiliado") return res.status(400).json("La solicitud de traslado solo puede cargarse para usuarios con rol afiliado");
    if (!titular.departamental_id) return res.status(400).json("El afiliado no tiene departamental asignada");
    if (cabecera.rol === "departamental" && Number(titular.departamental_id) !== Number(cabecera.departamental_id)) {
      return res.status(401).json("El afiliado pertenece a otra departamental");
    }

    // Un afiliado no puede tener dos pedidos activos a la vez
    const [activas] = await db.query(
      "SELECT id FROM traslado_solicitud WHERE usuario_id = ? AND eliminado = 0 AND estado_id = ?",
      [usuarioId, ESTADO.INICIADA]
    );
    if (activas.length > 0) {
      return res.status(409).json(`El afiliado ya tiene una solicitud de traslado en curso (#${activas[0].id}). Cancelala o concretala antes de iniciar otra.`);
    }

    const { errores, datos } = await validarDatosSolicitud(db, req.body, usuarioId);
    if (datos.departamental_destino_id && Number(datos.departamental_destino_id) === Number(titular.departamental_id)) {
      errores.push("La departamental de destino tiene que ser distinta a la de origen");
    }
    if (errores.length > 0) return res.status(400).json(errores.join(" | "));

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [resultado] = await connection.query(
      `INSERT INTO traslado_solicitud
        (usuario_id, creado_por_usuario_id, departamental_origen_id, departamental_destino_id, estado_id,
         lugar_trabajo, actividad_laboral, nivel_escalafon, fueros_origen, fueros_destino,
         disponibilidad_cargo, fueros_excluyentes, observaciones)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usuarioId, cabecera.id, titular.departamental_id, datos.departamental_destino_id, ESTADO.INICIADA,
        datos.lugar_trabajo, datos.actividad_laboral, datos.nivel_escalafon,
        JSON.stringify(datos.fueros_origen), JSON.stringify(datos.fueros_destino),
        datos.disponibilidad_cargo, datos.fueros_excluyentes, datos.observaciones,
      ]
    );
    const solicitudId = resultado.insertId;

    for (const localidadId of datos.localidades) {
      await connection.query(
        "INSERT INTO traslado_solicitud_localidad (solicitud_id, localidad_id) VALUES (?, ?)",
        [solicitudId, localidadId]
      );
    }

    const slots = archivosPorSlot(req.files);
    for (const [slot, files] of slots.entries()) {
      for (const file of files) {
        const key = await subirArchivoTraslado(file, `sol${solicitudId}_${slot.toLowerCase()}`);
        await connection.query(
          `INSERT INTO traslado_archivo (solicitud_id, tipo_adjunto, archivo, nombre_original, mime, tamanio)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [solicitudId, slot, key, file.originalname || null, file.mimetype || null, file.size || null]
        );
      }
    }

    await registrarHistorial(connection, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      estado_nuevo_id: ESTADO.INICIADA,
      observacion: cabecera.rol === "afiliado"
        ? "Solicitud de traslado cargada por el afiliado"
        : `Solicitud de traslado cargada por ${cabecera.rol} en nombre del afiliado`,
    });

    const solicitudNueva = {
      id: solicitudId,
      usuario_id: usuarioId,
      estado_id: ESTADO.INICIADA,
      departamental_origen_id: titular.departamental_id,
      departamental_destino_id: datos.departamental_destino_id,
    };
    await notificarInvolucrados(
      connection, solicitudNueva, cabecera, "TRASLADO_NUEVA",
      `Nueva solicitud de traslado #${solicitudId}`,
      `Tu solicitud de traslado #${solicitudId} fue registrada`,
      `${titular.apellido}, ${titular.nombre} solicita traslado de departamental. Revisá los datos y las posibles coincidencias.`
    );

    await connection.commit();
    res.status(201).json({ success: true, id: solicitudId, message: "Solicitud de traslado enviada correctamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    // Índice único uq_tra_sol_activa: doble submit concurrente de la misma solicitud
    if (error && error.code === "ER_DUP_ENTRY") {
      return res.status(409).json("El afiliado ya tiene una solicitud de traslado en curso. Cancelala o concretala antes de iniciar otra.");
    }
    console.log(error);
    res.status(500).json("Error al crear la solicitud de traslado");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /traslados/solicitudes — tabla con filtros, paginado y orden
// ---------------------------------------------------------------------------
const COLUMNAS_ORDEN = {
  id: "s.id",
  fecha_creacion: "s.fecha_creacion",
  afiliado: "u.apellido",
  departamental_origen: "dor.nombre",
  departamental_destino: "des.nombre",
  estado: "e.orden",
};

router.get("/traslados/solicitudes", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const orderBy = COLUMNAS_ORDEN[req.query.orderBy] || "s.id";
    const orderType = String(req.query.orderType).toUpperCase() === "ASC" ? "ASC" : "DESC";

    const condiciones = ["s.eliminado = 0"];
    const params = [];

    switch (cabecera.rol) {
      case "afiliado":
        condiciones.push("s.usuario_id = ?");
        params.push(Number(cabecera.id));
        break;
      case "departamental":
        condiciones.push("(s.departamental_origen_id = ? OR s.departamental_destino_id = ?)");
        params.push(Number(cabecera.departamental_id), Number(cabecera.departamental_id));
        break;
      case "admin":
      case "admin-central":
        break;
      default:
        return res.status(401).json("No autorizado");
    }

    if (req.query.estado_id) {
      const estados = String(req.query.estado_id).split(",").map((v) => Number(v)).filter((v) => v > 0);
      if (estados.length > 0) {
        condiciones.push(`s.estado_id IN (${estados.map(() => "?").join(",")})`);
        params.push(...estados);
      }
    }
    if (req.query.departamental_origen_id) {
      condiciones.push("s.departamental_origen_id = ?");
      params.push(Number(req.query.departamental_origen_id));
    }
    if (req.query.departamental_destino_id) {
      condiciones.push("s.departamental_destino_id = ?");
      params.push(Number(req.query.departamental_destino_id));
    }
    if (req.query.disponibilidad_cargo === "0" || req.query.disponibilidad_cargo === "1") {
      condiciones.push("s.disponibilidad_cargo = ?");
      params.push(Number(req.query.disponibilidad_cargo));
    }
    if (req.query.fueros_excluyentes === "0" || req.query.fueros_excluyentes === "1") {
      condiciones.push("s.fueros_excluyentes = ?");
      params.push(Number(req.query.fueros_excluyentes));
    }
    const fuero = normalizarTexto(req.query.fuero);
    if (fuero && FUEROS.includes(fuero)) {
      condiciones.push("(JSON_CONTAINS(s.fueros_origen, JSON_QUOTE(?)) OR JSON_CONTAINS(s.fueros_destino, JSON_QUOTE(?)))");
      params.push(fuero, fuero);
    }
    const fechaDesde = normalizarFecha(req.query.fecha_desde);
    if (fechaDesde) {
      condiciones.push("DATE(s.fecha_creacion) >= ?");
      params.push(fechaDesde);
    }
    const fechaHasta = normalizarFecha(req.query.fecha_hasta);
    if (fechaHasta) {
      condiciones.push("DATE(s.fecha_creacion) <= ?");
      params.push(fechaHasta);
    }
    const search = normalizarTexto(req.query.search);
    if (search) {
      condiciones.push(`(CAST(s.id AS CHAR) LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ?
        OR CAST(u.documento AS CHAR) LIKE ? OR CONCAT(u.apellido, ', ', u.nombre) LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    const where = condiciones.join(" AND ");
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM traslado_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN departamental dor ON dor.id = s.departamental_origen_id
       INNER JOIN departamental des ON des.id = s.departamental_destino_id
       INNER JOIN traslado_estado e ON e.id = s.estado_id
       WHERE ${where}`,
      params
    );
    const totalItems = Number(countRows[0].total);

    const [rows] = await db.query(
      `SELECT s.id, s.usuario_id, s.departamental_origen_id, s.departamental_destino_id, s.estado_id,
              s.lugar_trabajo, s.actividad_laboral, s.nivel_escalafon,
              CAST(s.fueros_origen AS CHAR) AS fueros_origen, CAST(s.fueros_destino AS CHAR) AS fueros_destino,
              s.disponibilidad_cargo, s.fueros_excluyentes, s.observaciones,
              s.fecha_creacion, s.fecha_modificacion, s.fecha_concretada, s.fecha_cancelada,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
              dor.nombre AS departamental_origen, des.nombre AS departamental_destino,
              e.nombre AS estado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              (SELECT COUNT(*) FROM traslado_observacion o WHERE o.solicitud_id = s.id) AS mensajes,
              (SELECT GROUP_CONCAT(l.nombre ORDER BY l.nombre SEPARATOR ', ')
               FROM traslado_solicitud_localidad sl
               INNER JOIN departamental_localidad l ON l.id = sl.localidad_id
               WHERE sl.solicitud_id = s.id) AS localidades
       FROM traslado_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN departamental dor ON dor.id = s.departamental_origen_id
       INNER JOIN departamental des ON des.id = s.departamental_destino_id
       INNER JOIN traslado_estado e ON e.id = s.estado_id
       WHERE ${where}
       ORDER BY ${orderBy} ${orderType}, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    // Coincidencias de la página contra todas las solicitudes activas
    const activas = await obtenerSolicitudesActivas(db);
    const results = rows.map((row) => {
      const coincidencias = Number(row.estado_id) === ESTADO.INICIADA
        ? activas.filter((otra) => sonCoincidentes(row, otra)).length
        : 0;
      return {
        ...row,
        fueros_origen: parseJsonSeguro(row.fueros_origen) || [],
        fueros_destino: parseJsonSeguro(row.fueros_destino) || [],
        coincidencias,
        puede_editar: puedeEditarSolicitud(cabecera, row),
        puede_eliminar: puedeEliminarSolicitud(cabecera, row),
        transiciones: transicionesDisponibles(cabecera, row.estado_id, Number(row.usuario_id) === Number(cabecera.id)),
      };
    });

    // Resumen por estado con el mismo scope pero sin el filtro de estado
    const condicionesResumen = condiciones.filter((c) => !c.startsWith("s.estado_id IN"));
    const paramsResumen = [];
    let estadoParamOffset = 0;
    condiciones.forEach((c, i) => {
      const cantidad = (c.match(/\?/g) || []).length;
      if (!c.startsWith("s.estado_id IN")) paramsResumen.push(...params.slice(estadoParamOffset, estadoParamOffset + cantidad));
      estadoParamOffset += cantidad;
    });
    const [resumen] = await db.query(
      `SELECT s.estado_id, COUNT(*) AS total
       FROM traslado_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       WHERE ${condicionesResumen.join(" AND ")}
       GROUP BY s.estado_id`,
      paramsResumen
    );

    res.status(200).json({ results, totalItems, page, pageSize, resumen });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las solicitudes de traslado");
  }
});

// ---------------------------------------------------------------------------
// GET /traslados/solicitudes/:id — detalle completo
// ---------------------------------------------------------------------------
router.get("/traslados/solicitudes/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `SELECT s.*, CAST(s.fueros_origen AS CHAR) AS fueros_origen_str, CAST(s.fueros_destino AS CHAR) AS fueros_destino_str,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
              u.email AS afiliado_email, u.telefono AS afiliado_telefono, u.legajo AS afiliado_legajo,
              dor.nombre AS departamental_origen, des.nombre AS departamental_destino,
              e.nombre AS estado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              creador.nombre AS creador_nombre, creador.apellido AS creador_apellido
       FROM traslado_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN departamental dor ON dor.id = s.departamental_origen_id
       INNER JOIN departamental des ON des.id = s.departamental_destino_id
       INNER JOIN traslado_estado e ON e.id = s.estado_id
       LEFT JOIN usuario creador ON creador.id = s.creado_por_usuario_id
       WHERE s.id = ? AND s.eliminado = 0`,
      [solicitudId]
    );
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeVerSolicitud(cabecera, solicitud)) return res.status(401).json("No autorizado");

    const [localidades] = await db.query(
      `SELECT l.id, l.nombre FROM traslado_solicitud_localidad sl
       INNER JOIN departamental_localidad l ON l.id = sl.localidad_id
       WHERE sl.solicitud_id = ? ORDER BY l.nombre`,
      [solicitudId]
    );

    const [archivos] = await db.query(
      "SELECT id, tipo_adjunto, archivo, nombre_original, mime, tamanio, fecha_creacion FROM traslado_archivo WHERE solicitud_id = ? ORDER BY id",
      [solicitudId]
    );
    const archivosFirmados = await Promise.all(
      archivos.map(async (a) => ({
        ...a,
        url: await getSignedFileUrlFromS3(a.archivo).catch(() => null),
      }))
    );

    const [observaciones] = await db.query(
      `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje, o.estado_id, o.fecha_creacion,
              u.nombre AS usuario_nombre, u.apellido AS usuario_apellido, e.nombre AS estado_nombre
       FROM traslado_observacion o
       LEFT JOIN usuario u ON u.id = o.usuario_id
       LEFT JOIN traslado_estado e ON e.id = o.estado_id
       WHERE o.solicitud_id = ?
       ORDER BY o.fecha_creacion ASC, o.id ASC`,
      [solicitudId]
    );

    let historial = [];
    if (ROLES_STAFF.includes(cabecera.rol)) {
      const [hist] = await db.query(
        `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
                ea.nombre AS estado_anterior, en.nombre AS estado_nuevo
         FROM traslado_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
         LEFT JOIN traslado_estado ea ON ea.id = h.estado_anterior_id
         LEFT JOIN traslado_estado en ON en.id = h.estado_nuevo_id
         WHERE h.solicitud_id = ?
         ORDER BY h.fecha DESC, h.id DESC`,
        [solicitudId]
      );
      historial = hist;
    }

    // Coincidencias: cruces activos contra esta solicitud
    let coincidencias = [];
    if (Number(solicitud.estado_id) === ESTADO.INICIADA) {
      const activas = await obtenerSolicitudesActivas(db);
      const propia = {
        ...solicitud,
        fueros_origen: solicitud.fueros_origen_str,
        fueros_destino: solicitud.fueros_destino_str,
      };
      const idsCoincidentes = activas.filter((otra) => Number(otra.id) !== solicitudId && sonCoincidentes(propia, otra)).map((o) => o.id);
      if (idsCoincidentes.length > 0) {
        const [filas] = await db.query(
          `SELECT s.id, s.usuario_id, s.fecha_creacion, s.disponibilidad_cargo, s.fueros_excluyentes,
                  CAST(s.fueros_origen AS CHAR) AS fueros_origen, CAST(s.fueros_destino AS CHAR) AS fueros_destino,
                  u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido,
                  dor.nombre AS departamental_origen, des.nombre AS departamental_destino
           FROM traslado_solicitud s
           INNER JOIN usuario u ON u.id = s.usuario_id
           INNER JOIN departamental dor ON dor.id = s.departamental_origen_id
           INNER JOIN departamental des ON des.id = s.departamental_destino_id
           WHERE s.id IN (${idsCoincidentes.map(() => "?").join(",")})
           ORDER BY s.fecha_creacion ASC`,
          idsCoincidentes
        );
        // El afiliado ve que existe el cruce pero no los datos personales del otro compañero
        coincidencias = filas.map((f) => ({
          id: f.id,
          fecha_creacion: f.fecha_creacion,
          disponibilidad_cargo: f.disponibilidad_cargo,
          fueros_excluyentes: f.fueros_excluyentes,
          fueros_origen: parseJsonSeguro(f.fueros_origen) || [],
          fueros_destino: parseJsonSeguro(f.fueros_destino) || [],
          departamental_origen: f.departamental_origen,
          departamental_destino: f.departamental_destino,
          afiliado: ROLES_STAFF.includes(cabecera.rol) ? `${f.afiliado_apellido}, ${f.afiliado_nombre}` : null,
        }));
      }
    }

    res.status(200).json({
      ...solicitud,
      fueros_origen: parseJsonSeguro(solicitud.fueros_origen_str) || [],
      fueros_destino: parseJsonSeguro(solicitud.fueros_destino_str) || [],
      fueros_origen_str: undefined,
      fueros_destino_str: undefined,
      localidades,
      archivos: archivosFirmados,
      observaciones_hilo: observaciones,
      historial,
      coincidencias,
      puede_editar: puedeEditarSolicitud(cabecera, solicitud),
      puede_eliminar: puedeEliminarSolicitud(cabecera, solicitud),
      transiciones: transicionesDisponibles(cabecera, solicitud.estado_id, Number(solicitud.usuario_id) === Number(cabecera.id)),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener el detalle de la solicitud de traslado");
  }
});

// ---------------------------------------------------------------------------
// PUT /traslados/solicitudes/:id — editar solicitud (estado Iniciada)
// Acepta multipart: nuevos archivos por slot + body.archivos_eliminar (JSON de IDs)
// ---------------------------------------------------------------------------
const ETIQUETAS_CAMPOS = {
  lugar_trabajo: "Lugar de trabajo",
  actividad_laboral: "Actividad laboral",
  nivel_escalafon: "Nivel escalafón salarial",
  fueros_origen: "Fueros de origen",
  fueros_destino: "Fueros de destino",
  disponibilidad_cargo: "Disponibilidad de cargo",
  fueros_excluyentes: "Fueros excluyentes",
  observaciones: "Observaciones",
  departamental_destino_id: "Departamental destino",
  localidades: "Localidades",
};

router.put("/traslados/solicitudes/:id", verifyToken, manejarUploadTraslados, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query("SELECT * FROM traslado_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeEditarSolicitud(cabecera, solicitud)) {
      return res.status(401).json("La solicitud no se puede editar en su estado actual");
    }

    const { errores, datos } = await validarDatosSolicitud(db, req.body, solicitud.usuario_id);
    if (datos.departamental_destino_id && Number(datos.departamental_destino_id) === Number(solicitud.departamental_origen_id)) {
      errores.push("La departamental de destino tiene que ser distinta a la de origen");
    }
    if (errores.length > 0) return res.status(400).json(errores.join(" | "));

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Historial por campo modificado
    const camposSimples = ["lugar_trabajo", "actividad_laboral", "nivel_escalafon", "observaciones", "departamental_destino_id"];
    const camposBooleanos = ["disponibilidad_cargo", "fueros_excluyentes"];
    const camposJson = ["fueros_origen", "fueros_destino"];
    const cambios = [];
    for (const campo of camposSimples) {
      const anterior = solicitud[campo] === null || solicitud[campo] === undefined ? null : String(solicitud[campo]);
      const nuevo = datos[campo] === null || datos[campo] === undefined ? null : String(datos[campo]);
      if (anterior !== nuevo) cambios.push({ campo, anterior, nuevo });
    }
    for (const campo of camposBooleanos) {
      const anterior = normalizarBooleano(solicitud[campo]);
      if (anterior !== datos[campo]) {
        cambios.push({ campo, anterior: anterior ? "Sí" : "No", nuevo: datos[campo] ? "Sí" : "No" });
      }
    }
    for (const campo of camposJson) {
      const anterior = (parseJsonSeguro(solicitud[campo]) || []).slice().sort().join(", ");
      const nuevo = datos[campo].slice().sort().join(", ");
      if (anterior !== nuevo) cambios.push({ campo, anterior, nuevo });
    }

    const [localidadesActuales] = await connection.query(
      `SELECT l.id, l.nombre FROM traslado_solicitud_localidad sl
       INNER JOIN departamental_localidad l ON l.id = sl.localidad_id WHERE sl.solicitud_id = ?`,
      [solicitudId]
    );
    const idsActuales = localidadesActuales.map((l) => l.id).sort((a, b) => a - b);
    const idsNuevos = datos.localidades.slice().sort((a, b) => a - b);
    if (JSON.stringify(idsActuales) !== JSON.stringify(idsNuevos)) {
      let nombresNuevos = [];
      if (idsNuevos.length > 0) {
        const [filas] = await connection.query(
          `SELECT nombre FROM departamental_localidad WHERE id IN (${idsNuevos.map(() => "?").join(",")}) ORDER BY nombre`,
          idsNuevos
        );
        nombresNuevos = filas.map((f) => f.nombre);
      }
      cambios.push({
        campo: "localidades",
        anterior: localidadesActuales.map((l) => l.nombre).sort().join(", ") || "—",
        nuevo: nombresNuevos.join(", ") || "—",
      });
    }

    await connection.query(
      `UPDATE traslado_solicitud
       SET lugar_trabajo = ?, actividad_laboral = ?, nivel_escalafon = ?, fueros_origen = ?, fueros_destino = ?,
           disponibilidad_cargo = ?, fueros_excluyentes = ?, observaciones = ?, departamental_destino_id = ?
       WHERE id = ?`,
      [
        datos.lugar_trabajo, datos.actividad_laboral, datos.nivel_escalafon,
        JSON.stringify(datos.fueros_origen), JSON.stringify(datos.fueros_destino),
        datos.disponibilidad_cargo, datos.fueros_excluyentes, datos.observaciones,
        datos.departamental_destino_id, solicitudId,
      ]
    );
    await connection.query("DELETE FROM traslado_solicitud_localidad WHERE solicitud_id = ?", [solicitudId]);
    for (const localidadId of datos.localidades) {
      await connection.query(
        "INSERT INTO traslado_solicitud_localidad (solicitud_id, localidad_id) VALUES (?, ?)",
        [solicitudId, localidadId]
      );
    }

    // Archivos a eliminar
    const archivosEliminar = (parseJsonSeguro(req.body.archivos_eliminar) || []).map((v) => Number(v)).filter(Boolean);
    if (archivosEliminar.length > 0) {
      const [archivos] = await connection.query(
        `SELECT id, nombre_original, tipo_adjunto FROM traslado_archivo
         WHERE solicitud_id = ? AND id IN (${archivosEliminar.map(() => "?").join(",")})`,
        [solicitudId, ...archivosEliminar]
      );
      for (const archivo of archivos) {
        await connection.query("DELETE FROM traslado_archivo WHERE id = ?", [archivo.id]);
        await registrarHistorial(connection, {
          solicitud_id: solicitudId,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "ARCHIVO",
          observacion: `Se quitó el archivo "${archivo.nombre_original || archivo.tipo_adjunto}"`,
        });
      }
    }

    // Archivos nuevos
    const slots = archivosPorSlot(req.files);
    for (const [slot, files] of slots.entries()) {
      for (const file of files) {
        const key = await subirArchivoTraslado(file, `sol${solicitudId}_${slot.toLowerCase()}`);
        await connection.query(
          `INSERT INTO traslado_archivo (solicitud_id, tipo_adjunto, archivo, nombre_original, mime, tamanio)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [solicitudId, slot, key, file.originalname || null, file.mimetype || null, file.size || null]
        );
        await registrarHistorial(connection, {
          solicitud_id: solicitudId,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "ARCHIVO",
          observacion: `Se adjuntó "${file.originalname || slot}"`,
        });
      }
    }

    for (const cambio of cambios) {
      await registrarHistorial(connection, {
        solicitud_id: solicitudId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE",
        campo_modificado: ETIQUETAS_CAMPOS[cambio.campo] || cambio.campo,
        valor_anterior: cambio.anterior,
        valor_nuevo: cambio.nuevo,
      });
    }

    if (cambios.length > 0 || archivosEliminar.length > 0 || (req.files || []).length > 0) {
      // Con el destino ya actualizado: si cambió la departamental de destino,
      // el aviso tiene que llegar a la nueva (la anterior deja de estar involucrada)
      await notificarInvolucrados(
        connection, { ...solicitud, departamental_destino_id: datos.departamental_destino_id }, cabecera, "TRASLADO_ACTUALIZADA",
        `Solicitud de traslado #${solicitudId} actualizada`,
        `Tu solicitud de traslado #${solicitudId} fue actualizada`,
        cabecera.rol === "afiliado"
          ? "El afiliado actualizó los datos de su solicitud de traslado."
          : "Se actualizaron datos de la solicitud de traslado."
      );
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Solicitud actualizada correctamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al actualizar la solicitud de traslado");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /traslados/solicitudes/:id/estado — cambio de estado
// ---------------------------------------------------------------------------
router.put("/traslados/solicitudes/:id/estado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    const estadoNuevo = Number(req.body.estado_id);
    const observacion = normalizarTexto(req.body.observacion);
    if (!solicitudId || !estadoNuevo) return res.status(400).json("Datos incompletos");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM traslado_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];

    const esPropia = Number(solicitud.usuario_id) === Number(cabecera.id);
    const transiciones = transicionesDisponibles(cabecera, solicitud.estado_id, esPropia);
    if (!puedeVerSolicitud(cabecera, solicitud) || !transiciones.includes(estadoNuevo)) {
      return res.status(401).json("No podés aplicar ese cambio de estado");
    }

    // Reabrir respeta la regla de una sola solicitud activa por afiliado
    if (estadoNuevo === ESTADO.INICIADA) {
      const [otrasActivas] = await db.query(
        "SELECT id FROM traslado_solicitud WHERE usuario_id = ? AND eliminado = 0 AND estado_id = ? AND id <> ?",
        [solicitud.usuario_id, ESTADO.INICIADA, solicitudId]
      );
      if (otrasActivas.length > 0) {
        return res.status(409).json(`No se puede reabrir: el afiliado ya tiene otra solicitud de traslado en curso (#${otrasActivas[0].id}).`);
      }
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      `UPDATE traslado_solicitud
       SET estado_id = ?,
           fecha_concretada = CASE WHEN ? = ${ESTADO.CONCRETADA} THEN NOW() WHEN ? = ${ESTADO.INICIADA} THEN NULL ELSE fecha_concretada END,
           fecha_cancelada = CASE WHEN ? = ${ESTADO.CANCELADA} THEN NOW() WHEN ? = ${ESTADO.INICIADA} THEN NULL ELSE fecha_cancelada END
       WHERE id = ?`,
      [estadoNuevo, estadoNuevo, estadoNuevo, estadoNuevo, estadoNuevo, solicitudId]
    );

    await registrarHistorial(connection, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "CAMBIO_ESTADO",
      estado_anterior_id: solicitud.estado_id,
      estado_nuevo_id: estadoNuevo,
      observacion,
    });

    if (observacion) {
      await connection.query(
        "INSERT INTO traslado_observacion (solicitud_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
        [solicitudId, cabecera.id, cabecera.rol, observacion, estadoNuevo]
      );
    }

    const [estados] = await connection.query("SELECT nombre FROM traslado_estado WHERE id = ?", [estadoNuevo]);
    const nombreEstado = estados.length > 0 ? estados[0].nombre : "";
    await notificarInvolucrados(
      connection, { ...solicitud, estado_id: estadoNuevo }, cabecera, "TRASLADO_ESTADO",
      `La solicitud de traslado #${solicitudId} pasó a "${nombreEstado}"`,
      `Tu solicitud de traslado #${solicitudId} pasó a "${nombreEstado}"`,
      `Nueva situación: ${nombreEstado}.${observacion ? " Observación: " + observacion : ""}`
    );

    await connection.commit();
    res.status(200).json({ success: true, message: `La solicitud pasó a "${nombreEstado}"`, estado_id: estadoNuevo });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error && error.code === "ER_DUP_ENTRY") {
      return res.status(409).json("No se puede reabrir: el afiliado ya tiene otra solicitud de traslado en curso.");
    }
    console.log(error);
    res.status(500).json("Error al cambiar el estado de la solicitud");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// POST /traslados/solicitudes/:id/observaciones — hilo de chat
// ---------------------------------------------------------------------------
router.post("/traslados/solicitudes/:id/observaciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!solicitudId || !mensaje) return res.status(400).json("El mensaje es obligatorio");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM traslado_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeVerSolicitud(cabecera, solicitud)) return res.status(401).json("No autorizado");

    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      "INSERT INTO traslado_observacion (solicitud_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
      [solicitudId, cabecera.id, cabecera.rol, mensaje, solicitud.estado_id]
    );
    await registrarHistorial(connection, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "OBSERVACION",
      observacion: mensaje,
    });

    await notificarInvolucrados(
      connection, solicitud, cabecera, "TRASLADO_OBSERVACION",
      `Nuevo mensaje en la solicitud de traslado #${solicitudId}`,
      `Nuevo mensaje en tu solicitud de traslado #${solicitudId}`,
      `${cabecera.rol === "afiliado" ? "El afiliado" : "El equipo de la AJB"} escribió: ${mensaje}`
    );

    await connection.commit();
    res.status(201).json({ success: true, message: "Mensaje enviado" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// DELETE /traslados/solicitudes/:id — baja lógica (staff)
// ---------------------------------------------------------------------------
router.delete("/traslados/solicitudes/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM traslado_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    if (!puedeEliminarSolicitud(cabecera, rows[0])) return res.status(401).json("No autorizado");

    connection = await db.getConnection();
    await connection.beginTransaction();
    await connection.query("UPDATE traslado_solicitud SET eliminado = 1 WHERE id = ?", [solicitudId]);
    await registrarHistorial(connection, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE",
      observacion: normalizarTexto(req.body?.motivo) || "Solicitud eliminada",
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Solicitud eliminada" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al eliminar la solicitud");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /traslados/archivos/:id/descargar — descarga individual (stream)
// ---------------------------------------------------------------------------
router.get("/traslados/archivos/:id/descargar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const archivoId = Number(req.params.id);
    if (!archivoId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `SELECT a.*, s.usuario_id, s.departamental_origen_id, s.departamental_destino_id, s.estado_id
       FROM traslado_archivo a INNER JOIN traslado_solicitud s ON s.id = a.solicitud_id
       WHERE a.id = ? AND s.eliminado = 0`,
      [archivoId]
    );
    if (rows.length === 0) return res.status(404).json("Archivo no encontrado");
    if (!puedeVerSolicitud(cabecera, rows[0])) return res.status(401).json("No autorizado");

    const objeto = await getObjectBufferFromS3(rows[0].archivo);
    if (!objeto) return res.status(404).json("El archivo no está disponible");

    const nombre = rows[0].nombre_original || rows[0].archivo.split("/").pop();
    res.setHeader("Content-Type", objeto.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(nombre)}"`);
    res.status(200).send(objeto.buffer);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al descargar el archivo");
  }
});

module.exports = router;
