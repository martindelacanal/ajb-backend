"use strict";
const U = require("../../predios/lib/util");
const { validarAutorizacionHa, esAutorizacionHa } = require("./predios-ha");

function identidad(datos = {}) {
  const instancia = String(datos.instancia_id || "");
  const equipo = String(datos.equipo_id || "");
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(instancia)) throw U.error("La instalación no informó una identidad válida", 400);
  if (equipo && !/^[a-f0-9]{64}$/.test(equipo)) throw U.error("La identidad del equipo no es válida", 400);
  return { instancia_id: instancia, equipo_id: equipo || null };
}

function exigirPropietario(predio, datos, { exigirLocal = false, haAutorizada = null } = {}) {
  const quien = identidad(datos);
  if (exigirLocal && predio.escritor !== "LOCAL") throw U.error("Esta instalación todavía no tiene el control de los datos", 409, { codigo: "SIN_CONTROL" });
  if (predio.escritor === "LOCAL") {
    if (predio.instancia_id && predio.instancia_id !== quien.instancia_id) {
      throw U.error(`Ya hay un servidor asignado a este predio (${predio.equipo || "otro equipo"}). Usá ese servidor. Un reemplazo requiere transferir el control desde la administración.`, 409, { codigo: "OTRA_INSTALACION" });
    }
    if (predio.equipo_id && predio.equipo_id !== quien.equipo_id && !esAutorizacionHa(haAutorizada, predio, quien)) {
      throw U.error("La instalación fue copiada a otro equipo. Este predio ya tiene un servidor asignado; no se habilitaron escrituras ni sincronización desde esta PC.", 409, { codigo: "OTRO_EQUIPO" });
    }
  }
  return quien;
}

async function conPropietarioBloqueado(pool, predioId, trabajo) {
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [[predio]] = await conexion.query("SELECT * FROM predio WHERE id = ? FOR UPDATE", [predioId]);
    if (!predio) throw U.error("No encontramos el predio", 404);
    const resultado = await trabajo(conexion, predio);
    await conexion.commit();
    return resultado;
  } catch (e) {
    await conexion.rollback();
    throw e;
  } finally { conexion.release(); }
}

async function saludarPredio(pool, predioId, body, opcionesHa = {}) {
  return conPropietarioBloqueado(pool, predioId, async (c, p) => {
    const haAutorizada = await validarAutorizacionHa(c, p, { ...opcionesHa, instanciaId: body.instancia_id, equipoId: body.equipo_id });
    const quien = exigirPropietario(p, body, { haAutorizada });
    if (p.escritor === "LOCAL" && p.instancia_id && !p.equipo_id && quien.equipo_id && p.equipo
      && String(body.equipo || "").trim().toLowerCase() !== String(p.equipo).trim().toLowerCase()) {
      throw U.error("El nombre del equipo no coincide con el servidor existente. No se vinculó esta copia al predio; revisá el reemplazo desde la administración.", 409, { codigo: "OTRO_EQUIPO" });
    }
    let accion = null;
    if (p.escritor === "CENTRAL") {
      const posterior = p.ultima_escritura_central && body.bootstrap_generado && p.ultima_escritura_central > body.bootstrap_generado;
      accion = body.vacia || (posterior && !Number(body.pendientes)) ? "DESCARGAR_DATOS" : "TOMAR_CONTROL";
    } else if (!p.instancia_id) accion = "TOMAR_CONTROL";
    await c.query(
      "UPDATE predio SET ultima_conexion = NOW(), version_local = ?, equipo = ?, pendientes_local = ?, equipo_id = COALESCE(equipo_id, ?) WHERE id = ?",
      [String(body.version || "").slice(0, 60) || null, String(body.equipo || "").slice(0, 120) || null, Number(body.pendientes) || 0, p.escritor === "LOCAL" && p.instancia_id ? quien.equipo_id : null, p.id]);
    return { predio: p, accion, autoriza_escritura: p.escritor === "LOCAL" && !!p.instancia_id };
  });
}

async function tomarControl(pool, predioId, body, opcionesHa = {}) {
  return conPropietarioBloqueado(pool, predioId, async (c, p) => {
    const haAutorizada = await validarAutorizacionHa(c, p, { ...opcionesHa, instanciaId: body.instancia_id, equipoId: body.equipo_id });
    const quien = exigirPropietario(p, body, { haAutorizada });
    // Los instaladores anteriores aún no envían identidad de hardware y buscan
    // actualizaciones después de tomar control. Se admite su primera activación
    // serializada; la nueva versión vincula el equipo al siguiente saludo.
    if (!quien.equipo_id && p.escritor === "LOCAL" && p.instancia_id && p.equipo_id) {
      throw U.error("Actualizá el sistema del predio antes de habilitar este equipo como servidor", 409, { codigo: "FALTA_IDENTIDAD_EQUIPO" });
    }
    const equipo = haAutorizada.haAutorizada ? p.equipo_id : p.escritor === "LOCAL" && p.instancia_id && !p.equipo_id ? null : quien.equipo_id;
    await c.query("UPDATE predio SET escritor = 'LOCAL', instancia_id = ?, equipo_id = ? WHERE id = ?", [quien.instancia_id, equipo, p.id]);
    await c.query("INSERT INTO predio_evento (predio_id, tipo, detalle) VALUES (?, 'TOMA_DE_CONTROL', ?)", [p.id, JSON.stringify({ instancia: quien.instancia_id, equipo_id: quien.equipo_id, anterior: p.instancia_id })]);
    return { ok: true, autoriza_escritura: true };
  });
}

module.exports = { identidad, exigirPropietario, conPropietarioBloqueado, saludarPredio, tomarControl };
