/**
 * Cliente de webservices de ARCA (ex AFIP) para el módulo de coseguro médico.
 *
 *  - WSAA  : autenticación. Se firma un "ticket de requerimiento" (TRA) con el
 *            certificado digital (CMS/PKCS#7) y ARCA devuelve un ticket de acceso
 *            (TA: token + sign) válido por 12 horas. Se cachea en disco.
 *  - WSCDC : "Constatación de Comprobantes": valida que una factura exista
 *            realmente en ARCA (CUIT emisor + punto de venta + número + fecha +
 *            importe + CAE).
 *
 * Configuración en .env:
 *   ARCA_CUIT      = CUIT del titular del certificado (sin guiones)
 *   ARCA_CERT_PATH = ruta al .crt (relativa a la carpeta BACKEND)
 *   ARCA_KEY_PATH  = ruta al .key (relativa a la carpeta BACKEND)
 *   ARCA_ENTORNO   = produccion | homologacion
 */
const fs = require("fs");
const path = require("path");
const forge = require("node-forge");
const moment = require("moment");

const RAIZ_BACKEND = path.join(__dirname, "..", "..");

const URLS = {
  produccion: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wscdc: "https://servicios1.afip.gov.ar/wscdc/service.asmx",
  },
  homologacion: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wscdc: "https://wswhomo.afip.gov.ar/wscdc/service.asmx",
  },
};

function configuracion() {
  const cuit = String(process.env.ARCA_CUIT || "").replace(/\D/g, "");
  const certPath = process.env.ARCA_CERT_PATH ? path.resolve(RAIZ_BACKEND, process.env.ARCA_CERT_PATH) : null;
  const keyPath = process.env.ARCA_KEY_PATH ? path.resolve(RAIZ_BACKEND, process.env.ARCA_KEY_PATH) : null;
  const entorno = (process.env.ARCA_ENTORNO || "produccion").toLowerCase() === "homologacion" ? "homologacion" : "produccion";
  const configurado = Boolean(cuit && certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath));
  return { cuit, certPath, keyPath, entorno, configurado, urls: URLS[entorno] };
}

function rutaCacheTa(entorno) {
  return path.join(RAIZ_BACKEND, "certificados", "arca", `ta-wscdc-${entorno}.json`);
}

// ---------------------------------------------------------------------------
// WSAA
// ---------------------------------------------------------------------------
function generarTra() {
  const uniqueId = Math.floor(Date.now() / 1000);
  const generado = moment().subtract(5, "minutes").format();
  const expira = moment().add(10, "minutes").format();
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generado}</generationTime>
    <expirationTime>${expira}</expirationTime>
  </header>
  <service>wscdc</service>
</loginTicketRequest>`;
}

function firmarCms(traXml, certPem, keyPem) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, "utf8");
  const certificado = forge.pki.certificateFromPem(certPem);
  const clave = forge.pki.privateKeyFromPem(keyPem);
  p7.addCertificate(certificado);
  p7.addSigner({
    key: clave,
    certificate: certificado,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

function desescaparXml(texto) {
  return String(texto || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extraerTag(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match ? match[1].trim() : null;
}

async function obtenerTicketAcceso(forzar = false) {
  const config = configuracion();
  if (!config.configurado) {
    throw new Error("ARCA no está configurado: completá ARCA_CUIT, ARCA_CERT_PATH y ARCA_KEY_PATH en el .env");
  }

  // Ticket cacheado (dura 12 horas; pedir uno nuevo con uno vigente da error en WSAA)
  const rutaCache = rutaCacheTa(config.entorno);
  if (!forzar && fs.existsSync(rutaCache)) {
    try {
      const cacheado = JSON.parse(fs.readFileSync(rutaCache, "utf8"));
      if (cacheado.expirationTime && moment(cacheado.expirationTime).isAfter(moment().add(5, "minutes"))) {
        return cacheado;
      }
    } catch (e) {
      // cache corrupto: se pide uno nuevo
    }
  }

  const certPem = fs.readFileSync(config.certPath, "utf8");
  const keyPem = fs.readFileSync(config.keyPath, "utf8");
  const cms = firmarCms(generarTra(), certPem, keyPem);

  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cms}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const respuesta = await fetch(config.urls.wsaa, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: soap,
  });
  const cuerpo = await respuesta.text();

  const fault = extraerTag(cuerpo, "faultstring");
  if (fault) {
    const error = new Error(`WSAA rechazó el login: ${fault}`);
    error.faultWsaa = fault;
    throw error;
  }
  if (!respuesta.ok) throw new Error(`WSAA devolvió HTTP ${respuesta.status}`);

  const loginReturn = desescaparXml(extraerTag(cuerpo, "loginCmsReturn"));
  const token = extraerTag(loginReturn, "token");
  const sign = extraerTag(loginReturn, "sign");
  const expirationTime = extraerTag(loginReturn, "expirationTime");
  if (!token || !sign) throw new Error("WSAA no devolvió token/sign (respuesta inesperada)");

  const ta = { token, sign, expirationTime, obtenido: moment().format() };
  try {
    fs.writeFileSync(rutaCache, JSON.stringify(ta, null, 2));
  } catch (e) {
    console.error("No se pudo cachear el TA de ARCA:", e.message);
  }
  return ta;
}

// ---------------------------------------------------------------------------
// WSCDC
// ---------------------------------------------------------------------------
function escaparXml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function llamarWscdc(metodo, cuerpoXml) {
  const config = configuracion();
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://servicios1.afip.gob.ar/wscdc/">
  <soap:Body>
    <ws:${metodo}>${cuerpoXml}</ws:${metodo}>
  </soap:Body>
</soap:Envelope>`;
  const respuesta = await fetch(config.urls.wscdc, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `http://servicios1.afip.gob.ar/wscdc/${metodo}`,
    },
    body: soap,
  });
  const texto = await respuesta.text();
  const fault = extraerTag(texto, "faultstring");
  if (fault) throw new Error(`WSCDC: ${fault}`);
  if (!respuesta.ok) throw new Error(`WSCDC devolvió HTTP ${respuesta.status}`);
  return texto;
}

