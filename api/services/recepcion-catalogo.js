"use strict";

// Catálogo de adicionales del predio, estadísticas de estadías y alquileres para los avisos de recepción.
// Corre en Turismo (base central): la notebook lo pide por /predios-sync/recepcion.

const U = require("../../predios/lib/util");
const P = require("./adicionales-precios");

const todos = async (c, sql, p = []) => (await c.query(sql, p))[0];
const uno = async (c, sql, p = []) => (await todos(c, sql, p))[0];
const ESTADOS_BAJA = ["Cancelada", "Rechazada", "No adjudicada"];
// Igual que recepcion.js: una visita sin noche se muestra con la fecha de salida que registró recepción.
const fechaFinVisibleSql = (evento) => `CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(${evento}.actual,'$.dia_sin_noche')) = 'true' AND DATEDIFF(r.fecha_fin,r.fecha_inicio)=1 THEN r.fecha_inicio ELSE r.fecha_fin END`;
const ultimoEventoSql = " LEFT JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev WHERE ev.reserva_id=r.id)";

async function ambitoPredio(c, predio, codigos) {
  const servicios = await todos(c, `SELECT id, nombre FROM servicio WHERE activo = 1 AND estado_aprobacion = 'APROBADO' AND codigo IN (?)
    ORDER BY nombre`, [codigos]);
  return { predio_id: Number(predio.id), servicio_ids: servicios.map(s => Number(s.id)), servicios };
}

/** Precios que el predio usa pero se cargan en Turismo (temporadas y bloques): sólo lectura en el predio. */
async function preciosDeTemporadas(c, destinos, adicionalId = null) {
  if (!destinos.length) return [];
  const filas = await todos(c, `SELECT ta.adicional_id, ta.recurso_id, ta.regimen_id, ta.fecha_inicio, ta.fecha_fin, ta.precio,
      ta.temporada_tarifa_id, tt.nombre AS temporada, tt.origen
    FROM tarifa_adicional ta JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
    WHERE ta.activo = 1 AND ta.recurso_id IN (?)${adicionalId ? " AND ta.adicional_id = ?" : ""}`,
  [[...new Set(destinos.map(d => d.recurso_id))], ...(adicionalId ? [adicionalId] : [])]);
  const reglas = [];
  const porTemporada = new Map();
  for (const f of filas) {
    if (!porTemporada.has(f.temporada_tarifa_id)) porTemporada.set(f.temporada_tarifa_id, []);
    porTemporada.get(f.temporada_tarifa_id).push(f);
  }
  // "Todos" en un precio de temporada son los recursos que esa temporada tarifa dentro del predio.
  const recursosPredio = new Set(destinos.map(d => Number(d.recurso_id)));
  for (const [temporadaId, lista] of porTemporada) {
    const propios = (await P.destinosDeAmbito(c, { temporada_tarifa_id: Number(temporadaId) }))
      .filter(d => recursosPredio.has(Number(d.recurso_id)));
    for (const r of P.inferirReglas(lista, propios.length ? propios : destinos)) {
      reglas.push({ ...r, id: null, origen: lista[0].origen === "BLOQUE" ? "BLOQUE" : "TEMPORADA", temporada_tarifa_id: Number(temporadaId),
        origen_nombre: lista[0].temporada || "Temporada", editable: false });
    }
  }
  return reglas;
}

async function catalogo(c, predio, codigos) {
  const ambito = await ambitoPredio(c, predio, codigos);
  const destinos = await P.destinosDeAmbito(c, ambito);
  const recursos = ambito.servicio_ids.length ? await todos(c, `SELECT id, nombre, servicio_id FROM recurso WHERE activo = 1 AND servicio_id IN (?)
    ORDER BY servicio_id, orden, nombre`, [ambito.servicio_ids]) : [];
  const idsRegimen = [...new Set(destinos.map(d => d.regimen_id))];
  const regimenes = idsRegimen.length ? await todos(c, "SELECT id, nombre FROM regimen WHERE id IN (?) ORDER BY id", [idsRegimen]) : [];
  const propias = (await P.reglasDeAmbito(c, { predio_id: ambito.predio_id })).map(r => ({ ...r, origen: "PREDIO", origen_nombre: "Catálogo del predio", editable: true }));
  const ajenas = await preciosDeTemporadas(c, destinos);
  const reglas = propias.concat(ajenas);
  const ids = [...new Set(reglas.map(r => Number(r.adicional_id)))];
  const adicionales = ids.length ? await todos(c, "SELECT id, nombre, modalidad FROM adicional WHERE id IN (?) ORDER BY nombre", [ids]) : [];
  return {
    servicios: ambito.servicios,
    recursos,
    regimenes,
    servicio_regimenes: [...new Map(destinos.map(d => [`${d.servicio_id}-${d.regimen_id}`, { servicio_id: d.servicio_id, regimen_id: d.regimen_id }])).values()],
    adicionales,
    reglas,
  };
}

