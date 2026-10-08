"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Conexión falsa: las rutas públicas se prueban sin base.
let responderConsulta = async () => [[]];
const consultas = [];
const poolFalso = {
  promise() {
    return {
      async query(sql, params) {
        consultas.push({ sql, params });
        return responderConsulta(sql, params);
      },
    };
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: poolFalso };

const {
  CONDICION_BENEFICIO_PUBLICO,
  CONDICION_VIAJE_PUBLICO,
  mapearBeneficioPublico,
  mapearConvenioPublico,
  mapearDepartamentalPublica,
  mapearServicioPublico,
  mapearTipoReintegroPublico,
  mapearViajePublico,
  normalizarBusqueda,
  textoPlanoAcotado,
} = require("../api/services/publico");
const publicoRouter = require("../api/routes/publico");
const placasRouter = require("../api/routes/turismo-placas");

const CAMPOS_INTERNOS_BENEFICIO = [
  "razon_social",
  "dni_titulares",
  "convenio_archivo",
  "convenio_nombre_original",
  "convenio_mime",
  "email_aviso_inscripcion",
  "email_contacto",
  "mensaje_inscripcion_html",
  "inscriptos",
  "promocion_html",
  "logo_archivo",
  "creado_por_usuario_id",
  "departamental_id",
  "estado_id",
  "telefono",
];

const FILA_BENEFICIO = {
  id: 4,
  nombre: "Óptica del Centro",
  razon_social: "Ópticas SRL",
  rubro_id: 8,
  rubro_nombre: "Ópticas",
  descripcion_corta: "20% en anteojos recetados",
  promocion_html: "<p>Presentando la credencial <strong>20%&nbsp;off</strong>.</p><ul><li>Lentes</li></ul>",
  telefono: "221-555-0000",
  telefono_visible: 0,
  sitio_web: "https://optica.com.ar",
  sitio_web_visible: 1,
  email_contacto: "ventas@optica.com.ar",
  email_contacto_visible: 1,
  dni_titulares: "20111222",
  cupo_maximo: 50,
  mostrar_mapa: 1,
  fecha_vigencia_desde: "2026-01-01",
  fecha_vigencia_hasta: "2026-12-31",
  habilitado: 1,
  tarjeta_usa_logo: 1,
  logo_archivo: "beneficios/logos/x.png",
  convenio_archivo: "beneficios/convenios/firmado.pdf",
  convenio_nombre_original: "convenio.pdf",
  convenio_mime: "application/pdf",
  email_aviso_inscripcion: "aviso@optica.com.ar",
  mensaje_inscripcion_html: "<p>Gracias</p>",
  alcance_todas: 0,
  departamental_id: 1,
  creado_por_usuario_id: 3,
  estado_id: 3,
  eliminado: 0,
  inscriptos: 12,
};

test("beneficio público: lista blanca de campos, nunca datos internos", () => {
  const salida = mapearBeneficioPublico(FILA_BENEFICIO, {
    imagenUrl: "https://s3/img",
    logoUrl: "https://s3/logo",
    departamentales: ["La Plata", "Quilmes"],
    sucursales: [{ id: 9, beneficio_id: 4, orden: 0, direccion: "Calle 7 Nº 100", latitud: "-34.92", longitud: "-57.95", etiqueta: "Casa central", imagen_archivo: "k", imagen_url: "https://s3/pin" }],
  });
  assert.deepEqual(Object.keys(salida).sort(), [
    "alcance", "cupo_limitado", "departamentales", "descripcion_corta", "detalle_texto", "id", "imagen_url",
    "logo_url", "nombre", "rubro_id", "rubro_nombre", "sitio_web", "sucursales", "vigencia_hasta",
  ]);
  const json = JSON.stringify(salida);
  for (const campo of CAMPOS_INTERNOS_BENEFICIO) {
    assert.equal(Object.prototype.hasOwnProperty.call(salida, campo), false, campo);
  }
  for (const valorInterno of ["Ópticas SRL", "20111222", "firmado.pdf", "aviso@optica", "ventas@optica", "221-555"]) {
    assert.equal(json.includes(valorInterno), false, valorInterno);
  }
  assert.equal(salida.alcance, "DEPARTAMENTALES");
  assert.deepEqual(salida.departamentales, ["La Plata", "Quilmes"]);
  assert.equal(salida.cupo_limitado, true);
  assert.equal(salida.sitio_web, "https://optica.com.ar");
  assert.equal(salida.vigencia_hasta, "2026-12-31");
  assert.equal(salida.detalle_texto, "Presentando la credencial 20% off.\n- Lentes");
  assert.deepEqual(salida.sucursales, [{
    direccion: "Calle 7 Nº 100", latitud: -34.92, longitud: -57.95, etiqueta: "Casa central", imagen_url: "https://s3/pin",
  }]);
});

test("beneficio público: sitio oculto, sin mapa, alcance provincia y sin cupo", () => {
  const salida = mapearBeneficioPublico(
    { ...FILA_BENEFICIO, sitio_web_visible: 0, mostrar_mapa: 0, alcance_todas: 1, cupo_maximo: null },
    { departamentales: ["La Plata"], sucursales: [{ direccion: "x", latitud: 1, longitud: 1 }] }
  );
  assert.equal(salida.sitio_web, null);
  assert.deepEqual(salida.sucursales, []);
  assert.equal(salida.alcance, "PROVINCIA");
  assert.deepEqual(salida.departamentales, []);
  assert.equal(salida.cupo_limitado, false);
  assert.equal(salida.imagen_url, null);
});

test("detalle de beneficio: texto plano de hasta 700 caracteres", () => {
  assert.equal(textoPlanoAcotado(null), null);
  assert.equal(textoPlanoAcotado("<p></p>"), null);
  const largo = `<p>${"palabra ".repeat(200)}</p>`;
  const texto = textoPlanoAcotado(largo);
  assert.ok(texto.length <= 700, String(texto.length));
  assert.ok(texto.endsWith("…"));
  assert.equal(texto.includes("<"), false);
  assert.equal(textoPlanoAcotado("<p>Caf&#xe9; &amp; m&#225;s</p>"), "Café & más");
});

test("condición pública de beneficios: aprobado, habilitado, vigente y sin parámetro de departamental", () => {
  assert.match(CONDICION_BENEFICIO_PUBLICO, /b\.eliminado = 0/);
  assert.match(CONDICION_BENEFICIO_PUBLICO, /b\.estado_id = 3/);
  assert.match(CONDICION_BENEFICIO_PUBLICO, /b\.habilitado = 1/);
  assert.match(CONDICION_BENEFICIO_PUBLICO, /fecha_vigencia_hasta >= CURDATE\(\)/);
  assert.equal(CONDICION_BENEFICIO_PUBLICO.includes("?"), false);
  assert.equal(/departamental/.test(CONDICION_BENEFICIO_PUBLICO), false);
  assert.match(CONDICION_VIAJE_PUBLICO, /dr\.oculto = 0/);
  assert.match(CONDICION_VIAJE_PUBLICO, /TIPO_VIAJE/);
});

test("tipos de reintegro: requisitos sin key interna; porcentaje sólo en modo PORCENTAJE", () => {
  const porcentaje = mapearTipoReintegroPublico({
    id: 1, nombre: "Medicamentos", icono: "medication", modo_cobertura: "PORCENTAJE",
    porcentaje_cobertura: "30.00", tope_reintegro: null, es_subsidio: 0, imputacion_id: 4,
    adjuntos_config: JSON.stringify([{ key: "RECETA", label: "Receta médica", requerido: 1 }, { key: "X", label: "Detalle", requerido: 0 }]),
  });
  assert.deepEqual(porcentaje, {
    id: 1, nombre: "Medicamentos", icono: "medication", modo_cobertura: "PORCENTAJE",
    porcentaje_cobertura: 30, tope_reintegro: null, es_subsidio: false,
    requisitos: [{ label: "Receta médica", requerido: true }, { label: "Detalle", requerido: false }],
  });
  const manual = mapearTipoReintegroPublico({
    id: 7, nombre: "Obsequio por nacimiento", icono: "child_care", modo_cobertura: "MANUAL",
    porcentaje_cobertura: 50, tope_reintegro: 1000, es_subsidio: 1, adjuntos_config: "no-json",
  });
  assert.equal(manual.porcentaje_cobertura, null);
  assert.equal(manual.tope_reintegro, null);
  assert.equal(manual.es_subsidio, true);
  assert.deepEqual(manual.requisitos, []);
});

test("viajes, servicios, convenios y departamentales: sólo campos públicos", () => {
  assert.deepEqual(
    mapearViajePublico({ id: 1, codigo: "VIAJE_BODAS", nombre: "Viaje de bodas", descripcion: "Luna de miel", porcentaje_descuento: "20.00", requiere_comprobante: 1, usos_maximos: 3, alcance_departamental: "TODAS" }),
    { codigo: "VIAJE_BODAS", nombre: "Viaje de bodas", descripcion: "Luna de miel", porcentaje_descuento: 20, requiere_comprobante: true }
  );
  const servicio = mapearServicioPublico(
    { id: 2, nombre: "Hotel Solís", lugar: "Capital Federal", tipo_codigo: "ALOJAMIENTO_RECURSO", descripcion: "Céntrico", modelo_tarifa: "TEMPORADAS", propietario_departamental_id: 1 },
    ["a", "b", "c", "d", "e", "f", "g"]
  );
  assert.deepEqual(Object.keys(servicio).sort(), ["descripcion", "id", "imagenes", "lugar", "nombre", "tipo_codigo"]);
  assert.equal(servicio.imagenes.length, 6);
  const convenio = mapearConvenioPublico({ id: 1, servicio_id: 6, nombre: "Hotel Linz", ciudad: "Villa Carlos Paz", provincia: "Córdoba", descripcion: "Hermoso", tarifario_pdf_archivo: "k.pdf", coordenadas_maps: "x" }, []);
  assert.deepEqual(Object.keys(convenio).sort(), ["ciudad", "descripcion", "id", "imagenes", "nombre", "provincia", "servicio_id"]);
  assert.deepEqual(
    mapearDepartamentalPublica({ id: 1, nombre: "La Plata", direccion: "Calle 55", localidad: "La Plata", coordenadas: "POINT", habilitado: "Y" }),
    { id: 1, nombre: "La Plata", direccion: "Calle 55", localidad: "La Plata" }
  );
});

test("búsqueda pública: texto recortado, vacío = null y tope de 200", () => {
  assert.equal(normalizarBusqueda(undefined), null);
  assert.equal(normalizarBusqueda("  "), null);
  assert.equal(normalizarBusqueda(" óptica "), "óptica");
  assert.equal(normalizarBusqueda("x".repeat(201)), undefined);
  assert.equal(normalizarBusqueda(["a", "b"]), undefined);
});

// ── Rutas ──────────────────────────────────────────────────────────────────

function capas(router) {
  return router.stack.filter((capa) => capa.route).map((capa) => ({
    path: capa.route.path,
    metodos: Object.keys(capa.route.methods),
    handlers: capa.route.stack.map((item) => item.handle),
  }));
}

test("el router público sólo expone GET sin middleware de sesión", () => {
  const rutas = capas(publicoRouter);
  assert.deepEqual(rutas.map((ruta) => ruta.path).sort(), [
    "/publico/beneficios",
    "/publico/departamentales",
    "/publico/salud",
    "/publico/subsidios",
    "/publico/turismo",
    "/publico/turismo/placas",
  ]);
  for (const ruta of rutas) {
    assert.deepEqual(ruta.metodos, ["get"], ruta.path);
    assert.equal(ruta.handlers.length, 1, `${ruta.path} no debería pedir token`);
  }
});

test("las rutas admin de placas exigen token y permiso de administrador de turismo", () => {
  const rutas = capas(placasRouter);
  assert.equal(rutas.length, 6);
  for (const ruta of rutas) {
    assert.ok(ruta.path.startsWith("/admin/turismo/placas"), ruta.path);
    assert.equal(ruta.handlers[0], placasRouter.__test.verifyToken, ruta.path);
    assert.equal(ruta.handlers[1], placasRouter.__test.exigirAdministradorTurismo, ruta.path);
  }
});

function ejecutarPermiso(cabecera) {
  const req = { data: { data: JSON.stringify(cabecera) } };
  let resultado = { siguio: false };
  const res = {
    status(codigo) { resultado.status = codigo; return this; },
    json(cuerpo) { resultado.cuerpo = cuerpo; return this; },
  };
  placasRouter.__test.exigirAdministradorTurismo(req, res, () => { resultado.siguio = true; });
  return resultado;
}

test("permiso de placas: admin y admin-central con área turismo; nadie más", () => {
  assert.equal(ejecutarPermiso({ id: 1, rol: "admin" }).siguio, true);
  assert.equal(ejecutarPermiso({ id: 11, rol: "admin-central", area_turismo: 1 }).siguio, true);
  const sinArea = ejecutarPermiso({ id: 11, rol: "admin-central", area_turismo: 0 });
  assert.equal(sinArea.siguio, false);
  assert.equal(sinArea.status, 403);
  for (const rol of ["departamental", "afiliado", "prensa", "auditor"]) {
    assert.equal(ejecutarPermiso({ id: 3, rol, area_turismo: 1, departamental_id: 1 }).status, 403, rol);
  }
});

function ejecutarHandler(router, ruta, query = {}) {
  const capa = router.stack.find((item) => item.route?.path === ruta);
  const handler = capa.route.stack[capa.route.stack.length - 1].handle;
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      removeHeader(nombre) { delete headers[nombre.toLowerCase()]; },
      set(nombre, valor) { headers[nombre.toLowerCase()] = valor; return this; },
      status(codigo) { this.statusCode = codigo; return this; },
      json(cuerpo) { resolve({ status: this.statusCode, cuerpo, headers }); return this; },
    };
    handler({ query }, res);
  });
}

