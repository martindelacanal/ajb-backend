"use strict";

// Módulo de descuentos de turismo: cupones con hashtag, tipos de viaje y el
// alta de "descuento médico" (subsidio por salud) por servicio.
//
// Rutas para el afiliado / staff que carga reservas:
//   GET  /descuentos/contexto            → qué descuentos ofrece el paso "Descuentos" para un servicio y titular
//   POST /descuentos/validar-cupon       → valida un hashtag contra el backend (tilde en vivo)
//   POST /descuentos/previsualizar       → calcula el descuento sobre la cotización ya obtenida
//   POST /reserva/:id/descuentos/:descuentoId/comprobantes → adjunta comprobantes (PDF/imagen)
//   DELETE /reserva/:id/descuentos/comprobantes/:archivoId
//
// Rutas de administración (admin y admin-central con área Turismo):
//   GET/POST/PUT/PATCH/DELETE /descuentos/admin/reglas
//   GET /descuentos/admin/catalogos | /usos | /metricas | /historial | /servicios-salud

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const mysqlConnection = require("../connection/connection");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { registrarErrorRuta } = require("../services/errores");
const { decimalACentavos, normalizarFechaCivil } = require("../services/valores-dominio");
const { puedeAprobarTurismo, tieneAreaTurismo } = require("../services/turismo-catalogo");
const {
  ALCANCES_DEPARTAMENTAL,
  ALCANCES_PERSONA,
  ALCANCES_SERVICIO,
  BASES_CALCULO,
  ESTADOS_RESERVA_NO_CONSUMEN,
  TIPOS_REGLA,
  calcularDescuentos,
  cargarDetalleReglas,
  crearError,
  evaluarReglaParaContexto,
  listarTiposViajeDisponibles,
  normalizarCodigoCupon,
  normalizarCodigoTipoViaje,
  obtenerReglaPorCodigo,
  obtenerReglaPorId,
  presentarReglaParaAfiliado,
  registrarHistorialDescuento,
  resolverDescuentosSolicitados,
} = require("../services/descuentos-reserva");

const router = express.Router();

const ROLES_RESERVA = new Set(["admin", "departamental", "afiliado"]);
const ROLES_ADMIN_DESCUENTOS = new Set(["admin", "admin-central"]);
const MAX_COMPROBANTE_BYTES = 10 * 1024 * 1024;
const MAX_COMPROBANTES_POR_CARGA = 5;
const MIME_COMPROBANTE = new Map([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
]);
const S3_EXPIRES = Math.min(86400, Math.max(60, Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || 3600)));

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});

// ---------------------------------------------------------------------------
// Infraestructura común
// ---------------------------------------------------------------------------

function verifyToken(req, res, next) {
  return verificarTokenConAutorizacionActual({
    req,
    res,
    next,
    jwt,
    jwtSecret: process.env.JWT_SECRET,
    db: mysqlConnection.promise(),
    mensajeAuthorization: "No autorizado",
  });
}

function cabeceraDe(req) {
  return JSON.parse(req.data.data);
}

function responderError(res, error, mensaje = "No se pudo completar la operación") {
  if (error?.statusCode) {
    const payload = { message: error.message, codigo: error.codigo || null };
    if (error.detalles) payload.detalles = error.detalles;
    return res.status(error.statusCode).json(payload);
  }
  if (error?.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ message: "Ya existe un descuento con ese código", codigo: "DESCUENTO_DUPLICADO" });
  }
  registrarErrorRuta(error);
  return res.status(500).json(mensaje);
}

function normalizarIdPositivo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function normalizarBooleano(valor, porDefecto = 0) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  if (valor === true || valor === 1 || valor === "1" || valor === "true") return 1;
  if (valor === false || valor === 0 || valor === "0" || valor === "false") return 0;
  return null;
}

function normalizarTexto(valor, { maximo = 500, nullable = true } = {}) {
  if (valor === undefined || valor === null) return nullable ? null : undefined;
  const texto = String(valor).trim();
  if (!texto) return nullable ? null : undefined;
  if (texto.length > maximo) return undefined;
  return texto;
}

function normalizarPorcentaje(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const centesimas = decimalACentavos(String(valor).replace(",", "."));
  if (centesimas === null || centesimas < 0 || centesimas > 10000) return null;
  return centesimas / 100;
}

function normalizarEnteroOpcional(valor, { minimo = 0, maximo = 1_000_000 } = {}) {
  if (valor === undefined || valor === null || valor === "") return null;
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero < minimo || numero > maximo) return undefined;
  return numero;
}

