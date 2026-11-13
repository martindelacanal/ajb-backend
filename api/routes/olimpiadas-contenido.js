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
const { verificarAccesoCompeticion, exigirDisciplinaVoluntario, exigirEdicionVoluntario, esVoluntario, puedeEditarEdicion } = require('../security/olimpiadas-voluntarios');
const {
  CAMPOS_PARTIDO_EXTRA, TIPOS_ORIGEN, TIPOS_MARCADOR, REGLAS_DIVISION, MAX_PUESTOS, calcularPosiciones, listarTorneos, listarEquipos, filtroId,
  normalizarSets, contarSets, ahoraBuenosAires, estaEnVivo, conEnVivo, normalizarNombre, resolverClasificacion, hayCiclo,
  nombrePuesto, calcularTablaMedallero, agruparMedallasPorDisciplina, puestosSegunResultados,
} = require('../services/olimpiadas-competicion');
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
  listarNombresDisciplinas,
  firmarSeguro,
  subirImagenOptimizada,
  eliminarObjetosS3Seguro,
  crearUploadOlimpiadas,
  manejarUploadOlimpiadas,
  subirArchivoOlimpiadas,
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
const MAX_FOTO_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_FOTOS_BYTES = 80 * 1024 * 1024;
const MAX_IDS_LOTE_FOTOS = 200;
const MAX_LINEAS_IMPORTACION = 500;
const PAGE_SIZE_FOTOS = 24;
const MAX_PAGE_SIZE_FOTOS = 60;
const MAX_TEXTO_HISTORIAL = 500;

const manejarUploadFotos = crearUploadOlimpiadas({ maxFiles: MAX_FOTOS_POR_LOTE, maxTotalBytes: MAX_TOTAL_FOTOS_BYTES, maxFileBytes: MAX_FOTO_BYTES });

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
    observacion: [esVoluntario(cabecera) ? `Voluntario #${cabecera.voluntario_id}: ${cabecera.nombre || cabecera.usuario || ''}` : null, datos.observacion].filter(Boolean).join(' · ') || null,
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
    `SELECT c.id, c.disciplina_id, d.nombre, d.tipo_marcador, c.sede_id, c.veedor, c.reglamento,
            c.reglamento_archivo, c.reglamento_archivo_nombre
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
         (SELECT COUNT(*) FROM olimpiada_seccion s WHERE s.olimpiada_id = ? AND s.eliminado = 0 AND s.ubicacion = 'REGLAMENTO' ${condicionSecciones}) AS secciones_reglamento,
         (SELECT COUNT(*) FROM olimpiada_video v WHERE v.olimpiada_id = ? AND v.eliminado = 0 AND v.estado = 'LISTO') AS videos_propios`,
      Array(13).fill(olimpiadaId)
    );
    // El medallero se reserva hasta que la organización lo publica: sin eso, ni el conteo sale de la gestión.
    if (!esSuperior(cabecera) && Number(olimpiada.medallero_publicado) !== 1) conteos.medallas = 0;
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
    const disciplinas = (await listarNombresDisciplinas(db, olimpiadaId)).get(olimpiadaId) || [];
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
        medallero_publicado: Number(olimpiada.medallero_publicado) || 0,
        posiciones_publicas: Number(olimpiada.posiciones_publicas) || 0,
        videos,
        // Nombres de las disciplinas de la edición: el banner dibuja esos deportes
        disciplinas,
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
// Punto marcado en el mapa: van los dos valores o ninguno.
function leerCoordenadas(body, base = {}) {
  const leer = (nombre, limite) => {
    if (body[nombre] === undefined) return base[nombre] === null || base[nombre] === undefined ? null : Number(base[nombre]);
    if (body[nombre] === null || body[nombre] === "") return null;
    const numero = Number(String(body[nombre]).replace(",", "."));
    if (!Number.isFinite(numero) || Math.abs(numero) > limite) throw crearErrorHttp("La ubicación marcada en el mapa es inválida");
    return Math.round(numero * 1e7) / 1e7;
  };
  const lat = leer("lat", 90);
  const lng = leer("lng", 180);
  if ((lat === null) !== (lng === null)) throw crearErrorHttp("Marcá la ubicación completa en el mapa (latitud y longitud)");
  return { lat, lng };
}

