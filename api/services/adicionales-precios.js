"use strict";

// Precios de adicionales por reglas.
//
// Una regla dice cuánto cuesta una unidad de un adicional (por día si es un alquiler) entre dos
// fechas inclusive, dentro de un ámbito: una temporada de Turismo (temporada_tarifa) o el catálogo
// propio de un predio. El alcance se elige de lo general a lo particular:
//   - todos los servicios del ámbito          (servicio_id, recurso_id y regimen_id vacíos)
//   - un servicio                             (servicio_id)
//   - un recurso                              (servicio_id + recurso_id)
//   - y en cualquiera de los anteriores, un régimen puntual (regimen_id) o todos.
// Cuando dos reglas valen el mismo día para el mismo recurso y régimen, gana la más particular
// (recurso > servicio > todos; régimen puntual > todos los regímenes). Dos reglas igual de
// particulares que se pisan son un error: no se sabría qué precio cobrar.
//
// Las cotizaciones siguen leyendo tarifa_adicional (una fila por recurso, régimen y rango). Al
// guardar, las reglas se "materializan" en esas filas y quedan enlazadas por adicional_precio_id.
// Las filas anteriores se dan de baja lógica: los renglones de reservas ya cotizadas conservan su
// precio y su referencia.

const U = require("../../predios/lib/util");

const MODALIDADES = ["ALQUILER", "VENTA"];
const MAX_REGLAS = 400;
const MAX_DIAS_REGLA = 3 * 366;

const todos = async (c, sql, p = []) => (await c.query(sql, p))[0];
const uno = async (c, sql, p = []) => (await todos(c, sql, p))[0];

function iso(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) {
    const p = n => String(n).padStart(2, "0");
    return `${valor.getFullYear()}-${p(valor.getMonth() + 1)}-${p(valor.getDate())}`;
  }
  return String(valor).slice(0, 10);
}
const dia = (f, n) => U.sumarDias(f, n);
const idONull = v => (v === null || v === undefined || v === "" || Number(v) === 0 ? null : Number(v));
const fechaCorta = f => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : "");

function puntaje(r) {
  return (r.recurso_id ? 4 : r.servicio_id ? 2 : 0) + (r.regimen_id ? 1 : 0);
}

function aplica(regla, destino) {
  if (regla.recurso_id && Number(regla.recurso_id) !== Number(destino.recurso_id)) return false;
  if (regla.servicio_id && Number(regla.servicio_id) !== Number(destino.servicio_id)) return false;
  if (regla.regimen_id && Number(regla.regimen_id) !== Number(destino.regimen_id)) return false;
  return true;
}

function agrupar(lista, clave) {
  const mapa = new Map();
  for (const x of lista) {
    const k = clave(x);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(x);
  }
  return mapa;
}

/**
 * Normaliza y valida reglas que llegan de una pantalla.
 * contexto: { destinos, servicios?: [{id,nombre}], recursos?: [{id,servicio_id,nombre}], adicionalId? }
 * Cada regla devuelta: { clave, adicional_id, servicio_id, recurso_id, regimen_id, fecha_inicio, fecha_fin, precio }.
 */
