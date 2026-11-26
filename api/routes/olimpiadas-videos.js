/*
 * Videos de una edición, guardados en el sistema (no en una carpeta externa).
 *
 * Un video pesa cientos de megas: no puede viajar en un solo pedido ni quedar en memoria. El
 * navegador lo manda en partes de 8 MB; cada parte llega acá y sigue a S3 como una parte de una
 * subida múltiple. S3 entrega directamente los rangos solicitados por el reproductor y las descargas.
 */
const express = require('express');
const crypto = require('crypto');
const drive = require('../services/olimpiadas-drive');
const { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const {
  s3, bucketName, getCabecera, crearErrorHttp, responderError,
  firmarSeguro, subirImagenOptimizada, eliminarObjetosS3Seguro, manejarUploadOlimpiadas,
} = require('../services/olimpiadas-comun');

const TAMANO_PARTE = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_DRIVE_BYTES = 500 * 1024 * 1024;
const MAX_VIDEOS_POR_EDICION = 40;
const EXPIRACION_VIDEO_SEGUNDOS = 6 * 60 * 60;
const TIPOS_VIDEO = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

// El contenedor se reconoce por sus primeros bytes: MP4/MOV traen «ftyp»; WebM, la cabecera EBML.
function detectarVideo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return buffer.toString('ascii', 8, 12).trim() === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';
  return null;
}

function partesTotales(bytes) { return Math.max(1, Math.ceil(Number(bytes) / TAMANO_PARTE)); }

// Drive puede entregar bloques de cualquier tamaño y omitir Content-Length. Mantener sólo una
// parte en memoria permite subir a S3 mientras llegan los bytes y verificar el límite real.
async function* agruparPartes(flujo) {
  let parte, usados = 0;
  for await (const bloque of flujo) {
    for (let pos = 0; pos < bloque.length;) {
      parte ??= Buffer.allocUnsafe(TAMANO_PARTE);
      const n = bloque.copy(parte, usados, pos, pos + TAMANO_PARTE - usados);
      pos += n;
      usados += n;
      if (usados === TAMANO_PARTE) {
        yield parte;
        parte = null;
        usados = 0;
      }
    }
  }
  if (usados) yield parte.subarray(0, usados);
}

function leerPartes(valor) {
  try { const partes = JSON.parse(valor || '[]'); return Array.isArray(partes) ? partes : []; } catch (_error) { return []; }
}

