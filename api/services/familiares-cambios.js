"use strict";

// ============================================================================
// Cambios de datos de familiares pedidos por el AFILIADO (con aprobación).
//
// El afiliado puede modificar todos los datos de sus familiares y acompañantes
// (nombre, apellido, DNI, fecha de nacimiento, teléfono, tipo de persona y
// parentesco), pero el cambio queda en una solicitud PENDIENTE
// (tabla familiar_cambio_solicitud) hasta que la departamental del titular —o
// un admin / admin-central— lo apruebe. Mientras tanto se usan los datos
// actuales. Al aprobar, el cambio se aplica con actualizarDatosUsuario
// (services/usuarios-datos.js) con el aprobador como actor, así que valen las
// mismas validaciones, historial y propagaciones que cualquier edición del staff.
//
// Notificaciones (dentro de la transacción del negocio):
//   FAMILIAR_CAMBIO_SOLICITADO → usuarios con rol departamental de la
//     departamental de la solicitud (NO admin ni admin-central).
//   FAMILIAR_CAMBIO_APROBADO / FAMILIAR_CAMBIO_RECHAZADO → al afiliado que pidió.
//
// El VÍNCULO con el grupo familiar también pasa por acá: "Sumar al grupo
// familiar" / "Quitar del grupo familiar" (PUT /familiares/:id/vinculo) y la
// promoción de un acompañante en POST /familiares crean un pedido con
// `es_familiar` (y `parentesco_id`). Al aprobarlo, aplicarVinculoAprobado ata a
// la persona al grupo del solicitante (usuario_familiar_id + departamental del
// titular) y actualizarDatosUsuario aplica es_familiar / parentesco (historial
// estricto y parentesco propagado a las reservas abiertas).
//
// Cada pedido tiene una `version` (hash de datos_propuestos): quien resuelve
// manda la que vio y, si el afiliado reemplazó el pedido mientras tanto, la
// resolución responde 409 SOLICITUD_MODIFICADA en lugar de aplicar algo que el
// aprobador no vio.
//
// Las funciones "puras" (sin base) están separadas para poder testearlas.
// ============================================================================

const crypto = require("crypto");

const {
  ESTADOS_RESERVA_ABIERTA,
  actualizarDatosUsuario,
  cargarUsuarioObjetivo,
  crearErrorUsuario,
  normalizarEntrada,
  registrarHistorialUsuarioEstricto,
} = require("./usuarios-datos");
const {
  calcularEdadEnFecha,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
} = require("./valores-dominio");

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
// Lo que el afiliado puede pedir desde "Editar datos" (POST /familiares/:id/cambios,
// PUT /acompaniantes/:id y el DNI del coseguro).
const CAMPOS_SOLICITABLES = Object.freeze([
  "nombre",
  "apellido",
  "documento",
  "fecha_nacimiento",
  "telefono",
  "tipo_persona_id",
  "parentesco_id",
]);

// Todo lo que puede viajar en un pedido: además, el vínculo con el grupo
// familiar, que sólo llega por solicitarCambioVinculo (tiene reglas propias).
const CAMPOS_PEDIDO = Object.freeze([...CAMPOS_SOLICITABLES, "es_familiar"]);

// Etiqueta para títulos de columna ("Antes → Después").
const ETIQUETAS_CAMPOS = Object.freeze({
  nombre: "Nombre",
  apellido: "Apellido",
  documento: "DNI",
  fecha_nacimiento: "Fecha de nacimiento",
  telefono: "Teléfono",
  tipo_persona_id: "Tipo de persona",
  parentesco_id: "Parentesco",
  es_familiar: "Vínculo",
});

const TEXTO_VINCULO = Object.freeze({
  S: "Grupo familiar",
  N: "Acompañante de viaje",
});

const ESTADOS_SOLICITUD = Object.freeze(["PENDIENTE", "APROBADA", "RECHAZADA", "CANCELADA"]);
const ACCIONES_RESOLUCION = Object.freeze(["APROBAR", "RECHAZAR"]);
const ROLES_STAFF_CAMBIOS = Object.freeze(["admin", "admin-central", "departamental"]);
const ROLES_SUPERIORES = Object.freeze(["admin", "admin-central"]);
// Roles de las personas cuyos datos puede aplicar el staff no-admin.
const ROLES_PERSONA_GESTIONABLE = Object.freeze(["afiliado", "invitado"]);
const TIPOS_NOTIFICACION_FAMILIAR = Object.freeze({
  SOLICITADO: "FAMILIAR_CAMBIO_SOLICITADO",
  APROBADO: "FAMILIAR_CAMBIO_APROBADO",
  RECHAZADO: "FAMILIAR_CAMBIO_RECHAZADO",
});

const MOTIVO_MAX = 1000;
const TITULO_NOTIFICACION_MAX = 180;
const BUSQUEDA_MAX = 200;
const PAGE_SIZE_DEFECTO = 20;
const PAGE_SIZE_MAX = 100;

const PARENTESCOS_FAMILIARES = Object.freeze([2, 3, 4]);
const PARENTESCO_TITULAR = 1;
const TIPO_PERSONA_AFILIADO = 1;
const TIPO_PERSONA_FAMILIAR = 2;
const TIPO_PERSONA_MENOR_2 = 5;
// Coseguro "en curso": todo lo que todavía no se exportó para liquidar.
const ESTADOS_COSEGURO_EN_CURSO = Object.freeze([1, 2, 3, 4, 7]);

const ROL_NOMBRE_POR_ID = Object.freeze({
  1: "admin",
  2: "afiliado",
  3: "departamental",
  4: "invitado",
  5: "admin-central",
  6: "auditor",
  7: "prensa",
});

// ---------------------------------------------------------------------------
// Helpers chicos
// ---------------------------------------------------------------------------
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

function tieneClave(objeto, clave) {
  return Boolean(objeto) && Object.prototype.hasOwnProperty.call(objeto, clave);
}

function nombreRol(usuario) {
  if (usuario?.rol_nombre) return String(usuario.rol_nombre);
  return ROL_NOMBRE_POR_ID[Number(usuario?.rol_id)] || null;
}

function nombreCompleto(persona) {
  const texto = [persona?.nombre, persona?.apellido].filter(Boolean).join(" ").trim();
  return texto || (persona?.id ? `usuario #${persona.id}` : "la persona");
}

function codigoSolicitud(id) {
  return `FC-${id}`;
}

function etiquetaEnFrase(campo) {
  const etiqueta = ETIQUETAS_CAMPOS[campo] || campo;
  return etiqueta === "DNI" ? etiqueta : etiqueta.toLowerCase();
}

// ["teléfono", "DNI"] → "teléfono y DNI"
function listaLegible(items) {
  const lista = items.filter(Boolean);
  if (lista.length <= 1) return lista.join("");
  return `${lista.slice(0, -1).join(", ")} y ${lista.at(-1)}`;
}

function acotarTituloNotificacion(titulo) {
  const texto = String(titulo || "").trim();
  return texto.length > TITULO_NOTIFICACION_MAX ? `${texto.slice(0, TITULO_NOTIFICACION_MAX - 1)}…` : texto;
}

/**
 * Cierra una frase con punto sin duplicarlo: "No coincide." → "No coincide.",
 * "No coincide" → "No coincide.", "¿Seguro?" → "¿Seguro?". Evita el ".." en los
 * avisos que encadenan un texto libre (motivo de rechazo, mensaje de regla).
 */
function cerrarFrase(texto) {
  const limpio = String(texto ?? "").trim().replace(/\.+$/, "").trimEnd();
  if (!limpio) return "";
  return /[!?…]$/.test(limpio) ? limpio : `${limpio}.`;
}

// 'S' integra el grupo familiar; cualquier otro valor (N, NULL) es acompañante.
function vinculoNormalizado(valor) {
  return valor === "S" ? "S" : "N";
}

function tieneCuentaPropia(persona) {
  return (persona?.password !== null && persona?.password !== undefined) ||
    Boolean(persona?.email && String(persona.email).trim());
}

function parsearJson(valor) {
  if (valor === null || valor === undefined) return {};
  if (Buffer.isBuffer(valor)) return parsearJson(valor.toString("utf8"));
  if (typeof valor === "object") return valor;
  try {
    const resultado = JSON.parse(String(valor));
    return resultado && typeof resultado === "object" ? resultado : {};
  } catch (_error) {
    return {};
  }
}

// Tabla todavía no migrada (1146) o sin GRANT para el runtime (1142): las
// lecturas auxiliares (cambio_pendiente en otras pantallas) no deben romperlas.
function esTablaNoDisponible(error) {
  const disponible = !(["ER_NO_SUCH_TABLE", "ER_TABLEACCESS_DENIED_ERROR"].includes(error?.code) ||
    [1146, 1142].includes(error?.errno));
  if (!disponible) {
    console.warn(`[familiares-cambios] familiar_cambio_solicitud no disponible (${error.code}): ¿falta la migración o el GRANT?`);
  }
  return !disponible;
}

function errorDato(campo, mensaje, statusCode = 400, codigo = "DATO_INVALIDO") {
  return crearErrorUsuario(mensaje, statusCode, codigo, campo ? { campo } : {});
}

// ---------------------------------------------------------------------------
// Normalización y diferencias (puras)
// ---------------------------------------------------------------------------
function fechaGuardada(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return normalizarFechaCivil(valor);
  const coincidencia = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(String(valor).trim());
  return coincidencia ? normalizarFechaCivil(coincidencia[1]) : null;
}

/** Valor guardado en `usuario`, normalizado para comparar con lo pedido. */
function valorGuardado(campo, persona) {
  const valor = persona?.[campo];
  switch (campo) {
    case "documento": {
      if (valor === null || valor === undefined || valor === "") return null;
      const numero = Number(valor);
      return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
    }
    case "fecha_nacimiento":
      return fechaGuardada(valor);
    case "tipo_persona_id":
    case "parentesco_id":
      return idPositivo(valor);
    case "es_familiar":
      return vinculoNormalizado(valor);
    default:
      return textoONull(valor);
  }
}

function mismoValor(campo, a, b) {
  if (campo === "es_familiar") return vinculoNormalizado(a) === vinculoNormalizado(b);
  const aVacio = a === null || a === undefined;
  const bVacio = b === null || b === undefined;
  if (aVacio || bVacio) return aVacio && bVacio;
  if (["documento", "tipo_persona_id", "parentesco_id"].includes(campo)) return Number(a) === Number(b);
  if (campo === "fecha_nacimiento") return fechaGuardada(a) === fechaGuardada(b);
  return String(a) === String(b);
}

// Un dato viejo que hoy no pasaría la validación (p. ej. un teléfono largo
// heredado) reenviado tal cual no es un cambio: no debe bloquear el pedido.
function coincideCrudoConGuardado(campo, crudo, guardado) {
  const texto = crudo instanceof Date ? fechaGuardada(crudo) : textoONull(crudo);
  if (texto === null) return guardado === null || guardado === undefined;
  if (guardado === null || guardado === undefined) return false;
  if (campo === "documento") return String(texto).replace(/[\s.-]/g, "") === String(guardado);
  if (campo === "fecha_nacimiento") return fechaGuardada(texto) === guardado;
  if (["tipo_persona_id", "parentesco_id"].includes(campo)) return Number(texto) === Number(guardado);
  return String(texto) === String(guardado);
}

/** Toma del body sólo los campos que el afiliado puede pedir (acepta `dni` como alias). */
function extraerDatosSolicitados(body) {
  const datos = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return datos;
  for (const campo of CAMPOS_SOLICITABLES) {
    if (body[campo] !== undefined) datos[campo] = body[campo];
  }
  if (datos.documento === undefined && body.dni !== undefined) datos.documento = body.dni;
  return datos;
}

/** Campos de un pedido guardado (incluye el vínculo). */
function filtrarSolicitables(objeto, campos = CAMPOS_PEDIDO) {
  const resultado = {};
  for (const campo of campos) {
    if (tieneClave(objeto, campo)) resultado[campo] = objeto[campo];
  }
  return resultado;
}

/**
 * Normaliza cada valor pedido con las mismas reglas que la edición del staff
 * (largos, DNI de 6 a 8 dígitos, fecha civil válida, ids, S/N). Lanza 400
 * DATO_INVALIDO con `campo`.
 */
function normalizarDatosSolicitados(datos, persona, { hoy = obtenerFechaCivilArgentina() } = {}) {
  const normalizados = {};
  for (const campo of CAMPOS_PEDIDO) {
    if (!tieneClave(datos, campo) || datos[campo] === undefined) continue;
    const crudo = datos[campo];
    try {
      normalizados[campo] = normalizarEntrada(campo, crudo, { hoy });
    } catch (error) {
      if (persona && coincideCrudoConGuardado(campo, crudo, valorGuardado(campo, persona))) continue;
      throw error;
    }
  }
  return normalizados;
}