function normalizarReglas(entrada, contexto) {
  if (!Array.isArray(entrada)) throw U.error("Revisá los precios del adicional.");
  if (entrada.length > MAX_REGLAS) throw U.error(`Se pueden cargar hasta ${MAX_REGLAS} precios por vez.`);
  const destinos = contexto.destinos || [];
  const recursos = new Map(destinos.map(d => [Number(d.recurso_id), Number(d.servicio_id)]));
  const servicios = new Set(destinos.map(d => Number(d.servicio_id)));
  const regimenes = new Set(destinos.map(d => Number(d.regimen_id)));
  return entrada.map((r, i) => {
    const fila = `precio ${i + 1}`;
    const adicional_id = U.id(r?.adicional_id ?? contexto.adicionalId, `El adicional del ${fila}`);
    let servicio_id = idONull(r.servicio_id);
    const recurso_id = idONull(r.recurso_id);
    const regimen_id = idONull(r.regimen_id);
    if (recurso_id) {
      if (!recursos.has(recurso_id)) throw U.error(`El recurso del ${fila} no está habilitado en este ámbito.`);
      if (servicio_id && servicio_id !== recursos.get(recurso_id)) throw U.error(`El recurso del ${fila} no pertenece al servicio elegido.`);
      servicio_id = recursos.get(recurso_id);
    }
    if (servicio_id && !servicios.has(servicio_id)) throw U.error(`El servicio del ${fila} no está habilitado en este ámbito.`);
    if (regimen_id && !regimenes.has(regimen_id)) throw U.error(`El régimen del ${fila} no está habilitado en este ámbito.`);
    if (regimen_id && !destinos.some(d => aplica({ servicio_id, recurso_id, regimen_id }, d))) {
      throw U.error(`El régimen del ${fila} no corresponde al servicio o recurso elegido.`);
    }
    const fecha_inicio = U.fecha(r.fecha_inicio ?? r.fecha_desde, { requerido: true, campo: `La fecha de inicio del ${fila}` });
    const fecha_fin = U.fecha(r.fecha_fin ?? r.fecha_hasta, { requerido: true, campo: `La fecha de fin del ${fila}` });
    if (fecha_fin < fecha_inicio) throw U.error(`En el ${fila}, la fecha de fin es anterior a la de inicio.`);
    if (fecha_fin > dia(fecha_inicio, MAX_DIAS_REGLA)) throw U.error(`En el ${fila}, la vigencia no puede superar los tres años.`);
    const precio = U.numero(r.precio, { min: 0, max: 99999999, campo: `El importe del ${fila}` });
    return { clave: i, adicional_id, servicio_id, recurso_id, regimen_id, fecha_inicio, fecha_fin, precio };
  });
}

/**
 * Convierte reglas en filas de tarifa_adicional.
 * destinos: [{ servicio_id, recurso_id, regimen_id, rangos?: [{ desde, hasta }] }]
 *   rangos (opcional): días en los que el ámbito tiene tarifas para ese recurso y régimen. Las filas
 *   se recortan y se parten en esos rangos, igual que las que cargaba el editor por tramo.
 * Devuelve { filas, conflictos }.
 */
function resolver(reglas, destinos) {
  const filas = [];
  const conflictos = [];
  for (const [adicionalId, lista] of agrupar(reglas, r => Number(r.adicional_id))) {
    for (const d of destinos) {
      const aplicables = lista.filter(r => aplica(r, d));
      if (!aplicables.length) continue;
      const rangos = Array.isArray(d.rangos) ? d.rangos : null;
      const cortes = new Set();
      for (const r of aplicables) { cortes.add(r.fecha_inicio); cortes.add(dia(r.fecha_fin, 1)); }
      if (rangos) for (const x of rangos) { cortes.add(x.desde); cortes.add(dia(x.hasta, 1)); }
      const orden = [...cortes].sort();
      let actual = null;
      let rangoActual = null;
      const cerrar = () => { if (actual) filas.push(actual); actual = null; };
      for (let i = 0; i < orden.length - 1; i++) {
        const a = orden[i];
        const z = dia(orden[i + 1], -1);
        const rango = rangos ? rangos.find(x => x.desde <= a && x.hasta >= z) : null;
        if (rangos && !rango) { cerrar(); continue; }
        const vigentes = aplicables.filter(r => r.fecha_inicio <= a && r.fecha_fin >= z);
        if (!vigentes.length) { cerrar(); continue; }
        const mejor = Math.max(...vigentes.map(puntaje));
        const empatadas = vigentes.filter(r => puntaje(r) === mejor);
        // Dos precios iguales que se pisan no son un conflicto.
        const ganadoras = empatadas.some(r => Number(r.precio) !== Number(empatadas[0].precio)) ? empatadas : [empatadas[0]];
        if (ganadoras.length > 1) {
          const previo = conflictos[conflictos.length - 1];
          if (previo && previo.adicional_id === adicionalId && previo.recurso_id === Number(d.recurso_id) &&
            previo.regimen_id === Number(d.regimen_id) && previo.hasta === dia(a, -1)) previo.hasta = z;
          else conflictos.push({ adicional_id: adicionalId, recurso_id: Number(d.recurso_id), regimen_id: Number(d.regimen_id),
            desde: a, hasta: z, reglas: ganadoras.map(r => r.clave) });
          cerrar();
          continue;
        }
        const g = ganadoras[0];
        if (actual && actual.regla === g && actual.fecha_fin === dia(a, -1) && rango === rangoActual) actual.fecha_fin = z;
        else {
          cerrar();
          rangoActual = rango;
          actual = { adicional_id: adicionalId, servicio_id: Number(d.servicio_id), recurso_id: Number(d.recurso_id),
            regimen_id: Number(d.regimen_id), fecha_inicio: a, fecha_fin: z, precio: Number(g.precio), regla: g };
        }
      }
      cerrar();
    }
  }
  return { filas, conflictos };
}

