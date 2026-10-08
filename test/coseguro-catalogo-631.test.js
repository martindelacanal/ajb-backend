"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { TIPOS, GRUPOS, normalizarCicCodigo } = require('../api/data/coseguro-catalogo-631');
const { seleccionarTipoLegado, seleccionarConceptosLegados, resolverImputacionMigrada } = require('../scripts/migrar-coseguro-catalogo-631');
const { validarDatosSolicitud, validarCamposCentral, parsearCamposCentral, filtrosEstadisticas, transicionesDisponibles, completarConceptosSolicitudes } = require('../api/routes/coseguro').__test;
const { mapearTipoReintegroPublico } = require('../api/services/publico');

test('catálogo reproduce las 29 cuentas con nombre del Excel, sin rubros ni códigos vacíos', () => {
  const codigos = ['631.103','631.105','631.202','631.203','631.205','631.206','631.301','631.401','631.402','631.403','631.501','631.502','631.503','631.504','631.505','631.601','631.602','631.603','631.604','631.605','631.606','631.607','631.608','631.609','631.611','631.612','631.613','631.614','511.701'];
  assert.deepEqual(TIPOS.map((t) => t.codigo).sort(), codigos.sort());
  assert.equal(TIPOS.flatMap((t) => t.conceptos).length, 16);
  assert.equal(TIPOS.filter((t) => t.conceptos.length).length, 6);
  assert.deepEqual(TIPOS.find((t) => t.codigo === '631.602').conceptos, ['Terapia familiar y otras','Terapia individual']);
  assert.equal(TIPOS.find((t) => t.codigo === '631.605').nombre, 'Armazón');
  for (const tipo of TIPOS) assert.ok(GRUPOS.some((g) => g.codigo === tipo.grupo_codigo));
  assert.deepEqual(TIPOS.map((t) => t.nombre), TIPOS.map((t) => t.nombre).sort((a,b) => a.localeCompare(b,'es')));
});

test('C.I.C. admite entero o punto, normaliza 6 dígitos y rechaza formatos ambiguos', () => {
  for (const [entrada, esperado] of [['631602','631.602'],[631602,'631.602'],[' 631.602 ','631.602'],['123','123'],['123.4','123.4']]) assert.equal(normalizarCicCodigo(entrada), esperado);
  for (const entrada of ['1e3','1.2.3','-1','1,2','1 2','ABC','123456789012345678901', {}, null]) assert.equal(normalizarCicCodigo(entrada), null);
});

function baseSolicitud(extra) {
  return { tipo_reintegro_id: 1, fecha_comprobante: new Date().toISOString().slice(0,10), comprobante_numero:'123456', emisor_nombre:'Profesional', importe:'100', cuil_afiliado:'20301112220', cbu:'0140999861000000123452', ...extra };
}
function dbConceptos(conceptos) {
  return { async query(sql) {
    if (/FROM coseguro_tipo_reintegro/.test(sql)) return [[{id:1, requiere_pto_venta:0, adjuntos_config:'[]', imputacion_id:10, modo_cobertura:'MANUAL'}]];
    if (/FROM coseguro_concepto/.test(sql)) return [conceptos];
    throw Error(sql);
  } };
}

test('validación conserva varios conceptos del tipo y descarta combinaciones ajenas', async () => {
  const db = dbConceptos([{id:2,nombre:'Terapia familiar y otras'},{id:3,nombre:'Terapia individual'}]);
  const valida = await validarDatosSolicitud(db, {rol:'afiliado'}, baseSolicitud({concepto_ids:'[3,2,3]'}), {});
  assert.deepEqual(valida.errores, []);
  assert.deepEqual(valida.concepto_ids, [2,3]);
  assert.equal(valida.datos.concepto_id, 2);
  const ajena = await validarDatosSolicitud(db, {rol:'afiliado'}, baseSolicitud({concepto_ids:[2,99]}), {});
  assert.ok(ajena.errores.some((e) => /pertenecer/.test(e)));
  const vacia = await validarDatosSolicitud(db, {rol:'afiliado'}, baseSolicitud({concepto_ids:[]}), {});
  assert.ok(vacia.errores.some((e) => /al menos un concepto/.test(e)));
  const sinConceptos = await validarDatosSolicitud(dbConceptos([]), {rol:'afiliado'}, baseSolicitud({concepto_ids:'[]'}), {});
  assert.deepEqual(sinConceptos.errores, []);
  assert.equal(sinConceptos.datos.concepto_id, null);
});

