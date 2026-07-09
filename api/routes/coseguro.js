/**
 * MÓDULO COSEGURO MÉDICO (reintegros a afiliados)
 *
 * Flujo de estados:
 *  1 Solicitud iniciada  -> el afiliado (o la departamental) carga el formulario
 *  2 Revisar solicitud   -> la departamental pide correcciones (el afiliado puede editar)
 *  3 Solicitud revisada  -> el afiliado reenvió la solicitud corregida
 *  4 Aprobado por departamental (a partir de acá el afiliado no edita más)
 *  5 Rechazado por departamental
 *  6 Solicitud cancelada (por el afiliado)
 *  7 Aprobado por servicios sociales (a partir de acá la departamental no edita más)
 *  8 Exportado para liquidar (interno; el afiliado lo ve como "Pendiente de acreditación")
 *  9 Pendiente de acreditación
 * 10 Liquidado (pago acreditado; fecha_pago desde el CSV del auditor)
 */
const express = require("express");
const router = express.Router();
const mysqlConnection = require("../connection/connection");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const moment = require("moment");
const archiver = require("archiver");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const arca = require("../services/arca");
const { calcularPhashes, sonMismaImagen, parsearPhash } = require("../services/imagen-hash");

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

async function subirArchivoCoseguro(file, prefijo) {
  const extension = extensionSegura(file.originalname, file.mimetype);
  const key = `coseguro/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
  return key;
}

async function subirFirmaBase64(firmaBase64) {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(firmaBase64 || "");
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  const key = `coseguro/firma_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.png`;
  await uploadBufferToS3({ key, buffer, contentType: match[1] });
  return key;
}

const EXTENSION_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

function extensionSegura(nombre, mime) {
  if (EXTENSION_POR_MIME[mime]) return EXTENSION_POR_MIME[mime];
  const partes = String(nombre || "").split(".");
  const ext = partes.length > 1 ? partes.pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return ext || "bin";
}

// ---------------------------------------------------------------------------
// Multer (memoria). Los campos de archivos llegan con fieldname = clave del slot
// (RECETA, TICKET_FISCAL, TROQUEL, BONO_FRENTE, ...) para que cada casilla sea específica.
// ---------------------------------------------------------------------------
const SLOTS_VALIDOS = [
  "RECETA", "TICKET_FISCAL", "TROQUEL", "DETALLE_COMPRA", "PRESCRIPCION", "FACTURA",
  "BONO_FRENTE", "BONO_DORSO", "PARTIDA_NACIMIENTO", "DNI_RECIEN_NACIDO", "COMPROBANTE",
  "DOCUMENTACION", "EXTRA",
];

const uploadCoseguro = multer({
  storage: multer.memoryStorage(),
  limits: { files: 20, fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const esImagen = file.mimetype?.startsWith("image/");
    const esPdf = file.mimetype === "application/pdf";
    if (!esImagen && !esPdf) return cb(new Error("Solo se permiten imágenes o PDF"));
    return cb(null, true);
  },
});

function manejarUploadCoseguro(req, res, next) {
  uploadCoseguro.any()(req, res, (error) => {
    if (error) return res.status(400).json(error.message || "No se pudieron procesar los archivos");
    return next();
  });
}

// Upload específico para el CSV de liquidación del banco
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mimesValidos = ["text/csv", "application/vnd.ms-excel", "text/plain", "application/csv", "application/octet-stream"];
    const esCsv = mimesValidos.includes(file.mimetype) || /\.(csv|txt)$/i.test(file.originalname || "");
    if (!esCsv) return cb(new Error("Subí un archivo CSV (separado por punto y coma)"));
    return cb(null, true);
  },
});

function manejarUploadCsv(req, res, next) {
  uploadCsv.any()(req, res, (error) => {
    if (error) return res.status(400).json(error.message || "No se pudo procesar el archivo CSV");
    return next();
  });
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

const ROLES_STAFF = ["admin", "departamental", "admin-central", "auditor"];
const ROLES_GESTION = ["admin", "departamental", "admin-central"];

// ---------------------------------------------------------------------------
// Estados y permisos
// ---------------------------------------------------------------------------
const ESTADO = {
  INICIADA: 1,
  REVISAR: 2,
  REVISADA: 3,
  APROBADA_DEPTO: 4,
  RECHAZADA_DEPTO: 5,
  CANCELADA: 6,
  APROBADA_CENTRAL: 7,
  EXPORTADO: 8,
  PENDIENTE_ACREDITACION: 9,
  LIQUIDADO: 10,
};

// Estados en los que cada rol puede editar los datos de la solicitud
const ESTADOS_EDICION_POR_ROL = {
  afiliado: [ESTADO.INICIADA, ESTADO.REVISAR],
  departamental: [ESTADO.INICIADA, ESTADO.REVISAR, ESTADO.REVISADA, ESTADO.APROBADA_DEPTO],
  "admin-central": [ESTADO.APROBADA_DEPTO, ESTADO.APROBADA_CENTRAL],
  admin: [ESTADO.INICIADA, ESTADO.REVISAR, ESTADO.REVISADA, ESTADO.APROBADA_DEPTO, ESTADO.APROBADA_CENTRAL],
};

// Estados en los que cada rol puede eliminar la solicitud (antes de aprobación central)
const ESTADOS_ELIMINACION_POR_ROL = {
  departamental: [ESTADO.INICIADA, ESTADO.REVISAR, ESTADO.REVISADA, ESTADO.APROBADA_DEPTO, ESTADO.RECHAZADA_DEPTO, ESTADO.CANCELADA],
  admin: [ESTADO.INICIADA, ESTADO.REVISAR, ESTADO.REVISADA, ESTADO.APROBADA_DEPTO, ESTADO.RECHAZADA_DEPTO, ESTADO.CANCELADA],
};

function transicionesDisponibles(rol, estadoId, esPropia) {
  switch (rol) {
    case "afiliado":
      return esPropia && [ESTADO.INICIADA, ESTADO.REVISAR, ESTADO.REVISADA].includes(estadoId) ? [ESTADO.CANCELADA] : [];
    case "departamental":
      return ({
        [ESTADO.INICIADA]: [ESTADO.APROBADA_DEPTO, ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.REVISAR]: [ESTADO.APROBADA_DEPTO, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.REVISADA]: [ESTADO.APROBADA_DEPTO, ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.APROBADA_DEPTO]: [ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
      })[estadoId] || [];
    case "admin-central":
      return ({
        [ESTADO.APROBADA_DEPTO]: [ESTADO.APROBADA_CENTRAL, ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.APROBADA_CENTRAL]: [ESTADO.PENDIENTE_ACREDITACION],
        [ESTADO.EXPORTADO]: [ESTADO.PENDIENTE_ACREDITACION],
      })[estadoId] || [];
    case "auditor":
      return ({
        [ESTADO.APROBADA_CENTRAL]: [ESTADO.PENDIENTE_ACREDITACION],
        [ESTADO.EXPORTADO]: [ESTADO.PENDIENTE_ACREDITACION],
      })[estadoId] || [];
    case "admin":
      return ({
        [ESTADO.INICIADA]: [ESTADO.APROBADA_DEPTO, ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.REVISAR]: [ESTADO.APROBADA_DEPTO, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.REVISADA]: [ESTADO.APROBADA_DEPTO, ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.APROBADA_DEPTO]: [ESTADO.APROBADA_CENTRAL, ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO],
        [ESTADO.APROBADA_CENTRAL]: [ESTADO.PENDIENTE_ACREDITACION],
        [ESTADO.EXPORTADO]: [ESTADO.PENDIENTE_ACREDITACION, ESTADO.LIQUIDADO],
        [ESTADO.PENDIENTE_ACREDITACION]: [ESTADO.LIQUIDADO],
      })[estadoId] || [];
    default:
      return [];
  }
}

function puedeVerSolicitud(cabecera, solicitud) {
  switch (cabecera.rol) {
    case "admin":
    case "admin-central":
      return true;
    case "auditor":
      return [ESTADO.APROBADA_CENTRAL, ESTADO.EXPORTADO, ESTADO.PENDIENTE_ACREDITACION, ESTADO.LIQUIDADO].includes(solicitud.estado_id);
    case "departamental":
      return Number(solicitud.departamental_id) === Number(cabecera.departamental_id);
    case "afiliado":
      return Number(solicitud.usuario_id) === Number(cabecera.id);
    default:
      return false;
  }
}

function puedeEditarSolicitud(cabecera, solicitud) {
  const estados = ESTADOS_EDICION_POR_ROL[cabecera.rol] || [];
  if (!estados.includes(solicitud.estado_id)) return false;
  if (cabecera.rol === "afiliado") return Number(solicitud.usuario_id) === Number(cabecera.id);
  if (cabecera.rol === "departamental") return Number(solicitud.departamental_id) === Number(cabecera.departamental_id);
  return true;
}

function puedeEliminarSolicitud(cabecera, solicitud) {
  const estados = ESTADOS_ELIMINACION_POR_ROL[cabecera.rol] || [];
  if (!estados.includes(solicitud.estado_id)) return false;
  if (cabecera.rol === "departamental") return Number(solicitud.departamental_id) === Number(cabecera.departamental_id);
  return cabecera.rol === "admin";
}

// ---------------------------------------------------------------------------
// Validaciones locales (sin servicios externos)
// ---------------------------------------------------------------------------
function validarCuit(cuit) {
  const limpio = String(cuit || "").replace(/\D/g, "");
  if (limpio.length !== 11) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(limpio[i]) * mult[i];
  let verificador = 11 - (suma % 11);
  if (verificador === 11) verificador = 0;
  if (verificador === 10) verificador = 9; // regla especial ARCA
  return verificador === Number(limpio[10]);
}

function validarCbu(cbu) {
  const limpio = String(cbu || "").replace(/\D/g, "");
  if (limpio.length !== 22) return false;
  const dv = (cadena, pesos) => {
    let suma = 0;
    for (let i = 0; i < cadena.length; i++) suma += Number(cadena[i]) * pesos[i % pesos.length];
    return (10 - (suma % 10)) % 10;
  };
  const bloque1 = limpio.slice(0, 7);
  const dv1 = Number(limpio[7]);
  const bloque2 = limpio.slice(8, 21);
  const dv2 = Number(limpio[21]);
  return dv(bloque1, [7, 1, 3, 9, 7, 1, 3]) === dv1 && dv(bloque2, [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === dv2;
}

function normalizarTexto(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto === "" ? null : texto;
}

function normalizarDigitos(valor, maxLargo) {
  const texto = String(valor || "").replace(/\D/g, "");
  if (texto === "") return null;
  return maxLargo ? texto.slice(0, maxLargo) : texto;
}

function normalizarImporte(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const numero = Number(String(valor).replace(",", "."));
  return Number.isFinite(numero) ? Math.round(numero * 100) / 100 : null;
}

function normalizarFecha(valor) {
  const fecha = moment(String(valor || "").slice(0, 10), ["YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY"], true);
  return fecha.isValid() ? fecha.format("YYYY-MM-DD") : null;
}

// Formatos de fecha/hora aceptados en el CSV de liquidación del banco
const FORMATOS_FECHA_CSV = [
  "DD/MM/YYYY HH:mm:ss", "DD/MM/YYYY HH:mm", "DD/MM/YYYY H:mm", "DD/MM/YYYY",
  "D/M/YYYY HH:mm:ss", "D/M/YYYY HH:mm", "D/M/YYYY H:mm", "D/M/YYYY",
  "DD/MM/YY HH:mm:ss", "DD/MM/YY HH:mm", "DD/MM/YY",
  "DD-MM-YYYY HH:mm:ss", "DD-MM-YYYY HH:mm", "DD-MM-YYYY",
  "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD HH:mm", "YYYY-MM-DD",
  "YYYY/MM/DD HH:mm:ss", "YYYY/MM/DD",
  "DD.MM.YYYY HH:mm:ss", "DD.MM.YYYY HH:mm", "DD.MM.YYYY",
];

function parsearFechaFlexible(valor) {
  const texto = String(valor || "").trim().replace(/\s+/g, " ").replace(/hs\.?$/i, "").trim();
  if (!texto) return null;
  // Número serial de Excel (días desde 1900-01-01)
  if (/^\d+([.,]\d+)?$/.test(texto)) {
    const serial = Number(texto.replace(",", "."));
    if (serial > 25569 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400 * 1000);
      const fecha = moment.utc(ms);
      if (fecha.isValid()) return fecha.format("YYYY-MM-DD HH:mm:ss");
    }
    return null;
  }
  const parseado = moment(texto, FORMATOS_FECHA_CSV, true);
  if (parseado.isValid()) return parseado.format("YYYY-MM-DD HH:mm:ss");
  const iso = moment(texto, moment.ISO_8601, true);
  if (iso.isValid()) return iso.format("YYYY-MM-DD HH:mm:ss");
  return null;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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

// ---------------------------------------------------------------------------
// Historial y notificaciones
// ---------------------------------------------------------------------------
async function registrarHistorial(connection, datos) {
  await connection.query(
    `INSERT INTO coseguro_historial
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

async function notificarUsuariosDepartamental(connection, departamentalId, tipo, titulo, mensaje, payload) {
  if (!departamentalId) return;
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE r.nombre = 'departamental' AND u.departamental_id = ? AND u.habilitado = 'Y'`,
    [departamentalId]
  );
  for (const u of usuarios) await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
}

async function notificarUsuariosPorRol(connection, rolNombre, tipo, titulo, mensaje, payload) {
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE r.nombre = ? AND u.habilitado = 'Y'`,
    [rolNombre]
  );
  for (const u of usuarios) await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
}

// Nombre del estado que ve el afiliado (el estado 8 se muestra como "Pendiente de acreditación")
async function nombreEstadoAfiliado(connection, estadoId) {
  const [rows] = await connection.query("SELECT nombre, nombre_afiliado FROM coseguro_estado WHERE id = ?", [estadoId]);
  if (rows.length === 0) return null;
  return rows[0].nombre_afiliado || rows[0].nombre;
}

async function notificarCambioEstadoAfiliado(connection, solicitud, estadoAnteriorId, estadoNuevoId, observacion) {
  const nombreNuevo = await nombreEstadoAfiliado(connection, estadoNuevoId);
  const nombreAnterior = estadoAnteriorId ? await nombreEstadoAfiliado(connection, estadoAnteriorId) : null;
  if (!nombreNuevo || nombreNuevo === nombreAnterior) return; // p.ej. 8 -> 9: el afiliado ve lo mismo
  const titulo = `Tu solicitud de reintegro #${solicitud.id} cambió de estado`;
  let mensaje = `Nueva situación: ${nombreNuevo}.`;
  if (observacion) mensaje += ` Observación: ${observacion}`;
  await insertarNotificacion(connection, solicitud.usuario_id, "COSEGURO_ESTADO", titulo, mensaje, {
    solicitud_id: solicitud.id,
    estado_id: estadoNuevoId,
    estado_nombre: nombreNuevo,
    observacion: observacion || null,
  });
}

