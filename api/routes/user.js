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
    SELECT usuario.id, usuario.nombre, usuario.apellido, usuario.documento, usuario.email, usuario.password, usuario.departamental_id, rol.nombre AS rol, usuario.habilitado
    FROM usuario
    INNER JOIN rol ON rol.id = usuario.rol_id
    WHERE usuario.documento = ? AND usuario.password IS NOT NULL
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
      let query = "SELECT id, tipo_servicio_id, nombre, lugar, rating FROM servicio";
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

      // Agregar campo imagenes a cada servicio
      const serviciosConImagenes = servicios.map(servicio => ({
        ...servicio,
        imagenes: imagenesPorServicio[servicio.id] || []
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

router.post("/reserva/recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const { fecha_inicio, fecha_fin, servicio_id, personas } = req.body;

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

      // Ahora obtenemos solo los recursos que tienen tarifas válidas
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
      const [filtros] = await mysqlConnection
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
      filtros.forEach(filtro => {
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

      // Calcular tarifas para cada recurso
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
          recursosConTarifas.push({
            id: recurso.id,
            servicio_id: recurso.servicio_id,
            grupo_recurso_id: recurso.grupo_recurso_id,
            nombre: recurso.nombre,
            tarifa: tarifaTotal,
            imagenes: imagenesPorRecurso[recurso.id] || [],
            filtros: filtrosPorRecurso[recurso.id] || []
          });
        }

      }

      res.status(200).json(recursosConTarifas);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los recursos con tarifas");
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
      const { fecha_inicio, fecha_fin, servicio_id, recurso_id, personas } = req.body;

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

      // Array para almacenar el resultado
      const fechasConTarifa = [];

      // Verificar que el recurso pertenezca al servicio
      const [recursoValido] = await mysqlConnection
        .promise()
        .query(`
          SELECT id FROM recurso 
          WHERE id = ? AND servicio_id = ?
        `, [recurso_id, servicio_id]);

      if (recursoValido.length === 0) {
        return res.status(404).json("El recurso no pertenece al servicio especificado");
      }

      // Procesar cada día del rango
      for (let dia = 0; dia < diasTotales; dia++) {
        const fechaActual = new Date(fechaInicioSolicitud);
        fechaActual.setDate(fechaInicioSolicitud.getDate() + dia);

        const fechaString = fechaActual.toISOString().split('T')[0];
        let precioTotalDia = 0;
        let todasPersonasTienenTarifa = true;

        // Calcular tarifa por cada persona para este día específico
        for (const persona of personas) {
          // Buscar tarifa válida para esta persona en este día específico
          const [tarifasPersona] = await mysqlConnection
            .promise()
            .query(`
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
            `, [
              recurso_id,
              persona.tipo_persona_id,
              persona.regimen_id,
              persona.edad,
              persona.edad,
              fechaString,
              fechaString
            ]);

          if (tarifasPersona.length === 0) {
            // No hay tarifa válida para esta persona en este día
            todasPersonasTienenTarifa = false;
            break;
          }

          precioTotalDia += tarifasPersona[0].precio;
        }

        // Agregar el resultado para este día
        fechasConTarifa.push({
          fecha: fechaString,
          precio: todasPersonasTienenTarifa ? precioTotalDia : null
        });
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

router.post("/reserva", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado"
    ) {
      const {
        nombre,
        observaciones,
        fecha_inicio,
        fecha_fin,
        servicio_id,
        recurso_id,
        tipo_servicio_id,
        regimen_id,
        personas,
        viaja_titular,
        adultos,
        ninos,
        bebes,
        total_tarifa,
        firma
      } = req.body;

      // Validar campos requeridos
      if (!nombre || !fecha_inicio || !fecha_fin || !servicio_id || !recurso_id ||
        !regimen_id || !personas || personas.length === 0 || !total_tarifa) {
        return res.status(400).json("Faltan campos requeridos");
      }

      let connection;
      try {
        // Iniciar transacción
        connection = await mysqlConnection.promise().getConnection();
        await connection.beginTransaction();

        // Procesar firma si existe
        let firmaArchivo = null;
        if (firma) {
          // Generar nombre único para el archivo
          const firmaFileName = `firma_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;

          // Remover el prefijo data:image si existe
          const base64Data = firma.replace(/^data:image\/[a-z]+;base64,/, '');

          // Guardar archivo en carpeta imagenes
          const firmaPath = path.join(__dirname, '../../imagenes', firmaFileName);
          fs.writeFileSync(firmaPath, base64Data, 'base64');

          firmaArchivo = firmaFileName;
        }

        // Obtener el usuario familiar principal del usuario que crea la reserva
        const [usuarioCreador] = await connection.query(
          "SELECT id, usuario_familiar_id FROM usuario WHERE id = ?",
          [cabecera.id]
        );

        let usuarioFamiliarPrincipalId = cabecera.id;

        if (usuarioCreador.length > 0) {
          let currentUserId = usuarioCreador[0].id;
          let currentUserFamiliarId = usuarioCreador[0].usuario_familiar_id;

          // Buscar el usuario principal de la familia (el que tiene usuario_familiar_id NULL)
          while (currentUserFamiliarId !== null) {
            const [nextUser] = await connection.query(
              "SELECT id, usuario_familiar_id FROM usuario WHERE id = ?",
              [currentUserFamiliarId]
            );

            if (nextUser.length > 0) {
              currentUserId = nextUser[0].id;
              currentUserFamiliarId = nextUser[0].usuario_familiar_id;
            } else {
              break;
            }
          }

          usuarioFamiliarPrincipalId = currentUserId;
        }

        // Crear o buscar usuarios para cada persona
        const usuariosIds = [];
        for (const persona of personas) {
          // Verificar si el usuario ya existe por documento
          const [existeUsuario] = await connection.query(
            "SELECT id FROM usuario WHERE documento = ?",
            [persona.dni]
          );

          let usuarioId;
          if (existeUsuario.length > 0) {
            usuarioId = existeUsuario[0].id;
          } else {
            // Crear nuevo usuario con usuario_familiar_id establecido
            const [nuevoUsuario] = await connection.query(
              `INSERT INTO usuario (
                rol_id, parentesco_id, nombre, apellido, fecha_nacimiento, 
                documento, contacto, password, usuario_familiar_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
              [
                2, // Rol de "afiliado"
                persona.parentesco_id,
                persona.nombre,
                persona.apellido,
                persona.fecha_nacimiento,
                persona.dni,
                persona.contacto || null,
                usuarioFamiliarPrincipalId
              ]
            );
            usuarioId = nuevoUsuario.insertId;
          }
          usuariosIds.push({
            ...persona,
            usuario_id: usuarioId
          });
        }

        // Insertar reserva principal
        const [reservaResult] = await connection.query(
          `INSERT INTO reserva (
            subtipo_servicio_id, regimen_id, recurso_id, usuario_id,
            firma_archivo, precio_total, fecha_inicio, fecha_fin, observaciones
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tipo_servicio_id || null,
            regimen_id,
            recurso_id,
            cabecera.id, // Usuario que hace la reserva
            firmaArchivo,
            total_tarifa,
            fecha_inicio,
            fecha_fin,
            observaciones || null
          ]
        );

        const reservaId = reservaResult.insertId;

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

            // Buscar tarifa correspondiente para esta persona en esta fecha
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

        // Generar número de reserva
        // const numeroReserva = `RES-${reservaId.toString().padStart(6, '0')}`;
        const numeroReserva = `${reservaId}`;

        res.status(201).json({
          id: reservaId,
          numero_reserva: numeroReserva,
          estado: "Confirmada",
          mensaje: "Reserva creada exitosamente",
          fecha_creacion: new Date().toISOString()
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
    res.status(500).json("Error al procesar la reserva");
  }
});

router.get("/acompaniantes", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (
      cabecera.rol === "admin" ||
      cabecera.rol === "afiliado" ||
      cabecera.rol === "departamental"
    ) {
      const usuario_id = req.query.usuario_id;
      
      if (!usuario_id) {
        return res.status(400).json("Falta el parámetro 'usuario_id'");
      }

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
            u.contacto,
            u.parentesco_id,
            NULL as tipo_persona_id
          FROM usuario u
          WHERE u.usuario_familiar_id = ?`,
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
              u.contacto,
              u.parentesco_id,
              NULL as tipo_persona_id
            FROM usuario u
            WHERE u.id = ?`,
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
            u.contacto,
            COALESCE(
              (SELECT rf2.parentesco_id 
               FROM reserva_familiar rf2 
               WHERE rf2.usuario_id = u.id 
                 AND rf2.reserva_id IN (
                   SELECT rf_main.reserva_id 
                   FROM reserva_familiar rf_main 
                   WHERE rf_main.usuario_id = ?
                 )
               ORDER BY rf2.fecha_creacion DESC 
               LIMIT 1), 
              u.parentesco_id
            ) as parentesco_id,
            (SELECT rf2.tipo_persona_id 
             FROM reserva_familiar rf2 
             WHERE rf2.usuario_id = u.id 
               AND rf2.reserva_id IN (
                 SELECT rf_main.reserva_id 
                 FROM reserva_familiar rf_main 
                 WHERE rf_main.usuario_id = ?
               )
             ORDER BY rf2.fecha_creacion DESC 
             LIMIT 1) as tipo_persona_id
          FROM usuario u
          INNER JOIN reserva_familiar rf ON u.id = rf.usuario_id
          WHERE rf.reserva_id IN (
            SELECT reserva_id 
            FROM reserva_familiar 
            WHERE usuario_id = ?
          )
          AND u.id != ?`,
          [usuario_id, usuario_id, usuario_id, usuario_id]
        );

      companierosReserva.forEach(companiero => {
        // Si ya existe en acompañantes (familiar), actualizar con datos de reserva si están disponibles
        if (acompaniantes.has(companiero.usuario_id)) {
          const existing = acompaniantes.get(companiero.usuario_id);
          if (companiero.tipo_persona_id) {
            existing.tipo_persona_id = companiero.tipo_persona_id;
          }
          if (companiero.parentesco_id) {
            existing.parentesco_id = companiero.parentesco_id;
          }
        } else {
          // Es nuevo, agregarlo
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

router.get("/subtipo_servicio", verifyToken, async (req, res) => {
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
          `SELECT sbs.id, sbs.nombre
         FROM servicio s
         INNER JOIN subtipo_servicio sbs ON s.tipo_servicio_id = sbs.tipo_servicio_id
         WHERE s.id = ?`,
          [servicioId]
        );
      res.status(200).json(rows);
    } catch (error) {
      console.log(error);
      res.status(500).json("Error al obtener los tipos de servicio");
    }
  } else {
    res.status(401).json("No autorizado");
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

router.post("/tabla-temporadas", verifyToken, async (req, res) => {
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
            contacto, 
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

        // 2. Procesar cada servicio
        for (const servicio of configuracion_servicios) {
          // Procesar cada régimen del servicio
          for (const regimen of servicio.regimenes) {
            // Procesar cada recurso del régimen
            for (const recurso of regimen.recursos) {
              // Procesar cada fecha del recurso
              for (const fecha of recurso.fechas) {
                // Procesar cada tipo de persona de la fecha
                for (const tipoPersona of fecha.tiposPersona) {
                  // Procesar cada rango de edad del tipo de persona
                  for (const rangoEdad of tipoPersona.rangosEdad) {
                    // Insertar tarifa individual
                    await connection.query(
                      `INSERT INTO tarifa 
                       (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id, 
                        edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                      [
                        recurso.id,
                        tipoPersona.tipoPersonaId,
                        regimen.id,
                        temporadaId,
                        rangoEdad.edadMinima,
                        rangoEdad.edadMaxima,
                        rangoEdad.precio,
                        fecha.fecha_inicio,
                        fecha.fecha_fin
                      ]
                    );
                  }
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



const storage = multer.memoryStorage();
var uploadImagen = multer({ storage: storage });
var uploadMultipleImagen = uploadImagen.fields([
  { name: "rostro" },
  { name: "dni_frente" },
  { name: "dni_dorso" },
]);

router.post("/alta/ditor", uploadMultipleImagen, (req, res) => {
  // formulario tiene: nombre, apellido, password, email, dni, celular, fecha_nacimiento, rostro, dni_frente, dni_dorso
  // formulario = JSON.parse(req.body);
  formulario = req.body;

  if (req.files.rostro && req.files.dni_frente && req.files.dni_dorso) {
    var funcionesSubidaS3Paralela = [];
    if (req.files.rostro) {
      req.files.rostro[0].filename = randomImageName();
      const paramsRostro = {
        Bucket: bucketName,
        Key: req.files.rostro[0].filename,
        Body: req.files.rostro[0].buffer,
        ContentType: "image/jpeg",
      };
      const commandRostro = new PutObjectCommand(paramsRostro);
      funcionesSubidaS3Paralela.push(s3.send(commandRostro));
    }
    if (req.files.dni_frente) {
      req.files.dni_frente[0].filename = randomImageName();
      const paramsDniFrente = {
        Bucket: bucketName,
        Key: req.files.dni_frente[0].filename,
        Body: req.files.dni_frente[0].buffer,
        ContentType: "image/jpeg",
      };
      const commandDniFrente = new PutObjectCommand(paramsDniFrente);
      funcionesSubidaS3Paralela.push(s3.send(commandDniFrente));
    }
    if (req.files.dni_dorso) {
      req.files.dni_dorso[0].filename = randomImageName();
      const paramsDniDorso = {
        Bucket: bucketName,
        Key: req.files.dni_dorso[0].filename,
        Body: req.files.dni_dorso[0].buffer,
        ContentType: "image/jpeg",
      };
      const commandDniDorso = new PutObjectCommand(paramsDniDorso);
      funcionesSubidaS3Paralela.push(s3.send(commandDniDorso));
    }

    Promise.all(funcionesSubidaS3Paralela).then(successCallback, errorCallback);
    async function successCallback(result) {
      if (req.files) {
        console.log("se subieron los archivos");
        let passwordHash = await bcryptjs.hash(formulario.password, 8);
        // alta Usuario
        mysqlConnection.query(
          `insert into usuario(nombre,apellido,password,email,cliente,rol) \
        values(${formulario.nombre ? `'${formulario.nombre}'` : null},${formulario.apellido ? `'${formulario.apellido}'` : null
          },'${passwordHash}',${formulario.email ? `'${formulario.email}'` : null
          },${formulario.cliente ? `'${formulario.cliente}'` : null},'3')`,
          (err, rowsUsuario, fields) => {
            if (err) {
              throw err;
            } else {
              // alta Ditor
              queryDitor = `insert into ditor(usuario) values('${rowsUsuario.insertId}');`;
              queryImagen = `insert into fotos_validacion_ditor(ditor,rostro,dni_frente,dni_dorso) \
        values('${rowsUsuario.insertId}',${req.files.rostro ? `'${req.files.rostro[0].filename}'` : null
                },${req.files.dni_frente
                  ? `'${req.files.dni_frente[0].filename}'`
                  : null
                },${req.files.dni_dorso
                  ? `'${req.files.dni_dorso[0].filename}'`
                  : null
                });`;
              // generar codigo_referido y guardarlo en la tabla perfil_ditor, el formato debe ser DITOR + guion + 5 primeras letras del nombre (si tiene menos, dejar hasta donde llegue) + id del usuario
              let codigo_referido =
                "DITOR-" +
                formulario.nombre.substring(0, 5).toUpperCase() +
                "-" +
                rowsUsuario.insertId;
              // fecha de nacimiento DATE '1997-12-31'
              queryPerfil = `insert into perfil_ditor(ditor,dni,celular,fecha_nacimiento,codigo_referido,foto) \
        values('${rowsUsuario.insertId}',${formulario.dni ? `'${formulario.dni}'` : null
                },${formulario.celular ? `'${formulario.celular}'` : null},${formulario.fecha_nacimiento
                  ? `'${formulario.fecha_nacimiento}'`
                  : null
                }, '${codigo_referido}', ${req.files.rostro ? `'${req.files.rostro[0].filename}'` : null
                });`;
              mysqlConnection.query(
                queryDitor + queryImagen + queryPerfil,
                (err, rows, fields) => {
                  if (err) {
                    res.status(500).json(err);
                  } else {
                    res.status(200).json("Ditor creado correctamente");
                  }
                }
              );
            }
          }
        );
      }
    }
    function errorCallback(err) {
      console.log("Error de subida de archivos al bucket", err);
      res.send(err);
    }
  } else {
    res.json("imagen no llegó");
  }
});

router.post("/posicion", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  try {
    if (cabecera.rol === "ditor") {
      const latitud = req.query.latitud;
      const longitud = req.query.longitud;
      const coordenadas = `POINT(${longitud} ${latitud})`;

      // Buscar si ya existe una posicion para el ditor
      const [rowsPosicion] = await mysqlConnection
        .promise()
        .execute(`SELECT * FROM posicion_actual_ditor WHERE usuario = ?`, [
          cabecera.id,
        ]);
      // Si ya existe una posicion, actualizarla
      if (rowsPosicion.length > 0) {
        const [rows] = await mysqlConnection
          .promise()
          .execute(
            `UPDATE posicion_actual_ditor SET coordenadas = ST_GeomFromText(?) WHERE usuario = ?`,
            [coordenadas, cabecera.id]
          );
        if (rows.affectedRows > 0) {
          res.status(200).json("Posicion actualizada correctamente");
        } else {
          res.status(500).json("No se pudo actualizar la posicion");
        }
      } else {
        // Si no existe una posicion, insertarla
        const [rows] = await mysqlConnection
          .promise()
          .execute(
            `INSERT INTO posicion_actual_ditor (usuario, coordenadas) VALUES (?, ST_GeomFromText(?))`,
            [cabecera.id, coordenadas]
          );
        if (rows.affectedRows > 0) {
          res.status(200).json("Posicion guardada correctamente");
        } else {
          res.status(500).json("No se pudo guardar la posicion");
        }
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  } catch (error) {
    console.log(error);
    res.status(500).send("An error occurred while trying to save the position");
  }
});

var uploadComercioSugerido = multer({ storage: storage });
var uploadMultipleComercioSugerido = uploadComercioSugerido.fields([
  { name: "comercio_sugerido" },
]);

router.post(
  "/modify/comercio-sugerido",
  uploadMultipleComercioSugerido,
  async (req, res) => {
    // formulario tiene: nombre_comercio, direccion, tipo_comercio, horario_visita, nombre_contacto, apellido_contacto, telefono, mail, lat, long, observaciones_generales, finalizado

    const idComercioSugerido = req.query.idComercioSugerido;

    const formulario = req.body;

    const coordenadas = `POINT(${formulario.lon} ${formulario.lat})`;

    const existefoto = formulario.nueva_foto;

    if (idComercioSugerido) {
      if (existefoto != "false") {
        if (req.files.comercio_sugerido) {
          var [rows] = await mysqlConnection
            .promise()
            .execute(
              "SELECT foto_frente_comercio FROM comercio_sugerido WHERE id = ?",
              [idComercioSugerido]
            );
          // si rows.foto_frente_comercio es distinto de null debo eliminar las fotos subidas al bucket de s3
          if (rows.length > 0) {
            if (
              rows[0].foto_frente_comercio !== null &&
              rows[0].foto_frente_comercio !== "" &&
              rows[0].foto_frente_comercio !== undefined
            ) {
              // eliminar la foto_frente_comercio del bucket de s3
              var archivosParaEliminar = [];
              params = {
                Bucket: bucketName,
                Delete: {
                  Objects: [],
                  Quiet: false,
                },
              };

              archivosParaEliminar.push(rows[0].foto_frente_comercio);

              console.log("ARCHIVO PARA ELIMINAR: ", archivosParaEliminar);
              if (archivosParaEliminar.length > 0) {
                params.Delete.Objects.push({
                  Key: archivosParaEliminar[0],
                });
                command = new DeleteObjectsCommand(params);
                await s3.send(command);
              }
            }
          } else {
            res.status(500).send("Error interno");
          }

          var funcionesSubidaS3Paralela = [];

          req.files.comercio_sugerido[0].filename = randomImageName();
          const paramsComerciosugerido = {
            Bucket: bucketName,
            Key: req.files.comercio_sugerido[0].filename,
            Body: req.files.comercio_sugerido[0].buffer,
            ContentType: req.files.comercio_sugerido[0].mimetype,
          };
          const commandComerciosugerido = new PutObjectCommand(
            paramsComerciosugerido
          );
          funcionesSubidaS3Paralela.push(s3.send(commandComerciosugerido));

          Promise.all(funcionesSubidaS3Paralela).then(
            successCallback,
            errorCallback
          );
          function successCallback(result) {
            const query = `UPDATE comercio_sugerido SET
                          nombre_comercio = ?, direccion = ?, tipo_comercio = ?, horario_visita = ?, 
                          nombre_contacto = ?, apellido_contacto = ?, telefono = ?, mail = ?, version = ?,
                          coordenadas = ST_GeomFromText(?), observaciones_generales = ?, 
                          foto_frente_comercio = ?, finalizado = ?
                          WHERE id = ?`;

            const values = [
              formulario.nombre_comercio || null,
              formulario.direccion || null,
              formulario.tipo_comercio || null,
              formulario.horario_visita || null,
              formulario.nombre_contacto || null,
              formulario.apellido_contacto || null,
              formulario.telefono || null,
              formulario.mail || null,
              formulario.version || null,
              coordenadas,
              formulario.observaciones_generales || null,
              req.files.comercio_sugerido[0].filename,
              formulario.finalizado || "N",
              idComercioSugerido,
            ];

            mysqlConnection.query(query, values, (err, results) => {
              if (err) {
                res.status(500).json(err);
              } else {
                res
                  .status(200)
                  .json(
                    "Comercio sugerido modificado (con imagen) correctamente"
                  );
              }
            });
          }
          function errorCallback(err) {
            console.log("Error de subida de archivos al bucket", err);
            res.send(err);
          }
        } else {
          res.status(500).json("Faltan datos");
        }
      } else {
        const query = `UPDATE comercio_sugerido SET
                        nombre_comercio = ?, direccion = ?, tipo_comercio = ?, horario_visita = ?, 
                        nombre_contacto = ?, apellido_contacto = ?, telefono = ?, mail = ?, version = ?,
                        coordenadas = ST_GeomFromText(?), observaciones_generales = ?, 
                        finalizado = ?
                        WHERE id = ?`;

        const values = [
          formulario.nombre_comercio || null,
          formulario.direccion || null,
          formulario.tipo_comercio || null,
          formulario.horario_visita || null,
          formulario.nombre_contacto || null,
          formulario.apellido_contacto || null,
          formulario.telefono || null,
          formulario.mail || null,
          formulario.version || null,
          coordenadas,
          formulario.observaciones_generales || null,
          formulario.finalizado || "N",
          idComercioSugerido,
        ];

        mysqlConnection.query(query, values, (err, results) => {
          if (err) {
            res.status(500).json(err);
          } else {
            res
              .status(200)
              .json("Comercio sugerido modificado (sin imagen) correctamente");
          }
        });
      }
    } else {
      res.status(400).json("No se ingreso id comercio sugerido");
    }
  }
);

var uploadComercioSugerido = multer({ storage: storage });
var uploadMultipleComercioSugerido = uploadComercioSugerido.fields([
  { name: "comercio_sugerido" },
]);

router.post(
  "/alta/comercio_sugerido",
  verifyToken,
  uploadMultipleComercioSugerido,
  (req, res) => {
    // formulario tiene: nombre_comercio, direccion, tipo_comercio, horario_visita, nombre_contacto, apellido_contacto, telefono, mail, lat, long, observaciones_generales, finalizado

    const cabecera = JSON.parse(req.data.data);

    const idCliente = cabecera.client_id;
    const idZnapper = cabecera.id;

    const formulario = req.body;

    let lon = formulario.lon;
    let lat = formulario.lat;

    let coordenadas = `POINT(${lon} ${lat})`;

    // alta comercio_sugerido

    if (req.files.comercio_sugerido) {
      var funcionesSubidaS3Paralela = [];

      req.files.comercio_sugerido[0].filename = randomImageName();
      const paramsComerciosugerido = {
        Bucket: bucketName,
        Key: req.files.comercio_sugerido[0].filename,
        Body: req.files.comercio_sugerido[0].buffer,
        ContentType: req.files.comercio_sugerido[0].mimetype,
      };
      const commandComerciosugerido = new PutObjectCommand(
        paramsComerciosugerido
      );
      funcionesSubidaS3Paralela.push(s3.send(commandComerciosugerido));

      Promise.all(funcionesSubidaS3Paralela).then(
        successCallback,
        errorCallback
      );
      function successCallback(result) {
        // let query = `insert into comercio_sugerido
        // (cliente, sugerido_por_znapper, nombre_comercio, direccion, tipo_comercio, horario_visita, nombre_contacto, apellido_contacto, telefono, mail, coordenadas, observaciones_generales, foto_frente_comercio)
        //           values
        //           ('${idCliente}', '${idZnapper}', '${formulario.nombre_comercio ? formulario.nombre_comercio : null
        //   }', '${formulario.direccion ? formulario.direccion : null
        //   }', '${formulario.tipo_comercio ? formulario.tipo_comercio : null}', '${formulario.horario_visita ? formulario.horario_visita : null
        //   }', '${formulario.nombre_contacto ? formulario.nombre_contacto : null
        //   }', '${formulario.apellido_contacto ? formulario.apellido_contacto : null
        //   }', '${formulario.telefono ? formulario.telefono : null
        //   }', '${formulario.mail ? formulario.mail : null
        //   }', '${coordenadas}', '${formulario.observaciones_generales ? formulario.observaciones_generales : null
        //   }', '${req.files.comercio_sugerido[0].filename}')`;

        // mysqlConnection.query(
        //   query,
        //   (err, rows, fields) => {
        //     if (err) {
        //       res.status(500).json(err);
        //     } else {
        //       res.status(200).json("Comercio sugerido creado correctamente");
        //     }
        //   }
        // );

        const query = `INSERT INTO comercio_sugerido
      (cliente, sugerido_por_znapper, nombre_comercio, direccion, tipo_comercio, horario_visita, nombre_contacto, apellido_contacto, telefono, mail, version, coordenadas, observaciones_generales, foto_frente_comercio, finalizado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?), ?, ?, ?)`;

        const values = [
          idCliente,
          idZnapper,
          formulario.nombre_comercio || null,
          formulario.direccion || null,
          formulario.tipo_comercio || null,
          formulario.horario_visita || null,
          formulario.nombre_contacto || null,
          formulario.apellido_contacto || null,
          formulario.telefono || null,
          formulario.mail || null,
          formulario.version || null,
          coordenadas,
          formulario.observaciones_generales || null,
          req.files.comercio_sugerido[0].filename,
          "N",
        ];

        mysqlConnection.query(query, values, (err, results) => {
          if (err) {
            res.status(500).json(err);
          } else {
            res.status(200).json("Comercio sugerido creado correctamente");
          }
        });
      }
      function errorCallback(err) {
        console.log("Error de subida de archivos al bucket", err);
        res.send(err);
      }
    } else {
      res.status(500).json("Faltan datos");
    }
  }
);

var uploadVisitaNoProgramada = multer({ storage: storage });
var uploadMultipleVisitaNoProgramada = uploadVisitaNoProgramada.fields([
  { name: "visita_no_programada" },
]);

router.post(
  "/alta/visita_no_programada",
  verifyToken,
  uploadMultipleVisitaNoProgramada,
  (req, res) => {
    // formulario tiene: nombre_comercio, direccion, id_comercio, numero_cliente, nombre_contacto, apellido_contacto, telefono, mail, lat, long, observaciones_generales

    const cabecera = JSON.parse(req.data.data);

    const idCliente = cabecera.client_id;
    const idZnapper = cabecera.id;

    const formulario = req.body;

    let lon = formulario.lon;
    let lat = formulario.lat;

    let coordenadas = `POINT(${lon} ${lat})`;

    // alta visita_no_programada

    if (req.files.visita_no_programada) {
      var funcionesSubidaS3Paralela = [];

      req.files.visita_no_programada[0].filename = randomImageName();
      const paramsVisitaNoProgramada = {
        Bucket: bucketName,
        Key: req.files.visita_no_programada[0].filename,
        Body: req.files.visita_no_programada[0].buffer,
        ContentType: req.files.visita_no_programada[0].mimetype,
      };
      const commandVisitaNoProgramada = new PutObjectCommand(
        paramsVisitaNoProgramada
      );
      funcionesSubidaS3Paralela.push(s3.send(commandVisitaNoProgramada));

      Promise.all(funcionesSubidaS3Paralela).then(
        successCallback,
        errorCallback
      );
      function successCallback(result) {
        const query = `INSERT INTO visita_no_programada
      (cliente, visitado_por_znapper, nombre_comercio, direccion, id_comercio, numero_cliente, nombre_contacto, apellido_contacto, telefono, mail, version, coordenadas, observaciones_generales, foto_frente_comercio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?), ?, ?)`;

        const values = [
          idCliente,
          idZnapper,
          formulario.nombre_comercio || null,
          formulario.direccion || null,
          formulario.id_comercio || null,
          formulario.numero_cliente || null,
          formulario.nombre_contacto || null,
          formulario.apellido_contacto || null,
          formulario.telefono || null,
          formulario.mail || null,
          formulario.version || null,
          coordenadas,
          formulario.observaciones_generales || null,
          req.files.visita_no_programada[0].filename,
        ];

        mysqlConnection.query(query, values, (err, results) => {
          if (err) {
            res.status(500).json(err);
          } else {
            res.status(200).json("Visita no programada creada correctamente");
          }
        });
      }
      function errorCallback(err) {
        console.log("Error de subida de archivos al bucket", err);
        res.send(err);
      }
    } else {
      res.status(500).json("Faltan datos");
    }
  }
);

router.get("/verificarExistencia/buscar", (req, res) => {
  // const cabecera = JSON.parse(req.data.data);
  // check if query string is empty
  if (Object.keys(req.query).length === 0) {
    res.json("No se ingreso ningun parametro de busqueda");
  } else {
    var email = req.query.email ? req.query.email : null;
    // check if query string is valid
    if (email) {
      //return json with param value 'existe' if exists in db or false if not exists in db
      mysqlConnection.query(
        `select * from usuario where email = '${email}'`,
        (err, rows, fields) => {
          if (err) {
            throw err;
          }
          if (rows.length > 0) {
            res.json({ existe: true });
          } else {
            res.json({ existe: false });
          }
        }
      );
    } else {
      res.status(400).json("No se ingreso ningun parametro de busqueda");
    }
  }
});

router.get("/recuperarPassword/buscar", (req, res) => {
  // const cabecera = JSON.parse(req.data.data);
  // check if query string is empty
  if (Object.keys(req.query).length === 0) {
    res.json("No se ingreso ningun parametro de busqueda");
  } else {
    var email = req.query.email ? req.query.email : null;
    // check if query string is valid
    if (email) {
      mysqlConnection.query(
        `select u.id as id, u.email as email, p.celular as celular from usuario u \
      inner join perfil_ditor p on u.id = p.ditor \
      where u.email = '${email}'`,
        (err, rows, fields) => {
          if (err) {
            throw err;
          }
          if (rows.length > 0) {
            res.json(rows[0]);
          } else {
            res.json({ id: null, email: null, celular: null });
          }
        }
      );
    } else {
      res.status(400).json("No se ingreso ningun parametro de busqueda");
    }
  }
});

router.put("/recuperarPassword", async (req, res) => {
  // const cabecera = JSON.parse(req.data.data);
  const { id, password } = req.body;
  if (id && password) {
    let passwordHash = await bcryptjs.hash(password, 8);
    mysqlConnection.query(
      `update usuario set password = '${passwordHash}' where id = '${id}'`,
      (err, rows, fields) => {
        if (err) {
          throw err;
        }
        if (rows.affectedRows > 0) {
          res.json("Contraseña actualizada correctamente");
        } else {
          res.status(500).json("No se pudo actualizar la contraseña");
        }
      }
    );
  } else {
    res.status(400).json("No se ingreso ningun parametro");
  }
});

router.put("/settings/password", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    try {
      const user_id = cabecera.id;
      const { actual_password, new_password } = req.body;

      if (actual_password && new_password) {
        const [rows] = await mysqlConnection
          .promise()
          .query("select password from usuario where id = ?", [user_id]);

        if (rows.length > 0) {
          const passwordCorrect = await bcryptjs.compare(
            actual_password,
            rows[0].password
          );
          if (passwordCorrect) {
            let passwordHash = await bcryptjs.hash(new_password, 8);
            const [rows2] = await mysqlConnection
              .promise()
              .query("update usuario set password = ? where id = ?", [
                passwordHash,
                user_id,
              ]);
            if (rows2.affectedRows > 0) {
              res.json("Password updated successfully");
            } else {
              res.status(500).json("Could not update password");
            }
          } else {
            res.status(401).json("Unauthorized");
          }
        } else {
          res.status(500).json("Could not update password");
        }
      } else {
        res.status(400).json("Bad request");
      }
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  }
});

router.get("/settings/info", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    try {
      const id = cabecera.id;
      const [rows] = await mysqlConnection.promise().query(
        `select nombre,
        apellido,
        email
        from usuario as u
        where u.id = ?`,
        [id]
      );
      if (rows.length > 0) {
        res.json(rows[0]);
      } else {
        res.status(404).json("User not found");
      }
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  } else {
    res.status(401).json("Unauthorized");
  }
});

router.put("/settings/info", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    try {
      const id = cabecera.id;
      formulario = req.body;
      const nombre = formulario.nombre || null;
      const apellido = formulario.apellido || null;
      const email = formulario.email || null;

      const [rows] = await mysqlConnection
        .promise()
        .query(
          "update usuario set nombre = ?, apellido = ?, email = ? where id = ?",
          [nombre, apellido, email, id]
        );

      if (rows.affectedRows > 0) {
        res.json("User updated successfully");
      } else {
        res.status(500).json("Could not update user");
      }
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  } else {
    res.status(401).json("Unauthorized");
  }
});

router.get("/email/existe/buscar", async (req, res) => {
  const email = req.query.email || null;
  try {
    if (email) {
      const [rows] = await mysqlConnection
        .promise()
        .query("select email from usuario where email = ?", [email]);
      if (rows.length > 0) {
        res.json(true);
      } else {
        res.json(false);
      }
    } else {
      res.json(false);
    }
  } catch (err) {
    console.log(err);
    res.status(500).json("Internal server error");
  }
});

router.get("/dni/existe/buscar", async (req, res) => {
  const dni = req.query.dni || null;
  try {
    if (dni) {
      const [rows] = await mysqlConnection
        .promise()
        .query("select dni from perfil_ditor where dni = ?", [dni]);
      if (rows.length > 0) {
        res.json(true);
      } else {
        res.json(false);
      }
    } else {
      res.json(false);
    }
  } catch (err) {
    console.log(err);
    res.status(500).json("Internal server error");
  }
});

router.get("/celular/existe/buscar", async (req, res) => {
  var celular = req.query.celular || null;
  try {
    if (celular) {
      celular = "+" + celular.trim(); // Elimina los espacios en blanco y agrega el signo de más al inicio
      const [rows] = await mysqlConnection
        .promise()
        .query("select celular from perfil_ditor where celular = ?", [celular]);
      if (rows.length > 0) {
        res.json(true);
      } else {
        res.json(false);
      }
    } else {
      res.json(false);
    }
  } catch (err) {
    console.log(err);
    res.status(500).json("Internal server error");
  }
});

router.get("/codigo-referido/existe/buscar", async (req, res) => {
  const codigo_referido = req.query.codigo_referido || null;
  try {
    if (codigo_referido) {
      const [rows] = await mysqlConnection
        .promise()
        .query(
          "select codigo_referido from perfil_ditor where codigo_referido = ?",
          [codigo_referido]
        );
      if (rows.length > 0) {
        res.json(true);
      } else {
        res.json(false);
      }
    } else {
      res.json(false);
    }
  } catch (err) {
    console.log(err);
    res.status(500).json("Internal server error");
  }
});

router.get("/codigo-empresa/existe/buscar", async (req, res) => {
  const codigo_empresa = req.query.codigo_empresa || null;
  try {
    if (codigo_empresa) {
      const [rows] = await mysqlConnection
        .promise()
        .query("select id from cliente where BINARY id_empresa = ?", [
          codigo_empresa,
        ]);
      if (rows.length > 0) {
        res.json({ control: true, client_id: rows[0].id });
      } else {
        res.json(false);
      }
    } else {
      res.json(false);
    }
  } catch (err) {
    console.log(err);
    res.status(500).json("Internal server error");
  }
});

router.get("/perfil/general", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const id = cabecera.id;

  if (cabecera.rol === "ditor") {
    // mostrar informacion del perfil del ditor y si no tiene genero, pais, provincia, localidad, mostrar null
    mysqlConnection.query(
      `select u.nombre as nombre, \
                            u.apellido as apellido, \ 
                            pd.dni as dni, \
                            pais.nombre as pais, \
                            provincia.nombre as provincia, \
                            localidad.nombre as localidad, \
                            genero.nombre as genero, \
                            u.email as email, \
                            IFNULL(u.cliente,0) as cliente, \
                            IFNULL(cli.nombre, '') as nombre_cliente, \
                            pd.celular as celular, \
                            pd.foto as rostro, \
                            ec.nombre as estado_civil, \
                            pd.hijos as hijos, \
                            pd.ocupacion as ocupacion, \
                            ne.nombre as nivel_educativo, \
                            DATE_FORMAT(pd.fecha_nacimiento, '%d-%m-%Y') as fecha_nacimiento, \
                            DATE_FORMAT(u.fecha_creacion, '%d-%m-%Y %T') as fecha_creacion, \
                            pd.codigo_referido as codigo_referido, \
                            IF(pd.codigo_referido_usuario_id IS NULL, 'N', 'Y') as tiene_codigo_referido, \
                            n.nombre as nivel, \
                            d.puntos as puntos, \
                            IFNULL(d.mision_activa, 0) as mision_activa_id, \
                            IFNULL(em.id, 0) as estado_mision_id, \
                            em.nombre as estado_mision \
                            from usuario u \
                            inner join ditor d on u.id = d.usuario \
                            inner join perfil_ditor pd on d.usuario = pd.ditor \
                            inner join nivel n on d.nivel = n.id \
                            inner join cliente cli on cli.id = u.cliente \
                            left join pais on pd.pais = pais.id \
                            left join provincia on pd.provincia = provincia.id \
                            left join localidad on pd.localidad = localidad.id \
                            left join genero on pd.genero = genero.id \
                            left join mision m on d.mision_activa = m.id \
                            left join estado_mision em on m.estado_mision = em.id \
                            left join estado_civil ec on pd.estado_civil = ec.id \
                            left join nivel_educativo ne on pd.nivel_educativo = ne.id \
                            where u.id = '${id}'`,
      async (err, rows, fields) => {
        if (err) {
          throw err;
        }
        if (rows.length > 0) {
          if (rows[0].rostro != null) {
            getObjectParams = {
              Bucket: bucketName,
              Key: rows[0].rostro,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            rows[0].rostro = url;
          }
          res.json(rows[0]);
        } else {
          res.status(500).json("No se pudo obtener el perfil");
        }
      }
    );
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/perfil/completo", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const id = cabecera.id;

  if (cabecera.rol === "ditor") {
    mysqlConnection.query(
      `select u.nombre as nombre, \
                            u.apellido as apellido, \
                            pd.dni as dni, \
                            pais.nombre as pais, \
                            provincia.nombre as provincia, \
                            localidad.nombre as localidad, \
                            genero.nombre as genero, \
                            u.email as email, \
                            pd.celular as celular, \
                            pd.foto as rostro, \
                            DATE_FORMAT(pd.fecha_nacimiento, '%d-%m-%Y') as fecha_nacimiento, \
                            DATE_FORMAT(u.fecha_creacion, '%d-%m-%Y %T') as fecha_creacion, \
                            pd.codigo_referido as codigo_referido, \
                            IF(pd.codigo_referido_usuario_id IS NULL, 'N', 'Y') as tiene_codigo_referido, \
                            n.nombre as nivel, \
                            d.puntos as puntos, \
                            IFNULL(d.mision_activa, 0) as mision_activa_id, \
                            IFNULL(em.id, 0) as estado_mision_id, \
                            em.nombre as estado_mision, \
                            pd.cuit_cuil as cuit_cuil, \
                            pd.calle as calle, \
                            pd.altura as altura, \
                            pd.piso as piso, \
                            pd.departamento as departamento, \
                            pd.codigo_postal as codigo_postal, \
                            ocupacion.nombre as ocupacion, \
                            estado_civil.nombre as estado_civil, \
                            nivel_educativo.nombre as nivel_educativo, \
                            pd.hijos as hijos, \
                            pd.mascotas as mascotas, \
                            pd.comentarios as comentarios \
                            from usuario u \
                            inner join ditor d on u.id = d.usuario \
                            inner join perfil_ditor pd on d.usuario = pd.ditor \
                            inner join nivel n on d.nivel = n.id \
                            left join pais on pd.pais = pais.id \
                            left join provincia on pd.provincia = provincia.id \
                            left join localidad on pd.localidad = localidad.id \
                            left join genero on pd.genero = genero.id \
                            left join ocupacion on pd.ocupacion = ocupacion.id \
                            left join estado_civil on pd.estado_civil = estado_civil.id \
                            left join nivel_educativo on pd.nivel_educativo = nivel_educativo.id \
                            left join mision m on d.mision_activa = m.id \
                            left join estado_mision em on m.estado_mision = em.id \
                            where u.id = '${id}'`,
      async (err, rows, fields) => {
        if (err) {
          throw err;
        }
        if (rows.length > 0) {
          if (rows[0].rostro != null) {
            getObjectParams = {
              Bucket: bucketName,
              Key: rows[0].rostro,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            rows[0].rostro = url;
          }
          res.json(rows[0]);
        } else {
          res.status(500).json("No se pudo obtener el perfil");
        }
      }
    );
  } else {
    res.status(401).json("No autorizado");
  }
});

var uploadLogoCliente = multer({ storage: storage });
var uploadMultipleLogoCliente = uploadLogoCliente.fields([{ name: "logo" }]);

router.post(
  "/alta/cliente",
  verifyToken,
  uploadMultipleLogoCliente,
  (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    formulario = req.body;

    if (cabecera.rol === "admin") {
      if (req.files.logo) {
        var funcionesSubidaS3Paralela = [];

        req.files.logo[0].filename = randomImageName();
        const paramsLogo = {
          Bucket: bucketName,
          Key: req.files.logo[0].filename,
          Body: req.files.logo[0].buffer,
          ContentType: req.files.logo[0].mimetype,
        };
        const commandLogo = new PutObjectCommand(paramsLogo);
        funcionesSubidaS3Paralela.push(s3.send(commandLogo));

        Promise.all(funcionesSubidaS3Paralela).then(
          successCallback,
          errorCallback
        );
        function successCallback(result) {
          mysqlConnection.query(
            `insert into cliente 
                                (nombre, razon_social, pais, direccion, cuit, telefono, email, rubro)
                                values
                                (${formulario.nombre
              ? `'${formulario.nombre}'`
              : null
            }, ${formulario.razon_social ? `'${formulario.razon_social}'` : null
            }, ${formulario.pais ? `'${formulario.pais}'` : null}, ${formulario.direccion ? `'${formulario.direccion}'` : null
            }, ${formulario.cuit ? `'${formulario.cuit}'` : null}, ${formulario.telefono ? `'${formulario.telefono}'` : null
            }, ${formulario.email ? `'${formulario.email}'` : null}, ${formulario.rubro ? `'${formulario.rubro}'` : null
            })`,
            (err, rows, fields) => {
              if (err) {
                throw err;
              }
              if (rows.affectedRows > 0) {
                mysqlConnection.query(
                  `insert into logo_cliente 
                                      (cliente, archivo)
                                      values
                                      ('${rows.insertId}', '${req.files.logo[0].filename}')`,
                  (err, rows, fields) => {
                    if (err) {
                      throw err;
                    }
                    if (rows.affectedRows > 0) {
                      res.json("Cliente registrado correctamente");
                    } else {
                      res.status(500).json("No se pudo registrar el cliente");
                    }
                  }
                );
              } else {
                res.status(500).json("No se pudo registrar el cliente");
              }
            }
          );
        }
        function errorCallback(err) {
          console.log("Error de subida de archivos al bucket", err);
          res.send(err);
        }
      } else {
        res.status(500).json("Faltan datos");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

// post articulo con n imagenes
var uploadImagenArticulo = multer({ storage: storage });
var uploadMultipleImagenArticulo = uploadImagenArticulo.fields([
  { name: "imagen" },
]);

router.post(
  "/alta/articulo",
  verifyToken,
  uploadMultipleImagenArticulo,
  (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    formulario = req.body;

    if (cabecera.rol === "admin") {
      if (req.files.imagen) {
        var funcionesSubidaS3Paralela = [];

        req.files.imagen[0].filename = randomImageName();
        const paramsImagen = {
          Bucket: bucketName,
          Key: req.files.imagen[0].filename,
          Body: req.files.imagen[0].buffer,
          ContentType: req.files.imagen[0].mimetype,
        };
        const commandImagen = new PutObjectCommand(paramsImagen);
        funcionesSubidaS3Paralela.push(s3.send(commandImagen));

        Promise.all(funcionesSubidaS3Paralela).then(
          successCallback,
          errorCallback
        );
        function successCallback(result) {
          mysqlConnection.query(
            `insert into articulo
                                (cliente, tipo_articulo, nombre, descripcion)
                                values
                                (${formulario.cliente
              ? `'${formulario.cliente}'`
              : null
            }, ${formulario.tipoArticulo ? `'${formulario.tipoArticulo}'` : null
            }, ${formulario.nombre ? `'${formulario.nombre}'` : null}, ${formulario.descripcion ? `'${formulario.descripcion}'` : null
            })`,
            (err, rows, fields) => {
              if (err) {
                throw err;
              }
              if (rows.affectedRows > 0) {
                var funcionesParalelasArticulo = [];
                funcionesParalelasArticulo.push(
                  funcionInsertarImagenesArticulo(
                    rows.insertId,
                    "Y",
                    req.files.imagen[0].filename
                  ),
                  funcionInsertarTipoArticulo(rows.insertId, formulario)
                );
                Promise.all(funcionesParalelasArticulo).then(
                  successCallback,
                  errorCallback
                );
                function successCallback(result) {
                  res.json("Articulo registrado correctamente");
                }
                function errorCallback(err) {
                  res.status(500).json("No se pudo registrar el articulo");
                }
              } else {
                res.status(500).json("No se pudo registrar el articulo");
              }
            }
          );
        }
        function errorCallback(err) {
          console.log("Error de subida de archivos al bucket", err);
          res.send(err);
        }
      } else {
        res.status(500).json("Faltan datos");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

function funcionInsertarImagenesArticulo(articulo, esFrontal, archivo) {
  return new Promise(function (resolve, reject) {
    try {
      mysqlConnection.query(
        `insert into imagenes_articulo
                                (articulo, es_frontal, archivo)
                                values
                                ('${articulo}', '${esFrontal}', '${archivo}')`,
        (err, rows, fields) => {
          if (err) {
            throw err;
          }
          if (rows.affectedRows > 0) {
            resolve("Imagen registrada correctamente");
          } else {
            reject("No se pudo registrar la imagen");
          }
        }
      );
    } catch (error) {
      reject("No se pudo registrar la imagen");
    }
  });
}

function funcionInsertarTipoArticulo(articulo, formulario) {
  return new Promise(function (resolve, reject) {
    try {
      mysqlConnection.query(
        `select nombre from tipo_articulo where id = '${formulario.tipoArticulo}'`,
        (err, rows, fields) => {
          if (err) {
            throw err;
          }
          if (rows.length > 0) {
            var query = "";
            if (rows[0].nombre === "Producto") {
              query = `insert into articulo_producto
                        (articulo, gtin, codigo_de_barras, marca, clasificacion, mercado_destino, contenido_neto)
                        values
                        ('${articulo}', '${formulario.gtin ? formulario.gtin : null
                }', '${formulario.codigoDeBarras ? formulario.codigoDeBarras : null
                }', '${formulario.marca ? formulario.marca : null}', '${formulario.clasificacion ? formulario.clasificacion : null
                }', '${formulario.mercadoDestino ? formulario.mercadoDestino : null
                }', '${formulario.contenidoNeto ? formulario.contenidoNeto : null
                }')`;
            } else if (rows[0].nombre === "Otro") {
              query = `insert into articulo_otro
                        (articulo, nombre_generico, identificacion)
                        values
                        ('${articulo}', '${formulario.nombreGenerico ? formulario.nombreGenerico : null
                }', '${formulario.identificacion ? formulario.identificacion : null
                }')`;
            }
            mysqlConnection.query(query, (err, rows, fields) => {
              if (err) {
                throw err;
              }
              if (rows.affectedRows > 0) {
                resolve("Tipo de articulo registrado correctamente");
              } else {
                reject("No se pudo registrar el tipo de articulo");
              }
            });
          } else {
            reject("No se pudo registrar el tipo de articulo");
          }
        }
      );
    } catch (error) {
      reject("No se pudo registrar el tipo de articulo");
    }
  });
}

router.post("/campania/detalle/fotos/:idCampania", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "cliente") {
      const filters = req.body;
      const idCampania = req.params.idCampania;

      let comercios = null;
      if (typeof filters.comercios === 'string') {
        comercios = filters.comercios.split(",");
      } else if (Array.isArray(filters.comercios)) {
        comercios = filters.comercios;
      }

      let preguntas = null;
      if (typeof filters.preguntas === 'string') {
        preguntas = filters.preguntas.split(",");
      } else if (Array.isArray(filters.preguntas)) {
        preguntas = filters.preguntas;
      }

      let pagina = filters.pagina ? parseInt(filters.pagina, 10) : 1;

      let limit = 14;
      let offset = (pagina - 1) * limit;

      let query = `
        SELECT 
          m.id as id_mision,
          m.asignada_a_id as asignada_a,
          IF(md.fecha_realizacion IS NOT NULL, md.ditor, NULL ) as realizado_por,
          u.nombre as nombre,
          u.apellido as apellido,
          em.nombre as estado,
          pc.id as id_pregunta,
          pc.pregunta as pregunta,
          m.comercio as id_comercio,
          co.nombre as nombre_comercio,
          fmd.archivo as file,
          DATE_FORMAT(fmd.fecha_modificacion, "%d/%m/%Y %T") as fecha_modificacion
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN usuario as u ON u.id = m.asignada_a_id
        INNER JOIN estado_mision as em ON em.id = m.estado_mision
        INNER JOIN comercio as co ON co.id = m.comercio
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN fotos_mision_ditor as fmd ON fmd.mision_ditor = md.id
        INNER JOIN pregunta_campania as pc ON pc.id = fmd.pregunta_campania
        WHERE pc.tipo_respuesta = 2
        AND c.id = ?
        AND fmd.archivo IS NOT NULL
      `;

      const params = [idCampania];

      if (comercios && comercios.length > 0) {
        query += ` AND m.comercio IN (${comercios.map(() => '?').join(',')})`;
        params.push(...comercios);
      }

      if (preguntas && preguntas.length > 0) {
        query += ` AND pc.id IN (${preguntas.map(() => '?').join(',')})`;
        params.push(...preguntas);
      }

      query += `
        ORDER BY fmd.fecha_modificacion DESC
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);

      const [rows] = await mysqlConnection.promise().execute(query, params);

      const fotos = [];
      for (const row of rows) {
        if (row.file) {
          const getObjectParams = {
            Bucket: bucketName,
            Key: row.file,
          };
          const command = new GetObjectCommand(getObjectParams);
          const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
          fotos.push({
            id_mision: row.id_mision,
            asignada_a: row.asignada_a,
            realizado_por: row.realizado_por,
            nombre: row.nombre,
            apellido: row.apellido,
            estado: row.estado,
            id_pregunta: row.id_pregunta,
            pregunta: row.pregunta,
            id_comercio: row.id_comercio,
            nombre_comercio: row.nombre_comercio,
            archivo: url,
            fecha: row.fecha_modificacion,
          });
        }
      }

      res.status(200).json(fotos);
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.error(error);
    res.status(500).json("Error interno del servidor");
  }
});

// get comercios de un cliente
router.get("/filtro/comercios/:idCampania", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    const idCliente = cabecera.client_id;
    const idCampania = req.params.idCampania;
    const [rows] = await mysqlConnection.promise().execute(
      `SELECT
        c.id as id,
        c.nombre as nombre
      FROM comercio as c
      INNER JOIN mision as m ON m.comercio = c.id
      WHERE c.cliente = ? AND m.campania = ?
      group by c.nombre
      order by c.nombre`,
      [idCliente, idCampania]
    );

    res.status(200).json(rows);
  } else {
    res.status(401).json("No autorizado");
  }
});

// get preguntas de una campania
router.get("/filtro/preguntas/:idCampania", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    const idCampania = req.params.idCampania;
    const [rows] = await mysqlConnection.promise().execute(
      `SELECT
        pc.id as id,
        pc.pregunta as nombre
      FROM pregunta_campania as pc
      WHERE pc.campania = ? and pc.tipo_respuesta = 2
      order by pc.pregunta`,
      [idCampania]
    );

    res.status(200).json(rows);
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/comercios-sugeridos", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const latitud = req.query.latitud;
    const longitud = req.query.longitud;
    const radio = req.query.radio;
    const idZnapper = cabecera.id;

    // google maps usa (latitud, longitud) pero mysql usa (longitud, latitud)
    const query = `SELECT id as id,
                          nombre_comercio,
                          direccion,
                          tipo_comercio,
                          horario_visita,
                          nombre_contacto,
                          apellido_contacto,
                          telefono,
                          mail,
                          foto_frente_comercio,
                          ST_Y(coordenadas) AS latitud, 
                          ST_X(coordenadas) AS longitud,
                          ST_Distance_Sphere(coordenadas, POINT(${longitud}, ${latitud})) / 1000 AS distancia_km,
                          observaciones_generales
                    FROM comercio_sugerido
                    WHERE 
                          finalizado = 'N'
                          AND ST_Distance_Sphere(coordenadas, POINT(${longitud}, ${latitud})) <= ${radio} * 1000
                          AND sugerido_por_znapper = ${idZnapper}
                          ORDER BY ST_Distance_Sphere(coordenadas, POINT(${longitud}, ${latitud})) ASC`;

    mysqlConnection.query(query, async (error, results) => {
      if (error) {
        console.log(error);
        res.status(500).send("Error al consultar la base de datos");
      } else {
        for (let i = 0; i < results.length; i++) {
          if (results[i].foto_frente_comercio != null) {
            getObjectParams = {
              Bucket: bucketName,
              Key: results[i].foto_frente_comercio,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            results[i].foto_frente_comercio = url;
          }
        }
        res.send(results);
      }
    });
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get(
  "/comercio-sugerido/:idComercioSugerido",
  verifyToken,
  (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const id = req.params.idComercioSugerido
        ? req.params.idComercioSugerido
        : null;

      const query = `SELECT id as id,
                          nombre_comercio,
                          direccion,
                          tipo_comercio,
                          horario_visita,
                          nombre_contacto,
                          apellido_contacto,
                          telefono,
                          mail,
                          foto_frente_comercio,
                          ST_Y(coordenadas) AS latitud, 
                          ST_X(coordenadas) AS longitud,
                          finalizado,
                          observaciones_generales
                    FROM comercio_sugerido
                    WHERE 
                          id = ?`;

      mysqlConnection.query(query, [id], async (error, results) => {
        if (error) {
          console.log(error);
          res.status(500).send("Error al consultar la base de datos");
        } else {
          for (let i = 0; i < results.length; i++) {
            if (results[i].foto_frente_comercio != null) {
              getObjectParams = {
                Bucket: bucketName,
                Key: results[i].foto_frente_comercio,
              };
              command = new GetObjectCommand(getObjectParams);
              url = await getSignedUrl(s3, command, { expiresIn: 3600 });
              results[i].foto_frente_comercio = url;
            }
          }
          res.send(results);
        }
      });
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

router.get(
  "/visita-no-programada/:idVisitaNoProgramada",
  verifyToken,
  (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const id = req.params.idVisitaNoProgramada
        ? req.params.idVisitaNoProgramada
        : null;

      const query = `SELECT id as id,
                          nombre_comercio,
                          direccion,
                          id_comercio,
                          numero_cliente,
                          nombre_contacto,
                          apellido_contacto,
                          telefono,
                          mail,
                          foto_frente_comercio,
                          ST_Y(coordenadas) AS latitud, 
                          ST_X(coordenadas) AS longitud,
                          observaciones_generales
                    FROM visita_no_programada
                    WHERE 
                          id = ?`;

      mysqlConnection.query(query, [id], async (error, results) => {
        if (error) {
          console.log(error);
          res.status(500).send("Error al consultar la base de datos");
        } else {
          for (let i = 0; i < results.length; i++) {
            if (results[i].foto_frente_comercio != null) {
              getObjectParams = {
                Bucket: bucketName,
                Key: results[i].foto_frente_comercio,
              };
              command = new GetObjectCommand(getObjectParams);
              url = await getSignedUrl(s3, command, { expiresIn: 3600 });
              results[i].foto_frente_comercio = url;
            }
          }
          res.send(results);
        }
      });
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

router.get("/comercios", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "admin") {
    const idCliente = cabecera.client_id;

    // google maps usa (latitud, longitud) pero mysql usa (longitud, latitud)
    // const query = `SELECT comercio.id as id, 
    //                       comercio.nombre as nombre,
    //                       comercio.codigo as codigo,
    //                       IFNULL(comercio.tipo_comercio, 'Sin informar') as tipo_comercio,
    //                       IFNULL(comercio.categoria, '') as categoria,
    //                       IFNULL((SELECT gestor FROM comercio_detalle WHERE comercio_id = mision.comercio and mision_id = mision.id), '') as gestor,
    //                       comercio.calle as calle,
    //                       comercio.numero as numero,
    //                       comercio.localidad as localidad,
    //                       campania.nombre as nombre_campania,
    //                       IFNULL(comercio.rango_horario, '') as rango_horario,
    //                       IFNULL(comercio.rango_horario2, '') as rango_horario2,
    //                       ST_Y(comercio.coordenadas) AS latitud, 
    //                       ST_X(comercio.coordenadas) AS longitud, 
    //                       count(*) AS cantidad_misiones,
    //                       mision.asignada_a_id as asignada_a,
    //                       mision.prioridad_visita as prioridad_visita,
    //                       (
    //                         SELECT MAX(
    //                             CASE 
    //                                 WHEN m2.prioridad_visita LIKE '%Media%' THEN 2
    //                                 WHEN m2.prioridad_visita LIKE '%Alta%' THEN 4
    //                                 WHEN m2.prioridad_visita LIKE '%Urgente%' THEN 6
    //                                 ELSE 1 
    //                             END
    //                         ) 
    //                         FROM retail.mision m2
    //                         WHERE m2.comercio = comercio.id and m2.estado_mision = 1
    //                       ) as max_prioridad_visita,
    //                       IFNULL((SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = mision.asignada_a_id), '') as usuario_asignado
    //                 FROM comercio
    //                       INNER JOIN mision ON comercio.id = mision.comercio
    //                       INNER JOIN estado_mision ON mision.estado_mision = estado_mision.id
    //                       INNER JOIN campania ON campania.id = mision.campania
    //                 WHERE 
    //                       comercio.habilitado = 'Y'
    //                       ${cabecera.client_id != 0
    //     ? `AND comercio.cliente = ${idCliente}`
    //     : ""
    //   }
    //                       ${cabecera.client_id != 0
    //     ? `AND campania.cliente = ${idCliente}`
    //     : ""
    //   }
    //                       AND estado_mision.nombre = 'Disponible'
    //                       GROUP BY id, nombre, latitud, longitud
    //                       `;

    // mysqlConnection.query(query, (error, results) => {
    //   if (error) {
    //     console.log(error);
    //     res.status(500).send("Error al consultar la base de datos");
    //   } else {
    //     console.log("results", results);
    //     res.send(results);
    //   }
    // });

    results = [
      {
        id: 1,
        nombre: 'La Plata',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'LA PLATA',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -34.91219154342435,
        longitud: -57.94794752324361,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 2,
        nombre: 'Mercedes',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'Mercedes',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -34.65068833445126,
        longitud: -59.431485281236725,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 3,
        nombre: 'San Nicolás',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'San Nicolás',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -33.45172498315471,
        longitud: -60.281162746252235,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 4,
        nombre: 'Dolores',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'Dolores',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -36.31427962797797,
        longitud: -57.67653308895115,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 5,
        nombre: 'Bahía Blanca',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'Bahía Blanca',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -38.71460606520239,
        longitud: -62.26634592354608,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 6,
        nombre: 'Azul',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'Azul',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -36.774055111818264,
        longitud: -59.854691469297464,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 7,
        nombre: 'Mar del Plata',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'Mar del Plata',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -38.0069295044809,
        longitud: -57.56484025828113,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      },
      {
        id: 8,
        nombre: 'Junín',
        codigo: '20372',
        tipo_comercio: 'Departamental',
        categoria: '',
        gestor: 'Encargado',
        calle: 'Calle 49 entre 4 y 5',
        numero: '3320',
        localidad: 'Junín',
        nombre_campania: 'Campaña Alarmas',
        rango_horario: '',
        rango_horario2: '',
        latitud: -34.58799118142035,
        longitud: -60.94925246018552,
        cantidad_misiones: 1,
        asignada_a: 0,
        prioridad_visita: 'Media',
        max_prioridad_visita: 2,
        usuario_asignado: ''
      }
    ]
    res.send(results);
  } else {
    res.status(401).json("No autorizado");
  }

});

router.get("/znappers/mapa", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    const idCliente = cabecera.client_id;

    // google maps usa (latitud, longitud) pero mysql usa (longitud, latitud)
    const [rows] = await mysqlConnection.promise().query(
      `SELECT 
            u.id,
            u.nombre,
            ST_Y(pad.coordenadas) AS latitud, 
            ST_X(pad.coordenadas) AS longitud, 
            1 as max_prioridad_visita
      FROM usuario as u
            INNER JOIN posicion_actual_ditor as pad ON u.id = pad.usuario
      WHERE 
            u.rol = 3 AND u.cliente = ? AND
            pad.fecha_modificacion > DATE_SUB(NOW(), INTERVAL 3 MINUTE)
            `,
      [idCliente]
    );

    res.json(rows);
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/znappers/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente") {
    const idZnapper = req.params.id;
    const idCliente = cabecera.client_id;

    const [rows] = await mysqlConnection.promise().query(
      `SELECT 
            u.id,
            u.nombre,
            u.apellido,
            u.email,
            u.pausado,
            pd.dni
      FROM usuario as u
            LEFT JOIN perfil_ditor as pd ON u.id = pd.ditor
      WHERE 
            u.id = ? and u.cliente = ?
            `,
      [idZnapper, idCliente]
    );

    res.json(rows[0]);
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/znappers/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente") {
    const idZnapper = req.params.id;
    const idCliente = cabecera.client_id;
    const formulario = req.body;

    try {
      // verificar que el usuario tenga entrada en tabla perfil_ditor, sino crearla
      const [rowsBusqueda] = await mysqlConnection.promise().query(
        `SELECT
            pd.ditor
        FROM perfil_ditor as pd
        WHERE 
            pd.ditor = ?`,
        [idZnapper]
      );

      if (rowsBusqueda.length === 0) {
        const [rows] = await mysqlConnection
          .promise()
          .query(`INSERT INTO perfil_ditor (ditor) VALUES (?)`, [idZnapper]);
      }

      // modificar datos del znapper nombre, apellido, email (tabla usuario) y dni (tabla perfil_ditor, si existe)
      const [rowsModificacion] = await mysqlConnection.promise().query(
        `UPDATE usuario as u
        INNER JOIN perfil_ditor as pd ON u.id = pd.ditor
        SET 
            u.nombre = ?,
            u.apellido = ?,
            u.email = ?,
            pd.dni = ?
        WHERE 
            u.id = ? and u.cliente = ?`,
        [
          formulario.nombre,
          formulario.apellido,
          formulario.email,
          formulario.dni,
          idZnapper,
          idCliente,
        ]
      );

      res.json("Znapper modificado correctamente");
    } catch (err) {
      console.log(err);
      res.status(500).json("Error al modificar el Znapper");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/znappers/pausar/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente") {
    const idZnapper = req.params.id;
    const idCliente = cabecera.client_id;
    const pausar = req.body.pausar;

    try {
      const [rowsModificacion] = await mysqlConnection.promise().query(
        `UPDATE usuario
        SET 
            pausado = ?
        WHERE 
            id = ? and cliente = ?`,
        [pausar, idZnapper, idCliente]
      );

      res.json("Znapper modificado correctamente");
    } catch (err) {
      console.log(err);
      res.status(500).json("Error al modificar el Znapper");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/znappers/eliminar/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente") {
    const idZnapper = req.params.id;
    const idCliente = cabecera.client_id;
    const habilitar = req.body.habilitar;

    try {
      const [rowsModificacion] = await mysqlConnection.promise().query(
        `UPDATE usuario
        SET 
            habilitado = ?
        WHERE 
            id = ? and cliente = ?`,
        [habilitar, idZnapper, idCliente]
      );

      res.json("Znapper modificado correctamente");
    } catch (err) {
      console.log(err);
      res.status(500).json("Error al modificar el Znapper");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/listado-misiones-comercios", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const latitud = req.query.latitud;
    const longitud = req.query.longitud;
    const radio = req.query.radio;
    const idCliente = cabecera.client_id;

    // google maps usa (latitud, longitud) pero mysql usa (longitud, latitud)
    const query = `SELECT comercio.id as id_comercio, 
                          comercio.nombre as nombre,
                          comercio.codigo as codigo,
                          IFNULL(comercio.tipo_comercio, 'Sin informar') as tipo_comercio,
                          IFNULL(comercio.categoria, '') as categoria,
                          IFNULL((SELECT gestor FROM comercio_detalle WHERE comercio_id = m.comercio and mision_id = m.id), '') as gestor,
                          comercio.calle as calle,
                          comercio.numero as numero,
                          comercio.localidad as localidad,
                          IFNULL(comercio.rango_horario, '') as rango_horario,
                          IFNULL(comercio.rango_horario2, '') as rango_horario2,
                          ST_Distance_Sphere(comercio.coordenadas, POINT(${longitud}, ${latitud})) / 1000 AS distancia_km,
                          m.id as id_mision, 
                          m.precio as precio, 
                          m.puntos as puntos,
                          IFNULL(m.variacion_transacciones, '') as variacion_transacciones,
                          IFNULL(m.prioridad_visita, '') as prioridad_visita,
                          m.asignada_a_id as asignada_a,
                          IFNULL((SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = m.asignada_a_id), '') as usuario_asignado,
                          IFNULL((SELECT date(fecha_modificacion) FROM mision m2 WHERE m2.estado_mision IN (4,5) and m2.comercio = m.comercio order by id desc LIMIT 1 ), '') as fecha_ultima_visita,
                          IFNULL((SELECT (SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = m2.asignada_a_id) FROM mision m2 WHERE m2.estado_mision IN (4,5) and m2.comercio = m.comercio order by id desc LIMIT 1 ), '') as usuario_ultima_visita,
                          c.nombre as nombre_campania,
                          c.objetivo as objetivo,
                          c.duracion_reserva as duracion_reserva,
                          c.duracion_mision as duracion_mision,
                          cliente.nombre as nombre_cliente
                    FROM comercio
                          INNER JOIN mision m ON comercio.id = m.comercio
                          INNER JOIN estado_mision ON m.estado_mision = estado_mision.id
                          INNER JOIN campania as c ON m.campania = c.id
                          INNER JOIN cliente ON c.cliente = cliente.id
                    WHERE 
                          comercio.habilitado = 'Y'
                          ${cabecera.client_id != 0
        ? `AND comercio.cliente = ${idCliente}`
        : ""
      }
                          ${cabecera.client_id != 0
        ? `AND c.cliente = ${idCliente}`
        : ""
      }
                          AND ST_Distance_Sphere(comercio.coordenadas, POINT(${longitud}, ${latitud})) <= ${radio} * 1000
                          AND estado_mision.nombre = 'Disponible'
                          GROUP BY m.id
                          ORDER BY ST_Distance_Sphere(comercio.coordenadas, POINT(${longitud}, ${latitud})) ASC`;

    mysqlConnection.query(query, (error, results) => {
      if (error) {
        console.log(error);
        res.status(500).send("Error al consultar la base de datos");
      } else {
        res.send(results);
      }
    });
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/misiones/comercio/:idComercio", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const id = req.params.idComercio ? req.params.idComercio : null;
    const idCliente = cabecera.client_id;

    var funcionesParalelasComercioId = [];
    funcionesParalelasComercioId.push(funcionMisionesComercioId(id, idCliente));
    Promise.all(funcionesParalelasComercioId).then(
      successCallback,
      errorCallback
    );
    function successCallback(result) {
      res.send({
        comercio: id,
        misiones: result[0],
      });
    }
    function errorCallback(error) {
      res
        .status(500)
        .json("No se pudieron obtener los datos de las misiones del comercio");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/detalle-misiones-comercio/:id", verifyToken, (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "admin" || cabecera.rol === "limited") {
    const idCliente = cabecera.client_id;
    const idComercio = req.params.id;

    // const query = `SELECT comercio.id as id_comercio, 
    //                       comercio.nombre as nombre,
    //                       comercio.codigo as codigo,
    //                       IFNULL(comercio.tipo_comercio, 'Sin informar') as tipo_comercio,
    //                       IFNULL(comercio.categoria, '') as categoria,
    //                       IFNULL((SELECT gestor FROM comercio_detalle WHERE comercio_id = m.comercio and mision_id = m.id), '') as gestor,
    //                       comercio.calle as calle,
    //                       comercio.numero as numero,
    //                       comercio.localidad as localidad,
    //                       IFNULL(comercio.rango_horario, '') as rango_horario,
    //                       IFNULL(comercio.rango_horario2, '') as rango_horario2,
    //                       m.id as id_mision, 
    //                       m.precio as precio, 
    //                       m.puntos as puntos,
    //                       IFNULL(m.variacion_transacciones, '') as variacion_transacciones,
    //                       IFNULL(m.prioridad_visita, '') as prioridad_visita,
    //                       m.asignada_a_id as asignada_a,
    //                       IFNULL((SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = m.asignada_a_id), '') as usuario_asignado,
    //                       IFNULL((SELECT date(fecha_modificacion) FROM mision m2 WHERE m2.estado_mision IN (4,5) and m2.comercio = m.comercio order by id desc LIMIT 1 ), '') as fecha_ultima_visita,
    //                       IFNULL((SELECT (SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = m2.asignada_a_id) FROM mision m2 WHERE m2.estado_mision IN (4,5) and m2.comercio = m.comercio order by id desc LIMIT 1 ), '') as usuario_ultima_visita,
    //                       c.nombre as nombre_campania,
    //                       c.objetivo as objetivo,
    //                       c.duracion_reserva as duracion_reserva,
    //                       c.duracion_mision as duracion_mision,
    //                       cliente.nombre as nombre_cliente
    //                 FROM comercio
    //                       INNER JOIN mision m ON comercio.id = m.comercio
    //                       INNER JOIN estado_mision ON m.estado_mision = estado_mision.id
    //                       INNER JOIN campania as c ON m.campania = c.id
    //                       INNER JOIN cliente ON c.cliente = cliente.id
    //                 WHERE 
    //                       comercio.habilitado = 'Y'
    //                       AND comercio.cliente = ${idCliente}
    //                       AND c.cliente = ${idCliente}
    //                       AND estado_mision.nombre = 'Disponible'
    //                       AND comercio.id = ${idComercio}	
    //                       GROUP BY m.id`;

    // mysqlConnection.query(query, (error, results) => {
    //   if (error) {
    //     console.log(error);
    //     res.status(500).send("Error al consultar la base de datos");
    //   } else {
    //     console.log("results", results);
    //     res.send(results);
    //   }
    // });
    switch (idComercio) {
      case 1:
        results = [{
          id_comercio: 1,
          nombre: 'La Plata',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'La Plata',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 2:

        results = [{
          id_comercio: 2,
          nombre: 'Mercedes',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'Mercedes',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 3:

        results = [{
          id_comercio: 3,
          nombre: 'San Nicolás',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'San Nicolás',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 4:
        results = [{
          id_comercio: 4,
          nombre: 'Dolores',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'Dolores',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 5:
        results = [{
          id_comercio: 5,
          nombre: 'Bahía Blanca',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'Bahía Blanca',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 6:
        results = [{
          id_comercio: 6,
          nombre: 'Azul',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'Azul',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 7:
        results = [{
          id_comercio: 7,
          nombre: 'Mar del Plata',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'Mar del Plata',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
      case 8:
        results = [{
          id_comercio: 8,
          nombre: 'Junín',
          codigo: '123',
          tipo_comercio: 'Departamental',
          categoria: '',
          gestor: 'Encargado',
          calle: 'Calle 49 entre 4 y 5',
          numero: '',
          localidad: 'Junín',
          rango_horario: '',
          rango_horario2: '',
          id_mision: 695,
          precio: 1,
          puntos: 1,
          variacion_transacciones: '',
          prioridad_visita: 'Media',
          asignada_a: 0,
          usuario_asignado: '',
          fecha_ultima_visita: '',
          usuario_ultima_visita: '',
          nombre_campania: 'Campaña Alarmas',
          objetivo: 'Las misiones de esta campaña requieren ingresar a la tienda, tomar fotografias de los estantes requeridos y completar una encuesta.',
          duracion_reserva: 90,
          duracion_mision: 15,
          nombre_cliente: 'Pago Virtual del Sur'
        }]
        break;
    }
    res.send(results);
  } else {
    res.status(401).json("No autorizado");
  }
});

function funcionMisionesComercioId(id, idCliente) {
  return new Promise(function (resolve, reject) {
    try {
      mysqlConnection.query(
        `SELECT m.id as id, 
                                  m.precio as precio, 
                                  m.puntos as puntos,
                                  IFNULL(m.variacion_transacciones, '') as variacion_transacciones,
                                  IFNULL(m.prioridad_visita, '') as prioridad_visita,
                                  m.asignada_a_id as asignada_a,
                                  IFNULL((SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = m.asignada_a_id), '') as usuario_asignado,
                                  IFNULL((SELECT date(fecha_modificacion) FROM mision m2 WHERE m2.estado_mision IN (4,5) and m2.comercio = m.comercio order by id desc LIMIT 1 ), '') as fecha_ultima_visita,
                                  IFNULL((SELECT (SELECT CONCAT(nombre, ' ', apellido) FROM usuario WHERE id = m2.asignada_a_id) FROM mision m2 WHERE m2.estado_mision IN (4,5) and m2.comercio = m.comercio order by id desc LIMIT 1 ), '') as usuario_ultima_visita,
                                  c.nombre as nombre_campania,
                                  c.objetivo as objetivo,
                                  c.duracion_reserva as duracion_reserva,
                                  c.duracion_mision as duracion_mision,
                                  cliente.nombre as nombre_cliente,
                                  IFNULL(logo_cliente.archivo, '') as logo_cliente
                            FROM mision m
                            inner join estado_mision ON m.estado_mision = estado_mision.id
                            inner join campania as c ON m.campania = c.id
                            inner join cliente ON c.cliente = cliente.id
                            left join logo_cliente ON c.cliente = logo_cliente.cliente
                            WHERE m.comercio = '${id}' AND estado_mision.nombre = 'Disponible'
                            ${idCliente != 0
          ? `AND c.cliente = ${idCliente}`
          : ""
        }`,
        async (error, rows) => {
          if (error) {
            res.status(500).send("Error al consultar la base de datos");
          } else {
            for (let i = 0; i < rows.length; i++) {
              if (rows[i].logo_cliente != '') {
                getObjectParams = {
                  Bucket: bucketName,
                  Key: rows[i].logo_cliente,
                };
                command = new GetObjectCommand(getObjectParams);
                url = await getSignedUrl(s3, command, { expiresIn: 3600 });
                rows[i].logo_cliente = url;
              }
            }
            resolve(rows);
          }
        }
      );
    } catch (error) {
      reject("No se pudo obtener el comercio");
    }
  });
}

router.put("/mision/reservar/:idMision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idMision = req.params.idMision ? req.params.idMision : null;
    const latitud = req.query.latitud ? req.query.latitud : null;
    const longitud = req.query.longitud ? req.query.longitud : null;
    const idUsuario = cabecera.id;

    if (idMision == null) {
      return res.status(422).json("Faltan parámetros");
    } else {
      // validar que el cliente no tenga una mision activa
      var [rows] = await mysqlConnection
        .promise()
        .execute("SELECT mision_activa FROM ditor WHERE usuario = ?", [
          idUsuario,
        ]);

      if (rows[0].mision_activa == null) {
        var distancia = null;
        var duracionAsignacion = null;
        // validar que la mision este disponible
        if (latitud != null && longitud != null) {
          [rows] = await mysqlConnection.promise().execute(
            "SELECT m.estado_mision as estado_mision, \
                            ST_Distance_Sphere(comercio.coordenadas, POINT(?, ?)) AS distancia_m, \
                            c.duracion_mision as duracion_mision \
                      FROM mision as m\
                      INNER JOIN comercio ON m.comercio = comercio.id \
                      INNER JOIN campania c ON m.campania = c.id \
                      WHERE m.id = ?",
            [longitud, latitud, idMision]
          );
          if (rows.length > 0) {
            distancia = rows[0].distancia_m;
            duracionAsignacion = rows[0].duracion_mision; // duracion_mision de la tabla campania en minutos
          } else {
            return res.status(500).json("No se pudo obtener la mision");
          }
        } else {
          [rows] = await mysqlConnection
            .promise()
            .execute("SELECT estado_mision FROM mision WHERE id = ?", [
              idMision,
            ]);
        }
        if (rows[0].estado_mision == 1) {
          // cambiar el estado de la mision a reservada
          [rows] = await mysqlConnection
            .promise()
            .execute("UPDATE mision SET estado_mision = 2 WHERE id = ?", [
              idMision,
            ]);

          // en la tabla ditor guardo idMision en mision_activa
          [rows] = await mysqlConnection
            .promise()
            .execute("UPDATE ditor SET mision_activa = ? WHERE usuario = ?", [
              idMision,
              idUsuario,
            ]);

          // obtener tiempo de reserva de la tabla campania
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "SELECT id, duracion_reserva FROM campania WHERE id = (SELECT campania FROM mision WHERE id = ?)",
              [idMision]
            );

          const duracionReserva = rows[0].duracion_reserva; // en minutos
          const fechaActual = new Date();
          const fechaReservaLimite = new Date(
            fechaActual.getTime() + duracionReserva * 60000
          );
          const idCampania = rows[0].id;

          // se crea mision_ditor con fecha_reserva y fecha_reserva_limite
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "INSERT INTO mision_ditor (mision, ditor, fecha_reserva, fecha_reserva_limite) VALUES (?, ?, ?, ?)",
              [idMision, idUsuario, fechaActual, fechaReservaLimite]
            );

          var idMisionDitor = null;

          if (rows.affectedRows > 0) {
            idMisionDitor = rows.insertId;
            console.log(
              `La mision_ditor con id ${idMisionDitor} ha sido creada.`
            );
          }
          // ASIGNACION AUTOMATICA SI LA PERSONA RESERVO A MENOS DE 100 METROS
          console.log("distancia ", distancia);
          if (distancia != null && distancia < 100) {
            // cambiar el estado de la mision a asignada
            await mysqlConnection
              .promise()
              .execute("UPDATE mision SET estado_mision = 3 WHERE id = ?", [
                idMision,
              ]);

            // obtener id de campania y duracion_mision de la tabla campania
            [rows] = await mysqlConnection.promise().execute(
              "SELECT c.id, c.duracion_mision \
                  FROM campania c \
                  INNER JOIN mision m ON c.id = m.campania \
                  WHERE m.id = ?",
              [idMision]
            );

            const duracionAsignacion = rows[0].duracion_mision; // en minutos
            // Obtener las preguntas que tienen fotos
            [rows] = await mysqlConnection.promise().execute(
              "SELECT pregunta_campania.id, pregunta_campania.cantidad_de_fotos \
                                                    FROM pregunta_campania \
                                                    WHERE pregunta_campania.campania = ? AND (pregunta_campania.cantidad_de_fotos > 0)",
              [idCampania]
            );

            // Iterar por cada pregunta y crear los inserts correspondientes
            let inserts = "";
            let cantidad_de_fotos = 0;
            for (const row of rows) {
              if (row.cantidad_de_fotos > 0) {
                cantidad_de_fotos = row.cantidad_de_fotos;
              }
              for (let i = 0; i < cantidad_de_fotos; i++) {
                inserts += `(${row.id}, ${idMisionDitor}),`;
              }
              cantidad_de_fotos = 0;
            }
            if (inserts) {
              inserts = inserts.slice(0, -1); // Eliminar la última coma
              // Ejecutar la cadena de texto con los inserts en un solo llamado a la base de datos
              await mysqlConnection
                .promise()
                .execute(
                  `INSERT INTO fotos_mision_ditor (pregunta_campania, mision_ditor) VALUES ${inserts}`
                );
            } else {
              console.log(
                "No hay registros para insertar en la tabla fotos_mision_ditor."
              );
            }
            // en mision_ditor actualizar fecha_asignacion, fecha_asignacion_limite y estado_mision_ditor cambiar a 2, puede existir mas de una mision_ditor con mismo idMision y idUsuario, elegir la última creada (es decir la más reciente)
            const fechaActual = new Date();
            const fechaAsignacionLimite = new Date(
              fechaActual.getTime() + duracionAsignacion * 60000
            );
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE mision_ditor SET fecha_asignacion = ?, fecha_asignacion_limite = ?, estado_mision_ditor = 2 WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1",
                [fechaActual, fechaAsignacionLimite, idMision, idUsuario]
              );

            if (rows.affectedRows > 0) {
              console.log(
                `La mision con id ${idMision} ha sido asignada a el ditor con id ${idUsuario}.`
              );
              res.status(200).json({
                idMisionDitor: idMisionDitor,
                duracionAsignacion: duracionAsignacion,
                fechaAsignacion: moment(fechaActual).format(
                  "DD/MM/YYYY HH:mm:ss"
                ),
                fechaAsignacionLimite: moment(fechaAsignacionLimite).format(
                  "DD/MM/YYYY HH:mm:ss"
                ),
                distancia: distancia,
                estadoMision: 3,
                mensaje: "La mision ha sido asignada",
              });
            } else {
              res.status(422).json("La misión no esta reservada");
            }
          } else {
            res.status(200).json({
              idMisionDitor: idMisionDitor,
              duracionReserva: duracionReserva,
              fechaReserva: moment(fechaActual).format("DD/MM/YYYY HH:mm:ss"),
              fechaReservaLimite: moment(fechaReservaLimite).format(
                "DD/MM/YYYY HH:mm:ss"
              ),
              estadoMision: 2,
              mensaje: "La mision ha sido reservada",
            });
          }
        } else {
          res.status(422).json("La mision no esta disponible");
        }
      } else {
        res.status(422).json("El cliente ya tiene una mision activa");
      }
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/mision/asignar/:idMision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idMision = req.params.idMision ? req.params.idMision : null;
    const idUsuario = cabecera.id;
    const latitud = req.query.latitud ? req.query.latitud : null;
    const longitud = req.query.longitud ? req.query.longitud : null;
    if (idMision == null || latitud == null || longitud == null) {
      res.status(422).json("Faltan parámetros");
    } else {
      try {
        // validar que el cliente tenga una mision activa
        var [rows] = await mysqlConnection
          .promise()
          .execute("SELECT mision_activa FROM ditor WHERE usuario = ?", [
            idUsuario,
          ]);
        // validar que le pertenezca la mision
        if (rows[0].mision_activa == idMision) {
          [mision_estado_dist_fechas] = await mysqlConnection.promise().execute(
            "SELECT mision_ditor.id AS id_mision_ditor, \
                                      m.estado_mision, \
                                      ST_Distance_Sphere(comercio.coordenadas, POINT(?, ?)) AS distancia_m, \
                                      mision_ditor.fecha_reserva_limite, \
                                      NOW() AS fecha_actual \
                                      FROM mision as m \
                                      INNER JOIN comercio ON m.comercio = comercio.id \
                                      INNER JOIN mision_ditor ON m.id = mision_ditor.mision \
                                      WHERE m.id = ? AND mision_ditor.ditor = ? \
                                      ORDER BY mision_ditor.id DESC LIMIT 1",
            [longitud, latitud, idMision, idUsuario]
          );
          const mision_ditor_id = mision_estado_dist_fechas[0].id_mision_ditor;
          // validar que la mision este reservada
          if (mision_estado_dist_fechas[0].estado_mision == 2) {
            // si la fecha actual es mayor a la fecha limite responder que no se puede asignar
            if (
              mision_estado_dist_fechas[0].fecha_actual >
              mision_estado_dist_fechas[0].fecha_reserva_limite
            ) {
              // liberar la mision (estado disponible y mision_activa = null y el estado de mision_ditor en 6 reserva expirada)
              [rows] = await mysqlConnection
                .promise()
                .execute("UPDATE mision SET estado_mision = 1 WHERE id = ?", [
                  idMision,
                ]);
              [rows] = await mysqlConnection
                .promise()
                .execute(
                  "UPDATE ditor SET mision_activa = null WHERE usuario = ?",
                  [idUsuario]
                );
              [rows] = await mysqlConnection
                .promise()
                .execute(
                  "UPDATE mision_ditor SET estado_mision_ditor = 6 WHERE id = ? ",
                  [mision_ditor_id]
                );

              res
                .status(422)
                .json(
                  "No se puede asignar la misión porque la fecha limite de reserva ha expirado"
                );
            } else {
              const distancia = mision_estado_dist_fechas[0].distancia_m;
              // si la distancia es mayor a 500 metros responder que no se puede asignar
              // if (distancia > 500) {
              //   res
              //     .status(422)
              //     .json(
              //       "No se puede asignar la mision porque la distancia es mayor a 500 metros"
              //     );
              // } else {
              // cambiar el estado de la mision a asignada
              await mysqlConnection
                .promise()
                .execute("UPDATE mision SET estado_mision = 3 WHERE id = ?", [
                  idMision,
                ]);

              // obtener id de campania y duracion_mision de la tabla campania
              [rows] = await mysqlConnection.promise().execute(
                "SELECT c.id, c.duracion_mision \
                                                            FROM campania c \
                                                            INNER JOIN mision m ON c.id = m.campania \
                                                            WHERE m.id = ?",
                [idMision]
              );

              const duracionAsignacion = rows[0].duracion_mision; // en minutos
              // Obtener las preguntas que tienen fotos
              [rows] = await mysqlConnection.promise().execute(
                "SELECT pregunta_campania.id, pregunta_campania.cantidad_de_fotos \
                                                          FROM pregunta_campania \
                                                          WHERE pregunta_campania.campania = ? AND (pregunta_campania.cantidad_de_fotos > 0)",
                [rows[0].id]
              );

              // Iterar por cada pregunta y crear los inserts correspondientes
              let inserts = "";
              let cantidad_de_fotos = 0;
              for (const row of rows) {
                if (row.cantidad_de_fotos > 0) {
                  cantidad_de_fotos = row.cantidad_de_fotos;
                }
                for (let i = 0; i < cantidad_de_fotos; i++) {
                  inserts += `(${row.id}, ${mision_ditor_id}),`;
                }
                cantidad_de_fotos = 0;
              }
              if (inserts) {
                inserts = inserts.slice(0, -1); // Eliminar la última coma
                // Ejecutar la cadena de texto con los inserts en un solo llamado a la base de datos
                await mysqlConnection
                  .promise()
                  .execute(
                    `INSERT INTO fotos_mision_ditor (pregunta_campania, mision_ditor) VALUES ${inserts}`
                  );
              } else {
                console.log(
                  "No hay registros para insertar en la tabla fotos_mision_ditor."
                );
              }
              // en mision_ditor actualizar fecha_asignacion, fecha_asignacion_limite y estado_mision_ditor cambiar a 2, puede existir mas de una mision_ditor con mismo idMision y idUsuario, elegir la última creada (es decir la más reciente)
              const fechaActual = new Date();
              const fechaAsignacionLimite = new Date(
                fechaActual.getTime() + duracionAsignacion * 60000
              );
              [rows] = await mysqlConnection
                .promise()
                .execute(
                  "UPDATE mision_ditor SET fecha_asignacion = ?, fecha_asignacion_limite = ?, estado_mision_ditor = 2 WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1",
                  [fechaActual, fechaAsignacionLimite, idMision, idUsuario]
                );

              if (rows.affectedRows > 0) {
                console.log(
                  `La mision con id ${idMision} ha sido asignada a el ditor con id ${idUsuario}.`
                );
                const respuestaFinal = {
                  duracionAsignacion: duracionAsignacion,
                  fechaAsignacion: moment(fechaActual).format(
                    "DD/MM/YYYY HH:mm:ss"
                  ),
                  fechaAsignacionLimite: moment(fechaAsignacionLimite).format(
                    "DD/MM/YYYY HH:mm:ss"
                  ),
                  distancia: distancia,
                  estadoMision: 3,
                  mensaje: "La mision ha sido asignada",
                };
                res.status(200).json(respuestaFinal);
              } else {
                res.status(422).json("La misión no esta reservada");
              }
              // }
            }
          } else {
            // liberar la mision (estado disponible y mision_activa = null y el estado de mision_ditor en 6 reserva expirada)
            // [rows] = await mysqlConnection.promise().execute('UPDATE mision SET estado_mision = 1 WHERE id = ?', [idMision]);
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE ditor SET mision_activa = null WHERE usuario = ?",
                [idUsuario]
              );
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE mision_ditor SET estado_mision_ditor = 6 WHERE id = ? ",
                [mision_ditor_id]
              );
            res.status(422).json("La misión no está reservada");
          }
        } else {
          res.status(422).json("La misión no está activa en el ditor");
        }
      } catch (error) {
        console.log(error);
        res.status(500).json("Error en el servidor");
      }
    }
  } else {
    res.status(401).json("Usuario no autorizado");
  }
});

router.put(
  "/mision/asignar-directo/:idMision",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idMision = req.params.idMision ? req.params.idMision : null;
      const idUsuario = cabecera.id;

      if (idMision == null) {
        return res.status(422).json("Faltan parámetros");
      } else {
        // cambiar el estado de la mision a reservada
        [rows] = await mysqlConnection
          .promise()
          .execute("UPDATE mision SET estado_mision = 2 WHERE id = ?", [
            idMision,
          ]);

        // en la tabla ditor guardo idMision en mision_activa
        [rows] = await mysqlConnection
          .promise()
          .execute("UPDATE ditor SET mision_activa = ? WHERE usuario = ?", [
            idMision,
            idUsuario,
          ]);

        // obtener tiempo de reserva de la tabla campania
        [rows] = await mysqlConnection
          .promise()
          .execute(
            "SELECT id, duracion_reserva FROM campania WHERE id = (SELECT campania FROM mision WHERE id = ?)",
            [idMision]
          );

        const duracionReserva = rows[0].duracion_reserva; // en minutos
        const fechaActual = new Date();
        const fechaReservaLimite = new Date(
          fechaActual.getTime() + duracionReserva * 60000
        );
        const idCampania = rows[0].id;

        // se crea mision_ditor con fecha_reserva y fecha_reserva_limite
        [rows] = await mysqlConnection
          .promise()
          .execute(
            "INSERT INTO mision_ditor (mision, ditor, fecha_reserva, fecha_reserva_limite) VALUES (?, ?, ?, ?)",
            [idMision, idUsuario, fechaActual, fechaReservaLimite]
          );

        var idMisionDitor = null;

        if (rows.affectedRows > 0) {
          idMisionDitor = rows.insertId;
          console.log(
            `La mision_ditor con id ${idMisionDitor} ha sido creada.`
          );
        }
        // SIEMPRE SE REALIZA ASIGNACION AUTOMATICA
        if (true) {
          // cambiar el estado de la mision a asignada
          await mysqlConnection
            .promise()
            .execute("UPDATE mision SET estado_mision = 3 WHERE id = ?", [
              idMision,
            ]);

          // obtener id de campania y duracion_mision de la tabla campania
          [rows] = await mysqlConnection.promise().execute(
            "SELECT c.id, c.duracion_mision \
                FROM campania c \
                INNER JOIN mision m ON c.id = m.campania \
                WHERE m.id = ?",
            [idMision]
          );

          const duracionAsignacion = rows[0].duracion_mision; // en minutos
          // Obtener las preguntas que tienen fotos
          [rows] = await mysqlConnection.promise().execute(
            "SELECT pregunta_campania.id, pregunta_campania.cantidad_de_fotos \
                                                  FROM pregunta_campania \
                                                  WHERE pregunta_campania.campania = ? AND (pregunta_campania.cantidad_de_fotos > 0)",
            [idCampania]
          );

          // Iterar por cada pregunta y crear los inserts correspondientes
          let inserts = "";
          let cantidad_de_fotos = 0;
          for (const row of rows) {
            if (row.cantidad_de_fotos > 0) {
              cantidad_de_fotos = row.cantidad_de_fotos;
            }
            for (let i = 0; i < cantidad_de_fotos; i++) {
              inserts += `(${row.id}, ${idMisionDitor}),`;
            }
            cantidad_de_fotos = 0;
          }
          if (inserts) {
            inserts = inserts.slice(0, -1); // Eliminar la última coma
            // Ejecutar la cadena de texto con los inserts en un solo llamado a la base de datos
            await mysqlConnection
              .promise()
              .execute(
                `INSERT INTO fotos_mision_ditor (pregunta_campania, mision_ditor) VALUES ${inserts}`
              );
          } else {
            console.log(
              "No hay registros para insertar en la tabla fotos_mision_ditor."
            );
          }
          // en mision_ditor actualizar fecha_asignacion, fecha_asignacion_limite y estado_mision_ditor cambiar a 2, puede existir mas de una mision_ditor con mismo idMision y idUsuario, elegir la última creada (es decir la más reciente)
          const fechaActual = new Date();
          const fechaAsignacionLimite = new Date(
            fechaActual.getTime() + duracionAsignacion * 60000
          );
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "UPDATE mision_ditor SET fecha_asignacion = ?, fecha_asignacion_limite = ?, estado_mision_ditor = 2 WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1",
              [fechaActual, fechaAsignacionLimite, idMision, idUsuario]
            );

          if (rows.affectedRows > 0) {
            console.log(
              `La mision con id ${idMision} ha sido asignada a el ditor con id ${idUsuario}.`
            );
            res.status(200).json({
              idMisionDitor: idMisionDitor,
              duracionAsignacion: duracionAsignacion,
              fechaAsignacion: moment(fechaActual).format(
                "DD/MM/YYYY HH:mm:ss"
              ),
              fechaAsignacionLimite: moment(fechaAsignacionLimite).format(
                "DD/MM/YYYY HH:mm:ss"
              ),
              estadoMision: 3,
              mensaje: "La mision ha sido asignada",
            });
          } else {
            res.status(422).json("La misión no esta reservada");
          }
        }
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

router.get("/mision/asignar/:idMision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idMision = req.params.idMision ? req.params.idMision : null;
    const idUsuario = cabecera.id;

    try {
      // validar que el cliente tenga la mision idMision
      var [mision_ditor] = await mysqlConnection
        .promise()
        .execute(
          "SELECT id, estado_mision_ditor, fecha_asignacion, fecha_asignacion_limite FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1",
          [idMision, idUsuario]
        );
      if (mision_ditor.length > 0) {
        // obtener id de campania y duracion_mision de la tabla campania
        [rows] = await mysqlConnection.promise().execute(
          "SELECT c.id, c.duracion_mision \
                                                            FROM campania c \
                                                            INNER JOIN mision m ON c.id = m.campania \
                                                            WHERE m.id = ?",
          [idMision]
        );
        const idCampania = rows[0].id;
        const duracionAsignacion = rows[0].duracion_mision;
        const idMisionDitor = mision_ditor[0].id;
        const fechaAsignacion = mision_ditor[0].fecha_asignacion;
        const fechaAsignacionLimite = mision_ditor[0].fecha_asignacion_limite;

        // obtener informacion del articulo
        [rows] = await mysqlConnection.promise().execute(
          "SELECT \
                                                          a.nombre AS nombre, \
                                                          a.descripcion AS descripcion, \
                                                          ia.archivo AS archivo_articulo, \
                                                          logo_cliente.archivo AS archivo_logo_cliente \
                                                        FROM imagenes_articulo as ia \
                                                        INNER JOIN articulo a ON ia.articulo = a.id \
                                                        INNER JOIN logo_cliente ON a.cliente = logo_cliente.cliente \
                                                          INNER JOIN campania ca ON a.id = ca.articulo \
                                                        WHERE ca.id = ?",
          [idCampania]
        );
        var archivo_logo_cliente = "";
        var articulo = {};
        if (rows.length > 0) {
          // obtener enlace a logo
          getObjectParams = {
            Bucket: bucketName,
            Key: rows[0].archivo_logo_cliente,
          };
          command = new GetObjectCommand(getObjectParams);
          url = await getSignedUrl(s3, command, { expiresIn: 3600 });
          archivo_logo_cliente = url;
          // obtener enlaces a imagenes de articulo
          articulo = {
            nombre: rows[0].nombre,
            descripcion: rows[0].descripcion,
            archivos: [],
          };
          for (let i = 0; i < rows.length; i++) {
            getObjectParams = {
              Bucket: bucketName,
              Key: rows[i].archivo_articulo,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            articulo.archivos.push(url);
          }
        } else {
          res.status(404).json("No se encontró el artículo");
        }

        // obtener preguntas y respuestas
        [rows] = await mysqlConnection.promise().execute(
          "SELECT \
                                        pc.id AS id_pregunta_campania, \
                                        tpc.id AS id_tipo_pregunta, \
                                        tpc.nombre AS tipo_pregunta, \
                                        tr.id AS id_tipo_respuesta, \
                                        tr.nombre AS tipo_respuesta, \
                                        pc.pregunta AS pregunta_campania, \
                                        pc.cantidad_de_fotos AS cantidad_de_fotos, \
                                        pc.obligatoria AS pregunta_obligatoria, \
                                        pcr.id AS id_respuesta_campania, \
                                        pcr.respuesta AS respuesta_campania, \
                                        mdrs.mision_ditor AS mision_ditor_respondio, \
                                        fm.id as id_foto_mision_ditor_respondio, \
                                        fm.archivo AS archivo_foto_mision_ditor_respondio, \
                                        mdrs.respuesta_texto AS respuesta_texto_respondio, \
                                        mdrs.respuesta_numero AS respuesta_numero_respondio, \
                                        mdrs.respuesta_si_no AS respuesta_si_no_respondio, \
                                        mdrm.pregunta_campania_respuesta AS respuesta_multiple_respondio \
                                        FROM pregunta_campania pc \
                                        LEFT JOIN tipo_pregunta tpc ON pc.tipo_pregunta = tpc.id \
                                        LEFT JOIN tipo_respuesta tr ON pc.tipo_respuesta = tr.id \
                                        LEFT JOIN pregunta_campania_respuesta pcr ON pc.id = pcr.pregunta_campania \
                                        LEFT JOIN mision_ditor_respuesta_simple mdrs ON pc.id = mdrs.pregunta_campania AND mdrs.mision_ditor = ? \
                                        LEFT JOIN fotos_mision_ditor fm ON pc.id = fm.pregunta_campania AND fm.mision_ditor = ? \
                                        LEFT JOIN mision_ditor_respuesta_multiple mdrm ON mdrs.id = mdrm.mision_ditor_respuesta_simple AND mdrm.pregunta_campania_respuesta = pcr.id \
                                        WHERE pc.campania = ? AND pc.habilitada = 'Y' \
                                        ORDER BY id_tipo_pregunta, id_pregunta_campania",
          [idMisionDitor, idMisionDitor, idCampania]
        );

        const preguntasRespuestas = {};
        // console.log (rows);
        var cantidad_fotos_respondidas = 0;
        var id_pregunta_campania_anterior = rows[0].id_pregunta_campania;
        var es_foto = false;
        var total_fotos_a_responder = 0;

        for (const row of rows) {
          const {
            id_pregunta_campania,
            id_tipo_pregunta,
            tipo_pregunta,
            id_tipo_respuesta,
            tipo_respuesta,
            pregunta_campania,
            cantidad_de_fotos,
            pregunta_obligatoria,
            id_respuesta_campania,
            respuesta_campania,
            id_foto_mision_ditor_respondio,
            mision_ditor_respondio,
            archivo_foto_mision_ditor_respondio,
            respuesta_texto_respondio,
            respuesta_numero_respondio,
            respuesta_si_no_respondio,
            respuesta_multiple_respondio,
          } = row;

          if (cantidad_de_fotos > 0) {
            total_fotos_a_responder = cantidad_de_fotos;
            es_foto = true;
          }
          if (id_pregunta_campania != id_pregunta_campania_anterior) {
            cantidad_fotos_respondidas = 0;
            id_pregunta_campania_anterior = id_pregunta_campania;
          }

          if (archivo_foto_mision_ditor_respondio != null) {
            cantidad_fotos_respondidas += 1;
          }

          if (!preguntasRespuestas[id_pregunta_campania]) {
            preguntasRespuestas[id_pregunta_campania] = {
              id_pregunta: id_pregunta_campania,
              id_tipo_pregunta: id_tipo_pregunta,
              tipo_pregunta: tipo_pregunta,
              id_tipo_respuesta: id_tipo_respuesta,
              tipo_respuesta: tipo_respuesta,
              pregunta: pregunta_campania,
              cantidad_de_fotos: cantidad_de_fotos,
              pregunta_obligatoria: pregunta_obligatoria,
              pregunta_respondida: mision_ditor_respondio ? "Y" : "N",
              respuesta_respondida:
                respuesta_texto_respondio ||
                respuesta_numero_respondio ||
                respuesta_si_no_respondio ||
                "",
              fotos_mision: [],
              respuestas: [],
            };
          } else {
            if (
              es_foto &&
              cantidad_fotos_respondidas == total_fotos_a_responder
            ) {
              preguntasRespuestas[id_pregunta_campania].pregunta_respondida =
                "Y";
            }
          }
          if (id_foto_mision_ditor_respondio != null) {
            if (archivo_foto_mision_ditor_respondio != null) {
              getObjectParams = {
                Bucket: bucketName,
                Key: archivo_foto_mision_ditor_respondio,
              };
              command = new GetObjectCommand(getObjectParams);
              url = await getSignedUrl(s3, command, { expiresIn: 3600 });
              preguntasRespuestas[id_pregunta_campania].fotos_mision.push({
                id: id_foto_mision_ditor_respondio,
                archivo: url ? url : "N",
              });
            } else {
              preguntasRespuestas[id_pregunta_campania].fotos_mision.push({
                id: id_foto_mision_ditor_respondio,
                archivo: "N",
              });
            }
            if (cantidad_fotos_respondidas == total_fotos_a_responder) {
              preguntasRespuestas[id_pregunta_campania].pregunta_respondida =
                "Y";
            }
          }
          if (respuesta_multiple_respondio) {
            if (
              preguntasRespuestas[id_pregunta_campania].respuesta_respondida ==
              ""
            ) {
              preguntasRespuestas[id_pregunta_campania].respuesta_respondida =
                respuesta_campania;
            } else {
              preguntasRespuestas[
                id_pregunta_campania
              ].respuesta_respondida += `, ${respuesta_campania}`;
            }
          }
          // if (respuesta_multiple_respondio) {
          //   preguntasRespuestas[id_pregunta_campania].respuestas_respondidas.push(respuesta_multiple_respondio);
          // }

          // respuestas simple o checkbox
          if (id_respuesta_campania) {
            preguntasRespuestas[id_pregunta_campania].respuestas.push({
              id: id_respuesta_campania,
              respuesta: respuesta_campania,
            });
          }

          es_foto = false;
        }

        const preguntasRespuestasArray = Object.values(preguntasRespuestas);

        var preguntas_sin_responder = 0;
        for (const pregunta of preguntasRespuestasArray) {
          if (pregunta.pregunta_respondida == "N") {
            preguntas_sin_responder += 1;
          }
        }

        // objeto con la respuesta final
        const respuestaFinal = {
          informacion: {
            id_mision_ditor: idMisionDitor,
            logo_cliente: archivo_logo_cliente,
            articulo: articulo,
            duracion_asignacion: duracionAsignacion,
            preguntas_sin_responder: preguntas_sin_responder,
            fecha_asignacion: moment(fechaAsignacion).format(
              "DD/MM/YYYY HH:mm:ss"
            ),
            fecha_asignacion_limite: moment(fechaAsignacionLimite).format(
              "DD/MM/YYYY HH:mm:ss"
            ),
          },
          cuestionario: preguntasRespuestasArray,
        };
        res.status(200).json(respuestaFinal);
      } else {
        res.status(404).json("La misión no esta asignada al ditor");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .json("Error al obtener la información de la misión del ditor");
    }
  } else {
    res.status(403).json("No tienes permisos para acceder a esta información");
  }
});

router.get("/mision/seccion_cuestionario/:idMision/:idTipoPregunta", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idMision = req.params.idMision ? req.params.idMision : null;
    const idTipoPregunta = req.params.idTipoPregunta ? req.params.idTipoPregunta : null;
    const idUsuario = cabecera.id;

    try {
      // validar que el cliente tenga la mision idMision
      var [mision_ditor] = await mysqlConnection
        .promise()
        .execute(
          "SELECT id, estado_mision_ditor, fecha_asignacion, fecha_asignacion_limite FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1",
          [idMision, idUsuario]
        );
      if (mision_ditor.length > 0) {
        // obtener id de campania y duracion_mision de la tabla campania
        [rows] = await mysqlConnection.promise().execute(
          "SELECT c.id, c.duracion_mision \
                                                            FROM campania c \
                                                            INNER JOIN mision m ON c.id = m.campania \
                                                            WHERE m.id = ?",
          [idMision]
        );
        const idCampania = rows[0].id;
        const duracionAsignacion = rows[0].duracion_mision;
        const idMisionDitor = mision_ditor[0].id;
        const fechaAsignacion = mision_ditor[0].fecha_asignacion;
        const fechaAsignacionLimite = mision_ditor[0].fecha_asignacion_limite;

        // obtener informacion del articulo
        [rows] = await mysqlConnection.promise().execute(
          "SELECT \
                                                          a.nombre AS nombre, \
                                                          a.descripcion AS descripcion, \
                                                          ia.archivo AS archivo_articulo, \
                                                          logo_cliente.archivo AS archivo_logo_cliente \
                                                        FROM imagenes_articulo as ia \
                                                        INNER JOIN articulo a ON ia.articulo = a.id \
                                                        INNER JOIN logo_cliente ON a.cliente = logo_cliente.cliente \
                                                          INNER JOIN campania ca ON a.id = ca.articulo \
                                                        WHERE ca.id = ?",
          [idCampania]
        );
        var archivo_logo_cliente = "";
        var articulo = {};
        if (rows.length > 0) {
          // obtener enlace a logo
          getObjectParams = {
            Bucket: bucketName,
            Key: rows[0].archivo_logo_cliente,
          };
          command = new GetObjectCommand(getObjectParams);
          url = await getSignedUrl(s3, command, { expiresIn: 3600 });
          archivo_logo_cliente = url;
          // obtener enlaces a imagenes de articulo
          articulo = {
            nombre: rows[0].nombre,
            descripcion: rows[0].descripcion,
            archivos: [],
          };
          for (let i = 0; i < rows.length; i++) {
            getObjectParams = {
              Bucket: bucketName,
              Key: rows[i].archivo_articulo,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            articulo.archivos.push(url);
          }
        } else {
          res.status(404).json("No se encontró el artículo");
        }

        // obtener preguntas y respuestas
        [rows] = await mysqlConnection.promise().execute(
          "SELECT \
                                        pc.id AS id_pregunta_campania, \
                                        tpc.id AS id_tipo_pregunta, \
                                        tpc.nombre AS tipo_pregunta, \
                                        tr.id AS id_tipo_respuesta, \
                                        tr.nombre AS tipo_respuesta, \
                                        pc.pregunta AS pregunta_campania, \
                                        pc.cantidad_de_fotos AS cantidad_de_fotos, \
                                        pc.obligatoria AS pregunta_obligatoria, \
                                        pcr.id AS id_respuesta_campania, \
                                        pcr.respuesta AS respuesta_campania, \
                                        mdrs.mision_ditor AS mision_ditor_respondio, \
                                        fm.id as id_foto_mision_ditor_respondio, \
                                        fm.archivo AS archivo_foto_mision_ditor_respondio, \
                                        mdrs.respuesta_texto AS respuesta_texto_respondio, \
                                        mdrs.respuesta_numero AS respuesta_numero_respondio, \
                                        mdrs.respuesta_si_no AS respuesta_si_no_respondio, \
                                        mdrm.pregunta_campania_respuesta AS respuesta_multiple_respondio \
                                        FROM pregunta_campania pc \
                                        LEFT JOIN tipo_pregunta tpc ON pc.tipo_pregunta = tpc.id \
                                        LEFT JOIN tipo_respuesta tr ON pc.tipo_respuesta = tr.id \
                                        LEFT JOIN pregunta_campania_respuesta pcr ON pc.id = pcr.pregunta_campania \
                                        LEFT JOIN mision_ditor_respuesta_simple mdrs ON pc.id = mdrs.pregunta_campania AND mdrs.mision_ditor = ? \
                                        LEFT JOIN fotos_mision_ditor fm ON pc.id = fm.pregunta_campania AND fm.mision_ditor = ? \
                                        LEFT JOIN mision_ditor_respuesta_multiple mdrm ON mdrs.id = mdrm.mision_ditor_respuesta_simple AND mdrm.pregunta_campania_respuesta = pcr.id \
                                        WHERE pc.campania = ? AND pc.habilitada = 'Y' AND tpc.id = ?\
                                        ORDER BY id_tipo_pregunta, id_pregunta_campania",
          [idMisionDitor, idMisionDitor, idCampania, idTipoPregunta]
        );

        const preguntasRespuestas = {};
        // console.log (rows);
        var cantidad_fotos_respondidas = 0;
        var id_pregunta_campania_anterior = rows[0].id_pregunta_campania;
        var es_foto = false;
        var total_fotos_a_responder = 0;

        for (const row of rows) {
          const {
            id_pregunta_campania,
            id_tipo_pregunta,
            tipo_pregunta,
            id_tipo_respuesta,
            tipo_respuesta,
            pregunta_campania,
            cantidad_de_fotos,
            pregunta_obligatoria,
            id_respuesta_campania,
            respuesta_campania,
            id_foto_mision_ditor_respondio,
            mision_ditor_respondio,
            archivo_foto_mision_ditor_respondio,
            respuesta_texto_respondio,
            respuesta_numero_respondio,
            respuesta_si_no_respondio,
            respuesta_multiple_respondio,
          } = row;

          if (cantidad_de_fotos > 0) {
            total_fotos_a_responder = cantidad_de_fotos;
            es_foto = true;
          }
          if (id_pregunta_campania != id_pregunta_campania_anterior) {
            cantidad_fotos_respondidas = 0;
            id_pregunta_campania_anterior = id_pregunta_campania;
          }

          if (archivo_foto_mision_ditor_respondio != null) {
            cantidad_fotos_respondidas += 1;
          }

          if (!preguntasRespuestas[id_pregunta_campania]) {
            preguntasRespuestas[id_pregunta_campania] = {
              id_pregunta: id_pregunta_campania,
              id_tipo_pregunta: id_tipo_pregunta,
              tipo_pregunta: tipo_pregunta,
              id_tipo_respuesta: id_tipo_respuesta,
              tipo_respuesta: tipo_respuesta,
              pregunta: pregunta_campania,
              cantidad_de_fotos: cantidad_de_fotos,
              pregunta_obligatoria: pregunta_obligatoria,
              pregunta_respondida: mision_ditor_respondio ? "Y" : "N",
              respuesta_respondida:
                respuesta_texto_respondio ||
                respuesta_numero_respondio ||
                respuesta_si_no_respondio ||
                "",
              fotos_mision: [],
              respuestas: [],
            };
          } else {
            if (
              es_foto &&
              cantidad_fotos_respondidas == total_fotos_a_responder
            ) {
              preguntasRespuestas[id_pregunta_campania].pregunta_respondida =
                "Y";
            }
          }
          if (id_foto_mision_ditor_respondio != null) {
            if (archivo_foto_mision_ditor_respondio != null) {
              getObjectParams = {
                Bucket: bucketName,
                Key: archivo_foto_mision_ditor_respondio,
              };
              command = new GetObjectCommand(getObjectParams);
              url = await getSignedUrl(s3, command, { expiresIn: 3600 });
              preguntasRespuestas[id_pregunta_campania].fotos_mision.push({
                id: id_foto_mision_ditor_respondio,
                archivo: url ? url : "N",
              });
            } else {
              preguntasRespuestas[id_pregunta_campania].fotos_mision.push({
                id: id_foto_mision_ditor_respondio,
                archivo: "N",
              });
            }
            if (cantidad_fotos_respondidas == total_fotos_a_responder) {
              preguntasRespuestas[id_pregunta_campania].pregunta_respondida =
                "Y";
            }
          }
          if (respuesta_multiple_respondio) {
            if (
              preguntasRespuestas[id_pregunta_campania].respuesta_respondida ==
              ""
            ) {
              preguntasRespuestas[id_pregunta_campania].respuesta_respondida =
                respuesta_campania;
            } else {
              preguntasRespuestas[
                id_pregunta_campania
              ].respuesta_respondida += `, ${respuesta_campania}`;
            }
          }
          // if (respuesta_multiple_respondio) {
          //   preguntasRespuestas[id_pregunta_campania].respuestas_respondidas.push(respuesta_multiple_respondio);
          // }

          // respuestas simple o checkbox
          if (id_respuesta_campania) {
            preguntasRespuestas[id_pregunta_campania].respuestas.push({
              id: id_respuesta_campania,
              respuesta: respuesta_campania,
            });
          }

          es_foto = false;
        }

        const preguntasRespuestasArray = Object.values(preguntasRespuestas);

        var preguntas_sin_responder = 0;
        for (const pregunta of preguntasRespuestasArray) {
          if (pregunta.pregunta_respondida == "N") {
            preguntas_sin_responder += 1;
          }
        }

        // objeto con la respuesta final
        const respuestaFinal = {
          informacion: {
            id_mision_ditor: idMisionDitor,
            logo_cliente: archivo_logo_cliente,
            articulo: articulo,
            duracion_asignacion: duracionAsignacion,
            preguntas_sin_responder: preguntas_sin_responder,
            fecha_asignacion: moment(fechaAsignacion).format(
              "DD/MM/YYYY HH:mm:ss"
            ),
            fecha_asignacion_limite: moment(fechaAsignacionLimite).format(
              "DD/MM/YYYY HH:mm:ss"
            ),
          },
          cuestionario: preguntasRespuestasArray,
        };
        res.status(200).json(respuestaFinal);
      } else {
        res.status(404).json("La misión no esta asignada al ditor");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .json("Error al obtener la información de la misión del ditor");
    }
  } else {
    res.status(403).json("No tienes permisos para acceder a esta información");
  }
});

router.get("/mision/tipo_pregunta/:idMision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {

    const idMision = req.params.idMision ? req.params.idMision : null;

    var [idCamp] = await mysqlConnection
      .promise()
      .execute(
        "SELECT campania FROM mision WHERE id = ? ORDER BY id DESC LIMIT 1",
        [idMision]
      );

    const idCampania = idCamp[0].campania;

    const query = `SELECT tp.id, tp.nombre from pregunta_campania pc
                      INNER JOIN tipo_pregunta tp ON (pc.tipo_pregunta = tp.id)
                      WHERE pc.campania = ? AND pc.habilitada = 'Y'
                      GROUP BY tipo_pregunta`;

    mysqlConnection.query(query, [idCampania], (error, results) => {
      if (error) {
        console.log(error);
        res.status(500).send("Error al consultar la base de datos");
      } else {
        res.send(results);
      }
    });
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get(
  "/mision/respuesta/fotos/:idMision/:idPregunta",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idMision = req.params.idMision ? req.params.idMision : null;
      const idPregunta = req.params.idPregunta ? req.params.idPregunta : null;

      try {
        // validar que el cliente tenga la mision idMision
        var [rows] = await mysqlConnection
          .promise()
          .execute(
            "SELECT id, estado_mision_ditor FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1",
            [idMision, cabecera.id]
          );
        console.log(rows);
        if (rows.length > 0) {
          // obtener el campo archivo de la tabla fotos_mision_ditor que tengan mision_ditor y pregunta_campania
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "SELECT id, archivo FROM fotos_mision_ditor WHERE mision_ditor = ? AND pregunta_campania = ?",
              [rows[0].id, idPregunta]
            );
          console.log("rows: ", rows);
          const fotos = [];
          if (rows.length > 0) {
            for (let i = 0; i < rows.length; i++) {
              if (rows[i].archivo != null) {
                getObjectParams = {
                  Bucket: bucketName,
                  Key: rows[i].archivo,
                };
                command = new GetObjectCommand(getObjectParams);
                url = await getSignedUrl(s3, command, { expiresIn: 3600 });
                fotos.push({ id_foto_mision: rows[i].id, archivo: url });
              } else {
                fotos.push({ id_foto_mision: rows[i].id, archivo: "" });
              }
            }
          }

          res.status(200).json(fotos);
        } else {
          res.status(404).json("La misión no esta asignada al ditor");
        }
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .json("Error al obtener las fotos de la misión del ditor");
      }
    } else {
      res
        .status(403)
        .json("No tienes permisos para acceder a esta información");
    }
  }
);

var uploadImagenDitor = multer({ storage: storage });
var uploadFotoMision = uploadImagenDitor.fields([{ name: "imagen" }]);
// necesito el id de la mision, el id de la pregunta, el id del tipo de respuesta, el id de la respuesta o texto o imagen y el id del usuario
router.post(
  "/mision/respuesta/:idMision",
  verifyToken,
  uploadFotoMision,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idMision = req.params.idMision ? req.params.idMision : null;
      const idUsuario = cabecera.id;

      // validar que la fecha actual sea menor a la fecha_asignacion_limite de la ultima mision_ditor creada
      var [rows] = await mysqlConnection
        .promise()
        .execute(
          "SELECT id,fecha_asignacion_limite FROM mision_ditor WHERE mision = ? and ditor = ? ORDER BY id DESC LIMIT 1",
          [idMision, idUsuario]
        );

      if (rows.length > 0) {
        const idMisionDitor = rows[0].id;
        const fechaAsignacionLimite = rows[0].fecha_asignacion_limite;

        const fechaActual = new Date();

        if (fechaActual < fechaAsignacionLimite) {
          // guardar la respuesta
          const idPregunta = req.body.id_pregunta
            ? parseInt(req.body.id_pregunta)
            : null;
          const idTipoRespuesta = req.body.id_tipo_respuesta
            ? parseInt(req.body.id_tipo_respuesta)
            : null;
          const idFotoMision = req.body.id_foto_mision
            ? parseInt(req.body.id_foto_mision)
            : null;
          const idRespuesta = req.body.id_respuesta
            ? req.body.id_respuesta.map((respuesta) => parseInt(respuesta))
            : null;
          const respuesta = req.body.respuesta ? req.body.respuesta : null;

          console.log(
            "idPregunta: " + idPregunta,
            "idTipoRespuesta: " + idTipoRespuesta,
            "idRespuesta: " + idRespuesta,
            "respuesta: " + respuesta
          );
          // idTipoRespuesta = 1 -> respuesta Si / No (idRespuesta = [])
          // idTipoRespuesta = 2 -> respuesta de tipo Foto (idRespuesta = [])
          // idTipoRespuesta = 3 -> respuesta de tipo Número (idRespuesta = [])
          // idTipoRespuesta = 4 -> respuesta de tipo Opción simple (idRespuesta = [id1])
          // idTipoRespuesta = 5 -> respuesta de tipo Check box (idRespuesta = [id1,id2,etc.])
          // idTipoRespuesta = 6 -> respuesta de tipo Texto (idRespuesta = [])
          // idTipoRespuesta = 7 -> respuesta de tipo Rating (idRespuesta = [])
          // idTipoRespuesta = 8 -> respuesta de tipo Firma (idRespuesta = [])
          // idTipoRespuesta = 9 -> respuesta de tipo Video (idRespuesta = [])

          if (idPregunta && idTipoRespuesta) {
            // Revisar si ya existe una respuesta para esa pregunta, si existe, actualizarla, si no, crearla
            if (
              idTipoRespuesta !== 2 ||
              idTipoRespuesta !== 8 ||
              idTipoRespuesta !== 9
            ) {
              var [rows] = await mysqlConnection
                .promise()
                .execute(
                  "SELECT id FROM mision_ditor_respuesta_simple WHERE mision_ditor = ? and pregunta_campania = ?",
                  [idMisionDitor, idPregunta]
                );
              var idRespuestaSimpleRespondida = null;
              if (rows.length > 0) {
                // actualizar la respuesta
                idRespuestaSimpleRespondida = rows[0].id;
              }
            }

            // switch para validar el tipo de respuesta
            switch (idTipoRespuesta) {
              case 1: // validar que la respuesta sea Si o No
                if (respuesta === "Y" || respuesta === "N") {
                  if (idRespuestaSimpleRespondida) {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE mision_ditor_respuesta_simple SET respuesta_si_no = ? WHERE id = ?",
                        [respuesta, idRespuestaSimpleRespondida]
                      );
                  } else {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_simple (mision_ditor, pregunta_campania, tipo_respuesta, respuesta_si_no) VALUES (?, ?, ?, ?)",
                        [idMisionDitor, idPregunta, idTipoRespuesta, respuesta]
                      );
                  }
                  res.status(200).json("Respuesta guardada correctamente");
                } else {
                  res.status(500).json("La respuesta debe ser Si o No");
                }

                break;
              case 2: // validar que la respuesta sea una imagen
                if (req.files.imagen) {
                  var [rows] = await mysqlConnection
                    .promise()
                    .execute(
                      "SELECT archivo FROM fotos_mision_ditor WHERE id = ?",
                      [idFotoMision]
                    );
                  // si rows.archivo es distinto de null debo eliminar las fotos subidas al bucket de s3
                  if (rows.length > 0) {
                    if (
                      rows[0].archivo !== null &&
                      rows[0].archivo !== "" &&
                      rows[0].archivo !== undefined
                    ) {
                      // eliminar la foto del bucket de s3
                      var archivosParaEliminar = [];
                      params = {
                        Bucket: bucketName,
                        Delete: {
                          Objects: [],
                          Quiet: false,
                        },
                      };

                      archivosParaEliminar.push(rows[0].archivo);

                      console.log(
                        "ARCHIVO PARA ELIMINAR: ",
                        archivosParaEliminar
                      );
                      if (archivosParaEliminar.length > 0) {
                        params.Delete.Objects.push({
                          Key: archivosParaEliminar[0],
                        });
                        command = new DeleteObjectsCommand(params);
                        await s3.send(command);
                      }
                    }
                  } else {
                    res.status(500).send("Error interno");
                  }
                  // subir las fotos al bucket de s3
                  var funcionesSubidaS3Paralela = [];

                  req.files.imagen[0].filename = randomImageName();
                  const paramsImagen = {
                    Bucket: bucketName,
                    Key: req.files.imagen[0].filename,
                    Body: req.files.imagen[0].buffer,
                    ContentType: "image/jpeg",
                  };
                  const commandImagen = new PutObjectCommand(paramsImagen);
                  funcionesSubidaS3Paralela.push(s3.send(commandImagen));
                  Promise.all(funcionesSubidaS3Paralela).then(
                    successCallback,
                    errorCallback
                  );

                  async function successCallback(result) {
                    console.log("se subieron los archivos");
                    // actualizar la tabla fotos_mision_ditor con el nombre de la foto
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE fotos_mision_ditor SET archivo = ? WHERE id = ?",
                        [req.files.imagen[0].filename, idFotoMision]
                      );

                    res.status(200).send("Se subió la imagen correctamente");
                  }
                  function errorCallback(error) {
                    res.status(500).send("No se pudo subir la imagen");
                  }
                } else {
                  res.status(500).send("No se recibió la imagen");
                }
                break;
              case 3: // validar que la respuesta sea un número float
                if (respuesta && !isNaN(respuesta)) {
                  if (idRespuestaSimpleRespondida) {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE mision_ditor_respuesta_simple SET respuesta_numero = ? WHERE id = ?",
                        [respuesta, idRespuestaSimpleRespondida]
                      );
                  } else {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_simple (mision_ditor, pregunta_campania, tipo_respuesta, respuesta_numero) VALUES (?, ?, ?, ?)",
                        [idMisionDitor, idPregunta, idTipoRespuesta, respuesta]
                      );
                  }
                  res.status(200).json("Respuesta guardada correctamente");
                } else {
                  res.status(500).json("La respuesta debe ser un número");
                }
                break;
              case 4: // validar que idRespuesta sea un vector con un solo elemento
                if (idRespuesta && idRespuesta.length === 1) {
                  if (idRespuestaSimpleRespondida) {
                    // actualizar tabla mision_ditor_respuesta_multiple
                    var [rows] = await mysqlConnection.promise().execute(
                      "UPDATE mision_ditor_respuesta_multiple \
                                                        SET pregunta_campania_respuesta = ? \
                                                        WHERE mision_ditor_respuesta_simple = ?",
                      [idRespuesta[0], idRespuestaSimpleRespondida]
                    );

                    var [rows] = await mysqlConnection.promise().execute(
                      "UPDATE mision_ditor_respuesta_simple \
                                                        SET fecha_modificacion = NOW() \
                                                        WHERE id = ?",
                      [idRespuestaSimpleRespondida]
                    );
                  } else {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_simple (mision_ditor, pregunta_campania, tipo_respuesta) VALUES (?, ?, ?)",
                        [idMisionDitor, idPregunta, idTipoRespuesta]
                      );
                    const idRespuestaSimpleRespondida = rows.insertId;
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_multiple (mision_ditor_respuesta_simple, pregunta_campania_respuesta) VALUES (?, ?)",
                        [idRespuestaSimpleRespondida, idRespuesta[0]]
                      );
                  }
                  res.status(200).json("Respuesta guardada correctamente");
                } else {
                  res
                    .status(500)
                    .json("La respuesta debe tener un solo elemento");
                }
                break;
              case 5: // validar que idRespuesta sea un vector con al menos un elemento
                if (idRespuesta && idRespuesta.length > 0) {
                  if (idRespuestaSimpleRespondida) {
                    // actualizar tabla mision_ditor_respuesta_multiple y actualizar fecha_modificacion en mision_ditor_respuesta_simple
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE mision_ditor_respuesta_simple SET fecha_modificacion = NOW() WHERE id = ?",
                        [idRespuestaSimpleRespondida]
                      );

                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "DELETE FROM mision_ditor_respuesta_multiple WHERE mision_ditor_respuesta_simple = ?",
                        [idRespuestaSimpleRespondida]
                      );
                  } else {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_simple (mision_ditor, pregunta_campania, tipo_respuesta) VALUES (?, ?, ?)",
                        [idMisionDitor, idPregunta, idTipoRespuesta]
                      );
                    idRespuestaSimpleRespondida = rows.insertId;
                  }
                  var values = idRespuesta
                    .map((id) => `(${idRespuestaSimpleRespondida}, ${id})`)
                    .join(",");
                  var [rows] = await mysqlConnection
                    .promise()
                    .execute(
                      `INSERT INTO mision_ditor_respuesta_multiple (mision_ditor_respuesta_simple, pregunta_campania_respuesta) VALUES ${values}`
                    );

                  res.status(200).json("Respuesta guardada correctamente");
                } else {
                  res
                    .status(500)
                    .json("Faltan datos para guardar la respuesta");
                }
                break;
              case 6: // validar que la respuesta sea un texto
                if (respuesta) {
                  if (idRespuestaSimpleRespondida) {
                    // actualizar tabla misión_ditor_respuesta_simple
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE mision_ditor_respuesta_simple SET respuesta_texto = ? WHERE id = ?",
                        [respuesta, idRespuestaSimpleRespondida]
                      );
                  } else {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_simple (mision_ditor, pregunta_campania, tipo_respuesta, respuesta_texto) VALUES (?, ?, ?, ?)",
                        [idMisionDitor, idPregunta, idTipoRespuesta, respuesta]
                      );
                  }
                  res.status(200).json("Respuesta guardada correctamente");
                } else {
                  res
                    .status(500)
                    .json("Faltan datos para guardar la respuesta");
                }
                break;
              case 7: // estrellas: validar que la respuesta sea un número float
                if (respuesta && !isNaN(respuesta)) {
                  if (idRespuestaSimpleRespondida) {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE mision_ditor_respuesta_simple SET respuesta_numero = ? WHERE id = ?",
                        [respuesta, idRespuestaSimpleRespondida]
                      );
                  } else {
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "INSERT INTO mision_ditor_respuesta_simple (mision_ditor, pregunta_campania, tipo_respuesta, respuesta_numero) VALUES (?, ?, ?, ?)",
                        [idMisionDitor, idPregunta, idTipoRespuesta, respuesta]
                      );
                  }
                  res.status(200).json("Respuesta guardada correctamente");
                } else {
                  res.status(500).json("La respuesta debe ser un número");
                }
                break;
              case 8: // validar que la respuesta sea una imagen (Firma)
                if (req.files.imagen) {
                  var [rows] = await mysqlConnection
                    .promise()
                    .execute(
                      "SELECT archivo FROM fotos_mision_ditor WHERE id = ?",
                      [idFotoMision]
                    );
                  // si rows.archivo es distinto de null debo eliminar las fotos subidas al bucket de s3
                  if (rows.length > 0) {
                    if (
                      rows[0].archivo !== null &&
                      rows[0].archivo !== "" &&
                      rows[0].archivo !== undefined
                    ) {
                      // eliminar la foto del bucket de s3
                      var archivosParaEliminar = [];
                      params = {
                        Bucket: bucketName,
                        Delete: {
                          Objects: [],
                          Quiet: false,
                        },
                      };

                      archivosParaEliminar.push(rows[0].archivo);

                      console.log(
                        "ARCHIVO PARA ELIMINAR: ",
                        archivosParaEliminar
                      );
                      if (archivosParaEliminar.length > 0) {
                        params.Delete.Objects.push({
                          Key: archivosParaEliminar[0],
                        });
                        command = new DeleteObjectsCommand(params);
                        await s3.send(command);
                      }
                    }
                  } else {
                    res.status(500).send("Error interno");
                  }
                  // subir las fotos al bucket de s3
                  var funcionesSubidaS3Paralela = [];

                  req.files.imagen[0].filename = randomImageName();
                  const paramsImagen = {
                    Bucket: bucketName,
                    Key: req.files.imagen[0].filename,
                    Body: req.files.imagen[0].buffer,
                    ContentType: "image/jpeg",
                  };
                  const commandImagen = new PutObjectCommand(paramsImagen);
                  funcionesSubidaS3Paralela.push(s3.send(commandImagen));
                  Promise.all(funcionesSubidaS3Paralela).then(
                    successCallback,
                    errorCallback
                  );

                  async function successCallback(result) {
                    console.log("se subieron los archivos");
                    // actualizar la tabla fotos_mision_ditor con el nombre de la foto
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE fotos_mision_ditor SET archivo = ? WHERE id = ?",
                        [req.files.imagen[0].filename, idFotoMision]
                      );

                    res.status(200).send("Se subió la imagen correctamente");
                  }
                  function errorCallback(error) {
                    res.status(500).send("No se pudo subir la imagen");
                  }
                } else {
                  res.status(500).send("No se recibió la imagen");
                }
                break;
              case 9: // validar que la respuesta sea un video (Video)
                if (req.files.imagen) {
                  var [rows] = await mysqlConnection
                    .promise()
                    .execute(
                      "SELECT archivo FROM fotos_mision_ditor WHERE id = ?",
                      [idFotoMision]
                    );
                  // si rows.archivo es distinto de null debo eliminar las fotos subidas al bucket de s3
                  if (rows.length > 0) {
                    if (
                      rows[0].archivo !== null &&
                      rows[0].archivo !== "" &&
                      rows[0].archivo !== undefined
                    ) {
                      // eliminar la foto del bucket de s3
                      var archivosParaEliminar = [];
                      params = {
                        Bucket: bucketName,
                        Delete: {
                          Objects: [],
                          Quiet: false,
                        },
                      };

                      archivosParaEliminar.push(rows[0].archivo);

                      console.log(
                        "ARCHIVO PARA ELIMINAR: ",
                        archivosParaEliminar
                      );
                      if (archivosParaEliminar.length > 0) {
                        params.Delete.Objects.push({
                          Key: archivosParaEliminar[0],
                        });
                        command = new DeleteObjectsCommand(params);
                        await s3.send(command);
                      }
                    }
                  } else {
                    res.status(500).send("Error interno");
                  }
                  // subir las fotos al bucket de s3
                  var funcionesSubidaS3Paralela = [];

                  req.files.imagen[0].filename = randomImageName();
                  const paramsImagen = {
                    Bucket: bucketName,
                    Key: req.files.imagen[0].filename,
                    Body: req.files.imagen[0].buffer,
                    ContentType: "image/jpeg",
                  };
                  const commandImagen = new PutObjectCommand(paramsImagen);
                  funcionesSubidaS3Paralela.push(s3.send(commandImagen));
                  Promise.all(funcionesSubidaS3Paralela).then(
                    successCallback,
                    errorCallback
                  );

                  async function successCallback(result) {
                    console.log("se subieron los archivos");
                    // actualizar la tabla fotos_mision_ditor con el nombre de la foto
                    var [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE fotos_mision_ditor SET archivo = ? WHERE id = ?",
                        [req.files.imagen[0].filename, idFotoMision]
                      );

                    res.status(200).send("Se subió la imagen correctamente");
                  }
                  function errorCallback(error) {
                    res.status(500).send("No se pudo subir la imagen");
                  }
                } else {
                  res.status(500).send("No se recibió la imagen");
                }
                break;
              default:
                res.status(500).json("Tipo de respuesta no válido");
                break;
            }
          } else {
            res.status(500).json("Faltan datos para guardar la respuesta");
          }
        } else {
          res.status(404).json("Expiró el tiempo para entregar la misión");
        }
      } else {
        res.status(404).json("La misión no esta asignada al ditor");
      }
    } else {
      //no autorizado
      res.status(401).json("No autorizado");
    }
  }
);

/*
Endpoint POST /mision/finalizar/:id
  - Validar que el usuario sea un ditor
  - Validar que el usuario tenga la misión asignada
  - Validar que la mision_ditor este en estado 2
  - Validar que la fecha actual sea menor a la fecha_asignacion_limite de la ultima mision_ditor creada
  - Validar que todas las preguntas tengan respuesta
  - Cambiar el estado de mision_ditor a '5' (En revisión) y de la misión a 4 (En revisión)
  - Quitar la misión activa del ditor
  - Devolver un mensaje de éxito
*/
router.post("/mision/finalizar/:idMision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idMision = req.params.idMision ? req.params.idMision : null;
    const idUsuario = cabecera.id;

    // validar que la fecha actual sea menor a la fecha_asignacion_limite de la ultima mision_ditor creada
    var [rows] = await mysqlConnection
      .promise()
      .execute(
        "SELECT id,fecha_asignacion_limite,estado_mision_ditor FROM mision_ditor WHERE mision = ? and ditor = ? ORDER BY id DESC LIMIT 1",
        [idMision, idUsuario]
      );

    if (rows.length > 0 && rows[0].estado_mision_ditor == 2) {
      const idMisionDitor = rows[0].id;
      const fechaAsignacionLimite = rows[0].fecha_asignacion_limite;

      const fechaActual = new Date();

      if (fechaActual < fechaAsignacionLimite) {
        // obtener id de campania y precio de la tabla campania
        [rows] = await mysqlConnection.promise().execute(
          `SELECT c.id, m.precio
                                                            FROM campania c
                                                            INNER JOIN mision m ON c.id = m.campania
                                                            WHERE m.id = ?`,
          [idMision]
        );
        const idCampania = rows[0].id;
        const precio = rows[0].precio;

        // validar que todas las preguntas tengan respuesta

        // obtener preguntas y respuestas
        [rows] = await mysqlConnection.promise().execute(
          `SELECT pc.id AS id_pregunta_campania,
                pc.obligatoria AS pregunta_obligatoria,
                tr.id AS id_tipo_respuesta,
                mdrs.mision_ditor AS mision_ditor_respondio,
                fm.archivo AS archivo_foto_mision_ditor_respondio
                FROM pregunta_campania pc
                LEFT JOIN tipo_respuesta tr ON pc.tipo_respuesta = tr.id
                LEFT JOIN mision_ditor_respuesta_simple mdrs ON pc.id = mdrs.pregunta_campania AND mdrs.mision_ditor = ?
                LEFT JOIN fotos_mision_ditor fm ON pc.id = fm.pregunta_campania AND fm.mision_ditor = ?
                WHERE pc.campania = ? AND pc.habilitada = 'Y'
                ORDER BY id_pregunta_campania`,
          [idMisionDitor, idMisionDitor, idCampania]
        );

        console.log("idMisionDitor: ", idMisionDitor);
        console.log("idCampania: ", idCampania);
        var es_foto = false;
        var todas_respondidas = true;
        var index = 0;
        var row = rows[index];
        // mientras el indice sea menor a la cantidad de filas y todas_respondidas sea true
        while (index < rows.length && todas_respondidas) {
          const {
            pregunta_obligatoria,
            id_tipo_respuesta,
            mision_ditor_respondio,
            archivo_foto_mision_ditor_respondio,
          } = row;

          if (
            id_tipo_respuesta == 2 ||
            id_tipo_respuesta == 8 ||
            id_tipo_respuesta == 9
          ) {
            es_foto = true;
          }

          // Verificar si respondio preguntas comunes
          if (!es_foto) {
            if (!mision_ditor_respondio && pregunta_obligatoria === "Y") {
              todas_respondidas = false;
            }
          } else {
            // Verificar si respondio preguntas de fotos
            if (
              archivo_foto_mision_ditor_respondio == null &&
              pregunta_obligatoria === "Y"
            ) {
              todas_respondidas = false;
            }
          }

          es_foto = false;
          index++;
          row = rows[index];
        }

        if (todas_respondidas) {
          // cambiar el estado de mision_ditor a 5 (En revisión) y de la misión a 4 (En revisión)
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "UPDATE mision_ditor SET estado_mision_ditor = 5, fecha_realizacion = NOW() WHERE id = ?",
              [idMisionDitor]
            );
          [rows] = await mysqlConnection
            .promise()
            .execute("UPDATE mision SET estado_mision = 4 WHERE id = ?", [
              idMision,
            ]);

          // quitar la misión activa del ditor
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "UPDATE ditor SET mision_activa = NULL WHERE usuario = ?",
              [idUsuario]
            );
          // sumar a saldo_pendiente de billetera el precio de la misión
          [rows] = await mysqlConnection
            .promise()
            .execute(
              "UPDATE billetera SET saldo_pendiente = saldo_pendiente + ? WHERE usuario = ?",
              [precio, idUsuario]
            );

          res.status(200).json("Misión finalizada correctamente");
        } else {
          res.status(422).json("Faltan preguntas por responder");
        }
      } else {
        res.status(404).json("Expiró el tiempo para entregar la misión");
      }
    } else {
      res.status(404).json("La misión no esta asignada al ditor");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.post(
  "/mision/finalizar-enterprise/:idMision",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idMision = req.params.idMision ? req.params.idMision : null;
      const idUsuario = cabecera.id;

      // validar que la fecha actual sea menor a la fecha_asignacion_limite de la ultima mision_ditor creada
      var [rows] = await mysqlConnection
        .promise()
        .execute(
          "SELECT id,fecha_asignacion_limite,estado_mision_ditor FROM mision_ditor WHERE mision = ? and ditor = ? ORDER BY id DESC LIMIT 1",
          [idMision, idUsuario]
        );

      if (rows.length > 0 && rows[0].estado_mision_ditor == 2) {
        const idMisionDitor = rows[0].id;
        const fechaAsignacionLimite = rows[0].fecha_asignacion_limite;

        const fechaActual = new Date();

        if (fechaActual < fechaAsignacionLimite) {
          // obtener id de campania y precio de la tabla campania
          [rows] = await mysqlConnection.promise().execute(
            `SELECT c.id, m.precio
                                                            FROM campania c
                                                            INNER JOIN mision m ON c.id = m.campania
                                                            WHERE m.id = ?`,
            [idMision]
          );
          const idCampania = rows[0].id;
          const precio = rows[0].precio;

          // validar que todas las preguntas tengan respuesta

          // obtener preguntas y respuestas
          [rows] = await mysqlConnection.promise().execute(
            `SELECT pc.id AS id_pregunta_campania,
                pc.obligatoria AS pregunta_obligatoria,
                tr.id AS id_tipo_respuesta,
                mdrs.mision_ditor AS mision_ditor_respondio,
                fm.archivo AS archivo_foto_mision_ditor_respondio
                FROM pregunta_campania pc
                LEFT JOIN tipo_respuesta tr ON pc.tipo_respuesta = tr.id
                LEFT JOIN mision_ditor_respuesta_simple mdrs ON pc.id = mdrs.pregunta_campania AND mdrs.mision_ditor = ?
                LEFT JOIN fotos_mision_ditor fm ON pc.id = fm.pregunta_campania AND fm.mision_ditor = ?
                WHERE pc.campania = ?  and pc.habilitada = 'Y'
                ORDER BY id_pregunta_campania`,
            [idMisionDitor, idMisionDitor, idCampania]
          );

          console.log("idMisionDitor: ", idMisionDitor);
          console.log("idCampania: ", idCampania);
          var es_foto = false;
          var todas_respondidas = true;
          var index = 0;
          var row = rows[index];
          // mientras el indice sea menor a la cantidad de filas y todas_respondidas sea true
          while (index < rows.length && todas_respondidas) {
            const {
              pregunta_obligatoria,
              id_tipo_respuesta,
              mision_ditor_respondio,
              archivo_foto_mision_ditor_respondio,
            } = row;

            if (
              id_tipo_respuesta == 2 ||
              id_tipo_respuesta == 8 ||
              id_tipo_respuesta == 9
            ) {
              es_foto = true;
            }

            // Verificar si respondio preguntas comunes
            if (!es_foto) {
              if (!mision_ditor_respondio && pregunta_obligatoria === "Y") {
                todas_respondidas = false;
              }
            } else {
              // Verificar si respondio preguntas de fotos
              if (
                archivo_foto_mision_ditor_respondio == null &&
                pregunta_obligatoria === "Y"
              ) {
                todas_respondidas = false;
              }
            }

            es_foto = false;
            index++;
            row = rows[index];
          }

          if (todas_respondidas) {
            // cambiar el estado de mision_ditor a 5 (En revisión) y de la misión a 4 (En revisión)
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE mision_ditor SET estado_mision_ditor = 8, fecha_realizacion = NOW() WHERE id = ?",
                [idMisionDitor]
              );
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE mision SET estado_mision = 5, fecha_finalizacion = NOW() WHERE id = ?",
                [idMision]
              );

            // quitar la misión activa del ditor
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE ditor SET mision_activa = NULL WHERE usuario = ?",
                [idUsuario]
              );
            // sumar a saldo_pendiente de billetera el precio de la misión
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE billetera SET saldo_pendiente = saldo_pendiente + ? WHERE usuario = ?",
                [precio, idUsuario]
              );

            res.status(200).json("Misión finalizada correctamente");
          } else {
            res.status(422).json("Faltan preguntas por responder");
          }
        } else {
          res.status(404).json("Expiró el tiempo para entregar la misión");
        }
      } else {
        res.status(404).json("La misión no esta asignada al ditor");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

router.get("/mision/historial", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  var fechaDesde = req.query.fechaDesde || "1970-01-01";
  var fechaHasta = req.query.fechaHasta || "2100-01-01";
  var fechaQuery = "";
  if (req.query.fechaDesde || req.query.fechaHasta) {
    fechaQuery = ` AND md.fecha_reserva >= '${fechaDesde}' AND md.fecha_reserva <= '${fechaHasta}'`;
  }
  var page = req.query.pagina ? Number(req.query.pagina) : 1;
  if (page < 1) {
    page = 1;
  }
  var resultsPerPage = req.query.cantidad ? Number(req.query.cantidad) : 10;
  var start = (page - 1) * resultsPerPage;
  var status = req.query.estado ? req.query.estado.split(",") : [];
  var statusQuery = "";
  if (status.length > 0) {
    for (let i = 0; i < status.length; i++) {
      status[i] = parseInt(status[i]);
    }
    statusQuery += ` AND md.estado_mision_ditor IN (${status.join(",")})`;
  }
  if (cabecera.rol === "ditor") {
    const idUsuario = cabecera.id;
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT
        CONCAT('#MI',m.id) as id_mision,
        IFNULL(md.motivo, '') as motivo,
        md.archivo as archivo,
        DATE_FORMAT(md.fecha_reserva, '%d/%m/%Y') as fecha_reserva,
        DATE_FORMAT(md.fecha_reserva, '%T') as hora_reserva,
          emd.nombre as estado_mision_ditor,
          IF(m.estado_mision != 5, 0, m.precio) as precio,
          c.nombre as comercio
        FROM mision_ditor md
        INNER JOIN mision m ON md.mision = m.id
        INNER JOIN estado_mision_ditor emd ON md.estado_mision_ditor = emd.id
        INNER JOIN comercio c ON m.comercio = c.id
        WHERE md.ditor = ? 
        ${statusQuery}
        ${fechaQuery}
        ORDER BY md.fecha_reserva DESC
        LIMIT ?, ?
    `,
        [idUsuario, start, resultsPerPage]
      );
      if (rows.length > 0) {
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].archivo != null) {
            getObjectParams = {
              Bucket: bucketName,
              Key: rows[i].archivo,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            rows[i].foto = url;
          } else {
            rows[i].foto = "";
          }
          delete rows[i].archivo;
        }
        const [countRows] = await mysqlConnection.promise().execute(
          `
        SELECT COUNT(*) as count
        FROM mision_ditor md
        INNER JOIN mision m ON md.mision = m.id
        INNER JOIN estado_mision_ditor emd ON md.estado_mision_ditor = emd.id
        INNER JOIN comercio c ON m.comercio = c.id
        WHERE md.ditor = ? 
        ${statusQuery}
        ${fechaQuery}
      `,
          [idUsuario]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);

        res.json({
          items: rows,
          cantidad_de_paginas: numOfPages,
          items_totales: numOfResults,
          pagina_actual: page,
        });
      } else {
        res.json({
          items: rows,
          cantidad_de_paginas: 0,
          items_totales: 0,
          pagina_actual: page,
        });
      }
    } catch (error) {
      console.log(error);
      logger.error(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/mision/todohistorial", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  var fechaDesde = req.query.fechaDesde || "1970-01-01";
  var fechaHasta = req.query.fechaHasta || "2100-01-01";
  var fechaQuery = "";
  var fechaVisita = "";
  var fechaComercio = "";
  if (req.query.fechaDesde || req.query.fechaHasta) {
    fechaQuery = ` AND md.fecha_reserva >= '${fechaDesde}' AND md.fecha_reserva <= '${fechaHasta}'`;
    fechaVisita = ` AND fecha_de_visita >= '${fechaDesde}' AND fecha_de_visita <= '${fechaHasta}'`;
    fechaComercio = ` AND fecha_de_sugerencia >= '${fechaDesde}' AND fecha_de_sugerencia <= '${fechaHasta}'`;
  }
  var page = req.query.pagina ? Number(req.query.pagina) : 1;
  if (page < 1) {
    page = 1;
  }
  var resultsPerPage = req.query.cantidad ? Number(req.query.cantidad) : 10;
  var start = (page - 1) * resultsPerPage;
  var status = req.query.estado ? req.query.estado.split(",") : [];
  var statusQuery = "";
  if (status.length > 0) {
    for (let i = 0; i < status.length; i++) {
      status[i] = parseInt(status[i]);
    }
    statusQuery += ` AND md.estado_mision_ditor IN (${status.join(",")})`;
  }
  if (cabecera.rol === "ditor") {
    const idUsuario = cabecera.id;
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT
        CONCAT('#MI',m.id) as id_mision,
        IFNULL(md.motivo, '') as motivo,
        md.archivo as archivo,
        DATE_FORMAT(md.fecha_reserva, '%d/%m/%Y') as fecha_reserva,
        DATE_FORMAT(md.fecha_reserva, '%T') as hora_reserva,
          emd.nombre as estado_mision_ditor,
          IF(m.estado_mision != 5, 0, m.precio) as precio,
          c.nombre as comercio
        FROM mision_ditor md
        INNER JOIN mision m ON md.mision = m.id
        INNER JOIN estado_mision_ditor emd ON md.estado_mision_ditor = emd.id
        INNER JOIN comercio c ON m.comercio = c.id
        WHERE md.ditor = ? 
        ${statusQuery}
        ${fechaQuery}
        UNION
          SELECT 
            id as id_mision,
            'Visita No Programada' as motivo,
            foto_frente_comercio as archivo,
            DATE_FORMAT(fecha_de_visita, '%d/%m/%Y') as fecha_reserva,
            DATE_FORMAT(fecha_de_visita, '%T') as hora_reserva,
            '' as estado_mision_ditor,
            0 as precio,
            IFNULL(nombre_comercio, '') as comercio
          FROM visita_no_programada
          WHERE visitado_por_znapper = ?
          ${fechaVisita}
        UNION
          SELECT
            id as id_mision,
            'Posible Alta' as motivo,
            foto_frente_comercio as archivo,
            DATE_FORMAT(fecha_de_sugerencia, '%d/%m/%Y') as fecha_reserva,
            DATE_FORMAT(fecha_de_sugerencia, '%T') as hora_reserva,
            finalizado as estado_mision_ditor, 
            0 as precio,
            IFNULL(nombre_comercio, '') as comercio
          FROM comercio_sugerido
          WHERE sugerido_por_znapper = ?
          ${fechaComercio}
        ORDER BY STR_TO_DATE(fecha_reserva, '%d/%m/%Y') DESC, STR_TO_DATE(hora_reserva, '%T') DESC
        LIMIT ?, ?
    `,
        [idUsuario, idUsuario, idUsuario, start, resultsPerPage]
      );
      if (rows.length > 0) {
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].archivo != null) {
            getObjectParams = {
              Bucket: bucketName,
              Key: rows[i].archivo,
            };
            command = new GetObjectCommand(getObjectParams);
            url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            rows[i].foto = url;
          } else {
            rows[i].foto = "";
          }
          delete rows[i].archivo;
        }
        const [countRows] = await mysqlConnection.promise().execute(
          `
          SELECT 
              (SELECT COUNT(*) 
              FROM mision_ditor md
              INNER JOIN mision m ON md.mision = m.id
              INNER JOIN estado_mision_ditor emd ON md.estado_mision_ditor = emd.id
              INNER JOIN comercio c ON m.comercio = c.id
              WHERE md.ditor = ? 
              ${statusQuery}
              ${fechaQuery}
              ) 
              +
              (SELECT COUNT(*) 
              FROM visita_no_programada 
              WHERE visitado_por_znapper = ? 
              ${fechaVisita}
              ) 
              +
              (SELECT COUNT(*) 
              FROM comercio_sugerido 
              WHERE sugerido_por_znapper = ? 
              ${fechaComercio}
              ) as total_count

      `,
          [idUsuario, idUsuario, idUsuario]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);

        res.json({
          items: rows,
          cantidad_de_paginas: numOfPages,
          items_totales: numOfResults,
          pagina_actual: page,
        });
      } else {
        res.json({
          items: rows,
          cantidad_de_paginas: 0,
          items_totales: 0,
          pagina_actual: page,
        });
      }
    } catch (error) {
      console.log(error);
      logger.error(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

var cancelImagenDitor = multer({ storage: storage });
var cancelFotoMision = cancelImagenDitor.fields([{ name: "imagen" }]);
router.post("/mision/cancelar/:idMision", verifyToken, cancelFotoMision,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idMision = req.params.idMision ? req.params.idMision : null;
      const motivo = req.body.motivo ? req.body.motivo : false;
      const marca = req.body.marca ? req.body.marca : 0;
      const idUsuario = cabecera.id;

      if (motivo) {
        // validar que el cliente tenga una mision activa
        var [rows] = await mysqlConnection
          .promise()
          .execute("SELECT mision_activa FROM ditor WHERE usuario = ?", [
            idUsuario,
          ]);

        if (rows[0].mision_activa == idMision) {
          // validar que la mision este reservada
          [rows] = await mysqlConnection
            .promise()
            .execute("SELECT estado_mision FROM mision WHERE id = ?", [
              idMision,
            ]);
          const estadoMision = rows[0].estado_mision;
          // reservada o asignada
          if (estadoMision == 2 || estadoMision == 3) {
            // cambiar el estado de la mision a disponible
            if (marca == 0) {
              [rows] = await mysqlConnection
                .promise()
                .execute("UPDATE mision SET estado_mision = 1 WHERE id = ?", [
                  idMision,
                ]);
            } else {
              [rows] = await mysqlConnection
                .promise()
                .execute("UPDATE mision SET estado_mision = 6 WHERE id = ?", [
                  idMision,
                ]);
            }

            // en la tabla ditor guardo idMision en mision_activa
            [rows] = await mysqlConnection
              .promise()
              .execute(
                "UPDATE ditor SET mision_activa = NULL WHERE usuario = ?",
                [idUsuario]
              );

            // en mision_ditor actualizar fecha_cancelacion_reserva y estado_mision_ditor cambiar a 3, puede existir mas de una mision_ditor con mismo idMision y idUsuario, elegir la última creada (es decir la más reciente)
            const fechaActual = new Date();
            if (req.files.imagen) {
              var [rows] = await mysqlConnection
                .promise()
                .execute(
                  "SELECT archivo FROM mision_ditor WHERE id = (SELECT id FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1)",
                  [idMision, idUsuario]
                );
              // si rows.archivo es distinto de null debo eliminar las fotos subidas al bucket de s3
              if (rows.length > 0) {
                if (
                  rows[0].archivo !== null &&
                  rows[0].archivo !== "" &&
                  rows[0].archivo !== undefined
                ) {
                  // eliminar la foto del bucket de s3
                  var archivosParaEliminar = [];
                  params = {
                    Bucket: bucketName,
                    Delete: {
                      Objects: [],
                      Quiet: false,
                    },
                  };

                  archivosParaEliminar.push(rows[0].archivo);

                  console.log("ARCHIVO PARA ELIMINAR: ", archivosParaEliminar);
                  if (archivosParaEliminar.length > 0) {
                    params.Delete.Objects.push({
                      Key: archivosParaEliminar[0],
                    });
                    command = new DeleteObjectsCommand(params);
                    await s3.send(command);
                  }
                }
              } else {
                res.status(500).send("Error interno");
              }
              // subir las fotos al bucket de s3
              var funcionesSubidaS3Paralela = [];

              req.files.imagen[0].filename = randomImageName();
              const paramsImagen = {
                Bucket: bucketName,
                Key: req.files.imagen[0].filename,
                Body: req.files.imagen[0].buffer,
                ContentType: "image/jpeg",
              };
              const commandImagen = new PutObjectCommand(paramsImagen);
              funcionesSubidaS3Paralela.push(s3.send(commandImagen));
              Promise.all(funcionesSubidaS3Paralela).then(
                successCallback,
                errorCallback
              );

              async function successCallback(result) {
                console.log("se subieron los archivos");
                // actualizar la tabla mision_ditor con el nombre de la foto y el motivo de cancelacion
                if (estadoMision == 2) {
                  [rows] = await mysqlConnection
                    .promise()
                    .execute(
                      "UPDATE mision_ditor SET fecha_cancelacion_reserva = ?, archivo = ?, motivo = ?, estado_mision_ditor = 3 WHERE id = (SELECT id FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1)",
                      [
                        fechaActual,
                        req.files.imagen[0].filename,
                        motivo,
                        idMision,
                        idUsuario,
                      ]
                    );
                } else {
                  [rows] = await mysqlConnection
                    .promise()
                    .execute(
                      "UPDATE mision_ditor SET fecha_cancelacion_asignacion = ?, archivo = ?, motivo = ?, estado_mision_ditor = 4 WHERE id = (SELECT id FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1)",
                      [
                        fechaActual,
                        req.files.imagen[0].filename,
                        motivo,
                        idMision,
                        idUsuario,
                      ]
                    );
                }

                if (rows.affectedRows > 0) {
                  console.log(
                    `La mision con id ${idMision} ha sido cancelada, con foto.`
                  );
                }

                res.status(200).json("La mision ha sido cancelada");
              }
              function errorCallback(error) {
                res.status(500).send("No se pudo subir la imagen");
              }
            } else {
              // actualizar la tabla mision_ditor con el motivo de la cancelacion, sin foto
              if (estadoMision == 2) {
                [rows] = await mysqlConnection
                  .promise()
                  .execute(
                    "UPDATE mision_ditor SET fecha_cancelacion_reserva = ?, motivo = ?, estado_mision_ditor = 3 WHERE id = (SELECT id FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1)",
                    [fechaActual, motivo, idMision, idUsuario]
                  );
              } else {
                [rows] = await mysqlConnection
                  .promise()
                  .execute(
                    "UPDATE mision_ditor SET fecha_cancelacion_asignacion = ?, motivo = ?, estado_mision_ditor = 4 WHERE id = (SELECT id FROM mision_ditor WHERE mision = ? AND ditor = ? ORDER BY id DESC LIMIT 1)",
                    [fechaActual, motivo, idMision, idUsuario]
                  );
              }

              if (rows.affectedRows > 0) {
                console.log(
                  `La mision con id ${idMision} ha sido cancelada, sin foto.`
                );
              }

              res.status(200).json("La mision ha sido cancelada");
            }
          } else {
            res.status(422).json("La mision no esta reservada ni activa");
          }
        } else {
          res.status(422).json("El cliente no tiene una mision activa");
        }
      } else {
        res.status(500).send("No se recibió el motivo de cancelación");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);

router.get("/mision/estado/:idMision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idMision = req.params.idMision ? req.params.idMision : null;
    const idUsuario = cabecera.id;
    // devolver el estado de la misión y el ditor que la tiene asignada mezclando datos de la tabla mision_ditor, estado_mision, mision y ditor (ordenar por id de la más reciente a la más antigua y devolver solo la más reciente)
    try {
      var [rows] = await mysqlConnection.promise().execute(
        "SELECT \
                                                          m.estado_mision as id_estado, \
                                                          em.nombre as estado, \
                                                          CASE WHEN d.mision_activa = ? THEN md.ditor ELSE 0 END as id_ditor \
                                                        FROM mision m \
                                                          INNER JOIN mision_ditor md ON m.id = md.mision \
                                                          INNER JOIN estado_mision em ON m.estado_mision = em.id \
                                                          INNER JOIN ditor d ON md.ditor = d.usuario \
                                                        WHERE m.id = ? \
                                                        ORDER BY md.id DESC \
                                                        LIMIT 1",
        [idMision, idMision]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error en el servidor");
    }
  } else {
    res.status(404).json("Usuario no autorizado");
  }
});

// saldo disponible, saldo pendiente (misiones en estado en revision), saldo generado en periodo dia/mes/año
router.get("/billetera", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idUsuario = cabecera.id;
    try {
      // obtener saldo disponible
      const [rows] = await mysqlConnection.promise().execute(
        `
          SELECT 
              COALESCE(saldo_disponible, 0) as saldo_disponible, 
              COALESCE(saldo_pendiente, 0) as saldo_pendiente, 
              COALESCE(SUM(CASE WHEN YEAR(m.fecha_finalizacion) = YEAR(CURDATE()) THEN m.precio ELSE 0 END), 0) as saldo_generado_anio,
              COALESCE(SUM(CASE WHEN MONTH(m.fecha_finalizacion) = MONTH(CURDATE()) AND YEAR(m.fecha_finalizacion) = YEAR(CURDATE()) THEN m.precio ELSE 0 END), 0) as saldo_generado_mes,
              COALESCE(SUM(CASE WHEN DATE(m.fecha_finalizacion) = CURDATE() THEN m.precio ELSE 0 END), 0) as saldo_generado_dia
          FROM billetera b
          LEFT JOIN mision_ditor md ON b.usuario = md.ditor
          LEFT JOIN mision m ON md.mision = m.id
          WHERE b.usuario = ? AND m.estado_mision = 5 AND md.estado_mision_ditor = 8
      `,
        [idUsuario]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la billetera");
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error en el servidor");
    }
  } else {
    res.status(404).json("Usuario no autorizado");
  }
});

var uploadImagenPerfil = multer({ storage: storage });
var uploadFotoPerfil = uploadImagenPerfil.fields([{ name: "rostro" }]);
router.post("/perfil", verifyToken, uploadFotoPerfil, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "ditor") {
    const idUsuario = cabecera.id;
    let campos = req.body.campos ? JSON.parse(req.body.campos) : null;

    if (req.files.rostro) {
      var [rows] = await mysqlConnection
        .promise()
        .execute("SELECT foto FROM perfil_ditor WHERE ditor = ?", [idUsuario]);
      // si rows.foto es distinto de null debo eliminar las fotos subidas al bucket de s3
      if (rows.length > 0) {
        if (
          rows[0].foto !== null &&
          rows[0].foto !== "" &&
          rows[0].foto !== undefined
        ) {
          // eliminar la foto del bucket de s3
          params = {
            Bucket: bucketName,
            Delete: {
              Objects: [],
              Quiet: false,
            },
          };

          params.Delete.Objects.push({
            Key: rows[0].foto,
          });
          command = new DeleteObjectsCommand(params);
          try {
            await s3.send(command);
          } catch (error) {
            return res
              .status(500)
              .send("No se pudo eliminar la imagen anterior");
          }
        }
      } else {
        return res.status(500).send("No se encontró el ditor");
      }

      // subir las fotos al bucket de s3
      req.files.rostro[0].filename = randomImageName();
      const paramsImagen = {
        Bucket: bucketName,
        Key: req.files.rostro[0].filename,
        Body: req.files.rostro[0].buffer,
        ContentType: "image/jpeg",
      };
      const commandImagen = new PutObjectCommand(paramsImagen);
      try {
        await s3.send(commandImagen);
        console.log("se subio la foto de perfil correctamente");
        // actualizar la tabla perfil_ditor con el nombre de la foto
        var [rows] = await mysqlConnection
          .promise()
          .execute("UPDATE perfil_ditor SET foto = ? WHERE ditor = ?", [
            req.files.rostro[0].filename,
            idUsuario,
          ]);
      } catch (error) {
        return res.status(500).send("No se pudo subir la imagen");
      }
    }

    if (campos) {
      var camposQuery = "";
      var camposQueryArray = [];
      var emailQuery = "";
      var emailQueryArray = [];
      for (let i = 0; i < campos.length; i++) {
        const campo = campos[i];
        if (campo.nombre === "email") {
          emailQuery = "email = ?";
          emailQueryArray.push(campo.valor);
        } else {
          if (campo.nombre === "codigo_referido_usuario_id") {
            camposQuery += `codigo_referido_usuario_id = ?`;
            // buscar el id del usuario que tiene el codigo_referido en su tabla perfil_ditor
            var [rows] = await mysqlConnection
              .promise()
              .execute(
                "SELECT ditor FROM perfil_ditor WHERE codigo_referido = ?",
                [campo.valor]
              );
            if (rows.length > 0) {
              camposQueryArray.push(rows[0].ditor);
            } else {
              res.status(400).json("El código referido no existe");
              return;
            }
          } else {
            camposQuery += `${campo.nombre} = ?`;
            camposQueryArray.push(campo.valor);
            if (i < campos.length - 1) {
              camposQuery += ", ";
            }
          }
        }
      }

      try {
        if (emailQuery) {
          var [emailRows] = await mysqlConnection
            .promise()
            .execute(
              `UPDATE usuario SET ${emailQuery} WHERE id = ?`,
              emailQueryArray.concat(idUsuario)
            );
        }

        if (camposQuery) {
          var [rows] = await mysqlConnection
            .promise()
            .execute(
              `UPDATE perfil_ditor SET ${camposQuery} WHERE ditor = ?`,
              camposQueryArray.concat(idUsuario)
            );
        }

        if (
          (rows && rows.affectedRows > 0) ||
          (emailRows && emailRows.affectedRows > 0)
        ) {
          res.status(200).json("Perfil actualizado correctamente");
        } else {
          res.status(400).json("No se ha encontrado el perfil");
        }
      } catch (error) {
        console.log(error);
        if (error.code === "ER_DUP_ENTRY") {
          res.status(400).json("El valor ya existe");
        } else {
          res.status(500).json("Error en el servidor");
        }
      }
    } else {
      if (req.files.rostro) {
        res.status(200).json("Foto de perfil actualizada correctamente");
      } else {
        res.status(400).json("No se ha recibido ningún campo");
      }
    }
  } else {
    res.status(400).json("Usuario no autorizado");
  }
});

/*
1) Recibir un id de campania y un id de mision 
2) Verificar que la mision esté en estado 4 ("En revisión") 
3) Hacer consulta SQL que obtenga el ultimo elemento insertado en mision_ditor que corresponda a esa misión y hacer join con fotos_mision_ditor en el campo mision_ditor para obtener el campo "archivo" y hacer join con el campo pregunta_campania de fotos_mision_ditor con la tabla pregunta_campania para obtener las preguntas
4) Iterar por cada pregunta y crear un nuevo objeto que tenga la pregunta y las fotos que se hayan subido para esa pregunta en un array (obtener link de amazon S3)
*/
router.get(
  "/campania/fotos/:idCampania/:idMision",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "admin") {
      const idCampania = req.params.idCampania ? req.params.idCampania : null;
      const idMision = req.params.idMision ? req.params.idMision : null;

      try {
        // validar que la mision este en estado 4 y obtener el id del ultimo mision_ditor asociado a esa mision
        var [rows] = await mysqlConnection.promise().execute(
          "SELECT mision_ditor.id AS id_mision_ditor, \
                                                                    mision.estado_mision AS estado_mision \
                                                                     FROM mision_ditor \
                                                                      INNER JOIN mision ON mision_ditor.mision = mision.id \
                                                                      WHERE mision_ditor.mision = ? \
                                                                      AND mision.campania = ? \
                                                                      ORDER BY mision_ditor.id DESC LIMIT 1",
          [idMision, idCampania]
        );
        if (rows.length > 0 && rows[0].estado_mision == 4) {
          const idMisionDitor = rows[0].id_mision_ditor;
          // obtener el campo "archivo" y las preguntas de la tabla fotos_mision_ditor que tengan mision_ditor y pregunta_campania
          [rows] = await mysqlConnection.promise().execute(
            "SELECT fm.archivo AS archivo, \
                                                                    pc.id AS id_pregunta_campania, \
                                                                    pc.pregunta AS pregunta_campania \
                                                                    FROM fotos_mision_ditor fm \
                                                                    INNER JOIN pregunta_campania pc ON fm.pregunta_campania = pc.id \
                                                                    WHERE fm.mision_ditor = ?",
            [idMisionDitor]
          );

          const fotos = {};
          if (rows.length > 0) {
            for (let i = 0; i < rows.length; i++) {
              if (rows[i].archivo != null) {
                getObjectParams = {
                  Bucket: bucketName,
                  Key: rows[i].archivo,
                };
                command = new GetObjectCommand(getObjectParams);
                url = await getSignedUrl(s3, command, { expiresIn: 3600 });
                if (!fotos[rows[i].id_pregunta_campania]) {
                  fotos[rows[i].id_pregunta_campania] = {
                    id_pregunta: rows[i].id_pregunta_campania,
                    pregunta: rows[i].pregunta_campania,
                    archivos: [],
                  };
                }
                fotos[rows[i].id_pregunta_campania].archivos.push(url);
              }
            }
          }

          const fotosArray = Object.values(fotos);

          res.status(200).json(fotosArray);
        } else {
          if (!rows.length > 0) {
            res.status(404).json("No se encontró la misión");
          } else {
            res.status(404).json("La misión no esta en estado En revisión");
          }
        }
      } catch (error) {
        console.log(error);
        res.status(500).json("Error al obtener las fotos de la misión");
      }
    } else if (cabecera.rol === "cliente") {
      const idCampania = req.params.idCampania ? req.params.idCampania : null;
      const idMision = req.params.idMision ? req.params.idMision : null;

      try {
        // validar que la mision este en estado 4 y obtener el id del ultimo mision_ditor asociado a esa mision
        var [rows] = await mysqlConnection.promise().execute(
          "SELECT mision_ditor.id AS id_mision_ditor, \
                                                                    mision.estado_mision AS estado_mision \
                                                                     FROM mision_ditor \
                                                                      INNER JOIN mision ON mision_ditor.mision = mision.id \
                                                                      INNER JOIN campania c ON c.id = mision.campania \
                                                                      WHERE mision_ditor.mision = ? \
                                                                      AND mision.campania = ? \
                                                                      AND c.cliente = ? \
                                                                      ORDER BY mision_ditor.id DESC LIMIT 1",
          [idMision, idCampania, cabecera.client_id]
        );
        if (rows.length > 0 && rows[0].estado_mision == 4) {
          const idMisionDitor = rows[0].id_mision_ditor;
          // obtener el campo "archivo" y las preguntas de la tabla fotos_mision_ditor que tengan mision_ditor y pregunta_campania
          [rows] = await mysqlConnection.promise().execute(
            "SELECT fm.archivo AS archivo, \
                                                                    pc.id AS id_pregunta_campania, \
                                                                    pc.pregunta AS pregunta_campania \
                                                                    FROM fotos_mision_ditor fm \
                                                                    INNER JOIN pregunta_campania pc ON fm.pregunta_campania = pc.id \
                                                                    WHERE fm.mision_ditor = ?",
            [idMisionDitor]
          );

          const fotos = {};
          if (rows.length > 0) {
            for (let i = 0; i < rows.length; i++) {
              if (rows[i].archivo != null) {
                getObjectParams = {
                  Bucket: bucketName,
                  Key: rows[i].archivo,
                };
                command = new GetObjectCommand(getObjectParams);
                url = await getSignedUrl(s3, command, { expiresIn: 3600 });
                if (!fotos[rows[i].id_pregunta_campania]) {
                  fotos[rows[i].id_pregunta_campania] = {
                    id_pregunta: rows[i].id_pregunta_campania,
                    pregunta: rows[i].pregunta_campania,
                    archivos: [],
                  };
                }
                fotos[rows[i].id_pregunta_campania].archivos.push(url);
              }
            }
          }

          const fotosArray = Object.values(fotos);

          res.status(200).json(fotosArray);
        } else {
          if (!rows.length > 0) {
            res.status(404).json("No se encontró la misión");
          } else {
            res.status(404).json("La misión no esta en estado En revisión");
          }
        }
      } catch (error) {
        console.log(error);
        res.status(500).json("Error al obtener las fotos de la misión");
      }
    } else {
      res
        .status(403)
        .json("No tienes permisos para acceder a esta información");
    }
  }
);

router.get("/genero", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const [rows] = await mysqlConnection
        .promise()
        .execute("SELECT * FROM genero");
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res.status(404).json("No se han encontrado generos");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los generos");
  }
});

router.get("/estado-civil", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const [rows] = await mysqlConnection
        .promise()
        .execute("SELECT * FROM estado_civil");
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res.status(404).json("No se han encontrado estados civiles");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los estados civiles");
  }
});

router.get("/listado-campanias-activas", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT
          id,
          nombre
        FROM campania       
        WHERE cliente = ? and estado_campania = 2
        `,
        [cabecera.client_id]
      );
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res
          .status(404)
          .json("No se han encontrado campanias activas para el cliente");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json("Error al obtener las campanias activas para el cliente");
  }
});

router.get("/nivel-educativo", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const [rows] = await mysqlConnection
        .promise()
        .execute("SELECT * FROM nivel_educativo");
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res.status(404).json("No se han encontrado niveles educativos");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los niveles educativos");
  }
});

router.get("/pais", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const [rows] = await mysqlConnection
        .promise()
        .execute("SELECT * FROM pais");
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res.status(404).json("No se han encontrado paises");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener los paises");
  }
});

router.get("/provincia/:idPais", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idPais = req.params.idPais ? req.params.idPais : null;
      const [rows] = await mysqlConnection
        .promise()
        .execute("SELECT * FROM provincia WHERE pais = ?", [idPais]);
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res.status(404).json("No se han encontrado provincias");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las provincias");
  }
});

router.get("/localidad/:idProvincia", verifyToken, async (req, res) => {
  try {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "ditor") {
      const idProvincia = req.params.idProvincia
        ? req.params.idProvincia
        : null;
      const [rows] = await mysqlConnection
        .promise()
        .execute("SELECT * FROM localidad WHERE provincia = ?", [idProvincia]);
      if (rows.length > 0) {
        res.status(200).json({ items: rows });
      } else {
        res.status(404).json("No se han encontrado localidades");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json("Error al obtener las localidades");
  }
});

router.get("/misiones-revision", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
      SELECT COUNT(m.estado_mision) AS value, DATE_FORMAT(m.fecha_modificacion, '%d/%m') as name
      FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
      WHERE em.nombre ='Disponible' AND m.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 1 MONTH)
      GROUP BY DAY(m.fecha_modificacion) , MONTH(m.fecha_modificacion)
    `);

      if (rows.length > 0) {
        console.log(rows);
        res.status(200).json(rows);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/misiones-revision-total", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
        SELECT COUNT(m.estado_mision) AS total
        FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
        WHERE em.nombre ='En revisión' AND m.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 1 MONTH)
      `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT COUNT(m.estado_mision) AS total
        FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
        INNER JOIN campania c ON c.id = m.campania
        WHERE em.nombre ='En revisión' AND m.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 1 MONTH) and c.cliente = ?
      
        `,
        [cabecera.client_id]
      );
      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/misiones-total", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
          SELECT COUNT(m.estado_mision) AS total
          FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
          WHERE  m.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 1 MONTH)
        `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/cantidad/znappers-online", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  try {
    if (cabecera.rol === "admin") {
      // contar los ditors cuya fecha_modificacion haya sido como maximo 3 minutos antes de la fecha actual
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(usuario) AS total
            FROM posicion_actual_ditor
            WHERE fecha_modificacion >= DATE_SUB((SELECT NOW()), INTERVAL 3 MINUTE)
          `);

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se ha encontrado posicion actual");
      }
    } else {
      if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
        const [rows] = await mysqlConnection.promise().execute(
          `
              SELECT COUNT(pad.usuario) AS total
              FROM posicion_actual_ditor pad
              INNER JOIN usuario u ON pad.usuario = u.id
              WHERE u.cliente = ? AND pad.fecha_modificacion >= DATE_SUB((SELECT NOW()), INTERVAL 3 MINUTE)
            `,
          [cabecera.client_id]
        );

        if (rows.length > 0) {
          res.status(200).json(rows[0].total);
        } else {
          res.status(404).json("No se ha encontrado posicion actual");
        }
      } else {
        res.status(401).send("Unauthorized");
      }
    }
  } catch (error) {
    console.log(error);
    res.status(500).send("An error occurred while trying to get misiones");
  }
});

router.post("/znappers/tabla/download-csv", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const filters = req.body;

      let fecha_desde = filters.fecha_desde || "1970-01-01";
      let fecha_hasta = filters.fecha_hasta || "2100-01-01";

      // Convertir a formato ISO y obtener solo la fecha
      if (filters.fecha_desde) {
        fecha_desde = new Date(filters.fecha_desde).toISOString().slice(0, 10);
      }
      if (filters.fecha_hasta) {
        fecha_hasta = new Date(filters.fecha_hasta).toISOString().slice(0, 10);
      }

      var query_fecha_desde = "";
      if (filters.fecha_desde) {
        query_fecha_desde = "AND u.fecha_creacion >= '" + fecha_desde + "'";
      }
      var query_fecha_hasta = "";
      if (filters.fecha_hasta) {
        query_fecha_hasta =
          "AND u.fecha_creacion < DATE_ADD('" +
          fecha_hasta +
          "', INTERVAL 1 DAY)";
      }

      const [rows] = await mysqlConnection.promise().query(
        `SELECT u.id,
                u.nombre,
                u.apellido,
                u.email,
                u.habilitado,
                u.validado,
                d.nivel,
                d.puntos,
                d.misiones_finalizadas,
                d.entrenamientos_pendientes,
                pd.dni,
                pd.cuit_cuil,
                g.nombre as genero,
                pd.celular,
                p.nombre as pais,
                pr.nombre as provincia,
                l.nombre as localidad,
                pd.calle,
                pd.altura,
                pd.piso,
                pd.departamento,
                pd.codigo_postal,
                pd.ocupacion,
                ec.nombre as estado_civil,
                ne.nombre as nivel_educativo,
                pd.hijos,
                pd.mascotas,
                DATE_FORMAT(pd.fecha_nacimiento, '%d/%m/%Y') AS fecha_creacion,
                pd.codigo_referido_usuario_id,
                pd.codigo_referido,
                DATE_FORMAT(u.fecha_creacion, '%d/%m/%Y') AS fecha_creacion,
                DATE_FORMAT(u.fecha_creacion, '%T') AS hora_creacion,
                DATE_FORMAT(u.fecha_modificacion, '%m/%d/%Y') AS fecha_modificacion,
                DATE_FORMAT(u.fecha_modificacion, '%T') AS hora_modificacion
        FROM usuario as u
        INNER JOIN ditor as d ON u.id = d.usuario
        INNER JOIN perfil_ditor as pd ON d.usuario = pd.ditor
        LEFT JOIN genero as g ON pd.genero = g.id
        LEFT JOIN pais as p ON pd.pais = p.id
        LEFT JOIN provincia as pr ON pd.provincia = pr.id
        LEFT JOIN localidad as l ON pd.localidad = l.id
        LEFT JOIN estado_civil as ec ON pd.estado_civil = ec.id
        LEFT JOIN nivel_educativo as ne ON pd.nivel_educativo = ne.id
        WHERE u.rol = 3 
        ${query_fecha_desde}
        ${query_fecha_hasta}
        ORDER BY u.id`,
        []
      );

      var headers_array = [
        { id: "id", title: "ID" },
        { id: "nombre", title: "Nombre" },
        { id: "apellido", title: "Apellido" },
        { id: "email", title: "Email" },
        { id: "habilitado", title: "Habilitado" },
        { id: "validado", title: "Validado" },
        { id: "nivel", title: "Nivel" },
        { id: "puntos", title: "Puntos" },
        { id: "misiones_finalizadas", title: "Misiones finalizadas" },
        { id: "entrenamientos_pendientes", title: "Entrenamientos pendientes" },
        { id: "dni", title: "DNI" },
        { id: "cuit_cuil", title: "Cuit/Cuil" },
        { id: "genero", title: "Genero" },
        { id: "celular", title: "Celular" },
        { id: "pais", title: "Pais" },
        { id: "provincia", title: "Provincia" },
        { id: "localidad", title: "Localidad" },
        { id: "calle", title: "Calle" },
        { id: "altura", title: "Altura" },
        { id: "piso", title: "Piso" },
        { id: "departamento", title: "Departamento" },
        { id: "codigo_postal", title: "Codigo postal" },
        { id: "ocupacion", title: "Ocupacion" },
        { id: "estado_civil", title: "Estado civil" },
        { id: "nivel_educativo", title: "Nivel educativo" },
        { id: "hijos", title: "Hijos" },
        { id: "mascotas", title: "Mascotas" },
        { id: "fecha_creacion", title: "Fecha de creacion" },
        {
          id: "codigo_referido_usuario_id",
          title: "Codigo referido usuario id",
        },
        { id: "codigo_referido", title: "Codigo referido" },
        { id: "fecha_creacion", title: "Fecha de creacion" },
        { id: "hora_creacion", title: "Hora de creacion" },
        { id: "fecha_modificacion", title: "Fecha de modificacion" },
        { id: "hora_modificacion", title: "Hora de modificacion" },
      ];

      const csvStringifier = createCsvStringifier({
        header: headers_array,
        fieldDelimiter: ";",
      });

      let csvData = csvStringifier.getHeaderString();
      csvData += csvStringifier.stringifyRecords(rows);

      res.setHeader(
        "Content-disposition",
        "attachment; filename=ethnicities-table.csv"
      );
      res.setHeader("Content-type", "text/csv; charset=utf-8");
      res.send(csvData);
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  } else {
    res.status(401).json("Unauthorized");
  }
});

router.post("/znappers/grafico/activos", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const filters = req.body;

      let fecha_desde = filters.fecha_desde || "1970-01-01";
      let fecha_hasta = filters.fecha_hasta || "2100-01-01";

      // Convertir a formato ISO y obtener solo la fecha
      if (filters.fecha_desde) {
        fecha_desde = new Date(filters.fecha_desde).toISOString().slice(0, 10);
      }
      if (filters.fecha_hasta) {
        fecha_hasta = new Date(filters.fecha_hasta).toISOString().slice(0, 10);
      }

      var query_fecha_desde = "";
      if (filters.fecha_desde) {
        query_fecha_desde = "AND u.fecha_creacion >= '" + fecha_desde + "'";
      }
      var query_fecha_hasta = "";
      if (filters.fecha_hasta) {
        query_fecha_hasta =
          "AND u.fecha_creacion < DATE_ADD('" +
          fecha_hasta +
          "', INTERVAL 1 DAY)";
      }

      const [rows] = await mysqlConnection.promise().query(
        `SELECT 
          'Activos' AS name,
          COUNT(DISTINCT usuario.id) AS total
        FROM 
          usuario
        LEFT JOIN 
          mision_ditor ON usuario.id = mision_ditor.ditor
        WHERE 
          usuario.rol = 3 AND usuario.cliente = ?
          AND (
            (mision_ditor.fecha_reserva >= ${query_fecha_desde
          ? `'${fecha_desde}'`
          : "DATE_SUB(CURDATE(), INTERVAL 7 DAY)"
        } AND mision_ditor.fecha_reserva < ${query_fecha_hasta
          ? `DATE_ADD('${fecha_hasta}', INTERVAL 1 DAY)`
          : "CURDATE()"
        })
            OR (mision_ditor.fecha_reserva IS NULL AND ${!query_fecha_desde && !query_fecha_hasta
        })
          )
        UNION ALL
        SELECT 
          'Inactivos' AS name,
          (SELECT COUNT(*) FROM usuario WHERE rol = 3) - COUNT(DISTINCT usuario.id) AS total
        FROM 
          usuario
        LEFT JOIN 
          mision_ditor ON usuario.id = mision_ditor.ditor
        WHERE 
          usuario.rol = 3 AND usuario.cliente = ?
          AND (
            (mision_ditor.fecha_reserva < ${query_fecha_desde
          ? `'${fecha_desde}'`
          : "DATE_SUB(CURDATE(), INTERVAL 7 DAY)"
        } OR mision_ditor.fecha_reserva >= ${query_fecha_hasta
          ? `DATE_ADD('${fecha_hasta}', INTERVAL 1 DAY)`
          : "CURDATE()"
        })
            OR (mision_ditor.fecha_reserva IS NULL AND ${!query_fecha_desde && !query_fecha_hasta
        })
          )`,
        [cabecera.client_id, cabecera.client_id]
      );
      res.json(rows);
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  }
});

router.post("/znappers/grafico/misiones", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const filters = req.body;

      let fecha_desde = filters.fecha_desde || "1970-01-01";
      let fecha_hasta = filters.fecha_hasta || "2100-01-01";

      // Convertir a formato ISO y obtener solo la fecha
      if (filters.fecha_desde) {
        fecha_desde = new Date(filters.fecha_desde).toISOString().slice(0, 10);
      }
      if (filters.fecha_hasta) {
        fecha_hasta = new Date(filters.fecha_hasta).toISOString().slice(0, 10);
      }

      var query_fecha_desde = "";
      if (filters.fecha_desde) {
        query_fecha_desde = "AND m.fecha_creacion >= '" + fecha_desde + "'";
      }
      var query_fecha_hasta = "";
      if (filters.fecha_hasta) {
        query_fecha_hasta =
          "AND m.fecha_creacion < DATE_ADD('" +
          fecha_hasta +
          "', INTERVAL 1 DAY)";
      }

      const [rows] = await mysqlConnection.promise().query(
        `SELECT 
          'Completadas' AS name,
          COUNT(DISTINCT m.id) AS total
        FROM 
          campania as c
        INNER JOIN 
          mision as m ON c.id = m.campania
        WHERE 
          m.estado_mision = 5 AND c.cliente = ? 
          ${query_fecha_desde}
          ${query_fecha_hasta}
        UNION ALL
        SELECT 
          'Sin completar' AS name,
          COUNT(DISTINCT m.id) AS total
        FROM 
          campania as c
        INNER JOIN 
          mision as m ON c.id = m.campania
        WHERE 
          m.estado_mision <> 5 AND c.cliente = ? 
          ${query_fecha_desde}
          ${query_fecha_hasta}
          `,
        [cabecera.client_id, cabecera.client_id]
      );
      res.json(rows);
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  }
});

router.get("/cantidad/misiones-disponibles", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  try {
    if (cabecera.rol === "admin") {
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(m.id) AS total
            FROM mision as m
            INNER JOIN campania as c ON m.campania = c.id
            WHERE m.estado_mision = 1 and c.estado_campania = 2
          `);

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se ha encontrado misión");
      }
    } else {
      if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
        const [rows] = await mysqlConnection.promise().execute(
          `
              SELECT COUNT(m.id) AS total FROM mision m
              INNER JOIN campania c ON m.campania = c.id
              WHERE m.estado_mision = 1 and c.estado_campania = 2 and c.cliente = ?
            `,
          [cabecera.client_id]
        );

        if (rows.length > 0) {
          res.status(200).json(rows[0].total);
        } else {
          res.status(404).json("No se ha encontrado misión");
        }
      } else {
        res.status(401).send("Unauthorized");
      }
    }
  } catch (error) {
    console.log(error);
    res.status(500).send("An error occurred while trying to get misiones");
  }
});

router.get("/misiones-disponibles", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(m.estado_mision) AS value, DATE_FORMAT(m.fecha_modificacion, '%d/%m') as name
            FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
            WHERE em.nombre ='Disponible' AND m.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 1 MONTH)
            GROUP BY DAY(m.fecha_modificacion) , MONTH(m.fecha_modificacion)
          `);

      if (rows.length > 0) {
        res.status(200).json(rows);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/misiones-disponibles-total", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
              SELECT COUNT(m.estado_mision) AS total
              FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
              WHERE em.nombre ='Disponible' AND  m.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 1 MONTH)
            `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
              SELECT count(*) as total FROM mision m
              INNER JOIN campania c ON (m.campania = c.id)
              WHERE m.estado_mision = 1 and c.estado_campania = 2 and c.cliente = ?
      
              `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-clientes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
          SELECT COUNT(c.id) AS total
	        FROM cliente as c
          WHERE c.estado_cliente <> 2
        `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado clientes");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-clientes-mes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(c.id) AS value, DATE_FORMAT(c.fecha_modificacion, '%d/%m') as name
            FROM cliente as c INNER JOIN estado_cliente as ec ON c.estado_cliente = ec.id
            WHERE ec.id <> 2 AND c.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 4 MONTH)
            GROUP BY DAY(c.fecha_modificacion) , MONTH(c.fecha_modificacion)
          `);

      if (rows.length > 0) {
        res.status(200).json(rows);
      } else {
        respuesta = [{ value: 0, name: "" }];
        res.status(200).json(respuesta);
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-comercios-mes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(c.id) AS value, DATE_FORMAT(cli.fecha_modificacion, '%d/%m') as name
            FROM comercio as c INNER JOIN cliente as cli ON c.cliente = cli.id
            WHERE cli.id <> 2 AND cli.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 4 MONTH)
            GROUP BY DAY(cli.fecha_modificacion) , MONTH(cli.fecha_modificacion)
          `);

      if (rows.length > 0) {
        console.log(rows);
        res.status(200).json(rows);
      } else {
        respuesta = [{ value: 0, name: "" }];
        res.status(200).json(respuesta);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get comercios");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-comercios", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(c.id) AS total
            FROM comercio as c
            WHERE c.habilitado = 'Y'
          `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado comercios");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-articulos", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
              SELECT COUNT(a.id) AS total
              FROM articulo as a
              WHERE a.estado_articulo <> 3
            `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado articulos");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-reclamos", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
                SELECT COUNT(r.id) AS total
                FROM articulo as a
                WHERE a.estado_articulo <> 3
              `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado reclamos");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/clientes-activos", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
                  SELECT COUNT(c.id) AS total
                  FROM cliente as c
                  WHERE c.estado_cliente = 1
                `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado clientes activos");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/ditors-activos", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
                    SELECT COUNT(d.usuario) AS total
                    FROM ditor as d
                    WHERE d.estado_ditor = 3
                  `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/total-ditors-mes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(d.id) AS value, DATE_FORMAT(d.fecha_ultima_conexion, '%d/%m') as name
            FROM ditor as c INNER JOIN estado_cliente as ec ON c.estado_cliente = ec.id
            WHERE ec.id <> 2 AND c.fecha_modificacion >= DATE_SUB((SELECT CURDATE()), INTERVAL 4 MONTH)
            GROUP BY DAY(c.fecha_modificacion) , MONTH(c.fecha_modificacion)
          `);

      if (rows.length > 0) {
        res.status(200).json(rows);
      } else {
        res.status(404).json("No se ha encontrado la misión");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/campanias-preparacion", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
                    SELECT COUNT(c.id) AS total
                    FROM campania as c
                    WHERE c.estado_campania = 1
                  `);

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/cantidad/campanias-activas", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
                      SELECT COUNT(c.id) AS total
                      FROM campania as c
                      WHERE c.estado_campania = 2
                    `);

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
                      SELECT COUNT(c.id) AS total
                      FROM campania as c
                      WHERE c.estado_campania = 2 and c.cliente = ?
                    `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.post("/campanias/cantidad/comercios", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.body.idCampania;
  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
                      SELECT COUNT(DISTINCT(co.id)) AS total
                      FROM campania as c
                      INNER JOIN mision as m ON m.campania = c.id
                      INNER JOIN comercio as co ON co.id = m.comercio
                      WHERE c.id = ? AND m.estado_mision <> 7
                    `,
        [idCampania]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.post(
  "/campanias/cantidad/misiones-realizadas/:idCampania",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
      const filters = req.body;
      let idCampania = req.params.idCampania;
      let fecha_desde = filters.fecha_desde || "1970-01-01";
      let fecha_hasta = filters.fecha_hasta || "2100-01-01";
      let tipo_fecha = filters.tipo_fecha || "creacion";

      // Convertir a formato ISO y obtener solo la fecha
      if (filters.fecha_desde) {
        fecha_desde = new Date(filters.fecha_desde).toISOString().slice(0, 10);
      }
      if (filters.fecha_hasta) {
        fecha_hasta = new Date(filters.fecha_hasta).toISOString().slice(0, 10);
      }

      var query_fecha_desde = "";
      if (filters.fecha_desde) {
        query_fecha_desde =
          `AND m.fecha_${tipo_fecha} >= \'` + fecha_desde + `\'`;
      }
      var query_fecha_hasta = "";
      if (filters.fecha_hasta) {
        query_fecha_hasta =
          `AND m.fecha_${tipo_fecha} < DATE_ADD(\'` +
          fecha_hasta +
          `\', INTERVAL 1 DAY)`;
      }

      try {
        let query = `
          SELECT 
            COUNT(DISTINCT(m.id)) AS total,
            SUM(CASE 
                  WHEN m.estado_mision IN (4,5) 
                  AND m.fecha_${tipo_fecha} >= ? 
                  AND m.fecha_${tipo_fecha} < DATE_ADD(?, INTERVAL 1 DAY) 
                  THEN 1 
                  ELSE 0 
                END) AS realizadas
          FROM 
            campania as c
            INNER JOIN mision as m ON m.campania = c.id
            INNER JOIN comercio as co ON co.id = m.comercio
          WHERE 
            c.id = ? AND m.estado_mision <> 7
            ${query_fecha_desde}
            ${query_fecha_hasta}
        `;

        const [rows] = await mysqlConnection
          .promise()
          .execute(query, [fecha_desde, fecha_hasta, idCampania]);

        if (rows.length > 0) {
          if (rows[0].realizadas === null) {
            rows[0].realizadas = 0;
          }
          res.status(200).json(rows[0]);
        } else {
          res.status(404).json("No se han encontrado campañas activas");
        }
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .send("An error occurred while trying to get misiones en revision");
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  }
);
router.post(
  "/campanias/cantidad/znappers-involucrados",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    const idCampania = req.body.idCampania;
    if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
      try {
        const [involucrados] = await mysqlConnection.promise().execute(
          `
                     SELECT 
                        count(distinct(m.asignada_a_id)) AS total
                        FROM campania as c
                        INNER JOIN mision as m ON m.campania = c.id
                        WHERE c.id = ? AND m.estado_mision <> 7
       `,
          [idCampania]
        );

        const [total] = await mysqlConnection.promise().execute(
          `
          SELECT COUNT(u.id) as total
          FROM usuario as u 
          WHERE u.rol = 3 AND u.habilitado = 'Y' AND u.cliente = ?
          `,
          [cabecera.client_id]
        );

        if (involucrados.length > 0 && total.length > 0) {
          res.status(200).json({
            total: total[0].total,
            involucrados: involucrados[0].total,
          });
        } else {
          res.status(404).json("No se han encontrado campañas activas");
        }
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .send("An error occurred while trying to get misiones en revision");
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  }
);

router.get("/table/listado-clientes", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  let queryBuscar = "";

  var page = req.query.page ? Number(req.query.page) : 1;
  if (page < 1) {
    page = 1;
  }
  var resultsPerPage = 10;
  var start = (page - 1) * resultsPerPage;

  var orderBy = req.query.orderBy ? req.query.orderBy : "idCliente";
  var orderType = ["asc", "desc"].includes(req.query.orderType)
    ? req.query.orderType
    : "desc";
  var queryOrderBy = `${orderBy} ${orderType}`;

  if (buscar) {
    buscar = "%" + buscar + "%";
    if (cabecera.role === "client") {
      queryBuscar = `and (cliente.id like '${buscar}' or CONCAT('#',cliente.id) like '${buscar}' or cliente.nombre like '${buscar}' or estado_cliente.nombre like '${buscar}')`;
    }
  }
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT
        CONCAT('#',campania.cliente) as idCliente,
        cliente.nombre as nombreCliente,
        COUNT(mision.campania) as totalMisiones,
        ec.nombre as estadoCliente,
        COUNT(campania.id) as campaniasActivas
        FROM campania
        INNER JOIN estado_campania ON estado_campania.id = 2
        INNER JOIN mision ON campania.id = mision.campania
        INNER JOIN cliente ON cliente.id = campania.cliente
        INNER JOIN estado_cliente as ec ON cliente.estado_cliente = ec.id            
        WHERE cliente.id = ? ${queryBuscar}
        ORDER BY ${queryOrderBy}
        LIMIT ?, ?
        `,
        [cabecera.id, start, resultsPerPage]
      );

      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
            SELECT COUNT(*) as count
            FROM campania
            INNER JOIN mision ON campania.id = mision.campania
            INNER JOIN cliente ON cliente.id = campania.cliente
            INNER JOIN estado_cliente as ec ON cliente.estado_cliente = ec.id
                        
            WHERE cliente.id = ? ${queryBuscar}
          `,
          [cabecera.id]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);

        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/table/campanias-activas/", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  let queryBuscar = "";

  var page = req.query.page ? Number(req.query.page) : 1;
  if (page < 1) {
    page = 1;
  }
  var resultsPerPage = 10;
  var start = (page - 1) * resultsPerPage;

  var orderBy = req.query.orderBy ? req.query.orderBy : "idCampania";
  var orderType = ["asc", "desc"].includes(req.query.orderType)
    ? req.query.orderType
    : "desc";
  var queryOrderBy = `${orderBy} ${orderType}`;

  // if (buscar) {
  //   buscar = '%' + buscar + '%';
  //   if (cabecera.role === 'client') {
  //     queryBuscar = `and (activity.id like '${buscar}' or CONCAT('#D',activity.id) like '${buscar}' or transaction.id like '${buscar}' or CONCAT('#TX',transaction.id) like '${buscar}' or DATE_FORMAT(transaction.date, '%d/%m/%Y') like '${buscar}' or DATE_FORMAT(transaction.date, '%T') like '${buscar}' or transaction.usd_amount like '${buscar}' or country_origin.name like '${buscar}' or country_destiny.name like '${buscar}' or entity_payer.document_number like '${buscar}' or entity_beneficiary.document_number like '${buscar}' or payment_method.name like '${buscar}' or status.name like '${buscar}')`;
  //   }
  // }
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT
        CONCAT('#',campania.id) as idCampania,
        cliente.nombre as nombreCliente,
        campania.fecha_inicio as fechaInicio,
        campania.fecha_fin as fechaFin,
        estado_campania.nombre as estado,
        (campania.presupuesto) as presupuestoTotal,
        campania.nombre as nombre_campania
        FROM campania
        INNER JOIN estado_campania ON estado_campania.id = campania.estado_campania
        INNER JOIN cliente ON cliente.id = campania.cliente
        INNER JOIN estado_cliente as ec ON cliente.estado_cliente = ec.id
        WHERE campania.estado_campania = 2 AND cliente.id = ?
        group by idCampania
        LIMIT ?, ?
            `,
        [cabecera.id, start, resultsPerPage]
      );

      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
          SELECT COUNT(*) as count
          FROM campania
          INNER JOIN cliente ON cliente.id = campania.cliente
          WHERE campania.estado_campania = 2 AND cliente.id = ?
          `,
          [cabecera.id]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
        console.log(rows);
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT
        CONCAT('#',campania.id) as idCampania,
        cliente.nombre as nombreCliente,
        campania.fecha_inicio as fechaInicio,
        campania.fecha_fin as fechaFin,
        estado_campania.nombre as estado,
        (campania.presupuesto) as presupuestoTotal,
        campania.nombre as nombre_campania
        FROM campania
        INNER JOIN estado_campania ON estado_campania.id = campania.estado_campania
        INNER JOIN cliente ON cliente.id = campania.cliente
        INNER JOIN estado_cliente as ec ON cliente.estado_cliente = ec.id
        WHERE campania.estado_campania = 2 AND cliente.id = ?
        group by idCampania
        LIMIT ?, ?
            `,
        [cabecera.client_id, start, resultsPerPage]
      );

      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
          SELECT COUNT(*) as count
          FROM campania
          INNER JOIN cliente ON cliente.id = campania.cliente
          WHERE campania.estado_campania = 2 AND cliente.id = ?
          `,
          [cabecera.client_id]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
        console.log(rows);
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/campanias-activas-torta", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rowTotal] = await mysqlConnection.promise().execute(`
            SELECT COUNT(c.id) AS total
            FROM campania as c
            WHERE c.estado_campania = 2
          `);

      const [rows] = await mysqlConnection.promise().execute(`
          SELECT COUNT(campania.id) as camp, cliente.nombre as nombreCliente, cliente.id as idCliente
          FROM campania INNER JOIN cliente ON cliente.id = campania.cliente 
          GROUP BY idCliente ORDER BY camp desc LIMIT 3;

       
        `);

      if (rows.length > 0) {
        res.status(200).json({ rows, rowTotal });
        console.log(res);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/campanias-preparacion-torta", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin") {
    try {
      const [rowTotal] = await mysqlConnection.promise().execute(`
              SELECT COUNT(c.id) AS total
              FROM campania as c
              WHERE c.estado_campania = 1
            `);

      const [rows] = await mysqlConnection.promise().execute(`
            SELECT COUNT(campania.id) as camp, cliente.nombre as nombreCliente, cliente.id as idCliente
            FROM campania INNER JOIN cliente ON cliente.id = campania.cliente 
            WHERE campania.estado_campania = 1
            GROUP BY idCliente ORDER BY camp  desc LIMIT 3;
  
         
          `);

      if (rows.length > 0) {
        res.status(200).json({ rows, rowTotal });
        console.log(res);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.post(
  "/campanias/grafico/misiones/:idCampania",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
      try {
        const filters = req.body;
        let idCampania = req.params.idCampania;
        let fecha_desde = filters.fecha_desde || "1970-01-01";
        let fecha_hasta = filters.fecha_hasta || "2100-01-01";
        let tipo_fecha = filters.tipo_fecha || "creacion";

        // Convertir a formato ISO y obtener solo la fecha
        if (filters.fecha_desde) {
          fecha_desde = new Date(filters.fecha_desde)
            .toISOString()
            .slice(0, 10);
        }
        if (filters.fecha_hasta) {
          fecha_hasta = new Date(filters.fecha_hasta)
            .toISOString()
            .slice(0, 10);
        }

        var query_fecha_desde = "";
        if (filters.fecha_desde) {
          query_fecha_desde =
            `AND m.fecha_${tipo_fecha} >= \'` + fecha_desde + `\'`;
        }
        var query_fecha_hasta = "";
        if (filters.fecha_hasta) {
          query_fecha_hasta =
            `AND m.fecha_${tipo_fecha} < DATE_ADD(\'` +
            fecha_hasta +
            `\', INTERVAL 1 DAY)`;
        }

        const [rows] = await mysqlConnection.promise().query(
          `SELECT 
            CASE 
              WHEN m.estado_mision IN (4,5) THEN 'Realizadas'
              WHEN m.estado_mision = 6 THEN 'Vencidas'
              ELSE 'Pendientes'
            END AS name,
            COUNT(DISTINCT m.id) AS total
          FROM 
            campania as c
          INNER JOIN 
            mision as m ON c.id = m.campania
          WHERE 
            c.cliente = ? AND c.id = ? AND m.estado_mision <> 7
            ${query_fecha_desde}
            ${query_fecha_hasta}
          GROUP BY 
            CASE 
              WHEN m.estado_mision IN (4,5) THEN 'Realizadas'
              WHEN m.estado_mision = 6 THEN 'Vencidas'
              ELSE 'Pendientes'
            END`,
          [cabecera.client_id, idCampania]
        );

        // Inicializar los estados con 0
        let estados = {
          Pendientes: 0,
          Realizadas: 0,
          Vencidas: 0
        };

        // Actualizar los estados con los valores obtenidos
        rows.forEach(row => {
          estados[row.name] = row.total;
        });

        // Convertir el objeto en un array
        let result = Object.keys(estados).map(key => ({
          name: key,
          total: estados[key]
        }));

        res.json(result);
      } catch (err) {
        console.log(err);
        res.status(500).json("Internal server error");
      }
    }
  }
);
router.post(
  "/campanias/grafico/comercios/:idCampania",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
      try {
        const filters = req.body;
        let idCampania = req.params.idCampania;
        let fecha_desde = filters.fecha_desde || "1970-01-01";
        let fecha_hasta = filters.fecha_hasta || "2100-01-01";
        let tipo_fecha = filters.tipo_fecha || "creacion";

        // Convertir a formato ISO y obtener solo la fecha
        if (filters.fecha_desde) {
          fecha_desde = new Date(filters.fecha_desde)
            .toISOString()
            .slice(0, 10);
        }
        if (filters.fecha_hasta) {
          fecha_hasta = new Date(filters.fecha_hasta)
            .toISOString()
            .slice(0, 10);
        }

        var query_fecha_desde = "";
        if (filters.fecha_desde) {
          query_fecha_desde =
            `AND m.fecha_${tipo_fecha} >= \'` + fecha_desde + `\'`;
        }
        var query_fecha_hasta = "";
        if (filters.fecha_hasta) {
          query_fecha_hasta =
            `AND m.fecha_${tipo_fecha} < DATE_ADD(\'` +
            fecha_hasta +
            `\', INTERVAL 1 DAY)`;
        }

        const [rows] = await mysqlConnection.promise().query(
          `     SELECT 
            'No relevados' AS name,
            COUNT(DISTINCT co.id) AS total
          FROM campania AS c
          INNER JOIN mision AS m ON m.campania = c.id
          INNER JOIN comercio AS co ON m.comercio = co.id
          WHERE c.id = ? AND c.cliente = ? AND m.estado_mision NOT IN (4,5,7)
            AND co.id NOT IN (
              SELECT DISTINCT co.id
              FROM campania AS c 
              INNER JOIN mision AS m ON m.campania = c.id
              INNER JOIN comercio AS co ON m.comercio = co.id
              WHERE c.id = ? AND c.cliente = ? AND m.estado_mision IN (4,5)
              ${query_fecha_desde}
              ${query_fecha_hasta}
            )
              ${query_fecha_desde}
              ${query_fecha_hasta}
        UNION
          SELECT 
            'Relevados' AS name,
            COUNT(DISTINCT co.id) AS total
          FROM campania AS c 
          INNER JOIN mision AS m ON m.campania = c.id
          INNER JOIN comercio AS co ON m.comercio = co.id
          WHERE c.id = ? AND c.cliente = ? AND m.estado_mision IN (4,5) AND m.estado_mision <> 7
          ${query_fecha_desde}
          ${query_fecha_hasta}`,
          [
            idCampania,
            cabecera.client_id,
            idCampania,
            cabecera.client_id,
            idCampania,
            cabecera.client_id,
          ]
        );
        res.json(rows);
      } catch (err) {
        console.log(err);
        res.status(500).json("Internal server error");
      }
    }
  }
);

//RESULTADOS

router.get("/resultados-cuestionario", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    let from_date =
      req.query.from_date && req.query.from_date !== "null"
        ? req.query.from_date
        : "1970-01-01";
    let to_date =
      req.query.to_date && req.query.to_date !== "null"
        ? req.query.to_date
        : "2100-01-01";
    const tipo_fecha =
      req.query.tipo_fecha && req.query.tipo_fecha !== "null"
        ? req.query.tipo_fecha
        : "creacion";
    const idCampania = req.query.id_campania;

    // Convertir a formato ISO y obtener solo la fecha
    if (from_date !== "null" && from_date !== "1970-01-01") {
      from_date = new Date(from_date).toISOString().slice(0, 10);
    }
    if (to_date !== "null" && to_date !== "2100-01-01") {
      to_date = new Date(to_date).toISOString().slice(0, 10);
    }

    try {
      // objetivo a devolver json: {id_pregunta: number,  pregunta: string, id_tipo_respuesta: number,  respuestas: {name: string, total: number}[]},

      const [rowsResult] = await mysqlConnection.promise().execute(
        `
        -- For multiple choice questions (tipo_respuesta 4 and 5)
        SELECT 
            pc.id as id_pregunta,
            pc.pregunta as pregunta,
            pc.tipo_respuesta as id_tipo_respuesta,
            pcr.respuesta as name,
            COUNT(mdm.id) as total
        FROM 
            pregunta_campania pc
            JOIN mision_ditor_respuesta_simple mdrs ON mdrs.pregunta_campania = pc.id
            JOIN mision_ditor md ON md.id = mdrs.mision_ditor
            JOIN mision m ON m.id = md.mision
            LEFT JOIN pregunta_campania_respuesta pcr ON pcr.pregunta_campania = pc.id
            LEFT JOIN mision_ditor_respuesta_multiple mdm ON mdm.mision_ditor_respuesta_simple = mdrs.id AND mdm.pregunta_campania_respuesta = pcr.id
        WHERE
            m.campania = ? AND m.estado_mision <> 7 AND pc.tipo_respuesta IN (4,5) AND m.fecha_${tipo_fecha} BETWEEN ? AND ?
        GROUP BY 
            pc.id, pcr.id
            
        UNION ALL

        -- For yes/no questions (tipo_respuesta 1)
        SELECT
            pc.id as id_pregunta,
            pc.pregunta as pregunta,
            pc.tipo_respuesta as id_tipo_respuesta,
            IF(mds.respuesta_si_no = 'Y', 'Si', 'No') as name,
            COUNT(*) as total
        FROM
            pregunta_campania pc
            JOIN mision_ditor_respuesta_simple mds ON mds.pregunta_campania = pc.id
            JOIN mision_ditor md ON md.id = mds.mision_ditor
            JOIN mision m ON m.id = md.mision
        WHERE
            m.campania = ? AND m.estado_mision <> 7 AND pc.tipo_respuesta = 1 AND mds.respuesta_si_no IS NOT NULL AND m.fecha_${tipo_fecha} BETWEEN ? AND ?
        GROUP BY
            pc.id, mds.respuesta_si_no

        UNION ALL

        -- For rating questions (tipo_respuesta 7)
        SELECT
            pc.id as id_pregunta,
            pc.pregunta as pregunta,
            pc.tipo_respuesta as id_tipo_respuesta,
            NULL as name,
            AVG(mds.respuesta_numero) as total
        FROM
            pregunta_campania pc
            JOIN mision_ditor_respuesta_simple mds ON mds.pregunta_campania = pc.id
            JOIN mision_ditor md ON md.id = mds.mision_ditor
            JOIN mision m ON m.id = md.mision
        WHERE
            m.campania = ? AND m.estado_mision <> 7 AND pc.tipo_respuesta = 7 AND m.fecha_${tipo_fecha} BETWEEN ? AND ?
        GROUP BY
            pc.id
        ORDER BY
            id_pregunta ASC, total DESC
        `,
        [
          idCampania,
          from_date,
          to_date,
          idCampania,
          from_date,
          to_date,
          idCampania,
          from_date,
          to_date,
        ]
      );

      if (rowsResult.length > 0) {
        const result = {};

        rowsResult.forEach((row) => {
          if (!result[row.id_pregunta]) {
            result[row.id_pregunta] = {
              id_pregunta: row.id_pregunta,
              pregunta: row.pregunta,
              id_tipo_respuesta: row.id_tipo_respuesta,
              respuestas: [],
              promedio_rating: null,
            };
          }

          if (row.id_tipo_respuesta === 7) {
            result[row.id_pregunta].promedio_rating = row.total;
          } else {
            result[row.id_pregunta].respuestas.push({
              name: row.name,
              total: row.total,
            });
          }
        });

        // Sort responses for each question
        Object.values(result).forEach((pregunta) => {
          if (pregunta.id_tipo_respuesta !== 7) {
            pregunta.respuestas.sort((a, b) => b.total - a.total);
          }
        });

        const combinedResults = Object.values(result);
        res.status(200).json(combinedResults);
      } else {
        res.status(200).json([]);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("Error interno al intentar obtener los resultados");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/resultados-preguntas-sino", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const from_date = req.query.from_date || "1970-01-01";
  const to_date = req.query.to_date || "2100-01-01";
  const filtro_fecha = req.query.filtro_fecha || "fecha_creacion";
  const idCampania = req.query.id_campania;
  // console.log("idCampania", idCampania);
  if (cabecera.rol === "admin") {
    try {
      const [rowTotal] = await mysqlConnection.promise().execute(
        `
      SELECT mds.respuesta_numero as respuesta_numero, pc.id as id_pregunta, COUNT(mds.respuesta_numero) as total
      FROM mision_ditor_respuesta_simple as mds
      INNER JOIN pregunta_campania as pc ON mds.pregunta_campania = pc.id
      -- Revisar
      INNER JOIN mision_ditor md ON md.id = mds.mision_ditor
      INNER JOIN mision m ON m.id = md.mision 
      WHERE pc.tipo_respuesta = '3' AND pc.campania = ?
      AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
      GROUP BY mds.respuesta_numero
      ORDER BY id_pregunta
      
      `,
        [idCampania, from_date, to_date]
      );
      const [respuestasMultiples] = await mysqlConnection.promise().execute(
        `
      SELECT (pcr.respuesta) as respuestas_multiples, COUNT(pcr.respuesta) as total,(mdm.pregunta_campania_respuesta) as id_respuesta,(mds.pregunta_campania) as id_pregunta
      FROM mision_ditor_respuesta_simple as mds
      INNER JOIN pregunta_campania as pc ON mds.pregunta_campania = pc.id
      INNER JOIN campania as c ON pc.campania = c.id
      INNER JOIN mision_ditor_respuesta_multiple as mdm ON mdm.mision_ditor_respuesta_simple = mds.id
      INNER JOIN pregunta_campania_respuesta as pcr ON pcr.pregunta_campania = mdm.pregunta_campania_respuesta
      -- Revisar
      INNER JOIN mision_ditor md ON md.id = mds.mision_ditor
      INNER JOIN mision m ON m.id = md.mision 
      WHERE pc.tipo_respuesta = 4 OR pc.tipo_respuesta = 5 AND c.id = ?
      AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
      group by pcr.respuesta
      order by id_respuesta
        `,
        [idCampania, from_date, to_date]
      );
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT 
      pc.pregunta as pregunta,
      SUM(CASE WHEN mds.respuesta_si_no = 'Y' THEN 1 ELSE 0 END) as respuestas_Y,
      SUM(CASE WHEN mds.respuesta_si_no = 'N' THEN 1 ELSE 0 END) as respuestas_N,
      SUM(mds.tipo_respuesta = 4 ) as respuesta_opcion_simple,
      SUM(mds.tipo_respuesta = 5 ) as respuesta_checkbox,
      AVG(mds.respuesta_numero) as respuesta_promedio,
      MIN(mds.respuesta_numero) as min_respuesta_numero,
      MAX(mds.respuesta_numero) as max_respuesta_numero,
      pc.id as id_pregunta,
      (SELECT respuesta_numero
       FROM mision_ditor_respuesta_simple 
       WHERE pregunta_campania = pc.id
       GROUP BY respuesta_numero 
       ORDER BY COUNT(*) DESC 
       LIMIT 1) as moda_respuesta_numero,
        tr.nombre as tipo_respuesta,
        tr.id as id_tipo_respuesta
        FROM 
        campania as c
       JOIN 
        pregunta_campania as pc ON c.id = pc.campania
      INNER JOIN 
        mision_ditor_respuesta_simple as mds ON mds.pregunta_campania = pc.id
      INNER JOIN 
        tipo_respuesta as tr ON tr.id = mds.tipo_respuesta
      -- Revisar
      INNER JOIN mision_ditor md ON md.id = mds.mision_ditor
      INNER JOIN mision m ON m.id = md.mision 
      WHERE  pc.tipo_respuesta<> 6 AND pc.tipo_respuesta <> 2 AND pc.tipo_respuesta <> 8 AND pc.tipo_respuesta <> 9 AND pc.tipo_respuesta <> 5 AND c.id = ?
      AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
      GROUP BY 
        pc.pregunta
  
      `,
        [idCampania, from_date, to_date]
      );
      if (rows.length > 0) {
        var nuevoObjeto = [];
        for (let i = 0; i < rows.length; i++) {
          // Crear un objeto para cada pregunta
          let pregunta = rows[i];

          // Si la pregunta es de tipo respuesta 3, buscar las respuestas correspondientes
          if (pregunta.id_tipo_respuesta == 3) {
            let min = pregunta.min_respuesta_numero;
            let max = pregunta.max_respuesta_numero;
            let numRanges = 4; // Define el número de rangos que deseas
            let rangeSize = (max - min) / numRanges;
            let ranges = [];
            let respuestas = new Array(numRanges).fill(0);
            //esta funcion arma un array con la cantidad de rangos que tenga numRanges
            for (let i = 0; i < numRanges; i++) {
              let start = min + i * rangeSize;
              let end = start + rangeSize;
              ranges.push(`${start.toFixed(0)}-${end.toFixed(0)}`);
            }

            rowTotal
              .filter((row) => row.id_pregunta == pregunta.id_pregunta)
              .forEach((row) => {
                for (let i = 0; i < numRanges; i++) {
                  let [start, end] = ranges[i].split("-").map(Number);
                  if (
                    row.respuesta_numero >= start &&
                    row.respuesta_numero <= end
                  ) {
                    respuestas[i] += row.total;
                    break;
                  }
                }
              });

            pregunta.ranges = ranges;
            pregunta.respuestas = respuestas;
          } else if (
            pregunta.id_tipo_respuesta == 4 ||
            pregunta.id_tipo_respuesta == 5
          ) {
            let respuestas = respuestasMultiples.filter(
              (r) => r.id_pregunta == pregunta.id_pregunta
            );
            let categorias = [];
            let totales = [];

            // Llenar los vectores con los datos de las respuestas
            for (let j = 0; j < respuestas.length; j++) {
              categorias.push(respuestas[j].respuestas_multiples);
              totales.push(respuestas[j].total);
            }

            // Agregar los vectores al objeto de la pregunta
            pregunta.ranges = categorias;
            pregunta.respuestas = totales;

            // console.log('respuestas multiples', pregunta);
            // console.log('rangos mult', ranges);
          }
          // Agregar la pregunta al array nuevoObjeto
          nuevoObjeto.push(pregunta);
        }
        // console.log(nuevoObjeto)
        res.status(200).json(nuevoObjeto);
      } else {
        res.status(404).json("No se han encontrado resultados.");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rowTotal] = await mysqlConnection.promise().execute(
        `
      SELECT mds.respuesta_numero as respuesta_numero, pc.id as id_pregunta, COUNT(mds.respuesta_numero) as total
      FROM mision_ditor_respuesta_simple as mds
      INNER JOIN pregunta_campania as pc ON mds.pregunta_campania = pc.id 
      INNER JOIN campania as c ON c.id = pc.campania
      -- Revisar
      INNER JOIN mision_ditor md ON md.id = mds.mision_ditor
      INNER JOIN mision m ON m.id = md.mision 
      WHERE pc.tipo_respuesta = '3' AND pc.campania = ? AND c.cliente = ?
      AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
      GROUP BY mds.respuesta_numero
      ORDER BY id_pregunta
      
      `,
        [idCampania, cabecera.client_id, from_date, to_date]
      );
      const [respuestasMultiples] = await mysqlConnection.promise().execute(
        `
      SELECT (pcr.respuesta) as respuestas_multiples, COUNT(pcr.respuesta) as total,(mdm.pregunta_campania_respuesta) as id_respuesta,(mds.pregunta_campania) as id_pregunta
      FROM mision_ditor_respuesta_simple as mds
      INNER JOIN pregunta_campania as pc ON mds.pregunta_campania = pc.id
      INNER JOIN campania as c ON pc.campania = c.id
      INNER JOIN mision_ditor_respuesta_multiple as mdm ON mdm.mision_ditor_respuesta_simple = mds.id
      INNER JOIN pregunta_campania_respuesta as pcr ON pcr.pregunta_campania = mdm.pregunta_campania_respuesta
      -- Revisar
      INNER JOIN mision_ditor md ON md.id = mds.mision_ditor
      INNER JOIN mision m ON m.id = md.mision 
      WHERE pc.tipo_respuesta = 4 OR pc.tipo_respuesta = 5 AND c.id = ? AND c.cliente = ?
      AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
      group by pcr.respuesta
      order by id_respuesta
        `,
        [idCampania, cabecera.client_id, from_date, to_date]
      );
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT 
      pc.pregunta as pregunta,
      SUM(CASE WHEN mds.respuesta_si_no = 'Y' THEN 1 ELSE 0 END) as respuestas_Y,
      SUM(CASE WHEN mds.respuesta_si_no = 'N' THEN 1 ELSE 0 END) as respuestas_N,
      SUM(mds.tipo_respuesta = 4 ) as respuesta_opcion_simple,
      SUM(mds.tipo_respuesta = 5 ) as respuesta_checkbox,
      AVG(mds.respuesta_numero) as respuesta_promedio,
      MIN(mds.respuesta_numero) as min_respuesta_numero,
      MAX(mds.respuesta_numero) as max_respuesta_numero,
      pc.id as id_pregunta,
      (SELECT respuesta_numero
        FROM mision_ditor_respuesta_simple 
        WHERE pregunta_campania = pc.id
        GROUP BY respuesta_numero 
        ORDER BY COUNT(*) DESC 
        LIMIT 1) as moda_respuesta_numero,
        tr.nombre as tipo_respuesta,
        tr.id as id_tipo_respuesta
        FROM 
        campania as c
        JOIN 
        pregunta_campania as pc ON c.id = pc.campania
      INNER JOIN 
        mision_ditor_respuesta_simple as mds ON mds.pregunta_campania = pc.id
      INNER JOIN 
        tipo_respuesta as tr ON tr.id = mds.tipo_respuesta
      -- Revisar
      INNER JOIN mision_ditor md ON md.id = mds.mision_ditor
      INNER JOIN mision m ON m.id = md.mision
      WHERE  pc.tipo_respuesta<> 6 AND pc.tipo_respuesta <> 2 AND pc.tipo_respuesta <> 8 AND pc.tipo_respuesta <> 9 AND pc.tipo_respuesta <> 5 AND c.id = ? AND c.cliente = ?
      AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
      GROUP BY 
        pc.pregunta
  
      `,
        [idCampania, cabecera.client_id, from_date, to_date]
      );
      if (rows.length > 0) {
        var nuevoObjeto = [];
        for (let i = 0; i < rows.length; i++) {
          // Crear un objeto para cada pregunta
          let pregunta = rows[i];

          // Si la pregunta es de tipo respuesta 3, buscar las respuestas correspondientes
          if (pregunta.id_tipo_respuesta == 3) {
            let min = pregunta.min_respuesta_numero;
            let max = pregunta.max_respuesta_numero;
            let numRanges = 4; // Define el número de rangos que deseas
            let rangeSize = (max - min) / numRanges;
            let ranges = [];
            let respuestas = new Array(numRanges).fill(0);
            //esta funcion arma un array con la cantidad de rangos que tenga numRanges
            for (let i = 0; i < numRanges; i++) {
              let start = min + i * rangeSize;
              let end = start + rangeSize;
              ranges.push(`${start.toFixed(0)}-${end.toFixed(0)}`);
            }

            rowTotal
              .filter((row) => row.id_pregunta == pregunta.id_pregunta)
              .forEach((row) => {
                for (let i = 0; i < numRanges; i++) {
                  let [start, end] = ranges[i].split("-").map(Number);
                  if (
                    row.respuesta_numero >= start &&
                    row.respuesta_numero <= end
                  ) {
                    respuestas[i] += row.total;
                    break;
                  }
                }
              });

            pregunta.ranges = ranges;
            pregunta.respuestas = respuestas;
          } else if (
            pregunta.id_tipo_respuesta == 4 ||
            pregunta.id_tipo_respuesta == 5
          ) {
            let respuestas = respuestasMultiples.filter(
              (r) => r.id_pregunta == pregunta.id_pregunta
            );
            let categorias = [];
            let totales = [];

            // Llenar los vectores con los datos de las respuestas
            for (let j = 0; j < respuestas.length; j++) {
              categorias.push(respuestas[j].respuestas_multiples);
              totales.push(respuestas[j].total);
            }

            // Agregar los vectores al objeto de la pregunta
            pregunta.ranges = categorias;
            pregunta.respuestas = totales;

            // console.log('respuestas multiples', pregunta);
            // console.log('rangos mult', ranges);
          }
          // Agregar la pregunta al array nuevoObjeto
          nuevoObjeto.push(pregunta);
        }
        // console.log(nuevoObjeto)
        res.status(200).json(nuevoObjeto);
      } else {
        res.status(404).json("No se han encontrado resultados");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/resultados-info-cliente", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const from_date = req.query.from_date || "1970-01-01";
  const to_date = req.query.to_date || "2100-01-01";
  const filtro_fecha = req.query.filtro_fecha || "fecha_creacion";
  const idCampania = req.query.id_campania;

  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT (c.cliente) as id_cliente, (ec.nombre) as estado_campania,(c.nombre) as nombre_campania,(c.fecha_inicio) as fecha_inicio,(c.fecha_fin) as fecha_fin,
        (SELECT COUNT(distinct mi2.comercio)
         FROM mision as mi2 
         INNER JOIN campania as c2 ON c2.id = mi2.campania
         WHERE mi2.campania = c.id AND mi2.${filtro_fecha} >= ? and mi2.${filtro_fecha} <= ? and mi2.campania = ? ) as cantidad_comercios,
               (SELECT COUNT(mi2.id)
         FROM mision as mi2 
         WHERE mi2.campania = c.id AND mi2.${filtro_fecha} >= ? and mi2.${filtro_fecha} <= ? and mi2.campania = ? ) as total_misiones,
        (SELECT COUNT(distinct mi.id) 
         FROM mision as mi 
         INNER JOIN campania as c ON c.id = mi.campania
         INNER JOIN cliente as cli ON cli.id = c.cliente
         WHERE mi.estado_mision = 5
         AND mi.${filtro_fecha} >= ? and mi.${filtro_fecha} <= ? and mi.campania = ?
        ) as cantidad_misiones_finalizadas,
      (SELECT COUNT(distinct art2.id)
         FROM articulo as art2 
         INNER JOIN campania as c2 ON c2.cliente = art2.cliente
         WHERE c2.id = c.id) as cantidad_articulos,
        (c.id) as id_campania
        FROM campania as c
        INNER JOIN estado_campania as ec ON ec.id = c.estado_campania
        WHERE c.id = ?
        group by c.cliente
    `,
        [
          from_date,
          to_date,
          idCampania,
          from_date,
          to_date,
          idCampania,
          from_date,
          to_date,
          idCampania,
          idCampania,
        ]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT (c.cliente) as id_cliente, (ec.nombre) as estado_campania,(c.nombre) as nombre_campania,(c.fecha_inicio) as fecha_inicio,(c.fecha_fin) as fecha_fin,
        (SELECT COUNT(distinct mi2.comercio)
         FROM mision as mi2 
         INNER JOIN campania as c2 ON c2.id = mi2.campania
         WHERE mi2.campania = c.id AND mi2.${filtro_fecha} >= ? and mi2.${filtro_fecha} <= ? and mi2.campania = ? ) as cantidad_comercios,
               (SELECT COUNT(mi2.id)
         FROM mision as mi2 
         WHERE mi2.campania = c.id AND mi2.${filtro_fecha} >= ? and mi2.${filtro_fecha} <= ? and mi2.campania = ? ) as total_misiones,
        (SELECT COUNT(distinct mi.id) 
         FROM mision as mi 
         INNER JOIN campania as c ON c.id = mi.campania
         INNER JOIN cliente as cli ON cli.id = c.cliente
         WHERE mi.estado_mision = 5
         AND mi.${filtro_fecha} >= ? and mi.${filtro_fecha} <= ? and mi.campania = ?
        ) as cantidad_misiones_finalizadas,
      (SELECT COUNT(distinct art2.id)
         FROM articulo as art2 
         INNER JOIN campania as c2 ON c2.cliente = art2.cliente
         WHERE c2.id = c.id) as cantidad_articulos,
        (c.id) as id_campania
        FROM retail.campania as c
        INNER JOIN estado_campania as ec ON ec.id = c.estado_campania
        WHERE c.id = ? and c.cliente = ?
        group by c.cliente
      `,

        [
          from_date,
          to_date,
          idCampania,
          from_date,
          to_date,
          idCampania,
          from_date,
          to_date,
          idCampania,
          idCampania,
          cabecera.client_id,
        ]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.get("/misiones-campania", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const from_date = req.query.from_date || "1970-01-01";
  const to_date = req.query.to_date || "2100-01-01";
  const filtro_fecha = req.query.filtro_fecha || "fecha_creacion";
  const idCampania = req.query.id_campania;
  var resultsPerPage = 10;
  var page = req.query.page ? Number(req.query.page) : 1;
  if (page < 1) {
    page = 1;
  }
  var start = (page - 1) * resultsPerPage;

  var orderBy = req.query.orderBy ? req.query.orderBy : "idMision";
  var orderType = ["asc", "desc"].includes(req.query.orderType)
    ? req.query.orderType
    : "desc";
  var queryOrderBy = `${orderBy} ${orderType}`;
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT CONCAT('#MI',m.id) as idMision,
        (cli.nombre) as cliente,
        (c.fecha_inicio) as fecha_inicio,
        (c.fecha_fin) as fecha_fin,
        (c.nombre) as nombre_campania
        FROM  mision as m
        INNER JOIN campania as c ON c.id = m.campania
        INNER JOIN cliente as cli ON cli.id = c.cliente
        INNER JOIN mision_ditor md ON (m.id = md.mision)
        INNER JOIN fotos_mision_ditor fmd ON (md.id = fmd.mision_ditor)
        WHERE c.id = ? AND fmd.archivo is not NULL and m.estado_mision IN (4,5)
        AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
        GROUP BY m.id
        LIMIT ?, ?
    `,
        [idCampania, from_date, to_date, start, resultsPerPage]
      );
      // console.log("misiones", rows);

      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
            SELECT COUNT(DISTINCT m.id) as count
            FROM  mision as m
            INNER JOIN campania as c ON c.id = m.campania
            INNER JOIN cliente as cli ON cli.id = c.cliente
            INNER JOIN mision_ditor md ON (m.id = md.mision)
            INNER JOIN fotos_mision_ditor fmd ON (md.id = fmd.mision_ditor)
            WHERE c.id = ? AND fmd.archivo is not NULL and m.estado_mision IN (4,5)
            AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
          `,
          [idCampania, from_date, to_date]
        );
        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);

        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get misiones ");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT CONCAT('#MI',m.id) as idMision,
        (cli.nombre) as cliente,
        (c.fecha_inicio) as fecha_inicio,
        (c.fecha_fin) as fecha_fin,
        (c.nombre) as nombre_campania
        FROM  mision as m
        INNER JOIN campania as c ON c.id = m.campania
        INNER JOIN cliente as cli ON cli.id = c.cliente
        INNER JOIN mision_ditor md ON (m.id = md.mision)
        INNER JOIN fotos_mision_ditor fmd ON (md.id = fmd.mision_ditor)
        WHERE c.id = ? AND cli.id = ? AND fmd.archivo is not NULL and m.estado_mision IN (4,5)
        AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
        GROUP BY m.id
        LIMIT ?, ?
    `,
        [
          idCampania,
          cabecera.client_id,
          from_date,
          to_date,
          start,
          resultsPerPage,
        ]
      );
      // console.log("misiones", rows);

      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
            SELECT COUNT(DISTINCT m.id) as count
            FROM  mision as m
            INNER JOIN campania as c ON c.id = m.campania
            INNER JOIN cliente as cli ON cli.id = c.cliente
            INNER JOIN mision_ditor md ON (m.id = md.mision)
            INNER JOIN fotos_mision_ditor fmd ON (md.id = fmd.mision_ditor)
            WHERE c.id = ? AND cli.id = ? AND fmd.archivo is not NULL and m.estado_mision IN (4,5)
            AND m.${filtro_fecha} >= ? and m.${filtro_fecha} <= ?
          `,
          [idCampania, cabecera.client_id, from_date, to_date]
        );
        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);

        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get misiones ");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.get("/total-genero-campania/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;
  // console.log(cabecera);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT 
      COUNT(g.id) as total,
      (g.nombre) as nombre
      FROM campania as c
      INNER JOIN mision as m ON m.campania = c.id
      INNER JOIN mision_ditor as md ON md.mision = m.id
      INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor
      INNER JOIN genero as g ON pd.genero = g.id
      WHERE c.id = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
      group by nombre
      
    `,
        [idCampania]
      );
      // console.log("generos", rows);
      if (rows.length > 0) {
        res.status(200).json(rows);
      } else {
        respuesta = [{ total: 0, nombre: "" }];
        res.status(200).json(respuesta);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get misiones ");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT 
      COUNT(g.id) as total,
      (g.nombre) as nombre
      FROM campania as c
      INNER JOIN mision as m ON m.campania = c.id
      INNER JOIN mision_ditor as md ON md.mision = m.id
      INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor
      INNER JOIN genero as g ON pd.genero = g.id
      WHERE c.id = ? AND c.cliente = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
      group by nombre
      
    `,
        [idCampania, cabecera.client_id]
      );
      // console.log("generos", rows);
      if (rows.length > 0) {
        res.status(200).json(rows);
      } else {
        respuesta = [{ total: 0, nombre: "" }];
        res.status(200).json(respuesta);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get misiones ");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.get("/rango-edades-campania/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;
  console.log("idCampania", idCampania);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT 
        round(DATEDIFF(CURDATE(), pd.fecha_nacimiento) / 365,0) AS edad
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor

        WHERE c.id = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
        group by pd.ditor
      `,
        [idCampania]
      );
      if (rows.length > 0) {
        let edad;
        var nuevoObjeto = [];
        let min = 999;
        let max = 0;
        for (let i = 0; i < rows.length; i++) {
          // Crear un objeto para cada pregunta
          edad = rows[i];
          if (edad.edad > max && edad.edad < min) {
            max = edad.edad;
            min = edad.edad;
          } //para el primer caso
          if (edad.edad > max) {
            max = edad.edad;
          } else {
            if (edad.edad < min) {
              min = edad.edad;
            }
          }
        }

        let numRanges = 5; // Define el número de rangos
        let rangeSize = (max - min) / numRanges;
        let ranges = [];
        let respuestas = new Array(numRanges).fill(0);
        let range = "";
        //esta funcion arma un array con la cantidad de rangos que tenga numRanges
        for (let i = 0; i < numRanges; i++) {
          let start = min + i * rangeSize;
          let end = start + rangeSize;
          start = Math.floor(start);
          if (start === end) {
            range = `${start.toFixed(0)}`;
            numRanges = 1;
          } else {
            range = `${start.toFixed(0)}-${end.toFixed(0)}`;
          }

          if (!ranges.includes(range)) {
            // Si el rango no existe en el arreglo, lo agregas
            ranges.push(range);
          }
        }
        rows.forEach((row) => {
          for (let i = 0; i < numRanges; i++) {
            let [start, end] = "";
            if (numRanges == 1) {
              start = ranges[i];
              respuestas[i]++;
            } else {
              [start, end] = ranges[i].split("-").map(Number);
              if (row.edad >= start && row.edad <= end) {
                respuestas[i]++;
                break;
              }
            }
          }
        });

        edad.ranges = ranges;
        edad.respuestas = respuestas;
        nuevoObjeto.push(edad);
        // console.log(nuevoObjeto[0]);
        res.status(200).json(nuevoObjeto[0]);
      } else {
        var nuevoObjeto = [{ edad: 0, ranges: ["0"], respuestas: [0] }];
        res.status(200).json(nuevoObjeto[0]);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get edades");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT 
        round(DATEDIFF(CURDATE(), pd.fecha_nacimiento) / 365,0) AS edad
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor

        WHERE c.id = ? AND c.cliente = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
        group by pd.ditor
      `,
        [idCampania, cabecera.client_id]
      );

      if (rows.length > 0) {
        let edad;
        var nuevoObjeto = [];
        let min = 999;
        let max = 0;
        for (let i = 0; i < rows.length; i++) {
          // Crear un objeto para cada pregunta
          edad = rows[i];
          if (edad.edad > max && edad.edad < min) {
            max = edad.edad;
            min = edad.edad;
          } //para el primer caso
          if (edad.edad > max) {
            max = edad.edad;
          } else {
            if (edad.edad < min) {
              min = edad.edad;
            }
          }
        }

        let numRanges = 5; // Define el número de rangos
        let rangeSize = (max - min) / numRanges;
        let ranges = [];
        let respuestas = new Array(numRanges).fill(0);
        let range = "";
        //esta funcion arma un array con la cantidad de rangos que tenga numRanges
        for (let i = 0; i < numRanges; i++) {
          let start = min + i * rangeSize;
          let end = start + rangeSize;
          start = Math.floor(start);
          if (start === end) {
            range = `${start.toFixed(0)}`;
            numRanges = 1;
          } else {
            range = `${start.toFixed(0)}-${end.toFixed(0)}`;
          }

          if (!ranges.includes(range)) {
            // Si el rango no existe en el arreglo, lo agregas
            ranges.push(range);
          }
        }
        rows.forEach((row) => {
          for (let i = 0; i < numRanges; i++) {
            let [start, end] = "";
            if (numRanges == 1) {
              start = ranges[i];
              respuestas[i]++;
            } else {
              [start, end] = ranges[i].split("-").map(Number);
              if (row.edad >= start && row.edad <= end) {
                respuestas[i]++;
                break;
              }
            }
          }
        });

        edad.ranges = ranges;
        edad.respuestas = respuestas;
        nuevoObjeto.push(edad);
        res.status(200).json(nuevoObjeto[0]);
      } else {
        var nuevoObjeto = [{ edad: 0, ranges: ["0"], respuestas: [0] }];
        res.status(200).json(nuevoObjeto[0]);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get edades");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.get("/nacionalidades-campania/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;

  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        p.nombre as nacionalidad,
        COUNT(p.nombre) as total
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor
        INNER JOIN pais as p ON p.id = pd.pais
        WHERE c.id = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
        group by nacionalidad
      `,
        [idCampania]
      );
      if (rows.length > 0) {
        var nuevoObjeto = [];
        let categorias = [];
        let totales = [];
        for (let i = 0; i < rows.length; i++) {
          nacionalidades = rows[i];
          categorias.push(rows[i].nacionalidad);
          totales.push(rows[i].total);
        }

        // Agregar los vectores al objeto de la pregunta
        nacionalidades.ranges = categorias;
        nacionalidades.respuestas = totales;

        nuevoObjeto.push(nacionalidades);
        // console.log(nuevoObjeto)
        res.status(200).json(nuevoObjeto);
      } else {
        var nuevoObjeto = [
          {
            nacionalidad: "",
            total: 0,
            ranges: [""],
            respuestas: [0],
          },
        ];
        res.status(200).json(nuevoObjeto);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get edades");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        p.nombre as nacionalidad,
        COUNT(p.nombre) as total
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor
        INNER JOIN pais as p ON p.id = pd.pais
        WHERE c.id = ? AND c.cliente = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
        group by nacionalidad
      `,
        [idCampania, cabecera.client_id]
      );
      if (rows.length > 0) {
        var nuevoObjeto = [];
        let categorias = [];
        let totales = [];
        for (let i = 0; i < rows.length; i++) {
          nacionalidades = rows[i];
          categorias.push(rows[i].nacionalidad);
          totales.push(rows[i].total);
        }

        // Agregar los vectores al objeto de la pregunta
        nacionalidades.ranges = categorias;
        nacionalidades.respuestas = totales;

        nuevoObjeto.push(nacionalidades);
        // console.log(nuevoObjeto)
        res.status(200).json(nuevoObjeto);
      } else {
        var nuevoObjeto = [
          {
            nacionalidad: "",
            total: 0,
            ranges: [""],
            respuestas: [0],
          },
        ];
        res.status(200).json(nuevoObjeto);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get edades");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.get("/cantidad-hijos-campania/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;
  // console.log("idCampania", idCampania);
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        pd.hijos as total
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor
        WHERE c.id = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
        group by pd.ditor
      `,
        [idCampania]
      );
      if (rows.length > 0) {
        let hijos;
        var nuevoObjeto = [];
        let min = 999;
        let max = 0;
        for (let i = 0; i < rows.length; i++) {
          // Crear un objeto para cada pregunta
          hijos = rows[i];
          if (hijos.total > max && hijos.total < min) {
            max = hijos.total;
            min = hijos.total;
          } //para el primer caso
          if (hijos.total > max) {
            max = hijos.total;
          } else {
            if (hijos.total < min) {
              min = hijos.total;
            }
          }
        }

        let numRanges = 5; // Define el número de rangos
        let rangeSize = (max - min) / numRanges;
        let ranges = [];
        let respuestas = new Array(numRanges).fill(0);
        //esta funcion arma un array con la cantidad de rangos que tenga numRanges
        for (let i = 0; i < numRanges; i++) {
          let start = min + i * rangeSize;
          let end = start + rangeSize;
          start = Math.floor(start);
          let range = `${start.toFixed(0)}-${end.toFixed(0)}`;

          if (!ranges.includes(range)) {
            // Si el rango no existe en el arreglo, lo agregas
            ranges.push(range);
          }
        }
        rows.forEach((row) => {
          for (let i = 0; i < numRanges; i++) {
            let [start, end] = ranges[i].split("-").map(Number);
            if (row.total >= start && row.total <= end) {
              respuestas[i] += row.total;
              break;
            }
          }
        });

        // Agregar los vectores al objeto de la pregunta
        hijos.ranges = ranges;
        hijos.respuestas = respuestas;

        nuevoObjeto.push(hijos);
        res.status(200).json(nuevoObjeto[0]);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get edades");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        pd.hijos as total
        FROM campania as c
        INNER JOIN mision as m ON m.campania = c.id
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN perfil_ditor as pd ON pd.ditor= md.ditor
        WHERE c.id = ? AND c.cliente = ? AND (m.estado_mision = 4 OR m.estado_mision = 5) AND (md.estado_mision_ditor = 5 OR md.estado_mision_ditor = 8)
        group by pd.ditor
      `,
        [idCampania, cabecera.client_id]
      );
      if (rows.length > 0) {
        let hijos;
        var nuevoObjeto = [];
        let min = 999;
        let max = 0;
        for (let i = 0; i < rows.length; i++) {
          // Crear un objeto para cada pregunta
          hijos = rows[i];
          if (hijos.total > max && hijos.total < min) {
            max = hijos.total;
            min = hijos.total;
          } //para el primer caso
          if (hijos.total > max) {
            max = hijos.total;
          } else {
            if (hijos.total < min) {
              min = hijos.total;
            }
          }
        }

        let numRanges = 5; // Define el número de rangos
        let rangeSize = (max - min) / numRanges;
        let ranges = [];
        let respuestas = new Array(numRanges).fill(0);
        //esta funcion arma un array con la cantidad de rangos que tenga numRanges
        for (let i = 0; i < numRanges; i++) {
          let start = min + i * rangeSize;
          let end = start + rangeSize;
          start = Math.floor(start);
          let range = `${start.toFixed(0)}-${end.toFixed(0)}`;

          if (!ranges.includes(range)) {
            // Si el rango no existe en el arreglo, lo agregas
            ranges.push(range);
          }
        }
        rows.forEach((row) => {
          for (let i = 0; i < numRanges; i++) {
            let [start, end] = ranges[i].split("-").map(Number);
            if (row.total >= start && row.total <= end) {
              respuestas[i] += row.total;
              break;
            }
          }
        });

        // Agregar los vectores al objeto de la pregunta
        hijos.ranges = ranges;
        hijos.respuestas = respuestas;

        nuevoObjeto.push(hijos);
        res.status(200).json(nuevoObjeto[0]);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get edades");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// Coordenadas recuperadas de la base de datos para mapa google

router.get("/map/locations", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().query(
        `SELECT
        ST_X(coordenadas) as lng, ST_Y(coordenadas) as lat, nombre as label
        FROM comercio co
        INNER JOIN mision m ON (co.id = m.comercio)
        WHERE co.habilitado = 'Y' AND m.estado_mision = 1
        ${cabecera.rol === "cliente" ? "AND co.cliente = ?" : ""}`,
        [cabecera.client_id]
      );
      const locations = rows.map((row) => ({
        position: { lat: row.lat, lng: row.lng },
        label: row.label,
      }));
      const center = locations.reduce(
        (acc, curr) => ({
          lat: acc.lat + curr.position.lat,
          lng: acc.lng + curr.position.lng,
        }),
        { lat: 0, lng: 0 }
      );
      center.lat /= locations.length;
      center.lng /= locations.length;
      // console.log({ center, locations});
      res.json({ center, locations });
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  } else {
    res.status(401).json("Unauthorized");
  }
});

//! Revisar (Funcionan pero por las dudas jaja)

router.get("/logo-cliente/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;
  if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        logo_cliente.archivo as logo_cliente
        FROM cliente
        inner join logo_cliente ON cliente.id = logo_cliente.cliente
        WHERE cliente.id = ?
      
    `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        if (rows[0].logo_cliente != null) {
          getObjectParams = {
            Bucket: bucketName,
            Key: rows[0].logo_cliente,
          };
          command = new GetObjectCommand(getObjectParams);
          url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        }

        res.status(200).json(url);
      } else {
        res.status(404).json("No se ha encontrado el logo del cliente");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get logo_cliente ");
    }
  } else if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        logo_cliente.archivo as logo_cliente
        FROM cliente
        inner join logo_cliente ON cliente.id = logo_cliente.cliente
        inner join campania c ON (c.cliente = cliente.id)
        WHERE c.id = ?;
      
    `,
        [idCampania]
      );

      if (rows.length > 0) {
        if (rows[0].logo_cliente != null) {
          getObjectParams = {
            Bucket: bucketName,
            Key: rows[0].logo_cliente,
          };
          command = new GetObjectCommand(getObjectParams);
          url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        }

        res.status(200).json(url);
      } else {
        res.status(404).json("No se ha encontrado el logo del cliente");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get logo_cliente ");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/respuestas-obtenidas", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
                    SELECT COUNT(*) as total 
                    FROM
                    campania c
                    INNER JOIN mision m ON c.id = m.campania
                    WHERE c.estado_campania = 2 and m.estado_mision = 5 and c.cliente = ?
                    `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado respuestas obtenidas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get respuestas obtenidas");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// Todas aquellas misiones que se encuentran en estado ASIGNADA hoy
router.get("/misiones-asignadas-hoy", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT COUNT(m.estado_mision) AS total
      FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
      INNER JOIN campania c ON m.campania = c.id
      WHERE em.nombre ='Asignada' AND m.fecha_modificacion = CURDATE() and c.cliente = ?;
                    `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado respuestas obtenidas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get respuestas obtenidas");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// cantidad de znappers que estan en vivo
router.get("/zappers/cantidad/en-vivo", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      // traer los znappers cuya posicion actual tuvo fecha_modificacion menor a 3 minutos
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT COUNT(u.id) as total
        FROM usuario as u
        INNER JOIN posicion_actual_ditor as pad ON pad.usuario = u.id
        WHERE u.rol = 3 AND pad.fecha_modificacion >= NOW() - INTERVAL 3 MINUTE AND u.cliente = ?`,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se ha encontrado znappers");
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get znappers");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// cantidad de znappers totales
router.post("/zappers/cantidad/total", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    const filters = req.body;
    // Convertir a formato ISO y obtener solo la fecha
    if (filters.fecha_desde) {
      fecha_desde = new Date(filters.fecha_desde).toISOString().slice(0, 10);
    }
    if (filters.fecha_hasta) {
      fecha_hasta = new Date(filters.fecha_hasta).toISOString().slice(0, 10);
    }

    var query_fecha_desde = "";
    if (filters.fecha_desde) {
      query_fecha_desde = "AND u.fecha_creacion >= '" + fecha_desde + "'";
    }
    var query_fecha_hasta = "";
    if (filters.fecha_hasta) {
      query_fecha_hasta =
        "AND u.fecha_creacion < DATE_ADD('" +
        fecha_hasta +
        "', INTERVAL 1 DAY)";
    }

    try {
      // traer los znappers utilizando los filtros
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT COUNT(u.id) as total
        FROM usuario as u
        WHERE u.rol = 3 AND u.cliente = ? AND u.habilitado = 'Y'
        ${query_fecha_desde}
        ${query_fecha_hasta}
        `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0].total);
      } else {
        res.status(404).json("No se ha encontrado znappers");
      }
    } catch (error) {
      console.log(error);
      res.status(500).send("An error occurred while trying to get znappers");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// Todas aquellas misiones que se encuentran en estado Completada hoy
router.get(
  "/cantidad/misiones-completadas-hoy",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
      try {
        const [rows] = await mysqlConnection.promise().execute(
          `
      SELECT COUNT(m.id) AS total
      FROM mision as m
      INNER JOIN campania c ON m.campania = c.id
      WHERE m.estado_mision = 5 AND DATE(m.fecha_finalizacion) = CURDATE() AND c.cliente = ?;
                    `,
          [cabecera.client_id]
        );

        if (rows.length > 0) {
          res.status(200).json(rows[0].total);
        } else {
          res.status(404).json("No se han encontrado respuestas obtenidas");
        }
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .send("An error occurred while trying to get respuestas obtenidas");
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  }
);

// Todas aquellas misiones que se encuentran en estado Completada Total
router.get("/misiones-completadas-total", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT COUNT(m.estado_mision) AS total
      FROM mision as m INNER JOIN estado_mision as em ON m.estado_mision = em.id
      INNER JOIN campania c ON m.campania = c.id
      WHERE em.nombre ='Completada' and c.cliente = ?;
                    `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado respuestas obtenidas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get respuestas obtenidas");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/desglose-servicios-torta", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      //? Consultar si es lo que se quiere mostrar en el grafico

      const [rowTotal] = await mysqlConnection.promise().execute(
        `
            SELECT COUNT(pp.id) as total
            FROM campania c
            INNER JOIN pregunta_campania pc ON (c.id = pc.campania)
            INNER JOIN pregunta_predefinida pp ON (pc.pregunta_predefinida = pp.id)
            WHERE c.cliente = ? and c.estado_campania = 2;
          `,
        [cabecera.client_id]
      );

      const [rows] = await mysqlConnection.promise().execute(
        `
            SELECT COUNT(pp.id) as camp, spp.nombre as nombreCliente, spp.id as idCliente
            FROM campania c
            INNER JOIN pregunta_campania pc ON (c.id = pc.campania)
            INNER JOIN pregunta_predefinida pp ON (pc.pregunta_predefinida = pp.id)
            INNER JOIN servicio_pregunta_predefinida spp ON (pp.servicio_pregunta_predefinida = spp.id)
            WHERE c.cliente = ? and c.estado_campania = 2
            GROUP BY idCliente ORDER BY camp desc LIMIT 3;

        `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json({ rows, rowTotal });
        // console.log(res);
      } else {
        res.status(404).json("No se han encontrado servicios activos");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get campañas activas");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// Para calcular porcentaje de progreso de una campañia (Vista cliente "clientes/campanias")

router.get("/campanias-barra-progreso", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
          SELECT (c.nombre) as nombre_campania,
          (SELECT COUNT(mi2.id)
          FROM mision as mi2 
          WHERE mi2.campania = c.id) as total_misiones,
          (SELECT COUNT(distinct mi.id) 
          FROM mision as mi 
          INNER JOIN campania as c ON c.id = mi.campania
          INNER JOIN cliente as cli ON cli.id = c.cliente
          WHERE mi.estado_mision = 5
          ) as cantidad_misiones_finalizadas,
          (c.id) as id_campania
          FROM retail.campania as c
          INNER JOIN estado_campania as ec ON ec.id = c.estado_campania
          WHERE 
          c.estado_campania = 2
          and c.cliente = ?
          LIMIT 1
      `,
        [cabecera.client_id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado campañas activas");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get misiones en revision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// Tabla Misiones disponibles

router.get("/table/misiones-disponibles/", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  let queryBuscar = "";

  var page = req.query.page ? Number(req.query.page) : 1;
  if (page < 1) {
    page = 1;
  }
  var resultsPerPage = 10;
  var start = (page - 1) * resultsPerPage;

  var orderBy = req.query.orderBy ? req.query.orderBy : "idCampania";
  var orderType = ["asc", "desc"].includes(req.query.orderType)
    ? req.query.orderType
    : "desc";
  var estado = req.query.estado ? req.query.estado : "1";
  var queryOrderBy = `${orderBy} ${orderType}`;

  // if (buscar) {
  //   buscar = '%' + buscar + '%';
  //   if (cabecera.role === 'client') {
  //     queryBuscar = `and (activity.id like '${buscar}' or CONCAT('#D',activity.id) like '${buscar}' or transaction.id like '${buscar}' or CONCAT('#TX',transaction.id) like '${buscar}' or DATE_FORMAT(transaction.date, '%d/%m/%Y') like '${buscar}' or DATE_FORMAT(transaction.date, '%T') like '${buscar}' or transaction.usd_amount like '${buscar}' or country_origin.name like '${buscar}' or country_destiny.name like '${buscar}' or entity_payer.document_number like '${buscar}' or entity_beneficiary.document_number like '${buscar}' or payment_method.name like '${buscar}' or status.name like '${buscar}')`;
  //   }
  // }
  if (cabecera.rol === "admin") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `

        SELECT CONCAT('#M', m.id) as idMision, CONCAT('#CC', m.campania) as idCamp,
          c.nombre as cliente,
          '' as tipoMision, m.fecha_finalizacion as fechaFin,
          (SELECT em.nombre FROM estado_mision em WHERE em.id = m.estado_mision) as estado

          FROM mision m
          INNER JOIN campania cc ON (m.campania = cc.id)
          INNER JOIN cliente c ON (cc.cliente = c.id)
          WHERE m.estado_mision = ? and cc.estado_campania = 2
          LIMIT ?, ?
            `,
        [estado, start, resultsPerPage]
      );

      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
          SELECT COUNT(*) as count
          FROM mision m
          INNER JOIN campania cc ON (m.campania = cc.id)
          INNER JOIN cliente c ON (cc.cliente = c.id)
          WHERE m.estado_mision = ? and cc.estado_campania = 2
          `,
          [estado]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        console.log(rows);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
        console.log(rows);
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else if (cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT CONCAT('#M', m.id) as idMision, CONCAT('#CC', m.campania) as idCamp,
          c.nombre as cliente,
          '' as tipoMision, m.fecha_finalizacion as fechaFin,
          (SELECT em.nombre FROM estado_mision em WHERE em.id = m.estado_mision) as estado

          FROM mision m
          INNER JOIN campania cc ON (m.campania = cc.id)
          INNER JOIN cliente c ON (cc.cliente = c.id)
          WHERE c.id = ? and m.estado_mision = ? and cc.estado_campania = 2
          LIMIT ?, ?
            `,
        [cabecera.client_id, estado, start, resultsPerPage]
      );
      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
          SELECT COUNT(*) as count
          FROM mision m
          INNER JOIN campania cc ON (m.campania = cc.id)
          INNER JOIN cliente c ON (cc.cliente = c.id)
          WHERE c.id = ? and m.estado_mision = ? and cc.estado_campania = 2
          `,
          [cabecera.client_id, estado]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/datos-perfil", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT CONCAT('#PER',id) as id, nombre as nombre, '' as contrasenia, '' as fecha_nacimiento, email, '' as telefono, rol
        FROM usuario
        WHERE id = ?
    `,
        [cabecera.id]
      );

      if (rows.length > 0) {
        res.status(200).json(rows[0]);
      } else {
        res.status(404).json("No se han encontrado datos del usuario");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get datos del usuario");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

const csv = require("csv-parser");
const fastcsv = require("fast-csv");

const storageCSV = multer.memoryStorage();

var uploadCSV = multer({ storage: storageCSV }).single("archivo");

router.post("/csv/:id", uploadCSV, verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;
  let errors = [];

  // if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    try {
      if (req.file) {
        let dataComercios = [];
        console.log(req.file);
        const codNoInsert = [];

        const buffer = req.file.buffer;

        // Convertir el buffer a una cadena
        const csvString = buffer.toString("utf-8");

        // Parsear el CSV desde una cadena
        const parser = csv({ separator: ";", headers: false, skipLines: 1 });

        parser.write(csvString);
        parser.end();

        parser
          .on("data", (row) => {
            // console.log(row);
            if (row["1"] != "") {
              let codigo = row["1"].trim();
              let nombre = row["2"].trim();
              let tipo_comercio = row["21"] ? row["21"].trim() : null;
              let telefono = row["13"].trim();
              let calle = row["14"].trim();
              let numero = row["15"].trim();
              let categoria = row["10"] ? row["10"].trim() : null;
              let localidad = row["11"].trim();
              let provincia = row["12"].trim();
              let pais = "ARGENTINA";
              let entre_1 = row["16"].trim();
              let entre_2 = row["17"].trim();
              let lon = row["19"].trim();
              let lat = row["18"].trim();

              lon = lon.replace("'", "").replace(",", ".");
              lat = lat.replace("'", "").replace(",", ".");

              let rango_horario = row["22"] ? row["22"].trim() : null;
              let rango_horario2 = row["23"] ? row["23"].trim() : null;
              let variacion_transacciones = row["6"].trim();
              let prioridad_visita = row["24"] ? row["24"].trim() : null;

              let gestor = row["8"].trim();
              let status = "Alarma";
              let semana_alarma = row["3"] ? row["3"].trim() : null;

              let asignada_a_id = row["20"].trim();

              // console.log("cuit: ", cuit, " numero: ", numero, " nombre: ", nombre);
              let dataComercio = {
                [codigo]: {
                  nombre,
                  codigo,
                  tipo_comercio,
                  telefono,
                  calle,
                  numero,
                  localidad,
                  provincia,
                  pais,
                  entre_1,
                  entre_2,
                  lon,
                  lat,
                  gestor,
                  status,
                  semana_alarma,
                  asignada_a_id,
                  rango_horario,
                  rango_horario2,
                  categoria,
                  variacion_transacciones,
                  prioridad_visita,
                },
              };
              dataComercios.push(dataComercio);
              // console.log(dataComercio);
            }
          })
          .on("end", async () => {
            // console.log(dataComercios);

            let codigoString = dataComercios
              .map((obj) => Object.keys(obj)[0])
              .join(",");
            // console.log('CODIGO: ', codigoString);

            const [rows] = await mysqlConnection.promise().execute(
              `
              SELECT codigo, id
              FROM comercio
              WHERE cliente = ?
              and codigo IN (${codigoString})
          `,
              [cabecera.client_id]
            );

            // console.log(rows);

            // Create a Set to keep track of unique 'codigo' values
            const uniqueCodigos = new Set();

            // Filter out duplicate rows based on 'codigo'
            for (const row of rows) {
              if (uniqueCodigos.has(row.codigo)) {
                // Skip duplicates
                continue;
              } else {
                uniqueCodigos.add(row.codigo);

                // Reviso si el codigo comercio tiene una mision asignada

                const [existeMision] = await mysqlConnection.promise().execute(
                  `
                  SELECT * FROM mision m
                  INNER JOIN comercio co ON (m.comercio = co.id)
                  WHERE m.estado_mision = 1 and m.campania = ? and co.codigo = ? and co.cliente = ?
              `,
                  [idCampania, row.codigo, cabecera.client_id]
                );

                const comercioData = dataComercios.find(
                  (data) => Object.keys(data)[0] === row.codigo
                );

                if (comercioData) {
                  if (
                    comercioData[row.codigo].lon !== "" &&
                    comercioData[row.codigo].lat !== ""
                  ) {
                    let lon = comercioData[row.codigo].lon;
                    let lat = comercioData[row.codigo].lat;

                    let coordenadas = `POINT(${lon} ${lat})`;

                    const [rows] = await mysqlConnection
                      .promise()
                      .execute(
                        "UPDATE comercio SET nombre = ?, tipo_comercio = ?, telefono = ?, calle = ?, numero = ?, localidad = ?, provincia = ?, pais = ?, coordenadas = ST_GeomFromText(?), entre_1 = ?, entre_2 = ?, rango_horario = ?, rango_horario2 = ?, categoria = ? WHERE codigo = ? and cliente = ?",
                        [
                          comercioData[row.codigo].nombre,
                          comercioData[row.codigo].tipo_comercio,
                          comercioData[row.codigo].telefono,
                          comercioData[row.codigo].calle,
                          comercioData[row.codigo].numero,
                          comercioData[row.codigo].localidad,
                          comercioData[row.codigo].provincia,
                          comercioData[row.codigo].pais,
                          coordenadas,
                          comercioData[row.codigo].entre_1,
                          comercioData[row.codigo].entre_2,
                          comercioData[row.codigo].rango_horario,
                          comercioData[row.codigo].rango_horario2,
                          comercioData[row.codigo].categoria,
                          comercioData[row.codigo].codigo,
                          cabecera.client_id,
                        ]
                      );
                  } else {
                    errors.push(
                      "No ingreso coordenadas del comercio codigo: " +
                      row.codigo
                    );
                  }

                  if (existeMision.length > 0) {
                    //Ya existe una mision activa para el comercio que se quiere cargar
                    // Skip
                  } else {
                    //No existe una mision activa para el comercio

                    try {
                      const [mision_array] = await mysqlConnection
                        .promise()
                        .execute(
                          `
                        INSERT INTO mision (campania, comercio, estado_mision, precio, puntos, asignada_a_id, variacion_transacciones, prioridad_visita)
                        VALUES (?, ?, '1', '1', '1', ?, ?, ?)
                      `,
                          [
                            idCampania,
                            row.id,
                            comercioData[row.codigo].asignada_a_id,
                            comercioData[row.codigo].variacion_transacciones,
                            comercioData[row.codigo].prioridad_visita,
                          ]
                        );

                      const [comercio_detalle_array] = await mysqlConnection
                        .promise()
                        .execute(
                          `
                            INSERT INTO comercio_detalle (comercio_id, mision_id, gestor, status, semana_de_alarma)
                            VALUES (?, ?, ?, ?, ?)
                          `,
                          [
                            row.id,
                            mision_array.insertId,
                            comercioData[row.codigo].gestor,
                            comercioData[row.codigo].status,
                            comercioData[row.codigo].semana_alarma,
                          ]
                        );
                    } catch (error) {
                      errors.push(
                        "Error al generar comercio_detalle del comercio codigo: " +
                        row.codigo
                      );
                      console.log(error);
                    }
                  }
                } else {
                  console.log("Error para el id: ", row.id);
                  console.log("Error para el codigo: ", row.codigo);
                }
              }
            }

            // console.log(uniqueRows);

            // console.log(rows);

            // Filtrar dataComercios eliminando los elementos que ya existen en la base de datos
            dataComercios = dataComercios.filter(
              (item) => !rows.some((row) => Object.keys(item)[0] === row.codigo)
            );

            // console.log('Nuevos datos a procesar:', dataComercios);

            if (dataComercios) {
              for (let i = 0; i < dataComercios.length; i++) {
                const comercio = dataComercios[i];
                const claves = Object.keys(comercio); // Obtiene todas las claves del objeto

                let codigo = comercio[claves[0]].codigo;

                if (
                  comercio[claves[0]].lon !== "" &&
                  comercio[claves[0]].lat !== ""
                ) {
                  let nombre = comercio[claves[0]].nombre;
                  let tipo_comercio = comercio[claves[0]].tipo_comercio;
                  let telefono = comercio[claves[0]].telefono;
                  let calle = comercio[claves[0]].calle;
                  let numero = comercio[claves[0]].numero;
                  let localidad = comercio[claves[0]].localidad;
                  let provincia = comercio[claves[0]].provincia;
                  let pais = comercio[claves[0]].pais;
                  let lon = comercio[claves[0]].lon;
                  let lat = comercio[claves[0]].lat;

                  let coordenadas = `POINT(${lon} ${lat})`;

                  let entre_1 = comercio[claves[0]].entre_1;
                  let entre_2 = comercio[claves[0]].entre_2;

                  let gestor = comercio[claves[0]].gestor;
                  let status = comercio[claves[0]].status;
                  let semana_alarma = comercio[claves[0]].semana_alarma;

                  let rango_horario = comercio[claves[0]].rango_horario;
                  let rango_horario2 = comercio[claves[0]].rango_horario2;
                  let categoria = comercio[claves[0]].categoria;

                  let asignada_a_id = comercio[claves[0]].asignada_a_id;
                  let variacion_transacciones =
                    comercio[claves[0]].variacion_transacciones;
                  let prioridad_visita = comercio[claves[0]].prioridad_visita;

                  try {
                    const [comercio_array] = await mysqlConnection
                      .promise()
                      .execute(
                        `
                        INSERT INTO comercio (cliente, nombre, tipo_comercio, telefono, calle, numero, localidad, provincia, pais, coordenadas, codigo, entre_1, entre_2, rango_horario, rango_horario2, categoria)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?), ?, ?, ?, ?, ?, ?)
                      `,

                        [
                          cabecera.client_id,
                          nombre,
                          tipo_comercio,
                          telefono,
                          calle,
                          numero,
                          localidad,
                          provincia,
                          pais,
                          coordenadas,
                          codigo,
                          entre_1,
                          entre_2,
                          rango_horario,
                          rango_horario2,
                          categoria,
                        ]
                      );

                    try {
                      const [mision_array] = await mysqlConnection
                        .promise()
                        .execute(
                          `
                            INSERT INTO mision (campania, comercio, estado_mision, precio, puntos, asignada_a_id, variacion_transacciones, prioridad_visita)
                            VALUES (?, ?, '1', '1', '1', ?, ?, ?)
                          `,

                          [
                            idCampania,
                            comercio_array.insertId,
                            asignada_a_id,
                            variacion_transacciones,
                            prioridad_visita,
                          ]
                        );

                      try {
                        const [comercio_detalle_array] = await mysqlConnection
                          .promise()
                          .execute(
                            `
                                INSERT INTO comercio_detalle (comercio_id, mision_id, gestor, status, semana_de_alarma)
                                VALUES (?, ?, ?, ?, ?)
                              `,

                            [
                              comercio_array.insertId,
                              mision_array.insertId,
                              gestor,
                              status,
                              semana_alarma,
                            ]
                          );
                      } catch (error) {
                        console.log(error);
                        errors.push(
                          "Error al generar comercio_detalle del comercio codigo: " +
                          codigo
                        );
                      }
                    } catch (error) {
                      console.log(error);
                      errors.push(
                        "Error al generar misión del comercio codigo: " + codigo
                      );
                    }
                  } catch (error) {
                    console.log(error);
                    errors.push(
                      "Error al insertar nuevo comercio del comercio codigo: " +
                      codigo
                    );
                  }
                } else {
                  errors.push(
                    "No ingreso coordenadas del comercio codigo: " + codigo
                  );
                }
              }
            }

            console.log("Errores: ", errors);

            if (errors.length === 0) {
              return res.status(200).json("Tengo el archivo");
            } else {
              return res.status(200).json(errors);
            }
          });
      } else {
        return res.status(400).json("no hay archivo");
      }
    } catch (error) {
      console.log(error);
      res.status(500).send(errors);
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

// const createCsvStringifier = require('csv-writer').createObjectCsvStringifier;

router.get("/mision/download-csv-viejo", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      const from_date = req.query.from_date || "1970-01-01";
      const to_date = req.query.to_date || "2100-01-01";
      const idCampania = req.query.id_campania;
      console.log(
        "download CSV mision from_date: " + from_date + " to_date: " + to_date
      );

      const [rows] = await mysqlConnection.promise().query(
        `SELECT c.codigo, 
        c.nombre, 
            cd.gestor as gestor,
            cd.status as status, 
            cd.semana_de_alarma as semana_de_alarma, 
            WEEK(md.fecha_realizacion)+1 as semana_de_visita,
            c.calle, 
            c.numero, 
            c.entre_1, 
            c.entre_2, 
            c.localidad, 
            c.provincia, 
            DATE_FORMAT(md.fecha_realizacion, '%Y-%m-%d %H:%i:%s') as fecha_finalizacion,
            DATE_FORMAT(mdrs.fecha_creacion, '%Y-%m-%d %H:%i:%s') as fecha_respuesta,
            camp.id as id_campania, 
            m.id as id_mision, 
            pc.id as id_pregunta, 
            pc.pregunta, 
            COALESCE(mdrs.respuesta_texto, mdrs.respuesta_numero, mdrs.respuesta_si_no, pcr.respuesta, fmd.archivo) as respuesta,
            md.ditor as id_usuario_visita
    FROM
      campania as camp
    INNER JOIN
      mision as m ON m.campania = camp.id
    INNER JOIN
      comercio as c ON m.comercio = c.id
    INNER JOIN
      comercio_detalle as cd ON cd.comercio_id = c.id and m.id = cd.mision_id
    INNER JOIN
      mision_ditor as md ON md.mision = m.id
    INNER JOIN
      pregunta_campania as pc ON pc.campania = camp.id
    LEFT JOIN
      mision_ditor_respuesta_simple as mdrs ON mdrs.mision_ditor = md.id AND mdrs.pregunta_campania = pc.id
    LEFT JOIN
      fotos_mision_ditor as fmd ON fmd.mision_ditor = md.id AND fmd.pregunta_campania = pc.id
    LEFT JOIN
      mision_ditor_respuesta_multiple as mdrm ON mdrm.mision_ditor_respuesta_simple = mdrs.id
      LEFT JOIN
      pregunta_campania_respuesta as pcr ON mdrm.pregunta_campania_respuesta = pcr.id
    WHERE 
    -- campania 6 (alarmas)
    camp.id = ? 
    -- la mision debe estar Asignada, En revisión o Completada
    and (m.estado_mision IN (3,4,5))
    -- ignoro mision de prueba
    and m.id != 309
    -- solo trae las misiones que se hicieron en la semana actual
    AND DATE(md.fecha_realizacion) >= ? AND DATE(md.fecha_realizacion) <= ?
    ORDER BY md.fecha_realizacion, pc.id, c.codigo`,
        [idCampania, from_date, to_date]
      );
      // WHERE CONVERT_TZ(dt.creation_date, '+00:00', 'America/Los_Angeles') >= ? AND CONVERT_TZ(dt.creation_date, '+00:00', 'America/Los_Angeles') < DATE_ADD(?, INTERVAL 1 DAY)

      var headers_array = [
        { id: "codigo", title: "Codigo" },
        { id: "nombre", title: "Nombre" },
        { id: "gestor", title: "Gestor" },
        { id: "status", title: "Status" },
        { id: "semana_de_alarma", title: "Semana de Alarma" },
        { id: "semana_de_visita", title: "Semana de Visita" },
        { id: "calle", title: "Calle" },
        { id: "numero", title: "Numero" },
        { id: "entre_1", title: "Entre 1" },
        { id: "entre_2", title: "Entre 2" },
        { id: "localidad", title: "Localidad" },
        { id: "provincia", title: "Provincia" },
        { id: "fecha_finalizacion", title: "Fecha Finalizacion" },
        { id: "fecha_respuesta", title: "Fecha Respuesta" },
        { id: "id_campania", title: "ID Campania" },
        { id: "id_mision", title: "ID Mision" },
        { id: "id_pregunta", title: "ID Pregunta" },
        { id: "pregunta", title: "Pregunta" },
        { id: "respuesta", title: "Respuesta" },
        { id: "id_usuario_visita", title: "ID Usuario Visita" },
      ];

      const csvStringifier = createCsvStringifier({
        header: headers_array,
        fieldDelimiter: ";",
      });

      let csvData = csvStringifier.getHeaderString();
      csvData += csvStringifier.stringifyRecords(rows);

      res.setHeader(
        "Content-disposition",
        "attachment; filename=results-beneficiary-form.csv"
      );
      res.setHeader("Content-type", "text/csv; charset=utf-8");
      res.send(csvData);
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  }
});

const createCsvStringifier = require("csv-writer").createObjectCsvStringifier;

// Función para eliminar acentos y caracteres especiales
const eliminarAcentos = (cadena) => {
  return String(cadena)
    .replace(/Á|À|Â|Ä/g, "A")
    .replace(/á|à|â|ä/g, "a")
    .replace(/É|È|Ê|Ë/g, "E")
    .replace(/é|è|ê|ë/g, "e")
    .replace(/Í|Ì|Ï|Î/g, "I")
    .replace(/í|ì|ï|î/g, "i")
    .replace(/Ó|Ò|Ö|Ô/g, "O")
    .replace(/ó|ò|ö|ô/g, "o")
    .replace(/Ú|Ù|Û|Ü/g, "U")
    .replace(/ú|ù|ü|û/g, "u")
    .replace(/Ñ/g, "N")
    .replace(/ñ/g, "n")
    .replace(/Ç/g, "C")
    .replace(/ç/g, "c")
    .replace(/¿/g, "");
};

router.get("/mision/download-csv", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    try {
      const from_date = req.query.from_date || "1970-01-01";
      const to_date = req.query.to_date || "2100-01-01";
      const idCampania = req.query.id_campania;
      console.log(
        "download CSV mision from_date: " + from_date + " to_date: " + to_date
      );

      const [rows] = await mysqlConnection.promise().query(
        `SELECT c.codigo, 
        c.nombre, 
            cd.gestor as gestor,
            cd.status as status, 
            cd.semana_de_alarma as semana_de_alarma, 
            WEEK(md.fecha_realizacion)+1 as semana_de_visita,
            c.calle, 
            c.numero, 
            c.entre_1, 
            c.entre_2, 
            c.localidad, 
            c.provincia, 
            DATE_FORMAT(md.fecha_realizacion, '%Y-%m-%d %H:%i:%s') as fecha_finalizacion,
            camp.id as id_campania, 
            m.id as id_mision, 
            pc.id as id_pregunta, 
            pc.pregunta, 
            COALESCE(mdrs.respuesta_texto, mdrs.respuesta_numero, mdrs.respuesta_si_no, pcr.respuesta, fmd.archivo) as respuesta,
            md.ditor as id_usuario_visita
    FROM
      campania as camp
    INNER JOIN
      mision as m ON m.campania = camp.id
    INNER JOIN
      comercio as c ON m.comercio = c.id
    INNER JOIN
      comercio_detalle as cd ON cd.comercio_id = c.id and m.id = cd.mision_id
    INNER JOIN
      mision_ditor as md ON md.mision = m.id
    INNER JOIN
      pregunta_campania as pc ON pc.campania = camp.id
    LEFT JOIN
      mision_ditor_respuesta_simple as mdrs ON mdrs.mision_ditor = md.id AND mdrs.pregunta_campania = pc.id
    LEFT JOIN
      fotos_mision_ditor as fmd ON fmd.mision_ditor = md.id AND fmd.pregunta_campania = pc.id
    LEFT JOIN
      mision_ditor_respuesta_multiple as mdrm ON mdrm.mision_ditor_respuesta_simple = mdrs.id
      LEFT JOIN
      pregunta_campania_respuesta as pcr ON mdrm.pregunta_campania_respuesta = pcr.id
    WHERE 
    -- campania 6 (alarmas)
    camp.id = ? 
    -- la mision debe estar Asignada, En revisión o Completada
    and (m.estado_mision IN (3,4,5))
    -- ignoro mision de prueba
    and m.id != 309
    -- solo trae las misiones que se hicieron en la semana actual
    AND DATE(md.fecha_realizacion) >= ? AND DATE(md.fecha_realizacion) <= ?
    ORDER BY md.fecha_realizacion, pc.id, c.codigo`,
        [idCampania, from_date, to_date]
      );

      // Paso 2: Agrupa y pivotear los datos
      const groupedData = {};
      rows.forEach((row) => {
        const key = row.id_mision;

        if (!groupedData[key]) {
          groupedData[key] = {
            codigo: row.codigo,
            nombre: row.nombre,
            gestor: row.gestor,
            status: row.status,
            semana_de_alarma: row.semana_de_alarma,
            semana_de_visita: row.semana_de_visita,
            calle: row.calle,
            numero: row.numero,
            entre_1: row.entre_1,
            entre_2: row.entre_2,
            localidad: row.localidad,
            provincia: row.provincia,
            fecha_finalizacion: row.fecha_finalizacion,
            id_campania: row.id_campania,
            id_mision: row.id_mision,
            id_usuario_visita: row.id_usuario_visita,
            preguntas: {},
          };
        }

        // Almacenar la respuesta de la pregunta en la misión correspondiente
        if (!groupedData[key].preguntas[row.id_pregunta]) {
          groupedData[key].preguntas[row.id_pregunta] = [];
        }
        groupedData[key].preguntas[row.id_pregunta].push(row.respuesta || "");
      });

      // Crear un objeto de mapeo de ID de pregunta a texto de pregunta
      const questionMap = {};
      rows.forEach((row) => {
        questionMap[row.id_pregunta] = row.pregunta;
      });

      const headers_array = [
        { id: "codigo", title: "Codigo" },
        { id: "nombre", title: "Nombre" },
        { id: "gestor", title: "Gestor" },
        { id: "status", title: "Status" },
        { id: "semana_de_alarma", title: "Semana de Alarma" },
        { id: "semana_de_visita", title: "Semana de Visita" },
        { id: "calle", title: "Calle" },
        { id: "numero", title: "Numero" },
        { id: "entre_1", title: "Entre 1" },
        { id: "entre_2", title: "Entre 2" },
        { id: "localidad", title: "Localidad" },
        { id: "provincia", title: "Provincia" },
        { id: "fecha_finalizacion", title: "Fecha Finalizacion" },
        { id: "id_campania", title: "ID Campania" },
        { id: "id_mision", title: "ID Mision" },
        { id: "id_usuario_visita", title: "ID Usuario Visita" },
      ];

      // Agregar todas las preguntas como columnas
      Object.keys(questionMap).forEach((questionId) => {
        const questionText = eliminarAcentos(questionMap[questionId]);
        headers_array.push({ id: questionId, title: questionText });
      });

      const csvData = [];

      // Crear los registros CSV a partir de groupedData
      Object.values(groupedData).forEach((mission) => {
        const record = {
          codigo: eliminarAcentos(mission.codigo),
          nombre: eliminarAcentos(mission.nombre),
          gestor: eliminarAcentos(mission.gestor),
          status: eliminarAcentos(mission.status),
          semana_de_alarma: eliminarAcentos(mission.semana_de_alarma),
          semana_de_visita: eliminarAcentos(mission.semana_de_visita),
          calle: eliminarAcentos(mission.calle),
          numero: eliminarAcentos(mission.numero),
          entre_1: eliminarAcentos(mission.entre_1),
          entre_2: eliminarAcentos(mission.entre_2),
          localidad: eliminarAcentos(mission.localidad),
          provincia: eliminarAcentos(mission.provincia),
          fecha_finalizacion: eliminarAcentos(mission.fecha_finalizacion),
          id_campania: eliminarAcentos(mission.id_campania),
          id_mision: eliminarAcentos(mission.id_mision),
          id_usuario_visita: eliminarAcentos(mission.id_usuario_visita),
        };

        // Agregar respuestas de preguntas a cada registro
        Object.keys(questionMap).forEach((questionId) => {
          const questionText = eliminarAcentos(questionMap[questionId]);
          record[questionId] = eliminarAcentos(
            (mission.preguntas[questionId] || []).join(", ")
          );
        });

        csvData.push(record);
      });

      const csvStringifier = createCsvStringifier({
        header: headers_array,
        fieldDelimiter: ";",
      });

      let csvOutput = csvStringifier.getHeaderString();
      csvOutput += csvStringifier.stringifyRecords(csvData);

      res.setHeader(
        "Content-disposition",
        "attachment; filename=results-beneficiary-form.csv"
      );
      res.setHeader("Content-type", "text/csv; charset=utf-8");
      res.send(csvOutput);
    } catch (err) {
      console.log(err);
      res.status(500).json("Internal server error");
    }
  }
});

router.get(
  "/crear-campania/misiones/download-csv",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
      try {
        const headers_array = [
          { id: "ID", title: "ID" },
          { id: "Codigo", title: "Codigo" },
          { id: "Nombre", title: "Nombre" },
          { id: "Semana_alarma", title: "Semana_alarma" },
          { id: "Trx Semanal", title: "Trx Semanal" },
          { id: "Distancia Al Promedio", title: "Distancia Al Promedio" },
          { id: "Var % Caida", title: "Var % Caida" },
          { id: "Minimo Aceptable", title: "Minimo Aceptable" },
          { id: "Gestor", title: "Gestor" },
          { id: "Sub Gestor", title: "Sub Gestor" },
          { id: "Categoria", title: "Categoria" },
          { id: "LOCALIDAD", title: "LOCALIDAD" },
          { id: "PROVINCIA", title: "PROVINCIA" },
          { id: "TELEFONO", title: "TELEFONO" },
          { id: "CALLE", title: "CALLE" },
          { id: "NUMERO", title: "NUMERO" },
          { id: "ENTRE_1", title: "ENTRE_1" },
          { id: "ENTRE_2", title: "ENTRE_2" },
          { id: "Latitud", title: "Latitud" },
          { id: "Longitud", title: "Longitud" },
          { id: "Asignada_a", title: "Asignada_a" },
          { id: "Rubro", title: "Rubro" },
          { id: "Rango Horario", title: "Rango Horario" },
          { id: "Rango Horario2", title: "Rango Horario2" },
          { id: "Prioridad de Visita", title: "Prioridad de Visita" },
        ];

        const csvData = [];

        const csvStringifier = createCsvStringifier({
          header: headers_array,
          fieldDelimiter: ";",
        });

        let csvOutput = csvStringifier.getHeaderString();
        csvOutput += csvStringifier.stringifyRecords(csvData);

        res.setHeader(
          "Content-disposition",
          "attachment; filename=crear-campania-misiones-template.csv"
        );
        res.setHeader("Content-type", "text/csv; charset=utf-8");
        res.send(csvOutput);
      } catch (err) {
        console.log(err);
        res.status(500).json("Internal server error");
      }
    }
  }
);

router.post(
  "/comercio-sugerido/download-csv",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    // console.log("HOLA");
    if (cabecera.rol === "cliente") {
      let idCliente = cabecera.client_id;
      try {
        // console.log(req.body);
        const filters = req.body;

        let fecha_desde = filters.fecha_desde || "1970-01-01";
        let fecha_hasta = filters.fecha_hasta || "2100-01-01";

        // Convertir a formato ISO y obtener solo la fecha
        if (filters.fecha_desde) {
          fecha_desde = new Date(filters.fecha_desde)
            .toISOString()
            .slice(0, 10);
        }
        if (filters.fecha_hasta) {
          fecha_hasta = new Date(filters.fecha_hasta)
            .toISOString()
            .slice(0, 10);
        }

        var query_fecha_desde = "";
        if (filters.fecha_desde) {
          query_fecha_desde =
            "AND comercio_sugerido.fecha_de_sugerencia >= '" +
            fecha_desde +
            "'";
        }
        var query_fecha_hasta = "";
        if (filters.fecha_hasta) {
          query_fecha_hasta =
            "AND comercio_sugerido.fecha_de_sugerencia < DATE_ADD('" +
            fecha_hasta +
            "', INTERVAL 1 DAY)";
        }
        const [rows] = await mysqlConnection.promise().query(
          `SELECT
              (SELECT nombre FROM usuario WHERE id = sugerido_por_znapper) as nombre_znapper,
              sugerido_por_znapper as id_znapper,
              nombre_comercio,
              direccion,
              tipo_comercio,
              horario_visita,
              CONCAT(nombre_contacto, ' ', apellido_contacto) as contacto_comercio,
              telefono,
              mail,
              ST_Y(coordenadas) AS latitud, 
              ST_X(coordenadas) AS longitud, 
              observaciones_generales,
              finalizado,
              foto_frente_comercio,
              DATE_FORMAT(fecha_de_sugerencia, '%Y-%m-%d %H:%i:%s') as fecha_de_sugerencia
          FROM comercio_sugerido
          WHERE cliente = ? 
        ${query_fecha_desde}
        ${query_fecha_hasta}`,
          [idCliente]
        );

        for (let row of rows) {
          if (row.foto_frente_comercio) {
            const getObjectParams = {
              Bucket: bucketName,
              Key: `${row.foto_frente_comercio}`,
              ResponseContentDisposition: `attachment; filename=${row.foto_frente_comercio}.png`,
            };
            const command = new GetObjectCommand(getObjectParams);
            const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            row.foto_frente_comercio = url;
          }
        }

        var headers_array = [
          { id: "nombre_znapper", title: "Nombre Znapper" },
          { id: "id_znapper", title: "Id Znapper" },
          { id: "nombre_comercio", title: "Nombre Comercio" },
          { id: "direccion", title: "Direccion" },
          { id: "tipo_comercio", title: "Tipo Comercio" },
          { id: "horario_visita", title: "Horario de Visita" },
          { id: "contacto_comercio", title: "Contacto Comercio" },
          { id: "telefono", title: "Telefono" },
          { id: "mail", title: "Mail" },
          { id: "latitud", title: "Latitud" },
          { id: "longitud", title: "Longitud" },
          { id: "observaciones_generales", title: "Observaciones Generales" },
          { id: "finalizado", title: "Finalizado" },
          { id: "foto_frente_comercio", title: "Foto" },
          { id: "fecha_de_sugerencia", title: "Fecha Sugerencia" },
        ];

        const csvStringifier = createCsvStringifier({
          header: headers_array,
          fieldDelimiter: ";",
        });

        let csvData = csvStringifier.getHeaderString();
        csvData += csvStringifier.stringifyRecords(rows);

        res.setHeader(
          "Content-disposition",
          "attachment; filename=results-beneficiary-form.csv"
        );
        res.setHeader("Content-type", "text/csv; charset=utf-8");
        res.send(csvData);
      } catch (err) {
        console.log(err);
        res.status(500).json("Internal server error");
      }
    }
  }
);

router.post(
  "/visita_no_programada/download-csv",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    if (cabecera.rol === "cliente") {
      let idCliente = cabecera.client_id;
      try {
        const filters = req.body;

        let fecha_desde = filters.fecha_desde || "1970-01-01";
        let fecha_hasta = filters.fecha_hasta || "2100-01-01";

        // Convertir a formato ISO y obtener solo la fecha
        if (filters.fecha_desde) {
          fecha_desde = new Date(filters.fecha_desde)
            .toISOString()
            .slice(0, 10);
        }
        if (filters.fecha_hasta) {
          fecha_hasta = new Date(filters.fecha_hasta)
            .toISOString()
            .slice(0, 10);
        }

        var query_fecha_desde = "";
        if (filters.fecha_desde) {
          query_fecha_desde =
            "AND  visita_no_programada.fecha_de_visita >= '" +
            fecha_desde +
            "'";
        }
        var query_fecha_hasta = "";
        if (filters.fecha_hasta) {
          query_fecha_hasta =
            "AND  visita_no_programada.fecha_de_visita < DATE_ADD('" +
            fecha_hasta +
            "', INTERVAL 1 DAY)";
        }
        const [rows] = await mysqlConnection.promise().query(
          `SELECT
              (SELECT nombre FROM usuario WHERE id = visitado_por_znapper) as nombre_znapper,
              visitado_por_znapper as id_znapper,
              nombre_comercio,
              direccion,
              id_comercio,
              numero_cliente,
              CONCAT(nombre_contacto, ' ', apellido_contacto) as contacto_comercio,
              telefono,
              mail,
              ST_Y(coordenadas) AS latitud, 
              ST_X(coordenadas) AS longitud, 
              observaciones_generales,
              foto_frente_comercio,
              DATE_FORMAT(fecha_de_visita, '%Y-%m-%d %H:%i:%s') as fecha_de_visita
          FROM visita_no_programada
          WHERE cliente = ?
        ${query_fecha_desde}
        ${query_fecha_hasta}`,
          [idCliente]
        );

        for (let row of rows) {
          if (row.foto_frente_comercio) {
            const getObjectParams = {
              Bucket: bucketName,
              Key: `${row.foto_frente_comercio}`,
              ResponseContentDisposition: `attachment; filename=${row.foto_frente_comercio}.png`,
            };
            const command = new GetObjectCommand(getObjectParams);
            const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            row.foto_frente_comercio = url;
          }
        }

        var headers_array = [
          { id: "nombre_znapper", title: "Nombre Znapper" },
          { id: "id_znapper", title: "Id Znapper" },
          { id: "nombre_comercio", title: "Nombre Comercio" },
          { id: "direccion", title: "Direccion" },
          { id: "id_comercio", title: "ID Comercio" },
          { id: "numero_cliente", title: "Numero Cliente" },
          { id: "contacto_comercio", title: "Contacto Comercio" },
          { id: "telefono", title: "Telefono" },
          { id: "mail", title: "Mail" },
          { id: "latitud", title: "Latitud" },
          { id: "longitud", title: "Longitud" },
          { id: "observaciones_generales", title: "Observaciones Generales" },
          { id: "foto_frente_comercio", title: "Foto" },
          { id: "fecha_de_visita", title: "Fecha_de_Visita" },
        ];

        const csvStringifier = createCsvStringifier({
          header: headers_array,
          fieldDelimiter: ";",
        });

        let csvData = csvStringifier.getHeaderString();
        csvData += csvStringifier.stringifyRecords(rows);

        res.setHeader(
          "Content-disposition",
          "attachment; filename=results-beneficiary-form.csv"
        );
        res.setHeader("Content-type", "text/csv; charset=utf-8");
        res.send(csvData);
      } catch (err) {
        console.log(err);
        res.status(500).json("Internal server error");
      }
    }
  }
);

router.get("/cambiar-estado-mision/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idMision = req.params.id;

  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      var [rows] = await mysqlConnection
        .promise()
        .execute("UPDATE mision SET estado_mision = 5 WHERE id = ?", [
          idMision,
        ]);

      res.status(200).json("Actualizado correctamente");
    } catch (error) {
      console.log(error);
      res.status(500).send("Error al actualizar estado mision");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get("/respuestas-mision/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  const idMision = req.params.id;

  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().query(
        `SELECT c.codigo, 
        c.nombre, 
        cd.gestor, 
            cd.status, 
            cd.semana_de_alarma,
            WEEK(md.fecha_realizacion) as semana_de_visita,
            c.calle, 
            c.numero, 
            c.entre_1, 
            c.entre_2, 
            c.localidad, 
            c.provincia, 
            DATE_FORMAT(md.fecha_realizacion, '%Y-%m-%d %H:%i:%s') as fecha_finalizacion,
            DATE_FORMAT(mdrs.fecha_creacion, '%Y-%m-%d %H:%i:%s') as fecha_respuesta,
            camp.id as id_campania, 
            m.id as id_mision, 
            pc.id as id_pregunta, 
            pc.pregunta, 
            COALESCE(mdrs.respuesta_texto, mdrs.respuesta_numero, mdrs.respuesta_si_no, pcr.respuesta, fmd.archivo) as respuesta
    FROM
      campania as camp
    INNER JOIN
      mision as m ON m.campania = camp.id
    INNER JOIN
    comercio as c ON m.comercio = c.id
    INNER JOIN
    comercio_detalle as cd ON cd.comercio_id = c.id and m.id = cd.mision_id
    INNER JOIN
      mision_ditor as md ON md.mision = m.id
    INNER JOIN
      pregunta_campania as pc ON pc.campania = camp.id
    LEFT JOIN
      mision_ditor_respuesta_simple as mdrs ON mdrs.mision_ditor = md.id AND mdrs.pregunta_campania = pc.id
    LEFT JOIN
      fotos_mision_ditor as fmd ON fmd.mision_ditor = md.id AND fmd.pregunta_campania = pc.id
    LEFT JOIN
      mision_ditor_respuesta_multiple as mdrm ON mdrm.mision_ditor_respuesta_simple = mdrs.id
      LEFT JOIN
      pregunta_campania_respuesta as pcr ON mdrm.pregunta_campania_respuesta = pcr.id
    WHERE 
    m.id = ?
    -- solo trae las misiones que se hicieron en la semana actual
    ORDER BY md.fecha_realizacion, pc.id, c.codigo`,
        [idMision]
      );

      if (rows.length > 0) {
        res.status(200).json(rows);
      } else {
        res.status(404).json("No se han encontrado datos del usuario");
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get datos del usuario");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.get(
  "/misiones-realizadas-asignadas/:idCampania",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    const idCampania = req.params.idCampania;

    if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
      try {
        const [rows] = await mysqlConnection.promise().query(
          `SELECT (SELECT count(distinct asignada_a_id) as znappers_hoy FROM retail.mision WHERE estado_mision = 5 and DATE(fecha_modificacion) = DATE(NOW()) and asignada_a_id != 0 and campania = ?) as znappers_hoy,
        (SELECT count(distinct asignada_a_id) as znappers_asignados FROM retail.mision WHERE estado_mision = 1 and asignada_a_id != 0 and campania = ?) as znappers_asignados`,
          [idCampania, idCampania]
        );

        if (rows.length > 0) {
          res.status(200).json(rows[0]);
        } else {
          res.status(404).json("No se han encontrado datos de la campania");
        }
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .send("An error occurred while trying to get datos de la campania");
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  }
);

//! Finaliza revisar

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
//endpoints para la pantalla de campanias

//filtro para la tabla
router.post("/tabla-campanias", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  // console.log("req.query.search", req.query.search);
  let buscar = req.query.search;
  //  console.log("body: ", req.body);
  const filters = req.body;
  const estado_campania = filters.estado;
  const fecha_desde = filters.startDate || "2023-01-01";
  const fecha_hasta = filters.endDate || "2024-12-31";
  let toDate = new Date(fecha_hasta);
  toDate.setDate(toDate.getDate() + 1); // Añade un día a la fecha final
  let queryBuscar = "";
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    var page = req.query.page ? Number(req.query.page) : 1;
    if (page < 1) {
      page = 1;
    }
    var resultsPerPage = 10;
    var start = (page - 1) * resultsPerPage;

    var orderBy = req.query.orderBy ? req.query.orderBy : "id";
    var orderType = ["asc", "desc"].includes(req.query.orderType)
      ? req.query.orderType
      : "desc";
    var queryOrderBy = `${orderBy} ${orderType}`;

    if (buscar) {
      buscar = "%" + buscar + "%";
      queryBuscar = `AND (c.id like '${buscar}' or c.nombre like '${buscar}'  or DATE_FORMAT(c.fecha_inicio, '%d/%m/%Y') like '${buscar}' or DATE_FORMAT(c.fecha_fin, '%d/%m/%Y') like '${buscar}' or c.estado_campania like'${buscar} ')`;
    }
    // console.log("queryBuscar: ", queryBuscar);
    let query = `
      SELECT DATE_FORMAT(c.fecha_inicio, '%d/%m/%Y') as fecha_inicio, 
        c.nombre as nombre, 
        c.id as id, 
        DATE_FORMAT(c.fecha_fin, '%d/%m/%Y') as fecha_fin, 
        (ec.nombre) AS estado
      FROM campania as c
      INNER JOIN estado_campania as ec ON ec.id = c.estado_campania
      WHERE c.cliente = ? ${estado_campania ? `AND ec.nombre = '${estado_campania}'` : ""
      }  ${queryBuscar}
      ORDER BY ${queryOrderBy}
    `;

    const queryParams = [cabecera.client_id];

    if (filters.startDate) {
      query += " AND c.fecha_inicio >= ?";
      queryParams.push(filters.startDate);
    }

    if (filters.endDate) {
      query += " AND c.fecha_fin <= ?";
      queryParams.push(filters.endDate);
    }

    try {
      const [rows] = await mysqlConnection
        .promise()
        .execute(query, queryParams);
      // console.log("rows: ", rows);
      if (rows.length > 0) {
        // console.log("rows length: ", rows.length);
        const numOfResults = rows.length;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
        // console.log(rows)
      } else {
        res.json({
          results: [],
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});
router.post("/table/campanias/misiones", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  // console.log("req.query.search", req.query.search);
  let buscar = req.query.search;
  // console.log("body: ", req.body);

  const filters = req.body;
  const idCampania = filters.idCampania;
  const fecha_desde = filters.startDate || "2010-01-01";
  const fecha_hasta = filters.endDate || "2025-12-31";
  let toDate = new Date(fecha_hasta);
  toDate.setDate(toDate.getDate() + 1); // Añade un día a la fecha final
  let queryBuscar = "";
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    var page = req.query.page ? Number(req.query.page) : 1;
    if (page < 1) {
      page = 1;
    }
    var resultsPerPage = 10;
    var start = (page - 1) * resultsPerPage;

    var orderBy = req.query.orderBy ? req.query.orderBy : "id_mision";
    var orderType = ["asc", "desc"].includes(req.query.orderType)
      ? req.query.orderType
      : "desc";
    if (orderBy === "vencimiento") {
      orderBy = "md.fecha_realizacion";
    } else {
      if (orderBy === "fecha_creacion") {
        orderBy = "m.fecha_creacion";
      }
    }
    var queryOrderBy = `${orderBy} ${orderType}`;
    if (orderBy === "md.fecha_realizacion") {
      orderBy = "vencimiento";
    } else {
      if (orderBy === "m.fecha_creacion") {
        orderBy = "fecha_creacion";
      }
    }
    let estado_mision = "";
    if (filters.estado) {
      estado_mision = filters.estado;
    }

    // console.log(estado_mision);
    if (buscar) {
      buscar = '%' + buscar + '%';
      queryBuscar = `AND (u.nombre like '${buscar}' OR u.apellido like '${buscar}' OR m.id like '${buscar}' or co.nombre like '${buscar}'  or em.nombre like '${buscar}' or m.asignada_a_id like '${buscar}' or m.comercio like '${buscar}' or DATE_FORMAT(m.fecha_creacion, '%d/%m/%Y %T') like '${buscar}' or DATE_FORMAT(md.fecha_realizacion, '%d/%m/%Y %T') like '${buscar}' )`;
    }
    // console.log("queryBuscar: ", queryBuscar);
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
          SELECT DISTINCT 
              co.nombre as nombre_comercio,
              m.comercio as idComercio,
              m.id as id_mision,
              em.nombre as estado,
              m.asignada_a_id as asignada_a,
              IF(md.fecha_realizacion IS NOT NULL, md.ditor, NULL ) as realizado_por,
              DATE_FORMAT(m.fecha_creacion, "%d/%m/%Y %T") as fecha_creacion,
              DATE_FORMAT(md.fecha_realizacion, "%d/%m/%Y %T") as vencimiento,
              u.nombre as nombre,
              u.apellido as apellido
            FROM mision as m
            INNER JOIN comercio as co ON co.id = m.comercio
            INNER JOIN estado_mision as em ON em.id = m.estado_mision
            LEFT JOIN mision_ditor as md ON md.mision = m.id
            LEFT JOIN usuario as u ON u.id = m.asignada_a_id
            WHERE m.campania = ? ${queryBuscar}
              AND m.fecha_creacion >= ?
              AND m.fecha_creacion <= ?
              ${estado_mision ? `AND em.nombre = '${estado_mision}'` : ""}
            ORDER BY ${queryOrderBy}
            LIMIT ?, ?;
    `,
        [idCampania, fecha_desde, fecha_hasta, start, resultsPerPage]
      );
      // console.log("rows: ", rows);
      if (rows.length > 0) {
        // console.log("rows length: ", rows.length);
        const [countRows] = await mysqlConnection.promise().execute(
          `
         SELECT COUNT(*) as count
          FROM mision as m
          INNER JOIN comercio as co ON co.id = m.comercio
          INNER JOIN estado_mision as em ON em.id = m.estado_mision
          LEFT JOIN mision_ditor as md ON md.mision = m.id
          LEFT JOIN usuario as u ON u.id = m.asignada_a_id
          WHERE m.campania = ? ${queryBuscar} AND m.fecha_creacion >= ? AND m.fecha_creacion <= ?  ${estado_mision ? `AND em.nombre = '${estado_mision}'` : ""
          }
        `,
          [idCampania, fecha_desde, fecha_hasta]
        );

        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
        // console.log(rows)
      } else {
        res.json({
          results: rows,
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});
router.get("/estados-campania", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    const [rows] = await mysqlConnection.promise().execute(`
    SELECT (ec.nombre) as nombre
    FROM estado_campania as ec
    `);
    // console.log("estados: ", rows);
    if (rows.length > 0) {
      res.status(200).json(rows);
    } else {
      res.status(404).json("No se han encontrado estados de campania");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});
router.get("/tipos-campania", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    const [rows] = await mysqlConnection.promise().execute(`
    SELECT *
    FROM tipo_campania
    `);
    if (rows.length > 0) {
      res.status(200).json(rows);
    } else {
      res.status(404).json("No se han encontrado tipos de campania");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.get("/estados-misiones", async (req, res) => {
  const [rows] = await mysqlConnection.promise().execute(`
    SELECT (em.nombre) as nombre
    FROM estado_mision as em
    `);
  console.log("estados: ", rows);
  if (rows.length > 0) {
    res.status(200).json(rows);
  } else {
    res.status(404).json("No se han encontrado estados de misiones");
  }
});
router.get("/tabla-misiones", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  if (
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited" ||
    cabecera.rol === "admin"
  ) {
    var page = req.query.page ? Number(req.query.page) : 1;
    if (page < 1) {
      page = 1;
    }
    var resultsPerPage = 10;
    var start = (page - 1) * resultsPerPage;
    var orderBy = req.query.orderBy ? req.query.orderBy : "id";
    var orderType = ["asc", "desc"].includes(req.query.orderType)
      ? req.query.orderType
      : "desc";
    if (orderBy === "fecha_hora") {
      orderBy = "m.fecha_finalizacion";
    } else {
      if (orderBy === "fecha_creacion") {
        orderBy = "m.fecha_creacion";
      }
    }
    var queryOrderBy = `${orderBy} ${orderType}`;
    if (orderBy === "m.fecha_finalizacion") {
      orderBy = "fecha_hora";
    } else {
      if (orderBy === "m.fecha_creacion") {
        orderBy = "fecha_creacion";
      }
    }
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `SELECT  distinct(m.id) as id,
            c.nombre as nombre_comercio,
            ca.nombre as campania,
            u.nombre as realizado_por,
            DATE_FORMAT(m.fecha_creacion, "%d/%m/%Y %T") as fecha_creacion,
            DATE_FORMAT(m.fecha_finalizacion, '%d/%m/%Y %T') as fecha_hora,
            m.asignada_a_id as asignada_a,
            m.estado_mision as estado_mision,
            u.nombre as nombre,
            u.apellido as apellido,
            u.id as id_znapper
        FROM  mision as m
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN usuario as u ON md.ditor = u.id
        INNER JOIN comercio as c ON c.id = m.comercio
        INNER JOIN campania as ca ON ca.id = m.campania
        WHERE m.estado_mision = 5 and ca.cliente = ?
        ORDER BY ${queryOrderBy}
        LIMIT ?, ?
    `,
        [cabecera.client_id, start, resultsPerPage]
      );
      // console.log("misiones:", rows.length);
      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
        SELECT count(*) as count
        FROM  mision as m
        INNER JOIN mision_ditor as md ON md.mision = m.id
        INNER JOIN usuario as u ON md.ditor = u.id
        INNER JOIN comercio as c ON c.id = m.comercio
        INNER JOIN campania as ca ON ca.id = m.campania
        WHERE m.estado_mision = 5 and ca.cliente = ?
          `,
          [cabecera.client_id]
        );
        console.log(countRows[0].count);
        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: [],
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});
router.post("/tabla-comercios", verifyToken, async (req, res) => {
  // console.log(req.data);
  const cabecera = JSON.parse(req.data.data);
  let buscar = req.query.search;
  // console.log("body: ", req.body);

  const filters = req.body;
  const idCampania = filters.idCampania;
  // console.log("idCampania ", idCampania);
  const fecha_desde = filters.startDate || "2010-01-01";
  const fecha_hasta = filters.endDate || "2025-12-31";
  let toDate = new Date(fecha_hasta);
  toDate.setDate(toDate.getDate() + 1); // Añade un día a la fecha final
  let queryBuscar = "";
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    var page = req.query.page ? Number(req.query.page) : 1;
    if (page < 1) {
      page = 1;
    }
    var resultsPerPage = 10;
    var start = (page - 1) * resultsPerPage;
    var orderBy = req.query.orderBy ? req.query.orderBy : "codigo";

    var orderType = ["asc", "desc"].includes(req.query.orderType)
      ? req.query.orderType
      : "desc";
    if (buscar) {
      buscar = "%" + buscar + "%";
      queryBuscar = `AND (c.codigo like '${buscar}' or c.nombre like '${buscar}'  or  c.localidad like '${buscar}' or c.provincia like '${buscar}' or c.calle like '${buscar}' or c.numero like '${buscar}' )`;
    }
    var queryOrderBy = `${orderBy} ${orderType}`;
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        SELECT 
        distinct(c.codigo) as codigo,
        c.id as idComercio,
        c.nombre as nombre_comercio,
        c.localidad as localidad,
        c.provincia as provincia,
        c.calle as calle,
        c.numero as numero
        FROM campania as ca
        INNER JOIN mision as m ON m.campania = ca.id
        INNER JOIN comercio as c ON c.id = m.comercio
        WHERE ca.id = ? ${queryBuscar} AND c.fecha_de_alta >= ? AND c.fecha_de_alta <= ?
        ORDER BY ${queryOrderBy}
        LIMIT ?, ?
      `,
        [idCampania, fecha_desde, fecha_hasta, start, resultsPerPage]
      );
      // console.log("misiones:",rows);
      if (rows.length > 0) {
        const [countRows] = await mysqlConnection.promise().execute(
          `
          SELECT count(*) as count
          FROM campania as ca
          INNER JOIN mision as m ON m.campania = ca.id
          INNER JOIN comercio as c ON c.id = m.comercio
          WHERE ca.id = ? ${queryBuscar} AND c.fecha_de_alta >= ? AND c.fecha_de_alta <= ?
         `,
          [idCampania, fecha_desde, fecha_hasta]
        );
        // console.log("rows length: ", rows.length);
        const numOfResults = countRows[0].count;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: [],
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});
//tabla znappers
router.post("/tabla-znappers", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  var page = req.query.page ? Number(req.query.page) : 1;
  if (page < 1) {
    page = 1;
  }
  var resultsPerPage = 10;
  var start = (page - 1) * resultsPerPage;
  var orderBy = req.query.orderBy ? req.query.orderBy : "id";
  var orderType = ["asc", "desc"].includes(req.query.orderType)
    ? req.query.orderType
    : "desc";
  var queryOrderBy = `${orderBy} ${orderType}`;
  if (cabecera.rol === "cliente") {
    const filters = req.body;

    let fecha_desde = filters.fecha_desde || "1970-01-01";
    let fecha_hasta = filters.fecha_hasta || "2100-01-01";
    let id_campania = filters.idCampania || null;
    // Convertir a formato ISO y obtener solo la fecha
    if (filters.fecha_desde) {
      fecha_desde = new Date(filters.fecha_desde).toISOString().slice(0, 10);
    }
    if (filters.fecha_hasta) {
      fecha_hasta = new Date(filters.fecha_hasta).toISOString().slice(0, 10);
    }

    var query_campania = '';
    if (id_campania != null) {
      query_campania = 'AND c.id =  \'' + id_campania + '\'';
    }

    // Filtros de fecha para cada campo
    var misiones_asignadas_date_filter = '';
    if (filters.fecha_desde) {
      misiones_asignadas_date_filter += ' AND fecha_creacion >= \'' + fecha_desde + '\'';
    }
    if (filters.fecha_hasta) {
      misiones_asignadas_date_filter += ' AND fecha_creacion < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY)';
    }

    var misiones_finalizadas_date_filter = '';
    if (filters.fecha_desde) {
      misiones_finalizadas_date_filter += ' AND fecha_finalizacion >= \'' + fecha_desde + '\'';
    }
    if (filters.fecha_hasta) {
      misiones_finalizadas_date_filter += ' AND fecha_finalizacion < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY)';
    }

    var misiones_canceladas_date_filter = '';
    if (filters.fecha_desde) {
      misiones_canceladas_date_filter += ' AND ((md.fecha_cancelacion_reserva >= \'' + fecha_desde + '\') OR (md.fecha_cancelacion_asignacion >= \'' + fecha_desde + '\'))';
    }
    if (filters.fecha_hasta) {
      misiones_canceladas_date_filter += ' AND ((md.fecha_cancelacion_reserva < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY)) OR (md.fecha_cancelacion_asignacion < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY)))';
    }

    var promedio_demora_date_filter = '';
    if (filters.fecha_desde) {
      promedio_demora_date_filter += ' AND md.fecha_asignacion >= \'' + fecha_desde + '\' AND md.fecha_realizacion >= \'' + fecha_desde + '\'';
    }
    if (filters.fecha_hasta) {
      promedio_demora_date_filter += ' AND md.fecha_asignacion < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY) AND md.fecha_realizacion < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY)';
    }

    var promedio_finalizadas_date_filter = '';
    if (filters.fecha_desde) {
      promedio_finalizadas_date_filter += ' AND fecha_finalizacion >= \'' + fecha_desde + '\'';
    }
    if (filters.fecha_hasta) {
      promedio_finalizadas_date_filter += ' AND fecha_finalizacion < DATE_ADD(\'' + fecha_hasta + '\', INTERVAL 1 DAY)';
    }

    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
          SELECT
          u.id as id,
          u.nombre as nombre,
          u.apellido as apellido,
          (SELECT COUNT(*) FROM mision WHERE asignada_a_id = u.id ${misiones_asignadas_date_filter}) as misiones_asignadas,
          (SELECT COUNT(*) FROM mision WHERE asignada_a_id = u.id AND fecha_finalizacion IS NOT NULL ${misiones_finalizadas_date_filter}) as misiones_finalizadas,
          (SELECT COUNT(DISTINCT(m.id)) FROM mision as m INNER JOIN mision_ditor as md ON md.mision = m.id 
            WHERE m.asignada_a_id = u.id AND (md.fecha_cancelacion_reserva IS NOT NULL OR md.fecha_cancelacion_asignacion IS NOT NULL) ${misiones_canceladas_date_filter}) as misiones_canceladas,
          IFNULL(
              TRIM(TRAILING '.00' FROM ROUND(
                  AVG(CASE 
                      WHEN md.estado_mision_ditor IN (5, 8) AND md.fecha_asignacion IS NOT NULL AND md.fecha_realizacion IS NOT NULL 
                      ${promedio_demora_date_filter}
                      THEN TIMESTAMPDIFF(MINUTE, md.fecha_asignacion, md.fecha_realizacion) 
                  END), 
                  2
              )), 
              0
          ) AS promedio_demora,
          CONCAT(
              TRIM(TRAILING '.00' FROM IFNULL(
                  ROUND(
                      (SELECT (COUNT(*) / (SELECT COUNT(*) FROM mision WHERE asignada_a_id = u.id ${misiones_asignadas_date_filter})) * 100 
                       FROM mision 
                       WHERE asignada_a_id = u.id AND fecha_finalizacion IS NOT NULL ${promedio_finalizadas_date_filter}), 
                      2
                  ), 
                  0
              )), 
              ' %'
          ) AS promedio_finalizadas
          FROM usuario as u
          LEFT JOIN mision_ditor as md ON md.ditor = u.id
          LEFT JOIN mision as m ON m.asignada_a_id = u.id
          ${query_campania ? 'LEFT JOIN campania as c ON c.id = m.campania' : ''}
          WHERE u.cliente = ? AND u.rol = 3 AND u.habilitado = 'Y'
          ${query_campania}
          GROUP BY u.id
          ORDER BY ${queryOrderBy}
        `, [cabecera.client_id]
      );
      if (rows.length > 0) {
        const numOfResults = rows.length;
        const numOfPages = Math.ceil(numOfResults / resultsPerPage);
        res.json({
          results: rows,
          numOfPages: numOfPages,
          totalItems: numOfResults,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      } else {
        res.json({
          results: [],
          numOfPages: 0,
          totalItems: 0,
          page: page - 1,
          orderBy: orderBy,
          orderType: orderType,
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  }
});


//detalle campania
router.get("/campanias/detalle/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    const idCampania = req.params.id;
    const [rows] = await mysqlConnection.promise().execute(
      `
      SELECT 
          c.id, 
          c.nombre, 
          c.fecha_inicio, 
          c.fecha_fin, 
          c.objetivo,
          (ec.nombre) AS estado,
          c.estado_campania as estado_id,
          (tc.nombre) AS tipo,
          c.tipo_campania as tipo_id,
          IF(c.estado_campania = 4, 'Y', 'N') as pausada
      FROM retail.campania as c
      INNER JOIN estado_campania as ec ON ec.id = c.estado_campania
      INNER JOIN tipo_campania as tc ON tc.id = c.tipo_campania
      WHERE c.id = ?
    `,
      [idCampania]
    );
    if (rows.length > 0) {
      res.json(rows[0]);
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/campanias/detalle/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "limited") {
    const idCampania = req.params.id;
    const idCliente = cabecera.client_id;
    const formulario = req.body;
    // console.log("formulario: ", formulario);

    // Convertir las fechas al formato YYYY-MM-DD
    const fechaInicio = new Date(formulario.fecha_inicio)
      .toISOString()
      .split("T")[0];
    const fechaFin = new Date(formulario.fecha_fin).toISOString().split("T")[0];
    try {
      // modificar datos de la campania nombre, fecha_inicio, fecha_fin, objetivo y tipo_campania
      const [rowsModificacion] = await mysqlConnection.promise().query(
        `UPDATE campania
        SET 
            nombre = ?,
            fecha_inicio = ?,
            fecha_fin = ?,
            objetivo = ?,
            tipo_campania = ?
        WHERE 
            id = ? and cliente = ?`,
        [
          formulario.nombre,
          fechaInicio,
          fechaFin,
          formulario.objetivo,
          formulario.tipo_id,
          idCampania,
          idCliente,
        ]
      );

      res.json("Campania modificada correctamente");
    } catch (err) {
      console.log(err);
      res.status(500).json("Error al modificar la campania");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/campanias/pausar/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente") {
    const idCampania = req.params.id;
    const idCliente = cabecera.client_id;
    const pausar = req.body.pausar;

    try {
      let estado = 2;
      if (pausar == "Y") {
        estado = 4;
      }
      const [rowsModificacion] = await mysqlConnection.promise().query(
        `UPDATE campania
        SET 
            estado_campania = ?
        WHERE 
            id = ? and cliente = ?`,
        [estado, idCampania, idCliente]
      );

      res.json("Campania modificada correctamente");
    } catch (err) {
      console.log(err);
      res.status(500).json("Error al modificar la campania");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

router.put("/campanias/eliminar/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (cabecera.rol === "cliente" || cabecera.rol === "admin") {
    const idCampania = req.params.id;
    const idCliente = cabecera.client_id;
    const habilitar = req.body.habilitar;

    try {
      const [rowsModificacion] = await mysqlConnection.promise().query(
        `UPDATE campania
        SET 
            estado_campania = 6
        WHERE 
            id = ? and cliente = ?`,
        [idCampania, idCliente]
      );

      res.json("Campania modificada correctamente");
    } catch (err) {
      console.log(err);
      res.status(500).json("Error al modificar la campania");
    }
  } else {
    res.status(401).json("No autorizado");
  }
});

// get preguntas para el tab
router.get("/campania/preguntas/:id", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const idCampania = req.params.id;
  var results = [];
  // console.log("idCampania: ",req.params);
  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
      SELECT (pc.pregunta) as pregunta,
       (pc.id) as id_pregunta,
		    (pc.obligatoria) as obligatoria,
        (tr.nombre) as tipo_respuesta,
        (pc.cantidad_de_fotos) as cantidad_fotos
      FROM pregunta_campania as pc
      INNER JOIN tipo_respuesta as tr ON tr.id = pc.tipo_respuesta
      WHERE pc.campania = ? AND pc.habilitada = 'Y'
      
      `,
        [idCampania]
      );
      // console.log(rows);
      const [respuestas] = await mysqlConnection.promise().execute(
        `
        SELECT (pc.id) as id_pregunta,
        (pcr.respuesta) as respuesta
        FROM pregunta_campania as pc
        INNER JOIN tipo_respuesta as tr ON tr.id = pc.tipo_respuesta
        INNER JOIN pregunta_campania_respuesta as pcr ON pcr.pregunta_campania = pc.id
        WHERE pc.campania = ? AND pcr.habilitada = 'Y' AND pc.habilitada = 'Y'
        `,
        [idCampania]
      );

      if (rows.length > 0) {
        if (respuestas.length > 0) {
          for (let i = 0; i < rows.length; i++) {
            let preguntaObj = {
              pregunta: rows[i].pregunta,
              tipo_respuesta: rows[i].tipo_respuesta,
              id_pregunta: rows[i].id_pregunta,
              obligatoria: rows[i].obligatoria,
              cantidad_fotos: rows[i].cantidad_fotos,
              respuestas: [],
            };

            for (let j = 0; j < respuestas.length; j++) {
              if (rows[i].id_pregunta == respuestas[j].id_pregunta) {
                preguntaObj.respuestas.push({
                  id_pregunta: respuestas[j].id_pregunta,
                  respuesta: respuestas[j].respuesta,
                });
              }

            }
            results.push(preguntaObj);
          }
        } else {
          for (let i = 0; i < rows.length; i++) {
            let preguntaObj = {
              pregunta: rows[i].pregunta,
              tipo_respuesta: rows[i].tipo_respuesta,
              id_pregunta: rows[i].id_pregunta,
              obligatoria: rows[i].obligatoria,
              cantidad_fotos: rows[i].cantidad_fotos,
              respuestas: [],
            };
            results.push(preguntaObj);
          }
        }
        // console.log("results:",results[0].respuestas[0].respuesta);
        console.log("preguntaObj:", results);
        res.status(200).json(results);
      } else {
        res.status(200).json([]);
      }
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("An error occurred while trying to get preguntas de la campania");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});
router.get("/campania/tipo-respuestas", verifyToken, async (req, res) => {
  const [rows] = await mysqlConnection.promise().execute(`
    SELECT (tr.nombre) as nombre,
    tr.id as id
    FROM tipo_respuesta as tr
    `);
  // console.log("estados: ", rows);
  if (rows.length > 0) {
    res.status(200).json(rows);
  } else {
    res.status(404).json("No se han encontrado tipos de respuestas");
  }
});

//eliminar opcion de preguntas check box
router.put(
  "/campania/preguntas/eliminar-opcion",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "cliente" || cabecera.rol === "admin") {
      const idCampania = req.body.id_campania;
      const idCliente = cabecera.client_id;
      const id_pregunta = req.body.id_pregunta;

      try {
        const [rowsModificacion] = await mysqlConnection.promise().query(
          `UPDATE pregunta_campania_respuesta
        SET 
            habilitada = 'N'
        WHERE 
            pregunta_campania = ? `,
          [id_pregunta]
        );
        console.log(rowsModificacion);
        if (rowsModificacion.affectedRows > 0) {
          res.json("Pregunta campania modificada correctamente");
        }
      } catch (err) {
        console.log(err);
        res.status(500).json("Error al modificar la pregunta de la campania");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);
//eliminar pregunta campania
router.put(
  "/campania/preguntas/eliminar-pregunta",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "cliente" || cabecera.rol === "admin") {
      const idCampania = req.body.id_campania;
      const idCliente = cabecera.client_id;
      const id_pregunta = req.body.id_pregunta;

      try {
        const [rowsModificacion] = await mysqlConnection.promise().query(
          `UPDATE pregunta_campania
        SET 
            habilitada = 'N'
        WHERE 
            id   = ? AND campania = ? `,
          [id_pregunta, idCampania]
        );
        // console.log(rowsModificacion);
        if (rowsModificacion.affectedRows > 0) {
          res.json("Pregunta campania modificada correctamente");
        }
      } catch (err) {
        console.log(err);
        res.status(500).json("Error al modificar la pregunta de la campania");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);
//update campo obligatoria
router.put(
  "/campania/preguntas/update-obligatoria-pregunta",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);

    if (cabecera.rol === "cliente" || cabecera.rol === "admin") {
      const idCampania = req.body.id_campania;
      const idCliente = cabecera.client_id;
      const id_pregunta = req.body.id_pregunta;
      const obligatoria = req.body.obligatoria;
      console.log(req.body);
      try {
        const [rowsModificacion] = await mysqlConnection.promise().query(
          `UPDATE pregunta_campania
        SET 
            obligatoria = ?
        WHERE 
            id = ? `,
          [obligatoria, id_pregunta]
        );
        // console.log(rowsModificacion);
        if (rowsModificacion.affectedRows > 0) {
          res.json("Pregunta campania modificada correctamente");
        }
      } catch (err) {
        console.log(err);
        res.status(500).json("Error al modificar la pregunta de la campania");
      }
    } else {
      res.status(401).json("No autorizado");
    }
  }
);
//detalle mision
router.post("/detalle-mision/preguntas", verifyToken, async (req, res) => {
  const id_mision = req.body.id_mision;
  const cabecera = JSON.parse(req.data.data);
  var results = [];
  var results_multiples = [];
  if (cabecera.rol === "admin" || cabecera.rol === "cliente" || cabecera.rol === "limited") {
    try {
      // Primero, obtenemos el ID de mision_ditor específico
      const [mdResult] = await mysqlConnection.promise().execute(
        `
          SELECT md.id
          FROM mision_ditor as md
          WHERE md.mision = ? AND md.estado_mision_ditor IN (5,8)
          ORDER BY md.id DESC
          LIMIT 1
        `, [id_mision]
      );

      if (mdResult.length > 0) {
        const md_id = mdResult[0].id;

        // Consultas usando el md_id específico
        const [rows] = await mysqlConnection.promise().execute(
          `
            SELECT 
              pc.pregunta as pregunta,
              CASE 
                WHEN mdrs.respuesta_texto IS NOT NULL THEN mdrs.respuesta_texto
                WHEN mdrs.respuesta_si_no IS NOT NULL THEN mdrs.respuesta_si_no
                WHEN mdrs.respuesta_numero IS NOT NULL THEN mdrs.respuesta_numero
                ELSE NULL
              END AS respuesta,
              pc.tipo_respuesta as tipo_respuesta
            FROM mision_ditor as md
            INNER JOIN pregunta_campania as pc ON pc.campania = (SELECT m.campania FROM mision as m WHERE m.id = md.mision)
            LEFT JOIN mision_ditor_respuesta_simple as mdrs ON mdrs.mision_ditor = md.id AND pc.id = mdrs.pregunta_campania
            WHERE md.id = ? AND pc.tipo_respuesta NOT IN (2,4,5,8,9)
          `, [md_id]
        );

        const [preguntas_multiples] = await mysqlConnection.promise().execute(

          `
            SELECT 
              pc.id as id,
              pc.pregunta as pregunta,
              pcr.respuesta AS respuesta,
              pc.tipo_respuesta as tipo_respuesta
            FROM mision_ditor as md
            INNER JOIN pregunta_campania as pc ON pc.campania = (SELECT m.campania FROM mision as m WHERE m.id = md.mision)
            LEFT JOIN mision_ditor_respuesta_simple as mdrs ON mdrs.mision_ditor = md.id AND pc.id = mdrs.pregunta_campania
            LEFT JOIN mision_ditor_respuesta_multiple as mdrm ON mdrm.mision_ditor_respuesta_simple = mdrs.id
            LEFT JOIN pregunta_campania_respuesta as pcr ON pcr.id = mdrm.pregunta_campania_respuesta
            WHERE md.id = ? AND pc.tipo_respuesta IN (4,5)
          `,
          [md_id]
        );
        if (preguntas_multiples.length > 0) {
          let preguntasMultiples = {};
          for (let j = 0; j < preguntas_multiples.length; j++) {
            let id_pregunta = preguntas_multiples[j].id;
            // console.log(preguntasMultiples[id_pregunta]);
            if (!preguntasMultiples[id_pregunta]) {
              preguntasMultiples[id_pregunta] = {
                pregunta: preguntas_multiples[j].pregunta,
                id_pregunta: id_pregunta,
                // id_respuesta: preguntas_multiples[j].id_respuesta,
                respuestas: [],
              };

              // console.log(preguntas_multiples[j]);
              // preguntasMultiples[id_pregunta].respuestas.push({respuesta: preguntas_multiples[j].respuesta });
            }
            if (id_pregunta == preguntas_multiples[j].id) {
              preguntasMultiples[id_pregunta].respuestas.push({
                respuesta: preguntas_multiples[j].respuesta,
              });
            }
          }
          results_multiples = Object.values(preguntasMultiples);
        }
        const [preguntas_fotos] = await mysqlConnection.promise().execute(
          `
            SELECT 
              pc.pregunta as pregunta,
              fmd.archivo as file,
              pc.id as id_pregunta,
              fmd.id as id_respuesta,
              DATE_FORMAT(fmd.fecha_modificacion, "%d/%m/%Y %T") as fecha_modificacion
            FROM fotos_mision_ditor as fmd
            INNER JOIN pregunta_campania as pc ON pc.id = fmd.pregunta_campania
            WHERE fmd.mision_ditor = ? AND pc.tipo_respuesta = 2
          `, [md_id]
        );

        if (preguntas_fotos.length > 0) {
          let preguntasMap = {};

          for (let i = 0; i < preguntas_fotos.length; i++) {
            let id_pregunta = preguntas_fotos[i].id_pregunta;

            if (!preguntasMap[id_pregunta]) {
              preguntasMap[id_pregunta] = {
                pregunta: preguntas_fotos[i].pregunta,
                id_pregunta: id_pregunta,
                id_respuesta: preguntas_fotos[i].id_respuesta,
                fotos: []
              };
            }

            if (preguntas_fotos[i].file) {
              let getObjectParams = {
                Bucket: bucketName,
                Key: preguntas_fotos[i].file
              };
              let command = new GetObjectCommand(getObjectParams);
              let url = await getSignedUrl(s3, command, { expiresIn: 3600 });
              let fechaModificacion = preguntas_fotos[i].fecha_modificacion;
              preguntasMap[id_pregunta].fotos.push({ image: url, thumbImage: url, alt: fechaModificacion, title: fechaModificacion });
            }
          }

          results = Object.values(preguntasMap);
        }

        res.json({
          preguntas_simples: rows || [],
          preguntas_multiples: results_multiples || [],
          preguntas_fotos: results || []
        });
      } else {
        res.json({
          preguntas_simples: [],
          preguntas_multiples: [],
          preguntas_fotos: []
        });
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});


//agregar nueva pregunta/agregar nuevas opciones
router.put(
  "/campania/preguntas/guardar-pregunta-nueva",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    console.log(req.body);
    const pregunta = req.body;
    if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
      try {
        const [rowsModificacion] = await mysqlConnection.promise().execute(
          `
        INSERT INTO pregunta_campania
        (campania,tipo_respuesta,pregunta,obligatoria,habilitada,cantidad_de_fotos) VALUES (?, ?, ?, ?, ?, ?)        
        
        `,
          [
            pregunta.campania,
            pregunta.tipo_respuesta,
            pregunta.pregunta,
            pregunta.obligatoria,
            pregunta.habilitada,
            pregunta.cantidad_fotos,
          ]
        );
        let id_pregunta_insertada = rowsModificacion.insertId;
        console.log(rowsModificacion);
        if (pregunta.opciones.length > 0) {
          for (let i = 0; i < pregunta.opciones.length; i++) {
            [rowsModificacion_opciones] = await mysqlConnection
              .promise()
              .execute(
                `
            INSERT INTO pregunta_campania_respuesta
            (pregunta_campania,respuesta,habilitada) VALUES 
            (?, ?,'Y')
            
            
            
            `,
                [id_pregunta_insertada, pregunta.opciones[i].opcion]
              );
          }
        }
        res.json("Pregunta guardada correctamente");
      } catch (error) {
        console.log(error);
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  }
);
//guardar pregunta existente editada
router.put(
  "/campania/preguntas/guardar-pregunta-editada",
  verifyToken,
  async (req, res) => {
    const cabecera = JSON.parse(req.data.data);
    // console.log(req.body);
    const pregunta = req.body;
    const id_pregunta = pregunta.id_pregunta;
    if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
      try {
        if (pregunta.opcionesPreguntaExistente.length > 0) {
          for (let i = 0; i < pregunta.opcionesPreguntaExistente.length; i++) {
            [rowsModificacion_opciones] = await mysqlConnection
              .promise()
              .execute(
                `
            INSERT INTO pregunta_campania_respuesta
            (pregunta_campania,respuesta,habilitada) VALUES 
            (?, ?,'Y')
            
            
            
            `,
                [id_pregunta, pregunta.opcionesPreguntaExistente[i].opcion]
              );
          }
        }
        res.json("Pregunta guardada correctamente");
      } catch (error) {
        console.log(error);
      }
    } else {
      res.status(401).send("Unauthorized");
    }
  }
);
//eliminar mision
router.post("/detalle-mision/eliminar", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);
  const id_mision = req.body.id_mision;
  // console.log(id_mision);
  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        UPDATE mision
        SET estado_mision = 7
        WHERE id = ?
        `,
        [id_mision]
      );
      if (rows.affectedRows > 0) {
        res.status(200).json("Estado mision actualizado correctamente");
      } else {
        res.status(500).json("No se pudo actualizar el estado mision");
      }
    } catch (error) {
      console.log(error);
    }
  }
});
//listado znappers detalle mision
router.get("/detalle-mision/znappers", verifyToken, async (req, res) => {
  const cabecera = JSON.parse(req.data.data);

  if (
    cabecera.rol === "admin" ||
    cabecera.rol === "cliente" ||
    cabecera.rol === "limited"
  ) {
    const idCliente = cabecera.client_id;
    // console.log(idCliente);
    const [rows] = await mysqlConnection.promise().query(
      `SELECT 
            u.id as id,
            u.nombre as nombre,
            u.apellido as apellido
      FROM usuario as u
            LEFT JOIN perfil_ditor as pd ON u.id = pd.ditor
      WHERE u.cliente = ?
            `,
      [idCliente]
    );

    res.json(rows);
  } else {
    res.status(401).json("No autorizado");
  }
});
router.post("/detalle-mision/update-znapper", verifyToken, async (req, res) => {
  // console.log("req body: ", req.body);
  const cabecera = JSON.parse(req.data.data);
  const id_mision = req.body.id_mision;
  const id_znapper = req.body.id_znapper;
  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {
    try {
      const [rows] = await mysqlConnection.promise().execute(
        `
        UPDATE mision
        SET asignada_a_id = ?
        WHERE id = ?
        `,
        [id_znapper, id_mision]
      );
      if (rows.affectedRows > 0) {
        res.status(200).json("Mision znapper actualizado correctamente");
      } else {
        res.status(500).json("No se pudo actualizar el znapper de la mision");
      }
    } catch (error) { }
  }
});

//guardar campania nueva
router.post("/campania/preguntas/guardar-campania", verifyToken, async (req, res) => {
  const campania = req.body;
  const cabecera = JSON.parse(req.data.data);
  let id_campania;
  console.log("campania: ", campania);
  // Convertir las fechas al formato YYYY-MM-DD
  const fechaInicio = new Date(campania.fecha_inicio)
    .toISOString()
    .split("T")[0];
  const fechaFin = campania.fecha_fin ? new Date(campania.fecha_fin).toISOString().split("T")[0] : null;

  if (cabecera.rol === "admin" || cabecera.rol === "cliente") {

    try {
      const [rows] = await mysqlConnection.promise().execute(`
          INSERT INTO campania
          (nombre,objetivo,cliente,estado_campania,tipo_campania,duracion_reserva,duracion_mision,fecha_inicio,fecha_fin)
          VALUES(?,?,?,2,1,90,15,?,?)
        
        
        `, [campania.nombre_campania, campania.objetivo_campania, cabecera.client_id, fechaInicio, fechaFin]);

      console.log(rows);

      if (rows.affectedRows > 0) {
        id_campania = rows.insertId;
        if (campania.preguntas_campania.length > 0) {
          for (let i = 0; i < campania.preguntas_campania.length; i++) {

            const [preguntas_campania] = await mysqlConnection.promise().execute(`
              INSERT INTO pregunta_campania
             (campania,tipo_respuesta,cantidad_de_fotos,pregunta,obligatoria,habilitada)
              VALUES (?,?,?,?,?,'Y')
              
             `, [id_campania, campania.preguntas_campania[i].tipo_respuesta, campania.preguntas_campania[i].cantidad_fotos, campania.preguntas_campania[i].pregunta, campania.preguntas_campania[i].obligatoria]);
            let id_pregunta = preguntas_campania.insertId;
            if (campania.preguntas_campania[i].opciones.length > 0) {
              for (let j = 0; j < campania.preguntas_campania[i].opciones.length; j++) {
                let opcion = campania.preguntas_campania[i].opciones[j].opcion;
                const [opciones_pregunta] = await mysqlConnection.promise().execute(`
                  INSERT INTO pregunta_campania_respuesta
                  (pregunta_campania,respuesta,habilitada)
                  VALUES(?,?,'Y')
                
                `, [id_pregunta, opcion]);
              }

            }
          }

        }
        res.status(200).json(id_campania);
      } else {
        res.status(401).send("Error al cargar la nueva campaña")
      }
    } catch (error) {
      console.log(error);
    }
  } else {
    res.status(401).send("Unauthorized");
  }
});

router.post("/detalle-campania/metricas-barras/:id", verifyToken, async (req, res) => {
  const id_campania = req.params.id;
  const cabecera = JSON.parse(req.data.data);
  const filtro = req.body.comercio;
  rows_filtro = [];
  console.log("filtro:", filtro);
  if (cabecera.rol === "admin" || cabecera.rol === "cliente" || cabecera.rol === "limited") {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
        SELECT
          (pc.id) as id_pregunta,
          (pc.pregunta) as pregunta,
          (pc.tipo_pregunta) as tipo_pregunta,
          IFNULL(mdrs.respuesta_numero,0) as rating,
           IFNULL(TRUNCATE(AVG(mdrs.respuesta_numero),2),0) as promedio,
          (tp.nombre) as seccion_pregunta
        FROM campania as c
        INNER JOIN pregunta_campania as pc ON pc.campania = c.id
        INNER JOIN mision as m ON m.campania = c.id
        LEFT JOIN mision_ditor as md ON md.mision = m.id
        LEFT JOIN mision_ditor_respuesta_simple as mdrs ON mdrs.pregunta_campania = pc.id
        INNER JOIN tipo_pregunta as tp ON tp.id = pc.tipo_pregunta
        WHERE c.id  = ? AND pc.tipo_respuesta = 7
        GROUP BY pc.id, pc.pregunta, pc.tipo_pregunta
        `, [id_campania]);
      console.log(rows);
      if (filtro.comercio != null) {
        [rows_filtro] = await mysqlConnection.promise().execute(`
          SELECT
            (pc.id) as id_pregunta,
            (pc.pregunta) as pregunta,
            (pc.tipo_pregunta) as tipo_pregunta,
         IFNULL(mdrs.respuesta_numero,0) as rating,
          IFNULL(TRUNCATE(AVG(mdrs.respuesta_numero),2),0) as promedio,
          (tp.nombre) as seccion_pregunta
          FROM campania as c
          INNER JOIN pregunta_campania as pc ON pc.campania = c.id
          INNER JOIN mision as m ON m.campania = c.id
          INNER JOIN tipo_pregunta as tp ON tp.id = pc.tipo_pregunta
          LEFT JOIN mision_ditor as md ON md.mision = m.id
          LEFT JOIN mision_ditor_respuesta_simple as mdrs ON mdrs.pregunta_campania = pc.id
          WHERE c.id  = ? AND pc.tipo_respuesta = 7 AND m.comercio = ?
          GROUP BY pc.id, pc.pregunta, pc.tipo_pregunta
          
          
          `, [id_campania, filtro.comercio]);
      }
      if (rows_filtro.length > 0) {
        res.status(200).json([{
          comercios: rows,
          comercio_unico: rows_filtro

        }]);
      } else {
        res.status(200).json([{
          comercios: rows,
          comercio_unico: []

        }]);
      }
    } catch (error) {
      console.log(error);
    }

  } else {
    res.status(401).send("Unauthorized");
  }

});
router.get("/detalle-campania/comercios", verifyToken, async (req, res) => {

  const cabecera = JSON.parse(req.data.data);
  const client_id = cabecera.client_id
  if (cabecera.rol === "admin" || cabecera.rol === "cliente" || cabecera.rol === "limited"
  ) {
    try {
      const [rows] = await mysqlConnection.promise().execute(`
          SELECT (c.nombre) as nombre,
                  (c.id) as id
          FROM comercio as c 
          WHERE c.cliente = ?
      
        `, [client_id]);
      if (rows.length > 0) {
        res.status(200).json(rows);
      }
    } catch (error) {
      console.log(error);
      res.status(500).json("Error interno");
    }

  } else {
    res.status(401).send("Unauthorized");
  }



});
module.exports = router;
