"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.JWT_SECRET ||= "test-only-secret";

const {
  normalizarSets, contarSets, estaEnVivo, partidoPublico, calcularPosiciones, resolverClasificacion, hayCiclo,
  repartirPuntos, calcularTablaMedallero, agruparMedallasPorDisciplina, detectarTriangular, puestosSegunResultados,
} = require("../api/services/olimpiadas-competicion");
const { leerPartido, leerOrigen, camposEdicionPartidoVeedor, leerCoordenadas, leerPuestosPuntos, mensajeConEfectos } = require("../api/routes/olimpiadas-contenido").__test;
const { validarPasswordVeedor, esCorreoInterno } = require("../api/security/olimpiadas-voluntarios");
const { detectarVideo, partesTotales, TAMANO_PARTE } = require("../api/routes/olimpiadas-videos");
const { tipoMarcadorSugerido } = require("../scripts/migrar-olimpiadas-veedores");
const { codigoGafete, leerCodigoGafete, generarGafetes } = require("../api/services/olimpiadas-gafetes");

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

test("básquet: guarda el desglose por cuarto y respeta los marcadores anteriores", () => {
  const base = { disciplina_id: 4, resultado1: "34", resultado2: "28", estado: "FINALIZADO" };
  const editar = body => leerPartido(body, base, { completo: true });
  const legado = editar({ observacion: "Cambio de sede" });
  assert.deepEqual([legado.resultado1, legado.resultado2, legado.sets], ["34", "28", null]);
  const cuartos = [[9, 3], [10, 12], [5, 7], [10, 6]];
  const partido = editar({ cuartos, resultado1: "999" });
  assert.deepEqual([partido.resultado1, partido.resultado2, JSON.parse(partido.sets)], ["34", "28", { cuartos }]);
  const empatado = editar({ cuartos: Array(4).fill([7, 7]), ganador: 2 });
  assert.equal(empatado.ganador, 2);
  assert.equal(leerPartido({ hora_inicio: "15:30" }, empatado, { completo: true }).ganador, 2);
  assert.equal(leerPartido({ cuartos, estado: "FINALIZADO" }, empatado, { completo: true }).ganador, 1);
  assert.equal(leerPartido({ estado: "EN_JUEGO" }, empatado, { completo: true }).ganador, null);
  for (const invalido of [[], [[7, null]], [[4, -1]], [[1.5, 2]], Array(5).fill([1, 0]), [[12, 3]]]) {
    assert.throws(() => editar({ cuartos: invalido }), { statusCode: 400 });
  }
  assert.throws(() => editar({ cuartos, sets: [[12, 3]] }), { statusCode: 400 });
});

test("migración: cada deporte arranca con la forma de carga que le corresponde", () => {
  for (const nombre of ["Voley Femenino", "Voley playa Mixto", "Padle Dobles Mixto", "Tenis Single Masculino", "Ping Pong", "Fútbol Tenis", "Pelota Paleta"]) {
    assert.equal(tipoMarcadorSugerido(nombre), "SETS", nombre);
  }
  for (const nombre of ["Ajedrez", "Baile (Tango)", "Pesca", "Maratón", "Natación"]) assert.equal(tipoMarcadorSugerido(nombre), "GANADOR", nombre);
  for (const nombre of ["Fútbol 11 Masculino", "Basquet Masculino", "Truco", "Hándbol Femenino", "Tejo"]) assert.equal(tipoMarcadorSugerido(nombre), "TANTOS", nombre);
});

// ---------------------------------------------------------------------------
// Inicio manual
// ---------------------------------------------------------------------------
test("en vivo: sólo los partidos iniciados expresamente figuran en juego", () => {
  for (const horario of [
    { fecha: "2026-11-26", hora_inicio: "14:30:00", hora_fin: "16:00:00" },
    { fecha: "2026-11-26", hora_inicio: "14:30:00", hora_fin: null },
    { fecha: null, hora_inicio: null, hora_fin: null },
  ]) {
    for (const estado of ["PROGRAMADO", "SUSPENDIDO", "FINALIZADO", "EN_JUEGO"]) {
      assert.equal(estaEnVivo({ ...horario, estado }), estado === "EN_JUEGO");
    }
  }
});

