"use strict";

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
const {
  aplicarDescuentoEnPuntosBase,
  decimalACentavos,
  centavosANumero,
} = require("../services/valores-dominio");
const {
  ALCANCES_DEPARTAMENTALES,
  AUDIENCIAS_DEPARTAMENTALES,
  ESTADOS_APROBACION,
  MODELOS_TARIFA,
  TIPOS_FILTRO,
  UNIDADES_COBRO,
  asegurarPropiedadServicio,
  crearErrorCatalogo,
  esAdministradorTurismo,
  normalizarBooleano,
  normalizarCodigo,
  normalizarEnteroNoNegativo,
  normalizarEnum,
  normalizarFechaCivil,
  normalizarIdPositivo,
  normalizarTexto,
  normalizarValorFiltro,
  obtenerServicioGestion,
  obtenerServicioGestionAutorizado,
  puedeAprobarTurismo,
  puedeGestionarTurismo,
  registrarHistorialTurismo,
  tieneAreaTurismo,
} = require("../services/turismo-catalogo");
const { registrarHistorialDescuento } = require("../services/descuentos-reserva");

const router = express.Router();

const ESTADOS_DESCUENTO_SALUD = new Set(["DESHABILITADO", "PENDIENTE", "HABILITADO"]);

const TEMPORADAS_REGLA = new Set(["ALTA", "BAJA", "UNICA", "PERSONALIZADA"]);
const MIME_IMAGEN_PERMITIDO = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXTENSION_POR_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_IMAGENES_POR_CARGA = 10;
const MAX_IMAGEN_BYTES = 10 * 1024 * 1024;
const S3_EXPIRES = Math.min(86400, Math.max(60, Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || 3600)));

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});

const uploadImagenesTurismo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGEN_BYTES, files: MAX_IMAGENES_POR_CARGA },
  fileFilter: (_req, file, callback) => {
    if (!MIME_IMAGEN_PERMITIDO.has(file.mimetype)) {
      const error = crearErrorCatalogo("Solo se permiten imágenes JPG, PNG o WebP", 400, "IMAGEN_TIPO_INVALIDO");
      return callback(error);
    }
    return callback(null, true);
  },
});

function procesarImagenesTurismo(req, res, next) {
  uploadImagenesTurismo.fields([
    { name: "imagenes", maxCount: MAX_IMAGENES_POR_CARGA },
    { name: "imagen", maxCount: 1 },
  ])(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const mensaje = error.code === "LIMIT_FILE_SIZE"
        ? "Cada imagen debe pesar como máximo 10 MB"
        : "La carga de imágenes no es válida";
      return res.status(400).json({ message: mensaje, codigo: error.code });
    }
    return responderError(res, error, "Error al procesar las imágenes");
  });
}

function archivosImagenDe(req) {
  return [...(req.files?.imagenes || []), ...(req.files?.imagen || [])];
}

async function subirImagenTurismo(file, prefijo) {
  const extension = EXTENSION_POR_MIME[file.mimetype];
  const key = `turismo/catalogo/${prefijo}/${Date.now()}_${crypto.randomBytes(10).toString("hex")}.${extension}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return key;
}

async function eliminarImagenS3Seguro(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
  } catch (error) {
    registrarErrorRuta(error);
  }
}

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
    return res.status(409).json({ message: "Ya existe un registro con esos datos", codigo: "CATALOGO_DUPLICADO" });
  }
  registrarErrorRuta(error);
  return res.status(500).json(mensaje);
}

function exigirGestion(req) {
  const cabecera = cabeceraDe(req);
  if (!puedeGestionarTurismo(cabecera)) {
    throw crearErrorCatalogo("No autorizado", 403, "GESTION_TURISMO_NO_AUTORIZADA");
  }
  if (cabecera.rol === "departamental" && !normalizarIdPositivo(cabecera.departamental_id)) {
    throw crearErrorCatalogo("No tenés una departamental asignada", 403, "DEPARTAMENTAL_NO_ASIGNADA");
  }
  return cabecera;
}

function normalizarPaginacion(query, porDefecto = 20) {
  const page = query?.page == null || query.page === "" ? 1 : normalizarIdPositivo(query.page);
  const pageSize = query?.pageSize == null || query.pageSize === "" ? porDefecto : normalizarIdPositivo(query.pageSize);
  if (!page || !pageSize || page > 1_000_000 || pageSize > 100) return null;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parsearIds(valor, maximo = 100) {
  if (valor === undefined || valor === null || valor === "") return [];
  let items = valor;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch (_) { items = items.split(","); }
  }
  if (!Array.isArray(items) || items.length > maximo) return null;
  const ids = items.map((item) => normalizarIdPositivo(typeof item === "object" ? item.id : item));
  if (ids.some((id) => !id)) return null;
  return [...new Set(ids)];
}

function validarServicioPayload(body, { parcial = false } = {}) {
  const nombre = body.nombre === undefined && parcial
    ? undefined
    : normalizarTexto(body.nombre, { nullable: false, maximo: 120 });
  const lugar = body.lugar === undefined && parcial
    ? undefined
    : normalizarTexto(body.lugar, { nullable: false, maximo: 120 });
  const tipoServicioId = body.tipo_servicio_id === undefined && parcial
    ? undefined
    : normalizarIdPositivo(body.tipo_servicio_id);
  const codigo = body.codigo === undefined && parcial
    ? undefined
    : normalizarCodigo(body.codigo, nombre);
  const descripcion = body.descripcion === undefined && parcial
    ? undefined
    : normalizarTexto(body.descripcion, { nullable: true, maximo: 20_000 });
  const provincia = body.provincia === undefined && parcial
    ? undefined
    : normalizarTexto(body.provincia, { nullable: true, maximo: 120 });
  const direccion = body.direccion === undefined && parcial
    ? undefined
    : normalizarTexto(body.direccion, { nullable: true, maximo: 255 });
  const condiciones = body.condiciones === undefined && parcial
    ? undefined
    : normalizarTexto(body.condiciones, { nullable: true, maximo: 60_000 });
  const formularioUrl = body.formulario_adhesion_url === undefined && parcial
    ? undefined
    : normalizarTexto(body.formulario_adhesion_url, { nullable: true, maximo: 1000 });
  const tarifarioUrl = body.tarifario_pdf_url === undefined && parcial
    ? undefined
    : normalizarTexto(body.tarifario_pdf_url, { nullable: true, maximo: 1000 });
  const alcanceRaw = body.alcance_departamental ?? body.alcance ?? (
    body.visible_otras_departamentales === undefined
      ? undefined
      : (normalizarBooleano(body.visible_otras_departamentales) ? "TODAS" : "PROPIA")
  );
  const alcance = alcanceRaw === undefined && parcial
    ? undefined
    : normalizarEnum(alcanceRaw, ALCANCES_DEPARTAMENTALES, "TODAS");
  const modeloTarifa = body.modelo_tarifa === undefined && parcial
    ? undefined
    : normalizarEnum(body.modelo_tarifa, MODELOS_TARIFA, "TEMPORADAS");
  const unidadCobro = body.unidad_cobro === undefined && parcial
    ? undefined
    : normalizarEnum(body.unidad_cobro, UNIDADES_COBRO, "POR_PERSONA_NOCHE");
  const permiteRaw = body.permite_acompanantes ?? (body.captura_personas === undefined
    ? undefined : String(body.captura_personas).toUpperCase() === "GRUPO");
  let permiteAcompanantes = permiteRaw === undefined && parcial
    ? undefined
    : normalizarBooleano(permiteRaw, 1);
  const maxPersonasRaw = body.max_personas_reserva ?? body.capacidad_maxima;
  const maxPersonas = maxPersonasRaw === undefined && parcial
    ? undefined
    : normalizarEnteroNoNegativo(maxPersonasRaw, { nullable: true, maximo: 100_000 });
  const anticipacion = body.anticipacion_minima_dias === undefined && parcial
    ? undefined
    : normalizarEnteroNoNegativo(body.anticipacion_minima_dias, { maximo: 3650 });
  const activo = body.activo === undefined && parcial ? undefined : normalizarBooleano(body.activo, 1);
  const orden = body.orden === undefined && parcial
    ? undefined
    : normalizarEnteroNoNegativo(body.orden, { maximo: 1_000_000 });
  const etiquetaIdentificador = body.etiqueta_identificador === undefined && parcial
    ? undefined
    : normalizarTexto(body.etiqueta_identificador, { nullable: true, maximo: 80 });
  const ratingRaw = body.rating;
  const rating = ratingRaw === undefined && parcial
    ? undefined
    : (ratingRaw === undefined || ratingRaw === null || ratingRaw === "" ? null : Number(ratingRaw));

  if (
    nombre === undefined || lugar === undefined || tipoServicioId === undefined || codigo === null ||
    descripcion === undefined || provincia === undefined || direccion === undefined ||
    condiciones === undefined || formularioUrl === undefined || tarifarioUrl === undefined ||
    alcance === undefined || modeloTarifa === undefined || unidadCobro === undefined ||
    permiteAcompanantes === undefined || maxPersonas === undefined || anticipacion === undefined ||
    activo === undefined || orden === undefined ||
    etiquetaIdentificador === undefined || rating === undefined || (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5))
  ) {
    throw crearErrorCatalogo("Los datos del servicio no son válidos", 400, "SERVICIO_DATOS_INVALIDOS");
  }
  if (formularioUrl && !/^https?:\/\//i.test(formularioUrl)) {
    throw crearErrorCatalogo("El formulario de adhesión debe ser una URL http(s)", 400, "SERVICIO_URL_INVALIDA");
  }
  if (tarifarioUrl && !/^https?:\/\//i.test(tarifarioUrl)) {
    throw crearErrorCatalogo("El tarifario debe ser una URL http(s)", 400, "SERVICIO_TARIFARIO_URL_INVALIDA");
  }
  if (modeloTarifa === "PRECIO_UNICO" && unidadCobro === "POR_PERSONA_NOCHE") {
    throw crearErrorCatalogo("El precio único debe cobrarse por recurso o estadía", 400, "SERVICIO_MODELO_TARIFA_INVALIDO");
  }
  return {
    nombre,
    lugar,
    tipo_servicio_id: tipoServicioId,
    codigo,
    descripcion,
    provincia,
    direccion,
    condiciones,
    formulario_adhesion_url: formularioUrl,
    tarifario_pdf_url: tarifarioUrl,
    alcance_departamental: alcance,
    modelo_tarifa: modeloTarifa,
    unidad_cobro: unidadCobro,
    permite_acompanantes: permiteAcompanantes,
    max_personas_reserva: maxPersonas,
    anticipacion_minima_dias: anticipacion,
    activo,
    orden,
    etiqueta_identificador: etiquetaIdentificador,
    rating,
  };
}

function validarRecursoPayload(body, { parcial = false } = {}) {
  const nombre = body.nombre === undefined && parcial ? undefined : normalizarTexto(body.nombre, { nullable: false, maximo: 120 });
  const codigo = body.codigo === undefined && parcial ? undefined : normalizarCodigo(body.codigo, nombre);
  const categoria = body.categoria === undefined && parcial ? undefined : normalizarTexto(body.categoria, { nullable: true, maximo: 80 });
  const descripcion = body.descripcion === undefined && parcial ? undefined : normalizarTexto(body.descripcion, { nullable: true, maximo: 20_000 });
  const activo = body.activo === undefined && parcial ? undefined : normalizarBooleano(body.activo, 1);
  const orden = body.orden === undefined && parcial ? undefined : normalizarEnteroNoNegativo(body.orden, { maximo: 1_000_000 });
  const cupoRaw = body.cupo_maximo ?? body.capacidad_maxima;
  const cupoMaximo = cupoRaw === undefined && parcial ? undefined : normalizarEnteroNoNegativo(cupoRaw, { nullable: true, maximo: 1_000_000 });
  const principal = body.es_recurso_principal === undefined && parcial ? undefined : normalizarBooleano(body.es_recurso_principal, 0);
  if ([nombre, categoria, descripcion, activo, orden, cupoMaximo, principal].includes(undefined) || codigo === null) {
    throw crearErrorCatalogo("Los datos del recurso no son válidos", 400, "RECURSO_DATOS_INVALIDOS");
  }
  return { nombre, codigo, categoria, descripcion, activo, orden, cupo_maximo: cupoMaximo, es_recurso_principal: principal };
}

async function validarTipoServicio(connection, tipoServicioId) {
  const [rows] = await connection.query(
    "SELECT id, codigo, nombre FROM tipo_servicio WHERE id = ? AND activo = 1 LIMIT 1",
    [tipoServicioId]
  );
  if (!rows.length) throw crearErrorCatalogo("El tipo de servicio no existe o está inactivo", 400, "TIPO_SERVICIO_INVALIDO");
  return rows[0];
}

function aplicarReglasTipoServicio(datos, tipoServicio) {
  if (datos.modelo_tarifa === "PRECIO_UNICO") {
    if (Number(datos.permite_acompanantes) === 1) {
      throw crearErrorCatalogo(
        "El precio único sólo permite reservar para el titular",
        400,
        "PRECIO_UNICO_SOLO_TITULAR"
      );
    }
    datos.permite_acompanantes = 0;
  }
  return datos;
}

async function resolverPayloadTipoServicio(connection, body = {}) {
  if (normalizarIdPositivo(body.tipo_servicio_id)) return body;
  const tipoRaw = body.tipo_codigo ?? body.tipo;
  const tipoId = normalizarIdPositivo(tipoRaw);
  if (tipoId) return { ...body, tipo_servicio_id: tipoId };
  const codigo = normalizarCodigo(tipoRaw);
  if (!codigo) return body;
  const [rows] = await connection.query(
    "SELECT id FROM tipo_servicio WHERE codigo = ? AND activo = 1 LIMIT 1",
    [codigo]
  );
  if (!rows.length) throw crearErrorCatalogo("El tipo de servicio no existe", 400, "TIPO_SERVICIO_INVALIDO");
  return { ...body, tipo_servicio_id: Number(rows[0].id) };
}

function bloqueConvenioDe(body = {}) {
  const bloque = body.convenio_hotel ?? body.convenio;
  if (bloque === undefined || bloque === null) return {};
  if (typeof bloque !== "object" || Array.isArray(bloque)) {
    throw crearErrorCatalogo("Los datos del convenio no son validos", 400, "CONVENIO_DATOS_INVALIDOS");
  }
  return bloque;
}

function integrarConvenioEnPayloadServicio(body = {}) {
  const convenio = bloqueConvenioDe(body);
  if (Object.keys(convenio).length === 0) return body;
  return {
    ...body,
    nombre: body.nombre ?? convenio.nombre,
    lugar: body.lugar ?? convenio.ciudad ?? body.ciudad,
    provincia: body.provincia ?? convenio.provincia,
    direccion: body.direccion ?? convenio.direccion,
    descripcion: body.descripcion ?? convenio.descripcion,
    tarifario_pdf_url: body.tarifario_pdf_url ?? convenio.tarifario_pdf_url,
    activo: body.activo ?? convenio.activo,
  };
}

function tieneDatosEspecificosConvenio(body = {}) {
  return body.convenio_hotel !== undefined || body.convenio !== undefined ||
    body.ciudad !== undefined || body.coordenadas_maps !== undefined ||
    body.latitud !== undefined || body.longitud !== undefined;
}

function validarConvenioEnServicio(body, datosServicio, anterior = null) {
  const convenio = bloqueConvenioDe(body);
  const valor = (campo) => convenio[campo] ?? body[campo] ?? anterior?.[campo];
  const ciudad = normalizarTexto(valor("ciudad") ?? datosServicio.lugar, { nullable: false, maximo: 120 });
  const provincia = normalizarTexto(valor("provincia") ?? datosServicio.provincia, { nullable: false, maximo: 120 });
  const coordenadas = normalizarTexto(valor("coordenadas_maps"), { nullable: false, maximo: 1000 });
  const latitudRaw = valor("latitud");
  const longitudRaw = valor("longitud");
  const latitud = latitudRaw == null || latitudRaw === "" ? null : Number(latitudRaw);
  const longitud = longitudRaw == null || longitudRaw === "" ? null : Number(longitudRaw);
  if (
    !ciudad || !provincia || !coordenadas ||
    (latitud !== null && (!Number.isFinite(latitud) || latitud < -90 || latitud > 90)) ||
    (longitud !== null && (!Number.isFinite(longitud) || longitud < -180 || longitud > 180))
  ) {
    throw crearErrorCatalogo(
      "El convenio requiere ciudad, provincia y coordenadas validas",
      400,
      "CONVENIO_DATOS_INVALIDOS"
    );
  }
  return {
    nombre: datosServicio.nombre,
    ciudad,
    provincia,
    coordenadas_maps: coordenadas,
    latitud,
    longitud,
    descripcion: datosServicio.descripcion,
    activo: datosServicio.activo,
  };
}

async function guardarConvenioEnServicio(connection, servicioId, body, datosServicio, anterior = null) {
  const datos = validarConvenioEnServicio(body, datosServicio, anterior);
  if (anterior) {
    await connection.query(
      `UPDATE convenio_hotel SET nombre = ?, ciudad = ?, provincia = ?, coordenadas_maps = ?,
              latitud = ?, longitud = ?, descripcion = ?, activo = ? WHERE servicio_id = ?`,
      [
        datos.nombre, datos.ciudad, datos.provincia, datos.coordenadas_maps,
        datos.latitud, datos.longitud, datos.descripcion, datos.activo, servicioId,
      ]
    );
  } else {
    await connection.query(
      `INSERT INTO convenio_hotel
         (servicio_id, nombre, ciudad, provincia, coordenadas_maps, latitud, longitud, descripcion, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        servicioId, datos.nombre, datos.ciudad, datos.provincia, datos.coordenadas_maps,
        datos.latitud, datos.longitud, datos.descripcion, datos.activo,
      ]
    );
  }
  return obtenerConvenioServicio(connection, servicioId);
}

