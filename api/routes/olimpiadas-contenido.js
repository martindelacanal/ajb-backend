/**
 * Contenido del portal de una edición de Olimpiadas: novedades, cronograma y actividades, sedes y
 * hoteles, contactos, secciones de texto, enlaces, fixture con resultados en vivo, medallero y
 * galería de fotos.
 *
 * Lecturas: cualquier rol autenticado (el afiliado ve sólo lo publicado/visible).
 * Escrituras: administración provincial (admin y admin-central) → esSuperior, si no 401.
 * Errores como string JSON (res.status(n).json("mensaje")); escrituras responden { success, id?, message }.
 */
const express = require("express");
const mysqlConnection = require("../connection/connection");
const { registrarErrorRuta } = require("../services/errores");
const { normalizarFechaCivil } = require("../services/valores-dominio");
const { SECCIONES_INICIALES } = require("../data/olimpiadas-plantillas");
const {
  verifyToken,
  getCabecera,
  esStaff,
  esSuperior,
  crearErrorHttp,
  responderError,
  normalizarTexto,
  normalizarIdPositivo,
  normalizarEnteroNoNegativo,
  normalizarBooleano01,
  normalizarIds,
  normalizarHora,
  normalizarUrl,
  fechaHoyBuenosAires,
  estaVentanaInscripcionAbierta,
  registrarHistorial,
  notificarInscriptosOlimpiada,
  obtenerOlimpiada,
  firmarSeguro,
  subirImagenOptimizada,
  eliminarObjetosS3Seguro,
  crearUploadOlimpiadas,
  manejarUploadOlimpiadas,
  SQL_ESTADOS_ACTIVOS,
} = require("../services/olimpiadas-comun");

const router = express.Router();
const db = mysqlConnection.promise();

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const TIPOS_SEDE = ["HOTEL", "DEPORTIVA", "OTRA"];
const TIPOS_EVENTO = ["GENERAL", "ACTIVIDAD"];
const UBICACIONES_SECCION = ["INFO", "REGLAMENTO", "BONOS", "DATOS_UTILES"];
const TIPOS_ENLACE = ["VIDEOS", "OTRO"];
const ESTADOS_PARTIDO = ["PROGRAMADO", "EN_JUEGO", "FINALIZADO", "SUSPENDIDO"];
const MAX_FOTOS_POR_LOTE = 20;
const MAX_TOTAL_FOTOS_BYTES = 80 * 1024 * 1024;
const MAX_IDS_LOTE_FOTOS = 200;
const MAX_LINEAS_IMPORTACION = 500;
const PAGE_SIZE_FOTOS = 24;
const MAX_PAGE_SIZE_FOTOS = 60;
const MAX_TEXTO_HISTORIAL = 500;

const manejarUploadFotos = crearUploadOlimpiadas({ maxFiles: MAX_FOTOS_POR_LOTE, maxTotalBytes: MAX_TOTAL_FOTOS_BYTES });

// Tablas hijas que se leen por id con `obtenerFila` (whitelist: el nombre va interpolado en el SQL).
const TABLAS_CONTENIDO = new Set([
  "olimpiada_novedad",
  "olimpiada_evento",
  "olimpiada_sede",
  "olimpiada_contacto",
  "olimpiada_seccion",
  "olimpiada_enlace",
  "olimpiada_partido",
  "olimpiada_foto",
]);

// ---------------------------------------------------------------------------
// Acceso y utilidades generales
// ---------------------------------------------------------------------------
function esAfiliado(cabecera) {
  return cabecera.rol === "afiliado";
}

// Escrituras: sólo administración provincial. Responde 401 y devuelve null si no corresponde.
function exigirSuperior(req, res) {
  const cabecera = getCabecera(req);
  if (!esSuperior(cabecera)) {
    res.status(401).json("No autorizado");
    return null;
  }
  return cabecera;
}

// Mismo gate como middleware: va ANTES de multer para no recibir archivos de quien no puede escribir.
function soloSuperior(req, res, next) {
  if (!esSuperior(getCabecera(req))) return res.status(401).json("No autorizado");
  return next();
}

function idDeRuta(valor) {
  const id = normalizarIdPositivo(valor);
  if (!id) throw crearErrorHttp("ID inválido");
  return id;
}

function capitalizar(texto) {
  const valor = String(texto || "");
  return valor.charAt(0).toUpperCase() + valor.slice(1);
}

function recortar(texto, maximo = MAX_TEXTO_HISTORIAL) {
  if (texto === null || texto === undefined) return null;
  const valor = String(texto);
  return valor.length <= maximo ? valor : `${valor.slice(0, maximo - 1)}…`;
}

// Primeros N caracteres de un texto en una sola línea (mensaje de notificación).
function resumenTexto(texto, maximo = 200) {
  const plano = String(texto || "").replace(/\s+/g, " ").trim();
  if (plano.length <= maximo) return plano;
  return `${plano.slice(0, maximo - 1)}…`;
}

async function cargarOlimpiada(conexion, olimpiadaId, cabecera, { forUpdate = false } = {}) {
  const olimpiada = await obtenerOlimpiada(conexion, olimpiadaId, { forUpdate });
  if (!olimpiada || (esAfiliado(cabecera) && olimpiada.habilitado !== "Y")) {
    throw crearErrorHttp("La olimpiada no existe", 404);
  }
  return olimpiada;
}

async function obtenerFila(conexion, tabla, id, { conEliminado = true } = {}) {
  if (!TABLAS_CONTENIDO.has(tabla)) throw new Error(`Tabla no permitida: ${tabla}`);
  const [rows] = await conexion.query(
    `SELECT * FROM ${tabla} WHERE id = ?${conEliminado ? " AND eliminado = 0" : ""}`,
    [id]
  );
  return rows[0] || null;
}

async function exigirFila(conexion, tabla, id, mensaje) {
  const fila = await obtenerFila(conexion, tabla, id);
  if (!fila) throw crearErrorHttp(mensaje, 404);
  return fila;
}

async function enTransaccion(trabajo) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const resultado = await trabajo(connection);
    await connection.commit();
    return resultado;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (errorRollback) {
      registrarErrorRuta(errorRollback, "olimpiadas-contenido:rollback");
    }
    throw error;
  } finally {
    connection.release();
  }
}

// Historial: siempre con el actor de la cabecera.
async function historial(connection, cabecera, datos) {
  await registrarHistorial(connection, {
    usuario_id: cabecera.id,
    usuario_rol: cabecera.rol,
    ...datos,
    valor_anterior: recortar(datos.valor_anterior),
    valor_nuevo: recortar(datos.valor_nuevo),
  });
}

// Date → "YYYY-MM-DD HH:MM:SS" en hora de Buenos Aires (misma zona con la que graba la BD).
function fechaHoraTexto(fecha) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(fecha);
  const p = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function textoComparable(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : fechaHoraTexto(valor);
  return String(valor);
}

// Un renglón UPDATE por campo que cambió.
async function historialCambios(connection, cabecera, base, anterior, nuevo, campos) {
  for (const campo of campos) {
    const antes = textoComparable(anterior[campo]);
    const despues = textoComparable(nuevo[campo]);
    if (antes === despues) continue;
    await historial(connection, cabecera, {
      ...base,
      tipo_operacion: "UPDATE",
      campo_modificado: campo,
      valor_anterior: antes,
      valor_nuevo: despues,
    });
  }
}

function archivoDeSlot(req, slot) {
  return (req.files || []).find((file) => String(file.fieldname || "").toUpperCase() === slot) || null;
}

function archivosDeSlot(req, slot) {
  return (req.files || []).filter((file) => String(file.fieldname || "").toUpperCase() === slot);
}

// ---------------------------------------------------------------------------
// Lectura de campos: body + fila base (POST → defaults, PUT → fila actual). Sólo pisa lo que viene.
// ---------------------------------------------------------------------------
function leerTexto(body, nombre, base, { maximo = null, requerido = false, etiqueta = nombre } = {}) {
  let valor;
  if (body[nombre] === undefined) valor = base[nombre] ?? null;
  else if (body[nombre] === null) valor = null;
  else if (typeof body[nombre] === "string" || typeof body[nombre] === "number") valor = normalizarTexto(String(body[nombre]));
  else throw crearErrorHttp(`${capitalizar(etiqueta)} tiene un formato inválido`);
  if (valor !== null && maximo && valor.length > maximo) {
    throw crearErrorHttp(`${capitalizar(etiqueta)} supera los ${maximo} caracteres`);
  }
  if (requerido && !valor) throw crearErrorHttp(`Ingresá ${etiqueta}`);
  return valor;
}

function leerEntero(body, nombre, base, { porDefecto = 0, maximo = 1_000_000, etiqueta = nombre } = {}) {
  if (body[nombre] === undefined) return base[nombre] ?? porDefecto;
  if (body[nombre] === null || body[nombre] === "") return porDefecto;
  const valor = normalizarEnteroNoNegativo(body[nombre]);
  if (valor === null || valor > maximo) throw crearErrorHttp(`${capitalizar(etiqueta)} debe ser un entero entre 0 y ${maximo}`);
  return valor;
}

function leerFlag(body, nombre, base, porDefecto) {
  if (body[nombre] === undefined) return base[nombre] ?? porDefecto;
  const valor = normalizarBooleano01(body[nombre]);
  return valor === null ? porDefecto : valor;
}

function leerFecha(body, nombre, base, { requerido = false, etiqueta = nombre } = {}) {
  let valor;
  if (body[nombre] === undefined) valor = base[nombre] ? normalizarFechaCivil(base[nombre]) : null;
  else if (body[nombre] === null || body[nombre] === "") valor = null;
  else {
    valor = normalizarFechaCivil(body[nombre]);
    if (!valor) throw crearErrorHttp(`${capitalizar(etiqueta)} debe tener formato YYYY-MM-DD`);
  }
  if (requerido && !valor) throw crearErrorHttp(`Ingresá ${etiqueta}`);
  return valor;
}

function leerHora(body, nombre, base, { etiqueta = nombre } = {}) {
  if (body[nombre] === undefined) return base[nombre] ?? null;
  const valor = normalizarHora(body[nombre]);
  if (valor === undefined) throw crearErrorHttp(`${capitalizar(etiqueta)} debe tener formato HH:MM`);
  return valor;
}

// null o "" cuentan como "no vino" (el front manda `tipo: null` cuando no eligió nada).
function leerEnum(body, nombre, base, valores, { porDefecto = null, etiqueta = nombre } = {}) {
  if (body[nombre] === undefined || body[nombre] === null || body[nombre] === "") {
    const valor = base[nombre] ?? porDefecto;
    if (!valor) throw crearErrorHttp(`Indicá ${etiqueta}`);
    return valor;
  }
  const valor = String(body[nombre] ?? "").trim().toUpperCase();
  if (!valores.includes(valor)) throw crearErrorHttp(`${capitalizar(etiqueta)} debe ser uno de: ${valores.join(", ")}`);
  return valor;
}

function leerIdOpcional(body, nombre, base, { etiqueta = nombre } = {}) {
  if (body[nombre] === undefined) return base[nombre] ?? null;
  if (body[nombre] === null || body[nombre] === "" || body[nombre] === 0 || body[nombre] === "0") return null;
  const valor = normalizarIdPositivo(body[nombre]);
  if (!valor) throw crearErrorHttp(`${capitalizar(etiqueta)} es inválido`);
  return valor;
}

function leerUrl(body, nombre, base, { maximo = 600, requerido = false, etiqueta = nombre } = {}) {
  let valor;
  if (body[nombre] === undefined) valor = base[nombre] ?? null;
  else {
    valor = normalizarUrl(body[nombre], maximo);
    if (valor === undefined) throw crearErrorHttp(`${capitalizar(etiqueta)} debe ser una dirección http(s) válida`);
  }
  if (requerido && !valor) throw crearErrorHttp(`Ingresá ${etiqueta}`);
  return valor;
}

// "YYYY-MM-DD", "YYYY-MM-DD HH:MM" o "YYYY-MM-DDTHH:MM[:SS]" → "YYYY-MM-DD HH:MM:SS".
// undefined = no vino; null = vacío; false = inválida.
function normalizarFechaHora(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2})(?::(\d{2}))?)?$/.exec(String(valor).trim());
  if (!match) return false;
  const fecha = normalizarFechaCivil(match[1]);
  const hora = normalizarHora(match[2] ? `${match[2]}${match[3] ? `:${match[3]}` : ""}` : "00:00");
  if (!fecha || !hora) return false;
  return `${fecha} ${hora}`;
}

// ---------------------------------------------------------------------------
// Validaciones contra la BD
// ---------------------------------------------------------------------------
async function validarSedeDeOlimpiada(conexion, olimpiadaId, sedeId) {
  if (!sedeId) return null;
  const [rows] = await conexion.query(
    "SELECT id, tipo, nombre FROM olimpiada_sede WHERE id = ? AND olimpiada_id = ? AND eliminado = 0",
    [sedeId, olimpiadaId]
  );
  if (rows.length === 0) throw crearErrorHttp("La sede elegida no pertenece a esta olimpiada", 404);
  return rows[0];
}

async function validarDepartamentales(conexion, ids) {
  if (!ids || ids.length === 0) return [];
  const [rows] = await conexion.query("SELECT id, nombre FROM departamental WHERE id IN (?)", [ids]);
  if (rows.length !== ids.length) throw crearErrorHttp("Hay departamentales inexistentes en la lista");
  return rows;
}

