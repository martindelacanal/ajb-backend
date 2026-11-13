"use strict";

/**
 * Olimpiadas · veedores, equipos interdepartamentales, clasificación automática, medallero y videos.
 *
 * Idempotente. Por defecto sólo informa lo pendiente (check); con --apply lo aplica.
 *
 *   node scripts/migrar-olimpiadas-veedores.js --check --target=develop
 *   node scripts/migrar-olimpiadas-veedores.js --apply --target=develop --confirm=APLICAR_OLIMPIADAS_VEEDORES
 *   node scripts/migrar-olimpiadas-veedores.js --apply --target=production --allow-production --confirm=APLICAR_OLIMPIADAS_VEEDORES
 *
 * Sin --target usa las variables DB_* del entorno (así se corre en el servidor, con la cuenta
 * administrativa). La cuenta de ejecución de la API (miajb_runtime) no tiene permisos DDL: por eso
 * la migración también otorga DML sobre las tablas nuevas.
 */
require("dotenv").config();
const fs = require("fs");
const mysql = require("mysql2/promise");

const CONFIRMACION = "APLICAR_OLIMPIADAS_VEEDORES";
const CHARSET = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

// [tabla, columna, definición]
const COLUMNAS = [
  ["olimpiada", "veedores_carga_abierta", "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = los veedores cargan resultados también fuera de las fechas del evento'"],
  ["olimpiada", "medallero_publicado", "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = afiliados, veedores y público ven el medallero'"],
  ["olimpiada", "posiciones_publicas", "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = se muestran las tablas de posiciones por partidos fuera de la gestión'"],
  ["olimpiada", "medallero_division", "ENUM('EXACTA','REDONDEO','ABAJO','ARRIBA','COMPLETO') NOT NULL DEFAULT 'EXACTA' COMMENT 'Cómo se reparten los puntos de un equipo interdepartamental'"],
  ["olimpiada_disciplina", "tipo_marcador", "ENUM('TANTOS','SETS','GANADOR') NOT NULL DEFAULT 'TANTOS' COMMENT 'Cómo se carga el resultado: tantos, sets o sólo quién ganó'"],
  ["olimpiada_disciplina_tipo", "competitiva", "TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = no es deporte (acompañantes, prensa…): no aparece en fixture ni medallero'"],
  ["olimpiada_disciplina_config", "reglamento_archivo", "VARCHAR(260) NULL COMMENT 'Key S3 del reglamento en PDF'"],
  ["olimpiada_disciplina_config", "reglamento_archivo_nombre", "VARCHAR(160) NULL"],
  ["olimpiada_partido", "equipo1_id", "INT NULL COMMENT 'Equipo interdepartamental del lado 1'"],
  ["olimpiada_partido", "equipo2_id", "INT NULL COMMENT 'Equipo interdepartamental del lado 2'"],
  ["olimpiada_partido", "zona", "VARCHAR(40) NULL COMMENT 'Zona o grupo (todos contra todos) al que pertenece el partido'"],
  ["olimpiada_partido", "origen1_tipo", "ENUM('GANADOR','PERDEDOR','POSICION') NULL"],
  ["olimpiada_partido", "origen1_zona", "VARCHAR(40) NULL"],
  ["olimpiada_partido", "origen1_posicion", "TINYINT NULL"],
  ["olimpiada_partido", "origen2_tipo", "ENUM('GANADOR','PERDEDOR','POSICION') NULL"],
  ["olimpiada_partido", "origen2_zona", "VARCHAR(40) NULL"],
  ["olimpiada_partido", "origen2_posicion", "TINYINT NULL"],
  ["olimpiada_partido", "sets", "VARCHAR(400) NULL COMMENT 'JSON [[25,18],[25,20]] para disciplinas por sets'"],
  ["olimpiada_medalla", "equipo_id", "INT NULL COMMENT 'Equipo interdepartamental que ganó el puesto (los puntos se reparten entre sus departamentales)'"],
  ["olimpiada_medalla", "origen", "ENUM('AUTO','MANUAL') NOT NULL DEFAULT 'MANUAL' COMMENT 'AUTO = salió de los resultados; MANUAL = lo cargó la administración'"],
  ["olimpiada_medalla", "puntos_manual", "DECIMAL(8,2) NULL COMMENT 'Si no es NULL pisa los puntos calculados'"],
  ["olimpiada_sede", "lat", "DECIMAL(10,7) NULL"],
  ["olimpiada_sede", "lng", "DECIMAL(10,7) NULL"],
  ["olimpiada_lugar", "lat", "DECIMAL(10,7) NULL"],
  ["olimpiada_lugar", "lng", "DECIMAL(10,7) NULL"],
  ["olimpiada_config", "logo_interdepartamental_archivo", "VARCHAR(260) NULL COMMENT 'Key S3 del escudo de los equipos interdepartamentales'"],
];