/**
 * Agrupa filas ya materializadas (o cargadas por tramo antes de existir las reglas) en la menor
 * cantidad de reglas que reproducen los mismos precios.
 * filas: [{ adicional_id, recurso_id, regimen_id, fecha_inicio, fecha_fin, precio }]
 * destinos: todos los recursos y regímenes del ámbito ("Todos" = todos ellos). Si traen rangos (días
 *   con tarifa), una regla puede abarcar días sin tarifa de un recurso: al materializarla se recortan.
 * Si el agrupado no reproduce exactamente los precios originales, se devuelve una regla por recurso.
 */
function inferirReglas(filas, destinos) {
  const claveDestino = (recurso, regimen) => `${Number(recurso)}-${Number(regimen)}`;
  const infoDestino = new Map(destinos.map(d => [claveDestino(d.recurso_id, d.regimen_id), d]));
  const servicios = agrupar(destinos, d => Number(d.servicio_id));
  const regimenesServicio = new Map([...servicios].map(([sv, ds]) => [sv, new Set(ds.map(d => Number(d.regimen_id)))]));
  const porFecha = (a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0);
  const salida = [];
  for (const [adicionalId, lista] of agrupar(filas, f => Number(f.adicional_id))) {
    // 1. Tramos de precio de cada destino: se unen los de igual precio contiguos o separados sólo
    //    por días sin tarifa (p. ej. el hueco de un bloque de temporada alta).
    const tramos = new Map();
    for (const [k, propias] of agrupar(lista, f => claveDestino(f.recurso_id, f.regimen_id))) {
      if (!infoDestino.has(k)) continue;
      const rangos = infoDestino.get(k).rangos;
      const hayTarifa = (a, z) => !rangos || rangos.some(x => x.desde <= z && x.hasta >= a);
      const unidos = [];
      const ordenadas = propias.map(f => ({ desde: iso(f.fecha_inicio), hasta: iso(f.fecha_fin), precio: U.redondear(Number(f.precio)) })).sort(porFecha);
      for (const t of ordenadas) {
        const ultimo = unidos[unidos.length - 1];
        const contiguo = ultimo && (dia(ultimo.hasta, 1) >= t.desde || (rangos && !hayTarifa(dia(ultimo.hasta, 1), dia(t.desde, -1))));
        if (ultimo && ultimo.precio === t.precio && contiguo) { if (t.hasta > ultimo.hasta) ultimo.hasta = t.hasta; }
        else unidos.push({ ...t, explicado: false });
      }
      tramos.set(k, unidos);
    }
    // ¿El destino acepta una regla (a, z, p)? Todos sus días con tarifa en [a, z] deben costar p.
    const compatible = (k, a, z, p) => {
      const d = infoDestino.get(k);
      const propios = tramos.get(k) || [];
      const segmentos = d.rangos
        ? d.rangos.filter(x => x.desde <= z && x.hasta >= a).map(x => ({ desde: x.desde > a ? x.desde : a, hasta: x.hasta < z ? x.hasta : z }))
        : [{ desde: a, hasta: z }];
      for (const sg of segmentos) {
        let cursor = sg.desde;
        for (const t of propios) {
          if (t.hasta < cursor || t.desde > sg.hasta) continue;
          if (t.desde > cursor || t.precio !== p) return false;
          cursor = dia(t.hasta, 1);
          if (cursor > sg.hasta) break;
        }
        if (cursor <= sg.hasta) return false;
      }
      return true;
    };
    // 2. Candidatos: los tramos más repetidos primero.
    const candidatos = new Map();
    for (const lista2 of tramos.values()) {
      for (const t of lista2) {
        const c = `${t.desde}|${t.hasta}|${t.precio}`;
        if (!candidatos.has(c)) candidatos.set(c, { desde: t.desde, hasta: t.hasta, precio: t.precio, veces: 0 });
        candidatos.get(c).veces++;
      }
    }
    const ordenCandidatos = [...candidatos.values()].sort((a, b) => b.veces - a.veces || porFecha(a, b));
    const reglas = [];
    for (const cand of ordenCandidatos) {
      const necesitan = new Set();
      for (const [k, lista2] of tramos) {
        if (lista2.some(t => !t.explicado && t.precio === cand.precio && t.desde >= cand.desde && t.hasta <= cand.hasta)) necesitan.add(k);
      }
      if (!necesitan.size) continue;
      const compatibles = new Set([...infoDestino.keys()].filter(k => compatible(k, cand.desde, cand.hasta, cand.precio)));
      // Sólo cuentan los destinos a los que la regla les queda bien en todo su período.
      for (const k of [...necesitan]) if (!compatibles.has(k)) necesitan.delete(k);
      if (!necesitan.size) continue;
      const cubre = ds => ds.length > 0 && ds.every(d => compatibles.has(claveDestino(d.recurso_id, d.regimen_id)));
      const necesita = ds => ds.some(d => necesitan.has(claveDestino(d.recurso_id, d.regimen_id)));
      const agregar = (alcance, ds) => {
        reglas.push({ adicional_id: adicionalId, servicio_id: null, recurso_id: null, regimen_id: null, ...alcance,
          fecha_inicio: cand.desde, fecha_fin: cand.hasta, precio: cand.precio, inferida: true });
        for (const d of ds) {
          const k = claveDestino(d.recurso_id, d.regimen_id);
          necesitan.delete(k);
          for (const t of tramos.get(k) || []) if (t.precio === cand.precio && t.desde >= cand.desde && t.hasta <= cand.hasta) t.explicado = true;
        }
      };
      if (cubre(destinos)) { agregar({}, destinos); continue; }
      for (const [servicioId, ds] of servicios) {
        if (!necesita(ds)) continue;
        if (cubre(ds)) { agregar({ servicio_id: servicioId }, ds); continue; }
        if (regimenesServicio.get(servicioId).size > 1) {
          for (const regimenId of regimenesServicio.get(servicioId)) {
            const dsr = ds.filter(d => Number(d.regimen_id) === regimenId);
            if (necesita(dsr) && cubre(dsr)) agregar({ servicio_id: servicioId, regimen_id: regimenId }, dsr);
          }
        }
        for (const [recursoId, dr] of agrupar(ds, d => Number(d.recurso_id))) {
          if (!necesita(dr)) continue;
          if (cubre(dr)) { agregar({ servicio_id: servicioId, recurso_id: recursoId }, dr); continue; }
          for (const d of dr) {
            if (necesitan.has(claveDestino(d.recurso_id, d.regimen_id))) {
              agregar({ servicio_id: servicioId, recurso_id: recursoId, regimen_id: Number(d.regimen_id) }, [d]);
            }
          }
        }
      }
    }
    // 3. Verificación: las reglas deben dar los mismos precios que las filas originales.
    if (reproduce(reglas, lista, destinos)) salida.push(...reglas);
    else {
      for (const [k, lista2] of tramos) {
        const d = infoDestino.get(k);
        const variosRegimenes = (regimenesServicio.get(Number(d.servicio_id)) || new Set()).size > 1;
        for (const t of lista2) {
          salida.push({ adicional_id: adicionalId, servicio_id: Number(d.servicio_id), recurso_id: Number(d.recurso_id),
            regimen_id: variosRegimenes ? Number(d.regimen_id) : null, fecha_inicio: t.desde, fecha_fin: t.hasta, precio: t.precio, inferida: true });
        }
      }
    }
  }
  return salida.sort((a, b) => a.adicional_id - b.adicional_id || (a.fecha_inicio < b.fecha_inicio ? -1 : a.fecha_inicio > b.fecha_inicio ? 1 : 0) ||
    puntaje(a) - puntaje(b) || (a.servicio_id || 0) - (b.servicio_id || 0) || (a.recurso_id || 0) - (b.recurso_id || 0));
}

