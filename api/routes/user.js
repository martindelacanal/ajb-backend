const express = require("express");
const router = express.Router();

const mysqlConnection = require("../connection/connection");

const jwt = require("jsonwebtoken");

const bcryptjs = require("bcryptjs");

const multer = require("multer");

const moment = require("moment"); // para formatear fechas
const {
  obtenerCalendarioAlternativoServicio,
  obtenerSnapshotDisponibilidad,
  obtenerServicios,
  parsearParametrosBusquedaDisponibilidad,
  parsearServicioIdsCsv,
} = require("../services/servicios-disponibilidad");

// S3 INICIO
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;

const crypto = require("crypto");

const S3_SIGNED_URL_EXPIRES_SECONDS = Number.parseInt(
  process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600",
  10
);

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const s3 = new S3Client({
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretAccessKey,
  },
  region: bucketRegion,
});

function getMimeTypeFromFileName(fileName, fallback = "application/octet-stream") {
  const extension = (fileName || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || fallback;
}

function getSafeFileExtension(originalName, mimeType) {
  const extensionFromName = (originalName || "").includes(".")
    ? originalName.split(".").pop().toLowerCase()
    : "";
  const sanitizedExtension = extensionFromName.replace(/[^a-z0-9]/g, "");
  if (sanitizedExtension) {
    return sanitizedExtension;
  }

  return EXTENSION_BY_MIME[mimeType] || "png";
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
  const dataUriMatch = value.match(/^data:([^;]+);base64,(.+)$/);
  const contentType = dataUriMatch ? dataUriMatch[1] : defaultContentType;
  const base64Payload = dataUriMatch ? dataUriMatch[2] : value;
  const buffer = Buffer.from(base64Payload.replace(/\s/g, ""), "base64");

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
// S3 FIN

router.post("/signin", async (req, res) => {
  const documento = req.body.documento || null;
  const password = req.body.password || null;
  const recordar = req.body.recordar || null;

  if (!documento || !password) {
    return res.status(400).json("Documento y contraseña son requeridos");
  }

  const query = `
    SELECT u.id, u.nombre, u.apellido, u.documento, u.email, u.password, u.departamental_id, rol.nombre AS rol, u.habilitado
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
          usuario.fecha_nacimiento = usuario.fecha_nacimiento.toISOString().split('T')[0];
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
    console.log(error);
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
          fecha_hash_credencial
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
    const fechaHash = new Date(usuario.fecha_hash_credencial);
    const fechaActual = new Date();

    // Calcular la diferencia en milisegundos y convertir a días
    const diferenciaDias = (fechaActual - fechaHash) / (1000 * 60 * 60 * 24);

    // Si la diferencia es mayor a 1 día, está expirada
    if (diferenciaDias > 1) {
      return res.status(200).json({
        estado: "Expirada",
        descripcion: "La credencial ha expirado"
      });
    }

    // Si está dentro del día, está vigente
    return res.status(200).json({
      estado: "Vigente",
      descripcion: "Credencial válida y vigente"
    });

  } catch (error) {
    console.log(error);
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
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT lugar FROM servicio GROUP BY lugar ORDER BY lugar ASC");
      const lugares = rows.map(row => row.lugar);
      res.status(200).json(lugares);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los lugares");
  }
});

router.get("/servicios", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const db = mysqlConnection.promise();
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
        });

        disponibilidadSnapshot.forEach((item) => {
          disponibilidadPorServicio.set(Number(item.servicio_id), item);
        });

        bloquesDisponiblesPorServicio = await obtenerBloquesDisponiblesPorServicio(db, {
          servicioIds: servicios.map((servicio) => Number(servicio.id)),
          fechaInicio: criteriosDisponibilidad.fecha_inicio,
          fechaFin: criteriosDisponibilidad.fecha_fin
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
                AND CURDATE() BETWEEN s.fecha_inicio_inscripcion AND s.fecha_fin_inscripcion
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
          const fechaInicioSolicitud = new Date(fecha_inicio);
          const fechaFinSolicitud = new Date(fecha_fin);

          // Calcular días del rango (NO incluir el día de salida)
          const diasTotales = Math.ceil((fechaFinSolicitud - fechaInicioSolicitud) / (1000 * 60 * 60 * 24));

          let precios_minimos_totales = [];
          let precios_maximos_totales = [];

          // Procesar cada día del rango
          for (let dia = 0; dia < diasTotales; dia++) {
            const fechaActual = new Date(fechaInicioSolicitud);
            fechaActual.setDate(fechaInicioSolicitud.getDate() + dia);
            const fechaString = fechaActual.toISOString().split('T')[0];

            let precio_minimo_dia = 0;
            let precio_maximo_dia = 0;

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

              if (tarifasAdultos.length > 0 && tarifasAdultos[0].precio_min !== null) {
                precio_minimo_dia += tarifasAdultos[0].precio_min * adultos;
                precio_maximo_dia += tarifasAdultos[0].precio_max * adultos;
              }
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

              if (tarifasninos.length > 0 && tarifasninos[0].precio_min !== null) {
                precio_minimo_dia += tarifasninos[0].precio_min * ninos;
                precio_maximo_dia += tarifasninos[0].precio_max * ninos;
              }
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

              if (tarifasBebes.length > 0 && tarifasBebes[0].precio_min !== null) {
                precio_minimo_dia += tarifasBebes[0].precio_min * bebes;
                precio_maximo_dia += tarifasBebes[0].precio_max * bebes;
              }
            }

            precios_minimos_totales.push(precio_minimo_dia);
            precios_maximos_totales.push(precio_maximo_dia);
          }

          // Sumar todos los días
          precio_minimo = precios_minimos_totales.reduce((sum, precio) => sum + precio, 0);
          precio_maximo = precios_maximos_totales.reduce((sum, precio) => sum + precio, 0);
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
    console.log(error);
    res.status(500).json("Error al obtener los servicios");
  }
});

router.get("/servicios/disponibilidad", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
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
      const snapshot = await obtenerSnapshotDisponibilidad(db, {
        lugar: req.query.lugar || null,
        servicioIds,
        fechaInicio: parseo.value.fecha_inicio,
        fechaFin: parseo.value.fecha_fin,
        adultos: parseo.value.adultos,
        ninos: parseo.value.ninos,
        bebes: parseo.value.bebes,
        totalPersonas: parseo.value.total_personas,
      });

      res.status(200).json(snapshot);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener disponibilidad de servicios");
  }
});

router.get("/servicios/:id/disponibilidad", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const servicioId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(servicioId) || servicioId <= 0) {
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
      });

      const bloquesDisponiblesMap = await obtenerBloquesDisponiblesPorServicio(db, {
        servicioId,
        fechaInicio: parseo.value.fecha_inicio,
        fechaFin: parseo.value.fecha_fin
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
    console.log(error);
    res.status(500).json("Error al obtener fechas alternativas");
  }
});

router.get("/recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
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
    console.log(error);
    res.status(500).json("Error al obtener los recursos");
  }
});

router.get("/adicionales", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM adicional ORDER BY nombre ASC");
      res.status(200).json(rows);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los adicionales");
  }
});

router.get("/sorteos/activos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol)) {
      return res.status(401).json("No autorizado");
    }

    const db = mysqlConnection.promise();
    await ejecutarMantenimientoBloquesAlta(db);

    const servicioId = normalizarIdPositivo(req.query.servicio_id);
    const params = [];
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
          AND CURDATE() BETWEEN s.fecha_inicio_inscripcion AND s.fecha_fin_inscripcion
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
    console.log(error);
    if (esErrorTemporadaAltaNoMigrada(error)) {
      return res.status(200).json([]);
    }
    res.status(500).json("Error al obtener sorteos activos");
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
    console.log(error);
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

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();

    const [sorteoResult] = await connection.query(
      `INSERT INTO sorteo (nombre, descripcion, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado)
       VALUES (?, ?, ?, ?, ?)`,
      [nombre, descripcion || null, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado]
    );

    const sorteoId = sorteoResult.insertId;

    for (const bloque of Array.isArray(bloques) ? bloques : []) {
      const servicioId = normalizarIdPositivo(bloque.servicio_id);
      const recursosIds = Array.isArray(bloque.recursos)
        ? bloque.recursos.map(normalizarIdPositivo).filter(Boolean)
        : [];

      if (!servicioId || !bloque.nombre || !bloque.fecha_inicio || !bloque.fecha_fin || recursosIds.length === 0) {
        continue;
      }

      const [bloqueResult] = await connection.query(
        `INSERT INTO bloque_fecha
          (sorteo_id, servicio_id, nombre, modalidad, fecha_inicio, fecha_fin, estado)
         VALUES (?, ?, ?, 'SORTEO', ?, ?, 'ACTIVO')`,
        [sorteoId, servicioId, bloque.nombre, bloque.fecha_inicio, bloque.fecha_fin]
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
    console.log(error);
    res.status(500).json("Error al crear sorteo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/sorteos/:id", verifyToken, async (req, res) => {
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

    await mysqlConnection.promise().query(
      `UPDATE sorteo
       SET nombre = ?, descripcion = ?, fecha_inicio_inscripcion = ?, fecha_fin_inscripcion = ?, estado = ?
       WHERE id = ?`,
      [nombre, descripcion || null, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado, sorteoId]
    );

    res.status(200).json({ message: "Sorteo actualizado correctamente" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al actualizar sorteo");
  }
});

router.delete("/admin/sorteos/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const sorteoId = normalizarIdPositivo(req.params.id);
    if (!sorteoId) {
      return res.status(400).json("ID invalido");
    }

    await mysqlConnection.promise().query("UPDATE sorteo SET estado = 'CANCELADO' WHERE id = ?", [sorteoId]);
    await mysqlConnection.promise().query("UPDATE bloque_fecha SET estado = 'CANCELADO' WHERE sorteo_id = ?", [sorteoId]);
    res.status(200).json({ message: "Sorteo cancelado correctamente" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al cancelar sorteo");
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
    console.log(error);
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
        await connection.query("DELETE FROM temporada_tarifa WHERE id = ?", [temporadaAnteriorId]);
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
    res.status(500).json("Error al obtener inscripciones");
  }
});

router.post("/sorteos/:id/cotizacion", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol)) {
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

    const cotizacion = await cotizarBloqueComun(db, {
      bloque,
      regimenId,
      personas: req.body.personas,
      adicionales: req.body.adicionales || []
    });

    res.status(200).json(cotizacion);
  } catch (error) {
    console.log(error);
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
    if (!["admin", "afiliado", "departamental"].includes(cabecera.rol)) {
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
    await ejecutarMantenimientoBloquesAlta(connection);

    const bloque = await obtenerBloqueConRecursos(connection, bloqueFechaId, { forUpdate: true });
    if (Number(bloque.sorteo_id) !== sorteoId) {
      await connection.rollback();
      return res.status(404).json("Bloque no encontrado para el sorteo");
    }
    validarBloqueInscripcionAbierta(bloque);

    const [inscripcionExistente] = await connection.query(
      `
        SELECT id
        FROM reserva
        WHERE sorteo_id = ?
          AND usuario_id = ?
          AND modalidad = 'SORTEO'
          AND COALESCE(estado_reserva_id, ?) <> ?
        LIMIT 1
        FOR UPDATE
      `,
      [sorteoId, cabecera.id, ESTADO_RESERVA_INICIADA_ID, ESTADO_RESERVA_CANCELADA_ID]
    );

    if (inscripcionExistente.length > 0) {
      await connection.rollback();
      return res.status(409).json({ message: "Ya tenes una inscripcion para este sorteo", codigo: "UN_TIRO" });
    }

    const cotizacion = await cotizarBloqueComun(connection, {
      bloque,
      regimenId,
      personas,
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
        cabecera.id,
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

    const usuariosIds = await obtenerOCrearUsuariosPersonasReserva(connection, personas, cabecera, req);
    const reservasFamiliaresIds = [];
    for (let index = 0; index < usuariosIds.length; index++) {
      const persona = usuariosIds[index];
      const personaCotizada = cotizacion.personas[index] || {};
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
          personaCotizada.tarifa_individual || persona.tarifa_individual || 0
        ]
      );

      reservasFamiliaresIds.push({
        reserva_familiar_id: reservaFamiliarResult.insertId,
        tipo_persona_id: persona.tipo_persona_id,
        edad: persona.edad
      });
    }

    await insertarTarifasFamiliaresReserva(
      connection,
      reservasFamiliaresIds,
      cotizacion.recurso_referencia_id,
      regimenId,
      cotizacion.fecha_inicio,
      cotizacion.fecha_fin,
      cotizacion.temporada_tarifa_id || null
    );

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
      monto_adicionales: cotizacion.monto_adicionales
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.log(error);
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
      `SELECT * FROM reserva WHERE id = ? AND modalidad = 'SORTEO' FOR UPDATE`,
      [reservaId]
    );
    if (reservas.length === 0) {
      await connection.rollback();
      return res.status(404).json("Inscripcion no encontrada");
    }

    const reserva = reservas[0];
    const bloque = await obtenerBloqueConRecursos(connection, reserva.bloque_fecha_id, { forUpdate: true });
    const recursoBloque = bloque.recursos.find((recurso) => Number(recurso.recurso_id) === recursoId);
    if (!recursoBloque || !ESTADOS_RECURSO_SORTEO_DISPONIBLES.has(recursoBloque.estado)) {
      await connection.rollback();
      return res.status(409).json("El recurso no esta disponible para adjudicar");
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
    await connection.query(
      `UPDATE bloque_fecha_recurso
       SET estado = 'ASIGNADO', reserva_id = ?
       WHERE bloque_fecha_id = ? AND recurso_id = ?`,
      [reservaId, bloque.id, recursoId]
    );

    await registrarHistorialReserva(
      connection,
      reservaId,
      "UPDATE",
      cabecera.id,
      req,
      [{ campo: "recurso_id", valorAnterior: null, valorNuevo: recursoId }],
      "Adjudicacion manual de sorteo"
    );

    await connection.commit();
    res.status(200).json({ message: "Inscripcion adjudicada correctamente" });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.log(error);
    res.status(500).json("Error al adjudicar inscripcion");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.put("/admin/sorteos/inscripciones/:id/no-adjudicada", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol !== "admin") {
      return res.status(401).json("No autorizado");
    }

    const reservaId = normalizarIdPositivo(req.params.id);
    if (!reservaId) {
      return res.status(400).json("ID invalido");
    }

    const db = mysqlConnection.promise();
    const estadoNoAdjudicadaId = await obtenerEstadoReservaId(db, "No adjudicada", ESTADO_RESERVA_RECHAZADA_ID);
    await db.query(
      `UPDATE reserva SET estado_reserva_id = ?, observaciones = COALESCE(?, observaciones) WHERE id = ? AND modalidad = 'SORTEO'`,
      [estadoNoAdjudicadaId, req.body.observaciones || null, reservaId]
    );
    res.status(200).json({ message: "Inscripcion marcada como no adjudicada" });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al marcar inscripcion");
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
    console.log(error);
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
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const {
        fecha_inicio,
        fecha_fin,
        servicio_id,
        personas,
        recurso_id,
        filtros,
        precio_minimo,
        precio_maximo,
        orden_id,
        modalidad,
        bloque_fecha_id
      } = req.body;

      if (!fecha_inicio || !fecha_fin || !servicio_id || !personas || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const db = mysqlConnection.promise();
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
          return res.status(409).json("No hay recursos disponibles para este bloque");
        }

        recursosPermitidosBloqueSet = new Set(recursosDisponiblesBloque.map((recurso) => Number(recurso.recurso_id)));
        temporadaTarifaIdFiltro = bloqueSeleccionado.temporada_tarifa_id || null;
      }

      // Primero obtenemos solo los recursos que tienen tarifas válidas para el servicio y las personas
      const recursosConTarifas = [];

      // Para cada persona, buscamos qué recursos tienen tarifas válidas
      const recursosValidos = new Set();

      for (const persona of personas) {
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
            servicio_id,
            persona.tipo_persona_id,
            persona.regimen_id,
            persona.edad,
            persona.edad,
            fecha_fin,
            fecha_inicio,
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

      if (recurso_id) {
        if (recursosValidos.has(Number(recurso_id)) || recursosValidos.has(recurso_id)) {
          // Mantener solo el recurso especificado
          recursosValidos.clear();
          recursosValidos.add(Number(recurso_id));
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

            // Obtener información del filtro para este recurso
            const [filtroRecurso] = await mysqlConnection
              .promise()
              .query(`
                      SELECT cantidad, habilitado
                      FROM filtro_recurso
                      WHERE recurso_id = ? AND filtro_id = ?
                    `, [recursoId, parseInt(filtroId)]);

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
        if (recursosOcupadosSet.has(Number(recurso.id))) {
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

        let tarifaTotal = 0;
        let tarifaOriginalTotal = 0;
        let usaPorcentajeEnAlgunaTarifa = false;
        let todasPersonasTienenTarifa = true;

        // Calcular tarifa por cada persona
        for (const persona of personas) {
          // Buscar todas las tarifas que apliquen para esta persona en este recurso
          const filtroTemporada = temporadaTarifaIdFiltro ? "AND temporada_tarifa_id = ?" : "";
          const [tarifasPersona] = await mysqlConnection
            .promise()
            .query(`
              SELECT precio, fecha_inicio, fecha_fin, usa_porcentaje, porcentaje_descuento
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
            `, [
              recurso.id,
              persona.tipo_persona_id,
              persona.regimen_id,
              persona.edad,
              persona.edad,
              fecha_fin,
              fecha_inicio,
              ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])
            ]);

          if (tarifasPersona.length === 0) {
            todasPersonasTienenTarifa = false;
            break;
          }

          // Calcular el precio total para esta persona sumando los rangos de fechas
          let tarifaPersona = 0;
          let tarifaOriginalPersona = 0;
          const fechaInicioSolicitud = new Date(fecha_inicio);
          const fechaFinSolicitud = new Date(fecha_fin);

          // Calcular días correctamente: NO incluir el día de salida
          const diasTotales = Math.ceil((fechaFinSolicitud - fechaInicioSolicitud) / (1000 * 60 * 60 * 24));

          // Crear un array para marcar qué días están cubiertos por tarifas
          const diasCubiertos = new Array(diasTotales).fill(false);

          for (const tarifa of tarifasPersona) {
            const fechaInicioTarifa = new Date(tarifa.fecha_inicio);
            const fechaFinTarifa = new Date(tarifa.fecha_fin);

            // Calcular la intersección entre el rango solicitado y el rango de la tarifa
            const inicioInterseccion = new Date(Math.max(fechaInicioSolicitud.getTime(), fechaInicioTarifa.getTime()));
            const finInterseccion = new Date(Math.min(fechaFinSolicitud.getTime(), fechaFinTarifa.getTime()));

            if (inicioInterseccion < finInterseccion) {
              // Calcular los días de intersección correctamente
              const diasInterseccion = Math.ceil((finInterseccion - inicioInterseccion) / (1000 * 60 * 60 * 24));

              // Calcular el día inicial relativo al inicio de la solicitud
              const diaInicioRelativo = Math.floor((inicioInterseccion - fechaInicioSolicitud) / (1000 * 60 * 60 * 24));

              // Calcular precio original
              let precioOriginal = tarifa.precio;
              const usaPorcentaje = tarifa.usa_porcentaje === 1 || tarifa.usa_porcentaje === true || tarifa.usa_porcentaje === '1';
              
              if (usaPorcentaje) {
                usaPorcentajeEnAlgunaTarifa = true;
                if (tarifa.porcentaje_descuento && tarifa.porcentaje_descuento > 0) {
                  const factor = 1 - (tarifa.porcentaje_descuento / 100);
                  if (factor > 0) {
                    precioOriginal = tarifa.precio / factor;
                  }
                }
              }

              // Marcar los días como cubiertos y sumar el precio
              for (let i = 0; i < diasInterseccion; i++) {
                const diaIndex = diaInicioRelativo + i;
                if (diaIndex >= 0 && diaIndex < diasTotales && !diasCubiertos[diaIndex]) {
                  diasCubiertos[diaIndex] = true;
                  tarifaPersona += tarifa.precio;
                  tarifaOriginalPersona += precioOriginal;
                }
              }
            }
          }

          // Verificar que todos los días estén cubiertos por alguna tarifa
          const todosDiasCubiertos = diasCubiertos.every(dia => dia === true);
          if (!todosDiasCubiertos) {
            todasPersonasTienenTarifa = false;
            break;
          }

          tarifaTotal += tarifaPersona;
          tarifaOriginalTotal += tarifaOriginalPersona;
        }

        // Solo incluir recursos que tengan tarifa para todas las personas y todos los días
        if (todasPersonasTienenTarifa) {
          // Aplicar filtro de precio si se especifica
          let cumpleFiltroPrecios = true;

          if (precio_minimo !== undefined && precio_minimo !== null && tarifaTotal < precio_minimo) {
            cumpleFiltroPrecios = false;
          }

          if (precio_maximo !== undefined && precio_maximo !== null && tarifaTotal > precio_maximo) {
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
              tarifa_original: usaPorcentajeEnAlgunaTarifa ? Math.round(tarifaOriginalTotal) : null,
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
    console.log(error);
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

      const { fecha_inicio, fecha_fin, servicio_id, personas, recurso_id, filtros, modalidad, bloque_fecha_id } = req.body;

      if (!fecha_inicio || !fecha_fin || !servicio_id || !personas || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      // Primero obtenemos solo los recursos que tienen tarifas válidas para el servicio y las personas
      const db = mysqlConnection.promise();
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
      for (const persona of personas) {
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
            servicio_id,
            persona.tipo_persona_id,
            persona.regimen_id,
            persona.edad,
            persona.edad,
            fecha_fin,
            fecha_inicio,
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
      if (recurso_id) {
        if (recursosValidos.has(recurso_id)) {
          recursosAConsiderar = [recurso_id];
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
        let tarifaTotal = 0;
        let todasPersonasTienenTarifa = true;

        // Calcular tarifa por cada persona
        for (const persona of personas) {
          // Buscar todas las tarifas que apliquen para esta persona en este recurso
          const filtroTemporada = temporadaTarifaIdFiltro ? "AND temporada_tarifa_id = ?" : "";
          const [tarifasPersona] = await mysqlConnection
            .promise()
            .query(`
              SELECT precio, fecha_inicio, fecha_fin
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
            `, [
              recurso.id,
              persona.tipo_persona_id,
              persona.regimen_id,
              persona.edad,
              persona.edad,
              fecha_fin,
              fecha_inicio,
              ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])
            ]);

          if (tarifasPersona.length === 0) {
            todasPersonasTienenTarifa = false;
            break;
          }

          // Calcular el precio total para esta persona sumando los rangos de fechas
          let tarifaPersona = 0;
          const fechaInicioSolicitud = new Date(fecha_inicio);
          const fechaFinSolicitud = new Date(fecha_fin);

          // Calcular días correctamente: NO incluir el día de salida
          const diasTotales = Math.ceil((fechaFinSolicitud - fechaInicioSolicitud) / (1000 * 60 * 60 * 24));

          // Crear un array para marcar qué días están cubiertos por tarifas
          const diasCubiertos = new Array(diasTotales).fill(false);

          for (const tarifa of tarifasPersona) {
            const fechaInicioTarifa = new Date(tarifa.fecha_inicio);
            const fechaFinTarifa = new Date(tarifa.fecha_fin);

            // Calcular la intersección entre el rango solicitado y el rango de la tarifa
            const inicioInterseccion = new Date(Math.max(fechaInicioSolicitud.getTime(), fechaInicioTarifa.getTime()));
            const finInterseccion = new Date(Math.min(fechaFinSolicitud.getTime(), fechaFinTarifa.getTime()));

            if (inicioInterseccion < finInterseccion) {
              // Calcular los días de intersección correctamente
              const diasInterseccion = Math.ceil((finInterseccion - inicioInterseccion) / (1000 * 60 * 60 * 24));

              // Calcular el día inicial relativo al inicio de la solicitud
              const diaInicioRelativo = Math.floor((inicioInterseccion - fechaInicioSolicitud) / (1000 * 60 * 60 * 24));

              // Marcar los días como cubiertos y sumar el precio
              for (let i = 0; i < diasInterseccion; i++) {
                const diaIndex = diaInicioRelativo + i;
                if (diaIndex >= 0 && diaIndex < diasTotales && !diasCubiertos[diaIndex]) {
                  diasCubiertos[diaIndex] = true;
                  tarifaPersona += tarifa.precio;
                }
              }
            }
          }

          // Verificar que todos los días estén cubiertos por alguna tarifa
          const todosDiasCubiertos = diasCubiertos.every(dia => dia === true);
          if (!todosDiasCubiertos) {
            todasPersonasTienenTarifa = false;
            break;
          }

          tarifaTotal += tarifaPersona;
        }

        // Solo incluir recursos que tengan tarifa para todas las personas y todos los días
        if (todasPersonasTienenTarifa) {
          precios.push(tarifaTotal);
        }
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
    console.log(error);
    res.status(500).json("Error al obtener los filtros para recursos");
  }
});

router.post("/reserva/tarifa/fechas", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const {
        fecha_inicio,
        fecha_fin,
        servicio_id,
        recurso_id,
        personas,
        regimen_id,
        adicionales,
        modalidad,
        bloque_fecha_id
      } = req.body;

      if (!fecha_inicio || !fecha_fin || !servicio_id || !recurso_id || !personas || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const fechaInicioSolicitud = new Date(fecha_inicio);
      const fechaFinSolicitud = new Date(fecha_fin);

      // Calcular días correctamente: INCLUIR el día de salida (fecha_fin)
      const diasTotales = Math.ceil((fechaFinSolicitud - fechaInicioSolicitud) / (1000 * 60 * 60 * 24)) + 1;

      if (diasTotales <= 0) {
        return res.status(400).json("El rango de fechas no es válido");
      }

      const pool = mysqlConnection.promise();
      const regimenIdSolicitud = regimen_id || (Array.isArray(personas) && personas.length > 0 ? personas[0].regimen_id : null);
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

      const adicionalesSeleccionados = Array.isArray(adicionales)
        ? adicionales
            .map(adicional => ({
              adicional_id: adicional.adicional_id,
              cantidad: Number(adicional.cantidad)
            }))
            .filter(adicional => adicional.adicional_id && adicional.cantidad > 0)
        : [];

      if (adicionalesSeleccionados.length > 0 && !regimenIdSolicitud) {
        return res.status(400).json("Se requiere el régimen para calcular los adicionales");
      }

      const cacheAdicionales = new Map();

      // Array para almacenar el resultado
      const fechasConTarifa = [];

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

        // Procesar cada día del rango
      for (let dia = 0; dia < diasTotales; dia++) {
        const fechaActual = new Date(fechaInicioSolicitud);
        fechaActual.setDate(fechaInicioSolicitud.getDate() + dia);

        const fechaString = fechaActual.toISOString().split('T')[0];
        let precioBaseDia = 0;
        let precioBaseSinDescuentoDia = 0;
        let usaPorcentajeDia = false;
        let porcentajeDescuentoDia = null;
        let todasPersonasTienenTarifa = true;

        // Calcular tarifa por cada persona para este día específico
        for (const persona of personas) {
          // Buscar tarifa válida para esta persona en este día específico
          const filtroTemporada = temporadaTarifaIdFiltro ? "AND temporada_tarifa_id = ?" : "";
          const [tarifasPersona] = await pool.query(
            `
              SELECT precio, usa_porcentaje, porcentaje_descuento
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
              LIMIT 1
            `,
            [
              recurso_id,
              persona.tipo_persona_id,
              persona.regimen_id,
              persona.edad,
              persona.edad,
              fechaString,
              fechaString,
              ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])
            ]
          );

          if (tarifasPersona.length === 0) {
            // No hay tarifa válida para esta persona en este día
            todasPersonasTienenTarifa = false;
            break;
          }

          const tarifa = tarifasPersona[0];
          precioBaseDia += tarifa.precio;

          // Calcular precio base sin descuento y capturar datos de porcentaje
          let precioBasePersona = tarifa.precio;
          
          // Normalizar usa_porcentaje (puede venir como 1/0 o true/false)
          const usaPorcentaje = tarifa.usa_porcentaje === 1 || tarifa.usa_porcentaje === true || tarifa.usa_porcentaje === '1';
          
          if (usaPorcentaje) {
            usaPorcentajeDia = true;
            // Si hay múltiples personas, nos quedamos con el último porcentaje encontrado (o el primero)
            // Idealmente deberían ser consistentes si es una reserva grupal con descuento
            porcentajeDescuentoDia = tarifa.porcentaje_descuento;

            if (tarifa.porcentaje_descuento && tarifa.porcentaje_descuento > 0) {
              // Revertir el descuento para obtener el precio base
              // precio = base * (1 - descuento/100)
              // base = precio / (1 - descuento/100)
              const factor = 1 - (tarifa.porcentaje_descuento / 100);
              if (factor > 0) {
                precioBasePersona = tarifa.precio / factor;
              }
            }
          }
          
          precioBaseSinDescuentoDia += precioBasePersona;
        }

        let totalExtrasDia = 0;
        const extrasDia = [];

        if (todasPersonasTienenTarifa && adicionalesSeleccionados.length > 0 && regimenIdSolicitud) {
          for (const adicional of adicionalesSeleccionados) {
            const resultadoAdicional = await obtenerPrecioAdicional(
              pool,
              cacheAdicionales,
              recurso_id,
              regimenIdSolicitud,
              adicional.adicional_id,
              fechaString,
              temporadaTarifaIdFiltro
            );

            if (resultadoAdicional === null) {
              continue;
            }

            const subtotalExtra = resultadoAdicional.precio * adicional.cantidad;
            totalExtrasDia += subtotalExtra;
            extrasDia.push({
              adicional_id: adicional.adicional_id,
              cantidad: adicional.cantidad,
              precio_unitario: resultadoAdicional.precio,
              subtotal: subtotalExtra
            });
          }
        }

        const respuestaDia = {
          fecha: fechaString,
          precio: todasPersonasTienenTarifa ? precioBaseDia + totalExtrasDia : null,
          precio_base: todasPersonasTienenTarifa ? Math.round(precioBaseSinDescuentoDia + totalExtrasDia) : null,
          usa_porcentaje: usaPorcentajeDia,
          porcentaje_descuento: usaPorcentajeDia ? porcentajeDescuentoDia : 0
        };

        if (extrasDia.length > 0) {
          respuestaDia.extras = extrasDia;
        }

        fechasConTarifa.push(respuestaDia);
      }

      res.status(200).json(fechasConTarifa);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las tarifas por fecha");
  }
});

router.post("/reserva/adicionales", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const { recurso_id, regimen_id, fecha_inicio, fecha_fin, modalidad, bloque_fecha_id } = req.body;

      if (!recurso_id || !regimen_id || !fecha_inicio || !fecha_fin) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      let temporadaTarifaIdFiltro = null;
      if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
        const bloqueSeleccionado = await obtenerBloqueConRecursos(mysqlConnection.promise(), bloqueFechaIdSolicitado);
        const recursoBloque = (bloqueSeleccionado.recursos || []).find((recurso) => Number(recurso.recurso_id) === Number(recurso_id));
        if (!recursoBloque || !rangoCoincideConBloque(fecha_inicio, fecha_fin, bloqueSeleccionado)) {
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
          [recurso_id, regimen_id, fecha_fin, fecha_inicio, ...(temporadaTarifaIdFiltro ? [temporadaTarifaIdFiltro] : [])]
        );

        res.status(200).json(adicionales);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
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

// Función auxiliar para registrar cambios en el historial de reservas
async function registrarHistorialReserva(connection, reservaId, tipoOperacion, usuarioModificadorId, req, campos = null, observaciones = null) {
  try {
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
  } catch (error) {
    console.error('Error al registrar historial de reserva:', error);
  }
}

const DIA_EN_MS = 1000 * 60 * 60 * 24;
const SERVICIO_CAMPING_ID = 4;
const RECURSO_CAMPING_ID = 1;
const MAX_PERSONAS_CAMPING = 6;
const ESTADO_RESERVA_CANCELADA_ID = 4;
const ESTADO_RESERVA_INICIADA_ID = 1;
const ESTADO_RESERVA_RECHAZADA_ID = 4;
const MODALIDAD_FECHA_LIBRE = "FECHA_LIBRE";
const MODALIDAD_BLOQUE = "BLOQUE";
const MODALIDAD_SORTEO = "SORTEO";
const ESTADOS_RECURSO_BLOQUE_RESERVABLES = new Set(["DISPONIBLE", "VENTA_DIRECTA"]);
const ESTADOS_RECURSO_SORTEO_DISPONIBLES = new Set(["DISPONIBLE", "SORTEO"]);
const ESTADOS_RESERVA_NO_OCUPAN = new Set([ESTADO_RESERVA_CANCELADA_ID, ESTADO_RESERVA_RECHAZADA_ID]);

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
    return fecha.slice(0, 10);
  }
  return new Date(fecha).toISOString().split("T")[0];
}

function fechasSonIguales(fechaA, fechaB) {
  return formatearFechaSQL(fechaA) === formatearFechaSQL(fechaB);
}

function rangosSolapan(fechaInicioA, fechaFinA, fechaInicioB, fechaFinB) {
  return formatearFechaSQL(fechaInicioA) < formatearFechaSQL(fechaFinB) &&
    formatearFechaSQL(fechaFinA) > formatearFechaSQL(fechaInicioB);
}

function rangosSolapanInclusivo(fechaInicioA, fechaFinA, fechaInicioB, fechaFinB) {
  return formatearFechaSQL(fechaInicioA) <= formatearFechaSQL(fechaFinB) &&
    formatearFechaSQL(fechaFinA) >= formatearFechaSQL(fechaInicioB);
}

function rangoCoincideConBloque(fechaInicio, fechaFin, bloque) {
  return fechasSonIguales(fechaInicio, bloque.fecha_inicio) && fechasSonIguales(fechaFin, bloque.fecha_fin);
}

function normalizarIdPositivo(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function normalizarModalidad(valor) {
  const modalidad = String(valor || MODALIDAD_FECHA_LIBRE).toUpperCase();
  if ([MODALIDAD_FECHA_LIBRE, MODALIDAD_BLOQUE, MODALIDAD_SORTEO].includes(modalidad)) {
    return modalidad;
  }
  return MODALIDAD_FECHA_LIBRE;
}

function fechaSqlAIndice(fecha) {
  const fechaSql = formatearFechaSQL(fecha);
  if (!fechaSql || !/^\d{4}-\d{2}-\d{2}$/.test(fechaSql)) {
    return null;
  }

  const [anio, mes, dia] = fechaSql.split("-").map(Number);
  return Math.floor(Date.UTC(anio, mes - 1, dia) / DIA_EN_MS);
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
        SET bfr.estado = 'LIBERADO', bfr.reserva_id = NULL
        WHERE bf.estado = 'ACTIVO'
          AND bf.fecha_inicio <= CURDATE()
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
          AND bf.fecha_inicio <= CURDATE()
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

function normalizarPersonasParaCotizacion(personas, regimenId) {
  if (!Array.isArray(personas) || personas.length === 0) {
    throw crearErrorNegocio("Debe indicar al menos una persona", 400);
  }

  return personas.map((persona) => ({
    ...persona,
    tipo_persona_id: normalizarIdPositivo(persona.tipo_persona_id ?? persona.tipo),
    regimen_id: normalizarIdPositivo(persona.regimen_id ?? regimenId),
    edad: Number(persona.edad)
  }));
}

async function calcularTarifaBaseReserva(connection, { recursoId, regimenId, personas, fechaInicio, fechaFin, temporadaTarifaId = null }) {
  const fechaInicioDate = new Date(fechaInicio);
  const fechaFinDate = new Date(fechaFin);
  const diasTotales = Math.ceil((fechaFinDate - fechaInicioDate) / DIA_EN_MS);

  if (!Number.isFinite(diasTotales) || diasTotales <= 0) {
    throw crearErrorNegocio("El rango de fechas no es valido", 400);
  }

  const personasNormalizadas = normalizarPersonasParaCotizacion(personas, regimenId);
  let total = 0;
  let totalOriginal = 0;
  const personasResultado = [];

  for (const persona of personasNormalizadas) {
    if (!persona.tipo_persona_id || !persona.regimen_id || !Number.isFinite(persona.edad)) {
      throw crearErrorNegocio("Los datos de las personas no son validos", 400);
    }

    const filtroTemporada = temporadaTarifaId ? "AND temporada_tarifa_id = ?" : "";
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
        recursoId,
        persona.tipo_persona_id,
        persona.regimen_id,
        persona.edad,
        persona.edad,
        fechaFin,
        fechaInicio,
        ...(temporadaTarifaId ? [temporadaTarifaId] : [])
      ]
    );

    if (tarifasPersona.length === 0) {
      throw crearErrorNegocio("No hay tarifas para todas las personas del bloque", 409, "TARIFA_INCOMPLETA");
    }

    const diasCubiertos = new Array(diasTotales).fill(false);
    const tarifasPorFecha = [];
    let totalPersona = 0;
    let totalOriginalPersona = 0;

    for (const tarifa of tarifasPersona) {
      const fechaInicioTarifa = new Date(tarifa.fecha_inicio);
      const fechaFinTarifa = new Date(tarifa.fecha_fin);
      const inicioInterseccion = new Date(Math.max(fechaInicioDate.getTime(), fechaInicioTarifa.getTime()));
      const finInterseccion = new Date(Math.min(fechaFinDate.getTime(), fechaFinTarifa.getTime()));

      if (inicioInterseccion >= finInterseccion) {
        continue;
      }

      const diasInterseccion = Math.ceil((finInterseccion - inicioInterseccion) / DIA_EN_MS);
      const diaInicioRelativo = Math.floor((inicioInterseccion - fechaInicioDate) / DIA_EN_MS);
      let precioOriginal = Number(tarifa.precio);
      const usaPorcentaje = tarifa.usa_porcentaje === 1 || tarifa.usa_porcentaje === true || tarifa.usa_porcentaje === "1";
      const porcentajeDescuento = tarifa.porcentaje_descuento !== null && tarifa.porcentaje_descuento !== undefined
        ? Number(tarifa.porcentaje_descuento)
        : 0;

      if (usaPorcentaje && porcentajeDescuento > 0) {
        const factor = 1 - porcentajeDescuento / 100;
        if (factor > 0) {
          precioOriginal = Number(tarifa.precio) / factor;
        }
      }

      for (let i = 0; i < diasInterseccion; i++) {
        const diaIndex = diaInicioRelativo + i;
        if (diaIndex < 0 || diaIndex >= diasTotales || diasCubiertos[diaIndex]) {
          continue;
        }

        const fechaActual = new Date(fechaInicioDate);
        fechaActual.setDate(fechaInicioDate.getDate() + diaIndex);
        const fechaString = fechaActual.toISOString().split("T")[0];

        diasCubiertos[diaIndex] = true;
        const precio = Number(tarifa.precio);
        totalPersona += precio;
        totalOriginalPersona += precioOriginal;
        tarifasPorFecha.push({
          fecha: fechaString,
          precio,
          precio_original: precioOriginal,
          tarifa_id: tarifa.id,
          usa_porcentaje: usaPorcentaje,
          porcentaje_descuento: porcentajeDescuento
        });
      }
    }

    if (!diasCubiertos.every(Boolean)) {
      throw crearErrorNegocio("No hay tarifas para todas las noches del bloque", 409, "TARIFA_INCOMPLETA");
    }

    total += totalPersona;
    totalOriginal += totalOriginalPersona;
    personasResultado.push({
      ...persona,
      tarifa_individual: totalPersona,
      tarifa_original_individual: totalOriginalPersona,
      tarifas_por_fecha: tarifasPorFecha.sort((a, b) => a.fecha.localeCompare(b.fecha))
    });
  }

  return {
    total,
    total_original: totalOriginal,
    personas: personasResultado
  };
}

async function insertarTarifasFamiliaresReserva(connection, reservasFamiliaresIds, recursoId, regimenId, fechaInicio, fechaFin, temporadaTarifaId = null) {
  const fechaInicioDate = new Date(fechaInicio);
  const fechaFinDate = new Date(fechaFin);
  const diasTotales = Math.ceil((fechaFinDate - fechaInicioDate) / DIA_EN_MS);

  for (const reservaFamiliar of reservasFamiliaresIds) {
    for (let dia = 0; dia < diasTotales; dia++) {
      const fechaActual = new Date(fechaInicioDate);
      fechaActual.setDate(fechaInicioDate.getDate() + dia);
      const fechaString = fechaActual.toISOString().split("T")[0];

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
         ORDER BY fecha_inicio ASC
         LIMIT 1`,
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

      if (tarifas.length > 0) {
        await connection.query(
          `INSERT INTO reserva_familiar_tarifa
            (reserva_familiar_id, tarifa_id, fecha)
           VALUES (?, ?, ?)`,
          [reservaFamiliar.reserva_familiar_id, tarifas[0].id, fechaString]
        );
      }
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

    while (currentUserFamiliarId !== null) {
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
          documento, telefono, email, password, usuario_familiar_id, departamental_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const inicio = new Date(bloque.fecha_inicio_inscripcion);
  const fin = new Date(bloque.fecha_fin_inscripcion);
  inicio.setHours(0, 0, 0, 0);
  fin.setHours(0, 0, 0, 0);

  if (hoy < inicio || hoy > fin) {
    throw crearErrorNegocio("El periodo de inscripcion al sorteo no esta vigente", 409);
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
      personas,
      bloque.temporada_tarifa_id || null
    );

    cotizaciones.push({
      recurso,
      tarifaBase,
      adicionalesProcesados,
      total: tarifaBase.total + adicionalesProcesados.total
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

async function obtenerBloquesDisponiblesPorServicio(connection, { servicioIds = [], servicioId = null, fechaInicio, fechaFin }) {
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
          s.nombre AS sorteo_nombre,
          s.estado AS sorteo_estado,
          COUNT(bfr.id) AS recursos_disponibles
        FROM bloque_fecha bf
        INNER JOIN bloque_fecha_recurso bfr ON bfr.bloque_fecha_id = bf.id
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
              AND CURDATE() BETWEEN s.fecha_inicio_inscripcion AND s.fecha_fin_inscripcion
            )
          )
        GROUP BY bf.id, modalidad_visible, s.id
        HAVING recursos_disponibles > 0
        ORDER BY bf.fecha_inicio ASC, bf.id ASC
      `,
      [...ids, fechaFin, fechaInicio]
    );

    const mapa = new Map();
    rows.forEach((row) => {
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
        fecha_inicio: formatearFechaSQL(row.fecha_inicio),
        fecha_fin: formatearFechaSQL(row.fecha_fin),
        recursos_disponibles: Number(row.recursos_disponibles || 0)
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

function obtenerNochesReserva(fechaInicio, fechaFin) {
  const inicio = new Date(fechaInicio);
  const fin = new Date(fechaFin);

  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime()) || inicio >= fin) {
    return [];
  }

  const noches = [];
  const cursor = new Date(inicio);

  while (cursor < fin) {
    noches.push(cursor.toISOString().split("T")[0]);
    cursor.setDate(cursor.getDate() + 1);
  }

  return noches;
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

async function asignarNumeroParcelaCamping(connection, { recursoId, fechaInicio, fechaFin, reservaIdExcluir = null }) {
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

  const filtroTemporada = temporadaTarifaId ? "AND temporada_tarifa_id = ?" : "";
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
      LIMIT 1
    `,
    [recursoId, regimenId, adicionalId, fecha, fecha, ...(temporadaTarifaId ? [temporadaTarifaId] : [])]
  );

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
  let maxDescuento = 0;
  let tarifaIdMax = null;

  for (const persona of personas) {
    if (!persona.tipo_persona_id || persona.edad === undefined) continue;

    const filtroTemporada = temporadaTarifaId ? "AND temporada_tarifa_id = ?" : "";
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
       ORDER BY fecha_inicio ASC
       LIMIT 1`,
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

    if (rows.length > 0) {
      const tarifa = rows[0];
      if (tarifa.usa_porcentaje === 1 && tarifa.porcentaje_descuento > maxDescuento) {
        maxDescuento = tarifa.porcentaje_descuento;
        tarifaIdMax = tarifa.id;
      }
    }
  }
  
  return { porcentaje_descuento: maxDescuento, tarifa_id: tarifaIdMax };
}

async function calcularAdicionalesReserva(connection, adicionales, recursoId, regimenId, fechaInicio, fechaFin, personas, temporadaTarifaId = null) {
  if (!Array.isArray(adicionales) || adicionales.length === 0) {
    return { total: 0, items: [] };
  }

  const fechaInicioDate = new Date(fechaInicio);
  const fechaFinDate = new Date(fechaFin);
  const diasTotales = Math.ceil((fechaFinDate - fechaInicioDate) / DIA_EN_MS);

  if (diasTotales <= 0) {
    return { total: 0, items: [] };
  }

  const cachePrecios = new Map();
  const cacheNombres = new Map();
  const items = [];
  let total = 0;

  // Pre-calcular descuentos por día si hay personas
  const descuentosPorDia = new Map();
  if (Array.isArray(personas) && personas.length > 0) {
    for (let dia = 0; dia < diasTotales; dia++) {
      const fechaActual = new Date(fechaInicioDate);
      fechaActual.setDate(fechaInicioDate.getDate() + dia);
      const fechaString = fechaActual.toISOString().split('T')[0];
      
      const descuento = await obtenerMejorDescuentoDia(connection, recursoId, regimenId, personas, fechaString, temporadaTarifaId);
      descuentosPorDia.set(fechaString, descuento);
    }
  }

  for (const adicional of adicionales) {
    if (!adicional) {
      continue;
    }

    const adicionalId = adicional.adicional_id || adicional.adicionalId;
    const cantidad = Number(adicional.cantidad);

    if (!adicionalId || !cantidad || cantidad <= 0) {
      continue;
    }

    const nombreAdicional = await obtenerNombreAdicional(connection, cacheNombres, adicionalId);
    const detalles = [];
    let subtotal = 0;

    for (let dia = 0; dia < diasTotales; dia++) {
      const fechaActual = new Date(fechaInicioDate);
      fechaActual.setDate(fechaInicioDate.getDate() + dia);
      const fechaString = fechaActual.toISOString().split('T')[0];

      const resultadoAdicional = await obtenerPrecioAdicional(connection, cachePrecios, recursoId, regimenId, adicionalId, fechaString, temporadaTarifaId);

      if (resultadoAdicional === null) {
        throw new Error(`No hay una tarifa de adicional vigente para la fecha ${fechaString}`);
      }

      let precioUnitario = resultadoAdicional.precio;
      const descuentoInfo = descuentosPorDia.get(fechaString) || { porcentaje_descuento: 0, tarifa_id: null };

      if (descuentoInfo.porcentaje_descuento > 0) {
        precioUnitario = precioUnitario * (1 - descuentoInfo.porcentaje_descuento / 100);
      }

      const subtotalDia = precioUnitario * cantidad;
      subtotal += subtotalDia;
      detalles.push({
        fecha: fechaString,
        cantidad,
        precio_unitario: precioUnitario,
        subtotal: subtotalDia,
        tarifa_adicional_id: resultadoAdicional.tarifa_adicional_id,
        porcentaje_descuento: descuentoInfo.porcentaje_descuento,
        tarifa_id: descuentoInfo.tarifa_id
      });
    }

    items.push({
      adicional_id: adicionalId,
      nombre_adicional: nombreAdicional,
      cantidad,
      dias: detalles.length,
      precio_referencia: detalles.length > 0 ? detalles[0].precio_unitario : 0,
      subtotal,
      detalles
    });

    total += subtotal;
  }

  return { total, items };
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

router.post("/reserva", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "departamental" ||
      cabecera.rol === "afiliado"
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
        bloque_fecha_id
      } = req.body;

      // Validar campos requeridos
      if (!nombre || !fecha_inicio || !fecha_fin || !servicio_id || !recurso_id ||
        !regimen_id || !personas || personas.length === 0 || !total_tarifa) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const totalTarifaBase = Number(total_tarifa);
      if (Number.isNaN(totalTarifaBase)) {
        return res.status(400).json("El total de la tarifa no es válido");
      }

      const esReservaCamping = esServicioCamping(servicio_id);
      const errorReglasCamping = validarReglasCampingReserva(servicio_id, recurso_id, personas);
      if (errorReglasCamping) {
        return res.status(422).json(errorReglasCamping);
      }

      const modalidadSolicitada = normalizarModalidad(modalidad);
      const bloqueFechaIdSolicitado = normalizarIdPositivo(bloque_fecha_id);
      let modalidadReserva = MODALIDAD_FECHA_LIBRE;
      let bloqueFechaIdReserva = null;

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        try {
          const bloquesPorRecurso = await obtenerBloquesActivosParaRecursos(connection, {
            recursoIds: [Number(recurso_id)],
            fechaInicio: fecha_inicio,
            fechaFin: fecha_fin
          });
          const bloquesActivos = bloquesPorRecurso.get(Number(recurso_id)) || [];
          const bloqueExacto = bloquesActivos.find((bloque) => rangoCoincideConBloque(fecha_inicio, fecha_fin, bloque));
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
            }
          } else if (modalidadSolicitada === MODALIDAD_BLOQUE && bloqueFechaIdSolicitado) {
            const bloque = await obtenerBloqueConRecursos(connection, bloqueFechaIdSolicitado, { forUpdate: true });
            const recursoBloque = bloque.recursos.find((recurso) => Number(recurso.recurso_id) === Number(recurso_id));
            if (!recursoBloque || !ESTADOS_RECURSO_BLOQUE_RESERVABLES.has(recursoBloque.estado) || !rangoCoincideConBloque(fecha_inicio, fecha_fin, bloque)) {
              await connection.rollback();
              return res.status(409).json("El bloque seleccionado no esta disponible para ese recurso y fechas");
            }
            modalidadReserva = MODALIDAD_BLOQUE;
            bloqueFechaIdReserva = bloque.id;
          }
        } catch (bloqueError) {
          if (!esErrorTemporadaAltaNoMigrada(bloqueError)) {
            await connection.rollback();
            throw bloqueError;
          }
        }

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

        // Obtener el usuario familiar principal del usuario que crea la reserva
        const [usuarioCreador] = await connection.query(
          "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
          [cabecera.id]
        );

        let usuarioFamiliarPrincipalId = cabecera.id;
        let departamentalId = usuarioCreador[0]?.departamental_id || null;

        if (usuarioCreador.length > 0) {
          let currentUserId = usuarioCreador[0].id;
          let currentUserFamiliarId = usuarioCreador[0].usuario_familiar_id;
          let currentDepartamentalId = usuarioCreador[0].departamental_id;

          while (currentUserFamiliarId !== null) {
            const [nextUser] = await connection.query(
              "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
              [currentUserFamiliarId]
            );

            if (nextUser.length > 0) {
              currentUserId = nextUser[0].id;
              currentUserFamiliarId = nextUser[0].usuario_familiar_id;
              currentDepartamentalId = nextUser[0].departamental_id;
            } else {
              break;
            }
          }

          usuarioFamiliarPrincipalId = currentUserId;
          // Usar el departamental_id del usuario principal de la familia
          departamentalId = currentDepartamentalId;
        }

        const adicionalesSeleccionados = Array.isArray(adicionales) ? adicionales : [];
        let montoAdicionales = 0;
        let adicionalesProcesados = [];

        if (adicionalesSeleccionados.length > 0) {
          try {
            const resultadoAdicionales = await calcularAdicionalesReserva(
              connection,
              adicionalesSeleccionados,
              recurso_id,
              regimen_id,
              fecha_inicio,
              fecha_fin,
              personas
            );
            montoAdicionales = resultadoAdicionales.total;
            adicionalesProcesados = resultadoAdicionales.items;
          } catch (adicionalError) {
            await connection.rollback();
            return res.status(400).json(adicionalError.message || "No se pudieron calcular los adicionales");
          }
        }

        // Crear o buscar usuarios para cada persona
        const usuariosIds = [];
        for (const persona of personas) {
          const [existeUsuario] = await connection.query(
            "SELECT id FROM usuario WHERE documento = ?",
            [persona.dni]
          );

          let usuarioId;
          if (existeUsuario.length > 0) {
            usuarioId = existeUsuario[0].id;
          } else {
            // Determinar el rol_id basado en tipo_persona_id
            const rolId = persona.tipo_persona_id === 1 ? 2 : 4;

            // Crear nuevo usuario con usuario_familiar_id y departamental_id establecidos
            const [nuevoUsuario] = await connection.query(
              `INSERT INTO usuario (
              rol_id, parentesco_id, tipo_persona_id, nombre, apellido, fecha_nacimiento, 
              documento, telefono, password, usuario_familiar_id, departamental_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
              [
                rolId,
                persona.parentesco_id,
                persona.tipo_persona_id,
                persona.nombre,
                persona.apellido,
                persona.fecha_nacimiento,
                persona.dni,
                persona.telefono || null,
                usuarioFamiliarPrincipalId,
                departamentalId
              ]
            );
            usuarioId = nuevoUsuario.insertId;

            // Registrar creación del usuario en el historial
            await registrarHistorial(
              connection,
              usuarioId,
              'CREATE',
              'usuario',
              cabecera.id,
              req,
              null,
              `Usuario creado durante reserva. Datos: ${persona.nombre} ${persona.apellido}, DNI: ${persona.dni}`
            );
          }
          usuariosIds.push({
            ...persona,
            usuario_id: usuarioId
          });
        }

        // Insertar reserva principal
        const precioTotalReserva = totalTarifaBase + montoAdicionales;

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
            servicio_id,
            regimen_id,
            recurso_id,
            cabecera.id,
            firmaArchivo,
            precioTotalReserva,
            fecha_inicio,
            fecha_fin,
            observaciones || null,
            montoAdicionales
          ]
        );

        const reservaId = reservaResult.insertId;
        let numeroParcelaAsignada = null;

        if (modalidadReserva === MODALIDAD_BLOQUE && bloqueFechaIdReserva) {
          await connection.query(
            `UPDATE bloque_fecha_recurso
             SET estado = 'RESERVADO', reserva_id = ?
             WHERE bloque_fecha_id = ? AND recurso_id = ?`,
            [reservaId, bloqueFechaIdReserva, recurso_id]
          );
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

        // Calcular días del rango de fechas (NO incluir día de salida)
        const fechaInicioDate = new Date(fecha_inicio);
        const fechaFinDate = new Date(fecha_fin);
        const diasTotales = Math.ceil((fechaFinDate - fechaInicioDate) / (1000 * 60 * 60 * 24));

        // Insertar reserva_familiar_tarifa para cada día y cada persona
        for (const reservaFamiliar of reservasFamiliaresIds) {
          for (let dia = 0; dia < diasTotales; dia++) {
            const fechaActual = new Date(fechaInicioDate);
            fechaActual.setDate(fechaInicioDate.getDate() + dia);
            const fechaString = fechaActual.toISOString().split('T')[0];

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
               ORDER BY fecha_inicio ASC
               LIMIT 1`,
              [
                recurso_id,
                reservaFamiliar.tipo_persona_id,
                regimen_id,
                reservaFamiliar.edad,
                reservaFamiliar.edad,
                fechaString,
                fechaString
              ]
            );

            if (tarifas.length > 0) {
              await connection.query(
                `INSERT INTO reserva_familiar_tarifa (
                  reserva_familiar_id, tarifa_id, fecha
                ) VALUES (?, ?, ?)`,
                [
                  reservaFamiliar.reserva_familiar_id,
                  tarifas[0].id,
                  fechaString
                ]
              );
            }
          }
        }

        // Confirmar transacción
        if (esReservaCamping) {
          numeroParcelaAsignada = await asignarNumeroParcelaCamping(connection, {
            recursoId: recurso_id,
            fechaInicio: fecha_inicio,
            fechaFin: fecha_fin
          });

          await connection.query(
            "UPDATE reserva SET numero_parcela = ? WHERE id = ?",
            [numeroParcelaAsignada, reservaId]
          );
        }

        await connection.commit();

        const numeroReserva = `${reservaId}`;

        res.status(201).json({
          id: reservaId,
          numero_reserva: numeroReserva,
          numero_parcela: numeroParcelaAsignada,
          estado: "Confirmada",
          mensaje: "Reserva creada exitosamente",
          fecha_creacion: new Date().toISOString(),
          monto_adicionales: montoAdicionales
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
    console.log(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json(error.message);
    }
    res.status(500).json("Error al procesar la reserva");
  }
});

router.put("/reserva/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" || cabecera.rol === "departamental" || cabecera.rol === "afiliado"
    ) {
      const reservaId = req.params.id;
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
        total_tarifa,
        adicionales
      } = req.body;

      // Validar campos requeridos
      if (!reservaId || !nombre || !fecha_inicio || !fecha_fin || !servicio_id ||
        !recurso_id || !regimen_id || !personas || personas.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Faltan campos requeridos"
        });
      }

      let tarifaBaseDesdeRequest = null;
      if (total_tarifa !== undefined) {
        tarifaBaseDesdeRequest = Number(total_tarifa);
        if (Number.isNaN(tarifaBaseDesdeRequest)) {
          return res.status(400).json({
            success: false,
            message: "El total de la tarifa no es válido"
          });
        }
      }

      const esReservaCamping = esServicioCamping(servicio_id);
      const errorReglasCamping = validarReglasCampingReserva(servicio_id, recurso_id, personas);
      if (errorReglasCamping) {
        return res.status(422).json({
          success: false,
          message: errorReglasCamping
        });
      }

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Verificar que la reserva existe
        const [reservaExistente] = await connection.query(
          "SELECT * FROM reserva WHERE id = ?",
          [reservaId]
        );

        if (reservaExistente.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Reserva no encontrada"
          });
        }

        // Si el rol es afiliado, verificar que la reserva le pertenezca
        if (cabecera.rol === "afiliado" && reservaExistente[0].usuario_id !== cabecera.id) {
          return res.status(403).json({
            success: false,
            message: "No tienes permisos para editar esta reserva"
          });
        }

        const numeroParcelaAnteriorRaw = reservaExistente[0].numero_parcela;
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

        // Obtener el usuario familiar principal del usuario que edita la reserva
        const [usuarioCreador] = await connection.query(
          "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
          [cabecera.id]
        );

        let usuarioFamiliarPrincipalId = cabecera.id;
        let departamentalId = usuarioCreador[0]?.departamental_id || null;

        if (usuarioCreador.length > 0) {
          let currentUserId = usuarioCreador[0].id;
          let currentUserFamiliarId = usuarioCreador[0].usuario_familiar_id;
          let currentDepartamentalId = usuarioCreador[0].departamental_id;

          while (currentUserFamiliarId !== null) {
            const [nextUser] = await connection.query(
              "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
              [currentUserFamiliarId]
            );

            if (nextUser.length > 0) {
              currentUserId = nextUser[0].id;
              currentUserFamiliarId = nextUser[0].usuario_familiar_id;
              currentDepartamentalId = nextUser[0].departamental_id;
            } else {
              break;
            }
          }

          usuarioFamiliarPrincipalId = currentUserId;
          // Usar el departamental_id del usuario principal de la familia
          departamentalId = currentDepartamentalId;
        }

        const adicionalesSeleccionados = Array.isArray(adicionales) ? adicionales : [];
        let montoAdicionales = 0;
        let adicionalesProcesados = [];

        if (adicionalesSeleccionados.length > 0) {
          try {
            const resultadoAdicionales = await calcularAdicionalesReserva(
              connection,
              adicionalesSeleccionados,
              recurso_id,
              regimen_id,
              fecha_inicio,
              fecha_fin,
              personas
            );
            montoAdicionales = resultadoAdicionales.total;
            adicionalesProcesados = resultadoAdicionales.items;
          } catch (adicionalError) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: adicionalError.message || "No se pudieron calcular los adicionales"
            });
          }
        }

        // Calcular tarifa total
        let tarifaTotal = 0;
        for (const persona of personas) {
          if (persona.tarifa_individual) {
            tarifaTotal += persona.tarifa_individual;
          }
        }

        const tarifaBase = tarifaBaseDesdeRequest !== null ? tarifaBaseDesdeRequest : tarifaTotal;
        const precioTotalReserva = tarifaBase + montoAdicionales;

        // Detectar cambios en la reserva
        const datosAnteriores = reservaExistente[0];
        const cambiosReserva = [];

        // Función auxiliar para formatear fechas para comparación
        const formatDate = (date) => {
            if (!date) return null;
            try {
                const d = new Date(date);
                if (isNaN(d.getTime())) return null;
                return d.toISOString().split('T')[0];
            } catch (e) { return null; }
        };

        if (datosAnteriores.regimen_id !== regimen_id) {
            cambiosReserva.push({ campo: 'regimen_id', valorAnterior: datosAnteriores.regimen_id, valorNuevo: regimen_id });
        }
        if (datosAnteriores.recurso_id !== recurso_id) {
            cambiosReserva.push({ campo: 'recurso_id', valorAnterior: datosAnteriores.recurso_id, valorNuevo: recurso_id });
        }
        if (formatDate(datosAnteriores.fecha_inicio) !== formatDate(fecha_inicio)) {
            cambiosReserva.push({ campo: 'fecha_inicio', valorAnterior: formatDate(datosAnteriores.fecha_inicio), valorNuevo: formatDate(fecha_inicio) });
        }
        if (formatDate(datosAnteriores.fecha_fin) !== formatDate(fecha_fin)) {
            cambiosReserva.push({ campo: 'fecha_fin', valorAnterior: formatDate(datosAnteriores.fecha_fin), valorNuevo: formatDate(fecha_fin) });
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

        if (cambiosReserva.length > 0) {
            await registrarHistorialReserva(connection, reservaId, 'UPDATE', cabecera.id, req, cambiosReserva, 'Modificación de reserva');
        }

        // Actualizar reserva principal
        const updateReservaQuery = `
          UPDATE reserva SET 
            regimen_id = ?, 
            recurso_id = ?, 
            ${firmaArchivo ? 'firma_archivo = ?,' : ''} 
            precio_total = ?, 
            fecha_inicio = ?, 
            fecha_fin = ?, 
            observaciones = ?,
            monto_adicionales = ?,
            estado_reserva_id = 1
          WHERE id = ?
        `;

        const updateReservaParams = [
          regimen_id,
          recurso_id,
          ...(firmaArchivo ? [firmaArchivo] : []),
          precioTotalReserva,
          fecha_inicio,
          fecha_fin,
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

        // Crear o buscar usuarios para cada persona
        const usuariosIds = [];
        for (const persona of personas) {
          let usuarioId;

          // Si la persona tiene ID, verificar si existe
          if (persona.id) {
            const [usuarioExistente] = await connection.query(
              "SELECT * FROM usuario WHERE id = ?",
              [persona.id]
            );

            if (usuarioExistente.length > 0) {
              usuarioId = persona.id;
              const usuarioAnterior = usuarioExistente[0];

              // Preparar campos para comparar cambios
              const cambios = [];

              if (usuarioAnterior.nombre !== persona.nombre) {
                cambios.push({
                  campo: 'nombre',
                  valorAnterior: usuarioAnterior.nombre,
                  valorNuevo: persona.nombre
                });
              }

              if (usuarioAnterior.apellido !== persona.apellido) {
                cambios.push({
                  campo: 'apellido',
                  valorAnterior: usuarioAnterior.apellido,
                  valorNuevo: persona.apellido
                });
              }

              if (usuarioAnterior.fecha_nacimiento !== persona.fecha_nacimiento) {
                cambios.push({
                  campo: 'fecha_nacimiento',
                  valorAnterior: usuarioAnterior.fecha_nacimiento,
                  valorNuevo: persona.fecha_nacimiento
                });
              }

              if (usuarioAnterior.telefono !== (persona.telefono || null)) {
                cambios.push({
                  campo: 'telefono',
                  valorAnterior: usuarioAnterior.telefono,
                  valorNuevo: persona.telefono || null
                });
              }

              if (usuarioAnterior.email !== (persona.email || null)) {
                cambios.push({
                  campo: 'email',
                  valorAnterior: usuarioAnterior.email,
                  valorNuevo: persona.email || null
                });
              }

              if (usuarioAnterior.parentesco_id !== persona.parentesco_id) {
                cambios.push({
                  campo: 'parentesco_id',
                  valorAnterior: usuarioAnterior.parentesco_id,
                  valorNuevo: persona.parentesco_id
                });
              }

              if (usuarioAnterior.tipo_persona_id !== persona.tipo_persona_id) {
                cambios.push({
                  campo: 'tipo_persona_id',
                  valorAnterior: usuarioAnterior.tipo_persona_id,
                  valorNuevo: persona.tipo_persona_id
                });
              }

              // Actualizar datos del usuario existente
              await connection.query(
                `UPDATE usuario SET 
                   nombre = ?, apellido = ?, fecha_nacimiento = ?, 
                   telefono = ?, email = ?, parentesco_id = ?, tipo_persona_id = ?
                 WHERE id = ?`,
                [
                  persona.nombre,
                  persona.apellido,
                  persona.fecha_nacimiento,
                  persona.telefono || null,
                  persona.email || null,
                  persona.parentesco_id,
                  persona.tipo_persona_id,
                  persona.id
                ]
              );

              // Registrar cambios en el historial si hubo modificaciones
              if (cambios.length > 0) {
                await registrarHistorial(
                  connection,
                  usuarioId,
                  'UPDATE',
                  'usuario',
                  cabecera.id,
                  req,
                  cambios,
                  `Usuario modificado durante edición de reserva ${reservaId}`
                );
              }
            } else {
              // El ID no existe, buscar por documento
              const [existeUsuarioPorDni] = await connection.query(
                "SELECT id FROM usuario WHERE documento = ?",
                [persona.dni]
              );

              if (existeUsuarioPorDni.length > 0) {
                usuarioId = existeUsuarioPorDni[0].id;
              } else {
                // Determinar el rol_id basado en tipo_persona_id
                const rolId = persona.tipo_persona_id === 1 ? 2 : 4;

                // Crear nuevo usuario con departamental_id
                const [nuevoUsuario] = await connection.query(
                  `INSERT INTO usuario (
                  rol_id, parentesco_id, tipo_persona_id, nombre, apellido, fecha_nacimiento, 
                  documento, telefono, email, password, usuario_familiar_id, departamental_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
                  [
                    rolId,
                    persona.parentesco_id,
                    persona.tipo_persona_id,
                    persona.nombre,
                    persona.apellido,
                    persona.fecha_nacimiento,
                    persona.dni,
                    persona.telefono || null,
                    persona.email || null,
                    usuarioFamiliarPrincipalId,
                    departamentalId
                  ]
                );
                usuarioId = nuevoUsuario.insertId;

                // Registrar creación del usuario en el historial
                await registrarHistorial(
                  connection,
                  usuarioId,
                  'CREATE',
                  'usuario',
                  cabecera.id,
                  req,
                  null,
                  `Usuario creado durante edición de reserva ${reservaId}. Datos: ${persona.nombre} ${persona.apellido}, DNI: ${persona.dni}`
                );
              }
            }
          } else {
            // No tiene ID, verificar si existe por documento
            const [existeUsuario] = await connection.query(
              "SELECT id FROM usuario WHERE documento = ?",
              [persona.dni]
            );

            if (existeUsuario.length > 0) {
              usuarioId = existeUsuario[0].id;
            } else {
              // Determinar el rol_id basado en tipo_persona_id
              const rolId = persona.tipo_persona_id === 1 ? 2 : 4;

              // Crear nuevo usuario con departamental_id
              const [nuevoUsuario] = await connection.query(
                `INSERT INTO usuario (
                rol_id, parentesco_id, tipo_persona_id, nombre, apellido, fecha_nacimiento, 
                documento, telefono, email, password, usuario_familiar_id, departamental_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
                [
                  rolId,
                  persona.parentesco_id,
                  persona.tipo_persona_id,
                  persona.nombre,
                  persona.apellido,
                  persona.fecha_nacimiento,
                  persona.dni,
                  persona.telefono || null,
                  persona.email || null,
                  usuarioFamiliarPrincipalId,
                  departamentalId
                ]
              );
              usuarioId = nuevoUsuario.insertId;

              // Registrar creación del usuario en el historial
              await registrarHistorial(
                connection,
                usuarioId,
                'CREATE',
                'usuario',
                cabecera.id,
                req,
                null,
                `Usuario creado durante edición de reserva ${reservaId}. Datos: ${persona.nombre} ${persona.apellido}, DNI: ${persona.dni}`
              );
            }
          }

          usuariosIds.push({
            ...persona,
            usuario_id: usuarioId
          });
        }

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
              persona.tarifa_individual || 0
            ]
          );

          reservasFamiliaresIds.push({
            reserva_familiar_id: reservaFamiliarResult.insertId,
            ...persona
          });
        }

        // Calcular días del rango de fechas (NO incluir día de salida)
        const fechaInicioDate = new Date(fecha_inicio);
        const fechaFinDate = new Date(fecha_fin);
        const diasTotales = Math.ceil((fechaFinDate - fechaInicioDate) / (1000 * 60 * 60 * 24));

        // Insertar reserva_familiar_tarifa para cada día y cada persona
        for (const reservaFamiliar of reservasFamiliaresIds) {
          for (let dia = 0; dia < diasTotales; dia++) {
            const fechaActual = new Date(fechaInicioDate);
            fechaActual.setDate(fechaInicioDate.getDate() + dia);
            const fechaString = fechaActual.toISOString().split('T')[0];

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
               ORDER BY fecha_inicio ASC
               LIMIT 1`,
              [
                recurso_id,
                reservaFamiliar.tipo_persona_id,
                regimen_id,
                reservaFamiliar.edad,
                reservaFamiliar.edad,
                fechaString,
                fechaString
              ]
            );

            if (tarifas.length > 0) {
              await connection.query(
                `INSERT INTO reserva_familiar_tarifa (
                  reserva_familiar_id, tarifa_id, fecha
                ) VALUES (?, ?, ?)`,
                [
                  reservaFamiliar.reserva_familiar_id,
                  tarifas[0].id,
                  fechaString
                ]
              );
            }
          }
        }

        if (adicionalesProcesados.length > 0) {
          await guardarAdicionalesReserva(connection, reservaId, adicionalesProcesados);
        }

        // Confirmar transacción
        if (esReservaCamping) {
          if (Number.isInteger(numeroParcelaReserva) && numeroParcelaReserva > 0) {
            await validarNumeroParcelaCampingExistente(connection, {
              reservaId,
              recursoId: recurso_id,
              fechaInicio: fecha_inicio,
              fechaFin: fecha_fin,
              numeroParcela: numeroParcelaReserva
            });
          } else {
            numeroParcelaReserva = await asignarNumeroParcelaCamping(connection, {
              recursoId: recurso_id,
              fechaInicio: fecha_inicio,
              fechaFin: fecha_fin,
              reservaIdExcluir: reservaId
            });

            await connection.query(
              "UPDATE reserva SET numero_parcela = ? WHERE id = ?",
              [numeroParcelaReserva, reservaId]
            );
          }
        }

        await connection.commit();

        const numeroReserva = `RES-${reservaId.toString().padStart(6, '0')}`;

        res.status(200).json({
          success: true,
          message: "Reserva actualizada correctamente",
          numero_reserva: numeroReserva,
          numero_parcela: numeroParcelaReserva,
          id: parseInt(reservaId),
          monto_adicionales: montoAdicionales
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
    console.log(error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
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
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const reservaId = req.params.id;

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
            COALESCE(r.modalidad, 'FECHA_LIBRE') as modalidad,
            r.sorteo_id,
            r.bloque_fecha_id,
            er.nombre as estado,
            s.id as servicio_id,
            s.nombre as servicio_nombre,
            s.lugar,
            rec.id as recurso_id,
            rec.nombre as recurso_nombre,
            bf.nombre as bloque_nombre,
            sorteo.nombre as sorteo_nombre,
            reg.id as regimen_id,
            reg.nombre as regimen_nombre
          FROM reserva r
          LEFT JOIN estado_reserva er ON r.estado_reserva_id = er.id
          LEFT JOIN recurso rec ON r.recurso_id = rec.id
          LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
          LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
          LEFT JOIN sorteo ON sorteo.id = r.sorteo_id
          INNER JOIN regimen reg ON r.regimen_id = reg.id
          WHERE r.id = ?
        `, [reservaId]);

        if (reservaInfo.length === 0) {
          return res.status(404).json("Reserva no encontrada");
        }

        const reserva = reservaInfo[0];

        // Si el rol es afiliado, verificar que la reserva le pertenezca
        if (cabecera.rol === "afiliado") {
          const [usuarioReserva] = await connection.query(
            "SELECT usuario_id FROM reserva WHERE id = ?",
            [reservaId]
          );

          if (usuarioReserva.length === 0 || usuarioReserva[0].usuario_id !== cabecera.id) {
            return res.status(403).json("No tienes permisos para editar esta reserva");
          }
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
            nombre: reserva.recurso_nombre || "Pendiente de adjudicacion",
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
    console.log(error);
    res.status(500).json("Error al obtener la información de la reserva para edición");
  }
});

router.get("/reserva/:id/resumen", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const reservaId = req.params.id;

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
            r.firma_archivo,
            COALESCE(r.modalidad, 'FECHA_LIBRE') as modalidad,
            r.sorteo_id,
            r.bloque_fecha_id,
            er.nombre as estado,
            s.id as servicio_id,
            s.nombre as servicio_nombre,
            s.lugar,
            rec.id as recurso_id,
            rec.nombre as recurso_nombre,
            bf.nombre as bloque_nombre,
            sorteo.nombre as sorteo_nombre,
            reg.id as regimen_id,
            reg.nombre as regimen_nombre
          FROM reserva r
          LEFT JOIN estado_reserva er ON r.estado_reserva_id = er.id
          LEFT JOIN recurso rec ON r.recurso_id = rec.id
          LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
          LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
          LEFT JOIN sorteo ON sorteo.id = r.sorteo_id
          INNER JOIN regimen reg ON r.regimen_id = reg.id
          WHERE r.id = ?
        `, [reservaId]);

        if (reservaInfo.length === 0) {
          return res.status(404).json("Reserva no encontrada");
        }

        const reserva = reservaInfo[0];

        // Si el rol es afiliado, verificar que la reserva le pertenezca
        if (cabecera.rol === "afiliado") {
          const [usuarioReserva] = await connection.query(
            "SELECT usuario_id FROM reserva WHERE id = ?",
            [reservaId]
          );

          if (usuarioReserva.length === 0 || usuarioReserva[0].usuario_id !== cabecera.id) {
            return res.status(403).json("No tienes permisos para ver esta reserva");
          }
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
            nombre: reserva.servicio_nombre
          },
          lugar: reserva.lugar,
          recurso: {
            id: reserva.recurso_id,
            nombre: reserva.recurso_nombre || "Pendiente de adjudicacion"
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
          adicionales: adicionalesFormateados
        };

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
    console.log(error);
    res.status(500).json("Error al obtener el resumen de la reserva");
  }
});

router.put("/reserva/:id/estado", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "departamental" ||
      cabecera.rol === "afiliado"
    ) {
      const reservaId = req.params.id;
      const { estado, observaciones, usuario_admin_id } = req.body;

      // Validar campos requeridos
      if (!reservaId || !estado) {
        return res.status(400).json({
          success: false,
          message: "ID de reserva y estado son requeridos"
        });
      }

      // Validar que el estado sea válido
      const estadosValidos = ["Verificada", "Cancelada"];
      if (!estadosValidos.includes(estado)) {
        return res.status(400).json({
          success: false,
          message: "Estado no válido. Debe ser 'Verificada' o 'Cancelada'"
        });
      }

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Verificar que la reserva existe
        const [reservaExistente] = await connection.query(
          "SELECT * FROM reserva WHERE id = ?",
          [reservaId]
        );

        if (reservaExistente.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Reserva no encontrada"
          });
        }

        // Mapear estado a ID numérico
        let estadoId;
        let estadoNombre;
        if (estado === "Verificada") {
          estadoId = 2;
          estadoNombre = "Verificada";
        } else if (estado === "Cancelada") {
          estadoId = 4; // Usando "Rechazada" como equivalente a "Cancelada"
          estadoNombre = "Rechazada";
        }

        // Detectar cambios
        const datosAnteriores = reservaExistente[0];
        const cambiosReserva = [];

        if (datosAnteriores.estado_reserva_id !== estadoId) {
            cambiosReserva.push({ campo: 'estado_reserva_id', valorAnterior: datosAnteriores.estado_reserva_id, valorNuevo: estadoId });
        }
        
        const obsAnt = datosAnteriores.observaciones || '';
        const obsNew = observaciones || '';
        if (obsAnt !== obsNew) {
            cambiosReserva.push({ campo: 'observaciones', valorAnterior: obsAnt, valorNuevo: obsNew });
        }

        if (cambiosReserva.length > 0) {
            await registrarHistorialReserva(connection, reservaId, 'UPDATE', cabecera.id, req, cambiosReserva, 'Cambio de estado de reserva');
        }

        // Actualizar el estado de la reserva
        const [updateResult] = await connection.query(
          `UPDATE reserva SET 
            estado_reserva_id = ?, 
            observaciones = ?,
            fecha_modificacion = NOW()
          WHERE id = ?`,
          [estadoId, observaciones || null, reservaId]
        );

        if (updateResult.affectedRows === 0) {
          return res.status(500).json({
            success: false,
            message: "No se pudo actualizar la reserva"
          });
        }

        // Insertar registro de auditoría si se proporciona usuario_admin_id
        // if (usuario_admin_id) {
        //   await connection.query(
        //     `INSERT INTO auditoria_reserva (reserva_id, usuario_id, estado_anterior, estado_nuevo, observaciones, fecha_cambio)
        //      VALUES (?, ?, ?, ?, ?, NOW())`,
        //     [reservaId, usuario_admin_id, reservaExistente[0].estado_reserva_id, estadoId, observaciones || null]
        //   );
        // }

        // Confirmar transacción
        await connection.commit();

        // Generar número de reserva para la respuesta
        const numeroReserva = `RES-${reservaId.toString().padStart(6, '0')}`;

        // Respuesta exitosa
        res.status(200).json({
          success: true,
          message: `Reserva ${estado.toLowerCase()} exitosamente`,
          reserva: {
            id: parseInt(reservaId),
            numero_reserva: numeroReserva,
            estado: estadoNombre,
            fecha_actualizacion: new Date().toISOString()
          }
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
      res.status(401).json({
        success: false,
        message: "No autorizado. Solo administradores y departamentales pueden cambiar estados de reservas"
      });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor al actualizar el estado de la reserva"
    });
  }
});

