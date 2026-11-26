const { crearErrorHttp, normalizarIdPositivo } = require('./olimpiadas-comun');

const CAMPOS_PARTIDO_EXTRA = ['torneo_id', 'instancia_id', 'lugar_id', 'inscripcion1_id', 'inscripcion2_id', 'mostrar_nombres_publico', 'partido_origen1_id', 'partido_origen2_id',
  'equipo1_id', 'equipo2_id', 'zona', 'origen1_tipo', 'origen1_zona', 'origen1_posicion', 'origen2_tipo', 'origen2_zona', 'origen2_posicion'];
const TIPOS_ORIGEN = ['GANADOR', 'PERDEDOR', 'POSICION'];
const TIPOS_MARCADOR = ['TANTOS', 'SETS', 'GANADOR'];
const REGLAS_DIVISION = ['EXACTA', 'REDONDEO', 'ABAJO', 'ARRIBA', 'COMPLETO'];
const MAX_SETS = 7;
const MAX_PUESTOS = 10;

// ---------------------------------------------------------------------------
// Sets (vóley, pádel, tenis…)
// ---------------------------------------------------------------------------

// Acepta un array [[25,18],[25,20]] o su JSON. Devuelve null si no hay sets y lanza si el formato es inválido.
function normalizarSets(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  let lista = valor;
  if (typeof valor === 'string') {
    try { lista = JSON.parse(valor); } catch (_error) { throw crearErrorHttp('Los sets tienen un formato inválido'); }
  }
  if (!Array.isArray(lista)) throw crearErrorHttp('Los sets tienen un formato inválido');
  const sets = [];
  for (const set of lista) {
    const par = Array.isArray(set) ? set : [set?.a ?? set?.[0], set?.b ?? set?.[1]];
    const vacio = par.every(v => v === null || v === undefined || String(v).trim() === '');
    if (vacio) continue;
    const numeros = par.map(v => (/^\d{1,3}$/.test(String(v ?? '').trim()) ? Number(v) : null));
    if (par.length !== 2 || numeros.some(n => n === null)) throw crearErrorHttp('Cada set lleva dos números enteros, uno por lado');
    sets.push(numeros);
  }
  if (sets.length > MAX_SETS) throw crearErrorHttp(`Se pueden cargar hasta ${MAX_SETS} sets`);
  return sets.length ? sets : null;
}

// Los sets históricos se guardan como lista. Los cuartos y los penales se identifican
// por su clave en el mismo campo de parciales.
function leerParciales(valor) {
  if (!valor) return null;
  if (typeof valor === 'object') return valor;
  try { return JSON.parse(valor); } catch (_error) { return null; }
}

function tipoMarcadorDisciplina(nombre, tipo = 'TANTOS') {
  const basquet = /\b(?:basquet(?:bol|ball)?|basket(?:ball|bol)?|baloncesto)\b/.test(normalizarNombre(nombre));
  return basquet && (!tipo || tipo === 'TANTOS') ? 'CUARTOS' : tipo || 'TANTOS';
}

function permitePenales(nombre, tipo = 'TANTOS') {
  const deporte = normalizarNombre(nombre);
  return (tipo || 'TANTOS') === 'TANTOS' && /\b(?:futbol\d*|futsal)\b/.test(deporte) && !/\btenis\b/.test(deporte);
}

function normalizarCuartos(cuartos, estado) {
  if (!Array.isArray(cuartos) || cuartos.length < 1 || cuartos.length > 4) {
    throw crearErrorHttp('Cargá entre uno y cuatro cuartos');
  }
  if (estado === 'FINALIZADO' && cuartos.length !== 4) {
    throw crearErrorHttp('Completá los cuatro cuartos antes de finalizar el partido');
  }
  return cuartos.map(par => {
    if (!Array.isArray(par) || par.length !== 2 || !par.every(n => Number.isInteger(n) && n >= 0 && n <= 999)) {
      throw crearErrorHttp('Cada cuarto lleva dos puntajes enteros entre 0 y 999');
    }
    return par;
  });
}

// Sets ganados por cada lado: es el resultado global del partido (2 a 0).
function contarSets(sets) {
  let lado1 = 0, lado2 = 0;
  for (const [a, b] of sets || []) { if (a > b) lado1++; else if (b > a) lado2++; }
  return [lado1, lado2];
}

