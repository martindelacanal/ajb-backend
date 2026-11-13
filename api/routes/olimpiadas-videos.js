/*
 * Videos de una edición, guardados en el sistema (no en una carpeta externa).
 *
 * Un video pesa cientos de megas: no puede viajar en un solo pedido ni quedar en memoria. El
 * navegador lo manda en partes de 8 MB; cada parte llega acá y sigue a S3 como una parte de una
 * subida múltiple. Al completar, S3 arma el archivo. Lecturas: cualquier rol; escrituras: la
 * administración provincial.
 */
const express = require('express');
const crypto = require('crypto');
const { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const {
  s3, bucketName, verifyToken, getCabecera, crearErrorHttp, responderError, normalizarTexto,
  firmarSeguro, subirImagenOptimizada, eliminarObjetosS3Seguro, manejarUploadOlimpiadas,
} = require('../services/olimpiadas-comun');

const TAMANO_PARTE = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1536 * 1024 * 1024; // 1,5 GB
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

function leerPartes(valor) {
  try { const partes = JSON.parse(valor || '[]'); return Array.isArray(partes) ? partes : []; } catch (_error) { return []; }
}

module.exports = function registrarVideos(router, helpers, { clienteS3 = s3, bucket = bucketName } = {}) {
  const { db, cargarOlimpiada, enTransaccion, historial, historialCambios, leerTexto, leerEntero, leerFecha, exigirSuperior, soloSuperior, idDeRuta, archivoDeSlot } = helpers;
  const endpoint = (fn, mensaje) => async (req, res) => { try { await fn(req, res); } catch (error) { responderError(res, error, mensaje); } };
  const cuerpoBinario = express.raw({ type: 'application/octet-stream', limit: TAMANO_PARTE + 1024 * 1024 });

  async function serializar(fila) {
    const [url, posterUrl] = await Promise.all([firmarSeguro(fila.archivo, EXPIRACION_VIDEO_SEGUNDOS), firmarSeguro(fila.poster_archivo, EXPIRACION_VIDEO_SEGUNDOS)]);
    return {
      id: fila.id, olimpiada_id: fila.olimpiada_id, titulo: fila.titulo, descripcion: fila.descripcion, fecha: fila.fecha,
      url, poster_url: posterUrl, mime: fila.mime, bytes: Number(fila.bytes) || 0, orden: fila.orden, fecha_creacion: fila.fecha_creacion,
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

  async function exigirVideo(videoId, { subiendo = false } = {}) {
    const [[video]] = await db.query('SELECT * FROM olimpiada_video WHERE id = ? AND eliminado = 0', [videoId]);
    if (!video) throw crearErrorHttp('El video no existe', 404);
    if (subiendo && video.estado !== 'SUBIENDO') throw crearErrorHttp('Este video ya terminó de subirse', 409);
    return video;
  }

  async function abortarSubida(video) {
    if (!video.subida_id) return;
    try { await clienteS3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: video.archivo, UploadId: video.subida_id })); }
    catch (_error) { /* Sin permiso para abortar, las partes sueltas quedan huérfanas en S3; no afecta al sistema. */ }
  }

  function leerDatos(body, base) {
    return {
      titulo: leerTexto(body, 'titulo', base, { maximo: 160, requerido: true, etiqueta: 'el título del video' }),
      descripcion: leerTexto(body, 'descripcion', base, { maximo: 400, etiqueta: 'la descripción' }),
      fecha: leerFecha(body, 'fecha', base, { etiqueta: 'el día' }),
      orden: leerEntero(body, 'orden', base, { etiqueta: 'el orden' }),
    };
  }

  router.get('/olimpiadas/:id(\\d+)/videos', verifyToken, endpoint(async (req, res) => {
    const cabecera = getCabecera(req), olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    res.set('Cache-Control', 'no-store');
    res.json(await listarVideos(db, olimpiadaId));
  }, 'No se pudieron cargar los videos'));

  // Paso 1: se anota el video y se abre la subida por partes.
  router.post('/olimpiadas/:id(\\d+)/videos', verifyToken, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const olimpiadaId = idDeRuta(req.params.id);
    await cargarOlimpiada(db, olimpiadaId, cabecera);
    const body = req.body || {};
    const datos = leerDatos(body, {});
    const mime = String(body.mime || '').toLowerCase();
    const extension = TIPOS_VIDEO[mime];
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
  router.put('/olimpiadas/videos/:videoId(\\d+)/partes/:numero(\\d+)', verifyToken, soloSuperior, cuerpoBinario, endpoint(async (req, res) => {
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
        await abortarSubida(video);
        await db.query('UPDATE olimpiada_video SET eliminado = 1, subida_id = NULL WHERE id = ?', [video.id]);
        throw crearErrorHttp('El archivo no es un video MP4, WebM o MOV válido');
      }
    }
    const respuesta = await clienteS3.send(new UploadPartCommand({ Bucket: bucket, Key: video.archivo, UploadId: video.subida_id, PartNumber: numero, Body: cuerpo, ContentLength: cuerpo.length }));
    if (!respuesta.ETag) throw crearErrorHttp('No se pudo guardar la parte del video', 502);
    const recibidas = await enTransaccion(async (connection) => {
      const [[fila]] = await connection.query('SELECT partes FROM olimpiada_video WHERE id = ? FOR UPDATE', [video.id]);
      const partes = leerPartes(fila?.partes).filter(p => Number(p.n) !== numero);
      partes.push({ n: numero, e: respuesta.ETag });
      await connection.query('UPDATE olimpiada_video SET partes = ? WHERE id = ?', [JSON.stringify(partes), video.id]);
      return partes.length;
    });
    res.json({ success: true, recibidas, partes: total });
  }, 'No se pudo subir la parte del video'));

  // Paso 3: S3 une las partes y el video queda disponible.
  router.post('/olimpiadas/videos/:videoId(\\d+)/completar', verifyToken, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const video = await exigirVideo(idDeRuta(req.params.videoId), { subiendo: true });
    const partes = leerPartes(video.partes).sort((a, b) => Number(a.n) - Number(b.n));
    const total = partesTotales(video.bytes);
    if (partes.length !== total || partes.some((parte, indice) => Number(parte.n) !== indice + 1)) {
      throw crearErrorHttp(`Faltan partes del video (${partes.length} de ${total}). Volvé a intentar la subida.`, 409);
    }
    await clienteS3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: video.archivo, UploadId: video.subida_id,
      MultipartUpload: { Parts: partes.map(parte => ({ PartNumber: Number(parte.n), ETag: parte.e })) },
    }));
    await enTransaccion(async (connection) => {
      await connection.query("UPDATE olimpiada_video SET estado = 'LISTO', subida_id = NULL, partes = NULL WHERE id = ?", [video.id]);
      await historial(connection, cabecera, { entidad: 'VIDEO', entidad_id: video.id, olimpiada_id: video.olimpiada_id, tipo_operacion: 'CREATE', valor_nuevo: video.titulo });
    });
    const [[listo]] = await db.query('SELECT * FROM olimpiada_video WHERE id = ?', [video.id]);
    res.json({ success: true, message: `Video «${video.titulo}» subido`, video: await serializar(listo) });
  }, 'No se pudo terminar la subida del video'));

  // Imagen de portada (la toma el navegador de un cuadro del video).
  router.post('/olimpiadas/videos/:videoId(\\d+)/poster', verifyToken, soloSuperior, manejarUploadOlimpiadas, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const video = await exigirVideo(idDeRuta(req.params.videoId));
    const archivo = archivoDeSlot(req, 'POSTER');
    if (!archivo) throw crearErrorHttp('Adjuntá la imagen de portada');
    const imagen = await subirImagenOptimizada(archivo, `videos/${video.olimpiada_id}/poster`, { anchoMaximo: 1280 });
    await db.query('UPDATE olimpiada_video SET poster_archivo = ? WHERE id = ?', [imagen.key, video.id]);
    await eliminarObjetosS3Seguro([video.poster_archivo]);
    res.json({ success: true, message: 'Portada del video actualizada', poster_url: await firmarSeguro(imagen.key, EXPIRACION_VIDEO_SEGUNDOS) });
  }, 'No se pudo guardar la portada del video'));

  router.put('/olimpiadas/videos/:videoId(\\d+)', verifyToken, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const video = await exigirVideo(idDeRuta(req.params.videoId));
    const datos = leerDatos(req.body || {}, video);
    await enTransaccion(async (connection) => {
      await connection.query('UPDATE olimpiada_video SET titulo = ?, descripcion = ?, fecha = ?, orden = ? WHERE id = ?', [datos.titulo, datos.descripcion, datos.fecha, datos.orden, video.id]);
      await historialCambios(connection, cabecera, { entidad: 'VIDEO', entidad_id: video.id, olimpiada_id: video.olimpiada_id }, video, datos, ['titulo', 'descripcion', 'fecha', 'orden']);
    });
    const [[actualizado]] = await db.query('SELECT * FROM olimpiada_video WHERE id = ?', [video.id]);
    res.json({ success: true, message: 'Video actualizado', video: await serializar(actualizado) });
  }, 'No se pudo actualizar el video'));

  router.delete('/olimpiadas/videos/:videoId(\\d+)', verifyToken, endpoint(async (req, res) => {
    const cabecera = exigirSuperior(req, res);
    if (!cabecera) return;
    const video = await exigirVideo(idDeRuta(req.params.videoId));
    await enTransaccion(async (connection) => {
      await connection.query('UPDATE olimpiada_video SET eliminado = 1, subida_id = NULL, partes = NULL WHERE id = ?', [video.id]);
      if (video.estado === 'LISTO') {
        await historial(connection, cabecera, { entidad: 'VIDEO', entidad_id: video.id, olimpiada_id: video.olimpiada_id, tipo_operacion: 'DELETE', valor_anterior: video.titulo });
      }
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
