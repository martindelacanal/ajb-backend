"use strict";

const ROLES_GESTION_TURISMO = new Set(["admin", "admin-central", "departamental"]);
const ROLES_APROBACION_TURISMO = new Set(["admin", "admin-central"]);
const ESTADOS_APROBACION = new Set(["BORRADOR", "PENDIENTE", "APROBADO", "RECHAZADO"]);
const ALCANCES_DEPARTAMENTALES = new Set(["TODAS", "PROPIA", "SELECCIONADAS"]);
const MODELOS_TARIFA = new Set(["TEMPORADAS", "PRECIO_UNICO"]);
const UNIDADES_COBRO = new Set([
  "POR_PERSONA_NOCHE",
  "POR_RECURSO_NOCHE",
  "POR_RECURSO_DIA",
  "POR_ESTADIA",
]);
const AUDIENCIAS_DEPARTAMENTALES = new Set(["TODAS", "PROPIA", "OTRAS"]);
const TIPOS_FILTRO = new Set(["NUMERO", "BOOLEANO", "TEXTO", "OPCION"]);

function normalizarIdPositivo(valor) {
  if (typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0) return valor;
  if (typeof valor === "string" && /^\d+$/.test(valor.trim())) {
    const numero = Number(valor.trim());
    if (Number.isSafeInteger(numero) && numero > 0) return numero;
  }
  return null;
}

function normalizarEnteroNoNegativo(valor, { nullable = false, maximo = 1_000_000 } = {}) {
  if (valor === undefined || valor === null || valor === "") return nullable ? null : 0;
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return undefined;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero >= 0 && numero <= maximo ? numero : undefined;
}

function normalizarBooleano(valor, porDefecto = null) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  if (valor === true || valor === 1 || ["1", "true", "y", "yes", "s", "si"].includes(String(valor).trim().toLowerCase())) return 1;
  if (valor === false || valor === 0 || ["0", "false", "n", "no"].includes(String(valor).trim().toLowerCase())) return 0;
  return undefined;
}

function normalizarTexto(valor, { nullable = true, maximo = 500 } = {}) {
  if (valor === undefined || valor === null) return nullable ? null : undefined;
  if (typeof valor !== "string") return undefined;
  const texto = valor.trim();
  if (!texto) return nullable ? null : undefined;
  if (texto.length > maximo) return undefined;
  return texto;
}

function normalizarCodigo(valor, fallback = null) {
  const fuente = normalizarTexto(valor, { nullable: true, maximo: 120 }) || fallback;
  if (!fuente) return null;
  const codigo = String(fuente)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return codigo || null;
}

function normalizarEnum(valor, permitidos, porDefecto = null) {
  if (valor === undefined || valor === null || valor === "") return porDefecto;
  const normalizado = String(valor).trim().toUpperCase();
  return permitidos.has(normalizado) ? normalizado : undefined;
}

function normalizarFechaCivil(valor) {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!match) return null;
  const fecha = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return fecha.getUTCFullYear() === Number(match[1])
    && fecha.getUTCMonth() === Number(match[2]) - 1
    && fecha.getUTCDate() === Number(match[3])
    ? texto
    : null;
}

function tieneAreaTurismo(cabecera) {
  if (!cabecera) return false;
  if (cabecera.rol === "afiliado") {
    return cabecera.modulo_turismo == null || Number(cabecera.modulo_turismo) === 1;
  }
  if (["departamental", "admin-central"].includes(cabecera.rol)) {
    return cabecera.area_turismo == null || Number(cabecera.area_turismo) === 1;
  }
  return cabecera.rol === "admin" || cabecera.rol === "auditor";
}

function puedeGestionarTurismo(cabecera) {
  return ROLES_GESTION_TURISMO.has(cabecera?.rol) && tieneAreaTurismo(cabecera);
}

function puedeAprobarTurismo(cabecera) {
  return ROLES_APROBACION_TURISMO.has(cabecera?.rol) && tieneAreaTurismo(cabecera);
}

function esAdministradorTurismo(cabecera) {
  return puedeAprobarTurismo(cabecera);
}

function crearErrorCatalogo(message, statusCode = 400, codigo = "CATALOGO_TURISMO_INVALIDO", detalles = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.codigo = codigo;
  if (detalles) error.detalles = detalles;
  return error;
}

