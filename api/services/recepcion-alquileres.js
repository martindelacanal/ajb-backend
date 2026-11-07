"use strict";

const U = require("../../predios/lib/util");
const uno = async (c, sql, params) => (await c.query(sql, params))[0][0];

async function crearAdicional(c, codigos, actor, datos) {
  if (actor.rol !== "ADMIN") throw U.error("Solo un administrador puede crear precios de alquiler.", 403);
  const servicio = U.id(datos.servicio_id, "El servicio");
  const recurso = U.id(datos.recurso_id, "El recurso");
  const regimen = U.id(datos.regimen_id, "El régimen");
  const nombre = U.texto(datos.nombre, { requerido: true, max: 100, campo: "El nombre del artículo" });
  const precio = U.numero(datos.precio, { min: 0, max: 99999999, campo: "El precio diario" });
  const desde = U.fecha(datos.fecha_desde || U.hoy());
  const finElegido = U.fecha(datos.fecha_hasta);
  if (finElegido && finElegido < desde) throw U.error("El fin de vigencia es anterior al inicio.");

  // El bloqueo del servicio serializa las altas simultáneas de recepción.
  const asignado = await uno(c, `SELECT s.id FROM servicio s JOIN recurso r ON r.servicio_id=s.id
    JOIN servicio_regimen sr ON sr.servicio_id=s.id
    WHERE s.id=? AND s.codigo IN (?) AND s.activo=1 AND s.estado_aprobacion='APROBADO'
      AND r.id=? AND r.activo=1 AND sr.regimen_id=? FOR UPDATE`, [servicio, codigos, recurso, regimen]);
  if (!asignado) throw U.error("El servicio, recurso y régimen deben estar habilitados en este predio.", 403);

  let articulo = await uno(c, "SELECT id,nombre FROM adicional WHERE nombre=? ORDER BY id LIMIT 1 FOR UPDATE", [nombre]);
  if (!articulo) {
    const [res] = await c.query("INSERT INTO adicional (nombre) VALUES (?)", [nombre]);
    articulo = { id: res.insertId, nombre };
  }
  let temporada = await uno(c, `SELECT tt.id, tt.fecha_fin FROM temporada_tarifa tt
    JOIN tarifa t ON t.temporada_tarifa_id=tt.id
    WHERE tt.origen='GENERAL' AND t.recurso_id=? AND t.regimen_id=? AND t.eliminado=0
      AND t.fecha_inicio<=? AND t.fecha_fin>=? AND tt.fecha_fin>=?
    ORDER BY tt.fecha_fin DESC,tt.id LIMIT 1`, [recurso, regimen, desde, desde, finElegido || desde]);
  const hasta = finElegido || temporada?.fecha_fin || U.sumarDias(desde, 365);
  const [existentes] = await c.query(`SELECT ta.id,ta.precio,ta.fecha_inicio,ta.fecha_fin FROM tarifa_adicional ta
    JOIN temporada_tarifa tt ON tt.id=ta.temporada_tarifa_id AND tt.origen='GENERAL'
    WHERE ta.recurso_id=? AND ta.regimen_id=? AND ta.adicional_id=? AND ta.activo=1
      AND ta.fecha_inicio<=? AND ta.fecha_fin>=? FOR UPDATE`, [recurso, regimen, articulo.id, hasta, desde]);
  const respuesta = { ...articulo, recurso_id: recurso, regimen_id: regimen, precio, fecha_desde: desde, fecha_hasta: hasta };
  if (existentes.length) {
    if (existentes.length === 1 && existentes[0].fecha_inicio === desde && existentes[0].fecha_fin === hasta && Number(existentes[0].precio) === precio) return respuesta;
    throw U.error("Ese artículo ya tiene un precio en parte de la vigencia elegida. Elegí otro período.", 409);
  }
  if (!temporada) {
    const nombreTemporada = "Alquileres de predio · " + servicio;
    temporada = await uno(c, "SELECT id FROM temporada_tarifa WHERE nombre=? AND origen='GENERAL' AND fecha_inicio<=? AND fecha_fin>=? ORDER BY id LIMIT 1", [nombreTemporada, desde, hasta]);
    if (!temporada) {
      const [res] = await c.query("INSERT INTO temporada_tarifa(nombre,fecha_inicio,fecha_fin,origen) VALUES(?,?,?,'GENERAL')", [nombreTemporada, desde, hasta]);
      temporada = { id: res.insertId };
    }
  }
  await c.query(`INSERT INTO tarifa_adicional(temporada_tarifa_id,recurso_id,regimen_id,adicional_id,fecha_inicio,fecha_fin,precio)
    VALUES(?,?,?,?,?,?,?)`, [temporada.id, recurso, regimen, articulo.id, desde, hasta, precio]);
  return respuesta;
}

