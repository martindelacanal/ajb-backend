"use strict";

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const simpleWebAuthn = require("@simplewebauthn/server");

const mysqlConnection = require("../connection/connection");
const {
  usuarioHabilitado,
  verificarTokenConAutorizacionActual,
} = require("../security/autorizacion-sesion");
const { obtenerOrigenesPermitidos } = require("../security/http-config");
const { emitirTokenSesion } = require("../security/token-sesion");
const {
  ErrorOrigenWebAuthn,
  resolverContextoWebAuthn,
} = require("../security/webauthn-origen");

const TIPO_REGISTRO = "REGISTRO";
const TIPO_AUTENTICACION = "AUTENTICACION";
const MAX_CREDENCIALES_POR_USUARIO = 10;
const MENSAJE_AUTENTICACION = "No se pudo validar la clave de acceso";
const MENSAJE_REGISTRO = "No se pudo registrar la clave de acceso";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,1400}$/;
const TRANSPORTES_PERMITIDOS = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

class ErrorWebAuthnEsperado extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ErrorWebAuthnEsperado";
    this.statusCode = statusCode;
  }
}

function normalizarRecordar(valor) {
  return valor === true || valor === 1 || valor === "true";
}

function normalizarNombreCredencial(valor) {
  const nombre = typeof valor === "string" ? valor.trim().replace(/\s+/g, " ") : "";
  return nombre.slice(0, 100) || "Clave de acceso";
}

function obtenerCredentialId(response) {
  const credentialId = typeof response?.id === "string" ? response.id : "";
  return CREDENTIAL_ID_PATTERN.test(credentialId) ? credentialId : null;
}

function parsearTransportes(valor) {
  let transportes = valor;
  if (!transportes) return [];
  try {
    if (typeof transportes === "string") transportes = JSON.parse(transportes);
  } catch (_error) {
    return [];
  }
  if (!Array.isArray(transportes)) return [];
  return [...new Set(transportes.filter((item) => TRANSPORTES_PERMITIDOS.has(item)))];
}

function compararBase64UrlSeguro(actual, esperado) {
  if (typeof actual !== "string" || typeof esperado !== "string") return false;
  const actualBuffer = Buffer.from(actual, "utf8");
  const esperadoBuffer = Buffer.from(esperado, "utf8");
  return actualBuffer.length === esperadoBuffer.length
    && crypto.timingSafeEqual(actualBuffer, esperadoBuffer);
}

function datosSesionDesdeFila(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    apellido: row.apellido,
    documento: row.documento,
    email: row.email,
    departamental_id: row.departamental_id,
    rol: row.rol,
    habilitado: row.habilitado,
    area_turismo: row.area_turismo,
    area_coseguro: row.area_coseguro,
    modulo_turismo: row.modulo_turismo,
    modulo_coseguro: row.modulo_coseguro,
    modulo_olimpiadas: row.modulo_olimpiadas,
  };
}

function crearLimitadorAnonimo({
  ventanaMs = 15 * 60 * 1000,
  maxIntentos = 40,
  maxClaves = 10000,
  ahora = () => Date.now(),
} = {}) {
  const estados = new Map();

  function limpiar(timestamp) {
    for (const [clave, estado] of estados) {
      if (timestamp - estado.inicio >= ventanaMs) estados.delete(clave);
    }
    while (estados.size >= maxClaves) {
      const primera = estados.keys().next().value;
      if (primera === undefined) break;
      estados.delete(primera);
    }
  }

  return (req, res, next) => {
    const timestamp = ahora();
    const clave = String(req.ip || req.socket?.remoteAddress || "desconocida");
    let estado = estados.get(clave);
    if (!estado || timestamp - estado.inicio >= ventanaMs) {
      limpiar(timestamp);
      estado = { inicio: timestamp, intentos: 0 };
      estados.set(clave, estado);
    }
    if (estado.intentos >= maxIntentos) {
      const segundos = Math.max(1, Math.ceil((ventanaMs - (timestamp - estado.inicio)) / 1000));
      res.setHeader("Retry-After", String(segundos));
      res.status(429).json("Demasiados intentos. Intente nuevamente mas tarde.");
      return;
    }
    estado.intentos += 1;
    next();
  };
}

async function limpiarDesafiosVencidos(db) {
  await db.query(
    `DELETE FROM webauthn_desafio
      WHERE vence_en < DATE_SUB(NOW(6), INTERVAL 1 DAY)
         OR consumido_en < DATE_SUB(NOW(6), INTERVAL 1 DAY)`
  );
}

