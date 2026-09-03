/**
 * MÓDULO OLIMPIADAS (encuentro recreativo para afiliados) — edición, catálogo e inscripciones.
 *
 * Entidades que gestiona este router:
 *  - olimpiada: edición del evento con ventana de inscripción propia + reglas de bonos/aprobación
 *  - olimpiada_disciplina / olimpiada_disciplina_tipo: catálogo administrable (los tipos son también
 *    la categoría del inscripto: Atleta, Coordinación, Cultura, Organización, Prensa, Acompañante)
 *  - olimpiada_disciplina_config: disciplinas habilitadas por olimpiada + cupo por departamental
 *  - olimpiada_inscripcion: formulario del afiliado (sanitario + firma + certificado + foto),
 *    categoría, acompañantes, planilla de descuento y flujo PENDIENTE → VALIDADO | CANCELADO
 *  - olimpiada_inscripcion_acompaniante: acompañantes con bonos por tramo de edad
 *  - olimpiada_inscripcion_observacion: chat afiliado <-> revisor
 *  - olimpiada_historial: auditoría de todas las acciones del módulo
 *  - olimpiada_mensaje_general: comunicados a todos los inscriptos (via tabla notificacion)
 *  - olimpiada_config: firma del Secretario de Acción Social para la constancia (solo admin)
 *
 * Bonos contribución, bloques y sorteo viven en olimpiadas-bonos.js; el contenido del portal
 * (novedades, cronograma, sedes, fixture, medallero, fotos) en olimpiadas-contenido.js.
 * Los helpers compartidos (auth, normalización, S3, historial, notificaciones, reglas de bonos)
 * están en services/olimpiadas-comun.js.
 */
const express = require("express");
const router = express.Router();
const mysqlConnection = require("../connection/connection");
const { registrarErrorRuta } = require("../services/errores");
const { normalizarFechaCivil } = require("../services/valores-dominio");
const {
  // archivos / S3
  firmarSeguro,
  getObjectBufferFromS3,
  subirArchivoOlimpiadas,
  subirFirmaBase64,
  manejarUploadOlimpiadas,
  decodificarFirmaBase64,
  detectarMimeArchivo,
  validarContenidoArchivo,
  // auth
  verifyToken,
  getCabecera,
  ROLES_GESTION,
  esStaff,
  esSuperior,
  esAdmin,
  departamentalDe,
  puedeVerInscripcion,
  // normalización
  crearErrorHttp,
  responderError,
  normalizarTexto,
  normalizarIdPositivo,
  normalizarEnteroNoNegativo,
  normalizarMonto,
  normalizarBooleano01,
  idsPositivosIguales,
  normalizarCupo,
  parseJsonSeguro,
  normalizarIds,
  fechaHoyBuenosAires,
  estaVentanaInscripcionAbierta,
  // estados
  ESTADOS_INSCRIPCION,
  ESTADOS_ACTIVOS,
  SQL_ESTADOS_ACTIVOS,
  // historial / notificaciones
  registrarHistorial,
  insertarNotificacion,
  notificarStaffOlimpiadas,
  // olimpiada / bonos
  obtenerOlimpiada,
  sembrarContenidoInicialOlimpiada,
  calcularBonosAcompaniante,
  resumenBonosInscripcion,
} = require("../services/olimpiadas-comun");

const MAX_ACOMPANIANTES = 15;
const MAX_BONOS_MANUAL = 999;
const MAX_CUOTAS_PLANILLA = 120;
const ESTADOS_EDICION = ["INSCRIPCION_ABIERTA", "PROXIMA", "INSCRIPCION_CERRADA", "EN_CURSO", "FINALIZADA"];

function valorInformado(valor) {
  return valor !== undefined && valor !== null && valor !== "";
}

// ---------------------------------------------------------------------------
// Reglas puras (testeables sin BD)
// ---------------------------------------------------------------------------

/**
 * Estado con el que nace una inscripción.
 *  - Afiliado: PENDIENTE si la edición exige aprobación o exige bonos para validar; si no, VALIDADO.
 *  - Staff: PENDIENTE sólo si la edición exige bonos para validar (los asigna después); si no, VALIDADO.
 */
function estadoInicialInscripcion({ rol, olimpiada }) {
  const exigeBonos = Number(olimpiada?.exigir_bonos_para_validar) === 1;
  const requiereAprobacion = Number(olimpiada?.requiere_aprobacion) === 1;
  if (rol === "afiliado") return requiereAprobacion || exigeBonos ? "PENDIENTE" : "VALIDADO";
  return exigeBonos ? "PENDIENTE" : "VALIDADO";
}

/**
 * Transiciones de estado: PENDIENTE → VALIDADO | CANCELADO; VALIDADO ↔ CANCELADO; el staff puede
 * volver cualquiera a PENDIENTE. El afiliado sólo puede cancelar (la propia, se valida aparte).
 */
function transicionPermitida({ rol, desde, hacia }) {
  if (!ESTADOS_INSCRIPCION.includes(desde) || !ESTADOS_INSCRIPCION.includes(hacia) || desde === hacia) return false;
  if (rol === "afiliado") return hacia === "CANCELADO";
  return ROLES_GESTION.includes(rol);
}

