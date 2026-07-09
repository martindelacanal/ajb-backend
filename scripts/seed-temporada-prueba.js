// Seed de una temporada de prueba con tarifas para poder testear el flujo de
// reserva de turismo end-to-end (modalidad FECHA_LIBRE / temporada GENERAL).
//
// Crea (o reutiliza) la temporada "Temporada de prueba (seed)" con un rango de
// fechas futuro y carga tarifas por persona para TODOS los recursos de TODOS
// los servicios, para cada combinación regimen × tipo de persona. Los recursos
// que ya tienen tarifas solapadas en el rango se saltean (para no duplicar
// precios en la cotización).
//
// Uso:  node scripts/seed-temporada-prueba.js
// Idempotente: si un recurso ya tiene tarifas de esta temporada, no re-inserta.

const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const NOMBRE_TEMPORADA = "Temporada de prueba (seed)";
const DIAS_HASTA_INICIO = 7;
const DURACION_DIAS = 90;
const SERVICIO_CAMPING_ID = 4;
const PARCELAS_CAMPING = 20;

function assertEnvVar(value, name) {
  if (!value) {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
}

function formatearFecha(fecha) {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

// Precio por noche según el tipo de persona (bebés no pagan, menores mitad).
function precioParaTipo(nombreTipo, base) {
  const nombre = (nombreTipo || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (nombre.includes("bebe")) return 0;
  if (nombre.includes("nin") || nombre.includes("menor")) return Math.round(base * 0.5);
  return base;
}

async function obtenerOCrearTemporada(connection, fechaInicio, fechaFin) {
  const [existentes] = await connection.query(
    "SELECT id, fecha_inicio, fecha_fin FROM temporada_tarifa WHERE nombre = ? LIMIT 1",
    [NOMBRE_TEMPORADA]
  );
  if (existentes.length > 0) {
    console.log(
      `Temporada existente reutilizada (id ${existentes[0].id}, ` +
        `${formatearFecha(new Date(existentes[0].fecha_inicio))} a ${formatearFecha(new Date(existentes[0].fecha_fin))}).`
    );
    return { id: existentes[0].id, creada: false };
  }

  const [resultado] = await connection.query(
    "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin, origen) VALUES (?, ?, ?, 'GENERAL')",
    [NOMBRE_TEMPORADA, fechaInicio, fechaFin]
  );
  console.log(`Temporada creada (id ${resultado.insertId}, ${fechaInicio} a ${fechaFin}).`);
  return { id: resultado.insertId, creada: true };
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
    const inicio = new Date();
    inicio.setDate(inicio.getDate() + DIAS_HASTA_INICIO);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + DURACION_DIAS);
    const fechaInicio = formatearFecha(inicio);
    const fechaFin = formatearFecha(fin);

    const [regimenes] = await connection.query("SELECT id, nombre FROM regimen");
    const [tiposPersona] = await connection.query("SELECT id, nombre FROM tipo_persona");
    const [servicios] = await connection.query("SELECT id, nombre FROM servicio");
    const [recursos] = await connection.query("SELECT id, nombre, servicio_id FROM recurso");

    if (!regimenes.length || !tiposPersona.length || !recursos.length) {
      throw new Error(
        `Faltan catálogos en la base: regimenes=${regimenes.length}, ` +
          `tipos_persona=${tiposPersona.length}, recursos=${recursos.length}`
      );
    }

    console.log(
      `Catálogos: ${servicios.length} servicios, ${recursos.length} recursos, ` +
        `${regimenes.length} regímenes, ${tiposPersona.length} tipos de persona.`
    );
    console.log(`Rango de la temporada de prueba: ${fechaInicio} a ${fechaFin}.\n`);

    const temporada = await obtenerOCrearTemporada(connection, fechaInicio, fechaFin);

    const nombreServicio = new Map(servicios.map((s) => [s.id, s.nombre]));
    let tarifasInsertadas = 0;
    let recursosSeedeados = 0;
    let recursosSalteados = 0;

    for (const recurso of recursos) {
      // Idempotencia: si este recurso ya tiene tarifas de esta temporada, listo.
      const [propias] = await connection.query(
        "SELECT COUNT(*) AS total FROM tarifa WHERE temporada_tarifa_id = ? AND recurso_id = ?",
        [temporada.id, recurso.id]
      );
      if (propias[0].total > 0) {
        recursosSalteados++;
        console.log(`- ${recurso.nombre} (recurso ${recurso.id}): ya seedeado, salteado.`);
        continue;
      }

      // Si el recurso ya tiene tarifas de OTRA temporada solapadas en el rango,
      // no insertamos: duplicar tarifas por día rompe la cotización.
      const [solapadas] = await connection.query(
        `SELECT COUNT(*) AS total
           FROM tarifa
          WHERE recurso_id = ?
            AND fecha_inicio <= ?
            AND fecha_fin >= ?`,
        [recurso.id, fechaFin, fechaInicio]
      );
      if (solapadas[0].total > 0) {
        recursosSalteados++;
        console.log(
          `- ${recurso.nombre} (recurso ${recurso.id}): ya tiene ${solapadas[0].total} tarifas ` +
            "solapadas en el rango, salteado (ya es testeable con esas)."
        );
        continue;
      }

      const esCamping = Number(recurso.servicio_id) === SERVICIO_CAMPING_ID;
      const filas = [];
      regimenes.forEach((regimen, indiceRegimen) => {
        // Base por regimen para que ordenar por precio tenga sentido en la UI.
        const base = 18000 + indiceRegimen * 6000;
        for (const tipo of tiposPersona) {
          filas.push([
            recurso.id,
            tipo.id,
            regimen.id,
            temporada.id,
            null, // edad_minima: sin tope, cubre cualquier edad
            null, // edad_maxima
            precioParaTipo(tipo.nombre, base),
            fechaInicio,
            fechaFin,
            "Y", // precio_por_persona
            0, // usa_porcentaje
            null, // porcentaje_descuento
            esCamping ? PARCELAS_CAMPING : null,
          ]);
        }
      });

      await connection.query(
        `INSERT INTO tarifa
           (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id,
            edad_minima, edad_maxima, precio, fecha_inicio, fecha_fin,
            precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
         VALUES ?`,
        [filas]
      );

      tarifasInsertadas += filas.length;
      recursosSeedeados++;
      console.log(
        `+ ${recurso.nombre} (recurso ${recurso.id}, servicio "${nombreServicio.get(recurso.servicio_id) || recurso.servicio_id}"): ` +
          `${filas.length} tarifas${esCamping ? ` con ${PARCELAS_CAMPING} parcelas` : ""}.`
      );
    }

    console.log(
      `\nListo: ${recursosSeedeados} recursos seedeados, ${recursosSalteados} salteados, ` +
        `${tarifasInsertadas} tarifas insertadas.`
    );
    console.log(
      `Para probar el flujo, buscá en el módulo de turismo con fechas entre ${fechaInicio} y ${fechaFin}.`
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Falló el seed de la temporada de prueba:", error.message);
  process.exit(1);
});
