"use strict";

/**
 * Olimpiadas · disciplinas que no se juegan 1 contra 1 (maratón, natación, pesca, póker).
 *
 * Agrega cómo se compite en cada disciplina (`olimpiada_disciplina.formato_competencia`), las
 * tablas de categorías / mesas (`olimpiada_prueba`) y de sus participantes
 * (`olimpiada_prueba_participante`), lo que necesita el medallero para sumar solo las medallas
 * de cada categoría (columnas de `olimpiada_medalla` y su clave única) y, para pesca, los ganadores
 * que se eligen a mano en cada categoría (`olimpiada_prueba_ganador`).
 *
 * Tercera tanda (25/11/2026): en pesca los participantes pasan a ser de la disciplina —los mismos
 * compiten por todos los premios— y dejan de estar repartidos por categoría. Quien había quedado
 * cargado en dos categorías figura una sola vez, y se quitan las medallas automáticas que venían
 * de las tablas de piezas y peso (ya no existen).
 *
 * Se puede volver a correr sobre una base que ya tenía una versión anterior: agrega sólo lo que falta.
 *
 * Idempotente. Por defecto sólo informa lo pendiente (check); con --apply lo aplica.
 *
 *   node scripts/migrar-olimpiadas-pruebas.js --check --target=develop
 *   node scripts/migrar-olimpiadas-pruebas.js --apply --target=develop --confirm=APLICAR_OLIMPIADAS_PRUEBAS
 *   node scripts/migrar-olimpiadas-pruebas.js --apply --target=production --allow-production --confirm=APLICAR_OLIMPIADAS_PRUEBAS
 *
 * Sin --target usa las variables DB_* del entorno (así se corre en el servidor, con la cuenta
 * administrativa). La cuenta de ejecución de la API (miajb_runtime) no tiene permisos DDL: por eso
 * la migración también otorga DML sobre las tablas nuevas.
 */
require("dotenv").config();
const fs = require("fs");
const mysql = require("mysql2/promise");
const { formatoSugerido, sinAcentos } = require("../api/services/olimpiadas-pruebas");

const CONFIRMACION = "APLICAR_OLIMPIADAS_PRUEBAS";
const CANDADO = "ajb:olimpiadas-pruebas-v1";
const CHARSET = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

// [tabla, columna, definición]
const COLUMNAS = [
  ["olimpiada_disciplina", "formato_competencia",
    "ENUM('PARTIDOS','TIEMPO','PESCA','MESAS') NOT NULL DEFAULT 'PARTIDOS' COMMENT 'PARTIDOS = 1 contra 1; TIEMPO = categorías por tiempo; PESCA = categorías por piezas y peso; MESAS = póker'"],
  ["olimpiada_prueba", "suma_medallero",
    "ENUM('TODO','PIEZAS','PESO','NADA') NOT NULL DEFAULT 'TODO' COMMENT 'Qué le suma la categoría al medallero (PIEZAS y PESO: sólo una de las dos tablas de pesca)'"],
  // Una medalla que salió de una categoría: de quién es y de cuál de las tablas (pesca)
  ["olimpiada_medalla", "prueba_id", "INT NULL COMMENT 'Categoría de la que salió la medalla (disciplinas por categorías)'"],
  ["olimpiada_medalla", "participante_id", "INT NULL COMMENT 'Participante que la ganó (olimpiada_prueba_participante)'"],
  ["olimpiada_medalla", "criterio", "ENUM('PIEZAS','PESO') NULL COMMENT 'Pesca: de cuál de las dos tablas salió'"],
  ["olimpiada_medalla", "clave_origen", "VARCHAR(40) NOT NULL DEFAULT '' COMMENT 'Distingue medallas del mismo puesto y departamental que vienen de categorías o personas distintas'"],
];

// Con varias categorías, una departamental puede ganar dos oros en la misma disciplina: la clave
// única pasa a incluir de dónde salió cada medalla (para las de partidos y las manuales queda vacía).
const INDICE_MEDALLA = { nuevo: "uq_oli_medalla_origen", anterior: "uq_oli_medalla", columnas: "(olimpiada_id, disciplina_id, puesto, departamental_id, clave_origen)" };

