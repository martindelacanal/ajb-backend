"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const fuente = require("../api/data/olimpiadas-cronograma-2026.json");
const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");

const MIGRACION = "20261117_cronograma_miramar_2026";
const NOMBRE = "Olimpiadas Judiciales 2026";
const BONO = {
  fuente: "https://ajb.org.ar/bono-contribucion-xxvii-olimpiadas-judiciales/",
  valor: 40000, fecha: "2026-11-27", sorteo: "Quiniela Provincial Nocturna",
  premios: [
    "Tarjeta precargada por $3.500.000.",
    "Tarjeta precargada por $2.000.000.",
    "Tarjeta precargada por $1.500.000.",
    "El Parador de la Montaña para 4 personas. Siete noches con pensión completa, bebidas hasta $100.000 y traslado hasta $250.000.",
    ...Array(2).fill("RCT Chapadmalal para hasta 6 personas. Siete noches sin pensión y traslado hasta $150.000."),
    "El Parador de la Montaña para 4 personas. Siete noches con media pensión, bebidas hasta $50.000 y traslado hasta $250.000.",
    "El Parador de la Montaña para 2 personas. Siete noches con pensión completa, bebidas hasta $50.000 y traslado hasta $200.000.",
    "El Parador de la Montaña para 2 personas. Siete noches con media pensión, bebidas hasta $25.000 y traslado hasta $200.000.",
    "Campamento Turístico de Miramar. Siete noches en cabaña para hasta 6 personas y traslado hasta $150.000.",
    "El Parador de la Montaña para 2 personas. Siete noches con pensión completa.",
    ...Array(4).fill("Campamento Turístico de Miramar. Siete noches en cabaña para 6 personas."),
  ],
};
const CHECKSUM = crypto.createHash("sha256").update(JSON.stringify({ fuente, BONO })).digest("hex");
const GENERALES = new Set(["Check In Hoteles", "Espacio de cuidado", "Cena", "Desayuno", "Almuerzo", "Fiesta"]);
const DISCIPLINA_CATALOGO = {
  "Futbol 5 Masculino +40": "Fútbol 5 Senior Masculino +40 años",
  "Futbol 5 Masculino +50": "Fútbol 5 Super Senior Masculino + 50 años",
  "Handball Femenino": "Hándbol Femenino",
  "Paddle Dobles Mixto": "Padle Dobles Mixto",
  "Paddle Dobles Masculino": "Padle Dobles Masculino",
  "Paddle Dobles Femenino": "Padle Dobles Femenino",
  "Tejo Playa": "Tejo",
};
const DEPARTAMENTAL_CATALOGO = { "San Martín": "Gral. San Martín", "Moreno-Rodríguez": "Moreno-Gral. Rodríguez" };
const FASES = ["Clasificación", "Fase de grupos", "Por la Gloria", "Cuartos de final", "Semifinal", "Tercer puesto", "Final"];
const RANKING_PENDIENTE = /^(?:[1-7]° (?:Ganador|Perdedor)|(?:Mejor|Peor) (?:Ganador|Perdedor)(?: \([12]\))?|Perdedor \([23]\))$/;
const ORIGEN = /^(Ganador|Perdedor) ([A-N])$/;

const clave = texto => String(texto).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const distintos = lista => [...new Set(lista)];
const cancha = nombre => /^\d+$/.test(nombre) ? "Cancha " + nombre : nombre;
const identificador = (disciplina, etiqueta) => disciplina + "|" + etiqueta;

function buscarId(catalogo, nombre) {
  const filas = catalogo.filter(x => clave(x.nombre) === clave(nombre));
  if (filas.length > 1) throw new Error("Nombre ambiguo en el catálogo: " + nombre);
  return filas[0]?.id;
}

