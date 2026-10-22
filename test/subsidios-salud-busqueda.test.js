"use strict";

// Subsidios por salud: búsqueda con el código «T-» que muestra la bandeja, sin
// nombres de estado en el backend, textos de las notificaciones y la búsqueda
// única del listado y la exportación CSV de reintegros.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "subsidios-salud-busqueda-test-secret";

const llamadas = [];
let sesionActual;
let manejador = async (sql) => {
  throw new Error(`Consulta inesperada: ${sql}`);
};

function esConsultaAutorizacion(sql) {
  return /u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r[\s\S]+WHERE u\.id = \?/i.test(sql);
}

async function consultar(sql, params = []) {
  llamadas.push({ sql, params });
  if (esConsultaAutorizacion(sql)) return [[{ ...sesionActual }]];
  return manejador(sql, params);
}

const conexion = {
  query: consultar,
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
};
const db = { query: consultar, async getConnection() { return conexion; } };

const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { promise: () => db } };

const router = require("../api/routes/coseguro");
const app = express();
app.use(express.json());
app.use("/api", router);

function preparar({ sesion = {}, handler } = {}) {
  llamadas.length = 0;
  sesionActual = {
    id: 40, rol_id: 2, rol: "departamental", departamental_id: 7, habilitado: "Y",
    area_turismo: 1, area_coseguro: 1, modulo_turismo: 1, modulo_coseguro: 1, modulo_olimpiadas: 1,
    ...sesion,
  };
  manejador = handler || (async (sql) => {
    throw new Error(`Consulta inesperada: ${sql}`);
  });
}

function consultasDeNegocio() {
  return llamadas.filter(({ sql }) => !esConsultaAutorizacion(sql));
}