// ---------------------------------------------------------------------------
// Estado del encuentro
// ---------------------------------------------------------------------------
function estaEnVivo(partido) {
  return partido?.estado === 'EN_JUEGO';
}

function conEnVivo(partidos) {
  return (partidos || []).map(p => {
    const parciales = leerParciales(p.sets);
    return { ...p, sets: Array.isArray(parciales) ? parciales : null,
      cuartos: parciales?.cuartos || null, penales: parciales?.penales || null,
      permite_penales: permitePenales(p.disciplina_nombre, p.tipo_marcador),
      tipo_marcador: tipoMarcadorDisciplina(p.disciplina_nombre, p.tipo_marcador),
      en_vivo: estaEnVivo(p), clasificacion1_manual: !!rotuloManual(p, 1), clasificacion2_manual: !!rotuloManual(p, 2) };
  });
}

// ---------------------------------------------------------------------------
// Proyección pública
// ---------------------------------------------------------------------------

// Public responses deliberately use an allowlist: registration IDs and free-text notes
// must never become public merely because another column is added to the private query.
// Sólo estos casilleros describen una clasificación sin identificar a una persona.
const ROTULOS_MANUALES = [
  /^\d{1,2}\.?[º°] (?:ganador|perdedor)$/i,
  /^(?:mejor|peor) (?:ganador|perdedor)(?: \(\d{1,2}\))?$/i,
  /^(?:ganador|perdedor) (?:[a-z]|\(\d{1,2}\))$/i,
];

function rotuloManual(p, lado) {
  if (p[`inscripcion${lado}_id`] || p[`departamental${lado}_id`] || p[`equipo${lado}_id`]
      || p[`origen${lado}_tipo`] || p[`partido_origen${lado}_id`]) return null;
  const texto = String(p[`participante${lado}`] || '').trim();
  return ROTULOS_MANUALES.some(formato => formato.test(texto)) ? texto : null;
}

function rotuloAutomaticoPublico(p, lado, porId) {
  const tipo = p[`origen${lado}_tipo`];
  const id = normalizarIdPositivo(p[`partido_origen${lado}_id`]);
  if (id) {
    const origen = porId?.get(id);
    const ronda = [origen?.instancia_nombre || origen?.fase, origen?.etiqueta].filter(Boolean).join(' ');
    const puesto = tipo === 'PERDEDOR' ? 'Perdedor' : 'Ganador';
    return ronda ? `${puesto} de ${ronda}` : `${puesto} del partido ${id}`;
  }
  const zona = p[`origen${lado}_zona`], posicion = normalizarIdPositivo(p[`origen${lado}_posicion`]);
  if (tipo === 'POSICION' && zona && posicion) return `${posicion}.º de ${nombreZona(zona)}`;
  return null;
}

function partidosPublicos(partidos) {
  const porId = new Map(partidos.map(p => [Number(p.id), p]));
  return partidos.map(p => partidoPublico(p, porId));
}

function partidoPublico(p, porId) {
  const campos = ['id', 'olimpiada_id', 'disciplina_id', 'disciplina_nombre', 'fecha', 'hora_inicio', 'hora_fin', 'etiqueta', 'fase',
    'departamental1_id', 'departamental2_id', 'departamental1_nombre', 'departamental2_nombre', 'resultado1', 'resultado2',
    'ganador', 'estado', 'sede_id', 'sede_nombre', 'orden', 'fecha_modificacion', 'torneo_id', 'torneo_nombre', 'instancia_id',
    'instancia_nombre', 'instancia_orden', 'lugar_id', 'lugar_nombre', 'lugar_predio', 'lugar_direccion', 'lugar_url_mapa',
    'partido_origen1_id', 'partido_origen2_id',
    'equipo1_id', 'equipo2_id', 'equipo1_nombre', 'equipo2_nombre', 'zona', 'bloque', 'sets', 'cuartos', 'penales', 'permite_penales', 'tipo_marcador', 'en_vivo',
    'origen1_tipo', 'origen2_tipo', 'sede_direccion', 'sede_url_mapa', 'sede_lat', 'sede_lng', 'lugar_lat', 'lugar_lng'];
  const salida = Object.fromEntries(campos.filter(c => p[c] !== undefined).map(c => [c, p[c]]));
  for (const lado of [1, 2]) {
    const manual = rotuloManual(p, lado);
    salida[`clasificacion${lado}_manual`] = !!manual;
    if (Number(p.mostrar_nombres_publico) === 1) { salida[`participante${lado}`] = p[`participante${lado}`]; continue; }
    salida[`participante${lado}`] = p[`equipo${lado}_nombre`] || p[`departamental${lado}_nombre`]
      || manual || rotuloAutomaticoPublico(p, lado, porId) || 'A confirmar';
  }
  return salida;
}

