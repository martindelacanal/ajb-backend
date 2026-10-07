#!/usr/bin/env node
"use strict";

// Datos de prueba autorizados: unifica las tarifas de ambas temporadas sin
// reemplazar reservas, sus precios, ni sus snapshots. Check es siempre lectura.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { parsearBloquesEnv, crearOpcionesConexion, validarConfiguracion } = require("./migrar-catalogo-turismo-v1");

const MIGRATION_ID = "20261007_temporadas_edades_0_1_2_17_18";
const CONFIRMACION = "APLICAR_EDADES_TEMPORADAS";
const CAMPOS_TARIFA = [
  "recurso_id", "tipo_persona_id", "regimen_id", "temporada_tarifa_id",
  "edad_minima", "edad_maxima", "precio", "fecha_inicio", "fecha_fin",
  "precio_por_persona", "usa_porcentaje", "porcentaje_descuento", "parcelas_disponibles",
  "audiencia_departamental", "turismo_tarifa_regla_id",
];
const CAMPOS_GRUPO = [
  "temporada_tarifa_id", "recurso_id", "regimen_id", "tipo_persona_id",
  "fecha_inicio", "fecha_fin", "audiencia_departamental", "turismo_tarifa_regla_id",
];

function centavos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) throw new Error("Importe invalido en los datos existentes");
  return Math.round(numero * 100);
}

function categoria(edad) {
  if (edad === null || edad === undefined || !Number.isInteger(Number(edad)) || Number(edad) < 0) {
    throw new Error("Hay una edad de reserva desconocida; no se puede reclasificar automaticamente");
  }
  return Number(edad) < 2 ? "bebe" : Number(edad) < 18 ? "menor" : "adulto";
}

function limites(nombre) {
  return nombre === "bebe" ? [0, 1] : nombre === "menor" ? [2, 17] : [18, null];
}

function agrupar(filas, clave) {
  const resultado = new Map();
  for (const fila of filas) {
    const key = clave(fila);
    if (!resultado.has(key)) resultado.set(key, []);
    resultado.get(key).push(fila);
  }
  return resultado;
}

function mismosCampos(antes, despues, campos) {
  return campos.every((campo) => antes[campo] == null && despues[campo] == null ||
    String(antes[campo]) === String(despues[campo]));
}