async function reemplazarVisibilidad(connection, servicioId, alcance, ids) {
  await connection.query("DELETE FROM servicio_departamental_visible WHERE servicio_id = ?", [servicioId]);
  if (alcance !== "SELECCIONADAS") return;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw crearErrorCatalogo("Seleccioná al menos una departamental", 400, "SERVICIO_ALCANCE_SIN_DEPARTAMENTALES");
  }
  const placeholders = ids.map(() => "?").join(",");
  const [validas] = await connection.query(
    `SELECT id FROM departamental WHERE id IN (${placeholders}) AND habilitado = 'Y'`,
    ids
  );
  if (validas.length !== ids.length) {
    throw crearErrorCatalogo("Hay departamentales inexistentes o inactivas", 400, "SERVICIO_DEPARTAMENTALES_INVALIDAS");
  }
  for (const departamentalId of ids) {
    await connection.query(
      "INSERT INTO servicio_departamental_visible (servicio_id, departamental_id) VALUES (?, ?)",
      [servicioId, departamentalId]
    );
  }
}

async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    "INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)",
    [usuarioId, tipo, titulo, mensaje, JSON.stringify(payload || {})]
  );
}

async function notificarRevisores(connection, servicio, tipo, titulo, mensaje, excluirUsuarioId = null) {
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.habilitado = 'Y'
        AND (r.nombre = 'admin' OR (r.nombre = 'admin-central' AND u.area_turismo = 1))`
  );
  for (const usuario of usuarios) {
    if (excluirUsuarioId && Number(usuario.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, usuario.id, tipo, titulo, mensaje, {
      servicio_id: Number(servicio.id),
      estado_aprobacion: servicio.estado_aprobacion,
      propietario_departamental_id: servicio.propietario_departamental_id || null,
    });
  }
}

async function notificarPropietaria(connection, servicio, tipo, titulo, mensaje, excluirUsuarioId = null) {
  const params = [];
  const condiciones = ["u.habilitado = 'Y'"];
  if (servicio.propietario_departamental_id) {
    condiciones.push("r.nombre = 'departamental'", "u.departamental_id = ?", "u.area_turismo = 1");
    params.push(servicio.propietario_departamental_id);
  } else if (servicio.creado_por_usuario_id) {
    condiciones.push("u.id = ?");
    params.push(servicio.creado_por_usuario_id);
  } else {
    return;
  }
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id WHERE ${condiciones.join(" AND ")}`,
    params
  );
  for (const usuario of usuarios) {
    if (excluirUsuarioId && Number(usuario.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, usuario.id, tipo, titulo, mensaje, {
      servicio_id: Number(servicio.id),
      estado_aprobacion: servicio.estado_aprobacion,
    });
  }
}

async function marcarPendientePorCambioDepartamental(connection, cabecera, servicio) {
  if (cabecera.rol !== "departamental" || servicio.estado_aprobacion === "PENDIENTE") return false;
  const estadoAnterior = servicio.estado_aprobacion;
  await connection.query(
    "UPDATE servicio SET estado_aprobacion = 'PENDIENTE', motivo_revision = NULL, version = version + 1 WHERE id = ?",
    [servicio.id]
  );
  servicio.estado_aprobacion = "PENDIENTE";
  await registrarHistorialTurismo(connection, {
    servicioId: servicio.id,
    entidadTipo: "SERVICIO",
    entidadId: servicio.id,
    operacion: "SUBMIT",
    resumen: `Cambios en “${servicio.nombre}” enviados a aprobación`,
    anterior: { estado_aprobacion: estadoAnterior },
    nuevo: { estado_aprobacion: "PENDIENTE" },
    usuarioId: cabecera.id,
  });
  await notificarRevisores(
    connection,
    servicio,
    "TURISMO_SERVICIO_PENDIENTE",
    `Cambios pendientes en ${servicio.nombre}`,
    `La departamental actualizó el servicio “${servicio.nombre}” y requiere revisión.`,
    cabecera.id
  );
  return true;
}

function permisosServicio(servicio, cabecera) {
  const administrador = esAdministradorTurismo(cabecera);
  const propio = cabecera.rol === "departamental"
    && Number(servicio.propietario_departamental_id) === Number(cabecera.departamental_id);
  return {
    puede_editar: administrador || propio,
    puede_aprobar: administrador && servicio.estado_aprobacion === "PENDIENTE",
    es_propio: propio,
  };
}

function presentarServicio(servicio, cabecera = null) {
  const propietarioDepartamentalId = normalizarIdPositivo(servicio.propietario_departamental_id);
  return {
    ...servicio,
    tipo: servicio.tipo_codigo,
    alcance: servicio.alcance_departamental,
    propietario_tipo: propietarioDepartamentalId ? "DEPARTAMENTAL" : "CENTRAL",
    propietario_nombre: servicio.propietario_departamental_nombre || null,
    captura_personas: Number(servicio.permite_acompanantes) === 1 ? "GRUPO" : "SOLO_TITULAR",
    capacidad_maxima: servicio.max_personas_reserva,
    // Descuento médico (subsidio por salud 100%) ofrecido al reservar este servicio
    descuento_salud_estado: ESTADOS_DESCUENTO_SALUD.has(servicio.descuento_salud_estado)
      ? servicio.descuento_salud_estado
      : "DESHABILITADO",
    descuento_salud_habilitado: servicio.descuento_salud_estado === "HABILITADO",
    descuento_salud_motivo: servicio.descuento_salud_motivo || null,
    descuento_salud_fecha_solicitud: servicio.descuento_salud_fecha_solicitud || null,
    ...(cabecera ? permisosServicio(servicio, cabecera) : {}),
  };
}

