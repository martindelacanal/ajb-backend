const DIA_EN_MS = 24 * 60 * 60 * 1000;
const MAX_DINERO_CENTAVOS = 999_999_999_999;
const FECHA_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_RE = /^\+?(\d+)(?:[.,](\d{1,2}))?$/;

function normalizarFechaCivil(valor) {
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const anio = valor.getUTCFullYear();
    const mes = String(valor.getUTCMonth() + 1).padStart(2, "0");
    const dia = String(valor.getUTCDate()).padStart(2, "0");
    return `${anio}-${mes}-${dia}`;
  }

  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  const coincidencia = FECHA_ISO_RE.exec(texto);
  if (!coincidencia) return null;

  const anio = Number(coincidencia[1]);
  const mes = Number(coincidencia[2]);
  const dia = Number(coincidencia[3]);
  const fechaUtc = new Date(Date.UTC(anio, mes - 1, dia));

  if (
    fechaUtc.getUTCFullYear() !== anio ||
    fechaUtc.getUTCMonth() !== mes - 1 ||
    fechaUtc.getUTCDate() !== dia
  ) {
    return null;
  }

  return texto;
}

function obtenerFechaCivilArgentina(ahora = new Date()) {
  const instante = ahora instanceof Date ? ahora : new Date(ahora);
  if (Number.isNaN(instante.getTime())) return null;
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instante);
  const porTipo = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return normalizarFechaCivil(`${porTipo.year}-${porTipo.month}-${porTipo.day}`);
}

function validarRangoReservaTemporal(fechaInicio, fechaFin, {
  hoy = obtenerFechaCivilArgentina(),
  rangoExistente = null,
} = {}) {
  const inicio = normalizarFechaCivil(fechaInicio);
  const fin = normalizarFechaCivil(fechaFin);
  const fechaHoy = normalizarFechaCivil(hoy);
  if (!inicio || !fin || !fechaHoy || inicio >= fin) {
    return { valido: false, codigo: "RANGO_INVALIDO" };
  }
  if (inicio >= fechaHoy) {
    return { valido: true, conservaRangoPasado: false };
  }

  const inicioExistente = normalizarFechaCivil(rangoExistente?.fecha_inicio);
  const finExistente = normalizarFechaCivil(rangoExistente?.fecha_fin);
  if (inicio === inicioExistente && fin === finExistente) {
    return { valido: true, conservaRangoPasado: true };
  }
  return { valido: false, codigo: "FECHA_INICIO_PASADA" };
}

function fechaCivilAIndice(valor) {
  const fecha = normalizarFechaCivil(valor);
  if (!fecha) return null;
  const [anio, mes, dia] = fecha.split("-").map(Number);
  return Math.trunc(Date.UTC(anio, mes - 1, dia) / DIA_EN_MS);
}

function indiceAFechaCivil(indice) {
  if (!Number.isSafeInteger(indice)) return null;
  return new Date(indice * DIA_EN_MS).toISOString().slice(0, 10);
}

function sumarDiasFechaCivil(valor, dias) {
  const indice = fechaCivilAIndice(valor);
  if (indice === null || !Number.isSafeInteger(dias)) return null;
  return indiceAFechaCivil(indice + dias);
}

function diferenciaDiasCivil(inicio, fin) {
  const indiceInicio = fechaCivilAIndice(inicio);
  const indiceFin = fechaCivilAIndice(fin);
  if (indiceInicio === null || indiceFin === null) return null;
  return indiceFin - indiceInicio;
}

function obtenerNochesReserva(inicio, fin, maximoNoches = 366) {
  const cantidad = diferenciaDiasCivil(inicio, fin);
  if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > maximoNoches) return [];

  const indiceInicio = fechaCivilAIndice(inicio);
  return Array.from({ length: cantidad }, (_, indice) => indiceAFechaCivil(indiceInicio + indice));
}

function calcularEdadEnFecha(fechaNacimiento, fechaReferencia) {
  const nacimiento = normalizarFechaCivil(fechaNacimiento);
  const referencia = normalizarFechaCivil(fechaReferencia);
  if (!nacimiento || !referencia || nacimiento > referencia) return null;

  const [anioNacimiento, mesNacimiento, diaNacimiento] = nacimiento.split("-").map(Number);
  const [anioReferencia, mesReferencia, diaReferencia] = referencia.split("-").map(Number);
  let edad = anioReferencia - anioNacimiento;
  if (
    mesReferencia < mesNacimiento ||
    (mesReferencia === mesNacimiento && diaReferencia < diaNacimiento)
  ) {
    edad -= 1;
  }

  return Number.isInteger(edad) && edad >= 0 && edad <= 130 ? edad : null;
}

