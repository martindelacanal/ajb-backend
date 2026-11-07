"use strict";

// Precios de adicionales por reglas (catálogo del predio y temporadas de Turismo).
//
//   - adicional.modalidad: ALQUILER (se cobra por unidad y por día, se devuelve) o VENTA (se cobra
//     una sola vez por unidad; p. ej. una bolsa de carbón).
//   - adicional_precio: reglas de precio por ámbito (temporada o catálogo de un predio), con alcance
//     todos / servicio / recurso y régimen opcional, entre dos fechas.
//   - tarifa_adicional.adicional_precio_id: fila generada por una regla. temporada_tarifa_id pasa a
//     admitir NULL: los precios del catálogo de un predio no pertenecen a ninguna temporada.
//   - Los precios que el catálogo del predio guardaba antes en temporadas propias
//     («Alquileres de predio · …») pasan al catálogo del predio como reglas.
//
// Uso (desde BACKEND):
//   node scripts/migrar-adicionales-precios.js --check --target=develop
//   node scripts/migrar-adicionales-precios.js --apply --target=develop --confirm=APLICAR_WEBAUTHN
//   node scripts/migrar-adicionales-precios.js --apply --target=production --allow-production --confirm=APLICAR_WEBAUTHN
// En el EC2 (credenciales en el entorno): node scripts/migrar-adicionales-precios.js --apply --desde-entorno
// Opcional: --adoptar-temporadas=12,15 suma temporadas cuyos precios de adicionales pasan al predio.

