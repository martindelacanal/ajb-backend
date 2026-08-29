const express = require("express");
const router = express.Router();

const mysqlConnection = require("../connection/connection");
const { registrarErrorRuta } = require("../services/errores");

const jwt = require("jsonwebtoken");

const bcryptjs = require("bcryptjs");

const { normalizarCredencialesSignin } = require("../security/signin-input");
const { DNI_MENSAJE, esDniValido } = require("../security/dni");
const { verificarTokenConAutorizacionActual } = require("../security/autorizacion-sesion");
const { condicionModuloNotificacion } = require("../services/notificaciones-modulos");

const multer = require("multer");

const moment = require("moment"); // para formatear fechas
const {
  obtenerCalendarioAlternativoServicio,
  obtenerSnapshotDisponibilidad,
  obtenerServicios,
  parsearParametrosBusquedaDisponibilidad,
  parsearServicioIdsCsv,
} = require("../services/servicios-disponibilidad");
const {
  CATALOGOS_HISTORIAL_RESERVA,
  CATALOGOS_HISTORIAL_USUARIO,
  crearEnriquecimientoHistorial,
} = require("../services/historial-legible");
const {
  aplicarDescuentoEnPuntosBase,
  calcularEdadEnFecha,
  centavosANumero,
  decimalACentavos,
  decimalAPuntosBase,
  diferenciaDiasCivil,
  fechaCivilAIndice,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  obtenerNochesReserva,
  revertirDescuentoEnPuntosBase,
  sumarCentavos,
  sumarDiasFechaCivil,
  validarCbu,
  validarCuitCuil,
  validarRangoReservaTemporal,
} = require("../services/valores-dominio");
const {
  archivarVersionReservaAntesDeReemplazo,
  cerrarGuardiaArchivoReserva,
  limpiarTokenGuardiaArchivoReserva,
} = require("../services/reserva-version-archivo");
const {
  estadoInicialSorteoPermitido,
  esEstadoReservaTerminal,
  obtenerEstadoRecursoTrasLiberacion,
  obtenerEstadoRecursoTrasRechazo,
  validarAdjudicacionSorteo,
  validarRespuestaAdjudicacion,
} = require("../services/sorteos-vigencia");
const {
  ESTADO_APROBADA,
  ESTADO_CONVENIO_RECHAZADO,
  ESTADO_INICIADA,
  ESTADO_RECHAZADA,
  ESTADO_VERIFICADA,
  PLAZO_RESPUESTA_HORAS,
  asegurarSinReservaIniciadaAfiliado,
  expirarPropuestaConvenioEnTransaccion,
  obtenerEstadoAltaTurismo,
  validarTransicionTurismo,
} = require("../services/reservas-turismo");
const {
  adquirirHoldTurismo,
  asegurarSinHoldAjenoEnTransaccion,
  consumirHoldEnTransaccion,
  contarHoldsActivosPorBloque,
  crearEventoInvalidacionHold,
  liberarHoldTurismo,
  obtenerEstadoHold,
  obtenerHoldIdActivoPorToken,
  obtenerNumerosParcelasRetenidas,
  obtenerRecursosRetenidos,
  validarHoldParaReservaEnTransaccion,
} = require("../services/turismo-reserva-holds");

const HISTORIAL_USUARIO_LEGIBLE = crearEnriquecimientoHistorial(
  CATALOGOS_HISTORIAL_USUARIO
);
const HISTORIAL_RESERVA_LEGIBLE = crearEnriquecimientoHistorial(
  CATALOGOS_HISTORIAL_RESERVA
);

// S3 INICIO
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;

const crypto = require("crypto");

const s3SignedUrlExpiresConfigurado = Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600");
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.isSafeInteger(s3SignedUrlExpiresConfigurado)
  && s3SignedUrlExpiresConfigurado >= 60
  && s3SignedUrlExpiresConfigurado <= 86400
  ? s3SignedUrlExpiresConfigurado
  : 3600;

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const MIME_IMAGEN_RASTER_PERMITIDO = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function contenidoCoincideConMime(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;

  switch (file.mimetype) {
    case "image/jpeg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a";
    case "image/webp":
      return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    case "application/pdf":
      return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    default:
      return false;
  }
}

function archivosSubidos(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

function validarContenidoArchivos(req, res, next) {
  if (archivosSubidos(req).every(contenidoCoincideConMime)) {
    next();
    return;
  }
  res.status(400).json("El contenido del archivo no coincide con un formato permitido");
}

const s3 = new S3Client({
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretAccessKey,
  },
  region: bucketRegion,
});

// Áreas por usuario: los roles departamental y admin-central pueden estar limitados a
// Turismo y/o Coseguro (usuario.area_turismo / usuario.area_coseguro, asignadas por el
// admin). Acá solo importa el área Turismo: un empleado "departamental con coseguro"
// no puede manipular reservas turísticas regulares. Los tokens emitidos antes de la
// migración no traen los flags y se tratan como habilitados (default 1).
const ROLES_CON_AREA = ["departamental", "admin-central"];

function moduloHabilitado(cabecera, campo) {
  if (cabecera.rol !== "afiliado") return true;
  const valor = cabecera[campo];
  // Los tokens emitidos antes de la migracion conservan acceso hasta el
  // siguiente inicio de sesion. Las columnas nuevas nacen habilitadas.
  return valor === undefined || valor === null || Number(valor) === 1;
}

function tieneModuloTurismo(cabecera) {
  return moduloHabilitado(cabecera, "modulo_turismo");
}

function tieneModuloCoseguro(cabecera) {
  return moduloHabilitado(cabecera, "modulo_coseguro");
}

function tieneModuloOlimpiadas(cabecera) {
  return moduloHabilitado(cabecera, "modulo_olimpiadas");
}

function tieneAreaTurismo(cabecera) {
  if (!tieneModuloTurismo(cabecera)) return false;
  if (!ROLES_CON_AREA.includes(cabecera.rol)) return true;
  return cabecera.area_turismo === undefined || cabecera.area_turismo === null || Number(cabecera.area_turismo) === 1;
}

function puedeVerDatosSaludReserva(cabecera) {
  if (cabecera.rol === "admin") return true;
  if (cabecera.rol === "afiliado") return tieneModuloCoseguro(cabecera);
  return ["departamental", "admin-central", "auditor"].includes(cabecera.rol) &&
    Number(cabecera.area_coseguro) === 1;
}

function getMimeTypeFromFileName(fileName, fallback = "application/octet-stream") {
  const extension = (fileName || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || fallback;
}

function getSafeFileExtension(originalName, mimeType) {
  return EXTENSION_BY_MIME[mimeType] || "bin";
}

function isS3ObjectNotFound(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function streamToBuffer(stream) {
  if (!stream) {
    return null;
  }

  if (Buffer.isBuffer(stream)) {
    return stream;
  }

  if (stream instanceof Uint8Array) {
    return Buffer.from(stream);
  }

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function uploadBufferToS3({ key, buffer, contentType }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType || getMimeTypeFromFileName(key),
    })
  );
}

async function uploadBase64ToS3({ key, value, defaultContentType = "image/png" }) {
  if (typeof value !== "string" || value.length > 3 * 1024 * 1024) {
    const error = new Error("La firma es invalida o supera el limite permitido");
    error.statusCode = 400;
    throw error;
  }
  const dataUriMatch = value.match(/^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (value.startsWith("data:") && !dataUriMatch) {
    const error = new Error("La firma debe ser una imagen PNG");
    error.statusCode = 400;
    throw error;
  }
  const contentType = dataUriMatch ? "image/png" : defaultContentType;
  const base64Payload = (dataUriMatch ? dataUriMatch[2] : value).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) {
    const error = new Error("La firma no contiene base64 valido");
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(base64Payload, "base64");
  if (!contenidoCoincideConMime({ buffer, mimetype: "image/png" })) {
    const error = new Error("La firma no contiene una imagen PNG valida");
    error.statusCode = 400;
    throw error;
  }

  await uploadBufferToS3({
    key,
    buffer,
    contentType,
  });
}

async function getObjectBufferFromS3(key) {
  try {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );

    return {
      buffer: await streamToBuffer(object.Body),
      contentType: object.ContentType || getMimeTypeFromFileName(key, "image/jpeg"),
    };
  } catch (error) {
    if (isS3ObjectNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function getSignedFileUrlFromS3(key) {
  if (!key) {
    return null;
  }

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
    { expiresIn: Number.isFinite(S3_SIGNED_URL_EXPIRES_SECONDS) ? S3_SIGNED_URL_EXPIRES_SECONDS : 3600 }
  );
}

async function deleteFileFromS3(key) {
  if (!key) {
    return;
  }

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
}
// S3 FIN

const uploadConvenioHotel = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 11,
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "fotos" && MIME_IMAGEN_RASTER_PERMITIDO.has(file.mimetype)) {
      return cb(null, true);
    }
    if (file.fieldname === "tarifario_pdf" && file.mimetype === "application/pdf") {
      return cb(null, true);
    }
    return cb(new Error("Solo se permiten fotos de imagen y un PDF tarifario"));
  },
});

const procesarUploadConvenioHotel = uploadConvenioHotel.fields([
  { name: "fotos", maxCount: 10 },
  { name: "tarifario_pdf", maxCount: 1 },
]);

function manejarUploadConvenioHotel(req, res, next) {
  procesarUploadConvenioHotel(req, res, (error) => {
    if (error) {
      return res.status(400).json(error.message || "No se pudieron procesar los archivos");
    }
    return validarContenidoArchivos(req, res, next);
  });
}

const uploadTurismoPropuesta = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 8 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "imagen" && MIME_IMAGEN_RASTER_PERMITIDO.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error("Solo se permite una imagen"));
  },
}).single("imagen");

function manejarUploadTurismoPropuesta(req, res, next) {
  uploadTurismoPropuesta(req, res, (error) => {
    if (error) {
      return res.status(400).json(error.message || "No se pudo procesar la imagen");
    }
    return validarContenidoArchivos(req, res, next);
  });
}

const uploadTurismoTestimonio = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "foto" && MIME_IMAGEN_RASTER_PERMITIDO.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error("Solo se permite una imagen de perfil"));
  },
}).single("foto");

function manejarUploadTurismoTestimonio(req, res, next) {
  uploadTurismoTestimonio(req, res, (error) => {
    if (error) {
      return res.status(400).json(error.message || "No se pudo procesar la foto");
    }
    return validarContenidoArchivos(req, res, next);
  });
}

const uploadLoginImagen = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 15 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (
      file.fieldname === "imagen" &&
      ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)
    ) {
      return cb(null, true);
    }
    return cb(new Error("Solo se permiten imagenes JPG, PNG o WebP"));
  },
}).single("imagen");

function manejarUploadLoginImagen(req, res, next) {
  uploadLoginImagen(req, res, (error) => {
    if (error) {
      return res.status(400).json(error.message || "No se pudo procesar la imagen");
    }
    return validarContenidoArchivos(req, res, next);
  });
}

router.get("/login/imagenes", async (req, res) => {
  try {
    const imagenes = await obtenerImagenesLogin(mysqlConnection.promise(), { soloActivas: true });
    res.status(200).json(imagenes);
  } catch (error) {
    console.error("Error al obtener las imagenes del login:", error);
    res.status(500).json("Error al obtener las imagenes del login");
  }
});

router.get("/admin/login/imagenes", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const imagenes = await obtenerImagenesLogin(mysqlConnection.promise());
    res.status(200).json(imagenes);
  } catch (error) {
    console.error("Error al obtener la galeria del login:", error);
    res.status(500).json("Error al obtener la galeria del login");
  }
});

router.post("/admin/login/imagenes", verifyToken, manejarUploadLoginImagen, async (req, res) => {
  let archivo = null;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }
    if (!req.file) {
      return res.status(400).json("La imagen es requerida");
    }

    const datos = validarDatosImagenLogin(req.body);
    if (datos.error) {
      return res.status(400).json(datos.error);
    }

    archivo = await subirImagenLogin(req.file);
    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      `
        INSERT INTO login_imagen
          (archivo, nombre_original, activo, orden)
        VALUES (?, ?, ?, ?)
      `,
      [archivo, req.file.originalname, datos.activo, datos.orden]
    );

    const imagenes = await obtenerImagenesLogin(db, { imagenId: resultado.insertId });
    res.status(201).json(imagenes[0]);
  } catch (error) {
    if (archivo) {
      try {
        await deleteFileFromS3(archivo);
      } catch (deleteError) {
        console.error("No se pudo limpiar el archivo de login luego del error:", deleteError);
      }
    }
    console.error("Error al crear la imagen del login:", error);
    res.status(500).json("Error al crear la imagen del login");
  }
});

router.put("/admin/login/imagenes/:id", verifyToken, manejarUploadLoginImagen, async (req, res) => {
  let connection;
  let archivoNuevo = null;
  let archivoAnterior = null;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const imagenId = normalizarIdPositivo(req.params.id);
    if (!imagenId) {
      return res.status(400).json("ID invalido");
    }
    const datos = validarDatosImagenLogin(req.body);
    if (datos.error) {
      return res.status(400).json(datos.error);
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [existentes] = await connection.query(
      "SELECT * FROM login_imagen WHERE id = ? LIMIT 1 FOR UPDATE",
      [imagenId]
    );
    if (existentes.length === 0) {
      await connection.rollback();
      return res.status(404).json("Imagen del login no encontrada");
    }

    archivoAnterior = existentes[0].archivo;
    archivoNuevo = req.file ? await subirImagenLogin(req.file) : archivoAnterior;
    const nombreOriginal = req.file ? req.file.originalname : existentes[0].nombre_original;

    await connection.query(
      `
        UPDATE login_imagen
        SET archivo = ?, nombre_original = ?, activo = ?, orden = ?
        WHERE id = ?
      `,
      [archivoNuevo, nombreOriginal, datos.activo, datos.orden, imagenId]
    );
    await connection.commit();

    if (req.file && archivoAnterior && archivoAnterior !== archivoNuevo) {
      try {
        await deleteFileFromS3(archivoAnterior);
      } catch (deleteError) {
        console.error("No se pudo borrar la version anterior de la imagen del login:", deleteError);
      }
    }

    const imagenes = await obtenerImagenesLogin(mysqlConnection.promise(), { imagenId });
    res.status(200).json(imagenes[0]);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    if (req.file && archivoNuevo && archivoNuevo !== archivoAnterior) {
      try {
        await deleteFileFromS3(archivoNuevo);
      } catch (deleteError) {
        console.error("No se pudo limpiar la nueva imagen del login:", deleteError);
      }
    }
    console.error("Error al actualizar la imagen del login:", error);
    res.status(500).json("Error al actualizar la imagen del login");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.delete("/admin/login/imagenes/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const imagenId = normalizarIdPositivo(req.params.id);
    if (!imagenId) {
      return res.status(400).json("ID invalido");
    }

    const db = mysqlConnection.promise();
    const [existentes] = await db.query(
      "SELECT archivo FROM login_imagen WHERE id = ? LIMIT 1",
      [imagenId]
    );
    if (existentes.length === 0) {
      return res.status(404).json("Imagen del login no encontrada");
    }

    await db.query("DELETE FROM login_imagen WHERE id = ?", [imagenId]);
    try {
      await deleteFileFromS3(existentes[0].archivo);
    } catch (deleteError) {
      console.error("No se pudo borrar de S3 la imagen eliminada del login:", deleteError);
    }

    res.status(200).json({ id: imagenId });
  } catch (error) {
    console.error("Error al eliminar la imagen del login:", error);
    res.status(500).json("Error al eliminar la imagen del login");
  }
});

router.post("/signin", async (req, res) => {
  const { documento, password, recordar, validas } = normalizarCredencialesSignin(req.body);

  if (!validas) {
    return res.status(400).json("Documento o contraseña invalidos");
  }

  const query = `
    SELECT u.id, u.nombre, u.apellido, u.documento, u.email, u.password, u.departamental_id, rol.nombre AS rol, u.habilitado,
           u.area_turismo, u.area_coseguro,
           u.modulo_turismo, u.modulo_coseguro, u.modulo_olimpiadas
    FROM usuario as u
    INNER JOIN rol ON rol.id = u.rol_id
    WHERE u.documento = ? AND u.password IS NOT NULL AND u.rol_id <> 4
  `;
  const queryParams = [documento];

  mysqlConnection.query(query, queryParams, async (err, rows, fields) => {
    if (!err) {
      if (rows.length > 0 && (await bcryptjs.compare(password, rows[0].password))) {
        if (rows[0].habilitado === "N") {
          res.status(403).json("Usuario inhabilitado");
        } else {
          delete rows[0].password;
          let data = rows[0];

          let tokenData = JSON.stringify(data);
          const expiresIn = recordar ? "7d" : "8h";
          jwt.sign({ data: tokenData }, process.env.JWT_SECRET, { expiresIn }, (err, token) => {
            if (err || !token) {
              console.error("Error al emitir token de acceso:", err);
              res.status(500).json("Error interno");
              return;
            }
            res.status(200).json({ token, data });
          });
        }
      } else {
        res.status(401).send();
      }
    } else {
      console.log(err);
      res.status(500).json("Error interno");
    }
  });
});

// Permisos actuales de la sesion. El middleware reemplaza los claims
// autorizativos del JWT con los valores vigentes de la base en cada llamada.
router.get("/sesion/permisos", verifyToken, (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    return res.status(200).json({
      id: cabecera.id,
      rol_id: cabecera.rol_id,
      rol: cabecera.rol,
      departamental_id: cabecera.departamental_id,
      habilitado: cabecera.habilitado,
      area_turismo: cabecera.area_turismo,
      area_coseguro: cabecera.area_coseguro,
      modulo_turismo: cabecera.modulo_turismo,
      modulo_coseguro: cabecera.modulo_coseguro,
      modulo_olimpiadas: cabecera.modulo_olimpiadas,
    });
  } catch (_error) {
    return res.status(403).json("Error en la sesion");
  }
});

router.get("/new/token", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    const id = cabecera.id;
    const [rows] = await mysqlConnection.promise().query(
      'select usuario.id, \
                                usuario.nombre, \
                                usuario.apellido, \
                                usuario.documento, \
                                usuario.email, \
                                rol.nombre AS rol, \
                                usuario.habilitado, \
                                usuario.validado, \
                                usuario.cliente as client_id \
                                FROM usuario \
                                INNER JOIN rol ON rol.id = usuario.rol \
                                WHERE usuario.id = ? AND usuario.habilitado = "Y"',
      [id]
    );
    if (rows.length > 0) {
      let data = JSON.stringify(rows[0]);
      jwt.sign(
        { data },
        process.env.JWT_SECRET,
        { expiresIn: "8h" },
        (err, token) => {
          res.status(200).json({ token });
        }
      );
    } else {
      res.status(401).send();
    }
  } else {
    res.status(401).send();
  }
});

router.get("/credencial-digital", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const userId = cabecera.id;

      // Generar hash aleatorio de 50 caracteres
      const hashCredencial = crypto.randomBytes(25).toString('hex'); // 25 bytes = 50 caracteres hex
      const fechaActual = new Date();

      // Actualizar el usuario con el nuevo hash y fecha
      await mysqlConnection
        .promise()
        .query(
          `UPDATE usuario SET 
            hash_credencial = ?, 
            fecha_hash_credencial = ?
          WHERE id = ?`,
          [hashCredencial, fechaActual, userId]
        );

      // Obtener los datos del usuario actualizados
      const [rows] = await mysqlConnection
        .promise()
        .query(
          `SELECT
            id,
            nombre,
            apellido,
            fecha_nacimiento,
            hash_credencial as hash,
            documento as dni,
            foto_archivo
          FROM usuario
          WHERE id = ?`,
          [userId]
        );

      if (rows.length > 0) {
        const usuario = rows[0];

        // Formatear la fecha de nacimiento a string (YYYY-MM-DD)
        if (usuario.fecha_nacimiento) {
          usuario.fecha_nacimiento = formatearFechaSQL(usuario.fecha_nacimiento);
        }

        // Si tiene foto, prepararla para envío (como base64)
        if (usuario.foto_archivo) {
          try {
            const fotoObject = await getObjectBufferFromS3(usuario.foto_archivo);
            if (fotoObject?.buffer) {
              const fotoBase64 = fotoObject.buffer.toString("base64");
              usuario.foto_data = `data:${fotoObject.contentType};base64,${fotoBase64}`;
            } else {
              usuario.foto_data = null;
            }
          } catch (readError) {
            console.error("Error leyendo foto desde S3:", readError);
            usuario.foto_data = null;
          }
        }

        res.status(200).json(usuario);
      } else {
        res.status(404).json("Usuario no encontrado");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la credencial digital");
  }
});

router.get("/credencial-digital/verificacion/:hash", async (req, res) => {
  try {
    console.log("Verificando hash:", req.params.hash);
    const hash = req.params.hash;

    // Validar que el hash tenga exactamente 50 caracteres
    if (!hash || hash.length !== 50) {
      return res.status(400).json({
        estado: "Inexistente",
        descripcion: "Hash inválido"
      });
    }

    // Buscar el usuario por hash_credencial
    const [rows] = await mysqlConnection
      .promise()
      .query(
        `SELECT 
          id,
          hash_credencial,
          DATE(fecha_hash_credencial) AS fecha_validez,
          CURDATE() AS fecha_actual
        FROM usuario 
        WHERE hash_credencial = ?`,
        [hash]
      );

    // Si no se encuentra el hash
    if (rows.length === 0) {
      return res.status(404).json({
        estado: "Inexistente",
        descripcion: "Credencial no encontrada"
      });
    }

    const usuario = rows[0];

    // La vigencia es la fecha civil actual de Argentina, no una ventana móvil
    // de 24 horas que permitiría reutilizar una captura del día anterior.
    if (!usuario.fecha_validez || String(usuario.fecha_validez) !== String(usuario.fecha_actual)) {
      return res.status(200).json({
        estado: "Expirada",
        descripcion: "La credencial no es válida en la fecha actual"
      });
    }

    return res.status(200).json({
      estado: "Vigente",
      descripcion: "Credencial válida en la fecha actual"
    });

  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json({
      estado: "Inexistente",
      descripcion: "Error interno del servidor"
    });
  }
});

router.get("/lugares", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      let rows;
      try {
        [rows] = await mysqlConnection
          .promise()
          .query(`
            SELECT lugar
            FROM (
              SELECT lugar FROM servicio WHERE lugar IS NOT NULL AND lugar <> ''
              UNION
              SELECT ciudad AS lugar FROM convenio_hotel WHERE activo = 1 AND ciudad IS NOT NULL AND ciudad <> ''
            ) lugares
            ORDER BY lugar ASC
          `);
      } catch (queryError) {
        if (!esErrorTemporadaAltaNoMigrada(queryError)) {
          throw queryError;
        }
        [rows] = await mysqlConnection
          .promise()
          .query("SELECT lugar FROM servicio GROUP BY lugar ORDER BY lugar ASC");
      }
      const lugares = rows.map(row => row.lugar);
      res.status(200).json(lugares);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los lugares");
  }
});

router.get("/servicios", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      const db = mysqlConnection.promise();
      const holdIdExcluir = await resolverHoldIdExcluir(db, cabecera, req.query.hold_token);
      const lugar = req.query.lugar;
      const hayParametrosDisponibilidad =
        req.query.fecha_inicio !== undefined ||
        req.query.fecha_fin !== undefined ||
        req.query.adultos !== undefined ||
        req.query.ninos !== undefined ||
        req.query.bebes !== undefined;

      let criteriosDisponibilidad = null;
      if (hayParametrosDisponibilidad) {
        const parseo = parsearParametrosBusquedaDisponibilidad(req.query, {
          requireFechas: true,
          requirePersonas: true,
        });

        if (parseo.error) {
          return res.status(422).json(parseo.error);
        }

        criteriosDisponibilidad = parseo.value;
      }

      let query = "SELECT id, nombre, lugar, rating FROM servicio";
      let params = [];
      if (lugar) {
        query += " WHERE lugar = ?";
        params.push(lugar);
      }
      query += " ORDER BY nombre ASC";

      // Obtener los servicios (filtrados o no)
      const [servicios] = await db.query(query, params);

      // Obtener todas las imagenes de servicios
      const [imagenes] = await db.query("SELECT id, servicio_id, archivo FROM imagen_servicio");

      const disponibilidadPorServicio = new Map();
      const sorteosActivosPorServicio = new Map();
      let bloquesDisponiblesPorServicio = new Map();
      if (criteriosDisponibilidad && servicios.length > 0) {
        await ejecutarMantenimientoBloquesAlta(db);

        const disponibilidadSnapshot = await obtenerSnapshotDisponibilidad(db, {
          servicioIds: servicios.map((servicio) => Number(servicio.id)),
          fechaInicio: criteriosDisponibilidad.fecha_inicio,
          fechaFin: criteriosDisponibilidad.fecha_fin,
          adultos: criteriosDisponibilidad.adultos,
          ninos: criteriosDisponibilidad.ninos,
          bebes: criteriosDisponibilidad.bebes,
          totalPersonas: criteriosDisponibilidad.total_personas,
          holdIdExcluir,
        });

        disponibilidadSnapshot.forEach((item) => {
          disponibilidadPorServicio.set(Number(item.servicio_id), item);
        });

        bloquesDisponiblesPorServicio = await obtenerBloquesDisponiblesPorServicio(db, {
          servicioIds: servicios.map((servicio) => Number(servicio.id)),
          fechaInicio: criteriosDisponibilidad.fecha_inicio,
          fechaFin: criteriosDisponibilidad.fecha_fin,
          holdIdExcluir,
        });

        try {
          const servicioIds = servicios.map((servicio) => Number(servicio.id));
          const placeholders = servicioIds.map(() => "?").join(",");
          const [sorteosRows] = await db.query(
            `
              SELECT
                bf.servicio_id,
                s.id AS sorteo_id,
                s.nombre AS sorteo_nombre,
                bf.id AS bloque_fecha_id,
                bf.nombre AS bloque_nombre,
                bf.fecha_inicio,
                bf.fecha_fin,
                COUNT(bfr.id) AS recursos_disponibles
              FROM bloque_fecha bf
              INNER JOIN sorteo s ON s.id = bf.sorteo_id
              INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
              WHERE bf.servicio_id IN (${placeholders})
                AND bf.estado = 'ACTIVO'
                AND bf.modalidad = 'SORTEO'
                AND s.estado = 'ACTIVO'
                AND bfr.estado IN ('DISPONIBLE', 'SORTEO')
                AND s.fecha_inicio_inscripcion <= CURDATE()
                AND s.fecha_fin_inscripcion >= CURDATE()
                AND bf.fecha_inicio < ?
                AND bf.fecha_fin > ?
              GROUP BY bf.id, s.id
              ORDER BY bf.fecha_inicio ASC
            `,
            [...servicioIds, criteriosDisponibilidad.fecha_fin, criteriosDisponibilidad.fecha_inicio]
          );

          sorteosRows.forEach((row) => {
            const servicioId = Number(row.servicio_id);
            if (!sorteosActivosPorServicio.has(servicioId)) {
              sorteosActivosPorServicio.set(servicioId, []);
            }
            sorteosActivosPorServicio.get(servicioId).push({
              sorteo_id: Number(row.sorteo_id),
              nombre: row.sorteo_nombre,
              bloque_fecha_id: Number(row.bloque_fecha_id),
              bloque_nombre: row.bloque_nombre,
              fecha_inicio: formatearFechaSQL(row.fecha_inicio),
              fecha_fin: formatearFechaSQL(row.fecha_fin),
              recursos_disponibles: Number(row.recursos_disponibles)
            });
          });
        } catch (error) {
          if (!esErrorTemporadaAltaNoMigrada(error)) {
            throw error;
          }
        }
      }

      // Mapear imagenes por servicio_id
      const imagenesConUrlPorServicio = await Promise.all(
        imagenes.map(async (img) => {
          try {
            return {
              ...img,
              archivo_url: await getSignedFileUrlFromS3(img.archivo),
            };
          } catch (error) {
            console.error("Error generando URL firmada para imagen de servicio:", error);
            return {
              ...img,
              archivo_url: null,
            };
          }
        })
      );

      const imagenesPorServicio = {};
      imagenesConUrlPorServicio.forEach((img) => {
        if (!imagenesPorServicio[img.servicio_id]) {
          imagenesPorServicio[img.servicio_id] = [];
        }
        imagenesPorServicio[img.servicio_id].push({
          id: img.id,
          archivo: img.archivo_url,
        });
      });

      // Agregar campo imagenes y precios a cada servicio
      const serviciosConImagenes = await Promise.all(servicios.map(async (servicio) => {
        let precio_minimo = null;
        let precio_maximo = null;

        // Calcular precios solo si se proporcionan las fechas y al menos una persona
        if (criteriosDisponibilidad) {
          const { fecha_inicio, fecha_fin, adultos, ninos, bebes } = criteriosDisponibilidad;
          const nochesSolicitud = obtenerNochesReserva(fecha_inicio, fecha_fin, 366);

          const preciosMinimosCentavos = [];
          const preciosMaximosCentavos = [];
          let estimacionCompleta = nochesSolicitud.length > 0;

          // Procesar cada día del rango
          for (const fechaString of nochesSolicitud) {

            let precioMinimoDiaCentavos = 0;
            let precioMaximoDiaCentavos = 0;
            const acumularRangoTarifa = (filas, cantidad) => {
              if (cantidad === 0) return true;
              const minimo = decimalACentavos(filas?.[0]?.precio_min);
              const maximo = decimalACentavos(filas?.[0]?.precio_max);
              const subtotalMinimo = minimo === null ? null : minimo * cantidad;
              const subtotalMaximo = maximo === null ? null : maximo * cantidad;
              if (!Number.isSafeInteger(subtotalMinimo) || !Number.isSafeInteger(subtotalMaximo)) {
                return false;
              }
              const nuevoMinimo = sumarCentavos(precioMinimoDiaCentavos, subtotalMinimo);
              const nuevoMaximo = sumarCentavos(precioMaximoDiaCentavos, subtotalMaximo);
              if (nuevoMinimo === null || nuevoMaximo === null) return false;
              precioMinimoDiaCentavos = nuevoMinimo;
              precioMaximoDiaCentavos = nuevoMaximo;
              return true;
            };

            // Procesar adultos (mayores de 5 años)
            if (adultos > 0) {
              const [tarifasAdultos] = await db.query(`
      SELECT MIN(t.precio) as precio_min, MAX(t.precio) as precio_max
      FROM tarifa t
      INNER JOIN recurso r ON t.recurso_id = r.id
      WHERE r.servicio_id = ?
        AND (t.edad_maxima IS NULL OR t.edad_maxima > 5)
        AND t.fecha_inicio <= ?
        AND t.fecha_fin >= ?
    `, [servicio.id, fechaString, fechaString]);

              estimacionCompleta = acumularRangoTarifa(tarifasAdultos, adultos) && estimacionCompleta;
            }

            // Procesar niños (entre 2 y 5 años inclusivo)
            if (ninos > 0) {
              const [tarifasninos] = await db.query(`
      SELECT MIN(t.precio) as precio_min, MAX(t.precio) as precio_max
      FROM tarifa t
      INNER JOIN recurso r ON t.recurso_id = r.id
      WHERE r.servicio_id = ?
        AND (t.edad_minima IS NULL OR t.edad_minima <= 5)
        AND (t.edad_maxima IS NULL OR t.edad_maxima >= 2)
        AND t.fecha_inicio <= ?
        AND t.fecha_fin >= ?
    `, [servicio.id, fechaString, fechaString]);

              estimacionCompleta = acumularRangoTarifa(tarifasninos, ninos) && estimacionCompleta;
            }

            // Procesar bebés (menores de 2 años)
            if (bebes > 0) {
              const [tarifasBebes] = await db.query(`
                SELECT MIN(t.precio) as precio_min, MAX(t.precio) as precio_max
                FROM tarifa t
                INNER JOIN recurso r ON t.recurso_id = r.id
                WHERE r.servicio_id = ?
                  AND (t.edad_maxima IS NULL OR t.edad_maxima < 2)
                  AND t.fecha_inicio <= ?
                  AND t.fecha_fin >= ?
              `, [servicio.id, fechaString, fechaString]);

              estimacionCompleta = acumularRangoTarifa(tarifasBebes, bebes) && estimacionCompleta;
            }

            preciosMinimosCentavos.push(precioMinimoDiaCentavos);
            preciosMaximosCentavos.push(precioMaximoDiaCentavos);
          }

          // Sumar todos los días
          const totalMinimoCentavos = sumarCentavos(...preciosMinimosCentavos);
          const totalMaximoCentavos = sumarCentavos(...preciosMaximosCentavos);
          if (estimacionCompleta && totalMinimoCentavos !== null && totalMaximoCentavos !== null) {
            precio_minimo = centavosANumero(totalMinimoCentavos);
            precio_maximo = centavosANumero(totalMaximoCentavos);
          }
        }

        const disponibilidadBase = disponibilidadPorServicio.get(Number(servicio.id)) || null;
        let calendario = null;

        if (criteriosDisponibilidad && disponibilidadBase) {
          calendario = {
            fechas_habilitadas: [],
            rangos_disponibles: [],
          };

          if (disponibilidadBase.sin_disponibilidad) {
            calendario = await obtenerCalendarioAlternativoServicio(db, {
              servicioId: Number(servicio.id),
              fechaInicio: criteriosDisponibilidad.fecha_inicio,
              fechaFin: criteriosDisponibilidad.fecha_fin,
              adultos: criteriosDisponibilidad.adultos,
              ninos: criteriosDisponibilidad.ninos,
              bebes: criteriosDisponibilidad.bebes,
              totalPersonas: criteriosDisponibilidad.total_personas,
              horizonteDias: 45,
              maxResultados: 12,
              holdIdExcluir,
            });
          }
        }

        const respuestaServicio = {
          ...servicio,
          imagenes: imagenesPorServicio[servicio.id] || [],
          precio_minimo,
          precio_maximo,
        };

        if (disponibilidadBase) {
          const disponibilidad = {
            disponibles: disponibilidadBase.disponibles,
            lugares_disponibles: disponibilidadBase.disponibles,
            cupo_disponible: disponibilidadBase.disponibles,
            total: disponibilidadBase.total,
            total_disponibles: disponibilidadBase.total,
            ultimos_lugares: disponibilidadBase.ultimos_lugares,
            sin_disponibilidad: disponibilidadBase.sin_disponibilidad,
            actualizado_en: disponibilidadBase.actualizado_en,
            calendario: calendario || {
              fechas_habilitadas: [],
              rangos_disponibles: [],
            },
          };

          respuestaServicio.disponibilidad = disponibilidad;
          respuestaServicio.disponibles = disponibilidad.disponibles;
          respuestaServicio.lugares_disponibles = disponibilidad.disponibles;
          respuestaServicio.cupo_disponible = disponibilidad.disponibles;
          respuestaServicio.total_disponibles = disponibilidad.total;
        }

        const sorteosServicio = sorteosActivosPorServicio.get(Number(servicio.id)) || [];
        const bloquesServicio = bloquesDisponiblesPorServicio.get(Number(servicio.id)) || [];
        if (bloquesServicio.length > 0) {
          respuestaServicio.bloques_disponibles = bloquesServicio;
        }

        if (sorteosServicio.length > 0) {
          respuestaServicio.sorteo_activo = sorteosServicio[0];
          respuestaServicio.sorteos_activos = sorteosServicio;
          respuestaServicio.modalidades_disponibles = Array.from(new Set([
            "FECHA_LIBRE",
            ...bloquesServicio.map((bloque) => bloque.modalidad),
            "SORTEO"
          ]));
        } else {
          respuestaServicio.modalidades_disponibles = Array.from(new Set([
            "FECHA_LIBRE",
            ...bloquesServicio.map((bloque) => bloque.modalidad)
          ]));
        }

        return respuestaServicio;
      }));
      res.status(200).json(serviciosConImagenes);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    if (responderErrorHold(res, error)) return;
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los servicios");
  }
});

function responderErrorHold(res, error) {
  const status = Number(error?.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 599) return false;
  const payload = {
    message: error.message,
    codigo: error.codigo || "HOLD_ERROR",
  };
  if (error.detalles && typeof error.detalles === "object") {
    Object.assign(payload, error.detalles);
  }
  res.status(status).json(payload);
  return true;
}

async function resolverHoldIdExcluir(connection, cabecera, holdToken) {
  if (holdToken === undefined || holdToken === null || holdToken === "") return null;
  return obtenerHoldIdActivoPorToken(connection, {
    actorUsuarioId: cabecera.id,
    holdToken,
  });
}

function emitirInvalidacionDisponibilidad(req, hold, motivo) {
  const evento = crearEventoInvalidacionHold(hold, motivo);
  if (evento) req.app.get("io")?.emit("servicios:disponibilidad:invalidada", evento);
}

function puedeUsarHoldsTurismo(cabecera) {
  return ["admin", "departamental", "afiliado"].includes(cabecera?.rol)
    && tieneAreaTurismo(cabecera);
}

router.post("/turismo/reserva-holds", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!puedeUsarHoldsTurismo(cabecera)) {
      return res.status(401).json({ message: "No autorizado", codigo: "HOLD_NO_AUTORIZADO" });
    }
    const actorId = normalizarIdPositivo(cabecera.id);
    const titularId = cabecera.rol === "afiliado"
      ? actorId
      : normalizarIdPositivo(req.body.titular_usuario_id ?? req.body.usuario_id);
    const resultado = await adquirirHoldTurismo(mysqlConnection.promise(), {
      actorUsuarioId: actorId,
      actorRol: cabecera.rol,
      actorDepartamentalId: cabecera.departamental_id,
      titularUsuarioId: titularId,
      servicioId: req.body.servicio_id,
      recursoId: req.body.recurso_id,
      bloqueFechaId: req.body.bloque_fecha_id,
      modalidad: req.body.modalidad,
      fechaInicio: req.body.fecha_inicio,
      fechaFin: req.body.fecha_fin,
      holdToken: req.body.hold_token,
    });
    const { creado, hold_anterior: holdAnterior, ...respuesta } = resultado;
    if (holdAnterior) emitirInvalidacionDisponibilidad(req, holdAnterior, "HOLD_REEMPLAZADO");
    emitirInvalidacionDisponibilidad(req, respuesta, respuesta.reemplazado ? "HOLD_REEMPLAZADO" : "HOLD_CREADO");
    return res.status(creado ? 201 : 200).json(respuesta);
  } catch (error) {
    if (responderErrorHold(res, error)) return;
    registrarErrorRuta(error);
    return res.status(500).json({ message: "No pudimos guardar temporalmente el alojamiento.", codigo: "HOLD_ERROR_INTERNO" });
  }
});

router.get("/turismo/reserva-holds/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!puedeUsarHoldsTurismo(cabecera)) {
      return res.status(401).json({ message: "No autorizado", codigo: "HOLD_NO_AUTORIZADO" });
    }
    const resultado = await obtenerEstadoHold(mysqlConnection.promise(), {
      actorUsuarioId: cabecera.id,
      holdId: req.params.id || null,
    });
    if (req.params.id && !resultado.hold) {
      return res.status(404).json({ message: "Reserva temporal no encontrada.", codigo: "HOLD_NO_ENCONTRADO" });
    }
    return res.status(200).json(resultado);
  } catch (error) {
    if (responderErrorHold(res, error)) return;
    registrarErrorRuta(error);
    return res.status(500).json({ message: "No pudimos consultar la reserva temporal.", codigo: "HOLD_ERROR_INTERNO" });
  }
});

router.delete("/turismo/reserva-holds/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!puedeUsarHoldsTurismo(cabecera)) {
      return res.status(401).json({ message: "No autorizado", codigo: "HOLD_NO_AUTORIZADO" });
    }
    const resultado = await liberarHoldTurismo(mysqlConnection.promise(), {
      actorUsuarioId: cabecera.id,
      holdId: req.params.id,
      holdToken: req.body?.hold_token,
    });
    emitirInvalidacionDisponibilidad(req, resultado.hold, resultado.estado === "VENCIDO" ? "HOLD_VENCIDO" : "HOLD_LIBERADO");
    const { hold: _hold, ...respuesta } = resultado;
    return res.status(200).json(respuesta);
  } catch (error) {
    if (responderErrorHold(res, error)) return;
    registrarErrorRuta(error);
    return res.status(500).json({ message: "No pudimos liberar la reserva temporal.", codigo: "HOLD_ERROR_INTERNO" });
  }
});

router.get("/turismo/propuestas", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const propuestas = await obtenerPropuestasTurismo(mysqlConnection.promise());
    res.status(200).json(propuestas);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las propuestas de turismo");
  }
});

router.get("/admin/turismo/propuestas", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const propuestas = await obtenerPropuestasTurismo(mysqlConnection.promise());
    res.status(200).json(propuestas);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las propuestas de turismo");
  }
});

router.put("/admin/turismo/propuestas/:id", verifyToken, manejarUploadTurismoPropuesta, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const propuestaId = normalizarIdPositivo(req.params.id);
    if (!propuestaId) {
      return res.status(400).json("ID invalido");
    }

    const titulo = normalizarTexto(req.body.titulo);
    const link = normalizarTexto(req.body.link);
    if (!titulo || !link) {
      return res.status(400).json("Titulo y link son requeridos");
    }
    if (!/^https?:\/\//i.test(link)) {
      return res.status(400).json("El link debe comenzar con http:// o https://");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [existentes] = await connection.query(
      "SELECT * FROM turismo_propuesta WHERE id = ? LIMIT 1 FOR UPDATE",
      [propuestaId]
    );
    if (existentes.length === 0) {
      await connection.rollback();
      return res.status(404).json("Propuesta de turismo no encontrada");
    }

    let imagenArchivo = existentes[0].imagen_archivo;
    if (req.file) {
      imagenArchivo = await subirImagenTurismoPropuesta(req.file);
    }

    await connection.query(
      `
        UPDATE turismo_propuesta
        SET titulo = ?,
            link = ?,
            imagen_archivo = ?
        WHERE id = ?
      `,
      [titulo, link, imagenArchivo, propuestaId]
    );

    await connection.commit();

    const propuestas = await obtenerPropuestasTurismo(mysqlConnection.promise(), propuestaId);
    res.status(200).json(propuestas[0]);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error al actualizar la propuesta de turismo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.get("/turismo/testimonios", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const testimonios = await obtenerTestimoniosTurismo(mysqlConnection.promise(), { soloActivos: true });
    res.status(200).json(testimonios);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los testimonios de turismo");
  }
});

router.get("/admin/turismo/testimonios", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const testimonios = await obtenerTestimoniosTurismo(mysqlConnection.promise());
    res.status(200).json(testimonios);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los testimonios de turismo");
  }
});

router.post("/admin/turismo/testimonios", verifyToken, manejarUploadTurismoTestimonio, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const datos = validarDatosTestimonioTurismo(req.body);
    if (datos.error) {
      return res.status(400).json(datos.error);
    }

    let fotoArchivo = null;
    if (req.file) {
      fotoArchivo = await subirFotoTurismoTestimonio(req.file);
    }

    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      `
        INSERT INTO turismo_testimonio (nombre, localidad, estrellas, comentario, foto_archivo, activo, orden)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [datos.nombre, datos.localidad, datos.estrellas, datos.comentario, fotoArchivo, datos.activo, datos.orden]
    );

    const testimonios = await obtenerTestimoniosTurismo(db, { testimonioId: resultado.insertId });
    res.status(201).json(testimonios[0]);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al crear el testimonio de turismo");
  }
});

router.put("/admin/turismo/testimonios/:id", verifyToken, manejarUploadTurismoTestimonio, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const testimonioId = normalizarIdPositivo(req.params.id);
    if (!testimonioId) {
      return res.status(400).json("ID invalido");
    }

    const datos = validarDatosTestimonioTurismo(req.body);
    if (datos.error) {
      return res.status(400).json(datos.error);
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [existentes] = await connection.query(
      "SELECT * FROM turismo_testimonio WHERE id = ? LIMIT 1 FOR UPDATE",
      [testimonioId]
    );
    if (existentes.length === 0) {
      await connection.rollback();
      return res.status(404).json("Testimonio de turismo no encontrado");
    }

    let fotoArchivo = existentes[0].foto_archivo;
    if (req.file) {
      fotoArchivo = await subirFotoTurismoTestimonio(req.file);
    } else if (normalizarBoolean(req.body.quitar_foto)) {
      fotoArchivo = null;
    }

    await connection.query(
      `
        UPDATE turismo_testimonio
        SET nombre = ?,
            localidad = ?,
            estrellas = ?,
            comentario = ?,
            foto_archivo = ?,
            activo = ?,
            orden = ?
        WHERE id = ?
      `,
      [datos.nombre, datos.localidad, datos.estrellas, datos.comentario, fotoArchivo, datos.activo, datos.orden, testimonioId]
    );

    await connection.commit();

    const testimonios = await obtenerTestimoniosTurismo(mysqlConnection.promise(), { testimonioId });
    res.status(200).json(testimonios[0]);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error al actualizar el testimonio de turismo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.delete("/admin/turismo/testimonios/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const testimonioId = normalizarIdPositivo(req.params.id);
    if (!testimonioId) {
      return res.status(400).json("ID invalido");
    }

    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      "DELETE FROM turismo_testimonio WHERE id = ?",
      [testimonioId]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json("Testimonio de turismo no encontrado");
    }

    res.status(200).json({ id: testimonioId });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al eliminar el testimonio de turismo");
  }
});

router.get("/admin/convenios-hoteleros", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const db = mysqlConnection.promise();
    const [hoteles] = await db.query(`
      SELECT
        id,
        nombre,
        ciudad,
        provincia,
        coordenadas_maps,
        latitud,
        longitud,
        descripcion,
        tarifario_pdf_archivo,
        activo,
        fecha_creacion,
        fecha_modificacion
      FROM convenio_hotel
      ORDER BY nombre ASC
    `);

    const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(db, hoteles.map((hotel) => hotel.id));
    const respuesta = await Promise.all(hoteles.map((hotel) => (
      firmarConvenioHotel(hotel, imagenesPorHotel.get(Number(hotel.id)) || [])
    )));

    res.status(200).json(respuesta);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los convenios hoteleros");
  }
});

router.get("/admin/convenios-hoteleros/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const hotelId = normalizarIdPositivo(req.params.id);
    if (!hotelId) {
      return res.status(400).json("ID invalido");
    }

    const db = mysqlConnection.promise();
    const [hoteles] = await db.query(
      `
        SELECT
          id,
          nombre,
          ciudad,
          provincia,
          coordenadas_maps,
          latitud,
          longitud,
          descripcion,
          tarifario_pdf_archivo,
          activo,
          fecha_creacion,
          fecha_modificacion
        FROM convenio_hotel
        WHERE id = ?
        LIMIT 1
      `,
      [hotelId]
    );

    if (hoteles.length === 0) {
      return res.status(404).json("Convenio hotelero no encontrado");
    }

    const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(db, [hotelId]);
    const respuesta = await firmarConvenioHotel(hoteles[0], imagenesPorHotel.get(hotelId) || []);

    res.status(200).json(respuesta);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el convenio hotelero");
  }
});

router.post("/admin/convenios-hoteleros", verifyToken, manejarUploadConvenioHotel, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const nombre = normalizarTexto(req.body.nombre);
    const ciudad = normalizarTexto(req.body.ciudad);
    const provincia = normalizarTexto(req.body.provincia);
    const coordenadasMaps = normalizarTexto(req.body.coordenadas_maps);
    const descripcion = normalizarTexto(req.body.descripcion);
    const latitud = normalizarNumeroNullable(req.body.latitud);
    const longitud = normalizarNumeroNullable(req.body.longitud);
    const activo = req.body.activo === undefined ? 1 : normalizarBooleanoBinarioEstricto(req.body.activo);
    const fotos = req.files?.fotos || [];
    const pdf = req.files?.tarifario_pdf?.[0] || null;

    if (!nombre || !ciudad || !provincia || !coordenadasMaps) {
      return res.status(400).json("Nombre, ciudad, provincia y coordenadas son requeridos");
    }
    if (activo === null
      || (req.body.latitud !== undefined && req.body.latitud !== "" && latitud === null)
      || (req.body.longitud !== undefined && req.body.longitud !== "" && longitud === null)
      || (latitud !== null && (latitud < -90 || latitud > 90))
      || (longitud !== null && (longitud < -180 || longitud > 180))) {
      return res.status(400).json("Coordenadas o estado activo inválidos");
    }
    if (fotos.length > 10) {
      return res.status(400).json("Se pueden subir hasta 10 fotos");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    let tarifarioPdfArchivo = null;
    if (pdf) {
      tarifarioPdfArchivo = await subirArchivoConvenioHotel(pdf, "tarifario");
    }

    const [result] = await connection.query(
      `
        INSERT INTO convenio_hotel (
          nombre,
          ciudad,
          provincia,
          coordenadas_maps,
          latitud,
          longitud,
          descripcion,
          tarifario_pdf_archivo,
          activo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [nombre, ciudad, provincia, coordenadasMaps, latitud, longitud, descripcion || null, tarifarioPdfArchivo, activo]
    );

    const hotelId = result.insertId;
    for (let index = 0; index < fotos.length; index++) {
      const archivo = await subirArchivoConvenioHotel(fotos[index], "foto");
      await connection.query(
        "INSERT INTO convenio_hotel_imagen (convenio_hotel_id, archivo, orden) VALUES (?, ?, ?)",
        [hotelId, archivo, index]
      );
    }

    await connection.commit();

    const [hoteles] = await mysqlConnection.promise().query(
      "SELECT * FROM convenio_hotel WHERE id = ?",
      [hotelId]
    );
    const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(mysqlConnection.promise(), [hotelId]);
    const respuesta = await firmarConvenioHotel(hoteles[0], imagenesPorHotel.get(hotelId) || []);

    res.status(201).json(respuesta);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error al crear el convenio hotelero");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/convenios-hoteleros/:id", verifyToken, manejarUploadConvenioHotel, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const hotelId = normalizarIdPositivo(req.params.id);
    if (!hotelId) {
      return res.status(400).json("ID invalido");
    }

    const nombre = normalizarTexto(req.body.nombre);
    const ciudad = normalizarTexto(req.body.ciudad);
    const provincia = normalizarTexto(req.body.provincia);
    const coordenadasMaps = normalizarTexto(req.body.coordenadas_maps);
    const descripcion = normalizarTexto(req.body.descripcion);
    const latitud = normalizarNumeroNullable(req.body.latitud);
    const longitud = normalizarNumeroNullable(req.body.longitud);
    const activo = req.body.activo === undefined ? 1 : normalizarBooleanoBinarioEstricto(req.body.activo);
    const fotos = req.files?.fotos || [];
    const pdf = req.files?.tarifario_pdf?.[0] || null;

    if (!nombre || !ciudad || !provincia || !coordenadasMaps) {
      return res.status(400).json("Nombre, ciudad, provincia y coordenadas son requeridos");
    }
    if (activo === null
      || (req.body.latitud !== undefined && req.body.latitud !== "" && latitud === null)
      || (req.body.longitud !== undefined && req.body.longitud !== "" && longitud === null)
      || (latitud !== null && (latitud < -90 || latitud > 90))
      || (longitud !== null && (longitud < -180 || longitud > 180))) {
      return res.status(400).json("Coordenadas o estado activo inválidos");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [existentes] = await connection.query(
      "SELECT * FROM convenio_hotel WHERE id = ? LIMIT 1 FOR UPDATE",
      [hotelId]
    );
    if (existentes.length === 0) {
      await connection.rollback();
      return res.status(404).json("Convenio hotelero no encontrado");
    }

    const [imagenesActuales] = await connection.query(
      "SELECT id FROM convenio_hotel_imagen WHERE convenio_hotel_id = ? ORDER BY orden ASC, id ASC",
      [hotelId]
    );
    const imagenesSolicitadas = parseArrayDesdeFormulario(req.body.imagenes_existentes);
    const envioListaImagenes = Object.prototype.hasOwnProperty.call(req.body, "imagenes_existentes");
    const idsSolicitados = imagenesSolicitadas
      .map((item) => normalizarIdPositivo(typeof item === "object" ? item.id : item))
      .filter(Boolean);
    const idsActuales = imagenesActuales.map((imagen) => Number(imagen.id));
    const idsAConservar = envioListaImagenes
      ? idsSolicitados.filter((id) => idsActuales.includes(id))
      : idsActuales;

    if (idsAConservar.length + fotos.length > 10) {
      await connection.rollback();
      return res.status(400).json("Se pueden conservar/subir hasta 10 fotos");
    }

    if (envioListaImagenes) {
      if (idsAConservar.length > 0) {
        const placeholders = idsAConservar.map(() => "?").join(",");
        await connection.query(
          `DELETE FROM convenio_hotel_imagen WHERE convenio_hotel_id = ? AND id NOT IN (${placeholders})`,
          [hotelId, ...idsAConservar]
        );
      } else {
        await connection.query(
          "DELETE FROM convenio_hotel_imagen WHERE convenio_hotel_id = ?",
          [hotelId]
        );
      }

      for (let index = 0; index < idsAConservar.length; index++) {
        await connection.query(
          "UPDATE convenio_hotel_imagen SET orden = ? WHERE id = ? AND convenio_hotel_id = ?",
          [index, idsAConservar[index], hotelId]
        );
      }
    }

    let tarifarioPdfArchivo = existentes[0].tarifario_pdf_archivo || null;
    if (pdf) {
      tarifarioPdfArchivo = await subirArchivoConvenioHotel(pdf, "tarifario");
    }

    await connection.query(
      `
        UPDATE convenio_hotel
        SET nombre = ?,
            ciudad = ?,
            provincia = ?,
            coordenadas_maps = ?,
            latitud = ?,
            longitud = ?,
            descripcion = ?,
            tarifario_pdf_archivo = ?,
            activo = ?
        WHERE id = ?
      `,
      [nombre, ciudad, provincia, coordenadasMaps, latitud, longitud, descripcion || null, tarifarioPdfArchivo, activo, hotelId]
    );

    const ordenInicial = idsAConservar.length;
    for (let index = 0; index < fotos.length; index++) {
      const archivo = await subirArchivoConvenioHotel(fotos[index], "foto");
      await connection.query(
        "INSERT INTO convenio_hotel_imagen (convenio_hotel_id, archivo, orden) VALUES (?, ?, ?)",
        [hotelId, archivo, ordenInicial + index]
      );
    }

    await connection.commit();

    const [hoteles] = await mysqlConnection.promise().query(
      "SELECT * FROM convenio_hotel WHERE id = ?",
      [hotelId]
    );
    const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(mysqlConnection.promise(), [hotelId]);
    const respuesta = await firmarConvenioHotel(hoteles[0], imagenesPorHotel.get(hotelId) || []);

    res.status(200).json(respuesta);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error al actualizar el convenio hotelero");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.patch("/admin/convenios-hoteleros/:id/activo", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const hotelId = normalizarIdPositivo(req.params.id);
    if (!hotelId) {
      return res.status(400).json("ID invalido");
    }

    const activo = normalizarBooleanActivo(req.body.activo, true);
    const [result] = await mysqlConnection.promise().query(
      "UPDATE convenio_hotel SET activo = ? WHERE id = ?",
      [activo, hotelId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json("Convenio hotelero no encontrado");
    }

    res.status(200).json({ message: "Convenio hotelero actualizado", activo: activo === 1 });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al actualizar el estado del convenio hotelero");
  }
});

router.get("/convenios-hoteleros", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const ciudad = normalizarTexto(req.query.ciudad || req.query.lugar);
    const params = [];
    let filtroCiudad = "";
    if (ciudad) {
      filtroCiudad = "AND ciudad = ?";
      params.push(ciudad);
    }

    const db = mysqlConnection.promise();
    const [hoteles] = await db.query(
      `
        SELECT
          id,
          nombre,
          ciudad,
          provincia,
          coordenadas_maps,
          latitud,
          longitud,
          descripcion,
          tarifario_pdf_archivo,
          activo,
          fecha_creacion,
          fecha_modificacion
        FROM convenio_hotel
        WHERE activo = 1
          ${filtroCiudad}
        ORDER BY nombre ASC
      `,
      params
    );

    const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(db, hoteles.map((hotel) => hotel.id));
    const respuesta = await Promise.all(hoteles.map((hotel) => (
      firmarConvenioHotel(hotel, imagenesPorHotel.get(Number(hotel.id)) || [])
    )));

    res.status(200).json(respuesta);
  } catch (error) {
    registrarErrorRuta(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json([]);
    }
    res.status(500).json("Error al obtener los convenios hoteleros");
  }
});

router.get("/convenios-hoteleros/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const hotelId = normalizarIdPositivo(req.params.id);
    if (!hotelId) {
      return res.status(400).json("ID invalido");
    }

    const db = mysqlConnection.promise();
    const [hoteles] = await db.query(
      `
        SELECT
          id,
          nombre,
          ciudad,
          provincia,
          coordenadas_maps,
          latitud,
          longitud,
          descripcion,
          tarifario_pdf_archivo,
          activo,
          fecha_creacion,
          fecha_modificacion
        FROM convenio_hotel
        WHERE id = ?
          AND (activo = 1 OR ? = 'admin')
        LIMIT 1
      `,
      [hotelId, cabecera.rol]
    );

    if (hoteles.length === 0) {
      return res.status(404).json("Convenio hotelero no encontrado");
    }

    const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(db, [hotelId]);
    const respuesta = await firmarConvenioHotel(hoteles[0], imagenesPorHotel.get(hotelId) || []);

    res.status(200).json(respuesta);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el convenio hotelero");
  }
});

router.get("/servicios/disponibilidad", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      const parseo = parsearParametrosBusquedaDisponibilidad(req.query, {
        requireFechas: true,
        requirePersonas: true,
      });

      if (parseo.error) {
        return res.status(422).json(parseo.error);
      }

      const servicioIds = parsearServicioIdsCsv(req.query.servicio_ids);
      const db = mysqlConnection.promise();
      const holdIdExcluir = await resolverHoldIdExcluir(db, cabecera, req.query.hold_token);

      // Al editar una reserva, el snapshot no debe contarla como ocupación.
      // El afiliado solo puede excluir una reserva propia (el cupo real lo
      // valida igual el PUT dentro de la transacción).
      let reservaExcluirId = normalizarIdPositivo(req.query.reserva_excluir_id);
      if (reservaExcluirId !== null && cabecera.rol === "afiliado") {
        const [reservaExcluir] = await db.query(
          "SELECT usuario_id FROM reserva WHERE id = ?",
          [reservaExcluirId]
        );
        const duenioReserva = normalizarIdPositivo(reservaExcluir?.[0]?.usuario_id);
        if (duenioReserva === null || duenioReserva !== normalizarIdPositivo(cabecera.id)) {
          reservaExcluirId = null;
        }
      }

      const snapshot = await obtenerSnapshotDisponibilidad(db, {
        lugar: req.query.lugar || null,
        servicioIds,
        fechaInicio: parseo.value.fecha_inicio,
        fechaFin: parseo.value.fecha_fin,
        adultos: parseo.value.adultos,
        ninos: parseo.value.ninos,
        bebes: parseo.value.bebes,
        totalPersonas: parseo.value.total_personas,
        reservaExcluirId,
        holdIdExcluir,
      });

      res.status(200).json(snapshot);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    if (responderErrorHold(res, error)) return;
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener disponibilidad de servicios");
  }
});

router.get("/servicios/:id/disponibilidad", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      const servicioId = normalizarIdPositivo(req.params.id);
      if (servicioId === null) {
        return res.status(404).json("Servicio inexistente");
      }

      const parseo = parsearParametrosBusquedaDisponibilidad(req.query, {
        requireFechas: true,
        requirePersonas: true,
      });

      if (parseo.error) {
        return res.status(422).json(parseo.error);
      }

      const db = mysqlConnection.promise();
      const holdIdExcluir = await resolverHoldIdExcluir(db, cabecera, req.query.hold_token);
      const servicios = await obtenerServicios(db, { servicioId });
      if (servicios.length === 0) {
        return res.status(404).json("Servicio inexistente");
      }

      const calendario = await obtenerCalendarioAlternativoServicio(db, {
        servicioId,
        fechaInicio: parseo.value.fecha_inicio,
        fechaFin: parseo.value.fecha_fin,
        adultos: parseo.value.adultos,
        ninos: parseo.value.ninos,
        bebes: parseo.value.bebes,
        totalPersonas: parseo.value.total_personas,
        holdIdExcluir,
      });

      const horizonteBloquesDiasRaw = normalizarEnteroNoNegativoOpcional(
        req.query.horizonte_bloques_dias,
        180
      );
      if (horizonteBloquesDiasRaw === undefined) {
        return res.status(400).json("El horizonte de bloques es inválido");
      }
      const horizonteBloquesDias = horizonteBloquesDiasRaw ?? 0;
      const fechaInicioBloques = horizonteBloquesDias > 0
        ? sumarDiasFechaSQL(parseo.value.fecha_inicio, -horizonteBloquesDias)
        : parseo.value.fecha_inicio;
      const fechaFinBloques = horizonteBloquesDias > 0
        ? sumarDiasFechaSQL(parseo.value.fecha_fin, horizonteBloquesDias)
        : parseo.value.fecha_fin;

      const bloquesDisponiblesMap = await obtenerBloquesDisponiblesPorServicio(db, {
        servicioId,
        fechaInicio: fechaInicioBloques,
        fechaFin: fechaFinBloques,
        holdIdExcluir,
      });
      calendario.bloques_disponibles = bloquesDisponiblesMap.get(servicioId) || [];

      if (
        (!calendario.fechas_habilitadas || calendario.fechas_habilitadas.length === 0) &&
        calendario.bloques_disponibles.length === 0
      ) {
        return res.status(409).json("No hay fechas alternativas para la cantidad de personas indicada");
      }

      res.status(200).json(calendario);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    if (responderErrorHold(res, error)) return;
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener fechas alternativas");
  }
});

router.get("/recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (["admin", "afiliado", "departamental"].includes(cabecera.rol) && tieneAreaTurismo(cabecera)) {
      const servicioId = req.query.servicio;
      let query = "SELECT id, servicio_id, nombre, grupo_recurso_id FROM recurso";
      let params = [];
      if (servicioId) {
        query += " WHERE servicio_id = ?";
        params.push(servicioId);
      }
      const [rows] = await mysqlConnection.promise().query(query, params);
      res.status(200).json(rows);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los recursos");
  }
});

router.get("/adicionales", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (["admin", "afiliado", "departamental"].includes(cabecera.rol) && tieneAreaTurismo(cabecera)) {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM adicional ORDER BY nombre ASC");
      res.status(200).json(rows);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los adicionales");
  }
});

router.get("/sorteos/activos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const db = mysqlConnection.promise();
    await ejecutarMantenimientoBloquesAlta(db);

    const servicioId = normalizarIdPositivo(req.query.servicio_id);
    const hoy = obtenerFechaCivilHoyArgentina();
    const params = [hoy, hoy];
    let filtroServicio = "";
    if (servicioId) {
      filtroServicio = " AND bf.servicio_id = ?";
      params.push(servicioId);
    }

    const [rows] = await db.query(
      `
        SELECT
          s.id AS sorteo_id,
          s.nombre AS sorteo_nombre,
          s.descripcion,
          s.fecha_inicio_inscripcion,
          s.fecha_fin_inscripcion,
          s.estado AS sorteo_estado,
          bf.id AS bloque_fecha_id,
          bf.servicio_id,
          bf.nombre AS bloque_nombre,
          bf.fecha_inicio,
          bf.fecha_fin,
          srv.nombre AS servicio_nombre,
          srv.lugar,
          COUNT(bfr.id) AS recursos_disponibles
        FROM sorteo s
        INNER JOIN bloque_fecha bf ON bf.sorteo_id = s.id
        INNER JOIN servicio srv ON srv.id = bf.servicio_id
        INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
        WHERE s.estado = 'ACTIVO'
          AND bf.estado = 'ACTIVO'
          AND bf.modalidad = 'SORTEO'
          AND bfr.estado IN ('DISPONIBLE', 'SORTEO')
          AND s.fecha_inicio_inscripcion <= ?
          AND s.fecha_fin_inscripcion >= ?
          ${filtroServicio}
        GROUP BY s.id, bf.id, srv.id
        ORDER BY s.fecha_inicio_inscripcion ASC, bf.fecha_inicio ASC
      `,
      params
    );

    const sorteosMap = new Map();
    rows.forEach((row) => {
      const sorteoId = Number(row.sorteo_id);
      if (!sorteosMap.has(sorteoId)) {
        sorteosMap.set(sorteoId, {
          id: sorteoId,
          nombre: row.sorteo_nombre,
          descripcion: row.descripcion,
          fecha_inicio_inscripcion: formatearFechaSQL(row.fecha_inicio_inscripcion),
          fecha_fin_inscripcion: formatearFechaSQL(row.fecha_fin_inscripcion),
          estado: row.sorteo_estado,
          bloques: []
        });
      }

      sorteosMap.get(sorteoId).bloques.push({
        id: Number(row.bloque_fecha_id),
        servicio_id: Number(row.servicio_id),
        servicio_nombre: row.servicio_nombre,
        lugar: row.lugar,
        nombre: row.bloque_nombre,
        fecha_inicio: formatearFechaSQL(row.fecha_inicio),
        fecha_fin: formatearFechaSQL(row.fecha_fin),
        recursos_disponibles: Number(row.recursos_disponibles)
      });
    });

    res.status(200).json(Array.from(sorteosMap.values()));
  } catch (error) {
    registrarErrorRuta(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json([]);
    }
    res.status(500).json("Error al obtener sorteos activos");
  }
});

router.get("/sorteos/inscripcion-activa", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const db = mysqlConnection.promise();
    const inscripcion = await obtenerInscripcionSorteoActiva(db, cabecera.id);

    res.status(200).json({
      activa: !!inscripcion,
      inscripcion
    });
  } catch (error) {
    registrarErrorRuta(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json({ activa: false, inscripcion: null });
    }
    res.status(500).json("Error al obtener inscripcion activa");
  }
});

// Búsqueda de titulares para altas presenciales de Turismo. Mantiene el
// contrato de /coseguro/afiliados-buscar, pero aplica el módulo y la
// jurisdicción propios de Turismo.
router.get("/turismo/afiliados-buscar", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const q = normalizarTexto(req.query.q);
    if (!q || q.length < 2) return res.status(200).json([]);
    if (q.length > 100) return res.status(400).json("La búsqueda es demasiado larga");

    const condiciones = [
      "r.nombre = 'afiliado'",
      "u.habilitado = 'Y'",
      "u.usuario_familiar_id IS NULL",
      "u.modulo_turismo = 1",
    ];
    const params = [];
    if (cabecera.rol === "departamental") {
      const departamentalId = normalizarIdPositivo(cabecera.departamental_id);
      if (!departamentalId) return res.status(403).json("No tienes una departamental asignada");
      condiciones.push("u.departamental_id = ?");
      params.push(departamentalId);
    }
    condiciones.push(
      "(u.nombre LIKE ? OR u.apellido LIKE ? OR CAST(u.documento AS CHAR) LIKE ? OR CONCAT(u.apellido, ' ', u.nombre) LIKE ?)"
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);

    const [rows] = await mysqlConnection.promise().query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.departamental_id,
              u.modulo_coseguro, d.nombre AS departamental_nombre
         FROM usuario u
         INNER JOIN rol r ON r.id = u.rol_id
         LEFT JOIN departamental d ON d.id = u.departamental_id
        WHERE ${condiciones.join(" AND ")}
        ORDER BY u.apellido, u.nombre
        LIMIT 15`,
      params
    );
    return res.status(200).json(rows.map((row) => ({
      ...row,
      modulo_coseguro: Number(row.modulo_coseguro) === 1 ? 1 : 0,
    })));
  } catch (error) {
    registrarErrorRuta(error);
    return res.status(500).json("Error al buscar afiliados de Turismo");
  }
});

// El query parser de Express puede entregar arrays (?leida=0&leida=0):
// siempre se toma el primer valor escalar.
function primerValorQuery(valor) {
  return Array.isArray(valor) ? valor[0] : valor;
}

router.get("/notificaciones", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental", "admin-central", "auditor"].includes(cabecera.rol)) {
      return res.status(401).json("No autorizado");
    }
    const usuarioId = normalizarIdPositivo(cabecera.id);
    if (!usuarioId) return res.status(401).json("No autorizado");
    if (["limit", "page", "leida", "modulo", "buscar", "desde", "hasta"]
      .some((campo) => Array.isArray(req.query[campo]))) {
      return res.status(400).json("Los filtros de notificaciones son inválidos");
    }

    // Paginación (por defecto se comporta como la versión histórica: primeras 40).
    // El tope de página evita que el OFFSET se serialice en notación exponencial.
    const limite = req.query.limit === undefined ? 40 : normalizarIdPositivo(req.query.limit);
    const pagina = req.query.page === undefined ? 1 : normalizarIdPositivo(req.query.page);
    if (!limite || limite > 100 || !pagina || pagina > 100_000) {
      return res.status(400).json("La paginación es inválida");
    }
    const offset = (pagina - 1) * limite;

    const condiciones = ["n.usuario_id = ?"];
    const params = [usuarioId];
    const condicionesVisibilidad = [];
    const paramsVisibilidad = [];

    const modulosOcultos = cabecera.rol === "admin" ? [] : ["traslados"];
    if (cabecera.rol === "afiliado") {
      if (!tieneModuloTurismo(cabecera)) modulosOcultos.push("turismo");
      if (!tieneModuloCoseguro(cabecera)) modulosOcultos.push("coseguro", "salud");
      if (!tieneModuloOlimpiadas(cabecera)) modulosOcultos.push("olimpiadas");
    }
    for (const moduloOculto of modulosOcultos) {
      const condicionOculta = condicionModuloNotificacion(moduloOculto);
      condicionesVisibilidad.push(`NOT ${condicionOculta.sql}`);
      paramsVisibilidad.push(...condicionOculta.params);
    }
    if (condicionesVisibilidad.length > 0) {
      condiciones.push(...condicionesVisibilidad);
      params.push(...paramsVisibilidad);
    }

    const leidaParam = primerValorQuery(req.query.leida);
    if (leidaParam === "0" || leidaParam === "1") {
      condiciones.push("n.leida = ?");
      params.push(Number(leidaParam));
    } else if (leidaParam !== undefined) {
      return res.status(400).json("El filtro de lectura es inválido");
    }

    const moduloParam = primerValorQuery(req.query.modulo);
    if (typeof moduloParam === "string" && moduloParam) {
      const condicionModulo = condicionModuloNotificacion(moduloParam);
      if (!condicionModulo) {
        return res.status(400).json("Módulo inválido");
      }
      condiciones.push(condicionModulo.sql);
      params.push(...condicionModulo.params);
    }

    const buscarParam = primerValorQuery(req.query.buscar);
    const buscar = typeof buscarParam === "string" ? buscarParam.trim() : "";
    if (buscar.length > 200) return res.status(400).json("La búsqueda es demasiado larga");
    if (buscar) {
      condiciones.push("(n.titulo LIKE ? OR n.mensaje LIKE ?)");
      params.push(`%${buscar}%`, `%${buscar}%`);
    }

    const esFechaValida = valor => normalizarFechaCivil(valor) !== null;
    const desdeParam = primerValorQuery(req.query.desde);
    const hastaParam = primerValorQuery(req.query.hasta);
    if (desdeParam !== undefined && !esFechaValida(desdeParam)) {
      return res.status(400).json("La fecha desde es inválida");
    }
    if (hastaParam !== undefined && !esFechaValida(hastaParam)) {
      return res.status(400).json("La fecha hasta es inválida");
    }
    if (desdeParam && hastaParam && desdeParam > hastaParam) {
      return res.status(400).json("La fecha desde no puede ser posterior a la fecha hasta");
    }
    if (esFechaValida(desdeParam)) {
      condiciones.push("n.fecha_creacion >= ?");
      params.push(`${desdeParam} 00:00:00`);
    }
    if (esFechaValida(hastaParam)) {
      condiciones.push("n.fecha_creacion < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(`${hastaParam} 00:00:00`);
    }

    const where = condiciones.join(" AND ");
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `
        SELECT
          n.id,
          n.tipo,
          n.titulo,
          n.mensaje,
          n.leida,
          n.fecha_creacion,
          n.fecha_lectura,
          CAST(n.payload AS CHAR) AS payload,
          sar.estado AS adjudicacion_estado
        FROM notificacion n
        LEFT JOIN sorteo_adjudicacion_respuesta sar ON sar.notificacion_id = n.id
        WHERE ${where}
        ORDER BY n.fecha_creacion DESC, n.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limite, offset]
    );

    const notificaciones = rows.map(row => ({
      id: Number(row.id),
      tipo: row.tipo,
      titulo: row.titulo,
      mensaje: row.mensaje,
      leida: row.leida === 1 || row.leida === true,
      fecha_creacion: row.fecha_creacion,
      fecha_lectura: row.fecha_lectura,
      payload: parseJsonSeguro(row.payload),
      adjudicacion_estado: row.adjudicacion_estado || null
    }));

    const [totalRows] = await db.query(
      `SELECT COUNT(*) AS total FROM notificacion n WHERE ${where}`,
      params
    );
    const total = Number(totalRows?.[0]?.total || 0);

    const whereNoLeidas = ["n.usuario_id = ?", "n.leida = 0", ...condicionesVisibilidad].join(" AND ");
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM notificacion n WHERE ${whereNoLeidas}`,
      [usuarioId, ...paramsVisibilidad]
    );

    res.status(200).json({
      notificaciones,
      no_leidas: Number(countRows?.[0]?.total || 0),
      total,
      pagina,
      paginas: Math.max(1, Math.ceil(total / limite)),
      hay_mas: offset + rows.length < total
    });
  } catch (error) {
    registrarErrorRuta(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json({ notificaciones: [], no_leidas: 0, total: 0, pagina: 1, paginas: 1, hay_mas: false });
    }
    res.status(500).json("Error al obtener notificaciones");
  }
});

router.put("/notificaciones/leidas", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental", "admin-central", "auditor"].includes(cabecera.rol)) {
      return res.status(401).json("No autorizado");
    }

    const [result] = await mysqlConnection.promise().query(
      `
        UPDATE notificacion
        SET leida = 1,
            fecha_lectura = COALESCE(fecha_lectura, NOW())
        WHERE usuario_id = ? AND leida = 0
      `,
      [cabecera.id]
    );

    res.status(200).json({
      message: "Notificaciones marcadas como leidas",
      actualizadas: Number(result.affectedRows || 0)
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al marcar notificaciones");
  }
});

router.put("/notificaciones/:id/leida", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental", "admin-central", "auditor"].includes(cabecera.rol)) {
      return res.status(401).json("No autorizado");
    }

    const notificacionId = normalizarIdPositivo(req.params.id);
    if (!notificacionId) {
      return res.status(400).json("ID invalido");
    }

    const [result] = await mysqlConnection.promise().query(
      `
        UPDATE notificacion
        SET leida = 1,
            fecha_lectura = COALESCE(fecha_lectura, NOW())
        WHERE id = ? AND usuario_id = ?
      `,
      [notificacionId, cabecera.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json("Notificacion no encontrada");
    }

    res.status(200).json({ message: "Notificacion marcada como leida" });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al marcar notificacion");
  }
});

// ---------------------------------------------------------------------------
// Lectura de los hilos de chat (badge de "no leídos" del chat flotante).
// Guarda, por usuario y entidad, el id del último mensaje visto.
// ---------------------------------------------------------------------------
const MODULOS_OBSERVACION = ["turismo", "coseguro", "traslados", "olimpiadas"];

router.get("/observaciones/:modulo/:entidadId/lectura", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental", "admin-central", "auditor"].includes(cabecera.rol)) {
      return res.status(401).json("No autorizado");
    }
    const modulo = req.params.modulo;
    const entidadId = normalizarIdPositivo(req.params.entidadId);
    if (!MODULOS_OBSERVACION.includes(modulo) || !entidadId) {
      return res.status(400).json("Parámetros inválidos");
    }

    const [rows] = await mysqlConnection.promise().query(
      "SELECT ultima_observacion_id FROM observacion_lectura WHERE usuario_id = ? AND modulo = ? AND entidad_id = ?",
      [cabecera.id, modulo, entidadId]
    );
    res.status(200).json({ ultima_observacion_id: rows.length ? Number(rows[0].ultima_observacion_id) : 0 });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la lectura del chat");
  }
});

router.put("/observaciones/:modulo/:entidadId/lectura", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental", "admin-central", "auditor"].includes(cabecera.rol)) {
      return res.status(401).json("No autorizado");
    }
    const modulo = req.params.modulo;
    const entidadId = normalizarIdPositivo(req.params.entidadId);
    const ultimaObservacionId = normalizarIdPositivo(req.body.ultima_observacion_id);
    if (!MODULOS_OBSERVACION.includes(modulo) || !entidadId || !ultimaObservacionId) {
      return res.status(400).json("Parámetros inválidos");
    }

    await mysqlConnection.promise().query(
      `INSERT INTO observacion_lectura (usuario_id, modulo, entidad_id, ultima_observacion_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         ultima_observacion_id = GREATEST(ultima_observacion_id, VALUES(ultima_observacion_id))`,
      [cabecera.id, modulo, entidadId, ultimaObservacionId]
    );
    res.status(200).json({ success: true });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al marcar el chat como leído");
  }
});

router.get("/sorteos/adjudicaciones/pendiente", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "afiliado" || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const adjudicacion = await obtenerPremioSorteoPendiente(mysqlConnection.promise(), cabecera.id);
    res.status(200).json({
      pendiente: !!adjudicacion,
      adjudicacion
    });
  } catch (error) {
    registrarErrorRuta(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json({ pendiente: false, adjudicacion: null });
    }
    res.status(500).json("Error al obtener adjudicacion pendiente");
  }
});

router.put("/sorteos/adjudicaciones/:id/aceptar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "afiliado" || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const adjudicacionId = normalizarIdPositivo(req.params.id);
    if (!adjudicacionId) {
      return res.status(400).json("ID invalido");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const adjudicacion = await obtenerPremioSorteoPorAdjudicacion(connection, {
      adjudicacionId,
      usuarioId: cabecera.id,
      forUpdate: true
    });

    if (!adjudicacion) {
      await connection.rollback();
      return res.status(404).json("Adjudicacion no encontrada");
    }

    if (adjudicacion.estado !== "PENDIENTE") {
      await connection.rollback();
      return res.status(409).json("La adjudicacion ya fue respondida");
    }

    const errorVigencia = validarRespuestaAdjudicacion({
      estadoBloque: adjudicacion.bloque_estado,
      estadoSorteo: adjudicacion.sorteo_estado,
      fechaInicioBloque: adjudicacion.bloque_fecha_inicio,
      hoy: obtenerFechaCivilHoyArgentina(),
    });
    if (errorVigencia) {
      throw crearErrorNegocio(errorVigencia.mensaje, 409, errorVigencia.codigo);
    }

    await connection.query(
      `
        UPDATE sorteo_adjudicacion_respuesta
        SET estado = 'ACEPTADA',
            fecha_respuesta = NOW()
        WHERE id = ?
      `,
      [adjudicacionId]
    );

    if (adjudicacion.notificacion_id) {
      await connection.query(
        `
          UPDATE notificacion
          SET leida = 1,
              fecha_lectura = COALESCE(fecha_lectura, NOW())
          WHERE id = ? AND usuario_id = ?
        `,
        [adjudicacion.notificacion_id, cabecera.id]
      );
    }

    await registrarHistorialReserva(
      connection,
      adjudicacion.reserva_id,
      "UPDATE",
      cabecera.id,
      req,
      [{ campo: "sorteo_adjudicacion_respuesta.estado", valorAnterior: "PENDIENTE", valorNuevo: "ACEPTADA" }],
      "Aceptacion de premio adjudicado por afiliado"
    );

    await connection.commit();
    res.status(200).json({ message: "Premio aceptado", reserva_id: adjudicacion.reserva_id });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al aceptar premio");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/sorteos/adjudicaciones/:id/rechazar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "afiliado" || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const adjudicacionId = normalizarIdPositivo(req.params.id);
    if (!adjudicacionId) {
      return res.status(400).json("ID invalido");
    }

    if (req.body?.confirmacion !== true) {
      return res.status(400).json("Debe confirmar el rechazo del premio");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const adjudicacion = await obtenerPremioSorteoPorAdjudicacion(connection, {
      adjudicacionId,
      usuarioId: cabecera.id,
      forUpdate: true
    });

    if (!adjudicacion) {
      await connection.rollback();
      return res.status(404).json("Adjudicacion no encontrada");
    }

    if (adjudicacion.estado !== "PENDIENTE") {
      await connection.rollback();
      return res.status(409).json("La adjudicacion ya fue respondida");
    }

    const errorVigencia = validarRespuestaAdjudicacion({
      estadoBloque: adjudicacion.bloque_estado,
      estadoSorteo: adjudicacion.sorteo_estado,
      fechaInicioBloque: adjudicacion.bloque_fecha_inicio,
      hoy: obtenerFechaCivilHoyArgentina(),
    });
    if (errorVigencia) {
      throw crearErrorNegocio(errorVigencia.mensaje, 409, errorVigencia.codigo);
    }
    const estadoRecursoLiberado = obtenerEstadoRecursoTrasRechazo({
      estadoBloque: adjudicacion.bloque_estado,
      estadoSorteo: adjudicacion.sorteo_estado,
    });

    const [reservaRows] = await connection.query(
      "SELECT id, estado_reserva_id, recurso_id, observaciones FROM reserva WHERE id = ? FOR UPDATE",
      [adjudicacion.reserva_id]
    );
    if (reservaRows.length === 0) {
      await connection.rollback();
      return res.status(404).json("Reserva no encontrada");
    }

    const reservaAnterior = reservaRows[0];
    const observaciones = req.body.observaciones || null;
    const estadoNoAdjudicadaId = await obtenerEstadoReservaId(connection, "No adjudicada", ESTADO_RESERVA_RECHAZADA_ID);

    await connection.query(
      `
        UPDATE sorteo_adjudicacion_respuesta
        SET estado = 'RECHAZADA',
            fecha_respuesta = NOW(),
            observaciones = ?
        WHERE id = ?
      `,
      [observaciones, adjudicacionId]
    );

    await connection.query(
      `
        UPDATE reserva
        SET estado_reserva_id = ?,
            recurso_id = NULL,
            observaciones = COALESCE(?, observaciones),
            fecha_modificacion = NOW()
        WHERE id = ?
      `,
      [estadoNoAdjudicadaId, observaciones, adjudicacion.reserva_id]
    );

    await connection.query(
      `
        UPDATE bloque_fecha_recurso
        SET estado = ?,
            reserva_id = NULL
        WHERE bloque_fecha_id = ?
          AND recurso_id = ?
          AND reserva_id = ?
      `,
      [estadoRecursoLiberado, adjudicacion.bloque_fecha_id, adjudicacion.recurso_id, adjudicacion.reserva_id]
    );

    if (adjudicacion.notificacion_id) {
      await connection.query(
        `
          UPDATE notificacion
          SET leida = 1,
              fecha_lectura = COALESCE(fecha_lectura, NOW())
          WHERE id = ? AND usuario_id = ?
        `,
        [adjudicacion.notificacion_id, cabecera.id]
      );
    }

    await registrarHistorialReserva(
      connection,
      adjudicacion.reserva_id,
      "UPDATE",
      cabecera.id,
      req,
      [
        { campo: "estado_reserva_id", valorAnterior: reservaAnterior.estado_reserva_id, valorNuevo: estadoNoAdjudicadaId },
        { campo: "recurso_id", valorAnterior: reservaAnterior.recurso_id, valorNuevo: null },
        { campo: "sorteo_adjudicacion_respuesta.estado", valorAnterior: "PENDIENTE", valorNuevo: "RECHAZADA" }
      ],
      "Rechazo de premio adjudicado por afiliado"
    );

    await connection.commit();
    res.status(200).json({ message: "Premio rechazado" });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al rechazar premio");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.get("/admin/sorteos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const db = mysqlConnection.promise();
    await ejecutarMantenimientoBloquesAlta(db);
    const [sorteos] = await db.query(
      `SELECT id, nombre, descripcion, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado, fecha_creacion
       FROM sorteo
       ORDER BY fecha_creacion DESC, id DESC`
    );

    if (sorteos.length === 0) {
      return res.status(200).json([]);
    }

    const sorteoIds = sorteos.map((sorteo) => sorteo.id);
    const [bloques] = await db.query(
      `
        SELECT
          bf.id,
          bf.sorteo_id,
          bf.servicio_id,
          bf.temporada_tarifa_id,
          bf.nombre,
          bf.modalidad,
          bf.fecha_inicio,
          bf.fecha_fin,
          bf.estado,
          srv.nombre AS servicio_nombre,
          srv.lugar
        FROM bloque_fecha bf
        INNER JOIN servicio srv ON srv.id = bf.servicio_id
        WHERE bf.sorteo_id IN (?)
        ORDER BY bf.fecha_inicio ASC, bf.id ASC
      `,
      [sorteoIds]
    );

    const bloqueIds = bloques.map((bloque) => bloque.id);
    let recursos = [];
    if (bloqueIds.length > 0) {
      const [recursosRows] = await db.query(
        `
          SELECT bfr.bloque_fecha_id, bfr.recurso_id, bfr.estado, bfr.reserva_id, r.nombre AS recurso_nombre
          FROM bloque_fecha_recurso bfr
          INNER JOIN recurso r ON r.id = bfr.recurso_id
          WHERE bfr.bloque_fecha_id IN (?)
          ORDER BY r.nombre ASC
        `,
        [bloqueIds]
      );
      recursos = recursosRows;
    }

    const recursosPorBloque = new Map();
    recursos.forEach((recurso) => {
      if (!recursosPorBloque.has(recurso.bloque_fecha_id)) {
        recursosPorBloque.set(recurso.bloque_fecha_id, []);
      }
      recursosPorBloque.get(recurso.bloque_fecha_id).push({
        recurso_id: Number(recurso.recurso_id),
        nombre: recurso.recurso_nombre,
        estado: recurso.estado,
        reserva_id: recurso.reserva_id
      });
    });

    const bloquesPorSorteo = new Map();
    bloques.forEach((bloque) => {
      if (!bloquesPorSorteo.has(bloque.sorteo_id)) {
        bloquesPorSorteo.set(bloque.sorteo_id, []);
      }
      bloquesPorSorteo.get(bloque.sorteo_id).push({
        id: Number(bloque.id),
        servicio_id: Number(bloque.servicio_id),
        servicio_nombre: bloque.servicio_nombre,
        lugar: bloque.lugar,
        nombre: bloque.nombre,
        modalidad: bloque.modalidad,
        fecha_inicio: formatearFechaSQL(bloque.fecha_inicio),
        fecha_fin: formatearFechaSQL(bloque.fecha_fin),
        estado: bloque.estado,
        recursos: recursosPorBloque.get(bloque.id) || []
      });
    });

    res.status(200).json(sorteos.map((sorteo) => ({
      id: Number(sorteo.id),
      nombre: sorteo.nombre,
      descripcion: sorteo.descripcion,
      fecha_inicio_inscripcion: formatearFechaSQL(sorteo.fecha_inicio_inscripcion),
      fecha_fin_inscripcion: formatearFechaSQL(sorteo.fecha_fin_inscripcion),
      estado: sorteo.estado,
      fecha_creacion: sorteo.fecha_creacion,
      bloques: bloquesPorSorteo.get(sorteo.id) || []
    })));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener sorteos");
  }
});

router.post("/admin/sorteos", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const {
      nombre,
      descripcion,
      fecha_inicio_inscripcion,
      fecha_fin_inscripcion,
      estado = "BORRADOR",
      bloques = []
    } = req.body;

    if (!nombre || !fecha_inicio_inscripcion || !fecha_fin_inscripcion) {
      return res.status(400).json("Faltan campos requeridos");
    }
    const nombreSorteo = normalizarTexto(nombre);
    const inicioInscripcion = formatearFechaSQL(fecha_inicio_inscripcion);
    const finInscripcion = formatearFechaSQL(fecha_fin_inscripcion);
    const estadoSorteo = String(estado || "BORRADOR").trim().toUpperCase();
    if (
      !nombreSorteo || nombreSorteo.length > 150 || !inicioInscripcion || !finInscripcion ||
      inicioInscripcion > finInscripcion || !estadoInicialSorteoPermitido(estadoSorteo)
    ) {
      return res.status(400).json("Nombre, fechas o estado del sorteo no válidos");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [sorteoResult] = await connection.query(
      `INSERT INTO sorteo (nombre, descripcion, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado)
       VALUES (?, ?, ?, ?, ?)`,
      [nombreSorteo, descripcion || null, inicioInscripcion, finInscripcion, estadoSorteo]
    );

    const sorteoId = sorteoResult.insertId;

    const clavesRecursos = new Set();
    for (let indiceBloque = 0; indiceBloque < (Array.isArray(bloques) ? bloques.length : 0); indiceBloque++) {
      const bloque = bloques[indiceBloque];
      const servicioId = normalizarIdPositivo(bloque.servicio_id);
      const recursosIds = Array.isArray(bloque.recursos)
        ? bloque.recursos.map(normalizarIdPositivo).filter(Boolean)
        : [];
      const inicioBloque = formatearFechaSQL(bloque.fecha_inicio);
      const finBloque = formatearFechaSQL(bloque.fecha_fin);

      if (
        !servicioId || !normalizarTexto(bloque.nombre) || !inicioBloque || !finBloque ||
        diferenciaDiasCivil(inicioBloque, finBloque) <= 0 || inicioBloque <= finInscripcion ||
        recursosIds.length === 0 || new Set(recursosIds).size !== recursosIds.length
      ) {
        throw crearErrorNegocio(`El bloque ${indiceBloque + 1} tiene datos, fechas o recursos inválidos`, 400);
      }
      const [recursosValidos] = await connection.query(
        `SELECT id FROM recurso WHERE servicio_id = ? AND id IN (${recursosIds.map(() => "?").join(",")}) FOR UPDATE`,
        [servicioId, ...recursosIds]
      );
      if (recursosValidos.length !== recursosIds.length) {
        throw crearErrorNegocio(`El bloque ${indiceBloque + 1} contiene recursos ajenos al servicio`, 400);
      }
      for (const recursoId of recursosIds) {
        const clave = `${recursoId}:${inicioBloque}:${finBloque}`;
        if (clavesRecursos.has(clave)) throw crearErrorNegocio("Un recurso está repetido en el mismo rango de sorteo", 400);
        clavesRecursos.add(clave);
      }

      const [bloqueResult] = await connection.query(
        `INSERT INTO bloque_fecha
          (sorteo_id, servicio_id, nombre, modalidad, fecha_inicio, fecha_fin, estado)
         VALUES (?, ?, ?, 'SORTEO', ?, ?, 'ACTIVO')`,
        [sorteoId, servicioId, normalizarTexto(bloque.nombre), inicioBloque, finBloque]
      );

      for (const recursoId of recursosIds) {
        await connection.query(
          `INSERT INTO bloque_fecha_recurso (bloque_fecha_id, recurso_id, estado)
           VALUES (?, ?, 'SORTEO')`,
          [bloqueResult.insertId, recursoId]
        );
      }
    }

    await connection.commit();
    res.status(201).json({ id: sorteoId, message: "Sorteo creado correctamente" });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al crear sorteo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/sorteos/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    const { nombre, descripcion, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado } = req.body;
    if (!sorteoId || !nombre || !fecha_inicio_inscripcion || !fecha_fin_inscripcion || !estado) {
      return res.status(400).json("Faltan campos requeridos");
    }

    const nombreSorteo = normalizarTexto(nombre);
    const inicio = formatearFechaSQL(fecha_inicio_inscripcion);
    const fin = formatearFechaSQL(fecha_fin_inscripcion);
    const estadoSorteo = String(estado).trim().toUpperCase();
    if (!nombreSorteo || nombreSorteo.length > 150 || !inicio || !fin || inicio > fin || !["BORRADOR", "ACTIVO", "CERRADO", "CANCELADO"].includes(estadoSorteo)) {
      return res.status(400).json("Nombre, fechas o estado del sorteo no válidos");
    }
    if (estadoSorteo === "CANCELADO") {
      return res.status(409).json("Usá la operación de cancelación para cerrar también bloques e inscripciones");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [sorteos] = await connection.query("SELECT id FROM sorteo WHERE id = ? FOR UPDATE", [sorteoId]);
    if (sorteos.length === 0) throw crearErrorNegocio("Sorteo no encontrado", 404);
    const [bloquesInvalidos] = await connection.query(
      "SELECT id FROM bloque_fecha WHERE sorteo_id = ? AND fecha_inicio <= ? LIMIT 1 FOR UPDATE",
      [sorteoId, fin]
    );
    if (bloquesInvalidos.length > 0) {
      throw crearErrorNegocio("La inscripción debe cerrar antes del inicio de todos los bloques", 409);
    }
    await connection.query(
      `UPDATE sorteo
       SET nombre = ?, descripcion = ?, fecha_inicio_inscripcion = ?, fecha_fin_inscripcion = ?, estado = ?
       WHERE id = ?`,
      [nombreSorteo, descripcion || null, inicio, fin, estadoSorteo, sorteoId]
    );
    await connection.commit();

    res.status(200).json({ message: "Sorteo actualizado correctamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    res.status(500).json("Error al actualizar sorteo");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/admin/sorteos/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    if (!sorteoId) {
      return res.status(400).json("ID invalido");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [sorteos] = await connection.query("SELECT id, estado FROM sorteo WHERE id = ? FOR UPDATE", [sorteoId]);
    if (sorteos.length === 0) throw crearErrorNegocio("Sorteo no encontrado", 404);
    if (sorteos[0].estado === "CANCELADO") throw crearErrorNegocio("El sorteo ya está cancelado", 409);

    const [reservas] = await connection.query(
      `SELECT r.id, r.estado_reserva_id
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
       WHERE r.sorteo_id = ?
         AND COALESCE(er.nombre, '') NOT IN ('Cancelada', 'Rechazada', 'No adjudicada')
       FOR UPDATE`,
      [sorteoId]
    );
    const [estadosCancelacion] = await connection.query(
      "SELECT id FROM estado_reserva WHERE nombre IN ('Cancelada', 'Rechazada') ORDER BY nombre = 'Cancelada' DESC LIMIT 1"
    );
    if (estadosCancelacion.length === 0) throw crearErrorNegocio("No existe un estado de cancelación configurado", 409);
    const estadoCancelacionId = Number(estadosCancelacion[0].id);

    for (const reserva of reservas) {
      await registrarHistorialReserva(
        connection,
        reserva.id,
        "UPDATE",
        cabecera.id,
        req,
        [{ campo: "estado_reserva_id", valorAnterior: reserva.estado_reserva_id, valorNuevo: estadoCancelacionId }],
        `Cancelación integral del sorteo ${sorteoId}`
      );
    }
    await connection.query("UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE sorteo_id = ?", [estadoCancelacionId, sorteoId]);
    await connection.query(
      `UPDATE bloque_fecha_recurso bfr
       INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
       SET bfr.estado = 'LIBERADO', bfr.reserva_id = NULL
       WHERE bf.sorteo_id = ?`,
      [sorteoId]
    );
    await connection.query(
      "UPDATE sorteo_adjudicacion_respuesta SET estado = 'RECHAZADA', fecha_respuesta = COALESCE(fecha_respuesta, NOW()) WHERE sorteo_id = ? AND estado = 'PENDIENTE'",
      [sorteoId]
    );
    await connection.query("UPDATE bloque_fecha SET estado = 'CANCELADO' WHERE sorteo_id = ?", [sorteoId]);
    await connection.query("UPDATE sorteo SET estado = 'CANCELADO' WHERE id = ?", [sorteoId]);
    await connection.commit();
    res.status(200).json({ message: "Sorteo cancelado correctamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    res.status(500).json("Error al cancelar sorteo");
  } finally {
    if (connection) connection.release();
  }
});

router.post("/admin/bloques", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const {
      nombre,
      servicio_id,
      modalidad = MODALIDAD_BLOQUE,
      fecha_inicio,
      fecha_fin,
      recursos = [],
      sorteo_id = null,
      tarifas = null
    } = req.body;
    const servicioId = normalizarIdPositivo(servicio_id);
    const modalidadNormalizada = normalizarModalidad(modalidad);
    const recursosIds = Array.isArray(recursos) ? recursos.map(normalizarIdPositivo).filter(Boolean) : [];

    if (!nombre || !servicioId || !fecha_inicio || !fecha_fin || recursosIds.length === 0) {
      return res.status(400).json("Faltan campos requeridos");
    }

    if (modalidadNormalizada === MODALIDAD_SORTEO && !normalizarIdPositivo(sorteo_id)) {
      return res.status(400).json("Debe seleccionar un sorteo para bloques de sorteo");
    }

    if (!tarifas || !Array.isArray(tarifas.configuracion_servicios) || tarifas.configuracion_servicios.length === 0) {
      return res.status(400).json("Debe cargar tarifas para los recursos del bloque");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const placeholders = recursosIds.map(() => "?").join(",");
    const [recursosServicio] = await connection.query(
      `SELECT id FROM recurso WHERE id IN (${placeholders}) AND servicio_id = ? FOR UPDATE`,
      [...recursosIds, servicioId]
    );

    if (recursosServicio.length !== recursosIds.length) {
      await connection.rollback();
      return res.status(400).json("Todos los recursos seleccionados deben pertenecer al servicio elegido");
    }

    const [bloquesSolapados] = await connection.query(
      `
        SELECT bf.id, bf.nombre
        FROM bloque_fecha_recurso bfr
        INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
        WHERE bfr.recurso_id IN (${placeholders})
          AND bf.estado = 'ACTIVO'
          AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA','RESERVADO','ASIGNADO')
          AND bf.fecha_inicio < ?
          AND bf.fecha_fin > ?
        LIMIT 1
        FOR UPDATE
      `,
      [...recursosIds, fecha_fin, fecha_inicio]
    );

    if (bloquesSolapados.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        message: `Hay recursos seleccionados que ya pertenecen al bloque activo "${bloquesSolapados[0].nombre}"`
      });
    }

    const errorCoberturaTarifas = validarCoberturaTarifasBloque(tarifas.configuracion_servicios, {
      fechaInicio: fecha_inicio,
      fechaFin: fecha_fin,
      recursosIds
    });

    if (errorCoberturaTarifas) {
      await connection.rollback();
      return res.status(400).json({ message: errorCoberturaTarifas });
    }

    await validarSolapamientoTarifasExistentes(connection, {
      configuracionServicios: tarifas.configuracion_servicios,
      origenes: ["GENERAL", "BLOQUE"]
    });

    const temporada = await crearTemporadaTarifasDesdeConfiguracion(connection, {
      nombre_campania: tarifas.nombre_campania || `Bloque ${nombre}`,
      fecha_inicio,
      fecha_fin,
      configuracion_servicios: tarifas.configuracion_servicios,
      porcentajes_tipo_persona: tarifas.porcentajes_tipo_persona || [],
      origen: "BLOQUE",
      usuario_id: cabecera.id
    });

    const [bloqueResult] = await connection.query(
      `INSERT INTO bloque_fecha (sorteo_id, servicio_id, temporada_tarifa_id, nombre, modalidad, fecha_inicio, fecha_fin, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVO')`,
      [
        modalidadNormalizada === MODALIDAD_SORTEO ? normalizarIdPositivo(sorteo_id) : null,
        servicioId,
        temporada.temporadaId,
        nombre,
        modalidadNormalizada,
        fecha_inicio,
        fecha_fin
      ]
    );

    for (const recursoId of recursosIds) {
      await connection.query(
        `INSERT INTO bloque_fecha_recurso (bloque_fecha_id, recurso_id, estado)
         VALUES (?, ?, ?)`,
        [bloqueResult.insertId, recursoId, modalidadNormalizada === MODALIDAD_SORTEO ? "SORTEO" : "DISPONIBLE"]
      );
    }

    await connection.commit();
    res.status(201).json({
      id: bloqueResult.insertId,
      temporada_tarifa_id: temporada.temporadaId,
      message: "Bloque creado correctamente"
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al crear bloque");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/bloques/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const bloqueId = normalizarIdPositivo(req.params.id);
    const {
      nombre,
      servicio_id,
      modalidad = MODALIDAD_BLOQUE,
      fecha_inicio,
      fecha_fin,
      recursos = [],
      sorteo_id = null,
      tarifas = null
    } = req.body;
    const servicioId = normalizarIdPositivo(servicio_id);
    const modalidadNormalizada = normalizarModalidad(modalidad);
    const recursosIds = Array.isArray(recursos) ? recursos.map(normalizarIdPositivo).filter(Boolean) : [];

    if (!bloqueId || !nombre || !servicioId || !fecha_inicio || !fecha_fin || recursosIds.length === 0) {
      return res.status(400).json("Faltan campos requeridos");
    }

    if (modalidadNormalizada === MODALIDAD_SORTEO && !normalizarIdPositivo(sorteo_id)) {
      return res.status(400).json("Debe seleccionar un sorteo para bloques de sorteo");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [bloques] = await connection.query(
      "SELECT id, temporada_tarifa_id FROM bloque_fecha WHERE id = ? FOR UPDATE",
      [bloqueId]
    );
    if (bloques.length === 0) {
      await connection.rollback();
      return res.status(404).json("Bloque no encontrado");
    }

    const [reservas] = await connection.query(
      `SELECT id FROM reserva
       WHERE bloque_fecha_id = ?
         AND COALESCE(estado_reserva_id, ?) <> ?
       LIMIT 1
       FOR UPDATE`,
      [bloqueId, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );
    if (reservas.length > 0) {
      await connection.rollback();
      return res.status(409).json("No se puede editar un bloque con reservas o inscripciones");
    }

    const placeholders = recursosIds.map(() => "?").join(",");
    const [recursosServicio] = await connection.query(
      `SELECT id FROM recurso WHERE id IN (${placeholders}) AND servicio_id = ? FOR UPDATE`,
      [...recursosIds, servicioId]
    );
    if (recursosServicio.length !== recursosIds.length) {
      await connection.rollback();
      return res.status(400).json("Todos los recursos seleccionados deben pertenecer al servicio elegido");
    }

    const [bloquesSolapados] = await connection.query(
      `
        SELECT bf.id, bf.nombre
        FROM bloque_fecha_recurso bfr
        INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
        WHERE bfr.recurso_id IN (${placeholders})
          AND bf.id <> ?
          AND bf.estado = 'ACTIVO'
          AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA','RESERVADO','ASIGNADO')
          AND bf.fecha_inicio < ?
          AND bf.fecha_fin > ?
        LIMIT 1
        FOR UPDATE
      `,
      [...recursosIds, bloqueId, fecha_fin, fecha_inicio]
    );
    if (bloquesSolapados.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        message: `Hay recursos seleccionados que ya pertenecen al bloque activo "${bloquesSolapados[0].nombre}"`
      });
    }

    let temporadaTarifaId = bloques[0].temporada_tarifa_id || null;
    if (tarifas && Array.isArray(tarifas.configuracion_servicios) && tarifas.configuracion_servicios.length > 0) {
      const errorCoberturaTarifas = validarCoberturaTarifasBloque(tarifas.configuracion_servicios, {
        fechaInicio: fecha_inicio,
        fechaFin: fecha_fin,
        recursosIds
      });

      if (errorCoberturaTarifas) {
        await connection.rollback();
        return res.status(400).json({ message: errorCoberturaTarifas });
      }

      await validarSolapamientoTarifasExistentes(connection, {
        configuracionServicios: tarifas.configuracion_servicios,
        excludeTemporadaTarifaId: temporadaTarifaId,
        origenes: ["GENERAL", "BLOQUE"]
      });

      const temporadaAnteriorId = temporadaTarifaId;
      const temporada = await crearTemporadaTarifasDesdeConfiguracion(connection, {
        nombre_campania: tarifas.nombre_campania || `Bloque ${nombre}`,
        fecha_inicio,
        fecha_fin,
        configuracion_servicios: tarifas.configuracion_servicios,
        porcentajes_tipo_persona: tarifas.porcentajes_tipo_persona || [],
        origen: "BLOQUE",
        usuario_id: cabecera.id
      });
      temporadaTarifaId = temporada.temporadaId;

      if (temporadaAnteriorId) {
        const tieneHistoria = await temporadaTieneReferenciasHistoricas(connection, temporadaAnteriorId);
        if (!tieneHistoria) {
          await connection.query("DELETE FROM temporada_tarifa WHERE id = ?", [temporadaAnteriorId]);
        }
      }
    }

    await connection.query(
      `UPDATE bloque_fecha
       SET sorteo_id = ?, servicio_id = ?, temporada_tarifa_id = ?, nombre = ?, modalidad = ?, fecha_inicio = ?, fecha_fin = ?
       WHERE id = ?`,
      [
        modalidadNormalizada === MODALIDAD_SORTEO ? normalizarIdPositivo(sorteo_id) : null,
        servicioId,
        temporadaTarifaId,
        nombre,
        modalidadNormalizada,
        fecha_inicio,
        fecha_fin,
        bloqueId
      ]
    );

    await connection.query("DELETE FROM bloque_fecha_recurso WHERE bloque_fecha_id = ?", [bloqueId]);
    for (const recursoId of recursosIds) {
      await connection.query(
        `INSERT INTO bloque_fecha_recurso (bloque_fecha_id, recurso_id, estado)
         VALUES (?, ?, ?)`,
        [bloqueId, recursoId, modalidadNormalizada === MODALIDAD_SORTEO ? "SORTEO" : "DISPONIBLE"]
      );
    }

    await connection.commit();
    res.status(200).json({ message: "Bloque actualizado correctamente" });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al actualizar bloque");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.get("/admin/bloques", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const [rows] = await mysqlConnection.promise().query(
      `
        SELECT
          bf.id,
          bf.sorteo_id,
          bf.servicio_id,
          bf.temporada_tarifa_id,
          bf.nombre,
          bf.modalidad,
          bf.fecha_inicio,
          bf.fecha_fin,
          bf.estado,
          s.nombre AS servicio_nombre,
          s.lugar,
          COUNT(bfr.id) AS recursos
        FROM bloque_fecha bf
        INNER JOIN servicio s ON s.id = bf.servicio_id
        LEFT JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
        GROUP BY bf.id, s.id
        ORDER BY bf.fecha_inicio DESC, bf.id DESC
      `
    );

    const bloqueIds = rows.map((row) => Number(row.id));
    let recursosPorBloque = new Map();
    if (bloqueIds.length > 0) {
      const placeholders = bloqueIds.map(() => "?").join(",");
      const [recursosRows] = await mysqlConnection.promise().query(
        `
          SELECT
            bfr.bloque_fecha_id,
            bfr.recurso_id,
            bfr.estado,
            r.nombre
          FROM bloque_fecha_recurso bfr
          INNER JOIN recurso r ON r.id = bfr.recurso_id
          WHERE bfr.bloque_fecha_id IN (${placeholders})
          ORDER BY r.nombre ASC
        `,
        bloqueIds
      );

      recursosRows.forEach((recurso) => {
        const bloqueId = Number(recurso.bloque_fecha_id);
        if (!recursosPorBloque.has(bloqueId)) {
          recursosPorBloque.set(bloqueId, []);
        }
        recursosPorBloque.get(bloqueId).push({
          recurso_id: Number(recurso.recurso_id),
          nombre: recurso.nombre,
          estado: recurso.estado
        });
      });
    }

    res.status(200).json(rows.map((row) => ({
      ...row,
      fecha_inicio: formatearFechaSQL(row.fecha_inicio),
      fecha_fin: formatearFechaSQL(row.fecha_fin),
      temporada_tarifa_id: row.temporada_tarifa_id ? Number(row.temporada_tarifa_id) : null,
      recursos: Number(row.recursos || 0),
      recursos_detalle: recursosPorBloque.get(Number(row.id)) || []
    })));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener bloques");
  }
});

router.get("/admin/sorteos/:id/inscripciones", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    if (!sorteoId) {
      return res.status(400).json("ID invalido");
    }

    const [rows] = await mysqlConnection.promise().query(
      `
        SELECT
          r.id,
          r.usuario_id,
          u.documento AS afiliado,
          CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, '')) AS afiliado_nombre,
          er.nombre AS estado,
          r.precio_total,
          r.monto_adicionales,
          r.fecha_inicio,
          r.fecha_fin,
          r.observaciones,
          r.recurso_id,
          rec.nombre AS recurso,
          bf.nombre AS bloque,
          bf.id AS bloque_fecha_id
        FROM reserva r
        INNER JOIN usuario u ON u.id = r.usuario_id
        LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
        LEFT JOIN recurso rec ON rec.id = r.recurso_id
        LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
        WHERE r.sorteo_id = ?
          AND r.modalidad = 'SORTEO'
        ORDER BY r.fecha_creacion ASC
      `,
      [sorteoId]
    );

    const inscripciones = [];
    for (const row of rows) {
      const [personasRows] = await mysqlConnection.promise().query(
        `
          SELECT
            rf.tipo_persona_id,
            tp.nombre AS tipo_persona,
            rf.parentesco_id,
            p.nombre AS parentesco,
            u.nombre,
            u.apellido,
            u.documento,
            u.fecha_nacimiento,
            u.telefono,
            rf.edad,
            rf.precio AS tarifa_individual
          FROM reserva_familiar rf
          INNER JOIN usuario u ON u.id = rf.usuario_id
          LEFT JOIN tipo_persona tp ON tp.id = rf.tipo_persona_id
          LEFT JOIN parentesco p ON p.id = rf.parentesco_id
          WHERE rf.reserva_id = ?
          ORDER BY rf.id ASC
        `,
        [row.id]
      );

      const [adicionalesRows] = await mysqlConnection.promise().query(
        `
          SELECT adicional_id, nombre_adicional, cantidad, dias, subtotal
          FROM reserva_adicional
          WHERE reserva_id = ?
          ORDER BY id ASC
        `,
        [row.id]
      );

      const [recursosRows] = await mysqlConnection.promise().query(
        `
          SELECT bfr.recurso_id, r.nombre, bfr.estado
          FROM bloque_fecha_recurso bfr
          INNER JOIN recurso r ON r.id = bfr.recurso_id
          WHERE bfr.bloque_fecha_id = ?
          ORDER BY r.nombre ASC
        `,
        [row.bloque_fecha_id]
      );

      inscripciones.push({
        ...row,
        fecha_inicio: formatearFechaSQL(row.fecha_inicio),
        fecha_fin: formatearFechaSQL(row.fecha_fin),
        precio_total: Number(row.precio_total || 0),
        monto_adicionales: Number(row.monto_adicionales || 0),
        personas: personasRows.map((persona) => ({
          ...persona,
          fecha_nacimiento: formatearFechaSQL(persona.fecha_nacimiento),
          tarifa_individual: Number(persona.tarifa_individual || 0)
        })),
        adicionales: adicionalesRows.map((adicional) => ({
          ...adicional,
          cantidad: Number(adicional.cantidad || 0),
          dias: Number(adicional.dias || 0),
          subtotal: Number(adicional.subtotal || 0)
        })),
        recursos_elegibles: recursosRows.map((recurso) => ({
          recurso_id: Number(recurso.recurso_id),
          nombre: recurso.nombre,
          estado: recurso.estado,
          disponible: ESTADOS_RECURSO_SORTEO_DISPONIBLES.has(recurso.estado)
        }))
      });
    }

    res.status(200).json(inscripciones);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener inscripciones");
  }
});

router.get("/admin/sorteos/:id/adjudicaciones/historial", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    if (!sorteoId) {
      return res.status(400).json("ID invalido");
    }

    const [rows] = await mysqlConnection.promise().query(
      `
        SELECT
          sar.id,
          sar.reserva_id,
          sar.estado,
          sar.fecha_adjudicacion,
          sar.fecha_respuesta,
          sar.observaciones,
          u.documento AS afiliado,
          CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, '')) AS afiliado_nombre,
          s.nombre AS sorteo_nombre,
          bf.nombre AS bloque_nombre,
          srv.nombre AS servicio_nombre,
          srv.lugar,
          rec.nombre AS recurso_nombre,
          n.leida AS notificacion_leida
        FROM sorteo_adjudicacion_respuesta sar
        INNER JOIN usuario u ON u.id = sar.usuario_id
        LEFT JOIN sorteo s ON s.id = sar.sorteo_id
        LEFT JOIN bloque_fecha bf ON bf.id = sar.bloque_fecha_id
        LEFT JOIN servicio srv ON srv.id = bf.servicio_id
        LEFT JOIN recurso rec ON rec.id = sar.recurso_id
        LEFT JOIN notificacion n ON n.id = sar.notificacion_id
        WHERE sar.sorteo_id = ?
        ORDER BY sar.fecha_adjudicacion DESC, sar.id DESC
      `,
      [sorteoId]
    );

    res.status(200).json(rows.map(row => ({
      ...row,
      id: Number(row.id),
      reserva_id: Number(row.reserva_id),
      fecha_adjudicacion: row.fecha_adjudicacion,
      fecha_respuesta: row.fecha_respuesta,
      notificacion_leida: row.notificacion_leida === 1 || row.notificacion_leida === true
    })));
  } catch (error) {
    registrarErrorRuta(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json([]);
    }
    res.status(500).json("Error al obtener historial de adjudicaciones");
  }
});

router.post("/sorteos/:id/cotizacion", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    const bloqueFechaId = normalizarIdPositivo(req.body.bloque_fecha_id);
    const regimenId = normalizarIdPositivo(req.body.regimen_id);
    if (!sorteoId || !bloqueFechaId || !regimenId) {
      return res.status(400).json("Faltan campos requeridos");
    }

    const db = mysqlConnection.promise();
    await ejecutarMantenimientoBloquesAlta(db);
    const bloque = await obtenerBloqueConRecursos(db, bloqueFechaId);
    if (Number(bloque.sorteo_id) !== sorteoId) {
      return res.status(404).json("Bloque no encontrado para el sorteo");
    }
    validarBloqueInscripcionAbierta(bloque);

    const personasAutorizadas = await resolverPersonasCotizacionAutorizadas(db, cabecera, {
      personas: req.body.personas,
      usuarioObjetivoId: req.body.usuario_id,
      fechaIngreso: bloque.fecha_inicio,
    });

    const cotizacion = await cotizarBloqueComun(db, {
      bloque,
      regimenId,
      personas: personasAutorizadas,
      adicionales: req.body.adicionales || []
    });

    res.status(200).json(cotizacion);
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al cotizar sorteo");
  }
});

router.post("/sorteos/:id/inscripciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    const bloqueFechaId = normalizarIdPositivo(req.body.bloque_fecha_id);
    const regimenId = normalizarIdPositivo(req.body.regimen_id);
    const personas = Array.isArray(req.body.personas) ? req.body.personas : [];
    if (!sorteoId || !bloqueFechaId || !regimenId || personas.length === 0) {
      return res.status(400).json("Faltan campos requeridos");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const usuarioReservaId = cabecera.rol === "afiliado"
      ? normalizarIdPositivo(cabecera.id)
      : normalizarIdPositivo(req.body.usuario_id);
    if (!usuarioReservaId) {
      throw crearErrorNegocio("Debes indicar un afiliado titular para la inscripción", 400);
    }
    const [titulares] = await connection.query(
      `SELECT u.id, u.habilitado, r.nombre AS rol
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
       WHERE u.id = ?
       FOR UPDATE`,
      [usuarioReservaId]
    );
    if (titulares.length === 0 || titulares[0].rol !== "afiliado" || titulares[0].habilitado !== "Y") {
      throw crearErrorNegocio("El titular debe ser un afiliado habilitado", 422);
    }
    if (cabecera.rol === "departamental" && !(await puedeAccederUsuarioRelacionado(connection, cabecera, usuarioReservaId))) {
      throw crearErrorNegocio("No puedes inscribir afiliados de otra departamental", 403);
    }
    await ejecutarMantenimientoBloquesAlta(connection);

    const bloque = await obtenerBloqueConRecursos(connection, bloqueFechaId, { forUpdate: true });
    if (Number(bloque.sorteo_id) !== sorteoId) {
      await connection.rollback();
      return res.status(404).json("Bloque no encontrado para el sorteo");
    }
    validarBloqueInscripcionAbierta(bloque);

    const inscripcionExistente = await obtenerInscripcionSorteoActiva(connection, usuarioReservaId, { forUpdate: true });

    if (inscripcionExistente) {
      await connection.rollback();
      return res.status(409).json({
        message: "Ya tenes una inscripcion activa a un sorteo. Solo podes tener una a la vez.",
        codigo: "INSCRIPCION_SORTEO_ACTIVA",
        inscripcion: inscripcionExistente
      });
    }

    const { usuarioFamiliarPrincipalId, departamentalId } = await obtenerUsuarioPrincipalFamilia(connection, usuarioReservaId);
    const personasAutorizadas = await crearOBuscarUsuariosReserva(connection, personas, {
      usuarioFamiliarPrincipalId,
      departamentalId,
      usuarioModificadorId: cabecera.id,
      req,
      fechaIngreso: bloque.fecha_inicio,
    });
    const cotizacion = await cotizarBloqueComun(connection, {
      bloque,
      regimenId,
      personas: personasAutorizadas,
      adicionales: req.body.adicionales || []
    });

    let firmaArchivo = null;
    if (req.body.firma) {
      const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
      await uploadBase64ToS3({
        key: firmaFileName,
        value: req.body.firma,
        defaultContentType: "image/png",
      });
      firmaArchivo = firmaFileName;
    }

    const estadoSolicitudId = await obtenerEstadoReservaId(connection, "Solicitud sorteo", ESTADO_RESERVA_INICIADA_ID);

    const [reservaResult] = await connection.query(
      `INSERT INTO reserva (
        estado_reserva_id, modalidad, sorteo_id, bloque_fecha_id, servicio_id,
        regimen_id, recurso_id, usuario_id, firma_archivo, precio_total,
        fecha_inicio, fecha_fin, observaciones, monto_adicionales
      ) VALUES (?, 'SORTEO', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        estadoSolicitudId,
        sorteoId,
        bloqueFechaId,
        cotizacion.servicio_id,
        regimenId,
        usuarioReservaId,
        firmaArchivo,
        cotizacion.precio_total,
        cotizacion.fecha_inicio,
        cotizacion.fecha_fin,
        req.body.observaciones || null,
        cotizacion.monto_adicionales
      ]
    );

    const reservaId = reservaResult.insertId;
    if (cotizacion.adicionales.length > 0) {
      await guardarAdicionalesReserva(connection, reservaId, cotizacion.adicionales);
    }

    const usuariosIds = cotizacion.personas;
    const reservasFamiliaresIds = [];
    for (let index = 0; index < usuariosIds.length; index++) {
      const persona = usuariosIds[index];
      const [reservaFamiliarResult] = await connection.query(
        `INSERT INTO reserva_familiar
          (reserva_id, usuario_id, tipo_persona_id, parentesco_id, edad, precio)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          reservaId,
          persona.usuario_id,
          persona.tipo_persona_id,
          persona.parentesco_id,
          persona.edad,
          persona.tarifa_individual
        ]
      );

      reservasFamiliaresIds.push({
        reserva_familiar_id: reservaFamiliarResult.insertId,
        ...persona,
      });
    }

    await insertarTarifasFamiliaresCalculadas(connection, reservasFamiliaresIds);

    await registrarHistorialReserva(
      connection,
      reservaId,
      "CREATE",
      cabecera.id,
      req,
      null,
      `Inscripcion al sorteo ${sorteoId}, bloque ${bloqueFechaId}`
    );

    await connection.commit();
    res.status(201).json({
      id: reservaId,
      numero_reserva: `${reservaId}`,
      estado: "Solicitud sorteo",
      mensaje: "Inscripcion al sorteo creada correctamente",
      fecha_creacion: new Date().toISOString(),
      precio_total: cotizacion.precio_total,
      total_tarifa: cotizacion.total_tarifa,
      monto_adicionales: cotizacion.monto_adicionales
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al crear inscripcion al sorteo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/sorteos/inscripciones/:id/adjudicar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.body.recurso_id);
    if (!reservaId || !recursoId) {
      return res.status(400).json("Faltan campos requeridos");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [reservas] = await connection.query(
      `SELECT r.*, er.nombre AS estado_nombre
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
       WHERE r.id = ? AND r.modalidad = 'SORTEO'
       FOR UPDATE`,
      [reservaId]
    );
    if (reservas.length === 0) {
      await connection.rollback();
      return res.status(404).json("Inscripcion no encontrada");
    }

    const reserva = reservas[0];
    if (reserva.recurso_id || esEstadoReservaTerminal(reserva.estado_nombre)) {
      throw crearErrorNegocio("La inscripción ya no puede ser adjudicada", 409);
    }
    const bloque = await obtenerBloqueConRecursos(connection, reserva.bloque_fecha_id, { forUpdate: true });
    const errorVigencia = validarAdjudicacionSorteo({
      estadoBloque: bloque.estado,
      estadoSorteo: bloque.sorteo_estado,
      fechaFinInscripcion: bloque.fecha_fin_inscripcion,
      fechaInicioBloque: bloque.fecha_inicio,
      hoy: obtenerFechaCivilHoyArgentina(),
    });
    if (errorVigencia) {
      throw crearErrorNegocio(errorVigencia.mensaje, 409, errorVigencia.codigo);
    }
    const recursoBloque = bloque.recursos.find((recurso) => Number(recurso.recurso_id) === recursoId);
    if (!recursoBloque || !ESTADOS_RECURSO_SORTEO_DISPONIBLES.has(recursoBloque.estado)) {
      await connection.rollback();
      return res.status(409).json("El recurso no esta disponible para adjudicar");
    }

    const [adjudicacionExistente] = await connection.query(
      "SELECT id, estado FROM sorteo_adjudicacion_respuesta WHERE reserva_id = ? LIMIT 1 FOR UPDATE",
      [reservaId]
    );
    if (adjudicacionExistente.length > 0) {
      await connection.rollback();
      return res.status(409).json("La inscripcion ya tiene una adjudicacion registrada");
    }

    const [conflictos] = await connection.query(
      `
        SELECT id
        FROM reserva
        WHERE id <> ?
          AND recurso_id = ?
          AND fecha_inicio < ?
          AND fecha_fin > ?
          AND COALESCE(estado_reserva_id, ?) <> ?
        LIMIT 1
        FOR UPDATE
      `,
      [reservaId, recursoId, reserva.fecha_fin, reserva.fecha_inicio, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );
    if (conflictos.length > 0) {
      await connection.rollback();
      return res.status(409).json("El recurso ya esta ocupado en ese bloque");
    }

    const estadoAdjudicadaId = await obtenerEstadoReservaId(connection, "Adjudicada", ESTADO_RESERVA_INICIADA_ID);
    await connection.query(
      `UPDATE reserva
       SET recurso_id = ?, servicio_id = ?, estado_reserva_id = ?, observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
      [recursoId, bloque.servicio_id, estadoAdjudicadaId, req.body.observaciones || null, reservaId]
    );
    const [asignacionRecurso] = await connection.query(
      `UPDATE bloque_fecha_recurso
       SET estado = 'ASIGNADO', reserva_id = ?
       WHERE bloque_fecha_id = ? AND recurso_id = ? AND estado IN ('DISPONIBLE', 'SORTEO') AND reserva_id IS NULL`,
      [reservaId, bloque.id, recursoId]
    );
    if (asignacionRecurso.affectedRows !== 1) {
      throw crearErrorNegocio("El recurso acaba de ser adjudicado por otra operación", 409);
    }

    const detallePremioBase = await obtenerDetallePremioParaReserva(connection, reservaId, recursoId);
    const [notificacionResult] = await connection.query(
      `
        INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload)
        VALUES (?, 'SORTEO_ADJUDICADO', ?, ?, JSON_OBJECT())
      `,
      [
        reserva.usuario_id,
        "Felicitaciones, fuiste adjudicado",
        `Ganaste ${detallePremioBase.bloque_nombre || "un bloque"} del sorteo ${detallePremioBase.sorteo_nombre || ""}`.trim()
      ]
    );

    const [adjudicacionResult] = await connection.query(
      `
        INSERT INTO sorteo_adjudicacion_respuesta
          (reserva_id, sorteo_id, bloque_fecha_id, recurso_id, usuario_id, notificacion_id, estado)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
      `,
      [
        reservaId,
        reserva.sorteo_id,
        reserva.bloque_fecha_id,
        recursoId,
        reserva.usuario_id,
        notificacionResult.insertId
      ]
    );

    const detallePremio = await obtenerPremioSorteoPorAdjudicacion(connection, {
      adjudicacionId: adjudicacionResult.insertId
    });
    await connection.query(
      "UPDATE notificacion SET payload = ? WHERE id = ?",
      [JSON.stringify(detallePremio), notificacionResult.insertId]
    );

    await registrarHistorialReserva(
      connection,
      reservaId,
      "UPDATE",
      cabecera.id,
      req,
      [
        { campo: "recurso_id", valorAnterior: null, valorNuevo: recursoId },
        { campo: "sorteo_adjudicacion_respuesta.estado", valorAnterior: null, valorNuevo: "PENDIENTE" }
      ],
      "Adjudicacion manual de sorteo"
    );

    await connection.commit();
    res.status(200).json({ message: "Inscripcion adjudicada correctamente" });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    res.status(500).json("Error al adjudicar inscripcion");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/sorteos/inscripciones/:id/no-adjudicada", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    if (!reservaId) {
      return res.status(400).json("ID invalido");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [reservas] = await connection.query(
      "SELECT id, estado_reserva_id, recurso_id FROM reserva WHERE id = ? AND modalidad = 'SORTEO' FOR UPDATE",
      [reservaId]
    );
    if (reservas.length === 0) throw crearErrorNegocio("Inscripción no encontrada", 404);
    if (reservas[0].recurso_id) throw crearErrorNegocio("Una inscripción adjudicada no puede marcarse como no adjudicada", 409);
    const [adjudicaciones] = await connection.query(
      "SELECT id FROM sorteo_adjudicacion_respuesta WHERE reserva_id = ? LIMIT 1 FOR UPDATE",
      [reservaId]
    );
    if (adjudicaciones.length > 0) throw crearErrorNegocio("La inscripción ya tiene una adjudicación", 409);

    const estadoNoAdjudicadaId = await obtenerEstadoReservaId(connection, "No adjudicada", ESTADO_RESERVA_RECHAZADA_ID);
    await connection.query(
      `UPDATE reserva SET estado_reserva_id = ?, observaciones = COALESCE(?, observaciones) WHERE id = ?`,
      [estadoNoAdjudicadaId, req.body.observaciones || null, reservaId]
    );
    await registrarHistorialReserva(
      connection,
      reservaId,
      "UPDATE",
      cabecera.id,
      req,
      [{ campo: "estado_reserva_id", valorAnterior: reservas[0].estado_reserva_id, valorNuevo: estadoNoAdjudicadaId }],
      "Inscripción marcada como no adjudicada"
    );
    await connection.commit();
    res.status(200).json({ message: "Inscripcion marcada como no adjudicada" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    res.status(500).json("Error al marcar inscripcion");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/admin/sorteos/:id/cerrar", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    if (!sorteoId) {
      return res.status(400).json("ID invalido");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [sorteos] = await connection.query("SELECT id, estado FROM sorteo WHERE id = ? FOR UPDATE", [sorteoId]);
    if (sorteos.length === 0) throw crearErrorNegocio("Sorteo no encontrado", 404);
    if (sorteos[0].estado === "CANCELADO") throw crearErrorNegocio("Un sorteo cancelado no puede cerrarse", 409);

    const [inscripcionesNoAdjudicadas] = await connection.query(
      `SELECT id, estado_reserva_id
       FROM reserva
       WHERE sorteo_id = ? AND modalidad = 'SORTEO' AND recurso_id IS NULL
         AND COALESCE(estado_reserva_id, ?) <> ?
       FOR UPDATE`,
      [sorteoId, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );
    const estadoNoAdjudicadaId = await obtenerEstadoReservaId(connection, "No adjudicada", ESTADO_RESERVA_RECHAZADA_ID);
    for (const inscripcion of inscripcionesNoAdjudicadas) {
      await registrarHistorialReserva(
        connection,
        inscripcion.id,
        "UPDATE",
        cabecera.id,
        req,
        [{ campo: "estado_reserva_id", valorAnterior: inscripcion.estado_reserva_id, valorNuevo: estadoNoAdjudicadaId }],
        `Cierre del sorteo ${sorteoId}`
      );
    }
    await connection.query(
      "UPDATE reserva SET estado_reserva_id = ? WHERE sorteo_id = ? AND modalidad = 'SORTEO' AND recurso_id IS NULL AND COALESCE(estado_reserva_id, ?) <> ?",
      [estadoNoAdjudicadaId, sorteoId, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );

    await connection.query(
      `UPDATE bloque_fecha_recurso bfr
       INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
       SET bfr.estado = 'VENTA_DIRECTA'
       WHERE bf.sorteo_id = ?
         AND bf.modalidad = 'SORTEO'
         AND bf.estado = 'ACTIVO'
         AND bfr.estado IN ('DISPONIBLE', 'SORTEO')`,
      [sorteoId]
    );
    await connection.query("UPDATE sorteo SET estado = 'CERRADO' WHERE id = ?", [sorteoId]);

    await connection.commit();
    res.status(200).json({ message: "Sorteo cerrado. Excedentes publicados como venta por bloque." });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    res.status(500).json("Error al cerrar sorteo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.post("/reserva/recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      const {
        fecha_inicio,
        fecha_fin,
        servicio_id,
        regimen_id,
        usuario_id,
        personas,
        recurso_id,
        filtros,
        precio_minimo,
        precio_maximo,
        orden_id,
        modalidad,
        bloque_fecha_id,
        hold_token,
        solo_fecha_libre,
        soloFechaLibre
      } = req.body;

      const fechaInicioSolicitud = formatearFechaSQL(fecha_inicio);
      const fechaFinSolicitud = formatearFechaSQL(fecha_fin);
      const servicioIdSolicitud = normalizarIdPositivo(servicio_id);
      const regimenIdSolicitud = normalizarIdPositivo(regimen_id);
      const recursoIdFiltro = recurso_id === undefined || recurso_id === null
        ? null
        : normalizarIdPositivo(recurso_id);
      if (
        !fechaInicioSolicitud || !fechaFinSolicitud ||
        obtenerNochesReserva(fechaInicioSolicitud, fechaFinSolicitud, 366).length === 0 ||
        !servicioIdSolicitud || !regimenIdSolicitud ||
        !Array.isArray(personas) || personas.length === 0 ||
        ((recurso_id !== undefined && recurso_id !== null) && !recursoIdFiltro)
      ) {
        return res.status(400).json("Faltan campos requeridos");
      }

      if (!validarRangoReservaTemporal(fechaInicioSolicitud, fechaFinSolicitud).valido) {
        return res.status(422).json("La fecha de inicio no puede ser anterior a hoy");
      }

      const db = mysqlConnection.promise();
      const holdIdExcluir = await resolverHoldIdExcluir(db, cabecera, hold_token);
      const personasAutorizadas = await resolverPersonasCotizacionAutorizadas(db, cabecera, {
        personas,
        usuarioObjetivoId: usuario_id,
        fechaIngreso: fechaInicioSolicitud,
      });
      const precioMinimoCentavos = precio_minimo === undefined || precio_minimo === null
        ? null
        : decimalACentavos(precio_minimo);
      const precioMaximoCentavos = precio_maximo === undefined || precio_maximo === null
        ? null
        : decimalACentavos(precio_maximo);
      if (
        (precio_minimo !== undefined && precio_minimo !== null && precioMinimoCentavos === null) ||
        (precio_maximo !== undefined && precio_maximo !== null && precioMaximoCentavos === null) ||
        (precioMinimoCentavos !== null && precioMaximoCentavos !== null && precioMinimoCentavos > precioMaximoCentavos)
      ) {
        return res.status(400).json("El rango de precios no es valido");
      }
      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      const soloFechaLibreSolicitada = normalizarBoolean(solo_fecha_libre ?? soloFechaLibre);
      let temporadaTarifaIdFiltro = null;
      let recursosPermitidosBloqueSet = null;

      if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
        const bloqueSeleccionado = await obtenerBloqueConRecursos(db, bloqueFechaIdSolicitado);
        const modalidadBloqueVisible = bloqueSeleccionado.modalidad === MODALIDAD_SORTEO
          ? MODALIDAD_BLOQUE
          : bloqueSeleccionado.modalidad;

        if (
          bloqueSeleccionado.estado !== "ACTIVO" ||
          Number(bloqueSeleccionado.servicio_id) !== Number(servicio_id) ||
          modalidadBloqueVisible !== MODALIDAD_BLOQUE ||
          !rangoCoincideConBloque(fecha_inicio, fecha_fin, bloqueSeleccionado)
        ) {
          return res.status(409).json("El bloque seleccionado no esta disponible para ese servicio y fechas");
        }

        const recursosDisponiblesBloque = (bloqueSeleccionado.recursos || []).filter((recurso) =>
          ESTADOS_RECURSO_BLOQUE_RESERVABLES.has(recurso.estado)
        );

        if (recursosDisponiblesBloque.length === 0) {
          return res.status(409).json("No hay recursos disponibles para este bloque");
        }

        recursosPermitidosBloqueSet = new Set(recursosDisponiblesBloque.map((recurso) => Number(recurso.recurso_id)));
        temporadaTarifaIdFiltro = bloqueSeleccionado.temporada_tarifa_id || null;
      }

      // Primero obtenemos solo los recursos que tienen tarifas válidas para el servicio y las personas
      const recursosConTarifas = [];

      // Para cada persona, buscamos qué recursos tienen tarifas válidas
      const recursosValidos = new Set();

      for (const persona of personasAutorizadas) {
        const filtroTemporada = temporadaTarifaIdFiltro ? "AND tarifa.temporada_tarifa_id = ?" : "";
        const [tarifasPersona] = await mysqlConnection
          .promise()
          .query(`
            SELECT DISTINCT recurso_id
            FROM tarifa 
            INNER JOIN recurso r ON tarifa.recurso_id = r.id
            WHERE r.servicio_id = ?
              AND tarifa.tipo_persona_id = ? 
              AND tarifa.regimen_id = ?
              AND (tarifa.edad_minima IS NULL OR tarifa.edad_minima <= ?)
              AND (tarifa.edad_maxima IS NULL OR tarifa.edad_maxima >= ?)
              AND tarifa.fecha_inicio <= ?
              AND tarifa.fecha_fin >= ?
              ${filtroTemporada}
          `, [
            servicioIdSolicitud,
            persona.tipo_persona_id,
            persona.regimen_id,
            persona.edad,
            persona.edad,
            fechaFinSolicitud,
            fechaInicioSolicitud,
            ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])
          ]);

        tarifasPersona.forEach(tarifa => {
          recursosValidos.add(tarifa.recurso_id);
        });
      }

      if (recursosValidos.size === 0) {
        return res.status(404).json("No se encontraron recursos con tarifas válidas para las personas especificadas");
      }

      // Si se especifica recurso_id, filtramos solo ese recurso (si está en los válidos)
      if (recursosPermitidosBloqueSet) {
        for (const recursoValido of Array.from(recursosValidos)) {
          if (!recursosPermitidosBloqueSet.has(Number(recursoValido))) {
            recursosValidos.delete(recursoValido);
          }
        }

        if (recursosValidos.size === 0) {
          return res.status(404).json("No se encontraron recursos disponibles dentro del bloque seleccionado");
        }
      }

      if (recursoIdFiltro) {
        if (recursosValidos.has(recursoIdFiltro)) {
          // Mantener solo el recurso especificado
          recursosValidos.clear();
          recursosValidos.add(recursoIdFiltro);
        } else {
          return res.status(404).json("El recurso especificado no tiene tarifas válidas para las personas especificadas");
        }
      }

      // Aplicar filtros si se proporcionan
      if (filtros && typeof filtros === 'object' && Object.keys(filtros).length > 0) {
        const recursosQueCumplenFiltros = new Set();

        for (const recursoId of recursosValidos) {
          let cumpleTodosFiltros = true;

          for (const [filtroId, valorFiltro] of Object.entries(filtros)) {
            // Saltar filtros que son null, undefined o string vacío
            if (valorFiltro === null || valorFiltro === undefined || valorFiltro === '') {
              continue;
            }

            const filtroIdNormalizado = normalizarIdPositivo(filtroId);
            const valorNumericoValido = typeof valorFiltro === 'number'
              && Number.isSafeInteger(valorFiltro)
              && valorFiltro >= 0;
            if (!filtroIdNormalizado || (typeof valorFiltro !== 'boolean' && !valorNumericoValido)) {
              return res.status(400).json("Los filtros de recursos contienen valores invalidos");
            }

            // Obtener información del filtro para este recurso
            const [filtroRecurso] = await mysqlConnection
              .promise()
              .query(`
                      SELECT cantidad, habilitado
                      FROM filtro_recurso
                      WHERE recurso_id = ? AND filtro_id = ?
                    `, [recursoId, filtroIdNormalizado]);

            if (filtroRecurso.length === 0) {
              // Si el recurso no tiene este filtro, no cumple con los criterios
              cumpleTodosFiltros = false;
              break;
            }

            const filtroData = filtroRecurso[0];

            // Verificar según el tipo de valor del filtro
            if (typeof valorFiltro === 'boolean') {
              // Filtro booleano: verificar campo habilitado
              const habilitadoBoolean = filtroData.habilitado === 'Y';
              if (habilitadoBoolean !== valorFiltro) {
                cumpleTodosFiltros = false;
                break;
              }
            } else if (typeof valorFiltro === 'number') {
              // Filtro numérico: verificar campo cantidad
              if (filtroData.cantidad !== valorFiltro) {
                cumpleTodosFiltros = false;
                break;
              }
            }
          }

          if (cumpleTodosFiltros) {
            recursosQueCumplenFiltros.add(recursoId);
          }
        }

        // Solo actualizar recursosValidos si se encontraron recursos que cumplen filtros
        if (recursosQueCumplenFiltros.size > 0) {
          recursosValidos.clear();
          recursosQueCumplenFiltros.forEach(id => recursosValidos.add(id));
        } else {
          // Si no hay recursos que cumplan filtros, retornar error específico
          return res.status(404).json("No se encontraron recursos que cumplan con los filtros especificados");
        }
      }

      // Ahora obtenemos solo los recursos que pasaron todas las validaciones
      const recursosIds = Array.from(recursosValidos);
      const placeholders = recursosIds.map(() => '?').join(',');

      const [recursos] = await mysqlConnection
        .promise()
        .query(`SELECT id, servicio_id, grupo_recurso_id, nombre FROM recurso WHERE id IN (${placeholders})`, recursosIds);

      const bloquesPorRecurso = await obtenerBloquesActivosParaRecursos(mysqlConnection.promise(), {
        recursoIds: recursos.map((recurso) => Number(recurso.id)),
        fechaInicio: fecha_inicio,
        fechaFin: fecha_fin
      });

      const [reservasSolapadasRecursos] = await mysqlConnection.promise().query(
        `
          SELECT DISTINCT recurso_id
          FROM reserva
          WHERE recurso_id IN (${placeholders})
            AND fecha_inicio < ?
            AND fecha_fin > ?
            AND COALESCE(estado_reserva_id, ?) <> ?
        `,
        [...recursosIds, fecha_fin, fecha_inicio, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
      );
      const recursosOcupadosSet = new Set(reservasSolapadasRecursos.map((reserva) => Number(reserva.recurso_id)));
      const recursosRetenidosSet = await obtenerRecursosRetenidos(db, {
        recursoIds: recursos.map((recurso) => Number(recurso.id)),
        fechaInicio: fechaInicioSolicitud,
        fechaFin: fechaFinSolicitud,
        holdIdExcluir,
      });
      let campingSinDisponibilidad = false;
      if (esServicioCamping(servicioIdSolicitud)) {
        const snapshotCamping = await obtenerSnapshotDisponibilidad(db, {
          servicioIds: [servicioIdSolicitud],
          fechaInicio: fechaInicioSolicitud,
          fechaFin: fechaFinSolicitud,
          adultos: 0,
          ninos: 0,
          bebes: 0,
          totalPersonas: personasAutorizadas.length,
          holdIdExcluir,
        });
        campingSinDisponibilidad = Number(snapshotCamping[0]?.disponibles || 0) <= 0;
      }

      // Obtener imágenes solo para los recursos válidos
      const [imagenes] = await mysqlConnection
        .promise()
        .query(`
          SELECT ir.id, ir.recurso_id, ir.archivo 
          FROM imagen_recurso ir
          WHERE ir.recurso_id IN (${placeholders})
        `, recursosIds);

      // Obtener filtros solo para los recursos válidos
      const [filtrosData] = await mysqlConnection
        .promise()
        .query(`
          SELECT fr.recurso_id, f.id as filtro_id, f.nombre, f.icono, fr.cantidad, fr.habilitado
          FROM filtro_recurso fr
          INNER JOIN filtro f ON fr.filtro_id = f.id
          WHERE fr.recurso_id IN (${placeholders})
        `, recursosIds);

      // Mapear imagenes por recurso_id
      const imagenesConUrlPorRecurso = await Promise.all(
        imagenes.map(async (img) => {
          try {
            return {
              ...img,
              archivo_url: await getSignedFileUrlFromS3(img.archivo),
            };
          } catch (error) {
            console.error("Error generando URL firmada para imagen de recurso:", error);
            return {
              ...img,
              archivo_url: null,
            };
          }
        })
      );

      const imagenesPorRecurso = {};
      imagenesConUrlPorRecurso.forEach((img) => {
        if (!imagenesPorRecurso[img.recurso_id]) {
          imagenesPorRecurso[img.recurso_id] = [];
        }
        imagenesPorRecurso[img.recurso_id].push({
          id: img.id,
          archivo: img.archivo_url,
        });
      });

      // Mapear filtros por recurso_id
      const filtrosPorRecurso = {};
      filtrosData.forEach(filtro => {
        if (!filtrosPorRecurso[filtro.recurso_id]) {
          filtrosPorRecurso[filtro.recurso_id] = [];
        }
        filtrosPorRecurso[filtro.recurso_id].push({
          id: filtro.filtro_id,
          nombre: filtro.nombre,
          icono: filtro.icono,
          cantidad: filtro.cantidad,
          habilitado: filtro.habilitado
        });
      });

      // Calcular tarifas para cada recurso y aplicar filtro de precio
      for (const recurso of recursos) {
        if (
          (esServicioCamping(servicioIdSolicitud) && campingSinDisponibilidad) ||
          (!esServicioCamping(servicioIdSolicitud) && (
            recursosOcupadosSet.has(Number(recurso.id)) || recursosRetenidosSet.has(Number(recurso.id))
          ))
        ) {
          continue;
        }

        const bloquesActivosRecurso = bloquesPorRecurso.get(Number(recurso.id)) || [];
        let modalidadRecurso = MODALIDAD_FECHA_LIBRE;
        let bloqueRecurso = null;

        if (bloquesActivosRecurso.length > 0) {
          const bloqueActivo = bloquesActivosRecurso[0];
          const ventaDirectaDesdeSorteo = bloqueActivo.modalidad === MODALIDAD_SORTEO && bloqueActivo.estado_recurso_bloque === "VENTA_DIRECTA";
          modalidadRecurso = ventaDirectaDesdeSorteo ? MODALIDAD_BLOQUE : bloqueActivo.modalidad;
          bloqueRecurso = {
            id: Number(bloqueActivo.bloque_fecha_id),
            nombre: bloqueActivo.bloque_nombre,
            modalidad: modalidadRecurso,
            fecha_inicio: formatearFechaSQL(bloqueActivo.fecha_inicio),
            fecha_fin: formatearFechaSQL(bloqueActivo.fecha_fin),
            sorteo_id: bloqueActivo.sorteo_id ? Number(bloqueActivo.sorteo_id) : null,
            sorteo_nombre: bloqueActivo.sorteo_nombre || null
          };

          if (modalidadRecurso === MODALIDAD_BLOQUE && !rangoCoincideConBloque(fecha_inicio, fecha_fin, bloqueActivo)) {
            continue;
          }
        }

        if (modalidadRecurso === MODALIDAD_SORTEO) {
          continue;
        }

        if (soloFechaLibreSolicitada && modalidadRecurso !== MODALIDAD_FECHA_LIBRE) {
          continue;
        }

        let cotizacionRecurso;
        try {
          cotizacionRecurso = await calcularTarifaBaseReserva(db, {
            recursoId: recurso.id,
            regimenId: regimenIdSolicitud,
            personas: personasAutorizadas,
            fechaInicio: fechaInicioSolicitud,
            fechaFin: fechaFinSolicitud,
            temporadaTarifaId: temporadaTarifaIdFiltro,
          });
        } catch (error) {
          if (["TARIFA_INCOMPLETA", "TARIFA_AMBIGUA"].includes(error?.codigo)) {
            continue;
          }
          throw error;
        }

        let tarifaTotal = cotizacionRecurso.total;
        let tarifaOriginalTotal = cotizacionRecurso.total_original;
        let usaPorcentajeEnAlgunaTarifa = cotizacionRecurso.personas.some((persona) =>
          (persona.tarifas_por_fecha || []).some((tarifa) => tarifa.usa_porcentaje)
        );

        // Aplicar filtro de precio si se especifica
        let cumpleFiltroPrecios = true;

        const tarifaTotalCentavos = decimalACentavos(tarifaTotal);
        if (tarifaTotalCentavos === null) {
          throw crearErrorNegocio("La tarifa calculada no es valida", 409, "TARIFA_INVALIDA");
        }
        if (precioMinimoCentavos !== null && tarifaTotalCentavos < precioMinimoCentavos) {
          cumpleFiltroPrecios = false;
        }

        if (precioMaximoCentavos !== null && tarifaTotalCentavos > precioMaximoCentavos) {
          cumpleFiltroPrecios = false;
        }

        if (cumpleFiltroPrecios) {
          // Calcular datos adicionales para ordenamiento
          let totalCamas = 0;
          let ambientes = 0;

          // Buscar camas (filtro_id 3 y 4) y ambientes (filtro_id 2)
          const filtrosRecurso = filtrosPorRecurso[recurso.id] || [];
          filtrosRecurso.forEach(filtro => {
            if (filtro.id === 3 || filtro.id === 4) { // Cama individual (3) y matrimonial (4)
              totalCamas += filtro.cantidad || 0;
            } else if (filtro.id === 2) { // Ambientes
              ambientes = filtro.cantidad || 0;
            }
          });

          recursosConTarifas.push({
            id: recurso.id,
            servicio_id: recurso.servicio_id,
            grupo_recurso_id: recurso.grupo_recurso_id,
            nombre: recurso.nombre,
            tarifa: tarifaTotal,
            tarifa_original: usaPorcentajeEnAlgunaTarifa ? tarifaOriginalTotal : null,
            modalidad: modalidadRecurso,
            bloque_fecha: bloqueRecurso,
            bloque_fecha_id: bloqueRecurso?.id || null,
            sorteo_id: bloqueRecurso?.sorteo_id || null,
            imagenes: imagenesPorRecurso[recurso.id] || [],
            filtros: filtrosPorRecurso[recurso.id] || [],
            totalCamas: totalCamas,
            ambientes: ambientes
          });
        }
      }

      // Aplicar ordenamiento según orden_id
      if (orden_id) {
        switch (orden_id) {
          case 1: // Precio (más bajo primero)
            recursosConTarifas.sort((a, b) => a.tarifa - b.tarifa);
            break;
          case 2: // Precio (más alto primero)
            recursosConTarifas.sort((a, b) => b.tarifa - a.tarifa);
            break;
          case 3: // Más camas primero
            recursosConTarifas.sort((a, b) => b.totalCamas - a.totalCamas);
            break;
          case 4: // Menos camas primero
            recursosConTarifas.sort((a, b) => a.totalCamas - b.totalCamas);
            break;
          case 5: // Más ambientes primero
            recursosConTarifas.sort((a, b) => b.ambientes - a.ambientes);
            break;
          case 6: // Menos ambientes primero
            recursosConTarifas.sort((a, b) => a.ambientes - b.ambientes);
            break;
          default:
            // No aplicar ordenamiento adicional
            break;
        }
      }

      // Limpiar campos auxiliares antes de enviar la respuesta
      const recursosLimpios = recursosConTarifas.map(recurso => {
        const { totalCamas, ambientes, ...recursoLimpio } = recurso;
        return recursoLimpio;
      });
      
      res.status(200).json(recursosLimpios);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al obtener los recursos con tarifas");
  }
});

router.post("/filtros/para-recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      if (!tieneAreaTurismo(cabecera)) {
        return res.status(403).json("No autorizado");
      }

      const {
        fecha_inicio,
        fecha_fin,
        servicio_id,
        regimen_id,
        usuario_id,
        personas,
        recurso_id,
        filtros,
        modalidad,
        bloque_fecha_id,
      } = req.body;

      const fechaInicioSolicitud = formatearFechaSQL(fecha_inicio);
      const fechaFinSolicitud = formatearFechaSQL(fecha_fin);
      const servicioIdSolicitud = normalizarIdPositivo(servicio_id);
      const regimenIdSolicitud = normalizarIdPositivo(regimen_id);
      const recursoIdFiltro = recurso_id === undefined || recurso_id === null
        ? null
        : normalizarIdPositivo(recurso_id);
      if (
        !fechaInicioSolicitud || !fechaFinSolicitud ||
        obtenerNochesReserva(fechaInicioSolicitud, fechaFinSolicitud, 366).length === 0 ||
        !servicioIdSolicitud || !regimenIdSolicitud ||
        !Array.isArray(personas) || personas.length === 0 ||
        ((recurso_id !== undefined && recurso_id !== null) && !recursoIdFiltro)
      ) {
        return res.status(400).json("Faltan campos requeridos");
      }

      if (!validarRangoReservaTemporal(fechaInicioSolicitud, fechaFinSolicitud).valido) {
        return res.status(422).json("La fecha de inicio no puede ser anterior a hoy");
      }

      // Primero obtenemos solo los recursos que tienen tarifas válidas para el servicio y las personas
      const db = mysqlConnection.promise();
      const personasAutorizadas = await resolverPersonasCotizacionAutorizadas(db, cabecera, {
        personas,
        usuarioObjetivoId: usuario_id,
        fechaIngreso: fechaInicioSolicitud,
      });
      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      let temporadaTarifaIdFiltro = null;
      let recursosPermitidosBloqueSet = null;

      if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
        const bloqueSeleccionado = await obtenerBloqueConRecursos(db, bloqueFechaIdSolicitado);
        const modalidadBloqueVisible = bloqueSeleccionado.modalidad === MODALIDAD_SORTEO
          ? MODALIDAD_BLOQUE
          : bloqueSeleccionado.modalidad;

        if (
          bloqueSeleccionado.estado !== "ACTIVO" ||
          Number(bloqueSeleccionado.servicio_id) !== Number(servicio_id) ||
          modalidadBloqueVisible !== MODALIDAD_BLOQUE ||
          !rangoCoincideConBloque(fecha_inicio, fecha_fin, bloqueSeleccionado)
        ) {
          return res.status(409).json("El bloque seleccionado no esta disponible para ese servicio y fechas");
        }

        const recursosDisponiblesBloque = (bloqueSeleccionado.recursos || []).filter((recurso) =>
          ESTADOS_RECURSO_BLOQUE_RESERVABLES.has(recurso.estado)
        );

        if (recursosDisponiblesBloque.length === 0) {
          return res.status(200).json([]);
        }

        recursosPermitidosBloqueSet = new Set(recursosDisponiblesBloque.map((recurso) => Number(recurso.recurso_id)));
        temporadaTarifaIdFiltro = bloqueSeleccionado.temporada_tarifa_id || null;
      }

      const recursosValidos = new Set();
      for (const persona of personasAutorizadas) {
        const filtroTemporada = temporadaTarifaIdFiltro ? "AND tarifa.temporada_tarifa_id = ?" : "";
        const [tarifasPersona] = await mysqlConnection
          .promise()
          .query(`
            SELECT DISTINCT recurso_id
            FROM tarifa 
            INNER JOIN recurso r ON tarifa.recurso_id = r.id
            WHERE r.servicio_id = ?
              AND tarifa.tipo_persona_id = ? 
              AND tarifa.regimen_id = ?
              AND (tarifa.edad_minima IS NULL OR tarifa.edad_minima <= ?)
              AND (tarifa.edad_maxima IS NULL OR tarifa.edad_maxima >= ?)
              AND tarifa.fecha_inicio <= ?
              AND tarifa.fecha_fin >= ?
              ${filtroTemporada}
          `, [
            servicioIdSolicitud,
            persona.tipo_persona_id,
            persona.regimen_id,
            persona.edad,
            persona.edad,
            fechaFinSolicitud,
            fechaInicioSolicitud,
            ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])
          ]);

        tarifasPersona.forEach(tarifa => {
          recursosValidos.add(tarifa.recurso_id);
        });
      }

      if (recursosPermitidosBloqueSet) {
        for (const recursoValido of Array.from(recursosValidos)) {
          if (!recursosPermitidosBloqueSet.has(Number(recursoValido))) {
            recursosValidos.delete(recursoValido);
          }
        }
      }

      if (recursosValidos.size === 0) {
        return res.status(200).json([]); // No hay recursos válidos, retornamos array vacío
      }

      // Si se especifica recurso_id, filtramos solo ese recurso (si está en los válidos)
      let recursosAConsiderar = Array.from(recursosValidos);
      if (recursoIdFiltro) {
        if (recursosValidos.has(recursoIdFiltro)) {
          recursosAConsiderar = [recursoIdFiltro];
        } else {
          return res.status(200).json([]); // El recurso especificado no es válido
        }
      }

      const placeholders = recursosAConsiderar.map(() => '?').join(',');

      // Obtener todos los filtros asociados a los recursos válidos con sus cantidades
      const [filtrosRecursos] = await mysqlConnection
        .promise()
        .query(`
          SELECT 
            f.id,
            f.nombre,
            f.icono,
            fr.cantidad,
            fr.habilitado
          FROM filtro_recurso fr
          INNER JOIN filtro f ON fr.filtro_id = f.id
          WHERE fr.recurso_id IN (${placeholders})
            AND fr.habilitado = 'Y'
        `, recursosAConsiderar);

      // Calcular el rango de precios de todos los recursos válidos
      const [recursos] = await mysqlConnection
        .promise()
        .query(`SELECT id, servicio_id, grupo_recurso_id, nombre FROM recurso WHERE id IN (${placeholders})`, recursosAConsiderar);

      let precioMinimo = null;
      let precioMaximo = null;
      const precios = [];

      // Calcular tarifas para cada recurso para obtener el rango de precios
      for (const recurso of recursos) {
        let cotizacionRecurso;
        try {
          cotizacionRecurso = await calcularTarifaBaseReserva(db, {
            recursoId: recurso.id,
            regimenId: regimenIdSolicitud,
            personas: personasAutorizadas,
            fechaInicio: fechaInicioSolicitud,
            fechaFin: fechaFinSolicitud,
            temporadaTarifaId: temporadaTarifaIdFiltro,
          });
        } catch (error) {
          if (["TARIFA_INCOMPLETA", "TARIFA_AMBIGUA"].includes(error?.codigo)) {
            continue;
          }
          throw error;
        }
        let tarifaTotal = cotizacionRecurso.total;
        precios.push(tarifaTotal);
      }

      // Calcular rango de precios
      if (precios.length > 0) {
        precioMinimo = Math.min(...precios);
        precioMaximo = Math.max(...precios);
      }

      // Agrupar por filtro y calcular min/max
      const filtrosAgrupados = {};

      filtrosRecursos.forEach(filtroRecurso => {
        const filtroId = filtroRecurso.id;

        if (!filtrosAgrupados[filtroId]) {
          filtrosAgrupados[filtroId] = {
            id: filtroId,
            nombre: filtroRecurso.nombre,
            icono: filtroRecurso.icono,
            cantidades: []
          };
        }

        filtrosAgrupados[filtroId].cantidades.push(filtroRecurso.cantidad);
      });

      // Calcular valorMinimo y valorMaximo para cada filtro
      const filtrosConValores = Object.values(filtrosAgrupados).map(filtro => {
        const cantidades = filtro.cantidades;
        const valorMinimo = Math.min(...cantidades);
        const valorMaximo = Math.max(...cantidades);

        return {
          id: filtro.id,
          nombre: filtro.nombre,
          icono: filtro.icono,
          valorMinimo: valorMinimo,
          valorMaximo: valorMaximo,
          habilitado: true
        };
      });

      // Agregar filtro de precio sintético al principio si hay precios válidos
      const filtrosFinales = [];
      if (precioMinimo !== null && precioMaximo !== null) {
        filtrosFinales.push({
          id: -1,
          nombre: 'Precio',
          icono: 'attach_money',
          valorMinimo: precioMinimo,
          valorMaximo: precioMaximo,
          habilitado: true,
          esPrecio: true,
          precioMinimo: precioMinimo,
          precioMaximo: precioMaximo
        });
      }

      // Agregar el resto de filtros ordenados por nombre
      filtrosConValores.sort((a, b) => a.nombre.localeCompare(b.nombre));
      filtrosFinales.push(...filtrosConValores);
      res.status(200).json(filtrosFinales);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al obtener los filtros para recursos");
  }
});

function construirFechasCotizacion(tarifaBase, adicionalesProcesados) {
  const porFecha = new Map();

  for (const persona of tarifaBase.personas || []) {
    for (const tarifa of persona.tarifas_por_fecha || []) {
      const actual = porFecha.get(tarifa.fecha) || {
        fecha: tarifa.fecha,
        precioCentavos: 0,
        precioOriginalCentavos: 0,
        porcentajeDescuento: 0,
        usaPorcentaje: false,
        adicionales: [],
      };
      actual.precioCentavos = sumarCentavos(actual.precioCentavos, decimalACentavos(tarifa.precio));
      actual.precioOriginalCentavos = sumarCentavos(
        actual.precioOriginalCentavos,
        decimalACentavos(tarifa.precio_original ?? tarifa.precio)
      );
      if (actual.precioCentavos === null || actual.precioOriginalCentavos === null) {
        throw crearErrorNegocio("El total diario excede el maximo permitido", 409, "TARIFA_INVALIDA");
      }
      actual.usaPorcentaje = actual.usaPorcentaje || Boolean(tarifa.usa_porcentaje);
      actual.porcentajeDescuento = Math.max(actual.porcentajeDescuento, Number(tarifa.porcentaje_descuento || 0));
      porFecha.set(tarifa.fecha, actual);
    }
  }

  for (const adicional of adicionalesProcesados.items || []) {
    for (const detalle of adicional.detalles || []) {
      const actual = porFecha.get(detalle.fecha);
      if (!actual) continue;
      actual.precioCentavos = sumarCentavos(actual.precioCentavos, decimalACentavos(detalle.subtotal));
      actual.precioOriginalCentavos = sumarCentavos(
        actual.precioOriginalCentavos,
        decimalACentavos(detalle.subtotal_original ?? detalle.subtotal)
      );
      if (actual.precioCentavos === null || actual.precioOriginalCentavos === null) {
        throw crearErrorNegocio("El total diario excede el maximo permitido", 409, "TARIFA_INVALIDA");
      }
      actual.usaPorcentaje = actual.usaPorcentaje || Number(detalle.porcentaje_descuento || 0) > 0;
      actual.porcentajeDescuento = Math.max(actual.porcentajeDescuento, Number(detalle.porcentaje_descuento || 0));
      actual.adicionales.push({
        adicional_id: adicional.adicional_id,
        nombre: adicional.nombre_adicional,
        cantidad: detalle.cantidad,
        precio_unitario: detalle.precio_unitario,
        subtotal: detalle.subtotal,
      });
    }
  }

  return Array.from(porFecha.values())
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((item) => ({
      fecha: item.fecha,
      precio: centavosANumero(item.precioCentavos),
      precio_base: centavosANumero(item.precioOriginalCentavos),
      usa_porcentaje: item.usaPorcentaje,
      porcentaje_descuento: item.usaPorcentaje ? item.porcentajeDescuento : 0,
      adicionales: item.adicionales,
    }));
}

router.post("/reserva/tarifa/fechas", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      if (!tieneAreaTurismo(cabecera)) {
        return res.status(403).json("No autorizado");
      }
      const {
        fecha_inicio,
        fecha_fin,
        servicio_id,
        recurso_id,
         personas,
         regimen_id,
         usuario_id,
         adicionales,
        modalidad,
        bloque_fecha_id
      } = req.body;

      if (!fecha_inicio || !fecha_fin || !servicio_id || !recurso_id || !personas || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const fechaInicioSolicitud = formatearFechaSQL(fecha_inicio);
      const fechaFinSolicitud = formatearFechaSQL(fecha_fin);

      // Calcular días correctamente: INCLUIR el día de salida (fecha_fin)
      const diasTotales = diferenciaDiasCivil(fechaInicioSolicitud, fechaFinSolicitud);

      if (!Number.isInteger(diasTotales) || diasTotales <= 0) {
        return res.status(400).json("El rango de fechas no es válido");
      }

      if (!validarRangoReservaTemporal(fechaInicioSolicitud, fechaFinSolicitud).valido) {
        return res.status(422).json("La fecha de inicio no puede ser anterior a hoy");
      }

      const pool = mysqlConnection.promise();
      const regimenIdSolicitud = normalizarIdPositivo(regimen_id);
      if (!regimenIdSolicitud) {
        return res.status(400).json("El regimen es requerido");
      }
      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      let temporadaTarifaIdFiltro = null;

      if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
        const bloqueSeleccionado = await obtenerBloqueConRecursos(pool, bloqueFechaIdSolicitado);
        const recursoBloque = (bloqueSeleccionado.recursos || []).find((recurso) => Number(recurso.recurso_id) === Number(recurso_id));
        if (
          bloqueSeleccionado.estado !== "ACTIVO" ||
          Number(bloqueSeleccionado.servicio_id) !== Number(servicio_id) ||
          !recursoBloque ||
          !ESTADOS_RECURSO_BLOQUE_RESERVABLES.has(recursoBloque.estado) ||
          !rangoCoincideConBloque(fecha_inicio, fecha_fin, bloqueSeleccionado)
        ) {
          return res.status(409).json("El bloque seleccionado no esta disponible para ese recurso y fechas");
        }
        temporadaTarifaIdFiltro = bloqueSeleccionado.temporada_tarifa_id || null;
      }

      const adicionalesSeleccionados = Array.isArray(adicionales) ? adicionales : [];

      if (adicionalesSeleccionados.length > 0 && !regimenIdSolicitud) {
        return res.status(400).json("Se requiere el régimen para calcular los adicionales");
      }

      // Verificar que el recurso pertenezca al servicio
      const [recursoValido] = await pool.query(
        `
          SELECT id FROM recurso 
          WHERE id = ? AND servicio_id = ?
        `,
        [recurso_id, servicio_id]
      );

      if (recursoValido.length === 0) {
        return res.status(404).json("El recurso no pertenece al servicio especificado");
      }

      const personasAutorizadas = await resolverPersonasCotizacionAutorizadas(pool, cabecera, {
        personas,
        usuarioObjetivoId: usuario_id,
        fechaIngreso: fechaInicioSolicitud,
      });

      const tarifaBase = await calcularTarifaBaseReserva(pool, {
        recursoId: recurso_id,
        regimenId: regimenIdSolicitud,
        personas: personasAutorizadas,
        fechaInicio: fechaInicioSolicitud,
        fechaFin: fechaFinSolicitud,
        temporadaTarifaId: temporadaTarifaIdFiltro,
      });
      const adicionalesProcesados = await calcularAdicionalesReserva(
        pool,
        adicionalesSeleccionados,
        recurso_id,
        regimenIdSolicitud,
        fechaInicioSolicitud,
        fechaFinSolicitud,
        tarifaBase.personas,
        temporadaTarifaIdFiltro
      );

      return res.status(200).json(construirFechasCotizacion(tarifaBase, adicionalesProcesados));
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json(error.message);
    }
    res.status(500).json("Error al obtener las tarifas por fecha");
  }
});

router.post("/reserva/adicionales", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      const { recurso_id, regimen_id, fecha_inicio, fecha_fin, modalidad, bloque_fecha_id } = req.body;

      if (!recurso_id || !regimen_id || !fecha_inicio || !fecha_fin) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const fechaInicioSolicitud = formatearFechaSQL(fecha_inicio);
      const fechaFinSolicitud = formatearFechaSQL(fecha_fin);
      if (!validarRangoReservaTemporal(fechaInicioSolicitud, fechaFinSolicitud).valido) {
        return res.status(422).json("El rango debe ser válido y no puede comenzar antes de hoy");
      }

      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      let temporadaTarifaIdFiltro = null;
      if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
        const bloqueSeleccionado = await obtenerBloqueConRecursos(mysqlConnection.promise(), bloqueFechaIdSolicitado);
        const recursoBloque = (bloqueSeleccionado.recursos || []).find((recurso) => Number(recurso.recurso_id) === Number(recurso_id));
        if (!recursoBloque || !rangoCoincideConBloque(fechaInicioSolicitud, fechaFinSolicitud, bloqueSeleccionado)) {
          return res.status(409).json("El bloque seleccionado no esta disponible para adicionales");
        }
        temporadaTarifaIdFiltro = bloqueSeleccionado.temporada_tarifa_id || null;
      }

      const filtroTemporada = temporadaTarifaIdFiltro ? "AND ta.temporada_tarifa_id = ?" : "";
      const [adicionales] = await mysqlConnection
        .promise()
        .query(
          `
            SELECT 
              ta.id as tarifa_adicional_id,
              ta.adicional_id,
              a.nombre,
              ta.precio,
              ta.fecha_inicio,
              ta.fecha_fin
            FROM tarifa_adicional ta
            INNER JOIN adicional a ON a.id = ta.adicional_id
            WHERE ta.recurso_id = ?
              AND ta.regimen_id = ?
              AND ta.fecha_inicio <= ?
              AND ta.fecha_fin >= ?
              AND ta.activo = 1
              ${filtroTemporada}
            ORDER BY ta.fecha_inicio ASC
          `,
          [recurso_id, regimen_id, fechaFinSolicitud, fechaInicioSolicitud, ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])]
        );

        res.status(200).json(adicionales);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los adicionales para la reserva");
  }
});

// Función auxiliar para registrar cambios en el historial
async function registrarHistorial(connection, usuarioId, tipoOperacion, tablaAfectada, usuarioModificadorId, req, campos = null, observaciones = null) {
  try {
    const ipAddress = req.ip || req.connection.remoteAddress || req.socket.remoteAddress ||
      (req.connection.socket ? req.connection.socket.remoteAddress : null);
    const userAgent = req.get('User-Agent') || null;

    if (campos && Array.isArray(campos)) {
      // Registrar cambio por cada campo modificado
      for (const campo of campos) {
        await connection.query(
          `INSERT INTO historial_usuario 
           (usuario_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, 
            tabla_afectada, usuario_modificador_id, ip_address, user_agent, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuarioId,
            tipoOperacion,
            campo.campo,
            campo.valorAnterior,
            campo.valorNuevo,
            tablaAfectada,
            usuarioModificadorId,
            ipAddress,
            userAgent,
            observaciones
          ]
        );
      }
    } else {
      // Registrar operación general (CREATE, DELETE)
      await connection.query(
        `INSERT INTO historial_usuario 
         (usuario_id, tipo_operacion, tabla_afectada, usuario_modificador_id, 
          ip_address, user_agent, observaciones)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          usuarioId,
          tipoOperacion,
          tablaAfectada,
          usuarioModificadorId,
          ipAddress,
          userAgent,
          observaciones
        ]
      );
    }
  } catch (error) {
    console.error('Error al registrar historial:', error);
    // No lanzar error para no interrumpir la operación principal
  }
}

// Variante estricta para operaciones cuyo cambio de estado y auditoría deben
// confirmar o revertir juntos dentro de la misma transacción.
async function registrarHistorialReservaEstricto(connection, reservaId, tipoOperacion, usuarioModificadorId, req, campos = null, observaciones = null) {
  const ipAddress = req.ip || req.connection.remoteAddress || req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null);
  const userAgent = req.get('User-Agent') || null;

  if (campos && Array.isArray(campos)) {
    // Registrar cambio por cada campo modificado
    for (const campo of campos) {
      await connection.query(
        `INSERT INTO historial_reserva
         (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
          usuario_modificador_id, ip_address, user_agent, observaciones)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reservaId,
          tipoOperacion,
          campo.campo,
          campo.valorAnterior,
          campo.valorNuevo,
          usuarioModificadorId,
          ipAddress,
          userAgent,
          observaciones
        ]
      );
    }
  } else {
    // Registrar operación general
    await connection.query(
      `INSERT INTO historial_reserva
       (reserva_id, tipo_operacion, usuario_modificador_id,
        ip_address, user_agent, observaciones)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        reservaId,
        tipoOperacion,
        usuarioModificadorId,
        ipAddress,
        userAgent,
        observaciones
      ]
    );
  }
}

// Los flujos legacy conservan historial best-effort para no cambiar su
// contrato. Las operaciones atómicas llaman directamente a la variante
// estricta de arriba.
async function registrarHistorialReserva(connection, reservaId, tipoOperacion, usuarioModificadorId, req, campos = null, observaciones = null) {
  try {
    await registrarHistorialReservaEstricto(
      connection,
      reservaId,
      tipoOperacion,
      usuarioModificadorId,
      req,
      campos,
      observaciones
    );
  } catch (error) {
    console.error('Error al registrar historial de reserva:', error);
  }
}

// ---------------------------------------------------------------------------
// Notificaciones del chat de reservas de turismo
// (mismo patrón que coseguro/traslados/olimpiadas)
// ---------------------------------------------------------------------------
async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    `INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, tipo, titulo, mensaje, JSON.stringify(payload || {})]
  );
}

// Staff de turismo involucrado en una reserva: admins globales + usuarios
// departamentales (con el área Turismo habilitada) de la departamental del afiliado.
async function notificarStaffTurismo(connection, departamentalId, tipo, titulo, mensaje, payload, excluirUsuarioId) {
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE u.habilitado = 'Y'
       AND (r.nombre = 'admin'
         OR (r.nombre = 'departamental' AND u.departamental_id = ?
             AND (u.area_turismo IS NULL OR u.area_turismo = 1)))`,
    [departamentalId || 0]
  );
  for (const u of usuarios) {
    if (excluirUsuarioId && Number(u.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, u.id, tipo, titulo, mensaje, payload);
  }
}

async function notificarAdministradoresTurismo(connection, tipo, titulo, mensaje, payload, excluirUsuarioId) {
  const [usuarios] = await connection.query(
    `SELECT u.id
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.habilitado = 'Y' AND r.nombre = 'admin'`
  );
  for (const usuario of usuarios) {
    if (excluirUsuarioId && Number(usuario.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, usuario.id, tipo, titulo, mensaje, payload);
  }
}

const SERVICIO_CAMPING_ID = 4;
const RECURSO_CAMPING_ID = 1;
const MAX_PERSONAS_CAMPING = 6;
const ESTADO_RESERVA_CANCELADA_ID = 4;
const ESTADO_RESERVA_INICIADA_ID = 1;
const ESTADO_RESERVA_RECHAZADA_ID = 4;
const MODALIDAD_FECHA_LIBRE = "FECHA_LIBRE";
const MODALIDAD_BLOQUE = "BLOQUE";
const MODALIDAD_SORTEO = "SORTEO";
const MODALIDAD_CONVENIO = "CONVENIO";
const TIPO_NOTIFICACION_CONVENIO_PROPUESTA = "CONVENIO_PROPUESTA";
const ESTADOS_RECURSO_BLOQUE_RESERVABLES = new Set(["DISPONIBLE", "VENTA_DIRECTA"]);
const ESTADOS_RECURSO_SORTEO_DISPONIBLES = new Set(["DISPONIBLE", "SORTEO"]);

function crearErrorNegocio(mensaje, statusCode = 400, codigo = null) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  error.codigo = codigo;
  return error;
}

function esErrorTemporadaAltaNoMigrada(error) {
  return (
    error?.code === "ER_NO_SUCH_TABLE" ||
    error?.code === "ER_BAD_FIELD_ERROR" ||
    error?.errno === 1146 ||
    error?.errno === 1054
  );
}

function formatearFechaSQL(fecha) {
  if (!fecha) {
    return null;
  }
  if (typeof fecha === "string") {
    return normalizarFechaCivil(fecha.trim());
  }
  return normalizarFechaCivil(fecha);
}

function sumarDiasFechaSQL(fecha, dias) {
  return sumarDiasFechaCivil(formatearFechaSQL(fecha), dias);
}

function obtenerFechaCivilHoyArgentina() {
  return obtenerFechaCivilArgentina();
}

function normalizarBoolean(valor) {
  if (valor === true || valor === 1) {
    return true;
  }
  if (typeof valor === "string") {
    return ["true", "1", "y", "yes", "si"].includes(valor.trim().toLowerCase());
  }
  return false;
}

function fechasSonIguales(fechaA, fechaB) {
  const fechaNormalizadaA = formatearFechaSQL(fechaA);
  const fechaNormalizadaB = formatearFechaSQL(fechaB);
  return Boolean(fechaNormalizadaA && fechaNormalizadaB && fechaNormalizadaA === fechaNormalizadaB);
}

function rangosSolapan(fechaInicioA, fechaFinA, fechaInicioB, fechaFinB) {
  const inicioA = formatearFechaSQL(fechaInicioA);
  const finA = formatearFechaSQL(fechaFinA);
  const inicioB = formatearFechaSQL(fechaInicioB);
  const finB = formatearFechaSQL(fechaFinB);
  return Boolean(inicioA && finA && inicioB && finB && inicioA < finB && finA > inicioB);
}

function rangosSolapanInclusivo(fechaInicioA, fechaFinA, fechaInicioB, fechaFinB) {
  const inicioA = formatearFechaSQL(fechaInicioA);
  const finA = formatearFechaSQL(fechaFinA);
  const inicioB = formatearFechaSQL(fechaInicioB);
  const finB = formatearFechaSQL(fechaFinB);
  return Boolean(inicioA && finA && inicioB && finB && inicioA <= finB && finA >= inicioB);
}

function rangoCoincideConBloque(fechaInicio, fechaFin, bloque) {
  return fechasSonIguales(fechaInicio, bloque.fecha_inicio) && fechasSonIguales(fechaFin, bloque.fecha_fin);
}

function normalizarIdPositivo(valor) {
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

async function resolverTitularReservaAlta(connection, cabecera, usuarioIdRaw, {
  requiereCoseguro = false,
} = {}) {
  const esRolCargaAdministrativa = ["admin", "departamental"].includes(cabecera.rol);
  if (
    requiereCoseguro &&
    esRolCargaAdministrativa &&
    !puedeVerDatosSaludReserva(cabecera)
  ) {
    throw crearErrorNegocio(
      "Para registrar un viaje por salud, debes tener acceso al área Coseguro",
      403,
      "AREA_COSEGURO_REQUERIDA"
    );
  }
  const usuarioIdFueInformado = !(
    usuarioIdRaw === undefined ||
    usuarioIdRaw === null ||
    (typeof usuarioIdRaw === "string" && usuarioIdRaw.trim() === "")
  );
  const usuarioIdSolicitado = normalizarIdPositivo(usuarioIdRaw);
  if (esRolCargaAdministrativa && !usuarioIdFueInformado) {
    throw crearErrorNegocio(
      "Debes seleccionar al afiliado titular de la reserva",
      400,
      "TITULAR_REQUERIDO"
    );
  }
  if (esRolCargaAdministrativa && !usuarioIdSolicitado) {
    throw crearErrorNegocio("El usuario titular indicado no es válido", 400, "TITULAR_INVALIDO");
  }

  const usuarioReservaId = esRolCargaAdministrativa
    ? usuarioIdSolicitado
    : normalizarIdPositivo(cabecera.id);
  if (!usuarioReservaId) {
    throw crearErrorNegocio("El usuario titular indicado no es válido", 400, "TITULAR_INVALIDO");
  }

  const [usuariosTitulares] = await connection.query(
    `SELECT u.id, u.nombre, u.apellido, u.usuario_familiar_id, u.departamental_id,
            u.habilitado, u.modulo_turismo, u.modulo_coseguro, r.nombre AS rol
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ?
      LIMIT 1
      FOR UPDATE`,
    [usuarioReservaId]
  );
  if (usuariosTitulares.length === 0) {
    throw crearErrorNegocio("El usuario titular indicado no existe", 404, "TITULAR_NO_ENCONTRADO");
  }

  const usuarioTitular = usuariosTitulares[0];
  if (cabecera.rol === "departamental") {
    const [editores] = await connection.query(
      "SELECT departamental_id FROM usuario WHERE id = ? LIMIT 1",
      [cabecera.id]
    );
    const departamentalEditorId = normalizarIdPositivo(editores[0]?.departamental_id);
    const departamentalTitularId = normalizarIdPositivo(usuarioTitular.departamental_id);
    if (!departamentalEditorId || departamentalEditorId !== departamentalTitularId) {
      throw crearErrorNegocio(
        "No puedes crear reservas para afiliados de otra departamental",
        403,
        "TITULAR_OTRA_DEPARTAMENTAL"
      );
    }
  }
  if (usuarioTitular.habilitado !== "Y" || usuarioTitular.rol !== "afiliado") {
    throw crearErrorNegocio(
      "El titular debe ser un afiliado habilitado",
      422,
      "TITULAR_NO_AFILIADO"
    );
  }
  if (Number(usuarioTitular.modulo_turismo) !== 1) {
    throw crearErrorNegocio(
      "El afiliado titular no tiene habilitado el módulo Turismo",
      403,
      "MODULO_TURISMO_DESHABILITADO"
    );
  }
  if (requiereCoseguro && Number(usuarioTitular.modulo_coseguro) !== 1) {
    throw crearErrorNegocio(
      "Para registrar un viaje por salud, el afiliado titular debe tener habilitado el módulo Coseguro",
      403,
      "MODULO_COSEGURO_DESHABILITADO"
    );
  }

  return { esRolCargaAdministrativa, usuarioReservaId, usuarioTitular };
}

function normalizarEnteroNoNegativoOpcional(valor, maximo = Number.MAX_SAFE_INTEGER) {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return undefined;
  if (typeof valor !== "string" && typeof valor !== "number") return undefined;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero >= 0 && numero <= maximo ? numero : undefined;
}

function normalizarPaginacion(query, tamanioPorDefecto = 10) {
  const page = query?.page === undefined || query?.page === ""
    ? 1
    : normalizarIdPositivo(query.page);
  const pageSize = query?.pageSize === undefined || query?.pageSize === ""
    ? tamanioPorDefecto
    : normalizarIdPositivo(query.pageSize);
  if (page === null || pageSize === null || page > 1_000_000 || pageSize > 100) return null;
  return { page, pageSize, start: (page - 1) * pageSize };
}

function normalizarModalidad(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === "") {
    return MODALIDAD_FECHA_LIBRE;
  }
  const modalidad = String(valor).trim().toUpperCase();
  if ([MODALIDAD_FECHA_LIBRE, MODALIDAD_BLOQUE, MODALIDAD_SORTEO, MODALIDAD_CONVENIO].includes(modalidad)) {
    return modalidad;
  }
  throw crearErrorNegocio("La modalidad indicada no es valida", 400, "MODALIDAD_INVALIDA");
}

function parseJsonSeguro(valor) {
  if (!valor) {
    return null;
  }
  if (typeof valor === "object") {
    return valor;
  }
  try {
    return JSON.parse(valor);
  } catch (error) {
    return null;
  }
}

function normalizarTexto(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

function normalizarBooleanActivo(valor, valorPorDefecto = true) {
  if (valor === undefined || valor === null || valor === "") {
    return valorPorDefecto ? 1 : 0;
  }
  if (typeof valor === "string") {
    const texto = valor.trim().toLowerCase();
    if (["1", "true", "y", "yes", "si", "s"].includes(texto)) {
      return 1;
    }
    if (["0", "false", "n", "no"].includes(texto)) {
      return 0;
    }
  }
  return normalizarBoolean(valor) ? 1 : 0;
}

function normalizarBooleanoBinarioEstricto(valor) {
  if ([true, 1, "1", "true"].includes(valor)) return 1;
  if ([false, 0, "0", "false"].includes(valor)) return 0;
  return null;
}

function normalizarSiNoEstricto(valor) {
  if ([true, 1, "1", "true", "Y"].includes(valor)) return "Y";
  if ([false, 0, "0", "false", "N"].includes(valor)) return "N";
  return null;
}

function normalizarNumeroNullable(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return null;
  }
  if (typeof valor === "string" && !/^[+-]?\d+(?:\.\d+)?$/.test(valor.trim())) return null;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function normalizarOrden(valor) {
  if (valor === undefined || valor === null || valor === "") return 0;
  if (typeof valor === "string" && !/^-?\d+$/.test(valor.trim())) return null;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && Math.abs(numero) <= 1_000_000 ? numero : null;
}

function validarDatosImagenLogin(body = {}) {
  const orden = normalizarOrden(body.orden);
  const activo = body.activo === undefined ? 1 : normalizarBooleanoBinarioEstricto(body.activo);
  if (orden === null) return { error: "El orden debe ser un entero válido" };
  if (activo === null) return { error: "El estado activo es inválido" };

  return {
    activo,
    orden,
  };
}

async function subirImagenLogin(file) {
  const extension = EXTENSION_BY_MIME[file.mimetype] || getSafeFileExtension(file.originalname, file.mimetype);
  const key = `login/fondos/fondo_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${extension}`;
  await uploadBufferToS3({
    key,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
  return key;
}

async function firmarImagenLogin(row) {
  let imagenUrl = null;
  try {
    imagenUrl = await getSignedFileUrlFromS3(row.archivo);
  } catch (error) {
    console.error("Error generando URL firmada para una imagen del login:", error);
  }

  return {
    id: Number(row.id),
    archivo: row.archivo,
    nombre_original: row.nombre_original,
    activo: Number(row.activo) === 1,
    orden: Number(row.orden || 0),
    imagen_url: imagenUrl,
    fecha_creacion: row.fecha_creacion,
    fecha_actualizacion: row.fecha_actualizacion,
  };
}

async function obtenerImagenesLogin(connection, { soloActivas = false, imagenId = null } = {}) {
  const filtros = [];
  const params = [];
  if (soloActivas) {
    filtros.push("activo = 1");
  }
  if (imagenId) {
    filtros.push("id = ?");
    params.push(imagenId);
  }

  const where = filtros.length > 0 ? `WHERE ${filtros.join(" AND ")}` : "";
  const [rows] = await connection.query(
    `
      SELECT id, archivo, nombre_original, activo, orden,
             fecha_creacion, fecha_actualizacion
      FROM login_imagen
      ${where}
      ORDER BY orden ASC, id ASC
    `,
    params
  );
  return Promise.all(rows.map((row) => firmarImagenLogin(row)));
}

function parseArrayDesdeFormulario(valor) {
  if (Array.isArray(valor)) {
    return valor;
  }
  if (typeof valor === "string" && valor.trim() !== "") {
    const parsed = parseJsonSeguro(valor);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

async function subirArchivoConvenioHotel(file, prefijo) {
  const extension = EXTENSION_BY_MIME[file.mimetype] || getSafeFileExtension(file.originalname, file.mimetype);
  const key = `convenios_hoteleros/${prefijo}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({
    key,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
  return key;
}

async function subirImagenTurismoPropuesta(file) {
  const extension = EXTENSION_BY_MIME[file.mimetype] || getSafeFileExtension(file.originalname, file.mimetype);
  const key = `turismo_propuestas/propuesta_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({
    key,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
  return key;
}

async function firmarTurismoPropuesta(row) {
  let imagenUrl = null;
  if (row?.imagen_archivo) {
    try {
      imagenUrl = await getSignedFileUrlFromS3(row.imagen_archivo);
    } catch (error) {
      console.error("Error generando URL firmada para propuesta de turismo:", error);
    }
  }

  return {
    id: Number(row.id),
    titulo: row.titulo,
    name: row.titulo,
    link: row.link,
    imagen_archivo: row.imagen_archivo,
    imagen_url: imagenUrl,
    image: imagenUrl,
    orden: Number(row.orden || 0),
    fecha_creacion: row.fecha_creacion,
    fecha_modificacion: row.fecha_modificacion,
  };
}

async function obtenerPropuestasTurismo(connection, propuestaId = null) {
  const params = [];
  let filtro = "";
  if (propuestaId) {
    filtro = "WHERE id = ?";
    params.push(propuestaId);
  }

  const [rows] = await connection.query(
    `
      SELECT
        id,
        titulo,
        imagen_archivo,
        link,
        orden,
        fecha_creacion,
        fecha_modificacion
      FROM turismo_propuesta
      ${filtro}
      ORDER BY orden ASC, id ASC
    `,
    params
  );

  return Promise.all(rows.map((row) => firmarTurismoPropuesta(row)));
}

function validarDatosTestimonioTurismo(body) {
  const nombre = normalizarTexto(body.nombre);
  const localidad = normalizarTexto(body.localidad);
  const comentario = normalizarTexto(body.comentario);
  const estrellas = normalizarIdPositivo(body.estrellas);

  if (!nombre || nombre.length > 80) {
    return { error: "El nombre es requerido (maximo 80 caracteres)" };
  }
  if (!localidad || localidad.length > 120) {
    return { error: "La localidad es requerida (maximo 120 caracteres)" };
  }
  if (!comentario || comentario.length > 500) {
    return { error: "El comentario es requerido (maximo 500 caracteres)" };
  }
  if (!Number.isInteger(estrellas) || estrellas < 1 || estrellas > 5) {
    return { error: "Las estrellas deben ser un entero entre 1 y 5" };
  }

  const orden = normalizarOrden(body.orden);
  const activo = body.activo === undefined ? 1 : normalizarBooleanoBinarioEstricto(body.activo);
  if (orden === null) return { error: "El orden debe ser un entero válido" };
  if (activo === null) return { error: "El estado activo es inválido" };

  return {
    nombre,
    localidad,
    comentario,
    estrellas,
    activo,
    orden,
  };
}

async function subirFotoTurismoTestimonio(file) {
  const extension = EXTENSION_BY_MIME[file.mimetype] || getSafeFileExtension(file.originalname, file.mimetype);
  const key = `turismo_testimonios/testimonio_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${extension}`;
  await uploadBufferToS3({
    key,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
  return key;
}

async function firmarTurismoTestimonio(row) {
  let fotoUrl = null;
  if (row?.foto_archivo) {
    try {
      fotoUrl = await getSignedFileUrlFromS3(row.foto_archivo);
    } catch (error) {
      console.error("Error generando URL firmada para testimonio de turismo:", error);
    }
  }

  return {
    id: Number(row.id),
    nombre: row.nombre,
    localidad: row.localidad,
    estrellas: Number(row.estrellas),
    comentario: row.comentario,
    foto_archivo: row.foto_archivo,
    foto_url: fotoUrl,
    activo: row.activo === 1 || row.activo === true,
    orden: Number(row.orden || 0),
    fecha_creacion: row.fecha_creacion,
    fecha_modificacion: row.fecha_modificacion,
  };
}

async function obtenerTestimoniosTurismo(connection, { soloActivos = false, testimonioId = null } = {}) {
  const condiciones = [];
  const params = [];

  if (soloActivos) {
    condiciones.push("activo = 1");
  }
  if (testimonioId) {
    condiciones.push("id = ?");
    params.push(testimonioId);
  }

  const filtro = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  const [rows] = await connection.query(
    `
      SELECT
        id,
        nombre,
        localidad,
        estrellas,
        comentario,
        foto_archivo,
        activo,
        orden,
        fecha_creacion,
        fecha_modificacion
      FROM turismo_testimonio
      ${filtro}
      ORDER BY orden ASC, id ASC
    `,
    params
  );

  return Promise.all(rows.map((row) => firmarTurismoTestimonio(row)));
}

async function firmarImagenesConvenio(imagenes = []) {
  return Promise.all((imagenes || []).map(async (imagen) => {
    let archivoUrl = null;
    try {
      archivoUrl = await getSignedFileUrlFromS3(imagen.archivo);
    } catch (error) {
      console.error("Error generando URL firmada para imagen de convenio:", error);
    }

    return {
      id: Number(imagen.id),
      hotel_id: Number(imagen.hotel_id),
      archivo: archivoUrl,
      archivo_url: archivoUrl,
      orden: Number(imagen.orden || 0),
    };
  }));
}

async function firmarConvenioHotel(row, imagenes = []) {
  let tarifarioPdfUrl = null;
  if (row?.tarifario_pdf_archivo) {
    try {
      tarifarioPdfUrl = await getSignedFileUrlFromS3(row.tarifario_pdf_archivo);
    } catch (error) {
      console.error("Error generando URL firmada para PDF de convenio:", error);
    }
  }

  return {
    id: Number(row.id),
    nombre: row.nombre,
    ciudad: row.ciudad,
    provincia: row.provincia,
    coordenadas_maps: row.coordenadas_maps,
    latitud: row.latitud !== null && row.latitud !== undefined ? Number(row.latitud) : null,
    longitud: row.longitud !== null && row.longitud !== undefined ? Number(row.longitud) : null,
    descripcion: row.descripcion || "",
    activo: row.activo === 1 || row.activo === true,
    tarifario_pdf_url: tarifarioPdfUrl,
    fecha_creacion: row.fecha_creacion,
    fecha_modificacion: row.fecha_modificacion,
    imagenes: await firmarImagenesConvenio(imagenes),
  };
}

async function obtenerImagenesConvenioPorHotel(connection, hotelIds) {
  const ids = (hotelIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await connection.query(
    `SELECT id, convenio_hotel_id AS hotel_id, archivo, orden
     FROM convenio_hotel_imagen
     WHERE convenio_hotel_id IN (${placeholders})
     ORDER BY convenio_hotel_id ASC, orden ASC, id ASC`,
    ids
  );

  const mapa = new Map();
  rows.forEach((row) => {
    const hotelId = Number(row.hotel_id);
    if (!mapa.has(hotelId)) {
      mapa.set(hotelId, []);
    }
    mapa.get(hotelId).push(row);
  });
  return mapa;
}

// Vínculo por defecto de una persona creada durante una reserva: si el
// parentesco declarado es Pareja (2), Hijo (3) o Familiar (4) integra el grupo
// familiar; el resto queda como acompañante de viaje.
function esFamiliarPorParentesco(parentescoId) {
  return [2, 3, 4].includes(Number(parentescoId)) ? "S" : "N";
}

async function obtenerUsuarioPrincipalFamilia(connection, usuarioId) {
  const [usuarioCreador] = await connection.query(
    "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
    [usuarioId]
  );

  let usuarioFamiliarPrincipalId = usuarioId;
  let departamentalId = usuarioCreador[0]?.departamental_id || null;

  if (usuarioCreador.length > 0) {
    let currentUserId = usuarioCreador[0].id;
    let currentUserFamiliarId = usuarioCreador[0].usuario_familiar_id;
    let currentDepartamentalId = usuarioCreador[0].departamental_id;
    const usuariosVisitados = new Set([Number(currentUserId)]);

    while (currentUserFamiliarId !== null) {
      const siguienteId = Number(currentUserFamiliarId);
      if (!Number.isInteger(siguienteId) || usuariosVisitados.has(siguienteId)) {
        throw crearErrorNegocio("La jerarquia familiar contiene un ciclo o una referencia invalida", 409, "JERARQUIA_FAMILIAR_INVALIDA");
      }
      usuariosVisitados.add(siguienteId);
      const [nextUser] = await connection.query(
        "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
        [currentUserFamiliarId]
      );

      if (nextUser.length === 0) {
        break;
      }

      currentUserId = nextUser[0].id;
      currentUserFamiliarId = nextUser[0].usuario_familiar_id;
      currentDepartamentalId = nextUser[0].departamental_id;
    }

    usuarioFamiliarPrincipalId = currentUserId;
    departamentalId = currentDepartamentalId;
  }

  return { usuarioFamiliarPrincipalId, departamentalId };
}

async function puedeAccederUsuarioPorJurisdiccion(connection, cabecera, usuarioObjetivoId) {
  const objetivoId = normalizarIdPositivo(usuarioObjetivoId);
  const actorId = normalizarIdPositivo(cabecera?.id);
  if (!objetivoId || !actorId) return false;
  if (cabecera.rol !== "departamental") return false;

  const [usuarios] = await connection.query(
    "SELECT id, departamental_id FROM usuario WHERE id IN (?, ?)",
    [actorId, objetivoId]
  );
  if (usuarios.length !== (actorId === objetivoId ? 1 : 2)) return false;
  const porId = new Map(usuarios.map((usuario) => [Number(usuario.id), usuario.departamental_id]));
  const departamentalActor = normalizarIdPositivo(porId.get(actorId));
  const departamentalObjetivo = normalizarIdPositivo(porId.get(objetivoId));
  return Boolean(departamentalActor && departamentalObjetivo && departamentalActor === departamentalObjetivo);
}

async function puedeAccederUsuarioRelacionado(connection, cabecera, usuarioObjetivoId) {
  const objetivoId = normalizarIdPositivo(usuarioObjetivoId);
  const actorId = normalizarIdPositivo(cabecera?.id);
  if (!objetivoId || !actorId) return false;
  if (cabecera.rol === "admin") return true;

  if (cabecera.rol === "afiliado") {
    const familiaActor = await obtenerUsuarioPrincipalFamilia(connection, actorId);
    const familiaObjetivo = await obtenerUsuarioPrincipalFamilia(connection, objetivoId);
    return Number(familiaActor.usuarioFamiliarPrincipalId) === Number(familiaObjetivo.usuarioFamiliarPrincipalId);
  }

  if (cabecera.rol === "departamental" && tieneAreaTurismo(cabecera)) {
    return puedeAccederUsuarioPorJurisdiccion(connection, cabecera, objetivoId);
  }

  return false;
}

async function resolverPersonasCotizacionAutorizadas(connection, cabecera, {
  personas,
  usuarioObjetivoId,
  fechaIngreso,
}) {
  const actorId = normalizarIdPositivo(cabecera?.id);
  const solicitadoId = normalizarIdPositivo(usuarioObjetivoId);
  if (!actorId) {
    throw crearErrorNegocio("No se pudo identificar al usuario autenticado", 401);
  }

  let titularId = actorId;
  if (cabecera.rol === "afiliado") {
    if (usuarioObjetivoId !== undefined && usuarioObjetivoId !== null && solicitadoId !== actorId) {
      throw crearErrorNegocio("No puedes cotizar para otro afiliado", 403);
    }
  } else {
    if (!solicitadoId) {
      throw crearErrorNegocio("Debes indicar el afiliado titular de la cotizacion", 400);
    }
    titularId = solicitadoId;
    if (cabecera.rol === "departamental" && !(await puedeAccederUsuarioRelacionado(connection, cabecera, titularId))) {
      throw crearErrorNegocio("No puedes cotizar para afiliados de otra departamental", 403);
    }
  }

  const [titulares] = await connection.query(
    `SELECT u.id, u.habilitado, r.nombre AS rol
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ?
      LIMIT 1`,
    [titularId]
  );
  if (titulares.length === 0 || titulares[0].rol !== "afiliado" || titulares[0].habilitado !== "Y") {
    throw crearErrorNegocio("El titular debe ser un afiliado habilitado", 422);
  }

  const { usuarioFamiliarPrincipalId, departamentalId } = await obtenerUsuarioPrincipalFamilia(
    connection,
    titularId
  );
  return crearOBuscarUsuariosReserva(connection, personas, {
    usuarioFamiliarPrincipalId,
    departamentalId,
    usuarioModificadorId: actorId,
    req: null,
    crearSiNoExiste: false,
    fechaIngreso,
  });
}

async function crearOBuscarUsuariosReserva(connection, personas, {
  usuarioFamiliarPrincipalId,
  departamentalId,
  usuarioModificadorId,
  req,
  crearSiNoExiste = true,
  fechaIngreso,
}) {
  if (!Array.isArray(personas) || personas.length === 0 || personas.length > 100) {
    throw crearErrorNegocio("La reserva debe incluir entre 1 y 100 personas", 400);
  }
  const usuariosIds = [];
  const documentosIncluidos = new Set();
  const principalId = normalizarIdPositivo(usuarioFamiliarPrincipalId);
  const fechaIngresoNormalizada = formatearFechaSQL(fechaIngreso);
  if (!principalId) {
    throw crearErrorNegocio("No se pudo determinar el titular del grupo familiar", 409, "TITULAR_INVALIDO");
  }
  if (!fechaIngresoNormalizada) {
    throw crearErrorNegocio("La fecha de ingreso de la reserva no es valida", 400);
  }

  for (let indice = 0; indice < personas.length; indice++) {
    const persona = personas[indice];
    const dni = String(persona.dni ?? persona.documento ?? "").trim();
    if (!esDniValido(dni)) {
      throw crearErrorNegocio(`El documento de personas[${indice}] no es valido`, 400);
    }
    if (documentosIncluidos.has(dni)) {
      throw crearErrorNegocio("No se puede incluir dos veces a la misma persona", 400, "PERSONA_DUPLICADA");
    }
    documentosIncluidos.add(dni);

    const personaId = normalizarIdPositivo(persona.id ?? persona.usuario_id);
    const [existeUsuario] = await connection.query(
      personaId
        ? `SELECT id, documento, nombre, apellido, fecha_nacimiento, tipo_persona_id,
                  parentesco_id, telefono, email
           FROM usuario WHERE id = ? LIMIT 1`
        : `SELECT id, documento, nombre, apellido, fecha_nacimiento, tipo_persona_id,
                  parentesco_id, telefono, email
           FROM usuario WHERE documento = ? LIMIT 1`,
      [personaId || dni]
    );

    let usuarioId;
    let personaAutorizada;
    if (existeUsuario.length > 0) {
      const usuarioExistente = existeUsuario[0];
      if (personaId && String(usuarioExistente.documento ?? "").trim() !== dni) {
        throw crearErrorNegocio("El identificador de la persona no coincide con su documento", 409, "PERSONA_INCONSISTENTE");
      }
      const familiaExistente = await obtenerUsuarioPrincipalFamilia(connection, usuarioExistente.id);
      if (Number(familiaExistente.usuarioFamiliarPrincipalId) !== principalId) {
        throw crearErrorNegocio("La persona indicada pertenece a otro grupo familiar", 403, "PERSONA_FUERA_DEL_GRUPO");
      }
      usuarioId = usuarioExistente.id;
      personaAutorizada = {
        ...persona,
        nombre: usuarioExistente.nombre,
        apellido: usuarioExistente.apellido,
        fecha_nacimiento: formatearFechaSQL(usuarioExistente.fecha_nacimiento),
        tipo_persona_id: normalizarIdPositivo(usuarioExistente.tipo_persona_id),
        parentesco_id: normalizarIdPositivo(usuarioExistente.parentesco_id),
        telefono: usuarioExistente.telefono || null,
        email: usuarioExistente.email || null,
      };
      personaAutorizada.edad = calcularEdadEnFecha(
        personaAutorizada.fecha_nacimiento,
        fechaIngresoNormalizada
      );
      if (!Number.isInteger(personaAutorizada.edad) || personaAutorizada.edad < 0 || personaAutorizada.edad > 130) {
        throw crearErrorNegocio(`La fecha de nacimiento de personas[${indice}] no es valida`, 409);
      }
    } else {
      if (personaId) {
        throw crearErrorNegocio("La persona indicada no existe", 404);
      }
      const tipoPersonaId = normalizarIdPositivo(persona.tipo_persona_id ?? persona.tipo);
      const fechaNacimiento = formatearFechaSQL(persona.fecha_nacimiento ?? persona.fechaNacimiento);
      const nombrePersona = normalizarTexto(persona.nombre);
      const apellidoPersona = normalizarTexto(persona.apellido);
      if (!tipoPersonaId || !fechaNacimiento || !nombrePersona || !apellidoPersona) {
        throw crearErrorNegocio(`Los datos de personas[${indice}] no son validos`, 400);
      }
      const [tiposPersona] = await connection.query("SELECT id FROM tipo_persona WHERE id = ? LIMIT 1", [tipoPersonaId]);
      if (tiposPersona.length === 0) {
        throw crearErrorNegocio(`El tipo de personas[${indice}] no existe`, 400);
      }
      const edadEnIngreso = calcularEdadEnFecha(fechaNacimiento, fechaIngresoNormalizada);
      if (!Number.isInteger(edadEnIngreso) || edadEnIngreso < 0 || edadEnIngreso > 130) {
        throw crearErrorNegocio(`La fecha de nacimiento de personas[${indice}] no es valida`, 400);
      }
      if (tipoPersonaId === 1) {
        throw crearErrorNegocio(
          "La categoria Afiliado solo puede usarse para una persona ya registrada",
          422,
          "TIPO_PERSONA_NO_VERIFICADO"
        );
      }
      if ((edadEnIngreso < 2 && tipoPersonaId !== 5) || (edadEnIngreso >= 2 && tipoPersonaId === 5)) {
        throw crearErrorNegocio(
          `El tipo de personas[${indice}] no coincide con su edad al ingreso`,
          422,
          "TIPO_PERSONA_EDAD_INCONSISTENTE"
        );
      }
      if (tipoPersonaId === 2 && esFamiliarPorParentesco(persona.parentesco_id) !== "S") {
        throw crearErrorNegocio(
          `El tipo familiar de personas[${indice}] requiere un parentesco familiar`,
          422,
          "TIPO_PERSONA_PARENTESCO_INCONSISTENTE"
        );
      }
      const rolId = tipoPersonaId === 1 ? 2 : 4;

      usuarioId = null;
      personaAutorizada = {
        ...persona,
        nombre: nombrePersona,
        apellido: apellidoPersona,
        fecha_nacimiento: fechaNacimiento,
        edad: edadEnIngreso,
        tipo_persona_id: tipoPersonaId,
        parentesco_id: normalizarIdPositivo(persona.parentesco_id),
      };

      if (crearSiNoExiste) {
        const [nuevoUsuario] = await connection.query(
          `INSERT INTO usuario (
            rol_id, parentesco_id, tipo_persona_id, nombre, apellido, fecha_nacimiento,
            documento, telefono, password, usuario_familiar_id, es_familiar, departamental_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          [
            rolId,
            persona.parentesco_id || null,
            tipoPersonaId,
            nombrePersona,
            apellidoPersona,
            fechaNacimiento,
            dni,
            persona.telefono || null,
            principalId,
            esFamiliarPorParentesco(persona.parentesco_id),
            departamentalId,
          ]
        );
        usuarioId = nuevoUsuario.insertId;

        await registrarHistorial(
          connection,
          usuarioId,
          "CREATE",
          "usuario",
          usuarioModificadorId,
          req,
          null,
          `Usuario creado durante reserva. Datos: ${persona.nombre} ${persona.apellido}, DNI: ${dni}`
        );
      }
    }

    usuariosIds.push({
      ...personaAutorizada,
      dni,
      usuario_id: usuarioId,
    });
  }

  return usuariosIds;
}

async function obtenerReservaConvenioParaAcceso(connection, reservaId, { forUpdate = false } = {}) {
  const lockSql = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `
      SELECT
        r.*,
        er.nombre AS estado_nombre,
        u.departamental_id AS usuario_departamental_id,
        ch.nombre AS convenio_nombre,
        ch.ciudad AS convenio_ciudad,
        ch.provincia AS convenio_provincia
      FROM reserva r
      INNER JOIN usuario u ON u.id = r.usuario_id
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
      WHERE r.id = ?
        AND r.modalidad = ?
      LIMIT 1${lockSql}
    `,
    [reservaId, MODALIDAD_CONVENIO]
  );

  return rows.length > 0 ? rows[0] : null;
}

let columnaUsuarioDepartamentalPropuestaCache;
async function obtenerColumnaUsuarioDepartamentalPropuesta(connection) {
  if (columnaUsuarioDepartamentalPropuestaCache !== undefined) {
    return columnaUsuarioDepartamentalPropuestaCache;
  }

  const [rows] = await connection.query(
    `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'reserva_convenio_propuesta'
        AND COLUMN_NAME IN ('departamental_usuario_id', 'usuario_departamental_id')
    `
  );

  const columnas = rows.map((row) => row.COLUMN_NAME);
  columnaUsuarioDepartamentalPropuestaCache = columnas.includes("departamental_usuario_id")
    ? "departamental_usuario_id"
    : (columnas.includes("usuario_departamental_id") ? "usuario_departamental_id" : null);

  return columnaUsuarioDepartamentalPropuestaCache;
}

function puedeGestionarReservaConvenio(cabecera, reserva) {
  if (!reserva) {
    return false;
  }
  if (cabecera.rol === "admin") {
    return true;
  }
  if (cabecera.rol === "afiliado") {
    return Number(reserva.usuario_id) === Number(cabecera.id);
  }
  if (cabecera.rol === "departamental") {
    return Number(reserva.usuario_departamental_id) === Number(cabecera.departamental_id);
  }
  return false;
}

function mapearPremioSorteo(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    notificacion_id: row.notificacion_id ? Number(row.notificacion_id) : null,
    reserva_id: Number(row.reserva_id),
    sorteo_nombre: row.sorteo_nombre || null,
    bloque_nombre: row.bloque_nombre || null,
    servicio_nombre: row.servicio_nombre || null,
    lugar: row.lugar || null,
    recurso_nombre: row.recurso_nombre || null,
    fecha_inicio: formatearFechaSQL(row.fecha_inicio),
    fecha_fin: formatearFechaSQL(row.fecha_fin),
    precio_total: Number(row.precio_total || 0),
    monto_adicionales: Number(row.monto_adicionales || 0),
    cantidad_personas: Number(row.cantidad_personas || 0),
    estado: row.estado || null,
    sorteo_id: row.sorteo_id ? Number(row.sorteo_id) : null,
    sorteo_estado: row.sorteo_estado || null,
    bloque_fecha_id: row.bloque_fecha_id ? Number(row.bloque_fecha_id) : null,
    bloque_estado: row.bloque_estado || null,
    bloque_fecha_inicio: formatearFechaSQL(row.bloque_fecha_inicio),
    recurso_id: row.recurso_id ? Number(row.recurso_id) : null,
    usuario_id: row.usuario_id ? Number(row.usuario_id) : null
  };
}

async function obtenerDetallePremioParaReserva(connection, reservaId, recursoId) {
  const [rows] = await connection.query(
    `
      SELECT
        r.id AS reserva_id,
        r.usuario_id,
        r.sorteo_id,
        r.bloque_fecha_id,
        ? AS recurso_id,
        r.precio_total,
        r.monto_adicionales,
        r.fecha_inicio,
        r.fecha_fin,
        s.nombre AS sorteo_nombre,
        s.estado AS sorteo_estado,
        bf.nombre AS bloque_nombre,
        bf.estado AS bloque_estado,
        bf.fecha_inicio AS bloque_fecha_inicio,
        srv.nombre AS servicio_nombre,
        srv.lugar,
        rec.nombre AS recurso_nombre,
        (SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) AS cantidad_personas
      FROM reserva r
      LEFT JOIN sorteo s ON s.id = r.sorteo_id
      LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
      LEFT JOIN servicio srv ON srv.id = COALESCE(r.servicio_id, bf.servicio_id)
      LEFT JOIN recurso rec ON rec.id = ?
      WHERE r.id = ?
      LIMIT 1
    `,
    [recursoId, recursoId, reservaId]
  );

  return rows.length > 0 ? rows[0] : {};
}

async function obtenerPremioSorteoPorAdjudicacion(connection, {
  adjudicacionId,
  usuarioId = null,
  forUpdate = false
} = {}) {
  const idNormalizado = normalizarIdPositivo(adjudicacionId);
  if (!idNormalizado) {
    return null;
  }

  const params = [idNormalizado];
  let filtroUsuario = "";
  const usuarioNormalizado = normalizarIdPositivo(usuarioId);
  if (usuarioNormalizado) {
    filtroUsuario = "AND sar.usuario_id = ?";
    params.push(usuarioNormalizado);
  }

  const lockSql = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `
      SELECT
        sar.id,
        sar.notificacion_id,
        sar.reserva_id,
        sar.usuario_id,
        sar.estado,
        r.sorteo_id,
        r.bloque_fecha_id,
        sar.recurso_id,
        r.precio_total,
        r.monto_adicionales,
        r.fecha_inicio,
        r.fecha_fin,
        s.nombre AS sorteo_nombre,
        s.estado AS sorteo_estado,
        bf.nombre AS bloque_nombre,
        bf.estado AS bloque_estado,
        bf.fecha_inicio AS bloque_fecha_inicio,
        srv.nombre AS servicio_nombre,
        srv.lugar,
        rec.nombre AS recurso_nombre,
        (SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) AS cantidad_personas
      FROM sorteo_adjudicacion_respuesta sar
      INNER JOIN reserva r ON r.id = sar.reserva_id
      LEFT JOIN sorteo s ON s.id = sar.sorteo_id
      LEFT JOIN bloque_fecha bf ON bf.id = sar.bloque_fecha_id
      LEFT JOIN servicio srv ON srv.id = COALESCE(r.servicio_id, bf.servicio_id)
      LEFT JOIN recurso rec ON rec.id = sar.recurso_id
      WHERE sar.id = ?
        ${filtroUsuario}
      LIMIT 1${lockSql}
    `,
    params
  );

  return rows.length > 0 ? mapearPremioSorteo(rows[0]) : null;
}

async function obtenerPremioSorteoPendiente(connection, usuarioId) {
  const usuarioNormalizado = normalizarIdPositivo(usuarioId);
  if (!usuarioNormalizado) {
    return null;
  }

  const [rows] = await connection.query(
    `
      SELECT
        sar.id,
        sar.notificacion_id,
        sar.reserva_id,
        sar.usuario_id,
        sar.estado,
        r.sorteo_id,
        r.bloque_fecha_id,
        sar.recurso_id,
        r.precio_total,
        r.monto_adicionales,
        r.fecha_inicio,
        r.fecha_fin,
        s.nombre AS sorteo_nombre,
        s.estado AS sorteo_estado,
        bf.nombre AS bloque_nombre,
        bf.estado AS bloque_estado,
        bf.fecha_inicio AS bloque_fecha_inicio,
        srv.nombre AS servicio_nombre,
        srv.lugar,
        rec.nombre AS recurso_nombre,
        (SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id = r.id) AS cantidad_personas
      FROM sorteo_adjudicacion_respuesta sar
      INNER JOIN reserva r ON r.id = sar.reserva_id
      LEFT JOIN sorteo s ON s.id = sar.sorteo_id
      LEFT JOIN bloque_fecha bf ON bf.id = sar.bloque_fecha_id
      LEFT JOIN servicio srv ON srv.id = COALESCE(r.servicio_id, bf.servicio_id)
      LEFT JOIN recurso rec ON rec.id = sar.recurso_id
      WHERE sar.usuario_id = ?
        AND sar.estado = 'PENDIENTE'
      ORDER BY sar.fecha_adjudicacion DESC, sar.id DESC
      LIMIT 1
    `,
    [usuarioNormalizado]
  );

  return rows.length > 0 ? mapearPremioSorteo(rows[0]) : null;
}

function fechaSqlAIndice(fecha) {
  return fechaCivilAIndice(formatearFechaSQL(fecha));
}

function extraerSegmentosTarifasConfiguracion(configuracionServicios) {
  const segmentos = [];

  if (!Array.isArray(configuracionServicios)) {
    return segmentos;
  }

  for (const servicio of configuracionServicios) {
    if (!servicio || !Array.isArray(servicio.regimenes)) {
      continue;
    }

    for (const regimen of servicio.regimenes) {
      if (!regimen || !Array.isArray(regimen.recursos)) {
        continue;
      }

      for (const recurso of regimen.recursos) {
        if (!recurso || !Array.isArray(recurso.fechas)) {
          continue;
        }

        const recursoId = normalizarIdPositivo(recurso.id ?? recurso.recurso_id ?? recurso.recursoId);
        const servicioId = normalizarIdPositivo(servicio.id ?? servicio.servicio_id ?? servicio.servicioId);
        const regimenId = normalizarIdPositivo(regimen.id ?? regimen.regimen_id ?? regimen.regimenId);

        for (let indiceFecha = 0; indiceFecha < recurso.fechas.length; indiceFecha++) {
          const fecha = recurso.fechas[indiceFecha];
          segmentos.push({
            servicioId,
            regimenId,
            recursoId,
            fechaInicio: formatearFechaSQL(fecha?.fecha_inicio),
            fechaFin: formatearFechaSQL(fecha?.fecha_fin),
            indiceFecha: indiceFecha + 1,
          });
        }
      }
    }
  }

  return segmentos;
}

function validarCoberturaTarifasBloque(configuracionServicios, {
  fechaInicio,
  fechaFin,
  recursosIds,
}) {
  const bloqueInicio = fechaSqlAIndice(fechaInicio);
  const bloqueFin = fechaSqlAIndice(fechaFin);

  if (bloqueInicio === null || bloqueFin === null || bloqueInicio > bloqueFin) {
    return "El bloque debe tener fechas validas";
  }

  const recursosRequeridos = new Set((recursosIds || []).map(Number));
  const segmentos = extraerSegmentosTarifasConfiguracion(configuracionServicios);
  const segmentosPorRecurso = new Map();

  for (const segmento of segmentos) {
    if (!segmento.recursoId || !recursosRequeridos.has(Number(segmento.recursoId))) {
      return "Las tarifas del bloque deben corresponder solo a los recursos seleccionados";
    }

    const inicio = fechaSqlAIndice(segmento.fechaInicio);
    const fin = fechaSqlAIndice(segmento.fechaFin);

    if (inicio === null || fin === null || fin < inicio) {
      return `El recurso ${segmento.recursoId} tiene un rango de tarifa invalido`;
    }

    if (inicio < bloqueInicio || fin > bloqueFin) {
      return `El recurso ${segmento.recursoId} tiene tarifas fuera del rango del bloque`;
    }

    if (!segmentosPorRecurso.has(Number(segmento.recursoId))) {
      segmentosPorRecurso.set(Number(segmento.recursoId), []);
    }

    segmentosPorRecurso.get(Number(segmento.recursoId)).push({
      ...segmento,
      inicio,
      fin,
    });
  }

  for (const recursoId of recursosRequeridos) {
    const rangos = segmentosPorRecurso.get(Number(recursoId)) || [];
    if (rangos.length === 0) {
      return `Debe cargar tarifas para el recurso ${recursoId}`;
    }

    rangos.sort((a, b) => a.inicio - b.inicio);

    let cursor = bloqueInicio;
    let finAnterior = null;

    for (const rango of rangos) {
      if (finAnterior !== null && rango.inicio <= finAnterior) {
        return `El recurso ${recursoId} tiene rangos de tarifa solapados dentro del bloque`;
      }

      if (rango.inicio > cursor) {
        return `El recurso ${recursoId} no tiene tarifas para todo el rango del bloque`;
      }

      cursor = Math.max(cursor, rango.fin + 1);
      finAnterior = rango.fin;
    }

    if (cursor <= bloqueFin) {
      return `El recurso ${recursoId} no tiene tarifas para todo el rango del bloque`;
    }
  }

  return null;
}

async function validarSolapamientoTarifasExistentes(connection, {
  configuracionServicios,
  excludeTemporadaTarifaId = null,
  origenes = [],
}) {
  const segmentos = extraerSegmentosTarifasConfiguracion(configuracionServicios)
    .filter((segmento) => segmento.recursoId && segmento.fechaInicio && segmento.fechaFin);

  if (segmentos.length === 0) {
    return;
  }

  const recursoIds = Array.from(new Set(segmentos.map((segmento) => Number(segmento.recursoId))));
  const minFechaInicio = segmentos.reduce((min, segmento) =>
    !min || segmento.fechaInicio < min ? segmento.fechaInicio : min,
  null);
  const maxFechaFin = segmentos.reduce((max, segmento) =>
    !max || segmento.fechaFin > max ? segmento.fechaFin : max,
  null);

  const placeholdersRecursos = recursoIds.map(() => "?").join(",");
  const params = [...recursoIds, maxFechaFin, minFechaInicio];
  let filtroExclude = "";
  let filtroOrigen = "";

  if (excludeTemporadaTarifaId) {
    filtroExclude = "AND t.temporada_tarifa_id <> ?";
    params.push(excludeTemporadaTarifaId);
  }

  if (Array.isArray(origenes) && origenes.length > 0) {
    filtroOrigen = `AND COALESCE(tt.origen, 'GENERAL') IN (${origenes.map(() => "?").join(",")})`;
    params.push(...origenes);
  }

  const [tarifasExistentes] = await connection.query(
    `
      SELECT
        t.recurso_id,
        DATE_FORMAT(t.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
        DATE_FORMAT(t.fecha_fin, '%Y-%m-%d') AS fecha_fin,
        tt.id AS temporada_tarifa_id,
        tt.nombre AS temporada_nombre,
        COALESCE(tt.origen, 'GENERAL') AS origen,
        r.nombre AS recurso_nombre
      FROM tarifa t
      INNER JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
      INNER JOIN recurso r ON r.id = t.recurso_id
      WHERE t.recurso_id IN (${placeholdersRecursos})
        AND t.fecha_inicio <= ?
        AND t.fecha_fin >= ?
        AND (
          COALESCE(tt.origen, 'GENERAL') <> 'BLOQUE'
          OR EXISTS (
            SELECT 1
            FROM bloque_fecha bf_vigente
            WHERE bf_vigente.temporada_tarifa_id = tt.id
              AND bf_vigente.estado = 'ACTIVO'
          )
        )
        ${filtroExclude}
        ${filtroOrigen}
    `,
    params
  );

  for (const existente of tarifasExistentes) {
    const segmentoSolapado = segmentos.find((segmento) =>
      Number(segmento.recursoId) === Number(existente.recurso_id) &&
      rangosSolapanInclusivo(segmento.fechaInicio, segmento.fechaFin, existente.fecha_inicio, existente.fecha_fin)
    );

    if (!segmentoSolapado) {
      continue;
    }

    const tipoTemporada = existente.origen === "BLOQUE" ? "temporada alta" : "temporada baja";
    throw crearErrorNegocio(
      `El recurso "${existente.recurso_nombre}" ya tiene precios cargados para esas fechas en ${tipoTemporada} (${existente.temporada_nombre}).`,
      409,
      "TARIFA_RECURSO_SOLAPADA"
    );
  }
}

async function ejecutarMantenimientoBloquesAlta(connection) {
  try {
    await connection.query(
      `
        UPDATE bloque_fecha_recurso bfr
        INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
        SET bfr.estado = 'DISPONIBLE', bfr.reserva_id = NULL
        WHERE bf.estado = 'LIBERADO'
          AND bf.modalidad = 'BLOQUE'
          AND bf.fecha_inicio <= CURDATE()
          AND bf.fecha_fin > CURDATE()
          AND bfr.estado = 'LIBERADO'
          AND NOT EXISTS (
            SELECT 1
            FROM reserva r
            WHERE r.bloque_fecha_id = bf.id
              AND r.recurso_id = bfr.recurso_id
              AND COALESCE(r.estado_reserva_id, ?) <> ?
          )
      `,
      [ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );

    await connection.query(
      `
        UPDATE bloque_fecha bf
        SET bf.estado = 'ACTIVO'
        WHERE bf.estado = 'LIBERADO'
          AND bf.modalidad = 'BLOQUE'
          AND bf.fecha_inicio <= CURDATE()
          AND bf.fecha_fin > CURDATE()
          AND EXISTS (
            SELECT 1
            FROM bloque_fecha_recurso bfr
            WHERE bfr.bloque_fecha_id = bf.id
              AND bfr.estado IN ('DISPONIBLE', 'VENTA_DIRECTA')
          )
      `
    );

    await connection.query(
      `
        UPDATE bloque_fecha_recurso bfr
        INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
        SET bfr.estado = 'LIBERADO', bfr.reserva_id = NULL
        WHERE bf.estado = 'ACTIVO'
          AND bf.fecha_fin <= CURDATE()
          AND bfr.estado IN ('DISPONIBLE', 'SORTEO', 'VENTA_DIRECTA')
          AND NOT EXISTS (
            SELECT 1
            FROM reserva r
            WHERE r.bloque_fecha_id = bf.id
              AND r.recurso_id = bfr.recurso_id
              AND COALESCE(r.estado_reserva_id, ?) <> ?
          )
      `,
      [ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );

    await connection.query(
      `
        UPDATE bloque_fecha bf
        SET bf.estado = 'LIBERADO'
        WHERE bf.estado = 'ACTIVO'
          AND bf.fecha_fin <= CURDATE()
          AND NOT EXISTS (
            SELECT 1
            FROM bloque_fecha_recurso bfr
            WHERE bfr.bloque_fecha_id = bf.id
              AND bfr.estado IN ('DISPONIBLE', 'SORTEO', 'VENTA_DIRECTA')
          )
      `
    );
  } catch (error) {
    if (!esErrorTemporadaAltaNoMigrada(error)) {
      console.error("Error ejecutando mantenimiento de bloques:", error);
    }
  }
}

async function obtenerEstadoReservaId(connection, nombre, fallbackId = ESTADO_RESERVA_INICIADA_ID) {
  const [rows] = await connection.query(
    "SELECT id FROM estado_reserva WHERE nombre = ? LIMIT 1",
    [nombre]
  );

  return rows.length > 0 ? Number(rows[0].id) : fallbackId;
}

async function obtenerInscripcionSorteoActiva(connection, usuarioId, { forUpdate = false } = {}) {
  const usuarioIdNormalizado = normalizarIdPositivo(usuarioId);
  if (!usuarioIdNormalizado) {
    return null;
  }

  const lockSql = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `
      SELECT
        r.id,
        r.sorteo_id,
        s.nombre AS sorteo_nombre,
        r.bloque_fecha_id,
        bf.nombre AS bloque_nombre,
        r.servicio_id,
        srv.nombre AS servicio_nombre,
        srv.lugar,
        r.fecha_inicio,
        r.fecha_fin,
        r.fecha_creacion,
        r.estado_reserva_id,
        er.nombre AS estado
      FROM reserva r
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      LEFT JOIN sorteo s ON s.id = r.sorteo_id
      LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
      LEFT JOIN servicio srv ON srv.id = r.servicio_id
      WHERE r.usuario_id = ?
        AND r.modalidad = 'SORTEO'
        AND r.recurso_id IS NULL
        AND COALESCE(r.estado_reserva_id, ?) <> ?
        AND COALESCE(er.nombre, '') NOT IN ('Adjudicada', 'No adjudicada', 'Cancelada', 'Rechazada')
      ORDER BY r.fecha_creacion DESC, r.id DESC
      LIMIT 1${lockSql}
    `,
    [usuarioIdNormalizado, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: Number(row.id),
    sorteo_id: row.sorteo_id ? Number(row.sorteo_id) : null,
    sorteo_nombre: row.sorteo_nombre || null,
    bloque_fecha_id: row.bloque_fecha_id ? Number(row.bloque_fecha_id) : null,
    bloque_nombre: row.bloque_nombre || null,
    servicio_id: row.servicio_id ? Number(row.servicio_id) : null,
    servicio_nombre: row.servicio_nombre || null,
    lugar: row.lugar || null,
    fecha_inicio: formatearFechaSQL(row.fecha_inicio),
    fecha_fin: formatearFechaSQL(row.fecha_fin),
    fecha_creacion: row.fecha_creacion,
    estado_reserva_id: row.estado_reserva_id ? Number(row.estado_reserva_id) : null,
    estado: row.estado || null
  };
}

function normalizarPersonasParaCotizacion(personas, regimenId, fechaInicio) {
  if (!Array.isArray(personas) || personas.length === 0) {
    throw crearErrorNegocio("Debe indicar al menos una persona", 400);
  }

  return personas.map((persona, indice) => {
    const tieneFechaNacimiento = persona?.fecha_nacimiento !== undefined || persona?.fechaNacimiento !== undefined;
    const fechaNacimiento = persona?.fecha_nacimiento ?? persona?.fechaNacimiento;
    const edad = tieneFechaNacimiento
      ? calcularEdadEnFecha(formatearFechaSQL(fechaNacimiento), fechaInicio)
      : Number(persona?.edad);

    if (!Number.isInteger(edad) || edad < 0 || edad > 130) {
      throw crearErrorNegocio(`La edad de personas[${indice}] no es valida para la fecha de ingreso`, 400);
    }

    return {
      ...persona,
      tipo_persona_id: normalizarIdPositivo(persona?.tipo_persona_id ?? persona?.tipo),
      // El regimen es una propiedad de la reserva; nunca se acepta uno distinto
      // por integrante porque produciria una reserva internamente contradictoria.
      regimen_id: normalizarIdPositivo(regimenId),
      edad,
    };
  });
}

async function calcularTarifaBaseReserva(connection, { recursoId, regimenId, personas, fechaInicio, fechaFin, temporadaTarifaId = null }) {
  const fechaInicioNormalizada = formatearFechaSQL(fechaInicio);
  const fechaFinNormalizada = formatearFechaSQL(fechaFin);
  const noches = obtenerNochesReserva(fechaInicioNormalizada, fechaFinNormalizada);
  if (noches.length === 0) {
    throw crearErrorNegocio("El rango de fechas no es valido", 400);
  }

  const recursoIdNormalizado = normalizarIdPositivo(recursoId);
  const regimenIdNormalizado = normalizarIdPositivo(regimenId);
  if (!recursoIdNormalizado || !regimenIdNormalizado) {
    throw crearErrorNegocio("El recurso y el regimen son requeridos", 400);
  }

  const personasNormalizadas = normalizarPersonasParaCotizacion(
    personas,
    regimenIdNormalizado,
    fechaInicioNormalizada
  );
  let totalCentavos = 0;
  let totalOriginalCentavos = 0;
  const personasResultado = [];
  const ultimaNoche = noches[noches.length - 1];

  for (const persona of personasNormalizadas) {
    if (!persona.tipo_persona_id || !persona.regimen_id) {
      throw crearErrorNegocio("Los datos de las personas no son validos", 400);
    }

    const filtroTemporada = temporadaTarifaId
      ? "AND temporada_tarifa_id = ?"
      : `AND (temporada_tarifa_id IS NULL OR temporada_tarifa_id IN (
           SELECT id FROM temporada_tarifa WHERE COALESCE(origen, 'GENERAL') = 'GENERAL'
         ))`;
    const [tarifasPersona] = await connection.query(
      `
        SELECT id, precio, fecha_inicio, fecha_fin, usa_porcentaje, porcentaje_descuento
        FROM tarifa
        WHERE recurso_id = ?
          AND tipo_persona_id = ?
          AND regimen_id = ?
          AND (edad_minima IS NULL OR edad_minima <= ?)
          AND (edad_maxima IS NULL OR edad_maxima >= ?)
          AND fecha_inicio <= ?
          AND fecha_fin >= ?
          ${filtroTemporada}
        ORDER BY fecha_inicio ASC
      `,
      [
        recursoIdNormalizado,
        persona.tipo_persona_id,
        persona.regimen_id,
        persona.edad,
        persona.edad,
        ultimaNoche,
        fechaInicioNormalizada,
        ...(temporadaTarifaId ? [temporadaTarifaId] : [])
      ]
    );

    if (tarifasPersona.length === 0) {
      throw crearErrorNegocio("No hay tarifas para todas las personas del bloque", 409, "TARIFA_INCOMPLETA");
    }

    const tarifasPorFecha = [];
    let totalPersonaCentavos = 0;
    let totalOriginalPersonaCentavos = 0;

    for (const noche of noches) {
      const tarifasAplicables = tarifasPersona.filter((tarifa) => {
        const inicioTarifa = formatearFechaSQL(tarifa.fecha_inicio);
        const finTarifa = formatearFechaSQL(tarifa.fecha_fin);
        return inicioTarifa && finTarifa && inicioTarifa <= noche && finTarifa >= noche;
      });

      if (tarifasAplicables.length === 0) {
        throw crearErrorNegocio("No hay tarifas para todas las noches del bloque", 409, "TARIFA_INCOMPLETA");
      }
      if (tarifasAplicables.length > 1) {
        throw crearErrorNegocio(
          `Hay mas de una tarifa aplicable para la fecha ${noche}`,
          409,
          "TARIFA_AMBIGUA"
        );
      }

      const tarifa = tarifasAplicables[0];
      const precioCentavos = decimalACentavos(tarifa.precio);
      if (precioCentavos === null) {
        throw crearErrorNegocio(`La tarifa de la fecha ${noche} tiene un importe invalido`, 409, "TARIFA_INVALIDA");
      }

      let precioOriginalCentavos = precioCentavos;
      const usaPorcentaje = tarifa.usa_porcentaje === 1 || tarifa.usa_porcentaje === true || tarifa.usa_porcentaje === "1";
      const porcentajePuntosBase = tarifa.porcentaje_descuento !== null && tarifa.porcentaje_descuento !== undefined
        ? decimalAPuntosBase(tarifa.porcentaje_descuento)
        : 0;

      if (usaPorcentaje) {
        if (porcentajePuntosBase === null || porcentajePuntosBase > 10000) {
          throw crearErrorNegocio(`La tarifa de la fecha ${noche} tiene un porcentaje invalido`, 409, "TARIFA_INVALIDA");
        }
        // Con bonificación total el precio de lista no puede reconstruirse por
        // división. El cobro canónico sí es inequívoco: cero centavos.
        precioOriginalCentavos = porcentajePuntosBase === 10000
          ? precioCentavos
          : revertirDescuentoEnPuntosBase(precioCentavos, porcentajePuntosBase);
      }

      totalPersonaCentavos = sumarCentavos(totalPersonaCentavos, precioCentavos);
      totalOriginalPersonaCentavos = sumarCentavos(totalOriginalPersonaCentavos, precioOriginalCentavos);
      if (totalPersonaCentavos === null || totalOriginalPersonaCentavos === null) {
        throw crearErrorNegocio("El total de la tarifa excede el maximo permitido", 409, "TARIFA_INVALIDA");
      }

      tarifasPorFecha.push({
        fecha: noche,
        precio: centavosANumero(precioCentavos),
        precio_original: centavosANumero(precioOriginalCentavos),
        tarifa_id: tarifa.id,
        usa_porcentaje: usaPorcentaje,
        porcentaje_descuento: porcentajePuntosBase / 100,
      });
    }

    totalCentavos = sumarCentavos(totalCentavos, totalPersonaCentavos);
    totalOriginalCentavos = sumarCentavos(totalOriginalCentavos, totalOriginalPersonaCentavos);
    if (totalCentavos === null || totalOriginalCentavos === null) {
      throw crearErrorNegocio("El total de la reserva excede el maximo permitido", 409, "TARIFA_INVALIDA");
    }

    personasResultado.push({
      ...persona,
      tarifa_individual: centavosANumero(totalPersonaCentavos),
      tarifa_original_individual: centavosANumero(totalOriginalPersonaCentavos),
      tarifas_por_fecha: tarifasPorFecha.sort((a, b) => a.fecha.localeCompare(b.fecha))
    });
  }

  return {
    total: centavosANumero(totalCentavos),
    total_original: centavosANumero(totalOriginalCentavos),
    personas: personasResultado
  };
}

async function insertarTarifasFamiliaresCalculadas(connection, reservasFamiliares) {
  for (const persona of reservasFamiliares) {
    const tarifas = Array.isArray(persona.tarifas_por_fecha) ? persona.tarifas_por_fecha : [];
    if (tarifas.length === 0) {
      throw crearErrorNegocio("No se pudo conservar el detalle de las tarifas aplicadas", 409, "TARIFA_INCOMPLETA");
    }
    for (const tarifa of tarifas) {
      const tarifaId = normalizarIdPositivo(tarifa.tarifa_id);
      const fecha = formatearFechaSQL(tarifa.fecha);
      if (!tarifaId || !fecha) {
        throw crearErrorNegocio("El detalle de tarifa calculado es invalido", 409, "TARIFA_INVALIDA");
      }
      await connection.query(
        `INSERT INTO reserva_familiar_tarifa (reserva_familiar_id, tarifa_id, fecha)
         VALUES (?, ?, ?)`,
        [persona.reserva_familiar_id, tarifaId, fecha]
      );
    }
  }
}

async function temporadaTieneReferenciasHistoricas(connection, temporadaTarifaId) {
  const [rows] = await connection.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM tarifa t
        INNER JOIN reserva_familiar_tarifa rft ON rft.tarifa_id = t.id
        WHERE t.temporada_tarifa_id = ?
        UNION ALL
        SELECT 1
        FROM tarifa t
        INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_id = t.id
        WHERE t.temporada_tarifa_id = ?
        UNION ALL
        SELECT 1
        FROM tarifa_adicional ta
        INNER JOIN reserva_adicional_detalle rad ON rad.tarifa_adicional_id = ta.id
        WHERE ta.temporada_tarifa_id = ?
      ) AS tiene_referencias
    `,
    [temporadaTarifaId, temporadaTarifaId, temporadaTarifaId]
  );
  return Number(rows[0]?.tiene_referencias) === 1;
}

async function insertarTarifasFamiliaresReserva(connection, reservasFamiliaresIds, recursoId, regimenId, fechaInicio, fechaFin, temporadaTarifaId = null) {
  const noches = obtenerNochesReserva(formatearFechaSQL(fechaInicio), formatearFechaSQL(fechaFin));
  if (noches.length === 0) {
    throw crearErrorNegocio("El rango de la reserva no es valido", 400);
  }

  for (const reservaFamiliar of reservasFamiliaresIds) {
    for (const fechaString of noches) {

      const filtroTemporada = temporadaTarifaId ? "AND temporada_tarifa_id = ?" : "";
      const [tarifas] = await connection.query(
        `SELECT id
         FROM tarifa
         WHERE recurso_id = ?
           AND tipo_persona_id = ?
           AND regimen_id = ?
           AND (edad_minima IS NULL OR edad_minima <= ?)
           AND (edad_maxima IS NULL OR edad_maxima >= ?)
           AND fecha_inicio <= ?
           AND fecha_fin >= ?
           ${filtroTemporada}
         ORDER BY fecha_inicio ASC`,
        [
          recursoId,
          reservaFamiliar.tipo_persona_id,
          regimenId,
          reservaFamiliar.edad,
          reservaFamiliar.edad,
          fechaString,
          fechaString,
          ...(temporadaTarifaId ? [temporadaTarifaId] : [])
        ]
      );

      if (tarifas.length !== 1) {
        throw crearErrorNegocio(
          tarifas.length === 0
            ? `No hay tarifa aplicable para la fecha ${fechaString}`
            : `Hay mas de una tarifa aplicable para la fecha ${fechaString}`,
          409,
          tarifas.length === 0 ? "TARIFA_INCOMPLETA" : "TARIFA_AMBIGUA"
        );
      }
      await connection.query(
        `INSERT INTO reserva_familiar_tarifa
          (reserva_familiar_id, tarifa_id, fecha)
         VALUES (?, ?, ?)`,
        [reservaFamiliar.reserva_familiar_id, tarifas[0].id, fechaString]
      );
    }
  }
}

async function obtenerDatosFamiliaUsuario(connection, usuarioId) {
  const [usuarioCreador] = await connection.query(
    "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
    [usuarioId]
  );

  let usuarioFamiliarPrincipalId = usuarioId;
  let departamentalId = usuarioCreador[0]?.departamental_id || null;

  if (usuarioCreador.length > 0) {
    let currentUserId = usuarioCreador[0].id;
    let currentUserFamiliarId = usuarioCreador[0].usuario_familiar_id;
    let currentDepartamentalId = usuarioCreador[0].departamental_id;
    const usuariosVisitados = new Set([Number(currentUserId)]);

    while (currentUserFamiliarId !== null) {
      const siguienteId = Number(currentUserFamiliarId);
      if (!Number.isInteger(siguienteId) || usuariosVisitados.has(siguienteId)) {
        throw crearErrorNegocio("La jerarquia familiar contiene un ciclo o una referencia invalida", 409, "JERARQUIA_FAMILIAR_INVALIDA");
      }
      usuariosVisitados.add(siguienteId);
      const [nextUser] = await connection.query(
        "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
        [currentUserFamiliarId]
      );

      if (nextUser.length === 0) {
        break;
      }

      currentUserId = nextUser[0].id;
      currentUserFamiliarId = nextUser[0].usuario_familiar_id;
      currentDepartamentalId = nextUser[0].departamental_id;
    }

    usuarioFamiliarPrincipalId = currentUserId;
    departamentalId = currentDepartamentalId;
  }

  return { usuarioFamiliarPrincipalId, departamentalId };
}

async function obtenerOCrearUsuariosPersonasReserva(connection, personas, cabecera, req) {
  const { usuarioFamiliarPrincipalId, departamentalId } = await obtenerDatosFamiliaUsuario(connection, cabecera.id);
  const usuariosIds = [];

  for (const persona of personas) {
    const documento = persona.dni ?? persona.documento;
    const [existeUsuario] = await connection.query(
      "SELECT id FROM usuario WHERE documento = ?",
      [documento]
    );

    let usuarioId;
    if (existeUsuario.length > 0) {
      usuarioId = existeUsuario[0].id;
    } else {
      const rolId = Number(persona.tipo_persona_id) === 1 ? 2 : 4;
      const [nuevoUsuario] = await connection.query(
        `INSERT INTO usuario (
          rol_id, parentesco_id, tipo_persona_id, nombre, apellido, fecha_nacimiento,
          documento, telefono, email, password, usuario_familiar_id, es_familiar, departamental_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          rolId,
          persona.parentesco_id,
          persona.tipo_persona_id,
          persona.nombre,
          persona.apellido,
          persona.fecha_nacimiento,
          documento,
          persona.telefono || null,
          persona.email || null,
          usuarioFamiliarPrincipalId,
          esFamiliarPorParentesco(persona.parentesco_id),
          departamentalId
        ]
      );
      usuarioId = nuevoUsuario.insertId;

      await registrarHistorial(
        connection,
        usuarioId,
        "CREATE",
        "usuario",
        cabecera.id,
        req,
        null,
        `Usuario creado durante inscripcion/reserva. Datos: ${persona.nombre} ${persona.apellido}, DNI: ${documento}`
      );
    }

    usuariosIds.push({
      ...persona,
      dni: documento,
      usuario_id: usuarioId
    });
  }

  return usuariosIds;
}

async function obtenerBloqueConRecursos(connection, bloqueFechaId, { forUpdate = false } = {}) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [bloqueRows] = await connection.query(
    `
      SELECT
        bf.id,
        bf.sorteo_id,
        bf.servicio_id,
        bf.temporada_tarifa_id,
        bf.nombre,
        bf.modalidad,
        bf.fecha_inicio,
        bf.fecha_fin,
        bf.estado,
        s.nombre AS sorteo_nombre,
        s.estado AS sorteo_estado,
        s.fecha_inicio_inscripcion,
        s.fecha_fin_inscripcion
      FROM bloque_fecha bf
      LEFT JOIN sorteo s ON s.id = bf.sorteo_id
      WHERE bf.id = ?
      ${lock}
    `,
    [bloqueFechaId]
  );

  if (bloqueRows.length === 0) {
    throw crearErrorNegocio("Bloque no encontrado", 404);
  }

  const bloque = bloqueRows[0];
  const [recursos] = await connection.query(
    `
      SELECT bfr.id, bfr.recurso_id, bfr.estado, bfr.reserva_id, r.nombre AS recurso_nombre
      FROM bloque_fecha_recurso bfr
      INNER JOIN recurso r ON r.id = bfr.recurso_id
      WHERE bfr.bloque_fecha_id = ?
      ORDER BY r.nombre ASC
      ${lock}
    `,
    [bloqueFechaId]
  );

  bloque.recursos = recursos;
  return bloque;
}

function validarBloqueInscripcionAbierta(bloque) {
  if (bloque.estado !== "ACTIVO") {
    throw crearErrorNegocio("El bloque no esta activo", 409);
  }
  if (bloque.modalidad !== MODALIDAD_SORTEO) {
    throw crearErrorNegocio("El bloque indicado no corresponde a un sorteo", 400);
  }
  if (bloque.sorteo_estado !== "ACTIVO") {
    throw crearErrorNegocio("El sorteo no esta activo", 409);
  }

  const hoy = obtenerFechaCivilHoyArgentina();
  const inicio = formatearFechaSQL(bloque.fecha_inicio_inscripcion);
  const fin = formatearFechaSQL(bloque.fecha_fin_inscripcion);

  if (!inicio || !fin || inicio > fin || hoy < inicio || hoy > fin) {
    throw crearErrorNegocio("El periodo de inscripcion al sorteo no esta vigente", 409);
  }
  if (!validarRangoReservaTemporal(bloque.fecha_inicio, bloque.fecha_fin, { hoy }).valido) {
    throw crearErrorNegocio("El bloque del sorteo ya no admite cotizaciones ni inscripciones", 409);
  }
}

async function cotizarBloqueComun(connection, { bloque, regimenId, personas, adicionales = [] }) {
  const recursosElegibles = (bloque.recursos || []).filter((recurso) => {
    if (bloque.modalidad === MODALIDAD_SORTEO) {
      return ESTADOS_RECURSO_SORTEO_DISPONIBLES.has(recurso.estado);
    }
    return ESTADOS_RECURSO_BLOQUE_RESERVABLES.has(recurso.estado);
  });

  if (recursosElegibles.length === 0) {
    throw crearErrorNegocio("No hay recursos disponibles para este bloque", 409);
  }

  const cotizaciones = [];
  for (const recurso of recursosElegibles) {
    const tarifaBase = await calcularTarifaBaseReserva(connection, {
      recursoId: recurso.recurso_id,
      regimenId,
      personas,
      fechaInicio: formatearFechaSQL(bloque.fecha_inicio),
      fechaFin: formatearFechaSQL(bloque.fecha_fin),
      temporadaTarifaId: bloque.temporada_tarifa_id || null
    });

    const adicionalesProcesados = await calcularAdicionalesReserva(
      connection,
      adicionales,
      recurso.recurso_id,
      regimenId,
      formatearFechaSQL(bloque.fecha_inicio),
      formatearFechaSQL(bloque.fecha_fin),
      tarifaBase.personas,
      bloque.temporada_tarifa_id || null
    );
    const totalCentavos = sumarCentavos(
      decimalACentavos(tarifaBase.total),
      decimalACentavos(adicionalesProcesados.total)
    );
    if (totalCentavos === null) {
      throw crearErrorNegocio("El total calculado del bloque no es valido", 409, "TARIFA_INVALIDA");
    }

    cotizaciones.push({
      recurso,
      tarifaBase,
      adicionalesProcesados,
      total: centavosANumero(totalCentavos)
    });
  }

  const totalReferencia = Math.round(cotizaciones[0].total * 100);
  const recursoConDiferencia = cotizaciones.find((cotizacion) => Math.round(cotizacion.total * 100) !== totalReferencia);

  if (recursoConDiferencia) {
    throw crearErrorNegocio(
      "Los recursos del sorteo/bloque no tienen una tarifa comun para las personas indicadas",
      409,
      "TARIFA_COMUN_REQUERIDA"
    );
  }

  const referencia = cotizaciones[0];
  return {
    bloque_fecha_id: bloque.id,
    sorteo_id: bloque.sorteo_id,
    servicio_id: bloque.servicio_id,
    temporada_tarifa_id: bloque.temporada_tarifa_id || null,
    modalidad: bloque.modalidad,
    nombre_bloque: bloque.nombre,
    fecha_inicio: formatearFechaSQL(bloque.fecha_inicio),
    fecha_fin: formatearFechaSQL(bloque.fecha_fin),
    recurso_referencia_id: referencia.recurso.recurso_id,
    total_tarifa: referencia.tarifaBase.total,
    total_tarifa_original: referencia.tarifaBase.total_original,
    monto_adicionales: referencia.adicionalesProcesados.total,
    precio_total: referencia.total,
    personas: referencia.tarifaBase.personas,
    adicionales: referencia.adicionalesProcesados.items,
    recursos_disponibles: cotizaciones.map((cotizacion) => ({
      id: cotizacion.recurso.recurso_id,
      nombre: cotizacion.recurso.recurso_nombre,
      estado: cotizacion.recurso.estado
    }))
  };
}

async function obtenerBloquesActivosParaRecursos(connection, { recursoIds, fechaInicio, fechaFin }) {
  if (!Array.isArray(recursoIds) || recursoIds.length === 0) {
    return new Map();
  }

  try {
    await ejecutarMantenimientoBloquesAlta(connection);
    const placeholders = recursoIds.map(() => "?").join(",");
    const [rows] = await connection.query(
      `
        SELECT
          bfr.recurso_id,
          bfr.estado AS estado_recurso_bloque,
          bf.id AS bloque_fecha_id,
          bf.sorteo_id,
          bf.servicio_id,
          bf.temporada_tarifa_id,
          bf.nombre AS bloque_nombre,
          bf.modalidad,
          bf.fecha_inicio,
          bf.fecha_fin,
          bf.estado AS estado_bloque,
          s.nombre AS sorteo_nombre,
          s.estado AS sorteo_estado
        FROM bloque_fecha_recurso bfr
        INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
        LEFT JOIN sorteo s ON s.id = bf.sorteo_id
        WHERE bfr.recurso_id IN (${placeholders})
          AND bf.estado = 'ACTIVO'
          AND bfr.estado IN ('DISPONIBLE', 'SORTEO', 'VENTA_DIRECTA')
          AND bf.fecha_inicio < ?
          AND bf.fecha_fin > ?
        ORDER BY bf.fecha_inicio ASC, bf.id ASC
      `,
      [...recursoIds, fechaFin, fechaInicio]
    );

    const mapa = new Map();
    rows.forEach((row) => {
      const recursoId = Number(row.recurso_id);
      if (!mapa.has(recursoId)) {
        mapa.set(recursoId, []);
      }
      mapa.get(recursoId).push(row);
    });
    return mapa;
  } catch (error) {
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return new Map();
    }
    throw error;
  }
}

async function obtenerBloquesDisponiblesPorServicio(connection, {
  servicioIds = [],
  servicioId = null,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const ids = Number.isInteger(servicioId) && servicioId > 0
    ? [servicioId]
    : (Array.isArray(servicioIds) ? servicioIds.map(Number).filter((id) => Number.isInteger(id) && id > 0) : []);

  if (ids.length === 0 || !fechaInicio || !fechaFin) {
    return new Map();
  }

  try {
    await ejecutarMantenimientoBloquesAlta(connection);
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await connection.query(
      `
        SELECT
          bf.id,
          bf.servicio_id,
          bf.sorteo_id,
          bf.nombre,
          CASE
            WHEN bf.modalidad = 'SORTEO' AND bfr.estado = 'VENTA_DIRECTA' THEN 'BLOQUE'
            ELSE bf.modalidad
          END AS modalidad_visible,
          bf.modalidad AS modalidad_origen,
          bf.fecha_inicio,
          bf.fecha_fin,
          srv.nombre AS servicio_nombre,
          srv.lugar,
          s.nombre AS sorteo_nombre,
          s.estado AS sorteo_estado,
          COUNT(bfr.id) AS recursos_disponibles
        FROM bloque_fecha bf
        INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
        INNER JOIN servicio srv ON srv.id = bf.servicio_id
        LEFT JOIN sorteo s ON s.id = bf.sorteo_id
        WHERE bf.servicio_id IN (${placeholders})
          AND bf.estado = 'ACTIVO'
          AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA')
          AND bf.fecha_inicio < ?
          AND bf.fecha_fin > ?
          AND (
            bf.modalidad = 'BLOQUE'
            OR bfr.estado = 'VENTA_DIRECTA'
            OR (
              bf.modalidad = 'SORTEO'
              AND s.estado = 'ACTIVO'
              AND s.fecha_inicio_inscripcion <= CURDATE()
              AND s.fecha_fin_inscripcion >= CURDATE()
            )
          )
        GROUP BY bf.id, modalidad_visible, s.id
        HAVING recursos_disponibles > 0
        ORDER BY bf.fecha_inicio ASC, bf.id ASC
      `,
      [...ids, fechaFin, fechaInicio]
    );

    const holdsPorBloque = await contarHoldsActivosPorBloque(connection, {
      bloqueFechaIds: rows.map((row) => Number(row.id)),
      holdIdExcluir,
    });
    const mapa = new Map();
    rows.forEach((row) => {
      const recursosDisponibles = Math.max(
        Number(row.recursos_disponibles || 0) - Number(holdsPorBloque.get(Number(row.id)) || 0),
        0
      );
      if (recursosDisponibles <= 0) return;
      const servicioIdRow = Number(row.servicio_id);
      if (!mapa.has(servicioIdRow)) {
        mapa.set(servicioIdRow, []);
      }
      mapa.get(servicioIdRow).push({
        id: Number(row.id),
        nombre: row.nombre,
        modalidad: row.modalidad_visible,
        modalidad_origen: row.modalidad_origen,
        sorteo_id: row.sorteo_id ? Number(row.sorteo_id) : null,
        sorteo_nombre: row.sorteo_nombre || null,
        sorteo_estado: row.sorteo_estado || null,
        servicio_id: servicioIdRow,
        servicio_nombre: row.servicio_nombre || null,
        lugar: row.lugar || null,
        fecha_inicio: formatearFechaSQL(row.fecha_inicio),
        fecha_fin: formatearFechaSQL(row.fecha_fin),
        recursos_disponibles: recursosDisponibles
      });
    });
    return mapa;
  } catch (error) {
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return new Map();
    }
    throw error;
  }
}

function esServicioCamping(servicioId) {
  return Number(servicioId) === SERVICIO_CAMPING_ID;
}

function crearErrorReservaCamping(mensaje, statusCode = 422) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

function validarReglasCampingReserva(servicioId, recursoId, personas) {
  if (!esServicioCamping(servicioId)) {
    return null;
  }

  if (Number(recursoId) !== RECURSO_CAMPING_ID) {
    return "Recurso invalido para servicio Camping";
  }

  if (Array.isArray(personas) && personas.length > MAX_PERSONAS_CAMPING) {
    return "Camping permite un maximo de 6 personas";
  }

  return null;
}

async function bloquearYValidarDisponibilidadReserva(connection, {
  servicioId,
  recursoId,
  fechaInicio,
  fechaFin,
  reservaIdExcluir = null,
  holdIdExcluir = null,
  omitirValidacionHolds = false,
}) {
  const servicioIdNormalizado = normalizarIdPositivo(servicioId);
  const recursoIdNormalizado = normalizarIdPositivo(recursoId);
  const inicio = formatearFechaSQL(fechaInicio);
  const fin = formatearFechaSQL(fechaFin);
  if (!servicioIdNormalizado || !recursoIdNormalizado || !inicio || !fin || diferenciaDiasCivil(inicio, fin) <= 0) {
    throw crearErrorNegocio("Los datos de disponibilidad no son validos", 400);
  }

  // La fila del recurso serializa altas y ediciones concurrentes, incluso cuando
  // todavia no existe ninguna reserva que pueda bloquearse con FOR UPDATE.
  const [recursos] = await connection.query(
    "SELECT id FROM recurso WHERE id = ? AND servicio_id = ? FOR UPDATE",
    [recursoIdNormalizado, servicioIdNormalizado]
  );
  if (recursos.length === 0) {
    throw crearErrorNegocio("El recurso no pertenece al servicio indicado", 422);
  }

  if (esServicioCamping(servicioIdNormalizado)) {
    return;
  }

  if (!omitirValidacionHolds) {
    await asegurarSinHoldAjenoEnTransaccion(connection, {
      recursoId: recursoIdNormalizado,
      fechaInicio: inicio,
      fechaFin: fin,
      holdIdExcluir,
    });
  }

  const params = [recursoIdNormalizado, fin, inicio];
  let filtroReserva = "";
  const reservaExcluirNormalizada = normalizarIdPositivo(reservaIdExcluir);
  if (reservaExcluirNormalizada) {
    filtroReserva = "AND r.id <> ?";
    params.push(reservaExcluirNormalizada);
  }

  const [conflictos] = await connection.query(
    `SELECT r.id
     FROM reserva r
     LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
     WHERE r.recurso_id = ?
       AND r.fecha_inicio < ?
       AND r.fecha_fin > ?
       ${filtroReserva}
       AND COALESCE(er.nombre, '') NOT IN ('Cancelada', 'Rechazada', 'No adjudicada')
       AND COALESCE(r.estado_reserva_id, ?) <> ?
     LIMIT 1
     FOR UPDATE`,
    [...params, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
  );
  if (conflictos.length > 0) {
    throw crearErrorNegocio(
      "El recurso ya tiene una reserva para parte del rango seleccionado",
      409,
      "RECURSO_NO_DISPONIBLE"
    );
  }
}

async function reclamarRecursoBloque(connection, { bloqueFechaId, recursoId, reservaId }) {
  const [resultado] = await connection.query(
    `UPDATE bloque_fecha_recurso
     SET estado = 'RESERVADO', reserva_id = ?
     WHERE bloque_fecha_id = ?
       AND recurso_id = ?
       AND estado IN ('DISPONIBLE', 'VENTA_DIRECTA')
       AND reserva_id IS NULL`,
    [reservaId, bloqueFechaId, recursoId]
  );
  if (resultado.affectedRows !== 1) {
    throw crearErrorNegocio("El recurso del bloque acaba de ser reservado por otra solicitud", 409, "BLOQUE_NO_DISPONIBLE");
  }
}

async function liberarRecursoBloqueReserva(connection, reservaId) {
  const [recursos] = await connection.query(
    `SELECT bfr.bloque_fecha_id,
            bfr.recurso_id,
            bf.modalidad,
            bf.estado AS bloque_estado,
            s.estado AS sorteo_estado
     FROM bloque_fecha_recurso bfr
     INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
     LEFT JOIN sorteo s ON s.id = bf.sorteo_id
     WHERE bfr.reserva_id = ?
     FOR UPDATE`,
    [reservaId]
  );

  for (const recurso of recursos) {
    const estado = obtenerEstadoRecursoTrasLiberacion({
      modalidad: recurso.modalidad,
      estadoBloque: recurso.bloque_estado,
      estadoSorteo: recurso.sorteo_estado,
    });
    await connection.query(
      `UPDATE bloque_fecha_recurso
       SET estado = ?, reserva_id = NULL
       WHERE bloque_fecha_id = ?
         AND recurso_id = ?
         AND reserva_id = ?`,
      [estado, recurso.bloque_fecha_id, recurso.recurso_id, reservaId]
    );
  }
}

async function bloquearRecursoCamping(connection, recursoId) {
  const [recursoRows] = await connection.query(
    `SELECT id
     FROM recurso
     WHERE id = ? AND servicio_id = ?
     FOR UPDATE`,
    [recursoId, SERVICIO_CAMPING_ID]
  );

  if (recursoRows.length === 0) {
    throw crearErrorReservaCamping("Recurso invalido para servicio Camping", 422);
  }
}

async function obtenerMinimoParcelasDisponiblesCamping(connection, recursoId, noches) {
  let minParcelasDisponibles = null;

  for (const fecha of noches) {
    const [parcelasDiaRows] = await connection.query(
      `SELECT MIN(t.parcelas_disponibles) AS parcelas_disponibles
       FROM tarifa t
       INNER JOIN recurso r ON t.recurso_id = r.id
       WHERE t.recurso_id = ?
         AND r.servicio_id = ?
         AND t.fecha_inicio <= ?
         AND t.fecha_fin >= ?
         AND t.parcelas_disponibles IS NOT NULL`,
      [recursoId, SERVICIO_CAMPING_ID, fecha, fecha]
    );

    const parcelasDiaRaw = parcelasDiaRows?.[0]?.parcelas_disponibles;
    if (parcelasDiaRaw === null || parcelasDiaRaw === undefined) {
      return null;
    }

    const parcelasDia = Number(parcelasDiaRaw);
    if (!Number.isFinite(parcelasDia) || parcelasDia <= 0) {
      return 0;
    }

    if (minParcelasDisponibles === null || parcelasDia < minParcelasDisponibles) {
      minParcelasDisponibles = parcelasDia;
    }
  }

  return minParcelasDisponibles;
}

async function asignarNumeroParcelaCamping(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  reservaIdExcluir = null,
  holdIdExcluir = null,
}) {
  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  if (noches.length === 0) {
    throw crearErrorReservaCamping("El rango de fechas seleccionado no es valido", 422);
  }

  await bloquearRecursoCamping(connection, recursoId);

  const parcelasDisponibles = await obtenerMinimoParcelasDisponiblesCamping(connection, recursoId, noches);
  if (!Number.isInteger(parcelasDisponibles) || parcelasDisponibles <= 0) {
    throw crearErrorReservaCamping("No hay parcelas disponibles para el rango de fechas seleccionado", 409);
  }

  const params = [
    recursoId,
    fechaFin,
    fechaInicio,
    ESTADO_RESERVA_CANCELADA_ID
  ];

  let query = `
    SELECT id, numero_parcela
    FROM reserva
    WHERE recurso_id = ?
      AND numero_parcela IS NOT NULL
      AND fecha_inicio < ?
      AND fecha_fin > ?
      AND COALESCE(estado_reserva_id, 1) <> ?
  `;

  if (reservaIdExcluir !== null && reservaIdExcluir !== undefined) {
    query += " AND id <> ?";
    params.push(reservaIdExcluir);
  }

  query += " ORDER BY numero_parcela ASC FOR UPDATE";

  const [reservasSolapadas] = await connection.query(query, params);

  if (reservasSolapadas.length >= parcelasDisponibles) {
    throw crearErrorReservaCamping("No hay parcelas disponibles para el rango de fechas seleccionado", 409);
  }

  const parcelasOcupadas = new Set();
  for (const reserva of reservasSolapadas) {
    const numeroParcela = Number(reserva.numero_parcela);
    if (Number.isInteger(numeroParcela) && numeroParcela > 0 && numeroParcela <= parcelasDisponibles) {
      parcelasOcupadas.add(numeroParcela);
    }
  }
  const parcelasRetenidas = await obtenerNumerosParcelasRetenidas(connection, {
    recursoId,
    fechaInicio,
    fechaFin,
    holdIdExcluir,
    forUpdate: true,
  });
  parcelasRetenidas.forEach((numeroParcela) => {
    if (numeroParcela <= parcelasDisponibles) parcelasOcupadas.add(numeroParcela);
  });

  for (let numeroParcela = 1; numeroParcela <= parcelasDisponibles; numeroParcela++) {
    if (!parcelasOcupadas.has(numeroParcela)) {
      return numeroParcela;
    }
  }

  throw crearErrorReservaCamping("No hay parcelas disponibles para el rango de fechas seleccionado", 409);
}

async function validarNumeroParcelaCampingExistente(connection, { reservaId, recursoId, fechaInicio, fechaFin, numeroParcela }) {
  if (!Number.isInteger(Number(numeroParcela)) || Number(numeroParcela) <= 0) {
    throw crearErrorReservaCamping("No hay parcelas disponibles para el rango de fechas seleccionado", 409);
  }

  const noches = obtenerNochesReserva(fechaInicio, fechaFin);
  if (noches.length === 0) {
    throw crearErrorReservaCamping("El rango de fechas seleccionado no es valido", 422);
  }

  await bloquearRecursoCamping(connection, recursoId);

  const parcelasDisponibles = await obtenerMinimoParcelasDisponiblesCamping(connection, recursoId, noches);
  if (!Number.isInteger(parcelasDisponibles) || parcelasDisponibles <= 0 || Number(numeroParcela) > parcelasDisponibles) {
    throw crearErrorReservaCamping("No hay parcelas disponibles para el rango de fechas seleccionado", 409);
  }

  const [conflictosParcela] = await connection.query(
    `SELECT id
     FROM reserva
     WHERE id <> ?
       AND recurso_id = ?
       AND numero_parcela = ?
       AND fecha_inicio < ?
       AND fecha_fin > ?
       AND COALESCE(estado_reserva_id, 1) <> ?
     FOR UPDATE`,
    [
      reservaId,
      recursoId,
      Number(numeroParcela),
      fechaFin,
      fechaInicio,
      ESTADO_RESERVA_CANCELADA_ID
    ]
  );

  if (conflictosParcela.length > 0) {
    throw crearErrorReservaCamping("No hay parcelas disponibles para el rango de fechas seleccionado", 409);
  }
}

async function obtenerPrecioAdicional(db, cache, recursoId, regimenId, adicionalId, fecha, temporadaTarifaId = null) {
  const cacheKey = `${recursoId}-${regimenId}-${adicionalId}-${fecha}-${temporadaTarifaId || "any"}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const filtroTemporada = temporadaTarifaId
    ? "AND temporada_tarifa_id = ?"
    : `AND (temporada_tarifa_id IS NULL OR temporada_tarifa_id IN (
         SELECT id FROM temporada_tarifa WHERE COALESCE(origen, 'GENERAL') = 'GENERAL'
       ))`;
  const [rows] = await db.query(
    `
      SELECT id as tarifa_adicional_id, precio
      FROM tarifa_adicional
      WHERE recurso_id = ?
        AND regimen_id = ?
        AND adicional_id = ?
        AND fecha_inicio <= ?
        AND fecha_fin >= ?
        AND activo = 1
        ${filtroTemporada}
      ORDER BY fecha_inicio DESC
    `,
    [recursoId, regimenId, adicionalId, fecha, fecha, ...(temporadaTarifaId ? [temporadaTarifaId] : [])]
  );

  if (rows.length > 1) {
    throw crearErrorNegocio(`Hay mas de una tarifa de adicional aplicable para la fecha ${fecha}`, 409, "TARIFA_AMBIGUA");
  }
  const resultado = rows.length > 0 ? {
    precio: Number(rows[0].precio), 
    tarifa_adicional_id: rows[0].tarifa_adicional_id 
  } : null;
  
  cache.set(cacheKey, resultado);
  return resultado;
}

async function obtenerNombreAdicional(connection, cache, adicionalId) {
  if (cache.has(adicionalId)) {
    return cache.get(adicionalId);
  }

  const [rows] = await connection.query(
    "SELECT nombre FROM adicional WHERE id = ? LIMIT 1",
    [adicionalId]
  );

  const nombre = rows.length > 0 ? rows[0].nombre : "Adicional";
  cache.set(adicionalId, nombre);
  return nombre;
}

async function obtenerMejorDescuentoDia(connection, recursoId, regimenId, personas, fecha, temporadaTarifaId = null) {
  let maxDescuentoPuntosBase = 0;
  let tarifaIdMax = null;

  for (const persona of personas) {
    if (!persona.tipo_persona_id || persona.edad === undefined) continue;

    const filtroTemporada = temporadaTarifaId
      ? "AND temporada_tarifa_id = ?"
      : `AND (temporada_tarifa_id IS NULL OR temporada_tarifa_id IN (
           SELECT id FROM temporada_tarifa WHERE COALESCE(origen, 'GENERAL') = 'GENERAL'
         ))`;
    const [rows] = await connection.query(
      `SELECT id, usa_porcentaje, porcentaje_descuento
       FROM tarifa 
       WHERE recurso_id = ? 
         AND tipo_persona_id = ? 
         AND regimen_id = ?
         AND (edad_minima IS NULL OR edad_minima <= ?)
         AND (edad_maxima IS NULL OR edad_maxima >= ?)
         AND fecha_inicio <= ?
         AND fecha_fin >= ?
         ${filtroTemporada}
       ORDER BY fecha_inicio ASC`,
      [
        recursoId,
        persona.tipo_persona_id,
        regimenId,
        persona.edad,
        persona.edad,
        fecha,
        fecha,
        ...(temporadaTarifaId ? [temporadaTarifaId] : [])
      ]
    );

    if (rows.length > 1) {
      throw crearErrorNegocio(`Hay mas de una tarifa aplicable para la fecha ${fecha}`, 409, "TARIFA_AMBIGUA");
    }
    if (rows.length > 0) {
      const tarifa = rows[0];
      const usaPorcentaje = tarifa.usa_porcentaje === 1 || tarifa.usa_porcentaje === true || tarifa.usa_porcentaje === "1";
      const puntosBase = decimalAPuntosBase(tarifa.porcentaje_descuento ?? 0);
      if (usaPorcentaje && puntosBase === null) {
        throw crearErrorNegocio(`La tarifa de la fecha ${fecha} tiene un porcentaje invalido`, 409, "TARIFA_INVALIDA");
      }
      if (usaPorcentaje && puntosBase > maxDescuentoPuntosBase) {
        maxDescuentoPuntosBase = puntosBase;
        tarifaIdMax = tarifa.id;
      }
    }
  }
  
  return {
    porcentaje_descuento: maxDescuentoPuntosBase / 100,
    porcentaje_puntos_base: maxDescuentoPuntosBase,
    tarifa_id: tarifaIdMax,
  };
}

async function calcularAdicionalesReserva(connection, adicionales, recursoId, regimenId, fechaInicio, fechaFin, personas, temporadaTarifaId = null) {
  if (!Array.isArray(adicionales) || adicionales.length === 0) {
    return { total: 0, items: [] };
  }

  const fechaInicioNormalizada = formatearFechaSQL(fechaInicio);
  const fechaFinNormalizada = formatearFechaSQL(fechaFin);
  const noches = obtenerNochesReserva(fechaInicioNormalizada, fechaFinNormalizada);
  if (noches.length === 0) {
    throw crearErrorNegocio("El rango de fechas no es valido", 400);
  }

  const personasNormalizadas = normalizarPersonasParaCotizacion(personas, regimenId, fechaInicioNormalizada);
  const cachePrecios = new Map();
  const cacheNombres = new Map();
  const descuentosPorDia = new Map();
  const items = [];
  let totalCentavos = 0;

  for (const noche of noches) {
    descuentosPorDia.set(
      noche,
      await obtenerMejorDescuentoDia(
        connection,
        recursoId,
        regimenId,
        personasNormalizadas,
        noche,
        temporadaTarifaId
      )
    );
  }

  for (let indice = 0; indice < adicionales.length; indice++) {
    const adicional = adicionales[indice];
    const adicionalId = normalizarIdPositivo(adicional?.adicional_id ?? adicional?.adicionalId);
    const cantidad = normalizarEnteroNoNegativoOpcional(adicional?.cantidad, 10_000);
    if (!adicionalId || !cantidad) {
      throw crearErrorNegocio(`adicionales[${indice}] debe tener id y cantidad entera positiva`, 400);
    }

    const detalles = [];
    let subtotalCentavos = 0;
    let subtotalOriginalCentavos = 0;

    for (const noche of noches) {
      const resultadoAdicional = await obtenerPrecioAdicional(
        connection,
        cachePrecios,
        recursoId,
        regimenId,
        adicionalId,
        noche,
        temporadaTarifaId
      );
      if (resultadoAdicional === null) {
        throw crearErrorNegocio(
          `No hay una tarifa de adicional vigente para la fecha ${noche}`,
          409,
          "TARIFA_ADICIONAL_INCOMPLETA"
        );
      }

      const precioOriginalCentavos = decimalACentavos(resultadoAdicional.precio);
      if (precioOriginalCentavos === null) {
        throw crearErrorNegocio(
          `La tarifa adicional de la fecha ${noche} tiene un importe invalido`,
          409,
          "TARIFA_ADICIONAL_INVALIDA"
        );
      }

      const descuentoInfo = descuentosPorDia.get(noche) || {
        porcentaje_descuento: 0,
        porcentaje_puntos_base: 0,
        tarifa_id: null,
      };
      const precioUnitarioCentavos = aplicarDescuentoEnPuntosBase(
        precioOriginalCentavos,
        descuentoInfo.porcentaje_puntos_base || 0
      );
      const subtotalDiaCentavos = precioUnitarioCentavos * cantidad;
      const subtotalOriginalDiaCentavos = precioOriginalCentavos * cantidad;
      if (!Number.isSafeInteger(subtotalDiaCentavos) || !Number.isSafeInteger(subtotalOriginalDiaCentavos)) {
        throw crearErrorNegocio("El subtotal del adicional excede el maximo permitido", 409, "TARIFA_ADICIONAL_INVALIDA");
      }

      subtotalCentavos = sumarCentavos(subtotalCentavos, subtotalDiaCentavos);
      subtotalOriginalCentavos = sumarCentavos(subtotalOriginalCentavos, subtotalOriginalDiaCentavos);
      if (subtotalCentavos === null || subtotalOriginalCentavos === null) {
        throw crearErrorNegocio("El total del adicional excede el maximo permitido", 409, "TARIFA_ADICIONAL_INVALIDA");
      }

      detalles.push({
        fecha: noche,
        cantidad,
        precio_unitario: centavosANumero(precioUnitarioCentavos),
        precio_unitario_original: centavosANumero(precioOriginalCentavos),
        subtotal: centavosANumero(subtotalDiaCentavos),
        subtotal_original: centavosANumero(subtotalOriginalDiaCentavos),
        tarifa_adicional_id: resultadoAdicional.tarifa_adicional_id,
        porcentaje_descuento: descuentoInfo.porcentaje_descuento,
        tarifa_id: descuentoInfo.tarifa_id,
      });
    }

    items.push({
      adicional_id: adicionalId,
      nombre_adicional: await obtenerNombreAdicional(connection, cacheNombres, adicionalId),
      cantidad,
      dias: detalles.length,
      precio_referencia: detalles[0]?.precio_unitario || 0,
      subtotal: centavosANumero(subtotalCentavos),
      subtotal_original: centavosANumero(subtotalOriginalCentavos),
      detalles,
    });

    totalCentavos = sumarCentavos(totalCentavos, subtotalCentavos);
    if (totalCentavos === null) {
      throw crearErrorNegocio("El total de adicionales excede el maximo permitido", 409, "TARIFA_ADICIONAL_INVALIDA");
    }
  }

  return { total: centavosANumero(totalCentavos), items };
}

async function guardarAdicionalesReserva(connection, reservaId, adicionalesProcesados) {
  if (!Array.isArray(adicionalesProcesados) || adicionalesProcesados.length === 0) {
    return;
  }

  for (const adicional of adicionalesProcesados) {
    const [resultado] = await connection.query(
      `INSERT INTO reserva_adicional
        (reserva_id, adicional_id, nombre_adicional, cantidad, dias, subtotal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        reservaId,
        adicional.adicional_id,
        adicional.nombre_adicional,
        adicional.cantidad,
        adicional.dias,
        adicional.subtotal
      ]
    );

    const reservaAdicionalId = resultado.insertId;
    for (const detalle of adicional.detalles) {
      await connection.query(
        `INSERT INTO reserva_adicional_detalle
          (reserva_adicional_id, fecha, cantidad, precio_unitario, subtotal, tarifa_adicional_id, porcentaje_descuento, tarifa_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reservaAdicionalId,
          detalle.fecha,
          detalle.cantidad,
          detalle.precio_unitario,
          detalle.subtotal,
          detalle.tarifa_adicional_id,
          detalle.porcentaje_descuento || 0,
          detalle.tarifa_id || null
        ]
      );
    }
  }
}

async function obtenerAdicionalesReserva(connection, reservaId) {
  const [adicionales] = await connection.query(
    `SELECT id, adicional_id, nombre_adicional, cantidad, dias, subtotal
     FROM reserva_adicional
     WHERE reserva_id = ?`,
    [reservaId]
  );

  if (adicionales.length === 0) {
    return [];
  }

  const ids = adicionales.map(a => a.id);
  const [detalles] = await connection.query(
    `SELECT reserva_adicional_id, fecha, cantidad, precio_unitario, subtotal, tarifa_adicional_id, porcentaje_descuento, tarifa_id
     FROM reserva_adicional_detalle
     WHERE reserva_adicional_id IN (?)
     ORDER BY fecha ASC`,
    [ids]
  );

  const detallesMap = new Map();
  for (const detalle of detalles) {
    if (!detallesMap.has(detalle.reserva_adicional_id)) {
      detallesMap.set(detalle.reserva_adicional_id, []);
    }
    detallesMap.get(detalle.reserva_adicional_id).push({
      fecha: detalle.fecha,
      cantidad: detalle.cantidad,
      precio_unitario: Number(detalle.precio_unitario),
      subtotal: Number(detalle.subtotal),
      tarifa_adicional_id: detalle.tarifa_adicional_id,
      porcentaje_descuento: detalle.porcentaje_descuento,
      tarifa_id: detalle.tarifa_id
    });
  }

  return adicionales.map(adicional => ({
    id: adicional.id,
    adicional_id: adicional.adicional_id,
    nombre: adicional.nombre_adicional,
    cantidad: adicional.cantidad,
    dias: adicional.dias,
    subtotal: Number(adicional.subtotal),
    fechas: detallesMap.get(adicional.id) || []
  }));
}

// ---------------------------------------------------------------------------
// Reserva por motivos de salud (cruce Turismo ↔ Servicios Sociales).
// Marca la reserva y crea el trámite de subsidio (reserva_salud) que valida
// el área de coseguro en dos pasos (departamental → admin-central) desde
// /coseguro/subsidios-salud. El afiliado queda obligado a cargar certificados
// médicos; hasta la aprobación final la reserva mantiene su tarifa normal.
// ---------------------------------------------------------------------------
function normalizarPorSalud(body) {
  const marcado = String(body.por_salud) === "1" || body.por_salud === true || body.por_salud === "true";
  if (!marcado) return null;
  const motivo = String(body.salud_motivo || "").trim();
  const centroMedico = String(body.salud_centro_medico || "").trim() || null;
  if (!motivo) {
    const error = new Error("Indicá el motivo médico del viaje para solicitar el subsidio por salud");
    error.statusCode = 400;
    throw error;
  }
  return { motivo, centro_medico: centroMedico };
}

async function crearReservaSalud(connection, {
  reservaId,
  usuarioId,
  salud,
  usuarioNombre,
  usuarioModificadorId = usuarioId,
}) {
  await connection.query("UPDATE reserva SET es_por_salud = 1 WHERE id = ?", [reservaId]);
  const [resultado] = await connection.query(
    "INSERT INTO reserva_salud (reserva_id, usuario_id, motivo, centro_medico) VALUES (?, ?, ?, ?)",
    [reservaId, usuarioId, salud.motivo, salud.centro_medico]
  );
  const reservaSaludId = resultado.insertId;

  await connection.query(
    `INSERT INTO historial_reserva (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, observaciones)
     VALUES (?, 'UPDATE', 'Subsidio por salud', NULL, 'PENDIENTE', ?, ?)`,
    [reservaId, usuarioModificadorId, `Reserva marcada como viaje por motivos de salud. Motivo: ${salud.motivo}`]
  );

  // Avisar al staff de Servicios Sociales (área coseguro) de la departamental del afiliado
  const [staff] = await connection.query(
    `SELECT u.id FROM usuario u
     INNER JOIN rol r ON r.id = u.rol_id
     INNER JOIN usuario afiliado ON afiliado.id = ?
     WHERE u.habilitado = 'Y' AND u.area_coseguro = 1
       AND ((r.nombre = 'departamental' AND u.departamental_id = afiliado.departamental_id) OR r.nombre = 'admin-central')`,
    [usuarioId]
  );
  for (const u of staff) {
    await connection.query(
      "INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)",
      [
        u.id,
        "RESERVA_SALUD_NUEVA",
        `Nueva reserva por salud #${reservaId}`,
        `${usuarioNombre} solicitó el subsidio de alojamiento por salud. Revisá los certificados médicos en Servicios Sociales.`,
        JSON.stringify({ reserva_id: reservaId, reserva_salud_id: reservaSaludId, estado: "PENDIENTE" }),
      ]
    );
  }
  return reservaSaludId;
}

router.post("/reserva", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (cabecera.rol === "admin" ||
        cabecera.rol === "departamental" ||
        cabecera.rol === "afiliado") &&
      tieneAreaTurismo(cabecera)
    ) {
      const {
        nombre,
        observaciones,
        fecha_inicio,
        fecha_fin,
        servicio_id,
        recurso_id,
        regimen_id,
        personas,
        viaja_titular,
        adultos,
        ninos,
        bebes,
        total_tarifa,
        firma,
        adicionales,
        modalidad,
        bloque_fecha_id,
        hold_id,
        hold_token
      } = req.body;

      // Validar campos requeridos
      if (!nombre || !fecha_inicio || !fecha_fin || !servicio_id || !recurso_id ||
        !regimen_id || !Array.isArray(personas) || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const servicioIdReserva = normalizarIdPositivo(servicio_id);
      const recursoIdReserva = normalizarIdPositivo(recurso_id);
      const regimenIdReserva = normalizarIdPositivo(regimen_id);
      const fechaInicioReserva = formatearFechaSQL(fecha_inicio);
      const fechaFinReserva = formatearFechaSQL(fecha_fin);
      if (
        !servicioIdReserva || !recursoIdReserva || !regimenIdReserva ||
        !fechaInicioReserva || !fechaFinReserva ||
        diferenciaDiasCivil(fechaInicioReserva, fechaFinReserva) <= 0
      ) {
        return res.status(400).json("Los identificadores o el rango de fechas no son válidos");
      }
      if (!validarRangoReservaTemporal(fechaInicioReserva, fechaFinReserva).valido) {
        return res.status(422).json("La fecha de inicio no puede ser anterior a hoy");
      }

      const porSalud = normalizarPorSalud(req.body);

      const esReservaCamping = esServicioCamping(servicio_id);
      const errorReglasCamping = validarReglasCampingReserva(servicio_id, recurso_id, personas);
      if (errorReglasCamping) {
        return res.status(422).json(errorReglasCamping);
      }

      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      let modalidadReserva = MODALIDAD_FECHA_LIBRE;
      let bloqueFechaIdReserva = null;
      let temporadaTarifaIdReserva = null;
      let holdReservaValidado = null;

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Admin y departamental pueden cargar una reserva para un afiliado. La
        // departamental queda limitada a afiliados de su propia jurisdiccion.
        const {
          esRolCargaAdministrativa,
          usuarioReservaId,
          usuarioTitular,
        } = await resolverTitularReservaAlta(connection, cabecera, req.body.usuario_id, {
          requiereCoseguro: Boolean(porSalud),
        });

        // Se controla antes de consultar disponibilidad para que, si la unica
        // reserva iniciada ya vencio, quede rechazada y libere el recurso en
        // esta misma transaccion. Tambien cubre altas hechas por admin para un
        // afiliado, que igualmente deben respetar la unicidad.
        const altaQuedaIniciada = obtenerEstadoAltaTurismo(cabecera.rol) === ESTADO_INICIADA;
        if (usuarioTitular.rol === "afiliado" && altaQuedaIniciada) {
          const reservaIniciada = await asegurarSinReservaIniciadaAfiliado(
            connection,
            usuarioReservaId
          );
          if (reservaIniciada) {
            const error = crearErrorNegocio(
              "Ya tenes una reserva de turismo iniciada. Podes verla y continuarla antes de crear otra.",
              409,
              "RESERVA_INICIADA_EXISTENTE"
            );
            error.detalles = { reserva: reservaIniciada };
            throw error;
          }
        }

        try {
          const bloquesPorRecurso = await obtenerBloquesActivosParaRecursos(connection, {
            recursoIds: [recursoIdReserva],
            fechaInicio: fechaInicioReserva,
            fechaFin: fechaFinReserva
          });
          const bloquesActivos = bloquesPorRecurso.get(recursoIdReserva) || [];
          const bloqueExacto = bloquesActivos.find((bloque) => rangoCoincideConBloque(fechaInicioReserva, fechaFinReserva, bloque));
          const bloqueAplicable = bloqueExacto || bloquesActivos[0] || null;

          if (bloqueAplicable) {
            const ventaDirectaDesdeSorteo = bloqueAplicable.modalidad === MODALIDAD_SORTEO && bloqueAplicable.estado_recurso_bloque === "VENTA_DIRECTA";
            const modalidadBloque = ventaDirectaDesdeSorteo ? MODALIDAD_BLOQUE : bloqueAplicable.modalidad;

            if (modalidadBloque === MODALIDAD_SORTEO) {
              await connection.rollback();
              return res.status(409).json({
                message: "Las fechas seleccionadas corresponden a un sorteo. Debe realizar la inscripcion al sorteo.",
                codigo: "FECHAS_CON_SORTEO",
                sorteo_id: bloqueAplicable.sorteo_id,
                bloque_fecha_id: bloqueAplicable.bloque_fecha_id
              });
            }

            if (modalidadBloque === MODALIDAD_BLOQUE) {
              if (!bloqueExacto) {
                await connection.rollback();
                return res.status(409).json({
                  message: "El recurso pertenece a un bloque de fechas y debe reservarse completo.",
                  codigo: "BLOQUE_COMPLETO_REQUERIDO",
                  bloque_fecha: {
                    id: bloqueAplicable.bloque_fecha_id,
                    nombre: bloqueAplicable.bloque_nombre,
                    fecha_inicio: formatearFechaSQL(bloqueAplicable.fecha_inicio),
                    fecha_fin: formatearFechaSQL(bloqueAplicable.fecha_fin)
                  }
                });
              }

              modalidadReserva = MODALIDAD_BLOQUE;
              bloqueFechaIdReserva = Number(bloqueExacto.bloque_fecha_id);
              temporadaTarifaIdReserva = normalizarIdPositivo(bloqueExacto.temporada_tarifa_id);
            }
          } else if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
            const bloque = await obtenerBloqueConRecursos(connection, bloqueFechaIdSolicitado, { forUpdate: true });
            const recursoBloque = bloque.recursos.find((recurso) => Number(recurso.recurso_id) === recursoIdReserva);
            if (!recursoBloque || !ESTADOS_RECURSO_BLOQUE_RESERVABLES.has(recursoBloque.estado) || !rangoCoincideConBloque(fechaInicioReserva, fechaFinReserva, bloque)) {
              await connection.rollback();
              return res.status(409).json("El bloque seleccionado no esta disponible para ese recurso y fechas");
            }
            modalidadReserva = MODALIDAD_BLOQUE;
            bloqueFechaIdReserva = bloque.id;
            temporadaTarifaIdReserva = normalizarIdPositivo(bloque.temporada_tarifa_id);
          }
        } catch (bloqueError) {
          if (!esErrorTemporadaAltaNoMigrada(bloqueError)) {
            await connection.rollback();
            throw bloqueError;
          }
        }

        const requiereHold = cabecera.rol === "afiliado" || Boolean(hold_token);
        const holdIdExcluirPrevalidado = requiereHold
          ? await obtenerHoldIdActivoPorToken(connection, {
              actorUsuarioId: cabecera.id,
              holdToken: hold_token,
            })
          : null;

        await bloquearYValidarDisponibilidadReserva(connection, {
          servicioId: servicioIdReserva,
          recursoId: recursoIdReserva,
          fechaInicio: fechaInicioReserva,
          fechaFin: fechaFinReserva,
          holdIdExcluir: holdIdExcluirPrevalidado,
          omitirValidacionHolds: requiereHold,
        });

        if (requiereHold) {
          holdReservaValidado = await validarHoldParaReservaEnTransaccion(connection, {
            actorUsuarioId: cabecera.id,
            titularUsuarioId: usuarioReservaId,
            servicioId: servicioIdReserva,
            recursoId: recursoIdReserva,
            bloqueFechaId: bloqueFechaIdReserva,
            modalidad: modalidadReserva,
            fechaInicio: fechaInicioReserva,
            fechaFin: fechaFinReserva,
            holdId: hold_id,
            holdToken: hold_token,
          });
          if (!esReservaCamping) {
            await asegurarSinHoldAjenoEnTransaccion(connection, {
              recursoId: recursoIdReserva,
              fechaInicio: fechaInicioReserva,
              fechaFin: fechaFinReserva,
              holdIdExcluir: holdReservaValidado.id,
            });
          }
        }

        const { usuarioFamiliarPrincipalId, departamentalId } = await obtenerUsuarioPrincipalFamilia(
          connection,
          usuarioReservaId
        );

        const usuariosAutorizados = await crearOBuscarUsuariosReserva(connection, personas, {
          usuarioFamiliarPrincipalId,
          departamentalId,
          usuarioModificadorId: cabecera.id,
          req,
          fechaIngreso: fechaInicioReserva,
        });
        const tarifaBaseCalculada = await calcularTarifaBaseReserva(connection, {
          recursoId: recursoIdReserva,
          regimenId: regimenIdReserva,
          personas: usuariosAutorizados,
          fechaInicio: fechaInicioReserva,
          fechaFin: fechaFinReserva,
          temporadaTarifaId: temporadaTarifaIdReserva,
        });
        const resultadoAdicionales = await calcularAdicionalesReserva(
          connection,
          Array.isArray(adicionales) ? adicionales : [],
          recursoIdReserva,
          regimenIdReserva,
          fechaInicioReserva,
          fechaFinReserva,
          tarifaBaseCalculada.personas,
          temporadaTarifaIdReserva
        );
        const precioTotalCentavos = sumarCentavos(
          decimalACentavos(tarifaBaseCalculada.total),
          decimalACentavos(resultadoAdicionales.total)
        );
        if (precioTotalCentavos === null) {
          throw crearErrorNegocio("El total calculado de la reserva no es valido", 409, "TARIFA_INVALIDA");
        }
        const personasCalculadas = tarifaBaseCalculada.personas;
        const montoAdicionales = resultadoAdicionales.total;
        const adicionalesProcesados = resultadoAdicionales.items;
        const precioTotalReserva = centavosANumero(precioTotalCentavos);

        // Procesar firma si existe
        let firmaArchivo = null;
        if (firma) {
          const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
          await uploadBase64ToS3({
            key: firmaFileName,
            value: firma,
            defaultContentType: "image/png",
          });
          firmaArchivo = firmaFileName;
        }

        const usuariosIds = personasCalculadas;

        const [reservaResult] = await connection.query(
          `INSERT INTO reserva (
            estado_reserva_id, modalidad, sorteo_id, bloque_fecha_id, servicio_id,
            regimen_id, recurso_id, usuario_id,
            firma_archivo, precio_total, fecha_inicio, fecha_fin, observaciones, monto_adicionales
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ESTADO_RESERVA_INICIADA_ID,
            modalidadReserva,
            bloqueFechaIdReserva,
            servicioIdReserva,
            regimenIdReserva,
            recursoIdReserva,
            usuarioReservaId,
            firmaArchivo,
            precioTotalReserva,
            fechaInicioReserva,
            fechaFinReserva,
            observaciones || null,
            montoAdicionales
          ]
        );

        const reservaId = reservaResult.insertId;
        let estadoRespuesta = ESTADO_INICIADA;
        const esAltaDepartamental = obtenerEstadoAltaTurismo(cabecera.rol) === ESTADO_VERIFICADA;
        const registrarHitoAlta = esAltaDepartamental
          ? registrarHistorialReservaEstricto
          : registrarHistorialReserva;

        await registrarHitoAlta(
          connection,
          reservaId,
          "CREATE",
          cabecera.id,
          req,
          [{ campo: "estado_reserva_id", valorAnterior: null, valorNuevo: ESTADO_RESERVA_INICIADA_ID }],
          "Reserva creada en estado Iniciada"
        );

        // Una reserva cargada por la departamental ya fue revisada por ese
        // equipo. Se conserva el paso Iniciada en el historial y se avanza en
        // la misma transaccion a Verificada.
        if (esAltaDepartamental) {
          const estadoVerificadaId = await obtenerEstadoReservaId(connection, ESTADO_VERIFICADA, 2);
          await connection.query(
            "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ?",
            [estadoVerificadaId, reservaId]
          );
          await registrarHistorialReservaEstricto(
            connection,
            reservaId,
            "UPDATE",
            cabecera.id,
            req,
            [{
              campo: "estado_reserva_id",
              valorAnterior: ESTADO_RESERVA_INICIADA_ID,
              valorNuevo: estadoVerificadaId,
            }],
            "Verificacion automatica por alta departamental"
          );
          await notificarAdministradoresTurismo(
            connection,
            "RESERVA_PARA_APROBAR",
            `Reserva #${reservaId} verificada`,
            "La departamental creó y verificó la reserva. Ya está disponible para aprobación administrativa.",
            { reserva_id: reservaId, estado: ESTADO_VERIFICADA },
            cabecera.id
          );
          estadoRespuesta = ESTADO_VERIFICADA;
        }
        if (esRolCargaAdministrativa) {
          await insertarNotificacion(
            connection,
            usuarioReservaId,
            "RESERVA_CREADA_POR_TURISMO",
            `Nueva reserva de turismo #${reservaId}`,
            estadoRespuesta === ESTADO_VERIFICADA
              ? "Tu departamental creó y verificó una reserva de turismo a tu nombre."
              : "El equipo de Turismo creó una reserva a tu nombre. La departamental tiene 72 horas para verificarla.",
            { reserva_id: reservaId, estado: estadoRespuesta }
          );
        }
        let numeroParcelaAsignada = null;

        if (modalidadReserva === MODALIDAD_BLOQUE && bloqueFechaIdReserva) {
          await reclamarRecursoBloque(connection, {
            bloqueFechaId: bloqueFechaIdReserva,
            recursoId: recursoIdReserva,
            reservaId,
          });
        }

        if (adicionalesProcesados.length > 0) {
          await guardarAdicionalesReserva(connection, reservaId, adicionalesProcesados);
        }

        // Insertar reserva_familiar para cada persona
        const reservasFamiliaresIds = [];
        for (const persona of usuariosIds) {
          const [reservaFamiliarResult] = await connection.query(
            `INSERT INTO reserva_familiar (
              reserva_id, usuario_id, tipo_persona_id, parentesco_id, edad, precio
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              reservaId,
              persona.usuario_id,
              persona.tipo_persona_id,
              persona.parentesco_id,
              persona.edad,
              persona.tarifa_individual
            ]
          );

          reservasFamiliaresIds.push({
            reserva_familiar_id: reservaFamiliarResult.insertId,
            ...persona
          });
        }

        await insertarTarifasFamiliaresCalculadas(connection, reservasFamiliaresIds);

        // Viaje por motivos de salud: crea el trámite de subsidio para Servicios Sociales
        let reservaSaludId = null;
        if (porSalud) {
          reservaSaludId = await crearReservaSalud(connection, {
            reservaId,
            usuarioId: usuarioReservaId,
            salud: porSalud,
            usuarioNombre: `${usuarioTitular.apellido}, ${usuarioTitular.nombre}`,
            usuarioModificadorId: cabecera.id,
          });
        }

        // Confirmar transacción
        if (esReservaCamping) {
          if (holdReservaValidado?.numeroParcela) {
            numeroParcelaAsignada = holdReservaValidado.numeroParcela;
            await validarNumeroParcelaCampingExistente(connection, {
              reservaId,
              recursoId: recursoIdReserva,
              fechaInicio: fechaInicioReserva,
              fechaFin: fechaFinReserva,
              numeroParcela: numeroParcelaAsignada,
            });
          } else {
            numeroParcelaAsignada = await asignarNumeroParcelaCamping(connection, {
              recursoId: recursoIdReserva,
              fechaInicio: fechaInicioReserva,
              fechaFin: fechaFinReserva,
              holdIdExcluir: holdReservaValidado?.id || null,
            });
          }

          await connection.query(
            "UPDATE reserva SET numero_parcela = ? WHERE id = ?",
            [numeroParcelaAsignada, reservaId]
          );
        }

        if (holdReservaValidado) {
          await consumirHoldEnTransaccion(connection, {
            holdId: holdReservaValidado.id,
            reservaId,
          });
        }

        await connection.commit();
        emitirInvalidacionDisponibilidad(
          req,
          holdReservaValidado?.hold || {
            servicio_id: servicioIdReserva,
            recurso_id: recursoIdReserva,
            bloque_fecha_id: bloqueFechaIdReserva,
            fecha_inicio: fechaInicioReserva,
            fecha_fin: fechaFinReserva,
          },
          holdReservaValidado ? "HOLD_CONSUMIDO" : "RESERVA_CREADA"
        );

        const numeroReserva = `${reservaId}`;

        res.status(201).json({
          id: reservaId,
          numero_reserva: numeroReserva,
          numero_parcela: numeroParcelaAsignada,
          estado: estadoRespuesta,
          mensaje: "Reserva creada exitosamente",
          fecha_creacion: new Date().toISOString(),
          precio_total: precioTotalReserva,
          total_tarifa: tarifaBaseCalculada.total,
          monto_adicionales: montoAdicionales,
          reserva_salud_id: reservaSaludId
        });

      } catch (transactionError) {
        if (connection) {
          await connection.rollback();
        }
        throw transactionError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      if (error.codigo) {
        return res.status(error.statusCode).json({
          message: error.message,
          codigo: error.codigo,
          ...(error.detalles || {}),
        });
      }
      return res.status(error.statusCode).json(error.message);
    }
    res.status(500).json("Error al procesar la reserva");
  }
});

router.post("/convenios-hoteleros/:id/reservas", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "departamental", "afiliado"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const hotelId = normalizarIdPositivo(req.params.id);
    const {
      fecha_inicio,
      fecha_fin,
      personas,
      firma,
      observaciones,
    } = req.body;

    if (!hotelId || !fecha_inicio || !fecha_fin || !Array.isArray(personas) || personas.length === 0 || !firma) {
      return res.status(400).json("Faltan campos requeridos");
    }
    const fechaInicioReserva = formatearFechaSQL(fecha_inicio);
    const fechaFinReserva = formatearFechaSQL(fecha_fin);
    if (!validarRangoReservaTemporal(fechaInicioReserva, fechaFinReserva).valido) {
      return res.status(422).json("El rango debe ser válido y no puede comenzar antes de hoy");
    }

    const porSalud = normalizarPorSalud(req.body);

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const {
      esRolCargaAdministrativa,
      usuarioReservaId,
      usuarioTitular,
    } = await resolverTitularReservaAlta(connection, cabecera, req.body.usuario_id, {
      requiereCoseguro: Boolean(porSalud),
    });

    const [hoteles] = await connection.query(
      "SELECT id, nombre FROM convenio_hotel WHERE id = ? AND activo = 1 LIMIT 1",
      [hotelId]
    );
    if (hoteles.length === 0) {
      await connection.rollback();
      return res.status(404).json("Convenio hotelero no disponible");
    }

    const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
    await uploadBase64ToS3({
      key: firmaFileName,
      value: firma,
      defaultContentType: "image/png",
    });

    const { usuarioFamiliarPrincipalId, departamentalId } = await obtenerUsuarioPrincipalFamilia(
      connection,
      usuarioReservaId
    );
    const usuariosIds = await crearOBuscarUsuariosReserva(connection, personas, {
      usuarioFamiliarPrincipalId,
      departamentalId,
      usuarioModificadorId: cabecera.id,
      req,
      fechaIngreso: fechaInicioReserva,
    });

    const estadoSolicitudConvenioId = await obtenerEstadoReservaId(
      connection,
      "Solicitud convenio",
      ESTADO_RESERVA_INICIADA_ID
    );

    const [reservaResult] = await connection.query(
      `
        INSERT INTO reserva (
          estado_reserva_id,
          modalidad,
          sorteo_id,
          bloque_fecha_id,
          servicio_id,
          regimen_id,
          recurso_id,
          convenio_hotel_id,
          usuario_id,
          firma_archivo,
          precio_total,
          fecha_inicio,
          fecha_fin,
          observaciones,
          monto_adicionales
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, 0)
      `,
      [
        estadoSolicitudConvenioId,
        MODALIDAD_CONVENIO,
        hotelId,
        usuarioReservaId,
        firmaFileName,
        fechaInicioReserva,
        fechaFinReserva,
        observaciones || null,
      ]
    );

    const reservaId = reservaResult.insertId;
    for (const persona of usuariosIds) {
      await connection.query(
        `
          INSERT INTO reserva_familiar (
            reserva_id,
            usuario_id,
            tipo_persona_id,
            parentesco_id,
            edad,
            precio
          ) VALUES (?, ?, ?, ?, ?, 0)
        `,
        [
          reservaId,
          persona.usuario_id,
          persona.tipo_persona_id || null,
          persona.parentesco_id || null,
          persona.edad || null,
        ]
      );
    }

    await registrarHistorialReserva(
      connection,
      reservaId,
      "CREATE",
      cabecera.id,
      req,
      null,
      `Solicitud de convenio hotelero creada para ${hoteles[0].nombre}`
    );

    if (esRolCargaAdministrativa) {
      await insertarNotificacion(
        connection,
        usuarioReservaId,
        "CONVENIO_CREADO_POR_TURISMO",
        `Nueva solicitud de convenio #${reservaId}`,
        "El equipo de Turismo creó una solicitud de convenio hotelero a tu nombre.",
        { reserva_id: reservaId, estado: "Solicitud convenio" }
      );
    }

    // Viaje por motivos de salud: crea el trámite de subsidio para Servicios Sociales
    let reservaSaludId = null;
    if (porSalud) {
      reservaSaludId = await crearReservaSalud(connection, {
        reservaId,
        usuarioId: usuarioReservaId,
        salud: porSalud,
        usuarioNombre: `${usuarioTitular.apellido}, ${usuarioTitular.nombre}`,
        usuarioModificadorId: cabecera.id,
      });
    }

    await connection.commit();

    res.status(201).json({
      id: reservaId,
      numero_reserva: `${reservaId}`,
      estado: "Solicitud convenio",
      mensaje: "Solicitud de convenio hotelero creada exitosamente",
      fecha_creacion: new Date().toISOString(),
      reserva_salud_id: reservaSaludId,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        message: error.message,
        codigo: error.codigo || null,
      });
    }
    res.status(500).json("Error al crear la solicitud de convenio hotelero");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/reserva/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (cabecera.rol === "admin" || cabecera.rol === "departamental" || cabecera.rol === "afiliado") &&
      tieneAreaTurismo(cabecera)
    ) {
      const reservaId = normalizarIdPositivo(req.params.id);
      const {
        nombre,
        observaciones,
        fecha_inicio,
        fecha_fin,
        servicio_id,
        recurso_id,
        regimen_id,
        personas,
        viaja_titular,
        firma_base64,
        adicionales
      } = req.body;

      // Validar campos requeridos
      if (!reservaId || !nombre || !fecha_inicio || !fecha_fin || !servicio_id ||
        !recurso_id || !regimen_id || !Array.isArray(personas) || personas.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Faltan campos requeridos"
        });
      }

      const servicioIdReserva = normalizarIdPositivo(servicio_id);
      const recursoIdReserva = normalizarIdPositivo(recurso_id);
      const regimenIdReserva = normalizarIdPositivo(regimen_id);
      const fechaInicioReserva = formatearFechaSQL(fecha_inicio);
      const fechaFinReserva = formatearFechaSQL(fecha_fin);
      if (
        !servicioIdReserva || !recursoIdReserva || !regimenIdReserva ||
        !fechaInicioReserva || !fechaFinReserva ||
        diferenciaDiasCivil(fechaInicioReserva, fechaFinReserva) <= 0
      ) {
        return res.status(400).json({ success: false, message: "Los identificadores o el rango de fechas no son válidos" });
      }

      const esReservaCamping = esServicioCamping(servicioIdReserva);
      const errorReglasCamping = validarReglasCampingReserva(servicioIdReserva, recursoIdReserva, personas);
      if (errorReglasCamping) {
        return res.status(422).json({
          success: false,
          message: errorReglasCamping
        });
      }

      let connection;
      let archivoReservaActivo = false;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Verificar que la reserva existe
        const [reservaExistente] = await connection.query(
          `SELECT r.*, er.nombre AS estado_nombre,
                  u.departamental_id AS usuario_departamental_id
           FROM reserva r
           LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
           INNER JOIN usuario u ON u.id = r.usuario_id
           WHERE r.id = ?
           FOR UPDATE`,
          [reservaId]
        );

        if (reservaExistente.length === 0) {
          throw crearErrorNegocio("Reserva no encontrada", 404);
        }

        const reservaActual = reservaExistente[0];
        // Autorizar antes de exponer el estado o validar el contenido editable.
        if (cabecera.rol === "afiliado" && Number(reservaActual.usuario_id) !== Number(cabecera.id)) {
          throw crearErrorNegocio("No tienes permisos para editar esta reserva", 403);
        }
        if (cabecera.rol === "departamental") {
          const [editores] = await connection.query("SELECT departamental_id FROM usuario WHERE id = ? LIMIT 1", [cabecera.id]);
          if (
            editores.length === 0 ||
            Number(editores[0].departamental_id) !== Number(reservaActual.usuario_departamental_id)
          ) {
            throw crearErrorNegocio("No tienes permisos para editar reservas de otra departamental", 403);
          }
        }
        if (reservaActual.estado_nombre !== ESTADO_INICIADA) {
          throw crearErrorNegocio(
            "Solo se pueden editar reservas en estado Iniciada",
            409,
            "RESERVA_NO_EDITABLE_POR_ESTADO"
          );
        }
        if ([MODALIDAD_SORTEO, MODALIDAD_CONVENIO].includes(reservaActual.modalidad)) {
          throw crearErrorNegocio("Esta modalidad no se puede editar desde la reserva general", 409);
        }
        const validacionTemporalEdicion = validarRangoReservaTemporal(fechaInicioReserva, fechaFinReserva, {
          rangoExistente: {
            fecha_inicio: formatearFechaSQL(reservaActual.fecha_inicio),
            fecha_fin: formatearFechaSQL(reservaActual.fecha_fin),
          },
        });
        if (!validacionTemporalEdicion.valido) {
          throw crearErrorNegocio(
            "Una reserva histórica solo puede conservar exactamente su rango de fechas existente",
            422,
            "RANGO_HISTORICO_NO_EDITABLE"
          );
        }

        const numeroParcelaAnteriorRaw = reservaActual.numero_parcela;
        let numeroParcelaReserva = numeroParcelaAnteriorRaw !== null && numeroParcelaAnteriorRaw !== undefined
          ? Number(numeroParcelaAnteriorRaw)
          : null;

        // Procesar firma si existe
        let firmaArchivo = null;
        if (firma_base64) {
          const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
          await uploadBase64ToS3({
            key: firmaFileName,
            value: firma_base64,
            defaultContentType: "image/png",
          });
          firmaArchivo = firmaFileName;
        }

        let temporadaTarifaIdReserva = null;
        if (reservaActual.modalidad === MODALIDAD_BLOQUE) {
          const bloque = await obtenerBloqueConRecursos(connection, reservaActual.bloque_fecha_id, { forUpdate: true });
          const recursoBloque = bloque.recursos.find((recurso) => Number(recurso.recurso_id) === recursoIdReserva);
          if (
            !recursoBloque || Number(recursoBloque.reserva_id) !== reservaId ||
            !rangoCoincideConBloque(fechaInicioReserva, fechaFinReserva, bloque)
          ) {
            throw crearErrorNegocio("Una reserva de bloque debe conservar su bloque, recurso y rango completos", 409);
          }
          temporadaTarifaIdReserva = normalizarIdPositivo(bloque.temporada_tarifa_id);
        } else {
          const bloquesPorRecurso = await obtenerBloquesActivosParaRecursos(connection, {
            recursoIds: [recursoIdReserva],
            fechaInicio: fechaInicioReserva,
            fechaFin: fechaFinReserva,
          });
          if ((bloquesPorRecurso.get(recursoIdReserva) || []).length > 0) {
            throw crearErrorNegocio("El nuevo rango corresponde a un bloque y no puede editarse como fecha libre", 409);
          }
        }

        await bloquearYValidarDisponibilidadReserva(connection, {
          servicioId: servicioIdReserva,
          recursoId: recursoIdReserva,
          fechaInicio: fechaInicioReserva,
          fechaFin: fechaFinReserva,
          reservaIdExcluir: reservaId,
        });

        const { usuarioFamiliarPrincipalId, departamentalId } = await obtenerUsuarioPrincipalFamilia(
          connection,
          reservaActual.usuario_id
        );
        const usuariosAutorizados = await crearOBuscarUsuariosReserva(connection, personas, {
          usuarioFamiliarPrincipalId,
          departamentalId,
          usuarioModificadorId: cabecera.id,
          req,
          fechaIngreso: fechaInicioReserva,
        });
        const tarifaBaseCalculada = await calcularTarifaBaseReserva(connection, {
          recursoId: recursoIdReserva,
          regimenId: regimenIdReserva,
          personas: usuariosAutorizados,
          fechaInicio: fechaInicioReserva,
          fechaFin: fechaFinReserva,
          temporadaTarifaId: temporadaTarifaIdReserva,
        });
        const resultadoAdicionales = await calcularAdicionalesReserva(
          connection,
          Array.isArray(adicionales) ? adicionales : [],
          recursoIdReserva,
          regimenIdReserva,
          fechaInicioReserva,
          fechaFinReserva,
          tarifaBaseCalculada.personas,
          temporadaTarifaIdReserva
        );
        const precioTotalCentavos = sumarCentavos(
          decimalACentavos(tarifaBaseCalculada.total),
          decimalACentavos(resultadoAdicionales.total)
        );
        if (precioTotalCentavos === null) {
          throw crearErrorNegocio("El total calculado de la reserva no es valido", 409, "TARIFA_INVALIDA");
        }
        const usuariosIds = tarifaBaseCalculada.personas;
        const montoAdicionales = resultadoAdicionales.total;
        const adicionalesProcesados = resultadoAdicionales.items;
        const precioTotalReserva = centavosANumero(precioTotalCentavos);

        // Detectar cambios en la reserva
        const datosAnteriores = reservaExistente[0];
        const cambiosReserva = [];

        if (Number(datosAnteriores.regimen_id) !== regimenIdReserva) {
            cambiosReserva.push({ campo: 'regimen_id', valorAnterior: datosAnteriores.regimen_id, valorNuevo: regimenIdReserva });
        }
        if (Number(datosAnteriores.servicio_id) !== servicioIdReserva) {
            cambiosReserva.push({ campo: 'servicio_id', valorAnterior: datosAnteriores.servicio_id, valorNuevo: servicioIdReserva });
        }
        if (Number(datosAnteriores.recurso_id) !== recursoIdReserva) {
            cambiosReserva.push({ campo: 'recurso_id', valorAnterior: datosAnteriores.recurso_id, valorNuevo: recursoIdReserva });
        }
        if (formatearFechaSQL(datosAnteriores.fecha_inicio) !== fechaInicioReserva) {
            cambiosReserva.push({ campo: 'fecha_inicio', valorAnterior: formatearFechaSQL(datosAnteriores.fecha_inicio), valorNuevo: fechaInicioReserva });
        }
        if (formatearFechaSQL(datosAnteriores.fecha_fin) !== fechaFinReserva) {
            cambiosReserva.push({ campo: 'fecha_fin', valorAnterior: formatearFechaSQL(datosAnteriores.fecha_fin), valorNuevo: fechaFinReserva });
        }
        if (Number(datosAnteriores.precio_total) !== Number(precioTotalReserva)) {
            cambiosReserva.push({ campo: 'precio_total', valorAnterior: datosAnteriores.precio_total, valorNuevo: precioTotalReserva });
        }
        
        const obsAnt = datosAnteriores.observaciones || '';
        const obsNew = observaciones || '';
        if (obsAnt !== obsNew) {
            cambiosReserva.push({ campo: 'observaciones', valorAnterior: obsAnt, valorNuevo: obsNew });
        }
        
        if (Number(datosAnteriores.monto_adicionales) !== Number(montoAdicionales)) {
            cambiosReserva.push({ campo: 'monto_adicionales', valorAnterior: datosAnteriores.monto_adicionales, valorNuevo: montoAdicionales });
        }
        if (firmaArchivo) {
             cambiosReserva.push({ campo: 'firma_archivo', valorAnterior: datosAnteriores.firma_archivo, valorNuevo: firmaArchivo });
        }

        await archivarVersionReservaAntesDeReemplazo(
          connection,
          reservaId,
          { id: cabecera.id, rol: cabecera.rol },
          "EDICION"
        );
        archivoReservaActivo = true;

        if (cambiosReserva.length > 0) {
            await registrarHistorialReserva(connection, reservaId, 'UPDATE', cabecera.id, req, cambiosReserva, 'Modificación de reserva');
        }

        // Actualizar reserva principal
        const updateReservaQuery = `
          UPDATE reserva SET 
            servicio_id = ?,
            regimen_id = ?, 
            recurso_id = ?, 
            ${firmaArchivo ? 'firma_archivo = ?,' : ''} 
            precio_total = ?, 
            fecha_inicio = ?, 
            fecha_fin = ?, 
            observaciones = ?,
            monto_adicionales = ?
          WHERE id = ?
        `;

        const updateReservaParams = [
          servicioIdReserva,
          regimenIdReserva,
          recursoIdReserva,
          ...(firmaArchivo ? [firmaArchivo] : []),
          precioTotalReserva,
          fechaInicioReserva,
          fechaFinReserva,
          observaciones || null,
          montoAdicionales,
          reservaId
        ];

        await connection.query(updateReservaQuery, updateReservaParams);

        // Eliminar registros existentes de reserva_familiar y reserva_familiar_tarifa
        await connection.query(
          "DELETE rft FROM reserva_familiar_tarifa rft INNER JOIN reserva_familiar rf ON rft.reserva_familiar_id = rf.id WHERE rf.reserva_id = ?",
          [reservaId]
        );

        await connection.query(
          "DELETE FROM reserva_familiar WHERE reserva_id = ?",
          [reservaId]
        );

        await connection.query(
          "DELETE FROM reserva_adicional WHERE reserva_id = ?",
          [reservaId]
        );


        // Insertar nuevos registros de reserva_familiar
        const reservasFamiliaresIds = [];
        for (const persona of usuariosIds) {
          const [reservaFamiliarResult] = await connection.query(
            `INSERT INTO reserva_familiar (
              reserva_id, usuario_id, tipo_persona_id, parentesco_id, edad, precio
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              reservaId,
              persona.usuario_id,
              persona.tipo_persona_id,
              persona.parentesco_id,
              persona.edad,
              persona.tarifa_individual
            ]
          );

          reservasFamiliaresIds.push({
            reserva_familiar_id: reservaFamiliarResult.insertId,
            ...persona
          });
        }

        await insertarTarifasFamiliaresCalculadas(connection, reservasFamiliaresIds);

        if (adicionalesProcesados.length > 0) {
          await guardarAdicionalesReserva(connection, reservaId, adicionalesProcesados);
        }

        // Confirmar transacción
        if (esReservaCamping) {
          if (Number.isInteger(numeroParcelaReserva) && numeroParcelaReserva > 0) {
            await validarNumeroParcelaCampingExistente(connection, {
              reservaId,
              recursoId: recursoIdReserva,
              fechaInicio: fechaInicioReserva,
              fechaFin: fechaFinReserva,
              numeroParcela: numeroParcelaReserva
            });
          } else {
            numeroParcelaReserva = await asignarNumeroParcelaCamping(connection, {
              recursoId: recursoIdReserva,
              fechaInicio: fechaInicioReserva,
              fechaFin: fechaFinReserva,
              reservaIdExcluir: reservaId
            });

            await connection.query(
              "UPDATE reserva SET numero_parcela = ? WHERE id = ?",
              [numeroParcelaReserva, reservaId]
            );
          }
        } else if (numeroParcelaReserva !== null) {
          numeroParcelaReserva = null;
          await connection.query("UPDATE reserva SET numero_parcela = NULL WHERE id = ?", [reservaId]);
        }

        await cerrarGuardiaArchivoReserva(connection, reservaId);
        archivoReservaActivo = false;
        await connection.commit();

        const numeroReserva = `RES-${reservaId.toString().padStart(6, '0')}`;

        res.status(200).json({
          success: true,
          message: "Reserva actualizada correctamente",
          numero_reserva: numeroReserva,
          numero_parcela: numeroParcelaReserva,
          id: parseInt(reservaId),
          precio_total: precioTotalReserva,
          total_tarifa: tarifaBaseCalculada.total,
          monto_adicionales: montoAdicionales
        });

      } catch (transactionError) {
        if (connection) {
          await connection.rollback();
          if (archivoReservaActivo) {
            try {
              await limpiarTokenGuardiaArchivoReserva(connection);
            } catch (_) {
              // La guardia de tabla y el archivo ya fueron revertidos con la transacción.
            }
          }
        }
        throw transactionError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json({
        success: false,
        message: "No autorizado"
      });
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        codigo: error.codigo || null
      });
    }
    res.status(500).json({
      success: false,
      message: "Error al actualizar la reserva"
    });
  }
});

router.get("/reserva/:id/edicion", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental") &&
      tieneAreaTurismo(cabecera)
    ) {
      const reservaId = normalizarIdPositivo(req.params.id);

      if (!reservaId) {
        return res.status(400).json("ID de reserva requerido");
      }

      let connection;
      try {
        connection = await mysqlConnection.promise().getConnection();

        // Obtener información básica de la reserva
        const [reservaInfo] = await connection.query(`
          SELECT 
            r.id,
            r.usuario_id,
            r.numero_parcela,
            r.precio_total as total_tarifa,
            r.monto_adicionales,
            r.fecha_inicio,
            r.fecha_fin,
            r.observaciones,
            r.fecha_creacion,
            DATE_ADD(r.fecha_creacion, INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR) AS fecha_vencimiento_respuesta,
            COALESCE(r.modalidad, 'FECHA_LIBRE') as modalidad,
            r.sorteo_id,
            r.bloque_fecha_id,
            r.convenio_hotel_id,
            er.nombre as estado,
            s.id as servicio_id,
            s.nombre as servicio_nombre,
            s.lugar,
            rec.id as recurso_id,
            rec.nombre as recurso_nombre,
            ch.nombre as convenio_nombre,
            ch.ciudad as convenio_ciudad,
            ch.provincia as convenio_provincia,
            ch.coordenadas_maps as convenio_coordenadas_maps,
            ch.latitud as convenio_latitud,
            ch.longitud as convenio_longitud,
            ch.descripcion as convenio_descripcion,
            ch.tarifario_pdf_archivo as convenio_tarifario_pdf_archivo,
            ur.departamental_id as usuario_departamental_id,
            bf.nombre as bloque_nombre,
            sorteo.nombre as sorteo_nombre,
            reg.id as regimen_id,
            reg.nombre as regimen_nombre
          FROM reserva r
          LEFT JOIN usuario ur ON ur.id = r.usuario_id
          LEFT JOIN estado_reserva er ON r.estado_reserva_id = er.id
          LEFT JOIN recurso rec ON r.recurso_id = rec.id
          LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
          LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
          LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
          LEFT JOIN sorteo ON sorteo.id = r.sorteo_id
          LEFT JOIN regimen reg ON r.regimen_id = reg.id
          WHERE r.id = ?
        `, [reservaId]);

        if (reservaInfo.length === 0) {
          return res.status(404).json("Reserva no encontrada");
        }

        const reserva = reservaInfo[0];

        // Si el rol es afiliado, verificar que la reserva le pertenezca
        if (cabecera.rol === "afiliado") {
          if (Number(reserva.usuario_id) !== Number(cabecera.id)) {
            return res.status(403).json("No tienes permisos para editar esta reserva");
          }
        }
        if (
          cabecera.rol === "departamental" &&
          !(await puedeAccederUsuarioRelacionado(connection, cabecera, reserva.usuario_id))
        ) {
          return res.status(403).json("No tienes permisos para editar esta reserva");
        }

        // Obtener las personas de la reserva con información completa para edición
        const [personas] = await connection.query(`
          SELECT 
            u.id,
            u.nombre,
            u.apellido,
            u.documento as dni,
            u.fecha_nacimiento,
            u.telefono,
            u.email,
            rf.id as reserva_familiar_id,
            rf.edad,
            rf.precio as tarifa_individual,
            rf.tipo_persona_id,
            rf.parentesco_id,
            tp.nombre as tipo_persona_nombre,
            p.nombre as parentesco_nombre,
            (
              SELECT t.usa_porcentaje 
              FROM reserva_familiar_tarifa rft 
              JOIN tarifa t ON rft.tarifa_id = t.id 
              WHERE rft.reserva_familiar_id = rf.id 
              ORDER BY t.usa_porcentaje DESC 
              LIMIT 1
            ) as usa_porcentaje,
            (
              SELECT t.porcentaje_descuento 
              FROM reserva_familiar_tarifa rft 
              JOIN tarifa t ON rft.tarifa_id = t.id 
              WHERE rft.reserva_familiar_id = rf.id 
              ORDER BY t.usa_porcentaje DESC 
              LIMIT 1
            ) as porcentaje_descuento
          FROM reserva_familiar rf
          INNER JOIN usuario u ON rf.usuario_id = u.id
          INNER JOIN tipo_persona tp ON rf.tipo_persona_id = tp.id
          INNER JOIN parentesco p ON rf.parentesco_id = p.id
          WHERE rf.reserva_id = ?
          ORDER BY p.id ASC
        `, [reservaId]);

        // Verificar si viaja el titular y formatear personas
        let viaja_titular = false;
        const personasFormateadas = personas.map(persona => {
          const es_titular = persona.parentesco_id === 1;
          if (es_titular) {
            viaja_titular = true;
          }

          return {
            id: persona.id,
            nombre: persona.nombre,
            apellido: persona.apellido,
            dni: persona.dni,
            fecha_nacimiento: persona.fecha_nacimiento,
            telefono: persona.telefono,
            email: persona.email,
            tipo_persona_id: persona.tipo_persona_id,
            parentesco_id: persona.parentesco_id,
            regimen_id: reserva.regimen_id, // Todas las personas tienen el mismo régimen
            edad: persona.edad,
            es_titular: es_titular,
            usa_porcentaje: persona.usa_porcentaje === 1 || persona.usa_porcentaje === true,
            porcentaje_descuento: persona.porcentaje_descuento
          };
        });

        // Generar número de reserva
        const numeroReserva = `RES-${reserva.id.toString().padStart(6, '0')}`;

        // Construir respuesta para edición
        const respuesta = {
          id: reserva.id,
          numero_reserva: numeroReserva,
          numero_parcela: reserva.numero_parcela !== null && reserva.numero_parcela !== undefined
            ? Number(reserva.numero_parcela)
            : null,
          nombre: reserva.observaciones || `Reserva ${numeroReserva}`,
          fecha_inicio: reserva.fecha_inicio,
          fecha_fin: reserva.fecha_fin,
          modalidad: reserva.modalidad || MODALIDAD_FECHA_LIBRE,
          sorteo_id: reserva.sorteo_id,
          sorteo_nombre: reserva.sorteo_nombre,
          bloque_fecha_id: reserva.bloque_fecha_id,
          bloque_nombre: reserva.bloque_nombre,
          observaciones: reserva.observaciones,
          servicio: {
            id: reserva.servicio_id,
            nombre: reserva.servicio_nombre
          },
          recurso: {
            id: reserva.recurso_id,
            nombre: reserva.recurso_nombre || "Pendiente de adjudicación",
            location: reserva.lugar
          },
          regimen: {
            id: reserva.regimen_id,
            nombre: reserva.regimen_nombre
          },
          lugar: reserva.lugar,
          personas: personasFormateadas,
          viaja_titular: viaja_titular
        };

        const adicionalesReserva = await obtenerAdicionalesReserva(connection, reservaId);
        const adicionalesFormateados = adicionalesReserva.map(adicional => ({
          id: adicional.id,
          adicional_id: adicional.adicional_id,
          nombre: adicional.nombre,
          cantidad: adicional.cantidad,
          dias: adicional.dias,
          subtotal: Number(adicional.subtotal),
          fechas: adicional.fechas.map(fecha => ({
            fecha: fecha.fecha,
            cantidad: fecha.cantidad,
            precio_unitario: Number(fecha.precio_unitario),
            subtotal: Number(fecha.subtotal),
            tarifa_adicional_id: fecha.tarifa_adicional_id,
            porcentaje_descuento: fecha.porcentaje_descuento,
            tarifa_id: fecha.tarifa_id
          }))
        }));

        respuesta.adicionales = adicionalesFormateados;
        respuesta.monto_adicionales = reserva.monto_adicionales || 0;
        
        res.status(200).json(respuesta);

      } catch (queryError) {
        throw queryError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la información de la reserva para edición");
  }
});

router.get("/reserva/:id/resumen", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (
        cabecera.rol === "admin" ||
        cabecera.rol === "afiliado" ||
        cabecera.rol === "departamental"
      ) && tieneAreaTurismo(cabecera)
    ) {
      const reservaId = normalizarIdPositivo(req.params.id);

      if (!reservaId) {
        return res.status(400).json("ID de reserva requerido");
      }

      let connection;
      try {
        connection = await mysqlConnection.promise().getConnection();

        // Obtener información básica de la reserva
        const [reservaInfo] = await connection.query(`
          SELECT 
            r.id,
            r.numero_parcela,
            r.precio_total as total_tarifa,
            r.monto_adicionales,
            r.fecha_inicio,
            r.fecha_fin,
            r.observaciones,
            r.fecha_creacion,
            DATE_ADD(r.fecha_creacion, INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR) AS fecha_vencimiento_respuesta,
            r.firma_archivo,
            r.usuario_id,
            r.es_por_salud,
            COALESCE(r.modalidad, 'FECHA_LIBRE') as modalidad,
            r.sorteo_id,
            r.bloque_fecha_id,
            r.convenio_hotel_id,
            er.nombre as estado,
            s.id as servicio_id,
            s.nombre as servicio_nombre,
            s.lugar,
            rec.id as recurso_id,
            rec.nombre as recurso_nombre,
            ch.nombre as convenio_nombre,
            ch.ciudad as convenio_ciudad,
            ch.provincia as convenio_provincia,
            ch.coordenadas_maps as convenio_coordenadas_maps,
            ch.latitud as convenio_latitud,
            ch.longitud as convenio_longitud,
            ch.descripcion as convenio_descripcion,
            ch.tarifario_pdf_archivo as convenio_tarifario_pdf_archivo,
            ur.departamental_id as usuario_departamental_id,
            bf.nombre as bloque_nombre,
            sorteo.nombre as sorteo_nombre,
            reg.id as regimen_id,
            reg.nombre as regimen_nombre
          FROM reserva r
          LEFT JOIN usuario ur ON ur.id = r.usuario_id
          LEFT JOIN estado_reserva er ON r.estado_reserva_id = er.id
          LEFT JOIN recurso rec ON r.recurso_id = rec.id
          LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
          LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
          LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
          LEFT JOIN sorteo ON sorteo.id = r.sorteo_id
          LEFT JOIN regimen reg ON r.regimen_id = reg.id
          WHERE r.id = ?
        `, [reservaId]);

        if (reservaInfo.length === 0) {
          return res.status(404).json("Reserva no encontrada");
        }

        const reserva = reservaInfo[0];

        // Si el rol es afiliado, verificar que la reserva le pertenezca
        if (cabecera.rol === "afiliado") {
          if (Number(reserva.usuario_id) !== Number(cabecera.id)) {
            return res.status(403).json("No tienes permisos para ver esta reserva");
          }
        }

        if (
          cabecera.rol === "departamental" &&
          !(await puedeAccederUsuarioRelacionado(connection, cabecera, reserva.usuario_id))
        ) {
          return res.status(403).json("No tienes permisos para ver esta reserva");
        }

        // Obtener las personas de la reserva
        const [personas] = await connection.query(`
          SELECT 
            u.id,
            u.nombre,
            u.apellido,
            u.documento as dni,
            u.fecha_nacimiento,
            u.telefono,
            rf.id as reserva_familiar_id,
            rf.edad,
            rf.precio as tarifa_individual,
            tp.id as tipo_persona_id,
            tp.nombre as tipo_persona_nombre,
            p.id as parentesco_id,
            p.nombre as parentesco_nombre,
            (
              SELECT t.usa_porcentaje 
              FROM reserva_familiar_tarifa rft 
              JOIN tarifa t ON rft.tarifa_id = t.id 
              WHERE rft.reserva_familiar_id = rf.id 
              ORDER BY t.usa_porcentaje DESC 
              LIMIT 1
            ) as usa_porcentaje,
            (
              SELECT t.porcentaje_descuento 
              FROM reserva_familiar_tarifa rft 
              JOIN tarifa t ON rft.tarifa_id = t.id 
              WHERE rft.reserva_familiar_id = rf.id 
              ORDER BY t.usa_porcentaje DESC 
              LIMIT 1
            ) as porcentaje_descuento
          FROM reserva_familiar rf
          INNER JOIN usuario u ON rf.usuario_id = u.id
          INNER JOIN tipo_persona tp ON rf.tipo_persona_id = tp.id
          INNER JOIN parentesco p ON rf.parentesco_id = p.id
          WHERE rf.reserva_id = ?
          ORDER BY p.id ASC
        `, [reservaId]);

        // Contar tipos de personas
        let adultos = 0;
        let ninos = 0;
        let bebes = 0;
        let viaja_titular = false;

        personas.forEach(persona => {
          if (persona.edad > 5) {
            adultos++;
          } else if (persona.edad >= 2) {
            ninos++;
          } else {
            bebes++;
          }

          // Verificar si viaja el titular (parentesco_id = 1 generalmente indica titular)
          if (persona.parentesco_id === 1) {
            viaja_titular = true;
          }
        });

        // Formatear personas para la respuesta
        const personasFormateadas = personas.map(persona => ({
          id: persona.id,
          tipo_persona: {
            id: persona.tipo_persona_id,
            nombre: persona.tipo_persona_nombre
          },
          parentesco: {
            id: persona.parentesco_id,
            nombre: persona.parentesco_nombre
          },
          nombre: persona.nombre,
          apellido: persona.apellido,
          dni: persona.dni,
          fecha_nacimiento: persona.fecha_nacimiento,
          telefono: persona.telefono,
          edad: persona.edad,
          reserva_familiar_id: persona.reserva_familiar_id,
          tarifa_individual: persona.tarifa_individual,
          usa_porcentaje: persona.usa_porcentaje === 1 || persona.usa_porcentaje === true,
          porcentaje_descuento: persona.porcentaje_descuento
        }));

        const adicionalesReserva = await obtenerAdicionalesReserva(connection, reservaId);
        const adicionalesFormateados = adicionalesReserva.map(adicional => ({
          id: adicional.id,
          adicional_id: adicional.adicional_id,
          nombre: adicional.nombre,
          cantidad: adicional.cantidad,
          dias: adicional.dias,
          subtotal: Number(adicional.subtotal),
          fechas: adicional.fechas.map(fecha => ({
            fecha: fecha.fecha,
            cantidad: fecha.cantidad,
            precio_unitario: Number(fecha.precio_unitario),
            subtotal: Number(fecha.subtotal),
            tarifa_adicional_id: fecha.tarifa_adicional_id,
            porcentaje_descuento: fecha.porcentaje_descuento,
            tarifa_id: fecha.tarifa_id
          }))
        }));

        // Los datos médicos pertenecen al módulo Coseguro. Poder consultar la
        // reserva turística no habilita por sí solo a leerlos ni a firmar sus
        // certificados.
        const puedeVerSalud = puedeVerDatosSaludReserva(cabecera);
        let salud = null;
        if (puedeVerSalud && Number(reserva.es_por_salud) === 1) {
          const [saludRows] = await connection.query(
            `SELECT rs.id, rs.motivo, rs.centro_medico, rs.estado, rs.precio_cubierto, rs.observacion_resolucion,
                    rs.fecha_aprobacion_departamental, rs.fecha_resolucion, rs.fecha_creacion
             FROM reserva_salud rs WHERE rs.reserva_id = ?`,
            [reservaId]
          );
          if (saludRows.length > 0) {
            const [archivosSalud] = await connection.query(
              "SELECT id, archivo, nombre_original, mime, tamanio, fecha_creacion FROM reserva_salud_archivo WHERE reserva_salud_id = ? ORDER BY id",
              [saludRows[0].id]
            );
            const archivosFirmados = [];
            for (const archivo of archivosSalud) {
              let url = null;
              try {
                url = await getSignedFileUrlFromS3(archivo.archivo);
              } catch (error) {
                url = null;
              }
              archivosFirmados.push({ ...archivo, url });
            }
            salud = { ...saludRows[0], archivos: archivosFirmados };
          }
        }

        // Hilo de mensajes de la reserva (chat afiliado ↔ departamental/admin)
        const [observacionesHilo] = await connection.query(
          `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje, o.estado_reserva_id, o.fecha_creacion,
                  u.nombre AS usuario_nombre, u.apellido AS usuario_apellido, er.nombre AS estado_nombre
           FROM reserva_observacion o
           LEFT JOIN usuario u ON u.id = o.usuario_id
           LEFT JOIN estado_reserva er ON er.id = o.estado_reserva_id
           WHERE o.reserva_id = ?
           ORDER BY o.fecha_creacion ASC, o.id ASC`,
          [reservaId]
        );

        // Generar número de reserva
        const numeroReserva = `${reserva.id}`;

        // Generar URL de firma si existe
        let firmaUrl = null;
        if (reserva.firma_archivo) {
          try {
            firmaUrl = await getSignedFileUrlFromS3(reserva.firma_archivo);
          } catch (error) {
            console.error("Error generando URL firmada para firma de reserva:", error);
            firmaUrl = null;
          }
        }

        let convenioHotel = null;
        let convenioPropuesta = null;
        if (reserva.modalidad === MODALIDAD_CONVENIO && reserva.convenio_hotel_id) {
          const imagenesPorHotel = await obtenerImagenesConvenioPorHotel(connection, [reserva.convenio_hotel_id]);
          convenioHotel = await firmarConvenioHotel(
            {
              id: reserva.convenio_hotel_id,
              nombre: reserva.convenio_nombre,
              ciudad: reserva.convenio_ciudad,
              provincia: reserva.convenio_provincia,
              coordenadas_maps: reserva.convenio_coordenadas_maps,
              latitud: reserva.convenio_latitud,
              longitud: reserva.convenio_longitud,
              descripcion: reserva.convenio_descripcion,
              tarifario_pdf_archivo: reserva.convenio_tarifario_pdf_archivo,
              activo: 1,
            },
            imagenesPorHotel.get(Number(reserva.convenio_hotel_id)) || []
          );

          const columnaUsuarioDepartamentalPropuesta = await obtenerColumnaUsuarioDepartamentalPropuesta(connection);
          const selectUsuarioDepartamentalPropuesta = columnaUsuarioDepartamentalPropuesta
            ? `rcp.${columnaUsuarioDepartamentalPropuesta} AS departamental_usuario_id`
            : "NULL AS departamental_usuario_id";
          const [propuestas] = await connection.query(
            `
              SELECT
                rcp.id,
                rcp.mensaje,
                rcp.departamental_id,
                ${selectUsuarioDepartamentalPropuesta},
                rcp.respuesta,
                rcp.fecha_propuesta,
                DATE_ADD(rcp.fecha_propuesta, INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR) AS fecha_vencimiento,
                rcp.fecha_respuesta,
                d.nombre AS departamental_nombre
              FROM reserva_convenio_propuesta rcp
              LEFT JOIN departamental d ON d.id = rcp.departamental_id
              WHERE rcp.reserva_id = ?
              LIMIT 1
            `,
            [reservaId]
          );

          if (
            propuestas.length > 0 &&
            (propuestas[0].mensaje || propuestas[0].departamental_id || propuestas[0].departamental_usuario_id)
          ) {
            convenioPropuesta = {
              id: Number(propuestas[0].id),
              mensaje: propuestas[0].mensaje || "",
              departamental_id: propuestas[0].departamental_id ? Number(propuestas[0].departamental_id) : null,
              departamental_usuario_id: propuestas[0].departamental_usuario_id ? Number(propuestas[0].departamental_usuario_id) : null,
              departamental_nombre: propuestas[0].departamental_nombre || null,
              respuesta: propuestas[0].respuesta || "PENDIENTE",
              fecha_propuesta: propuestas[0].fecha_propuesta,
              fecha_vencimiento: propuestas[0].fecha_vencimiento,
              fecha_respuesta: propuestas[0].fecha_respuesta,
              plazo_respuesta_horas: PLAZO_RESPUESTA_HORAS,
            };
          }
        }

        // Construir respuesta
        const respuesta = {
          id: reserva.id,
          numero_reserva: numeroReserva,
          numero_parcela: reserva.numero_parcela !== null && reserva.numero_parcela !== undefined
            ? Number(reserva.numero_parcela)
            : null,
          nombre: reserva.observaciones || `Reserva ${numeroReserva}`,
          estado: reserva.estado || "Confirmada",
          fecha_creacion: reserva.fecha_creacion,
          fecha_vencimiento_respuesta: reserva.fecha_vencimiento_respuesta,
          plazo_respuesta_horas: PLAZO_RESPUESTA_HORAS,
          observaciones: reserva.observaciones,
          fecha_inicio: reserva.fecha_inicio,
          fecha_fin: reserva.fecha_fin,
          modalidad: reserva.modalidad || MODALIDAD_FECHA_LIBRE,
          sorteo_id: reserva.sorteo_id,
          sorteo_nombre: reserva.sorteo_nombre,
          bloque_fecha_id: reserva.bloque_fecha_id,
          bloque_nombre: reserva.bloque_nombre,
          servicio: {
            id: reserva.servicio_id,
            nombre: reserva.servicio_nombre || (convenioHotel ? "Convenio hotelero" : null)
          },
          lugar: reserva.lugar,
          recurso: {
            id: reserva.recurso_id || reserva.convenio_hotel_id || null,
            nombre: reserva.recurso_nombre || "Pendiente de adjudicación"
          },
          regimen: {
            id: reserva.regimen_id,
            nombre: reserva.regimen_nombre
          },
          personas: personasFormateadas,
          total_tarifa: reserva.total_tarifa,
          firma_url: firmaUrl,
          viaja_titular: viaja_titular,
          adultos: adultos,
          ninos: ninos,
          bebes: bebes,
          monto_adicionales: reserva.monto_adicionales || 0,
          adicionales: adicionalesFormateados,
          es_por_salud: puedeVerSalud && Number(reserva.es_por_salud) === 1,
          salud,
          observaciones_hilo: observacionesHilo
        };

        respuesta.convenio_hotel = convenioHotel;
        respuesta.convenio_propuesta = convenioPropuesta;
        if (convenioHotel) {
          respuesta.recurso.nombre = convenioHotel.nombre;
          respuesta.lugar = `${convenioHotel.ciudad}, ${convenioHotel.provincia}`;
        }

        res.status(200).json(respuesta);

      } catch (queryError) {
        throw queryError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el resumen de la reserva");
  }
});

// ---------------------------------------------------------------------------
// POST /reserva/:id/observaciones — hilo de chat de la reserva
// (mismo patrón que coseguro/traslados/olimpiadas)
// ---------------------------------------------------------------------------
router.post("/reserva/:id/observaciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!reservaId || !mensaje) {
      return res.status(400).json("El mensaje es obligatorio");
    }

    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT r.id, r.usuario_id, r.estado_reserva_id, ur.departamental_id AS usuario_departamental_id
       FROM reserva r
       LEFT JOIN usuario ur ON ur.id = r.usuario_id
       WHERE r.id = ?`,
      [reservaId]
    );
    if (rows.length === 0) return res.status(404).json("Reserva no encontrada");
    const reserva = rows[0];

    if (cabecera.rol === "afiliado" && Number(reserva.usuario_id) !== Number(cabecera.id)) {
      return res.status(403).json("No tienes permisos sobre esta reserva");
    }
    if (
      cabecera.rol === "departamental" &&
      Number(reserva.usuario_departamental_id) !== Number(cabecera.departamental_id)
    ) {
      return res.status(403).json("No tienes permisos sobre esta reserva");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      "INSERT INTO reserva_observacion (reserva_id, usuario_id, usuario_rol, mensaje, estado_reserva_id) VALUES (?, ?, ?, ?, ?)",
      [reservaId, cabecera.id, cabecera.rol, mensaje, reserva.estado_reserva_id]
    );

    await registrarHistorialReserva(connection, reservaId, "OBSERVACION", cabecera.id, req, null, mensaje);

    const autorEsAfiliado = cabecera.rol === "afiliado";
    const resumenMensaje = `${autorEsAfiliado ? "El afiliado" : "El equipo de la AJB"} escribió: ${mensaje}`;
    const payload = { reserva_id: reservaId, estado_reserva_id: reserva.estado_reserva_id };

    if (Number(reserva.usuario_id) !== Number(cabecera.id)) {
      await insertarNotificacion(
        connection,
        reserva.usuario_id,
        "RESERVA_OBSERVACION",
        `Nuevo mensaje en tu reserva #${reservaId}`,
        resumenMensaje,
        payload
      );
    }
    await notificarStaffTurismo(
      connection,
      reserva.usuario_departamental_id,
      "RESERVA_OBSERVACION",
      `Nuevo mensaje en la reserva #${reservaId}`,
      resumenMensaje,
      payload,
      cabecera.id
    );

    await connection.commit();
    res.status(201).json({ success: true, message: "Mensaje enviado" });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json("Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/reserva/:id/convenio/propuesta", verifyToken, async (req, res) => {
  let connection;
  let archivoReservaActivo = false;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "departamental"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    const mensaje = normalizarTexto(req.body.mensaje);
    const costos = parseArrayDesdeFormulario(req.body.costos);

    if (!reservaId || !mensaje || !Array.isArray(costos) || costos.length === 0) {
      return res.status(400).json("Mensaje y costos por persona son requeridos");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const reserva = await obtenerReservaConvenioParaAcceso(connection, reservaId, { forUpdate: true });
    if (!reserva) {
      await connection.rollback();
      return res.status(404).json("Reserva de convenio no encontrada");
    }
    if (!puedeGestionarReservaConvenio(cabecera, reserva) || cabecera.rol === "afiliado") {
      await connection.rollback();
      return res.status(403).json("No tienes permisos para gestionar esta reserva");
    }
    if (reserva.estado_nombre !== "Solicitud convenio") {
      throw crearErrorNegocio(
        "La solicitud ya no admite una nueva cotización",
        409,
        "CONVENIO_NO_COTIZABLE"
      );
    }

    const [propuestasExistentes] = await connection.query(
      `SELECT id, respuesta, fecha_propuesta, fecha_respuesta
         FROM reserva_convenio_propuesta
        WHERE reserva_id = ?
        LIMIT 1
        FOR UPDATE`,
      [reservaId]
    );
    if (propuestasExistentes.length > 0) {
      throw crearErrorNegocio(
        "La solicitud ya tiene una cotización registrada",
        409,
        "CONVENIO_PROPUESTA_EXISTENTE"
      );
    }

    const [familiares] = await connection.query(
      "SELECT id FROM reserva_familiar WHERE reserva_id = ?",
      [reservaId]
    );
    const idsFamiliares = familiares.map((row) => Number(row.id));
    const costosPorFamiliar = new Map();

    for (const item of costos) {
      const reservaFamiliarId = normalizarIdPositivo(item.reserva_familiar_id || item.id);
      const precioCentavos = decimalACentavos(item.precio);
      if (
        !reservaFamiliarId ||
        !idsFamiliares.includes(reservaFamiliarId) ||
        precioCentavos === null ||
        costosPorFamiliar.has(reservaFamiliarId)
      ) {
        await connection.rollback();
        return res.status(400).json("Los costos enviados no son validos");
      }
      costosPorFamiliar.set(reservaFamiliarId, precioCentavos);
    }

    if (costosPorFamiliar.size !== idsFamiliares.length) {
      await connection.rollback();
      return res.status(400).json("Debe cargar un costo para cada persona de la reserva");
    }

    await archivarVersionReservaAntesDeReemplazo(
      connection,
      reservaId,
      { id: cabecera.id, rol: cabecera.rol },
      "EDICION"
    );
    archivoReservaActivo = true;

    let precioTotalCentavos = 0;
    for (const familiarId of idsFamiliares) {
      const precioCentavos = costosPorFamiliar.get(familiarId);
      precioTotalCentavos = sumarCentavos(precioTotalCentavos, precioCentavos);
      if (precioTotalCentavos === null) {
        throw crearErrorNegocio("El total de la propuesta excede el máximo permitido", 422);
      }
      await connection.query(
        "UPDATE reserva_familiar SET precio = ? WHERE id = ? AND reserva_id = ?",
        [centavosANumero(precioCentavos), familiarId, reservaId]
      );
    }
    const precioTotal = centavosANumero(precioTotalCentavos);

    const estadoPropuestaId = await obtenerEstadoReservaId(
      connection,
      "Propuesta convenio",
      ESTADO_RESERVA_INICIADA_ID
    );

    const columnaUsuarioDepartamentalPropuesta = await obtenerColumnaUsuarioDepartamentalPropuesta(connection);
    const columnaUsuarioDepartamentalSql = columnaUsuarioDepartamentalPropuesta
      ? `, ${columnaUsuarioDepartamentalPropuesta}`
      : "";
    const valorUsuarioDepartamentalSql = columnaUsuarioDepartamentalPropuesta ? ", ?" : "";
    try {
      await connection.query(
        `
          INSERT INTO reserva_convenio_propuesta (
            reserva_id,
            mensaje,
            departamental_id
            ${columnaUsuarioDepartamentalSql},
            respuesta,
            fecha_propuesta,
            fecha_respuesta
          ) VALUES (?, ?, ?${valorUsuarioDepartamentalSql}, 'PENDIENTE', NOW(), NULL)
        `,
        [
          reservaId,
          mensaje,
          cabecera.departamental_id || null,
          ...(columnaUsuarioDepartamentalPropuesta ? [cabecera.id] : [])
        ]
      );
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        throw crearErrorNegocio(
          "La solicitud ya tiene una cotización registrada",
          409,
          "CONVENIO_PROPUESTA_EXISTENTE"
        );
      }
      throw error;
    }

    await connection.query(
      "UPDATE reserva SET precio_total = ?, estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ?",
      [precioTotal, estadoPropuestaId, reservaId]
    );

    const [plazosPropuesta] = await connection.query(
      `SELECT fecha_propuesta,
              DATE_ADD(fecha_propuesta, INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR) AS fecha_vencimiento
         FROM reserva_convenio_propuesta
        WHERE reserva_id = ?
        LIMIT 1`,
      [reservaId]
    );

    const payload = {
      reserva_id: reservaId,
      hotel_id: reserva.convenio_hotel_id,
      hotel_nombre: reserva.convenio_nombre,
      total: precioTotal,
      fecha_vencimiento: plazosPropuesta[0]?.fecha_vencimiento || null,
      plazo_respuesta_horas: PLAZO_RESPUESTA_HORAS,
    };
    await connection.query(
      `
        INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        reserva.usuario_id,
        TIPO_NOTIFICACION_CONVENIO_PROPUESTA,
        "Propuesta de cotización",
        `Ya tenes una propuesta de cotización para ${reserva.convenio_nombre || "tu convenio hotelero"}. Recordá responderla dentro de las 72 horas.`,
        JSON.stringify(payload),
      ]
    );

    await registrarHistorialReserva(
      connection,
      reservaId,
      "UPDATE",
      cabecera.id,
      req,
      [
        { campo: "precio_total", valorAnterior: reserva.precio_total, valorNuevo: precioTotal },
        { campo: "estado_reserva_id", valorAnterior: reserva.estado_reserva_id, valorNuevo: estadoPropuestaId },
        { campo: "reserva_convenio_propuesta.mensaje", valorAnterior: null, valorNuevo: mensaje },
      ],
      "Propuesta de cotización cargada"
    );

    await cerrarGuardiaArchivoReserva(connection, reservaId);
    archivoReservaActivo = false;
    await connection.commit();

    res.status(200).json({
      message: "Propuesta enviada",
      reserva_id: reservaId,
      precio_total: precioTotal,
      respuesta: "PENDIENTE",
      fecha_propuesta: plazosPropuesta[0]?.fecha_propuesta || null,
      fecha_vencimiento: plazosPropuesta[0]?.fecha_vencimiento || null,
      plazo_respuesta_horas: PLAZO_RESPUESTA_HORAS,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
      if (archivoReservaActivo) {
        try {
          await limpiarTokenGuardiaArchivoReserva(connection);
        } catch (_) {
          // La transacción ya revirtió el archivo y su guardia.
        }
      }
    }
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al enviar la propuesta de convenio");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/reserva/:id/convenio/respuesta", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "afiliado" || !tieneAreaTurismo(cabecera)) {
      return res.status(401).json("No autorizado");
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    const accion = String(req.body.accion || "").toUpperCase();
    if (!reservaId || !["ACEPTAR", "RECHAZAR"].includes(accion)) {
      return res.status(400).json("Accion invalida");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const reserva = await obtenerReservaConvenioParaAcceso(connection, reservaId, { forUpdate: true });
    if (!reserva) {
      await connection.rollback();
      return res.status(404).json("Reserva de convenio no encontrada");
    }
    if (Number(reserva.usuario_id) !== Number(cabecera.id)) {
      await connection.rollback();
      return res.status(403).json("No tienes permisos para responder esta reserva");
    }

    const [propuestas] = await connection.query(
      `SELECT *,
              DATE_ADD(fecha_propuesta, INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR) AS fecha_vencimiento,
              (fecha_propuesta <= DATE_SUB(NOW(), INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR)) AS vencida
         FROM reserva_convenio_propuesta
        WHERE reserva_id = ?
        LIMIT 1
        FOR UPDATE`,
      [reservaId]
    );
    if (propuestas.length === 0 || !propuestas[0].fecha_propuesta) {
      await connection.rollback();
      return res.status(409).json("La reserva no tiene una propuesta para responder");
    }
    if (propuestas[0].respuesta !== "PENDIENTE") {
      await connection.rollback();
      return res.status(409).json("La propuesta ya fue respondida");
    }

    if (Number(propuestas[0].vencida) === 1) {
      const estadoConvenioRechazadoId = await obtenerEstadoReservaId(
        connection,
        ESTADO_CONVENIO_RECHAZADO,
        ESTADO_RESERVA_RECHAZADA_ID
      );
      await expirarPropuestaConvenioEnTransaccion(
        connection,
        reserva,
        propuestas[0],
        estadoConvenioRechazadoId
      );
      await connection.commit();
      return res.status(409).json({
        message: "La propuesta vencio porque transcurrieron las 72 horas para responderla.",
        codigo: "PROPUESTA_CONVENIO_VENCIDA",
        reserva_id: reservaId,
        estado: ESTADO_CONVENIO_RECHAZADO,
        fecha_vencimiento: propuestas[0].fecha_vencimiento,
      });
    }

    const respuesta = accion === "ACEPTAR" ? "ACEPTADA" : "RECHAZADA";
    const estadoNombre = accion === "ACEPTAR" ? "Convenio aceptado" : "Convenio rechazado";
    const estadoId = await obtenerEstadoReservaId(
      connection,
      estadoNombre,
      accion === "ACEPTAR" ? ESTADO_RESERVA_INICIADA_ID : ESTADO_RESERVA_RECHAZADA_ID
    );

    await connection.query(
      `
        UPDATE reserva_convenio_propuesta
        SET respuesta = ?,
            fecha_respuesta = NOW()
        WHERE reserva_id = ?
      `,
      [respuesta, reservaId]
    );

    await connection.query(
      "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ?",
      [estadoId, reservaId]
    );

    await connection.query(
      `
        UPDATE notificacion
        SET leida = 1,
            fecha_lectura = COALESCE(fecha_lectura, NOW())
        WHERE usuario_id = ?
          AND tipo = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reserva_id')) = ?
      `,
      [cabecera.id, TIPO_NOTIFICACION_CONVENIO_PROPUESTA, String(reservaId)]
    );

    await registrarHistorialReserva(
      connection,
      reservaId,
      "UPDATE",
      cabecera.id,
      req,
      [
        { campo: "reserva_convenio_propuesta.respuesta", valorAnterior: "PENDIENTE", valorNuevo: respuesta },
        { campo: "estado_reserva_id", valorAnterior: reserva.estado_reserva_id, valorNuevo: estadoId },
      ],
      `Respuesta de propuesta de convenio: ${respuesta}`
    );

    await connection.commit();

    res.status(200).json({
      message: accion === "ACEPTAR" ? "Propuesta aceptada" : "Propuesta rechazada",
      reserva_id: reservaId,
      respuesta,
      estado: estadoNombre,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error al responder la propuesta de convenio");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/reserva/:id/estado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "departamental", "afiliado"].includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
      return res.status(403).json({ success: false, message: "No autorizado" });
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    const estado = typeof req.body?.estado === "string" ? req.body.estado.trim() : "";
    const estadosValidos = ["Verificada", "Aprobada", "Rechazada", "Cancelada"];
    if (!reservaId || !estadosValidos.includes(estado)) {
      return res.status(400).json({
        success: false,
        message: "Estado no válido. Debe ser Verificada, Aprobada, Rechazada o Cancelada",
      });
    }

    const observaciones = req.body?.observaciones;
    if (observaciones !== undefined && observaciones !== null && typeof observaciones !== "string") {
      return res.status(400).json({ success: false, message: "Las observaciones deben ser texto" });
    }
    const observacionesNormalizadas = typeof observaciones === "string" && observaciones.trim()
      ? observaciones.trim()
      : null;
    if (observacionesNormalizadas && Buffer.byteLength(observacionesNormalizadas, "utf8") > 65535) {
      return res.status(400).json({ success: false, message: "Las observaciones son demasiado extensas" });
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [reservas] = await connection.query(
      `SELECT r.*, er.nombre AS estado_nombre,
              u.departamental_id AS usuario_departamental_id
         FROM reserva r
         LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
         INNER JOIN usuario u ON u.id = r.usuario_id
        WHERE r.id = ?
        FOR UPDATE`,
      [reservaId]
    );
    if (reservas.length === 0) {
      throw crearErrorNegocio("Reserva no encontrada", 404, "RESERVA_NO_ENCONTRADA");
    }

    const reservaActual = reservas[0];
    if (cabecera.rol === "departamental") {
      const [editores] = await connection.query(
        "SELECT departamental_id FROM usuario WHERE id = ? LIMIT 1",
        [cabecera.id]
      );
      const departamentalEditorId = normalizarIdPositivo(editores[0]?.departamental_id);
      const departamentalReservaId = normalizarIdPositivo(reservaActual.usuario_departamental_id);
      if (!departamentalEditorId || departamentalEditorId !== departamentalReservaId) {
        throw crearErrorNegocio(
          "No puedes gestionar reservas de otra departamental",
          403,
          "RESERVA_OTRA_DEPARTAMENTAL"
        );
      }
    }

    const transicion = validarTransicionTurismo({
      rol: cabecera.rol,
      usuarioId: cabecera.id,
      propietarioId: reservaActual.usuario_id,
      estadoActual: reservaActual.estado_nombre,
      estadoSolicitado: estado,
      modalidad: reservaActual.modalidad,
    });
    if (!transicion.valido) {
      throw crearErrorNegocio(transicion.mensaje, transicion.statusCode, transicion.codigo);
    }

    const fallbackEstadoId = transicion.estadoDestino === ESTADO_VERIFICADA
      ? 2
      : (transicion.estadoDestino === ESTADO_APROBADA ? 3 : ESTADO_RESERVA_RECHAZADA_ID);
    const estadoId = await obtenerEstadoReservaId(
      connection,
      transicion.estadoDestino,
      fallbackEstadoId
    );

    const cambios = [{
      campo: "estado_reserva_id",
      valorAnterior: reservaActual.estado_reserva_id,
      valorNuevo: estadoId,
    }];
    if (
      observacionesNormalizadas !== null &&
      String(reservaActual.observaciones || "") !== observacionesNormalizadas
    ) {
      cambios.push({
        campo: "observaciones",
        valorAnterior: reservaActual.observaciones || "",
        valorNuevo: observacionesNormalizadas,
      });
    }

    const [actualizacion] = await connection.query(
      `UPDATE reserva
          SET estado_reserva_id = ?,
              observaciones = COALESCE(?, observaciones),
              fecha_modificacion = NOW()
        WHERE id = ? AND estado_reserva_id = ?`,
      [estadoId, observacionesNormalizadas, reservaId, reservaActual.estado_reserva_id]
    );
    if (actualizacion.affectedRows !== 1) {
      throw crearErrorNegocio("La reserva cambió de estado. Volvé a cargarla.", 409, "RESERVA_MODIFICADA");
    }

    await registrarHistorialReserva(
      connection,
      reservaId,
      "UPDATE",
      cabecera.id,
      req,
      cambios,
      `Cambio de estado: ${reservaActual.estado_nombre} → ${transicion.estadoDestino}`
    );

    if (transicion.estadoDestino === ESTADO_RECHAZADA) {
      await liberarRecursoBloqueReserva(connection, reservaId);
      await connection.query(
        `UPDATE sorteo_adjudicacion_respuesta
            SET estado = 'RECHAZADA', fecha_respuesta = COALESCE(fecha_respuesta, NOW())
          WHERE reserva_id = ? AND estado = 'PENDIENTE'`,
        [reservaId]
      );
    }

    const mensajes = {
      [ESTADO_VERIFICADA]: "Tu reserva fue verificada por Turismo y ahora espera la aprobación de un administrador.",
      [ESTADO_APROBADA]: "Tu reserva fue aprobada.",
      [ESTADO_RECHAZADA]: observacionesNormalizadas
        ? `Tu reserva fue rechazada. Motivo: ${observacionesNormalizadas}`
        : "Tu reserva fue rechazada.",
    };
    if (Number(reservaActual.usuario_id) !== Number(cabecera.id)) {
      await insertarNotificacion(
        connection,
        reservaActual.usuario_id,
        `RESERVA_${transicion.accion}`,
        `Reserva #${reservaId}: ${transicion.estadoDestino}`,
        mensajes[transicion.estadoDestino],
        { reserva_id: reservaId, estado: transicion.estadoDestino }
      );
    } else if (cabecera.rol === "afiliado") {
      await notificarStaffTurismo(
        connection,
        reservaActual.usuario_departamental_id,
        "RESERVA_CANCELADA_AFILIADO",
        `Reserva #${reservaId} cancelada por el afiliado`,
        observacionesNormalizadas || "El afiliado canceló la reserva iniciada.",
        { reserva_id: reservaId, estado: transicion.estadoDestino },
        cabecera.id
      );
    }
    if (transicion.estadoDestino === ESTADO_VERIFICADA) {
      await notificarAdministradoresTurismo(
        connection,
        "RESERVA_PARA_APROBAR",
        `Reserva #${reservaId} verificada`,
        "Turismo verificó la reserva. Ya está disponible para aprobación administrativa.",
        { reserva_id: reservaId, estado: ESTADO_VERIFICADA },
        cabecera.id
      );
    }

    await connection.commit();
    return res.status(200).json({
      success: true,
      message: `Reserva ${transicion.estadoDestino.toLowerCase()} exitosamente`,
      reserva: {
        id: reservaId,
        numero_reserva: `RES-${reservaId.toString().padStart(6, "0")}`,
        estado: transicion.estadoDestino,
        fecha_actualizacion: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        codigo: error.codigo || null,
      });
    }
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor al actualizar el estado de la reserva",
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/acompaniantes/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      (cabecera.rol === "departamental" && tieneAreaTurismo(cabecera))
    ) {
      const db = mysqlConnection.promise();
      const usuario_id = normalizarIdPositivo(req.query.usuario_id);
      const specific_id = normalizarIdPositivo(req.params.id); // ID específico opcional

      if (req.params.id !== undefined && specific_id === null) {
        return res.status(400).json("ID de acompañante inválido");
      }

      // Si viene un ID específico, devolver directamente ese usuario
      if (specific_id) {
        if (!(await puedeAccederUsuarioRelacionado(db, cabecera, specific_id))) {
          return res.status(403).json("No autorizado para consultar esta persona");
        }
        const [usuario] = await db.query(
            `SELECT 
              u.id,
              u.nombre,
              u.apellido,
              u.documento,
              u.fecha_nacimiento,
              u.telefono,
              u.parentesco_id,
              u.tipo_persona_id,
              TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) as edad
            FROM usuario u
            WHERE u.id = ?`,
            [specific_id]
          );

        if (usuario.length === 0) {
          return res.status(404).json("No se encontró el acompañante con el ID especificado");
        }

        return res.status(200).json(usuario[0]);
      }

      // Lógica original cuando no viene ID específico
      const adultos = normalizarEnteroNoNegativoOpcional(req.query.adultos, 100);
      const ninos = normalizarEnteroNoNegativoOpcional(req.query.ninos, 100);
      const bebes = normalizarEnteroNoNegativoOpcional(req.query.bebes, 100);
      if ([adultos, ninos, bebes].some((cantidad) => cantidad === undefined)) {
        return res.status(400).json("Las cantidades de personas son inválidas");
      }

      if (!usuario_id) {
        return res.status(400).json("Falta el parámetro 'usuario_id'");
      }
      if (!(await puedeAccederUsuarioRelacionado(db, cabecera, usuario_id))) {
        return res.status(403).json("No autorizado para consultar este grupo familiar");
      }

      // Construir filtros de edad basados en fecha de nacimiento
      let ageFilters = [];

      // Si adultos > 0, incluir personas mayores de 5 años
      if (adultos && adultos > 0) {
        ageFilters.push("TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) > 5");
      }

      // Si niños > 0, incluir personas entre 2 y 5 años
      if (ninos && ninos > 0) {
        ageFilters.push("(TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) >= 2 AND TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) <= 5)");
      }

      // Si bebés > 0, incluir personas menores de 2 años
      if (bebes && bebes > 0) {
        ageFilters.push("TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) < 2");
      }

      // Si no se especifica ningún filtro de edad, no aplicar filtros
      const ageFilterClause = ageFilters.length > 0 ? `AND (${ageFilters.join(' OR ')})` : '';

      // Obtener información del usuario principal
      const [usuarioPrincipal] = await mysqlConnection
        .promise()
        .query(
          "SELECT id, usuario_familiar_id FROM usuario WHERE id = ?",
          [usuario_id]
        );

      if (usuarioPrincipal.length === 0) {
        return res.status(404).json("Usuario no encontrado");
      }

      const acompaniantes = new Map(); // Usar Map para evitar duplicados por usuario_id

      // 1. Obtener familiares directos (que tienen usuario_familiar_id = usuario_id)
      const [familiares] = await mysqlConnection
        .promise()
        .query(
          `SELECT 
            u.id as usuario_id,
            u.nombre,
            u.apellido,
            u.documento,
            u.fecha_nacimiento,
            u.telefono,
            u.parentesco_id,
            u.tipo_persona_id,
            TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) as edad
          FROM usuario u
          WHERE u.usuario_familiar_id = ? ${ageFilterClause}`,
          [usuario_id]
        );

      familiares.forEach(familiar => {
        acompaniantes.set(familiar.usuario_id, familiar);
      });

      // 2. Obtener el usuario familiar principal (si el usuario actual tiene usuario_familiar_id)
      if (usuarioPrincipal[0].usuario_familiar_id) {
        const [familiarPrincipal] = await mysqlConnection
          .promise()
          .query(
            `SELECT 
              u.id as usuario_id,
              u.nombre,
              u.apellido,
              u.documento,
              u.fecha_nacimiento,
              u.telefono,
              u.parentesco_id,
              u.tipo_persona_id,
              TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) as edad
            FROM usuario u
            WHERE u.id = ? ${ageFilterClause}`,
            [usuarioPrincipal[0].usuario_familiar_id]
          );

        if (familiarPrincipal.length > 0) {
          acompaniantes.set(familiarPrincipal[0].usuario_id, familiarPrincipal[0]);
        }
      }

      // 3. Obtener personas que han compartido reservas
      const [companierosReserva] = await mysqlConnection
        .promise()
        .query(
          `SELECT DISTINCT
            u.id as usuario_id,
            u.nombre,
            u.apellido,
            u.documento,
            u.fecha_nacimiento,
            u.telefono,
            u.parentesco_id,
            u.tipo_persona_id,
            TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) as edad
          FROM usuario u
          INNER JOIN reserva_familiar rf ON u.id = rf.usuario_id
          WHERE rf.reserva_id IN (
            SELECT reserva_id 
            FROM reserva_familiar 
            WHERE usuario_id = ?
          )
          AND u.id != ? ${ageFilterClause}`,
          [usuario_id, usuario_id]
        );

      companierosReserva.forEach(companiero => {
        // Si no existe ya en acompañantes, agregarlo
        if (!acompaniantes.has(companiero.usuario_id)) {
          acompaniantes.set(companiero.usuario_id, companiero);
        }
      });

      // Convertir Map a Array
      const resultado = Array.from(acompaniantes.values());

      res.status(200).json(resultado);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los acompañantes");
  }
});

router.put("/acompaniantes/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      (cabecera.rol === "departamental" && tieneAreaTurismo(cabecera))
    ) {
      const { usuarioId, personas } = req.body;
      const specific_id = normalizarIdPositivo(req.params.id);

      // Si viene un ID específico, actualizar directamente ese usuario
      if (specific_id) {
        let persona;

        if (req.body.nombre && req.body.apellido) {
          persona = req.body;
        } else if (personas && Array.isArray(personas) && personas.length > 0) {
          persona = personas[0];
        } else {
          return res.status(400).json({
            success: false,
            message: "Faltan datos de la persona a actualizar"
          });
        }

        if (!persona.nombre || !persona.apellido) {
          return res.status(400).json({
            success: false,
            message: "Nombre y apellido son requeridos"
          });
        }

        let fechaFormateada = formatearFechaSQL(persona.fecha_nacimiento);
        let tipoPersonaId = normalizarIdPositivo(persona.tipo_persona_id);
        let parentescoId = persona.parentesco_id ? normalizarIdPositivo(persona.parentesco_id) : null;
        if (!fechaFormateada || !tipoPersonaId || (persona.parentesco_id && !parentescoId)) {
          return res.status(400).json({ success: false, message: "Fecha, parentesco o tipo de persona no válido" });
        }

        let connection;
        try {
          connection = await mysqlConnection.promise().getConnection();
          await connection.beginTransaction();

          // Obtener datos anteriores del usuario para el historial
          const [usuarioAnterior] = await connection.query(
            "SELECT * FROM usuario WHERE id = ? FOR UPDATE",
            [specific_id]
          );

          if (usuarioAnterior.length === 0) {
            throw crearErrorNegocio("Usuario no encontrado", 404);
          }
          if (!(await puedeAccederUsuarioRelacionado(connection, cabecera, specific_id))) {
            throw crearErrorNegocio("No tienes permisos para modificar esta persona", 403);
          }

          const datosAnteriores = usuarioAnterior[0];
          if (cabecera.rol === "afiliado") {
            fechaFormateada = formatearFechaSQL(datosAnteriores.fecha_nacimiento);
            tipoPersonaId = normalizarIdPositivo(datosAnteriores.tipo_persona_id);
            parentescoId = normalizarIdPositivo(datosAnteriores.parentesco_id);
          }

          // Preparar campos para comparar cambios
          const cambios = [];

          if (datosAnteriores.nombre !== persona.nombre) {
            cambios.push({
              campo: 'nombre',
              valorAnterior: datosAnteriores.nombre,
              valorNuevo: persona.nombre
            });
          }

          if (datosAnteriores.apellido !== persona.apellido) {
            cambios.push({
              campo: 'apellido',
              valorAnterior: datosAnteriores.apellido,
              valorNuevo: persona.apellido
            });
          }

          if (datosAnteriores.fecha_nacimiento !== fechaFormateada) {
            cambios.push({
              campo: 'fecha_nacimiento',
              valorAnterior: datosAnteriores.fecha_nacimiento,
              valorNuevo: fechaFormateada
            });
          }

          if (datosAnteriores.telefono !== (persona.telefono || null)) {
            cambios.push({
              campo: 'telefono',
              valorAnterior: datosAnteriores.telefono,
              valorNuevo: persona.telefono || null
            });
          }

          if (Number(datosAnteriores.parentesco_id || 0) !== Number(parentescoId || 0)) {
            cambios.push({
              campo: 'parentesco_id',
              valorAnterior: datosAnteriores.parentesco_id,
              valorNuevo: parentescoId
            });
          }

          if (Number(datosAnteriores.tipo_persona_id) !== tipoPersonaId) {
            cambios.push({
              campo: 'tipo_persona_id',
              valorAnterior: datosAnteriores.tipo_persona_id,
              valorNuevo: tipoPersonaId
            });
          }

          // Preparar los campos para actualizar
          let updateFields = [
            "nombre = ?",
            "apellido = ?",
            "fecha_nacimiento = ?",
            "telefono = ?",
            "parentesco_id = ?",
            "tipo_persona_id = ?"
          ];

          let updateValues = [
            persona.nombre,
            persona.apellido,
            fechaFormateada,
            persona.telefono || null,
            parentescoId,
            tipoPersonaId
          ];

          // Si viene password, hashearlo y agregarlo a la actualización
          if (persona.password && (cabecera.rol === "admin" || Number(cabecera.id) === specific_id)) {
            let passwordHash = await bcryptjs.hash(persona.password, 8);
            updateFields.push("password = ?");
            updateValues.push(passwordHash);

            cambios.push({
              campo: 'password',
              valorAnterior: '[OCULTO]',
              valorNuevo: '[MODIFICADO]'
            });
          }

          updateValues.push(specific_id);
          const updateQuery = `UPDATE usuario SET ${updateFields.join(', ')} WHERE id = ?`;

          const [result] = await connection.query(updateQuery, updateValues);

          // Registrar cambios en el historial si hubo modificaciones
          if (cambios.length > 0) {
            await registrarHistorial(
              connection,
              specific_id,
              'UPDATE',
              'usuario',
              cabecera.id,
              req,
              cambios,
              'Usuario actualizado directamente por ID'
            );
          }

          await connection.commit();

          return res.status(200).json({
            success: result.affectedRows > 0,
            message: result.affectedRows > 0 ? "Usuario actualizado correctamente" : "No se encontró el usuario o no se realizaron cambios"
          });

        } catch (updateError) {
          if (connection) {
            await connection.rollback();
          }
          throw updateError;
        } finally {
          if (connection) {
            connection.release();
          }
        }
      }

      // Lógica original cuando no viene ID específico
      if (!usuarioId || !personas || !Array.isArray(personas) || personas.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Faltan datos requeridos o el array de personas está vacío"
        });
      }

      const usuarioObjetivoId = normalizarIdPositivo(usuarioId);
      if (!usuarioObjetivoId) {
        return res.status(400).json({ success: false, message: "El usuario indicado no es válido" });
      }
      if (cabecera.rol === "afiliado" && Number(cabecera.id) !== usuarioObjetivoId) {
        return res.status(403).json({
          success: false,
          message: "No tienes permisos para modificar los datos de este usuario"
        });
      }

      let connection;
      try {
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();
        if (!(await puedeAccederUsuarioRelacionado(connection, cabecera, usuarioObjetivoId))) {
          throw crearErrorNegocio("No tienes permisos para modificar este grupo familiar", 403);
        }

        let usuariosModificados = 0;
        const errores = [];

        // Procesar cada persona
        for (const persona of personas) {
          try {
            if (!persona.dni) {
              errores.push(`Persona ${persona.nombre} ${persona.apellido}: DNI es requerido`);
              continue;
            }

            // Buscar usuario por documento y obtener todos sus datos para el historial
            const [usuarioExistente] = await connection.query(
              `SELECT * FROM usuario WHERE documento = ?`,
              [persona.dni]
            );

            if (usuarioExistente.length === 0) {
              continue;
            }

            const usuario = usuarioExistente[0];

            // Verificar permisos
            const tienePermisos = await puedeAccederUsuarioRelacionado(connection, cabecera, usuario.id);

            if (!tienePermisos) {
              errores.push(`Persona ${persona.nombre} ${persona.apellido}: No tienes permisos para modificar este usuario`);
              continue;
            }

            // Función auxiliar para normalizar fechas
            const normalizarFecha = (fecha) => formatearFechaSQL(fecha);
            let fechaNacimiento = normalizarFecha(persona.fechaNacimiento);
            let parentescoId = persona.parentescoId ? normalizarIdPositivo(persona.parentescoId) : null;
            let tipoPersonaId = normalizarIdPositivo(persona.tipoPersonaId);
            if (!fechaNacimiento || !tipoPersonaId || (persona.parentescoId && !parentescoId)) {
              errores.push(`Persona ${persona.nombre} ${persona.apellido}: fecha, parentesco o tipo inválido`);
              continue;
            }
            if (cabecera.rol === "afiliado") {
              fechaNacimiento = normalizarFecha(usuario.fecha_nacimiento);
              parentescoId = normalizarIdPositivo(usuario.parentesco_id);
              tipoPersonaId = normalizarIdPositivo(usuario.tipo_persona_id);
            }

            // Función auxiliar para normalizar teléfonos
            const normalizarTelefono = (telefono) => {
              return String(telefono || '').trim();
            };

            // Preparar campos para comparar cambios
            const cambios = [];

            if (usuario.nombre !== persona.nombre) {
              cambios.push({
                campo: 'nombre',
                valorAnterior: usuario.nombre,
                valorNuevo: persona.nombre
              });
            }

            if (usuario.apellido !== persona.apellido) {
              cambios.push({
                campo: 'apellido',
                valorAnterior: usuario.apellido,
                valorNuevo: persona.apellido
              });
            }

            if (normalizarFecha(usuario.fecha_nacimiento) !== fechaNacimiento) {
              cambios.push({
                campo: 'fecha_nacimiento',
                valorAnterior: normalizarFecha(usuario.fecha_nacimiento),
                valorNuevo: fechaNacimiento
              });
            }

            if (normalizarTelefono(usuario.telefono) !== normalizarTelefono(persona.telefono)) {
              cambios.push({
                campo: 'telefono',
                valorAnterior: usuario.telefono,
                valorNuevo: persona.telefono || null
              });
            }

            if (Number(usuario.parentesco_id || 0) !== Number(parentescoId || 0)) {
              cambios.push({
                campo: 'parentesco_id',
                valorAnterior: usuario.parentesco_id,
                valorNuevo: parentescoId
              });
            }

            if (Number(usuario.tipo_persona_id) !== tipoPersonaId) {
              cambios.push({
                campo: 'tipo_persona_id',
                valorAnterior: usuario.tipo_persona_id,
                valorNuevo: tipoPersonaId
              });
            }

            // Verificar si hay cambios
            if (cambios.length > 0) {
              // Actualizar el usuario
              await connection.query(
                `UPDATE usuario SET 
                   nombre = ?, 
                   apellido = ?, 
                   fecha_nacimiento = ?, 
                   telefono = ?, 
                   parentesco_id = ?,
                   tipo_persona_id = ?
                 WHERE id = ?`,
                [
                  persona.nombre,
                  persona.apellido,
                  fechaNacimiento,
                  persona.telefono || null,
                  parentescoId,
                  tipoPersonaId,
                  usuario.id
                ]
              );

              // Registrar cambios en el historial
              await registrarHistorial(
                connection,
                usuario.id,
                'UPDATE',
                'usuario',
                cabecera.id,
                req,
                cambios,
                'Usuario actualizado mediante gestión de acompañantes'
              );

              usuariosModificados++;
            }

          } catch (personaError) {
            errores.push(`Error procesando ${persona.nombre} ${persona.apellido}: ${personaError.message}`);
          }
        }

        await connection.commit();

        const success = usuariosModificados > 0;
        let message = "";

        if (success) {
          message = `Se actualizaron ${usuariosModificados} usuario(s) correctamente`;
          if (errores.length > 0) {
            message += `. Errores: ${errores.join('; ')}`;
          }
        } else {
          if (errores.length > 0) {
            message = `No se pudo actualizar ningún usuario. Errores: ${errores.join('; ')}`;
          } else {
            message = "No se encontraron usuarios para actualizar o no había cambios";
          }
        }

        res.status(200).json({
          success,
          message
        });

      } catch (transactionError) {
        if (connection) {
          await connection.rollback();
        }
        throw transactionError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json({
        success: false,
        message: "No autorizado"
      });
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    res.status(500).json({
      success: false,
      message: "Error interno del servidor"
    });
  }
});

router.get("/regimen", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (
    (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) && tieneAreaTurismo(cabecera)
  ) {
    try {
      const servicioId = req.query.servicio;
      if (!servicioId) {
        return res.status(400).json("Falta el parámetro 'servicio'");
      }
      const [rows] = await mysqlConnection
        .promise()
        .query(
          `SELECT r.id, r.nombre
           FROM regimen r
           INNER JOIN servicio_regimen sr ON r.id = sr.regimen_id
           WHERE sr.servicio_id = ?
           ORDER BY r.nombre ASC`,
          [servicioId]
        );
      res.status(200).json(rows);
    } catch (error) {
      registrarErrorRuta(error);
      res.status(500).json("Error al obtener los regimenes");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/tipo_persona", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM tipo_persona order by nombre asc");
      res.status(200).json(rows);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los tipos de persona");
  }
});

router.get("/parentesco", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM parentesco order by nombre asc");
      res.status(200).json(rows);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los parentescos");
  }
});

router.get("/departamental", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const query = `
      SELECT 
        id,
        nombre,
        direccion,
        localidad,
        provincia,
        ST_Y(coordenadas) AS latitud,
        ST_X(coordenadas) AS longitud,
        habilitado,
        DATE_FORMAT(fecha_creacion, '%d/%m/%Y %T') AS fecha_creacion,
        DATE_FORMAT(fecha_modificacion, '%d/%m/%Y %T') AS fecha_modificacion
      FROM departamental
    `;

    const [rows] = await mysqlConnection.promise().query(query);

    res.status(200).json(rows);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

router.post("/tabla/departamentales", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    // Solo admin puede consultar la tabla completa
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    let buscar = req.query.search;
    const paginacion = normalizarPaginacion(req.query, 10);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize: resultsPerPage, start } = paginacion;

    const columnasOrdenDepartamentales = {
      id: "d.id",
      nombre: "d.nombre",
      direccion: "d.direccion",
      localidad: "d.localidad",
      provincia: "d.provincia",
      habilitado: "d.habilitado",
      fecha_creacion: "d.fecha_creacion",
      fecha_modificacion: "d.fecha_modificacion",
    };
    const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenDepartamentales, req.query.orderBy)
      ? req.query.orderBy
      : "fecha_creacion";
    const orderBy = columnasOrdenDepartamentales[orderByKey];
    const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

    // Obtener filtros del body
    const filters = req.body || {};
    const { habilitado, fecha_creacion_minima, fecha_creacion_maxima } = filters;

    const queryOrderBy = `${orderBy} ${orderType}`;

    // Filtro de búsqueda general
    let queryBuscar = "";
    const queryBuscarParams = [];
    if (buscar) {
      const like = `%${buscar}%`;
      queryBuscar = `AND (CAST(d.id AS CHAR) LIKE ? OR d.nombre LIKE ? OR d.direccion LIKE ? OR d.localidad LIKE ? OR d.provincia LIKE ?)`;
      queryBuscarParams.push(...Array(5).fill(like));
    }

    // Construcción de filtros específicos
    let whereConditions = [];
    let queryParams = [];

    // Filtro por habilitado
    if (habilitado === 'Y' || habilitado === 'N') {
      whereConditions.push(`d.habilitado = ?`);
      queryParams.push(habilitado);
    }

    // Filtro por fecha de creación mínima
    if (fecha_creacion_minima) {
      whereConditions.push(`DATE(d.fecha_creacion) >= ?`);
      queryParams.push(fecha_creacion_minima);
    }

    // Filtro por fecha de creación máxima
    if (fecha_creacion_maxima) {
      whereConditions.push(`DATE(d.fecha_creacion) <= ?`);
      queryParams.push(fecha_creacion_maxima);
    }

    // Construcción de la cláusula WHERE
    let whereClause = "";
    if (whereConditions.length > 0) {
      whereClause = "AND " + whereConditions.join(" AND ");
    }

    let query = `
      SELECT
        d.id,
        d.nombre,
        d.direccion,
        d.localidad,
        d.provincia,
        d.habilitado,
        DATE_FORMAT(d.fecha_creacion, '%d/%m/%Y %T') AS fecha_creacion
      FROM departamental d
      WHERE 1=1
        ${queryBuscar}
        ${whereClause}
      ORDER BY ${queryOrderBy}, d.id DESC
      LIMIT ${start}, ${resultsPerPage}
    `;

    const [rows] = await mysqlConnection.promise().execute(query, [...queryBuscarParams, ...queryParams]);

    // Query para contar el total de registros
    let countQuery = `
      SELECT COUNT(*) AS count
      FROM departamental d
      WHERE 1=1
        ${queryBuscar}
        ${whereClause}
    `;

    const [countRows] = await mysqlConnection.promise().execute(countQuery, [...queryBuscarParams, ...queryParams]);

    const numOfResults = countRows[0].count;
    const numOfPages = Math.ceil(numOfResults / resultsPerPage);

    res.json({
      results: rows,
      numOfPages,
      totalItems: numOfResults,
      page: page - 1,
      orderBy: orderByKey,
      orderType,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

// GET /departamental/:id - Obtiene una departamental por ID
router.get("/departamental/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const { id } = req.params;

    const query = `
      SELECT
        id,
        nombre,
        direccion,
        localidad,
        provincia,
        ST_Y(coordenadas) AS latitud,
        ST_X(coordenadas) AS longitud,
        habilitado,
        DATE_FORMAT(fecha_creacion, '%d/%m/%Y %T') AS fecha_creacion,
        DATE_FORMAT(fecha_modificacion, '%d/%m/%Y %T') AS fecha_modificacion
      FROM departamental
      WHERE id = ?
    `;

    const [rows] = await mysqlConnection.promise().execute(query, [id]);

    if (rows.length === 0) {
      return res.status(404).json("Departamental no encontrada");
    }

    res.status(200).json(rows[0]);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

// Función auxiliar para guardar historial de cambios en departamentales
async function guardarHistorialDepartamental(connection, departamentalId, usuarioId, operacion, campoAfectado, valorAnterior, valorNuevo) {
  try {
    await connection.query(
      `INSERT INTO historial_departamental
       (departamental_id, usuario_id, operacion, campo_afectado, valor_anterior, valor_nuevo, fecha_cambio)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [departamentalId, usuarioId, operacion, campoAfectado, valorAnterior, valorNuevo]
    );
  } catch (error) {
    console.error("Error al guardar historial departamental:", error);
    // No lanzamos el error para que no afecte la operación principal
  }
}

// POST /departamental - Crea una nueva departamental
router.post("/departamental", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const { nombre, direccion, localidad, provincia, latitud, longitud, habilitado } = req.body;

    // Validaciones
    if (!nombre || !direccion || !localidad || !provincia || latitud === undefined || longitud === undefined || !habilitado) {
      return res.status(400).json("Faltan campos obligatorios");
    }

    if (habilitado !== 'Y' && habilitado !== 'N') {
      return res.status(400).json("El campo habilitado debe ser 'Y' o 'N'");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    try {
      const query = `
        INSERT INTO departamental (nombre, direccion, localidad, provincia, coordenadas, habilitado, fecha_creacion, fecha_modificacion)
        VALUES (?, ?, ?, ?, POINT(?, ?), ?, NOW(), NOW())
      `;

      const [result] = await connection.query(query, [
        nombre,
        direccion,
        localidad,
        provincia,
        longitud,
        latitud,
        habilitado
      ]);

      const departamentalId = result.insertId;

      // Guardar historial de creación
      await guardarHistorialDepartamental(
        connection,
        departamentalId,
        cabecera.id,
        'CREATE',
        'departamental',
        null,
        JSON.stringify({
          nombre,
          direccion,
          localidad,
          provincia,
          latitud,
          longitud,
          habilitado
        })
      );

      // Obtener la departamental recién creada
      const selectQuery = `
        SELECT
          id,
          nombre,
          direccion,
          localidad,
          provincia,
          ST_Y(coordenadas) AS latitud,
          ST_X(coordenadas) AS longitud,
          habilitado,
          DATE_FORMAT(fecha_creacion, '%d/%m/%Y %T') AS fecha_creacion,
          DATE_FORMAT(fecha_modificacion, '%d/%m/%Y %T') AS fecha_modificacion
        FROM departamental
        WHERE id = ?
      `;

      const [rows] = await connection.query(selectQuery, [departamentalId]);

      await connection.commit();
      connection.release();

      res.status(201).json(rows[0]);
    } catch (error) {
      await connection.rollback();
      connection.release();
      throw error;
    }
  } catch (error) {
    if (connection) {
      connection.release();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

// PUT /departamental/:id - Actualiza una departamental existente
router.put("/departamental/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const { id } = req.params;
    const { nombre, direccion, localidad, provincia, latitud, longitud, habilitado } = req.body;

    // Validaciones
    if (!nombre || !direccion || !localidad || !provincia || latitud === undefined || longitud === undefined || !habilitado) {
      return res.status(400).json("Faltan campos obligatorios");
    }

    if (habilitado !== 'Y' && habilitado !== 'N') {
      return res.status(400).json("El campo habilitado debe ser 'Y' o 'N'");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    try {
      // Verificar que la departamental existe y obtener datos anteriores
      const checkQuery = `
        SELECT
          nombre,
          direccion,
          localidad,
          provincia,
          ST_Y(coordenadas) AS latitud,
          ST_X(coordenadas) AS longitud,
          habilitado
        FROM departamental
        WHERE id = ?
      `;
      const [existing] = await connection.query(checkQuery, [id]);

      if (existing.length === 0) {
        connection.release();
        return res.status(404).json("Departamental no encontrada");
      }

      const datosAnteriores = existing[0];

      // Actualizar la departamental
      const query = `
        UPDATE departamental
        SET nombre = ?,
            direccion = ?,
            localidad = ?,
            provincia = ?,
            coordenadas = POINT(?, ?),
            habilitado = ?,
            fecha_modificacion = NOW()
        WHERE id = ?
      `;

      await connection.query(query, [
        nombre,
        direccion,
        localidad,
        provincia,
        longitud,
        latitud,
        habilitado,
        id
      ]);

      // Registrar cambios individuales en el historial
      if (datosAnteriores.nombre !== nombre) {
        await guardarHistorialDepartamental(
          connection,
          id,
          cabecera.id,
          'UPDATE',
          'nombre',
          datosAnteriores.nombre,
          nombre
        );
      }

      if (datosAnteriores.direccion !== direccion) {
        await guardarHistorialDepartamental(
          connection,
          id,
          cabecera.id,
          'UPDATE',
          'direccion',
          datosAnteriores.direccion,
          direccion
        );
      }

      if (datosAnteriores.localidad !== localidad) {
        await guardarHistorialDepartamental(
          connection,
          id,
          cabecera.id,
          'UPDATE',
          'localidad',
          datosAnteriores.localidad,
          localidad
        );
      }

      if (datosAnteriores.provincia !== provincia) {
        await guardarHistorialDepartamental(
          connection,
          id,
          cabecera.id,
          'UPDATE',
          'provincia',
          datosAnteriores.provincia,
          provincia
        );
      }

      if (parseFloat(datosAnteriores.latitud) !== parseFloat(latitud) ||
          parseFloat(datosAnteriores.longitud) !== parseFloat(longitud)) {
        await guardarHistorialDepartamental(
          connection,
          id,
          cabecera.id,
          'UPDATE',
          'coordenadas',
          JSON.stringify({
            latitud: datosAnteriores.latitud,
            longitud: datosAnteriores.longitud
          }),
          JSON.stringify({ latitud, longitud })
        );
      }

      if (datosAnteriores.habilitado !== habilitado) {
        await guardarHistorialDepartamental(
          connection,
          id,
          cabecera.id,
          'UPDATE',
          'habilitado',
          datosAnteriores.habilitado,
          habilitado
        );
      }

      // Obtener la departamental actualizada
      const selectQuery = `
        SELECT
          id,
          nombre,
          direccion,
          localidad,
          provincia,
          ST_Y(coordenadas) AS latitud,
          ST_X(coordenadas) AS longitud,
          habilitado,
          DATE_FORMAT(fecha_creacion, '%d/%m/%Y %T') AS fecha_creacion,
          DATE_FORMAT(fecha_modificacion, '%d/%m/%Y %T') AS fecha_modificacion
        FROM departamental
        WHERE id = ?
      `;

      const [rows] = await connection.query(selectQuery, [id]);

      await connection.commit();
      connection.release();

      res.status(200).json(rows[0]);
    } catch (error) {
      await connection.rollback();
      connection.release();
      throw error;
    }
  } catch (error) {
    if (connection) {
      connection.release();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

router.post("/tabla/temporadas", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  const filters = req.body || {};
  const fecha_incio = filters.startDate || "2023-01-01";
  const fecha_fin = filters.endDate || "2070-12-31";
  const fromDate = normalizarFechaCivil(fecha_incio);
  const toDate = normalizarFechaCivil(fecha_fin);
  if (!fromDate || !toDate || fromDate > toDate) {
    return res.status(422).json("El rango de fechas no es valido");
  }

  let queryBuscar = "";
  if (
    cabecera.rol === "admin"
  ) {
    const paginacion = normalizarPaginacion(req.query, 10);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize: resultsPerPage, start } = paginacion;

    const columnasOrdenTemporadas = {
      id: "temporada_tarifa.id",
      nombre: "temporada_tarifa.nombre",
      fecha_inicio: "temporada_tarifa.fecha_inicio",
      fecha_fin: "temporada_tarifa.fecha_fin",
    };
    const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenTemporadas, req.query.orderBy)
      ? req.query.orderBy
      : "id";
    const orderBy = columnasOrdenTemporadas[orderByKey];
    const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

    const queryOrderBy = `${orderBy} ${orderType}`;
    
    const querySearchParams = [];
    if (buscar) {
      const like = `%${buscar}%`;
      queryBuscar = `AND (CAST(id AS CHAR) LIKE ? OR nombre LIKE ? OR DATE_FORMAT(fecha_inicio, '%d/%m/%Y') LIKE ?
        OR DATE_FORMAT(fecha_fin, '%d/%m/%Y') LIKE ?
        OR (CASE WHEN fecha_fin < CURDATE() THEN 'Finalizada' WHEN fecha_inicio > CURDATE() THEN 'Futura' ELSE 'Activa' END) LIKE ?)`;
      querySearchParams.push(...Array(5).fill(like));
    }

    const queryParams = [...querySearchParams];
    let query = `
      SELECT DATE_FORMAT(fecha_inicio, '%d/%m/%Y') AS fecha_inicio, 
             nombre AS nombre, 
             id AS id, 
             DATE_FORMAT(fecha_fin, '%d/%m/%Y') AS fecha_fin
      FROM temporada_tarifa
      WHERE 1=1 
        AND COALESCE(origen, 'GENERAL') = 'GENERAL'
        ${queryBuscar}
        ${fromDate ? "AND fecha_inicio >= ?" : ""}
        ${toDate ? "AND fecha_fin <= ?" : ""}
    `;

    if (fromDate) {
      queryParams.push(fromDate);
    }

    if (toDate) {
      queryParams.push(toDate);
    }

    query += ` ORDER BY ${queryOrderBy}, temporada_tarifa.id DESC LIMIT ${start}, ${resultsPerPage}`;

    try {
      const [rows] = await mysqlConnection.promise().execute(query, queryParams);

      const [countRows] = await mysqlConnection.promise().execute(
        `
        SELECT COUNT(*) AS count
        FROM temporada_tarifa
        WHERE 1=1 
          AND COALESCE(origen, 'GENERAL') = 'GENERAL'
          ${queryBuscar}
          ${fromDate ? "AND fecha_inicio >= ?" : ""}
          ${toDate ? "AND fecha_fin <= ?" : ""}
        `,
        queryParams
      );

      const numOfResults = countRows[0].count;
      const numOfPages = Math.ceil(numOfResults / resultsPerPage);

      res.json({
        results: rows,
        numOfPages,
        totalItems: numOfResults,
        page: page - 1,
        orderBy: orderByKey,
        orderType,
      });
    } catch (error) {
      registrarErrorRuta(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.post("/tabla/reservas", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const rolesPermitidos = ["admin", "departamental"];
  if (!rolesPermitidos.includes(cabecera.rol) || !tieneAreaTurismo(cabecera)) {
    return res.status(403).json("No autorizado");
  }

  const departamentalId =
    cabecera.rol === "departamental" ? normalizarIdPositivo(cabecera.departamental_id) : null;
  if (cabecera.rol === "departamental" && !departamentalId) {
    return res.status(403).json("No autorizado");
  }

  let buscar = req.query.search;
  const filters = req.body || {};
  // Filtro por estado de reserva (nombre en estado_reserva). "Todas" = sin filtro.
  const estadoFiltro =
    typeof filters.estado === "string" && filters.estado.trim() !== "" && filters.estado !== "Todas"
      ? filters.estado.trim()
      : null;
  const fecha_incio = filters.startDate || "2023-01-01";
  const fecha_fin = filters.endDate || "2070-12-31";
  const fromDate = normalizarFechaCivil(fecha_incio);
  const toDate = normalizarFechaCivil(fecha_fin);
  if (!fromDate || !toDate || fromDate > toDate) {
    return res.status(422).json("El rango de fechas no es valido");
  }

  let queryBuscar = "";
  // La página es 1-based; se clampa para que un page=0 o inválido nunca
  // genere un LIMIT negativo (error de sintaxis SQL).
  const paginacion = normalizarPaginacion(req.query, 10);
  if (!paginacion) return res.status(400).json("La paginación es inválida");
  const { page, pageSize: resultsPerPage, start } = paginacion;

  const columnasOrdenReservas = {
    id: "r.id",
    estado: "er.nombre",
    modalidad: "COALESCE(r.modalidad, 'FECHA_LIBRE')",
    servicio: "COALESCE(s.nombre, 'Convenio hotelero')",
    recurso: "COALESCE(rec.nombre, ch.nombre, 'Pendiente de adjudicación')",
    afiliado: "u.documento",
    fecha_inicio: "r.fecha_inicio",
    fecha_fin: "r.fecha_fin",
    fecha_creacion: "r.fecha_creacion",
    observaciones: "COALESCE(r.observaciones, '')",
  };
  const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenReservas, req.query.orderBy)
    ? req.query.orderBy
    : "fecha_inicio";
  const orderBy = columnasOrdenReservas[orderByKey];
  const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

  const queryOrderBy = `${orderBy} ${orderType}`;

  const querySearchParams = [];
  if (buscar) {
    const like = `%${buscar}%`;
    queryBuscar = `AND (CAST(r.id AS CHAR) LIKE ? OR er.nombre LIKE ? OR r.modalidad LIKE ?
      OR s.nombre LIKE ? OR rec.nombre LIKE ? OR ch.nombre LIKE ? OR ch.ciudad LIKE ? OR ch.provincia LIKE ?
      OR bf.nombre LIKE ? OR CAST(u.documento AS CHAR) LIKE ? OR DATE_FORMAT(r.fecha_inicio, '%d/%m/%Y') LIKE ?
      OR DATE_FORMAT(r.fecha_fin, '%d/%m/%Y') LIKE ? OR DATE_FORMAT(r.fecha_creacion, '%d/%m/%Y') LIKE ?
      OR r.observaciones LIKE ?
      OR CAST((SELECT COUNT(*) FROM reserva_observacion ro_busqueda WHERE ro_busqueda.reserva_id = r.id) AS CHAR) LIKE ?)`;
    querySearchParams.push(...Array(15).fill(like));
  }

  const queryParams = [...querySearchParams];
  let query = `
    SELECT 
      r.id,
      COALESCE(er.nombre, 'Sin estado') AS estado,
      COALESCE(s.nombre, 'Convenio hotelero') AS servicio,
      COALESCE(rec.nombre, ch.nombre, 'Pendiente de adjudicación') AS recurso,
      COALESCE(r.modalidad, 'FECHA_LIBRE') AS modalidad,
      bf.nombre AS bloque,
      u.documento AS afiliado,
      DATE_FORMAT(r.fecha_inicio, '%d/%m/%Y') AS fecha_inicio,
      DATE_FORMAT(r.fecha_fin, '%d/%m/%Y') AS fecha_fin,
      COALESCE(r.observaciones, '') AS observaciones,
      DATE_FORMAT(r.fecha_creacion, '%d/%m/%Y') AS fecha_creacion,
      (SELECT COUNT(*) FROM reserva_observacion ro WHERE ro.reserva_id = r.id) AS mensajes
    FROM reserva r
    INNER JOIN estado_reserva er ON r.estado_reserva_id = er.id
    LEFT JOIN recurso rec ON r.recurso_id = rec.id
    LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
    LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
    LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
    INNER JOIN usuario u ON r.usuario_id = u.id
    WHERE 1=1
      ${queryBuscar}
      ${fromDate ? "AND r.fecha_inicio >= ?" : ""}
      ${toDate ? "AND r.fecha_fin <= ?" : ""}
      ${estadoFiltro ? "AND er.nombre = ?" : ""}
  `;

  if (fromDate) {
    queryParams.push(fromDate);
  }
  if (toDate) {
    queryParams.push(toDate);
  }
  if (estadoFiltro) {
    queryParams.push(estadoFiltro);
  }

  if (cabecera.rol === "departamental") {
    query += " AND u.departamental_id = ?";
    queryParams.push(departamentalId);
  }

  query += ` ORDER BY ${queryOrderBy}, r.id DESC LIMIT ${start}, ${resultsPerPage}`;

  try {
    const [rows] = await mysqlConnection.promise().execute(query, queryParams);

    // Construye los parámetros para el countQuery de forma independiente
    const countParams = [...querySearchParams];
    if (fromDate) countParams.push(fromDate);
    if (toDate) countParams.push(toDate);
    if (estadoFiltro) countParams.push(estadoFiltro);
    if (cabecera.rol === "departamental") countParams.push(departamentalId);

    let countQuery = `
      SELECT COUNT(*) AS count
      FROM reserva r
      INNER JOIN estado_reserva er ON r.estado_reserva_id = er.id
      LEFT JOIN recurso rec ON r.recurso_id = rec.id
      LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
      LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
      LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
      INNER JOIN usuario u ON r.usuario_id = u.id
      WHERE 1=1
        ${queryBuscar}
        ${fromDate ? "AND r.fecha_inicio >= ?" : ""}
        ${toDate ? "AND r.fecha_fin <= ?" : ""}
        ${estadoFiltro ? "AND er.nombre = ?" : ""}
        ${cabecera.rol === "departamental" ? "AND u.departamental_id = ?" : ""}
    `;

    const [countRows] = await mysqlConnection.promise().execute(countQuery, countParams);

    const numOfResults = countRows[0].count;
    const numOfPages = Math.ceil(numOfResults / resultsPerPage);

    res.json({
      results: rows,
      numOfPages,
      totalItems: numOfResults,
      page: page - 1,
      orderBy: orderByKey,
      orderType,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

// ---------------------------------------------------------------------------
// MIS GESTIONES (rol afiliado): vista unificada de las reservas de turismo y
// las solicitudes de coseguro médico del usuario logueado.
// Los códigos se devuelven con prefijo por módulo: T-<id> (turismo) y C-<id> (coseguro).
// ---------------------------------------------------------------------------

// Colores pastel para los estados de reserva (misma estética que coseguro_estado)
const COLORES_ESTADO_RESERVA = {
  "Iniciada": { color: "#E3F2FD", color_texto: "#1565C0" },
  "Verificada": { color: "#FEF9C3", color_texto: "#A16207" },
  "Aprobada": { color: "#D1FAE5", color_texto: "#047857" },
  "Rechazada": { color: "#FEE2E2", color_texto: "#B91C1C" },
  "Utilizada": { color: "#E5E7EB", color_texto: "#374151" },
  "Solicitud sorteo": { color: "#EDE9FE", color_texto: "#6D28D9" },
  "Adjudicada": { color: "#DCFCE7", color_texto: "#15803D" },
  "No adjudicada": { color: "#FFE4E6", color_texto: "#BE123C" },
  "Solicitud convenio": { color: "#E0E7FF", color_texto: "#4338CA" },
  "Propuesta convenio": { color: "#FFF1DB", color_texto: "#B45309" },
  "Convenio aceptado": { color: "#D1FAE5", color_texto: "#047857" },
  "Convenio rechazado": { color: "#FEE2E2", color_texto: "#B91C1C" },
};
const COLOR_ESTADO_GESTION_DEFECTO = { color: "#F3F4F6", color_texto: "#4B5563" };

// El afiliado ve el estado interno de coseguro "Exportado para liquidar" (8)
// como "Pendiente de acreditación" (9)
const COSEGURO_ESTADO_EXPORTADO = 8;
const COSEGURO_ESTADO_PENDIENTE_ACREDITACION = 9;

// Catálogos de estados para armar los filtros del listado unificado
router.get("/mis-gestiones/catalogos", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol !== "afiliado") return res.status(401).json("No autorizado");
  try {
    const db = mysqlConnection.promise();
    const [estadosTurismo] = tieneModuloTurismo(cabecera)
      ? await db.query("SELECT id, nombre FROM estado_reserva ORDER BY id")
      : [[]];
    const [estadosCoseguro] = tieneModuloCoseguro(cabecera)
      ? await db.query(
        `SELECT id, COALESCE(nombre_afiliado, nombre) AS nombre, color, color_texto
         FROM coseguro_estado WHERE id <> ? ORDER BY id`,
        [COSEGURO_ESTADO_EXPORTADO]
      )
      : [[]];
    res.json({
      estados_turismo: estadosTurismo.map((estado) => ({
        ...estado,
        ...(COLORES_ESTADO_RESERVA[estado.nombre] || COLOR_ESTADO_GESTION_DEFECTO),
      })),
      estados_coseguro: estadosCoseguro,
      estados_traslados: [],
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los catálogos de gestiones");
  }
});

// Listado unificado con búsqueda, filtros, orden y paginación
router.get("/mis-gestiones", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol !== "afiliado") return res.status(401).json("No autorizado");

  try {
    const db = mysqlConnection.promise();
    const paginacion = normalizarPaginacion(req.query, 10);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize } = paginacion;
    const orderType = String(req.query.orderType).toLowerCase() === "asc" ? "ASC" : "DESC";
    const COLUMNAS_ORDEN_GESTIONES = {
      fecha_creacion: "g.fecha_creacion",
      tipo: "g.tipo",
      estado: "g.estado",
      importe: "g.importe",
    };
    const orderBy = COLUMNAS_ORDEN_GESTIONES[req.query.orderBy] || "g.fecha_creacion";

    const puedeVerSalud = puedeVerDatosSaludReserva(cabecera);
    const esPorSaludTurismoSql = puedeVerSalud ? "r.es_por_salud" : "0";
    const estadoSaludTurismoSql = puedeVerSalud ? "rs.estado" : "NULL";
    const joinSaludTurismoSql = puedeVerSalud
      ? "LEFT JOIN reserva_salud rs ON rs.reserva_id = r.id"
      : "";

    // Vista unificada: ambos módulos proyectados a las mismas columnas. Si
    // Coseguro está apagado, la rama Turismo ni siquiera une la tabla médica.
    const unionSql = `
      SELECT
        r.id,
        'turismo' AS tipo,
        CONCAT('T-', r.id) AS codigo,
        er.id AS estado_id,
        er.nombre AS estado,
        NULL AS estado_color,
        NULL AS estado_color_texto,
        COALESCE(s.nombre, ch.nombre, 'Convenio hotelero') AS titulo,
        COALESCE(rec.nombre, ch.nombre, 'Pendiente de adjudicación') AS subtitulo,
        COALESCE(r.modalidad, 'FECHA_LIBRE') AS modalidad,
        DATE_FORMAT(r.fecha_inicio, '%d/%m/%Y') AS fecha_inicio,
        DATE_FORMAT(r.fecha_fin, '%d/%m/%Y') AS fecha_fin,
        NULL AS importe,
        NULL AS comprobante,
        NULL AS beneficiario,
        ${esPorSaludTurismoSql} AS es_por_salud,
        ${estadoSaludTurismoSql} AS salud_estado,
        r.fecha_creacion
      FROM reserva r
        INNER JOIN estado_reserva er ON er.id = r.estado_reserva_id
        LEFT JOIN recurso rec ON rec.id = r.recurso_id
        LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
        LEFT JOIN convenio_hotel ch ON ch.id = r.convenio_hotel_id
        ${joinSaludTurismoSql}
      WHERE r.usuario_id = ? AND ? = 1
      UNION ALL
      SELECT
        cs.id,
        'coseguro' AS tipo,
        CONCAT('C-', cs.id) AS codigo,
        e.id AS estado_id,
        COALESCE(e.nombre_afiliado, e.nombre) AS estado,
        e.color AS estado_color,
        e.color_texto AS estado_color_texto,
        COALESCE(t.nombre, 'Reintegro') AS titulo,
        COALESCE(c.nombre, cs.emisor_nombre) AS subtitulo,
        NULL AS modalidad,
        NULL AS fecha_inicio,
        NULL AS fecha_fin,
        COALESCE(cs.importe_autorizado, cs.importe_estimado, cs.importe) AS importe,
        CONCAT(COALESCE(CONCAT(cs.comprobante_pto_venta, '-'), ''), cs.comprobante_numero) AS comprobante,
        CASE WHEN cs.familiar_usuario_id IS NOT NULL THEN CONCAT(fam.nombre, ' ', fam.apellido) ELSE NULL END AS beneficiario,
        0 AS es_por_salud,
        NULL AS salud_estado,
        cs.fecha_creacion
      FROM coseguro_solicitud cs
        INNER JOIN coseguro_estado e ON e.id = cs.estado_id
        LEFT JOIN usuario fam ON fam.id = cs.familiar_usuario_id
        LEFT JOIN coseguro_tipo_reintegro t ON t.id = cs.tipo_reintegro_id
        LEFT JOIN coseguro_concepto c ON c.id = cs.concepto_id
      WHERE cs.usuario_id = ? AND cs.eliminado = 0 AND ? = 1
      UNION ALL
      SELECT
        ts.id,
        'traslado' AS tipo,
        CONCAT('TR-', ts.id) AS codigo,
        te.id AS estado_id,
        te.nombre AS estado,
        te.color AS estado_color,
        te.color_texto AS estado_color_texto,
        CONCAT('Traslado a ', ddes.nombre) AS titulo,
        CONCAT('Desde ', dori.nombre) AS subtitulo,
        NULL AS modalidad,
        NULL AS fecha_inicio,
        NULL AS fecha_fin,
        NULL AS importe,
        NULL AS comprobante,
        NULL AS beneficiario,
        0 AS es_por_salud,
        NULL AS salud_estado,
        ts.fecha_creacion
      FROM traslado_solicitud ts
        INNER JOIN traslado_estado te ON te.id = ts.estado_id
        INNER JOIN departamental dori ON dori.id = ts.departamental_origen_id
        INNER JOIN departamental ddes ON ddes.id = ts.departamental_destino_id
      WHERE ts.usuario_id = ? AND ts.eliminado = 0 AND 1 = 0
    `;
    const unionParams = [
      cabecera.id,
      tieneModuloTurismo(cabecera) ? 1 : 0,
      cabecera.id,
      tieneModuloCoseguro(cabecera) ? 1 : 0,
      cabecera.id,
    ];

    // Filtros comunes (el tipo se aplica aparte para poder devolver los
    // contadores de ambos módulos calculados con estos mismos filtros)
    const condiciones = [];
    const params = [];

    const search = String(req.query.search || "").trim();
    if (search) {
      condiciones.push(`(g.codigo LIKE ? OR g.tipo LIKE ? OR g.titulo LIKE ? OR g.subtitulo LIKE ? OR g.estado LIKE ?
        OR g.comprobante LIKE ? OR g.beneficiario LIKE ? OR g.fecha_inicio LIKE ? OR g.fecha_fin LIKE ?
        OR REPLACE(g.modalidad, '_', ' ') LIKE ? OR CAST(g.importe AS CHAR) LIKE ?
        OR DATE_FORMAT(g.fecha_creacion, '%d/%m/%Y %H:%i') LIKE ?
        OR (CASE WHEN g.es_por_salud = 1 THEN 'Por salud' ELSE '' END) LIKE ? OR g.salud_estado LIKE ?)`);
      const like = `%${search}%`;
      params.push(...Array(14).fill(like));
    }

    // estados=T1,T3,C7 → cada token filtra dentro de su propio módulo
    const tokens = String(req.query.estados || "")
      .split(",")
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean);
    const estadosTurismo = tokens.filter((t) => /^T\d+$/.test(t)).map((t) => Number(t.slice(1)));
    const estadosCoseguro = tokens.filter((t) => /^C\d+$/.test(t)).map((t) => Number(t.slice(1)));
    const estadosTraslados = tokens.filter((t) => /^R\d+$/.test(t)).map((t) => Number(t.slice(1)));
    if (estadosCoseguro.includes(COSEGURO_ESTADO_PENDIENTE_ACREDITACION) && !estadosCoseguro.includes(COSEGURO_ESTADO_EXPORTADO)) {
      estadosCoseguro.push(COSEGURO_ESTADO_EXPORTADO);
    }
    if (estadosTurismo.length > 0 || estadosCoseguro.length > 0 || estadosTraslados.length > 0) {
      const ramas = [];
      if (estadosTurismo.length > 0) {
        ramas.push(`(g.tipo = 'turismo' AND g.estado_id IN (${estadosTurismo.map(() => "?").join(",")}))`);
        params.push(...estadosTurismo);
      }
      if (estadosCoseguro.length > 0) {
        ramas.push(`(g.tipo = 'coseguro' AND g.estado_id IN (${estadosCoseguro.map(() => "?").join(",")}))`);
        params.push(...estadosCoseguro);
      }
      if (estadosTraslados.length > 0) {
        ramas.push(`(g.tipo = 'traslado' AND g.estado_id IN (${estadosTraslados.map(() => "?").join(",")}))`);
        params.push(...estadosTraslados);
      }
      condiciones.push(`(${ramas.join(" OR ")})`);
    }

    const esFechaValida = (valor) => /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ""));
    if (esFechaValida(req.query.fecha_desde)) {
      condiciones.push("DATE(g.fecha_creacion) >= ?");
      params.push(req.query.fecha_desde);
    }
    if (esFechaValida(req.query.fecha_hasta)) {
      condiciones.push("DATE(g.fecha_creacion) <= ?");
      params.push(req.query.fecha_hasta);
    }

    const whereComun = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

    // Contadores por módulo (para los chips "Turismo" / "Coseguro médico")
    const [conteoRows] = await db.query(
      `SELECT g.tipo, COUNT(*) AS total FROM (${unionSql}) g ${whereComun} GROUP BY g.tipo`,
      [...unionParams, ...params]
    );
    const conteos = { turismo: 0, coseguro: 0, traslado: 0 };
    conteoRows.forEach((row) => (conteos[row.tipo] = Number(row.total)));

    const tipo = ["turismo", "coseguro", "traslado"].includes(req.query.tipo) ? req.query.tipo : null;
    const totalItems = tipo ? conteos[tipo] : conteos.turismo + conteos.coseguro + conteos.traslado;

    const condicionesFinal = tipo ? [...condiciones, "g.tipo = ?"] : condiciones;
    const paramsFinal = tipo ? [...params, tipo] : params;
    const where = condicionesFinal.length > 0 ? `WHERE ${condicionesFinal.join(" AND ")}` : "";

    const [rows] = await db.query(
      `SELECT g.* FROM (${unionSql}) g ${where}
       ORDER BY ${orderBy} ${orderType}, g.fecha_creacion DESC, g.tipo ASC, g.id DESC
       LIMIT ? OFFSET ?`,
      [...unionParams, ...paramsFinal, pageSize, (page - 1) * pageSize]
    );

    const results = rows.map((row) => {
      if (row.tipo === "turismo") {
        const colores = COLORES_ESTADO_RESERVA[row.estado] || COLOR_ESTADO_GESTION_DEFECTO;
        return { ...row, estado_color: colores.color, estado_color_texto: colores.color_texto };
      }
      return row;
    });

    res.json({ results, totalItems, page, pageSize, conteos });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las gestiones");
  }
});

// POST /tabla/acompaniantes - Tabla unificada de "Familiares y acompañantes" del afiliado.
// Devuelve en una sola lista los familiares del grupo familiar (es_familiar = 'S',
// los que usa el coseguro médico) y los acompañantes de viaje sin cuenta propia
// (personas creadas en reservas o que compartieron reservas con el afiliado).
// Body (filtros): { vinculo: 'FAMILIAR'|'ACOMPANIANTE', parentesco_id, dni: 'con'|'sin' }
router.post("/tabla/acompaniantes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol !== "afiliado") {
    return res.status(401).json("No autorizado");
  }

  const usuarioId = normalizarIdPositivo(cabecera.id);
  if (!usuarioId) return res.status(401).json("No autorizado");
  const paginacion = normalizarPaginacion(req.query, 10);
  if (!paginacion) return res.status(400).json("La paginación es inválida");
  const { page, pageSize: resultsPerPage, start } = paginacion;

  const ordenColumnas = {
    nombre: "base.nombre",
    apellido: "base.apellido",
    documento: "base.documento",
    parentesco: "base.parentesco",
    edad: "base.edad",
    vinculo: "base.vinculo",
    viajes_compartidos: "base.viajes_compartidos",
    fecha_creacion: "base.fecha_creacion_orden",
  };
  const orderBy = ordenColumnas[req.query.orderBy] ? req.query.orderBy : "fecha_creacion";
  const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

  const filtros = req.body || {};
  const filtroVinculo = ["FAMILIAR", "ACOMPANIANTE"].includes(filtros.vinculo) ? filtros.vinculo : null;
  const filtroParentesco = filtros.parentesco_id === undefined || filtros.parentesco_id === null || filtros.parentesco_id === ""
    ? null
    : normalizarIdPositivo(filtros.parentesco_id);
  const filtroDni = ["con", "sin"].includes(filtros.dni) ? filtros.dni : null;
  if (filtros.vinculo !== undefined && filtros.vinculo !== null && filtros.vinculo !== "" && !filtroVinculo) {
    return res.status(400).json("El filtro de vínculo es inválido");
  }
  if (filtros.parentesco_id !== undefined && filtros.parentesco_id !== null
    && filtros.parentesco_id !== "" && !filtroParentesco) {
    return res.status(400).json("El filtro de parentesco es inválido");
  }
  if (filtros.dni !== undefined && filtros.dni !== null && filtros.dni !== "" && !filtroDni) {
    return res.status(400).json("El filtro de DNI es inválido");
  }

  // Universo del afiliado: familiares del grupo + acompañantes de viaje sin
  // cuenta propia (vinculados directamente o a través de reservas compartidas).
  const baseQuery = `
    SELECT
      u.id,
      u.nombre,
      u.apellido,
      u.documento,
      u.fecha_nacimiento,
      TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) AS edad,
      u.telefono,
      u.parentesco_id,
      p.nombre AS parentesco,
      u.tipo_persona_id,
      tp.nombre AS tipo_persona,
      CASE WHEN u.usuario_familiar_id = ? AND u.es_familiar = 'S' THEN 'FAMILIAR' ELSE 'ACOMPANIANTE' END AS vinculo,
      (u.password IS NOT NULL OR (u.email IS NOT NULL AND u.email <> '')) AS tiene_usuario,
      (SELECT COUNT(DISTINCT rf.reserva_id)
         FROM reserva_familiar rf
        WHERE rf.usuario_id = u.id
          AND rf.reserva_id IN (SELECT rf2.reserva_id FROM reserva_familiar rf2 WHERE rf2.usuario_id = ?)) AS viajes_compartidos,
      (SELECT MAX(r.fecha_inicio)
         FROM reserva r
        INNER JOIN reserva_familiar rf3 ON rf3.reserva_id = r.id
        WHERE rf3.usuario_id = u.id
          AND r.id IN (SELECT rf4.reserva_id FROM reserva_familiar rf4 WHERE rf4.usuario_id = ?)) AS ultimo_viaje_fecha,
      DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') AS fecha_creacion,
      u.fecha_creacion AS fecha_creacion_orden
    FROM usuario u
    LEFT JOIN parentesco p ON u.parentesco_id = p.id
    LEFT JOIN tipo_persona tp ON u.tipo_persona_id = tp.id
    WHERE u.id <> ?
      AND COALESCE(u.habilitado, 'Y') = 'Y'
      AND (
        (u.usuario_familiar_id = ? AND u.es_familiar = 'S')
        OR (
          u.password IS NULL AND (u.email IS NULL OR u.email = '')
          AND (
            (u.usuario_familiar_id = ? AND (u.es_familiar IS NULL OR u.es_familiar = 'N'))
            OR u.id IN (
              SELECT rf5.usuario_id
              FROM reserva_familiar rf5
              WHERE rf5.reserva_id IN (SELECT rf6.reserva_id FROM reserva_familiar rf6 WHERE rf6.usuario_id = ?)
            )
          )
        )
      )
  `;
  const baseParams = [usuarioId, usuarioId, usuarioId, usuarioId, usuarioId, usuarioId, usuarioId];

  const condiciones = [];
  const paramsFiltro = [];
  if (req.query.search) {
    if (typeof req.query.search !== "string" || req.query.search.length > 200) {
      return res.status(400).json("La búsqueda es inválida");
    }
    const buscar = `%${req.query.search.trim()}%`;
    condiciones.push(`(
      base.nombre LIKE ? OR base.apellido LIKE ?
      OR CONCAT(base.nombre, ' ', base.apellido) LIKE ?
      OR CONCAT(base.apellido, ' ', base.nombre) LIKE ?
      OR CAST(base.documento AS CHAR) LIKE ?
      OR base.parentesco LIKE ?
      OR base.vinculo LIKE ?
      OR base.tipo_persona LIKE ?
      OR CAST(base.edad AS CHAR) LIKE ?
      OR CAST(base.viajes_compartidos AS CHAR) LIKE ?
      OR DATE_FORMAT(base.ultimo_viaje_fecha, '%d/%m/%Y') LIKE ?
      OR DATE_FORMAT(base.fecha_creacion_orden, '%d/%m/%Y') LIKE ?
    )`);
    paramsFiltro.push(...Array(12).fill(buscar));
  }
  if (filtroVinculo) {
    condiciones.push("base.vinculo = ?");
    paramsFiltro.push(filtroVinculo);
  }
  if (filtroParentesco) {
    condiciones.push("base.parentesco_id = ?");
    paramsFiltro.push(filtroParentesco);
  }
  if (filtroDni === "con") {
    condiciones.push("base.documento IS NOT NULL AND base.documento > 0");
  } else if (filtroDni === "sin") {
    condiciones.push("(base.documento IS NULL OR base.documento <= 0)");
  }
  const whereFiltros = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  try {
    const db = mysqlConnection.promise();

    const [rows] = await db.query(
      `SELECT base.* FROM (${baseQuery}) base
       ${whereFiltros}
       ORDER BY ${ordenColumnas[orderBy]} ${orderType}, base.apellido ASC, base.nombre ASC, base.id DESC
       LIMIT ${start}, ${resultsPerPage}`,
      [...baseParams, ...paramsFiltro]
    );

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS count FROM (${baseQuery}) base ${whereFiltros}`,
      [...baseParams, ...paramsFiltro]
    );

    // Stats del universo completo (sin filtros): alimentan chips y tarjetas.
    const [statsRows] = await db.query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(base.vinculo = 'FAMILIAR'), 0) AS familiares,
         COALESCE(SUM(base.vinculo = 'ACOMPANIANTE'), 0) AS acompaniantes,
         COALESCE(SUM(base.vinculo = 'FAMILIAR' AND base.documento IS NOT NULL AND base.documento > 0), 0) AS listos_coseguro
       FROM (${baseQuery}) base`,
      baseParams
    );

    const formatearFecha = (fecha) => {
      if (!fecha) return null;
      const fechaCivil = formatearFechaSQL(fecha);
      if (!fechaCivil) return null;
      const [anio, mes, dia] = fechaCivil.split("-");
      return `${dia}/${mes}/${anio}`;
    };

    const numOfResults = countRows[0].count;

    res.json({
      results: rows.map((row) => ({
        id: row.id,
        nombre: row.nombre,
        apellido: row.apellido,
        documento: row.documento,
        fecha_nacimiento: row.fecha_nacimiento,
        edad: row.edad,
        telefono: row.telefono,
        parentesco_id: row.parentesco_id,
        parentesco: row.parentesco,
        tipo_persona_id: row.tipo_persona_id,
        tipo_persona: row.tipo_persona,
        vinculo: row.vinculo,
        tiene_usuario: Boolean(row.tiene_usuario),
        viajes_compartidos: Number(row.viajes_compartidos) || 0,
        ultimo_viaje: formatearFecha(row.ultimo_viaje_fecha),
        fecha_creacion: row.fecha_creacion,
      })),
      numOfPages: Math.ceil(numOfResults / resultsPerPage),
      totalItems: numOfResults,
      page: page - 1,
      orderBy,
      orderType,
      stats: {
        total: Number(statsRows[0].total) || 0,
        familiares: Number(statsRows[0].familiares) || 0,
        acompaniantes: Number(statsRows[0].acompaniantes) || 0,
        listos_coseguro: Number(statsRows[0].listos_coseguro) || 0,
      },
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

// POST /familiares - Alta de un familiar del grupo familiar (rol afiliado).
// El familiar queda vinculado con usuario_familiar_id + es_familiar = 'S' y por
// eso también queda disponible como "familiar a cargo" en el coseguro médico.
router.post("/familiares", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "afiliado") {
      return res.status(401).json({ success: false, message: "No autorizado" });
    }

    const { nombre, apellido, parentesco_id, fecha_nacimiento, documento, telefono } = req.body || {};
    const actorId = normalizarIdPositivo(cabecera.id);
    const nombreNormalizado = normalizarTexto(nombre);
    const apellidoNormalizado = normalizarTexto(apellido);
    const telefonoNormalizado = telefono === undefined || telefono === null || telefono === ""
      ? null
      : normalizarTexto(telefono);

    if (!actorId) return res.status(401).json({ success: false, message: "No autorizado" });
    if (!nombreNormalizado || nombreNormalizado.length > 45
      || !apellidoNormalizado || apellidoNormalizado.length > 45) {
      return res.status(400).json({ success: false, message: "Nombre y apellido son requeridos" });
    }
    if (telefonoNormalizado && telefonoNormalizado.length > 15) {
      return res.status(400).json({ success: false, message: "El teléfono es inválido" });
    }
    const parentescoId = normalizarIdPositivo(parentesco_id);
    if (![2, 3, 4].includes(parentescoId)) {
      return res.status(400).json({ success: false, message: "El parentesco debe ser Pareja, Hijo o Familiar" });
    }
    const fechaNacimiento = normalizarFechaCivil(fecha_nacimiento);
    const edad = calcularEdadEnFecha(fechaNacimiento, obtenerFechaCivilHoyArgentina());
    if (!fechaNacimiento || edad === null) {
      return res.status(400).json({ success: false, message: "La fecha de nacimiento es requerida" });
    }
    const documentoNormalizado = documento !== undefined && documento !== null && String(documento).trim() !== ""
      ? normalizarTexto(documento)
      : null;
    if (documentoNormalizado !== null && !esDniValido(documentoNormalizado)) {
      return res.status(400).json({ success: false, message: DNI_MENSAJE });
    }

    // Menores de 2 años (5); resto: invitados familiares AJB (2)
    const tipoPersonaId = edad < 2 ? 5 : 2;

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [titular] = await connection.query(
      "SELECT id, departamental_id FROM usuario WHERE id = ? AND habilitado = 'Y' FOR UPDATE",
      [actorId]
    );
    if (titular.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }
    const titularDepartamentalId = normalizarIdPositivo(titular[0].departamental_id);
    if (!titularDepartamentalId) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "El titular no tiene una departamental valida asignada",
      });
    }

    if (documentoNormalizado !== null) {
      const [existente] = await connection.query(
        `SELECT id, usuario_familiar_id, es_familiar, parentesco_id, departamental_id, password, email
         FROM usuario WHERE documento = ? FOR UPDATE`,
        [Number(documentoNormalizado)]
      );

      if (existente.length > 0) {
        const persona = existente[0];
        const esDelGrupo = normalizarIdPositivo(persona.usuario_familiar_id) === actorId;
        const sinCuenta = persona.password === null && (persona.email === null || persona.email === "");

        if (esDelGrupo && persona.es_familiar === "S") {
          await connection.rollback();
          return res.status(409).json({ success: false, message: "Esa persona ya está cargada como familiar" });
        }

        // Si ya viajó con el afiliado (o quedó vinculada como acompañante) y no
        // tiene cuenta propia, se la promueve a familiar en lugar de duplicarla.
        if (esDelGrupo && sinCuenta) {
          await connection.query(
            "UPDATE usuario SET es_familiar = 'S', parentesco_id = ?, departamental_id = ? WHERE id = ?",
            [parentescoId, titularDepartamentalId, persona.id]
          );
          const cambios = [
            { campo: "es_familiar", valorAnterior: persona.es_familiar, valorNuevo: "S" },
          ];
          if (Number(persona.parentesco_id) !== parentescoId) {
            cambios.push({ campo: "parentesco_id", valorAnterior: persona.parentesco_id, valorNuevo: parentescoId });
          }
          if (Number(persona.departamental_id) !== titularDepartamentalId) {
            cambios.push({
              campo: "departamental_id",
              valorAnterior: persona.departamental_id,
              valorNuevo: titularDepartamentalId,
            });
          }
          await registrarHistorial(
            connection,
            persona.id,
            "UPDATE",
            "usuario",
            actorId,
            req,
            cambios,
            "Acompañante de viaje promovido a familiar del grupo familiar"
          );
          await connection.commit();
          return res.status(200).json({
            success: true,
            id: persona.id,
            promovido: true,
            message: "Esa persona ya te acompañó en viajes: la sumamos a tu grupo familiar",
          });
        }

        await connection.rollback();
        return res.status(409).json({ success: false, message: "Ya existe otra persona registrada con ese DNI" });
      }
    }

    const [nuevoFamiliar] = await connection.query(
      `INSERT INTO usuario (
        rol_id, parentesco_id, tipo_persona_id, nombre, apellido, fecha_nacimiento,
        documento, telefono, password, usuario_familiar_id, es_familiar, departamental_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'S', ?)`,
      [
        4, // rol invitado: familiar sin cuenta propia
        parentescoId,
        tipoPersonaId,
        nombreNormalizado,
        apellidoNormalizado,
        fechaNacimiento,
        documentoNormalizado !== null ? Number(documentoNormalizado) : null,
        telefonoNormalizado,
        actorId,
        titularDepartamentalId,
      ]
    );

    await registrarHistorial(
      connection,
      nuevoFamiliar.insertId,
      "CREATE",
      "usuario",
      actorId,
      req,
      null,
      `Familiar cargado por el afiliado. Datos: ${nombreNormalizado} ${apellidoNormalizado}${documentoNormalizado ? `, DNI: ${documentoNormalizado}` : ""}`
    );

    await connection.commit();
    res.status(201).json({ success: true, id: nuevoFamiliar.insertId, message: "Familiar agregado a tu grupo familiar" });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    if (error && error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Ya existe otra persona registrada con ese DNI" });
    }
    registrarErrorRuta(error);
    res.status(500).json({ success: false, message: "Error al agregar el familiar" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// PUT /familiares/:id/vinculo - Cambia el vínculo de una persona con el afiliado.
// Body: { es_familiar: 'S' | 'N', parentesco_id? } — 'S' suma la persona al grupo
// familiar (coseguro), 'N' la deja solo como acompañante de viaje.
router.put("/familiares/:id/vinculo", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "afiliado") {
      return res.status(401).json({ success: false, message: "No autorizado" });
    }

    const actorId = normalizarIdPositivo(cabecera.id);
    const personaId = normalizarIdPositivo(req.params.id);
    const esFamiliar = req.body?.es_familiar;
    const parentescoId = normalizarIdPositivo(req.body?.parentesco_id);

    if (!actorId || !personaId || personaId === actorId) {
      return res.status(400).json({ success: false, message: "ID inválido" });
    }
    if (!["S", "N"].includes(esFamiliar)) {
      return res.status(400).json({ success: false, message: "El tipo de vínculo es inválido" });
    }
    if (esFamiliar === "S" && ![2, 3, 4].includes(parentescoId)) {
      return res.status(400).json({ success: false, message: "El parentesco es inválido" });
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const [titulares] = await connection.query(
      "SELECT id, departamental_id FROM usuario WHERE id = ? AND habilitado = 'Y' FOR UPDATE",
      [actorId]
    );
    if (titulares.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }
    const titularDepartamentalId = normalizarIdPositivo(titulares[0].departamental_id);
    if (!titularDepartamentalId) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "El titular no tiene una departamental valida asignada",
      });
    }
    const [personas] = await connection.query(
      `SELECT id, usuario_familiar_id, es_familiar, parentesco_id, departamental_id, password, email
       FROM usuario WHERE id = ? FOR UPDATE`,
      [personaId]
    );
    if (personas.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Persona no encontrada" });
    }

    const persona = personas[0];
    const esDelGrupo = normalizarIdPositivo(persona.usuario_familiar_id) === actorId;
    const sinCuenta = persona.password === null && (persona.email === null || persona.email === "");

    if (esFamiliar === "N" && !esDelGrupo) {
      await connection.rollback();
      return res.status(401).json({ success: false, message: "No autorizado" });
    }

    if (!esDelGrupo) {
      // Solo se puede sumar al grupo a alguien sin cuenta propia que haya
      // compartido al menos una reserva con el afiliado.
      const [comparte] = await connection.query(
        `SELECT COUNT(*) AS c
         FROM reserva_familiar rf
         WHERE rf.usuario_id = ?
           AND rf.reserva_id IN (SELECT rf2.reserva_id FROM reserva_familiar rf2 WHERE rf2.usuario_id = ?)`,
        [personaId, actorId]
      );
      if (!sinCuenta || Number(comparte[0].c) === 0) {
        await connection.rollback();
        return res.status(401).json({ success: false, message: "No autorizado" });
      }
    }

    const cambios = [{ campo: "es_familiar", valorAnterior: persona.es_familiar, valorNuevo: esFamiliar }];
    if (esFamiliar === "S" && parentescoId && parentescoId !== persona.parentesco_id) {
      cambios.push({ campo: "parentesco_id", valorAnterior: persona.parentesco_id, valorNuevo: parentescoId });
    }
    const usuarioFamiliarIdNuevo = esFamiliar === "S" ? actorId : null;
    if (normalizarIdPositivo(persona.usuario_familiar_id) !== usuarioFamiliarIdNuevo) {
      cambios.push({
        campo: "usuario_familiar_id",
        valorAnterior: persona.usuario_familiar_id,
        valorNuevo: usuarioFamiliarIdNuevo,
      });
    }
    if (esFamiliar === "S" && Number(persona.departamental_id) !== titularDepartamentalId) {
      cambios.push({
        campo: "departamental_id",
        valorAnterior: persona.departamental_id,
        valorNuevo: titularDepartamentalId,
      });
    }

    await connection.query(
      `UPDATE usuario
       SET es_familiar = ?,
           usuario_familiar_id = ?,
           parentesco_id = COALESCE(?, parentesco_id),
           departamental_id = CASE WHEN ? = 'S' THEN ? ELSE departamental_id END
       WHERE id = ?`,
      [
        esFamiliar,
        usuarioFamiliarIdNuevo,
        esFamiliar === "S" ? parentescoId : null,
        esFamiliar,
        titularDepartamentalId,
        personaId,
      ]
    );

    await registrarHistorial(
      connection,
      personaId,
      "UPDATE",
      "usuario",
      actorId,
      req,
      cambios,
      esFamiliar === "S"
        ? "Persona sumada al grupo familiar por el afiliado"
        : "Persona quitada del grupo familiar por el afiliado"
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: esFamiliar === "S" ? "Persona sumada a tu grupo familiar" : "Persona quitada de tu grupo familiar",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    registrarErrorRuta(error);
    res.status(500).json({ success: false, message: "Error al actualizar el vínculo" });
  } finally {
    if (connection) connection.release();
  }
});

// GET /tabla/historial-usuario/:id? - Obtiene el historial de cambios de usuarios
router.get("/tabla/historial-usuario/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "departamental"
    ) {
      const userId = req.params.id === undefined ? null : normalizarIdPositivo(req.params.id);
      if (req.params.id !== undefined && !userId) {
        return res.status(400).json("ID de usuario invalido");
      }

      const esDepartamental = cabecera.rol === "departamental";
      const departamentalId = esDepartamental
        ? normalizarIdPositivo(cabecera.departamental_id)
        : null;

      if (esDepartamental) {
        if (!userId) {
          return res.status(400).json("El ID de usuario es requerido");
        }
        if (!departamentalId) {
          return res.status(403).json("No autorizado");
        }

        const [usuariosPermitidos] = await mysqlConnection.promise().execute(
          `SELECT id
           FROM usuario
           WHERE id = ?
             AND departamental_id = ?
           LIMIT 1`,
          [userId, departamentalId]
        );
        if (usuariosPermitidos.length === 0) {
          return res.status(403).json("No autorizado");
        }
      }

      const paginacion = normalizarPaginacion(req.query, 20);
      if (!paginacion) return res.status(400).json("La paginación es inválida");
      const { page, pageSize: resultsPerPage, start } = paginacion;

      const columnasOrdenHistorialUsuario = {
        fecha_modificacion: "h.fecha_modificacion",
        tipo_operacion: "h.tipo_operacion",
        campo_modificado: "h.campo_modificado",
        valor_anterior: "h.valor_anterior",
        valor_nuevo: "h.valor_nuevo",
        tabla_afectada: "h.tabla_afectada",
        modificador_nombre: "CONCAT_WS(' ', um.nombre, um.apellido)",
        usuario_nombre: "CONCAT_WS(' ', u.nombre, u.apellido)",
        observaciones: "h.observaciones",
      };
      const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenHistorialUsuario, req.query.orderBy)
        ? req.query.orderBy
        : "fecha_modificacion";
      const orderBy = columnasOrdenHistorialUsuario[orderByKey];
      const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

      const tipoOperacion = req.query.tipo_operacion;
      const fechaDesde = req.query.fecha_desde;
      const fechaHasta = req.query.fecha_hasta;

      let whereClause = "";
      let params = [];

      if (userId) {
        whereClause += " WHERE h.usuario_id = ?";
        params.push(userId);
      }

      if (esDepartamental) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " u.departamental_id = ?";
        params.push(departamentalId);
      }

      if (tipoOperacion) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " h.tipo_operacion = ?";
        params.push(tipoOperacion);
      }

      if (fechaDesde) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " h.fecha_modificacion >= ?";
        params.push(fechaDesde);
      }

      if (fechaHasta) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " h.fecha_modificacion <= ?";
        params.push(fechaHasta + ' 23:59:59');
      }

      const search = String(req.query.search || "").trim();
      if (search) {
        const like = `%${search}%`;
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += ` (DATE_FORMAT(h.fecha_modificacion, '%d/%m/%Y %H:%i:%s') LIKE ?
          OR h.tipo_operacion LIKE ? OR h.campo_modificado LIKE ? OR h.valor_anterior LIKE ?
          OR h.valor_nuevo LIKE ? OR h.tabla_afectada LIKE ?
          OR CONCAT(um.nombre, ' ', um.apellido) LIKE ? OR h.observaciones LIKE ?
          OR ${HISTORIAL_USUARIO_LEGIBLE.valorAnteriorSql} LIKE ?
          OR ${HISTORIAL_USUARIO_LEGIBLE.valorNuevoSql} LIKE ?)`;
        params.push(...Array(10).fill(like));
      }

      const query = `
        SELECT
          h.id,
          h.usuario_id,
          CONCAT(u.nombre, ' ', u.apellido) as usuario_nombre,
          u.documento as usuario_documento,
          h.tipo_operacion,
          h.campo_modificado,
          h.valor_anterior,
          h.valor_nuevo,
          ${HISTORIAL_USUARIO_LEGIBLE.valorAnteriorSql} as valor_anterior_legible,
          ${HISTORIAL_USUARIO_LEGIBLE.valorNuevoSql} as valor_nuevo_legible,
          h.tabla_afectada,
          h.usuario_modificador_id,
          CONCAT(um.nombre, ' ', um.apellido) as modificador_nombre,
          DATE_FORMAT(h.fecha_modificacion, '%d/%m/%Y %H:%i:%s') as fecha_modificacion,
          h.observaciones
        FROM historial_usuario h
        INNER JOIN usuario u ON h.usuario_id = u.id
        LEFT JOIN usuario um ON h.usuario_modificador_id = um.id
        ${HISTORIAL_USUARIO_LEGIBLE.joins}
        ${whereClause}
        ORDER BY ${orderBy} ${orderType}, h.id DESC
        LIMIT ${start}, ${resultsPerPage}
      `;

      const [rows] = await mysqlConnection.promise().execute(query, params);

      // Consulta para el total de registros
      const countQuery = `
        SELECT COUNT(*) as total
        FROM historial_usuario h
        INNER JOIN usuario u ON h.usuario_id = u.id
        LEFT JOIN usuario um ON h.usuario_modificador_id = um.id
        ${search ? HISTORIAL_USUARIO_LEGIBLE.joins : ""}
        ${whereClause}
      `;

      const [countRows] = await mysqlConnection.promise().execute(countQuery, params);
      const total = countRows[0].total;
      const numOfPages = Math.ceil(total / resultsPerPage);

      res.status(200).json({
        results: rows,
        numOfPages,
        totalItems: total,
        page: page - 1,
        pageSize: resultsPerPage,
        orderBy: orderByKey,
        orderType
      });

    } else {
      res.status(403).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el historial de usuarios");
  }
});

// GET /tabla/historial-departamental/:id? - Obtiene el historial de cambios de departamentales
router.get("/tabla/historial-departamental/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const departamentalId = req.params.id;
    const paginacion = normalizarPaginacion(req.query, 20);
    if (!paginacion) return res.status(400).json("La paginación es inválida");
    const { page, pageSize: resultsPerPage, start } = paginacion;

    const columnasOrdenHistorialDepartamental = {
      fecha_cambio: "h.fecha_cambio",
      operacion: "h.operacion",
      campo_afectado: "h.campo_afectado",
      valor_anterior: "h.valor_anterior",
      valor_nuevo: "h.valor_nuevo",
      usuario_nombre: "CONCAT_WS(' ', u.nombre, u.apellido)",
      departamental_nombre: "d.nombre",
    };
    const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenHistorialDepartamental, req.query.orderBy)
      ? req.query.orderBy
      : "fecha_cambio";
    const orderBy = columnasOrdenHistorialDepartamental[orderByKey];
    const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

    const operacion = req.query.operacion;
    const campoAfectado = req.query.campo_afectado;
    const fechaDesde = req.query.fecha_desde;
    const fechaHasta = req.query.fecha_hasta;

    let whereClause = "";
    let params = [];

    if (departamentalId) {
      whereClause += " WHERE h.departamental_id = ?";
      params.push(departamentalId);
    }

    if (operacion) {
      whereClause += whereClause ? " AND" : " WHERE";
      whereClause += " h.operacion = ?";
      params.push(operacion);
    }

    if (campoAfectado) {
      whereClause += whereClause ? " AND" : " WHERE";
      whereClause += " h.campo_afectado = ?";
      params.push(campoAfectado);
    }

    if (fechaDesde) {
      whereClause += whereClause ? " AND" : " WHERE";
      whereClause += " h.fecha_cambio >= ?";
      params.push(fechaDesde);
    }

    if (fechaHasta) {
      whereClause += whereClause ? " AND" : " WHERE";
      whereClause += " h.fecha_cambio <= ?";
      params.push(fechaHasta + ' 23:59:59');
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      const like = `%${search}%`;
      whereClause += whereClause ? " AND" : " WHERE";
      whereClause += ` (DATE_FORMAT(h.fecha_cambio, '%d/%m/%Y %H:%i:%s') LIKE ? OR h.operacion LIKE ?
        OR h.campo_afectado LIKE ? OR h.valor_anterior LIKE ? OR h.valor_nuevo LIKE ?
        OR CONCAT(u.nombre, ' ', u.apellido) LIKE ?)`;
      params.push(...Array(6).fill(like));
    }

    const query = `
      SELECT
        h.id,
        h.departamental_id,
        d.nombre as departamental_nombre,
        d.direccion as departamental_direccion,
        d.localidad as departamental_localidad,
        h.operacion,
        h.campo_afectado,
        h.valor_anterior,
        h.valor_nuevo,
        h.usuario_id,
        CONCAT(u.nombre, ' ', u.apellido) as usuario_nombre,
        DATE_FORMAT(h.fecha_cambio, '%d/%m/%Y %H:%i:%s') as fecha_cambio
      FROM historial_departamental h
      INNER JOIN departamental d ON h.departamental_id = d.id
      LEFT JOIN usuario u ON h.usuario_id = u.id
      ${whereClause}
      ORDER BY ${orderBy} ${orderType}, h.id DESC
      LIMIT ${start}, ${resultsPerPage}
    `;

    const [rows] = await mysqlConnection.promise().execute(query, params);

    // Consulta para el total de registros
    const countQuery = `
      SELECT COUNT(*) as total
      FROM historial_departamental h
      INNER JOIN departamental d ON h.departamental_id = d.id
      LEFT JOIN usuario u ON h.usuario_id = u.id
      ${whereClause}
    `;

    const [countRows] = await mysqlConnection.promise().execute(countQuery, params);
    const total = countRows[0].total;
    const numOfPages = Math.ceil(total / resultsPerPage);

    res.status(200).json({
      results: rows,
      numOfPages,
      totalItems: total,
      page: page - 1,
      pageSize: resultsPerPage,
      orderBy: orderByKey,
      orderType
    });

  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el historial de departamentales");
  }
});

// GET /tabla/historial-reserva/:id? - Obtiene el historial de cambios de reservas
router.get("/tabla/historial-reserva/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      (cabecera.rol === "admin" ||
        cabecera.rol === "departamental") &&
      tieneAreaTurismo(cabecera)
    ) {
      const reservaId = req.params.id === undefined ? null : normalizarIdPositivo(req.params.id);
      if (req.params.id !== undefined && !reservaId) {
        return res.status(400).json("ID de reserva invalido");
      }

      const esDepartamental = cabecera.rol === "departamental";
      const departamentalId = esDepartamental
        ? normalizarIdPositivo(cabecera.departamental_id)
        : null;

      if (esDepartamental) {
        if (!reservaId) {
          return res.status(400).json("El ID de reserva es requerido");
        }
        if (!departamentalId) {
          return res.status(403).json("No autorizado");
        }

        const [reservasPermitidas] = await mysqlConnection.promise().execute(
          `SELECT r.id
           FROM reserva r
           INNER JOIN usuario u ON u.id = r.usuario_id
           WHERE r.id = ?
             AND u.departamental_id = ?
           LIMIT 1`,
          [reservaId, departamentalId]
        );
        if (reservasPermitidas.length === 0) {
          return res.status(403).json("No autorizado");
        }
      }

      const paginacion = normalizarPaginacion(req.query, 20);
      if (!paginacion) return res.status(400).json("La paginación es inválida");
      const { page, pageSize: resultsPerPage, start } = paginacion;

      const columnasOrdenHistorialReserva = {
        fecha_modificacion: "h.fecha_modificacion",
        tipo_operacion: "h.tipo_operacion",
        campo_modificado: "h.campo_modificado",
        valor_anterior: "h.valor_anterior",
        valor_nuevo: "h.valor_nuevo",
        modificador_nombre: "CONCAT_WS(' ', um.nombre, um.apellido)",
        observaciones: "h.observaciones",
      };
      const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenHistorialReserva, req.query.orderBy)
        ? req.query.orderBy
        : "fecha_modificacion";
      const orderBy = columnasOrdenHistorialReserva[orderByKey];
      const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

      const tipoOperacion = req.query.tipo_operacion;
      const fechaDesde = req.query.fecha_desde;
      const fechaHasta = req.query.fecha_hasta;

      let whereClause = "";
      let params = [];

      if (reservaId) {
        whereClause += " WHERE h.reserva_id = ?";
        params.push(reservaId);
      }

      if (esDepartamental) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " u.departamental_id = ?";
        params.push(departamentalId);
      }

      if (tipoOperacion) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " h.tipo_operacion = ?";
        params.push(tipoOperacion);
      }

      if (fechaDesde) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " h.fecha_modificacion >= ?";
        params.push(fechaDesde);
      }

      if (fechaHasta) {
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += " h.fecha_modificacion <= ?";
        params.push(fechaHasta + ' 23:59:59');
      }

      const search = String(req.query.search || "").trim();
      if (search) {
        const like = `%${search}%`;
        whereClause += whereClause ? " AND" : " WHERE";
        whereClause += ` (DATE_FORMAT(h.fecha_modificacion, '%d/%m/%Y %H:%i:%s') LIKE ?
          OR h.tipo_operacion LIKE ? OR h.campo_modificado LIKE ? OR h.valor_anterior LIKE ?
          OR h.valor_nuevo LIKE ? OR CONCAT(um.nombre, ' ', um.apellido) LIKE ? OR h.observaciones LIKE ?
          OR ${HISTORIAL_RESERVA_LEGIBLE.valorAnteriorSql} LIKE ?
          OR ${HISTORIAL_RESERVA_LEGIBLE.valorNuevoSql} LIKE ?)`;
        params.push(...Array(9).fill(like));
      }

      const joinsAlcanceDepartamental = esDepartamental
        ? `INNER JOIN reserva r ON r.id = h.reserva_id
           INNER JOIN usuario u ON u.id = r.usuario_id`
        : "";

      const query = `
        SELECT
          h.id,
          h.reserva_id,
          h.tipo_operacion,
          h.campo_modificado,
          h.valor_anterior,
          h.valor_nuevo,
          ${HISTORIAL_RESERVA_LEGIBLE.valorAnteriorSql} as valor_anterior_legible,
          ${HISTORIAL_RESERVA_LEGIBLE.valorNuevoSql} as valor_nuevo_legible,
          h.usuario_modificador_id,
          CONCAT(um.nombre, ' ', um.apellido) as modificador_nombre,
          DATE_FORMAT(h.fecha_modificacion, '%d/%m/%Y %H:%i:%s') as fecha_modificacion,
          h.observaciones
        FROM historial_reserva h
        ${joinsAlcanceDepartamental}
        LEFT JOIN usuario um ON h.usuario_modificador_id = um.id
        ${HISTORIAL_RESERVA_LEGIBLE.joins}
        ${whereClause}
        ORDER BY ${orderBy} ${orderType}, h.id DESC
        LIMIT ${start}, ${resultsPerPage}
      `;

      const [rows] = await mysqlConnection.promise().execute(query, params);

      // Consulta para el total de registros
      const countQuery = `
        SELECT COUNT(*) as total
        FROM historial_reserva h
        ${joinsAlcanceDepartamental}
        LEFT JOIN usuario um ON h.usuario_modificador_id = um.id
        ${search ? HISTORIAL_RESERVA_LEGIBLE.joins : ""}
        ${whereClause}
      `;

      const [countRows] = await mysqlConnection.promise().execute(countQuery, params);
      const total = countRows[0].total;
      const numOfPages = Math.ceil(total / resultsPerPage);

      res.status(200).json({
        results: rows,
        numOfPages,
        totalItems: total,
        page: page - 1,
        pageSize: resultsPerPage,
        orderBy: orderByKey,
        orderType
      });

    } else {
      res.status(403).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el historial de reservas");
  }
});

router.post("/tabla/usuarios", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "departamental"
    ) {
      let buscar = req.query.search;
      const filters = req.body;

      // Paginación (1-based, clampada: un page=0 o inválido no debe generar
      // un LIMIT negativo, que es error de sintaxis en MySQL)
      const paginacion = normalizarPaginacion(req.query, 10);
      if (!paginacion) return res.status(400).json("La paginación es inválida");
      const { page, pageSize: resultsPerPage, start } = paginacion;

      // Ordenamiento
      const columnasOrdenUsuarios = {
        id: "u.id",
        nombre: "u.nombre",
        apellido: "u.apellido",
        rol: "r.nombre",
        documento: "u.documento",
        legajo: "u.legajo",
        fecha_nacimiento: "u.fecha_nacimiento",
        habilitado: "u.habilitado",
        fecha_creacion: "u.fecha_creacion",
      };
      const orderByKey = Object.prototype.hasOwnProperty.call(columnasOrdenUsuarios, req.query.orderBy)
        ? req.query.orderBy
        : "fecha_creacion";
      const orderBy = columnasOrdenUsuarios[orderByKey];
      const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

      const queryOrderBy = `${orderBy} ${orderType}`;

      // Filtro de búsqueda general
      let queryBuscar = "";
      const queryBuscarParams = [];
      if (buscar) {
        const like = `%${buscar}%`;
        queryBuscar = `AND (CAST(u.id AS CHAR) LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ?
          OR CAST(u.documento AS CHAR) LIKE ? OR u.legajo LIKE ? OR r.nombre LIKE ?
          OR DATE_FORMAT(u.fecha_nacimiento, '%d/%m/%Y') LIKE ? OR DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') LIKE ?)`;
        queryBuscarParams.push(...Array(8).fill(like));
      }

      // Construcción de filtros específicos
      let whereConditions = [];
      let queryParams = [];

      // Filtro por rol departamental
      if (cabecera.rol === "departamental") {
        whereConditions.push(`u.departamental_id = ?`);
        queryParams.push(cabecera.departamental_id);

        whereConditions.push(`u.rol_id IN (2, 4)`);
      }

      // Filtro por roles
      if (filters.roles && Array.isArray(filters.roles) && filters.roles.length > 0) {
        const placeholders = filters.roles.map(() => '?').join(',');
        whereConditions.push(`u.rol_id IN (${placeholders})`);
        queryParams.push(...filters.roles);
      }

      // Filtro por edad (calculada desde fecha_nacimiento)
      if (filters.edad_minima) {
        whereConditions.push(`TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) >= ?`);
        queryParams.push(filters.edad_minima);
      }

      if (filters.edad_maxima) {
        whereConditions.push(`TIMESTAMPDIFF(YEAR, u.fecha_nacimiento, CURDATE()) <= ?`);
        queryParams.push(filters.edad_maxima);
      }

      // Filtro por rango de fecha de nacimiento
      if (filters.fecha_nacimiento_minima) {
        whereConditions.push(`u.fecha_nacimiento >= ?`);
        queryParams.push(filters.fecha_nacimiento_minima);
      }

      if (filters.fecha_nacimiento_maxima) {
        whereConditions.push(`u.fecha_nacimiento <= ?`);
        queryParams.push(filters.fecha_nacimiento_maxima);
      }

      // Filtro por habilitado
      if (filters.habilitado && (filters.habilitado === 'Y' || filters.habilitado === 'N')) {
        whereConditions.push(`u.habilitado = ?`);
        queryParams.push(filters.habilitado);
      }

      // Filtro por rango de fecha de creación
      if (filters.fecha_creacion_minima) {
        whereConditions.push(`DATE(u.fecha_creacion) >= ?`);
        queryParams.push(filters.fecha_creacion_minima);
      }

      if (filters.fecha_creacion_maxima) {
        whereConditions.push(`DATE(u.fecha_creacion) <= ?`);
        queryParams.push(filters.fecha_creacion_maxima);
      }

      // Filtro departamentales_ids (solo admin)
      if (
        cabecera.rol === "admin" &&
        filters.departamentales_ids &&
        Array.isArray(filters.departamentales_ids) &&
        filters.departamentales_ids.length > 0
      ) {
        const placeholders = filters.departamentales_ids.map(() => '?').join(',');
        whereConditions.push(`u.departamental_id IN (${placeholders})`);
        queryParams.push(...filters.departamentales_ids);
      }

      // Construcción de la cláusula WHERE
      let whereClause = "";
      if (whereConditions.length > 0) {
        whereClause = "AND " + whereConditions.join(" AND ");
      }

      // Query principal
      let query = `
        SELECT 
          u.id,
          CASE 
            WHEN r.nombre = 'admin' THEN 'Admin'
            WHEN r.nombre = 'afiliado' THEN 'Afiliado'
            WHEN r.nombre = 'departamental' THEN 'Departamental'
            WHEN r.nombre = 'invitado' THEN 'Invitado'
            ELSE r.nombre
          END AS rol,
          u.nombre,
          u.apellido,
          DATE_FORMAT(u.fecha_nacimiento, '%d/%m/%Y') AS fecha_nacimiento,
          u.documento,
          COALESCE(u.legajo, '') AS legajo,
          u.habilitado,
          DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') AS fecha_creacion
        FROM usuario u
        LEFT JOIN rol r ON u.rol_id = r.id
        WHERE 1=1 
          ${queryBuscar}
          ${whereClause}
        ORDER BY ${queryOrderBy}, u.id DESC
        LIMIT ${start}, ${resultsPerPage}
      `;

      const [rows] = await mysqlConnection.promise().execute(query, [...queryBuscarParams, ...queryParams]);

      // Query para contar el total de registros
      let countQuery = `
        SELECT COUNT(*) AS count
        FROM usuario u
        LEFT JOIN rol r ON u.rol_id = r.id
        WHERE 1=1 
          ${queryBuscar}
          ${whereClause}
      `;

      const [countRows] = await mysqlConnection.promise().execute(countQuery, [...queryBuscarParams, ...queryParams]);

      const numOfResults = countRows[0].count;
      const numOfPages = Math.ceil(numOfResults / resultsPerPage);

      res.json({
        results: rows,
        numOfPages,
        totalItems: numOfResults,
        page: page - 1,
        orderBy: orderByKey,
        orderType,
      });

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error interno");
  }
});

router.get("/rol", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "admin") {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM rol ORDER BY id ASC");

      const rolesMap = {
        admin: "Admin",
        afiliado: "Afiliado",
        departamental: "Departamental",
        invitado: "Invitado"
      };

      const roles = rows.map(r => ({
        id: r.id,
        nombre: rolesMap[r.nombre] || r.nombre
      }));

      res.status(200).json(roles);
    } else if (cabecera.rol === "departamental") {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM rol WHERE nombre IN ('afiliado', 'invitado') ORDER BY id ASC");

      const rolesMap = {
        afiliado: "Afiliado",
        invitado: "Invitado"
      };

      const roles = rows.map(r => ({
        id: r.id,
        nombre: rolesMap[r.nombre] || r.nombre
      }));

      res.status(200).json(roles);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los roles");
  }
});

router.get("/usuario", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const documento = req.query.documento;
      if (!documento) {
        return res.status(400).json("Falta el parámetro 'documento'");
      }
      const [rows] = await mysqlConnection
        .promise()
        .query(
          `SELECT 
            id, 
            nombre, 
            apellido, 
            documento, 
            parentesco_id, 
            fecha_nacimiento, 
            telefono, 
            email, 
            rol_id as rol, 
            departamental_id 
          FROM usuario 
          WHERE documento = ?`,
          [documento]
        );
      res.status(200).json(rows);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el usuario");
  }
});

// Función auxiliar para guardar historial de cambios
async function guardarHistorialTemporada(connection, temporadaId, usuarioId, operacion, campoAfectado, valorAnterior, valorNuevo) {
  try {
    await connection.query(
      `INSERT INTO historial_temporada
       (temporada_id, usuario_id, operacion, campo_afectado, valor_anterior, valor_nuevo, fecha_cambio)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [temporadaId, usuarioId, operacion, campoAfectado, valorAnterior, valorNuevo]
    );
  } catch (error) {
    console.error("Error al guardar historial:", error);
    // No lanzamos el error para que no afecte la operación principal
  }
}

function normalizarBanderaPorcentaje(valor) {
  if (valor === undefined || valor === null) {
    return false;
  }
  if (typeof valor === "string") {
    const normalizado = valor.trim().toLowerCase();
    return normalizado === "1" || normalizado === "true" || normalizado === "y" || normalizado === "yes";
  }
  return Boolean(valor);
}

function normalizarValorPorcentaje(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return null;
  }
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  const puntosBase = decimalAPuntosBase(numero);
  return puntosBase !== null && puntosBase <= 10000 ? puntosBase / 100 : null;
}

function construirMapaPreciosDeLista(tiposPersona) {
  const mapa = new Map();
  const rangosPrecioLista = [];
  if (!Array.isArray(tiposPersona)) {
    return mapa;
  }

  for (const tipoPersona of tiposPersona) {
    const tipoPersonaId = tipoPersona?.tipoPersonaId ?? tipoPersona?.tipo_persona_id;
    if (Number(tipoPersonaId) !== 4 || !Array.isArray(tipoPersona?.rangosEdad)) {
      continue;
    }

    for (const rango of tipoPersona.rangosEdad) {
      const edadMin = rango?.edadMinima ?? rango?.edad_minima ?? "";
      const edadMax = rango?.edadMaxima ?? rango?.edad_maxima ?? "";
      const key = `${edadMin}-${edadMax}`;
      const precio = Number(rango?.precio ?? 0);
      if (!Number.isNaN(precio)) {
        mapa.set(key, precio);
        rangosPrecioLista.push({
          edad_minima: edadMin === "" ? null : Number(edadMin),
          edad_maxima: edadMax === "" || edadMax === null || edadMax === undefined ? null : Number(edadMax),
          precio,
        });
      }
    }
  }

  mapa.set("__rangos_precio_lista__", rangosPrecioLista);
  return mapa;
}

function buscarPrecioListaPorCobertura(mapaPreciosDeLista, edadMin, edadMax) {
  const rangos = mapaPreciosDeLista?.get
    ? mapaPreciosDeLista.get("__rangos_precio_lista__")
    : [];

  if (!Array.isArray(rangos) || rangos.length === 0) {
    return undefined;
  }

  const minObjetivo = edadMin === "" || edadMin === null || edadMin === undefined
    ? null
    : Number(edadMin);
  const maxObjetivo = edadMax === "" || edadMax === null || edadMax === undefined
    ? null
    : Number(edadMax);

  if (minObjetivo === null || Number.isNaN(minObjetivo)) {
    return undefined;
  }

  const rangoContenedor = rangos.find((rango) => {
    const minBase = Number(rango.edad_minima);
    const maxBase = rango.edad_maxima === null || rango.edad_maxima === undefined
      ? null
      : Number(rango.edad_maxima);

    if (!Number.isFinite(minBase) || minBase > minObjetivo) {
      return false;
    }

    if (maxObjetivo === null) {
      return maxBase === null;
    }

    return maxBase === null || maxBase >= maxObjetivo;
  });

  return rangoContenedor ? rangoContenedor.precio : undefined;
}

function calcularPrecioRangoConPorcentaje(rangoEdad, tipoPersonaId, mapaPreciosDeLista) {
  const usaPorcentaje = normalizarBanderaPorcentaje(rangoEdad?.usa_porcentaje ?? rangoEdad?.usaPorcentaje);
  
  let rawPorcentaje = rangoEdad?.porcentaje_descuento ??
      rangoEdad?.porcentaje ??
      rangoEdad?.porcentajeDescuento;

  // Si usa porcentaje y no viene el campo explicito, asumimos que el precio es el porcentaje
  if (usaPorcentaje && (rawPorcentaje === undefined || rawPorcentaje === null)) {
    rawPorcentaje = rangoEdad?.precio;
  }

  let porcentajeDescuento = normalizarValorPorcentaje(rawPorcentaje);

  // Si no usa porcentaje, forzamos 0 si es null
  if (!usaPorcentaje && porcentajeDescuento === null) {
    porcentajeDescuento = 0;
  }

  let precioTarifa = Number(rangoEdad?.precio ?? 0);
  if (Number.isNaN(precioTarifa)) {
    precioTarifa = 0;
  }

  if (usaPorcentaje && Number(tipoPersonaId) !== 4) {
    const edadMin = rangoEdad?.edadMinima ?? rangoEdad?.edad_minima ?? "";
    const edadMax = rangoEdad?.edadMaxima ?? rangoEdad?.edad_maxima ?? "";
    const key = `${edadMin}-${edadMax}`;
    let precioBase = mapaPreciosDeLista?.get
      ? mapaPreciosDeLista.get(key)
      : undefined;
    if (typeof precioBase !== "number" || Number.isNaN(precioBase)) {
      precioBase = buscarPrecioListaPorCobertura(mapaPreciosDeLista, edadMin, edadMax);
    }

    if (typeof precioBase === "number" && !Number.isNaN(precioBase)) {
      const precioBaseCentavos = decimalACentavos(precioBase);
      const descuentoPuntosBase = decimalAPuntosBase(porcentajeDescuento !== null ? porcentajeDescuento : 0);
      const precioFinalCentavos = precioBaseCentavos !== null && descuentoPuntosBase !== null
        ? aplicarDescuentoEnPuntosBase(precioBaseCentavos, descuentoPuntosBase)
        : null;
      if (precioFinalCentavos !== null) {
        precioTarifa = centavosANumero(precioFinalCentavos);
      }
    }
  }

  return {
    precioTarifa,
    usaPorcentaje,
    porcentajeDescuento,
  };
}

function normalizarParcelasDisponibles(valor, valorPorDefecto = 100) {
  if (valor === undefined || valor === null || valor === "") {
    return { value: valorPorDefecto };
  }

  const numero = Number(valor);
  if (!Number.isFinite(numero) || !Number.isInteger(numero) || numero < 0) {
    return { error: "parcelas_disponibles debe ser un numero entero mayor o igual a 0" };
  }

  return { value: numero };
}

function esPrecioPorPersonaConfiguracion(valor) {
  return valor === true || valor === 1 || ["1", "true", "y", "yes", "s", "si"].includes(String(valor || "").trim().toLowerCase());
}

function validarConfiguracionTemporada({
  nombreCampania,
  fechaInicio,
  fechaFin,
  configuracionServicios,
  porcentajesTipoPersona = [],
}) {
  const nombre = normalizarTexto(nombreCampania);
  const inicioTemporada = formatearFechaSQL(fechaInicio);
  const finTemporada = formatearFechaSQL(fechaFin);
  if (!nombre || nombre.length > 150) return "El nombre de campaña es requerido y admite hasta 150 caracteres";
  if (!inicioTemporada || !finTemporada || inicioTemporada > finTemporada) return "El rango de la temporada no es válido";
  if (!Array.isArray(configuracionServicios) || configuracionServicios.length === 0 || configuracionServicios.length > 100) {
    return "La temporada debe incluir entre 1 y 100 servicios";
  }

  let cantidadRangos = 0;
  const rangosPorRecursoRegimen = new Map();
  for (let indiceServicio = 0; indiceServicio < configuracionServicios.length; indiceServicio++) {
    const servicio = configuracionServicios[indiceServicio];
    const servicioId = normalizarIdPositivo(servicio?.id ?? servicio?.servicio_id);
    if (!servicioId || !Array.isArray(servicio?.regimenes) || servicio.regimenes.length === 0) {
      return `El servicio ${indiceServicio + 1} no tiene un identificador o regímenes válidos`;
    }

    for (let indiceRegimen = 0; indiceRegimen < servicio.regimenes.length; indiceRegimen++) {
      const regimen = servicio.regimenes[indiceRegimen];
      const regimenId = normalizarIdPositivo(regimen?.id ?? regimen?.regimen_id);
      if (!regimenId || !Array.isArray(regimen?.recursos) || regimen.recursos.length === 0) {
        return `El régimen ${indiceRegimen + 1} del servicio ${servicioId} no es válido`;
      }

      for (let indiceRecurso = 0; indiceRecurso < regimen.recursos.length; indiceRecurso++) {
        const recurso = regimen.recursos[indiceRecurso];
        const recursoId = normalizarIdPositivo(recurso?.id ?? recurso?.recurso_id);
        if (!recursoId || !Array.isArray(recurso?.fechas) || recurso.fechas.length === 0) {
          return `El recurso ${indiceRecurso + 1} del servicio ${servicioId} no tiene rangos válidos`;
        }
        recurso.precio_por_persona = esPrecioPorPersonaConfiguracion(recurso.precio_por_persona);
        const claveRecurso = `${recursoId}:${regimenId}`;
        const rangosRecurso = rangosPorRecursoRegimen.get(claveRecurso) || [];

        for (let indiceFecha = 0; indiceFecha < recurso.fechas.length; indiceFecha++) {
          cantidadRangos += 1;
          if (cantidadRangos > 10000) return "La configuración supera el máximo de 10.000 rangos";
          const fecha = recurso.fechas[indiceFecha];
          const inicio = formatearFechaSQL(fecha?.fecha_inicio);
          const fin = formatearFechaSQL(fecha?.fecha_fin);
          if (!inicio || !fin || inicio > fin || inicio < inicioTemporada || fin > finTemporada) {
            return `El rango ${indiceFecha + 1} del recurso ${recursoId} es inválido o queda fuera de la temporada`;
          }
          fecha.fecha_inicio = inicio;
          fecha.fecha_fin = fin;
          if (rangosRecurso.some((rango) => inicio <= rango.fin && fin >= rango.inicio)) {
            return `El recurso ${recursoId} tiene rangos de fechas solapados para el mismo régimen`;
          }
          rangosRecurso.push({ inicio, fin });

          const adicionalesVistos = new Set();
          for (const adicional of Array.isArray(fecha.adicionales) ? fecha.adicionales : []) {
            const adicionalId = normalizarIdPositivo(adicional?.adicionalId ?? adicional?.adicional_id);
            const precioCentavos = decimalACentavos(adicional?.precio);
            if (!adicionalId || precioCentavos === null || adicionalesVistos.has(adicionalId)) {
              return `El rango ${indiceFecha + 1} del recurso ${recursoId} contiene un adicional inválido o repetido`;
            }
            adicionalesVistos.add(adicionalId);
            adicional.adicionalId = adicionalId;
            adicional.precio = centavosANumero(precioCentavos);
          }

          if (!recurso.precio_por_persona) {
            const precioCentavos = decimalACentavos(fecha?.precio);
            if (precioCentavos === null) return `El rango ${indiceFecha + 1} del recurso ${recursoId} tiene un precio inválido`;
            fecha.precio = centavosANumero(precioCentavos);
            continue;
          }

          if (!Array.isArray(fecha?.tiposPersona) || fecha.tiposPersona.length === 0) {
            return `El rango ${indiceFecha + 1} del recurso ${recursoId} no tiene tipos de persona`;
          }
          const tiposVistos = new Set();
          for (const tipoPersona of fecha.tiposPersona) {
            const tipoPersonaId = normalizarIdPositivo(tipoPersona?.tipoPersonaId ?? tipoPersona?.tipo_persona_id);
            if (!tipoPersonaId || tiposVistos.has(tipoPersonaId) || !Array.isArray(tipoPersona?.rangosEdad) || tipoPersona.rangosEdad.length === 0) {
              return `El rango ${indiceFecha + 1} del recurso ${recursoId} contiene un tipo de persona inválido o repetido`;
            }
            tiposVistos.add(tipoPersonaId);
            tipoPersona.tipoPersonaId = tipoPersonaId;
            const edades = [];
            for (const rangoEdad of tipoPersona.rangosEdad) {
              const minimoRaw = rangoEdad?.edadMinima ?? rangoEdad?.edad_minima;
              const maximoRaw = rangoEdad?.edadMaxima ?? rangoEdad?.edad_maxima;
              const minimo = minimoRaw === "" || minimoRaw === null || minimoRaw === undefined ? 0 : Number(minimoRaw);
              const maximo = maximoRaw === "" || maximoRaw === null || maximoRaw === undefined ? null : Number(maximoRaw);
              if (!Number.isInteger(minimo) || minimo < 0 || minimo > 130 || (maximo !== null && (!Number.isInteger(maximo) || maximo < minimo || maximo > 130))) {
                return `El recurso ${recursoId} tiene un rango de edad inválido`;
              }
              const maximoComparacion = maximo === null ? 130 : maximo;
              if (edades.some((rango) => minimo <= rango.maximo && maximoComparacion >= rango.minimo)) {
                return `El recurso ${recursoId} tiene rangos de edad solapados para el tipo ${tipoPersonaId}`;
              }
              edades.push({ minimo, maximo: maximoComparacion });
              rangoEdad.edadMinima = minimo;
              rangoEdad.edadMaxima = maximo;

              const usaPorcentaje = normalizarBanderaPorcentaje(rangoEdad?.usa_porcentaje ?? rangoEdad?.usaPorcentaje);
              if (tipoPersonaId === 4 && usaPorcentaje) {
                return `El precio de lista del recurso ${recursoId} no puede definirse como porcentaje`;
              }
              const porcentajeRaw = rangoEdad?.porcentaje_descuento ?? rangoEdad?.porcentaje ?? rangoEdad?.porcentajeDescuento ?? (usaPorcentaje ? rangoEdad?.precio : 0);
              const porcentajePuntosBase = decimalAPuntosBase(porcentajeRaw);
              if (porcentajePuntosBase === null || porcentajePuntosBase > 10000) {
                return `El recurso ${recursoId} tiene un porcentaje fuera del rango 0 a 100`;
              }
              rangoEdad.usa_porcentaje = usaPorcentaje;
              rangoEdad.porcentaje_descuento = usaPorcentaje ? porcentajePuntosBase / 100 : 0;
              if (!usaPorcentaje && decimalACentavos(rangoEdad?.precio) === null) {
                return `El recurso ${recursoId} tiene un precio por persona inválido`;
              }
              if (!usaPorcentaje) rangoEdad.precio = centavosANumero(decimalACentavos(rangoEdad.precio));
            }
          }

          const mapaPreciosLista = construirMapaPreciosDeLista(fecha.tiposPersona);
          for (const tipoPersona of fecha.tiposPersona) {
            if (Number(tipoPersona.tipoPersonaId) === 4) continue;
            for (const rangoEdad of tipoPersona.rangosEdad) {
              if (!rangoEdad.usa_porcentaje) continue;
              const base = buscarPrecioListaPorCobertura(mapaPreciosLista, rangoEdad.edadMinima, rangoEdad.edadMaxima);
              if (!Number.isFinite(base) || decimalACentavos(base) === null) {
                return `Falta un precio de lista que cubra el rango porcentual del recurso ${recursoId}`;
              }
            }
          }
        }
        rangosPorRecursoRegimen.set(claveRecurso, rangosRecurso);
      }
    }
  }

  const porcentajesVistos = new Set();
  for (const porcentaje of Array.isArray(porcentajesTipoPersona) ? porcentajesTipoPersona : []) {
    const tipoPersonaId = normalizarIdPositivo(porcentaje?.tipo_persona_id ?? porcentaje?.tipoPersonaId);
    const valor = porcentaje?.porcentaje ?? porcentaje?.valor ?? porcentaje?.porcentaje_descuento ?? porcentaje?.porcentajeDescuento;
    const puntosBase = decimalAPuntosBase(valor);
    if (!tipoPersonaId || puntosBase === null || puntosBase > 10000 || porcentajesVistos.has(tipoPersonaId)) {
      return "Los porcentajes generales por tipo de persona son inválidos o están repetidos";
    }
    porcentajesVistos.add(tipoPersonaId);
  }

  return null;
}

async function validarReferenciasConfiguracionTemporada(connection, configuracionServicios) {
  const recursosEsperados = new Map();
  const paresServicioRegimen = new Set();
  const tiposPersona = new Set();
  const adicionales = new Set();

  for (const servicio of configuracionServicios) {
    const servicioId = normalizarIdPositivo(servicio.id ?? servicio.servicio_id);
    for (const regimen of servicio.regimenes) {
      const regimenId = normalizarIdPositivo(regimen.id ?? regimen.regimen_id);
      paresServicioRegimen.add(`${servicioId}:${regimenId}`);
      for (const recurso of regimen.recursos) {
        const recursoId = normalizarIdPositivo(recurso.id ?? recurso.recurso_id);
        const servicioAnterior = recursosEsperados.get(recursoId);
        if (servicioAnterior && servicioAnterior !== servicioId) {
          throw crearErrorNegocio(`El recurso ${recursoId} fue asociado a dos servicios distintos`, 400);
        }
        recursosEsperados.set(recursoId, servicioId);
        for (const fecha of recurso.fechas) {
          for (const adicional of Array.isArray(fecha.adicionales) ? fecha.adicionales : []) {
            adicionales.add(normalizarIdPositivo(adicional.adicionalId ?? adicional.adicional_id));
          }
          for (const tipo of Array.isArray(fecha.tiposPersona) ? fecha.tiposPersona : []) {
            tiposPersona.add(normalizarIdPositivo(tipo.tipoPersonaId ?? tipo.tipo_persona_id));
          }
        }
      }
    }
  }

  const recursoIds = Array.from(recursosEsperados.keys());
  const servicioIds = Array.from(new Set(Array.from(recursosEsperados.values())));
  const regimenIds = Array.from(new Set(Array.from(paresServicioRegimen).map((par) => Number(par.split(":")[1]))));
  const placeholders = (valores) => valores.map(() => "?").join(",");

  const [recursos] = await connection.query(
    `SELECT id, servicio_id FROM recurso WHERE id IN (${placeholders(recursoIds)})`,
    recursoIds
  );
  const recursosValidos = new Set(
    recursos
      .filter((recurso) => Number(recursosEsperados.get(Number(recurso.id))) === Number(recurso.servicio_id))
      .map((recurso) => Number(recurso.id))
  );
  if (recursosValidos.size !== recursoIds.length) {
    throw crearErrorNegocio("Hay recursos que no existen o no pertenecen al servicio indicado", 400);
  }

  const [regimenes] = await connection.query(
    `SELECT servicio_id, regimen_id
     FROM servicio_regimen
     WHERE servicio_id IN (${placeholders(servicioIds)})
       AND regimen_id IN (${placeholders(regimenIds)})`,
    [...servicioIds, ...regimenIds]
  );
  const paresValidos = new Set(regimenes.map((fila) => `${Number(fila.servicio_id)}:${Number(fila.regimen_id)}`));
  if (Array.from(paresServicioRegimen).some((par) => !paresValidos.has(par))) {
    throw crearErrorNegocio("Hay regímenes que no pertenecen al servicio indicado", 400);
  }

  if (tiposPersona.size > 0) {
    const ids = Array.from(tiposPersona);
    const [rows] = await connection.query(`SELECT id FROM tipo_persona WHERE id IN (${placeholders(ids)})`, ids);
    if (rows.length !== ids.length) throw crearErrorNegocio("Hay tipos de persona inexistentes", 400);
  }
  if (adicionales.size > 0) {
    const ids = Array.from(adicionales);
    const [rows] = await connection.query(`SELECT id FROM adicional WHERE id IN (${placeholders(ids)})`, ids);
    if (rows.length !== ids.length) throw crearErrorNegocio("Hay adicionales inexistentes", 400);
  }
}

function validarParcelasDisponiblesEnConfiguracion(configuracionServicios) {
  if (!Array.isArray(configuracionServicios)) {
    return null;
  }

  for (let i = 0; i < configuracionServicios.length; i++) {
    const servicio = configuracionServicios[i];
    if (Number(servicio?.id) !== 4 || !Array.isArray(servicio?.regimenes)) {
      continue;
    }

    for (let j = 0; j < servicio.regimenes.length; j++) {
      const regimen = servicio.regimenes[j];
      if (!Array.isArray(regimen?.recursos)) {
        continue;
      }

      for (let k = 0; k < regimen.recursos.length; k++) {
        const recurso = regimen.recursos[k];
        if (!Array.isArray(recurso?.fechas)) {
          continue;
        }

        for (let l = 0; l < recurso.fechas.length; l++) {
          const fecha = recurso.fechas[l];
          const normalizado = normalizarParcelasDisponibles(fecha?.parcelas_disponibles);
          if (normalizado.error) {
            return `Servicio 4: recurso ${recurso?.id || "sin_id"}, rango ${l + 1}: ${normalizado.error}`;
          }
          fecha.parcelas_disponibles = normalizado.value;
        }
      }
    }
  }

  return null;
}

function obtenerParcelasDisponiblesPorFecha(servicioId, fecha) {
  if (Number(servicioId) !== 4) {
    return null;
  }

  const normalizado = normalizarParcelasDisponibles(fecha?.parcelas_disponibles);
  if (normalizado.error) {
    return null;
  }

  return normalizado.value;
}

async function crearTemporadaTarifasDesdeConfiguracion(connection, {
  nombre_campania,
  fecha_inicio,
  fecha_fin,
  configuracion_servicios,
  porcentajes_tipo_persona = [],
  origen = "GENERAL",
  usuario_id = null
}) {
  if (!nombre_campania || !fecha_inicio || !fecha_fin || !Array.isArray(configuracion_servicios)) {
    throw crearErrorNegocio("Faltan campos requeridos para crear tarifas", 400);
  }

  const errorConfiguracion = validarConfiguracionTemporada({
    nombreCampania: nombre_campania,
    fechaInicio: fecha_inicio,
    fechaFin: fecha_fin,
    configuracionServicios: configuracion_servicios,
    porcentajesTipoPersona: porcentajes_tipo_persona,
  });
  if (errorConfiguracion) {
    throw crearErrorNegocio(errorConfiguracion, 400);
  }

  const errorParcelas = validarParcelasDisponiblesEnConfiguracion(configuracion_servicios);
  if (errorParcelas) {
    throw crearErrorNegocio(errorParcelas, 400);
  }

  await validarReferenciasConfiguracionTemporada(connection, configuracion_servicios);

  const [temporadaResult] = await connection.query(
    "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin, origen) VALUES (?, ?, ?, ?)",
    [nombre_campania, fecha_inicio, fecha_fin, origen]
  );

  const temporadaId = temporadaResult.insertId;
  const adicionalesPorTemporada = [];
  const porcentajesRegistrados = [];

  if (usuario_id) {
    await guardarHistorialTemporada(
      connection,
      temporadaId,
      usuario_id,
      "CREATE",
      "temporada",
      null,
      JSON.stringify({ nombre_campania, fecha_inicio, fecha_fin, origen })
    );
  }

  if (Array.isArray(porcentajes_tipo_persona) && porcentajes_tipo_persona.length > 0) {
    for (const porcentaje of porcentajes_tipo_persona) {
      const tipoPersonaId = porcentaje?.tipo_persona_id ?? porcentaje?.tipoPersonaId;
      const porcentajeValor = normalizarValorPorcentaje(
        porcentaje?.porcentaje ??
        porcentaje?.valor ??
        porcentaje?.porcentaje_descuento ??
        porcentaje?.porcentajeDescuento
      );

      if (!tipoPersonaId || porcentajeValor === null) {
        continue;
      }

      await connection.query(
        `INSERT INTO temporada_tipo_persona_porcentaje
          (temporada_tarifa_id, tipo_persona_id, porcentaje)
         VALUES (?, ?, ?)`,
        [temporadaId, tipoPersonaId, porcentajeValor]
      );

      porcentajesRegistrados.push({
        tipo_persona_id: Number(tipoPersonaId),
        porcentaje: porcentajeValor
      });
    }

    if (usuario_id && porcentajesRegistrados.length > 0) {
      await guardarHistorialTemporada(
        connection,
        temporadaId,
        usuario_id,
        "CREATE",
        "porcentajes_tipo_persona",
        null,
        JSON.stringify(porcentajesRegistrados)
      );
    }
  }

  for (const servicio of configuracion_servicios) {
    if (!servicio || !Array.isArray(servicio.regimenes)) {
      continue;
    }

    for (const regimen of servicio.regimenes) {
      if (!regimen || !Array.isArray(regimen.recursos)) {
        continue;
      }

      for (const recurso of regimen.recursos) {
        if (!recurso || !Array.isArray(recurso.fechas)) {
          continue;
        }

        for (const fecha of recurso.fechas) {
          const parcelasDisponibles = obtenerParcelasDisponiblesPorFecha(servicio.id, fecha);

          if (Array.isArray(fecha.adicionales) && fecha.adicionales.length > 0) {
            for (const adicional of fecha.adicionales) {
              if (!adicional || !adicional.adicionalId || adicional.precio === undefined || adicional.precio === null) {
                continue;
              }

              await connection.query(
                `
                  INSERT INTO tarifa_adicional
                    (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                `,
                [
                  temporadaId,
                  recurso.id,
                  regimen.id,
                  adicional.adicionalId,
                  fecha.fecha_inicio,
                  fecha.fecha_fin,
                  adicional.precio
                ]
              );

              adicionalesPorTemporada.push({
                adicional_id: adicional.adicionalId,
                recurso_id: recurso.id,
                regimen_id: regimen.id,
                fecha_inicio: fecha.fecha_inicio,
                fecha_fin: fecha.fecha_fin
              });
            }
          }

          if (recurso.precio_por_persona !== false) {
            const mapaPreciosDeLista = construirMapaPreciosDeLista(fecha.tiposPersona);
            for (const tipoPersona of fecha.tiposPersona || []) {
              const tipoPersonaId = tipoPersona?.tipoPersonaId ?? tipoPersona?.tipo_persona_id;
              if (!tipoPersonaId || !Array.isArray(tipoPersona?.rangosEdad)) {
                continue;
              }

              for (const rangoEdad of tipoPersona.rangosEdad) {
                const { precioTarifa, usaPorcentaje, porcentajeDescuento } = calcularPrecioRangoConPorcentaje(
                  rangoEdad,
                  tipoPersonaId,
                  mapaPreciosDeLista
                );

                const [tarifaResult] = await connection.query(
                  `INSERT INTO tarifa
                   (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                    edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    recurso.id,
                    tipoPersonaId,
                    regimen.id,
                    temporadaId,
                    rangoEdad.edadMinima ?? rangoEdad.edad_minima ?? null,
                    rangoEdad.edadMaxima ?? rangoEdad.edad_maxima ?? null,
                    precioTarifa,
                    fecha.fecha_inicio,
                    fecha.fecha_fin,
                    "Y",
                    usaPorcentaje ? 1 : 0,
                    porcentajeDescuento,
                    parcelasDisponibles
                  ]
                );

                if (usuario_id) {
                  await guardarHistorialTemporada(
                    connection,
                    temporadaId,
                    usuario_id,
                    "CREATE",
                    `tarifa_${tarifaResult.insertId}`,
                    null,
                    JSON.stringify({
                      recurso_id: recurso.id,
                      tipo_persona_id: tipoPersonaId,
                      regimen_id: regimen.id,
                      precio: precioTarifa,
                      usa_porcentaje: usaPorcentaje ? 1 : 0,
                      porcentaje_descuento: porcentajeDescuento,
                      parcelas_disponibles: parcelasDisponibles
                    })
                  );
                }
              }
            }
          } else {
            const [tarifaResult] = await connection.query(
              `INSERT INTO tarifa
               (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                recurso.id,
                null,
                regimen.id,
                temporadaId,
                null,
                null,
                fecha.precio,
                fecha.fecha_inicio,
                fecha.fecha_fin,
                "N",
                0,
                null,
                parcelasDisponibles
              ]
            );

            if (usuario_id) {
              await guardarHistorialTemporada(
                connection,
                temporadaId,
                usuario_id,
                "CREATE",
                `tarifa_${tarifaResult.insertId}`,
                null,
                JSON.stringify({
                  recurso_id: recurso.id,
                  regimen_id: regimen.id,
                  precio: fecha.precio,
                  usa_porcentaje: 0,
                  parcelas_disponibles: parcelasDisponibles
                })
              );
            }
          }
        }
      }
    }
  }

  return {
    temporadaId,
    adicionales: adicionalesPorTemporada,
    porcentajes: porcentajesRegistrados
  };
}

router.post("/temporada", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "admin") {
      const { nombre_campania, fecha_inicio, fecha_fin, configuracion_servicios, porcentajes_tipo_persona } = req.body;

      if (!nombre_campania || !fecha_inicio || !fecha_fin || !configuracion_servicios) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const errorConfiguracion = validarConfiguracionTemporada({
        nombreCampania: nombre_campania,
        fechaInicio: fecha_inicio,
        fechaFin: fecha_fin,
        configuracionServicios: configuracion_servicios,
        porcentajesTipoPersona: porcentajes_tipo_persona,
      });
      if (errorConfiguracion) {
        return res.status(400).json(errorConfiguracion);
      }

      const errorParcelas = validarParcelasDisponiblesEnConfiguracion(configuracion_servicios);
      if (errorParcelas) {
        return res.status(400).json(errorParcelas);
      }

      // Iniciar transacción
      let connection;
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      try {
        await validarReferenciasConfiguracionTemporada(connection, configuracion_servicios);
        await validarSolapamientoTarifasExistentes(connection, {
          configuracionServicios: configuracion_servicios,
          origenes: ["GENERAL", "BLOQUE"]
        });

        // 1. Crear la temporada principal
        const [temporadaResult] = await connection.query(
          "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin) VALUES (?, ?, ?)",
          [nombre_campania, fecha_inicio, fecha_fin]
        );

        const temporadaId = temporadaResult.insertId;
        const adicionalesPorTemporada = [];
        const porcentajesRegistrados = [];

        // Guardar historial de creación
        await guardarHistorialTemporada(
          connection,
          temporadaId,
          cabecera.id,
          'CREATE',
          'temporada',
          null,
          JSON.stringify({ nombre_campania, fecha_inicio, fecha_fin })
        );

        if (Array.isArray(porcentajes_tipo_persona) && porcentajes_tipo_persona.length > 0) {
          for (const porcentaje of porcentajes_tipo_persona) {
            const tipoPersonaId = porcentaje?.tipo_persona_id ?? porcentaje?.tipoPersonaId;
            const porcentajeValor = normalizarValorPorcentaje(
              porcentaje?.porcentaje ??
              porcentaje?.valor ??
              porcentaje?.porcentaje_descuento ??
              porcentaje?.porcentajeDescuento
            );

            if (!tipoPersonaId || porcentajeValor === null) {
              continue;
            }

            await connection.query(
              `INSERT INTO temporada_tipo_persona_porcentaje
                (temporada_tarifa_id, tipo_persona_id, porcentaje)
               VALUES (?, ?, ?)`,
              [temporadaId, tipoPersonaId, porcentajeValor]
            );

            porcentajesRegistrados.push({
              tipo_persona_id: Number(tipoPersonaId),
              porcentaje: porcentajeValor
            });
          }

          if (porcentajesRegistrados.length > 0) {
            await guardarHistorialTemporada(
              connection,
              temporadaId,
              cabecera.id,
              'CREATE',
              'porcentajes_tipo_persona',
              null,
              JSON.stringify(porcentajesRegistrados)
            );
          }
        }

        // 2. Procesar cada servicio
        for (const servicio of configuracion_servicios) {
          // Procesar cada régimen del servicio
          for (const regimen of servicio.regimenes) {
            // Procesar cada recurso del régimen
            for (const recurso of regimen.recursos) {
              // Procesar cada fecha del recurso
              for (const fecha of recurso.fechas) {
                const parcelasDisponibles = obtenerParcelasDisponiblesPorFecha(servicio.id, fecha);

                if (Array.isArray(fecha.adicionales) && fecha.adicionales.length > 0) {
                  for (const adicional of fecha.adicionales) {
                    if (!adicional || !adicional.adicionalId || adicional.precio === undefined || adicional.precio === null) {
                      continue;
                    }

                    await connection.query(
                      `
                        INSERT INTO tarifa_adicional
                          (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                      `,
                      [
                        temporadaId,
                        recurso.id,
                        regimen.id,
                        adicional.adicionalId,
                        fecha.fecha_inicio,
                        fecha.fecha_fin,
                        adicional.precio
                      ]
                    );

                    adicionalesPorTemporada.push({
                      adicional_id: adicional.adicionalId,
                      recurso_id: recurso.id,
                      regimen_id: regimen.id,
                      fecha_inicio: fecha.fecha_inicio,
                      fecha_fin: fecha.fecha_fin
                    });
                  }
                }


                // Verificar si el precio es por persona o por recurso
                if (recurso.precio_por_persona) {
                  const mapaPreciosDeLista = construirMapaPreciosDeLista(fecha.tiposPersona);
                  // Procesar cada tipo de persona de la fecha
                  for (const tipoPersona of fecha.tiposPersona) {
                    const tipoPersonaId = tipoPersona?.tipoPersonaId ?? tipoPersona?.tipo_persona_id;
                    if (!tipoPersonaId || !Array.isArray(tipoPersona?.rangosEdad)) {
                      continue;
                    }

                    // Procesar cada rango de edad del tipo de persona
                    for (const rangoEdad of tipoPersona.rangosEdad) {
                      const { precioTarifa, usaPorcentaje, porcentajeDescuento } = calcularPrecioRangoConPorcentaje(
                        rangoEdad,
                        tipoPersonaId,
                        mapaPreciosDeLista
                      );

                      // Insertar tarifa individual con tipos de persona
                      const [tarifaResult] = await connection.query(
                        `INSERT INTO tarifa
                         (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                          edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                          recurso.id,
                          tipoPersonaId,
                          regimen.id,
                          temporadaId,
                          rangoEdad.edadMinima,
                          rangoEdad.edadMaxima,
                          precioTarifa,
                          fecha.fecha_inicio,
                          fecha.fecha_fin,
                          'Y', // precio_por_persona como 'Y'
                          usaPorcentaje ? 1 : 0,
                          porcentajeDescuento,
                          parcelasDisponibles
                        ]
                      );

                      // Guardar historial de creacion de tarifa
                      await guardarHistorialTemporada(
                        connection,
                        temporadaId,
                        cabecera.id,
                        'CREATE',
                        `tarifa_${tarifaResult.insertId}`,
                        null,
                        JSON.stringify({
                          recurso_id: recurso.id,
                          tipo_persona_id: tipoPersonaId,
                          regimen_id: regimen.id,
                          precio: precioTarifa,
                          usa_porcentaje: usaPorcentaje ? 1 : 0,
                          porcentaje_descuento: porcentajeDescuento,
                          parcelas_disponibles: parcelasDisponibles
                        })
                      );
                    }
                  }
                } else {
                  // Precio por recurso: insertar tarifa sin tipos de persona
                  const [tarifaResult] = await connection.query(
                    `INSERT INTO tarifa
                     (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                      edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      recurso.id,
                      null, // tipo_persona_id como null
                      regimen.id,
                      temporadaId,
                      null, // edad_minima como null
                      null, // edad_maxima como null
                      fecha.precio, // usar el precio del recurso desde FechaTemporada
                      fecha.fecha_inicio,
                      fecha.fecha_fin,
                      'N', // precio_por_persona como 'N'
                      0,
                      null,
                      parcelasDisponibles
                    ]
                  );

                  // Guardar historial de creacion de tarifa
                  await guardarHistorialTemporada(
                    connection,
                    temporadaId,
                    cabecera.id,
                    'CREATE',
                    `tarifa_${tarifaResult.insertId}`,
                    null,
                    JSON.stringify({
                      recurso_id: recurso.id,
                      regimen_id: regimen.id,
                      precio: fecha.precio,
                      usa_porcentaje: 0,
                      parcelas_disponibles: parcelasDisponibles
                    })
                  );
                }

              }
            }
          }
        }

        // Confirmar transacción
        await connection.commit();

        res.status(201).json({
          message: "Temporada creada correctamente",
          temporadaId: temporadaId
        });

      } catch (transactionError) {
        // Rollback en caso de error
        if (connection) {
          await connection.rollback();
        }
        throw transactionError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al crear la temporada");
  }
});

router.get("/temporada/rangos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const excludeTemporadaIdRaw = req.query.exclude_temporada_id;
    let excludeTemporadaId = null;

    if (excludeTemporadaIdRaw !== undefined) {
      const excludeTemporadaIdTexto = String(excludeTemporadaIdRaw).trim();
      if (!/^\d+$/.test(excludeTemporadaIdTexto) || Number(excludeTemporadaIdTexto) <= 0) {
        return res.status(400).json("exclude_temporada_id invalido");
      }
      excludeTemporadaId = Number(excludeTemporadaIdTexto);
    }

    const queryParams = [];
    let query = `
      SELECT
        id,
        nombre AS nombre_campania,
        DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
        DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS fecha_fin
      FROM temporada_tarifa
      WHERE COALESCE(origen, 'GENERAL') = 'GENERAL'
    `;

    if (excludeTemporadaId !== null) {
      query += " AND id <> ?";
      queryParams.push(excludeTemporadaId);
    }

    query += " ORDER BY fecha_inicio ASC, fecha_fin ASC, id ASC";

    const [rows] = await mysqlConnection.promise().query(query, queryParams);
    res.status(200).json(rows);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los rangos de temporada");
  }
});

// GET /temporada/:id - Obtener una temporada con toda su configuración
router.get("/temporada/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "admin") {
      const { id } = req.params;

      let connection;
      connection = await mysqlConnection.promise().getConnection();

      try {
        // 1. Obtener datos de la temporada principal
        const [temporadaRows] = await connection.query(
          "SELECT id, nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = ?",
          [id]
        );

        if (temporadaRows.length === 0) {
          connection.release();
          return res.status(404).json("Temporada no encontrada");
        }

        const temporada = temporadaRows[0];

        // 2. Obtener todas las tarifas de la temporada con información relacionada
        const [tarifasRows] = await connection.query(
          `SELECT
            t.id as tarifa_id,
            t.recurso_id,
            t.tipo_persona_id,
            t.regimen_id,
            t.edad_minima,
            t.edad_maxima,
            t.precio,
            t.fecha_inicio,
            t.fecha_fin,
            t.precio_por_persona,
            t.usa_porcentaje,
            t.porcentaje_descuento,
            t.parcelas_disponibles,
            r.nombre as recurso_nombre,
            r.servicio_id,
            s.nombre as servicio_nombre,
            reg.nombre as regimen_nombre
          FROM tarifa t
          JOIN recurso r ON t.recurso_id = r.id
          JOIN servicio s ON r.servicio_id = s.id
          JOIN regimen reg ON t.regimen_id = reg.id
          WHERE t.temporada_tarifa_id = ?
          ORDER BY s.id, reg.id, r.id, t.fecha_inicio`,
          [id]
        );

        // 3. Estructurar la respuesta según el formato requerido
        const serviciosMap = new Map();
        const recursoRegimenMap = new Map();

        for (const tarifa of tarifasRows) {
          // Crear o obtener servicio
          if (!serviciosMap.has(tarifa.servicio_id)) {
            serviciosMap.set(tarifa.servicio_id, {
              id: tarifa.servicio_id,
              nombre: tarifa.servicio_nombre,
              regimenes: []
            });
          }
          const servicio = serviciosMap.get(tarifa.servicio_id);

          // Buscar o crear régimen en el servicio
          let regimen = servicio.regimenes.find(r => r.id === tarifa.regimen_id);
          if (!regimen) {
            regimen = {
              id: tarifa.regimen_id,
              nombre: tarifa.regimen_nombre,
              recursos: []
            };
            servicio.regimenes.push(regimen);
          }

          // Buscar o crear recurso en el régimen
          let recurso = regimen.recursos.find(r => r.id === tarifa.recurso_id);
          if (!recurso) {
            recurso = {
              id: tarifa.recurso_id,
              recurso: tarifa.recurso_nombre,
              id_servicio: tarifa.servicio_id,
              id_regimen: tarifa.regimen_id,
              precio_por_persona: tarifa.precio_por_persona === 'Y',
              fechas: []
            };
            regimen.recursos.push(recurso);
          }

          const recursoKey = `${tarifa.regimen_id}-${tarifa.recurso_id}`;
          recursoRegimenMap.set(recursoKey, recurso);

          const tarifaFechaInicio = formatearFechaSQL(tarifa.fecha_inicio);
          const tarifaFechaFin = formatearFechaSQL(tarifa.fecha_fin);
          if (!tarifaFechaInicio || !tarifaFechaFin || tarifaFechaInicio > tarifaFechaFin) {
            throw crearErrorNegocio("La temporada contiene un rango de tarifa invalido", 409, "TARIFA_INVALIDA");
          }

          // Buscar o crear fecha en el recurso
          let fecha = recurso.fechas.find(f => {
            return formatearFechaSQL(f.fecha_inicio) === tarifaFechaInicio &&
              formatearFechaSQL(f.fecha_fin) === tarifaFechaFin;
          });
          const esServicioParcelas = Number(tarifa.servicio_id) === 4;
          const parcelasDisponibles = tarifa.parcelas_disponibles !== null && tarifa.parcelas_disponibles !== undefined
            ? Number(tarifa.parcelas_disponibles)
            : 100;
          if (!fecha) {
            fecha = {
              id: tarifa.tarifa_id,
              fecha_inicio: tarifa.fecha_inicio,
              fecha_fin: tarifa.fecha_fin,
              precio: tarifa.precio_por_persona === 'N' ? tarifa.precio : null,
              tiposPersona: [],
              adicionales: [] // Los adicionales se pueden agregar después si es necesario
            };
            if (esServicioParcelas) {
              fecha.parcelas_disponibles = parcelasDisponibles;
            }
            recurso.fechas.push(fecha);
          } else if (esServicioParcelas && (fecha.parcelas_disponibles === undefined || fecha.parcelas_disponibles === null)) {
            fecha.parcelas_disponibles = parcelasDisponibles;
          }

          // Si es precio por persona, agregar tipo de persona y rango de edad
          if (tarifa.precio_por_persona === 'Y' && tarifa.tipo_persona_id) {
            let tipoPersona = fecha.tiposPersona.find(
              tp => tp.tipoPersonaId === tarifa.tipo_persona_id
            );
            if (!tipoPersona) {
              tipoPersona = {
                id: tarifa.tarifa_id,
                tipoPersonaId: tarifa.tipo_persona_id,
                rangosEdad: []
              };
              fecha.tiposPersona.push(tipoPersona);
            }

            const usaPorcentaje = tarifa.usa_porcentaje === 1 || tarifa.usa_porcentaje === '1';
            const porcentajeDescuento = tarifa.porcentaje_descuento !== null && tarifa.porcentaje_descuento !== undefined
              ? Number(tarifa.porcentaje_descuento)
              : null;

            tipoPersona.rangosEdad.push({
              id: tarifa.tarifa_id,
              edadMinima: tarifa.edad_minima,
              edadMaxima: tarifa.edad_maxima,
              precio: tarifa.precio,
              usa_porcentaje: usaPorcentaje,
              porcentaje_descuento: porcentajeDescuento
            });
          }
        }

        const [adicionalRows] = await connection.query(
          `
            SELECT recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio
            FROM tarifa_adicional
            WHERE temporada_tarifa_id = ? AND activo = 1
          `,
          [id]
        );

        for (const adicional of adicionalRows) {
          const recursoKey = `${adicional.regimen_id}-${adicional.recurso_id}`;
          const recurso = recursoRegimenMap.get(recursoKey);
          if (!recurso) {
            continue;
          }

          const adicionalFechaInicio = formatearFechaSQL(adicional.fecha_inicio);
          const adicionalFechaFin = formatearFechaSQL(adicional.fecha_fin);
          if (!adicionalFechaInicio || !adicionalFechaFin || adicionalFechaInicio > adicionalFechaFin) {
            throw crearErrorNegocio("La temporada contiene un rango de adicional invalido", 409, "TARIFA_ADICIONAL_INVALIDA");
          }

          const fecha = recurso.fechas.find(f => {
            return formatearFechaSQL(f.fecha_inicio) === adicionalFechaInicio &&
              formatearFechaSQL(f.fecha_fin) === adicionalFechaFin;
          });

          if (!fecha) {
            continue;
          }

          if (!Array.isArray(fecha.adicionales)) {
            fecha.adicionales = [];
          }

          fecha.adicionales.push({
            adicionalId: adicional.adicional_id,
            precio: Number(adicional.precio)
          });
        }

        const [porcentajesTipoPersonaRows] = await connection.query(
          `
            SELECT tipo_persona_id, porcentaje
            FROM temporada_tipo_persona_porcentaje
            WHERE temporada_tarifa_id = ?
          `,
          [id]
        );

        const porcentajesTipoPersona = porcentajesTipoPersonaRows.map(row => {
          const porcentajeValor = row.porcentaje !== null && row.porcentaje !== undefined
            ? Number(row.porcentaje)
            : null;
          return {
            tipo_persona_id: row.tipo_persona_id,
            porcentaje: porcentajeValor
          };
        });

        // 4. Construir respuesta final
        const response = {
          nombre_campania: temporada.nombre,
          fecha_inicio: temporada.fecha_inicio,
          fecha_fin: temporada.fecha_fin,
          configuracion_servicios: Array.from(serviciosMap.values()),
          porcentajes_tipo_persona: porcentajesTipoPersona
        };

        connection.release();
        res.status(200).json(response);

      } catch (queryError) {
        if (connection) {
          connection.release();
        }
        throw queryError;
      }

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la temporada");
  }
});

// PUT /temporada/:id - Actualizar una temporada
router.put("/temporada/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "admin") {
      const { id } = req.params;
      const { nombre_campania, fecha_inicio, fecha_fin, configuracion_servicios, porcentajes_tipo_persona } = req.body;

      if (!nombre_campania || !fecha_inicio || !fecha_fin || !configuracion_servicios) {
        return res.status(400).json("Faltan campos requeridos");
      }


      const errorConfiguracion = validarConfiguracionTemporada({
        nombreCampania: nombre_campania,
        fechaInicio: fecha_inicio,
        fechaFin: fecha_fin,
        configuracionServicios: configuracion_servicios,
        porcentajesTipoPersona: porcentajes_tipo_persona,
      });
      if (errorConfiguracion) {
        return res.status(400).json(errorConfiguracion);
      }

      const errorParcelas = validarParcelasDisponiblesEnConfiguracion(configuracion_servicios);
      if (errorParcelas) {
        return res.status(400).json(errorParcelas);
      }

      let connection;
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      try {
        await validarReferenciasConfiguracionTemporada(connection, configuracion_servicios);
        // 1. Verificar que la temporada existe y obtener datos anteriores
        const [temporadaAnterior] = await connection.query(
          "SELECT nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = ? FOR UPDATE",
          [id]
        );

        if (temporadaAnterior.length === 0) {
          throw crearErrorNegocio("Temporada no encontrada", 404);
        }

        const datosAnteriores = temporadaAnterior[0];

        await validarSolapamientoTarifasExistentes(connection, {
          configuracionServicios: configuracion_servicios,
          excludeTemporadaTarifaId: normalizarIdPositivo(id),
          origenes: ["GENERAL", "BLOQUE"]
        });

        // 2. Actualizar la temporada principal
        await connection.query(
          "UPDATE temporada_tarifa SET nombre = ?, fecha_inicio = ?, fecha_fin = ? WHERE id = ?",
          [nombre_campania, fecha_inicio, fecha_fin, id]
        );

        const adicionalesPorTemporada = [];

        // Guardar historial de actualización de temporada
        if (datosAnteriores.nombre !== nombre_campania ||
            datosAnteriores.fecha_inicio !== fecha_inicio ||
            datosAnteriores.fecha_fin !== fecha_fin) {
          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'UPDATE',
            'temporada',
            JSON.stringify(datosAnteriores),
            JSON.stringify({ nombre_campania, fecha_inicio, fecha_fin })
          );
        }

        // 3. Eliminar todas las tarifas existentes de esta temporada
        const [tarifasAnteriores] = await connection.query(
          "SELECT id FROM tarifa WHERE temporada_tarifa_id = ?",
          [id]
        );

        if (tarifasAnteriores.length > 0) {
          const [referenciasTarifas] = await connection.query(
            `SELECT COUNT(*) AS cantidad
             FROM reserva_familiar_tarifa rft
             INNER JOIN tarifa t ON t.id = rft.tarifa_id
             WHERE t.temporada_tarifa_id = ?`,
            [id]
          );
          if (Number(referenciasTarifas[0]?.cantidad || 0) > 0) {
            throw crearErrorNegocio(
              "La temporada ya fue utilizada por reservas y no puede reemplazar sus tarifas históricas; crea una nueva temporada",
              409,
              "TEMPORADA_CON_HISTORIAL"
            );
          }
          await connection.query(
            "DELETE FROM tarifa WHERE temporada_tarifa_id = ?",
            [id]
          );

          // Guardar historial de eliminación
          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'DELETE',
            'tarifas',
            JSON.stringify({ cantidad: tarifasAnteriores.length }),
            null
          );
        }

        // Soft delete: marcar como inactivas las tarifas adicionales existentes
        // en lugar de eliminarlas (para preservar referencias de reservas existentes)
        const [adicionalesAnteriores] = await connection.query(
          "SELECT id FROM tarifa_adicional WHERE temporada_tarifa_id = ? AND activo = 1",
          [id]
        );

        if (adicionalesAnteriores.length > 0) {
          await connection.query(
            "UPDATE tarifa_adicional SET activo = 0 WHERE temporada_tarifa_id = ?",
            [id]
          );

          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'UPDATE',
            'tarifa_adicional',
            JSON.stringify({ cantidad: adicionalesAnteriores.length, accion: 'desactivar' }),
            null
          );
        }

        const [porcentajesAnteriores] = await connection.query(
          "SELECT tipo_persona_id, porcentaje FROM temporada_tipo_persona_porcentaje WHERE temporada_tarifa_id = ?",
          [id]
        );

        if (porcentajesAnteriores.length > 0) {
          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'DELETE',
            'porcentajes_tipo_persona',
            JSON.stringify(porcentajesAnteriores),
            null
          );
        }

        await connection.query(
          "DELETE FROM temporada_tipo_persona_porcentaje WHERE temporada_tarifa_id = ?",
          [id]
        );

        const porcentajesRegistrados = [];
        if (Array.isArray(porcentajes_tipo_persona) && porcentajes_tipo_persona.length > 0) {
          for (const porcentaje of porcentajes_tipo_persona) {
            const tipoPersonaId = porcentaje?.tipo_persona_id ?? porcentaje?.tipoPersonaId;
            const porcentajeValor = normalizarValorPorcentaje(
              porcentaje?.porcentaje ??
              porcentaje?.valor ??
              porcentaje?.porcentaje_descuento ??
              porcentaje?.porcentajeDescuento
            );

            if (!tipoPersonaId || porcentajeValor === null) {
              continue;
            }

            await connection.query(
              `INSERT INTO temporada_tipo_persona_porcentaje
                (temporada_tarifa_id, tipo_persona_id, porcentaje)
               VALUES (?, ?, ?)`,
              [id, tipoPersonaId, porcentajeValor]
            );

            porcentajesRegistrados.push({
              tipo_persona_id: Number(tipoPersonaId),
              porcentaje: porcentajeValor
            });
          }
        }

        if (porcentajesRegistrados.length > 0) {
          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'CREATE',
            'porcentajes_tipo_persona',
            null,
            JSON.stringify(porcentajesRegistrados)
          );
        }

        // 4. Insertar las nuevas tarifas (mismo código que POST)
        for (const servicio of configuracion_servicios) {
          for (const regimen of servicio.regimenes) {
              for (const recurso of regimen.recursos) {
                for (const fecha of recurso.fechas) {
                  const parcelasDisponibles = obtenerParcelasDisponiblesPorFecha(servicio.id, fecha);

                  if (Array.isArray(fecha.adicionales) && fecha.adicionales.length > 0) {
                    for (const adicional of fecha.adicionales) {
                      if (!adicional || !adicional.adicionalId || adicional.precio === undefined || adicional.precio === null) {
                        continue;
                      }

                      await connection.query(
                        `
                          INSERT INTO tarifa_adicional
                            (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio, activo)
                          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                          ON DUPLICATE KEY UPDATE precio = VALUES(precio), activo = 1
                        `,
                        [
                          id,
                          recurso.id,
                          regimen.id,
                          adicional.adicionalId,
                          fecha.fecha_inicio,
                          fecha.fecha_fin,
                          adicional.precio
                        ]
                      );

                      adicionalesPorTemporada.push({
                        adicional_id: adicional.adicionalId,
                        recurso_id: recurso.id,
                        regimen_id: regimen.id,
                        fecha_inicio: fecha.fecha_inicio,
                        fecha_fin: fecha.fecha_fin
                      });
                    }
                  }


                  if (recurso.precio_por_persona) {
                    const mapaPreciosDeLista = construirMapaPreciosDeLista(fecha.tiposPersona);
                    for (const tipoPersona of fecha.tiposPersona) {
                      const tipoPersonaId = tipoPersona?.tipoPersonaId ?? tipoPersona?.tipo_persona_id;
                      if (!tipoPersonaId || !Array.isArray(tipoPersona?.rangosEdad)) {
                        continue;
                      }

                      for (const rangoEdad of tipoPersona.rangosEdad) {
                        const { precioTarifa, usaPorcentaje, porcentajeDescuento } = calcularPrecioRangoConPorcentaje(
                          rangoEdad,
                          tipoPersonaId,
                          mapaPreciosDeLista
                        );

                        const [tarifaResult] = await connection.query(
                          `INSERT INTO tarifa
                           (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                            edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                          [
                            recurso.id,
                            tipoPersonaId,
                            regimen.id,
                            id,
                            rangoEdad.edadMinima,
                            rangoEdad.edadMaxima,
                            precioTarifa,
                            fecha.fecha_inicio,
                            fecha.fecha_fin,
                            'Y',
                            usaPorcentaje ? 1 : 0,
                            porcentajeDescuento,
                            parcelasDisponibles
                          ]
                        );

                        // Guardar historial de creacion de nueva tarifa
                        await guardarHistorialTemporada(
                          connection,
                          id,
                          cabecera.id,
                          'CREATE',
                          `tarifa_${tarifaResult.insertId}`,
                          null,
                          JSON.stringify({
                            recurso_id: recurso.id,
                            tipo_persona_id: tipoPersonaId,
                            regimen_id: regimen.id,
                            precio: precioTarifa,
                            usa_porcentaje: usaPorcentaje ? 1 : 0,
                            porcentaje_descuento: porcentajeDescuento,
                            parcelas_disponibles: parcelasDisponibles
                          })
                        );
                      }
                    }
                  } else {
                    const [tarifaResult] = await connection.query(
                      `INSERT INTO tarifa
                       (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                        edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                      [
                        recurso.id,
                        null,
                        regimen.id,
                        id,
                        null,
                        null,
                        fecha.precio,
                        fecha.fecha_inicio,
                        fecha.fecha_fin,
                        'N',
                        0,
                        null,
                        parcelasDisponibles
                      ]
                    );

                    // Guardar historial de creacion de nueva tarifa
                    await guardarHistorialTemporada(
                      connection,
                      id,
                      cabecera.id,
                      'CREATE',
                      `tarifa_${tarifaResult.insertId}`,
                      null,
                      JSON.stringify({
                        recurso_id: recurso.id,
                        regimen_id: regimen.id,
                        precio: fecha.precio,
                        usa_porcentaje: 0,
                        parcelas_disponibles: parcelasDisponibles
                      })
                    );
                  }

              }
            }
          }
        }

        if (adicionalesPorTemporada.length > 0) {
          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'CREATE',
            'tarifa_adicional',
            null,
            JSON.stringify({ registros: adicionalesPorTemporada.length })
          );
        }

        // 5. Confirmar transacción
        await connection.commit();

        res.status(200).json({
          message: "Temporada actualizada correctamente",
          temporadaId: id
        });

      } catch (transactionError) {
        if (connection) {
          await connection.rollback();
        }
        throw transactionError;
      } finally {
        if (connection) {
          connection.release();
        }
      }

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message, codigo: error.codigo || null });
    }
    res.status(500).json("Error al actualizar la temporada");
  }
});

const MODOS_SALTO_FLUJO_VALIDOS = new Set(["POR_RANGO", "POR_ANIO"]);
const SENTIDOS_CALCULO_FLUJO_VALIDOS = new Set(["ASCENDENTE", "DESCENDENTE"]);
const TIPOS_VALORES_PREDETERMINADOS_TEMPORADA = new Set(["BAJA", "ALTA"]);

function normalizarTipoValoresPredeterminados(valor) {
  const tipo = String(valor || "").trim().toUpperCase();
  if (!TIPOS_VALORES_PREDETERMINADOS_TEMPORADA.has(tipo)) {
    return { error: "tipo debe ser BAJA o ALTA" };
  }
  return { value: tipo };
}

function parsearEnteroNoNegativoFlujo(valor, nombreCampo, opciones = {}) {
  const permiteNull = Boolean(opciones.permiteNull);
  if (valor === undefined || valor === null || valor === "") {
    if (permiteNull) {
      return { value: null };
    }
    return { error: `${nombreCampo} es requerido` };
  }

  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < 0) {
    return { error: `${nombreCampo} debe ser un entero mayor o igual a 0` };
  }

  return { value: numero };
}

function parsearDecimalPositivoFlujo(valor, nombreCampo) {
  if (valor === undefined || valor === null || valor === "") {
    return { error: `${nombreCampo} es requerido` };
  }

  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    return { error: `${nombreCampo} debe ser un numero decimal mayor a 0` };
  }

  return { value: numero };
}

function parsearBooleanFlujo(valor, nombreCampo) {
  if (typeof valor === "boolean") {
    return { value: valor };
  }

  if (typeof valor === "number" && (valor === 0 || valor === 1)) {
    return { value: valor === 1 };
  }

  if (typeof valor === "string") {
    const normalizado = valor.trim().toLowerCase();
    if (["true", "1", "y", "yes", "si", "s"].includes(normalizado)) {
      return { value: true };
    }
    if (["false", "0", "n", "no"].includes(normalizado)) {
      return { value: false };
    }
  }

  return { error: `${nombreCampo} debe ser booleano` };
}

function validarYNormalizarFlujoDescuentoEscalonado(body) {
  const reglas = body?.reglas;
  if (!Array.isArray(reglas) || reglas.length === 0) {
    return { error: "Debe enviar al menos 1 regla" };
  }

  const reglasNormalizadas = [];

  for (let i = 0; i < reglas.length; i++) {
    const regla = reglas[i] || {};
    const prefijoRegla = `reglas[${i}]`;

    const servicioIdResultado = parsearEnteroNoNegativoFlujo(
      regla.servicio_id ?? regla.servicioId,
      `${prefijoRegla}.servicio_id`
    );
    if (servicioIdResultado.error) {
      return servicioIdResultado;
    }

    const recursoIdResultado = parsearEnteroNoNegativoFlujo(
      regla.recurso_id ?? regla.recursoId,
      `${prefijoRegla}.recurso_id`
    );
    if (recursoIdResultado.error) {
      return recursoIdResultado;
    }

    const tipoPersonaIdResultado = parsearEnteroNoNegativoFlujo(
      regla.tipo_persona_id ?? regla.tipoPersonaId,
      `${prefijoRegla}.tipo_persona_id`
    );
    if (tipoPersonaIdResultado.error) {
      return tipoPersonaIdResultado;
    }

    const saltoResultado = parsearDecimalPositivoFlujo(
      regla.salto_porcentaje ?? regla.saltoPorcentaje,
      `${prefijoRegla}.salto_porcentaje`
    );
    if (saltoResultado.error) {
      return saltoResultado;
    }

    const modoSalto = String(regla.modo_salto ?? regla.modoSalto ?? "")
      .trim()
      .toUpperCase();
    if (!MODOS_SALTO_FLUJO_VALIDOS.has(modoSalto)) {
      return {
        error: `${prefijoRegla}.modo_salto debe ser POR_RANGO o POR_ANIO`,
      };
    }

    const sentidoCalculo = String(
      regla.sentido_calculo ?? regla.sentidoCalculo ?? ""
    )
      .trim()
      .toUpperCase();
    if (!SENTIDOS_CALCULO_FLUJO_VALIDOS.has(sentidoCalculo)) {
      return {
        error: `${prefijoRegla}.sentido_calculo debe ser ASCENDENTE o DESCENDENTE`,
      };
    }

    const rangoBaseOrdenResultado = parsearEnteroNoNegativoFlujo(
      regla.rango_base_orden ?? regla.rangoBaseOrden,
      `${prefijoRegla}.rango_base_orden`
    );
    if (rangoBaseOrdenResultado.error) {
      return rangoBaseOrdenResultado;
    }
    const rangoBaseOrden = rangoBaseOrdenResultado.value;

    const usarTopeResultado = parsearBooleanFlujo(
      regla.usar_tope ?? regla.usarTope,
      `${prefijoRegla}.usar_tope`
    );
    if (usarTopeResultado.error) {
      return usarTopeResultado;
    }
    const usarTope = usarTopeResultado.value;

    const rangosEdad = regla.rangos_edad ?? regla.rangosEdad;
    if (!Array.isArray(rangosEdad) || rangosEdad.length === 0) {
      return { error: `${prefijoRegla} debe tener al menos 1 rango de edad` };
    }

    const rangosNormalizados = [];
    const ordenesUsados = new Set();

    for (let j = 0; j < rangosEdad.length; j++) {
      const rango = rangosEdad[j] || {};
      const prefijoRango = `${prefijoRegla}.rangos_edad[${j}]`;

      const ordenResultado = parsearEnteroNoNegativoFlujo(
        rango.orden,
        `${prefijoRango}.orden`
      );
      if (ordenResultado.error) {
        return ordenResultado;
      }
      const orden = ordenResultado.value;

      if (ordenesUsados.has(orden)) {
        return { error: `${prefijoRegla}.rangos_edad contiene ordenes duplicados` };
      }
      ordenesUsados.add(orden);

      const edadMinimaResultado = parsearEnteroNoNegativoFlujo(
        rango.edad_minima ?? rango.edadMinima,
        `${prefijoRango}.edad_minima`
      );
      if (edadMinimaResultado.error) {
        return edadMinimaResultado;
      }
      const edadMinima = edadMinimaResultado.value;

      const edadMaximaRaw = rango.edad_maxima ?? rango.edadMaxima;
      let edadMaxima = null;
      if (
        edadMaximaRaw !== undefined &&
        edadMaximaRaw !== null &&
        edadMaximaRaw !== ""
      ) {
        const edadMaximaResultado = parsearEnteroNoNegativoFlujo(
          edadMaximaRaw,
          `${prefijoRango}.edad_maxima`
        );
        if (edadMaximaResultado.error) {
          return edadMaximaResultado;
        }
        edadMaxima = edadMaximaResultado.value;

        if (edadMaxima <= edadMinima) {
          return {
            error: `${prefijoRango}.edad_maxima debe ser mayor que edad_minima`,
          };
        }
      }

      rangosNormalizados.push({
        orden,
        edad_minima: edadMinima,
        edad_maxima: edadMaxima,
      });
    }

    rangosNormalizados.sort((a, b) => a.orden - b.orden);

    for (let ordenEsperado = 0; ordenEsperado < rangosNormalizados.length; ordenEsperado++) {
      if (rangosNormalizados[ordenEsperado].orden !== ordenEsperado) {
        return {
          error: `${prefijoRegla}.rangos_edad debe ser secuencial desde 0`,
        };
      }
    }

    for (let j = 0; j < rangosNormalizados.length; j++) {
      const actual = rangosNormalizados[j];

      if (actual.edad_maxima === null && j !== rangosNormalizados.length - 1) {
        return {
          error: `${prefijoRegla}.solo el ultimo rango puede tener edad_maxima null`,
        };
      }

      if (j === 0) {
        continue;
      }

      const anterior = rangosNormalizados[j - 1];
      if (
        anterior.edad_maxima !== null &&
        actual.edad_minima <= anterior.edad_maxima
      ) {
        return { error: `${prefijoRegla}.rangos_edad tiene solapamientos` };
      }
    }

    const ordenesValidos = new Set(rangosNormalizados.map(rango => rango.orden));
    if (!ordenesValidos.has(rangoBaseOrden)) {
      return {
        error: `${prefijoRegla}.rango_base_orden debe existir en rangos_edad`,
      };
    }

    const rangoTopeRaw = regla.rango_tope_orden ?? regla.rangoTopeOrden;
    let rangoTopeOrden = null;

    if (usarTope) {
      const rangoTopeResultado = parsearEnteroNoNegativoFlujo(
        rangoTopeRaw,
        `${prefijoRegla}.rango_tope_orden`
      );
      if (rangoTopeResultado.error) {
        return rangoTopeResultado;
      }
      rangoTopeOrden = rangoTopeResultado.value;

      if (!ordenesValidos.has(rangoTopeOrden)) {
        return {
          error: `${prefijoRegla}.rango_tope_orden debe existir en rangos_edad`,
        };
      }
    } else if (
      rangoTopeRaw !== undefined &&
      rangoTopeRaw !== null &&
      rangoTopeRaw !== ""
    ) {
      return {
        error: `${prefijoRegla}.rango_tope_orden debe ser null cuando usar_tope es false`,
      };
    }

    reglasNormalizadas.push({
      servicio_id: servicioIdResultado.value,
      recurso_id: recursoIdResultado.value,
      tipo_persona_id: tipoPersonaIdResultado.value,
      salto_porcentaje: saltoResultado.value,
      modo_salto: modoSalto,
      sentido_calculo: sentidoCalculo,
      rango_base_orden: rangoBaseOrden,
      usar_tope: usarTope,
      rango_tope_orden: rangoTopeOrden,
      rangos_edad: rangosNormalizados,
    });
  }

  return { reglas: reglasNormalizadas };
}

function validarYNormalizarPorcentajesPredeterminados(body) {
  const porcentajesRaw = body?.porcentajes_tipo_persona ?? body?.porcentajesTipoPersona ?? [];
  if (!Array.isArray(porcentajesRaw)) {
    return { error: "porcentajes_tipo_persona debe ser un arreglo" };
  }

  const porcentajes = [];
  const tiposUsados = new Set();

  for (let i = 0; i < porcentajesRaw.length; i++) {
    const item = porcentajesRaw[i] || {};
    const tipoPersonaId = Number(item.tipo_persona_id ?? item.tipoPersonaId);
    const porcentaje = normalizarValorPorcentaje(
      item.porcentaje ??
      item.valor ??
      item.porcentaje_descuento ??
      item.porcentajeDescuento
    );

    if (!Number.isInteger(tipoPersonaId) || tipoPersonaId <= 0) {
      return { error: `porcentajes_tipo_persona[${i}].tipo_persona_id debe ser un entero positivo` };
    }

    if (Number(tipoPersonaId) === 4 || Number(tipoPersonaId) === 5) {
      continue;
    }

    if (porcentaje === null || porcentaje < 0 || porcentaje > 100) {
      return { error: `porcentajes_tipo_persona[${i}].porcentaje debe estar entre 0 y 100` };
    }

    if (tiposUsados.has(tipoPersonaId)) {
      return { error: `porcentajes_tipo_persona tiene tipo_persona_id duplicado: ${tipoPersonaId}` };
    }

    tiposUsados.add(tipoPersonaId);
    porcentajes.push({
      tipo_persona_id: tipoPersonaId,
      porcentaje,
    });
  }

  return { porcentajes };
}

function validarYNormalizarValoresPredeterminadosTemporada(body) {
  const flujo = validarYNormalizarFlujoDescuentoEscalonado(body);
  if (flujo.error) {
    return flujo;
  }

  const porcentajes = validarYNormalizarPorcentajesPredeterminados(body);
  if (porcentajes.error) {
    return porcentajes;
  }

  return {
    reglas: flujo.reglas,
    porcentajes: porcentajes.porcentajes,
  };
}

async function insertarReglasFlujoDescuentoEscalonado(connection, flujoId, reglas) {
  for (const regla of reglas) {
    const [reglaResult] = await connection.query(
      `INSERT INTO flujo_descuento_escalonado_regla
        (flujo_id, servicio_id, recurso_id, tipo_persona_id, salto_porcentaje, modo_salto, sentido_calculo, rango_base_orden, usar_tope, rango_tope_orden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flujoId,
        regla.servicio_id,
        regla.recurso_id,
        regla.tipo_persona_id,
        regla.salto_porcentaje,
        regla.modo_salto,
        regla.sentido_calculo,
        regla.rango_base_orden,
        regla.usar_tope ? 1 : 0,
        regla.rango_tope_orden,
      ]
    );

    for (const rango of regla.rangos_edad) {
      await connection.query(
        `INSERT INTO flujo_descuento_escalonado_rango_edad
          (regla_id, orden, edad_minima, edad_maxima)
         VALUES (?, ?, ?, ?)`,
        [reglaResult.insertId, rango.orden, rango.edad_minima, rango.edad_maxima]
      );
    }
  }
}

async function insertarPorcentajesPredeterminadosTemporada(connection, flujoId, porcentajes) {
  if (!Array.isArray(porcentajes) || porcentajes.length === 0) {
    return;
  }

  for (const porcentaje of porcentajes) {
    await connection.query(
      `INSERT INTO flujo_descuento_escalonado_tipo_persona_porcentaje
        (flujo_id, tipo_persona_id, porcentaje)
       VALUES (?, ?, ?)`,
      [flujoId, porcentaje.tipo_persona_id, porcentaje.porcentaje]
    );
  }
}

async function obtenerFlujoDescuentoEscalonado(connection, flujoId = null, tipoTemporada = "BAJA") {
  const params = [];
  let flujoQuery = `
    SELECT id, tipo_temporada, created_at, updated_at
    FROM flujo_descuento_escalonado
  `;

  if (flujoId !== null) {
    flujoQuery += " WHERE id = ?";
    params.push(flujoId);
  } else {
    flujoQuery += " WHERE tipo_temporada = ?";
    params.push(tipoTemporada);
  }

  flujoQuery += " ORDER BY id ASC LIMIT 1";

  const [flujoRows] = await connection.query(flujoQuery, params);
  if (flujoRows.length === 0) {
    return null;
  }

  const flujo = flujoRows[0];
  const [reglasRows] = await connection.query(
    `SELECT
      id,
      flujo_id,
      servicio_id,
      recurso_id,
      tipo_persona_id,
      salto_porcentaje,
      modo_salto,
      sentido_calculo,
      rango_base_orden,
      usar_tope,
      rango_tope_orden
    FROM flujo_descuento_escalonado_regla
    WHERE flujo_id = ?
    ORDER BY id ASC`,
    [flujo.id]
  );

  let rangosRows = [];
  if (reglasRows.length > 0) {
    const reglasIds = reglasRows.map(regla => regla.id);
    const [rangosResult] = await connection.query(
      `SELECT id, regla_id, orden, edad_minima, edad_maxima
       FROM flujo_descuento_escalonado_rango_edad
       WHERE regla_id IN (?)
       ORDER BY regla_id ASC, orden ASC`,
      [reglasIds]
    );
    rangosRows = rangosResult;
  }

  const rangosPorRegla = new Map();
  for (const rango of rangosRows) {
    if (!rangosPorRegla.has(rango.regla_id)) {
      rangosPorRegla.set(rango.regla_id, []);
    }
    rangosPorRegla.get(rango.regla_id).push({
      id: rango.id,
      orden: rango.orden,
      edad_minima: rango.edad_minima,
      edad_maxima: rango.edad_maxima,
    });
  }

  const [porcentajesRows] = await connection.query(
    `SELECT tipo_persona_id, porcentaje
     FROM flujo_descuento_escalonado_tipo_persona_porcentaje
     WHERE flujo_id = ?
     ORDER BY tipo_persona_id ASC`,
    [flujo.id]
  );

  return {
    id: flujo.id,
    tipo: flujo.tipo_temporada || tipoTemporada,
    tipo_temporada: flujo.tipo_temporada || tipoTemporada,
    porcentajes_tipo_persona: porcentajesRows.map(row => ({
      tipo_persona_id: row.tipo_persona_id,
      porcentaje: row.porcentaje !== null && row.porcentaje !== undefined ? Number(row.porcentaje) : null,
    })),
    reglas: reglasRows.map(regla => ({
      id: regla.id,
      servicio_id: regla.servicio_id,
      recurso_id: regla.recurso_id,
      tipo_persona_id: regla.tipo_persona_id,
      salto_porcentaje:
        regla.salto_porcentaje !== null ? Number(regla.salto_porcentaje) : null,
      modo_salto: regla.modo_salto,
      sentido_calculo: regla.sentido_calculo,
      rango_base_orden: regla.rango_base_orden,
      usar_tope: regla.usar_tope === 1 || regla.usar_tope === true,
      rango_tope_orden: regla.rango_tope_orden,
      rangos_edad: rangosPorRegla.get(regla.id) || [],
    })),
    created_at: flujo.created_at,
    updated_at: flujo.updated_at,
  };
}

router.get("/flujo-descuento-escalonado", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const connection = await mysqlConnection.promise().getConnection();
    try {
      const flujo = await obtenerFlujoDescuentoEscalonado(connection);
      // console.log(flujo);
      // if (!flujo) {
      //   return res.status(404).json("Flujo no encontrado");
      // }
      res.status(200).json(flujo);
    } finally {
      connection.release();
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el flujo de descuento escalonado");
  }
});

router.get("/valores-predeterminados-temporada/:tipo", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const tipoResultado = normalizarTipoValoresPredeterminados(req.params.tipo);
    if (tipoResultado.error) {
      return res.status(400).json(tipoResultado.error);
    }

    const connection = await mysqlConnection.promise().getConnection();
    try {
      const valores = await obtenerFlujoDescuentoEscalonado(connection, null, tipoResultado.value);
      res.status(200).json(valores);
    } finally {
      connection.release();
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener valores predeterminados de temporada");
  }
});

router.put("/valores-predeterminados-temporada/:tipo", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const tipoResultado = normalizarTipoValoresPredeterminados(req.params.tipo);
    if (tipoResultado.error) {
      return res.status(400).json(tipoResultado.error);
    }

    const validacion = validarYNormalizarValoresPredeterminadosTemporada(req.body);
    if (validacion.error) {
      return res.status(400).json(validacion.error);
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [flujoRows] = await connection.query(
      "SELECT id FROM flujo_descuento_escalonado WHERE tipo_temporada = ? FOR UPDATE",
      [tipoResultado.value]
    );

    let flujoId;
    if (flujoRows.length === 0) {
      const [flujoResult] = await connection.query(
        "INSERT INTO flujo_descuento_escalonado (tipo_temporada, created_at, updated_at) VALUES (?, NOW(), NOW())",
        [tipoResultado.value]
      );
      flujoId = flujoResult.insertId;
    } else {
      flujoId = flujoRows[0].id;
      await connection.query(
        `DELETE frango
         FROM flujo_descuento_escalonado_rango_edad frango
         INNER JOIN flujo_descuento_escalonado_regla fregla ON fregla.id = frango.regla_id
         WHERE fregla.flujo_id = ?`,
        [flujoId]
      );
      await connection.query(
        "DELETE FROM flujo_descuento_escalonado_regla WHERE flujo_id = ?",
        [flujoId]
      );
      await connection.query(
        "DELETE FROM flujo_descuento_escalonado_tipo_persona_porcentaje WHERE flujo_id = ?",
        [flujoId]
      );
    }

    await insertarReglasFlujoDescuentoEscalonado(connection, flujoId, validacion.reglas);
    await insertarPorcentajesPredeterminadosTemporada(connection, flujoId, validacion.porcentajes);
    await connection.query(
      "UPDATE flujo_descuento_escalonado SET updated_at = NOW() WHERE id = ?",
      [flujoId]
    );

    const valoresActualizados = await obtenerFlujoDescuentoEscalonado(
      connection,
      flujoId,
      tipoResultado.value
    );

    await connection.commit();
    res.status(200).json(valoresActualizados);
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    registrarErrorRuta(error);
    res.status(500).json("Error al guardar valores predeterminados de temporada");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.post("/flujo-descuento-escalonado", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const validacion = validarYNormalizarValoresPredeterminadosTemporada(req.body);
    if (validacion.error) {
      return res.status(400).json(validacion.error);
    }

    let connection;
    try {
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      const [flujoExistente] = await connection.query(
        "SELECT id FROM flujo_descuento_escalonado WHERE tipo_temporada = 'BAJA' LIMIT 1 FOR UPDATE"
      );
      if (flujoExistente.length > 0) {
        await connection.rollback();
        return res.status(409).json("Ya existe un flujo de descuento escalonado");
      }

      const [flujoResult] = await connection.query(
        "INSERT INTO flujo_descuento_escalonado (tipo_temporada, created_at, updated_at) VALUES ('BAJA', NOW(), NOW())"
      );

      await insertarReglasFlujoDescuentoEscalonado(
        connection,
        flujoResult.insertId,
        validacion.reglas
      );
      await insertarPorcentajesPredeterminadosTemporada(
        connection,
        flujoResult.insertId,
        validacion.porcentajes
      );

      const flujo = await obtenerFlujoDescuentoEscalonado(
        connection,
        flujoResult.insertId,
        "BAJA"
      );

      await connection.commit();
      res.status(201).json(flujo);
    } catch (transactionError) {
      if (connection) {
        await connection.rollback();
      }
      throw transactionError;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al crear el flujo de descuento escalonado");
  }
});

router.put("/flujo-descuento-escalonado/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const idResultado = parsearEnteroNoNegativoFlujo(req.params.id, "id");
    if (idResultado.error || idResultado.value <= 0) {
      return res.status(400).json("id invalido");
    }

    const validacion = validarYNormalizarValoresPredeterminadosTemporada(req.body);
    if (validacion.error) {
      return res.status(400).json(validacion.error);
    }

    let connection;
    try {
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      const [flujoRows] = await connection.query(
        "SELECT id FROM flujo_descuento_escalonado WHERE id = ? FOR UPDATE",
        [idResultado.value]
      );
      if (flujoRows.length === 0) {
        await connection.rollback();
        return res.status(404).json("Flujo no encontrado");
      }

      await connection.query(
        `DELETE frango
         FROM flujo_descuento_escalonado_rango_edad frango
         INNER JOIN flujo_descuento_escalonado_regla fregla ON fregla.id = frango.regla_id
         WHERE fregla.flujo_id = ?`,
        [idResultado.value]
      );

      await connection.query(
        "DELETE FROM flujo_descuento_escalonado_regla WHERE flujo_id = ?",
        [idResultado.value]
      );
      await connection.query(
        "DELETE FROM flujo_descuento_escalonado_tipo_persona_porcentaje WHERE flujo_id = ?",
        [idResultado.value]
      );

      await insertarReglasFlujoDescuentoEscalonado(
        connection,
        idResultado.value,
        validacion.reglas
      );
      await insertarPorcentajesPredeterminadosTemporada(
        connection,
        idResultado.value,
        validacion.porcentajes
      );

      await connection.query(
        "UPDATE flujo_descuento_escalonado SET updated_at = NOW() WHERE id = ?",
        [idResultado.value]
      );

      const flujoActualizado = await obtenerFlujoDescuentoEscalonado(
        connection,
        idResultado.value,
        "BAJA"
      );

      await connection.commit();
      res.status(200).json(flujoActualizado);
    } catch (transactionError) {
      if (connection) {
        await connection.rollback();
      }
      throw transactionError;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al actualizar el flujo de descuento escalonado");
  }
});

// Configuración de multer para fotos de perfil
const uploadFotoPerfil = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Solo formatos raster conocidos; SVG y tipos arbitrarios pueden ejecutar
    // contenido activo cuando se muestran desde una URL firmada.
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  }
});

function manejarUploadFotoPerfil(req, res, next) {
  uploadFotoPerfil.single('foto')(req, res, (error) => {
    if (error) {
      res.status(400).json(error.message || 'No se pudo procesar la foto');
      return;
    }
    validarContenidoArchivos(req, res, next);
  });
}

// GET /configuracion/usuario/:id? - Obtener datos del usuario
router.get("/configuracion/usuario/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    const userId = req.params.id ? normalizarIdPositivo(req.params.id) : normalizarIdPositivo(cabecera.id);
    if (!userId) {
      return res.status(400).json({ success: false, message: "ID de usuario inválido" });
    }
    const db = mysqlConnection.promise();

    // Verificar permisos
    let tienePermisos = false;

    if (cabecera.rol === "admin") {
      tienePermisos = true;
    } else if (cabecera.rol === "departamental") {
      tienePermisos = await puedeAccederUsuarioPorJurisdiccion(db, cabecera, userId);
    } else if (cabecera.rol === "afiliado") {
      // Afiliado solo puede verse a sí mismo
      tienePermisos = userId === normalizarIdPositivo(cabecera.id);
    } else if (["admin-central", "auditor"].includes(cabecera.rol)) {
      // Roles del módulo de coseguro: solo pueden ver su propio perfil
      tienePermisos = userId === normalizarIdPositivo(cabecera.id);
    }

    if (!tienePermisos) {
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para ver este usuario"
      });
    }

    // Obtener datos del usuario
    const [usuario] = await mysqlConnection
      .promise()
      .query(
        `SELECT
          u.id,
          u.rol_id,
          u.area_turismo,
          u.area_coseguro,
          u.modulo_turismo,
          u.modulo_coseguro,
          u.modulo_olimpiadas,
          u.departamental_id,
          d.nombre as departamental_nombre,
          u.tipo_persona_id,
          tp.nombre as tipo_persona_nombre,
          u.nombre,
          u.apellido,
          u.fecha_nacimiento,
          u.documento,
          u.email,
          u.telefono,
          u.direccion,
          u.dependencia_judicial,
          u.legajo,
          u.cuil,
          u.cbu,
          u.foto_archivo,
          u.habilitado,
          r.nombre as rol_nombre
        FROM usuario u
        LEFT JOIN rol r ON r.id = u.rol_id
        LEFT JOIN tipo_persona tp ON tp.id = u.tipo_persona_id
        LEFT JOIN departamental d ON d.id = u.departamental_id
        WHERE u.id = ?`,
        [userId]
      );

    if (usuario.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado"
      });
    }

    const usuarioData = usuario[0];

    // Si tiene foto, prepararla para envío (como base64 o URL)
    if (usuarioData.foto_archivo) {
      try {
        const fotoObject = await getObjectBufferFromS3(usuarioData.foto_archivo);
        if (fotoObject?.buffer) {
          const fotoBase64 = fotoObject.buffer.toString("base64");
          usuarioData.foto_data = `data:${fotoObject.contentType};base64,${fotoBase64}`;
        } else {
          usuarioData.foto_data = null;
        }
      } catch (readError) {
        console.error("Error leyendo foto desde S3:", readError);
        usuarioData.foto_data = null;
      }
    }
    
    res.status(200).json({
      success: true,
      data: usuarioData
    });

  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener datos del usuario"
    });
  }
});

// PUT /configuracion/usuario/:id - Actualizar datos del usuario
router.put("/configuracion/usuario/:id", verifyToken, manejarUploadFotoPerfil, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    const userId = normalizarIdPositivo(req.params.id);

    // Validar que el ID sea válido
    if (!userId || isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: "ID de usuario inválido"
      });
    }

    let connection;
    let fotoNuevaSubida = null;
    try {
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      // Obtener datos actuales del usuario
      const [usuarioActual] = await connection.query(
        "SELECT * FROM usuario WHERE id = ? FOR UPDATE",
        [userId]
      );

      if (usuarioActual.length === 0) {
        throw crearErrorNegocio("Usuario no encontrado", 404);
      }

      const datosAnteriores = usuarioActual[0];

      // Verificar permisos y determinar qué campos puede editar
      let camposPermitidos = [];
      let tienePermisos = false;

      if (cabecera.rol === "admin") {
        tienePermisos = true;
        camposPermitidos = [
          'rol_id', 'area_turismo', 'area_coseguro', 'modulo_turismo', 'modulo_coseguro', 'modulo_olimpiadas',
          'departamental_id', 'tipo_persona_id', 'nombre', 'apellido',
          'fecha_nacimiento', 'documento', 'password', 'email', 'telefono', 'direccion', 'dependencia_judicial',
          'legajo', 'cuil', 'cbu', 'foto_archivo', 'habilitado'
        ];
      } else if (cabecera.rol === "departamental") {
        tienePermisos = await puedeAccederUsuarioPorJurisdiccion(connection, cabecera, userId);
        camposPermitidos = [
          'tipo_persona_id', 'nombre', 'apellido', 'fecha_nacimiento',
          'documento', 'password', 'email', 'telefono', 'direccion', 'dependencia_judicial', 'legajo',
          'modulo_turismo', 'modulo_coseguro', 'modulo_olimpiadas',
          'cuil', 'cbu', 'foto_archivo', 'habilitado'
        ];
      } else if (cabecera.rol === "afiliado") {
        // Solo puede editarse a sí mismo
        if (userId === normalizarIdPositivo(cabecera.id)) {
          tienePermisos = true;
        }
        camposPermitidos = [
          'nombre', 'apellido',
          'password', 'email', 'telefono', 'direccion', 'dependencia_judicial',
          'cuil', 'cbu', 'foto_archivo'
        ];
      } else if (["admin-central", "auditor"].includes(cabecera.rol)) {
        // Roles del módulo de coseguro: solo editan su propio perfil (datos personales)
        if (userId === normalizarIdPositivo(cabecera.id)) {
          tienePermisos = true;
        }
        camposPermitidos = [
          'nombre', 'apellido',
          'password', 'email', 'telefono', 'direccion', 'dependencia_judicial', 'cuil', 'cbu', 'foto_archivo'
        ];
      }

      if (!tienePermisos) {
        throw crearErrorNegocio("No tienes permisos para modificar este usuario", 403);
      }

      // Preparar campos para actualizar
      const updateFields = [];
      const updateValues = [];
      const cambios = [];
      let rolFinalId = normalizarIdPositivo(datosAnteriores.rol_id);
      let departamentalFinalId = normalizarIdPositivo(datosAnteriores.departamental_id);
      let tipoPersonaFinalId = normalizarIdPositivo(datosAnteriores.tipo_persona_id);
      let fechaNacimientoFinal = formatearFechaSQL(datosAnteriores.fecha_nacimiento);

      // Función auxiliar para formatear fechas
      const formatearFecha = (fecha) => formatearFechaSQL(fecha);

      // Procesar cada campo permitido
      if (camposPermitidos.includes('rol_id') && req.body.rol_id !== undefined) {
        const nuevoValor = normalizarIdPositivo(req.body.rol_id);
        if (!nuevoValor) throw crearErrorNegocio("Rol inválido", 400);
        const [rolesValidos] = await connection.query("SELECT id FROM rol WHERE id = ?", [nuevoValor]);
        if (rolesValidos.length === 0) throw crearErrorNegocio("Rol inexistente", 400);
        rolFinalId = nuevoValor;
        if (datosAnteriores.rol_id !== nuevoValor) {
          updateFields.push('rol_id = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'rol_id',
            valorAnterior: datosAnteriores.rol_id,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('departamental_id') && req.body.departamental_id !== undefined) {
        const nuevoValor = req.body.departamental_id === "" ? null : normalizarIdPositivo(req.body.departamental_id);
        if (req.body.departamental_id !== "" && !nuevoValor) throw crearErrorNegocio("Departamental inválida", 400);
        if (nuevoValor !== null) {
          const [departamentalesValidas] = await connection.query(
            "SELECT id FROM departamental WHERE id = ? AND habilitado = 'Y'",
            [nuevoValor]
          );
          if (departamentalesValidas.length === 0) throw crearErrorNegocio("Departamental inexistente o deshabilitada", 400);
        }
        departamentalFinalId = nuevoValor;
        if (datosAnteriores.departamental_id !== nuevoValor) {
          updateFields.push('departamental_id = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'departamental_id',
            valorAnterior: datosAnteriores.departamental_id,
            valorNuevo: nuevoValor
          });
        }
      }

      // Áreas habilitadas (solo staff departamental / admin-central): "1"/"0" desde el FormData
      for (const campoArea of ['area_turismo', 'area_coseguro']) {
        if (camposPermitidos.includes(campoArea) && req.body[campoArea] !== undefined) {
          const nuevoValor = normalizarBooleanoBinarioEstricto(req.body[campoArea]);
          if (nuevoValor === null) throw crearErrorNegocio(`El valor de ${campoArea} es inválido`, 400);
          if (Number(datosAnteriores[campoArea]) !== nuevoValor) {
            updateFields.push(`${campoArea} = ?`);
            updateValues.push(nuevoValor);
            cambios.push({
              campo: campoArea,
              valorAnterior: datosAnteriores[campoArea],
              valorNuevo: nuevoValor
            });
          }
        }
      }

      // Módulos visibles para cuentas afiliadas. Admin y departamental pueden
      // gestionarlos desde el perfil; el afiliado no puede cambiarlos.
      for (const campoModulo of ['modulo_turismo', 'modulo_coseguro', 'modulo_olimpiadas']) {
        if (camposPermitidos.includes(campoModulo) && req.body[campoModulo] !== undefined) {
          const nuevoValor = normalizarBooleanoBinarioEstricto(req.body[campoModulo]);
          if (nuevoValor === null) throw crearErrorNegocio(`El valor de ${campoModulo} es inválido`, 400);
          if (Number(datosAnteriores[campoModulo]) !== nuevoValor) {
            updateFields.push(`${campoModulo} = ?`);
            updateValues.push(nuevoValor);
            cambios.push({
              campo: campoModulo,
              valorAnterior: datosAnteriores[campoModulo],
              valorNuevo: nuevoValor
            });
          }
        }
      }

      if (camposPermitidos.includes('tipo_persona_id') && req.body.tipo_persona_id !== undefined) {
        const nuevoValor = req.body.tipo_persona_id === "" ? null : normalizarIdPositivo(req.body.tipo_persona_id);
        if (req.body.tipo_persona_id !== "" && !nuevoValor) throw crearErrorNegocio("Tipo de persona inválido", 400);
        if (nuevoValor !== null) {
          const [tiposValidos] = await connection.query("SELECT id FROM tipo_persona WHERE id = ?", [nuevoValor]);
          if (tiposValidos.length === 0) throw crearErrorNegocio("Tipo de persona inexistente", 400);
        }
        tipoPersonaFinalId = nuevoValor;
        if (datosAnteriores.tipo_persona_id !== nuevoValor) {
          updateFields.push('tipo_persona_id = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'tipo_persona_id',
            valorAnterior: datosAnteriores.tipo_persona_id,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('nombre') && req.body.nombre !== undefined) {
        const nuevoValor = normalizarTexto(req.body.nombre);
        if (!nuevoValor || nuevoValor.length > 45) throw crearErrorNegocio("Nombre inválido", 400);
        if (datosAnteriores.nombre !== nuevoValor) {
          updateFields.push('nombre = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'nombre',
            valorAnterior: datosAnteriores.nombre,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('apellido') && req.body.apellido !== undefined) {
        const nuevoValor = normalizarTexto(req.body.apellido);
        if (!nuevoValor || nuevoValor.length > 45) throw crearErrorNegocio("Apellido inválido", 400);
        if (datosAnteriores.apellido !== nuevoValor) {
          updateFields.push('apellido = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'apellido',
            valorAnterior: datosAnteriores.apellido,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('fecha_nacimiento') && req.body.fecha_nacimiento !== undefined) {
        const fechaFormateada = formatearFecha(req.body.fecha_nacimiento);
        const fechaAnteriorFormateada = formatearFecha(datosAnteriores.fecha_nacimiento);
        if (!fechaFormateada || calcularEdadEnFecha(fechaFormateada, obtenerFechaCivilHoyArgentina()) === null) {
          throw crearErrorNegocio("Fecha de nacimiento inválida", 400);
        }
        if (fechaAnteriorFormateada !== fechaFormateada) {
          updateFields.push('fecha_nacimiento = ?');
          updateValues.push(fechaFormateada);
          cambios.push({
            campo: 'fecha_nacimiento',
            valorAnterior: fechaAnteriorFormateada,
            valorNuevo: fechaFormateada
          });
        }
        fechaNacimientoFinal = fechaFormateada;
      }

      if (camposPermitidos.includes('documento') && req.body.documento !== undefined) {
        const documentoTexto = normalizarTexto(req.body.documento);
        const nuevoValor = esDniValido(documentoTexto) ? Number(documentoTexto) : null;
        if (!nuevoValor) throw crearErrorNegocio("Documento inválido", 400);
        if (Number(datosAnteriores.documento) !== nuevoValor) {
          updateFields.push('documento = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'documento',
            valorAnterior: datosAnteriores.documento,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('email') && req.body.email !== undefined) {
        const nuevoValor = normalizarTexto(req.body.email).toLowerCase();
        if (!nuevoValor || nuevoValor.length > 45 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nuevoValor)) {
          throw crearErrorNegocio("Email inválido", 400);
        }
        if (datosAnteriores.email !== nuevoValor) {
          const [emailsExistentes] = await connection.query(
            "SELECT id FROM usuario WHERE LOWER(TRIM(email)) = ? AND id <> ? LIMIT 1 FOR UPDATE",
            [nuevoValor, userId]
          );
          if (emailsExistentes.length > 0) throw crearErrorNegocio("Ya existe un usuario con ese email", 409);
          updateFields.push('email = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'email',
            valorAnterior: datosAnteriores.email,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('telefono') && req.body.telefono !== undefined) {
        const nuevoValor = normalizarTexto(req.body.telefono) || null;
        if (nuevoValor && nuevoValor.length > 15) throw crearErrorNegocio("Teléfono inválido", 400);
        if (datosAnteriores.telefono !== nuevoValor) {
          updateFields.push('telefono = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'telefono',
            valorAnterior: datosAnteriores.telefono,
            valorNuevo: nuevoValor
          });
        }
      }

      for (const campoContacto of ['direccion', 'dependencia_judicial']) {
        if (camposPermitidos.includes(campoContacto) && req.body[campoContacto] !== undefined) {
          const nuevoValor = normalizarTexto(req.body[campoContacto]) || null;
          if (nuevoValor && nuevoValor.length > 50) {
            throw crearErrorNegocio(
              campoContacto === 'direccion' ? "Dirección inválida" : "Dependencia judicial inválida",
              400
            );
          }
          if (datosAnteriores[campoContacto] !== nuevoValor) {
            updateFields.push(`${campoContacto} = ?`);
            updateValues.push(nuevoValor);
            cambios.push({
              campo: campoContacto,
              valorAnterior: datosAnteriores[campoContacto],
              valorNuevo: nuevoValor
            });
          }
        }
      }

      if (camposPermitidos.includes('legajo') && req.body.legajo !== undefined) {
        const nuevoValor = normalizarTexto(req.body.legajo) || null;
        if (nuevoValor && nuevoValor.length > 45) throw crearErrorNegocio("Legajo inválido", 400);
        if (datosAnteriores.legajo !== nuevoValor) {
          updateFields.push('legajo = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'legajo',
            valorAnterior: datosAnteriores.legajo,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('habilitado') && req.body.habilitado !== undefined) {
        const nuevoValor = normalizarSiNoEstricto(req.body.habilitado);
        if (nuevoValor === null) throw crearErrorNegocio("Estado habilitado inválido", 400);
        if (datosAnteriores.habilitado !== nuevoValor) {
          updateFields.push('habilitado = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'habilitado',
            valorAnterior: datosAnteriores.habilitado,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('cuil') && req.body.cuil !== undefined) {
        const nuevoValor = normalizarTexto(req.body.cuil) || null;
        if (nuevoValor && !validarCuitCuil(nuevoValor)) {
          throw crearErrorNegocio("El CUIL es inválido", 400);
        }
        if (datosAnteriores.cuil !== nuevoValor) {
          updateFields.push('cuil = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'cuil',
            valorAnterior: datosAnteriores.cuil,
            valorNuevo: nuevoValor
          });
        }
      }

      if (camposPermitidos.includes('cbu') && req.body.cbu !== undefined) {
        const nuevoValor = normalizarTexto(req.body.cbu) || null;
        if (nuevoValor && !validarCbu(nuevoValor)) {
          throw crearErrorNegocio("El CBU es inválido", 400);
        }
        if (datosAnteriores.cbu !== nuevoValor) {
          updateFields.push('cbu = ?');
          updateValues.push(nuevoValor);
          cambios.push({
            campo: 'cbu',
            valorAnterior: datosAnteriores.cbu,
            valorNuevo: nuevoValor
          });
        }
      }

      // Procesar password si viene
      if (
        camposPermitidos.includes('password') &&
        (cabecera.rol === "admin" || userId === normalizarIdPositivo(cabecera.id)) &&
        typeof req.body.password === "string" && req.body.password.trim() !== ''
      ) {
        if (req.body.password.length < 8 || req.body.password.length > 128) {
          throw crearErrorNegocio("La contraseña debe tener entre 8 y 128 caracteres", 400);
        }
        const passwordHash = await bcryptjs.hash(req.body.password, 8);
        updateFields.push('password = ?');
        updateValues.push(passwordHash);
        cambios.push({
          campo: 'password',
          valorAnterior: '[OCULTO]',
          valorNuevo: '[MODIFICADO]'
        });
      }

      const [rolFinalRows] = rolFinalId
        ? await connection.query("SELECT nombre FROM rol WHERE id = ?", [rolFinalId])
        : [[]];
      if (rolFinalRows.length === 0) throw crearErrorNegocio("El usuario debe tener un rol válido", 400);
      if (rolFinalRows[0].nombre === "afiliado") {
        if (!departamentalFinalId || !tipoPersonaFinalId || !fechaNacimientoFinal
          || calcularEdadEnFecha(fechaNacimientoFinal, obtenerFechaCivilHoyArgentina()) === null) {
          throw crearErrorNegocio(
            "Los afiliados requieren departamental, tipo de persona y fecha de nacimiento válidos",
            400
          );
        }
      }

      // Procesar foto si viene
      if (camposPermitidos.includes('foto_archivo') && req.file) {
        try {
          // Generar nombre único para la foto
          const fotoHash = crypto.randomBytes(16).toString('hex');
          const extension = getSafeFileExtension(req.file.originalname, req.file.mimetype);
          const nombreArchivo = `perfil_${fotoHash}.${extension}`;
          await uploadBufferToS3({
            key: nombreArchivo,
            buffer: req.file.buffer,
            contentType: req.file.mimetype || getMimeTypeFromFileName(nombreArchivo, "image/jpeg"),
          });
          fotoNuevaSubida = nombreArchivo;

          // Actualizar campo en base de datos
          updateFields.push('foto_archivo = ?');
          updateValues.push(nombreArchivo);
          cambios.push({
            campo: 'foto_archivo',
            valorAnterior: datosAnteriores.foto_archivo,
            valorNuevo: nombreArchivo
          });

          // Nota: NO borramos la foto anterior según requerimiento
        } catch (fotoError) {
          console.error('Error guardando foto:', fotoError);
          await connection.rollback();
          return res.status(500).json({
            success: false,
            message: "Error al guardar la foto"
          });
        }
      } else if (
        camposPermitidos.includes('foto_archivo') &&
        normalizarBoolean(req.body.quitar_foto) &&
        datosAnteriores.foto_archivo
      ) {
        // Quitar la foto de perfil (el objeto en S3 se conserva, igual que al
        // reemplazarla)
        updateFields.push('foto_archivo = ?');
        updateValues.push(null);
        cambios.push({
          campo: 'foto_archivo',
          valorAnterior: datosAnteriores.foto_archivo,
          valorNuevo: null
        });
      }

      // Si no hay cambios, retornar
      if (updateFields.length === 0) {
        await connection.rollback();
        return res.status(200).json({
          success: true,
          message: "No hay cambios para actualizar"
        });
      }

      // Ejecutar actualización
      updateValues.push(userId);
      const updateQuery = `UPDATE usuario SET ${updateFields.join(', ')} WHERE id = ?`;

      const [result] = await connection.query(updateQuery, updateValues);

      // Registrar cambios en el historial
      if (cambios.length > 0) {
        await registrarHistorial(
          connection,
          userId,
          'UPDATE',
          'usuario',
          cabecera.id,
          req,
          cambios,
          'Actualización de configuración de usuario'
        );
      }

      await connection.commit();
      fotoNuevaSubida = null;

      res.status(200).json({
        success: true,
        message: "Usuario actualizado correctamente"
      });

    } catch (updateError) {
      if (connection) {
        await connection.rollback();
      }
      if (fotoNuevaSubida) {
        try {
          await deleteFileFromS3(fotoNuevaSubida);
        } catch (deleteError) {
          console.error("No se pudo limpiar la foto nueva tras revertir el usuario", deleteError?.name || deleteError?.code);
        }
      }
      throw updateError;
    } finally {
      if (connection) {
        connection.release();
      }
    }

  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Ya existe un usuario con esos datos" });
    }
    res.status(500).json({
      success: false,
      message: "Error al actualizar el usuario"
    });
  }
});

// POST /configuracion/usuario - Crear nuevo usuario
router.post("/configuracion/usuario", verifyToken, manejarUploadFotoPerfil, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    // Verificar permisos - solo admin y departamental pueden crear usuarios
    if (cabecera.rol !== "admin" && cabecera.rol !== "departamental") {
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para crear usuarios"
      });
    }

    const nombreNormalizado = normalizarTexto(req.body?.nombre);
    const apellidoNormalizado = normalizarTexto(req.body?.apellido);
    const emailNormalizado = normalizarTexto(req.body?.email).toLowerCase();
    const documentoTexto = normalizarTexto(req.body?.documento);
    const passwordTexto = typeof req.body?.password === "string" ? req.body.password : "";

    // Estos límites reflejan el esquema actual y evitan truncados/coerciones de MySQL.
    if (!nombreNormalizado || nombreNormalizado.length > 45
      || !apellidoNormalizado || apellidoNormalizado.length > 45
      || !emailNormalizado || emailNormalizado.length > 45
      || !esDniValido(documentoTexto)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)
      || passwordTexto.length < 8 || passwordTexto.length > 128) {
      return res.status(400).json({
        success: false,
        message: "Nombre, apellido, email, documento y contraseña son inválidos"
      });
    }
    const documentoValor = Number(documentoTexto);

    let connection;
    let nombreArchivo = null;
    try {
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      // Determinar qué campos puede asignar según el rol
      let camposPermitidos = [];
      let valorDefectoRol = null;
      let valorDefectoDepartamental = null;
      let rolEfectivo = null;
      let departamentalEfectiva = null;
      let tipoPersonaEfectivo = null;
      let fechaNacimientoEfectiva = null;

      if (cabecera.rol === "admin") {
        camposPermitidos = [
          'rol_id', 'area_turismo', 'area_coseguro', 'modulo_turismo', 'modulo_coseguro', 'modulo_olimpiadas',
          'departamental_id', 'tipo_persona_id', 'nombre', 'apellido',
          'fecha_nacimiento', 'documento', 'password', 'email', 'telefono', 'direccion', 'dependencia_judicial',
          'legajo', 'cuil', 'cbu', 'foto_archivo', 'habilitado'
        ];
      } else if (cabecera.rol === "departamental") {
        // Departamental puede crear usuarios pero con restricciones
        camposPermitidos = [
          'tipo_persona_id', 'nombre', 'apellido', 'fecha_nacimiento',
          'documento', 'password', 'email', 'telefono', 'direccion', 'dependencia_judicial', 'legajo',
          'modulo_turismo', 'modulo_coseguro', 'modulo_olimpiadas',
          'cuil', 'cbu', 'foto_archivo', 'habilitado'
        ];
        // Asignar automáticamente rol afiliado y su departamento
        const [rolAfiliado] = await connection.query(
          "SELECT id FROM rol WHERE nombre = 'afiliado' LIMIT 1"
        );
        if (rolAfiliado.length > 0) {
          valorDefectoRol = rolAfiliado[0].id;
          rolEfectivo = "afiliado";
        }
        const [usuarioDepartamental] = await connection.query(
          "SELECT departamental_id FROM usuario WHERE id = ? LIMIT 1",
          [cabecera.id]
        );
        valorDefectoDepartamental = normalizarIdPositivo(usuarioDepartamental[0]?.departamental_id);
        if (!valorDefectoDepartamental) {
          throw crearErrorNegocio("El usuario departamental no tiene una departamental válida asignada", 409);
        }
      }

      // Preparar campos para insertar
      const insertFields = [];
      const insertPlaceholders = [];
      const insertValues = [];
      const cambios = [];

      const formatearFecha = (fecha) => formatearFechaSQL(fecha);

      // Procesar rol_id
      if (camposPermitidos.includes('rol_id') && req.body.rol_id !== undefined) {
        const nuevoValor = normalizarIdPositivo(req.body.rol_id);
        if (nuevoValor === null) throw crearErrorNegocio("Rol inválido", 400);
        const [rolesValidos] = await connection.query("SELECT nombre FROM rol WHERE id = ?", [nuevoValor]);
        if (rolesValidos.length === 0) throw crearErrorNegocio("Rol inexistente", 400);
        rolEfectivo = rolesValidos[0].nombre;
        insertFields.push('rol_id');
        insertPlaceholders.push('?');
        insertValues.push(nuevoValor);
        cambios.push({
          campo: 'rol_id',
          valorAnterior: null,
          valorNuevo: nuevoValor
        });
      } else if (valorDefectoRol !== null) {
        insertFields.push('rol_id');
        insertPlaceholders.push('?');
        insertValues.push(valorDefectoRol);
        cambios.push({
          campo: 'rol_id',
          valorAnterior: null,
          valorNuevo: valorDefectoRol
        });
      } else {
        throw crearErrorNegocio("El rol es obligatorio", 400);
      }

      // Procesar departamental_id
      if (camposPermitidos.includes('departamental_id') && req.body.departamental_id !== undefined) {
        const nuevoValor = req.body.departamental_id === "" ? null : normalizarIdPositivo(req.body.departamental_id);
        if (req.body.departamental_id !== "" && nuevoValor === null) {
          throw crearErrorNegocio("Departamental inválida", 400);
        }
        if (nuevoValor !== null) {
          const [departamentalesValidas] = await connection.query(
            "SELECT id FROM departamental WHERE id = ? AND habilitado = 'Y'",
            [nuevoValor]
          );
          if (departamentalesValidas.length === 0) throw crearErrorNegocio("Departamental inexistente o deshabilitada", 400);
        }
        departamentalEfectiva = nuevoValor;
        insertFields.push('departamental_id');
        insertPlaceholders.push('?');
        insertValues.push(nuevoValor);
        cambios.push({
          campo: 'departamental_id',
          valorAnterior: null,
          valorNuevo: nuevoValor
        });
      } else if (valorDefectoDepartamental !== null) {
        departamentalEfectiva = valorDefectoDepartamental;
        insertFields.push('departamental_id');
        insertPlaceholders.push('?');
        insertValues.push(valorDefectoDepartamental);
        cambios.push({
          campo: 'departamental_id',
          valorAnterior: null,
          valorNuevo: valorDefectoDepartamental
        });
      }

      // Procesar tipo_persona_id
      if (camposPermitidos.includes('tipo_persona_id') && req.body.tipo_persona_id !== undefined) {
        const nuevoValor = req.body.tipo_persona_id === "" ? null : normalizarIdPositivo(req.body.tipo_persona_id);
        if (req.body.tipo_persona_id !== "" && nuevoValor === null) {
          throw crearErrorNegocio("Tipo de persona inválido", 400);
        }
        if (nuevoValor !== null) {
          const [tiposValidos] = await connection.query("SELECT id FROM tipo_persona WHERE id = ?", [nuevoValor]);
          if (tiposValidos.length === 0) throw crearErrorNegocio("Tipo de persona inexistente", 400);
        }
        tipoPersonaEfectivo = nuevoValor;
        insertFields.push('tipo_persona_id');
        insertPlaceholders.push('?');
        insertValues.push(nuevoValor);
        cambios.push({
          campo: 'tipo_persona_id',
          valorAnterior: null,
          valorNuevo: nuevoValor
        });
      }

      if (rolEfectivo === "afiliado" && (!departamentalEfectiva || !tipoPersonaEfectivo)) {
        throw crearErrorNegocio("Los afiliados requieren departamental y tipo de persona válidos", 400);
      }

      // Procesar áreas habilitadas (solo staff departamental / admin-central)
      for (const campoArea of ['area_turismo', 'area_coseguro']) {
        if (camposPermitidos.includes(campoArea) && req.body[campoArea] !== undefined) {
          const nuevoValor = normalizarBooleanoBinarioEstricto(req.body[campoArea]);
          if (nuevoValor === null) throw crearErrorNegocio(`El valor de ${campoArea} es inválido`, 400);
          insertFields.push(campoArea);
          insertPlaceholders.push('?');
          insertValues.push(nuevoValor);
          cambios.push({
            campo: campoArea,
            valorAnterior: null,
            valorNuevo: nuevoValor
          });
        }
      }

      for (const campoModulo of ['modulo_turismo', 'modulo_coseguro', 'modulo_olimpiadas']) {
        if (camposPermitidos.includes(campoModulo) && req.body[campoModulo] !== undefined) {
          const nuevoValor = normalizarBooleanoBinarioEstricto(req.body[campoModulo]);
          if (nuevoValor === null) throw crearErrorNegocio(`El valor de ${campoModulo} es inválido`, 400);
          insertFields.push(campoModulo);
          insertPlaceholders.push('?');
          insertValues.push(nuevoValor);
          cambios.push({ campo: campoModulo, valorAnterior: null, valorNuevo: nuevoValor });
        }
      }

      // Procesar nombre (requerido)
      insertFields.push('nombre');
      insertPlaceholders.push('?');
      insertValues.push(nombreNormalizado);
      cambios.push({
        campo: 'nombre',
        valorAnterior: null,
        valorNuevo: nombreNormalizado
      });

      // Procesar apellido (requerido)
      insertFields.push('apellido');
      insertPlaceholders.push('?');
      insertValues.push(apellidoNormalizado);
      cambios.push({
        campo: 'apellido',
        valorAnterior: null,
        valorNuevo: apellidoNormalizado
      });

      // Procesar fecha_nacimiento
      if (camposPermitidos.includes('fecha_nacimiento') && req.body.fecha_nacimiento !== undefined) {
        const fechaFormateada = formatearFecha(req.body.fecha_nacimiento);
        if (!fechaFormateada || calcularEdadEnFecha(fechaFormateada, obtenerFechaCivilHoyArgentina()) === null) {
          throw crearErrorNegocio("Fecha de nacimiento inválida", 400);
        }
        insertFields.push('fecha_nacimiento');
        insertPlaceholders.push('?');
        insertValues.push(fechaFormateada);
        fechaNacimientoEfectiva = fechaFormateada;
        cambios.push({
          campo: 'fecha_nacimiento',
          valorAnterior: null,
          valorNuevo: fechaFormateada
        });
      }
      if (rolEfectivo === "afiliado" && !fechaNacimientoEfectiva) {
        throw crearErrorNegocio("La fecha de nacimiento es obligatoria para afiliados", 400);
      }

      // Procesar documento (requerido)
      insertFields.push('documento');
      insertPlaceholders.push('?');
      insertValues.push(documentoValor);
      cambios.push({
        campo: 'documento',
        valorAnterior: null,
        valorNuevo: documentoValor
      });

      // Procesar email (requerido)
      insertFields.push('email');
      insertPlaceholders.push('?');
      insertValues.push(emailNormalizado);
      cambios.push({
        campo: 'email',
        valorAnterior: null,
        valorNuevo: emailNormalizado
      });

      // Verificar si el email ya existe
      const [emailExistente] = await connection.query(
        "SELECT id FROM usuario WHERE email = ?",
        [emailNormalizado]
      );

      if (emailExistente.length > 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Ya existe un usuario con este email"
        });
      }

      // Procesar telefono
      if (camposPermitidos.includes('telefono') && req.body.telefono !== undefined) {
        const telefono = normalizarTexto(req.body.telefono) || null;
        if (telefono && telefono.length > 15) throw crearErrorNegocio("Teléfono inválido", 400);
        insertFields.push('telefono');
        insertPlaceholders.push('?');
        insertValues.push(telefono);
        cambios.push({
          campo: 'telefono',
          valorAnterior: null,
          valorNuevo: telefono
        });
      }

      for (const campoContacto of ['direccion', 'dependencia_judicial']) {
        if (camposPermitidos.includes(campoContacto) && req.body[campoContacto] !== undefined) {
          const valor = normalizarTexto(req.body[campoContacto]) || null;
          if (valor && valor.length > 50) {
            throw crearErrorNegocio(
              campoContacto === 'direccion' ? "Dirección inválida" : "Dependencia judicial inválida",
              400
            );
          }
          insertFields.push(campoContacto);
          insertPlaceholders.push('?');
          insertValues.push(valor);
          cambios.push({ campo: campoContacto, valorAnterior: null, valorNuevo: valor });
        }
      }

      // Procesar legajo
      if (camposPermitidos.includes('legajo') && req.body.legajo !== undefined) {
        const legajo = normalizarTexto(req.body.legajo) || null;
        if (legajo && legajo.length > 45) throw crearErrorNegocio("Legajo inválido", 400);
        insertFields.push('legajo');
        insertPlaceholders.push('?');
        insertValues.push(legajo);
        cambios.push({
          campo: 'legajo',
          valorAnterior: null,
          valorNuevo: legajo
        });
      }

      for (const [campo, longitud] of [["cuil", 11], ["cbu", 22]]) {
        if (camposPermitidos.includes(campo) && req.body[campo] !== undefined) {
          const valor = normalizarTexto(req.body[campo]) || null;
          const valido = valor === null || (campo === "cuil" ? validarCuitCuil(valor) : validarCbu(valor));
          if (!valido || (valor !== null && valor.length !== longitud)) {
            throw crearErrorNegocio(`${campo.toUpperCase()} inválido`, 400);
          }
          insertFields.push(campo);
          insertPlaceholders.push('?');
          insertValues.push(valor);
          cambios.push({ campo, valorAnterior: null, valorNuevo: valor });
        }
      }

      // Procesar habilitado (por defecto true)
      if (camposPermitidos.includes('habilitado')) {
        const habilitadoValor = req.body.habilitado === undefined
          ? "Y"
          : normalizarSiNoEstricto(req.body.habilitado);
        if (habilitadoValor === null) throw crearErrorNegocio("El estado habilitado es inválido", 400);
        insertFields.push('habilitado');
        insertPlaceholders.push('?');
        insertValues.push(habilitadoValor);
        cambios.push({
          campo: 'habilitado',
          valorAnterior: null,
          valorNuevo: habilitadoValor
        });
      }

      // Procesar password (si viene, sino generar una por defecto o dejarla opcional)
      if (camposPermitidos.includes('password')) {
        const passwordHash = await bcryptjs.hash(passwordTexto, 8);
        insertFields.push('password');
        insertPlaceholders.push('?');
        insertValues.push(passwordHash);
        cambios.push({
          campo: 'password',
          valorAnterior: null,
          valorNuevo: '[ESTABLECIDO]'
        });
      }

      // Procesar foto si viene
      if (camposPermitidos.includes('foto_archivo') && req.file) {
        try {
          // Generar nombre único para la foto
          const fotoHash = crypto.randomBytes(16).toString('hex');
          const extension = getSafeFileExtension(req.file.originalname, req.file.mimetype);
          nombreArchivo = `perfil_${fotoHash}.${extension}`;
          await uploadBufferToS3({
            key: nombreArchivo,
            buffer: req.file.buffer,
            contentType: req.file.mimetype || getMimeTypeFromFileName(nombreArchivo, "image/jpeg"),
          });

          insertFields.push('foto_archivo');
          insertPlaceholders.push('?');
          insertValues.push(nombreArchivo);
          cambios.push({
            campo: 'foto_archivo',
            valorAnterior: null,
            valorNuevo: nombreArchivo
          });
        } catch (fotoError) {
          console.error('Error guardando foto:', fotoError);
          await connection.rollback();
          return res.status(500).json({
            success: false,
            message: "Error al guardar la foto"
          });
        }
      }

      // Ejecutar inserción
      const insertQuery = `INSERT INTO usuario (${insertFields.join(', ')}) VALUES (${insertPlaceholders.join(', ')})`;
      const [result] = await connection.query(insertQuery, insertValues);

      const nuevoUsuarioId = result.insertId;

      // Registrar en el historial
      if (cambios.length > 0) {
        await registrarHistorial(
          connection,
          nuevoUsuarioId,
          'CREATE',
          'usuario',
          cabecera.id,
          req,
          cambios,
          'Creación de nuevo usuario'
        );
      }

      await connection.commit();
      nombreArchivo = null;

      res.status(201).json({
        success: true,
        message: "Usuario creado correctamente",
        data: {
          id: nuevoUsuarioId
        }
      });

    } catch (createError) {
      if (connection) {
        await connection.rollback();
      }
      if (nombreArchivo) {
        try {
          await deleteFileFromS3(nombreArchivo);
        } catch (deleteError) {
          console.error("No se pudo limpiar la foto del usuario no creado", deleteError?.name || deleteError?.code);
        }
      }
      throw createError;
    } finally {
      if (connection) {
        connection.release();
      }
    }

  } catch (error) {
    registrarErrorRuta(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Ya existe un usuario con esos datos" });
    }
    res.status(500).json({
      success: false,
      message: "Error al crear el usuario"
    });
  }
});

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

module.exports = router;
