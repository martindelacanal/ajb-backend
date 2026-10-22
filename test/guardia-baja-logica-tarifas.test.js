const test = require("node:test");
const assert = require("node:assert/strict");

const { asegurarSinTarifasDadasDeBaja } = require("../scripts/guardia-baja-logica-tarifas");

function conexionFalsa({ columna, bajas }) {
  return {
    async query(sql) {
      if (/information_schema\.COLUMNS/.test(sql)) return [[{ n: columna ? 1 : 0 }]];
      if (/FROM tarifa WHERE eliminado = 1/.test(sql)) return [[{ n: bajas }]];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

test("guardia: sin la columna eliminado (base anterior a la migración) deja correr el script", async () => {
  await asegurarSinTarifasDadasDeBaja(conexionFalsa({ columna: false }), "x.js");
});

test("guardia: con la columna pero sin tarifas dadas de baja deja correr el script", async () => {
  await asegurarSinTarifasDadasDeBaja(conexionFalsa({ columna: true, bajas: 0 }), "x.js");
});

test("guardia: con tarifas dadas de baja frena antes de tocar nada y dice por qué", async () => {
  await assert.rejects(
    () => asegurarSinTarifasDadasDeBaja(conexionFalsa({ columna: true, bajas: 9 }), "seed-demo-integral.js"),
    /seed-demo-integral\.js es anterior a la baja lógica de tarifas y la base ya tiene 9 tarifa\(s\) dada\(s\) de baja/
  );
});