/** Sólo los campos que difieren de la ficha: { anteriores, propuestos, campos }. */
function calcularDiferencias(persona, normalizados) {
  const anteriores = {};
  const propuestos = {};
  const campos = [];
  for (const campo of CAMPOS_PEDIDO) {
    if (!tieneClave(normalizados, campo)) continue;
    const actual = valorGuardado(campo, persona);
    const nuevo = normalizados[campo] === undefined ? null : normalizados[campo];
    if (mismoValor(campo, actual, nuevo)) continue;
    anteriores[campo] = actual;
    propuestos[campo] = nuevo;
    campos.push(campo);
  }
  return { anteriores, propuestos, campos };
}

/**
 * Reglas de negocio sobre el estado final (ficha + lo pedido). Son las de la
 * edición del staff más las propias del afiliado:
 *  - nombre, apellido, DNI, fecha, tipo y parentesco no se pueden vaciar;
 *  - tipo "Menores de 2 años" ⇔ menos de 2 años;
 *  - tipo "Afiliados" sólo para quien ya está registrado como afiliado;
 *  - tipo "Invitados familiares" exige parentesco Pareja / Hijo / Familiar;
 *  - nunca parentesco Titular;
 *  - quien integra (o pasa a integrar) el grupo familiar sólo puede ser
 *    Pareja / Hijo / Familiar.
 * Devuelve el estado final. Lanza 400 / 422 con `codigo` y `campo`.
 */
function validarReglasSolicitud({ persona, propuestos, hoy = obtenerFechaCivilArgentina() }) {
  const cambia = (campo) => tieneClave(propuestos, campo);
  const final = {};
  for (const campo of CAMPOS_PEDIDO) {
    final[campo] = cambia(campo) ? propuestos[campo] : valorGuardado(campo, persona);
  }
  final.es_familiar = vinculoNormalizado(final.es_familiar);

  for (const campo of ["nombre", "apellido"]) {
    if (cambia(campo) && !final[campo]) throw errorDato(campo, `El ${etiquetaEnFrase(campo)} es obligatorio`);
  }
  if (cambia("documento") && final.documento === null) {
    throw errorDato("documento", "El DNI no se puede borrar");
  }
  if (cambia("fecha_nacimiento") && final.fecha_nacimiento === null) {
    throw errorDato("fecha_nacimiento", "La fecha de nacimiento es obligatoria");
  }
  if (cambia("tipo_persona_id") && final.tipo_persona_id === null) {
    throw errorDato("tipo_persona_id", "Elegí el tipo de persona");
  }
  if (cambia("parentesco_id") && final.parentesco_id === null) {
    throw errorDato("parentesco_id", "Elegí el parentesco");
  }

  if (cambia("parentesco_id") && final.parentesco_id === PARENTESCO_TITULAR) {
    throw errorDato(
      "parentesco_id",
      "Un familiar o acompañante no puede tener parentesco Titular",
      422,
      "PARENTESCO_TITULAR_INVALIDO"
    );
  }

  if (cambia("tipo_persona_id") || cambia("fecha_nacimiento")) {
    const edad = final.fecha_nacimiento ? calcularEdadEnFecha(final.fecha_nacimiento, hoy) : null;
    if (final.tipo_persona_id === TIPO_PERSONA_MENOR_2 && (edad === null || edad >= 2)) {
      throw errorDato(
        cambia("tipo_persona_id") ? "tipo_persona_id" : "fecha_nacimiento",
        "El tipo de persona \"Menores de 2 años\" sólo corresponde a personas de menos de 2 años",
        422,
        "TIPO_PERSONA_EDAD_INCONSISTENTE"
      );
    }
    if (edad !== null && edad < 2 && final.tipo_persona_id && final.tipo_persona_id !== TIPO_PERSONA_MENOR_2) {
      throw errorDato(
        cambia("tipo_persona_id") ? "tipo_persona_id" : "fecha_nacimiento",
        "Para una persona de menos de 2 años el tipo de persona tiene que ser \"Menores de 2 años\"",
        422,
        "TIPO_PERSONA_EDAD_INCONSISTENTE"
      );
    }
  }

  if (cambia("tipo_persona_id") && final.tipo_persona_id === TIPO_PERSONA_AFILIADO && nombreRol(persona) !== "afiliado") {
    throw errorDato(
      "tipo_persona_id",
      "El tipo de persona \"Afiliados\" sólo corresponde a quien está registrado como afiliado. Si esta persona se afilió, comunicate con tu departamental.",
      422,
      "TIPO_PERSONA_NO_VERIFICADO"
    );
  }

  if ((cambia("tipo_persona_id") || cambia("parentesco_id")) && final.tipo_persona_id === TIPO_PERSONA_FAMILIAR &&
      !PARENTESCOS_FAMILIARES.includes(final.parentesco_id)) {
    throw errorDato(
      cambia("parentesco_id") ? "parentesco_id" : "tipo_persona_id",
      "El tipo de persona familiar requiere parentesco Pareja, Hijo o Familiar",
      422,
      "TIPO_PERSONA_PARENTESCO_INCONSISTENTE"
    );
  }

  if (cambia("es_familiar") && final.es_familiar === "S" && !PARENTESCOS_FAMILIARES.includes(final.parentesco_id)) {
    throw errorDato(
      "parentesco_id",
      "Para sumar a alguien a tu grupo familiar el parentesco tiene que ser Pareja, Hijo o Familiar",
      422,
      "GRUPO_FAMILIAR_INVALIDO"
    );
  }
  if (cambia("parentesco_id") && final.es_familiar === "S" && !PARENTESCOS_FAMILIARES.includes(final.parentesco_id)) {
    throw errorDato(
      "parentesco_id",
      "Quien integra tu grupo familiar tiene que ser Pareja, Hijo o Familiar. Si ahora sólo te acompaña en los viajes, primero quitala del grupo familiar.",
      422,
      "GRUPO_FAMILIAR_INVALIDO"
    );
  }

  return final;
}

/** Campos (de los pedidos) cuya ficha cambió desde que se hizo el pedido. */
function camposModificadosDesdePedido(persona, datosAnteriores, campos = CAMPOS_PEDIDO) {
  return campos.filter((campo) => tieneClave(datosAnteriores, campo) &&
    !mismoValor(campo, valorGuardado(campo, persona), datosAnteriores[campo]));
}

// ---------------------------------------------------------------------------
// Presentación (pura)
// ---------------------------------------------------------------------------
function textoValor(campo, valor, catalogos = {}) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (campo === "fecha_nacimiento") {
    const fecha = fechaGuardada(valor);
    if (!fecha) return String(valor);
    const [anio, mes, dia] = fecha.split("-");
    return `${dia}/${mes}/${anio}`;
  }
  if (campo === "tipo_persona_id") return catalogos.tipos?.get(Number(valor)) || `#${valor}`;
  if (campo === "parentesco_id") return catalogos.parentescos?.get(Number(valor)) || `#${valor}`;
  if (campo === "es_familiar") return TEXTO_VINCULO[vinculoNormalizado(valor)];
  return String(valor);
}

/** Diferencia legible: [{campo, etiqueta, anterior, nuevo, anterior_texto, nuevo_texto}]. */
function presentarCambios(anteriores, propuestos, catalogos = {}) {
  return CAMPOS_PEDIDO.filter((campo) => tieneClave(propuestos, campo)).map((campo) => ({
    campo,
    etiqueta: ETIQUETAS_CAMPOS[campo],
    anterior: anteriores?.[campo] ?? null,
    nuevo: propuestos[campo] ?? null,
    anterior_texto: textoValor(campo, anteriores?.[campo], catalogos),
    nuevo_texto: textoValor(campo, propuestos[campo], catalogos),
  }));
}

/**
 * Cambio de vínculo del pedido en una frase para quien decide (null si el
 * pedido no toca el vínculo):
 *   'S' → "Pasa a integrar el grupo familiar como Hijo"
 *   'N' → "Deja el grupo familiar; queda como acompañante de viaje"
 * `parentescoActual` (nombre) se usa cuando el pedido no cambia el parentesco.
 */
function presentarCambioVinculo(propuestos, catalogos = {}, { parentescoActual = null } = {}) {
  if (!tieneClave(propuestos, "es_familiar")) return null;
  if (vinculoNormalizado(propuestos.es_familiar) === "N") {
    return {
      es_familiar: "N",
      parentesco_id: null,
      parentesco_texto: null,
      descripcion: "Deja el grupo familiar; queda como acompañante de viaje",
    };
  }
  const parentescoId = idPositivo(propuestos.parentesco_id);
  const parentescoTexto = parentescoId
    ? (catalogos.parentescos?.get(parentescoId) || null)
    : (parentescoActual || null);
  return {
    es_familiar: "S",
    parentesco_id: parentescoId,
    parentesco_texto: parentescoTexto,
    descripcion: `Pasa a integrar el grupo familiar${parentescoTexto ? ` como ${parentescoTexto}` : ""}`,
  };
}

function resumenCambiosTexto(cambios) {
  return cambios
    .map((cambio) => `${cambio.etiqueta}: ${cambio.anterior_texto ?? "(vacío)"} → ${cambio.nuevo_texto ?? "(vacío)"}`)
    .join("; ");
}

function camposDeSolicitud(propuestos) {
  return CAMPOS_PEDIDO.filter((campo) => tieneClave(propuestos, campo));
}

// Valor canónico de un campo pedido para la versión (independiente del orden
// de claves con que MySQL devuelve el JSON y de "3" vs 3).
function valorCanonico(campo, valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  switch (campo) {
    case "documento":
    case "tipo_persona_id":
    case "parentesco_id":
      return Number.isFinite(Number(valor)) ? Number(valor) : String(valor);
    case "fecha_nacimiento":
      return fechaGuardada(valor) || String(valor);
    case "es_familiar":
      return vinculoNormalizado(valor);
    default:
      return String(valor);
  }
}

/**
 * Versión de un pedido: hash corto de sus datos propuestos. Cambia cada vez
 * que el afiliado reemplaza el pedido con datos distintos, así quien resuelve
 * no aplica algo que no vio (fecha_modificacion tiene precisión de segundos y
 * no alcanza para eso).
 */
function versionSolicitud(datosPropuestos) {
  const propuestos = filtrarSolicitables(parsearJson(datosPropuestos));
  const canonico = CAMPOS_PEDIDO
    .filter((campo) => tieneClave(propuestos, campo))
    .map((campo) => [campo, valorCanonico(campo, propuestos[campo])]);
  return crypto.createHash("sha256").update(JSON.stringify(canonico)).digest("hex").slice(0, 16);
}

function presentarPendiente(fila) {
  const propuestos = filtrarSolicitables(parsearJson(fila.datos_propuestos));
  return {
    id: Number(fila.id),
    codigo: codigoSolicitud(fila.id),
    solicitante_usuario_id: idPositivo(fila.solicitante_usuario_id),
    fecha_creacion: fila.fecha_creacion ?? null,
    fecha_modificacion: fila.fecha_modificacion ?? null,
    campos: camposDeSolicitud(propuestos),
    datos_anteriores: filtrarSolicitables(parsearJson(fila.datos_anteriores)),
    datos_propuestos: propuestos,
    version: versionSolicitud(propuestos),
  };
}

// ---------------------------------------------------------------------------
// Permisos (puros)
// ---------------------------------------------------------------------------
/** admin / admin-central: todo; departamental: sólo solicitudes de su departamental. */
function puedeGestionarSolicitud(actor, solicitud) {
  if (!actor || !solicitud) return false;
  if (ROLES_SUPERIORES.includes(actor.rol)) return true;
  if (actor.rol === "departamental") {
    const propia = idPositivo(actor.departamental_id);
    return Boolean(propia && propia === idPositivo(solicitud.departamental_id));
  }
  return false;
}