async function validarDepartamentalOpcional(conexion, id, etiqueta) {
  if (!id) return null;
  const [rows] = await conexion.query("SELECT id, nombre FROM departamental WHERE id = ?", [id]);
  if (rows.length === 0) throw crearErrorHttp(`${capitalizar(etiqueta)} no existe`, 404);
  return rows[0];
}

async function validarDisciplinaDeOlimpiada(conexion, olimpiadaId, disciplinaId) {
  const [rows] = await conexion.query(
    `SELECT c.id, c.disciplina_id, d.nombre, c.sede_id, c.veedor, c.reglamento
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     WHERE c.olimpiada_id = ? AND c.disciplina_id = ?`,
    [olimpiadaId, disciplinaId]
  );
  if (rows.length === 0) throw crearErrorHttp("La disciplina no forma parte de esta olimpiada", 404);
  return rows[0];
}

async function validarDisciplinaCatalogo(conexion, disciplinaId) {
  if (!disciplinaId) return null;
  const [rows] = await conexion.query("SELECT id, nombre FROM olimpiada_disciplina WHERE id = ?", [disciplinaId]);
  if (rows.length === 0) throw crearErrorHttp("La disciplina elegida no existe", 404);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Helpers puros (exportados en router.__test)
// ---------------------------------------------------------------------------

// Estado de la edición según la fecha civil de hoy (misma regla que calcularEstadoEdicion de
// GET /olimpiadas/ediciones: fechas inclusivas, hoy en Buenos Aires).
function estadoEdicion(olimpiada, hoy = fechaHoyBuenosAires()) {
  const fecha = normalizarFechaCivil(hoy) || fechaHoyBuenosAires();
  const inicio = normalizarFechaCivil(olimpiada?.fecha_inicio);
  const fin = normalizarFechaCivil(olimpiada?.fecha_fin) || inicio;
  const inscripcionInicio = normalizarFechaCivil(olimpiada?.fecha_inicio_inscripcion);
  const inscripcionFin = normalizarFechaCivil(olimpiada?.fecha_fin_inscripcion);
  if (fin && fecha > fin) return "FINALIZADA";
  if (inicio && fecha >= inicio) return "EN_CURSO";
  if (inscripcionInicio && inscripcionFin && inscripcionInicio <= fecha && fecha <= inscripcionFin) return "INSCRIPCION_ABIERTA";
  if (inscripcionInicio && fecha < inscripcionInicio) return "PROXIMA";
  return "INSCRIPCION_CERRADA";
}

// Columnas de una línea pegada desde una planilla: TAB, "|" o 2+ espacios.
function dividirColumnas(linea) {
  const texto = String(linea || "").replace(/\r$/, "");
  let partes;
  if (texto.includes("\t")) partes = texto.split("\t");
  else if (texto.includes("|")) partes = texto.split("|");
  else partes = texto.trim().split(/\s{2,}/);
  return partes.map((parte) => parte.trim());
}

// "—", "-", "–" o vacío = sin dato.
function esColumnaVacia(valor) {
  const texto = String(valor ?? "").trim();
  return texto.length === 0 || /^[-—–]+$/.test(texto);
}

// dd/mm/yyyy, dd/mm/yy, dd-mm-yyyy o yyyy-mm-dd → "YYYY-MM-DD". null si no parsea.
function parsearFechaFlexible(texto) {
  const valor = String(texto ?? "").trim();
  let match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(valor);
  if (match) {
    const anio = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return normalizarFechaCivil(`${anio}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`);
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(valor);
  if (match) {
    return normalizarFechaCivil(`${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`);
  }
  return null;
}

// "10:00", "10.30", "9", "14 hs" → "HH:MM:SS". null si está vacía o no se entiende.
function parsearHoraFlexible(texto) {
  if (esColumnaVacia(texto)) return null;
  const valor = String(texto)
    .trim()
    .toLowerCase()
    .replace(/\s*(hs|h|horas)\.?$/, "")
    .replace(".", ":");
  if (/^\d{1,2}$/.test(valor)) return normalizarHora(`${valor}:00`) ?? null;
  const hora = normalizarHora(valor);
  return hora === undefined ? null : hora;
}

function lineasDe(texto) {
  return String(texto || "")
    .split(/\r?\n/)
    .map((linea) => linea.replace(/\s+$/, ""))
    .filter((linea) => linea.trim().length > 0);
}

/**
 * Cronograma pegado desde una planilla: `fecha, inicio, fin, actividad, lugar` por línea.
 * Una línea sin fecha (vacía o "—") hereda la fecha de la línea anterior. Las que no se entienden
 * (encabezados, líneas sueltas) se cuentan en `ignoradas`.
 */
function parsearEventosTexto(texto) {
  const eventos = [];
  let ignoradas = 0;
  let fechaActual = null;
  for (const linea of lineasDe(texto)) {
    const columnas = dividirColumnas(linea);
    let fecha = parsearFechaFlexible(columnas[0]);
    let resto = columnas.slice(1);
    if (!fecha) {
      if (esColumnaVacia(columnas[0]) && fechaActual) fecha = fechaActual;
      else {
        ignoradas += 1;
        continue;
      }
    }
    if (resto.length < 3) {
      ignoradas += 1;
      continue;
    }
    const titulo = normalizarTexto(resto[2], 160);
    if (!titulo) {
      ignoradas += 1;
      continue;
    }
    fechaActual = fecha;
    eventos.push({
      fecha,
      hora_inicio: parsearHoraFlexible(resto[0]),
      hora_fin: parsearHoraFlexible(resto[1]),
      titulo,
      lugar: esColumnaVacia(resto[3]) ? null : normalizarTexto(resto[3], 160),
    });
  }
  return { eventos, ignoradas };
}

/**
 * Partidos pegados desde una planilla: `fecha, inicio, fin, etiqueta, participante1, participante2`.
 * La fecha puede venir vacía ("—") para partidos sin programar; un texto que no es fecha se ignora.
 */
function parsearPartidosTexto(texto) {
  const partidos = [];
  let ignoradas = 0;
  for (const linea of lineasDe(texto)) {
    const columnas = dividirColumnas(linea);
    if (columnas.length < 6) {
      ignoradas += 1;
      continue;
    }
    const fecha = esColumnaVacia(columnas[0]) ? null : parsearFechaFlexible(columnas[0]);
    if (fecha === null && !esColumnaVacia(columnas[0])) {
      ignoradas += 1;
      continue;
    }
    const participante1 = normalizarTexto(columnas[4], 120);
    const participante2 = normalizarTexto(columnas[5], 120);
    if (!participante1 || !participante2) {
      ignoradas += 1;
      continue;
    }
    partidos.push({
      fecha,
      hora_inicio: parsearHoraFlexible(columnas[1]),
      hora_fin: parsearHoraFlexible(columnas[2]),
      etiqueta: esColumnaVacia(columnas[3]) ? null : normalizarTexto(columnas[3], 40),
      participante1,
      participante2,
    });
  }
  return { partidos, ignoradas };
}

function resultadoNumerico(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(texto)) return null;
  return Number(texto);
}

// 1 = gana participante1, 2 = participante2, 0 = empate, null = no se puede calcular.
function calcularGanadorPartido(resultado1, resultado2) {
  const r1 = resultadoNumerico(resultado1);
  const r2 = resultadoNumerico(resultado2);
  if (r1 === null || r2 === null) return null;
  if (r1 > r2) return 1;
  if (r2 > r1) return 2;
  return 0;
}

function leerGanador(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === "") return null;
  const numero = Number(valor);
  if (![0, 1, 2].includes(numero)) throw crearErrorHttp("El ganador debe ser 1, 2 o 0 (empate)");
  return numero;
}

/**
 * Tabla de posiciones del medallero. `medallas`: [{ disciplina_id, puesto, departamental_id, nombre }].
 * Interdepartamentalidad: los puntos de un puesto compartido se dividen en partes iguales entre las
 * departamentales de ese puesto, pero la medalla cuenta 1 para cada una.
 */
function calcularTablaMedallero(medallas, puntos) {
  const puntosPorPuesto = {
    1: Number(puntos?.oro) || 0,
    2: Number(puntos?.plata) || 0,
    3: Number(puntos?.bronce) || 0,
  };
  const compartidos = new Map();
  for (const medalla of medallas || []) {
    const clave = `${medalla.disciplina_id}:${medalla.puesto}`;
    compartidos.set(clave, (compartidos.get(clave) || 0) + 1);
  }
  const tabla = new Map();
  for (const medalla of medallas || []) {
    const id = Number(medalla.departamental_id);
    if (!tabla.has(id)) tabla.set(id, { departamental_id: id, nombre: medalla.nombre, oro: 0, plata: 0, bronce: 0, puntos: 0 });
    const fila = tabla.get(id);
    const puesto = Number(medalla.puesto);
    if (puesto === 1) fila.oro += 1;
    else if (puesto === 2) fila.plata += 1;
    else if (puesto === 3) fila.bronce += 1;
    const cantidad = compartidos.get(`${medalla.disciplina_id}:${medalla.puesto}`) || 1;
    fila.puntos += (puntosPorPuesto[puesto] || 0) / cantidad;
  }
  return [...tabla.values()]
    .map((fila) => ({ ...fila, puntos: Math.round(fila.puntos * 100) / 100 }))
    .sort(
      (a, b) =>
        b.puntos - a.puntos ||
        b.oro - a.oro ||
        b.plata - a.plata ||
        b.bronce - a.bronce ||
        String(a.nombre).localeCompare(String(b.nombre), "es")
    );
}

