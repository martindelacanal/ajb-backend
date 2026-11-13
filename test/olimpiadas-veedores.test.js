"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.JWT_SECRET ||= "test-only-secret";

const {
  normalizarSets, contarSets, estaEnVivo, partidoPublico, calcularPosiciones, resolverClasificacion, hayCiclo,
  repartirPuntos, calcularTablaMedallero, agruparMedallasPorDisciplina, puestosSegunResultados,
} = require("../api/services/olimpiadas-competicion");
const { leerPartido, leerOrigen, leerCoordenadas, leerPuestosPuntos, mensajeConEfectos } = require("../api/routes/olimpiadas-contenido").__test;
const { validarPasswordVeedor, esCorreoInterno } = require("../api/security/olimpiadas-voluntarios");
const { detectarVideo, partesTotales, TAMANO_PARTE } = require("../api/routes/olimpiadas-videos");
const { tipoMarcadorSugerido } = require("../scripts/migrar-olimpiadas-veedores");

// ---------------------------------------------------------------------------
// Resultados por deporte
// ---------------------------------------------------------------------------
test("sets: el resultado global sale de contar los sets ganados (vóley 2 a 0, pádel 2 a 1)", () => {
  assert.deepEqual(contarSets(normalizarSets([[25, 1], [25, 3]])), [2, 0]);
  assert.deepEqual(contarSets(normalizarSets("[[6,1],[3,6],[6,4]]")), [2, 1]);
  // Los renglones vacíos de la planilla se ignoran; sin ningún set no hay resultado por sets.
  assert.deepEqual(normalizarSets([[25, 20], ["", ""], [null, null]]), [[25, 20]]);
  assert.equal(normalizarSets([]), null);
  assert.equal(normalizarSets(undefined), undefined);
  for (const invalido of [[[25]], [["a", 2]], [[25, -1]], "no es json", Array(8).fill([1, 0])]) {
    assert.throws(() => normalizarSets(invalido), { statusCode: 400 });
  }
});

test("partidos: al guardar sets el marcador pasa a ser los sets ganados", () => {
  const datos = leerPartido({ sets: [[25, 18], [22, 25], [15, 10]] }, { disciplina_id: 4, participante1: "A", participante2: "B" }, { completo: true });
  assert.equal(datos.resultado1, "2");
  assert.equal(datos.resultado2, "1");
  assert.equal(datos.sets, "[[25,18],[22,25],[15,10]]");
});

test("migración: cada deporte arranca con la forma de carga que le corresponde", () => {
  for (const nombre of ["Voley Femenino", "Voley playa Mixto", "Padle Dobles Mixto", "Tenis Single Masculino", "Ping Pong", "Fútbol Tenis", "Pelota Paleta"]) {
    assert.equal(tipoMarcadorSugerido(nombre), "SETS", nombre);
  }
  for (const nombre of ["Ajedrez", "Baile (Tango)", "Pesca", "Maratón", "Natación"]) assert.equal(tipoMarcadorSugerido(nombre), "GANADOR", nombre);
  for (const nombre of ["Fútbol 11 Masculino", "Basquet Masculino", "Truco", "Hándbol Femenino", "Tejo"]) assert.equal(tipoMarcadorSugerido(nombre), "TANTOS", nombre);
});

// ---------------------------------------------------------------------------
// En vivo según el horario
// ---------------------------------------------------------------------------
test("en vivo: un partido programado figura en vivo mientras dura su horario", () => {
  const ahora = { fecha: "2026-11-26", minutos: 15 * 60 };
  const base = { estado: "PROGRAMADO", fecha: "2026-11-26", hora_inicio: "14:30:00", hora_fin: "16:00:00" };
  assert.equal(estaEnVivo(base, ahora), true);
  assert.equal(estaEnVivo({ ...base, hora_inicio: "15:01:00" }, ahora), false);
  assert.equal(estaEnVivo({ ...base, hora_fin: "15:00:00" }, ahora), false);
  assert.equal(estaEnVivo({ ...base, fecha: "2026-11-27" }, ahora), false);
  // Sin hora de fin se asume una duración estándar de hora y media.
  assert.equal(estaEnVivo({ ...base, hora_inicio: "13:45:00", hora_fin: null }, ahora), true);
  assert.equal(estaEnVivo({ ...base, hora_inicio: "13:00:00", hora_fin: null }, ahora), false);
  // Lo que marca la organización manda: en juego siempre, finalizado o suspendido nunca.
  assert.equal(estaEnVivo({ ...base, estado: "EN_JUEGO", fecha: null, hora_inicio: null }, ahora), true);
  assert.equal(estaEnVivo({ ...base, estado: "FINALIZADO" }, ahora), false);
  assert.equal(estaEnVivo({ ...base, estado: "SUSPENDIDO" }, ahora), false);
});

