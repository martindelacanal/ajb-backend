"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { randomUUID } = require("node:crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const kits = require("../services/kits");

const router = express.Router();
const s3 = new S3Client({ region: process.env.BUCKET_REGION, credentials: { accessKeyId: process.env.ACCESS_KEY, secretAccessKey: process.env.SECRET_ACCESS_KEY } });
const Bucket = process.env.BUCKET_NAME;
const mimeExtensiones = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
function actor(req) { return JSON.parse(req.data.data); }
function verificar(req, res, next) {
  return verificarTokenConAutorizacionActual({ req, res, next, jwt, jwtSecret: process.env.JWT_SECRET, db: mysqlConnection.promise(), mensajeAuthorization: "Iniciá sesión para continuar" });
}
function permiso(tipo) {
  return (req, res, next) => {
    try { if (tipo === "staff") kits.exigirStaff(actor(req)); else kits.exigirAfiliado(actor(req)); next(); }
    catch (error) { responderError(res, error); }
  };
}
function subir(campo) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 25, fieldSize: 150000 },
    fileFilter: (_req, file, callback) => callback(mimeExtensiones[file.mimetype] && (campo !== "imagen" || file.mimetype !== "application/pdf") ? null : kits.error("El formato del archivo no está permitido"), true),
  }).single(campo);
  return (req, res, next) => upload(req, res, (error) => {
    if (error) return res.status(400).json({ message: error instanceof multer.MulterError ? "Subí un solo archivo de hasta 10 MB" : error.message });
    next();
  });
}
function responderError(res, error) {
  if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Ya existe una inscripción para este DNI en la campaña" });
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error("Kits: error de operación", error.code || error.name);
  return res.status(500).json({ message: "No pudimos completar la operación. Volvé a intentar." });
}
function mediaPara(nuevos = []) {
  return {
    firmar: (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 }),
    guardar: async (file, carpeta) => {
      const Key = `kits/${carpeta}/${randomUUID()}.${mimeExtensiones[file.mimetype]}`;
      await s3.send(new PutObjectCommand({ Bucket, Key, Body: file.buffer, ContentType: file.mimetype,
        ...(carpeta === "documentos" ? { ContentDisposition: "attachment" } : {}) }));
      nuevos.push(Key); return Key;
    },
  };
}
async function eliminarArchivo(Key) {
  try { await s3.send(new DeleteObjectCommand({ Bucket, Key })); }
  catch (error) { console.error("Kits: no se pudo retirar archivo reemplazado", error.code || error.name); }
}
async function transaccion(trabajo) {
  const db = await mysqlConnection.promise().getConnection();
  const nuevos = [];
  try {
    await db.beginTransaction();
    const resultado = await trabajo(db, mediaPara(nuevos));
    await db.commit();
    return resultado;
  } catch (error) {
    await db.rollback();
    for (const key of nuevos) await eliminarArchivo(key);
    throw error;
  } finally { db.release(); }
}

router.get("/kits", verificar, async (req, res) => {
  try { res.json({ results: await kits.listarCampanias(mysqlConnection.promise(), actor(req), mediaPara()) }); }
  catch (error) { responderError(res, error); }
});
router.get("/kits/mis-inscripciones", verificar, permiso("afiliado"), async (req, res) => {
  try { res.json({ results: await kits.listarInscripciones(mysqlConnection.promise(), actor(req), req.query) }); }
  catch (error) { responderError(res, error); }
});
router.get("/kits/inscripciones", verificar, permiso("staff"), async (req, res) => {
  try { res.json({ results: await kits.listarInscripciones(mysqlConnection.promise(), actor(req), req.query), estados: kits.ESTADOS }); }
  catch (error) { responderError(res, error); }
});
router.get("/kits/inscripciones/:id(\\d+)/documento", verificar, async (req, res) => {
  try {
    const inscripcion = await kits.buscarInscripcion(mysqlConnection.promise(), actor(req), req.params.id);
    if (!inscripcion.documento_archivo) return res.status(404).json({ message: "Esta inscripción no tiene un documento adjunto" });
    const archivo = await s3.send(new GetObjectCommand({ Bucket, Key: inscripcion.documento_archivo }));
    res.setHeader("Content-Type", inscripcion.documento_mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="comprobante-kit-${inscripcion.id}.${mimeExtensiones[inscripcion.documento_mime] || "bin"}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    archivo.Body.on("error", () => res.destroy());
    archivo.Body.pipe(res);
  } catch (error) { responderError(res, error); }
});
router.get("/kits/inscripciones/:id(\\d+)", verificar, async (req, res) => {
  try { res.json({ data: await kits.detalleInscripcion(mysqlConnection.promise(), actor(req), req.params.id) }); }
  catch (error) { responderError(res, error); }
});
router.patch("/kits/inscripciones/:id(\\d+)", verificar, async (req, res) => {
  try { res.json({ success: true, ...await transaccion((db) => kits.cambiarEstado(db, actor(req), req.params.id, req.body || {})) }); }
  catch (error) { responderError(res, error); }
});
router.get("/kits/:id(\\d+)", verificar, async (req, res) => {
  try { res.json({ data: await kits.detalleCampania(mysqlConnection.promise(), actor(req), req.params.id, mediaPara()) }); }
  catch (error) { responderError(res, error); }
});
router.post("/kits", verificar, permiso("staff"), subir("imagen"), async (req, res) => {
  try {
    const resultado = await transaccion((db, media) => kits.guardarCampania(db, actor(req), req.body || {}, null, req.file, media));
    res.status(201).json({ success: true, id: resultado.id });
  } catch (error) { responderError(res, error); }
});
router.put("/kits/:id(\\d+)", verificar, permiso("staff"), subir("imagen"), async (req, res) => {
  try {
    const resultado = await transaccion((db, media) => kits.guardarCampania(db, actor(req), req.body || {}, req.params.id, req.file, media));
    if (resultado.anterior_imagen) await eliminarArchivo(resultado.anterior_imagen);
    res.json({ success: true, id: resultado.id });
  } catch (error) { responderError(res, error); }
});
router.post("/kits/:id(\\d+)/inscripciones", verificar, permiso("afiliado"), subir("documento"), async (req, res) => {
  try { res.status(201).json({ success: true, ...await transaccion((db, media) => kits.inscribir(db, actor(req), req.params.id, req.body || {}, req.file, media)) }); }
  catch (error) { responderError(res, error); }
});

module.exports = router;