function puedeVerSolicitud(actor, solicitud) {
  if (puedeGestionarSolicitud(actor, solicitud)) return true;
  return actor?.rol === "afiliado" && idPositivo(actor.id) === idPositivo(solicitud?.solicitante_usuario_id);
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
// Mismo universo que POST /tabla/acompaniantes (routes/user.js): familiares del
// grupo + acompañantes de viaje sin cuenta propia (vinculados directamente o
// por reservas compartidas). NO es la raíz de la familia amplia: un familiar
// con cuenta propia no puede pedir cambios sobre el titular ni sus hermanos.
// Por reservas compartidas sólo entra quien no integra el grupo de OTRO
// afiliado (usuario_familiar_id NULL o el propio): viajar juntos no habilita a
// pedir cambios sobre el acompañante de otra familia.
async function personaEnUniversoAfiliado(connection, actorId, personaId) {
  const [filas] = await connection.query(
    `SELECT u.id
       FROM usuario u
      WHERE u.id = ?
        AND u.id <> ?
        AND COALESCE(u.habilitado, 'Y') = 'Y'
        AND (
          (u.usuario_familiar_id = ? AND u.es_familiar = 'S')
          OR (
            u.password IS NULL AND (u.email IS NULL OR u.email = '')
            AND (
              (u.usuario_familiar_id = ? AND (u.es_familiar IS NULL OR u.es_familiar = 'N'))
              OR (
                (u.usuario_familiar_id IS NULL OR u.usuario_familiar_id = ?)
                AND u.id IN (
                  SELECT rf5.usuario_id
                    FROM reserva_familiar rf5
                   WHERE rf5.reserva_id IN (SELECT rf6.reserva_id FROM reserva_familiar rf6 WHERE rf6.usuario_id = ?)
                )
              )
            )
          )
        )
      LIMIT 1`,
    [personaId, actorId, actorId, actorId, actorId, actorId]
  );
  return filas.length > 0;
}

/**
 * Departamental ACTUAL del titular de un usuario: la de la raíz de su grupo
 * familiar (siguiendo usuario_familiar_id) o, si la raíz no tiene, la del
 * propio usuario. null si ninguno tiene. Sin bloqueos.
 */
async function departamentalActualDelTitular(connection, usuarioId) {
  const id = idPositivo(usuarioId);
  if (!id) return { departamentalId: null, titularId: null };
  let [filas] = await connection.query(
    "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
    [id]
  );
  const inicial = filas[0] || null;
  let actual = inicial;
  const visitados = new Set(actual ? [Number(actual.id)] : []);
  while (actual && idPositivo(actual.usuario_familiar_id)) {
    const siguiente = idPositivo(actual.usuario_familiar_id);
    if (visitados.has(siguiente)) break;
    visitados.add(siguiente);
    [filas] = await connection.query(
      "SELECT id, usuario_familiar_id, departamental_id FROM usuario WHERE id = ?",
      [siguiente]
    );
    if (filas.length === 0) break;
    actual = filas[0];
  }
  return {
    departamentalId: idPositivo(actual?.departamental_id) || idPositivo(inicial?.departamental_id) || null,
    titularId: idPositivo(actual?.id),
  };
}

/**
 * Departamental del titular que pide (la raíz de su grupo familiar). Es una
 * foto: si después cambia la departamental del titular, los pedidos
 * pendientes se reasignan (reasignarSolicitudesPendientesDelTitular) y, si no
 * se reasignaron, la departamental original ya no los puede resolver
 * (403 FUERA_DE_JURISDICCION en resolverSolicitud).
 */
async function departamentalDelTitular(connection, actor) {
  const { departamentalId: delTitular } = await departamentalActualDelTitular(connection, actor?.id);
  const departamentalId = delTitular || idPositivo(actor?.departamental_id);
  if (!departamentalId) {
    throw crearErrorUsuario(
      "Tu usuario no tiene una departamental asignada. Comunicate con AJB para que te la asignen.",
      409,
      "SIN_DEPARTAMENTAL"
    );
  }
  return departamentalId;
}

async function validarCatalogos(connection, propuestos) {
  if (propuestos.tipo_persona_id) {
    const [tipos] = await connection.query("SELECT id FROM tipo_persona WHERE id = ?", [propuestos.tipo_persona_id]);
    if (tipos.length === 0) throw errorDato("tipo_persona_id", "Tipo de persona inexistente", 400, "REFERENCIA_INEXISTENTE");
  }
  if (propuestos.parentesco_id) {
    const [parentescos] = await connection.query("SELECT id FROM parentesco WHERE id = ?", [propuestos.parentesco_id]);
    if (parentescos.length === 0) throw errorDato("parentesco_id", "Parentesco inexistente", 400, "REFERENCIA_INEXISTENTE");
  }
}

// El mensaje nunca expone datos de la otra persona (lo lee el afiliado).
async function validarDniDisponible(connection, { documento, personaId, solicitudId = null }) {
  const [duplicados] = await connection.query(
    "SELECT id FROM usuario WHERE documento = ? AND id <> ? LIMIT 1",
    [documento, personaId]
  );
  if (duplicados.length > 0) {
    throw crearErrorUsuario(
      "El DNI ingresado ya está registrado en el sistema. Si es correcto, comunicate con tu departamental.",
      409,
      "DNI_DUPLICADO",
      { campo: "documento" }
    );
  }
  const [enOtroPedido] = await connection.query(
    `SELECT id FROM familiar_cambio_solicitud
      WHERE estado = 'PENDIENTE' AND persona_usuario_id <> ? AND id <> ?
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(datos_propuestos, '$.documento')) AS UNSIGNED) = ?
      LIMIT 1`,
    [personaId, solicitudId || 0, documento]
  );
  if (enOtroPedido.length > 0) {
    throw crearErrorUsuario(
      "Ese DNI ya figura en otro pedido de cambio que está en revisión. Revisá el número o esperá a que la departamental lo resuelva.",
      409,
      "DNI_DUPLICADO",
      { campo: "documento" }
    );
  }
}

async function cargarCatalogos(connection) {
  const [tipos] = await connection.query("SELECT id, nombre FROM tipo_persona");
  const [parentescos] = await connection.query("SELECT id, nombre FROM parentesco");
  return {
    tipos: new Map(tipos.map((fila) => [Number(fila.id), fila.nombre])),
    parentescos: new Map(parentescos.map((fila) => [Number(fila.id), fila.nombre])),
  };
}

async function cargarCatalogosSiHaceFalta(connection, campos) {
  if (!campos.some((campo) => ["tipo_persona_id", "parentesco_id", "es_familiar"].includes(campo))) return {};
  return cargarCatalogos(connection);
}

async function nombreDepartamental(connection, departamentalId) {
  const id = idPositivo(departamentalId);
  if (!id) return null;
  const [filas] = await connection.query("SELECT nombre FROM departamental WHERE id = ?", [id]);
  return filas[0]?.nombre ?? null;
}

async function datosUsuario(connection, usuarioId) {
  const [filas] = await connection.query(
    `SELECT u.id, u.nombre, u.apellido, u.rol_id, u.departamental_id, d.nombre AS departamental_nombre
       FROM usuario u
       LEFT JOIN departamental d ON d.id = u.departamental_id
      WHERE u.id = ?`,
    [usuarioId]
  );
  return filas[0] || { id: usuarioId };
}

// ---------------------------------------------------------------------------
// Notificaciones
// ---------------------------------------------------------------------------
async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  await connection.query(
    "INSERT INTO notificacion (usuario_id, tipo, titulo, mensaje, payload) VALUES (?, ?, ?, ?, ?)",
    [usuarioId, tipo, acotarTituloNotificacion(titulo), mensaje, JSON.stringify(payload || {})]
  );
}

/**
 * Usuarios con rol departamental (habilitados) de la departamental indicada.
 * Sin filtrar por área: los datos del grupo sirven a turismo y a coseguro.
 * Nunca incluye admin ni admin-central (pedido explícito del cliente).
 */
async function notificarDepartamentales(connection, departamentalId, tipo, titulo, mensaje, payload, excluirUsuarioId = null) {
  const id = idPositivo(departamentalId);
  if (!id) return 0;
  const [usuarios] = await connection.query(
    `SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
      WHERE r.nombre = 'departamental' AND u.departamental_id = ? AND u.habilitado = 'Y'`,
    [id]
  );
  let enviados = 0;
  for (const usuario of usuarios) {
    if (excluirUsuarioId && Number(usuario.id) === Number(excluirUsuarioId)) continue;
    await insertarNotificacion(connection, usuario.id, tipo, titulo, mensaje, payload);
    enviados += 1;
  }
  return enviados;
}

// Avisos "pidió actualizar…" todavía sin leer de una solicitud que ya fue
// reemplazada, retirada o resuelta: se marcan como leídos para que la campana
// de la departamental no acumule avisos viejos (siguen en el historial).
async function marcarAvisosSolicitudLeidos(connection, solicitudId) {
  await connection.query(
    `UPDATE notificacion
        SET leida = 1, fecha_lectura = NOW()
      WHERE tipo = ? AND leida = 0 AND JSON_EXTRACT(payload, '$.solicitud_id') = ?`,
    [TIPOS_NOTIFICACION_FAMILIAR.SOLICITADO, Number(solicitudId)]
  );
}

function quienResolvio(staff) {
  const nombre = nombreCompleto(staff);
  if (Number(staff?.rol_id) === 3 && staff?.departamental_nombre) return `${nombre} (departamental ${staff.departamental_nombre})`;
  if ([1, 5].includes(Number(staff?.rol_id))) return `${nombre} (AJB central)`;
  return nombre;
}

/**
 * Título y mensaje del aviso FAMILIAR_CAMBIO_SOLICITADO.
 * motivo: 'NUEVO' (primer pedido), 'ACTUALIZADO' (el afiliado lo reemplazó) o
 * 'REASIGNADO' (el titular cambió de departamental y el pedido pasó a otra).
 */
function textosAvisoSolicitado({
  motivo = "NUEVO",
  nombreSolicitante,
  nombrePersona,
  codigo,
  cambios = [],
  propuestos = {},
  cambioVinculo = null,
  departamentalAnteriorNombre = null,
}) {
  const vinculo = tieneClave(propuestos, "es_familiar") ? vinculoNormalizado(propuestos.es_familiar) : null;
  let titulo;
  if (motivo === "REASIGNADO") {
    titulo = `Te pasaron el pedido ${codigo}: cambios de ${nombrePersona} (de ${nombreSolicitante})`;
  } else if (vinculo === "S") {
    titulo = motivo === "ACTUALIZADO"
      ? `${nombreSolicitante} actualizó su pedido para sumar a ${nombrePersona} a su grupo familiar`
      : `${nombreSolicitante} pidió sumar a ${nombrePersona} a su grupo familiar`;
  } else if (vinculo === "N") {
    titulo = motivo === "ACTUALIZADO"
      ? `${nombreSolicitante} actualizó su pedido para quitar a ${nombrePersona} de su grupo familiar`
      : `${nombreSolicitante} pidió quitar a ${nombrePersona} de su grupo familiar`;
  } else {
    titulo = motivo === "ACTUALIZADO"
      ? `${nombreSolicitante} actualizó su pedido de cambios de ${nombrePersona}`
      : `${nombreSolicitante} pidió actualizar los datos de ${nombrePersona}`;
  }
  // El vínculo va en una frase ("Pasa a integrar el grupo familiar como Hijo")
  // en lugar de "Vínculo: … → …"; si suma al grupo, la frase ya dice el parentesco.
  const otros = vinculo
    ? cambios.filter((cambio) => cambio.campo !== "es_familiar" && !(vinculo === "S" && cambio.campo === "parentesco_id"))
    : cambios;
  const resumen = [
    vinculo ? (cambioVinculo?.descripcion || (vinculo === "S" ? "Pasa a integrar el grupo familiar" : "Deja el grupo familiar")) : null,
    resumenCambiosTexto(otros) || null,
  ].filter(Boolean).join("; ");
  const cierre = motivo === "REASIGNADO"
    ? `El titular cambió de departamental${departamentalAnteriorNombre ? ` (antes ${departamentalAnteriorNombre})` : ""}: ahora lo resolvés vos desde Cambios de familiares.`
    : "Los datos no cambian hasta que los apruebes o rechaces desde Cambios de familiares.";
  const mensaje = `${codigo}${resumen ? ` · ${cerrarFrase(resumen)}` : "."} ${cierre}`;
  return { titulo, mensaje };
}

/**
 * Avisa FAMILIAR_CAMBIO_SOLICITADO a los usuarios departamentales de
 * `departamentalId` sobre la solicitud PENDIENTE `solicitudId`, leyéndola de la
 * base. Antes marca como leídos los avisos viejos sin leer de ese pedido (los
 * de la departamental anterior incluidos). Corre en la transacción del
 * llamador. Pensada para quien reasigna pedidos (cambio de departamental del
 * titular); devuelve la cantidad de avisos enviados (0 si la solicitud no está
 * PENDIENTE).
 *
 * @param {object} connection conexión con transacción abierta
 * @param {object} params
 * @param {number} params.solicitudId
 * @param {number} [params.departamentalId] por defecto, la de la solicitud
 * @param {'NUEVO'|'ACTUALIZADO'|'REASIGNADO'} [params.motivo='REASIGNADO']
 * @param {number|null} [params.departamentalAnteriorId] para el texto de REASIGNADO
 * @param {number|null} [params.excluirUsuarioId] p. ej. quien hizo el cambio
 */