function leerSede(body, base) {
  const datos = {
    tipo: leerEnum(body, "tipo", base, TIPOS_SEDE, { porDefecto: "DEPORTIVA", etiqueta: "el tipo de sede" }),
    nombre: leerTexto(body, "nombre", base, { maximo: 160, requerido: true, etiqueta: "el nombre de la sede" }),
    direccion: leerTexto(body, "direccion", base, { maximo: 200, etiqueta: "la dirección" }),
    telefono: leerTexto(body, "telefono", base, { maximo: 60, etiqueta: "el teléfono" }),
    descripcion: leerTexto(body, "descripcion", base, { maximo: 400, etiqueta: "la descripción" }),
    url_mapa: leerUrl(body, "url_mapa", base, { maximo: 400, etiqueta: "el enlace del mapa" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
    ...leerCoordenadas(body, base),
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
    `SELECT s.id, s.tipo, s.nombre, s.direccion, s.telefono, s.descripcion, s.url_mapa, s.orden, s.lat, s.lng
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
    lat: sede.lat === null ? null : Number(sede.lat),
    lng: sede.lng === null ? null : Number(sede.lng),
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
        `INSERT INTO olimpiada_sede (olimpiada_id, tipo, nombre, direccion, telefono, descripcion, url_mapa, orden, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [olimpiadaId, datos.tipo, datos.nombre, datos.direccion, datos.telefono, datos.descripcion, datos.url_mapa, datos.orden, datos.lat, datos.lng]
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
        `UPDATE olimpiada_sede SET tipo = ?, nombre = ?, direccion = ?, telefono = ?, descripcion = ?, url_mapa = ?, orden = ?, lat = ?, lng = ? WHERE id = ?`,
        [datos.tipo, datos.nombre, datos.direccion, datos.telefono, datos.descripcion, datos.url_mapa, datos.orden, datos.lat, datos.lng, sedeId]
      );
      const base = { entidad: "SEDE", entidad_id: sedeId, olimpiada_id: actual.olimpiada_id };
      await historialCambios(connection, cabecera, base, { ...actual, lat: actual.lat === null ? null : Number(actual.lat), lng: actual.lng === null ? null : Number(actual.lng) }, datos,
        ["tipo", "nombre", "direccion", "telefono", "descripcion", "url_mapa", "orden", "lat", "lng"]);
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
// La sede que se muestra es la del partido y, si no tiene, la de la disciplina (con su mapa).
const SELECT_PARTIDO = `
  SELECT p.id, p.olimpiada_id, p.disciplina_id, d.nombre AS disciplina_nombre, d.tipo_marcador, p.fecha, p.hora_inicio, p.hora_fin,
         p.etiqueta, p.fase, p.zona, p.participante1, p.participante2, p.departamental1_id, p.departamental2_id,
         p.equipo1_id, p.equipo2_id, eq1.nombre AS equipo1_nombre, eq2.nombre AS equipo2_nombre,
         p.resultado1, p.resultado2, p.sets, p.ganador, p.estado, p.sede_id,
         IF(s.id IS NULL, sd.nombre, s.nombre) AS sede_nombre, IF(s.id IS NULL, sd.direccion, s.direccion) AS sede_direccion,
         IF(s.id IS NULL, sd.url_mapa, s.url_mapa) AS sede_url_mapa, IF(s.id IS NULL, sd.lat, s.lat) AS sede_lat, IF(s.id IS NULL, sd.lng, s.lng) AS sede_lng,
         p.observacion, p.orden, p.fecha_modificacion, p.torneo_id, t.nombre AS torneo_nombre,
         p.instancia_id, inst.nombre AS instancia_nombre, ti.orden AS instancia_orden,
         p.lugar_id, l.nombre AS lugar_nombre, l.predio AS lugar_predio, l.direccion AS lugar_direccion, l.url_mapa AS lugar_url_mapa,
         l.lat AS lugar_lat, l.lng AS lugar_lng,
         p.inscripcion1_id, p.inscripcion2_id, p.mostrar_nombres_publico, p.partido_origen1_id, p.partido_origen2_id,
         p.origen1_tipo, p.origen1_zona, p.origen1_posicion, p.origen2_tipo, p.origen2_zona, p.origen2_posicion,
         dep1.nombre AS departamental1_nombre, dep2.nombre AS departamental2_nombre
  FROM olimpiada_partido p
  INNER JOIN olimpiada_disciplina d ON d.id = p.disciplina_id
  LEFT JOIN olimpiada_sede s ON s.id = p.sede_id AND s.eliminado = 0
  LEFT JOIN olimpiada_disciplina_config dc ON dc.olimpiada_id = p.olimpiada_id AND dc.disciplina_id = p.disciplina_id
  LEFT JOIN olimpiada_sede sd ON sd.id = dc.sede_id AND sd.eliminado = 0
  LEFT JOIN olimpiada_torneo t ON t.id = p.torneo_id
  LEFT JOIN olimpiada_instancia inst ON inst.id = p.instancia_id
  LEFT JOIN olimpiada_torneo_instancia ti ON ti.torneo_id = p.torneo_id AND ti.instancia_id = p.instancia_id
  LEFT JOIN olimpiada_lugar l ON l.id = p.lugar_id
  LEFT JOIN olimpiada_equipo eq1 ON eq1.id = p.equipo1_id
  LEFT JOIN olimpiada_equipo eq2 ON eq2.id = p.equipo2_id
  LEFT JOIN departamental dep1 ON dep1.id = p.departamental1_id
  LEFT JOIN departamental dep2 ON dep2.id = p.departamental2_id`;
const ORDEN_PARTIDOS = "p.fecha IS NULL, p.fecha, p.hora_inicio IS NULL, p.hora_inicio, p.orden, p.id";
const COORDENADAS_PARTIDO = ["sede_lat", "sede_lng", "lugar_lat", "lugar_lng"];

// Cada partido sale con sus sets ya leídos, las coordenadas como número y si está en vivo ahora.
function decorarPartidos(rows, ahora = ahoraBuenosAires()) {
  return conEnVivo(rows, ahora).map((partido) => {
    for (const campo of COORDENADAS_PARTIDO) {
      if (partido[campo] !== undefined) partido[campo] = partido[campo] === null ? null : Number(partido[campo]);
    }
    return partido;
  });
}

async function consultarPartidos(conexion, { condiciones, params, orden = ORDEN_PARTIDOS, limite = null }) {
  const [rows] = await conexion.query(
    `${SELECT_PARTIDO} WHERE p.eliminado = 0 AND ${condiciones.join(" AND ")} ORDER BY ${orden}${limite ? ` LIMIT ${Number(limite)}` : ""}`,
    params
  );
  return decorarPartidos(rows);
}

async function obtenerPartidoCompleto(conexion, partidoId) {
  const rows = await consultarPartidos(conexion, { condiciones: ["p.id = ?"], params: [partidoId] });
  return rows[0] || null;
}

// Sólo las disciplinas que se juegan: las categorías que no son deporte (prensa, organización…) no entran.
async function listarDisciplinasFixture(conexion, olimpiadaId) {
  const [rows] = await conexion.query(
    `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.icono_archivo, d.tipo_marcador,
            c.sede_id, s.nombre AS sede_nombre, s.direccion AS sede_direccion, s.url_mapa AS sede_url_mapa, s.lat AS sede_lat, s.lng AS sede_lng,
            c.veedor, c.reglamento, c.reglamento_archivo, c.reglamento_archivo_nombre,
            (SELECT COUNT(*) FROM olimpiada_partido p WHERE p.olimpiada_id = c.olimpiada_id AND p.disciplina_id = d.id AND p.eliminado = 0) AS partidos
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     LEFT JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
     LEFT JOIN olimpiada_sede s ON s.id = c.sede_id AND s.eliminado = 0
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y' AND COALESCE(t.competitiva, 1) = 1
     ORDER BY d.nombre`,
    [olimpiadaId]
  );
  const hoy = fechaHoyBuenosAires();
  const [[candidatos], [veedores]] = await Promise.all([
    conexion.query(
      `SELECT p.id, p.disciplina_id, p.estado, p.fecha, p.hora_inicio, p.hora_fin FROM olimpiada_partido p
       WHERE p.olimpiada_id = ? AND p.eliminado = 0 AND (p.estado = 'EN_JUEGO' OR (p.estado = 'PROGRAMADO' AND p.fecha = ?))`,
      [olimpiadaId, hoy]
    ),
    conexion.query(
      `SELECT a.disciplina_id, TRIM(CASE WHEN u.id IS NULL THEN v.nombre ELSE CONCAT_WS(' ', u.nombre, u.apellido) END) AS nombre
       FROM olimpiada_voluntario_disciplina a
       INNER JOIN olimpiada_voluntario v ON v.id = a.voluntario_id AND v.habilitado = 1
       LEFT JOIN usuario u ON u.id = v.usuario_sistema_id
       WHERE a.olimpiada_id = ? ORDER BY nombre`,
      [olimpiadaId]
    ),
  ]);
  const ahora = ahoraBuenosAires();
  const enVivoPor = new Map();
  for (const partido of candidatos) {
    if (estaEnVivo(partido, ahora)) enVivoPor.set(Number(partido.disciplina_id), (enVivoPor.get(Number(partido.disciplina_id)) || 0) + 1);
  }
  return Promise.all(
    rows.map(async (fila) => ({
      id: fila.id,
      nombre: fila.nombre,
      tipo_id: fila.tipo_id,
      tipo_nombre: fila.tipo_nombre || null,
      tipo_marcador: fila.tipo_marcador || "TANTOS",
      icono_url: await firmarSeguro(fila.icono_archivo),
      sede_id: fila.sede_id,
      sede_nombre: fila.sede_nombre || null,
      sede_direccion: fila.sede_direccion || null,
      sede_url_mapa: fila.sede_url_mapa || null,
      sede_lat: fila.sede_lat === null ? null : Number(fila.sede_lat),
      sede_lng: fila.sede_lng === null ? null : Number(fila.sede_lng),
      veedor: fila.veedor,
      // Quiénes están a cargo: las personas asignadas como veedoras de la disciplina en esta edición.
      veedores: veedores.filter((v) => Number(v.disciplina_id) === Number(fila.id) && v.nombre).map((v) => v.nombre),
      reglamento: fila.reglamento,
      reglamento_url: await firmarSeguro(fila.reglamento_archivo),
      reglamento_archivo_nombre: fila.reglamento_archivo ? fila.reglamento_archivo_nombre || "Reglamento.pdf" : null,
      partidos: Number(fila.partidos) || 0,
      en_vivo: enVivoPor.get(Number(fila.id)) || 0,
    }))
  );
}

// Escudos para pintar junto a cada participante: las departamentales y el de los equipos interdepartamentales.
async function listarEscudos(conexion) {
  const [[departamentales], [config]] = await Promise.all([
    conexion.query("SELECT id, nombre, logo_archivo FROM departamental ORDER BY nombre"),
    conexion.query("SELECT logo_interdepartamental_archivo FROM olimpiada_config WHERE id = 1"),
  ]);
  return {
    departamentales: await Promise.all(departamentales.map(async ({ logo_archivo, ...dep }) => ({ ...dep, logo_url: await firmarSeguro(logo_archivo) }))),
    logo_interdepartamental_url: await firmarSeguro(config[0]?.logo_interdepartamental_archivo),
  };
}

function ajustesCompeticion(olimpiada) {
  return {
    veedores_carga_abierta: Number(olimpiada.veedores_carga_abierta) || 0,
    medallero_publicado: Number(olimpiada.medallero_publicado) || 0,
    posiciones_publicas: Number(olimpiada.posiciones_publicas) || 0,
    medallero_division: olimpiada.medallero_division || "EXACTA",
  };
}

// Las tablas de posiciones por partidos quedan en la gestión salvo que la organización las publique.
function puedeVerPosiciones(cabecera, olimpiada) {
  return esSuperior(cabecera) || esVoluntario(cabecera) || Number(olimpiada.posiciones_publicas) === 1;
}

router.get("/olimpiadas/:id(\\d+)/fixture", verificarAccesoCompeticion, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const condiciones = ["p.olimpiada_id = ?"];
    const params = [olimpiadaId];
    if (asignadas) { condiciones.push('p.disciplina_id IN (?)'); params.push(asignadas.length ? asignadas : [0]); }
    if (req.query.disciplina_id !== undefined && req.query.disciplina_id !== "") {
      const disciplinaId = normalizarIdPositivo(req.query.disciplina_id);
      if (!disciplinaId) return res.status(400).json("La disciplina es inválida");
      condiciones.push("p.disciplina_id = ?");
      params.push(disciplinaId);
      await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId });
    }
    for (const campo of ['torneo_id', 'lugar_id']) { const id = filtroId(req.query, campo); if (id) { condiciones.push(`p.${campo} = ?`); params.push(id); } }
    const [disciplinas, partidos, torneos, equipos, escudos] = await Promise.all([
      listarDisciplinasFixture(db, olimpiadaId),
      consultarPartidos(db, { condiciones, params }),
      listarTorneos(db, olimpiadaId, asignadas),
      listarEquipos(db, olimpiadaId, asignadas),
      listarEscudos(db),
    ]);
    const puedeEditar = esSuperior(cabecera) || (esVoluntario(cabecera) && puedeEditarEdicion(olimpiada));
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      olimpiada: { id: olimpiada.id, nombre: olimpiada.nombre, fecha_inicio: olimpiada.fecha_inicio, fecha_fin: olimpiada.fecha_fin },
      puede_editar: puedeEditar,
      ajustes: ajustesCompeticion(olimpiada),
      disciplinas: asignadas ? disciplinas.filter(d => asignadas.includes(Number(d.id))) : disciplinas,
      partidos, torneos, equipos, ...escudos,
      posiciones: puedeVerPosiciones(cabecera, olimpiada) ? calcularPosiciones(partidos) : [],
    });
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
    // Cómo se carga el resultado es propio del deporte: vale para todas las ediciones.
    const tipoMarcador = body.tipo_marcador === undefined ? null
      : leerEnum(body, "tipo_marcador", actual, TIPOS_MARCADOR, { porDefecto: "TANTOS", etiqueta: "la forma de cargar el resultado" });
    await validarSedeDeOlimpiada(db, olimpiadaId, datos.sede_id);
    await enTransaccion(async (connection) => {
      await connection.query(
        "UPDATE olimpiada_disciplina_config SET sede_id = ?, veedor = ?, reglamento = ? WHERE olimpiada_id = ? AND disciplina_id = ?",
        [datos.sede_id, datos.veedor, datos.reglamento, olimpiadaId, disciplinaId]
      );
      if (tipoMarcador) await connection.query("UPDATE olimpiada_disciplina SET tipo_marcador = ? WHERE id = ?", [tipoMarcador, disciplinaId]);
      await historialCambios(
        connection,
        cabecera,
        { entidad: "DISCIPLINA_INFO", entidad_id: disciplinaId, olimpiada_id: olimpiadaId },
        actual,
        tipoMarcador ? { ...datos, tipo_marcador: tipoMarcador } : datos,
        tipoMarcador ? ["sede_id", "veedor", "reglamento", "tipo_marcador"] : ["sede_id", "veedor", "reglamento"]
      );
    });
    res.status(200).json({ success: true, message: `Información de ${actual.nombre} guardada` });
  } catch (error) {
    responderError(res, error, "No se pudo guardar la información de la disciplina");
  }
});

