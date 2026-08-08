const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizarSqlModeEstricto,
} = require("../scripts/integridad-financiera-common");

test("los scripts financieros fuerzan modo estricto sin borrar modos existentes", () => {
  assert.equal(
    normalizarSqlModeEstricto(""),
    "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION"
  );
  assert.equal(
    normalizarSqlModeEstricto("IGNORE_SPACE"),
    "IGNORE_SPACE,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION"
  );
  assert.equal(
    normalizarSqlModeEstricto("STRICT_ALL_TABLES,ANSI_QUOTES"),
    "STRICT_ALL_TABLES,ANSI_QUOTES,NO_ENGINE_SUBSTITUTION"
  );
  assert.equal(
    normalizarSqlModeEstricto("strict_trans_tables,STRICT_TRANS_TABLES"),
    "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION"
  );
});