// ---------------------------------------------------------------------------
// Extracción automática del comprobante con Google Gemini (opcional)
// ---------------------------------------------------------------------------
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const ESQUEMA_EXTRACCION = {
  type: "OBJECT",
  properties: {
    tipo_documento: { type: "STRING", description: "FACTURA, TICKET_FISCAL, RECIBO, BONO, RECETA, PRESCRIPCION, TROQUEL, OTRO" },
    fecha: { type: "STRING", description: "Fecha de emisión del comprobante en formato YYYY-MM-DD" },
    punto_venta: { type: "STRING", description: "Punto de venta de la factura (4 o 5 dígitos), solo números" },
    numero_comprobante: { type: "STRING", description: "Número del comprobante (8 dígitos) o código del bono, solo números" },
    cuit_emisor: { type: "STRING", description: "CUIT del emisor, 11 dígitos sin guiones" },
    nombre_emisor: { type: "STRING", description: "Razón social o nombre del profesional emisor" },
    importe_total: { type: "NUMBER", description: "Importe total del comprobante en pesos" },
    cae: { type: "STRING", description: "Número de CAE/CAI de AFIP si figura (14 dígitos)" },
    tipo_comprobante_arca: {
      type: "NUMBER",
      description:
        "Código ARCA del tipo de comprobante si es identificable: 1=Factura A, 6=Factura B, 11=Factura C, 51=Factura M, 19=Factura E, 4=Recibo A, 9=Recibo B, 15=Recibo C, 81=Tique Factura A, 82=Tique Factura B, 111=Tique Factura C, 83=Tique",
    },
    cantidad_sesiones: { type: "NUMBER", description: "Cantidad de sesiones si se menciona (ej: psicología 4 sesiones)" },
    descripcion: { type: "STRING", description: "Descripción breve de la prestación o los productos" },
    es_legible: { type: "BOOLEAN", description: "false si el documento es ilegible o no es un comprobante" },
    confianza: { type: "NUMBER", description: "Confianza global de la extracción entre 0 y 1" },
  },
  required: ["es_legible", "confianza"],
};

const PROMPT_EXTRACCION = `Sos un asistente experto en comprobantes médicos argentinos (facturas AFIP/ARCA, tickets fiscales,
recibos, bonos de consulta, recetas y prescripciones médicas manuscritas, troqueles de medicamentos).
Analizá los documentos adjuntos (pueden ser PDF con texto, PDF escaneados o fotos de papeles manuscritos)
y extraé los datos solicitados. Reglas:
- El número de comprobante de una factura argentina tiene el formato PPPPP-NNNNNNNN (punto de venta - número). Devolvé ambos por separado, solo dígitos.
- El CUIT tiene 11 dígitos; devolvelo sin guiones. No lo inventes: si no se ve, dejalo vacío.
- La fecha va en formato YYYY-MM-DD. Interpretá formatos argentinos (DD/MM/YYYY).
- El importe es el TOTAL final del comprobante (número decimal, sin símbolo $, punto decimal).
- Si hay varios documentos, priorizá el comprobante fiscal (factura/ticket) para número, CUIT e importe.
- Si el comprobante indica su tipo y letra (ej: "FACTURA C", "TIQUE FACTURA B"), devolvé el código ARCA en tipo_comprobante_arca.
- El CAE/CAI tiene exactamente 14 dígitos; devolvelo solo con números.
- Si es una receta o prescripción manuscrita, extraé el nombre del médico como nombre_emisor si es legible.
- Si algo no se puede leer con seguridad, dejá el campo vacío en lugar de adivinar y bajá la confianza.`;

async function extraerDatosComprobanteIA(files) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { disponible: false, motivo: "GEMINI_API_KEY no configurada" };

  const partes = [{ text: PROMPT_EXTRACCION }];
  for (const file of files.slice(0, 3)) {
    partes.push({ inline_data: { mime_type: file.mimetype, data: file.buffer.toString("base64") } });
  }

  const respuesta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: partes }],
        generationConfig: {
          temperature: 0,
          response_mime_type: "application/json",
          response_schema: ESQUEMA_EXTRACCION,
        },
      }),
    }
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => "");
    console.error("Error Gemini:", respuesta.status, detalle.slice(0, 500));
    return { disponible: false, motivo: `Error del servicio de extracción (${respuesta.status})` };
  }

  const data = await respuesta.json();
  const texto = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const datos = parseJsonSeguro(texto);
  if (!datos) return { disponible: false, motivo: "No se pudo interpretar la respuesta del servicio" };

  // Normalización defensiva
  if (datos.cuit_emisor) datos.cuit_emisor = normalizarDigitos(datos.cuit_emisor, 11);
  if (datos.punto_venta) datos.punto_venta = normalizarDigitos(datos.punto_venta, 5);
  if (datos.numero_comprobante) datos.numero_comprobante = normalizarDigitos(datos.numero_comprobante, 20);
  if (datos.fecha) datos.fecha = normalizarFecha(datos.fecha);
  if (datos.importe_total !== undefined) datos.importe_total = normalizarImporte(datos.importe_total);
  return { disponible: true, datos };
}

// ---------------------------------------------------------------------------
// Chequeo de duplicados
// ---------------------------------------------------------------------------
// Un comprobante se considera repetido cuando tiene el mismo número Y además
// pertenece al mismo emisor (mismo CUIT, tolerando cargas viejas sin CUIT) o al
// mismo afiliado (que repite su propio bono/comprobante). Así se evita el falso
// positivo entre bonos de talonarios distintos de afiliados distintos.
async function buscarDuplicadosComprobante(db, { emisor_cuit, comprobante_pto_venta, comprobante_numero, usuario_id, excluirId }) {
  if (!comprobante_numero) return [];
  if (!emisor_cuit && !usuario_id) return [];
  const condiciones = ["s.eliminado = 0", "s.estado_id NOT IN (?, ?)", "s.comprobante_numero = ?"];
  const params = [ESTADO.RECHAZADA_DEPTO, ESTADO.CANCELADA, comprobante_numero];

  const alcance = [];
  if (emisor_cuit) {
    alcance.push("s.emisor_cuit = ? OR s.emisor_cuit IS NULL");
    params.push(emisor_cuit);
  }
  if (usuario_id) {
    alcance.push("s.usuario_id = ?");
    params.push(usuario_id);
  }
  condiciones.push(`(${alcance.join(" OR ")})`);

  // Si ambos tienen punto de venta y difieren, son comprobantes distintos
  if (comprobante_pto_venta) {
    condiciones.push("(s.comprobante_pto_venta = ? OR s.comprobante_pto_venta IS NULL)");
    params.push(comprobante_pto_venta);
  }
  if (excluirId) {
    condiciones.push("s.id <> ?");
    params.push(excluirId);
  }
  const [rows] = await db.query(
    `SELECT s.id, s.usuario_id, s.estado_id, s.fecha_creacion, s.importe,
            CONCAT(u.apellido, ', ', u.nombre) AS afiliado, e.nombre AS estado
     FROM coseguro_solicitud s
     INNER JOIN usuario u ON u.id = s.usuario_id
     INNER JOIN coseguro_estado e ON e.id = s.estado_id
     WHERE ${condiciones.join(" AND ")}
     LIMIT 5`,
    params
  );
  return rows;
}

// Busca en TODO el histórico de archivos del sistema:
//  - por SHA-256 (archivo idéntico byte a byte, incluye PDFs)
//  - por hash perceptual (misma imagen aunque esté ROTADA, ESPEJADA, recomprimida o redimensionada)
async function buscarDuplicadosArchivo(db, hashes, excluirSolicitudId, phashSets = []) {
  const resultados = new Map();

  if (hashes && hashes.length > 0) {
    const params = [hashes, ESTADO.RECHAZADA_DEPTO, ESTADO.CANCELADA];
    let extra = "";
    if (excluirSolicitudId) {
      extra = " AND s.id <> ?";
      params.push(excluirSolicitudId);
    }
    const [rows] = await db.query(
      `SELECT a.id AS archivo_id, a.sha256, a.tipo_adjunto, s.id AS solicitud_id, s.usuario_id, e.nombre AS estado,
              CONCAT(u.apellido, ', ', u.nombre) AS afiliado
       FROM coseguro_archivo a
       INNER JOIN coseguro_solicitud s ON s.id = a.solicitud_id
       INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       WHERE a.sha256 IN (?) AND s.eliminado = 0 AND s.estado_id NOT IN (?, ?)${extra}
       LIMIT 10`,
      params
    );
    rows.forEach((row) => resultados.set(row.archivo_id, { ...row, coincidencia: "archivo" }));
  }

  // Comparación perceptual contra todo el histórico activo (la distancia de Hamming se
  // resuelve en memoria: son solo los hashes, no los archivos)
  const setsValidos = (phashSets || []).filter((set) => Array.isArray(set) && set.length > 0);
  if (setsValidos.length > 0) {
    const params = [ESTADO.RECHAZADA_DEPTO, ESTADO.CANCELADA];
    let extra = "";
    if (excluirSolicitudId) {
      extra = " AND s.id <> ?";
      params.push(excluirSolicitudId);
    }
    const [rows] = await db.query(
      `SELECT a.id AS archivo_id, a.sha256, a.phash, a.tipo_adjunto, s.id AS solicitud_id, s.usuario_id, e.nombre AS estado,
              CONCAT(u.apellido, ', ', u.nombre) AS afiliado
       FROM coseguro_archivo a
       INNER JOIN coseguro_solicitud s ON s.id = a.solicitud_id
       INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       WHERE a.phash IS NOT NULL AND s.eliminado = 0 AND s.estado_id NOT IN (?, ?)${extra}`,
      params
    );
    for (const row of rows) {
      if (resultados.has(row.archivo_id)) continue;
      const hashesExistentes = parsearPhash(row.phash);
      if (!hashesExistentes) continue;
      if (setsValidos.some((set) => sonMismaImagen(set, hashesExistentes))) {
        const { phash, ...resto } = row;
        resultados.set(row.archivo_id, { ...resto, coincidencia: "imagen" });
      }
    }
  }

  return Array.from(resultados.values()).slice(0, 10);
}

// Calcula sha256 + hash perceptual de los archivos subidos y detecta si el usuario
// puso la MISMA imagen (aun rotada/espejada) en dos casillas del mismo formulario
async function prepararHashesArchivos(files) {
  const lista = files || [];
  for (const file of lista) {
    file.sha256Calculado = sha256(file.buffer);
    file.phashes = await calcularPhashes(file.buffer, file.mimetype);
  }
  for (let i = 0; i < lista.length; i++) {
    for (let j = i + 1; j < lista.length; j++) {
      if (lista[i].sha256Calculado === lista[j].sha256Calculado) return { repetidoInterno: true };
      if (lista[i].phashes && lista[j].phashes && sonMismaImagen(lista[i].phashes, lista[j].phashes)) {
        return { repetidoInterno: true };
      }
    }
  }
  return { repetidoInterno: false };
}

// ---------------------------------------------------------------------------
// Constatación automática en ARCA
// ---------------------------------------------------------------------------
// Un comprobante es "constatable" cuando la extracción automática leyó un CAE de
// 14 dígitos y el tipo de comprobante, y la solicitud tiene CUIT + punto de venta
// + número. Los bonos, recetas y prescripciones no tienen CAE: se saltean solos.
function datosConstatablesArca(solicitud, extraccion) {
  const cae = String(extraccion?.cae || "").replace(/\D/g, "");
  const cbteTipo = Number(extraccion?.tipo_comprobante_arca) || null;
  if (cae.length !== 14 || !cbteTipo) return null;
  if (!solicitud.emisor_cuit || !solicitud.comprobante_pto_venta || !solicitud.comprobante_numero) return null;
  return { cae, cbteTipo };
}

// Se ejecuta en segundo plano al crear/corregir una solicitud: no demora el envío
// del afiliado y le ahorra a la departamental abrir trámites que ARCA ya rechazó.
async function constatarArcaAutomatico(solicitudId) {
  try {
    if (!arca.configuracion().configurado) return;
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return;
    const solicitud = rows[0];
    const extraccion = parseJsonSeguro(solicitud.extraccion_ia);
    const datos = datosConstatablesArca(solicitud, extraccion);
    if (!datos) return;

    const resultado = await arca.constatarComprobante({
      cuit_emisor: solicitud.emisor_cuit,
      pto_venta: solicitud.comprobante_pto_venta,
      numero: solicitud.comprobante_numero,
      fecha: moment(solicitud.fecha_comprobante).format("YYYY-MM-DD"),
      importe: solicitud.importe,
      cod_autorizacion: datos.cae,
      cbte_tipo: datos.cbteTipo,
    });

    const verificacion = parseJsonSeguro(solicitud.verificacion) || {};
    verificacion.arca = {
      resultado: resultado.resultado,
      aprobado: resultado.aprobado,
      observaciones: resultado.observaciones,
      errores: resultado.errores,
      cbte_tipo: datos.cbteTipo,
      cod_autorizacion: datos.cae,
      fecha_consulta: moment().format("YYYY-MM-DD HH:mm:ss"),
      consultado_por: null,
      origen: "automatica",
      entorno: resultado.entorno,
    };
    await db.query("UPDATE coseguro_solicitud SET verificacion = ? WHERE id = ?", [JSON.stringify(verificacion), solicitudId]);
    await registrarHistorial(db, {
      solicitud_id: solicitudId,
      usuario_id: null,
      usuario_rol: "sistema",
      tipo_operacion: "UPDATE",
      campo_modificado: "Constatación ARCA (automática)",
      valor_nuevo: resultado.aprobado
        ? "APROBADO: el comprobante existe en ARCA"
        : `RECHAZADO: ${(resultado.observaciones || []).map((o) => o.mensaje).join("; ") || "sin detalle"}`,
    });
  } catch (error) {
    // Si ARCA está caído o el login falla, no afecta el flujo: queda el botón manual
    console.error(`Constatación ARCA automática (solicitud ${solicitudId}):`, error.message);
  }
}