// Detalle por disciplina: siempre los tres puestos, con las departamentales de cada uno.
function agruparMedallasPorDisciplina(disciplinas, medallas) {
  const porDisciplina = new Map();
  for (const disciplina of disciplinas || []) {
    porDisciplina.set(Number(disciplina.id), {
      disciplina_id: Number(disciplina.id),
      disciplina_nombre: disciplina.nombre,
      puestos: [1, 2, 3].map((puesto) => ({ puesto, departamentales: [] })),
    });
  }
  for (const medalla of medallas || []) {
    const id = Number(medalla.disciplina_id);
    if (!porDisciplina.has(id)) {
      porDisciplina.set(id, {
        disciplina_id: id,
        disciplina_nombre: medalla.disciplina_nombre,
        puestos: [1, 2, 3].map((puesto) => ({ puesto, departamentales: [] })),
      });
    }
    const puesto = porDisciplina.get(id).puestos.find((p) => p.puesto === Number(medalla.puesto));
    if (puesto) puesto.departamentales.push({ id: Number(medalla.departamental_id), nombre: medalla.nombre });
  }
  return [...porDisciplina.values()].sort((a, b) => String(a.disciplina_nombre).localeCompare(String(b.disciplina_nombre), "es"));
}

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/portal", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const afiliado = esAfiliado(cabecera);
    const condicionNovedades = afiliado ? "AND n.publicada = 1 AND n.fecha_publicacion <= NOW()" : "";
    const condicionSecciones = afiliado ? "AND s.visible = 1" : "";
    const [[conteos]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM olimpiada_novedad n WHERE n.olimpiada_id = ? AND n.eliminado = 0 ${condicionNovedades}) AS novedades,
         (SELECT COUNT(*) FROM olimpiada_evento e WHERE e.olimpiada_id = ? AND e.eliminado = 0) AS eventos,
         (SELECT COUNT(*) FROM olimpiada_partido p WHERE p.olimpiada_id = ? AND p.eliminado = 0) AS partidos,
         (SELECT COUNT(*) FROM olimpiada_partido p WHERE p.olimpiada_id = ? AND p.eliminado = 0 AND p.estado = 'EN_JUEGO') AS en_vivo,
         (SELECT COUNT(*) FROM olimpiada_foto f WHERE f.olimpiada_id = ? AND f.eliminado = 0) AS fotos,
         (SELECT COUNT(*) FROM olimpiada_medalla m WHERE m.olimpiada_id = ?) AS medallas,
         (SELECT COUNT(*) FROM olimpiada_sede s WHERE s.olimpiada_id = ? AND s.eliminado = 0 AND s.tipo <> 'HOTEL') AS sedes,
         (SELECT COUNT(*) FROM olimpiada_sede s WHERE s.olimpiada_id = ? AND s.eliminado = 0 AND s.tipo = 'HOTEL') AS hoteles,
         (SELECT COUNT(*) FROM olimpiada_contacto c WHERE c.olimpiada_id = ? AND c.eliminado = 0) AS contactos,
         (SELECT COUNT(*) FROM olimpiada_premio pr WHERE pr.olimpiada_id = ?) AS premios,
         (SELECT COUNT(*) FROM olimpiada_enlace l WHERE l.olimpiada_id = ? AND l.eliminado = 0) AS enlaces,
         (SELECT COUNT(*) FROM olimpiada_seccion s WHERE s.olimpiada_id = ? AND s.eliminado = 0 AND s.ubicacion = 'REGLAMENTO' ${condicionSecciones}) AS secciones_reglamento`,
      Array(12).fill(olimpiadaId)
    );
    const [videos] = await db.query(
      "SELECT id, titulo, url FROM olimpiada_enlace WHERE olimpiada_id = ? AND eliminado = 0 AND tipo = 'VIDEOS' ORDER BY orden, id",
      [olimpiadaId]
    );
    const [inscripciones] = await db.query(
      `SELECT id, estado FROM olimpiada_inscripcion
       WHERE olimpiada_id = ? AND usuario_id = ? AND eliminado = 0
       ORDER BY (estado IN ${SQL_ESTADOS_ACTIVOS}) DESC, id DESC LIMIT 1`,
      [olimpiadaId, cabecera.id]
    );
    const departamentalId = normalizarIdPositivo(cabecera.departamental_id);
    let hotelesMiDepartamental = [];
    if (departamentalId) {
      const [hoteles] = await db.query(
        `SELECT s.id, s.nombre, s.direccion, s.telefono
         FROM olimpiada_sede s
         INNER JOIN olimpiada_sede_departamental sd ON sd.sede_id = s.id
         WHERE s.olimpiada_id = ? AND s.eliminado = 0 AND s.tipo = 'HOTEL' AND sd.departamental_id = ?
         ORDER BY s.orden, s.nombre`,
        [olimpiadaId, departamentalId]
      );
      hotelesMiDepartamental = hoteles;
    }
    const conteosNumericos = Object.fromEntries(Object.entries(conteos).map(([clave, valor]) => [clave, Number(valor) || 0]));
    res.status(200).json({
      olimpiada: {
        id: olimpiada.id,
        nombre: olimpiada.nombre,
        edicion: olimpiada.edicion,
        localidad: olimpiada.localidad,
        descripcion: olimpiada.descripcion,
        fecha_inicio: olimpiada.fecha_inicio,
        fecha_fin: olimpiada.fecha_fin,
        fecha_inicio_inscripcion: olimpiada.fecha_inicio_inscripcion,
        fecha_fin_inscripcion: olimpiada.fecha_fin_inscripcion,
        inscripcion_abierta: estaVentanaInscripcionAbierta(olimpiada),
        estado: estadoEdicion(olimpiada),
        valor_bono: Number(olimpiada.valor_bono) || 0,
        bonos_afiliado: Number(olimpiada.bonos_afiliado) || 0,
        fecha_sorteo: olimpiada.fecha_sorteo,
        sorteo_publicado: Number(olimpiada.sorteo_publicado) || 0,
        videos,
      },
      mi_inscripcion: inscripciones[0] ? { id: inscripciones[0].id, estado: inscripciones[0].estado } : null,
      conteos: conteosNumericos,
      hoteles_mi_departamental: hotelesMiDepartamental,
      departamental_id: departamentalId,
    });
  } catch (error) {
    responderError(res, error, "No se pudo cargar el portal de la olimpiada");
  }
});

// ---------------------------------------------------------------------------
// Novedades
// ---------------------------------------------------------------------------
const SELECT_NOVEDAD = `
  SELECT n.id, n.olimpiada_id, n.titulo, n.cuerpo, n.imagen_archivo, n.publicada, n.fijada, n.notificada,
         n.fecha_publicacion, n.fecha_creacion, n.fecha_modificacion,
         u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
  FROM olimpiada_novedad n
  LEFT JOIN usuario u ON u.id = n.usuario_id`;

async function serializarNovedad(fila) {
  return {
    id: fila.id,
    olimpiada_id: fila.olimpiada_id,
    titulo: fila.titulo,
    cuerpo: fila.cuerpo,
    imagen_url: await firmarSeguro(fila.imagen_archivo),
    // olimpiada_novedad no guarda dimensiones: el front reserva espacio con proporción por defecto.
    imagen_ancho: null,
    imagen_alto: null,
    publicada: Number(fila.publicada),
    fijada: Number(fila.fijada),
    notificada: Number(fila.notificada),
    fecha_publicacion: fila.fecha_publicacion,
    fecha_creacion: fila.fecha_creacion,
    fecha_modificacion: fila.fecha_modificacion,
    usuario_nombre: fila.usuario_nombre || null,
    usuario_apellido: fila.usuario_apellido || null,
  };
}

function leerNovedad(body, base) {
  const fechaPublicacion = normalizarFechaHora(body.fecha_publicacion);
  if (fechaPublicacion === false) throw crearErrorHttp("La fecha de publicación debe tener formato YYYY-MM-DD HH:MM");
  return {
    titulo: leerTexto(body, "titulo", base, { maximo: 180, requerido: true, etiqueta: "el título" }),
    cuerpo: leerTexto(body, "cuerpo", base, { maximo: 20000, requerido: true, etiqueta: "el cuerpo de la novedad" }),
    publicada: leerFlag(body, "publicada", base, 1),
    fijada: leerFlag(body, "fijada", base, 0),
    fecha_publicacion: fechaPublicacion === undefined ? base.fecha_publicacion ?? null : fechaPublicacion,
  };
}

async function novedadVisible(conexion, novedadId) {
  const [[fila]] = await conexion.query(
    "SELECT (publicada = 1 AND fecha_publicacion <= NOW()) AS visible FROM olimpiada_novedad WHERE id = ?",
    [novedadId]
  );
  return Number(fila?.visible) === 1;
}

async function notificarNovedad(connection, olimpiadaId, novedad) {
  return notificarInscriptosOlimpiada(
    connection,
    olimpiadaId,
    "OLIMPIADA_NOVEDAD",
    novedad.titulo,
    resumenTexto(novedad.cuerpo, 200),
    { olimpiada_id: olimpiadaId, novedad_id: novedad.id, seccion: "novedades" }
  );
}

router.get("/olimpiadas/:id(\\d+)/novedades", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const condicion = esAfiliado(cabecera) ? "AND n.publicada = 1 AND n.fecha_publicacion <= NOW()" : "";
    const [rows] = await db.query(
      `${SELECT_NOVEDAD} WHERE n.olimpiada_id = ? AND n.eliminado = 0 ${condicion}
       ORDER BY n.fijada DESC, n.fecha_publicacion DESC, n.id DESC`,
      [olimpiadaId]
    );
    res.status(200).json(await Promise.all(rows.map(serializarNovedad)));
  } catch (error) {
    responderError(res, error, "No se pudieron cargar las novedades");
  }
});

router.post("/olimpiadas/:id(\\d+)/novedades", verifyToken, soloSuperior, manejarUploadOlimpiadas, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  const subidas = [];
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const datos = leerNovedad(body, {});
    const notificar = normalizarBooleano01(body.notificar) === 1;
    const archivo = archivoDeSlot(req, "IMAGEN");
    let imagenArchivo = null;
    if (archivo) {
      const imagen = await subirImagenOptimizada(archivo, "contenido/novedad", { anchoMaximo: 1600 });
      subidas.push(...imagen.keys);
      imagenArchivo = imagen.key;
    }
    const resultado = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_novedad (olimpiada_id, titulo, cuerpo, imagen_archivo, publicada, fijada, usuario_id, fecha_publicacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))`,
        [olimpiadaId, datos.titulo, datos.cuerpo, imagenArchivo, datos.publicada, datos.fijada, cabecera.id, datos.fecha_publicacion]
      );
      const novedadId = insert.insertId;
      await historial(connection, cabecera, {
        entidad: "NOVEDAD",
        entidad_id: novedadId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: datos.titulo,
      });
      let destinatarios = null;
      if (notificar && (await novedadVisible(connection, novedadId))) {
        destinatarios = await notificarNovedad(connection, olimpiadaId, { id: novedadId, titulo: datos.titulo, cuerpo: datos.cuerpo });
        await connection.query("UPDATE olimpiada_novedad SET notificada = 1 WHERE id = ?", [novedadId]);
      }
      return { id: novedadId, destinatarios };
    });
    let message = "Novedad guardada";
    if (notificar && resultado.destinatarios === null) {
      message = "Novedad guardada. No se avisó a los inscriptos porque todavía no está publicada";
    } else if (notificar) {
      message = resultado.destinatarios > 0
        ? `Novedad publicada y avisada a ${resultado.destinatarios} inscriptos`
        : "Novedad publicada. Todavía no hay inscriptos activos para avisar";
    }
    res.status(201).json({ success: true, id: resultado.id, message, destinatarios: resultado.destinatarios });
  } catch (error) {
    await eliminarObjetosS3Seguro(subidas);
    responderError(res, error, "No se pudo crear la novedad");
  }
});