function extraerLista(xml, contenedor) {
  const bloque = extraerTag(xml, contenedor);
  if (!bloque) return [];
  const items = [];
  const regex = /<Code>([\s\S]*?)<\/Code>\s*<Msg>([\s\S]*?)<\/Msg>/gi;
  let match;
  while ((match = regex.exec(bloque)) !== null) {
    items.push({ codigo: match[1].trim(), mensaje: desescaparXml(match[2].trim()) });
  }
  return items;
}

/** Prueba de conectividad del servicio (no requiere datos de comprobante) */
async function comprobanteDummy() {
  const xml = await llamarWscdc("ComprobanteDummy", "");
  return {
    app_server: extraerTag(xml, "AppServer"),
    db_server: extraerTag(xml, "DbServer"),
    auth_server: extraerTag(xml, "AuthServer"),
  };
}

/**
 * Constata un comprobante contra ARCA.
 * datos: { cuit_emisor, pto_venta, numero, fecha (YYYY-MM-DD), importe, cod_autorizacion (CAE/CAI),
 *          cbte_tipo (código ARCA, ej: 11 = Factura C), doc_tipo_receptor?, doc_nro_receptor? }
 */
async function constatarComprobante(datos) {
  const config = configuracion();
  const ta = await obtenerTicketAcceso();

  const receptor = datos.doc_nro_receptor
    ? `<ws:DocTipoReceptor>${escaparXml(datos.doc_tipo_receptor || "80")}</ws:DocTipoReceptor>
       <ws:DocNroReceptor>${escaparXml(datos.doc_nro_receptor)}</ws:DocNroReceptor>`
    : "";

  const cuerpo = `
      <ws:Auth>
        <ws:Token>${ta.token}</ws:Token>
        <ws:Sign>${ta.sign}</ws:Sign>
        <ws:Cuit>${config.cuit}</ws:Cuit>
      </ws:Auth>
      <ws:CmpReq>
        <ws:CbteModo>${escaparXml(datos.cbte_modo || "CAE")}</ws:CbteModo>
        <ws:CuitEmisor>${escaparXml(datos.cuit_emisor)}</ws:CuitEmisor>
        <ws:PtoVta>${Number(datos.pto_venta)}</ws:PtoVta>
        <ws:CbteTipo>${Number(datos.cbte_tipo)}</ws:CbteTipo>
        <ws:CbteNro>${Number(datos.numero)}</ws:CbteNro>
        <ws:CbteFch>${moment(datos.fecha).format("YYYYMMDD")}</ws:CbteFch>
        <ws:ImpTotal>${Number(datos.importe).toFixed(2)}</ws:ImpTotal>
        <ws:CodAutorizacion>${escaparXml(String(datos.cod_autorizacion || "").replace(/\D/g, ""))}</ws:CodAutorizacion>
        ${receptor}
      </ws:CmpReq>`;

  const xml = await llamarWscdc("ComprobanteConstatar", cuerpo);
  const resultado = extraerTag(xml, "Resultado"); // 'A' aprobado / 'R' rechazado
  return {
    resultado,
    aprobado: resultado === "A",
    fecha_proceso: extraerTag(xml, "FchProceso"),
    observaciones: extraerLista(xml, "Observaciones"),
    errores: extraerLista(xml, "Errors"),
    entorno: config.entorno,
  };
}

// Códigos de tipo de comprobante ARCA más comunes para reintegros médicos
const TIPOS_COMPROBANTE_ARCA = [
  { codigo: 1, nombre: "Factura A" },
  { codigo: 6, nombre: "Factura B" },
  { codigo: 11, nombre: "Factura C" },
  { codigo: 51, nombre: "Factura M" },
  { codigo: 19, nombre: "Factura E (exportación)" },
  { codigo: 4, nombre: "Recibo A" },
  { codigo: 9, nombre: "Recibo B" },
  { codigo: 15, nombre: "Recibo C" },
  { codigo: 81, nombre: "Tique Factura A" },
  { codigo: 82, nombre: "Tique Factura B" },
  { codigo: 111, nombre: "Tique Factura C" },
  { codigo: 83, nombre: "Tique" },
];

module.exports = {
  configuracion,
  obtenerTicketAcceso,
  comprobanteDummy,
  constatarComprobante,
  TIPOS_COMPROBANTE_ARCA,
};