// ---------------------------------------------------------------------------
// Equipos interdepartamentales
// ---------------------------------------------------------------------------
test("público: un equipo interdepartamental se muestra con su nombre combinado", () => {
  const publico = partidoPublico({ id: 1, participante1: "Dolores + Mar del Plata", equipo1_id: 3, equipo1_nombre: "Dolores + Mar del Plata",
    participante2: "Nombre privado", departamental2_id: 7, departamental2_nombre: "Bahía Blanca", inscripcion2_id: 9 });
  assert.equal(publico.participante1, "Dolores + Mar del Plata");
  assert.equal(publico.participante2, "Bahía Blanca");
  assert.equal(publico.equipo1_id, 3);
  // El lugar que todavía depende de otro resultado muestra el texto que arma el sistema, nunca un nombre cargado a mano.
  const pendiente = partidoPublico({ participante1: "Ganador de Semifinal A", origen1_tipo: "GANADOR", partido_origen1_id: 4, participante2: "Persona", origen2_tipo: null });
  assert.equal(pendiente.participante1, "Ganador de Semifinal A");
  assert.equal(pendiente.participante2, "A confirmar");
});

test("posiciones: un equipo interdepartamental suma como un competidor propio", () => {
  const tabla = calcularPosiciones([
    { estado: "FINALIZADO", ganador: 1, resultado1: "2", resultado2: "0", equipo1_id: 3, equipo1_nombre: "Dolores + Mar del Plata", participante1: "Dolores + Mar del Plata", departamental2_id: 7, departamental2_nombre: "Bahía Blanca" },
    { estado: "FINALIZADO", ganador: 2, resultado1: "1", resultado2: "3", departamental1_id: 7, departamental1_nombre: "Bahía Blanca", equipo2_id: 3, equipo2_nombre: "Dolores + Mar del Plata" },
  ]);
  assert.equal(tabla.length, 2);
  assert.deepEqual([tabla[0].equipo_id, tabla[0].departamental_id, tabla[0].nombre, tabla[0].puntos], [3, null, "Dolores + Mar del Plata", 6]);
  assert.deepEqual([tabla[1].departamental_id, tabla[1].puntos], [7, 0]);
});

// ---------------------------------------------------------------------------
// Clasificación automática
// ---------------------------------------------------------------------------
function cuadro() {
  return [
    { id: 1, etiqueta: "A", instancia_nombre: "Semifinal", estado: "PROGRAMADO", ganador: null, participante1: "La Plata", departamental1_id: 1, departamental1_nombre: "La Plata", participante2: "Mercedes", departamental2_id: 4, departamental2_nombre: "Mercedes" },
    { id: 2, etiqueta: "B", instancia_nombre: "Semifinal", estado: "PROGRAMADO", ganador: null, participante1: "Dolores + Mar del Plata", equipo1_id: 3, equipo1_nombre: "Dolores + Mar del Plata", participante2: "Azul", departamental2_id: 8, departamental2_nombre: "Azul" },
    { id: 3, instancia_nombre: "Final", estado: "PROGRAMADO", ganador: null, participante1: "A confirmar", participante2: "A confirmar",
      origen1_tipo: "GANADOR", partido_origen1_id: 1, origen2_tipo: "GANADOR", partido_origen2_id: 2 },
    { id: 4, instancia_nombre: "Tercer puesto", estado: "PROGRAMADO", ganador: null, participante1: "A confirmar", participante2: "A confirmar",
      origen1_tipo: "PERDEDOR", partido_origen1_id: 1, origen2_tipo: "PERDEDOR", partido_origen2_id: 2 },
  ];
}
function aplicar(partidos, cambios) {
  for (const cambio of cambios) Object.assign(partidos.find(p => p.id === cambio.id), cambio.campos);
}

