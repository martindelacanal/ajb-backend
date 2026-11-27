const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

const MIB = 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * MIB;
const LIMITE_POR_RANGO = MIB;
const LIMITE_LECTURA = 16 * MIB;
const LIMITE_SOLICITUDES = 32;
const LIMITE_JPEG = MIB;
const PLAZO_MS = 15_000;
const FORMATOS = new Map([['video/mp4', 'mov'], ['video/quicktime', 'mov'], ['video/webm', 'matroska']]);

// FFmpeg puede saltar hasta el índice del MOV al final del objeto sin tener la URL de S3
// ni las credenciales. El puente solamente sirve rangos de la clave fija de este video.
function abrirPuente({ clienteS3, bucket, key, bytes, mime }, tarea) {
  const ruta = `/${randomUUID()}`;
  let solicitudes = 0;
  let presupuesto = LIMITE_LECTURA;
  const sockets = new Set();
  const servidor = createServer({ requestTimeout: PLAZO_MS, headersTimeout: 3_000, keepAliveTimeout: 1_000 }, (req, res) => {
    servir(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
      else res.destroy();
    });
  });
  servidor.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function servir(req, res) {
    if (req.method !== 'GET' || req.url !== ruta || tarea.signal.aborted) {
      res.writeHead(404).end();
      return;
    }
    const rango = /^bytes=(\d{1,10})-(\d{0,10})$/.exec(req.headers.range || 'bytes=0-');
    const inicio = rango ? Number(rango[1]) : bytes;
    const fin = Math.min(bytes - 1, inicio + Math.min(LIMITE_POR_RANGO, presupuesto) - 1, rango?.[2] ? Number(rango[2]) : Infinity);
    if (inicio > fin || ++solicitudes > LIMITE_SOLICITUDES) {
      res.writeHead(416, { 'Content-Range': `bytes */${bytes}` }).end();
      return;
    }

    const pedido = new AbortController();
    res.once('close', () => pedido.abort());
    const signal = AbortSignal.any([tarea.signal, pedido.signal]);
    const esperado = `bytes ${inicio}-${fin}/${bytes}`;
    const longitud = fin - inicio + 1;
    presupuesto -= longitud;
    const objeto = await clienteS3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${inicio}-${fin}` }), { abortSignal: signal });
    if (!objeto.Body || objeto.ContentRange !== esperado || objeto.ContentLength !== longitud || signal.aborted) {
      objeto.Body?.destroy?.();
      throw new Error('Rango inválido');
    }
    res.writeHead(206, { 'Content-Range': esperado, 'Content-Length': longitud, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });

    let transferidos = 0;
    const limitar = new Transform({
      transform(bloque, _codificacion, listo) {
        transferidos += bloque.length;
        if (transferidos > longitud) {
          tarea.abort();
          listo(new Error('Límite de lectura del video'));
          return;
        }
        listo(null, bloque);
      },
    });
    await pipeline(objeto.Body, limitar, res, { signal });
  }

  return {
    iniciar: () => new Promise((resolve, reject) => {
      servidor.once('error', reject);
      servidor.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${servidor.address().port}${ruta}`));
    }),
    cerrar: () => {
      servidor.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

function extraerJpeg(url, formato, signal) {
  const ejecutable = process.env.OLIMPIADAS_FFMPEG || '/usr/bin/ffmpeg';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', String(64 * MIB), '-filter_threads', '1',
    '-protocol_whitelist', 'http,tcp', '-rw_timeout', '5000000', '-seekable', '1', '-reconnect', '1', '-reconnect_delay_max', '1',
    '-probesize', String(8 * MIB), '-analyzeduration', '3000000', '-max_pixels', '16777216', '-threads', '1', '-f', formato, '-i', url,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', "scale='min(800,iw)':'min(800,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1',
  ];
  return new Promise(resolve => {
    const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
    const hijo = spawn(ejecutable, args, { env, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], killSignal: 'SIGKILL' });
    const partes = [];
    let longitud = 0;
    hijo.stdout.on('data', bloque => {
      longitud += bloque.length;
      if (longitud > LIMITE_JPEG) hijo.kill('SIGKILL');
      else partes.push(bloque);
    });
    hijo.once('error', () => resolve(null));
    hijo.once('close', codigo => {
      resolve(codigo === 0 && longitud >= 4 && longitud <= LIMITE_JPEG ? Buffer.concat(partes, longitud) : null);
    });
  });
}

async function capturarPortadaVideo(datos) {
  const { clienteS3, bucket, key, bytes, mime } = datos;
  const formato = FORMATOS.get(mime);
  if (!formato || !clienteS3 || !bucket || !key || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_VIDEO_BYTES) return null;
  const tarea = new AbortController();
  const plazo = setTimeout(() => tarea.abort(), PLAZO_MS);
  const puente = abrirPuente(datos, tarea);
  try {
    const url = await puente.iniciar();
    const buffer = await extraerJpeg(url, formato, tarea.signal);
    if (buffer?.[0] !== 0xff || buffer[1] !== 0xd8 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
    return { buffer, fieldname: 'POSTER', mimetype: 'image/jpeg' };
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(plazo);
    tarea.abort();
    puente.cerrar();
  }
}

module.exports = { capturarPortadaVideo };
