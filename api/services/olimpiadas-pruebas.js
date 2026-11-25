'use strict';

/**
 * Disciplinas que no se juegan 1 contra 1: se organizan por categorías (maratón, natación, pesca)
 * o por mesas (póker). Acá vive la lógica pura: leer tiempos y marcas, ordenar y repartir medallas.
 * Las consultas y las rutas están en `routes/olimpiadas-pruebas.js`.
 *
 * - TIEMPO (maratón, natación): cada categoría tiene sus participantes y el orden sale del tiempo.
 * - PESCA: los participantes son de la disciplina (los mismos compiten por todo) y cada categoría es
 *   un premio («Mayor peso total», «Mayor cantidad de piezas»…) cuyos ganadores se eligen a mano.
 * - MESAS (póker): jugadores de la disciplina, sentados en mesas, y tres ganadores elegidos a mano.
 *
 * No depende de ningún otro módulo: la migración también lo usa y no tiene que abrir la conexión
 * de la API ni cargar el resto del servidor.
 */

// Misma forma que el `crearErrorHttp` de olimpiadas-comun (error de negocio con su código).
function crearErrorHttp(mensaje, statusCode = 400) {
  const error = new Error(mensaje);
  error.statusCode = statusCode;
  return error;
}

// Cómo se compite en una disciplina (olimpiada_disciplina.formato_competencia).
const FORMATOS = ['PARTIDOS', 'TIEMPO', 'PESCA', 'MESAS'];
const FORMATOS_POR_CATEGORIAS = ['TIEMPO', 'PESCA', 'MESAS'];
const ESTADOS_PRUEBA = ['PROGRAMADA', 'EN_JUEGO', 'FINALIZADA'];
const MEDALLAS = ['ORO', 'PLATA', 'BRONCE'];
// Qué le suma una categoría al medallero por departamental (olimpiada_prueba.suma_medallero).
// La columna también admite PIEZAS y PESO (de cuando pesca llevaba dos tablas por categoría): hoy
// cuentan como TODO.
const OPCIONES_MEDALLERO = ['TODO', 'NADA'];

const MAX_TIEMPO_MS = 100 * 3600 * 1000 - 1;
// Pesca: lo que se anota al lado de cada ganador («12 piezas», «4,350 kg»).
const MAX_MARCA = 60;
const MAX_JUGADORES_MESA = 14;
const MAX_PRUEBAS_DISCIPLINA = 40;
const MAX_PARTICIPANTES_CARGA = 200;
const MAX_PARTICIPANTES_DISCIPLINA = 1500;

function sinAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Formato según el nombre de la disciplina (después se cambia en su ficha).
function formatoSugerido(nombre) {
  const n = sinAcentos(nombre);
  if (/maraton|natacion/.test(n)) return 'TIEMPO';
  if (/\bpesca\b/.test(n)) return 'PESCA';
  if (/\bpo(k|qu)er\b/.test(n)) return 'MESAS';
  return 'PARTIDOS';
}

function esPorCategorias(formato) {
  return FORMATOS_POR_CATEGORIAS.includes(formato);
}

// Cómo se llama cada grupo según el formato: las pantallas hablan de «categoría» o de «mesa».
function nombreGrupo(formato) {
  return formato === 'MESAS' ? 'mesa' : 'categoría';
}

// ---------------------------------------------------------------------------
// Tiempos
// ---------------------------------------------------------------------------

/**
 * Lee un tiempo cronometrado y lo devuelve en milésimas.
 * Acepta milésimas como número o un texto «1:02:03», «32:05,48», «58.30» (segundos).
 * undefined = no vino; null o vacío = sin tiempo.
 */
function leerTiempo(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  let ms = null;
  if (typeof valor === 'number') {
    if (Number.isInteger(valor)) ms = valor;
  } else if (typeof valor === 'string') {
    const texto = valor.trim().replace(/\s+/g, '');
    if (texto === '') return null;
    const decimales = fraccion => Number(String(fraccion || '').padEnd(3, '0'));
    let partes = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(texto);
    if (partes) {
      const horas = Number(partes[1] || 0), minutos = Number(partes[2]), segundos = Number(partes[3]);
      if (segundos < 60 && (partes[1] === undefined || minutos < 60)) ms = ((horas * 60 + minutos) * 60 + segundos) * 1000 + decimales(partes[4]);
    } else {
      partes = /^(\d{1,5})(?:[.,](\d{1,3}))?$/.exec(texto);
      if (partes) ms = Number(partes[1]) * 1000 + decimales(partes[2]);
    }
  }
  if (ms === null) throw crearErrorHttp('El tiempo tiene un formato inválido. Ejemplos: 1:02:03 o 32:05,48');
  if (ms <= 0) throw crearErrorHttp('El tiempo tiene que ser mayor que cero');
  if (ms > MAX_TIEMPO_MS) throw crearErrorHttp('El tiempo es demasiado largo');
  return ms;
}

