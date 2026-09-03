const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/olimpiadas-contenido");
const { procesarImagenWeb } = require("../api/services/olimpiadas-comun");
const {
  parsearEventosTexto,
  parsearPartidosTexto,
  parsearFechaFlexible,
  parsearHoraFlexible,
  dividirColumnas,
  calcularTablaMedallero,
  agruparMedallasPorDisciplina,
  calcularGanadorPartido,
  leerGanador,
  estadoEdicion,
  leerEnum,
  normalizarFechaHora,
  procesarLoteFotos,
} = router.__test;

// ---------------------------------------------------------------------------
// Importación de cronograma
// ---------------------------------------------------------------------------
test("contenido: el cronograma pegado con TAB se parsea (fecha, inicio, fin, actividad, lugar)", () => {
  const texto = [
    "Fecha\tInicio\tFin\tActividad\tLugar",
    "28/11/2024\t10:00\t—\tCheck In Hoteles\tHoteles",
    "28/11/2024\t13:00\t15:00\tAlmuerzo\tCamping",
    "\t21:00\t\tCena de bienvenida\tSalón principal",
    "29/11/2024 | 9 hs | 12.30 | Competencias | Polideportivo",
    "Texto suelto sin columnas",
  ].join("\n");
  const { eventos, ignoradas } = parsearEventosTexto(texto);
  assert.equal(ignoradas, 2);
  assert.equal(eventos.length, 4);
  assert.deepEqual(eventos[0], {
    fecha: "2024-11-28",
    hora_inicio: "10:00:00",
    hora_fin: null,
    titulo: "Check In Hoteles",
    lugar: "Hoteles",
  });
  assert.equal(eventos[1].hora_fin, "15:00:00");
  // Sin fecha: hereda la del renglón anterior
  assert.equal(eventos[2].fecha, "2024-11-28");
  assert.equal(eventos[2].hora_inicio, "21:00:00");
  assert.equal(eventos[2].titulo, "Cena de bienvenida");
  // Separador "|" y horas laxas ("9 hs", "12.30")
  assert.equal(eventos[3].fecha, "2024-11-29");
  assert.equal(eventos[3].hora_inicio, "09:00:00");
  assert.equal(eventos[3].hora_fin, "12:30:00");
  assert.equal(eventos[3].lugar, "Polideportivo");
});

test("contenido: el cronograma vacío o sin líneas válidas no crea eventos", () => {
  assert.deepEqual(parsearEventosTexto(""), { eventos: [], ignoradas: 0 });
  assert.deepEqual(parsearEventosTexto("Sólo un encabezado\nOtro encabezado"), { eventos: [], ignoradas: 2 });
});

// ---------------------------------------------------------------------------
// Importación de partidos
// ---------------------------------------------------------------------------
test("contenido: los partidos pegados se parsean con fecha dd/mm/yy y etiqueta", () => {
  const texto = [
    "28/11/24\t14:30\t16:00\tA\tBahia Blanca\tLomas",
    "28/11/24\t16:00\t—\tB\tLa Plata\tMercedes",
    "—\t—\t—\tFinal\tGanador A\tGanador B",
    "hoy\t10:00\t11:00\tC\tX\tY",
    "faltan columnas\t10:00",
  ].join("\n");
  const { partidos, ignoradas } = parsearPartidosTexto(texto);
  assert.equal(ignoradas, 2);
  assert.equal(partidos.length, 3);
  assert.deepEqual(partidos[0], {
    fecha: "2024-11-28",
    hora_inicio: "14:30:00",
    hora_fin: "16:00:00",
    etiqueta: "A",
    participante1: "Bahia Blanca",
    participante2: "Lomas",
  });
  assert.equal(partidos[1].hora_fin, null);
  // Partido sin programar: fecha y horas vacías, etiqueta "Final"
  assert.equal(partidos[2].fecha, null);
  assert.equal(partidos[2].hora_inicio, null);
  assert.equal(partidos[2].etiqueta, "Final");
});

