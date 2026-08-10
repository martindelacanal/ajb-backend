// Migración del módulo Noticias (portada institucional pública).
//
// Crea las tablas noticia y noticia_imagen de forma idempotente.
// Uso:
//   node scripts/migrar-noticias.js                  → solo esquema (develop)
//   node scripts/migrar-noticias.js --seed           → esquema + noticias de demostración (solo si la tabla está vacía)
//   node scripts/migrar-noticias.js --allow-production  → obligatorio si DB_HOST no es localhost
//
// El seed sube portadas a S3 reutilizando imágenes de FRONTEND/src/assets.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { crearServicioNoticiaMedia, descriptorPersistible } = require("../api/services/noticia-media");

function assertEnvVar(value, name) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

const args = process.argv.slice(2);
const conSeed = args.includes("--seed");
const permiteProduccion = args.includes("--allow-production");

const DDL_NOTICIA = `
CREATE TABLE IF NOT EXISTS noticia (
  id INT NOT NULL AUTO_INCREMENT,
  titulo VARCHAR(160) NOT NULL,
  bajada VARCHAR(300) DEFAULT NULL COMMENT 'Copete corto que acompaña al título en portada',
  cuerpo MEDIUMTEXT NULL COMMENT 'HTML saneado del editor del panel',
  categoria VARCHAR(60) NOT NULL DEFAULT 'Institucional' COMMENT 'Etiqueta libre: Gremial, Salario, Turismo, etc.',
  departamental_id INT DEFAULT NULL COMMENT 'NULL = noticia provincial',
  imagen_archivo VARCHAR(260) DEFAULT NULL COMMENT 'Key S3 de la imagen de portada',
  imagen_ancho INT UNSIGNED DEFAULT NULL,
  imagen_alto INT UNSIGNED DEFAULT NULL,
  imagen_mime VARCHAR(40) DEFAULT NULL,
  imagen_variantes JSON DEFAULT NULL,
  destacada TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Integra el bloque principal de la portada',
  orden INT NOT NULL DEFAULT 0 COMMENT 'Prioridad manual dentro del feed (mayor primero)',
  estado ENUM('BORRADOR','PUBLICADA','ARCHIVADA') NOT NULL DEFAULT 'BORRADOR',
  fecha_publicacion DATETIME DEFAULT NULL COMMENT 'Visible al público cuando estado=PUBLICADA y fecha <= NOW()',
  creado_por_usuario_id INT NOT NULL COMMENT 'Admin que cargó la noticia',
  eliminado TINYINT(1) NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_not_publica (eliminado, estado, fecha_publicacion),
  KEY idx_not_categoria (categoria),
  KEY idx_not_departamental (departamental_id),
  CONSTRAINT fk_not_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id),
  CONSTRAINT fk_not_creador FOREIGN KEY (creado_por_usuario_id) REFERENCES usuario (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const DDL_NOTICIA_IMAGEN = `
