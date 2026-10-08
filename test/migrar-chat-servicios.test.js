"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ampliarEnum, ejecutarMigracion, validarEntorno } = require("../scripts/migrar-chat-servicios");

test("amplía el enum sin reordenar estados anteriores y valida el entorno remoto", () => {
  assert.equal(ampliarEnum("enum('BORRADOR','PENDIENTE','APROBADO','RECHAZADO')"), "enum('BORRADOR','PENDIENTE','APROBADO','RECHAZADO','EN_REVISION')");
  assert.equal(ampliarEnum("enum('PENDIENTE','EN_REVISION')"), null);
  assert.throws(() => ampliarEnum("varchar(40)"), /ENUM/);
  const env = { DB_HOST: "produccion", DB_USER: "admin", DB_PASSWORD: "test", DB_DATABASE: "ajb" };
  assert.throws(() => validarEntorno(env), /allow-production/);
  assert.doesNotThrow(() => validarEntorno(env, { permiteProduccion: true }));
});

test("migración aditiva e idempotente preserva registros y otorga sólo lectura y escritura del chat", async () => {
  let enumTipo = "enum('BORRADOR','PENDIENTE','APROBADO','RECHAZADO')";
  let existeChat = false;
  const sqls = [];
  const connection = { async query(sql) {
    sqls.push(sql);
    if (sql.includes("information_schema.COLUMNS")) return [[{ COLUMN_TYPE: enumTipo }]];
    if (sql.includes("information_schema.TABLES")) return [existeChat ? [{ TABLE_NAME: "servicio_observacion" }] : []];
    if (sql.startsWith("CREATE TABLE")) existeChat = true;
    if (sql.startsWith("ALTER TABLE")) enumTipo = ampliarEnum(enumTipo);
    if (sql.includes("FROM mysql.user")) return [[{ user: "miajb_runtime", host: "%" }]];
    return [{ affectedRows: 1 }];
  } };
  const opciones = { env: { DB_DATABASE: "ajb" }, log() {} };
  const check = await ejecutarMigracion(connection, { ...opciones, check: true });
  assert.equal(check.requiereChat, true);
  assert.equal(existeChat, false);
  await ejecutarMigracion(connection, opciones);
  const segunda = await ejecutarMigracion(connection, opciones);
  assert.equal(segunda.requiereEnum, false);
  assert.equal(segunda.requiereChat, false);
  assert.equal(sqls.filter((sql) => sql.startsWith("ALTER TABLE")).length, 1);
  assert.ok(sqls.some((sql) => /GRANT SELECT, INSERT ON/.test(sql)));
  assert.ok(sqls.some((sql) => /INSERT IGNORE INTO servicio_departamental_visible/.test(sql)));
  assert.ok(sqls.every((sql) => !/DELETE|DROP|TRUNCATE|CASCADE/.test(sql)));
});
