const ORIGENES_PREDETERMINADOS = Object.freeze([
  "https://d2bnjhvusxwgza.cloudfront.net",
  "http://localhost:4200",
  "http://127.0.0.1:4200",
]);

function normalizarOrigen(valor) {
  const texto = String(valor || "").trim();
  if (!texto || texto === "*") {
    return null;
  }

  try {
    const url = new URL(texto);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch (_error) {
    return null;
  }
}

function obtenerOrigenesPermitidos(valor = process.env.CORS_ALLOWED_ORIGINS) {
  if (!valor && process.env.NODE_ENV === "production") {
    throw new Error("CORS_ALLOWED_ORIGINS es obligatorio en produccion");
  }
  const entradas = valor
    ? String(valor).split(",")
    : ORIGENES_PREDETERMINADOS;
  const origenes = new Set();

  for (const entrada of entradas) {
    const origen = normalizarOrigen(entrada);
    if (!origen) {
      throw new Error(`Origen CORS invalido: ${String(entrada || "(vacio)")}`);
    }
    origenes.add(origen);
  }

  if (origenes.size === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS no contiene ningun origen valido");
  }

  return origenes;
}

function crearValidadorCors(origenes) {
  return (origen, callback) => {
    // Clientes no navegador (health checks, CLI y servidor a servidor) no envian Origin.
    if (!origen || origenes.has(normalizarOrigen(origen))) {
      callback(null, true);
      return;
    }

    const error = new Error("Origen no permitido");
    error.code = "ORIGEN_CORS_NO_PERMITIDO";
    callback(error);
  };
}

module.exports = {
  ORIGENES_PREDETERMINADOS,
  normalizarOrigen,
  obtenerOrigenesPermitidos,
  crearValidadorCors,
};