// Estado de una edición según el calendario (fechas civiles inclusivas, hoy en Buenos Aires).
function calcularEstadoEdicion(olimpiada, hoy = fechaHoyBuenosAires()) {
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

/**
 * Acompañantes desde el body (JSON string o array). `bonos_manual` sólo se respeta si el actor es staff.
 * Devuelve { value: undefined } si el campo no vino, { value: [] } si vino vacío, { error } si es inválido.
 */
function normalizarAcompaniantes(valor, { permitirManual = false } = {}) {
  if (valor === undefined) return { value: undefined };
  if (valor === null || valor === "") return { value: [] };
  const lista = parseJsonSeguro(valor, null);
  if (!Array.isArray(lista)) return { error: "La lista de acompañantes es inválida" };
  if (lista.length > MAX_ACOMPANIANTES) return { error: `Se pueden cargar hasta ${MAX_ACOMPANIANTES} acompañantes por inscripción` };
  const normalizados = [];
  for (const [indice, acompaniante] of lista.entries()) {
    const numero = indice + 1;
    if (!acompaniante || typeof acompaniante !== "object" || Array.isArray(acompaniante)) {
      return { error: `El acompañante #${numero} es inválido` };
    }
    const nombre = normalizarTexto(acompaniante.nombre, 80);
    const apellido = normalizarTexto(acompaniante.apellido, 80);
    if (!nombre || !apellido) return { error: `El acompañante #${numero} necesita nombre y apellido` };

    let documento = null;
    if (valorInformado(acompaniante.documento)) {
      documento = String(acompaniante.documento).trim();
      if (!/^[0-9A-Za-z.\-]{1,20}$/.test(documento)) return { error: `El documento del acompañante #${numero} es inválido` };
    }
    let fechaNacimiento = null;
    if (valorInformado(acompaniante.fecha_nacimiento)) {
      fechaNacimiento = normalizarFechaCivil(acompaniante.fecha_nacimiento);
      if (!fechaNacimiento) return { error: `La fecha de nacimiento del acompañante #${numero} es inválida (YYYY-MM-DD)` };
    }
    let esAfiliado = 0;
    if (valorInformado(acompaniante.es_afiliado)) {
      esAfiliado = normalizarBooleano01(acompaniante.es_afiliado);
      if (esAfiliado === null) return { error: `"es_afiliado" del acompañante #${numero} debe ser 1 o 0` };
    }
    let bonosManual = 0;
    let bonos = null;
    if (permitirManual && normalizarBooleano01(acompaniante.bonos_manual) === 1) {
      bonos = normalizarEnteroNoNegativo(acompaniante.bonos);
      if (bonos === null || bonos > MAX_BONOS_MANUAL) {
        return { error: `Los bonos manuales del acompañante #${numero} deben ser un entero entre 0 y ${MAX_BONOS_MANUAL}` };
      }
      bonosManual = 1;
    }
    normalizados.push({
      nombre,
      apellido,
      documento,
      fecha_nacimiento: fechaNacimiento,
      vinculo: normalizarTexto(acompaniante.vinculo, 40),
      es_afiliado: esAfiliado,
      bonos,
      bonos_manual: bonosManual,
      observacion: normalizarTexto(acompaniante.observacion, 200),
    });
  }
  return { value: normalizados };
}

// Permisos de una inscripción para quien ya pasó puedeVerInscripcion.
function permisosInscripcion({ cabecera, inscripcion, olimpiada, hoy = fechaHoyBuenosAires() }) {
  const staff = esStaff(cabecera);
  const propia = cabecera.rol === "afiliado" && idsPositivosIguales(inscripcion.usuario_id, cabecera.id);
  const estado = inscripcion.estado;
  const ventanaAbierta = estaVentanaInscripcionAbierta(olimpiada, hoy);
  return {
    puede_editar: staff || (propia && ventanaAbierta && estado !== "CANCELADO"),
    puede_validar: staff && estado !== "VALIDADO",
    puede_cancelar: (staff || propia) && estado !== "CANCELADO",
    puede_pendiente: staff && estado !== "PENDIENTE",
    puede_eliminar: esAdmin(cabecera),
    puede_gestionar_bonos: staff,
  };
}

function documentacionCompleta(inscripcion) {
  return Boolean(inscripcion.foto_archivo && inscripcion.certificado_archivo && inscripcion.firma_archivo);
}

function textoResumenAcompaniantes({ cantidad, bonos }) {
  const n = Number(cantidad) || 0;
  return `${n} acompañante${n === 1 ? "" : "s"} (${Number(bonos) || 0} bonos)`;
}

// ---------------------------------------------------------------------------
// Helpers con BD
// ---------------------------------------------------------------------------

// Olimpiada con inscripción abierta hoy (la más próxima a terminar)
const SQL_OLIMPIADA_VIGENTE = `
  SELECT o.*
  FROM olimpiada o
  WHERE o.eliminado = 0 AND o.habilitado = 'Y'
    AND CURDATE() BETWEEN o.fecha_inicio_inscripcion AND o.fecha_fin_inscripcion
  ORDER BY o.fecha_fin_inscripcion ASC, o.id DESC
  LIMIT 1`;

// Agrega la URL firmada del ícono a una lista de disciplinas
async function firmarIconosDisciplinas(disciplinas) {
  return Promise.all(disciplinas.map(async (d) => ({ ...d, icono_url: await firmarSeguro(d.icono_archivo) })));
}

// Disciplinas de una olimpiada con cupo y ocupación por departamental (ocupan cupo PENDIENTE y VALIDADO)
async function obtenerDisciplinasOlimpiada(db, olimpiadaId, departamentalId) {
  const [disciplinas] = await db.query(
    `SELECT c.disciplina_id AS id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.icono_archivo,
            c.max_por_departamental, c.sede_id, c.veedor,
            (SELECT COUNT(*)
             FROM olimpiada_inscripcion_disciplina idp
             INNER JOIN olimpiada_inscripcion i ON i.id = idp.inscripcion_id
             WHERE idp.disciplina_id = c.disciplina_id AND i.olimpiada_id = c.olimpiada_id
               AND i.eliminado = 0 AND i.estado IN ${SQL_ESTADOS_ACTIVOS}
               AND (? IS NULL OR i.departamental_id = ?)) AS inscriptos_departamental
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y'
     ORDER BY t.nombre ASC, d.nombre ASC`,
    [departamentalId ?? null, departamentalId ?? null, olimpiadaId]
  );
  return firmarIconosDisciplinas(disciplinas.map((d) => ({
    ...d,
    cupo_disponible: d.max_por_departamental === null ? null : Math.max(0, d.max_por_departamental - d.inscriptos_departamental),
  })));
}

async function obtenerTramos(db, olimpiadaId) {
  const [tramos] = await db.query(
    "SELECT id, edad_desde, edad_hasta, bonos, etiqueta FROM olimpiada_bono_tramo WHERE olimpiada_id = ? ORDER BY edad_desde",
    [olimpiadaId]
  );
  return tramos;
}

async function obtenerCategorias(db) {
  const [tipos] = await db.query("SELECT id, nombre FROM olimpiada_disciplina_tipo WHERE habilitado = 'Y' ORDER BY nombre");
  return tipos;
}

async function obtenerCategoria(db, categoriaTipoId) {
  const [rows] = await db.query(
    "SELECT id, nombre FROM olimpiada_disciplina_tipo WHERE id = ? AND habilitado = 'Y'",
    [categoriaTipoId]
  );
  return rows[0] || null;
}

// Las disciplinas ofrecidas se filtran por tipo = categoría: el backend exige la misma coherencia.
async function validarDisciplinasCategoria(db, disciplinaIds, categoria) {
  if (!categoria || !Array.isArray(disciplinaIds) || disciplinaIds.length === 0) return;
  const [disciplinas] = await db.query("SELECT id, nombre, tipo_id FROM olimpiada_disciplina WHERE id IN (?)", [disciplinaIds]);
  const ajena = disciplinas.find((d) => !idsPositivosIguales(d.tipo_id, categoria.id));
  if (ajena) {
    throw crearErrorHttp(`La disciplina "${ajena.nombre}" no corresponde a la categoría ${categoria.nombre}: elegí disciplinas de esa categoría`, 400);
  }
}

// Reemplaza el set de acompañantes de una inscripción calculando los bonos de cada uno.
async function guardarAcompaniantes(connection, inscripcionId, acompaniantes, { tramos, bonosAfiliado, fechaReferencia }) {
  await connection.query("DELETE FROM olimpiada_inscripcion_acompaniante WHERE inscripcion_id = ?", [inscripcionId]);
  let totalBonos = 0;
  for (const a of acompaniantes) {
    const bonos = calcularBonosAcompaniante(a, { tramos, bonosAfiliado, fechaReferencia });
    totalBonos += bonos;
    await connection.query(
      `INSERT INTO olimpiada_inscripcion_acompaniante
         (inscripcion_id, nombre, apellido, documento, fecha_nacimiento, vinculo, es_afiliado, bonos, bonos_manual, observacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [inscripcionId, a.nombre, a.apellido, a.documento, a.fecha_nacimiento, a.vinculo, a.es_afiliado, bonos, a.bonos_manual, a.observacion]
    );
  }
  return { cantidad: acompaniantes.length, bonos: totalBonos };
}

async function resumenAcompaniantesActual(db, inscripcionId) {
  const [[fila]] = await db.query(
    "SELECT COUNT(*) AS cantidad, COALESCE(SUM(bonos), 0) AS bonos FROM olimpiada_inscripcion_acompaniante WHERE inscripcion_id = ?",
    [inscripcionId]
  );
  return { cantidad: Number(fila.cantidad) || 0, bonos: Number(fila.bonos) || 0 };
}

async function bloquearOlimpiada(connection, olimpiadaId, { requiereHabilitada = false } = {}) {
  const [rows] = await connection.query(
    `SELECT * FROM olimpiada
     WHERE id = ? AND eliminado = 0${requiereHabilitada ? " AND habilitado = 'Y'" : ""}
     FOR UPDATE`,
    [olimpiadaId]
  );
  return rows[0] || null;
}

async function validarDisciplinasCatalogo(connection, disciplinas) {
  const ids = disciplinas.map((disciplina) => disciplina.disciplina_id);
  const [rows] = await connection.query(
    "SELECT id FROM olimpiada_disciplina WHERE id IN (?) AND habilitado = 'Y' FOR UPDATE",
    [ids]
  );
  const existentes = new Set(rows.map((row) => Number(row.id)));
  if (ids.some((id) => !existentes.has(id))) {
    throw crearErrorHttp("Una de las disciplinas no existe o está deshabilitada", 400);
  }
}

// No se puede quitar una disciplina con inscripciones ni bajar el cupo por debajo de las activas.
async function validarConfiguracionContraInscripciones(connection, olimpiadaId, disciplinas) {
  const configuracion = new Map(disciplinas.map((disciplina) => [disciplina.disciplina_id, disciplina]));
  const [usos] = await connection.query(
    `SELECT idp.disciplina_id, i.departamental_id,
            COUNT(*) AS inscripciones,
            SUM(CASE WHEN i.estado IN ${SQL_ESTADOS_ACTIVOS} THEN 1 ELSE 0 END) AS activas
     FROM olimpiada_inscripcion_disciplina idp
     INNER JOIN olimpiada_inscripcion i ON i.id = idp.inscripcion_id
     WHERE i.olimpiada_id = ? AND i.eliminado = 0
     GROUP BY idp.disciplina_id, i.departamental_id`,
    [olimpiadaId]
  );

  for (const uso of usos) {
    const disciplinaId = Number(uso.disciplina_id);
    const nuevaConfiguracion = configuracion.get(disciplinaId);
    if (!nuevaConfiguracion) {
      throw crearErrorHttp(`No se puede quitar la disciplina #${disciplinaId}: tiene inscripciones asociadas`, 409);
    }
    const cupo = nuevaConfiguracion.max_por_departamental;
    if (cupo !== null && Number(uso.activas) > cupo) {
      const sede = uso.departamental_id === null ? "sin departamental" : `departamental #${uso.departamental_id}`;
      throw crearErrorHttp(
        `El cupo de la disciplina #${disciplinaId} no puede bajar de ${uso.activas} para ${sede}`,
        409
      );
    }
  }
}

async function validarCapacidadDisciplinas(connection, {
  olimpiadaId,
  departamentalId,
  disciplinaIds,
  excluirInscripcionId = null,
  controlarCapacidad = true,
}) {
  const [configs] = await connection.query(
    `SELECT c.disciplina_id, c.max_por_departamental, d.nombre
     FROM olimpiada_disciplina_config c
     INNER JOIN olimpiada_disciplina d ON d.id = c.disciplina_id
     WHERE c.olimpiada_id = ? AND d.habilitado = 'Y'
     FOR UPDATE`,
    [olimpiadaId]
  );
  const porDisciplina = new Map(configs.map((config) => [Number(config.disciplina_id), config]));

  for (const disciplinaId of disciplinaIds) {
    const config = porDisciplina.get(disciplinaId);
    if (!config) throw crearErrorHttp("Una de las disciplinas elegidas no pertenece a esta olimpiada", 400);
    if (!controlarCapacidad || config.max_por_departamental === null) continue;

    const params = [disciplinaId, olimpiadaId, departamentalId];
    const excluir = excluirInscripcionId ? " AND i.id <> ?" : "";
    if (excluirInscripcionId) params.push(excluirInscripcionId);
    const [[ocupacion]] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM olimpiada_inscripcion_disciplina idp
       INNER JOIN olimpiada_inscripcion i ON i.id = idp.inscripcion_id
       WHERE idp.disciplina_id = ? AND i.olimpiada_id = ? AND i.eliminado = 0
         AND i.estado IN ${SQL_ESTADOS_ACTIVOS} AND i.departamental_id <=> ?${excluir}`,
      params
    );
    if (Number(ocupacion.total) >= Number(config.max_por_departamental)) {
      throw crearErrorHttp(`No quedan cupos de "${config.nombre}" para la departamental`, 409);
    }
  }
}

async function validarReferenciasSanitarias(connection, grupoSanguineoId, datosSanitarioIds) {
  const [grupos] = await connection.query(
    "SELECT id FROM olimpiada_grupo_sanguineo WHERE id = ? FOR UPDATE",
    [grupoSanguineoId]
  );
  if (grupos.length === 0) throw crearErrorHttp("El grupo sanguíneo seleccionado no existe", 400);
  if (datosSanitarioIds.length === 0) return;
  const [datos] = await connection.query(
    "SELECT id FROM olimpiada_dato_sanitario WHERE id IN (?) FOR UPDATE",
    [datosSanitarioIds]
  );
  const existentes = new Set(datos.map((dato) => Number(dato.id)));
  if (datosSanitarioIds.some((id) => !existentes.has(id))) {
    throw crearErrorHttp("Uno de los datos sanitarios seleccionados no existe", 400);
  }
}

/**
 * Afiliado destinatario de una inscripción: titular real, habilitado, con módulo de olimpiadas.
 * Una departamental sólo puede inscribir afiliados de su propia departamental.
 */
async function resolverAfiliadoDestino(db, usuarioId, cabecera, { forUpdate = false } = {}) {
  const [usuarios] = await db.query(
    `SELECT u.*, r.nombre AS rol_nombre
     FROM usuario u INNER JOIN rol r ON r.id = u.rol_id
     WHERE u.id = ?${forUpdate ? " FOR UPDATE" : ""}`,
    [usuarioId]
  );
  if (usuarios.length === 0) throw crearErrorHttp("Afiliado no encontrado", 404);
  const afiliado = usuarios[0];
  if (afiliado.rol_nombre !== "afiliado" || afiliado.habilitado !== "Y" || afiliado.usuario_familiar_id !== null || afiliado.es_familiar === "S") {
    throw crearErrorHttp("El destinatario debe ser un afiliado titular habilitado", 422);
  }
  if (Number(afiliado.modulo_olimpiadas) !== 1) {
    throw crearErrorHttp("El afiliado no tiene habilitado el módulo de Olimpiadas", 422);
  }
  if (cabecera.rol === "departamental" && !idsPositivosIguales(afiliado.departamental_id, cabecera.departamental_id)) {
    throw crearErrorHttp("Sólo podés inscribir afiliados de tu departamental", 403);
  }
  return afiliado;
}

// ===========================================================================
// CATÁLOGOS (grupos sanguíneos, datos sanitarios, tipos, disciplinas, departamentales)
// ===========================================================================
router.get("/olimpiadas/catalogos", verifyToken, async (req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [gruposSanguineos] = await db.query("SELECT id, nombre FROM olimpiada_grupo_sanguineo ORDER BY orden, id");
    const [datosSanitarios] = await db.query("SELECT id, nombre FROM olimpiada_dato_sanitario ORDER BY orden, id");
    const tipos = await obtenerCategorias(db);
    const [disciplinas] = await db.query(
      `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.max_por_departamental, d.icono_archivo
       FROM olimpiada_disciplina d INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
       WHERE d.habilitado = 'Y' ORDER BY t.nombre, d.nombre`
    );
    const [departamentales] = await db.query("SELECT id, nombre FROM departamental WHERE habilitado = 'Y' ORDER BY nombre");
    res.status(200).json({
      grupos_sanguineos: gruposSanguineos,
      datos_sanitarios: datosSanitarios,
      tipos,
      disciplinas: await firmarIconosDisciplinas(disciplinas),
      departamentales,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los catálogos de olimpiadas");
  }
});

// ===========================================================================
// TIPOS DE DISCIPLINA (ABM admin)
// ===========================================================================
router.get("/olimpiadas/tipos-disciplina", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [tipos] = await db.query(
      `SELECT t.id, t.nombre, t.fecha_creacion,
              (SELECT COUNT(*) FROM olimpiada_disciplina d WHERE d.tipo_id = t.id AND d.habilitado = 'Y') AS disciplinas
       FROM olimpiada_disciplina_tipo t
       WHERE t.habilitado = 'Y'
       ORDER BY t.nombre`
    );
    res.status(200).json(tipos);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los tipos de disciplina");
  }
});

router.post("/olimpiadas/tipos-disciplina", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const nombre = normalizarTexto(req.body.nombre, 80);
    if (!nombre) return res.status(400).json("El nombre es obligatorio");
    const db = mysqlConnection.promise();
    const [resultado] = await db.query("INSERT INTO olimpiada_disciplina_tipo (nombre) VALUES (?)", [nombre]);
    await registrarHistorial(db, {
      entidad: "TIPO_DISCIPLINA", entidad_id: resultado.insertId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE", valor_nuevo: nombre,
    });
    res.status(201).json({ success: true, id: resultado.insertId, message: "Tipo de disciplina creado" });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al crear el tipo de disciplina");
  }
});

router.put("/olimpiadas/tipos-disciplina/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const tipoId = normalizarIdPositivo(req.params.id);
    const nombre = normalizarTexto(req.body.nombre, 80);
    if (!tipoId || !nombre) return res.status(400).json("El nombre es obligatorio");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina_tipo WHERE id = ? AND habilitado = 'Y'", [tipoId]);
    if (rows.length === 0) return res.status(404).json("Tipo de disciplina no encontrado");
    await db.query("UPDATE olimpiada_disciplina_tipo SET nombre = ? WHERE id = ?", [nombre, tipoId]);
    await registrarHistorial(db, {
      entidad: "TIPO_DISCIPLINA", entidad_id: tipoId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE", campo_modificado: "nombre",
      valor_anterior: rows[0].nombre, valor_nuevo: nombre,
    });
    res.status(200).json({ success: true, message: "Tipo de disciplina actualizado" });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al actualizar el tipo de disciplina");
  }
});

router.delete("/olimpiadas/tipos-disciplina/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const tipoId = normalizarIdPositivo(req.params.id);
    if (!tipoId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina_tipo WHERE id = ? AND habilitado = 'Y'", [tipoId]);
    if (rows.length === 0) return res.status(404).json("Tipo de disciplina no encontrado");
    const [[uso]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM olimpiada_disciplina WHERE tipo_id = ? AND habilitado = 'Y') +
              (SELECT COUNT(*) FROM olimpiada_inscripcion WHERE categoria_tipo_id = ? AND eliminado = 0) AS total`,
      [tipoId, tipoId]
    );
    if (uso.total > 0) return res.status(409).json("No se puede eliminar: hay disciplinas o inscripciones que usan este tipo");
    await db.query("UPDATE olimpiada_disciplina_tipo SET habilitado = 'N' WHERE id = ?", [tipoId]);
    await registrarHistorial(db, {
      entidad: "TIPO_DISCIPLINA", entidad_id: tipoId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE", valor_anterior: rows[0].nombre,
    });
    res.status(200).json({ success: true, message: "Tipo de disciplina eliminado" });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al eliminar el tipo de disciplina");
  }
});

// ===========================================================================
// DISCIPLINAS (ABM admin)
// ===========================================================================
router.get("/olimpiadas/disciplinas", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [disciplinas] = await db.query(
      `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.max_por_departamental, d.icono_archivo, d.fecha_creacion
       FROM olimpiada_disciplina d INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
       WHERE d.habilitado = 'Y'
       ORDER BY d.nombre, d.id`
    );
    res.status(200).json(await firmarIconosDisciplinas(disciplinas));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las disciplinas");
  }
});

// Ícono de disciplina: JPEG/PNG/WebP/HEIC adjunto en el slot ICONO (opcional)
function obtenerArchivoIcono(req, res) {
  const archivo = (req.files || []).find((f) => f.fieldname === "ICONO");
  if (!archivo) return { archivo: null };
  if (!archivo.mimetype?.startsWith("image/")) {
    res.status(400).json("El ícono debe ser una imagen JPEG, PNG, WebP o HEIC");
    return { error: true };
  }
  return { archivo };
}

router.post("/olimpiadas/disciplinas", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const nombre = normalizarTexto(req.body.nombre, 120);
    const tipoId = normalizarIdPositivo(req.body.tipo_id);
    const cupo = normalizarCupo(req.body.max_por_departamental);
    if (!nombre || !tipoId) return res.status(400).json("Nombre y tipo son obligatorios");
    if (cupo.error) return res.status(400).json(cupo.error);
    const max = cupo.value;

    const icono = obtenerArchivoIcono(req, res);
    if (icono.error) return;
    let iconoArchivo = null;
    if (icono.archivo) iconoArchivo = await subirArchivoOlimpiadas(icono.archivo, "disciplinas/icono");

    const db = mysqlConnection.promise();
    const [resultado] = await db.query(
      "INSERT INTO olimpiada_disciplina (nombre, tipo_id, max_por_departamental, icono_archivo) VALUES (?, ?, ?, ?)",
      [nombre, tipoId, max, iconoArchivo]
    );
    await registrarHistorial(db, {
      entidad: "DISCIPLINA", entidad_id: resultado.insertId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      valor_nuevo: `${nombre} (tipo ${tipoId}, máx ${max === null ? "ilimitado" : max}${iconoArchivo ? ", con ícono" : ""})`,
    });
    res.status(201).json({ success: true, id: resultado.insertId, message: "Disciplina creada" });
  } catch (error) {
    responderError(res, error, "Error al crear la disciplina");
  }
});