function prepararPrograma() {
  const filas = fuente.filas.map(celdas => Object.fromEntries(fuente.columnas.map((c, i) => [c, celdas[i]])));
  const partidos = filas.filter(f => !/^-+$/.test(f.participante2));
  const eventos = filas.filter(f => /^-+$/.test(f.participante2));
  const deportes = distintos(filas.filter(f => !GENERALES.has(f.actividad)).map(f => f.actividad));
  const sedes = distintos(filas.map(f => f.sede));
  const torneos = new Map();
  for (const actividad of distintos(partidos.map(p => p.actividad))) {
    const cruces = partidos.filter(p => p.actividad === actividad);
    const porEtiqueta = new Map(cruces.map(p => [p.partido, p]));
    if (porEtiqueta.size !== cruces.length) throw new Error("Etiqueta de partido repetida en " + actividad);
    const fasePorEtiqueta = new Map();
    const final = porEtiqueta.get("Final");
    const faseBase = final ? "Clasificación" : "Fase de grupos";
    for (const p of cruces) {
      let fase = faseBase;
      if (/^Por la Gloria/.test(p.partido)) fase = "Por la Gloria";
      if (p.partido === "Tercer Puesto") fase = "Tercer puesto";
      if (p.partido === "Final") fase = "Final";
      fasePorEtiqueta.set(p.partido, fase);
      for (const lado of [p.participante1, p.participante2]) {
        const anterior = ORIGEN.exec(lado)?.[2];
        if (anterior && (!porEtiqueta.has(anterior) || porEtiqueta.get(anterior).fila >= p.fila)) {
          throw new Error("Origen de partido inválido en fila " + p.fila + ": " + lado);
        }
      }
    }
    // Sólo las referencias explícitas del cuadro definen estas instancias.
    const ganadoresDe = p => [p.participante1, p.participante2].map(lado => /^Ganador ([A-N])$/.exec(lado)?.[1]).filter(Boolean);
    if (final) {
      const semis = ganadoresDe(final);
      for (const etiqueta of semis) fasePorEtiqueta.set(etiqueta, "Semifinal");
      const cuartos = distintos(semis.flatMap(e => ganadoresDe(porEtiqueta.get(e))));
      if (cuartos.length === 4) for (const etiqueta of cuartos) fasePorEtiqueta.set(etiqueta, "Cuartos de final");
    }
    torneos.set(actividad, { formato: final ? "ELIMINACION" : "LIGA", fasePorEtiqueta });
  }
  return { filas, deportes, sedes, partidos, eventos, torneos };
}

async function esquemaBloques(db, aplicar = false) {
  const faltan = [];
  for (const tabla of ["olimpiada_partido", "olimpiada_evento"]) {
    const [columnas] = await db.query("SHOW COLUMNS FROM " + tabla + " LIKE 'bloque'");
    if (!columnas.length) {
      faltan.push(tabla);
      if (aplicar) await db.query("ALTER TABLE " + tabla + " ADD COLUMN bloque TINYINT UNSIGNED NULL");
    } else if (columnas[0].Type !== "tinyint unsigned" || columnas[0].Null !== "YES") {
      throw new Error("Tipo incompatible para " + tabla + ".bloque");
    }
  }
  return faltan;
}

async function leerCatalogos(db) {
  const [disciplinas] = await db.query("SELECT d.id, d.nombre, d.tipo_id, d.icono_archivo FROM olimpiada_disciplina d JOIN olimpiada_disciplina_tipo t ON d.tipo_id=t.id WHERE d.habilitado='Y' AND t.competitiva=1 AND t.habilitado='Y'");
  const [departamentales] = await db.query("SELECT id, nombre FROM departamental");
  const [lugares] = await db.query("SELECT id, nombre, predio FROM olimpiada_lugar WHERE eliminado=0");
  const [instancias] = await db.query("SELECT id, nombre FROM olimpiada_instancia WHERE eliminado=0");
  return { disciplinas, departamentales, lugares, instancias };
}

function leerRival(nombre, catalogos) {
  const origen = ORIGEN.exec(nombre);
  if (origen) return { tipo: origen[1].toUpperCase(), etiqueta: origen[2] };
  if (RANKING_PENDIENTE.test(nombre)) return { tipo: "PENDIENTE" };
  const inter = nombre.startsWith("Inter. ");
  const nombres = inter ? nombre.slice(7).split(" / ") : [nombre];
  const ids = nombres.map(n => {
    const id = buscarId(catalogos.departamentales, DEPARTAMENTAL_CATALOGO[n] || n);
    if (!id) throw new Error("Falta la departamental " + n);
    return id;
  });
  return { tipo: inter ? "EQUIPO" : "DEPARTAMENTAL", ids };
}

function resumir(programa, catalogos) {
  const nuevas = [];
  for (const actividad of programa.deportes) {
    if (buscarId(catalogos.disciplinas, DISCIPLINA_CATALOGO[actividad] || actividad)) continue;
    if (actividad !== "Fútbol 5 Mixto") throw new Error("Falta la disciplina " + actividad);
    nuevas.push(actividad);
  }
  const equipos = new Set();
  let origenesDirectos = 0, puestosPendientes = 0;
  for (const p of programa.partidos) for (const nombre of [p.participante1, p.participante2]) {
    const rival = leerRival(nombre, catalogos);
    if (rival.tipo === "EQUIPO") equipos.add(identificador(p.actividad, nombre));
    if (rival.etiqueta) origenesDirectos++;
    if (rival.tipo === "PENDIENTE") puestosPendientes++;
  }
  return { filas: programa.filas.length, disciplinas: programa.deportes.length, nuevas, sedes: programa.sedes.length,
    torneos: programa.torneos.size, partidos: programa.partidos.length, eventos: programa.eventos.length, equipos: equipos.size,
    origenesDirectos, puestosPendientes, premios: BONO.premios.length };
}

