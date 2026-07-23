const IDENTIFICADOR_SQL = /^[a-z_][a-z0-9_]*$/i;

const CATALOGOS_HISTORIAL_USUARIO = Object.freeze([
  Object.freeze({ campo: "parentesco_id", tabla: "parentesco", alias: "hu_parentesco" }),
  Object.freeze({ campo: "tipo_persona_id", tabla: "tipo_persona", alias: "hu_tipo_persona" }),
  Object.freeze({ campo: "rol_id", tabla: "rol", alias: "hu_rol" }),
  Object.freeze({ campo: "departamental_id", tabla: "departamental", alias: "hu_departamental" }),
]);

const CATALOGOS_HISTORIAL_RESERVA = Object.freeze([
  Object.freeze({ campo: "estado_reserva_id", tabla: "estado_reserva", alias: "hr_estado_reserva" }),
  Object.freeze({ campo: "recurso_id", tabla: "recurso", alias: "hr_recurso" }),
  Object.freeze({ campo: "regimen_id", tabla: "regimen", alias: "hr_regimen" }),
]);

function validarIdentificadorSql(valor, descripcion) {
  if (!IDENTIFICADOR_SQL.test(valor)) {
    throw new Error(`${descripcion} no es un identificador SQL valido`);
  }
  return valor;
}

function escaparLiteralSql(valor) {
  return String(valor).replace(/'/g, "''");
}

/**
 * Genera SQL exclusivamente a partir de configuracion estatica del servidor.
 * Conserva los valores del historial y resuelve los IDs contra los catalogos
 * de la base conectada al momento de la consulta.
 */
function crearEnriquecimientoHistorial(catalogos, opciones = {}) {
  const aliasHistorial = validarIdentificadorSql(opciones.aliasHistorial || "h", "El alias del historial");
  const columnaCampo = validarIdentificadorSql(opciones.columnaCampo || "campo_modificado", "La columna de campo");
  const columnaAnterior = validarIdentificadorSql(opciones.columnaAnterior || "valor_anterior", "La columna anterior");
  const columnaNueva = validarIdentificadorSql(opciones.columnaNueva || "valor_nuevo", "La columna nueva");

  const camposVistos = new Set();
  const aliasesVistos = new Set();
  const catalogosValidados = catalogos.map((catalogo) => {
    const campo = String(catalogo.campo);
    const tabla = validarIdentificadorSql(catalogo.tabla, "La tabla de catalogo");
    const alias = validarIdentificadorSql(catalogo.alias, "El alias de catalogo");
    const columnaId = validarIdentificadorSql(catalogo.columnaId || "id", "La columna ID de catalogo");
    const columnaNombre = validarIdentificadorSql(catalogo.columnaNombre || "nombre", "La columna de nombre de catalogo");

    if (camposVistos.has(campo) || aliasesVistos.has(alias)) {
      throw new Error("La configuracion de catalogos del historial contiene duplicados");
    }
    camposVistos.add(campo);
    aliasesVistos.add(alias);

    return {
      campo,
      campoSql: escaparLiteralSql(campo),
      tabla,
      alias,
      columnaId,
      columnaNombre,
    };
  });

  const crearJoin = (catalogo, columnaValor, sufijo) => {
    const aliasValor = `${catalogo.alias}_${sufijo}`;
    return `LEFT JOIN ${catalogo.tabla} ${aliasValor}
          ON ${aliasHistorial}.${columnaCampo} = '${catalogo.campoSql}'
         AND ${aliasHistorial}.${columnaValor} REGEXP '^[0-9]+$'
         AND ${aliasValor}.${catalogo.columnaId} = CAST(${aliasHistorial}.${columnaValor} AS UNSIGNED)`;
  };

  const joins = catalogosValidados
    .flatMap((catalogo) => [
      crearJoin(catalogo, columnaAnterior, "anterior"),
      crearJoin(catalogo, columnaNueva, "nuevo"),
    ])
    .join("\n        ");

  const crearExpresionValor = (columnaValor, sufijo) => {
    const casos = catalogosValidados
      .map((catalogo) => (
        `WHEN '${catalogo.campoSql}' THEN COALESCE(${catalogo.alias}_${sufijo}.${catalogo.columnaNombre}, ${aliasHistorial}.${columnaValor})`
      ))
      .join("\n            ");

    return `CASE ${aliasHistorial}.${columnaCampo}
            ${casos}
            ELSE ${aliasHistorial}.${columnaValor}
          END`;
  };

  return Object.freeze({
    joins,
    valorAnteriorSql: crearExpresionValor(columnaAnterior, "anterior"),
    valorNuevoSql: crearExpresionValor(columnaNueva, "nuevo"),
  });
}

module.exports = {
  CATALOGOS_HISTORIAL_RESERVA,
  CATALOGOS_HISTORIAL_USUARIO,
  crearEnriquecimientoHistorial,
};
