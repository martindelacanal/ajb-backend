const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmdirSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { capturarPortadaVideo } = require('../api/services/olimpiadas-portada-video');

const ejecutable = process.env.OLIMPIADAS_FFMPEG || '/usr/bin/ffmpeg';
const disponible = spawnSync(ejecutable, ['-version'], { stdio: 'ignore', timeout: 2_000 }).status === 0;
const argumento = { bucket: 'galeria-prueba', key: 'video-falso.mov', mime: 'video/quicktime' };
const MIB = 1024 * 1024;

test('rechaza tamaños y contenedores desconocidos antes de leer S3', async () => {
  const clienteS3 = { send: () => assert.fail('No se debe leer S3') };
  for (const invalido of [{ bytes: 0 }, { bytes: 1024 * MIB + 1 }, { bytes: 1.5 }, { bytes: MIB, mime: 'video/x-msvideo' }]) {
    assert.equal(await capturarPortadaVideo({ ...argumento, clienteS3, ...invalido }), null);
  }
});

function crearMov() {
  const temporal = mkdtempSync(join(tmpdir(), 'miajb-mov-'));
  const archivo = join(temporal, 'prueba.mov');
  try {
    const captura = spawnSync(ejecutable, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=96x54:r=10', '-t', '1',
      '-threads', '1', '-an', '-c:v', 'mpeg4', '-f', 'mov', '-y', archivo,
    ], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
    assert.equal(captura.status, 0);
    return readFileSync(archivo);
  } finally {
    try { unlinkSync(archivo); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(temporal);
  }
}

function clienteConRangos(video, pedidos) {
  return {
    async send(comando) {
      assert.ok(comando instanceof GetObjectCommand);
      assert.equal(comando.input.Bucket, argumento.bucket);
      assert.equal(comando.input.Key, argumento.key);
      const [, primero, ultimo] = /^bytes=(\d+)-(\d+)$/.exec(comando.input.Range) || [];
      const desde = Number(primero);
      const hasta = Number(ultimo);
      assert.ok(hasta >= desde && hasta < video.length);
      pedidos.push({ desde, hasta });
      return {
        Body: Readable.from([video.subarray(desde, hasta + 1)]),
        ContentLength: hasta - desde + 1, ContentRange: `bytes ${desde}-${hasta}/${video.length}`,
      };
    },
  };
}

test('devuelve un JPEG del primer cuadro de un MOV con su índice lejos del inicio', { skip: !disponible, timeout: 20_000 }, async () => {
  const mov = crearMov();
  let indice = 0;
  while (mov.toString('ascii', indice + 4, indice + 8) !== 'moov') indice += mov.readUInt32BE(indice);
  const relleno = Buffer.alloc(6 * MIB);
  relleno.writeUInt32BE(relleno.length);
  relleno.write('free', 4, 'ascii');
  const video = Buffer.concat([mov.subarray(0, indice), relleno, mov.subarray(indice)]);
  const pedidos = [];
  const portada = await capturarPortadaVideo({ ...argumento, clienteS3: clienteConRangos(video, pedidos), bytes: video.length });
  assert.ok(portada);
  assert.equal(portada.fieldname, 'POSTER');
  assert.equal(portada.mimetype, 'image/jpeg');
  assert.deepEqual(portada.buffer.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.ok(pedidos.some(rango => rango.desde >= relleno.length));
  assert.ok(pedidos.some(rango => rango.desde < indice));
  assert.ok(pedidos.every(rango => rango.hasta - rango.desde + 1 <= MIB));
  assert.ok(pedidos.reduce((suma, rango) => suma + rango.hasta - rango.desde + 1, 0) < video.length);
});

test('devuelve null si S3 no entrega el rango solicitado', { skip: !disponible, timeout: 20_000 }, async () => {
  let fallo = false;
  const clienteS3 = { send: async () => { fallo = true; return {}; } };
  assert.equal(await capturarPortadaVideo({ ...argumento, clienteS3, bytes: 64 }), null);
  assert.equal(fallo, true);
});
