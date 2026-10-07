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
    throw new ErrorSesionUsuario("La sesión no contiene un usuario válido");
  }
}

function usuarioHabilitado(valor) {
  if (valor === false || valor === 0) return false;
  const normalizado = String(valor ?? "S").trim().toUpperCase();
  return !["N", "NO", "0", "FALSE"].includes(normalizado);
}

// Un familiar invitado usa la experiencia de autogestión exclusivamente para
// turismo. La relación y el titular se vuelven a comprobar en cada petición.
async function resolverAccesoFamiliar(usuario, db) {
  if (String(usuario.rol).toLowerCase() !== 'invitado') return usuario;
  const titularId = Number(usuario.usuario_familiar_id);
  if (String(usuario.es_familiar).toUpperCase() !== 'S' || !Number.isSafeInteger(titularId) || titularId <= 0 || titularId === Number(usuario.id)) {
    throw new ErrorSesionUsuario('El invitado no tiene un vínculo familiar habilitado');
  }
  const [titulares] = await db.query(
    `SELECT id, rol_id, habilitado, modulo_turismo, departamental_id, usuario_familiar_id
       FROM usuario WHERE id = ? LIMIT 1`, [titularId]);
  const titular = titulares[0];
  if (!titular || Number(titular.rol_id) !== 2 || !usuarioHabilitado(titular.habilitado) || titular.usuario_familiar_id) {
    throw new ErrorSesionUsuario('El titular del grupo familiar no está habilitado');
  }
  return { ...usuario, rol: 'afiliado', es_familiar: 'S', acceso_familiar_turismo: true,
    titular_usuario_id: titularId, departamental_id: titular.departamental_id,
    area_turismo: 1, area_coseguro: 0,
    modulo_turismo: (titular.modulo_turismo == null || Number(titular.modulo_turismo) === 1) &&
      (usuario.modulo_turismo == null || Number(usuario.modulo_turismo) === 1) ? 1 : 0,
    modulo_coseguro: 0, modulo_olimpiadas: 0 };
}

function rutaPermitidaFamiliar(req) {
  const ruta = String(req.path || req.url || '').split('?')[0];
  if ((req.method === 'POST' && ruta === '/familiares') || /^\/familiares\/\d+\/vinculo\/?$/.test(ruta)) return false;
  // Los handlers conservan sus controles de propiedad y ámbito de grupo.
  return /^\/(?:sesion\/permisos|configuracion\/usuario(?:\/\d+)?|usuario|notificaciones(?:\/.*)?|mis-gestiones(?:\/catalogos)?|turismo(?:\/.*)?|reserva(?:\/.*)?|reservas\/aprobaciones-titular|servicios(?:\/.*)?|lugares|recursos|adicionales|regimen|tipo_persona|parentesco|acompaniantes(?:\/\d+)?|tabla\/acompaniantes|familiares(?:\/.*)?|convenios-hoteleros(?:\/.*)?|sorteos(?:\/.*)?|filtros\/para-recursos|descuentos(?:\/.*)?|observaciones\/turismo\/\d+\/lectura|webauthn(?:\/.*)?)\/?$/.test(ruta);
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
       u.modulo_olimpiadas,
       u.es_familiar,
       u.usuario_familiar_id
     FROM usuario u
     INNER JOIN rol r ON r.id = u.rol_id
     WHERE u.id = ?
     LIMIT 1`,
    [cabecera.id]
  );

  if (!usuarios.length) {
    throw new ErrorSesionUsuario("El usuario de la sesión ya no existe");
  }
  if (!usuarioHabilitado(usuarios[0].habilitado)) {
    throw new ErrorSesionUsuario("Usuario inhabilitado");
  }

  const actualizada = { ...cabecera, acceso_familiar_turismo: false, titular_usuario_id: null, ...await resolverAccesoFamiliar(usuarios[0], db) };
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
    if (error) {
      return res.status(403).json(error.name === "TokenExpiredError"
        ? "Tu sesión venció. Volvé a iniciar sesión."
        : "Tu sesión no es válida. Volvé a iniciar sesión.");
    }
    try {
      const permisos = await actualizarAutorizacionSesion(authData, db);
      if (permisos.acceso_familiar_turismo && !rutaPermitidaFamiliar(req)) {
        return res.status(403).json('La cuenta familiar solo tiene acceso a turismo y a sus datos personales');
      }
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
  resolverAccesoFamiliar,
  rutaPermitidaFamiliar,
  ErrorSesionUsuario,
  actualizarAutorizacionSesion,
  parsearCabecera,
  usuarioHabilitado,
  verificarTokenConAutorizacionActual,
};
