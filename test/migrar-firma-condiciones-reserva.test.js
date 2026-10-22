"use strict";

// scripts/migrar-firma-condiciones-reserva.js: columnas, estado 15, tablas nuevas, datos y
// permisos del runtime. Idempotente, --check sin escrituras, frena si el 15 está tomado y
// no corre contra producción sin --allow-production.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BACKFILL,
  COLUMNAS,
  MIGRATION_CHECKSUM,
  MIGRATION_ID,
  MIGRATION_LOCK,
  TABLAS_NUEVAS,
  ejecutarMigracion,
  esquemaCoincide,
  main,
  parsearArgumentos,
  privilegiosDeGrant,
  validarDestino,
} = require("../scripts/migrar-firma-condiciones-reserva");

const columna = (DATA_TYPE, COLUMN_TYPE, IS_NULLABLE = "YES", COLUMN_DEFAULT = null) => (
  { DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT }
);

// Esquema de develop (sólo lo que importa para la migración).
function esquemaActual() {
  const tabla = (columnas, indices = { PRIMARY: ["id"] }) => ({ columnas: new Map(columnas), indices, collation: "utf8mb4_0900_ai_ci" });
  return {
    reserva: tabla([
      ["id", columna("int", "int", "NO")],
      ["usuario_id", columna("int", "int")],
      ["firma_archivo", columna("varchar", "varchar(260)")],
      ["fecha_modificacion", columna("datetime", "datetime")],
    ], { PRIMARY: ["id"], idx_reserva_sorteo_activa: ["usuario_id", "modalidad", "estado_reserva_id"] }),
    estado_reserva: tabla([["id", columna("int", "int", "NO")], ["nombre", columna("varchar", "varchar(45)")]]),
    historial_reserva: tabla([["id", columna("int", "int", "NO")]]),
    usuario: tabla([["id", columna("int", "int", "NO")]]),
    rol: tabla([["id", columna("int", "int", "NO")]]),
    politica_cancelacion: tabla([["id", columna("bigint", "bigint unsigned", "NO")]]),
    reserva_politica_cancelacion: tabla([
      ["reserva_id", columna("bigint", "bigint unsigned", "NO")],
      ["aceptada_por", columna("bigint", "bigint unsigned", "NO")],
      ["aceptada_en", columna("datetime", "datetime", "NO", "CURRENT_TIMESTAMP")],
    ], { PRIMARY: ["reserva_id"] }),
    reserva_cancelacion_politica: tabla([
      ["reserva_id", columna("bigint", "bigint unsigned", "NO")],
      ["cancelada_por", columna("bigint", "bigint unsigned", "NO")],
      ["cancelada_en", columna("datetime", "datetime", "NO")],
      ["tipo_base", columna("varchar", "varchar(40)")],
    ], { PRIMARY: ["reserva_id"] }),
  };
}

function definicionColumna(tabla, nombre) {
  return COLUMNAS.find((t) => t.tabla === tabla).columnas.find((c) => c.nombre === nombre);
}

function columnasDeTablaNueva(tabla) {
  return new Map(TABLAS_NUEVAS.find((t) => t.tabla === tabla).columnas.map((c) => [c.nombre, {
    DATA_TYPE: c.dataType,
    COLUMN_TYPE: c.columnType,
    IS_NULLABLE: c.nulable ? "YES" : "NO",
    COLUMN_DEFAULT: c.predeterminado ?? null,
  }]));
}