// Reglamento de la disciplina como archivo PDF (además del texto de la ficha).
router.post("/olimpiadas/:id(\\d+)/disciplinas/:disciplinaId(\\d+)/reglamento-archivo", verifyToken, soloSuperior, manejarUploadOlimpiadas, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const disciplinaId = idDeRuta(req.params.disciplinaId);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const actual = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    const archivo = archivoDeSlot(req, "REGLAMENTO");
    if (!archivo) return res.status(400).json("Adjuntá el reglamento en PDF");
    if (archivo.mimetype !== "application/pdf") return res.status(400).json("El reglamento tiene que ser un archivo PDF");
    const key = await subirArchivoOlimpiadas(archivo, `reglamentos/${olimpiadaId}/disciplina_${disciplinaId}`);
    const nombre = normalizarTexto(String(archivo.originalname || "Reglamento.pdf"), 160) || "Reglamento.pdf";
    try {
      await enTransaccion(async (connection) => {
        await connection.query(
          "UPDATE olimpiada_disciplina_config SET reglamento_archivo = ?, reglamento_archivo_nombre = ? WHERE olimpiada_id = ? AND disciplina_id = ?",
          [key, nombre, olimpiadaId, disciplinaId]
        );
        await historial(connection, cabecera, {
          entidad: "DISCIPLINA_INFO", entidad_id: disciplinaId, olimpiada_id: olimpiadaId, tipo_operacion: "UPDATE",
          campo_modificado: "reglamento_archivo", valor_anterior: actual.reglamento_archivo_nombre || null, valor_nuevo: nombre,
        });
      });
    } catch (error) {
      await eliminarObjetosS3Seguro([key]);
      throw error;
    }
    await eliminarObjetosS3Seguro([actual.reglamento_archivo]);
    res.status(200).json({ success: true, message: `Reglamento de ${actual.nombre} cargado`, reglamento_url: await firmarSeguro(key), reglamento_archivo_nombre: nombre });
  } catch (error) {
    responderError(res, error, "No se pudo cargar el reglamento");
  }
});

router.delete("/olimpiadas/:id(\\d+)/disciplinas/:disciplinaId(\\d+)/reglamento-archivo", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const disciplinaId = idDeRuta(req.params.disciplinaId);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const actual = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    if (!actual.reglamento_archivo) return res.status(200).json({ success: true, message: "La disciplina no tenía un reglamento en PDF" });
    await enTransaccion(async (connection) => {
      await connection.query(
        "UPDATE olimpiada_disciplina_config SET reglamento_archivo = NULL, reglamento_archivo_nombre = NULL WHERE olimpiada_id = ? AND disciplina_id = ?",
        [olimpiadaId, disciplinaId]
      );
      await historial(connection, cabecera, {
        entidad: "DISCIPLINA_INFO", entidad_id: disciplinaId, olimpiada_id: olimpiadaId, tipo_operacion: "UPDATE",
        campo_modificado: "reglamento_archivo", valor_anterior: actual.reglamento_archivo_nombre || "Reglamento.pdf", valor_nuevo: null,
      });
    });
    await eliminarObjetosS3Seguro([actual.reglamento_archivo]);
    res.status(200).json({ success: true, message: "Reglamento en PDF quitado" });
  } catch (error) {
    responderError(res, error, "No se pudo quitar el reglamento");
  }
});

// De dónde sale cada lado cuando el partido se arma solo: el ganador o el perdedor de otro partido,
// o un puesto de una zona. Si el lado se elige a mano, no tiene origen.
function leerOrigen(body, base, lado) {
  const campoTipo = `origen${lado}_tipo`;
  let tipo;
  if (body[campoTipo] === undefined) tipo = base[campoTipo] ?? null;
  else if (body[campoTipo] === null || body[campoTipo] === "") tipo = null;
  else {
    tipo = String(body[campoTipo]).trim().toUpperCase();
    if (!TIPOS_ORIGEN.includes(tipo)) throw crearErrorHttp(`El origen del participante ${lado} es inválido`);
  }
  let partidoOrigen = leerIdOpcional(body, `partido_origen${lado}_id`, base);
  // Compatibilidad: un partido de origen sin tipo es «el ganador de».
  if (!tipo && partidoOrigen && body[campoTipo] === undefined) tipo = "GANADOR";
  let zona = leerTexto(body, `origen${lado}_zona`, base, { maximo: 40, etiqueta: `la zona de origen del participante ${lado}` });
  let posicion = body[`origen${lado}_posicion`] === undefined ? base[`origen${lado}_posicion`] ?? null
    : body[`origen${lado}_posicion`] === null || body[`origen${lado}_posicion`] === "" ? null : Number(body[`origen${lado}_posicion`]);
  if (tipo === "POSICION") {
    if (!zona) throw crearErrorHttp(`Indicá de qué zona sale el participante ${lado}`);
    if (!Number.isInteger(posicion) || posicion < 1 || posicion > 20) throw crearErrorHttp(`Indicá qué puesto de la zona ocupa el participante ${lado} (1 a 20)`);
    partidoOrigen = null;
  } else {
    zona = null;
    posicion = null;
    if (tipo && !partidoOrigen) throw crearErrorHttp(`Elegí de qué partido viene el participante ${lado}`);
    if (!tipo) partidoOrigen = null;
  }
  return { tipo, partidoOrigen, zona, posicion };
}

function leerPartido(body, base, { completo = false } = {}) {
  const datos = {
    disciplina_id: leerIdOpcional(body, "disciplina_id", base, { etiqueta: "la disciplina" }),
    fecha: leerFecha(body, "fecha", base, { etiqueta: "la fecha" }),
    hora_inicio: leerHora(body, "hora_inicio", base, { etiqueta: "la hora de inicio" }),
    hora_fin: leerHora(body, "hora_fin", base, { etiqueta: "la hora de fin" }),
    etiqueta: leerTexto(body, "etiqueta", base, { maximo: 40, etiqueta: "la etiqueta" }),
    fase: leerTexto(body, "fase", base, { maximo: 60, etiqueta: "la fase" }),
    zona: leerTexto(body, "zona", base, { maximo: 40, etiqueta: "la zona" }),
    participante1: leerTexto(body, "participante1", base, { maximo: 120, etiqueta: "el participante 1" }),
    participante2: leerTexto(body, "participante2", base, { maximo: 120, etiqueta: "el participante 2" }),
    departamental1_id: leerIdOpcional(body, "departamental1_id", base, { etiqueta: "la departamental del participante 1" }),
    departamental2_id: leerIdOpcional(body, "departamental2_id", base, { etiqueta: "la departamental del participante 2" }),
    equipo1_id: leerIdOpcional(body, "equipo1_id", base, { etiqueta: "el equipo del participante 1" }),
    equipo2_id: leerIdOpcional(body, "equipo2_id", base, { etiqueta: "el equipo del participante 2" }),
    sede_id: leerIdOpcional(body, "sede_id", base, { etiqueta: "la sede" }),
    observacion: leerTexto(body, "observacion", base, { maximo: 300, etiqueta: "la observación" }),
    orden: leerEntero(body, "orden", base, { etiqueta: "el orden" }),
    torneo_id: leerIdOpcional(body, 'torneo_id', base),
    instancia_id: leerIdOpcional(body, 'instancia_id', base),
    lugar_id: leerIdOpcional(body, 'lugar_id', base),
    inscripcion1_id: leerIdOpcional(body, 'inscripcion1_id', base),
    inscripcion2_id: leerIdOpcional(body, 'inscripcion2_id', base),
    mostrar_nombres_publico: leerFlag(body, 'mostrar_nombres_publico', base, 0),
  };
  for (const lado of [1, 2]) {
    const origen = leerOrigen(body, base, lado);
    datos[`origen${lado}_tipo`] = origen.tipo;
    datos[`partido_origen${lado}_id`] = origen.partidoOrigen;
    datos[`origen${lado}_zona`] = origen.zona;
    datos[`origen${lado}_posicion`] = origen.posicion;
    // Elegir un equipo, una departamental o un afiliado deja atrás las otras dos opciones de ese lado.
    if (body[`equipo${lado}_id`] && datos[`equipo${lado}_id`]) { datos[`departamental${lado}_id`] = null; datos[`inscripcion${lado}_id`] = null; }
    else if (body[`inscripcion${lado}_id`] && datos[`inscripcion${lado}_id`]) datos[`equipo${lado}_id`] = null;
    else if (body[`departamental${lado}_id`] && datos[`departamental${lado}_id`]) { datos[`equipo${lado}_id`] = null; if (body[`inscripcion${lado}_id`] === undefined) datos[`inscripcion${lado}_id`] = null; }
  }
  if (!datos.disciplina_id) throw crearErrorHttp("Indicá la disciplina del partido");
  if (datos.hora_inicio && datos.hora_fin && datos.hora_fin <= datos.hora_inicio) throw crearErrorHttp('La hora de fin debe ser posterior al inicio');
  if (completo) {
    datos.estado = leerEnum(body, "estado", base, ESTADOS_PARTIDO, { porDefecto: "PROGRAMADO", etiqueta: "el estado" });
    datos.resultado1 = leerTexto(body, "resultado1", base, { maximo: 20, etiqueta: "el resultado 1" });
    datos.resultado2 = leerTexto(body, "resultado2", base, { maximo: 20, etiqueta: "el resultado 2" });
    const ganador = leerGanador(body.ganador);
    datos.ganador = ganador === undefined ? base.ganador ?? null : ganador;
    const sets = normalizarSets(body.sets);
    datos.sets = sets === undefined ? base.sets ?? null : sets ? JSON.stringify(sets) : null;
    if (sets) [datos.resultado1, datos.resultado2] = contarSets(sets).map(String);
  }
  return datos;
}