test("GET /publico/beneficios no filtra por departamental y no filtra campos internos", async () => {
  consultas.length = 0;
  responderConsulta = async (sql) => {
    if (/FROM beneficio b\s+INNER JOIN beneficio_rubro r ON r\.id = b\.rubro_id\s+WHERE/.test(sql) && !/GROUP BY/.test(sql)) {
      return [[{ ...FILA_BENEFICIO, logo_archivo: null }]];
    }
    if (/FROM beneficio_departamental/.test(sql)) return [[{ beneficio_id: 4, nombre: "La Plata" }]];
    if (/FROM beneficio_sucursal/.test(sql)) return [[{ beneficio_id: 4, direccion: "Calle 7", latitud: 1, longitud: 2, etiqueta: null, imagen_archivo: null }]];
    if (/GROUP BY r\.id/.test(sql)) return [[{ id: 8, nombre: "Ópticas", cantidad: 1 }]];
    return [[]];
  };
  const respuesta = await ejecutarHandler(publicoRouter, "/publico/beneficios", { q: "óptica", rubro_id: "8" });
  assert.equal(respuesta.status, 200);
  assert.match(respuesta.headers["cache-control"], /^public/);
  assert.equal(respuesta.cuerpo.results.length, 1);
  assert.deepEqual(respuesta.cuerpo.rubros, [{ id: 8, nombre: "Ópticas", cantidad: 1 }]);
  const json = JSON.stringify(respuesta.cuerpo);
  for (const valorInterno of ["Ópticas SRL", "20111222", "firmado.pdf", "aviso@optica", "ventas@optica", "Gracias"]) {
    assert.equal(json.includes(valorInterno), false, valorInterno);
  }
  // Ninguna consulta del listado recibe una departamental como parámetro
  const listado = consultas.find((consulta) => /LIMIT 200/.test(consulta.sql));
  assert.deepEqual(listado.params, ["%óptica%", "%óptica%", "%óptica%", 8]);
});

