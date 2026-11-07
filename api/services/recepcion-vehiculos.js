"use strict";

// Vehículos de las reservas del predio y QR de la reserva.
// Una reserva puede tener varios vehículos, cada uno con su ingreso y su salida. Se guardan
// en la revisión de recepción (`vehiculos`). Las revisiones anteriores tenían un solo
// `vehiculo` y su salida en recepcion_vehiculo: se leen igual, como una lista de uno.
// El QR identifica la reserva (no un vehículo): Seguridad ve sus vehículos, personas y deuda.
const { randomBytes } = require("node:crypto");
const U = require("../../predios/lib/util");
const { serviciosDe } = require("./predios-central");

const lecturas = new Set(["vehiculos", "detalleVehiculo", "buscarVehiculoQr"]);
const acciones = new Set([...lecturas, "emitirVehiculoQr", "retirarVehiculo"]);
const gestiona = actor => actor?.rol === "ADMIN" || actor?.rol === "CAJERO" && Number(actor.gestionar_reservas) === 1;
const puedeLeer = actor => ["ADMIN", "SEGURIDAD"].includes(actor?.rol);
const permitir = (actor, accion) => lecturas.has(accion) ? puedeLeer(actor)
  : accion === "emitirVehiculoQr" ? gestiona(actor) : accion === "retirarVehiculo" && actor?.rol === "ADMIN";
const tokenValido = /^[A-Za-z0-9_-]{32}$/;
const MAX_VEHICULOS = 20;
const todos = async (c, sql, params) => (await c.query(sql, params))[0];
const uno = async (c, sql, params) => (await todos(c, sql, params))[0];
const noEncontrado = () => U.error("No encontramos esa reserva entre las del predio.", 404);
const presente = p => p.entrada && !p.salida;
const nombre = p => [p.nombre, p.apellido].filter(Boolean).join(" ");

/** Patente comparable: mayúsculas, sin espacios, puntos ni guiones. */
function placa(valor) {
  return String(valor || "").toUpperCase().replace(/[\s.\-]/g, "");
}

/** Lista de vehículos de una revisión (formato nuevo o el vehículo único anterior). */
function vehiculosDe(r, salidaAnterior = null) {
  if (Array.isArray(r?.vehiculos)) return r.vehiculos.map(v => ({ ...v }));
  const v = r?.vehiculo;
  if (!v?.patente) return [];
  return [{ patente: v.patente, marca: v.marca || null, color: v.color || null, sector: v.sector || null,
    entrada: null, salida: salidaAnterior || null }];
}

/** Un vehículo está en el predio si no salió, ya ingresó y queda alguien de la reserva. */
function vehiculoPresente(v, r, hoy = U.hoy()) {
  return !v.salida && (!v.entrada || v.entrada <= hoy) && (r.personas || []).some(presente);
}

// Las revisiones del formato anterior guardaban la salida del vehículo aparte.
async function salidaAnterior(c, predioId, reservaId, ext) {
  if (Array.isArray(ext?.vehiculos) || !ext?.vehiculo?.patente || !predioId) return null;
  const fila = await uno(c, `SELECT patente,DATE_FORMAT(salida,'%Y-%m-%d') AS salida FROM recepcion_vehiculo
    WHERE predio_id=? AND reserva_id=?`, [predioId, reservaId]);
  return fila && placa(fila.patente) === placa(ext.vehiculo.patente) ? fila.salida : null;
}

/**
 * Valida la lista de vehículos que manda recepción contra la revisión anterior.
 * - patente, marca y color obligatorios; el sector de estacionamiento es opcional;
 * - ingreso y salida dentro de la estadía y no futuros;
 * - un vehículo que ya ingresó no se borra: se le registra la salida;
 * - una salida registrada se puede corregir, no borrar.
 * Sin ingreso propio, el vehículo entra con el grupo: toma el primer ingreso de las personas.
 */