async function insertar(db, tabla, datos) {
  const [resultado] = await db.query("INSERT INTO " + tabla + " SET ?", [datos]);
  return resultado.insertId;
}

async function registrar(db, olimpiadaId, tipo, anterior, nuevo, observacion) {
  await insertar(db, "olimpiada_historial", { entidad: "OLIMPIADA", entidad_id: olimpiadaId, olimpiada_id: olimpiadaId,
    tipo_operacion: tipo, valor_anterior: anterior, valor_nuevo: nuevo, observacion });
}

async function leerEstado(db, bloquear = false) {
  const [[marca]] = await db.query("SELECT estado, checksum, detalle FROM ajb_schema_migration WHERE migration_id=?", [MIGRACION]);
  if (marca) {
    if (marca.checksum !== CHECKSUM || marca.estado !== "APLICADA") throw new Error("La marca de importación no coincide con la fuente");
    return { aplicado: true, ...JSON.parse(marca.detalle) };
  }
  const [ediciones] = await db.query("SELECT id,nombre,edicion,habilitado,eliminado,publicada_publico,fecha_inicio,fecha_fin FROM olimpiada WHERE id=1 OR nombre=? OR (fecha_inicio=? AND fecha_fin=?)" +
    (bloquear ? " FOR UPDATE" : ""), [NOMBRE, "2026-11-26", "2026-11-29"]);
  if (ediciones.some(e => e.id !== 1)) throw new Error("Ya existe una edición con este nombre o estas fechas. Verificar antes de importar.");
  const demo = ediciones.find(e => e.id === 1);
  if (!demo || demo.nombre !== "Olimpiadas 2026" || demo.edicion !== "Demo" || demo.eliminado) {
    throw new Error("La edición de prueba no coincide con la edición identificada");
  }
  return { aplicado: false, demo };
}

async function prepararCompetencia(db, edicion, programa, catalogos, sedes) {
  const disciplinas = new Map(), torneos = new Map(), instancias = new Map();
  for (const actividad of programa.deportes) {
    const nombre = DISCIPLINA_CATALOGO[actividad] || actividad;
    let id = buscarId(catalogos.disciplinas, nombre);
    if (!id) {
      // Mixto comparte el tipo y el ícono del fútbol 5 del mismo catálogo.
      if (actividad !== "Fútbol 5 Mixto") throw new Error("Falta disciplina " + actividad);
      const base = catalogos.disciplinas.find(d => clave(d.nombre) === clave("Fútbol 5 Masculino"));
      id = await insertar(db, "olimpiada_disciplina", { nombre, tipo_id: base.tipo_id, icono_archivo: base.icono_archivo, tipo_marcador: "TANTOS" });
    }
    disciplinas.set(actividad, id);
    const lugares = distintos(programa.filas.filter(p => p.actividad === actividad).map(p => p.sede));
    await insertar(db, "olimpiada_disciplina_config", { olimpiada_id: edicion, disciplina_id: id, sede_id: lugares.length === 1 ? sedes.get(lugares[0]) : null });
    const cuadro = programa.torneos.get(actividad);
    if (!cuadro) continue;
    const torneo = await insertar(db, "olimpiada_torneo", { olimpiada_id: edicion, disciplina_id: id, nombre: actividad, formato: cuadro.formato });
    torneos.set(actividad, torneo);
    const utilizadas = new Set(cuadro.fasePorEtiqueta.values());
    for (const [orden, fase] of FASES.entries()) if (utilizadas.has(fase)) {
      if (!instancias.has(fase)) instancias.set(fase, buscarId(catalogos.instancias, fase) || await insertar(db, "olimpiada_instancia", { nombre: fase, orden }));
      await insertar(db, "olimpiada_torneo_instancia", { torneo_id: torneo, instancia_id: instancias.get(fase), orden });
    }
  }
  return { disciplinas, torneos, instancias };
}