async function notificarDepartamentalesCambioFamiliar(connection, {
  solicitudId,
  departamentalId = null,
  motivo = "REASIGNADO",
  departamentalAnteriorId = null,
  excluirUsuarioId = null,
} = {}) {
  const id = idPositivo(solicitudId);
  if (!id) return 0;
  const fila = await leerSolicitud(connection, id);
  if (!fila || fila.estado !== "PENDIENTE") return 0;
  const destino = idPositivo(departamentalId) || idPositivo(fila.departamental_id);
  const anteriores = filtrarSolicitables(parsearJson(fila.datos_anteriores));
  const propuestos = filtrarSolicitables(parsearJson(fila.datos_propuestos));
  const catalogos = await cargarCatalogosSiHaceFalta(connection, camposDeSolicitud(propuestos));
  const { titulo, mensaje } = textosAvisoSolicitado({
    motivo,
    nombreSolicitante: nombreCompleto({ id: fila.solicitante_usuario_id, nombre: fila.solicitante_nombre, apellido: fila.solicitante_apellido }),
    nombrePersona: nombreCompleto({ id: fila.persona_usuario_id, nombre: fila.persona_nombre, apellido: fila.persona_apellido }),
    codigo: codigoSolicitud(id),
    cambios: presentarCambios(anteriores, propuestos, catalogos),
    propuestos,
    cambioVinculo: presentarCambioVinculo(propuestos, catalogos, { parentescoActual: fila.persona_parentesco }),
    departamentalAnteriorNombre: motivo === "REASIGNADO" ? await nombreDepartamental(connection, departamentalAnteriorId) : null,
  });
  await marcarAvisosSolicitudLeidos(connection, id);
  return notificarDepartamentales(
    connection,
    destino,
    TIPOS_NOTIFICACION_FAMILIAR.SOLICITADO,
    titulo,
    mensaje,
    { solicitud_id: id, persona_id: Number(fila.persona_usuario_id) },
    excluirUsuarioId
  );
}

/**
 * El titular `titularId` pasó a la departamental `departamentalId`: sus pedidos
 * PENDIENTES (y los de los afiliados de su grupo, usuario_familiar_id =
 * titular) pasan a esa departamental y se le avisa. Corre en la transacción del
 * llamador (p. ej. la propagación de departamental de usuarios-datos.js; como
 * este módulo requiere usuarios-datos, requerilo de forma diferida dentro de
 * la función para no crear un require circular).
 *
 * @returns {Promise<Array<{solicitud_id, codigo, persona_id, departamental_anterior_id, departamental_nueva_id, notificados}>>}
 */
async function reasignarSolicitudesPendientesDelTitular(connection, {
  titularId,
  departamentalId,
  excluirUsuarioId = null,
} = {}) {
  const titular = idPositivo(titularId);
  const nueva = idPositivo(departamentalId);
  if (!titular || !nueva) return [];
  let filas;
  try {
    [filas] = await connection.query(
      `SELECT f.id, f.persona_usuario_id, f.departamental_id
         FROM familiar_cambio_solicitud f
        WHERE f.estado = 'PENDIENTE'
          AND f.departamental_id <> ?
          AND (f.solicitante_usuario_id = ?
               OR f.solicitante_usuario_id IN (SELECT u.id FROM usuario u WHERE u.usuario_familiar_id = ?))
        ORDER BY f.id
        FOR UPDATE`,
      [nueva, titular, titular]
    );
  } catch (error) {
    if (esTablaNoDisponible(error)) return [];
    throw error;
  }
  const reasignadas = [];
  for (const fila of filas) {
    const [actualizacion] = await connection.query(
      "UPDATE familiar_cambio_solicitud SET departamental_id = ? WHERE id = ? AND estado = 'PENDIENTE'",
      [nueva, fila.id]
    );
    if (Number(actualizacion?.affectedRows) !== 1) continue;
    const notificados = await notificarDepartamentalesCambioFamiliar(connection, {
      solicitudId: fila.id,
      departamentalId: nueva,
      motivo: "REASIGNADO",
      departamentalAnteriorId: fila.departamental_id,
      excluirUsuarioId,
    });
    reasignadas.push({
      solicitud_id: Number(fila.id),
      codigo: codigoSolicitud(fila.id),
      persona_id: Number(fila.persona_usuario_id),
      departamental_anterior_id: idPositivo(fila.departamental_id),
      departamental_nueva_id: nueva,
      notificados,
    });
  }
  return reasignadas;
}

// ---------------------------------------------------------------------------
// Casos de uso
// ---------------------------------------------------------------------------
const MENSAJE_FUERA_DEL_GRUPO =
  "Sólo podés pedir cambios de las personas de tu grupo familiar o de quienes viajaron con vos";

function validarActorAfiliado(actor, personaId) {
  const actorId = idPositivo(actor?.id);
  if (!actorId) throw crearErrorUsuario("No se pudo identificar al usuario autenticado", 401, "SIN_SESION");
  if (actor.rol !== "afiliado") {
    throw crearErrorUsuario("Sólo el afiliado puede pedir cambios de datos de su grupo", 403, "SIN_PERMISO");
  }
  const objetivoId = idPositivo(personaId);
  if (!objetivoId) throw errorDato(null, "La persona indicada no es válida");
  if (objetivoId === actorId) {
    throw crearErrorUsuario("Tus propios datos se cambian desde Mi perfil", 400, "PERSONA_PROPIA");
  }
  return { actorId, objetivoId };
}

async function exigirPersonaEnUniverso(connection, actorId, objetivoId) {
  if (!(await personaEnUniversoAfiliado(connection, actorId, objetivoId))) {
    throw crearErrorUsuario(MENSAJE_FUERA_DEL_GRUPO, 403, "PERSONA_FUERA_DEL_GRUPO");
  }
}

/**
 * Pedido PENDIENTE de la persona (o null), bloqueado para reemplazarlo.
 *
 * Sin gap locks: un `SELECT ... WHERE pendiente_persona = ? FOR UPDATE` sobre
 * un valor que NO existe bloquea el hueco del índice único y frena los pedidos
 * de otras personas. Por eso primero se busca sin bloquear y sólo se bloquea la
 * fila encontrada (por PK); si no hay, se confía en el UNIQUE
 * (uq_fcs_pendiente_persona) al insertar. Con `bloquearPorPersona` (reintento
 * después de un ER_DUP_ENTRY, cuando el pedido ya existe) se lee bloqueando por
 * el índice único: con la fila presente, es un bloqueo de registro.
 */
async function leerPendienteDePersona(connection, personaId, { bloquearPorPersona = false } = {}) {
  if (bloquearPorPersona) {
    const [filas] = await connection.query(
      `SELECT id, solicitante_usuario_id, datos_propuestos, estado
         FROM familiar_cambio_solicitud
        WHERE pendiente_persona = ?
        FOR UPDATE`,
      [personaId]
    );
    return filas[0] || null;
  }
  const [candidatas] = await connection.query(
    "SELECT id FROM familiar_cambio_solicitud WHERE pendiente_persona = ?",
    [personaId]
  );
  if (candidatas.length === 0) return null;
  const [filas] = await connection.query(
    `SELECT id, solicitante_usuario_id, datos_propuestos, estado
       FROM familiar_cambio_solicitud
      WHERE id = ?
      FOR UPDATE`,
    [candidatas[0].id]
  );
  // La lectura bloqueante ve lo último confirmado: si se resolvió mientras
  // tanto, ya no hay pedido que reemplazar.
  const fila = filas[0];
  return fila && fila.estado === "PENDIENTE" ? fila : null;
}

/**
 * Crea o reemplaza el pedido PENDIENTE del afiliado sobre la persona. Corre en
 * la transacción del llamador (que hace commit/rollback). No toca `usuario`.
 *
 * - `construirDatos(persona, hoy)` devuelve los datos crudos pedidos (se
 *   normalizan acá); puede lanzar si la persona no admite el pedido.
 * - Si ya hay una solicitud PENDIENTE del mismo afiliado para esa persona, la
 *   reemplaza: los campos que vienen pisan a los pedidos antes y los que no
 *   vienen se conservan (coseguro sólo manda el DNI). Vuelve a notificar.
 * - Sin diferencias contra la ficha → 400 SIN_CAMBIOS.
 * - Valida todo como lo validaría la aprobación (incluido DNI duplicado).
 */
async function registrarPedido(connection, { actor, actorId, objetivoId, construirDatos, mensajeSinCambios = null }) {
  const hoy = obtenerFechaCivilArgentina();

  // Orden de bloqueos: persona → solicitud (igual que la resolución).
  const persona = await cargarUsuarioObjetivo(connection, objetivoId, { bloquear: true });
  const normalizados = normalizarDatosSolicitados(await construirDatos(persona, hoy), persona, { hoy });
  const departamentalId = await departamentalDelTitular(connection, actor);

  let pendiente = null;
  let solicitudId = null;
  let anteriores = {};
  let propuestos = {};
  let campos = [];
  for (let intento = 1; solicitudId === null; intento += 1) {
    pendiente = await leerPendienteDePersona(connection, objetivoId, { bloquearPorPersona: intento > 1 });
    if (pendiente && idPositivo(pendiente.solicitante_usuario_id) !== actorId) {
      throw crearErrorUsuario(
        "Ya hay otro pedido de cambio de datos de esta persona en revisión. Esperá a que la departamental lo resuelva.",
        409,
        "CAMBIO_PENDIENTE_DE_OTRO",
        { solicitud_id: Number(pendiente.id) }
      );
    }

    const previos = pendiente ? filtrarSolicitables(parsearJson(pendiente.datos_propuestos)) : {};
    ({ anteriores, propuestos, campos } = calcularDiferencias(persona, { ...previos, ...normalizados }));
    if (campos.length === 0) {
      const propio = typeof mensajeSinCambios === "function" ? mensajeSinCambios(persona, pendiente) : null;
      throw crearErrorUsuario(
        propio || (pendiente
          ? "Los datos que enviaste son iguales a los actuales. Si ya no querés el cambio, retirá el pedido en revisión."
          : "Los datos que enviaste son iguales a los actuales: no hay nada para cambiar."),
        400,
        "SIN_CAMBIOS",
        pendiente ? { solicitud_id: Number(pendiente.id) } : {}
      );
    }
    validarReglasSolicitud({ persona, propuestos, hoy });
    await validarCatalogos(connection, propuestos);
    if (tieneClave(propuestos, "documento")) {
      await validarDniDisponible(connection, {
        documento: propuestos.documento,
        personaId: objetivoId,
        solicitudId: pendiente ? Number(pendiente.id) : null,
      });
    }

    if (pendiente) {
      await connection.query(
        `UPDATE familiar_cambio_solicitud
            SET datos_anteriores = ?, datos_propuestos = ?, departamental_id = ?
          WHERE id = ? AND estado = 'PENDIENTE'`,
        [JSON.stringify(anteriores), JSON.stringify(propuestos), departamentalId, Number(pendiente.id)]
      );
      solicitudId = Number(pendiente.id);
      break;
    }
    try {
      const [insercion] = await connection.query(
        `INSERT INTO familiar_cambio_solicitud
           (persona_usuario_id, solicitante_usuario_id, departamental_id, estado, datos_anteriores, datos_propuestos)
         VALUES (?, ?, ?, 'PENDIENTE', ?, ?)`,
        [objetivoId, actorId, departamentalId, JSON.stringify(anteriores), JSON.stringify(propuestos)]
      );
      solicitudId = Number(insercion.insertId);
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
      // Otro pedido de esta persona se confirmó entre la lectura y el INSERT
      // (el UNIQUE lo frenó): se relee una vez y se reemplaza o se informa.
      if (intento >= 2) {
        throw crearErrorUsuario(
          "Ya hay un pedido de cambio de esta persona en revisión. Actualizá la pantalla y volvé a intentar.",
          409,
          "CAMBIO_PENDIENTE_EXISTENTE"
        );
      }
    }
  }

  const catalogos = await cargarCatalogosSiHaceFalta(connection, campos);
  const cambios = presentarCambios(anteriores, propuestos, catalogos);
  const cambioVinculo = presentarCambioVinculo(propuestos, catalogos, {
    parentescoActual: catalogos.parentescos?.get(Number(persona.parentesco_id)) || null,
  });
  const solicitante = await datosUsuario(connection, actorId);
  const codigo = codigoSolicitud(solicitudId);
  const { titulo, mensaje } = textosAvisoSolicitado({
    motivo: pendiente ? "ACTUALIZADO" : "NUEVO",
    nombreSolicitante: nombreCompleto(solicitante),
    nombrePersona: nombreCompleto(persona),
    codigo,
    cambios,
    propuestos,
    cambioVinculo,
  });
  if (pendiente) await marcarAvisosSolicitudLeidos(connection, solicitudId);
  const notificados = await notificarDepartamentales(
    connection,
    departamentalId,
    TIPOS_NOTIFICACION_FAMILIAR.SOLICITADO,
    titulo,
    mensaje,
    { solicitud_id: solicitudId, persona_id: objetivoId }
  );

  return {
    solicitud_id: solicitudId,
    codigo,
    reemplazada: Boolean(pendiente),
    departamental_id: departamentalId,
    campos,
    datos_anteriores: anteriores,
    datos_propuestos: propuestos,
    cambios,
    cambio_vinculo: cambioVinculo,
    version: versionSolicitud(propuestos),
    notificados,
  };
}

