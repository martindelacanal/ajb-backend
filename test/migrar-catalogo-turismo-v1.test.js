"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = require("../scripts/migrar-catalogo-turismo-v1");
const catalogo = require("../api/data/turismo-catalogo-inicial");

function filasInformationSchemaDesdeContrato(contrato) {
  return Object.entries(contrato).map(([nombre, definicion]) => {
    const extra = [];
    if (definicion.defaultValue === "CURRENT_TIMESTAMP") extra.push("DEFAULT_GENERATED");
    if (definicion.autoIncrement) extra.push("auto_increment");
    if (definicion.onUpdateCurrentTimestamp) extra.push("on update CURRENT_TIMESTAMP");
    return {
      COLUMN_NAME: nombre,
      COLUMN_TYPE: definicion.tipo,
      IS_NULLABLE: definicion.nullable,
      COLUMN_DEFAULT: definicion.defaultValue,
      EXTRA: extra.join(" "),
    };
  });
}

function filasDefinicionesIniciales() {
  const tiposRows = catalogo.TIPOS_SERVICIO.map((tipo, index) => ({
    id: tipo.legacyId ?? 100 + index,
    codigo: tipo.codigo,
    nombre: tipo.nombre,
    descripcion: tipo.descripcion,
    activo: tipo.activo,
    orden: tipo.orden,
  }));
  const filtrosRows = catalogo.FILTROS.map((filtro, index) => ({
    id: filtro.legacyId ?? 200 + index,
    codigo: filtro.codigo,
    nombre: filtro.nombre,
    tipo_valor: filtro.tipoValor,
    categoria: filtro.categoria,
    unidad: filtro.unidad,
    ayuda: filtro.ayuda,
    opciones: filtro.opciones == null ? null : JSON.stringify(filtro.opciones),
    activo: filtro.activo,
    orden: filtro.orden,
  }));
  const ordenPorFiltro = new Map(catalogo.FILTROS.map((filtro) => [filtro.codigo, filtro.orden]));
  const asociacionesRows = catalogo.SERVICIOS.flatMap((servicio) => {
    const codigos = new Set(servicio.recursos.flatMap((recurso) => Object.keys(recurso.valores)));
    return [...codigos].map((codigo) => ({
      servicio_codigo: servicio.codigo,
      filtro_codigo: codigo,
      mostrar_en_busqueda: 1,
      orden: ordenPorFiltro.get(codigo),
    }));
  });
  return { tiposRows, filtrosRows, asociacionesRows };
}

test("CLI exige modo y target explicitos; nunca permite target all", () => {
  assert.throws(() => migration.parsearArgumentos([]), /exactamente uno/);
  assert.throws(() => migration.parsearArgumentos(["--check"]), /target es obligatorio/);
  assert.throws(() => migration.parsearArgumentos(["--check", "--target=all"]), /develop o production/);
  assert.throws(() => migration.parsearArgumentos(["--check", "--apply", "--target=develop"]), /exactamente uno/);
  assert.deepEqual(
    migration.parsearArgumentos(["--check", "--target=develop", "--env-file=.env"]),
    {
      apply: false,
      checkOnly: true,
      target: "develop",
      allowProduction: false,
      confirmacion: null,
      envFile: path.resolve(".env"),
    }
  );
});

test("apply tiene confirmaciones distintas por entorno y production siempre exige opt-in", () => {
  assert.notEqual(migration.CONFIRMACIONES.develop, migration.CONFIRMACIONES.production);
  assert.throws(
    () => migration.validarAutorizacion(migration.parsearArgumentos(["--apply", "--target=develop"])),
    /APLICAR_CATALOGO_TURISMO_DEVELOP/
  );
  assert.doesNotThrow(() => migration.validarAutorizacion(migration.parsearArgumentos([
    "--apply", "--target=develop", "--confirm=APLICAR_CATALOGO_TURISMO_DEVELOP",
  ])));
  assert.throws(
    () => migration.validarAutorizacion(migration.parsearArgumentos(["--check", "--target=production"])),
    /--allow-production/
  );
  assert.throws(
    () => migration.validarAutorizacion(migration.parsearArgumentos([
      "--apply", "--target=production", "--allow-production", "--confirm=APLICAR_CATALOGO_TURISMO_DEVELOP",
    ])),
    /APLICAR_CATALOGO_TURISMO_PRODUCTION/
  );
});

