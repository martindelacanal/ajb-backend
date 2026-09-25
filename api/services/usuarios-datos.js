"use strict";

// ============================================================================
// Edición de los datos de una persona (tabla `usuario`) — servicio único.
//
// Todas las pantallas que cambian datos de una persona (configuración de
// usuario, acompañantes, coseguro y la aprobación de cambios de familiares)
// pasan por `actualizarDatosUsuario`, que corre DENTRO de la transacción del
// llamador y se encarga de:
//   1. bloquear la fila (FOR UPDATE) y autorizar al actor sobre el objetivo;
//   2. aplicar la lista blanca de campos por rol (403 explícito por campo);
//   3. normalizar y validar cada valor (largos, DNI 6-8, CUIL/CBU, fechas,
//      catálogos, reglas de tipo de persona / edad / parentesco);
//   4. controlar unicidad de DNI y email;
//   5. escribir el UPDATE y el historial ESTRICTO (si el historial falla, se
//      revierte todo el cambio);
//   6. propagar el cambio a las copias que guardan otros módulos (familiares,
//      coseguro, traslados, turismo y olimpiadas) respetando los triggers:
//      - departamental del titular: sólo a los integrantes que la tenían vacía
//        o igual a la anterior del titular (los de sede propia se avisan con
//        DEPARTAMENTAL_INTEGRANTE_NO_PROPAGADA), a su coseguro 1-3 y traslados
//        iniciados, y los pedidos PENDIENTES de cambios de familiares del grupo
//        se reasignan con familiares-cambios.js (avisa a la sede nueva);
//      - CUIL/CBU: sólo a las solicitudes de coseguro que el actor podría
//        editar desde Coseguro (ESTADOS_COSEGURO_EDICION_POR_ROL); el resto se
//        avisa con COSEGURO_DATO_BANCARIO_NO_PROPAGADO y sus ids.
//
// Este archivo no importa nada de routes/*.js para no generar ciclos: los
// helpers chicos que necesita están duplicados acá a propósito.
// ============================================================================

const bcryptjs = require("bcryptjs");
const { DNI_MENSAJE, esDniValido } = require("../security/dni");
const {
  calcularEdadEnFecha,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  validarCbu,
  validarCuitCuil,
} = require("./valores-dominio");

// ---------------------------------------------------------------------------
// Catálogos y constantes
// ---------------------------------------------------------------------------
const ROL_NOMBRE_POR_ID = Object.freeze({
  1: "admin",
  2: "afiliado",
  3: "departamental",
  4: "invitado",
  5: "admin-central",
  6: "auditor",
  7: "prensa",
});

// Roles de las personas que el staff (admin-central / departamental) puede gestionar.
const ROLES_OBJETIVO_STAFF = Object.freeze(["afiliado", "invitado"]);

// Reservas "abiertas": todo lo que no es Rechazada (4), Utilizada (5),
// No adjudicada (8) ni Convenio rechazado (12).
const ESTADOS_RESERVA_ABIERTA = Object.freeze([1, 2, 3, 6, 7, 9, 10, 11]);
// Coseguro: al cambiar la departamental sólo se mueven las solicitudes que
// todavía están en manos de la departamental.
const ESTADOS_COSEGURO_MOVER_DEPARTAMENTAL = Object.freeze([1, 2, 3]);
// Coseguro: CUIL/CBU se corrigen en todo lo que todavía no se exportó para
// liquidar, pero sólo en las solicitudes que el ACTOR podría editar desde
// Coseguro (ver ESTADOS_COSEGURO_EDICION_POR_ROL).
const ESTADOS_COSEGURO_DATOS_BANCARIOS = Object.freeze([1, 2, 3, 4, 7]);
// Espejo EXACTO de ESTADOS_EDICION_POR_ROL de routes/coseguro.js (no se importa
// para no depender de un router). test/usuarios-datos.test.js lee el router y
// falla si las dos matrices dejan de coincidir.
//   1 Iniciada · 2 Revisar · 3 Revisada · 4 Aprobada departamental · 7 Aprobada central
const ESTADOS_COSEGURO_EDICION_POR_ROL = Object.freeze({
  afiliado: Object.freeze([1, 2]),
  departamental: Object.freeze([1, 2, 3, 4]),
  "admin-central": Object.freeze([4, 7]),
  admin: Object.freeze([1, 2, 3, 4, 7]),
});
const NOMBRE_ESTADO_COSEGURO = Object.freeze({
  1: "iniciada",
  2: "para revisar",
  3: "revisada",
  4: "aprobada por la departamental",
  7: "aprobada por Servicios Sociales",
});
// Roles del staff limitados por área (usuario.area_turismo / area_coseguro).
const ROLES_CON_AREA = Object.freeze(["departamental", "admin-central"]);
const ESTADO_TRASLADO_INICIADA = 1;
const PARENTESCOS_FAMILIARES = Object.freeze([2, 3, 4]);
const PARENTESCO_TITULAR = 1;
const TIPO_PERSONA_FAMILIAR = 2;
const TIPO_PERSONA_MENOR_2 = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Definición de cada campo editable: tipo de normalización, largo máximo y
// etiqueta legible para los mensajes.
const DEFINICION_CAMPOS = Object.freeze({
  rol_id: { tipo: "id", etiqueta: "rol", requerido: true },
  departamental_id: { tipo: "id", etiqueta: "departamental" },
  area_turismo: { tipo: "binario", etiqueta: "área Turismo" },
  area_coseguro: { tipo: "binario", etiqueta: "área Coseguro" },
  modulo_turismo: { tipo: "binario", etiqueta: "módulo Turismo" },
  modulo_coseguro: { tipo: "binario", etiqueta: "módulo Coseguro" },
  modulo_olimpiadas: { tipo: "binario", etiqueta: "módulo Olimpíadas" },
  tipo_persona_id: { tipo: "id", etiqueta: "tipo de persona" },
  parentesco_id: { tipo: "id", etiqueta: "parentesco" },
  es_familiar: { tipo: "si_no_familiar", etiqueta: "integra el grupo familiar" },
  nombre: { tipo: "texto", max: 45, etiqueta: "nombre", requerido: true },
  apellido: { tipo: "texto", max: 45, etiqueta: "apellido", requerido: true },
  fecha_nacimiento: { tipo: "fecha", etiqueta: "fecha de nacimiento" },
  documento: { tipo: "documento", etiqueta: "DNI" },
  email: { tipo: "email", max: 45, etiqueta: "email" },
  telefono: { tipo: "texto", max: 15, etiqueta: "teléfono" },
  direccion: { tipo: "texto", max: 50, etiqueta: "dirección" },
  dependencia_judicial: { tipo: "texto", max: 50, etiqueta: "dependencia judicial" },
  legajo: { tipo: "texto", max: 45, etiqueta: "legajo" },
  habilitado: { tipo: "si_no_habilitado", etiqueta: "habilitado" },
  cuil: { tipo: "cuil", etiqueta: "CUIL" },
  cbu: { tipo: "cbu", etiqueta: "CBU" },
  password: { tipo: "password", etiqueta: "contraseña" },
  foto_archivo: { tipo: "foto", max: 255, etiqueta: "foto" },
});

// Orden estable de las columnas en el UPDATE y en el historial (el mismo que
// usaba la ruta de configuración, más parentesco / es_familiar).
const ORDEN_CAMPOS = Object.freeze([
  "rol_id", "departamental_id", "area_turismo", "area_coseguro",
  "modulo_turismo", "modulo_coseguro", "modulo_olimpiadas",
  "tipo_persona_id", "parentesco_id", "es_familiar",
  "nombre", "apellido", "fecha_nacimiento", "documento", "email", "telefono",
  "direccion", "dependencia_judicial", "legajo", "habilitado", "cuil", "cbu",
  "password", "foto_archivo",
]);
const CAMPOS_USUARIO_EDITABLES = ORDEN_CAMPOS;
const CAMPOS_SNAPSHOT = ORDEN_CAMPOS.filter((campo) => campo !== "password");

// Perfil propio (cualquier rol que no sea admin editándose a sí mismo).
const CAMPOS_PERFIL_PROPIO = Object.freeze([
  "nombre", "apellido", "email", "telefono", "direccion", "dependencia_judicial",
  "cuil", "cbu", "foto_archivo", "password",
]);
// Datos personales que admin, admin-central y departamental editan sobre las
// personas que gestionan.
const CAMPOS_DATOS_PERSONALES = Object.freeze([
  "nombre", "apellido", "documento", "fecha_nacimiento", "tipo_persona_id",
  "parentesco_id", "es_familiar", "email", "telefono", "direccion",
  "dependencia_judicial", "legajo", "cuil", "cbu", "habilitado", "foto_archivo",
]);
const CAMPOS_MODULOS = Object.freeze(["modulo_turismo", "modulo_coseguro", "modulo_olimpiadas"]);

const OBSERVACION_POR_ORIGEN = Object.freeze({
  configuracion: "Actualización de configuración de usuario",
  acompaniantes: "Datos de la persona actualizados por el personal",
  coseguro: "Actualización desde Coseguro médico",
  aprobacion: "Cambio de datos aprobado por el personal",
});

// ---------------------------------------------------------------------------
// Helpers chicos (duplicados de routes/user.js a propósito, ver cabecera)
// ---------------------------------------------------------------------------
function crearErrorUsuario(mensaje, statusCode = 400, codigo = null, extra = {}) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  error.codigo = codigo;
  Object.assign(error, extra);
  return error;
}

