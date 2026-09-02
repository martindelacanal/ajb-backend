"use strict";

// Descuentos de turismo (cupones con hashtag y tipos de viaje).
//
// Este módulo es la única fuente de verdad del cálculo: lo usan la
// previsualización del paso "Descuentos" del formulario de reserva y el alta /
// edición real de la reserva en user.js. Todo el dinero se trabaja en centavos
// y los porcentajes en puntos base (1% = 100 pb) con los helpers de
// valores-dominio, igual que el resto de la cotización.
//
// Reglas de negocio:
// - Una reserva puede llevar como máximo UN cupón y UN tipo de viaje.
// - Cada regla define sobre qué base se aplica: PRECIO_FINAL (lo que paga el
//   afiliado después del descuento de temporada) o PRECIO_LISTA (el precio de
//   lista / particular, antes del descuento de temporada).
// - Puede limitarse a tipos de persona y/o a un rango de edad: en ese caso la
//   base son solo las personas alcanzadas.
// - Los adicionales entran en la base solo si la regla lo indica y no filtra
//   personas (los adicionales no son por persona).
// - Si conviven cupón y tipo de viaje: se suman si ambos son acumulables; si
//   no, se aplica solo el más conveniente para el afiliado.
// - Ningún descuento puede dejar la reserva en negativo.

const {
  aplicarDescuentoEnPuntosBase,
  centavosANumero,
  decimalACentavos,
  decimalAPuntosBase,
  obtenerFechaCivilArgentina,
  sumarCentavos,
} = require("./valores-dominio");

const TIPOS_REGLA = Object.freeze(["CUPON", "TIPO_VIAJE"]);
const BASES_CALCULO = Object.freeze(["PRECIO_FINAL", "PRECIO_LISTA"]);
const ALCANCES_DEPARTAMENTAL = Object.freeze(["TODAS", "SELECCIONADAS"]);
const ALCANCES_SERVICIO = Object.freeze(["TODOS", "SELECCIONADOS"]);
const ALCANCES_PERSONA = Object.freeze(["TODAS", "SELECCIONADAS"]);
// Estados de reserva que no consumen cupos de uso ni suman en las métricas:
// la reserva no prosperó (misma lista de terminales negativos que usa el resto
// del backend y el verificador de integridad financiera).
const ESTADOS_RESERVA_NO_CONSUMEN = Object.freeze([
  "Cancelada",
  "Rechazada",
  "No adjudicada",
  "Convenio rechazado",
]);
const CODIGO_CUPON_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const CODIGO_TIPO_VIAJE_RE = /^[A-Z0-9][A-Z0-9_-]{1,59}$/;

function crearError(mensaje, statusCode = 400, codigo = null, detalles = null) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  if (codigo) error.codigo = codigo;
  if (detalles) error.detalles = detalles;
  return error;
}

function normalizarIdPositivo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

/**
 * Normaliza lo que escribe el afiliado en el campo del cupón: acepta el
 * hashtag con o sin "#", espacios alrededor, minúsculas y acentos comunes.
 * Devuelve null si el texto no puede ser un código válido.
 */