test('C.I.C. libre aprobado se guarda con id nulo; código existente asigna su cuenta', async () => {
  const libre = await validarCamposCentral({async query(){return [[]]}}, {importe_autorizado:10}, parsearCamposCentral({cic_codigo:'123456',imputacion_id:null}), {aprobar:true});
  assert.equal(libre.cic_codigo,'123.456');
  assert.equal(libre.imputacion_id,null);
  const conocido = await validarCamposCentral({async query(){return [[{id:10,codigo:'631.602'}]]}}, {importe_autorizado:10}, parsearCamposCentral({cic_codigo:'631602',imputacion_id:null}), {aprobar:true});
  assert.equal(conocido.cic_codigo,'631.602');
  assert.equal(conocido.imputacion_id,10);
  assert.throws(() => parsearCamposCentral({cic_codigo:'1e3'}), (e) => e.statusCode === 400);
});

test('filtros multidepartamental, conceptos asociados y C.I.C. libre respetan el ámbito departamental', () => {
  const filtros = {departamental_ids:'[7,9]',concepto_id:3,cic_codigo:'888123'};
  const central = filtrosEstadisticas({rol:'admin-central'}, filtros);
  assert.match(central.where,/departamental_id IN \(\?,\?\)/);
  assert.match(central.where,/EXISTS.*solicitud_concepto/);
  assert.ok(central.params.includes('888.123'));
  const depto = filtrosEstadisticas({rol:'departamental',departamental_id:4}, filtros);
  assert.ok(depto.params.includes(4));
  assert.ok(!depto.params.includes(7) && !depto.params.includes(9));
  assert.deepEqual(filtrosEstadisticas({rol:'admin'},{departamental_id:[7,9]}).params,[7,9]);
});

test('rechazo de Servicios Sociales es terminal y no se ofrece a departamental ni afiliado', () => {
  assert.ok(transicionesDisponibles({rol:'admin-central'},4,false).includes(11));
  assert.ok(transicionesDisponibles({rol:'admin'},4,false).includes(11));
  assert.ok(!transicionesDisponibles({rol:'departamental'},4,false).includes(11));
  for (const rol of ['admin','admin-central','departamental','afiliado','auditor']) assert.deepEqual(transicionesDisponibles({rol},11,true),[]);
});

test('lectura de solicitudes y catálogo público incluyen todos los conceptos alfabéticamente', async () => {
  const solicitudes=[{id:1,concepto:'anterior'},{id:2}];
  await completarConceptosSolicitudes({async query(){return [[{solicitud_id:1,id:2,nombre:'Familiar'},{solicitud_id:1,id:3,nombre:'Individual'}]]}}, solicitudes);
  assert.deepEqual(solicitudes[0].concepto_ids,[2,3]);
  assert.equal(solicitudes[0].concepto,'Familiar, Individual');
  assert.deepEqual(solicitudes[1].conceptos,[]);
  const publico=mapearTipoReintegroPublico({id:1,nombre:'Psicología',grupo_codigo:'631.600',grupo_nombre:'Otras prestaciones',grupo_icono:'psychology',conceptos:'[{"id":3,"nombre":"Individual"},{"id":2,"nombre":"Familiar"}]'});
  assert.equal(publico.grupo_codigo,'631.600');
  assert.deepEqual(publico.conceptos.map((c) => c.nombre),['Familiar','Individual']);
});

test('migración corrige tipo genérico desde concepto previo y conserva subtipos IOMA', () => {
  const tipo=seleccionarTipoLegado({tipo_reintegro_id:10,concepto_id:7},[{id:10,codigo:'631.611'}],[{id:7,codigo:'631.603',nombre:'Enfermería'}]);
  assert.equal(tipo.codigo,'631.603');
  const conceptos=[{id:20,nombre:'Con cobertura IOMA',tipo_reintegro_id:9},{id:21,nombre:'Sin cobertura IOMA',tipo_reintegro_id:9}];
  assert.deepEqual(seleccionarConceptosLegados({id:9,codigo:'631.206',conceptos:['Con cobertura IOMA','Sin cobertura IOMA']},{},{nombre:'Prácticas sin cobertura del IOMA'},null,conceptos),[21]);
});

test('remigrar conserva la cuenta conocida reasignada por el personal y los códigos libres', () => {
  const tipos=[{codigo:'631.602',imputacion_id:10},{codigo:'631.203',imputacion_id:11}];
  const tipo={codigo:'631.602',imputacion_id:10};
  assert.deepEqual(resolverImputacionMigrada({cic_codigo:'631.203'},{grupo_codigo:'631.600'},tipo,tipos),{codigo:'631.203',imputacionId:11});
  assert.deepEqual(resolverImputacionMigrada({cic_codigo:'888123'},{grupo_codigo:'631.600'},tipo,tipos),{codigo:'888.123',imputacionId:null});
  assert.deepEqual(resolverImputacionMigrada({cic_codigo:'631.203'},{grupo_codigo:null},tipo,tipos),{codigo:'631.602',imputacionId:10});
});
