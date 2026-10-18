const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createHash,
  generateKeyPairSync,
  verify,
  webcrypto,
  X509Certificate,
} = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const asn1js = require("asn1js");
const pkijs = require("pkijs");
const { firmarCms } = require("../api/services/arca-cms");
const arca = require("../api/services/arca");

const crypto = new pkijs.CryptoEngine({ name: "Test WebCrypto", crypto: webcrypto });
const TRA = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header><uniqueId>123456789</uniqueId></header>
  <service>wscdc</service><!-- Asociación judicial: ñ, á, € -->
</loginTicketRequest>`;
let certificado;
let certPem;
let clavesPem;
let otraClavePem;

function pem(tipo, bytes) {
  return `-----BEGIN ${tipo}-----\n${Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${tipo}-----\n`;
}

function leerCms(base64) {
  const cms = pkijs.ContentInfo.fromBER(Buffer.from(base64, "base64"));
  assert.equal(cms.contentType, pkijs.ContentInfo.SIGNED_DATA);
  return new pkijs.SignedData({ schema: cms.content });
}

function codificarCms(firmado) {
  return Buffer.from(new pkijs.ContentInfo({
    contentType: pkijs.ContentInfo.SIGNED_DATA,
    content: firmado.toSchema(true),
  }).toSchema().toBER(false));
}

before(async () => {
  // Credenciales nuevas exclusivamente para pruebas; no se leen certificados de ARCA.
  const par = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const emisor = generateKeyPairSync("rsa", { modulusLength: 2048 });
  clavesPem = Object.fromEntries(["pkcs1", "pkcs8"].map((type) => [
    type, par.privateKey.export({ type, format: "pem" }),
  ]));
  otraClavePem = emisor.privateKey.export({ type: "pkcs8", format: "pem" });
  const claveEmisor = await webcrypto.subtle.importKey(
    "pkcs8", emisor.privateKey.export({ type: "pkcs8", format: "der" }),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  certificado = new pkijs.Certificate({
    version: 2,
    serialNumber: new asn1js.Integer({ value: 42 }),
    issuer: new pkijs.RelativeDistinguishedNames({ typesAndValues: [
      new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: "CA de pruebas" }) }),
    ] }),
    subject: new pkijs.RelativeDistinguishedNames({ typesAndValues: [
      new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: "Firmante de pruebas" }) }),
    ] }),
    notBefore: new pkijs.Time({ value: new Date(Date.now() - 60_000) }),
    notAfter: new pkijs.Time({ value: new Date(Date.now() + 86_400_000) }),
    subjectPublicKeyInfo: pkijs.PublicKeyInfo.fromBER(par.publicKey.export({ type: "spki", format: "der" })),
  });
  await certificado.sign(claveEmisor, "SHA-256", crypto);
  certPem = pem("CERTIFICATE", certificado.toSchema(true).toBER(false));
});

for (const tipo of ["pkcs1", "pkcs8"]) {
  test(`ARCA firma CMS verificable con clave RSA ${tipo.toUpperCase()} y conserva el TRA UTF-8`, async () => {
    const inicio = Date.now();
    const base64 = await firmarCms(TRA, certPem, clavesPem[tipo]);
    assert.match(base64, /^[A-Za-z0-9+/]+={0,2}$/);
    const firmado = leerCms(base64);
    assert.equal(firmado.version, 1);
    assert.equal(firmado.encapContentInfo.eContentType, pkijs.ContentInfo.DATA);
    assert.equal(firmado.encapContentInfo.eContent.idBlock.isConstructed, false);
    assert.deepEqual(Buffer.from(firmado.encapContentInfo.eContent.getValue()), Buffer.from(TRA, "utf8"));
    assert.equal(firmado.certificates.length, 1);
    assert.deepEqual(Buffer.from(firmado.certificates[0].toSchema().toBER(false)), new X509Certificate(certPem).raw);
    assert.deepEqual(firmado.digestAlgorithms.map((alg) => alg.algorithmId), ["2.16.840.1.101.3.4.2.1"]);
    assert.equal(firmado.signerInfos.length, 1);
    const firmante = firmado.signerInfos[0];
    assert.equal(firmante.version, 1);
    assert.equal(firmante.sid.issuer.isEqual(certificado.issuer), true);
    assert.equal(firmante.sid.serialNumber.isEqual(certificado.serialNumber), true);
    assert.equal(firmante.digestAlgorithm.algorithmId, "2.16.840.1.101.3.4.2.1");
    assert.equal(firmante.signatureAlgorithm.algorithmId, "1.2.840.113549.1.1.11");
    const attrs = firmante.signedAttrs.attributes;
    assert.deepEqual(attrs.map((attr) => attr.type).sort(), [
      "1.2.840.113549.1.9.3", "1.2.840.113549.1.9.4", "1.2.840.113549.1.9.5",
    ]);
    const valor = (oid) => attrs.find((attr) => attr.type === oid).values[0];
    assert.equal(valor("1.2.840.113549.1.9.3").valueBlock.toString(), pkijs.ContentInfo.DATA);
    assert.deepEqual(Buffer.from(valor("1.2.840.113549.1.9.4").getValue()), createHash("sha256").update(TRA, "utf8").digest());
    const fechaFirma = valor("1.2.840.113549.1.9.5").toDate().getTime();
    assert.ok(fechaFirma >= inicio - 1000 && fechaFirma <= Date.now());
    const atributosDer = attrs.map((attr) => Buffer.from(attr.toSchema().toBER(false)));
    assert.deepEqual(atributosDer, [...atributosDer].sort(Buffer.compare));
    assert.equal(await firmado.verify({ signer: 0, checkChain: false }, crypto), true);
    // Verificación independiente con OpenSSL de Node, sin el verificador de PKIjs.
    assert.equal(verify("sha256", Buffer.from(firmante.signedAttrs.encodedValue),
      new X509Certificate(certPem).publicKey, Buffer.from(firmante.signature.getValue())), true);
  });
}

test("ARCA CMS rechaza alteraciones del contenido y de la firma", async () => {
  const base64 = await firmarCms(TRA, certPem, clavesPem.pkcs8);
  const contenidoAlterado = leerCms(base64);
  contenidoAlterado.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: Buffer.from(`${TRA} `, "utf8") });
  await assert.rejects(() => contenidoAlterado.verify({ signer: 0, checkChain: false }, crypto), /digest doesn't match/);

  const firmaAlterada = leerCms(base64);
  firmaAlterada.signerInfos[0].signature.valueBlock.valueHexView[0] ^= 1;
  assert.equal(await firmaAlterada.verify({ signer: 0, checkChain: false }, crypto), false);
});

test("ARCA CMS rechaza certificados o claves inválidos, claves ajenas y claves no RSA", async () => {
  await assert.rejects(() => firmarCms(TRA, "certificado inválido", clavesPem.pkcs8));
  await assert.rejects(() => firmarCms(TRA, certPem, "clave inválida"));
  await assert.rejects(() => firmarCms(TRA, certPem, certPem));
  await assert.rejects(() => firmarCms(TRA, certPem, otraClavePem), /no corresponde al certificado/);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await assert.rejects(() => firmarCms(TRA, certPem, ec.privateKey.export({ type: "pkcs8", format: "pem" })), /requiere.*RSA/);
});

test("OpenSSL verifica el CMS generado y rechaza contenido alterado", async (t) => {
  const disponible = spawnSync("openssl", ["version"], { timeout: 10_000, windowsHide: true });
  if (disponible.error?.code === "ENOENT") {
    t.skip("OpenSSL CLI no está instalado; la verificación nativa de Node se ejecuta en las otras pruebas");
    return;
  }
  assert.equal(disponible.status, 0, disponible.error?.message || disponible.stderr.toString());
  const base64 = await firmarCms(TRA, certPem, clavesPem.pkcs8);
  const args = ["cms", "-verify", "-inform", "DER", "-binary", "-noverify"];
  const verificado = spawnSync("openssl", args, {
    input: Buffer.from(base64, "base64"), timeout: 10_000, windowsHide: true,
  });
  assert.equal(verificado.status, 0, verificado.error?.message || verificado.stderr.toString());
  assert.deepEqual(verificado.stdout, Buffer.from(TRA, "utf8"));
  const alterado = leerCms(base64);
  alterado.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: Buffer.from(`${TRA} alterado`, "utf8") });
  const rechazado = spawnSync("openssl", args, {
    input: codificarCms(alterado), timeout: 10_000, windowsHide: true,
  });
  assert.ifError(rechazado.error);
  assert.notEqual(rechazado.status, 0);
});

test("WSAA espera la firma y envía un CMS completo antes de leer el ticket", async (t) => {
  const variables = ["ARCA_CUIT", "ARCA_CERT_PATH", "ARCA_KEY_PATH", "ARCA_ENTORNO"];
  const entornoAnterior = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of variables) {
      if (entornoAnterior[key] === undefined) delete process.env[key];
      else process.env[key] = entornoAnterior[key];
    }
  });
  process.env.ARCA_CUIT = "20123456789";
  process.env.ARCA_CERT_PATH = "cms-prueba.crt";
  process.env.ARCA_KEY_PATH = "cms-prueba.key";
  process.env.ARCA_ENTORNO = "homologacion";
  const raiz = path.resolve(__dirname, "..");
  const archivos = new Map([
    [path.join(raiz, "cms-prueba.crt"), certPem],
    [path.join(raiz, "cms-prueba.key"), clavesPem.pkcs1],
  ]);
  const existsSync = fs.existsSync;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "existsSync", (ruta) => archivos.has(ruta) || existsSync(ruta));
  t.mock.method(fs, "readFileSync", (ruta, ...args) => archivos.has(ruta) ? archivos.get(ruta) : readFileSync(ruta, ...args));
  // El TA de prueba tampoco se escribe sobre el cache real.
  const rutaCache = path.join(raiz, "certificados", "arca", "ta-wscdc-homologacion.json");
  t.mock.method(fs, "writeFileSync", (ruta) => assert.equal(ruta, rutaCache));
  t.mock.method(fs, "chmodSync", (ruta) => assert.equal(ruta, rutaCache));
  let llamadas = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    llamadas++;
    assert.equal(url, "https://wsaahomo.afip.gov.ar/ws/services/LoginCms");
    assert.equal(options.method, "POST");
    const cms = /<wsaa:in0>([A-Za-z0-9+/=]+)<\/wsaa:in0>/.exec(options.body);
    assert.ok(cms, "El SOAP debe contener Base64 firmado, no una Promise");
    const firmado = leerCms(cms[1]);
    assert.equal(await firmado.verify({ signer: 0, checkChain: false }, crypto), true);
    assert.match(Buffer.from(firmado.encapContentInfo.eContent.getValue()).toString("utf8"), /<service>wscdc<\/service>/);
    return {
      ok: true,
      text: async () => "<loginCmsReturn>&lt;token&gt;token-prueba&lt;/token&gt;&lt;sign&gt;sign-prueba&lt;/sign&gt;</loginCmsReturn>",
    };
  });
  const ta = await arca.obtenerTicketAcceso(true);
  assert.equal(llamadas, 1);
  assert.equal(ta.token, "token-prueba");
  assert.equal(ta.sign, "sign-prueba");
});