test("clasificación: antes de jugarse, los cruces siguientes dicen de dónde sale cada lado", () => {
  const partidos = cuadro();
  const { cambios } = resolverClasificacion(partidos);
  aplicar(partidos, cambios);
  assert.equal(partidos[2].participante1, "Ganador de Semifinal A");
  assert.equal(partidos[2].participante2, "Ganador de Semifinal B");
  assert.equal(partidos[3].participante1, "Perdedor de Semifinal A");
  // Una segunda pasada no encuentra nada que cambiar.
  assert.deepEqual(resolverClasificacion(partidos).cambios, []);
});

test("clasificación: al cargar un resultado el ganador pasa a la final y el perdedor al tercer puesto", () => {
  const partidos = cuadro();
  aplicar(partidos, resolverClasificacion(partidos).cambios);
  Object.assign(partidos[0], { estado: "FINALIZADO", ganador: 2, resultado1: "0", resultado2: "5" });
  Object.assign(partidos[1], { estado: "FINALIZADO", ganador: 1, resultado1: "2", resultado2: "1" });
  const { cambios } = resolverClasificacion(partidos);
  aplicar(partidos, cambios);
  const final = partidos[2], tercero = partidos[3];
  assert.deepEqual([final.participante1, final.departamental1_id, final.equipo1_id || null], ["Mercedes", 4, null]);
  // El equipo interdepartamental avanza como equipo: conserva su nombre combinado y no una sola departamental.
  assert.deepEqual([final.participante2, final.departamental2_id ?? null, final.equipo2_id], ["Dolores + Mar del Plata", null, 3]);
  assert.deepEqual([tercero.participante1, tercero.departamental1_id], ["La Plata", 1]);
  assert.deepEqual([tercero.participante2, tercero.departamental2_id], ["Azul", 8]);
});

test("clasificación: corregir quién ganó cambia el cruce siguiente y avisa si ya tenía marcador", () => {
  const partidos = cuadro();
  aplicar(partidos, resolverClasificacion(partidos).cambios);
  Object.assign(partidos[0], { estado: "FINALIZADO", ganador: 1 });
  aplicar(partidos, resolverClasificacion(partidos).cambios);
  assert.equal(partidos[2].participante1, "La Plata");
  // Error al cargar qué departamental ganó: se corrige y la final ya estaba en juego.
  partidos[2].estado = "EN_JUEGO";
  partidos[0].ganador = 2;
  const { cambios } = resolverClasificacion(partidos);
  aplicar(partidos, cambios);
  assert.equal(partidos[2].participante1, "Mercedes");
  assert.equal(partidos[3].participante1, "La Plata");
  assert.equal(cambios.find(c => c.id === 3).jugado, true);
  // Reabrir el partido deja el lado otra vez por definir.
  Object.assign(partidos[0], { estado: "PROGRAMADO", ganador: null });
  aplicar(partidos, resolverClasificacion(partidos).cambios);
  assert.deepEqual([partidos[2].participante1, partidos[2].departamental1_id], ["Ganador de Semifinal A", null]);
});

test("clasificación: los puestos de una zona pasan a la fase siguiente cuando la zona terminó", () => {
  const dep = (id, nombre, lado) => ({ [`participante${lado}`]: nombre, [`departamental${lado}_id`]: id, [`departamental${lado}_nombre`]: nombre });
  const zona = [
    { id: 1, zona: "A", estado: "FINALIZADO", ganador: 1, resultado1: "3", resultado2: "0", ...dep(1, "La Plata", 1), ...dep(4, "Mercedes", 2) },
    { id: 2, zona: "A", estado: "FINALIZADO", ganador: 2, resultado1: "1", resultado2: "2", ...dep(4, "Mercedes", 1), ...dep(8, "Azul", 2) },
    { id: 3, zona: "A", estado: "PROGRAMADO", ganador: null, ...dep(1, "La Plata", 1), ...dep(8, "Azul", 2) },
  ];
  const semi = { id: 9, instancia_nombre: "Semifinal", estado: "PROGRAMADO", participante1: "A confirmar", participante2: "A confirmar",
    origen1_tipo: "POSICION", origen1_zona: "a", origen1_posicion: 1, origen2_tipo: "POSICION", origen2_zona: "Zona B", origen2_posicion: 2 };
  const partidos = [...zona, semi];
  aplicar(partidos, resolverClasificacion(partidos).cambios);
  // Falta un partido de la zona: todavía no se sabe quién clasifica.
  assert.deepEqual([semi.participante1, semi.departamental1_id ?? null], ["1.º de Zona A", null]);
  assert.equal(semi.participante2, "2.º de Zona B");
  Object.assign(zona[2], { estado: "FINALIZADO", ganador: 0, resultado1: "1", resultado2: "1" });
  aplicar(partidos, resolverClasificacion(partidos).cambios);
  // La Plata: 4 puntos. Azul: 4 puntos y menor diferencia. Mercedes: 0.
  assert.deepEqual([semi.participante1, semi.departamental1_id], ["La Plata", 1]);
});