test("contenido: fechas flexibles (dd/mm/yy, dd/mm/yyyy, ISO) y columnas", () => {
  assert.equal(parsearFechaFlexible("28/11/24"), "2024-11-28");
  assert.equal(parsearFechaFlexible("5/3/2025"), "2025-03-05");
  assert.equal(parsearFechaFlexible("2025-03-05"), "2025-03-05");
  assert.equal(parsearFechaFlexible("31/02/2025"), null);
  assert.equal(parsearFechaFlexible("mañana"), null);
  assert.equal(parsearHoraFlexible("14 hs"), "14:00:00");
  assert.equal(parsearHoraFlexible("—"), null);
  assert.equal(parsearHoraFlexible("25:00"), null);
  assert.deepEqual(dividirColumnas("a  b   c"), ["a", "b", "c"]);
  assert.deepEqual(dividirColumnas("a | b | c\r"), ["a", "b", "c"]);
  assert.equal(normalizarFechaHora("2026-09-03 10:30"), "2026-09-03 10:30:00");
  assert.equal(normalizarFechaHora("2026-09-03"), "2026-09-03 00:00:00");
  assert.equal(normalizarFechaHora("03/09/2026"), false);
  assert.equal(normalizarFechaHora(""), null);
});

// ---------------------------------------------------------------------------
// Medallero
// ---------------------------------------------------------------------------
test("contenido: el oro compartido entre dos departamentales vale 5 puntos y una medalla para cada una", () => {
  const medallas = [
    { disciplina_id: 2, puesto: 1, departamental_id: 1, nombre: "La Plata" },
    { disciplina_id: 2, puesto: 1, departamental_id: 4, nombre: "Mercedes" },
    { disciplina_id: 2, puesto: 2, departamental_id: 7, nombre: "Bahía Blanca" },
    { disciplina_id: 2, puesto: 3, departamental_id: 9, nombre: "Mar del Plata" },
    { disciplina_id: 3, puesto: 1, departamental_id: 7, nombre: "Bahía Blanca" },
  ];
  const tabla = calcularTablaMedallero(medallas, { oro: 10, plata: 5, bronce: 4 });
  const fila = (id) => tabla.find((f) => f.departamental_id === id);
  assert.deepEqual(fila(1), { departamental_id: 1, nombre: "La Plata", oro: 1, plata: 0, bronce: 0, puntos: 5 });
  assert.deepEqual(fila(4), { departamental_id: 4, nombre: "Mercedes", oro: 1, plata: 0, bronce: 0, puntos: 5 });
  // Bahía Blanca: oro entero (10) + plata (5) = 15 → primera
  assert.equal(tabla[0].departamental_id, 7);
  assert.equal(tabla[0].puntos, 15);
  assert.equal(fila(9).puntos, 4);
  // Empate en puntos entre La Plata y Mercedes → desempata por oro/plata/bronce y luego nombre
  assert.deepEqual(tabla.slice(1, 3).map((f) => f.nombre), ["La Plata", "Mercedes"]);
});

test("contenido: puntos compartidos entre tres se redondean a dos decimales y el detalle trae los tres puestos", () => {
  const medallas = [1, 4, 7].map((id) => ({ disciplina_id: 5, disciplina_nombre: "Truco", puesto: 3, departamental_id: id, nombre: `D${id}` }));
  const tabla = calcularTablaMedallero(medallas, { oro: 10, plata: 5, bronce: 4 });
  assert.equal(tabla.length, 3);
  for (const fila of tabla) assert.equal(fila.puntos, 1.33);
  const detalle = agruparMedallasPorDisciplina([{ id: 5, nombre: "Truco" }, { id: 6, nombre: "Ajedrez" }], medallas);
  assert.equal(detalle.length, 2);
  const truco = detalle.find((d) => d.disciplina_id === 5);
  assert.deepEqual(truco.puestos.map((p) => p.departamentales.length), [0, 0, 3]);
  assert.deepEqual(detalle.find((d) => d.disciplina_id === 6).puestos.map((p) => p.departamentales.length), [0, 0, 0]);
  assert.deepEqual(calcularTablaMedallero([], { oro: 10, plata: 5, bronce: 4 }), []);
});