test("develop se obtiene solo del bloque comentado y production del env activo TLS", () => {
  const env = `
DB_HOST=prod.example
DB_USER=prod
DB_PASSWORD=prod-secret
DB_DATABASE=prod_db
DB_PORT=3306
DB_SSL_MODE=verify-full
DB_SSL_CA_PATH=C:/certs/prod.pem
NODE_ENV=production

# DEVELOP (MySQL local)
# DB_HOST=127.0.0.1
# DB_USER=dev
# DB_PASSWORD=dev-secret
# DB_DATABASE=dev_db
# DB_PORT=3307
`;
  const blocks = migration.parsearBloquesEnv(env);
  assert.equal(blocks.develop.DB_DATABASE, "dev_db");
  const develop = migration.seleccionarConfiguracion({ target: "develop" }, env, {});
  assert.equal(develop.DB_HOST, "127.0.0.1");
  assert.equal(develop.DB_PORT, "3307");
  const production = migration.seleccionarConfiguracion({ target: "production" }, env, {});
  assert.equal(production.DB_HOST, "prod.example");
  assert.equal(production.DB_SSL_MODE, "verify-full");
  assert.equal(production.NODE_ENV, "production");
  assert.throws(
    () => migration.seleccionarConfiguracion({ target: "production" }, env.replace("NODE_ENV=production", "NODE_ENV=develop"), {}),
    /NODE_ENV=production/
  );
});