const TABLAS = {
  olimpiada_prueba: `CREATE TABLE IF NOT EXISTS olimpiada_prueba (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    olimpiada_id INT NOT NULL,
    disciplina_id INT NOT NULL,
    nombre VARCHAR(120) NOT NULL COMMENT 'Categoría (damas hasta 40, embarcado…) o mesa de póker',
    descripcion VARCHAR(300) NULL COMMENT 'Distancia, estilo o aclaración que se ve en el portal',
    fecha DATE NULL,
    hora_inicio TIME NULL,
    estado ENUM('PROGRAMADA','EN_JUEGO','FINALIZADA') NOT NULL DEFAULT 'PROGRAMADA',
    suma_medallero ENUM('TODO','PIEZAS','PESO','NADA') NOT NULL DEFAULT 'TODO' COMMENT 'Qué le suma la categoría al medallero (PIEZAS y PESO: sólo una de las dos tablas de pesca)',
    orden INT NOT NULL DEFAULT 0,
    eliminado TINYINT(1) NOT NULL DEFAULT 0,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_oli_prueba_disciplina (olimpiada_id, disciplina_id, eliminado),
    CONSTRAINT fk_oli_prueba_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id),
    CONSTRAINT fk_oli_prueba_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id)
  ) ${CHARSET}`,
  olimpiada_prueba_participante: `CREATE TABLE IF NOT EXISTS olimpiada_prueba_participante (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    olimpiada_id INT NOT NULL,
    disciplina_id INT NOT NULL,
    prueba_id INT NULL COMMENT 'Categoría o mesa; NULL = jugador de póker todavía sin mesa',
    nombre VARCHAR(160) NOT NULL,
    departamental_id INT NULL,
    inscripcion_id INT NULL COMMENT 'Inscripción aprobada de la que se tomó la persona (opcional)',
    tiempo_ms INT UNSIGNED NULL COMMENT 'Tiempo cronometrado en milésimas (maratón, natación)',
    piezas INT UNSIGNED NULL COMMENT 'Pesca: cantidad de piezas',
    peso_gramos INT UNSIGNED NULL COMMENT 'Pesca: peso total en gramos',
    puesto TINYINT UNSIGNED NULL COMMENT 'Póker: 1.º, 2.º o 3.º elegido a mano',
    orden INT NOT NULL DEFAULT 0 COMMENT 'Orden de carga; en póker, el lugar en la mesa',
    eliminado TINYINT(1) NOT NULL DEFAULT 0,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_oli_prueba_part_disciplina (olimpiada_id, disciplina_id, eliminado),
    KEY idx_oli_prueba_part_prueba (prueba_id, eliminado),
    CONSTRAINT fk_oli_prueba_part_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id),
    CONSTRAINT fk_oli_prueba_part_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id),
    CONSTRAINT fk_oli_prueba_part_prueba FOREIGN KEY (prueba_id) REFERENCES olimpiada_prueba (id),
    CONSTRAINT fk_oli_prueba_part_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id)
  ) ${CHARSET}`,
  olimpiada_prueba_ganador: `CREATE TABLE IF NOT EXISTS olimpiada_prueba_ganador (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    olimpiada_id INT NOT NULL,
    disciplina_id INT NOT NULL,
    prueba_id INT NOT NULL COMMENT 'Categoría de pesca que se premia',
    participante_id INT NOT NULL COMMENT 'Participante de la disciplina (olimpiada_prueba_participante)',
    puesto TINYINT UNSIGNED NOT NULL COMMENT '1 = oro, 2 = plata, 3 = bronce',
    marca VARCHAR(60) NULL COMMENT 'Lo que se anota al lado del ganador: 12 piezas, 4,350 kg…',
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_oli_prueba_ganador_puesto (prueba_id, puesto),
    UNIQUE KEY uq_oli_prueba_ganador_persona (prueba_id, participante_id),
    KEY idx_oli_prueba_ganador_disciplina (olimpiada_id, disciplina_id),
    KEY idx_oli_prueba_ganador_participante (participante_id),
    CONSTRAINT fk_oli_prueba_ganador_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id),
    CONSTRAINT fk_oli_prueba_ganador_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id),
    CONSTRAINT fk_oli_prueba_ganador_prueba FOREIGN KEY (prueba_id) REFERENCES olimpiada_prueba (id),
    CONSTRAINT fk_oli_prueba_ganador_participante FOREIGN KEY (participante_id) REFERENCES olimpiada_prueba_participante (id)
  ) ${CHARSET}`,
};

