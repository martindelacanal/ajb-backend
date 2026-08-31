"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const consultas = [];
const fakeDb = {
  async query(sql, params = []) {
    consultas.push({ sql, params });
    if (/FROM tipo_servicio/i.test(sql)) {
      return [[{
        id: 1,
        codigo: "ALOJAMIENTO_RECURSO",
        nombre: "Alojamiento por recurso",
        descripcion: "Inventario individual",
        activo: 1,
        orden: 10,
      }]];
    }
    if (/FROM departamental/i.test(sql)) {
      return [[{ id: 7, nombre: "Departamental Azul" }]];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  },
};

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: { promise: () => fakeDb },
};

const autorizacionPath = require.resolve("../api/security/autorizacion-sesion");
require.cache[autorizacionPath] = {
  id: autorizacionPath,
  filename: autorizacionPath,
  loaded: true,
  exports: {
    verificarTokenConAutorizacionActual({ req, next }) {
      req.data = {
        data: JSON.stringify({
          id: 10,
          rol: req.get("x-test-role") || "afiliado",
          area_turismo: 1,
          modulo_turismo: 1,
          departamental_id: 7,
        }),
      };
      next();
    },
  },
};

const router = require("../api/routes/turismo-gestion");
const app = express();
app.use(express.json());
app.use("/api", router);

async function request(pathname, role) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      headers: { "x-test-role": role },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("admin-central puede leer tipos parametrizados y un afiliado no entra a gestión", async () => {
  consultas.length = 0;
  const autorizado = await request("/api/gestion/turismo/tipos", "admin-central");
  assert.equal(autorizado.status, 200);
  assert.equal(autorizado.body[0].codigo, "ALOJAMIENTO_RECURSO");

  const cantidadConsultas = consultas.length;
  const afiliado = await request("/api/gestion/turismo/tipos", "afiliado");
  assert.equal(afiliado.status, 403);
  assert.equal(afiliado.body.codigo, "GESTION_TURISMO_NO_AUTORIZADA");
  assert.equal(consultas.length, cantidadConsultas);
});

test("departamental obtiene el catálogo read-only para alcance seleccionado", async () => {
  const response = await request("/api/gestion/turismo/departamentales", "departamental");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [{ id: 7, nombre: "Departamental Azul" }]);
  assert.match(consultas.at(-1).sql, /habilitado = 'Y'/);
});

test("el catálogo está montado y publica el contrato CRUD completo", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "routes", "turismo-gestion.js"),
    "utf8"
  );
  assert.match(appSource, /require\('\.\/api\/routes\/turismo-gestion'\)/);
  assert.match(appSource, /app\.use\('\/api', turismoGestionRoute\)/);
  for (const contrato of [
    "/gestion/turismo/servicios",
    "/gestion/turismo/servicios/:id/recursos",
    "/gestion/turismo/servicios/:id/filtros",
    "/gestion/turismo/servicios/:id/tarifas",
    "/gestion/turismo/servicios/:id/cupos",
    "/gestion/turismo/servicios/:id/imagenes",
    "/gestion/turismo/servicios/:id/convenio",
    "/gestion/turismo/servicios/:id/historial",
    "/gestion/turismo/servicios/:id/aprobacion",
  ]) {
    assert.match(routeSource, new RegExp(contrato.replaceAll("/", "\\/")));
  }
  assert.match(routeSource, /datos\.modelo_tarifa === "PRECIO_UNICO"[\s\S]+datos\.permite_acompanantes = 0/);
  assert.match(routeSource, /req\.body\?\.caracteristicas/);
});

test("los filtros compartidos usan clone-on-write y conservan valores del servicio", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "routes", "turismo-gestion.js"),
    "utf8"
  );
  assert.match(routeSource, /INSERT INTO filtro \(codigo, nombre, tipo_valor/);
  assert.match(routeSource, /UPDATE servicio_filtro SET filtro_id = \?/);
  assert.match(routeSource, /UPDATE filtro_recurso fr[\s\S]+INNER JOIN recurso r[\s\S]+r\.servicio_id = \?/);
  assert.match(routeSource, /clonado_desde_filtro_id/);
  assert.doesNotMatch(routeSource, /SELECT id FROM filtro WHERE codigo = \? AND id <> \?/);
});

test("servicio y convenio se escriben atomicos y el alta central queda en borrador", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "routes", "turismo-gestion.js"),
    "utf8"
  );
  assert.match(routeSource, /const estado = cabecera\.rol === "departamental" \? "PENDIENTE" : "BORRADOR"/);
  assert.match(routeSource, /guardarConvenioEnServicio\(connection, servicioId, payload, datos/);
  assert.match(routeSource, /convenio_hotel: convenio/);
  assert.match(routeSource, /await connection\.beginTransaction\(\)[\s\S]+guardarConvenioEnServicio[\s\S]+await connection\.commit\(\)/);
});

test("aprobacion, activacion y listados exponen el checklist de configuracion", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "routes", "turismo-gestion.js"),
    "utf8"
  );
  const catalogoSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "services", "turismo-catalogo.js"),
    "utf8"
  );
  assert.match(routeSource, /configuracion_completa: faltantes\.length === 0/);
  assert.match(routeSource, /faltantes_configuracion: faltantes/);
  assert.match(routeSource, /estadoDestino === "APROBADO"[\s\S]+SERVICIO_CONFIGURACION_INCOMPLETA/);
  assert.match(routeSource, /activo === 1[\s\S]+No se puede habilitar un servicio con configuracion incompleta/);
  assert.match(catalogoSource, /imagen_servicio ivs/);
  assert.match(catalogoSource, /turismo_tarifa_regla trv/);
  assert.match(catalogoSource, /recurso_cupo_periodo cpv/);
});

test("las reglas TEMPORADAS se materializan y cotizan con takeover de rango completo", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "routes", "turismo-gestion.js"),
    "utf8"
  );
  const userSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "routes", "user.js"),
    "utf8"
  );
  const disponibilidadSource = fs.readFileSync(
    path.join(__dirname, "..", "api", "services", "servicios-disponibilidad.js"),
    "utf8"
  );
  assert.doesNotMatch(routeSource, /sincronizarTarifasMaterializadas[\s\S]{0,180}modelo_tarifa !== "PRECIO_UNICO"/);
  assert.match(routeSource, /turismo_tarifa_regla_id\)[\s\S]+Number\(regla\.precio_por_persona\) === 1 \? "Y" : "N"/);
  assert.match(userSource, /calcularTarifaTemporadasGestionadas/);
  assert.match(userSource, /toma control solo cuando cubre el rango[\s\S]+return null/);
  assert.match(disponibilidadSource, /turismo_tarifa_regla tr[\s\S]+tarifas\.push\(\.\.\.reglas\)/);
  assert.match(
    disponibilidadSource,
    /turismo_tarifa_regla_id IS NULL[\s\S]+COALESCE\(audiencia_departamental, 'TODAS'\) IN \('TODAS', \?\)/
  );
});