async function validarReferenciasPartido(conexion, olimpiadaId, datos) {
  await validarDisciplinaDeOlimpiada(conexion, olimpiadaId, datos.disciplina_id);
  await validarSedeDeOlimpiada(conexion, olimpiadaId, datos.sede_id);
  if (datos.torneo_id) {
    const [[torneo]] = await conexion.query('SELECT id FROM olimpiada_torneo WHERE id = ? AND olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0', [datos.torneo_id, olimpiadaId, datos.disciplina_id]);
    if (!torneo) throw crearErrorHttp('El torneo no pertenece a esta edición y disciplina');
  }
  if (datos.instancia_id) {
    if (!datos.torneo_id) throw crearErrorHttp('Elegí un torneo para seleccionar su instancia');
    const [[instancia]] = await conexion.query('SELECT i.nombre FROM olimpiada_torneo_instancia ti INNER JOIN olimpiada_instancia i ON i.id = ti.instancia_id WHERE ti.torneo_id = ? AND ti.instancia_id = ?', [datos.torneo_id, datos.instancia_id]);
    if (!instancia) throw crearErrorHttp('La instancia no pertenece al torneo');
    datos.fase = instancia.nombre;
  }
  if (datos.lugar_id) {
    const [[lugar]] = await conexion.query('SELECT id FROM olimpiada_lugar WHERE id = ? AND eliminado = 0', [datos.lugar_id]);
    if (!lugar) throw crearErrorHttp('El lugar elegido no existe');
  }
  for (const lado of [1, 2]) {
    if (datos[`equipo${lado}_id`]) {
      const [[equipo]] = await conexion.query('SELECT id, nombre FROM olimpiada_equipo WHERE id = ? AND olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0', [datos[`equipo${lado}_id`], olimpiadaId, datos.disciplina_id]);
      if (!equipo) throw crearErrorHttp(`El equipo interdepartamental del participante ${lado} no pertenece a esta disciplina`);
      datos[`participante${lado}`] = String(equipo.nombre).slice(0, 120);
      datos[`departamental${lado}_id`] = null;
      datos[`inscripcion${lado}_id`] = null;
    } else if (datos[`inscripcion${lado}_id`]) {
      const [[inscripcion]] = await conexion.query(`SELECT i.id, i.departamental_id, u.nombre, u.apellido FROM olimpiada_inscripcion i
        INNER JOIN usuario u ON u.id = i.usuario_id
        INNER JOIN olimpiada_inscripcion_disciplina d ON d.inscripcion_id = i.id AND d.disciplina_id = ?
        WHERE i.id = ? AND i.olimpiada_id = ? AND i.estado = 'VALIDADO' AND i.eliminado = 0`, [datos.disciplina_id, datos[`inscripcion${lado}_id`], olimpiadaId]);
      if (!inscripcion) throw crearErrorHttp(`El participante ${lado} debe tener inscripción aprobada en esta disciplina`);
      datos[`participante${lado}`] = `${inscripcion.apellido || ''} ${inscripcion.nombre || ''}`.trim();
      datos[`departamental${lado}_id`] = inscripcion.departamental_id;
    } else if (datos[`departamental${lado}_id`]) {
      const departamental = await validarDepartamentalOpcional(conexion, datos[`departamental${lado}_id`], `la departamental ${lado}`);
      datos[`participante${lado}`] = departamental.nombre;
    }
    const tipo = datos[`origen${lado}_tipo`];
    if (tipo === 'POSICION') {
      datos[`participante${lado}`] ||= 'A confirmar';
    } else if (datos[`partido_origen${lado}_id`]) {
      const [[origen]] = await conexion.query('SELECT id, torneo_id FROM olimpiada_partido WHERE id = ? AND olimpiada_id = ? AND disciplina_id = ? AND eliminado = 0', [datos[`partido_origen${lado}_id`], olimpiadaId, datos.disciplina_id]);
      if (!origen || Number(origen.torneo_id) !== Number(datos.torneo_id)) throw crearErrorHttp('El partido de origen debe pertenecer al mismo torneo y disciplina');
      datos[`participante${lado}`] ||= `Ganador del partido ${origen.id}`;
    }
    if (!datos[`participante${lado}`]) throw crearErrorHttp(`Elegí la departamental, el equipo o el afiliado del participante ${lado}`);
  }
  if (datos.inscripcion1_id && datos.inscripcion1_id === datos.inscripcion2_id) throw crearErrorHttp('Un afiliado no puede enfrentarse consigo mismo');
  if (datos.equipo1_id && datos.equipo1_id === datos.equipo2_id) throw crearErrorHttp('Un equipo no puede enfrentarse consigo mismo');
  if (datos.partido_origen1_id && datos.partido_origen1_id === datos.partido_origen2_id && datos.origen1_tipo === datos.origen2_tipo) {
    throw crearErrorHttp('Los dos participantes no pueden venir del mismo resultado del mismo partido');
  }
}

async function autorizarPartido(cabecera, olimpiadaId, disciplinaId, datos = null, actual = null) {
  if (!esSuperior(cabecera) && !esVoluntario(cabecera)) throw crearErrorHttp('No autorizado', 403);
  await exigirDisciplinaVoluntario({ db, cabecera, olimpiadaId, disciplinaId, escritura: true });
  if (esVoluntario(cabecera) && datos && Number(datos.mostrar_nombres_publico) !== Number(actual?.mostrar_nombres_publico || 0)) throw crearErrorHttp('La publicación de nombres la decide la administración', 403);
}

async function guardarExtrasPartido(connection, partidoId, datos) {
  const origenes = [datos.partido_origen1_id, datos.partido_origen2_id].filter(Boolean).map(Number);
  if (origenes.includes(Number(partidoId))) throw crearErrorHttp('Un partido no puede venir de sí mismo');
  if (origenes.length) {
    // Un partido no puede depender, ni siquiera a través de otros, de su propio resultado.
    const [vecinos] = await connection.query(
      'SELECT id, partido_origen1_id, partido_origen2_id FROM olimpiada_partido WHERE eliminado = 0 AND olimpiada_id = (SELECT olimpiada_id FROM olimpiada_partido WHERE id = ?)',
      [partidoId]
    );
    if (hayCiclo(vecinos, partidoId, origenes)) throw crearErrorHttp('Ese partido de origen depende de este partido: elegí otro');
  }
  await connection.query(`UPDATE olimpiada_partido SET ${CAMPOS_PARTIDO_EXTRA.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...CAMPOS_PARTIDO_EXTRA.map(c => datos[c] ?? null), partidoId]);
}

// Prevent a concurrent edit (including a discipline reassignment) from silently
// replacing the row that was authorized and used as the audit's previous value.
async function bloquearSinCambios(connection, tabla, anterior) {
  if (!['olimpiada_partido', 'olimpiada_torneo'].includes(tabla)) throw new Error('Tabla de competición inválida');
  const [[actual]] = await connection.query(`SELECT * FROM ${tabla} WHERE id = ? AND eliminado = 0 FOR UPDATE`, [anterior.id]);
  if (!actual) throw crearErrorHttp('El registro ya no existe', 404);
  if (Object.keys(anterior).some(campo => textoComparable(actual[campo]) !== textoComparable(anterior[campo]))) {
    throw crearErrorHttp('Otra persona actualizó este registro. Recargá los datos antes de guardar.', 409);
  }
  return actual;
}

function describirPartido(partido) {
  const fecha = partido.fecha ? `${normalizarFechaCivil(partido.fecha) || partido.fecha} ` : "";
  return `${fecha}${partido.participante1} vs ${partido.participante2}${partido.etiqueta ? ` (${partido.etiqueta})` : ""}`;
}

// ---------------------------------------------------------------------------
// Clasificación automática y medallas que salen de los resultados
// ---------------------------------------------------------------------------
const SELECT_PARTIDO_CLASIFICACION = `
  SELECT p.id, p.torneo_id, p.zona, p.etiqueta, p.fase, inst.nombre AS instancia_nombre, p.estado, p.ganador, p.resultado1, p.resultado2,
         p.participante1, p.participante2, p.departamental1_id, p.departamental2_id, p.inscripcion1_id, p.inscripcion2_id,
         p.equipo1_id, p.equipo2_id, eq1.nombre AS equipo1_nombre, eq2.nombre AS equipo2_nombre,
         dep1.nombre AS departamental1_nombre, dep2.nombre AS departamental2_nombre,
         p.partido_origen1_id, p.partido_origen2_id, p.origen1_tipo, p.origen1_zona, p.origen1_posicion,
         p.origen2_tipo, p.origen2_zona, p.origen2_posicion
  FROM olimpiada_partido p
  LEFT JOIN olimpiada_instancia inst ON inst.id = p.instancia_id
  LEFT JOIN olimpiada_equipo eq1 ON eq1.id = p.equipo1_id
  LEFT JOIN olimpiada_equipo eq2 ON eq2.id = p.equipo2_id
  LEFT JOIN departamental dep1 ON dep1.id = p.departamental1_id
  LEFT JOIN departamental dep2 ON dep2.id = p.departamental2_id
  WHERE p.olimpiada_id = ? AND p.disciplina_id = ? AND p.eliminado = 0
  ORDER BY p.id`;

// Completa (o vuelve a dejar por definir) los cruces que dependen de otros resultados.
async function aplicarClasificacion(connection, cabecera, olimpiadaId, disciplinaId) {
  const [partidos] = await connection.query(SELECT_PARTIDO_CLASIFICACION, [olimpiadaId, disciplinaId]);
  const { cambios, avisos } = resolverClasificacion(partidos);
  const porId = new Map(partidos.map(p => [Number(p.id), p]));
  for (const cambio of cambios) {
    await connection.query("UPDATE olimpiada_partido SET ? WHERE id = ?", [cambio.campos, cambio.id]);
    const partido = porId.get(cambio.id);
    for (const [lado, detalle] of Object.entries(cambio.lados)) {
      if (String(detalle.anterior || "") === String(detalle.nuevo || "")) continue;
      await historial(connection, cabecera, {
        entidad: "PARTIDO", entidad_id: cambio.id, olimpiada_id: olimpiadaId, tipo_operacion: "UPDATE",
        campo_modificado: `participante${lado}`, valor_anterior: detalle.anterior, valor_nuevo: detalle.nuevo,
        observacion: "Clasificación automática según los resultados cargados",
      });
    }
    if (cambio.jugado) {
      const rotulo = [partido?.instancia_nombre || partido?.fase, partido?.etiqueta].filter(Boolean).join(" ") || `#${cambio.id}`;
      avisos.push(`El partido ${rotulo} ya tenía marcador y cambió un participante: revisalo.`);
    }
  }
  return { clasificados: cambios.length, avisos };
}

