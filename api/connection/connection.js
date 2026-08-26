const mysql = require('mysql2');
const fs = require('fs');

const connectionLimitRaw = Number(process.env.DB_CONNECTION_LIMIT || 20);
const connectionLimit = Number.isInteger(connectionLimitRaw) && connectionLimitRaw > 0 && connectionLimitRaw <= 100
  ? connectionLimitRaw
  : 20;

function obtenerConfiguracionTls() {
  const modo = String(process.env.DB_SSL_MODE || 'disabled').trim().toLowerCase();
  if (modo === 'disabled') {
    const host = String(process.env.DB_HOST || '').trim().toLowerCase();
    const hostLocal = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (process.env.NODE_ENV === 'production' && !hostLocal) {
      throw new Error('TLS de base de datos es obligatorio para hosts remotos en produccion');
    }
    return undefined;
  }
  if (modo !== 'verify-ca' && modo !== 'verify-full') {
    throw new Error('DB_SSL_MODE debe ser disabled, verify-ca o verify-full');
  }
  const rutaCa = String(process.env.DB_SSL_CA_PATH || '').trim();
  if (!rutaCa) {
    throw new Error('DB_SSL_CA_PATH es requerido cuando TLS de base de datos está habilitado');
  }
  return {
    ca: fs.readFileSync(rutaCa),
    rejectUnauthorized: true,
  };
}

// const mysqlConnection = mysql.createConnection({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_DATABASE,
//   port: process.env.DB_PORT,
//   multipleStatements: true
// });

const mysqlConnection = mysql.createPool({
  connectionLimit,
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  multipleStatements: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // Ojo: no usar maxIdle/idleTimeout. Con maxIdle < connectionLimit mysql2 arma
  // un temporizador que nunca se libera (unref) y mantiene vivo cualquier
  // proceso que cargue este módulo (los tests y scripts no terminan).
  decimalNumbers: true,
  // Toda fecha/hora de negocio se interpreta en Argentina. Esto también alinea
  // CURDATE()/NOW() de MySQL con las validaciones civiles de la API.
  timezone: '-03:00',
  // Los DATE son fechas civiles, no instantes. Devolverlos como texto evita que
  // el huso horario del proceso cambie el dia al serializarlos.
  dateStrings: ["DATE"],
  ssl: obtenerConfiguracionTls(),
});

// mysqlConnection.connect( err => {
//   if(err){
//     console.log('Error en db: ', err);
//     return;
//   }else{
//     console.log('Db ok');
//   }
// });

mysqlConnection.on("connection", connection => {
  console.log("Database connected!");

  connection.query("SET SESSION time_zone = '-03:00'", error => {
    if (error) {
      console.error('No se pudo fijar la zona horaria de la sesión MySQL', error.code);
      connection.destroy();
    }
  });

  connection.on("error", err => {
    // 4031 / PROTOCOL_CONNECTION_LOST: el servidor cerró una conexión ociosa.
    // El pool la descarta solo; no es un fallo del sistema.
    if (err?.code === "ER_CLIENT_INTERACTION_TIMEOUT" || err?.code === "PROTOCOL_CONNECTION_LOST") {
      console.info(new Date(), "MySQL: conexión ociosa cerrada por el servidor, se descarta del pool", err.code);
      return;
    }
    console.error(new Date(), "MySQL error", err?.code, err?.message);
  });

  connection.on("close", err => {
    if (err) console.error(new Date(), "MySQL close", err);
  });
});

module.exports = mysqlConnection;
