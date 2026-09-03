/**
 * Bonos contribución del módulo Olimpiadas: reglas de la edición, bloques de numeración por
 * departamental, grilla/buscador/ventas, premios y sorteo.
 *
 * Reglas de negocio (SPEC-OLIMPIADAS-V2 §1.4 a §1.7):
 *  - La edición emite los números `bono_numero_desde..bono_numero_hasta`. La administración provincial
 *    (admin, admin-central) reparte esa numeración en bloques por departamental; un número sin bloque
 *    está "sin asignar" y no se puede vender.
 *  - Sólo existen filas en `olimpiada_bono` para números vendidos. Anular = borrar la fila; la venta y
 *    la anulación quedan en `olimpiada_historial` (entidad BONO).
 *  - Cada departamental vende/anula únicamente dentro de sus bloques y nunca ve compradores ajenos.
 *  - Las ventas se serializan con FOR UPDATE sobre la fila de la olimpiada; la UNIQUE
 *    (olimpiada_id, numero) es la última barrera (ER_DUP_ENTRY → 409).
 *  - El sorteo cruza los números ganadores cargados con los bonos vendidos (`calcularGanadores`);
 *    los afiliados ven los resultados sólo con `sorteo_publicado = 1`.
 */
const express = require("express");
const mysqlConnection = require("../connection/connection");
const { normalizarFechaCivil } = require("../services/valores-dominio");
const {
  verifyToken,
  getCabecera,
  esStaff,
  esSuperior,
  departamentalDe,
  puedeVerInscripcion,
  crearErrorHttp,
  responderError,
  normalizarTexto,
  normalizarIdPositivo,
  normalizarEnteroNoNegativo,
  normalizarMonto,
  normalizarBooleano01,
  SQL_ESTADOS_ACTIVOS,
  registrarHistorial,
  insertarNotificacion,
  notificarInscriptosOlimpiada,
  obtenerOlimpiada,
  calcularBonosAcompaniante,
  validarTramos,
  digitosBono,
  formatearNumeroBono,
  parsearNumerosBono,
  bloquesSeSolapan,
  bloqueDeNumero,
  calcularGanadores,
  resumenBonosInscripcion,
} = require("../services/olimpiadas-comun");

const router = express.Router();
const db = mysqlConnection.promise();

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const MAX_NUMERO_BONO = 999999;
const MAX_BONOS_AFILIADO = 999;
const MAX_NUMEROS_POR_OPERACION = 500;
const MAX_CANTIDAD_AUTOMATICA = 200;
const MAX_PREMIOS = 200;
const MAX_VENTANA_GRILLA = 500;
const VENTANA_GRILLA_DEFAULT = 100;
const MAX_RESULTADOS_BUSQUEDA = 100;
const MAX_FILAS_CSV = 50000;
const MAX_LARGO_BUSQUEDA = 80;
const MAX_TEXTO_IMPORTACION = 100000;
const MAX_LARGO_DESCRIPCION_PREMIO = 600;

const COLUMNAS_ORDEN_VENDIDOS = Object.freeze({
  numero: "b.numero",
  fecha_venta: "b.fecha_venta",
  comprador_nombre: "b.comprador_nombre",
  departamental: "d.nombre",
});

const COLUMNAS_CSV = Object.freeze([
  "Número",
  "Comprador",
  "DNI",
  "Email",
  "Teléfono",
  "Departamental",
  "A nombre de la departamental",
  "Inscripción",
  "Afiliado",
  "Fecha de venta",
  "Observación",
]);

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const DOCUMENTO_RE = /^[0-9A-Za-z.\-/ ]{1,20}$/;
// "1º ", "1ª ", "2° ", "3. ", "4) ", "5- ", "6– " al inicio de una línea de premios.
const PREFIJO_PREMIO_CON_MARCA_RE = /^\s*\d+\s*[ºª°.)\-–]+\s*/;
const PREFIJO_PREMIO_SOLO_NUMERO_RE = /^\s*(\d+)[\t ]+/;

// ---------------------------------------------------------------------------
// Helpers puros (exportados en router.__test)
// ---------------------------------------------------------------------------
function rangoDeOlimpiada(olimpiada) {
  return {
    desde: Number(olimpiada?.bono_numero_desde) || 0,
    hasta: Number(olimpiada?.bono_numero_hasta) || 0,
  };
}

// Formato visible de un número cuando todavía no hay olimpiada a mano: mínimo 4 dígitos.
function padNumero(numero, hasta) {
  return String(numero).padStart(Math.max(4, String(Number(hasta) || 0).length), "0");
}

function textoRango(desde, hasta, olimpiada) {
  return `${formatearNumeroBono(desde, olimpiada)}–${formatearNumeroBono(hasta, olimpiada)}`;
}

function ordenarBloques(bloques) {
  return [...(bloques || [])].sort(
    (a, b) => Number(a.numero_desde) - Number(b.numero_desde) || Number(a.id || 0) - Number(b.id || 0)
  );
}

/**
 * Modo automático: los primeros `cantidad` números libres recorriendo los bloques en orden.
 * Devuelve un array (puede ser más corto que `cantidad` si no alcanzan los disponibles).
 */
function elegirNumerosLibres(bloques, vendidosSet, cantidad) {
  const objetivo = Math.max(0, Math.trunc(Number(cantidad) || 0));
  const vendidos = vendidosSet instanceof Set ? vendidosSet : new Set((vendidosSet || []).map(Number));
  const elegidos = [];
  for (const bloque of ordenarBloques(bloques)) {
    const desde = Number(bloque.numero_desde);
    const hasta = Number(bloque.numero_hasta);
    for (let numero = desde; numero <= hasta && elegidos.length < objetivo; numero += 1) {
      if (!vendidos.has(numero)) elegidos.push(numero);
    }
    if (elegidos.length >= objetivo) break;
  }
  return elegidos;
}

/**
 * Valida un bloque (alta o edición) contra el rango de la edición y los demás bloques.
 * Devuelve { value } o { error, status }.
 */
function validarBloque(datos, { olimpiada, bloques = [], bloqueId = null } = {}) {
  const entrada = datos || {};
  const departamentalId = normalizarIdPositivo(entrada.departamental_id);
  if (!departamentalId) return { error: "Elegí la departamental a la que se le asigna el bloque", status: 400 };
  const desde = normalizarEnteroNoNegativo(entrada.numero_desde);
  const hasta = normalizarEnteroNoNegativo(entrada.numero_hasta);
  if (desde === null || hasta === null) return { error: "Los números desde y hasta del bloque deben ser enteros", status: 400 };
  if (hasta < desde) return { error: "El número hasta no puede ser menor que el número desde", status: 400 };
  const rango = rangoDeOlimpiada(olimpiada);
  if (desde < rango.desde || hasta > rango.hasta) {
    return {
      error: `El bloque tiene que estar dentro de la numeración de la edición (${padNumero(rango.desde, rango.hasta)}–${padNumero(rango.hasta, rango.hasta)})`,
      status: 400,
    };
  }
  if (entrada.observacion !== undefined && entrada.observacion !== null && typeof entrada.observacion !== "string") {
    return { error: "La observación del bloque es inválida", status: 400 };
  }
  const candidato = { numero_desde: desde, numero_hasta: hasta };
  for (const otro of bloques || []) {
    if (bloqueId && Number(otro.id) === Number(bloqueId)) continue;
    if (bloquesSeSolapan(candidato, otro)) {
      const duenia = otro.departamental_nombre ? ` de ${otro.departamental_nombre}` : "";
      return {
        error: `El rango se solapa con el bloque ${padNumero(otro.numero_desde, rango.hasta)}–${padNumero(otro.numero_hasta, rango.hasta)}${duenia}`,
        status: 409,
      };
    }
  }
  return {
    value: {
      departamental_id: departamentalId,
      numero_desde: desde,
      numero_hasta: hasta,
      observacion: normalizarTexto(entrada.observacion, 200),
    },
  };
}

// El nuevo rango de la edición no puede dejar afuera bloques ni bonos vendidos.
function validarRangoNumeracion(desde, hasta, { bloques = [], vendidosMin = null, vendidosMax = null } = {}) {
  if (hasta < desde) return { error: "El último número de la edición no puede ser menor que el primero", status: 400 };
  if (hasta > MAX_NUMERO_BONO) return { error: `La numeración puede llegar como máximo a ${MAX_NUMERO_BONO}`, status: 400 };
  const afuera = (bloques || []).find((b) => Number(b.numero_desde) < desde || Number(b.numero_hasta) > hasta);
  if (afuera) {
    const duenia = afuera.departamental_nombre ? ` de ${afuera.departamental_nombre}` : "";
    return {
      error: `El rango dejaría afuera el bloque ${padNumero(afuera.numero_desde, hasta)}–${padNumero(afuera.numero_hasta, hasta)}${duenia}. Ajustá o eliminá el bloque antes`,
      status: 409,
    };
  }
  if (vendidosMin !== null && vendidosMin !== undefined && (Number(vendidosMin) < desde || Number(vendidosMax) > hasta)) {
    return {
      error: `Hay bonos vendidos que quedarían fuera del nuevo rango (${padNumero(vendidosMin, hasta)}–${padNumero(vendidosMax, hasta)})`,
      status: 409,
    };
  }
  return { value: { desde, hasta } };
}

/**
 * Una línea = un premio. Se quita el prefijo de puesto ("1º", "2°", "3.", "4)", "5-") y, si la línea
 * arranca con el número de la posición sin marca ("3 Estadía…"), también. Un número que no coincide
 * con la posición se conserva ("2 pasajes a Brasil").
 */
function parsearPremios(texto) {
  const lineas = String(texto ?? "").split(/\r?\n/);
  const premios = [];
  for (const linea of lineas) {
    if (linea.trim().length === 0) continue;
    let descripcion = linea;
    const conMarca = PREFIJO_PREMIO_CON_MARCA_RE.exec(descripcion);
    if (conMarca) {
      descripcion = descripcion.slice(conMarca[0].length);
    } else {
      const soloNumero = PREFIJO_PREMIO_SOLO_NUMERO_RE.exec(descripcion);
      if (soloNumero && Number(soloNumero[1]) === premios.length + 1) descripcion = descripcion.slice(soloNumero[0].length);
    }
    descripcion = descripcion.trim();
    if (descripcion.length === 0) continue;
    premios.push(descripcion.slice(0, MAX_LARGO_DESCRIPCION_PREMIO));
  }
  return premios;
}