function idPositivo(valor) {
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function textoONull(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto === "" ? null : texto;
}

function normalizarSiNoEstricto(valor) {
  if ([true, 1, "1", "true", "Y"].includes(valor)) return "Y";
  if ([false, 0, "0", "false", "N"].includes(valor)) return "N";
  return null;
}

function normalizarBooleanoBinarioEstricto(valor) {
  if ([true, 1, "1", "true"].includes(valor)) return 1;
  if ([false, 0, "0", "false"].includes(valor)) return 0;
  return null;
}

function normalizarEsFamiliar(valor) {
  if ([true, 1, "1", "true", "S", "s"].includes(valor)) return "S";
  if ([false, 0, "0", "false", "N", "n"].includes(valor)) return "N";
  return undefined;
}

// Fecha guardada en la base: puede venir como Date, 'YYYY-MM-DD' o, en filas
// viejas, 'YYYY-MM-DD HH:MM:SS(.mmm)'. Se compara siempre como fecha civil.
function fechaAlmacenada(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return normalizarFechaCivil(valor);
  const texto = String(valor).trim();
  const coincidencia = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(texto);
  return coincidencia ? normalizarFechaCivil(coincidencia[1]) : null;
}

function esFamiliarPorParentesco(parentescoId) {
  return PARENTESCOS_FAMILIARES.includes(Number(parentescoId)) ? "S" : "N";
}

function nombreRol(usuario) {
  if (usuario?.rol_nombre) return String(usuario.rol_nombre);
  return ROL_NOMBRE_POR_ID[Number(usuario?.rol_id)] || null;
}

function nombreCompleto(persona) {
  return [persona?.nombre, persona?.apellido].filter(Boolean).join(" ").trim() || `usuario #${persona?.id}`;
}

function contextoDesdeRequest(req) {
  if (!req) return { ip: null, userAgent: null };
  const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || null;
  let userAgent = null;
  if (typeof req.get === "function") userAgent = req.get("User-Agent") || null;
  else if (req.headers) userAgent = req.headers["user-agent"] || null;
  return { ip: ip ? String(ip).slice(0, 45) : null, userAgent };
}

async function obtenerUsuarioPrincipalFamilia(connection, usuarioId) {
  const [filas] = await connection.query(
    "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
    [usuarioId]
  );
  if (filas.length === 0) return { usuarioFamiliarPrincipalId: usuarioId, departamentalId: null };
  let actual = filas[0];
  const visitados = new Set([Number(actual.id)]);
  while (actual.usuario_familiar_id !== null && actual.usuario_familiar_id !== undefined) {
    const siguienteId = Number(actual.usuario_familiar_id);
    if (!Number.isInteger(siguienteId) || visitados.has(siguienteId)) {
      throw crearErrorUsuario(
        "La jerarquía familiar contiene un ciclo o una referencia inválida",
        409,
        "JERARQUIA_FAMILIAR_INVALIDA"
      );
    }
    visitados.add(siguienteId);
    const [siguientes] = await connection.query(
      "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
      [siguienteId]
    );
    if (siguientes.length === 0) break;
    actual = siguientes[0];
  }
  return { usuarioFamiliarPrincipalId: Number(actual.id), departamentalId: actual.departamental_id ?? null };
}

// ---------------------------------------------------------------------------
// Historial estricto de usuario (mismo INSERT que registrarHistorial de
// routes/user.js, pero relanza el error para que el cambio y su auditoría
// confirmen o se reviertan juntos).
// ---------------------------------------------------------------------------
async function registrarHistorialUsuarioEstricto(connection, {
  usuarioId,
  tipoOperacion = "UPDATE",
  tablaAfectada = "usuario",
  modificadorId = null,
  contexto = {},
  campos = null,
  observaciones = null,
}) {
  const ipAddress = contexto.ip ?? null;
  const userAgent = contexto.userAgent ?? null;
  if (Array.isArray(campos)) {
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
          valorHistorial(campo.valorAnterior),
          valorHistorial(campo.valorNuevo),
          tablaAfectada,
          modificadorId,
          ipAddress,
          userAgent,
          observaciones,
        ]
      );
    }
    return;
  }
  await connection.query(
    `INSERT INTO historial_usuario
     (usuario_id, tipo_operacion, tabla_afectada, usuario_modificador_id,
      ip_address, user_agent, observaciones)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [usuarioId, tipoOperacion, tablaAfectada, modificadorId, ipAddress, userAgent, observaciones]
  );
}

function valorHistorial(valor) {
  return valor === undefined || valor === null ? null : valor;
}

async function registrarHistorialReserva(connection, reservaId, { modificadorId, contexto, campo = null, valorAnterior = null, valorNuevo = null, observaciones }) {
  await connection.query(
    `INSERT INTO historial_reserva
     (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
      usuario_modificador_id, ip_address, user_agent, observaciones)
     VALUES (?, 'OBSERVACION', ?, ?, ?, ?, ?, ?, ?)`,
    [
      reservaId,
      campo,
      valorAnterior === null || valorAnterior === undefined ? null : String(valorAnterior),
      valorNuevo === null || valorNuevo === undefined ? null : String(valorNuevo),
      modificadorId,
      contexto.ip ?? null,
      contexto.userAgent ? String(contexto.userAgent).slice(0, 255) : null,
      observaciones,
    ]
  );
}

async function registrarHistorialCoseguro(connection, datos) {
  await connection.query(
    `INSERT INTO coseguro_historial
       (solicitud_id, usuario_id, usuario_rol, tipo_operacion, estado_anterior_id, estado_nuevo_id,
        campo_modificado, valor_anterior, valor_nuevo, observacion)
     VALUES (?, ?, ?, 'UPDATE', NULL, NULL, ?, ?, ?, ?)`,
    [
      datos.solicitud_id,
      datos.usuario_id || null,
      datos.usuario_rol || null,
      datos.campo_modificado || null,
      datos.valor_anterior === null || datos.valor_anterior === undefined ? null : String(datos.valor_anterior),
      datos.valor_nuevo === null || datos.valor_nuevo === undefined ? null : String(datos.valor_nuevo),
      datos.observacion || null,
    ]
  );
}

async function registrarHistorialTraslado(connection, datos) {
  await connection.query(
    `INSERT INTO traslado_historial
       (solicitud_id, usuario_id, usuario_rol, tipo_operacion, estado_anterior_id, estado_nuevo_id,
        campo_modificado, valor_anterior, valor_nuevo, observacion)
     VALUES (?, ?, ?, 'UPDATE', NULL, NULL, ?, ?, ?, ?)`,
    [
      datos.solicitud_id,
      datos.usuario_id || null,
      datos.usuario_rol || null,
      datos.campo_modificado || null,
      datos.valor_anterior === null || datos.valor_anterior === undefined ? null : String(datos.valor_anterior),
      datos.valor_nuevo === null || datos.valor_nuevo === undefined ? null : String(datos.valor_nuevo),
      datos.observacion || null,
    ]
  );
}

async function registrarHistorialOlimpiada(connection, datos) {
  await connection.query(
    `INSERT INTO olimpiada_historial
       (entidad, entidad_id, olimpiada_id, inscripcion_id, usuario_id, usuario_rol,
        tipo_operacion, campo_modificado, valor_anterior, valor_nuevo, observacion)
     VALUES (?, ?, ?, ?, ?, ?, 'UPDATE', ?, ?, ?, ?)`,
    [
      datos.entidad,
      datos.entidad_id || null,
      datos.olimpiada_id || null,
      datos.inscripcion_id || null,
      datos.usuario_id || null,
      datos.usuario_rol || null,
      datos.campo_modificado || null,
      datos.valor_anterior === null || datos.valor_anterior === undefined ? null : String(datos.valor_anterior),
      datos.valor_nuevo === null || datos.valor_nuevo === undefined ? null : String(datos.valor_nuevo),
      datos.observacion || null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Autorización
// ---------------------------------------------------------------------------
function esMismoUsuario(actor, objetivo) {
  const actorId = idPositivo(actor?.id);
  return Boolean(actorId && actorId === idPositivo(objetivo?.id));
}

/**
 * ¿Puede el actor gestionar (ver y editar) al objetivo?
 *  - admin: a cualquiera.
 *  - cualquier rol: a sí mismo (sólo con los campos del perfil propio).
 *  - admin-central: afiliados e invitados de cualquier departamental.
 *  - departamental: afiliados e invitados de SU departamental (la del objetivo
 *    o, si la persona no tiene, la del titular de su grupo).
 */
function puedeGestionarUsuario(actor, objetivo) {
  const actorId = idPositivo(actor?.id);
  const objetivoId = idPositivo(objetivo?.id);
  if (!actorId || !objetivoId) return false;
  if (actor.rol === "admin") return true;
  if (actorId === objetivoId) return true;
  if (!ROLES_OBJETIVO_STAFF.includes(nombreRol(objetivo))) return false;
  if (actor.rol === "admin-central") return true;
  if (actor.rol === "departamental") {
    const departamentalActor = idPositivo(actor.departamental_id);
    const departamentalObjetivo = idPositivo(objetivo.departamental_id) || idPositivo(objetivo.departamental_efectiva_id);
    return Boolean(departamentalActor && departamentalObjetivo && departamentalActor === departamentalObjetivo);
  }
  return false;
}

/**
 * Espejo de tieneAreaCoseguro + puedeEditarSolicitud de routes/coseguro.js:
 * ¿podría el actor editar esta solicitud de reintegro desde Coseguro?
 *  - afiliado: estados 1-2, sólo las propias y con el módulo habilitado;
 *  - departamental: estados 1-4, sólo las de su departamental y con área Coseguro;
 *  - admin-central: estados 4 y 7, con área Coseguro;
 *  - admin: estados 1-4 y 7.
 * Los tokens viejos sin los flags de área/módulo se tratan como habilitados.
 */
function tieneAreaCoseguroActor(actor) {
  if (actor?.rol === "afiliado") {
    const modulo = actor.modulo_coseguro;
    return modulo === undefined || modulo === null || Number(modulo) === 1;
  }
  if (!ROLES_CON_AREA.includes(actor?.rol)) return true;
  const area = actor.area_coseguro;
  return area === undefined || area === null || Number(area) === 1;
}

function puedeEditarSolicitudCoseguro(actor, solicitud) {
  if (!tieneAreaCoseguroActor(actor)) return false;
  const estados = ESTADOS_COSEGURO_EDICION_POR_ROL[actor?.rol] || [];
  if (!estados.includes(Number(solicitud?.estado_id))) return false;
  if (actor.rol === "afiliado") {
    const actorId = idPositivo(actor.id);
    return Boolean(actorId && actorId === idPositivo(solicitud.usuario_id));
  }
  if (actor.rol === "departamental") {
    const propia = idPositivo(actor.departamental_id);
    return Boolean(propia && propia === idPositivo(solicitud.departamental_id));
  }
  return true;
}

/** Campos que el actor puede modificar sobre el objetivo (Set). */
function camposEditables(actor, objetivo) {
  if (actor?.rol === "admin") return new Set(CAMPOS_USUARIO_EDITABLES);
  if (esMismoUsuario(actor, objetivo)) return new Set(CAMPOS_PERFIL_PROPIO);
  if (actor?.rol === "admin-central") return new Set([...CAMPOS_DATOS_PERSONALES, "departamental_id"]);
  // Los módulos visibles de una cuenta afiliada los gestiona también la
  // departamental (comportamiento previo, cubierto por
  // test/perfil-departamental-autorizacion.test.js).
  if (actor?.rol === "departamental") return new Set([...CAMPOS_DATOS_PERSONALES, ...CAMPOS_MODULOS]);
  return new Set();
}

/**
 * Lee al usuario (opcionalmente con FOR UPDATE) con el nombre de su rol y, si
 * no tiene departamental propia pero pertenece a un grupo, la del titular.
 */
async function cargarUsuarioObjetivo(connection, usuarioId, { bloquear = false, actor = null } = {}) {
  const [filas] = await connection.query(
    `SELECT u.*, r.nombre AS rol_nombre
       FROM usuario u
       LEFT JOIN rol r ON r.id = u.rol_id
      WHERE u.id = ?${bloquear ? " FOR UPDATE OF u" : ""}`,
    [usuarioId]
  );
  if (filas.length === 0) {
    throw crearErrorUsuario("Usuario no encontrado", 404, "USUARIO_NO_ENCONTRADO");
  }
  const objetivo = { ...filas[0], rol_nombre: nombreRol(filas[0]) };
  if (
    actor?.rol === "departamental" &&
    !idPositivo(objetivo.departamental_id) &&
    idPositivo(objetivo.usuario_familiar_id)
  ) {
    const familia = await obtenerUsuarioPrincipalFamilia(connection, objetivo.id);
    objetivo.departamental_efectiva_id = idPositivo(familia.departamentalId);
  }
  return objetivo;
}

/**
 * Carga y autoriza. Devuelve { objetivo, permitidos } o lanza 404/403.
 * Lo usan las rutas que necesitan chequear antes de subir archivos.
 */
async function autorizarEdicionUsuario(connection, actor, usuarioId, { bloquear = true } = {}) {
  const objetivoId = idPositivo(usuarioId);
  if (!objetivoId) throw crearErrorUsuario("ID de usuario inválido", 400, "DATO_INVALIDO");
  const objetivo = await cargarUsuarioObjetivo(connection, objetivoId, { bloquear, actor });
  if (!puedeGestionarUsuario(actor, objetivo)) {
    throw crearErrorUsuario("No tenés permisos para modificar este usuario", 403, "SIN_PERMISO");
  }
  return { objetivo, permitidos: camposEditables(actor, objetivo) };
}

// ---------------------------------------------------------------------------
// Normalización y comparación
// ---------------------------------------------------------------------------
function errorDatoInvalido(campo, mensaje) {
  return crearErrorUsuario(mensaje, 400, "DATO_INVALIDO", { campo });
}

function errorCampoNoPermitido(campo) {
  const etiqueta = DEFINICION_CAMPOS[campo]?.etiqueta || campo;
  return crearErrorUsuario(
    `No tenés permiso para modificar el campo "${etiqueta}" de este usuario`,
    403,
    "CAMPO_NO_PERMITIDO",
    { campo }
  );
}

function capitalizar(texto) {
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : texto;
}

/** Normaliza un valor recibido. Devuelve el valor listo para guardar (o null). */
function normalizarEntrada(campo, valor, { hoy = obtenerFechaCivilArgentina() } = {}) {
  const definicion = DEFINICION_CAMPOS[campo];
  switch (definicion.tipo) {
    case "texto": {
      const texto = textoONull(valor);
      if (texto !== null && texto.length > definicion.max) {
        throw errorDatoInvalido(campo, `${capitalizar(definicion.etiqueta)}: admite hasta ${definicion.max} caracteres`);
      }
      return texto;
    }
    case "foto": {
      const texto = textoONull(valor);
      if (texto !== null && texto.length > definicion.max) throw errorDatoInvalido(campo, "Archivo de foto inválido");
      return texto;
    }
    case "email": {
      const texto = textoONull(valor);
      if (texto === null) return null;
      const email = texto.toLowerCase();
      if (email.length > definicion.max || !EMAIL_RE.test(email)) throw errorDatoInvalido(campo, "Email inválido");
      return email;
    }
    case "documento": {
      if (valor === null || valor === undefined) return null;
      const texto = String(valor).replace(/[\s.-]/g, "");
      if (texto === "") return null;
      if (!esDniValido(texto)) throw errorDatoInvalido(campo, DNI_MENSAJE);
      return Number(texto);
    }
    case "fecha": {
      if (valor === null || valor === undefined) return null;
      if (!(valor instanceof Date) && String(valor).trim() === "") return null;
      const fecha = normalizarFechaCivil(valor instanceof Date ? valor : String(valor).trim());
      if (!fecha || calcularEdadEnFecha(fecha, hoy) === null) {
        throw errorDatoInvalido(campo, "Fecha de nacimiento inválida");
      }
      return fecha;
    }
    case "id": {
      if (valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "")) return null;
      const id = idPositivo(typeof valor === "string" ? valor.trim() : valor);
      if (!id) throw errorDatoInvalido(campo, `${capitalizar(definicion.etiqueta)} inválido`);
      return id;
    }
    case "binario": {
      const binario = normalizarBooleanoBinarioEstricto(valor);
      if (binario === null) throw errorDatoInvalido(campo, `El valor de ${campo} es inválido`);
      return binario;
    }
    case "si_no_habilitado": {
      const siNo = normalizarSiNoEstricto(valor);
      if (siNo === null) throw errorDatoInvalido(campo, "Estado habilitado inválido");
      return siNo;
    }
    case "si_no_familiar": {
      if (valor === null || valor === "") return null;
      const siNo = normalizarEsFamiliar(valor);
      if (siNo === undefined) throw errorDatoInvalido(campo, "El valor de es_familiar debe ser S o N");
      return siNo;
    }
    case "cuil": {
      const texto = textoONull(valor);
      if (texto === null) return null;
      const cuil = texto.replace(/[\s.-]/g, "");
      if (!validarCuitCuil(cuil)) throw errorDatoInvalido(campo, "El CUIL es inválido");
      return cuil;
    }
    case "cbu": {
      const texto = textoONull(valor);
      if (texto === null) return null;
      const cbu = texto.replace(/[\s.-]/g, "");
      if (!validarCbu(cbu)) throw errorDatoInvalido(campo, "El CBU es inválido");
      return cbu;
    }
    default:
      throw errorDatoInvalido(campo, `Campo ${campo} no soportado`);
  }
}

/** Normaliza el valor guardado para poder compararlo contra el nuevo. */
function normalizarAlmacenado(campo, valor) {
  const tipo = DEFINICION_CAMPOS[campo]?.tipo;
  if (valor === undefined || valor === null) return null;
  switch (tipo) {
    case "fecha":
      return fechaAlmacenada(valor);
    case "id":
      return idPositivo(valor);
    case "documento": {
      if (valor === "") return null;
      const numero = Number(valor);
      return Number.isFinite(numero) ? numero : null;
    }
    case "binario": {
      const numero = Number(valor);
      return Number.isFinite(numero) ? numero : null;
    }
    default:
      return textoONull(valor);
  }
}

function sonIguales(campo, anterior, nuevo) {
  const anteriorVacio = anterior === null || anterior === undefined;
  const nuevoVacio = nuevo === null || nuevo === undefined;
  if (anteriorVacio || nuevoVacio) return anteriorVacio && nuevoVacio;
  const tipo = DEFINICION_CAMPOS[campo]?.tipo;
  if (["id", "documento", "binario"].includes(tipo)) return Number(anterior) === Number(nuevo);
  return String(anterior) === String(nuevo);
}

// Comparación "cruda" (sin validar) del valor recibido contra el guardado.
function coincideConGuardado(campo, crudo, anterior) {
  const tipo = DEFINICION_CAMPOS[campo]?.tipo;
  const texto = crudo instanceof Date ? fechaAlmacenada(crudo) : textoONull(crudo);
  if (texto === null) return anterior === null || anterior === undefined;
  if (anterior === null || anterior === undefined) return false;
  if (["documento", "cuil", "cbu"].includes(tipo)) return String(texto).replace(/[\s.-]/g, "") === String(anterior);
  if (tipo === "fecha") return fechaAlmacenada(texto) === anterior;
  if (["id", "binario"].includes(tipo)) return Number(texto) === Number(anterior);
  return String(texto) === String(anterior);
}

function snapshotUsuario(usuario) {
  const snapshot = { id: idPositivo(usuario.id) };
  for (const campo of CAMPOS_SNAPSHOT) snapshot[campo] = normalizarAlmacenado(campo, usuario[campo]);
  snapshot.usuario_familiar_id = idPositivo(usuario.usuario_familiar_id);
  snapshot.rol_nombre = nombreRol(usuario);
  return snapshot;
}

function extraerCambiosUsuario(body, { excluir = ["foto_archivo"] } = {}) {
  const cambios = {};
  if (!body || typeof body !== "object") return cambios;
  for (const campo of CAMPOS_USUARIO_EDITABLES) {
    if (excluir.includes(campo)) continue;
    if (Object.prototype.hasOwnProperty.call(body, campo) && body[campo] !== undefined) {
      cambios[campo] = body[campo];
    }
  }
  return cambios;
}

// ---------------------------------------------------------------------------
// Consultas auxiliares de catálogo
// ---------------------------------------------------------------------------
async function nombresPorId(connection, tabla, ids) {
  const lista = [...new Set(ids.map(idPositivo).filter(Boolean))];
  if (lista.length === 0) return new Map();
  const [filas] = await connection.query(`SELECT id, nombre FROM ${tabla} WHERE id IN (?)`, [lista]);
  return new Map(filas.map((fila) => [Number(fila.id), fila.nombre]));
}

async function validarReferencias(connection, nuevos) {
  const resultado = {};
  if (nuevos.rol_id !== undefined) {
    const [roles] = await connection.query("SELECT id, nombre FROM rol WHERE id = ?", [nuevos.rol_id]);
    if (roles.length === 0) throw crearErrorUsuario("Rol inexistente", 400, "REFERENCIA_INEXISTENTE", { campo: "rol_id" });
    resultado.rolNombre = roles[0].nombre;
  }
  if (nuevos.departamental_id !== undefined && nuevos.departamental_id !== null) {
    const [departamentales] = await connection.query(
      "SELECT id, nombre FROM departamental WHERE id = ? AND habilitado = 'Y'",
      [nuevos.departamental_id]
    );
    if (departamentales.length === 0) {
      throw crearErrorUsuario("Departamental inexistente o deshabilitada", 400, "REFERENCIA_INEXISTENTE", { campo: "departamental_id" });
    }
  }
  if (nuevos.tipo_persona_id !== undefined && nuevos.tipo_persona_id !== null) {
    const [tipos] = await connection.query("SELECT id FROM tipo_persona WHERE id = ?", [nuevos.tipo_persona_id]);
    if (tipos.length === 0) {
      throw crearErrorUsuario("Tipo de persona inexistente", 400, "REFERENCIA_INEXISTENTE", { campo: "tipo_persona_id" });
    }
  }
  if (nuevos.parentesco_id !== undefined && nuevos.parentesco_id !== null) {
    const [parentescos] = await connection.query("SELECT id FROM parentesco WHERE id = ?", [nuevos.parentesco_id]);
    if (parentescos.length === 0) {
      throw crearErrorUsuario("Parentesco inexistente", 400, "REFERENCIA_INEXISTENTE", { campo: "parentesco_id" });
    }
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Reglas de negocio sobre el estado final
// ---------------------------------------------------------------------------
function validarReglas({ objetivo, nuevos, final, rolFinalNombre, hoy }) {
  const cambio = (campo) => Object.prototype.hasOwnProperty.call(nuevos, campo);
  const esMiembroDeGrupo = Boolean(idPositivo(objetivo.usuario_familiar_id));

  for (const campo of ["nombre", "apellido"]) {
    if (cambio(campo) && !final[campo]) {
      throw errorDatoInvalido(campo, `El ${DEFINICION_CAMPOS[campo].etiqueta} es obligatorio`);
    }
  }
  if (cambio("rol_id") && !final.rol_id) throw errorDatoInvalido("rol_id", "Rol inválido");
  if (cambio("documento") && final.documento === null) {
    throw errorDatoInvalido("documento", "El DNI es obligatorio: no se puede dejar vacío");
  }
  if (cambio("fecha_nacimiento") && final.fecha_nacimiento === null) {
    throw errorDatoInvalido("fecha_nacimiento", "La fecha de nacimiento es obligatoria: no se puede dejar vacía");
  }

  // Email: obligatorio para cuentas propias; opcional para invitados y
  // personas del grupo de un titular (familiares / acompañantes).
  if (cambio("email") && final.email === null) {
    const emailOpcional = rolFinalNombre === "invitado" || esMiembroDeGrupo;
    if (!emailOpcional) {
      throw crearErrorUsuario(
        "El email es obligatorio para los usuarios con cuenta propia",
        400,
        "EMAIL_OBLIGATORIO",
        { campo: "email" }
      );
    }
  }

  // Tipo "Menores de 2 años" sólo si efectivamente tiene menos de 2 años.
  if ((cambio("tipo_persona_id") || cambio("fecha_nacimiento")) && Number(final.tipo_persona_id) === TIPO_PERSONA_MENOR_2) {
    const edad = final.fecha_nacimiento ? calcularEdadEnFecha(final.fecha_nacimiento, hoy) : null;
    if (edad === null || edad >= 2) {
      throw crearErrorUsuario(
        "El tipo de persona \"Menores de 2 años\" sólo corresponde a personas de menos de 2 años",
        422,
        "TIPO_PERSONA_EDAD_INCONSISTENTE",
        { campo: cambio("tipo_persona_id") ? "tipo_persona_id" : "fecha_nacimiento" }
      );
    }
  }

  // Tipo "Invitados familiares" exige un parentesco familiar.
  if ((cambio("tipo_persona_id") || cambio("parentesco_id")) && Number(final.tipo_persona_id) === TIPO_PERSONA_FAMILIAR) {
    if (!PARENTESCOS_FAMILIARES.includes(Number(final.parentesco_id))) {
      throw crearErrorUsuario(
        "El tipo de persona familiar requiere parentesco Pareja, Hijo o Familiar",
        422,
        "TIPO_PERSONA_PARENTESCO_INCONSISTENTE",
        { campo: cambio("parentesco_id") ? "parentesco_id" : "tipo_persona_id" }
      );
    }
  }

  // Un familiar / acompañante nunca es "Titular".
  if (cambio("parentesco_id") && Number(final.parentesco_id) === PARENTESCO_TITULAR && esMiembroDeGrupo) {
    throw crearErrorUsuario(
      "Una persona del grupo de un titular no puede tener parentesco Titular",
      422,
      "PARENTESCO_TITULAR_INVALIDO",
      { campo: "parentesco_id" }
    );
  }

  if (cambio("es_familiar") && final.es_familiar === "S") {
    if (!esMiembroDeGrupo) {
      throw crearErrorUsuario(
        "Sólo una persona vinculada a un titular puede integrar su grupo familiar",
        422,
        "GRUPO_FAMILIAR_INVALIDO",
        { campo: "es_familiar" }
      );
    }
    if (!PARENTESCOS_FAMILIARES.includes(Number(final.parentesco_id))) {
      throw crearErrorUsuario(
        "Para integrar el grupo familiar el parentesco debe ser Pareja, Hijo o Familiar",
        422,
        "GRUPO_FAMILIAR_INVALIDO",
        { campo: "parentesco_id" }
      );
    }
  }

  // Un afiliado necesita departamental, tipo y fecha de nacimiento válidos.
  if (
    ["rol_id", "departamental_id", "tipo_persona_id", "fecha_nacimiento"].some(cambio) &&
    rolFinalNombre === "afiliado"
  ) {
    if (
      !final.departamental_id || !final.tipo_persona_id || !final.fecha_nacimiento ||
      calcularEdadEnFecha(final.fecha_nacimiento, hoy) === null
    ) {
      throw crearErrorUsuario(
        "Los afiliados requieren departamental, tipo de persona y fecha de nacimiento válidos",
        400,
        "AFILIADO_INCOMPLETO"
      );
    }
  }
}

async function validarUnicidad(connection, { actor, objetivoId, nuevos }) {
  if (nuevos.documento !== undefined && nuevos.documento !== null) {
    // Lectura sin bloqueo: con un DNI inexistente, FOR UPDATE tomaba un gap
    // lock que chocaba con otro cambio de DNI concurrente (deadlock → 500). La
    // unicidad la garantizan documento_UNIQUE y el mapeo de ER_DUP_ENTRY.
    const [duplicados] = await connection.query(
      "SELECT id FROM usuario WHERE documento = ? AND id <> ? LIMIT 1",
      [nuevos.documento, objetivoId]
    );
    if (duplicados.length > 0) {
      throw errorDniDuplicado(actor, nuevos.documento, duplicados[0].id);
    }
  }
  if (nuevos.email !== undefined && nuevos.email !== null) {
    // Lectura NO bloqueante: la expresión LOWER(TRIM(email)) no usa índice, así
    // que un FOR UPDATE recorría y bloqueaba la tabla usuario entera hasta el
    // commit (frenando logins, altas y cualquier otra edición). El email no
    // tiene índice único: el chequeo es de mejor esfuerzo, como antes del servicio.
    const [emails] = await connection.query(
      "SELECT id FROM usuario WHERE LOWER(TRIM(email)) = ? AND id <> ? LIMIT 1",
      [nuevos.email, objetivoId]
    );
    if (emails.length > 0) {
      throw crearErrorUsuario("Ya existe un usuario con ese email", 409, "EMAIL_DUPLICADO", { campo: "email" });
    }
  }
}

// El mensaje nunca expone datos de la otra persona. Admin y admin-central, que
// ven a todo el padrón, reciben además el id para ir a revisarla.
function errorDniDuplicado(actor, documento, otroUsuarioId = null) {
  const esStaff = ["admin", "admin-central", "departamental"].includes(actor?.rol);
  const mensaje = esStaff
    ? `El DNI ${documento} ya está registrado para otra persona. No puede haber dos personas con el mismo DNI: revisá el número o buscá si la persona ya está cargada.`
    : "El DNI ingresado ya está registrado en el sistema. Si es correcto, comunicate con tu departamental.";
  const extra = { campo: "documento" };
  if (otroUsuarioId && ["admin", "admin-central"].includes(actor?.rol)) {
    extra.usuario_existente_id = Number(otroUsuarioId);
  }
  return crearErrorUsuario(mensaje, 409, "DNI_DUPLICADO", extra);
}

// ---------------------------------------------------------------------------
// Propagaciones
// ---------------------------------------------------------------------------
function agregarReservaAfectada(lista, fila, motivo) {
  const existente = lista.find((item) => item.reserva_id === Number(fila.reserva_id));
  if (existente) {
    existente.motivo = `${existente.motivo}; ${motivo}`;
    return;
  }
  lista.push({
    reserva_id: Number(fila.reserva_id),
    estado: fila.estado_nombre || null,
    estado_id: idPositivo(fila.estado_reserva_id),
    fecha_inicio: fechaAlmacenada(fila.fecha_inicio),
    fecha_fin: fechaAlmacenada(fila.fecha_fin),
    motivo,
  });
}

async function propagarDepartamental(connection, ctx) {
  const { objetivo, anterior, final, actor, contexto, resultado } = ctx;
  const nuevaId = final.departamental_id;
  const anteriorId = idPositivo(anterior.departamental_id);
  const nombres = await nombresPorId(connection, "departamental", [anterior.departamental_id, nuevaId]);
  const nombreNueva = nuevaId ? (nombres.get(nuevaId) || `#${nuevaId}`) : "(sin departamental)";
  const nombreDe = (id) => (id ? (nombres.get(Number(id)) || `#${id}`) : "(sin departamental)");

  const personas = [{ id: objetivo.id, nombre: final.nombre, apellido: final.apellido }];
  const esTitular = !idPositivo(objetivo.usuario_familiar_id);

  if (esTitular) {
    // Titular: los familiares y acompañantes que dependían de su departamental
    // (la tenían vacía o igual a la ANTERIOR del titular) la heredan. Los que
    // tienen una departamental propia distinta (p. ej. una afiliada con cuenta
    // y sede propias) no se mueven: se avisa para que se revise en su ficha.
    const noPropagados = [];
    const visitados = new Set([Number(objetivo.id)]);
    let frontera = [Number(objetivo.id)];
    while (frontera.length > 0) {
      const [miembros] = await connection.query(
        `SELECT id, nombre, apellido, departamental_id
           FROM usuario
          WHERE usuario_familiar_id IN (?)
          ORDER BY id
          FOR UPDATE`,
        [frontera]
      );
      frontera = [];
      for (const miembro of miembros) {
        const miembroId = Number(miembro.id);
        if (visitados.has(miembroId)) continue;
        visitados.add(miembroId);
        frontera.push(miembroId);
        const departamentalMiembro = idPositivo(miembro.departamental_id);
        if (departamentalMiembro === nuevaId) continue;
        if (departamentalMiembro !== null && departamentalMiembro !== anteriorId) {
          noPropagados.push(miembro);
          continue;
        }
        await connection.query("UPDATE usuario SET departamental_id = ? WHERE id = ?", [nuevaId, miembroId]);
        await registrarHistorialUsuarioEstricto(connection, {
          usuarioId: miembroId,
          modificadorId: idPositivo(actor.id),
          contexto,
          campos: [{ campo: "departamental_id", valorAnterior: miembro.departamental_id, valorNuevo: nuevaId }],
          observaciones: `Departamental heredada del titular ${nombreCompleto(final)} (usuario #${objetivo.id})`,
        });
        resultado.propagaciones.push({
          modulo: "usuarios",
          tabla: "usuario",
          id: miembroId,
          campo: "departamental_id",
          valorAnterior: idPositivo(miembro.departamental_id),
          valorNuevo: nuevaId,
          descripcion: `${nombreCompleto(miembro)} (grupo familiar) pasa a la departamental ${nombreNueva}`,
        });
        personas.push({ id: miembroId, nombre: miembro.nombre, apellido: miembro.apellido });
      }
    }
    if (noPropagados.length > 0) {
      const propias = await nombresPorId(connection, "departamental", noPropagados.map((miembro) => miembro.departamental_id));
      for (const miembro of noPropagados) {
        const propiaId = idPositivo(miembro.departamental_id);
        resultado.advertencias.push({
          codigo: "DEPARTAMENTAL_INTEGRANTE_NO_PROPAGADA",
          mensaje:
            `${nombreCompleto(miembro)} (grupo familiar) tiene su propia departamental (${propias.get(propiaId) || `#${propiaId}`}) ` +
            `y no se pasó a ${nombreNueva}. Si también corresponde cambiársela, hacelo desde su ficha.`,
          usuario_id: Number(miembro.id),
        });
      }
    }
  } else {
    resultado.advertencias.push({
      codigo: "DEPARTAMENTAL_DISTINTA_TITULAR",
      mensaje: `${nombreCompleto(final)} pertenece al grupo de un titular: los familiares suelen heredar la departamental del titular y ahora quedó distinta.`,
    });
  }

  const ids = personas.map((persona) => persona.id);
  const nombrePersona = new Map(personas.map((persona) => [Number(persona.id), nombreCompleto(persona)]));

  // Traslados iniciados: la departamental de origen es una foto del alta.
  const [traslados] = await connection.query(
    `SELECT id, usuario_id, departamental_origen_id, departamental_destino_id
       FROM traslado_solicitud
      WHERE usuario_id IN (?) AND estado_id = ? AND eliminado = 0
      ORDER BY id
      FOR UPDATE`,
    [ids, ESTADO_TRASLADO_INICIADA]
  );
  for (const traslado of traslados) {
    if (nuevaId && idPositivo(traslado.departamental_destino_id) === nuevaId) {
      throw crearErrorUsuario(
        `No se puede pasar a ${nombrePersona.get(Number(traslado.usuario_id))} a la departamental ${nombreNueva}: ` +
          `tiene una solicitud de traslado iniciada (TR-${traslado.id}) justamente hacia esa departamental. ` +
          "Si el traslado ya se concretó, marcá la solicitud como Concretada desde Traslados y después cambiá la departamental; " +
          "si no corresponde, cancelá la solicitud antes de hacer el cambio.",
        409,
        "TRASLADO_DESTINO_IGUAL",
        { campo: "departamental_id", traslado_id: Number(traslado.id) }
      );
    }
  }
  for (const traslado of traslados) {
    if (!nuevaId || idPositivo(traslado.departamental_origen_id) === nuevaId) continue;
    await connection.query(
      "UPDATE traslado_solicitud SET departamental_origen_id = ? WHERE id = ? AND estado_id = ? AND eliminado = 0",
      [nuevaId, traslado.id, ESTADO_TRASLADO_INICIADA]
    );
    await registrarHistorialTraslado(connection, {
      solicitud_id: traslado.id,
      usuario_id: idPositivo(actor.id),
      usuario_rol: actor.rol,
      campo_modificado: "Departamental de origen",
      valor_anterior: nombreDe(traslado.departamental_origen_id),
      valor_nuevo: nombreNueva,
      observacion: `Cambio de departamental de ${nombrePersona.get(Number(traslado.usuario_id))} desde su ficha de usuario`,
    });
    resultado.propagaciones.push({
      modulo: "traslados",
      tabla: "traslado_solicitud",
      id: Number(traslado.id),
      campo: "departamental_origen_id",
      valorAnterior: idPositivo(traslado.departamental_origen_id),
      valorNuevo: nuevaId,
      descripcion: `La solicitud de traslado TR-${traslado.id} ahora sale de ${nombreNueva}`,
    });
  }

  // Coseguro: sólo las solicitudes que todavía gestiona la departamental.
  if (nuevaId) {
    const [solicitudes] = await connection.query(
      `SELECT id, usuario_id, estado_id, departamental_id
         FROM coseguro_solicitud
        WHERE usuario_id IN (?) AND eliminado = 0 AND estado_id IN (?)
          AND (departamental_id IS NULL OR departamental_id <> ?)
        ORDER BY id
        FOR UPDATE`,
      [ids, ESTADOS_COSEGURO_MOVER_DEPARTAMENTAL, nuevaId]
    );
    for (const solicitud of solicitudes) {
      try {
        // El trigger ajb_cos_claim_au recrea los claims del comprobante.
        await connection.query(
          "UPDATE coseguro_solicitud SET departamental_id = ? WHERE id = ? AND eliminado = 0",
          [nuevaId, solicitud.id]
        );
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") throw error;
        resultado.advertencias.push({
          codigo: "COSEGURO_NO_MOVIDA",
          mensaje: `La solicitud de reintegro #${solicitud.id} no se pudo pasar a ${nombreNueva} porque su comprobante choca con otra solicitud. Revisala desde Coseguro.`,
        });
        continue;
      }
      await registrarHistorialCoseguro(connection, {
        solicitud_id: solicitud.id,
        usuario_id: idPositivo(actor.id),
        usuario_rol: actor.rol,
        campo_modificado: "Departamental",
        valor_anterior: nombreDe(solicitud.departamental_id),
        valor_nuevo: nombreNueva,
        observacion: `Cambio de departamental de ${nombrePersona.get(Number(solicitud.usuario_id))} desde su ficha de usuario`,
      });
      resultado.propagaciones.push({
        modulo: "coseguro",
        tabla: "coseguro_solicitud",
        id: Number(solicitud.id),
        campo: "departamental_id",
        valorAnterior: idPositivo(solicitud.departamental_id),
        valorNuevo: nuevaId,
        descripcion: `La solicitud de reintegro #${solicitud.id} pasa a la departamental ${nombreNueva}`,
      });
    }
  }

  // Olimpiadas: la delegación es una foto que cuenta para los cupos; no se
  // mueve sola, sólo se avisa.
  const [inscripciones] = await connection.query(
    `SELECT i.id, i.usuario_id, i.departamental_id, o.nombre AS olimpiada_nombre
       FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
      WHERE i.usuario_id IN (?) AND i.eliminado = 0 AND i.estado IN ('PENDIENTE','VALIDADO')
        AND (o.fecha_fin IS NULL OR o.fecha_fin >= ?)
      ORDER BY i.id`,
    [ids, ctx.hoy]
  );
  for (const inscripcion of inscripciones) {
    if (idPositivo(inscripcion.departamental_id) === nuevaId) continue;
    resultado.advertencias.push({
      codigo: "OLIMPIADA_DELEGACION_SIN_CAMBIO",
      mensaje: `${nombrePersona.get(Number(inscripcion.usuario_id))} tiene una inscripción activa en ${inscripcion.olimpiada_nombre} por la delegación de ${nombreDe(inscripcion.departamental_id)}; la inscripción no cambia de delegación automáticamente.`,
    });
  }

  // Pedidos PENDIENTES de cambios de familiares del grupo: los reasigna
  // services/familiares-cambios.js (dueño de familiar_cambio_solicitud) a la
  // departamental nueva, marca leídos los avisos viejos y avisa a los
  // departamentales de la sede nueva con FAMILIAR_CAMBIO_SOLICITADO. Sin la
  // tabla (producción sin migrar) no hace nada.
  if (esTitular && nuevaId) {
    // Carga diferida: familiares-cambios.js importa este archivo.
    const { reasignarSolicitudesPendientesDelTitular } = require("./familiares-cambios");
    const reasignadas = await reasignarSolicitudesPendientesDelTitular(connection, {
      titularId: Number(objetivo.id),
      departamentalId: nuevaId,
      excluirUsuarioId: idPositivo(actor.id),
    });
    for (const pedido of reasignadas || []) {
      const notificados = Number(pedido.notificados) || 0;
      resultado.propagaciones.push({
        modulo: "familiares",
        tabla: "familiar_cambio_solicitud",
        id: Number(pedido.solicitud_id),
        campo: "departamental_id",
        valorAnterior: idPositivo(pedido.departamental_anterior_id),
        valorNuevo: nuevaId,
        descripcion:
          `El pedido de cambio de datos ${pedido.codigo || `FC-${pedido.solicitud_id}`} pasa a la departamental ${nombreNueva}` +
          (notificados > 0 ? ` y se avisó a ${notificados === 1 ? "1 usuario" : `${notificados} usuarios`} de esa sede` : ""),
      });
    }
  }
}