function obtenerIp(req) {
  return req?.ip || req?.socket?.remoteAddress || null;
}

function serializarHistorial(valor) {
  if (valor === undefined) return null;
  return JSON.stringify(valor);
}

async function registrarHistorialTurismo(connection, {
  servicioId,
  recursoId = null,
  entidadTipo,
  entidadId = null,
  operacion,
  resumen,
  anterior = null,
  nuevo = null,
  usuarioId,
  req,
}) {
  await connection.query(
    `INSERT INTO turismo_historial
       (servicio_id, recurso_id, entidad_tipo, entidad_id, operacion, resumen,
        valor_anterior, valor_nuevo, usuario_id, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      servicioId,
      recursoId,
      entidadTipo,
      entidadId,
      operacion,
      resumen,
      serializarHistorial(anterior),
      serializarHistorial(nuevo),
      usuarioId,
      obtenerIp(req),
      req?.get?.("User-Agent") || null,
    ]
  );
}

async function obtenerServicioGestion(connection, servicioId, { forUpdate = false } = {}) {
  const id = normalizarIdPositivo(servicioId);
  if (!id) return null;
  const [rows] = await connection.query(
    `SELECT s.*, ts.codigo AS tipo_codigo, ts.nombre AS tipo_nombre,
            d.nombre AS propietario_departamental_nombre
       FROM servicio s
       INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
       LEFT JOIN departamental d ON d.id = s.propietario_departamental_id
      WHERE s.id = ?
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [id]
  );
  return rows[0] || null;
}

function asegurarPropiedadServicio(cabecera, servicio) {
  if (!servicio) throw crearErrorCatalogo("Servicio no encontrado", 404, "SERVICIO_NO_ENCONTRADO");
  if (esAdministradorTurismo(cabecera)) return;
  if (cabecera?.rol !== "departamental") {
    throw crearErrorCatalogo("No autorizado", 403, "SERVICIO_NO_AUTORIZADO");
  }
  const propia = normalizarIdPositivo(cabecera.departamental_id);
  if (!propia || propia !== normalizarIdPositivo(servicio.propietario_departamental_id)) {
    throw crearErrorCatalogo(
      "Sólo podés administrar servicios de tu departamental",
      403,
      "SERVICIO_OTRA_DEPARTAMENTAL"
    );
  }
}

async function obtenerServicioGestionAutorizado(connection, cabecera, servicioId, opciones = {}) {
  const servicio = await obtenerServicioGestion(connection, servicioId, opciones);
  asegurarPropiedadServicio(cabecera, servicio);
  return servicio;
}

/**
 * Condición SQL para las rutas de consulta/reserva. Admin y admin-central ven
 * todo lo publicado; afiliado/departamental además quedan acotados por su
 * departamental. Las pantallas de gestión usan su endpoint propio.
 */
