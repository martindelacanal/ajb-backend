const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;

const imagesDirectory = path.resolve(__dirname, "..", "imagenes");

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function getMimeTypeFromFileName(fileName) {
  const extension = (fileName || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || "application/octet-stream";
}

function assertEnvVar(value, name) {
  if (!value) {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
}

function listFilesInDirectory(directoryPath) {
  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directoryPath, entry.name));
}

async function uploadFileToS3(s3, filePath) {
  const fileName = path.basename(filePath);
  const contentType = getMimeTypeFromFileName(fileName);
  const fileBuffer = fs.readFileSync(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );
}

async function main() {
  assertEnvVar(bucketName, "BUCKET_NAME");
  assertEnvVar(bucketRegion, "BUCKET_REGION");
  assertEnvVar(accessKey, "ACCESS_KEY");
  assertEnvVar(secretAccessKey, "SECRET_ACCESS_KEY");

  if (!fs.existsSync(imagesDirectory)) {
    throw new Error(`No existe la carpeta de imagenes: ${imagesDirectory}`);
  }

  const files = listFilesInDirectory(imagesDirectory);
  if (files.length === 0) {
    console.log("No se encontraron archivos para migrar.");
    return;
  }

  const s3 = new S3Client({
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretAccessKey,
    },
    region: bucketRegion,
  });

  console.log(`Iniciando migracion de ${files.length} archivos a S3 (${bucketName})...`);

  let successCount = 0;
  let errorCount = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    try {
      await uploadFileToS3(s3, filePath);
      successCount += 1;
      console.log(`[OK] ${fileName}`);
    } catch (error) {
      errorCount += 1;
      console.error(`[ERROR] ${fileName}:`, error.message);
    }
  }

  console.log("Migracion finalizada.");
  console.log(`Exitosos: ${successCount}`);
  console.log(`Con error: ${errorCount}`);

  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Fallo la migracion:", error.message);
  process.exit(1);
});
