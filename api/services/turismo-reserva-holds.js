"use strict";

const crypto = require("crypto");
const {
  normalizarFechaCivil,
  obtenerNochesReserva,
  validarRangoReservaTemporal,
} = require("./valores-dominio");

const TABLA_HOLDS = "turismo_reserva_hold";
const HOLD_TTL_MINUTOS = 20;
const HOLD_ESTADO_ACTIVO = "ACTIVO";
const HOLD_ESTADO_CONSUMIDO = "CONSUMIDO";
const HOLD_ESTADO_LIBERADO = "LIBERADO";
const HOLD_ESTADO_VENCIDO = "VENCIDO";
const MODALIDAD_FECHA_LIBRE = "FECHA_LIBRE";
const MODALIDAD_BLOQUE = "BLOQUE";
const LOCK_EXPIRACION_HOLDS = "ajb:turismo:reserva-holds:expiracion:v1";
const TOKEN_MIN_LENGTH = 32;
const TOKEN_MAX_LENGTH = 200;

// Latido (migración v2): `vence_en` es el plazo corto que renueva cada latido
// del formulario y `vence_max_en` el tope de HOLD_TTL_MINUTOS que ve la persona.
// Todas las consultas de ocupación siguen filtrando `vence_en > NOW(6)`, así que
// un navegador que se cierra de golpe libera el alojamiento al perder el plazo
// corto sin tocar esas consultas. Los clientes que no declaran `soporta_latido`
// (bundles viejos) reciben ambos plazos iguales: el comportamiento de v1.
const HOLD_GRACIA_LATIDO_SEGUNDOS_DEFECTO = 150;
// 5 minutos: al volver antes, el latido sigue; después, `reanudar` lo recupera
// si nadie tomó el alojamiento mientras tanto.
const HOLD_GRACIA_SEGUNDO_PLANO_SEGUNDOS_DEFECTO = 300;
const HOLD_LATIDO_CADA_SEGUNDOS_DEFECTO = 30;
const MOTIVO_CIERRE_TIEMPO = "TIEMPO";
const MOTIVO_CIERRE_ABANDONO = "ABANDONO";
const MOTIVO_CIERRE_REEMPLAZADO = "REEMPLAZADO";
const MOTIVO_CIERRE_LIBERADO = "LIBERADO";
// Si el plazo corto quedó antes del tope, lo que se perdió fue el latido.
const SQL_MOTIVO_VENCIMIENTO =
  "IF(vence_en < COALESCE(vence_max_en, vence_en), 'ABANDONO', 'TIEMPO')";

const HOLD_VENCIDO_MENSAJE =
  "Se terminó el tiempo para completar la reserva. Liberamos el alojamiento para que otras personas puedan elegirlo.";
const HOLD_CONFLICTO_MENSAJE =
  "Este alojamiento acaba de ser elegido por otra persona. Te ayudamos a buscar otra opción.";
const HOLD_REEMPLAZADO_MENSAJE =
  "Tu reserva siguió en otra pestaña. Continuala desde ahí.";
const HOLD_LATIDO_PERDIDO_MENSAJE =
  "Perdimos por un momento la conexión con tu reserva. Estamos intentando recuperarla.";

// `expira_en_ms` es el plazo corto (vence_en): lo usan todos los chequeos de
// vencimiento en JS. `limite_en_ms` es el tope que se muestra al usuario.
const SELECT_HOLD_FIELDS = `
  h.id,
  h.actor_usuario_id,
  h.titular_usuario_id,
  h.servicio_id,
  h.recurso_id,
  h.bloque_fecha_id,
  h.modalidad,
  DATE_FORMAT(h.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
  DATE_FORMAT(h.fecha_fin, '%Y-%m-%d') AS fecha_fin,
  h.numero_parcela,
  h.estado,
  h.motivo_cierre,
  h.reserva_id,
  ROUND(UNIX_TIMESTAMP(h.vence_en) * 1000) AS expira_en_ms,
  ROUND(UNIX_TIMESTAMP(COALESCE(h.vence_max_en, h.vence_en)) * 1000) AS limite_en_ms,
  ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS servidor_ahora_ms
`;

function enteroAcotado(valor, defecto, minimo, maximo) {
  const texto = valor === undefined || valor === null ? "" : String(valor).trim();
  const numero = Number(texto);
  const base = texto === "" || !Number.isFinite(numero) ? defecto : Math.trunc(numero);
  return Math.max(minimo, Math.min(maximo, base));
}

/**
 * Márgenes del latido, leídos en cada uso para que un cambio de entorno no
 * requiera tocar el código:
 * - TURISMO_HOLDS_GRACIA_LATIDO_SEGUNDOS (150, 60-600): pestaña al frente.
 * - TURISMO_HOLDS_GRACIA_SEGUNDO_PLANO_SEGUNDOS (300, entre la gracia y el tope):
 *   último latido al ocultarse la pestaña (mobile congela los timers).
 * - TURISMO_HOLDS_LATIDO_CADA_SEGUNDOS (30, 5 a la mitad de la gracia): se
 *   devuelve al front como `latido_cada_segundos`.
 */
function obtenerConfiguracionLatido(env = process.env) {
  const topeSegundos = HOLD_TTL_MINUTOS * 60;
  const graciaSegundos = enteroAcotado(
    env.TURISMO_HOLDS_GRACIA_LATIDO_SEGUNDOS,
    HOLD_GRACIA_LATIDO_SEGUNDOS_DEFECTO,
    60,
    600
  );
  const graciaSegundoPlanoSegundos = enteroAcotado(
    env.TURISMO_HOLDS_GRACIA_SEGUNDO_PLANO_SEGUNDOS,
    HOLD_GRACIA_SEGUNDO_PLANO_SEGUNDOS_DEFECTO,
    graciaSegundos,
    topeSegundos
  );
  const latidoCadaSegundos = enteroAcotado(
    env.TURISMO_HOLDS_LATIDO_CADA_SEGUNDOS,
    HOLD_LATIDO_CADA_SEGUNDOS_DEFECTO,
    5,
    Math.max(5, Math.floor(graciaSegundos / 2))
  );
  return { topeSegundos, graciaSegundos, graciaSegundoPlanoSegundos, latidoCadaSegundos };
}

// Sin tope informado (filas previas a v2) el tope es el plazo corto, como en mapearHold.
function topeVigente(row) {
  const informado = Number(row?.limite_en_ms);
  const limite = Number.isFinite(informado) && informado > 0 ? informado : Number(row?.expira_en_ms);
  return Number.isFinite(limite) && limite > Number(row?.servidor_ahora_ms);
}

function segundosParaLiberar(row) {
  return Math.max(0, Math.ceil((Number(row?.expira_en_ms) - Number(row?.servidor_ahora_ms)) / 1000) || 0);
}

function crearErrorHold(message, statusCode, codigo, detalles = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.codigo = codigo;
  if (detalles) error.detalles = detalles;
  return error;
}

function crearErrorHoldVencido() {
  return crearErrorHold(HOLD_VENCIDO_MENSAJE, 410, "HOLD_VENCIDO");
}

function crearErrorHoldReemplazado() {
  return crearErrorHold(HOLD_REEMPLAZADO_MENSAJE, 409, "HOLD_REEMPLAZADO");
}

function crearErrorHoldActivoExistente(message, holdActual) {
  return crearErrorHold(message, 409, "HOLD_ACTIVO_EXISTENTE", {
    hold: mapearHold(holdActual),
    // Si la otra pestaña ya no late, en este tiempo el hold se libera solo.
    segundos_para_liberar: segundosParaLiberar(holdActual),
    puede_reemplazar: true,
  });
}

function esErrorTablaHoldNoMigrada(error) {
  return error?.code === "ER_NO_SUCH_TABLE" || error?.errno === 1146;
}

// Backend nuevo contra una base sin la migración v2 (latido).
function esErrorColumnasLatidoNoMigradas(error) {
  return (error?.code === "ER_BAD_FIELD_ERROR" || error?.errno === 1054)
    && /vence_max_en|ultimo_latido_en|motivo_cierre/.test(String(error?.sqlMessage || error?.message || ""));
}

function convertirErrorTablaHold(error) {
  if (!esErrorTablaHoldNoMigrada(error) && !esErrorColumnasLatidoNoMigradas(error)) return error;
  return crearErrorHold(
    "La reserva temporal de Turismo todavía no está disponible.",
    503,
    "TURISMO_HOLDS_NO_MIGRADO"
  );
}

