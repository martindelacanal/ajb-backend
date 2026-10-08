"use strict";

// Noticias por departamental: alcance (todas / algunas departamentales) en la redacción,
// serialización 3.1 y portal departamental del afiliado (/noticias/departamental*).

const test = require("node:test");
const assert = require("node:assert/strict");

// ── BD falsa (pool + conexión) inyectada antes de cargar el router ───────────
let conexionActual;
let consultarPool = async (sql) => {
  throw new Error(`Consulta de pool inesperada: ${sql}`);
};

const dbFalsa = {
  query(sql, params) {
    return consultarPool(sql, params);
  },
  async getConnection() {
    assert.ok(conexionActual, "la prueba debe configurar una conexión");
    return conexionActual;
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: { promise: () => dbFalsa },
};

const router = require("../api/routes/noticias");

const {
  CONDICION_ALCANCE_PORTAL,
  CONDICION_PORTAL,
  CONDICION_SOLO_DEPARTAMENTAL,
  MAX_DEPARTAMENTALES_NOTICIA,
  MENSAJE_ALCANCE_SIN_DEPARTAMENTALES,
  MENSAJE_DEPARTAMENTALES_INVALIDAS,
  MENSAJE_SOLO_AFILIADOS,
  cargarDepartamentalesDeNoticias,
  construirConsultaPortal,
  departamentalDeCabecera,
  departamentalHeredado,
  esAfiliadoDelPortal,
  normalizarAlcanceNoticia,
  normalizarDesdeResumen,
  normalizarListaDepartamentales,
  normalizarOrigenPortal,
  resumirDepartamentales,
  serializarAlcanceNoticia,
  validarDatosNoticia,
} = router.__test;

function obtenerHandlerFinal(metodo, ruta) {
  const capa = router.stack.find(
    (item) => item.route?.path === ruta && item.route.methods?.[metodo]
  );
  assert.ok(capa, `no se encontró ${metodo.toUpperCase()} ${ruta}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}

const getPortal = obtenerHandlerFinal("get", "/noticias/departamental");
const getResumen = obtenerHandlerFinal("get", "/noticias/departamental/resumen");
const getNoticiaPortal = obtenerHandlerFinal("get", "/noticias/departamental/:id(\\d+)");
const getAdminListado = obtenerHandlerFinal("get", "/admin/noticias");
const getAdminNoticia = obtenerHandlerFinal("get", "/admin/noticias/:id(\\d+)");
const getPublicas = obtenerHandlerFinal("get", "/noticias/publicas");
const getFiltrosPublicos = obtenerHandlerFinal("get", "/noticias/publicas/filtros");
const getNoticiaPublica = obtenerHandlerFinal("get", "/noticias/publicas/:id(\\d+)");
const postNoticia = obtenerHandlerFinal("post", "/admin/noticias");
const putNoticia = obtenerHandlerFinal("put", "/admin/noticias/:id(\\d+)");

const AFILIADO_LA_PLATA = Object.freeze({ id: 2, rol: "afiliado", departamental_id: 1 });
const AFILIADO_SIN_DEPARTAMENTAL = Object.freeze({ id: 40, rol: "afiliado", departamental_id: null });
const ADMIN = Object.freeze({ id: 1, rol: "admin" });

const normalizarSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

// Pool falso con reglas { si: RegExp, da: (params, sql) => resultado }. Registra todo.
function poolCon(reglas) {
  const consultas = [];
  consultarPool = async (sql, params = []) => {
    const texto = normalizarSql(sql);
    consultas.push({ sql: texto, params });
    const regla = reglas.find((item) => item.si.test(texto));
    if (!regla) throw new Error(`SQL inesperado: ${texto}`);
    return regla.da(params, texto);
  };
  return consultas;
}

function poolSinConsultas() {
  return poolCon([]);
}

function filaNoticia(datos = {}) {
  return {
    id: 1,
    titulo: "Noticia",
    bajada: "Bajada",
    categoria: "Gremial",
    alcance_todas: 1,
    destacada: 0,
    orden: 0,
    estado: "PUBLICADA",
    fecha_publicacion: new Date("2026-10-01T12:00:00Z"),
    fecha_creacion: new Date("2026-10-01T12:00:00Z"),
    fecha_modificacion: new Date("2026-10-01T12:00:00Z"),
    imagen_archivo: null,
    imagen_ancho: null,
    imagen_alto: null,
    imagen_mime: null,
    imagen_variantes: null,
    ...datos,
  };
}

const REGLA_PUENTE = (filasPorNoticia) => ({
  si: /FROM noticia_departamental nd INNER JOIN departamental d ON d\.id = nd\.departamental_id WHERE nd\.noticia_id IN/,
  da: (params) => [params.flatMap((noticiaId) => (filasPorNoticia[noticiaId] || []).map(
    (departamental) => ({ noticia_id: noticiaId, ...departamental })
  ))],
});

async function ejecutar(handler, {
  body = {},
  params = {},
  query = {},
  cabecera = AFILIADO_LA_PLATA,
} = {}) {
  let statusCode = 200;
  let respuesta;
  const headers = {};
  const req = {
    body,
    params,
    query,
    files: {},
    data: { data: JSON.stringify(cabecera) },
  };
  const res = {
    status(valor) {
      statusCode = valor;
      return this;
    },
    json(valor) {
      respuesta = valor;
      return this;
    },
    set(nombre, valor) {
      headers[nombre.toLowerCase()] = valor;
      return this;
    },
    removeHeader(nombre) {
      delete headers[nombre.toLowerCase()];
      return this;
    },
  };

  const consoleErrorOriginal = console.error;
  console.error = () => {};
  try {
    await handler(req, res);
  } finally {
    console.error = consoleErrorOriginal;
  }
  return { statusCode, respuesta, headers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de departamentales y alcance
// ─────────────────────────────────────────────────────────────────────────────

test("la lista de departamentales acepta JSON, CSV, campo repetido y número suelto", () => {
  assert.deepEqual(normalizarListaDepartamentales("[1,7,9]"), [1, 7, 9]);
  assert.deepEqual(normalizarListaDepartamentales(' ["3", "12"] '), [3, 12]);
  assert.deepEqual(normalizarListaDepartamentales('[{"id":4},{"id":9,"nombre":"Mar del Plata"}]'), [4, 9]);
  assert.deepEqual(normalizarListaDepartamentales("1,7,9"), [1, 7, 9]);
  assert.deepEqual(normalizarListaDepartamentales(" 1 , 7 "), [1, 7]);
  assert.deepEqual(normalizarListaDepartamentales(["1", "7"]), [1, 7]);
  assert.deepEqual(normalizarListaDepartamentales([5, "8"]), [5, 8]);
  assert.deepEqual(normalizarListaDepartamentales(5), [5]);
  assert.deepEqual(normalizarListaDepartamentales("[]"), []);
  assert.deepEqual(normalizarListaDepartamentales(""), []);
  assert.deepEqual(normalizarListaDepartamentales("   "), []);
  assert.deepEqual(normalizarListaDepartamentales(undefined), []);
  assert.deepEqual(normalizarListaDepartamentales(null), []);
});

test("la lista de departamentales rechaza ids inválidos, repetidos y excesos", () => {
  [
    "[1, 'x']",
    "[1,",
    '{"id":1}',
    '"1"',
    "1,,2",
    "1,a",
    "0",
    "-3",
    "1.5",
    "1;2",
    "1 OR 1=1",
    "1,1",
    '["1",1]',
    ["1", ""],
    [1, [2]],
    [{ id: "x" }],
    true,
    {},
  ].forEach((valor) => {
    assert.equal(normalizarListaDepartamentales(valor), null, `debería rechazar ${JSON.stringify(valor)}`);
  });

  const cincuenta = Array.from({ length: MAX_DEPARTAMENTALES_NOTICIA }, (_, indice) => indice + 1);
  assert.equal(MAX_DEPARTAMENTALES_NOTICIA, 50);
  assert.deepEqual(normalizarListaDepartamentales(JSON.stringify(cincuenta)), cincuenta);
  assert.equal(normalizarListaDepartamentales(JSON.stringify([...cincuenta, 51])), null);
  assert.equal(normalizarListaDepartamentales([...cincuenta, 51].join(",")), null);
});

test("alcance explícito: todas ignora la lista y algunas exige al menos una", () => {
  assert.deepEqual(normalizarAlcanceNoticia({ alcance_todas: "1", departamentales: "[1,7]" }).value, {
    alcanceTodas: 1,
    departamentales: [],
  });
  // Con «todas» una lista vieja mal formada no traba el guardado.
  assert.deepEqual(normalizarAlcanceNoticia({ alcance_todas: "1", departamentales: "basura" }).value, {
    alcanceTodas: 1,
    departamentales: [],
  });
  assert.deepEqual(normalizarAlcanceNoticia({ alcance_todas: "0", departamentales: "[9,1]" }).value, {
    alcanceTodas: 0,
    departamentales: [9, 1],
  });
  assert.deepEqual(normalizarAlcanceNoticia({ alcance_todas: false, departamentales: [3] }).value, {
    alcanceTodas: 0,
    departamentales: [3],
  });
  assert.deepEqual(normalizarAlcanceNoticia({ alcance_todas: true }).value, { alcanceTodas: 1, departamentales: [] });

  assert.equal(MENSAJE_ALCANCE_SIN_DEPARTAMENTALES, "Elegí al menos una departamental o marcá «Todas las departamentales»");
  assert.equal(MENSAJE_DEPARTAMENTALES_INVALIDAS, "Hay departamentales inválidas en el alcance");
  assert.equal(normalizarAlcanceNoticia({ alcance_todas: "0" }).error, MENSAJE_ALCANCE_SIN_DEPARTAMENTALES);
  assert.equal(normalizarAlcanceNoticia({ alcance_todas: "0", departamentales: "[]" }).error, MENSAJE_ALCANCE_SIN_DEPARTAMENTALES);
  assert.equal(normalizarAlcanceNoticia({ alcance_todas: "0", departamentales: "[1,1]" }).error, MENSAJE_DEPARTAMENTALES_INVALIDAS);
  assert.equal(normalizarAlcanceNoticia({ alcance_todas: "0", departamentales: "1,x" }).error, MENSAJE_DEPARTAMENTALES_INVALIDAS);
  assert.equal(normalizarAlcanceNoticia({ alcance_todas: "tal vez" }).error, "El alcance de la noticia es inválido");
  assert.equal(normalizarAlcanceNoticia({ alcance_todas: ["1", "0"] }).error, "El alcance de la noticia es inválido");
});

test("compatibilidad: sin alcance_todas se deriva de departamental_id", () => {
  assert.deepEqual(normalizarAlcanceNoticia({}).value, { alcanceTodas: 1, departamentales: [] });
  assert.deepEqual(normalizarAlcanceNoticia({ departamental_id: "" }).value, { alcanceTodas: 1, departamentales: [] });
  assert.deepEqual(normalizarAlcanceNoticia({ alcance_todas: "", departamental_id: "" }).value, {
    alcanceTodas: 1,
    departamentales: [],
  });
  assert.deepEqual(normalizarAlcanceNoticia({ departamental_id: "7" }).value, { alcanceTodas: 0, departamentales: [7] });
  assert.deepEqual(normalizarAlcanceNoticia({ departamental_id: 9 }).value, { alcanceTodas: 0, departamentales: [9] });
  assert.equal(normalizarAlcanceNoticia({ departamental_id: "abc" }).error, "La departamental es inválida");
  // Un cliente que manda sólo la lista (sin alcance_todas) no termina en «todas».
  assert.deepEqual(normalizarAlcanceNoticia({ departamentales: "1,7" }).value, { alcanceTodas: 0, departamentales: [1, 7] });
  assert.equal(normalizarAlcanceNoticia({ departamentales: "1,1" }).error, MENSAJE_DEPARTAMENTALES_INVALIDAS);
});

test("validarDatosNoticia sincroniza la columna heredada departamental_id", () => {
  const base = { titulo: "Título", categoria: "Gremial" };
  const una = validarDatosNoticia({ ...base, alcance_todas: "0", departamentales: "[13]" }).value;
  assert.equal(una.alcanceTodas, 0);
  assert.deepEqual(una.departamentales, [13]);
  assert.equal(una.departamentalId, 13);

  const dos = validarDatosNoticia({ ...base, alcance_todas: "0", departamentales: "[13,8]" }).value;
  assert.deepEqual(dos.departamentales, [13, 8]);
  assert.equal(dos.departamentalId, null);

  const todas = validarDatosNoticia({ ...base, alcance_todas: "1", departamentales: "[13]" }).value;
  assert.equal(todas.alcanceTodas, 1);
  assert.deepEqual(todas.departamentales, []);
  assert.equal(todas.departamentalId, null);

  assert.equal(validarDatosNoticia({ ...base, alcance_todas: "0" }).error, MENSAJE_ALCANCE_SIN_DEPARTAMENTALES);
  assert.equal(departamentalHeredado({ alcanceTodas: 1, departamentales: [4] }), null);
  assert.equal(departamentalHeredado({ alcanceTodas: 0, departamentales: [4] }), 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// Serialización 3.1
// ─────────────────────────────────────────────────────────────────────────────

test("el resumen de departamentales cubre 0, 1, 2 y 3 o más", () => {
  assert.equal(resumirDepartamentales([]), null);
  assert.equal(resumirDepartamentales(undefined), null);
  assert.equal(resumirDepartamentales([{ id: 1, nombre: "La Plata" }]), "La Plata");
  assert.equal(resumirDepartamentales([{ id: 8, nombre: "Azul" }, { id: 1, nombre: "La Plata" }]), "Azul y La Plata");
  assert.equal(
    resumirDepartamentales([{ id: 8, nombre: "Azul" }, { id: 1, nombre: "La Plata" }, { id: 9, nombre: "Mar del Plata" }]),
    "3 departamentales"
  );
  assert.equal(resumirDepartamentales(Array.from({ length: 7 }, (_, i) => ({ id: i + 1, nombre: `D${i}` }))), "7 departamentales");
});

test("serializar el alcance: todas vacía la lista y algunas ordena alfabéticamente en español", () => {
  assert.deepEqual(serializarAlcanceNoticia(1, [{ id: 1, nombre: "La Plata" }]), {
    alcance_todas: true,
    departamentales: [],
    departamental_id: null,
    departamental_nombre: null,
  });

  const una = serializarAlcanceNoticia(0, [{ id: "19", nombre: "Moreno-Gral. Rodríguez" }]);
  assert.deepEqual(una, {
    alcance_todas: false,
    departamentales: [{ id: 19, nombre: "Moreno-Gral. Rodríguez" }],
    departamental_id: 19,
    departamental_nombre: "Moreno-Gral. Rodríguez",
  });

  const dos = serializarAlcanceNoticia("0", [{ id: 16, nombre: "Morón" }, { id: 13, nombre: "Avellaneda-Lanús" }]);
  assert.deepEqual(dos.departamentales.map((d) => d.nombre), ["Avellaneda-Lanús", "Morón"]);
  assert.equal(dos.departamental_id, null);
  assert.equal(dos.departamental_nombre, "Avellaneda-Lanús y Morón");

  const tres = serializarAlcanceNoticia(0, [
    { id: 20, nombre: "Zárate-Campana" },
    { id: 22, nombre: "Trenque Lauquen" },
    { id: 17, nombre: "Gral. San Martín" },
  ]);
  assert.deepEqual(tres.departamentales.map((d) => d.id), [17, 22, 20]);
  assert.equal(tres.departamental_nombre, "3 departamentales");
  assert.equal(tres.departamental_id, null);
});

test("las departamentales de una lista salen en UNA consulta y se omiten las de todas", async () => {
  const consultas = poolCon([REGLA_PUENTE({
    5: [{ id: 9, nombre: "Mar del Plata" }, { id: 1, nombre: "La Plata" }],
    6: [{ id: 7, nombre: "Bahía Blanca" }],
  })]);

  const mapa = await cargarDepartamentalesDeNoticias(dbFalsa, [
    filaNoticia({ id: 4, alcance_todas: 1 }),
    filaNoticia({ id: 5, alcance_todas: 0 }),
    filaNoticia({ id: 6, alcance_todas: 0 }),
    filaNoticia({ id: 5, alcance_todas: 0 }),
  ]);

  assert.equal(consultas.length, 1);
  assert.deepEqual(consultas[0].params, [5, 6]);
  assert.match(consultas[0].sql, /WHERE nd\.noticia_id IN \(\?,\?\)$/);
  assert.deepEqual(mapa.get(5).map((d) => d.id), [9, 1]);
  assert.deepEqual(mapa.get(6), [{ id: 7, nombre: "Bahía Blanca" }]);
  assert.equal(mapa.has(4), false);

  const sinConsultas = poolSinConsultas();
  const vacio = await cargarDepartamentalesDeNoticias(dbFalsa, [filaNoticia({ id: 8, alcance_todas: 1 })]);
  assert.equal(vacio.size, 0);
  assert.equal(sinConsultas.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Portal del afiliado: autorización y consultas
// ─────────────────────────────────────────────────────────────────────────────

test("sólo el rol afiliado (no el familiar invitado) entra al portal", () => {
  assert.equal(esAfiliadoDelPortal({ rol: "afiliado", departamental_id: 1 }), true);
  ["admin", "prensa", "departamental", "admin-central", "invitado", undefined].forEach((rol) => {
    assert.equal(esAfiliadoDelPortal({ rol }), false, `el rol ${rol} no debe ver el portal`);
  });
  assert.equal(esAfiliadoDelPortal({ rol: "afiliado", acceso_familiar_turismo: true }), false);
  assert.equal(esAfiliadoDelPortal(null), false);

  assert.equal(departamentalDeCabecera({ departamental_id: 13 }), 13);
  assert.equal(departamentalDeCabecera({ departamental_id: "7" }), 7);
  assert.equal(departamentalDeCabecera({ departamental_id: null }), 0);
  assert.equal(departamentalDeCabecera({}), 0);
});

for (const [nombre, handler, params] of [
  ["listado", getPortal, {}],
  ["resumen", getResumen, {}],
  ["lectura", getNoticiaPortal, { id: "9" }],
]) {
  test(`el ${nombre} del portal responde 403 a quien no es afiliado, sin consultar la base`, async () => {
    for (const cabecera of [
      ADMIN,
      { id: 5, rol: "prensa" },
      { id: 3, rol: "departamental", departamental_id: 1 },
      { id: 50, rol: "afiliado", departamental_id: 1, acceso_familiar_turismo: true },
    ]) {
      const consultas = poolSinConsultas();
      const resultado = await ejecutar(handler, { cabecera, params });
      assert.equal(resultado.statusCode, 403, `rol ${cabecera.rol}`);
      assert.equal(resultado.respuesta, MENSAJE_SOLO_AFILIADOS);
      assert.equal(resultado.headers["cache-control"], "private, no-store");
      assert.equal(consultas.length, 0);
    }
  });
}

test("la visibilidad del portal combina lo publicado con todas + la departamental del afiliado", () => {
  assert.match(CONDICION_PORTAL, /n\.eliminado = 0 AND n\.estado = 'PUBLICADA' AND \(n\.fecha_publicacion IS NULL OR n\.fecha_publicacion <= NOW\(\)\)/);
  assert.match(
    CONDICION_ALCANCE_PORTAL,
    /^\(n\.alcance_todas = 1 OR EXISTS \(SELECT 1 FROM noticia_departamental nd WHERE nd\.noticia_id = n\.id AND nd\.departamental_id = \?\)\)$/
  );
  assert.ok(CONDICION_PORTAL.endsWith(CONDICION_ALCANCE_PORTAL));

  const conDepartamental = construirConsultaPortal({ departamentalId: 1 });
  assert.equal(conDepartamental.where, CONDICION_PORTAL);
  assert.deepEqual(conDepartamental.params, [1]);

  // Sin departamental se consulta con 0: sólo matchean las de todas.
  const sinDepartamental = construirConsultaPortal({});
  assert.deepEqual(sinDepartamental.params, [0]);

  const completa = construirConsultaPortal({
    departamentalId: 7,
    origen: "propias",
    categoria: "Gremial",
    busqueda: "paritaria",
    idsExcluidos: [3, 4],
  });
  assert.equal(
    completa.where,
    `${CONDICION_PORTAL} AND n.alcance_todas = 0 AND n.categoria = ? AND (n.titulo LIKE ? OR n.bajada LIKE ?) AND n.id NOT IN (?,?)`
  );
  assert.deepEqual(completa.params, [7, "Gremial", "%paritaria%", "%paritaria%", 3, 4]);
  assert.match(construirConsultaPortal({ departamentalId: 7, origen: "generales" }).where, / AND n\.alcance_todas = 1$/);

  assert.deepEqual(normalizarOrigenPortal(undefined), { value: null });
  assert.deepEqual(normalizarOrigenPortal(""), { value: null });
  assert.deepEqual(normalizarOrigenPortal("todas"), { value: null });
  assert.deepEqual(normalizarOrigenPortal("Propias"), { value: "propias" });
  assert.deepEqual(normalizarOrigenPortal("generales"), { value: "generales" });
  assert.equal(normalizarOrigenPortal("ajenas").error, "El origen de las noticias es inválido");
  assert.equal(normalizarOrigenPortal(["propias"]).error, "El origen de las noticias es inválido");
});

function reglasPortal({
  departamental = { id: 1, nombre: "La Plata", direccion: "Calle 55 Nº 910 e/ 13 y 14", localidad: "La Plata", lat: -34.924, lng: -57.953 },
  filas = [],
  totalItems = filas.length,
  conteos = { todas: 0, propias: 0, generales: 0 },
  categorias = [],
  puente = {},
} = {}) {
  return [
    { si: /FROM departamental d WHERE d\.id = \? LIMIT 1$/, da: () => [departamental ? [departamental] : []] },
    { si: /AS totalItems FROM noticia n WHERE/, da: () => [[{ totalItems }]] },
    { si: /COUNT\(\*\) AS todas/, da: () => [[conteos]] },
    { si: /GROUP BY n\.categoria/, da: () => [categorias] },
    REGLA_PUENTE(puente),
    { si: /ORDER BY .* LIMIT \? OFFSET \?$/, da: () => [filas] },
  ];
}

test("el listado del portal arma la respuesta con departamental, marcas, conteos y categorías", async () => {
  const consultas = poolCon(reglasPortal({
    filas: [
      filaNoticia({ id: 9, titulo: "Gran jornada patria en el Predio Malvinas Argentinas", categoria: "Departamentales", alcance_todas: 0 }),
      filaNoticia({ id: 1, titulo: "Nueva recomposición salarial", categoria: "Salario", alcance_todas: 1 }),
      filaNoticia({ id: 30, titulo: "Para La Plata y Azul", alcance_todas: 0 }),
    ],
    totalItems: 12,
    conteos: { todas: 12, propias: "2", generales: "10" },
    categorias: [{ categoria: "Gremial", total: 3 }, { categoria: "Salario", total: "2" }],
    puente: {
      9: [{ id: 1, nombre: "La Plata" }],
      30: [{ id: 8, nombre: "Azul" }, { id: 1, nombre: "La Plata" }],
    },
  }));

  const resultado = await ejecutar(getPortal);

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.headers["cache-control"], "private, no-store");
  const cuerpo = resultado.respuesta;
  assert.deepEqual(cuerpo.departamental, {
    id: 1,
    nombre: "La Plata",
    direccion: "Calle 55 Nº 910 e/ 13 y 14",
    localidad: "La Plata",
    lat: -34.924,
    lng: -57.953,
  });
  assert.equal(cuerpo.totalItems, 12);
  assert.equal(cuerpo.page, 1);
  assert.equal(cuerpo.pageSize, 9);
  assert.deepEqual(cuerpo.conteos, { todas: 12, propias: 2, generales: 10 });
  assert.deepEqual(cuerpo.categorias, [{ categoria: "Gremial", total: 3 }, { categoria: "Salario", total: 2 }]);

  assert.deepEqual(cuerpo.results.map((n) => [n.id, n.para_mi_departamental]), [[9, true], [1, false], [30, true]]);
  const [propia, general, compartida] = cuerpo.results;
  assert.equal(propia.alcance_todas, false);
  assert.equal(propia.departamental_id, 1);
  assert.equal(propia.departamental_nombre, "La Plata");
  assert.equal(general.alcance_todas, true);
  assert.deepEqual(general.departamentales, []);
  assert.equal(general.departamental_nombre, null);
  assert.equal(compartida.departamental_nombre, "Azul y La Plata");
  assert.equal(compartida.departamental_id, null);
  assert.equal("cuerpo" in propia, false);

  // Parámetros: la departamental de la cabecera en todas las consultas de visibilidad.
  const porSql = (patron) => consultas.filter((consulta) => patron.test(consulta.sql));
  assert.deepEqual(porSql(/FROM departamental d WHERE d\.id = \?/)[0].params, [1]);
  assert.match(porSql(/FROM departamental d WHERE d\.id = \?/)[0].sql, /ST_Y\(d\.coordenadas\) AS lat, ST_X\(d\.coordenadas\) AS lng/);
  assert.deepEqual(porSql(/AS totalItems/)[0].params, [1]);
  assert.deepEqual(porSql(/LIMIT \? OFFSET \?$/)[0].params, [1, 9, 0]);
  assert.match(porSql(/LIMIT \? OFFSET \?$/)[0].sql, /ORDER BY n\.orden DESC, COALESCE\(n\.fecha_publicacion, n\.fecha_creacion\) DESC, n\.id DESC/);
  assert.deepEqual(porSql(/COUNT\(\*\) AS todas/)[0].params, [1]);
  assert.deepEqual(porSql(/GROUP BY n\.categoria/)[0].params, [1]);
  assert.match(porSql(/GROUP BY n\.categoria/)[0].sql, /ORDER BY total DESC, n\.categoria ASC$/);
  // Una sola consulta de departamentales, sólo para las noticias específicas.
  const puente = porSql(/FROM noticia_departamental nd INNER JOIN/);
  assert.equal(puente.length, 1);
  assert.deepEqual(puente[0].params, [9, 30]);
});

test("el listado del portal aplica origen, categoría, búsqueda, exclusiones y paginación", async () => {
  const consultas = poolCon(reglasPortal());

  const resultado = await ejecutar(getPortal, {
    query: { origen: "propias", categoria: "Gremial", q: "autarquía", exclude_ids: "4,5", page: "2", pageSize: "3" },
  });

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.respuesta.page, 2);
  assert.equal(resultado.respuesta.pageSize, 3);
  const listado = consultas.find((consulta) => /LIMIT \? OFFSET \?$/.test(consulta.sql));
  assert.match(listado.sql, /AND n\.alcance_todas = 0 AND n\.categoria = \? AND \(n\.titulo LIKE \? OR n\.bajada LIKE \?\) AND n\.id NOT IN \(\?,\?\)/);
  assert.deepEqual(listado.params, [1, "Gremial", "%autarquía%", "%autarquía%", 4, 5, 3, 3]);
  // Conteos y categorías no llevan los filtros de la vista.
  const conteos = consultas.find((consulta) => /COUNT\(\*\) AS todas/.test(consulta.sql));
  assert.doesNotMatch(conteos.sql, /n\.categoria = \?|LIKE|NOT IN|n\.alcance_todas = 0 AND n\.categoria/);

  const generales = poolCon(reglasPortal());
  await ejecutar(getPortal, { query: { origen: "generales" } });
  assert.match(generales.find((consulta) => /LIMIT \? OFFSET \?$/.test(consulta.sql)).sql, /AND n\.alcance_todas = 1 ORDER BY/);
});

test("el portal de un afiliado sin departamental muestra sólo las de toda la AJB", async () => {
  const consultas = poolCon(reglasPortal({
    filas: [filaNoticia({ id: 1, alcance_todas: 1 })],
    conteos: { todas: 1, propias: 0, generales: 1 },
  }));

  const resultado = await ejecutar(getPortal, { cabecera: AFILIADO_SIN_DEPARTAMENTAL });

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.respuesta.departamental, null);
  assert.equal(resultado.respuesta.results[0].para_mi_departamental, false);
  assert.equal(consultas.some((consulta) => /FROM departamental d WHERE d\.id = \?/.test(consulta.sql)), false);
  consultas.forEach((consulta) => assert.equal(consulta.params[0], 0, consulta.sql));
});

test("la sede sin coordenadas (o en 0,0) sale con lat/lng nulos", async () => {
  poolCon(reglasPortal({ departamental: { id: 3, nombre: "Provincia", direccion: "Calle 49 entre 4 y 5", localidad: "La Plata", lat: null, lng: null } }));
  const sinCoordenadas = await ejecutar(getPortal, { cabecera: { ...AFILIADO_LA_PLATA, departamental_id: 3 } });
  assert.deepEqual(sinCoordenadas.respuesta.departamental, {
    id: 3, nombre: "Provincia", direccion: "Calle 49 entre 4 y 5", localidad: "La Plata", lat: null, lng: null,
  });

  poolCon(reglasPortal({ departamental: { id: 4, nombre: "Mercedes", direccion: null, localidad: null, lat: 0, lng: 0 } }));
  const enCero = await ejecutar(getPortal, { cabecera: { ...AFILIADO_LA_PLATA, departamental_id: 4 } });
  assert.equal(enCero.respuesta.departamental.lat, null);
  assert.equal(enCero.respuesta.departamental.lng, null);
});

test("el listado del portal valida origen, página y exclusiones", async () => {
  for (const [query, mensaje] of [
    [{ origen: "ajenas" }, "El origen de las noticias es inválido"],
    [{ pageSize: "31" }, "La paginación es inválida"],
    [{ page: "0" }, "La paginación es inválida"],
    [{ exclude_ids: "1,2,3,4,5,6" }, "Los IDs excluidos son inválidos"],
    [{ exclude_ids: "1,x" }, "Los IDs excluidos son inválidos"],
  ]) {
    const consultas = poolSinConsultas();
    const resultado = await ejecutar(getPortal, { query });
    assert.equal(resultado.statusCode, 400, JSON.stringify(query));
    assert.equal(resultado.respuesta, mensaje);
    assert.equal(consultas.length, 0);
  }

  poolCon(reglasPortal());
  const maximo = await ejecutar(getPortal, { query: { pageSize: "30" } });
  assert.equal(maximo.statusCode, 200);
  assert.equal(maximo.respuesta.pageSize, 30);
});

test("la lectura del portal devuelve cuerpo, galería y la marca de su departamental", async () => {
  const consultas = poolCon([
    {
      si: /n\.cuerpo FROM noticia n WHERE/,
      da: () => [[filaNoticia({ id: 9, alcance_todas: 0, cuerpo: "<p>Hola</p>" })]],
    },
    REGLA_PUENTE({ 9: [{ id: 1, nombre: "La Plata" }] }),
    {
      si: /FROM noticia_imagen WHERE noticia_id = \?/,
      da: () => [[{ id: 4, archivo: null, epigrafe: "Acto", orden: 0 }]],
    },
  ]);

  const resultado = await ejecutar(getNoticiaPortal, { params: { id: "9" } });

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.headers["cache-control"], "private, no-store");
  assert.equal(resultado.respuesta.id, 9);
  assert.equal(resultado.respuesta.cuerpo, "<p>Hola</p>");
  assert.equal(resultado.respuesta.para_mi_departamental, true);
  assert.equal(resultado.respuesta.departamental_nombre, "La Plata");
  assert.equal(resultado.respuesta.galeria.length, 1);
  assert.equal("relacionadas" in resultado.respuesta, false);
  const lectura = consultas.find((consulta) => /n\.cuerpo FROM noticia n/.test(consulta.sql));
  assert.ok(lectura.sql.includes(`WHERE ${CONDICION_PORTAL} AND n.id = ?`));
  assert.deepEqual(lectura.params, [1, 9]);
});

test("la lectura del portal responde 404 si la noticia no es visible para su departamental", async () => {
  const consultas = poolCon([{ si: /n\.cuerpo FROM noticia n WHERE/, da: () => [[]] }]);

  const resultado = await ejecutar(getNoticiaPortal, {
    params: { id: "10" },
    cabecera: AFILIADO_SIN_DEPARTAMENTAL,
  });

  assert.equal(resultado.statusCode, 404);
  assert.equal(resultado.respuesta, "Noticia no encontrada");
  assert.equal(consultas.length, 1);
  assert.deepEqual(consultas[0].params, [0, 10]);
});

test("el resumen cuenta lo visible publicado después de 'desde' con tope 99", async () => {
  let consultas = poolCon([{ si: /AS nuevas/, da: () => [[{ nuevas: 3 }]] }]);
  const valido = await ejecutar(getResumen, { query: { desde: "2026-10-01T12:00:00.000Z" } });
  assert.equal(valido.statusCode, 200);
  assert.equal(valido.headers["cache-control"], "private, no-store");
  assert.deepEqual(valido.respuesta, { nuevas: 3 });
  assert.equal(consultas.length, 1);
  assert.ok(consultas[0].sql.includes(`WHERE ${CONDICION_PORTAL} AND COALESCE(n.fecha_publicacion, n.fecha_creacion) > ?`));
  assert.match(consultas[0].sql, /LIMIT 99 \) AS recientes$/);
  assert.equal(consultas[0].params[0], 1);
  assert.equal(consultas[0].params[1].toISOString(), "2026-10-01T12:00:00.000Z");

  consultas = poolCon([{ si: /AS nuevas/, da: () => [[{ nuevas: 150 }]] }]);
  const antes = Date.now();
  const invalido = await ejecutar(getResumen, { query: { desde: "ayer" }, cabecera: AFILIADO_SIN_DEPARTAMENTAL });
  assert.deepEqual(invalido.respuesta, { nuevas: 99 });
  assert.equal(consultas[0].params[0], 0);
  const catorceDias = 14 * 24 * 60 * 60 * 1000;
  const desdeUsado = consultas[0].params[1].getTime();
  assert.ok(desdeUsado >= antes - catorceDias - 1000 && desdeUsado <= Date.now() - catorceDias + 1000);
});

test("'desde' admite ISO 8601 con zona, sin zona (hora argentina) y cae a 14 días si es inválido", () => {
  const ahora = new Date("2026-10-08T15:00:00.000Z");
  const porDefecto = "2026-09-24T15:00:00.000Z";
  const casos = [
    ["2026-10-01T12:00:00Z", "2026-10-01T12:00:00.000Z"],
    ["2026-10-01T12:00:00.123456Z", "2026-10-01T12:00:00.123Z"],
    ["2026-10-01T09:30:00-03:00", "2026-10-01T12:30:00.000Z"],
    ["2026-10-01T09:30:00+0100", "2026-10-01T08:30:00.000Z"],
    ["2026-10-01T09:30", "2026-10-01T12:30:00.000Z"],
    ["2026-10-01", "2026-10-01T03:00:00.000Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
    [undefined, porDefecto],
    ["", porDefecto],
    ["ayer", porDefecto],
    ["2026-02-30T00:00:00Z", porDefecto],
    ["2026-13-01", porDefecto],
    ["2026-10-01T24:00:00Z", porDefecto],
    ["1969-12-31T23:59:59Z", porDefecto],
    ["2026-10-01T12:00:00+15:00", porDefecto],
    [["2026-10-01"], porDefecto],
    [1759320000000, porDefecto],
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(normalizarDesdeResumen(entrada, ahora).toISOString(), esperado, `desde=${JSON.stringify(entrada)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Panel de la redacción y portada pública
// ─────────────────────────────────────────────────────────────────────────────

test("el listado del panel filtra por 'se ve en' y serializa con una sola consulta de departamentales", async () => {
  const consultas = poolCon([
    { si: /AS totalItems FROM noticia n WHERE/, da: () => [[{ totalItems: 2 }]] },
    {
      si: /LEFT JOIN usuario u ON u\.id = n\.creado_por_usuario_id WHERE .* LIMIT \? OFFSET \?$/,
      da: () => [[
        filaNoticia({ id: 10, alcance_todas: 0, autor_nombre: "Ana", autor_apellido: "Pérez" }),
        filaNoticia({ id: 11, alcance_todas: 1, autor_nombre: "Ana", autor_apellido: "Pérez" }),
      ]],
    },
    { si: /GROUP BY n\.estado$/, da: () => [[{ estado: "PUBLICADA", total: 2, destacadas: 0 }]] },
    REGLA_PUENTE({ 10: [{ id: 7, nombre: "Bahía Blanca" }, { id: 1, nombre: "La Plata" }, { id: 8, nombre: "Azul" }] }),
  ]);

  const resultado = await ejecutar(getAdminListado, { cabecera: ADMIN, query: { visible_en: "7", estado: "PUBLICADA" } });

  assert.equal(resultado.statusCode, 200);
  const listado = consultas.find((consulta) => /LIMIT \? OFFSET \?$/.test(consulta.sql));
  assert.ok(listado.sql.includes(`n.eliminado = 0 AND n.estado = ? AND ${CONDICION_ALCANCE_PORTAL}`));
  assert.deepEqual(listado.params, ["PUBLICADA", 7, 10, 0]);
  assert.equal(consultas.filter((consulta) => /FROM noticia_departamental nd INNER JOIN/.test(consulta.sql)).length, 1);
  assert.doesNotMatch(listado.sql, /LEFT JOIN departamental/);

  const [especifica, general] = resultado.respuesta.results;
  assert.deepEqual(especifica.departamentales.map((d) => d.nombre), ["Azul", "Bahía Blanca", "La Plata"]);
  assert.equal(especifica.departamental_nombre, "3 departamentales");
  assert.equal(especifica.alcance_todas, false);
  assert.equal(especifica.autor, "Ana Pérez");
  assert.equal(general.alcance_todas, true);
  assert.equal(general.departamental_nombre, null);

  const invalido = await ejecutar(getAdminListado, { cabecera: ADMIN, query: { visible_en: "abc" } });
  assert.equal(invalido.statusCode, 400);
  assert.equal(invalido.respuesta, "La departamental del filtro es inválida");
});

test("el detalle del panel devuelve el alcance completo", async () => {
  poolCon([
    {
      si: /n\.cuerpo, u\.nombre AS autor_nombre/,
      da: () => [[filaNoticia({ id: 12, alcance_todas: 0, cuerpo: "<p>x</p>", autor_nombre: null, autor_apellido: null })]],
    },
    REGLA_PUENTE({ 12: [{ id: 9, nombre: "Mar del Plata" }] }),
    { si: /FROM noticia_imagen/, da: () => [[]] },
  ]);

  const resultado = await ejecutar(getAdminNoticia, { cabecera: ADMIN, params: { id: "12" } });

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.respuesta.alcance_todas, false);
  assert.deepEqual(resultado.respuesta.departamentales, [{ id: 9, nombre: "Mar del Plata" }]);
  assert.equal(resultado.respuesta.departamental_id, 9);
  assert.equal(resultado.respuesta.departamental_nombre, "Mar del Plata");
  assert.deepEqual(resultado.respuesta.galeria, []);
});

test("la portada pública filtra por departamental con la tabla puente", async () => {
  const consultas = poolCon([
    { si: /AS totalItems FROM noticia n WHERE/, da: () => [[{ totalItems: 1 }]] },
    { si: /LIMIT \? OFFSET \?$/, da: () => [[filaNoticia({ id: 9, alcance_todas: 0 })]] },
    REGLA_PUENTE({ 9: [{ id: 1, nombre: "La Plata" }] }),
  ]);

  const resultado = await ejecutar(getPublicas, { query: { departamental_id: "1" } });

  assert.equal(resultado.statusCode, 200);
  const listado = consultas.find((consulta) => /LIMIT \? OFFSET \?$/.test(consulta.sql));
  assert.ok(listado.sql.includes(CONDICION_SOLO_DEPARTAMENTAL));
  assert.doesNotMatch(listado.sql, /n\.departamental_id = \?/);
  assert.deepEqual(listado.params, [1, 9, 0]);
  assert.equal(resultado.respuesta.results[0].departamental_nombre, "La Plata");
});

test("los filtros públicos cuentan por departamental sólo las noticias elegidas para ella", async () => {
  const consultas = poolCon([
    { si: /GROUP BY n\.categoria/, da: () => [[{ categoria: "Gremial", total: 2 }]] },
    { si: /FROM departamental d INNER JOIN noticia_departamental nd/, da: () => [[{ id: 1, nombre: "La Plata", total: "1" }]] },
  ]);

  const resultado = await ejecutar(getFiltrosPublicos);

  assert.equal(resultado.statusCode, 200);
  assert.deepEqual(resultado.respuesta.departamentales, [{ id: 1, nombre: "La Plata", total: 1 }]);
  const departamentales = consultas.find((consulta) => /noticia_departamental/.test(consulta.sql));
  assert.match(departamentales.sql, /INNER JOIN noticia n ON n\.id = nd\.noticia_id AND n\.alcance_todas = 0 AND n\.eliminado = 0/);
});

test("la noticia pública y sus relacionadas cargan las departamentales en una sola consulta", async () => {
  const consultas = poolCon([
    { si: /n\.cuerpo FROM noticia n WHERE/, da: () => [[filaNoticia({ id: 9, alcance_todas: 0, categoria: "Departamentales", cuerpo: "<p>x</p>" })]] },
    { si: /FROM noticia_imagen/, da: () => [[]] },
    {
      si: /n\.id <> \? AND n\.categoria = \?/,
      da: () => [[filaNoticia({ id: 8, alcance_todas: 0, categoria: "Departamentales" }), filaNoticia({ id: 2, alcance_todas: 1 })]],
    },
    REGLA_PUENTE({ 9: [{ id: 1, nombre: "La Plata" }], 8: [{ id: 9, nombre: "Mar del Plata" }] }),
  ]);

  const resultado = await ejecutar(getNoticiaPublica, { params: { id: "9" } });

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.respuesta.departamental_nombre, "La Plata");
  assert.deepEqual(resultado.respuesta.relacionadas.map((n) => n.departamental_nombre), ["Mar del Plata", null]);
  const puente = consultas.filter((consulta) => /FROM noticia_departamental nd INNER JOIN/.test(consulta.sql));
  assert.equal(puente.length, 1);
  assert.deepEqual(puente[0].params, [9, 8]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Escritura: POST / PUT dentro de la transacción
// ─────────────────────────────────────────────────────────────────────────────

// `noticia` suma campos a la fila guardada (p. ej. su alcance) y `puente`, sus departamentales.
function crearConexion({ noticiaId = 23, insertId = 71, fallarEn = null, noticia = {}, puente = [] } = {}) {
  const eventos = [];
  const consultas = [];
  return {
    eventos,
    consultas,
    async query(sql, params = []) {
      const texto = normalizarSql(sql);
      consultas.push({ sql: texto, params });
      if (fallarEn && fallarEn.test(texto)) {
        eventos.push("falla");
        throw new Error("falla simulada");
      }
      if (texto.includes("GET_LOCK")) {
        eventos.push("get_lock");
        return [[{ adquirido: 1 }]];
      }
      if (texto.includes("RELEASE_LOCK")) {
        eventos.push("release_lock");
        return [[{ liberado: 1 }]];
      }
      if (/^SELECT \* FROM noticia WHERE id = \?/.test(texto)) {
        eventos.push("select_noticia");
        return [[{ id: noticiaId, destacada: 0, fecha_publicacion: null, imagen_archivo: null, ...noticia }]];
      }
      if (/^SELECT departamental_id FROM noticia_departamental WHERE noticia_id = \?$/.test(texto)) {
        eventos.push("select_puente");
        return [puente.map((departamentalId) => ({ departamental_id: departamentalId }))];
      }
      if (/^INSERT INTO noticia \(/.test(texto)) {
        eventos.push("insert_noticia");
        return [{ insertId }];
      }
      if (/^UPDATE noticia SET/.test(texto)) {
        eventos.push("update_noticia");
        return [{ affectedRows: 1 }];
      }
      if (/^DELETE FROM noticia_departamental WHERE noticia_id = \?$/.test(texto)) {
        eventos.push("delete_puente");
        return [{ affectedRows: 2 }];
      }
      if (/^INSERT INTO noticia_departamental \(noticia_id, departamental_id\) VALUES/.test(texto)) {
        eventos.push("insert_puente");
        return [{ affectedRows: params.length / 2 }];
      }
      throw new Error(`SQL inesperado: ${texto}`);
    },
    async beginTransaction() {
      eventos.push("begin");
    },
    async commit() {
      eventos.push("commit");
    },
    async rollback() {
      eventos.push("rollback");
    },
    release() {
      eventos.push("release");
    },
    destroy() {
      eventos.push("destroy");
    },
  };
}

const BODY_BASE = Object.freeze({
  titulo: "Convenio con la Cruz Roja para capacitaciones en primeros auxilios",
  categoria: "Departamentales",
  estado: "BORRADOR",
  destacada: "0",
  orden: "0",
  cuerpo: "",
  fecha_publicacion: "",
});

// Validación de existencia: devuelve como válidas las de `validas`.
function poolValidacion(validas) {
  return poolCon([{
    si: /^SELECT d\.id FROM departamental d WHERE d\.id IN/,
    da: (params) => [params.filter((id) => validas.includes(id)).map((id) => ({ id }))],
  }]);
}

const paramsInsertNoticia = (conexion) => conexion.consultas.find((c) => /^INSERT INTO noticia \(/.test(c.sql));
const paramsUpdateNoticia = (conexion) => conexion.consultas.find((c) => /^UPDATE noticia SET/.test(c.sql));
const insertPuente = (conexion) => conexion.consultas.find((c) => /^INSERT INTO noticia_departamental/.test(c.sql));

test("POST guarda el alcance en la transacción: noticia + filas puente antes del commit", async () => {
  const pool = poolValidacion([7, 1]);
  conexionActual = crearConexion();

  const resultado = await ejecutar(postNoticia, {
    cabecera: ADMIN,
    body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[7,1]" },
  });

  assert.equal(resultado.statusCode, 201);
  assert.equal(resultado.respuesta.id, 71);
  assert.deepEqual(conexionActual.eventos, ["begin", "insert_noticia", "insert_puente", "commit", "release"]);
  const insert = paramsInsertNoticia(conexionActual);
  assert.match(insert.sql, /\(titulo, bajada, cuerpo, categoria, alcance_todas, departamental_id,/);
  assert.deepEqual(insert.params.slice(4, 6), [0, null]);
  assert.equal(insert.params.length, 17);
  assert.match(insert.sql, /VALUES \((\?, ){16}\?\)$/);
  // Sin el dato, una noticia nueva sale en la portada pública (último parámetro).
  assert.equal(insert.params[16], 1);
  const puente = insertPuente(conexionActual);
  assert.match(puente.sql, /VALUES \(\?, \?\), \(\?, \?\)$/);
  assert.deepEqual(puente.params, [71, 7, 71, 1]);
  // Validación de existencia: sólo departamentales habilitadas al crear.
  assert.equal(pool.length, 1);
  assert.match(pool[0].sql, /WHERE d\.id IN \(\?,\?\) AND d\.habilitado = 'Y'$/);
  assert.deepEqual(pool[0].params, [7, 1]);
});

test("POST con una sola departamental sincroniza departamental_id; con todas no toca la tabla puente", async () => {
  poolValidacion([13]);
  conexionActual = crearConexion();
  const una = await ejecutar(postNoticia, { cabecera: ADMIN, body: { ...BODY_BASE, alcance_todas: "0", departamentales: "13" } });
  assert.equal(una.statusCode, 201);
  assert.deepEqual(paramsInsertNoticia(conexionActual).params.slice(4, 6), [0, 13]);
  assert.deepEqual(insertPuente(conexionActual).params, [71, 13]);

  const sinConsultas = poolSinConsultas();
  conexionActual = crearConexion();
  const todas = await ejecutar(postNoticia, { cabecera: ADMIN, body: { ...BODY_BASE, alcance_todas: "1" } });
  assert.equal(todas.statusCode, 201);
  assert.deepEqual(conexionActual.eventos, ["begin", "insert_noticia", "commit", "release"]);
  assert.deepEqual(paramsInsertNoticia(conexionActual).params.slice(4, 6), [1, null]);
  assert.equal(sinConsultas.length, 0);

  // Editor anterior: sólo departamental_id.
  poolValidacion([9]);
  conexionActual = crearConexion();
  const compat = await ejecutar(postNoticia, { cabecera: ADMIN, body: { ...BODY_BASE, departamental_id: "9" } });
  assert.equal(compat.statusCode, 201);
  assert.deepEqual(paramsInsertNoticia(conexionActual).params.slice(4, 6), [0, 9]);
  assert.deepEqual(insertPuente(conexionActual).params, [71, 9]);
});

test("POST rechaza alcance vacío o departamentales inválidas antes de tocar la conexión", async () => {
  conexionActual = undefined;
  poolSinConsultas();
  const vacio = await ejecutar(postNoticia, { cabecera: ADMIN, body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[]" } });
  assert.equal(vacio.statusCode, 400);
  assert.equal(vacio.respuesta, MENSAJE_ALCANCE_SIN_DEPARTAMENTALES);

  const repetidas = await ejecutar(postNoticia, { cabecera: ADMIN, body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[1,1]" } });
  assert.equal(repetidas.statusCode, 400);
  assert.equal(repetidas.respuesta, MENSAJE_DEPARTAMENTALES_INVALIDAS);

  poolValidacion([1]);
  const inexistente = await ejecutar(postNoticia, { cabecera: ADMIN, body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[1,999]" } });
  assert.equal(inexistente.statusCode, 400);
  assert.equal(inexistente.respuesta, MENSAJE_DEPARTAMENTALES_INVALIDAS);
});

test("POST revierte la noticia si fallan las filas puente", async () => {
  poolValidacion([7, 1]);
  conexionActual = crearConexion({ fallarEn: /^INSERT INTO noticia_departamental/ });

  const resultado = await ejecutar(postNoticia, {
    cabecera: ADMIN,
    body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[7,1]" },
  });

  assert.equal(resultado.statusCode, 500);
  assert.equal(resultado.respuesta, "Error al crear la noticia");
  assert.deepEqual(conexionActual.eventos, ["begin", "insert_noticia", "falla", "rollback", "release"]);
});

test("PUT reemplaza las filas puente (DELETE + INSERT) en la misma transacción que la noticia", async () => {
  const pool = poolValidacion([3, 9]);
  conexionActual = crearConexion({ noticiaId: 23 });

  const resultado = await ejecutar(putNoticia, {
    cabecera: ADMIN,
    params: { id: "23" },
    body: { ...BODY_BASE, alcance_todas: "0", departamentales: '["3","9"]' },
  });

  assert.equal(resultado.statusCode, 200);
  assert.deepEqual(conexionActual.eventos, [
    "get_lock", "begin", "select_noticia", "update_noticia", "delete_puente", "insert_puente",
    "commit", "release_lock", "release",
  ]);
  const update = paramsUpdateNoticia(conexionActual);
  assert.match(update.sql, /categoria = \?, alcance_todas = \?, departamental_id = \?,/);
  assert.deepEqual(update.params.slice(4, 6), [0, null]);
  assert.equal(update.params.at(-1), 23);
  assert.deepEqual(conexionActual.consultas.find((c) => /^DELETE FROM noticia_departamental/.test(c.sql)).params, [23]);
  assert.deepEqual(insertPuente(conexionActual).params, [23, 3, 23, 9]);
  // Al editar vale una departamental ya asignada aunque hoy esté deshabilitada.
  assert.match(pool[0].sql, /d\.habilitado = 'Y' OR EXISTS \( SELECT 1 FROM noticia_departamental nd WHERE nd\.noticia_id = \? AND nd\.departamental_id = d\.id\)/);
  assert.deepEqual(pool[0].params, [3, 9, 23]);
});

test("PUT a «todas» borra las filas puente y deja departamental_id en NULL", async () => {
  poolSinConsultas();
  conexionActual = crearConexion({ noticiaId: 23 });

  const resultado = await ejecutar(putNoticia, {
    cabecera: ADMIN,
    params: { id: "23" },
    body: { ...BODY_BASE, alcance_todas: "1", departamentales: "[3,9]" },
  });

  assert.equal(resultado.statusCode, 200);
  assert.deepEqual(conexionActual.eventos, [
    "get_lock", "begin", "select_noticia", "update_noticia", "delete_puente", "commit", "release_lock", "release",
  ]);
  assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [1, null]);
});

test("PUT del editor anterior (sólo departamental_id) queda con esa única departamental", async () => {
  poolValidacion([9]);
  conexionActual = crearConexion({ noticiaId: 23 });

  const resultado = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "23" }, body: { ...BODY_BASE, departamental_id: "9" } });

  assert.equal(resultado.statusCode, 200);
  assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [0, 9]);
  assert.deepEqual(insertPuente(conexionActual).params, [23, 9]);
});

// Pestaña abierta desde antes del deploy: con 2 o más departamentales la API le devuelve
// departamental_id = null y su select muestra «Provincial» sin que nadie lo haya elegido.
test("PUT del editor anterior sin departamental conserva una noticia de 2 o más departamentales", async () => {
  for (const body of [{ ...BODY_BASE, departamental_id: "" }, { ...BODY_BASE }]) {
    const pool = poolSinConsultas();
    conexionActual = crearConexion({ noticiaId: 20, noticia: { alcance_todas: 0, departamental_id: null }, puente: [1, 8] });

    const resultado = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "20" }, body });

    const caso = "departamental_id" in body ? `departamental_id ${JSON.stringify(body.departamental_id)}` : "sin departamental_id";
    assert.equal(resultado.statusCode, 200, caso);
    // Las filas puente se leen dentro de la transacción, con la noticia ya bloqueada.
    assert.deepEqual(conexionActual.eventos, [
      "get_lock", "begin", "select_noticia", "select_puente", "update_noticia", "delete_puente", "insert_puente",
      "commit", "release_lock", "release",
    ], caso);
    const lecturaPuente = conexionActual.consultas.find((c) => /^SELECT departamental_id FROM noticia_departamental/.test(c.sql));
    assert.deepEqual(lecturaPuente.params, [20]);
    assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [0, null], caso);
    assert.deepEqual(insertPuente(conexionActual).params, [20, 1, 20, 8], caso);
    assert.equal(pool.length, 0);
  }
});

test("PUT del editor anterior: con 0 o 1 departamental o con un id elegido se respeta lo pedido", async () => {
  // Con 0 o 1 fila puente el select viejo mostraba el alcance real: «Provincial» es una elección.
  for (const puente of [[1], []]) {
    poolSinConsultas();
    conexionActual = crearConexion({
      noticiaId: 20,
      noticia: { alcance_todas: 0, departamental_id: puente[0] ?? null },
      puente,
    });
    const resultado = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "20" }, body: { ...BODY_BASE, departamental_id: "" } });
    assert.equal(resultado.statusCode, 200);
    assert.deepEqual(conexionActual.eventos, [
      "get_lock", "begin", "select_noticia", "select_puente", "update_noticia", "delete_puente",
      "commit", "release_lock", "release",
    ], `puente ${JSON.stringify(puente)}`);
    assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [1, null]);
  }

  // Un id concreto lo eligió el usuario en el select simple: queda sólo esa.
  poolValidacion([9]);
  conexionActual = crearConexion({ noticiaId: 20, noticia: { alcance_todas: 0, departamental_id: null }, puente: [1, 8] });
  const elegida = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "20" }, body: { ...BODY_BASE, departamental_id: "9" } });
  assert.equal(elegida.statusCode, 200);
  assert.equal(conexionActual.eventos.includes("select_puente"), false);
  assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [0, 9]);
  assert.deepEqual(insertPuente(conexionActual).params, [20, 9]);

  // Quien manda la lista (aunque sin alcance_todas) ya no es el editor anterior.
  poolValidacion([3]);
  conexionActual = crearConexion({ noticiaId: 20, noticia: { alcance_todas: 0, departamental_id: null }, puente: [1, 8] });
  const lista = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "20" }, body: { ...BODY_BASE, departamentales: "[3]" } });
  assert.equal(lista.statusCode, 200);
  assert.equal(conexionActual.eventos.includes("select_puente"), false);
  assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [0, 3]);
  assert.deepEqual(insertPuente(conexionActual).params, [20, 3]);

  // «Todas las departamentales» elegida a propósito vale: el editor nuevo siempre manda
  // alcance_todas (con la lista vacía) y otro cliente puede mandar sólo alcance_todas.
  for (const body of [
    { ...BODY_BASE, alcance_todas: "1", departamentales: "[]", departamental_id: "" },
    { ...BODY_BASE, alcance_todas: "1" },
  ]) {
    poolSinConsultas();
    conexionActual = crearConexion({ noticiaId: 20, noticia: { alcance_todas: 0, departamental_id: null }, puente: [1, 8] });
    const todas = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "20" }, body });
    const caso = "departamentales" in body ? "editor nuevo" : "sólo alcance_todas";
    assert.equal(todas.statusCode, 200, caso);
    assert.equal(conexionActual.eventos.includes("select_puente"), false, caso);
    assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [1, null], caso);
    assert.equal(insertPuente(conexionActual), undefined, caso);
  }

  // Una noticia que ya es de todas ni consulta la tabla puente.
  poolSinConsultas();
  conexionActual = crearConexion({ noticiaId: 20, noticia: { alcance_todas: 1, departamental_id: null } });
  const general = await ejecutar(putNoticia, { cabecera: ADMIN, params: { id: "20" }, body: { ...BODY_BASE, departamental_id: "" } });
  assert.equal(general.statusCode, 200);
  assert.equal(conexionActual.eventos.includes("select_puente"), false);
  assert.deepEqual(paramsUpdateNoticia(conexionActual).params.slice(4, 6), [1, null]);
});

test("PUT revierte todo si falla el reemplazo de las filas puente", async () => {
  poolValidacion([3]);
  conexionActual = crearConexion({ noticiaId: 23, fallarEn: /^INSERT INTO noticia_departamental/ });

  const resultado = await ejecutar(putNoticia, {
    cabecera: ADMIN,
    params: { id: "23" },
    body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[3]" },
  });

  assert.equal(resultado.statusCode, 500);
  assert.equal(resultado.respuesta, "Error al actualizar la noticia");
  assert.equal(conexionActual.eventos.includes("commit"), false);
  assert.deepEqual(conexionActual.eventos.slice(-4), ["falla", "rollback", "release_lock", "release"]);
});

test("PUT rechaza departamentales que no existen ni estaban asignadas", async () => {
  poolValidacion([3]);
  conexionActual = undefined;

  const resultado = await ejecutar(putNoticia, {
    cabecera: ADMIN,
    params: { id: "23" },
    body: { ...BODY_BASE, alcance_todas: "0", departamentales: "[3,404]" },
  });

  assert.equal(resultado.statusCode, 400);
  assert.equal(resultado.respuesta, MENSAJE_DEPARTAMENTALES_INVALIDAS);
});
