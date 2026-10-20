"use strict";

// Ejemplos acotados a Olimpiadas 2026 / Demo (id 1). Sólo inserta filas nuevas:
// no cambia partidos existentes ni inscripciones y no genera notificaciones.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
const { validarEdicion } = require("./seed-olimpiadas-demo-contenido");

const SEED_ID = "20261020_olimpiadas_demo_competicion";
const DEPARTAMENTALES = { 1: "La Plata", 4: "Mercedes", 5: "San Nicolás", 8: "Azul", 12: "Quilmes", 14: "Lomas de Zamora" };
const TORNEOS = [
  { disciplina_id: 6, disciplina: "Basquet Masculino", nombre: "[Ejemplo] Copa de Básquet Masculino", unidad: "puntos", duracion_minutos: 90,
    equipos: [1, 4, 12, 5], marcadores: [[72, 61], [58, 64], [59, 65], [76, 72]],
    fecha_semi: "2026-09-24", horas: ["10:00:00", "12:00:00", "09:00:00", "10:30:00"] },
  { disciplina_id: 14, disciplina: "Fútbol 5 Femenino", nombre: "[Ejemplo] Copa de Fútbol 5 Femenino", unidad: "goles", duracion_minutos: 45,
    equipos: [14, 8, 12, 1], marcadores: [[4, 1], [2, 4], [1, 3], [2, 1]],
    fecha_semi: "2026-09-25", horas: ["09:00:00", "10:00:00", "11:00:00", "12:00:00"] },
  { disciplina_id: 44, disciplina: "Voley Femenino", nombre: "[Ejemplo] Copa de Vóley Femenino", unidad: "sets", duracion_minutos: 60,
    equipos: [12, 4, 8, 14], marcadores: [[2, 0], [0, 2], [0, 2], [2, 1]],
    fecha_semi: "2026-09-25", horas: ["14:00:00", "15:00:00", "14:00:00", "15:00:00"] },
];
const INSTANCIAS = ["Semifinal", "Tercer puesto", "Final"];
const CHECKSUM = crypto.createHash("sha256").update(JSON.stringify({ SEED_ID, DEPARTAMENTALES, TORNEOS, INSTANCIAS })).digest("hex");

function armarResultados(torneo) {
  const horaFin = inicio => {
    const [hora, minutos] = inicio.split(":").map(Number), fin = hora * 60 + minutos + torneo.duracion_minutos;
    if (fin >= 1440) throw new Error("El ejemplo no puede terminar al día siguiente");
    return `${String(Math.floor(fin / 60)).padStart(2, "0")}:${String(fin % 60).padStart(2, "0")}:00`;
  };
  const partido = (equipos, resultado, fase, indice, origenes = []) => ({
    departamental1_id: equipos[0], departamental2_id: equipos[1],
    resultado1: String(resultado[0]), resultado2: String(resultado[1]), ganador: resultado[0] > resultado[1] ? 1 : 2,
    fase, fecha: indice < 2 ? torneo.fecha_semi : "2026-09-26", hora_inicio: torneo.horas[indice], hora_fin: horaFin(torneo.horas[indice]), origenes,
  });
  if (torneo.marcadores.some(m => m.length !== 2 || m.some(v => !Number.isInteger(v) || v < 0) || m[0] === m[1])) throw new Error("Los ejemplos eliminatorios requieren marcadores enteros sin empate");
  const semis = [partido(torneo.equipos.slice(0, 2), torneo.marcadores[0], "Semifinal", 0), partido(torneo.equipos.slice(2, 4), torneo.marcadores[1], "Semifinal", 1)];
  const ganador = p => p[`departamental${p.ganador}_id`];
  const perdedor = p => p[`departamental${p.ganador === 1 ? 2 : 1}_id`];
  const bronce = partido(semis.map(perdedor), torneo.marcadores[2], "Tercer puesto", 2, [0, 1]);
  const final = partido(semis.map(ganador), torneo.marcadores[3], "Final", 3, [0, 1]);
  return { partidos: [...semis, bronce, final], medallas: [
    { puesto: 1, departamental_id: ganador(final) }, { puesto: 2, departamental_id: perdedor(final) },
    { puesto: 3, departamental_id: ganador(bronce) },
  ] };
}

