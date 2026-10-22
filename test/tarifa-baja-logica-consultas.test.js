"use strict";

// Guardia de la baja lógica de tarifas: al editar una temporada sus tarifas quedan
// con eliminado = 1 en lugar de borrarse. Toda consulta de api/ que lee la tabla
// tarifa (FROM/JOIN tarifa, no tarifa_*) tiene que filtrar "eliminado = 0"; si no,
// lo quitado vuelve a cotizar (409 TARIFA_AMBIGUA), a ofrecerse o a verse al editar.
// Si este test falla por una consulta nueva: sumale "AND <alias>.eliminado = 0", o,
// si de verdad tiene que ver lo dado de baja, agregala a EXCEPCIONES con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");

// Lista cerrada de lecturas que a propósito ven también lo dado de baja.
const EXCEPCIONES = [
  {
    archivo: "api/routes/user.js",
    patron: /JOIN tarifa t\s+ON t\.turismo_tarifa_regla_id = tr\.id/,
    veces: 2,
    motivo: "precio único y temporadas gestionadas: tarifas materializadas por reglas, sin temporada",
  },
  {
    archivo: "api/routes/user.js",
    patron: /JOIN tarifa t ON rft\.tarifa_id = t\.id/,
    veces: 4,
    motivo: "edición y resumen de una reserva hecha: la tarifa que usó, aunque hoy esté dada de baja",
  },
  {
    archivo: "api/routes/user.js",
    patron: /JOIN tarifa t ON t\.id = rft\.tarifa_id/,
    veces: 1,
    motivo: "temporadaUsadaEnReservas: reservas sobre cualquier tarifa de la temporada",
  },
  {
    archivo: "api/routes/turismo-gestion.js",
    patron: /FROM tarifa t WHERE t\.turismo_tarifa_regla_id = \?/,
    veces: 1,
    motivo: "sincronización de tarifas materializadas por reglas (sin temporada)",
  },
  {
    archivo: "api/routes/turismo-gestion.js",
    patron: /DELETE FROM tarifa WHERE id IN/,
    veces: 1,
    motivo: "borra materializaciones de reglas que ninguna reserva usó (sin temporada)",
  },
];

function archivosJs(directorio) {
  return fs.readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivosJs(ruta);
    return entrada.name.endsWith(".js") ? [ruta] : [];
  });
}

