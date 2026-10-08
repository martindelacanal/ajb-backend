"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "historial-listado-test";
let sesion;
const consultas = [];
const db = {
  async query(sql,params) {
    if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u/.test(sql)) return [[sesion]];
    consultas.push({sql,params});
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{total:0}]];
    if (/FROM coseguro_solicitud s/.test(sql)) return [[]];
    throw Error(`Consulta inesperada: ${sql}`);
  },
};
const connectionPath = require.resolve("../api/connection/connection");
require.cache[connectionPath] = {id:connectionPath,filename:connectionPath,loaded:true,exports:{promise:() => db}};
const app = express();
app.use("/api",require("../api/routes/coseguro"));

async function listado(rol,query,extra = {}) {
  consultas.length = 0;
  sesion = {id:9,rol,rol_id:3,departamental_id:7,habilitado:"Y",area_coseguro:1,modulo_coseguro:1,...extra};
  const server = app.listen(0,"127.0.0.1");
  await new Promise((resolve) => server.once("listening",resolve));
  try {
    const token = jwt.sign({data:JSON.stringify({id:9,rol})},process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/coseguro/solicitudes?${query}`,{headers:{authorization:`Bearer ${token}`}});
    return {status:response.status,body:await response.json()};
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("historial filtrado por afiliado entrega paginación y mantiene todos los filtros del listado", async () => {
  const response = await listado("admin-central","usuario_id=12&page=2&pageSize=25&concepto_id=3&cic_codigo=631200&estado_id=4&fecha_solicitud_desde=2026-01-01&importe_min=10&orderBy=fecha_comprobante&orderType=asc");
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{results:[],totalItems:0,page:2,pageSize:25});
  assert.ok(consultas.every(({params}) => params.includes(12)));
  assert.match(consultas[1].sql,/ORDER BY s\.fecha_comprobante ASC/);
  assert.deepEqual(consultas[1].params.slice(-2),[25,25]);
  for (const fragmento of [/s\.usuario_id = \?/,/cic_codigo = \?/,/solicitud_concepto/,/DATE\(s\.fecha_creacion\) >= \?/]) assert.match(consultas[0].sql,fragmento);
});

test("el filtro de afiliado no amplía el ámbito de su departamental", async () => {
  assert.equal((await listado("departamental","usuario_id=12&departamental_ids=8,9")).status,200);
  assert.match(consultas[0].sql,/s\.departamental_id = \?/);
  assert.deepEqual(consultas[0].params,[7,12]);
});

test("un afiliado sólo puede listar sus propios trámites aunque cambie usuario_id", async () => {
  assert.equal((await listado("afiliado","usuario_id=12")).status,200);
  assert.deepEqual(consultas[0].params,[9]);
  assert.match(consultas[0].sql,/s\.usuario_id = \?/);
});

test("historial del auditor conserva el ámbito de estados autorizados", async () => {
  assert.equal((await listado("auditor","usuario_id=12")).status,200);
  assert.deepEqual(consultas[0].params,[7,8,9,10,12]);
  assert.match(consultas[0].sql,/s\.estado_id IN \(\?, \?, \?, \?\)/);
});

test("historial rechaza filtros inválidos y usuarios sin área antes de consultar trámites", async () => {
  assert.equal((await listado("admin-central","usuario_id=1e3")).status,400);
  assert.equal(consultas.length,0);
  assert.equal((await listado("admin-central","usuario_id=12",{area_coseguro:0})).status,401);
  assert.equal(consultas.length,0);
});