async function leerEstado(db, bloquear = false) {
  const [[edicion]] = await db.query(`SELECT id, nombre, edicion, fecha_inicio, fecha_fin, habilitado, eliminado, publicada_publico,
    puntos_oro, puntos_plata, puntos_bronce FROM olimpiada WHERE id = 1${bloquear ? " FOR UPDATE" : ""}`);
  validarEdicion(edicion);
  if (Number(edicion.puntos_oro) !== 10 || Number(edicion.puntos_plata) !== 5 || Number(edicion.puntos_bronce) !== 4) throw new Error("Cambió la puntuación del medallero de prueba");
  const [[registro]] = await db.query("SELECT estado, checksum, detalle FROM ajb_schema_migration WHERE migration_id = ?", [SEED_ID]);
  if (registro && registro.checksum !== CHECKSUM) throw new Error("El seed registrado tiene un checksum diferente");
  const existentes = {};
  for (const tabla of ["olimpiada_disciplina_config", "olimpiada_torneo", "olimpiada_partido", "olimpiada_medalla"]) {
    const [rows] = await db.query(`SELECT * FROM ${tabla} WHERE olimpiada_id = 1`);
    existentes[tabla] = rows;
  }
  const [disciplinas] = await db.query("SELECT id, nombre FROM olimpiada_disciplina WHERE id IN (?)", [TORNEOS.map(t => t.disciplina_id)]);
  const [departamentales] = await db.query("SELECT id, nombre FROM departamental WHERE id IN (?)", [Object.keys(DEPARTAMENTALES).map(Number)]);
  const [instancias] = await db.query("SELECT id, nombre FROM olimpiada_instancia WHERE eliminado = 0 AND nombre IN (?)", [INSTANCIAS]);
  const [[sede]] = await db.query("SELECT id, olimpiada_id, nombre, tipo, eliminado FROM olimpiada_sede WHERE id = 1");
  if (!sede || sede.olimpiada_id !== 1 || sede.nombre !== "Camping AJB" || sede.tipo !== "DEPORTIVA" || Number(sede.eliminado) !== 0) throw new Error("No coincide la sede deportiva de la edición Demo");
  for (const torneo of TORNEOS) if (!disciplinas.some(d => d.id === torneo.disciplina_id && d.nombre === torneo.disciplina)) throw new Error(`No coincide la disciplina ${torneo.disciplina_id}`);
  for (const [id, nombre] of Object.entries(DEPARTAMENTALES)) if (!departamentales.some(d => d.id === Number(id) && d.nombre === nombre)) throw new Error(`No coincide la departamental ${id}`);
  for (const nombre of INSTANCIAS) if (instancias.filter(i => i.nombre === nombre).length !== 1) throw new Error(`Falta la instancia ${nombre}`);
  const aplicado = registro?.estado === "APLICADA";
  if (!aplicado && (existentes.olimpiada_torneo.some(t => TORNEOS.some(d => d.nombre === t.nombre))
    || existentes.olimpiada_medalla.some(m => TORNEOS.some(t => t.disciplina_id === m.disciplina_id)))) {
    throw new Error("Ya hay torneos de ejemplo o medallas en las disciplinas elegidas; no se sobrescriben");
  }
  return { edicion, aplicado, existentes, instancias, sede };
}