/**
 * Pesca: qué hacer con los participantes que estaban cargados dentro de una categoría. Recibe las
 * filas vigentes de las disciplinas de pesca (primero las que ya son de la disciplina) y devuelve
 * cuáles pasan al listado de la disciplina, con su orden, y cuáles sobran por estar repetidas
 * (misma inscripción, o mismo nombre y departamental).
 */
function planParticipantesPesca(filas) {
  const disciplinas = new Map();
  const mover = [], repetidos = [];
  for (const fila of filas) {
    const clave = `${fila.olimpiada_id}|${fila.disciplina_id}`;
    if (!disciplinas.has(clave)) disciplinas.set(clave, { vistos: new Set(), orden: 0, pendiente: false, filas: [] });
    const grupo = disciplinas.get(clave);
    if (fila.prueba_id !== null && fila.prueba_id !== undefined) grupo.pendiente = true;
    const identidades = [`N${sinAcentos(fila.nombre)}|${Number(fila.departamental_id) || 0}`, ...(fila.inscripcion_id ? [`I${Number(fila.inscripcion_id)}`] : [])];
    if (identidades.some(identidad => grupo.vistos.has(identidad))) { grupo.filas.push({ id: Number(fila.id), repetido: true }); continue; }
    identidades.forEach(identidad => grupo.vistos.add(identidad));
    grupo.filas.push({ id: Number(fila.id), orden: ++grupo.orden });
  }
  // Una disciplina que ya tiene a todos en su listado no se toca
  for (const grupo of disciplinas.values()) {
    if (!grupo.pendiente) continue;
    for (const fila of grupo.filas) (fila.repetido ? repetidos : mover).push(fila.repetido ? fila.id : { id: fila.id, orden: fila.orden });
  }
  return { mover, repetidos };
}

async function existeColumna(db, tabla, columna) {
  const [rows] = await db.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [tabla, columna]
  );
  return rows.length > 0;
}

async function existeTabla(db, tabla) {
  const [rows] = await db.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [tabla]);
  return rows.length > 0;
}

async function existeIndice(db, tabla, indice) {
  const [rows] = await db.query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
    [tabla, indice]
  );
  return rows.length > 0;
}

