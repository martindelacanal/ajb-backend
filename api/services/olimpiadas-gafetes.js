const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
// Generador de QR sin dependencias (el mismo que usa Predios): el despliegue no instala paquetes nuevos.
const qrcode = require('../vendor/qrcode-generator-1.4.4.min.js');

const MM = 72 / 25.4;
const ANCHO = 90 * MM;
const ALTO = 120 * MM;
const AZUL = '#07517a';

const QR_LADO = 58;

// Código del gafete: número de inscripción + firma. Sin la firma no se puede consultar otra inscripción.
function firmaGafete(id, secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error('Falta JWT_SECRET');
  return crypto.createHmac('sha256', secret).update(`ajb:olimpiadas:gafete:v1:${Number(id)}`).digest('hex').slice(0, 20);
}
function codigoGafete(id, secret) { return `${Number(id)}-${firmaGafete(id, secret)}`; }
function leerCodigoGafete(codigo, secret) {
  const match = /^([1-9]\d{0,9})-([a-f0-9]{20})$/.exec(String(codigo || ''));
  if (!match) return null;
  const esperado = Buffer.from(firmaGafete(match[1], secret));
  const recibido = Buffer.from(match[2]);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido) ? Number(match[1]) : null;
}

// Dibuja el QR módulo por módulo (vectorial: se imprime nítido a cualquier tamaño).
function dibujarQr(doc, texto, x, y, lado) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const modulos = qr.getModuleCount();
  const paso = lado / modulos;
  doc.save();
  doc.rect(x - 3, y - 3, lado + 6, lado + 6).fill('#ffffff');
  doc.fillColor('#000000');
  for (let fila = 0; fila < modulos; fila++) {
    for (let columna = 0; columna < modulos; columna++) {
      if (qr.isDark(fila, columna)) doc.rect(x + columna * paso, y + fila * paso, paso + 0.05, paso + 0.05).fill();
    }
  }
  doc.restore();
}

function textoAjustado(doc, texto, x, y, ancho, alto, tamano = 14) {
  const contenido = String(texto || '').replace(/[\x00-\x1f]/g, ' ').trim();
  let size = tamano;
  doc.fontSize(size);
  while (size > 7 && doc.heightOfString(contenido, { width: ancho }) > alto) doc.fontSize(--size);
  doc.text(contenido, x, y, { width: ancho, height: alto, ellipsis: true, lineGap: 1 });
}

/**
 * `urlVerificacion(codigo)` arma la dirección que lleva el QR: quien lo escanea (el veedor en la mesa)
 * ve si la inscripción sigue aprobada y en qué disciplinas. Sin esa función el gafete sale sin QR.
 */
async function generarGafetes(registros, { cargarFoto = async () => null, urlVerificacion = null } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: {
    Title: 'Credenciales de Olimpiadas - AJB', Author: 'Asociación Judicial Bonaerense',
  } });
  const chunks = [];
  const terminado = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (let i = 0; i < registros.length; i++) {
    const r = registros[i];
    if (i % 4 === 0) {
      doc.addPage();
      doc.font('Helvetica').fontSize(8).fillColor('#495565').text('Imprimir al 100% · A4 · Recortar por las marcas · Gafetes de 9 × 12 cm', 30, 21, { width: 535, align: 'center' });
    }
    const x = 30 + (i % 2) * (ANCHO + 24);
    const y = 49 + Math.floor((i % 4) / 2) * (ALTO + 28);
    doc.save();
    doc.lineWidth(.4).strokeColor('#bbc4cc').rect(x, y, ANCHO, ALTO).stroke();
    doc.rect(x, y, ANCHO, 49).fill(AZUL);
    doc.font('Helvetica-Bold').fillColor('#ffffff');
    textoAjustado(doc, 'AJB · Olimpiadas Judiciales', x + 13, y + 12, ANCHO - 26, 16, 13);
    doc.font('Helvetica');
    textoAjustado(doc, r.olimpiada_nombre, x + 13, y + 31, ANCHO - 26, 14, 9);
    const fotoX = x + 13, fotoY = y + 63, fotoW = 65, fotoH = 80;
    doc.rect(fotoX, fotoY, fotoW, fotoH).fill('#edf3f7');
    let foto = null;
    if (r.foto_archivo) {
      try {
        const original = await cargarFoto(r.foto_archivo);
        if (original?.length) foto = await sharp(original, { limitInputPixels: 40000000 }).rotate().resize(300, 370, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
      } catch { /* Una foto dañada no impide acreditar al resto del lote. */ }
    }
    if (foto) doc.image(foto, fotoX, fotoY, { width: fotoW, height: fotoH });
    else {
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(24).text(`${r.afiliado_nombre?.[0] || ''}${r.afiliado_apellido?.[0] || ''}`, fotoX, fotoY + 25, { width: fotoW, align: 'center' });
      doc.font('Helvetica').fontSize(7).fillColor('#526477').text('Sin fotografía', fotoX, fotoY + 64, { width: fotoW, align: 'center' });
    }
    doc.fillColor('#132b3c').font('Helvetica-Bold');
    textoAjustado(doc, `${r.afiliado_nombre} ${r.afiliado_apellido}`, x + 90, y + 65, ANCHO - 103, 53, 17);
    doc.fillColor(AZUL).font('Helvetica-Bold');
    textoAjustado(doc, r.departamental_nombre || 'AJB', x + 90, y + 121, ANCHO - 103, 28, 11);
    doc.fillColor('#132b3c').font('Helvetica-Bold');
    textoAjustado(doc, r.categoria_nombre || 'Participante', x + 13, y + 159, ANCHO - 26, 22, 12);
    doc.strokeColor('#cad8e2').moveTo(x + 13, y + 185).lineTo(x + ANCHO - 13, y + 185).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(AZUL).text('DISCIPLINAS / ACTIVIDADES', x + 13, y + 195);
    doc.font('Helvetica').fillColor('#132b3c');
    // Con QR, el pie deja libre la esquina inferior derecha.
    const conQr = typeof urlVerificacion === 'function';
    const anchoPie = conQr ? ANCHO - 26 - QR_LADO - 12 : ANCHO - 26;
    textoAjustado(doc, (r.disciplinas || []).join(' · ') || 'Sin disciplinas asignadas', x + 13, y + 214, ANCHO - 26, conQr ? 46 : 70, 11);
    doc.font('Helvetica').fontSize(8).fillColor('#526477');
    textoAjustado(doc, [r.olimpiada_localidad, r.fecha_inicio, r.fecha_fin && r.fecha_fin !== r.fecha_inicio ? `al ${r.fecha_fin}` : ''].filter(Boolean).join(' · '), x + 13, y + (conQr ? 278 : 292), anchoPie, 22, 8);
    doc.font('Helvetica-Bold').fillColor(AZUL).fontSize(9).text(`INSCRIPCIÓN APROBADA · Nº ${String(r.id).padStart(3, '0')}`, x + 13, y + ALTO - (conQr ? 30 : 23), { width: anchoPie });
    if (conQr) dibujarQr(doc, urlVerificacion(codigoGafete(r.id)), x + ANCHO - 13 - QR_LADO, y + ALTO - 13 - QR_LADO, QR_LADO);
    doc.restore();
  }
  doc.end();
  return terminado;
}

module.exports = { generarGafetes, textoAjustado, codigoGafete, leerCodigoGafete, dibujarQr };
