"use strict";

/**
 * Plantilla base de los correos de Mi AJB.
 *
 * El HTML es deliberadamente "antiguo" (tablas, atributos de presentación y
 * estilos en línea) porque Outlook, Gmail y las apps móviles descartan hojas de
 * estilo, flexbox y grid. El logo viaja como adjunto embebido (cid:) en lugar de
 * una URL remota para que se vea aunque el cliente bloquee imágenes externas.
 */

const path = require("path");

const RUTA_LOGO = path.join(__dirname, "assets", "logo-ajb.png");
const CID_LOGO = "logo-ajb";

const COLOR = Object.freeze({
  celeste: "#0097de",
  celesteOscuro: "#0b6f9e",
  tinta: "#12324a",
  texto: "#3d566b",
  suave: "#eef5fa",
  borde: "#dbe6ee",
  fondo: "#f1f5f8",
  blanco: "#ffffff",
  tenue: "#7d94a6",
});

const FUENTE = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const ESCAPES_HTML = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

const ENTIDADES = Object.freeze({
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
});

function escaparHtml(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (caracter) => ESCAPES_HTML[caracter]);
}

/** Solo se aceptan esquemas navegables: evita javascript: y data: en los botones. */
function urlSegura(valor) {
  const limpio = String(valor ?? "").trim();
  if (!limpio) return "";
  return /^(https?:\/\/|mailto:)/i.test(limpio) ? limpio : "";
}

function comoLista(valor) {
  if (valor === null || valor === undefined || valor === "") return [];
  return Array.isArray(valor)
    ? valor.filter((item) => item !== null && item !== undefined && item !== "")
    : [valor];
}

/** Fallback de texto plano cuando quien llama solo aporta HTML. */
function textoPlanoDesdeHtml(html) {
  return String(html ?? "")
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h1|h2|h3|li|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_todo, codigo) => String.fromCharCode(Number(codigo)))
    .replace(/&[a-z]+;/gi, (entidad) => ENTIDADES[entidad.toLowerCase()] ?? entidad)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bloqueParrafo(texto) {
  return `<p style="margin:0 0 16px;font-family:${FUENTE};font-size:16px;line-height:1.6;color:${COLOR.texto};">${escaparHtml(texto)}</p>`;
}

function bloqueDatos(datos) {
  const filas = datos
    .filter((dato) => dato && dato.etiqueta)
    .map((dato, indice) => {
      const borde = indice === 0 ? "none" : `1px solid ${COLOR.borde}`;
      return `<tr>
              <td style="padding:10px 16px;border-top:${borde};font-family:${FUENTE};font-size:13px;line-height:1.4;color:${COLOR.tenue};text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;">${escaparHtml(dato.etiqueta)}</td>
              <td align="right" style="padding:10px 16px;border-top:${borde};font-family:${FUENTE};font-size:15px;line-height:1.5;color:${COLOR.tinta};font-weight:600;">${escaparHtml(dato.valor ?? "")}</td>
            </tr>`;
    })
    .join("");

  if (!filas) return "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background-color:${COLOR.suave};border:1px solid ${COLOR.borde};border-radius:10px;border-collapse:separate;">
            ${filas}
          </table>`;
}

function bloqueBoton(boton) {
  const url = urlSegura(boton?.url);
  const texto = String(boton?.texto ?? "").trim();
  if (!url || !texto) return "";

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;">
            <tr>
              <td align="center" bgcolor="${COLOR.celeste}" style="border-radius:10px;">
                <a href="${escaparHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-family:${FUENTE};font-size:16px;font-weight:700;line-height:1;color:${COLOR.blanco};text-decoration:none;border-radius:10px;">${escaparHtml(texto)}</a>
              </td>
            </tr>
          </table>`;
}