async function cargarPrograma(db, edicion, programa, catalogos) {
  const sedes = new Map(), canchas = new Map(), partidos = new Map(), equipos = new Map();
  for (const nombre of programa.sedes) {
    sedes.set(nombre, await insertar(db, "olimpiada_sede", { olimpiada_id: edicion, nombre, tipo: nombre === "Hoteles" ? "HOTEL" : "DEPORTIVA" }));
  }
  const competencia = await prepararCompetencia(db, edicion, programa, catalogos, sedes);
  for (const fila of programa.eventos) {
    const detalles = [fila.participante1];
    if (!/^-+$/.test(fila.partido)) detalles.push("Partido " + fila.partido);
    if (fila.fin && fila.fin < fila.inicio) detalles.push("Finaliza al día siguiente.");
    await insertar(db, "olimpiada_evento", { olimpiada_id: edicion, tipo: "GENERAL", fecha: fila.fecha, hora_inicio: fila.inicio,
      hora_fin: fila.fin, titulo: fila.actividad, descripcion: detalles.join(" · "), sede_id: sedes.get(fila.sede),
      lugar: /^-+$/.test(fila.cancha) ? null : cancha(fila.cancha), orden: fila.fila, bloque: fila.bloque });
  }
  for (const p of programa.partidos) {
    const disciplina = competencia.disciplinas.get(p.actividad), lugar = cancha(p.cancha);
    const canchaClave = identificador(p.sede, lugar);
    if (!canchas.has(canchaClave)) {
      const existentes = catalogos.lugares.filter(l => clave(l.predio) === clave(p.sede));
      let id = buscarId(existentes, lugar);
      // El catálogo 2025 ya identifica físicamente estas canchas del camping.
      if (!id && p.sede === "Camping") {
        const historicos = catalogos.lugares.filter(l => l.predio === "Miramar");
        const anterior = { "Comedor": "Camping (Comedor)", "Confitería": "Camping (Confitería)", "Adm. Invierno": "Camping Adm. Invierno" }[lugar];
        if (anterior || /^Cancha \d+$/.test(lugar)) id = buscarId(historicos, anterior || "Camping " + lugar);
      }
      canchas.set(canchaClave, id || await insertar(db, "olimpiada_lugar", { nombre: lugar, predio: p.sede }));
    }
    const fase = programa.torneos.get(p.actividad).fasePorEtiqueta.get(p.partido);
    const datos = { olimpiada_id: edicion, disciplina_id: disciplina, torneo_id: competencia.torneos.get(p.actividad), fase,
      instancia_id: competencia.instancias.get(fase), etiqueta: p.partido, fecha: p.fecha, hora_inicio: p.inicio,
      hora_fin: p.fin, sede_id: sedes.get(p.sede), lugar_id: canchas.get(canchaClave), orden: p.fila, bloque: p.bloque,
      estado: "PROGRAMADO", mostrar_nombres_publico: 0 };
    for (const lado of [1, 2]) {
      const nombre = p["participante" + lado], rival = leerRival(nombre, catalogos);
      datos["participante" + lado] = nombre;
      if (rival.tipo === "DEPARTAMENTAL") datos["departamental" + lado + "_id"] = rival.ids[0];
      if (rival.tipo === "EQUIPO") {
        const llave = identificador(disciplina, nombre);
        if (!equipos.has(llave)) {
          const equipo = await insertar(db, "olimpiada_equipo", { olimpiada_id: edicion, disciplina_id: disciplina, nombre });
          for (const departamental of rival.ids) await insertar(db, "olimpiada_equipo_departamental", { equipo_id: equipo, departamental_id: departamental });
          equipos.set(llave, equipo);
        }
        datos["equipo" + lado + "_id"] = equipos.get(llave);
      }
      if (rival.etiqueta) {
        datos["origen" + lado + "_tipo"] = rival.tipo;
        datos["partido_origen" + lado + "_id"] = partidos.get(identificador(p.actividad, rival.etiqueta));
      }
    }
    partidos.set(identificador(p.actividad, p.partido), await insertar(db, "olimpiada_partido", datos));
  }
}