router.put("/olimpiadas/disciplinas/:id(\\d+)", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const disciplinaId = normalizarIdPositivo(req.params.id);
    const nombre = normalizarTexto(req.body.nombre, 120);
    const tipoId = normalizarIdPositivo(req.body.tipo_id);
    const cupo = normalizarCupo(req.body.max_por_departamental);
    if (!disciplinaId || !nombre || !tipoId) return res.status(400).json("Nombre y tipo son obligatorios");
    if (cupo.error) return res.status(400).json(cupo.error);
    const max = cupo.value;
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina WHERE id = ? AND habilitado = 'Y'", [disciplinaId]);
    if (rows.length === 0) return res.status(404).json("Disciplina no encontrada");
    const anterior = rows[0];

    const icono = obtenerArchivoIcono(req, res);
    if (icono.error) return;
    let iconoArchivo = anterior.icono_archivo;
    if (icono.archivo) {
      iconoArchivo = await subirArchivoOlimpiadas(icono.archivo, "disciplinas/icono");
    } else if (String(req.body.quitar_icono) === "1") {
      iconoArchivo = null;
    }

    await db.query(
      "UPDATE olimpiada_disciplina SET nombre = ?, tipo_id = ?, max_por_departamental = ?, icono_archivo = ? WHERE id = ?",
      [nombre, tipoId, max, iconoArchivo, disciplinaId]
    );
    const cambios = [];
    if (anterior.nombre !== nombre) cambios.push({ campo: "nombre", anterior: anterior.nombre, nuevo: nombre });
    if (Number(anterior.tipo_id) !== tipoId) cambios.push({ campo: "tipo_id", anterior: anterior.tipo_id, nuevo: tipoId });
    if ((anterior.icono_archivo ?? null) !== (iconoArchivo ?? null)) {
      cambios.push({ campo: "icono_archivo", anterior: anterior.icono_archivo, nuevo: iconoArchivo });
    }
    if ((anterior.max_por_departamental ?? null) !== max) {
      cambios.push({
        campo: "max_por_departamental",
        anterior: anterior.max_por_departamental === null ? "ilimitado" : anterior.max_por_departamental,
        nuevo: max === null ? "ilimitado" : max,
      });
    }
    for (const cambio of cambios) {
      await registrarHistorial(db, {
        entidad: "DISCIPLINA", entidad_id: disciplinaId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE", campo_modificado: cambio.campo,
        valor_anterior: cambio.anterior, valor_nuevo: cambio.nuevo,
      });
    }
    res.status(200).json({ success: true, message: "Disciplina actualizada" });
  } catch (error) {
    responderError(res, error, "Error al actualizar la disciplina");
  }
});

router.delete("/olimpiadas/disciplinas/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const disciplinaId = normalizarIdPositivo(req.params.id);
    if (!disciplinaId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_disciplina WHERE id = ? AND habilitado = 'Y'", [disciplinaId]);
    if (rows.length === 0) return res.status(404).json("Disciplina no encontrada");
    const [[uso]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM olimpiada_inscripcion_disciplina WHERE disciplina_id = ?) +
              (SELECT COUNT(*) FROM olimpiada_disciplina_config c
               INNER JOIN olimpiada o ON o.id = c.olimpiada_id
               WHERE c.disciplina_id = ? AND o.eliminado = 0) AS total`,
      [disciplinaId, disciplinaId]
    );
    if (uso.total > 0) return res.status(409).json("No se puede eliminar: la disciplina está usada en olimpiadas o inscripciones");
    await db.query("UPDATE olimpiada_disciplina SET habilitado = 'N' WHERE id = ?", [disciplinaId]);
    await registrarHistorial(db, {
      entidad: "DISCIPLINA", entidad_id: disciplinaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE", valor_anterior: rows[0].nombre,
    });
    res.status(200).json({ success: true, message: "Disciplina eliminada" });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al eliminar la disciplina");
  }
});

// ===========================================================================
// CONFIG (firma del Secretario para la constancia; sube solo admin)
// ===========================================================================
router.get("/olimpiadas/config", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_config WHERE id = 1");
    const config = rows[0] || {};
    res.status(200).json({
      firma_secretario_nombre: config.firma_secretario_nombre || null,
      firma_secretario_cargo: config.firma_secretario_cargo || null,
      firma_secretario_url: await firmarSeguro(config.firma_secretario_archivo),
      tiene_firma: !!config.firma_secretario_archivo,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la configuración de olimpiadas");
  }
});

router.put("/olimpiadas/config", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    // La migración crea esta fila única. El upsert defensivo también materializa
    // la clave antes del FOR UPDATE si una instalación antigua no ejecutó el seed.
    await connection.query("INSERT INTO olimpiada_config (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id");
    const [rows] = await connection.query("SELECT * FROM olimpiada_config WHERE id = 1 FOR UPDATE");
    const anterior = rows[0] || {};

    const nombre = normalizarTexto(req.body.firma_secretario_nombre, 120) || anterior.firma_secretario_nombre;
    const cargo = normalizarTexto(req.body.firma_secretario_cargo, 120) || anterior.firma_secretario_cargo;
    let firmaArchivo = anterior.firma_secretario_archivo || null;

    const archivoFirma = (req.files || []).find((f) => f.fieldname === "FIRMA_SECRETARIO");
    if (archivoFirma) {
      if (!archivoFirma.mimetype?.startsWith("image/")) throw crearErrorHttp("La firma debe ser una imagen", 400);
      firmaArchivo = await subirArchivoOlimpiadas(archivoFirma, "config/firma_secretario");
    }

    await connection.query(
      `UPDATE olimpiada_config
       SET firma_secretario_archivo = ?, firma_secretario_nombre = ?, firma_secretario_cargo = ?
       WHERE id = 1`,
      [firmaArchivo, nombre, cargo]
    );
    await registrarHistorial(connection, {
      entidad: "CONFIG", entidad_id: 1,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE",
      campo_modificado: archivoFirma ? "firma_secretario" : "datos_secretario",
      valor_nuevo: `${nombre} - ${cargo}${archivoFirma ? " (nueva imagen de firma)" : ""}`,
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Configuración guardada" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al guardar la configuración de olimpiadas");
  } finally {
    if (connection) connection.release();
  }
});

// ===========================================================================
// OLIMPIADAS (ABM administración provincial + vista del afiliado)
// ===========================================================================

// Todas las ediciones visibles (portal del afiliado + ediciones anteriores), con mi inscripción
router.get("/olimpiadas/ediciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();
    const [olimpiadas] = await db.query(
      `SELECT o.id, o.nombre, o.edicion, o.localidad, o.descripcion,
              o.fecha_inicio, o.fecha_fin, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion,
              (SELECT COUNT(*) FROM olimpiada_foto f WHERE f.olimpiada_id = o.id AND f.eliminado = 0) AS fotos,
              (SELECT COUNT(*) FROM olimpiada_novedad n
               WHERE n.olimpiada_id = o.id AND n.eliminado = 0 AND n.publicada = 1 AND n.fecha_publicacion <= NOW()) AS novedades
       FROM olimpiada o
       WHERE o.eliminado = 0 AND o.habilitado = 'Y'
       ORDER BY o.fecha_inicio DESC, o.id DESC`
    );
    const [mias] = await db.query(
      `SELECT i.id, i.olimpiada_id, i.estado
       FROM olimpiada_inscripcion i
       WHERE i.usuario_id = ? AND i.eliminado = 0
       ORDER BY i.id ASC`,
      [cabecera.id]
    );
    const porOlimpiada = new Map();
    for (const inscripcion of mias) porOlimpiada.set(Number(inscripcion.olimpiada_id), { id: inscripcion.id, estado: inscripcion.estado });
    const hoy = fechaHoyBuenosAires();
    res.status(200).json(olimpiadas.map((o) => ({
      ...o,
      fotos: Number(o.fotos) || 0,
      novedades: Number(o.novedades) || 0,
      estado: calcularEstadoEdicion(o, hoy),
      mi_inscripcion: porOlimpiada.get(Number(o.id)) || null,
    })));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las ediciones");
  }
});

// Buscador de afiliados titulares para que el staff inscriba (departamental: sólo los suyos)
router.get("/olimpiadas/afiliados-buscar", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const q = normalizarTexto(req.query.q, 100);
    if (!q || q.length < 2) return res.status(400).json("Escribí al menos 2 caracteres para buscar");
    let olimpiadaId = null;
    if (valorInformado(req.query.olimpiada_id)) {
      olimpiadaId = normalizarIdPositivo(req.query.olimpiada_id);
      if (!olimpiadaId) return res.status(400).json("Olimpiada inválida");
    }

    const condiciones = [
      "r.nombre = 'afiliado'",
      "u.habilitado = 'Y'",
      "u.usuario_familiar_id IS NULL",
      "(u.es_familiar IS NULL OR u.es_familiar <> 'S')",
      "u.modulo_olimpiadas = 1",
    ];
    const params = [olimpiadaId || 0, olimpiadaId || 0];
    if (cabecera.rol === "departamental") {
      const departamentalId = departamentalDe(cabecera);
      if (!departamentalId) return res.status(403).json("Tu usuario no tiene una departamental asignada");
      condiciones.push("u.departamental_id = ?");
      params.push(departamentalId);
    }
    const contiene = `%${q}%`;
    condiciones.push(
      `(u.nombre LIKE ? OR u.apellido LIKE ? OR CONCAT(u.apellido, ' ', u.nombre) LIKE ? OR CONCAT(u.nombre, ' ', u.apellido) LIKE ?
        OR CAST(u.documento AS CHAR) LIKE ? OR u.legajo LIKE ?)`
    );
    params.push(contiene, contiene, contiene, contiene, `${q}%`, `${q}%`);

    const db = mysqlConnection.promise();
    const [afiliados] = await db.query(
      `SELECT u.id, u.nombre, u.apellido, u.documento, u.legajo, u.fecha_nacimiento, u.email,
              u.departamental_id, d.nombre AS departamental_nombre,
              (SELECT i.id FROM olimpiada_inscripcion i
               WHERE i.usuario_id = u.id AND i.olimpiada_id = ? AND i.eliminado = 0
               ORDER BY i.id DESC LIMIT 1) AS inscripcion_id,
              (SELECT i.estado FROM olimpiada_inscripcion i
               WHERE i.usuario_id = u.id AND i.olimpiada_id = ? AND i.eliminado = 0
               ORDER BY i.id DESC LIMIT 1) AS inscripcion_estado
       FROM usuario u
       INNER JOIN rol r ON r.id = u.rol_id
       LEFT JOIN departamental d ON d.id = u.departamental_id
       WHERE ${condiciones.join(" AND ")}
       ORDER BY u.apellido, u.nombre
       LIMIT 15`,
      params
    );
    res.status(200).json(afiliados);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al buscar afiliados");
  }
});

// Vista del afiliado: olimpiada con inscripción abierta (o la próxima) + su inscripción + reglas
router.get("/olimpiadas/actual", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();

    const [vigentes] = await db.query(SQL_OLIMPIADA_VIGENTE);
    let olimpiada = vigentes[0] || null;
    let proxima = null;

    if (!olimpiada) {
      const [proximas] = await db.query(
        `SELECT * FROM olimpiada
         WHERE eliminado = 0 AND habilitado = 'Y' AND fecha_inicio_inscripcion > CURDATE()
         ORDER BY fecha_inicio_inscripcion ASC LIMIT 1`
      );
      proxima = proximas[0] || null;
    }

    let disciplinas = [];
    let inscripcion = null;
    let reglasBonos = null;
    const referencia = olimpiada || proxima;
    if (referencia) {
      disciplinas = await obtenerDisciplinasOlimpiada(db, referencia.id, cabecera.departamental_id ?? null);
      const [inscripciones] = await db.query(
        `SELECT i.id, i.estado, i.fecha_creacion, i.categoria_tipo_id,
                (SELECT COUNT(*) FROM olimpiada_inscripcion_observacion o WHERE o.inscripcion_id = i.id) AS mensajes
         FROM olimpiada_inscripcion i
         WHERE i.olimpiada_id = ? AND i.usuario_id = ? AND i.eliminado = 0
         ORDER BY i.id DESC LIMIT 1`,
        [referencia.id, cabecera.id]
      );
      inscripcion = inscripciones[0] || null;
      reglasBonos = {
        valor_bono: Number(referencia.valor_bono) || 0,
        bonos_afiliado: Number(referencia.bonos_afiliado) || 0,
        requiere_aprobacion: Number(referencia.requiere_aprobacion) === 1 ? 1 : 0,
        exigir_bonos_para_validar: Number(referencia.exigir_bonos_para_validar) === 1 ? 1 : 0,
        tramos: await obtenerTramos(db, referencia.id),
      };
    }

    res.status(200).json({
      olimpiada,
      proxima,
      disciplinas,
      inscripcion,
      inscripcion_abierta: !!olimpiada,
      categorias: await obtenerCategorias(db),
      reglas_bonos: reglasBonos,
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la olimpiada vigente");
  }
});

// Listado staff con métricas (departamental: contadores de su departamental)
router.get("/olimpiadas", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const filtroDepartamental = cabecera.rol === "departamental" ? departamentalDe(cabecera) : null;
    const [olimpiadas] = await db.query(
      `SELECT o.id, o.nombre, o.edicion, o.localidad, o.descripcion,
              o.fecha_inicio, o.fecha_fin, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion,
              o.texto_licencia, o.habilitado, o.fecha_creacion,
              o.valor_bono, o.bonos_afiliado, o.requiere_aprobacion, o.exigir_bonos_para_validar,
              o.fecha_sorteo, o.sorteo_publicado,
              (SELECT COUNT(*) FROM olimpiada_inscripcion i
               WHERE i.olimpiada_id = o.id AND i.eliminado = 0
                 AND (? IS NULL OR i.departamental_id = ?)) AS inscriptos,
              (SELECT COUNT(*) FROM olimpiada_inscripcion i
               WHERE i.olimpiada_id = o.id AND i.eliminado = 0 AND i.estado = 'PENDIENTE'
                 AND (? IS NULL OR i.departamental_id = ?)) AS pendientes,
              (SELECT COUNT(*) FROM olimpiada_inscripcion i
               WHERE i.olimpiada_id = o.id AND i.eliminado = 0 AND i.estado = 'VALIDADO'
                 AND (? IS NULL OR i.departamental_id = ?)) AS validadas,
              (SELECT COUNT(*) FROM olimpiada_bono b
               WHERE b.olimpiada_id = o.id
                 AND (? IS NULL OR b.departamental_id = ?)) AS bonos_vendidos,
              (SELECT COUNT(*) FROM olimpiada_disciplina_config c WHERE c.olimpiada_id = o.id) AS disciplinas
       FROM olimpiada o
       WHERE o.eliminado = 0
       ORDER BY o.fecha_inicio DESC, o.id DESC`,
      [
        filtroDepartamental, filtroDepartamental,
        filtroDepartamental, filtroDepartamental,
        filtroDepartamental, filtroDepartamental,
        filtroDepartamental, filtroDepartamental,
      ]
    );
    const hoy = fechaHoyBuenosAires();
    res.status(200).json(olimpiadas.map((o) => ({ ...o, estado_edicion: calcularEstadoEdicion(o, hoy) })));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las olimpiadas");
  }
});

router.get("/olimpiadas/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    const olimpiada = await obtenerOlimpiada(db, olimpiadaId);
    if (!olimpiada) return res.status(404).json("Olimpiada no encontrada");
    const disciplinas = await obtenerDisciplinasOlimpiada(
      db, olimpiadaId, cabecera.rol === "departamental" ? cabecera.departamental_id : null
    );
    res.status(200).json({
      ...olimpiada,
      estado_edicion: calcularEstadoEdicion(olimpiada),
      disciplinas,
      tramos: await obtenerTramos(db, olimpiadaId),
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la olimpiada");
  }
});

// Campos opcionales de la edición (bonos y flujo). Sólo se devuelven los que vinieron informados.
function normalizarOpcionalesOlimpiada(body) {
  const opcionales = {};
  if (valorInformado(body.valor_bono)) {
    const valor = normalizarMonto(body.valor_bono);
    if (valor === null) return { error: "El valor del bono debe ser un monto válido (hasta 2 decimales)" };
    opcionales.valor_bono = valor;
  }
  if (valorInformado(body.bonos_afiliado)) {
    const bonos = normalizarEnteroNoNegativo(body.bonos_afiliado);
    if (bonos === null || bonos > MAX_BONOS_MANUAL) return { error: `Los bonos por afiliado deben ser un entero entre 0 y ${MAX_BONOS_MANUAL}` };
    opcionales.bonos_afiliado = bonos;
  }
  for (const campo of ["requiere_aprobacion", "exigir_bonos_para_validar"]) {
    if (!valorInformado(body[campo])) continue;
    const bandera = normalizarBooleano01(body[campo]);
    if (bandera === null) return { error: `El campo ${campo} debe ser 1 o 0` };
    opcionales[campo] = bandera;
  }
  return { value: opcionales };
}

function validarDatosOlimpiada(body) {
  const nombre = normalizarTexto(body.nombre, 160);
  const fechaInicio = normalizarFechaCivil(body.fecha_inicio);
  const fechaFin = normalizarFechaCivil(body.fecha_fin);
  const inscInicio = normalizarFechaCivil(body.fecha_inicio_inscripcion);
  const inscFin = normalizarFechaCivil(body.fecha_fin_inscripcion);
  if (!nombre || !fechaInicio || !fechaFin || !inscInicio || !inscFin) {
    return { error: "Nombre y las cuatro fechas civiles válidas (YYYY-MM-DD) son obligatorios" };
  }
  if (fechaFin < fechaInicio) return { error: "La fecha de fin no puede ser anterior a la de inicio" };
  if (inscFin < inscInicio) return { error: "El cierre de inscripción no puede ser anterior a su apertura" };
  if (inscFin > fechaInicio) return { error: "La inscripción debe cerrar antes o el mismo día de inicio de la olimpiada" };
  const disciplinas = Array.isArray(body.disciplinas) ? body.disciplinas : parseJsonSeguro(body.disciplinas, []);
  if (!Array.isArray(disciplinas) || disciplinas.length === 0) {
    return { error: "Elegí al menos una disciplina para la olimpiada" };
  }
  const disciplinasNormalizadas = [];
  const disciplinasVistas = new Set();
  for (const d of disciplinas) {
    const disciplinaId = normalizarIdPositivo(d.disciplina_id ?? d.id);
    if (!disciplinaId) return { error: "Hay una disciplina inválida en la lista" };
    if (disciplinasVistas.has(disciplinaId)) return { error: "No se puede repetir una disciplina" };
    disciplinasVistas.add(disciplinaId);
    const cupo = normalizarCupo(d.max_por_departamental);
    if (cupo.error) return { error: `Cupo inválido para la disciplina #${disciplinaId}: ${cupo.error}` };
    disciplinasNormalizadas.push({ disciplina_id: disciplinaId, max_por_departamental: cupo.value });
  }
  const opcionales = normalizarOpcionalesOlimpiada(body);
  if (opcionales.error) return { error: opcionales.error };
  return {
    value: {
      nombre,
      edicion: normalizarTexto(body.edicion, 80),
      localidad: normalizarTexto(body.localidad, 120),
      descripcion: normalizarTexto(body.descripcion),
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      fecha_inicio_inscripcion: inscInicio,
      fecha_fin_inscripcion: inscFin,
      texto_licencia: normalizarTexto(body.texto_licencia),
      disciplinas: disciplinasNormalizadas,
      opcionales: opcionales.value,
    },
  };
}

