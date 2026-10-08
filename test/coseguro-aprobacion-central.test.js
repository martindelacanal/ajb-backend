"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "coseguro-aprobacion-test-secret";

let escenario;
const llamadas = [];
const eventos = [];
let actualizacionPendiente;
let actualizacionConfirmada;

const conexionTransaccion = {
  query: consultar,
  async beginTransaction() { eventos.push("begin"); },
  async commit() {
    eventos.push("commit");
    actualizacionConfirmada = actualizacionPendiente;
  },
  async rollback() { eventos.push("rollback"); actualizacionPendiente = null; },
  release() { eventos.push("release"); },
};
const db = {
  query: consultar,
  async getConnection() { return conexionTransaccion; },
};

function reemplazarModulo(ruta, exports) {
  const filename = require.resolve(ruta);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

reemplazarModulo("../api/connection/connection", { promise: () => db });
reemplazarModulo("../api/services/usuarios-datos", {
  async actualizarDatosUsuario() { eventos.push("datos-usuario"); },
  contextoDesdeRequest: () => ({}),
});
const sdkS3 = require("@aws-sdk/client-s3");
reemplazarModulo("@aws-sdk/client-s3", {
  ...sdkS3,
  S3Client: class {
    async send(command) {
      eventos.push(command instanceof sdkS3.DeleteObjectCommand ? "s3-delete" : "s3-put");
      return {};
    }
  },
});

const router = require("../api/routes/coseguro");
const app = express();
app.use(express.json());
app.use("/api", router);

function preparar(opciones = {}) {
  llamadas.length = 0;
  eventos.length = 0;
  actualizacionPendiente = null;
  actualizacionConfirmada = null;
  escenario = {
    rol: "admin-central",
    cuenta: { id: 10, codigo: "631.301" },
    detalleValido: true,
    ...opciones,
  };
  escenario.solicitud = {
    id: 21, usuario_id: 9, departamental_id: 7, estado_id: 4,
    tipo_reintegro_id: 1, concepto_id: 2, fecha_comprobante: "2026-01-10",
    comprobante_numero: "123456", comprobante_pto_venta: null,
    emisor_nombre: "Emisor", emisor_cuit: null, importe: 100,
    cuil_afiliado: "20301112220", cbu: "0140999861000000123452",
    importe_autorizado: null, importe_estimado: 50, porcentaje_cobertura_aplicado: 50,
    imputacion_id: null, imputacion_detalle_id: null, cic_codigo: null,
    periodo_prestacion: "2026-01", verificacion: "{}",
    ...opciones.solicitud,
  };
}

async function consultar(sql, params = []) {
  llamadas.push({ sql, params });
  if (/u\.modulo_olimpiadas[\s\S]+FROM usuario u[\s\S]+INNER JOIN rol r/.test(sql)) {
    return [[{ id: 100, rol: escenario.rol, rol_id: 5, departamental_id: 7, habilitado: "Y", area_coseguro: 1 }]];
  }
  if (/SELECT \* FROM coseguro_solicitud/.test(sql)) {
    const solicitud = { ...escenario.solicitud };
    if (/FOR UPDATE/.test(sql)) {
      if (escenario.estadoConcurrente) solicitud.estado_id = escenario.estadoConcurrente;
      if (escenario.periodoConcurrente) solicitud.periodo_prestacion = escenario.periodoConcurrente;
    }
    return [[{ ...solicitud }]];
  }
  if (/FROM coseguro_tipo_reintegro/.test(sql)) {
    return [[{ id: 1, nombre: "Consulta", requiere_pto_venta: 0, adjuntos_config: "[]", modo_cobertura: "MANUAL", ...escenario.tipo }]];
  }
  if (/FROM usuario u INNER JOIN rol r ON r.id = u.rol_id\s+WHERE u.id = \?/.test(sql)) {
    return [[{ id: params[0], rol: "afiliado", habilitado: "Y", usuario_familiar_id: null, departamental_id: 7,
      cuil: "20301112220", cbu: "0140999861000000123452", ...escenario.titular,
      ...(/FOR UPDATE/.test(sql) ? escenario.titularConcurrente : {}) }]];
  }
  if (/FROM usuario WHERE id = \? AND usuario_familiar_id = \?/.test(sql)) return [params[1] === escenario.familiarTitular ? [{ id: params[0], documento: 30111222, nombre: "Familiar", apellido: "Nuevo" }] : []];
  if (/WHERE r.nombre = \? AND u.habilitado/.test(sql)) return [[{ id: 101 }]];
  if (/WHERE r.nombre = 'departamental'/.test(sql)) return [[{ id: 102 }]];
  if (/FROM coseguro_concepto/.test(sql)) return [[{ id: 2, nombre: "Bono bioquímico" }]];
  if (/SELECT concepto_id FROM coseguro_solicitud_concepto/.test(sql)) return [[{ concepto_id: 2 }]];
  if (/(?:DELETE FROM|INSERT INTO) coseguro_solicitud_concepto/.test(sql)) return [{ affectedRows: 1 }];
  if (/SELECT id, tipo_adjunto, sha256, archivo, tamanio FROM coseguro_archivo/.test(sql)) {
    const archivos = /FOR UPDATE/.test(sql) ? escenario.archivosConcurrentes || escenario.archivos : escenario.archivos;
    return [archivos || [{ id: 3, tipo_adjunto: "FACTURA", sha256: null, archivo: "comprobante.pdf", tamanio: 100 }]];
  }
  if (/FROM coseguro_solicitud s/.test(sql)) return [[]]; // búsqueda de duplicados
  if (/FROM coseguro_archivo a/.test(sql)) return [[]];
  if (/INSERT INTO coseguro_archivo/.test(sql)) {
    if (escenario.fallaArchivo) throw new Error("Archivo no disponible");
    return [{affectedRows:1}];
  }
  if (/DELETE FROM coseguro_archivo/.test(sql)) return [{affectedRows:1}];
  if (/GET_LOCK/.test(sql)) return [[{ adquirido: 1 }]];
  if (/RELEASE_LOCK/.test(sql)) return [[{ liberado: 1 }]];
  if (/FROM coseguro_imputacion/.test(sql)) {
    if (/tipo = 'CUENTA'/.test(sql)) return [escenario.cuenta ? [escenario.cuenta] : []];
    if (/tipo = 'DETALLE'/.test(sql)) return [escenario.detalleValido && params[1] === 10 ? [{ id: params[0] }] : []];
  }
  if (/UPDATE coseguro_solicitud SET/.test(sql)) {
    actualizacionPendiente = { sql, params };
    return [{ affectedRows: 1 }];
  }
  if (/INSERT INTO coseguro_solicitud\s/.test(sql)) return [{ insertId: 22, affectedRows: 1 }];
  if (/UPDATE coseguro_solicitud s INNER JOIN coseguro_tipo_reintegro/.test(sql)) return [{ affectedRows: 1 }];
  if (/INSERT INTO coseguro_historial/.test(sql)) {
    if (escenario.fallaHistorial && params[3] === "CAMBIO_ESTADO") throw new Error("Historial no disponible");
    return [{ affectedRows: 1 }];
  }
  if (/FROM coseguro_estado/.test(sql)) return [[{ nombre: `Estado ${params[0]}` }]];
  if (/INSERT INTO notificacion/.test(sql)) return [{ affectedRows: 1 }];
  if (/INSERT INTO coseguro_observacion/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Consulta inesperada: ${sql}`);
}

async function request(body, { editar = false, crear = false } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const token = jwt.sign({ data: JSON.stringify({ id: 100, rol: escenario.rol }) }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/coseguro/solicitudes${crear ? "" : `/21${editar ? "" : "/estado"}`}`, {
      method: crear ? "POST" : "PUT",
      headers: body instanceof FormData ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function formulario(extra = {}) {
  const s = escenario.solicitud;
  return {
    tipo_reintegro_id: s.tipo_reintegro_id, concepto_id: s.concepto_id,
    fecha_comprobante: s.fecha_comprobante, comprobante_numero: s.comprobante_numero,
    emisor_nombre: s.emisor_nombre, importe: s.importe,
    cuil_afiliado: s.cuil_afiliado, cbu: s.cbu,
    ...extra,
  };
}

function camposActualizados() {
  assert.ok(actualizacionConfirmada, "debe confirmar la actualización dentro de la transacción");
  const { sql, params } = actualizacionConfirmada;
  const set = sql.slice(sql.indexOf(" SET ") + 5, sql.indexOf("WHERE"));
  const campos = [...set.matchAll(/(\w+) = (\?|NOW\(\))/g)];
  let indice = 0;
  return Object.fromEntries(campos.map(([, campo, valor]) => [campo, valor === "?" ? params[indice++] : "NOW()"]));
}

test("aprobar exige importe autorizado explícito y C.I.C. en ambos endpoints", async (t) => {
  for (const editar of [false, true]) {
    for (const faltante of ["importe", "cic"]) {
      await t.test(`${editar ? "edición" : "estado"}: falta ${faltante}`, async () => {
        preparar({ solicitud: faltante === "importe" ? { imputacion_id: 10 } : { importe_autorizado: 20 } });
        const body = editar ? formulario({ aprobar_servicios_sociales: "1" }) : { estado_id: 7 };
        const resultado = await request(body, { editar });
        assert.equal(resultado.status, 400);
        assert.match(resultado.body, faltante === "importe" ? /importe autorizado/ : /C\.I\.C\./);
        assert.equal(actualizacionConfirmada, null);
        assert.ok(eventos.includes("rollback"));
      });
    }
  }
});

test("aprobar guarda valores elegidos, código, autor y estado juntos y registra el historial", async (t) => {
  for (const editar of [false, true]) {
    for (const monto of ["0", "42.35"]) {
      await t.test(`${editar ? "edición" : "estado"}: monto ${monto}`, async () => {
        preparar({ solicitud: { importe_autorizado: 15, imputacion_id: 11, cic_codigo: "anterior" } });
        const datos = { importe_autorizado: monto, imputacion_id: "10", imputacion_detalle_id: "12" };
        const body = editar ? formulario({ ...datos, aprobar_servicios_sociales: true, emisor_nombre: "Emisor corregido" }) : { ...datos, estado_id: 7 };
        const resultado = await request(body, { editar });
        assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
        assert.equal(resultado.body.estado_id, 7);
        const campos = camposActualizados();
        assert.equal(campos.importe_autorizado, Number(monto));
        assert.equal(campos.imputacion_id, 10);
        assert.equal(campos.imputacion_detalle_id, 12);
        assert.equal(campos.cic_codigo, "631.301");
        assert.equal(campos.estado_id, 7);
        assert.equal(campos.aprobado_central_usuario_id, 100);
        assert.equal(campos.fecha_aprobacion_central, "NOW()");
        if (editar) assert.equal(campos.emisor_nombre, "Emisor corregido");
        const historial = llamadas.filter(({ sql }) => /INSERT INTO coseguro_historial/.test(sql));
        assert.ok(historial.some(({ params }) => params[3] === "UPDATE" && params[6] === "Importe autorizado"));
        assert.ok(historial.some(({ params }) => params[3] === "CAMBIO_ESTADO" && params[4] === 4 && params[5] === 7));
        assert.ok(llamadas.some(({ sql }) => /INSERT INTO notificacion/.test(sql)));
        assert.deepEqual(eventos.filter((evento) => ["begin", "commit", "rollback"].includes(evento)), ["begin", "commit"]);
      });
    }
  }
});

test("aprobar conserva datos explícitos ya guardados sin usar el importe estimado", async () => {
  preparar({ solicitud: { importe_autorizado: 23, imputacion_id: 10 } });
  const resultado = await request({ estado_id: 7 });
  assert.equal(resultado.status, 200);
  assert.equal(camposActualizados().importe_autorizado, 23);
});

test("admin puede aprobar y guardar el período de prestación opcional en ambos endpoints", async (t) => {
  for (const editar of [false, true]) {
    await t.test(editar ? "edición" : "estado", async () => {
      preparar({ rol: "admin" });
      const datos = { importe_autorizado: 20, imputacion_id: 10, periodo_prestacion: "2026-03" };
      const body = editar ? formulario({ ...datos, aprobar_servicios_sociales: true }) : { ...datos, estado_id: 7 };
      const resultado = await request(body, { editar });
      assert.equal(resultado.status, 200);
      assert.equal(camposActualizados().periodo_prestacion, "2026-03");
      assert.ok(llamadas.some(({ sql, params }) => /INSERT INTO coseguro_historial/.test(sql) && params[6] === "Período de la prestación"));
    });
  }
});

test("aprobar valida el formato del período opcional", async () => {
  preparar();
  const resultado = await request({ estado_id: 7, importe_autorizado: 20, imputacion_id: 10, periodo_prestacion: "2026-13" });
  assert.equal(resultado.status, 400);
  assert.match(resultado.body, /período de prestación/);
  assert.equal(actualizacionConfirmada, null);
});

test("edición y aprobación conservan un período legado sólo si es exactamente el valor guardado", async (t) => {
  for (const editar of [false, true]) {
    for (const conservar of [true, false]) {
      await t.test(`${editar ? "edición" : "estado"}: ${conservar ? "inalterado" : "modificado"}`, async () => {
        preparar({ solicitud: { periodo_prestacion: "Julio a agosto de 2025" } });
        const datos = {
          importe_autorizado: 20, imputacion_id: 10,
          periodo_prestacion: conservar ? "Julio a agosto de 2025" : "junio de 2025",
        };
        const body = editar ? formulario(datos) : { ...datos, estado_id: 7 };
        const resultado = await request(body, { editar });
        assert.equal(resultado.status, conservar ? 200 : 400);
        if (conservar) assert.equal(camposActualizados().periodo_prestacion, "Julio a agosto de 2025");
        else assert.equal(actualizacionConfirmada, null);
      });
    }
  }
});

test("editar vuelve a validar la igualdad del período legado con el valor bloqueado", async () => {
  preparar({ solicitud: { periodo_prestacion: "Julio de 2025" }, periodoConcurrente: "Agosto de 2025" });
  const resultado = await request(formulario({ periodo_prestacion: "Julio de 2025" }), { editar: true });
  assert.equal(resultado.status, 400);
  assert.equal(actualizacionConfirmada, null);
  assert.ok(eventos.includes("rollback"));
});

test("aprobar rechaza C.I.C. inexistente o sin código y detalles de otra cuenta", async (t) => {
  for (const editar of [false, true]) {
    for (const caso of ["cuenta inexistente", "cuenta sin código", "detalle ajeno"]) {
      await t.test(`${editar ? "edición" : "estado"}: ${caso}`, async () => {
        preparar({
          cuenta: caso === "cuenta inexistente" ? null : caso === "cuenta sin código" ? { codigo: "" } : { codigo: "631.301" },
          detalleValido: caso !== "detalle ajeno",
        });
        const datos = { importe_autorizado: 20, imputacion_id: 10, imputacion_detalle_id: 12 };
        const body = editar ? formulario({ ...datos, aprobar_servicios_sociales: 1 }) : { ...datos, estado_id: 7 };
        const resultado = await request(body, { editar });
        assert.equal(resultado.status, 400);
        assert.equal(actualizacionConfirmada, null);
        assert.ok(eventos.includes("rollback"));
      });
    }
  }
});

test("aprobar rechaza importes inválidos y IDs no enteros", async (t) => {
  for (const datos of [
    { importe_autorizado: -1, imputacion_id: 10 },
    { importe_autorizado: "1e3", imputacion_id: 10 },
    { importe_autorizado: "1.001", imputacion_id: 10 },
    { importe_autorizado: 20, imputacion_id: "10.5" },
  ]) {
    await t.test(JSON.stringify(datos), async () => {
      preparar();
      const resultado = await request({ ...datos, estado_id: 7 });
      assert.equal(resultado.status, 400);
      assert.equal(actualizacionConfirmada, null);
    });
  }
});

test("guardar sin aprobar admite campos incompletos y conserva el estado departamental", async () => {
  preparar();
  const resultado = await request(formulario({ importe_autorizado: "", imputacion_id: "", aprobar_servicios_sociales: "0" }), { editar: true });
  assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
  assert.equal(resultado.body.estado_id, 4);
  const campos = camposActualizados();
  assert.equal(campos.importe_autorizado, null);
  assert.equal(campos.imputacion_id, null);
  assert.equal(campos.imputacion_detalle_id, null);
  assert.equal(campos.cic_codigo, null);
  assert.ok(!("aprobado_central_usuario_id" in campos));
});

test("editar y aprobar sólo se permite a central/admin desde aprobado departamental", async (t) => {
  for (const caso of [
    { rol: "departamental", estado: 4, status: 403 },
    { rol: "admin", estado: 1, status: 409 },
    { rol: "admin-central", estado: 7, status: 409 },
  ]) {
    await t.test(`${caso.rol} estado ${caso.estado}`, async () => {
      preparar({ rol: caso.rol, solicitud: { estado_id: caso.estado } });
      const resultado = await request(formulario({ aprobar_servicios_sociales: true, importe_autorizado: 20, imputacion_id: 10 }), { editar: true });
      assert.equal(resultado.status, caso.status);
      assert.equal(actualizacionConfirmada, null);
    });
  }
});

test("editar y aprobar vuelve a validar la transición bajo bloqueo ante otro aprobador", async () => {
  preparar({ estadoConcurrente: 7 });
  const resultado = await request(formulario({ aprobar_servicios_sociales: true, importe_autorizado: 20, imputacion_id: 10 }), { editar: true });
  assert.equal(resultado.status, 409);
  assert.ok(eventos.includes("rollback"));
  assert.equal(actualizacionConfirmada, null);
});

test("un fallo de historial revierte datos y aprobación en ambos endpoints", async (t) => {
  for (const editar of [false, true]) {
    await t.test(editar ? "edición" : "estado", async () => {
      preparar({ fallaHistorial: true });
      const datos = { importe_autorizado: 20, imputacion_id: 10 };
      const body = editar ? formulario({ ...datos, aprobar_servicios_sociales: true }) : { ...datos, estado_id: 7 };
      const resultado = await request(body, { editar });
      assert.equal(resultado.status, 500);
      assert.equal(actualizacionConfirmada, null);
      assert.ok(eventos.includes("rollback"));
      assert.ok(!eventos.includes("commit"));
    });
  }
});

test("C.I.C. escrito por el personal selecciona la cuenta conocida o conserva un código libre", async (t) => {
  for (const editar of [false, true]) {
    for (const conocido of [false, true]) {
      await t.test(`${editar ? 'edición' : 'estado'}: ${conocido ? 'conocido' : 'libre'}`, async () => {
        preparar({ cuenta: conocido ? { id: 10, codigo: '631.301' } : null });
        const datos = { importe_autorizado: 20, imputacion_id: null, cic_codigo: conocido ? '631301' : '888.123' };
        const body = editar ? formulario({ ...datos, aprobar_servicios_sociales: true }) : { ...datos, estado_id: 7 };
        const resultado = await request(body, { editar });
        assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
        const campos = camposActualizados();
        assert.equal(campos.cic_codigo, conocido ? '631.301' : '888.123');
        assert.equal(campos.imputacion_id, conocido ? 10 : null);
        assert.equal(campos.imputacion_detalle_id, null);
      });
    }
  }
});

test("Servicios Sociales rechaza con estado 11 y motivo obligatorio; la departamental mantiene estado 5", async () => {
  preparar();
  const sinMotivo = await request({ estado_id: 11 });
  assert.equal(sinMotivo.status, 400);
  assert.equal(actualizacionConfirmada, null);
  preparar();
  const central = await request({ estado_id: 11, observacion: 'Prestación no cubierta' });
  assert.equal(central.status, 200, JSON.stringify(central.body));
  assert.equal(camposActualizados().estado_id, 11);
  assert.ok(llamadas.some((l) => /INSERT INTO coseguro_historial/.test(l.sql) && l.params[2] === 'admin-central' && l.params[5] === 11));
  preparar({ rol: 'departamental' });
  const departamental = await request({ estado_id: 11, observacion: 'Prestación no cubierta' });
  assert.equal(departamental.status, 409);
});

const archivosFactura = (cantidad) => Array.from({length:cantidad},(_,i) => ({id:i+1,tipo_adjunto:"FACTURA",sha256:null,archivo:`factura${i}.pdf`,tamanio:100}));
function formularioConArchivo(slot = "FACTURA", extra = {}) {
  const form = new FormData();
  for (const [key,value] of Object.entries(formulario(extra))) form.append(key,String(value));
  form.append(slot,new Blob(["%PDF-1.4\ncomprobante de prueba"],{type:"application/pdf"}),"factura.pdf");
  return form;
}

test("editar rechaza el sexto comprobante y revalida el acumulado luego de bloquear la solicitud", async () => {
  preparar({archivos:archivosFactura(5)});
  const sexto = await request(formularioConArchivo(),{editar:true});
  assert.equal(sexto.status,400);
  assert.match(sexto.body,/hasta 5 archivos/);
  assert.ok(!eventos.includes("begin"));
  preparar({archivos:archivosFactura(4),archivosConcurrentes:archivosFactura(5)});
  const concurrente = await request(formularioConArchivo(),{editar:true});
  assert.equal(concurrente.status,400);
  assert.ok(eventos.includes("begin") && eventos.includes("rollback"));
  assert.ok(llamadas.some(({sql}) => /coseguro_archivo WHERE solicitud_id = \? FOR UPDATE/.test(sql)));
  assert.ok(!eventos.includes("s3-put"));
  assert.equal(actualizacionConfirmada,null);
});

test("editar permite reemplazar un comprobante de cinco y acepta OTROS_COMPROBANTES", async () => {
  preparar({archivos:archivosFactura(5)});
  const reemplazo = await request(formularioConArchivo("FACTURA",{archivos_eliminados:"[1]"}),{editar:true});
  assert.equal(reemplazo.status,200,JSON.stringify(reemplazo.body));
  assert.ok(llamadas.some(({sql,params}) => /DELETE FROM coseguro_archivo/.test(sql) && params[0] === 1 && params[1] === 21));
  assert.ok(llamadas.some(({sql,params}) => /INSERT INTO coseguro_archivo/.test(sql) && params[1] === "FACTURA"));
  assert.ok(eventos.includes("commit") && eventos.includes("s3-put") && !eventos.includes("s3-delete"));
  preparar({archivos:archivosFactura(5)});
  const otro = await request(formularioConArchivo("OTROS_COMPROBANTES"),{editar:true});
  assert.equal(otro.status,200,JSON.stringify(otro.body));
  assert.ok(llamadas.some(({sql,params}) => /INSERT INTO coseguro_archivo/.test(sql) && params[1] === "OTROS_COMPROBANTES"));
});

test("editar elimina la copia S3 subida si falla su persistencia y revierte la transacción", async () => {
  preparar({fallaArchivo:true});
  const response = await request(formularioConArchivo("OTROS_COMPROBANTES"),{editar:true});
  assert.equal(response.status,500);
  assert.ok(eventos.includes("rollback"));
  assert.ok(eventos.indexOf("s3-delete") > eventos.indexOf("s3-put"));
  assert.equal(actualizacionConfirmada,null);
});

test("cobertura automática conserva foto histórica y admite autorizado distinto al sugerido", async () => {
  preparar({ tipo: { modo_cobertura: "PORCENTAJE", porcentaje_cobertura: 90, tope_reintegro: 1000 },
    solicitud: { modo_cobertura_aplicado: "PORCENTAJE", porcentaje_cobertura_aplicado: 50, importe_estimado: 40,
      tope_reintegro_aplicado: 40, cobertura_origen_aplicado: "CONFIGURACION", cobertura_fecha_aplicada: "2026-01-10 10:00:00" } });
  const respuesta = await request(formulario({ importe: 200, importe_autorizado: 75, cic_codigo: "631.301", aprobar_servicios_sociales: true }), { editar: true });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const campos = camposActualizados();
  assert.equal(campos.importe_autorizado, 75);
  assert.equal(campos.importe_estimado, 40);
  assert.equal(campos.porcentaje_cobertura_aplicado, 50);
  assert.equal(campos.tope_reintegro_aplicado, 40);
  assert.equal(campos.cobertura_fecha_aplicada, "2026-01-10 10:00:00");
});

test("departamental guarda y aprueba desde iniciada con auditoría y notificaciones", async () => {
  preparar({ rol: "departamental", solicitud: { estado_id: 1 } });
  const respuesta = await request(formulario({ aprobar_departamental: true }), { editar: true });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  assert.equal(camposActualizados().estado_id, 4);
  assert.equal(camposActualizados().aprobado_departamental_usuario_id, 100);
  assert.ok(llamadas.some(({ sql, params }) => /INSERT INTO coseguro_historial/.test(sql) && params[3] === "CAMBIO_ESTADO" && params[4] === 1 && params[5] === 4));
  assert.ok(llamadas.some(({ sql, params }) => /INSERT INTO notificacion/.test(sql) && params[1] === "COSEGURO_PARA_CONTROL"));
});

test("aprobación departamental rechaza obligatorios incompletos y no persiste", async () => {
  for (const editar of [false, true]) {
    preparar({ rol: "departamental", solicitud: { estado_id: 1, cbu: null } });
    const respuesta = await request(editar ? formulario({ aprobar_departamental: true }) : { estado_id: 4 }, { editar });
    assert.equal(respuesta.status, 400);
    assert.match(respuesta.body, /CBU/);
    assert.equal(actualizacionConfirmada, null);
  }
});

test("reasignación valida jurisdicción bajo bloqueo, familiar nuevo y origen inmutable", async () => {
  preparar({ rol: "departamental", familiarTitular: 12, solicitud: { usuario_original_id: 8, firma_archivo: "firma-original.png" } });
  const respuesta = await request(formulario({ usuario_id: 12, usuario_original_id: 999, familiar_usuario_id: 13 }), { editar: true });
  assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
  const campos = camposActualizados();
  assert.equal(campos.usuario_id, 12);
  assert.equal(campos.familiar_usuario_id, 13);
  assert.equal(campos.firma_archivo, null);
  assert.ok(!("usuario_original_id" in campos));
  const notificaciones = llamadas.filter(({ sql, params }) => /INSERT INTO notificacion/.test(sql) && params[1] === "COSEGURO_REASIGNADA");
  assert.deepEqual(notificaciones.map(({params}) => params[0]), [8, 9, 12]);
  assert.equal(JSON.parse(notificaciones[0].params[4]).reasignacion, "saliente");
  assert.equal(JSON.parse(notificaciones[2].params[4]).reasignacion, "entrante");
  preparar({ rol: "departamental", titularConcurrente: { departamental_id: 99 } });
  const concurrente = await request(formulario({ usuario_id: 12 }), { editar: true });
  assert.equal(concurrente.status, 403);
  assert.ok(eventos.includes("rollback"));
  assert.equal(actualizacionConfirmada, null);
});

test("reasignar al mismo afiliado no notifica; otro familiar titular se rechaza", async () => {
  preparar({ rol: "departamental" });
  const igual = await request(formulario({ usuario_id: 9 }), { editar: true });
  assert.equal(igual.status, 200);
  assert.ok(!llamadas.some(({ sql, params }) => /INSERT INTO notificacion/.test(sql) && params[1] === "COSEGURO_REASIGNADA"));
  preparar({ rol: "departamental", familiarTitular: 9 });
  const familiarViejo = await request(formulario({ usuario_id: 12, familiar_usuario_id: 13 }), { editar: true });
  assert.equal(familiarViejo.status, 400);
  assert.match(familiarViejo.body, /no figura a cargo/);
  assert.equal(actualizacionConfirmada, null);
});

test("reasignación no traslada CUIL/CBU anterior a un perfil distinto", async () => {
  preparar({ rol: "departamental", titular: { cuil: "20111111112", cbu: "otro" } });
  const respuesta = await request(formulario({ usuario_id: 12 }), { editar: true });
  assert.equal(respuesta.status, 400);
  assert.match(respuesta.body, /no se pueden trasladar/);
  assert.equal(actualizacionConfirmada, null);
});

test("reasignación y notificaciones quedan juntas en transacción y puede volver al original", async () => {
  preparar({ rol: "departamental", solicitud: { usuario_id: 12, usuario_original_id: 9 } });
  const respuesta = await request(formulario({ usuario_id: 9 }), { editar: true });
  assert.equal(respuesta.status, 200);
  assert.equal(camposActualizados().usuario_id, 9);
  const notificaciones = llamadas.filter(({ sql, params }) => /INSERT INTO notificacion/.test(sql) && params[1] === "COSEGURO_REASIGNADA");
  assert.deepEqual(notificaciones.map(({params}) => params[0]), [9, 12]);
  preparar({ rol: "departamental", solicitud: { estado_id: 1 }, fallaHistorial: true });
  const falla = await request(formulario({ usuario_id: 12, aprobar_departamental: true }), { editar: true });
  assert.equal(falla.status, 500);
  assert.equal(actualizacionConfirmada, null);
  assert.ok(eventos.includes("rollback"));
});

test("departamental crea y aprueba en una transacción y no crea para otra departamental", async () => {
  preparar({ rol: "departamental" });
  const respuesta = await request(formularioConArchivo("FACTURA", { usuario_id: 9, aprobar_departamental: true, forzar_antiguedad: 1 }), { crear: true });
  assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
  assert.equal(respuesta.body.estado_id, 4);
  const insercion = llamadas.find(({sql}) => /INSERT INTO coseguro_solicitud\s/.test(sql));
  assert.equal(insercion.params.length, 29);
  assert.equal(insercion.params[4], 4);
  assert.equal(insercion.params[24], 9);
  assert.equal(insercion.params[28], "CONFIGURACION");
  assert.ok(eventos.includes("commit"));
  assert.ok(llamadas.some(({sql,params}) => /INSERT INTO notificacion/.test(sql) && params[1] === "COSEGURO_PARA_CONTROL"));
  preparar({ rol: "departamental", titular: { departamental_id: 99 } });
  const otra = await request(formularioConArchivo("FACTURA", { usuario_id: 12, aprobar_departamental: true }), { crear: true });
  assert.equal(otra.status, 403);
  assert.ok(!eventos.includes("commit"));
});
