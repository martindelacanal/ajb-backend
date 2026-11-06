"use strict";

// El asistente entrega la clave por stdin; nunca por argumentos, entorno o disco.
// Recuperar crea una carpeta detenida. No instala tareas ni acredita un escritor.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validarRespaldo, restaurarRespaldo, LIMITES } = require("./respaldo-local");

function resumen(manifest) {
  return { predio: manifest.predio_codigo || String(manifest.predio_id), predioId: manifest.predio_id,
    generado: manifest.generado, pendientes: manifest.pendientes.cantidad, version: manifest.version || "Sin informar" };
}

function ejecutarRecuperacion(datos) {
  if (!datos || typeof datos !== "object" || Array.isArray(datos) || !["validar", "restaurar"].includes(datos.accion)) throw new Error("Indicá si querés validar o recuperar el respaldo");
  if (typeof datos.archivo !== "string" || !datos.archivo || datos.archivo.length > 4096 || !/\.ajbrespaldo$/i.test(datos.archivo)) throw new Error("Elegí un archivo .ajbrespaldo");
  if (typeof datos.clave !== "string" || datos.clave.length < 12 || datos.clave.length > 1024) throw new Error("La clave de recuperación debe tener entre 12 y 1024 caracteres");
  const archivo = path.resolve(datos.archivo);
  const stat = fs.lstatSync(archivo);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITES.paquete) throw new Error("El respaldo debe ser un archivo regular dentro del tamaño permitido");
  const buffer = fs.readFileSync(archivo);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (datos.sha256Esperado !== undefined && (!/^[a-f0-9]{64}$/.test(datos.sha256Esperado) || datos.sha256Esperado !== sha256)) throw new Error("El archivo cambió después de validarlo. Volvé a seleccionarlo");
  if (datos.accion === "validar") {
    const manifest = validarRespaldo(buffer, { clave: datos.clave });
    return { valido: true, sha256, resumen: resumen(manifest) };
  }
  if (!datos.sha256Esperado) throw new Error("Validá el archivo antes de recuperarlo");
  if (typeof datos.destino !== "string" || !datos.destino || datos.destino.length > 4096) throw new Error("Elegí una carpeta nueva para la recuperación");
  const resultado = restaurarRespaldo(buffer, { clave: datos.clave, destino: datos.destino });
  return { recuperado: true, carpeta: resultado.carpeta, modo: resultado.modo, activacionRequerida: true, resumen: resumen(resultado.manifest),
    mensaje: "Recuperado en espera. Para reincorporar esta PC al grupo, usá el instalador de Respaldo con el testigo disponible." };
}

async function leerEntrada(stream) {
  const partes = []; let bytes = 0;
  for await (const parte of stream) {
    bytes += parte.length;
    if (bytes > 16384) throw new Error("Los datos de recuperación superan el tamaño permitido");
    partes.push(parte);
  }
  try { return JSON.parse(Buffer.concat(partes).toString("utf8").replace(/^\uFEFF/, "")); }
  catch (_e) { throw new Error("No se pudieron leer los datos de recuperación"); }
}

if (require.main === module) {
  (async () => {
    let entrada;
    try {
      entrada = await leerEntrada(process.stdin);
      const resultado = ejecutarRecuperacion(entrada);
      process.stdout.write(JSON.stringify(resultado));
    } finally { if (entrada && typeof entrada === "object") entrada.clave = ""; }
  })().catch(e => {
    // JSON.parse de V8 puede incluir fragmentos del input. Ese error se reemplaza
    // en leerEntrada; aquí sólo se muestran errores operativos sin la clave.
    process.stderr.write(JSON.stringify({ mensaje: e.message || "No se pudo recuperar el respaldo" }));
    process.exitCode = 1;
  });
}

module.exports = { ejecutarRecuperacion };