router.put("/olimpiadas/novedades/:novedadId(\\d+)", verifyToken, soloSuperior, manejarUploadOlimpiadas, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  const subidas = [];
  try {
    const novedadId = idDeRuta(req.params.novedadId);
    const actual = await exigirFila(db, "olimpiada_novedad", novedadId, "La novedad no existe");
    const body = req.body || {};
    const datos = leerNovedad(body, actual);
    const archivo = archivoDeSlot(req, "IMAGEN");
    const quitarImagen = normalizarBooleano01(body.quitar_imagen) === 1;
    let imagenArchivo = actual.imagen_archivo;
    if (archivo) {
      const imagen = await subirImagenOptimizada(archivo, "contenido/novedad", { anchoMaximo: 1600 });
      subidas.push(...imagen.keys);
      imagenArchivo = imagen.key;
    } else if (quitarImagen) {
      imagenArchivo = null;
    }
    const nuevo = { ...datos, imagen_archivo: imagenArchivo };
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_novedad
         SET titulo = ?, cuerpo = ?, imagen_archivo = ?, publicada = ?, fijada = ?, fecha_publicacion = COALESCE(?, NOW())
         WHERE id = ?`,
        [nuevo.titulo, nuevo.cuerpo, nuevo.imagen_archivo, nuevo.publicada, nuevo.fijada, nuevo.fecha_publicacion, novedadId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "NOVEDAD", entidad_id: novedadId, olimpiada_id: actual.olimpiada_id },
        actual,
        nuevo,
        ["titulo", "cuerpo", "imagen_archivo", "publicada", "fijada", "fecha_publicacion"]
      );
    });
    if (actual.imagen_archivo && actual.imagen_archivo !== imagenArchivo) await eliminarObjetosS3Seguro([actual.imagen_archivo]);
    res.status(200).json({ success: true, id: novedadId, message: "Novedad actualizada" });
  } catch (error) {
    await eliminarObjetosS3Seguro(subidas);
    responderError(res, error, "No se pudo actualizar la novedad");
  }
});

router.delete("/olimpiadas/novedades/:novedadId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const novedadId = idDeRuta(req.params.novedadId);
    const actual = await exigirFila(db, "olimpiada_novedad", novedadId, "La novedad no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_novedad SET eliminado = 1 WHERE id = ?", [novedadId]);
      await historial(connection, cabecera, {
        entidad: "NOVEDAD",
        entidad_id: novedadId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: actual.titulo,
      });
    });
    await eliminarObjetosS3Seguro([actual.imagen_archivo]);
    res.status(200).json({ success: true, message: "Novedad eliminada" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar la novedad");
  }
});

router.post("/olimpiadas/novedades/:novedadId(\\d+)/notificar", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const novedadId = idDeRuta(req.params.novedadId);
    const novedad = await exigirFila(db, "olimpiada_novedad", novedadId, "La novedad no existe");
    if (!(await novedadVisible(db, novedadId))) {
      throw crearErrorHttp("Publicá la novedad antes de avisar a los inscriptos", 409);
    }
    const destinatarios = await enTransaccion(async (connection) => {
      const cantidad = await notificarNovedad(connection, novedad.olimpiada_id, novedad);
      await connection.query("UPDATE olimpiada_novedad SET notificada = 1 WHERE id = ?", [novedadId]);
      await historial(connection, cabecera, {
        entidad: "NOVEDAD",
        entidad_id: novedadId,
        olimpiada_id: novedad.olimpiada_id,
        tipo_operacion: "MENSAJE_GENERAL",
        valor_nuevo: `Aviso a ${cantidad} inscriptos`,
      });
      return cantidad;
    });
    res.status(200).json({
      success: true,
      message: destinatarios > 0 ? `Se avisó a ${destinatarios} inscriptos` : "No hay inscriptos activos para avisar",
      destinatarios,
    });
  } catch (error) {
    responderError(res, error, "No se pudo avisar a los inscriptos");
  }
});

// ---------------------------------------------------------------------------
// Eventos: cronograma (GENERAL) y actividades (ACTIVIDAD)
// ---------------------------------------------------------------------------
const SELECT_EVENTO = `
  SELECT e.id, e.olimpiada_id, e.tipo, e.fecha, e.hora_inicio, e.hora_fin, e.titulo, e.descripcion, e.lugar,
         e.sede_id, s.nombre AS sede_nombre, e.imagen_archivo, e.orden, e.fecha_modificacion
  FROM olimpiada_evento e
  LEFT JOIN olimpiada_sede s ON s.id = e.sede_id AND s.eliminado = 0`;

async function serializarEvento(fila) {
  return {
    id: fila.id,
    olimpiada_id: fila.olimpiada_id,
    tipo: fila.tipo,
    fecha: fila.fecha,
    hora_inicio: fila.hora_inicio,
    hora_fin: fila.hora_fin,
    titulo: fila.titulo,
    descripcion: fila.descripcion,
    lugar: fila.lugar,
    sede_id: fila.sede_id,
    sede_nombre: fila.sede_nombre || null,
    imagen_url: await firmarSeguro(fila.imagen_archivo),
    orden: fila.orden,
    fecha_modificacion: fila.fecha_modificacion,
  };
}

function leerEvento(body, base) {
  return {
    tipo: leerEnum(body, "tipo", base, TIPOS_EVENTO, { porDefecto: "GENERAL", etiqueta: "el tipo de evento" }),
    fecha: leerFecha(body, "fecha", base, { requerido: true, etiqueta: "la fecha" }),
    hora_inicio: leerHora(body, "hora_inicio", base, { etiqueta: "la hora de inicio" }),
    hora_fin: leerHora(body, "hora_fin", base, { etiqueta: "la hora de fin" }),
    titulo: leerTexto(body, "titulo", base, { maximo: 160, requerido: true, etiqueta: "el título" }),
    descripcion: leerTexto(body, "descripcion", base, { maximo: 20000, etiqueta: "la descripción" }),
    lugar: leerTexto(body, "lugar", base, { maximo: 160, etiqueta: "el lugar" }),
    sede_id: leerIdOpcional(body, "sede_id", base, { etiqueta: "la sede" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
  };
}

router.get("/olimpiadas/:id(\\d+)/eventos", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const condiciones = ["e.olimpiada_id = ?", "e.eliminado = 0"];
    const params = [olimpiadaId];
    if (req.query.tipo !== undefined && req.query.tipo !== "") {
      const tipo = String(req.query.tipo).toUpperCase();
      if (!TIPOS_EVENTO.includes(tipo)) return res.status(400).json("El tipo de evento debe ser GENERAL o ACTIVIDAD");
      condiciones.push("e.tipo = ?");
      params.push(tipo);
    }
    const [rows] = await db.query(
      `${SELECT_EVENTO} WHERE ${condiciones.join(" AND ")}
       ORDER BY e.fecha, e.hora_inicio IS NULL, e.hora_inicio, e.orden, e.id`,
      params
    );
    res.status(200).json(await Promise.all(rows.map(serializarEvento)));
  } catch (error) {
    responderError(res, error, "No se pudo cargar el cronograma");
  }
});

router.post("/olimpiadas/:id(\\d+)/eventos", verifyToken, soloSuperior, manejarUploadOlimpiadas, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  const subidas = [];
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const datos = leerEvento(req.body || {}, {});
    await validarSedeDeOlimpiada(db, olimpiadaId, datos.sede_id);
    const archivo = archivoDeSlot(req, "IMAGEN");
    let imagenArchivo = null;
    if (archivo) {
      const imagen = await subirImagenOptimizada(archivo, "contenido/evento", { anchoMaximo: 1600 });
      subidas.push(...imagen.keys);
      imagenArchivo = imagen.key;
    }
    const eventoId = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_evento (olimpiada_id, tipo, fecha, hora_inicio, hora_fin, titulo, descripcion, lugar, sede_id, imagen_archivo, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.tipo, datos.fecha, datos.hora_inicio, datos.hora_fin, datos.titulo, datos.descripcion, datos.lugar, datos.sede_id, imagenArchivo, datos.orden]
      );
      await historial(connection, cabecera, {
        entidad: "EVENTO",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: `${datos.fecha} ${datos.titulo}`,
      });
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: eventoId, message: datos.tipo === "ACTIVIDAD" ? "Actividad guardada" : "Evento agregado al cronograma" });
  } catch (error) {
    await eliminarObjetosS3Seguro(subidas);
    responderError(res, error, "No se pudo crear el evento");
  }
});

router.post("/olimpiadas/:id(\\d+)/eventos/importar", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const texto = typeof body.texto === "string" ? body.texto : "";
    if (!texto.trim()) return res.status(400).json("Pegá el cronograma en el cuadro de texto");
    const tipo = leerEnum(body, "tipo", {}, TIPOS_EVENTO, { porDefecto: "GENERAL", etiqueta: "el tipo de evento" });
    const { eventos, ignoradas } = parsearEventosTexto(texto);
    if (eventos.length === 0) {
      return res.status(400).json(
        "No se reconoció ninguna línea. Usá una línea por evento con las columnas fecha, inicio, fin, actividad y lugar separadas por TAB, \"|\" o dos espacios (ej.: 28/11/2024 | 10:00 | — | Check in hoteles | Hoteles)"
      );
    }
    if (eventos.length > MAX_LINEAS_IMPORTACION) return res.status(400).json(`Se pueden importar hasta ${MAX_LINEAS_IMPORTACION} eventos por vez`);
    const [sedes] = await db.query("SELECT id, nombre FROM olimpiada_sede WHERE olimpiada_id = ? AND eliminado = 0", [olimpiadaId]);
    const sedePorNombre = new Map(sedes.map((sede) => [String(sede.nombre).trim().toLowerCase(), sede.id]));
    const [[ultimo]] = await db.query("SELECT COALESCE(MAX(orden), 0) AS orden FROM olimpiada_evento WHERE olimpiada_id = ? AND eliminado = 0", [olimpiadaId]);
    let orden = Number(ultimo.orden) || 0;
    await enTransaccion(async (connection) => {
      for (const evento of eventos) {
        orden += 1;
        const sedeId = evento.lugar ? sedePorNombre.get(evento.lugar.toLowerCase()) || null : null;
        await connection.query(
          `INSERT INTO olimpiada_evento (olimpiada_id, tipo, fecha, hora_inicio, hora_fin, titulo, lugar, sede_id, orden)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [olimpiadaId, tipo, evento.fecha, evento.hora_inicio, evento.hora_fin, evento.titulo, evento.lugar, sedeId, orden]
        );
      }
      await historial(connection, cabecera, {
        entidad: "EVENTO",
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        campo_modificado: "importacion",
        valor_nuevo: `${eventos.length} eventos importados desde texto (${tipo})`,
      });
    });
    res.status(201).json({
      success: true,
      message: `Se importaron ${eventos.length} eventos${ignoradas > 0 ? ` (${ignoradas} líneas ignoradas)` : ""}`,
      creados: eventos.length,
      ignoradas,
    });
  } catch (error) {
    responderError(res, error, "No se pudo importar el cronograma");
  }
});

router.put("/olimpiadas/eventos/:eventoId(\\d+)", verifyToken, soloSuperior, manejarUploadOlimpiadas, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  const subidas = [];
  try {
    const eventoId = idDeRuta(req.params.eventoId);
    const actual = await exigirFila(db, "olimpiada_evento", eventoId, "El evento no existe");
    const body = req.body || {};
    const datos = leerEvento(body, actual);
    await validarSedeDeOlimpiada(db, actual.olimpiada_id, datos.sede_id);
    const archivo = archivoDeSlot(req, "IMAGEN");
    const quitarImagen = normalizarBooleano01(body.quitar_imagen) === 1;
    let imagenArchivo = actual.imagen_archivo;
    if (archivo) {
      const imagen = await subirImagenOptimizada(archivo, "contenido/evento", { anchoMaximo: 1600 });
      subidas.push(...imagen.keys);
      imagenArchivo = imagen.key;
    } else if (quitarImagen) {
      imagenArchivo = null;
    }
    const nuevo = { ...datos, imagen_archivo: imagenArchivo };
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_evento
         SET tipo = ?, fecha = ?, hora_inicio = ?, hora_fin = ?, titulo = ?, descripcion = ?, lugar = ?, sede_id = ?, imagen_archivo = ?, orden = ?
         WHERE id = ?`,
        [nuevo.tipo, nuevo.fecha, nuevo.hora_inicio, nuevo.hora_fin, nuevo.titulo, nuevo.descripcion, nuevo.lugar, nuevo.sede_id, nuevo.imagen_archivo, nuevo.orden, eventoId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "EVENTO", entidad_id: eventoId, olimpiada_id: actual.olimpiada_id },
        actual,
        nuevo,
        ["tipo", "fecha", "hora_inicio", "hora_fin", "titulo", "descripcion", "lugar", "sede_id", "imagen_archivo", "orden"]
      );
    });
    if (actual.imagen_archivo && actual.imagen_archivo !== imagenArchivo) await eliminarObjetosS3Seguro([actual.imagen_archivo]);
    res.status(200).json({ success: true, id: eventoId, message: "Evento actualizado" });
  } catch (error) {
    await eliminarObjetosS3Seguro(subidas);
    responderError(res, error, "No se pudo actualizar el evento");
  }
});

router.delete("/olimpiadas/eventos/:eventoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const eventoId = idDeRuta(req.params.eventoId);
    const actual = await exigirFila(db, "olimpiada_evento", eventoId, "El evento no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_evento SET eliminado = 1 WHERE id = ?", [eventoId]);
      await historial(connection, cabecera, {
        entidad: "EVENTO",
        entidad_id: eventoId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: `${actual.fecha} ${actual.titulo}`,
      });
    });
    await eliminarObjetosS3Seguro([actual.imagen_archivo]);
    res.status(200).json({ success: true, message: "Evento eliminado" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar el evento");
  }
});

// ---------------------------------------------------------------------------
// Sedes deportivas y hoteles
// ---------------------------------------------------------------------------
function leerSede(body, base) {
  const datos = {
    tipo: leerEnum(body, "tipo", base, TIPOS_SEDE, { porDefecto: "DEPORTIVA", etiqueta: "el tipo de sede" }),
    nombre: leerTexto(body, "nombre", base, { maximo: 160, requerido: true, etiqueta: "el nombre de la sede" }),
    direccion: leerTexto(body, "direccion", base, { maximo: 200, etiqueta: "la dirección" }),
    telefono: leerTexto(body, "telefono", base, { maximo: 60, etiqueta: "el teléfono" }),
    descripcion: leerTexto(body, "descripcion", base, { maximo: 400, etiqueta: "la descripción" }),
    url_mapa: leerUrl(body, "url_mapa", base, { maximo: 400, etiqueta: "el enlace del mapa" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
  };
  let departamentalesIds;
  if (body.departamentales_ids !== undefined) {
    departamentalesIds = normalizarIds(body.departamentales_ids);
    if (departamentalesIds === null) throw crearErrorHttp("La lista de departamentales es inválida");
  }
  return { datos, departamentalesIds };
}

async function listarSedes(conexion, olimpiadaId) {
  const [sedes] = await conexion.query(
    `SELECT s.id, s.tipo, s.nombre, s.direccion, s.telefono, s.descripcion, s.url_mapa, s.orden
     FROM olimpiada_sede s
     WHERE s.olimpiada_id = ? AND s.eliminado = 0
     ORDER BY FIELD(s.tipo, 'HOTEL', 'DEPORTIVA', 'OTRA'), s.orden, s.nombre`,
    [olimpiadaId]
  );
  if (sedes.length === 0) return [];
  const ids = sedes.map((sede) => sede.id);
  const [departamentales] = await conexion.query(
    `SELECT sd.sede_id, d.id, d.nombre
     FROM olimpiada_sede_departamental sd
     INNER JOIN departamental d ON d.id = sd.departamental_id
     WHERE sd.sede_id IN (?) ORDER BY d.nombre`,
    [ids]
  );
  const [disciplinas] = await conexion.query(
    `SELECT c.sede_id, d.id, d.nombre
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     WHERE c.olimpiada_id = ? AND c.sede_id IS NOT NULL ORDER BY d.nombre`,
    [olimpiadaId]
  );
  return sedes.map((sede) => ({
    ...sede,
    departamentales: departamentales.filter((fila) => fila.sede_id === sede.id).map((fila) => ({ id: fila.id, nombre: fila.nombre })),
    disciplinas: disciplinas.filter((fila) => fila.sede_id === sede.id).map((fila) => ({ id: fila.id, nombre: fila.nombre })),
  }));
}

router.get("/olimpiadas/:id(\\d+)/sedes", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    res.status(200).json(await listarSedes(db, olimpiadaId));
  } catch (error) {
    responderError(res, error, "No se pudieron cargar las sedes");
  }
});

router.post("/olimpiadas/:id(\\d+)/sedes", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const { datos, departamentalesIds } = leerSede(req.body || {}, {});
    const departamentales = await validarDepartamentales(db, departamentalesIds || []);
    const sedeId = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_sede (olimpiada_id, tipo, nombre, direccion, telefono, descripcion, url_mapa, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.tipo, datos.nombre, datos.direccion, datos.telefono, datos.descripcion, datos.url_mapa, datos.orden]
      );
      for (const departamental of departamentales) {
        await connection.query("INSERT INTO olimpiada_sede_departamental (sede_id, departamental_id) VALUES (?, ?)", [insert.insertId, departamental.id]);
      }
      await historial(connection, cabecera, {
        entidad: "SEDE",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: `${datos.tipo}: ${datos.nombre}${departamentales.length ? ` (${departamentales.map((d) => d.nombre).join(", ")})` : ""}`,
      });
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: sedeId, message: datos.tipo === "HOTEL" ? "Hotel guardado" : "Sede guardada" });
  } catch (error) {
    responderError(res, error, "No se pudo crear la sede");
  }
});

router.put("/olimpiadas/sedes/:sedeId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const sedeId = idDeRuta(req.params.sedeId);
    const actual = await exigirFila(db, "olimpiada_sede", sedeId, "La sede no existe");
    const { datos, departamentalesIds } = leerSede(req.body || {}, actual);
    const departamentales = departamentalesIds === undefined ? null : await validarDepartamentales(db, departamentalesIds);
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_sede SET tipo = ?, nombre = ?, direccion = ?, telefono = ?, descripcion = ?, url_mapa = ?, orden = ? WHERE id = ?`,
        [datos.tipo, datos.nombre, datos.direccion, datos.telefono, datos.descripcion, datos.url_mapa, datos.orden, sedeId]
      );
      const base = { entidad: "SEDE", entidad_id: sedeId, olimpiada_id: actual.olimpiada_id };
      await historialCambios(connection, cabecera, base, actual, datos, ["tipo", "nombre", "direccion", "telefono", "descripcion", "url_mapa", "orden"]);
      if (departamentales !== null) {
        const [previas] = await connection.query(
          `SELECT d.nombre FROM olimpiada_sede_departamental sd INNER JOIN departamental d ON d.id = sd.departamental_id WHERE sd.sede_id = ? ORDER BY d.nombre`,
          [sedeId]
        );
        await connection.query("DELETE FROM olimpiada_sede_departamental WHERE sede_id = ?", [sedeId]);
        for (const departamental of departamentales) {
          await connection.query("INSERT INTO olimpiada_sede_departamental (sede_id, departamental_id) VALUES (?, ?)", [sedeId, departamental.id]);
        }
        const antes = previas.map((fila) => fila.nombre).join(", ");
        const despues = departamentales.map((fila) => fila.nombre).sort((a, b) => a.localeCompare(b, "es")).join(", ");
        if (antes !== despues) {
          await historial(connection, cabecera, { ...base, tipo_operacion: "UPDATE", campo_modificado: "departamentales", valor_anterior: antes || null, valor_nuevo: despues || null });
        }
      }
    });
    res.status(200).json({ success: true, id: sedeId, message: "Sede actualizada" });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar la sede");
  }
});

