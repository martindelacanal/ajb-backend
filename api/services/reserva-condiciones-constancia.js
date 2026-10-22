"use strict";

// Constancia OPCIONAL de las condiciones de cancelación de una reserva:
// una carilla A4 para imprimir y que la persona afiliada la firme en papel. Mismo
// esqueleto que coseguro-constancia.js (membrete, márgenes, fuentes estándar).
// Las fuentes estándar de PDFKit usan WinAnsi: sin «≥» ni «→» («·», «»», «–» y
// las tildes sí andan).

const path = require("node:path");
const PDFDocument = require("pdfkit");
const { formatearFechaConstancia, formatearImporteConstancia } = require("./coseguro-constancia");
const { diferenciaDiasCivil, normalizarFechaCivil } = require("./valores-dominio");

const LOGO_PATH = path.join(__dirname, "..", "assets", "ajb-logo.png");
const MARGEN = 42;
const NO_INFORMADO = "No informado";
const TINTA = "#12344d";
const LINEA = "#9aa9b5";

function texto(valor) {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

function nombreCompleto(nombre, apellido) {
  return [nombre, apellido].map(texto).filter(Boolean).join(" ");
}

function formatearFechaHora(valor, ahora = new Date()) {
  const instante = valor instanceof Date ? valor : new Date(valor ?? ahora);
  if (Number.isNaN(instante.getTime())) return NO_INFORMADO;
  const partes = Object.fromEntries(new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(instante).map((parte) => [parte.type, parte.value]));
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

function formatearFechaDeInstante(valor) {
  return formatearFechaHora(valor).slice(0, 10);
}

function diasTexto(dias) {
  return `${dias} ${dias === 1 ? "día" : "días"}`;
}

// «Hasta el 26/12/2026», «Del 27/12/2026 al 03/01/2027», «Desde el 04/01/2027».
function etiquetaFechasTramo(tramo, cantidadTramos) {
  if (cantidadTramos === 1) return "En cualquier momento";
  const fecha = (valor) => formatearFechaConstancia(valor);
  if (tramo.desde_fecha === null) return `Hasta el ${fecha(tramo.hasta_fecha)}`;
  if (tramo.dias_desde === 0) return `Desde el ${fecha(tramo.desde_fecha)}`;
  if (tramo.desde_fecha === tramo.hasta_fecha) return `El ${fecha(tramo.hasta_fecha)}`;
  return `Del ${fecha(tramo.desde_fecha)} al ${fecha(tramo.hasta_fecha)}`;
}

// «15 días o más antes», «De 7 a 14 días antes», «Menos de 7 días antes».
function etiquetaAnticipacion(tramo) {
  if (tramo.dias_hasta === null) {
    return tramo.dias_desde === 0 ? "Sin importar la anticipación" : `${diasTexto(tramo.dias_desde)} o más antes del ingreso`;
  }
  if (tramo.dias_desde === 0) {
    return tramo.dias_hasta === 0 ? "El mismo día del ingreso" : `Menos de ${diasTexto(tramo.dias_hasta + 1)} antes del ingreso`;
  }
  if (tramo.dias_desde === tramo.dias_hasta) return `${diasTexto(tramo.dias_desde)} antes del ingreso`;
  return `De ${tramo.dias_desde} a ${tramo.dias_hasta} días antes del ingreso`;
}

function etiquetaReintegro(porcentaje) {
  const numero = Number(porcentaje);
  if (!Number.isFinite(numero) || numero === 0) return "Sin reintegro";
  return `${numero.toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;
}

function etiquetaCarga(carga) {
  if (!carga) return "";
  const quien = texto(carga.nombre) || "Turismo";
  const area = carga.rol === "departamental" && texto(carga.departamental_nombre)
    ? ` (Departamental ${texto(carga.departamental_nombre)})`
    : carga.rol === "admin" ? " (Turismo)" : "";
  const fecha = carga.fecha ? ` el ${formatearFechaDeInstante(carga.fecha)}` : "";
  return `${quien}${area}${fecha}`;
}

/**
 * Datos impresos, separados del dibujo para poder probarlos.
 * `reserva`: id, afiliado_*, departamental_nombre, servicio_nombre, recurso_nombre,
 * convenio_nombre, lugar, fecha_inicio, fecha_fin, precio_total, modalidad, sorteo_nombre.
 * `condiciones`: obtenerCondicionesReserva (con nombres: la arma el staff).
 */
function datosConstanciaCondiciones({ reserva, personas = [], condiciones, entregadaPor = "" }) {
  const noches = diferenciaDiasCivil(normalizarFechaCivil(reserva.fecha_inicio), normalizarFechaCivil(reserva.fecha_fin));
  const estadia = `del ${formatearFechaConstancia(reserva.fecha_inicio)} al ${formatearFechaConstancia(reserva.fecha_fin)}`
    + (Number.isInteger(noches) && noches > 0 ? ` (${noches} ${noches === 1 ? "noche" : "noches"})` : "");
  const alojamiento = [texto(reserva.servicio_nombre) || texto(reserva.convenio_nombre), texto(reserva.recurso_nombre) || texto(reserva.convenio_nombre)]
    .filter((valor, indice, lista) => valor && lista.indexOf(valor) === indice).join(" · ");
  const esConvenio = texto(reserva.modalidad).toUpperCase() === "CONVENIO";
  const viajan = personas.map((persona) => nombreCompleto(persona.nombre, persona.apellido)).filter(Boolean).join(", ");
  // «APELLIDO, Nombre · DNI …»
  const afiliado = [texto(reserva.afiliado_apellido).toUpperCase(), texto(reserva.afiliado_nombre)].filter(Boolean).join(", ");
  const filas = [
    ["Persona afiliada", [afiliado, texto(reserva.afiliado_documento) ? `DNI ${texto(reserva.afiliado_documento)}` : ""].filter(Boolean).join(" · ") || NO_INFORMADO],
    ["Departamental", texto(reserva.departamental_nombre) || NO_INFORMADO],
    ["Alojamiento", alojamiento || NO_INFORMADO],
    ["Lugar", texto(reserva.lugar) || NO_INFORMADO],
    ["Estadía", estadia],
    ["Personas que viajan", viajan || NO_INFORMADO],
    ["Total de la reserva", esConvenio ? "A cotizar" : `$ ${formatearImporteConstancia(reserva.precio_total)}`],
  ];
  if (texto(reserva.sorteo_nombre)) filas.splice(2, 0, ["Sorteo", texto(reserva.sorteo_nombre)]);
  const cargadaPor = etiquetaCarga(condiciones?.carga);
  if (cargadaPor) filas.push(["Cargada por", cargadaPor]);

  const tramos = Array.isArray(condiciones?.tramos) ? condiciones.tramos : [];
  // Si firmó por teléfono alguien del staff que no es quien cargó (otro registró la firma de
  // una reserva enviada), el recuadro lleva su nombre: la firma impresa es la suya.
  const firmoStaff = condiciones?.firma?.firmante === "ADMINISTRATIVO" ? texto(condiciones.firma.firmante_nombre) : "";
  return {
    titulo: "CONSTANCIA DE CONDICIONES DE CANCELACIÓN",
    codigo: `Reserva T-${reserva.id}`,
    filas,
    politica: `${texto(condiciones?.politica?.titulo) || "Política de cancelación"} · versión ${condiciones?.politica?.version ?? "-"}`,
    esSorteo: texto(reserva.modalidad).toUpperCase() === "SORTEO",
    sinDevoluciones: Boolean(condiciones?.sin_devoluciones),
    tramos: tramos.map((tramo) => ({
      cuando: etiquetaFechasTramo(tramo, tramos.length),
      anticipacion: tramos.length === 1 ? "" : etiquetaAnticipacion(tramo),
      reintegro: etiquetaReintegro(tramo.porcentaje_reintegro),
    })),
    notas: [
      "Los días se cuentan hasta la fecha de ingreso, con el calendario de Argentina. El reintegro se calcula sobre el total de la reserva y el importe final se confirma al gestionar el reintegro.",
      "Estas condiciones quedan guardadas con la reserva aunque la política del servicio cambie después.",
    ],
    declaracion: "Me informaron estas condiciones de cancelación y estoy de acuerdo.",
    recuadroStaff: firmoStaff && firmoStaff !== texto(condiciones?.carga?.nombre)
      ? { titulo: "Firma y sello de quien registró la aceptación", aclaracion: firmoStaff }
      : condiciones?.carga
        ? { titulo: "Firma y sello de quien cargó la reserva", aclaracion: texto(condiciones.carga.nombre) }
        : { titulo: "Firma y sello de quien entrega la constancia", aclaracion: texto(entregadaPor) },
  };
}

/**
 * Genera el PDF. `firma`: { imagen: Buffer PNG, firmante: 'AFILIADO'|'ADMINISTRATIVO', firmada_en, canal }
 * cuando ya se firmó (en la pantalla de la oficina o desde Mi AJB): se imprime en el recuadro
 * de quien firmó.
 */
function generarConstanciaCondiciones({ reserva, personas = [], condiciones, entregadaPor = "", firma = null, generadaEn = new Date() }) {
  return new Promise((resolve, reject) => {
    const datos = datosConstanciaCondiciones({ reserva, personas, condiciones, entregadaPor });
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGEN,
      info: { Title: `Constancia de condiciones de cancelación T-${reserva.id}`, Author: "Asociación Judicial Bonaerense" },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const ancho = doc.page.width - MARGEN * 2;
      const limiteInferior = () => doc.page.height - MARGEN - 18;
      const asegurarEspacio = (alto) => {
        if (doc.y + alto > limiteInferior()) {
          doc.addPage();
          doc.font("Helvetica-Bold").fontSize(10).fillColor(TINTA)
            .text(`${datos.titulo} - continuación`, MARGEN, MARGEN, { width: ancho });
          doc.y += 12;
        }
      };
      const subtitulo = (contenido) => {
        asegurarEspacio(40);
        doc.y += 10;
        doc.font("Helvetica-Bold").fontSize(11).fillColor(TINTA).text(contenido, MARGEN, doc.y, { width: ancho });
        doc.y += 6;
      };

      // Membrete (igual al de la constancia de coseguro).
      doc.image(LOGO_PATH, MARGEN, 31, { fit: [40, 40] });
      doc.font("Helvetica-Bold").fontSize(14).fillColor("black")
        .text("ASOCIACION JUDICIAL BONAERENSE", MARGEN + 46, 30, { width: ancho - 46, align: "center" });
      doc.font("Helvetica").fontSize(7.5)
        .text("PERSONERIA GREMIAL N°1446 - FEDERACION JUDICIAL ARGENTINA - C.T.A.", MARGEN + 46, 51, { width: ancho - 46, align: "center" });
      doc.fontSize(8)
        .text("Sede Central: 50 N°712 - CPA-B 1900 APT La Plata - Buenos Aires - Tel: (0221) 423-1006 / 4258594 - e-mail: ajb@ajb.org.ar", MARGEN, 75, { width: ancho, align: "center" })
        .text("Secretaría de Turismo: 49 N°488 - La Plata - Tel: (0221) 423-3101 / 423-2632 - e-mail: osocial@ajb.org.ar", MARGEN, doc.y + 3, { width: ancho, align: "center" });
      doc.font("Helvetica-Bold").fontSize(13).fillColor(TINTA)
        .text(datos.titulo, MARGEN, Math.max(118, doc.y + 18), { width: ancho, align: "center" });
      doc.font("Helvetica").fontSize(11).text(datos.codigo, MARGEN, doc.y + 2, { width: ancho, align: "center" });
      doc.y += 8;

      subtitulo("DATOS DE LA RESERVA");
      for (const [rotulo, valor] of datos.filas) {
        const contenido = `${rotulo}: ${valor}`;
        doc.font("Helvetica").fontSize(10);
        asegurarEspacio(doc.heightOfString(contenido, { width: ancho }) + 4);
        doc.font("Helvetica-Bold").fillColor("black").text(`${rotulo}: `, MARGEN, doc.y, { width: ancho, continued: true })
          .font("Helvetica").text(valor);
        doc.y += 3;
      }

      subtitulo("CONDICIONES DE CANCELACIÓN");
      doc.font("Helvetica").fontSize(10).fillColor("black").text(datos.politica, MARGEN, doc.y, { width: ancho });
      if (datos.esSorteo) doc.text("Se aplican si se adjudica el lugar.", MARGEN, doc.y + 2, { width: ancho });
      if (datos.sinDevoluciones) {
        doc.text("Esta reserva no tiene devoluciones: si se cancela, el reintegro es del 0%.", MARGEN, doc.y + 2, { width: ancho });
      }
      doc.y += 8;

      // Tabla «Si cancela» / «Reintegro».
      const anchoReintegro = 120;
      const anchoCuando = ancho - anchoReintegro;
      const dibujarFila = (izquierda, derecha, { encabezado = false, detalle = "" } = {}) => {
        const fuente = encabezado ? "Helvetica-Bold" : "Helvetica";
        doc.font(fuente).fontSize(10);
        const contenidoIzquierda = detalle ? `${izquierda}\n${detalle}` : izquierda;
        const alto = Math.max(doc.heightOfString(contenidoIzquierda, { width: anchoCuando - 16 }), 12) + 12;
        asegurarEspacio(alto);
        const y = doc.y;
        if (encabezado) doc.rect(MARGEN, y, ancho, alto).fill("#eef4f8");
        doc.fillColor("black").font(fuente).fontSize(10).text(izquierda, MARGEN + 8, y + 6, { width: anchoCuando - 16 });
        if (detalle) doc.font("Helvetica").fontSize(9).fillColor("#4a5d6c").text(detalle, MARGEN + 8, doc.y, { width: anchoCuando - 16 });
        doc.font("Helvetica-Bold").fontSize(10).fillColor("black")
          .text(derecha, MARGEN + anchoCuando + 8, y + 6, { width: anchoReintegro - 16, align: "right" });
        doc.moveTo(MARGEN, y + alto).lineTo(MARGEN + ancho, y + alto).lineWidth(0.6).strokeColor(LINEA).stroke();
        doc.y = y + alto;
      };
      dibujarFila("Si cancela…", "Reintegro", { encabezado: true });
      for (const tramo of datos.tramos) dibujarFila(tramo.cuando, tramo.reintegro, { detalle: tramo.anticipacion });
      doc.y += 8;
      doc.font("Helvetica").fontSize(9).fillColor("#4a5d6c");
      for (const nota of datos.notas) {
        asegurarEspacio(doc.heightOfString(nota, { width: ancho }) + 4);
        doc.text(nota, MARGEN, doc.y, { width: ancho });
        doc.y += 3;
      }

      subtitulo("DECLARACIÓN");
      doc.font("Helvetica").fontSize(10.5).fillColor("black").text(datos.declaracion, MARGEN, doc.y, { width: ancho });
      doc.y += 14;

      // Dos recuadros de firma. Si ya se firmó en pantalla, la firma se imprime
      // en el recuadro de quien firmó (sirve de copia para entregarle).
      const altoRecuadro = 118;
      asegurarEspacio(altoRecuadro + 40);
      const yRecuadros = doc.y;
      const separacion = 16;
      const anchoRecuadro = (ancho - separacion) / 2;
      const recuadros = [
        { x: MARGEN, titulo: "Firma de la persona afiliada", lineas: ["Aclaración:", "DNI:"], firmante: "AFILIADO" },
        {
          x: MARGEN + anchoRecuadro + separacion,
          titulo: datos.recuadroStaff.titulo,
          lineas: [`Aclaración: ${datos.recuadroStaff.aclaracion}`.trim()],
          firmante: "ADMINISTRATIVO",
        },
      ];
      for (const recuadro of recuadros) {
        doc.rect(recuadro.x, yRecuadros, anchoRecuadro, altoRecuadro).lineWidth(0.8).strokeColor(LINEA).stroke();
        doc.font("Helvetica-Bold").fontSize(9).fillColor(TINTA)
          .text(recuadro.titulo, recuadro.x + 8, yRecuadros + 6, { width: anchoRecuadro - 16 });
        const firmaAca = firma?.imagen && firma.firmante === recuadro.firmante;
        if (firmaAca) {
          try {
            doc.image(firma.imagen, recuadro.x + 12, yRecuadros + 22, { fit: [anchoRecuadro - 24, 44], align: "center", valign: "center" });
          } catch (_) {
            // Una imagen ilegible no impide imprimir la constancia: queda el renglón.
          }
          // APP (reservó sola) y ENVIO (firmó lo que se le envió): firmó desde su cuenta, no en la oficina.
          const dondeFirmo = ["APP", "ENVIO"].includes(firma.canal) ? "Firmada desde Mi AJB" : "Firmada en pantalla";
          doc.font("Helvetica").fontSize(7.5).fillColor("#4a5d6c")
            .text(`${dondeFirmo} el ${formatearFechaDeInstante(firma.firmada_en || generadaEn)}`, recuadro.x + 8, yRecuadros + 68, { width: anchoRecuadro - 16, align: "center" });
        }
        const yRenglon = yRecuadros + 80;
        doc.moveTo(recuadro.x + 8, yRenglon).lineTo(recuadro.x + anchoRecuadro - 8, yRenglon).lineWidth(0.6).strokeColor(LINEA).stroke();
        doc.font("Helvetica").fontSize(8.5).fillColor("black");
        recuadro.lineas.forEach((linea, indice) => {
          doc.text(linea, recuadro.x + 8, yRenglon + 6 + indice * 13, { width: anchoRecuadro - 16 });
        });
      }
      doc.y = yRecuadros + altoRecuadro + 14;
      doc.font("Helvetica").fontSize(10).fillColor("black")
        .text("Lugar y fecha: ______________________________________", MARGEN, doc.y, { width: ancho });

      // Pie en la última página (el contenido termina antes: asegurarEspacio deja 18 pt libres).
      doc.font("Helvetica").fontSize(8).fillColor("#4a5d6c")
        .text(`Generada el ${formatearFechaHora(generadaEn)} · ${datos.codigo}`, MARGEN, doc.page.height - MARGEN - 14,
          { width: ancho, align: "center", lineBreak: false });
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}

module.exports = {
  datosConstanciaCondiciones,
  etiquetaAnticipacion,
  etiquetaFechasTramo,
  formatearFechaHora,
  generarConstanciaCondiciones,
};
