#!/usr/bin/env node
"use strict";

// Compatibilidad con el comando historico. El seed anterior podia escribir
// tarifas parciales, usar regimenes ajenos al servicio y desalinear las fechas
// de una temporada reutilizada. Toda ejecucion se delega ahora al seed integral,
// que es dry-run por defecto y aplica exclusivamente con manifiesto confirmado.

const { main } = require("./seed-demo-integral");
const { redactError } = require("./integridad-financiera-common");

if (require.main === module) {
  console.error(
    "Aviso: seed-temporada-prueba.js fue reemplazado por seed-demo-integral.js; " +
    "se ejecutara el flujo seguro equivalente."
  );
  main().catch((error) => {
    console.error(JSON.stringify(redactError(error)));
    process.exitCode = 1;
  });
}

module.exports = { main };