router.delete("/olimpiadas/sedes/:sedeId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const sedeId = idDeRuta(req.params.sedeId);
    const actual = await exigirFila(db, "olimpiada_sede", sedeId, "La sede no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_sede SET eliminado = 1 WHERE id = ?", [sedeId]);
      await connection.query("UPDATE olimpiada_disciplina_config SET sede_id = NULL WHERE sede_id = ?", [sedeId]);
      await connection.query("UPDATE olimpiada_evento SET sede_id = NULL WHERE sede_id = ?", [sedeId]);
      await connection.query("UPDATE olimpiada_partido SET sede_id = NULL WHERE sede_id = ?", [sedeId]);
      await historial(connection, cabecera, {
        entidad: "SEDE",
        entidad_id: sedeId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: `${actual.tipo}: ${actual.nombre}`,
      });
    });
    res.status(200).json({ success: true, message: "Sede eliminada. Las disciplinas, eventos y partidos que la usaban quedaron sin sede" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar la sede");
  }
});

// ---------------------------------------------------------------------------
// Contactos (datos útiles)
// ---------------------------------------------------------------------------
function leerContacto(body, base) {
  const datos = {
    grupo: leerTexto(body, "grupo", base, { maximo: 80, etiqueta: "el grupo" }) || "Organización",
    nombre: leerTexto(body, "nombre", base, { maximo: 120, requerido: true, etiqueta: "el nombre del contacto" }),
    cargo: leerTexto(body, "cargo", base, { maximo: 120, etiqueta: "el cargo" }),
    telefono: leerTexto(body, "telefono", base, { maximo: 60, etiqueta: "el teléfono" }),
    email: leerTexto(body, "email", base, { maximo: 120, etiqueta: "el email" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
  };
  if (datos.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.email)) throw crearErrorHttp("El email del contacto es inválido");
  return datos;
}

router.get("/olimpiadas/:id(\\d+)/contactos", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const [rows] = await db.query(
      `SELECT id, grupo, nombre, cargo, telefono, email, orden
       FROM olimpiada_contacto WHERE olimpiada_id = ? AND eliminado = 0
       ORDER BY grupo, orden, id`,
      [olimpiadaId]
    );
    res.status(200).json(rows);
  } catch (error) {
    responderError(res, error, "No se pudieron cargar los contactos");
  }
});

router.post("/olimpiadas/:id(\\d+)/contactos", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const datos = leerContacto(req.body || {}, {});
    const contactoId = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_contacto (olimpiada_id, grupo, nombre, cargo, telefono, email, orden) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.grupo, datos.nombre, datos.cargo, datos.telefono, datos.email, datos.orden]
      );
      await historial(connection, cabecera, {
        entidad: "CONTACTO",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: `${datos.grupo}: ${datos.nombre}`,
      });
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: contactoId, message: "Contacto guardado" });
  } catch (error) {
    responderError(res, error, "No se pudo crear el contacto");
  }
});

router.put("/olimpiadas/contactos/:contactoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const contactoId = idDeRuta(req.params.contactoId);
    const actual = await exigirFila(db, "olimpiada_contacto", contactoId, "El contacto no existe");
    const datos = leerContacto(req.body || {}, actual);
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_contacto SET grupo = ?, nombre = ?, cargo = ?, telefono = ?, email = ?, orden = ? WHERE id = ?`,
        [datos.grupo, datos.nombre, datos.cargo, datos.telefono, datos.email, datos.orden, contactoId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "CONTACTO", entidad_id: contactoId, olimpiada_id: actual.olimpiada_id },
        actual,
        datos,
        ["grupo", "nombre", "cargo", "telefono", "email", "orden"]
      );
    });
    res.status(200).json({ success: true, id: contactoId, message: "Contacto actualizado" });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el contacto");
  }
});

router.delete("/olimpiadas/contactos/:contactoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const contactoId = idDeRuta(req.params.contactoId);
    const actual = await exigirFila(db, "olimpiada_contacto", contactoId, "El contacto no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_contacto SET eliminado = 1 WHERE id = ?", [contactoId]);
      await historial(connection, cabecera, {
        entidad: "CONTACTO",
        entidad_id: contactoId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: `${actual.grupo}: ${actual.nombre}`,
      });
    });
    res.status(200).json({ success: true, message: "Contacto eliminado" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar el contacto");
  }
});

// ---------------------------------------------------------------------------
// Secciones de texto (INFO, REGLAMENTO, BONOS, DATOS_UTILES)
// ---------------------------------------------------------------------------
function leerSeccion(body, base) {
  return {
    clave: leerTexto(body, "clave", base, { maximo: 40, etiqueta: "la clave" }),
    ubicacion: leerEnum(body, "ubicacion", base, UBICACIONES_SECCION, { porDefecto: "INFO", etiqueta: "la ubicación" }),
    titulo: leerTexto(body, "titulo", base, { maximo: 160, requerido: true, etiqueta: "el título" }),
    contenido: leerTexto(body, "contenido", base, { maximo: 100000, requerido: true, etiqueta: "el contenido" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
    visible: leerFlag(body, "visible", base, 1),
  };
}

// Literal antes que /olimpiadas/secciones/:seccionId
router.get("/olimpiadas/secciones/plantillas", verifyToken, (req, res) => {
  const cabecera = getCabecera(req);
  if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
  return res.status(200).json(SECCIONES_INICIALES.map((seccion) => ({ ...seccion })));
});

router.get("/olimpiadas/:id(\\d+)/secciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const condiciones = ["olimpiada_id = ?", "eliminado = 0"];
    const params = [olimpiadaId];
    if (req.query.ubicacion !== undefined && req.query.ubicacion !== "") {
      const ubicacion = String(req.query.ubicacion).toUpperCase();
      if (!UBICACIONES_SECCION.includes(ubicacion)) return res.status(400).json(`La ubicación debe ser una de: ${UBICACIONES_SECCION.join(", ")}`);
      condiciones.push("ubicacion = ?");
      params.push(ubicacion);
    }
    if (esAfiliado(cabecera)) condiciones.push("visible = 1");
    const [rows] = await db.query(
      `SELECT id, clave, ubicacion, titulo, contenido, orden, visible
       FROM olimpiada_seccion WHERE ${condiciones.join(" AND ")}
       ORDER BY FIELD(ubicacion, 'INFO', 'REGLAMENTO', 'BONOS', 'DATOS_UTILES'), orden, id`,
      params
    );
    res.status(200).json(rows);
  } catch (error) {
    responderError(res, error, "No se pudieron cargar las secciones");
  }
});

router.post("/olimpiadas/:id(\\d+)/secciones", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const datos = leerSeccion(req.body || {}, {});
    const seccionId = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_seccion (olimpiada_id, clave, ubicacion, titulo, contenido, orden, visible) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.clave, datos.ubicacion, datos.titulo, datos.contenido, datos.orden, datos.visible]
      );
      await historial(connection, cabecera, {
        entidad: "SECCION",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: `${datos.ubicacion}: ${datos.titulo}`,
      });
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: seccionId, message: "Sección guardada" });
  } catch (error) {
    responderError(res, error, "No se pudo crear la sección");
  }
});

router.put("/olimpiadas/secciones/:seccionId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const seccionId = idDeRuta(req.params.seccionId);
    const actual = await exigirFila(db, "olimpiada_seccion", seccionId, "La sección no existe");
    const datos = leerSeccion(req.body || {}, actual);
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_seccion SET clave = ?, ubicacion = ?, titulo = ?, contenido = ?, orden = ?, visible = ? WHERE id = ?`,
        [datos.clave, datos.ubicacion, datos.titulo, datos.contenido, datos.orden, datos.visible, seccionId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "SECCION", entidad_id: seccionId, olimpiada_id: actual.olimpiada_id },
        actual,
        datos,
        ["clave", "ubicacion", "titulo", "contenido", "orden", "visible"]
      );
    });
    res.status(200).json({ success: true, id: seccionId, message: "Sección actualizada" });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar la sección");
  }
});

router.delete("/olimpiadas/secciones/:seccionId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const seccionId = idDeRuta(req.params.seccionId);
    const actual = await exigirFila(db, "olimpiada_seccion", seccionId, "La sección no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_seccion SET eliminado = 1 WHERE id = ?", [seccionId]);
      await historial(connection, cabecera, {
        entidad: "SECCION",
        entidad_id: seccionId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: `${actual.ubicacion}: ${actual.titulo}`,
      });
    });
    res.status(200).json({ success: true, message: "Sección eliminada" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar la sección");
  }
});

// ---------------------------------------------------------------------------
// Enlaces (videos y otros)
// ---------------------------------------------------------------------------
function leerEnlace(body, base) {
  return {
    tipo: leerEnum(body, "tipo", base, TIPOS_ENLACE, { porDefecto: "OTRO", etiqueta: "el tipo de enlace" }),
    titulo: leerTexto(body, "titulo", base, { maximo: 160, requerido: true, etiqueta: "el título" }),
    url: leerUrl(body, "url", base, { maximo: 600, requerido: true, etiqueta: "la dirección del enlace" }),
    descripcion: leerTexto(body, "descripcion", base, { maximo: 300, etiqueta: "la descripción" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
  };
}

router.get("/olimpiadas/:id(\\d+)/enlaces", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const [rows] = await db.query(
      `SELECT id, tipo, titulo, url, descripcion, orden
       FROM olimpiada_enlace WHERE olimpiada_id = ? AND eliminado = 0
       ORDER BY FIELD(tipo, 'VIDEOS', 'OTRO'), orden, id`,
      [olimpiadaId]
    );
    res.status(200).json(rows);
  } catch (error) {
    responderError(res, error, "No se pudieron cargar los enlaces");
  }
});

router.post("/olimpiadas/:id(\\d+)/enlaces", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const datos = leerEnlace(req.body || {}, {});
    const enlaceId = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_enlace (olimpiada_id, tipo, titulo, url, descripcion, orden) VALUES (?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.tipo, datos.titulo, datos.url, datos.descripcion, datos.orden]
      );
      await historial(connection, cabecera, {
        entidad: "ENLACE",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: `${datos.tipo}: ${datos.titulo} → ${datos.url}`,
      });
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: enlaceId, message: "Enlace guardado" });
  } catch (error) {
    responderError(res, error, "No se pudo crear el enlace");
  }
});

