"use strict";

// Noticias fuera de la portada pública: una noticia para algunas departamentales puede
// quedar sólo en sus portales (noticia.en_portada_publica = 0).

const test = require("node:test");
const assert = require("node:assert/strict");

let conexionActual;
let consultarPool = async () => {
  throw new Error("Consulta de pool inesperada");
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
  CONDICION_PORTAL,
  CONDICION_PUBLICA,
  CONDICION_VIGENTE,
  MENSAJE_DESTACADA_SIN_PORTADA,
  esPortadaPublica,
  firmarNoticias,
  normalizarPortadaPublica,
  resolverPortadaPublica,
  validarDatosNoticia,
} = router.__test;

function obtenerHandlerFinal(metodo, ruta) {
  const capa = router.stack.find((item) => item.route?.path === ruta && item.route.methods?.[metodo]);
  assert.ok(capa, `no se encontró ${metodo.toUpperCase()} ${ruta}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}

const getPublicas = obtenerHandlerFinal("get", "/noticias/publicas");
const getPortal = obtenerHandlerFinal("get", "/noticias/departamental");
const postNoticia = obtenerHandlerFinal("post", "/admin/noticias");
const putNoticia = obtenerHandlerFinal("put", "/admin/noticias/:id(\\d+)");
const putFlags = obtenerHandlerFinal("put", "/admin/noticias/:id(\\d+)/flags");

const ADMIN = Object.freeze({ id: 1, rol: "admin" });
const AFILIADO = Object.freeze({ id: 2, rol: "afiliado", departamental_id: 1 });
const normalizarSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

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

async function ejecutar(handler, { body = {}, params = {}, query = {}, cabecera = ADMIN } = {}) {
  let statusCode = 200;
  let respuesta;
  const req = { body, params, query, files: {}, data: { data: JSON.stringify(cabecera) } };
  const res = {
    status(valor) { statusCode = valor; return this; },
    json(valor) { respuesta = valor; return this; },
    set() { return this; },
    removeHeader() { return this; },
  };
  const consoleErrorOriginal = console.error;
  console.error = () => {};
  try {
    await handler(req, res);
  } finally {
    console.error = consoleErrorOriginal;
  }
  return { statusCode, respuesta };
}

// `noticia`: campos de la fila guardada; `puente`: sus departamentales.
function crearConexion({ insertId = 71, noticia = {}, puente = [] } = {}) {
  const eventos = [];
  const consultas = [];
  return {
    eventos,
    consultas,
    async query(sql, params = []) {
      const texto = normalizarSql(sql);
      consultas.push({ sql: texto, params });
      if (texto.includes("GET_LOCK")) { eventos.push("get_lock"); return [[{ adquirido: 1 }]]; }
      if (texto.includes("RELEASE_LOCK")) { eventos.push("release_lock"); return [[{ liberado: 1 }]]; }
      if (/^SELECT \* FROM noticia WHERE id = \?/.test(texto)) {
        return [[{ id: 23, destacada: 0, fecha_publicacion: null, imagen_archivo: null, ...noticia }]];
      }
      if (/^SELECT id, en_portada_publica FROM noticia WHERE id = \?/.test(texto)) {
        return [[{ id: 23, en_portada_publica: 1, ...noticia }]];
      }
      if (/^SELECT departamental_id FROM noticia_departamental/.test(texto)) {
        return [puente.map((id) => ({ departamental_id: id }))];
      }
      if (/^SELECT COUNT\(\*\) AS total\s+FROM noticia/.test(texto)) { eventos.push("cupo"); return [[{ total: 0 }]]; }
      if (/^INSERT INTO noticia \(/.test(texto)) { eventos.push("insert_noticia"); return [{ insertId }]; }
      if (/^UPDATE noticia SET/.test(texto)) { eventos.push("update_noticia"); return [{ affectedRows: 1 }]; }
      if (/^DELETE FROM noticia_departamental/.test(texto)) { return [{ affectedRows: 0 }]; }
      if (/^INSERT INTO noticia_departamental/.test(texto)) { return [{ affectedRows: params.length / 2 }]; }
      throw new Error(`SQL inesperado: ${texto}`);
    },
    async beginTransaction() { eventos.push("begin"); },
    async commit() { eventos.push("commit"); },
    async rollback() { eventos.push("rollback"); },
    release() { eventos.push("release"); },
    destroy() { eventos.push("destroy"); },
  };
}

const BODY_BASE = Object.freeze({
  titulo: "Asamblea de afiliados en la sede",
  categoria: "Departamentales",
  estado: "BORRADOR",
  destacada: "0",
  orden: "0",
  cuerpo: "",
  fecha_publicacion: "",
});

const validarDepartamentales = (validas) => poolCon([{
  si: /^SELECT d\.id FROM departamental d WHERE d\.id IN/,
  da: (params) => [params.filter((id) => validas.includes(id)).map((id) => ({ id }))],
}]);

const insertNoticia = (conexion) => conexion.consultas.find((c) => /^INSERT INTO noticia \(/.test(c.sql));
const updateNoticia = (conexion) => conexion.consultas.find((c) => /^UPDATE noticia SET/.test(c.sql));

// ── Normalización y resolución ──────────────────────────────────────────────

test("en_portada_publica: ausente es null, acepta 1/0/true/false y rechaza lo demás", () => {
  assert.deepEqual(normalizarPortadaPublica(undefined), { value: null });
  assert.deepEqual(normalizarPortadaPublica(""), { value: null });
  assert.deepEqual(normalizarPortadaPublica(" 1 "), { value: 1 });
  assert.deepEqual(normalizarPortadaPublica("0"), { value: 0 });
  assert.deepEqual(normalizarPortadaPublica(true), { value: 1 });
  assert.deepEqual(normalizarPortadaPublica("false"), { value: 0 });
  assert.ok(normalizarPortadaPublica("tal vez").error);

  assert.equal(validarDatosNoticia({ ...BODY_BASE, en_portada_publica: "quizás" }).error, "El valor de portada pública es inválido");
  assert.equal(validarDatosNoticia({ ...BODY_BASE }).value.enPortadaPublica, null);
  assert.equal(validarDatosNoticia({ ...BODY_BASE, alcance_todas: "0", departamentales: "[1]", en_portada_publica: "0" }).value.enPortadaPublica, 0);
});

test("sólo un 0 explícito saca la noticia de la portada", () => {
  assert.equal(esPortadaPublica(0), false);
  assert.equal(esPortadaPublica("0"), false);
  assert.equal(esPortadaPublica(false), false);
  assert.equal(esPortadaPublica(1), true);
  assert.equal(esPortadaPublica(undefined), true);
  assert.equal(esPortadaPublica(null), true);
});

test("resolverPortadaPublica: todas siempre sale, el dato manda, sin dato se conserva y fuera de portada no hay destacada", () => {
  assert.equal(resolverPortadaPublica({ alcanceTodas: 1, enPortadaPublica: 0, destacada: 1 }).enPortadaPublica, 1);

  const fuera = resolverPortadaPublica({ alcanceTodas: 0, enPortadaPublica: 0, destacada: 1 });
  assert.equal(fuera.enPortadaPublica, 0);
  assert.equal(fuera.destacada, 0);

  assert.equal(resolverPortadaPublica({ alcanceTodas: 0, enPortadaPublica: 1, destacada: 1 }, { en_portada_publica: 0 }).destacada, 1);
  // Sin dato: al crear sale; al editar se conserva lo guardado.
  assert.equal(resolverPortadaPublica({ alcanceTodas: 0, enPortadaPublica: null, destacada: 0 }).enPortadaPublica, 1);
  assert.equal(resolverPortadaPublica({ alcanceTodas: 0, enPortadaPublica: null, destacada: 0 }, { en_portada_publica: 0 }).enPortadaPublica, 0);
  assert.equal(resolverPortadaPublica({ alcanceTodas: 0, enPortadaPublica: null, destacada: 0 }, { en_portada_publica: 1 }).enPortadaPublica, 1);
});

// ── Visibilidad ─────────────────────────────────────────────────────────────

test("la portada pública filtra en_portada_publica = 1 y el portal departamental no", () => {
  assert.match(CONDICION_PUBLICA, /n\.en_portada_publica = 1$/);
  assert.ok(CONDICION_PUBLICA.startsWith(CONDICION_VIGENTE));
  assert.doesNotMatch(CONDICION_VIGENTE, /en_portada_publica/);
  assert.doesNotMatch(CONDICION_PORTAL, /en_portada_publica/);
  assert.ok(CONDICION_PORTAL.startsWith(CONDICION_VIGENTE));
});

test("el listado público pide sólo lo que sale en la portada; el portal también ve lo de sus departamentales", async () => {
  const publico = poolCon([
    { si: /^SELECT COUNT\(\*\) AS totalItems FROM noticia n WHERE/, da: () => [[{ totalItems: 0 }]] },
    { si: /^SELECT n\.id, n\.titulo/, da: () => [[]] },
  ]);
  const respuestaPublica = await ejecutar(getPublicas, { query: {} });
  assert.equal(respuestaPublica.statusCode, 200);
  assert.ok(publico.every((consulta) => consulta.sql.includes("n.en_portada_publica = 1")));

  const portal = poolCon([
    { si: /FROM departamental d WHERE d\.id = \?/, da: () => [[]] },
    { si: /^SELECT COUNT\(\*\) AS totalItems FROM noticia n WHERE/, da: () => [[{ totalItems: 0 }]] },
    { si: /^SELECT n\.id, n\.titulo/, da: () => [[]] },
    { si: /^SELECT COUNT\(\*\) AS todas/, da: () => [[{ todas: 0, propias: 0, generales: 0 }]] },
    { si: /^SELECT n\.categoria, COUNT\(\*\) AS total/, da: () => [[]] },
  ]);
  const respuestaPortal = await ejecutar(getPortal, { cabecera: AFILIADO, query: {} });
  assert.equal(respuestaPortal.statusCode, 200);
  assert.ok(portal.filter((consulta) => /FROM noticia n/.test(consulta.sql)).length >= 3);
  // La columna viaja en los campos, pero ningún WHERE del portal la filtra.
  assert.ok(portal.every((consulta) => !consulta.sql.includes("en_portada_publica = 1")));
});

test("la serialización expone en_portada_publica (todas siempre true)", async () => {
  const db = {
    async query() {
      return [[{ noticia_id: 5, id: 1, nombre: "La Plata" }]];
    },
  };
  const [general, puntual, fuera] = await firmarNoticias(db, [
    { id: 4, titulo: "A", categoria: "Gremial", alcance_todas: 1, en_portada_publica: 0 },
    { id: 5, titulo: "B", categoria: "Gremial", alcance_todas: 0, en_portada_publica: 1 },
    { id: 6, titulo: "C", categoria: "Gremial", alcance_todas: 0, en_portada_publica: 0 },
  ]);
  assert.equal(general.en_portada_publica, true);
  assert.equal(puntual.en_portada_publica, true);
  assert.equal(fuera.en_portada_publica, false);
});

// ── Alta, edición y destacadas ──────────────────────────────────────────────

test("POST fuera de la portada guarda 0 y apaga destacada sin pedir el lock del carrusel", async () => {
  validarDepartamentales([1]);
  conexionActual = crearConexion();
  const resultado = await ejecutar(postNoticia, {
    body: { ...BODY_BASE, destacada: "1", alcance_todas: "0", departamentales: "[1]", en_portada_publica: "0" },
  });
  assert.equal(resultado.statusCode, 201);
  const insert = insertNoticia(conexionActual);
  assert.match(insert.sql, /creado_por_usuario_id, en_portada_publica\)/);
  assert.equal(insert.params[11], 0, "destacada");
  assert.equal(insert.params[16], 0, "en_portada_publica");
  assert.equal(conexionActual.eventos.includes("get_lock"), false);
});

test("POST para todas sale en la portada aunque pidan lo contrario", async () => {
  poolCon([]);
  conexionActual = crearConexion();
  const resultado = await ejecutar(postNoticia, { body: { ...BODY_BASE, alcance_todas: "1", en_portada_publica: "0" } });
  assert.equal(resultado.statusCode, 201);
  assert.equal(insertNoticia(conexionActual).params[16], 1);
});

test("PUT: el editor anterior (sin el dato) conserva lo guardado; el nuevo lo cambia", async () => {
  validarDepartamentales([1]);
  conexionActual = crearConexion({ noticia: { alcance_todas: 0, en_portada_publica: 0 } });
  const viejo = await ejecutar(putNoticia, { params: { id: "23" }, body: { ...BODY_BASE, departamental_id: "1" } });
  assert.equal(viejo.statusCode, 200);
  let update = updateNoticia(conexionActual);
  assert.match(update.sql, /fecha_publicacion = \?, en_portada_publica = \? WHERE id = \?$/);
  assert.equal(update.params[15], 0);

  validarDepartamentales([1]);
  conexionActual = crearConexion({ noticia: { alcance_todas: 0, en_portada_publica: 0 } });
  const nuevo = await ejecutar(putNoticia, {
    params: { id: "23" },
    body: { ...BODY_BASE, destacada: "1", alcance_todas: "0", departamentales: "[1]", en_portada_publica: "1" },
  });
  assert.equal(nuevo.statusCode, 200);
  update = updateNoticia(conexionActual);
  assert.equal(update.params[15], 1);
  assert.equal(update.params[11], 1, "puede volver a destacarse");

  // Pasar a todas la devuelve a la portada.
  poolCon([]);
  conexionActual = crearConexion({ noticia: { alcance_todas: 0, en_portada_publica: 0 } });
  const todas = await ejecutar(putNoticia, { params: { id: "23" }, body: { ...BODY_BASE, alcance_todas: "1" } });
  assert.equal(todas.statusCode, 200);
  assert.equal(updateNoticia(conexionActual).params[15], 1);
});

test("PUT fuera de la portada apaga destacada", async () => {
  validarDepartamentales([1]);
  conexionActual = crearConexion({ noticia: { alcance_todas: 0, en_portada_publica: 1, destacada: 1 } });
  const resultado = await ejecutar(putNoticia, {
    params: { id: "23" },
    body: { ...BODY_BASE, destacada: "1", alcance_todas: "0", departamentales: "[1]", en_portada_publica: "0" },
  });
  assert.equal(resultado.statusCode, 200);
  const update = updateNoticia(conexionActual);
  assert.equal(update.params[11], 0);
  assert.equal(update.params[15], 0);
});

test("las acciones rápidas no destacan una noticia que no sale en la portada", async () => {
  conexionActual = crearConexion({ noticia: { en_portada_publica: 0 } });
  const rechazada = await ejecutar(putFlags, { params: { id: "23" }, body: { destacada: "1" } });
  assert.equal(rechazada.statusCode, 409);
  assert.equal(rechazada.respuesta, MENSAJE_DESTACADA_SIN_PORTADA);
  assert.ok(conexionActual.eventos.includes("rollback"));
  assert.equal(conexionActual.eventos.includes("update_noticia"), false);

  // Quitar la destacada o publicar sí se puede.
  conexionActual = crearConexion({ noticia: { en_portada_publica: 0 } });
  const quitar = await ejecutar(putFlags, { params: { id: "23" }, body: { destacada: "0", estado: "PUBLICADA" } });
  assert.equal(quitar.statusCode, 200);

  conexionActual = crearConexion({ noticia: { en_portada_publica: 1 } });
  const publica = await ejecutar(putFlags, { params: { id: "23" }, body: { destacada: "1" } });
  assert.equal(publica.statusCode, 200);
});