function normalizarPaginacion(query, porDefecto = 20) {
  const page = query?.page == null || query.page === "" ? 1 : normalizarIdPositivo(query.page);
  const pageSize = query?.pageSize == null || query.pageSize === "" ? porDefecto : normalizarIdPositivo(query.pageSize);
  if (!page || !pageSize || page > 1_000_000 || pageSize > 200) return null;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function exigirAdminDescuentos(req) {
  const cabecera = cabeceraDe(req);
  if (!ROLES_ADMIN_DESCUENTOS.has(cabecera.rol) || !puedeAprobarTurismo(cabecera)) {
    throw crearError("No autorizado", 403, "DESCUENTOS_NO_AUTORIZADO");
  }
  return cabecera;
}

function exigirRolReserva(req) {
  const cabecera = cabeceraDe(req);
  if (!ROLES_RESERVA.has(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
    throw crearError("No autorizado", 403, "DESCUENTOS_NO_AUTORIZADO");
  }
  return cabecera;
}

/**
 * Titular de la reserva para el que se consultan descuentos: el afiliado es él
 * mismo; admin y departamental indican usuario_id (la departamental sólo dentro
 * de su jurisdicción). Devuelve id, departamental y módulo coseguro.
 */
async function resolverTitularDescuentos(db, cabecera, usuarioIdRaw) {
  const usuarioId = cabecera.rol === "afiliado"
    ? normalizarIdPositivo(cabecera.id)
    : normalizarIdPositivo(usuarioIdRaw);
  if (!usuarioId) {
    return null;
  }
  const [rows] = await db.query(
    `SELECT u.id, u.nombre, u.apellido, u.departamental_id, u.modulo_coseguro, u.modulo_turismo, r.nombre AS rol
       FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ? LIMIT 1`,
    [usuarioId]
  );
  if (!rows.length) throw crearError("El afiliado indicado no existe", 404, "TITULAR_NO_ENCONTRADO");
  const titular = rows[0];
  if (cabecera.rol === "departamental") {
    if (!cabecera.departamental_id || Number(cabecera.departamental_id) !== Number(titular.departamental_id)) {
      throw crearError("El afiliado pertenece a otra departamental", 403, "TITULAR_OTRA_DEPARTAMENTAL");
    }
  }
  return titular;
}

async function obtenerServicioBasico(db, servicioId) {
  const id = normalizarIdPositivo(servicioId);
  if (!id) return null;
  const [rows] = await db.query(
    `SELECT s.id, s.nombre, s.descuento_salud_estado, s.activo, s.estado_aprobacion, ts.codigo AS tipo_codigo
       FROM servicio s INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
      WHERE s.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/** Devuelve el id de la reserva sólo si pertenece al titular indicado (evita usar reservas ajenas). */
async function reservaDelTitular(db, reservaIdRaw, titularId) {
  const reservaId = normalizarIdPositivo(reservaIdRaw);
  if (!reservaId || !titularId) return null;
  const [rows] = await db.query("SELECT id FROM reserva WHERE id = ? AND usuario_id = ? LIMIT 1", [reservaId, titularId]);
  return rows.length ? reservaId : null;
}

function saludDisponiblePara(cabecera, titular, servicio) {
  if (!servicio || servicio.descuento_salud_estado !== "HABILITADO") return false;
  if (!titular || Number(titular.modulo_coseguro) !== 1) return false;
  if (cabecera.rol === "afiliado") {
    return cabecera.modulo_coseguro == null || Number(cabecera.modulo_coseguro) === 1;
  }
  if (cabecera.rol === "admin") return true;
  // Un operador departamental necesita el área Coseguro para registrar viajes por salud
  return Number(cabecera.area_coseguro) === 1;
}

// ---------------------------------------------------------------------------
// Paso "Descuentos" del formulario de reserva
// ---------------------------------------------------------------------------

router.get("/descuentos/contexto", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirRolReserva(req);
    const db = mysqlConnection.promise();
    const servicio = await obtenerServicioBasico(db, req.query.servicio_id);
    if (!servicio) throw crearError("El servicio no existe", 404, "SERVICIO_NO_ENCONTRADO");
    const titular = await resolverTitularDescuentos(db, cabecera, req.query.usuario_id);
    const departamentalId = titular ? normalizarIdPositivo(titular.departamental_id) : null;
    const tiposViaje = await listarTiposViajeDisponibles(db, {
      departamentalId,
      servicioId: servicio.id,
      usuarioId: titular?.id || null,
      incluirOcultos: cabecera.rol !== "afiliado",
    });
    return res.status(200).json({
      servicio_id: Number(servicio.id),
      servicio_nombre: servicio.nombre,
      titular_id: titular ? Number(titular.id) : null,
      salud_habilitado: saludDisponiblePara(cabecera, titular, servicio),
      salud_estado_servicio: servicio.descuento_salud_estado,
      cupones_habilitados: true,
      tipos_viaje: tiposViaje,
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener los descuentos disponibles");
  }
});

router.post("/descuentos/validar-cupon", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirRolReserva(req);
    const db = mysqlConnection.promise();
    const codigo = normalizarCodigoCupon(req.body?.codigo);
    if (!codigo) {
      return res.status(200).json({
        valido: false,
        codigo: null,
        motivo: "Escribí el cupón con letras y números, por ejemplo #JUBILADO",
        codigo_error: "CUPON_INVALIDO",
      });
    }
    const servicioId = normalizarIdPositivo(req.body?.servicio_id);
    const titular = await resolverTitularDescuentos(db, cabecera, req.body?.usuario_id);
    const regla = await obtenerReglaPorCodigo(db, "CUPON", codigo);
    if (!regla) {
      return res.status(200).json({ valido: false, codigo, motivo: "Ese cupón no existe. Revisá que esté bien escrito.", codigo_error: "CUPON_INEXISTENTE" });
    }
    const evaluacion = await evaluarReglaParaContexto(db, regla, {
      departamentalId: titular ? normalizarIdPositivo(titular.departamental_id) : null,
      servicioId,
      usuarioId: titular?.id || null,
      excluirReservaId: titular ? await reservaDelTitular(db, req.body?.reserva_id, titular.id) : null,
    });
    if (!evaluacion.aplicable) {
      return res.status(200).json({ valido: false, codigo, motivo: evaluacion.motivo, codigo_error: evaluacion.codigo });
    }
    return res.status(200).json({
      valido: true,
      codigo,
      regla: presentarReglaParaAfiliado(regla, evaluacion.porcentaje),
    });
  } catch (error) {
    return responderError(res, error, "Error al validar el cupón");
  }
});

router.post("/descuentos/previsualizar", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirRolReserva(req);
    const db = mysqlConnection.promise();
    const body = req.body || {};
    const servicioId = normalizarIdPositivo(body.servicio_id);
    if (!servicioId) throw crearError("El servicio es requerido", 400, "SERVICIO_REQUERIDO");
    const titular = await resolverTitularDescuentos(db, cabecera, body.usuario_id);
    if (!titular) throw crearError("El afiliado titular es requerido", 400, "TITULAR_REQUERIDO");
    const personasRaw = Array.isArray(body.personas) ? body.personas : [];
    if (personasRaw.length === 0 || personasRaw.length > 50) {
      throw crearError("Las personas de la cotización no son válidas", 400, "PERSONAS_INVALIDAS");
    }
    const personas = personasRaw.map((persona, indice) => {
      if (!persona || typeof persona !== "object" || Array.isArray(persona)) {
        throw crearError(`Los datos de la persona ${indice + 1} no son válidos`, 400, "PERSONAS_INVALIDAS");
      }
      const finalCentavos = decimalACentavos(persona.importe_final);
      const listaCentavos = decimalACentavos(persona.importe_lista ?? persona.importe_final);
      const edad = normalizarEnteroOpcional(persona.edad, { minimo: 0, maximo: 130 });
      if (finalCentavos === null || listaCentavos === null || edad === undefined) {
        throw crearError(`Los datos de la persona ${indice + 1} no son válidos`, 400, "PERSONAS_INVALIDAS");
      }
      return {
        tipo_persona_id: normalizarIdPositivo(persona.tipo_persona_id),
        edad,
        final_centavos: finalCentavos,
        lista_centavos: listaCentavos,
      };
    });
    const adicionalesCentavos = decimalACentavos(body.adicionales_total ?? 0);
    if (adicionalesCentavos === null) throw crearError("El total de adicionales no es válido", 400, "ADICIONALES_INVALIDOS");

    // Sólo se consideran los descuentos previos si la reserva es del titular resuelto
    const reservaId = await reservaDelTitular(db, body.reserva_id, titular.id);
    let existentes = [];
    if (reservaId) {
      const [filas] = await db.query("SELECT rd.* FROM reserva_descuento rd WHERE rd.reserva_id = ?", [reservaId]);
      existentes = filas;
    }
    const { reglas, rechazos } = await resolverDescuentosSolicitados(db, {
      cuponCodigo: body.cupon_codigo,
      tipoViajeId: body.tipo_viaje_id,
      departamentalId: normalizarIdPositivo(titular.departamental_id),
      servicioId,
      usuarioId: Number(titular.id),
      excluirReservaId: reservaId,
      esStaff: cabecera.rol !== "afiliado",
      existentes,
      estricto: false,
    });
    const resultado = calcularDescuentos({ personas, adicionalesCentavos, reglas });
    return res.status(200).json({
      items: resultado.items.map(presentarItemPreview),
      aplicados: resultado.aplicados.map(presentarItemPreview),
      rechazados: rechazos,
      total_antes: resultado.total_antes,
      total_descuento: resultado.total_descuento,
      total_final: resultado.total_final,
    });
  } catch (error) {
    return responderError(res, error, "Error al calcular los descuentos");
  }
});

function presentarItemPreview(item) {
  return {
    regla_id: item.regla_id,
    tipo: item.tipo,
    codigo: item.codigo,
    nombre: item.nombre,
    descripcion: item.descripcion,
    porcentaje: item.porcentaje,
    base_calculo: item.base_calculo,
    incluye_adicionales: item.incluye_adicionales,
    acumulable: item.acumulable,
    requiere_comprobante: item.requiere_comprobante,
    personas_alcanzadas: item.personas_alcanzadas,
    importe_base: item.importe_base,
    importe_descuento: item.importe_descuento,
    aplicado: item.aplicado && item.descuento_centavos > 0,
    motivo_no_aplicado: item.aplicado && item.descuento_centavos > 0 ? null : item.motivo_no_aplicado,
    recortado: Boolean(item.recortado),
  };
}

// ---------------------------------------------------------------------------
// Comprobantes de la reserva (tipo de viaje): se pueden cargar al reservar o
// después, por el afiliado dueño o por el staff de Turismo.
// ---------------------------------------------------------------------------

const uploadComprobantes = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_COMPROBANTES_POR_CARGA, fileSize: MAX_COMPROBANTE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!MIME_COMPROBANTE.has(file.mimetype)) {
      return callback(crearError("Solo se permiten imágenes JPG, PNG, WebP o PDF", 400, "COMPROBANTE_TIPO_INVALIDO"));
    }
    return callback(null, true);
  },
});

function contenidoCoincideConMime(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  switch (file.mimetype) {
    case "image/jpeg":
    case "image/jpg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    case "application/pdf":
      return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    default:
      return false;
  }
}

function procesarComprobantes(req, res, next) {
  uploadComprobantes.array("archivos", MAX_COMPROBANTES_POR_CARGA)(req, res, (error) => {
    if (!error) {
      for (const file of req.files || []) {
        if (!contenidoCoincideConMime(file)) {
          return res.status(400).json({ message: "El contenido de un archivo no coincide con su formato", codigo: "COMPROBANTE_CONTENIDO_INVALIDO" });
        }
      }
      return next();
    }
    if (error instanceof multer.MulterError) {
      const mensaje = error.code === "LIMIT_FILE_SIZE"
        ? "Cada comprobante debe pesar como máximo 10 MB"
        : error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"
          ? `Podés subir hasta ${MAX_COMPROBANTES_POR_CARGA} comprobantes por vez (campo "archivos")`
          : "La carga de comprobantes no es válida";
      return res.status(400).json({ message: mensaje, codigo: error.code });
    }
    return responderError(res, error, "Error al procesar los comprobantes");
  });
}

async function subirComprobante(file, reservaId) {
  const extension = MIME_COMPROBANTE.get(file.mimetype) || "bin";
  const key = `turismo/descuentos/reserva${reservaId}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${extension}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype,
  }));
  return key;
}

async function firmarArchivo(key) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }), { expiresIn: S3_EXPIRES });
}

async function eliminarArchivoSeguro(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
  } catch (error) {
    registrarErrorRuta(error);
  }
}

const ESTADOS_RESERVA_CERRADOS = new Set(["Cancelada", "Rechazada", "Utilizada", "No adjudicada", "Convenio rechazado"]);