CREATE TABLE IF NOT EXISTS noticia_imagen (
  id INT NOT NULL AUTO_INCREMENT,
  noticia_id INT NOT NULL,
  archivo VARCHAR(260) NOT NULL COMMENT 'Key S3',
  ancho INT UNSIGNED DEFAULT NULL,
  alto INT UNSIGNED DEFAULT NULL,
  mime VARCHAR(40) DEFAULT NULL,
  variantes JSON DEFAULT NULL,
  epigrafe VARCHAR(200) DEFAULT NULL,
  orden INT NOT NULL DEFAULT 0,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_not_img_noticia (noticia_id),
  CONSTRAINT fk_not_img_noticia FOREIGN KEY (noticia_id)
    REFERENCES noticia (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

const ASSETS_FRONTEND = path.join(__dirname, "..", "..", "FRONTEND", "src", "assets");

// Portadas de demostración: se reutilizan fotos ya presentes en el repo.
const IMAGENES_SEED = {
  turismo: { archivo: path.join(ASSETS_FRONTEND, "banner", "header-realista-booking.jpeg"), mime: "image/jpeg", extension: "jpg" },
  fondo1: { archivo: path.join(ASSETS_FRONTEND, "login", "fondo1.png"), mime: "image/png", extension: "png" },
  fondo2: { archivo: path.join(ASSETS_FRONTEND, "login", "fondo2.png"), mime: "image/png", extension: "png" },
};

function parrafos(...textos) {
  return textos.map((t) => `<p>${t}</p>`).join("");
}

// Noticias de demostración con el tono y los temas reales de la AJB.
// departamental: nombre a resolver contra la tabla departamental (null = provincial).
const NOTICIAS_SEED = [
  {
    titulo: "Nueva recomposición salarial: se firmó el Acuerdo 4093",
    bajada: "La paritaria judicial cerró una recomposición que recupera lo perdido frente a la inflación y suma cláusula de revisión trimestral.",
    categoria: "Salario",
    destacada: 1,
    orden: 30,
    diasAtras: 1,
    imagen: "fondo1",
    cuerpo: parrafos(
      "Tras una nueva ronda de negociación paritaria, la Asociación Judicial Bonaerense firmó el Acuerdo 4093 con la Suprema Corte de Justicia, que establece una recomposición salarial para todo el escalafón del Poder Judicial de la provincia de Buenos Aires.",
      "El acuerdo incorpora una cláusula de revisión trimestral que permitirá monitorear la evolución de los precios y reabrir la discusión en caso de que la inflación supere los aumentos pactados. Además, se garantiza el arrastre a los adicionales por antigüedad y título.",
      "Desde la Comisión Directiva Provincial destacaron que el acuerdo es el resultado de la participación de las y los judiciales en las asambleas de las 20 departamentales, y convocaron a seguir fortaleciendo la organización gremial en cada lugar de trabajo."
    ),
  },
  {
    titulo: "Se creó la Subcategoría F para compañeras y compañeros con menos de 5 años",
    bajada: "Un reclamo histórico de la AJB: quienes recién ingresan al Poder Judicial tendrán un nuevo escalón salarial que mejora su ingreso inicial.",
    categoria: "Carrera judicial",
    destacada: 1,
    orden: 20,
    diasAtras: 3,
    imagen: null,
    cuerpo: parrafos(
      "La Suprema Corte de Justicia hizo lugar al reclamo sostenido por la Asociación Judicial Bonaerense y dispuso la creación de la Subcategoría F, destinada a las trabajadoras y los trabajadores con menos de cinco años de antigüedad en el Poder Judicial.",
      "La medida implica una mejora directa para el sector que percibe los salarios más bajos del escalafón y reconoce la carrera judicial desde el ingreso. La AJB venía planteando esta necesidad en cada mesa técnica y en las presentaciones formales ante la Corte.",
      "El gremio continuará trabajando para que la carrera judicial contemple a todos los sectores, con especial atención a quienes cumplen funciones en la Justicia de Paz y en los organismos descentralizados."
    ),
  },
  {
    titulo: "Feria de Invierno 2026: resultado del sorteo de plazas de turismo",
    bajada: "Ya está disponible el listado de adjudicaciones del sorteo de plazas para la temporada de invierno en las unidades turísticas de la AJB.",
    categoria: "Turismo",
    destacada: 1,
    orden: 10,
    diasAtras: 5,
    imagen: "turismo",
    cuerpo: parrafos(
      "La Secretaría de Turismo y Acción Social informa que ya se encuentra disponible el resultado del sorteo de plazas para la Feria de Invierno 2026 en las unidades turísticas propias y los hoteles con convenio en todo el país.",
      "Las afiliadas y los afiliados adjudicados recibirán la notificación en la plataforma Mi AJB, donde también podrán confirmar la reserva, cargar a sus acompañantes y consultar los requisitos de cada destino.",
      "Quienes no hayan resultado adjudicados integrarán la lista de espera automática, que se irá corriendo a medida que se liberen plazas. Como siempre, el sistema de sorteo garantiza la transparencia y la igualdad de oportunidades para todo el padrón."
    ),
  },
  {
    titulo: "Reunión con la Suprema Corte por las subcategorías de jubiladas y jubilados",
    bajada: "La Subsecretaría de Jubilados y Pensionados avanzó en el reconocimiento de las subcategorías para el sector pasivo.",
    categoria: "Jubilados",
    destacada: 0,
    orden: 0,
    diasAtras: 7,
    imagen: null,
    cuerpo: parrafos(
      "Representantes de la Subsecretaría de Jubilados y Pensionados de la AJB mantuvieron una reunión de trabajo con autoridades de la Suprema Corte para avanzar en la aplicación de las subcategorías al sector pasivo del Poder Judicial.",
      "El planteo gremial busca que las mejoras obtenidas por las trabajadoras y los trabajadores en actividad se trasladen de manera automática a las jubilaciones y pensiones, tal como establece la movilidad del 82 por ciento móvil.",
      "La AJB seguirá acompañando a sus jubiladas y jubilados con asesoramiento previsional gratuito en todas las departamentales."
    ),
  },
  {
    titulo: "Capacitación sobre Ley Yolanda: ambiente, trabajo y comunidad",
    bajada: "Nueva cohorte del curso de formación ambiental integral para judiciales, con certificación oficial del Campus Virtual AJB.",
    categoria: "Capacitación",
    destacada: 0,
    orden: 0,
    diasAtras: 9,
    imagen: null,
    cuerpo: parrafos(
      "La Secretaría de Capacitación abre la inscripción a una nueva cohorte del curso sobre Ley Yolanda, la norma que establece la formación ambiental integral para quienes se desempeñan en la función pública.",
      "La propuesta, organizada junto al Centro de Capacitación y Formación (CiyF), se cursa de manera virtual a través del Campus AJB y otorga certificación oficial válida para la carrera judicial.",
      "Las vacantes son limitadas y se priorizará a quienes no hayan realizado ediciones anteriores. La inscripción se realiza desde el Campus Virtual con el usuario de afiliado."
    ),
  },
  {
    titulo: "XVII Encuentro Nacional de Mujeres y LGTTNB Judiciales",
    bajada: "La delegación bonaerense participó del encuentro federal con talleres sobre violencia laboral, cuidados y paridad en la justicia.",
    categoria: "Género",
    destacada: 0,
    orden: 0,
    diasAtras: 12,
    imagen: "fondo2",
    cuerpo: parrafos(
      "Con una nutrida delegación de las 20 departamentales, la AJB participó del XVII Encuentro Nacional de Mujeres y LGTTNB Judiciales, un espacio federal de formación y debate impulsado por la Federación Judicial Argentina.",
      "Durante dos jornadas se desarrollaron talleres sobre violencia laboral con perspectiva de género, corresponsabilidad de los cuidados, licencias igualitarias y paridad en los cargos de decisión del Poder Judicial.",
      "La Secretaría de Género y Diversidad de la AJB puso a disposición su equipo de acompañamiento para situaciones de violencia en los lugares de trabajo, con atención en todas las sedes departamentales."
    ),
  },
  {
    titulo: "Actualización de coberturas del coseguro médico",
    bajada: "Desde este mes rigen nuevos porcentajes de reintegro y topes actualizados para prestaciones médicas, odontológicas y de salud mental.",
    categoria: "Coseguro médico",
    destacada: 1,
    orden: 0,
    diasAtras: 15,
    imagen: null,
    cuerpo: parrafos(
      "El Directorio del Coseguro Médico de la AJB aprobó una actualización integral de las coberturas que alcanza a las prestaciones médicas, odontológicas, de óptica y de salud mental, con nuevos topes de reintegro.",
      "La actualización incorpora además la carga digital de comprobantes desde la plataforma Mi AJB: las afiliadas y los afiliados pueden iniciar su solicitud de reintegro sin concurrir a la departamental, adjuntando la documentación desde el celular.",
      "El detalle completo de porcentajes y topes por práctica está disponible en la sección Coseguro de Mi AJB. Ante cualquier consulta, el equipo de Servicios Sociales atiende en todas las departamentales."
    ),
  },
  {
    titulo: "Convenio con la Cruz Roja para capacitaciones en primeros auxilios",
    bajada: "Trabajadoras y trabajadores judiciales podrán formarse en RCP y primeros auxilios con certificación oficial.",
    categoria: "Departamentales",
    departamental: "Mar del Plata",
    destacada: 0,
    orden: 0,
    diasAtras: 17,
    imagen: null,
    cuerpo: parrafos(
      "La departamental Mar del Plata firmó un convenio con la Cruz Roja Argentina para brindar capacitaciones en reanimación cardiopulmonar (RCP) y primeros auxilios destinadas a las y los judiciales de la jurisdicción.",
      "Los cursos son gratuitos para afiliadas y afiliados, otorgan certificación oficial y se dictarán en la sede gremial. La iniciativa se enmarca en la campaña provincial por edificios judiciales seguros y saludables.",
      "Las inscripciones se reciben en la sede de la departamental y a través de los canales digitales del gremio."
    ),
  },
  {
    titulo: "Gran jornada patria en el Predio Malvinas Argentinas",
    bajada: "Una multitud de familias judiciales compartió el locro, los juegos para las infancias y el homenaje a nuestros veteranos.",
    categoria: "Departamentales",
    departamental: "La Plata",
    destacada: 0,
    orden: 0,
    diasAtras: 20,
    imagen: null,
    cuerpo: parrafos(
      "El Predio Malvinas Argentinas de la AJB fue sede de una gran jornada patria que reunió a cientos de familias judiciales de La Plata y la región, con locro criollo, peña folclórica y actividades para las infancias.",
      "Durante el acto central se rindió homenaje a los veteranos y caídos en Malvinas, con la presencia de excombatientes de la región capital, y se reafirmó el compromiso del gremio con la memoria, la verdad y la justicia.",
      "La jornada cerró con la actuación de artistas locales y el tradicional brindis de camaradería organizado por la comisión de la departamental."
    ),
  },
  {
    titulo: "Importante reunión por la Autarquía Judicial",
    bajada: "La AJB expuso ante legisladores provinciales la necesidad de una ley de autarquía que garantice presupuesto y salarios dignos.",
    categoria: "Gremial",
    departamental: "Bahía Blanca",
    destacada: 0,
    orden: 0,
    diasAtras: 23,
    imagen: null,
    cuerpo: parrafos(
      "Dirigentes de la AJB mantuvieron una reunión de trabajo con legisladores provinciales para avanzar en el proyecto de Autarquía Judicial, una herramienta clave para garantizar el financiamiento del sistema de justicia bonaerense.",
      "El gremio sostiene que la autarquía debe asegurar la intangibilidad de los salarios, la infraestructura edilicia y la cobertura de las vacantes, evitando que el presupuesto judicial quede atado a la discrecionalidad del poder político.",
      "El proyecto será tratado en las próximas sesiones y la AJB convocó a las 20 departamentales a acompañar el debate legislativo."
    ),
  },
  {
    titulo: "Olimpíadas Judiciales Inclusivas: abrió la inscripción",
    bajada: "Vuelve el encuentro deportivo más esperado del año, con disciplinas para todas las edades y cupos por departamental.",
    categoria: "Deportes",
    destacada: 0,
    orden: 0,
    diasAtras: 26,
    imagen: null,
    cuerpo: parrafos(
      "La Secretaría de Deportes anunció la apertura de la inscripción para las Olimpíadas Judiciales Inclusivas, el encuentro que reúne a delegaciones de las 20 departamentales en una semana de competencia y camaradería.",
      "La inscripción se realiza íntegramente desde la plataforma Mi AJB, donde cada afiliada y afiliado puede anotarse en su disciplina, consultar los cupos de su departamental y seguir el estado de su inscripción.",
      "Como en cada edición, habrá disciplinas adaptadas y actividades recreativas para toda la familia judicial. ¡Nos vemos en la cancha!"
    ),
  },
  {
    titulo: "La AJB celebró un nuevo aniversario de su fundación",
    bajada: "El 3 de junio de 1960 nacía la Asociación Judicial Bonaerense. Más de seis décadas de lucha y organización de las y los judiciales.",
    categoria: "Institucional",
    destacada: 0,
    orden: 0,
    diasAtras: 30,
    imagen: null,
    cuerpo: parrafos(
      "Cada 3 de junio la familia judicial bonaerense celebra el aniversario de la fundación de la AJB, el sindicato que desde 1960 organiza a las trabajadoras y los trabajadores del Poder Judicial de la provincia de Buenos Aires.",
      "Con personería gremial 1446/85 y presencia en las 20 departamentales judiciales, la AJB construyó a lo largo de su historia conquistas fundamentales: la carrera judicial, el coseguro médico, el sistema de turismo social y una red de sedes gremiales en toda la provincia.",
      "El mejor homenaje a quienes fundaron el gremio es seguir fortaleciendo la organización en cada lugar de trabajo, con la unidad como bandera: 20 departamentales, un solo gremio."
    ),
  },
];

const COLUMNAS_MEDIA = Object.freeze({
  noticia: Object.freeze({
    imagen_ancho: "INT UNSIGNED DEFAULT NULL",
    imagen_alto: "INT UNSIGNED DEFAULT NULL",
    imagen_mime: "VARCHAR(40) DEFAULT NULL",
    imagen_variantes: "JSON DEFAULT NULL",
  }),
  noticia_imagen: Object.freeze({
    ancho: "INT UNSIGNED DEFAULT NULL",
    alto: "INT UNSIGNED DEFAULT NULL",
    mime: "VARCHAR(40) DEFAULT NULL",
    variantes: "JSON DEFAULT NULL",
  }),
});

async function asegurarColumnasMedia(connection) {
  for (const [tabla, columnas] of Object.entries(COLUMNAS_MEDIA)) {
    const [existentes] = await connection.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tabla]
    );
    const nombres = new Set(existentes.map((fila) => fila.COLUMN_NAME));
    const faltantes = Object.entries(columnas).filter(([columna]) => !nombres.has(columna));
    if (faltantes.length > 0) {
      const clausulas = faltantes
        .map(([columna, definicion]) => `ADD COLUMN \`${columna}\` ${definicion}`)
        .join(", ");
      await connection.query(`ALTER TABLE \`${tabla}\` ${clausulas}`);
      faltantes.forEach(([columna]) => console.log(`  ✔ ${tabla}.${columna}`));
    }
  }
}