async function propagarDatosBancarios(connection, ctx) {
  const { objetivo, anterior, nuevos, final, actor, resultado } = ctx;
  const cambiosBancarios = [
    { campo: "cuil", columna: "cuil_afiliado", etiqueta: "CUIL" },
    { campo: "cbu", columna: "cbu", etiqueta: "CBU" },
  ].filter(({ campo }) => Object.prototype.hasOwnProperty.call(nuevos, campo));
  if (cambiosBancarios.length === 0) return;

  const conValor = cambiosBancarios.filter(({ campo }) => final[campo] !== null);
  for (const { campo, etiqueta } of cambiosBancarios) {
    if (final[campo] === null && anterior[campo] !== null) {
      resultado.advertencias.push({
        codigo: "COSEGURO_DATO_BANCARIO_VACIO",
        mensaje: `Se borró el ${etiqueta} del perfil; las solicitudes de reintegro abiertas conservan el que tenían.`,
      });
    }
  }
  if (conValor.length === 0) return;

  const [solicitudes] = await connection.query(
    `SELECT id, usuario_id, departamental_id, estado_id, cuil_afiliado, cbu
       FROM coseguro_solicitud
      WHERE usuario_id = ? AND eliminado = 0 AND estado_id IN (?)
      ORDER BY id
      FOR UPDATE`,
    [objetivo.id, ESTADOS_COSEGURO_DATOS_BANCARIOS]
  );
  // Sólo se copian a las solicitudes que el actor podría editar desde Coseguro
  // (misma matriz de estados por rol). P. ej. si el afiliado cambia su CBU, una
  // solicitud ya aprobada (4/7) no pasa a pagarse a otra cuenta sin que el
  // staff lo revise: queda como estaba y se avisa.
  const noPropagadas = [];
  for (const solicitud of solicitudes) {
    const pendientes = conValor.filter(({ campo, columna }) => String(solicitud[columna] ?? "") !== String(final[campo]));
    if (pendientes.length === 0) continue;
    if (!puedeEditarSolicitudCoseguro(actor, solicitud)) {
      noPropagadas.push({ solicitud, etiquetas: pendientes.map(({ etiqueta }) => etiqueta) });
      continue;
    }
    try {
      await connection.query(
        `UPDATE coseguro_solicitud SET ${pendientes.map(({ columna }) => `${columna} = ?`).join(", ")} WHERE id = ? AND eliminado = 0`,
        [...pendientes.map(({ campo }) => final[campo]), solicitud.id]
      );
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
      resultado.advertencias.push({
        codigo: "COSEGURO_NO_ACTUALIZADA",
        mensaje: `La solicitud de reintegro #${solicitud.id} no se pudo actualizar porque su comprobante choca con otra solicitud. Revisala desde Coseguro.`,
      });
      continue;
    }
    for (const { campo, columna, etiqueta } of pendientes) {
      await registrarHistorialCoseguro(connection, {
        solicitud_id: solicitud.id,
        usuario_id: idPositivo(actor.id),
        usuario_rol: actor.rol,
        campo_modificado: etiqueta,
        valor_anterior: solicitud[columna],
        valor_nuevo: final[campo],
        observacion: `${etiqueta} actualizado desde la ficha de ${nombreCompleto(final)}`,
      });
      resultado.propagaciones.push({
        modulo: "coseguro",
        tabla: "coseguro_solicitud",
        id: Number(solicitud.id),
        campo: columna,
        valorAnterior: solicitud[columna] ?? null,
        valorNuevo: final[campo],
        descripcion: `La solicitud de reintegro #${solicitud.id} toma el ${etiqueta} nuevo`,
      });
    }
  }
  if (noPropagadas.length > 0) {
    resultado.advertencias.push(advertenciaDatoBancarioNoPropagado(actor, noPropagadas));
  }
}