async function migrar(db, aplicar = false, { otorgar = true } = {}) {
  const pendientes = [];
  const informe = [];

  // Primero las tablas: una base nueva las crea ya con todas sus columnas.
  const tablasNuevas = new Set();
  for (const [tabla, ddl] of Object.entries(TABLAS)) {
    if (await existeTabla(db, tabla)) continue;
    pendientes.push(`Crear ${tabla}`);
    tablasNuevas.add(tabla);
    if (aplicar) await db.query(ddl);
  }

  const columnasNuevas = new Set();
  for (const [tabla, columna, definicion] of COLUMNAS) {
    // La tabla recién creada (o por crear) ya trae la columna
    if (tablasNuevas.has(tabla) || await existeColumna(db, tabla, columna)) continue;
    pendientes.push(`Agregar ${tabla}.${columna}`);
    columnasNuevas.add(`${tabla}.${columna}`);
    if (aplicar) await db.query(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${columna}\` ${definicion}`);
  }

  // La clave única del medallero: se agrega la nueva y se quita la anterior en el mismo paso.
  if (!(await existeIndice(db, "olimpiada_medalla", INDICE_MEDALLA.nuevo))) {
    const quitar = await existeIndice(db, "olimpiada_medalla", INDICE_MEDALLA.anterior);
    pendientes.push(`Clave única de olimpiada_medalla con el origen de cada medalla${quitar ? " (reemplaza a la anterior)" : ""}`);
    if (aplicar) {
      await db.query(
        `ALTER TABLE olimpiada_medalla ADD UNIQUE KEY \`${INDICE_MEDALLA.nuevo}\` ${INDICE_MEDALLA.columnas}${quitar ? `, DROP INDEX \`${INDICE_MEDALLA.anterior}\`` : ""}`
      );
    }
  }

  // Sólo la primera vez: después manda lo que la administración elija en la ficha de la disciplina.
  if (columnasNuevas.has("olimpiada_disciplina.formato_competencia")) {
    const [disciplinas] = await db.query("SELECT id, nombre FROM olimpiada_disciplina ORDER BY nombre");
    const cambios = disciplinas.map((d) => ({ ...d, formato: formatoSugerido(d.nombre) })).filter((d) => d.formato !== "PARTIDOS");
    for (const formato of ["TIEMPO", "PESCA", "MESAS"]) {
      informe.push(`${formato}: ${cambios.filter((d) => d.formato === formato).map((d) => d.nombre).join(", ") || "ninguna"}`);
    }
    if (aplicar) for (const d of cambios) await db.query("UPDATE olimpiada_disciplina SET formato_competencia = ? WHERE id = ?", [d.formato, d.id]);
  }

  // Pesca: los participantes pasan de la categoría a la disciplina (ver el encabezado).
  const hayParticipantes = !tablasNuevas.has("olimpiada_prueba_participante") && await existeColumna(db, "olimpiada_disciplina", "formato_competencia");
  if (hayParticipantes) {
    const [filas] = await db.query(
      `SELECT p.id, p.olimpiada_id, p.disciplina_id, p.prueba_id, p.nombre, p.departamental_id, p.inscripcion_id
       FROM olimpiada_prueba_participante p INNER JOIN olimpiada_disciplina d ON d.id = p.disciplina_id
       WHERE d.formato_competencia = 'PESCA' AND p.eliminado = 0
       ORDER BY p.olimpiada_id, p.disciplina_id, (p.prueba_id IS NOT NULL), p.prueba_id, p.orden, p.id`
    );
    const { mover, repetidos } = planParticipantesPesca(filas);
    if (mover.length || repetidos.length) {
      pendientes.push(`Pesca: pasar ${mover.length} participante(s) al listado de la disciplina${repetidos.length ? ` y quitar ${repetidos.length} repetido(s)` : ""}`);
      if (aplicar) {
        await db.beginTransaction();
        try {
          if (repetidos.length) await db.query("UPDATE olimpiada_prueba_participante SET eliminado = 1 WHERE id IN (?)", [repetidos]);
          for (const fila of mover) await db.query("UPDATE olimpiada_prueba_participante SET prueba_id = NULL, orden = ? WHERE id = ?", [fila.orden, fila.id]);
          await db.commit();
        } catch (error) {
          await db.rollback();
          throw error;
        }
      }
    }
    // Las medallas automáticas de las dos tablas (piezas y peso) salían de datos que ya no se cargan
    if (await existeColumna(db, "olimpiada_medalla", "criterio")) {
      const [[viejas]] = await db.query(
        `SELECT COUNT(*) AS cantidad FROM olimpiada_medalla m INNER JOIN olimpiada_disciplina d ON d.id = m.disciplina_id
         WHERE d.formato_competencia = 'PESCA' AND m.origen = 'AUTO' AND m.criterio IS NOT NULL`
      );
      if (Number(viejas?.cantidad)) {
        pendientes.push(`Pesca: quitar ${viejas.cantidad} medalla(s) automáticas de las tablas de piezas y peso`);
        if (aplicar) {
          await db.query(
            `DELETE m FROM olimpiada_medalla m INNER JOIN olimpiada_disciplina d ON d.id = m.disciplina_id
             WHERE d.formato_competencia = 'PESCA' AND m.origen = 'AUTO' AND m.criterio IS NOT NULL`
          );
        }
      }
    }
  }

  // Permisos de la cuenta de ejecución de la API sobre las tablas nuevas (se repite sin problema).
  if (aplicar && otorgar) {
    const [[schema]] = await db.query("SELECT DATABASE() AS nombre");
    const [cuentas] = await db.query("SELECT User, Host FROM mysql.user WHERE User = 'miajb_runtime'");
    for (const cuenta of cuentas) {
      for (const tabla of Object.keys(TABLAS)) {
        await db.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${schema.nombre.replace(/`/g, "``")}\`.\`${tabla}\` TO ${mysql.escape(cuenta.User)}@${mysql.escape(cuenta.Host)}`
        );
      }
    }
    informe.push(`Permisos otorgados a ${cuentas.length} cuenta(s) de ejecución.`);
  }

  return { pendientes, informe };
}

