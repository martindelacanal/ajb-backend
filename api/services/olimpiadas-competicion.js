const { crearErrorHttp, normalizarIdPositivo } = require('./olimpiadas-comun');

const CAMPOS_PARTIDO_EXTRA = ['torneo_id', 'instancia_id', 'lugar_id', 'inscripcion1_id', 'inscripcion2_id', 'mostrar_nombres_publico', 'partido_origen1_id', 'partido_origen2_id'];

// Public responses deliberately use an allowlist: registration IDs and free-text notes
// must never become public merely because another column is added to the private query.
function partidoPublico(p) {
  const campos = ['id', 'olimpiada_id', 'disciplina_id', 'disciplina_nombre', 'fecha', 'hora_inicio', 'hora_fin', 'etiqueta', 'fase',
    'departamental1_id', 'departamental2_id', 'departamental1_nombre', 'departamental2_nombre', 'resultado1', 'resultado2',
    'ganador', 'estado', 'sede_id', 'sede_nombre', 'orden', 'fecha_modificacion', 'torneo_id', 'torneo_nombre', 'instancia_id',
    'instancia_nombre', 'instancia_orden', 'lugar_id', 'lugar_nombre', 'lugar_predio', 'lugar_direccion', 'lugar_url_mapa',
    'partido_origen1_id', 'partido_origen2_id'];
  const salida = Object.fromEntries(campos.filter(c => p[c] !== undefined).map(c => [c, p[c]]));
  for (const lado of [1, 2]) {
    salida[`participante${lado}`] = Number(p.mostrar_nombres_publico) === 1
      ? p[`participante${lado}`]
      : p[`departamental${lado}_nombre`] || (p[`partido_origen${lado}_id`] ? `Ganador del partido ${p[`partido_origen${lado}_id`]}` : 'A confirmar');
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

// Standings count only finalized matches with an adjudicated winner/draw and both
// departments known; scheduled matches and undecided walkovers never award points.
function calcularPosiciones(partidos) {
  const tabla = new Map();
  for (const p of partidos) {
    if (p.estado !== 'FINALIZADO' || ![0, 1, 2].includes(Number(p.ganador)) || p.ganador == null) continue;
    const ids = [normalizarIdPositivo(p.departamental1_id), normalizarIdPositivo(p.departamental2_id)];
    if (ids.some(id => !id) || ids[0] === ids[1]) continue;
    const tantos = [marcadorNumerico(p.resultado1), marcadorNumerico(p.resultado2)];
    for (let i = 0; i < 2; i++) {
      if (!tabla.has(ids[i])) tabla.set(ids[i], { departamental_id: ids[i], nombre: p[`departamental${i + 1}_nombre`] || `Departamental ${ids[i]}`, jugados: 0, ganados: 0, empatados: 0, perdidos: 0, a_favor: 0, en_contra: 0, diferencia: 0, puntos: 0 });
      const fila = tabla.get(ids[i]);
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
  return [...tabla.values()].sort((a, b) => b.puntos - a.puntos || b.ganados - a.ganados || b.diferencia - a.diferencia || a.nombre.localeCompare(b.nombre, 'es'))
    .map((fila, index) => ({ ...fila, posicion: index + 1 }));
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

function filtroId(query, campo) {
  if (query[campo] === undefined || query[campo] === '') return null;
  const id = normalizarIdPositivo(query[campo]);
  if (!id) throw crearErrorHttp(`El filtro ${campo} es inválido`);
  return id;
}

module.exports = { CAMPOS_PARTIDO_EXTRA, partidoPublico, marcadorNumerico, calcularPosiciones, listarTorneos, filtroId };