// Conexión falsa que aplica el DDL sobre `esquema` (así la segunda corrida ve el resultado
// de la primera), guarda el catálogo de estados y simula GRANT / SHOW GRANTS.
function crearConexion(esquema, {
  estados = [{ id: 13, nombre: "Cancelada" }, { id: 14, nombre: "Pendiente_Aprobacion_Titular" }],
  cuentas = [{ user: "miajb_runtime", host: "127.0.0.1" }, { user: "miajb_runtime", host: "localhost" }],
  grantsBase = [],
  grantFalla = null,
  mysqlUserFalla = null,
  lock = 1,
  registrada = null,
  backfill = {},
} = {}) {
  const consultas = [];
  const otorgados = [...grantsBase];
  return {
    consultas,
    estados,
    otorgados,
    transaccion: [],
    terminada: false,
    async beginTransaction() { this.transaccion.push("begin"); },
    async commit() { this.transaccion.push("commit"); },
    async rollback() { this.transaccion.push("rollback"); },
    async query(sql, params = []) {
      const texto = String(sql).replace(/\s+/g, " ").trim();
      consultas.push({ sql: texto, params });
      if (/^SELECT GET_LOCK/.test(texto)) return [[{ adquirido: lock }]];
      if (/^SELECT RELEASE_LOCK/.test(texto)) return [[{ liberado: 1 }]];
      if (/^SET SESSION lock_wait_timeout/.test(texto)) return [{}];
      if (/^CREATE TABLE IF NOT EXISTS ajb_schema_migration/.test(texto)) return [{}];
      if (/^SELECT checksum FROM ajb_schema_migration/.test(texto)) return [registrada ? [{ checksum: registrada }] : []];
      if (/^(INSERT INTO|UPDATE) ajb_schema_migration/.test(texto)) return [{ affectedRows: 1 }];
      if (/^SELECT DATABASE\(\) AS base/.test(texto)) return [[{ base: "db_miajb" }]];
      if (/SELECT COUNT\(\*\) AS total FROM information_schema\.TABLES/.test(texto)) return [[{ total: esquema[params[0]] ? 1 : 0 }]];
      if (/SELECT TABLE_COLLATION FROM information_schema\.TABLES/.test(texto)) return [[{ TABLE_COLLATION: esquema[params[0]]?.collation }]];
      if (/FROM information_schema\.COLUMNS/.test(texto)) {
        const tabla = esquema[params[0]];
        return [tabla ? Array.from(tabla.columnas, ([COLUMN_NAME, datos]) => ({ COLUMN_NAME, ...datos })) : []];
      }
      if (/FROM information_schema\.STATISTICS/.test(texto)) {
        const filas = Object.entries(esquema[params[0]]?.indices || {}).flatMap(([INDEX_NAME, columnas]) => (
          columnas.map((COLUMN_NAME, posicion) => ({ INDEX_NAME, SEQ_IN_INDEX: posicion + 1, COLUMN_NAME }))
        ));
        return [filas];
      }
      if (/^SELECT id, nombre FROM estado_reserva WHERE id = \? OR nombre = \?/.test(texto)) {
        return [estados.filter((estado) => estado.id === params[0] || estado.nombre === params[1])];
      }
      if (/^INSERT INTO estado_reserva \(id, nombre\)/.test(texto)) {
        estados.push({ id: params[0], nombre: params[1] });
        return [{ affectedRows: 1 }];
      }
      const altaColumnas = /^ALTER TABLE (\w+) (ADD COLUMN .*)$/.exec(texto);
      if (altaColumnas) {
        for (const [, nombre] of altaColumnas[2].matchAll(/ADD COLUMN (\w+)/g)) {
          const def = definicionColumna(altaColumnas[1], nombre);
          esquema[altaColumnas[1]].columnas.set(nombre, {
            DATA_TYPE: def.dataType,
            COLUMN_TYPE: def.columnType,
            IS_NULLABLE: def.nulable ? "YES" : "NO",
            COLUMN_DEFAULT: def.predeterminado ?? null,
          });
        }
        return [{ affectedRows: 0 }];
      }
      const altaIndice = /^ALTER TABLE (\w+) ADD INDEX (\w+) \(([^)]+)\), ALGORITHM=INPLACE, LOCK=NONE$/.exec(texto);
      if (altaIndice) {
        esquema[altaIndice[1]].indices[altaIndice[2]] = altaIndice[3].split(", ");
        return [{ affectedRows: 0 }];
      }
      const altaTabla = /^CREATE TABLE IF NOT EXISTS (\w+) \(/.exec(texto);
      if (altaTabla) {
        esquema[altaTabla[1]] = { columnas: columnasDeTablaNueva(altaTabla[1]), indices: {}, collation: /COLLATE=(\w+)$/.exec(texto)?.[1] };
        return [{ affectedRows: 0 }];
      }
      if (/^UPDATE (reserva|reserva_politica_cancelacion|reserva_cancelacion_politica) /.test(texto)) {
        const paso = BACKFILL.find((item) => item.sql.replace(/\s+/g, " ").trim() === texto);
        assert.ok(paso, `UPDATE inesperado: ${texto}`);
        return [{ affectedRows: backfill[paso.clave] ?? 0 }];
      }
      if (/^SELECT COUNT\(\*\) AS total FROM reserva r INNER JOIN \(/.test(texto)) return [[{ total: 0 }]];
      if (/^SELECT COUNT\(\*\) AS total FROM reserva r WHERE NOT EXISTS/.test(texto)) return [[{ total: 2 }]];
      if (/FROM reserva_politica_cancelacion pc INNER JOIN reserva r/.test(texto) && /^SELECT COUNT/.test(texto)) {
        return [[{ total: 3, afiliado: 2, staff: 1 }]];
      }
      if (/FROM reserva_cancelacion_politica rcp INNER JOIN reserva r/.test(texto) && /^SELECT COUNT/.test(texto)) {
        return [[{ total: 1, del_duenio: 1 }]];
      }
      if (/^SELECT user, host FROM mysql\.user/.test(texto)) {
        if (mysqlUserFalla) throw Object.assign(new Error("denied"), { code: mysqlUserFalla });
        return [cuentas];
      }
      if (/^GRANT /.test(texto)) {
        if (grantFalla) throw Object.assign(new Error("Access denied"), { code: grantFalla });
        otorgados.push(texto);
        return [{}];
      }
      if (/^FLUSH PRIVILEGES$/.test(texto)) return [{}];
      const showGrants = /^SHOW GRANTS FOR '([^']+)'@'([^']+)'$/.exec(texto);
      if (showGrants) {
        const destino = `'${showGrants[1]}'@'${showGrants[2]}'`;
        const lineas = otorgados.filter((grant) => grant.endsWith(`TO ${destino}`))
          .map((grant) => grant.replace(`TO ${destino}`, `TO \`${showGrants[1]}\`@\`${showGrants[2]}\``));
        return [[`GRANT USAGE ON *.* TO \`${showGrants[1]}\`@\`${showGrants[2]}\``, ...lineas]
          .map((linea) => ({ [`Grants for ${showGrants[1]}@${showGrants[2]}`]: linea }))];
      }
      throw new Error(`Consulta inesperada: ${texto}`);
    },
    async end() {
      this.terminada = true;
    },
  };
}

const silencio = () => {};
// Escrituras de la migración (el registro en ajb_schema_migration se controla aparte).
const escrituras = (conexion) => conexion.consultas
  .filter(({ sql }) => /^(ALTER|CREATE TABLE IF NOT EXISTS reserva_|INSERT|UPDATE|GRANT|FLUSH)/.test(sql))
  .filter(({ sql }) => !/ajb_schema_migration/.test(sql))
  .map(({ sql }) => sql);

// GRANT de DML existente sobre las tablas viejas del circuito, para que la verificación no avise.
const grantsTablasViejas = ["127.0.0.1", "localhost"].flatMap((host) => (
  ["reserva", "reserva_politica_cancelacion", "reserva_cancelacion_politica", "historial_reserva", "notificacion"]
    .map((tabla) => `GRANT SELECT, INSERT, UPDATE, DELETE ON \`db_miajb\`.\`${tabla}\` TO 'miajb_runtime'@'${host}'`)
));

test("aplica columnas, índice, tablas nuevas, estado 15, datos y GRANT; una segunda corrida no cambia el esquema", async () => {
  const esquema = esquemaActual();
  const conexion = crearConexion(esquema, {
    grantsBase: grantsTablasViejas,
    backfill: { creado_por: 13, aceptacion_afiliado: 2, aceptacion_staff: 1, firma_archivo: 3, firma_por: 2, cancelacion_afiliado: 1 },
  });
  const lineas = [];
  const primera = await ejecutarMigracion(conexion, { log: (linea) => lineas.push(linea), usuarioConectado: "root" });

  assert.deepEqual(primera.columnasCreadas, [
    "reserva.creado_por_usuario_id",
    "reserva_politica_cancelacion.modo",
    "reserva_politica_cancelacion.canal",
    "reserva_politica_cancelacion.firma_por",
    "reserva_politica_cancelacion.firma_archivo",
    "reserva_politica_cancelacion.firmada_en",
    "reserva_cancelacion_politica.origen",
    "reserva_cancelacion_politica.canal",
    "reserva_cancelacion_politica.cancelada_por_rol",
    "reserva_cancelacion_politica.motivo",
    "reserva_cancelacion_politica.regla",
  ]);
  assert.deepEqual(primera.indicesCreados, ["reserva.idx_reserva_creado_por"]);
  assert.deepEqual(primera.tablasCreadas, ["reserva_firma_afiliado", "reserva_constancia_archivo"]);
  assert.equal(primera.estadoCreado, true);
  assert.deepEqual(conexion.estados.at(-1), { id: 15, nombre: "Pendiente de firma" });
  assert.deepEqual(primera.backfill, { creado_por: 13, aceptacion_afiliado: 2, aceptacion_staff: 1, firma_archivo: 3, firma_por: 2, cancelacion_afiliado: 1 });

  const ddl = escrituras(conexion);
  assert.match(ddl[0], /^ALTER TABLE reserva ADD COLUMN creado_por_usuario_id INT NULL DEFAULT NULL COMMENT '[^']+' AFTER usuario_id$/);
  assert.match(ddl[1], /^ALTER TABLE reserva_politica_cancelacion ADD COLUMN modo ENUM\('AFILIADO','CARGA_ADMINISTRATIVA'\) NULL DEFAULT NULL COMMENT '[^']+' AFTER aceptada_en, /);
  assert.match(ddl[1], /ADD COLUMN canal ENUM\('APP','PRESENCIAL','TELEFONO','ENVIO'\) NULL DEFAULT NULL COMMENT '[^']+' AFTER modo, /);
  assert.match(ddl[1], /ADD COLUMN firmada_en DATETIME NULL DEFAULT NULL AFTER firma_archivo$/);
  assert.match(ddl[2], /^ALTER TABLE reserva_cancelacion_politica ADD COLUMN origen ENUM\('AFILIADO','STAFF_A_PEDIDO'\) NULL DEFAULT NULL COMMENT '[^']+' AFTER cancelada_por, /);
  assert.match(ddl[2], /ADD COLUMN regla ENUM\('POLITICA','SIN_FIRMA'\) NOT NULL DEFAULT 'POLITICA' COMMENT '[^']+' AFTER tipo_base$/);
  assert.equal(ddl[3], "ALTER TABLE reserva ADD INDEX idx_reserva_creado_por (creado_por_usuario_id), ALGORITHM=INPLACE, LOCK=NONE");
  const firma = ddl.find((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS reserva_firma_afiliado"));
  assert.match(firma, /politica_id BIGINT UNSIGNED NOT NULL, politica_version INT UNSIGNED NOT NULL, politica_snapshot_json JSON NOT NULL/);
  assert.match(firma, /decision ENUM\('PENDIENTE','FIRMADA','RECHAZADA','CANCELADA','VENCIDA'\) NOT NULL DEFAULT 'PENDIENTE'/);
  assert.match(firma, /CONSTRAINT fk_rfa_reserva FOREIGN KEY \(reserva_id\) REFERENCES reserva \(id\) ON DELETE CASCADE/);
  assert.match(firma, /COLLATE=utf8mb4_0900_ai_ci$/);
  assert.doesNotMatch(firma, /firmante|canal_firma|firma_archivo/, "la prueba de la firma vive en reserva_politica_cancelacion");
  assert.ok(ddl.some((sql) => /^CREATE TABLE IF NOT EXISTS reserva_constancia_archivo .*eliminado TINYINT\(1\) NOT NULL DEFAULT 0/.test(sql)));

  // El catálogo y los datos van en una transacción, después del DDL.
  assert.deepEqual(conexion.transaccion, ["begin", "commit"]);
  const indiceInsert = conexion.consultas.findIndex(({ sql }) => /^INSERT INTO estado_reserva/.test(sql));
  const indiceUltimoAlter = conexion.consultas.map(({ sql }) => /^(ALTER|CREATE TABLE IF NOT EXISTS reserva_)/.test(sql)).lastIndexOf(true);
  assert.ok(indiceInsert > indiceUltimoAlter);
  assert.ok(conexion.consultas.some(({ sql }) => /^SELECT id, nombre FROM estado_reserva .* FOR UPDATE$/.test(sql)));

  // GRANT a las dos cuentas del runtime sobre las dos tablas nuevas, y verificación.
  const grants = ddl.filter((sql) => sql.startsWith("GRANT"));
  assert.deepEqual(grants, [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`reserva_firma_afiliado` TO 'miajb_runtime'@'127.0.0.1'",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`reserva_constancia_archivo` TO 'miajb_runtime'@'127.0.0.1'",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`reserva_firma_afiliado` TO 'miajb_runtime'@'localhost'",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`reserva_constancia_archivo` TO 'miajb_runtime'@'localhost'",
  ]);
  assert.ok(ddl.includes("FLUSH PRIVILEGES"));
  assert.deepEqual(primera.grants.permisos.map((permiso) => permiso.faltantes), [{}, {}]);
  assert.ok(lineas.some((linea) => /✔ SHOW GRANTS 'miajb_runtime'@'localhost'/.test(linea)));

  // Segunda corrida: nada de DDL, el estado ya existe y los datos sólo tocan lo vacío.
  const otra = crearConexion(esquema, { estados: conexion.estados, grantsBase: conexion.otorgados });
  const segunda = await ejecutarMigracion(otra, { log: silencio, usuarioConectado: "root" });
  assert.deepEqual(segunda.columnasCreadas, []);
  assert.deepEqual(segunda.indicesCreados, []);
  assert.deepEqual(segunda.tablasCreadas, []);
  assert.equal(segunda.estadoCreado, false);
  assert.equal(segunda.catalogo, "EXISTE");
  assert.equal(segunda.columnasExistentes.length, 11);
  assert.deepEqual(segunda.tablasExistentes, ["reserva_firma_afiliado", "reserva_constancia_archivo"]);
  assert.equal(escrituras(otra).filter((sql) => /^(ALTER|CREATE|INSERT)/.test(sql)).length, 0);
  // Cada backfill vuelve a correr pero sólo sobre lo vacío (WHERE … IS NULL).
  for (const paso of BACKFILL) assert.match(paso.sql, /IS NULL/, paso.clave);
});

test("--check sólo informa: no escribe esquema, datos, estado, permisos ni registro", async () => {
  const conexion = crearConexion(esquemaActual());
  const lineas = [];
  const resultado = await ejecutarMigracion(conexion, { checkOnly: true, log: (linea) => lineas.push(linea) });
  assert.deepEqual(escrituras(conexion), []);
  assert.deepEqual(conexion.transaccion, []);
  assert.equal(conexion.consultas.some(({ sql }) => /ajb_schema_migration/.test(sql)), false);
  // 11 columnas, 1 índice, 2 tablas, el estado 15 y, sin GRANT previos, 2 tablas × 2 cuentas.
  assert.equal(resultado.pendientes.length, 11 + 1 + 2 + 1 + 4);
  assert.ok(lineas.some((linea) => /\[PENDIENTE\] INSERT INTO estado_reserva \(id, nombre\) VALUES \(15, 'Pendiente de firma'\)/.test(linea)));
  assert.ok(lineas.some((linea) => /\[PENDIENTE\] CREATE TABLE reserva_firma_afiliado/.test(linea)));
  assert.ok(lineas.some((linea) => /\[PENDIENTE\] GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`\.`reserva_firma_afiliado` TO 'miajb_runtime'@'localhost'/.test(linea)));
  assert.equal(lineas.filter((linea) => /\[PENDIENTE\] GRANT /.test(linea)).length, 4);
  // Sin GRANT previos en develop: informa lo mínimo que el circuito usa en las tablas viejas
  // (las aceptaciones son inmutables: SELECT e INSERT, sin sugerir UPDATE ni DELETE).
  assert.ok(lineas.some((linea) => /Aviso: 'miajb_runtime'@'localhost' no tiene SELECT, INSERT sobre reserva_politica_cancelacion; el circuito necesita al menos SELECT, INSERT \(/.test(linea)));
  assert.ok(lineas.some((linea) => /Aviso: 'miajb_runtime'@'localhost' no tiene SELECT, INSERT, UPDATE sobre reserva; el circuito necesita al menos SELECT, INSERT, UPDATE \(/.test(linea)));
  assert.equal(lineas.some((linea) => /otorgalo|DELETE sobre (reserva_politica_cancelacion|reserva_cancelacion_politica|historial_reserva)/.test(linea)), false);
  // Lo que falta en las tablas nuevas sale una sola vez, como GRANT pendiente.
  assert.equal(lineas.some((linea) => /· Falta .* sobre reserva_firma_afiliado/.test(linea)), false);
  assert.deepEqual(resultado.conteos, {
    reservas_creador_a_completar: 0,
    reservas_sin_create_en_historial: 2,
    aceptaciones_sin_modo: 3,
    aceptaciones_afiliado: 2,
    aceptaciones_staff: 1,
    aceptaciones_sin_dato: 0,
    cancelaciones_sin_origen: 1,
    cancelaciones_del_duenio: 1,
    cancelaciones_sin_dato: 0,
  });
});

test("--check en una base ya migrada: los GRANT que SHOW GRANTS ya muestra no salen como pendientes; si falta uno, sólo ése", async () => {
  // Primera corrida (como la de develop): esquema, estado 15 y GRANT a las dos cuentas.
  const esquema = esquemaActual();
  const aplicada = crearConexion(esquema, { grantsBase: grantsTablasViejas });
  await ejecutarMigracion(aplicada, { log: silencio, usuarioConectado: "root" });

  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  const chequear = async (grantsBase) => {
    const conexion = crearConexion(esquema, { estados: aplicada.estados, grantsBase });
    const lineas = [];
    await main({ argv: ["--check"], env: remoto, conectar: async () => conexion, log: (linea) => lineas.push(linea) });
    assert.deepEqual(escrituras(conexion), []);
    return lineas;
  };

  // SHOW GRANTS (con backticks, como MySQL 8) ya tiene todo: nada pendiente y el cierre lo dice.
  const completa = await chequear(aplicada.otorgados);
  assert.deepEqual(completa.filter((linea) => /\[PENDIENTE\]/.test(linea)), []);
  assert.equal(completa.filter((linea) => /✔ SHOW GRANTS 'miajb_runtime'@'(127\.0\.0\.1|localhost)': tiene lo necesario/.test(linea)).length, 2);
  assert.equal(completa.at(-1), "Chequeo completado sin cambios (0 cambio(s) pendiente(s)).");

  // A 'localhost' le dieron sólo SELECT e INSERT sobre reserva_firma_afiliado: falta lo demás, nada más.
  const completo = "GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`.`reserva_firma_afiliado` TO 'miajb_runtime'@'localhost'";
  assert.ok(aplicada.otorgados.includes(completo));
  const parcial = await chequear(aplicada.otorgados
    .filter((grant) => grant !== completo)
    .concat("GRANT SELECT, INSERT ON `db_miajb`.`reserva_firma_afiliado` TO 'miajb_runtime'@'localhost'"));
  assert.deepEqual(parcial.filter((linea) => /\[PENDIENTE\]/.test(linea)), [
    "  [PENDIENTE] GRANT UPDATE, DELETE ON `db_miajb`.`reserva_firma_afiliado` TO 'miajb_runtime'@'localhost'",
  ]);
  assert.equal(parcial.at(-1), "Chequeo completado sin cambios (1 cambio(s) pendiente(s)).");
});

test("tablas existentes: verifica lo mínimo que usa el circuito y sólo informa lo que falta", async () => {
  const minimos = ["127.0.0.1", "localhost"].flatMap((host) => [
    `GRANT SELECT ON \`db_miajb\`.\`reserva\` TO 'miajb_runtime'@'${host}'`,
    ...["reserva_politica_cancelacion", "reserva_cancelacion_politica", "historial_reserva"]
      .map((tabla) => `GRANT SELECT, INSERT ON \`db_miajb\`.\`${tabla}\` TO 'miajb_runtime'@'${host}'`),
    `GRANT SELECT, INSERT, UPDATE ON \`db_miajb\`.\`notificacion\` TO 'miajb_runtime'@'${host}'`,
  ]);
  const conexion = crearConexion(esquemaActual(), { grantsBase: minimos });
  const lineas = [];
  const resultado = await ejecutarMigracion(conexion, { log: (linea) => lineas.push(linea), usuarioConectado: "root" });
  // Aceptaciones, cancelaciones e historial son registros que sólo se agregan: SELECT e INSERT alcanzan.
  assert.deepEqual(resultado.grants.permisos.map((permiso) => permiso.faltantes), [
    { reserva: ["INSERT", "UPDATE"] },
    { reserva: ["INSERT", "UPDATE"] },
  ]);
  const avisos = lineas.filter((linea) => /Aviso: 'miajb_runtime'/.test(linea));
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /^ {2}· Aviso: 'miajb_runtime'@'localhost' no tiene INSERT, UPDATE sobre reserva; el circuito necesita al menos SELECT, INSERT, UPDATE \(tabla existente/);
  assert.equal(lineas.some((linea) => /otorgalo/.test(linea)), false);
});

test("frena sin tocar nada si el id 15 ya es otro estado", async () => {
  for (const modo of [{ checkOnly: false }, { checkOnly: true }]) {
    const conexion = crearConexion(esquemaActual(), { estados: [{ id: 15, nombre: "Pendiente_Firma" }] });
    await assert.rejects(
      () => ejecutarMigracion(conexion, { ...modo, log: silencio }),
      /El id 15 de estado_reserva ya es 'Pendiente_Firma'\. La migración frena sin tocar nada/
    );
    assert.deepEqual(escrituras(conexion), [], JSON.stringify(modo));
  }
});

test("frena si 'Pendiente de firma' existe con otro id", async () => {
  const conexion = crearConexion(esquemaActual(), { estados: [{ id: 16, nombre: "Pendiente de firma" }] });
  await assert.rejects(() => ejecutarMigracion(conexion, { log: silencio }), /ya existe con id 16, pero el backend espera el 15/);
  assert.deepEqual(escrituras(conexion), []);
});

test("frena si una columna o una tabla nueva ya existen con otra definición", async () => {
  const esquema = esquemaActual();
  esquema.reserva_politica_cancelacion.columnas.set("canal", columna("varchar", "varchar(20)"));
  const conexion = crearConexion(esquema);
  await assert.rejects(() => ejecutarMigracion(conexion, { log: silencio }), /reserva_politica_cancelacion\.canal: tipo varchar \(se esperaba enum\)/);
  assert.deepEqual(escrituras(conexion), []);

  const otro = esquemaActual();
  otro.reserva_firma_afiliado = { columnas: new Map([["reserva_id", columna("int", "int", "NO")]]), indices: {}, collation: "utf8mb4_0900_ai_ci" };
  const conexionTabla = crearConexion(otro);
  await assert.rejects(() => ejecutarMigracion(conexionTabla, { log: silencio }), /La tabla reserva_firma_afiliado ya existe con otra definición/);
  assert.deepEqual(escrituras(conexionTabla), []);
});

test("frena si reserva.id no es INT (las claves foráneas no serían compatibles)", async () => {
  const esquema = esquemaActual();
  esquema.reserva.columnas.set("id", columna("bigint", "bigint unsigned", "NO"));
  const conexion = crearConexion(esquema);
  await assert.rejects(() => ejecutarMigracion(conexion, { log: silencio }), /reserva\.id es bigint unsigned/);
  assert.deepEqual(escrituras(conexion), []);
});

test("sin permiso para GRANT avisa e imprime las sentencias, y el esquema queda igual", async () => {
  const conexion = crearConexion(esquemaActual(), { grantFalla: "ER_ACCESS_DENIED_ERROR" });
  const lineas = [];
  const resultado = await ejecutarMigracion(conexion, { log: (linea) => lineas.push(linea), usuarioConectado: "admin" });
  assert.equal(resultado.tablasCreadas.length, 2);
  assert.equal(resultado.grants.sentenciasPendientes.length, 4);
  const aviso = lineas.find((linea) => /No se pudieron otorgar los permisos/.test(linea));
  assert.match(aviso, /GRANT SELECT, INSERT, UPDATE, DELETE ON `db_miajb`\.`reserva_firma_afiliado` TO 'miajb_runtime'@'127\.0\.0\.1';/);
  assert.match(aviso, /FLUSH PRIVILEGES;/);
  assert.ok(lineas.some((linea) => /· Falta SELECT, INSERT, UPDATE, DELETE sobre reserva_firma_afiliado para 'miajb_runtime'@'localhost'/.test(linea)));
});

test("conectado como el runtime no intenta otorgarse permisos; sin acceso a mysql.user avisa", async () => {
  const conexion = crearConexion(esquemaActual());
  const lineas = [];
  const resultado = await ejecutarMigracion(conexion, { log: (linea) => lineas.push(linea), usuarioConectado: "miajb_runtime" });
  assert.equal(conexion.consultas.some(({ sql }) => /^GRANT/.test(sql)), false);
  assert.equal(resultado.grants.sentenciasPendientes.length, 4);
  assert.ok(lineas.some((linea) => /no puede otorgarse permisos a sí mismo/.test(linea)));

  const sinMysqlUser = crearConexion(esquemaActual(), { mysqlUserFalla: "ER_TABLEACCESS_DENIED_ERROR" });
  const avisos = [];
  const otro = await ejecutarMigracion(sinMysqlUser, { log: (linea) => avisos.push(linea), usuarioConectado: "admin" });
  assert.equal(sinMysqlUser.consultas.some(({ sql }) => /^GRANT/.test(sql)), false);
  assert.match(otro.grants.aviso, /No se pudo leer mysql\.user/);
});

test("SHOW GRANTS: interpreta tabla, base completa, ALL y comodines", () => {
  const linea = (objeto, privilegios = "SELECT, INSERT, UPDATE, DELETE") => `GRANT ${privilegios} ON ${objeto} TO \`miajb_runtime\`@\`localhost\``;
  assert.deepEqual([...privilegiosDeGrant(linea("`db_miajb`.`reserva`"), "db_miajb", "reserva")], ["SELECT", "INSERT", "UPDATE", "DELETE"]);
  assert.equal(privilegiosDeGrant(linea("`db_miajb`.`reserva`"), "db_miajb", "reserva_firma_afiliado").size, 0);
  assert.equal(privilegiosDeGrant(linea("`db_miajb`.*"), "db_miajb", "reserva_firma_afiliado").size, 4);
  assert.equal(privilegiosDeGrant(linea("`db\\_miajb`.*", "ALL PRIVILEGES"), "db_miajb", "reserva_firma_afiliado").size, 4);
  assert.equal(privilegiosDeGrant(linea("`otra`.*"), "db_miajb", "reserva").size, 0);
  assert.deepEqual([...privilegiosDeGrant(linea("`db_miajb`.`reserva`", "SELECT (id, nombre), UPDATE"), "db_miajb", "reserva")], ["UPDATE"]);
  assert.equal(privilegiosDeGrant("GRANT USAGE ON *.* TO `miajb_runtime`@`localhost`", "db_miajb", "reserva").size, 0);
  assert.equal(esquemaCoincide("`db%`", "db_miajb"), true);
  assert.equal(esquemaCoincide("`db\\_x`", "dbAx"), false);
});

test("argumentos y destino: producción exige --allow-production", () => {
  assert.deepEqual(parsearArgumentos(["--check"]), { checkOnly: true, allowProduction: false });
  assert.throws(() => parsearArgumentos(["--force"]), /Argumentos desconocidos/);
  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  assert.throws(() => validarDestino({ checkOnly: false, allowProduction: false }, remoto), /--allow-production/);
  assert.doesNotThrow(() => validarDestino({ checkOnly: true, allowProduction: false }, remoto));
  assert.doesNotThrow(() => validarDestino({ checkOnly: false, allowProduction: true }, remoto));
  assert.doesNotThrow(() => validarDestino({ checkOnly: false, allowProduction: false }, { ...remoto, DB_HOST: "localhost" }));
  assert.throws(() => validarDestino({ checkOnly: false, allowProduction: false }, { ...remoto, DB_HOST: "localhost", NODE_ENV: "production" }), /--allow-production/);
});

test("main toma el lock, registra la corrida y no se conecta a producción sin permiso", async () => {
  const remoto = { DB_HOST: "db.rds.test", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  let conecto = false;
  await assert.rejects(
    () => main({ argv: [], env: remoto, conectar: async () => { conecto = true; }, log: silencio }),
    /--allow-production/
  );
  assert.equal(conecto, false);

  const conexion = crearConexion(esquemaActual());
  await main({ argv: [], env: { ...remoto, DB_HOST: "localhost" }, conectar: async () => conexion, log: silencio });
  const sqls = conexion.consultas.map(({ sql }) => sql);
  assert.equal(conexion.consultas[0].params[0], MIGRATION_LOCK);
  assert.match(sqls[0], /^SELECT GET_LOCK/);
  // Con el lock tomado y antes de cualquier DDL: no espera un metadata lock más de 10 s.
  assert.equal(sqls[1], "SET SESSION lock_wait_timeout = 10, innodb_lock_wait_timeout = 10");
  const registro = conexion.consultas.find(({ sql }) => /^INSERT INTO ajb_schema_migration/.test(sql));
  assert.deepEqual(registro.params, [MIGRATION_ID, MIGRATION_CHECKSUM, 1]);
  const cierre = conexion.consultas.find(({ sql }) => /^UPDATE ajb_schema_migration/.test(sql));
  assert.equal(cierre.params[0], "APLICADA");
  assert.match(cierre.params[2], /estado 15: creado/);
  assert.match(sqls.at(-1), /^SELECT RELEASE_LOCK/);
  assert.equal(conexion.terminada, true);

  // --check contra la RDS: sin registro ni escrituras.
  const chequeo = crearConexion(esquemaActual());
  await main({ argv: ["--check"], env: remoto, conectar: async () => chequeo, log: silencio });
  assert.equal(chequeo.consultas.filter(({ sql }) => /ajb_schema_migration/.test(sql)).length, 0);
  assert.deepEqual(escrituras(chequeo), []);
});

test("main: si los permisos del runtime no quedan confirmados, la corrida queda APLICADA pero lo dice al final y devuelve grantsIncompletos", async () => {
  const env = { DB_HOST: "localhost", DB_USER: "admin", DB_PASSWORD: "x", DB_DATABASE: "db_miajb" };
  const correr = async (opciones) => {
    const conexion = crearConexion(esquemaActual(), opciones);
    const lineas = [];
    const resultado = await main({ argv: [], env, conectar: async () => conexion, log: (linea) => lineas.push(linea) });
    const cierre = conexion.consultas.find(({ sql }) => /^UPDATE ajb_schema_migration/.test(sql));
    return { resultado, lineas, estado: cierre.params[0], final: lineas.at(-1) };
  };
  const PERO = /^Migracion 20261022_firma_condiciones_reserva_v1 aplicada, PERO los permisos de miajb_runtime sobre las tablas nuevas no quedaron confirmados/;

  // Sin GRANT OPTION: el esquema queda, el registro dice APLICADA y el final no deja seguir de largo.
  const sinGrant = await correr({ grantFalla: "ER_ACCESS_DENIED_ERROR" });
  assert.equal(sinGrant.resultado.grantsIncompletos, true);
  assert.equal(sinGrant.estado, "APLICADA");
  assert.match(sinGrant.final, PERO);
  assert.match(sinGrant.final, /antes de desplegar el backend\.$/);
  // Sin acceso a mysql.user no se sabe: tampoco sigue de largo.
  const sinMysqlUser = await correr({ mysqlUserFalla: "ER_TABLEACCESS_DENIED_ERROR" });
  assert.equal(sinMysqlUser.resultado.grantsIncompletos, true);
  assert.match(sinMysqlUser.final, PERO);

  // GRANT otorgados y confirmados con SHOW GRANTS (aunque falte algo en tablas existentes, que sólo se informa).
  const completa = await correr({});
  assert.equal(completa.resultado.grantsIncompletos, false);
  assert.equal(completa.final, "Migracion 20261022_firma_condiciones_reserva_v1 aplicada.");
  // Una base sin la cuenta runtime (no hay nada que otorgar) no es un error.
  const sinRuntime = await correr({ cuentas: [] });
  assert.equal(sinRuntime.resultado.grantsIncompletos, false);
  assert.equal(sinRuntime.final, "Migracion 20261022_firma_condiciones_reserva_v1 aplicada.");
});

test("main marca la corrida como FALLIDA si algo sale mal y libera el lock", async () => {
  const conexion = crearConexion(esquemaActual(), { estados: [{ id: 15, nombre: "Otro" }] });
  await assert.rejects(
    () => main({ argv: [], env: { DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "x", DB_DATABASE: "db" }, conectar: async () => conexion, log: silencio }),
    /El id 15 de estado_reserva ya es 'Otro'/
  );
  const cierre = conexion.consultas.find(({ sql }) => /^UPDATE ajb_schema_migration/.test(sql));
  assert.equal(cierre.params[0], "FALLIDA");
  assert.match(conexion.consultas.at(-1).sql, /^SELECT RELEASE_LOCK/);
  assert.deepEqual(escrituras(conexion), []);
});

test("frena si la migración ya se registró con otro checksum", async () => {
  const conexion = crearConexion(esquemaActual(), { registrada: "otro" });
  await assert.rejects(
    () => main({ argv: [], env: { DB_HOST: "localhost", DB_USER: "root", DB_PASSWORD: "x", DB_DATABASE: "db" }, conectar: async () => conexion, log: silencio }),
    /ya fue registrada con otro checksum/
  );
  assert.deepEqual(escrituras(conexion), []);
});
