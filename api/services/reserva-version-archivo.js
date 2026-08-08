"use strict";

const crypto = require("crypto");

function normalizarValor(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { base64: value.toString("base64") };
  if (Array.isArray(value)) return value.map(normalizarValor);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) result[key] = normalizarValor(value[key]);
        return result;
      }, {});
  }
  return value;
}

function jsonCanonico(value) {
  return JSON.stringify(normalizarValor(value));
}

async function archivarVersionReservaAntesDeReemplazo(
  connection,
  reservaId,
  actor,
  operacion = "EDICION"
) {
  const operacionesPermitidas = new Set(["EDICION", "ELIMINACION", "CORRECCION"]);
  if (!operacionesPermitidas.has(operacion)) {
    throw new Error("Operación de archivo de reserva inválida");
  }
  const [reservas] = await connection.query(
    "SELECT * FROM reserva WHERE id = ? FOR UPDATE",
    [reservaId]
  );
  if (reservas.length !== 1) throw new Error("No existe la reserva a archivar");

  const consultas = [
    ["familiares", "SELECT * FROM reserva_familiar WHERE reserva_id = ? ORDER BY id"],
    [
      "tarifas_familiares",
      `SELECT rft.*
         FROM reserva_familiar_tarifa rft
         INNER JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
        WHERE rf.reserva_id = ? ORDER BY rf.id, rft.fecha, rft.id`,
    ],
    ["adicionales", "SELECT * FROM reserva_adicional WHERE reserva_id = ? ORDER BY id"],
    [
      "detalles_adicionales",
      `SELECT rad.*
         FROM reserva_adicional_detalle rad
         INNER JOIN reserva_adicional ra ON ra.id = rad.reserva_adicional_id
        WHERE ra.reserva_id = ? ORDER BY ra.id, rad.fecha, rad.id`,
    ],
    ["historial", "SELECT * FROM historial_reserva WHERE reserva_id = ? ORDER BY id"],
    ["salud", "SELECT * FROM reserva_salud WHERE reserva_id = ? ORDER BY id"],
    [
      "salud_archivos",
      `SELECT rsa.*
         FROM reserva_salud_archivo rsa
         INNER JOIN reserva_salud rs ON rs.id = rsa.reserva_salud_id
        WHERE rs.reserva_id = ? ORDER BY rs.id, rsa.id`,
    ],
    ["observaciones", "SELECT * FROM reserva_observacion WHERE reserva_id = ? ORDER BY id"],
    ["convenio_propuestas", "SELECT * FROM reserva_convenio_propuesta WHERE reserva_id = ? ORDER BY id"],
    ["sorteo_respuestas", "SELECT * FROM sorteo_adjudicacion_respuesta WHERE reserva_id = ? ORDER BY id"],
    ["bloques_recurso", "SELECT * FROM bloque_fecha_recurso WHERE reserva_id = ? ORDER BY id"],
  ];
  const contenido = { formato_version: 1, reserva: reservas[0] };
  for (const [clave, sql] of consultas) {
    const [rows] = await connection.query(sql, [reservaId]);
    contenido[clave] = rows;
  }

  const canonical = jsonCanonico(contenido);
  const checksum = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  const guardToken = crypto.randomBytes(32).toString("hex");
  const [versionRows] = await connection.query(
    `SELECT COALESCE(MAX(version_numero), 0) + 1 AS siguiente
       FROM ajb_reserva_version_archivo WHERE reserva_id = ?`,
    [reservaId]
  );
  const versionNumero = Number(versionRows[0].siguiente);
  const [archivo] = await connection.query(
    `INSERT INTO ajb_reserva_version_archivo
       (reserva_id, version_numero, operacion, actor_usuario_id, actor_rol,
        conexion_id, contenido_json, contenido_sha256)
     VALUES (?, ?, ?, ?, ?, CONNECTION_ID(), CAST(? AS JSON), ?)`,
    [
      reservaId,
      versionNumero,
      operacion,
      actor?.id || null,
      actor?.rol || null,
      canonical,
      checksum,
    ]
  );
  await connection.query("SET @ajb_reserva_guard_token = ?", [guardToken]);
  await connection.query(
    `INSERT INTO ajb_reserva_mutacion_guard
       (conexion_id, reserva_id, guard_token, archivo_id, operacion)
     VALUES (CONNECTION_ID(), ?, ?, ?, ?)`,
    [reservaId, guardToken, archivo.insertId, operacion]
  );
  return { archivoId: archivo.insertId, checksum, versionNumero };
}

async function cerrarGuardiaArchivoReserva(connection, reservaId) {
  const [result] = await connection.query(
    `DELETE FROM ajb_reserva_mutacion_guard
      WHERE conexion_id = CONNECTION_ID()
        AND reserva_id = ?
        AND guard_token = @ajb_reserva_guard_token`,
    [reservaId]
  );
  if (Number(result.affectedRows) !== 1) {
    throw new Error("No se pudo cerrar exactamente una guardia de archivo de reserva");
  }
  await connection.query("SET @ajb_reserva_guard_token = NULL");
}

async function limpiarTokenGuardiaArchivoReserva(connection) {
  await connection.query("SET @ajb_reserva_guard_token = NULL");
}

module.exports = {
  archivarVersionReservaAntesDeReemplazo,
  cerrarGuardiaArchivoReserva,
  jsonCanonico,
  limpiarTokenGuardiaArchivoReserva,
};
