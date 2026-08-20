"use strict";

class ErrorSesionUsuario extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.name = "ErrorSesionUsuario";
    this.statusCode = statusCode;
  }
}

function parsearCabecera(authData) {
  try {
    const cabecera = typeof authData?.data === "string"
      ? JSON.parse(authData.data)
      : authData?.data;
    const usuarioId = Number.parseInt(cabecera?.id, 10);
    if (!cabecera || !Number.isInteger(usuarioId) || usuarioId <= 0) {
      throw new Error("cabecera invalida");
    }
    return { ...cabecera, id: usuarioId };
  } catch (_error) {
    throw new ErrorSesionUsuario("La sesion no contiene un usuario valido");
  }
}

function usuarioHabilitado(valor) {
  if (valor === false || valor === 0) return false;
  const normalizado = String(valor ?? "S").trim().toUpperCase();
  return !["N", "NO", "0", "FALSE"].includes(normalizado);
}

async function actualizarAutorizacionSesion(authData, db) {
  const cabecera = parsearCabecera(authData);
  const [usuarios] = await db.query(
    `SELECT
       u.id,
       u.rol_id,
       r.nombre AS rol,
       u.departamental_id,
       u.habilitado,
       u.area_turismo,
       u.area_coseguro,
       u.modulo_turismo,
       u.modulo_coseguro,
       u.modulo_olimpiadas
     FROM usuario u
     INNER JOIN rol r ON r.id = u.rol_id
     WHERE u.id = ?
     LIMIT 1`,
    [cabecera.id]
  );

  if (!usuarios.length) {
    throw new ErrorSesionUsuario("El usuario de la sesion ya no existe");
  }
  if (!usuarioHabilitado(usuarios[0].habilitado)) {
    throw new ErrorSesionUsuario("Usuario inhabilitado");
  }

  const actualizada = { ...cabecera, ...usuarios[0] };
  authData.data = JSON.stringify(actualizada);
  return actualizada;
}

function verificarTokenConAutorizacionActual({
  req,
  res,
  next,
  jwt,
  jwtSecret,
  db,
  mensajeAuthorization = "No autorizado",
}) {
  const coincidencia = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ""));
  if (!coincidencia) return res.status(401).json(mensajeAuthorization);

  return jwt.verify(coincidencia[1], jwtSecret, async (error, authData) => {
    if (error) return res.status(403).json("Error en el token");
    try {
      await actualizarAutorizacionSesion(authData, db);
      req.data = authData;
      return next();
    } catch (sessionError) {
      if (sessionError instanceof ErrorSesionUsuario) {
        return res.status(sessionError.statusCode).json(sessionError.message);
      }
      console.error("No se pudieron refrescar los permisos de la sesion:", sessionError);
      return res.status(500).json("No se pudieron validar los permisos actuales");
    }
  });
}

module.exports = {
  ErrorSesionUsuario,
  actualizarAutorizacionSesion,
  parsearCabecera,
  usuarioHabilitado,
  verificarTokenConAutorizacionActual,
};
