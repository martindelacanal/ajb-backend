const PDFDocument = require('pdfkit');
const sharp = require('sharp');

const MM = 72 / 25.4;
const ANCHO = 90 * MM;
const ALTO = 120 * MM;
const AZUL = '#07517a';

function textoAjustado(doc, texto, x, y, ancho, alto, tamano = 14) {
  const contenido = String(texto || '').replace(/[\x00-\x1f]/g, ' ').trim();
  let size = tamano;
  doc.fontSize(size);
  while (size > 7 && doc.heightOfString(contenido, { width: ancho }) > alto) doc.fontSize(--size);
  doc.text(contenido, x, y, { width: ancho, height: alto, ellipsis: true, lineGap: 1 });
}

async function generarGafetes(registros, { cargarFoto = async () => null } = {}) {
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
    textoAjustado(doc, (r.disciplinas || []).join(' · ') || 'Sin disciplinas asignadas', x + 13, y + 214, ANCHO - 26, 70, 11);
    doc.font('Helvetica').fontSize(8).fillColor('#526477');
    textoAjustado(doc, [r.olimpiada_localidad, r.fecha_inicio, r.fecha_fin && r.fecha_fin !== r.fecha_inicio ? `al ${r.fecha_fin}` : ''].filter(Boolean).join(' · '), x + 13, y + 292, ANCHO - 26, 22, 8);
    doc.font('Helvetica-Bold').fillColor(AZUL).fontSize(9).text(`INSCRIPCIÓN APROBADA · #${r.id}`, x + 13, y + ALTO - 23, { width: ANCHO - 26 });
    doc.restore();
  }
  doc.end();
  return terminado;
}

module.exports = { generarGafetes, textoAjustado };