router.put("/olimpiadas/enlaces/:enlaceId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const enlaceId = idDeRuta(req.params.enlaceId);
    const actual = await exigirFila(db, "olimpiada_enlace", enlaceId, "El enlace no existe");
    const datos = leerEnlace(req.body || {}, actual);
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_enlace SET tipo = ?, titulo = ?, url = ?, descripcion = ?, orden = ? WHERE id = ?`,
        [datos.tipo, datos.titulo, datos.url, datos.descripcion, datos.orden, enlaceId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "ENLACE", entidad_id: enlaceId, olimpiada_id: actual.olimpiada_id },
        actual,
        datos,
        ["tipo", "titulo", "url", "descripcion", "orden"]
      );
    });
    res.status(200).json({ success: true, id: enlaceId, message: "Enlace actualizado" });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el enlace");
  }
});

router.delete("/olimpiadas/enlaces/:enlaceId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const enlaceId = idDeRuta(req.params.enlaceId);
    const actual = await exigirFila(db, "olimpiada_enlace", enlaceId, "El enlace no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_enlace SET eliminado = 1 WHERE id = ?", [enlaceId]);
      await historial(connection, cabecera, {
        entidad: "ENLACE",
        entidad_id: enlaceId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: `${actual.tipo}: ${actual.titulo}`,
      });
    });
    res.status(200).json({ success: true, message: "Enlace eliminado" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar el enlace");
  }
});

// ---------------------------------------------------------------------------
// Fixture: disciplinas de la edición, partidos y resultados
// ---------------------------------------------------------------------------
const SELECT_PARTIDO = `
  SELECT p.id, p.olimpiada_id, p.disciplina_id, d.nombre AS disciplina_nombre, p.fecha, p.hora_inicio, p.hora_fin,
         p.etiqueta, p.fase, p.participante1, p.participante2, p.departamental1_id, p.departamental2_id,
         p.resultado1, p.resultado2, p.ganador, p.estado, p.sede_id, s.nombre AS sede_nombre,
         p.observacion, p.orden, p.fecha_modificacion
  FROM olimpiada_partido p
  INNER JOIN olimpiada_disciplina d ON d.id = p.disciplina_id
  LEFT JOIN olimpiada_sede s ON s.id = p.sede_id AND s.eliminado = 0`;
const ORDEN_PARTIDOS = "p.fecha IS NULL, p.fecha, p.hora_inicio IS NULL, p.hora_inicio, p.orden, p.id";

async function consultarPartidos(conexion, { condiciones, params, orden = ORDEN_PARTIDOS, limite = null }) {
  const [rows] = await conexion.query(
    `${SELECT_PARTIDO} WHERE p.eliminado = 0 AND ${condiciones.join(" AND ")} ORDER BY ${orden}${limite ? ` LIMIT ${Number(limite)}` : ""}`,
    params
  );
  return rows;
}

async function obtenerPartidoCompleto(conexion, partidoId) {
  const rows = await consultarPartidos(conexion, { condiciones: ["p.id = ?"], params: [partidoId] });
  return rows[0] || null;
}

async function listarDisciplinasFixture(conexion, olimpiadaId) {
  const [rows] = await conexion.query(
    `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.icono_archivo,
            c.sede_id, s.nombre AS sede_nombre, s.direccion AS sede_direccion, c.veedor, c.reglamento,
            (SELECT COUNT(*) FROM olimpiada_partido p WHERE p.olimpiada_id = c.olimpiada_id AND p.disciplina_id = d.id AND p.eliminado = 0) AS partidos,
            (SELECT COUNT(*) FROM olimpiada_partido p WHERE p.olimpiada_id = c.olimpiada_id AND p.disciplina_id = d.id AND p.eliminado = 0 AND p.estado = 'EN_JUEGO') AS en_vivo
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     LEFT JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
     LEFT JOIN olimpiada_sede s ON s.id = c.sede_id AND s.eliminado = 0
     WHERE c.olimpiada_id = ?
     ORDER BY d.nombre`,
    [olimpiadaId]
  );
  return Promise.all(
    rows.map(async (fila) => ({
      id: fila.id,
      nombre: fila.nombre,
      tipo_id: fila.tipo_id,
      tipo_nombre: fila.tipo_nombre || null,
      icono_url: await firmarSeguro(fila.icono_archivo),
      sede_id: fila.sede_id,
      sede_nombre: fila.sede_nombre || null,
      sede_direccion: fila.sede_direccion || null,
      veedor: fila.veedor,
      reglamento: fila.reglamento,
      partidos: Number(fila.partidos) || 0,
      en_vivo: Number(fila.en_vivo) || 0,
    }))
  );
}

router.get("/olimpiadas/:id(\\d+)/fixture", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const condiciones = ["p.olimpiada_id = ?"];
    const params = [olimpiadaId];
    if (req.query.disciplina_id !== undefined && req.query.disciplina_id !== "") {
      const disciplinaId = normalizarIdPositivo(req.query.disciplina_id);
      if (!disciplinaId) return res.status(400).json("La disciplina es inválida");
      condiciones.push("p.disciplina_id = ?");
      params.push(disciplinaId);
    }
    const [disciplinas, partidos] = await Promise.all([
      listarDisciplinasFixture(db, olimpiadaId),
      consultarPartidos(db, { condiciones, params }),
    ]);
    res.status(200).json({ disciplinas, partidos });
  } catch (error) {
    responderError(res, error, "No se pudo cargar el fixture");
  }
});

router.put("/olimpiadas/:id(\\d+)/disciplinas/:disciplinaId(\\d+)/info", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const disciplinaId = idDeRuta(req.params.disciplinaId);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const actual = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    const body = req.body || {};
    const datos = {
      sede_id: leerIdOpcional(body, "sede_id", actual, { etiqueta: "la sede" }),
      veedor: leerTexto(body, "veedor", actual, { maximo: 160, etiqueta: "el veedor" }),
      reglamento: leerTexto(body, "reglamento", actual, { maximo: 100000, etiqueta: "el reglamento" }),
    };
    await validarSedeDeOlimpiada(db, olimpiadaId, datos.sede_id);
    await enTransaccion(async (connection) => {
      await connection.query(
        "UPDATE olimpiada_disciplina_config SET sede_id = ?, veedor = ?, reglamento = ? WHERE olimpiada_id = ? AND disciplina_id = ?",
        [datos.sede_id, datos.veedor, datos.reglamento, olimpiadaId, disciplinaId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "DISCIPLINA_INFO", entidad_id: disciplinaId, olimpiada_id: olimpiadaId },
        actual,
        datos,
        ["sede_id", "veedor", "reglamento"]
      );
    });
    res.status(200).json({ success: true, message: `Información de ${actual.nombre} guardada` });
  } catch (error) {
    responderError(res, error, "No se pudo guardar la información de la disciplina");
  }
});

function leerPartido(body, base, { completo = false } = {}) {
  const datos = {
    disciplina_id: leerIdOpcional(body, "disciplina_id", base, { etiqueta: "la disciplina" }),
    fecha: leerFecha(body, "fecha", base, { etiqueta: "la fecha" }),
    hora_inicio: leerHora(body, "hora_inicio", base, { etiqueta: "la hora de inicio" }),
    hora_fin: leerHora(body, "hora_fin", base, { etiqueta: "la hora de fin" }),
    etiqueta: leerTexto(body, "etiqueta", base, { maximo: 40, etiqueta: "la etiqueta" }),
    fase: leerTexto(body, "fase", base, { maximo: 60, etiqueta: "la fase" }),
    participante1: leerTexto(body, "participante1", base, { maximo: 120, requerido: true, etiqueta: "el participante 1" }),
    participante2: leerTexto(body, "participante2", base, { maximo: 120, requerido: true, etiqueta: "el participante 2" }),
    departamental1_id: leerIdOpcional(body, "departamental1_id", base, { etiqueta: "la departamental del participante 1" }),
    departamental2_id: leerIdOpcional(body, "departamental2_id", base, { etiqueta: "la departamental del participante 2" }),
    sede_id: leerIdOpcional(body, "sede_id", base, { etiqueta: "la sede" }),
    observacion: leerTexto(body, "observacion", base, { maximo: 300, etiqueta: "la observación" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
  };
  if (!datos.disciplina_id) throw crearErrorHttp("Indicá la disciplina del partido");
  if (completo) {
    datos.estado = leerEnum(body, "estado", base, ESTADOS_PARTIDO, { porDefecto: "PROGRAMADO", etiqueta: "el estado" });
    datos.resultado1 = leerTexto(body, "resultado1", base, { maximo: 20, etiqueta: "el resultado 1" });
    datos.resultado2 = leerTexto(body, "resultado2", base, { maximo: 20, etiqueta: "el resultado 2" });
    const ganador = leerGanador(body.ganador);
    datos.ganador = ganador === undefined ? base.ganador ?? null : ganador;
  }
  return datos;
}

async function validarReferenciasPartido(conexion, olimpiadaId, datos) {
  await validarDisciplinaDeOlimpiada(conexion, olimpiadaId, datos.disciplina_id);
  await validarSedeDeOlimpiada(conexion, olimpiadaId, datos.sede_id);
  await validarDepartamentalOpcional(conexion, datos.departamental1_id, "la departamental del participante 1");
  await validarDepartamentalOpcional(conexion, datos.departamental2_id, "la departamental del participante 2");
}

function describirPartido(partido) {
  const fecha = partido.fecha ? `${normalizarFechaCivil(partido.fecha) || partido.fecha} ` : "";
  return `${fecha}${partido.participante1} vs ${partido.participante2}${partido.etiqueta ? ` (${partido.etiqueta})` : ""}`;
}

router.post("/olimpiadas/:id(\\d+)/partidos", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const datos = leerPartido(req.body || {}, {});
    await validarReferenciasPartido(db, olimpiadaId, datos);
    const partidoId = await enTransaccion(async (connection) => {
      const [insert] = await connection.query(
        `INSERT INTO olimpiada_partido
           (olimpiada_id, disciplina_id, fecha, hora_inicio, hora_fin, etiqueta, fase, participante1, participante2,
            departamental1_id, departamental2_id, sede_id, observacion, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          olimpiadaId, datos.disciplina_id, datos.fecha, datos.hora_inicio, datos.hora_fin, datos.etiqueta, datos.fase,
          datos.participante1, datos.participante2, datos.departamental1_id, datos.departamental2_id, datos.sede_id,
          datos.observacion, datos.orden,
        ]
      );
      await historial(connection, cabecera, {
        entidad: "PARTIDO",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: describirPartido(datos),
      });
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: partidoId, message: "Partido agregado al fixture" });
  } catch (error) {
    responderError(res, error, "No se pudo crear el partido");
  }
});

router.post("/olimpiadas/:id(\\d+)/partidos/importar", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const disciplinaId = normalizarIdPositivo(body.disciplina_id);
    if (!disciplinaId) return res.status(400).json("Elegí la disciplina a la que pertenecen los partidos");
    const disciplina = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    const texto = typeof body.texto === "string" ? body.texto : "";
    if (!texto.trim()) return res.status(400).json("Pegá los partidos en el cuadro de texto");
    const { partidos, ignoradas } = parsearPartidosTexto(texto);
    if (partidos.length === 0) {
      return res.status(400).json(
        "No se reconoció ninguna línea. Usá una línea por partido con las columnas fecha, inicio, fin, etiqueta, participante 1 y participante 2 separadas por TAB, \"|\" o dos espacios (ej.: 28/11/24 | 14:30 | 16:00 | A | Bahía Blanca | Lomas)"
      );
    }
    if (partidos.length > MAX_LINEAS_IMPORTACION) return res.status(400).json(`Se pueden importar hasta ${MAX_LINEAS_IMPORTACION} partidos por vez`);
    const [[ultimo]] = await db.query(
      "SELECT COALESCE(MAX(orden), 0) AS orden FROM olimpiada_partido WHERE olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0",
      [olimpiadaId, disciplinaId]
    );
    let orden = Number(ultimo.orden) || 0;
    await enTransaccion(async (connection) => {
      for (const partido of partidos) {
        orden += 1;
        await connection.query(
          `INSERT INTO olimpiada_partido (olimpiada_id, disciplina_id, fecha, hora_inicio, hora_fin, etiqueta, participante1, participante2, orden)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [olimpiadaId, disciplinaId, partido.fecha, partido.hora_inicio, partido.hora_fin, partido.etiqueta, partido.participante1, partido.participante2, orden]
        );
      }
      await historial(connection, cabecera, {
        entidad: "PARTIDO",
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        campo_modificado: "importacion",
        valor_nuevo: `${partidos.length} partidos de ${disciplina.nombre} importados desde texto`,
      });
    });
    res.status(201).json({
      success: true,
      message: `Se importaron ${partidos.length} partidos de ${disciplina.nombre}${ignoradas > 0 ? ` (${ignoradas} líneas ignoradas)` : ""}`,
      creados: partidos.length,
      ignoradas,
    });
  } catch (error) {
    responderError(res, error, "No se pudieron importar los partidos");
  }
});

router.put("/olimpiadas/partidos/:partidoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const partidoId = idDeRuta(req.params.partidoId);
    const actual = await exigirFila(db, "olimpiada_partido", partidoId, "El partido no existe");
    const body = req.body || {};
    const datos = leerPartido(body, actual, { completo: true });
    // Finalizado sin ganador definido y con marcador numérico → se calcula (igual que /resultado).
    if (datos.estado === "FINALIZADO" && datos.ganador === null) {
      datos.ganador = calcularGanadorPartido(datos.resultado1, datos.resultado2);
    }
    if (datos.estado !== "FINALIZADO") datos.ganador = null;
    await validarReferenciasPartido(db, actual.olimpiada_id, datos);
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_partido
         SET disciplina_id = ?, fecha = ?, hora_inicio = ?, hora_fin = ?, etiqueta = ?, fase = ?, participante1 = ?, participante2 = ?,
             departamental1_id = ?, departamental2_id = ?, sede_id = ?, observacion = ?, orden = ?,
             estado = ?, resultado1 = ?, resultado2 = ?, ganador = ?
         WHERE id = ?`,
        [
          datos.disciplina_id, datos.fecha, datos.hora_inicio, datos.hora_fin, datos.etiqueta, datos.fase, datos.participante1,
          datos.participante2, datos.departamental1_id, datos.departamental2_id, datos.sede_id, datos.observacion, datos.orden,
          datos.estado, datos.resultado1, datos.resultado2, datos.ganador, partidoId,
        ]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "PARTIDO", entidad_id: partidoId, olimpiada_id: actual.olimpiada_id },
        actual,
        datos,
        [
          "disciplina_id", "fecha", "hora_inicio", "hora_fin", "etiqueta", "fase", "participante1", "participante2",
          "departamental1_id", "departamental2_id", "sede_id", "observacion", "orden", "estado", "resultado1", "resultado2", "ganador",
        ]
      );
    });
    res.status(200).json({ success: true, id: partidoId, message: "Partido actualizado", partido: await obtenerPartidoCompleto(db, partidoId) });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el partido");
  }
});