function normalizarIdPositivo(valor) {
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  if (!["string", "number"].includes(typeof valor)) return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function normalizarModalidadHold(valor) {
  const modalidad = String(valor || MODALIDAD_FECHA_LIBRE).trim().toUpperCase();
  return [MODALIDAD_FECHA_LIBRE, MODALIDAD_BLOQUE].includes(modalidad) ? modalidad : null;
}

function normalizarTokenHold(token, { requerido = true } = {}) {
  if (token === undefined || token === null || token === "") {
    if (!requerido) return null;
    throw crearErrorHold("Falta la reserva temporal. Volvé a elegir el alojamiento.", 400, "HOLD_TOKEN_REQUERIDO");
  }
  if (typeof token !== "string") {
    throw crearErrorHold("La reserva temporal no es válida. Volvé a elegir el alojamiento.", 400, "HOLD_TOKEN_INVALIDO");
  }
  const normalizado = token.trim();
  if (
    normalizado.length < TOKEN_MIN_LENGTH ||
    normalizado.length > TOKEN_MAX_LENGTH ||
    !/^[A-Za-z0-9._~-]+$/.test(normalizado)
  ) {
    throw crearErrorHold("La reserva temporal no es válida. Volvé a elegir el alojamiento.", 400, "HOLD_TOKEN_INVALIDO");
  }
  return normalizado;
}

function generarTokenHold() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashTokenHold(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

function hashTokenCoincide(valorPersistido, hashEsperado) {
  const persistido = Buffer.from(valorPersistido || []);
  return persistido.length === hashEsperado.length && crypto.timingSafeEqual(persistido, hashEsperado);
}

function isoDesdeEpoch(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return new Date(numero).toISOString();
}

function mapearHold(row, { incluirToken = null, reemplazado = undefined } = {}) {
  if (!row) return null;
  // `expira_en` y `segundos_restantes` son la cuenta de 20 minutos del front:
  // se calculan contra el tope. Sin tope (filas previas a v2 o mocks) coincide
  // con el plazo corto. El plazo corto sale como `abandono_en`, nunca como
  // `vence_en`.
  const abandonoEnMs = Number(row.expira_en_ms);
  const limiteInformado = Number(row.limite_en_ms);
  const expiraEnMs = Number.isFinite(limiteInformado) && limiteInformado > 0 ? limiteInformado : abandonoEnMs;
  const servidorAhoraMs = Number(row.servidor_ahora_ms);
  const resultado = {
    id: Number(row.id),
    estado: String(row.estado || ""),
    actor_usuario_id: Number(row.actor_usuario_id),
    titular_usuario_id: row.titular_usuario_id == null ? null : Number(row.titular_usuario_id),
    servicio_id: Number(row.servicio_id),
    recurso_id: Number(row.recurso_id),
    bloque_fecha_id: row.bloque_fecha_id == null ? null : Number(row.bloque_fecha_id),
    modalidad: row.modalidad,
    fecha_inicio: normalizarFechaCivil(row.fecha_inicio),
    fecha_fin: normalizarFechaCivil(row.fecha_fin),
    numero_parcela: row.numero_parcela == null ? null : Number(row.numero_parcela),
    expira_en: isoDesdeEpoch(expiraEnMs),
    servidor_ahora: isoDesdeEpoch(servidorAhoraMs),
    segundos_restantes: Math.max(0, Math.floor((expiraEnMs - servidorAhoraMs) / 1000)),
    abandono_en: isoDesdeEpoch(abandonoEnMs),
    latido_cada_segundos: obtenerConfiguracionLatido().latidoCadaSegundos,
  };
  if (incluirToken) resultado.hold_token = incluirToken;
  if (reemplazado !== undefined) resultado.reemplazado = Boolean(reemplazado);
  return resultado;
}

function mismoCriterioHold(row, datos) {
  return (
    Number(row.servicio_id) === Number(datos.servicioId) &&
    Number(row.recurso_id) === Number(datos.recursoId) &&
    (row.bloque_fecha_id == null ? null : Number(row.bloque_fecha_id)) === datos.bloqueFechaId &&
    String(row.modalidad) === datos.modalidad &&
    normalizarFechaCivil(row.fecha_inicio) === datos.fechaInicio &&
    normalizarFechaCivil(row.fecha_fin) === datos.fechaFin &&
    (row.titular_usuario_id == null ? null : Number(row.titular_usuario_id)) === datos.titularUsuarioId
  );
}

function normalizarDatosAdquisicion(params) {
  const actorUsuarioId = normalizarIdPositivo(params.actorUsuarioId);
  const titularUsuarioId = params.titularUsuarioId == null
    ? null
    : normalizarIdPositivo(params.titularUsuarioId);
  const servicioId = normalizarIdPositivo(params.servicioId);
  const recursoId = normalizarIdPositivo(params.recursoId);
  const modalidad = normalizarModalidadHold(params.modalidad);
  const bloqueFechaId = params.bloqueFechaId == null
    ? null
    : normalizarIdPositivo(params.bloqueFechaId);
  const fechaInicio = normalizarFechaCivil(params.fechaInicio);
  const fechaFin = normalizarFechaCivil(params.fechaFin);
  const validacionTemporal = fechaInicio && fechaFin
    ? validarRangoReservaTemporal(fechaInicio, fechaFin)
    : { valido: false };

  if (
    !actorUsuarioId || !servicioId || !recursoId || !modalidad || !fechaInicio || !fechaFin ||
    fechaInicio >= fechaFin || !validacionTemporal.valido ||
    (params.titularUsuarioId != null && !titularUsuarioId) ||
    (params.totalPersonas != null && (!Number.isSafeInteger(Number(params.totalPersonas)) || Number(params.totalPersonas) <= 0)) ||
    (modalidad === MODALIDAD_BLOQUE && !bloqueFechaId) ||
    (modalidad === MODALIDAD_FECHA_LIBRE && bloqueFechaId !== null)
  ) {
    throw crearErrorHold(
      "Los datos para reservar temporalmente el alojamiento no son válidos.",
      400,
      "HOLD_DATOS_INVALIDOS"
    );
  }
  return {
    actorUsuarioId,
    actorRol: String(params.actorRol || "").trim().toLowerCase(),
    actorDepartamentalId: normalizarIdPositivo(params.actorDepartamentalId),
    titularUsuarioId,
    servicioId,
    recursoId,
    modalidad,
    bloqueFechaId,
    fechaInicio,
    fechaFin,
    totalPersonas: params.totalPersonas == null ? null : Number(params.totalPersonas),
  };
}

async function bloquearYValidarUsuarios(connection, datos) {
  const ids = [...new Set([datos.actorUsuarioId, datos.titularUsuarioId].filter(Boolean))].sort((a, b) => a - b);
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await connection.query(
    `SELECT u.id, u.habilitado, u.departamental_id, u.area_turismo, u.modulo_turismo, r.nombre AS rol
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
      WHERE u.id IN (${placeholders})
      ORDER BY u.id
      FOR UPDATE`,
    ids
  );
  const usuarios = new Map(rows.map((row) => [Number(row.id), row]));
  const actor = usuarios.get(datos.actorUsuarioId);
  if (!actor || actor.habilitado !== "Y") {
    throw crearErrorHold("La sesión ya no está habilitada.", 403, "HOLD_NO_AUTORIZADO");
  }
  const rolActual = String(actor.rol || "").trim().toLowerCase();
  datos.actorRol = rolActual;
  datos.actorDepartamentalId = normalizarIdPositivo(actor.departamental_id);
  if (!['admin', 'departamental', 'afiliado'].includes(rolActual)) {
    throw crearErrorHold("No tienes permisos para reservar este alojamiento.", 403, "HOLD_NO_AUTORIZADO");
  }
  if (rolActual === "departamental" && actor.area_turismo != null && Number(actor.area_turismo) !== 1) {
    throw crearErrorHold("No tienes habilitada el área Turismo.", 403, "HOLD_NO_AUTORIZADO");
  }

  if (rolActual === "afiliado") {
    if (datos.titularUsuarioId !== datos.actorUsuarioId) {
      throw crearErrorHold("No tienes permisos para reservar para otra persona.", 403, "HOLD_NO_AUTORIZADO");
    }
    if (actor.modulo_turismo != null && Number(actor.modulo_turismo) !== 1) {
      throw crearErrorHold("No tienes habilitado el módulo Turismo.", 403, "HOLD_NO_AUTORIZADO");
    }
    datos.departamentalVisibilidadId = normalizarIdPositivo(actor.departamental_id);
    return;
  }

  if (datos.titularUsuarioId == null) {
    datos.departamentalVisibilidadId = normalizarIdPositivo(actor.departamental_id);
    return;
  }
  const titular = usuarios.get(datos.titularUsuarioId);
  if (
    !titular || titular.habilitado !== "Y" ||
    String(titular.rol || "").trim().toLowerCase() !== "afiliado" ||
    (titular.modulo_turismo != null && Number(titular.modulo_turismo) !== 1)
  ) {
    throw crearErrorHold(
      "El titular debe ser un afiliado habilitado para Turismo.",
      422,
      "HOLD_TITULAR_INVALIDO"
    );
  }
  if (
    rolActual === "departamental" &&
    Number(actor.departamental_id) !== Number(titular.departamental_id)
  ) {
    throw crearErrorHold(
      "No puedes reservar para afiliados de otra departamental.",
      403,
      "HOLD_NO_AUTORIZADO"
    );
  }
  datos.departamentalVisibilidadId = normalizarIdPositivo(titular.departamental_id);
}

async function obtenerHoldPorId(connection, holdId, { forUpdate = false } = {}) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT ${SELECT_HOLD_FIELDS}
       FROM ${TABLA_HOLDS} h
      WHERE h.id = ?
      LIMIT 1${lock}`,
    [holdId]
  );
  return rows[0] || null;
}

async function obtenerHoldActivoActor(connection, actorUsuarioId, { forUpdate = false } = {}) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT ${SELECT_HOLD_FIELDS}, h.token_hash
       FROM ${TABLA_HOLDS} h
      WHERE h.actor_usuario_id = ?
        AND h.estado = 'ACTIVO'
      LIMIT 1${lock}`,
    [actorUsuarioId]
  );
  return rows[0] || null;
}