function marcadorNumerico(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const texto = String(valor).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(texto)) return null;
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : null;
}

// ---------------------------------------------------------------------------
// Competidores y posiciones
// ---------------------------------------------------------------------------
function normalizarNombre(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Quién ocupa un lado del partido. Un equipo interdepartamental se identifica por su id; una
 * departamental por el suyo. `porNombre` (sólo para clasificar dentro de una zona) acepta además
 * participantes cargados como texto libre.
 */
function competidorDe(partido, lado, { porNombre = false } = {}) {
  const equipoId = normalizarIdPositivo(partido[`equipo${lado}_id`]);
  const inscripcionId = normalizarIdPositivo(partido[`inscripcion${lado}_id`]);
  const departamentalId = normalizarIdPositivo(partido[`departamental${lado}_id`]);
  const nombre = partido[`participante${lado}`] || null;
  const base = { participante: nombre, departamental_id: departamentalId, inscripcion_id: inscripcionId, equipo_id: equipoId };
  if (equipoId) return { ...base, clave: `E${equipoId}`, departamental_id: null, inscripcion_id: null, nombre: partido[`equipo${lado}_nombre`] || nombre };
  if (inscripcionId && porNombre) return { ...base, clave: `I${inscripcionId}`, nombre };
  if (departamentalId) return { ...base, clave: `D${departamentalId}`, nombre: (porNombre && nombre) || partido[`departamental${lado}_nombre`] || nombre || `Departamental ${departamentalId}` };
  if (porNombre && normalizarNombre(nombre)) return { ...base, clave: `N${normalizarNombre(nombre)}`, nombre };
  return null;
}

// Standings count only finalized matches with an adjudicated winner/draw and both
// sides known; scheduled matches and undecided walkovers never award points.
function calcularPosiciones(partidos, opciones = {}) {
  const tabla = new Map();
  for (const p of partidos) {
    if (p.estado !== 'FINALIZADO' || ![0, 1, 2].includes(Number(p.ganador)) || p.ganador == null) continue;
    const lados = [competidorDe(p, 1, opciones), competidorDe(p, 2, opciones)];
    if (lados.some(lado => !lado) || lados[0].clave === lados[1].clave) continue;
    const tantos = [marcadorNumerico(p.resultado1), marcadorNumerico(p.resultado2)];
    for (let i = 0; i < 2; i++) {
      const lado = lados[i];
      if (!tabla.has(lado.clave)) {
        tabla.set(lado.clave, {
          clave: lado.clave, departamental_id: lado.equipo_id ? null : lado.departamental_id, equipo_id: lado.equipo_id || null,
          nombre: lado.nombre, competidor: lado,
          jugados: 0, ganados: 0, empatados: 0, perdidos: 0, a_favor: 0, en_contra: 0, diferencia: 0, puntos: 0,
        });
      }
      const fila = tabla.get(lado.clave);
      fila.jugados++;
      const empate = Number(p.ganador) === 0;
      const gano = Number(p.ganador) === i + 1;
      fila[empate ? 'empatados' : gano ? 'ganados' : 'perdidos']++;
      fila.puntos += empate ? 1 : gano ? 3 : 0;
      if (tantos.every(n => n !== null)) {
        fila.a_favor += tantos[i];
        fila.en_contra += tantos[1 - i];
      }
      fila.diferencia = fila.a_favor - fila.en_contra;
    }
  }
  return [...tabla.values()].sort((a, b) => b.puntos - a.puntos || b.ganados - a.ganados || b.diferencia - a.diferencia || b.a_favor - a.a_favor || String(a.nombre).localeCompare(String(b.nombre), 'es'))
    .map((fila, index) => {
      const { competidor, ...publica } = fila;
      return opciones.conCompetidor ? { ...publica, competidor, posicion: index + 1 } : { ...publica, posicion: index + 1 };
    });
}

// ---------------------------------------------------------------------------
// Clasificación automática entre fases
// ---------------------------------------------------------------------------
function mismaZona(a, b) { return normalizarNombre(a) !== '' && normalizarNombre(a) === normalizarNombre(b); }
function mismoTorneo(a, b) { return (normalizarIdPositivo(a) || 0) === (normalizarIdPositivo(b) || 0); }
function recortarNombre(texto) { const valor = String(texto || ''); return valor.length <= 120 ? valor : `${valor.slice(0, 119)}…`; }

function nombreZona(zona) {
  const texto = String(zona || '').trim();
  return /^zona|^grupo/i.test(texto) ? texto : `Zona ${texto}`;
}

function describirOrigen(tipo, origen) {
  const verbo = tipo === 'PERDEDOR' ? 'Perdedor' : 'Ganador';
  if (!origen) return 'A confirmar';
  const instancia = origen.instancia_nombre || origen.fase;
  const rotulo = [instancia, origen.etiqueta].filter(Boolean).join(' ').trim();
  return recortarNombre(rotulo ? `${verbo} de ${rotulo}` : `${verbo} de ${origen.participante1} vs ${origen.participante2}`);
}

const CAMPOS_LADO = ['participante', 'departamental', 'inscripcion', 'equipo'];
function campoLado(campo, lado) { return campo === 'participante' ? `participante${lado}` : `${campo}${lado}_id`; }

/**
 * Función pura. Recibe TODOS los partidos vigentes de una disciplina (de una edición) y devuelve
 * qué lados hay que actualizar según sus orígenes:
 *  - GANADOR / PERDEDOR de otro partido: se completa cuando ese partido termina con ganador.
 *  - POSICION n de una zona: se completa cuando terminaron todos los partidos de la zona.
 * Si el origen deja de estar definido (se corrige o se reabre un resultado) el lado vuelve a quedar
 * «por definir». Los empates en el corte de una zona se informan en `avisos`: el sistema elige por
 * diferencia y tantos, y la organización puede corregirlo a mano.
 */
function resolverClasificacion(partidosOriginales) {
  const partidos = (partidosOriginales || []).map(p => ({ ...p }));
  const porId = new Map(partidos.map(p => [Number(p.id), p]));
  const cambios = new Map();
  const avisos = new Set();
  const maxPasadas = Math.max(2, partidos.length + 1);
  for (let pasada = 0; pasada < maxPasadas; pasada++) {
    let huboCambios = false;
    for (const partido of partidos) {
      for (const lado of [1, 2]) {
        const tipo = partido[`origen${lado}_tipo`];
        if (!TIPOS_ORIGEN.includes(tipo)) continue;
        let destino = null;
        let pendiente = 'A confirmar';
        if (tipo === 'POSICION') {
          const zona = partido[`origen${lado}_zona`];
          const posicion = Number(partido[`origen${lado}_posicion`]) || 0;
          const deLaZona = partidos.filter(p => p.id !== partido.id && mismaZona(p.zona, zona) && mismoTorneo(p.torneo_id, partido.torneo_id));
          // El rótulo usa el nombre de la zona tal como figura en sus partidos.
          const rotuloZona = nombreZona(deLaZona[0]?.zona || zona);
          pendiente = recortarNombre(`${posicion}.º de ${rotuloZona}`);
          const completa = deLaZona.length > 0 && deLaZona.every(p => p.estado === 'FINALIZADO' && [0, 1, 2].includes(Number(p.ganador)) && p.ganador != null);
          if (completa && posicion > 0) {
            const tabla = calcularPosiciones(deLaZona, { porNombre: true, conCompetidor: true });
            const fila = tabla[posicion - 1];
            if (fila) {
              destino = fila.competidor;
              const vecina = [tabla[posicion - 2], tabla[posicion]].find(otra => otra
                && otra.puntos === fila.puntos && otra.ganados === fila.ganados && otra.diferencia === fila.diferencia && otra.a_favor === fila.a_favor);
              if (vecina) avisos.add(`Hay empate en ${rotuloZona} entre ${fila.nombre} y ${vecina.nombre}: revisá quién clasifica.`);
            }
          }
        } else {
          const origen = porId.get(Number(partido[`partido_origen${lado}_id`]));
          pendiente = describirOrigen(tipo, origen);
          const ganador = Number(origen?.ganador);
          if (origen && origen.estado === 'FINALIZADO' && origen.ganador != null && [1, 2].includes(ganador)) {
            destino = competidorDe(origen, tipo === 'GANADOR' ? ganador : 3 - ganador, { porNombre: true })
              || { participante: origen[`participante${tipo === 'GANADOR' ? ganador : 3 - ganador}`], departamental_id: null, inscripcion_id: null, equipo_id: null };
          }
        }
        const nuevo = destino
          ? { participante: recortarNombre(destino.participante || destino.nombre || pendiente), departamental: destino.departamental_id || null, inscripcion: destino.inscripcion_id || null, equipo: destino.equipo_id || null }
          : { participante: pendiente, departamental: null, inscripcion: null, equipo: null };
        const distinto = CAMPOS_LADO.some(campo => {
          const actual = partido[campoLado(campo, lado)];
          return campo === 'participante' ? String(actual || '') !== String(nuevo[campo] || '') : (normalizarIdPositivo(actual) || null) !== nuevo[campo];
        });
        if (!distinto) continue;
        huboCambios = true;
        const registro = cambios.get(Number(partido.id)) || { id: Number(partido.id), campos: {}, lados: {} };
        const anterior = registro.lados[lado]?.anterior ?? partido[`participante${lado}`];
        for (const campo of CAMPOS_LADO) {
          partido[campoLado(campo, lado)] = nuevo[campo];
          registro.campos[campoLado(campo, lado)] = nuevo[campo];
        }
        registro.lados[lado] = { anterior, nuevo: nuevo.participante, definido: !!destino };
        registro.jugado = ['EN_JUEGO', 'FINALIZADO'].includes(partido.estado);
        cambios.set(Number(partido.id), registro);
      }
    }
    if (!huboCambios) break;
  }
  // Un lado que volvió a su valor original no es un cambio.
  const originales = new Map((partidosOriginales || []).map(p => [Number(p.id), p]));
  const lista = [];
  for (const registro of cambios.values()) {
    const original = originales.get(registro.id);
    const campos = Object.fromEntries(Object.entries(registro.campos).filter(([campo, valor]) => {
      const antes = original?.[campo];
      return campo.startsWith('participante') ? String(antes || '') !== String(valor || '') : (normalizarIdPositivo(antes) || null) !== (valor || null);
    }));
    if (Object.keys(campos).length) lista.push({ ...registro, campos });
  }
  return { cambios: lista, avisos: [...avisos] };
}

// Un partido no puede depender (directa o indirectamente) de sí mismo.
function hayCiclo(partidos, partidoId, origenIds) {
  const porId = new Map((partidos || []).map(p => [Number(p.id), p]));
  const pendientes = [...origenIds].map(Number).filter(Boolean);
  const vistos = new Set();
  while (pendientes.length) {
    const id = pendientes.pop();
    if (id === Number(partidoId)) return true;
    if (vistos.has(id)) continue;
    vistos.add(id);
    const origen = porId.get(id);
    if (!origen) continue;
    for (const lado of [1, 2]) if (origen[`partido_origen${lado}_id`]) pendientes.push(Number(origen[`partido_origen${lado}_id`]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Medallero
// ---------------------------------------------------------------------------
const NOMBRES_PUESTO = ['Oro', 'Plata', 'Bronce'];
function nombrePuesto(puesto) { return NOMBRES_PUESTO[puesto - 1] || `${puesto}.º puesto`; }

function redondear2(valor) { return Math.round((Number(valor) || 0) * 100) / 100; }

// Puntos que le tocan a cada departamental de un equipo de `cantidad` departamentales.
function repartirPuntos(puntos, cantidad, regla = 'EXACTA') {
  const total = Number(puntos) || 0;
  if (cantidad <= 1 || regla === 'COMPLETO') return total;
  const parte = total / cantidad;
  if (regla === 'REDONDEO') return Math.round(parte);
  if (regla === 'ABAJO') return Math.floor(parte);
  if (regla === 'ARRIBA') return Math.ceil(parte);
  return redondear2(parte);
}

function puntosPorPuestoDe(puntos) {
  if (Array.isArray(puntos)) return new Map(puntos.map(p => [Number(p.puesto), Number(p.puntos) || 0]));
  return new Map([[1, Number(puntos?.oro) || 0], [2, Number(puntos?.plata) || 0], [3, Number(puntos?.bronce) || 0]]);
}

/**
 * Tabla del medallero. `medallas`: [{ disciplina_id, puesto, departamental_id, nombre, equipo_id?, puntos_manual? }].
 * El medallero es siempre por departamental. Las filas con el mismo `equipo_id` son un equipo
 * interdepartamental: cada departamental suma la medalla y los puntos del puesto se reparten entre
 * ellas según la regla de la edición. Sin `equipo_id` cada fila es un ganador distinto (por ejemplo
 * dos bronces) y se lleva los puntos completos. `puntos_manual` pisa el cálculo de esa fila.
 */
function calcularTablaMedallero(medallas, puntos, { division = 'EXACTA' } = {}) {
  const puntosPorPuesto = puntosPorPuestoDe(puntos);
  const integrantes = new Map();
  for (const medalla of medallas || []) {
    if (!medalla.equipo_id) continue;
    const clave = `${medalla.disciplina_id}:${medalla.puesto}:${medalla.equipo_id}`;
    integrantes.set(clave, (integrantes.get(clave) || 0) + 1);
  }
  const tabla = new Map();
  for (const medalla of medallas || []) {
    const id = Number(medalla.departamental_id);
    if (!tabla.has(id)) tabla.set(id, { departamental_id: id, nombre: medalla.nombre, oro: 0, plata: 0, bronce: 0, otros: 0, puntos: 0 });
    const fila = tabla.get(id);
    const puesto = Number(medalla.puesto);
    if (puesto === 1) fila.oro += 1;
    else if (puesto === 2) fila.plata += 1;
    else if (puesto === 3) fila.bronce += 1;
    else fila.otros += 1;
    fila.puntos += puntosDeMedalla(medalla, puntosPorPuesto, integrantes, division);
  }
  return [...tabla.values()]
    .map((fila) => ({ ...fila, puntos: redondear2(fila.puntos) }))
    .sort(
      (a, b) =>
        b.puntos - a.puntos ||
        b.oro - a.oro ||
        b.plata - a.plata ||
        b.bronce - a.bronce ||
        String(a.nombre).localeCompare(String(b.nombre), "es")
    );
}

function puntosDeMedalla(medalla, puntosPorPuesto, integrantes, division) {
  if (medalla.puntos_manual !== null && medalla.puntos_manual !== undefined && medalla.puntos_manual !== '') return Number(medalla.puntos_manual) || 0;
  const delPuesto = puntosPorPuesto.get(Number(medalla.puesto)) || 0;
  const cantidad = medalla.equipo_id ? integrantes.get(`${medalla.disciplina_id}:${medalla.puesto}:${medalla.equipo_id}`) || 1 : 1;
  return repartirPuntos(delPuesto, cantidad, division);
}

// Detalle por disciplina: todos los puestos con puntos (como mínimo los tres primeros) y sus ganadores.
function agruparMedallasPorDisciplina(disciplinas, medallas, { puntos = null, division = 'EXACTA' } = {}) {
  const puntosPorPuesto = puntosPorPuestoDe(puntos || {});
  const maxPuesto = Math.max(3, ...puntosPorPuesto.keys(), ...(medallas || []).map(m => Number(m.puesto) || 0));
  const integrantes = new Map();
  for (const medalla of medallas || []) {
    if (!medalla.equipo_id) continue;
    const clave = `${medalla.disciplina_id}:${medalla.puesto}:${medalla.equipo_id}`;
    integrantes.set(clave, (integrantes.get(clave) || 0) + 1);
  }
  const nueva = (id, nombre) => ({
    disciplina_id: id, disciplina_nombre: nombre, automatico: true,
    puestos: Array.from({ length: maxPuesto }, (_, i) => ({ puesto: i + 1, nombre: nombrePuesto(i + 1), departamentales: [], ganadores: [] })),
  });
  const porDisciplina = new Map();
  for (const disciplina of disciplinas || []) porDisciplina.set(Number(disciplina.id), nueva(Number(disciplina.id), disciplina.nombre));
  for (const medalla of medallas || []) {
    const id = Number(medalla.disciplina_id);
    if (!porDisciplina.has(id)) porDisciplina.set(id, nueva(id, medalla.disciplina_nombre));
    const disciplina = porDisciplina.get(id);
    if (medalla.origen === 'MANUAL') disciplina.automatico = false;
    const puesto = disciplina.puestos.find((p) => p.puesto === Number(medalla.puesto));
    if (!puesto) continue;
    const departamental = { id: Number(medalla.departamental_id), nombre: medalla.nombre };
    puesto.departamentales.push(departamental);
    const puntosFila = redondear2(puntosDeMedalla(medalla, puntosPorPuesto, integrantes, division));
    const detalle = { ...departamental, medalla_id: medalla.id ?? null, puntos: puntosFila, puntos_manual: medalla.puntos_manual === null || medalla.puntos_manual === undefined ? null : Number(medalla.puntos_manual) };
    const equipoId = normalizarIdPositivo(medalla.equipo_id);
    let ganador = equipoId ? puesto.ganadores.find(g => g.equipo_id === equipoId) : null;
    if (!ganador) {
      ganador = equipoId
        ? { tipo: 'EQUIPO', equipo_id: equipoId, departamental_id: null, nombre: medalla.equipo_nombre || '', departamentales: [] }
        // `detalle`: en las disciplinas por categorías, de qué categoría es la medalla y quién la ganó
        : { tipo: 'DEPARTAMENTAL', equipo_id: null, departamental_id: departamental.id, nombre: departamental.nombre, detalle: medalla.detalle || null, departamentales: [] };
      puesto.ganadores.push(ganador);
    }
    ganador.departamentales.push(detalle);
    if (equipoId && !medalla.equipo_nombre) ganador.nombre = ganador.departamentales.map(d => d.nombre).join(' + ');
  }
  return [...porDisciplina.values()].sort((a, b) => String(a.disciplina_nombre).localeCompare(String(b.disciplina_nombre), "es"));
}

/**
 * Función pura. Con los partidos de una disciplina devuelve los puestos que se desprenden de los
 * resultados: la final define oro y plata; el partido por el tercer puesto, bronce y cuarto.
 * Cada partido decisivo reparte sus puestos de forma independiente.
 */
function puestosSegunResultados(partidos) {
  const rotulos = p => [p.instancia_nombre, p.fase, p.etiqueta].map(normalizarNombre);
  const tercerPuesto = /^(?:(?:partido|final) )?(?:por (?:el |la )?)?(?:(?:tercer|tercero|3(?:er|ro|o)?) (?:puesto|lugar)|(?:tercer|tercero|3(?:er|ro|o)?) (?:y )?(?:cuarto|4(?:to|o)?)(?: puestos?)?|(?:medalla de )?bronce)$/;
  const esTercero = p => rotulos(p).some(r => tercerPuesto.test(r)) || normalizarNombre(p.instancia_nombre) === 'tercero';
  const esFinal = p => {
    const nombres = rotulos(p);
    return !esTercero(p) && nombres.some(r => /^(?:(?:gran|partido) )?final$/.test(r))
      && !nombres.some(r => /\b(?:semifinal(?:es)?|semi final(?:es)?|cuartos?|octavos?|dieciseisavos?)\b/.test(r));
  };
  const vigentes = (partidos || []).filter(p => !Number(p.eliminado));
  const finales = vigentes.filter(esFinal);
  const terceros = vigentes.filter(esTercero);
  if (finales.length > 1 || terceros.length > 1) return null;
  if (finales.length && terceros.length && finales[0].torneo_id !== terceros[0].torneo_id) return null;
  const puestos = [];
  const agregar = (partido, puestoGanador) => {
    const ganador = Number(partido.ganador);
    if (partido.estado !== 'FINALIZADO' || partido.ganador == null || ![1, 2].includes(ganador)) return;
    puestos.push({ puesto: puestoGanador, competidor: competidorDe(partido, ganador) });
    puestos.push({ puesto: puestoGanador + 1, competidor: competidorDe(partido, 3 - ganador) });
  };
  if (finales.length) {
    agregar(finales[0], 1);
  } else {
    // El cruce por el bronce identifica ambas semifinales de la misma llave.
    // Si sus dos ganadoras representan a la misma departamental, ya se conocen oro y plata.
    const semifinales = vigentes.filter(p => /^semi\s*final(?:es)?$/.test(normalizarNombre(p.instancia_nombre)));
    const torneoId = semifinales[0]?.torneo_id;
    const tercero = terceros[0];
    const origenes = new Set([1, 2].filter(lado => tercero?.[`origen${lado}_tipo`] === 'PERDEDOR')
      .map(lado => normalizarIdPositivo(tercero[`partido_origen${lado}_id`])).filter(Boolean));
    if (torneoId && semifinales.length === 2 && origenes.size === 2 && semifinales.every(p => origenes.has(Number(p.id)))
      && vigentes.every(p => p.torneo_id === torneoId)) {
      const finalistas = semifinales.map(p => p.estado === 'FINALIZADO' && [1, 2].includes(Number(p.ganador)) ? competidorDe(p, Number(p.ganador)) : null);
      if (finalistas[0]?.departamental_id && finalistas[0].departamental_id === finalistas[1]?.departamental_id) {
        puestos.push({ puesto: 1, competidor: finalistas[0] }, { puesto: 2, competidor: finalistas[1] });
      }
    }
    if (!puestos.length && !terceros.length) return null;
  }
  if (terceros.length === 1) agregar(terceros[0], 3);
  return puestos.filter(p => p.competidor);
}

async function listarTorneos(conexion, olimpiadaId, disciplinaIds = null) {
  if (Array.isArray(disciplinaIds) && !disciplinaIds.length) return [];
  const [torneos] = await conexion.query(`SELECT t.id, t.olimpiada_id, t.disciplina_id, d.nombre AS disciplina_nombre,
    t.nombre, t.formato, t.descripcion, t.fecha_modificacion FROM olimpiada_torneo t
    INNER JOIN olimpiada_disciplina d ON d.id = t.disciplina_id
    WHERE t.olimpiada_id = ? AND t.eliminado = 0 ${disciplinaIds ? 'AND t.disciplina_id IN (?)' : ''}
    ORDER BY d.nombre, t.nombre, t.id`, disciplinaIds ? [olimpiadaId, disciplinaIds] : [olimpiadaId]);
  if (!torneos.length) return [];
  const [instancias] = await conexion.query(`SELECT ti.torneo_id, i.id, i.nombre, ti.orden FROM olimpiada_torneo_instancia ti
    INNER JOIN olimpiada_instancia i ON i.id = ti.instancia_id WHERE ti.torneo_id IN (?) ORDER BY ti.orden, i.id`, [torneos.map(t => t.id)]);
  return torneos.map(t => ({ ...t, instancias: instancias.filter(i => Number(i.torneo_id) === Number(t.id)) }));
}

async function listarEquipos(conexion, olimpiadaId, disciplinaIds = null) {
  if (Array.isArray(disciplinaIds) && !disciplinaIds.length) return [];
  const [equipos] = await conexion.query(`SELECT e.id, e.olimpiada_id, e.disciplina_id, e.nombre FROM olimpiada_equipo e
    WHERE e.olimpiada_id = ? AND e.eliminado = 0 ${disciplinaIds ? 'AND e.disciplina_id IN (?)' : ''} ORDER BY e.nombre, e.id`,
  disciplinaIds ? [olimpiadaId, disciplinaIds] : [olimpiadaId]);
  if (!equipos.length) return [];
  const [miembros] = await conexion.query(`SELECT ed.equipo_id, d.id, d.nombre FROM olimpiada_equipo_departamental ed
    INNER JOIN departamental d ON d.id = ed.departamental_id WHERE ed.equipo_id IN (?) ORDER BY d.nombre`, [equipos.map(e => e.id)]);
  return equipos.map(e => {
    const departamentales = miembros.filter(m => Number(m.equipo_id) === Number(e.id)).map(m => ({ id: Number(m.id), nombre: m.nombre }));
    return { ...e, departamentales, departamental_ids: departamentales.map(d => d.id) };
  });
}

function filtroId(query, campo) {
  if (query[campo] === undefined || query[campo] === '') return null;
  const id = normalizarIdPositivo(query[campo]);
  if (!id) throw crearErrorHttp(`El filtro ${campo} es inválido`);
  return id;
}

module.exports = {
  CAMPOS_PARTIDO_EXTRA, TIPOS_ORIGEN, TIPOS_MARCADOR, REGLAS_DIVISION, MAX_SETS, MAX_PUESTOS,
  partidoPublico, partidosPublicos, marcadorNumerico, calcularPosiciones, listarTorneos, listarEquipos, filtroId,
  normalizarSets, leerParciales, normalizarCuartos, tipoMarcadorDisciplina, permitePenales, contarSets, estaEnVivo, conEnVivo,
  normalizarNombre, competidorDe, resolverClasificacion, hayCiclo, nombreZona,
  nombrePuesto, repartirPuntos, calcularTablaMedallero, agruparMedallasPorDisciplina, puestosSegunResultados,
};
