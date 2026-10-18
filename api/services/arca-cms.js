const { createPrivateKey, webcrypto, X509Certificate } = require("node:crypto");
const asn1js = require("asn1js");
const pkijs = require("pkijs");

// Un motor explícito evita modificar la configuración criptográfica global.
const crypto = new pkijs.CryptoEngine({ name: "Node WebCrypto", crypto: webcrypto });

/** Firma el TRA UTF-8 como CMS encapsulado, requerido por WSAA. */
async function firmarCms(traXml, certPem, keyPem) {
  const certificadoX509 = new X509Certificate(certPem);
  // Node acepta claves RSA PEM tanto PKCS#1 como PKCS#8.
  const clave = createPrivateKey(keyPem);
  if (clave.asymmetricKeyType !== "rsa" || certificadoX509.publicKey.asymmetricKeyType !== "rsa") {
    throw new TypeError("ARCA requiere un certificado y una clave privada RSA");
  }
  if (!certificadoX509.checkPrivateKey(clave)) {
    throw new Error("La clave privada de ARCA no corresponde al certificado");
  }

  const certificado = pkijs.Certificate.fromBER(certificadoX509.raw);
  const claveFirma = await webcrypto.subtle.importKey(
    "pkcs8",
    clave.export({ type: "pkcs8", format: "der" }),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const contenido = Buffer.from(traXml, "utf8");
  const digest = await webcrypto.subtle.digest("SHA-256", contenido);
  const fechaFirma = new Date();
  const Tiempo = fechaFirma.getUTCFullYear() < 2050 ? asn1js.UTCTime : asn1js.GeneralizedTime;
  const atributos = [
    new pkijs.Attribute({
      type: "1.2.840.113549.1.9.3", // contentType
      values: [new asn1js.ObjectIdentifier({ value: pkijs.ContentInfo.DATA })],
    }),
    new pkijs.Attribute({
      type: "1.2.840.113549.1.9.4", // messageDigest
      values: [new asn1js.OctetString({ valueHex: digest })],
    }),
    new pkijs.Attribute({
      type: "1.2.840.113549.1.9.5", // signingTime
      values: [new Tiempo({ valueDate: fechaFirma })],
    }),
  ];
  // RFC 5652: signedAttrs se firma como SET OF con orden canónico DER.
  atributos.sort((a, b) => Buffer.compare(
    Buffer.from(a.toSchema().toBER(false)),
    Buffer.from(b.toSchema().toBER(false))
  ));

  const contenidoCms = new pkijs.EncapsulatedContentInfo({ eContentType: pkijs.ContentInfo.DATA });
  // Asignarlo después del constructor conserva el OCTET STRING primitivo DER.
  contenidoCms.eContent = new asn1js.OctetString({ valueHex: contenido });
  const firmado = new pkijs.SignedData({
    version: 1,
    encapContentInfo: contenidoCms,
    certificates: [certificado],
    signerInfos: [new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({
        issuer: certificado.issuer,
        serialNumber: certificado.serialNumber,
      }),
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: atributos }),
    })],
  });
  await firmado.sign(claveFirma, 0, "SHA-256", undefined, crypto);
  const cms = new pkijs.ContentInfo({
    contentType: pkijs.ContentInfo.SIGNED_DATA,
    content: firmado.toSchema(true),
  });
  return Buffer.from(cms.toSchema().toBER(false)).toString("base64");
}

module.exports = { firmarCms };