// ---------------------------------------------------------------------------
// Ganador de partido
// ---------------------------------------------------------------------------
test("contenido: el ganador se calcula sólo con marcadores numéricos", () => {
  assert.equal(calcularGanadorPartido("2", "1"), 1);
  assert.equal(calcularGanadorPartido("1", "2"), 2);
  assert.equal(calcularGanadorPartido("3", "3"), 0);
  assert.equal(calcularGanadorPartido("2,5", "1"), 1);
  assert.equal(calcularGanadorPartido("W.O.", "0"), null);
  assert.equal(calcularGanadorPartido(null, "1"), null);
  assert.equal(leerGanador(undefined), undefined);
  assert.equal(leerGanador(null), null);
  assert.equal(leerGanador("2"), 2);
  assert.throws(() => leerGanador(3), (e) => e.statusCode === 400);
});

// ---------------------------------------------------------------------------
// Estado de la edición y lectura de enums
// ---------------------------------------------------------------------------
test("contenido: el estado de la edición sigue el calendario", () => {
  const olimpiada = {
    fecha_inicio: "2026-09-23",
    fecha_fin: "2026-09-26",
    fecha_inicio_inscripcion: "2026-08-08",
    fecha_fin_inscripcion: "2026-08-30",
  };
  assert.equal(estadoEdicion(olimpiada, "2026-08-01"), "PROXIMA");
  assert.equal(estadoEdicion(olimpiada, "2026-08-08"), "INSCRIPCION_ABIERTA");
  assert.equal(estadoEdicion(olimpiada, "2026-08-30"), "INSCRIPCION_ABIERTA");
  assert.equal(estadoEdicion(olimpiada, "2026-09-01"), "INSCRIPCION_CERRADA");
  assert.equal(estadoEdicion(olimpiada, "2026-09-23"), "EN_CURSO");
  assert.equal(estadoEdicion(olimpiada, "2026-09-26"), "EN_CURSO");
  assert.equal(estadoEdicion(olimpiada, "2026-09-27"), "FINALIZADA");
});

test("contenido: leerEnum toma null o vacío como 'no vino' (el front manda tipo: null)", () => {
  const valores = ["GENERAL", "ACTIVIDAD"];
  assert.equal(leerEnum({ tipo: null }, "tipo", {}, valores, { porDefecto: "GENERAL" }), "GENERAL");
  assert.equal(leerEnum({ tipo: "" }, "tipo", { tipo: "ACTIVIDAD" }, valores, { porDefecto: "GENERAL" }), "ACTIVIDAD");
  assert.equal(leerEnum({ tipo: "actividad" }, "tipo", {}, valores), "ACTIVIDAD");
  assert.throws(() => leerEnum({ tipo: "OTRO" }, "tipo", {}, valores), (e) => e.statusCode === 400 && /GENERAL, ACTIVIDAD/.test(e.message));
  assert.throws(() => leerEnum({}, "tipo", {}, valores, { etiqueta: "el tipo" }), (e) => /Indicá el tipo/.test(e.message));
});

// ---------------------------------------------------------------------------
// Fotos: lote secuencial con errores por archivo (sharp real, S3 y BD simulados)
// ---------------------------------------------------------------------------
async function jpegDePrueba(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
}