function decimalACentavos(valor, {
  permiteCero = true,
  permiteNegativo = false,
  maximoCentavos = MAX_DINERO_CENTAVOS,
} = {}) {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor === "number" && !Number.isFinite(valor)) return null;

  const texto = String(valor).trim();
  const negativo = texto.startsWith("-");
  if (negativo && !permiteNegativo) return null;
  const textoAbsoluto = negativo ? texto.slice(1) : texto;
  const coincidencia = DECIMAL_RE.exec(textoAbsoluto);
  if (!coincidencia) return null;

  const enteros = BigInt(coincidencia[1]);
  const decimales = BigInt((coincidencia[2] || "").padEnd(2, "0"));
  let centavos = enteros * 100n + decimales;
  if (negativo) centavos = -centavos;

  if (!Number.isSafeInteger(maximoCentavos) || maximoCentavos < 0) return null;
  const limite = BigInt(maximoCentavos);
  if (centavos > limite || centavos < -limite) return null;

  const resultado = Number(centavos);
  if (!permiteCero && resultado === 0) return null;
  return resultado;
}

function centavosADecimal(centavos) {
  if (!Number.isSafeInteger(centavos) || Math.abs(centavos) > MAX_DINERO_CENTAVOS) return null;
  const negativo = centavos < 0 ? "-" : "";
  const absoluto = Math.abs(centavos);
  return `${negativo}${Math.trunc(absoluto / 100)}.${String(absoluto % 100).padStart(2, "0")}`;
}

function centavosANumero(centavos) {
  const decimal = centavosADecimal(centavos);
  return decimal === null ? null : Number(decimal);
}

function decimalAPuntosBase(valor, { minimo = 0, maximo = 100 } = {}) {
  const puntosBase = decimalACentavos(valor, { permiteCero: true, permiteNegativo: minimo < 0 });
  if (puntosBase === null || puntosBase < minimo * 100 || puntosBase > maximo * 100) return null;
  return puntosBase;
}

function dividirRedondeandoPositivo(numerador, denominador) {
  if (numerador < 0n || denominador <= 0n) {
    throw new RangeError("La division monetaria requiere valores positivos");
  }
  return (numerador + denominador / 2n) / denominador;
}

function aplicarDescuentoEnPuntosBase(centavos, puntosBase) {
  if (!Number.isSafeInteger(centavos) || centavos < 0 || centavos > MAX_DINERO_CENTAVOS) return null;
  if (!Number.isInteger(puntosBase) || puntosBase < 0 || puntosBase > 10000) return null;

  const resultado = dividirRedondeandoPositivo(
    BigInt(centavos) * BigInt(10000 - puntosBase),
    10000n
  );
  return resultado <= BigInt(MAX_DINERO_CENTAVOS) ? Number(resultado) : null;
}

function revertirDescuentoEnPuntosBase(centavos, puntosBase) {
  if (!Number.isSafeInteger(centavos) || centavos < 0 || centavos > MAX_DINERO_CENTAVOS) return null;
  if (!Number.isInteger(puntosBase) || puntosBase < 0 || puntosBase >= 10000) return null;

  const resultado = dividirRedondeandoPositivo(
    BigInt(centavos) * 10000n,
    BigInt(10000 - puntosBase)
  );
  return resultado <= BigInt(MAX_DINERO_CENTAVOS) ? Number(resultado) : null;
}

function sumarCentavos(...valores) {
  let total = 0;
  for (const valor of valores) {
    if (!Number.isSafeInteger(valor)) return null;
    total += valor;
    if (!Number.isSafeInteger(total) || Math.abs(total) > MAX_DINERO_CENTAVOS) return null;
  }
  return total;
}

function validarCuitCuil(valor) {
  if (typeof valor !== "string" || !/^\d{11}$/.test(valor)) return false;
  const multiplicadores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = multiplicadores.reduce(
    (total, multiplicador, indice) => total + Number(valor[indice]) * multiplicador,
    0
  );
  let verificador = 11 - (suma % 11);
  if (verificador === 11) verificador = 0;
  if (verificador === 10) verificador = 9;
  return verificador === Number(valor[10]);
}

function validarCbu(valor) {
  if (typeof valor !== "string" || !/^\d{22}$/.test(valor)) return false;
  const digitoVerificador = (cadena, pesos) => {
    const suma = [...cadena].reduce(
      (total, digito, indice) => total + Number(digito) * pesos[indice],
      0
    );
    return (10 - (suma % 10)) % 10;
  };
  return digitoVerificador(valor.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === Number(valor[7])
    && digitoVerificador(
      valor.slice(8, 21),
      [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]
    ) === Number(valor[21]);
}

module.exports = {
  DIA_EN_MS,
  MAX_DINERO_CENTAVOS,
  aplicarDescuentoEnPuntosBase,
  calcularEdadEnFecha,
  centavosADecimal,
  centavosANumero,
  decimalACentavos,
  decimalAPuntosBase,
  diferenciaDiasCivil,
  fechaCivilAIndice,
  indiceAFechaCivil,
  normalizarFechaCivil,
  obtenerFechaCivilArgentina,
  obtenerNochesReserva,
  revertirDescuentoEnPuntosBase,
  sumarCentavos,
  sumarDiasFechaCivil,
  validarCbu,
  validarCuitCuil,
  validarRangoReservaTemporal,
};
