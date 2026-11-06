"use strict";

// Integración optativa sobre develop: todas las escrituras se revierten.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  M = require("./migrar-webauthn-v1");
const env = M.parsearBloquesEnv(fs.readFileSync(".env", "utf8")).develop;
if (!["localhost", "127.0.0.1"].includes(env.DB_HOST)) throw Error("Se requiere MySQL local de desarrollo");
Object.assign(process.env, env);
const {
    operar
  } = require("../api/services/recepcion"),
  U = require("../predios/lib/util");
(async () => {
  const c = await require("mysql2/promise").createConnection({
    ...M.crearOpcionesConexion(env),
    dateStrings: true,
    decimalNumbers: true
  });
  try {
    await c.beginTransaction();
    const [[predio]] = await c.query("SELECT * FROM predio WHERE codigo='MIRAMAR'");
    const actor = {
      id: 1,
      rol: "ADMIN",
      nombre: "Prueba local"
    };
    const call = (k, b) => operar(c, predio, actor, k, b);
    const o = await call("opciones", {}),
      servicio = o.servicios.find(x => x.codigo === "MIRAMAR_CAMPING");
    const p = {
      dni: "99874561",
      nombre: "Prueba",
      apellido: "Recepción",
      fecha_nacimiento: "1990-05-06",
      parentesco_id: 1,
      tipo_persona_id: 4,
      entrada: U.hoy()
    };
    const b = {
      tipo: "CONTINGENTE",
      entidad: "Grupo de prueba",
      cantidad: 24,
      servicio_id: servicio.id,
      titular_dni: p.dni,
      particular: p,
      fecha_inicio: U.hoy(),
      fecha_fin: U.hoy(),
      manual: 0,
      personas: [p],
      operacion: U.uuid()
    };
    assert.equal((await call("cotizar", b)).total, 0);
    assert.equal((await call("familia", {
      q: p.dni
    })).titular, null);
    const alta = await call("guardar", b);
    assert.equal(alta.estado, "Aprobada");
    assert.equal(alta.cantidad, 24);
    assert.equal((await call("guardar", b)).id, alta.id);
    const d = await call("detalle", {
      id: alta.id
    });
    assert.equal(d.historial.length, 1);
    assert.match(d.historial[0].fecha, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "Recepción muestra hora civil, igual que los movimientos de caja");
    const dia = await call("listar", { q: String(alta.id), desde: U.hoy(), hasta: U.hoy() });
    assert.equal(dia.filas[0].fecha_fin, U.hoy());
    assert.equal((await call("listar", { q: String(alta.id), desde: U.sumarDias(U.hoy(), 1) })).cantidad, 0);
    await assert.rejects(call("cotizar", { ...b, tipo: "PASA_EL_DIA", fecha_fin: U.sumarDias(U.hoy(), 1) }), /mismo día/);
    const menor = { ...p, dni: "99874560", nombre: "Menor", fecha_nacimiento: U.sumarDias(U.hoy(), -3650) };
    await assert.rejects(call("cotizar", { ...b, titular_dni: menor.dni, particular: menor, personas: [menor] }), /adulto/);
    const edit = {
      ...b,
      id: alta.id,
      version: d.reserva.version,
      manual: 150,
      motivo: "Ampliación",
      cantidad: 26,
      operacion: U.uuid()
    };
    const propuesta = await call("cotizar", edit);
    await assert.rejects(call("guardar", { ...edit, manual: 175, cotizacion_esperada: propuesta.cotizacion_esperada }), /importe cambió/);
    assert.equal((await call("guardar", { ...edit, cotizacion_esperada: propuesta.cotizacion_esperada })).diferencia, 150);
    await assert.rejects(call("guardar", {
      ...edit,
      operacion: U.uuid()
    }), /modificó/);
    await assert.rejects(operar(c, {
      ...predio,
      servicio_codigos: '["OTRO"]'
    }, actor, "detalle", {
      id: alta.id
    }), /asignados/);
    const [[u]] = await c.query("SELECT password,habilitado FROM usuario WHERE documento=?", [p.dni]);
    assert.equal(u.password, null);
    assert.equal(u.habilitado, "N");
    assert.equal((await call("listar", {
      q: String(alta.id),
      atipicas: "1"
    })).cantidad, 1);
    const rec = o.recursos.find(x => x.servicio_id === servicio.id);
    const fin = U.hoy(),
      ini = U.sumarDias(fin, -3),
      comp = {
        ...p,
        dni: "99874562",
        nombre: "Acompañante",
        parentesco_id: 5,
        entrada: U.sumarDias(fin, -2),
        salida: U.sumarDias(fin, -1)
      };
    const normal = {
      ...b,
      tipo: "GENERAL",
      cantidad: 2,
      manual: null,
      regimen_id: 3,
      recurso_id: rec.id,
      fecha_inicio: ini,
      fecha_fin: fin,
      personas: [{
        ...p,
        entrada: ini
      }, comp],
      operacion: U.uuid()
    };
    const tarifa = await call("cotizar", normal);
    assert.ok(tarifa.total > 0);
    assert.equal(tarifa.personas[0].precio, 3 * tarifa.personas[1].precio);
    await assert.rejects(call("cotizar", {
      ...normal,
      manual: 0
    }), /Justific/);
    const camp = await call("guardar", normal);
    assert.ok(camp.numero_parcela > 0);
    assert.equal(camp.precio_total, tarifa.total);
    const despues = (await call("detalle", {id: camp.id})).reserva;
    await assert.rejects(call("cotizar", { ...normal, id: camp.id, version: despues.version, personas: [normal.personas[0], {...comp, salida: null}] }), /salida registrada/);
    await assert.rejects(call("cotizar", { ...normal, id: camp.id, version: despues.version, personas: [{...p, entrada: null}, comp] }), /check-in/);
    const deducida = await call("cotizar", {
      ...normal,
      id: camp.id,
      version: (await call("detalle", {
        id: camp.id
      })).reserva.version,
      manual: 0,
      motivo: "Falta de agua caliente"
    });
    assert.equal(deducida.diferencia, -tarifa.total);
    const cabanas = o.servicios.find(s => s.codigo === "MIRAMAR_CABANAS");
    const visita = { ...b, servicio_id: cabanas.id, fecha_inicio: ini, fecha_fin: fin, personas: [{ ...p, entrada: ini }] };
    const libres = [];
    for (const rec of o.recursos.filter(x => x.servicio_id === cabanas.id)) {
      try { await call("cotizar", { ...visita, recurso_id: rec.id }); libres.push(rec.id); }
      catch (e) { if (e.status !== 409) throw e; }
      if (libres.length === 2) break;
    }
    assert.equal(libres.length, 2, "Se requieren dos recursos libres en la base local");
    const moved = await call("guardar", { ...visita, recurso_id: libres[0], operacion: U.uuid() });
    const traslado = U.sumarDias(fin, -1);
    await call("guardar", { ...visita, operacion: U.uuid(), id: moved.id, version: (await call("detalle", {id:moved.id})).reserva.version, recurso_id: libres[1], traslado });
    const antesTraslado = { ...visita, fecha_inicio: ini, fecha_fin: traslado };
    await assert.rejects(call("cotizar", { ...antesTraslado, recurso_id:libres[0] }), /ya tiene una reserva/);
    await call("cotizar", { ...antesTraslado, recurso_id:libres[1] });
    const despuesTraslado = { ...visita, fecha_inicio: traslado, personas:[{...p, entrada:traslado}] };
    await call("cotizar", { ...despuesTraslado, recurso_id:libres[0] });
    await assert.rejects(call("cotizar", { ...despuesTraslado, recurso_id:libres[1] }), /ya tiene una reserva/);
    const anteriorAlIngreso = U.sumarDias(ini, -1);
    await call("guardar", { ...visita, recurso_id: libres[0], operacion: U.uuid(), fecha_inicio: anteriorAlIngreso, fecha_fin: ini, personas:[{...p, entrada: anteriorAlIngreso}] });
    await assert.rejects(call("cotizar", { ...visita, id: moved.id, version:(await call("detalle", {id:moved.id})).reserva.version, recurso_id: libres[1], fecha_inicio: anteriorAlIngreso }), /ya tiene una reserva/);
    console.log("OK responsable adulto, fecha visible sin noche, importe revisado, permanencia del check-in/out y ocupación de ambos recursos tras un traslado");
    console.log("OK tarifa vigente por noche, prorrateo individual, parcela, justificación y diferencial a devolver");
    console.log("OK alta aprobada, particular sin acceso, cotización reversible, edición auditada, concurrencia, reintento, alcance y filtro");
  } finally {
    await c.rollback();
    await c.end();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