// Dónde termina la consulta que empieza en `indice` (un FROM/JOIN): en el paréntesis
// que cierra su subconsulta o donde cierra el literal que la contiene. Un string con
// comillas dobles no cruza líneas; un template string se recorre salteando ${...}.
function finDeConsulta(fuente, indice) {
  const inicioLinea = fuente.lastIndexOf("\n", indice) + 1;
  const comillasAntes = (fuente.slice(inicioLinea, indice).match(/(?<!\\)"/g) || []).length;
  const delimitador = comillasAntes % 2 === 1 ? '"' : "`";
  let expresion = 0;
  let parentesis = 0;
  for (let i = indice; i < fuente.length; i++) {
    const caracter = fuente[i];
    if (expresion > 0) {
      if (caracter === "{") expresion += 1;
      else if (caracter === "}") expresion -= 1;
      continue;
    }
    if (caracter === delimitador) return i;
    if (delimitador === "`" && caracter === "$" && fuente[i + 1] === "{") {
      expresion = 1;
      i += 1;
    } else if (caracter === "(") {
      parentesis += 1;
    } else if (caracter === ")") {
      if (parentesis === 0) return i;
      parentesis -= 1;
    }
  }
  return fuente.length;
}

// Cada lectura: `consulta` va del FROM/JOIN al fin de su consulta (ahí se busca el
// filtro), `linea` agrega el principio de la línea (para las excepciones) y `contexto`
// unas líneas de antes (sólo para reconocer de qué consulta se trata).
function lecturasDeTarifa() {
  const lecturas = [];
  for (const archivo of archivosJs(path.join(RAIZ, "api"))) {
    const relativo = path.relative(RAIZ, archivo).split(path.sep).join("/");
    const fuente = fs.readFileSync(archivo, "utf8").replace(/\r\n/g, "\n");
    for (const coincidencia of fuente.matchAll(/\b(?:FROM|JOIN)\s+tarifa\b/gi)) {
      const fin = finDeConsulta(fuente, coincidencia.index);
      const inicioLinea = fuente.lastIndexOf("\n", coincidencia.index) + 1;
      lecturas.push({
        archivo: relativo,
        numeroLinea: fuente.slice(0, coincidencia.index).split("\n").length,
        consulta: fuente.slice(coincidencia.index, fin),
        linea: fuente.slice(inicioLinea, fin),
        contexto: fuente.slice(Math.max(0, inicioLinea - 400), fin),
      });
    }
  }
  return lecturas;
}

test("toda lectura de la tabla tarifa en api/ filtra lo dado de baja", () => {
  const lecturas = lecturasDeTarifa();
  // Cotización, disponibilidad, catálogo, edición, solapamientos, gestión: son muchas.
  assert.ok(lecturas.length >= 20, `Se esperaban al menos 20 lecturas de tarifa y hay ${lecturas.length}`);

  const usos = new Map(EXCEPCIONES.map((excepcion) => [excepcion, 0]));
  const sinFiltro = [];
  for (const lectura of lecturas) {
    if (/\beliminado\s*=\s*0\b/.test(lectura.consulta)) continue;
    const excepcion = EXCEPCIONES.find((candidata) => (
      candidata.archivo === lectura.archivo && candidata.patron.test(lectura.linea)
    ));
    if (excepcion) {
      usos.set(excepcion, usos.get(excepcion) + 1);
      continue;
    }
    const resumen = lectura.linea.replace(/\s+/g, " ").trim().slice(0, 140);
    sinFiltro.push(`${lectura.archivo}:${lectura.numeroLinea} → ${resumen}`);
  }

  assert.deepEqual(sinFiltro, [], `Lecturas de tarifa sin "eliminado = 0":\n${sinFiltro.join("\n")}`);
  for (const [excepcion, cantidad] of usos) {
    assert.equal(
      cantidad,
      excepcion.veces,
      `La excepción de ${excepcion.archivo} (${excepcion.motivo}) se usó ${cantidad} vez/veces y se esperaban ${excepcion.veces}`
    );
  }
});

test("las consultas críticas de cotización y disponibilidad están cubiertas por la guardia", () => {
  const filtradas = lecturasDeTarifa().filter((lectura) => /\beliminado\s*=\s*0\b/.test(lectura.consulta));
  const archivos = new Set(filtradas.map((lectura) => lectura.archivo));
  for (const archivo of [
    "api/routes/user.js",
    "api/routes/turismo-gestion.js",
    "api/services/descuento-adicionales.js",
    "api/services/servicios-disponibilidad.js",
    "api/services/turismo-reserva-holds.js",
    "api/services/turismo-catalogo.js",
  ]) {
    assert.ok(archivos.has(archivo), `${archivo} no tiene ninguna lectura de tarifa filtrada`);
  }
  const userJs = filtradas.filter((lectura) => lectura.archivo === "api/routes/user.js").map((lectura) => lectura.contexto);
  // calcularTarifaBaseReserva: si viera filas dadas de baja frenaría reservas con TARIFA_AMBIGUA.
  assert.ok(userJs.some((sql) => /SELECT id, precio, fecha_inicio, fecha_fin, usa_porcentaje, porcentaje_descuento/.test(sql)));
  // validarSolapamientoTarifasExistentes: si no, un recurso quitado frena a otra temporada.
  assert.ok(userJs.some((sql) => /INNER JOIN temporada_tarifa tt ON tt\.id = t\.temporada_tarifa_id/.test(sql)));
});

test("user.js ya no borra tarifas ni temporadas", () => {
  const fuente = fs.readFileSync(path.join(RAIZ, "api", "routes", "user.js"), "utf8");
  assert.doesNotMatch(fuente, /DELETE\s+FROM\s+tarifa\b/);
  assert.doesNotMatch(fuente, /DELETE\s+FROM\s+tarifa_adicional\b/);
  assert.doesNotMatch(fuente, /DELETE\s+FROM\s+temporada_tarifa\b/);
});

// --- Verificador de integridad (scripts/integridad-financiera-common.js) ---------
const { runDataPreflight } = require("../scripts/integridad-financiera-common");

// Conexión falsa: todas las tablas existen; `conBaja` dice si tarifa.eliminado existe.
function conexionVerificador({ conBaja }) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params = []) {
      consultas.push(sql);
      if (/information_schema\.TABLES/.test(sql)) return [[{ cantidad: 1 }]];
      if (/information_schema\.COLUMNS/.test(sql)) {
        const existe = conBaja && params[0] === "tarifa" && params[1] === "eliminado";
        return [existe ? [{ COLUMN_NAME: "eliminado", DATA_TYPE: "tinyint" }] : []];
      }
      if (/ENGINE <> 'InnoDB'/.test(sql)) return [[]];
      return [[{}]];
    },
  };
}

function consultaRelaciones(consultas) {
  const sql = consultas.find((texto) => /AS tarifas_aplicables_solapadas/.test(texto));
  assert.ok(sql, "No se encontró la consulta de relaciones tarifarias");
  return sql.replace(/\s+/g, " ");
}

test("el verificador no cuenta como solapadas ni inconsistentes las tarifas dadas de baja", async () => {
  const conexion = conexionVerificador({ conBaja: true });
  await runDataPreflight(conexion);
  const sql = consultaRelaciones(conexion.consultas);
  assert.match(sql, /ON a\.id < b\.id AND a\.eliminado = 0 AND b\.eliminado = 0 AND a\.recurso_id <=> b\.recurso_id/);
  assert.match(sql, /OR sr\.servicio_id IS NULL\) AND t\.eliminado = 0\) AS tarifa_regimen_fuera_servicio/);
  // Los adicionales inactivos (activo = 0) tampoco: los bloques ya no los borran en cascada.
  assert.match(sql, /OR sr\.servicio_id IS NULL\) AND ta\.activo = 1\) AS adicional_regimen_fuera_servicio/);
});

test("el verificador sigue funcionando antes de la migración (sin la columna eliminado)", async () => {
  const conexion = conexionVerificador({ conBaja: false });
  await runDataPreflight(conexion);
  const sql = consultaRelaciones(conexion.consultas);
  assert.doesNotMatch(sql, /eliminado/);
  assert.match(sql, /ON a\.id < b\.id AND a\.recurso_id <=> b\.recurso_id/);
  // activo existe desde antes: el filtro de adicionales no depende de la migración.
  assert.match(sql, /OR sr\.servicio_id IS NULL\) AND ta\.activo = 1\) AS adicional_regimen_fuera_servicio/);
});