// 3723450 → «1:02:03,45» · 1925000 → «32:05» · 58300 → «0:58,3»
function formatearTiempo(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return null;
  const total = Math.max(0, Math.round(Number(ms)));
  const horas = Math.floor(total / 3600000);
  const minutos = Math.floor((total % 3600000) / 60000);
  const segundos = Math.floor((total % 60000) / 1000);
  const milesimas = total % 1000;
  const dos = n => String(n).padStart(2, '0');
  let texto = horas > 0 ? `${horas}:${dos(minutos)}:${dos(segundos)}` : `${minutos}:${dos(segundos)}`;
  if (milesimas > 0) texto += `,${milesimas % 10 === 0 ? dos(milesimas / 10) : String(milesimas).padStart(3, '0')}`;
  return texto;
}

// ---------------------------------------------------------------------------
// Pesca
// ---------------------------------------------------------------------------

/**
 * La marca de un ganador: texto corto y libre («12 piezas», «4,350 kg», «42 cm»), porque cada
 * categoría premia otra cosa. undefined = no vino; null = sin marca.
 */
function leerMarca(valor) {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor !== 'string' && typeof valor !== 'number') throw crearErrorHttp('La marca tiene un formato inválido');
  const texto = String(valor).replace(/\s+/g, ' ').trim();
  if (texto.length > MAX_MARCA) throw crearErrorHttp(`La marca admite hasta ${MAX_MARCA} caracteres`);
  return texto || null;
}

/**
 * Lee los ganadores de una categoría de pesca: hasta tres lugares (oro, plata, bronce), cada uno
 * `{ participante_id, marca }` o null si queda sin definir. Devuelve [{ puesto, participante_id, marca }].
 */
function leerGanadores(valor, normalizarId) {
  if (!Array.isArray(valor) || valor.length > MEDALLAS.length) throw crearErrorHttp('Indicá el 1.º, el 2.º y el 3.º puesto');
  const ganadores = [];
  valor.forEach((item, indice) => {
    if (item === null || item === undefined || item === '') return;
    const dato = typeof item === 'object' ? item : { participante_id: item };
    if (dato.participante_id === null || dato.participante_id === undefined || dato.participante_id === '') return;
    const participanteId = normalizarId(dato.participante_id);
    if (!participanteId) throw crearErrorHttp('Uno de los ganadores es inválido');
    ganadores.push({ puesto: indice + 1, participante_id: participanteId, marca: leerMarca(dato.marca) ?? null });
  });
  if (new Set(ganadores.map(g => g.participante_id)).size !== ganadores.length) throw crearErrorHttp('Una misma persona no puede ocupar dos puestos de la misma categoría');
  return ganadores;
}