const MENSAJE_RESULTADO = {
  PROGRAMADO: "Partido reprogramado",
  EN_JUEGO: "Partido en juego",
  FINALIZADO: "Resultado cargado",
  SUSPENDIDO: "Partido suspendido",
};

router.put("/olimpiadas/partidos/:partidoId(\\d+)/resultado", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const partidoId = idDeRuta(req.params.partidoId);
    const actual = await exigirFila(db, "olimpiada_partido", partidoId, "El partido no existe");
    const body = req.body || {};
    if (body.estado === undefined) return res.status(400).json("Indicá el estado del partido");
    const estado = leerEnum(body, "estado", {}, ESTADOS_PARTIDO, { etiqueta: "el estado" });
    const resultado1 = leerTexto(body, "resultado1", actual, { maximo: 20, etiqueta: "el resultado 1" });
    const resultado2 = leerTexto(body, "resultado2", actual, { maximo: 20, etiqueta: "el resultado 2" });
    let ganador = leerGanador(body.ganador);
    if (ganador === undefined || ganador === null) {
      ganador = estado === "FINALIZADO" ? calcularGanadorPartido(resultado1, resultado2) : null;
    }
    const nuevo = { estado, resultado1, resultado2, ganador };
    await enTransaccion(async (connection) => {
      await connection.query(
        "UPDATE olimpiada_partido SET estado = ?, resultado1 = ?, resultado2 = ?, ganador = ? WHERE id = ?",
        [estado, resultado1, resultado2, ganador, partidoId]
      );
      const marcador = resultado1 !== null || resultado2 !== null ? ` ${resultado1 ?? "-"} a ${resultado2 ?? "-"}` : "";
      await historial(connection, cabecera, {
        entidad: "PARTIDO",
        entidad_id: partidoId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "CAMBIO_ESTADO",
        campo_modificado: "estado",
        valor_anterior: actual.estado,
        valor_nuevo: estado,
        observacion: `${actual.participante1} vs ${actual.participante2}${marcador}${ganador === 0 ? " (empate)" : ""}`,
      });
      await historialCambios(
        connection,
        cabecera,
        { entidad: "PARTIDO", entidad_id: partidoId, olimpiada_id: actual.olimpiada_id },
        actual,
        nuevo,
        ["resultado1", "resultado2", "ganador"]
      );
    });
    res.status(200).json({ success: true, message: MENSAJE_RESULTADO[estado], partido: await obtenerPartidoCompleto(db, partidoId) });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el resultado");
  }
});

router.delete("/olimpiadas/partidos/:partidoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const partidoId = idDeRuta(req.params.partidoId);
    const actual = await exigirFila(db, "olimpiada_partido", partidoId, "El partido no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_partido SET eliminado = 1 WHERE id = ?", [partidoId]);
      await historial(connection, cabecera, {
        entidad: "PARTIDO",
        entidad_id: partidoId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: describirPartido(actual),
      });
    });
    res.status(200).json({ success: true, message: "Partido eliminado" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar el partido");
  }
});

// ---------------------------------------------------------------------------
// En vivo
// ---------------------------------------------------------------------------
router.get("/olimpiadas/:id(\\d+)/en-vivo", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const hoy = fechaHoyBuenosAires();
    const [enJuego, recientes, proximos] = await Promise.all([
      consultarPartidos(db, { condiciones: ["p.olimpiada_id = ?", "p.estado = 'EN_JUEGO'"], params: [olimpiadaId] }),
      consultarPartidos(db, {
        condiciones: ["p.olimpiada_id = ?", "p.estado = 'FINALIZADO'"],
        params: [olimpiadaId],
        orden: "p.fecha_modificacion DESC, p.id DESC",
        limite: 20,
      }),
      consultarPartidos(db, {
        condiciones: ["p.olimpiada_id = ?", "p.estado = 'PROGRAMADO'", "p.fecha >= ?"],
        params: [olimpiadaId, hoy],
        orden: "p.fecha, p.hora_inicio IS NULL, p.hora_inicio, p.orden, p.id",
        limite: 20,
      }),
    ]);
    res.set("Cache-Control", "no-store");
    res.status(200).json({ actualizado: new Date().toISOString(), en_juego: enJuego, recientes, proximos });
  } catch (error) {
    responderError(res, error, "No se pudo cargar el estado en vivo");
  }
});

// ---------------------------------------------------------------------------
// Medallero
// ---------------------------------------------------------------------------
async function armarMedallero(conexion, olimpiada) {
  const puntos = {
    oro: Number(olimpiada.puntos_oro) || 0,
    plata: Number(olimpiada.puntos_plata) || 0,
    bronce: Number(olimpiada.puntos_bronce) || 0,
  };
  const [disciplinas] = await conexion.query(
    `SELECT d.id, d.nombre FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     WHERE c.olimpiada_id = ? ORDER BY d.nombre`,
    [olimpiada.id]
  );
  const [medallas] = await conexion.query(
    `SELECT m.disciplina_id, d.nombre AS disciplina_nombre, m.puesto, m.departamental_id, dep.nombre
     FROM olimpiada_medalla m
     INNER JOIN olimpiada_disciplina d ON d.id = m.disciplina_id
     INNER JOIN departamental dep ON dep.id = m.departamental_id
     WHERE m.olimpiada_id = ?
     ORDER BY d.nombre, m.puesto, dep.nombre`,
    [olimpiada.id]
  );
  return {
    puntos,
    disciplinas: agruparMedallasPorDisciplina(disciplinas, medallas),
    tabla: calcularTablaMedallero(medallas, puntos),
  };
}

router.get("/olimpiadas/:id(\\d+)/medallero", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    res.status(200).json(await armarMedallero(db, olimpiada));
  } catch (error) {
    responderError(res, error, "No se pudo cargar el medallero");
  }
});

// Literal antes que /medallero/:disciplinaId
router.put("/olimpiadas/:id(\\d+)/medallero/puntos", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const base = { puntos_oro: olimpiada.puntos_oro, puntos_plata: olimpiada.puntos_plata, puntos_bronce: olimpiada.puntos_bronce };
    const nuevo = {
      puntos_oro: leerEntero(body, "puntos_oro", base, { maximo: 1000, etiqueta: "los puntos por oro" }),
      puntos_plata: leerEntero(body, "puntos_plata", base, { maximo: 1000, etiqueta: "los puntos por plata" }),
      puntos_bronce: leerEntero(body, "puntos_bronce", base, { maximo: 1000, etiqueta: "los puntos por bronce" }),
    };
    await enTransaccion(async (connection) => {
      await connection.query(
        "UPDATE olimpiada SET puntos_oro = ?, puntos_plata = ?, puntos_bronce = ? WHERE id = ?",
        [nuevo.puntos_oro, nuevo.puntos_plata, nuevo.puntos_bronce, olimpiadaId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "MEDALLA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId },
        base,
        nuevo,
        ["puntos_oro", "puntos_plata", "puntos_bronce"]
      );
    });
    res.status(200).json({ success: true, message: "Sistema de puntos actualizado", medallero: await armarMedallero(db, { ...olimpiada, ...nuevo }) });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el sistema de puntos");
  }
});

router.put("/olimpiadas/:id(\\d+)/medallero/:disciplinaId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const disciplinaId = idDeRuta(req.params.disciplinaId);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const disciplina = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    const puestos = Array.isArray(req.body?.puestos) ? req.body.puestos : null;
    if (!puestos) return res.status(400).json("Indicá los puestos con sus departamentales");
    const porPuesto = new Map();
    for (const entrada of puestos) {
      const puesto = Number(entrada?.puesto);
      if (![1, 2, 3].includes(puesto)) return res.status(400).json("El puesto debe ser 1 (oro), 2 (plata) o 3 (bronce)");
      const ids = normalizarIds(entrada?.departamental_ids);
      if (ids === null) return res.status(400).json("La lista de departamentales es inválida");
      porPuesto.set(puesto, [...new Set([...(porPuesto.get(puesto) || []), ...ids])]);
    }
    const todos = [...new Set([...porPuesto.values()].flat())];
    const departamentales = await validarDepartamentales(db, todos);
    const nombrePor = new Map(departamentales.map((d) => [d.id, d.nombre]));
    await enTransaccion(async (connection) => {
      const [previas] = await connection.query(
        `SELECT m.puesto, dep.nombre FROM olimpiada_medalla m INNER JOIN departamental dep ON dep.id = m.departamental_id
         WHERE m.olimpiada_id = ? AND m.disciplina_id = ? ORDER BY m.puesto, dep.nombre`,
        [olimpiadaId, disciplinaId]
      );
      await connection.query("DELETE FROM olimpiada_medalla WHERE olimpiada_id = ? AND disciplina_id = ?", [olimpiadaId, disciplinaId]);
      for (const [puesto, ids] of porPuesto.entries()) {
        for (const departamentalId of ids) {
          await connection.query(
            "INSERT INTO olimpiada_medalla (olimpiada_id, disciplina_id, puesto, departamental_id) VALUES (?, ?, ?, ?)",
            [olimpiadaId, disciplinaId, puesto, departamentalId]
          );
        }
      }
      const describir = (lista) => [1, 2, 3]
        .map((puesto) => {
          const nombres = lista.filter((m) => Number(m.puesto) === puesto).map((m) => m.nombre);
          return nombres.length ? `${["Oro", "Plata", "Bronce"][puesto - 1]}: ${nombres.join(" / ")}` : null;
        })
        .filter(Boolean)
        .join(" · ");
      const nuevas = [...porPuesto.entries()].flatMap(([puesto, ids]) => ids.map((id) => ({ puesto, nombre: nombrePor.get(id) })));
      await historial(connection, cabecera, {
        entidad: "MEDALLA",
        entidad_id: disciplinaId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "UPDATE",
        campo_modificado: disciplina.nombre,
        valor_anterior: describir(previas) || null,
        valor_nuevo: describir(nuevas) || null,
      });
    });
    res.status(200).json({ success: true, message: `Medallas de ${disciplina.nombre} guardadas`, medallero: await armarMedallero(db, olimpiada) });
  } catch (error) {
    responderError(res, error, "No se pudieron guardar las medallas");
  }
});

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------
const SELECT_FOTO = `
  SELECT f.id, f.olimpiada_id, f.archivo, f.miniatura_archivo, f.ancho, f.alto, f.epigrafe, f.disciplina_id,
         d.nombre AS disciplina_nombre, f.fecha, f.etiqueta, f.orden, f.fecha_creacion
  FROM olimpiada_foto f
  LEFT JOIN olimpiada_disciplina d ON d.id = f.disciplina_id`;

async function serializarFoto(fila) {
  const [url, urlMiniatura] = await Promise.all([firmarSeguro(fila.archivo), firmarSeguro(fila.miniatura_archivo)]);
  return {
    id: fila.id,
    olimpiada_id: fila.olimpiada_id,
    url,
    url_miniatura: urlMiniatura,
    ancho: fila.ancho,
    alto: fila.alto,
    epigrafe: fila.epigrafe,
    disciplina_id: fila.disciplina_id,
    disciplina_nombre: fila.disciplina_nombre || null,
    fecha: fila.fecha,
    etiqueta: fila.etiqueta,
    orden: fila.orden,
    fecha_creacion: fila.fecha_creacion,
  };
}

// Campos comunes de un lote / edición: sólo los que vienen en el body.
function leerCamposFoto(body, { conEpigrafe = false } = {}) {
  const cambios = {};
  if (body.disciplina_id !== undefined) cambios.disciplina_id = leerIdOpcional(body, "disciplina_id", {}, { etiqueta: "la disciplina" });
  if (body.fecha !== undefined) cambios.fecha = leerFecha(body, "fecha", {}, { etiqueta: "la fecha" });
  if (body.etiqueta !== undefined) cambios.etiqueta = leerTexto(body, "etiqueta", {}, { maximo: 60, etiqueta: "la etiqueta" });
  if (conEpigrafe && body.epigrafe !== undefined) cambios.epigrafe = leerTexto(body, "epigrafe", {}, { maximo: 200, etiqueta: "el epígrafe" });
  return cambios;
}

/**
 * Sube las fotos de a una (sharp + S3 + INSERT). Si una falla se limpia lo subido de esa foto y se
 * sigue con la siguiente; el resultado trae las que entraron y un error por archivo fallido.
 */