test("GET /publico/beneficios valida rubro y búsqueda", async () => {
  responderConsulta = async () => [[]];
  assert.equal((await ejecutarHandler(publicoRouter, "/publico/beneficios", { rubro_id: "abc" })).status, 400);
  assert.equal((await ejecutarHandler(publicoRouter, "/publico/beneficios", { q: "x".repeat(201) })).status, 400);
  const vacio = await ejecutarHandler(publicoRouter, "/publico/beneficios", {});
  assert.deepEqual(vacio.cuerpo, { results: [], rubros: [] });
});

test("GET /publico/turismo usa la visibilidad pública (sólo alcance TODAS)", async () => {
  consultas.length = 0;
  responderConsulta = async () => [[]];
  const respuesta = await ejecutarHandler(publicoRouter, "/publico/turismo");
  assert.equal(respuesta.status, 200);
  assert.deepEqual(respuesta.cuerpo, { servicios: [], convenios: [], lugares: [] });
  for (const consulta of consultas) {
    assert.match(consulta.sql, /alcance_departamental = 'TODAS'/);
    assert.equal(/propietario_departamental_id = \?/.test(consulta.sql), false);
    assert.equal(/tarifa\b.*precio|precio_/i.test(consulta.sql.split("WHERE")[0]), false);
  }
});