// «1.º: Ana Ruiz (12 piezas) · 2.º: Beto Paz» — para el historial.
function describirGanadores(ganadores) {
  return [...(ganadores || [])].sort((a, b) => Number(a.puesto) - Number(b.puesto))
    .map(g => `${Number(g.puesto)}.º: ${g.nombre}${g.marca ? ` (${g.marca})` : ''}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Clasificación
// ---------------------------------------------------------------------------

/**
 * Puesto de cada participante con resultado. Los empates comparten el puesto y el siguiente salta
 * (1.º, 2.º, 2.º, 4.º). Devuelve un Map id → puesto.
 */
function puestosSegun(participantes, tieneResultado, comparar) {
  const conResultado = participantes.filter(tieneResultado).sort((a, b) => comparar(a, b) || Number(a.id) - Number(b.id));
  const puestos = new Map();
  let puesto = 0;
  conResultado.forEach((participante, indice) => {
    if (indice === 0 || comparar(conResultado[indice - 1], participante) !== 0) puesto = indice + 1;
    puestos.set(Number(participante.id), puesto);
  });
  return puestos;
}

function medallaDe(puesto) {
  return puesto && puesto <= MEDALLAS.length ? MEDALLAS[puesto - 1] : null;
}

const numero = valor => (valor === null || valor === undefined ? null : Number(valor));
const porOrden = (a, b) => Number(a.orden) - Number(b.orden) || Number(a.id) - Number(b.id);

function clasificarTiempo(participantes) {
  const puestos = puestosSegun(participantes, p => p.tiempo_ms !== null && p.tiempo_ms !== undefined, (a, b) => Number(a.tiempo_ms) - Number(b.tiempo_ms));
  return participantes
    .map(p => {
      const puesto = puestos.get(Number(p.id)) || null;
      return { ...p, tiempo_ms: numero(p.tiempo_ms), tiempo: formatearTiempo(p.tiempo_ms), puesto, medalla: medallaDe(puesto) };
    })
    .sort((a, b) => (a.puesto === null) - (b.puesto === null) || (a.puesto || 0) - (b.puesto || 0) || porOrden(a, b));
}

/**
 * Pesca: los ganadores de una categoría, tal como los eligió la organización. `ganadores` son las
 * filas de olimpiada_prueba_ganador de la categoría y `porId` los participantes de la disciplina.
 */
function ganadoresDePrueba(pruebaId, ganadores, porId) {
  return (ganadores || [])
    .filter(g => Number(g.prueba_id) === Number(pruebaId) && porId.has(Number(g.participante_id)) && MEDALLAS[Number(g.puesto) - 1])
    .sort((a, b) => Number(a.puesto) - Number(b.puesto) || Number(a.id) - Number(b.id))
    .map(g => {
      const p = porId.get(Number(g.participante_id));
      return {
        puesto: Number(g.puesto), medalla: medallaDe(Number(g.puesto)), participante_id: Number(p.id), nombre: p.nombre,
        departamental_id: numero(p.departamental_id), departamental_nombre: p.departamental_nombre || null, marca: g.marca || null,
      };
    });
}

// Póker: el orden es el de la mesa y los puestos son los que eligió la organización.
function clasificarMesa(participantes) {
  return participantes
    .map(p => { const puesto = numero(p.puesto); return { ...p, puesto, medalla: medallaDe(puesto) }; })
    .sort(porOrden);
}

function clasificar(formato, participantes) {
  return formato === 'TIEMPO' ? clasificarTiempo(participantes) : clasificarMesa(participantes);
}

// ---------------------------------------------------------------------------
// Medallero por departamental
// ---------------------------------------------------------------------------

// Lee qué suma una categoría al medallero. undefined = no vino.
function leerSumaMedallero(valor) {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const opcion = String(valor).trim().toUpperCase();
  if (!OPCIONES_MEDALLERO.includes(opcion)) throw crearErrorHttp('La opción del medallero es inválida');
  return opcion;
}

// Lo guardado puede ser PIEZAS o PESO (pesca, antes): suma todo salvo que diga NADA.
function sumaMedallero(prueba) {
  return prueba?.suma_medallero === 'NADA' ? 'NADA' : 'TODO';
}

/**
 * Las medallas que estas disciplinas le suman solas al medallero: los primeros puestos de cada
 * categoría (por tiempo), los ganadores elegidos en cada categoría de pesca o los de póker.
 * Cada fila es de UNA persona: dos corredores de la misma departamental en el podio son dos medallas,
 * y un pescador puede ganar dos categorías (son dos medallas). Sin departamental no hay medalla
 * (el medallero es por departamental).
 *
 * `maxPuesto`: hasta qué puesto reparte puntos la edición (como mínimo los tres primeros).
 * `ganadores`: pesca, las filas de olimpiada_prueba_ganador de la disciplina.
 * Devuelve [{ puesto, departamental_id, nombre, prueba_id, participante_id, criterio, clave_origen, detalle }].
 */
function medallasDeDisciplina(formato, pruebas, participantes, { maxPuesto = 3, ganadores = [] } = {}) {
  const tope = Math.max(3, Number(maxPuesto) || 3);
  const medallas = [];
  const agregar = (p, puesto, prueba, clave) => {
    if (!puesto || puesto > tope || !p.departamental_id) return;
    medallas.push({
      puesto, departamental_id: Number(p.departamental_id), nombre: p.departamental_nombre || null,
      prueba_id: prueba ? Number(prueba.id) : null, participante_id: Number(p.id), criterio: null,
      clave_origen: clave || `P${Number(p.id)}`,
      detalle: [prueba?.nombre, p.nombre].filter(Boolean).join(' · '),
    });
  };
  if (formato === 'MESAS') {
    for (const p of participantes) agregar(p, MEDALLAS[Number(p.puesto) - 1] ? Number(p.puesto) : null, null);
  } else {
    const porId = new Map(participantes.map(p => [Number(p.id), p]));
    for (const prueba of [...pruebas].sort(porOrden)) {
      if (sumaMedallero(prueba) === 'NADA') continue;
      if (formato === 'TIEMPO') {
        const propios = participantes.filter(p => Number(p.prueba_id) === Number(prueba.id));
        for (const p of clasificarTiempo(propios)) agregar(p, p.puesto, prueba);
      } else if (formato === 'PESCA') {
        // La misma persona puede ganar varias categorías: la clave lleva también la categoría
        for (const g of ganadoresDePrueba(prueba.id, ganadores, porId)) {
          agregar({ id: g.participante_id, nombre: g.nombre, departamental_id: g.departamental_id, departamental_nombre: g.departamental_nombre },
            g.puesto, prueba, `P${g.participante_id}:C${Number(prueba.id)}`);
        }
      }
    }
  }
  return medallas.sort((a, b) => a.puesto - b.puesto || String(a.nombre).localeCompare(String(b.nombre), 'es')
    || (a.prueba_id || 0) - (b.prueba_id || 0) || a.participante_id - b.participante_id);
}

// El lugar que ocupa una medalla: la categoría, la tabla (en pesca) y el puesto.
function lugarDeMedalla(medalla) {
  return `${Number(medalla.prueba_id) || 0}:${medalla.criterio || ''}:${Number(medalla.puesto)}`;
}

/**
 * Un ajuste de puntos hecho a mano (por ejemplo «0» para que una categoría no sume) es del lugar,
 * no de la persona: si después cambia quién quedó primero, el oro de esa categoría sigue valiendo
 * lo que la administración dejó. Devuelve las medallas nuevas con su `puntos_manual`.
 */
function heredarAjustes(anteriores, nuevas) {
  const ajustes = new Map();
  for (const medalla of anteriores || []) {
    if (medalla.puntos_manual === null || medalla.puntos_manual === undefined) continue;
    if (!ajustes.has(lugarDeMedalla(medalla))) ajustes.set(lugarDeMedalla(medalla), Number(medalla.puntos_manual));
  }
  return (nuevas || []).map(medalla => ({ ...medalla, puntos_manual: ajustes.has(lugarDeMedalla(medalla)) ? ajustes.get(lugarDeMedalla(medalla)) : null }));
}

// ---------------------------------------------------------------------------
// Lo que sale de la API
// ---------------------------------------------------------------------------
const CAMPOS_POR_FORMATO = {
  TIEMPO: ['tiempo_ms', 'tiempo', 'puesto', 'medalla'],
  PESCA: [],
  MESAS: ['puesto', 'medalla'],
};

function participantePublico(participante, formato, { gestion = false } = {}) {
  const salida = {
    id: Number(participante.id), prueba_id: numero(participante.prueba_id), nombre: participante.nombre,
    departamental_id: numero(participante.departamental_id), departamental_nombre: participante.departamental_nombre || null,
    orden: Number(participante.orden) || 0,
  };
  for (const campo of CAMPOS_POR_FORMATO[formato] || []) salida[campo] = participante[campo] ?? null;
  if (gestion) salida.inscripcion_id = numero(participante.inscripcion_id);
  return salida;
}

/**
 * Arma una disciplina con sus categorías (o mesas) ya ordenadas y con medallas.
 * `gestion` agrega lo que sólo sirve para cargar (jugadores sin mesa, inscripción de origen).
 * `ganadores`: pesca, las filas de olimpiada_prueba_ganador (de una o varias disciplinas).
 */
function armarDisciplina(disciplina, pruebas, participantes, { gestion = false, ganadores = [] } = {}) {
  const formato = disciplina.formato;
  const deLaDisciplina = participantes.filter(p => Number(p.disciplina_id) === Number(disciplina.id));
  const clasificados = formato === 'MESAS' ? clasificarMesa(deLaDisciplina) : null;
  const porId = new Map(deLaDisciplina.map(p => [Number(p.id), p]));
  const grupos = pruebas
    .filter(prueba => Number(prueba.disciplina_id) === Number(disciplina.id))
    .sort(porOrden)
    .map(prueba => {
      // En pesca las personas son de la disciplina: la categoría sólo lleva a sus ganadores
      const propios = formato === 'PESCA' ? [] : deLaDisciplina.filter(p => Number(p.prueba_id) === Number(prueba.id));
      const lista = clasificar(formato, propios).map(p => participantePublico(p, formato, { gestion }));
      const premiados = formato === 'PESCA' ? ganadoresDePrueba(prueba.id, ganadores, porId) : null;
      return {
        id: Number(prueba.id), nombre: prueba.nombre, descripcion: prueba.descripcion || null, fecha: prueba.fecha || null,
        hora_inicio: prueba.hora_inicio || null, estado: prueba.estado, orden: Number(prueba.orden) || 0,
        // Qué le suma al medallero (sólo le sirve a quien carga)
        ...(gestion && formato !== 'MESAS' ? { suma_medallero: sumaMedallero(prueba) } : {}),
        participantes: lista,
        ...(premiados ? { ganadores: premiados } : {}),
        con_resultado: premiados ? premiados.length : lista.filter(p => formato === 'TIEMPO' && p.tiempo_ms !== null).length,
      };
    });
  const salida = {
    ...disciplina,
    grupo: nombreGrupo(formato),
    pruebas: grupos,
    participantes: deLaDisciplina.length,
    en_juego: grupos.filter(g => g.estado === 'EN_JUEGO').length,
  };
  if (formato === 'PESCA') {
    // Todos los que compiten, en el orden en que se cargaron: es el mismo listado para todas las categorías
    salida.competidores = [...deLaDisciplina].sort(porOrden).map(p => participantePublico({ ...p, prueba_id: null }, formato, { gestion }));
  }
  if (formato === 'MESAS') {
    // Los tres ganadores del torneo, elegidos a mano entre todos los jugadores.
    salida.podio = clasificados.filter(p => p.puesto).sort((a, b) => a.puesto - b.puesto || porOrden(a, b)).map(p => participantePublico(p, formato, { gestion }));
    const mesas = new Set(grupos.map(g => g.id));
    const sinMesa = clasificados.filter(p => !mesas.has(Number(p.prueba_id))).map(p => participantePublico({ ...p, prueba_id: null }, formato, { gestion }));
    // Sin mesas armadas, el portal muestra igual quiénes juegan; con mesas, sólo los sentados.
    if (gestion || grupos.length === 0) salida.sin_mesa = sinMesa;
  }
  return salida;
}

/**
 * El día y la hora que comparten las categorías de una disciplina (maratón, natación y pesca se
 * disputan todas juntas). `mixto` avisa que alguna categoría quedó con otro horario.
 */
function horarioComun(pruebas) {
  const lista = pruebas || [];
  const clave = p => `${p.fecha || ''}|${String(p.hora_inicio || '').slice(0, 5)}`;
  const referencia = lista.find(p => p.fecha || p.hora_inicio) || lista[0];
  if (!referencia) return { fecha: null, hora_inicio: null, mixto: false };
  return {
    fecha: referencia.fecha || null, hora_inicio: referencia.hora_inicio ? String(referencia.hora_inicio).slice(0, 5) : null,
    mixto: lista.some(p => clave(p) !== clave(referencia)),
  };
}

module.exports = {
  FORMATOS, FORMATOS_POR_CATEGORIAS, ESTADOS_PRUEBA, MEDALLAS, OPCIONES_MEDALLERO,
  MAX_TIEMPO_MS, MAX_MARCA, MAX_JUGADORES_MESA, MAX_PRUEBAS_DISCIPLINA, MAX_PARTICIPANTES_CARGA, MAX_PARTICIPANTES_DISCIPLINA,
  formatoSugerido, esPorCategorias, nombreGrupo, sinAcentos,
  leerTiempo, formatearTiempo, leerMarca, leerGanadores, describirGanadores,
  puestosSegun, medallaDe, clasificarTiempo, clasificarMesa, clasificar, ganadoresDePrueba,
  leerSumaMedallero, sumaMedallero, medallasDeDisciplina, lugarDeMedalla, heredarAjustes,
  participantePublico, armarDisciplina, horarioComun,
};
