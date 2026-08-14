"use strict";

/**
 * Normaliza los DNI de `usuario` que tienen menos de DNI_MIN_DIGITOS dígitos,
 * repitiendo el número hasta alcanzar el mínimo (111 → 111111).
 *
 *   node scripts/dni-normalizar.js --entorno=develop            (relevamiento)
 *   node scripts/dni-normalizar.js --entorno=develop --aplicar  (escribe)
 *
 * Sin --aplicar solo informa. Antes de escribir vuelca los valores anteriores a
 * un .json para poder revertir. Si el valor normalizado choca con un documento
 * ya existente, esa fila se reporta y se deja intacta: `documento` identifica al
 * afiliado en todo el sistema y un duplicado silencioso sería peor que un DNI corto.
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { DNI_MAX_DIGITOS, DNI_MIN_DIGITOS } = require("../api/security/dni");

const RAIZ = path.join(__dirname, "..");

// El .env tiene el bloque de producción activo y el de develop comentado, así
// que se parsea a mano por bloque en vez de con dotenv.
function leerConfigs() {
  const lineas = fs.readFileSync(path.join(RAIZ, ".env"), "utf8").split(/\r?\n/);
  const configs = {};
  let actual = null;

  for (const linea of lineas) {
    const encabezado = linea.match(/^\s*#\s*(PRODUCCION|DEVELOP)\s*$/i);
    if (encabezado) {
      actual = encabezado[1].toLowerCase() === "produccion" ? "produccion" : "develop";
      if (!configs[actual]) configs[actual] = {};
      continue;
    }
    if (!actual) continue;

    const dato = linea.match(/^\s*#?\s*(DB_[A-Z]+)\s*=\s*(.*?)\s*$/);
    if (dato && configs[actual][dato[1]] === undefined) {
      configs[actual][dato[1]] = dato[2];
    }
  }

  return configs;
}

function aConexion(cfg) {
  return {
    host: cfg.DB_HOST,
    user: cfg.DB_USER,
    password: cfg.DB_PASSWORD,
    database: cfg.DB_DATABASE,
    port: Number(cfg.DB_PORT || 3306),
  };
}

/**
 * Repite el número hasta llegar al mínimo y corta ahí: el resultado siempre
 * tiene exactamente DNI_MIN_DIGITOS. 111 → 111111 · 7 → 777777 · 1234 → 123412
 */
function completarRepitiendo(documento) {
  const base = String(documento);
  let salida = base;
  while (salida.length < DNI_MIN_DIGITOS) {
    salida += base;
  }
  return salida.slice(0, DNI_MIN_DIGITOS);
}

async function main() {
  const args = process.argv.slice(2);
  const entorno = (args.find((a) => a.startsWith("--entorno=")) || "").split("=")[1];
  const aplicar = args.includes("--aplicar");

  if (!entorno) {
    console.error("Falta --entorno=develop|produccion");
    process.exit(1);
  }

  const configs = leerConfigs();
  const cfg = configs[entorno];
  if (!cfg || !cfg.DB_HOST) {
    console.error(`No se encontró el bloque ${entorno} en .env`);
    process.exit(1);
  }

  const conexion = await mysql.createConnection(aConexion(cfg));
  console.log(`[${entorno}] ${cfg.DB_USER}@${cfg.DB_HOST}/${cfg.DB_DATABASE}\n`);

  try {
    const [cortos] = await conexion.query(
      `SELECT id, nombre, apellido, documento
         FROM usuario
        WHERE documento IS NOT NULL
          AND CHAR_LENGTH(CAST(documento AS CHAR)) < ?
        ORDER BY id`,
      [DNI_MIN_DIGITOS]
    );

    const [largos] = await conexion.query(
      `SELECT id, documento
         FROM usuario
        WHERE documento IS NOT NULL
          AND CHAR_LENGTH(CAST(documento AS CHAR)) > ?
        ORDER BY id`,
      [DNI_MAX_DIGITOS]
    );

    if (largos.length) {
      console.log(`⚠ ${largos.length} usuario(s) con más de ${DNI_MAX_DIGITOS} dígitos (no se tocan):`);
      largos.forEach((u) => console.log(`   id=${u.id} documento=${u.documento}`));
      console.log("");
    }

    if (!cortos.length) {
      console.log(`Sin usuarios con menos de ${DNI_MIN_DIGITOS} dígitos. Nada para hacer.`);
      return;
    }

    // Documentos ya ocupados, para no generar duplicados al completar
    const [todos] = await conexion.query(
      "SELECT documento FROM usuario WHERE documento IS NOT NULL"
    );
    const ocupados = new Set(todos.map((u) => String(u.documento)));

    const plan = [];
    const choques = [];
    for (const usuario of cortos) {
      const nuevo = completarRepitiendo(usuario.documento);
      if (ocupados.has(nuevo)) {
        choques.push({ ...usuario, nuevo });
        continue;
      }
      ocupados.add(nuevo);
      plan.push({ ...usuario, nuevo });
    }

    console.log(`${cortos.length} usuario(s) con DNI corto:\n`);
    for (const p of plan) {
      console.log(`   id=${p.id}  ${p.apellido}, ${p.nombre}:  ${p.documento} → ${p.nuevo}`);
    }
    if (choques.length) {
      console.log(`\n⚠ ${choques.length} quedan sin tocar: el valor normalizado ya existe`);
      choques.forEach((c) => console.log(`   id=${c.id}  ${c.documento} → ${c.nuevo} (ocupado)`));
    }

    if (!aplicar) {
      console.log("\n(relevamiento: no se escribió nada — agregar --aplicar)");
      return;
    }

    const respaldo = path.join(RAIZ, "scripts", `dni-respaldo-${entorno}.json`);
    fs.writeFileSync(respaldo, JSON.stringify({ entorno, plan, choques }, null, 2));
    console.log(`\nRespaldo: ${respaldo}`);

    await conexion.beginTransaction();
    try {
      for (const p of plan) {
        await conexion.query("UPDATE usuario SET documento = ? WHERE id = ?", [
          Number(p.nuevo),
          p.id,
        ]);
      }
      await conexion.commit();
      console.log(`✔ ${plan.length} documento(s) actualizado(s)`);
    } catch (error) {
      await conexion.rollback();
      throw error;
    }
  } finally {
    await conexion.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