function conexionDesdeEntorno(env) {
  for (const clave of ["DB_HOST", "DB_USER", "DB_DATABASE"]) if (!env[clave]) throw new Error(`Falta ${clave}`);
  const remoto = !["localhost", "127.0.0.1", "::1"].includes(String(env.DB_HOST).toLowerCase());
  const modoTls = String(env.DB_SSL_MODE || "disabled").toLowerCase();
  if (!["disabled", "verify-ca", "verify-full"].includes(modoTls)) throw new Error("DB_SSL_MODE inválido");
  if (modoTls === "disabled" && remoto) throw new Error("TLS es obligatorio para bases remotas");
  if (modoTls !== "disabled" && !env.DB_SSL_CA_PATH) throw new Error("Falta DB_SSL_CA_PATH");
  return {
    remoto,
    opciones: {
      host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER, password: env.DB_PASSWORD,
      database: env.DB_DATABASE, timezone: "-03:00",
      ssl: modoTls === "disabled" ? undefined : { ca: fs.readFileSync(env.DB_SSL_CA_PATH), rejectUnauthorized: true },
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const aplicar = argv.includes("--apply");
  const target = argv.find((a) => a.startsWith("--target="))?.slice(9) || null;
  const permiteProduccion = argv.includes("--allow-production");
  if (aplicar && !argv.includes(`--confirm=${CONFIRMACION}`)) throw new Error(`Aplicar requiere --confirm=${CONFIRMACION}`);

  let entornos;
  if (target) {
    const { parsearArgumentos, obtenerEntornos, crearOpcionesConexion } = require("./migrar-webauthn-v1");
    const opciones = parsearArgumentos(argv.filter((a) => !a.startsWith("--confirm=")));
    if (["production", "all"].includes(opciones.target) && !permiteProduccion) throw new Error("Production requiere --allow-production");
    entornos = obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"))
      .map((e) => ({ nombre: e.nombre, opciones: crearOpcionesConexion(e.config) }));
  } else {
    const { remoto, opciones } = conexionDesdeEntorno(process.env);
    if (aplicar && (remoto || process.env.NODE_ENV === "production") && !permiteProduccion) {
      throw new Error("La base remota o de producción requiere --allow-production");
    }
    entornos = [{ nombre: remoto ? "remota" : "local", opciones }];
  }

  for (const entorno of entornos) {
    const db = await mysql.createConnection(entorno.opciones);
    try {
      const [[lock]] = await db.query("SELECT GET_LOCK(?, 15) AS tomado", [CANDADO]);
      if (Number(lock.tomado) !== 1) throw new Error("Otra migración de Olimpiadas está en curso");
      const resultado = await migrar(db, aplicar, { otorgar: !argv.includes("--skip-grants") });
      console.log(JSON.stringify({ entorno: entorno.nombre, modo: aplicar ? "apply" : "check", ...resultado }, null, 2));
    } finally {
      await db.query("SELECT RELEASE_LOCK(?)", [CANDADO]).catch(() => {});
      await db.end();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[olimpiadas-pruebas] migración fallida: ${error?.message || error?.code}`);
    process.exitCode = 1;
  });
}

module.exports = { migrar, planParticipantesPesca, COLUMNAS, TABLAS, INDICE_MEDALLA, CONFIRMACION };
