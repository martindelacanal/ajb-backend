"use strict";

const { randomBytes } = require("node:crypto");
const U = require("../../predios/lib/util");
const { serviciosDe } = require("./predios-central");

const lecturas = new Set(["vehiculos", "detalleVehiculo", "buscarVehiculoQr"]);
const acciones = new Set([...lecturas, "emitirVehiculoQr", "retirarVehiculo"]);
const puedeLeer = actor => ["ADMIN", "SEGURIDAD"].includes(actor?.rol);
const puedeEmitir = actor => actor?.rol === "ADMIN" || actor?.rol === "CAJERO" && Number(actor.gestionar_reservas) === 1;
const permitir = (actor, accion) => lecturas.has(accion) ? puedeLeer(actor)
  : accion === "emitirVehiculoQr" ? puedeEmitir(actor) : accion === "retirarVehiculo" && actor?.rol === "ADMIN";
const tokenValido = /^[A-Za-z0-9_-]{32}$/;
const patente = r => r?.vehiculo?.patente || "";
const presente = p => p.entrada && !p.salida;
const todos = async (c, sql, params) => (await c.query(sql, params))[0];
const uno = async (c, sql, params) => (await todos(c, sql, params))[0];
const noEncontrado = () => U.error("No encontramos ese vehículo en el predio.", 404);

function estadoGuardado(c, predio, r, bloquear) {
  return uno(c, `SELECT patente,token,DATE_FORMAT(salida,'%Y-%m-%d') AS salida FROM recepcion_vehiculo
    WHERE predio_id=? AND reserva_id=?${bloquear ? " FOR UPDATE" : ""}`, [predio.id, r.id]);
}

async function estadoVehiculo(c, predio, r, { bloquear = false } = {}) {
  if (!patente(r)) return { presente: false, salida: null };
  const registro = await estadoGuardado(c, predio, r, bloquear);
  const salida = registro?.patente === patente(r) ? registro.salida : null;
  return { presente: !salida && (r.personas || []).some(presente), salida };
}

// Las escrituras de vehículo comparten el bloqueo de la cabecera con recepción.
async function registrarSalida(c, predio, actor, r, fecha) {
  const placa = patente(r);
  if (!placa) throw noEncontrado();
  const registro = await estadoGuardado(c, predio, r, true);
  if (registro?.patente === placa && registro.salida) return;
  const salida = U.fecha(fecha, { requerido: true });
  if (registro) {
    await c.query("UPDATE recepcion_vehiculo SET patente=?,token=?,salida=?,salida_actor=? WHERE predio_id=? AND reserva_id=?",
      [placa, registro.patente === placa ? registro.token : null, salida, actor.nombre, predio.id, r.id]);
  } else {
    await c.query("INSERT INTO recepcion_vehiculo(predio_id,reserva_id,patente,salida,salida_actor) VALUES(?,?,?,?,?)",
      [predio.id, r.id, placa, salida, actor.nombre]);
  }
}

async function limpiarCambioVehiculo(c, predio, anterior, actual) {
  if (anterior && patente(anterior) !== patente(actual)) {
    await c.query("DELETE FROM recepcion_vehiculo WHERE predio_id=? AND reserva_id=?", [predio.id, actual.id]);
  }
}

async function leerReserva(c, predio, codigos, id) {
  const r = await uno(c, `SELECT r.id FROM reserva r JOIN servicio s ON s.id=r.servicio_id
    WHERE r.id=? AND s.codigo IN (?) FOR UPDATE OF r`, [id, codigos]);
  if (!r) throw noEncontrado();
  const evento = await uno(c, `SELECT predio_id,actual FROM recepcion_reserva_evento
    WHERE reserva_id=? ORDER BY id DESC LIMIT 1 FOR SHARE`, [id]);
  if (Number(evento?.predio_id) !== Number(predio.id)) throw noEncontrado();
  const actual = JSON.parse(evento.actual);
  if (!patente(actual)) throw noEncontrado();
  return { ...actual, id };
}