async function leerPuntosPuestos(conexion, olimpiada) {
  const [rows] = await conexion.query("SELECT puesto, puntos FROM olimpiada_puntos_puesto WHERE olimpiada_id = ? ORDER BY puesto", [olimpiada.id]);
  if (rows.length) return rows.map(r => ({ puesto: Number(r.puesto), puntos: Number(r.puntos) || 0, nombre: nombrePuesto(Number(r.puesto)) }));
  return [olimpiada.puntos_oro, olimpiada.puntos_plata, olimpiada.puntos_bronce].map((puntos, i) => ({ puesto: i + 1, puntos: Number(puntos) || 0, nombre: nombrePuesto(i + 1) }));
}

function describirMedallas(filas) {
  const puestos = [...new Set(filas.map(f => Number(f.puesto)))].sort((a, b) => a - b);
  return puestos.map((puesto) => {
    const nombres = filas.filter(f => Number(f.puesto) === puesto).map(f => f.nombre);
    return `${nombrePuesto(puesto)}: ${nombres.join(" / ")}`;
  }).join(" · ");
}

/**
 * Medallas que salen solas de los resultados: la final define oro y plata; el tercer puesto, bronce
 * y cuarto. Sólo toca las medallas automáticas: si la administración cargó a mano los puestos de una
 * disciplina, esa disciplina queda como la dejó (hasta que elija «volver al cálculo automático»).
 */
async function sincronizarMedallasAutomaticas(connection, cabecera, olimpiadaId, disciplinaId) {
  const [existentes] = await connection.query(
    `SELECT m.id, m.puesto, m.departamental_id, m.equipo_id, m.origen, dep.nombre
     FROM olimpiada_medalla m INNER JOIN departamental dep ON dep.id = m.departamental_id
     WHERE m.olimpiada_id = ? AND m.disciplina_id = ? ORDER BY m.puesto, dep.nombre`,
    [olimpiadaId, disciplinaId]
  );
  if (existentes.some(m => m.origen === "MANUAL")) return false;
  const [partidos] = await connection.query(SELECT_PARTIDO_CLASIFICACION, [olimpiadaId, disciplinaId]);
  const puestos = puestosSegunResultados(partidos) || [];
  const deseadas = [];
  for (const { puesto, competidor } of puestos) {
    let filas = [];
    if (competidor.equipo_id) {
      const [miembros] = await connection.query(
        `SELECT d.id, d.nombre FROM olimpiada_equipo_departamental ed INNER JOIN departamental d ON d.id = ed.departamental_id WHERE ed.equipo_id = ? ORDER BY d.nombre`,
        [competidor.equipo_id]
      );
      filas = miembros.map(m => ({ puesto, departamental_id: Number(m.id), equipo_id: Number(competidor.equipo_id), nombre: m.nombre }));
    } else if (competidor.departamental_id) {
      const [[departamental]] = await connection.query("SELECT id, nombre FROM departamental WHERE id = ?", [competidor.departamental_id]);
      if (departamental) filas = [{ puesto, departamental_id: Number(departamental.id), equipo_id: null, nombre: departamental.nombre }];
    }
    for (const fila of filas) {
      if (!deseadas.some(d => d.puesto === fila.puesto && d.departamental_id === fila.departamental_id)) deseadas.push(fila);
    }
  }
  const clave = f => `${Number(f.puesto)}:${Number(f.departamental_id)}:${Number(f.equipo_id) || 0}`;
  const antes = existentes.map(clave).sort().join("|");
  const despues = deseadas.map(clave).sort().join("|");
  if (antes === despues) return false;
  await connection.query("DELETE FROM olimpiada_medalla WHERE olimpiada_id = ? AND disciplina_id = ? AND origen = 'AUTO'", [olimpiadaId, disciplinaId]);
  for (const fila of deseadas) {
    await connection.query(
      "INSERT INTO olimpiada_medalla (olimpiada_id, disciplina_id, puesto, departamental_id, equipo_id, origen) VALUES (?, ?, ?, ?, ?, 'AUTO')",
      [olimpiadaId, disciplinaId, fila.puesto, fila.departamental_id, fila.equipo_id]
    );
  }
  const [[disciplina]] = await connection.query("SELECT nombre FROM olimpiada_disciplina WHERE id = ?", [disciplinaId]);
  await historial(connection, cabecera, {
    entidad: "MEDALLA", entidad_id: disciplinaId, olimpiada_id: olimpiadaId, tipo_operacion: "UPDATE",
    campo_modificado: disciplina?.nombre || null,
    valor_anterior: describirMedallas(existentes) || null, valor_nuevo: describirMedallas(deseadas) || null,
    observacion: "Calculado con los resultados cargados",
  });
  return true;
}

// Todo lo que se actualiza solo después de tocar un partido de la disciplina.
async function aplicarEfectosCompeticion(connection, cabecera, olimpiadaId, disciplinaId) {
  const clasificacion = await aplicarClasificacion(connection, cabecera, olimpiadaId, disciplinaId);
  const medallas = await sincronizarMedallasAutomaticas(connection, cabecera, olimpiadaId, disciplinaId);
  return { ...clasificacion, medallas };
}

function mensajeConEfectos(mensaje, efectos) {
  const partes = [mensaje];
  if (efectos?.clasificados) partes.push(efectos.clasificados === 1 ? "Se actualizó 1 cruce de la fase siguiente." : `Se actualizaron ${efectos.clasificados} cruces de las fases siguientes.`);
  for (const aviso of efectos?.avisos || []) partes.push(aviso);
  return partes.join(" ");
}

// Para la importación desde texto: si el nombre coincide con una departamental o con un equipo
// interdepartamental («Dolores + Mar del Plata»), el partido queda vinculado y lleva su escudo.
async function prepararVinculacionPorNombre(conexion, olimpiadaId, disciplinaId) {
  const [departamentales] = await conexion.query("SELECT id, nombre FROM departamental");
  const equipos = await listarEquipos(conexion, olimpiadaId, [disciplinaId]);
  const porNombre = new Map(departamentales.map(d => [normalizarNombre(d.nombre), d]));
  const claveEquipo = ids => [...ids].sort((a, b) => a - b).join("-");
  const equipoPorMiembros = new Map(equipos.map(e => [claveEquipo(e.departamental_ids), e]));
  return async function vincular(connection, texto) {
    const directo = porNombre.get(normalizarNombre(texto));
    if (directo) return { participante: directo.nombre, departamental_id: directo.id, equipo_id: null };
    const partes = String(texto || "").split(/\s*(?:\+|\/| y )\s*/i).map(parte => porNombre.get(normalizarNombre(parte)));
    if (partes.length >= 2 && partes.length <= 6 && partes.every(Boolean) && new Set(partes.map(p => p.id)).size === partes.length) {
      const ids = partes.map(p => Number(p.id));
      let equipo = equipoPorMiembros.get(claveEquipo(ids));
      if (!equipo) {
        const nombre = partes.map(p => p.nombre).join(" + ").slice(0, 160);
        const [insert] = await connection.query("INSERT INTO olimpiada_equipo (olimpiada_id, disciplina_id, nombre) VALUES (?, ?, ?)", [olimpiadaId, disciplinaId, nombre]);
        for (const id of ids) await connection.query("INSERT INTO olimpiada_equipo_departamental (equipo_id, departamental_id) VALUES (?, ?)", [insert.insertId, id]);
        equipo = { id: insert.insertId, nombre, departamental_ids: ids };
        equipoPorMiembros.set(claveEquipo(ids), equipo);
      }
      return { participante: String(equipo.nombre).slice(0, 120), departamental_id: null, equipo_id: equipo.id };
    }
    return { participante: texto, departamental_id: null, equipo_id: null };
  };
}

router.post("/olimpiadas/:id(\\d+)/partidos", verificarAccesoCompeticion, async (req, res) => {
  const cabecera = getCabecera(req);
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const datos = leerPartido(req.body || {}, {});
    await autorizarPartido(cabecera, olimpiadaId, datos.disciplina_id, datos);
    await validarReferenciasPartido(db, olimpiadaId, datos);
    let efectos = null;
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
      await guardarExtrasPartido(connection, insert.insertId, datos);
      await historial(connection, cabecera, {
        entidad: "PARTIDO",
        entidad_id: insert.insertId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "CREATE",
        valor_nuevo: describirPartido(datos),
      });
      efectos = await aplicarEfectosCompeticion(connection, cabecera, olimpiadaId, datos.disciplina_id);
      return insert.insertId;
    });
    res.status(201).json({ success: true, id: partidoId, message: mensajeConEfectos("Partido agregado al fixture.", { avisos: efectos?.avisos }) });
  } catch (error) {
    responderError(res, error, "No se pudo crear el partido");
  }
});