async function evaluarConfiguracionServicio(connection, servicio) {
  const [[metricas]] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM imagen_servicio i WHERE i.servicio_id = ?) AS imagenes_servicio,
       (SELECT COUNT(*) FROM recurso r WHERE r.servicio_id = ? AND r.activo = 1) AS recursos_activos,
       (SELECT COUNT(*) FROM recurso r
         WHERE r.servicio_id = ? AND r.activo = 1 AND r.es_recurso_principal = 1) AS recursos_principales,
       (SELECT COUNT(*) FROM recurso_cupo_periodo cp
          INNER JOIN recurso r ON r.id = cp.recurso_id
         WHERE r.servicio_id = ? AND r.activo = 1 AND cp.activo = 1
           AND cp.fecha_fin >= CURDATE()) AS cupos_vigentes,
       (SELECT COUNT(*) FROM turismo_tarifa_regla tr
         WHERE tr.servicio_id = ? AND tr.activo = 1 AND tr.fecha_fin >= CURDATE()) AS reglas_vigentes,
       (SELECT COUNT(*) FROM tarifa t
          INNER JOIN recurso r ON r.id = t.recurso_id
         WHERE r.servicio_id = ? AND r.activo = 1
           AND t.turismo_tarifa_regla_id IS NULL AND t.fecha_fin >= CURDATE()) AS tarifas_legacy_vigentes,
       (SELECT COUNT(*) FROM servicio_departamental_visible sdv
         WHERE sdv.servicio_id = ?) AS departamentales_visibles`,
    Array(7).fill(servicio.id)
  );
  const faltantes = [];
  if (Number(metricas.imagenes_servicio) < 1) {
    faltantes.push("Agrega al menos una imagen del servicio.");
  }
  if (servicio.alcance_departamental === "SELECCIONADAS" && Number(metricas.departamentales_visibles) < 1) {
    faltantes.push("Selecciona al menos una departamental para el alcance elegido.");
  }

  if (servicio.tipo_codigo === "CONVENIO_HOTELERO") {
    const convenio = await obtenerConvenioServicio(connection, servicio.id);
    if (!convenio || !convenio.ciudad || !convenio.provincia || !convenio.coordenadas_maps) {
      faltantes.push("Completa ciudad, provincia y coordenadas del convenio hotelero.");
    }
    if (!servicio.tarifario_pdf_url && !convenio?.tarifario_pdf_archivo) {
      faltantes.push("Agrega el tarifario del convenio hotelero.");
    }
  } else {
    if (Number(metricas.recursos_activos) < 1) {
      faltantes.push("Agrega al menos un recurso activo.");
    }
    if (servicio.tipo_codigo === "CUPO_NUMERADO") {
      if (Number(metricas.recursos_principales) !== 1) {
        faltantes.push("Marca exactamente un recurso activo como principal.");
      }
      if (Number(metricas.cupos_vigentes) < 1) {
        faltantes.push("Configura al menos un periodo de cupo activo y vigente.");
      }
    }
    if (Number(metricas.reglas_vigentes) + Number(metricas.tarifas_legacy_vigentes) < 1) {
      faltantes.push("Configura al menos una tarifa activa y vigente.");
    }
  }
  return {
    configuracion_completa: faltantes.length === 0,
    faltantes_configuracion: faltantes,
    // El editor muestra de donde sale el precio: reglas propias o temporadas.
    reglas_vigentes: Number(metricas.reglas_vigentes || 0),
    tarifas_legacy_vigentes: Number(metricas.tarifas_legacy_vigentes || 0),
    cupos_vigentes: Number(metricas.cupos_vigentes || 0),
  };
}

async function presentarServicioConConfiguracion(connection, servicio, cabecera) {
  const presentado = presentarServicio(servicio, cabecera);
  const configuracion = await evaluarConfiguracionServicio(connection, servicio);
  return {
    ...presentado,
    ...configuracion,
    puede_aprobar: Boolean(presentado.puede_aprobar && configuracion.configuracion_completa),
  };
}

function condicionListadoDepartamental(cabecera, params) {
  if (cabecera.rol !== "departamental") return "1=1";
  const dep = normalizarIdPositivo(cabecera.departamental_id);
  params.push(dep, dep, dep);
  return `(s.propietario_departamental_id = ? OR (
    s.activo = 1 AND s.estado_aprobacion = 'APROBADO' AND (
      s.alcance_departamental = 'TODAS'
      OR (s.alcance_departamental = 'PROPIA' AND s.propietario_departamental_id = ?)
      OR (s.alcance_departamental = 'SELECCIONADAS' AND EXISTS (
        SELECT 1 FROM servicio_departamental_visible sdv
         WHERE sdv.servicio_id = s.id AND sdv.departamental_id = ?
      ))
    )
  ))`;
}

router.get("/gestion/turismo/tipos-servicio", verifyToken, async (req, res) => {
  try {
    exigirGestion(req);
    const [rows] = await mysqlConnection.promise().query(
      "SELECT id, codigo, nombre, descripcion, activo, orden FROM tipo_servicio WHERE activo = 1 ORDER BY orden, nombre"
    );
    return res.status(200).json(rows);
  } catch (error) {
    return responderError(res, error, "Error al obtener tipos de servicio");
  }
});

router.get("/gestion/turismo/tipos", verifyToken, async (req, res) => {
  try {
    exigirGestion(req);
    const [rows] = await mysqlConnection.promise().query(
      "SELECT id, codigo, nombre, descripcion, activo, orden FROM tipo_servicio WHERE activo = 1 ORDER BY orden, nombre"
    );
    return res.status(200).json(rows);
  } catch (error) {
    return responderError(res, error, "Error al obtener tipos de servicio");
  }
});

router.get("/gestion/turismo/departamentales", verifyToken, async (req, res) => {
  try {
    exigirGestion(req);
    const [rows] = await mysqlConnection.promise().query(
      "SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre, id"
    );
    return res.status(200).json(rows);
  } catch (error) {
    return responderError(res, error, "Error al obtener departamentales");
  }
});

router.get("/gestion/turismo/servicios", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const paginacion = normalizarPaginacion(req.query);
    if (!paginacion) throw crearErrorCatalogo("La paginación no es válida", 400, "PAGINACION_INVALIDA");
    const condiciones = [];
    const params = [];
    condiciones.push(condicionListadoDepartamental(cabecera, params));

    const search = normalizarTexto(String(req.query.search || ""), { nullable: true, maximo: 120 });
    if (search) {
      condiciones.push("(s.nombre LIKE ? OR s.codigo LIKE ? OR s.lugar LIKE ? OR ts.nombre LIKE ? OR d.nombre LIKE ?)");
      params.push(...Array(5).fill(`%${search}%`));
    }
    const tipo = normalizarTexto(String(req.query.tipo || ""), { nullable: true, maximo: 80 });
    if (tipo) { condiciones.push("ts.codigo = ?"); params.push(tipo.toUpperCase()); }
    const modelo = normalizarEnum(req.query.modelo_tarifa, MODELOS_TARIFA);
    if (req.query.modelo_tarifa && !modelo) throw crearErrorCatalogo("Modelo de tarifa inválido", 400);
    if (modelo) { condiciones.push("s.modelo_tarifa = ?"); params.push(modelo); }
    const alcance = normalizarEnum(req.query.alcance, ALCANCES_DEPARTAMENTALES);
    if (req.query.alcance && !alcance) throw crearErrorCatalogo("Alcance inválido", 400);
    if (alcance) { condiciones.push("s.alcance_departamental = ?"); params.push(alcance); }
    const ubicacion = normalizarTexto(String(req.query.ubicacion || ""), { nullable: true, maximo: 120 });
    if (ubicacion) { condiciones.push("s.lugar LIKE ?"); params.push(`%${ubicacion}%`); }
    const estado = normalizarEnum(req.query.estado_aprobacion, ESTADOS_APROBACION);
    if (req.query.estado_aprobacion && !estado) throw crearErrorCatalogo("Estado inválido", 400);
    if (estado) { condiciones.push("s.estado_aprobacion = ?"); params.push(estado); }
    const activo = req.query.activo === undefined ? null : normalizarBooleano(req.query.activo);
    if (req.query.activo !== undefined && activo === undefined) throw crearErrorCatalogo("Activo inválido", 400);
    if (activo !== null) { condiciones.push("s.activo = ?"); params.push(activo); }
    const propietaria = req.query.propietario_departamental_id === undefined
      ? null : normalizarIdPositivo(req.query.propietario_departamental_id);
    if (req.query.propietario_departamental_id !== undefined && !propietaria) throw crearErrorCatalogo("Departamental inválida", 400);
    if (propietaria) { condiciones.push("s.propietario_departamental_id = ?"); params.push(propietaria); }
    const propietarioTipo = String(req.query.propietario || "").trim().toUpperCase();
    if (propietarioTipo) {
      if (propietarioTipo === "CENTRAL") condiciones.push("s.propietario_departamental_id IS NULL");
      else if (propietarioTipo === "DEPARTAMENTAL") condiciones.push("s.propietario_departamental_id IS NOT NULL");
      else throw crearErrorCatalogo("Tipo de propietario inválido", 400);
    }
    const vista = String(req.query.vista || "TODOS").toUpperCase();
    if (!new Set(["TODOS", "PROPIOS", "DISPONIBLES"]).has(vista)) throw crearErrorCatalogo("Vista inválida", 400);
    if (cabecera.rol === "departamental" && vista === "PROPIOS") {
      condiciones.push("s.propietario_departamental_id = ?"); params.push(cabecera.departamental_id);
    } else if (cabecera.rol === "departamental" && vista === "DISPONIBLES") {
      condiciones.push("COALESCE(s.propietario_departamental_id, 0) <> ?"); params.push(cabecera.departamental_id);
    }

    const where = condiciones.length ? condiciones.join(" AND ") : "1=1";
    const ordenes = {
      nombre: "s.nombre",
      tipo: "ts.nombre",
      propietario: "d.nombre",
      estado: "s.estado_aprobacion",
      activo: "s.activo",
      fecha_modificacion: "s.fecha_modificacion",
      orden: "s.orden",
    };
    const orderByKey = Object.hasOwn(ordenes, req.query.orderBy) ? req.query.orderBy : "orden";
    const orderType = String(req.query.orderType || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const baseFrom = `FROM servicio s
      INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
      LEFT JOIN departamental d ON d.id = s.propietario_departamental_id`;
    const [rows] = await mysqlConnection.promise().query(
      `SELECT s.*, ts.codigo AS tipo_codigo, ts.nombre AS tipo_nombre,
              d.nombre AS propietario_departamental_nombre,
              (SELECT COUNT(*) FROM recurso r WHERE r.servicio_id = s.id) AS recursos_total,
              (SELECT COUNT(*) FROM recurso r WHERE r.servicio_id = s.id AND r.activo = 1) AS recursos_activos,
              (SELECT COUNT(*) FROM imagen_servicio i WHERE i.servicio_id = s.id) AS imagenes_total
         ${baseFrom}
        WHERE ${where}
        ORDER BY ${ordenes[orderByKey]} ${orderType}, s.id ASC
        LIMIT ? OFFSET ?`,
      [...params, paginacion.pageSize, paginacion.offset]
    );
    const [[conteo]] = await mysqlConnection.promise().query(
      `SELECT COUNT(*) AS total ${baseFrom} WHERE ${where}`,
      params
    );
    const db = mysqlConnection.promise();
    const resultados = await Promise.all(
      rows.map((row) => presentarServicioConConfiguracion(db, row, cabecera))
    );
    return res.status(200).json({
      results: resultados,
      totalItems: Number(conteo.total || 0),
      page: paginacion.page - 1,
      pagina: paginacion.page,
      pageSize: paginacion.pageSize,
      numOfPages: Math.ceil(Number(conteo.total || 0) / paginacion.pageSize),
      orderBy: orderByKey,
      orderType: orderType.toLowerCase(),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener servicios de Turismo");
  }
});

async function asegurarPuedeVerDetalle(connection, cabecera, servicioId) {
  const servicio = await obtenerServicioGestion(connection, servicioId);
  if (!servicio) throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
  if (esAdministradorTurismo(cabecera)) return servicio;
  const propio = Number(servicio.propietario_departamental_id) === Number(cabecera.departamental_id);
  if (propio) return servicio;
  if (servicio.activo !== 1 || servicio.estado_aprobacion !== "APROBADO") {
    throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
  }
  const dep = normalizarIdPositivo(cabecera.departamental_id);
  if (servicio.alcance_departamental === "TODAS") return servicio;
  if (servicio.alcance_departamental === "PROPIA" && Number(servicio.propietario_departamental_id) === dep) return servicio;
  if (servicio.alcance_departamental === "SELECCIONADAS") {
    const [visibles] = await connection.query(
      "SELECT 1 FROM servicio_departamental_visible WHERE servicio_id = ? AND departamental_id = ? LIMIT 1",
      [servicio.id, dep]
    );
    if (visibles.length) return servicio;
  }
  throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
}

async function firmarImagen(row) {
  try {
    const archivoUrl = row.archivo
      ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: row.archivo }), { expiresIn: S3_EXPIRES })
      : null;
    return { id: Number(row.id), archivo: row.archivo, archivo_url: archivoUrl };
  } catch (error) {
    registrarErrorRuta(error);
    return { id: Number(row.id), archivo: row.archivo, archivo_url: null };
  }
}

router.get("/gestion/turismo/servicios/:id", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const db = mysqlConnection.promise();
    const servicio = await asegurarPuedeVerDetalle(db, cabecera, servicioId);
    const [departamentales, imagenesServicio, recursos, imagenesRecurso, filtros, valores, cupos, reglas, convenios, temporadasLegacy] = await Promise.all([
      db.query(`SELECT d.id, d.nombre FROM servicio_departamental_visible sdv
        INNER JOIN departamental d ON d.id = sdv.departamental_id
        WHERE sdv.servicio_id = ? ORDER BY d.nombre`, [servicioId]).then(([rows]) => rows),
      db.query("SELECT id, archivo FROM imagen_servicio WHERE servicio_id = ? ORDER BY id", [servicioId]).then(([rows]) => rows),
      db.query(`SELECT id, servicio_id, codigo, categoria, nombre, descripcion, activo, orden,
                       cupo_maximo, es_recurso_principal, fecha_creacion, fecha_modificacion, version
                  FROM recurso WHERE servicio_id = ? ORDER BY activo DESC, categoria, orden, nombre`, [servicioId]).then(([rows]) => rows),
      db.query(`SELECT ir.id, ir.recurso_id, ir.archivo FROM imagen_recurso ir
        INNER JOIN recurso r ON r.id = ir.recurso_id WHERE r.servicio_id = ? ORDER BY ir.id`, [servicioId]).then(([rows]) => rows),
      db.query(`SELECT f.*, sf.mostrar_en_busqueda, sf.orden AS servicio_orden
        FROM servicio_filtro sf INNER JOIN filtro f ON f.id = sf.filtro_id
        WHERE sf.servicio_id = ? ORDER BY sf.orden, f.orden, f.nombre`, [servicioId]).then(([rows]) => rows),
      db.query(`SELECT fr.*, f.tipo_valor, f.codigo AS filtro_codigo, f.nombre,
                       f.categoria, f.unidad FROM filtro_recurso fr
        INNER JOIN recurso r ON r.id = fr.recurso_id
        INNER JOIN filtro f ON f.id = fr.filtro_id
        WHERE r.servicio_id = ?`, [servicioId]).then(([rows]) => rows),
      db.query(`SELECT rcp.* FROM recurso_cupo_periodo rcp
        INNER JOIN recurso r ON r.id = rcp.recurso_id WHERE r.servicio_id = ?
        ORDER BY rcp.fecha_inicio, rcp.id`, [servicioId]).then(([rows]) => rows),
      db.query(`SELECT * FROM turismo_tarifa_regla WHERE servicio_id = ?
        ORDER BY activo DESC, fecha_inicio, audiencia_departamental, id`, [servicioId]).then(([rows]) => rows),
      db.query("SELECT * FROM convenio_hotel WHERE servicio_id = ? LIMIT 1", [servicioId]).then(([rows]) => rows),
      db.query(
        `SELECT tt.id, tt.nombre,
                DATE_FORMAT(tt.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
                DATE_FORMAT(tt.fecha_fin, '%Y-%m-%d') AS fecha_fin,
                COALESCE(tt.origen, 'GENERAL') AS origen,
                COUNT(DISTINCT t.recurso_id) AS recursos,
                COUNT(DISTINCT t.regimen_id) AS regimenes,
                MIN(t.precio) AS precio_minimo,
                MAX(t.precio) AS precio_maximo,
                (SELECT COUNT(*) FROM tarifa_adicional ta
                  WHERE ta.temporada_tarifa_id = tt.id AND ta.activo = 1
                    AND ta.recurso_id IN (SELECT rr.id FROM recurso rr WHERE rr.servicio_id = ?)) AS adicionales,
                (SELECT bf.id FROM bloque_fecha bf WHERE bf.temporada_tarifa_id = tt.id LIMIT 1) AS bloque_fecha_id
           FROM temporada_tarifa tt
           INNER JOIN tarifa t ON t.temporada_tarifa_id = tt.id
           INNER JOIN recurso r ON r.id = t.recurso_id
          WHERE r.servicio_id = ? AND tt.fecha_fin >= CURDATE()
          GROUP BY tt.id
          ORDER BY tt.fecha_inicio, tt.id`,
        [servicioId, servicioId]
      ).then(([rows]) => rows).catch((error) => {
        registrarErrorRuta(error);
        return [];
      }),
    ]);

    const imagenesServicioFirmadas = await Promise.all(imagenesServicio.map(firmarImagen));
    const imagenesRecursosFirmadas = await Promise.all(imagenesRecurso.map(firmarImagen));
    const imagenesPorRecurso = new Map();
    for (let i = 0; i < imagenesRecurso.length; i += 1) {
      const recursoId = Number(imagenesRecurso[i].recurso_id);
      if (!imagenesPorRecurso.has(recursoId)) imagenesPorRecurso.set(recursoId, []);
      imagenesPorRecurso.get(recursoId).push(imagenesRecursosFirmadas[i]);
    }
    const valoresPorRecurso = new Map();
    for (const valor of valores) {
      const recursoId = Number(valor.recurso_id);
      if (!valoresPorRecurso.has(recursoId)) valoresPorRecurso.set(recursoId, []);
      valoresPorRecurso.get(recursoId).push(valor);
    }
    const cuposPorRecurso = new Map();
    for (const cupo of cupos) {
      const recursoId = Number(cupo.recurso_id);
      if (!cuposPorRecurso.has(recursoId)) cuposPorRecurso.set(recursoId, []);
      cuposPorRecurso.get(recursoId).push(cupo);
    }
    const servicioPresentado = await presentarServicioConConfiguracion(db, servicio, cabecera);
    return res.status(200).json({
      ...servicioPresentado,
      departamentales_visibles: departamentales,
      departamentales,
      imagenes: imagenesServicioFirmadas,
      filtros,
      reglas_tarifa: reglas,
      tarifas: reglas,
      temporadas_legacy: temporadasLegacy.map((temporada) => ({
        ...temporada,
        id: Number(temporada.id),
        recursos: Number(temporada.recursos || 0),
        regimenes: Number(temporada.regimenes || 0),
        adicionales: Number(temporada.adicionales || 0),
        precio_minimo: temporada.precio_minimo === null ? null : Number(temporada.precio_minimo),
        precio_maximo: temporada.precio_maximo === null ? null : Number(temporada.precio_maximo),
        bloque_fecha_id: temporada.bloque_fecha_id === null ? null : Number(temporada.bloque_fecha_id),
      })),
      cupos,
      convenio_hotel: convenios[0] || null,
      recursos: recursos.map((recurso) => ({
        ...recurso,
        imagenes: imagenesPorRecurso.get(Number(recurso.id)) || [],
        caracteristicas: valoresPorRecurso.get(Number(recurso.id)) || [],
        cupos: cuposPorRecurso.get(Number(recurso.id)) || [],
      })),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener el servicio de Turismo");
  }
});

router.post("/gestion/turismo/servicios", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const payloadIntegrado = integrarConvenioEnPayloadServicio(req.body || {});
    const payload = await resolverPayloadTipoServicio(mysqlConnection.promise(), payloadIntegrado);
    const datos = validarServicioPayload(payload);
    const departamentales = parsearIds(
      payload.departamentales_visibles ?? payload.alcance_departamentales ??
      payload.departamentales_ids ?? payload.departamentales
    );
    if (departamentales === null) throw crearErrorCatalogo("La selección de departamentales no es válida", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const tipoServicio = await validarTipoServicio(connection, datos.tipo_servicio_id);
    aplicarReglasTipoServicio(datos, tipoServicio);
    if (tipoServicio.codigo !== "CONVENIO_HOTELERO" && tieneDatosEspecificosConvenio(payload)) {
      throw crearErrorCatalogo(
        "Los datos de convenio solo se admiten para un convenio hotelero",
        400,
        "CONVENIO_TIPO_SERVICIO_INVALIDO"
      );
    }

    let propietaria = payload.propietario_departamental_id == null || payload.propietario_departamental_id === ""
      ? null : normalizarIdPositivo(payload.propietario_departamental_id);
    if (cabecera.rol === "departamental") propietaria = normalizarIdPositivo(cabecera.departamental_id);
    if (payload.propietario_departamental_id != null && payload.propietario_departamental_id !== "" && !propietaria) {
      throw crearErrorCatalogo("La departamental propietaria no es válida", 400);
    }
    if (datos.alcance_departamental === "PROPIA" && !propietaria) {
      throw crearErrorCatalogo("El alcance propio requiere una departamental propietaria", 400);
    }
    // Tambien el alta central comienza como borrador: primero se completa el
    // catalogo y luego se envia a aprobacion de forma explicita.
    const estado = cabecera.rol === "departamental" ? "PENDIENTE" : "BORRADOR";
    if (!estado) throw crearErrorCatalogo("El estado de aprobación no es válido", 400);

    const [resultado] = await connection.query(
      `INSERT INTO servicio
       (tipo_servicio_id, codigo, nombre, lugar, provincia, direccion, rating, descripcion,
        propietario_departamental_id, creado_por_usuario_id, estado_aprobacion, activo,
        alcance_departamental, modelo_tarifa, unidad_cobro, permite_acompanantes,
        max_personas_reserva, anticipacion_minima_dias, etiqueta_identificador, condiciones,
        formulario_adhesion_url, tarifario_pdf_url, orden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.tipo_servicio_id, datos.codigo, datos.nombre, datos.lugar, datos.provincia, datos.direccion,
        datos.rating, datos.descripcion,
        propietaria, cabecera.id, estado, datos.activo, datos.alcance_departamental,
        datos.modelo_tarifa, datos.unidad_cobro, datos.permite_acompanantes,
        datos.max_personas_reserva, datos.anticipacion_minima_dias, datos.etiqueta_identificador,
        datos.condiciones, datos.formulario_adhesion_url, datos.tarifario_pdf_url, datos.orden,
      ]
    );
    const servicioId = Number(resultado.insertId);
    await reemplazarVisibilidad(connection, servicioId, datos.alcance_departamental, departamentales);
    const convenio = tipoServicio.codigo === "CONVENIO_HOTELERO"
      ? await guardarConvenioEnServicio(connection, servicioId, payload, datos)
      : null;
    const creado = await obtenerServicioGestion(connection, servicioId);
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "SERVICIO", entidadId: servicioId, operacion: "CREATE",
      resumen: `Servicio “${datos.nombre}” creado`, nuevo: creado, usuarioId: cabecera.id, req,
    });
    if (convenio) {
      await registrarHistorialTurismo(connection, {
        servicioId, entidadTipo: "CONVENIO_HOTEL", entidadId: convenio.id, operacion: "CREATE",
        resumen: `Convenio creado junto con el servicio: ${datos.nombre}`,
        nuevo: convenio, usuarioId: cabecera.id, req,
      });
    }
    if (estado === "PENDIENTE") {
      await notificarRevisores(
        connection, creado, "TURISMO_SERVICIO_PENDIENTE",
        `Nuevo servicio pendiente: ${datos.nombre}`,
        `La departamental creó “${datos.nombre}” y espera aprobación.`, cabecera.id
      );
    }
    await connection.commit();
    return res.status(201).json({ ...presentarServicio(creado, cabecera), convenio_hotel: convenio });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al crear el servicio de Turismo");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/gestion/turismo/servicios/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const payloadIntegrado = integrarConvenioEnPayloadServicio(req.body || {});
    const payload = await resolverPayloadTipoServicio(mysqlConnection.promise(), payloadIntegrado);
    const datos = validarServicioPayload(payload);
    const departamentales = parsearIds(
      payload.departamentales_visibles ?? payload.alcance_departamentales ??
      payload.departamentales_ids ?? payload.departamentales
    );
    if (departamentales === null) throw crearErrorCatalogo("La selección de departamentales no es válida", 400);
    const version = payload.version === undefined ? null : normalizarEnteroNoNegativo(payload.version, { maximo: Number.MAX_SAFE_INTEGER });
    if (payload.version !== undefined && version === undefined) throw crearErrorCatalogo("Versión inválida", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    if (version !== null && Number(anterior.version) !== version) {
      throw crearErrorCatalogo("El servicio fue modificado por otra persona. Volvé a cargarlo.", 409, "SERVICIO_VERSION_DESACTUALIZADA");
    }
    const tipoServicio = await validarTipoServicio(connection, datos.tipo_servicio_id);
    aplicarReglasTipoServicio(datos, tipoServicio);
    if (tipoServicio.codigo !== "CONVENIO_HOTELERO" && tieneDatosEspecificosConvenio(payload)) {
      throw crearErrorCatalogo(
        "Los datos de convenio solo se admiten para un convenio hotelero",
        400,
        "CONVENIO_TIPO_SERVICIO_INVALIDO"
      );
    }
    const convenioAnterior = await obtenerConvenioServicio(connection, servicioId);
    let propietaria = anterior.propietario_departamental_id;
    if (esAdministradorTurismo(cabecera)) {
      propietaria = payload.propietario_departamental_id == null || payload.propietario_departamental_id === ""
        ? null : normalizarIdPositivo(payload.propietario_departamental_id);
      if (payload.propietario_departamental_id && !propietaria) throw crearErrorCatalogo("Departamental inválida", 400);
    }
    if (datos.alcance_departamental === "PROPIA" && !propietaria) {
      throw crearErrorCatalogo("El alcance propio requiere una departamental propietaria", 400);
    }
    const estado = cabecera.rol === "departamental" ? "PENDIENTE" : anterior.estado_aprobacion;
    const [actualizacion] = await connection.query(
      `UPDATE servicio SET
         tipo_servicio_id = ?, codigo = ?, nombre = ?, lugar = ?, provincia = ?, direccion = ?,
         rating = ?, descripcion = ?,
         propietario_departamental_id = ?, estado_aprobacion = ?, activo = ?, alcance_departamental = ?,
         modelo_tarifa = ?, unidad_cobro = ?, permite_acompanantes = ?, max_personas_reserva = ?,
         anticipacion_minima_dias = ?, etiqueta_identificador = ?, condiciones = ?,
         formulario_adhesion_url = ?, tarifario_pdf_url = ?, motivo_revision = ?,
         orden = ?, version = version + 1
       WHERE id = ? AND version = ?`,
      [
        datos.tipo_servicio_id, datos.codigo, datos.nombre, datos.lugar, datos.provincia, datos.direccion,
        datos.rating, datos.descripcion,
        propietaria, estado, datos.activo, datos.alcance_departamental, datos.modelo_tarifa,
        datos.unidad_cobro, datos.permite_acompanantes, datos.max_personas_reserva,
        datos.anticipacion_minima_dias, datos.etiqueta_identificador, datos.condiciones,
        datos.formulario_adhesion_url, datos.tarifario_pdf_url,
        cabecera.rol === "departamental" ? null : anterior.motivo_revision,
        datos.orden, servicioId, anterior.version,
      ]
    );
    if (Number(actualizacion.affectedRows) !== 1) {
      throw crearErrorCatalogo("El servicio fue modificado por otra persona. Volvé a cargarlo.", 409, "SERVICIO_VERSION_DESACTUALIZADA");
    }
    await reemplazarVisibilidad(connection, servicioId, datos.alcance_departamental, departamentales);
    let convenio = null;
    if (tipoServicio.codigo === "CONVENIO_HOTELERO") {
      convenio = await guardarConvenioEnServicio(connection, servicioId, payload, datos, convenioAnterior);
      await registrarHistorialTurismo(connection, {
        servicioId, entidadTipo: "CONVENIO_HOTEL", entidadId: convenio.id,
        operacion: convenioAnterior ? "UPDATE" : "CREATE",
        resumen: `Convenio “${datos.nombre}” guardado junto con el servicio`,
        anterior: convenioAnterior, nuevo: convenio, usuarioId: cabecera.id, req,
      });
    } else if (convenioAnterior && Number(convenioAnterior.activo) !== 0) {
      await connection.query("UPDATE convenio_hotel SET activo = 0 WHERE servicio_id = ?", [servicioId]);
    }
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await sincronizarMaterializacionesServicio(connection, nuevo);
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "SERVICIO", entidadId: servicioId, operacion: "UPDATE",
      resumen: `Servicio “${datos.nombre}” actualizado`, anterior, nuevo, usuarioId: cabecera.id, req,
    });
    if (cabecera.rol === "departamental" && anterior.estado_aprobacion !== "PENDIENTE") {
      await notificarRevisores(
        connection, nuevo, "TURISMO_SERVICIO_PENDIENTE",
        `Cambios pendientes en ${datos.nombre}`,
        `La departamental actualizó “${datos.nombre}” y requiere revisión.`, cabecera.id
      );
    }
    await connection.commit();
    return res.status(200).json({ ...presentarServicio(nuevo, cabecera), convenio_hotel: convenio });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar el servicio de Turismo");
  } finally {
    if (connection) connection.release();
  }
});