function resumir(estado) {
  return { edicion: estado.edicion, aplicado: estado.aplicado,
    existentes: Object.fromEntries(Object.entries(estado.existentes).map(([t, rows]) => [t, rows.length])),
    pendientes: estado.aplicado ? { disciplinas: 0, torneos: 0, partidos: 0, medallas: 0 } : {
      disciplinas: TORNEOS.filter(t => !estado.existentes.olimpiada_disciplina_config.some(c => c.disciplina_id === t.disciplina_id)).length,
      torneos: TORNEOS.length, partidos: TORNEOS.length * 4, medallas: TORNEOS.length * 3,
    } };
}

async function insertar(db, tabla, datos) {
  const columnas = Object.keys(datos);
  const [resultado] = await db.query(`INSERT INTO ${tabla} (${columnas.join(", ")}) VALUES (${columnas.map(() => "?").join(", ")})`, Object.values(datos));
  return resultado.insertId;
}
async function auditar(db, entidad, id, detalle) {
  await insertar(db, "olimpiada_historial", { entidad, entidad_id: id, olimpiada_id: 1, tipo_operacion: "CREATE",
    valor_nuevo: detalle, observacion: `Resultado ficticio de ejemplo, sin notificaciones (${SEED_ID})` });
}

async function aplicar(db, { respaldar } = {}) {
  const [[lock]] = await db.query("SELECT GET_LOCK(?, 15) AS tomado", [SEED_ID]);
  if (Number(lock.tomado) !== 1) throw new Error("Otro seed está en curso");
  let transaccion = false;
  try {
    await db.beginTransaction(); transaccion = true;
    const estado = await leerEstado(db, true);
    if (estado.aplicado) {
      await db.commit(); transaccion = false;
      return { ...resumir(estado), agregados: { disciplinas: 0, torneos: 0, partidos: 0, medallas: 0 } };
    }
    if (typeof respaldar !== "function") throw new Error("Se requiere un respaldo antes de insertar");
    const respaldo = await respaldar({ seed: SEED_ID, ...estado, dataset: TORNEOS });
    const agregados = { disciplinas: 0, torneos: 0, partidos: 0, medallas: 0 }, torneos = [];
    for (const ejemplo of TORNEOS) {
      if (!estado.existentes.olimpiada_disciplina_config.some(c => c.disciplina_id === ejemplo.disciplina_id)) {
        const id = await insertar(db, "olimpiada_disciplina_config", { olimpiada_id: 1, disciplina_id: ejemplo.disciplina_id, sede_id: estado.sede.id });
        await auditar(db, "CONFIG", id, `[Ejemplo] Habilitar ${ejemplo.disciplina} sólo en la edición Demo`);
        agregados.disciplinas++;
      }
      const torneoId = await insertar(db, "olimpiada_torneo", { olimpiada_id: 1, disciplina_id: ejemplo.disciplina_id, nombre: ejemplo.nombre,
        formato: "ELIMINACION", descripcion: `Torneo de demostración con resultados ficticios en ${ejemplo.unidad}. Semifinales, final y tercer puesto; no corresponde a resultados oficiales.` });
      await auditar(db, "TORNEO", torneoId, ejemplo.nombre); agregados.torneos++;
      for (const [orden, nombre] of INSTANCIAS.entries()) {
        await insertar(db, "olimpiada_torneo_instancia", { torneo_id: torneoId, instancia_id: estado.instancias.find(i => i.nombre === nombre).id, orden });
      }
      const resultados = armarResultados(ejemplo), partidos = [];
      for (const [orden, p] of resultados.partidos.entries()) {
        const { origenes, ...resultado } = p;
        const partidoId = await insertar(db, "olimpiada_partido", {
          olimpiada_id: 1, disciplina_id: ejemplo.disciplina_id, torneo_id: torneoId, sede_id: estado.sede.id,
          instancia_id: estado.instancias.find(i => i.nombre === p.fase).id, ...resultado,
          etiqueta: `[Ejemplo] ${p.fase}${orden < 2 ? ` ${orden + 1}` : ""}`,
          participante1: DEPARTAMENTALES[p.departamental1_id], participante2: DEPARTAMENTALES[p.departamental2_id],
          estado: "FINALIZADO", mostrar_nombres_publico: 0, inscripcion1_id: null, inscripcion2_id: null,
          partido_origen1_id: origenes.length ? partidos[origenes[0]] : null,
          partido_origen2_id: origenes.length ? partidos[origenes[1]] : null,
          observacion: `[Ejemplo] Marcador en ${ejemplo.unidad}. ${p.fase === "Tercer puesto" ? "Participan quienes perdieron las semifinales." : "Resultado ficticio para mostrar el módulo."}`,
          orden: orden + 1,
        });
        partidos.push(partidoId);
        await auditar(db, "PARTIDO", partidoId, `${ejemplo.nombre}: ${p.fase} ${DEPARTAMENTALES[p.departamental1_id]} ${p.resultado1}–${p.resultado2} ${DEPARTAMENTALES[p.departamental2_id]}`);
        agregados.partidos++;
      }
      const medallas = [];
      for (const m of resultados.medallas) {
        const id = await insertar(db, "olimpiada_medalla", { olimpiada_id: 1, disciplina_id: ejemplo.disciplina_id, ...m,
          observacion: `[Ejemplo] Puesto derivado del resultado de ${m.puesto === 3 ? "tercer puesto" : "la final"} de la copa de demostración.` });
        await auditar(db, "MEDALLA", id, `${ejemplo.disciplina}: puesto ${m.puesto}, ${DEPARTAMENTALES[m.departamental_id]}`);
        medallas.push({ id, ...m }); agregados.medallas++;
      }
      torneos.push({ id: torneoId, nombre: ejemplo.nombre, disciplina_id: ejemplo.disciplina_id, partidos, medallas });
    }
    await db.query(`INSERT INTO ajb_schema_migration
      (migration_id, checksum, revision, estado, etapa, detalle, trigger_sql_mode, finalizada_en)
      VALUES (?, ?, 1, 'APLICADA', 'completa', ?, '', NOW())`, [SEED_ID, CHECKSUM, JSON.stringify({ agregados, torneos, respaldo })]);
    await db.commit(); transaccion = false;
    return { aplicado: true, edicion: estado.edicion, agregados, torneos, respaldo };
  } catch (error) {
    if (transaccion) await db.rollback();
    throw error;
  } finally { await db.query("SELECT RELEASE_LOCK(?)", [SEED_ID]); }
}

