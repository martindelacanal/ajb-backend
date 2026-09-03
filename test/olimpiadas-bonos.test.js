const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/olimpiadas-bonos");
const {
  MAX_CANTIDAD_AUTOMATICA,
  MAX_NUMERO_BONO,
  COLUMNAS_CSV,
  elegirNumerosLibres,
  validarBloque,
  validarRangoNumeracion,
  parsearPremios,
  describirNumeros,
  escaparCsv,
  armarCsvBonos,
  clasificarNumero,
  normalizarVenta,
  normalizarEdicionBono,
  normalizarReglasEntrada,
  condicionBusquedaBonos,
  leerEnteroQuery,
  armarReglas,
  mapearBonoVendido,
  padNumero,
} = router.__test;
const { calcularGanadores, parsearNumerosBono, validarTramos, bloquesSeSolapan, bloqueDeNumero, formatearNumeroBono } = require("../api/services/olimpiadas-comun");

const OLIMPIADA = { id: 1, bono_numero_desde: 0, bono_numero_hasta: 9999, valor_bono: 40000, bonos_afiliado: 8 };
const BLOQUES = [
  { id: 1, departamental_id: 1, departamental_nombre: "La Plata", numero_desde: 0, numero_hasta: 4200 },
  { id: 2, departamental_id: 4, departamental_nombre: "Mercedes", numero_desde: 4201, numero_hasta: 9999 },
];
const ADMIN = { id: 1, rol: "admin", departamental_id: null };
const DEPARTAMENTAL = { id: 3, rol: "departamental", departamental_id: 1 };

// ---------------------------------------------------------------------------
// Modo automático y bloques
// ---------------------------------------------------------------------------
test("bonos: elegirNumerosLibres recorre los bloques en orden y saltea los vendidos", () => {
  const bloques = [
    { id: 9, numero_desde: 20, numero_hasta: 22 },
    { id: 3, numero_desde: 10, numero_hasta: 12 },
  ];
  assert.deepEqual(elegirNumerosLibres(bloques, new Set([10, 12]), 3), [11, 20, 21]);
  assert.deepEqual(elegirNumerosLibres(bloques, [10, 11, 12, 20, 21, 22], 2), []);
  assert.deepEqual(elegirNumerosLibres(bloques, new Set(), 10), [10, 11, 12, 20, 21, 22]);
  assert.deepEqual(elegirNumerosLibres([], new Set(), 5), []);
  assert.deepEqual(elegirNumerosLibres(bloques, new Set(), 0), []);
});

test("bonos: validarBloque exige rango dentro de la edición y sin solapamientos", () => {
  const ok = validarBloque({ departamental_id: "7", numero_desde: "100", numero_hasta: 200, observacion: "  cupo extra " }, { olimpiada: OLIMPIADA, bloques: [] });
  assert.deepEqual(ok.value, { departamental_id: 7, numero_desde: 100, numero_hasta: 200, observacion: "cupo extra" });

  assert.match(validarBloque({ numero_desde: 1, numero_hasta: 2 }, { olimpiada: OLIMPIADA }).error, /departamental/);
  assert.match(validarBloque({ departamental_id: 1, numero_desde: "a", numero_hasta: 2 }, { olimpiada: OLIMPIADA }).error, /enteros/);
  assert.match(validarBloque({ departamental_id: 1, numero_desde: 5, numero_hasta: 2 }, { olimpiada: OLIMPIADA }).error, /menor/);
  assert.match(validarBloque({ departamental_id: 1, numero_desde: 0, numero_hasta: 10000 }, { olimpiada: OLIMPIADA }).error, /0000–9999/);

  const solapado = validarBloque({ departamental_id: 2, numero_desde: 4000, numero_hasta: 4500 }, { olimpiada: OLIMPIADA, bloques: BLOQUES });
  assert.equal(solapado.status, 409);
  assert.match(solapado.error, /0000–4200 de La Plata/);

  // Editar el mismo bloque no se solapa consigo mismo
  const edicion = validarBloque({ departamental_id: 1, numero_desde: 0, numero_hasta: 4100 }, { olimpiada: OLIMPIADA, bloques: BLOQUES, bloqueId: 1 });
  assert.equal(edicion.error, undefined);
  assert.equal(edicion.value.numero_hasta, 4100);
});