async function cambiarEstadoAprobacion(req, res, estadoDestino) {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    if (!puedeAprobarTurismo(cabecera)) {
      throw crearErrorCatalogo("Solo un administrador puede revisar servicios", 403, "APROBACION_TURISMO_NO_AUTORIZADA");
    }
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const motivo = normalizarTexto(req.body?.motivo, { nullable: true, maximo: 1000 });
    if (req.body?.motivo !== undefined && motivo === undefined) {
      throw crearErrorCatalogo("El motivo no es válido", 400, "APROBACION_MOTIVO_INVALIDO");
    }
    if (estadoDestino === "RECHAZADO" && !motivo) {
      throw crearErrorCatalogo("Indicá el motivo del rechazo", 400, "APROBACION_MOTIVO_REQUERIDO");
    }

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestion(connection, servicioId, { forUpdate: true });
    if (!anterior) throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
    if (anterior.estado_aprobacion !== "PENDIENTE") {
      throw crearErrorCatalogo(
        "Solo se pueden revisar servicios pendientes",
        409,
        "SERVICIO_NO_ESTA_PENDIENTE"
      );
    }
    if (estadoDestino === "APROBADO") {
      const configuracion = await evaluarConfiguracionServicio(connection, anterior);
      if (!configuracion.configuracion_completa) {
        throw crearErrorCatalogo(
          "El servicio todavia tiene configuracion obligatoria pendiente",
          409,
          "SERVICIO_CONFIGURACION_INCOMPLETA",
          { faltantes_configuracion: configuracion.faltantes_configuracion }
        );
      }
    }
    await connection.query(
      "UPDATE servicio SET estado_aprobacion = ?, motivo_revision = ?, version = version + 1 WHERE id = ?",
      [estadoDestino, estadoDestino === "RECHAZADO" ? motivo : null, servicioId]
    );
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await registrarHistorialTurismo(connection, {
      servicioId,
      entidadTipo: "SERVICIO",
      entidadId: servicioId,
      operacion: estadoDestino === "APROBADO" ? "APPROVE" : "REJECT",
      resumen: estadoDestino === "APROBADO"
        ? `Servicio “${nuevo.nombre}” aprobado`
        : `Servicio “${nuevo.nombre}” rechazado: ${motivo}`,
      anterior,
      nuevo: { ...nuevo, motivo: motivo || null },
      usuarioId: cabecera.id,
      req,
    });
    await notificarPropietaria(
      connection,
      nuevo,
      estadoDestino === "APROBADO" ? "TURISMO_SERVICIO_APROBADO" : "TURISMO_SERVICIO_RECHAZADO",
      estadoDestino === "APROBADO" ? "Servicio de Turismo aprobado" : "Servicio de Turismo rechazado",
      estadoDestino === "APROBADO"
        ? `El servicio “${nuevo.nombre}” fue aprobado y ya puede publicarse.`
        : `El servicio “${nuevo.nombre}” fue rechazado. Motivo: ${motivo}`,
      cabecera.id
    );
    await connection.commit();
    return res.status(200).json({ ...presentarServicio(nuevo, cabecera), motivo: motivo || null });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al revisar el servicio de Turismo");
  } finally {
    if (connection) connection.release();
  }
}

router.post("/gestion/turismo/servicios/:id/aprobar", verifyToken, (req, res) =>
  cambiarEstadoAprobacion(req, res, "APROBADO"));

router.post("/gestion/turismo/servicios/:id/rechazar", verifyToken, (req, res) =>
  cambiarEstadoAprobacion(req, res, "RECHAZADO"));

router.post("/gestion/turismo/servicios/:id/aprobacion", verifyToken, async (req, res) => {
  const accion = String(req.body?.estado || req.body?.accion || "").trim().toUpperCase();
  req.body = {
    ...(req.body || {}),
    motivo: req.body?.motivo ?? req.body?.observacion,
  };
  if (["APROBAR", "APROBADO"].includes(accion)) return cambiarEstadoAprobacion(req, res, "APROBADO");
  if (["RECHAZAR", "RECHAZADO", "SOLICITAR_CAMBIOS"].includes(accion)) {
    return cambiarEstadoAprobacion(req, res, "RECHAZADO");
  }
  if (accion !== "ENVIAR" && accion !== "PENDIENTE") {
    return res.status(400).json({ message: "La acción de aprobación no es válida", codigo: "APROBACION_ACCION_INVALIDA" });
  }

  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    if (anterior.estado_aprobacion === "APROBADO") {
      throw crearErrorCatalogo("El servicio ya está aprobado", 409, "SERVICIO_YA_APROBADO");
    }
    await connection.query(
      "UPDATE servicio SET estado_aprobacion = 'PENDIENTE', motivo_revision = NULL, version = version + 1 WHERE id = ?",
      [servicioId]
    );
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "SERVICIO", entidadId: servicioId, operacion: "SUBMIT",
      resumen: `Servicio “${nuevo.nombre}” enviado a aprobación`, anterior, nuevo,
      usuarioId: cabecera.id, req,
    });
    await notificarRevisores(
      connection, nuevo, "TURISMO_SERVICIO_PENDIENTE", `Servicio pendiente: ${nuevo.nombre}`,
      `El servicio “${nuevo.nombre}” fue enviado a aprobación.`, cabecera.id
    );
    await connection.commit();
    return res.status(200).json(presentarServicio(nuevo, cabecera));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al enviar el servicio a aprobación");
  } finally {
    if (connection) connection.release();
  }
});

router.patch("/gestion/turismo/servicios/:id/activo", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const activo = normalizarBooleano(req.body?.activo);
    if (!servicioId || activo === undefined || activo === null) {
      throw crearErrorCatalogo("Los datos no son válidos", 400, "SERVICIO_ACTIVO_INVALIDO");
    }
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    if (activo === 1) {
      const configuracion = await evaluarConfiguracionServicio(connection, anterior);
      if (!configuracion.configuracion_completa) {
        throw crearErrorCatalogo(
          "No se puede habilitar un servicio con configuracion incompleta",
          409,
          "SERVICIO_CONFIGURACION_INCOMPLETA",
          { faltantes_configuracion: configuracion.faltantes_configuracion }
        );
      }
    }
    await connection.query(
      "UPDATE servicio SET activo = ?, version = version + 1 WHERE id = ?",
      [activo, servicioId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...anterior });
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await registrarHistorialTurismo(connection, {
      servicioId,
      entidadTipo: "SERVICIO",
      entidadId: servicioId,
      operacion: activo ? "ENABLE" : "DISABLE",
      resumen: `Servicio “${nuevo.nombre}” ${activo ? "habilitado" : "deshabilitado"}`,
      anterior,
      nuevo,
      usuarioId: cabecera.id,
      req,
    });
    await connection.commit();
    return res.status(200).json(presentarServicio(nuevo, cabecera));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al cambiar el estado del servicio");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/gestion/turismo/servicios/:id", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    await connection.query("UPDATE servicio SET activo = 0, version = version + 1 WHERE id = ?", [servicioId]);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...anterior });
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "SERVICIO", entidadId: servicioId, operacion: "DISABLE",
      resumen: `Servicio “${nuevo.nombre}” deshabilitado`, anterior, nuevo,
      usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json(presentarServicio(nuevo, cabecera));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al deshabilitar el servicio");
  } finally {
    if (connection) connection.release();
  }
});

async function obtenerRecursoAutorizado(connection, cabecera, servicioId, recursoId, { forUpdate = false } = {}) {
  const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate });
  const [rows] = await connection.query(
    `SELECT * FROM recurso WHERE id = ? AND servicio_id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [recursoId, servicioId]
  );
  if (!rows.length) throw crearErrorCatalogo("Recurso no encontrado", 404, "RECURSO_NO_ENCONTRADO");
  return { servicio, recurso: rows[0] };
}

async function reemplazarCaracteristicasInline(connection, servicioId, recursoId, items, { conservarSiAusente = false } = {}) {
  if (items === undefined && conservarSiAusente) {
    const [actuales] = await connection.query(
      "SELECT * FROM filtro_recurso WHERE recurso_id = ? ORDER BY filtro_id",
      [recursoId]
    );
    return actuales;
  }
  const caracteristicas = items ?? [];
  if (!Array.isArray(caracteristicas) || caracteristicas.length > 200) {
    throw crearErrorCatalogo("Las características no son válidas", 400, "CARACTERISTICAS_INVALIDAS");
  }
  const ids = caracteristicas.map((item) => normalizarIdPositivo(item.filtro_id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw crearErrorCatalogo("Hay filtros repetidos o inválidos", 400, "CARACTERISTICAS_FILTROS_INVALIDOS");
  }
  let definiciones = [];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    [definiciones] = await connection.query(
      `SELECT f.* FROM filtro f INNER JOIN servicio_filtro sf ON sf.filtro_id = f.id
        WHERE sf.servicio_id = ? AND f.id IN (${placeholders})`,
      [servicioId, ...ids]
    );
  }
  if (definiciones.length !== ids.length) {
    throw crearErrorCatalogo("Todos los filtros deben pertenecer al servicio", 400, "CARACTERISTICA_FILTRO_NO_ASOCIADO");
  }
  const porId = new Map(definiciones.map((filtro) => [Number(filtro.id), filtro]));
  const normalizadas = caracteristicas.map((item) => {
    const resultado = normalizarValorFiltro(porId.get(Number(item.filtro_id)), item);
    if (resultado.error) throw crearErrorCatalogo(resultado.error, 400, "CARACTERISTICA_VALOR_INVALIDO");
    return { filtro_id: Number(item.filtro_id), recurso_id: recursoId, ...resultado.value };
  });
  await connection.query("DELETE FROM filtro_recurso WHERE recurso_id = ?", [recursoId]);
  for (const item of normalizadas) {
    await connection.query(
      `INSERT INTO filtro_recurso (filtro_id, recurso_id, valor_numero, valor_booleano, valor_texto)
       VALUES (?, ?, ?, ?, ?)`,
      [item.filtro_id, recursoId, item.valor_numero, item.valor_booleano, item.valor_texto]
    );
  }
  return normalizadas;
}

router.post("/gestion/turismo/servicios/:id/recursos", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarRecursoPayload(req.body || {});
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    if (datos.es_recurso_principal) {
      await connection.query(
        "UPDATE recurso SET es_recurso_principal = 0, version = version + 1 WHERE servicio_id = ? AND es_recurso_principal = 1",
        [servicioId]
      );
    }
    const [resultado] = await connection.query(
      `INSERT INTO recurso
         (servicio_id, codigo, categoria, nombre, descripcion, activo, orden, cupo_maximo, es_recurso_principal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        servicioId, datos.codigo, datos.categoria, datos.nombre, datos.descripcion,
        datos.activo, datos.orden, datos.cupo_maximo, datos.es_recurso_principal,
      ]
    );
    const recursoId = Number(resultado.insertId);
    const caracteristicas = await reemplazarCaracteristicasInline(
      connection, servicioId, recursoId, req.body?.caracteristicas
    );
    const [rows] = await connection.query("SELECT * FROM recurso WHERE id = ?", [recursoId]);
    const nuevo = { ...rows[0], caracteristicas };
    await sincronizarMaterializacionesServicio(connection, servicio);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId,
      recursoId,
      entidadTipo: "RECURSO",
      entidadId: recursoId,
      operacion: "CREATE",
      resumen: `Recurso “${nuevo.nombre}” creado`,
      nuevo,
      usuarioId: cabecera.id,
      req,
    });
    await connection.commit();
    return res.status(201).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al crear el recurso");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/gestion/turismo/servicios/:id/recursos/:recursoId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    if (!servicioId || !recursoId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarRecursoPayload(req.body || {});
    const version = req.body.version === undefined
      ? null
      : normalizarEnteroNoNegativo(req.body.version, { maximo: Number.MAX_SAFE_INTEGER });
    if (req.body.version !== undefined && version === undefined) throw crearErrorCatalogo("Versión inválida", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio, recurso: anterior } = await obtenerRecursoAutorizado(
      connection, cabecera, servicioId, recursoId, { forUpdate: true }
    );
    if (version !== null && Number(anterior.version) !== version) {
      throw crearErrorCatalogo("El recurso fue modificado por otra persona. Volvé a cargarlo.", 409, "RECURSO_VERSION_DESACTUALIZADA");
    }
    if (datos.es_recurso_principal) {
      await connection.query(
        "UPDATE recurso SET es_recurso_principal = 0, version = version + 1 WHERE servicio_id = ? AND id <> ? AND es_recurso_principal = 1",
        [servicioId, recursoId]
      );
    }
    const [actualizacion] = await connection.query(
      `UPDATE recurso SET codigo = ?, categoria = ?, nombre = ?, descripcion = ?, activo = ?,
              orden = ?, cupo_maximo = ?, es_recurso_principal = ?, version = version + 1
        WHERE id = ? AND servicio_id = ? AND version = ?`,
      [
        datos.codigo, datos.categoria, datos.nombre, datos.descripcion, datos.activo,
        datos.orden, datos.cupo_maximo, datos.es_recurso_principal,
        recursoId, servicioId, anterior.version,
      ]
    );
    if (Number(actualizacion.affectedRows) !== 1) {
      throw crearErrorCatalogo("El recurso fue modificado por otra persona. Volvé a cargarlo.", 409, "RECURSO_VERSION_DESACTUALIZADA");
    }
    const caracteristicas = await reemplazarCaracteristicasInline(
      connection, servicioId, recursoId, req.body?.caracteristicas, { conservarSiAusente: true }
    );
    const [rows] = await connection.query("SELECT * FROM recurso WHERE id = ?", [recursoId]);
    const nuevo = { ...rows[0], caracteristicas };
    await sincronizarMaterializacionesServicio(connection, servicio);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId,
      recursoId,
      entidadTipo: "RECURSO",
      entidadId: recursoId,
      operacion: "UPDATE",
      resumen: `Recurso “${nuevo.nombre}” actualizado`,
      anterior,
      nuevo,
      usuarioId: cabecera.id,
      req,
    });
    await connection.commit();
    return res.status(200).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar el recurso");
  } finally {
    if (connection) connection.release();
  }
});