async function bloquearRecursos(connection, recursoIds, servicioIdEsperado, datos) {
  const ids = [...new Set(recursoIds.filter(Boolean).map(Number))].sort((a, b) => a - b);
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids];
  let visibilidad = "";
  if (datos.actorRol !== "admin") {
    const dep = normalizarIdPositivo(datos.departamentalVisibilidadId);
    if (dep) {
      visibilidad = `AND (
        s.alcance_departamental = 'TODAS'
        OR (s.alcance_departamental = 'PROPIA' AND s.propietario_departamental_id = ?)
        OR (s.alcance_departamental = 'SELECCIONADAS' AND EXISTS (
          SELECT 1 FROM servicio_departamental_visible sdv
           WHERE sdv.servicio_id = s.id AND sdv.departamental_id = ?
        ))
      )`;
      params.push(dep, dep);
    } else {
      visibilidad = "AND s.alcance_departamental = 'TODAS'";
    }
  }
  const [rows] = await connection.query(
    `SELECT r.id, r.servicio_id, r.cupo_maximo, r.es_recurso_principal,
            s.max_personas_reserva, s.modelo_tarifa, ts.codigo AS tipo_codigo
       FROM recurso r
       INNER JOIN servicio s ON s.id = r.servicio_id
       INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
      WHERE r.id IN (${placeholders}) AND r.activo = 1
        AND s.activo = 1 AND s.estado_aprobacion = 'APROBADO' AND ts.activo = 1
        ${visibilidad}
      ORDER BY r.id
      FOR UPDATE`,
    params
  );
  const nuevo = rows.find((row) => Number(row.id) === Number(recursoIds.at(-1)));
  if (!nuevo || Number(nuevo.servicio_id) !== Number(servicioIdEsperado)) {
    throw crearErrorHold(
      "El alojamiento no pertenece al destino seleccionado.",
      422,
      "HOLD_RECURSO_INVALIDO"
    );
  }
  const maxPersonas = Number(nuevo.max_personas_reserva);
  if (nuevo.modelo_tarifa === "PRECIO_UNICO" && Number.isInteger(datos.totalPersonas) && datos.totalPersonas !== 1) {
    throw crearErrorHold(
      "Este servicio sólo admite la reserva del titular.",
      422,
      "PRECIO_UNICO_SOLO_TITULAR"
    );
  }
  if (
    Number.isInteger(datos.totalPersonas) && Number.isInteger(maxPersonas) && maxPersonas > 0 &&
    datos.totalPersonas > maxPersonas
  ) {
    throw crearErrorHold("La cantidad de personas supera el máximo del servicio.", 422, "HOLD_CAPACIDAD_EXCEDIDA");
  }
  return nuevo;
}

async function validarBloque(connection, datos) {
  const [rows] = await connection.query(
    `SELECT bf.id, bf.servicio_id, bf.modalidad, bf.estado,
            DATE_FORMAT(bf.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(bf.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            s.estado AS sorteo_estado,
            bfr.estado AS recurso_estado,
            bfr.reserva_id
       FROM bloque_fecha bf
       INNER JOIN bloque_fecha_recurso bfr
         ON bfr.bloque_fecha_id = bf.id AND bfr.recurso_id = ?
       LEFT JOIN sorteo s ON s.id = bf.sorteo_id
      WHERE bf.id = ?
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.bloqueFechaId]
  );
  const bloque = rows[0];
  const ventaDirectaSorteo = bloque?.modalidad === "SORTEO" && bloque?.recurso_estado === "VENTA_DIRECTA";
  if (
    !bloque || bloque.estado !== "ACTIVO" ||
    Number(bloque.servicio_id) !== datos.servicioId ||
    normalizarFechaCivil(bloque.fecha_inicio) !== datos.fechaInicio ||
    normalizarFechaCivil(bloque.fecha_fin) !== datos.fechaFin ||
    !(bloque.modalidad === "BLOQUE" || ventaDirectaSorteo) ||
    !["DISPONIBLE", "VENTA_DIRECTA"].includes(bloque.recurso_estado) ||
    bloque.reserva_id != null
  ) {
    throw crearErrorHold(
      "El bloque seleccionado ya no está disponible. Elegí otra opción.",
      409,
      "HOLD_BLOQUE_NO_DISPONIBLE"
    );
  }
}

async function validarFechaLibreFueraDeBloque(connection, datos) {
  const [rows] = await connection.query(
    `SELECT bf.id, bf.modalidad, bfr.estado AS recurso_estado
       FROM bloque_fecha bf
       INNER JOIN bloque_fecha_recurso bfr
         ON bfr.bloque_fecha_id = bf.id AND bfr.recurso_id = ?
      WHERE bf.estado = 'ACTIVO'
        AND bfr.estado IN ('DISPONIBLE','SORTEO','VENTA_DIRECTA')
        AND bf.fecha_inicio < ?
        AND bf.fecha_fin > ?
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.fechaFin, datos.fechaInicio]
  );
  if (rows.length > 0) {
    const esSorteoAbierto = rows[0].modalidad === "SORTEO" && rows[0].recurso_estado !== "VENTA_DIRECTA";
    throw crearErrorHold(
      esSorteoAbierto
        ? "Esas fechas pertenecen a un sorteo y no necesitan una reserva temporal."
        : "Esas fechas se venden como bloque completo. Elegí el bloque disponible.",
      409,
      esSorteoAbierto ? "HOLD_MODALIDAD_SORTEO" : "HOLD_BLOQUE_REQUERIDO"
    );
  }
}

async function validarReservaDefinitivaNoCamping(connection, datos) {
  const [rows] = await connection.query(
    `SELECT r.id
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id = ?
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(er.nombre, '') NOT IN ('Cancelada','Rechazada','No adjudicada')
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.fechaFin, datos.fechaInicio]
  );
  if (rows.length > 0) {
    throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
  }
}

async function obtenerHoldsSolapados(connection, datos, holdIdExcluir = null, { forUpdate = true } = {}) {
  const params = [datos.recursoId, datos.fechaFin, datos.fechaInicio];
  let filtroExclusion = "";
  if (holdIdExcluir) {
    filtroExclusion = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT id, actor_usuario_id, numero_parcela
       FROM ${TABLA_HOLDS}
      WHERE recurso_id = ?
        AND estado = 'ACTIVO'
        AND vence_en > NOW(6)
        AND fecha_inicio < ?
        AND fecha_fin > ?${filtroExclusion}
      ORDER BY id${lock}`,
    params
  );
  return rows;
}

/**
 * Primera parcela libre del rango. `parcelaPreferida` (la que ya tenía el hold
 * que se recupera) gana si sigue libre, para no cambiarle el número a nadie.
 */