async function importar(db, aplicar = false) {
  const [[lock]] = await db.query("SELECT GET_LOCK(?,15) AS tomado", [MIGRACION]);
  if (Number(lock.tomado) !== 1) throw new Error("Otra importación está en curso");
  try {
    const estado = await leerEstado(db);
    if (estado.aplicado) return estado;
    const programa = prepararPrograma(), catalogos = await leerCatalogos(db);
    const plan = resumir(programa, catalogos);
    const bloquesFaltantes = await esquemaBloques(db);
    if (!aplicar) return { ...estado, ...plan, bloquesFaltantes };
    if (bloquesFaltantes.length) throw new Error("Aplicar primero --solo-esquema");
    await db.beginTransaction();
    try {
      const { demo } = await leerEstado(db, true);
      // Numeración confirmada en la convocatoria de la Subsecretaría de Deportes de la AJB.
      const edicion = await insertar(db, "olimpiada", { nombre: NOMBRE, edicion: "XXVII", localidad: "Miramar",
        fecha_inicio: "2026-11-26", fecha_fin: "2026-11-29", fecha_inicio_inscripcion: null, fecha_fin_inscripcion: null,
        habilitado: "Y", publicada_publico: 1, requiere_aprobacion: 1,
        valor_bono: BONO.valor, fecha_sorteo: BONO.fecha, sorteo_detalle: BONO.sorteo });
      await cargarPrograma(db, edicion, programa, catalogos);
      await insertar(db, "olimpiada_seccion", { olimpiada_id: edicion, ubicacion: "BONOS", clave: "bases_condiciones_bono",
        titulo: "Bases y condiciones del bono", visible: 1,
        contenido: "Cada bono participa con un número de cuatro cifras. Las estadías corresponden a la temporada baja de 2027. Consultá los plazos de acreditación, las condiciones de cada premio y la asignación de vacantes en las bases oficiales de la AJB.\n\n" + BONO.fuente });
      await insertar(db, "olimpiada_enlace", { olimpiada_id: edicion, tipo: "OTRO",
        titulo: "Bases y premios del bono contribución", url: BONO.fuente });
      for (const [i, descripcion] of BONO.premios.entries()) {
        await insertar(db, "olimpiada_premio", { olimpiada_id: edicion, orden: i + 1, descripcion, sorteo: BONO.sorteo });
      }
      // Los cruces de fuentes y los planteles incompletos son notas de trabajo para la organización.
      await insertar(db, "olimpiada_seccion", { olimpiada_id: edicion, ubicacion: "INFO", titulo: "Observaciones de organización",
        visible: 0, contenido: fuente.observaciones.map(([,tema,nota]) => tema + "\n" + nota).join("\n\n") });
      await insertar(db, "olimpiada_seccion", { olimpiada_id: edicion, ubicacion: "INFO", titulo: "Bloques del cronograma", visible: 1,
        contenido: fuente.notas[0].split(". Filas en rosa")[0] + ".\n\n" + fuente.notas[1] });
      await db.query("UPDATE olimpiada SET habilitado='N', publicada_publico=0 WHERE id=?", [demo.id]);
      await registrar(db, demo.id, "UPDATE", JSON.stringify(demo), "Edición de prueba archivada", MIGRACION);
      await registrar(db, edicion, "CREATE", null, JSON.stringify(plan), fuente.archivo + " · SHA-256 " + fuente.sha256);
      const detalle = { edicionId: edicion, demoAnterior: demo, ...plan };
      await insertar(db, "ajb_schema_migration", { migration_id: MIGRACION, checksum: CHECKSUM, revision: 1, estado: "APLICADA",
        etapa: "completa", detalle: JSON.stringify(detalle), trigger_sql_mode: "", finalizada_en: new Date() });
      await db.commit();
      return { aplicado: true, ...detalle };
    } catch (error) { await db.rollback(); throw error; }
  } finally { await db.query("SELECT RELEASE_LOCK(?)", [MIGRACION]); }
}

async function main(argv = process.argv.slice(2)) {
  const args = parsearArgumentos(argv);
  if (args.target === "all") throw new Error("Elegí un entorno por vez");
  if (args.target === "production" && !args.allowProduction) throw new Error("Production requiere --allow-production");
  if (args.apply && args.confirmacion !== "CARGAR_MIRAMAR_2026") throw new Error("Aplicar requiere --confirm=CARGAR_MIRAMAR_2026");
  const [entorno] = obtenerEntornos(args, fs.readFileSync(args.envFile, "utf8"), args.target === "production" ? process.env : { DB_SSL_MODE: "disabled" });
  const opciones = crearOpcionesConexion(entorno.config);
  if (opciones.ssl) opciones.ssl.verifyIdentity = true;
  const db = await mysql.createConnection(opciones);
  try {
    const resultado = argv.includes("--solo-esquema") ? await esquemaBloques(db, args.apply) : await importar(db, args.apply);
    console.log(JSON.stringify(resultado, null, 2));
  } finally { await db.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { importar, esquemaBloques, prepararPrograma, resumir };