test("bonos: validarRangoNumeracion no deja afuera bloques ni bonos vendidos", () => {
  assert.equal(validarRangoNumeracion(0, 9999, { bloques: BLOQUES }).error, undefined);
  assert.equal(validarRangoNumeracion(10, 5).status, 400);
  assert.equal(validarRangoNumeracion(0, MAX_NUMERO_BONO + 1).status, 400);
  const bloqueAfuera = validarRangoNumeracion(0, 5000, { bloques: BLOQUES });
  assert.equal(bloqueAfuera.status, 409);
  assert.match(bloqueAfuera.error, /Mercedes/);
  const vendidoAfuera = validarRangoNumeracion(100, 9999, { bloques: [], vendidosMin: 12, vendidosMax: 460 });
  assert.equal(vendidoAfuera.status, 409);
  assert.match(vendidoAfuera.error, /0012–0460/);
  assert.equal(validarRangoNumeracion(0, 9999, { bloques: [], vendidosMin: 12, vendidosMax: 460 }).error, undefined);
});

test("bonos: helpers de comun detectan solapamientos y ubican el bloque de un número", () => {
  assert.equal(bloquesSeSolapan({ numero_desde: 0, numero_hasta: 10 }, { numero_desde: 10, numero_hasta: 20 }), true);
  assert.equal(bloquesSeSolapan({ numero_desde: 0, numero_hasta: 9 }, { numero_desde: 10, numero_hasta: 20 }), false);
  assert.equal(bloqueDeNumero(BLOQUES, 460).id, 1);
  assert.equal(bloqueDeNumero(BLOQUES, 4201).id, 2);
  assert.equal(bloqueDeNumero(BLOQUES, 10000), null);
});

// ---------------------------------------------------------------------------
// Grilla, buscador y formato
// ---------------------------------------------------------------------------
test("bonos: clasificarNumero oculta compradores ajenos a la departamental", () => {
  const bono = { id: 5, comprador_nombre: "Pérez, Juan", comprador_documento: "123", inscripcion_id: 12, a_nombre_departamental: 0, departamental_id: 4, departamental_nombre: "Mercedes" };
  const ajeno = clasificarNumero({ numero: 4300, bloque: BLOQUES[1], bono, cabecera: DEPARTAMENTAL, olimpiada: OLIMPIADA });
  assert.equal(ajeno.estado, "AJENO");
  assert.equal(ajeno.bono, null);
  assert.equal(ajeno.departamental_nombre, "Mercedes");

  const propio = clasificarNumero({ numero: 460, bloque: BLOQUES[0], bono: { ...bono, departamental_id: 1 }, cabecera: DEPARTAMENTAL, olimpiada: OLIMPIADA });
  assert.equal(propio.estado, "VENDIDO");
  assert.deepEqual(propio.bono, { id: 5, comprador_nombre: "Pérez, Juan", comprador_documento: "123", inscripcion_id: 12, a_nombre_departamental: 0 });
  assert.equal(propio.numero_texto, "0460");

  const superior = clasificarNumero({ numero: 4300, bloque: BLOQUES[1], bono, cabecera: ADMIN, olimpiada: OLIMPIADA });
  assert.equal(superior.estado, "VENDIDO");
  assert.equal(clasificarNumero({ numero: 4300, bloque: BLOQUES[1], bono: null, cabecera: ADMIN, olimpiada: OLIMPIADA }).estado, "DISPONIBLE");

  const sinBloque = clasificarNumero({ numero: 10, bloque: null, bono: null, cabecera: ADMIN, olimpiada: OLIMPIADA });
  assert.equal(sinBloque.estado, "SIN_ASIGNAR");
  assert.equal(sinBloque.departamental_id, null);
});

test("bonos: la búsqueda combina número exacto, prefijo con ceros, comprador, DNI, email y afiliado", () => {
  const numerica = condicionBusquedaBonos("0460", OLIMPIADA);
  assert.equal(numerica.params[0], 460);
  assert.equal(numerica.params[1], "0460%");
  assert.equal(numerica.params[2], 4);
  assert.equal((numerica.sql.match(/\?/g) || []).length, numerica.params.length);
  const texto = condicionBusquedaBonos("prueba", OLIMPIADA);
  assert.equal(texto.params[0], -1);
  assert.ok(texto.params.includes("%prueba%"));
  assert.ok(texto.params.includes("prueba%"));
});

test("bonos: leerEnteroQuery distingue ausente de inválido", () => {
  assert.equal(leerEnteroQuery(undefined), null);
  assert.equal(leerEnteroQuery(""), null);
  assert.equal(leerEnteroQuery("400"), 400);
  assert.equal(leerEnteroQuery("abc"), undefined);
  assert.equal(leerEnteroQuery("-1"), undefined);
});

