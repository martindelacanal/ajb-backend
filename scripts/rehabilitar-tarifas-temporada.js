"use strict";

// Rehabilitar tarifas de temporada dadas de baja (herramienta del desarrollador).
//
// Desde 2026-10-21, al guardar una temporada (o al reemplazar la de un bloque de
// temporada alta) no se borra nada: las tarifas quedan con eliminado = 1 y los
// adicionales con activo = 0, con fecha, usuario, motivo y un lote (UUID) por guardado.
//   QUITADO      el servicio, régimen o recurso ya no estaba en lo que se guardó.
//   REEMPLAZADO  el recurso seguía y sus precios se reemplazaron por los nuevos (o, en
//                un bloque, la temporada entera se reemplazó por otra).
// Requiere la migración scripts/migrar-temporadas-baja-logica.js.
//
// 1. Ver los guardados (lotes) de una temporada, quién y qué se dio de baja en cada uno:
//      node scripts/rehabilitar-tarifas-temporada.js --temporada=28
//      (o npm run tarifas:rehabilitar -- --temporada=28; lo mismo con las demás opciones)
// 2. Simular (sólo lee): qué se rehabilitaría y con qué choca.
//      node scripts/rehabilitar-tarifas-temporada.js --lote=<UUID>
//      node scripts/rehabilitar-tarifas-temporada.js --lote=<UUID> --recurso=12 --regimen=3
//    Por defecto toma sólo lo QUITADO; --motivo=REEMPLAZADO o --motivo=TODOS para el resto.
// 3. Aplicar: lo mismo con --aplicar y --usuario=<id del administrador que rehabilita>
//    (queda en historial_temporada). Corre en una transacción, bloquea la temporada y
//    vuelve a revisar los choques adentro.
//      node scripts/rehabilitar-tarifas-temporada.js --lote=<UUID> --aplicar --usuario=1
//
// Si hay algún choque no rehabilita nada:
//   - una tarifa vigente del mismo recurso y régimen en la misma temporada con fechas que
//     se pisan (el editor no admite rangos solapados para el mismo régimen);
//   - una tarifa vigente del mismo recurso en otra temporada (baja, o alta con bloque
//     activo) con fechas que se pisan: el editor respondería 409 TARIFA_RECURSO_SOLAPADA;
//   - un rango fuera de las fechas que tiene hoy la temporada;
//   - el recurso ya no existe o su servicio ya no ofrece ese régimen;
//   - un adicional vigente del mismo recurso, régimen y adicional con fechas que se pisan
//     (misma temporada, o las dos de temporada baja): la cotización daría TARIFA_AMBIGUA;
//   - la temporada es de un bloque de temporada alta que ya usa otra temporada.
// Para volver a precios anteriores (lote REEMPLAZADO) primero hay que sacar los vigentes
// de ese recurso: quitá el recurso de la temporada en el editor, guardá y después
// rehabilitá el lote viejo con --recurso, --regimen y --motivo=REEMPLAZADO.
//
// Producción: los pasos 1 y 2 sólo leen; --aplicar contra una base que no es local exige
// --allow-production. El bloque activo del .env apunta a la RDS; para develop pasá
// DB_HOST=localhost DB_USER=root DB_PASSWORD=<pass> DB_DATABASE=db_miajb (dotenv no pisa
// variables ya definidas). TLS: si DB_SSL_MODE es verify-ca o verify-full se conecta con
// DB_SSL_CA_PATH.

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MOTIVOS = Object.freeze(["QUITADO", "REEMPLAZADO", "TODOS"]);
const PATRON_LOTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// historial_temporada.valor_nuevo es TEXT (64 KB): se guarda un resumen por par.
const MAXIMO_PARES_HISTORIAL = 500;

function idPositivo(valor, nombre) {
  const texto = String(valor ?? "").trim();
  const numero = Number(texto);
  if (!/^\d+$/.test(texto) || !Number.isSafeInteger(numero) || numero <= 0) {
    throw new Error(`${nombre} tiene que ser un número entero positivo`);
  }
  return numero;
}

