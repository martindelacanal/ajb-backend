const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/olimpiadas");
const {
  ESTADOS_EDICION,
  MENSAJE_FORMATO_FOTO,
  avisoAltaPorStaff,
  calcularEstadoEdicion,
  documentacionCompleta,
  estadoInicialInscripcion,
  formatoFotoValido,
  mensajeAltaInscripcion,
  mismosAcompaniantes,
  nombreArchivoOriginal,
  normalizarAcompaniantes,
  observacionCambioAdjunto,
  permisosInscripcion,
  resumenAltaInscripcion,
  textoCupo,
  textoResumenAcompaniantes,
  transicionPermitida,
} = router.__test;

// ---------------------------------------------------------------------------
// Estado inicial de la inscripción (§1.3 del contrato)
// ---------------------------------------------------------------------------
test("estado inicial: el afiliado nace PENDIENTE si la edición exige aprobación o bonos", () => {
  assert.equal(estadoInicialInscripcion({ rol: "afiliado", olimpiada: { requiere_aprobacion: 1, exigir_bonos_para_validar: 0 } }), "PENDIENTE");
  assert.equal(estadoInicialInscripcion({ rol: "afiliado", olimpiada: { requiere_aprobacion: 0, exigir_bonos_para_validar: 1 } }), "PENDIENTE");
  assert.equal(estadoInicialInscripcion({ rol: "afiliado", olimpiada: { requiere_aprobacion: "1", exigir_bonos_para_validar: "1" } }), "PENDIENTE");
  assert.equal(estadoInicialInscripcion({ rol: "afiliado", olimpiada: { requiere_aprobacion: 0, exigir_bonos_para_validar: 0 } }), "PENDIENTE");
});

test("estado inicial: el staff nace PENDIENTE sólo si la edición exige bonos para validar", () => {
  for (const rol of ["departamental", "admin", "admin-central"]) {
    assert.equal(estadoInicialInscripcion({ rol, olimpiada: { requiere_aprobacion: 1, exigir_bonos_para_validar: 1 } }), "PENDIENTE", rol);
    assert.equal(estadoInicialInscripcion({ rol, olimpiada: { requiere_aprobacion: 1, exigir_bonos_para_validar: 0 } }), "VALIDADO", rol);
    assert.equal(estadoInicialInscripcion({ rol, olimpiada: { requiere_aprobacion: 0, exigir_bonos_para_validar: 0 } }), "VALIDADO", rol);
  }
});

test("estado inicial: sin olimpiada o con banderas ausentes se trata como no exigido", () => {
  assert.equal(estadoInicialInscripcion({ rol: "afiliado", olimpiada: null }), "PENDIENTE");
  assert.equal(estadoInicialInscripcion({ rol: "departamental", olimpiada: {} }), "VALIDADO");
});

// ---------------------------------------------------------------------------
// Transiciones de estado
// ---------------------------------------------------------------------------
test("transiciones: el afiliado sólo puede cancelar", () => {
  assert.equal(transicionPermitida({ rol: "afiliado", desde: "PENDIENTE", hacia: "CANCELADO" }), true);
  assert.equal(transicionPermitida({ rol: "afiliado", desde: "VALIDADO", hacia: "CANCELADO" }), true);
  assert.equal(transicionPermitida({ rol: "afiliado", desde: "PENDIENTE", hacia: "VALIDADO" }), false);
  assert.equal(transicionPermitida({ rol: "afiliado", desde: "CANCELADO", hacia: "VALIDADO" }), false);
  assert.equal(transicionPermitida({ rol: "afiliado", desde: "CANCELADO", hacia: "PENDIENTE" }), false);
});

test("transiciones: el staff aprueba, cancela, reactiva y devuelve a revisión", () => {
  const pares = [
    ["PENDIENTE", "VALIDADO"],
    ["PENDIENTE", "CANCELADO"],
    ["VALIDADO", "CANCELADO"],
    ["CANCELADO", "VALIDADO"],
    ["VALIDADO", "PENDIENTE"],
    ["CANCELADO", "PENDIENTE"],
  ];
  for (const rol of ["departamental", "admin", "admin-central"]) {
    for (const [desde, hacia] of pares) {
      assert.equal(transicionPermitida({ rol, desde, hacia }), true, `${rol} ${desde}→${hacia}`);
    }
  }
});