async function usosDelAdicional(c, adicionalId) {
  const enTemporadas = await uno(c, "SELECT COUNT(*) AS n FROM tarifa_adicional WHERE adicional_id = ? AND activo = 1 AND temporada_tarifa_id IS NOT NULL", [adicionalId]);
  const enOtrosPredios = await uno(c, "SELECT COUNT(DISTINCT predio_id) AS n FROM adicional_precio WHERE adicional_id = ? AND activo = 1 AND predio_id IS NOT NULL", [adicionalId]);
  const reservas = await uno(c, "SELECT COUNT(DISTINCT reserva_id) AS n FROM reserva_adicional WHERE adicional_id = ?", [adicionalId]);
  return { temporadas: Number(enTemporadas.n), predios: Number(enOtrosPredios.n), reservas: Number(reservas.n) };
}

async function adicional(c, predio, codigos, id) {
  const fila = await uno(c, "SELECT id, nombre, modalidad FROM adicional WHERE id = ?", [U.id(id, "El adicional")]);
  if (!fila) throw U.error("No encontramos ese adicional.", 404);
  const base = await catalogo(c, predio, codigos);
  const usos = await usosDelAdicional(c, fila.id);
  const propias = base.reglas.filter(r => r.editable && Number(r.adicional_id) === Number(fila.id));
  const ajenas = base.reglas.filter(r => !r.editable && Number(r.adicional_id) === Number(fila.id));
  return {
    ...base,
    adicional: fila,
    reglas: propias,
    ajenas,
    usos,
    // Un nombre o una modalidad compartidos con Turismo se cambian donde se cargó ese precio.
    puede_renombrar: usos.temporadas === 0 && usos.predios <= (propias.length ? 1 : 0),
    puede_cambiar_modalidad: usos.temporadas === 0 && usos.predios <= (propias.length ? 1 : 0),
  };
}

async function guardarAdicional(c, predio, codigos, actor, b) {
  if (actor.rol !== "ADMIN") throw U.error("Solo un administrador puede modificar el catálogo de adicionales.", 403);
  // El bloqueo del predio serializa los cambios simultáneos del catálogo.
  await uno(c, "SELECT id FROM predio WHERE id = ? FOR UPDATE", [predio.id]);
  const ambito = await ambitoPredio(c, predio, codigos);
  const destinos = await P.destinosDeAmbito(c, ambito, { bloquear: true });
  if (!destinos.length) throw U.error("El predio no tiene servicios con recursos activos para cargar precios.", 409);
  const nombre = U.texto(b.nombre, { requerido: true, max: 100, campo: "El nombre del adicional" });
  const modalidad = U.opcion(b.modalidad || "ALQUILER", P.MODALIDADES, "El tipo de adicional");
  let fila = b.id ? await uno(c, "SELECT id, nombre, modalidad FROM adicional WHERE id = ? FOR UPDATE", [U.id(b.id, "El adicional")]) : null;
  if (b.id && !fila) throw U.error("No encontramos ese adicional.", 404);
  if (!fila) {
    const mismo = await uno(c, "SELECT id, nombre, modalidad FROM adicional WHERE LOWER(TRIM(nombre)) = LOWER(?) ORDER BY id LIMIT 1 FOR UPDATE", [nombre]);
    if (mismo) {
      const yaEsta = await uno(c, "SELECT id FROM adicional_precio WHERE predio_id = ? AND adicional_id = ? AND activo = 1 LIMIT 1", [predio.id, mismo.id]);
      if (yaEsta) throw U.error(`«${mismo.nombre}» ya está en el catálogo. Abrilo desde la tabla para agregarle precios.`, 409);
      fila = mismo;
    }
  }
  const usos = fila ? await usosDelAdicional(c, fila.id) : { temporadas: 0, predios: 0, reservas: 0 };
  // El artículo es compartido: el nombre y el tipo sólo se cambian si nadie fuera de este predio lo usa.
  const propio = fila ? await uno(c, "SELECT 1 AS si FROM adicional_precio WHERE predio_id = ? AND adicional_id = ? AND activo = 1 LIMIT 1", [predio.id, fila.id]) : null;
  const compartido = !!(usos.temporadas || usos.predios > (propio ? 1 : 0));
  if (fila && fila.modalidad !== modalidad && compartido) {
    throw U.error(usos.temporadas ? "Ese adicional también se usa en temporadas de Turismo, que lo cobran por día: no se puede pasar a venta por unidad."
      : "Ese adicional también lo usa otro predio: su tipo no se puede cambiar desde acá.", 409);
  }
  if (!fila) {
    const [res] = await c.query("INSERT INTO adicional (nombre, modalidad) VALUES (?, ?)", [nombre, modalidad]);
    fila = { id: res.insertId, nombre, modalidad };
  } else if (fila.nombre !== nombre || fila.modalidad !== modalidad) {
    if (fila.nombre !== nombre && compartido) {
      throw U.error("Ese adicional se usa también fuera de este predio: su nombre se cambia desde Mi AJB.", 409);
    }
    await c.query("UPDATE adicional SET nombre = ?, modalidad = ? WHERE id = ?", [nombre, modalidad, fila.id]);
  }
  const reglas = P.normalizarReglas((b.reglas || []).map(r => ({ ...r, adicional_id: fila.id })), { destinos, adicionalId: fila.id });
  const r = await P.materializar(c, { predio_id: Number(predio.id) }, [fila.id], reglas, {
    destinos, actorId: actor.general_usuario_id || null, actorNombre: String(actor.nombre || "Predio").slice(0, 160),
  });
  return { id: Number(fila.id), nombre, modalidad, reglas: r.reglas.length, mensaje: reglas.length ? "Adicional guardado" : "Adicional quitado del catálogo del predio" };
}