function parsearArgumentos(argv = process.argv.slice(2)) {
  const valores = {};
  const banderas = new Set();
  for (const argumento of argv) {
    const coincidencia = /^--([a-z-]+)(?:=(.*))?$/.exec(argumento);
    if (!coincidencia) throw new Error(`Argumento desconocido: ${argumento}`);
    const [, nombre, valor] = coincidencia;
    if (["temporada", "lote", "recurso", "regimen", "motivo", "usuario"].includes(nombre) && valor !== undefined) {
      valores[nombre] = valor;
    } else if (["aplicar", "allow-production"].includes(nombre) && valor === undefined) {
      banderas.add(nombre);
    } else {
      throw new Error(`Argumento desconocido: ${argumento}`);
    }
  }

  const opciones = {
    temporadaId: null,
    lote: null,
    recursoId: null,
    regimenId: null,
    motivo: "QUITADO",
    aplicar: banderas.has("aplicar"),
    usuarioId: null,
    allowProduction: banderas.has("allow-production"),
  };
  if ((valores.temporada === undefined) === (valores.lote === undefined)) {
    throw new Error("Indicá --temporada=ID (para ver lo dado de baja) o --lote=UUID (para rehabilitar)");
  }
  if (valores.temporada !== undefined) {
    opciones.temporadaId = idPositivo(valores.temporada, "--temporada");
    const deLote = ["recurso", "regimen", "motivo", "usuario"].filter((nombre) => valores[nombre] !== undefined);
    if (deLote.length > 0 || opciones.aplicar) {
      throw new Error("--recurso, --regimen, --motivo, --usuario y --aplicar van con --lote");
    }
    return opciones;
  }

  opciones.lote = String(valores.lote).trim().toLowerCase();
  if (!PATRON_LOTE.test(opciones.lote)) throw new Error("--lote tiene que ser el UUID que muestra --temporada");
  if ((valores.recurso === undefined) !== (valores.regimen === undefined)) {
    throw new Error("--recurso y --regimen van juntos");
  }
  if (valores.recurso !== undefined) {
    opciones.recursoId = idPositivo(valores.recurso, "--recurso");
    opciones.regimenId = idPositivo(valores.regimen, "--regimen");
  }
  if (valores.motivo !== undefined) {
    opciones.motivo = String(valores.motivo).trim().toUpperCase();
    if (!MOTIVOS.includes(opciones.motivo)) throw new Error(`--motivo tiene que ser ${MOTIVOS.join(", ")}`);
  }
  if (valores.usuario !== undefined) opciones.usuarioId = idPositivo(valores.usuario, "--usuario");
  if (opciones.aplicar && !opciones.usuarioId) {
    throw new Error("Con --aplicar indicá --usuario=<id del administrador que rehabilita> (queda en el historial)");
  }
  if (!opciones.aplicar && opciones.usuarioId) throw new Error("--usuario va con --aplicar");
  return opciones;
}

function esHostLocal(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host || "").trim().toLowerCase());
}

function validarDestino(opciones, env = process.env) {
  for (const variable of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!env[variable]) throw new Error(`Falta la variable de entorno ${variable}`);
  }
  const remoto = !esHostLocal(env.DB_HOST);
  const produccion = String(env.NODE_ENV || "").trim().toLowerCase() === "production";
  if ((remoto || produccion) && opciones.aplicar && !opciones.allowProduction) {
    throw new Error(
      `DB_HOST=${env.DB_HOST} no es local. Para rehabilitar en producción agregá --allow-production.`
    );
  }
  return { remoto, produccion };
}