router.get("/acompaniantes/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const usuario_id = req.query.usuario_id;
      const specific_id = req.params.id; // ID específico opcional

      // Si viene un ID específico, devolver directamente ese usuario
      if (specific_id) {
        const [usuario] = await mysqlConnection
          .promise()
          .query(
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
            [parseInt(specific_id)]
          );

        if (usuario.length === 0) {
          return res.status(404).json("No se encontró el acompañante con el ID especificado");
        }

        return res.status(200).json(usuario[0]);
      }

      // Lógica original cuando no viene ID específico
      const adultos = parseInt(req.query.adultos) || null;
      const ninos = parseInt(req.query.ninos) || null;
      const bebes = parseInt(req.query.bebes) || null;

      if (!usuario_id) {
        return res.status(400).json("Falta el parámetro 'usuario_id'");
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
    console.log(error);
    res.status(500).json("Error al obtener los acompañantes");
  }
});

router.put("/acompaniantes/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const { usuarioId, personas } = req.body;
      const specific_id = req.params.id;

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

        const formatearFecha = (fecha) => {
          if (!fecha) return null;
          try {
            const fechaObj = new Date(fecha);
            if (isNaN(fechaObj.getTime())) return null;
            return fechaObj.toISOString().split('T')[0];
          } catch (error) {
            return null;
          }
        };

        let connection;
        try {
          connection = await mysqlConnection.promise().getConnection();
          await connection.beginTransaction();

          // Obtener datos anteriores del usuario para el historial
          const [usuarioAnterior] = await connection.query(
            "SELECT * FROM usuario WHERE id = ?",
            [parseInt(specific_id)]
          );

          if (usuarioAnterior.length === 0) {
            return res.status(404).json({
              success: false,
              message: "Usuario no encontrado"
            });
          }

          const datosAnteriores = usuarioAnterior[0];

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

          const fechaFormateada = formatearFecha(persona.fecha_nacimiento);
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

          if (datosAnteriores.parentesco_id !== (persona.parentesco_id || null)) {
            cambios.push({
              campo: 'parentesco_id',
              valorAnterior: datosAnteriores.parentesco_id,
              valorNuevo: persona.parentesco_id || null
            });
          }

          if (datosAnteriores.tipo_persona_id !== (persona.tipo_persona_id || null)) {
            cambios.push({
              campo: 'tipo_persona_id',
              valorAnterior: datosAnteriores.tipo_persona_id,
              valorNuevo: persona.tipo_persona_id || null
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
            persona.parentesco_id || null,
            persona.tipo_persona_id || null
          ];

          // Si viene password, hashearlo y agregarlo a la actualización
          if (persona.password) {
            let passwordHash = await bcryptjs.hash(persona.password, 8);
            updateFields.push("password = ?");
            updateValues.push(passwordHash);

            cambios.push({
              campo: 'password',
              valorAnterior: '[OCULTO]',
              valorNuevo: '[MODIFICADO]'
            });
          }

          updateValues.push(parseInt(specific_id));
          const updateQuery = `UPDATE usuario SET ${updateFields.join(', ')} WHERE id = ?`;

          const [result] = await connection.query(updateQuery, updateValues);

          // Registrar cambios en el historial si hubo modificaciones
          if (cambios.length > 0) {
            await registrarHistorial(
              connection,
              parseInt(specific_id),
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

      if (cabecera.id !== usuarioId && cabecera.rol !== "admin") {
        return res.status(403).json({
          success: false,
          message: "No tienes permisos para modificar los datos de este usuario"
        });
      }

      let connection;
      try {
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

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
            let tienePermisos = false;
            if (usuario.usuario_familiar_id === cabecera.id) {
              tienePermisos = true;
            } else if (usuario.id === cabecera.id) {
              tienePermisos = true;
            }

            if (cabecera.rol === "admin") {
              tienePermisos = true;
            }

            if (!tienePermisos) {
              errores.push(`Persona ${persona.nombre} ${persona.apellido}: No tienes permisos para modificar este usuario`);
              continue;
            }

            // Función auxiliar para normalizar fechas
            const normalizarFecha = (fecha) => {
              if (!fecha) return null;
              if (fecha instanceof Date) return fecha.toISOString().split('T')[0];
              return fecha;
            };

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

            if (normalizarFecha(usuario.fecha_nacimiento) !== normalizarFecha(persona.fechaNacimiento)) {
              cambios.push({
                campo: 'fecha_nacimiento',
                valorAnterior: normalizarFecha(usuario.fecha_nacimiento),
                valorNuevo: normalizarFecha(persona.fechaNacimiento)
              });
            }

            if (normalizarTelefono(usuario.telefono) !== normalizarTelefono(persona.telefono)) {
              cambios.push({
                campo: 'telefono',
                valorAnterior: usuario.telefono,
                valorNuevo: persona.telefono || null
              });
            }

            if (usuario.parentesco_id !== persona.parentescoId) {
              cambios.push({
                campo: 'parentesco_id',
                valorAnterior: usuario.parentesco_id,
                valorNuevo: persona.parentescoId
              });
            }

            if (usuario.tipo_persona_id !== persona.tipoPersonaId) {
              cambios.push({
                campo: 'tipo_persona_id',
                valorAnterior: usuario.tipo_persona_id,
                valorNuevo: persona.tipoPersonaId
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
                  persona.fechaNacimiento || null,
                  persona.telefono || null,
                  persona.parentescoId,
                  persona.tipoPersonaId,
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
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor"
    });
  }
});

router.get("/regimen", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "afiliado" ||
    cabecera.rol === "departamental"
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
      console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    const page = req.query.page ? Number(req.query.page) : 1;
    const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 10;
    const start = (page - 1) * resultsPerPage;

    let orderBy = req.query.orderBy ? req.query.orderBy : "fecha_creacion";
    const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

    // Obtener filtros del body
    const filters = req.body || {};
    const { habilitado, fecha_creacion_minima, fecha_creacion_maxima } = filters;

    // Mapeo de columnas para ordenamiento
    if (orderBy === "nombre") orderBy = "d.nombre";
    else if (orderBy === "direccion") orderBy = "d.direccion";
    else if (orderBy === "localidad") orderBy = "d.localidad";
    else if (orderBy === "provincia") orderBy = "d.provincia";
    else if (orderBy === "habilitado") orderBy = "d.habilitado";
    else if (orderBy === "fecha_creacion") orderBy = "d.fecha_creacion";
    else if (orderBy === "fecha_modificacion") orderBy = "d.fecha_modificacion";
    else orderBy = "d.fecha_creacion";

    const queryOrderBy = `${orderBy} ${orderType}`;

    // Filtro de búsqueda general
    let queryBuscar = "";
    if (buscar) {
      buscar = "%" + buscar + "%";
      queryBuscar = `AND (d.id LIKE '${buscar}' OR d.nombre LIKE '${buscar}' OR d.direccion LIKE '${buscar}' OR d.localidad LIKE '${buscar}' OR d.provincia LIKE '${buscar}')`;
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
      ORDER BY ${queryOrderBy}
      LIMIT ${start}, ${resultsPerPage}
    `;

    const [rows] = await mysqlConnection.promise().execute(query, queryParams);

    // Query para contar el total de registros
    let countQuery = `
      SELECT COUNT(*) AS count
      FROM departamental d
      WHERE 1=1
        ${queryBuscar}
        ${whereClause}
    `;

    const [countRows] = await mysqlConnection.promise().execute(countQuery, queryParams);

    const numOfResults = countRows[0].count;
    const numOfPages = Math.ceil(numOfResults / resultsPerPage);

    res.json({
      results: rows,
      numOfPages,
      totalItems: numOfResults,
      page: page - 1,
      orderBy: req.query.orderBy || "fecha_creacion",
      orderType,
    });
  } catch (error) {
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
    res.status(500).json("Error interno");
  }
});

router.post("/tabla/temporadas", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  const filters = req.body;
  const fecha_incio = filters.startDate || "2023-01-01";
  const fecha_fin = filters.endDate || "2070-12-31";
  let fromDate = new Date(fecha_incio);
  let toDate = new Date(fecha_fin);

  // Format for SQL comparison (MySQL format)
  fromDate = fromDate.toISOString().split("T")[0];
  toDate.setDate(toDate.getDate() + 1);
  toDate = toDate.toISOString().split("T")[0];

  let queryBuscar = "";
  if (
    cabecera.rol === "admin"
  ) {
    const page = req.query.page ? Number(req.query.page) : 1;
    const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 10;
    const start = (page - 1) * resultsPerPage;

    let orderBy = req.query.orderBy ? req.query.orderBy : "id";
    const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

    if (orderBy === "fecha_inicio") {
      orderBy = "fecha_inicio";
    } else if (orderBy === "fecha_fin") {
      orderBy = "fecha_fin";
    }

    const queryOrderBy = `${orderBy} ${orderType}`;
    
    if (buscar) {
      buscar = "%" + buscar + "%";
      queryBuscar = `AND (id LIKE '${buscar}' OR nombre LIKE '${buscar}' OR DATE_FORMAT(fecha_inicio, '%d/%m/%Y') LIKE '${buscar}' OR DATE_FORMAT(fecha_fin, '%d/%m/%Y') LIKE '${buscar}')`;
    }

    const queryParams = [];
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

    query += ` ORDER BY ${queryOrderBy} LIMIT ${start}, ${resultsPerPage}`;

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
        orderBy,
        orderType,
      });
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.post("/tabla/reservas", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  const filters = req.body;
  const fecha_incio = filters.startDate || "2023-01-01";
  const fecha_fin = filters.endDate || "2070-12-31";
  let fromDate = new Date(fecha_incio);
  let toDate = new Date(fecha_fin);

  // Format for SQL comparison (MySQL format)
  fromDate = fromDate.toISOString().split("T")[0];
  toDate.setDate(toDate.getDate() + 1);
  toDate = toDate.toISOString().split("T")[0];

  let queryBuscar = "";
  const page = req.query.page ? Number(req.query.page) : 1;
  const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 10;
  const start = (page - 1) * resultsPerPage;

  let orderBy = req.query.orderBy ? req.query.orderBy : "fecha_inicio";
  const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

  if (orderBy === "fecha_inicio") {
    orderBy = "r.fecha_inicio";
  } else if (orderBy === "fecha_fin") {
    orderBy = "r.fecha_fin";
  } else if (orderBy === "id") {
    orderBy = "r.id";
  } else if (orderBy === "estado") {
    orderBy = "er.nombre";
  } else if (orderBy === "servicio") {
    orderBy = "s.nombre";
  } else if (orderBy === "recurso") {
    orderBy = "rec.nombre";
  } else if (orderBy === "afiliado") {
    orderBy = "u.documento";
  } else if (orderBy === "modalidad") {
    orderBy = "r.modalidad";
  }

  const queryOrderBy = `${orderBy} ${orderType}`;

  if (buscar) {
    buscar = "%" + buscar + "%";
    queryBuscar = `AND (r.id LIKE '${buscar}' OR er.nombre LIKE '${buscar}' OR s.nombre LIKE '${buscar}' OR rec.nombre LIKE '${buscar}' OR u.documento LIKE '${buscar}' OR DATE_FORMAT(r.fecha_inicio, '%d/%m/%Y') LIKE '${buscar}' OR DATE_FORMAT(r.fecha_fin, '%d/%m/%Y') LIKE '${buscar}' OR r.observaciones LIKE '${buscar}')`;
  }

  const queryParams = [];
  let query = `
    SELECT 
      r.id,
      COALESCE(er.nombre, 'Sin estado') AS estado,
      s.nombre AS servicio,
      COALESCE(rec.nombre, 'Pendiente de adjudicacion') AS recurso,
      COALESCE(r.modalidad, 'FECHA_LIBRE') AS modalidad,
      bf.nombre AS bloque,
      u.documento AS afiliado,
      DATE_FORMAT(r.fecha_inicio, '%d/%m/%Y') AS fecha_inicio,
      DATE_FORMAT(r.fecha_fin, '%d/%m/%Y') AS fecha_fin,
      COALESCE(r.observaciones, '') AS observaciones,
      DATE_FORMAT(r.fecha_creacion, '%d/%m/%Y') AS fecha_creacion
    FROM reserva r
    INNER JOIN estado_reserva er ON r.estado_reserva_id = er.id
    LEFT JOIN recurso rec ON r.recurso_id = rec.id
    LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
    LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
    INNER JOIN usuario u ON r.usuario_id = u.id
    WHERE 1=1 
      ${queryBuscar}
      ${fromDate ? "AND r.fecha_inicio >= ?" : ""}
      ${toDate ? "AND r.fecha_fin <= ?" : ""}
  `;

  if (fromDate) {
    queryParams.push(fromDate);
  }
  if (toDate) {
    queryParams.push(toDate);
  }

  // Si el rol es afiliado, filtrar por usuario_id
  if (cabecera.rol === "afiliado") {
    query += " AND r.usuario_id = ?";
    queryParams.push(cabecera.id);
  }

  query += ` ORDER BY ${queryOrderBy} LIMIT ${start}, ${resultsPerPage}`;

  try {
    const [rows] = await mysqlConnection.promise().execute(query, queryParams);

    // Construye los parámetros para el countQuery de forma independiente
    const countParams = [];
    if (fromDate) countParams.push(fromDate);
    if (toDate) countParams.push(toDate);
    if (cabecera.rol === "afiliado") countParams.push(cabecera.id);

    let countQuery = `
      SELECT COUNT(*) AS count
      FROM reserva r
      INNER JOIN estado_reserva er ON r.estado_reserva_id = er.id
      LEFT JOIN recurso rec ON r.recurso_id = rec.id
      LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
      LEFT JOIN bloque_fecha bf ON bf.id = r.bloque_fecha_id
      INNER JOIN usuario u ON r.usuario_id = u.id
      WHERE 1=1 
        ${queryBuscar}
        ${fromDate ? "AND r.fecha_inicio >= ?" : ""}
        ${toDate ? "AND r.fecha_fin <= ?" : ""}
        ${cabecera.rol === "afiliado" ? "AND r.usuario_id = ?" : ""}
    `;

    const [countRows] = await mysqlConnection.promise().execute(countQuery, countParams);

    const numOfResults = countRows[0].count;
    const numOfPages = Math.ceil(numOfResults / resultsPerPage);

    res.json({
      results: rows,
      numOfPages,
      totalItems: numOfResults,
      page: page - 1,
      orderBy: req.query.orderBy || "fecha_inicio",
      orderType,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error interno");
  }
});

router.post("/tabla/acompaniantes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol !== "afiliado") {
    return res.status(401).json("No autorizado");
  }

  let buscar = req.query.search;
  const page = req.query.page ? Number(req.query.page) : 1;
  const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 10;
  const start = (page - 1) * resultsPerPage;

  let orderBy = req.query.orderBy ? req.query.orderBy : "fecha_creacion";
  const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

  // Map orderBy to correct SQL columns
  if (orderBy === "nombre") {
    orderBy = "u.nombre";
  } else if (orderBy === "apellido") {
    orderBy = "u.apellido";
  } else if (orderBy === "documento") {
    orderBy = "u.documento";
  } else if (orderBy === "parentesco") {
    orderBy = "p.nombre";
  } else if (orderBy === "tipo_persona") {
    orderBy = "tp.nombre";
  } else if (orderBy === "fecha_creacion") {
    orderBy = "u.fecha_creacion";
  }

  const queryOrderBy = `${orderBy} ${orderType}`;

  let queryBuscar = "";
  if (buscar) {
    buscar = "%" + buscar + "%";
    queryBuscar = `AND (u.nombre LIKE '${buscar}' OR u.apellido LIKE '${buscar}' OR u.documento LIKE '${buscar}' OR p.nombre LIKE '${buscar}' OR tp.nombre LIKE '${buscar}' OR DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') LIKE '${buscar}')`;
  }

  const queryParams = [cabecera.id];
  let query = `
    SELECT 
      u.id,
      u.nombre,
      u.apellido,
      u.documento,
      u.tipo_persona_id,
      p.nombre AS parentesco,
      tp.nombre AS tipo_persona,
      DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') AS fecha_creacion
    FROM usuario u
    LEFT JOIN parentesco p ON u.parentesco_id = p.id
    LEFT JOIN tipo_persona tp ON u.tipo_persona_id = tp.id
    WHERE u.usuario_familiar_id = ?
      ${queryBuscar}
    ORDER BY ${queryOrderBy}
    LIMIT ${start}, ${resultsPerPage}
  `;

  try {
    const [rows] = await mysqlConnection.promise().execute(query, queryParams);

    // Count total items for pagination
    let countQuery = `
      SELECT COUNT(*) AS count
      FROM usuario u
      LEFT JOIN parentesco p ON u.parentesco_id = p.id
      LEFT JOIN tipo_persona tp ON u.tipo_persona_id = tp.id
      WHERE u.usuario_familiar_id = ?
      ${queryBuscar}
    `;
    const [countRows] = await mysqlConnection.promise().execute(countQuery, queryParams);

    const numOfResults = countRows[0].count;
    const numOfPages = Math.ceil(numOfResults / resultsPerPage);

    res.json({
      results: rows,
      numOfPages,
      totalItems: numOfResults,
      page: page - 1,
      orderBy: req.query.orderBy || "fecha_creacion",
      orderType,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json("Error interno");
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
      const userId = req.params.id;
      const page = req.query.page ? Number(req.query.page) : 1;
      const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 20;
      const start = (page - 1) * resultsPerPage;

      const tipoOperacion = req.query.tipo_operacion;
      const fechaDesde = req.query.fecha_desde;
      const fechaHasta = req.query.fecha_hasta;

      let whereClause = "";
      let params = [];

      if (userId) {
        whereClause += " WHERE h.usuario_id = ?";
        params.push(userId);
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
          h.tabla_afectada,
          h.usuario_modificador_id,
          CONCAT(um.nombre, ' ', um.apellido) as modificador_nombre,
          DATE_FORMAT(h.fecha_modificacion, '%d/%m/%Y %H:%i:%s') as fecha_modificacion,
          h.observaciones
        FROM historial_usuario h
        INNER JOIN usuario u ON h.usuario_id = u.id
        LEFT JOIN usuario um ON h.usuario_modificador_id = um.id
        ${whereClause}
        ORDER BY h.fecha_modificacion DESC
        LIMIT ${start}, ${resultsPerPage}
      `;

      const [rows] = await mysqlConnection.promise().execute(query, params);

      // Consulta para el total de registros
      const countQuery = `
        SELECT COUNT(*) as total
        FROM historial_usuario h
        INNER JOIN usuario u ON h.usuario_id = u.id
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
        pageSize: resultsPerPage
      });

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
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
    const page = req.query.page ? Number(req.query.page) : 1;
    const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 20;
    const start = (page - 1) * resultsPerPage;

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
      ORDER BY h.fecha_cambio DESC
      LIMIT ${start}, ${resultsPerPage}
    `;

    const [rows] = await mysqlConnection.promise().execute(query, params);

    // Consulta para el total de registros
    const countQuery = `
      SELECT COUNT(*) as total
      FROM historial_departamental h
      INNER JOIN departamental d ON h.departamental_id = d.id
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
      pageSize: resultsPerPage
    });

  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener el historial de departamentales");
  }
});

// GET /tabla/historial-reserva/:id? - Obtiene el historial de cambios de reservas
router.get("/tabla/historial-reserva/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "departamental"
    ) {
      const reservaId = req.params.id;
      const page = req.query.page ? Number(req.query.page) : 1;
      const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 20;
      const start = (page - 1) * resultsPerPage;

      const tipoOperacion = req.query.tipo_operacion;
      const fechaDesde = req.query.fecha_desde;
      const fechaHasta = req.query.fecha_hasta;

      let whereClause = "";
      let params = [];

      if (reservaId) {
        whereClause += " WHERE h.reserva_id = ?";
        params.push(reservaId);
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

      const query = `
        SELECT
          h.id,
          h.reserva_id,
          h.tipo_operacion,
          h.campo_modificado,
          h.valor_anterior,
          h.valor_nuevo,
          h.usuario_modificador_id,
          CONCAT(um.nombre, ' ', um.apellido) as modificador_nombre,
          DATE_FORMAT(h.fecha_modificacion, '%d/%m/%Y %H:%i:%s') as fecha_modificacion,
          h.observaciones
        FROM historial_reserva h
        LEFT JOIN usuario um ON h.usuario_modificador_id = um.id
        ${whereClause}
        ORDER BY h.fecha_modificacion DESC
        LIMIT ${start}, ${resultsPerPage}
      `;

      const [rows] = await mysqlConnection.promise().execute(query, params);

      // Consulta para el total de registros
      const countQuery = `
        SELECT COUNT(*) as total
        FROM historial_reserva h
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
        pageSize: resultsPerPage
      });

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
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

      // Paginación
      const page = req.query.page ? Number(req.query.page) : 1;
      const resultsPerPage = req.query.pageSize ? Number(req.query.pageSize) : 10;
      const start = (page - 1) * resultsPerPage;

      // Ordenamiento
      let orderBy = req.query.orderBy ? req.query.orderBy : "fecha_creacion";
      const orderType = ["asc", "desc"].includes(req.query.orderType) ? req.query.orderType : "desc";

      // Mapeo de columnas para ordenamiento
      if (orderBy === "fecha_nacimiento") {
        orderBy = "u.fecha_nacimiento";
      } else if (orderBy === "fecha_creacion") {
        orderBy = "u.fecha_creacion";
      } else if (orderBy === "nombre") {
        orderBy = "u.nombre";
      } else if (orderBy === "apellido") {
        orderBy = "u.apellido";
      } else if (orderBy === "documento") {
        orderBy = "u.documento";
      } else if (orderBy === "legajo") {
        orderBy = "u.legajo";
      } else if (orderBy === "rol") {
        orderBy = "r.nombre";
      } else if (orderBy === "habilitado") {
        orderBy = "u.habilitado";
      }

      const queryOrderBy = `${orderBy} ${orderType}`;

      // Filtro de búsqueda general
      let queryBuscar = "";
      if (buscar) {
        buscar = "%" + buscar + "%";
        queryBuscar = `AND (u.id LIKE '${buscar}' OR u.nombre LIKE '${buscar}' OR u.apellido LIKE '${buscar}' OR u.documento LIKE '${buscar}' OR u.legajo LIKE '${buscar}' OR r.nombre LIKE '${buscar}' OR DATE_FORMAT(u.fecha_nacimiento, '%d/%m/%Y') LIKE '${buscar}' OR DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') LIKE '${buscar}')`;
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
        ORDER BY ${queryOrderBy}
        LIMIT ${start}, ${resultsPerPage}
      `;

      const [rows] = await mysqlConnection.promise().execute(query, queryParams);

      // Query para contar el total de registros
      let countQuery = `
        SELECT COUNT(*) AS count
        FROM usuario u
        LEFT JOIN rol r ON u.rol_id = r.id
        WHERE 1=1 
          ${queryBuscar}
          ${whereClause}
      `;

      const [countRows] = await mysqlConnection.promise().execute(countQuery, queryParams);

      const numOfResults = countRows[0].count;
      const numOfPages = Math.ceil(numOfResults / resultsPerPage);

      res.json({
        results: rows,
        numOfPages,
        totalItems: numOfResults,
        page: page - 1,
        orderBy: req.query.orderBy || "fecha_creacion",
        orderType,
      });

    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
  return Number.isNaN(numero) ? null : numero;
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
      const pDescuento = porcentajeDescuento !== null ? porcentajeDescuento : 0;
      const factor = 1 - pDescuento / 100;
      precioTarifa = Number((precioBase * factor).toFixed(2));
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

  const errorParcelas = validarParcelasDisponiblesEnConfiguracion(configuracion_servicios);
  if (errorParcelas) {
    throw crearErrorNegocio(errorParcelas, 400);
  }

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

      const errorParcelas = validarParcelasDisponiblesEnConfiguracion(configuracion_servicios);
      if (errorParcelas) {
        return res.status(400).json(errorParcelas);
      }

      // Iniciar transacción
      let connection;
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      try {
        await validarSolapamientoTarifasExistentes(connection, {
          configuracionServicios: configuracion_servicios,
          origenes: ["BLOQUE"]
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
    console.log(error);
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
    console.log(error);
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

          // Normalizar fechas para evitar duplicados por comparar objetos Date diferentes
          const tarifaFechaInicioMs = new Date(tarifa.fecha_inicio).getTime();
          const tarifaFechaFinMs = new Date(tarifa.fecha_fin).getTime();

          // Buscar o crear fecha en el recurso
          let fecha = recurso.fechas.find(f => {
            const fechaInicioMs = new Date(f.fecha_inicio).getTime();
            const fechaFinMs = new Date(f.fecha_fin).getTime();
            return fechaInicioMs === tarifaFechaInicioMs && fechaFinMs === tarifaFechaFinMs;
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

          const adicionalFechaInicio = new Date(adicional.fecha_inicio).getTime();
          const adicionalFechaFin = new Date(adicional.fecha_fin).getTime();

          const fecha = recurso.fechas.find(f => {
            const fechaInicioMs = new Date(f.fecha_inicio).getTime();
            const fechaFinMs = new Date(f.fecha_fin).getTime();
            return fechaInicioMs === adicionalFechaInicio && fechaFinMs === adicionalFechaFin;
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
    console.log(error);
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

      const errorParcelas = validarParcelasDisponiblesEnConfiguracion(configuracion_servicios);
      if (errorParcelas) {
        return res.status(400).json(errorParcelas);
      }

      let connection;
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      try {
        // 1. Verificar que la temporada existe y obtener datos anteriores
        const [temporadaAnterior] = await connection.query(
          "SELECT nombre, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE id = ?",
          [id]
        );

        if (temporadaAnterior.length === 0) {
          connection.release();
          return res.status(404).json("Temporada no encontrada");
        }

        const datosAnteriores = temporadaAnterior[0];

        await validarSolapamientoTarifasExistentes(connection, {
          configuracionServicios: configuracion_servicios,
          origenes: ["BLOQUE"]
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    console.log(error);
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
    // Aceptar solo imágenes
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  }
});

// GET /configuracion/usuario/:id? - Obtener datos del usuario
router.get("/configuracion/usuario/:id?", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    const userId = req.params.id ? parseInt(req.params.id) : cabecera.id;

    // Verificar permisos
    let tienePermisos = false;

    if (cabecera.rol === "admin") {
      tienePermisos = true;
    } else if (cabecera.rol === "departamental") {
      // Departamental puede ver usuarios de su departamento o a sí mismo
      if (userId === cabecera.id) {
        tienePermisos = true;
      } else {
        const [usuarioTarget] = await mysqlConnection
          .promise()
          .query(
            "SELECT departamental_id FROM usuario WHERE id = ?",
            [userId]
          );

        if (usuarioTarget.length > 0 && usuarioTarget[0].departamental_id === cabecera.id) {
          tienePermisos = true;
        }
      }
    } else if (cabecera.rol === "afiliado") {
      // Afiliado solo puede verse a sí mismo
      tienePermisos = userId === cabecera.id;
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
          u.legajo,
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
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener datos del usuario"
    });
  }
});

// PUT /configuracion/usuario/:id - Actualizar datos del usuario
router.put("/configuracion/usuario/:id", verifyToken, uploadFotoPerfil.single('foto'), async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    const userId = parseInt(req.params.id);

    // Validar que el ID sea válido
    if (!userId || isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: "ID de usuario inválido"
      });
    }

    let connection;
    try {
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      // Obtener datos actuales del usuario
      const [usuarioActual] = await connection.query(
        "SELECT * FROM usuario WHERE id = ?",
        [userId]
      );

      if (usuarioActual.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "Usuario no encontrado"
        });
      }

      const datosAnteriores = usuarioActual[0];

      // Verificar permisos y determinar qué campos puede editar
      let camposPermitidos = [];
      let tienePermisos = false;

      if (cabecera.rol === "admin") {
        tienePermisos = true;
        camposPermitidos = [
          'rol_id', 'departamental_id', 'tipo_persona_id', 'nombre', 'apellido',
          'fecha_nacimiento', 'documento', 'password', 'email', 'telefono',
          'legajo', 'foto_archivo', 'habilitado'
        ];
      } else if (cabecera.rol === "departamental") {
        // Verificar que el usuario pertenezca a su departamento o sea él mismo
        if (userId === cabecera.id) {
          tienePermisos = true;
        } else if (datosAnteriores.departamental_id === cabecera.id) {
          tienePermisos = true;
        }
        camposPermitidos = [
          'tipo_persona_id', 'nombre', 'apellido', 'fecha_nacimiento',
          'documento', 'password', 'email', 'telefono', 'legajo',
          'foto_archivo', 'habilitado'
        ];
      } else if (cabecera.rol === "afiliado") {
        // Solo puede editarse a sí mismo
        if (userId === cabecera.id) {
          tienePermisos = true;
        }
        camposPermitidos = [
          'tipo_persona_id', 'nombre', 'apellido', 'fecha_nacimiento',
          'documento', 'password', 'email', 'telefono', 'legajo', 'foto_archivo'
        ];
      }

      if (!tienePermisos) {
        await connection.rollback();
        return res.status(403).json({
          success: false,
          message: "No tienes permisos para modificar este usuario"
        });
      }

      // Preparar campos para actualizar
      const updateFields = [];
      const updateValues = [];
      const cambios = [];

      // Función auxiliar para formatear fechas
      const formatearFecha = (fecha) => {
        if (!fecha) return null;
        try {
          const fechaObj = new Date(fecha);
          if (isNaN(fechaObj.getTime())) return null;
          return fechaObj.toISOString().split('T')[0];
        } catch (error) {
          return null;
        }
      };

      // Procesar cada campo permitido
      if (camposPermitidos.includes('rol_id') && req.body.rol_id !== undefined) {
        const nuevoValor = req.body.rol_id ? parseInt(req.body.rol_id) : null;
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
        const nuevoValor = req.body.departamental_id ? parseInt(req.body.departamental_id) : null;
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

      if (camposPermitidos.includes('tipo_persona_id') && req.body.tipo_persona_id !== undefined) {
        const nuevoValor = req.body.tipo_persona_id ? parseInt(req.body.tipo_persona_id) : null;
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
        if (datosAnteriores.nombre !== req.body.nombre) {
          updateFields.push('nombre = ?');
          updateValues.push(req.body.nombre);
          cambios.push({
            campo: 'nombre',
            valorAnterior: datosAnteriores.nombre,
            valorNuevo: req.body.nombre
          });
        }
      }

      if (camposPermitidos.includes('apellido') && req.body.apellido !== undefined) {
        if (datosAnteriores.apellido !== req.body.apellido) {
          updateFields.push('apellido = ?');
          updateValues.push(req.body.apellido);
          cambios.push({
            campo: 'apellido',
            valorAnterior: datosAnteriores.apellido,
            valorNuevo: req.body.apellido
          });
        }
      }

      if (camposPermitidos.includes('fecha_nacimiento') && req.body.fecha_nacimiento !== undefined) {
        const fechaFormateada = formatearFecha(req.body.fecha_nacimiento);
        const fechaAnteriorFormateada = formatearFecha(datosAnteriores.fecha_nacimiento);
        if (fechaAnteriorFormateada !== fechaFormateada) {
          updateFields.push('fecha_nacimiento = ?');
          updateValues.push(fechaFormateada);
          cambios.push({
            campo: 'fecha_nacimiento',
            valorAnterior: fechaAnteriorFormateada,
            valorNuevo: fechaFormateada
          });
        }
      }

      if (camposPermitidos.includes('documento') && req.body.documento !== undefined) {
        const nuevoValor = req.body.documento ? parseInt(req.body.documento) : null;
        if (datosAnteriores.documento !== nuevoValor) {
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
        if (datosAnteriores.email !== req.body.email) {
          updateFields.push('email = ?');
          updateValues.push(req.body.email);
          cambios.push({
            campo: 'email',
            valorAnterior: datosAnteriores.email,
            valorNuevo: req.body.email
          });
        }
      }

      if (camposPermitidos.includes('telefono') && req.body.telefono !== undefined) {
        if (datosAnteriores.telefono !== req.body.telefono) {
          updateFields.push('telefono = ?');
          updateValues.push(req.body.telefono || null);
          cambios.push({
            campo: 'telefono',
            valorAnterior: datosAnteriores.telefono,
            valorNuevo: req.body.telefono || null
          });
        }
      }

      if (camposPermitidos.includes('legajo') && req.body.legajo !== undefined) {
        if (datosAnteriores.legajo !== req.body.legajo) {
          updateFields.push('legajo = ?');
          updateValues.push(req.body.legajo || null);
          cambios.push({
            campo: 'legajo',
            valorAnterior: datosAnteriores.legajo,
            valorNuevo: req.body.legajo || null
          });
        }
      }

      if (camposPermitidos.includes('habilitado') && req.body.habilitado !== undefined) {
        if (datosAnteriores.habilitado !== req.body.habilitado) {
          updateFields.push('habilitado = ?');
          updateValues.push(req.body.habilitado);
          cambios.push({
            campo: 'habilitado',
            valorAnterior: datosAnteriores.habilitado,
            valorNuevo: req.body.habilitado
          });
        }
      }

      // Procesar password si viene
      if (camposPermitidos.includes('password') && req.body.password && req.body.password.trim() !== '') {
        const passwordHash = await bcryptjs.hash(req.body.password, 8);
        updateFields.push('password = ?');
        updateValues.push(passwordHash);
        cambios.push({
          campo: 'password',
          valorAnterior: '[OCULTO]',
          valorNuevo: '[MODIFICADO]'
        });
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

      res.status(200).json({
        success: true,
        message: "Usuario actualizado correctamente"
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

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error al actualizar el usuario"
    });
  }
});

// POST /configuracion/usuario - Crear nuevo usuario
router.post("/configuracion/usuario", verifyToken, uploadFotoPerfil.single('foto'), async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    // Verificar permisos - solo admin y departamental pueden crear usuarios
    if (cabecera.rol !== "admin" && cabecera.rol !== "departamental") {
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para crear usuarios"
      });
    }

    // Validar campos requeridos
    if (!req.body.nombre || !req.body.apellido || !req.body.email || !req.body.documento) {
      return res.status(400).json({
        success: false,
        message: "Faltan campos requeridos: nombre, apellido, email y documento son obligatorios"
      });
    }

    let connection;
    try {
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      // Determinar qué campos puede asignar según el rol
      let camposPermitidos = [];
      let valorDefectoRol = null;
      let valorDefectoDepartamental = null;

      if (cabecera.rol === "admin") {
        camposPermitidos = [
          'rol_id', 'departamental_id', 'tipo_persona_id', 'nombre', 'apellido',
          'fecha_nacimiento', 'documento', 'password', 'email', 'telefono',
          'legajo', 'foto_archivo', 'habilitado'
        ];
      } else if (cabecera.rol === "departamental") {
        // Departamental puede crear usuarios pero con restricciones
        camposPermitidos = [
          'tipo_persona_id', 'nombre', 'apellido', 'fecha_nacimiento',
          'documento', 'password', 'email', 'telefono', 'legajo',
          'foto_archivo', 'habilitado'
        ];
        // Asignar automáticamente rol afiliado y su departamento
        const [rolAfiliado] = await connection.query(
          "SELECT id FROM rol WHERE nombre = 'afiliado' LIMIT 1"
        );
        if (rolAfiliado.length > 0) {
          valorDefectoRol = rolAfiliado[0].id;
        }
        valorDefectoDepartamental = cabecera.id;
      }

      // Preparar campos para insertar
      const insertFields = [];
      const insertPlaceholders = [];
      const insertValues = [];
      const cambios = [];

      // Función auxiliar para formatear fechas
      const formatearFecha = (fecha) => {
        if (!fecha) return null;
        try {
          const fechaObj = new Date(fecha);
          if (isNaN(fechaObj.getTime())) return null;
          return fechaObj.toISOString().split('T')[0];
        } catch (error) {
          return null;
        }
      };

      // Procesar rol_id
      if (camposPermitidos.includes('rol_id') && req.body.rol_id !== undefined) {
        const nuevoValor = req.body.rol_id ? parseInt(req.body.rol_id) : null;
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
      }

      // Procesar departamental_id
      if (camposPermitidos.includes('departamental_id') && req.body.departamental_id !== undefined) {
        const nuevoValor = req.body.departamental_id ? parseInt(req.body.departamental_id) : null;
        insertFields.push('departamental_id');
        insertPlaceholders.push('?');
        insertValues.push(nuevoValor);
        cambios.push({
          campo: 'departamental_id',
          valorAnterior: null,
          valorNuevo: nuevoValor
        });
      } else if (valorDefectoDepartamental !== null) {
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
        const nuevoValor = req.body.tipo_persona_id ? parseInt(req.body.tipo_persona_id) : null;
        insertFields.push('tipo_persona_id');
        insertPlaceholders.push('?');
        insertValues.push(nuevoValor);
        cambios.push({
          campo: 'tipo_persona_id',
          valorAnterior: null,
          valorNuevo: nuevoValor
        });
      }

      // Procesar nombre (requerido)
      insertFields.push('nombre');
      insertPlaceholders.push('?');
      insertValues.push(req.body.nombre);
      cambios.push({
        campo: 'nombre',
        valorAnterior: null,
        valorNuevo: req.body.nombre
      });

      // Procesar apellido (requerido)
      insertFields.push('apellido');
      insertPlaceholders.push('?');
      insertValues.push(req.body.apellido);
      cambios.push({
        campo: 'apellido',
        valorAnterior: null,
        valorNuevo: req.body.apellido
      });

      // Procesar fecha_nacimiento
      if (camposPermitidos.includes('fecha_nacimiento') && req.body.fecha_nacimiento !== undefined) {
        const fechaFormateada = formatearFecha(req.body.fecha_nacimiento);
        insertFields.push('fecha_nacimiento');
        insertPlaceholders.push('?');
        insertValues.push(fechaFormateada);
        cambios.push({
          campo: 'fecha_nacimiento',
          valorAnterior: null,
          valorNuevo: fechaFormateada
        });
      }

      // Procesar documento (requerido)
      const documentoValor = req.body.documento ? parseInt(req.body.documento) : null;
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
      insertValues.push(req.body.email);
      cambios.push({
        campo: 'email',
        valorAnterior: null,
        valorNuevo: req.body.email
      });

      // Verificar si el email ya existe
      const [emailExistente] = await connection.query(
        "SELECT id FROM usuario WHERE email = ?",
        [req.body.email]
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
        insertFields.push('telefono');
        insertPlaceholders.push('?');
        insertValues.push(req.body.telefono || null);
        cambios.push({
          campo: 'telefono',
          valorAnterior: null,
          valorNuevo: req.body.telefono || null
        });
      }

      // Procesar legajo
      if (camposPermitidos.includes('legajo') && req.body.legajo !== undefined) {
        insertFields.push('legajo');
        insertPlaceholders.push('?');
        insertValues.push(req.body.legajo || null);
        cambios.push({
          campo: 'legajo',
          valorAnterior: null,
          valorNuevo: req.body.legajo || null
        });
      }

      // Procesar habilitado (por defecto true)
      if (camposPermitidos.includes('habilitado')) {
        const habilitadoValor = req.body.habilitado !== undefined ? req.body.habilitado : true;
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
        const passwordTexto = req.body.password && req.body.password.trim() !== ''
          ? req.body.password
          : req.body.documento ? req.body.documento.toString() : '123456';

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
      let nombreArchivo = null;
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
      throw createError;
    } finally {
      if (connection) {
        connection.release();
      }
    }

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error al crear el usuario"
    });
  }
});

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

module.exports = router;