router.post("/olimpiadas/:id(\\d+)/partidos/importar", verificarAccesoCompeticion, async (req, res) => {
  const cabecera = getCabecera(req);
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const disciplinaId = normalizarIdPositivo(body.disciplina_id);
    if (!disciplinaId) return res.status(400).json("Elegí la disciplina a la que pertenecen los partidos");
    await autorizarPartido(cabecera, olimpiadaId, disciplinaId);
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
    let vinculados = 0;
    const vincular = await prepararVinculacionPorNombre(db, olimpiadaId, disciplinaId);
    await enTransaccion(async (connection) => {
      for (const partido of partidos) {
        orden += 1;
        const lado1 = await vincular(connection, partido.participante1);
        const lado2 = await vincular(connection, partido.participante2);
        if (lado1.departamental_id || lado1.equipo_id) vinculados += 1;
        if (lado2.departamental_id || lado2.equipo_id) vinculados += 1;
        await connection.query(
          `INSERT INTO olimpiada_partido (olimpiada_id, disciplina_id, fecha, hora_inicio, hora_fin, etiqueta, participante1, participante2,
             departamental1_id, departamental2_id, equipo1_id, equipo2_id, orden)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [olimpiadaId, disciplinaId, partido.fecha, partido.hora_inicio, partido.hora_fin, partido.etiqueta, lado1.participante, lado2.participante,
            lado1.departamental_id, lado2.departamental_id, lado1.equipo_id, lado2.equipo_id, orden]
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
    const sinVincular = partidos.length * 2 - vinculados;
    res.status(201).json({
      success: true,
      message: `Se importaron ${partidos.length} partidos de ${disciplina.nombre}${ignoradas > 0 ? ` (${ignoradas} líneas ignoradas)` : ""}.`
        + (sinVincular > 0 ? ` ${sinVincular} participante(s) no coinciden con una departamental: revisalos para que lleven su escudo.` : ""),
      creados: partidos.length,
      ignoradas,
    });
  } catch (error) {
    responderError(res, error, "No se pudieron importar los partidos");
  }
});

router.put("/olimpiadas/partidos/:partidoId(\\d+)", verificarAccesoCompeticion, async (req, res) => {
  const cabecera = getCabecera(req);
  try {
    const partidoId = idDeRuta(req.params.partidoId);
    const actual = await exigirFila(db, "olimpiada_partido", partidoId, "El partido no existe");
    const body = req.body || {};
    const datos = leerPartido(body, actual, { completo: true });
    await autorizarPartido(cabecera, actual.olimpiada_id, actual.disciplina_id, datos, actual);
    await autorizarPartido(cabecera, actual.olimpiada_id, datos.disciplina_id, datos, actual);
    if ((body.resultado1 !== undefined || body.resultado2 !== undefined || body.sets !== undefined) && body.ganador === undefined) datos.ganador = null;
    // Finalizado sin ganador definido y con marcador numérico → se calcula (igual que /resultado).
    if (datos.estado === "FINALIZADO" && datos.ganador === null) {
      datos.ganador = calcularGanadorPartido(datos.resultado1, datos.resultado2);
    }
    if (datos.estado !== "FINALIZADO") datos.ganador = null;
    await validarReferenciasPartido(db, actual.olimpiada_id, datos);
    let efectos = null;
    await enTransaccion(async (connection) => {
      await bloquearSinCambios(connection, 'olimpiada_partido', actual);
      await connection.query(
        `UPDATE olimpiada_partido
         SET disciplina_id = ?, fecha = ?, hora_inicio = ?, hora_fin = ?, etiqueta = ?, fase = ?, participante1 = ?, participante2 = ?,
             departamental1_id = ?, departamental2_id = ?, sede_id = ?, observacion = ?, orden = ?,
             estado = ?, resultado1 = ?, resultado2 = ?, ganador = ?, sets = ?
         WHERE id = ?`,
        [
          datos.disciplina_id, datos.fecha, datos.hora_inicio, datos.hora_fin, datos.etiqueta, datos.fase, datos.participante1,
          datos.participante2, datos.departamental1_id, datos.departamental2_id, datos.sede_id, datos.observacion, datos.orden,
          datos.estado, datos.resultado1, datos.resultado2, datos.ganador, datos.sets, partidoId,
        ]
      );
      await guardarExtrasPartido(connection, partidoId, datos);
      await historialCambios(
        connection,
        cabecera,
        { entidad: "PARTIDO", entidad_id: partidoId, olimpiada_id: actual.olimpiada_id },
        actual,
        datos,
        [
          "disciplina_id", "fecha", "hora_inicio", "hora_fin", "etiqueta", "fase", "participante1", "participante2",
          "departamental1_id", "departamental2_id", "sede_id", "observacion", "orden", "estado", "resultado1", "resultado2", "ganador", "sets",
          ...CAMPOS_PARTIDO_EXTRA,
        ]
      );
      efectos = await aplicarEfectosCompeticion(connection, cabecera, actual.olimpiada_id, datos.disciplina_id);
      if (Number(actual.disciplina_id) !== Number(datos.disciplina_id)) {
        await aplicarEfectosCompeticion(connection, cabecera, actual.olimpiada_id, actual.disciplina_id);
      }
    });
    res.status(200).json({ success: true, id: partidoId, message: mensajeConEfectos("Partido actualizado.", efectos), partido: await obtenerPartidoCompleto(db, partidoId) });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el partido");
  }
});

const MENSAJE_RESULTADO = {
  PROGRAMADO: "Partido reprogramado.",
  EN_JUEGO: "Partido en juego.",
  FINALIZADO: "Resultado cargado.",
  SUSPENDIDO: "Partido suspendido.",
};

router.put("/olimpiadas/partidos/:partidoId(\\d+)/resultado", verificarAccesoCompeticion, async (req, res) => {
  const cabecera = getCabecera(req);
  try {
    const partidoId = idDeRuta(req.params.partidoId);
    const actual = await exigirFila(db, "olimpiada_partido", partidoId, "El partido no existe");
    await autorizarPartido(cabecera, actual.olimpiada_id, actual.disciplina_id);
    const body = req.body || {};
    if (body.estado === undefined) return res.status(400).json("Indicá el estado del partido");
    const estado = leerEnum(body, "estado", {}, ESTADOS_PARTIDO, { etiqueta: "el estado" });
    let resultado1 = leerTexto(body, "resultado1", actual, { maximo: 20, etiqueta: "el resultado 1" });
    let resultado2 = leerTexto(body, "resultado2", actual, { maximo: 20, etiqueta: "el resultado 2" });
    // Por sets: el resultado global (2 a 0) sale de contar los sets ganados por cada lado.
    const setsLeidos = normalizarSets(body.sets);
    let sets = setsLeidos === undefined ? actual.sets ?? null : setsLeidos ? JSON.stringify(setsLeidos) : null;
    if (setsLeidos) [resultado1, resultado2] = contarSets(setsLeidos).map(String);
    if (estado === "PROGRAMADO" && body.sets === undefined && body.resultado1 === null && body.resultado2 === null) sets = null;
    let ganador = leerGanador(body.ganador);
    if (ganador === undefined || ganador === null) {
      ganador = estado === "FINALIZADO" ? calcularGanadorPartido(resultado1, resultado2) : null;
    }
    if (estado !== 'FINALIZADO') ganador = null;
    const nuevo = { estado, resultado1, resultado2, ganador, sets };
    let efectos = null;
    await enTransaccion(async (connection) => {
      await bloquearSinCambios(connection, 'olimpiada_partido', actual);
      await connection.query(
        "UPDATE olimpiada_partido SET estado = ?, resultado1 = ?, resultado2 = ?, ganador = ?, sets = ? WHERE id = ?",
        [estado, resultado1, resultado2, ganador, sets, partidoId]
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
        ["resultado1", "resultado2", "ganador", "sets"]
      );
      efectos = await aplicarEfectosCompeticion(connection, cabecera, actual.olimpiada_id, actual.disciplina_id);
    });
    res.status(200).json({
      success: true, message: mensajeConEfectos(MENSAJE_RESULTADO[estado], efectos),
      clasificados: efectos?.clasificados || 0, avisos: efectos?.avisos || [],
      partido: await obtenerPartidoCompleto(db, partidoId),
    });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el resultado");
  }
});

router.delete("/olimpiadas/partidos/:partidoId(\\d+)", verificarAccesoCompeticion, async (req, res) => {
  const cabecera = getCabecera(req);
  try {
    const partidoId = idDeRuta(req.params.partidoId);
    const actual = await exigirFila(db, "olimpiada_partido", partidoId, "El partido no existe");
    await autorizarPartido(cabecera, actual.olimpiada_id, actual.disciplina_id);
    const [[referencias]] = await db.query('SELECT COUNT(*) AS cantidad FROM olimpiada_partido WHERE eliminado = 0 AND (partido_origen1_id = ? OR partido_origen2_id = ?)', [partidoId, partidoId]);
    if (Number(referencias.cantidad)) throw crearErrorHttp('Primero quitá este partido como origen de los partidos siguientes');
    await enTransaccion(async (connection) => {
      await bloquearSinCambios(connection, 'olimpiada_partido', actual);
      await connection.query("UPDATE olimpiada_partido SET eliminado = 1 WHERE id = ?", [partidoId]);
      await historial(connection, cabecera, {
        entidad: "PARTIDO",
        entidad_id: partidoId,
        olimpiada_id: actual.olimpiada_id,
        tipo_operacion: "DELETE",
        valor_anterior: describirPartido(actual),
      });
      await aplicarEfectosCompeticion(connection, cabecera, actual.olimpiada_id, actual.disciplina_id);
    });
    res.status(200).json({ success: true, message: "Partido eliminado" });
  } catch (error) {
    responderError(res, error, "No se pudo eliminar el partido");
  }
});

// ---------------------------------------------------------------------------
// En vivo
// ---------------------------------------------------------------------------
// «En juego» junta los partidos que alguien marcó en juego y los que están en su horario.
async function armarEnVivo(conexion, olimpiadaId, { condicionExtra = null, paramsExtra = [] } = {}) {
  const consultar = (opciones) => consultarPartidos(conexion, condicionExtra ? {
    ...opciones, condiciones: [...opciones.condiciones, condicionExtra], params: [...opciones.params, ...paramsExtra],
  } : opciones);
  const hoy = fechaHoyBuenosAires();
  const [candidatos, recientes, programados] = await Promise.all([
    consultar({ condiciones: ["p.olimpiada_id = ?", "(p.estado = 'EN_JUEGO' OR (p.estado = 'PROGRAMADO' AND p.fecha = ?))"], params: [olimpiadaId, hoy] }),
    consultar({
      condiciones: ["p.olimpiada_id = ?", "p.estado = 'FINALIZADO'"],
      params: [olimpiadaId],
      orden: "p.fecha_modificacion DESC, p.id DESC",
      limite: 20,
    }),
    consultar({
      condiciones: ["p.olimpiada_id = ?", "p.estado = 'PROGRAMADO'", "p.fecha >= ?"],
      params: [olimpiadaId, hoy],
      orden: "p.fecha, p.hora_inicio IS NULL, p.hora_inicio, p.orden, p.id",
      limite: 40,
    }),
  ]);
  return {
    actualizado: new Date().toISOString(),
    en_juego: candidatos.filter(p => p.en_vivo),
    recientes,
    proximos: programados.filter(p => !p.en_vivo).slice(0, 20),
  };
}

router.get("/olimpiadas/:id(\\d+)/en-vivo", verificarAccesoCompeticion, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const asignadas = await exigirEdicionVoluntario({ db, cabecera, olimpiadaId });
    const enVivo = await armarEnVivo(db, olimpiadaId, asignadas
      ? { condicionExtra: 'p.disciplina_id IN (?)', paramsExtra: [asignadas.length ? asignadas : [0]] } : {});
    res.set("Cache-Control", "no-store");
    res.status(200).json(enVivo);
  } catch (error) {
    responderError(res, error, "No se pudo cargar el estado en vivo");
  }
});

// ---------------------------------------------------------------------------
// Medallero
// ---------------------------------------------------------------------------
async function armarMedallero(conexion, olimpiada) {
  const puestos = await leerPuntosPuestos(conexion, olimpiada);
  const division = REGLAS_DIVISION.includes(olimpiada.medallero_division) ? olimpiada.medallero_division : "EXACTA";
  const puntosDe = puesto => puestos.find(p => p.puesto === puesto)?.puntos || 0;
  const [disciplinas] = await conexion.query(
    `SELECT d.id, d.nombre FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     LEFT JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y' AND COALESCE(t.competitiva, 1) = 1 ORDER BY d.nombre`,
    [olimpiada.id]
  );
  const [medallas] = await conexion.query(
    `SELECT m.id, m.disciplina_id, d.nombre AS disciplina_nombre, m.puesto, m.departamental_id, dep.nombre,
            m.equipo_id, e.nombre AS equipo_nombre, m.origen, m.puntos_manual
     FROM olimpiada_medalla m
     INNER JOIN olimpiada_disciplina d ON d.id = m.disciplina_id
     INNER JOIN departamental dep ON dep.id = m.departamental_id
     LEFT JOIN olimpiada_equipo e ON e.id = m.equipo_id
     WHERE m.olimpiada_id = ?
     ORDER BY d.nombre, m.puesto, dep.nombre`,
    [olimpiada.id]
  );
  return {
    publicado: Number(olimpiada.medallero_publicado) === 1,
    division,
    puestos,
    puntos: { oro: puntosDe(1), plata: puntosDe(2), bronce: puntosDe(3) },
    disciplinas: agruparMedallasPorDisciplina(disciplinas, medallas, { puntos: puestos, division }),
    tabla: calcularTablaMedallero(medallas, puestos, { division }),
  };
}

// Mientras no se publique, el medallero no sale de la administración provincial.
function medalleroReservado(olimpiada) {
  return {
    publicado: false, reservado: true, division: olimpiada?.medallero_division || "EXACTA",
    puestos: [], puntos: { oro: 0, plata: 0, bronce: 0 }, disciplinas: [], tabla: [],
  };
}

function puedeVerMedallero(cabecera, olimpiada) {
  return (cabecera && esSuperior(cabecera)) || Number(olimpiada.medallero_publicado) === 1;
}

router.get("/olimpiadas/:id(\\d+)/medallero", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    res.set("Cache-Control", "no-store");
    res.status(200).json(puedeVerMedallero(cabecera, olimpiada) ? await armarMedallero(db, olimpiada) : medalleroReservado(olimpiada));
  } catch (error) {
    responderError(res, error, "No se pudo cargar el medallero");
  }
});

function leerPuestosPuntos(body, olimpiada) {
  if (Array.isArray(body.puestos)) {
    if (body.puestos.length < 3 || body.puestos.length > MAX_PUESTOS) throw crearErrorHttp(`El sistema de puntos lleva entre 3 y ${MAX_PUESTOS} puestos`);
    return body.puestos.map((entrada, indice) => {
      const puntos = Number(String(entrada?.puntos ?? "").replace(",", "."));
      if (Number(entrada?.puesto) !== indice + 1) throw crearErrorHttp("Los puestos tienen que ir en orden, sin saltear ninguno");
      if (!Number.isFinite(puntos) || puntos < 0 || puntos > 1000) throw crearErrorHttp(`Los puntos del ${nombrePuesto(indice + 1).toLowerCase()} deben estar entre 0 y 1000`);
      return { puesto: indice + 1, puntos: Math.round(puntos * 100) / 100 };
    });
  }
  const base = { puntos_oro: olimpiada.puntos_oro, puntos_plata: olimpiada.puntos_plata, puntos_bronce: olimpiada.puntos_bronce };
  return [
    leerEntero(body, "puntos_oro", base, { maximo: 1000, etiqueta: "los puntos por oro" }),
    leerEntero(body, "puntos_plata", base, { maximo: 1000, etiqueta: "los puntos por plata" }),
    leerEntero(body, "puntos_bronce", base, { maximo: 1000, etiqueta: "los puntos por bronce" }),
  ].map((puntos, indice) => ({ puesto: indice + 1, puntos }));
}

// Literal antes que /medallero/:disciplinaId
router.put("/olimpiadas/:id(\\d+)/medallero/puntos", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const anteriores = await leerPuntosPuestos(db, olimpiada);
    // Con el formato viejo (oro, plata y bronce) se conservan los puestos siguientes ya configurados.
    const leidos = leerPuestosPuntos(body, olimpiada);
    const nuevos = Array.isArray(body.puestos) ? leidos : [...leidos, ...anteriores.filter(p => p.puesto > 3).map(p => ({ puesto: p.puesto, puntos: p.puntos }))];
    const describir = lista => lista.map(p => `${nombrePuesto(p.puesto)} ${p.puntos}`).join(" · ");
    const legado = { puntos_oro: Math.round(nuevos[0].puntos), puntos_plata: Math.round(nuevos[1].puntos), puntos_bronce: Math.round(nuevos[2].puntos) };
    await enTransaccion(async (connection) => {
      await connection.query("DELETE FROM olimpiada_puntos_puesto WHERE olimpiada_id = ?", [olimpiadaId]);
      for (const puesto of nuevos) {
        await connection.query("INSERT INTO olimpiada_puntos_puesto (olimpiada_id, puesto, puntos) VALUES (?, ?, ?)", [olimpiadaId, puesto.puesto, puesto.puntos]);
      }
      await connection.query(
        "UPDATE olimpiada SET puntos_oro = ?, puntos_plata = ?, puntos_bronce = ? WHERE id = ?",
        [legado.puntos_oro, legado.puntos_plata, legado.puntos_bronce, olimpiadaId]
      );
      if (describir(anteriores) !== describir(nuevos)) {
        await historial(connection, cabecera, {
          entidad: "MEDALLA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId, tipo_operacion: "UPDATE",
          campo_modificado: "sistema_puntos", valor_anterior: describir(anteriores), valor_nuevo: describir(nuevos),
        });
      }
    });
    res.status(200).json({ success: true, message: "Sistema de puntos actualizado", medallero: await armarMedallero(db, { ...olimpiada, ...legado }) });
  } catch (error) {
    responderError(res, error, "No se pudo actualizar el sistema de puntos");
  }
});