/**
 * El afiliado pide cambiar datos de una persona de su grupo (nombre, apellido,
 * DNI, fecha, teléfono, tipo y parentesco; el vínculo va por
 * solicitarCambioVinculo). Corre dentro de la transacción del llamador.
 *
 * @returns {Promise<{solicitud_id, codigo, reemplazada, departamental_id, campos, datos_anteriores, datos_propuestos, cambios, cambio_vinculo, version, notificados}>}
 */
async function solicitarCambioFamiliar(connection, { actor, personaId, datos = {} } = {}) {
  const { actorId, objetivoId } = validarActorAfiliado(actor, personaId);
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) {
    throw errorDato(null, "Los datos enviados no son válidos");
  }
  await exigirPersonaEnUniverso(connection, actorId, objetivoId);
  // El vínculo (es_familiar) tiene reglas propias: por acá nunca entra.
  const pedidos = filtrarSolicitables(datos, CAMPOS_SOLICITABLES);
  return registrarPedido(connection, {
    actor,
    actorId,
    objetivoId,
    construirDatos: () => pedidos,
  });
}

/**
 * "Sumar al grupo familiar" (esFamiliar 'S', con parentesco Pareja / Hijo /
 * Familiar) o "Quitar del grupo familiar" ('N') pedido por el afiliado: queda
 * como pedido PENDIENTE (datos_propuestos con es_familiar y parentesco_id) que
 * aprueba la departamental. Lo usan PUT /familiares/:id/vinculo y la promoción
 * de un acompañante en POST /familiares.
 *
 * - Quitar: sólo a quien integra el grupo del afiliado (usuario_familiar_id = él).
 * - Sumar: a un acompañante de su grupo o a alguien sin cuenta que compartió una
 *   reserva con él y que NO integra el grupo de otro afiliado
 *   (usuario_familiar_id NULL).
 * Corre dentro de la transacción del llamador. Misma respuesta que
 * solicitarCambioFamiliar.
 */
async function solicitarCambioVinculo(connection, { actor, personaId, esFamiliar, parentescoId = null } = {}) {
  const { actorId, objetivoId } = validarActorAfiliado(actor, personaId);
  const vinculo = esFamiliar === "S" || esFamiliar === "N" ? esFamiliar : null;
  if (!vinculo) throw errorDato("es_familiar", "El tipo de vínculo es inválido");
  const parentesco = parentescoId === null || parentescoId === undefined || parentescoId === ""
    ? null
    : idPositivo(parentescoId);
  if (vinculo === "S" && !PARENTESCOS_FAMILIARES.includes(parentesco)) {
    throw errorDato("parentesco_id", "Para sumar a alguien a tu grupo familiar el parentesco tiene que ser Pareja, Hijo o Familiar");
  }
  await exigirPersonaEnUniverso(connection, actorId, objetivoId);

  return registrarPedido(connection, {
    actor,
    actorId,
    objetivoId,
    construirDatos: (persona) => {
      const vinculadaA = idPositivo(persona.usuario_familiar_id);
      if (vinculadaA && vinculadaA !== actorId) {
        throw crearErrorUsuario(MENSAJE_FUERA_DEL_GRUPO, 403, "PERSONA_FUERA_DEL_GRUPO");
      }
      if (vinculo === "N" && vinculadaA !== actorId) {
        throw crearErrorUsuario("Sólo podés quitar del grupo familiar a personas de tu grupo", 403, "PERSONA_FUERA_DEL_GRUPO");
      }
      if (vinculo === "S" && !vinculadaA && tieneCuentaPropia(persona)) {
        throw crearErrorUsuario(
          "Esa persona tiene cuenta propia en MiAJB: para sumarla a tu grupo comunicate con tu departamental",
          403,
          "PERSONA_FUERA_DEL_GRUPO"
        );
      }
      return vinculo === "S" ? { es_familiar: "S", parentesco_id: parentesco } : { es_familiar: "N" };
    },
    mensajeSinCambios: (persona, pendiente) => {
      if (pendiente) return null;
      return vinculo === "S"
        ? `${nombreCompleto(persona)} ya integra tu grupo familiar con ese parentesco: no hay nada para cambiar.`
        : `${nombreCompleto(persona)} ya figura como acompañante de viaje: no hay nada para cambiar.`;
    },
  });
}

/** El afiliado retira su propia solicitud PENDIENTE (→ CANCELADA). */
async function cancelarSolicitud(connection, { actor, solicitudId }) {
  const actorId = idPositivo(actor?.id);
  if (!actorId) throw crearErrorUsuario("No se pudo identificar al usuario autenticado", 401, "SIN_SESION");
  if (actor.rol !== "afiliado") throw crearErrorUsuario("Sólo el afiliado que hizo el pedido puede retirarlo", 403, "SIN_PERMISO");
  const id = idPositivo(solicitudId);
  if (!id) throw errorDato(null, "La solicitud indicada no es válida");
  const [filas] = await connection.query(
    "SELECT id, solicitante_usuario_id, persona_usuario_id, estado FROM familiar_cambio_solicitud WHERE id = ? FOR UPDATE",
    [id]
  );
  const solicitud = filas[0];
  if (!solicitud || idPositivo(solicitud.solicitante_usuario_id) !== actorId) {
    throw crearErrorUsuario("No encontramos ese pedido de cambio", 404, "SOLICITUD_NO_ENCONTRADA");
  }
  if (solicitud.estado !== "PENDIENTE") {
    throw crearErrorUsuario(
      `Ese pedido ya no está en revisión (${estadoLegible(solicitud.estado)})`,
      409,
      "SOLICITUD_YA_RESUELTA",
      { estado: solicitud.estado }
    );
  }
  const [resultado] = await connection.query(
    `UPDATE familiar_cambio_solicitud
        SET estado = 'CANCELADA', resuelto_usuario_id = ?, fecha_resolucion = NOW()
      WHERE id = ? AND estado = 'PENDIENTE'`,
    [actorId, id]
  );
  if (Number(resultado?.affectedRows) !== 1) {
    throw crearErrorUsuario("El pedido cambió mientras se procesaba. Actualizá la pantalla.", 409, "SOLICITUD_YA_RESUELTA");
  }
  await marcarAvisosSolicitudLeidos(connection, id);
  return { solicitud_id: id, codigo: codigoSolicitud(id), estado: "CANCELADA", persona_id: Number(solicitud.persona_usuario_id) };
}

function estadoLegible(estado) {
  return {
    PENDIENTE: "en revisión",
    APROBADA: "aprobado",
    RECHAZADA: "rechazado",
    CANCELADA: "retirado",
  }[estado] || String(estado || "").toLowerCase();
}

const SELECT_SOLICITUD = `
  SELECT f.id, f.persona_usuario_id, f.solicitante_usuario_id, f.departamental_id, f.estado,
         f.datos_anteriores, f.datos_propuestos, f.motivo_rechazo, f.resuelto_usuario_id,
         f.fecha_resolucion, f.fecha_creacion, f.fecha_modificacion,
         p.nombre AS persona_nombre, p.apellido AS persona_apellido, p.documento AS persona_documento,
         p.es_familiar AS persona_es_familiar, p.usuario_familiar_id AS persona_usuario_familiar_id,
         p.rol_id AS persona_rol_id, pa.nombre AS persona_parentesco,
         s.nombre AS solicitante_nombre, s.apellido AS solicitante_apellido, s.documento AS solicitante_documento,
         rz.nombre AS resuelto_nombre, rz.apellido AS resuelto_apellido,
         d.nombre AS departamental_nombre
    FROM familiar_cambio_solicitud f
    INNER JOIN usuario p ON p.id = f.persona_usuario_id
    INNER JOIN usuario s ON s.id = f.solicitante_usuario_id
    LEFT JOIN usuario rz ON rz.id = f.resuelto_usuario_id
    LEFT JOIN parentesco pa ON pa.id = p.parentesco_id
    LEFT JOIN departamental d ON d.id = f.departamental_id`;

function presentarSolicitud(fila, catalogos = {}) {
  const anteriores = filtrarSolicitables(parsearJson(fila.datos_anteriores));
  const propuestos = filtrarSolicitables(parsearJson(fila.datos_propuestos));
  const esFamiliarDelSolicitante = fila.persona_es_familiar === "S" &&
    idPositivo(fila.persona_usuario_familiar_id) === idPositivo(fila.solicitante_usuario_id);
  return {
    id: Number(fila.id),
    codigo: codigoSolicitud(fila.id),
    estado: fila.estado,
    fecha_creacion: fila.fecha_creacion ?? null,
    fecha_modificacion: fila.fecha_modificacion ?? null,
    fecha_resolucion: fila.fecha_resolucion ?? null,
    motivo_rechazo: fila.motivo_rechazo ?? null,
    departamental: {
      id: idPositivo(fila.departamental_id),
      nombre: fila.departamental_nombre ?? null,
    },
    persona: {
      id: Number(fila.persona_usuario_id),
      nombre: fila.persona_nombre ?? null,
      apellido: fila.persona_apellido ?? null,
      documento: fila.persona_documento ?? null,
      parentesco: fila.persona_parentesco ?? null,
      vinculo: esFamiliarDelSolicitante ? "FAMILIAR" : "ACOMPANIANTE",
    },
    solicitante: {
      id: Number(fila.solicitante_usuario_id),
      nombre: fila.solicitante_nombre ?? null,
      apellido: fila.solicitante_apellido ?? null,
      documento: fila.solicitante_documento ?? null,
    },
    resuelto_por: idPositivo(fila.resuelto_usuario_id)
      ? { id: Number(fila.resuelto_usuario_id), nombre: fila.resuelto_nombre ?? null, apellido: fila.resuelto_apellido ?? null }
      : null,
    campos: camposDeSolicitud(propuestos),
    datos_anteriores: anteriores,
    datos_propuestos: propuestos,
    cambios: presentarCambios(anteriores, propuestos, catalogos),
    // Frase legible del cambio de vínculo (null si el pedido no lo toca).
    cambio_vinculo: presentarCambioVinculo(propuestos, catalogos, { parentescoActual: fila.persona_parentesco ?? null }),
    // Se manda al resolver: si el afiliado reemplazó el pedido, 409 SOLICITUD_MODIFICADA.
    version: versionSolicitud(propuestos),
  };
}

function normalizarFiltrosListado(query = {}) {
  const primero = (valor) => (Array.isArray(valor) ? valor[0] : valor);
  const estadoCrudo = textoONull(primero(query.estado));
  const estado = estadoCrudo ? estadoCrudo.toUpperCase() : null;
  if (estado && estado !== "TODAS" && !ESTADOS_SOLICITUD.includes(estado)) {
    throw errorDato("estado", "El filtro de estado es inválido");
  }
  const search = textoONull(primero(query.search));
  if (search && search.length > BUSQUEDA_MAX) throw errorDato("search", "La búsqueda es demasiado larga");
  const pageCrudo = primero(query.page);
  const pageSizeCrudo = primero(query.pageSize);
  const page = pageCrudo === undefined || pageCrudo === "" ? 1 : idPositivo(pageCrudo);
  const pageSize = pageSizeCrudo === undefined || pageSizeCrudo === "" ? PAGE_SIZE_DEFECTO : idPositivo(pageSizeCrudo);
  if (!page || page > 100000 || !pageSize || pageSize > PAGE_SIZE_MAX) throw errorDato(null, "La paginación es inválida");
  const departamentalCrudo = primero(query.departamental_id);
  const departamentalId = departamentalCrudo === undefined || departamentalCrudo === "" ? null : idPositivo(departamentalCrudo);
  if (departamentalCrudo !== undefined && departamentalCrudo !== "" && !departamentalId) {
    throw errorDato("departamental_id", "La departamental es inválida");
  }
  return { estado: estado === "TODAS" ? null : estado, search, page, pageSize, departamentalId };
}

/**
 * Bandeja del staff. admin / admin-central ven todo (filtro opcional
 * departamental_id); departamental sólo lo de su departamental.
 */