async function obtenerParcelasCamping(connection, datos, configuracion, holdIdExcluir = null, { parcelaPreferida = null } = {}) {
  const noches = obtenerNochesReserva(datos.fechaInicio, datos.fechaFin, 366);
  if (noches.length === 0) {
    throw crearErrorHold("El rango de fechas no es válido.", 400, "HOLD_DATOS_INVALIDOS");
  }
  let minimo = null;
  for (const fecha of noches) {
    const [cupos] = await connection.query(
      `SELECT MIN(cupo_total) AS cupo
         FROM recurso_cupo_periodo
        WHERE recurso_id = ? AND activo = 1
          AND fecha_inicio <= ? AND fecha_fin >= ?`,
      [datos.recursoId, fecha, fecha]
    );
    let parcelas = Number(cupos[0]?.cupo);
    const [rows] = await connection.query(
      `SELECT MIN(parcelas_disponibles) AS parcelas
         FROM tarifa
        WHERE recurso_id = ?
          AND fecha_inicio <= ?
          AND fecha_fin >= ?
          AND parcelas_disponibles IS NOT NULL`,
      [datos.recursoId, fecha, fecha]
    );
    if (!Number.isInteger(parcelas) || parcelas <= 0) parcelas = Number(rows[0]?.parcelas);
    if (!Number.isInteger(parcelas) || parcelas <= 0) parcelas = Number(configuracion.cupo_maximo);
    if (!Number.isInteger(parcelas) || parcelas <= 0) {
      throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
    }
    minimo = minimo === null ? parcelas : Math.min(minimo, parcelas);
  }

  const [reservas] = await connection.query(
    `SELECT r.numero_parcela
       FROM reserva r
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE r.recurso_id = ?
        AND r.numero_parcela IS NOT NULL
        AND r.fecha_inicio < ?
        AND r.fecha_fin > ?
        AND COALESCE(er.nombre, '') NOT IN ('Cancelada','Rechazada','No adjudicada')
      ORDER BY r.numero_parcela
      FOR UPDATE`,
    [datos.recursoId, datos.fechaFin, datos.fechaInicio]
  );
  const holds = await obtenerHoldsSolapados(connection, datos, holdIdExcluir, { forUpdate: true });
  const ocupadas = new Set([
    ...reservas.map((row) => Number(row.numero_parcela)),
    ...holds.map((row) => Number(row.numero_parcela)),
  ].filter((numero) => Number.isInteger(numero) && numero > 0));
  const preferida = Number(parcelaPreferida);
  if (Number.isInteger(preferida) && preferida > 0 && preferida <= minimo && !ocupadas.has(preferida)) {
    return preferida;
  }
  for (let numero = 1; numero <= minimo; numero += 1) {
    if (!ocupadas.has(numero)) return numero;
  }
  throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
}

async function validarDisponibilidad(connection, datos, configuracion, holdActual = null, { parcelaPreferida = null } = {}) {
  if (datos.modalidad === MODALIDAD_BLOQUE) {
    await validarBloque(connection, datos);
  } else {
    await validarFechaLibreFueraDeBloque(connection, datos);
  }

  if (configuracion.tipo_codigo === "CUPO_NUMERADO") {
    return obtenerParcelasCamping(connection, datos, configuracion, holdActual?.id || null, { parcelaPreferida });
  }
  await validarReservaDefinitivaNoCamping(connection, datos);
  const holds = await obtenerHoldsSolapados(connection, datos, holdActual?.id || null, { forUpdate: true });
  if (holds.length > 0) {
    throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
  }
  return null;
}

async function recargarHold(connection, holdId) {
  const row = await obtenerHoldPorId(connection, holdId);
  if (!row) throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
  return row;
}

/**
 * Crea, reemplaza o recupera el hold del actor.
 *
 * Opciones del latido (v2):
 * - `soportaLatido`: el cliente late cada `latido_cada_segundos`; el plazo corto
 *   arranca en la gracia y el tope queda en HOLD_TTL_MINUTOS. Sin la marca, los
 *   dos plazos valen HOLD_TTL_MINUTOS (bundles viejos, comportamiento v1).
 * - `reanudar`: con el MISMO token, recupera el hold que perdió el latido si el
 *   tope sigue vigente y el alojamiento continúa libre (misma fila, mismo tope).
 * - `reemplazarHoldPropio`: libera el hold ACTIVO del propio actor que tenga
 *   otro token (otra pestaña, o una que se cerró de golpe) y continúa.
 */