router.patch("/gestion/turismo/servicios/:id/recursos/:recursoId/activo", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    const activo = normalizarBooleano(req.body?.activo);
    if (!servicioId || !recursoId || activo === undefined || activo === null) {
      throw crearErrorCatalogo("Los datos no son válidos", 400, "RECURSO_ACTIVO_INVALIDO");
    }
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio, recurso: anterior } = await obtenerRecursoAutorizado(
      connection, cabecera, servicioId, recursoId, { forUpdate: true }
    );
    await connection.query(
      "UPDATE recurso SET activo = ?, version = version + 1 WHERE id = ? AND servicio_id = ?",
      [activo, recursoId, servicioId]
    );
    const [rows] = await connection.query("SELECT * FROM recurso WHERE id = ?", [recursoId]);
    const nuevo = rows[0];
    await sincronizarMaterializacionesServicio(connection, servicio);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId,
      recursoId,
      entidadTipo: "RECURSO",
      entidadId: recursoId,
      operacion: activo ? "ENABLE" : "DISABLE",
      resumen: `Recurso “${nuevo.nombre}” ${activo ? "habilitado" : "deshabilitado"}`,
      anterior,
      nuevo,
      usuarioId: cabecera.id,
      req,
    });
    await connection.commit();
    return res.status(200).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al cambiar el estado del recurso");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/gestion/turismo/servicios/:id/recursos/:recursoId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    if (!servicioId || !recursoId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio, recurso: anterior } = await obtenerRecursoAutorizado(
      connection, cabecera, servicioId, recursoId, { forUpdate: true }
    );
    await connection.query(
      "UPDATE recurso SET activo = 0, version = version + 1 WHERE id = ? AND servicio_id = ?",
      [recursoId, servicioId]
    );
    const [rows] = await connection.query("SELECT * FROM recurso WHERE id = ?", [recursoId]);
    const nuevo = rows[0];
    await sincronizarMaterializacionesServicio(connection, servicio);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId, entidadTipo: "RECURSO", entidadId: recursoId, operacion: "DISABLE",
      resumen: `Recurso “${nuevo.nombre}” deshabilitado`, anterior, nuevo,
      usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al deshabilitar el recurso");
  } finally {
    if (connection) connection.release();
  }
});

function validarFiltroPayload(body, { parcial = false } = {}) {
  const nombre = body.nombre === undefined && parcial ? undefined : normalizarTexto(body.nombre, { nullable: false, maximo: 120 });
  const codigo = body.codigo === undefined && parcial ? undefined : normalizarCodigo(body.codigo, nombre);
  const tipoValor = body.tipo_valor === undefined && parcial
    ? undefined
    : normalizarEnum(body.tipo_valor, TIPOS_FILTRO, "TEXTO");
  const categoria = body.categoria === undefined && parcial ? undefined : normalizarTexto(body.categoria, { nullable: true, maximo: 80 });
  const unidad = body.unidad === undefined && parcial ? undefined : normalizarTexto(body.unidad, { nullable: true, maximo: 40 });
  const ayuda = body.ayuda === undefined && parcial ? undefined : normalizarTexto(body.ayuda, { nullable: true, maximo: 500 });
  // Nombre de icono de Material Symbols (p. ej. "king_bed"); vacio = el front infiere uno.
  const iconoRaw = body.icono === undefined && parcial ? undefined : normalizarTexto(body.icono, { nullable: true, maximo: 60 });
  const icono = iconoRaw === undefined
    ? undefined
    : (iconoRaw === null ? null : (/^[a-z0-9_]{1,60}$/.test(iconoRaw.toLowerCase()) ? iconoRaw.toLowerCase() : undefined));
  const activo = body.activo === undefined && parcial ? undefined : normalizarBooleano(body.activo, 1);
  const orden = body.orden === undefined && parcial ? undefined : normalizarEnteroNoNegativo(body.orden, { maximo: 1_000_000 });
  let opciones = body.opciones;
  if (opciones === undefined && parcial) opciones = undefined;
  else if (opciones == null || opciones === "") opciones = [];
  else if (typeof opciones === "string") {
    try { opciones = JSON.parse(opciones); } catch (_) { opciones = null; }
  }
  if (
    nombre === undefined || codigo === null || tipoValor === undefined || categoria === undefined ||
    unidad === undefined || ayuda === undefined || icono === undefined || activo === undefined || orden === undefined ||
    (opciones !== undefined && (!Array.isArray(opciones) || opciones.length > 100))
  ) {
    throw crearErrorCatalogo("Los datos del filtro no son válidos", 400, "FILTRO_DATOS_INVALIDOS");
  }
  if (opciones !== undefined) {
    opciones = opciones.map((opcion) => {
      if (typeof opcion === "string") return opcion.trim();
      if (opcion && typeof opcion === "object") return opcion;
      return null;
    });
    if (opciones.some((opcion) => opcion == null || opcion === "")) {
      throw crearErrorCatalogo("Las opciones del filtro no son válidas", 400, "FILTRO_OPCIONES_INVALIDAS");
    }
  }
  if (tipoValor !== undefined && tipoValor !== "OPCION" && opciones?.length) {
    throw crearErrorCatalogo("Solo los filtros de tipo opción admiten opciones", 400, "FILTRO_OPCIONES_NO_APLICAN");
  }
  if (tipoValor === "OPCION" && opciones !== undefined && opciones.length === 0) {
    throw crearErrorCatalogo("Agregá al menos una opción", 400, "FILTRO_OPCIONES_REQUERIDAS");
  }
  return { nombre, codigo, tipo_valor: tipoValor, categoria, unidad, ayuda, icono, opciones, activo, orden };
}

router.get("/gestion/turismo/servicios/:id/recursos", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const db = mysqlConnection.promise();
    await asegurarPuedeVerDetalle(db, cabecera, servicioId);
    const [recursos, valores, imagenes] = await Promise.all([
      db.query(
        `SELECT * FROM recurso WHERE servicio_id = ?
         ORDER BY activo DESC, categoria, orden, nombre, id`,
        [servicioId]
      ).then(([rows]) => rows),
      db.query(
        `SELECT fr.*, f.nombre, f.codigo, f.categoria, f.tipo_valor, f.unidad
           FROM filtro_recurso fr INNER JOIN filtro f ON f.id = fr.filtro_id
           INNER JOIN recurso r ON r.id = fr.recurso_id WHERE r.servicio_id = ?
          ORDER BY f.categoria, f.orden, f.nombre`,
        [servicioId]
      ).then(([rows]) => rows),
      db.query(
        `SELECT ir.id, ir.recurso_id, ir.archivo FROM imagen_recurso ir
          INNER JOIN recurso r ON r.id = ir.recurso_id WHERE r.servicio_id = ? ORDER BY ir.id`,
        [servicioId]
      ).then(([rows]) => rows),
    ]);
    const imagenesFirmadas = await Promise.all(imagenes.map(firmarImagen));
    return res.status(200).json(recursos.map((recurso) => ({
      ...recurso,
      capacidad_maxima: recurso.cupo_maximo,
      caracteristicas: valores.filter((valor) => Number(valor.recurso_id) === Number(recurso.id)),
      imagenes: imagenesFirmadas.filter((_, indice) => Number(imagenes[indice].recurso_id) === Number(recurso.id)),
    })));
  } catch (error) {
    return responderError(res, error, "Error al obtener recursos de Turismo");
  }
});

router.get("/gestion/turismo/servicios/:id/filtros", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const db = mysqlConnection.promise();
    await asegurarPuedeVerDetalle(db, cabecera, servicioId);
    const [rows] = await db.query(
      `SELECT f.*, sf.mostrar_en_busqueda, sf.orden AS servicio_orden
         FROM servicio_filtro sf INNER JOIN filtro f ON f.id = sf.filtro_id
        WHERE sf.servicio_id = ? ORDER BY sf.orden, f.orden, f.nombre`,
      [servicioId]
    );
    return res.status(200).json(rows.map((row) => ({
      ...row,
      servicio_id: servicioId,
      grupo: row.categoria,
      tipo: row.tipo_valor,
      visible_busqueda: Boolean(row.mostrar_en_busqueda),
    })));
  } catch (error) {
    return responderError(res, error, "Error al obtener filtros del servicio");
  }
});

router.get("/gestion/turismo/servicios/:id/tarifas", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const db = mysqlConnection.promise();
    const servicio = await asegurarPuedeVerDetalle(db, cabecera, servicioId);
    const [rows] = await db.query(
      `SELECT tr.*, r.nombre AS recurso_nombre
         FROM turismo_tarifa_regla tr LEFT JOIN recurso r ON r.id = tr.recurso_id
        WHERE tr.servicio_id = ?
        ORDER BY tr.activo DESC, tr.fecha_inicio, tr.audiencia_departamental, tr.id`,
      [servicioId]
    );
    return res.status(200).json(rows.map((row) => ({
      ...row,
      tipo_temporada: row.temporada,
      unidad_cobro: servicio.unidad_cobro,
    })));
  } catch (error) {
    return responderError(res, error, "Error al obtener tarifas del servicio");
  }
});

router.get("/gestion/turismo/servicios/:id/cupos", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const db = mysqlConnection.promise();
    await asegurarPuedeVerDetalle(db, cabecera, servicioId);
    const [rows] = await db.query(
      `SELECT cp.*, r.servicio_id, r.nombre AS recurso_nombre
         FROM recurso_cupo_periodo cp INNER JOIN recurso r ON r.id = cp.recurso_id
        WHERE r.servicio_id = ? ORDER BY cp.fecha_inicio, r.orden, r.nombre, cp.id`,
      [servicioId]
    );
    return res.status(200).json(rows.map((row) => ({ ...row, cantidad_total: row.cupo_total })));
  } catch (error) {
    return responderError(res, error, "Error al obtener cupos del servicio");
  }
});

async function resolverRecursoParaCupo(connection, servicioId, recursoIdRaw = null) {
  const recursoId = recursoIdRaw == null || recursoIdRaw === "" ? null : normalizarIdPositivo(recursoIdRaw);
  if (recursoIdRaw != null && recursoIdRaw !== "" && !recursoId) {
    throw crearErrorCatalogo("Recurso inválido", 400, "CUPO_RECURSO_INVALIDO");
  }
  const params = [servicioId];
  const filtro = recursoId ? "AND id = ?" : "";
  if (recursoId) params.push(recursoId);
  const [rows] = await connection.query(
    `SELECT * FROM recurso WHERE servicio_id = ? ${filtro}
      ORDER BY es_recurso_principal DESC, activo DESC, orden, id LIMIT 1`,
    params
  );
  if (!rows.length) {
    throw crearErrorCatalogo(
      recursoId ? "El recurso no pertenece al servicio" : "Creá un recurso principal antes de configurar cupos",
      400,
      "CUPO_RECURSO_INVALIDO"
    );
  }
  return rows[0];
}

router.post("/gestion/turismo/servicios/:id/cupos", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarCupoPayload({ ...req.body, cupo_total: req.body?.cupo_total ?? req.body?.cantidad_total });
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const recurso = await resolverRecursoParaCupo(connection, servicioId, req.body?.recurso_id);
    await asegurarCupoSinSolapamiento(connection, recurso.id, datos);
    const [resultado] = await connection.query(
      `INSERT INTO recurso_cupo_periodo (recurso_id, fecha_inicio, fecha_fin, cupo_total, activo)
       VALUES (?, ?, ?, ?, ?)`,
      [recurso.id, datos.fecha_inicio, datos.fecha_fin, datos.cupo_total, datos.activo]
    );
    const cupoId = Number(resultado.insertId);
    const [[nuevo]] = await connection.query("SELECT * FROM recurso_cupo_periodo WHERE id = ?", [cupoId]);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId: recurso.id, entidadTipo: "CUPO", entidadId: cupoId, operacion: "CREATE",
      resumen: `Cupo de ${datos.cupo_total} creado para ${recurso.nombre}`,
      nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(201).json({ ...nuevo, servicio_id: servicioId, cantidad_total: nuevo.cupo_total });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al crear el cupo");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/gestion/turismo/servicios/:id/cupos/:cupoId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const cupoId = normalizarIdPositivo(req.params.cupoId);
    if (!servicioId || !cupoId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarCupoPayload({ ...req.body, cupo_total: req.body?.cupo_total ?? req.body?.cantidad_total });
    const version = req.body.version === undefined ? null : normalizarEnteroNoNegativo(req.body.version, { maximo: Number.MAX_SAFE_INTEGER });
    if (req.body.version !== undefined && version === undefined) throw crearErrorCatalogo("Versión inválida", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      `SELECT cp.* FROM recurso_cupo_periodo cp INNER JOIN recurso r ON r.id = cp.recurso_id
        WHERE cp.id = ? AND r.servicio_id = ? FOR UPDATE`,
      [cupoId, servicioId]
    );
    if (!anterior) throw crearErrorCatalogo("Cupo no encontrado", 404, "CUPO_NO_ENCONTRADO");
    if (version !== null && Number(anterior.version) !== version) throw crearErrorCatalogo("El cupo fue modificado", 409, "CUPO_VERSION_DESACTUALIZADA");
    const recurso = req.body?.recurso_id == null
      ? { id: anterior.recurso_id }
      : await resolverRecursoParaCupo(connection, servicioId, req.body.recurso_id);
    await asegurarCupoSinSolapamiento(connection, recurso.id, datos, cupoId);
    await connection.query(
      `UPDATE recurso_cupo_periodo SET recurso_id = ?, fecha_inicio = ?, fecha_fin = ?,
              cupo_total = ?, activo = ?, version = version + 1 WHERE id = ?`,
      [recurso.id, datos.fecha_inicio, datos.fecha_fin, datos.cupo_total, datos.activo, cupoId]
    );
    const [[nuevo]] = await connection.query("SELECT * FROM recurso_cupo_periodo WHERE id = ?", [cupoId]);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId: recurso.id, entidadTipo: "CUPO", entidadId: cupoId, operacion: "UPDATE",
      resumen: `Cupo actualizado para ${datos.fecha_inicio} a ${datos.fecha_fin}`,
      anterior, nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ ...nuevo, servicio_id: servicioId, cantidad_total: nuevo.cupo_total });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar el cupo");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/gestion/turismo/servicios/:id/cupos/:cupoId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const cupoId = normalizarIdPositivo(req.params.cupoId);
    if (!servicioId || !cupoId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      `SELECT cp.* FROM recurso_cupo_periodo cp INNER JOIN recurso r ON r.id = cp.recurso_id
        WHERE cp.id = ? AND r.servicio_id = ? FOR UPDATE`,
      [cupoId, servicioId]
    );
    if (!anterior) throw crearErrorCatalogo("Cupo no encontrado", 404, "CUPO_NO_ENCONTRADO");
    await connection.query(
      "UPDATE recurso_cupo_periodo SET activo = 0, version = version + 1 WHERE id = ?",
      [cupoId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId: anterior.recurso_id, entidadTipo: "CUPO", entidadId: cupoId, operacion: "DISABLE",
      resumen: "Período de cupo deshabilitado", anterior, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ id: cupoId, activo: 0 });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al deshabilitar el cupo");
  } finally {
    if (connection) connection.release();
  }
});

function validarCupoPayload(body) {
  const fechaInicio = normalizarFechaCivil(body.fecha_inicio);
  const fechaFin = normalizarFechaCivil(body.fecha_fin);
  const cupoTotal = normalizarIdPositivo(body.cupo_total);
  const activo = normalizarBooleano(body.activo, 1);
  if (!fechaInicio || !fechaFin || fechaInicio > fechaFin || !cupoTotal || activo === undefined) {
    throw crearErrorCatalogo("Los datos del cupo no son válidos", 400, "CUPO_DATOS_INVALIDOS");
  }
  return { fecha_inicio: fechaInicio, fecha_fin: fechaFin, cupo_total: cupoTotal, activo };
}