function construirVisibilidadServicioSql(cabecera, alias = "s") {
  const condiciones = [`${alias}.activo = 1`, `${alias}.estado_aprobacion = 'APROBADO'`];
  const params = [];
  condiciones.push(`EXISTS (
    SELECT 1 FROM imagen_servicio ivs WHERE ivs.servicio_id = ${alias}.id
  )`);
  condiciones.push(`EXISTS (
    SELECT 1
      FROM tipo_servicio tsv
     WHERE tsv.id = ${alias}.tipo_servicio_id AND tsv.activo = 1
       AND (
         (
           tsv.codigo = 'CONVENIO_HOTELERO'
           AND EXISTS (
             SELECT 1 FROM convenio_hotel chv
              WHERE chv.servicio_id = ${alias}.id AND chv.activo = 1
                AND chv.ciudad IS NOT NULL AND chv.ciudad <> ''
                AND chv.provincia IS NOT NULL AND chv.provincia <> ''
                AND chv.coordenadas_maps IS NOT NULL AND chv.coordenadas_maps <> ''
                AND (
                  (${alias}.tarifario_pdf_url IS NOT NULL AND ${alias}.tarifario_pdf_url <> '')
                  OR (chv.tarifario_pdf_archivo IS NOT NULL AND chv.tarifario_pdf_archivo <> '')
                )
           )
         )
         OR (
           tsv.codigo IN ('ALOJAMIENTO_RECURSO', 'CUPO_NUMERADO')
           AND EXISTS (
             SELECT 1 FROM recurso rcv
              WHERE rcv.servicio_id = ${alias}.id AND rcv.activo = 1
           )
           AND (
             EXISTS (
               SELECT 1 FROM turismo_tarifa_regla trv
                WHERE trv.servicio_id = ${alias}.id AND trv.activo = 1
                  AND trv.fecha_fin >= CURDATE()
             )
             OR EXISTS (
               SELECT 1 FROM tarifa tv
                 INNER JOIN recurso rtv ON rtv.id = tv.recurso_id
                WHERE rtv.servicio_id = ${alias}.id AND rtv.activo = 1
                  AND tv.fecha_fin >= CURDATE()
             )
           )
           AND (
             tsv.codigo <> 'CUPO_NUMERADO'
             OR (
               (SELECT COUNT(*) FROM recurso rpv
                 WHERE rpv.servicio_id = ${alias}.id AND rpv.activo = 1
                   AND rpv.es_recurso_principal = 1) = 1
               AND EXISTS (
                 SELECT 1 FROM recurso_cupo_periodo cpv
                   INNER JOIN recurso rcpv ON rcpv.id = cpv.recurso_id
                  WHERE rcpv.servicio_id = ${alias}.id AND rcpv.activo = 1
                    AND cpv.activo = 1 AND cpv.fecha_fin >= CURDATE()
               )
             )
           )
         )
       )
  )`);
  if (["admin", "admin-central"].includes(cabecera?.rol)) {
    return { sql: condiciones.join(" AND "), params };
  }

  const departamentalId = normalizarIdPositivo(cabecera?.departamental_id);
  if (!departamentalId) {
    condiciones.push(`${alias}.alcance_departamental = 'TODAS'`);
    return { sql: condiciones.join(" AND "), params };
  }

  condiciones.push(`(
    ${alias}.alcance_departamental = 'TODAS'
    OR (${alias}.alcance_departamental = 'PROPIA' AND ${alias}.propietario_departamental_id = ?)
    OR (${alias}.alcance_departamental = 'SELECCIONADAS' AND EXISTS (
      SELECT 1 FROM servicio_departamental_visible sdv
       WHERE sdv.servicio_id = ${alias}.id AND sdv.departamental_id = ?
    ))
  )`);
  params.push(departamentalId, departamentalId);
  return { sql: condiciones.join(" AND "), params };
}