async function adquirirHoldTurismo(db, params) {
  const datos = normalizarDatosAdquisicion(params);
  const tokenSolicitado = normalizarTokenHold(params.holdToken, { requerido: false });
  const token = tokenSolicitado || generarTokenHold();
  const tokenHash = hashTokenHold(token);
  const soportaLatido = params.soportaLatido === true;
  // Recuperar exige el mismo token; un cliente con latido que reenvía su token
  // también quiere continuar, aunque cambie de opción.
  const quiereReanudar = Boolean(tokenSolicitado) && (params.reanudar === true || soportaLatido);
  const reemplazarHoldPropio = params.reemplazarHoldPropio === true;
  const configuracionLatido = obtenerConfiguracionLatido();
  const plazoInicialSegundos = soportaLatido
    ? configuracionLatido.graciaSegundos
    : HOLD_TTL_MINUTOS * 60;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await bloquearYValidarUsuarios(connection, datos);

    // Todos los flujos que consumen disponibilidad bloquean primero las filas
    // de recurso. La lectura preliminar sólo sirve para incluir también el
    // recurso anterior en un reemplazo; la fila del hold se relee con lock.
    const holdObservado = await obtenerHoldActivoActor(connection, datos.actorUsuarioId);
    const recursosABloquear = holdObservado
      ? [Number(holdObservado.recurso_id), datos.recursoId]
      : [datos.recursoId];
    const configuracion = await bloquearRecursos(connection, recursosABloquear, datos.servicioId, datos);

    let holdActual = await obtenerHoldActivoActor(connection, datos.actorUsuarioId, { forUpdate: true });
    // Hold del mismo token que sigue ACTIVO pero perdió el plazo corto.
    let holdARecuperar = null;
    // Hold del mismo token que el barrido ya cerró como VENCIDO por ABANDONO.
    let holdAReactivar = null;
    // Hold propio con otro token que se libera por pedido explícito.
    let holdPropioLiberado = null;
    if (holdActual && Number(holdActual.expira_en_ms) <= Number(holdActual.servidor_ahora_ms)) {
      const tokenDelHoldVencido = tokenSolicitado
        ? hashTokenCoincide(holdActual.token_hash, tokenHash)
        : false;
      if (tokenDelHoldVencido && quiereReanudar && topeVigente(holdActual)) {
        holdARecuperar = holdActual;
      } else {
        const [actualizacion] = await connection.query(
          `UPDATE ${TABLA_HOLDS}
              SET estado = 'VENCIDO', motivo_cierre = ${SQL_MOTIVO_VENCIMIENTO},
                  fecha_cierre = COALESCE(fecha_cierre, NOW(6))
            WHERE id = ? AND estado = 'ACTIVO'`,
          [holdActual.id]
        );
        if (Number(actualizacion.affectedRows) !== 1) throw crearErrorHoldVencido();
        holdActual = null;
        if (tokenDelHoldVencido) {
          await connection.commit();
          throw crearErrorHoldVencido();
        }
      }
    }

    if (holdActual && !hashTokenCoincide(holdActual.token_hash, tokenHash)) {
      if (!reemplazarHoldPropio) {
        throw crearErrorHoldActivoExistente(
          tokenSolicitado
            ? "Ya tenés un alojamiento reservado temporalmente en otra pestaña."
            : "Ya tenés un alojamiento reservado temporalmente. Volvé a ese formulario o cancelalo antes de elegir otro.",
          holdActual
        );
      }
      // Sólo puede ser del propio actor: obtenerHoldActivoActor filtra por actor.
      const [liberacion] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'LIBERADO', motivo_cierre = '${MOTIVO_CIERRE_REEMPLAZADO}', fecha_cierre = NOW(6)
          WHERE id = ? AND estado = 'ACTIVO'`,
        [holdActual.id]
      );
      if (Number(liberacion.affectedRows) !== 1) {
        throw crearErrorHold("Ya tenés una reserva temporal activa.", 409, "HOLD_ACTIVO_EXISTENTE");
      }
      holdPropioLiberado = holdActual;
      holdActual = null;
    }

    if (!holdActual) {
      const [tokenExistente] = await connection.query(
        `SELECT id, actor_usuario_id, estado, motivo_cierre,
                ROUND(UNIX_TIMESTAMP(COALESCE(vence_max_en, vence_en)) * 1000) AS limite_en_ms,
                ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS servidor_ahora_ms
           FROM ${TABLA_HOLDS}
          WHERE token_hash = ?
          LIMIT 1
          FOR UPDATE`,
        [tokenHash]
      );
      const previo = tokenExistente[0];
      if (previo) {
        const mismoActor = Number(previo.actor_usuario_id) === datos.actorUsuarioId;
        if (
          mismoActor && quiereReanudar &&
          previo.estado === HOLD_ESTADO_VENCIDO &&
          previo.motivo_cierre === MOTIVO_CIERRE_ABANDONO &&
          topeVigente(previo)
        ) {
          // uq_trh_token_hash impide insertar otra fila con este token: se revive la misma.
          holdAReactivar = await obtenerHoldPorId(connection, previo.id);
        } else if (mismoActor && previo.estado === HOLD_ESTADO_VENCIDO) {
          throw crearErrorHoldVencido();
        } else if (
          mismoActor && previo.estado === HOLD_ESTADO_LIBERADO &&
          previo.motivo_cierre === MOTIVO_CIERRE_REEMPLAZADO
        ) {
          throw crearErrorHoldReemplazado();
        } else {
          throw crearErrorHold(
            "Esa reserva temporal ya se usó. Volvé a elegir el alojamiento para iniciar otra.",
            409,
            "HOLD_TOKEN_REUTILIZADO"
          );
        }
      }
    }

    const holdConservado = holdActual || holdAReactivar;
    const numeroParcela = await validarDisponibilidad(connection, datos, configuracion, holdConservado);
    let holdId;
    let reemplazado = false;
    const reanudado = Boolean(holdARecuperar || holdAReactivar);
    if (holdConservado) {
      holdId = Number(holdConservado.id);
      reemplazado = !mismoCriterioHold(holdConservado, datos) ||
        (holdConservado.numero_parcela == null ? null : Number(holdConservado.numero_parcela)) !== numeroParcela;
    }
    if (reanudado) {
      // Recuperación: plazo corto nuevo, el tope de 20 minutos no cambia. Va
      // separado del UPDATE de reemplazo, que nunca toca los plazos.
      const [reanudacion] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET vence_max_en = COALESCE(vence_max_en, vence_en),
                vence_en = LEAST(vence_max_en, DATE_ADD(NOW(6), INTERVAL ? SECOND)),
                ultimo_latido_en = NOW(6),
                estado = 'ACTIVO', fecha_cierre = NULL, motivo_cierre = NULL,
                titular_usuario_id = ?, servicio_id = ?, recurso_id = ?, bloque_fecha_id = ?,
                modalidad = ?, fecha_inicio = ?, fecha_fin = ?, numero_parcela = ?
          WHERE id = ? AND estado = ? AND COALESCE(vence_max_en, vence_en) > NOW(6)
            AND (estado = 'ACTIVO' OR motivo_cierre = '${MOTIVO_CIERRE_ABANDONO}')`,
        [
          configuracionLatido.graciaSegundos,
          datos.titularUsuarioId,
          datos.servicioId,
          datos.recursoId,
          datos.bloqueFechaId,
          datos.modalidad,
          datos.fechaInicio,
          datos.fechaFin,
          numeroParcela,
          holdId,
          holdARecuperar ? HOLD_ESTADO_ACTIVO : HOLD_ESTADO_VENCIDO,
        ]
      );
      if (Number(reanudacion.affectedRows) !== 1) throw crearErrorHoldVencido();
    } else if (holdActual) {
      const [actualizacionHold] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET titular_usuario_id = ?, servicio_id = ?, recurso_id = ?, bloque_fecha_id = ?,
                modalidad = ?, fecha_inicio = ?, fecha_fin = ?, numero_parcela = ?
          WHERE id = ? AND estado = 'ACTIVO' AND vence_en > NOW(6)`,
        [
          datos.titularUsuarioId,
          datos.servicioId,
          datos.recursoId,
          datos.bloqueFechaId,
          datos.modalidad,
          datos.fechaInicio,
          datos.fechaFin,
          numeroParcela,
          holdId,
        ]
      );
      if (Number(actualizacionHold.affectedRows) !== 1) throw crearErrorHoldVencido();
      // vence_en y token_hash se conservan: cambiar de opción nunca reinicia los 20 minutos.
    } else {
      // Con latido el plazo corto arranca en la gracia; sin latido, los dos
      // plazos son el mismo instante (NOW(6) es constante en la sentencia).
      const [resultado] = await connection.query(
        `INSERT INTO ${TABLA_HOLDS}
          (token_hash, actor_usuario_id, titular_usuario_id, servicio_id, recurso_id,
           bloque_fecha_id, modalidad, fecha_inicio, fecha_fin, numero_parcela, estado,
           vence_en, vence_max_en, ultimo_latido_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO',
           DATE_ADD(NOW(6), INTERVAL ? SECOND),
           DATE_ADD(NOW(6), INTERVAL ${HOLD_TTL_MINUTOS} MINUTE),
           IF(?, NOW(6), NULL))`,
        [
          tokenHash,
          datos.actorUsuarioId,
          datos.titularUsuarioId,
          datos.servicioId,
          datos.recursoId,
          datos.bloqueFechaId,
          datos.modalidad,
          datos.fechaInicio,
          datos.fechaFin,
          numeroParcela,
          plazoInicialSegundos,
          soportaLatido ? 1 : 0,
        ]
      );
      holdId = Number(resultado.insertId);
    }

    const row = await recargarHold(connection, holdId);
    await connection.commit();
    let mensaje = "Guardamos este alojamiento para vos durante 20 minutos.";
    if (reanudado) {
      mensaje = "Retomamos tu reserva y conservamos el tiempo que ya tenías disponible.";
    } else if (reemplazado) {
      mensaje = "Actualizamos tu alojamiento y conservamos el tiempo que ya tenías disponible.";
    }
    return {
      ...mapearHold(row, { incluirToken: token, reemplazado }),
      creado: !holdConservado,
      reanudado,
      hold_anterior: holdConservado && reemplazado ? mapearHold(holdConservado) : null,
      hold_liberado: holdPropioLiberado ? mapearHold(holdPropioLiberado) : null,
      mensaje,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Se conserva el error original.
    }
    if (error?.code === "ER_DUP_ENTRY") {
      throw crearErrorHold(
        "Ya tenés una reserva temporal activa.",
        409,
        "HOLD_ACTIVO_EXISTENTE"
      );
    }
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

async function obtenerEstadoHold(db, { actorUsuarioId, holdId = null } = {}) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const id = holdId == null ? null : normalizarIdPositivo(holdId);
  if (!actorId || (holdId != null && !id)) {
    throw crearErrorHold("Reserva temporal no válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    let row;
    if (id) {
      row = await obtenerHoldPorId(connection, id, { forUpdate: true });
      if (row && Number(row.actor_usuario_id) !== actorId) {
        throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
      }
    } else {
      row = await obtenerHoldActivoActor(connection, actorId, { forUpdate: true });
    }
    if (row && row.estado === HOLD_ESTADO_ACTIVO && Number(row.expira_en_ms) <= Number(row.servidor_ahora_ms)) {
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', motivo_cierre = ${SQL_MOTIVO_VENCIMIENTO},
                fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [row.id]
      );
      row = await recargarHold(connection, row.id);
    }
    await connection.commit();
    const hold = row ? mapearHold(row) : null;
    return {
      activo: Boolean(hold && hold.estado === HOLD_ESTADO_ACTIVO && hold.segundos_restantes > 0),
      hold,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

async function liberarHoldTurismo(db, { actorUsuarioId, holdId, holdToken }) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const id = normalizarIdPositivo(holdId);
  const token = normalizarTokenHold(holdToken);
  if (!actorId || !id) {
    throw crearErrorHold("Reserva temporal no válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const tokenHash = hashTokenHold(token);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}, h.token_hash
         FROM ${TABLA_HOLDS} h
        WHERE h.id = ?
        LIMIT 1
        FOR UPDATE`,
      [id]
    );
    const row = rows[0];
    if (
      !row || Number(row.actor_usuario_id) !== actorId ||
      !hashTokenCoincide(row.token_hash, tokenHash)
    ) {
      throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
    }

    let liberado = false;
    let estado = row.estado;
    if (estado === HOLD_ESTADO_ACTIVO) {
      // Una liberación explícita siempre cierra con motivo LIBERADO: aunque el
      // hold hubiera perdido el plazo corto, un "reanudar" o el alta posterior
      // no pueden revivirlo (sólo se revive VENCIDO por ABANDONO). Si además ya
      // pasó el tope, el estado refleja que el tiempo se había terminado.
      estado = topeVigente(row) ? HOLD_ESTADO_LIBERADO : HOLD_ESTADO_VENCIDO;
      const [resultado] = await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = ?, motivo_cierre = '${MOTIVO_CIERRE_LIBERADO}',
                fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [estado, id]
      );
      liberado = estado === HOLD_ESTADO_LIBERADO && Number(resultado.affectedRows) === 1;
    } else if (estado === HOLD_ESTADO_VENCIDO && row.motivo_cierre === MOTIVO_CIERRE_ABANDONO) {
      // Quien libera a propósito no quiere que un "reanudar" posterior lo reviva.
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET motivo_cierre = '${MOTIVO_CIERRE_LIBERADO}'
          WHERE id = ? AND estado = 'VENCIDO' AND motivo_cierre = '${MOTIVO_CIERRE_ABANDONO}'`,
        [id]
      );
    }
    await connection.commit();
    const holdCerrado = {
      ...row,
      estado,
      servidor_ahora_ms: Date.now(),
    };
    return {
      liberado,
      estado,
      hold: mapearHold(holdCerrado),
      mensaje: liberado
        ? "Listo, liberamos el alojamiento para que puedas elegir otra opción."
        : (estado === HOLD_ESTADO_VENCIDO ? HOLD_VENCIDO_MENSAJE : "La reserva temporal ya estaba cerrada."),
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

/**
 * Clasifica un hold cuyo latido no pudo renovarse. El front decide con el
 * código: HOLD_LATIDO_PERDIDO → intenta recuperarlo con el mismo token y
 * `reanudar`; HOLD_VENCIDO → se acabó el tope; HOLD_REEMPLAZADO → la reserva
 * siguió en otra pestaña; HOLD_NO_ACTIVO → ya se usó o se liberó.
 */
function crearErrorLatidoNoRenovado(row) {
  const recuperable = row.estado === HOLD_ESTADO_ACTIVO
    || (row.estado === HOLD_ESTADO_VENCIDO && row.motivo_cierre === MOTIVO_CIERRE_ABANDONO);
  if (recuperable && topeVigente(row)) {
    return crearErrorHold(HOLD_LATIDO_PERDIDO_MENSAJE, 409, "HOLD_LATIDO_PERDIDO", { hold: mapearHold(row) });
  }
  if (row.estado === HOLD_ESTADO_ACTIVO || row.estado === HOLD_ESTADO_VENCIDO) {
    return crearErrorHoldVencido();
  }
  if (row.estado === HOLD_ESTADO_LIBERADO && row.motivo_cierre === MOTIVO_CIERRE_REEMPLAZADO) {
    return crearErrorHoldReemplazado();
  }
  return crearErrorHold(
    "La reserva temporal ya fue utilizada o liberada.",
    409,
    "HOLD_NO_ACTIVO",
    { estado: String(row.estado || "") }
  );
}

/**
 * Latido del formulario: renueva el plazo corto de un hold ACTIVO que todavía
 * no lo perdió, sin pasar nunca el tope. `segundoPlano` usa la gracia larga
 * (último latido antes de que el navegador congele la pestaña).
 *
 * Un latido NUNCA revive un hold: el latido keepalive de `visibilitychange`
 * puede llegar después del DELETE del `pagehide` (los dos viajan en paralelo).
 */
async function renovarLatidoHoldTurismo(db, { actorUsuarioId, holdId, holdToken, segundoPlano = false } = {}) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const id = normalizarIdPositivo(holdId);
  const token = normalizarTokenHold(holdToken);
  if (!actorId || !id) {
    throw crearErrorHold("Reserva temporal no válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const tokenHash = hashTokenHold(token);
  const configuracion = obtenerConfiguracionLatido();
  const graciaSegundos = segundoPlano === true
    ? configuracion.graciaSegundoPlanoSegundos
    : configuracion.graciaSegundos;
  const connection = await db.getConnection();
  try {
    // MySQL asigna los SET de izquierda a derecha: vence_max_en ya queda
    // relleno (filas previas a v2) cuando se calcula el nuevo vence_en.
    const [resultado] = await connection.query(
      `UPDATE ${TABLA_HOLDS}
          SET vence_max_en = COALESCE(vence_max_en, vence_en),
              vence_en = LEAST(vence_max_en, DATE_ADD(NOW(6), INTERVAL ? SECOND)),
              ultimo_latido_en = NOW(6)
        WHERE id = ? AND actor_usuario_id = ? AND token_hash = ?
          AND estado = 'ACTIVO' AND vence_en > NOW(6)`,
      [graciaSegundos, id, actorId, tokenHash]
    );
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}, h.token_hash
         FROM ${TABLA_HOLDS} h
        WHERE h.id = ?
        LIMIT 1`,
      [id]
    );
    const row = rows[0];
    if (!row || Number(row.actor_usuario_id) !== actorId || !hashTokenCoincide(row.token_hash, tokenHash)) {
      throw crearErrorHold("Reserva temporal no encontrada.", 404, "HOLD_NO_ENCONTRADO");
    }
    const vigente = row.estado === HOLD_ESTADO_ACTIVO
      && Number(row.expira_en_ms) > Number(row.servidor_ahora_ms);
    // affectedRows 0 con la fila vigente sólo pasa si un "reanudar" la recuperó
    // entre el UPDATE y la relectura: también es una señal de vida válida.
    if (!vigente) throw crearErrorLatidoNoRenovado(row);
    return {
      activo: true,
      renovado: Number(resultado.affectedRows) === 1,
      segundo_plano: segundoPlano === true,
      latido_cada_segundos: configuracion.latidoCadaSegundos,
      hold: mapearHold(row),
    };
  } catch (error) {
    throw convertirErrorTablaHold(error);
  } finally {
    connection.release();
  }
}