function validarReglaTarifaPayload(body, servicio) {
  const nombre = normalizarTexto(body.nombre, { nullable: false, maximo: 120 });
  const temporada = normalizarEnum(body.temporada, TEMPORADAS_REGLA, "PERSONALIZADA");
  const fechaInicio = normalizarFechaCivil(body.fecha_inicio);
  const fechaFin = normalizarFechaCivil(body.fecha_fin);
  const audiencia = normalizarEnum(body.audiencia_departamental, AUDIENCIAS_DEPARTAMENTALES, "TODAS");
  const recursoId = body.recurso_id == null || body.recurso_id === "" ? null : normalizarIdPositivo(body.recurso_id);
  const precioCentavos = decimalACentavos(body.precio, { permiteCero: false });
  const porcentajePuntos = decimalACentavos(body.porcentaje_descuento ?? 0, { permiteCero: true });
  let precioPorPersona = normalizarBooleano(body.precio_por_persona, servicio.modelo_tarifa === "PRECIO_UNICO" ? 0 : 1);
  const activo = normalizarBooleano(body.activo, 1);
  if (
    !nombre || !temporada || !fechaInicio || !fechaFin || fechaInicio > fechaFin || !audiencia ||
    (body.recurso_id != null && body.recurso_id !== "" && !recursoId) || precioCentavos === null ||
    porcentajePuntos === null || porcentajePuntos > 10_000 || precioPorPersona === undefined || activo === undefined
  ) {
    throw crearErrorCatalogo("Los datos de la tarifa no son válidos", 400, "TARIFA_REGLA_DATOS_INVALIDOS");
  }
  if (servicio.modelo_tarifa === "PRECIO_UNICO" || servicio.unidad_cobro !== "POR_PERSONA_NOCHE") {
    precioPorPersona = 0;
  } else {
    precioPorPersona = 1;
  }
  return {
    nombre,
    temporada,
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFin,
    audiencia_departamental: audiencia,
    recurso_id: recursoId,
    precio: centavosANumero(precioCentavos),
    porcentaje_descuento: centavosANumero(porcentajePuntos),
    precio_por_persona: precioPorPersona,
    activo,
  };
}

router.get("/gestion/turismo/filtros", verifyToken, async (req, res) => {
  try {
    exigirGestion(req);
    const incluirInactivos = normalizarBooleano(req.query.incluir_inactivos, 0);
    if (incluirInactivos === undefined) throw crearErrorCatalogo("Parámetro inválido", 400);
    const [rows] = await mysqlConnection.promise().query(
      `SELECT f.*, (SELECT COUNT(*) FROM servicio_filtro sf WHERE sf.filtro_id = f.id) AS servicios_total
         FROM filtro f ${incluirInactivos ? "" : "WHERE f.activo = 1"}
        ORDER BY f.categoria, f.orden, f.nombre`
    );
    return res.status(200).json(rows);
  } catch (error) {
    return responderError(res, error, "Error al obtener filtros de Turismo");
  }
});

router.post("/gestion/turismo/servicios/:id/filtros", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const filtroExistenteId = req.body?.filtro_id == null || req.body.filtro_id === ""
      ? null : normalizarIdPositivo(req.body.filtro_id);
    if (req.body?.filtro_id != null && req.body.filtro_id !== "" && !filtroExistenteId) {
      throw crearErrorCatalogo("Filtro inválido", 400);
    }
    const datos = filtroExistenteId ? null : validarFiltroPayload(req.body || {});
    const mostrar = normalizarBooleano(req.body?.mostrar_en_busqueda, 1);
    const servicioOrden = normalizarEnteroNoNegativo(req.body?.servicio_orden ?? req.body?.orden, { maximo: 1_000_000 });
    if (mostrar === undefined || servicioOrden === undefined) throw crearErrorCatalogo("Configuración inválida", 400);

    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    let filtroId = filtroExistenteId;
    if (filtroId) {
      const [existentes] = await connection.query("SELECT * FROM filtro WHERE id = ? LIMIT 1", [filtroId]);
      if (!existentes.length) throw crearErrorCatalogo("Filtro no encontrado", 404, "FILTRO_NO_ENCONTRADO");
    } else {
      const [resultado] = await connection.query(
        `INSERT INTO filtro (codigo, nombre, tipo_valor, categoria, unidad, ayuda, icono, opciones, activo, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          datos.codigo, datos.nombre, datos.tipo_valor, datos.categoria, datos.unidad,
          datos.ayuda, datos.icono, JSON.stringify(datos.opciones || []), datos.activo, datos.orden,
        ]
      );
      filtroId = Number(resultado.insertId);
    }
    await connection.query(
      `INSERT INTO servicio_filtro (servicio_id, filtro_id, mostrar_en_busqueda, orden)
       VALUES (?, ?, ?, ?)`,
      [servicioId, filtroId, mostrar, servicioOrden]
    );
    const [[nuevo]] = await connection.query(
      `SELECT f.*, sf.mostrar_en_busqueda, sf.orden AS servicio_orden
         FROM filtro f INNER JOIN servicio_filtro sf ON sf.filtro_id = f.id
        WHERE sf.servicio_id = ? AND sf.filtro_id = ?`,
      [servicioId, filtroId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "FILTRO", entidadId: filtroId, operacion: "CREATE",
      resumen: `Filtro “${nuevo.nombre}” agregado`, nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(201).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al agregar el filtro");
  } finally {
    if (connection) connection.release();
  }
});

async function codigoDisponibleParaClonFiltro(connection, codigoSolicitado, servicioId) {
  const baseSolicitada = normalizarCodigo(codigoSolicitado);
  const baseServicio = normalizarCodigo(`${baseSolicitada || "FILTRO"}_S${servicioId}`);
  for (let intento = 0; intento < 100; intento += 1) {
    const candidato = intento === 0 && baseSolicitada
      ? baseSolicitada
      : `${baseServicio.slice(0, Math.max(1, 74 - String(intento || "").length))}${intento ? `_${intento}` : ""}`;
    const [existentes] = await connection.query(
      "SELECT id FROM filtro WHERE codigo = ? LIMIT 1",
      [candidato]
    );
    if (!existentes.length) return candidato;
  }
  throw crearErrorCatalogo("No se pudo generar un código único para el filtro", 409, "FILTRO_CODIGO_NO_DISPONIBLE");
}

router.put("/gestion/turismo/servicios/:id/filtros/:filtroId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    let filtroId = normalizarIdPositivo(req.params.filtroId);
    if (!servicioId || !filtroId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarFiltroPayload(req.body || {});
    const mostrar = normalizarBooleano(req.body?.mostrar_en_busqueda, 1);
    const servicioOrden = normalizarEnteroNoNegativo(req.body?.servicio_orden ?? req.body?.orden, { maximo: 1_000_000 });
    if (mostrar === undefined || servicioOrden === undefined) throw crearErrorCatalogo("Configuración inválida", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      `SELECT f.*, sf.mostrar_en_busqueda, sf.orden AS servicio_orden,
              (SELECT COUNT(*) FROM servicio_filtro x WHERE x.filtro_id = f.id) AS servicios_total
         FROM filtro f INNER JOIN servicio_filtro sf ON sf.filtro_id = f.id
        WHERE sf.servicio_id = ? AND sf.filtro_id = ? FOR UPDATE`,
      [servicioId, filtroId]
    );
    if (!anterior) throw crearErrorCatalogo("Filtro no encontrado", 404, "FILTRO_NO_ENCONTRADO");
    let clonarDefinicion = false;
    if (Number(anterior.servicios_total) > 1) {
      let opcionesAnteriores = anterior.opciones;
      if (typeof opcionesAnteriores === "string") {
        try { opcionesAnteriores = JSON.parse(opcionesAnteriores); } catch (_) { opcionesAnteriores = []; }
      }
      const definicionAnterior = {
        codigo: anterior.codigo,
        nombre: anterior.nombre,
        tipo_valor: anterior.tipo_valor,
        categoria: anterior.categoria || null,
        unidad: anterior.unidad || null,
        ayuda: anterior.ayuda || null,
        icono: anterior.icono || null,
        opciones: Array.isArray(opcionesAnteriores) ? opcionesAnteriores : [],
        activo: Number(anterior.activo),
        orden: Number(anterior.orden || 0),
      };
      const definicionNueva = {
        codigo: datos.codigo,
        nombre: datos.nombre,
        tipo_valor: datos.tipo_valor,
        categoria: datos.categoria || null,
        unidad: datos.unidad || null,
        ayuda: datos.ayuda || null,
        icono: datos.icono || null,
        opciones: datos.opciones || [],
        activo: Number(datos.activo),
        orden: Number(datos.orden || 0),
      };
      if (JSON.stringify(definicionAnterior) !== JSON.stringify(definicionNueva)) {
        clonarDefinicion = true;
      }
    }
    if (clonarDefinicion) {
      const filtroIdOrigen = filtroId;
      const codigoClonado = await codigoDisponibleParaClonFiltro(
        connection, datos.codigo, servicioId
      );
      const [resultadoClon] = await connection.query(
        `INSERT INTO filtro (codigo, nombre, tipo_valor, categoria, unidad, ayuda, icono, opciones, activo, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigoClonado, datos.nombre, datos.tipo_valor, datos.categoria, datos.unidad,
          datos.ayuda, datos.icono, JSON.stringify(datos.opciones || []), datos.activo, datos.orden,
        ]
      );
      filtroId = Number(resultadoClon.insertId);
      await connection.query(
        `UPDATE servicio_filtro SET filtro_id = ?, mostrar_en_busqueda = ?, orden = ?
          WHERE servicio_id = ? AND filtro_id = ?`,
        [filtroId, mostrar, servicioOrden, servicioId, filtroIdOrigen]
      );
      await connection.query(
        `UPDATE filtro_recurso fr
           INNER JOIN recurso r ON r.id = fr.recurso_id
            SET fr.filtro_id = ?
          WHERE r.servicio_id = ? AND fr.filtro_id = ?`,
        [filtroId, servicioId, filtroIdOrigen]
      );
    } else {
      await connection.query(
        `UPDATE filtro SET codigo = ?, nombre = ?, tipo_valor = ?, categoria = ?, unidad = ?,
                ayuda = ?, icono = ?, opciones = ?, activo = ?, orden = ? WHERE id = ?`,
        [
          datos.codigo, datos.nombre, datos.tipo_valor, datos.categoria, datos.unidad,
          datos.ayuda, datos.icono, JSON.stringify(datos.opciones || []), datos.activo, datos.orden, filtroId,
        ]
      );
      await connection.query(
        "UPDATE servicio_filtro SET mostrar_en_busqueda = ?, orden = ? WHERE servicio_id = ? AND filtro_id = ?",
        [mostrar, servicioOrden, servicioId, filtroId]
      );
    }
    const [[nuevo]] = await connection.query(
      `SELECT f.*, sf.mostrar_en_busqueda, sf.orden AS servicio_orden
         FROM filtro f INNER JOIN servicio_filtro sf ON sf.filtro_id = f.id
        WHERE sf.servicio_id = ? AND sf.filtro_id = ?`,
      [servicioId, filtroId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "FILTRO", entidadId: filtroId, operacion: "UPDATE",
      resumen: clonarDefinicion
        ? `Filtro compartido “${anterior.nombre}” clonado y actualizado para el servicio`
        : `Filtro “${nuevo.nombre}” actualizado`,
      anterior,
      nuevo: { ...nuevo, clonado_desde_filtro_id: clonarDefinicion ? Number(anterior.id) : null },
      usuarioId: cabecera.id,
      req,
    });
    await connection.commit();
    return res.status(200).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar el filtro");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/gestion/turismo/servicios/:id/filtros/:filtroId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const filtroId = normalizarIdPositivo(req.params.filtroId);
    if (!servicioId || !filtroId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      `SELECT f.*, sf.mostrar_en_busqueda, sf.orden AS servicio_orden
         FROM filtro f INNER JOIN servicio_filtro sf ON sf.filtro_id = f.id
        WHERE sf.servicio_id = ? AND sf.filtro_id = ? FOR UPDATE`,
      [servicioId, filtroId]
    );
    if (!anterior) throw crearErrorCatalogo("Filtro no encontrado", 404, "FILTRO_NO_ENCONTRADO");
    await connection.query(
      `DELETE fr FROM filtro_recurso fr INNER JOIN recurso r ON r.id = fr.recurso_id
        WHERE r.servicio_id = ? AND fr.filtro_id = ?`,
      [servicioId, filtroId]
    );
    await connection.query(
      "DELETE FROM servicio_filtro WHERE servicio_id = ? AND filtro_id = ?",
      [servicioId, filtroId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "FILTRO", entidadId: filtroId, operacion: "REMOVE",
      resumen: `Filtro “${anterior.nombre}” quitado del servicio`, anterior,
      usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ id: filtroId, eliminado: true });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al quitar el filtro");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/gestion/turismo/servicios/:id/recursos/:recursoId/caracteristicas", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    const items = req.body?.caracteristicas;
    if (!servicioId || !recursoId || !Array.isArray(items) || items.length > 200) {
      throw crearErrorCatalogo("Las características no son válidas", 400, "CARACTERISTICAS_INVALIDAS");
    }
    const ids = items.map((item) => normalizarIdPositivo(item.filtro_id));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw crearErrorCatalogo("Hay filtros repetidos o inválidos", 400, "CARACTERISTICAS_FILTROS_INVALIDOS");
    }
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio } = await obtenerRecursoAutorizado(connection, cabecera, servicioId, recursoId, { forUpdate: true });
    const [anteriores] = await connection.query(
      "SELECT * FROM filtro_recurso WHERE recurso_id = ? FOR UPDATE",
      [recursoId]
    );
    let definiciones = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      [definiciones] = await connection.query(
        `SELECT f.* FROM filtro f INNER JOIN servicio_filtro sf ON sf.filtro_id = f.id
          WHERE sf.servicio_id = ? AND f.id IN (${placeholders})`,
        [servicioId, ...ids]
      );
    }
    if (definiciones.length !== ids.length) {
      throw crearErrorCatalogo("Todos los filtros deben pertenecer al servicio", 400, "CARACTERISTICA_FILTRO_NO_ASOCIADO");
    }
    const definicionPorId = new Map(definiciones.map((filtro) => [Number(filtro.id), filtro]));
    const normalizadas = items.map((item) => {
      const filtro = definicionPorId.get(Number(item.filtro_id));
      const resultado = normalizarValorFiltro(filtro, item);
      if (resultado.error) throw crearErrorCatalogo(resultado.error, 400, "CARACTERISTICA_VALOR_INVALIDO");
      return { filtro_id: Number(item.filtro_id), ...resultado.value };
    });
    await connection.query("DELETE FROM filtro_recurso WHERE recurso_id = ?", [recursoId]);
    for (const item of normalizadas) {
      await connection.query(
        `INSERT INTO filtro_recurso
           (filtro_id, recurso_id, valor_numero, valor_booleano, valor_texto)
         VALUES (?, ?, ?, ?, ?)`,
        [item.filtro_id, recursoId, item.valor_numero, item.valor_booleano, item.valor_texto]
      );
    }
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId, entidadTipo: "CARACTERISTICAS", entidadId: recursoId, operacion: "REPLACE",
      resumen: `Características del recurso actualizadas (${normalizadas.length})`,
      anterior: anteriores, nuevo: normalizadas, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ recurso_id: recursoId, caracteristicas: normalizadas });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar las características");
  } finally {
    if (connection) connection.release();
  }
});

async function asegurarCupoSinSolapamiento(connection, recursoId, datos, excluirId = null) {
  const params = [recursoId, datos.fecha_fin, datos.fecha_inicio];
  let excluir = "";
  if (excluirId) { excluir = "AND id <> ?"; params.push(excluirId); }
  const [rows] = await connection.query(
    `SELECT id FROM recurso_cupo_periodo
      WHERE recurso_id = ? AND activo = 1 AND fecha_inicio <= ? AND fecha_fin >= ? ${excluir}
      LIMIT 1`,
    params
  );
  if (rows.length && datos.activo) {
    throw crearErrorCatalogo("El período se superpone con otro cupo activo", 409, "CUPO_PERIODO_SUPERPUESTO");
  }
}