test("bonos: describirNumeros comprime tramos consecutivos y formatea con ceros", () => {
  assert.equal(describirNumeros([467, 460, 461, 462, 470, 460], OLIMPIADA), "0460-0462, 0467, 0470 (5)");
  assert.equal(describirNumeros([5], OLIMPIADA), "0005 (1)");
  assert.equal(padNumero(7, 999999), "000007");
  assert.equal(formatearNumeroBono(12, { bono_numero_hasta: 99 }), "0012");
});

test("bonos: armarReglas y mapearBonoVendido devuelven el shape del contrato", () => {
  const reglas = armarReglas(
    { ...OLIMPIADA, requiere_aprobacion: 1, exigir_bonos_para_validar: 0, fecha_sorteo: "2026-09-25", sorteo_detalle: null, sorteo_publicado: 0, fecha_inicio: "2026-09-23" },
    [{ id: 1, edad_desde: 18, edad_hasta: null, bonos: 11, etiqueta: "Invitado", orden: 1, fecha_creacion: "x" }]
  );
  assert.deepEqual(Object.keys(reglas), [
    "olimpiada_id", "valor_bono", "bonos_afiliado", "bono_numero_desde", "bono_numero_hasta", "digitos",
    "requiere_aprobacion", "exigir_bonos_para_validar", "fecha_sorteo", "sorteo_detalle", "sorteo_publicado", "fecha_inicio", "tramos",
  ]);
  assert.equal(reglas.digitos, 4);
  assert.deepEqual(reglas.tramos[0], { id: 1, edad_desde: 18, edad_hasta: null, bonos: 11, etiqueta: "Invitado", orden: 1 });

  const fila = mapearBonoVendido({ id: 3, numero: 460, comprador_nombre: "Coop", a_nombre_departamental: 1, inscripcion_id: null, departamental_id: 1, fecha_venta: "2026-09-02" }, OLIMPIADA);
  assert.equal(fila.numero_texto, "0460");
  assert.equal(fila.a_nombre_departamental, 1);
  assert.equal(fila.afiliado_apellido, null);
  assert.equal(fila.usuario_nombre, null);
});

// ---------------------------------------------------------------------------
// Entradas de venta, edición y reglas
// ---------------------------------------------------------------------------
test("bonos: normalizarVenta exige exactamente uno de numeros o cantidad", () => {
  assert.match(normalizarVenta({}).error, /una de las dos/);
  assert.match(normalizarVenta({ numeros: "1", cantidad: 2, comprador_nombre: "x" }).error, /una de las dos/);
  assert.match(normalizarVenta({ cantidad: 0, comprador_nombre: "x" }).error, /entre 1 y/);
  assert.match(normalizarVenta({ cantidad: MAX_CANTIDAD_AUTOMATICA + 1, comprador_nombre: "x" }).error, /entre 1 y/);
  assert.match(normalizarVenta({ numeros: "12, 15-18" }).error, /nombre del comprador/);
  assert.match(normalizarVenta({ numeros: "12", comprador_nombre: "x", comprador_email: "no-es-email" }).error, /email/);
  assert.match(normalizarVenta({ numeros: "12", comprador_nombre: "x", a_nombre_departamental: "si" }).error, /0 o 1/);

  const venta = normalizarVenta({ numeros: "12, 15-18 0460", comprador_nombre: "  Cooperadora  ", comprador_documento: "20123456", observacion: "efectivo" });
  assert.deepEqual(venta.value.numeros, [12, 15, 16, 17, 18, 460]);
  assert.equal(venta.value.cantidad, null);
  assert.equal(venta.value.comprador_nombre, "Cooperadora");
  assert.equal(venta.value.a_nombre_departamental, 0);
  assert.equal(venta.value.observacion, "efectivo");

  // A nombre de la departamental o imputado a una inscripción no necesita comprador
  assert.equal(normalizarVenta({ cantidad: "2", a_nombre_departamental: 1 }).error, undefined);
  assert.equal(normalizarVenta({ cantidad: 2, inscripcion_id: "12" }).value.inscripcion_id, 12);
  assert.deepEqual(normalizarVenta({ numeros: [3, "5"], comprador_nombre: "x" }).value.numeros, [3, 5]);
});

