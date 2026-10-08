"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { PassThrough } = require("node:stream");
const { LIMITES_ARCHIVOS, completarAdjuntos } = require("../api/data/coseguro-limites-archivos");
const { validarLimitesArchivos, manejarUploadCoseguro, almacenamientoCoseguro } = require("../api/routes/coseguro").__test;

const archivo = (slot, size = 100) => ({ fieldname: slot, size });
const existente = (id, slot, tamanio = 100) => ({ id, tipo_adjunto: slot, tamanio });

test("límites publicados coinciden con 5 archivos por tipo, 20 por solicitud y 5/50 MiB", () => {
  assert.deepEqual(LIMITES_ARCHIVOS, { por_tipo: 5, total: 20, peso_archivo_bytes: 5242880, peso_total_bytes: 52428800 });
  assert.deepEqual(completarAdjuntos([{key:"OTROS_COMPROBANTES",label:"viejo"}]), [{key:"OTROS_COMPROBANTES",label:"Otros comprobantes",requerido:0}]);
});

test("los límites contemplan todos los comprobantes existentes menos eliminados más nuevos", () => {
  const previos = Array.from({length:5}, (_,i) => existente(i+1,"FACTURA",5242880));
  assert.throws(() => validarLimitesArchivos([archivo("FACTURA")],previos), /hasta 5 archivos/);
  assert.deepEqual(validarLimitesArchivos([archivo("FACTURA",5242880)],previos,[1]), {cantidad:5,peso_total_bytes:26214400});
  assert.throws(() => validarLimitesArchivos([archivo("FACTURA")],previos,[99]), /hasta 5 archivos/);
  const veinte = ["FACTURA","RECETA","PRESCRIPCION","OTROS_COMPROBANTES"].flatMap((slot,j) => Array.from({length:5},(_,i) => existente(5*j+i+1,slot)));
  assert.equal(validarLimitesArchivos([],veinte).cantidad,20);
  assert.throws(() => validarLimitesArchivos([archivo("DOCUMENTACION")],veinte),/hasta 20 archivos/);
  assert.equal(validarLimitesArchivos([archivo("DOCUMENTACION")],veinte,[1]).cantidad,20);
});

test("el peso acumulado se valida con los archivos vigentes y respeta exactamente 50 MiB", () => {
  const previos = ["FACTURA","RECETA"].flatMap((slot,j) => Array.from({length:5},(_,i) => existente(5*j+i+1,slot,5242880)));
  assert.equal(validarLimitesArchivos([],previos).peso_total_bytes,52428800);
  assert.throws(() => validarLimitesArchivos([archivo("DOCUMENTACION",1)],previos),/50 MB/);
  assert.equal(validarLimitesArchivos([archivo("DOCUMENTACION",5242880)],previos,[1]).peso_total_bytes,52428800);
  for (const size of [0,5242881,-1,NaN]) assert.throws(() => validarLimitesArchivos([archivo("FACTURA",size)]),/5 MB/);
  assert.throws(() => validarLimitesArchivos([archivo("NO_VALIDO")]),/no permitido/);
  assert.equal(validarLimitesArchivos([archivo("OTROS_COMPROBANTES")]).cantidad,1);
});

async function cargar(files, path = "/coseguro/solicitudes") {
  const app = express();
  app.post(path, manejarUploadCoseguro, (req,res) => res.json({cantidad:req.files.length,slots:req.files.map((f) => f.fieldname)}));
  const server = app.listen(0,"127.0.0.1");
  await new Promise((resolve) => server.once("listening",resolve));
  try {
    const form = new FormData();
    for (const file of files) {
      const buffer = Buffer.alloc(file.size ?? 9);
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(buffer);
      form.append(file.slot,new Blob([buffer],{type:file.mime || "image/png"}),"foto.png");
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:"POST",body:form});
    return {status:response.status,body:await response.json()};
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("Multer permite cinco archivos en la misma casilla y rechaza el sexto", async () => {
  const cinco = Array.from({length:5},() => ({slot:"FACTURA"}));
  assert.equal((await cargar(cinco)).status,200);
  const excedido = await cargar([...cinco,{slot:"FACTURA"}]);
  assert.equal(excedido.status,400);
  assert.match(excedido.body,/5 archivos por tipo/);
});

test("Multer rechaza archivos mayores de 5 MiB, formatos falsos y casillas desconocidas", async () => {
  const grande = await cargar([{slot:"FACTURA",size:5242881}]);
  assert.equal(grande.status,400);
  assert.match(grande.body,/5 MB/);
  assert.equal((await cargar([{slot:"FACTURA",mime:"application/pdf"}])).status,400);
  assert.equal((await cargar([{slot:"NO_VALIDO"}])).status,400);
  assert.equal((await cargar([{slot:"OTROS_COMPROBANTES"}])).status,200);
  // Extracción y certificados comparten middleware y conservan su campo genérico.
  assert.equal((await cargar([{slot:"archivo"}],"/coseguro/extraer-comprobante")).status,200);
});

test("Multer permite veinte archivos por lote y rechaza el número veintiuno", async () => {
  const veinte = ["FACTURA","RECETA","PRESCRIPCION","OTROS_COMPROBANTES"].flatMap((slot) => Array.from({length:5},() => ({slot})));
  assert.equal((await cargar(veinte)).status,200);
  const excedido = await cargar([...veinte,{slot:"DOCUMENTACION"}]);
  assert.equal(excedido.status,400);
  assert.match(excedido.body,/20 archivos/);
});

test("el almacenamiento corta el peso total durante la recepción y elimina buffers temporales", async () => {
  const storage = almacenamientoCoseguro();
  const req = {coseguroBytesRecibidos:52428800-1};
  const stream = new PassThrough();
  const resultado = new Promise((resolve) => storage._handleFile(req,{stream},(error,info) => resolve({error,info})));
  stream.end(Buffer.alloc(2));
  const {error,info} = await resultado;
  assert.match(error.message,/50 MB/);
  assert.equal(info,undefined);
  const file = {buffer:Buffer.alloc(10)};
  await new Promise((resolve,reject) => storage._removeFile(req,file,(error) => error ? reject(error) : resolve()));
  assert.equal(file.buffer,undefined);
});