async function procesarLoteFotos(
  { archivos, olimpiadaId, comunes, usuarioId, ordenInicial = 0 },
  { subirImagen = subirImagenOptimizada, conexion = db, eliminarObjetos = eliminarObjetosS3Seguro } = {}
) {
  const fotos = [];
  const errores = [];
  let orden = Number(ordenInicial) || 0;
  for (const [indice, archivo] of (archivos || []).entries()) {
    const nombre = archivo?.originalname || `foto ${indice + 1}`;
    let imagen = null;
    try {
      imagen = await subirImagen(archivo, `fotos/${olimpiadaId}/foto`, { anchoMaximo: 1600, miniatura: true, anchoMiniatura: 420 });
      // El orden sólo avanza cuando la foto entró (una fallida no deja huecos).
      const ordenFoto = orden + 1;
      const [insert] = await conexion.query(
        `INSERT INTO olimpiada_foto (olimpiada_id, archivo, miniatura_archivo, ancho, alto, mime, epigrafe, disciplina_id, fecha, etiqueta, orden, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          olimpiadaId, imagen.key, imagen.miniatura_key, imagen.ancho, imagen.alto, imagen.mime,
          comunes.epigrafe ?? null, comunes.disciplina_id ?? null, comunes.fecha ?? null, comunes.etiqueta ?? null, ordenFoto, usuarioId,
        ]
      );
      orden = ordenFoto;
      fotos.push({
        id: insert.insertId,
        olimpiada_id: olimpiadaId,
        archivo: imagen.key,
        miniatura_archivo: imagen.miniatura_key,
        ancho: imagen.ancho,
        alto: imagen.alto,
        epigrafe: comunes.epigrafe ?? null,
        disciplina_id: comunes.disciplina_id ?? null,
        disciplina_nombre: comunes.disciplina_nombre ?? null,
        fecha: comunes.fecha ?? null,
        etiqueta: comunes.etiqueta ?? null,
        orden,
        fecha_creacion: new Date(),
      });
    } catch (error) {
      if (imagen) await eliminarObjetos(imagen.keys);
      registrarErrorRuta(error, `olimpiadas-contenido:foto ${nombre}`);
      errores.push({ archivo: nombre, error: error?.statusCode ? error.message : "No se pudo guardar la foto" });
    }
  }
  return { fotos, errores };
}

router.get("/olimpiadas/:id(\\d+)/fotos", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const page = req.query.page === undefined || req.query.page === "" ? 1 : normalizarIdPositivo(req.query.page);
    const pageSize = req.query.pageSize === undefined || req.query.pageSize === "" ? PAGE_SIZE_FOTOS : normalizarIdPositivo(req.query.pageSize);
    if (!page || !pageSize || page > 1_000_000 || pageSize > MAX_PAGE_SIZE_FOTOS) return res.status(400).json("La paginación es inválida");
    const condiciones = ["f.olimpiada_id = ?", "f.eliminado = 0"];
    const params = [olimpiadaId];
    if (req.query.disciplina_id !== undefined && req.query.disciplina_id !== "") {
      const disciplinaId = normalizarIdPositivo(req.query.disciplina_id);
      if (!disciplinaId) return res.status(400).json("La disciplina es inválida");
      condiciones.push("f.disciplina_id = ?");
      params.push(disciplinaId);
    }
    if (req.query.fecha !== undefined && req.query.fecha !== "") {
      const fecha = normalizarFechaCivil(req.query.fecha);
      if (!fecha) return res.status(400).json("La fecha debe tener formato YYYY-MM-DD");
      condiciones.push("f.fecha = ?");
      params.push(fecha);
    }
    if (req.query.etiqueta !== undefined && req.query.etiqueta !== "") {
      const etiqueta = normalizarTexto(String(req.query.etiqueta), 60);
      if (etiqueta) {
        condiciones.push("f.etiqueta = ?");
        params.push(etiqueta);
      }
    }
    const where = condiciones.join(" AND ");
    const [[conteo]] = await db.query(`SELECT COUNT(*) AS total FROM olimpiada_foto f WHERE ${where}`, params);
    const [rows] = await db.query(
      `${SELECT_FOTO} WHERE ${where} ORDER BY f.fecha DESC, f.orden, f.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const [[disciplinas], [fechas], [etiquetas]] = await Promise.all([
      db.query(
        `SELECT d.id, d.nombre, COUNT(*) AS cantidad FROM olimpiada_foto f INNER JOIN olimpiada_disciplina d ON d.id = f.disciplina_id
         WHERE f.olimpiada_id = ? AND f.eliminado = 0 GROUP BY d.id, d.nombre ORDER BY d.nombre`,
        [olimpiadaId]
      ),
      db.query(
        `SELECT f.fecha, COUNT(*) AS cantidad FROM olimpiada_foto f WHERE f.olimpiada_id = ? AND f.eliminado = 0 AND f.fecha IS NOT NULL
         GROUP BY f.fecha ORDER BY f.fecha DESC`,
        [olimpiadaId]
      ),
      db.query(
        `SELECT f.etiqueta, COUNT(*) AS cantidad FROM olimpiada_foto f WHERE f.olimpiada_id = ? AND f.eliminado = 0 AND f.etiqueta IS NOT NULL
         GROUP BY f.etiqueta ORDER BY f.etiqueta`,
        [olimpiadaId]
      ),
    ]);
    res.status(200).json({
      results: await Promise.all(rows.map(serializarFoto)),
      totalItems: Number(conteo.total) || 0,
      page,
      pageSize,
      filtros: {
        disciplinas: disciplinas.map((fila) => ({ id: fila.id, nombre: fila.nombre, cantidad: Number(fila.cantidad) })),
        fechas: fechas.map((fila) => ({ fecha: fila.fecha, cantidad: Number(fila.cantidad) })),
        etiquetas: etiquetas.map((fila) => ({ etiqueta: fila.etiqueta, cantidad: Number(fila.cantidad) })),
      },
    });
  } catch (error) {
    responderError(res, error, "No se pudieron cargar las fotos");
  }
});

router.post("/olimpiadas/:id(\\d+)/fotos", verifyToken, soloSuperior, manejarUploadFotos, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const archivos = archivosDeSlot(req, "FOTOS");
    if (archivos.length === 0) return res.status(400).json("Adjuntá al menos una foto en el campo FOTOS");
    const comunes = leerCamposFoto(req.body || {}, { conEpigrafe: true });
    const disciplina = await validarDisciplinaCatalogo(db, comunes.disciplina_id);
    if (disciplina) comunes.disciplina_nombre = disciplina.nombre;
    const [[ultimo]] = await db.query("SELECT COALESCE(MAX(orden), 0) AS orden FROM olimpiada_foto WHERE olimpiada_id = ?", [olimpiadaId]);
    const { fotos, errores } = await procesarLoteFotos({
      archivos,
      olimpiadaId,
      comunes,
      usuarioId: cabecera.id,
      ordenInicial: Number(ultimo.orden) || 0,
    });
    if (fotos.length === 0) {
      const detalle = errores.map((e) => `${e.archivo}: ${e.error}`).join("; ");
      return res.status(400).json(`No se pudo subir ninguna foto${detalle ? ` (${detalle})` : ""}`);
    }
    await historial(db, cabecera, {
      entidad: "FOTO",
      olimpiada_id: olimpiadaId,
      tipo_operacion: "CREATE",
      valor_nuevo: `${fotos.length} fotos subidas${comunes.etiqueta ? ` (${comunes.etiqueta})` : ""}${errores.length ? `, ${errores.length} con error` : ""}`,
    });
    res.status(201).json({
      success: true,
      message: errores.length === 0
        ? `Se subieron ${fotos.length} fotos`
        : `Se subieron ${fotos.length} fotos; ${errores.length} no se pudieron procesar`,
      subidas: fotos.length,
      errores,
      fotos: await Promise.all(fotos.map(serializarFoto)),
    });
  } catch (error) {
    responderError(res, error, "No se pudieron subir las fotos");
  }
});

// Literal antes que /olimpiadas/fotos/:fotoId
router.put("/olimpiadas/fotos/lote", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const body = req.body || {};
    const ids = normalizarIds(body.ids);
    if (ids === null || ids.length === 0) return res.status(400).json("Elegí al menos una foto");
    if (ids.length > MAX_IDS_LOTE_FOTOS) return res.status(400).json(`Se pueden editar hasta ${MAX_IDS_LOTE_FOTOS} fotos por vez`);
    const cambios = leerCamposFoto(body);
    const campos = Object.keys(cambios);
    if (campos.length === 0) return res.status(400).json("Indicá al menos un dato para aplicar (disciplina, fecha o etiqueta)");
    await validarDisciplinaCatalogo(db, cambios.disciplina_id);
    const [olimpiadas] = await db.query("SELECT DISTINCT olimpiada_id FROM olimpiada_foto WHERE id IN (?) AND eliminado = 0", [ids]);
    const resultado = await enTransaccion(async (connection) => {
      const [update] = await connection.query(
        `UPDATE olimpiada_foto SET ${campos.map((campo) => `${campo} = ?`).join(", ")} WHERE id IN (?) AND eliminado = 0`,
        [...campos.map((campo) => cambios[campo]), ids]
      );
      for (const fila of olimpiadas) {
        await historial(connection, cabecera, {
          entidad: "FOTO",
          olimpiada_id: fila.olimpiada_id,
          tipo_operacion: "UPDATE",
          campo_modificado: "lote",
          valor_nuevo: `${ids.length} fotos: ${JSON.stringify(cambios)}`,
        });
      }
      return update.affectedRows;
    });
    res.status(200).json({ success: true, message: `Se actualizaron ${resultado} fotos`, actualizadas: resultado });
  } catch (error) {
    responderError(res, error, "No se pudieron actualizar las fotos");
  }
});

router.post("/olimpiadas/fotos/eliminar-lote", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const ids = normalizarIds(req.body?.ids);
    if (ids === null || ids.length === 0) return res.status(400).json("Elegí al menos una foto");
    if (ids.length > MAX_IDS_LOTE_FOTOS) return res.status(400).json(`Se pueden eliminar hasta ${MAX_IDS_LOTE_FOTOS} fotos por vez`);
    const [fotos] = await db.query("SELECT id, olimpiada_id, archivo, miniatura_archivo FROM olimpiada_foto WHERE id IN (?) AND eliminado = 0", [ids]);
    if (fotos.length === 0) return res.status(404).json("Las fotos ya no existen");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_foto SET eliminado = 1 WHERE id IN (?)", [fotos.map((foto) => foto.id)]);
      const porOlimpiada = new Map();
      for (const foto of fotos) porOlimpiada.set(foto.olimpiada_id, (porOlimpiada.get(foto.olimpiada_id) || 0) + 1);
      for (const [olimpiadaId, cantidad] of porOlimpiada.entries()) {
        await historial(connection, cabecera, {
          entidad: "FOTO",
          olimpiada_id: olimpiadaId,
          tipo_operacion: "DELETE",
          campo_modificado: "lote",
          valor_anterior: `${cantidad} fotos eliminadas`,
        });
      }
    });
    await eliminarObjetosS3Seguro(fotos.flatMap((foto) => [foto.archivo, foto.miniatura_archivo]));
    res.status(200).json({ success: true, message: `Se eliminaron ${fotos.length} fotos`, eliminadas: fotos.length });
  } catch (error) {
    responderError(res, error, "No se pudieron eliminar las fotos");
  }
});

router.put("/olimpiadas/fotos/:fotoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const fotoId = idDeRuta(req.params.fotoId);
    const actual = await exigirFila(db, "olimpiada_foto", fotoId, "La foto no existe");
    const cambios = leerCamposFoto(req.body || {}, { conEpigrafe: true });
    const campos = Object.keys(cambios);
    if (campos.length === 0) return res.status(400).json("Indicá al menos un dato para actualizar");
    await validarDisciplinaCatalogo(db, cambios.disciplina_id);
    await enTransaccion(async (connection) => {
      await connection.query(
        `UPDATE olimpiada_foto SET ${campos.map((campo) => `${campo} = ?`).join(", ")} WHERE id = ?`,
        [...campos.map((campo) => cambios[campo]), fotoId]
      );
      await historialCambios(
        connection,
        cabecera,
        { entidad: "FOTO", entidad_id: fotoId, olimpiada_id: actual.olimpiada_id },
        actual,
        { ...actual, ...cambios },
        campos
      );
    });
    const [rows] = await db.query(`${SELECT_FOTO} WHERE f.id = ?`, [fotoId]);
    res.status(200).json({ success: true, id: fotoId, message: "Foto actualizada", foto: rows[0] ? await serializarFoto(rows[0]) : null });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar la foto");
  }
});

router.delete("/olimpiadas/fotos/:fotoId(\\d+)", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const fotoId = idDeRuta(req.params.fotoId);
    const actual = await exigirFila(db, "olimpiada_foto", fotoId, "La foto no existe");
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_foto SET eliminado = 1 WHERE id = ?", [fotoId]);
      await historial(connection, cabecera, {
        entidad: "FOTO",
        entidad_id: fotoId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: actual.epigrafe || actual.archivo,
      });
    });
    await eliminarObjetosS3Seguro([actual.archivo, actual.miniatura_archivo]);
    res.status(200).json({ success: true, message: "Foto eliminada" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar la foto");
  }
});

// ---------------------------------------------------------------------------
router.__test = Object.freeze({
  TIPOS_SEDE,
  TIPOS_EVENTO,
  UBICACIONES_SECCION,
  TIPOS_ENLACE,
  ESTADOS_PARTIDO,
  estadoEdicion,
  dividirColumnas,
  esColumnaVacia,
  parsearFechaFlexible,
  parsearHoraFlexible,
  parsearEventosTexto,
  parsearPartidosTexto,
  calcularGanadorPartido,
  leerGanador,
  calcularTablaMedallero,
  agruparMedallasPorDisciplina,
  normalizarFechaHora,
  resumenTexto,
  leerTexto,
  leerEntero,
  leerFlag,
  leerFecha,
  leerHora,
  leerEnum,
  leerIdOpcional,
  leerUrl,
  leerNovedad,
  leerEvento,
  leerSede,
  leerContacto,
  leerSeccion,
  leerEnlace,
  leerPartido,
  leerCamposFoto,
  procesarLoteFotos,
});

module.exports = router;