function disposicionDescarga(fila) {
  const extension = TIPOS_VIDEO[fila.mime] || 'mp4';
  const base = 'video-' + fila.id;
  const titulo = String(fila.titulo || '').normalize('NFC').replace(/[\p{C}<>:"/\\|?*]+/gu, ' ')
    .replace(/\.(mp4|mov|webm)$/i, '').replace(/^[\s.]+|[\s.]+$/g, '').replace(/\s+/g, ' ') || base;
  const nombre = encodeURIComponent(titulo + '.' + extension)
    .replace(/['()*]/g, letra => '%' + letra.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + base + '.' + extension + '"; filename*=UTF-8\'\'' + nombre;
}

module.exports = function registrarVideos(router, helpers, { clienteS3 = s3, bucket = bucketName } = {}) {
  const { db, cargarOlimpiada, enTransaccion, historial, historialCambios, leerTexto, leerEntero, leerFecha, verifyTokenMultimedia, soloGestionMultimedia, idDeRuta, archivoDeSlot } = helpers;
  const endpoint = (fn, mensaje) => async (req, res) => { try { await fn(req, res); } catch (error) { responderError(res, error, mensaje); } };
  const cuerpoBinario = express.raw({ type: 'application/octet-stream', limit: TAMANO_PARTE + 1024 * 1024 });

  async function serializar(fila) {
    const [url, descargaUrl, posterUrl] = await Promise.all([
      firmarSeguro(fila.archivo, EXPIRACION_VIDEO_SEGUNDOS),
      firmarSeguro(fila.archivo, EXPIRACION_VIDEO_SEGUNDOS, disposicionDescarga(fila)),
      firmarSeguro(fila.poster_archivo, EXPIRACION_VIDEO_SEGUNDOS),
    ]);
    return {
      id: fila.id, olimpiada_id: fila.olimpiada_id, titulo: fila.titulo, descripcion: fila.descripcion, fecha: fila.fecha,
      url, descarga_url: descargaUrl, poster_url: posterUrl, mime: fila.mime, bytes: Number(fila.bytes) || 0, orden: fila.orden, fecha_creacion: fila.fecha_creacion,
    };
  }

  async function listarVideos(conexion, olimpiadaId) {
    const [rows] = await conexion.query(
      `SELECT id, olimpiada_id, titulo, descripcion, fecha, archivo, poster_archivo, mime, bytes, orden, fecha_creacion
       FROM olimpiada_video WHERE olimpiada_id = ? AND eliminado = 0 AND estado = 'LISTO' ORDER BY fecha IS NULL, fecha, orden, id`,
      [olimpiadaId]
    );
    return Promise.all(rows.map(serializar));
  }

  async function exigirVideo(videoId, { subiendo = false, conexion } = {}) {
    const [[video]] = await (conexion || db).query('SELECT * FROM olimpiada_video WHERE id = ? AND eliminado = 0' + (conexion ? ' FOR UPDATE' : ''), [videoId]);
    if (!video) throw crearErrorHttp('El video no existe', 404);
    if (subiendo && video.estado !== 'SUBIENDO') throw crearErrorHttp('Este video ya terminó de subirse', 409);
    return video;
  }

  async function abortarSubida(video) {
    if (!video.subida_id) return;
    try { await clienteS3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: video.archivo, UploadId: video.subida_id })); }
    catch (_error) { /* Sin permiso para abortar, las partes sueltas quedan huérfanas en S3; no afecta al sistema. */ }
  }

  async function completarSubida(key, uploadId, partes, bytes) {
    try {
      await clienteS3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: partes } }));
    } catch (error) {
      // S3 puede haber ensamblado el objeto aunque se haya perdido la confirmación.
      const objeto = await clienteS3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(() => null);
      if (!objeto || Number(objeto.ContentLength) !== Number(bytes)) throw error;
    }
  }

  function leerDatos(body, base) {
    return {
      titulo: leerTexto(body, 'titulo', base, { maximo: 160, requerido: true, etiqueta: 'el título del video' }),
      descripcion: leerTexto(body, 'descripcion', base, { maximo: 400, etiqueta: 'la descripción' }),
      fecha: leerFecha(body, 'fecha', base, { etiqueta: 'el día' }),
      orden: leerEntero(body, 'orden', base, { etiqueta: 'el orden' }),
    };
  }

  router.post('/olimpiadas/:id(\\d+)/drive/video', verifyTokenMultimedia, soloGestionMultimedia, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const carga = body.carga_id ?? crypto.randomUUID();
    if (typeof carga !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(carga)) {
      throw crearErrorHttp('Identificador de carga inválido');
    }
    const prefijo = `olimpiadas/videos/${olimpiadaId}/drive/${cabecera.id}/${carga.toLowerCase()}/`;
    async function buscarCarga(conexion) {
      const [[video]] = await conexion.query("SELECT id, archivo FROM olimpiada_video WHERE olimpiada_id = ? AND archivo LIKE ? AND eliminado = 0 AND estado = 'LISTO' LIMIT 1",
        [olimpiadaId, prefijo + '%']);
      return video;
    }
    async function cupo(conexion) {
      const [[cuenta]] = await conexion.query('SELECT COUNT(*) AS cantidad, COALESCE(MAX(orden), 0) AS orden FROM olimpiada_video WHERE olimpiada_id = ? AND eliminado = 0', [olimpiadaId]);
      if (Number(cuenta.cantidad) >= MAX_VIDEOS_POR_EDICION) throw crearErrorHttp(`Una edición admite hasta ${MAX_VIDEOS_POR_EDICION} videos`);
      return Number(cuenta.orden) + 1;
    }
    const confirmar = video => res.status(201).json({ success: true, id: video.id, message: 'Video importado' });
    const anterior = await buscarCarga(db);
    if (anterior) return confirmar(anterior);
    await cupo(db);
    const origen = await drive.archivoSeleccionado(body, 'video');
    const datos = leerDatos(body, { titulo: origen.nombre.replace(/\.(mp4|webm|mov)$/i, '').trim().slice(0, 160) || 'Video' });
    const key = prefijo + crypto.randomUUID() + '.' + TIPOS_VIDEO[origen.mime];
    const destino = { Bucket: bucket, Key: key };
    let uploadId, completado = false, bytes = 0;
    const partes = [];
    try {
      for await (const parte of agruparPartes(await drive.descargar(origen, MAX_VIDEO_DRIVE_BYTES))) {
        if (!uploadId) {
          const tipo = detectarVideo(parte);
          if (!tipo || (tipo === 'video/webm') !== (origen.mime === 'video/webm')) throw crearErrorHttp('El archivo no es un video válido para ese formato.');
          const subida = await clienteS3.send(new CreateMultipartUploadCommand({ ...destino, ContentType: origen.mime }));
          uploadId = subida.UploadId;
          if (!uploadId) throw crearErrorHttp('No se pudo iniciar la subida del video', 502);
        }
        const numero = partes.length + 1;
        const { ETag } = await clienteS3.send(new UploadPartCommand({ ...destino, UploadId: uploadId, PartNumber: numero, Body: parte, ContentLength: parte.length }));
        if (!ETag) throw crearErrorHttp('No se pudo guardar la parte del video', 502);
        partes.push({ ETag, PartNumber: numero });
        bytes += parte.length;
      }
      if (!bytes) throw crearErrorHttp('El video está vacío.');
      await completarSubida(key, uploadId, partes, bytes);
      completado = true;
      const video = await enTransaccion(async conexion => {
        await cargarOlimpiada(conexion, olimpiadaId, cabecera, { forUpdate: true });
        const guardado = await buscarCarga(conexion);
        if (guardado) return guardado;
        const orden = await cupo(conexion);
        const [insert] = await conexion.query(
          "INSERT INTO olimpiada_video (olimpiada_id, titulo, descripcion, fecha, archivo, mime, bytes, orden, estado, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LISTO', ?)",
          [olimpiadaId, datos.titulo, datos.descripcion, datos.fecha, key, origen.mime, bytes, orden, cabecera.id]);
        await historial(conexion, cabecera, { entidad: 'VIDEO', entidad_id: insert.insertId, olimpiada_id: olimpiadaId, tipo_operacion: 'CREATE', valor_nuevo: datos.titulo });
        return { id: insert.insertId, archivo: key };
      });
      if (video.archivo !== key) await eliminarObjetosS3Seguro([key]);
      confirmar(video);
    } catch (error) {
      if (!completado && uploadId) await abortarSubida({ archivo: key, subida_id: uploadId });
      if (completado) {
        const guardado = await buscarCarga(db);
        if (guardado?.archivo !== key) await eliminarObjetosS3Seguro([key]);
        if (guardado) return confirmar(guardado);
      }
      throw error;
    }
  }, 'No se pudo importar el video desde Drive'));

  router.get('/olimpiadas/:id(\\d+)/videos', verifyTokenMultimedia, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    res.set('Cache-Control', 'no-store');
    res.json(await listarVideos(db, olimpiadaId));
  }, 'No se pudieron cargar los videos'));

  // Paso 1: se anota el video y se abre la subida por partes.
  router.post('/olimpiadas/:id(\\d+)/videos', verifyTokenMultimedia, soloGestionMultimedia, endpoint(async (req, res) => {
    const cabecera = getCabecera(req);
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const datos = leerDatos(body, {});
    const mime = String(body.mime || '').toLowerCase();
    const extension = Object.hasOwn(TIPOS_VIDEO, mime) ? TIPOS_VIDEO[mime] : null;
    if (!extension) throw crearErrorHttp('El video tiene que ser MP4, WebM o MOV. MP4 es el que se reproduce en todos los teléfonos.');
    const bytes = Number(body.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw crearErrorHttp('No pudimos leer el tamaño del video');
    if (bytes > MAX_VIDEO_BYTES) throw crearErrorHttp(`El video supera el máximo de ${Math.floor(MAX_VIDEO_BYTES / 1024 / 1024)} MB`);
    const [[cuenta]] = await db.query('SELECT COUNT(*) AS cantidad FROM olimpiada_video WHERE olimpiada_id = ? AND eliminado = 0', [olimpiadaId]);
    if (Number(cuenta.cantidad) >= MAX_VIDEOS_POR_EDICION) throw crearErrorHttp(`Una edición admite hasta ${MAX_VIDEOS_POR_EDICION} videos`);
    const key = `olimpiadas/videos/${olimpiadaId}/video_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${extension}`;
    const subida = await clienteS3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: mime }));
    if (!subida.UploadId) throw crearErrorHttp('No se pudo iniciar la subida del video', 502);
    const [[ultimo]] = await db.query('SELECT COALESCE(MAX(orden), 0) AS orden FROM olimpiada_video WHERE olimpiada_id = ? AND eliminado = 0', [olimpiadaId]);
    const [insert] = await db.query(
      `INSERT INTO olimpiada_video (olimpiada_id, titulo, descripcion, fecha, archivo, mime, bytes, orden, estado, subida_id, partes, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBIENDO', ?, '[]', ?)`,
      [olimpiadaId, datos.titulo, datos.descripcion, datos.fecha, key, mime, bytes, body.orden === undefined ? Number(ultimo.orden) + 1 : datos.orden, subida.UploadId, cabecera.id]
    );
    res.status(201).json({ success: true, id: insert.insertId, tamano_parte: TAMANO_PARTE, partes: partesTotales(bytes), message: 'Subida iniciada' });
  }, 'No se pudo iniciar la subida del video'));

  // Paso 2: una parte por pedido (cuerpo binario). Repetir una parte la reemplaza.
  router.put('/olimpiadas/videos/:videoId(\\d+)/partes/:numero(\\d+)', verifyTokenMultimedia, soloGestionMultimedia, cuerpoBinario, endpoint(async (req, res) => {
    const video = await exigirVideo(idDeRuta(req.params.videoId), { subiendo: true });
    const numero = Number(req.params.numero);
    const total = partesTotales(video.bytes);
    if (!Number.isInteger(numero) || numero < 1 || numero > total) throw crearErrorHttp('El número de parte es inválido');
    const cuerpo = req.body;
    if (!Buffer.isBuffer(cuerpo) || cuerpo.length === 0) throw crearErrorHttp('La parte del video llegó vacía');
    const esperado = numero < total ? TAMANO_PARTE : Number(video.bytes) - TAMANO_PARTE * (total - 1);
    if (cuerpo.length !== esperado) throw crearErrorHttp('La parte del video no tiene el tamaño esperado. Volvé a intentar la subida.');
    if (numero === 1) {
      const detectado = detectarVideo(cuerpo);
      const equivalentes = detectado === video.mime || (detectado === 'video/mp4' && video.mime === 'video/quicktime') || (detectado === 'video/quicktime' && video.mime === 'video/mp4');
      if (!detectado || !equivalentes) {
        const [baja] = await db.query("UPDATE olimpiada_video SET eliminado = 1, subida_id = NULL WHERE id = ? AND eliminado = 0 AND estado = 'SUBIENDO'", [video.id]);
        if (baja.affectedRows) await abortarSubida(video);
        throw crearErrorHttp('El archivo no es un video MP4, WebM o MOV válido');
      }
    }
    const respuesta = await clienteS3.send(new UploadPartCommand({ Bucket: bucket, Key: video.archivo, UploadId: video.subida_id, PartNumber: numero, Body: cuerpo, ContentLength: cuerpo.length }));
    if (!respuesta.ETag) throw crearErrorHttp('No se pudo guardar la parte del video', 502);
    const recibidas = await enTransaccion(async (connection) => {
      const fila = await exigirVideo(video.id, { subiendo: true, conexion: connection });
      const partes = leerPartes(fila.partes).filter(p => Number(p.n) !== numero);
      partes.push({ n: numero, e: respuesta.ETag });
      await connection.query('UPDATE olimpiada_video SET partes = ? WHERE id = ?', [JSON.stringify(partes), video.id]);
      return partes.length;
    });
    res.json({ success: true, recibidas, partes: total });
  }, 'No se pudo subir la parte del video'));

  // Paso 3: S3 une las partes y el video queda disponible.
  router.post('/olimpiadas/videos/:videoId(\\d+)/completar', verifyTokenMultimedia, soloGestionMultimedia, endpoint(async (req, res) => {
    const cabecera = getCabecera(req);
    const listo = await enTransaccion(async (connection) => {
      const video = await exigirVideo(idDeRuta(req.params.videoId), { conexion: connection });
      if (video.estado === 'LISTO') return video;
      const partes = leerPartes(video.partes).sort((a, b) => Number(a.n) - Number(b.n));
      const total = partesTotales(video.bytes);
      if (partes.length !== total || partes.some((parte, indice) => Number(parte.n) !== indice + 1)) {
        throw crearErrorHttp(`Faltan partes del video (${partes.length} de ${total}). Volvé a intentar la subida.`, 409);
      }
      await completarSubida(video.archivo, video.subida_id, partes.map(parte => ({ PartNumber: Number(parte.n), ETag: parte.e })), video.bytes);
      await connection.query("UPDATE olimpiada_video SET estado = 'LISTO', subida_id = NULL, partes = NULL WHERE id = ?", [video.id]);
      await historial(connection, cabecera, { entidad: 'VIDEO', entidad_id: video.id, olimpiada_id: video.olimpiada_id, tipo_operacion: 'CREATE', valor_nuevo: video.titulo });
      return video;
    });
    res.json({ success: true, message: `Video «${listo.titulo}» subido`, video: await serializar(listo) });
  }, 'No se pudo terminar la subida del video'));

  // Imagen de portada (la toma el navegador de un cuadro del video).
  router.post('/olimpiadas/videos/:videoId(\\d+)/poster', verifyTokenMultimedia, soloGestionMultimedia, manejarUploadOlimpiadas, endpoint(async (req, res) => {
    const cabecera = getCabecera(req);
    const video = await exigirVideo(idDeRuta(req.params.videoId));
    const archivo = archivoDeSlot(req, 'POSTER');
    if (!archivo) throw crearErrorHttp('Adjuntá la imagen de portada');
    const imagen = await subirImagenOptimizada(archivo, `videos/${video.olimpiada_id}/poster`, { anchoMaximo: 1280 });
    await db.query('UPDATE olimpiada_video SET poster_archivo = ? WHERE id = ?', [imagen.key, video.id]);
    await eliminarObjetosS3Seguro([video.poster_archivo]);
    res.json({ success: true, message: 'Portada del video actualizada', poster_url: await firmarSeguro(imagen.key, EXPIRACION_VIDEO_SEGUNDOS) });
  }, 'No se pudo guardar la portada del video'));

  router.put('/olimpiadas/videos/:videoId(\\d+)', verifyTokenMultimedia, soloGestionMultimedia, endpoint(async (req, res) => {
    const cabecera = getCabecera(req);
    const video = await exigirVideo(idDeRuta(req.params.videoId));
    const datos = leerDatos(req.body || {}, video);
    await enTransaccion(async (connection) => {
      await connection.query('UPDATE olimpiada_video SET titulo = ?, descripcion = ?, fecha = ?, orden = ? WHERE id = ?', [datos.titulo, datos.descripcion, datos.fecha, datos.orden, video.id]);
      await historialCambios(connection, cabecera, { entidad: 'VIDEO', entidad_id: video.id, olimpiada_id: video.olimpiada_id }, video, datos, ['titulo', 'descripcion', 'fecha', 'orden']);
    });
    const [[actualizado]] = await db.query('SELECT * FROM olimpiada_video WHERE id = ?', [video.id]);
    res.json({ success: true, message: 'Video actualizado', video: await serializar(actualizado) });
  }, 'No se pudo actualizar el video'));

  router.delete('/olimpiadas/videos/:videoId(\\d+)', verifyTokenMultimedia, soloGestionMultimedia, endpoint(async (req, res) => {
    const cabecera = getCabecera(req);
    const video = await enTransaccion(async (connection) => {
      const fila = await exigirVideo(idDeRuta(req.params.videoId), { conexion: connection });
      if (req.query.cancelar === '1' && fila.estado !== 'SUBIENDO') throw crearErrorHttp('El video ya terminó de subirse', 409);
      // Prensa elimina los videos de sus ediciones. Una subida en curso sólo la corta quien la empezó
      // (verifyTokenMultimedia ya lo exige; la regla queda escrita también acá).
      if (cabecera.rol === 'prensa' && fila.estado === 'SUBIENDO' && Number(fila.usuario_id) !== Number(cabecera.id)) {
        throw crearErrorHttp('Sólo podés cancelar tus propias subidas en curso', 403);
      }
      await connection.query('UPDATE olimpiada_video SET eliminado = 1, subida_id = NULL, partes = NULL WHERE id = ?', [fila.id]);
      if (fila.estado === 'LISTO') {
        await historial(connection, cabecera, { entidad: 'VIDEO', entidad_id: fila.id, olimpiada_id: fila.olimpiada_id, tipo_operacion: 'DELETE', valor_anterior: fila.titulo });
      }
      return fila;
    });
    if (video.estado === 'SUBIENDO') await abortarSubida(video);
    await eliminarObjetosS3Seguro(video.estado === 'LISTO' ? [video.archivo, video.poster_archivo] : [video.poster_archivo]);
    res.json({ success: true, message: video.estado === 'LISTO' ? 'Video eliminado' : 'Subida cancelada' });
  }, 'No se pudo eliminar el video'));

  return { listarVideos, detectarVideo, partesTotales, TAMANO_PARTE, MAX_VIDEO_BYTES };
};
module.exports.detectarVideo = detectarVideo;
module.exports.partesTotales = partesTotales;
module.exports.TAMANO_PARTE = TAMANO_PARTE;