// "0460-0467, 0470 (9)": tramos consecutivos comprimidos + total.
function describirNumeros(numeros, olimpiada) {
  const lista = [...new Set((numeros || []).map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const tramos = [];
  let inicio = null;
  let previo = null;
  for (const numero of lista) {
    if (inicio === null) {
      inicio = numero;
      previo = numero;
      continue;
    }
    if (numero === previo + 1) {
      previo = numero;
      continue;
    }
    tramos.push([inicio, previo]);
    inicio = numero;
    previo = numero;
  }
  if (inicio !== null) tramos.push([inicio, previo]);
  const texto = tramos
    .map(([a, b]) => (a === b ? formatearNumeroBono(a, olimpiada) : `${formatearNumeroBono(a, olimpiada)}-${formatearNumeroBono(b, olimpiada)}`))
    .join(", ");
  return `${texto} (${lista.length})`;
}

function formatearFechaHora(valor) {
  if (!valor) return "";
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) return String(valor);
  const partes = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(fecha);
  const p = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// Escapa una celda para CSV con `;`. Neutraliza fórmulas (=, +, -, @) para que Excel no las ejecute.
function escaparCsv(valor) {
  if (valor === null || valor === undefined) return "";
  let texto = String(valor);
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  if (/[";\n\r]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

function armarCsvBonos(filas, olimpiada) {
  const lineas = [COLUMNAS_CSV.join(";")];
  for (const fila of filas || []) {
    lineas.push(
      [
        formatearNumeroBono(fila.numero, olimpiada),
        fila.comprador_nombre,
        fila.comprador_documento,
        fila.comprador_email,
        fila.comprador_telefono,
        fila.departamental_nombre,
        Number(fila.a_nombre_departamental) === 1 ? "Sí" : "No",
        fila.inscripcion_id ? `#${fila.inscripcion_id}` : "",
        fila.afiliado_apellido ? `${fila.afiliado_apellido}, ${fila.afiliado_nombre || ""}`.trim() : "",
        formatearFechaHora(fila.fecha_venta),
        fila.observacion,
      ]
        .map(escaparCsv)
        .join(";")
    );
  }
  // BOM explícito para que Excel abra el archivo como UTF-8 y respete acentos.
  return `﻿${lineas.join("\r\n")}\r\n`;
}

/**
 * Celda de la grilla / tarjeta del buscador para un número. La departamental sólo ve el detalle del
 * comprador en sus propios bloques: lo ajeno sale como AJENO sin `bono`.
 */
function clasificarNumero({ numero, bloque, bono, cabecera, olimpiada }) {
  const mia = departamentalDe(cabecera);
  const superior = esSuperior(cabecera);
  const duenia = bloque ? Number(bloque.departamental_id) : bono ? Number(bono.departamental_id) || null : null;
  const propio = superior || (duenia !== null && duenia === mia);
  const base = {
    numero,
    numero_texto: formatearNumeroBono(numero, olimpiada),
    departamental_id: duenia,
    departamental_nombre: bloque?.departamental_nombre || bono?.departamental_nombre || null,
  };
  if (!bloque && !bono) return { ...base, estado: "SIN_ASIGNAR", bono: null };
  if (!propio) return { ...base, estado: "AJENO", bono: null };
  if (bono) {
    return {
      ...base,
      estado: "VENDIDO",
      bono: {
        id: bono.id,
        comprador_nombre: bono.comprador_nombre,
        comprador_documento: bono.comprador_documento ?? null,
        inscripcion_id: bono.inscripcion_id ?? null,
        a_nombre_departamental: Number(bono.a_nombre_departamental) === 1 ? 1 : 0,
      },
    };
  }
  return { ...base, estado: "DISPONIBLE", bono: null };
}

function normalizarCamposComprador(body, { parcial = false } = {}) {
  const value = {};
  const campos = [
    ["comprador_nombre", 160],
    ["comprador_documento", 20],
    ["comprador_email", 120],
    ["comprador_telefono", 30],
  ];
  for (const [campo, maximo] of campos) {
    if (body[campo] === undefined) {
      if (!parcial) value[campo] = null;
      continue;
    }
    if (body[campo] !== null && typeof body[campo] !== "string" && typeof body[campo] !== "number") {
      return { error: `El campo ${campo} es inválido` };
    }
    value[campo] = body[campo] === null ? null : normalizarTexto(String(body[campo]), maximo);
  }
  if (value.comprador_email && !EMAIL_RE.test(value.comprador_email)) return { error: "El email del comprador no es válido" };
  if (value.comprador_documento && !DOCUMENTO_RE.test(value.comprador_documento)) {
    return { error: "El documento del comprador sólo admite números, letras, puntos y guiones" };
  }
  return { value };
}

function normalizarIdOpcional(valor, etiqueta) {
  if (valor === undefined || valor === null || valor === "") return { value: null };
  const id = normalizarIdPositivo(valor);
  if (!id) return { error: `${etiqueta} es inválida` };
  return { value: id };
}

/**
 * Body de POST /olimpiadas/:id/bonos → { value } | { error }. Exactamente uno de `numeros` o `cantidad`.
 */
function normalizarVenta(body) {
  const b = body || {};
  const tieneNumeros = Array.isArray(b.numeros)
    ? b.numeros.length > 0
    : b.numeros !== undefined && b.numeros !== null && String(b.numeros).trim() !== "";
  const tieneCantidad = b.cantidad !== undefined && b.cantidad !== null && String(b.cantidad).trim() !== "";
  if (tieneNumeros === tieneCantidad) {
    return { error: "Indicá los números a vender o la cantidad a asignar automáticamente (una de las dos opciones)" };
  }
  const datos = { numeros: null, cantidad: null };
  if (tieneNumeros) {
    const parseo = parsearNumerosBono(b.numeros, { maximo: MAX_NUMEROS_POR_OPERACION });
    if (parseo.error) return { error: parseo.error };
    datos.numeros = parseo.value;
  } else {
    const cantidad = normalizarIdPositivo(typeof b.cantidad === "number" ? b.cantidad : String(b.cantidad).trim());
    if (!cantidad || cantidad > MAX_CANTIDAD_AUTOMATICA) {
      return { error: `La cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD_AUTOMATICA}` };
    }
    datos.cantidad = cantidad;
  }
  const departamental = normalizarIdOpcional(b.departamental_id, "La departamental");
  if (departamental.error) return departamental;
  datos.departamental_id = departamental.value;
  const inscripcion = normalizarIdOpcional(b.inscripcion_id, "La inscripción");
  if (inscripcion.error) return inscripcion;
  datos.inscripcion_id = inscripcion.value;
  const comprador = normalizarCamposComprador(b);
  if (comprador.error) return comprador;
  Object.assign(datos, comprador.value);
  const aNombre = b.a_nombre_departamental === undefined ? 0 : normalizarBooleano01(b.a_nombre_departamental);
  if (aNombre === null) return { error: "El campo a_nombre_departamental debe ser 0 o 1" };
  datos.a_nombre_departamental = aNombre;
  if (b.observacion !== undefined && b.observacion !== null && typeof b.observacion !== "string") {
    return { error: "La observación es inválida" };
  }
  datos.observacion = normalizarTexto(b.observacion, 200);
  if (!datos.inscripcion_id && datos.a_nombre_departamental !== 1 && !datos.comprador_nombre) {
    return { error: "Indicá el nombre del comprador (persona o razón social)" };
  }
  return { value: datos };
}

// Body de PUT /olimpiadas/bonos/:bonoId: sólo se tocan los campos que vienen.
function normalizarEdicionBono(body) {
  const b = body || {};
  const comprador = normalizarCamposComprador(b, { parcial: true });
  if (comprador.error) return comprador;
  const datos = { ...comprador.value };
  if (b.a_nombre_departamental !== undefined) {
    const aNombre = normalizarBooleano01(b.a_nombre_departamental);
    if (aNombre === null) return { error: "El campo a_nombre_departamental debe ser 0 o 1" };
    datos.a_nombre_departamental = aNombre;
  }
  if (b.inscripcion_id !== undefined) {
    const inscripcion = normalizarIdOpcional(b.inscripcion_id, "La inscripción");
    if (inscripcion.error) return inscripcion;
    datos.inscripcion_id = inscripcion.value;
  }
  if (b.observacion !== undefined) {
    if (b.observacion !== null && typeof b.observacion !== "string") return { error: "La observación es inválida" };
    datos.observacion = normalizarTexto(b.observacion, 200);
  }
  if (Object.keys(datos).length === 0) return { error: "No hay cambios para guardar" };
  return { value: datos };
}

// Body de PUT /olimpiadas/:id/bonos/reglas → { value: { cambios, tramos } } | { error }.
function normalizarReglasEntrada(body) {
  const b = body || {};
  const cambios = {};
  if (b.valor_bono !== undefined) {
    const valor = normalizarMonto(b.valor_bono);
    if (valor === null) return { error: "El valor del bono debe ser un importe válido (ej: 40000 o 40000,50)" };
    cambios.valor_bono = valor;
  }
  if (b.bonos_afiliado !== undefined) {
    const valor = normalizarEnteroNoNegativo(typeof b.bonos_afiliado === "number" ? b.bonos_afiliado : String(b.bonos_afiliado ?? ""));
    if (valor === null || valor > MAX_BONOS_AFILIADO) return { error: `Los bonos por afiliado deben ser un entero entre 0 y ${MAX_BONOS_AFILIADO}` };
    cambios.bonos_afiliado = valor;
  }
  for (const campo of ["bono_numero_desde", "bono_numero_hasta"]) {
    if (b[campo] === undefined) continue;
    const valor = normalizarEnteroNoNegativo(typeof b[campo] === "number" ? b[campo] : String(b[campo] ?? ""));
    if (valor === null || valor > MAX_NUMERO_BONO) return { error: `La numeración debe ser un entero entre 0 y ${MAX_NUMERO_BONO}` };
    cambios[campo] = valor;
  }
  for (const campo of ["requiere_aprobacion", "exigir_bonos_para_validar", "sorteo_publicado"]) {
    if (b[campo] === undefined) continue;
    const valor = normalizarBooleano01(b[campo]);
    if (valor === null) return { error: `El campo ${campo} debe ser 0 o 1` };
    cambios[campo] = valor;
  }
  if (b.fecha_sorteo !== undefined) {
    if (b.fecha_sorteo === null || b.fecha_sorteo === "") {
      cambios.fecha_sorteo = null;
    } else {
      const fecha = normalizarFechaCivil(b.fecha_sorteo);
      if (!fecha) return { error: "La fecha del sorteo debe tener formato YYYY-MM-DD" };
      cambios.fecha_sorteo = fecha;
    }
  }
  if (b.sorteo_detalle !== undefined) {
    if (b.sorteo_detalle !== null && typeof b.sorteo_detalle !== "string") return { error: "El detalle del sorteo es inválido" };
    cambios.sorteo_detalle = normalizarTexto(b.sorteo_detalle, 300);
  }
  let tramos = null;
  if (b.tramos !== undefined) {
    const validacion = validarTramos(b.tramos);
    if (validacion.error) return { error: validacion.error };
    tramos = validacion.value;
  }
  return { value: { cambios, tramos } };
}

function describirTramos(tramos) {
  return (tramos || [])
    .map((t) => `${t.edad_desde}${t.edad_hasta === null || t.edad_hasta === undefined ? "+" : `-${t.edad_hasta}`}: ${t.bonos}`)
    .join(", ");
}

// Condición SQL del buscador de bonos vendidos (número, comprador, DNI, email, afiliado).
function condicionBusquedaBonos(q, olimpiada) {
  const texto = String(q).trim();
  const numeroExacto = /^\d{1,6}$/.test(texto) ? Number(texto) : -1;
  const contiene = `%${texto}%`;
  const empieza = `${texto}%`;
  return {
    sql: `(b.numero = ? OR CAST(b.numero AS CHAR) LIKE ? OR LPAD(b.numero, ?, '0') LIKE ?
           OR b.comprador_nombre LIKE ? OR b.comprador_documento LIKE ? OR b.comprador_email LIKE ?
           OR u.apellido LIKE ? OR u.nombre LIKE ? OR CONCAT(u.apellido, ' ', u.nombre) LIKE ? OR CONCAT(u.apellido, ', ', u.nombre) LIKE ?)`,
    params: [numeroExacto, empieza, digitosBono(olimpiada), empieza, contiene, empieza, contiene, contiene, contiene, contiene, contiene],
  };
}

function leerEnteroQuery(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const numero = normalizarEnteroNoNegativo(String(valor).trim());
  return numero === null ? undefined : numero;
}

function armarReglas(olimpiada, tramos) {
  return {
    olimpiada_id: olimpiada.id,
    valor_bono: Number(olimpiada.valor_bono) || 0,
    bonos_afiliado: Number(olimpiada.bonos_afiliado) || 0,
    bono_numero_desde: Number(olimpiada.bono_numero_desde) || 0,
    bono_numero_hasta: Number(olimpiada.bono_numero_hasta) || 0,
    digitos: digitosBono(olimpiada),
    requiere_aprobacion: Number(olimpiada.requiere_aprobacion) === 1 ? 1 : 0,
    exigir_bonos_para_validar: Number(olimpiada.exigir_bonos_para_validar) === 1 ? 1 : 0,
    fecha_sorteo: olimpiada.fecha_sorteo || null,
    sorteo_detalle: olimpiada.sorteo_detalle || null,
    sorteo_publicado: Number(olimpiada.sorteo_publicado) === 1 ? 1 : 0,
    fecha_inicio: olimpiada.fecha_inicio || null,
    tramos: (tramos || []).map((t) => ({
      id: t.id,
      edad_desde: t.edad_desde,
      edad_hasta: t.edad_hasta,
      bonos: t.bonos,
      etiqueta: t.etiqueta,
      orden: t.orden,
    })),
  };
}

function mapearBonoVendido(fila, olimpiada) {
  return {
    id: fila.id,
    numero: fila.numero,
    numero_texto: formatearNumeroBono(fila.numero, olimpiada),
    comprador_nombre: fila.comprador_nombre,
    comprador_documento: fila.comprador_documento,
    comprador_email: fila.comprador_email,
    comprador_telefono: fila.comprador_telefono,
    a_nombre_departamental: Number(fila.a_nombre_departamental) === 1 ? 1 : 0,
    inscripcion_id: fila.inscripcion_id,
    afiliado_apellido: fila.afiliado_apellido ?? null,
    afiliado_nombre: fila.afiliado_nombre ?? null,
    departamental_id: fila.departamental_id,
    departamental_nombre: fila.departamental_nombre ?? null,
    observacion: fila.observacion,
    fecha_venta: fila.fecha_venta,
    usuario_nombre: fila.usuario_nombre ?? null,
  };
}

// ---------------------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------------------
const SQL_BLOQUES = `SELECT b.id, b.olimpiada_id, b.departamental_id, d.nombre AS departamental_nombre,
                            b.numero_desde, b.numero_hasta, b.observacion, b.usuario_id, b.fecha_creacion, b.fecha_modificacion
                     FROM olimpiada_bono_bloque b
                     INNER JOIN departamental d ON d.id = b.departamental_id`;

const SQL_BONOS_SELECT = `SELECT b.id, b.numero, b.olimpiada_id, b.comprador_nombre, b.comprador_documento, b.comprador_email,
                                 b.comprador_telefono, b.a_nombre_departamental, b.inscripcion_id,
                                 u.apellido AS afiliado_apellido, u.nombre AS afiliado_nombre,
                                 b.departamental_id, d.nombre AS departamental_nombre, b.observacion, b.fecha_venta,
                                 CASE WHEN v.id IS NULL THEN NULL ELSE CONCAT(v.apellido, ', ', v.nombre) END AS usuario_nombre`;
const SQL_BONOS_FROM = `FROM olimpiada_bono b
                        LEFT JOIN departamental d ON d.id = b.departamental_id
                        LEFT JOIN olimpiada_inscripcion i ON i.id = b.inscripcion_id
                        LEFT JOIN usuario u ON u.id = i.usuario_id
                        LEFT JOIN usuario v ON v.id = b.usuario_id`;

async function conTransaccion(trabajo) {
  const connection = await db.getConnection();
  let confirmada = false;
  try {
    await connection.beginTransaction();
    const resultado = await trabajo(connection);
    await connection.commit();
    confirmada = true;
    return resultado;
  } catch (error) {
    if (!confirmada) {
      try {
        await connection.rollback();
      } catch (errorRollback) {
        // La conexión ya está rota: el error original es el que importa.
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function exigirOlimpiada(conn, olimpiadaId, opciones) {
  const olimpiada = await obtenerOlimpiada(conn, olimpiadaId, opciones);
  if (!olimpiada) throw crearErrorHttp("La olimpiada no existe", 404);
  return olimpiada;
}

async function cargarTramos(conn, olimpiadaId) {
  const [tramos] = await conn.query(
    `SELECT id, edad_desde, edad_hasta, bonos, etiqueta, orden
     FROM olimpiada_bono_tramo WHERE olimpiada_id = ? ORDER BY orden, edad_desde, id`,
    [olimpiadaId]
  );
  return tramos;
}

async function listarBloques(conn, olimpiadaId) {
  const [bloques] = await conn.query(`${SQL_BLOQUES} WHERE b.olimpiada_id = ? ORDER BY b.numero_desde, b.id`, [olimpiadaId]);
  return bloques;
}

async function obtenerBloque(conn, bloqueId) {
  const [filas] = await conn.query(`${SQL_BLOQUES} WHERE b.id = ?`, [bloqueId]);
  return filas[0] || null;
}

async function listarBloquesConVendidos(conn, olimpiadaId) {
  const [bloques] = await conn.query(
    `${SQL_BLOQUES}
     WHERE b.olimpiada_id = ? ORDER BY b.numero_desde, b.id`,
    [olimpiadaId]
  );
  if (bloques.length === 0) return [];
  const [vendidos] = await conn.query(`SELECT numero FROM olimpiada_bono WHERE olimpiada_id = ?`, [olimpiadaId]);
  const numeros = vendidos.map((v) => Number(v.numero)).sort((a, b) => a - b);
  return bloques.map((bloque) => {
    const desde = Number(bloque.numero_desde);
    const hasta = Number(bloque.numero_hasta);
    const cantidad = hasta - desde + 1;
    const vendidosBloque = numeros.filter((n) => n >= desde && n <= hasta).length;
    return {
      ...bloque,
      cantidad,
      vendidos: vendidosBloque,
      disponibles: cantidad - vendidosBloque,
    };
  });
}

async function contarVendidosEnRango(conn, olimpiadaId, desde, hasta, { excluirDepartamentalId = null } = {}) {
  const params = [olimpiadaId, desde, hasta];
  let filtro = "";
  if (excluirDepartamentalId) {
    filtro = " AND (departamental_id IS NULL OR departamental_id <> ?)";
    params.push(excluirDepartamentalId);
  }
  const [[fila]] = await conn.query(
    `SELECT COUNT(*) AS total FROM olimpiada_bono WHERE olimpiada_id = ? AND numero BETWEEN ? AND ?${filtro}`,
    params
  );
  return Number(fila.total) || 0;
}

async function obtenerDepartamental(conn, departamentalId) {
  const [filas] = await conn.query(`SELECT id, nombre FROM departamental WHERE id = ? AND habilitado = 'Y'`, [departamentalId]);
  return filas[0] || null;
}

async function obtenerBonoPorNumero(conn, olimpiadaId, numero) {
  const [filas] = await conn.query(
    `${SQL_BONOS_SELECT} ${SQL_BONOS_FROM} WHERE b.olimpiada_id = ? AND b.numero = ?`,
    [olimpiadaId, numero]
  );
  return filas[0] || null;
}

async function obtenerBonoCompleto(conn, bonoId, { forUpdate = false } = {}) {
  if (forUpdate) {
    // Bloqueo sobre la fila del bono (sin JOIN para no bloquear catálogos); después el detalle.
    const [bloqueo] = await conn.query(`SELECT id FROM olimpiada_bono WHERE id = ? FOR UPDATE`, [bonoId]);
    if (bloqueo.length === 0) return null;
  }
  const [filas] = await conn.query(`${SQL_BONOS_SELECT} ${SQL_BONOS_FROM} WHERE b.id = ?`, [bonoId]);
  return filas[0] || null;
}

// Inscripción a la que se imputan bonos: existe, no eliminada, de esa olimpiada, visible por el actor.
async function cargarInscripcionParaBonos(conn, inscripcionId, olimpiada, cabecera) {
  const [filas] = await conn.query(
    `SELECT i.id, i.olimpiada_id, i.usuario_id, i.departamental_id, i.estado, i.bonos_requeridos_manual,
            i.planilla_descuento, i.planilla_monto, i.planilla_cuotas, i.planilla_observacion,
            u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento AS afiliado_documento,
            u.email AS afiliado_email, u.telefono AS afiliado_telefono, d.nombre AS departamental_nombre
     FROM olimpiada_inscripcion i
     INNER JOIN usuario u ON u.id = i.usuario_id
     LEFT JOIN departamental d ON d.id = i.departamental_id
     WHERE i.id = ? AND i.eliminado = 0`,
    [inscripcionId]
  );
  const inscripcion = filas[0];
  if (!inscripcion) throw crearErrorHttp("La inscripción no existe", 404);
  if (Number(inscripcion.olimpiada_id) !== Number(olimpiada.id)) throw crearErrorHttp("La inscripción no pertenece a esta olimpiada", 400);
  if (!puedeVerInscripcion(cabecera, inscripcion)) throw crearErrorHttp("No podés operar sobre inscripciones de otra departamental", 403);
  if (inscripcion.estado === "CANCELADO") throw crearErrorHttp("La inscripción está cancelada: reactivala antes de asignarle bonos", 409);
  return inscripcion;
}

// Bonos requeridos por inscripción activa, agrupados por departamental (para el resumen).
async function requeridosPorDepartamental(conn, olimpiada) {
  const tramos = await cargarTramos(conn, olimpiada.id);
  const [inscripciones] = await conn.query(
    `SELECT i.id, i.departamental_id, i.bonos_requeridos_manual
     FROM olimpiada_inscripcion i
     WHERE i.olimpiada_id = ? AND i.eliminado = 0 AND i.estado IN ${SQL_ESTADOS_ACTIVOS}`,
    [olimpiada.id]
  );
  const [acompaniantes] = await conn.query(
    `SELECT a.inscripcion_id, a.fecha_nacimiento, a.es_afiliado, a.bonos, a.bonos_manual
     FROM olimpiada_inscripcion_acompaniante a
     INNER JOIN olimpiada_inscripcion i ON i.id = a.inscripcion_id
     WHERE i.olimpiada_id = ? AND i.eliminado = 0 AND i.estado IN ${SQL_ESTADOS_ACTIVOS}`,
    [olimpiada.id]
  );
  const bonosAfiliado = Number(olimpiada.bonos_afiliado) || 0;
  const porInscripcion = new Map();
  for (const a of acompaniantes) {
    const total = (porInscripcion.get(Number(a.inscripcion_id)) || 0)
      + calcularBonosAcompaniante(a, { tramos, bonosAfiliado, fechaReferencia: olimpiada.fecha_inicio });
    porInscripcion.set(Number(a.inscripcion_id), total);
  }
  const resultado = new Map();
  for (const i of inscripciones) {
    const clave = Number(i.departamental_id) || 0;
    const requeridos = i.bonos_requeridos_manual === null || i.bonos_requeridos_manual === undefined
      ? bonosAfiliado + (porInscripcion.get(Number(i.id)) || 0)
      : Number(i.bonos_requeridos_manual);
    const acumulado = resultado.get(clave) || { inscriptos_activos: 0, bonos_requeridos: 0 };
    acumulado.inscriptos_activos += 1;
    acumulado.bonos_requeridos += requeridos;
    resultado.set(clave, acumulado);
  }
  return resultado;
}

async function armarRespuestaPremios(conn, olimpiada, cabecera) {
  const [premios] = await conn.query(
    `SELECT id, orden, descripcion, sorteo, numero_ganador FROM olimpiada_premio WHERE olimpiada_id = ? ORDER BY orden, id`,
    [olimpiada.id]
  );
  const staff = esStaff(cabecera);
  const publicado = Number(olimpiada.sorteo_publicado) === 1;
  const base = {
    fecha_sorteo: olimpiada.fecha_sorteo || null,
    sorteo_detalle: olimpiada.sorteo_detalle || null,
    sorteo_publicado: publicado ? 1 : 0,
    valor_bono: Number(olimpiada.valor_bono) || 0,
  };
  if (!staff && !publicado) {
    return {
      ...base,
      premios: premios.map((p) => ({
        id: p.id,
        orden: p.orden,
        descripcion: p.descripcion,
        sorteo: p.sorteo,
        numero_ganador: null,
        numero_texto: null,
        estado: "SIN_SORTEAR",
        motivo_vacante: null,
        ganador: null,
      })),
    };
  }
  const numeros = [...new Set(premios.map((p) => p.numero_ganador).filter((n) => n !== null && n !== undefined).map(Number))];
  const bonosPorNumero = new Map();
  if (numeros.length > 0) {
    const [bonos] = await conn.query(
      `SELECT b.id, b.numero, b.comprador_nombre, b.comprador_documento, b.a_nombre_departamental, b.inscripcion_id,
              b.departamental_id, d.nombre AS departamental_nombre
       FROM olimpiada_bono b LEFT JOIN departamental d ON d.id = b.departamental_id
       WHERE b.olimpiada_id = ? AND b.numero IN (?)`,
      [olimpiada.id, numeros]
    );
    for (const bono of bonos) bonosPorNumero.set(Number(bono.numero), bono);
  }
  const resultados = calcularGanadores(premios, bonosPorNumero);
  return {
    ...base,
    premios: resultados.map((p) => ({
      id: p.id,
      orden: p.orden,
      descripcion: p.descripcion,
      sorteo: p.sorteo,
      numero_ganador: p.numero_ganador,
      numero_texto: p.numero_ganador === null ? null : formatearNumeroBono(p.numero_ganador, olimpiada),
      estado: p.estado,
      motivo_vacante: p.motivo_vacante,
      ganador: p.bono
        ? {
            comprador_nombre: p.bono.comprador_nombre,
            departamental_nombre: p.bono.departamental_nombre,
            a_nombre_departamental: Number(p.bono.a_nombre_departamental) === 1 ? 1 : 0,
            ...(staff ? { inscripcion_id: p.bono.inscripcion_id ?? null, comprador_documento: p.bono.comprador_documento ?? null } : {}),
          }
        : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reglas de la edición
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/bonos/reglas", verifyToken, async (req, res) => {
  const olimpiadaId = Number(req.params.id);
  try {
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    const tramos = await cargarTramos(db, olimpiadaId);
    return res.status(200).json(armarReglas(olimpiada, tramos));
  } catch (error) {
    return responderError(res, error, "Error al obtener las reglas de los bonos");
  }
});

router.put("/olimpiadas/:id(\\d+)/bonos/reglas", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const entrada = normalizarReglasEntrada(req.body);
  if (entrada.error) return res.status(400).json(entrada.error);
  const { cambios, tramos } = entrada.value;
  try {
    await conTransaccion(async (connection) => {
      const olimpiada = await exigirOlimpiada(connection, olimpiadaId, { forUpdate: true });
      const desde = cambios.bono_numero_desde ?? Number(olimpiada.bono_numero_desde);
      const hasta = cambios.bono_numero_hasta ?? Number(olimpiada.bono_numero_hasta);
      if (cambios.bono_numero_desde !== undefined || cambios.bono_numero_hasta !== undefined) {
        const bloques = await listarBloques(connection, olimpiadaId);
        const [[vendidos]] = await connection.query(
          `SELECT MIN(numero) AS minimo, MAX(numero) AS maximo FROM olimpiada_bono WHERE olimpiada_id = ?`,
          [olimpiadaId]
        );
        const validacion = validarRangoNumeracion(desde, hasta, {
          bloques,
          vendidosMin: vendidos.minimo === null ? null : Number(vendidos.minimo),
          vendidosMax: vendidos.maximo === null ? null : Number(vendidos.maximo),
        });
        if (validacion.error) throw crearErrorHttp(validacion.error, validacion.status);
      }
      const sets = [];
      const params = [];
      for (const [campo, valorNuevo] of Object.entries(cambios)) {
        const valorAnterior = olimpiada[campo] === undefined ? null : olimpiada[campo];
        const anteriorTexto = valorAnterior === null ? null : String(campo === "valor_bono" ? Number(valorAnterior) : valorAnterior);
        const nuevoTexto = valorNuevo === null ? null : String(valorNuevo);
        if (anteriorTexto === nuevoTexto) continue;
        sets.push(`${campo} = ?`);
        params.push(valorNuevo);
        await registrarHistorial(connection, {
          entidad: "BONO_REGLAS",
          entidad_id: olimpiadaId,
          olimpiada_id: olimpiadaId,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE",
          campo_modificado: campo,
          valor_anterior: anteriorTexto,
          valor_nuevo: nuevoTexto,
        });
      }
      if (sets.length > 0) {
        await connection.query(`UPDATE olimpiada SET ${sets.join(", ")} WHERE id = ?`, [...params, olimpiadaId]);
      }
      if (tramos) {
        const anteriores = await cargarTramos(connection, olimpiadaId);
        await connection.query(`DELETE FROM olimpiada_bono_tramo WHERE olimpiada_id = ?`, [olimpiadaId]);
        for (const tramo of tramos) {
          await connection.query(
            `INSERT INTO olimpiada_bono_tramo (olimpiada_id, edad_desde, edad_hasta, bonos, etiqueta, orden)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [olimpiadaId, tramo.edad_desde, tramo.edad_hasta, tramo.bonos, tramo.etiqueta, tramo.orden]
          );
        }
        const resumenAnterior = describirTramos(anteriores);
        const resumenNuevo = describirTramos(tramos);
        if (resumenAnterior !== resumenNuevo) {
          await registrarHistorial(connection, {
            entidad: "BONO_REGLAS",
            entidad_id: olimpiadaId,
            olimpiada_id: olimpiadaId,
            usuario_id: cabecera.id,
            usuario_rol: cabecera.rol,
            tipo_operacion: "UPDATE",
            campo_modificado: "tramos",
            valor_anterior: resumenAnterior,
            valor_nuevo: resumenNuevo,
          });
        }
      }
    });
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    const tramosActuales = await cargarTramos(db, olimpiadaId);
    return res.status(200).json(armarReglas(olimpiada, tramosActuales));
  } catch (error) {
    return responderError(res, error, "Error al guardar las reglas de los bonos");
  }
});

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/bonos/resumen", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  try {
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    const tramos = await cargarTramos(db, olimpiadaId);
    const bloques = await listarBloquesConVendidos(db, olimpiadaId);
    const [[conteo]] = await db.query(`SELECT COUNT(*) AS total FROM olimpiada_bono WHERE olimpiada_id = ?`, [olimpiadaId]);
    const requeridos = await requeridosPorDepartamental(db, olimpiada);
    const [departamentales] = await db.query(`SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre`);
    const nombres = new Map(departamentales.map((d) => [Number(d.id), d.nombre]));

    const rango = rangoDeOlimpiada(olimpiada);
    const emitidos = Math.max(0, rango.hasta - rango.desde + 1);
    const enBloques = bloques.reduce((total, b) => total + b.cantidad, 0);
    const vendidosTotal = Number(conteo.total) || 0;
    const disponibles = bloques.reduce((total, b) => total + b.disponibles, 0);
    const valorBono = Number(olimpiada.valor_bono) || 0;

    const porDepartamental = new Map();
    for (const bloque of bloques) {
      const clave = Number(bloque.departamental_id);
      const acumulado = porDepartamental.get(clave) || {
        departamental_id: clave,
        nombre: bloque.departamental_nombre,
        asignados: 0,
        vendidos: 0,
        disponibles: 0,
        inscriptos_activos: 0,
        bonos_requeridos: 0,
      };
      acumulado.asignados += bloque.cantidad;
      acumulado.vendidos += bloque.vendidos;
      acumulado.disponibles += bloque.disponibles;
      porDepartamental.set(clave, acumulado);
    }
    for (const [clave, datos] of requeridos.entries()) {
      const acumulado = porDepartamental.get(clave) || {
        departamental_id: clave || null,
        nombre: nombres.get(clave) || "Sin departamental",
        asignados: 0,
        vendidos: 0,
        disponibles: 0,
        inscriptos_activos: 0,
        bonos_requeridos: 0,
      };
      acumulado.inscriptos_activos = datos.inscriptos_activos;
      acumulado.bonos_requeridos = datos.bonos_requeridos;
      porDepartamental.set(clave, acumulado);
    }

    const mia = departamentalDe(cabecera);
    const superior = esSuperior(cabecera);
    const bloquesVisibles = superior ? bloques : bloques.filter((b) => Number(b.departamental_id) === mia);
    const departamentalesVisibles = [...porDepartamental.values()]
      .filter((d) => superior || Number(d.departamental_id) === mia)
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), "es"));

    return res.status(200).json({
      reglas: armarReglas(olimpiada, tramos),
      bloques: bloquesVisibles.map((b) => ({
        id: b.id,
        departamental_id: b.departamental_id,
        departamental_nombre: b.departamental_nombre,
        numero_desde: b.numero_desde,
        numero_hasta: b.numero_hasta,
        cantidad: b.cantidad,
        vendidos: b.vendidos,
        disponibles: b.disponibles,
        observacion: b.observacion,
      })),
      totales: {
        emitidos,
        en_bloques: enBloques,
        sin_asignar: Math.max(0, emitidos - enBloques),
        vendidos: vendidosTotal,
        disponibles,
        recaudado: vendidosTotal * valorBono,
      },
      por_departamental: departamentalesVisibles,
      mi_departamental_id: mia || null,
    });
  } catch (error) {
    return responderError(res, error, "Error al obtener el resumen de bonos");
  }
});

// ---------------------------------------------------------------------------
// Bloques por departamental (administración provincial)
// ---------------------------------------------------------------------------
router.post("/olimpiadas/:id(\\d+)/bonos/bloques", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  try {
    const resultado = await conTransaccion(async (connection) => {
      const olimpiada = await exigirOlimpiada(connection, olimpiadaId, { forUpdate: true });
      const bloques = await listarBloques(connection, olimpiadaId);
      const validacion = validarBloque(req.body || {}, { olimpiada, bloques });
      if (validacion.error) throw crearErrorHttp(validacion.error, validacion.status);
      const datos = validacion.value;
      const departamental = await obtenerDepartamental(connection, datos.departamental_id);
      if (!departamental) throw crearErrorHttp("La departamental no existe o está inhabilitada", 400);
      const ajenos = await contarVendidosEnRango(connection, olimpiadaId, datos.numero_desde, datos.numero_hasta, {
        excluirDepartamentalId: datos.departamental_id,
      });
      if (ajenos > 0) {
        throw crearErrorHttp(`Dentro del rango hay ${ajenos} bono${ajenos === 1 ? "" : "s"} vendido${ajenos === 1 ? "" : "s"} por otra departamental`, 409);
      }
      const [insercion] = await connection.query(
        `INSERT INTO olimpiada_bono_bloque (olimpiada_id, departamental_id, numero_desde, numero_hasta, observacion, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.departamental_id, datos.numero_desde, datos.numero_hasta, datos.observacion, cabecera.id]
      );
      const etiqueta = `${textoRango(datos.numero_desde, datos.numero_hasta, olimpiada)} → ${departamental.nombre}`;
      await registrarHistorial(connection, {
        entidad: "BONO_BLOQUE",
        entidad_id: insercion.insertId,
        olimpiada_id: olimpiadaId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "CREATE",
        campo_modificado: "bloque",
        valor_nuevo: etiqueta,
        observacion: datos.observacion,
      });
      return { id: insercion.insertId, etiqueta };
    });
    return res.status(201).json({ success: true, id: resultado.id, message: `Bloque ${resultado.etiqueta} asignado` });
  } catch (error) {
    return responderError(res, error, "Error al crear el bloque");
  }
});

router.put("/olimpiadas/bonos/bloques/:bloqueId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const bloqueId = Number(req.params.bloqueId);
  const body = req.body || {};
  try {
    const mensaje = await conTransaccion(async (connection) => {
      const referencia = await obtenerBloque(connection, bloqueId);
      if (!referencia) throw crearErrorHttp("El bloque no existe", 404);
      const olimpiada = await exigirOlimpiada(connection, referencia.olimpiada_id, { forUpdate: true });
      const actual = await obtenerBloque(connection, bloqueId);
      if (!actual) throw crearErrorHttp("El bloque no existe", 404);
      const bloques = await listarBloques(connection, olimpiada.id);
      const validacion = validarBloque(
        {
          departamental_id: body.departamental_id === undefined ? actual.departamental_id : body.departamental_id,
          numero_desde: body.numero_desde === undefined ? actual.numero_desde : body.numero_desde,
          numero_hasta: body.numero_hasta === undefined ? actual.numero_hasta : body.numero_hasta,
          observacion: body.observacion === undefined ? actual.observacion : body.observacion,
        },
        { olimpiada, bloques, bloqueId }
      );
      if (validacion.error) throw crearErrorHttp(validacion.error, validacion.status);
      const datos = validacion.value;
      const departamental = await obtenerDepartamental(connection, datos.departamental_id);
      if (!departamental) throw crearErrorHttp("La departamental no existe o está inhabilitada", 400);

      const [[vendidosActual]] = await connection.query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN numero BETWEEN ? AND ? THEN 0 ELSE 1 END) AS afuera
         FROM olimpiada_bono WHERE olimpiada_id = ? AND numero BETWEEN ? AND ?`,
        [datos.numero_desde, datos.numero_hasta, olimpiada.id, actual.numero_desde, actual.numero_hasta]
      );
      const totalVendidos = Number(vendidosActual.total) || 0;
      const afuera = Number(vendidosActual.afuera) || 0;
      if (afuera > 0) throw crearErrorHttp(`El bloque tiene ${afuera} bono${afuera === 1 ? "" : "s"} vendido${afuera === 1 ? "" : "s"} fuera del nuevo rango`, 409);
      if (totalVendidos > 0 && Number(actual.departamental_id) !== datos.departamental_id) {
        throw crearErrorHttp(`El bloque tiene ${totalVendidos} bono${totalVendidos === 1 ? "" : "s"} vendido${totalVendidos === 1 ? "" : "s"}: no se puede cambiar de departamental`, 409);
      }
      const ajenos = await contarVendidosEnRango(connection, olimpiada.id, datos.numero_desde, datos.numero_hasta, {
        excluirDepartamentalId: datos.departamental_id,
      });
      if (ajenos > 0) throw crearErrorHttp(`Dentro del nuevo rango hay ${ajenos} bono${ajenos === 1 ? "" : "s"} vendido${ajenos === 1 ? "" : "s"} por otra departamental`, 409);

      const cambios = [];
      const campos = [
        ["departamental_id", Number(actual.departamental_id), datos.departamental_id],
        ["numero_desde", Number(actual.numero_desde), datos.numero_desde],
        ["numero_hasta", Number(actual.numero_hasta), datos.numero_hasta],
        ["observacion", actual.observacion || null, datos.observacion],
      ];
      for (const [campo, anterior, nuevo] of campos) {
        if (anterior === nuevo) continue;
        cambios.push(campo);
        await registrarHistorial(connection, {
          entidad: "BONO_BLOQUE",
          entidad_id: bloqueId,
          olimpiada_id: olimpiada.id,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE",
          campo_modificado: campo,
          valor_anterior: campo === "departamental_id" ? actual.departamental_nombre : anterior,
          valor_nuevo: campo === "departamental_id" ? departamental.nombre : nuevo,
        });
      }
      if (cambios.length > 0) {
        await connection.query(
          `UPDATE olimpiada_bono_bloque SET departamental_id = ?, numero_desde = ?, numero_hasta = ?, observacion = ? WHERE id = ?`,
          [datos.departamental_id, datos.numero_desde, datos.numero_hasta, datos.observacion, bloqueId]
        );
      }
      return cambios.length > 0
        ? `Bloque ${textoRango(datos.numero_desde, datos.numero_hasta, olimpiada)} de ${departamental.nombre} actualizado`
        : "El bloque no tenía cambios";
    });
    return res.status(200).json({ success: true, id: bloqueId, message: mensaje });
  } catch (error) {
    return responderError(res, error, "Error al actualizar el bloque");
  }
});

router.delete("/olimpiadas/bonos/bloques/:bloqueId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const bloqueId = Number(req.params.bloqueId);
  try {
    const mensaje = await conTransaccion(async (connection) => {
      const referencia = await obtenerBloque(connection, bloqueId);
      if (!referencia) throw crearErrorHttp("El bloque no existe", 404);
      const olimpiada = await exigirOlimpiada(connection, referencia.olimpiada_id, { forUpdate: true });
      const bloque = await obtenerBloque(connection, bloqueId);
      if (!bloque) throw crearErrorHttp("El bloque no existe", 404);
      const vendidos = await contarVendidosEnRango(connection, olimpiada.id, bloque.numero_desde, bloque.numero_hasta);
      if (vendidos > 0) {
        throw crearErrorHttp(`El bloque tiene ${vendidos} bono${vendidos === 1 ? "" : "s"} vendido${vendidos === 1 ? "" : "s"} y no se puede eliminar. Anulá las ventas o reducí el rango`, 409);
      }
      await connection.query(`DELETE FROM olimpiada_bono_bloque WHERE id = ?`, [bloqueId]);
      await registrarHistorial(connection, {
        entidad: "BONO_BLOQUE",
        entidad_id: bloqueId,
        olimpiada_id: olimpiada.id,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "DELETE",
        campo_modificado: "bloque",
        valor_anterior: JSON.stringify({
          departamental_id: bloque.departamental_id,
          departamental_nombre: bloque.departamental_nombre,
          numero_desde: bloque.numero_desde,
          numero_hasta: bloque.numero_hasta,
          observacion: bloque.observacion,
        }),
      });
      return `Bloque ${textoRango(bloque.numero_desde, bloque.numero_hasta, olimpiada)} de ${bloque.departamental_nombre} eliminado`;
    });
    return res.status(200).json({ success: true, message: mensaje });
  } catch (error) {
    return responderError(res, error, "Error al eliminar el bloque");
  }
});

// ---------------------------------------------------------------------------
// Grilla y buscador
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/bonos/grilla", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const desdeQuery = leerEnteroQuery(req.query.desde);
  const hastaQuery = leerEnteroQuery(req.query.hasta);
  if (desdeQuery === undefined || hastaQuery === undefined) return res.status(400).json("Los parámetros desde y hasta deben ser enteros");
  try {
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    const bloques = await listarBloques(db, olimpiadaId);
    const rango = rangoDeOlimpiada(olimpiada);
    const mia = departamentalDe(cabecera);
    const superior = esSuperior(cabecera);
    let desde = desdeQuery;
    if (desde === null) {
      const primerPropio = superior ? null : ordenarBloques(bloques).find((b) => Number(b.departamental_id) === mia);
      desde = primerPropio ? Number(primerPropio.numero_desde) : rango.desde;
    }
    desde = Math.min(Math.max(desde, rango.desde), rango.hasta);
    let hasta = hastaQuery === null ? desde + VENTANA_GRILLA_DEFAULT - 1 : hastaQuery;
    hasta = Math.min(hasta, rango.hasta);
    if (hasta < desde) return res.status(400).json("El número hasta no puede ser menor que el desde");
    if (hasta - desde + 1 > MAX_VENTANA_GRILLA) return res.status(400).json(`La grilla muestra hasta ${MAX_VENTANA_GRILLA} números por vez`);

    const [bonos] = await db.query(
      `SELECT b.id, b.numero, b.comprador_nombre, b.comprador_documento, b.inscripcion_id, b.a_nombre_departamental,
              b.departamental_id, d.nombre AS departamental_nombre
       FROM olimpiada_bono b LEFT JOIN departamental d ON d.id = b.departamental_id
       WHERE b.olimpiada_id = ? AND b.numero BETWEEN ? AND ?`,
      [olimpiadaId, desde, hasta]
    );
    const bonosPorNumero = new Map(bonos.map((b) => [Number(b.numero), b]));
    const numeros = [];
    for (let numero = desde; numero <= hasta; numero += 1) {
      numeros.push(
        clasificarNumero({
          numero,
          bloque: bloqueDeNumero(bloques, numero),
          bono: bonosPorNumero.get(numero) || null,
          cabecera,
          olimpiada,
        })
      );
    }
    return res.status(200).json({ desde, hasta, digitos: digitosBono(olimpiada), rango, numeros });
  } catch (error) {
    return responderError(res, error, "Error al obtener la grilla de bonos");
  }
});

router.get("/olimpiadas/:id(\\d+)/bonos/buscar", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length === 0 || q.length > MAX_LARGO_BUSQUEDA) return res.status(400).json(`Escribí entre 1 y ${MAX_LARGO_BUSQUEDA} caracteres para buscar`);
  try {
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    const bloques = await listarBloques(db, olimpiadaId);
    const rango = rangoDeOlimpiada(olimpiada);
    const mia = departamentalDe(cabecera);
    const superior = esSuperior(cabecera);

    let numero = null;
    if (/^\d{1,6}$/.test(q) && Number(q) >= rango.desde && Number(q) <= rango.hasta) {
      const valor = Number(q);
      const bono = await obtenerBonoPorNumero(db, olimpiadaId, valor);
      numero = clasificarNumero({ numero: valor, bloque: bloqueDeNumero(bloques, valor), bono, cabecera, olimpiada });
    }

    const busqueda = condicionBusquedaBonos(q, olimpiada);
    const condiciones = ["b.olimpiada_id = ?", busqueda.sql];
    const params = [olimpiadaId, ...busqueda.params];
    if (!superior) {
      condiciones.push("b.departamental_id = ?");
      params.push(mia);
    }
    const [filas] = await db.query(
      `${SQL_BONOS_SELECT} ${SQL_BONOS_FROM} WHERE ${condiciones.join(" AND ")} ORDER BY b.numero LIMIT ?`,
      [...params, MAX_RESULTADOS_BUSQUEDA]
    );
    return res.status(200).json({ numero, bonos: filas.map((fila) => mapearBonoVendido(fila, olimpiada)) });
  } catch (error) {
    return responderError(res, error, "Error al buscar bonos");
  }
});

// ---------------------------------------------------------------------------
// Vendidos (tabla paginada + CSV)
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/bonos/vendidos", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const formatoCsv = String(req.query.formato || "").toLowerCase() === "csv";
  const page = req.query.page === undefined || req.query.page === "" ? 1 : normalizarIdPositivo(String(req.query.page));
  const pageSize = req.query.pageSize === undefined || req.query.pageSize === "" ? 20 : normalizarIdPositivo(String(req.query.pageSize));
  if (page === null || pageSize === null || page > 1_000_000 || pageSize > 100) return res.status(400).json("La paginación es inválida");
  const orderBy = COLUMNAS_ORDEN_VENDIDOS[req.query.orderBy] || "b.numero";
  const orderType = String(req.query.orderType || "").toUpperCase() === "DESC" ? "DESC" : "ASC";
  const buscar = typeof req.query.buscar === "string" ? req.query.buscar.trim() : "";
  if (buscar.length > MAX_LARGO_BUSQUEDA) return res.status(400).json(`La búsqueda admite hasta ${MAX_LARGO_BUSQUEDA} caracteres`);
  const departamentalFiltro = normalizarIdOpcional(req.query.departamental_id, "La departamental");
  if (departamentalFiltro.error) return res.status(400).json(departamentalFiltro.error);
  const inscripcionFiltro = normalizarIdOpcional(req.query.inscripcion_id, "La inscripción");
  if (inscripcionFiltro.error) return res.status(400).json(inscripcionFiltro.error);
  let aNombre = null;
  if (req.query.a_nombre_departamental !== undefined && req.query.a_nombre_departamental !== "") {
    aNombre = normalizarBooleano01(req.query.a_nombre_departamental);
    if (aNombre === null) return res.status(400).json("El filtro a_nombre_departamental debe ser 0 o 1");
  }
  try {
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    const condiciones = ["b.olimpiada_id = ?"];
    const params = [olimpiadaId];
    if (esSuperior(cabecera)) {
      if (departamentalFiltro.value) {
        condiciones.push("b.departamental_id = ?");
        params.push(departamentalFiltro.value);
      }
    } else {
      condiciones.push("b.departamental_id = ?");
      params.push(departamentalDe(cabecera));
    }
    if (inscripcionFiltro.value) {
      condiciones.push("b.inscripcion_id = ?");
      params.push(inscripcionFiltro.value);
    }
    if (aNombre !== null) {
      condiciones.push("b.a_nombre_departamental = ?");
      params.push(aNombre);
    }
    if (buscar.length > 0) {
      const busqueda = condicionBusquedaBonos(buscar, olimpiada);
      condiciones.push(busqueda.sql);
      params.push(...busqueda.params);
    }
    const where = condiciones.join(" AND ");
    const orden = `ORDER BY ${orderBy} ${orderType}, b.numero ASC`;

    if (formatoCsv) {
      const [filas] = await db.query(`${SQL_BONOS_SELECT} ${SQL_BONOS_FROM} WHERE ${where} ${orden} LIMIT ?`, [...params, MAX_FILAS_CSV]);
      const csv = armarCsvBonos(filas, olimpiada);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="bonos-olimpiada-${olimpiadaId}.csv"`);
      return res.status(200).send(csv);
    }

    const [[conteo]] = await db.query(`SELECT COUNT(*) AS total ${SQL_BONOS_FROM} WHERE ${where}`, params);
    const [filas] = await db.query(
      `${SQL_BONOS_SELECT} ${SQL_BONOS_FROM} WHERE ${where} ${orden} LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    return res.status(200).json({
      results: filas.map((fila) => mapearBonoVendido(fila, olimpiada)),
      totalItems: Number(conteo.total) || 0,
      page,
      pageSize,
    });
  } catch (error) {
    return responderError(res, error, "Error al listar los bonos vendidos");
  }
});

// ---------------------------------------------------------------------------
// Venta / asignación de bonos
// ---------------------------------------------------------------------------
router.post("/olimpiadas/:id(\\d+)/bonos", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const entrada = normalizarVenta(req.body);
  if (entrada.error) return res.status(400).json(entrada.error);
  const datos = entrada.value;
  const superior = esSuperior(cabecera);
  const mia = departamentalDe(cabecera);
  if (!superior && !mia) return res.status(403).json("Tu usuario no tiene una departamental asignada");
  if (!superior && datos.departamental_id && datos.departamental_id !== mia) {
    return res.status(403).json("Sólo podés vender bonos de los bloques de tu departamental");
  }
  try {
    const resultado = await conTransaccion(async (connection) => {
      const olimpiada = await exigirOlimpiada(connection, olimpiadaId, { forUpdate: true });
      const bloques = await listarBloques(connection, olimpiadaId);
      const rango = rangoDeOlimpiada(olimpiada);
      const inscripcion = datos.inscripcion_id
        ? await cargarInscripcionParaBonos(connection, datos.inscripcion_id, olimpiada, cabecera)
        : null;

      let asignaciones = [];
      if (datos.numeros) {
        for (const numero of datos.numeros) {
          const texto = formatearNumeroBono(numero, olimpiada);
          if (numero < rango.desde || numero > rango.hasta) {
            throw crearErrorHttp(`El bono ${texto} está fuera de la numeración de la edición (${textoRango(rango.desde, rango.hasta, olimpiada)})`, 400);
          }
          const bloque = bloqueDeNumero(bloques, numero);
          if (!bloque) throw crearErrorHttp(`El bono ${texto} no está asignado a ninguna departamental`, 409);
          if (!superior && Number(bloque.departamental_id) !== mia) {
            throw crearErrorHttp(`El bono ${texto} pertenece al bloque de ${bloque.departamental_nombre}`, 403);
          }
          if (superior && datos.departamental_id && Number(bloque.departamental_id) !== datos.departamental_id) {
            throw crearErrorHttp(`El bono ${texto} pertenece al bloque de ${bloque.departamental_nombre}`, 409);
          }
          asignaciones.push({ numero, bloque });
        }
        const [yaVendidos] = await connection.query(
          `SELECT numero FROM olimpiada_bono WHERE olimpiada_id = ? AND numero IN (?) ORDER BY numero`,
          [olimpiadaId, datos.numeros]
        );
        if (yaVendidos.length > 0) {
          throw crearErrorHttp(`El bono ${formatearNumeroBono(yaVendidos[0].numero, olimpiada)} ya está vendido`, 409);
        }
      } else {
        const objetivoId = superior
          ? datos.departamental_id || (inscripcion ? normalizarIdPositivo(inscripcion.departamental_id) : null)
          : mia;
        if (!objetivoId) throw crearErrorHttp("Indicá la departamental cuyos bloques se van a usar para la asignación automática", 400);
        const propios = bloques.filter((b) => Number(b.departamental_id) === objetivoId);
        const objetivo = propios[0]?.departamental_nombre
          ? { id: objetivoId, nombre: propios[0].departamental_nombre }
          : await obtenerDepartamental(connection, objetivoId);
        if (!objetivo) throw crearErrorHttp("La departamental no existe o está inhabilitada", 400);
        if (propios.length === 0) throw crearErrorHttp(`${objetivo.nombre} no tiene bloques de bonos asignados en esta edición`, 409);
        const [vendidos] = await connection.query(`SELECT numero FROM olimpiada_bono WHERE olimpiada_id = ?`, [olimpiadaId]);
        const elegidos = elegirNumerosLibres(propios, new Set(vendidos.map((v) => Number(v.numero))), datos.cantidad);
        if (elegidos.length < datos.cantidad) {
          throw crearErrorHttp(
            elegidos.length === 0
              ? `No quedan bonos disponibles en los bloques de ${objetivo.nombre}`
              : `Sólo quedan ${elegidos.length} bono${elegidos.length === 1 ? "" : "s"} disponible${elegidos.length === 1 ? "" : "s"} en los bloques de ${objetivo.nombre} (pediste ${datos.cantidad})`,
            409
          );
        }
        asignaciones = elegidos.map((numero) => ({ numero, bloque: bloqueDeNumero(propios, numero) }));
      }

      const compradorBase = {
        nombre: datos.comprador_nombre,
        documento: datos.comprador_documento,
        email: datos.comprador_email,
        telefono: datos.comprador_telefono,
      };
      if (inscripcion) {
        compradorBase.nombre = compradorBase.nombre || `${inscripcion.afiliado_apellido}, ${inscripcion.afiliado_nombre}`;
        compradorBase.documento = compradorBase.documento || (inscripcion.afiliado_documento ? String(inscripcion.afiliado_documento) : null);
        compradorBase.email = compradorBase.email || inscripcion.afiliado_email || null;
        compradorBase.telefono = compradorBase.telefono || inscripcion.afiliado_telefono || null;
      }

      const creados = [];
      for (const { numero, bloque } of asignaciones) {
        const nombreComprador = datos.a_nombre_departamental === 1 ? bloque.departamental_nombre : compradorBase.nombre;
        try {
          const [insercion] = await connection.query(
            `INSERT INTO olimpiada_bono
               (olimpiada_id, numero, departamental_id, inscripcion_id, comprador_nombre, comprador_documento,
                comprador_email, comprador_telefono, a_nombre_departamental, observacion, usuario_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              olimpiadaId,
              numero,
              bloque.departamental_id,
              inscripcion ? inscripcion.id : null,
              nombreComprador,
              compradorBase.documento,
              compradorBase.email,
              compradorBase.telefono,
              datos.a_nombre_departamental,
              datos.observacion,
              cabecera.id,
            ]
          );
          creados.push({ id: insercion.insertId, numero, numero_texto: formatearNumeroBono(numero, olimpiada) });
        } catch (error) {
          if (error?.code === "ER_DUP_ENTRY") throw crearErrorHttp(`El bono ${formatearNumeroBono(numero, olimpiada)} ya está vendido`, 409);
          throw error;
        }
      }

      const numerosCreados = creados.map((c) => c.numero);
      const resumenComprador = datos.a_nombre_departamental === 1
        ? `a nombre de ${[...new Set(asignaciones.map((a) => a.bloque.departamental_nombre))].join(", ")}`
        : compradorBase.nombre;
      await registrarHistorial(connection, {
        entidad: "BONO",
        entidad_id: creados[0].id,
        olimpiada_id: olimpiadaId,
        inscripcion_id: inscripcion ? inscripcion.id : null,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "CREATE",
        campo_modificado: "venta",
        valor_nuevo: `${describirNumeros(numerosCreados, olimpiada)} → ${resumenComprador}${inscripcion ? ` / inscripción #${inscripcion.id}` : ""}`,
        observacion: datos.observacion,
      });

      if (inscripcion) {
        const cantidad = creados.length;
        await insertarNotificacion(
          connection,
          inscripcion.usuario_id,
          "OLIMPIADA_BONOS",
          `Te asignaron ${cantidad} bono${cantidad === 1 ? "" : "s"} contribución`,
          `${olimpiada.nombre}: ${cantidad === 1 ? "número" : "números"} ${creados.map((c) => c.numero_texto).join(", ")}.`,
          { inscripcion_id: inscripcion.id, olimpiada_id: olimpiadaId }
        );
      }
      return { olimpiada, inscripcion, creados };
    });

    const cantidad = resultado.creados.length;
    const resumenInscripcion = resultado.inscripcion
      ? await resumenBonosInscripcion(db, resultado.inscripcion, resultado.olimpiada)
      : null;
    const mensaje = cantidad === 1
      ? `Se registró el bono ${resultado.creados[0].numero_texto}`
      : `Se registraron ${cantidad} bonos (${describirNumeros(resultado.creados.map((c) => c.numero), resultado.olimpiada)})`;
    return res.status(201).json({
      success: true,
      message: resultado.inscripcion ? `${mensaje} para la inscripción #${resultado.inscripcion.id}` : mensaje,
      bonos: resultado.creados,
      resumen_inscripcion: resumenInscripcion,
    });
  } catch (error) {
    return responderError(res, error, "Error al registrar los bonos");
  }
});

// ---------------------------------------------------------------------------
// Edición y anulación de un bono
// ---------------------------------------------------------------------------
function exigirScopeBono(cabecera, bono) {
  if (esSuperior(cabecera)) return;
  const mia = departamentalDe(cabecera);
  if (!mia || Number(bono.departamental_id) !== mia) {
    throw crearErrorHttp(`El bono pertenece a ${bono.departamental_nombre || "otra departamental"}`, 403);
  }
}

router.put("/olimpiadas/bonos/:bonoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const bonoId = Number(req.params.bonoId);
  const entrada = normalizarEdicionBono(req.body);
  if (entrada.error) return res.status(400).json(entrada.error);
  const datos = entrada.value;
  try {
    const mensaje = await conTransaccion(async (connection) => {
      const referencia = await obtenerBonoCompleto(connection, bonoId);
      if (!referencia) throw crearErrorHttp("El bono no existe", 404);
      const olimpiada = await exigirOlimpiada(connection, referencia.olimpiada_id, { forUpdate: true });
      const bono = await obtenerBonoCompleto(connection, bonoId, { forUpdate: true });
      if (!bono) throw crearErrorHttp("El bono no existe", 404);
      exigirScopeBono(cabecera, bono);

      let inscripcionNueva = null;
      if (datos.inscripcion_id !== undefined && datos.inscripcion_id !== null && datos.inscripcion_id !== Number(bono.inscripcion_id)) {
        inscripcionNueva = await cargarInscripcionParaBonos(connection, datos.inscripcion_id, olimpiada, cabecera);
      }
      const aNombre = datos.a_nombre_departamental === undefined ? Number(bono.a_nombre_departamental) === 1 ? 1 : 0 : datos.a_nombre_departamental;
      let nombre = datos.comprador_nombre === undefined ? bono.comprador_nombre : datos.comprador_nombre;
      if (aNombre === 1) nombre = bono.departamental_nombre || nombre;
      if (!nombre) throw crearErrorHttp("Indicá el nombre del comprador (persona o razón social)", 400);

      const valores = {
        comprador_nombre: nombre,
        comprador_documento: datos.comprador_documento === undefined ? bono.comprador_documento : datos.comprador_documento,
        comprador_email: datos.comprador_email === undefined ? bono.comprador_email : datos.comprador_email,
        comprador_telefono: datos.comprador_telefono === undefined ? bono.comprador_telefono : datos.comprador_telefono,
        a_nombre_departamental: aNombre,
        inscripcion_id: datos.inscripcion_id === undefined ? bono.inscripcion_id : datos.inscripcion_id,
        observacion: datos.observacion === undefined ? bono.observacion : datos.observacion,
      };
      const cambios = [];
      for (const [campo, nuevo] of Object.entries(valores)) {
        const anterior = bono[campo] === undefined || bono[campo] === null ? null : bono[campo];
        const anteriorTexto = anterior === null ? null : String(anterior);
        const nuevoTexto = nuevo === null || nuevo === undefined ? null : String(nuevo);
        if (anteriorTexto === nuevoTexto) continue;
        cambios.push(campo);
        await registrarHistorial(connection, {
          entidad: "BONO",
          entidad_id: bonoId,
          olimpiada_id: olimpiada.id,
          inscripcion_id: valores.inscripcion_id || bono.inscripcion_id || null,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE",
          campo_modificado: campo,
          valor_anterior: anteriorTexto,
          valor_nuevo: nuevoTexto,
          observacion: `Bono ${formatearNumeroBono(bono.numero, olimpiada)}`,
        });
      }
      if (cambios.length === 0) return "El bono no tenía cambios";
      await connection.query(
        `UPDATE olimpiada_bono
         SET comprador_nombre = ?, comprador_documento = ?, comprador_email = ?, comprador_telefono = ?,
             a_nombre_departamental = ?, inscripcion_id = ?, observacion = ?
         WHERE id = ?`,
        [
          valores.comprador_nombre,
          valores.comprador_documento,
          valores.comprador_email,
          valores.comprador_telefono,
          valores.a_nombre_departamental,
          valores.inscripcion_id,
          valores.observacion,
          bonoId,
        ]
      );
      if (inscripcionNueva) {
        await insertarNotificacion(
          connection,
          inscripcionNueva.usuario_id,
          "OLIMPIADA_BONOS",
          "Te asignaron 1 bono contribución",
          `${olimpiada.nombre}: número ${formatearNumeroBono(bono.numero, olimpiada)}.`,
          { inscripcion_id: inscripcionNueva.id, olimpiada_id: olimpiada.id }
        );
      }
      return `Bono ${formatearNumeroBono(bono.numero, olimpiada)} actualizado`;
    });
    return res.status(200).json({ success: true, id: bonoId, message: mensaje });
  } catch (error) {
    return responderError(res, error, "Error al actualizar el bono");
  }
});

router.delete("/olimpiadas/bonos/:bonoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  const bonoId = Number(req.params.bonoId);
  const motivoCrudo = req.body?.motivo;
  if (motivoCrudo !== undefined && motivoCrudo !== null && typeof motivoCrudo !== "string") return res.status(400).json("El motivo es inválido");
  const motivo = normalizarTexto(motivoCrudo, 300);
  try {
    const mensaje = await conTransaccion(async (connection) => {
      const referencia = await obtenerBonoCompleto(connection, bonoId);
      if (!referencia) throw crearErrorHttp("El bono no existe", 404);
      const olimpiada = await exigirOlimpiada(connection, referencia.olimpiada_id, { forUpdate: true });
      const bono = await obtenerBonoCompleto(connection, bonoId, { forUpdate: true });
      if (!bono) throw crearErrorHttp("El bono no existe", 404);
      exigirScopeBono(cabecera, bono);
      await connection.query(`DELETE FROM olimpiada_bono WHERE id = ?`, [bonoId]);
      await registrarHistorial(connection, {
        entidad: "BONO",
        entidad_id: bonoId,
        olimpiada_id: olimpiada.id,
        inscripcion_id: bono.inscripcion_id || null,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "DELETE",
        campo_modificado: "anulacion",
        valor_anterior: JSON.stringify({
          id: bono.id,
          numero: bono.numero,
          numero_texto: formatearNumeroBono(bono.numero, olimpiada),
          departamental_id: bono.departamental_id,
          departamental_nombre: bono.departamental_nombre,
          inscripcion_id: bono.inscripcion_id,
          comprador_nombre: bono.comprador_nombre,
          comprador_documento: bono.comprador_documento,
          comprador_email: bono.comprador_email,
          comprador_telefono: bono.comprador_telefono,
          a_nombre_departamental: Number(bono.a_nombre_departamental) === 1 ? 1 : 0,
          observacion: bono.observacion,
          fecha_venta: bono.fecha_venta,
        }),
        observacion: motivo,
      });
      return `Bono ${formatearNumeroBono(bono.numero, olimpiada)} anulado: el número vuelve a estar disponible`;
    });
    return res.status(200).json({ success: true, message: mensaje });
  } catch (error) {
    return responderError(res, error, "Error al anular el bono");
  }
});

// ---------------------------------------------------------------------------
// Premios y sorteo
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/premios", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  const olimpiadaId = Number(req.params.id);
  try {
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    return res.status(200).json(await armarRespuestaPremios(db, olimpiada, cabecera));
  } catch (error) {
    return responderError(res, error, "Error al obtener los premios");
  }
});

router.put("/olimpiadas/:id(\\d+)/premios", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const lista = req.body?.premios;
  if (!Array.isArray(lista)) return res.status(400).json("Enviá la lista de premios");
  if (lista.length > MAX_PREMIOS) return res.status(400).json(`Se pueden cargar hasta ${MAX_PREMIOS} premios`);
  const premios = [];
  for (const [indice, premio] of lista.entries()) {
    if (!premio || typeof premio !== "object") return res.status(400).json(`El premio en la posición ${indice + 1} es inválido`);
    const descripcion = typeof premio.descripcion === "string" ? normalizarTexto(premio.descripcion, MAX_LARGO_DESCRIPCION_PREMIO) : null;
    if (!descripcion) return res.status(400).json(`El premio en la posición ${indice + 1} no tiene descripción`);
    const orden = premio.orden === undefined || premio.orden === null || premio.orden === "" ? indice + 1 : normalizarIdPositivo(premio.orden);
    if (!orden) return res.status(400).json(`El orden del premio "${descripcion.slice(0, 40)}" debe ser un entero mayor a 0`);
    if (premio.sorteo !== undefined && premio.sorteo !== null && typeof premio.sorteo !== "string") return res.status(400).json("El campo sorteo es inválido");
    const id = premio.id === undefined || premio.id === null || premio.id === "" ? null : normalizarIdPositivo(premio.id);
    if (premio.id !== undefined && premio.id !== null && premio.id !== "" && !id) return res.status(400).json("Hay un premio con id inválido");
    premios.push({ id, orden, descripcion, sorteo: normalizarTexto(premio.sorteo, 80) });
  }
  try {
    const resumen = await conTransaccion(async (connection) => {
      await exigirOlimpiada(connection, olimpiadaId, { forUpdate: true });
      const [existentes] = await connection.query(`SELECT id FROM olimpiada_premio WHERE olimpiada_id = ?`, [olimpiadaId]);
      const idsExistentes = new Set(existentes.map((p) => Number(p.id)));
      const conservados = [];
      let creados = 0;
      let actualizados = 0;
      for (const premio of premios) {
        if (premio.id && idsExistentes.has(premio.id)) {
          await connection.query(
            `UPDATE olimpiada_premio SET orden = ?, descripcion = ?, sorteo = ? WHERE id = ? AND olimpiada_id = ?`,
            [premio.orden, premio.descripcion, premio.sorteo, premio.id, olimpiadaId]
          );
          conservados.push(premio.id);
          actualizados += 1;
        } else {
          const [insercion] = await connection.query(
            `INSERT INTO olimpiada_premio (olimpiada_id, orden, descripcion, sorteo) VALUES (?, ?, ?, ?)`,
            [olimpiadaId, premio.orden, premio.descripcion, premio.sorteo]
          );
          conservados.push(insercion.insertId);
          creados += 1;
        }
      }
      const eliminados = [...idsExistentes].filter((id) => !conservados.includes(id));
      if (eliminados.length > 0) {
        await connection.query(`DELETE FROM olimpiada_premio WHERE olimpiada_id = ? AND id IN (?)`, [olimpiadaId, eliminados]);
      }
      await registrarHistorial(connection, {
        entidad: "PREMIO",
        entidad_id: olimpiadaId,
        olimpiada_id: olimpiadaId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE",
        campo_modificado: "premios",
        valor_anterior: `${idsExistentes.size} premios`,
        valor_nuevo: `${premios.length} premios (${creados} nuevos, ${actualizados} actualizados, ${eliminados.length} eliminados)`,
      });
      return { creados, actualizados, eliminados: eliminados.length };
    });
    return res.status(200).json({
      success: true,
      message: `Premios guardados: ${resumen.creados} nuevos, ${resumen.actualizados} actualizados, ${resumen.eliminados} eliminados`,
    });
  } catch (error) {
    return responderError(res, error, "Error al guardar los premios");
  }
});

router.post("/olimpiadas/:id(\\d+)/premios/importar", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const texto = req.body?.texto;
  if (typeof texto !== "string" || texto.trim().length === 0) return res.status(400).json("Pegá el listado de premios, uno por línea");
  if (texto.length > MAX_TEXTO_IMPORTACION) return res.status(400).json("El texto es demasiado largo");
  const descripciones = parsearPremios(texto);
  if (descripciones.length === 0) return res.status(400).json("No se encontró ningún premio en el texto");
  try {
    const creados = await conTransaccion(async (connection) => {
      await exigirOlimpiada(connection, olimpiadaId, { forUpdate: true });
      const [[estado]] = await connection.query(
        `SELECT COUNT(*) AS total, COALESCE(MAX(orden), 0) AS ultimo FROM olimpiada_premio WHERE olimpiada_id = ?`,
        [olimpiadaId]
      );
      if (Number(estado.total) + descripciones.length > MAX_PREMIOS) {
        throw crearErrorHttp(`Con este listado se superarían los ${MAX_PREMIOS} premios permitidos (ya hay ${estado.total})`, 400);
      }
      let orden = Number(estado.ultimo) || 0;
      for (const descripcion of descripciones) {
        orden += 1;
        await connection.query(`INSERT INTO olimpiada_premio (olimpiada_id, orden, descripcion) VALUES (?, ?, ?)`, [olimpiadaId, orden, descripcion]);
      }
      await registrarHistorial(connection, {
        entidad: "PREMIO",
        entidad_id: olimpiadaId,
        olimpiada_id: olimpiadaId,
        usuario_id: cabecera.id,
        usuario_rol: cabecera.rol,
        tipo_operacion: "CREATE",
        campo_modificado: "importacion",
        valor_nuevo: `${descripciones.length} premios importados (puestos ${Number(estado.ultimo) + 1} a ${orden})`,
      });
      return descripciones.length;
    });
    return res.status(201).json({
      success: true,
      message: creados === 1 ? "Se agregó 1 premio" : `Se agregaron ${creados} premios`,
      creados,
    });
  } catch (error) {
    return responderError(res, error, "Error al importar los premios");
  }
});

router.put("/olimpiadas/:id(\\d+)/premios/sorteo", verifyToken, async (req, res) => {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
  const olimpiadaId = Number(req.params.id);
  const body = req.body || {};
  const cambios = {};
  if (body.fecha_sorteo !== undefined) {
    if (body.fecha_sorteo === null || body.fecha_sorteo === "") {
      cambios.fecha_sorteo = null;
    } else {
      const fecha = normalizarFechaCivil(body.fecha_sorteo);
      if (!fecha) return res.status(400).json("La fecha del sorteo debe tener formato YYYY-MM-DD");
      cambios.fecha_sorteo = fecha;
    }
  }
  if (body.sorteo_detalle !== undefined) {
    if (body.sorteo_detalle !== null && typeof body.sorteo_detalle !== "string") return res.status(400).json("El detalle del sorteo es inválido");
    cambios.sorteo_detalle = normalizarTexto(body.sorteo_detalle, 300);
  }
  if (body.sorteo_publicado !== undefined) {
    const publicado = normalizarBooleano01(body.sorteo_publicado);
    if (publicado === null) return res.status(400).json("El campo sorteo_publicado debe ser 0 o 1");
    cambios.sorteo_publicado = publicado;
  }
  const resultados = body.resultados === undefined || body.resultados === null ? [] : body.resultados;
  if (!Array.isArray(resultados)) return res.status(400).json("Los resultados deben ser una lista de { premio_id, numero_ganador }");
  if (resultados.length > MAX_PREMIOS) return res.status(400).json(`Se pueden cargar hasta ${MAX_PREMIOS} resultados`);
  try {
    await conTransaccion(async (connection) => {
      const olimpiada = await exigirOlimpiada(connection, olimpiadaId, { forUpdate: true });
      const rango = rangoDeOlimpiada(olimpiada);
      const [premios] = await connection.query(`SELECT id, orden, numero_ganador FROM olimpiada_premio WHERE olimpiada_id = ?`, [olimpiadaId]);
      const porId = new Map(premios.map((p) => [Number(p.id), p]));
      const normalizados = [];
      for (const resultado of resultados) {
        if (!resultado || typeof resultado !== "object") throw crearErrorHttp("Hay un resultado inválido", 400);
        const premioId = normalizarIdPositivo(resultado.premio_id);
        if (!premioId || !porId.has(premioId)) throw crearErrorHttp(`El premio #${resultado?.premio_id ?? "?"} no pertenece a esta olimpiada`, 400);
        let numero = null;
        if (resultado.numero_ganador !== null && resultado.numero_ganador !== undefined && resultado.numero_ganador !== "") {
          numero = normalizarEnteroNoNegativo(typeof resultado.numero_ganador === "number" ? resultado.numero_ganador : String(resultado.numero_ganador).trim());
          if (numero === null) throw crearErrorHttp(`El número ganador del premio ${porId.get(premioId).orden}º debe ser un entero`, 400);
          if (numero < rango.desde || numero > rango.hasta) {
            throw crearErrorHttp(`El número ${formatearNumeroBono(numero, olimpiada)} está fuera de la numeración de la edición (${textoRango(rango.desde, rango.hasta, olimpiada)})`, 400);
          }
        }
        normalizados.push({ premioId, numero });
      }
      let cargados = 0;
      for (const { premioId, numero } of normalizados) {
        await connection.query(`UPDATE olimpiada_premio SET numero_ganador = ? WHERE id = ? AND olimpiada_id = ?`, [numero, premioId, olimpiadaId]);
        if (numero !== null) cargados += 1;
      }
      const sets = [];
      const params = [];
      const detalle = [];
      for (const [campo, valor] of Object.entries(cambios)) {
        const anterior = olimpiada[campo] === undefined || olimpiada[campo] === null ? null : String(olimpiada[campo]);
        const nuevo = valor === null ? null : String(valor);
        if (anterior === nuevo) continue;
        sets.push(`${campo} = ?`);
        params.push(valor);
        detalle.push(`${campo}: ${anterior ?? "—"} → ${nuevo ?? "—"}`);
      }
      if (sets.length > 0) await connection.query(`UPDATE olimpiada SET ${sets.join(", ")} WHERE id = ?`, [...params, olimpiadaId]);
      if (normalizados.length > 0 || detalle.length > 0) {
        await registrarHistorial(connection, {
          entidad: "SORTEO",
          entidad_id: olimpiadaId,
          olimpiada_id: olimpiadaId,
          usuario_id: cabecera.id,
          usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE",
          campo_modificado: "sorteo",
          valor_nuevo: [
            normalizados.length > 0 ? `${cargados} número${cargados === 1 ? "" : "s"} ganador${cargados === 1 ? "" : "es"} cargado${cargados === 1 ? "" : "s"} (${normalizados.length} premios)` : null,
            ...detalle,
          ].filter(Boolean).join("; "),
        });
      }
      // Al publicar por primera vez se avisa a los inscriptos activos (la notificación lleva al portal, sección bonos).
      if (cambios.sorteo_publicado === 1 && Number(olimpiada.sorteo_publicado) !== 1) {
        await notificarInscriptosOlimpiada(
          connection,
          olimpiadaId,
          "OLIMPIADA_NOVEDAD",
          "Ya están los resultados del sorteo del bono contribución",
          `${olimpiada.nombre}: entrá al portal de la edición para ver los premios y sus ganadores.`,
          { olimpiada_id: olimpiadaId, seccion: "bonos" }
        );
      }
    });
    const olimpiada = await exigirOlimpiada(db, olimpiadaId);
    return res.status(200).json(await armarRespuestaPremios(db, olimpiada, cabecera));
  } catch (error) {
    return responderError(res, error, "Error al guardar el sorteo");
  }
});

router.__test = Object.freeze({
  MAX_NUMERO_BONO,
  MAX_CANTIDAD_AUTOMATICA,
  MAX_NUMEROS_POR_OPERACION,
  MAX_PREMIOS,
  COLUMNAS_CSV,
  rangoDeOlimpiada,
  padNumero,
  ordenarBloques,
  elegirNumerosLibres,
  validarBloque,
  validarRangoNumeracion,
  parsearPremios,
  describirNumeros,
  formatearFechaHora,
  escaparCsv,
  armarCsvBonos,
  clasificarNumero,
  normalizarCamposComprador,
  normalizarVenta,
  normalizarEdicionBono,
  normalizarReglasEntrada,
  describirTramos,
  condicionBusquedaBonos,
  leerEnteroQuery,
  armarReglas,
  mapearBonoVendido,
});

module.exports = router;