test("clasificación: un empate exacto en el corte de la zona se avisa para que lo resuelva la organización", () => {
  const dep = (id, nombre, lado) => ({ [`participante${lado}`]: nombre, [`departamental${lado}_id`]: id, [`departamental${lado}_nombre`]: nombre });
  const partidos = [
    { id: 1, zona: "A", estado: "FINALIZADO", ganador: 0, resultado1: "1", resultado2: "1", ...dep(1, "La Plata", 1), ...dep(4, "Mercedes", 2) },
    { id: 9, estado: "PROGRAMADO", participante1: "x", participante2: "Azul", departamental2_id: 8, origen1_tipo: "POSICION", origen1_zona: "A", origen1_posicion: 1 },
  ];
  const { avisos } = resolverClasificacion(partidos);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /empate en Zona A/);
});

test("clasificación: detecta un cuadro que se muerde la cola", () => {
  const partidos = [{ id: 1 }, { id: 2, partido_origen1_id: 1 }, { id: 3, partido_origen2_id: 2 }];
  assert.equal(hayCiclo(partidos, 1, [3]), true);
  assert.equal(hayCiclo(partidos, 3, [1, 2]), false);
});

test("partidos: cada lado sale de un partido, de un puesto de zona o se elige a mano", () => {
  assert.deepEqual(leerOrigen({ origen1_tipo: "PERDEDOR", partido_origen1_id: 5 }, {}, 1), { tipo: "PERDEDOR", partidoOrigen: 5, zona: null, posicion: null });
  assert.deepEqual(leerOrigen({ origen2_tipo: "POSICION", origen2_zona: "A", origen2_posicion: 2, partido_origen2_id: 5 }, {}, 2), { tipo: "POSICION", partidoOrigen: null, zona: "A", posicion: 2 });
  // Compatibilidad con lo ya cargado: un partido de origen sin tipo es «el ganador de».
  assert.equal(leerOrigen({ partido_origen1_id: 5 }, {}, 1).tipo, "GANADOR");
  // Elegir el participante a mano quita el origen.
  assert.deepEqual(leerOrigen({ origen1_tipo: null }, { origen1_tipo: "GANADOR", partido_origen1_id: 5 }, 1), { tipo: null, partidoOrigen: null, zona: null, posicion: null });
  for (const body of [{ origen1_tipo: "GANADOR" }, { origen1_tipo: "POSICION", origen1_zona: "A" }, { origen1_tipo: "POSICION", origen1_zona: "A", origen1_posicion: 0 }, { origen1_tipo: "OTRO" }]) {
    assert.throws(() => leerOrigen(body, {}, 1), { statusCode: 400 });
  }
});

test("partidos: elegir un equipo interdepartamental desplaza a la departamental y al afiliado de ese lado", () => {
  const datos = leerPartido({ equipo1_id: 3 }, { disciplina_id: 4, departamental1_id: 1, inscripcion1_id: 9, participante1: "x", participante2: "y" });
  assert.deepEqual([datos.equipo1_id, datos.departamental1_id, datos.inscripcion1_id], [3, null, null]);
  const vuelta = leerPartido({ departamental1_id: 1 }, { disciplina_id: 4, equipo1_id: 3, participante1: "x", participante2: "y" });
  assert.deepEqual([vuelta.equipo1_id, vuelta.departamental1_id], [null, 1]);
});

test("mensajes: el resultado cuenta qué cruces se actualizaron solos", () => {
  assert.equal(mensajeConEfectos("Resultado cargado.", { clasificados: 0, avisos: [] }), "Resultado cargado.");
  assert.equal(mensajeConEfectos("Resultado cargado.", { clasificados: 1, avisos: [] }), "Resultado cargado. Se actualizó 1 cruce de la fase siguiente.");
  assert.match(mensajeConEfectos("Resultado cargado.", { clasificados: 2, avisos: ["Revisá X."] }), /2 cruces.*Revisá X\./);
});