test("transiciones: nunca al mismo estado, a estados desconocidos ni para roles sin gestión", () => {
  assert.equal(transicionPermitida({ rol: "admin", desde: "VALIDADO", hacia: "VALIDADO" }), false);
  assert.equal(transicionPermitida({ rol: "admin", desde: "PENDIENTE", hacia: "APROBADO" }), false);
  assert.equal(transicionPermitida({ rol: "admin", desde: "BORRADOR", hacia: "VALIDADO" }), false);
  assert.equal(transicionPermitida({ rol: "auditor", desde: "PENDIENTE", hacia: "VALIDADO" }), false);
  assert.equal(transicionPermitida({ rol: "invitado", desde: "PENDIENTE", hacia: "CANCELADO" }), false);
  assert.equal(transicionPermitida({ rol: undefined, desde: "PENDIENTE", hacia: "CANCELADO" }), false);
});

// ---------------------------------------------------------------------------
// Acompañantes
// ---------------------------------------------------------------------------
test("acompañantes: campo ausente conserva, vacío limpia, JSON roto o de más rechaza", () => {
  assert.deepEqual(normalizarAcompaniantes(undefined), { value: undefined });
  assert.deepEqual(normalizarAcompaniantes(""), { value: [] });
  assert.deepEqual(normalizarAcompaniantes(null), { value: [] });
  assert.deepEqual(normalizarAcompaniantes("[]"), { value: [] });
  assert.match(normalizarAcompaniantes("no-json").error, /inválida/);
  assert.match(normalizarAcompaniantes('{"nombre":"Ana"}').error, /inválida/);
  const muchos = JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ nombre: `N${i}`, apellido: "A" })));
  assert.match(normalizarAcompaniantes(muchos).error, /hasta 15/);
});