/**
 * Valida (FOR UPDATE) el hold con el que se confirma el alta, dentro de la
 * transacción del alta. HOLD_VENCIDO sólo cuando pasó el tope de 20 minutos:
 * si lo que se perdió fue el plazo corto (sin latidos), se recupera como en
 * `reanudar` (ver recuperarHoldParaReservaEnTransaccion). Devuelve
 * `{ id, numeroParcela, hold, recuperado }`.
 */
async function validarHoldParaReservaEnTransaccion(connection, params) {
  const actorUsuarioId = normalizarIdPositivo(params.actorUsuarioId);
  const titularUsuarioId = params.titularUsuarioId == null ? null : normalizarIdPositivo(params.titularUsuarioId);
  const servicioId = normalizarIdPositivo(params.servicioId);
  const recursoId = normalizarIdPositivo(params.recursoId);
  const bloqueFechaId = params.bloqueFechaId == null ? null : normalizarIdPositivo(params.bloqueFechaId);
  const modalidad = normalizarModalidadHold(params.modalidad);
  const fechaInicio = normalizarFechaCivil(params.fechaInicio);
  const fechaFin = normalizarFechaCivil(params.fechaFin);
  const holdIdSolicitado = params.holdId == null ? null : normalizarIdPositivo(params.holdId);
  if (params.holdId != null && !holdIdSolicitado) {
    throw crearErrorHold("La reserva temporal no es válida.", 400, "HOLD_DATOS_INVALIDOS");
  }
  const token = normalizarTokenHold(params.holdToken);
  const tokenHash = hashTokenHold(token);

  try {
    const filtros = ["h.token_hash = ?"];
    const valores = [tokenHash];
    if (holdIdSolicitado) {
      filtros.push("h.id = ?");
      valores.push(holdIdSolicitado);
    }
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}
         FROM ${TABLA_HOLDS} h
        WHERE ${filtros.join(" AND ")}
        LIMIT 1
        FOR UPDATE`,
      valores
    );
    const row = rows[0];
    if (!row || Number(row.actor_usuario_id) !== actorUsuarioId) {
      throw crearErrorHold("La reserva temporal no corresponde a tu sesión.", 403, "HOLD_NO_AUTORIZADO");
    }
    const abandonado = row.estado === HOLD_ESTADO_VENCIDO && row.motivo_cierre === MOTIVO_CIERRE_ABANDONO;
    if (row.estado !== HOLD_ESTADO_ACTIVO && !abandonado) {
      if (row.estado === HOLD_ESTADO_VENCIDO) throw crearErrorHoldVencido();
      throw crearErrorHold("La reserva temporal ya fue utilizada o liberada.", 409, "HOLD_NO_ACTIVO");
    }
    // Perdió el plazo corto (pestaña suspendida, red caída) sin haber confirmado.
    const perdioPlazoCorto = abandonado || Number(row.expira_en_ms) <= Number(row.servidor_ahora_ms);
    if (perdioPlazoCorto && !topeVigente(row)) {
      if (row.estado === HOLD_ESTADO_ACTIVO) {
        await connection.query(
          `UPDATE ${TABLA_HOLDS}
              SET estado = 'VENCIDO', motivo_cierre = ${SQL_MOTIVO_VENCIMIENTO},
                  fecha_cierre = COALESCE(fecha_cierre, NOW(6))
            WHERE id = ? AND estado = 'ACTIVO'`,
          [row.id]
        );
      }
      throw crearErrorHoldVencido();
    }
    const coincide = (
      Number(row.servicio_id) === servicioId &&
      Number(row.recurso_id) === recursoId &&
      (row.bloque_fecha_id == null ? null : Number(row.bloque_fecha_id)) === bloqueFechaId &&
      row.modalidad === modalidad &&
      normalizarFechaCivil(row.fecha_inicio) === fechaInicio &&
      normalizarFechaCivil(row.fecha_fin) === fechaFin &&
      (row.titular_usuario_id == null ? null : Number(row.titular_usuario_id)) === titularUsuarioId
    );
    if (!coincide) {
      throw crearErrorHold(
        "La reserva temporal no coincide con el alojamiento o las fechas enviadas.",
        409,
        "HOLD_DATOS_NO_COINCIDEN"
      );
    }
    if (perdioPlazoCorto) {
      const recuperado = await recuperarHoldParaReservaEnTransaccion(connection, row, {
        actorUsuarioId,
        servicioId,
        recursoId,
        bloqueFechaId,
        modalidad,
        fechaInicio,
        fechaFin,
      });
      return {
        id: Number(recuperado.id),
        numeroParcela: recuperado.numero_parcela == null ? null : Number(recuperado.numero_parcela),
        hold: mapearHold(recuperado),
        recuperado: true,
      };
    }
    // El alta es una señal de vida: se extiende el plazo corto (nunca se acorta
    // ni pasa el tope) para que una transacción larga no llegue vencida a
    // consumirHoldEnTransaccion. Si el alta hace rollback, esto también.
    await connection.query(
      `UPDATE ${TABLA_HOLDS}
          SET vence_en = GREATEST(vence_en, LEAST(COALESCE(vence_max_en, vence_en), DATE_ADD(NOW(6), INTERVAL ? SECOND)))
        WHERE id = ? AND estado = 'ACTIVO'`,
      [obtenerConfiguracionLatido().graciaSegundos, row.id]
    );
    return {
      id: Number(row.id),
      numeroParcela: row.numero_parcela == null ? null : Number(row.numero_parcela),
      hold: mapearHold(row),
      recuperado: false,
    };
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      throw crearErrorHold("Ya tenés una reserva temporal activa.", 409, "HOLD_ACTIVO_EXISTENTE");
    }
    throw convertirErrorTablaHold(error);
  }
}

/**
 * Confirmar la reserva con el hold sin plazo corto (ACTIVO vencido o VENCIDO
 * por ABANDONO) pero con el tope de 20 minutos vigente: la persona todavía ve
 * minutos en el contador, así que es el mismo caso que `reanudar`. Se revalida
 * la disponibilidad excluyendo el hold propio y, si sigue libre, se extiende el
 * plazo corto (sin pasar el tope) y se revive la misma fila; si otra persona lo
 * tomó mientras tanto, HOLD_RECURSO_NO_DISPONIBLE (o HOLD_BLOQUE_NO_DISPONIBLE).
 *
 * Locks: el alta ya bloqueó usuario → recurso → esta fila, el mismo orden que
 * adquirirHoldTurismo. El recurso se vuelve a pedir con FOR UPDATE (no-op en el
 * alta) para que ningún llamador pueda revalidar sin tenerlo. Todo vive en la
 * transacción del alta: si el alta hace rollback, el hold queda como estaba.
 */
async function recuperarHoldParaReservaEnTransaccion(connection, row, datos) {
  const [recursos] = await connection.query(
    `SELECT r.id AS recurso_id, r.cupo_maximo, ts.codigo AS tipo_codigo
       FROM recurso r
       INNER JOIN servicio s ON s.id = r.servicio_id
       INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
      WHERE r.id = ? AND r.servicio_id = ?
      LIMIT 1
      FOR UPDATE`,
    [datos.recursoId, datos.servicioId]
  );
  const configuracion = recursos[0];
  if (!configuracion) {
    throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
  }

  if (row.estado === HOLD_ESTADO_VENCIDO) {
    // uq_trh_actor_activo: revivir exige que el actor no tenga otro ACTIVO.
    const otro = await obtenerHoldActivoActor(connection, datos.actorUsuarioId, { forUpdate: true });
    if (otro && Number(otro.id) !== Number(row.id)) {
      if (Number(otro.expira_en_ms) > Number(otro.servidor_ahora_ms)) {
        throw crearErrorHoldActivoExistente(
          "Ya tenés un alojamiento reservado temporalmente en otra pestaña.",
          otro
        );
      }
      // El otro también perdió el latido: ya no retiene nada, se cierra.
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', motivo_cierre = ${SQL_MOTIVO_VENCIMIENTO},
                fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id = ? AND estado = 'ACTIVO'`,
        [otro.id]
      );
    }
  }

  const numeroParcela = await validarDisponibilidad(connection, datos, configuracion, row, {
    parcelaPreferida: row.numero_parcela,
  });
  // MySQL asigna los SET de izquierda a derecha (ver renovarLatidoHoldTurismo).
  const [recuperacion] = await connection.query(
    `UPDATE ${TABLA_HOLDS}
        SET vence_max_en = COALESCE(vence_max_en, vence_en),
            vence_en = LEAST(vence_max_en, DATE_ADD(NOW(6), INTERVAL ? SECOND)),
            ultimo_latido_en = NOW(6),
            estado = 'ACTIVO', fecha_cierre = NULL, motivo_cierre = NULL,
            numero_parcela = ?
      WHERE id = ? AND estado = ? AND COALESCE(vence_max_en, vence_en) > NOW(6)
        AND (estado = 'ACTIVO' OR motivo_cierre = '${MOTIVO_CIERRE_ABANDONO}')`,
    [obtenerConfiguracionLatido().graciaSegundos, numeroParcela, row.id, row.estado]
  );
  if (Number(recuperacion.affectedRows) !== 1) throw crearErrorHoldVencido();
  return recargarHold(connection, row.id);
}