const TABLAS = {
  olimpiada_puntos_puesto: `CREATE TABLE IF NOT EXISTS olimpiada_puntos_puesto (
    olimpiada_id INT NOT NULL,
    puesto TINYINT NOT NULL COMMENT '1 = oro, 2 = plata, 3 = bronce, 4.º, 5.º…',
    puntos DECIMAL(8,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (olimpiada_id, puesto),
    CONSTRAINT fk_oli_puntos_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
  ) ${CHARSET}`,
  olimpiada_equipo: `CREATE TABLE IF NOT EXISTS olimpiada_equipo (
    id INT NOT NULL AUTO_INCREMENT,
    olimpiada_id INT NOT NULL,
    disciplina_id INT NOT NULL,
    nombre VARCHAR(160) NOT NULL COMMENT 'Ej: Dolores + Mar del Plata',
    eliminado TINYINT(1) NOT NULL DEFAULT 0,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_oli_equipo_edicion (olimpiada_id, disciplina_id, eliminado),
    CONSTRAINT fk_oli_equipo_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE,
    CONSTRAINT fk_oli_equipo_disciplina FOREIGN KEY (disciplina_id) REFERENCES olimpiada_disciplina (id)
  ) ${CHARSET}`,
  olimpiada_equipo_departamental: `CREATE TABLE IF NOT EXISTS olimpiada_equipo_departamental (
    equipo_id INT NOT NULL,
    departamental_id INT NOT NULL,
    PRIMARY KEY (equipo_id, departamental_id),
    KEY idx_oli_equipo_dep_departamental (departamental_id),
    CONSTRAINT fk_oli_equipo_dep_equipo FOREIGN KEY (equipo_id) REFERENCES olimpiada_equipo (id) ON DELETE CASCADE,
    CONSTRAINT fk_oli_equipo_dep_departamental FOREIGN KEY (departamental_id) REFERENCES departamental (id)
  ) ${CHARSET}`,
  olimpiada_video: `CREATE TABLE IF NOT EXISTS olimpiada_video (
    id INT NOT NULL AUTO_INCREMENT,
    olimpiada_id INT NOT NULL,
    titulo VARCHAR(160) NOT NULL,
    descripcion VARCHAR(400) NULL,
    fecha DATE NULL COMMENT 'Día del evento al que pertenece',
    archivo VARCHAR(260) NOT NULL COMMENT 'Key S3 del video',
    poster_archivo VARCHAR(260) NULL COMMENT 'Key S3 de la imagen de portada',
    mime VARCHAR(60) NOT NULL,
    bytes BIGINT NOT NULL DEFAULT 0,
    orden INT NOT NULL DEFAULT 0,
    estado ENUM('SUBIENDO','LISTO') NOT NULL DEFAULT 'SUBIENDO',
    subida_id VARCHAR(400) NULL COMMENT 'UploadId de la subida por partes en curso',
    partes MEDIUMTEXT NULL COMMENT 'JSON con las partes ya subidas',
    usuario_id INT NULL,
    eliminado TINYINT(1) NOT NULL DEFAULT 0,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_modificacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_oli_video_olimpiada (olimpiada_id, eliminado, estado, orden),
    CONSTRAINT fk_oli_video_olimpiada FOREIGN KEY (olimpiada_id) REFERENCES olimpiada (id) ON DELETE CASCADE
  ) ${CHARSET}`,
};