async function servicioVisibleParaActor(connection, cabecera, servicioId, { recursoId = null, forUpdate = false } = {}) {
  const id = normalizarIdPositivo(servicioId);
  const rid = recursoId == null ? null : normalizarIdPositivo(recursoId);
  if (!id || (recursoId != null && !rid)) return null;
  const visibilidad = construirVisibilidadServicioSql(cabecera, "s");
  const recursoJoin = rid
    ? "INNER JOIN recurso r ON r.servicio_id = s.id AND r.id = ? AND r.activo = 1"
    : "";
  // Capacidad real de la unidad: el cupo del catalogo o, si no esta cargado,
  // la caracteristica "Personas" (filtro PERSONAS) del recurso.
  const recursoSelect = rid
    ? `COALESCE(NULLIF(r.cupo_maximo, 0), (
         SELECT COALESCE(fr.valor_numero, fr.cantidad)
           FROM filtro_recurso fr INNER JOIN filtro f ON f.id = fr.filtro_id
          WHERE fr.recurso_id = r.id AND f.codigo = 'PERSONAS'
          LIMIT 1
       )) AS recurso_cupo_maximo`
    : "NULL AS recurso_cupo_maximo";
  const [rows] = await connection.query(
    `SELECT s.id, s.tipo_servicio_id, s.propietario_departamental_id,
            s.modelo_tarifa, s.unidad_cobro, s.permite_acompanantes,
            s.max_personas_reserva, s.anticipacion_minima_dias,
            ${recursoSelect}, ts.codigo AS tipo_codigo
       FROM servicio s
       INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id AND ts.activo = 1
       ${recursoJoin}
      WHERE s.id = ? AND ${visibilidad.sql}
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [...(rid ? [rid] : []), id, ...visibilidad.params]
  );
  return rows[0] || null;
}

function audienciaParaActor(servicio, cabecera) {
  const propietaria = normalizarIdPositivo(servicio?.propietario_departamental_id);
  const actor = normalizarIdPositivo(cabecera?.departamental_id);
  if (!propietaria) return "TODAS";
  return actor && actor === propietaria ? "PROPIA" : "OTRAS";
}

function normalizarValorFiltro(definicion, payload = {}) {
  const tipo = normalizarEnum(definicion?.tipo_valor, TIPOS_FILTRO);
  if (!tipo) return { error: "El tipo de característica no es válido" };
  if (tipo === "NUMERO") {
    const raw = payload.valor_numero ?? payload.valor ?? payload.cantidad;
    if (raw === undefined || raw === null || raw === "") return { value: { valor_numero: null, valor_booleano: null, valor_texto: null } };
    const numero = Number(raw);
    if (!Number.isFinite(numero) || numero < 0 || numero > 1_000_000) return { error: "El valor numérico no es válido" };
    return { value: { valor_numero: numero, valor_booleano: null, valor_texto: null } };
  }
  if (tipo === "BOOLEANO") {
    const booleano = normalizarBooleano(payload.valor_booleano ?? payload.valor ?? payload.habilitado);
    if (booleano === undefined || booleano === null) return { error: "El valor sí/no no es válido" };
    return { value: { valor_numero: null, valor_booleano: booleano, valor_texto: null } };
  }
  const texto = normalizarTexto(payload.valor_texto ?? payload.valor_opcion ?? payload.valor, { nullable: true, maximo: 500 });
  if (texto === undefined) return { error: "El valor de texto no es válido" };
  if (tipo === "OPCION" && texto) {
    let opciones = definicion.opciones;
    if (typeof opciones === "string") {
      try { opciones = JSON.parse(opciones); } catch (_) { opciones = []; }
    }
    const valores = (Array.isArray(opciones) ? opciones : [])
      .map((item) => typeof item === "object" ? String(item.valor ?? item.value ?? item.nombre ?? item.label ?? "") : String(item));
    if (valores.length && !valores.includes(texto)) return { error: "La opción elegida no pertenece al filtro" };
  }
  return { value: { valor_numero: null, valor_booleano: null, valor_texto: texto } };
}

function cumpleFiltroTipado(recursoFiltro, filtroSolicitado) {
  const tipo = String(recursoFiltro?.tipo_valor || "").toUpperCase();
  if (tipo === "NUMERO") {
    const minimo = Number(filtroSolicitado?.minimo ?? filtroSolicitado?.valor ?? filtroSolicitado);
    const actual = Number(recursoFiltro?.valor_numero ?? recursoFiltro?.cantidad);
    return Number.isFinite(minimo) && Number.isFinite(actual) && actual >= minimo;
  }
  if (tipo === "BOOLEANO") {
    const esperado = normalizarBooleano(filtroSolicitado?.valor ?? filtroSolicitado);
    const actual = normalizarBooleano(recursoFiltro?.valor_booleano ?? recursoFiltro?.habilitado);
    return esperado !== undefined && esperado !== null && actual === esperado;
  }
  const esperado = String(filtroSolicitado?.valor ?? filtroSolicitado ?? "").trim().toLocaleLowerCase("es");
  const actual = String(recursoFiltro?.valor_texto ?? "").trim().toLocaleLowerCase("es");
  return Boolean(esperado) && actual === esperado;
}

module.exports = {
  ALCANCES_DEPARTAMENTALES,
  AUDIENCIAS_DEPARTAMENTALES,
  ESTADOS_APROBACION,
  MODELOS_TARIFA,
  ROLES_APROBACION_TURISMO,
  ROLES_GESTION_TURISMO,
  TIPOS_FILTRO,
  UNIDADES_COBRO,
  asegurarPropiedadServicio,
  audienciaParaActor,
  construirVisibilidadServicioSql,
  crearErrorCatalogo,
  cumpleFiltroTipado,
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
  servicioVisibleParaActor,
  tieneAreaTurismo,
};