function unirConY(partes) {
  if (partes.length <= 1) return partes.join("");
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

/** Por qué el actor no puede tocar una solicitud (misma lógica que puedeEditarSolicitudCoseguro). */
function motivoNoPropagacionCoseguro(actor, solicitud) {
  if (!tieneAreaCoseguroActor(actor)) {
    return actor?.rol === "afiliado"
      ? "porque tu cuenta no tiene habilitado el módulo Coseguro"
      : "porque tu usuario no tiene el área Coseguro";
  }
  if (actor?.rol === "departamental") {
    const propia = idPositivo(actor.departamental_id);
    if (!propia || propia !== idPositivo(solicitud.departamental_id)) {
      return "porque está a cargo de otra departamental";
    }
  }
  return "porque no las podés modificar desde Coseguro en esta etapa";
}

function advertenciaDatoBancarioNoPropagado(actor, noPropagadas) {
  const etiquetas = [...new Set(noPropagadas.flatMap(({ etiquetas: lista }) => lista))];
  const datos = etiquetas.length === 1 ? `El ${etiquetas[0]} nuevo no se copió` : `El ${etiquetas.join(" y el ")} nuevos no se copiaron`;
  const solicitudes = noPropagadas.map(({ solicitud }) => {
    const estado = NOMBRE_ESTADO_COSEGURO[Number(solicitud.estado_id)];
    return `#${solicitud.id}${estado ? ` (${estado})` : ""}`;
  });
  const una = solicitudes.length === 1;
  // El motivo real puede ser el módulo/área, la sede o la etapa del trámite.
  const motivos = new Set(noPropagadas.map(({ solicitud }) => motivoNoPropagacionCoseguro(actor, solicitud)));
  const motivo = motivos.size === 1 ? [...motivos][0] : "porque no las podés modificar desde tu usuario";
  const destino = una
    ? `a la solicitud de reintegro ${solicitudes[0]}, que conserva el dato anterior ${motivo.replace("las podés", "la podés")}`
    : `a las solicitudes de reintegro ${unirConY(solicitudes)}, que conservan el dato anterior ${motivo}`;
  const siguiente = actor?.rol === "afiliado"
    ? `Si ${una ? "tiene" : "tienen"} que pagarse con el dato nuevo, avisale a tu departamental.`
    : "Si corresponde usar el dato nuevo, corregilo desde Coseguro con un usuario que pueda editar esa etapa.";
  return {
    codigo: "COSEGURO_DATO_BANCARIO_NO_PROPAGADO",
    mensaje: `${datos} ${destino}. ${siguiente}`,
    solicitudes: noPropagadas.map(({ solicitud }) => Number(solicitud.id)),
  };
}

async function propagarParentesco(connection, ctx) {
  const { objetivo, anterior, final, actor, contexto, resultado, hoy } = ctx;
  const nuevoId = final.parentesco_id;
  const [filas] = await connection.query(
    `SELECT rf.id, rf.reserva_id, rf.parentesco_id, r.estado_reserva_id, r.fecha_inicio, r.fecha_fin
       FROM reserva_familiar rf
       INNER JOIN reserva r ON r.id = rf.reserva_id
      WHERE rf.usuario_id = ? AND r.estado_reserva_id IN (?) AND r.fecha_fin >= ?
      ORDER BY rf.reserva_id, rf.id
      FOR UPDATE OF rf`,
    [objetivo.id, ESTADOS_RESERVA_ABIERTA, hoy]
  );
  const aActualizar = filas.filter((fila) => idPositivo(fila.parentesco_id) !== nuevoId);
  if (aActualizar.length === 0) return;
  const nombres = await nombresPorId(connection, "parentesco", [
    nuevoId,
    anterior.parentesco_id,
    ...aActualizar.map((fila) => fila.parentesco_id),
  ]);
  const nombreDe = (id) => (idPositivo(id) ? (nombres.get(Number(id)) || `#${id}`) : "(sin parentesco)");
  for (const fila of aActualizar) {
    // ajb_rf_guard_bu sólo bloquea cambios de precio: el parentesco es una
    // etiqueta y se puede corregir sin archivar la reserva.
    await connection.query("UPDATE reserva_familiar SET parentesco_id = ? WHERE id = ?", [nuevoId, fila.id]);
    await registrarHistorialReserva(connection, fila.reserva_id, {
      modificadorId: idPositivo(actor.id),
      contexto,
      campo: "parentesco",
      valorAnterior: nombreDe(fila.parentesco_id),
      valorNuevo: nombreDe(nuevoId),
      observaciones: `Parentesco de ${nombreCompleto(final)} actualizado desde su ficha de usuario. La tarifa cotizada no cambia.`,
    });
    resultado.propagaciones.push({
      modulo: "turismo",
      tabla: "reserva_familiar",
      id: Number(fila.id),
      reserva_id: Number(fila.reserva_id),
      campo: "parentesco_id",
      valorAnterior: idPositivo(fila.parentesco_id),
      valorNuevo: nuevoId,
      descripcion: `En la reserva #${fila.reserva_id} ${nombreCompleto(final)} figura ahora como ${nombreDe(nuevoId)}`,
    });
  }
}

async function detectarReservasAfectadasPorTarifa(connection, ctx) {
  const { objetivo, nuevos, final, actor, contexto, resultado, hoy } = ctx;
  const cambioTipo = Object.prototype.hasOwnProperty.call(nuevos, "tipo_persona_id");
  const cambioFecha = Object.prototype.hasOwnProperty.call(nuevos, "fecha_nacimiento");
  const [filas] = await connection.query(
    `SELECT rf.reserva_id, rf.tipo_persona_id, rf.edad, r.estado_reserva_id, r.fecha_inicio, r.fecha_fin,
            er.nombre AS estado_nombre
       FROM reserva_familiar rf
       INNER JOIN reserva r ON r.id = rf.reserva_id
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE rf.usuario_id = ? AND r.estado_reserva_id IN (?) AND r.fecha_fin >= ?
      ORDER BY rf.reserva_id`,
    [objetivo.id, ESTADOS_RESERVA_ABIERTA, hoy]
  );
  if (filas.length === 0) return;
  const tipos = cambioTipo
    ? await nombresPorId(connection, "tipo_persona", [final.tipo_persona_id, ...filas.map((fila) => fila.tipo_persona_id)])
    : new Map();
  const nombreTipo = (id) => (idPositivo(id) ? (tipos.get(Number(id)) || `#${id}`) : "(sin tipo)");

  for (const fila of filas) {
    const diferencias = [];
    if (cambioTipo && idPositivo(fila.tipo_persona_id) !== final.tipo_persona_id) {
      diferencias.push(`tipo de persona: la reserva tiene "${nombreTipo(fila.tipo_persona_id)}" y ahora es "${nombreTipo(final.tipo_persona_id)}"`);
    }
    if (cambioFecha && final.fecha_nacimiento && fila.edad !== null && fila.edad !== undefined) {
      const edadNueva = calcularEdadEnFecha(final.fecha_nacimiento, fechaAlmacenada(fila.fecha_inicio));
      if (edadNueva !== null && Number(fila.edad) !== edadNueva) {
        diferencias.push(`edad al ingreso: la reserva tiene ${fila.edad} y con la nueva fecha de nacimiento serían ${edadNueva}`);
      }
    }
    if (diferencias.length === 0) continue;
    const motivo = `Los datos de ${nombreCompleto(final)} cambiaron (${diferencias.join("; ")}); la reserva conserva la tarifa cotizada`;
    await registrarHistorialReserva(connection, fila.reserva_id, {
      modificadorId: idPositivo(actor.id),
      contexto,
      campo: cambioTipo && cambioFecha ? "datos_persona" : (cambioTipo ? "tipo_persona" : "fecha_nacimiento"),
      observaciones: `${motivo}.`,
    });
    agregarReservaAfectada(resultado.reservasAfectadas, fila, motivo);
  }
}

function normalizarDniTexto(valor) {
  return String(valor ?? "").replace(/[\s.-]/g, "");
}

async function propagarIdentidadOlimpiadas(connection, ctx) {
  const { objetivo, anterior, nuevos, final, actor, resultado, hoy } = ctx;
  if (!anterior.documento) return;
  const dniViejo = String(anterior.documento);
  const cambioNombre = Object.prototype.hasOwnProperty.call(nuevos, "nombre") ||
    Object.prototype.hasOwnProperty.call(nuevos, "apellido");
  const cambioDni = Object.prototype.hasOwnProperty.call(nuevos, "documento");

  // Bonos a nombre del afiliado ligados a SUS inscripciones, mientras el
  // sorteo no se publicó. Se compara por parámetro (collation) y sin puntos.
  const [bonos] = await connection.query(
    `SELECT b.id, b.olimpiada_id, b.inscripcion_id, b.comprador_nombre, b.comprador_documento
       FROM olimpiada_bono b
       INNER JOIN olimpiada_inscripcion i ON i.id = b.inscripcion_id
       INNER JOIN olimpiada o ON o.id = b.olimpiada_id
      WHERE i.usuario_id = ?
        AND b.a_nombre_departamental = 0
        AND COALESCE(o.sorteo_publicado, 0) = 0
        AND REPLACE(REPLACE(REPLACE(b.comprador_documento, '.', ''), '-', ''), ' ', '') = ?
      ORDER BY b.id
      FOR UPDATE OF b`,
    [objetivo.id, dniViejo]
  );
  const nombreComprador = `${final.apellido}, ${final.nombre}`.slice(0, 160);
  for (const bono of bonos) {
    const cambios = [];
    if (cambioNombre && bono.comprador_nombre !== nombreComprador) {
      cambios.push({ columna: "comprador_nombre", anterior: bono.comprador_nombre, nuevo: nombreComprador });
    }
    if (cambioDni && normalizarDniTexto(bono.comprador_documento) !== String(final.documento)) {
      cambios.push({ columna: "comprador_documento", anterior: bono.comprador_documento, nuevo: String(final.documento) });
    }
    if (cambios.length === 0) continue;
    await connection.query(
      `UPDATE olimpiada_bono SET ${cambios.map(({ columna }) => `${columna} = ?`).join(", ")} WHERE id = ?`,
      [...cambios.map(({ nuevo }) => nuevo), bono.id]
    );
    for (const cambio of cambios) {
      await registrarHistorialOlimpiada(connection, {
        entidad: "BONO",
        entidad_id: bono.id,
        olimpiada_id: bono.olimpiada_id,
        inscripcion_id: bono.inscripcion_id,
        usuario_id: idPositivo(actor.id),
        usuario_rol: actor.rol,
        campo_modificado: cambio.columna,
        valor_anterior: cambio.anterior,
        valor_nuevo: cambio.nuevo,
        observacion: "Datos del comprador actualizados desde la ficha del afiliado",
      });
      resultado.propagaciones.push({
        modulo: "olimpiadas",
        tabla: "olimpiada_bono",
        id: Number(bono.id),
        campo: cambio.columna,
        valorAnterior: cambio.anterior,
        valorNuevo: cambio.nuevo,
        descripcion: `El bono #${bono.id} de olimpíadas queda a nombre de ${nombreComprador}`,
      });
    }
  }

  // Acompañantes cargados a mano en inscripciones activas del mismo grupo
  // familiar. Nunca se toca fecha_nacimiento: define los bonos que se deben.
  const familia = await obtenerUsuarioPrincipalFamilia(connection, objetivo.id);
  const raizId = Number(familia.usuarioFamiliarPrincipalId);
  const [miembros] = await connection.query("SELECT id FROM usuario WHERE usuario_familiar_id = ?", [raizId]);
  const grupo = [...new Set([raizId, Number(objetivo.id), ...miembros.map((miembro) => Number(miembro.id))])];
  const [acompaniantes] = await connection.query(
    `SELECT a.id, a.inscripcion_id, i.olimpiada_id, a.nombre, a.apellido, a.documento
       FROM olimpiada_inscripcion_acompaniante a
       INNER JOIN olimpiada_inscripcion i ON i.id = a.inscripcion_id
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
      WHERE i.usuario_id IN (?)
        AND i.eliminado = 0
        AND i.estado <> 'CANCELADO'
        AND (o.fecha_fin IS NULL OR o.fecha_fin >= ?)
        AND REPLACE(REPLACE(REPLACE(a.documento, '.', ''), '-', ''), ' ', '') = ?
      ORDER BY a.id
      FOR UPDATE OF a`,
    [grupo, hoy, dniViejo]
  );
  for (const acompaniante of acompaniantes) {
    const cambios = [];
    if (Object.prototype.hasOwnProperty.call(nuevos, "nombre") && acompaniante.nombre !== final.nombre) {
      cambios.push({ columna: "nombre", anterior: acompaniante.nombre, nuevo: String(final.nombre).slice(0, 80) });
    }
    if (Object.prototype.hasOwnProperty.call(nuevos, "apellido") && acompaniante.apellido !== final.apellido) {
      cambios.push({ columna: "apellido", anterior: acompaniante.apellido, nuevo: String(final.apellido).slice(0, 80) });
    }
    if (cambioDni && normalizarDniTexto(acompaniante.documento) !== String(final.documento)) {
      cambios.push({ columna: "documento", anterior: acompaniante.documento, nuevo: String(final.documento) });
    }
    if (cambios.length === 0) continue;
    await connection.query(
      `UPDATE olimpiada_inscripcion_acompaniante SET ${cambios.map(({ columna }) => `${columna} = ?`).join(", ")} WHERE id = ?`,
      [...cambios.map(({ nuevo }) => nuevo), acompaniante.id]
    );
    for (const cambio of cambios) {
      await registrarHistorialOlimpiada(connection, {
        entidad: "INSCRIPCION",
        entidad_id: acompaniante.inscripcion_id,
        olimpiada_id: acompaniante.olimpiada_id,
        inscripcion_id: acompaniante.inscripcion_id,
        usuario_id: idPositivo(actor.id),
        usuario_rol: actor.rol,
        campo_modificado: `acompañante ${cambio.columna}`,
        valor_anterior: cambio.anterior,
        valor_nuevo: cambio.nuevo,
        observacion: `Datos del acompañante actualizados desde la ficha de ${nombreCompleto(final)}`,
      });
      resultado.propagaciones.push({
        modulo: "olimpiadas",
        tabla: "olimpiada_inscripcion_acompaniante",
        id: Number(acompaniante.id),
        campo: cambio.columna,
        valorAnterior: cambio.anterior,
        valorNuevo: cambio.nuevo,
        descripcion: `El acompañante de la inscripción #${acompaniante.inscripcion_id} toma los datos nuevos de ${nombreCompleto(final)}`,
      });
    }
  }
}

function agregarAdvertenciasDni({ objetivo, anterior, nuevos, final, rolFinalNombre, resultado }) {
  if (!Object.prototype.hasOwnProperty.call(nuevos, "documento")) return;
  const dniViejo = anterior.documento;
  // (g) El login es por DNI (signin: password no nulo y rol distinto de invitado).
  if (objetivo.password !== null && objetivo.password !== undefined && rolFinalNombre !== "invitado") {
    resultado.advertencias.push({
      codigo: "LOGIN_CAMBIA_DNI",
      mensaje: `${nombreCompleto(final)} ingresa al sistema con su DNI: desde ahora tiene que iniciar sesión con ${final.documento}${dniViejo ? ` (el ${dniViejo} deja de funcionar)` : ""}.`,
    });
  }
  // (f) El CUIL contiene el DNI (2 dígitos + DNI a 8 + verificador).
  if (dniViejo && final.cuil && !Object.prototype.hasOwnProperty.call(nuevos, "cuil")) {
    const dniEnCuil = String(final.cuil).slice(2, 10);
    if (dniEnCuil === String(dniViejo).padStart(8, "0")) {
      resultado.advertencias.push({
        codigo: "CUIL_CON_DNI_ANTERIOR",
        mensaje: `El CUIL guardado (${final.cuil}) contiene el DNI anterior (${dniViejo}). Revisalo: si también cambió, actualizalo en la ficha para que las solicitudes de coseguro abiertas tomen el nuevo.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Función principal
// ---------------------------------------------------------------------------
/**
 * Actualiza los datos de un usuario dentro de la transacción del llamador.
 *
 * @param {object} connection conexión con transacción abierta (mysql2/promise)
 * @param {object} params
 * @param {object} params.actor cabecera refrescada: { id, rol, departamental_id, ... }
 * @param {number|string} params.usuarioId persona a modificar
 * @param {object} params.cambios sólo las claves presentes (parcial). Claves válidas: CAMPOS_USUARIO_EDITABLES.
 *   foto_archivo recibe la key ya subida (o null para quitarla). password vacía = no se cambia.
 * @param {object} [params.contexto] { origen: 'configuracion'|'acompaniantes'|'coseguro'|'aprobacion', observaciones, ip, userAgent }
 * @param {object} [params.opciones] { propagar = true, autorizacionPrevia = false }
 *   autorizacionPrevia: la ruta ya autorizó el acto (p. ej. coseguro sincroniza CUIL/CBU
 *   de una solicitud que el actor puede editar); se saltea puedeGestionarUsuario y la lista blanca.
 * @returns {Promise<{anterior, actual, cambios, propagaciones, reservasAfectadas, advertencias}>}
 */
async function actualizarDatosUsuario(connection, {
  actor,
  usuarioId,
  cambios = {},
  contexto = {},
  opciones = {},
} = {}) {
  const propagar = opciones.propagar !== false;
  const autorizacionPrevia = opciones.autorizacionPrevia === true;
  const objetivoId = idPositivo(usuarioId);
  const actorId = idPositivo(actor?.id);
  if (!objetivoId) throw crearErrorUsuario("ID de usuario inválido", 400, "DATO_INVALIDO");
  if (!actorId) throw crearErrorUsuario("No se pudo identificar al usuario autenticado", 401, "SIN_SESION");
  if (!cambios || typeof cambios !== "object" || Array.isArray(cambios)) {
    throw crearErrorUsuario("Los cambios enviados no son válidos", 400, "DATO_INVALIDO");
  }
  const contextoNormalizado = {
    origen: contexto.origen || null,
    observaciones: contexto.observaciones || null,
    ip: contexto.ip ?? null,
    userAgent: contexto.userAgent ?? null,
  };
  const hoy = obtenerFechaCivilArgentina();

  // 1. Bloqueo + autorización
  const objetivo = await cargarUsuarioObjetivo(connection, objetivoId, { bloquear: true, actor });
  if (!autorizacionPrevia && !puedeGestionarUsuario(actor, objetivo)) {
    throw crearErrorUsuario("No tenés permisos para modificar este usuario", 403, "SIN_PERMISO");
  }
  const permitidos = autorizacionPrevia ? new Set(CAMPOS_USUARIO_EDITABLES) : camposEditables(actor, objetivo);
  const anterior = snapshotUsuario(objetivo);

  // 2. Normalización + diferencia + lista blanca
  const nuevos = {};
  for (const [campo, valorCrudo] of Object.entries(cambios)) {
    if (valorCrudo === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFINICION_CAMPOS, campo)) {
      throw crearErrorUsuario(`El campo "${campo}" no se puede editar`, 400, "CAMPO_DESCONOCIDO", { campo });
    }
    if (campo === "password") {
      if (typeof valorCrudo !== "string" || valorCrudo.trim() === "") continue; // vacía = no se cambia
      if (!permitidos.has("password")) throw errorCampoNoPermitido("password");
      if (valorCrudo.length < 8 || valorCrudo.length > 128) {
        throw errorDatoInvalido("password", "La contraseña debe tener entre 8 y 128 caracteres");
      }
      nuevos.password = valorCrudo;
      continue;
    }
    let valor;
    try {
      valor = normalizarEntrada(campo, valorCrudo, { hoy });
    } catch (error) {
      // Reenviar tal cual un dato viejo que hoy no pasaría la validación (p. ej.
      // un CUIL heredado) no es un cambio: no debe bloquear el resto del guardado.
      if (coincideConGuardado(campo, valorCrudo, anterior[campo])) continue;
      // Un valor inválido en un campo que no puede tocar es, ante todo, un
      // intento de modificarlo.
      if (!permitidos.has(campo)) throw errorCampoNoPermitido(campo);
      throw error;
    }
    if (sonIguales(campo, anterior[campo], valor)) continue; // igual al guardado: se ignora
    if (!permitidos.has(campo)) throw errorCampoNoPermitido(campo);
    nuevos[campo] = valor;
  }

  // 3. Derivados: es_familiar sigue al parentesco salvo que venga explícito.
  if (
    Object.prototype.hasOwnProperty.call(nuevos, "parentesco_id") &&
    cambios.es_familiar === undefined &&
    idPositivo(objetivo.usuario_familiar_id)
  ) {
    const derivado = esFamiliarPorParentesco(nuevos.parentesco_id);
    if (derivado !== anterior.es_familiar) nuevos.es_familiar = derivado;
  }

  const resultado = {
    anterior,
    actual: anterior,
    cambios: [],
    propagaciones: [],
    reservasAfectadas: [],
    advertencias: [],
  };
  const camposQueCambian = ORDEN_CAMPOS.filter((campo) => Object.prototype.hasOwnProperty.call(nuevos, campo));
  if (camposQueCambian.length === 0) return resultado;

  // 4. Catálogos, reglas y unicidad
  const referencias = await validarReferencias(connection, nuevos);
  const rolFinalNombre = referencias.rolNombre || anterior.rol_nombre;
  const final = { ...anterior };
  for (const campo of camposQueCambian) {
    if (campo !== "password") final[campo] = nuevos[campo];
  }
  final.rol_nombre = rolFinalNombre;
  validarReglas({ objetivo, nuevos, final, rolFinalNombre, hoy });
  await validarUnicidad(connection, { actor, objetivoId, nuevos });

  // 5. UPDATE
  const valores = [];
  for (const campo of camposQueCambian) {
    valores.push(campo === "password" ? await bcryptjs.hash(nuevos.password, 8) : nuevos[campo]);
  }
  try {
    await connection.query(
      `UPDATE usuario SET ${camposQueCambian.map((campo) => `${campo} = ?`).join(", ")} WHERE id = ?`,
      [...valores, objetivoId]
    );
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      if (/documento/i.test(String(error.message || ""))) throw errorDniDuplicado(actor, nuevos.documento);
      throw crearErrorUsuario("Ya existe un usuario con esos datos", 409, "DATO_DUPLICADO");
    }
    throw error;
  }

  // 6. Historial estricto
  resultado.cambios = camposQueCambian.map((campo) => (campo === "password"
    ? { campo, valorAnterior: "[OCULTO]", valorNuevo: "[MODIFICADO]" }
    : { campo, valorAnterior: anterior[campo], valorNuevo: nuevos[campo] }));
  const observaciones = contextoNormalizado.observaciones ||
    OBSERVACION_POR_ORIGEN[contextoNormalizado.origen] ||
    "Actualización de datos de usuario";
  await registrarHistorialUsuarioEstricto(connection, {
    usuarioId: objetivoId,
    modificadorId: actorId,
    contexto: contextoNormalizado,
    campos: resultado.cambios,
    observaciones,
  });
  resultado.actual = final;

  // 7. Propagación a otros módulos
  const ctx = {
    objetivo,
    anterior,
    nuevos,
    final,
    actor,
    contexto: contextoNormalizado,
    resultado,
    hoy,
    rolFinalNombre,
  };
  if (propagar) {
    const cambio = (campo) => Object.prototype.hasOwnProperty.call(nuevos, campo);
    if (cambio("departamental_id")) await propagarDepartamental(connection, ctx);
    if (cambio("cuil") || cambio("cbu")) await propagarDatosBancarios(connection, ctx);
    if (cambio("parentesco_id")) await propagarParentesco(connection, ctx);
    if (cambio("tipo_persona_id") || cambio("fecha_nacimiento")) await detectarReservasAfectadasPorTarifa(connection, ctx);
    if (cambio("nombre") || cambio("apellido") || cambio("documento")) await propagarIdentidadOlimpiadas(connection, ctx);
  }
  agregarAdvertenciasDni(ctx);

  return resultado;
}

/** Cuerpo JSON uniforme para los errores de este servicio. */
function cuerpoErrorUsuario(error) {
  const cuerpo = { success: false, message: error.message };
  if (error.codigo) cuerpo.codigo = error.codigo;
  if (error.campo) cuerpo.campo = error.campo;
  if (error.usuario_existente_id) cuerpo.usuario_existente_id = error.usuario_existente_id;
  if (error.traslado_id) cuerpo.traslado_id = error.traslado_id;
  return cuerpo;
}

function resumenResultado(resultado) {
  return {
    cambios: resultado?.cambios || [],
    propagaciones: resultado?.propagaciones || [],
    advertencias: resultado?.advertencias || [],
    reservasAfectadas: resultado?.reservasAfectadas || [],
  };
}

module.exports = {
  CAMPOS_DATOS_PERSONALES,
  CAMPOS_PERFIL_PROPIO,
  CAMPOS_USUARIO_EDITABLES,
  ESTADOS_COSEGURO_DATOS_BANCARIOS,
  ESTADOS_COSEGURO_EDICION_POR_ROL,
  ESTADOS_COSEGURO_MOVER_DEPARTAMENTAL,
  ESTADOS_RESERVA_ABIERTA,
  actualizarDatosUsuario,
  autorizarEdicionUsuario,
  camposEditables,
  cargarUsuarioObjetivo,
  contextoDesdeRequest,
  crearErrorUsuario,
  cuerpoErrorUsuario,
  esFamiliarPorParentesco,
  extraerCambiosUsuario,
  normalizarEntrada,
  puedeEditarSolicitudCoseguro,
  puedeGestionarUsuario,
  registrarHistorialUsuarioEstricto,
  resumenResultado,
};