const INDICES = [
  ["olimpiada_partido", "idx_oli_partido_equipos", "(equipo1_id, equipo2_id)"],
  ["olimpiada_medalla", "idx_oli_medalla_equipo", "(equipo_id)"],
];

// Categorías que no son deporte: no entran en fixture, medallero ni asignación de veedores.
const TIPOS_NO_COMPETITIVOS = ["Acompañante", "Coordinación", "Organización", "Prensa"];

// Cómo se carga el resultado según el nombre de la disciplina (se puede cambiar después en su ficha).
function tipoMarcadorSugerido(nombre) {
  const n = String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/voley|v[oó]leibol|padel|padle|paddle|\btenis\b|ping\s*pong|tenis de mesa|pelota paleta|futbol\s*tenis/.test(n)) return "SETS";
  if (/ajedrez|damas|baile|tango|folclore|folklore|cumbia|pesca|maraton|natacion/.test(n)) return "GANADOR";
  return "TANTOS";
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

  for (const [tabla, ddl] of Object.entries(TABLAS)) {
    if (await existeTabla(db, tabla)) continue;
    pendientes.push(`Crear ${tabla}`);
    if (aplicar) await db.query(ddl);
  }

  const columnasNuevas = new Set();
  for (const [tabla, columna, definicion] of COLUMNAS) {
    if (await existeColumna(db, tabla, columna)) continue;
    pendientes.push(`Agregar ${tabla}.${columna}`);
    columnasNuevas.add(`${tabla}.${columna}`);
    if (aplicar) await db.query(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${columna}\` ${definicion}`);
  }

  for (const [tabla, indice, columnas] of INDICES) {
    if (await existeIndice(db, tabla, indice)) continue;
    pendientes.push(`Índice ${tabla}.${indice}`);
    if (aplicar) await db.query(`ALTER TABLE \`${tabla}\` ADD INDEX \`${indice}\` ${columnas}`);
  }

  // ---- Datos: sólo la primera vez que aparece cada columna, para no pisar lo que ajuste la administración ----
  if (columnasNuevas.has("olimpiada_disciplina.tipo_marcador")) {
    const [disciplinas] = await db.query("SELECT id, nombre FROM olimpiada_disciplina");
    const cambios = disciplinas.map((d) => ({ ...d, tipo: tipoMarcadorSugerido(d.nombre) })).filter((d) => d.tipo !== "TANTOS");
    informe.push(`Resultado por sets: ${cambios.filter((d) => d.tipo === "SETS").map((d) => d.nombre).join(", ") || "ninguna"}`);
    informe.push(`Resultado por ganador: ${cambios.filter((d) => d.tipo === "GANADOR").map((d) => d.nombre).join(", ") || "ninguna"}`);
    if (aplicar) for (const d of cambios) await db.query("UPDATE olimpiada_disciplina SET tipo_marcador = ? WHERE id = ?", [d.tipo, d.id]);
  }

  if (columnasNuevas.has("olimpiada_disciplina_tipo.competitiva")) {
    const [tipos] = await db.query("SELECT id, nombre FROM olimpiada_disciplina_tipo WHERE nombre IN (?)", [TIPOS_NO_COMPETITIVOS]);
    informe.push(`Categorías que no son deporte (fuera de fixture y medallero): ${tipos.map((t) => t.nombre).join(", ") || "ninguna"}`);
    if (aplicar && tipos.length) await db.query("UPDATE olimpiada_disciplina_tipo SET competitiva = 0 WHERE id IN (?)", [tipos.map((t) => t.id)]);
  }

  if (columnasNuevas.has("olimpiada_partido.origen1_tipo")) {
    pendientes.push("Marcar como «ganador de» los orígenes de partidos ya cargados");
    if (aplicar) {
      await db.query("UPDATE olimpiada_partido SET origen1_tipo = 'GANADOR' WHERE partido_origen1_id IS NOT NULL AND origen1_tipo IS NULL");
      await db.query("UPDATE olimpiada_partido SET origen2_tipo = 'GANADOR' WHERE partido_origen2_id IS NOT NULL AND origen2_tipo IS NULL");
    }
  }

  // Antes, varias departamentales en el mismo puesto eran un equipo interdepartamental. Ahora ese
  // equipo es explícito: se arma uno por cada puesto compartido ya cargado (sólo la primera vez).
  if (columnasNuevas.has("olimpiada_medalla.equipo_id")) {
    const [compartidos] = await db.query(
      `SELECT m.olimpiada_id, m.disciplina_id, m.puesto, COUNT(*) AS cantidad
       FROM olimpiada_medalla m GROUP BY m.olimpiada_id, m.disciplina_id, m.puesto HAVING COUNT(*) > 1`
    );
    if (compartidos.length) {
      pendientes.push(`Convertir ${compartidos.length} puesto(s) compartidos del medallero en equipos interdepartamentales`);
      if (aplicar) {
        for (const grupo of compartidos) {
          const [filas] = await db.query(
            `SELECT m.id, m.departamental_id, d.nombre FROM olimpiada_medalla m INNER JOIN departamental d ON d.id = m.departamental_id
             WHERE m.olimpiada_id = ? AND m.disciplina_id = ? AND m.puesto = ? ORDER BY d.nombre`,
            [grupo.olimpiada_id, grupo.disciplina_id, grupo.puesto]
          );
          const [equipo] = await db.query(
            "INSERT INTO olimpiada_equipo (olimpiada_id, disciplina_id, nombre) VALUES (?, ?, ?)",
            [grupo.olimpiada_id, grupo.disciplina_id, filas.map((f) => f.nombre).join(" + ").slice(0, 160)]
          );
          for (const fila of filas) {
            await db.query("INSERT IGNORE INTO olimpiada_equipo_departamental (equipo_id, departamental_id) VALUES (?, ?)", [equipo.insertId, fila.departamental_id]);
          }
          await db.query("UPDATE olimpiada_medalla SET equipo_id = ? WHERE id IN (?)", [equipo.insertId, filas.map((f) => f.id)]);
        }
      }
    }
  }

  // Puntos por puesto: se copian los tres valores históricos de cada edición que todavía no tenga tabla propia.
  if (await existeTabla(db, "olimpiada_puntos_puesto") || aplicar) {
    const [ediciones] = aplicar || (await existeTabla(db, "olimpiada_puntos_puesto"))
      ? await db.query(`SELECT o.id, o.puntos_oro, o.puntos_plata, o.puntos_bronce FROM olimpiada o
          WHERE NOT EXISTS (SELECT 1 FROM olimpiada_puntos_puesto p WHERE p.olimpiada_id = o.id)`)
      : [[]];
    if (ediciones.length) {
      pendientes.push(`Copiar los puntos de oro, plata y bronce de ${ediciones.length} edición(es)`);
      if (aplicar) {
        for (const o of ediciones) {
          for (const [puesto, puntos] of [[1, o.puntos_oro], [2, o.puntos_plata], [3, o.puntos_bronce]]) {
            await db.query("INSERT IGNORE INTO olimpiada_puntos_puesto (olimpiada_id, puesto, puntos) VALUES (?, ?, ?)", [o.id, puesto, Number(puntos) || 0]);
          }
        }
      }
    }
  } else {
    pendientes.push("Copiar los puntos de oro, plata y bronce de cada edición");
  }

  // «Acompañante de afiliadx» no es una disciplina deportiva: se retira del catálogo si nadie la usa.
  const [acompaniantes] = await db.query(
    "SELECT id, nombre, tipo_id FROM olimpiada_disciplina WHERE habilitado = 'Y' AND nombre LIKE 'Acompa%ante de afiliad%'"
  );
  for (const disciplina of acompaniantes) {
    const [[uso]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM olimpiada_inscripcion_disciplina x INNER JOIN olimpiada_inscripcion i ON i.id = x.inscripcion_id
           WHERE x.disciplina_id = ? AND i.eliminado = 0 AND i.estado IN ('PENDIENTE','VALIDADO')) AS inscripciones,
         (SELECT COUNT(*) FROM olimpiada_partido WHERE disciplina_id = ? AND eliminado = 0) AS partidos,
         (SELECT COUNT(*) FROM olimpiada_medalla WHERE disciplina_id = ?) AS medallas`,
      [disciplina.id, disciplina.id, disciplina.id]
    );
    const enUso = Number(uso.inscripciones) + Number(uso.partidos) + Number(uso.medallas);
    if (enUso > 0) {
      informe.push(`«${disciplina.nombre}» sigue en el catálogo: tiene ${uso.inscripciones} inscripción(es) activas. Ya no aparece en fixture ni medallero.`);
      continue;
    }
    pendientes.push(`Quitar «${disciplina.nombre}» del catálogo de disciplinas`);
    if (aplicar) {
      await db.query("UPDATE olimpiada_disciplina SET habilitado = 'N' WHERE id = ?", [disciplina.id]);
      await db.query("DELETE FROM olimpiada_disciplina_config WHERE disciplina_id = ?", [disciplina.id]);
      if (await existeTabla(db, "olimpiada_voluntario_disciplina")) {
        await db.query("DELETE FROM olimpiada_voluntario_disciplina WHERE disciplina_id = ?", [disciplina.id]);
      }
      await db.query(
        `INSERT INTO olimpiada_historial (entidad, entidad_id, tipo_operacion, valor_anterior, observacion)
         VALUES ('DISCIPLINA', ?, 'DELETE', ?, 'Retirada por la migración de veedores: no es una disciplina deportiva.')`,
        [disciplina.id, disciplina.nombre]
      ).catch(() => {});
      // La categoría queda sin disciplinas: si tampoco la usa ninguna inscripción, deja de ofrecerse.
      const [[resto]] = await db.query(
        `SELECT (SELECT COUNT(*) FROM olimpiada_disciplina WHERE tipo_id = ? AND habilitado = 'Y') +
                (SELECT COUNT(*) FROM olimpiada_inscripcion WHERE categoria_tipo_id = ? AND eliminado = 0) AS total`,
        [disciplina.tipo_id, disciplina.tipo_id]
      );
      if (Number(resto.total) === 0) {
        await db.query("UPDATE olimpiada_disciplina_tipo SET habilitado = 'N' WHERE id = ?", [disciplina.tipo_id]);
        informe.push("La categoría «Acompañante» quedó sin disciplinas ni inscripciones y dejó de ofrecerse.");
      }
    }
  }

  // Permisos de la cuenta de ejecución de la API sobre las tablas nuevas.
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
      const [[lock]] = await db.query("SELECT GET_LOCK('ajb:olimpiadas-veedores-v1', 15) AS tomado");
      if (Number(lock.tomado) !== 1) throw new Error("Otra migración de Olimpiadas está en curso");
      const resultado = await migrar(db, aplicar, { otorgar: !argv.includes("--skip-grants") });
      console.log(JSON.stringify({ entorno: entorno.nombre, modo: aplicar ? "apply" : "check", ...resultado }, null, 2));
    } finally {
      await db.query("SELECT RELEASE_LOCK('ajb:olimpiadas-veedores-v1')").catch(() => {});
      await db.end();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[olimpiadas-veedores] migración fallida: ${error?.message || error?.code}`);
    process.exitCode = 1;
  });
}

module.exports = { migrar, COLUMNAS, TABLAS, INDICES, TIPOS_NO_COMPETITIVOS, tipoMarcadorSugerido };
