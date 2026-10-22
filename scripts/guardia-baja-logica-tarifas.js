"use strict";

// Guardia para los scripts de una sola vez que son anteriores a la baja lógica de tarifas
// (migrar-temporadas-baja-logica.js, 2026-10-21): leen y reescriben `tarifa` sin conocer la
// columna `eliminado`, así que con tarifas dadas de baja podrían contarlas como vigentes,
// reactivarlas o borrarlas. Mientras no haya ninguna dada de baja se comportan como siempre;
// si hay, frenan antes de tocar nada.
async function asegurarSinTarifasDadasDeBaja(connection, script) {
  const [[columna]] = await connection.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tarifa' AND COLUMN_NAME = 'eliminado'`
  );
  if (Number(columna.n) === 0) return;
  const [[bajas]] = await connection.query("SELECT COUNT(*) AS n FROM tarifa WHERE eliminado = 1");
  if (Number(bajas.n) > 0) {
    throw new Error(
      `${script} es anterior a la baja lógica de tarifas y la base ya tiene ${bajas.n} tarifa(s) dada(s) de baja: ` +
      "podría reactivarlas o borrarlas. Adaptalo (filtrar eliminado = 0) antes de correrlo."
    );
  }
}

module.exports = { asegurarSinTarifasDadasDeBaja };