/** Reserva + descuento, autorizando al dueño o al staff con jurisdicción. */
async function cargarDescuentoAutorizado(db, cabecera, reservaId, descuentoId) {
  const [rows] = await db.query(
    `SELECT rd.*, r.usuario_id AS reserva_usuario_id, u.departamental_id AS reserva_departamental_id,
            er.nombre AS estado_reserva
       FROM reserva_descuento rd
       INNER JOIN reserva r ON r.id = rd.reserva_id
       INNER JOIN usuario u ON u.id = r.usuario_id
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE rd.reserva_id = ? AND rd.id = ?
      LIMIT 1`,
    [reservaId, descuentoId]
  );
  if (!rows.length) throw crearError("El descuento de la reserva no existe", 404, "RESERVA_DESCUENTO_NO_ENCONTRADO");
  const descuento = rows[0];
  const esStaff = ["admin", "departamental", "admin-central"].includes(cabecera.rol) && tieneAreaTurismo(cabecera);
  if (cabecera.rol === "afiliado") {
    if (Number(descuento.reserva_usuario_id) !== Number(cabecera.id)) {
      throw crearError("No podés modificar los comprobantes de esta reserva", 403, "RESERVA_DESCUENTO_NO_AUTORIZADO");
    }
    if (ESTADOS_RESERVA_CERRADOS.has(descuento.estado_reserva)) {
      throw crearError("La reserva ya está cerrada: no se pueden modificar los comprobantes", 409, "RESERVA_CERRADA");
    }
  } else if (!esStaff) {
    throw crearError("No autorizado", 403, "RESERVA_DESCUENTO_NO_AUTORIZADO");
  } else if (cabecera.rol === "departamental" && Number(cabecera.departamental_id) !== Number(descuento.reserva_departamental_id)) {
    throw crearError("La reserva pertenece a otra departamental", 403, "RESERVA_DESCUENTO_NO_AUTORIZADO");
  }
  return descuento;
}

router.post("/reserva/:id/descuentos/:descuentoId/comprobantes", verifyToken, procesarComprobantes, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    if (!["admin", "departamental", "afiliado", "admin-central"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      throw crearError("No autorizado", 403, "RESERVA_DESCUENTO_NO_AUTORIZADO");
    }
    const reservaId = normalizarIdPositivo(req.params.id);
    const descuentoId = normalizarIdPositivo(req.params.descuentoId);
    if (!reservaId || !descuentoId) throw crearError("Identificadores inválidos", 400);
    const files = req.files || [];
    if (files.length === 0) throw crearError("Adjuntá al menos un comprobante", 400, "COMPROBANTE_REQUERIDO");
    const db = mysqlConnection.promise();
    const descuento = await cargarDescuentoAutorizado(db, cabecera, reservaId, descuentoId);
    const [[conteo]] = await db.query(
      "SELECT COUNT(*) AS total FROM reserva_descuento_archivo WHERE reserva_descuento_id = ?",
      [descuentoId]
    );
    if (Number(conteo.total) + files.length > 10) {
      throw crearError("Una reserva admite hasta 10 comprobantes por descuento", 409, "COMPROBANTES_MAXIMO");
    }
    const guardados = [];
    for (const file of files) {
      const nombreOriginal = String(file.originalname || "").slice(0, 260) || null;
      const key = await subirComprobante(file, reservaId);
      const [insercion] = await db.query(
        `INSERT INTO reserva_descuento_archivo (reserva_descuento_id, archivo, nombre_original, mime, tamanio, subido_por_usuario_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [descuentoId, key, nombreOriginal, String(file.mimetype || "").slice(0, 100) || null, file.size || null, cabecera.id]
      );
      guardados.push({ id: Number(insercion.insertId), nombre_original: nombreOriginal, mime: file.mimetype, tamanio: file.size, url: await firmarArchivo(key) });
    }
    await registrarHistorialDescuento(db, {
      reglaId: descuento.regla_id, reservaId, servicioId: descuento.servicio_id,
      entidadTipo: "COMPROBANTE", entidadId: descuentoId, operacion: "UPLOAD",
      resumen: `Reserva #${reservaId}: ${files.length} comprobante${files.length === 1 ? "" : "s"} de ${descuento.nombre} cargado${files.length === 1 ? "" : "s"} por ${cabecera.rol}`,
      nuevo: { archivos: guardados.map((archivo) => ({ id: archivo.id, nombre: archivo.nombre_original })) },
      usuarioId: cabecera.id, req,
    });
    await db.query(
      `INSERT INTO historial_reserva (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, ip_address, user_agent, observaciones)
       VALUES (?, 'UPDATE', ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservaId, `Comprobante (${descuento.nombre})`, String(conteo.total), String(Number(conteo.total) + files.length),
        cabecera.id, req.ip || null, req.get("User-Agent") || null,
        `Se ${files.length === 1 ? "adjuntó un comprobante" : `adjuntaron ${files.length} comprobantes`} del descuento "${descuento.nombre}"`,
      ]
    );
    return res.status(201).json({ success: true, cantidad: guardados.length, archivos: guardados });
  } catch (error) {
    return responderError(res, error, "Error al cargar los comprobantes");
  }
});

router.delete("/reserva/:id/descuentos/comprobantes/:archivoId", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    const reservaId = normalizarIdPositivo(req.params.id);
    const archivoId = normalizarIdPositivo(req.params.archivoId);
    if (!reservaId || !archivoId) throw crearError("Identificadores inválidos", 400);
    const db = mysqlConnection.promise();
    const [archivos] = await db.query(
      `SELECT a.*, rd.reserva_id FROM reserva_descuento_archivo a
        INNER JOIN reserva_descuento rd ON rd.id = a.reserva_descuento_id
       WHERE a.id = ? AND rd.reserva_id = ? LIMIT 1`,
      [archivoId, reservaId]
    );
    if (!archivos.length) throw crearError("El comprobante no existe", 404, "COMPROBANTE_NO_ENCONTRADO");
    const archivo = archivos[0];
    const descuento = await cargarDescuentoAutorizado(db, cabecera, reservaId, archivo.reserva_descuento_id);
    if (cabecera.rol === "afiliado" && Number(archivo.subido_por_usuario_id) !== Number(cabecera.id)) {
      throw crearError("Solo podés quitar los comprobantes que subiste vos", 403, "COMPROBANTE_AJENO");
    }
    // Una vez que la departamental revisó la reserva, la documentación queda a resguardo del staff
    if (cabecera.rol === "afiliado" && descuento.estado_reserva !== "Iniciada") {
      throw crearError("La reserva ya fue revisada: pedile a tu departamental que quite el comprobante", 409, "COMPROBANTE_RESERVA_REVISADA");
    }
    await db.query("DELETE FROM reserva_descuento_archivo WHERE id = ?", [archivoId]);
    await eliminarArchivoSeguro(archivo.archivo);
    await registrarHistorialDescuento(db, {
      reglaId: descuento.regla_id, reservaId, servicioId: descuento.servicio_id,
      entidadTipo: "COMPROBANTE", entidadId: descuento.id, operacion: "DELETE",
      resumen: `Reserva #${reservaId}: se quitó el comprobante "${archivo.nombre_original || archivoId}" de ${descuento.nombre}`,
      anterior: { id: archivoId, nombre: archivo.nombre_original }, usuarioId: cabecera.id, req,
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    return responderError(res, error, "Error al quitar el comprobante");
  }
});

// ---------------------------------------------------------------------------
// Administración de reglas (cupones y tipos de viaje)
// ---------------------------------------------------------------------------