function esBebe(tipo) {
  const nombre = String(tipo.nombre || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return Number(tipo.id) === 5 || /bebe|menores? de 2/.test(nombre);
}

function planTarifas(datos) {
  const tiposBebe = new Set(datos.tipos.filter(esBebe).map((tipo) => Number(tipo.id)));
  const referencias = agrupar(datos.referencias, (fila) => Number(fila.tarifa_id));
  const protegidas = new Set(datos.protegidas.map((fila) => Number(fila.tarifa_id)));
  const grupos = agrupar(datos.tarifas, (fila) => JSON.stringify(CAMPOS_GRUPO.map((campo) => fila[campo])));
  const updates = [], inserts = [], deletes = [], resultado = [];

  for (const filas of grupos.values()) {
    if (filas.every((fila) => fila.precio_por_persona === "N" || fila.tipo_persona_id == null)) {
      resultado.push(...filas);
      continue;
    }
    const categorias = tiposBebe.has(Number(filas[0].tipo_persona_id)) ? ["bebe"] : ["adulto", "menor"];
    const asignadas = new Set();
    const porCategoria = new Map();
    for (const nombre of categorias) {
      const referenciadas = filas.filter((fila) =>
        (referencias.get(Number(fila.id)) || []).some((ref) => categoria(ref.edad) === nombre));
      if (referenciadas.length > 1) {
        throw new Error(`El grupo de tarifa ${filas[0].id} tiene varias tarifas reservadas para ${nombre}; requiere conciliacion explicita`);
      }
      if (referenciadas.length === 1) {
        const elegida = referenciadas[0];
        if (asignadas.has(Number(elegida.id))) {
          throw new Error(`La tarifa ${elegida.id} esta reservada por varias categorias; no se modificaran snapshots`);
        }
        asignadas.add(Number(elegida.id));
        porCategoria.set(nombre, elegida);
      }
    }
    for (const nombre of categorias) {
      if (porCategoria.has(nombre)) continue;
      const candidatas = filas.filter((fila) => !asignadas.has(Number(fila.id))).sort((a, b) => {
        // La ultima banda antigua es la de adultos; la primera la de menores.
        const diferencia = Number(a.edad_minima || 0) - Number(b.edad_minima || 0);
        return (nombre === "adulto" ? -diferencia : diferencia) || Number(a.id) - Number(b.id);
      });
      const elegida = candidatas[0];
      if (elegida) {
        asignadas.add(Number(elegida.id));
        porCategoria.set(nombre, elegida);
      } else {
        const copia = { ...filas[0], id: null };
        porCategoria.set(nombre, copia);
      }
    }
    for (const [nombre, original] of porCategoria) {
      const [minimo, maximo] = limites(nombre);
      const nueva = { ...original, edad_minima: minimo, edad_maxima: maximo };
      if (nombre === "bebe") {
        nueva.precio = "0.00";
        nueva.usa_porcentaje = 0;
        nueva.porcentaje_descuento = "0.00";
      }
      if (original.id !== null) {
        for (const ref of referencias.get(Number(original.id)) || []) {
          if (categoria(ref.edad) !== nombre || Number(ref.tipo_persona_id) !== Number(original.tipo_persona_id)) {
            throw new Error(`La tarifa ${original.id} no puede reclasificarse sin cambiar participantes`);
          }
          if (centavos(ref.precio_aplicado) !== centavos(nueva.precio)) {
            throw new Error(`La tarifa reservada ${original.id} cambiaria el precio de un snapshot`);
          }
        }
        if (!mismosCampos(original, nueva, CAMPOS_TARIFA)) updates.push(nueva);
      } else inserts.push(nueva);
      resultado.push(nueva);
    }
    for (const fila of filas) {
      if (asignadas.has(Number(fila.id))) continue;
      if (protegidas.has(Number(fila.id)) || referencias.has(Number(fila.id))) {
        throw new Error(`La tarifa ${fila.id} tiene referencias y no puede consolidarse`);
      }
      deletes.push(Number(fila.id));
    }
  }
  // Una banda adulta agregada a partir de una infantil usa la lista adulta y
  // conserva su porcentaje. Así el editor puede volver a guardar la temporada.
  const claveLista = (fila) => JSON.stringify(CAMPOS_GRUPO.filter((campo) => campo !== "tipo_persona_id")
    .map((campo) => fila[campo]).concat(fila.edad_minima, fila.edad_maxima));
  const listas = new Map(resultado.filter((fila) => Number(fila.tipo_persona_id) === 4)
    .map((fila) => [claveLista(fila), fila]));
  for (const fila of resultado) {
    if (!Number(fila.usa_porcentaje)) continue;
    const lista = listas.get(claveLista(fila));
    if (!lista) throw new Error(`Falta precio de lista para la tarifa ${fila.id || "nueva"}`);
    const precio = Math.round(centavos(lista.precio) * (10000 - Math.round(Number(fila.porcentaje_descuento) * 100)) / 10000);
    if (precio === centavos(fila.precio)) continue;
    if (referencias.has(Number(fila.id))) throw new Error(`La tarifa reservada ${fila.id} no coincide con su precio de lista`);
    fila.precio = (precio / 100).toFixed(2);
    if (fila.id !== null && !updates.some((item) => Number(item.id) === Number(fila.id))) updates.push(fila);
  }
  return { updates, inserts, deletes, resultado, grupos: grupos.size };
}

function planPredeterminados(datos) {
  const porRegla = agrupar(datos.rangos, (fila) => Number(fila.regla_id));
  const tiposBebe = new Set(datos.tipos.filter(esBebe).map((tipo) => Number(tipo.id)));
  const cambios = [];
  for (const regla of datos.reglas) {
    const antiguos = porRegla.get(Number(regla.id)) || [];
    const nombres = tiposBebe.has(Number(regla.tipo_persona_id)) ? ["bebe"] : ["menor", "adulto"];
    const nuevos = nombres.map((nombre, orden) => {
      const [edad_minima, edad_maxima] = limites(nombre);
      return { orden, edad_minima, edad_maxima };
    });
    const mapearOrden = (valor) => {
      const previo = antiguos.find((fila) => Number(fila.orden) === Number(valor));
      return nombres.length === 1 || !previo ||
        (Number(previo.edad_minima || 0) < 18 && previo.edad_maxima !== null) ? 0 : 1;
    };
    const rango_base_orden = mapearOrden(regla.rango_base_orden);
    const rango_tope_orden = Number(regla.usar_tope) ? mapearOrden(regla.rango_tope_orden) : null;
    if (antiguos.length !== nuevos.length || nuevos.some((fila, i) =>
      !mismosCampos(antiguos[i] || {}, fila, ["orden", "edad_minima", "edad_maxima"])) ||
      Number(regla.rango_base_orden) !== rango_base_orden ||
      !mismosCampos(regla, { rango_tope_orden }, ["rango_tope_orden"])) {
      cambios.push({ id: regla.id, nuevos, rango_base_orden, rango_tope_orden });
    }
  }
  return cambios;
}

function validarReservas(datos, tarifas) {
  const tarifasPorId = new Map(tarifas.filter((fila) => fila.id !== null).map((fila) => [Number(fila.id), fila]));
  const porPersona = agrupar(datos.referencias, (fila) => Number(fila.reserva_familiar_id));
  const porReserva = agrupar(datos.personas, (fila) => Number(fila.reserva_id));
  for (const ref of datos.referencias) {
    const tarifa = tarifasPorId.get(Number(ref.tarifa_id));
    if (!tarifa) throw new Error(`La tarifa reservada ${ref.tarifa_id} no se preservo`);
    const edad = Number(ref.edad);
    if (edad < tarifa.edad_minima || tarifa.edad_maxima !== null && edad > tarifa.edad_maxima ||
      ref.fecha < tarifa.fecha_inicio || ref.fecha > tarifa.fecha_fin ||
      Number(tarifa.tipo_persona_id) !== Number(ref.tipo_persona_id)) {
      throw new Error(`La referencia de reserva ${ref.reserva_familiar_id} no coincide con su tarifa normalizada`);
    }
  }
  for (const persona of datos.personas) {
    categoria(persona.edad);
    const noches = porPersona.get(Number(persona.id)) || [];
    if (noches.length && noches.reduce((suma, fila) => suma + centavos(fila.precio_aplicado), 0) !== centavos(persona.precio)) {
      throw new Error(`El importe del participante ${persona.id} no coincide con sus noches`);
    }
  }
  for (const reserva of datos.reservas) {
    const subtotal = (porReserva.get(Number(reserva.id)) || []).reduce((suma, fila) => suma + centavos(fila.precio), 0);
    if (subtotal + centavos(reserva.monto_adicionales) - centavos(reserva.monto_descuentos) !== centavos(reserva.precio_total)) {
      throw new Error(`El total de la reserva ${reserva.id} no coincide con su detalle`);
    }
  }
  return { reservas: datos.reservas.length, personas: datos.personas.length, noches: datos.referencias.length };
}

function crearPlan(datos) {
  const tarifas = planTarifas(datos);
  const predeterminados = planPredeterminados(datos);
  const reservas = validarReservas(datos, tarifas.resultado);
  return { tarifas, predeterminados, resumen: {
    temporadas: datos.temporadas.length,
    tarifas_actuales: datos.tarifas.length,
    tarifas_finales: tarifas.resultado.length,
    tarifas_actualizadas: tarifas.updates.length,
    tarifas_agregadas: tarifas.inserts.length,
    tarifas_consolidadas: tarifas.deletes.length,
    reglas_predeterminadas_actualizadas: predeterminados.length,
    reservas_verificadas: reservas.reservas,
    participantes_verificados: reservas.personas,
    noches_verificadas: reservas.noches,
    reservas_con_cambios_financieros: 0,
  } };
}

async function cargarDatos(connection, lock = false) {
  const sufijo = lock ? " FOR UPDATE" : "";
  const sql = {
    tipos: "SELECT id, nombre FROM tipo_persona ORDER BY id",
    temporadas: "SELECT id, origen FROM temporada_tarifa ORDER BY id",
    tarifas: `SELECT id, ${CAMPOS_TARIFA.join(", ")} FROM tarifa WHERE temporada_tarifa_id IS NOT NULL ORDER BY id`,
    reglas: "SELECT id, tipo_persona_id, rango_base_orden, usar_tope, rango_tope_orden FROM flujo_descuento_escalonado_regla ORDER BY id",
    rangos: "SELECT id, regla_id, orden, edad_minima, edad_maxima FROM flujo_descuento_escalonado_rango_edad ORDER BY regla_id, orden",
    reservas: "SELECT id, precio_total, monto_adicionales, monto_descuentos FROM reserva ORDER BY id",
    personas: "SELECT id, reserva_id, tipo_persona_id, edad, precio FROM reserva_familiar ORDER BY id",
    referencias: `SELECT rft.tarifa_id, rft.reserva_familiar_id, rft.fecha,
      COALESCE(rft.precio_aplicado, t.precio) precio_aplicado, rf.tipo_persona_id, rf.edad
      FROM reserva_familiar_tarifa rft JOIN reserva_familiar rf ON rf.id = rft.reserva_familiar_id
      JOIN tarifa t ON t.id = rft.tarifa_id WHERE t.temporada_tarifa_id IS NOT NULL ORDER BY rft.id`,
    protegidas: `SELECT tarifa_id FROM reserva_adicional_detalle WHERE tarifa_id IS NOT NULL
      UNION SELECT tarifa_id_legacy tarifa_id FROM reserva_familiar_tarifa WHERE tarifa_id_legacy IS NOT NULL`,
  };
  const datos = {};
  for (const [clave, consulta] of Object.entries(sql)) {
    [datos[clave]] = await connection.query(consulta + (clave === "protegidas" ? "" : sufijo));
  }
  return datos;
}

function huellaReservas(datos) {
  return crypto.createHash("sha256").update(JSON.stringify({
    reservas: datos.reservas, personas: datos.personas, referencias: datos.referencias,
  })).digest("hex");
}

async function aplicarPlan(connection, plan) {
  // Eliminar únicamente bandas redundantes sin ninguna referencia. El trigger
  // de integridad también rechaza una eliminación si apareció una referencia.
  for (const id of plan.tarifas.deletes) await connection.query("DELETE FROM tarifa WHERE id = ?", [id]);
  for (const fila of plan.tarifas.updates) {
    await connection.query(`UPDATE tarifa SET ${CAMPOS_TARIFA.map((campo) => `${campo} = ?`).join(", ")} WHERE id = ?`,
      [...CAMPOS_TARIFA.map((campo) => fila[campo]), fila.id]);
  }
  for (const fila of plan.tarifas.inserts) {
    await connection.query(`INSERT INTO tarifa (${CAMPOS_TARIFA.join(", ")}) VALUES (${CAMPOS_TARIFA.map(() => "?").join(", ")})`,
      CAMPOS_TARIFA.map((campo) => fila[campo]));
  }
  for (const regla of plan.predeterminados) {
    await connection.query("DELETE FROM flujo_descuento_escalonado_rango_edad WHERE regla_id = ?", [regla.id]);
    for (const rango of regla.nuevos) {
      await connection.query("INSERT INTO flujo_descuento_escalonado_rango_edad (regla_id, orden, edad_minima, edad_maxima) VALUES (?, ?, ?, ?)",
        [regla.id, rango.orden, rango.edad_minima, rango.edad_maxima]);
    }
    await connection.query("UPDATE flujo_descuento_escalonado_regla SET rango_base_orden = ?, rango_tope_orden = ? WHERE id = ?",
      [regla.rango_base_orden, regla.rango_tope_orden, regla.id]);
  }
}

function opcionesDesdeArgv(argv) {
  const valor = (nombre) => argv.find((arg) => arg.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
  const target = valor("target");
  if (!["develop", "production"].includes(target)) throw new Error("Indica --target=develop o --target=production");
  if (argv.includes("--apply") && argv.includes("--check")) throw new Error("Indica --check o --apply, no ambos");
  if (target === "production" && !argv.includes("--allow-production")) throw new Error("Production exige --allow-production");
  const apply = argv.includes("--apply");
  if (apply && valor("confirm") !== CONFIRMACION) throw new Error(`Apply exige --confirm=${CONFIRMACION}`);
  return { target, apply, envFile: path.resolve(valor("env-file") || path.join(__dirname, "../.env")), caPath: valor("ca-path") };
}

async function main(argv = process.argv.slice(2)) {
  const opciones = opcionesDesdeArgv(argv);
  const config = { ...parsearBloquesEnv(fs.readFileSync(opciones.envFile, "utf8"))[opciones.target] };
  const ca = opciones.caPath || process.env.DB_SSL_CA_PATH;
  if (ca) { config.DB_SSL_MODE = "verify-full"; config.DB_SSL_CA_PATH = ca; }
  validarConfiguracion(opciones.target, config);
  const connection = await mysql.createConnection({ ...crearOpcionesConexion(config, opciones.target), connectTimeout: 10000 });
  let lock = false;
  try {
    await connection.query("SET SESSION time_zone = '-03:00'");
    if (opciones.apply) {
      const [[fila]] = await connection.query("SELECT GET_LOCK(?, 10) adquirido", [MIGRATION_ID]);
      if (Number(fila.adquirido) !== 1) throw new Error("Otra migracion de edades esta en curso");
      lock = true;
      await connection.beginTransaction();
    } else await connection.query("START TRANSACTION READ ONLY");
    const antes = await cargarDatos(connection, opciones.apply);
    const plan = crearPlan(antes);
    const informe = { migration_id: MIGRATION_ID, target: opciones.target, modo: opciones.apply ? "apply" : "check", ...plan.resumen };
    if (opciones.apply) {
      await aplicarPlan(connection, plan);
      const despues = await cargarDatos(connection, true);
      const post = crearPlan(despues);
      if (post.tarifas.updates.length || post.tarifas.inserts.length || post.tarifas.deletes.length || post.predeterminados.length) {
        throw new Error("La verificacion posterior detecto cambios pendientes; rollback");
      }
      if (huellaReservas(antes) !== huellaReservas(despues)) throw new Error("Cambio inesperado en reservas; rollback");
      await connection.commit();
      informe.verificado = true;
      informe.pendientes = 0;
    } else await connection.rollback();
    console.log(JSON.stringify(informe, null, 2));
    return informe;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    if (lock) await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_ID]).catch(() => {});
    await connection.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || error.message }));
  process.exitCode = 1;
});

module.exports = { CONFIRMACION, aplicarPlan, categoria, crearPlan, huellaReservas, limites, main, opcionesDesdeArgv, planPredeterminados, planTarifas, validarReservas };