// Vuelve una disciplina al cálculo automático: descarta lo cargado a mano y toma los resultados.
router.post("/olimpiadas/:id(\\d+)/medallero/:disciplinaId(\\d+)/automatico", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const disciplinaId = idDeRuta(req.params.disciplinaId);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const disciplina = await validarDisciplinaDeOlimpiada(db, olimpiadaId, disciplinaId);
    await enTransaccion(async (connection) => {
      const [previas] = await connection.query(
        `SELECT m.puesto, dep.nombre FROM olimpiada_medalla m INNER JOIN departamental dep ON dep.id = m.departamental_id
         WHERE m.olimpiada_id = ? AND m.disciplina_id = ? AND m.origen = 'MANUAL' ORDER BY m.puesto, dep.nombre`,
        [olimpiadaId, disciplinaId]
      );
      await connection.query("DELETE FROM olimpiada_medalla WHERE olimpiada_id = ? AND disciplina_id = ?", [olimpiadaId, disciplinaId]);
      if (previas.length) {
        await historial(connection, cabecera, {
          entidad: "MEDALLA", entidad_id: disciplinaId, olimpiada_id: olimpiadaId, tipo_operacion: "UPDATE",
          campo_modificado: disciplina.nombre, valor_anterior: describirMedallas(previas), valor_nuevo: null,
          observacion: "Se descartó la carga manual para volver al cálculo automático",
        });
      }
      await sincronizarMedallasAutomaticas(connection, cabecera, olimpiadaId, disciplinaId);
    });
    res.status(200).json({ success: true, message: `${disciplina.nombre} vuelve a calcularse con los resultados`, medallero: await armarMedallero(db, olimpiada) });
  } catch (error) {
    responderError(res, error, "No se pudo volver al cálculo automático");
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
    const puntosPuestos = await leerPuntosPuestos(db, olimpiada);
    const maxPuesto = Math.max(3, ...puntosPuestos.map(p => p.puesto));
    // Cada ganador de un puesto es una departamental sola o un equipo interdepartamental.
    const ganadores = [];
    for (const entrada of puestos) {
      const puesto = Number(entrada?.puesto);
      if (!Number.isInteger(puesto) || puesto < 1 || puesto > maxPuesto) return res.status(400).json(`El puesto debe estar entre 1 y ${maxPuesto}`);
      const departamentalIds = normalizarIds(entrada?.departamental_ids ?? []);
      const equipoIds = normalizarIds(entrada?.equipo_ids ?? []);
      if (departamentalIds === null || equipoIds === null) return res.status(400).json("La lista de ganadores es inválida");
      for (const item of Array.isArray(entrada?.ganadores) ? entrada.ganadores : []) {
        const equipoId = normalizarIdPositivo(item?.equipo_id);
        const departamentalId = normalizarIdPositivo(item?.departamental_id);
        if (equipoId) equipoIds.push(equipoId);
        else if (departamentalId) departamentalIds.push(departamentalId);
        else return res.status(400).json("Cada ganador es una departamental o un equipo interdepartamental");
      }
      for (const id of new Set(departamentalIds)) ganadores.push({ puesto, departamental_id: id, equipo_id: null });
      for (const id of new Set(equipoIds)) ganadores.push({ puesto, departamental_id: null, equipo_id: id });
    }
    const equipos = await listarEquipos(db, olimpiadaId, [disciplinaId]);
    const equipoPor = new Map(equipos.map(e => [Number(e.id), e]));
    const filas = [];
    for (const ganador of ganadores) {
      if (ganador.equipo_id) {
        const equipo = equipoPor.get(ganador.equipo_id);
        if (!equipo) return res.status(400).json("Uno de los equipos interdepartamentales no pertenece a esta disciplina");
        for (const dep of equipo.departamentales) filas.push({ puesto: ganador.puesto, departamental_id: dep.id, equipo_id: equipo.id, nombre: dep.nombre });
      } else filas.push({ puesto: ganador.puesto, departamental_id: ganador.departamental_id, equipo_id: null, nombre: null });
    }
    const repetida = filas.find((fila, indice) => filas.findIndex(f => f.puesto === fila.puesto && f.departamental_id === fila.departamental_id) !== indice);
    if (repetida) return res.status(400).json(`Una departamental aparece dos veces en el ${nombrePuesto(repetida.puesto).toLowerCase()}`);
    const departamentales = await validarDepartamentales(db, [...new Set(filas.map(f => f.departamental_id))]);
    const nombrePor = new Map(departamentales.map((d) => [Number(d.id), d.nombre]));
    for (const fila of filas) fila.nombre = nombrePor.get(Number(fila.departamental_id));
    await enTransaccion(async (connection) => {
      const [previas] = await connection.query(
        `SELECT m.puesto, m.departamental_id, m.equipo_id, m.puntos_manual, dep.nombre FROM olimpiada_medalla m INNER JOIN departamental dep ON dep.id = m.departamental_id
         WHERE m.olimpiada_id = ? AND m.disciplina_id = ? ORDER BY m.puesto, dep.nombre`,
        [olimpiadaId, disciplinaId]
      );
      await connection.query("DELETE FROM olimpiada_medalla WHERE olimpiada_id = ? AND disciplina_id = ?", [olimpiadaId, disciplinaId]);
      for (const fila of filas) {
        // Un ajuste manual de puntos se conserva mientras la departamental siga en el mismo puesto y equipo.
        const anterior = previas.find(p => Number(p.puesto) === fila.puesto && Number(p.departamental_id) === Number(fila.departamental_id) && (Number(p.equipo_id) || 0) === (fila.equipo_id || 0));
        await connection.query(
          "INSERT INTO olimpiada_medalla (olimpiada_id, disciplina_id, puesto, departamental_id, equipo_id, origen, puntos_manual) VALUES (?, ?, ?, ?, ?, 'MANUAL', ?)",
          [olimpiadaId, disciplinaId, fila.puesto, fila.departamental_id, fila.equipo_id, anterior?.puntos_manual ?? null]
        );
      }
      await historial(connection, cabecera, {
        entidad: "MEDALLA",
        entidad_id: disciplinaId,
        olimpiada_id: olimpiadaId,
        tipo_operacion: "UPDATE",
        campo_modificado: disciplina.nombre,
        valor_anterior: describirMedallas(previas) || null,
        valor_nuevo: describirMedallas(filas) || null,
        observacion: "Cargado a mano por la administración",
      });
    });
    res.status(200).json({ success: true, message: `Medallas de ${disciplina.nombre} guardadas`, medallero: await armarMedallero(db, olimpiada) });
  } catch (error) {
    responderError(res, error, "No se pudieron guardar las medallas");
  }
});