// ---------------------------------------------------------------------------
// GET /coseguro/catalogos — estados, tipos, conceptos, imputaciones, departamentales
// ---------------------------------------------------------------------------
router.get("/coseguro/catalogos", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();

    const [estados] = await db.query("SELECT * FROM coseguro_estado ORDER BY orden");
    const [tipos] = await db.query(
      `SELECT t.id, t.nombre, t.icono, t.imputacion_id, t.imputacion_detalle_id, t.requiere_pto_venta,
              CAST(t.adjuntos_config AS CHAR) AS adjuntos_config, i.codigo AS cic_codigo
       FROM coseguro_tipo_reintegro t
       LEFT JOIN coseguro_imputacion i ON i.id = t.imputacion_id
       WHERE t.activo = 1 ORDER BY t.orden`
    );
    const [conceptos] = await db.query(
      `SELECT c.id, c.nombre, c.imputacion_id, c.imputacion_detalle_id, i.codigo AS cic_codigo
       FROM coseguro_concepto c
       LEFT JOIN coseguro_imputacion i ON i.id = c.imputacion_id
       WHERE c.activo = 1 ORDER BY c.orden`
    );
    const [imputaciones] = await db.query(
      `SELECT id, codigo, descripcion, tipo, parent_id, activo FROM coseguro_imputacion ORDER BY orden`
    );
    let departamentales = [];
    if (ROLES_STAFF.includes(cabecera.rol)) {
      const [rows] = await db.query("SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre");
      departamentales = rows;
    }

    // Los estados que ve el afiliado usan el nombre público
    const estadosSalida = estados.map((e) => ({
      ...e,
      nombre_visible: cabecera.rol === "afiliado" && e.nombre_afiliado ? e.nombre_afiliado : e.nombre,
    }));

    res.status(200).json({
      estados: estadosSalida,
      tipos_reintegro: tipos.map((t) => ({ ...t, adjuntos_config: parseJsonSeguro(t.adjuntos_config) || [] })),
      conceptos,
      imputaciones,
      departamentales,
      limite_meses: 6,
      extraccion_ia_disponible: Boolean(process.env.GEMINI_API_KEY),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los catálogos de coseguro");
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/perfil — CUIL/CBU guardados del afiliado (+ familiares)
// ---------------------------------------------------------------------------
router.get("/coseguro/perfil", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    let usuarioId = Number(cabecera.id);
    if (ROLES_STAFF.includes(cabecera.rol) && req.query.usuario_id) usuarioId = Number(req.query.usuario_id);

    const db = mysqlConnection.promise();
    const [usuarios] = await db.query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.cuil, u.cbu, u.departamental_id, d.nombre AS departamental_nombre
       FROM usuario u LEFT JOIN departamental d ON d.id = u.departamental_id WHERE u.id = ?`,
      [usuarioId]
    );
    if (usuarios.length === 0) return res.status(404).json("Usuario no encontrado");
    if (cabecera.rol === "departamental" && usuarios[0].departamental_id !== null &&
        Number(usuarios[0].departamental_id) !== Number(cabecera.departamental_id)) {
      return res.status(401).json("No autorizado");
    }

    const [familiares] = await db.query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.fecha_nacimiento, u.parentesco_id, p.nombre AS parentesco,
              TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) AS edad
       FROM usuario u LEFT JOIN parentesco p ON p.id = u.parentesco_id
       WHERE u.usuario_familiar_id = ? AND u.es_familiar = 'S' AND u.habilitado = 'Y'
       ORDER BY u.apellido, u.nombre`,
      [usuarioId]
    );

    res.status(200).json({
      usuario: usuarios[0],
      familiares: familiares.map((f) => ({ ...f, dni_cargado: f.documento !== null && Number(f.documento) > 0 })),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener el perfil del afiliado");
  }
});

// ---------------------------------------------------------------------------
// PUT /coseguro/familiares/:id/documento — carga obligatoria del DNI del familiar
// ---------------------------------------------------------------------------
router.put("/coseguro/familiares/:id/documento", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const familiarId = Number(req.params.id);
    const documento = normalizarDigitos(req.body.documento, 9);
    if (!familiarId) return res.status(400).json("ID inválido");
    if (!documento || documento.length < 6) return res.status(400).json("El DNI debe tener al menos 6 dígitos");

    const db = mysqlConnection.promise();
    const [familiares] = await db.query("SELECT id, usuario_familiar_id FROM usuario WHERE id = ?", [familiarId]);
    if (familiares.length === 0) return res.status(404).json("Familiar no encontrado");

    const esPropio = Number(familiares[0].usuario_familiar_id) === Number(cabecera.id);
    if (cabecera.rol === "afiliado" && !esPropio) return res.status(401).json("No autorizado");
    if (!["afiliado", ...ROLES_GESTION].includes(cabecera.rol)) return res.status(401).json("No autorizado");

    try {
      await db.query("UPDATE usuario SET documento = ? WHERE id = ?", [Number(documento), familiarId]);
    } catch (error) {
      if (error && error.code === "ER_DUP_ENTRY") {
        return res.status(409).json("Ya existe otro usuario con ese DNI en el sistema");
      }
      throw error;
    }
    res.status(200).json({ success: true, message: "DNI actualizado" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al actualizar el DNI del familiar");
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/afiliados-buscar — búsqueda de afiliados (staff, para carga presencial)
// ---------------------------------------------------------------------------
router.get("/coseguro/afiliados-buscar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_GESTION.includes(cabecera.rol)) return res.status(401).json("No autorizado");

    const q = normalizarTexto(req.query.q);
    if (!q || q.length < 2) return res.status(200).json([]);

    const condiciones = ["r.nombre = 'afiliado'", "u.habilitado = 'Y'", "u.usuario_familiar_id IS NULL"];
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
// POST /coseguro/extraer-comprobante — extracción automática con IA
// ---------------------------------------------------------------------------
router.post("/coseguro/extraer-comprobante", verifyToken, manejarUploadCoseguro, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!["afiliado", ...ROLES_GESTION].includes(cabecera.rol)) return res.status(401).json("No autorizado");

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json("No se recibió ningún archivo");

    const resultado = await extraerDatosComprobanteIA(files);
    if (!resultado.disponible) {
      return res.status(200).json({ disponible: false, motivo: resultado.motivo });
    }

    const datos = resultado.datos || {};
    const validaciones = {
      cuit_valido: datos.cuit_emisor ? validarCuit(datos.cuit_emisor) : null,
      fecha_valida: Boolean(datos.fecha),
      dentro_de_6_meses: datos.fecha ? moment(datos.fecha).isSameOrAfter(moment().subtract(6, "months"), "day") : null,
    };
    res.status(200).json({ disponible: true, datos, validaciones });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al extraer los datos del comprobante");
  }
});

// ---------------------------------------------------------------------------
// POST /coseguro/verificar-duplicados — chequeo previo desde el formulario
// ---------------------------------------------------------------------------
router.post("/coseguro/verificar-duplicados", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!["afiliado", ...ROLES_GESTION].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const comprobantes = await buscarDuplicadosComprobante(db, {
      emisor_cuit: normalizarDigitos(req.body.emisor_cuit, 11),
      comprobante_pto_venta: normalizarDigitos(req.body.comprobante_pto_venta, 5),
      comprobante_numero: normalizarDigitos(req.body.comprobante_numero, 20),
      usuario_id: cabecera.rol === "afiliado" ? Number(cabecera.id) : Number(req.body.usuario_id) || null,
      excluirId: req.body.solicitud_id ? Number(req.body.solicitud_id) : null,
    });
    const hashes = Array.isArray(req.body.hashes) ? req.body.hashes.filter((h) => /^[a-f0-9]{64}$/i.test(String(h))) : [];
    const archivos = await buscarDuplicadosArchivo(db, hashes, req.body.solicitud_id ? Number(req.body.solicitud_id) : null);

    res.status(200).json({
      duplicado_comprobante: comprobantes.length > 0,
      duplicado_archivo: archivos.length > 0,
      comprobantes,
      archivos,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al verificar duplicados");
  }
});

// ---------------------------------------------------------------------------
// POST /coseguro/verificar-archivo — chequeo de UN archivo al momento de subirlo
// al formulario (contra TODO el histórico, incluyendo imágenes rotadas/espejadas).
// Permite avisarle al afiliado antes de que envíe un formulario en vano.
// ---------------------------------------------------------------------------
router.post("/coseguro/verificar-archivo", verifyToken, manejarUploadCoseguro, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!["afiliado", ...ROLES_GESTION].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const file = (req.files || [])[0];
    if (!file) return res.status(400).json("No se recibió ningún archivo");

    const db = mysqlConnection.promise();
    const sha = sha256(file.buffer);
    const phashes = await calcularPhashes(file.buffer, file.mimetype);
    const excluirId = req.body.solicitud_id ? Number(req.body.solicitud_id) : null;
    const duplicados = await buscarDuplicadosArchivo(db, [sha], excluirId, phashes ? [phashes] : []);

    if (duplicados.length === 0) return res.status(200).json({ duplicado: false });
    const dup = duplicados[0];
    res.status(200).json({
      duplicado: true,
      coincidencia: dup.coincidencia, // 'archivo' (idéntico) | 'imagen' (rotada/espejada/recomprimida)
      solicitud_id: dup.solicitud_id,
      estado: dup.estado,
      mismo_afiliado: Number(dup.usuario_id) === Number(cabecera.rol === "afiliado" ? cabecera.id : dup.usuario_id),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al verificar el archivo");
  }
});

// ---------------------------------------------------------------------------
// Validación y armado de los datos de una solicitud (crear/editar)
// ---------------------------------------------------------------------------
async function validarDatosSolicitud(db, cabecera, body, opciones) {
  const errores = [];
  const advertencias = [];
  const esStaff = ROLES_GESTION.includes(cabecera.rol);

  const tipoReintegroId = Number(body.tipo_reintegro_id) || null;
  if (!tipoReintegroId) errores.push("Seleccioná el tipo de reintegro");

  let tipo = null;
  if (tipoReintegroId) {
    const [tipos] = await db.query(
      "SELECT id, nombre, requiere_pto_venta, CAST(adjuntos_config AS CHAR) AS adjuntos_config, imputacion_id, imputacion_detalle_id FROM coseguro_tipo_reintegro WHERE id = ? AND activo = 1",
      [tipoReintegroId]
    );
    if (tipos.length === 0) errores.push("Tipo de reintegro inválido");
    else tipo = { ...tipos[0], adjuntos_config: parseJsonSeguro(tipos[0].adjuntos_config) || [] };
  }

  const conceptoId = Number(body.concepto_id) || null;
  if (!conceptoId) errores.push("Seleccioná el concepto");
  else {
    const [conceptos] = await db.query("SELECT id FROM coseguro_concepto WHERE id = ? AND activo = 1", [conceptoId]);
    if (conceptos.length === 0) errores.push("Concepto inválido");
  }

  const fechaComprobante = normalizarFecha(body.fecha_comprobante);
  if (!fechaComprobante) errores.push("La fecha del comprobante es obligatoria");
  else {
    if (moment(fechaComprobante).isAfter(moment(), "day")) errores.push("La fecha del comprobante no puede ser futura");
    const dentroDe6Meses = moment(fechaComprobante).isSameOrAfter(moment().subtract(6, "months"), "day");
    // Si es una edición y la fecha no cambió, no se re-aplica la regla de antigüedad:
    // la solicitud ya fue aceptada con esa fecha (evita trabar correcciones pedidas por la departamental)
    const fechaOriginal = opciones.fechaOriginal ? moment(opciones.fechaOriginal).format("YYYY-MM-DD") : null;
    if (!dentroDe6Meses && fechaOriginal === fechaComprobante) {
      advertencias.push("El comprobante supera los 6 meses de antigüedad (fecha ya aceptada previamente)");
    } else if (!dentroDe6Meses) {
      if (cabecera.rol === "afiliado") {
        errores.push("El comprobante tiene más de 6 meses de antigüedad. Por favor comunicate con tu departamental para gestionar este reintegro.");
      } else if (String(body.forzar_antiguedad) === "1" || body.forzar_antiguedad === true) {
        advertencias.push("Comprobante con más de 6 meses de antigüedad (cargado con autorización de la departamental)");
      } else {
        errores.push("ANTIGUEDAD:El comprobante tiene más de 6 meses de antigüedad. Confirmá si querés cargarlo de todas formas.");
      }
    }
  }

  const requierePtoVenta = tipo ? Number(tipo.requiere_pto_venta) === 1 : true;
  const ptoVenta = normalizarDigitos(body.comprobante_pto_venta, 5);
  const numero = normalizarDigitos(body.comprobante_numero, 20);
  if (!numero) errores.push("El número de comprobante es obligatorio");
  if (requierePtoVenta) {
    if (!ptoVenta) errores.push("El punto de venta del comprobante es obligatorio (los primeros 4-5 dígitos, ej: 00001)");
    else if (ptoVenta.length < 4) errores.push("El punto de venta debe tener 4 o 5 dígitos");
    if (numero && numero.length < 6) errores.push("El número de comprobante debe tener al menos 6 dígitos (completalo con ceros a la izquierda si hace falta)");
  }

  const emisorNombre = normalizarTexto(body.emisor_nombre);
  if (!emisorNombre) errores.push("El nombre del emisor del comprobante es obligatorio");

  const emisorCuit = normalizarDigitos(body.emisor_cuit, 11);
  if (requierePtoVenta && !emisorCuit) errores.push("El CUIT del emisor es obligatorio (11 dígitos, sin guiones)");
  if (emisorCuit && !validarCuit(emisorCuit)) errores.push("El CUIT del emisor no es válido (verificá los 11 dígitos)");

  const importe = normalizarImporte(body.importe);
  if (importe === null || importe <= 0) errores.push("El importe del comprobante es obligatorio y debe ser mayor a 0");

  const cuil = normalizarDigitos(body.cuil_afiliado, 11);
  if (!cuil) errores.push("El CUIL del afiliado es obligatorio (11 dígitos, sin guiones)");
  else if (!validarCuit(cuil)) errores.push("El CUIL ingresado no es válido (verificá los 11 dígitos)");

  const cbu = normalizarDigitos(body.cbu, 22);
  if (!cbu) errores.push("El CBU es obligatorio para depositar el reintegro (22 dígitos)");
  else if (cbu.length !== 22) errores.push("El CBU debe tener exactamente 22 dígitos");
  else if (!validarCbu(cbu)) errores.push("El CBU ingresado no es válido (verificá los 22 dígitos)");

  // Familiar a cargo (solicitante). NULL = titular
  let familiarId = body.familiar_usuario_id !== undefined && body.familiar_usuario_id !== null && String(body.familiar_usuario_id) !== "" && String(body.familiar_usuario_id) !== "0"
    ? Number(body.familiar_usuario_id)
    : null;
  if (familiarId) {
    const [familiares] = await db.query(
      "SELECT id, documento, nombre, apellido FROM usuario WHERE id = ? AND usuario_familiar_id = ? AND es_familiar = 'S'",
      [familiarId, opciones.usuarioId]
    );
    if (familiares.length === 0) {
      errores.push("El familiar seleccionado no figura a cargo del afiliado titular");
      familiarId = null;
    } else if (!familiares[0].documento || Number(familiares[0].documento) <= 0) {
      errores.push(`Falta cargar el DNI de ${familiares[0].nombre} ${familiares[0].apellido}. Actualizalo antes de continuar.`);
    }
  }

  const cantidadSesiones = body.cantidad_sesiones !== undefined && body.cantidad_sesiones !== null && String(body.cantidad_sesiones) !== ""
    ? Math.max(1, Math.trunc(Number(body.cantidad_sesiones)) || 1)
    : null;

  return {
    errores,
    advertencias,
    tipo,
    datos: {
      tipo_reintegro_id: tipoReintegroId,
      concepto_id: conceptoId,
      fecha_comprobante: fechaComprobante,
      comprobante_pto_venta: ptoVenta,
      comprobante_numero: numero,
      emisor_nombre: emisorNombre,
      emisor_cuit: emisorCuit,
      importe,
      cuil_afiliado: cuil,
      cbu,
      observaciones: normalizarTexto(body.observaciones),
      familiar_usuario_id: familiarId,
      cantidad_sesiones: cantidadSesiones,
      periodo_prestacion: fechaComprobante ? fechaComprobante.slice(0, 7) : null,
    },
  };
}

function archivosPorSlot(files) {
  const mapa = new Map();
  for (const file of files || []) {
    const slot = String(file.fieldname || "").toUpperCase();
    if (!SLOTS_VALIDOS.includes(slot)) continue;
    if (!mapa.has(slot)) mapa.set(slot, []);
    mapa.get(slot).push(file);
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// POST /coseguro/solicitudes — crear solicitud
// ---------------------------------------------------------------------------
router.post("/coseguro/solicitudes", verifyToken, manejarUploadCoseguro, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!["afiliado", ...ROLES_GESTION].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    // ¿Para qué afiliado es la solicitud?
    let usuarioId = Number(cabecera.id);
    if (ROLES_GESTION.includes(cabecera.rol)) {
      if (!req.body.usuario_id) return res.status(400).json("Indicá el afiliado titular de la solicitud");
      usuarioId = Number(req.body.usuario_id);
    }
    const [titulares] = await db.query(
      `SELECT u.id, u.departamental_id, u.nombre, u.apellido, r.nombre AS rol
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id WHERE u.id = ?`,
      [usuarioId]
    );
    if (titulares.length === 0) return res.status(404).json("Afiliado no encontrado");
    const titular = titulares[0];
    if (cabecera.rol === "departamental" && titular.departamental_id !== null &&
        Number(titular.departamental_id) !== Number(cabecera.departamental_id)) {
      return res.status(401).json("El afiliado pertenece a otra departamental");
    }

    const validacion = await validarDatosSolicitud(db, cabecera, req.body, { usuarioId });

    // Archivos requeridos según el tipo de reintegro
    const slots = archivosPorSlot(req.files);
    if (validacion.tipo) {
      for (const adjunto of validacion.tipo.adjuntos_config) {
        if (Number(adjunto.requerido) === 1 && !slots.has(adjunto.key)) {
          validacion.errores.push(`Falta adjuntar: ${adjunto.label}`);
        }
      }
    }
    if ((req.files || []).length === 0) validacion.errores.push("Adjuntá al menos un comprobante");

    // Firma
    const firmaBase64 = req.body.firma || null;
    if (cabecera.rol === "afiliado" && !firmaBase64) validacion.errores.push("La firma es obligatoria para enviar la solicitud");

    if (validacion.errores.length > 0) return res.status(400).json(validacion.errores.join(" | "));

    const datos = validacion.datos;
    const forzarDuplicado = ROLES_GESTION.includes(cabecera.rol) && (String(req.body.forzar_duplicado) === "1" || req.body.forzar_duplicado === true);

    // Duplicados por número de comprobante
    const duplicadosComprobante = await buscarDuplicadosComprobante(db, {
      emisor_cuit: datos.emisor_cuit,
      comprobante_pto_venta: datos.comprobante_pto_venta,
      comprobante_numero: datos.comprobante_numero,
      usuario_id: usuarioId,
    });
    if (duplicadosComprobante.length > 0 && !forzarDuplicado) {
      return res.status(409).json(
        `Ya existe una solicitud con ese número de comprobante (solicitud #${duplicadosComprobante[0].id} de ${duplicadosComprobante[0].afiliado}, estado: ${duplicadosComprobante[0].estado}). No se puede cargar dos veces el mismo comprobante.`
      );
    }

    // Duplicados por archivo: idéntico (SHA-256) o misma imagen transformada (hash perceptual)
    const preparacion = await prepararHashesArchivos(req.files);
    if (preparacion.repetidoInterno) {
      return res.status(400).json(
        "Subiste la misma imagen en dos casillas distintas (aunque esté rotada o espejada sigue siendo la misma). Cada casilla debe llevar el documento que corresponde."
      );
    }
    const hashes = (req.files || []).map((f) => f.sha256Calculado);
    const phashSets = (req.files || []).map((f) => f.phashes).filter(Boolean);
    const duplicadosArchivo = await buscarDuplicadosArchivo(db, hashes, null, phashSets);
    if (duplicadosArchivo.length > 0 && !forzarDuplicado) {
      const dup = duplicadosArchivo[0];
      const detalle = dup.coincidencia === "imagen" ? " (la imagen coincide aunque esté rotada, espejada o recomprimida)" : "";
      return res.status(409).json(
        `Uno de los archivos adjuntos ya fue presentado en la solicitud #${dup.solicitud_id} (${dup.afiliado})${detalle}. No se puede subir el mismo comprobante dos veces.`
      );
    }

    const departamentalId = titular.departamental_id !== null ? titular.departamental_id : (cabecera.departamental_id || null);

    const verificacion = {
      cuit_emisor_valido: datos.emisor_cuit ? validarCuit(datos.emisor_cuit) : null,
      cuil_valido: validarCuit(datos.cuil_afiliado),
      cbu_valido: validarCbu(datos.cbu),
      duplicados_forzados: forzarDuplicado && (duplicadosComprobante.length > 0 || duplicadosArchivo.length > 0),
      advertencias: validacion.advertencias,
    };
    const extraccionIA = parseJsonSeguro(req.body.extraccion_ia);

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Subir firma y archivos a S3
    let firmaArchivo = null;
    if (firmaBase64) firmaArchivo = await subirFirmaBase64(firmaBase64);

    const [resultado] = await connection.query(
      `INSERT INTO coseguro_solicitud
        (usuario_id, familiar_usuario_id, departamental_id, creado_por_usuario_id, estado_id,
         tipo_reintegro_id, concepto_id, fecha_comprobante, comprobante_pto_venta, comprobante_numero,
         emisor_nombre, emisor_cuit, importe, cuil_afiliado, cbu, observaciones, cantidad_sesiones,
         periodo_prestacion, firma_archivo, extraccion_ia, verificacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usuarioId, datos.familiar_usuario_id, departamentalId, cabecera.id, ESTADO.INICIADA,
        datos.tipo_reintegro_id, datos.concepto_id, datos.fecha_comprobante, datos.comprobante_pto_venta,
        datos.comprobante_numero, datos.emisor_nombre, datos.emisor_cuit, datos.importe, datos.cuil_afiliado,
        datos.cbu, datos.observaciones, datos.cantidad_sesiones, datos.periodo_prestacion, firmaArchivo,
        extraccionIA ? JSON.stringify(extraccionIA) : null, JSON.stringify(verificacion),
      ]
    );
    const solicitudId = resultado.insertId;

    for (const [slot, files] of slots.entries()) {
      for (const file of files) {
        const key = await subirArchivoCoseguro(file, `sol${solicitudId}_${slot.toLowerCase()}`);
        await connection.query(
          `INSERT INTO coseguro_archivo (solicitud_id, tipo_adjunto, archivo, nombre_original, mime, tamanio, sha256, phash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [solicitudId, slot, key, file.originalname || null, file.mimetype || null, file.size || null, file.sha256Calculado, file.phashes ? JSON.stringify(file.phashes) : null]
        );
      }
    }

    // Guardar CUIL/CBU en el perfil del afiliado para las próximas solicitudes
    await connection.query("UPDATE usuario SET cuil = ?, cbu = ? WHERE id = ?", [datos.cuil_afiliado, datos.cbu, usuarioId]);

    await registrarHistorial(connection, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      estado_nuevo_id: ESTADO.INICIADA,
      observacion: cabecera.rol === "afiliado" ? "Solicitud cargada por el afiliado" : `Solicitud cargada presencialmente por ${cabecera.rol}`,
    });

    // Avisar a la departamental que entró una solicitud nueva
    await notificarUsuariosDepartamental(connection, departamentalId, "COSEGURO_NUEVA",
      `Nueva solicitud de reintegro #${solicitudId}`,
      `${titular.apellido}, ${titular.nombre} cargó una solicitud de reintegro para revisar.`,
      { solicitud_id: solicitudId, estado_id: ESTADO.INICIADA });

    await connection.commit();

    // Constatación en ARCA en segundo plano (si la IA leyó el CAE del comprobante)
    void constatarArcaAutomatico(solicitudId);

    res.status(201).json({ success: true, id: solicitudId, message: "Solicitud de reintegro enviada correctamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al crear la solicitud de reintegro");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/solicitudes — tabla con filtros, paginado y orden
// ---------------------------------------------------------------------------
const COLUMNAS_ORDEN = {
  id: "s.id",
  fecha_creacion: "s.fecha_creacion",
  fecha_comprobante: "s.fecha_comprobante",
  afiliado: "u.apellido",
  departamental: "d.nombre",
  tipo_reintegro: "t.nombre",
  concepto: "c.nombre",
  importe: "s.importe",
  importe_autorizado: "s.importe_autorizado",
  estado: "e.orden",
};

router.get("/coseguro/solicitudes", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!["afiliado", ...ROLES_STAFF].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));
    const orderBy = COLUMNAS_ORDEN[req.query.orderBy] || "s.fecha_creacion";
    const orderType = String(req.query.orderType).toLowerCase() === "asc" ? "ASC" : "DESC";

    const condiciones = ["s.eliminado = 0"];
    const params = [];

    // Scope por rol
    if (cabecera.rol === "afiliado") {
      condiciones.push("s.usuario_id = ?");
      params.push(cabecera.id);
    } else if (cabecera.rol === "departamental") {
      condiciones.push("s.departamental_id = ?");
      params.push(cabecera.departamental_id);
    } else if (cabecera.rol === "auditor") {
      condiciones.push("s.estado_id IN (?, ?, ?, ?)");
      params.push(ESTADO.APROBADA_CENTRAL, ESTADO.EXPORTADO, ESTADO.PENDIENTE_ACREDITACION, ESTADO.LIQUIDADO);
    }

    if (req.query.estado_id) {
      const estados = String(req.query.estado_id).split(",").map((v) => Number(v)).filter((v) => v > 0);
      if (estados.length > 0) {
        condiciones.push(`s.estado_id IN (${estados.map(() => "?").join(",")})`);
        params.push(...estados);
      }
    }
    if (req.query.departamental_id && cabecera.rol !== "departamental" && cabecera.rol !== "afiliado") {
      condiciones.push("s.departamental_id = ?");
      params.push(Number(req.query.departamental_id));
    }
    if (req.query.tipo_reintegro_id) {
      condiciones.push("s.tipo_reintegro_id = ?");
      params.push(Number(req.query.tipo_reintegro_id));
    }
    if (req.query.concepto_id) {
      condiciones.push("s.concepto_id = ?");
      params.push(Number(req.query.concepto_id));
    }
    if (req.query.usuario_id && ROLES_STAFF.includes(cabecera.rol)) {
      condiciones.push("s.usuario_id = ?");
      params.push(Number(req.query.usuario_id));
    }
    const fechaDesde = normalizarFecha(req.query.fecha_desde);
    if (fechaDesde) {
      condiciones.push("s.fecha_comprobante >= ?");
      params.push(fechaDesde);
    }
    const fechaHasta = normalizarFecha(req.query.fecha_hasta);
    if (fechaHasta) {
      condiciones.push("s.fecha_comprobante <= ?");
      params.push(fechaHasta);
    }
    const solicitudDesde = normalizarFecha(req.query.fecha_solicitud_desde);
    if (solicitudDesde) {
      condiciones.push("DATE(s.fecha_creacion) >= ?");
      params.push(solicitudDesde);
    }
    const solicitudHasta = normalizarFecha(req.query.fecha_solicitud_hasta);
    if (solicitudHasta) {
      condiciones.push("DATE(s.fecha_creacion) <= ?");
      params.push(solicitudHasta);
    }
    // Misma semántica que la exportación: filtra por el importe efectivo (autorizado si existe)
    const importeMin = normalizarImporte(req.query.importe_min);
    if (importeMin !== null) {
      condiciones.push("COALESCE(s.importe_autorizado, s.importe) >= ?");
      params.push(importeMin);
    }
    const importeMax = normalizarImporte(req.query.importe_max);
    if (importeMax !== null) {
      condiciones.push("COALESCE(s.importe_autorizado, s.importe) <= ?");
      params.push(importeMax);
    }
    const search = normalizarTexto(req.query.search);
    if (search) {
      condiciones.push(`(CAST(s.id AS CHAR) LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ? OR CAST(u.documento AS CHAR) LIKE ?
        OR s.comprobante_numero LIKE ? OR s.emisor_nombre LIKE ? OR s.emisor_cuit LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like, like);
    }

    // Marca de posibles duplicados (mismo comprobante o mismo archivo en otra solicitud activa).
    // Misma semántica que buscarDuplicadosComprobante: mismo número y (mismo afiliado o mismo emisor,
    // tolerando cargas sin CUIT).
    const subqueryDuplicados = `(
      SELECT COUNT(DISTINCT s2.id) FROM coseguro_solicitud s2
      WHERE s2.id <> s.id AND s2.eliminado = 0 AND s2.estado_id NOT IN (${ESTADO.RECHAZADA_DEPTO}, ${ESTADO.CANCELADA})
        AND s2.comprobante_numero = s.comprobante_numero
        AND (s2.usuario_id = s.usuario_id OR s2.emisor_cuit = s.emisor_cuit OR s2.emisor_cuit IS NULL OR s.emisor_cuit IS NULL)
        AND (s2.comprobante_pto_venta = s.comprobante_pto_venta OR s2.comprobante_pto_venta IS NULL OR s.comprobante_pto_venta IS NULL)
    ) + (
      SELECT COUNT(DISTINCT a2.solicitud_id) FROM coseguro_archivo a1
      INNER JOIN coseguro_archivo a2 ON (a2.sha256 = a1.sha256 OR (a1.phash IS NOT NULL AND a2.phash = a1.phash)) AND a2.solicitud_id <> a1.solicitud_id
      INNER JOIN coseguro_solicitud s3 ON s3.id = a2.solicitud_id AND s3.eliminado = 0 AND s3.estado_id NOT IN (${ESTADO.RECHAZADA_DEPTO}, ${ESTADO.CANCELADA})
      WHERE a1.solicitud_id = s.id
    )`;

    if (String(req.query.con_duplicados) === "1") condiciones.push(`${subqueryDuplicados} > 0`);

    const where = condiciones.join(" AND ");
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM coseguro_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       LEFT JOIN departamental d ON d.id = s.departamental_id
       LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
       LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       WHERE ${where}`,
      params
    );
    const totalItems = Number(countRows[0].total);

    const [rows] = await db.query(
      `SELECT s.id, s.usuario_id, s.familiar_usuario_id, s.departamental_id, s.estado_id,
              s.tipo_reintegro_id, s.concepto_id, s.fecha_comprobante, s.comprobante_pto_venta,
              s.comprobante_numero, s.emisor_nombre, s.emisor_cuit, s.importe, s.importe_autorizado,
              s.cantidad_sesiones, s.cic_codigo, s.fecha_creacion, s.fecha_modificacion, s.fecha_pago,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
              fam.nombre AS familiar_nombre, fam.apellido AS familiar_apellido,
              d.nombre AS departamental_nombre,
              t.nombre AS tipo_reintegro, t.icono AS tipo_icono,
              c.nombre AS concepto,
              e.nombre AS estado, e.nombre_afiliado AS estado_nombre_afiliado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              JSON_UNQUOTE(JSON_EXTRACT(s.verificacion, '$.arca.resultado')) AS arca_resultado,
              ${subqueryDuplicados} AS posibles_duplicados
       FROM coseguro_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       LEFT JOIN usuario fam ON fam.id = s.familiar_usuario_id
       LEFT JOIN departamental d ON d.id = s.departamental_id
       LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
       LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       WHERE ${where}
       ORDER BY ${orderBy} ${orderType}, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    // Resumen por estado (para chips del listado) con el mismo scope pero sin filtro de estado
    const results = rows.map((row) => ({
      ...row,
      estado_visible: cabecera.rol === "afiliado" && row.estado_nombre_afiliado ? row.estado_nombre_afiliado : row.estado,
      puede_editar: puedeEditarSolicitud(cabecera, row),
      puede_eliminar: puedeEliminarSolicitud(cabecera, row),
      transiciones: transicionesDisponibles(cabecera.rol, row.estado_id, Number(row.usuario_id) === Number(cabecera.id)),
    }));

    res.status(200).json({ results, totalItems, page, pageSize });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las solicitudes de reintegro");
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/solicitudes/:id — detalle completo
// ---------------------------------------------------------------------------
router.get("/coseguro/solicitudes/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `SELECT s.*, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
              u.email AS afiliado_email, u.telefono AS afiliado_telefono,
              fam.nombre AS familiar_nombre, fam.apellido AS familiar_apellido, fam.documento AS familiar_documento,
              pfam.nombre AS familiar_parentesco,
              d.nombre AS departamental_nombre,
              t.nombre AS tipo_reintegro, t.icono AS tipo_icono, t.requiere_pto_venta,
              CAST(t.adjuntos_config AS CHAR) AS adjuntos_config,
              c.nombre AS concepto,
              e.nombre AS estado, e.nombre_afiliado AS estado_nombre_afiliado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              imp.codigo AS imputacion_codigo, imp.descripcion AS imputacion_descripcion,
              impd.descripcion AS imputacion_detalle_descripcion,
              creador.nombre AS creador_nombre, creador.apellido AS creador_apellido,
              aprdep.nombre AS aprobo_departamental_nombre, aprdep.apellido AS aprobo_departamental_apellido,
              aprcen.nombre AS aprobo_central_nombre, aprcen.apellido AS aprobo_central_apellido,
              CAST(s.extraccion_ia AS CHAR) AS extraccion_ia_str, CAST(s.verificacion AS CHAR) AS verificacion_str
       FROM coseguro_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       LEFT JOIN usuario fam ON fam.id = s.familiar_usuario_id
       LEFT JOIN parentesco pfam ON pfam.id = fam.parentesco_id
       LEFT JOIN departamental d ON d.id = s.departamental_id
       LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
       LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       LEFT JOIN coseguro_imputacion imp ON imp.id = s.imputacion_id
       LEFT JOIN coseguro_imputacion impd ON impd.id = s.imputacion_detalle_id
       LEFT JOIN usuario creador ON creador.id = s.creado_por_usuario_id
       LEFT JOIN usuario aprdep ON aprdep.id = s.aprobado_departamental_usuario_id
       LEFT JOIN usuario aprcen ON aprcen.id = s.aprobado_central_usuario_id
       WHERE s.id = ? AND s.eliminado = 0`,
      [solicitudId]
    );
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeVerSolicitud(cabecera, solicitud)) return res.status(401).json("No autorizado");

    const [archivos] = await db.query(
      "SELECT id, tipo_adjunto, archivo, nombre_original, mime, tamanio, sha256, phash, fecha_creacion FROM coseguro_archivo WHERE solicitud_id = ? ORDER BY id",
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
       FROM coseguro_observacion o
       LEFT JOIN usuario u ON u.id = o.usuario_id
       LEFT JOIN coseguro_estado e ON e.id = o.estado_id
       WHERE o.solicitud_id = ?
       ORDER BY o.fecha_creacion ASC, o.id ASC`,
      [solicitudId]
    );

    let historial = [];
    if (ROLES_STAFF.includes(cabecera.rol)) {
      const [hist] = await db.query(
        `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
                ea.nombre AS estado_anterior, en.nombre AS estado_nuevo
         FROM coseguro_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
         LEFT JOIN coseguro_estado ea ON ea.id = h.estado_anterior_id
         LEFT JOIN coseguro_estado en ON en.id = h.estado_nuevo_id
         WHERE h.solicitud_id = ?
         ORDER BY h.fecha DESC, h.id DESC`,
        [solicitudId]
      );
      historial = hist;
    }

    // Duplicados potenciales para revisión rápida del staff
    let duplicados = { comprobantes: [], archivos: [] };
    if (ROLES_STAFF.includes(cabecera.rol)) {
      duplicados.comprobantes = await buscarDuplicadosComprobante(db, {
        emisor_cuit: solicitud.emisor_cuit,
        comprobante_pto_venta: solicitud.comprobante_pto_venta,
        comprobante_numero: solicitud.comprobante_numero,
        usuario_id: solicitud.usuario_id,
        excluirId: solicitudId,
      });
      duplicados.archivos = await buscarDuplicadosArchivo(
        db,
        archivos.map((a) => a.sha256).filter(Boolean),
        solicitudId,
        archivos.map((a) => parsearPhash(a.phash)).filter(Boolean)
      );
    }

    const firmaUrl = solicitud.firma_archivo ? await getSignedFileUrlFromS3(solicitud.firma_archivo).catch(() => null) : null;

    res.status(200).json({
      ...solicitud,
      adjuntos_config: parseJsonSeguro(solicitud.adjuntos_config) || [],
      extraccion_ia: parseJsonSeguro(solicitud.extraccion_ia_str),
      verificacion: parseJsonSeguro(solicitud.verificacion_str),
      extraccion_ia_str: undefined,
      verificacion_str: undefined,
      estado_visible: cabecera.rol === "afiliado" && solicitud.estado_nombre_afiliado ? solicitud.estado_nombre_afiliado : solicitud.estado,
      firma_url: firmaUrl,
      archivos: archivosFirmados,
      observaciones_hilo: observaciones,
      historial,
      duplicados,
      puede_editar: puedeEditarSolicitud(cabecera, solicitud),
      puede_eliminar: puedeEliminarSolicitud(cabecera, solicitud),
      transiciones: transicionesDisponibles(cabecera.rol, solicitud.estado_id, Number(solicitud.usuario_id) === Number(cabecera.id)),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener el detalle de la solicitud");
  }
});

// ---------------------------------------------------------------------------
// PUT /coseguro/solicitudes/:id — editar solicitud
// ---------------------------------------------------------------------------
const ETIQUETAS_CAMPOS = {
  tipo_reintegro_id: "Tipo de reintegro",
  concepto_id: "Concepto",
  fecha_comprobante: "Fecha del comprobante",
  comprobante_pto_venta: "Punto de venta",
  comprobante_numero: "Número de comprobante",
  emisor_nombre: "Emisor",
  emisor_cuit: "CUIT emisor",
  importe: "Importe",
  cuil_afiliado: "CUIL",
  cbu: "CBU",
  observaciones: "Observaciones",
  familiar_usuario_id: "Familiar a cargo (solicitante)",
  cantidad_sesiones: "Cantidad de sesiones",
  importe_autorizado: "Importe autorizado",
  imputacion_id: "Imputación",
  imputacion_detalle_id: "Detalle de imputación",
  cic_codigo: "C.I.C.",
  periodo_prestacion: "Período de la prestación",
};

router.put("/coseguro/solicitudes/:id", verifyToken, manejarUploadCoseguro, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeEditarSolicitud(cabecera, solicitud)) {
      return res.status(401).json("No tenés permisos para modificar esta solicitud en su estado actual");
    }

    const validacion = await validarDatosSolicitud(db, cabecera, req.body, {
      usuarioId: solicitud.usuario_id,
      fechaOriginal: solicitud.fecha_comprobante,
    });

    // Archivos: los requeridos deben quedar cubiertos entre los existentes (no eliminados) y los nuevos
    const eliminarIds = (parseJsonSeguro(req.body.archivos_eliminados) || []).map(Number).filter((n) => n > 0);
    const [archivosActuales] = await db.query("SELECT id, tipo_adjunto, sha256, archivo FROM coseguro_archivo WHERE solicitud_id = ?", [solicitudId]);
    const restantes = archivosActuales.filter((a) => !eliminarIds.includes(a.id));
    const slots = archivosPorSlot(req.files);
    if (validacion.tipo) {
      for (const adjunto of validacion.tipo.adjuntos_config) {
        const tieneExistente = restantes.some((a) => a.tipo_adjunto === adjunto.key);
        const tieneNuevo = slots.has(adjunto.key);
        if (Number(adjunto.requerido) === 1 && !tieneExistente && !tieneNuevo) {
          validacion.errores.push(`Falta adjuntar: ${adjunto.label}`);
        }
      }
    }
    if (restantes.length === 0 && (req.files || []).length === 0) validacion.errores.push("La solicitud debe conservar al menos un comprobante adjunto");

    if (validacion.errores.length > 0) return res.status(400).json(validacion.errores.join(" | "));

    const datos = validacion.datos;
    const forzarDuplicado = ROLES_GESTION.includes(cabecera.rol) && (String(req.body.forzar_duplicado) === "1" || req.body.forzar_duplicado === true);

    const duplicadosComprobante = await buscarDuplicadosComprobante(db, {
      emisor_cuit: datos.emisor_cuit,
      comprobante_pto_venta: datos.comprobante_pto_venta,
      comprobante_numero: datos.comprobante_numero,
      usuario_id: solicitud.usuario_id,
      excluirId: solicitudId,
    });
    if (duplicadosComprobante.length > 0 && !forzarDuplicado) {
      return res.status(409).json(
        `Ya existe otra solicitud con ese número de comprobante (solicitud #${duplicadosComprobante[0].id}, estado: ${duplicadosComprobante[0].estado}).`
      );
    }
    const preparacion = await prepararHashesArchivos(req.files);
    if (preparacion.repetidoInterno) {
      return res.status(400).json(
        "Subiste la misma imagen en dos casillas distintas (aunque esté rotada o espejada sigue siendo la misma)."
      );
    }
    const hashesNuevos = (req.files || []).map((f) => f.sha256Calculado);
    const phashSetsNuevos = (req.files || []).map((f) => f.phashes).filter(Boolean);
    const duplicadosArchivo = await buscarDuplicadosArchivo(db, hashesNuevos, solicitudId, phashSetsNuevos);
    if (duplicadosArchivo.length > 0 && !forzarDuplicado) {
      const dup = duplicadosArchivo[0];
      const detalle = dup.coincidencia === "imagen" ? " (la imagen coincide aunque esté rotada, espejada o recomprimida)" : "";
      return res.status(409).json(
        `Uno de los archivos adjuntos ya fue presentado en la solicitud #${dup.solicitud_id}${detalle}.`
      );
    }

    // Campos exclusivos de servicios sociales / admin
    const camposCentral = {};
    if (["admin-central", "admin"].includes(cabecera.rol)) {
      if (req.body.importe_autorizado !== undefined) camposCentral.importe_autorizado = normalizarImporte(req.body.importe_autorizado);
      if (req.body.imputacion_id !== undefined) camposCentral.imputacion_id = Number(req.body.imputacion_id) || null;
      if (req.body.imputacion_detalle_id !== undefined) camposCentral.imputacion_detalle_id = Number(req.body.imputacion_detalle_id) || null;
      if (req.body.periodo_prestacion !== undefined) {
        const periodo = String(req.body.periodo_prestacion || "").slice(0, 7);
        camposCentral.periodo_prestacion = /^\d{4}-\d{2}$/.test(periodo) ? periodo : null;
      }
      if (camposCentral.imputacion_id) {
        const [imps] = await db.query("SELECT codigo FROM coseguro_imputacion WHERE id = ? AND tipo = 'CUENTA'", [camposCentral.imputacion_id]);
        if (imps.length === 0) return res.status(400).json("Imputación inválida");
        camposCentral.cic_codigo = imps[0].codigo;
      } else if (camposCentral.imputacion_id === null && req.body.imputacion_id !== undefined) {
        camposCentral.cic_codigo = null;
      }
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Diff de campos para el historial
    const camposEditables = { ...datos };
    if (!("periodo_prestacion" in camposCentral)) {
      // si central no lo tocó, se mantiene el derivado de la fecha de comprobante
      camposEditables.periodo_prestacion = datos.periodo_prestacion;
    } else {
      delete camposEditables.periodo_prestacion;
    }
    const todosLosCampos = { ...camposEditables, ...camposCentral };
    const camposCambiados = new Set();
    for (const [campo, valorNuevo] of Object.entries(todosLosCampos)) {
      const valorAnterior = solicitud[campo];
      const anteriorNormalizado = valorAnterior instanceof Date ? moment(valorAnterior).format("YYYY-MM-DD") : valorAnterior;
      const iguales = String(anteriorNormalizado ?? "") === String(valorNuevo ?? "");
      if (!iguales) {
        camposCambiados.add(campo);
        await registrarHistorial(connection, {
          solicitud_id: solicitudId,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE",
          campo_modificado: ETIQUETAS_CAMPOS[campo] || campo,
          valor_anterior: anteriorNormalizado,
          valor_nuevo: valorNuevo,
        });
      }
    }

    // Si cambian los datos del comprobante, la constatación de ARCA guardada queda desactualizada
    const camposArca = ["emisor_cuit", "comprobante_pto_venta", "comprobante_numero", "fecha_comprobante", "importe"];
    const constatacionDesactualizada = camposArca.some((campo) => camposCambiados.has(campo));
    if (constatacionDesactualizada) {
      const verificacionActual = parseJsonSeguro(solicitud.verificacion) || {};
      if (verificacionActual.arca) {
        delete verificacionActual.arca;
        await connection.query("UPDATE coseguro_solicitud SET verificacion = ? WHERE id = ?", [
          JSON.stringify(verificacionActual),
          solicitudId,
        ]);
      }
    }

    const sets = [];
    const setParams = [];
    for (const [campo, valor] of Object.entries(todosLosCampos)) {
      sets.push(`${campo} = ?`);
      setParams.push(valor);
    }

    // Reenvío del afiliado: si estaba en "Revisar solicitud", pasa a "Solicitud revisada"
    let estadoNuevo = null;
    if (cabecera.rol === "afiliado" && solicitud.estado_id === ESTADO.REVISAR) {
      estadoNuevo = ESTADO.REVISADA;
      sets.push("estado_id = ?");
      setParams.push(estadoNuevo);
    }

    setParams.push(solicitudId);
    await connection.query(`UPDATE coseguro_solicitud SET ${sets.join(", ")} WHERE id = ?`, setParams);

    // Archivos eliminados
    for (const archivoId of eliminarIds) {
      const archivo = archivosActuales.find((a) => a.id === archivoId);
      if (!archivo) continue;
      await connection.query("DELETE FROM coseguro_archivo WHERE id = ? AND solicitud_id = ?", [archivoId, solicitudId]);
      await registrarHistorial(connection, {
        solicitud_id: solicitudId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE",
        campo_modificado: `Adjunto ${archivo.tipo_adjunto}`,
        valor_anterior: archivo.archivo,
        valor_nuevo: "(eliminado)",
      });
    }

    // Archivos nuevos
    for (const [slot, files] of slots.entries()) {
      for (const file of files) {
        const key = await subirArchivoCoseguro(file, `sol${solicitudId}_${slot.toLowerCase()}`);
        await connection.query(
          `INSERT INTO coseguro_archivo (solicitud_id, tipo_adjunto, archivo, nombre_original, mime, tamanio, sha256, phash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [solicitudId, slot, key, file.originalname || null, file.mimetype || null, file.size || null, file.sha256Calculado, file.phashes ? JSON.stringify(file.phashes) : null]
        );
        await registrarHistorial(connection, {
          solicitud_id: solicitudId,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE",
          campo_modificado: `Adjunto ${slot}`,
          valor_anterior: null,
          valor_nuevo: file.originalname || key,
        });
      }
    }

    // Firma nueva (opcional en edición)
    if (req.body.firma) {
      const firmaArchivo = await subirFirmaBase64(req.body.firma);
      if (firmaArchivo) {
        await connection.query("UPDATE coseguro_solicitud SET firma_archivo = ? WHERE id = ?", [firmaArchivo, solicitudId]);
      }
    }

    // Actualizar CUIL/CBU del afiliado
    await connection.query("UPDATE usuario SET cuil = ?, cbu = ? WHERE id = ?", [datos.cuil_afiliado, datos.cbu, solicitud.usuario_id]);

    if (estadoNuevo) {
      const mensajeRevision = normalizarTexto(req.body.mensaje_revision);
      await registrarHistorial(connection, {
        solicitud_id: solicitudId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "CAMBIO_ESTADO",
        estado_anterior_id: solicitud.estado_id,
        estado_nuevo_id: estadoNuevo,
        observacion: mensajeRevision || "El afiliado reenvió la solicitud corregida",
      });
      if (mensajeRevision) {
        await connection.query(
          "INSERT INTO coseguro_observacion (solicitud_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
          [solicitudId, cabecera.id, cabecera.rol, mensajeRevision, estadoNuevo]
        );
      }
      await notificarUsuariosDepartamental(connection, solicitud.departamental_id, "COSEGURO_REVISADA",
        `Solicitud de reintegro #${solicitudId} revisada`,
        `El afiliado corrigió y reenvió la solicitud #${solicitudId}.${mensajeRevision ? " Mensaje: " + mensajeRevision : ""}`,
        { solicitud_id: solicitudId, estado_id: estadoNuevo });
    }

    await connection.commit();

    // Re-constatar en ARCA en segundo plano si cambiaron los datos del comprobante
    if (constatacionDesactualizada) void constatarArcaAutomatico(solicitudId);

    res.status(200).json({ success: true, message: "Solicitud actualizada correctamente", estado_id: estadoNuevo || solicitud.estado_id });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al actualizar la solicitud");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// DELETE /coseguro/solicitudes/:id — eliminar (soft delete, antes de aprobación central)
// ---------------------------------------------------------------------------
router.delete("/coseguro/solicitudes/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeEliminarSolicitud(cabecera, solicitud)) {
      return res.status(401).json("No se puede eliminar esta solicitud (ya pasó a la instancia de aprobación central o no tenés permisos)");
    }

    await db.query(
      "UPDATE coseguro_solicitud SET eliminado = 1, eliminado_usuario_id = ?, fecha_eliminacion = NOW() WHERE id = ?",
      [cabecera.id, solicitudId]
    );
    await registrarHistorial(db, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE",
      observacion: normalizarTexto(req.body?.motivo) || "Solicitud eliminada",
    });
    res.status(200).json({ success: true, message: "Solicitud eliminada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al eliminar la solicitud");
  }
});

// ---------------------------------------------------------------------------
// PUT /coseguro/solicitudes/:id/estado — cambio de estado con observación
// ---------------------------------------------------------------------------
router.put("/coseguro/solicitudes/:id/estado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    const estadoNuevo = Number(req.body.estado_id);
    const observacion = normalizarTexto(req.body.observacion);
    if (!solicitudId || !estadoNuevo) return res.status(400).json("Datos inválidos");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeVerSolicitud(cabecera, solicitud)) return res.status(401).json("No autorizado");

    const esPropia = Number(solicitud.usuario_id) === Number(cabecera.id);
    const permitidas = transicionesDisponibles(cabecera.rol, solicitud.estado_id, esPropia);
    if (!permitidas.includes(estadoNuevo)) {
      return res.status(400).json("Transición de estado no permitida para tu rol en el estado actual");
    }
    // Al pedir revisión o rechazar, la observación es obligatoria para que el afiliado sepa qué pasó
    if ([ESTADO.REVISAR, ESTADO.RECHAZADA_DEPTO].includes(estadoNuevo) && !observacion) {
      return res.status(400).json("Ingresá una observación para el afiliado explicando el motivo");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const sets = ["estado_id = ?"];
    const params = [estadoNuevo];
    if (estadoNuevo === ESTADO.APROBADA_DEPTO) {
      sets.push("fecha_aprobacion_departamental = NOW()", "aprobado_departamental_usuario_id = ?");
      params.push(cabecera.id);
    }
    if (estadoNuevo === ESTADO.APROBADA_CENTRAL) {
      sets.push("fecha_aprobacion_central = NOW()", "aprobado_central_usuario_id = ?");
      params.push(cabecera.id);
    }
    if (estadoNuevo === ESTADO.LIQUIDADO) {
      const fechaPago = parsearFechaFlexible(req.body.fecha_pago) || moment().format("YYYY-MM-DD HH:mm:ss");
      sets.push("fecha_pago = ?");
      params.push(fechaPago);
    }
    params.push(solicitudId);
    await connection.query(`UPDATE coseguro_solicitud SET ${sets.join(", ")} WHERE id = ?`, params);

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
        "INSERT INTO coseguro_observacion (solicitud_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
        [solicitudId, cabecera.id, cabecera.rol, observacion, estadoNuevo]
      );
    }

    // Notificaciones
    if (cabecera.rol === "afiliado" && estadoNuevo === ESTADO.CANCELADA) {
      await notificarUsuariosDepartamental(connection, solicitud.departamental_id, "COSEGURO_CANCELADA",
        `Solicitud de reintegro #${solicitudId} cancelada`,
        `El afiliado canceló la solicitud #${solicitudId}.${observacion ? " Motivo: " + observacion : ""}`,
        { solicitud_id: solicitudId, estado_id: estadoNuevo });
    } else {
      await notificarCambioEstadoAfiliado(connection, solicitud, solicitud.estado_id, estadoNuevo, observacion);
    }
    if (estadoNuevo === ESTADO.APROBADA_DEPTO) {
      await notificarUsuariosPorRol(connection, "admin-central", "COSEGURO_PARA_CONTROL",
        `Solicitud #${solicitudId} aprobada por departamental`,
        `La solicitud de reintegro #${solicitudId} quedó lista para el control de Servicios Sociales.`,
        { solicitud_id: solicitudId, estado_id: estadoNuevo });
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Estado actualizado correctamente", estado_id: estadoNuevo });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al cambiar el estado de la solicitud");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// POST /coseguro/solicitudes/:id/observaciones — hilo de observaciones
// ---------------------------------------------------------------------------
router.post("/coseguro/solicitudes/:id/observaciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!solicitudId || !mensaje) return res.status(400).json("El mensaje es obligatorio");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeVerSolicitud(cabecera, solicitud)) return res.status(401).json("No autorizado");

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Si el afiliado responde estando en "Revisar solicitud" y marca reenviar, pasa a "Solicitud revisada"
    let estadoNuevo = null;
    if (cabecera.rol === "afiliado" && solicitud.estado_id === ESTADO.REVISAR &&
        (String(req.body.reenviar) === "1" || req.body.reenviar === true)) {
      estadoNuevo = ESTADO.REVISADA;
      await connection.query("UPDATE coseguro_solicitud SET estado_id = ? WHERE id = ?", [estadoNuevo, solicitudId]);
      await registrarHistorial(connection, {
        solicitud_id: solicitudId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "CAMBIO_ESTADO",
        estado_anterior_id: solicitud.estado_id,
        estado_nuevo_id: estadoNuevo,
        observacion: mensaje,
      });
    }

    await connection.query(
      "INSERT INTO coseguro_observacion (solicitud_id, usuario_id, usuario_rol, mensaje, estado_id) VALUES (?, ?, ?, ?, ?)",
      [solicitudId, cabecera.id, cabecera.rol, mensaje, estadoNuevo || solicitud.estado_id]
    );
    await registrarHistorial(connection, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "OBSERVACION",
      observacion: mensaje,
    });

    if (cabecera.rol === "afiliado") {
      await notificarUsuariosDepartamental(connection, solicitud.departamental_id,
        estadoNuevo ? "COSEGURO_REVISADA" : "COSEGURO_OBSERVACION",
        estadoNuevo ? `Solicitud de reintegro #${solicitudId} revisada` : `Nueva observación en la solicitud #${solicitudId}`,
        `El afiliado escribió: ${mensaje}`,
        { solicitud_id: solicitudId, estado_id: estadoNuevo || solicitud.estado_id });
    } else {
      await insertarNotificacion(connection, solicitud.usuario_id, "COSEGURO_OBSERVACION",
        `Nueva observación en tu solicitud #${solicitudId}`,
        mensaje,
        { solicitud_id: solicitudId, estado_id: solicitud.estado_id });
    }

    await connection.commit();
    res.status(201).json({ success: true, message: "Observación registrada", estado_id: estadoNuevo || solicitud.estado_id });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al registrar la observación");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/archivos/:id/descargar — descarga individual (stream)
// ---------------------------------------------------------------------------
router.get("/coseguro/archivos/:id/descargar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const archivoId = Number(req.params.id);
    if (!archivoId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `SELECT a.*, s.usuario_id, s.departamental_id, s.estado_id
       FROM coseguro_archivo a INNER JOIN coseguro_solicitud s ON s.id = a.solicitud_id
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

// ---------------------------------------------------------------------------
// GET /coseguro/solicitudes/:id/zip — todos los adjuntos en un ZIP
// ---------------------------------------------------------------------------
router.get("/coseguro/solicitudes/:id/zip", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    if (!puedeVerSolicitud(cabecera, rows[0])) return res.status(401).json("No autorizado");

    const [archivos] = await db.query("SELECT * FROM coseguro_archivo WHERE solicitud_id = ? ORDER BY id", [solicitudId]);
    if (archivos.length === 0 && !rows[0].firma_archivo) return res.status(404).json("La solicitud no tiene archivos adjuntos");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="reintegro_${solicitudId}_adjuntos.zip"`);

    const zip = archiver("zip", { zlib: { level: 6 } });
    zip.on("error", (err) => {
      console.log(err);
      res.destroy();
    });
    zip.pipe(res);

    let indice = 0;
    for (const archivo of archivos) {
      const objeto = await getObjectBufferFromS3(archivo.archivo).catch(() => null);
      if (!objeto) continue;
      indice += 1;
      const extension = archivo.archivo.split(".").pop();
      const nombre = `${String(indice).padStart(2, "0")}_${archivo.tipo_adjunto}.${extension}`;
      zip.append(objeto.buffer, { name: nombre });
    }
    if (rows[0].firma_archivo) {
      const firma = await getObjectBufferFromS3(rows[0].firma_archivo).catch(() => null);
      if (firma) zip.append(firma.buffer, { name: "firma.png" });
    }
    await zip.finalize();
  } catch (error) {
    console.log(error);
    if (!res.headersSent) res.status(500).json("Error al generar el ZIP");
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/afiliado/:usuarioId/historial — historial rápido del afiliado (staff)
// para detectar solicitudes repetidas de un vistazo
// ---------------------------------------------------------------------------
router.get("/coseguro/afiliado/:usuarioId/historial", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    // El auditor no participa de la revisión de duplicados: no accede al historial completo del afiliado
    if (!ROLES_GESTION.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const usuarioId = Number(req.params.usuarioId);
    if (!usuarioId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();

    if (cabecera.rol === "departamental") {
      const [usuarios] = await db.query("SELECT departamental_id FROM usuario WHERE id = ?", [usuarioId]);
      if (usuarios.length === 0) return res.status(404).json("Afiliado no encontrado");
      if (usuarios[0].departamental_id !== null && Number(usuarios[0].departamental_id) !== Number(cabecera.departamental_id)) {
        return res.status(401).json("No autorizado");
      }
    }

    const [solicitudes] = await db.query(
      `SELECT s.id, s.estado_id, s.tipo_reintegro_id, s.concepto_id, s.fecha_comprobante,
              s.comprobante_pto_venta, s.comprobante_numero, s.emisor_nombre, s.emisor_cuit,
              s.importe, s.importe_autorizado, s.cantidad_sesiones, s.fecha_creacion, s.fecha_pago, s.eliminado,
              t.nombre AS tipo_reintegro, c.nombre AS concepto,
              e.nombre AS estado, e.color AS estado_color, e.color_texto AS estado_color_texto,
              fam.nombre AS familiar_nombre, fam.apellido AS familiar_apellido
       FROM coseguro_solicitud s
       LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
       LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       LEFT JOIN usuario fam ON fam.id = s.familiar_usuario_id
       WHERE s.usuario_id = ?
       ORDER BY s.fecha_creacion DESC`,
      [usuarioId]
    );

    // Detectar repetidos dentro del propio historial (mismo comprobante o misma fecha+importe+emisor)
    const grupos = new Map();
    for (const s of solicitudes) {
      if (s.eliminado) continue;
      const claves = [];
      if (s.comprobante_numero) claves.push(`nro:${s.emisor_cuit || ""}|${s.comprobante_pto_venta || ""}|${s.comprobante_numero}`);
      claves.push(`imp:${moment(s.fecha_comprobante).format("YYYY-MM-DD")}|${s.importe}|${(s.emisor_nombre || "").toLowerCase().trim()}`);
      for (const clave of claves) {
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(s.id);
      }
    }
    const repetidos = new Set();
    for (const ids of grupos.values()) {
      if (ids.length > 1) ids.forEach((id) => repetidos.add(id));
    }

    const [usuario] = await db.query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.cuil, u.cbu, d.nombre AS departamental_nombre
       FROM usuario u LEFT JOIN departamental d ON d.id = u.departamental_id WHERE u.id = ?`,
      [usuarioId]
    );

    res.status(200).json({
      usuario: usuario[0] || null,
      solicitudes: solicitudes.map((s) => ({ ...s, posible_repetida: repetidos.has(s.id) })),
      total: solicitudes.filter((s) => !s.eliminado).length,
      con_repetidos: repetidos.size > 0,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener el historial del afiliado");
  }
});

// ---------------------------------------------------------------------------
// Exportación CSV para Tesorería (auditor)
// ---------------------------------------------------------------------------
function csvEscape(valor) {
  if (valor === null || valor === undefined) return "";
  const texto = String(valor);
  if (/[;"\r\n]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

function formatearImporteCsv(valor) {
  if (valor === null || valor === undefined) return "";
  return Number(valor).toFixed(2).replace(".", ",");
}

const ESTADOS_VISIBLES_AUDITOR = [ESTADO.APROBADA_CENTRAL, ESTADO.EXPORTADO, ESTADO.PENDIENTE_ACREDITACION, ESTADO.LIQUIDADO];

async function consultarSolicitudesParaExportar(db, cabecera, filtros) {
  const condiciones = ["s.eliminado = 0"];
  const params = [];
  let estados = Array.isArray(filtros.estado_id) && filtros.estado_id.length > 0
    ? filtros.estado_id.map(Number).filter((n) => n > 0)
    : [ESTADO.APROBADA_CENTRAL];
  // El auditor solo puede ver/exportar a partir de "Aprobado por servicios sociales"
  if (cabecera.rol === "auditor") {
    estados = estados.filter((estado) => ESTADOS_VISIBLES_AUDITOR.includes(estado));
    if (estados.length === 0) estados = [ESTADO.APROBADA_CENTRAL];
  }
  condiciones.push(`s.estado_id IN (${estados.map(() => "?").join(",")})`);
  params.push(...estados);

  if (cabecera.rol === "departamental") {
    condiciones.push("s.departamental_id = ?");
    params.push(cabecera.departamental_id);
  } else if (filtros.departamental_id) {
    condiciones.push("s.departamental_id = ?");
    params.push(Number(filtros.departamental_id));
  }
  if (filtros.usuario_id) {
    condiciones.push("s.usuario_id = ?");
    params.push(Number(filtros.usuario_id));
  }
  const search = normalizarTexto(filtros.search);
  if (search) {
    condiciones.push(`(CAST(s.id AS CHAR) LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ? OR CAST(u.documento AS CHAR) LIKE ?
      OR s.comprobante_numero LIKE ? OR s.emisor_nombre LIKE ? OR s.emisor_cuit LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (filtros.tipo_reintegro_id) {
    condiciones.push("s.tipo_reintegro_id = ?");
    params.push(Number(filtros.tipo_reintegro_id));
  }
  if (filtros.concepto_id) {
    condiciones.push("s.concepto_id = ?");
    params.push(Number(filtros.concepto_id));
  }
  const fechaDesde = normalizarFecha(filtros.fecha_desde);
  if (fechaDesde) {
    condiciones.push("s.fecha_comprobante >= ?");
    params.push(fechaDesde);
  }
  const fechaHasta = normalizarFecha(filtros.fecha_hasta);
  if (fechaHasta) {
    condiciones.push("s.fecha_comprobante <= ?");
    params.push(fechaHasta);
  }
  const importeMin = normalizarImporte(filtros.importe_min);
  if (importeMin !== null) {
    condiciones.push("COALESCE(s.importe_autorizado, s.importe) >= ?");
    params.push(importeMin);
  }
  const importeMax = normalizarImporte(filtros.importe_max);
  if (importeMax !== null) {
    condiciones.push("COALESCE(s.importe_autorizado, s.importe) <= ?");
    params.push(importeMax);
  }
  if (Array.isArray(filtros.ids) && filtros.ids.length > 0) {
    const ids = filtros.ids.map(Number).filter((n) => n > 0);
    condiciones.push(`s.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (String(filtros.con_duplicados) === "1" || filtros.con_duplicados === true) {
    condiciones.push(`((
      SELECT COUNT(DISTINCT s2.id) FROM coseguro_solicitud s2
      WHERE s2.id <> s.id AND s2.eliminado = 0 AND s2.estado_id NOT IN (${ESTADO.RECHAZADA_DEPTO}, ${ESTADO.CANCELADA})
        AND s2.comprobante_numero = s.comprobante_numero
        AND (s2.usuario_id = s.usuario_id OR s2.emisor_cuit = s.emisor_cuit OR s2.emisor_cuit IS NULL OR s.emisor_cuit IS NULL)
        AND (s2.comprobante_pto_venta = s.comprobante_pto_venta OR s2.comprobante_pto_venta IS NULL OR s.comprobante_pto_venta IS NULL)
    ) + (
      SELECT COUNT(DISTINCT a2.solicitud_id) FROM coseguro_archivo a1
      INNER JOIN coseguro_archivo a2 ON (a2.sha256 = a1.sha256 OR (a1.phash IS NOT NULL AND a2.phash = a1.phash)) AND a2.solicitud_id <> a1.solicitud_id
      INNER JOIN coseguro_solicitud s3 ON s3.id = a2.solicitud_id AND s3.eliminado = 0 AND s3.estado_id NOT IN (${ESTADO.RECHAZADA_DEPTO}, ${ESTADO.CANCELADA})
      WHERE a1.solicitud_id = s.id
    )) > 0`);
  }

  const [rows] = await db.query(
    `SELECT s.id, s.fecha_creacion, s.fecha_comprobante, s.comprobante_pto_venta, s.comprobante_numero,
            s.emisor_nombre, s.emisor_cuit, s.importe, s.importe_autorizado, s.cuil_afiliado, s.cbu,
            s.cantidad_sesiones, s.cic_codigo, s.observaciones, s.estado_id, s.periodo_prestacion,
            s.fecha_aprobacion_departamental, s.fecha_aprobacion_central, s.fecha_exportacion, s.fecha_pago,
            u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
            fam.nombre AS familiar_nombre, fam.apellido AS familiar_apellido, fam.documento AS familiar_documento,
            d.nombre AS departamental_nombre, t.nombre AS tipo_reintegro, c.nombre AS concepto,
            e.nombre AS estado, imp.descripcion AS imputacion, impd.descripcion AS imputacion_detalle
     FROM coseguro_solicitud s
     INNER JOIN usuario u ON u.id = s.usuario_id
     LEFT JOIN usuario fam ON fam.id = s.familiar_usuario_id
     LEFT JOIN departamental d ON d.id = s.departamental_id
     LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
     LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id
     INNER JOIN coseguro_estado e ON e.id = s.estado_id
     LEFT JOIN coseguro_imputacion imp ON imp.id = s.imputacion_id
     LEFT JOIN coseguro_imputacion impd ON impd.id = s.imputacion_detalle_id
     WHERE ${condiciones.join(" AND ")}
     ORDER BY s.id`,
    params
  );
  return rows;
}

function generarCsvSolicitudes(rows) {
  const encabezados = [
    "ID", "Fecha solicitud", "Departamental", "Afiliado", "DNI afiliado", "CUIL", "CBU",
    "Solicitante", "DNI solicitante", "Tipo de reintegro", "Concepto", "Fecha comprobante",
    "Punto de venta", "Numero comprobante", "Emisor", "CUIT emisor", "Importe", "Importe autorizado",
    "C.I.C.", "Imputacion", "Detalle imputacion", "Cantidad sesiones", "Periodo", "Estado",
    "Fecha aprobacion departamental", "Fecha aprobacion central", "Fecha exportacion", "Fecha de pago", "Observaciones",
  ];
  const lineas = [encabezados.join(";")];
  for (const r of rows) {
    const solicitante = r.familiar_nombre ? `${r.familiar_apellido}, ${r.familiar_nombre}` : `${r.afiliado_apellido}, ${r.afiliado_nombre} (titular)`;
    const dniSolicitante = r.familiar_nombre ? r.familiar_documento : r.afiliado_documento;
    lineas.push([
      r.id,
      r.fecha_creacion ? moment(r.fecha_creacion).format("DD/MM/YYYY HH:mm") : "",
      csvEscape(r.departamental_nombre),
      csvEscape(`${r.afiliado_apellido}, ${r.afiliado_nombre}`),
      r.afiliado_documento || "",
      r.cuil_afiliado || "",
      r.cbu || "",
      csvEscape(solicitante),
      dniSolicitante || "",
      csvEscape(r.tipo_reintegro),
      csvEscape(r.concepto),
      r.fecha_comprobante ? moment(r.fecha_comprobante).format("DD/MM/YYYY") : "",
      r.comprobante_pto_venta || "",
      r.comprobante_numero || "",
      csvEscape(r.emisor_nombre),
      r.emisor_cuit || "",
      formatearImporteCsv(r.importe),
      formatearImporteCsv(r.importe_autorizado),
      r.cic_codigo || "",
      csvEscape(r.imputacion),
      csvEscape(r.imputacion_detalle),
      r.cantidad_sesiones || "",
      r.periodo_prestacion || "",
      csvEscape(r.estado),
      r.fecha_aprobacion_departamental ? moment(r.fecha_aprobacion_departamental).format("DD/MM/YYYY HH:mm") : "",
      r.fecha_aprobacion_central ? moment(r.fecha_aprobacion_central).format("DD/MM/YYYY HH:mm") : "",
      r.fecha_exportacion ? moment(r.fecha_exportacion).format("DD/MM/YYYY HH:mm") : "",
      r.fecha_pago ? moment(r.fecha_pago).format("DD/MM/YYYY HH:mm") : "",
      csvEscape(r.observaciones),
    ].join(";"));
  }
  return "﻿" + lineas.join("\r\n");
}

// POST /coseguro/exportar — genera el CSV (auditor y admin). No cambia estados.
router.post("/coseguro/exportar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!["auditor", "admin", "admin-central"].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const rows = await consultarSolicitudesParaExportar(db, cabecera, req.body || {});
    if (rows.length === 0) return res.status(404).json("No hay solicitudes para exportar con esos filtros");

    const csv = generarCsvSolicitudes(rows);
    res.status(200).json({
      csv,
      ids: rows.map((r) => r.id),
      // Solo se ofrece cambiar de estado las que están en "Aprobado por servicios sociales"
      ids_exportables: rows.filter((r) => r.estado_id === ESTADO.APROBADA_CENTRAL).map((r) => r.id),
      total: rows.length,
      nombre_archivo: `reintegros_para_liquidar_${moment().format("YYYYMMDD_HHmm")}.csv`,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al generar la exportación");
  }
});

// POST /coseguro/exportar/confirmar — marca las solicitudes como "Exportado para liquidar"
router.post("/coseguro/exportar/confirmar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!["auditor", "admin"].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => n > 0);
    if (ids.length === 0) return res.status(400).json("No se indicaron solicitudes");

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT id, usuario_id, estado_id FROM coseguro_solicitud
       WHERE id IN (${ids.map(() => "?").join(",")}) AND eliminado = 0 AND estado_id = ? FOR UPDATE`,
      [...ids, ESTADO.APROBADA_CENTRAL]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(400).json("Ninguna de las solicitudes está en estado 'Aprobado por servicios sociales'");
    }

    const idsValidos = rows.map((r) => r.id);
    await connection.query(
      `UPDATE coseguro_solicitud SET estado_id = ?, fecha_exportacion = NOW(), exportado_usuario_id = ?
       WHERE id IN (${idsValidos.map(() => "?").join(",")})`,
      [ESTADO.EXPORTADO, cabecera.id, ...idsValidos]
    );
    for (const solicitud of rows) {
      await registrarHistorial(connection, {
        solicitud_id: solicitud.id,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "EXPORT",
        estado_anterior_id: solicitud.estado_id,
        estado_nuevo_id: ESTADO.EXPORTADO,
        observacion: "Exportado en CSV para Tesorería",
      });
      await notificarCambioEstadoAfiliado(connection, solicitud, solicitud.estado_id, ESTADO.EXPORTADO, null);
    }

    await connection.commit();
    res.status(200).json({ success: true, message: `${idsValidos.length} solicitudes marcadas como "Exportado para liquidar"`, ids: idsValidos });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al confirmar la exportación");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// POST /coseguro/estado-masivo — marcar varias como "Pendiente de acreditación"
// ---------------------------------------------------------------------------
router.post("/coseguro/estado-masivo", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!["admin", "admin-central", "auditor"].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => n > 0);
    const estadoNuevo = Number(req.body.estado_id);
    if (ids.length === 0) return res.status(400).json("No se indicaron solicitudes");
    if (estadoNuevo !== ESTADO.PENDIENTE_ACREDITACION) return res.status(400).json("Este endpoint solo permite pasar a 'Pendiente de acreditación'");

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT id, usuario_id, estado_id FROM coseguro_solicitud
       WHERE id IN (${ids.map(() => "?").join(",")}) AND eliminado = 0 AND estado_id IN (?, ?) FOR UPDATE`,
      [...ids, ESTADO.APROBADA_CENTRAL, ESTADO.EXPORTADO]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(400).json("Ninguna solicitud está en un estado válido para pasar a 'Pendiente de acreditación'");
    }
    const idsValidos = rows.map((r) => r.id);
    await connection.query(
      `UPDATE coseguro_solicitud SET estado_id = ? WHERE id IN (${idsValidos.map(() => "?").join(",")})`,
      [ESTADO.PENDIENTE_ACREDITACION, ...idsValidos]
    );
    for (const solicitud of rows) {
      await registrarHistorial(connection, {
        solicitud_id: solicitud.id,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "CAMBIO_ESTADO",
        estado_anterior_id: solicitud.estado_id,
        estado_nuevo_id: ESTADO.PENDIENTE_ACREDITACION,
      });
      await notificarCambioEstadoAfiliado(connection, solicitud, solicitud.estado_id, ESTADO.PENDIENTE_ACREDITACION, null);
    }
    await connection.commit();
    res.status(200).json({ success: true, message: `${idsValidos.length} solicitudes pasaron a "Pendiente de acreditación"`, ids: idsValidos });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al actualizar los estados");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// Liquidación: el auditor sube el CSV del banco con los IDs acreditados + fecha/hora
// ---------------------------------------------------------------------------
function parsearCsvLiquidacion(buffer) {
  const texto = buffer.toString("utf8").replace(/^﻿/, "");
  const lineas = texto.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const items = [];
  const erroresParseo = [];
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const separador = linea.includes(";") ? ";" : linea.includes("\t") ? "\t" : ",";
    const celdas = linea.split(separador).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    const id = Number(celdas[0]);
    if (!Number.isInteger(id) || id <= 0) {
      // probablemente la fila de encabezados
      if (i === 0) continue;
      erroresParseo.push({ linea: i + 1, contenido: linea, motivo: "El ID no es un número válido" });
      continue;
    }
    // la fecha puede venir en una celda ("07/07/2026 14:30") o en dos separadas (fecha ; hora)
    let fecha = null;
    if (celdas.length >= 3 && celdas[1] && celdas[2] && !celdas[1].includes(":") && /^\d{1,2}:\d{2}/.test(celdas[2])) {
      fecha = parsearFechaFlexible(`${celdas[1]} ${celdas[2]}`);
    }
    if (!fecha && celdas[1]) fecha = parsearFechaFlexible(celdas[1]);
    if (!fecha) {
      for (let j = 2; j < celdas.length && !fecha; j++) fecha = parsearFechaFlexible(celdas[j]);
    }
    if (!fecha) {
      erroresParseo.push({ linea: i + 1, contenido: linea, motivo: "No se pudo interpretar la fecha/hora de acreditación" });
      continue;
    }
    items.push({ id, fecha_pago: fecha });
  }
  return { items, errores: erroresParseo };
}

// POST /coseguro/liquidacion/analizar — vista previa del CSV (sin aplicar cambios)
router.post("/coseguro/liquidacion/analizar", verifyToken, manejarUploadCsv, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!["auditor", "admin"].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const file = (req.files || [])[0];
    if (!file) return res.status(400).json("Subí el archivo CSV con los IDs acreditados");

    const { items, errores } = parsearCsvLiquidacion(file.buffer);
    if (items.length === 0) {
      return res.status(400).json("El archivo no contiene filas válidas (se espera: ID; fecha y hora de acreditación)");
    }

    const db = mysqlConnection.promise();
    const ids = items.map((i) => i.id);
    const [rows] = await db.query(
      `SELECT s.id, s.estado_id, e.nombre AS estado, s.importe_autorizado, s.importe,
              CONCAT(u.apellido, ', ', u.nombre) AS afiliado
       FROM coseguro_solicitud s
       INNER JOIN usuario u ON u.id = s.usuario_id
       INNER JOIN coseguro_estado e ON e.id = s.estado_id
       WHERE s.id IN (${ids.map(() => "?").join(",")}) AND s.eliminado = 0`,
      ids
    );
    const porId = new Map(rows.map((r) => [r.id, r]));

    const preview = items.map((item) => {
      const solicitud = porId.get(item.id);
      let situacion = "OK";
      let detalle = "";
      if (!solicitud) {
        situacion = "NO_ENCONTRADA";
        detalle = "No existe una solicitud con ese ID";
      } else if (![ESTADO.EXPORTADO, ESTADO.PENDIENTE_ACREDITACION].includes(solicitud.estado_id)) {
        situacion = "ESTADO_INVALIDO";
        detalle = `Estado actual: ${solicitud.estado}`;
      }
      return {
        id: item.id,
        fecha_pago: item.fecha_pago,
        situacion,
        detalle,
        afiliado: solicitud?.afiliado || null,
        estado_actual: solicitud?.estado || null,
        importe: solicitud ? solicitud.importe_autorizado || solicitud.importe : null,
      };
    });

    res.status(200).json({
      preview,
      errores_archivo: errores,
      total: items.length,
      aplicables: preview.filter((p) => p.situacion === "OK").length,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al analizar el archivo de liquidación");
  }
});

// POST /coseguro/liquidacion/confirmar — aplica: estado Liquidado + fecha de pago
router.post("/coseguro/liquidacion/confirmar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!["auditor", "admin"].includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const items = (Array.isArray(req.body.items) ? req.body.items : [])
      .map((i) => ({ id: Number(i.id), fecha_pago: parsearFechaFlexible(i.fecha_pago) }))
      .filter((i) => i.id > 0 && i.fecha_pago);
    if (items.length === 0) return res.status(400).json("No hay solicitudes válidas para liquidar");

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();

    const ids = items.map((i) => i.id);
    const [rows] = await connection.query(
      `SELECT id, usuario_id, estado_id FROM coseguro_solicitud
       WHERE id IN (${ids.map(() => "?").join(",")}) AND eliminado = 0 AND estado_id IN (?, ?) FOR UPDATE`,
      [...ids, ESTADO.EXPORTADO, ESTADO.PENDIENTE_ACREDITACION]
    );
    const porId = new Map(rows.map((r) => [r.id, r]));
    let aplicadas = 0;
    for (const item of items) {
      const solicitud = porId.get(item.id);
      if (!solicitud) continue;
      await connection.query(
        "UPDATE coseguro_solicitud SET estado_id = ?, fecha_pago = ? WHERE id = ?",
        [ESTADO.LIQUIDADO, item.fecha_pago, item.id]
      );
      await registrarHistorial(connection, {
        solicitud_id: item.id,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "LIQUIDACION",
        estado_anterior_id: solicitud.estado_id,
        estado_nuevo_id: ESTADO.LIQUIDADO,
        observacion: `Acreditación bancaria confirmada el ${moment(item.fecha_pago).format("DD/MM/YYYY HH:mm")}`,
      });
      await insertarNotificacion(connection, solicitud.usuario_id, "COSEGURO_ESTADO",
        `Tu reintegro #${item.id} fue liquidado`,
        `El pago ya fue acreditado en tu cuenta el ${moment(item.fecha_pago).format("DD/MM/YYYY HH:mm")}.`,
        { solicitud_id: item.id, estado_id: ESTADO.LIQUIDADO, estado_nombre: "Liquidado" });
      aplicadas += 1;
    }
    if (aplicadas === 0) {
      await connection.rollback();
      return res.status(400).json("Ninguna solicitud estaba en un estado válido para liquidar");
    }

    await connection.commit();
    res.status(200).json({ success: true, message: `${aplicadas} solicitudes liquidadas correctamente`, aplicadas });
  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json("Error al confirmar la liquidación");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// GET /coseguro/estadisticas — dashboard (admin, admin-central, departamental)
// ---------------------------------------------------------------------------
function filtrosEstadisticas(cabecera, query) {
  const condiciones = ["s.eliminado = 0"];
  const params = [];
  if (cabecera.rol === "auditor") {
    // El auditor solo ve trámites desde "Aprobado por servicios sociales"
    condiciones.push(`s.estado_id IN (${ESTADOS_VISIBLES_AUDITOR.map(() => "?").join(",")})`);
    params.push(...ESTADOS_VISIBLES_AUDITOR);
  }
  if (cabecera.rol === "departamental") {
    condiciones.push("s.departamental_id = ?");
    params.push(cabecera.departamental_id);
  } else if (query.departamental_id) {
    condiciones.push("s.departamental_id = ?");
    params.push(Number(query.departamental_id));
  }
  const fechaDesde = normalizarFecha(query.fecha_desde);
  if (fechaDesde) {
    condiciones.push("s.fecha_comprobante >= ?");
    params.push(fechaDesde);
  }
  const fechaHasta = normalizarFecha(query.fecha_hasta);
  if (fechaHasta) {
    condiciones.push("s.fecha_comprobante <= ?");
    params.push(fechaHasta);
  }
  if (query.tipo_reintegro_id) {
    condiciones.push("s.tipo_reintegro_id = ?");
    params.push(Number(query.tipo_reintegro_id));
  }
  if (query.concepto_id) {
    condiciones.push("s.concepto_id = ?");
    params.push(Number(query.concepto_id));
  }
  if (query.usuario_id) {
    condiciones.push("s.usuario_id = ?");
    params.push(Number(query.usuario_id));
  }
  const importeMin = normalizarImporte(query.importe_min);
  if (importeMin !== null) {
    condiciones.push("COALESCE(s.importe_autorizado, s.importe) >= ?");
    params.push(importeMin);
  }
  const importeMax = normalizarImporte(query.importe_max);
  if (importeMax !== null) {
    condiciones.push("COALESCE(s.importe_autorizado, s.importe) <= ?");
    params.push(importeMax);
  }
  return { where: condiciones.join(" AND "), params };
}

router.get("/coseguro/estadisticas", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_GESTION.includes(cabecera.rol) && cabecera.rol !== "auditor") return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const { where, params } = filtrosEstadisticas(cabecera, req.query);

    const [totales] = await db.query(
      `SELECT COUNT(*) AS cantidad, COALESCE(SUM(s.importe), 0) AS importe_solicitado,
              COALESCE(SUM(s.importe_autorizado), 0) AS importe_autorizado,
              COALESCE(SUM(CASE WHEN s.estado_id = ${ESTADO.LIQUIDADO} THEN COALESCE(s.importe_autorizado, s.importe) ELSE 0 END), 0) AS importe_liquidado,
              COALESCE(SUM(s.cantidad_sesiones), 0) AS sesiones
       FROM coseguro_solicitud s WHERE ${where}`,
      params
    );
    const [porEstado] = await db.query(
      `SELECT e.id, e.nombre, e.color, e.color_texto, COUNT(s.id) AS cantidad,
              COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe)), 0) AS importe
       FROM coseguro_estado e
       LEFT JOIN coseguro_solicitud s ON s.estado_id = e.id AND ${where}
       GROUP BY e.id, e.nombre, e.color, e.color_texto, e.orden
       ORDER BY e.orden`,
      params
    );
    const [porTipo] = await db.query(
      `SELECT t.nombre, COUNT(*) AS cantidad, COALESCE(SUM(s.importe), 0) AS importe,
              COALESCE(SUM(s.importe_autorizado), 0) AS importe_autorizado
       FROM coseguro_solicitud s INNER JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id
       WHERE ${where} GROUP BY t.id, t.nombre ORDER BY cantidad DESC`,
      params
    );
    const [porConcepto] = await db.query(
      `SELECT c.nombre, COUNT(*) AS cantidad, COALESCE(SUM(s.importe), 0) AS importe,
              COALESCE(SUM(s.importe_autorizado), 0) AS importe_autorizado,
              COALESCE(SUM(s.cantidad_sesiones), 0) AS sesiones
       FROM coseguro_solicitud s INNER JOIN coseguro_concepto c ON c.id = s.concepto_id
       WHERE ${where} GROUP BY c.id, c.nombre ORDER BY cantidad DESC`,
      params
    );
    const [porImputacion] = await db.query(
      `SELECT COALESCE(i.codigo, '(sin imputar)') AS codigo, COALESCE(i.descripcion, 'Sin imputación asignada') AS descripcion,
              COALESCE(d.descripcion, '') AS detalle,
              COUNT(*) AS cantidad, COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe)), 0) AS importe
       FROM coseguro_solicitud s
       LEFT JOIN coseguro_imputacion i ON i.id = s.imputacion_id
       LEFT JOIN coseguro_imputacion d ON d.id = s.imputacion_detalle_id
       WHERE ${where}
       GROUP BY i.id, i.codigo, i.descripcion, d.id, d.descripcion
       ORDER BY importe DESC`,
      params
    );
    const [evolucion] = await db.query(
      `SELECT DATE_FORMAT(s.fecha_comprobante, '%Y-%m') AS mes, COUNT(*) AS cantidad,
              COALESCE(SUM(s.importe), 0) AS importe_solicitado,
              COALESCE(SUM(s.importe_autorizado), 0) AS importe_autorizado
       FROM coseguro_solicitud s WHERE ${where}
       GROUP BY mes ORDER BY mes DESC LIMIT 12`,
      params
    );
    const [porDepartamental] = await db.query(
      `SELECT COALESCE(d.nombre, 'Sin departamental') AS nombre, COUNT(*) AS cantidad,
              COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe)), 0) AS importe
       FROM coseguro_solicitud s LEFT JOIN departamental d ON d.id = s.departamental_id
       WHERE ${where} GROUP BY d.id, d.nombre ORDER BY cantidad DESC`,
      params
    );
    const [topAfiliados] = await db.query(
      `SELECT CONCAT(u.apellido, ', ', u.nombre) AS afiliado, u.id AS usuario_id, u.documento,
              COUNT(*) AS cantidad, COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe)), 0) AS importe,
              COALESCE(SUM(s.cantidad_sesiones), 0) AS sesiones
       FROM coseguro_solicitud s INNER JOIN usuario u ON u.id = s.usuario_id
       WHERE ${where} GROUP BY u.id, u.apellido, u.nombre, u.documento
       ORDER BY cantidad DESC LIMIT 10`,
      params
    );

    // Consumo mensual por concepto de un afiliado puntual (ej: sesiones de psicología)
    let consumosAfiliado = null;
    if (req.query.usuario_id) {
      const [consumos] = await db.query(
        `SELECT DATE_FORMAT(s.fecha_comprobante, '%Y-%m') AS mes, c.nombre AS concepto,
                COUNT(*) AS solicitudes, COALESCE(SUM(COALESCE(s.cantidad_sesiones, 1)), 0) AS prestaciones,
                COALESCE(SUM(COALESCE(s.importe_autorizado, s.importe)), 0) AS importe
         FROM coseguro_solicitud s LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id
         WHERE ${where}
         GROUP BY mes, c.id, c.nombre ORDER BY mes DESC, prestaciones DESC`,
        params
      );
      consumosAfiliado = consumos;
    }

    res.status(200).json({
      totales: totales[0],
      por_estado: porEstado,
      por_tipo: porTipo,
      por_concepto: porConcepto,
      por_imputacion: porImputacion,
      evolucion_mensual: evolucion.reverse(),
      por_departamental: porDepartamental,
      top_afiliados: topAfiliados,
      consumos_afiliado: consumosAfiliado,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las estadísticas");
  }
});

// ---------------------------------------------------------------------------
// Constatación de comprobantes contra ARCA (WSCDC)
// ---------------------------------------------------------------------------
// GET /coseguro/arca/estado — informa si la integración está configurada
router.get("/coseguro/arca/estado", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_GESTION.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const config = arca.configuracion();
    res.status(200).json({
      configurado: config.configurado,
      entorno: config.entorno,
      tipos_comprobante: arca.TIPOS_COMPROBANTE_ARCA,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al consultar el estado de ARCA");
  }
});

// POST /coseguro/solicitudes/:id/constatar-arca — valida la factura contra ARCA
// body: { cbte_tipo (código ARCA, ej 11 = Factura C), cod_autorizacion (CAE/CAI) }
router.post("/coseguro/solicitudes/:id/constatar-arca", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_GESTION.includes(cabecera.rol)) return res.status(401).json("No autorizado");
    const solicitudId = Number(req.params.id);
    if (!solicitudId) return res.status(400).json("ID inválido");

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM coseguro_solicitud WHERE id = ? AND eliminado = 0", [solicitudId]);
    if (rows.length === 0) return res.status(404).json("Solicitud no encontrada");
    const solicitud = rows[0];
    if (!puedeVerSolicitud(cabecera, solicitud)) return res.status(401).json("No autorizado");

    const cbteTipo = Number(req.body.cbte_tipo);
    const codAutorizacion = String(req.body.cod_autorizacion || "").replace(/\D/g, "");
    if (!cbteTipo) return res.status(400).json("Indicá el tipo de comprobante (código ARCA)");
    if (codAutorizacion.length !== 14) return res.status(400).json("El CAE/CAI debe tener 14 dígitos");
    if (!solicitud.emisor_cuit) return res.status(400).json("La solicitud no tiene CUIT del emisor: no se puede constatar");
    if (!solicitud.comprobante_pto_venta) return res.status(400).json("La solicitud no tiene punto de venta: no se puede constatar");

    const config = arca.configuracion();
    if (!config.configurado) {
      return res.status(503).json("La integración con ARCA no está configurada (ver BD/COSEGURO_SETUP_IA_AFIP.md)");
    }

    let resultado;
    try {
      resultado = await arca.constatarComprobante({
        cuit_emisor: solicitud.emisor_cuit,
        pto_venta: solicitud.comprobante_pto_venta,
        numero: solicitud.comprobante_numero,
        fecha: moment(solicitud.fecha_comprobante).format("YYYY-MM-DD"),
        importe: solicitud.importe,
        cod_autorizacion: codAutorizacion,
        cbte_tipo: cbteTipo,
      });
    } catch (error) {
      console.log("Error WSAA/WSCDC:", error.message);
      // Errores típicos: servicio no autorizado en ARCA, certificado vencido, ARCA caído
      return res.status(502).json(`No se pudo consultar ARCA: ${error.message}`);
    }

    // Guardar el resultado en la verificación de la solicitud + historial
    const verificacion = parseJsonSeguro(solicitud.verificacion) || {};
    verificacion.arca = {
      resultado: resultado.resultado,
      aprobado: resultado.aprobado,
      observaciones: resultado.observaciones,
      errores: resultado.errores,
      cbte_tipo: cbteTipo,
      cod_autorizacion: codAutorizacion,
      fecha_consulta: moment().format("YYYY-MM-DD HH:mm:ss"),
      consultado_por: cabecera.id,
      origen: "manual",
      entorno: resultado.entorno,
    };
    await db.query("UPDATE coseguro_solicitud SET verificacion = ? WHERE id = ?", [JSON.stringify(verificacion), solicitudId]);
    await registrarHistorial(db, {
      solicitud_id: solicitudId,
      usuario_id: cabecera.id,
      usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE",
      campo_modificado: "Constatación ARCA",
      valor_nuevo: resultado.aprobado
        ? "APROBADO: el comprobante existe en ARCA"
        : `RECHAZADO: ${(resultado.observaciones || []).map((o) => o.mensaje).join("; ") || "sin detalle"}`,
    });

    res.status(200).json(verificacion.arca);
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al constatar el comprobante");
  }
});

// GET /coseguro/estadisticas/export — CSV con el detalle filtrado del dashboard
router.get("/coseguro/estadisticas/export", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!ROLES_GESTION.includes(cabecera.rol) && cabecera.rol !== "auditor") return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();

    const filtros = {
      ...req.query,
      estado_id: req.query.estado_id
        ? String(req.query.estado_id).split(",").map(Number).filter((n) => n > 0)
        : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };
    const rows = await consultarSolicitudesParaExportar(db, cabecera, filtros);
    const csv = generarCsvSolicitudes(rows);
    res.status(200).json({ csv, total: rows.length, nombre_archivo: `reintegros_${moment().format("YYYYMMDD_HHmm")}.csv` });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al exportar las estadísticas");
  }
});

module.exports = router;