test("contrato DDL contiene todas las tablas, columnas, enums e indices requeridos", () => {
  assert.deepEqual(Object.keys(migration.CREATE_NUEVAS_TABLAS_SQL).sort(), [
    "recurso_cupo_periodo",
    "servicio_departamental_visible",
    "servicio_filtro",
    "turismo_historial",
    "turismo_tarifa_regla",
  ]);
  const ddl = Object.values(migration.CREATE_NUEVAS_TABLAS_SQL).join("\n");
  for (const fragment of [
    "uq_sdv_servicio_departamental", "mostrar_en_busqueda", "uq_rcp_recurso_fechas",
    "temporada ENUM('ALTA','BAJA','UNICA','PERSONALIZADA')", "audiencia_departamental",
    "porcentaje_descuento", "precio_por_persona", "valor_anterior JSON", "valor_nuevo JSON",
    "ip_address", "user_agent", "fecha_creacion",
  ]) assert.match(ddl, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.deepEqual(Object.keys(migration.COLUMNAS_A_AGREGAR.servicio), [
    "codigo", "descripcion", "provincia", "direccion", "tarifario_pdf_url", "motivo_revision",
    "anticipacion_minima_dias", "propietario_departamental_id", "creado_por_usuario_id",
    "estado_aprobacion", "activo", "alcance_departamental", "modelo_tarifa", "unidad_cobro",
    "permite_acompanantes", "max_personas_reserva", "etiqueta_identificador", "condiciones",
    "formulario_adhesion_url", "orden", "fecha_creacion", "fecha_modificacion", "version",
  ]);
  assert.match(migration.COLUMNAS_A_AGREGAR.servicio.unidad_cobro, /POR_PERSONA_NOCHE.*POR_RECURSO_DIA.*POR_ESTADIA/);
  assert.deepEqual(Object.keys(migration.COLUMNAS_A_AGREGAR.recurso), [
    "codigo", "categoria", "descripcion", "activo", "orden", "cupo_maximo",
    "es_recurso_principal", "fecha_creacion", "fecha_modificacion", "version",
  ]);
  assert.deepEqual(Object.keys(migration.COLUMNAS_A_AGREGAR.filtro_recurso), [
    "valor_numero", "valor_booleano", "valor_texto",
  ]);
  assert.deepEqual(migration.COLUMNAS_NUEVAS_TABLAS_REQUERIDAS.recurso_cupo_periodo, [
    "id", "recurso_id", "fecha_inicio", "fecha_fin", "cupo_total", "activo",
    "fecha_creacion", "fecha_modificacion", "version",
  ]);
  assert.ok(migration.INDICES_NUEVAS_TABLAS_REQUERIDOS.some(([, nombre]) => nombre === "uq_rcp_recurso_fechas"));
  assert.ok(migration.FOREIGN_KEYS_NUEVAS_TABLAS_REQUERIDAS.some(([, nombre]) => nombre === "fk_ttr_servicio"));
  assert.equal(migration.COLUMNAS_A_ALINEAR.servicio.nombre, "VARCHAR(120) NULL");
  assert.equal(migration.COLUMNAS_A_ALINEAR.servicio.lugar, "VARCHAR(160) NULL");
  assert.equal(migration.COLUMNAS_A_ALINEAR.convenio_hotel.coordenadas_maps, "VARCHAR(1000) NULL");
  assert.ok(migration.CHECKS_NUEVAS_TABLAS_REQUERIDOS.some(([, nombre]) => nombre === "chk_ttr_descuento"));
  assert.match(migration.CREATE_NUEVAS_TABLAS_SQL.turismo_tarifa_regla, /fecha_inicio DATE NOT NULL/);
  assert.match(migration.CREATE_NUEVAS_TABLAS_SQL.turismo_tarifa_regla, /porcentaje_descuento DECIMAL\(5,2\) NOT NULL DEFAULT 0/);
});

test("contrato semantico de tablas nuevas valida tipo, null, default, extra, autoincrement y columnas sobrantes", () => {
  assert.deepEqual(
    Object.keys(migration.CONTRATO_COLUMNAS_NUEVAS_TABLAS).sort(),
    Object.keys(migration.CREATE_NUEVAS_TABLAS_SQL).sort()
  );
  for (const [tabla, contrato] of Object.entries(migration.CONTRATO_COLUMNAS_NUEVAS_TABLAS)) {
    assert.deepEqual(Object.keys(contrato), migration.COLUMNAS_NUEVAS_TABLAS_REQUERIDAS[tabla]);
    assert.equal(contrato.id.autoIncrement, true);
    const evaluacion = migration.evaluarContratoColumnasNuevaTabla(
      tabla,
      filasInformationSchemaDesdeContrato(contrato)
    );
    assert.deepEqual(evaluacion, { faltantes: [], extras: [], incompatibles: [] });
  }

  const tabla = "servicio_filtro";
  const filas = filasInformationSchemaDesdeContrato(migration.CONTRATO_COLUMNAS_NUEVAS_TABLAS[tabla]);
  filas.find((row) => row.COLUMN_NAME === "id").EXTRA = "";
  filas.find((row) => row.COLUMN_NAME === "servicio_id").COLUMN_TYPE = "bigint";
  filas.find((row) => row.COLUMN_NAME === "filtro_id").IS_NULLABLE = "YES";
  filas.find((row) => row.COLUMN_NAME === "mostrar_en_busqueda").COLUMN_DEFAULT = "0";
  filas.find((row) => row.COLUMN_NAME === "fecha_creacion").EXTRA = "DEFAULT_GENERATED INVISIBLE";
  filas.push({
    COLUMN_NAME: "columna_fuera_de_contrato",
    COLUMN_TYPE: "int",
    IS_NULLABLE: "YES",
    COLUMN_DEFAULT: null,
    EXTRA: "",
  });
  const evaluacion = migration.evaluarContratoColumnasNuevaTabla(tabla, filas);
  assert.deepEqual(evaluacion.extras, ["columna_fuera_de_contrato"]);
  assert.deepEqual(
    evaluacion.incompatibles.map((item) => item.columna).sort(),
    ["fecha_creacion", "filtro_id", "id", "mostrar_en_busqueda", "servicio_id"].sort()
  );
  assert.ok(evaluacion.incompatibles.find((item) => item.columna === "id")
    .diferencias.some((item) => item.campo === "auto_increment"));
  assert.ok(evaluacion.incompatibles.find((item) => item.columna === "fecha_creacion")
    .diferencias.some((item) => item.campo === "extra_desconocido"));
  assert.equal(migration.normalizarDefaultColumna("0.00"), "0");
  assert.equal(migration.normalizarDefaultColumna("current_timestamp()"), "CURRENT_TIMESTAMP");
});

test("postflight compara tipos, filtros tipados/opciones y servicio_filtro solo para el seed", () => {
  const exactas = filasDefinicionesIniciales();
  exactas.tiposRows.push({ codigo: "TIPO_USUARIO", nombre: "Usuario", descripcion: "", activo: 1, orden: 999 });
  exactas.filtrosRows.push({ codigo: "FILTRO_USUARIO", nombre: "Usuario", tipo_valor: "TEXTO", activo: 1, orden: 999 });
  exactas.asociacionesRows.push({
    servicio_codigo: "SERVICIO_USUARIO",
    filtro_codigo: "FILTRO_USUARIO",
    mostrar_en_busqueda: 0,
    orden: 999,
  });
  assert.deepEqual(migration.erroresDefinicionesIniciales(exactas), []);

  const tipoAlterado = filasDefinicionesIniciales();
  tipoAlterado.tiposRows[0] = { ...tipoAlterado.tiposRows[0], orden: 999 };
  assert.match(migration.erroresDefinicionesIniciales(tipoAlterado).join(";"), /Tipo de servicio/);

  const filtroAlterado = filasDefinicionesIniciales();
  const indexTipoUnidad = filtroAlterado.filtrosRows.findIndex((row) => row.codigo === "TIPO_UNIDAD");
  filtroAlterado.filtrosRows[indexTipoUnidad] = {
    ...filtroAlterado.filtrosRows[indexTipoUnidad],
    tipo_valor: "TEXTO",
    opciones: JSON.stringify(["Opcion ajena"]),
  };
  assert.match(migration.erroresDefinicionesIniciales(filtroAlterado).join(";"), /Filtro TIPO_UNIDAD/);

  const asociacionFaltante = filasDefinicionesIniciales();
  const servicio = catalogo.SERVICIOS[0].codigo;
  asociacionFaltante.asociacionesRows = asociacionFaltante.asociacionesRows.filter(
    (row, index) => row.servicio_codigo !== servicio || index !== asociacionFaltante.asociacionesRows.findIndex((item) => item.servicio_codigo === servicio)
  );
  assert.match(migration.erroresDefinicionesIniciales(asociacionFaltante).join(";"), new RegExp(`Filtros visibles de ${servicio}`));

  const asociacionExtra = filasDefinicionesIniciales();
  asociacionExtra.asociacionesRows.push({
    servicio_codigo: servicio,
    filtro_codigo: "FILTRO_USUARIO",
    mostrar_en_busqueda: 1,
    orden: 999,
  });
  assert.match(migration.erroresDefinicionesIniciales(asociacionExtra).join(";"), new RegExp(`Filtros visibles de ${servicio}`));
});

test("checksum es SHA-256 estable y el seed no inserta ni copia precios", () => {
  assert.equal(migration.MIGRATION_REVISION, 3);
  assert.match(migration.MIGRATION_CHECKSUM, /^[a-f0-9]{64}$/);
  assert.equal(migration.MIGRATION_CHECKSUM, require("../scripts/migrar-catalogo-turismo-v1").MIGRATION_CHECKSUM);
  const source = fs.readFileSync(require.resolve("../scripts/migrar-catalogo-turismo-v1"), "utf8");
  assert.doesNotMatch(source, /INSERT\s+INTO\s+tarifa\b/i);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+turismo_tarifa_regla\b/i);
  assert.match(source, /TARIFA_COLUMNAS_LEGACY/);
  assert.match(source, /se esperaban 181 tarifas legacy/);
  assert.match(source, /checksumFilas\(tarifas\)/);
  assert.match(source, /GET_LOCK/);
  assert.match(source, /ajb_turismo_catalogo_backup/);
  assert.match(source, /INSERT INTO recurso_cupo_periodo/);
  assert.match(source, /MIN\(parcelas_disponibles\)/);
  assert.match(source, /identidadesLegacyValidas/);
  assert.match(source, /columnasIncompatibles/);
  assert.match(source, /CHECKSUMS_ANTERIORES_PERMITIDOS/);
  assert.match(source, /if \(report\.aplicado\) postflight = await verificarPostflight\(connection, snapshot\)/);
  assert.match(source, /ajb_turismo_catalogo_backup b[\s\S]+CAST\(b\.fila_id AS UNSIGNED\)=t\.id/);
  assert.match(source, /DELETE FROM servicio_filtro WHERE servicio_id=\?/);
  assert.match(source, /DELETE FROM recurso_cupo_periodo WHERE recurso_id = \?/);
});

test("los cupos legacy se enlazan con la clave canonica de Miramar Camping", () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/migrar-catalogo-turismo-v1.js"), "utf8");
  assert.match(source, /recursos\.get\("MIRAMAR_CAMPING:CAMP-PARCELA"\)/);
  assert.doesNotMatch(source, /recursos\.get\("CAMPING:CAMP-PARCELA"\)/);
});

test("conversión de valores mantiene compatibilidad legacy y columnas tipadas", () => {
  assert.deepEqual(migration.filaFiltroTipado({ tipoValor: "NUMERO" }, 4), {
    cantidad: 4, habilitado: "Y", valorNumero: 4, valorBooleano: null, valorTexto: null,
  });
  assert.deepEqual(migration.filaFiltroTipado({ tipoValor: "BOOLEANO" }, true), {
    cantidad: 0, habilitado: "Y", valorNumero: null, valorBooleano: 1, valorTexto: null,
  });
  assert.deepEqual(migration.filaFiltroTipado({ tipoValor: "OPCION" }, "Cabaña"), {
    cantidad: 0, habilitado: "Y", valorNumero: null, valorBooleano: null, valorTexto: "Cabaña",
  });
});