router.post("/olimpiadas", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
    const parseo = validarDatosOlimpiada(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    await validarDisciplinasCatalogo(connection, datos.disciplinas);

    const columnas = [
      "nombre", "edicion", "localidad", "descripcion", "fecha_inicio", "fecha_fin",
      "fecha_inicio_inscripcion", "fecha_fin_inscripcion", "texto_licencia",
    ];
    const valores = [
      datos.nombre, datos.edicion, datos.localidad, datos.descripcion,
      datos.fecha_inicio, datos.fecha_fin,
      datos.fecha_inicio_inscripcion, datos.fecha_fin_inscripcion, datos.texto_licencia,
    ];
    for (const [campo, valor] of Object.entries(datos.opcionales)) {
      columnas.push(campo);
      valores.push(valor);
    }
    const [resultado] = await connection.query(
      `INSERT INTO olimpiada (${columnas.join(", ")}) VALUES (${columnas.map(() => "?").join(", ")})`,
      valores
    );
    const olimpiadaId = resultado.insertId;

    for (const d of datos.disciplinas) {
      await connection.query(
        `INSERT INTO olimpiada_disciplina_config (olimpiada_id, disciplina_id, max_por_departamental) VALUES (?, ?, ?)`,
        [olimpiadaId, d.disciplina_id, d.max_por_departamental]
      );
    }
    // Tramos de bonos por edad + secciones informativas de base (editables desde el back-office)
    await sembrarContenidoInicialOlimpiada(connection, olimpiadaId);

    await registrarHistorial(connection, {
      entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      valor_nuevo: `${datos.nombre} (${datos.fecha_inicio} a ${datos.fecha_fin}, ${datos.disciplinas.length} disciplinas)`,
    });

    await connection.commit();
    res.status(201).json({ success: true, id: olimpiadaId, message: "Olimpiada creada" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al crear la olimpiada");
  } finally {
    if (connection) connection.release();
  }
});

router.put("/olimpiadas/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID inválido");
    const parseo = validarDatosOlimpiada(req.body);
    if (parseo.error) return res.status(400).json(parseo.error);
    const datos = parseo.value;

    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const anterior = await bloquearOlimpiada(connection, olimpiadaId);
    if (!anterior) throw crearErrorHttp("Olimpiada no encontrada", 404);
    await connection.query(
      "SELECT disciplina_id FROM olimpiada_disciplina_config WHERE olimpiada_id = ? FOR UPDATE",
      [olimpiadaId]
    );
    await validarDisciplinasCatalogo(connection, datos.disciplinas);
    await validarConfiguracionContraInscripciones(connection, olimpiadaId, datos.disciplinas);

    const asignaciones = [
      "nombre = ?", "edicion = ?", "localidad = ?", "descripcion = ?", "fecha_inicio = ?", "fecha_fin = ?",
      "fecha_inicio_inscripcion = ?", "fecha_fin_inscripcion = ?", "texto_licencia = ?",
    ];
    const valores = [
      datos.nombre, datos.edicion, datos.localidad, datos.descripcion,
      datos.fecha_inicio, datos.fecha_fin,
      datos.fecha_inicio_inscripcion, datos.fecha_fin_inscripcion, datos.texto_licencia,
    ];
    for (const [campo, valor] of Object.entries(datos.opcionales)) {
      asignaciones.push(`${campo} = ?`);
      valores.push(valor);
    }
    valores.push(olimpiadaId);
    await connection.query(`UPDATE olimpiada SET ${asignaciones.join(", ")} WHERE id = ?`, valores);

    // Upsert de la configuración: conserva sede/veedor/reglamento de las disciplinas que siguen
    for (const d of datos.disciplinas) {
      await connection.query(
        `INSERT INTO olimpiada_disciplina_config (olimpiada_id, disciplina_id, max_por_departamental)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE max_por_departamental = ?`,
        [olimpiadaId, d.disciplina_id, d.max_por_departamental, d.max_por_departamental]
      );
    }
    await connection.query(
      "DELETE FROM olimpiada_disciplina_config WHERE olimpiada_id = ? AND disciplina_id NOT IN (?)",
      [olimpiadaId, datos.disciplinas.map((d) => d.disciplina_id)]
    );

    const formatearFecha = (fecha) => normalizarFechaCivil(fecha) || "";
    const camposComparables = [
      ["nombre", anterior.nombre, datos.nombre],
      ["edicion", anterior.edicion, datos.edicion],
      ["localidad", anterior.localidad, datos.localidad],
      ["descripcion", anterior.descripcion, datos.descripcion],
      ["fecha_inicio", formatearFecha(anterior.fecha_inicio), datos.fecha_inicio],
      ["fecha_fin", formatearFecha(anterior.fecha_fin), datos.fecha_fin],
      ["fecha_inicio_inscripcion", formatearFecha(anterior.fecha_inicio_inscripcion), datos.fecha_inicio_inscripcion],
      ["fecha_fin_inscripcion", formatearFecha(anterior.fecha_fin_inscripcion), datos.fecha_fin_inscripcion],
      ["texto_licencia", anterior.texto_licencia, datos.texto_licencia],
    ];
    for (const [campo, valor] of Object.entries(datos.opcionales)) {
      camposComparables.push([campo, String(Number(anterior[campo]) || 0), String(valor)]);
    }
    for (const [campo, valorAnterior, valorNuevo] of camposComparables) {
      if ((valorAnterior ?? "") !== (valorNuevo ?? "")) {
        await registrarHistorial(connection, {
          entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
          usuario_id: cabecera.id, usuario_rol: cabecera.rol,
          tipo_operacion: "UPDATE", campo_modificado: campo,
          valor_anterior: valorAnterior, valor_nuevo: valorNuevo,
        });
      }
    }
    await registrarHistorial(connection, {
      entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "UPDATE", campo_modificado: "disciplinas",
      valor_nuevo: datos.disciplinas
        .map((d) => `#${d.disciplina_id}:${d.max_por_departamental === null ? "ilimitado" : d.max_por_departamental}`)
        .join(", "),
    });

    await connection.commit();
    res.status(200).json({ success: true, message: "Olimpiada actualizada" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al actualizar la olimpiada");
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/olimpiadas/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID inválido");
    const db = mysqlConnection.promise();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const olimpiada = await bloquearOlimpiada(connection, olimpiadaId);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    await connection.query("UPDATE olimpiada SET eliminado = 1 WHERE id = ? AND eliminado = 0", [olimpiadaId]);
    await registrarHistorial(connection, {
      entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE", valor_anterior: olimpiada.nombre,
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Olimpiada eliminada" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al eliminar la olimpiada");
  } finally {
    if (connection) connection.release();
  }
});

// ===========================================================================
// MENSAJES GENERALES a los inscriptos activos
// ===========================================================================
router.get("/olimpiadas/:id(\\d+)/mensajes", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    const db = mysqlConnection.promise();
    const [mensajes] = await db.query(
      `SELECT m.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
       FROM olimpiada_mensaje_general m
       LEFT JOIN usuario u ON u.id = m.usuario_id
       WHERE m.olimpiada_id = ?
       ORDER BY m.fecha_creacion DESC, m.id DESC`,
      [olimpiadaId]
    );
    res.status(200).json(mensajes);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener los mensajes");
  }
});