test("contenido: el lote de fotos procesa de a una, sigue ante un archivo roto y limpia lo subido de la que falló", async () => {
  const buena = await jpegDePrueba(1200, 800);
  const rota = Buffer.concat([buena.subarray(0, 400), Buffer.from("basura")]);
  const archivos = [
    { fieldname: "FOTOS", originalname: "uno.jpg", mimetype: "image/jpeg", buffer: buena },
    { fieldname: "FOTOS", originalname: "rota.jpg", mimetype: "image/jpeg", buffer: rota },
    { fieldname: "FOTOS", originalname: "falla-bd.jpg", mimetype: "image/jpeg", buffer: buena },
    { fieldname: "FOTOS", originalname: "dos.jpg", mimetype: "image/jpeg", buffer: buena },
  ];
  let activos = 0;
  let maximoActivos = 0;
  const eliminadas = [];
  const inserts = [];
  const subirImagen = async (archivo, prefijo, opciones) => {
    activos += 1;
    maximoActivos = Math.max(maximoActivos, activos);
    try {
      const web = await procesarImagenWeb(archivo.buffer, { anchoMaximo: opciones.anchoMaximo });
      const chica = await procesarImagenWeb(archivo.buffer, { anchoMaximo: opciones.anchoMiniatura });
      const key = `olimpiadas/${prefijo}_${archivo.originalname}.webp`;
      const miniatura = `olimpiadas/${prefijo}_min_${archivo.originalname}.webp`;
      return { key, miniatura_key: miniatura, ancho: web.ancho, alto: web.alto, mime: web.mime, keys: [key, miniatura], miniatura_ancho: chica.ancho };
    } finally {
      activos -= 1;
    }
  };
  const conexion = {
    async query(sql, params) {
      assert.match(sql, /INSERT INTO olimpiada_foto/);
      if (params[1].includes("falla-bd")) throw new Error("ER_FAKE");
      inserts.push(params);
      return [{ insertId: inserts.length }];
    },
  };
  const eliminarObjetos = async (keys) => eliminadas.push(...keys);

  const { fotos, errores } = await procesarLoteFotos(
    { archivos, olimpiadaId: 1, comunes: { etiqueta: "Prueba", disciplina_id: 2, disciplina_nombre: "Ajedrez" }, usuarioId: 1, ordenInicial: 3 },
    { subirImagen, conexion, eliminarObjetos }
  );
  assert.equal(maximoActivos, 1, "las fotos se suben de a una");
  assert.equal(fotos.length, 2);
  assert.deepEqual(fotos.map((f) => f.orden), [4, 5]);
  assert.equal(fotos[0].ancho, 1200);
  assert.equal(fotos[0].alto, 800);
  assert.equal(fotos[0].etiqueta, "Prueba");
  assert.equal(fotos[0].disciplina_nombre, "Ajedrez");
  assert.equal(errores.length, 2);
  assert.equal(errores[0].archivo, "rota.jpg");
  assert.match(errores[0].error, /dañada|no se pudo procesar/);
  assert.equal(errores[1].archivo, "falla-bd.jpg");
  assert.equal(errores[1].error, "No se pudo guardar la foto");
  // Sólo la que falló en la BD tenía objetos subidos para limpiar
  assert.deepEqual(eliminadas, ["olimpiadas/fotos/1/foto_falla-bd.jpg.webp", "olimpiadas/fotos/1/foto_min_falla-bd.jpg.webp"]);
});

test("contenido: la miniatura y la versión web respetan el ancho máximo (sharp)", async () => {
  const original = await jpegDePrueba(2400, 1600);
  const web = await procesarImagenWeb(original, { anchoMaximo: 1600 });
  const chica = await procesarImagenWeb(original, { anchoMaximo: 420 });
  assert.equal(web.mime, "image/webp");
  assert.deepEqual([web.ancho, web.alto], [1600, 1067]);
  assert.deepEqual([chica.ancho, chica.alto], [420, 280]);
  const meta = await sharp(chica.buffer).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 420);
  // Una imagen chica no se agranda
  const pequenia = await procesarImagenWeb(await jpegDePrueba(300, 200), { anchoMaximo: 1600 });
  assert.deepEqual([pequenia.ancho, pequenia.alto], [300, 200]);
});