// ---------------------------------------------------------------------------
// Medallero
// ---------------------------------------------------------------------------
test("medallero: el puntaje de un equipo interdepartamental se divide por la cantidad de departamentales", () => {
  assert.equal(repartirPuntos(10, 1), 10);
  assert.equal(repartirPuntos(10, 2), 5);
  // Entre tres hay cinco reglas posibles; la organización elige una por edición.
  assert.equal(repartirPuntos(10, 3, "EXACTA"), 3.33);
  assert.equal(repartirPuntos(10, 3, "REDONDEO"), 3);
  assert.equal(repartirPuntos(10, 3, "ABAJO"), 3);
  assert.equal(repartirPuntos(10, 3, "ARRIBA"), 4);
  assert.equal(repartirPuntos(10, 3, "COMPLETO"), 10);
});

test("medallero: dos bronces de equipos distintos no se reparten entre sí y hay puntos más allá del tercer puesto", () => {
  const puestos = [{ puesto: 1, puntos: 10 }, { puesto: 2, puntos: 5 }, { puesto: 3, puntos: 4 }, { puesto: 4, puntos: 2 }, { puesto: 5, puntos: 1 }];
  const medallas = [
    { id: 1, disciplina_id: 2, puesto: 3, departamental_id: 1, nombre: "La Plata" },
    { id: 2, disciplina_id: 2, puesto: 3, departamental_id: 4, nombre: "Mercedes" },
    { id: 3, disciplina_id: 2, puesto: 4, departamental_id: 7, nombre: "Bahía Blanca" },
    { id: 4, disciplina_id: 2, puesto: 5, departamental_id: 6, nombre: "Dolores", equipo_id: 9 },
    { id: 5, disciplina_id: 2, puesto: 5, departamental_id: 9, nombre: "Mar del Plata", equipo_id: 9 },
  ];
  const tabla = calcularTablaMedallero(medallas, puestos);
  const fila = id => tabla.find(f => f.departamental_id === id);
  assert.deepEqual([fila(1).puntos, fila(4).puntos], [4, 4]);
  assert.deepEqual([fila(7).puntos, fila(7).otros, fila(7).bronce], [2, 1, 0]);
  assert.deepEqual([fila(6).puntos, fila(9).puntos], [0.5, 0.5]);
  const detalle = agruparMedallasPorDisciplina([{ id: 2, nombre: "Vóley" }], medallas, { puntos: puestos });
  assert.equal(detalle[0].puestos.length, 5);
  assert.deepEqual(detalle[0].puestos[2].ganadores.map(g => g.tipo), ["DEPARTAMENTAL", "DEPARTAMENTAL"]);
  assert.deepEqual(detalle[0].puestos[4].ganadores.map(g => [g.tipo, g.nombre, g.departamentales.length]), [["EQUIPO", "Dolores + Mar del Plata", 2]]);
  assert.equal(detalle[0].puestos[4].ganadores[0].departamentales[0].puntos, 0.5);
});

test("medallero: un ajuste manual de puntos pisa el cálculo de esa medalla y nada más", () => {
  const medallas = [
    { disciplina_id: 2, puesto: 1, departamental_id: 13, nombre: "Avellaneda-Lanús", equipo_id: 5, puntos_manual: 4 },
    { disciplina_id: 2, puesto: 1, departamental_id: 14, nombre: "Lomas de Zamora", equipo_id: 5, puntos_manual: null },
    { disciplina_id: 2, puesto: 1, departamental_id: 15, nombre: "La Matanza", equipo_id: 5 },
  ];
  const tabla = calcularTablaMedallero(medallas, { oro: 10, plata: 5, bronce: 4 }, { division: "ABAJO" });
  assert.deepEqual(tabla.map(f => [f.nombre, f.puntos]), [["Avellaneda-Lanús", 4], ["La Matanza", 3], ["Lomas de Zamora", 3]]);
});