router.post("/gestion/turismo/servicios/:id/recursos/:recursoId/cupos", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    if (!servicioId || !recursoId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarCupoPayload(req.body || {});
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio } = await obtenerRecursoAutorizado(connection, cabecera, servicioId, recursoId, { forUpdate: true });
    await asegurarCupoSinSolapamiento(connection, recursoId, datos);
    const [resultado] = await connection.query(
      `INSERT INTO recurso_cupo_periodo (recurso_id, fecha_inicio, fecha_fin, cupo_total, activo)
       VALUES (?, ?, ?, ?, ?)`,
      [recursoId, datos.fecha_inicio, datos.fecha_fin, datos.cupo_total, datos.activo]
    );
    const cupoId = Number(resultado.insertId);
    const [[nuevo]] = await connection.query("SELECT * FROM recurso_cupo_periodo WHERE id = ?", [cupoId]);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId, entidadTipo: "CUPO", entidadId: cupoId, operacion: "CREATE",
      resumen: `Cupo de ${datos.cupo_total} creado para ${datos.fecha_inicio} a ${datos.fecha_fin}`,
      nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(201).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al crear el cupo");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/gestion/turismo/servicios/:id/recursos/:recursoId/cupos/:cupoId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    const cupoId = normalizarIdPositivo(req.params.cupoId);
    if (!servicioId || !recursoId || !cupoId) throw crearErrorCatalogo("ID inválido", 400);
    const datos = validarCupoPayload(req.body || {});
    const version = req.body.version === undefined ? null : normalizarEnteroNoNegativo(req.body.version, { maximo: Number.MAX_SAFE_INTEGER });
    if (req.body.version !== undefined && version === undefined) throw crearErrorCatalogo("Versión inválida", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio } = await obtenerRecursoAutorizado(connection, cabecera, servicioId, recursoId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      "SELECT * FROM recurso_cupo_periodo WHERE id = ? AND recurso_id = ? FOR UPDATE",
      [cupoId, recursoId]
    );
    if (!anterior) throw crearErrorCatalogo("Cupo no encontrado", 404, "CUPO_NO_ENCONTRADO");
    if (version !== null && Number(anterior.version) !== version) throw crearErrorCatalogo("El cupo fue modificado", 409, "CUPO_VERSION_DESACTUALIZADA");
    await asegurarCupoSinSolapamiento(connection, recursoId, datos, cupoId);
    await connection.query(
      `UPDATE recurso_cupo_periodo SET fecha_inicio = ?, fecha_fin = ?, cupo_total = ?, activo = ?, version = version + 1
        WHERE id = ? AND recurso_id = ?`,
      [datos.fecha_inicio, datos.fecha_fin, datos.cupo_total, datos.activo, cupoId, recursoId]
    );
    const [[nuevo]] = await connection.query("SELECT * FROM recurso_cupo_periodo WHERE id = ?", [cupoId]);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId, entidadTipo: "CUPO", entidadId: cupoId, operacion: "UPDATE",
      resumen: `Cupo actualizado para ${datos.fecha_inicio} a ${datos.fecha_fin}`,
      anterior, nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar el cupo");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/gestion/turismo/servicios/:id/recursos/:recursoId/cupos/:cupoId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const recursoId = normalizarIdPositivo(req.params.recursoId);
    const cupoId = normalizarIdPositivo(req.params.cupoId);
    if (!servicioId || !recursoId || !cupoId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const { servicio } = await obtenerRecursoAutorizado(connection, cabecera, servicioId, recursoId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      "SELECT * FROM recurso_cupo_periodo WHERE id = ? AND recurso_id = ? FOR UPDATE",
      [cupoId, recursoId]
    );
    if (!anterior) throw crearErrorCatalogo("Cupo no encontrado", 404, "CUPO_NO_ENCONTRADO");
    await connection.query(
      "UPDATE recurso_cupo_periodo SET activo = 0, version = version + 1 WHERE id = ?",
      [cupoId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId, entidadTipo: "CUPO", entidadId: cupoId, operacion: "DISABLE",
      resumen: "Período de cupo deshabilitado", anterior, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ id: cupoId, activo: 0 });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al deshabilitar el cupo");
  } finally {
    if (connection) connection.release();
  }
});

async function validarRecursoRegla(connection, servicioId, recursoId) {
  if (!recursoId) return;
  const [rows] = await connection.query(
    "SELECT id FROM recurso WHERE id = ? AND servicio_id = ? LIMIT 1",
    [recursoId, servicioId]
  );
  if (!rows.length) throw crearErrorCatalogo("El recurso no pertenece al servicio", 400, "TARIFA_RECURSO_INVALIDO");
}

async function asegurarReglaSinSolapamiento(connection, servicioId, datos, excluirId = null) {
  const params = [servicioId, datos.audiencia_departamental, datos.recurso_id, datos.recurso_id, datos.fecha_fin, datos.fecha_inicio];
  let excluir = "";
  if (excluirId) { excluir = "AND id <> ?"; params.push(excluirId); }
  const [rows] = await connection.query(
    `SELECT id FROM turismo_tarifa_regla
      WHERE servicio_id = ? AND audiencia_departamental = ?
        AND ((recurso_id IS NULL AND ? IS NULL) OR recurso_id = ?)
        AND activo = 1 AND fecha_inicio <= ? AND fecha_fin >= ? ${excluir}
      LIMIT 1`,
    params
  );
  if (rows.length && datos.activo) {
    throw crearErrorCatalogo("La tarifa se superpone con otra regla activa para la misma audiencia", 409, "TARIFA_REGLA_SUPERPUESTA");
  }
}

