// Iconos de los filtros/características de turismo.
//
// - Amplía filtro.icono a VARCHAR(60) (los nombres de Material Symbols como
//   "baby_changing_station" no entraban en 20 caracteres).
// - Completa el icono de los filtros del catálogo que no tienen uno, por
//   código; los que ya tienen icono se respetan.
//
// Idempotente. Uso:
//   node scripts/migrar-turismo-iconos-filtros.js                      → develop (DB_HOST localhost)
//   node scripts/migrar-turismo-iconos-filtros.js --allow-production   → obligatorio si DB_HOST no es localhost
//   node scripts/migrar-turismo-iconos-filtros.js --check              → solo informa, no escribe
//
// En develop el backend corre como miajb_runtime (sin ALTER): correr con la
// cuenta administrativa por entorno (dotenv no pisa lo ya definido):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb node scripts/migrar-turismo-iconos-filtros.js

require("dotenv").config();
const mysql = require("mysql2/promise");

const args = process.argv.slice(2);
const permiteProduccion = args.includes("--allow-production");
const soloCheck = args.includes("--check");

// Nombres de Material Symbols Outlined (los mismos que renderiza <mat-icon>).
const ICONOS_POR_CODIGO = {
  PERSONAS: "group",
  AMBIENTES: "meeting_room",
  HABITACIONES: "door_front",
  PLANTAS: "stairs",
  CAMAS_INDIVIDUALES: "single_bed",
  CAMAS_MATRIMONIALES: "king_bed",
  BANOS: "bathtub",
  BANO_PRIVADO: "bathroom",
  BANO_EN_SUITE: "shower",
  SIN_BANO: "no_meeting_room",
  MESA_SILLAS: "table_restaurant",
  COCINA_EQUIPADA: "kitchen",
  PARRILLA_PROPIA: "outdoor_grill",
  TIPO_UNIDAD: "holiday_village",
  UBICACION: "place",
  VISTA_MAR: "waves",
  VENTANA_CALLE: "window",
  ENTRA_CATRE: "airline_seat_flat",
  CAMA_MATRIMONIAL_ENTREPISO: "bedroom_parent",
};

async function main() {
  const host = process.env.DB_HOST || "localhost";
  const esLocal = ["localhost", "127.0.0.1"].includes(host);
  if (!esLocal && !permiteProduccion) {
    throw new Error(`DB_HOST=${host} no es local: agregá --allow-production para continuar`);
  }

  const connection = await mysql.createConnection({
    host,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    multipleStatements: false,
  });

  try {
    const [[columna]] = await connection.query(
      `SELECT CHARACTER_MAXIMUM_LENGTH AS largo
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'filtro' AND COLUMN_NAME = 'icono'`
    );
    if (!columna) throw new Error("La tabla filtro no tiene la columna icono");
    console.log(`filtro.icono: VARCHAR(${columna.largo})`);
    if (Number(columna.largo) < 60) {
      if (soloCheck) console.log("  → se ampliaría a VARCHAR(60)");
      else {
        await connection.query("ALTER TABLE filtro MODIFY COLUMN icono VARCHAR(60) DEFAULT NULL");
        console.log("  → ampliada a VARCHAR(60)");
      }
    }

    const [filtros] = await connection.query("SELECT id, codigo, nombre, icono FROM filtro ORDER BY id");
    let actualizados = 0;
    for (const filtro of filtros) {
      const actual = String(filtro.icono || "").trim();
      const sugerido = ICONOS_POR_CODIGO[String(filtro.codigo || "").toUpperCase()] || null;
      if (actual || !sugerido) continue;
      console.log(`  ${filtro.codigo} (${filtro.nombre}) → ${sugerido}`);
      if (!soloCheck) {
        await connection.query("UPDATE filtro SET icono = ? WHERE id = ?", [sugerido, filtro.id]);
      }
      actualizados += 1;
    }
    console.log(`${soloCheck ? "Se completarían" : "Completados"} ${actualizados} iconos de ${filtros.length} filtros.`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
