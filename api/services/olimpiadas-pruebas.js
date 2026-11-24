'use strict';

/**
 * Disciplinas que no se juegan 1 contra 1: se organizan por categorías (maratón, natación, pesca)
 * o por mesas (póker). Acá vive la lógica pura: leer tiempos y pesos, ordenar y repartir medallas.
 * Las consultas y las rutas están en `routes/olimpiadas-pruebas.js`.
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

const MAX_TIEMPO_MS = 100 * 3600 * 1000 - 1;
const MAX_PIEZAS = 9999;
const MAX_PESO_GRAMOS = 999999;
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
function leerCantidad(valor, { maximo, etiqueta }) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  const texto = String(valor).trim();
  if (!/^\d{1,7}$/.test(texto) || Number(texto) > maximo) throw crearErrorHttp(`${etiqueta} tiene que ser un número entero entre 0 y ${maximo}`);
  return Number(texto);
}

function leerPiezas(valor) {
  return leerCantidad(valor, { maximo: MAX_PIEZAS, etiqueta: 'La cantidad de piezas' });
}

// El peso se guarda en gramos. Llega en gramos (`peso_gramos`) o en kilos con coma o punto (`peso_kg`: «4,350»).
function leerPeso(body) {
  if (body.peso_gramos !== undefined) return leerCantidad(body.peso_gramos, { maximo: MAX_PESO_GRAMOS, etiqueta: 'El peso en gramos' });
  const valor = body.peso_kg;
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  const texto = String(valor).trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(texto)) throw crearErrorHttp('El peso va en kilos, con hasta tres decimales. Ejemplo: 4,350');
  const gramos = Math.round(Number(texto) * 1000);
  if (gramos > MAX_PESO_GRAMOS) throw crearErrorHttp('El peso es demasiado grande');
  return gramos;
}

// 4350 → «4,350 kg»
function formatearPeso(gramos) {
  if (gramos === null || gramos === undefined) return null;
  return `${(Number(gramos) / 1000).toFixed(3).replace('.', ',')} kg`;
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
 * Pesca premia dos cosas: la mayor cantidad de piezas y el mayor peso total. Cada participante
 * lleva su puesto en las dos tablas; el empate en una se define por la otra. Sin piezas (o sin
 * peso) no hay medalla.
 */
function clasificarPesca(participantes) {
  const piezas = p => Number(p.piezas) || 0, peso = p => Number(p.peso_gramos) || 0;
  const porPiezas = puestosSegun(participantes, p => p.piezas !== null && p.piezas !== undefined, (a, b) => piezas(b) - piezas(a) || peso(b) - peso(a));
  const porPeso = puestosSegun(participantes, p => p.peso_gramos !== null && p.peso_gramos !== undefined, (a, b) => peso(b) - peso(a) || piezas(b) - piezas(a));
  return participantes
    .map(p => {
      const puestoPiezas = porPiezas.get(Number(p.id)) || null, puestoPeso = porPeso.get(Number(p.id)) || null;
      return {
        ...p, piezas: numero(p.piezas), peso_gramos: numero(p.peso_gramos), peso: formatearPeso(p.peso_gramos),
        puesto_piezas: puestoPiezas, medalla_piezas: piezas(p) > 0 ? medallaDe(puestoPiezas) : null,
        puesto_peso: puestoPeso, medalla_peso: peso(p) > 0 ? medallaDe(puestoPeso) : null,
      };
    })
    .sort((a, b) => (a.puesto_piezas === null) - (b.puesto_piezas === null) || (a.puesto_piezas || 0) - (b.puesto_piezas || 0)
      || (a.puesto_peso === null) - (b.puesto_peso === null) || (a.puesto_peso || 0) - (b.puesto_peso || 0) || porOrden(a, b));
}

// Póker: el orden es el de la mesa y los puestos son los que eligió la organización.
function clasificarMesa(participantes) {
  return participantes
    .map(p => { const puesto = numero(p.puesto); return { ...p, puesto, medalla: medallaDe(puesto) }; })
    .sort(porOrden);
}

function clasificar(formato, participantes) {
  if (formato === 'TIEMPO') return clasificarTiempo(participantes);
  if (formato === 'PESCA') return clasificarPesca(participantes);
  return clasificarMesa(participantes);
}

// ---------------------------------------------------------------------------
// Lo que sale de la API
// ---------------------------------------------------------------------------
const CAMPOS_POR_FORMATO = {
  TIEMPO: ['tiempo_ms', 'tiempo', 'puesto', 'medalla'],
  PESCA: ['piezas', 'peso_gramos', 'peso', 'puesto_piezas', 'medalla_piezas', 'puesto_peso', 'medalla_peso'],
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
 */
function armarDisciplina(disciplina, pruebas, participantes, { gestion = false } = {}) {
  const formato = disciplina.formato;
  const deLaDisciplina = participantes.filter(p => Number(p.disciplina_id) === Number(disciplina.id));
  const clasificados = formato === 'MESAS' ? clasificarMesa(deLaDisciplina) : null;
  const grupos = pruebas
    .filter(prueba => Number(prueba.disciplina_id) === Number(disciplina.id))
    .sort(porOrden)
    .map(prueba => {
      const propios = deLaDisciplina.filter(p => Number(p.prueba_id) === Number(prueba.id));
      const lista = (formato === 'MESAS' ? clasificarMesa(propios) : clasificar(formato, propios)).map(p => participantePublico(p, formato, { gestion }));
      return {
        id: Number(prueba.id), nombre: prueba.nombre, descripcion: prueba.descripcion || null, fecha: prueba.fecha || null,
        hora_inicio: prueba.hora_inicio || null, estado: prueba.estado, orden: Number(prueba.orden) || 0,
        participantes: lista,
        con_resultado: lista.filter(p => (formato === 'TIEMPO' ? p.tiempo_ms !== null : formato === 'PESCA' ? p.piezas !== null || p.peso_gramos !== null : false)).length,
      };
    });
  const salida = {
    ...disciplina,
    grupo: nombreGrupo(formato),
    pruebas: grupos,
    participantes: deLaDisciplina.length,
    en_juego: grupos.filter(g => g.estado === 'EN_JUEGO').length,
  };
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

module.exports = {
  FORMATOS, FORMATOS_POR_CATEGORIAS, ESTADOS_PRUEBA, MEDALLAS,
  MAX_TIEMPO_MS, MAX_PIEZAS, MAX_PESO_GRAMOS, MAX_JUGADORES_MESA, MAX_PRUEBAS_DISCIPLINA, MAX_PARTICIPANTES_CARGA, MAX_PARTICIPANTES_DISCIPLINA,
  formatoSugerido, esPorCategorias, nombreGrupo, sinAcentos,
  leerTiempo, formatearTiempo, leerPiezas, leerPeso, formatearPeso,
  puestosSegun, medallaDe, clasificarTiempo, clasificarPesca, clasificarMesa, clasificar,
  participantePublico, armarDisciplina,
};
