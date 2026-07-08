const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const testimonios = [
  {
    orden: 1,
    nombre: "María Laura G.",
    localidad: "La Plata, Buenos Aires",
    estrellas: 5,
    comentario: "La atención y los precios son excelentes. Siempre es nuestra primera opción.",
  },
  {
    orden: 2,
    nombre: "Carlos D.",
    localidad: "Bahía Blanca, Buenos Aires",
    estrellas: 5,
    comentario: "Reservar es muy fácil y los lugares son increíbles. ¡Muy recomendable!",
  },
  {
    orden: 3,
    nombre: "Vanesa S.",
    localidad: "Lomas de Zamora, Buenos Aires",
    estrellas: 5,
    comentario: "Gracias a MiAJB pudimos disfrutar en familia sin que el presupuesto sea un problema.",
  },
  {
    orden: 4,
    nombre: "Jorge M.",
    localidad: "Mar del Plata, Buenos Aires",
    estrellas: 5,
    comentario: "El Parador de la Montaña es un lugar hermoso. Volvemos todos los años con mi familia.",
  },
  {
    orden: 5,
    nombre: "Silvina R.",
    localidad: "Quilmes, Buenos Aires",
    estrellas: 4,
    comentario: "Muy conforme con el camping de Miramar. Todo limpio, ordenado y con precios accesibles.",
  },
  {
    orden: 6,
    nombre: "Pablo T.",
    localidad: "San Isidro, Buenos Aires",
    estrellas: 5,
    comentario: "Casa Solís nos salvó el viaje a Capital. Céntrica, cómoda y con la tranquilidad de reservar por el gremio.",
  },
];

function assertEnvVar(value, name) {
  if (!value) {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
}

async function ensureTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS turismo_testimonio (
      id INT NOT NULL AUTO_INCREMENT,
      nombre VARCHAR(80) NOT NULL,
      localidad VARCHAR(120) NOT NULL,
      estrellas TINYINT NOT NULL DEFAULT 5,
      comentario VARCHAR(500) NOT NULL,
      foto_archivo VARCHAR(260) NULL,
      activo TINYINT NOT NULL DEFAULT 1,
      orden INT NOT NULL DEFAULT 0,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_turismo_testimonio_activo_orden (activo, orden)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function seedTestimonios(connection) {
  const [existentes] = await connection.query("SELECT COUNT(*) AS total FROM turismo_testimonio");
  if (existentes[0].total > 0) {
    console.log(`La tabla ya tiene ${existentes[0].total} testimonios, no se siembran datos.`);
    return;
  }

  for (const testimonio of testimonios) {
    await connection.query(
      `
        INSERT INTO turismo_testimonio (nombre, localidad, estrellas, comentario, activo, orden)
        VALUES (?, ?, ?, ?, 1, ?)
      `,
      [testimonio.nombre, testimonio.localidad, testimonio.estrellas, testimonio.comentario, testimonio.orden]
    );
  }
  console.log(`${testimonios.length} testimonios sembrados.`);
}

async function main() {
  assertEnvVar(process.env.DB_HOST, "DB_HOST");
  assertEnvVar(process.env.DB_USER, "DB_USER");
  assertEnvVar(process.env.DB_DATABASE, "DB_DATABASE");

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
  });

  try {
    await ensureTable(connection);
    await seedTestimonios(connection);
    console.log("Testimonios de turismo migrados correctamente.");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Fallo la migracion de testimonios de turismo:", error.message);
  process.exit(1);
});