function bloqueAviso(aviso) {
  if (!aviso) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
            <tr>
              <td style="padding:14px 18px;background-color:${COLOR.suave};border-left:4px solid ${COLOR.celeste};border-radius:0 8px 8px 0;font-family:${FUENTE};font-size:14px;line-height:1.6;color:${COLOR.tinta};">${escaparHtml(aviso)}</td>
            </tr>
          </table>`;
}

/**
 * Construye el correo completo a partir de piezas de contenido.
 *
 * @param {object} opciones
 * @param {string} opciones.titulo             Encabezado principal.
 * @param {string} [opciones.previsualizacion] Texto que la bandeja muestra junto al asunto.
 * @param {string} [opciones.saludo]           Ej: "Hola, María".
 * @param {string|string[]} [opciones.parrafos]
 * @param {{etiqueta:string, valor:string}[]} [opciones.datos] Ficha de datos.
 * @param {{texto:string, url:string}} [opciones.boton]
 * @param {string} [opciones.aviso]            Recuadro destacado.
 * @param {string|string[]} [opciones.pie]     Líneas extra del pie.
 * @param {boolean} [opciones.incluirLogo=true]
 * @returns {{html:string, texto:string, adjuntos:object[]}}
 */
function construirCorreoHtml({
  titulo = "",
  previsualizacion = "",
  saludo = "",
  parrafos = [],
  datos = [],
  boton = null,
  aviso = "",
  pie = [],
  incluirLogo = true,
} = {}) {
  const lineasPie = comoLista(pie);
  const adjuntos = incluirLogo
    ? [{ filename: "logo-ajb.png", path: RUTA_LOGO, cid: CID_LOGO, contentDisposition: "inline" }]
    : [];

  const encabezado = incluirLogo
    ? `<img src="cid:${CID_LOGO}" width="190" alt="Mi Asociación Judicial Bonaerense" style="display:block;width:190px;max-width:70%;height:auto;border:0;outline:none;text-decoration:none;" />`
    : `<span style="font-family:${FUENTE};font-size:22px;font-weight:700;color:${COLOR.tinta};">Mi AJB</span>`;

  const cuerpo = [
    titulo
      ? `<h1 style="margin:0 0 18px;font-family:${FUENTE};font-size:24px;line-height:1.3;color:${COLOR.tinta};font-weight:700;">${escaparHtml(titulo)}</h1>`
      : "",
    saludo ? bloqueParrafo(saludo) : "",
    comoLista(parrafos).map(bloqueParrafo).join(""),
    bloqueDatos(comoLista(datos)),
    bloqueBoton(boton),
    bloqueAviso(aviso),
  ].join("");

  const piePersonalizado = lineasPie
    .map(
      (linea) =>
        `<p style="margin:0 0 8px;font-family:${FUENTE};font-size:12px;line-height:1.6;color:${COLOR.tenue};">${escaparHtml(linea)}</p>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escaparHtml(titulo || "Mi AJB")}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLOR.fondo};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${escaparHtml(previsualizacion)}&#8203;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.fondo};">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${COLOR.blanco};border-radius:14px;">
        <tr>
          <td align="center" style="padding:28px 32px 22px;background-color:${COLOR.blanco};border-bottom:4px solid ${COLOR.celeste};border-radius:14px 14px 0 0;">
            ${encabezado}
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 12px;background-color:${COLOR.blanco};">
            ${cuerpo}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px 28px;background-color:${COLOR.suave};border-top:1px solid ${COLOR.borde};border-radius:0 0 14px 14px;">
            ${piePersonalizado}
            <p style="margin:0 0 6px;font-family:${FUENTE};font-size:12px;line-height:1.6;color:${COLOR.tenue};">Este es un mensaje automático de <strong style="color:${COLOR.celesteOscuro};">Mi AJB</strong>. Por favor, no respondas a esta dirección.</p>
            <p style="margin:0;font-family:${FUENTE};font-size:12px;line-height:1.6;color:${COLOR.tenue};">Asociación Judicial Bonaerense &middot; ajb.org.ar</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const textoPlano = [
    titulo,
    saludo,
    ...comoLista(parrafos),
    ...comoLista(datos)
      .filter((dato) => dato && dato.etiqueta)
      .map((dato) => `${dato.etiqueta}: ${dato.valor ?? ""}`),
    boton && urlSegura(boton.url) ? `${boton.texto}: ${urlSegura(boton.url)}` : "",
    aviso,
    ...lineasPie,
    "---",
    "Este es un mensaje automático de Mi AJB. Por favor, no respondas a esta dirección.",
    "Asociación Judicial Bonaerense · ajb.org.ar",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { html, texto: textoPlano, adjuntos };
}

module.exports = {
  CID_LOGO,
  COLOR,
  RUTA_LOGO,
  construirCorreoHtml,
  escaparHtml,
  textoPlanoDesdeHtml,
  urlSegura,
};