// ---------------------------------------------------------------------------
// Equipos interdepartamentales
// ---------------------------------------------------------------------------
test("veedor: corregir el horario o el equipo directo no reescribe la llave del otro lado", () => {
  const partido = { disciplina_id: 4, participante1: "La Plata", participante2: "A confirmar", partido_origen2_id: 12 };
  const datosAnteriores = { disciplina_id: 4, participante1: "La Plata", participante2: "A confirmar" };
  assert.deepEqual(camposEdicionPartidoVeedor({ ...datosAnteriores, fecha: "2026-11-27" }, partido), ["fecha"]);
  assert.deepEqual(camposEdicionPartidoVeedor({ equipo1_id: 3, origen1_tipo: null }, partido),
    ["participante1", "equipo1_id", "departamental1_id", "inscripcion1_id"]);
  assert.throws(() => camposEdicionPartidoVeedor({ equipo2_id: 3 }, partido), { statusCode: 403 });
});

test("público: un equipo interdepartamental se muestra con su nombre combinado", () => {
  const publico = partidoPublico({ id: 1, participante1: "Dolores + Mar del Plata", equipo1_id: 3, equipo1_nombre: "Dolores + Mar del Plata",
    participante2: "Nombre privado", departamental2_id: 7, departamental2_nombre: "Bahía Blanca", inscripcion2_id: 9 });
  assert.equal(publico.participante1, "Dolores + Mar del Plata");
  assert.equal(publico.participante2, "Bahía Blanca");
  assert.equal(publico.equipo1_id, 3);
  // El lugar que todavía depende de otro resultado muestra el texto que arma el sistema, nunca un nombre cargado a mano.
  const pendiente = partidoPublico({ participante1: "Ganador de Semifinal A", origen1_tipo: "GANADOR", partido_origen1_id: 4, participante2: "Persona", origen2_tipo: null },
    new Map([[4, { instancia_nombre: "Semifinal", etiqueta: "A" }]]));
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

test("medallero: resuelve el tercer puesto aunque falte la final y reconoce los rótulos del cuadro", () => {
  const tercero = { torneo_id: 8, etiqueta: "3º y 4º puesto", fase: "Finales", estado: "FINALIZADO", ganador: 2, departamental1_id: 4, departamental2_id: 8,
    origen1_tipo: "PERDEDOR", origen2_tipo: "PERDEDOR", partido_origen1_id: 90, partido_origen2_id: 94 };
  const final = { ...tercero, etiqueta: "D", fase: "Eliminación", instancia_nombre: "Gran final" };
  const puestos = partidos => puestosSegunResultados(partidos)?.map(p => [p.puesto, p.competidor.departamental_id]);
  assert.deepEqual(puestos([tercero]), [[3, 8], [4, 4]]);
  assert.deepEqual(puestos([tercero, final]), [[1, 8], [2, 4], [3, 8], [4, 4]]);
  const semi = { ...tercero, id: 90, etiqueta: "A", fase: "Semifinal", instancia_nombre: "Semifinal", inscripcion2_id: 201 };
  const otra = { ...semi, id: 94, etiqueta: "B", departamental1_id: 10, inscripcion2_id: 202 };
  const compartido = [[1, 8], [2, 8], [3, 8], [4, 4]];
  assert.deepEqual(puestos([tercero, semi, otra]), compartido);
  for (const cambio of [{ ganador: 1 }, { estado: "EN_JUEGO" }, { torneo_id: 5 }, { instancia_nombre: null },
    { inscripcion2_id: 201 }, { inscripcion2_id: null }]) {
    assert.deepEqual(puestos([tercero, semi, { ...otra, ...cambio }]), [[3, 8], [4, 4]]);
  }
  for (const cambio of [{ origen2_tipo: "GANADOR" }, { partido_origen1_id: 94 }, { partido_origen2_id: null }]) {
    assert.deepEqual(puestos([{ ...tercero, ...cambio }, semi, otra]), [[3, 8], [4, 4]]);
  }
  assert.deepEqual(puestos([tercero, semi, otra, { ...final, estado: "PROGRAMADO" }]), [[3, 8], [4, 4]]);
});

test("medallero: una fecha o fase genérica nunca se toma como la definición de una medalla", () => {
  const partido = { estado: "FINALIZADO", ganador: 1, departamental1_id: 4, departamental2_id: 8 };
  for (const rotulos of [
    { instancia_nombre: "Fase final", etiqueta: "A" }, { fase: "Clasificación final", etiqueta: "Tercera fecha" },
    { instancia_nombre: "Tercera fecha" }, { etiqueta: "Tercer partido" }, { fase: "Final", instancia_nombre: "Cuartos de final" },
    { fase: "Fase final", etiqueta: "Semifinal" }, { fase: "Tercero" },
  ]) assert.equal(puestosSegunResultados([{ ...partido, ...rotulos }]), null);
  for (const etiqueta of ["3.º y 4.º puesto", "3º y 4º", "3er puesto", "Tercer y cuarto puesto", "Por el bronce"]) {
    assert.deepEqual(puestosSegunResultados([{ ...partido, fase: "Fase final", etiqueta }]).map(p => p.puesto), [3, 4]);
  }
});

test("triangular de liga: los tres cruces adjudican las medallas al terminar y una corrección cambia los puestos", () => {
  const base = { torneo_id: 24, torneo_formato: "LIGA", estado: "FINALIZADO" };
  const partidos = [
    { ...base, departamental1_id: 19, departamental2_id: 17, ganador: 1, resultado1: "3", resultado2: "0" },
    { ...base, departamental1_id: 19, departamental2_id: 14, ganador: 1, resultado1: "3", resultado2: "1" },
    { ...base, departamental1_id: 17, departamental2_id: 14, ganador: 2, resultado1: "0", resultado2: "3" },
  ];
  const puestos = encuentros => puestosSegunResultados(encuentros)?.map(p => [p.puesto, p.competidor.departamental_id]);
  assert.deepEqual(puestos(partidos), [[1, 19], [2, 14], [3, 17]]);
  assert.deepEqual(puestos([partidos[0], partidos[1], { ...partidos[2], ganador: 1 }]), [[1, 19], [2, 17], [3, 14]]);
  for (const cambio of [{ ganador: null }, { estado: "EN_JUEGO" }, { torneo_id: 25 }, { origen1_tipo: "PERDEDOR" }, { departamental1_id: 19 }]) {
    assert.equal(puestosSegunResultados([partidos[0], partidos[1], { ...partidos[2], ...cambio }]), null);
  }
  assert.equal(puestosSegunResultados([partidos[0], { ...partidos[1], ganador: 2 }, { ...partidos[2], ganador: 1 }]), null, "empate circular aun con diferencia de tantos");
  assert.equal(puestosSegunResultados(partidos.slice(0, 2)), null);
  assert.equal(puestosSegunResultados([...partidos, partidos[0]]), null);
  assert.deepEqual(puestos(partidos.map(p => ({ ...p, torneo_formato: "GRUPOS" }))), [[1, 19], [2, 14], [3, 17]]);
});

test("triangular: reconoce las tres parejas antes de jugar independientemente del formato y conserva las llaves", () => {
  const cruces = [[19, 17], [19, 14], [17, 14]].map(([a, b], i) => ({
    id: i + 1, torneo_formato: "ELIMINACION", torneo_id: 24, estado: "PROGRAMADO", ganador: null,
    instancia_nombre: i === 2 ? "Tercer puesto" : "Semifinal", departamental1_id: a, departamental2_id: b,
  }));
  assert.deepEqual(detectarTriangular(cruces), { estado: "EN_CURSO", puestos: [] });
  const sinTorneo = cruces.map(p => ({ ...p, torneo_id: null, torneo_formato: null }));
  assert.equal(detectarTriangular(sinTorneo).estado, "EN_CURSO");
  for (const cambio of [{ zona: "B" }, { torneo_id: null }, { instancia_nombre: "Gran final" },
    { partido_origen1_id: 1 }, { origen1_tipo: "POSICION" }, { departamental2_id: 19 },
    { departamental1_id: null, participante1: "Nombre libre" }, { torneo_eliminatoria_pendiente: 1, torneo_formato: "MIXTO" }]) {
    assert.equal(detectarTriangular([cruces[0], cruces[1], { ...cruces[2], ...cambio }]), null);
  }
  assert.equal(detectarTriangular(cruces.slice(0, 2)), null);
  assert.equal(detectarTriangular([...cruces, cruces[0]]), null);
  const circular = cruces.map((p,i) => ({ ...p, estado: "FINALIZADO", ganador: i === 1 ? 2 : 1 }));
  assert.deepEqual(detectarTriangular(circular), { estado: "EMPATADO", puestos: [] });
  assert.equal(puestosSegunResultados(circular), null, "no toma el rótulo heredado de tercer puesto");
  const resueltos = circular.map(p => ({ ...p, ganador: p.id === 3 ? 2 : 1 }));
  assert.equal(detectarTriangular(resueltos).estado, "RESUELTO");
  assert.deepEqual(puestosSegunResultados(resueltos).map(p => p.competidor.departamental_id), [19,14,17]);
  assert.deepEqual(detectarTriangular([...resueltos, { ...cruces[0], eliminado: 1 }]), detectarTriangular(resueltos));
});

test("triangular: dos inscripciones distintas de la misma departamental pueden ganar oro y plata", () => {
  const base = { estado: "FINALIZADO", torneo_id: 1, torneo_formato: "LIGA", ganador: 1 };
  const partidos = [
    { ...base, inscripcion1_id: 1, inscripcion2_id: 2, departamental1_id: 19, departamental2_id: 19 },
    { ...base, inscripcion1_id: 1, inscripcion2_id: 3, departamental1_id: 19, departamental2_id: 14 },
    { ...base, inscripcion1_id: 2, inscripcion2_id: 3, departamental1_id: 19, departamental2_id: 14 },
  ];
  assert.deepEqual(puestosSegunResultados(partidos).map(p => p.competidor.inscripcion_id), [1, 2, 3]);
  const ambiguos = partidos.map(p => ({ ...p, inscripcion1_id: p.inscripcion1_id === 2 ? null : p.inscripcion1_id, inscripcion2_id: p.inscripcion2_id === 2 ? null : p.inscripcion2_id }));
  assert.equal(puestosSegunResultados(ambiguos), null);
});

test("triangular: ganador y perdedor del primer partido enfrentan al mismo tercer rival", () => {
  const comun = { torneo_formato: "ELIMINACION", torneo_id: 12, fase: "Partido", estado: "PROGRAMADO" };
  const primero = { ...comun, id: 58, equipo1_id: 4, departamental2_id: 22 };
  const segundo = { ...comun, id: 38, equipo1_id: 9, partido_origen2_id: 58, origen2_tipo: "PERDEDOR" };
  const tercero = { ...comun, id: 182, equipo2_id: 9, partido_origen1_id: 58, origen1_tipo: "GANADOR" };
  const detectar = (a = primero, b = segundo, c = tercero) => detectarTriangular([b, a, c]);
  assert.deepEqual(detectar(), { estado: "EN_CURSO", puestos: [] });
  for (const cambio of [{ equipo2_id: 7 }, { equipo2_id: 4 }, { equipo2_id: null }, { partido_origen1_id: 38 },
    { origen1_tipo: "PERDEDOR" }, { origen1_tipo: "POSICION" }, { partido_origen1_id: null }]) {
    assert.equal(detectar(primero, segundo, { ...tercero, ...cambio }), null);
  }
  const a = { ...primero, estado: "FINALIZADO", ganador: 2 };
  const b = { ...segundo, estado: "FINALIZADO", ganador: 1, equipo2_id: 4 };
  const c = { ...tercero, estado: "FINALIZADO", ganador: 2, departamental1_id: 22 };
  assert.deepEqual(detectar(a, b, c).puestos.map(p => p.competidor.clave), ["E9", "D22", "E4"]);
  assert.deepEqual(detectar(a, b, { ...c, ganador: 1 }).puestos.map(p => p.competidor.clave), ["D22", "E9", "E4"]);
  for (const cambio of [{ departamental1_id: null }, { departamental1_id: 23 }]) {
    assert.deepEqual(detectar(a, b, { ...c, ...cambio }).puestos, []);
  }
  assert.equal(detectar({ ...a, ganador: 0 }, b, c).estado, "EN_CURSO");
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

test("gafetes: el código del QR lleva una firma y no sirve para consultar otra inscripción", async () => {
  const codigo = codigoGafete(12, "secreto");
  assert.match(codigo, /^12-[a-f0-9]{20}$/);
  assert.equal(leerCodigoGafete(codigo, "secreto"), 12);
  // Cambiar el número, la firma o el secreto invalida el código.
  assert.equal(leerCodigoGafete(`13-${codigo.split("-")[1]}`, "secreto"), null);
  assert.equal(leerCodigoGafete(codigo, "otro-secreto"), null);
  for (const basura of ["", "12", "12-xyz", "0-" + "a".repeat(20), null]) assert.equal(leerCodigoGafete(basura, "secreto"), null);
  const direcciones = [];
  const pdf = await generarGafetes([{ id: 12, afiliado_nombre: "Rosa", afiliado_apellido: "Benítez", disciplinas: ["Truco"] }],
    { urlVerificacion: (c) => { direcciones.push(c); return `https://ejemplo.test/olimpiadas-publicas/gafete/${c}`; } });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.deepEqual(direcciones, [codigoGafete(12)]);
});