async function emitir(c, predio, r) {
  const placa = patente(r);
  const registro = await estadoGuardado(c, predio, r, true);
  if (registro?.patente === placa) {
    if (registro.salida) throw U.error("El vehículo ya registró su salida.", 409);
    if (registro.token) return { token: registro.token };
  }
  const token = randomBytes(24).toString("base64url");
  if (registro) {
    await c.query("UPDATE recepcion_vehiculo SET patente=?,token=?,salida=NULL,salida_actor=NULL WHERE predio_id=? AND reserva_id=?",
      [placa, token, predio.id, r.id]);
  } else {
    await c.query("INSERT INTO recepcion_vehiculo(predio_id,reserva_id,patente,token) VALUES(?,?,?,?)",
      [predio.id, r.id, placa, token]);
  }
  return { token };
}

async function listar(c, predio, codigos, { id, token } = {}) {
  const datosEvento = "IF(JSON_VALID(e.actual),e.actual,'{}')";
  const placa = `JSON_EXTRACT(${datosEvento},'$.vehiculo.patente')`;
  const cond = ["e.predio_id=?", "s.codigo IN (?)", "v.salida IS NULL", `JSON_TYPE(${placa})='STRING'`];
  const params = [predio.id, codigos];
  if (id) { cond.push("r.id=?"); params.push(id); }
  if (token) { cond.push("v.token=?"); params.push(token); }
  const filas = await todos(c, `SELECT r.id,e.id AS revision,r.fecha_inicio,r.fecha_fin,s.nombre AS servicio,
    rec.nombre AS recurso,CONCAT_WS(', ',u.apellido,u.nombre) AS titular,e.actual
    FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id
    LEFT JOIN recurso rec ON rec.id=r.recurso_id
    JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev WHERE ev.reserva_id=r.id)
    LEFT JOIN recepcion_vehiculo v ON v.predio_id=e.predio_id AND v.reserva_id=r.id
      AND BINARY v.patente=BINARY JSON_UNQUOTE(${placa})
    WHERE ${cond.join(" AND ")}
    ORDER BY r.id DESC`, params);
  return filas.flatMap(({ actual, ...fila }) => {
    const r = JSON.parse(actual);
    if (!patente(r) || !(r.personas || []).some(presente)) return [];
    const { marca, color, patente: placa, sector } = r.vehiculo;
    return [{
      ...fila,
      fecha_fin: r.dia_sin_noche && fila.fecha_fin === U.sumarDias(fila.fecha_inicio, 1) ? fila.fecha_inicio : fila.fecha_fin,
      vehiculo: { marca, color, patente: placa, sector },
      personas: r.personas.map(p => ({ nombre: [p.nombre, p.apellido].filter(Boolean).join(" "), entrada: p.entrada, salida: p.salida }))
    }];
  });
}

async function operar(c, predio, actor, accion, b = {}) {
  if (!permitir(actor, accion)) throw U.error("Tu cuenta no tiene permiso para esta operación de vehículos.", 403);
  const codigos = serviciosDe(predio);
  if (!codigos.length) throw U.error("Este predio no tiene servicios asignados.", 403);
  if (accion === "vehiculos") return { filas: await listar(c, predio, codigos) };
  if (accion === "buscarVehiculoQr") {
    if (typeof b.token !== "string" || !tokenValido.test(b.token)) throw noEncontrado();
    const [fila] = await listar(c, predio, codigos, { token: b.token });
    if (!fila) throw noEncontrado();
    return fila;
  }
  const id = U.id(b.id);
  if (accion === "detalleVehiculo") {
    const [fila] = await listar(c, predio, codigos, { id });
    if (!fila) throw noEncontrado();
    return fila;
  }
  const r = await leerReserva(c, predio, codigos, id);
  if (patente(r) !== b.patente) throw U.error("Cambió la patente de la reserva. Volvé a abrir el vehículo.", 409);
  if (accion === "emitirVehiculoQr") return emitir(c, predio, r);
  const estado = await estadoVehiculo(c, predio, r, { bloquear: true });
  if (!estado.presente && !estado.salida) throw noEncontrado();
  await registrarSalida(c, predio, actor, r, U.hoy());
  return { ok: true };
}

module.exports = { acciones, permitir, operar, estadoVehiculo, registrarSalida, limpiarCambioVehiculo };