async function main(argv = process.argv.slice(2)) {
  const opciones = parsearArgumentos(argv);
  if (opciones.target === "all") throw new Error("Elegí un único entorno para el seed");
  if (opciones.target === "production" && !opciones.allowProduction) throw new Error("Production requiere --allow-production");
  if (opciones.apply && opciones.confirmacion !== "CARGAR_COMPETICION_DEMO_2026") throw new Error("Aplicar requiere --confirm=CARGAR_COMPETICION_DEMO_2026");
  require("dotenv").config({ path: opciones.envFile });
  const [entorno] = obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"), opciones.target === "production" ? process.env : { DB_SSL_MODE: "disabled" });
  const db = await mysql.createConnection(crearOpcionesConexion(entorno.config));
  try {
    const resultado = opciones.apply ? await aplicar(db, { respaldar: async datos => {
      const directorio = path.resolve(__dirname, "../../output/olimpiadas-demo-competicion");
      fs.mkdirSync(directorio, { recursive: true });
      const archivo = path.join(directorio, `respaldo-${entorno.nombre}-${Date.now()}.json`);
      fs.writeFileSync(archivo, JSON.stringify(datos, null, 2), { flag: "wx" });
      return archivo;
    } }) : resumir(await leerEstado(db));
    console.log(JSON.stringify({ entorno: entorno.nombre, modo: opciones.apply ? "apply" : "check", ...resultado }, null, 2));
  } finally { await db.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { SEED_ID, CHECKSUM, DEPARTAMENTALES, TORNEOS, armarResultados, aplicar };
