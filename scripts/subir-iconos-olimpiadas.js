// Reemplaza los íconos de las disciplinas de Olimpiadas en S3 por el set de scripts/olimpiadas-iconos/.
//
// Los íconos viven en S3 (olimpiada_disciplina.icono_archivo = "olimpiadas/disciplinas/<nombre>.svg") y se
// sirven con URL firmada, así que alcanza con pisar el objeto: la base no cambia. Sólo se suben los
// archivos cuya key ya usa alguna disciplina; antes de pisar cada uno se guarda el anterior en
// "olimpiadas/disciplinas/_anteriores/<nombre>-<fecha>.svg" para poder volver atrás.
//
// Uso:
//   node scripts/subir-iconos-olimpiadas.js            → sólo verifica (qué se subiría y qué falta)
//   node scripts/subir-iconos-olimpiadas.js --subir    → respalda y reemplaza en S3
//
// La base y el bucket salen del .env (hoy: producción). El bucket es el mismo para develop y producción.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const CARPETA = path.join(__dirname, "olimpiadas-iconos");
const PREFIJO = "olimpiadas/disciplinas/";
const subir = process.argv.includes("--subir");
// Paleta del sistema: azul, celeste, celestes claros, blanco y tinta. Nada fuera de esto.
const PALETA = new Set(["#0d5482", "#0097de", "#bfe6fa", "#e3f4fd", "#ffffff", "#12344d", "#fff"]);

function validar(nombre, svg) {
  const problemas = [];
  if (!/^<svg[^>]*viewBox="0 0 48 48"/.test(svg.trim())) problemas.push("viewBox distinto de 0 0 48 48");
  if (/<script|<style|<text|<image|href=|url\(/i.test(svg)) problemas.push("contenido no permitido");
  const colores = (svg.match(/#[0-9a-f]{3,6}\b/gi) || []).map((c) => c.toLowerCase());
  const ajenos = [...new Set(colores.filter((c) => !PALETA.has(c)))];
  if (ajenos.length) problemas.push(`colores fuera de la paleta: ${ajenos.join(", ")}`);
  if (Buffer.byteLength(svg) > 4096) problemas.push("pesa más de 4 KB");
  return problemas.map((p) => `${nombre}: ${p}`);
}

(async () => {
  const archivos = fs.readdirSync(CARPETA).filter((f) => f.endsWith(".svg")).sort();
  const errores = archivos.flatMap((f) => validar(f, fs.readFileSync(path.join(CARPETA, f), "utf8")));
  if (errores.length) {
    console.error("Íconos inválidos:\n" + errores.join("\n"));
    process.exit(1);
  }

  const db = await mysql.createConnection({
    host: process.env.DB_HOST?.trim(),
    user: process.env.DB_USER?.trim(),
    password: process.env.DB_PASSWORD?.trim(),
    database: process.env.DB_DATABASE?.trim(),
    port: Number(process.env.DB_PORT || 3306),
  });
  const [filas] = await db.query(
    "SELECT DISTINCT icono_archivo FROM olimpiada_disciplina WHERE icono_archivo LIKE ?",
    [`${PREFIJO}%`]
  );
  await db.end();
  const enUso = new Set(filas.map((f) => f.icono_archivo));

  const plan = archivos.map((f) => ({ archivo: f, key: PREFIJO + f })).filter((p) => enUso.has(p.key));
  const sinUso = archivos.filter((f) => !enUso.has(PREFIJO + f));
  const sinIcono = [...enUso].filter((k) => !archivos.includes(path.basename(k)));
  console.log(`Base: ${process.env.DB_HOST?.trim()} · ${enUso.size} keys en uso · ${plan.length} a reemplazar`);
  if (sinUso.length) console.log("Sin disciplina que los use (no se suben):", sinUso.join(", "));
  if (sinIcono.length) console.log("Keys en uso sin ícono nuevo (quedan como están):", sinIcono.join(", "));
  if (!subir) {
    console.log("Verificación OK. Para reemplazar en S3: --subir");
    return;
  }

  const s3 = new S3Client({
    region: process.env.BUCKET_REGION.trim(),
    credentials: { accessKeyId: process.env.ACCESS_KEY.trim(), secretAccessKey: process.env.SECRET_ACCESS_KEY.trim() },
  });
  const Bucket = process.env.BUCKET_NAME.trim();
  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (const { archivo, key } of plan) {
    const nuevo = fs.readFileSync(path.join(CARPETA, archivo));
    const actual = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
    const anterior = Buffer.from(await actual.Body.transformToByteArray());
    if (anterior.equals(nuevo)) {
      console.log(`= ${key} (ya estaba actualizado)`);
      continue;
    }
    const respaldo = `${PREFIJO}_anteriores/${archivo.replace(/\.svg$/, "")}-${fecha}.svg`;
    await s3.send(new PutObjectCommand({ Bucket, Key: respaldo, Body: anterior, ContentType: "image/svg+xml" }));
    await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: nuevo, ContentType: "image/svg+xml" }));
    console.log(`✓ ${key} (anterior en ${respaldo})`);
  }
  console.log("Listo.");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
