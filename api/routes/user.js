const express = require("express");
const router = express.Router();

const mysqlConnection = require("../connection/connection");

const jwt = require("jsonwebtoken");

const bcryptjs = require("bcryptjs");

const multer = require("multer");
// Import the filesystem module
const fs = require("fs");

var path = require("path");

const moment = require("moment"); // para formatear fechas

// S3 INICIO
const S3Client = require("@aws-sdk/client-s3").S3Client;
const PutObjectCommand = require("@aws-sdk/client-s3").PutObjectCommand;
const GetObjectCommand = require("@aws-sdk/client-s3").GetObjectCommand;
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const getSignedUrl = require("@aws-sdk/s3-request-presigner").getSignedUrl;

const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;

const crypto = require("crypto");
const randomImageName = (bytes = 32) =>
  crypto.randomBytes(bytes).toString("hex");

const s3 = new S3Client({
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretAccessKey,
  },
  region: bucketRegion,
});
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
          const fotoPath = path.join(__dirname, '../../imagenes', usuario.foto_archivo);
          if (fs.existsSync(fotoPath)) {
            try {
              const fotoBuffer = fs.readFileSync(fotoPath);
              const fotoBase64 = fotoBuffer.toString('base64');
              const mimeType = usuario.foto_archivo.match(/\.(jpg|jpeg|png|gif)$/i);
              const mimeTypeStr = mimeType ? `image/${mimeType[1].toLowerCase()}` : 'image/jpeg';
              usuario.foto_data = `data:${mimeTypeStr};base64,${fotoBase64}`;
            } catch (readError) {
              console.error('Error leyendo foto:', readError);
              usuario.foto_data = null;
            }
          } else {
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
      // Filtrar por lugar si viene el query param
      const lugar = req.query.lugar;
      const fecha_inicio = req.query.fecha_inicio;
      const fecha_fin = req.query.fecha_fin;
      const adultos = parseInt(req.query.adultos) || 0;
      const ninos = parseInt(req.query.ninos) || 0;
      const bebes = parseInt(req.query.bebes) || 0;

      let query = "SELECT id, nombre, lugar, rating FROM servicio";
      let params = [];
      if (lugar) {
        query += " WHERE lugar = ?";
        params.push(lugar);
      }
      query += " ORDER BY nombre ASC";

      // Obtener los servicios (filtrados o no)
      const [servicios] = await mysqlConnection
        .promise()
        .query(query, params);

      // Obtener todas las imagenes de servicios
      const [imagenes] = await mysqlConnection
        .promise()
        .query("SELECT id, servicio_id, archivo FROM imagen_servicio");

      // Mapear imagenes por servicio_id
      const imagenesPorServicio = {};
      imagenes.forEach(img => {
        if (!imagenesPorServicio[img.servicio_id]) {
          imagenesPorServicio[img.servicio_id] = [];
        }
        imagenesPorServicio[img.servicio_id].push({
          id: img.id,
          archivo: `http://localhost:3000/imagenes/${img.archivo}`
        });
      });

      // Agregar campo imagenes y precios a cada servicio
      const serviciosConImagenes = await Promise.all(servicios.map(async (servicio) => {
        let precio_minimo = null;
        let precio_maximo = null;

        // Calcular precios solo si se proporcionan las fechas y al menos una persona
        if (fecha_inicio && fecha_fin && (adultos > 0 || ninos > 0 || bebes > 0)) {
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
              const [tarifasAdultos] = await mysqlConnection
                .promise()
                .query(`
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
              const [tarifasninos] = await mysqlConnection
                .promise()
                .query(`
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
              const [tarifasBebes] = await mysqlConnection
                .promise()
                .query(`
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

        return {
          ...servicio,
          imagenes: imagenesPorServicio[servicio.id] || [],
          precio_minimo: precio_minimo,
          precio_maximo: precio_maximo
        };
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

router.post("/reserva/recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const { fecha_inicio, fecha_fin, servicio_id, personas, recurso_id, filtros, precio_minimo, precio_maximo, orden_id } = req.body;

      if (!fecha_inicio || !fecha_fin || !servicio_id || !personas || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      // Primero obtenemos solo los recursos que tienen tarifas válidas para el servicio y las personas
      const recursosConTarifas = [];

      // Para cada persona, buscamos qué recursos tienen tarifas válidas
      const recursosValidos = new Set();

      for (const persona of personas) {
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
          `, [
            servicio_id,
            persona.tipo_persona_id,
            persona.regimen_id,
            persona.edad,
            persona.edad,
            fecha_fin,
            fecha_inicio
          ]);

        tarifasPersona.forEach(tarifa => {
          recursosValidos.add(tarifa.recurso_id);
        });
      }

      if (recursosValidos.size === 0) {
        return res.status(404).json("No se encontraron recursos con tarifas válidas para las personas especificadas");
      }

      // Si se especifica recurso_id, filtramos solo ese recurso (si está en los válidos)
      if (recurso_id) {
        if (recursosValidos.has(recurso_id)) {
          // Mantener solo el recurso especificado
          recursosValidos.clear();
          recursosValidos.add(recurso_id);
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
      const imagenesPorRecurso = {};
      imagenes.forEach(img => {
        if (!imagenesPorRecurso[img.recurso_id]) {
          imagenesPorRecurso[img.recurso_id] = [];
        }
        imagenesPorRecurso[img.recurso_id].push({
          id: img.id,
          archivo: `http://localhost:3000/imagenes/${img.archivo}`
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
        let tarifaTotal = 0;
        let todasPersonasTienenTarifa = true;

        // Calcular tarifa por cada persona
        for (const persona of personas) {
          // Buscar todas las tarifas que apliquen para esta persona en este recurso
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
              ORDER BY fecha_inicio ASC
            `, [
              recurso.id,
              persona.tipo_persona_id,
              persona.regimen_id,
              persona.edad,
              persona.edad,
              fecha_fin,
              fecha_inicio
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

      const { fecha_inicio, fecha_fin, servicio_id, personas, recurso_id, filtros } = req.body;

      if (!fecha_inicio || !fecha_fin || !servicio_id || !personas || personas.length === 0) {
        return res.status(400).json("Faltan campos requeridos");
      }

      // Primero obtenemos solo los recursos que tienen tarifas válidas para el servicio y las personas
      const recursosValidos = new Set();
      for (const persona of personas) {
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
          `, [
            servicio_id,
            persona.tipo_persona_id,
            persona.regimen_id,
            persona.edad,
            persona.edad,
            fecha_fin,
            fecha_inicio
          ]);

        tarifasPersona.forEach(tarifa => {
          recursosValidos.add(tarifa.recurso_id);
        });
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
              ORDER BY fecha_inicio ASC
            `, [
              recurso.id,
              persona.tipo_persona_id,
              persona.regimen_id,
              persona.edad,
              persona.edad,
              fecha_fin,
              fecha_inicio
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
        adicionales
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
        let todasPersonasTienenTarifa = true;

        // Calcular tarifa por cada persona para este día específico
        for (const persona of personas) {
          // Buscar tarifa válida para esta persona en este día específico
          const [tarifasPersona] = await pool.query(
            `
              SELECT precio
              FROM tarifa 
              WHERE recurso_id = ? 
                AND tipo_persona_id = ? 
                AND regimen_id = ?
                AND (edad_minima IS NULL OR edad_minima <= ?)
                AND (edad_maxima IS NULL OR edad_maxima >= ?)
                AND fecha_inicio <= ?
                AND fecha_fin >= ?
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
              fechaString
            ]
          );

          if (tarifasPersona.length === 0) {
            // No hay tarifa válida para esta persona en este día
            todasPersonasTienenTarifa = false;
            break;
          }

          precioBaseDia += tarifasPersona[0].precio;
        }

        let totalExtrasDia = 0;
        const extrasDia = [];

        if (todasPersonasTienenTarifa && adicionalesSeleccionados.length > 0 && regimenIdSolicitud) {
          for (const adicional of adicionalesSeleccionados) {
            const precioVigente = await obtenerPrecioAdicional(
              pool,
              cacheAdicionales,
              recurso_id,
              regimenIdSolicitud,
              adicional.adicional_id,
              fechaString
            );

            if (precioVigente === null) {
              continue;
            }

            const subtotalExtra = precioVigente * adicional.cantidad;
            totalExtrasDia += subtotalExtra;
            extrasDia.push({
              adicional_id: adicional.adicional_id,
              cantidad: adicional.cantidad,
              precio_unitario: precioVigente,
              subtotal: subtotalExtra
            });
          }
        }

        const respuestaDia = {
          fecha: fechaString,
          precio: todasPersonasTienenTarifa ? precioBaseDia + totalExtrasDia : null
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
      const { recurso_id, regimen_id, fecha_inicio, fecha_fin } = req.body;

      if (!recurso_id || !regimen_id || !fecha_inicio || !fecha_fin) {
        return res.status(400).json("Faltan campos requeridos");
      }

      const [adicionales] = await mysqlConnection
        .promise()
        .query(
          `
            SELECT 
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
            ORDER BY ta.fecha_inicio ASC
          `,
          [recurso_id, regimen_id, fecha_inicio, fecha_fin]
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

const DIA_EN_MS = 1000 * 60 * 60 * 24;

async function obtenerPrecioAdicional(db, cache, recursoId, regimenId, adicionalId, fecha) {
  const cacheKey = `${recursoId}-${regimenId}-${adicionalId}-${fecha}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const [rows] = await db.query(
    `
      SELECT precio
      FROM tarifa_adicional
      WHERE recurso_id = ?
        AND regimen_id = ?
        AND adicional_id = ?
        AND fecha_inicio <= ?
        AND fecha_fin >= ?
      ORDER BY fecha_inicio DESC
      LIMIT 1
    `,
    [recursoId, regimenId, adicionalId, fecha, fecha]
  );

  const precio = rows.length > 0 ? Number(rows[0].precio) : null;
  cache.set(cacheKey, precio);
  return precio;
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

async function calcularAdicionalesReserva(connection, adicionales, recursoId, regimenId, fechaInicio, fechaFin) {
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

      const precioDia = await obtenerPrecioAdicional(connection, cachePrecios, recursoId, regimenId, adicionalId, fechaString);

      if (precioDia === null) {
        throw new Error(`No hay una tarifa de adicional vigente para la fecha ${fechaString}`);
      }

      const subtotalDia = precioDia * cantidad;
      subtotal += subtotalDia;
      detalles.push({
        fecha: fechaString,
        cantidad,
        precio_unitario: precioDia,
        subtotal: subtotalDia
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
        (reserva_id, adicional_id, nombre_adicional, cantidad, precio_unitario, dias, subtotal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        reservaId,
        adicional.adicional_id,
        adicional.nombre_adicional,
        adicional.cantidad,
        adicional.precio_referencia,
        adicional.dias,
        adicional.subtotal
      ]
    );

    const reservaAdicionalId = resultado.insertId;
    for (const detalle of adicional.detalles) {
      await connection.query(
        `INSERT INTO reserva_adicional_detalle
          (reserva_adicional_id, fecha, cantidad, precio_unitario, subtotal)
         VALUES (?, ?, ?, ?, ?)`,
        [
          reservaAdicionalId,
          detalle.fecha,
          detalle.cantidad,
          detalle.precio_unitario,
          detalle.subtotal
        ]
      );
    }
  }
}

async function obtenerAdicionalesReserva(connection, reservaId) {
  const [adicionales] = await connection.query(
    `SELECT id, adicional_id, nombre_adicional, cantidad, precio_unitario, dias, subtotal
     FROM reserva_adicional
     WHERE reserva_id = ?`,
    [reservaId]
  );

  if (adicionales.length === 0) {
    return [];
  }

  const ids = adicionales.map(a => a.id);
  const [detalles] = await connection.query(
    `SELECT reserva_adicional_id, fecha, cantidad, precio_unitario, subtotal
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
      subtotal: Number(detalle.subtotal)
    });
  }

  return adicionales.map(adicional => ({
    id: adicional.id,
    adicional_id: adicional.adicional_id,
    nombre: adicional.nombre_adicional,
    cantidad: adicional.cantidad,
    precio_unitario: Number(adicional.precio_unitario),
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
        adicionales
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

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Procesar firma si existe
        let firmaArchivo = null;
        if (firma) {
          const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
          const base64Data = firma.replace(/^data:image\/[a-z]+;base64,/, '');
          const firmaPath = path.join(__dirname, '../../imagenes', firmaFileName);
          fs.writeFileSync(firmaPath, base64Data, 'base64');
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
              fecha_fin
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
            regimen_id, recurso_id, usuario_id,
            firma_archivo, precio_total, fecha_inicio, fecha_fin, observaciones, monto_adicionales
          ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
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
        await connection.commit();

        const numeroReserva = `${reservaId}`;

        res.status(201).json({
          id: reservaId,
          numero_reserva: numeroReserva,
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

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Verificar que la reserva existe
        const [reservaExistente] = await connection.query(
          "SELECT id, usuario_id FROM reserva WHERE id = ?",
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

        // Procesar firma si existe
        let firmaArchivo = null;
        if (firma_base64) {
          const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
          const base64Data = firma_base64.replace(/^data:image\/[a-z]+;base64,/, '');
          const firmaPath = path.join(__dirname, '../../imagenes', firmaFileName);
          fs.writeFileSync(firmaPath, base64Data, 'base64');
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
              fecha_fin
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
        await connection.commit();

        const numeroReserva = `RES-${reservaId.toString().padStart(6, '0')}`;

        res.status(200).json({
          success: true,
          message: "Reserva actualizada correctamente",
          numero_reserva: numeroReserva,
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
            r.precio_total as total_tarifa,
            r.monto_adicionales,
            r.fecha_inicio,
            r.fecha_fin,
            r.observaciones,
            r.fecha_creacion,
            er.nombre as estado,
            s.id as servicio_id,
            s.nombre as servicio_nombre,
            s.lugar,
            rec.id as recurso_id,
            rec.nombre as recurso_nombre,
            reg.id as regimen_id,
            reg.nombre as regimen_nombre
          FROM reserva r
          LEFT JOIN estado_reserva er ON r.estado_reserva_id = er.id
          INNER JOIN recurso rec ON r.recurso_id = rec.id
          INNER JOIN servicio s ON rec.servicio_id = s.id
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
            rf.edad,
            rf.precio as tarifa_individual,
            rf.tipo_persona_id,
            rf.parentesco_id,
            tp.nombre as tipo_persona_nombre,
            p.nombre as parentesco_nombre
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
            es_titular: es_titular
          };
        });

        // Generar número de reserva
        const numeroReserva = `RES-${reserva.id.toString().padStart(6, '0')}`;

        // Construir respuesta para edición
        const respuesta = {
          id: reserva.id,
          numero_reserva: numeroReserva,
          nombre: reserva.observaciones || `Reserva ${numeroReserva}`,
          fecha_inicio: reserva.fecha_inicio,
          fecha_fin: reserva.fecha_fin,
          observaciones: reserva.observaciones,
          servicio: {
            id: reserva.servicio_id,
            nombre: reserva.servicio_nombre
          },
          recurso: {
            id: reserva.recurso_id,
            nombre: reserva.recurso_nombre,
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

        respuesta.adicionales = adicionalesReserva;
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
            r.precio_total as total_tarifa,
            r.monto_adicionales,
            r.fecha_inicio,
            r.fecha_fin,
            r.observaciones,
            r.fecha_creacion,
            r.firma_archivo,
            er.nombre as estado,
            s.id as servicio_id,
            s.nombre as servicio_nombre,
            s.lugar,
            rec.id as recurso_id,
            rec.nombre as recurso_nombre,
            reg.id as regimen_id,
            reg.nombre as regimen_nombre
          FROM reserva r
          LEFT JOIN estado_reserva er ON r.estado_reserva_id = er.id
          INNER JOIN recurso rec ON r.recurso_id = rec.id
          INNER JOIN servicio s ON rec.servicio_id = s.id
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
            rf.edad,
            rf.precio as tarifa_individual,
            tp.id as tipo_persona_id,
            tp.nombre as tipo_persona_nombre,
            p.id as parentesco_id,
            p.nombre as parentesco_nombre
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
          tarifa_individual: persona.tarifa_individual
        }));

        const adicionalesReserva = await obtenerAdicionalesReserva(connection, reservaId);

        // Generar número de reserva
        const numeroReserva = `${reserva.id}`;

        // Generar URL de firma si existe
        let firmaUrl = null;
        if (reserva.firma_archivo) {
          firmaUrl = `http://localhost:3000/imagenes/${reserva.firma_archivo}`;
        }

        // Construir respuesta
        const respuesta = {
          id: reserva.id,
          numero_reserva: numeroReserva,
          nombre: reserva.observaciones || `Reserva ${numeroReserva}`,
          estado: reserva.estado || "Confirmada",
          fecha_creacion: reserva.fecha_creacion,
          observaciones: reserva.observaciones,
          fecha_inicio: reserva.fecha_inicio,
          fecha_fin: reserva.fecha_fin,
          servicio: {
            id: reserva.servicio_id,
            nombre: reserva.servicio_nombre
          },
          lugar: reserva.lugar,
          recurso: {
            id: reserva.recurso_id,
            nombre: reserva.recurso_nombre
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
          adicionales: adicionalesReserva
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
          "SELECT id, estado_reserva_id FROM reserva WHERE id = ?",
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

    let orderBy = req.query.orderBy ? req.query.orderBy : "fecha_inicio";
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

    query += ` ORDER BY ${queryOrderBy}, fecha_inicio DESC LIMIT ${start}, ${resultsPerPage}`;

    try {
      const [rows] = await mysqlConnection.promise().execute(query, queryParams);

      const [countRows] = await mysqlConnection.promise().execute(
        `
        SELECT COUNT(*) AS count
        FROM temporada_tarifa
        WHERE 1=1 
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
      rec.nombre AS recurso,
      u.documento AS afiliado,
      DATE_FORMAT(r.fecha_inicio, '%d/%m/%Y') AS fecha_inicio,
      DATE_FORMAT(r.fecha_fin, '%d/%m/%Y') AS fecha_fin,
      COALESCE(r.observaciones, '') AS observaciones,
      DATE_FORMAT(r.fecha_creacion, '%d/%m/%Y') AS fecha_creacion
    FROM reserva r
    INNER JOIN estado_reserva er ON r.estado_reserva_id = er.id
    INNER JOIN recurso rec ON r.recurso_id = rec.id
    INNER JOIN servicio s ON rec.servicio_id = s.id
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
      INNER JOIN recurso rec ON r.recurso_id = rec.id
      INNER JOIN servicio s ON rec.servicio_id = s.id
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
            WHEN r.nombre = 'noafiliado' THEN 'No afiliado'
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
        noafiliado: "No afiliado"
      };

      const roles = rows.map(r => ({
        id: r.id,
        nombre: rolesMap[r.nombre] || r.nombre
      }));

      res.status(200).json(roles);
    } else if (cabecera.rol === "departamental") {
      const [rows] = await mysqlConnection
        .promise()
        .query("SELECT id, nombre FROM rol WHERE nombre IN ('afiliado', 'noafiliado') ORDER BY id ASC");

      const rolesMap = {
        afiliado: "Afiliado",
        noafiliado: "No afiliado"
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

router.post("/temporada", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "admin") {
      const { nombre_campania, fecha_inicio, fecha_fin, configuracion_servicios } = req.body;

      if (!nombre_campania || !fecha_inicio || !fecha_fin || !configuracion_servicios) {
        return res.status(400).json("Faltan campos requeridos");
      }

      // Iniciar transacción
      let connection;
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();

      try {
        // 1. Crear la temporada principal
        const [temporadaResult] = await connection.query(
          "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin) VALUES (?, ?, ?)",
          [nombre_campania, fecha_inicio, fecha_fin]
        );

        const temporadaId = temporadaResult.insertId;
        const adicionalesPorTemporada = [];

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

        // 2. Procesar cada servicio
        for (const servicio of configuracion_servicios) {
          // Procesar cada régimen del servicio
          for (const regimen of servicio.regimenes) {
            // Procesar cada recurso del régimen
            for (const recurso of regimen.recursos) {
              // Procesar cada fecha del recurso
              for (const fecha of recurso.fechas) {
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
                  // Procesar cada tipo de persona de la fecha
                  for (const tipoPersona of fecha.tiposPersona) {
                    // Procesar cada rango de edad del tipo de persona
                    for (const rangoEdad of tipoPersona.rangosEdad) {
                      // Insertar tarifa individual con tipos de persona
                      const [tarifaResult] = await connection.query(
                        `INSERT INTO tarifa
                         (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                          edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                          recurso.id,
                          tipoPersona.tipoPersonaId,
                          regimen.id,
                          temporadaId,
                          rangoEdad.edadMinima,
                          rangoEdad.edadMaxima,
                          rangoEdad.precio,
                          fecha.fecha_inicio,
                          fecha.fecha_fin,
                          'Y' // precio_por_persona como 'Y'
                        ]
                      );

                      // Guardar historial de creación de tarifa
                      await guardarHistorialTemporada(
                        connection,
                        temporadaId,
                        cabecera.id,
                        'CREATE',
                        `tarifa_${tarifaResult.insertId}`,
                        null,
                        JSON.stringify({
                          recurso_id: recurso.id,
                          tipo_persona_id: tipoPersona.tipoPersonaId,
                          regimen_id: regimen.id,
                          precio: rangoEdad.precio
                        })
                      );
                    }
                  }
                } else {
                  // Precio por recurso: insertar tarifa sin tipos de persona
                  const [tarifaResult] = await connection.query(
                    `INSERT INTO tarifa
                     (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                      edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                      'N' // precio_por_persona como 'N'
                    ]
                  );

                  // Guardar historial de creación de tarifa
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
                      precio: fecha.precio
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
    res.status(500).json("Error al crear la temporada");
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
          if (!fecha) {
            fecha = {
              id: tarifa.tarifa_id,
              fecha_inicio: tarifa.fecha_inicio,
              fecha_fin: tarifa.fecha_fin,
              precio: tarifa.precio_por_persona === 'N' ? tarifa.precio : null,
              tiposPersona: [],
              adicionales: [] // Los adicionales se pueden agregar después si es necesario
            };
            recurso.fechas.push(fecha);
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

            tipoPersona.rangosEdad.push({
              id: tarifa.tarifa_id,
              edadMinima: tarifa.edad_minima,
              edadMaxima: tarifa.edad_maxima,
              precio: tarifa.precio
            });
          }
        }

        const [adicionalRows] = await connection.query(
          `
            SELECT recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio
            FROM tarifa_adicional
            WHERE temporada_tarifa_id = ?
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

        // 4. Construir respuesta final
        const response = {
          nombre_campania: temporada.nombre,
          fecha_inicio: temporada.fecha_inicio,
          fecha_fin: temporada.fecha_fin,
          configuracion_servicios: Array.from(serviciosMap.values())
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
      const { nombre_campania, fecha_inicio, fecha_fin, configuracion_servicios } = req.body;

      if (!nombre_campania || !fecha_inicio || !fecha_fin || !configuracion_servicios) {
        return res.status(400).json("Faltan campos requeridos");
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

        const [adicionalesAnteriores] = await connection.query(
          "SELECT id FROM tarifa_adicional WHERE temporada_tarifa_id = ?",
          [id]
        );

        if (adicionalesAnteriores.length > 0) {
          await guardarHistorialTemporada(
            connection,
            id,
            cabecera.id,
            'DELETE',
            'tarifa_adicional',
            JSON.stringify({ cantidad: adicionalesAnteriores.length }),
            null
          );
        }

        await connection.query(
          "DELETE FROM tarifa_adicional WHERE temporada_tarifa_id = ?",
          [id]
        );

        // 4. Insertar las nuevas tarifas (mismo código que POST)
        for (const servicio of configuracion_servicios) {
          for (const regimen of servicio.regimenes) {
              for (const recurso of regimen.recursos) {
                for (const fecha of recurso.fechas) {
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
                  for (const tipoPersona of fecha.tiposPersona) {
                    for (const rangoEdad of tipoPersona.rangosEdad) {
                      const [tarifaResult] = await connection.query(
                        `INSERT INTO tarifa
                         (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                          edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                          recurso.id,
                          tipoPersona.tipoPersonaId,
                          regimen.id,
                          id,
                          rangoEdad.edadMinima,
                          rangoEdad.edadMaxima,
                          rangoEdad.precio,
                          fecha.fecha_inicio,
                          fecha.fecha_fin,
                          'Y'
                        ]
                      );

                      // Guardar historial de creación de nueva tarifa
                      await guardarHistorialTemporada(
                        connection,
                        id,
                        cabecera.id,
                        'CREATE',
                        `tarifa_${tarifaResult.insertId}`,
                        null,
                        JSON.stringify({
                          recurso_id: recurso.id,
                          tipo_persona_id: tipoPersona.tipoPersonaId,
                          regimen_id: regimen.id,
                          precio: rangoEdad.precio
                        })
                      );
                    }
                  }
                } else {
                  const [tarifaResult] = await connection.query(
                    `INSERT INTO tarifa
                     (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
                      edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin, precio_por_persona)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                      'N'
                    ]
                  );

                  // Guardar historial de creación de nueva tarifa
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
                      precio: fecha.precio
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
    res.status(500).json("Error al actualizar la temporada");
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
      const fotoPath = path.join(__dirname, '../../imagenes', usuarioData.foto_archivo);
      if (fs.existsSync(fotoPath)) {
        try {
          const fotoBuffer = fs.readFileSync(fotoPath);
          const fotoBase64 = fotoBuffer.toString('base64');
          const mimeType = usuarioData.foto_archivo.match(/\.(jpg|jpeg|png|gif)$/i);
          const mimeTypeStr = mimeType ? `image/${mimeType[1].toLowerCase()}` : 'image/jpeg';
          usuarioData.foto_data = `data:${mimeTypeStr};base64,${fotoBase64}`;
        } catch (readError) {
          console.error('Error leyendo foto:', readError);
          usuarioData.foto_data = null;
        }
      } else {
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
          const extension = req.file.originalname.split('.').pop();
          const nombreArchivo = `perfil_${fotoHash}.${extension}`;
          const rutaArchivo = path.join(__dirname, '../../imagenes', nombreArchivo);

          // Guardar archivo en disco
          fs.writeFileSync(rutaArchivo, req.file.buffer);

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
          const extension = req.file.originalname.split('.').pop();
          nombreArchivo = `perfil_${fotoHash}.${extension}`;
          const rutaArchivo = path.join(__dirname, '../../imagenes', nombreArchivo);

          // Guardar archivo en disco
          fs.writeFileSync(rutaArchivo, req.file.buffer);

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