/** Compara día por día (en los días con tarifa) el precio de las reglas con el de las filas. */
function reproduce(reglas, filas, destinos) {
  const conFilas = new Set(filas.map(f => `${Number(f.recurso_id)}-${Number(f.regimen_id)}`));
  const objetivo = destinos.filter(d => conFilas.has(`${Number(d.recurso_id)}-${Number(d.regimen_id)}`) || reglas.some(r => aplica(r, d)));
  const { filas: generadas, conflictos } = resolver(reglas.map((r, i) => ({ ...r, clave: i })), objetivo);
  if (conflictos.length) return false;
  const porDia = (lista) => {
    const m = new Map();
    let n = 0;
    for (const f of lista) {
      for (let d = iso(f.fecha_inicio); d <= iso(f.fecha_fin); d = dia(d, 1)) {
        if (++n > 400000) return null;
        m.set(`${Number(f.recurso_id)}|${Number(f.regimen_id)}|${d}`, U.redondear(Number(f.precio)));
      }
    }
    return m;
  };
  const a = porDia(filas);
  const b = porDia(generadas);
  if (!a || !b) return true;
  const rangos = new Map(objetivo.map(d => [`${Number(d.recurso_id)}|${Number(d.regimen_id)}`, d.rangos]));
  const conTarifa = (k) => {
    const [r, g, d] = k.split("|");
    const rs = rangos.get(`${r}|${g}`);
    return !rs || rs.some(x => x.desde <= d && x.hasta >= d);
  };
  for (const [k, v] of a) if (conTarifa(k) && b.get(k) !== v) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

// ------------------------------------------------------------------ ámbitos

function rangosUnidos(lista) {
  const orden = lista.map(x => ({ desde: iso(x.desde), hasta: iso(x.hasta) })).sort((a, b) => (a.desde < b.desde ? -1 : 1));
  const salida = [];
  for (const r of orden) {
    const ultimo = salida[salida.length - 1];
    // Rangos contiguos se conservan separados: las filas se alinean con cada tramo de tarifa.
    if (ultimo && r.desde <= ultimo.hasta) { if (r.hasta > ultimo.hasta) ultimo.hasta = r.hasta; }
    else salida.push(r);
  }
  return salida;
}

/** Recursos y regímenes donde puede valer un precio del ámbito. */
async function destinosDeAmbito(c, ambito, { bloquear = false } = {}) {
  if (ambito.temporada_tarifa_id) {
    const filas = await todos(c, `SELECT r.servicio_id, t.recurso_id, t.regimen_id, t.fecha_inicio AS desde, t.fecha_fin AS hasta
      FROM tarifa t JOIN recurso r ON r.id = t.recurso_id
      WHERE t.temporada_tarifa_id = ? AND t.eliminado = 0${bloquear ? " FOR SHARE" : ""}`, [ambito.temporada_tarifa_id]);
    return [...agrupar(filas, f => `${f.recurso_id}-${f.regimen_id}`).values()].map(ds => ({
      servicio_id: Number(ds[0].servicio_id), recurso_id: Number(ds[0].recurso_id), regimen_id: Number(ds[0].regimen_id),
      rangos: rangosUnidos(ds),
    }));
  }
  const servicios = ambito.servicio_ids || [];
  if (!servicios.length) return [];
  const recursos = await todos(c, "SELECT id, servicio_id FROM recurso WHERE activo = 1 AND servicio_id IN (?) ORDER BY servicio_id, orden, nombre", [servicios]);
  const regimenes = await todos(c, "SELECT servicio_id, regimen_id FROM servicio_regimen WHERE servicio_id IN (?) ORDER BY regimen_id", [servicios]);
  const destinos = [];
  for (const r of recursos) {
    const propios = regimenes.filter(x => Number(x.servicio_id) === Number(r.servicio_id)).map(x => Number(x.regimen_id));
    for (const regimenId of propios.length ? propios : [3]) {
      destinos.push({ servicio_id: Number(r.servicio_id), recurso_id: Number(r.id), regimen_id: regimenId });
    }
  }
  return destinos;
}

/** Condición SQL de las filas de tarifa_adicional que pertenecen al ámbito. */
function condicionFilasAmbito(ambito, alias = "ta") {
  if (ambito.temporada_tarifa_id) return { sql: `${alias}.temporada_tarifa_id = ?`, params: [ambito.temporada_tarifa_id] };
  return {
    sql: `${alias}.temporada_tarifa_id IS NULL AND ${alias}.adicional_precio_id IN (SELECT ap.id FROM adicional_precio ap WHERE ap.predio_id = ?)`,
    params: [ambito.predio_id],
  };
}
function condicionReglasAmbito(ambito, alias = "ap") {
  return ambito.temporada_tarifa_id
    ? { sql: `${alias}.temporada_tarifa_id = ?`, params: [ambito.temporada_tarifa_id] }
    : { sql: `${alias}.predio_id = ?`, params: [ambito.predio_id] };
}

/** Reglas vigentes del ámbito. Los precios cargados antes de las reglas se devuelven agrupados (inferida: true). */
async function reglasDeAmbito(c, ambito, { destinos = null } = {}) {
  const cond = condicionReglasAmbito(ambito);
  const reglas = (await todos(c, `SELECT ap.id, ap.adicional_id, ap.servicio_id, ap.recurso_id, ap.regimen_id, ap.fecha_inicio, ap.fecha_fin, ap.precio
    FROM adicional_precio ap WHERE ${cond.sql} AND ap.activo = 1 ORDER BY ap.adicional_id, ap.fecha_inicio, ap.id`, cond.params)).map(r => ({
    ...r, servicio_id: idONull(r.servicio_id), recurso_id: idONull(r.recurso_id), regimen_id: idONull(r.regimen_id),
    fecha_inicio: iso(r.fecha_inicio), fecha_fin: iso(r.fecha_fin), precio: Number(r.precio),
  }));
  if (!ambito.temporada_tarifa_id) return reglas;
  const sueltas = await todos(c, `SELECT ta.adicional_id, ta.recurso_id, ta.regimen_id, ta.fecha_inicio, ta.fecha_fin, ta.precio
    FROM tarifa_adicional ta WHERE ta.temporada_tarifa_id = ? AND ta.activo = 1 AND ta.adicional_precio_id IS NULL`, [ambito.temporada_tarifa_id]);
  if (!sueltas.length) return reglas;
  const ds = destinos || await destinosDeAmbito(c, ambito);
  return reglas.concat(inferirReglas(sueltas, ds));
}

function describirDestino(nombres, recursoId, regimenId, conRegimen) {
  const recurso = nombres.recursos?.get(Number(recursoId)) || `recurso ${recursoId}`;
  const regimen = conRegimen ? nombres.regimenes?.get(Number(regimenId)) : null;
  return regimen ? `${recurso} (${regimen})` : recurso;
}

async function nombresPara(c, adicionalIds, recursoIds, servicioIds = []) {
  const adicionales = adicionalIds.length ? await todos(c, "SELECT id, nombre FROM adicional WHERE id IN (?)", [adicionalIds]) : [];
  const servicios = servicioIds.length ? await todos(c, "SELECT id, nombre FROM servicio WHERE id IN (?)", [servicioIds]) : [];
  const recursos = recursoIds.length ? await todos(c, "SELECT id, nombre FROM recurso WHERE id IN (?)", [recursoIds]) : [];
  const regimenes = await todos(c, "SELECT id, nombre FROM regimen");
  return {
    adicionales: new Map(adicionales.map(x => [Number(x.id), x.nombre])),
    recursos: new Map(recursos.map(x => [Number(x.id), x.nombre])),
    servicios: new Map(servicios.map(x => [Number(x.id), x.nombre])),
    regimenes: new Map(regimenes.map(x => [Number(x.id), x.nombre])),
  };
}

/**
 * Reemplaza las reglas del ámbito (de los adicionales indicados, o de todos si adicionalIds es null)
 * y vuelve a generar sus filas de tarifa_adicional.
 * opciones: { destinos?, actorId?, verificarOtrosAmbitos? (por defecto: sí, salvo en temporadas de bloque) }
 */
async function materializar(c, ambito, adicionalIds, reglas, opciones = {}) {
  const destinos = opciones.destinos || await destinosDeAmbito(c, ambito, { bloquear: true });
  const ids = adicionalIds ? [...new Set(adicionalIds.map(Number))] : null;
  if (ids) for (const r of reglas) if (!ids.includes(Number(r.adicional_id))) throw U.error("Hay precios de un adicional que no corresponde a esta operación.");
  const { filas, conflictos } = resolver(reglas, destinos);
  const recursosInvolucrados = [...new Set(filas.map(f => f.recurso_id).concat(conflictos.map(x => x.recurso_id)))];
  const adicionalesInvolucrados = [...new Set(reglas.map(r => Number(r.adicional_id)).concat(ids || []))];
  const conRegimen = new Set(destinos.map(d => d.regimen_id)).size > 1;
  if (conflictos.length) {
    const porClave = new Map(reglas.map(r => [r.clave, r]));
    const enConflicto = conflictos.flatMap(x => x.reglas.map(k => porClave.get(k))).filter(Boolean);
    const nombres = await nombresPara(c, adicionalesInvolucrados, recursosInvolucrados.concat(enConflicto.map(r => Number(r.recurso_id)).filter(Boolean)),
      [...new Set(enConflicto.map(r => Number(r.servicio_id)).filter(Boolean))]);
    const alcance = (r) => [r.recurso_id ? nombres.recursos.get(Number(r.recurso_id)) || "un recurso" : r.servicio_id ? nombres.servicios.get(Number(r.servicio_id)) || "un servicio" : "todos los servicios",
      r.regimen_id ? nombres.regimenes.get(Number(r.regimen_id)) : null].filter(Boolean).join(", ");
    const grupos = agrupar(conflictos, x => `${x.adicional_id}|${x.reglas.join(",")}|${x.desde}|${x.hasta}`);
    const detalle = [...grupos.values()].slice(0, 3).map(xs => {
      const x = xs[0];
      const donde = xs.length > 2 ? `${xs.length} recursos` : xs.map(y => describirDestino(nombres, y.recurso_id, y.regimen_id, conRegimen)).join(" y ");
      const precios = x.reglas.map(k => porClave.get(k)).filter(Boolean)
        .map(r => `${alcance(r)} del ${fechaCorta(r.fecha_inicio)} al ${fechaCorta(r.fecha_fin)} a ${U.pesos(r.precio)}`);
      return `en «${nombres.adicionales.get(x.adicional_id) || "Adicional"}» se pisan ${precios.join(" y ")} (del ${fechaCorta(x.desde)} al ${fechaCorta(x.hasta)}, en ${donde})`;
    });
    throw U.error(`Hay dos precios distintos para el mismo día: ${detalle.join("; ")}. Ajustá las fechas o el alcance de uno de ellos.`, 409, { conflictos });
  }

  // Las bajas y los altas se hacen con el ámbito bloqueado por la transacción que llama.
  const condFilas = condicionFilasAmbito(ambito);
  const condReglas = condicionReglasAmbito(ambito);
  const filtroIds = ids ? " AND ta.adicional_id IN (?)" : "";
  const filtroIdsReglas = ids ? " AND ap.adicional_id IN (?)" : "";
  const paramsIds = ids && ids.length ? [ids] : [];
  if (!ids || ids.length) {
    const temporada = ambito.temporada_tarifa_id
      ? await uno(c, "SELECT origen FROM temporada_tarifa WHERE id = ?", [ambito.temporada_tarifa_id]) : null;
    const verificar = opciones.verificarOtrosAmbitos ?? (!temporada || temporada.origen !== "BLOQUE");
    if (verificar && filas.length) await verificarOtrosAmbitos(c, ambito, filas, destinos, conRegimen);
    const lote = U.uuid();
    await c.query(`UPDATE tarifa_adicional ta SET ta.activo = 0, ta.fecha_eliminacion = NOW(), ta.eliminado_usuario_id = ?,
        ta.eliminado_motivo = 'REEMPLAZADO', ta.eliminado_lote = ?
      WHERE ${condFilas.sql} AND ta.activo = 1${filtroIds}`, [opciones.actorId || null, lote, ...condFilas.params, ...paramsIds]);
    await c.query(`UPDATE adicional_precio ap SET ap.activo = 0, ap.fecha_baja = NOW() WHERE ${condReglas.sql} AND ap.activo = 1${filtroIdsReglas}`,
      [...condReglas.params, ...paramsIds]);
  }
  const idsReglas = new Map();
  for (const r of reglas) {
    const [res] = await c.query(`INSERT INTO adicional_precio
        (temporada_tarifa_id, predio_id, adicional_id, servicio_id, recurso_id, regimen_id, fecha_inicio, fecha_fin, precio, usuario_id, usuario_nombre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ambito.temporada_tarifa_id || null, ambito.predio_id || null, r.adicional_id,
      r.servicio_id, r.recurso_id, r.regimen_id, r.fecha_inicio, r.fecha_fin, r.precio, opciones.actorId || null, opciones.actorNombre || null]);
    idsReglas.set(r, res.insertId);
  }
  for (const f of filas) {
    const reglaId = idsReglas.get(f.regla);
    if (ambito.temporada_tarifa_id) {
      // La clave única de la temporada reactiva la fila dada de baja si coincide: igual que el editor por tramo.
      await c.query(`INSERT INTO tarifa_adicional
          (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio, activo, adicional_precio_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE precio = VALUES(precio), activo = 1, adicional_precio_id = VALUES(adicional_precio_id),
          fecha_eliminacion = NULL, eliminado_usuario_id = NULL, eliminado_motivo = NULL, eliminado_lote = NULL`,
      [ambito.temporada_tarifa_id, f.recurso_id, f.regimen_id, f.adicional_id, f.fecha_inicio, f.fecha_fin, f.precio, reglaId]);
    } else {
      await c.query(`INSERT INTO tarifa_adicional
          (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio, activo, adicional_precio_id)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, ?)`, [f.recurso_id, f.regimen_id, f.adicional_id, f.fecha_inicio, f.fecha_fin, f.precio, reglaId]);
    }
  }
  return { reglas: reglas.map(r => ({ ...r, id: idsReglas.get(r) })), filas: filas.length };
}

/**
 * Las cotizaciones sin temporada puntual leen a la vez las temporadas generales y los catálogos de
 * predio: el mismo adicional no puede tener dos precios el mismo día para el mismo recurso y régimen.
 */
async function verificarOtrosAmbitos(c, ambito, filas, destinos, conRegimen) {
  const adicionales = [...new Set(filas.map(f => f.adicional_id))];
  const recursos = [...new Set(filas.map(f => f.recurso_id))];
  const propio = ambito.temporada_tarifa_id
    ? { sql: "NOT (ta.temporada_tarifa_id <=> ?)", params: [ambito.temporada_tarifa_id] }
    : { sql: "NOT (ta.temporada_tarifa_id IS NULL AND ta.adicional_precio_id IN (SELECT ap.id FROM adicional_precio ap WHERE ap.predio_id = ?))", params: [ambito.predio_id] };
  const otras = await todos(c, `SELECT ta.adicional_id, ta.recurso_id, ta.regimen_id, ta.fecha_inicio, ta.fecha_fin, ta.temporada_tarifa_id,
      tt.nombre AS temporada, pr.nombre AS predio
    FROM tarifa_adicional ta
    LEFT JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
    LEFT JOIN adicional_precio ap2 ON ap2.id = ta.adicional_precio_id
    LEFT JOIN predio pr ON pr.id = ap2.predio_id
    WHERE ta.activo = 1 AND ta.adicional_id IN (?) AND ta.recurso_id IN (?)
      AND (ta.temporada_tarifa_id IS NULL OR COALESCE(tt.origen, 'GENERAL') = 'GENERAL')
      AND ${propio.sql}
    FOR SHARE`, [adicionales, recursos, ...propio.params]);
  if (!otras.length) return;
  const choques = [];
  for (const f of filas) {
    for (const o of otras) {
      if (Number(o.adicional_id) !== f.adicional_id || Number(o.recurso_id) !== f.recurso_id || Number(o.regimen_id) !== f.regimen_id) continue;
      const desde = iso(o.fecha_inicio) > f.fecha_inicio ? iso(o.fecha_inicio) : f.fecha_inicio;
      const hasta = iso(o.fecha_fin) < f.fecha_fin ? iso(o.fecha_fin) : f.fecha_fin;
      if (desde <= hasta) choques.push({ ...f, desde, hasta, origen: o.temporada ? `la temporada «${o.temporada}»` : `el catálogo del predio ${o.predio || ""}`.trim() });
    }
  }
  if (!choques.length) return;
  const nombres = await nombresPara(c, adicionales, recursos);
  const grupos = [...agrupar(choques, x => `${x.adicional_id}|${x.origen}`).values()];
  const detalle = grupos.slice(0, 3).map(xs => {
    const desde = xs.map(x => x.desde).sort()[0];
    const hasta = xs.map(x => x.hasta).sort().pop();
    const recursos = [...new Set(xs.map(x => x.recurso_id))];
    const donde = recursos.length > 2 ? `${recursos.length} recursos` : xs.filter((x, i) => xs.findIndex(y => y.recurso_id === x.recurso_id) === i)
      .map(x => describirDestino(nombres, x.recurso_id, x.regimen_id, conRegimen)).join(" y ");
    return `«${nombres.adicionales.get(xs[0].adicional_id) || "Adicional"}» ya tiene precio en ${xs[0].origen} entre el ${fechaCorta(desde)} y el ${fechaCorta(hasta)} (${donde})`;
  });
  throw U.error(`${detalle.join("; ")}. Elegí otras fechas o cambiá ese precio donde está cargado.`, 409,
    { conflictos: choques.slice(0, 50).map(x => ({ adicional_id: x.adicional_id, recurso_id: x.recurso_id, regimen_id: x.regimen_id, desde: x.desde, hasta: x.hasta })) });
}

module.exports = {
  MODALIDADES,
  iso,
  puntaje,
  aplica,
  normalizarReglas,
  resolver,
  inferirReglas,
  destinosDeAmbito,
  reglasDeAmbito,
  materializar,
  verificarOtrosAmbitos,
};