async function guardarDesafio(db, {
  id,
  tipo,
  usuarioId = null,
  challenge,
  webauthnUsuarioId = null,
  origen,
  rpID,
  recordar = false,
}) {
  await db.query(
    `INSERT INTO webauthn_desafio
       (id, tipo, usuario_id, challenge, webauthn_usuario_id, origen, rp_id, recordar, vence_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(6), INTERVAL 5 MINUTE))`,
    [id, tipo, usuarioId, challenge, webauthnUsuarioId, origen, rpID, recordar ? 1 : 0]
  );
}

async function consumirDesafio(db, {
  id,
  tipo,
  contexto,
  usuarioId = null,
}) {
  if (!UUID_PATTERN.test(String(id || ""))) return null;
  const condicionUsuario = tipo === TIPO_REGISTRO ? "AND usuario_id = ?" : "";
  const params = [id, tipo, contexto.origen, contexto.rpID];
  if (tipo === TIPO_REGISTRO) params.push(usuarioId);

  const [resultado] = await db.query(
    `UPDATE webauthn_desafio
        SET consumido_en = NOW(6)
      WHERE id = ?
        AND tipo = ?
        AND origen = ?
        AND rp_id = ?
        ${condicionUsuario}
        AND consumido_en IS NULL
        AND vence_en > NOW(6)`,
    params
  );
  if (Number(resultado?.affectedRows) !== 1) return null;

  const [rows] = await db.query(
    `SELECT id, tipo, usuario_id, challenge, webauthn_usuario_id, origen, rp_id, recordar
       FROM webauthn_desafio
      WHERE id = ?
      LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

function crearRouterWebAuthn({
  db = mysqlConnection.promise(),
  webauthnLib = simpleWebAuthn,
  jwtLib = jwt,
  jwtSecret = process.env.JWT_SECRET,
  origenesPermitidos = obtenerOrigenesPermitidos(),
  randomUUID = () => crypto.randomUUID(),
  rpName = process.env.WEBAUTHN_RP_NAME || "Mi AJB",
  limitadorAnonimo = crearLimitadorAnonimo(),
} = {}) {
  const router = express.Router();

  function exigirOrigen(req, res, next) {
    try {
      req.webauthn = resolverContextoWebAuthn(req, origenesPermitidos);
      next();
    } catch (error) {
      if (error instanceof ErrorOrigenWebAuthn) {
        res.status(error.statusCode).json("Origen no permitido");
        return;
      }
      next(error);
    }
  }

  function verificarToken(req, res, next) {
    return verificarTokenConAutorizacionActual({
      req,
      res,
      next,
      jwt: jwtLib,
      jwtSecret,
      db,
      mensajeAuthorization: "No autorizado",
    });
  }

  router.get("/passkeys", verificarToken, async (req, res) => {
    try {
      const usuario = JSON.parse(req.data.data);
      const [rows] = await db.query(
        `SELECT id, nombre, rp_id, tipo_dispositivo, respaldada,
                fecha_creacion, fecha_ultimo_uso
           FROM webauthn_credencial
          WHERE usuario_id = ?
          ORDER BY fecha_creacion DESC`,
        [usuario.id]
      );
      res.status(200).json(rows.map((row) => ({
        id: row.id,
        nombre: row.nombre,
        creada_en: row.fecha_creacion,
        ultimo_uso_en: row.fecha_ultimo_uso,
        tipo_dispositivo: row.tipo_dispositivo,
        respaldada: Boolean(row.respaldada),
        dominio: row.rp_id,
      })));
    } catch (error) {
      console.error("No se pudieron listar las claves de acceso:", error?.code || error?.message);
      res.status(500).json("No se pudieron obtener las claves de acceso");
    }
  });

  router.post("/passkeys/registration/options", exigirOrigen, verificarToken, async (req, res) => {
    try {
      const sesion = JSON.parse(req.data.data);
      const [usuarios] = await db.query(
        `SELECT u.id, u.nombre, u.apellido, u.documento, u.rol_id, u.habilitado
           FROM usuario u
          WHERE u.id = ? AND u.rol_id <> 4
          LIMIT 1`,
        [sesion.id]
      );
      const usuario = usuarios[0];
      if (!usuario || !usuarioHabilitado(usuario.habilitado)) {
        return res.status(403).json("No autorizado");
      }

      const [credenciales] = await db.query(
        `SELECT rp_id, credential_id, transportes
           FROM webauthn_credencial
          WHERE usuario_id = ?
          ORDER BY id`,
        [usuario.id]
      );
      if (credenciales.length >= MAX_CREDENCIALES_POR_USUARIO) {
        return res.status(409).json("Se alcanzo el limite de claves de acceso");
      }

      const options = await webauthnLib.generateRegistrationOptions({
        rpName,
        rpID: req.webauthn.rpID,
        userID: Buffer.from(`miajb-usuario:${usuario.id}`, "utf8"),
        userName: String(usuario.documento),
        userDisplayName: `${usuario.nombre || ""} ${usuario.apellido || ""}`.trim(),
        timeout: 300000,
        attestationType: "none",
        supportedAlgorithmIDs: [-7, -257],
        excludeCredentials: credenciales
          .filter((credencial) => credencial.rp_id === req.webauthn.rpID)
          .map((credencial) => ({
            id: credencial.credential_id,
            transports: parsearTransportes(credencial.transportes),
          })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });

      const ceremonyId = randomUUID();
      await limpiarDesafiosVencidos(db);
      await guardarDesafio(db, {
        id: ceremonyId,
        tipo: TIPO_REGISTRO,
        usuarioId: usuario.id,
        challenge: options.challenge,
        webauthnUsuarioId: options.user.id,
        origen: req.webauthn.origen,
        rpID: req.webauthn.rpID,
      });
      res.status(200).json({ ceremonia_id: ceremonyId, opciones: options });
    } catch (error) {
      console.error("No se pudieron generar opciones WebAuthn de registro:", error?.code || error?.message);
      res.status(500).json(MENSAJE_REGISTRO);
    }
  });

  router.post("/passkeys/registration/verify", exigirOrigen, verificarToken, async (req, res) => {
    let connection;
    try {
      const sesion = JSON.parse(req.data.data);
      const desafio = await consumirDesafio(db, {
        id: req.body?.ceremonia_id,
        tipo: TIPO_REGISTRO,
        contexto: req.webauthn,
        usuarioId: sesion.id,
      });
      if (!desafio) return res.status(400).json(MENSAJE_REGISTRO);

      const response = req.body?.respuesta;
      if (!obtenerCredentialId(response)) {
        return res.status(400).json(MENSAJE_REGISTRO);
      }

      let verification;
      try {
        verification = await webauthnLib.verifyRegistrationResponse({
          response,
          expectedChallenge: desafio.challenge,
          expectedOrigin: desafio.origen,
          expectedRPID: desafio.rp_id,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257],
        });
      } catch (_error) {
        return res.status(400).json(MENSAJE_REGISTRO);
      }
      if (!verification?.verified || !verification.registrationInfo?.credential) {
        return res.status(400).json(MENSAJE_REGISTRO);
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      const credentialId = obtenerCredentialId(credential);
      if (!credentialId || !credential.publicKey) {
        return res.status(400).json(MENSAJE_REGISTRO);
      }

      connection = await db.getConnection();
      await connection.beginTransaction();
      const [usuariosActuales] = await connection.query(
        `SELECT id, rol_id, habilitado
           FROM usuario
          WHERE id = ?
          LIMIT 1
          FOR UPDATE`,
        [desafio.usuario_id]
      );
      const usuarioActual = usuariosActuales[0];
      if (
        !usuarioActual
        || Number(usuarioActual.rol_id) === 4
        || !usuarioHabilitado(usuarioActual.habilitado)
      ) {
        throw new ErrorWebAuthnEsperado("No autorizado", 403);
      }
      const [totales] = await connection.query(
        `SELECT COUNT(*) AS total
           FROM webauthn_credencial
          WHERE usuario_id = ?`,
        [desafio.usuario_id]
      );
      if (Number(totales[0]?.total || 0) >= MAX_CREDENCIALES_POR_USUARIO) {
        throw new ErrorWebAuthnEsperado("Se alcanzo el limite de claves de acceso", 409);
      }

      const [resultado] = await connection.query(
        `INSERT INTO webauthn_credencial
           (usuario_id, rp_id, webauthn_usuario_id, credential_id, clave_publica,
            contador, tipo_dispositivo, respaldada, transportes, nombre)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          desafio.usuario_id,
          desafio.rp_id,
          desafio.webauthn_usuario_id,
          credentialId,
          Buffer.from(credential.publicKey),
          Number(credential.counter || 0),
          credentialDeviceType || "unknown",
          credentialBackedUp ? 1 : 0,
          JSON.stringify(parsearTransportes(credential.transports)),
          normalizarNombreCredencial(req.body?.nombre),
        ]
      );
      const [credencialesInsertadas] = await connection.query(
        `SELECT id, nombre, rp_id, tipo_dispositivo, respaldada,
                fecha_creacion, fecha_ultimo_uso
           FROM webauthn_credencial
          WHERE id = ? AND usuario_id = ?
          LIMIT 1`,
        [resultado.insertId, desafio.usuario_id]
      );
      const credencialInsertada = credencialesInsertadas[0];
      await connection.commit();
      connection.release();
      connection = null;
      res.status(201).json({
        id: credencialInsertada?.id ?? resultado.insertId,
        nombre: credencialInsertada?.nombre ?? normalizarNombreCredencial(req.body?.nombre),
        creada_en: credencialInsertada?.fecha_creacion ?? new Date().toISOString(),
        ultimo_uso_en: credencialInsertada?.fecha_ultimo_uso ?? null,
        tipo_dispositivo: credencialInsertada?.tipo_dispositivo ?? credentialDeviceType ?? "unknown",
        respaldada: credencialInsertada
          ? Boolean(credencialInsertada.respaldada)
          : Boolean(credentialBackedUp),
        dominio: credencialInsertada?.rp_id ?? desafio.rp_id,
      });
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (_rollbackError) {
          // El error original conserva prioridad.
        }
        connection.release();
      }
      if (error instanceof ErrorWebAuthnEsperado) {
        res.status(error.statusCode).json(error.message);
        return;
      }
      if (error?.code === "ER_DUP_ENTRY") {
        res.status(409).json("La clave de acceso ya se encuentra registrada");
        return;
      }
      console.error("No se pudo verificar el registro WebAuthn:", error?.code || error?.message);
      res.status(500).json(MENSAJE_REGISTRO);
    }
  });

  router.delete("/passkeys/:id", verificarToken, async (req, res) => {
    try {
      const credentialId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(credentialId) || credentialId <= 0 || String(credentialId) !== req.params.id) {
        return res.status(400).json("ID invalido");
      }
      const sesion = JSON.parse(req.data.data);
      const [resultado] = await db.query(
        `DELETE FROM webauthn_credencial
          WHERE id = ? AND usuario_id = ?`,
        [credentialId, sesion.id]
      );
      if (Number(resultado?.affectedRows) !== 1) {
        return res.status(404).json("Clave de acceso no encontrada");
      }
      res.status(200).json({ success: true });
    } catch (error) {
      console.error("No se pudo eliminar la clave de acceso:", error?.code || error?.message);
      res.status(500).json("No se pudo eliminar la clave de acceso");
    }
  });

  router.post(
    "/passkeys/authentication/options",
    limitadorAnonimo,
    exigirOrigen,
    async (req, res) => {
      try {
        const options = await webauthnLib.generateAuthenticationOptions({
          rpID: req.webauthn.rpID,
          timeout: 300000,
          userVerification: "required",
          allowCredentials: [],
        });
        const ceremonyId = randomUUID();
        await limpiarDesafiosVencidos(db);
        await guardarDesafio(db, {
          id: ceremonyId,
          tipo: TIPO_AUTENTICACION,
          challenge: options.challenge,
          origen: req.webauthn.origen,
          rpID: req.webauthn.rpID,
          recordar: normalizarRecordar(req.body?.recordar),
        });
        res.status(200).json({ ceremonia_id: ceremonyId, opciones: options });
      } catch (error) {
        console.error("No se pudieron generar opciones WebAuthn de autenticacion:", error?.code || error?.message);
        res.status(500).json(MENSAJE_AUTENTICACION);
      }
    }
  );

  router.post(
    "/passkeys/authentication/verify",
    limitadorAnonimo,
    exigirOrigen,
    async (req, res) => {
      let connection;
      try {
        const desafio = await consumirDesafio(db, {
          id: req.body?.ceremonia_id,
          tipo: TIPO_AUTENTICACION,
          contexto: req.webauthn,
        });
        if (!desafio) throw new ErrorWebAuthnEsperado(MENSAJE_AUTENTICACION, 401);

        const response = req.body?.respuesta;
        const credentialId = obtenerCredentialId(response);
        if (!credentialId) throw new ErrorWebAuthnEsperado(MENSAJE_AUTENTICACION, 401);

        connection = await db.getConnection();
        await connection.beginTransaction();
        const [rows] = await connection.query(
          `SELECT c.id AS webauthn_credencial_id, c.credential_id, c.clave_publica,
                  c.contador, c.transportes, c.webauthn_usuario_id,
                  u.id, u.nombre, u.apellido, u.documento, u.email,
                  u.departamental_id, u.rol_id, r.nombre AS rol, u.habilitado,
                  u.area_turismo, u.area_coseguro,
                  u.modulo_turismo, u.modulo_coseguro, u.modulo_olimpiadas
             FROM webauthn_credencial c
             INNER JOIN usuario u ON u.id = c.usuario_id
             INNER JOIN rol r ON r.id = u.rol_id
            WHERE c.credential_id = ? AND c.rp_id = ?
            LIMIT 1
            FOR UPDATE`,
          [credentialId, desafio.rp_id]
        );
        const credencial = rows[0];
        if (
          !credencial
          || Number(credencial.rol_id) === 4
          || !usuarioHabilitado(credencial.habilitado)
          || !compararBase64UrlSeguro(response?.response?.userHandle, credencial.webauthn_usuario_id)
        ) {
          throw new ErrorWebAuthnEsperado(MENSAJE_AUTENTICACION, 401);
        }

        let verification;
        try {
          verification = await webauthnLib.verifyAuthenticationResponse({
            response,
            expectedChallenge: desafio.challenge,
            expectedOrigin: desafio.origen,
            expectedRPID: desafio.rp_id,
            credential: {
              id: credencial.credential_id,
              publicKey: new Uint8Array(credencial.clave_publica),
              counter: Number(credencial.contador || 0),
              transports: parsearTransportes(credencial.transportes),
            },
            requireUserVerification: true,
          });
        } catch (_error) {
          throw new ErrorWebAuthnEsperado(MENSAJE_AUTENTICACION, 401);
        }
        if (!verification?.verified) {
          throw new ErrorWebAuthnEsperado(MENSAJE_AUTENTICACION, 401);
        }

        const authenticationInfo = verification.authenticationInfo;
        const newCounter = Number(authenticationInfo?.newCounter || 0);
        const deviceType = authenticationInfo?.credentialDeviceType;
        const backedUp = authenticationInfo?.credentialBackedUp;
        if (
          !Number.isSafeInteger(newCounter)
          || newCounter < 0
          || !["singleDevice", "multiDevice"].includes(deviceType)
          || typeof backedUp !== "boolean"
        ) {
          throw new ErrorWebAuthnEsperado(MENSAJE_AUTENTICACION, 401);
        }
        await connection.query(
          `UPDATE webauthn_credencial
              SET contador = ?, tipo_dispositivo = ?, respaldada = ?,
                  fecha_ultimo_uso = NOW(6)
            WHERE id = ?`,
          [newCounter, deviceType, backedUp ? 1 : 0, credencial.webauthn_credencial_id]
        );

        const data = datosSesionDesdeFila(credencial);
        const token = await emitirTokenSesion({
          data,
          recordar: Boolean(desafio.recordar),
          jwtLib,
          jwtSecret,
        });
        await connection.commit();
        connection.release();
        connection = null;
        res.status(200).json({ token, data });
      } catch (error) {
        if (connection) {
          try {
            await connection.rollback();
          } catch (_rollbackError) {
            // El error original conserva prioridad.
          }
          connection.release();
        }
        if (error instanceof ErrorWebAuthnEsperado) {
          res.status(error.statusCode).json(error.message);
          return;
        }
        console.error("No se pudo verificar la autenticacion WebAuthn:", error?.code || error?.message);
        res.status(500).json(MENSAJE_AUTENTICACION);
      }
    }
  );

  return router;
}

const router = crearRouterWebAuthn();

module.exports = router;
module.exports.ErrorWebAuthnEsperado = ErrorWebAuthnEsperado;
module.exports.compararBase64UrlSeguro = compararBase64UrlSeguro;
module.exports.crearLimitadorAnonimo = crearLimitadorAnonimo;
module.exports.crearRouterWebAuthn = crearRouterWebAuthn;
module.exports.datosSesionDesdeFila = datosSesionDesdeFila;
module.exports.normalizarRecordar = normalizarRecordar;