router.post("/olimpiadas/:id(\\d+)/mensajes", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    const titulo = normalizarTexto(req.body.titulo, 180);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!olimpiadaId || !titulo || !mensaje) return res.status(400).json("Título y mensaje son obligatorios");

    const db = mysqlConnection.promise();
    const olimpiada = await obtenerOlimpiada(db, olimpiadaId);
    if (!olimpiada) return res.status(404).json("Olimpiada no encontrada");

    // La administración provincial escribe a todos los inscriptos; una departamental, sólo a los suyos
    const filtroDepartamental = cabecera.rol === "departamental" ? departamentalDe(cabecera) : null;
    const [inscriptos] = await db.query(
      `SELECT DISTINCT i.usuario_id
       FROM olimpiada_inscripcion i
       WHERE i.olimpiada_id = ? AND i.eliminado = 0 AND i.estado IN ${SQL_ESTADOS_ACTIVOS}
         AND (? IS NULL OR i.departamental_id = ?)`,
      [olimpiadaId, filtroDepartamental, filtroDepartamental]
    );
    if (inscriptos.length === 0) return res.status(400).json("La olimpiada todavía no tiene inscriptos para notificar");

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [resultado] = await connection.query(
      `INSERT INTO olimpiada_mensaje_general (olimpiada_id, usuario_id, usuario_rol, titulo, mensaje, destinatarios)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [olimpiadaId, cabecera.id, cabecera.rol, titulo, mensaje, inscriptos.length]
    );

    for (const inscripto of inscriptos) {
      await insertarNotificacion(connection, inscripto.usuario_id, "OLIMPIADA_MENSAJE", titulo, mensaje, {
        olimpiada_id: olimpiadaId,
        mensaje_id: resultado.insertId,
      });
    }

    await registrarHistorial(connection, {
      entidad: "MENSAJE_GENERAL", entidad_id: resultado.insertId, olimpiada_id: olimpiadaId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "MENSAJE_GENERAL",
      valor_nuevo: `${titulo} (${inscriptos.length} destinatarios)`,
      observacion: mensaje,
    });

    await connection.commit();
    res.status(201).json({ success: true, message: `Mensaje enviado a ${inscriptos.length} inscriptos` });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

// ===========================================================================
// INSCRIPCIONES
// ===========================================================================

// Alta (afiliado para sí mismo; staff en nombre de un afiliado: departamental sólo los suyos)
router.post("/olimpiadas/:id(\\d+)/inscripciones", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID de olimpiada inválido");
    const actorEsStaff = esStaff(cabecera);
    if (cabecera.rol !== "afiliado" && !actorEsStaff) return res.status(401).json("No autorizado");

    const db = mysqlConnection.promise();
    const [olimpiadas] = await db.query("SELECT * FROM olimpiada WHERE id = ? AND eliminado = 0 AND habilitado = 'Y'", [olimpiadaId]);
    if (olimpiadas.length === 0) return res.status(404).json("Olimpiada no encontrada");
    let olimpiada = olimpiadas[0];

    // Afiliado destinatario de la inscripción
    let usuarioId = normalizarIdPositivo(cabecera.id);
    if (actorEsStaff) {
      usuarioId = normalizarIdPositivo(req.body.usuario_id);
      if (!usuarioId) return res.status(400).json("Elegí el afiliado a inscribir");
    }
    let afiliado = await resolverAfiliadoDestino(db, usuarioId, cabecera);

    const [existentes] = await db.query(
      "SELECT id FROM olimpiada_inscripcion WHERE olimpiada_id = ? AND usuario_id = ? AND eliminado = 0",
      [olimpiadaId, usuarioId]
    );
    if (existentes.length > 0) return res.status(409).json("El afiliado ya tiene una inscripción en esta olimpiada");

    const categoriaTipoId = normalizarIdPositivo(req.body.categoria_tipo_id);
    if (!categoriaTipoId) return res.status(400).json("Elegí la categoría del inscripto (Atleta, Coordinación, Cultura…)");
    const disciplinaIds = normalizarIds(req.body.disciplinas);
    if (!disciplinaIds || disciplinaIds.length === 0) return res.status(400).json("Elegí al menos una disciplina con IDs válidos");
    const acompaniantesParseo = normalizarAcompaniantes(req.body.acompaniantes, { permitirManual: actorEsStaff });
    if (acompaniantesParseo.error) return res.status(400).json(acompaniantesParseo.error);
    const acompaniantes = acompaniantesParseo.value || [];

    const datosSanitarioIds = normalizarIds(req.body.datos_sanitarios);
    if (!datosSanitarioIds) return res.status(400).json("La lista de datos sanitarios contiene IDs inválidos");
    const tensionArterial = normalizarTexto(req.body.tension_arterial, 20);
    const grupoSanguineoId = normalizarIdPositivo(req.body.grupo_sanguineo_id);
    if (!tensionArterial) return res.status(400).json(actorEsStaff ? "Indicá la presión arterial habitual del afiliado" : "Indicá tu presión arterial habitual");
    if (!grupoSanguineoId) return res.status(400).json(actorEsStaff ? "Elegí el grupo sanguíneo del afiliado" : "Elegí tu grupo sanguíneo");

    // Documentación: obligatoria para el afiliado; el staff puede dejarla pendiente
    const archivos = req.files || [];
    const archivoCertificado = archivos.find((f) => f.fieldname === "CERTIFICADO");
    const archivoFoto = archivos.find((f) => f.fieldname === "FOTO");
    const firmaBase64 = normalizarTexto(req.body.firma);
    if (!actorEsStaff) {
      if (!archivoCertificado) return res.status(400).json("Adjuntá el certificado médico");
      if (!archivoFoto) return res.status(400).json("Adjuntá una foto del afiliado");
      if (!firmaBase64) return res.status(400).json("Falta la firma");
    }
    if (archivoFoto && !archivoFoto.mimetype?.startsWith("image/")) return res.status(400).json("La foto debe ser una imagen");

    // Cupos por departamental (dentro de la transacción para evitar sobrecupo)
    connection = await db.getConnection();
    await connection.beginTransaction();

    const olimpiadaBloqueada = await bloquearOlimpiada(connection, olimpiadaId, { requiereHabilitada: true });
    if (!olimpiadaBloqueada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    olimpiada = olimpiadaBloqueada;
    // El staff puede cargar inscripciones fuera de la ventana (carga en mostrador); el afiliado no
    if (!actorEsStaff && !estaVentanaInscripcionAbierta(olimpiada)) {
      throw crearErrorHttp("La inscripción a esta olimpiada no está abierta", 409);
    }

    afiliado = await resolverAfiliadoDestino(connection, usuarioId, cabecera, { forUpdate: true });

    const [existentesBloqueadas] = await connection.query(
      `SELECT id FROM olimpiada_inscripcion
       WHERE olimpiada_id = ? AND usuario_id = ? AND eliminado = 0
       FOR UPDATE`,
      [olimpiadaId, usuarioId]
    );
    if (existentesBloqueadas.length > 0) {
      throw crearErrorHttp("El afiliado ya tiene una inscripción en esta olimpiada", 409);
    }

    const categoria = await obtenerCategoria(connection, categoriaTipoId);
    if (!categoria) throw crearErrorHttp("La categoría elegida no existe o está deshabilitada", 400);
    await validarDisciplinasCategoria(connection, disciplinaIds, categoria);
    await validarReferenciasSanitarias(connection, grupoSanguineoId, datosSanitarioIds);
    await validarCapacidadDisciplinas(connection, {
      olimpiadaId,
      departamentalId: afiliado.departamental_id,
      disciplinaIds,
    });
    const tramos = await obtenerTramos(connection, olimpiadaId);
    const estadoInicial = estadoInicialInscripcion({ rol: cabecera.rol, olimpiada });

    // Archivos a S3 (los que vinieron)
    let firmaArchivo = null;
    let certificadoArchivo = null;
    let fotoArchivo = null;
    if (firmaBase64) firmaArchivo = await subirFirmaBase64(firmaBase64, "inscripciones/firma");
    if (archivoCertificado) certificadoArchivo = await subirArchivoOlimpiadas(archivoCertificado, "inscripciones/certificado");
    if (archivoFoto) fotoArchivo = await subirArchivoOlimpiadas(archivoFoto, "inscripciones/foto");

    const validadaAlCrear = estadoInicial === "VALIDADO";
    const [resultado] = await connection.query(
      `INSERT INTO olimpiada_inscripcion
         (olimpiada_id, usuario_id, departamental_id, creado_por_usuario_id, estado, categoria_tipo_id,
          tension_arterial, grupo_sanguineo_id, detalle_medico, detalle_alimentario, observaciones,
          lugar_trabajo, firma_archivo, certificado_archivo, certificado_nombre_original, certificado_mime, foto_archivo,
          fecha_validacion, validado_por_usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${validadaAlCrear ? "NOW()" : "NULL"}, ?)`,
      [
        olimpiadaId, usuarioId, afiliado.departamental_id, cabecera.id, estadoInicial, categoria.id,
        tensionArterial, grupoSanguineoId,
        normalizarTexto(req.body.detalle_medico), normalizarTexto(req.body.detalle_alimentario),
        normalizarTexto(req.body.observaciones), normalizarTexto(req.body.lugar_trabajo, 120),
        firmaArchivo, certificadoArchivo,
        archivoCertificado ? archivoCertificado.originalname || null : null,
        archivoCertificado ? archivoCertificado.mimetype || null : null,
        fotoArchivo,
        validadaAlCrear && actorEsStaff ? cabecera.id : null,
      ]
    );
    const inscripcionId = resultado.insertId;

    for (const disciplinaId of disciplinaIds) {
      await connection.query(
        "INSERT INTO olimpiada_inscripcion_disciplina (inscripcion_id, disciplina_id) VALUES (?, ?)",
        [inscripcionId, disciplinaId]
      );
    }
    for (const datoId of datosSanitarioIds) {
      await connection.query(
        "INSERT INTO olimpiada_inscripcion_dato_sanitario (inscripcion_id, dato_sanitario_id) VALUES (?, ?)",
        [inscripcionId, datoId]
      );
    }
    const resumenAcompaniantes = await guardarAcompaniantes(connection, inscripcionId, acompaniantes, {
      tramos,
      bonosAfiliado: olimpiada.bonos_afiliado,
      fechaReferencia: olimpiada.fecha_inicio,
    });

    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: olimpiadaId, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CREATE",
      valor_nuevo: `Inscripción de ${afiliado.apellido}, ${afiliado.nombre} · ${categoria.nombre} · ${disciplinaIds.length} disciplinas · ${estadoInicial}`,
    });
    if (resumenAcompaniantes.cantidad > 0) {
      await registrarHistorial(connection, {
        entidad: "ACOMPANIANTE", entidad_id: inscripcionId,
        olimpiada_id: olimpiadaId, inscripcion_id: inscripcionId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "CREATE", campo_modificado: "acompaniantes",
        valor_nuevo: textoResumenAcompaniantes(resumenAcompaniantes),
      });
    }

    if (actorEsStaff) {
      await insertarNotificacion(connection, usuarioId, "OLIMPIADA_ESTADO",
        `Te inscribimos a ${olimpiada.nombre}`,
        estadoInicial === "VALIDADO"
          ? `Tu departamental cargó tu inscripción a ${olimpiada.nombre} y ya está aprobada. Revisá el detalle y escribinos por el chat si tenés dudas.`
          : `Tu departamental cargó tu inscripción a ${olimpiada.nombre}. Queda en revisión hasta que se cubran los bonos contribución.`,
        { inscripcion_id: inscripcionId, olimpiada_id: olimpiadaId, estado: estadoInicial });
    } else {
      await notificarStaffOlimpiadas(connection, afiliado.departamental_id, "OLIMPIADA_NUEVA",
        `Nueva inscripción a ${olimpiada.nombre}`,
        `${afiliado.apellido}, ${afiliado.nombre} se inscribió a las olimpiadas${estadoInicial === "PENDIENTE" ? " y espera aprobación" : ""}.`,
        { inscripcion_id: inscripcionId, olimpiada_id: olimpiadaId, estado: estadoInicial });
    }

    await connection.commit();
    let message;
    if (estadoInicial === "PENDIENTE") {
      message = actorEsStaff
        ? "Inscripción cargada. Asigná los bonos para validarla"
        : "¡Inscripción enviada! Queda pendiente de aprobación de tu departamental";
    } else {
      message = actorEsStaff ? "Inscripción cargada y validada" : "¡Inscripción enviada! Nos vemos en las olimpiadas";
    }
    res.status(201).json({ success: true, id: inscripcionId, message, estado: estadoInicial });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al enviar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// Tabla de inscriptos de una olimpiada (staff), con categoría, acompañantes, bonos y documentación
router.get("/olimpiadas/:id(\\d+)/inscripciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const olimpiadaId = normalizarIdPositivo(req.params.id);
    if (!olimpiadaId) return res.status(400).json("ID de olimpiada inválido");
    const estadoFiltro = valorInformado(req.query.estado) ? String(req.query.estado).toUpperCase() : null;
    if (estadoFiltro && !ESTADOS_INSCRIPCION.includes(estadoFiltro)) return res.status(400).json("Estado inválido");
    const filtroDepartamental = cabecera.rol === "departamental" ? departamentalDe(cabecera) : null;

    const db = mysqlConnection.promise();
    const olimpiada = await obtenerOlimpiada(db, olimpiadaId);
    if (!olimpiada) return res.status(404).json("Olimpiada no encontrada");

    const [inscripciones] = await db.query(
      `SELECT i.id, i.estado, i.fecha_creacion, i.fecha_validacion, i.departamental_id,
              i.categoria_tipo_id, ct.nombre AS categoria_nombre,
              i.bonos_requeridos_manual, i.planilla_descuento,
              i.foto_archivo IS NOT NULL AS tiene_foto,
              i.certificado_archivo IS NOT NULL AS tiene_certificado,
              i.firma_archivo IS NOT NULL AS tiene_firma,
              dep.nombre AS departamental_nombre,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido,
              u.legajo, u.documento,
              i.detalle_medico IS NOT NULL AND i.detalle_medico <> '' AS tiene_detalle_medico,
              i.detalle_alimentario IS NOT NULL AND i.detalle_alimentario <> '' AS tiene_detalle_alimentario,
              (SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ')
               FROM olimpiada_inscripcion_disciplina idp
               INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
               WHERE idp.inscripcion_id = i.id) AS disciplinas
       FROM olimpiada_inscripcion i
       INNER JOIN usuario u ON u.id = i.usuario_id
       LEFT JOIN departamental dep ON dep.id = i.departamental_id
       LEFT JOIN olimpiada_disciplina_tipo ct ON ct.id = i.categoria_tipo_id
       WHERE i.olimpiada_id = ? AND i.eliminado = 0
         AND (? IS NULL OR i.departamental_id = ?)
         AND (? IS NULL OR i.estado = ?)
       ORDER BY i.fecha_creacion DESC, i.id DESC`,
      [olimpiadaId, filtroDepartamental, filtroDepartamental, estadoFiltro, estadoFiltro]
    );

    // Bonos requeridos/asignados calculados en JS: tramos + acompañantes + counts de bonos
    const tramos = await obtenerTramos(db, olimpiadaId);
    const [acompaniantes] = await db.query(
      `SELECT a.inscripcion_id, a.fecha_nacimiento, a.es_afiliado, a.bonos, a.bonos_manual
       FROM olimpiada_inscripcion_acompaniante a
       INNER JOIN olimpiada_inscripcion i ON i.id = a.inscripcion_id
       WHERE i.olimpiada_id = ? AND i.eliminado = 0`,
      [olimpiadaId]
    );
    const [bonos] = await db.query(
      `SELECT b.inscripcion_id, COUNT(*) AS total
       FROM olimpiada_bono b
       WHERE b.olimpiada_id = ? AND b.inscripcion_id IS NOT NULL
       GROUP BY b.inscripcion_id`,
      [olimpiadaId]
    );
    const bonosAfiliado = Number(olimpiada.bonos_afiliado) || 0;
    const acompaniantesPorInscripcion = new Map();
    for (const a of acompaniantes) {
      const clave = Number(a.inscripcion_id);
      if (!acompaniantesPorInscripcion.has(clave)) acompaniantesPorInscripcion.set(clave, []);
      acompaniantesPorInscripcion.get(clave).push(a);
    }
    const bonosPorInscripcion = new Map(bonos.map((b) => [Number(b.inscripcion_id), Number(b.total) || 0]));

    res.status(200).json(inscripciones.map((fila) => {
      const lista = acompaniantesPorInscripcion.get(Number(fila.id)) || [];
      const calculados = bonosAfiliado + lista.reduce(
        (total, a) => total + calcularBonosAcompaniante(a, { tramos, bonosAfiliado, fechaReferencia: olimpiada.fecha_inicio }),
        0
      );
      const manual = fila.bonos_requeridos_manual === null || fila.bonos_requeridos_manual === undefined
        ? null
        : Number(fila.bonos_requeridos_manual);
      const { tiene_foto, tiene_certificado, tiene_firma, ...resto } = fila;
      return {
        ...resto,
        planilla_descuento: Number(fila.planilla_descuento) === 1 ? 1 : 0,
        acompaniantes: lista.length,
        bonos_asignados: bonosPorInscripcion.get(Number(fila.id)) || 0,
        bonos_requeridos: manual !== null ? manual : calculados,
        documentacion_completa: Boolean(tiene_foto && tiene_certificado && tiene_firma),
      };
    }));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener las inscripciones");
  }
});

// Inscripciones propias del afiliado
router.get("/olimpiadas/mis-inscripciones", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const db = mysqlConnection.promise();
    const [inscripciones] = await db.query(
      `SELECT i.id, i.estado, i.fecha_creacion, i.olimpiada_id, i.categoria_tipo_id, ct.nombre AS categoria_nombre,
              o.nombre AS olimpiada_nombre, o.edicion, o.localidad, o.fecha_inicio, o.fecha_fin,
              (SELECT COUNT(*) FROM olimpiada_bono b WHERE b.inscripcion_id = i.id) AS bonos_asignados,
              (SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ')
               FROM olimpiada_inscripcion_disciplina idp
               INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
               WHERE idp.inscripcion_id = i.id) AS disciplinas
       FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       LEFT JOIN olimpiada_disciplina_tipo ct ON ct.id = i.categoria_tipo_id
       WHERE i.usuario_id = ? AND i.eliminado = 0 AND o.eliminado = 0
       ORDER BY o.fecha_inicio DESC, i.id DESC`,
      [cabecera.id]
    );
    res.status(200).json(inscripciones.map((i) => ({ ...i, bonos_asignados: Number(i.bonos_asignados) || 0 })));
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener tus inscripciones");
  }
});

// Detalle completo de una inscripción
router.get("/olimpiadas/inscripciones/:id(\\d+)", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre, o.edicion AS olimpiada_edicion, o.localidad AS olimpiada_localidad,
              o.fecha_inicio AS olimpiada_fecha_inicio, o.fecha_fin AS olimpiada_fecha_fin, o.texto_licencia,
              o.fecha_inicio_inscripcion AS olimpiada_fecha_inicio_inscripcion,
              o.fecha_fin_inscripcion AS olimpiada_fecha_fin_inscripcion,
              o.valor_bono AS olimpiada_valor_bono, o.bonos_afiliado AS olimpiada_bonos_afiliado,
              o.requiere_aprobacion AS olimpiada_requiere_aprobacion,
              o.exigir_bonos_para_validar AS olimpiada_exigir_bonos,
              o.bono_numero_hasta AS olimpiada_bono_numero_hasta,
              dep.nombre AS departamental_nombre,
              g.nombre AS grupo_sanguineo_nombre,
              ct.nombre AS categoria_nombre,
              u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido, u.documento, u.legajo,
              u.cuil, u.email, u.telefono, u.fecha_nacimiento, u.dependencia_judicial,
              u.foto_archivo AS afiliado_foto_archivo,
              tp.nombre AS tipo_persona_nombre,
              CASE WHEN v.id IS NULL THEN NULL ELSE CONCAT(v.apellido, ', ', v.nombre) END AS validado_por_nombre
       FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       INNER JOIN usuario u ON u.id = i.usuario_id
       LEFT JOIN departamental dep ON dep.id = i.departamental_id
       LEFT JOIN olimpiada_grupo_sanguineo g ON g.id = i.grupo_sanguineo_id
       LEFT JOIN olimpiada_disciplina_tipo ct ON ct.id = i.categoria_tipo_id
       LEFT JOIN tipo_persona tp ON tp.id = u.tipo_persona_id
       LEFT JOIN usuario v ON v.id = i.validado_por_usuario_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    const inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");

    const olimpiada = {
      id: inscripcion.olimpiada_id,
      valor_bono: inscripcion.olimpiada_valor_bono,
      bonos_afiliado: inscripcion.olimpiada_bonos_afiliado,
      fecha_inicio: inscripcion.olimpiada_fecha_inicio,
      fecha_inicio_inscripcion: inscripcion.olimpiada_fecha_inicio_inscripcion,
      fecha_fin_inscripcion: inscripcion.olimpiada_fecha_fin_inscripcion,
      exigir_bonos_para_validar: inscripcion.olimpiada_exigir_bonos,
      bono_numero_hasta: inscripcion.olimpiada_bono_numero_hasta,
    };

    const [disciplinas] = await db.query(
      `SELECT d.id, d.nombre, d.tipo_id, t.nombre AS tipo_nombre, d.icono_archivo
       FROM olimpiada_inscripcion_disciplina idp
       INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
       INNER JOIN olimpiada_disciplina_tipo t ON t.id = d.tipo_id
       WHERE idp.inscripcion_id = ?
       ORDER BY d.nombre`,
      [inscripcionId]
    );
    const [datosSanitarios] = await db.query(
      `SELECT ds.id, ds.nombre
       FROM olimpiada_inscripcion_dato_sanitario ids
       INNER JOIN olimpiada_dato_sanitario ds ON ds.id = ids.dato_sanitario_id
       WHERE ids.inscripcion_id = ?
       ORDER BY ds.orden`,
      [inscripcionId]
    );
    const [observaciones] = await db.query(
      `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje, o.fecha_creacion,
              u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
       FROM olimpiada_inscripcion_observacion o
       LEFT JOIN usuario u ON u.id = o.usuario_id
       WHERE o.inscripcion_id = ?
       ORDER BY o.fecha_creacion ASC, o.id ASC`,
      [inscripcionId]
    );
    const resumen = await resumenBonosInscripcion(db, inscripcion, olimpiada);

    let historial = [];
    let firmaSecretario = null;
    if (esStaff(cabecera)) {
      const [historialRows] = await db.query(
        `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido
         FROM olimpiada_historial h
         LEFT JOIN usuario u ON u.id = h.usuario_id
         WHERE h.inscripcion_id = ?
         ORDER BY h.fecha DESC, h.id DESC`,
        [inscripcionId]
      );
      historial = historialRows;
      // Firma del secretario para la constancia (solo staff)
      const [configRows] = await db.query("SELECT * FROM olimpiada_config WHERE id = 1");
      const config = configRows[0] || {};
      firmaSecretario = {
        nombre: config.firma_secretario_nombre || null,
        cargo: config.firma_secretario_cargo || null,
        url: await firmarSeguro(config.firma_secretario_archivo),
      };
    }

    res.status(200).json({
      ...inscripcion,
      planilla_descuento: Number(inscripcion.planilla_descuento) === 1 ? 1 : 0,
      olimpiada_requiere_aprobacion: Number(inscripcion.olimpiada_requiere_aprobacion) === 1 ? 1 : 0,
      olimpiada_exigir_bonos: Number(inscripcion.olimpiada_exigir_bonos) === 1 ? 1 : 0,
      inscripcion_abierta: estaVentanaInscripcionAbierta(olimpiada),
      disciplinas: await firmarIconosDisciplinas(disciplinas),
      datos_sanitarios: datosSanitarios,
      acompaniantes: resumen.acompaniantes,
      bonos: resumen,
      documentacion_completa: documentacionCompleta(inscripcion),
      observaciones_hilo: observaciones,
      historial,
      firma_secretario: firmaSecretario,
      firma_url: await firmarSeguro(inscripcion.firma_archivo),
      certificado_url: await firmarSeguro(inscripcion.certificado_archivo),
      foto_url: await firmarSeguro(inscripcion.foto_archivo),
      permisos: permisosInscripcion({ cabecera, inscripcion, olimpiada }),
    });
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener la inscripción");
  }
});

// Edición (staff siempre; el afiliado mientras la ventana esté abierta y no esté cancelada)
router.put("/olimpiadas/inscripciones/:id(\\d+)", verifyToken, manejarUploadOlimpiadas, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const actorEsStaff = esStaff(cabecera);
    if (cabecera.rol !== "afiliado" && !actorEsStaff) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion
       FROM olimpiada_inscripcion i INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    let inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");
    if (cabecera.rol === "afiliado") {
      if (!estaVentanaInscripcionAbierta(inscripcion)) return res.status(409).json("La inscripción ya cerró: pedí los cambios por el chat de tu inscripción");
      if (inscripcion.estado === "CANCELADO") return res.status(409).json("La inscripción está cancelada");
    }

    // Validaciones de formato antes de abrir la transacción
    const acompaniantesParseo = normalizarAcompaniantes(req.body.acompaniantes, { permitirManual: actorEsStaff });
    if (acompaniantesParseo.error) return res.status(400).json(acompaniantesParseo.error);
    const acompaniantes = acompaniantesParseo.value;

    connection = await db.getConnection();
    await connection.beginTransaction();

    const olimpiada = await bloquearOlimpiada(connection, inscripcion.olimpiada_id);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [inscripcionesBloqueadas] = await connection.query(
      `SELECT i.*, o.fecha_inicio_inscripcion, o.fecha_fin_inscripcion
       FROM olimpiada_inscripcion i INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0 FOR UPDATE`,
      [inscripcionId]
    );
    if (inscripcionesBloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    inscripcion = inscripcionesBloqueadas[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) throw crearErrorHttp("No autorizado", 403);
    if (cabecera.rol === "afiliado") {
      if (!estaVentanaInscripcionAbierta(inscripcion)) {
        throw crearErrorHttp("La inscripción ya cerró: pedí los cambios por el chat", 409);
      }
      if (inscripcion.estado === "CANCELADO") throw crearErrorHttp("La inscripción está cancelada", 409);
    }

    const cambios = [];
    let grupoSanguineoId = inscripcion.grupo_sanguineo_id;
    if (req.body.grupo_sanguineo_id !== undefined) {
      grupoSanguineoId = normalizarIdPositivo(req.body.grupo_sanguineo_id);
      if (!grupoSanguineoId) throw crearErrorHttp("Grupo sanguíneo inválido", 400);
    }

    // Categoría del inscripto
    let categoriaTipoId = inscripcion.categoria_tipo_id;
    let categoria = null;
    let categoriaCambio = false;
    if (req.body.categoria_tipo_id !== undefined) {
      categoriaTipoId = normalizarIdPositivo(req.body.categoria_tipo_id);
      if (!categoriaTipoId) throw crearErrorHttp("Elegí la categoría del inscripto", 400);
      categoria = await obtenerCategoria(connection, categoriaTipoId);
      if (!categoria) throw crearErrorHttp("La categoría elegida no existe o está deshabilitada", 400);
      if (!idsPositivosIguales(categoria.id, inscripcion.categoria_tipo_id)) {
        categoriaCambio = true;
        cambios.push({ campo: "categoria_tipo_id", anterior: inscripcion.categoria_tipo_id, nuevo: categoria.id });
      }
    } else if (categoriaTipoId) {
      categoria = await obtenerCategoria(connection, categoriaTipoId);
    }

    const campos = {
      tension_arterial: normalizarTexto(req.body.tension_arterial, 20) ?? inscripcion.tension_arterial,
      grupo_sanguineo_id: grupoSanguineoId,
      detalle_medico: req.body.detalle_medico !== undefined ? normalizarTexto(req.body.detalle_medico) : inscripcion.detalle_medico,
      detalle_alimentario: req.body.detalle_alimentario !== undefined ? normalizarTexto(req.body.detalle_alimentario) : inscripcion.detalle_alimentario,
      observaciones: req.body.observaciones !== undefined ? normalizarTexto(req.body.observaciones) : inscripcion.observaciones,
      lugar_trabajo: req.body.lugar_trabajo !== undefined ? normalizarTexto(req.body.lugar_trabajo, 120) : inscripcion.lugar_trabajo,
    };
    await validarReferenciasSanitarias(connection, campos.grupo_sanguineo_id, []);
    for (const [campo, valorNuevo] of Object.entries(campos)) {
      const valorAnterior = inscripcion[campo];
      if ((valorAnterior ?? "") !== (valorNuevo ?? "")) {
        cambios.push({ campo, anterior: valorAnterior, nuevo: valorNuevo });
      }
    }

    // Archivos nuevos (opcionales)
    const archivos = req.files || [];
    const archivoCertificado = archivos.find((f) => f.fieldname === "CERTIFICADO");
    const archivoFoto = archivos.find((f) => f.fieldname === "FOTO");
    let certificadoArchivo = inscripcion.certificado_archivo;
    let certificadoNombre = inscripcion.certificado_nombre_original;
    let certificadoMime = inscripcion.certificado_mime;
    let fotoArchivo = inscripcion.foto_archivo;
    let firmaArchivo = inscripcion.firma_archivo;
    if (archivoCertificado) {
      certificadoArchivo = await subirArchivoOlimpiadas(archivoCertificado, "inscripciones/certificado");
      certificadoNombre = archivoCertificado.originalname || null;
      certificadoMime = archivoCertificado.mimetype || null;
      cambios.push({ campo: "certificado_archivo", anterior: inscripcion.certificado_archivo, nuevo: certificadoArchivo });
    }
    if (archivoFoto) {
      if (!archivoFoto.mimetype?.startsWith("image/")) throw crearErrorHttp("La foto debe ser una imagen", 400);
      fotoArchivo = await subirArchivoOlimpiadas(archivoFoto, "inscripciones/foto");
      cambios.push({ campo: "foto_archivo", anterior: inscripcion.foto_archivo, nuevo: fotoArchivo });
    }
    const firmaBase64 = normalizarTexto(req.body.firma);
    if (firmaBase64) {
      const nuevaFirma = await subirFirmaBase64(firmaBase64, "inscripciones/firma");
      firmaArchivo = nuevaFirma;
      cambios.push({ campo: "firma_archivo", anterior: inscripcion.firma_archivo, nuevo: nuevaFirma });
    }

    const [actualizacionInscripcion] = await connection.query(
      `UPDATE olimpiada_inscripcion
       SET tension_arterial = ?, grupo_sanguineo_id = ?, detalle_medico = ?, detalle_alimentario = ?,
           observaciones = ?, lugar_trabajo = ?, firma_archivo = ?,
           certificado_archivo = ?, certificado_nombre_original = ?, certificado_mime = ?, foto_archivo = ?,
           categoria_tipo_id = ?
       WHERE id = ? AND estado = ? AND eliminado = 0`,
      [
        campos.tension_arterial, campos.grupo_sanguineo_id, campos.detalle_medico, campos.detalle_alimentario,
        campos.observaciones, campos.lugar_trabajo, firmaArchivo,
        certificadoArchivo, certificadoNombre, certificadoMime, fotoArchivo,
        categoriaTipoId,
        inscripcionId, inscripcion.estado,
      ]
    );
    if (actualizacionInscripcion.affectedRows !== 1) {
      throw crearErrorHttp("La inscripción cambió mientras se editaba. Recargá e intentá nuevamente.", 409);
    }

    // Disciplinas y datos sanitarios (si vienen, se reemplazan)
    let disciplinasFinales = null;
    if (req.body.disciplinas !== undefined) {
      const disciplinaIds = normalizarIds(req.body.disciplinas);
      if (!disciplinaIds || disciplinaIds.length === 0) throw crearErrorHttp("Elegí al menos una disciplina con IDs válidos", 400);
      await validarCapacidadDisciplinas(connection, {
        olimpiadaId: inscripcion.olimpiada_id,
        departamentalId: inscripcion.departamental_id,
        disciplinaIds,
        excluirInscripcionId: inscripcionId,
        controlarCapacidad: ESTADOS_ACTIVOS.includes(inscripcion.estado),
      });
      const [anteriores] = await connection.query(
        `SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ') AS lista
         FROM olimpiada_inscripcion_disciplina idp
         INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
         WHERE idp.inscripcion_id = ?`,
        [inscripcionId]
      );
      await connection.query("DELETE FROM olimpiada_inscripcion_disciplina WHERE inscripcion_id = ?", [inscripcionId]);
      for (const disciplinaId of disciplinaIds) {
        await connection.query(
          "INSERT INTO olimpiada_inscripcion_disciplina (inscripcion_id, disciplina_id) VALUES (?, ?)",
          [inscripcionId, disciplinaId]
        );
      }
      const [nuevas] = await connection.query(
        `SELECT GROUP_CONCAT(d.nombre ORDER BY d.nombre SEPARATOR ', ') AS lista
         FROM olimpiada_inscripcion_disciplina idp
         INNER JOIN olimpiada_disciplina d ON d.id = idp.disciplina_id
         WHERE idp.inscripcion_id = ?`,
        [inscripcionId]
      );
      if ((anteriores[0].lista || "") !== (nuevas[0].lista || "")) {
        cambios.push({ campo: "disciplinas", anterior: anteriores[0].lista, nuevo: nuevas[0].lista });
      }
      disciplinasFinales = disciplinaIds;
    }
    // Coherencia disciplinas ↔ categoría cuando cambia alguna de las dos
    if (categoria && (categoriaCambio || disciplinasFinales)) {
      if (!disciplinasFinales) {
        const [actuales] = await connection.query(
          "SELECT disciplina_id FROM olimpiada_inscripcion_disciplina WHERE inscripcion_id = ?",
          [inscripcionId]
        );
        disciplinasFinales = actuales.map((d) => Number(d.disciplina_id));
      }
      await validarDisciplinasCategoria(connection, disciplinasFinales, categoria);
    }
    if (req.body.datos_sanitarios !== undefined) {
      const datoIds = normalizarIds(req.body.datos_sanitarios);
      if (!datoIds) throw crearErrorHttp("La lista de datos sanitarios contiene IDs inválidos", 400);
      await validarReferenciasSanitarias(connection, campos.grupo_sanguineo_id, datoIds);
      await connection.query("DELETE FROM olimpiada_inscripcion_dato_sanitario WHERE inscripcion_id = ?", [inscripcionId]);
      for (const datoId of datoIds) {
        await connection.query(
          "INSERT INTO olimpiada_inscripcion_dato_sanitario (inscripcion_id, dato_sanitario_id) VALUES (?, ?)",
          [inscripcionId, datoId]
        );
      }
    }

    // Acompañantes (si vienen, se reemplaza el set completo y se recalculan los bonos)
    let resumenAcompaniantesNuevo = null;
    if (acompaniantes !== undefined) {
      const resumenAnterior = await resumenAcompaniantesActual(connection, inscripcionId);
      const tramos = await obtenerTramos(connection, inscripcion.olimpiada_id);
      resumenAcompaniantesNuevo = await guardarAcompaniantes(connection, inscripcionId, acompaniantes, {
        tramos,
        bonosAfiliado: olimpiada.bonos_afiliado,
        fechaReferencia: olimpiada.fecha_inicio,
      });
      await registrarHistorial(connection, {
        entidad: "ACOMPANIANTE", entidad_id: inscripcionId,
        olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE", campo_modificado: "acompaniantes",
        valor_anterior: textoResumenAcompaniantes(resumenAnterior),
        valor_nuevo: textoResumenAcompaniantes(resumenAcompaniantesNuevo),
      });
    }

    for (const cambio of cambios) {
      await registrarHistorial(connection, {
        entidad: "INSCRIPCION", entidad_id: inscripcionId,
        olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE", campo_modificado: cambio.campo,
        valor_anterior: cambio.anterior, valor_nuevo: cambio.nuevo,
      });
    }

    // Avisar a la otra parte si hubo cambios
    if (cambios.length > 0 || resumenAcompaniantesNuevo) {
      if (cabecera.rol === "afiliado") {
        await notificarStaffOlimpiadas(connection, inscripcion.departamental_id, "OLIMPIADA_ACTUALIZADA",
          `Inscripción #${inscripcionId} actualizada`,
          `El afiliado actualizó su formulario de inscripción a las olimpiadas.`,
          { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
      } else {
        await insertarNotificacion(connection, inscripcion.usuario_id, "OLIMPIADA_ACTUALIZADA",
          `Actualizamos tu inscripción a las olimpiadas`,
          `Nuestro equipo editó tu formulario de inscripción. Revisalo y escribinos por el chat si tenés dudas.`,
          { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
      }
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Inscripción actualizada" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al actualizar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// Cambio de estado: PENDIENTE → VALIDADO | CANCELADO; VALIDADO ↔ CANCELADO; staff vuelve a PENDIENTE;
// el afiliado sólo cancela la propia. Validar exige bonos cubiertos si la edición lo pide.
router.put("/olimpiadas/inscripciones/:id(\\d+)/estado", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const estadoNuevo = String(req.body.estado || "").toUpperCase();
    if (!ESTADOS_INSCRIPCION.includes(estadoNuevo)) return res.status(400).json("Estado inválido");
    const motivo = normalizarTexto(req.body.motivo, 500);
    if (cabecera.rol !== "afiliado" && !esStaff(cabecera)) return res.status(401).json("No autorizado");

    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    let inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");
    if (inscripcion.estado === estadoNuevo) return res.status(409).json("La inscripción ya está en ese estado");
    if (!transicionPermitida({ rol: cabecera.rol, desde: inscripcion.estado, hacia: estadoNuevo })) {
      return res.status(401).json("No autorizado");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const olimpiada = await bloquearOlimpiada(connection, inscripcion.olimpiada_id);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [inscripcionesBloqueadas] = await connection.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre
       FROM olimpiada_inscripcion i INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0 FOR UPDATE`,
      [inscripcionId]
    );
    if (inscripcionesBloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    inscripcion = inscripcionesBloqueadas[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) throw crearErrorHttp("No autorizado", 403);
    if (inscripcion.estado === estadoNuevo) throw crearErrorHttp("La inscripción ya está en ese estado", 409);
    if (!transicionPermitida({ rol: cabecera.rol, desde: inscripcion.estado, hacia: estadoNuevo })) {
      throw crearErrorHttp("No autorizado", 403);
    }

    // Reactivar (CANCELADO → PENDIENTE/VALIDADO) vuelve a ocupar cupo: se controla la capacidad
    const pasaAActivo = ESTADOS_ACTIVOS.includes(estadoNuevo) && !ESTADOS_ACTIVOS.includes(inscripcion.estado);
    if (pasaAActivo) {
      const [disciplinas] = await connection.query(
        "SELECT disciplina_id FROM olimpiada_inscripcion_disciplina WHERE inscripcion_id = ? FOR UPDATE",
        [inscripcionId]
      );
      const disciplinaIds = disciplinas.map((disciplina) => normalizarIdPositivo(disciplina.disciplina_id));
      if (disciplinaIds.length === 0 || disciplinaIds.some((id) => !id)) {
        throw crearErrorHttp("La inscripción no tiene disciplinas válidas para reactivarse", 409);
      }
      await validarCapacidadDisciplinas(connection, {
        olimpiadaId: inscripcion.olimpiada_id,
        departamentalId: inscripcion.departamental_id,
        disciplinaIds,
        excluirInscripcionId: inscripcionId,
      });
    }

    // Validar exige bonos completos o planilla de descuento cuando la edición lo pide
    if (estadoNuevo === "VALIDADO" && Number(olimpiada.exigir_bonos_para_validar) === 1) {
      const resumen = await resumenBonosInscripcion(connection, inscripcion, olimpiada);
      if (!resumen.cubiertos) {
        throw crearErrorHttp(`Faltan ${resumen.faltantes} bonos: asigná bonos o registrá la planilla de descuento`, 409);
      }
    }

    let setValidacion = "";
    const params = [estadoNuevo];
    if (estadoNuevo === "VALIDADO") {
      setValidacion = ", fecha_validacion = NOW(), validado_por_usuario_id = ?";
      params.push(cabecera.id);
    } else if (inscripcion.estado === "VALIDADO") {
      setValidacion = ", fecha_validacion = NULL, validado_por_usuario_id = NULL";
    }
    params.push(inscripcionId, inscripcion.estado);
    const [actualizacionEstado] = await connection.query(
      `UPDATE olimpiada_inscripcion SET estado = ?${setValidacion} WHERE id = ? AND estado = ? AND eliminado = 0`,
      params
    );
    if (actualizacionEstado.affectedRows !== 1) {
      throw crearErrorHttp("La inscripción cambió mientras se procesaba. Recargá e intentá nuevamente.", 409);
    }
    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "CAMBIO_ESTADO",
      campo_modificado: "estado", valor_anterior: inscripcion.estado, valor_nuevo: estadoNuevo,
      observacion: motivo,
    });

    if (cabecera.rol === "afiliado") {
      await notificarStaffOlimpiadas(connection, inscripcion.departamental_id, "OLIMPIADA_ESTADO",
        `Inscripción #${inscripcionId} cancelada`,
        `El afiliado canceló su inscripción a ${inscripcion.olimpiada_nombre}.${motivo ? ` Motivo: ${motivo}` : ""}`,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id, estado: estadoNuevo });
    } else {
      const textos = {
        VALIDADO: {
          titulo: "¡Tu inscripción está aprobada!",
          mensaje: `Tu inscripción a ${inscripcion.olimpiada_nombre} quedó aprobada. ¡Nos vemos en las olimpiadas!`,
        },
        CANCELADO: {
          titulo: "Tu inscripción fue cancelada",
          mensaje: `Cancelamos tu inscripción a ${inscripcion.olimpiada_nombre}.${motivo ? ` Motivo: ${motivo}.` : ""} Escribinos por el chat de tu inscripción si creés que es un error.`,
        },
        PENDIENTE: {
          titulo: "Tu inscripción volvió a revisión",
          mensaje: `Tu inscripción a ${inscripcion.olimpiada_nombre} volvió a revisión de tu departamental.${motivo ? ` Motivo: ${motivo}.` : ""} Escribinos por el chat si tenés dudas.`,
        },
      }[estadoNuevo];
      await insertarNotificacion(connection, inscripcion.usuario_id, "OLIMPIADA_ESTADO", textos.titulo, textos.mensaje,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id, estado: estadoNuevo });
    }

    await connection.commit();
    const message = {
      VALIDADO: "Inscripción aprobada",
      CANCELADO: "Inscripción cancelada",
      PENDIENTE: "Inscripción devuelta a revisión",
    }[estadoNuevo];
    res.status(200).json({ success: true, message, estado: estadoNuevo });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al actualizar el estado");
  } finally {
    if (connection) connection.release();
  }
});