async function consumirHoldEnTransaccion(connection, { holdId, reservaId }) {
  const id = normalizarIdPositivo(holdId);
  const reserva = normalizarIdPositivo(reservaId);
  if (!id || !reserva) {
    throw crearErrorHold("No se pudo vincular la reserva temporal.", 500, "HOLD_CONSUMO_INVALIDO");
  }
  try {
    const [resultado] = await connection.query(
      `UPDATE ${TABLA_HOLDS}
          SET estado = 'CONSUMIDO', reserva_id = ?, fecha_cierre = NOW(6)
        WHERE id = ? AND estado = 'ACTIVO' AND vence_en > NOW(6)`,
      [reserva, id]
    );
    if (Number(resultado.affectedRows) !== 1) throw crearErrorHoldVencido();
  } catch (error) {
    throw convertirErrorTablaHold(error);
  }
}

async function asegurarSinHoldAjenoEnTransaccion(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const datos = {
    recursoId: normalizarIdPositivo(recursoId),
    fechaInicio: normalizarFechaCivil(fechaInicio),
    fechaFin: normalizarFechaCivil(fechaFin),
  };
  if (!datos.recursoId || !datos.fechaInicio || !datos.fechaFin) {
    throw crearErrorHold("Los datos de disponibilidad no son válidos.", 400, "HOLD_DATOS_INVALIDOS");
  }
  try {
    const rows = await obtenerHoldsSolapados(connection, datos, holdIdExcluir, { forUpdate: true });
    if (rows.length > 0) {
      throw crearErrorHold(HOLD_CONFLICTO_MENSAJE, 409, "HOLD_RECURSO_NO_DISPONIBLE");
    }
  } catch (error) {
    throw convertirErrorTablaHold(error);
  }
}

async function obtenerHoldIdActivoPorToken(connection, { actorUsuarioId, holdToken }) {
  const actorId = normalizarIdPositivo(actorUsuarioId);
  const token = normalizarTokenHold(holdToken, { requerido: false });
  if (!actorId || !token) return null;
  try {
    const [rows] = await connection.query(
      `SELECT id
         FROM ${TABLA_HOLDS}
        WHERE actor_usuario_id = ?
          AND token_hash = ?
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
        LIMIT 1`,
      [actorId, hashTokenHold(token)]
    );
    return rows.length === 1 ? Number(rows[0].id) : null;
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return null;
    throw error;
  }
}

async function obtenerRecursosRetenidos(connection, {
  recursoIds,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const ids = [...new Set((recursoIds || []).map(normalizarIdPositivo).filter(Boolean))];
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  if (ids.length === 0 || !inicio || !fin) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids, fin, inicio];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT DISTINCT recurso_id
         FROM ${TABLA_HOLDS}
        WHERE recurso_id IN (${placeholders})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
          AND fecha_inicio < ?
          AND fecha_fin > ?${filtro}`,
      params
    );
    return new Set(rows.map((row) => Number(row.recurso_id)));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Set();
    throw error;
  }
}

async function listarHoldsActivosRecursos(connection, {
  recursoIds,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const ids = [...new Set((recursoIds || []).map(normalizarIdPositivo).filter(Boolean))];
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  if (ids.length === 0 || !inicio || !fin) return [];
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids, fin, inicio];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT id, recurso_id, numero_parcela,
              DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
              DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS fecha_fin
         FROM ${TABLA_HOLDS}
        WHERE recurso_id IN (${placeholders})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
          AND fecha_inicio < ?
          AND fecha_fin > ?${filtro}`,
      params
    );
    return rows.map((row) => ({
      id: Number(row.id),
      recurso_id: Number(row.recurso_id),
      numero_parcela: row.numero_parcela == null ? null : Number(row.numero_parcela),
      fecha_inicio: row.fecha_inicio,
      fecha_fin: row.fecha_fin,
    }));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return [];
    throw error;
  }
}