function normalizarCodigoCupon(texto) {
  if (texto === undefined || texto === null) return null;
  let codigo = String(texto).trim();
  if (!codigo) return null;
  codigo = codigo.replace(/^#+/, "").trim();
  codigo = codigo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .toUpperCase();
  return CODIGO_CUPON_RE.test(codigo) ? codigo : null;
}

function normalizarCodigoTipoViaje(texto, fallback = null) {
  const base = texto === undefined || texto === null || String(texto).trim() === "" ? fallback : texto;
  if (base === undefined || base === null) return null;
  const codigo = String(base)
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return CODIGO_TIPO_VIAJE_RE.test(codigo) ? codigo : null;
}

function esVerdadero(valor) {
  return valor === true || valor === 1 || valor === "1" || valor === "true";
}

// ---------------------------------------------------------------------------
// Cálculo puro
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {Array<{tipo_persona_id:number, edad:number|null, final_centavos:number, lista_centavos:number}>} params.personas
 * @param {number} params.adicionalesCentavos
 * @param {Array<object>} params.reglas  Reglas ya resueltas para el contexto:
 *   { id, tipo, codigo, nombre, porcentaje (0-100), base_calculo,
 *     incluye_adicionales, acumulable, alcance_persona, tipos_persona: number[],
 *     edad_minima, edad_maxima, requiere_comprobante }
 */
function calcularDescuentos({ personas = [], adicionalesCentavos = 0, reglas = [] }) {
  const personasNormalizadas = personas.map((persona, indice) => {
    const finalCentavos = Number(persona.final_centavos);
    const listaCentavosRaw = Number(persona.lista_centavos);
    const listaCentavos = Number.isSafeInteger(listaCentavosRaw) && listaCentavosRaw >= finalCentavos
      ? listaCentavosRaw
      : finalCentavos;
    if (!Number.isSafeInteger(finalCentavos) || finalCentavos < 0) {
      throw crearError(`El importe de la persona ${indice + 1} no es válido`, 409, "DESCUENTO_IMPORTE_INVALIDO");
    }
    const edad = persona.edad === null || persona.edad === undefined ? null : Number(persona.edad);
    return {
      indice,
      tipo_persona_id: normalizarIdPositivo(persona.tipo_persona_id),
      edad: Number.isInteger(edad) && edad >= 0 ? edad : null,
      final_centavos: finalCentavos,
      lista_centavos: listaCentavos,
    };
  });
  const adicionales = Number.isSafeInteger(Number(adicionalesCentavos)) && Number(adicionalesCentavos) > 0
    ? Number(adicionalesCentavos)
    : 0;
  const totalFinalCentavos = sumarCentavos(
    ...personasNormalizadas.map((persona) => persona.final_centavos),
    adicionales
  );
  if (totalFinalCentavos === null) {
    throw crearError("El total de la reserva no es válido", 409, "DESCUENTO_TOTAL_INVALIDO");
  }

  const items = [];
  for (const regla of reglas) {
    if (!regla) continue;
    const puntosBase = decimalAPuntosBase(regla.porcentaje);
    if (puntosBase === null) {
      throw crearError(`El porcentaje del descuento ${regla.nombre || regla.codigo} no es válido`, 409, "DESCUENTO_PORCENTAJE_INVALIDO");
    }
    const filtraPersonas = filtraPorPersona(regla);
    const alcanzadas = personasNormalizadas.filter((persona) => personaAlcanzada(regla, persona));
    const usaLista = regla.base_calculo === "PRECIO_LISTA";
    let baseCentavos = 0;
    let topeCentavos = 0;
    let descuentoPersonasCentavos = 0;
    const detallePersonas = [];
    for (const persona of alcanzadas) {
      const basePersona = usaLista ? persona.lista_centavos : persona.final_centavos;
      // Tope por persona: nunca más de lo que esa persona paga
      const descuentoPersona = descuentoSobre(basePersona, puntosBase, persona.final_centavos);
      baseCentavos = sumarCentavos(baseCentavos, basePersona);
      topeCentavos = sumarCentavos(topeCentavos, persona.final_centavos);
      descuentoPersonasCentavos = sumarCentavos(descuentoPersonasCentavos, descuentoPersona);
      detallePersonas.push({
        indice: persona.indice,
        tipo_persona_id: persona.tipo_persona_id,
        edad: persona.edad,
        base: centavosANumero(basePersona),
        descuento: centavosANumero(descuentoPersona),
      });
    }
    let adicionalesEnBase = 0;
    if (esVerdadero(regla.incluye_adicionales) && !filtraPersonas && adicionales > 0) {
      adicionalesEnBase = adicionales;
      baseCentavos = sumarCentavos(baseCentavos, adicionales);
      topeCentavos = sumarCentavos(topeCentavos, adicionales);
    }
    if (baseCentavos === null || topeCentavos === null || descuentoPersonasCentavos === null) {
      throw crearError("La base del descuento excede el máximo permitido", 409, "DESCUENTO_TOTAL_INVALIDO");
    }
    // El importe se arma persona por persona (cada una con su tope) más la parte
    // de adicionales, así el desglose y el importe persistido siempre coinciden.
    const descuentoCentavos = sumarCentavos(
      descuentoPersonasCentavos,
      adicionalesEnBase > 0 ? descuentoSobre(adicionalesEnBase, puntosBase, adicionalesEnBase) : 0
    );
    if (descuentoCentavos === null) {
      throw crearError("El descuento excede el máximo permitido", 409, "DESCUENTO_TOTAL_INVALIDO");
    }

    items.push({
      regla_id: regla.id || null,
      tipo: regla.tipo,
      codigo: regla.codigo,
      nombre: regla.nombre,
      descripcion: regla.descripcion || null,
      porcentaje: puntosBase / 100,
      base_calculo: regla.base_calculo,
      incluye_adicionales: esVerdadero(regla.incluye_adicionales) && !filtraPersonas,
      acumulable: esVerdadero(regla.acumulable),
      requiere_comprobante: esVerdadero(regla.requiere_comprobante),
      alcance_persona: regla.alcance_persona || "TODAS",
      tipos_persona: Array.isArray(regla.tipos_persona) ? regla.tipos_persona.map(Number) : [],
      edad_minima: regla.edad_minima ?? null,
      edad_maxima: regla.edad_maxima ?? null,
      personas_alcanzadas: alcanzadas.length,
      base_centavos: baseCentavos,
      descuento_centavos: descuentoCentavos,
      importe_base: centavosANumero(baseCentavos),
      importe_descuento: centavosANumero(descuentoCentavos),
      detalle: { personas: detallePersonas, adicionales: centavosANumero(adicionalesEnBase) },
      aplicado: descuentoCentavos > 0,
      motivo_no_aplicado: descuentoCentavos > 0
        ? null
        : (alcanzadas.length === 0 && adicionalesEnBase === 0
          ? "Ninguna persona de la reserva está alcanzada por este descuento"
          : "El descuento no genera una rebaja sobre esta reserva"),
    });
  }

  // Combinación cupón + tipo de viaje
  const conRebaja = items.filter((item) => item.descuento_centavos > 0);
  let aplicados = conRebaja;
  if (conRebaja.length > 1) {
    const todosAcumulables = conRebaja.every((item) => item.acumulable);
    if (!todosAcumulables) {
      const ordenados = [...conRebaja].sort((a, b) => {
        if (b.descuento_centavos !== a.descuento_centavos) return b.descuento_centavos - a.descuento_centavos;
        return a.tipo === "TIPO_VIAJE" ? -1 : 1;
      });
      aplicados = [ordenados[0]];
      for (const descartado of ordenados.slice(1)) {
        descartado.aplicado = false;
        descartado.motivo_no_aplicado = `No es acumulable: se aplicó ${ordenados[0].tipo === "CUPON" ? "el cupón" : "el tipo de viaje"} ${ordenados[0].nombre}, que conviene más`;
      }
    }
  }

  // Tope global: nunca por debajo de $0
  let totalDescuentoCentavos = 0;
  for (const item of aplicados) {
    const restante = totalFinalCentavos - totalDescuentoCentavos;
    if (item.descuento_centavos > restante) {
      item.descuento_centavos = Math.max(0, restante);
      item.importe_descuento = centavosANumero(item.descuento_centavos);
      item.recortado = true;
    }
    if (item.descuento_centavos === 0) {
      // El otro descuento ya dejó la reserva en $0: este no aporta nada
      item.aplicado = false;
      item.motivo_no_aplicado = "La reserva ya quedó en $0 con el otro descuento";
    }
    totalDescuentoCentavos = sumarCentavos(totalDescuentoCentavos, item.descuento_centavos);
  }

  return {
    items,
    aplicados: aplicados.filter((item) => item.descuento_centavos > 0),
    total_descuento_centavos: totalDescuentoCentavos,
    total_descuento: centavosANumero(totalDescuentoCentavos),
    total_antes_centavos: totalFinalCentavos,
    total_antes: centavosANumero(totalFinalCentavos),
    total_final_centavos: totalFinalCentavos - totalDescuentoCentavos,
    total_final: centavosANumero(totalFinalCentavos - totalDescuentoCentavos),
  };
}

function descuentoSobre(baseCentavos, puntosBase, topeCentavos) {
  if (!Number.isSafeInteger(baseCentavos) || baseCentavos <= 0) return 0;
  const conDescuento = aplicarDescuentoEnPuntosBase(baseCentavos, puntosBase);
  if (conDescuento === null) {
    throw crearError("No se pudo calcular el descuento", 409, "DESCUENTO_CALCULO_INVALIDO");
  }
  const descuento = baseCentavos - conDescuento;
  const tope = Number.isSafeInteger(topeCentavos) ? Math.max(0, topeCentavos) : descuento;
  return Math.min(descuento, tope);
}

function filtraPorPersona(regla) {
  const porTipo = regla.alcance_persona === "SELECCIONADAS";
  const porEdad = regla.edad_minima !== null && regla.edad_minima !== undefined
    || regla.edad_maxima !== null && regla.edad_maxima !== undefined;
  return porTipo || Boolean(porEdad);
}

function personaAlcanzada(regla, persona) {
  if (regla.alcance_persona === "SELECCIONADAS") {
    const tipos = Array.isArray(regla.tipos_persona) ? regla.tipos_persona.map(Number) : [];
    if (!persona.tipo_persona_id || !tipos.includes(Number(persona.tipo_persona_id))) return false;
  }
  const minima = regla.edad_minima === null || regla.edad_minima === undefined ? null : Number(regla.edad_minima);
  const maxima = regla.edad_maxima === null || regla.edad_maxima === undefined ? null : Number(regla.edad_maxima);
  if (minima !== null || maxima !== null) {
    if (persona.edad === null) return false;
    if (minima !== null && persona.edad < minima) return false;
    if (maxima !== null && persona.edad > maxima) return false;
  }
  return true;
}

/** Adapta el resultado de calcularTarifaBaseReserva al formato del cálculo. */
function construirPersonasParaDescuento(personasCotizadas = []) {
  return personasCotizadas.map((persona) => ({
    tipo_persona_id: persona.tipo_persona_id,
    edad: persona.edad,
    final_centavos: decimalACentavos(persona.tarifa_individual) ?? 0,
    lista_centavos: decimalACentavos(persona.tarifa_original_individual ?? persona.tarifa_individual) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Acceso a reglas
// ---------------------------------------------------------------------------

const SQL_REGLA_BASE = `
  SELECT r.*
    FROM descuento_regla r
   WHERE r.eliminado = 0`;

async function cargarDetalleReglas(db, reglas) {
  if (!reglas.length) return reglas;
  const ids = reglas.map((regla) => Number(regla.id));
  const placeholders = ids.map(() => "?").join(",");
  const [departamentales] = await db.query(
    `SELECT rd.regla_id, rd.departamental_id, rd.habilitado, rd.porcentaje_descuento, d.nombre AS departamental_nombre
       FROM descuento_regla_departamental rd
       LEFT JOIN departamental d ON d.id = rd.departamental_id
      WHERE rd.regla_id IN (${placeholders})
      ORDER BY d.nombre`,
    ids
  );
  const [servicios] = await db.query(
    `SELECT rs.regla_id, rs.servicio_id, s.nombre AS servicio_nombre
       FROM descuento_regla_servicio rs
       LEFT JOIN servicio s ON s.id = rs.servicio_id
      WHERE rs.regla_id IN (${placeholders})
      ORDER BY s.nombre`,
    ids
  );
  const [tiposPersona] = await db.query(
    `SELECT rt.regla_id, rt.tipo_persona_id, tp.nombre AS tipo_persona_nombre
       FROM descuento_regla_tipo_persona rt
       LEFT JOIN tipo_persona tp ON tp.id = rt.tipo_persona_id
      WHERE rt.regla_id IN (${placeholders})
      ORDER BY tp.id`,
    ids
  );
  const porRegla = new Map(reglas.map((regla) => [Number(regla.id), {
    ...regla,
    departamentales: [],
    servicios: [],
    tipos_persona: [],
    tipos_persona_detalle: [],
  }]));
  for (const fila of departamentales) {
    porRegla.get(Number(fila.regla_id))?.departamentales.push({
      departamental_id: Number(fila.departamental_id),
      nombre: fila.departamental_nombre,
      habilitado: Number(fila.habilitado) === 1,
      porcentaje_descuento: fila.porcentaje_descuento === null ? null : Number(fila.porcentaje_descuento),
    });
  }
  for (const fila of servicios) {
    porRegla.get(Number(fila.regla_id))?.servicios.push({ servicio_id: Number(fila.servicio_id), nombre: fila.servicio_nombre });
  }
  for (const fila of tiposPersona) {
    const regla = porRegla.get(Number(fila.regla_id));
    if (!regla) continue;
    regla.tipos_persona.push(Number(fila.tipo_persona_id));
    regla.tipos_persona_detalle.push({ tipo_persona_id: Number(fila.tipo_persona_id), nombre: fila.tipo_persona_nombre });
  }
  return reglas.map((regla) => porRegla.get(Number(regla.id)));
}

async function obtenerReglaPorId(db, reglaId, { incluirEliminadas = false } = {}) {
  const id = normalizarIdPositivo(reglaId);
  if (!id) return null;
  const [rows] = await db.query(
    `SELECT r.* FROM descuento_regla r WHERE r.id = ?${incluirEliminadas ? "" : " AND r.eliminado = 0"} LIMIT 1`,
    [id]
  );
  if (!rows.length) return null;
  const [regla] = await cargarDetalleReglas(db, rows);
  return regla;
}

async function obtenerReglaPorCodigo(db, tipo, codigo) {
  if (!TIPOS_REGLA.includes(tipo) || !codigo) return null;
  const [rows] = await db.query(
    `${SQL_REGLA_BASE} AND r.tipo = ? AND r.codigo = ? LIMIT 1`,
    [tipo, codigo]
  );
  if (!rows.length) return null;
  const [regla] = await cargarDetalleReglas(db, rows);
  return regla;
}

async function contarUsosRegla(db, reglaId, { usuarioId = null, excluirReservaId = null } = {}) {
  const params = [reglaId, ...ESTADOS_RESERVA_NO_CONSUMEN];
  let sql = `
    SELECT COUNT(*) AS total
      FROM reserva_descuento rd
      INNER JOIN reserva r ON r.id = rd.reserva_id
      LEFT JOIN estado_reserva er ON er.id = r.estado_reserva_id
     WHERE rd.regla_id = ?
       AND COALESCE(er.nombre, '') NOT IN (${ESTADOS_RESERVA_NO_CONSUMEN.map(() => "?").join(",")})`;
  if (usuarioId) {
    sql += " AND rd.usuario_id = ?";
    params.push(usuarioId);
  }
  if (excluirReservaId) {
    sql += " AND rd.reserva_id <> ?";
    params.push(excluirReservaId);
  }
  const [[fila]] = await db.query(sql, params);
  return Number(fila.total || 0);
}

/**
 * Evalúa si una regla aplica a un contexto (departamental del titular,
 * servicio, fecha de hoy y cupos de uso). Devuelve el porcentaje efectivo,
 * que puede estar sobreescrito por departamental.
 */
async function evaluarReglaParaContexto(db, regla, {
  departamentalId = null,
  servicioId = null,
  usuarioId = null,
  excluirReservaId = null,
  hoy = obtenerFechaCivilArgentina(),
  permitirOcultas = true,
  bloquear = false,
} = {}) {
  if (!regla || Number(regla.eliminado) === 1) {
    return { aplicable: false, motivo: "El descuento no existe", codigo: "DESCUENTO_INEXISTENTE" };
  }
  if (Number(regla.habilitado) !== 1) {
    return { aplicable: false, motivo: "El descuento está deshabilitado", codigo: "DESCUENTO_DESHABILITADO" };
  }
  if (!permitirOcultas && Number(regla.oculto) === 1) {
    return { aplicable: false, motivo: "El descuento no está disponible", codigo: "DESCUENTO_OCULTO" };
  }
  const desde = regla.vigencia_desde ? String(regla.vigencia_desde).slice(0, 10) : null;
  const hasta = regla.vigencia_hasta ? String(regla.vigencia_hasta).slice(0, 10) : null;
  if (desde && hoy < desde) {
    return { aplicable: false, motivo: `El descuento estará vigente desde el ${formatearFecha(desde)}`, codigo: "DESCUENTO_NO_VIGENTE" };
  }
  if (hasta && hoy > hasta) {
    return { aplicable: false, motivo: `El descuento venció el ${formatearFecha(hasta)}`, codigo: "DESCUENTO_VENCIDO" };
  }
  if (regla.alcance_servicio === "SELECCIONADOS") {
    const servicios = (regla.servicios || []).map((item) => Number(item.servicio_id));
    if (!servicioId || !servicios.includes(Number(servicioId))) {
      return { aplicable: false, motivo: "El descuento no aplica a este servicio", codigo: "DESCUENTO_SERVICIO_NO_ALCANZADO" };
    }
  }
  let porcentaje = Number(regla.porcentaje_descuento);
  const configuracionDepartamental = (regla.departamentales || []).find(
    (item) => Number(item.departamental_id) === Number(departamentalId)
  );
  if (regla.alcance_departamental === "SELECCIONADAS") {
    if (!configuracionDepartamental || !configuracionDepartamental.habilitado) {
      return { aplicable: false, motivo: "El descuento no está habilitado para tu departamental", codigo: "DESCUENTO_DEPARTAMENTAL_NO_ALCANZADA" };
    }
  } else if (configuracionDepartamental && !configuracionDepartamental.habilitado) {
    return { aplicable: false, motivo: "El descuento no está habilitado para tu departamental", codigo: "DESCUENTO_DEPARTAMENTAL_NO_ALCANZADA" };
  }
  if (configuracionDepartamental && configuracionDepartamental.porcentaje_descuento !== null) {
    porcentaje = Number(configuracionDepartamental.porcentaje_descuento);
  }
  const tieneLimiteUsos = (regla.usos_maximos !== null && regla.usos_maximos !== undefined)
    || (regla.usos_por_afiliado !== null && regla.usos_por_afiliado !== undefined);
  if (tieneLimiteUsos && bloquear) {
    // Dentro de la transacción del alta: serializa el conteo de usos entre altas concurrentes
    await db.query("SELECT id FROM descuento_regla WHERE id = ? FOR UPDATE", [regla.id]);
  }
  if (regla.usos_maximos !== null && regla.usos_maximos !== undefined) {
    const usos = await contarUsosRegla(db, regla.id, { excluirReservaId });
    if (usos >= Number(regla.usos_maximos)) {
      return { aplicable: false, motivo: "El descuento agotó su cantidad de usos", codigo: "DESCUENTO_AGOTADO" };
    }
  }
  if (regla.usos_por_afiliado !== null && regla.usos_por_afiliado !== undefined && usuarioId) {
    const usosAfiliado = await contarUsosRegla(db, regla.id, { usuarioId, excluirReservaId });
    if (usosAfiliado >= Number(regla.usos_por_afiliado)) {
      return { aplicable: false, motivo: "Ya usaste este descuento la cantidad máxima de veces", codigo: "DESCUENTO_AGOTADO_AFILIADO" };
    }
  }
  return { aplicable: true, motivo: null, codigo: null, porcentaje };
}

function formatearFecha(fechaIso) {
  const [anio, mes, dia] = String(fechaIso).split("-");
  return `${dia}/${mes}/${anio}`;
}

/** Vista resumida de una regla para el afiliado (sin datos internos). */
function presentarReglaParaAfiliado(regla, porcentaje) {
  return {
    id: Number(regla.id),
    tipo: regla.tipo,
    codigo: regla.codigo,
    nombre: regla.nombre,
    descripcion: regla.descripcion || null,
    porcentaje: Number(porcentaje ?? regla.porcentaje_descuento),
    base_calculo: regla.base_calculo,
    incluye_adicionales: Number(regla.incluye_adicionales) === 1,
    acumulable: Number(regla.acumulable) === 1,
    requiere_comprobante: Number(regla.requiere_comprobante) === 1,
    alcance_persona: regla.alcance_persona,
    tipos_persona: (regla.tipos_persona_detalle || []).map((item) => item.nombre).filter(Boolean),
    edad_minima: regla.edad_minima === null || regla.edad_minima === undefined ? null : Number(regla.edad_minima),
    edad_maxima: regla.edad_maxima === null || regla.edad_maxima === undefined ? null : Number(regla.edad_maxima),
  };
}

/** Regla resuelta (con % efectivo) lista para calcularDescuentos. */
function reglaParaCalculo(regla, porcentaje) {
  return {
    id: Number(regla.id),
    tipo: regla.tipo,
    codigo: regla.codigo,
    nombre: regla.nombre,
    descripcion: regla.descripcion || null,
    porcentaje: Number(porcentaje ?? regla.porcentaje_descuento),
    base_calculo: regla.base_calculo,
    incluye_adicionales: Number(regla.incluye_adicionales) === 1,
    acumulable: Number(regla.acumulable) === 1,
    requiere_comprobante: Number(regla.requiere_comprobante) === 1,
    alcance_persona: regla.alcance_persona,
    tipos_persona: regla.tipos_persona || [],
    edad_minima: regla.edad_minima,
    edad_maxima: regla.edad_maxima,
  };
}

async function listarTiposViajeDisponibles(db, {
  departamentalId = null,
  servicioId = null,
  usuarioId = null,
  incluirOcultos = false,
} = {}) {
  const [rows] = await db.query(
    `${SQL_REGLA_BASE} AND r.tipo = 'TIPO_VIAJE' AND r.habilitado = 1${incluirOcultos ? "" : " AND r.oculto = 0"}
     ORDER BY r.orden ASC, r.nombre ASC`
  );
  const reglas = await cargarDetalleReglas(db, rows);
  const disponibles = [];
  for (const regla of reglas) {
    const evaluacion = await evaluarReglaParaContexto(db, regla, {
      departamentalId,
      servicioId,
      usuarioId,
      permitirOcultas: incluirOcultos,
    });
    if (evaluacion.aplicable) {
      disponibles.push(presentarReglaParaAfiliado(regla, evaluacion.porcentaje));
    }
  }
  return disponibles;
}

/**
 * Resuelve las reglas pedidas en una reserva (alta, edición o previsualización).
 * `existentes` son las filas actuales de reserva_descuento en una edición: si
 * el afiliado conserva la misma regla, se respeta el % ya aplicado aunque la
 * regla haya vencido después.
 */
async function resolverDescuentosSolicitados(db, {
  cuponCodigo = null,
  tipoViajeId = null,
  departamentalId = null,
  servicioId = null,
  usuarioId = null,
  excluirReservaId = null,
  esStaff = false,
  existentes = [],
  estricto = true,
  bloquearReglas = false,
} = {}) {
  const reglas = [];
  const rechazos = [];

  const codigoCupon = cuponCodigo === null || cuponCodigo === undefined || String(cuponCodigo).trim() === ""
    ? null
    : normalizarCodigoCupon(cuponCodigo);
  if (cuponCodigo && !codigoCupon) {
    if (estricto) throw crearError("El código del cupón no es válido", 400, "CUPON_INVALIDO");
    rechazos.push({ tipo: "CUPON", codigo: String(cuponCodigo), motivo: "El código del cupón no es válido" });
  }
  if (codigoCupon) {
    const existente = existentes.find((item) => item.tipo === "CUPON" && item.codigo === codigoCupon && item.regla_id);
    const regla = await obtenerReglaPorCodigo(db, "CUPON", codigoCupon);
    if (!regla) {
      if (existente) {
        reglas.push(reglaDesdeSnapshot(existente));
      } else if (estricto) {
        throw crearError("El cupón ingresado no existe", 404, "CUPON_INEXISTENTE");
      } else {
        rechazos.push({ tipo: "CUPON", codigo: codigoCupon, motivo: "El cupón ingresado no existe" });
      }
    } else {
      const evaluacion = await evaluarReglaParaContexto(db, regla, {
        departamentalId, servicioId, usuarioId, excluirReservaId, bloquear: bloquearReglas,
      });
      if (evaluacion.aplicable) {
        reglas.push(reglaParaCalculo(regla, evaluacion.porcentaje));
      } else if (existente && Number(existente.regla_id) === Number(regla.id)) {
        reglas.push(reglaDesdeSnapshot(existente, regla));
      } else if (estricto) {
        throw crearError(evaluacion.motivo, 422, evaluacion.codigo);
      } else {
        rechazos.push({ tipo: "CUPON", codigo: codigoCupon, nombre: regla.nombre, motivo: evaluacion.motivo });
      }
    }
  }

  const tipoViaje = normalizarIdPositivo(tipoViajeId);
  if (tipoViajeId !== null && tipoViajeId !== undefined && tipoViajeId !== "" && !tipoViaje) {
    if (estricto) throw crearError("El tipo de viaje no es válido", 400, "TIPO_VIAJE_INVALIDO");
    rechazos.push({ tipo: "TIPO_VIAJE", motivo: "El tipo de viaje no es válido" });
  }
  if (tipoViaje) {
    const existente = existentes.find((item) => item.tipo === "TIPO_VIAJE" && Number(item.regla_id) === tipoViaje);
    const regla = await obtenerReglaPorId(db, tipoViaje);
    if (!regla || regla.tipo !== "TIPO_VIAJE") {
      if (existente) {
        reglas.push(reglaDesdeSnapshot(existente));
      } else if (estricto) {
        throw crearError("El tipo de viaje no existe", 404, "TIPO_VIAJE_INEXISTENTE");
      } else {
        rechazos.push({ tipo: "TIPO_VIAJE", motivo: "El tipo de viaje no existe" });
      }
    } else {
      const evaluacion = await evaluarReglaParaContexto(db, regla, {
        departamentalId, servicioId, usuarioId, excluirReservaId, permitirOcultas: esStaff || Boolean(existente),
        bloquear: bloquearReglas,
      });
      if (evaluacion.aplicable) {
        reglas.push(reglaParaCalculo(regla, evaluacion.porcentaje));
      } else if (existente) {
        reglas.push(reglaDesdeSnapshot(existente, regla));
      } else if (estricto) {
        throw crearError(evaluacion.motivo, 422, evaluacion.codigo);
      } else {
        rechazos.push({ tipo: "TIPO_VIAJE", nombre: regla.nombre, motivo: evaluacion.motivo });
      }
    }
  }

  return { reglas, rechazos };
}

function reglaDesdeSnapshot(existente, regla = null) {
  const detalle = parsearJson(existente.detalle_json) || {};
  return {
    id: existente.regla_id ? Number(existente.regla_id) : null,
    tipo: existente.tipo,
    codigo: existente.codigo,
    nombre: existente.nombre,
    descripcion: regla?.descripcion || null,
    porcentaje: Number(existente.porcentaje_aplicado),
    base_calculo: existente.base_calculo,
    incluye_adicionales: regla ? Number(regla.incluye_adicionales) === 1 : Boolean(detalle.incluye_adicionales),
    acumulable: regla ? Number(regla.acumulable) === 1 : Boolean(detalle.acumulable),
    requiere_comprobante: Number(existente.requiere_comprobante) === 1,
    alcance_persona: regla?.alcance_persona || detalle.alcance_persona || "TODAS",
    tipos_persona: regla?.tipos_persona || detalle.tipos_persona || [],
    edad_minima: regla ? regla.edad_minima : (detalle.edad_minima ?? null),
    edad_maxima: regla ? regla.edad_maxima : (detalle.edad_maxima ?? null),
  };
}

function parsearJson(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "object") return valor;
  try {
    return JSON.parse(valor);
  } catch (_error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistencia en la reserva
// ---------------------------------------------------------------------------

async function registrarHistorialDescuento(connection, {
  reglaId = null,
  reservaId = null,
  servicioId = null,
  entidadTipo,
  entidadId = null,
  operacion,
  resumen,
  anterior = null,
  nuevo = null,
  usuarioId = null,
  req = null,
}) {
  await connection.query(
    `INSERT INTO descuento_historial
       (regla_id, reserva_id, servicio_id, entidad_tipo, entidad_id, operacion, resumen,
        valor_anterior, valor_nuevo, usuario_id, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reglaId,
      reservaId,
      servicioId,
      entidadTipo,
      entidadId,
      operacion,
      String(resumen || "").slice(0, 255),
      anterior === null || anterior === undefined ? null : JSON.stringify(anterior),
      nuevo === null || nuevo === undefined ? null : JSON.stringify(nuevo),
      usuarioId,
      String(req?.ip || req?.socket?.remoteAddress || "").slice(0, 64) || null,
      String(req?.get?.("User-Agent") || "").slice(0, 500) || null,
    ]
  );
}

async function obtenerDescuentosReservaCrudos(db, reservaId) {
  const [rows] = await db.query(
    `SELECT rd.*, (SELECT COUNT(*) FROM reserva_descuento_archivo a WHERE a.reserva_descuento_id = rd.id) AS comprobantes
       FROM reserva_descuento rd
      WHERE rd.reserva_id = ?
      ORDER BY FIELD(rd.tipo, 'TIPO_VIAJE', 'CUPON'), rd.id`,
    [reservaId]
  );
  return rows;
}

/**
 * Guarda (alta) o sincroniza (edición) las filas de reserva_descuento con el
 * resultado del cálculo. Conserva la fila (y sus comprobantes) cuando la
 * reserva mantiene el mismo tipo de descuento; elimina las que ya no aplican.
 */
async function guardarReservaDescuentos(connection, {
  reservaId,
  usuarioId,
  departamentalId = null,
  servicioId = null,
  resultado,
  actorId = null,
  req = null,
  registrarHistorialReserva = null,
  esAlta = false,
  eliminarArchivo = null,
}) {
  // En un alta la reserva recién se insertó: no hay filas previas que leer.
  if (esAlta && !(resultado?.aplicados || []).length) return [];
  const existentes = esAlta ? [] : await obtenerDescuentosReservaCrudos(connection, reservaId);
  const aplicados = resultado?.aplicados || [];
  const guardados = [];

  for (const item of aplicados) {
    const existente = existentes.find((fila) => fila.tipo === item.tipo);
    const detalleJson = JSON.stringify({
      ...item.detalle,
      incluye_adicionales: item.incluye_adicionales,
      acumulable: item.acumulable,
      alcance_persona: item.alcance_persona || "TODAS",
      tipos_persona: item.tipos_persona || [],
      edad_minima: item.edad_minima ?? null,
      edad_maxima: item.edad_maxima ?? null,
      recortado: Boolean(item.recortado),
    });
    if (existente) {
      await connection.query(
        `UPDATE reserva_descuento
            SET regla_id = ?, codigo = ?, nombre = ?, porcentaje_aplicado = ?, base_calculo = ?,
                importe_base = ?, importe_descuento = ?, servicio_id = ?, departamental_id = ?,
                requiere_comprobante = ?, detalle_json = ?, aplicado_por_usuario_id = ?
          WHERE id = ?`,
        [
          item.regla_id, item.codigo, item.nombre, item.porcentaje, item.base_calculo,
          item.importe_base, item.importe_descuento, servicioId, departamentalId,
          item.requiere_comprobante ? 1 : 0, detalleJson, actorId, existente.id,
        ]
      );
      const cambio = Number(existente.regla_id) !== Number(item.regla_id)
        || Number(existente.importe_descuento) !== Number(item.importe_descuento)
        || Number(existente.porcentaje_aplicado) !== Number(item.porcentaje);
      if (cambio) {
        const cambioDeRegla = Number(existente.regla_id) !== Number(item.regla_id);
        await registrarHistorialDescuento(connection, {
          reglaId: item.regla_id, reservaId, servicioId, entidadTipo: "USO", entidadId: existente.id,
          operacion: "UPDATE",
          resumen: cambioDeRegla
            ? `Reserva #${reservaId}: ${etiquetaTipo(item.tipo)} cambiado de ${existente.nombre} a ${item.nombre} (${item.porcentaje}% → $${item.importe_descuento})`
            : `Reserva #${reservaId}: ${etiquetaTipo(item.tipo)} ${item.nombre} recalculado (${item.porcentaje}% → $${item.importe_descuento})`,
          anterior: snapshotUso(existente), nuevo: snapshotUso({ ...item, id: existente.id }), usuarioId: actorId, req,
        });
        if (registrarHistorialReserva) {
          await registrarHistorialReserva([{
            campo: `Descuento (${etiquetaTipo(item.tipo)})`,
            valorAnterior: `${existente.nombre} · ${Number(existente.porcentaje_aplicado)}% · $${Number(existente.importe_descuento)}`,
            valorNuevo: `${item.nombre} · ${item.porcentaje}% · $${item.importe_descuento}`,
          }], "Descuento recalculado al editar la reserva");
        }
      }
      guardados.push({ id: Number(existente.id), tipo: item.tipo, regla_id: item.regla_id, codigo: item.codigo, nombre: item.nombre, requiere_comprobante: item.requiere_comprobante, importe_descuento: item.importe_descuento });
    } else {
      const [insercion] = await connection.query(
        `INSERT INTO reserva_descuento
           (reserva_id, regla_id, tipo, codigo, nombre, porcentaje_aplicado, base_calculo,
            importe_base, importe_descuento, usuario_id, departamental_id, servicio_id,
            requiere_comprobante, detalle_json, aplicado_por_usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reservaId, item.regla_id, item.tipo, item.codigo, item.nombre, item.porcentaje, item.base_calculo,
          item.importe_base, item.importe_descuento, usuarioId, departamentalId, servicioId,
          item.requiere_comprobante ? 1 : 0, detalleJson, actorId,
        ]
      );
      await registrarHistorialDescuento(connection, {
        reglaId: item.regla_id, reservaId, servicioId, entidadTipo: "USO", entidadId: insercion.insertId,
        operacion: "CREATE",
        resumen: `Reserva #${reservaId}: ${etiquetaTipo(item.tipo)} ${item.nombre} aplicado (${item.porcentaje}% sobre ${item.base_calculo === "PRECIO_LISTA" ? "precio de lista" : "precio final"} → $${item.importe_descuento})`,
        nuevo: snapshotUso({ ...item, id: insercion.insertId }), usuarioId: actorId, req,
      });
      if (registrarHistorialReserva) {
        await registrarHistorialReserva([{
          campo: `Descuento (${etiquetaTipo(item.tipo)})`,
          valorAnterior: null,
          valorNuevo: `${item.nombre} · ${item.porcentaje}% · $${item.importe_descuento}`,
        }], `Descuento aplicado: ${item.tipo === "CUPON" ? "#" + item.codigo : item.nombre}`);
      }
      guardados.push({ id: Number(insercion.insertId), tipo: item.tipo, regla_id: item.regla_id, codigo: item.codigo, nombre: item.nombre, requiere_comprobante: item.requiere_comprobante, importe_descuento: item.importe_descuento });
    }
  }

  for (const existente of existentes) {
    if (aplicados.some((item) => item.tipo === existente.tipo)) continue;
    // Los comprobantes de un descuento que se quita dejan de tener sentido:
    // se borran de la base (cascade) y, best-effort, de S3.
    const [archivosHuerfanos] = await connection.query(
      "SELECT archivo FROM reserva_descuento_archivo WHERE reserva_descuento_id = ?",
      [existente.id]
    );
    await connection.query("DELETE FROM reserva_descuento WHERE id = ?", [existente.id]);
    if (eliminarArchivo) {
      for (const archivo of archivosHuerfanos) {
        try {
          await eliminarArchivo(archivo.archivo);
        } catch (_error) {
          // La fila ya no existe; un objeto huérfano en S3 no bloquea la edición.
        }
      }
    }
    await registrarHistorialDescuento(connection, {
      reglaId: existente.regla_id, reservaId, servicioId, entidadTipo: "USO", entidadId: existente.id,
      operacion: "DELETE",
      resumen: `Reserva #${reservaId}: se quitó ${etiquetaTipo(existente.tipo)} ${existente.nombre}`,
      anterior: snapshotUso(existente), usuarioId: actorId, req,
    });
    if (registrarHistorialReserva) {
      await registrarHistorialReserva([{
        campo: `Descuento (${etiquetaTipo(existente.tipo)})`,
        valorAnterior: `${existente.nombre} · ${Number(existente.porcentaje_aplicado)}% · $${Number(existente.importe_descuento)}`,
        valorNuevo: null,
      }], "Descuento quitado al editar la reserva");
    }
  }

  return guardados;
}

function snapshotUso(fila) {
  return {
    id: fila.id ? Number(fila.id) : null,
    regla_id: fila.regla_id ? Number(fila.regla_id) : null,
    tipo: fila.tipo,
    codigo: fila.codigo,
    nombre: fila.nombre,
    porcentaje: Number(fila.porcentaje_aplicado ?? fila.porcentaje),
    base_calculo: fila.base_calculo,
    importe_base: Number(fila.importe_base),
    importe_descuento: Number(fila.importe_descuento),
  };
}

function etiquetaTipo(tipo) {
  return tipo === "CUPON" ? "cupón" : "tipo de viaje";
}

/**
 * Descuentos de una reserva para el detalle/edición, con comprobantes firmados.
 * `firmarArchivo(key)` debe devolver una URL o null.
 */
async function obtenerDescuentosReserva(db, reservaId, { firmarArchivo = null } = {}) {
  const filas = await obtenerDescuentosReservaCrudos(db, reservaId);
  if (!filas.length) return [];
  const ids = filas.map((fila) => Number(fila.id));
  const [archivos] = await db.query(
    `SELECT a.id, a.reserva_descuento_id, a.archivo, a.nombre_original, a.mime, a.tamanio, a.fecha_creacion,
            a.subido_por_usuario_id, CONCAT(u.nombre, ' ', u.apellido) AS subido_por_nombre
       FROM reserva_descuento_archivo a
       LEFT JOIN usuario u ON u.id = a.subido_por_usuario_id
      WHERE a.reserva_descuento_id IN (${ids.map(() => "?").join(",")})
      ORDER BY a.id`,
    ids
  );
  const archivosPorDescuento = new Map();
  for (const archivo of archivos) {
    let url = null;
    if (firmarArchivo) {
      try {
        url = await firmarArchivo(archivo.archivo);
      } catch (_error) {
        url = null;
      }
    }
    const lista = archivosPorDescuento.get(Number(archivo.reserva_descuento_id)) || [];
    lista.push({
      id: Number(archivo.id),
      nombre_original: archivo.nombre_original,
      mime: archivo.mime,
      tamanio: archivo.tamanio === null ? null : Number(archivo.tamanio),
      fecha_creacion: archivo.fecha_creacion,
      subido_por_usuario_id: archivo.subido_por_usuario_id,
      subido_por_nombre: archivo.subido_por_nombre,
      url,
    });
    archivosPorDescuento.set(Number(archivo.reserva_descuento_id), lista);
  }
  return filas.map((fila) => ({
    id: Number(fila.id),
    regla_id: fila.regla_id ? Number(fila.regla_id) : null,
    tipo: fila.tipo,
    codigo: fila.codigo,
    nombre: fila.nombre,
    porcentaje_aplicado: Number(fila.porcentaje_aplicado),
    base_calculo: fila.base_calculo,
    importe_base: Number(fila.importe_base),
    importe_descuento: Number(fila.importe_descuento),
    requiere_comprobante: Number(fila.requiere_comprobante) === 1,
    detalle: parsearJson(fila.detalle_json),
    fecha_creacion: fila.fecha_creacion,
    archivos: archivosPorDescuento.get(Number(fila.id)) || [],
  }));
}

module.exports = {
  ALCANCES_DEPARTAMENTAL,
  ALCANCES_PERSONA,
  ALCANCES_SERVICIO,
  BASES_CALCULO,
  ESTADOS_RESERVA_NO_CONSUMEN,
  TIPOS_REGLA,
  calcularDescuentos,
  cargarDetalleReglas,
  construirPersonasParaDescuento,
  contarUsosRegla,
  crearError,
  evaluarReglaParaContexto,
  guardarReservaDescuentos,
  listarTiposViajeDisponibles,
  normalizarCodigoCupon,
  normalizarCodigoTipoViaje,
  obtenerDescuentosReserva,
  obtenerDescuentosReservaCrudos,
  obtenerReglaPorCodigo,
  obtenerReglaPorId,
  presentarReglaParaAfiliado,
  reglaParaCalculo,
  registrarHistorialDescuento,
  resolverDescuentosSolicitados,
};