async function pedir(ruta, { method = "GET", body } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: sesionActual.id, rol: sesionActual.rol }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const texto = await response.text();
    return { status: response.status, body: texto ? JSON.parse(texto) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const subsidio = {
  id: 5, reserva_id: 120, usuario_id: 9, estado: "PENDIENTE", motivo: "Tratamiento", certificados: 2,
  afiliado_nombre: "Ana", afiliado_apellido: "Pérez", afiliado_departamental_id: 7, precio_total: 50000,
};

// Bandeja: devuelve un subsidio y los conteos; guarda la consulta del listado
function bandeja(capturadas) {
  return async (sql, params) => {
    if (/FROM reserva_salud rs[\s\S]+ORDER BY FIELD\(rs\.estado/.test(sql)) {
      capturadas.push({ sql, params });
      return [[{ ...subsidio }]];
    }
    if (/SELECT rs\.estado, COUNT\(\*\) AS cantidad/.test(sql)) return [[{ estado: "PENDIENTE", cantidad: 1 }]];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("la bandeja encuentra el expediente por su código T-, con o sin guion, y sólo ese", async () => {
  for (const texto of ["T-120", "t120", "T 120", "#120"]) {
    const listados = [];
    preparar({ handler: bandeja(listados) });
    const respuesta = await pedir(`/coseguro/subsidios-salud?search=${encodeURIComponent(texto)}`);
    assert.equal(respuesta.status, 200, texto);
    assert.equal(listados.length, 1);
    const [{ sql, params }] = listados;
    assert.match(sql, /rs\.reserva_id = \?/, texto);
    assert.doesNotMatch(sql, /LIKE/, texto);
    // Primero el alcance de la departamental, después el código exacto
    assert.deepEqual(params, [7, 120], texto);
  }
});

test("el texto libre ya no compara el código interno del estado", async () => {
  const listados = [];
  preparar({ handler: bandeja(listados) });
  const respuesta = await pedir(`/coseguro/subsidios-salud?search=${encodeURIComponent("Pérez")}`);
  assert.equal(respuesta.status, 200);
  const [{ sql, params }] = listados;
  assert.doesNotMatch(sql, /rs\.estado LIKE/);
  assert.doesNotMatch(sql, /rs\.reserva_id = \?/);
  assert.match(sql, /CAST\(rs\.reserva_id AS CHAR\) LIKE \?/);
  assert.deepEqual(params, [7, ...Array(12).fill("%Pérez%")]);
});

test("un código de otro módulo o el número solo se buscan en forma amplia", async () => {
  for (const texto of ["TR-120", "120"]) {
    const listados = [];
    preparar({ handler: bandeja(listados) });
    const respuesta = await pedir(`/coseguro/subsidios-salud?search=${encodeURIComponent(texto)}`);
    assert.equal(respuesta.status, 200, texto);
    const [{ sql, params }] = listados;
    assert.doesNotMatch(sql, /rs\.reserva_id = \?/, texto);
    assert.equal(params.filter((p) => p === `%${texto}%`).length, 12, texto);
  }
});

test("el DNI escrito con puntos, como lo muestra la bandeja, se busca sin ellos", async () => {
  const listados = [];
  preparar({ handler: bandeja(listados) });
  const respuesta = await pedir(`/coseguro/subsidios-salud?search=${encodeURIComponent("40.759.125")}`);
  assert.equal(respuesta.status, 200);
  const [{ sql, params }] = listados;
  const likes = params.slice(1);
  assert.equal(likes.length, 12);
  // El quinto LIKE es el del documento
  assert.match(sql, /CONCAT\(u\.apellido, ', ', u\.nombre\) LIKE \? OR CAST\(u\.documento AS CHAR\) LIKE \?/);
  assert.equal(likes[4], "%40759125%");
  assert.equal(likes.filter((p) => p === "%40.759.125%").length, 11);
});

test("una búsqueda de más de 200 caracteres se rechaza sin consultar la base", async () => {
  preparar();
  const respuesta = await pedir(`/coseguro/subsidios-salud?search=${"a".repeat(201)}`);
  assert.equal(respuesta.status, 400);
  assert.equal(respuesta.body, "La búsqueda es demasiado larga");
  assert.equal(consultasDeNegocio().length, 0);
});

test("el backend devuelve el código del estado y no su nombre (lo pone el front)", async () => {
  preparar({ handler: bandeja([]) });
  const respuesta = await pedir("/coseguro/subsidios-salud");
  assert.equal(respuesta.status, 200);
  const [fila] = respuesta.body.results;
  assert.equal(fila.estado, "PENDIENTE");
  assert.equal(Object.hasOwn(fila, "estado_nombre"), false);
  assert.deepEqual(fila.transiciones, ["APROBADA_DEPARTAMENTAL", "RECHAZADA"]);
  const fuente = fs.readFileSync(path.join(__dirname, "../api/routes/coseguro.js"), "utf8");
  assert.doesNotMatch(fuente, /SUBSIDIO_ESTADO_NOMBRE|estado_nombre: SUBSIDIO/);
});

test("las notificaciones del cambio de estado nombran la reserva con su código T-", async () => {
  const avisos = [];
  preparar({
    handler: async (sql, params) => {
      if (/SELECT id, reserva_id FROM reserva_salud WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: 5, reserva_id: 120 }]];
      if (/SELECT id FROM reserva WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: 120 }]];
      if (/FROM reserva_salud rs[\s\S]+WHERE rs\.id = \?/.test(sql)) return [[{ ...subsidio }]];
      if (/UPDATE reserva_salud SET/.test(sql)) return [{ affectedRows: 1 }];
      if (/INSERT INTO historial_reserva/.test(sql)) return [{ insertId: 1, affectedRows: 1 }];
      if (/SELECT u\.id FROM usuario u INNER JOIN rol r/.test(sql)) return [[{ id: 50 }]];
      if (/INSERT INTO notificacion/.test(sql)) {
        avisos.push({ usuarioId: params[0], titulo: params[2], mensaje: params[3] });
        return [{ insertId: avisos.length, affectedRows: 1 }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });
  const respuesta = await pedir("/coseguro/subsidios-salud/5/estado", {
    method: "PUT",
    body: { estado: "APROBADA_DEPARTAMENTAL" },
  });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.deepEqual(avisos.map(({ usuarioId, titulo }) => [usuarioId, titulo]), [
    [9, "Subsidio por salud de tu reserva T-120"],
    [50, "Subsidio por salud de la reserva T-120 para aprobar"],
  ]);
});

test("el aviso de alta del subsidio usa el código T- y dice dónde se validan los certificados", async () => {
  // Ejecuta la función real de user.js; sólo se reemplazan la base y el alta de avisos
  const fuente = fs.readFileSync(path.join(__dirname, "../api/routes/user.js"), "utf8").replace(/\r\n/g, "\n");
  const inicio = fuente.indexOf("async function crearReservaSalud(");
  assert.ok(inicio >= 0);
  const fin = fuente.indexOf("\n}\n", inicio);
  assert.ok(fin > inicio);
  const avisos = [];
  const crearReservaSalud = vm.runInNewContext(`(${fuente.slice(inicio, fin + 2)})`, {
    crearNotificacion: async (_connection, aviso) => {
      avisos.push(aviso);
      return { insertId: avisos.length };
    },
  });
  const consultas = [];
  const conexionAlta = {
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/INSERT INTO reserva_salud/.test(sql)) return [{ insertId: 33 }];
      if (/SELECT u\.id FROM usuario u/.test(sql)) return [[{ id: 50 }, { id: 51 }]];
      return [{ affectedRows: 1 }];
    },
  };

  const reservaSaludId = await crearReservaSalud(conexionAlta, {
    reservaId: 120,
    usuarioId: 9,
    salud: { motivo: "Tratamiento", centro_medico: null },
    usuarioNombre: "Pérez, Ana",
  });

  assert.equal(reservaSaludId, 33);
  assert.equal(avisos.length, 2);
  for (const aviso of avisos) {
    assert.equal(aviso.titulo, "Nueva reserva por salud T-120");
    assert.equal(aviso.mensaje,
      "Pérez, Ana pidió el subsidio de alojamiento por salud. Sus certificados médicos están por validar en Coseguro médico › Subsidios por salud.");
    assert.equal(aviso.payload.estado, "PENDIENTE");
  }
  // El historial sigue guardando el código: el nombre lo pone el front
  const historial = consultas.find(({ sql }) => /INSERT INTO historial_reserva/.test(sql));
  assert.match(historial.sql, /'Subsidio por salud', NULL, 'PENDIENTE'/);
});

// ---------------------------------------------------------------------------
// Reintegros: la exportación CSV busca igual que el listado
// ---------------------------------------------------------------------------
const { condicionBusquedaSolicitudes, consultarSolicitudesParaExportar } = router.__test;

async function exportar(filtros) {
  const consultasExportacion = [];
  const dbExportacion = {
    async query(sql, params) {
      consultasExportacion.push({ sql, params });
      return [[]];
    },
  };
  await consultarSolicitudesParaExportar(dbExportacion, { id: 1, rol: "admin" }, filtros);
  assert.equal(consultasExportacion.length, 1);
  return consultasExportacion[0];
}

test("el CSV encuentra la solicitud con el «#22» que manda el front (antes salía vacío)", async () => {
  for (const search of ["#22", "C-22", "c22"]) {
    const { sql, params } = await exportar({ search });
    assert.match(sql, /s\.id = \?/, search);
    assert.doesNotMatch(sql, /CAST\(s\.id AS CHAR\) LIKE/, search);
    assert.equal(params.at(-1), 22, search);
  }
});

test("el CSV busca en las mismas columnas que el listado (departamental, estado, concepto…)", async () => {
  const { sql, params } = await exportar({ search: "Junín" });
  const esperada = condicionBusquedaSolicitudes("Junín");
  assert.ok(sql.includes(esperada.sql));
  assert.match(esperada.sql, /d\.nombre LIKE \?[\s\S]+c\.nombre LIKE \?[\s\S]+e\.nombre LIKE \?/);
  assert.equal(params.filter((p) => p === "%Junín%").length, 21);
});

test("el listado y la exportación usan la misma condición de búsqueda y los mismos alias", async () => {
  const listados = [];
  preparar({
    sesion: { id: 1, rol_id: 1, rol: "admin", departamental_id: null },
    handler: async (sql, params) => {
      listados.push({ sql, params });
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) return [[{ total: 0 }]];
      return [[]];
    },
  });
  const respuesta = await pedir(`/coseguro/solicitudes?search=${encodeURIComponent("Junín")}`);
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const esperada = condicionBusquedaSolicitudes("Junín");
  assert.equal(listados.length, 2);
  for (const { sql } of listados) assert.ok(sql.includes(esperada.sql));

  // Los alias de la condición existen en las dos consultas
  const exportacion = await exportar({ search: "Junín" });
  for (const join of [
    "INNER JOIN usuario u ON u.id = s.usuario_id",
    "LEFT JOIN usuario fam ON fam.id = s.familiar_usuario_id",
    "LEFT JOIN departamental d ON d.id = s.departamental_id",
    "LEFT JOIN coseguro_tipo_reintegro t ON t.id = s.tipo_reintegro_id",
    "LEFT JOIN coseguro_concepto c ON c.id = s.concepto_id",
    "INNER JOIN coseguro_estado e ON e.id = s.estado_id",
  ]) {
    assert.ok(listados[0].sql.includes(join), `listado: ${join}`);
    assert.ok(exportacion.sql.includes(join), `exportación: ${join}`);
  }

  // Con el código, los dos traen sólo esa solicitud
  listados.length = 0;
  const conCodigo = await pedir("/coseguro/solicitudes?search=C-22");
  assert.equal(conCodigo.status, 200);
  for (const { sql, params } of listados) {
    assert.match(sql, /s\.id = \?/);
    assert.ok(params.includes(22));
  }
});