async function contarHoldsActivosRecurso(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
}) {
  const id = normalizarIdPositivo(recursoId);
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  if (!id || !inicio || !fin) return 0;
  const params = [id, fin, inicio];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS total
         FROM ${TABLA_HOLDS}
        WHERE recurso_id = ?
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)
          AND fecha_inicio < ?
          AND fecha_fin > ?${filtro}`,
      params
    );
    return Number(rows[0]?.total || 0);
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return 0;
    throw error;
  }
}

async function obtenerNumerosParcelasRetenidas(connection, {
  recursoId,
  fechaInicio,
  fechaFin,
  holdIdExcluir = null,
  forUpdate = false,
}) {
  const datos = {
    recursoId: normalizarIdPositivo(recursoId),
    fechaInicio: normalizarFechaCivil(fechaInicio),
    fechaFin: normalizarFechaCivil(fechaFin),
  };
  if (!datos.recursoId || !datos.fechaInicio || !datos.fechaFin) return new Set();
  try {
    const rows = await obtenerHoldsSolapados(connection, datos, holdIdExcluir, { forUpdate });
    return new Set(rows
      .map((row) => Number(row.numero_parcela))
      .filter((numero) => Number.isInteger(numero) && numero > 0));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Set();
    throw error;
  }
}

async function obtenerBloquesRecursosRetenidos(connection, {
  bloqueFechaIds,
  holdIdExcluir = null,
}) {
  const ids = [...new Set((bloqueFechaIds || []).map(normalizarIdPositivo).filter(Boolean))];
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const params = [...ids];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT bloque_fecha_id, recurso_id
         FROM ${TABLA_HOLDS}
        WHERE bloque_fecha_id IN (${placeholders})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)${filtro}`,
      params
    );
    return new Set(rows.map((row) => `${Number(row.bloque_fecha_id)}:${Number(row.recurso_id)}`));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Set();
    throw error;
  }
}

async function contarHoldsActivosPorBloque(connection, { bloqueFechaIds, holdIdExcluir = null }) {
  const ids = [...new Set((bloqueFechaIds || []).map(normalizarIdPositivo).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const params = [...ids];
  let filtro = "";
  if (holdIdExcluir) {
    filtro = " AND id <> ?";
    params.push(holdIdExcluir);
  }
  try {
    const [rows] = await connection.query(
      `SELECT bloque_fecha_id, COUNT(*) AS total
         FROM ${TABLA_HOLDS}
        WHERE bloque_fecha_id IN (${ids.map(() => "?").join(",")})
          AND estado = 'ACTIVO'
          AND vence_en > NOW(6)${filtro}
        GROUP BY bloque_fecha_id`,
      params
    );
    return new Map(rows.map((row) => [Number(row.bloque_fecha_id), Number(row.total || 0)]));
  } catch (error) {
    if (esErrorTablaHoldNoMigrada(error)) return new Map();
    throw error;
  }
}

async function expirarHoldsVencidos(db, { limite = 200 } = {}) {
  const limiteSeguro = Number.isInteger(Number(limite))
    ? Math.max(1, Math.min(1000, Number(limite)))
    : 200;
  const connection = await db.getConnection();
  let lockTomado = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 0) AS adquirido", [LOCK_EXPIRACION_HOLDS]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) return { ejecutado: false, holds: [] };
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT ${SELECT_HOLD_FIELDS}
         FROM ${TABLA_HOLDS} h
        WHERE h.estado = 'ACTIVO' AND h.vence_en <= NOW(6)
        ORDER BY h.vence_en, h.id
        LIMIT ${limiteSeguro}
        FOR UPDATE SKIP LOCKED`
    );
    if (rows.length > 0) {
      const ids = rows.map((row) => Number(row.id));
      await connection.query(
        `UPDATE ${TABLA_HOLDS}
            SET estado = 'VENCIDO', motivo_cierre = ${SQL_MOTIVO_VENCIMIENTO},
                fecha_cierre = COALESCE(fecha_cierre, NOW(6))
          WHERE id IN (${ids.map(() => "?").join(",")}) AND estado = 'ACTIVO'`,
        ids
      );
    }
    await connection.commit();
    return {
      ejecutado: true,
      holds: rows.map((row) => ({
        ...mapearHold(row),
        motivo_cierre: Number(row.expira_en_ms) < Number(row.limite_en_ms)
          ? MOTIVO_CIERRE_ABANDONO
          : MOTIVO_CIERRE_TIEMPO,
      })),
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    if (esErrorTablaHoldNoMigrada(error)) return { ejecutado: false, holds: [], noMigrado: true };
    throw error;
  } finally {
    if (lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_EXPIRACION_HOLDS]);
      } catch (_) {}
    }
    connection.release();
  }
}

function iniciarMantenimientoHolds(db, {
  intervaloMs = Number(process.env.TURISMO_HOLDS_EXPIRACION_INTERVALO_MS || 15000),
  demoraInicialMs = Number(process.env.TURISMO_HOLDS_EXPIRACION_DEMORA_INICIAL_MS || 5000),
  onExpirados = null,
} = {}) {
  const intervaloSeguro = Number.isFinite(intervaloMs)
    ? Math.max(5000, Math.min(60000, Math.trunc(intervaloMs)))
    : 15000;
  const demoraSegura = Number.isFinite(demoraInicialMs)
    ? Math.max(0, Math.min(60000, Math.trunc(demoraInicialMs)))
    : 5000;
  let ejecutando = false;
  const ejecutar = async () => {
    if (ejecutando) return;
    ejecutando = true;
    try {
      const resultado = await expirarHoldsVencidos(db);
      if (resultado.holds.length > 0 && typeof onExpirados === "function") {
        await onExpirados(resultado.holds);
      }
    } catch (error) {
      console.error("Error en mantenimiento de reservas temporales de Turismo:", error?.code || error?.message);
    } finally {
      ejecutando = false;
    }
  };
  const inicio = setTimeout(() => void ejecutar(), demoraSegura);
  const intervalo = setInterval(() => void ejecutar(), intervaloSeguro);
  inicio.unref?.();
  intervalo.unref?.();
  return () => {
    clearTimeout(inicio);
    clearInterval(intervalo);
  };
}

function crearEventoInvalidacionHold(hold, motivo) {
  if (!hold) return null;
  return {
    motivo,
    servicio_ids: [Number(hold.servicio_id)],
    servicio_id: Number(hold.servicio_id),
    recurso_id: Number(hold.recurso_id),
    bloque_fecha_id: hold.bloque_fecha_id == null ? null : Number(hold.bloque_fecha_id),
    fecha_inicio: hold.fecha_inicio,
    fecha_fin: hold.fecha_fin,
    emitido_en: new Date().toISOString(),
  };
}

module.exports = {
  HOLD_CONFLICTO_MENSAJE,
  HOLD_ESTADO_ACTIVO,
  HOLD_ESTADO_CONSUMIDO,
  HOLD_ESTADO_LIBERADO,
  HOLD_ESTADO_VENCIDO,
  HOLD_TTL_MINUTOS,
  HOLD_VENCIDO_MENSAJE,
  MODALIDAD_BLOQUE,
  MODALIDAD_FECHA_LIBRE,
  MOTIVO_CIERRE_ABANDONO,
  MOTIVO_CIERRE_LIBERADO,
  MOTIVO_CIERRE_REEMPLAZADO,
  MOTIVO_CIERRE_TIEMPO,
  TABLA_HOLDS,
  adquirirHoldTurismo,
  asegurarSinHoldAjenoEnTransaccion,
  consumirHoldEnTransaccion,
  contarHoldsActivosPorBloque,
  contarHoldsActivosRecurso,
  crearErrorHold,
  crearEventoInvalidacionHold,
  esErrorTablaHoldNoMigrada,
  expirarHoldsVencidos,
  generarTokenHold,
  hashTokenHold,
  iniciarMantenimientoHolds,
  liberarHoldTurismo,
  listarHoldsActivosRecursos,
  mapearHold,
  normalizarTokenHold,
  obtenerBloquesRecursosRetenidos,
  obtenerConfiguracionLatido,
  obtenerEstadoHold,
  obtenerHoldIdActivoPorToken,
  obtenerNumerosParcelasRetenidas,
  obtenerRecursosRetenidos,
  renovarLatidoHoldTurismo,
  validarHoldParaReservaEnTransaccion,
};