function normalizarVehiculos(lista, anteriores, { inicio, fin, personas, ingresoAnterior = false, hoy = U.hoy() }) {
  if (!Array.isArray(lista)) throw U.error("La lista de vehículos no es válida.");
  if (lista.length > MAX_VEHICULOS) throw U.error("Una reserva admite hasta " + MAX_VEHICULOS + " vehículos.");
  const previos = new Map(anteriores.map(v => [placa(v.patente), v]));
  const vistos = new Set();
  const ingresoGrupo = (personas || []).map(p => p.entrada).filter(Boolean).sort()[0] || null;
  const vehiculos = lista.map(v => {
    const patente = placa(U.texto(v?.patente, { max: 20 }));
    const marca = U.texto(v?.marca, { max: 50 });
    const color = U.texto(v?.color, { max: 50 });
    const sector = U.texto(v?.sector, { max: 50 }) || null;
    if (!patente && !marca && !color && !sector) return null;
    if (!patente || !marca || !color) throw U.error("Completá patente, marca y color de cada vehículo. El sector de estacionamiento es opcional.");
    if (!/^[A-Z0-9]{4,12}$/.test(patente)) throw U.error("Revisá la patente " + patente + ": usá letras y números.");
    if (vistos.has(patente)) throw U.error("La patente " + patente + " está repetida en la reserva.");
    vistos.add(patente);
    const previo = previos.get(patente);
    let entrada = U.fecha(v.entrada, { campo: "El ingreso del vehículo" });
    const salida = U.fecha(v.salida, { campo: "La salida del vehículo" });
    if (!entrada && previo?.entrada) entrada = previo.entrada;
    if (!entrada && (salida || ingresoGrupo)) entrada = ingresoGrupo && (!salida || ingresoGrupo <= salida) ? ingresoGrupo : salida;
    if (entrada && (entrada < inicio || entrada > hoy || fin && entrada > fin)) {
      throw U.error("Revisá el ingreso del vehículo " + patente + ": debe estar dentro de la estadía y no ser futuro.");
    }
    if (salida && (salida < (entrada || inicio) || salida > hoy)) {
      throw U.error("Revisá la salida del vehículo " + patente + ": debe seguir al ingreso y no ser futura.");
    }
    if (previo?.salida && !salida) throw U.error("Podés corregir la salida del vehículo " + patente + ", pero no borrarla.");
    return { patente, marca, color, sector, entrada: entrada || null, salida: salida || null };
  }).filter(Boolean);
  for (const [clave, previo] of previos) {
    // Un error de carga del mismo día se puede borrar; lo anterior queda con su salida.
    const ingreso = previo.entrada || (ingresoAnterior ? inicio : null);
    if (!vistos.has(clave) && (previo.salida || ingreso && ingreso !== hoy)) {
      throw U.error("El vehículo " + previo.patente + " ya ingresó: para sacarlo de la reserva registrá su salida.");
    }
  }
  return vehiculos;
}