async function listarSolicitudes(db, { actor, query = {} }) {
  if (!ROLES_STAFF_CAMBIOS.includes(actor?.rol)) {
    throw crearErrorUsuario("No autorizado", 403, "SIN_PERMISO");
  }
  const filtros = normalizarFiltrosListado(query);
  const alcance = [];
  const paramsAlcance = [];
  if (actor.rol === "departamental") {
    const propia = idPositivo(actor.departamental_id);
    if (!propia) throw crearErrorUsuario("Tu usuario no tiene una departamental asignada", 403, "SIN_DEPARTAMENTAL");
    alcance.push("f.departamental_id = ?");
    paramsAlcance.push(propia);
  } else if (filtros.departamentalId) {
    alcance.push("f.departamental_id = ?");
    paramsAlcance.push(filtros.departamentalId);
  }
  if (filtros.search) {
    const patron = `%${filtros.search}%`;
    const partes = [
      "p.nombre LIKE ?", "p.apellido LIKE ?", "CONCAT(p.nombre, ' ', p.apellido) LIKE ?",
      "CONCAT(p.apellido, ' ', p.nombre) LIKE ?", "CAST(p.documento AS CHAR) LIKE ?",
      "s.nombre LIKE ?", "s.apellido LIKE ?", "CONCAT(s.nombre, ' ', s.apellido) LIKE ?",
      "CONCAT(s.apellido, ' ', s.nombre) LIKE ?", "CAST(s.documento AS CHAR) LIKE ?",
    ];
    const params = Array(partes.length).fill(patron);
    const codigo = /^fc-?(\d+)$/i.exec(filtros.search.replace(/\s+/g, ""));
    if (codigo) {
      partes.push("f.id = ?");
      params.push(Number(codigo[1]));
    }
    alcance.push(`(${partes.join(" OR ")})`);
    paramsAlcance.push(...params);
  }

  const condiciones = [...alcance];
  const params = [...paramsAlcance];
  if (filtros.estado) {
    condiciones.push("f.estado = ?");
    params.push(filtros.estado);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
  const whereAlcance = alcance.length ? `WHERE ${alcance.join(" AND ")}` : "";
  const offset = (filtros.page - 1) * filtros.pageSize;

  const [filas] = await db.query(
    `${SELECT_SOLICITUD}
      ${where}
      ORDER BY (f.estado = 'PENDIENTE') DESC, f.fecha_modificacion DESC, f.id DESC
      LIMIT ? OFFSET ?`,
    [...params, filtros.pageSize, offset]
  );
  const [totales] = await db.query(
    `SELECT COUNT(*) AS total
       FROM familiar_cambio_solicitud f
       INNER JOIN usuario p ON p.id = f.persona_usuario_id
       INNER JOIN usuario s ON s.id = f.solicitante_usuario_id
      ${where}`,
    params
  );
  const [porEstado] = await db.query(
    `SELECT f.estado, COUNT(*) AS cantidad
       FROM familiar_cambio_solicitud f
       INNER JOIN usuario p ON p.id = f.persona_usuario_id
       INNER JOIN usuario s ON s.id = f.solicitante_usuario_id
      ${whereAlcance}
      GROUP BY f.estado`,
    paramsAlcance
  );
  const catalogos = filas.length ? await cargarCatalogos(db) : {};
  const conteos = { PENDIENTE: 0, APROBADA: 0, RECHAZADA: 0, CANCELADA: 0, TOTAL: 0 };
  for (const fila of porEstado) {
    const cantidad = Number(fila.cantidad) || 0;
    if (tieneClave(conteos, fila.estado)) conteos[fila.estado] = cantidad;
    conteos.TOTAL += cantidad;
  }
  const total = Number(totales?.[0]?.total) || 0;
  return {
    results: filas.map((fila) => presentarSolicitud(fila, catalogos)),
    total,
    page: filtros.page,
    pageSize: filtros.pageSize,
    numOfPages: Math.max(1, Math.ceil(total / filtros.pageSize)),
    conteos,
    filtros: { estado: filtros.estado, search: filtros.search, departamental_id: filtros.departamentalId },
  };
}

async function leerSolicitud(connection, solicitudId, { bloquear = false } = {}) {
  const [filas] = await connection.query(
    `${SELECT_SOLICITUD}
      WHERE f.id = ?${bloquear ? " FOR UPDATE OF f" : ""}`,
    [solicitudId]
  );
  return filas[0] || null;
}

/**
 * ¿Se puede aplicar hoy el cambio de vínculo pedido por `solicitanteId`?
 * null si se puede; si no, {codigo:'VINCULO_INVALIDO', mensaje}.
 *  - Nadie se "roba" del grupo de otro afiliado (usuario_familiar_id ajeno).
 *  - Quitar exige que la persona siga en el grupo del solicitante.
 *  - Sumar a alguien sin grupo exige que siga sin cuenta propia.
 */
function problemaVinculo(persona, { solicitanteId, esFamiliar, nombreSolicitante = "el afiliado" }) {
  const nombrePersona = nombreCompleto(persona);
  const vinculadaA = idPositivo(persona?.usuario_familiar_id);
  if (vinculadaA && vinculadaA !== solicitanteId) {
    return {
      codigo: "VINCULO_INVALIDO",
      mensaje: `${nombrePersona} ahora integra el grupo de otro afiliado: el cambio de vínculo pedido por ${nombreSolicitante} ya no se puede aplicar.`,
    };
  }
  if (vinculoNormalizado(esFamiliar) === "N" && vinculadaA !== solicitanteId) {
    return {
      codigo: "VINCULO_INVALIDO",
      mensaje: `${nombrePersona} ya no integra el grupo de ${nombreSolicitante}: no hay nada que quitar.`,
    };
  }
  if (vinculoNormalizado(esFamiliar) === "S" && !vinculadaA && tieneCuentaPropia(persona)) {
    return {
      codigo: "VINCULO_INVALIDO",
      mensaje: `${nombrePersona} ahora tiene cuenta propia en MiAJB: sumala al grupo desde su ficha si corresponde.`,
    };
  }
  return null;
}

/**
 * Advertencias para quien aprueba (sólo si la solicitud sigue PENDIENTE): DNI
 * tomado, persona con cuenta propia (el DNI es su usuario de ingreso), reservas
 * abiertas, coseguro en curso, reglas que hoy no se cumplirían, vínculo que ya
 * no se puede aplicar y ficha modificada desde el pedido.
 */
async function advertenciasSolicitud(db, { actor, solicitud, persona, anteriores, propuestos }) {
  const advertencias = [];
  if (solicitud.estado !== "PENDIENTE" || !persona) return advertencias;
  const hoy = obtenerFechaCivilArgentina();
  const campos = camposDeSolicitud(propuestos);
  const nombrePersona = nombreCompleto(persona);

  const modificados = camposModificadosDesdePedido(persona, anteriores, campos);
  if (modificados.length) {
    advertencias.push({
      codigo: "FICHA_MODIFICADA",
      campos: modificados,
      mensaje: `La ficha de ${nombrePersona} cambió desde que se hizo el pedido (${listaLegible(modificados.map(etiquetaEnFrase))}). Si aprobás, se aplican igual los datos pedidos.`,
    });
  }

  const distintos = {};
  for (const campo of campos) {
    if (!mismoValor(campo, valorGuardado(campo, persona), propuestos[campo])) distintos[campo] = propuestos[campo];
  }
  if (campos.length && Object.keys(distintos).length === 0) {
    advertencias.push({
      codigo: "SIN_DIFERENCIAS",
      mensaje: `Los datos pedidos ya coinciden con la ficha actual de ${nombrePersona}: aprobar no cambia nada.`,
    });
  }

  try {
    validarReglasSolicitud({ persona, propuestos: distintos, hoy });
  } catch (error) {
    advertencias.push({ codigo: error.codigo || "DATO_INVALIDO", campo: error.campo, mensaje: `${cerrarFrase(error.message)} Así no se puede aprobar.` });
  }

  if (tieneClave(distintos, "es_familiar")) {
    const solicitanteId = idPositivo(solicitud.solicitante_usuario_id);
    const nombreSolicitante = nombreCompleto({ id: solicitanteId, nombre: solicitud.solicitante_nombre, apellido: solicitud.solicitante_apellido });
    const problema = problemaVinculo(persona, { solicitanteId, esFamiliar: distintos.es_familiar, nombreSolicitante });
    if (problema) {
      advertencias.push({ ...problema, campo: "es_familiar" });
    } else if (vinculoNormalizado(distintos.es_familiar) === "S" && !idPositivo(persona.usuario_familiar_id)) {
      advertencias.push({
        codigo: "VINCULO_NUEVO",
        mensaje: `${nombrePersona} no integraba ningún grupo (viajó con ${nombreSolicitante}): si aprobás, pasa al grupo de ${nombreSolicitante} y toma la departamental del titular.`,
      });
    }
  }

  if (tieneClave(distintos, "documento") && distintos.documento) {
    const [duplicados] = await db.query(
      "SELECT id FROM usuario WHERE documento = ? AND id <> ? LIMIT 1",
      [distintos.documento, persona.id]
    );
    if (duplicados.length) {
      const advertencia = {
        codigo: "DNI_TOMADO",
        campo: "documento",
        mensaje: `El DNI ${distintos.documento} ya está registrado para otra persona: así no se puede aprobar.`,
      };
      if (ROLES_SUPERIORES.includes(actor?.rol)) advertencia.usuario_existente_id = Number(duplicados[0].id);
      advertencias.push(advertencia);
    }
    const [otros] = await db.query(
      `SELECT id FROM familiar_cambio_solicitud
        WHERE estado = 'PENDIENTE' AND id <> ?
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(datos_propuestos, '$.documento')) AS UNSIGNED) = ?`,
      [solicitud.id, distintos.documento]
    );
    if (otros.length) {
      advertencias.push({
        codigo: "DNI_EN_OTRO_PEDIDO",
        campo: "documento",
        solicitudes: otros.map((fila) => codigoSolicitud(fila.id)),
        mensaje: `El mismo DNI figura en otro pedido en revisión (${otros.map((fila) => codigoSolicitud(fila.id)).join(", ")}): sólo se va a poder aprobar uno.`,
      });
    }
    const dniViejo = valorGuardado("documento", persona);
    if (dniViejo && persona.cuil && String(persona.cuil).slice(2, 10) === String(dniViejo).padStart(8, "0")) {
      advertencias.push({
        codigo: "CUIL_CON_DNI_ANTERIOR",
        mensaje: `El CUIL guardado (${persona.cuil}) contiene el DNI actual (${dniViejo}); si cambia el DNI, revisá también el CUIL.`,
      });
    }
  }

  const tieneCuenta = persona.password !== null && persona.password !== undefined && nombreRol(persona) !== "invitado";
  if (tieneCuenta) {
    advertencias.push({
      codigo: "CUENTA_PROPIA",
      mensaje: `${nombrePersona} tiene cuenta propia en MiAJB: el pedido lo hizo otra persona de su grupo.`,
    });
    if (tieneClave(distintos, "documento")) {
      const dniViejo = valorGuardado("documento", persona);
      advertencias.push({
        codigo: "LOGIN_CAMBIA_DNI",
        campo: "documento",
        mensaje: `${nombrePersona} ingresa al sistema con su DNI: si aprobás, tiene que iniciar sesión con ${distintos.documento}${dniViejo ? ` (el ${dniViejo} deja de funcionar)` : ""}.`,
      });
    }
  }

  const [reservas] = await db.query(
    `SELECT DISTINCT r.id, r.estado_reserva_id, er.nombre AS estado_nombre, r.fecha_inicio, r.fecha_fin
       FROM reserva_familiar rf
       INNER JOIN reserva r ON r.id = rf.reserva_id
       LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
      WHERE rf.usuario_id = ? AND r.estado_reserva_id IN (?) AND r.fecha_fin >= ?
      ORDER BY r.fecha_inicio, r.id`,
    [persona.id, ESTADOS_RESERVA_ABIERTA, hoy]
  );
  if (reservas.length) {
    const afectaTarifa = tieneClave(distintos, "tipo_persona_id") || tieneClave(distintos, "fecha_nacimiento");
    advertencias.push({
      codigo: "RESERVAS_ABIERTAS",
      reservas: reservas.map((fila) => ({
        reserva_id: Number(fila.id),
        estado: fila.estado_nombre ?? null,
        fecha_inicio: fechaGuardada(fila.fecha_inicio),
        fecha_fin: fechaGuardada(fila.fecha_fin),
      })),
      mensaje: afectaTarifa
        ? `${nombrePersona} viaja en ${reservas.length} reserva(s) abierta(s). Cambiar el tipo de persona o la fecha de nacimiento no recalcula la tarifa ya cotizada: revisalas después de aprobar.`
        : `${nombrePersona} viaja en ${reservas.length} reserva(s) abierta(s); van a mostrar los datos nuevos.`,
    });
  }

  const [coseguro] = await db.query(
    `SELECT id, estado_id
       FROM coseguro_solicitud
      WHERE (usuario_id = ? OR familiar_usuario_id = ?) AND eliminado = 0 AND estado_id IN (?)
      ORDER BY id`,
    [persona.id, persona.id, ESTADOS_COSEGURO_EN_CURSO]
  );
  if (coseguro.length) {
    advertencias.push({
      codigo: "COSEGURO_EN_CURSO",
      solicitudes: coseguro.map((fila) => Number(fila.id)),
      mensaje: `${nombrePersona} tiene ${coseguro.length} solicitud(es) de reintegro en curso (${coseguro.map((fila) => `#${fila.id}`).join(", ")}); van a tomar los datos nuevos.`,
    });
  }

  return advertencias;
}

/** Detalle para el staff (con advertencias) o para el afiliado dueño (sin ellas). */
async function detalleSolicitud(db, { actor, solicitudId }) {
  const id = idPositivo(solicitudId);
  if (!id) throw errorDato(null, "La solicitud indicada no es válida");
  const fila = await leerSolicitud(db, id);
  if (!fila) throw crearErrorUsuario("No encontramos ese pedido de cambio", 404, "SOLICITUD_NO_ENCONTRADA");
  if (!puedeVerSolicitud(actor, fila)) {
    if (actor?.rol === "afiliado") throw crearErrorUsuario("No encontramos ese pedido de cambio", 404, "SOLICITUD_NO_ENCONTRADA");
    throw crearErrorUsuario("Este pedido corresponde a otra departamental", 403, "SIN_PERMISO");
  }
  const catalogos = await cargarCatalogos(db);
  const detalle = presentarSolicitud(fila, catalogos);
  if (!puedeGestionarSolicitud(actor, fila)) return detalle;

  const persona = await cargarUsuarioObjetivo(db, fila.persona_usuario_id).catch((error) => {
    if (error?.statusCode === 404) return null;
    throw error;
  });
  const fichaActual = {};
  if (persona) {
    for (const campo of CAMPOS_PEDIDO) fichaActual[campo] = valorGuardado(campo, persona);
  }
  detalle.ficha_actual = fichaActual;
  detalle.ficha_actual_texto = Object.fromEntries(
    CAMPOS_PEDIDO.map((campo) => [campo, textoValor(campo, fichaActual[campo], catalogos)])
  );
  detalle.persona.tiene_cuenta = Boolean(persona && persona.password !== null && persona.password !== undefined &&
    nombreRol(persona) !== "invitado");
  const advertencias = await advertenciasSolicitud(db, {
    actor,
    solicitud: fila,
    persona,
    anteriores: detalle.datos_anteriores,
    propuestos: detalle.datos_propuestos,
  });

  // Jurisdicción: la departamental del pedido tiene que seguir siendo la del
  // titular (si el titular se mudó y el pedido no se reasignó, la departamental
  // vieja ya no lo puede resolver).
  let puedeResolver = fila.estado === "PENDIENTE";
  if (puedeResolver) {
    const jurisdiccion = await verificarJurisdiccion(db, fila);
    if (!jurisdiccion.vigente) {
      if (actor.rol === "departamental") {
        puedeResolver = false;
        advertencias.unshift({ codigo: "FUERA_DE_JURISDICCION", mensaje: jurisdiccion.mensaje });
      } else {
        advertencias.unshift({ codigo: "DEPARTAMENTAL_CAMBIADA", mensaje: jurisdiccion.mensajeSuperior });
      }
    }
  }
  detalle.advertencias = advertencias;
  detalle.puede_resolver = puedeResolver;
  return detalle;
}

/**
 * ¿La departamental del pedido sigue siendo la del titular que lo hizo?
 * {vigente, departamentalTitularId, mensaje (para la departamental),
 *  mensajeSuperior (para admin / admin-central)}.
 */
async function verificarJurisdiccion(db, solicitud) {
  const { departamentalId: actual } = await departamentalActualDelTitular(db, solicitud.solicitante_usuario_id);
  const delPedido = idPositivo(solicitud.departamental_id);
  if (actual && actual === delPedido) return { vigente: true, departamentalTitularId: actual };
  const nombreActual = actual ? await nombreDepartamental(db, actual) : null;
  const destino = actual ? `la departamental ${nombreActual || `#${actual}`}` : null;
  return {
    vigente: false,
    departamentalTitularId: actual,
    mensaje: destino
      ? `Este pedido ya no es de tu jurisdicción: el titular pasó a ${destino}. Lo tiene que resolver esa departamental o AJB central.`
      : "Este pedido ya no es de tu jurisdicción: el titular no tiene una departamental asignada. Lo tiene que resolver AJB central.",
    mensajeSuperior: destino
      ? `El titular pasó a ${destino}, pero el pedido sigue asignado a otra departamental.`
      : "El titular ya no tiene una departamental asignada.",
  };
}

/**
 * Ata a la persona al grupo del solicitante al aprobar un cambio de vínculo:
 * usuario_familiar_id = solicitante y, si pasa a integrar el grupo familiar,
 * la departamental del titular. Son las columnas "de vínculo" que no pasan por
 * actualizarDatosUsuario (usuario_familiar_id no está en su lista de campos, y
 * la departamental propagaría como si la persona fuera titular): se escriben
 * acá con historial estricto, en la transacción del llamador. es_familiar,
 * parentesco y el resto de los datos los aplica después actualizarDatosUsuario.
 *
 * @returns {Promise<Array<{campo, valorAnterior, valorNuevo}>>} lo que cambió
 */
async function aplicarVinculoAprobado(connection, {
  persona,
  solicitanteId,
  esFamiliar,
  departamentalTitularId,
  actorId,
  contexto = {},
  observaciones,
}) {
  const cambios = [];
  const vinculadaA = idPositivo(persona.usuario_familiar_id);
  if (vinculadaA !== solicitanteId) {
    cambios.push({ campo: "usuario_familiar_id", valorAnterior: vinculadaA, valorNuevo: solicitanteId });
  }
  const departamentalPersona = idPositivo(persona.departamental_id);
  const departamentalNueva = idPositivo(departamentalTitularId);
  if (vinculoNormalizado(esFamiliar) === "S" && departamentalNueva && departamentalPersona !== departamentalNueva) {
    cambios.push({ campo: "departamental_id", valorAnterior: departamentalPersona, valorNuevo: departamentalNueva });
  }
  if (cambios.length === 0) return cambios;
  await connection.query(
    `UPDATE usuario SET ${cambios.map(({ campo }) => `${campo} = ?`).join(", ")} WHERE id = ?`,
    [...cambios.map(({ valorNuevo }) => valorNuevo), persona.id]
  );
  await registrarHistorialUsuarioEstricto(connection, {
    usuarioId: persona.id,
    modificadorId: actorId,
    contexto,
    campos: cambios,
    observaciones,
  });
  return cambios;
}

/** Título y mensaje del aviso al afiliado cuando se resuelve su pedido. */
function textosAvisoResolucion({ aprobada, quien, codigo, nombrePersona, camposTexto, motivo, cambioVinculo, otrosCampos }) {
  const vinculo = cambioVinculo?.es_familiar || null;
  const tambien = otrosCampos.length
    ? ` También ${aprobada ? "quedó vigente" : "se pedía"} el cambio de ${listaLegible(otrosCampos.map(etiquetaEnFrase))}.`
    : "";
  if (aprobada) {
    if (vinculo === "S") {
      return {
        titulo: `${nombrePersona} ya integra tu grupo familiar`,
        mensaje: `${quien} aprobó tu pedido ${codigo}: ${nombrePersona} pasa a integrar tu grupo familiar` +
          `${cambioVinculo.parentesco_texto ? ` como ${cambioVinculo.parentesco_texto}` : ""}.${tambien}`,
      };
    }
    if (vinculo === "N") {
      return {
        titulo: `${nombrePersona} quedó como acompañante de viaje`,
        mensaje: `${quien} aprobó tu pedido ${codigo}: ${nombrePersona} deja tu grupo familiar y queda como acompañante de viaje.${tambien}`,
      };
    }
    return {
      titulo: `Se aprobaron los cambios de ${nombrePersona}`,
      mensaje: `${quien} aprobó el cambio de ${camposTexto} (${codigo}). Los datos nuevos de ${nombrePersona} ya están vigentes.`,
    };
  }
  const motivoTexto = `Motivo: ${cerrarFrase(motivo)}`;
  if (vinculo === "S") {
    return {
      titulo: `No se aprobó sumar a ${nombrePersona} a tu grupo familiar`,
      mensaje: `${quien} rechazó el pedido ${codigo}. ${motivoTexto} ${nombrePersona} sigue como estaba.`,
    };
  }
  if (vinculo === "N") {
    return {
      titulo: `No se aprobó quitar a ${nombrePersona} de tu grupo familiar`,
      mensaje: `${quien} rechazó el pedido ${codigo}. ${motivoTexto} ${nombrePersona} sigue en tu grupo familiar.`,
    };
  }
  return {
    titulo: `No se aprobaron los cambios de ${nombrePersona}`,
    mensaje: `${quien} rechazó el pedido de cambio de ${camposTexto} (${codigo}). ${motivoTexto} Los datos de ${nombrePersona} siguen como estaban.`,
  };
}

/**
 * Aprueba o rechaza una solicitud PENDIENTE (dentro de la transacción del
 * llamador).
 *  - Permiso: admin / admin-central, o departamental de la misma departamental
 *    que además siga siendo la del titular (si no, 403 FUERA_DE_JURISDICCION).
 *  - `version` obligatoria (la del detalle que se revisó): si el afiliado
 *    reemplazó el pedido mientras tanto → 409 SOLICITUD_MODIFICADA.
 *  - RECHAZAR exige motivo.
 *  - APROBAR: si la ficha cambió desde el pedido → 409 FICHA_MODIFICADA salvo
 *    `forzar`; revalida las reglas y aplica con actualizarDatosUsuario (actor =
 *    aprobador, origen 'aprobacion', historial "Solicitado por … (FC-n),
 *    aprobado por …"). Si el pedido cambia el vínculo, antes ata a la persona
 *    al grupo del solicitante (aplicarVinculoAprobado).
 *  - UPDATE ... WHERE estado = 'PENDIENTE' con control de affectedRows.
 *  - Notifica al afiliado que pidió el cambio.
 */
async function resolverSolicitud(connection, {
  actor,
  solicitudId,
  accion,
  motivo,
  forzar = false,
  version,
  contexto = {},
} = {}) {
  const actorId = idPositivo(actor?.id);
  if (!actorId) throw crearErrorUsuario("No se pudo identificar al usuario autenticado", 401, "SIN_SESION");
  if (!ROLES_STAFF_CAMBIOS.includes(actor.rol)) throw crearErrorUsuario("No autorizado", 403, "SIN_PERMISO");
  const id = idPositivo(solicitudId);
  if (!id) throw errorDato(null, "La solicitud indicada no es válida");
  const accionNormalizada = typeof accion === "string" ? accion.trim().toUpperCase() : "";
  if (!ACCIONES_RESOLUCION.includes(accionNormalizada)) {
    throw errorDato("accion", "La acción tiene que ser APROBAR o RECHAZAR");
  }
  if (motivo !== undefined && motivo !== null && typeof motivo !== "string") {
    throw errorDato("motivo", "El motivo es inválido");
  }
  const motivoTexto = textoONull(motivo);
  if (motivoTexto && motivoTexto.length > MOTIVO_MAX) {
    throw errorDato("motivo", `El motivo admite hasta ${MOTIVO_MAX} caracteres`);
  }
  if (accionNormalizada === "RECHAZAR" && !motivoTexto) {
    throw errorDato("motivo", "Para rechazar el pedido tenés que escribir el motivo: se lo mandamos al afiliado", 400, "MOTIVO_OBLIGATORIO");
  }
  const versionVista = typeof version === "string" ? version.trim() : "";
  if (!versionVista || versionVista.length > 64) {
    throw errorDato(
      "version",
      "Falta la versión del pedido que revisaste. Actualizá la pantalla y volvé a intentar.",
      400,
      "VERSION_REQUERIDA"
    );
  }
  const forzarAplicar = forzar === true || forzar === "true" || forzar === 1 || forzar === "1";

  // 1. Lectura sin bloqueo para conocer a la persona; los bloqueos van en el
  //    mismo orden que al pedir (persona → solicitud) para no cruzarse.
  const previa = await leerSolicitud(connection, id);
  if (!previa) throw crearErrorUsuario("No encontramos ese pedido de cambio", 404, "SOLICITUD_NO_ENCONTRADA");
  if (!puedeGestionarSolicitud(actor, previa)) {
    throw crearErrorUsuario("Este pedido corresponde a otra departamental", 403, "SIN_PERMISO");
  }
  const persona = await cargarUsuarioObjetivo(connection, previa.persona_usuario_id, { bloquear: true });
  const [bloqueadas] = await connection.query(
    `SELECT id, persona_usuario_id, solicitante_usuario_id, departamental_id, estado, datos_anteriores, datos_propuestos
       FROM familiar_cambio_solicitud
      WHERE id = ?
      FOR UPDATE`,
    [id]
  );
  const solicitud = bloqueadas[0];
  if (!solicitud) throw crearErrorUsuario("No encontramos ese pedido de cambio", 404, "SOLICITUD_NO_ENCONTRADA");
  if (!puedeGestionarSolicitud(actor, solicitud)) {
    throw crearErrorUsuario("Este pedido corresponde a otra departamental", 403, "SIN_PERMISO");
  }
  if (solicitud.estado !== "PENDIENTE") {
    throw crearErrorUsuario(
      `Este pedido ya fue ${estadoLegible(solicitud.estado)}: actualizá la pantalla.`,
      409,
      "SOLICITUD_YA_RESUELTA",
      { estado: solicitud.estado }
    );
  }
  // 2. Jurisdicción: la departamental sólo resuelve si la persona sigue siendo
  //    de su jurisdicción (la del pedido = la actual del titular).
  const jurisdiccion = await verificarJurisdiccion(connection, solicitud);
  if (actor.rol === "departamental" && !jurisdiccion.vigente) {
    throw crearErrorUsuario(jurisdiccion.mensaje, 403, "FUERA_DE_JURISDICCION");
  }
  // 3. Versión: lo que se resuelve tiene que ser lo que se vio.
  const versionActual = versionSolicitud(solicitud.datos_propuestos);
  if (versionActual !== versionVista) {
    throw crearErrorUsuario(
      "El afiliado actualizó el pedido mientras lo revisabas; revisalo de nuevo.",
      409,
      "SOLICITUD_MODIFICADA",
      { version: versionActual }
    );
  }

  const anteriores = filtrarSolicitables(parsearJson(solicitud.datos_anteriores));
  const propuestos = filtrarSolicitables(parsearJson(solicitud.datos_propuestos));
  const campos = camposDeSolicitud(propuestos);
  const catalogos = await cargarCatalogosSiHaceFalta(connection, campos);
  const cambiosLegibles = presentarCambios(anteriores, propuestos, catalogos);
  const cambioVinculo = presentarCambioVinculo(propuestos, catalogos, {
    parentescoActual: catalogos.parentescos?.get(Number(persona.parentesco_id)) || null,
  });
  const solicitanteId = Number(solicitud.solicitante_usuario_id);
  const solicitante = await datosUsuario(connection, solicitanteId);
  const staff = await datosUsuario(connection, actorId);
  const nombrePersona = nombreCompleto(persona);
  const codigo = codigoSolicitud(id);
  const camposTexto = listaLegible(campos.map(etiquetaEnFrase)) || "sus datos";
  // Campos que no son el vínculo (ni el parentesco con el que se suma al grupo).
  const otrosCampos = cambioVinculo
    ? campos.filter((campo) => campo !== "es_familiar" && !(cambioVinculo.es_familiar === "S" && campo === "parentesco_id"))
    : campos;
  const payload = { solicitud_id: id, persona_id: Number(persona.id) };

  if (accionNormalizada === "RECHAZAR") {
    const [actualizacion] = await connection.query(
      `UPDATE familiar_cambio_solicitud
          SET estado = 'RECHAZADA', motivo_rechazo = ?, resuelto_usuario_id = ?, fecha_resolucion = NOW()
        WHERE id = ? AND estado = 'PENDIENTE'`,
      [motivoTexto, actorId, id]
    );
    if (Number(actualizacion?.affectedRows) !== 1) {
      throw crearErrorUsuario("El pedido cambió mientras se procesaba. Actualizá la pantalla.", 409, "SOLICITUD_YA_RESUELTA");
    }
    await marcarAvisosSolicitudLeidos(connection, id);
    const aviso = textosAvisoResolucion({
      aprobada: false,
      quien: quienResolvio(staff),
      codigo,
      nombrePersona,
      camposTexto,
      motivo: motivoTexto,
      cambioVinculo,
      otrosCampos,
    });
    await insertarNotificacion(connection, solicitanteId, TIPOS_NOTIFICACION_FAMILIAR.RECHAZADO, aviso.titulo, aviso.mensaje, payload);
    return {
      solicitud_id: id,
      codigo,
      estado: "RECHAZADA",
      motivo_rechazo: motivoTexto,
      campos,
      cambios: cambiosLegibles,
      cambio_vinculo: cambioVinculo,
      resultado: null,
    };
  }

  // APROBAR
  if (actor.rol !== "admin" && !ROLES_PERSONA_GESTIONABLE.includes(nombreRol(persona))) {
    throw crearErrorUsuario(
      "Los datos de esta persona sólo los puede cambiar un administrador",
      403,
      "SIN_PERMISO"
    );
  }
  const modificados = camposModificadosDesdePedido(persona, anteriores, campos);
  if (modificados.length && !forzarAplicar) {
    throw crearErrorUsuario(
      `La ficha de ${nombrePersona} cambió desde que se hizo el pedido (${listaLegible(modificados.map(etiquetaEnFrase))}). ` +
        "Revisá los datos actuales y, si igual corresponde, confirmá para aplicar lo pedido.",
      409,
      "FICHA_MODIFICADA",
      { campos: modificados }
    );
  }
  const distintos = {};
  for (const campo of campos) {
    if (!mismoValor(campo, valorGuardado(campo, persona), propuestos[campo])) distintos[campo] = propuestos[campo];
  }
  validarReglasSolicitud({ persona, propuestos: distintos });
  const cambiaVinculo = tieneClave(distintos, "es_familiar");
  if (cambiaVinculo) {
    const problema = problemaVinculo(persona, {
      solicitanteId,
      esFamiliar: distintos.es_familiar,
      nombreSolicitante: nombreCompleto(solicitante),
    });
    if (problema) throw crearErrorUsuario(problema.mensaje, 409, problema.codigo, { campo: "es_familiar" });
  }

  let observaciones = `Solicitado por ${nombreCompleto(solicitante)} (${codigo}), aprobado por ${nombreCompleto(staff)}`;
  if (modificados.length) observaciones += ". Se aplicó aunque la ficha había cambiado desde el pedido";
  if (motivoTexto) observaciones += `. Nota: ${motivoTexto}`;

  // Vínculo primero: actualizarDatosUsuario exige que quien pasa a integrar el
  // grupo familiar ya esté vinculada a un titular (usuario_familiar_id).
  const cambiosVinculo = cambiaVinculo
    ? await aplicarVinculoAprobado(connection, {
      persona,
      solicitanteId,
      esFamiliar: distintos.es_familiar,
      departamentalTitularId: jurisdiccion.departamentalTitularId,
      actorId,
      contexto,
      observaciones,
    })
    : [];

  const resultado = await actualizarDatosUsuario(connection, {
    actor,
    usuarioId: persona.id,
    // es_familiar siempre explícito: el pedido de vínculo lo trae; si no, se
    // pasa el actual para que un cambio de parentesco no sume ni saque a la
    // persona del grupo familiar (eso sólo pasa con un pedido de vínculo).
    cambios: { ...distintos, es_familiar: cambiaVinculo ? distintos.es_familiar : (persona.es_familiar ?? null) },
    contexto: { ...contexto, origen: "aprobacion", observaciones },
    // La ruta ya autorizó: solicitud de la misma departamental (la del titular,
    // que puede no coincidir con la columna de la persona si quedó vieja).
    opciones: { autorizacionPrevia: true },
  });
  if (cambiosVinculo.length) resultado.cambios = [...cambiosVinculo, ...(resultado.cambios || [])];

  const [actualizacion] = await connection.query(
    `UPDATE familiar_cambio_solicitud
        SET estado = 'APROBADA', resuelto_usuario_id = ?, fecha_resolucion = NOW()
      WHERE id = ? AND estado = 'PENDIENTE'`,
    [actorId, id]
  );
  if (Number(actualizacion?.affectedRows) !== 1) {
    throw crearErrorUsuario("El pedido cambió mientras se procesaba. Actualizá la pantalla.", 409, "SOLICITUD_YA_RESUELTA");
  }
  await marcarAvisosSolicitudLeidos(connection, id);
  const aviso = textosAvisoResolucion({
    aprobada: true,
    quien: quienResolvio(staff),
    codigo,
    nombrePersona,
    camposTexto,
    motivo: motivoTexto,
    cambioVinculo,
    otrosCampos,
  });
  await insertarNotificacion(connection, solicitanteId, TIPOS_NOTIFICACION_FAMILIAR.APROBADO, aviso.titulo, aviso.mensaje, payload);
  return {
    solicitud_id: id,
    codigo,
    estado: "APROBADA",
    forzada: modificados.length > 0,
    campos,
    cambios: cambiosLegibles,
    cambio_vinculo: cambioVinculo,
    resultado,
  };
}

/**
 * Solicitudes PENDIENTES de las personas indicadas: Map(persona_id → resumen).
 * Si la tabla todavía no existe (backend desplegado antes que la migración)
 * devuelve un Map vacío para no romper las pantallas que sólo la consultan.
 */
async function obtenerCambiosPendientesPorPersona(db, personaIds) {
  const ids = [...new Set((personaIds || []).map(idPositivo).filter(Boolean))];
  if (ids.length === 0) return new Map();
  try {
    const [filas] = await db.query(
      `SELECT id, persona_usuario_id, solicitante_usuario_id, datos_anteriores, datos_propuestos,
              fecha_creacion, fecha_modificacion
         FROM familiar_cambio_solicitud
        WHERE pendiente_persona IN (?)`,
      [ids]
    );
    return new Map(filas.map((fila) => [Number(fila.persona_usuario_id), presentarPendiente(fila)]));
  } catch (error) {
    if (esTablaNoDisponible(error)) return new Map();
    throw error;
  }
}

/** Cantidad de personas de una subconsulta (columna `id`) con un pedido pendiente. */
async function contarPendientesEnSubconsulta(db, subconsulta, params = []) {
  try {
    const [filas] = await db.query(
      `SELECT COUNT(*) AS pendientes
         FROM (${subconsulta}) base
         INNER JOIN familiar_cambio_solicitud fcs ON fcs.pendiente_persona = base.id`,
      params
    );
    return Number(filas?.[0]?.pendientes) || 0;
  } catch (error) {
    if (esTablaNoDisponible(error)) return 0;
    throw error;
  }
}

/** Cuerpo JSON uniforme para los errores de este flujo. */
function cuerpoErrorCambio(error) {
  const cuerpo = { success: false, message: error.message };
  for (const clave of ["codigo", "campo", "campos", "solicitud_id", "estado", "version", "usuario_existente_id", "traslado_id"]) {
    if (error[clave] !== undefined && error[clave] !== null) cuerpo[clave] = error[clave];
  }
  return cuerpo;
}

module.exports = {
  ACCIONES_RESOLUCION,
  CAMPOS_PEDIDO,
  CAMPOS_SOLICITABLES,
  ESTADOS_SOLICITUD,
  ETIQUETAS_CAMPOS,
  ROLES_STAFF_CAMBIOS,
  TIPOS_NOTIFICACION_FAMILIAR,
  acotarTituloNotificacion,
  calcularDiferencias,
  camposModificadosDesdePedido,
  cancelarSolicitud,
  cerrarFrase,
  codigoSolicitud,
  contarPendientesEnSubconsulta,
  cuerpoErrorCambio,
  departamentalActualDelTitular,
  detalleSolicitud,
  extraerDatosSolicitados,
  listarSolicitudes,
  listaLegible,
  normalizarDatosSolicitados,
  normalizarFiltrosListado,
  notificarDepartamentales,
  notificarDepartamentalesCambioFamiliar,
  obtenerCambiosPendientesPorPersona,
  personaEnUniversoAfiliado,
  presentarCambioVinculo,
  presentarCambios,
  problemaVinculo,
  puedeGestionarSolicitud,
  puedeVerSolicitud,
  reasignarSolicitudesPendientesDelTitular,
  resolverSolicitud,
  solicitarCambioFamiliar,
  solicitarCambioVinculo,
  validarReglasSolicitud,
  valorGuardado,
  versionSolicitud,
};