async function subirImagenSeed(servicioMedia, clave) {
  const definicion = IMAGENES_SEED[clave];
  if (!definicion) return null;
  if (!fs.existsSync(definicion.archivo)) {
    console.warn(`  · Aviso: no se encontró ${definicion.archivo}; la noticia queda sin portada.`);
    return null;
  }
  const buffer = fs.readFileSync(definicion.archivo);
  return servicioMedia.procesarYSubir({ buffer, mimetype: definicion.mime }, "portadas");
}

async function main() {
  assertEnvVar(process.env.DB_HOST, "DB_HOST");
  assertEnvVar(process.env.DB_USER, "DB_USER");
  assertEnvVar(process.env.DB_PASSWORD, "DB_PASSWORD");
  assertEnvVar(process.env.DB_DATABASE, "DB_DATABASE");

  const esProduccion = !["localhost", "127.0.0.1"].includes(process.env.DB_HOST);
  if (esProduccion && !permiteProduccion) {
    throw new Error(
      `DB_HOST=${process.env.DB_HOST} no es localhost. Para correr contra producción agregá --allow-production.`
    );
  }

  console.log(`Conectando a ${process.env.DB_HOST}/${process.env.DB_DATABASE} como ${process.env.DB_USER}...`);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    timezone: "-03:00",
  });

  try {
    console.log("Creando tabla noticia (si no existe)...");
    await connection.query(DDL_NOTICIA);
    console.log("Creando tabla noticia_imagen (si no existe)...");
    await connection.query(DDL_NOTICIA_IMAGEN);
    console.log("Verificando columnas de media responsiva...");
    await asegurarColumnasMedia(connection);
    console.log("Esquema listo.");

    if (!conSeed) return;

    const [[{ total }]] = await connection.query("SELECT COUNT(*) AS total FROM noticia");
    if (Number(total) > 0) {
      console.log(`La tabla noticia ya tiene ${total} filas; se omite el seed.`);
      return;
    }

    const [admins] = await connection.query(
      "SELECT u.id FROM usuario u INNER JOIN rol r ON r.id = u.rol_id WHERE r.nombre = 'admin' ORDER BY u.id ASC LIMIT 1"
    );
    if (admins.length === 0) {
      console.warn("No hay usuarios admin; se omite el seed.");
      return;
    }
    const adminId = admins[0].id;

    assertEnvVar(process.env.BUCKET_NAME, "BUCKET_NAME");
    assertEnvVar(process.env.BUCKET_REGION, "BUCKET_REGION");
    assertEnvVar(process.env.ACCESS_KEY, "ACCESS_KEY");
    assertEnvVar(process.env.SECRET_ACCESS_KEY, "SECRET_ACCESS_KEY");
    const s3 = new S3Client({
      credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
      },
      region: process.env.BUCKET_REGION,
    });
    const servicioMedia = crearServicioNoticiaMedia({
      subirObjeto: ({ key, buffer, contentType, cacheControl }) => s3.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: cacheControl,
      })),
      eliminarObjeto: (key) => s3.send(new DeleteObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
      })),
    });

    // Cada key de imagen se sube una sola vez aunque la usen varias noticias.
    const cacheImagenes = {};

    console.log(`Sembrando ${NOTICIAS_SEED.length} noticias de demostración (autor: usuario ${adminId})...`);
    for (const noticia of NOTICIAS_SEED) {
      let departamentalId = null;
      if (noticia.departamental) {
        const [deps] = await connection.query(
          "SELECT id FROM departamental WHERE nombre = ? AND habilitado = 'Y' LIMIT 1",
          [noticia.departamental]
        );
        if (deps.length > 0) {
          departamentalId = deps[0].id;
        } else {
          console.warn(`  · Departamental "${noticia.departamental}" no encontrada; la noticia queda provincial.`);
        }
      }

      let imagenArchivo = null;
      if (noticia.imagen) {
        if (!(noticia.imagen in cacheImagenes)) {
          cacheImagenes[noticia.imagen] = await subirImagenSeed(servicioMedia, noticia.imagen);
        }
        imagenArchivo = cacheImagenes[noticia.imagen];
      }

      const media = descriptorPersistible(imagenArchivo);

      await connection.query(
        `INSERT INTO noticia
           (titulo, bajada, cuerpo, categoria, departamental_id,
            imagen_archivo, imagen_ancho, imagen_alto, imagen_mime, imagen_variantes,
             destacada, orden, estado, fecha_publicacion, creado_por_usuario_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLICADA', DATE_SUB(NOW(), INTERVAL ? DAY), ?)`,
        [
          noticia.titulo, noticia.bajada, noticia.cuerpo, noticia.categoria, departamentalId,
          media.archivo, media.ancho, media.alto, media.mime,
          media.variantes.length > 0 ? JSON.stringify(media.variantes) : null,
          noticia.destacada, noticia.orden, noticia.diasAtras, adminId,
        ]
      );
      console.log(`  ✔ ${noticia.titulo}`);
    }
    console.log("Seed completo.");
  } finally {
    await connection.end();
  }
}

main()
  .then(() => {
    console.log("Migración de noticias finalizada.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error en la migración de noticias:", error.message);
    process.exit(1);
  });