// Ajuste manual de los puntos que una medalla le suma a una departamental (null = volver al cálculo).
router.put("/olimpiadas/medallas/:medallaId(\\d+)/puntos", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const medallaId = idDeRuta(req.params.medallaId);
    const [[medalla]] = await db.query(
      `SELECT m.*, dep.nombre AS departamental_nombre, d.nombre AS disciplina_nombre FROM olimpiada_medalla m
       INNER JOIN departamental dep ON dep.id = m.departamental_id INNER JOIN olimpiada_disciplina d ON d.id = m.disciplina_id WHERE m.id = ?`,
      [medallaId]
    );
    if (!medalla) return res.status(404).json("La medalla ya no existe. Recargá el medallero.");
    const olimpiada = await cargarOlimpiada(db, medalla.olimpiada_id, cabecera);
    const valor = req.body?.puntos_manual;
    let puntos = null;
    if (valor !== null && valor !== undefined && valor !== "") {
      puntos = Number(String(valor).replace(",", "."));
      if (!Number.isFinite(puntos) || puntos < 0 || puntos > 1000) return res.status(400).json("Los puntos deben estar entre 0 y 1000");
      puntos = Math.round(puntos * 100) / 100;
    }
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_medalla SET puntos_manual = ? WHERE id = ?", [puntos, medallaId]);
      await historial(connection, cabecera, {
        entidad: "MEDALLA", entidad_id: medalla.disciplina_id, olimpiada_id: medalla.olimpiada_id, tipo_operacion: "UPDATE",
        campo_modificado: "puntos_manual",
        valor_anterior: medalla.puntos_manual === null ? "Cálculo automático" : Number(medalla.puntos_manual),
        valor_nuevo: puntos === null ? "Cálculo automático" : puntos,
        observacion: `${medalla.disciplina_nombre} · ${nombrePuesto(Number(medalla.puesto))} · ${medalla.departamental_nombre}`,
      });
    });
    res.status(200).json({ success: true, message: puntos === null ? "Los puntos vuelven a calcularse solos" : "Puntos ajustados a mano", medallero: await armarMedallero(db, olimpiada) });
  } catch (error) {
    responderError(res, error, "No se pudieron ajustar los puntos");
  }
});

// Qué se publica y cómo se reparten los puntos: lo decide la administración provincial.
router.put("/olimpiadas/:id(\\d+)/competicion/ajustes", verifyToken, async (req, res) => {
  const cabecera = exigirSuperior(req, res);
  if (!cabecera) return;
  try {
    const olimpiadaId = idDeRuta(req.params.id);
    const olimpiada = await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const actual = ajustesCompeticion(olimpiada);
    const nuevo = {
      veedores_carga_abierta: leerFlag(body, "veedores_carga_abierta", actual, 0),
      medallero_publicado: leerFlag(body, "medallero_publicado", actual, 0),
      posiciones_publicas: leerFlag(body, "posiciones_publicas", actual, 0),
      medallero_division: leerEnum(body, "medallero_division", actual, REGLAS_DIVISION, { porDefecto: "EXACTA", etiqueta: "la regla de reparto de puntos" }),
    };
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada SET ? WHERE id = ?", [nuevo, olimpiadaId]);
      await historialCambios(connection, cabecera, { entidad: "AJUSTE", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId }, actual, nuevo, Object.keys(nuevo));
    });
    res.status(200).json({ success: true, message: "Ajustes guardados", ajustes: nuevo });
  } catch (error) {
    responderError(res, error, "No se pudieron guardar los ajustes");
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
const ayudantes = {
  db, cargarOlimpiada, enTransaccion, historial, historialCambios, leerTexto, leerIdOpcional, leerEnum, leerEntero, leerUrl, leerFecha, leerCoordenadas,
  validarDisciplinaDeOlimpiada, validarDepartamentales, consultarPartidos, bloquearSinCambios, exigirSuperior, soloSuperior, idDeRuta,
  archivoDeSlot, aplicarEfectosCompeticion, puedeVerPosiciones, listarEscudos,
};
require('./olimpiadas-torneos')(router, ayudantes);
require('./olimpiadas-equipos')(router, ayudantes);
const videos = require('./olimpiadas-videos')(router, ayudantes);

router.lecturasPublicas = Object.freeze({
  estadoEdicion, consultarPartidos, listarDisciplinasFixture, listarSedes, armarMedallero, serializarNovedad, serializarEvento, serializarFoto, SELECT_EVENTO, SELECT_FOTO,
  armarEnVivo, listarEscudos, puedeVerMedallero, medalleroReservado, listarVideos: videos.listarVideos,
});

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
  leerOrigen,
  leerCoordenadas,
  validarReferenciasPartido,
  guardarExtrasPartido,
  bloquearSinCambios,
  decorarPartidos,
  aplicarClasificacion,
  sincronizarMedallasAutomaticas,
  leerPuestosPuntos,
  mensajeConEfectos,
  leerCamposFoto,
  procesarLoteFotos,
});

module.exports = router;