// Pago de la inscripción: bonos requeridos a mano y planilla de descuento (staff)
router.put("/olimpiadas/inscripciones/:id(\\d+)/pago", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esStaff(cabecera)) return res.status(401).json("No autorizado");
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const body = req.body || {};

    // Cada campo se toca sólo si vino en el body (undefined = conservar)
    let bonosManual;
    if (body.bonos_requeridos_manual !== undefined) {
      if (!valorInformado(body.bonos_requeridos_manual)) {
        bonosManual = null;
      } else {
        bonosManual = normalizarEnteroNoNegativo(body.bonos_requeridos_manual);
        if (bonosManual === null || bonosManual > MAX_BONOS_MANUAL) {
          return res.status(400).json(`Los bonos requeridos deben ser un entero entre 0 y ${MAX_BONOS_MANUAL} (o vacío para volver al cálculo automático)`);
        }
      }
    }
    let planilla;
    if (body.planilla_descuento !== undefined) {
      planilla = normalizarBooleano01(body.planilla_descuento);
      if (planilla === null) return res.status(400).json("La planilla de descuento debe ser 1 o 0");
    }
    let planillaMonto;
    if (body.planilla_monto !== undefined) {
      if (!valorInformado(body.planilla_monto)) {
        planillaMonto = null;
      } else {
        planillaMonto = normalizarMonto(body.planilla_monto);
        if (planillaMonto === null) return res.status(400).json("El monto de la planilla es inválido (hasta 2 decimales)");
      }
    }
    let planillaCuotas;
    if (body.planilla_cuotas !== undefined) {
      if (!valorInformado(body.planilla_cuotas)) {
        planillaCuotas = null;
      } else {
        planillaCuotas = normalizarEnteroNoNegativo(body.planilla_cuotas);
        if (!planillaCuotas || planillaCuotas > MAX_CUOTAS_PLANILLA) {
          return res.status(400).json(`Las cuotas de la planilla deben ser un entero entre 1 y ${MAX_CUOTAS_PLANILLA}`);
        }
      }
    }
    let planillaObservacion;
    if (body.planilla_observacion !== undefined) planillaObservacion = normalizarTexto(body.planilla_observacion, 300);

    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_inscripcion WHERE id = ? AND eliminado = 0", [inscripcionId]);
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    if (!puedeVerInscripcion(cabecera, rows[0])) return res.status(401).json("No autorizado");

    connection = await db.getConnection();
    await connection.beginTransaction();
    const olimpiada = await bloquearOlimpiada(connection, rows[0].olimpiada_id);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [bloqueadas] = await connection.query(
      "SELECT * FROM olimpiada_inscripcion WHERE id = ? AND eliminado = 0 FOR UPDATE",
      [inscripcionId]
    );
    if (bloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    const inscripcion = bloqueadas[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) throw crearErrorHttp("No autorizado", 403);

    const anterior = {
      bonos_requeridos_manual: inscripcion.bonos_requeridos_manual === null ? null : Number(inscripcion.bonos_requeridos_manual),
      planilla_descuento: Number(inscripcion.planilla_descuento) === 1 ? 1 : 0,
      planilla_monto: inscripcion.planilla_monto === null ? null : Number(inscripcion.planilla_monto),
      planilla_cuotas: inscripcion.planilla_cuotas === null ? null : Number(inscripcion.planilla_cuotas),
      planilla_observacion: inscripcion.planilla_observacion ?? null,
    };
    const nuevo = {
      bonos_requeridos_manual: bonosManual !== undefined ? bonosManual : anterior.bonos_requeridos_manual,
      planilla_descuento: planilla !== undefined ? planilla : anterior.planilla_descuento,
      planilla_monto: planillaMonto !== undefined ? planillaMonto : anterior.planilla_monto,
      planilla_cuotas: planillaCuotas !== undefined ? planillaCuotas : anterior.planilla_cuotas,
      planilla_observacion: planillaObservacion !== undefined ? planillaObservacion : anterior.planilla_observacion,
    };
    if (nuevo.planilla_descuento === 1) {
      if (nuevo.planilla_monto === null) {
        // Sin monto explícito: lo que falta pagar con los bonos requeridos vigentes
        const previo = await resumenBonosInscripcion(
          connection,
          { ...inscripcion, bonos_requeridos_manual: nuevo.bonos_requeridos_manual, planilla_descuento: 0 },
          olimpiada
        );
        nuevo.planilla_monto = previo.monto_faltante;
      }
    } else {
      nuevo.planilla_monto = null;
      nuevo.planilla_cuotas = null;
      nuevo.planilla_observacion = null;
    }

    await connection.query(
      `UPDATE olimpiada_inscripcion
       SET bonos_requeridos_manual = ?, planilla_descuento = ?, planilla_monto = ?, planilla_cuotas = ?, planilla_observacion = ?
       WHERE id = ? AND eliminado = 0`,
      [
        nuevo.bonos_requeridos_manual, nuevo.planilla_descuento, nuevo.planilla_monto,
        nuevo.planilla_cuotas, nuevo.planilla_observacion, inscripcionId,
      ]
    );

    const etiquetas = {
      bonos_requeridos_manual: (v) => (v === null ? "automático" : String(v)),
      planilla_descuento: (v) => (v === 1 ? "sí" : "no"),
      planilla_monto: (v) => (v === null ? "" : String(v)),
      planilla_cuotas: (v) => (v === null ? "" : String(v)),
      planilla_observacion: (v) => v ?? "",
    };
    let hubaCambios = false;
    for (const campo of Object.keys(nuevo)) {
      const valorAnterior = etiquetas[campo](anterior[campo]);
      const valorNuevo = etiquetas[campo](nuevo[campo]);
      if (valorAnterior === valorNuevo) continue;
      hubaCambios = true;
      await registrarHistorial(connection, {
        entidad: "PAGO", entidad_id: inscripcionId,
        olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
        usuario_id: cabecera.id, usuario_rol: cabecera.rol,
        tipo_operacion: "UPDATE", campo_modificado: campo,
        valor_anterior: valorAnterior, valor_nuevo: valorNuevo,
      });
    }

    const resumen = await resumenBonosInscripcion(connection, { ...inscripcion, ...nuevo }, olimpiada);
    await connection.commit();
    res.status(200).json({
      success: true,
      message: hubaCambios ? "Datos de pago actualizados" : "No hubo cambios en los datos de pago",
      bonos: resumen,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al actualizar los datos de pago");
  } finally {
    if (connection) connection.release();
  }
});

