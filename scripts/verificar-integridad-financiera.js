#!/usr/bin/env node
"use strict";

const {
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_REVISION,
  createConnection,
  inspectTargetSchema,
  parseArguments,
  redactError,
  runDataPreflight,
  tableExists,
} = require("./integridad-financiera-common");
const { verifyTargetContract } = require("./migrar-integridad-financiera");

async function readRegistry(connection) {
  if (!(await tableExists(connection, "ajb_schema_migration"))) return null;
  const [rows] = await connection.query(
    `SELECT * FROM ajb_schema_migration
      WHERE migration_id = ?`,
    [MIGRATION_ID]
  );
  return rows[0] || null;
}

function registryStatus(registry) {
  const problems = [];
  if (!registry) problems.push("registro ausente");
  else {
    if (registry.estado !== "APLICADA") problems.push(`estado ${registry.estado}`);
    if (registry.checksum !== MIGRATION_CHECKSUM) problems.push("checksum inesperado");
    if (Number(registry.revision) !== MIGRATION_REVISION) problems.push("revisión inesperada");
    if (!String(registry.trigger_definer || "").includes("@")) {
      problems.push("DEFINER contractual ausente");
    }
    if (!String(registry.trigger_sql_mode || "").match(/STRICT_(?:TRANS|ALL)_TABLES/)) {
      problems.push("SQL_MODE contractual no estricto");
    }
  }
  return { ok: problems.length === 0, problems };
}

function printHuman(report) {
  console.log("Verificación de integridad financiera (sólo lectura)");
  console.log(`Preflight de datos: ${report.preflight.ok ? "OK" : "BLOQUEADO"}`);
  console.log(`Registro exacto: ${report.registry_status.ok ? "OK" : "NO"}`);
  console.log(`Contrato exacto de esquema: ${report.contract.ok ? "OK" : "NO"}`);
  if (!report.registry_status.ok) {
    console.error(`- Registro: ${report.registry_status.problems.join(", ")}`);
  }
  if (!report.contract.ok) {
    console.error(`- Esquema: ${report.contract.error.code}: ${report.contract.error.message}`);
  }
  for (const warning of report.preflight.warnings) {
    console.log(`- Advertencia ${warning.code}: ${warning.message}`, warning.evidence || "");
  }
  for (const fatal of report.preflight.fatal) {
    console.error(`- Bloqueante ${fatal.code}: ${fatal.message}`, fatal.evidence || "");
  }
}

async function main() {
  const args = parseArguments();
  const connection = await createConnection();
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const registry = await readRegistry(connection);
    const registryState = registryStatus(registry);
    const contract = await verifyTargetContract(connection, registry);
    const preflight = await runDataPreflight(connection);
    const schema = await inspectTargetSchema(connection);
    const migrated = registryState.ok && contract.ok && preflight.ok;
    const report = {
      read_only: true,
      migration_id: MIGRATION_ID,
      expected_revision: MIGRATION_REVISION,
      expected_checksum: MIGRATION_CHECKSUM,
      migrated,
      registry_status: registryState,
      registry,
      contract,
      preflight,
      schema,
    };
    await connection.rollback();

    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);

    if (!preflight.ok) process.exitCode = 2;
    else if (args["require-migrated"] && !migrated) process.exitCode = 3;
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify(redactError(error)));
    process.exitCode = 1;
  });
}
