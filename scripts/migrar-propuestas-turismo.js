const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;

const imagesDirectory = path.resolve(__dirname, "..", "..", "BD", "imagenes-propuestas");

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const propuestas = [
  {
    orden: 1,
    titulo: "Camping (Miramar)",
    fileName: "camping.png",
    key: "turismo_propuestas/camping.png",
    link: "https://ajb.org.ar/turismo-ajb-campamento-de-miramar/",
  },
  {
    orden: 2,
    titulo: "Parador de la Monta\u00f1a (C\u00f3rdoba)",
    fileName: "parador.jpg",
    key: "turismo_propuestas/parador.jpg",
    link: "https://ajb.org.ar/turismo-ajb-el-parador-de-la-montana/",
  },
  {
    orden: 3,
    titulo: "Casa Sol\u00eds (CABA)",
    fileName: "casasolis.png",
    key: "turismo_propuestas/casasolis.png",
    link: "https://ajb.org.ar/turismo-ajb-casa-solis/",
  },
  {
    orden: 4,
    titulo: "Caba\u00f1as (Miramar)",
    fileName: "cabanias.png",
    key: "turismo_propuestas/cabanias.png",
    link: "https://ajb.org.ar/turismo-ajb-camping-miramar/",
  },
];

function assertEnvVar(value, name) {
  if (!value) {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
}

function getMimeTypeFromFileName(fileName) {
  const extension = (fileName || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || "application/octet-stream";
}

async function uploadFileToS3(s3, propuesta) {
  const filePath = path.join(imagesDirectory, propuesta.fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No existe la imagen requerida: ${filePath}`);
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: propuesta.key,
      Body: fs.readFileSync(filePath),
      ContentType: getMimeTypeFromFileName(propuesta.fileName),
    })
  );
}

async function ensureTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS turismo_propuesta (
      id INT NOT NULL AUTO_INCREMENT,
      titulo VARCHAR(120) NOT NULL,
      imagen_archivo VARCHAR(260) NOT NULL,
      link VARCHAR(500) NOT NULL,
      orden INT NOT NULL,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_turismo_propuesta_orden (orden),
      KEY idx_turismo_propuesta_orden (orden)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function seedPropuestas(connection) {
  for (const propuesta of propuestas) {
    await connection.query(
      `
        INSERT INTO turismo_propuesta (titulo, imagen_archivo, link, orden)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          titulo = IF(titulo IS NULL OR titulo = '', VALUES(titulo), titulo),
          imagen_archivo = IF(imagen_archivo IS NULL OR imagen_archivo = '', VALUES(imagen_archivo), imagen_archivo),
          link = IF(link IS NULL OR link = '', VALUES(link), link)
      `,
      [propuesta.titulo, propuesta.key, propuesta.link, propuesta.orden]
    );
  }
}

async function main() {
  assertEnvVar(bucketName, "BUCKET_NAME");
  assertEnvVar(bucketRegion, "BUCKET_REGION");
  assertEnvVar(accessKey, "ACCESS_KEY");
  assertEnvVar(secretAccessKey, "SECRET_ACCESS_KEY");
  assertEnvVar(process.env.DB_HOST, "DB_HOST");
  assertEnvVar(process.env.DB_USER, "DB_USER");
  assertEnvVar(process.env.DB_DATABASE, "DB_DATABASE");

  const s3 = new S3Client({
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey,
    },
    region: bucketRegion,
  });

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    multipleStatements: true,
  });

  try {
    await ensureTable(connection);
    for (const propuesta of propuestas) {
      await uploadFileToS3(s3, propuesta);
      console.log(`[OK] ${propuesta.fileName} -> ${propuesta.key}`);
    }
    await seedPropuestas(connection);
    console.log("Propuestas de turismo migradas correctamente.");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Fallo la migracion de propuestas de turismo:", error.message);
  process.exit(1);
});