test("bonos: normalizarEdicionBono sólo toma los campos enviados", () => {
  assert.match(normalizarEdicionBono({}).error, /No hay cambios/);
  const cambios = normalizarEdicionBono({ comprador_nombre: "Nuevo", inscripcion_id: null, a_nombre_departamental: "0" });
  assert.deepEqual(cambios.value, { comprador_nombre: "Nuevo", inscripcion_id: null, a_nombre_departamental: 0 });
  assert.match(normalizarEdicionBono({ comprador_documento: "!!!" }).error, /documento/);
});

test("bonos: normalizarReglasEntrada valida montos, numeración, flags, fecha y tramos", () => {
  const ok = normalizarReglasEntrada({
    valor_bono: "40000,50",
    bonos_afiliado: "8",
    bono_numero_hasta: 9999,
    requiere_aprobacion: "true",
    exigir_bonos_para_validar: 0,
    fecha_sorteo: "2026-09-25",
    sorteo_detalle: " Quiniela nocturna ",
    tramos: [{ edad_desde: 0, edad_hasta: 17, bonos: 5 }, { edad_desde: 18, edad_hasta: null, bonos: 11 }],
  });
  assert.deepEqual(ok.value.cambios, {
    valor_bono: 40000.5,
    bonos_afiliado: 8,
    bono_numero_hasta: 9999,
    requiere_aprobacion: 1,
    exigir_bonos_para_validar: 0,
    fecha_sorteo: "2026-09-25",
    sorteo_detalle: "Quiniela nocturna",
  });
  assert.equal(ok.value.tramos.length, 2);
  assert.equal(ok.value.tramos[1].orden, 2);

  assert.match(normalizarReglasEntrada({ valor_bono: "abc" }).error, /importe/);
  assert.match(normalizarReglasEntrada({ bonos_afiliado: -1 }).error, /entre 0 y/);
  assert.match(normalizarReglasEntrada({ bono_numero_hasta: MAX_NUMERO_BONO + 1 }).error, /numeración/);
  assert.match(normalizarReglasEntrada({ fecha_sorteo: "25/09/2026" }).error, /YYYY-MM-DD/);
  assert.equal(normalizarReglasEntrada({ fecha_sorteo: "" }).value.cambios.fecha_sorteo, null);
  assert.match(normalizarReglasEntrada({ tramos: [] }).error, /al menos un tramo/);
  assert.deepEqual(normalizarReglasEntrada({}).value, { cambios: {}, tramos: null });
});

// ---------------------------------------------------------------------------
// Premios y sorteo
// ---------------------------------------------------------------------------
test("bonos: parsearPremios quita el prefijo de puesto y conserva números que son parte del premio", () => {
  const texto = "1º PlayStation 5\r\n2° Notebook\n3. Tablet\n4) Bicicleta\n5- Estadía\n6– Cena\n\n   \n7 Televisor\n2 pasajes a Brasil\nSin número";
  assert.deepEqual(parsearPremios(texto), [
    "PlayStation 5",
    "Notebook",
    "Tablet",
    "Bicicleta",
    "Estadía",
    "Cena",
    "Televisor",
    "2 pasajes a Brasil",
    "Sin número",
  ]);
  assert.deepEqual(parsearPremios(""), []);
  assert.deepEqual(parsearPremios("1º "), []);
});

