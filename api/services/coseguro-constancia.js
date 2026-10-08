"use strict";

const path = require("node:path");
const PDFDocument = require("pdfkit");
const { decimalACentavos, normalizarFechaCivil } = require("./valores-dominio");

const LOGO_PATH = path.join(__dirname, "..", "assets", "ajb-logo.png");
const MARGEN = 42;
const NO_INFORMADO = "No informado";

function texto(valor) {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

function formatearFechaConstancia(valor) {
  // Las fechas SQL llegan como cadenas civiles con DATE_FORMAT. No convertirlas
  // a instantes, porque la zona horaria podría desplazarlas al día anterior.
  const fecha = normalizarFechaCivil(typeof valor === "string" ? valor.slice(0, 10) : valor);
  if (!fecha) return NO_INFORMADO;
  const [anio, mes, dia] = fecha.split("-");
  return `${dia}/${mes}/${anio}`;
}

function formatearImporteConstancia(valor) {
  const centavos = decimalACentavos(valor);
  if (centavos === null) return NO_INFORMADO;
  return (centavos / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatearNumeroComprobante(puntoVenta, numero) {
  const rellenar = (valor, largo) => {
    const limpio = texto(valor);
    return /^\d+$/.test(limpio) ? limpio.padStart(largo, "0") : limpio;
  };
  const punto = rellenar(puntoVenta, 4);
  const comprobante = rellenar(numero, 8);
  if (!comprobante) return NO_INFORMADO;
  return punto ? `${punto}-${comprobante}` : comprobante;
}

function datosConstanciaReintegro(solicitud) {
  const conceptos = Array.isArray(solicitud.conceptos)
    ? solicitud.conceptos.map((concepto) => texto(concepto.nombre)).filter(Boolean)
    : [];
  const domicilio = [solicitud.afiliado_direccion, solicitud.afiliado_dependencia_judicial]
    .map(texto).filter(Boolean).join(" / ");
  return {
    reintegro: [
      ["Tipo de Reintegro", texto(solicitud.tipo_reintegro) || NO_INFORMADO, true],
      ["Conceptos", conceptos.join(", ") || texto(solicitud.concepto) || NO_INFORMADO, true],
      ["Fecha de Aprobación", formatearFechaConstancia(solicitud.fecha_aprobacion_central_civil ?? solicitud.fecha_aprobacion_central), true],
      ["Importe", formatearImporteConstancia(solicitud.importe_autorizado), true],
      ["Fecha de Comprobante", formatearFechaConstancia(solicitud.fecha_comprobante_civil ?? solicitud.fecha_comprobante)],
      ["Nro de Comprobante", formatearNumeroComprobante(solicitud.comprobante_pto_venta, solicitud.comprobante_numero)],
      ["Emisor del Comprobante", texto(solicitud.emisor_nombre) || NO_INFORMADO],
      ["CUIT del Comprobante", texto(solicitud.emisor_cuit) || NO_INFORMADO],
    ],
    afiliado: [
      ["Nombre del Afiliado", [solicitud.afiliado_apellido, solicitud.afiliado_nombre].map(texto).filter(Boolean).join(" ") || NO_INFORMADO],
      ["DNI", texto(solicitud.afiliado_documento) || NO_INFORMADO],
      ["Legajo", texto(solicitud.afiliado_legajo) || NO_INFORMADO],
      ["Mail", texto(solicitud.afiliado_email) || NO_INFORMADO],
      ["Teléfono", texto(solicitud.afiliado_telefono) || NO_INFORMADO],
      ["Dirección/Oficina", domicilio],
      ["Departamental", texto(solicitud.departamental_nombre) || NO_INFORMADO],
    ],
  };
}

function generarConstanciaReintegro(solicitud) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGEN,
      info: {
        Title: `Constancia de reintegro #${solicitud.id}`,
        Author: "Asociación Judicial Bonaerense",
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const ancho = doc.page.width - MARGEN * 2;
      doc.image(LOGO_PATH, MARGEN, 31, { fit: [40, 40] });
      doc.font("Helvetica-Bold").fontSize(14)
        .text("ASOCIACION JUDICIAL BONAERENSE", MARGEN + 46, 30, { width: ancho - 46, align: "center" });
      doc.font("Helvetica").fontSize(7.5)
        .text("PERSONERIA GREMIAL N°1446 - FEDERACION JUDICIAL ARGENTINA - C.T.A.", MARGEN + 46, 51, { width: ancho - 46, align: "center" });
      doc.fontSize(8)
        .text("Sede Central: 50 N°712 - CPA-B 1900 APT La Plata - Buenos Aires - Tel: (0221) 423-1006 / 4258594 - e-mail: ajb@ajb.org.ar", MARGEN, 75, { width: ancho, align: "center" })
        .text("Secretaría de Turismo: 49 N°488 - La Plata - Tel: (0221) 423-3101 / 423-2632 - e-mail: osocial@ajb.org.ar", MARGEN, doc.y + 3, { width: ancho, align: "center" });
      doc.font("Helvetica-Bold").fontSize(14)
        .text("CONSTANCIA DE REINTEGRO", MARGEN, Math.max(120, doc.y + 20), { width: ancho, align: "center" });
      doc.y = Math.max(155, doc.y + 18);

      const nuevaPagina = () => {
        doc.addPage();
        doc.font("Helvetica-Bold").fontSize(10).text("CONSTANCIA DE REINTEGRO - continuación", MARGEN, MARGEN, { width: ancho });
        doc.y += 18;
      };
      const escribirCampo = ([nombre, valor, negrita]) => {
        doc.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(12);
        const contenido = `${nombre}: ${valor}`;
        const opciones = { width: ancho, lineGap: 3 };
        const alto = doc.heightOfString(contenido, opciones);
        const altoDisponible = doc.page.height - MARGEN - doc.y;
        if (alto + 15 > altoDisponible && doc.y > MARGEN + 50) nuevaPagina();
        // PDFKit continúa automáticamente en una página nueva si un único
        // valor ocupa más de una página. Sin height/ellipsis no se recorta.
        doc.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(12)
          .text(contenido, MARGEN, doc.y, opciones);
        doc.y += 15;
      };
      const datos = datosConstanciaReintegro(solicitud);
      datos.reintegro.forEach(escribirCampo);
      if (doc.page.height - MARGEN - doc.y < 85) nuevaPagina();
      doc.y += 14;
      doc.font("Helvetica-Bold").fontSize(12).text("DATOS DEL AFILIADO", MARGEN, doc.y, { width: ancho, align: "center" });
      doc.y += 18;
      datos.afiliado.forEach(escribirCampo);
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}

module.exports = {
  datosConstanciaReintegro,
  formatearFechaConstancia,
  formatearImporteConstancia,
  formatearNumeroComprobante,
  generarConstanciaReintegro,
};