async function sincronizarTarifasMaterializadas(connection, servicio, regla) {
  const [existentes] = await connection.query(
    `SELECT t.id,
            EXISTS(SELECT 1 FROM reserva_familiar_tarifa rft WHERE rft.tarifa_id = t.id) AS referenciada
       FROM tarifa t WHERE t.turismo_tarifa_regla_id = ? FOR UPDATE`,
    [regla.id]
  );
  const eliminables = existentes.filter((tarifa) => Number(tarifa.referenciada) !== 1).map((tarifa) => Number(tarifa.id));
  const historicas = existentes.filter((tarifa) => Number(tarifa.referenciada) === 1).map((tarifa) => Number(tarifa.id));
  if (eliminables.length) {
    await connection.query(
      `DELETE FROM tarifa WHERE id IN (${eliminables.map(() => "?").join(",")})`,
      eliminables
    );
  }
  if (historicas.length) {
    await connection.query(
      `UPDATE tarifa SET turismo_tarifa_regla_id = NULL WHERE id IN (${historicas.map(() => "?").join(",")})`,
      historicas
    );
  }
  if (!Number(regla.activo)) return;

  const params = [servicio.id];
  let filtroRecurso = "";
  if (regla.recurso_id) { filtroRecurso = "AND id = ?"; params.push(regla.recurso_id); }
  const [recursos] = await connection.query(
    `SELECT id FROM recurso WHERE servicio_id = ? AND activo = 1 ${filtroRecurso} ORDER BY id`,
    params
  );
  const precioBase = decimalACentavos(regla.precio, { permiteCero: false });
  const descuento = decimalACentavos(regla.porcentaje_descuento || 0, { permiteCero: true });
  const precioFinal = aplicarDescuentoEnPuntosBase(precioBase, descuento);
  if (precioBase === null || descuento === null || precioFinal === null) {
    throw crearErrorCatalogo("La regla no puede materializarse por un importe inválido", 409, "TARIFA_REGLA_INVALIDA");
  }
  for (const recurso of recursos) {
    await connection.query(
      `INSERT INTO tarifa
         (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
          edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin,
          precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles,
          audiencia_departamental, turismo_tarifa_regla_id)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        recurso.id, centavosANumero(precioFinal), regla.fecha_inicio, regla.fecha_fin,
        Number(regla.precio_por_persona) === 1 ? "Y" : "N",
        descuento > 0 ? 1 : 0, regla.porcentaje_descuento || 0,
        regla.audiencia_departamental, regla.id,
      ]
    );
  }
}

async function sincronizarMaterializacionesServicio(connection, servicio) {
  const [reglas] = await connection.query(
    "SELECT * FROM turismo_tarifa_regla WHERE servicio_id = ? AND activo = 1 ORDER BY id",
    [servicio.id]
  );
  for (const regla of reglas) await sincronizarTarifasMaterializadas(connection, servicio, regla);
}

router.post("/gestion/turismo/servicios/:id/tarifas", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const datos = validarReglaTarifaPayload(req.body || {}, servicio);
    await validarRecursoRegla(connection, servicioId, datos.recurso_id);
    await asegurarReglaSinSolapamiento(connection, servicioId, datos);
    const [resultado] = await connection.query(
      `INSERT INTO turismo_tarifa_regla
         (servicio_id, recurso_id, nombre, temporada, fecha_inicio, fecha_fin,
          audiencia_departamental, precio, porcentaje_descuento, precio_por_persona, activo, creado_por_usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        servicioId, datos.recurso_id, datos.nombre, datos.temporada, datos.fecha_inicio, datos.fecha_fin,
        datos.audiencia_departamental, datos.precio, datos.porcentaje_descuento,
        datos.precio_por_persona, datos.activo, cabecera.id,
      ]
    );
    const reglaId = Number(resultado.insertId);
    const [[nuevo]] = await connection.query("SELECT * FROM turismo_tarifa_regla WHERE id = ?", [reglaId]);
    await sincronizarTarifasMaterializadas(connection, servicio, nuevo);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId: datos.recurso_id, entidadTipo: "TARIFA_REGLA", entidadId: reglaId, operacion: "CREATE",
      resumen: `Tarifa “${datos.nombre}” creada`, nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(201).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al crear la tarifa");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/gestion/turismo/servicios/:id/tarifas/:reglaId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const reglaId = normalizarIdPositivo(req.params.reglaId);
    if (!servicioId || !reglaId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const datos = validarReglaTarifaPayload(req.body || {}, servicio);
    const version = req.body.version === undefined ? null : normalizarEnteroNoNegativo(req.body.version, { maximo: Number.MAX_SAFE_INTEGER });
    if (req.body.version !== undefined && version === undefined) throw crearErrorCatalogo("Versión inválida", 400);
    const [[anterior]] = await connection.query(
      "SELECT * FROM turismo_tarifa_regla WHERE id = ? AND servicio_id = ? FOR UPDATE",
      [reglaId, servicioId]
    );
    if (!anterior) throw crearErrorCatalogo("Tarifa no encontrada", 404, "TARIFA_REGLA_NO_ENCONTRADA");
    if (version !== null && Number(anterior.version) !== version) throw crearErrorCatalogo("La tarifa fue modificada", 409, "TARIFA_REGLA_VERSION_DESACTUALIZADA");
    await validarRecursoRegla(connection, servicioId, datos.recurso_id);
    await asegurarReglaSinSolapamiento(connection, servicioId, datos, reglaId);
    await connection.query(
      `UPDATE turismo_tarifa_regla SET recurso_id = ?, nombre = ?, temporada = ?, fecha_inicio = ?, fecha_fin = ?,
              audiencia_departamental = ?, precio = ?, porcentaje_descuento = ?, precio_por_persona = ?,
              activo = ?, version = version + 1
        WHERE id = ? AND servicio_id = ?`,
      [
        datos.recurso_id, datos.nombre, datos.temporada, datos.fecha_inicio, datos.fecha_fin,
        datos.audiencia_departamental, datos.precio, datos.porcentaje_descuento,
        datos.precio_por_persona, datos.activo, reglaId, servicioId,
      ]
    );
    const [[nuevo]] = await connection.query("SELECT * FROM turismo_tarifa_regla WHERE id = ?", [reglaId]);
    await sincronizarTarifasMaterializadas(connection, servicio, nuevo);
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId: datos.recurso_id, entidadTipo: "TARIFA_REGLA", entidadId: reglaId, operacion: "UPDATE",
      resumen: `Tarifa “${datos.nombre}” actualizada`, anterior, nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al actualizar la tarifa");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/gestion/turismo/servicios/:id/tarifas/:reglaId", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const reglaId = normalizarIdPositivo(req.params.reglaId);
    if (!servicioId || !reglaId) throw crearErrorCatalogo("ID inválido", 400);
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const [[anterior]] = await connection.query(
      "SELECT * FROM turismo_tarifa_regla WHERE id = ? AND servicio_id = ? FOR UPDATE",
      [reglaId, servicioId]
    );
    if (!anterior) throw crearErrorCatalogo("Tarifa no encontrada", 404, "TARIFA_REGLA_NO_ENCONTRADA");
    await connection.query(
      "UPDATE turismo_tarifa_regla SET activo = 0, version = version + 1 WHERE id = ?",
      [reglaId]
    );
    await sincronizarTarifasMaterializadas(connection, servicio, { ...anterior, activo: 0 });
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId: anterior.recurso_id, entidadTipo: "TARIFA_REGLA", entidadId: reglaId, operacion: "DISABLE",
      resumen: `Tarifa “${anterior.nombre}” deshabilitada`, anterior, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(200).json({ id: reglaId, activo: 0 });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al deshabilitar la tarifa");
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/gestion/turismo/servicios/:id/imagenes",
  verifyToken,
  procesarImagenesTurismo,
  async (req, res) => {
    let connection;
    const subidas = [];
    try {
      const cabecera = exigirGestion(req);
      const servicioId = normalizarIdPositivo(req.params.id);
      const recursoId = req.body?.recurso_id == null || req.body.recurso_id === ""
        ? null : normalizarIdPositivo(req.body.recurso_id);
      const archivos = archivosImagenDe(req);
      if (!servicioId || (req.body?.recurso_id != null && req.body.recurso_id !== "" && !recursoId)) {
        throw crearErrorCatalogo("Los datos de la imagen no son válidos", 400, "IMAGEN_DATOS_INVALIDOS");
      }
      if (!archivos.length) throw crearErrorCatalogo("Seleccioná al menos una imagen", 400, "IMAGEN_REQUERIDA");
      connection = await mysqlConnection.promise().getConnection();
      await connection.beginTransaction();
      const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
      let recurso = null;
      if (recursoId) {
        const [recursos] = await connection.query(
          "SELECT * FROM recurso WHERE id = ? AND servicio_id = ? LIMIT 1 FOR UPDATE",
          [recursoId, servicioId]
        );
        if (!recursos.length) throw crearErrorCatalogo("Recurso no encontrado", 404, "RECURSO_NO_ENCONTRADO");
        [recurso] = recursos;
      }
      const creadas = [];
      for (const file of archivos) {
        const key = await subirImagenTurismo(file, recursoId ? `recursos/${recursoId}` : `servicios/${servicioId}`);
        subidas.push(key);
        const tabla = recursoId ? "imagen_recurso" : "imagen_servicio";
        const columna = recursoId ? "recurso_id" : "servicio_id";
        const [resultado] = await connection.query(
          `INSERT INTO ${tabla} (${columna}, archivo) VALUES (?, ?)`,
          [recursoId || servicioId, key]
        );
        creadas.push({
          id: Number(resultado.insertId),
          archivo: key,
          servicio_id: servicioId,
          recurso_id: recursoId,
          tipo: recursoId ? "RECURSO" : "SERVICIO",
        });
      }
      await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
      await registrarHistorialTurismo(connection, {
        servicioId, recursoId, entidadTipo: "IMAGEN", entidadId: null, operacion: "UPLOAD",
        resumen: `${creadas.length} imagen${creadas.length === 1 ? "" : "es"} agregada${creadas.length === 1 ? "" : "s"}${recurso ? ` a “${recurso.nombre}”` : " al servicio"}`,
        nuevo: creadas, usuarioId: cabecera.id, req,
      });
      await connection.commit();
      const firmadas = await Promise.all(creadas.map(firmarImagen));
      return res.status(201).json({ imagenes: firmadas.map((imagen, indice) => ({ ...creadas[indice], ...imagen })) });
    } catch (error) {
      if (connection) await connection.rollback();
      await Promise.all(subidas.map(eliminarImagenS3Seguro));
      return responderError(res, error, "Error al subir las imágenes");
    } finally {
      if (connection) connection.release();
    }
  }
);

router.delete("/gestion/turismo/servicios/:id/imagenes/:imagenId", verifyToken, async (req, res) => {
  let connection;
  let archivo = null;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const imagenId = normalizarIdPositivo(req.params.imagenId);
    const recursoSolicitado = req.query?.recurso_id == null || req.query.recurso_id === ""
      ? null : normalizarIdPositivo(req.query.recurso_id);
    if (!servicioId || !imagenId || (req.query?.recurso_id != null && req.query.recurso_id !== "" && !recursoSolicitado)) {
      throw crearErrorCatalogo("ID inválido", 400);
    }
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    let tipo = "SERVICIO";
    let recursoId = null;
    let imagen = null;
    if (!recursoSolicitado) {
      const [imagenesServicio] = await connection.query(
        "SELECT * FROM imagen_servicio WHERE id = ? AND servicio_id = ? LIMIT 1 FOR UPDATE",
        [imagenId, servicioId]
      );
      [imagen] = imagenesServicio;
    }
    if (!imagen) {
      const params = [imagenId, servicioId];
      let filtroRecurso = "";
      if (recursoSolicitado) { filtroRecurso = "AND r.id = ?"; params.push(recursoSolicitado); }
      const [imagenesRecurso] = await connection.query(
        `SELECT ir.*, r.id AS recurso_id FROM imagen_recurso ir
          INNER JOIN recurso r ON r.id = ir.recurso_id
         WHERE ir.id = ? AND r.servicio_id = ? ${filtroRecurso} LIMIT 1 FOR UPDATE`,
        params
      );
      [imagen] = imagenesRecurso;
      if (imagen) { tipo = "RECURSO"; recursoId = Number(imagen.recurso_id); }
    }
    if (!imagen) throw crearErrorCatalogo("Imagen no encontrada", 404, "IMAGEN_NO_ENCONTRADA");
    archivo = imagen.archivo;
    await connection.query(
      tipo === "SERVICIO" ? "DELETE FROM imagen_servicio WHERE id = ?" : "DELETE FROM imagen_recurso WHERE id = ?",
      [imagenId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    await registrarHistorialTurismo(connection, {
      servicioId, recursoId, entidadTipo: "IMAGEN", entidadId: imagenId, operacion: "DELETE",
      resumen: "Imagen eliminada del catálogo", anterior: { ...imagen, tipo }, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    await eliminarImagenS3Seguro(archivo);
    return res.status(200).json({ id: imagenId, eliminado: true, tipo, recurso_id: recursoId });
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al eliminar la imagen");
  } finally {
    if (connection) connection.release();
  }
});

async function obtenerConvenioServicio(connection, servicioId) {
  const [rows] = await connection.query(
    `SELECT ch.*, s.direccion, s.tarifario_pdf_url
       FROM convenio_hotel ch INNER JOIN servicio s ON s.id = ch.servicio_id
      WHERE ch.servicio_id = ? LIMIT 1`,
    [servicioId]
  );
  return rows[0] || null;
}

router.get("/gestion/turismo/servicios/:id/convenio", verifyToken, async (req, res) => {
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const db = mysqlConnection.promise();
    const servicio = await asegurarPuedeVerDetalle(db, cabecera, servicioId);
    if (servicio.tipo_codigo !== "CONVENIO_HOTELERO") {
      throw crearErrorCatalogo("El servicio no es un convenio hotelero", 409, "SERVICIO_NO_ES_CONVENIO");
    }
    const convenio = await obtenerConvenioServicio(db, servicioId);
    return res.status(200).json(convenio);
  } catch (error) {
    return responderError(res, error, "Error al obtener el convenio hotelero");
  }
});

router.put("/gestion/turismo/servicios/:id/convenio", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    if (!servicioId) throw crearErrorCatalogo("ID inválido", 400);
    const ciudad = normalizarTexto(req.body?.ciudad, { nullable: false, maximo: 120 });
    const provincia = normalizarTexto(req.body?.provincia, { nullable: false, maximo: 120 });
    const coordenadas = normalizarTexto(req.body?.coordenadas_maps, { nullable: false, maximo: 1000 });
    const nombrePayload = normalizarTexto(req.body?.nombre, { nullable: true, maximo: 160 });
    const descripcion = normalizarTexto(req.body?.descripcion, { nullable: true, maximo: 20_000 });
    const direccion = normalizarTexto(req.body?.direccion, { nullable: true, maximo: 255 });
    const tarifarioUrl = normalizarTexto(req.body?.tarifario_pdf_url, { nullable: true, maximo: 1000 });
    const activo = normalizarBooleano(req.body?.activo, 1);
    const latitud = req.body?.latitud == null || req.body.latitud === "" ? null : Number(req.body.latitud);
    const longitud = req.body?.longitud == null || req.body.longitud === "" ? null : Number(req.body.longitud);
    if (
      !ciudad || !provincia || !coordenadas || descripcion === undefined || direccion === undefined ||
      tarifarioUrl === undefined || activo === undefined ||
      (latitud !== null && (!Number.isFinite(latitud) || latitud < -90 || latitud > 90)) ||
      (longitud !== null && (!Number.isFinite(longitud) || longitud < -180 || longitud > 180)) ||
      (tarifarioUrl && !/^https?:\/\//i.test(tarifarioUrl))
    ) {
      throw crearErrorCatalogo("Los datos del convenio no son válidos", 400, "CONVENIO_DATOS_INVALIDOS");
    }
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const servicio = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    if (servicio.tipo_codigo !== "CONVENIO_HOTELERO") {
      throw crearErrorCatalogo("El servicio no es un convenio hotelero", 409, "SERVICIO_NO_ES_CONVENIO");
    }
    const anterior = await obtenerConvenioServicio(connection, servicioId);
    const nombre = nombrePayload || servicio.nombre;
    if (anterior) {
      await connection.query(
        `UPDATE convenio_hotel SET nombre = ?, ciudad = ?, provincia = ?, coordenadas_maps = ?,
                latitud = ?, longitud = ?, descripcion = ?, activo = ? WHERE servicio_id = ?`,
        [nombre, ciudad, provincia, coordenadas, latitud, longitud, descripcion, activo, servicioId]
      );
    } else {
      await connection.query(
        `INSERT INTO convenio_hotel
           (servicio_id, nombre, ciudad, provincia, coordenadas_maps, latitud, longitud, descripcion, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [servicioId, nombre, ciudad, provincia, coordenadas, latitud, longitud, descripcion, activo]
      );
    }
    await connection.query(
      "UPDATE servicio SET provincia = ?, direccion = ?, tarifario_pdf_url = ?, version = version + 1 WHERE id = ?",
      [provincia, direccion, tarifarioUrl, servicioId]
    );
    await marcarPendientePorCambioDepartamental(connection, cabecera, { ...servicio });
    const nuevo = await obtenerConvenioServicio(connection, servicioId);
    await registrarHistorialTurismo(connection, {
      servicioId, entidadTipo: "CONVENIO_HOTEL", entidadId: nuevo.id,
      operacion: anterior ? "UPDATE" : "CREATE", resumen: `Convenio “${nombre}” guardado`,
      anterior, nuevo, usuarioId: cabecera.id, req,
    });
    await connection.commit();
    return res.status(anterior ? 200 : 201).json(nuevo);
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al guardar el convenio hotelero");
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------------------------------
// Descuento médico por servicio (subsidio de alojamiento por salud, 100%).
// admin / admin-central lo habilitan o deshabilitan directamente; una
// departamental sólo puede pedirlo para sus propios servicios y queda
// PENDIENTE hasta que un rol superior lo apruebe.
// ---------------------------------------------------------------------------
async function registrarCambioDescuentoSalud(connection, { servicio, estadoAnterior, estadoNuevo, operacion, resumen, motivo = null, cabecera, req }) {
  await registrarHistorialTurismo(connection, {
    servicioId: servicio.id,
    entidadTipo: "DESCUENTO_SALUD",
    entidadId: servicio.id,
    operacion,
    resumen,
    anterior: { descuento_salud_estado: estadoAnterior },
    nuevo: { descuento_salud_estado: estadoNuevo, motivo },
    usuarioId: cabecera.id,
    req,
  });
  await registrarHistorialDescuento(connection, {
    servicioId: servicio.id,
    entidadTipo: "SERVICIO_SALUD",
    entidadId: servicio.id,
    operacion,
    resumen,
    anterior: { descuento_salud_estado: estadoAnterior },
    nuevo: { descuento_salud_estado: estadoNuevo, motivo },
    usuarioId: cabecera.id,
    req,
  });
}

router.put("/gestion/turismo/servicios/:id/descuento-salud", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    const servicioId = normalizarIdPositivo(req.params.id);
    const habilitado = normalizarBooleano(req.body?.habilitado);
    if (!servicioId || habilitado === undefined || habilitado === null) {
      throw crearErrorCatalogo("Los datos no son válidos", 400, "DESCUENTO_SALUD_DATOS_INVALIDOS");
    }
    const motivo = normalizarTexto(req.body?.motivo, { nullable: true, maximo: 1000 });
    if (motivo === undefined) throw crearErrorCatalogo("El motivo no es válido", 400, "DESCUENTO_SALUD_MOTIVO_INVALIDO");
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestionAutorizado(connection, cabecera, servicioId, { forUpdate: true });
    const estadoAnterior = anterior.descuento_salud_estado || "DESHABILITADO";
    const esAdministrador = esAdministradorTurismo(cabecera);
    let estadoNuevo;
    let operacion;
    let resumen;
    if (habilitado === 1) {
      if (estadoAnterior === "HABILITADO") {
        throw crearErrorCatalogo("El descuento médico ya está habilitado en este servicio", 409, "DESCUENTO_SALUD_YA_HABILITADO");
      }
      if (esAdministrador) {
        estadoNuevo = "HABILITADO";
        operacion = "ENABLE";
        resumen = `Descuento médico habilitado en “${anterior.nombre}”`;
      } else {
        if (estadoAnterior === "PENDIENTE") {
          throw crearErrorCatalogo("La solicitud ya está pendiente de aprobación", 409, "DESCUENTO_SALUD_YA_PENDIENTE");
        }
        estadoNuevo = "PENDIENTE";
        operacion = "SUBMIT";
        resumen = `La departamental solicitó habilitar el descuento médico en “${anterior.nombre}”`;
      }
    } else {
      if (estadoAnterior === "DESHABILITADO") {
        throw crearErrorCatalogo("El descuento médico ya está deshabilitado en este servicio", 409, "DESCUENTO_SALUD_YA_DESHABILITADO");
      }
      estadoNuevo = "DESHABILITADO";
      operacion = estadoAnterior === "PENDIENTE" && !esAdministrador ? "WITHDRAW" : "DISABLE";
      resumen = estadoAnterior === "PENDIENTE" && !esAdministrador
        ? `La departamental retiró la solicitud de descuento médico de “${anterior.nombre}”`
        : `Descuento médico deshabilitado en “${anterior.nombre}”`;
    }
    await connection.query(
      `UPDATE servicio
          SET descuento_salud_estado = ?,
              descuento_salud_solicitado_por_usuario_id = ?,
              descuento_salud_fecha_solicitud = ?,
              descuento_salud_motivo = ?
        WHERE id = ?`,
      [
        estadoNuevo,
        estadoNuevo === "PENDIENTE" ? cabecera.id : null,
        estadoNuevo === "PENDIENTE" ? new Date() : null,
        estadoNuevo === "DESHABILITADO" ? motivo : null,
        servicioId,
      ]
    );
    await registrarCambioDescuentoSalud(connection, {
      servicio: anterior, estadoAnterior, estadoNuevo, operacion, resumen, motivo, cabecera, req,
    });
    if (estadoNuevo === "PENDIENTE") {
      await notificarRevisores(
        connection, anterior, "TURISMO_DESCUENTO_SALUD_PENDIENTE",
        `Descuento médico pendiente: ${anterior.nombre}`,
        `La departamental pidió habilitar el subsidio por salud (100%) en “${anterior.nombre}”. Revisalo en Turismo → Servicios.`,
        cabecera.id
      );
    }
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await connection.commit();
    return res.status(200).json(presentarServicio(nuevo, cabecera));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al cambiar el descuento médico del servicio");
  } finally {
    if (connection) connection.release();
  }
});

router.post("/gestion/turismo/servicios/:id/descuento-salud/aprobacion", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = exigirGestion(req);
    if (!puedeAprobarTurismo(cabecera)) {
      throw crearErrorCatalogo("Solo un administrador puede resolver la solicitud", 403, "APROBACION_TURISMO_NO_AUTORIZADA");
    }
    const servicioId = normalizarIdPositivo(req.params.id);
    const accion = String(req.body?.accion || req.body?.estado || "").trim().toUpperCase();
    const aprobar = ["APROBAR", "APROBADO", "HABILITAR"].includes(accion);
    const rechazar = ["RECHAZAR", "RECHAZADO"].includes(accion);
    if (!servicioId || (!aprobar && !rechazar)) {
      throw crearErrorCatalogo("La acción no es válida", 400, "DESCUENTO_SALUD_ACCION_INVALIDA");
    }
    const motivo = normalizarTexto(req.body?.motivo ?? req.body?.observacion, { nullable: true, maximo: 1000 });
    if (motivo === undefined) throw crearErrorCatalogo("El motivo no es válido", 400, "DESCUENTO_SALUD_MOTIVO_INVALIDO");
    if (rechazar && !motivo) throw crearErrorCatalogo("Indicá el motivo del rechazo", 400, "DESCUENTO_SALUD_MOTIVO_REQUERIDO");
    connection = await mysqlConnection.promise().getConnection();
    await connection.beginTransaction();
    const anterior = await obtenerServicioGestion(connection, servicioId, { forUpdate: true });
    if (!anterior) throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
    if (anterior.descuento_salud_estado !== "PENDIENTE") {
      throw crearErrorCatalogo("No hay una solicitud pendiente para este servicio", 409, "DESCUENTO_SALUD_NO_PENDIENTE");
    }
    const estadoNuevo = aprobar ? "HABILITADO" : "DESHABILITADO";
    await connection.query(
      "UPDATE servicio SET descuento_salud_estado = ?, descuento_salud_motivo = ? WHERE id = ?",
      [estadoNuevo, aprobar ? null : motivo, servicioId]
    );
    await registrarCambioDescuentoSalud(connection, {
      servicio: anterior,
      estadoAnterior: "PENDIENTE",
      estadoNuevo,
      operacion: aprobar ? "APPROVE" : "REJECT",
      resumen: aprobar
        ? `Descuento médico aprobado en “${anterior.nombre}”${motivo ? `: ${motivo}` : ""}`
        : `Solicitud de descuento médico rechazada en “${anterior.nombre}”: ${motivo}`,
      motivo,
      cabecera,
      req,
    });
    await notificarPropietaria(
      connection, anterior, "TURISMO_DESCUENTO_SALUD_RESUELTO",
      aprobar ? "Descuento médico aprobado" : "Descuento médico rechazado",
      aprobar
        ? `Ya podés ofrecer el subsidio por salud (100%) en “${anterior.nombre}”.`
        : `La solicitud de descuento médico para “${anterior.nombre}” fue rechazada. Motivo: ${motivo}`,
      cabecera.id
    );
    const nuevo = await obtenerServicioGestion(connection, servicioId);
    await connection.commit();
    return res.status(200).json(presentarServicio(nuevo, cabecera));
  } catch (error) {
    if (connection) await connection.rollback();
    return responderError(res, error, "Error al resolver la solicitud de descuento médico");
  } finally {
    if (connection) connection.release();
  }
});

router.get("/gestion/turismo/servicios/:id/historial", verifyToken, async (req, res) => {
  try {
    const cabecera = cabeceraDe(req);
    if (!tieneAreaTurismo(cabecera) || !["admin", "admin-central", "departamental", "auditor"].includes(cabecera.rol)) {
      throw crearErrorCatalogo("No autorizado", 403, "HISTORIAL_TURISMO_NO_AUTORIZADO");
    }
    const servicioId = normalizarIdPositivo(req.params.id);
    const paginacion = normalizarPaginacion(req.query, 30);
    if (!servicioId || !paginacion) throw crearErrorCatalogo("Los parámetros no son válidos", 400);
    const db = mysqlConnection.promise();
    const servicio = await obtenerServicioGestion(db, servicioId);
    if (!servicio) throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
    if (cabecera.rol === "departamental") asegurarPropiedadServicio(cabecera, servicio);
    const [rows] = await db.query(
      `SELECT h.*, CONCAT(u.nombre, ' ', u.apellido) AS usuario_nombre
         FROM turismo_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
        WHERE h.servicio_id = ?
        ORDER BY h.fecha_creacion DESC, h.id DESC
        LIMIT ? OFFSET ?`,
      [servicioId, paginacion.pageSize, paginacion.offset]
    );
    const [[conteo]] = await db.query(
      "SELECT COUNT(*) AS total FROM turismo_historial WHERE servicio_id = ?",
      [servicioId]
    );
    return res.status(200).json({
      results: rows,
      totalItems: Number(conteo.total || 0),
      page: paginacion.page - 1,
      pagina: paginacion.page,
      pageSize: paginacion.pageSize,
      numOfPages: Math.ceil(Number(conteo.total || 0) / paginacion.pageSize),
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener el historial de Turismo");
  }
});

module.exports = router;