test("acompañantes: exige nombre y apellido y valida documento y fecha", () => {
  assert.match(normalizarAcompaniantes([{ nombre: "Ana" }]).error, /#1 necesita nombre y apellido/);
  assert.match(normalizarAcompaniantes([{ nombre: "Ana", apellido: "Staffa" }, { apellido: "X" }]).error, /#2 necesita/);
  assert.match(normalizarAcompaniantes([{ nombre: "Ana", apellido: "Staffa", fecha_nacimiento: "05/05/2015" }]).error, /fecha de nacimiento/);
  assert.match(normalizarAcompaniantes([{ nombre: "Ana", apellido: "Staffa", documento: "12 345" }]).error, /documento/);
  assert.match(normalizarAcompaniantes([{ nombre: "Ana", apellido: "Staffa", es_afiliado: "quizás" }]).error, /es_afiliado/);
  assert.match(normalizarAcompaniantes([null]).error, /#1 es inválido/);
});

test("acompañantes: normaliza una fila completa y respeta bonos_manual sólo para el staff", () => {
  const fila = JSON.stringify([{
    nombre: "  Ana ", apellido: "Staffa", documento: "40123456", fecha_nacimiento: "2015-05-05",
    vinculo: "Hijo/a", es_afiliado: "0", bonos: 4, bonos_manual: 1, observacion: "DT externo",
  }]);
  const afiliado = normalizarAcompaniantes(fila, { permitirManual: false }).value[0];
  assert.deepEqual(afiliado, {
    nombre: "Ana", apellido: "Staffa", documento: "40123456", fecha_nacimiento: "2015-05-05",
    vinculo: "Hijo/a", es_afiliado: 0, bonos: null, bonos_manual: 0, observacion: "DT externo",
  });
  const staff = normalizarAcompaniantes(fila, { permitirManual: true }).value[0];
  assert.equal(staff.bonos_manual, 1);
  assert.equal(staff.bonos, 4);
  assert.match(
    normalizarAcompaniantes([{ nombre: "A", apellido: "B", bonos_manual: 1, bonos: -1 }], { permitirManual: true }).error,
    /bonos manuales/
  );
  assert.match(
    normalizarAcompaniantes([{ nombre: "A", apellido: "B", bonos_manual: 1, bonos: 1000 }], { permitirManual: true }).error,
    /bonos manuales/
  );
});

test("acompañantes: resumen legible en singular y plural", () => {
  assert.equal(textoResumenAcompaniantes({ cantidad: 1, bonos: 6 }), "1 acompañante (6 bonos)");
  assert.equal(textoResumenAcompaniantes({ cantidad: 3, bonos: 17 }), "3 acompañantes (17 bonos)");
  assert.equal(textoResumenAcompaniantes({ cantidad: 0, bonos: 0 }), "0 acompañantes (0 bonos)");
});

// El historial muestra este texto tal cual («Ahora» de «Se creó la inscripción»)
test("alta: el resumen del historial va con el plural correcto y el estado como se ve en pantalla", () => {
  const datos = { apellido: "Staffa", nombre: "Nahuel", categoria: "Atleta" };
  assert.equal(
    resumenAltaInscripcion({ ...datos, cantidadDisciplinas: 1, estado: "PENDIENTE" }),
    "Inscripción de Staffa, Nahuel · Atleta · 1 disciplina · En revisión"
  );
  assert.equal(
    resumenAltaInscripcion({ ...datos, cantidadDisciplinas: 3, estado: "VALIDADO" }),
    "Inscripción de Staffa, Nahuel · Atleta · 3 disciplinas · Aprobada"
  );
  assert.equal(
    resumenAltaInscripcion({ ...datos, cantidadDisciplinas: 2, estado: "CANCELADO" }),
    "Inscripción de Staffa, Nahuel · Atleta · 2 disciplinas · Cancelada"
  );
  // Ningún código de estado crudo, en ninguno de los estados con que puede nacer
  for (const estado of ["PENDIENTE", "VALIDADO"]) {
    assert.doesNotMatch(resumenAltaInscripcion({ ...datos, cantidadDisciplinas: 1, estado }), /PENDIENTE|VALIDADO|1 disciplinas/);
  }
});

// ---------------------------------------------------------------------------
// Permisos por rol y estado
// ---------------------------------------------------------------------------
const olimpiadaAbierta = { fecha_inicio_inscripcion: "2027-08-01", fecha_fin_inscripcion: "2027-08-31" };
const hoyDentro = "2027-08-15";
const hoyFuera = "2027-09-15";

test("permisos: el afiliado edita y cancela la propia mientras la ventana está abierta", () => {
  const cabecera = { rol: "afiliado", id: 2 };
  const pendiente = { usuario_id: 2, estado: "PENDIENTE" };
  assert.deepEqual(permisosInscripcion({ cabecera, inscripcion: pendiente, olimpiada: olimpiadaAbierta, hoy: hoyDentro }), {
    puede_editar: true, puede_validar: false, puede_cancelar: true,
    puede_pendiente: false, puede_eliminar: false, puede_gestionar_bonos: false,
  });
  assert.equal(permisosInscripcion({ cabecera, inscripcion: pendiente, olimpiada: olimpiadaAbierta, hoy: hoyFuera }).puede_editar, false);
  const cancelada = { usuario_id: 2, estado: "CANCELADO" };
  const permisosCancelada = permisosInscripcion({ cabecera, inscripcion: cancelada, olimpiada: olimpiadaAbierta, hoy: hoyDentro });
  assert.equal(permisosCancelada.puede_editar, false);
  assert.equal(permisosCancelada.puede_cancelar, false);
});

test("permisos: la departamental gestiona pero no elimina; el admin elimina", () => {
  const inscripcion = { usuario_id: 2, estado: "PENDIENTE", departamental_id: 1 };
  const departamental = permisosInscripcion({ cabecera: { rol: "departamental", id: 3, departamental_id: 1 }, inscripcion, olimpiada: olimpiadaAbierta, hoy: hoyFuera });
  assert.deepEqual(departamental, {
    puede_editar: true, puede_validar: true, puede_cancelar: true,
    puede_pendiente: false, puede_eliminar: false, puede_gestionar_bonos: true,
  });
  const admin = permisosInscripcion({ cabecera: { rol: "admin", id: 1 }, inscripcion: { ...inscripcion, estado: "VALIDADO" }, olimpiada: olimpiadaAbierta, hoy: hoyFuera });
  assert.equal(admin.puede_validar, false);
  assert.equal(admin.puede_pendiente, true);
  assert.equal(admin.puede_eliminar, true);
  const central = permisosInscripcion({ cabecera: { rol: "admin-central", id: 11 }, inscripcion, olimpiada: olimpiadaAbierta, hoy: hoyFuera });
  assert.equal(central.puede_validar, true);
  assert.equal(central.puede_eliminar, false);
});

// ---------------------------------------------------------------------------
// Estado de la edición según el calendario
// ---------------------------------------------------------------------------
test("edición: el estado se calcula con fechas civiles inclusivas", () => {
  const olimpiada = {
    fecha_inicio_inscripcion: "2027-08-01", fecha_fin_inscripcion: "2027-08-31",
    fecha_inicio: "2027-10-10", fecha_fin: "2027-10-12",
  };
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-07-31"), "PROXIMA");
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-08-01"), "INSCRIPCION_ABIERTA");
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-08-31"), "INSCRIPCION_ABIERTA");
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-09-01"), "INSCRIPCION_CERRADA");
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-10-10"), "EN_CURSO");
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-10-12"), "EN_CURSO");
  assert.equal(calcularEstadoEdicion(olimpiada, "2027-10-13"), "FINALIZADA");
  for (const estado of ["PROXIMA", "INSCRIPCION_ABIERTA", "INSCRIPCION_CERRADA", "EN_CURSO", "FINALIZADA"]) {
    assert.ok(ESTADOS_EDICION.includes(estado));
  }
});

test("documentación completa exige foto y certificado sin exigir firma del afiliado", () => {
  assert.equal(documentacionCompleta({ foto_archivo: "a", certificado_archivo: "b" }), true);
  assert.equal(documentacionCompleta({ foto_archivo: "a", certificado_archivo: "b", firma_archivo: null }), true);
  assert.equal(documentacionCompleta({ foto_archivo: "a", certificado_archivo: "b", firma_archivo: "c" }), true);
  assert.equal(documentacionCompleta({ foto_archivo: "a", certificado_archivo: null, firma_archivo: "c" }), false);
  assert.equal(documentacionCompleta({}), false);
});

// ---------------------------------------------------------------------------
// Cupo por departamental: textos
// ---------------------------------------------------------------------------
test("cupo: los mensajes nombran el cupo de la departamental de la persona", () => {
  assert.equal(textoCupo("La Plata"), "el cupo de La Plata");
  assert.equal(textoCupo(null), "el cupo de afiliados sin departamental");
  assert.equal(textoCupo(""), "el cupo de afiliados sin departamental");
});

test("cupo: el alta del staff confirma de qué cupo se descontaron los lugares", () => {
  assert.equal(
    mensajeAltaInscripcion({ actorEsStaff: true, estado: "PENDIENTE", nombreDepartamental: "La Plata" }),
    "Inscripción cargada en el cupo de La Plata. Asigná los bonos para aprobarla"
  );
  assert.equal(
    mensajeAltaInscripcion({ actorEsStaff: true, estado: "VALIDADO", nombreDepartamental: "La Plata" }),
    "Inscripción cargada y aprobada en el cupo de La Plata"
  );
  // El afiliado sigue viendo los textos de siempre
  assert.equal(
    mensajeAltaInscripcion({ actorEsStaff: false, estado: "PENDIENTE", nombreDepartamental: "La Plata" }),
    "¡Inscripción enviada! Queda pendiente de aprobación de tu departamental"
  );
  assert.equal(
    mensajeAltaInscripcion({ actorEsStaff: false, estado: "VALIDADO", nombreDepartamental: "La Plata" }),
    "¡Inscripción enviada! Nos vemos en las olimpiadas"
  );
});

test("aviso al afiliado: dice quién cargó la inscripción", () => {
  const departamental = avisoAltaPorStaff({ rol: "departamental", olimpiadaNombre: "Olimpiadas 2027", estado: "VALIDADO" });
  assert.equal(departamental.titulo, "Te inscribimos a Olimpiadas 2027");
  assert.match(departamental.mensaje, /^Tu departamental cargó tu inscripción a Olimpiadas 2027 y ya está aprobada\./);
  for (const rol of ["admin", "admin-central"]) {
    const aviso = avisoAltaPorStaff({ rol, olimpiadaNombre: "Olimpiadas 2027", estado: "PENDIENTE" });
    assert.equal(aviso.mensaje, "La AJB cargó tu inscripción a Olimpiadas 2027. Queda en revisión hasta que se cubran los bonos contribución.", rol);
    assert.doesNotMatch(aviso.mensaje, /Tu departamental/);
  }
});

// ---------------------------------------------------------------------------
// Foto y certificado al editar
// ---------------------------------------------------------------------------
test("adjuntos: la foto acepta JPG, PNG y WebP y rechaza HEIC con un texto que dice qué hacer", () => {
  for (const mimetype of ["image/jpeg", "image/png", "image/webp"]) assert.equal(formatoFotoValido({ mimetype }), true, mimetype);
  assert.equal(formatoFotoValido({ mimetype: "image/heic" }), false);
  assert.equal(formatoFotoValido({ mimetype: "application/pdf" }), false);
  assert.equal(formatoFotoValido(null), false);
  assert.match(MENSAJE_FORMATO_FOTO, /JPG, PNG o WebP.*HEIC.*guardala como JPG/);
});

test("adjuntos: el nombre del archivo se repara de latin1 y se acota a la columna", () => {
  assert.equal(nombreArchivoOriginal("apto_mÃ©dico_MuÃ±oz.pdf"), "apto_médico_Muñoz.pdf");
  assert.equal(nombreArchivoOriginal("certificado.pdf"), "certificado.pdf");
  assert.equal(nombreArchivoOriginal("apto_médico.pdf"), "apto_médico.pdf"); // ya correcto: no se rompe
  assert.equal(nombreArchivoOriginal("FOTO_Ñandú.jpg"), "FOTO_Ñandú.jpg");
  assert.equal(nombreArchivoOriginal(Buffer.from("Ñoño.pdf", "utf8").toString("latin1")), "Ñoño.pdf");
  assert.equal(nombreArchivoOriginal("apto\u0000\nfinal.pdf"), "aptofinal.pdf");
  assert.equal(nombreArchivoOriginal("a".repeat(400)).length, 255);
  assert.equal(Array.from(nombreArchivoOriginal("😀".repeat(300))).length, 255); // corta por caracteres, no por mitades
  assert.equal(nombreArchivoOriginal(""), null);
  assert.equal(nombreArchivoOriginal("   "), null);
  assert.equal(nombreArchivoOriginal(undefined), null);
});

test("adjuntos: el historial dice si se cargó o se reemplazó, sin keys de S3", () => {
  assert.equal(observacionCambioAdjunto({ campo: "foto_archivo", habia: false }), "Se cargó la foto del afiliado.");
  assert.equal(
    observacionCambioAdjunto({ campo: "foto_archivo", habia: true }),
    "Se reemplazó la foto del afiliado. La anterior queda guardada."
  );
  assert.equal(
    observacionCambioAdjunto({ campo: "certificado_archivo", habia: false, nombreNuevo: "apto.pdf" }),
    "Se adjuntó el certificado médico «apto.pdf»."
  );
  assert.equal(observacionCambioAdjunto({ campo: "certificado_archivo", habia: false }), "Se adjuntó el certificado médico.");
  assert.equal(
    observacionCambioAdjunto({ campo: "certificado_archivo", habia: true, nombreAnterior: "viejo.pdf", nombreNuevo: "nuevo.pdf" }),
    "Se reemplazó el certificado médico «viejo.pdf» por «nuevo.pdf». El anterior queda guardado."
  );
  assert.equal(
    observacionCambioAdjunto({ campo: "certificado_archivo", habia: true }),
    "Se reemplazó el certificado médico por uno nuevo. El anterior queda guardado."
  );
  assert.equal(observacionCambioAdjunto({ campo: "firma_archivo", habia: true }), null);
  assert.doesNotMatch(observacionCambioAdjunto({ campo: "foto_archivo", habia: true }), /olimpiadas\//);
});

test("acompañantes: sólo cuenta como cambio si cambió alguna persona, sus datos o sus bonos", () => {
  // Lo guardado viene de la BD (tinyint, DATE como texto); lo nuevo, del normalizador más los bonos calculados
  const guardados = [
    { nombre: "Ana", apellido: "Staffa", documento: "40123456", fecha_nacimiento: "2015-05-05", vinculo: "Hijo/a", es_afiliado: 0, bonos: 6, bonos_manual: 0, observacion: null },
    { nombre: "Luis", apellido: "Gómez", documento: null, fecha_nacimiento: null, vinculo: null, es_afiliado: 1, bonos: 10, bonos_manual: 0, observacion: null },
  ];
  const mismos = guardados.map((a) => ({ ...a, es_afiliado: Number(a.es_afiliado), bonos_manual: Number(a.bonos_manual) }));
  assert.equal(mismosAcompaniantes(guardados, mismos), true);
  assert.equal(mismosAcompaniantes(guardados, [...mismos].reverse()), true); // el orden no es un cambio
  assert.equal(mismosAcompaniantes([], []), true);
  assert.equal(mismosAcompaniantes(guardados, mismos.slice(1)), false);
  assert.equal(mismosAcompaniantes(guardados, [{ ...mismos[0], nombre: "Anabel" }, mismos[1]]), false);
  assert.equal(mismosAcompaniantes(guardados, [{ ...mismos[0], fecha_nacimiento: "2015-05-06" }, mismos[1]]), false);
  assert.equal(mismosAcompaniantes(guardados, [{ ...mismos[0], bonos: 4, bonos_manual: 1 }, mismos[1]]), false);
  assert.equal(mismosAcompaniantes(guardados, [mismos[0], { ...mismos[1], observacion: "DT" }]), false);
});