function seleccionArticulos(input, { inicio, fin, tipo, personas, recursoId, regimenId, anteriores = [] }) {
  if (!Array.isArray(input) || input.length > 50) throw U.error("Revisá los adicionales (hasta 50 artículos).");
  const cierre = personas.length && personas.every(p => p.salida) ? personas.map(p => p.salida).sort().at(-1) : null;
  const ids = new Set();
  const seleccion = [];
  for (const item of input) {
    const adicional_id = U.id(item?.adicional_id, "El artículo");
    const cantidad = U.id(item.cantidad, "La cantidad de artículos");
    if (cantidad > 10000 || ids.has(adicional_id)) throw U.error("Revisá las cantidades y los artículos repetidos.");
    ids.add(adicional_id);
    if (!item.fecha_desde && !item.fecha_hasta) {
      if (tipo !== "GENERAL") throw U.error("Indicá el primer y el último día de uso del artículo.");
      seleccion.push({ adicional_id, cantidad });
      continue;
    }
    const desde = U.fecha(item.fecha_desde, { requerido: true, campo: "El primer día de uso" });
    const hasta = U.fecha(item.fecha_hasta, { requerido: true, campo: "El último día de uso" });
    if (desde < inicio || hasta < desde || (!cierre && hasta > fin)) throw U.error("El alquiler debe estar dentro de la estadía y terminar el día de inicio o después.");
    if (cierre && desde > cierre) continue;
    const previo = anteriores.find(a => Number(a.adicional_id) === adicional_id && a.fecha_desde);
    seleccion.push({
      adicional_id, cantidad, fecha_desde: desde, fecha_hasta: cierre && cierre < hasta ? cierre : hasta,
      recurso_tarifa_id: U.id(previo?.recurso_tarifa_id || recursoId, "El recurso del alquiler"),
      regimen_tarifa_id: U.id(previo?.regimen_tarifa_id || regimenId, "El régimen del alquiler")
    });
  }
  return seleccion;
}

// Reutilizar los importes acordados para días ya guardados evita que una edición
// de cantidad, fechas o un traslado revalorice el alquiler a un precio posterior.
async function cotizarAlquileres(c, T, seleccion, personas, temporada, preciosPrevios = []) {
  const items = [];
  for (const alquiler of seleccion) {
    const { adicional_id, cantidad, fecha_desde, fecha_hasta, recurso_tarifa_id, regimen_tarifa_id } = alquiler;
    const guardados = new Map(preciosPrevios.filter(p => Number(p.adicional_id) === adicional_id).map(p => [p.fecha, p]));
    const detalles = [];
    let nombre;
    for (let dia = fecha_desde; dia <= fecha_hasta;) {
      const precio = guardados.get(dia);
      if (precio) {
        nombre = precio.nombre_adicional;
        const subtotal = U.redondear(Number(precio.precio_unitario) * cantidad);
        detalles.push({ ...precio, cantidad, subtotal });
        dia = U.sumarDias(dia, 1);
        continue;
      }
      const desde = dia;
      do { dia = U.sumarDias(dia, 1); } while (dia <= fecha_hasta && !guardados.has(dia) && !temporada);
      const calcular = temporadaId => T.calcularAdicionalesReserva(c, [alquiler], recurso_tarifa_id, regimen_tarifa_id, desde, dia, personas, temporadaId, { recepcion: true });
      let cot;
      try { cot = await calcular(temporada); } catch (e) {
        if (!temporada || e.codigo !== "TARIFA_ADICIONAL_INCOMPLETA") throw e;
        // Recepción también puede entregar artículos de su catálogo general a huéspedes de un bloque.
        cot = await calcular(null);
      }
      nombre = cot.items[0].nombre_adicional;
      detalles.push(...cot.items[0].detalles);
    }
    const subtotal = U.redondear(detalles.reduce((s, d) => s + Number(d.subtotal), 0));
    items.push({ adicional_id, nombre_adicional: nombre, cantidad, dias: detalles.length, subtotal, detalles });
  }
  return items;
}

module.exports = { crearAdicional, seleccionArticulos, cotizarAlquileres };
