const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

const router = require("../api/routes/olimpiadas");
const {
  ESTADOS_EDICION,
  MENSAJE_FORMATO_FOTO,
  NOMBRES_CAMPOS_INSCRIPCION,
  avisoAltaPorStaff,
  avisoEdicionAfiliado,
  calcularEstadoEdicion,
  conservarBonosManuales,
  documentacionCompleta,
  estadoInicialInscripcion,
  formatoFotoValido,
  mensajeAltaInscripcion,
  mensajeEdicionInscripcion,
  mismosAcompaniantes,
  mismosIds,
  nombreArchivoOriginal,
  normalizarAcompaniantes,
  observacionCambioAdjunto,
  permisosInscripcion,
  resumenAltaInscripcion,
  textoCamposCambiados,
  textoComparable,
  textoCupo,
  textoResumenAcompaniantes,
  transicionPermitida,
  validarDatosOlimpiada,
  versionInscripcion,
} = router.__test;

// ---------------------------------------------------------------------------
// Estado inicial de la inscripción (§1.3 del contrato)
// ---------------------------------------------------------------------------
test("estado inicial: el afiliado siempre nace PENDIENTE: la aprobación es obligatoria", () => {
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

// La aprobación del afiliado es obligatoria en todas las ediciones (Solución A): el interruptor viejo
// requiere_aprobacion no se lee del body y la edición siempre lo guarda en 1.
test("edición de la olimpiada: requiere_aprobacion no se lee del body y se guarda siempre en 1", () => {
  const datos = {
    nombre: "Olimpiadas 2027", fecha_inicio: "2027-10-10", fecha_fin: "2027-10-12",
    fecha_inicio_inscripcion: "2027-08-01", fecha_fin_inscripcion: "2027-10-09",
    disciplinas: [{ disciplina_id: 1, max_por_departamental: 10 }],
  };
  for (const valor of [undefined, 0, "0", 1, "1", "x", false]) {
    for (const nueva of [true, false]) {
      const resultado = validarDatosOlimpiada({ ...datos, requiere_aprobacion: valor }, { nueva });
      assert.equal(resultado.error, undefined, `${valor} (${nueva ? "alta" : "edición"})`);
      assert.equal(resultado.value.opcionales.requiere_aprobacion, 1, `${valor} (${nueva ? "alta" : "edición"})`);
    }
  }
  // Las otras banderas se siguen validando
  assert.match(validarDatosOlimpiada({ ...datos, exigir_bonos_para_validar: "x" }).error, /exigir_bonos_para_validar debe ser 1 o 0/);
  assert.equal(validarDatosOlimpiada({ ...datos, exigir_bonos_para_validar: 0 }).value.opcionales.exigir_bonos_para_validar, 0);
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

// ---------------------------------------------------------------------------
// «Guardar cambios»: qué es un cambio real
// ---------------------------------------------------------------------------
test("acompañantes: los bonos calculados, el documento con puntos y el vínculo vacío no son un cambio", () => {
  const guardado = {
    nombre: "Ana", apellido: "Staffa", documento: "40.123.456", fecha_nacimiento: "2015-05-05",
    vinculo: null, es_afiliado: 0, bonos: 4, bonos_manual: 0, observacion: null,
  };
  // Como lo reenvía el formulario: documento sólo con dígitos, vínculo «Otro» y sin bonos (los calcula el servidor)
  const reenviado = { ...guardado, documento: "40123456", vinculo: "Otro", bonos: null };
  assert.equal(mismosAcompaniantes([guardado], [reenviado]), true);
  assert.equal(mismosAcompaniantes([guardado], [{ ...reenviado, bonos: 6 }]), true); // los tramos cambiaron después
  assert.equal(mismosAcompaniantes([guardado], [{ ...reenviado, vinculo: "" }]), true);
  assert.equal(mismosAcompaniantes([{ ...guardado, nombre: " Ana " }], [reenviado]), true); // espacios en los extremos
  assert.equal(mismosAcompaniantes([{ ...guardado, observacion: "Celíaca\nSin TACC" }], [{ ...reenviado, observacion: "Celíaca\r\nSin TACC" }]), true);
  // Los cambios de verdad siguen contando
  assert.equal(mismosAcompaniantes([guardado], [{ ...reenviado, documento: "40123457" }]), false);
  assert.equal(mismosAcompaniantes([guardado], [{ ...reenviado, vinculo: "Hijo/a" }]), false);
  assert.equal(mismosAcompaniantes([guardado], [{ ...reenviado, nombre: "ana" }]), false);
  assert.equal(mismosAcompaniantes([guardado], [{ ...reenviado, es_afiliado: 1 }]), false);
  // Bonos fijados a mano: cuentan la marca y el valor
  const manual = { ...guardado, bonos: 3, bonos_manual: 1 };
  assert.equal(mismosAcompaniantes([manual], [{ ...reenviado, bonos: 3, bonos_manual: 1 }]), true);
  assert.equal(mismosAcompaniantes([manual], [{ ...reenviado, bonos: 5, bonos_manual: 1 }]), false);
  assert.equal(mismosAcompaniantes([manual], [reenviado]), false); // sin el ajuste: vuelve al cálculo por edad
});

test("acompañantes: el afiliado conserva los bonos que el staff fijó a mano mientras no cambie esos datos", () => {
  const guardados = [
    { nombre: "Ana", apellido: "Staffa", documento: "40.123.456", fecha_nacimiento: "2015-05-05", vinculo: null, es_afiliado: 0, bonos: 3, bonos_manual: 1, observacion: null },
    { nombre: "Luis", apellido: "Gómez", documento: null, fecha_nacimiento: null, vinculo: "Esposo/a", es_afiliado: 0, bonos: 6, bonos_manual: 0, observacion: null },
  ];
  // Lo que llega del afiliado (normalizarAcompaniantes sin permitirManual): nunca trae bonos
  const ana = { nombre: "Ana", apellido: "Staffa", documento: "40123456", fecha_nacimiento: "2015-05-05", vinculo: "Otro", es_afiliado: 0, bonos: null, bonos_manual: 0, observacion: null };
  const luis = { nombre: "Luis", apellido: "Gómez", documento: null, fecha_nacimiento: null, vinculo: "Esposo/a", es_afiliado: 0, bonos: null, bonos_manual: 0, observacion: null };

  const conservados = conservarBonosManuales(guardados, [luis, ana]);
  assert.deepEqual(conservados, [luis, { ...ana, bonos: 3, bonos_manual: 1 }]);
  assert.equal(mismosAcompaniantes(guardados, conservados), true);
  assert.equal(ana.bonos_manual, 0); // no modifica lo recibido

  // Con un dato cambiado, el ajuste no se aplica y la lista cuenta como cambio
  const cambiada = conservarBonosManuales(guardados, [{ ...ana, fecha_nacimiento: "2015-06-05" }, luis]);
  assert.equal(cambiada[0].bonos_manual, 0);
  assert.equal(mismosAcompaniantes(guardados, cambiada), false);

  // Cada ajuste se usa una sola vez: si se repite la persona, sólo una lo hereda
  assert.deepEqual(conservarBonosManuales(guardados, [ana, ana]).map((a) => a.bonos_manual), [1, 0]);
  assert.deepEqual(conservarBonosManuales([], [ana]), [ana]);
  assert.deepEqual(conservarBonosManuales(guardados, []), []);
  assert.deepEqual(conservarBonosManuales(null, null), []);
});

test("ids: disciplinas y antecedentes son el mismo conjunto sin importar el orden", () => {
  assert.equal(mismosIds([1, 2], [2, 1]), true);
  assert.equal(mismosIds(["4"], [4]), true);
  assert.equal(mismosIds([], []), true);
  assert.equal(mismosIds(null, []), true);
  assert.equal(mismosIds([1], [1, 2]), false);
  assert.equal(mismosIds([1, 2], [1, 3]), false);
  assert.equal(mismosIds([1, 2], []), false);
});

test("textos: los saltos de línea y los espacios de los extremos no son un cambio", () => {
  assert.equal(textoComparable("Llego el sábado\r\nSin auto"), textoComparable("Llego el sábado\nSin auto"));
  assert.equal(textoComparable("a\rb"), "a\nb");
  assert.equal(textoComparable("  12/8 "), "12/8");
  assert.equal(textoComparable(null), "");
  assert.equal(textoComparable(undefined), "");
  assert.equal(textoComparable(""), "");
  assert.equal(textoComparable(2), "2"); // grupo sanguíneo
  assert.notEqual(textoComparable("Llego el sábado"), textoComparable("Llego el domingo"));
  assert.notEqual(textoComparable("Sin\nauto"), textoComparable("Sin auto"));
});

test("cambios: se nombran como en el formulario y en su orden, sin el estado", () => {
  assert.equal(textoCamposCambiados(["foto_archivo"]), "la foto");
  assert.equal(textoCamposCambiados(["foto_archivo", "disciplinas"]), "las disciplinas y la foto");
  assert.equal(
    textoCamposCambiados(["certificado_archivo", "categoria_tipo_id", "acompaniantes"]),
    "la categoría, los acompañantes y el certificado médico"
  );
  assert.equal(textoCamposCambiados(["tension_arterial", "estado"]), "la presión arterial");
  assert.equal(textoCamposCambiados(["datos_sanitarios", "datos_sanitarios"]), "los antecedentes de salud");
  assert.equal(textoCamposCambiados(["estado"]), "");
  assert.equal(textoCamposCambiados([]), "");
  assert.equal(textoCamposCambiados(undefined), "");
  // Cada campo que puede cambiar «Guardar cambios» tiene nombre, y ninguno es un código
  const campos = [
    "categoria_tipo_id", "disciplinas", "acompaniantes", "tension_arterial", "grupo_sanguineo_id", "lugar_trabajo",
    "datos_sanitarios", "detalle_medico", "detalle_alimentario", "observaciones", "foto_archivo", "certificado_archivo", "firma_archivo",
  ];
  assert.deepEqual(NOMBRES_CAMPOS_INSCRIPCION.map(([campo]) => campo), campos);
  for (const campo of campos) assert.doesNotMatch(textoCamposCambiados([campo]), /^$|_/, campo);
});

test("aviso al staff: quién, qué cambió y si la inscripción volvió a revisión", () => {
  assert.deepEqual(avisoEdicionAfiliado({ inscripcionId: 11, persona: "Pérez, Ana", campos: ["foto_archivo", "disciplinas"], volvioARevision: true }), {
    titulo: "Inscripción #11 actualizada y de vuelta en revisión",
    mensaje: "Pérez, Ana cambió las disciplinas y la foto de su inscripción aprobada. Volvió a «En revisión»: revisá los cambios y aprobala de nuevo para que pueda descargar el gafete.",
  });
  assert.deepEqual(avisoEdicionAfiliado({ inscripcionId: 11, persona: "Pérez, Ana", campos: ["tension_arterial"], volvioARevision: false }), {
    titulo: "Inscripción #11 actualizada",
    mensaje: "Pérez, Ana cambió la presión arterial de su inscripción.",
  });
  // Sin nombre (no debería pasar) o sin campos con nombre
  assert.match(
    avisoEdicionAfiliado({ inscripcionId: 11, persona: null, campos: ["tension_arterial"], volvioARevision: true }).mensaje,
    /^El afiliado cambió la presión arterial de su inscripción aprobada\./
  );
  assert.equal(
    avisoEdicionAfiliado({ inscripcionId: 11, persona: "Pérez, Ana", campos: [], volvioARevision: false }).mensaje,
    "Pérez, Ana cambió algunos datos de su inscripción."
  );
});

test("respuesta de «Guardar cambios»: dice si había cambios y cómo queda la inscripción", () => {
  const casos = [
    [{ actorEsStaff: false, huboCambios: false, volvioARevision: false, estado: "VALIDADO" }, "No había cambios para guardar: tu inscripción sigue aprobada."],
    [{ actorEsStaff: false, huboCambios: false, volvioARevision: false, estado: "PENDIENTE" }, "No había cambios para guardar: tu inscripción sigue en revisión."],
    [{ actorEsStaff: false, huboCambios: true, volvioARevision: false, estado: "PENDIENTE" }, "Guardamos los cambios. Tu inscripción sigue en revisión: te avisamos cuando tu departamental la apruebe."],
    [{ actorEsStaff: false, huboCambios: true, volvioARevision: true, estado: "PENDIENTE" }, "Guardamos los cambios. Tu inscripción volvió a «En revisión»: vas a poder descargar el gafete cuando tu departamental la apruebe de nuevo."],
    [{ actorEsStaff: true, huboCambios: true, volvioARevision: false, estado: "VALIDADO" }, "Inscripción actualizada"],
    [{ actorEsStaff: true, huboCambios: false, volvioARevision: false, estado: "VALIDADO" }, "No había cambios para guardar."],
  ];
  for (const [datos, texto] of casos) assert.equal(mensajeEdicionInscripcion(datos), texto, JSON.stringify(datos));
});

test("versión: cambia con el estado o con algo del formulario; los bonos calculados y la forma de leerla, no", () => {
  const fila = {
    estado: "VALIDADO", categoria_tipo_id: 1, grupo_sanguineo_id: 2, tension_arterial: "12/8", detalle_medico: null,
    detalle_alimentario: null, observaciones: "Llego el sábado", lugar_trabajo: null,
    foto_archivo: "olimpiadas/inscripciones/foto_1.png", certificado_archivo: null, firma_archivo: null,
  };
  const ana = { nombre: "Ana", apellido: "Staffa", documento: "40123456", fecha_nacimiento: "2015-05-05", vinculo: "Hijo/a", es_afiliado: 0, bonos: 4, bonos_manual: 0, observacion: null };
  const luis = { nombre: "Luis", apellido: "Gómez", documento: null, fecha_nacimiento: null, vinculo: null, es_afiliado: 0, bonos: 3, bonos_manual: 1, observacion: null };
  const guardada = { disciplinaIds: [4, 5], datoSanitarioIds: [1], acompaniantes: [ana, luis] };
  const version = versionInscripcion(fila, guardada);
  assert.match(version, /^[0-9a-f]{16}$/);
  // Como la arma el detalle (GET): con columnas de más, los bonos recalculados con las reglas vigentes y otro orden.
  // Tiene que dar lo mismo que en el PUT, que lee las filas guardadas.
  assert.equal(versionInscripcion(
    { ...fila, olimpiada_nombre: "Olimpiadas 2027", afiliado_apellido: "Pérez", categoria_tipo_id: "1" },
    { disciplinaIds: [5, 4], datoSanitarioIds: [1], acompaniantes: [{ ...luis, id: 9, edad: 40 }, { ...ana, id: 8, edad: 11, bonos: 6 }] }
  ), version);
  // Lo que otra persona puede cambiar mientras el formulario está abierto la cambia
  const distintas = [
    versionInscripcion({ ...fila, estado: "PENDIENTE" }, guardada), // la aprobaron o la devolvieron a revisión
    versionInscripcion({ ...fila, tension_arterial: "13/8" }, guardada),
    versionInscripcion({ ...fila, grupo_sanguineo_id: 3 }, guardada),
    versionInscripcion({ ...fila, categoria_tipo_id: 2 }, guardada),
    versionInscripcion({ ...fila, observaciones: null }, guardada),
    versionInscripcion({ ...fila, certificado_archivo: "olimpiadas/inscripciones/certificado_2.pdf" }, guardada),
    versionInscripcion(fila, { ...guardada, disciplinaIds: [4] }),
    versionInscripcion(fila, { ...guardada, datoSanitarioIds: [] }),
    versionInscripcion(fila, { ...guardada, acompaniantes: [ana] }),
    versionInscripcion(fila, { ...guardada, acompaniantes: [{ ...ana, vinculo: "Pareja" }, luis] }),
    versionInscripcion(fila, { ...guardada, acompaniantes: [ana, { ...luis, bonos: 5 }] }), // bonos fijados a mano
  ];
  for (const [indice, otra] of distintas.entries()) assert.notEqual(otra, version, `caso ${indice}`);
});
