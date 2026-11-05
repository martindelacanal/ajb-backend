"use strict";

// Datos que manda el sistema general: departamentales y afiliados con reservas en los
// servicios del predio (camping y cabañas). Se aplican igual en la notebook (SQLite)
// y en la réplica central (MySQL). Un afiliado cargado a mano se une solo con su
// ficha del sistema cuando coincide el DNI o el legajo.

const U = require("./util");
const N = require("./negocio");

async function aplicarMaestros(t, ctx, maestros) {
  const resumen = { departamentales: 0, afiliados_nuevos: 0, afiliados_unidos: 0, afiliados_actualizados: 0, estadias: 0 };
  const pid = ctx.pid;

  for (const d of maestros.departamentales || []) {
    const id = Number(d.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const nombre = String(d.nombre || "").slice(0, 80) || `Departamental ${id}`;
    const activo = d.activo === false || d.activo === 0 ? 0 : 1;
    const existe = await t.get("SELECT nombre, activo FROM predio_departamental WHERE predio_id = ? AND id = ?", [pid, id]);
    if (!existe) {
      await t.run("INSERT INTO predio_departamental (predio_id, id, nombre, activo) VALUES (?, ?, ?, ?)", [pid, id, nombre, activo]);
      resumen.departamentales++;
    } else if (existe.nombre !== nombre || Number(existe.activo) !== activo) {
      await t.run("UPDATE predio_departamental SET nombre = ?, activo = ? WHERE predio_id = ? AND id = ?", [nombre, activo, pid, id]);
      resumen.departamentales++;
    }
  }

  const config = await N.leerConfig(t, ctx);
  const limiteInicial = U.redondear(Number(config.limite_inicial || 0));
  const actor = { ...ctx, usuario: { id: null, nombre: "Sincronización" }, origen: "SISTEMA" };
  const reservasVistas = new Set();

  for (const a of maestros.afiliados || []) {
    const generalId = Number(a.usuario_id);
    if (!Number.isSafeInteger(generalId) || generalId <= 0) continue;
    const dni = a.documento ? String(Number(String(a.documento).replace(/\D/g, ""))) : null;
    const legajo = a.legajo ? String(a.legajo).trim().slice(0, 30) : null;
    const nombre = String(a.nombre || "").replace(/\s+/g, " ").trim().slice(0, 160) || `Afiliado ${dni || generalId}`;
    const departamentalId = a.departamental_id ? Number(a.departamental_id) : null;

    let fila = await t.get("SELECT * FROM predio_afiliado WHERE predio_id = ? AND usuario_general_id = ?", [pid, generalId]);
    if (!fila && (dni || legajo)) {
      fila = await t.get(
        `SELECT * FROM predio_afiliado WHERE predio_id = ? AND usuario_general_id IS NULL
         AND ((? IS NOT NULL AND dni = ?) OR (? IS NOT NULL AND legajo = ?)) ORDER BY id LIMIT 1`,
        [pid, dni, dni, legajo, legajo]);
      if (fila) {
        await N.actualizar(t, actor, "predio_afiliado", fila.id, {
          usuario_general_id: generalId, origen: "SISTEMA", nombre, dni: dni || fila.dni, legajo: legajo || fila.legajo,
          departamental_id: departamentalId || fila.departamental_id,
        });
        await N.auditar(t, actor, "Afiliado manual unido con el sistema general", "afiliado", fila.id, { dni, legajo, usuario_general_id: generalId });
        resumen.afiliados_unidos++;
      }
    } else if (fila && (fila.nombre !== nombre || (dni && fila.dni !== dni) || (legajo && fila.legajo !== legajo) || Number(fila.departamental_id || 0) !== Number(departamentalId || 0))) {
      await N.actualizar(t, actor, "predio_afiliado", fila.id, {
        nombre, dni: dni || fila.dni, legajo: legajo || fila.legajo, departamental_id: departamentalId, origen: "SISTEMA",
      });
      resumen.afiliados_actualizados++;
    }
    let afiliadoId = fila ? fila.id : null;
    if (!afiliadoId) {
      afiliadoId = await N.insertar(t, actor, "predio_afiliado", {
        usuario_general_id: generalId, dni, legajo, nombre, departamental_id: departamentalId, limite: limiteInicial,
        habilitado_descuento: 1, origen: "SISTEMA",
      });
      if (limiteInicial > 0) {
        await N.insertar(t, actor, "predio_limite_historial", {
          afiliado_id: afiliadoId, fecha: U.fechaHora(), limite_anterior: 0, limite_nuevo: limiteInicial, motivo: "ALTA", usuario_nombre: "Sincronización",
        });
      }
      resumen.afiliados_nuevos++;
    }

    for (const e of a.estadias || []) {
      const reservaId = Number(e.reserva_id);
      if (!Number.isSafeInteger(reservaId) || !U.esFechaIso(String(e.fecha_inicio).slice(0, 10)) || !U.esFechaIso(String(e.fecha_fin).slice(0, 10))) continue;
      reservasVistas.add(reservaId);
      const datos = {
        afiliado_id: afiliadoId,
        servicio: e.servicio ? String(e.servicio).slice(0, 80) : null,
        unidad: e.unidad ? String(e.unidad).slice(0, 80) : null,
        fecha_inicio: String(e.fecha_inicio).slice(0, 10),
        fecha_fin: String(e.fecha_fin).slice(0, 10),
        estado: e.estado ? String(e.estado).slice(0, 40) : null,
        personas: Number.isFinite(Number(e.personas)) ? Number(e.personas) : null,
        activo: 1,
        fecha_modificacion: U.fechaHora(),
      };
      const existe = await t.get("SELECT * FROM predio_estadia WHERE predio_id = ? AND reserva_id = ?", [pid, reservaId]);
      if (!existe) {
        await N.insertar(t, actor, "predio_estadia", { ...datos, reserva_id: reservaId });
        resumen.estadias++;
      } else if (["afiliado_id", "servicio", "unidad", "fecha_inicio", "fecha_fin", "estado", "personas", "activo"]
        .some((k) => String(existe[k] ?? "") !== String(datos[k] ?? ""))) {
        await N.actualizar(t, actor, "predio_estadia", existe.id, datos);
        resumen.estadias++;
      }
    }
  }

  // Reservas que ya no vienen (canceladas o rechazadas) dentro de la ventana informada.
  if (maestros.ventana_desde && U.esFechaIso(maestros.ventana_desde)) {
    const activas = await t.all(
      "SELECT id, reserva_id FROM predio_estadia WHERE predio_id = ? AND activo = 1 AND reserva_id IS NOT NULL AND fecha_fin >= ?",
      [pid, maestros.ventana_desde]);
    for (const e of activas) {
      if (!reservasVistas.has(Number(e.reserva_id))) {
        await t.run("UPDATE predio_estadia SET activo = 0, estado = ?, fecha_modificacion = ? WHERE predio_id = ? AND id = ?",
          ["Sin reserva vigente", U.fechaHora(), pid, e.id]);
        resumen.estadias++;
      }
    }
  }
  return resumen;
}

module.exports = { aplicarMaestros };
