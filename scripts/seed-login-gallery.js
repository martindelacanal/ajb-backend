const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const sourceDirectory = path.resolve(__dirname, "..", "..", "BD", "imagenes-propuestas");
const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const contentTypes = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function assertConfiguration() {
  const required = [
    "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE", "DB_PORT",
    "BUCKET_NAME", "BUCKET_REGION", "ACCESS_KEY", "SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno requeridas: ${missing.join(", ")}`);
  }
}

async function ensureTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS login_imagen (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      archivo VARCHAR(512) NOT NULL,
      nombre_original VARCHAR(255) NULL,
      titulo VARCHAR(120) NULL,
      texto_alternativo VARCHAR(255) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      orden INT NOT NULL DEFAULT 0,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_actualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_login_imagen_archivo (archivo),
      KEY idx_login_imagen_publicacion (activo, orden, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function titleFromFileName(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function run() {
  assertConfiguration();
  if (!fs.existsSync(sourceDirectory)) {
    throw new Error(`No existe el directorio de imágenes iniciales: ${sourceDirectory}`);
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
  });
  const s3 = new S3Client({
    region: process.env.BUCKET_REGION,
    credentials: {
      accessKeyId: process.env.ACCESS_KEY,
      secretAccessKey: process.env.SECRET_ACCESS_KEY,
    },
  });

  const uploaded = [];
  const skipped = [];
  try {
    await ensureTable(connection);
    const files = fs.readdirSync(sourceDirectory)
      .filter((name) => supportedExtensions.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "es"));

    for (let index = 0; index < files.length; index += 1) {
      const fileName = files[index];
      const [existing] = await connection.query(
        "SELECT id FROM login_imagen WHERE nombre_original = ? LIMIT 1",
        [fileName]
      );
      if (existing.length > 0) {
        skipped.push(fileName);
        continue;
      }

      const extension = path.extname(fileName).toLowerCase();
      const key = `login/fondos/inicial_${Date.now()}_${crypto.randomBytes(8).toString("hex")}${extension}`;
      const body = fs.readFileSync(path.join(sourceDirectory, fileName));
      await s3.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentTypes[extension],
      }));

      try {
        const title = titleFromFileName(fileName);
        await connection.query(
          `
            INSERT INTO login_imagen
              (archivo, nombre_original, titulo, texto_alternativo, activo, orden)
            VALUES (?, ?, ?, ?, 1, ?)
          `,
          [key, fileName, title, `Paisaje de ${title} para el acceso a MiAJB`, index]
        );
        uploaded.push(fileName);
      } catch (error) {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
        throw error;
      }
    }

    console.log(JSON.stringify({ success: true, uploaded, skipped, total: uploaded.length + skipped.length }));
  } finally {
    await connection.end();
    s3.destroy();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ success: false, code: error.code || error.name, message: error.message }));
  process.exit(1);
});
