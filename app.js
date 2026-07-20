const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require("path");

app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

// const whitelist = ['http://localhost:4200', 'http://smart-lab-frontend.s3-website-sa-east-1.amazonaws.com'];
// app.use(cors({origin: whitelist}));
app.use(cors()); // CORS HABILITADOS PARA TODOS
// app.use(express.static('./api/public/uploads'));
// app.use(express.static('./api/public/imagenes'));

require('dotenv').config({path: './.env'}); // variables de entorno

// ROUTES

const userRoute = require('./api/routes/user');
const coseguroRoute = require('./api/routes/coseguro');
const olimpiadasRoute = require('./api/routes/olimpiadas');
const trasladosRoute = require('./api/routes/traslados');
app.use('/api',userRoute);
app.use('/api',coseguroRoute);
app.use('/api',olimpiadasRoute);
app.use('/api',trasladosRoute);
app.use('/imagenes', express.static(path.join(__dirname, 'imagenes')));

module.exports = app;