// Baja lógica (solo admin)
router.delete("/olimpiadas/inscripciones/:id(\\d+)", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    if (!esAdmin(cabecera)) return res.status(401).json("No autorizado");
    const inscripcionId = normalizarIdPositivo(req.params.id);
    if (!inscripcionId) return res.status(400).json("ID de inscripción inválido");
    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido
       FROM olimpiada_inscripcion i INNER JOIN usuario u ON u.id = i.usuario_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");

    connection = await db.getConnection();
    await connection.beginTransaction();
    const olimpiada = await bloquearOlimpiada(connection, rows[0].olimpiada_id);
    if (!olimpiada) throw crearErrorHttp("Olimpiada no encontrada", 404);
    const [inscripcionesBloqueadas] = await connection.query(
      `SELECT i.*, u.nombre AS afiliado_nombre, u.apellido AS afiliado_apellido
       FROM olimpiada_inscripcion i INNER JOIN usuario u ON u.id = i.usuario_id
       WHERE i.id = ? AND i.eliminado = 0 FOR UPDATE`,
      [inscripcionId]
    );
    if (inscripcionesBloqueadas.length === 0) throw crearErrorHttp("Inscripción no encontrada", 404);
    const inscripcion = inscripcionesBloqueadas[0];
    const [eliminacion] = await connection.query(
      `UPDATE olimpiada_inscripcion
       SET eliminado = 1, eliminado_usuario_id = ?, fecha_eliminacion = NOW()
       WHERE id = ? AND estado = ? AND eliminado = 0`,
      [cabecera.id, inscripcionId, inscripcion.estado]
    );
    if (eliminacion.affectedRows !== 1) throw crearErrorHttp("La inscripción cambió mientras se eliminaba", 409);
    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "DELETE",
      valor_anterior: `Inscripción de ${inscripcion.afiliado_apellido}, ${inscripcion.afiliado_nombre}`,
      observacion: normalizarTexto(req.body?.motivo, 500),
    });
    await connection.commit();
    res.status(200).json({ success: true, message: "Inscripción eliminada" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al eliminar la inscripción");
  } finally {
    if (connection) connection.release();
  }
});