function configuracionTls(env = process.env) {
  const modo = String(env.DB_SSL_MODE || "disabled").trim().toLowerCase();
  if (modo === "disabled") return undefined;
  if (!["verify-ca", "verify-full"].includes(modo)) {
    throw new Error("DB_SSL_MODE debe ser disabled, verify-ca o verify-full");
  }
  const caPath = String(env.DB_SSL_CA_PATH || "").trim();
  if (!caPath || !fs.existsSync(caPath)) {
    throw new Error("DB_SSL_CA_PATH debe apuntar a un certificado existente cuando TLS está habilitado");
  }
  return { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
}

async function leerTemporada(connection, temporadaId, { bloquear = false } = {}) {
  const [rows] = await connection.query(
    `SELECT id, nombre, COALESCE(origen, 'GENERAL') AS origen,
            DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS fecha_fin
       FROM temporada_tarifa
      WHERE id = ?${bloquear ? " FOR UPDATE" : ""}`,
    [temporadaId]
  );
  return rows[0] || null;
}

// --- 1. Listado de lo dado de baja en una temporada ---------------------------
async function listarTemporada(connection, temporadaId) {
  const temporada = await leerTemporada(connection, temporadaId);
  if (!temporada) throw new Error(`No existe la temporada ${temporadaId}`);

  const [[vigentes]] = await connection.query(
    `SELECT (SELECT COUNT(*) FROM tarifa WHERE temporada_tarifa_id = ? AND eliminado = 0) AS tarifas,
            (SELECT COUNT(*) FROM tarifa_adicional WHERE temporada_tarifa_id = ? AND activo = 1) AS adicionales`,
    [temporadaId, temporadaId]
  );
  const [pares] = await connection.query(
    `SELECT t.eliminado_lote AS lote, t.eliminado_motivo AS motivo,
            DATE_FORMAT(MIN(t.fecha_eliminacion), '%Y-%m-%d %H:%i') AS fecha,
            MIN(t.eliminado_usuario_id) AS usuario_id,
            r.servicio_id, s.nombre AS servicio, t.regimen_id, reg.nombre AS regimen,
            t.recurso_id, r.nombre AS recurso, COUNT(*) AS filas,
            DATE_FORMAT(MIN(t.fecha_inicio), '%Y-%m-%d') AS desde,
            DATE_FORMAT(MAX(t.fecha_fin), '%Y-%m-%d') AS hasta
       FROM tarifa t
       LEFT JOIN recurso r ON r.id = t.recurso_id
       LEFT JOIN servicio s ON s.id = r.servicio_id
       LEFT JOIN regimen reg ON reg.id = t.regimen_id
      WHERE t.temporada_tarifa_id = ? AND t.eliminado = 1
      GROUP BY t.eliminado_lote, t.eliminado_motivo, r.servicio_id, s.nombre,
               t.regimen_id, reg.nombre, t.recurso_id, r.nombre
      ORDER BY fecha DESC, lote, servicio, regimen, recurso`,
    [temporadaId]
  );
  const [adicionales] = await connection.query(
    `SELECT eliminado_lote AS lote, eliminado_motivo AS motivo, COUNT(*) AS filas
       FROM tarifa_adicional
      WHERE temporada_tarifa_id = ? AND activo = 0
      GROUP BY eliminado_lote, eliminado_motivo`,
    [temporadaId]
  );

  const lotes = new Map();
  const loteDe = (clave) => {
    if (!lotes.has(clave)) {
      lotes.set(clave, { lote: clave, fecha: null, usuario_id: null, tarifas: 0, adicionales: 0, motivos: {}, pares: [] });
    }
    return lotes.get(clave);
  };
  for (const par of pares) {
    const lote = loteDe(par.lote || null);
    lote.fecha = lote.fecha || par.fecha || null;
    lote.usuario_id = lote.usuario_id || (par.usuario_id === null ? null : Number(par.usuario_id));
    lote.tarifas += Number(par.filas || 0);
    lote.motivos[par.motivo || "SIN MOTIVO"] = (lote.motivos[par.motivo || "SIN MOTIVO"] || 0) + Number(par.filas || 0);
    lote.pares.push({
      motivo: par.motivo || null,
      servicio: par.servicio || `servicio ${par.servicio_id}`,
      regimen_id: par.regimen_id === null ? null : Number(par.regimen_id),
      regimen: par.regimen || `régimen ${par.regimen_id}`,
      recurso_id: Number(par.recurso_id),
      recurso: par.recurso || `recurso ${par.recurso_id}`,
      filas: Number(par.filas || 0),
      desde: par.desde,
      hasta: par.hasta,
    });
  }
  let adicionalesLegado = 0;
  for (const fila of adicionales) {
    if (!fila.lote) {
      adicionalesLegado += Number(fila.filas || 0);
      continue;
    }
    loteDe(fila.lote).adicionales += Number(fila.filas || 0);
  }

  // Quién guardó cada lote, para la auditoría.
  const usuarioIds = Array.from(new Set(Array.from(lotes.values(), (lote) => lote.usuario_id).filter(Boolean)));
  if (usuarioIds.length > 0) {
    const [usuarios] = await connection.query("SELECT id, nombre, apellido FROM usuario WHERE id IN (?)", [usuarioIds]);
    const nombres = new Map(usuarios.map((fila) => [Number(fila.id), [fila.apellido, fila.nombre].filter(Boolean).join(", ")]));
    for (const lote of lotes.values()) lote.usuario = nombres.get(lote.usuario_id) || null;
  }

  return {
    temporada,
    vigentes: { tarifas: Number(vigentes?.tarifas || 0), adicionales: Number(vigentes?.adicionales || 0) },
    lotes: Array.from(lotes.values()),
    adicionalesLegado,
  };
}

function imprimirListado(listado, log = console.log) {
  const { temporada } = listado;
  log(`Temporada ${temporada.id} «${temporada.nombre}» (${temporada.origen}, ${temporada.fecha_inicio} a ${temporada.fecha_fin})`);
  log(`  Vigentes: ${listado.vigentes.tarifas} tarifa(s), ${listado.vigentes.adicionales} adicional(es)`);
  if (listado.lotes.length === 0) log("  No tiene tarifas dadas de baja.");
  for (const lote of listado.lotes) {
    const motivos = Object.entries(lote.motivos).map(([motivo, filas]) => `${motivo} ${filas}`).join(", ");
    log("");
    log(`  Lote ${lote.lote || "(sin lote)"} · ${lote.fecha || "sin fecha"} · usuario ${lote.usuario_id ?? "-"}${lote.usuario ? ` (${lote.usuario})` : ""}`);
    log(`    ${lote.tarifas} tarifa(s) (${motivos || "-"}), ${lote.adicionales} adicional(es)`);
    for (const par of lote.pares) {
      log(`    - ${par.motivo || "SIN MOTIVO"}: ${par.servicio} › ${par.regimen} (régimen ${par.regimen_id}) › ${par.recurso} (recurso ${par.recurso_id}) · ${par.filas} fila(s) del ${par.desde} al ${par.hasta}`);
    }
  }
  if (listado.adicionalesLegado > 0) {
    log("");
    log(`  ${listado.adicionalesLegado} adicional(es) inactivo(s) de antes de la baja lógica (sin lote): no se rehabilitan con este script.`);
  }
}

// --- 2 y 3. Plan de rehabilitación de un lote ----------------------------------
function filtrosLote(opciones, alias) {
  const condiciones = [];
  const params = [];
  if (opciones.recursoId) {
    condiciones.push(`${alias}.recurso_id = ?`, `${alias}.regimen_id = ?`);
    params.push(opciones.recursoId, opciones.regimenId);
  }
  if (opciones.motivo !== "TODOS") {
    condiciones.push(`${alias}.eliminado_motivo = ?`);
    params.push(opciones.motivo);
  }
  return { sql: condiciones.map((condicion) => ` AND ${condicion}`).join(""), params };
}

async function buscarChoques(connection, temporada, tarifaIds, adicionalIds) {
  const choques = [];
  if (temporada.origen === "BLOQUE") {
    const [bloques] = await connection.query(
      "SELECT id FROM bloque_fecha WHERE temporada_tarifa_id = ? LIMIT 1",
      [temporada.id]
    );
    if (bloques.length === 0) {
      choques.push(
        `La temporada ${temporada.id} es de temporada alta y ningún bloque la usa (el bloque pasó a otra temporada): rehabilitarla dejaría precios sueltos.`
      );
    }
  }

  if (tarifaIds.length > 0) {
    const [mismaTemporada] = await connection.query(
      `SELECT a.id AS tarifa_id, b.id AS vigente_id, a.recurso_id, a.regimen_id,
              DATE_FORMAT(b.fecha_inicio, '%Y-%m-%d') AS desde, DATE_FORMAT(b.fecha_fin, '%Y-%m-%d') AS hasta
         FROM tarifa a
         INNER JOIN tarifa b
           ON b.temporada_tarifa_id = a.temporada_tarifa_id
          AND b.recurso_id = a.recurso_id
          AND b.regimen_id <=> a.regimen_id
          AND b.eliminado = 0
          AND a.fecha_inicio <= b.fecha_fin AND b.fecha_inicio <= a.fecha_fin
        WHERE a.id IN (?)
        ORDER BY a.recurso_id, a.regimen_id, b.fecha_inicio`,
      [tarifaIds]
    );
    for (const fila of mismaTemporada) {
      choques.push(
        `Tarifa ${fila.tarifa_id}: el recurso ${fila.recurso_id} (régimen ${fila.regimen_id}) ya tiene la tarifa vigente ${fila.vigente_id} del ${fila.desde} al ${fila.hasta} en esta temporada.`
      );
    }

    const [otrasTemporadas] = await connection.query(
      `SELECT a.id AS tarifa_id, b.id AS vigente_id, a.recurso_id,
              tb.id AS temporada_id, tb.nombre AS temporada, COALESCE(tb.origen, 'GENERAL') AS origen,
              DATE_FORMAT(b.fecha_inicio, '%Y-%m-%d') AS desde, DATE_FORMAT(b.fecha_fin, '%Y-%m-%d') AS hasta
         FROM tarifa a
         INNER JOIN tarifa b
           ON b.recurso_id = a.recurso_id
          AND b.temporada_tarifa_id <> a.temporada_tarifa_id
          AND b.eliminado = 0
          AND a.fecha_inicio <= b.fecha_fin AND b.fecha_inicio <= a.fecha_fin
         INNER JOIN temporada_tarifa tb ON tb.id = b.temporada_tarifa_id
        WHERE a.id IN (?)
          AND (
            COALESCE(tb.origen, 'GENERAL') <> 'BLOQUE'
            OR EXISTS (
              SELECT 1 FROM bloque_fecha bf WHERE bf.temporada_tarifa_id = tb.id AND bf.estado = 'ACTIVO'
            )
          )
        ORDER BY a.recurso_id, tb.id, b.fecha_inicio`,
      [tarifaIds]
    );
    for (const fila of otrasTemporadas) {
      choques.push(
        `Tarifa ${fila.tarifa_id}: el recurso ${fila.recurso_id} ya tiene precios del ${fila.desde} al ${fila.hasta} en la temporada ${fila.temporada_id} «${fila.temporada}» (${fila.origen}, tarifa ${fila.vigente_id}).`
      );
    }

    const [fueraDeRango] = await connection.query(
      `SELECT t.id, DATE_FORMAT(t.fecha_inicio, '%Y-%m-%d') AS desde, DATE_FORMAT(t.fecha_fin, '%Y-%m-%d') AS hasta
         FROM tarifa t
         INNER JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
        WHERE t.id IN (?)
          AND (t.fecha_inicio < tt.fecha_inicio OR t.fecha_fin > tt.fecha_fin)
        ORDER BY t.id`,
      [tarifaIds]
    );
    for (const fila of fueraDeRango) {
      choques.push(
        `Tarifa ${fila.id}: su rango (${fila.desde} a ${fila.hasta}) queda fuera de las fechas actuales de la temporada (${temporada.fecha_inicio} a ${temporada.fecha_fin}).`
      );
    }

    const [sinRegimen] = await connection.query(
      `SELECT DISTINCT t.recurso_id, t.regimen_id, r.servicio_id
         FROM tarifa t
         LEFT JOIN recurso r ON r.id = t.recurso_id
         LEFT JOIN servicio_regimen sr ON sr.servicio_id = r.servicio_id AND sr.regimen_id = t.regimen_id
        WHERE t.id IN (?)
          AND (r.id IS NULL OR sr.servicio_id IS NULL)`,
      [tarifaIds]
    );
    for (const fila of sinRegimen) {
      choques.push(
        fila.servicio_id === null || fila.servicio_id === undefined
          ? `El recurso ${fila.recurso_id} ya no existe.`
          : `El servicio ${fila.servicio_id} ya no ofrece el régimen ${fila.regimen_id} (recurso ${fila.recurso_id}).`
      );
    }
  }

  if (adicionalIds.length > 0) {
    const [adicionales] = await connection.query(
      `SELECT a.id AS tarifa_adicional_id, b.id AS vigente_id, a.recurso_id, a.regimen_id, a.adicional_id,
              b.temporada_tarifa_id AS temporada_id,
              DATE_FORMAT(b.fecha_inicio, '%Y-%m-%d') AS desde, DATE_FORMAT(b.fecha_fin, '%Y-%m-%d') AS hasta
         FROM tarifa_adicional a
         INNER JOIN tarifa_adicional b
           ON b.id <> a.id
          AND b.recurso_id = a.recurso_id
          AND b.regimen_id = a.regimen_id
          AND b.adicional_id = a.adicional_id
          AND b.activo = 1
          AND a.fecha_inicio <= b.fecha_fin AND b.fecha_inicio <= a.fecha_fin
         LEFT JOIN temporada_tarifa tta ON tta.id = a.temporada_tarifa_id
         LEFT JOIN temporada_tarifa ttb ON ttb.id = b.temporada_tarifa_id
        WHERE a.id IN (?)
          AND (
            b.temporada_tarifa_id = a.temporada_tarifa_id
            OR (COALESCE(tta.origen, 'GENERAL') = 'GENERAL' AND COALESCE(ttb.origen, 'GENERAL') = 'GENERAL')
          )
        ORDER BY a.recurso_id, a.adicional_id, b.fecha_inicio`,
      [adicionalIds]
    );
    for (const fila of adicionales) {
      choques.push(
        `Adicional ${fila.adicional_id} del recurso ${fila.recurso_id} (régimen ${fila.regimen_id}): ya hay uno vigente del ${fila.desde} al ${fila.hasta} en la temporada ${fila.temporada_id} (fila ${fila.vigente_id}).`
      );
    }

    const [adicionalesFuera] = await connection.query(
      `SELECT ta.id, ta.adicional_id, DATE_FORMAT(ta.fecha_inicio, '%Y-%m-%d') AS desde,
              DATE_FORMAT(ta.fecha_fin, '%Y-%m-%d') AS hasta
         FROM tarifa_adicional ta
         INNER JOIN temporada_tarifa tt ON tt.id = ta.temporada_tarifa_id
        WHERE ta.id IN (?)
          AND (ta.fecha_inicio < tt.fecha_inicio OR ta.fecha_fin > tt.fecha_fin)
        ORDER BY ta.id`,
      [adicionalIds]
    );
    for (const fila of adicionalesFuera) {
      choques.push(
        `Adicional ${fila.adicional_id} (fila ${fila.id}): su rango (${fila.desde} a ${fila.hasta}) queda fuera de las fechas actuales de la temporada.`
      );
    }
  }
  return choques;
}

// Un lote es un guardado: pertenece a una sola temporada.
async function temporadaDelLote(connection, lote) {
  const [temporadas] = await connection.query(
    `SELECT temporada_tarifa_id FROM tarifa WHERE eliminado_lote = ?
     UNION
     SELECT temporada_tarifa_id FROM tarifa_adicional WHERE eliminado_lote = ?`,
    [lote, lote]
  );
  if (temporadas.length === 0) throw new Error(`No hay nada dado de baja con el lote ${lote}`);
  if (temporadas.length > 1) {
    throw new Error(`El lote ${lote} aparece en varias temporadas (${temporadas.map((fila) => fila.temporada_tarifa_id).join(", ")}): revisalo a mano`);
  }
  return Number(temporadas[0].temporada_tarifa_id);
}

/**
 * Qué se rehabilitaría de un lote y con qué choca. Con bloquear (dentro de una
 * transacción) toma la temporada y las filas FOR UPDATE: la temporada primero, igual
 * que PUT /temporada/:id, así el editor espera a que termine.
 */
async function prepararRehabilitacion(connection, opciones, { bloquear = false, temporadaId = null } = {}) {
  const id = temporadaId || await temporadaDelLote(connection, opciones.lote);
  const temporada = await leerTemporada(connection, id, { bloquear });
  if (!temporada) throw new Error(`No existe la temporada ${id}`);

  const bloqueo = bloquear ? " FOR UPDATE" : "";
  const filtroTarifa = filtrosLote(opciones, "t");
  const [tarifas] = await connection.query(
    `SELECT t.id, t.recurso_id, t.regimen_id, t.eliminado_motivo AS motivo,
            DATE_FORMAT(t.fecha_inicio, '%Y-%m-%d') AS desde, DATE_FORMAT(t.fecha_fin, '%Y-%m-%d') AS hasta
       FROM tarifa t
      WHERE t.eliminado_lote = ? AND t.eliminado = 1${filtroTarifa.sql}
      ORDER BY t.recurso_id, t.regimen_id, t.fecha_inicio, t.id${bloqueo}`,
    [opciones.lote, ...filtroTarifa.params]
  );
  const filtroAdicional = filtrosLote(opciones, "ta");
  const [adicionales] = await connection.query(
    `SELECT ta.id, ta.recurso_id, ta.regimen_id, ta.adicional_id, ta.eliminado_motivo AS motivo
       FROM tarifa_adicional ta
      WHERE ta.eliminado_lote = ? AND ta.activo = 0${filtroAdicional.sql}
      ORDER BY ta.recurso_id, ta.regimen_id, ta.adicional_id, ta.id${bloqueo}`,
    [opciones.lote, ...filtroAdicional.params]
  );

  const pares = new Map();
  for (const tarifa of tarifas) {
    const clave = `${tarifa.recurso_id}:${tarifa.regimen_id}`;
    if (!pares.has(clave)) {
      pares.set(clave, {
        recurso_id: Number(tarifa.recurso_id),
        regimen_id: tarifa.regimen_id === null ? null : Number(tarifa.regimen_id),
        motivo: tarifa.motivo || null,
        tarifas: 0,
        adicionales: 0,
        desde: tarifa.desde,
        hasta: tarifa.hasta,
      });
    }
    const par = pares.get(clave);
    par.tarifas += 1;
    if (tarifa.desde < par.desde) par.desde = tarifa.desde;
    if (tarifa.hasta > par.hasta) par.hasta = tarifa.hasta;
  }
  for (const adicional of adicionales) {
    const par = pares.get(`${adicional.recurso_id}:${adicional.regimen_id}`);
    if (par) par.adicionales += 1;
  }

  const choques = await buscarChoques(
    connection,
    temporada,
    tarifas.map((tarifa) => Number(tarifa.id)),
    adicionales.map((adicional) => Number(adicional.id))
  );
  return { temporada, tarifas, adicionales, pares: Array.from(pares.values()), choques };
}

function imprimirPlan(plan, opciones, log = console.log) {
  const { temporada } = plan;
  const filtro = [
    opciones.recursoId ? `recurso ${opciones.recursoId}, régimen ${opciones.regimenId}` : "todos los recursos",
    opciones.motivo === "TODOS" ? "QUITADO y REEMPLAZADO" : `sólo ${opciones.motivo}`,
  ].join(" · ");
  log(`Lote ${opciones.lote} · temporada ${temporada.id} «${temporada.nombre}» (${temporada.origen}, ${temporada.fecha_inicio} a ${temporada.fecha_fin})`);
  log(`  Filtro: ${filtro}`);
  log(`  Se rehabilitarían ${plan.tarifas.length} tarifa(s) y ${plan.adicionales.length} adicional(es):`);
  for (const par of plan.pares) {
    log(`    - ${par.motivo || "SIN MOTIVO"}: recurso ${par.recurso_id}, régimen ${par.regimen_id} · ${par.tarifas} tarifa(s), ${par.adicionales} adicional(es), del ${par.desde} al ${par.hasta}`);
  }
  if (plan.choques.length > 0) {
    log(`  No se puede rehabilitar: ${plan.choques.length} choque(s).`);
    for (const choque of plan.choques) log(`    ✖ ${choque}`);
  } else if (plan.tarifas.length + plan.adicionales.length > 0) {
    log("  Sin choques.");
  }
}

async function aplicarRehabilitacion(connection, opciones, { log = console.log } = {}) {
  // Fuera de la transacción: así lo primero adentro es el bloqueo de la temporada y la
  // foto de lectura de los choques se toma con el editor ya frenado.
  const temporadaId = await temporadaDelLote(connection, opciones.lote);
  await connection.beginTransaction();
  try {
    const plan = await prepararRehabilitacion(connection, opciones, { bloquear: true, temporadaId });
    const [usuarios] = await connection.query("SELECT id FROM usuario WHERE id = ?", [opciones.usuarioId]);
    if (usuarios.length === 0) throw new Error(`No existe el usuario ${opciones.usuarioId} (--usuario)`);
    imprimirPlan(plan, opciones, log);
    if (plan.tarifas.length + plan.adicionales.length === 0) {
      throw new Error(
        opciones.motivo === "QUITADO"
          ? "El lote no tiene nada QUITADO con ese filtro (para lo reemplazado usá --motivo=REEMPLAZADO o --motivo=TODOS)"
          : "El lote no tiene nada dado de baja con ese filtro"
      );
    }
    if (plan.choques.length > 0) throw new Error("No se rehabilitó nada: resolvé los choques primero");

    const tarifaIds = plan.tarifas.map((tarifa) => Number(tarifa.id));
    const adicionalIds = plan.adicionales.map((adicional) => Number(adicional.id));
    if (tarifaIds.length > 0) {
      const [resultado] = await connection.query(
        `UPDATE tarifa
            SET eliminado = 0, fecha_eliminacion = NULL, eliminado_usuario_id = NULL,
                eliminado_motivo = NULL, eliminado_lote = NULL
          WHERE id IN (?) AND eliminado = 1`,
        [tarifaIds]
      );
      if (Number(resultado?.affectedRows) !== tarifaIds.length) {
        throw new Error("Las tarifas cambiaron mientras se rehabilitaban: no se tocó nada, volvé a correrlo");
      }
    }
    if (adicionalIds.length > 0) {
      const [resultado] = await connection.query(
        `UPDATE tarifa_adicional
            SET activo = 1, fecha_eliminacion = NULL, eliminado_usuario_id = NULL,
                eliminado_motivo = NULL, eliminado_lote = NULL
          WHERE id IN (?) AND activo = 0`,
        [adicionalIds]
      );
      if (Number(resultado?.affectedRows) !== adicionalIds.length) {
        throw new Error("Los adicionales cambiaron mientras se rehabilitaban: no se tocó nada, volvé a correrlo");
      }
    }

    const pares = plan.pares.slice(0, MAXIMO_PARES_HISTORIAL);
    await connection.query(
      `INSERT INTO historial_temporada
         (temporada_id, usuario_id, operacion, campo_afectado, valor_anterior, valor_nuevo, fecha_cambio)
       VALUES (?, ?, 'UPDATE', 'tarifas', ?, ?, NOW())`,
      [
        plan.temporada.id,
        opciones.usuarioId,
        JSON.stringify({
          baja_logica: true,
          lote: opciones.lote,
          motivo: opciones.motivo,
          recurso_id: opciones.recursoId,
          regimen_id: opciones.regimenId,
        }),
        JSON.stringify({
          accion: "rehabilitar",
          herramienta: "scripts/rehabilitar-tarifas-temporada.js",
          tarifas: tarifaIds.length,
          adicionales: adicionalIds.length,
          pares,
          ...(plan.pares.length > pares.length ? { pares_omitidos: plan.pares.length - pares.length } : {}),
        }),
      ]
    );
    await connection.commit();
    log(`  ✔ Rehabilitadas ${tarifaIds.length} tarifa(s) y ${adicionalIds.length} adicional(es).`);
    return { ...plan, rehabilitadas: { tarifas: tarifaIds.length, adicionales: adicionalIds.length } };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Se conserva el error original.
    }
    throw error;
  }
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  conectar = null,
  log = console.log,
} = {}) {
  const opciones = parsearArgumentos(argv);
  validarDestino(opciones, env);
  log(`Conectando a ${env.DB_HOST}/${env.DB_DATABASE} como ${env.DB_USER}...`);
  const configuracion = {
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    port: Number(env.DB_PORT || 3306),
    timezone: "-03:00",
  };
  const connection = conectar
    ? await conectar(configuracion)
    : await require("mysql2/promise").createConnection({ ...configuracion, ssl: configuracionTls(env) });
  try {
    if (opciones.temporadaId) {
      const listado = await listarTemporada(connection, opciones.temporadaId);
      imprimirListado(listado, log);
      return listado;
    }
    if (opciones.aplicar) return await aplicarRehabilitacion(connection, opciones, { log });
    const plan = await prepararRehabilitacion(connection, opciones);
    imprimirPlan(plan, opciones, log);
    if (plan.tarifas.length + plan.adicionales.length === 0) {
      log(opciones.motivo === "QUITADO"
        ? "  El lote no tiene nada QUITADO con ese filtro (para lo reemplazado usá --motivo=REEMPLAZADO o --motivo=TODOS)."
        : "  El lote no tiene nada dado de baja con ese filtro.");
    } else if (plan.choques.length === 0) {
      log("  Simulación: no se escribió nada. Para rehabilitar agregá --aplicar --usuario=<id>.");
    }
    return plan;
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error al rehabilitar tarifas:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  aplicarRehabilitacion,
  buscarChoques,
  listarTemporada,
  main,
  parsearArgumentos,
  prepararRehabilitacion,
  validarDestino,
};