function describirVehiculo(v) {
  return [v.patente, [v.marca, v.color].filter(Boolean).join(" "), v.sector ? "Sector " + v.sector : null,
    (v.entrada || "sin ingreso") + " / " + (v.salida || "sin salida")].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ QR de la reserva

async function reservaDelPredio(c, codigos, id, bloquear = false) {
  const r = await uno(c, `SELECT r.id FROM reserva r JOIN servicio s ON s.id=r.servicio_id
    WHERE r.id=? AND s.codigo IN (?)${bloquear ? " FOR UPDATE OF r" : ""}`, [id, codigos]);
  if (!r) throw noEncontrado();
  return r;
}

async function emitirQr(c, predio, codigos, id) {
  await reservaDelPredio(c, codigos, id, true);
  const previo = await uno(c, "SELECT token FROM recepcion_reserva_qr WHERE predio_id=? AND reserva_id=? FOR UPDATE", [predio.id, id]);
  if (previo?.token) return { token: previo.token };
  const token = randomBytes(24).toString("base64url");
  await c.query("INSERT INTO recepcion_reserva_qr(predio_id,reserva_id,token) VALUES(?,?,?)", [predio.id, id, token]);
  return { token };
}

async function reservaDeToken(c, predio, token) {
  if (typeof token !== "string" || !tokenValido.test(token)) throw noEncontrado();
  const fila = await uno(c, "SELECT reserva_id FROM recepcion_reserva_qr WHERE predio_id=? AND token=?", [predio.id, token]);
  if (!fila) throw U.error("Ese QR no corresponde a una reserva de este predio.", 404);
  return Number(fila.reserva_id);
}

// ------------------------------------------------------------------ ficha para Seguridad

function edad(nacimiento, hoy) {
  if (!nacimiento) return null;
  const n = String(nacimiento).slice(0, 10);
  let años = Number(hoy.slice(0, 4)) - Number(n.slice(0, 4));
  if (hoy.slice(5) < n.slice(5)) años--;
  return años >= 0 && años < 130 ? años : null;
}

/** Lo que ve Seguridad de una reserva: personas, vehículos y estadía (la deuda la suma el predio). */
async function ficha(c, r) {
  const hoy = U.hoy();
  const parentescos = new Map((await todos(c, "SELECT id,nombre FROM parentesco")).map(p => [Number(p.id), p.nombre]));
  const vehiculos = vehiculosDe(r).map(v => ({ ...v, en_predio: vehiculoPresente(v, r, hoy) }));
  return {
    id: Number(r.id),
    revision: Number(r.revision || 0),
    titular: r.titular_nombre,
    titular_dni: r.titular_dni,
    estado: r.estado,
    servicio: r.servicio,
    recurso: (r.recursos || []).map(x => x.nombre).join(", ") || r.recurso || null,
    numero_parcela: r.numero_parcela || null,
    es_parcela: !!r.es_parcela,
    ubicacion: r.ubicacion || null,
    fecha_inicio: r.fecha_inicio,
    fecha_fin: r.fecha_fin,
    personas: (r.personas || []).map(p => ({
      nombre: nombre(p), dni: String(p.dni), edad: edad(p.fecha_nacimiento, hoy),
      vinculo: parentescos.get(Number(p.parentesco_id)) || null,
      entrada: p.entrada || null, salida: p.salida || null, salida_prevista: p.salida_prevista || r.fecha_fin
    })),
    vehiculos,
    // Compatibilidad: el primer vehículo en el predio (o el primero de la lista).
    vehiculo: vehiculos.find(v => v.en_predio) || vehiculos[0] || null
  };
}

// ------------------------------------------------------------------ listado de vehículos en el predio

async function listar(c, predio, codigos) {
  const datosEvento = "IF(JSON_VALID(e.actual),e.actual,'{}')";
  const filas = await todos(c, `SELECT r.id,e.id AS revision,r.fecha_inicio,r.fecha_fin,r.numero_parcela,s.nombre AS servicio,
    rec.nombre AS recurso,CONCAT_WS(', ',u.apellido,u.nombre) AS titular,e.actual,
    v.patente AS patente_anterior,DATE_FORMAT(v.salida,'%Y-%m-%d') AS salida_anterior
    FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id
    LEFT JOIN recurso rec ON rec.id=r.recurso_id
    JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev WHERE ev.reserva_id=r.id)
    LEFT JOIN recepcion_vehiculo v ON v.predio_id=e.predio_id AND v.reserva_id=r.id
    WHERE e.predio_id=? AND s.codigo IN (?)
      AND (JSON_LENGTH(${datosEvento},'$.vehiculos')>0 OR JSON_TYPE(JSON_EXTRACT(${datosEvento},'$.vehiculo.patente'))='STRING')
    ORDER BY r.id DESC`, [predio.id, codigos]);
  const hoy = U.hoy();
  return filas.flatMap(({ actual, patente_anterior: anterior, salida_anterior: salida, ...fila }) => {
    const r = JSON.parse(actual);
    if (!(r.personas || []).some(presente)) return [];
    const legado = !Array.isArray(r.vehiculos) && anterior && placa(anterior) === placa(r.vehiculo?.patente) ? salida : null;
    const lista = vehiculosDe(r, legado);
    const personas = r.personas.map(p => ({ nombre: nombre(p), entrada: p.entrada, salida: p.salida }));
    const fin = r.dia_sin_noche && fila.fecha_fin === U.sumarDias(fila.fecha_inicio, 1) ? fila.fecha_inicio : fila.fecha_fin;
    return lista.filter(v => vehiculoPresente(v, r, hoy)).map(v => ({
      ...fila, fecha_fin: fin, ubicacion: r.ubicacion || null,
      vehiculo: { marca: v.marca, color: v.color, patente: v.patente, sector: v.sector, entrada: v.entrada },
      otros_vehiculos: lista.filter(x => x !== v && vehiculoPresente(x, r, hoy)).map(x => x.patente),
      personas
    }));
  });
}

/**
 * Lecturas de Seguridad y emisión del QR. `detalle` es el de recepcion.js (se inyecta
 * para no crear una dependencia circular).
 */
async function operar(c, predio, actor, accion, b = {}, { detalle } = {}) {
  if (!permitir(actor, accion)) throw U.error("Tu cuenta no tiene permiso para esta operación de vehículos.", 403);
  const codigos = serviciosDe(predio);
  if (!codigos.length) throw U.error("Este predio no tiene servicios asignados.", 403);
  if (accion === "vehiculos") return { filas: await listar(c, predio, codigos) };
  if (accion === "emitirVehiculoQr") return emitirQr(c, predio, codigos, U.id(b.id));
  const id = accion === "buscarVehiculoQr" ? await reservaDeToken(c, predio, b.token) : U.id(b.id);
  const r = await detalle(c, codigos, id);
  // Por número de reserva, Seguridad sólo abre las que tienen un vehículo en el predio (las de su
  // lista); con el QR de la etiqueta, la reserva de esa etiqueta.
  if (accion === "detalleVehiculo" && actor.rol !== "ADMIN" && !vehiculosDe(r).some(v => vehiculoPresente(v, r))) throw noEncontrado();
  return ficha(c, r);
}

module.exports = {
  acciones, permitir, gestiona, operar, placa, vehiculosDe, vehiculoPresente, salidaAnterior,
  normalizarVehiculos, describirVehiculo, MAX_VEHICULOS
};
