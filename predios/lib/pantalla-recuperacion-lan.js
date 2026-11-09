"use strict";

function esNavegacion(req, ruta) {
  return req.method === "GET" && ruta !== "/api" && !ruta.startsWith("/api/") &&
    (ruta === "/" || /\btext\/html\b/i.test(req.headers.accept || ""));
}

function paginaRecuperacion({ estado = {}, mensaje } = {}) {
  const escapar = texto => String(texto).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const conocido = estado.testigo;
  let ayuda = "Encendé la notebook principal y las PCs de respaldo y dejalas conectadas a la red del camping.";
  if (conocido?.solo_principal) {
    ayuda = "La última configuración conocida dejaba a la notebook como único servidor. Encendé la notebook principal y dejala conectada a la red.";
  } else if (Array.isArray(conocido?.votantes) && conocido.votantes.length >= 3) {
    const necesarias = Math.floor(conocido.votantes.length / 2) + 1;
    ayuda = `Según la última configuración conocida, hacen falta al menos ${necesarias} PCs del grupo encendidas y conectadas entre sí.`;
  }
  const revision = estado.confirmada?.indice;
  const copia = Number.isSafeInteger(revision) && revision >= 0
    ? `<p>Esta PC guarda la revisión ${revision}. El grupo debe verificar que sea la más reciente antes de habilitar ventas.</p>`
    : "<p>Esta PC todavía no pudo verificar qué copia debe utilizar.</p>";
  const detalle = String(mensaje || estado.error || "Esperando que el grupo confirme un servidor disponible.").slice(0, 400);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="5"><title>Recuperando el sistema del camping</title>
    <style>body{font:1rem system-ui;max-width:38rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#202b36;background:#f4f6f8}
    main{background:white;padding:1.5rem;border-radius:1rem}h1{font-size:1.5rem}a{display:inline-block;padding:.7rem 1rem;background:#174c73;color:white;border-radius:.5rem;text-decoration:none}.detalle{overflow-wrap:anywhere;color:#536271}</style></head>
    <body><main><h1>El sistema está recuperando la conexión</h1>
    <p role="status">${escapar(ayuda)}</p>
    <p>Esta página vuelve a comprobar el acceso cada 5 segundos y abrirá el sistema cuando haya un servidor disponible.</p>
    ${copia}<p class="detalle">${escapar(detalle)}</p>
    <a href="">Reintentar ahora</a></main></body></html>`;
}

module.exports = { esNavegacion, paginaRecuperacion };
