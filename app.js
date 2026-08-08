require('dotenv').config({ path: './.env' });

if (process.env.NODE_ENV === 'production' && String(process.env.JWT_SECRET || '').length < 64) {
  throw new Error('JWT_SECRET debe tener al menos 64 caracteres en produccion');
}

const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require("path");
const mysqlConnection = require('./api/connection/connection');
const {
  obtenerOrigenesPermitidos,
  crearValidadorCors,
} = require('./api/security/http-config');

const origenesPermitidos = obtenerOrigenesPermitidos();
const corsOptions = {
  origin: crearValidadorCors(origenesPermitidos),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  exposedHeaders: ['Retry-After'],
  credentials: false,
  maxAge: 600,
};

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors(corsOptions));
app.use(bodyParser.urlencoded({
  extended: false,
  limit: process.env.REQUEST_FORM_LIMIT || '1mb',
  parameterLimit: 2000,
}));
app.use(bodyParser.json({ limit: process.env.REQUEST_JSON_LIMIT || '2mb' }));

const intentosLogin = new Map();
const VENTANA_LOGIN_MS = 15 * 60 * 1000;
const MAX_INTENTOS_LOGIN = 10;
const MAX_CLAVES_LOGIN = 10000;

function limitarMemoriaIntentosLogin(ahora) {
  for (const [key, value] of intentosLogin) {
    if (ahora - value.inicio >= VENTANA_LOGIN_MS) {
      intentosLogin.delete(key);
    }
  }
  while (intentosLogin.size >= MAX_CLAVES_LOGIN) {
    const claveMasAntigua = intentosLogin.keys().next().value;
    if (claveMasAntigua === undefined) break;
    intentosLogin.delete(claveMasAntigua);
  }
}

app.use('/api/signin', (req, res, next) => {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const documento = String(req.body?.documento || '').trim().slice(0, 20);
  const clave = `${req.ip}:${documento}`;
  const ahora = Date.now();
  let estado = intentosLogin.get(clave);

  if (!estado || ahora - estado.inicio >= VENTANA_LOGIN_MS) {
    if (!estado) limitarMemoriaIntentosLogin(ahora);
    estado = { inicio: ahora, fallos: 0 };
    intentosLogin.set(clave, estado);
  }

  if (estado.fallos >= MAX_INTENTOS_LOGIN) {
    const segundos = Math.max(1, Math.ceil((VENTANA_LOGIN_MS - (ahora - estado.inicio)) / 1000));
    res.setHeader('Retry-After', String(segundos));
    res.status(429).json('Demasiados intentos. Intente nuevamente mas tarde.');
    return;
  }

  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      intentosLogin.delete(clave);
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      estado.fallos += 1;
    }

    if (intentosLogin.size >= MAX_CLAVES_LOGIN) {
      limitarMemoriaIntentosLogin(Date.now());
    }
  });

  next();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.get('/api/healthz', async (_req, res) => {
  try {
    await mysqlConnection.promise().query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Health check de base de datos fallido:', error?.code || error?.message);
    res.status(503).json({ status: 'unavailable' });
  }
});

// ROUTES

const userRoute = require('./api/routes/user');
const coseguroRoute = require('./api/routes/coseguro');
const olimpiadasRoute = require('./api/routes/olimpiadas');
const trasladosRoute = require('./api/routes/traslados');
app.use('/api',userRoute);
app.use('/api',coseguroRoute);
app.use('/api',olimpiadasRoute);
app.use('/api',trasladosRoute);
app.use('/imagenes', express.static(path.join(__dirname, 'imagenes'), {
  dotfiles: 'deny',
  fallthrough: false,
  index: false,
  maxAge: '1h',
}));

app.use((error, req, res, next) => {
  if (error?.code === 'ORIGEN_CORS_NO_PERMITIDO') {
    res.status(403).json('Origen no permitido');
    return;
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).json('El contenido enviado supera el limite permitido');
    return;
  }
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json('El contenido JSON es invalido');
    return;
  }
  next(error);
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error('Error HTTP no controlado:', error?.code || error?.message);
  res.status(500).json('Error interno');
});

module.exports = app;