const DDL_ADICIONAL_PRECIO = `CREATE TABLE IF NOT EXISTS adicional_precio (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  temporada_tarifa_id INT NULL,
  predio_id INT NULL,
  adicional_id INT NOT NULL,
  servicio_id INT NULL,
  recurso_id INT NULL,
  regimen_id INT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  precio DECIMAL(12,2) NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  usuario_id INT NULL,
  usuario_nombre VARCHAR(160) NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_baja DATETIME NULL,
  KEY ix_adicional_precio_temporada (temporada_tarifa_id, activo, adicional_id),
  KEY ix_adicional_precio_predio (predio_id, activo, adicional_id),
  KEY ix_adicional_precio_adicional (adicional_id),
  CONSTRAINT fk_adicional_precio_temporada FOREIGN KEY (temporada_tarifa_id) REFERENCES temporada_tarifa(id) ON DELETE CASCADE,
  CONSTRAINT fk_adicional_precio_adicional FOREIGN KEY (adicional_id) REFERENCES adicional(id),
  CONSTRAINT fk_adicional_precio_servicio FOREIGN KEY (servicio_id) REFERENCES servicio(id),
  CONSTRAINT fk_adicional_precio_recurso FOREIGN KEY (recurso_id) REFERENCES recurso(id),
  CONSTRAINT fk_adicional_precio_regimen FOREIGN KEY (regimen_id) REFERENCES regimen(id),
  CONSTRAINT chk_adicional_precio CHECK (precio >= 0 AND fecha_inicio <= fecha_fin),
  CONSTRAINT chk_adicional_precio_ambito CHECK ((temporada_tarifa_id IS NULL) <> (predio_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

async function columnas(c, tabla) {
  const [r] = await c.query("SELECT column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [tabla]);
  return new Map(r.map(f => [f.c || f.COLUMN_NAME, f.n || f.IS_NULLABLE]));
}
async function indice(c, tabla, nombre) {
  const [r] = await c.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1", [tabla, nombre]);
  return r.length > 0;
}

async function faltantes(c) {
  const lista = [];
  const [t] = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'adicional_precio'");
  if (!t.length) lista.push("tabla adicional_precio");
  if (!(await columnas(c, "adicional")).has("modalidad")) lista.push("adicional.modalidad");
  const ta = await columnas(c, "tarifa_adicional");
  if (!ta.has("adicional_precio_id")) lista.push("tarifa_adicional.adicional_precio_id");
  if (ta.get("temporada_tarifa_id") !== "YES") lista.push("tarifa_adicional.temporada_tarifa_id admite NULL");
  return lista;
}

async function aplicarEsquema(c, { runtime = true } = {}) {
  await c.query(DDL_ADICIONAL_PRECIO);
  if (!(await columnas(c, "adicional")).has("modalidad")) {
    await c.query("ALTER TABLE adicional ADD COLUMN modalidad ENUM('ALQUILER','VENTA') NOT NULL DEFAULT 'ALQUILER'");
  }
  const ta = await columnas(c, "tarifa_adicional");
  if (!ta.has("adicional_precio_id")) {
    await c.query("ALTER TABLE tarifa_adicional ADD COLUMN adicional_precio_id INT NULL");
  }
  if (!(await indice(c, "tarifa_adicional", "ix_tarifa_adicional_regla"))) {
    await c.query("ALTER TABLE tarifa_adicional ADD KEY ix_tarifa_adicional_regla (adicional_precio_id)");
  }
  if (ta.get("temporada_tarifa_id") !== "YES") {
    await c.query("ALTER TABLE tarifa_adicional MODIFY temporada_tarifa_id INT NULL");
  }
  if (!runtime) return;
  const [[{ base }]] = await c.query("SELECT DATABASE() AS base");
  let hosts = [];
  try { [hosts] = await c.query("SELECT Host AS host FROM mysql.user WHERE User = 'miajb_runtime'"); } catch (_e) { hosts = []; }
  for (const { host } of hosts) {
    await c.query("GRANT SELECT, INSERT, UPDATE ON ??.adicional_precio TO 'miajb_runtime'@?", [base, host]);
  }
}

/** Pasa al catálogo del predio los precios que el catálogo viejo guardaba en temporadas propias. */
async function adoptarPreciosDePredios(c, { temporadasExtra = [], log = console.log } = {}) {
  const P = require("../api/services/adicionales-precios");
  const { serviciosDe } = require("../api/services/predios-central");
  const [predios] = await c.query("SELECT * FROM predio WHERE activo = 1");
  let total = 0;
  for (const predio of predios) {
    const codigos = serviciosDe(predio);
    if (!codigos.length) continue;
    const [servicios] = await c.query("SELECT id FROM servicio WHERE codigo IN (?)", [codigos]);
    const ambito = { predio_id: predio.id, servicio_ids: servicios.map(s => Number(s.id)) };
    const destinos = await P.destinosDeAmbito(c, ambito);
    if (!destinos.length) continue;
    const [filas] = await c.query(`SELECT ta.id, ta.adicional_id, ta.recurso_id, ta.regimen_id, ta.fecha_inicio, ta.fecha_fin, ta.precio
      FROM tarifa_adicional ta JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
      WHERE ta.activo = 1 AND ta.adicional_precio_id IS NULL AND ta.recurso_id IN (?)
        AND (tt.nombre LIKE 'Alquileres de predio%'${temporadasExtra.length ? " OR tt.id IN (?)" : ""})
      FOR UPDATE`, [destinos.map(d => d.recurso_id), ...(temporadasExtra.length ? [temporadasExtra] : [])]);
    if (!filas.length) continue;
    const reglas = P.inferirReglas(filas, destinos).map((r, i) => ({ ...r, clave: i }));
    const ids = [...new Set(reglas.map(r => r.adicional_id))];
    // Las existentes del predio para esos adicionales se suman: la regla nueva no reemplaza otra.
    const previas = (await P.reglasDeAmbito(c, { predio_id: predio.id })).filter(r => ids.includes(Number(r.adicional_id)))
      .map((r, i) => ({ ...r, clave: reglas.length + i }));
    await c.query(`UPDATE tarifa_adicional SET activo = 0, fecha_eliminacion = NOW(), eliminado_motivo = 'REEMPLAZADO', eliminado_lote = ?
      WHERE id IN (?)`, [require("../predios/lib/util").uuid(), filas.map(f => f.id)]);
    await P.materializar(c, ambito, ids, reglas.concat(previas), { destinos, verificarOtrosAmbitos: false, actorNombre: "Migración de precios de adicionales" });
    total += reglas.length;
    log(`  ${predio.codigo}: ${filas.length} precios por recurso pasaron a ${reglas.length} reglas del catálogo del predio`);
  }
  return total;
}

/** Informe: adicionales de los recursos de cada predio, por temporada (para decidir adopciones). */
async function informe(c, log = console.log) {
  const { serviciosDe } = require("../api/services/predios-central");
  const [predios] = await c.query("SELECT * FROM predio WHERE activo = 1");
  for (const predio of predios) {
    const codigos = serviciosDe(predio);
    if (!codigos.length) continue;
    const [r] = await c.query(`SELECT COALESCE(tt.nombre, 'Catálogo del predio') AS ambito, tt.id AS temporada_id, a.nombre, COUNT(*) AS filas
      FROM tarifa_adicional ta JOIN adicional a ON a.id = ta.adicional_id JOIN recurso r ON r.id = ta.recurso_id
      JOIN servicio s ON s.id = r.servicio_id LEFT JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
      WHERE ta.activo = 1 AND s.codigo IN (?) GROUP BY ambito, temporada_id, a.nombre ORDER BY ambito, a.nombre`, [codigos]);
    log(`  ${predio.codigo}: ${r.length ? "" : "sin precios de adicionales"}`);
    for (const x of r) log(`    [${x.temporada_id || "-"}] ${x.ambito} · ${x.nombre} (${x.filas} filas)`);
  }
}

async function aplicar(c, opciones = {}) {
  await aplicarEsquema(c, opciones);
  await c.beginTransaction();
  try {
    await adoptarPreciosDePredios(c, opciones);
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  }
}

async function main() {
  const fs = require("node:fs");
  const mysql = require("mysql2/promise");
  const argv = process.argv.slice(2);
  const temporadasExtra = (argv.find(a => a.startsWith("--adoptar-temporadas=")) || "").slice("--adoptar-temporadas=".length)
    .split(",").map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  const conexiones = [];
  if (argv.includes("--desde-entorno")) {
    require("dotenv").config();
    const e = process.env;
    conexiones.push({ nombre: e.DB_HOST, opciones: {
      host: e.DB_HOST, user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_DATABASE, port: Number(e.DB_PORT || 3306),
      ssl: String(e.DB_SSL_MODE || "disabled").toLowerCase() === "disabled" ? undefined : { ca: fs.readFileSync(e.DB_SSL_CA_PATH), rejectUnauthorized: true },
    } });
  } else {
    const M = require("./migrar-webauthn-v1");
    const opciones = M.parsearArgumentos(argv.filter(a => !a.startsWith("--adoptar-temporadas=")));
    const entornos = M.obtenerEntornos(opciones, fs.readFileSync(opciones.envFile, "utf8"));
    M.validarApplySeguro(opciones, entornos);
    for (const { nombre, config } of entornos) conexiones.push({ nombre, opciones: M.crearOpcionesConexion(config) });
  }
  const aplicarCambios = argv.includes("--apply");
  for (const { nombre, opciones } of conexiones) {
    const c = await mysql.createConnection({ ...opciones, dateStrings: true, decimalNumbers: true });
    try {
      const antes = await faltantes(c);
      console.log(`[adicionales-precios] ${nombre}: ${antes.length ? "falta " + antes.join(", ") : "esquema al día"}`);
      if (aplicarCambios) {
        await aplicar(c, { temporadasExtra });
        const despues = await faltantes(c);
        if (despues.length) throw Error("Quedó pendiente: " + despues.join(", "));
        console.log(`[adicionales-precios] ${nombre}: esquema aplicado`);
      }
      await informe(c);
    } finally { await c.end(); }
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { DDL_ADICIONAL_PRECIO, aplicar, aplicarEsquema, adoptarPreciosDePredios, faltantes };