router.get("/descuentos/admin/catalogos", verifyToken, async (req, res) => {
  try {
    exigirAdminDescuentos(req);
    const db = mysqlConnection.promise();
    const [departamentales] = await db.query(
      "SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre"
    );
    const [servicios] = await db.query(
      `SELECT s.id, s.nombre, s.lugar, ts.codigo AS tipo_codigo, s.activo, s.estado_aprobacion, s.descuento_salud_estado
         FROM servicio s INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
        ORDER BY s.nombre`
    );
    const [tiposPersona] = await db.query("SELECT id, nombre FROM tipo_persona ORDER BY id");
    return res.status(200).json({
      departamentales,
      servicios,
      tipos_persona: tiposPersona,
      bases_calculo: [
        { valor: "PRECIO_FINAL", nombre: "Precio final", ayuda: "Lo que paga el afiliado después del descuento de temporada. Es la opción habitual." },
        { valor: "PRECIO_LISTA", nombre: "Precio de lista", ayuda: "El precio máximo del particular. En temporada baja el descuento resulta mayor porque se calcula antes de la rebaja de temporada." },
      ],
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener los catálogos de descuentos");
  }
});

function presentarReglaAdmin(regla, extras = {}) {
  return {
    id: Number(regla.id),
    tipo: regla.tipo,
    codigo: regla.codigo,
    etiqueta: regla.tipo === "CUPON" ? `#${regla.codigo}` : regla.nombre,
    nombre: regla.nombre,
    descripcion: regla.descripcion || null,
    porcentaje_descuento: Number(regla.porcentaje_descuento),
    base_calculo: regla.base_calculo,
    incluye_adicionales: Number(regla.incluye_adicionales) === 1,
    acumulable: Number(regla.acumulable) === 1,
    requiere_comprobante: Number(regla.requiere_comprobante) === 1,
    oculto: Number(regla.oculto) === 1,
    alcance_departamental: regla.alcance_departamental,
    alcance_servicio: regla.alcance_servicio,
    alcance_persona: regla.alcance_persona,
    edad_minima: regla.edad_minima === null || regla.edad_minima === undefined ? null : Number(regla.edad_minima),
    edad_maxima: regla.edad_maxima === null || regla.edad_maxima === undefined ? null : Number(regla.edad_maxima),
    vigencia_desde: regla.vigencia_desde ? String(regla.vigencia_desde).slice(0, 10) : null,
    vigencia_hasta: regla.vigencia_hasta ? String(regla.vigencia_hasta).slice(0, 10) : null,
    usos_maximos: regla.usos_maximos === null || regla.usos_maximos === undefined ? null : Number(regla.usos_maximos),
    usos_por_afiliado: regla.usos_por_afiliado === null || regla.usos_por_afiliado === undefined ? null : Number(regla.usos_por_afiliado),
    habilitado: Number(regla.habilitado) === 1,
    orden: Number(regla.orden || 0),
    creado_por_usuario_id: regla.creado_por_usuario_id || null,
    fecha_creacion: regla.fecha_creacion,
    fecha_modificacion: regla.fecha_modificacion,
    departamentales: regla.departamentales || [],
    servicios: regla.servicios || [],
    tipos_persona: regla.tipos_persona_detalle || [],
    tipos_persona_ids: regla.tipos_persona || [],
    ...extras,
  };
}

function snapshotRegla(regla) {
  if (!regla) return null;
  const presentada = presentarReglaAdmin(regla);
  delete presentada.fecha_modificacion;
  delete presentada.fecha_creacion;
  delete presentada.etiqueta;
  return presentada;
}

function validarPayloadRegla(body, { existente = null } = {}) {
  const tipo = existente ? existente.tipo : String(body.tipo || "").toUpperCase();
  if (!TIPOS_REGLA.includes(tipo)) throw crearError("El tipo de descuento no es válido", 400, "DESCUENTO_TIPO_INVALIDO");
  const nombre = normalizarTexto(body.nombre, { maximo: 120, nullable: false });
  if (!nombre) throw crearError("Ingresá un nombre para el descuento", 400, "DESCUENTO_NOMBRE_REQUERIDO");
  const descripcion = normalizarTexto(body.descripcion, { maximo: 500 });
  if (descripcion === undefined) throw crearError("La descripción es demasiado larga (máximo 500 caracteres)", 400, "DESCUENTO_DESCRIPCION_INVALIDA");
  const codigo = tipo === "CUPON"
    ? normalizarCodigoCupon(body.codigo)
    : normalizarCodigoTipoViaje(body.codigo, existente ? existente.codigo : nombre);
  if (!codigo) {
    throw crearError(
      tipo === "CUPON"
        ? "El hashtag del cupón debe tener entre 2 y 40 letras, números, guiones o guiones bajos (ej. #JUBILADO)"
        : "El código del tipo de viaje no es válido",
      400,
      "DESCUENTO_CODIGO_INVALIDO"
    );
  }
  const porcentaje = normalizarPorcentaje(body.porcentaje_descuento);
  if (porcentaje === null) throw crearError("El porcentaje debe estar entre 0 y 100", 400, "DESCUENTO_PORCENTAJE_INVALIDO");
  const baseCalculo = String(body.base_calculo || "PRECIO_FINAL").toUpperCase();
  if (!BASES_CALCULO.includes(baseCalculo)) throw crearError("La base de cálculo no es válida", 400, "DESCUENTO_BASE_INVALIDA");
  const incluyeAdicionales = normalizarBooleano(body.incluye_adicionales, 0);
  const acumulable = normalizarBooleano(body.acumulable, 0);
  const requiereComprobante = normalizarBooleano(body.requiere_comprobante, tipo === "TIPO_VIAJE" ? 1 : 0);
  const oculto = normalizarBooleano(body.oculto, 0);
  const habilitado = normalizarBooleano(body.habilitado, 1);
  if ([incluyeAdicionales, acumulable, requiereComprobante, oculto, habilitado].includes(null)) {
    throw crearError("Hay opciones con valores inválidos", 400, "DESCUENTO_OPCION_INVALIDA");
  }
  const alcanceDepartamental = String(body.alcance_departamental || "TODAS").toUpperCase();
  const alcanceServicio = String(body.alcance_servicio || "TODOS").toUpperCase();
  const alcancePersona = String(body.alcance_persona || "TODAS").toUpperCase();
  if (!ALCANCES_DEPARTAMENTAL.includes(alcanceDepartamental) || !ALCANCES_SERVICIO.includes(alcanceServicio) || !ALCANCES_PERSONA.includes(alcancePersona)) {
    throw crearError("El alcance indicado no es válido", 400, "DESCUENTO_ALCANCE_INVALIDO");
  }
  const departamentalesRaw = Array.isArray(body.departamentales) ? body.departamentales : [];
  const departamentales = [];
  const vistas = new Set();
  for (const item of departamentalesRaw) {
    const departamentalId = normalizarIdPositivo(item?.departamental_id ?? item?.id);
    if (!departamentalId || vistas.has(departamentalId)) throw crearError("La configuración por departamental no es válida", 400, "DESCUENTO_DEPARTAMENTALES_INVALIDAS");
    vistas.add(departamentalId);
    const habilitadaDep = normalizarBooleano(item.habilitado, 1);
    const porcentajeDep = item.porcentaje_descuento === undefined || item.porcentaje_descuento === null || item.porcentaje_descuento === ""
      ? null
      : normalizarPorcentaje(item.porcentaje_descuento);
    if (habilitadaDep === null || porcentajeDep === undefined || (item.porcentaje_descuento !== undefined && item.porcentaje_descuento !== null && item.porcentaje_descuento !== "" && porcentajeDep === null)) {
      throw crearError("El porcentaje por departamental debe estar entre 0 y 100", 400, "DESCUENTO_DEPARTAMENTALES_INVALIDAS");
    }
    departamentales.push({ departamental_id: departamentalId, habilitado: habilitadaDep, porcentaje_descuento: porcentajeDep });
  }
  if (alcanceDepartamental === "SELECCIONADAS" && !departamentales.some((item) => item.habilitado === 1)) {
    throw crearError("Seleccioná al menos una departamental habilitada", 400, "DESCUENTO_SIN_DEPARTAMENTALES");
  }
  const serviciosIds = normalizarListaIds(body.servicios_ids ?? body.servicios);
  if (serviciosIds === null) throw crearError("La lista de servicios no es válida", 400, "DESCUENTO_SERVICIOS_INVALIDOS");
  if (alcanceServicio === "SELECCIONADOS" && serviciosIds.length === 0) {
    throw crearError("Seleccioná al menos un servicio", 400, "DESCUENTO_SIN_SERVICIOS");
  }
  const tiposPersonaIds = normalizarListaIds(body.tipos_persona_ids ?? body.tipos_persona);
  if (tiposPersonaIds === null) throw crearError("La lista de tipos de persona no es válida", 400, "DESCUENTO_TIPOS_PERSONA_INVALIDOS");
  if (alcancePersona === "SELECCIONADAS" && tiposPersonaIds.length === 0) {
    throw crearError("Seleccioná al menos un tipo de persona", 400, "DESCUENTO_SIN_TIPOS_PERSONA");
  }
  const edadMinima = normalizarEnteroOpcional(body.edad_minima, { minimo: 0, maximo: 130 });
  const edadMaxima = normalizarEnteroOpcional(body.edad_maxima, { minimo: 0, maximo: 130 });
  if (edadMinima === undefined || edadMaxima === undefined || (edadMinima !== null && edadMaxima !== null && edadMinima > edadMaxima)) {
    throw crearError("El rango de edad no es válido", 400, "DESCUENTO_EDAD_INVALIDA");
  }
  const vigenciaDesde = body.vigencia_desde ? normalizarFechaCivil(String(body.vigencia_desde).slice(0, 10)) : null;
  const vigenciaHasta = body.vigencia_hasta ? normalizarFechaCivil(String(body.vigencia_hasta).slice(0, 10)) : null;
  if ((body.vigencia_desde && !vigenciaDesde) || (body.vigencia_hasta && !vigenciaHasta) || (vigenciaDesde && vigenciaHasta && vigenciaDesde > vigenciaHasta)) {
    throw crearError("Las fechas de vigencia no son válidas", 400, "DESCUENTO_VIGENCIA_INVALIDA");
  }
  const usosMaximos = normalizarEnteroOpcional(body.usos_maximos, { minimo: 1, maximo: 10_000_000 });
  const usosPorAfiliado = normalizarEnteroOpcional(body.usos_por_afiliado, { minimo: 1, maximo: 10_000 });
  if (usosMaximos === undefined || usosPorAfiliado === undefined) {
    throw crearError("Los límites de uso deben ser números enteros positivos", 400, "DESCUENTO_USOS_INVALIDOS");
  }
  const orden = normalizarEnteroOpcional(body.orden, { minimo: 0, maximo: 100_000 }) ?? 0;
  if (orden === undefined) throw crearError("El orden no es válido", 400, "DESCUENTO_ORDEN_INVALIDO");

  return {
    tipo,
    codigo,
    nombre,
    descripcion,
    porcentaje_descuento: porcentaje,
    base_calculo: baseCalculo,
    incluye_adicionales: incluyeAdicionales,
    acumulable,
    requiere_comprobante: requiereComprobante,
    oculto,
    habilitado,
    alcance_departamental: alcanceDepartamental,
    alcance_servicio: alcanceServicio,
    alcance_persona: alcancePersona,
    edad_minima: edadMinima,
    edad_maxima: edadMaxima,
    vigencia_desde: vigenciaDesde,
    vigencia_hasta: vigenciaHasta,
    usos_maximos: usosMaximos,
    usos_por_afiliado: usosPorAfiliado,
    orden,
    departamentales,
    servicios_ids: serviciosIds,
    tipos_persona_ids: tiposPersonaIds,
  };
}

function normalizarListaIds(valor) {
  if (valor === undefined || valor === null || valor === "") return [];
  const lista = Array.isArray(valor) ? valor : String(valor).split(",");
  const ids = lista.map((item) => normalizarIdPositivo(typeof item === "object" && item !== null ? (item.id ?? item.servicio_id ?? item.tipo_persona_id) : item));
  if (ids.some((id) => !id) || ids.length > 200) return null;
  return [...new Set(ids)];
}

async function validarReferencias(connection, datos) {
  if (datos.departamentales.length) {
    const ids = datos.departamentales.map((item) => item.departamental_id);
    const [rows] = await connection.query(`SELECT id FROM departamental WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    if (rows.length !== ids.length) throw crearError("Hay departamentales inexistentes", 400, "DESCUENTO_DEPARTAMENTALES_INVALIDAS");
  }
  if (datos.servicios_ids.length) {
    const [rows] = await connection.query(`SELECT id FROM servicio WHERE id IN (${datos.servicios_ids.map(() => "?").join(",")})`, datos.servicios_ids);
    if (rows.length !== datos.servicios_ids.length) throw crearError("Hay servicios inexistentes", 400, "DESCUENTO_SERVICIOS_INVALIDOS");
  }
  if (datos.tipos_persona_ids.length) {
    const [rows] = await connection.query(`SELECT id FROM tipo_persona WHERE id IN (${datos.tipos_persona_ids.map(() => "?").join(",")})`, datos.tipos_persona_ids);
    if (rows.length !== datos.tipos_persona_ids.length) throw crearError("Hay tipos de persona inexistentes", 400, "DESCUENTO_TIPOS_PERSONA_INVALIDOS");
  }
}

async function reemplazarDetalleRegla(connection, reglaId, datos) {
  await connection.query("DELETE FROM descuento_regla_departamental WHERE regla_id = ?", [reglaId]);
  await connection.query("DELETE FROM descuento_regla_servicio WHERE regla_id = ?", [reglaId]);
  await connection.query("DELETE FROM descuento_regla_tipo_persona WHERE regla_id = ?", [reglaId]);
  for (const item of datos.departamentales) {
    await connection.query(
      "INSERT INTO descuento_regla_departamental (regla_id, departamental_id, habilitado, porcentaje_descuento) VALUES (?, ?, ?, ?)",
      [reglaId, item.departamental_id, item.habilitado, item.porcentaje_descuento]
    );
  }
  if (datos.alcance_servicio === "SELECCIONADOS") {
    for (const servicioId of datos.servicios_ids) {
      await connection.query("INSERT INTO descuento_regla_servicio (regla_id, servicio_id) VALUES (?, ?)", [reglaId, servicioId]);
    }
  }
  if (datos.alcance_persona === "SELECCIONADAS") {
    for (const tipoPersonaId of datos.tipos_persona_ids) {
      await connection.query("INSERT INTO descuento_regla_tipo_persona (regla_id, tipo_persona_id) VALUES (?, ?)", [reglaId, tipoPersonaId]);
    }
  }
}

const ETIQUETAS_CAMPO = {
  nombre: "nombre",
  codigo: "código",
  descripcion: "descripción",
  porcentaje_descuento: "porcentaje",
  base_calculo: "base de cálculo",
  incluye_adicionales: "incluye adicionales",
  acumulable: "acumulable",
  requiere_comprobante: "requiere comprobante",
  oculto: "oculto",
  habilitado: "habilitado",
  alcance_departamental: "alcance por departamental",
  alcance_servicio: "alcance por servicio",
  alcance_persona: "alcance por persona",
  edad_minima: "edad mínima",
  edad_maxima: "edad máxima",
  vigencia_desde: "vigencia desde",
  vigencia_hasta: "vigencia hasta",
  usos_maximos: "usos máximos",
  usos_por_afiliado: "usos por afiliado",
  orden: "orden",
  departamentales: "departamentales",
  servicios: "servicios",
  tipos_persona_ids: "tipos de persona",
};

function describirCambios(anterior, nuevo) {
  const cambios = [];
  for (const campo of Object.keys(ETIQUETAS_CAMPO)) {
    const a = JSON.stringify(anterior?.[campo] ?? null);
    const b = JSON.stringify(nuevo?.[campo] ?? null);
    if (a !== b) cambios.push(ETIQUETAS_CAMPO[campo]);
  }
  return cambios;
}

router.get("/descuentos/admin/reglas", verifyToken, async (req, res) => {
  try {
    exigirAdminDescuentos(req);
    const db = mysqlConnection.promise();
    const condiciones = ["r.eliminado = 0"];
    const params = [];
    const tipo = String(req.query.tipo || "").toUpperCase();
    if (tipo) {
      if (!TIPOS_REGLA.includes(tipo)) throw crearError("El tipo no es válido", 400, "DESCUENTO_TIPO_INVALIDO");
      condiciones.push("r.tipo = ?");
      params.push(tipo);
    }
    const habilitado = normalizarBooleano(req.query.habilitado, null);
    if (habilitado === 0 || habilitado === 1) {
      condiciones.push("r.habilitado = ?");
      params.push(habilitado);
    }
    const vigencia = String(req.query.vigencia || "").toLowerCase();
    if (vigencia === "vigentes") {
      condiciones.push("(r.vigencia_desde IS NULL OR r.vigencia_desde <= CURDATE()) AND (r.vigencia_hasta IS NULL OR r.vigencia_hasta >= CURDATE())");
    } else if (vigencia === "vencidas") {
      condiciones.push("r.vigencia_hasta IS NOT NULL AND r.vigencia_hasta < CURDATE()");
    } else if (vigencia === "programadas") {
      condiciones.push("r.vigencia_desde IS NOT NULL AND r.vigencia_desde > CURDATE()");
    }
    const search = normalizarTexto(req.query.search, { maximo: 120 });
    if (search) {
      condiciones.push("(r.codigo LIKE ? OR r.nombre LIKE ? OR r.descripcion LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const estadosNoConsumen = ESTADOS_RESERVA_NO_CONSUMEN.map(() => "?").join(",");
    const [rows] = await db.query(
      `SELECT r.*,
              (SELECT COUNT(*) FROM reserva_descuento rd
                 INNER JOIN reserva rv ON rv.id = rd.reserva_id
                 LEFT JOIN estado_reserva er ON er.id = rv.estado_reserva_id
                WHERE rd.regla_id = r.id AND COALESCE(er.nombre, '') NOT IN (${estadosNoConsumen})) AS usos,
              (SELECT COALESCE(SUM(rd.importe_descuento), 0) FROM reserva_descuento rd
                 INNER JOIN reserva rv ON rv.id = rd.reserva_id
                 LEFT JOIN estado_reserva er ON er.id = rv.estado_reserva_id
                WHERE rd.regla_id = r.id AND COALESCE(er.nombre, '') NOT IN (${estadosNoConsumen})) AS importe_total,
              (SELECT MAX(rd.fecha_creacion) FROM reserva_descuento rd WHERE rd.regla_id = r.id) AS ultimo_uso
         FROM descuento_regla r
        WHERE ${condiciones.join(" AND ")}
        ORDER BY FIELD(r.tipo, 'TIPO_VIAJE', 'CUPON'), r.habilitado DESC, r.orden ASC, r.nombre ASC
        LIMIT 500`,
      [...ESTADOS_RESERVA_NO_CONSUMEN, ...ESTADOS_RESERVA_NO_CONSUMEN, ...params]
    );
    const reglas = await cargarDetalleReglas(db, rows);
    return res.status(200).json({
      results: reglas.map((regla) => presentarReglaAdmin(regla, {
        usos: Number(regla.usos || 0),
        importe_total: Number(regla.importe_total || 0),
        ultimo_uso: regla.ultimo_uso || null,
        estado_vigencia: estadoVigencia(regla),
      })),
      totalItems: reglas.length,
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener los descuentos");
  }
});

function estadoVigencia(regla) {
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = regla.vigencia_desde ? String(regla.vigencia_desde).slice(0, 10) : null;
  const hasta = regla.vigencia_hasta ? String(regla.vigencia_hasta).slice(0, 10) : null;
  if (Number(regla.habilitado) !== 1) return "DESHABILITADO";
  if (desde && hoy < desde) return "PROGRAMADO";
  if (hasta && hoy > hasta) return "VENCIDO";
  return "VIGENTE";
}

router.get("/descuentos/admin/reglas/:id", verifyToken, async (req, res) => {
  try {
    exigirAdminDescuentos(req);
    const db = mysqlConnection.promise();
    const regla = await obtenerReglaPorId(db, req.params.id);
    if (!regla) throw crearError("El descuento no existe", 404, "DESCUENTO_INEXISTENTE");
    const [[usos]] = await db.query(
      `SELECT COUNT(*) AS usos, COALESCE(SUM(rd.importe_descuento), 0) AS importe_total
         FROM reserva_descuento rd
         INNER JOIN reserva rv ON rv.id = rd.reserva_id
         LEFT JOIN estado_reserva er ON er.id = rv.estado_reserva_id
        WHERE rd.regla_id = ? AND COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_NO_CONSUMEN.map(() => "?").join(",")})`,
      [regla.id, ...ESTADOS_RESERVA_NO_CONSUMEN]
    );
    return res.status(200).json(presentarReglaAdmin(regla, {
      usos: Number(usos.usos || 0),
      importe_total: Number(usos.importe_total || 0),
      estado_vigencia: estadoVigencia(regla),
    }));
  } catch (error) {
    return responderError(res, error, "Error al obtener el descuento");
  }
});

router.post("/descuentos/admin/reglas", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirAdminDescuentos(req);
    const datos = validarPayloadRegla(req.body || {});
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    await validarReferencias(connection, datos);
    const [duplicado] = await connection.query(
      "SELECT id FROM descuento_regla WHERE tipo = ? AND codigo = ? AND eliminado = 0 LIMIT 1",
      [datos.tipo, datos.codigo]
    );
    if (duplicado.length) {
      throw crearError(
        datos.tipo === "CUPON" ? `Ya existe un cupón #${datos.codigo}` : "Ya existe un tipo de viaje con ese código",
        409,
        "DESCUENTO_DUPLICADO"
      );
    }
    const [insercion] = await connection.query(
      `INSERT INTO descuento_regla
         (tipo, codigo, nombre, descripcion, porcentaje_descuento, base_calculo, incluye_adicionales, acumulable,
          requiere_comprobante, oculto, alcance_departamental, alcance_servicio, alcance_persona, edad_minima, edad_maxima,
          vigencia_desde, vigencia_hasta, usos_maximos, usos_por_afiliado, habilitado, orden, creado_por_usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.tipo, datos.codigo, datos.nombre, datos.descripcion, datos.porcentaje_descuento, datos.base_calculo,
        datos.incluye_adicionales, datos.acumulable, datos.requiere_comprobante, datos.oculto,
        datos.alcance_departamental, datos.alcance_servicio, datos.alcance_persona, datos.edad_minima, datos.edad_maxima,
        datos.vigencia_desde, datos.vigencia_hasta, datos.usos_maximos, datos.usos_por_afiliado, datos.habilitado,
        datos.orden, cabecera.id,
      ]
    );
    const reglaId = Number(insercion.insertId);
    await reemplazarDetalleRegla(connection, reglaId, datos);
    const creada = await obtenerReglaPorId(connection, reglaId);
    await registrarHistorialDescuento(connection, {
      reglaId, entidadTipo: "REGLA", entidadId: reglaId, operacion: "CREATE",
      resumen: `${datos.tipo === "CUPON" ? "Cupón #" + datos.codigo : "Tipo de viaje “" + datos.nombre + "”"} creado (${datos.porcentaje_descuento}% sobre ${datos.base_calculo === "PRECIO_LISTA" ? "precio de lista" : "precio final"})`,
      nuevo: snapshotRegla(creada), usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(201).json(presentarReglaAdmin(creada, { usos: 0, importe_total: 0, estado_vigencia: estadoVigencia(creada) }));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al crear el descuento");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/descuentos/admin/reglas/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirAdminDescuentos(req);
    const reglaId = normalizarIdPositivo(req.params.id);
    if (!reglaId) throw crearError("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [bloqueo] = await connection.query("SELECT * FROM descuento_regla WHERE id = ? AND eliminado = 0 FOR UPDATE", [reglaId]);
    if (!bloqueo.length) throw crearError("El descuento no existe", 404, "DESCUENTO_INEXISTENTE");
    const anterior = await obtenerReglaPorId(connection, reglaId);
    const datos = validarPayloadRegla(req.body || {}, { existente: anterior });
    await validarReferencias(connection, datos);
    const [duplicado] = await connection.query(
      "SELECT id FROM descuento_regla WHERE tipo = ? AND codigo = ? AND eliminado = 0 AND id <> ? LIMIT 1",
      [datos.tipo, datos.codigo, reglaId]
    );
    if (duplicado.length) {
      throw crearError(
        datos.tipo === "CUPON" ? `Ya existe otro cupón #${datos.codigo}` : "Ya existe otro tipo de viaje con ese código",
        409,
        "DESCUENTO_DUPLICADO"
      );
    }
    await connection.query(
      `UPDATE descuento_regla SET
         codigo = ?, nombre = ?, descripcion = ?, porcentaje_descuento = ?, base_calculo = ?, incluye_adicionales = ?,
         acumulable = ?, requiere_comprobante = ?, oculto = ?, alcance_departamental = ?, alcance_servicio = ?,
         alcance_persona = ?, edad_minima = ?, edad_maxima = ?, vigencia_desde = ?, vigencia_hasta = ?,
         usos_maximos = ?, usos_por_afiliado = ?, habilitado = ?, orden = ?
       WHERE id = ?`,
      [
        datos.codigo, datos.nombre, datos.descripcion, datos.porcentaje_descuento, datos.base_calculo, datos.incluye_adicionales,
        datos.acumulable, datos.requiere_comprobante, datos.oculto, datos.alcance_departamental, datos.alcance_servicio,
        datos.alcance_persona, datos.edad_minima, datos.edad_maxima, datos.vigencia_desde, datos.vigencia_hasta,
        datos.usos_maximos, datos.usos_por_afiliado, datos.habilitado, datos.orden, reglaId,
      ]
    );
    await reemplazarDetalleRegla(connection, reglaId, datos);
    const nueva = await obtenerReglaPorId(connection, reglaId);
    const snapshotAnterior = snapshotRegla(anterior);
    const snapshotNuevo = snapshotRegla(nueva);
    const cambios = describirCambios(snapshotAnterior, snapshotNuevo);
    await registrarHistorialDescuento(connection, {
      reglaId, entidadTipo: "REGLA", entidadId: reglaId, operacion: "UPDATE",
      resumen: `${etiquetaRegla(nueva)} actualizado${cambios.length ? ": " + cambios.join(", ") : " (sin cambios de datos)"}`,
      anterior: snapshotAnterior, nuevo: snapshotNuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json(presentarReglaAdmin(nueva, { estado_vigencia: estadoVigencia(nueva) }));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar el descuento");
  } finally {
    if (connection) connection.release();
  }
});