/** Compatibilidad con notebooks anteriores: «Crear adicional» con un precio por recurso y régimen. */
async function crearAdicionalSimple(c, predio, codigos, actor, d) {
  const nombre = U.texto(d.nombre, { requerido: true, max: 100, campo: "El nombre del artículo" });
  const existente = await uno(c, "SELECT id, nombre, modalidad FROM adicional WHERE LOWER(TRIM(nombre)) = LOWER(?) ORDER BY id LIMIT 1", [nombre]);
  const previas = existente ? (await P.reglasDeAmbito(c, { predio_id: predio.id })).filter(r => Number(r.adicional_id) === Number(existente.id)) : [];
  const desde = U.fecha(d.fecha_desde || U.hoy());
  const nueva = { servicio_id: d.servicio_id, recurso_id: d.recurso_id, regimen_id: d.regimen_id, fecha_inicio: desde,
    fecha_fin: U.fecha(d.fecha_hasta) || U.sumarDias(desde, 365), precio: d.precio };
  const r = await guardarAdicional(c, predio, codigos, actor, { id: existente?.id, nombre: existente?.nombre || nombre, modalidad: existente?.modalidad || "ALQUILER", reglas: [...previas, nueva] });
  return { id: r.id, nombre, recurso_id: Number(d.recurso_id), regimen_id: Number(d.regimen_id), precio: Number(d.precio), fecha_desde: nueva.fecha_inicio, fecha_hasta: nueva.fecha_fin };
}

// ------------------------------------------------------------------ estadísticas de estadías