test("medallero: la final define oro y plata, y el tercer puesto bronce y cuarto", () => {
  const partidos = [
    { id: 1, instancia_nombre: "Semifinal", estado: "FINALIZADO", ganador: 1, departamental1_id: 1, departamental2_id: 4 },
    { id: 3, instancia_nombre: "Final", estado: "FINALIZADO", ganador: 2, departamental1_id: 1, departamental1_nombre: "La Plata", equipo2_id: 3, equipo2_nombre: "Dolores + Mar del Plata" },
    { id: 4, fase: "Tercer puesto", estado: "FINALIZADO", ganador: 1, departamental1_id: 4, departamental2_id: 8 },
  ];
  const puestos = puestosSegunResultados(partidos);
  assert.deepEqual(puestos.map(p => [p.puesto, p.competidor.clave]), [[1, "E3"], [2, "D1"], [3, "D4"], [4, "D8"]]);
  // Con la final sin terminar todavía no hay medallas; sin final (o con dos) no se puede saber.
  assert.deepEqual(puestosSegunResultados([{ ...partidos[1], estado: "EN_JUEGO", ganador: null }]), []);
  assert.equal(puestosSegunResultados([partidos[0]]), null);
  assert.equal(puestosSegunResultados([partidos[1], { ...partidos[1], id: 8 }]), null);
});

test("medallero: el sistema de puntos admite entre 3 y 10 puestos, en orden", () => {
  const olimpiada = { puntos_oro: 10, puntos_plata: 5, puntos_bronce: 4 };
  assert.deepEqual(leerPuestosPuntos({ puestos: [1, 2, 3, 4, 5].map(puesto => ({ puesto, puntos: 12 - puesto * 2 })) }, olimpiada).map(p => p.puntos), [10, 8, 6, 4, 2]);
  assert.deepEqual(leerPuestosPuntos({ puntos_oro: 9 }, olimpiada), [{ puesto: 1, puntos: 9 }, { puesto: 2, puntos: 5 }, { puesto: 3, puntos: 4 }]);
  for (const puestos of [[{ puesto: 1, puntos: 10 }], [{ puesto: 1, puntos: 10 }, { puesto: 3, puntos: 5 }, { puesto: 2, puntos: 4 }], [{ puesto: 1, puntos: -1 }, { puesto: 2, puntos: 5 }, { puesto: 3, puntos: 4 }]]) {
    assert.throws(() => leerPuestosPuntos({ puestos }, olimpiada), { statusCode: 400 });
  }
});

// ---------------------------------------------------------------------------
// Sedes, veedores y videos
// ---------------------------------------------------------------------------
test("sedes: el punto del mapa va completo o no va", () => {
  assert.deepEqual(leerCoordenadas({ lat: "-38.2716", lng: "-57.8389" }), { lat: -38.2716, lng: -57.8389 });
  assert.deepEqual(leerCoordenadas({}, { lat: "-38.2716000", lng: "-57.8389000" }), { lat: -38.2716, lng: -57.8389 });
  assert.deepEqual(leerCoordenadas({ lat: null, lng: "" }, { lat: 1, lng: 2 }), { lat: null, lng: null });
  for (const body of [{ lat: -38.27 }, { lat: 91, lng: 0 }, { lat: "x", lng: 0 }]) assert.throws(() => leerCoordenadas(body), { statusCode: 400 });
});

test("veedores: la clave de un invitado puede ser de un solo carácter, pero no vacía", () => {
  for (const clave of ["1", "a", "123", "clave larga con espacios"]) assert.doesNotThrow(() => validarPasswordVeedor(clave));
  for (const clave of ["", "   ", null, undefined, 123, "x".repeat(73)]) assert.throws(() => validarPasswordVeedor(clave), { statusCode: 400 });
  assert.equal(esCorreoInterno("veedor-juan@cuentas.internas.invalid"), true);
  assert.equal(esCorreoInterno("juan@example.org"), false);
});

test("videos: sólo entran contenedores de video reales y la subida se parte en tramos", () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(8)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
  assert.equal(detectarVideo(mp4), "video/mp4");
  assert.equal(detectarVideo(mov), "video/quicktime");
  assert.equal(detectarVideo(webm), "video/webm");
  assert.equal(detectarVideo(Buffer.from("%PDF-1.7 esto no es un video")), null);
  assert.equal(partesTotales(1), 1);
  assert.equal(partesTotales(TAMANO_PARTE), 1);
  assert.equal(partesTotales(TAMANO_PARTE + 1), 2);
});