function etiquetaRegla(regla) {
  return regla.tipo === "CUPON" ? `Cupón #${regla.codigo}` : `Tipo de viaje “${regla.nombre}”`;
}

router.patch("/descuentos/admin/reglas/:id/habilitado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirAdminDescuentos(req);
    const reglaId = normalizarIdPositivo(req.params.id);
    const habilitado = normalizarBooleano(req.body?.habilitado, null);
    if (!reglaId || habilitado === null) throw crearError("Los datos no son válidos", 400, "DESCUENTO_OPCION_INVALIDA");
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerReglaPorId(connection, reglaId);
    if (!anterior) throw crearError("El descuento no existe", 404, "DESCUENTO_INEXISTENTE");
    await connection.query("UPDATE descuento_regla SET habilitado = ? WHERE id = ?", [habilitado, reglaId]);
    const nueva = await obtenerReglaPorId(connection, reglaId);
    await registrarHistorialDescuento(connection, {
      reglaId, entidadTipo: "REGLA", entidadId: reglaId, operacion: habilitado ? "ENABLE" : "DISABLE",
      resumen: `${etiquetaRegla(nueva)} ${habilitado ? "habilitado" : "deshabilitado"}`,
      anterior: { habilitado: Number(anterior.habilitado) === 1 }, nuevo: { habilitado: habilitado === 1 },
      usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json(presentarReglaAdmin(nueva, { estado_vigencia: estadoVigencia(nueva) }));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al cambiar el estado del descuento");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/descuentos/admin/reglas/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirAdminDescuentos(req);
    const reglaId = normalizarIdPositivo(req.params.id);
    if (!reglaId) throw crearError("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerReglaPorId(connection, reglaId);
    if (!anterior) throw crearError("El descuento no existe", 404, "DESCUENTO_INEXISTENTE");
    // Baja lógica: los usos históricos conservan su snapshot y la referencia.
    await connection.query("UPDATE descuento_regla SET eliminado = 1, habilitado = 0 WHERE id = ?", [reglaId]);
    await registrarHistorialDescuento(connection, {
      reglaId, entidadTipo: "REGLA", entidadId: reglaId, operacion: "DELETE",
      resumen: `${etiquetaRegla(anterior)} eliminado`, anterior: snapshotRegla(anterior), usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ success: true });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al eliminar el descuento");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// Usos, métricas e historial
// ---------------------------------------------------------------------------

function construirFiltrosUsos(query) {
  const condiciones = ["1=1"];
  const params = [];
  const reglaId = normalizarIdPositivo(query.regla_id);
  if (reglaId) { condiciones.push("rd.regla_id = ?"); params.push(reglaId); }
  const tipo = String(query.tipo || "").toUpperCase();
  if (tipo && TIPOS_REGLA.includes(tipo)) { condiciones.push("rd.tipo = ?"); params.push(tipo); }
  const departamentalId = normalizarIdPositivo(query.departamental_id);
  if (departamentalId) { condiciones.push("COALESCE(rd.departamental_id, u.departamental_id) = ?"); params.push(departamentalId); }
  const servicioId = normalizarIdPositivo(query.servicio_id);
  if (servicioId) { condiciones.push("COALESCE(rd.servicio_id, r.servicio_id) = ?"); params.push(servicioId); }
  const desde = query.desde ? normalizarFechaCivil(String(query.desde).slice(0, 10)) : null;
  if (desde) { condiciones.push("rd.fecha_creacion >= ?"); params.push(`${desde} 00:00:00`); }
  const hasta = query.hasta ? normalizarFechaCivil(String(query.hasta).slice(0, 10)) : null;
  if (hasta) { condiciones.push("rd.fecha_creacion <= ?"); params.push(`${hasta} 23:59:59`); }
  if (normalizarBooleano(query.solo_sin_comprobante, 0) === 1) {
    condiciones.push("rd.requiere_comprobante = 1 AND NOT EXISTS (SELECT 1 FROM reserva_descuento_archivo a WHERE a.reserva_descuento_id = rd.id)");
  }
  const search = normalizarTexto(query.search, { maximo: 120 });
  if (search) {
    const like = `%${search}%`;
    condiciones.push(`(CAST(rd.reserva_id AS CHAR) LIKE ? OR rd.codigo LIKE ? OR rd.nombre LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ?
      OR CAST(u.documento AS CHAR) LIKE ? OR d.nombre LIKE ? OR s.nombre LIKE ? OR er.nombre LIKE ?)`);
    params.push(like, like, like, like, like, like, like, like, like);
  }
  return { where: condiciones.join(" AND "), params };
}

const SQL_USOS_FROM = `
  FROM reserva_descuento rd
  INNER JOIN reserva r ON r.id = rd.reserva_id
  INNER JOIN usuario u ON u.id = r.usuario_id
  LEFT JOIN departamental d ON d.id = COALESCE(rd.departamental_id, u.departamental_id)
  LEFT JOIN servicio s ON s.id = COALESCE(rd.servicio_id, r.servicio_id)
  LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id`;

router.get("/descuentos/admin/usos", verifyToken, async (req, res) => {
  try {
    exigirAdminDescuentos(req);
    const db = mysqlConnection.promise();
    const paginacion = normalizarPaginacion(req.query, 20);
    if (!paginacion) throw crearError("La paginación no es válida", 400);
    const { where, params } = construirFiltrosUsos(req.query);
    const ordenables = {
      fecha: "rd.fecha_creacion",
      reserva: "rd.reserva_id",
      importe: "rd.importe_descuento",
      afiliado: "u.apellido",
      departamental: "d.nombre",
      servicio: "s.nombre",
    };
    const orderBy = Object.prototype.hasOwnProperty.call(ordenables, String(req.query.orderBy || ""))
      ? ordenables[String(req.query.orderBy)]
      : ordenables.fecha;
    const orderType = String(req.query.orderType || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const [rows] = await db.query(
      `SELECT rd.id, rd.reserva_id, rd.regla_id, rd.tipo, rd.codigo, rd.nombre, rd.porcentaje_aplicado, rd.base_calculo,
              rd.importe_base, rd.importe_descuento, rd.requiere_comprobante, rd.fecha_creacion,
              u.id AS usuario_id, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
              d.id AS departamental_id, d.nombre AS departamental_nombre,
              s.id AS servicio_id, s.nombre AS servicio_nombre,
              r.fecha_inicio, r.fecha_fin, r.precio_total, r.monto_descuentos, er.nombre AS estado_reserva,
              (SELECT COUNT(*) FROM reserva_descuento_archivo a WHERE a.reserva_descuento_id = rd.id) AS comprobantes
         ${SQL_USOS_FROM}
        WHERE ${where}
        ORDER BY ${orderBy} ${orderType}, rd.id DESC
        LIMIT ? OFFSET ?`,
      [...params, paginacion.pageSize, paginacion.offset]
    );
    const [[conteo]] = await db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(rd.importe_descuento), 0) AS importe_total ${SQL_USOS_FROM} WHERE ${where}`,
      params
    );
    return res.status(200).json({
      results: rows.map((fila) => ({
        ...fila,
        porcentaje_aplicado: Number(fila.porcentaje_aplicado),
        importe_base: Number(fila.importe_base),
        importe_descuento: Number(fila.importe_descuento),
        precio_total: fila.precio_total === null ? null : Number(fila.precio_total),
        monto_descuentos: Number(fila.monto_descuentos || 0),
        requiere_comprobante: Number(fila.requiere_comprobante) === 1,
        comprobantes: Number(fila.comprobantes || 0),
        comprobante_pendiente: Number(fila.requiere_comprobante) === 1 && Number(fila.comprobantes || 0) === 0,
      })),
      totalItems: Number(conteo.total || 0),
      importe_total: Number(conteo.importe_total || 0),
      page: paginacion.page,
      pageSize: paginacion.pageSize,
      numOfPages: Math.ceil(Number(conteo.total || 0) / paginacion.pageSize),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener los usos de descuentos");
  }
});

router.get("/descuentos/admin/metricas", verifyToken, async (req, res) => {
  try {
    exigirAdminDescuentos(req);
    const db = mysqlConnection.promise();
    const desde = req.query.desde ? normalizarFechaCivil(String(req.query.desde).slice(0, 10)) : null;
    const hasta = req.query.hasta ? normalizarFechaCivil(String(req.query.hasta).slice(0, 10)) : null;
    const condiciones = [`COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_NO_CONSUMEN.map(() => "?").join(",")})`];
    const params = [...ESTADOS_RESERVA_NO_CONSUMEN];
    if (desde) { condiciones.push("rd.fecha_creacion >= ?"); params.push(`${desde} 00:00:00`); }
    if (hasta) { condiciones.push("rd.fecha_creacion <= ?"); params.push(`${hasta} 23:59:59`); }
    const where = condiciones.join(" AND ");

    const [[totales]] = await db.query(
      `SELECT COUNT(*) AS usos,
              COUNT(DISTINCT rd.reserva_id) AS reservas,
              COALESCE(SUM(rd.importe_descuento), 0) AS importe_total,
              COALESCE(SUM(rd.importe_base), 0) AS base_total,
              COALESCE(SUM(CASE WHEN rd.tipo = 'CUPON' THEN 1 ELSE 0 END), 0) AS usos_cupon,
              COALESCE(SUM(CASE WHEN rd.tipo = 'TIPO_VIAJE' THEN 1 ELSE 0 END), 0) AS usos_tipo_viaje,
              COALESCE(SUM(CASE WHEN rd.tipo = 'CUPON' THEN rd.importe_descuento ELSE 0 END), 0) AS importe_cupon,
              COALESCE(SUM(CASE WHEN rd.tipo = 'TIPO_VIAJE' THEN rd.importe_descuento ELSE 0 END), 0) AS importe_tipo_viaje,
              COALESCE(SUM(CASE WHEN rd.requiere_comprobante = 1
                AND NOT EXISTS (SELECT 1 FROM reserva_descuento_archivo a WHERE a.reserva_descuento_id = rd.id) THEN 1 ELSE 0 END), 0) AS comprobantes_pendientes
         ${SQL_USOS_FROM}
        WHERE ${where}`,
      params
    );
    const [porRegla] = await db.query(
      `SELECT rd.regla_id, rd.tipo, rd.codigo, rd.nombre, COUNT(*) AS usos, COALESCE(SUM(rd.importe_descuento), 0) AS importe_total
         ${SQL_USOS_FROM}
        WHERE ${where}
        GROUP BY rd.regla_id, rd.tipo, rd.codigo, rd.nombre
        ORDER BY usos DESC, importe_total DESC
        LIMIT 12`,
      params
    );
    const [porDepartamental] = await db.query(
      `SELECT d.id AS departamental_id, COALESCE(d.nombre, 'Sin departamental') AS departamental_nombre,
              COUNT(*) AS usos, COALESCE(SUM(rd.importe_descuento), 0) AS importe_total
         ${SQL_USOS_FROM}
        WHERE ${where}
        GROUP BY d.id, d.nombre
        ORDER BY usos DESC, importe_total DESC`,
      params
    );
    const [porServicio] = await db.query(
      `SELECT s.id AS servicio_id, COALESCE(s.nombre, 'Sin servicio') AS servicio_nombre,
              COUNT(*) AS usos, COALESCE(SUM(rd.importe_descuento), 0) AS importe_total
         ${SQL_USOS_FROM}
        WHERE ${where}
        GROUP BY s.id, s.nombre
        ORDER BY usos DESC, importe_total DESC
        LIMIT 12`,
      params
    );
    const [porMes] = await db.query(
      `SELECT DATE_FORMAT(rd.fecha_creacion, '%Y-%m') AS mes, COUNT(*) AS usos, COALESCE(SUM(rd.importe_descuento), 0) AS importe_total
         ${SQL_USOS_FROM}
        WHERE COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_NO_CONSUMEN.map(() => "?").join(",")})
          AND rd.fecha_creacion >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
        GROUP BY DATE_FORMAT(rd.fecha_creacion, '%Y-%m')
        ORDER BY mes`,
      [...ESTADOS_RESERVA_NO_CONSUMEN]
    );
    const [[reglas]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'CUPON' AND habilitado = 1 THEN 1 ELSE 0 END), 0) AS cupones_activos,
              COALESCE(SUM(CASE WHEN tipo = 'TIPO_VIAJE' AND habilitado = 1 THEN 1 ELSE 0 END), 0) AS tipos_viaje_activos,
              COUNT(*) AS reglas_total
         FROM descuento_regla WHERE eliminado = 0`
    );
    const [[salud]] = await db.query(
      `SELECT COALESCE(SUM(descuento_salud_estado = 'HABILITADO'), 0) AS servicios_habilitados,
              COALESCE(SUM(descuento_salud_estado = 'PENDIENTE'), 0) AS servicios_pendientes
         FROM servicio`
    );
    const [saludReservas] = await db.query(
      `SELECT rs.estado, COUNT(*) AS cantidad, COALESCE(SUM(rs.precio_cubierto), 0) AS importe_cubierto
         FROM reserva_salud rs
        ${desde || hasta ? "WHERE 1=1" : ""}
        ${desde ? " AND rs.fecha_creacion >= ?" : ""}
        ${hasta ? " AND rs.fecha_creacion <= ?" : ""}
        GROUP BY rs.estado`,
      [...(desde ? [`${desde} 00:00:00`] : []), ...(hasta ? [`${hasta} 23:59:59`] : [])]
    );
    return res.status(200).json({
      periodo: { desde, hasta },
      totales: {
        usos: Number(totales.usos || 0),
        reservas: Number(totales.reservas || 0),
        importe_total: Number(totales.importe_total || 0),
        base_total: Number(totales.base_total || 0),
        usos_cupon: Number(totales.usos_cupon || 0),
        usos_tipo_viaje: Number(totales.usos_tipo_viaje || 0),
        importe_cupon: Number(totales.importe_cupon || 0),
        importe_tipo_viaje: Number(totales.importe_tipo_viaje || 0),
        comprobantes_pendientes: Number(totales.comprobantes_pendientes || 0),
        cupones_activos: Number(reglas.cupones_activos || 0),
        tipos_viaje_activos: Number(reglas.tipos_viaje_activos || 0),
        reglas_total: Number(reglas.reglas_total || 0),
        servicios_salud_habilitados: Number(salud.servicios_habilitados || 0),
        servicios_salud_pendientes: Number(salud.servicios_pendientes || 0),
      },
      por_regla: porRegla.map((fila) => ({ ...fila, usos: Number(fila.usos), importe_total: Number(fila.importe_total) })),
      por_departamental: porDepartamental.map((fila) => ({ ...fila, usos: Number(fila.usos), importe_total: Number(fila.importe_total) })),
      por_servicio: porServicio.map((fila) => ({ ...fila, usos: Number(fila.usos), importe_total: Number(fila.importe_total) })),
      por_mes: porMes.map((fila) => ({ mes: fila.mes, usos: Number(fila.usos), importe_total: Number(fila.importe_total) })),
      salud: saludReservas.map((fila) => ({ estado: fila.estado, cantidad: Number(fila.cantidad), importe_cubierto: Number(fila.importe_cubierto) })),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener las métricas de descuentos");
  }
});

router.get("/descuentos/admin/historial", verifyToken, async (req, res) => {
  try {
    exigirAdminDescuentos(req);
    const db = mysqlConnection.promise();
    const paginacion = normalizarPaginacion(req.query, 30);
    if (!paginacion) throw crearError("La paginación no es válida", 400);
    const condiciones = ["1=1"];
    const params = [];
    const reglaId = normalizarIdPositivo(req.query.regla_id);
    if (reglaId) { condiciones.push("h.regla_id = ?"); params.push(reglaId); }
    const reservaId = normalizarIdPositivo(req.query.reserva_id);
    if (reservaId) { condiciones.push("h.reserva_id = ?"); params.push(reservaId); }
    const servicioId = normalizarIdPositivo(req.query.servicio_id);
    if (servicioId) { condiciones.push("h.servicio_id = ?"); params.push(servicioId); }
    const entidad = String(req.query.entidad_tipo || "").toUpperCase();
    if (["REGLA", "USO", "COMPROBANTE", "SERVICIO_SALUD"].includes(entidad)) { condiciones.push("h.entidad_tipo = ?"); params.push(entidad); }
    const desde = req.query.desde ? normalizarFechaCivil(String(req.query.desde).slice(0, 10)) : null;
    if (desde) { condiciones.push("h.fecha_creacion >= ?"); params.push(`${desde} 00:00:00`); }
    const hasta = req.query.hasta ? normalizarFechaCivil(String(req.query.hasta).slice(0, 10)) : null;
    if (hasta) { condiciones.push("h.fecha_creacion <= ?"); params.push(`${hasta} 23:59:59`); }
    const search = normalizarTexto(req.query.search, { maximo: 120 });
    if (search) {
      const like = `%${search}%`;
      condiciones.push("(h.resumen LIKE ? OR CONCAT(u.nombre, ' ', u.apellido) LIKE ? OR r.nombre LIKE ? OR r.codigo LIKE ? OR CAST(h.reserva_id AS CHAR) LIKE ?)");
      params.push(like, like, like, like, like);
    }
    const where = condiciones.join(" AND ");
    const [rows] = await db.query(
      `SELECT h.*, CONCAT(u.nombre, ' ', u.apellido) AS usuario_nombre, rol.nombre AS usuario_rol,
              r.nombre AS regla_nombre, r.codigo AS regla_codigo, r.tipo AS regla_tipo, s.nombre AS servicio_nombre
         FROM descuento_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
         LEFT JOIN rol ON rol.id = u.rol_id
         LEFT JOIN descuento_regla r ON r.id = h.regla_id
         LEFT JOIN servicio s ON s.id = h.servicio_id
        WHERE ${where}
        ORDER BY h.fecha_creacion DESC, h.id DESC
        LIMIT ? OFFSET ?`,
      [...params, paginacion.pageSize, paginacion.offset]
    );
    const [[conteo]] = await db.query(
      `SELECT COUNT(*) AS total FROM descuento_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
         LEFT JOIN descuento_regla r ON r.id = h.regla_id
        WHERE ${where}`,
      params
    );
    return res.status(200).json({
      results: rows.map((fila) => ({
        ...fila,
        valor_anterior: parsearJson(fila.valor_anterior),
        valor_nuevo: parsearJson(fila.valor_nuevo),
      })),
      totalItems: Number(conteo.total || 0),
      page: paginacion.page,
      pageSize: paginacion.pageSize,
      numOfPages: Math.ceil(Number(conteo.total || 0) / paginacion.pageSize),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener el historial de descuentos");
  }
});

function parsearJson(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "object") return valor;
  try {
    return JSON.parse(valor);
  } catch (_error) {
    return null;
  }
}

// Panorama del "descuento médico" por servicio: admin y admin-central ven todos
// los servicios (y resuelven las solicitudes pendientes desde el módulo de
// servicios); la departamental ve el estado de los propios.
router.get("/descuentos/admin/servicios-salud", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    if (!["admin", "admin-central", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      throw crearError("No autorizado", 403, "DESCUENTOS_NO_AUTORIZADO");
    }
    const db = mysqlConnection.promise();
    const condiciones = ["1=1"];
    const params = [];
    if (cabecera.rol === "departamental") {
      condiciones.push("s.propietario_departamental_id = ?");
      params.push(normalizarIdPositivo(cabecera.departamental_id) || 0);
    }
    const [rows] = await db.query(
      `SELECT s.id, s.nombre, s.lugar, s.activo, s.estado_aprobacion, ts.codigo AS tipo_codigo,
              s.propietario_departamental_id, d.nombre AS propietario_nombre,
              s.descuento_salud_estado, s.descuento_salud_motivo, s.descuento_salud_fecha_solicitud,
              CONCAT(us.nombre, ' ', us.apellido) AS descuento_salud_solicitado_por,
              (SELECT COUNT(*) FROM reserva r WHERE r.servicio_id = s.id AND r.es_por_salud = 1) AS reservas_salud
         FROM servicio s
         INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
         LEFT JOIN departamental d ON d.id = s.propietario_departamental_id
         LEFT JOIN usuario us ON us.id = s.descuento_salud_solicitado_por_usuario_id
        WHERE ${condiciones.join(" AND ")}
        ORDER BY FIELD(s.descuento_salud_estado, 'PENDIENTE', 'HABILITADO', 'DESHABILITADO'), s.nombre`,
      params
    );
    return res.status(200).json({
      results: rows.map((fila) => ({
        ...fila,
        activo: Number(fila.activo) === 1,
        reservas_salud: Number(fila.reservas_salud || 0),
        puede_resolver: puedeAprobarTurismo(cabecera) && fila.descuento_salud_estado === "PENDIENTE",
        puede_gestionar: puedeAprobarTurismo(cabecera)
          || (cabecera.rol === "departamental" && Number(fila.propietario_departamental_id) === Number(cabecera.departamental_id)),
      })),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener los servicios con descuento médico");
  }
});

module.exports = router;