async function estadisticas(c, predio, codigos, b) {
  const hoy = U.hoy();
  const desde = U.fecha(b.desde) || U.sumarDias(hoy, -29);
  const hasta = U.fecha(b.hasta) || hoy;
  if (hasta < desde || hasta > U.sumarDias(desde, 800)) throw U.error("Revisá el período (hasta dos años).");
  const cond = ["s.codigo IN (?)", "er.nombre NOT IN (?)", `${fechaFinVisibleSql("e")} >= ?`, "r.fecha_inicio <= ?"];
  const p = [codigos, ESTADOS_BAJA, desde, hasta];
  if (b.servicio_id) { cond.push("s.id = ?"); p.push(U.id(b.servicio_id)); }
  if (b.recurso_id) {
    cond.push("(r.recurso_id = ? OR EXISTS (SELECT 1 FROM recepcion_reserva_recurso rr WHERE rr.reserva_id = r.id AND rr.recurso_id = ?))");
    const recurso = U.id(b.recurso_id); p.push(recurso, recurso);
  }
  if (b.adicional_id) { cond.push("EXISTS (SELECT 1 FROM reserva_adicional rx WHERE rx.reserva_id = r.id AND rx.adicional_id = ?)"); p.push(U.id(b.adicional_id)); }
  if (b.tipo) { cond.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.tipo')),'GENERAL') = ?"); p.push(U.opcion(b.tipo, ["GENERAL", "PASA_EL_DIA", "CONTINGENTE", "FEDERACION"])); }
  const filas = await todos(c, `SELECT r.id, r.fecha_inicio, ${fechaFinVisibleSql("e")} AS fecha_fin, r.precio_total, COALESCE(r.monto_adicionales,0) AS monto_adicionales,
      s.id AS servicio_id, s.nombre AS servicio, er.nombre AS estado,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.tipo')),'GENERAL') AS tipo, (e.id IS NOT NULL) AS atipica,
      COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.cantidad')) AS UNSIGNED),(SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id=r.id)) AS personas
    FROM reserva r JOIN servicio s ON s.id = r.servicio_id JOIN estado_reserva er ON er.id = r.estado_reserva_id
    ${ultimoEventoSql} WHERE ${cond.join(" AND ")} LIMIT 20000`, p);
  const suma = (xs, k) => U.redondear(xs.reduce((t, x) => t + Number(x[k] || 0), 0));
  const agrupar = (k, nombre) => {
    const m = new Map();
    for (const x of filas) {
      const clave = x[k];
      if (!m.has(clave)) m.set(clave, { clave, nombre: nombre ? x[nombre] : clave, reservas: 0, personas: 0, importe: 0 });
      const g = m.get(clave);
      g.reservas++; g.personas += Number(x.personas || 0); g.importe = U.redondear(g.importe + Number(x.precio_total || 0));
    }
    return [...m.values()].sort((a, b2) => b2.importe - a.importe || b2.reservas - a.reservas);
  };
  const noches = filas.reduce((t, x) => {
    const a = x.fecha_inicio > desde ? x.fecha_inicio : desde;
    const z = x.fecha_fin < U.sumarDias(hasta, 1) ? x.fecha_fin : U.sumarDias(hasta, 1);
    let n = 0;
    for (let d = a; d < z && n < 800; d = U.sumarDias(d, 1)) n++;
    return t + n;
  }, 0);
  const ids = filas.map(x => x.id);
  const adicionales = ids.length ? await todos(c, `SELECT ra.adicional_id, COALESCE(a.nombre, ra.nombre_adicional) AS nombre, COALESCE(a.modalidad,'ALQUILER') AS modalidad,
      COUNT(DISTINCT ra.reserva_id) AS reservas, SUM(ra.cantidad) AS unidades, SUM(ra.dias * ra.cantidad) AS dias_unidad, SUM(ra.subtotal) AS importe
    FROM reserva_adicional ra LEFT JOIN adicional a ON a.id = ra.adicional_id
    WHERE ra.reserva_id IN (?) GROUP BY ra.adicional_id, nombre, modalidad ORDER BY importe DESC LIMIT 30`, [ids]) : [];
  // Personas por día en el período (según las fechas de cada reserva).
  const porDia = [];
  const dias = new Map();
  for (let d = desde; d <= hasta && porDia.length < 800; d = U.sumarDias(d, 1)) { const x = { dia: d, personas: 0, reservas: 0 }; porDia.push(x); dias.set(d, x); }
  for (const x of filas) {
    const ultimo = x.fecha_fin > x.fecha_inicio ? U.sumarDias(x.fecha_fin, -1) : x.fecha_inicio;
    for (let d = x.fecha_inicio > desde ? x.fecha_inicio : desde; d <= ultimo && d <= hasta; d = U.sumarDias(d, 1)) {
      const g = dias.get(d);
      if (g) { g.personas += Number(x.personas || 0); g.reservas++; }
    }
  }
  const presentes = await uno(c, `SELECT COUNT(*) AS personas, COUNT(DISTINCT reserva_id) AS reservas FROM predio_huesped
    WHERE predio_id = ? AND entrada IS NOT NULL AND salida IS NULL`, [predio.id]);
  const importe = suma(filas, "precio_total");
  const montoAdicionales = suma(filas, "monto_adicionales");
  return {
    desde, hasta,
    kpi: {
      reservas: filas.length,
      personas: filas.reduce((t, x) => t + Number(x.personas || 0), 0),
      importe,
      alojamiento: U.redondear(importe - montoAdicionales),
      adicionales: montoAdicionales,
      promedio: filas.length ? U.redondear(importe / filas.length) : 0,
      noches,
      atipicas: filas.filter(x => Number(x.atipica)).length,
      presentes_personas: Number(presentes?.personas || 0),
      presentes_reservas: Number(presentes?.reservas || 0),
    },
    por_servicio: agrupar("servicio_id", "servicio"),
    por_tipo: agrupar("tipo"),
    por_estado: agrupar("estado"),
    adicionales: adicionales.map(a => ({ ...a, unidades: Number(a.unidades || 0), dias_unidad: Number(a.dias_unidad || 0), importe: Number(a.importe || 0), reservas: Number(a.reservas) })),
    por_dia: porDia,
  };
}

// ------------------------------------------------------------------ alquileres para los avisos

function personasDeEvento(actual) {
  try { const x = typeof actual === "string" ? JSON.parse(actual) : actual; return Array.isArray(x?.personas) ? x.personas : null; } catch (_e) { return null; }
}

/** Primer estado conocido de la reserva antes de que el predio la modificara (lo que ya venía de Turismo). */
async function basesDeTurismo(c, ids) {
  if (!ids.length) return new Map();
  const eventos = await todos(c, `SELECT e.reserva_id, e.anterior FROM recepcion_reserva_evento e
    WHERE e.id IN (SELECT MIN(x.id) FROM recepcion_reserva_evento x WHERE x.reserva_id IN (?) GROUP BY x.reserva_id)`, [ids]);
  const mapa = new Map();
  for (const ev of eventos) {
    let anterior = null;
    try { anterior = typeof ev.anterior === "string" ? JSON.parse(ev.anterior) : ev.anterior; } catch (_e) { anterior = null; }
    const base = new Map();
    for (const a of anterior?.adicionales || []) base.set(Number(a.adicional_id), Number(a.subtotal || 0));
    mapa.set(Number(ev.reserva_id), base);
  }
  return mapa;
}

async function alquileres(c, predio, codigos, b = {}) {
  const hoy = U.hoy();
  const reservaId = b.reserva_id ? U.id(b.reserva_id) : null;
  const filas = await todos(c, `SELECT r.id AS reserva_id, CONCAT_WS(', ', u.apellido, u.nombre) AS titular, s.nombre AS servicio, rec.nombre AS recurso,
      r.fecha_fin AS reserva_fin, e.actual AS evento, e.predio_id AS evento_predio,
      ra.adicional_id, ra.nombre_adicional AS nombre, COALESCE(a.modalidad, 'ALQUILER') AS modalidad, ra.cantidad, ra.dias, ra.subtotal,
      MIN(d.fecha) AS fecha_desde, MAX(d.fecha) AS fecha_hasta
    FROM reserva r JOIN servicio s ON s.id = r.servicio_id JOIN usuario u ON u.id = r.usuario_id
    JOIN estado_reserva er ON er.id = r.estado_reserva_id LEFT JOIN recurso rec ON rec.id = r.recurso_id
    JOIN reserva_adicional ra ON ra.reserva_id = r.id LEFT JOIN adicional a ON a.id = ra.adicional_id
    LEFT JOIN reserva_adicional_detalle d ON d.reserva_adicional_id = ra.id
    ${ultimoEventoSql}
    WHERE s.codigo IN (?) AND er.nombre NOT IN (?) AND e.id IS NOT NULL
      ${reservaId ? "AND r.id = ?" : "AND r.fecha_fin >= ?"}
    GROUP BY r.id, ra.id, e.id
    ORDER BY r.id, ra.id`, [codigos, ESTADOS_BAJA, reservaId || U.sumarDias(hoy, -180)]);
  const bases = await basesDeTurismo(c, [...new Set(filas.map(f => Number(f.reserva_id)))]);
  return {
    hoy,
    lineas: filas.map(f => {
      const personas = Number(f.evento_predio) === Number(predio.id) ? personasDeEvento(f.evento) : null;
      const ingresaron = personas ? personas.filter(p => p.entrada) : [];
      const todosSalieron = !!(ingresaron.length && ingresaron.every(p => p.salida));
      const fechaHasta = f.fecha_hasta ? P.iso(f.fecha_hasta) : null;
      return {
        reserva_id: Number(f.reserva_id), titular: f.titular, servicio: f.servicio, recurso: f.recurso,
        adicional_id: Number(f.adicional_id), nombre: f.nombre, modalidad: f.modalidad, cantidad: Number(f.cantidad),
        dias: Number(f.dias || 0), subtotal: Number(f.subtotal), fecha_desde: f.fecha_desde ? P.iso(f.fecha_desde) : null, fecha_hasta: fechaHasta,
        base_turismo: bases.get(Number(f.reserva_id))?.get(Number(f.adicional_id)) || 0,
        todos_salieron: todosSalieron,
        ultima_salida: todosSalieron ? ingresaron.map(p => p.salida).sort().pop() : null,
      };
    }),
  };
}

module.exports = { catalogo, adicional, guardarAdicional, crearAdicionalSimple, estadisticas, alquileres, basesDeTurismo, ambitoPredio };
