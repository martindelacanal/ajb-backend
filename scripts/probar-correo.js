/**
 * Diagnóstico del módulo de correo automático.
 *
 *   node scripts/probar-correo.js                      -> verifica y envía a MAIL_TEST_TO
 *   node scripts/probar-correo.js alguien@dominio.com  -> verifica y envía a esa casilla
 *   node scripts/probar-correo.js --solo-verificar     -> solo prueba credenciales (no envía)
 *
 * El correo de prueba ejercita todo lo que puede fallar en un cliente real:
 * asunto con acentos, alternativa en texto plano, HTML con estilos en línea,
 * imagen embebida (cid:), archivo adjunto y botón enlazado.
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  cerrarTransporte,
  enviarCorreoPlantilla,
  estadoCorreo,
  urlAplicacion,
  verificarCorreo,
} = require("../api/services/correo");
const { RUTA_LOGO } = require("../api/services/correo/plantilla");

const soloVerificar = process.argv.includes("--solo-verificar");
const destino = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || process.env.MAIL_TEST_TO || "";

function marcaDeTiempo() {
  return new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
}

async function main() {
  console.log("Configuración SMTP en uso:");
  const estado = estadoCorreo();
  // En SES el usuario SMTP es un identificador de acceso; no hace falta publicarlo.
  delete estado.usuario;
  console.table(estado);

  console.log("\n1) Verificando credenciales y conectividad (EHLO + AUTH)...");
  const verificacion = await verificarCorreo();
  if (!verificacion.conectado) {
    console.error("   ✗ No se pudo autenticar contra el servidor.");
    console.error("     motivo:", verificacion.motivo, "| código:", verificacion.codigo);
    console.error("     detalle:", verificacion.error || "(sin detalle)");
    process.exitCode = 1;
    return;
  }
  console.log("   ✓ Conexión y credenciales correctas.");

  if (soloVerificar) return;

  if (!destino) {
    console.error("\nFalta el destinatario: pasalo como argumento o definí MAIL_TEST_TO en el .env.");
    process.exitCode = 1;
    return;
  }

  console.log(`\n2) Enviando correo de prueba a ${destino}...`);
  const resultado = await enviarCorreoPlantilla({
    para: destino,
    asunto: "Prueba de correo automático · Mi AJB",
    titulo: "El envío automático funciona",
    previsualizacion: "Si ves este mensaje con el logo y el botón, el módulo de correo quedó operativo.",
    saludo: "Hola,",
    parrafos: [
      "Este es un correo de prueba generado por el backend de Mi AJB para validar el envío automático de notificaciones.",
      "Incluye acentos y eñes (ñ, á, é, í, ó, ú, ü) para confirmar que la codificación UTF-8 llega intacta, una imagen embebida en el encabezado, un archivo adjunto y una versión en texto plano para clientes que no muestran HTML.",
    ],
    datos: [
      { etiqueta: "Servidor", valor: `${process.env.MAIL_HOST}:${process.env.MAIL_PORT}` },
      { etiqueta: "Remitente", valor: process.env.MAIL_FROM || process.env.MAIL_USER },
      { etiqueta: "Destinatario", valor: destino },
      { etiqueta: "Fecha y hora", valor: marcaDeTiempo() },
    ],
    boton: { texto: "Ir a Mi AJB", url: urlAplicacion("/home") },
    aviso: "Si el logo del encabezado se ve correctamente, las imágenes embebidas (cid:) no requieren que el destinatario habilite la descarga de imágenes externas.",
    pie: ["Mensaje generado por scripts/probar-correo.js"],
    adjuntos: [{ filename: "adjunto-de-prueba.png", path: RUTA_LOGO }],
  });

  if (!resultado.enviado) {
    console.error("   ✗ El envío falló.");
    console.error("     motivo:", resultado.motivo, "| código:", resultado.codigo);
    console.error("     detalle:", resultado.error || "(sin detalle)");
    process.exitCode = 1;
    return;
  }

  console.log("   ✓ Correo aceptado por el servidor.");
  console.log("     messageId :", resultado.messageId);
  console.log("     aceptados :", resultado.aceptados.join(", ") || "(ninguno)");
  console.log("     rechazados:", resultado.rechazados.join(", ") || "(ninguno)");
  console.log("     respuesta :", resultado.respuesta.trim());
}

main()
  .catch((error) => {
    console.error("Error inesperado:", error);
    process.exitCode = 1;
  })
  .finally(cerrarTransporte);