test("bonos: calcularGanadores cruza con los vendidos y deja vacantes los no vendidos y repetidos", () => {
  const premios = [
    { id: 3, orden: 3, descripcion: "Tablet", numero_ganador: 460 },
    { id: 1, orden: 1, descripcion: "PlayStation 5", numero_ganador: 460 },
    { id: 2, orden: 2, descripcion: "Notebook", numero_ganador: 8000 },
    { id: 4, orden: 4, descripcion: "Bicicleta", numero_ganador: null },
  ];
  const vendidos = new Map([[460, { id: 9, comprador_nombre: "Cooperadora Prueba", departamental_nombre: "La Plata" }]]);
  const resultado = calcularGanadores(premios, vendidos);
  assert.deepEqual(resultado.map((p) => [p.id, p.estado, p.motivo_vacante]), [
    [1, "GANADO", null],
    [2, "VACANTE", "Bono no vendido"],
    [3, "VACANTE", "Número repetido"],
    [4, "SIN_SORTEAR", null],
  ]);
  assert.equal(resultado[0].bono.comprador_nombre, "Cooperadora Prueba");
  assert.equal(resultado[3].numero_ganador, null);
  // También acepta un objeto plano como índice de vendidos
  assert.equal(calcularGanadores([{ id: 1, orden: 1, numero_ganador: "12" }], { 12: { id: 1 } })[0].estado, "GANADO");
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
test("bonos: escaparCsv neutraliza fórmulas y encierra separadores, comillas y saltos", () => {
  assert.equal(escaparCsv(null), "");
  assert.equal(escaparCsv("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(escaparCsv("+54 11"), "'+54 11");
  assert.equal(escaparCsv("-1"), "'-1");
  assert.equal(escaparCsv("@usuario"), "'@usuario");
  assert.equal(escaparCsv("Pérez; Juan"), '"Pérez; Juan"');
  assert.equal(escaparCsv('dijo "hola"'), '"dijo ""hola"""');
  assert.equal(escaparCsv("dos\nlíneas"), '"dos\nlíneas"');
  assert.equal(escaparCsv("texto normal"), "texto normal");
});

test("bonos: armarCsvBonos arranca con BOM, usa ; y las columnas del contrato", () => {
  const csv = armarCsvBonos(
    [
      { numero: 460, comprador_nombre: "=malicioso()", comprador_documento: "20123456", comprador_email: "a@b.com", comprador_telefono: null, departamental_nombre: "La Plata", a_nombre_departamental: 1, inscripcion_id: 12, afiliado_apellido: "Pérez", afiliado_nombre: "Juan", fecha_venta: new Date("2026-09-02T18:05:00-03:00"), observacion: "ok; listo" },
      { numero: 7, comprador_nombre: "Cooperadora", comprador_documento: null, comprador_email: null, comprador_telefono: null, departamental_nombre: "Mercedes", a_nombre_departamental: 0, inscripcion_id: null, afiliado_apellido: null, afiliado_nombre: null, fecha_venta: null, observacion: null },
    ],
    OLIMPIADA
  );
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lineas = csv.slice(1).split("\r\n");
  assert.equal(lineas[0], COLUMNAS_CSV.join(";"));
  assert.equal(lineas[0], "Número;Comprador;DNI;Email;Teléfono;Departamental;A nombre de la departamental;Inscripción;Afiliado;Fecha de venta;Observación");
  assert.equal(lineas[1], `0460;'=malicioso();20123456;a@b.com;;La Plata;Sí;#12;Pérez, Juan;02/09/2026 18:05;"ok; listo"`);
  assert.equal(lineas[2], "0007;Cooperadora;;;;Mercedes;No;;;;");
  assert.equal(lineas[3], "");
});

// ---------------------------------------------------------------------------
// Helpers puros de comun usados por el router
// ---------------------------------------------------------------------------
test("bonos: parsearNumerosBono acepta listas, rangos y rechaza basura o exceso", () => {
  assert.deepEqual(parsearNumerosBono("12, 15-18 0460;3").value, [3, 12, 15, 16, 17, 18, 460]);
  assert.deepEqual(parsearNumerosBono([5, "7-8"]).value, [5, 7, 8]);
  assert.match(parsearNumerosBono("18-15").error, /invertido/);
  assert.match(parsearNumerosBono("12a").error, /no es un número/);
  assert.match(parsearNumerosBono("").error, /al menos un número/);
  assert.match(parsearNumerosBono("1-600", { maximo: 500 }).error, /500/);
  assert.match(parsearNumerosBono("1-3", { maximo: 2 }).error, /2 números/);
});

test("bonos: validarTramos ordena, numera y rechaza solapamientos o más de un tramo abierto", () => {
  const ok = validarTramos([
    { edad_desde: 18, edad_hasta: "", bonos: 11, etiqueta: "Invitado" },
    { edad_desde: "0", edad_hasta: 17, bonos: "5" },
  ]);
  assert.deepEqual(ok.value.map((t) => [t.edad_desde, t.edad_hasta, t.bonos, t.orden]), [[0, 17, 5, 1], [18, null, 11, 2]]);
  assert.match(validarTramos([{ edad_desde: 0, edad_hasta: 18, bonos: 5 }, { edad_desde: 18, edad_hasta: null, bonos: 11 }]).error, /solapan/);
  assert.match(validarTramos([{ edad_desde: 0, edad_hasta: null, bonos: 5 }, { edad_desde: 18, edad_hasta: null, bonos: 11 }]).error, /solapan/);
  assert.match(validarTramos([{ edad_desde: 10, edad_hasta: 5, bonos: 1 }]).error, /inválidos/);
  assert.match(validarTramos([{ edad_desde: 0, edad_hasta: 200, bonos: 1 }]).error, /fuera de rango/);
  assert.match(validarTramos(null).error, /al menos un tramo/);
});