// Chat de la inscripción (afiliado <-> staff)
router.post("/olimpiadas/inscripciones/:id(\\d+)/observaciones", verifyToken, async (req, res) => {
  let connection;
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    const mensaje = normalizarTexto(req.body.mensaje);
    if (!inscripcionId || !mensaje) return res.status(400).json("El mensaje es obligatorio");

    const db = mysqlConnection.promise();
    const [rows] = await db.query(
      `SELECT i.*, o.nombre AS olimpiada_nombre FROM olimpiada_inscripcion i
       INNER JOIN olimpiada o ON o.id = i.olimpiada_id
       WHERE i.id = ? AND i.eliminado = 0`,
      [inscripcionId]
    );
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    const inscripcion = rows[0];
    if (!puedeVerInscripcion(cabecera, inscripcion)) return res.status(401).json("No autorizado");

    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      "INSERT INTO olimpiada_inscripcion_observacion (inscripcion_id, usuario_id, usuario_rol, mensaje) VALUES (?, ?, ?, ?)",
      [inscripcionId, cabecera.id, cabecera.rol, mensaje]
    );
    await registrarHistorial(connection, {
      entidad: "INSCRIPCION", entidad_id: inscripcionId,
      olimpiada_id: inscripcion.olimpiada_id, inscripcion_id: inscripcionId,
      usuario_id: cabecera.id, usuario_rol: cabecera.rol,
      tipo_operacion: "OBSERVACION", observacion: mensaje,
    });

    if (cabecera.rol === "afiliado") {
      await notificarStaffOlimpiadas(connection, inscripcion.departamental_id, "OLIMPIADA_OBSERVACION",
        `Nuevo mensaje en la inscripción #${inscripcionId}`,
        `El afiliado escribió: ${mensaje}`,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
    } else {
      await insertarNotificacion(connection, inscripcion.usuario_id, "OLIMPIADA_OBSERVACION",
        `Nuevo mensaje en tu inscripción a ${inscripcion.olimpiada_nombre}`, mensaje,
        { inscripcion_id: inscripcionId, olimpiada_id: inscripcion.olimpiada_id });
    }

    await connection.commit();
    res.status(201).json({ success: true, message: "Mensaje enviado" });
  } catch (error) {
    if (connection) await connection.rollback();
    responderError(res, error, "Error al enviar el mensaje");
  } finally {
    if (connection) connection.release();
  }
});

// Descarga del certificado médico
router.get("/olimpiadas/inscripciones/:id(\\d+)/certificado", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    const inscripcionId = normalizarIdPositivo(req.params.id);
    const db = mysqlConnection.promise();
    const [rows] = await db.query("SELECT * FROM olimpiada_inscripcion WHERE id = ? AND eliminado = 0", [inscripcionId]);
    if (rows.length === 0) return res.status(404).json("Inscripción no encontrada");
    if (!puedeVerInscripcion(cabecera, rows[0])) return res.status(401).json("No autorizado");
    if (!rows[0].certificado_archivo) return res.status(404).json("La inscripción no tiene certificado");
    const objeto = await getObjectBufferFromS3(rows[0].certificado_archivo);
    if (!objeto) return res.status(404).json("El archivo no está disponible");
    const nombre = rows[0].certificado_nombre_original || rows[0].certificado_archivo.split("/").pop();
    res.setHeader("Content-Type", objeto.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(nombre)}"`);
    res.status(200).send(objeto.buffer);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al descargar el certificado");
  }
});

// ===========================================================================
// HISTORIAL GLOBAL (auditoría, administración provincial)
// ===========================================================================
router.get("/olimpiadas/historial", verifyToken, async (req, res) => {
  try {
    const cabecera = getCabecera(req);
    if (!esSuperior(cabecera)) return res.status(401).json("No autorizado");
    const db = mysqlConnection.promise();
    const limite = req.query.limite === undefined ? 500 : normalizarIdPositivo(req.query.limite);
    if (!limite || limite > 2000) return res.status(400).json("El límite es inválido");
    const [historial] = await db.query(
      `SELECT h.*, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido, o.nombre AS olimpiada_nombre
       FROM olimpiada_historial h
       LEFT JOIN usuario u ON u.id = h.usuario_id
       LEFT JOIN olimpiada o ON o.id = h.olimpiada_id
       ORDER BY h.fecha DESC, h.id DESC
       LIMIT ?`,
      [limite]
    );
    res.status(200).json(historial);
  } catch (error) {
    registrarErrorRuta(error);
    res.status(500).json("Error al obtener el historial");
  }
});

router.__test = Object.freeze({
  ESTADOS_EDICION,
  calcularEstadoEdicion,
  decodificarFirmaBase64,
  detectarMimeArchivo,
  documentacionCompleta,
  estaVentanaInscripcionAbierta,
  estadoInicialInscripcion,
  fechaHoyBuenosAires,
  idsPositivosIguales,
  normalizarAcompaniantes,
  normalizarCupo,
  normalizarIdPositivo,
  normalizarIds,
  permisosInscripcion,
  textoResumenAcompaniantes,
  transicionPermitida,
  validarCapacidadDisciplinas,
  validarConfiguracionContraInscripciones,
  validarContenidoArchivo,
  validarDatosOlimpiada,
  verifyToken,
});

module.exports = router;
