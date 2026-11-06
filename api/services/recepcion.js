"use strict";

// La reserva, sus tarifas, su historial y el recibo de reintento se confirman juntos en Turismo.
const U = require("../../predios/lib/util");
const {
  serviciosDe
} = require("./predios-central");
const {
  jsonCanonico
} = require("./reserva-version-archivo");
const todos = async (c, sql, p = []) => (await c.query(sql, p))[0];
const uno = async (c, sql, p) => (await todos(c, sql, p))[0];
const dinero = v => U.numero(v, {
  min: 0,
  max: 999999999,
  campo: "El precio"
});
const fecha = v => U.fecha(v, {
  requerido: true
});
const tipos = ["GENERAL", "PASA_EL_DIA", "CONTINGENTE", "FEDERACION"];
const personaCols = "u.id,u.documento AS dni,u.nombre,u.apellido,u.fecha_nacimiento,u.tipo_persona_id,u.parentesco_id,u.legajo";
const firma = d => U.sha256(jsonCanonico(d));
const nombre = p => [p.apellido, p.nombre].filter(Boolean).join(", ");
const ultimo = (c, id, lock) => uno(c, "SELECT * FROM recepcion_reserva_evento WHERE reserva_id=? ORDER BY id DESC LIMIT 1" + (lock ? " FOR UPDATE" : ""), [id]);
async function opciones(c, codigos) {
  const servicios = await todos(c, "SELECT id,nombre,codigo,modelo_tarifa FROM servicio WHERE activo=1 AND estado_aprobacion='APROBADO' AND codigo IN (?) ORDER BY nombre", [codigos]);
  const ids = servicios.map(s => s.id);
  const recursos = ids.length ? await todos(c, "SELECT id,nombre,servicio_id FROM recurso WHERE activo=1 AND servicio_id IN (?) ORDER BY orden,nombre", [ids]) : [];
  const adicionales = ids.length ? await todos(c, "SELECT DISTINCT a.id,a.nombre,ta.recurso_id,ta.regimen_id FROM tarifa_adicional ta JOIN adicional a ON a.id=ta.adicional_id JOIN recurso r ON r.id=ta.recurso_id WHERE ta.activo=1 AND r.servicio_id IN (?) ORDER BY a.nombre", [ids]) : [];
  return {
    servicios,
    recursos,
    adicionales,
    regimenes: await todos(c, "SELECT id,nombre FROM regimen"),
    parentescos: await todos(c, "SELECT id,nombre FROM parentesco")
  };
}
async function familia(c, q, pid) {
  q = U.texto(q, {
    requerido: true,
    max: 30
  });
  const t = await uno(c, `SELECT ${personaCols},u.departamental_id, (rp.usuario_id IS NULL) AS afiliado FROM usuario u
    LEFT JOIN recepcion_particular rp ON rp.usuario_id=u.id
    WHERE (u.documento=? OR u.legajo=?) AND ((u.rol_id=2 AND u.habilitado='Y' AND u.usuario_familiar_id IS NULL) OR rp.predio_id=?)
    ORDER BY (u.documento=?) DESC LIMIT 1`, [q, q, pid, q]);
  if (!t) return {
    titular: null,
    personas: []
  };
  const personas = await todos(c, `SELECT ${personaCols} FROM usuario u WHERE u.id=? OR u.usuario_familiar_id=? ORDER BY u.id=? DESC,u.apellido,u.nombre`, [t.id, t.id, t.id]);
  return {
    titular: t,
    personas
  };
}
async function detalle(c, codigos, id, lock = false) {
  const r = await uno(c, `SELECT r.id,r.usuario_id,r.servicio_id,r.recurso_id,r.regimen_id,r.fecha_inicio,r.fecha_fin,r.precio_total,r.observaciones,r.numero_parcela,r.bloque_fecha_id,r.sorteo_id,r.estado_reserva_id,er.nombre AS estado,s.nombre AS servicio,rec.nombre AS recurso,
    u.documento AS titular_dni,CONCAT_WS(', ',u.apellido,u.nombre) AS titular_nombre,u.legajo AS titular_legajo,(u.rol_id=2 AND u.habilitado='Y') AS afiliado
    FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id LEFT JOIN recurso rec ON rec.id=r.recurso_id
    JOIN estado_reserva er ON er.id=r.estado_reserva_id WHERE r.id=? AND s.codigo IN (?)${lock ? " FOR UPDATE" : ""}`, [id, codigos]);
  if (!r) throw U.error("No se encontró esa reserva entre los servicios asignados al predio.", 404);
  const ev = await ultimo(c, id, lock),
    ext = ev ? JSON.parse(ev.actual) : {};
  if (ext.dia_sin_noche && r.fecha_fin === U.sumarDias(r.fecha_inicio, 1)) r.fecha_fin = r.fecha_inicio;
  const personas = await todos(c, `SELECT ${personaCols},rf.parentesco_id,rf.tipo_persona_id,rf.precio FROM reserva_familiar rf JOIN usuario u ON u.id=rf.usuario_id WHERE rf.reserva_id=? ORDER BY rf.id`, [id]);
  for (const p of personas) {
    const prev = (ext.personas || []).find(x => String(x.dni) === String(p.dni));
    p.entrada = prev?.entrada || null;
    p.salida = prev?.salida || null;
  }
  const adicionales = await todos(c, "SELECT adicional_id,cantidad,nombre_adicional AS nombre,subtotal FROM reserva_adicional WHERE reserva_id=? ORDER BY id", [id]);
  const datos = {
    ...r,
    tipo: ext.tipo || "GENERAL",
    entidad: ext.entidad || null,
    cantidad: ext.cantidad || personas.length,
    vehiculo: ext.vehiculo || {},
    manual: ext.manual ?? null,
    automatico: ext.automatico ?? r.precio_total,
    tramos: ext.tramos || [],
    personas,
    adicionales,
    revision: ev ? Number(ev.id) : 0
  };
  return {
    ...datos,
    version: firma(datos)
  };
}
function resumenCambios(a, b) {
  const cambios = [];
  for (const [k, l] of Object.entries({
    estado: "Estado",
    servicio: "Servicio",
    recurso: "Recurso",
    regimen_id: "Régimen",
    fecha_inicio: "Desde",
    fecha_fin: "Hasta",
    tipo: "Tipo",
    cantidad: "Integrantes",
    entidad: "Entidad",
    precio_total: "Precio final",
    manual: "Precio manual",
    observaciones: "Observaciones"
  })) {
    if (String(a?.[k] ?? "") !== String(b[k] ?? "")) cambios.push([l, a?.[k], b[k]]);
  }
  for (const k of ["marca", "color", "patente", "sector"]) {
    if ((a?.vehiculo?.[k] || "") !== (b.vehiculo[k] || "")) cambios.push([k, a?.vehiculo?.[k], b.vehiculo[k]]);
  }
  const mapa = (xs, fn) => new Map((xs || []).map(x => [String(fn(x)), x]));
  for (const [key, id, describe] of [["personas", "dni", p => nombre(p) + " · DNI " + p.dni + " · " + (p.entrada || "sin ingreso") + " / " + (p.salida || "sin salida") + " · $" + Number(p.precio || 0)], ["adicionales", "adicional_id", p => p.nombre + " × " + p.cantidad + " · $" + Number(p.subtotal)]]) {
    const ant = mapa(a?.[key], p => p[id]),
      sig = mapa(b[key], p => p[id]);
    for (const k of new Set([...ant.keys(), ...sig.keys()])) {
      const x = ant.has(k) ? describe(ant.get(k)) : null,
        y = sig.has(k) ? describe(sig.get(k)) : null;
      if (x !== y) cambios.push([key === "personas" ? "Pasajero" : "Adicional", x, y]);
    }
  }
  if (a && Number(a.recurso_id) !== Number(b.recurso_id)) cambios.push(["Traslado", a.recurso, (b.recurso || "Sin recurso") + " · " + (b.tramos.at(-1)?.desde || b.fecha_inicio) + " · " + b.personas.filter(p => !p.salida).map(nombre).join("; ")]);
  return cambios;
}
async function listar(c, codigos, b) {
  const cond = ["s.codigo IN (?)"],
    p = [codigos];
  if (b.ocupacion === "PRESENTE" || b.ocupacion === "SALIDA") {
    const modo = b.ocupacion === "PRESENTE" ? "hp.salida IS NULL" : "hp.salida IS NOT NULL";
    cond.push("EXISTS (SELECT 1 FROM predio_huesped hp WHERE hp.reserva_id=r.id AND hp.predio_id=? AND hp.entrada IS NOT NULL AND " + modo + ")");
    p.push(U.id(b.predioId));
  }
  if (b.q) {
    cond.push("(r.id=? OR u.documento=? OR CONCAT_WS(' ',u.apellido,u.nombre) LIKE ?)");
    p.push(Number(b.q) || 0, b.q, "%" + U.texto(b.q, {
      max: 80
    }) + "%");
  }
  if (b.desde) {
    cond.push("r.fecha_fin>=?");
    p.push(fecha(b.desde));
  }
  if (b.hasta) {
    cond.push("r.fecha_inicio<=?");
    p.push(fecha(b.hasta));
  }
  if (b.tipo) {
    cond.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.tipo')),'GENERAL')=?");
    p.push(U.opcion(b.tipo, tipos));
  }
  if (b.atipicas === "1") {
    cond.push("e.id IS NOT NULL");
  }
  if (b.servicio_id) {
    cond.push("s.id=?");
    p.push(U.id(b.servicio_id));
  }
  const from = ` FROM reserva r JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id JOIN estado_reserva er ON er.id=r.estado_reserva_id LEFT JOIN recurso rec ON rec.id=r.recurso_id
    LEFT JOIN recepcion_reserva_evento e ON e.id=(SELECT MAX(ev.id) FROM recepcion_reserva_evento ev WHERE ev.reserva_id=r.id) WHERE ${cond.join(" AND ")}`;
  const pagina = U.entero(b.pagina || 1, {
    min: 1,
    max: 999999
  });
  const filas = await todos(c, `SELECT r.id,r.fecha_inicio,r.fecha_fin,r.precio_total,s.nombre AS servicio,rec.nombre AS recurso,er.nombre AS estado,CONCAT_WS(', ',u.apellido,u.nombre) AS titular,JSON_UNQUOTE(JSON_EXTRACT(e.actual,'$.tipo')) AS tipo${from} ORDER BY r.fecha_inicio DESC,r.id DESC LIMIT 40 OFFSET ${(pagina - 1) * 40}`, p);
  return {
    filas,
    pagina,
    ...(await uno(c, "SELECT COUNT(*) AS cantidad,COALESCE(SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(e.actual,\'$.cantidad\')) AS UNSIGNED),(SELECT COUNT(*) FROM reserva_familiar rf WHERE rf.reserva_id=r.id))),0) AS viajeros,COALESCE(SUM(r.precio_total),0) AS importe" + from, p))
  };
}
async function cotizar(c, T, {
  tipo,
  servicio,
  recursoId,
  regimenId,
  personas,
  inicio,
  fin,
  adicionales,
  tramos,
  temporada,
  departamentalId
}) {
  const pasajeros = personas.map(p => ({
    ...p,
    tarifa_individual: 0,
    tarifa_original_individual: 0,
    tarifas_por_fecha: []
  }));
  if (tipo !== "GENERAL") return {
    personas: pasajeros,
    total: 0,
    extras: {
      total: 0,
      items: []
    }
  };
  let total = 0;
  const segmentos = tramos.length ? tramos : [{
    desde: inicio,
    recurso_id: recursoId
  }];
  for (let i = 0; i < segmentos.length; i++) {
    const seg = segmentos[i],
      a = i === 0 ? inicio : seg.desde,
      z = segmentos[i + 1]?.desde || fin;
    if (a >= z) continue;
    const fijo = servicio.modelo_tarifa === "PRECIO_UNICO" || servicio.unidad_cobro === "POR_ESTADIA" || ["POR_RECURSO_NOCHE", "POR_RECURSO_DIA"].includes(servicio.unidad_cobro);
    const cot = await T.calcularTarifaBaseReserva(c, {
      recursoId: seg.recurso_id,
      regimenId,
      personas: servicio.modelo_tarifa === "PRECIO_UNICO" ? pasajeros.slice(0, 1) : pasajeros,
      fechaInicio: a,
      fechaFin: z,
      temporadaTarifaId: temporada,
      departamentalId,
      recepcion: true
    });
    for (const row of cot.personas) {
      const p = pasajeros.find(x => String(x.dni) === String(row.dni));
      for (const noche of row.tarifas_por_fecha) {
        if (!fijo && noche.por_persona !== false && (noche.fecha < (p.entrada || inicio) || noche.fecha >= (p.salida || fin))) continue;
        p.tarifas_por_fecha.push(noche);
        p.tarifa_individual = U.redondear(p.tarifa_individual + Number(noche.precio));
        p.tarifa_original_individual = U.redondear(p.tarifa_original_individual + Number(noche.precio_original ?? noche.precio));
        total += Number(noche.precio);
      }
    }
  }
  return {
    personas: pasajeros,
    total: U.redondear(total),
    extras: await T.calcularAdicionalesReserva(c, adicionales, recursoId, regimenId, inicio, fin, pasajeros, temporada)
  };
}
async function guardar(c, predio, actor, b, codigos, previa) {
  const T = require("../routes/user").negocioRecepcion;
  const actorId = actor.general_usuario_id || null;
  const req = {
    ip: "",
    connection: {
      remoteAddress: ""
    },
    socket: {
      remoteAddress: ""
    },
    headers: {},
    get: () => null
  };
  const operacion = String(b.operacion || ""),
    huella = firma({
      actor: actor.id,
      datos: b
    });
  if (!previa) {
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(operacion)) throw U.error("Falta identificar la operación.");
    const recibo = await uno(c, "SELECT id,huella,actual FROM recepcion_reserva_evento WHERE predio_id=? AND operacion=?", [predio.id, operacion]);
    if (recibo) {
      if (recibo.huella !== huella) throw U.error("El comprobante corresponde a otro cambio.", 409);
      return {
        ...JSON.parse(recibo.actual),
        evento_id: Number(recibo.id)
      };
    }
  }
  const anterior = b.id ? await detalle(c, codigos, U.id(b.id), true) : null;
  if (anterior && anterior.version !== b.version) throw U.error("Otra persona modificó la reserva. Volvé a abrirla antes de guardar.", 409);
  if (anterior && !["Aprobada", "Verificada", "Iniciada", "Adjudicada"].includes(anterior.estado)) throw U.error("El estado de esta reserva no permite modificar la estadía.", 409);
  const servicio = await uno(c, "SELECT s.*,ts.codigo AS tipo_codigo FROM servicio s JOIN tipo_servicio ts ON ts.id=s.tipo_servicio_id WHERE s.id=? AND s.codigo IN (?) AND s.activo=1 AND s.estado_aprobacion='APROBADO' FOR UPDATE", [U.id(b.servicio_id), codigos]);
  if (!servicio) throw U.error("El servicio no está asignado a este predio.", 403);
  const tipo = U.opcion(b.tipo || "GENERAL", tipos),
    inicio = fecha(b.fecha_inicio),
    fin = fecha(b.fecha_fin);
  if (fin < inicio || tipo === "GENERAL" && fin === inicio || fin > U.sumarDias(inicio, 366)) throw U.error("Revisá las fechas de la estadía (hasta un año).");
  const hasta = fin === inicio ? U.sumarDias(inicio, 1) : fin;
  const recursoId = U.id(b.recurso_id, "El recurso", tipo === "GENERAL"),
    regimenId = U.id(b.regimen_id, "El régimen", tipo === "GENERAL" && servicio.modelo_tarifa !== "PRECIO_UNICO");
  const recurso = recursoId ? await uno(c, "SELECT * FROM recurso WHERE id=? AND servicio_id=? AND activo=1 FOR UPDATE", [recursoId, servicio.id]) : null;
  if (recursoId && !recurso) throw U.error("El recurso no pertenece al servicio.", 422);
  if (anterior?.bloque_fecha_id && (Number(anterior.recurso_id) !== recursoId || anterior.fecha_inicio !== inicio || anterior.fecha_fin !== fin)) throw U.error("Para cambiar un bloque adjudicado primero liberalo en Turismo.", 409);
  const tramos = (anterior?.tramos || []).map(x => ({
    ...x
  }));
  if (anterior && Number(anterior.recurso_id) !== Number(recursoId) && anterior.personas.some(p => p.entrada)) {
    if (!anterior.recurso_id || !recursoId || anterior.servicio_id !== servicio.id) throw U.error("Un traslado durante la estadía requiere dos recursos del mismo servicio.");
    const desde = fecha(b.traslado || U.hoy());
    if (desde < inicio || desde >= hasta || desde > U.hoy() || tramos.length && desde < tramos.at(-1).desde) throw U.error("La fecha del traslado debe estar dentro de la estadía, en orden y no ser futura.");
    if (!tramos.length) tramos.push({
      desde: inicio,
      recurso_id: anterior.recurso_id
    });
    tramos.push({
      desde,
      recurso_id: recursoId
    });
  }
  const ocupacionDesde = tramos.length ? tramos.at(-1).desde : inicio;
  if (ocupacionDesde >= hasta) throw U.error("La salida debe ser posterior al último traslado registrado.");
  if (recurso) {
    await T.bloquearYValidarDisponibilidadReserva(c, {
      servicioId: servicio.id,
      recursoId,
      fechaInicio: ocupacionDesde,
      fechaFin: hasta,
      reservaIdExcluir: anterior?.id
    });
    const bloque = await uno(c, `SELECT bf.id FROM bloque_fecha bf JOIN bloque_fecha_recurso br ON br.bloque_fecha_id=bf.id
      WHERE br.recurso_id=? AND bf.estado='ACTIVO' AND bf.fecha_inicio<? AND bf.fecha_fin>? AND (br.reserva_id IS NULL OR br.reserva_id<>?) AND bf.id<>? LIMIT 1 FOR UPDATE`, [recursoId, hasta, ocupacionDesde, anterior?.id || 0, anterior?.bloque_fecha_id || 0]);
    if (bloque) throw U.error("El recurso está reservado para un bloque de Turismo en esas fechas.", 409);
  }
  let titular;
  if (anterior) {
    titular = await uno(c, `SELECT ${personaCols},u.departamental_id, (u.rol_id=2 AND u.habilitado='Y') AS afiliado FROM usuario u WHERE u.id=?`, [anterior.usuario_id]);
  } else {
    const d = String(b.titular_dni || "");
    if (!/^\d{6,10}$/.test(d)) throw U.error("Ingresá el DNI del titular.");
    titular = (await familia(c, d, predio.id)).titular;
    if (!titular) {
      if (!b.particular) throw U.error("Buscá el afiliado por DNI o elegí registrar un particular.");
      const p = b.particular,
        nom = U.texto(p.nombre, {
          requerido: true,
          max: 70
        }),
        ape = U.texto(p.apellido, {
          requerido: true,
          max: 70
        }),
        nac = fecha(p.fecha_nacimiento);
      if (await uno(c, "SELECT id FROM usuario WHERE documento=?", [d])) throw U.error("Ya hay una ficha con ese DNI. Revisá los datos del titular.", 409);
      const [res] = await c.query("INSERT INTO usuario (rol_id,tipo_persona_id,parentesco_id,documento,nombre,apellido,fecha_nacimiento,password,habilitado,modulo_turismo,modulo_coseguro,modulo_olimpiadas) VALUES (4,4,1,?,?,?,?,NULL,'N',0,0,0)", [d, nom, ape, nac]);
      await c.query("INSERT INTO recepcion_particular(usuario_id,predio_id) VALUES(?,?)", [res.insertId, predio.id]);
      titular = {
        id: res.insertId,
        dni: d,
        nombre: nom,
        apellido: ape,
        departamental_id: null,
        afiliado: 0
      };
    }
  }
  const viajeros = b.personas;
  if (!Array.isArray(viajeros) || !viajeros.length || viajeros.length > 100) throw U.error("Indicá entre uno y cien pasajeros identificados.");
  const grupo = await T.obtenerUsuarioPrincipalFamilia(c, titular.id);
  const existentesParticular = Number(titular.afiliado) ? null : new Set((await todos(c, "SELECT documento FROM usuario WHERE documento IN (?)", [viajeros.map(p => String(p.dni))])).map(x => String(x.documento)));
  const personas = await T.crearOBuscarUsuariosReserva(c, viajeros.map(p => ({
    dni: p.dni,
    nombre: p.nombre,
    apellido: p.apellido,
    fecha_nacimiento: p.fecha_nacimiento,
    parentesco_id: p.parentesco_id || 5,
    tipo_persona_id: !Number(titular.afiliado) && p.tipo_persona_id !== 5 ? 4 : p.tipo_persona_id
  })), {
    ...grupo,
    usuarioModificadorId: actorId,
    fechaIngreso: inicio,
    req
  });
  for (let i = 0; i < personas.length; i++) {
    const a = personas[i],
      p = viajeros[i];
    if (existentesParticular && !existentesParticular.has(String(a.dni))) await c.query("UPDATE usuario SET habilitado=\'N\',modulo_turismo=0,modulo_coseguro=0,modulo_olimpiadas=0 WHERE id=? AND password IS NULL AND rol_id=4", [a.usuario_id]);
    a.entrada = U.fecha(p.entrada);
    a.salida = U.fecha(p.salida);
    if (a.entrada && (a.entrada < inicio || a.entrada > fin || a.entrada > U.hoy()) || a.salida && (!a.entrada || a.salida < a.entrada || a.salida > fin || a.salida > U.hoy())) throw U.error("Revisá el ingreso y la salida de " + nombre(a) + ": deben estar dentro de la estadía y no ser futuros.");
  }
  if ((anterior?.personas || []).some(p => p.entrada && !personas.some(x => String(x.dni) === String(p.dni)))) throw U.error("Conservá a quienes ya ingresaron y registrá su salida.");
  const cantidad = tipo === "CONTINGENTE" ? U.id(b.cantidad, "La cantidad total del contingente") : personas.length;
  if (cantidad < personas.length || cantidad > 10000) throw U.error("La cantidad total debe incluir a las personas identificadas (máximo 10.000).");
  if (tipo === "GENERAL" && recurso?.cupo_maximo && servicio.tipo_codigo !== "CUPO_NUMERADO" && cantidad > Number(recurso.cupo_maximo)) throw U.error("La cantidad supera la capacidad del recurso.");
  if (tipo === "GENERAL" && servicio.max_personas_reserva && cantidad > servicio.max_personas_reserva) throw U.error("La cantidad supera el máximo del servicio.");
  const entidad = tipo === "CONTINGENTE" ? U.texto(b.entidad, {
    max: 120
  }) : null;
  const vehiculo = {};
  for (const k of ["marca", "color", "patente", "sector"]) vehiculo[k] = U.texto(b.vehiculo?.[k], {
    max: 50
  });
  if (Object.values(vehiculo).some(Boolean) && Object.values(vehiculo).some(v => !v)) throw U.error("Completá marca, color, patente y sector, o dejalos vacíos si no hay vehículo.");
  const ad = b.adicionales || [];
  if (!Array.isArray(ad) || ad.length > 50 || new Set(ad.map(x => Number(x.adicional_id))).size !== ad.length || tipo !== "GENERAL" && ad.length) throw U.error("Revisá los adicionales.");
  const temporada = anterior?.bloque_fecha_id ? (await uno(c, "SELECT temporada_tarifa_id FROM bloque_fecha WHERE id=?", [anterior.bloque_fecha_id]))?.temporada_tarifa_id : null;
  const cot = await cotizar(c, T, {
    tipo,
    servicio,
    recursoId,
    regimenId,
    personas,
    inicio,
    fin,
    adicionales: ad,
    tramos,
    temporada,
    departamentalId: titular.departamental_id
  });
  const descuentos = await T.aplicarDescuentosReserva(c, {
    cabecera: {
      rol: "predio"
    },
    servicioId: servicio.id,
    usuarioTitular: titular,
    tarifaBase: cot,
    adicionalesTotal: cot.extras.total,
    reservaId: anterior?.id
  });
  const automatico = Math.max(0, Math.round(cot.total + cot.extras.total - Number(descuentos.total_descuento || 0)));
  const manual = b.manual == null || b.manual === "" ? null : dinero(b.manual);
  const motivo = U.texto(b.motivo, {
    max: 255
  });
  if (tipo !== "GENERAL" && manual === null) throw U.error("Indicá el precio acordado. Puede ser cero.");
  if (tipo === "GENERAL" && manual !== null && manual !== automatico && !motivo && (anterior?.manual == null || Number(anterior.manual) !== manual)) throw U.error("Justificá el cambio de precio en la observación.");
  const total = manual ?? automatico,
    diferencia = U.redondear(total - Number(anterior?.precio_total || 0));
  if (previa) return {
    automatico,
    total,
    diferencia,
    personas: cot.personas.map(p => ({
      dni: p.dni,
      nombre: nombre(p),
      precio: p.tarifa_individual
    })),
    adicionales: cot.extras.total,
    descuentos: descuentos.total_descuento
  };
  let id = anterior?.id,
    parcela = null;
  if (recurso && servicio.tipo_codigo === "CUPO_NUMERADO") {
    if (anterior?.numero_parcela && anterior.recurso_id === recursoId) {
      parcela = anterior.numero_parcela;
      await T.validarNumeroParcelaCampingExistente(c, {
        reservaId: id,
        recursoId,
        fechaInicio: ocupacionDesde,
        fechaFin: hasta,
        numeroParcela: parcela
      });
    } else parcela = await T.asignarNumeroParcelaCamping(c, {
      recursoId,
      fechaInicio: ocupacionDesde,
      fechaFin: hasta,
      reservaIdExcluir: id
    });
  }
  const obs = U.texto(b.observaciones, {
    max: 250
  });
  const args = [servicio.id, recursoId, regimenId, parcela, inicio, hasta, total, cot.extras.total, descuentos.total_descuento || 0, obs];
  if (id) {
    await T.archivarVersionReservaAntesDeReemplazo(c, id, {
      id: actorId,
      rol: "predio"
    });
    await c.query("UPDATE reserva SET servicio_id=?,recurso_id=?,regimen_id=?,numero_parcela=?,fecha_inicio=?,fecha_fin=?,precio_total=?,monto_adicionales=?,monto_descuentos=?,observaciones=?,fecha_modificacion=NOW() WHERE id=?", [...args, id]);
    await c.query("DELETE rft FROM reserva_familiar_tarifa rft JOIN reserva_familiar rf ON rf.id=rft.reserva_familiar_id WHERE rf.reserva_id=?", [id]);
    await c.query("DELETE FROM reserva_familiar WHERE reserva_id=?", [id]);
    await c.query("DELETE FROM reserva_adicional WHERE reserva_id=?", [id]);
  } else {
    const [r] = await c.query("INSERT INTO reserva (servicio_id,recurso_id,regimen_id,numero_parcela,fecha_inicio,fecha_fin,precio_total,monto_adicionales,monto_descuentos,observaciones,estado_reserva_id,modalidad,usuario_id,creado_por_usuario_id) VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT id FROM estado_reserva WHERE nombre='Aprobada'),'FECHA_LIBRE',?,?)", [...args, titular.id, actorId]);
    id = r.insertId;
  }
  for (const p of cot.personas) {
    const [r] = await c.query("INSERT INTO reserva_familiar(reserva_id,usuario_id,tipo_persona_id,parentesco_id,edad,precio) VALUES(?,?,?,?,?,?)", [id, p.usuario_id, p.tipo_persona_id, p.parentesco_id, p.edad, p.tarifa_individual]);
    if (p.tarifas_por_fecha.length) await T.insertarTarifasFamiliaresCalculadas(c, [{
      ...p,
      reserva_familiar_id: r.insertId
    }]);
  }
  await T.guardarAdicionalesReserva(c, id, cot.extras.items);
  if (descuentos.total_descuento || anterior) await T.guardarReservaDescuentos(c, {
    reservaId: id,
    usuarioId: titular.id,
    departamentalId: titular.departamental_id,
    servicioId: servicio.id,
    resultado: descuentos,
    actorId,
    req,
    registrarHistorialReserva: async () => {}
  });
  if (anterior && ["Iniciada", "Verificada"].includes(anterior.estado) && personas.some(p => p.entrada)) await c.query("UPDATE reserva SET estado_reserva_id=(SELECT id FROM estado_reserva WHERE nombre='Aprobada') WHERE id=?", [id]);
  const actual = await detalle(c, codigos, id);
  Object.assign(actual, {
    fecha_fin: fin,
    dia_sin_noche: fin === inicio,
    tipo,
    cantidad,
    entidad,
    vehiculo,
    tramos,
    manual,
    automatico,
    diferencia
  });
  for (const p of actual.personas) {
    const a = personas.find(x => String(x.dni) === String(p.dni));
    p.entrada = a.entrada;
    p.salida = a.salida;
  }
  const cambios = resumenCambios(anterior, actual);
  actual.cambios = cambios;
  actual.huella_local = U.sha256(JSON.stringify([actor.id, b]));
  const nota = ("Operación atípica · " + predio.nombre + " · " + actor.nombre + (motivo ? " · " + motivo : "")).slice(0, 500);
  for (const [k, a, n] of cambios.length ? cambios : [["Recepción", null, "Actualización"]]) await c.query("INSERT INTO historial_reserva(reserva_id,tipo_operacion,campo_modificado,valor_anterior,valor_nuevo,usuario_modificador_id,observaciones) VALUES(?,?,?,?,?,?,?)", [id, anterior ? "UPDATE" : "CREATE", k, a == null ? null : String(a), n == null ? null : String(n), actorId, nota]);
  const [evento] = await c.query("INSERT INTO recepcion_reserva_evento(predio_id,reserva_id,operacion,huella,actor,empleado_id,anterior,actual,motivo) VALUES(?,?,?,?,?,?,?,?,?)", [predio.id, id, operacion, huella, actor.nombre, actor.id || null, anterior ? JSON.stringify(anterior) : null, JSON.stringify(actual), motivo]);
  actual.evento_id = Number(evento.insertId);
  if (anterior) await T.cerrarGuardiaArchivoReserva(c, id);
  return actual;
}
async function operar(c, predio, actor, accion, b) {
  if (!actor || actor.rol !== "ADMIN" && !Number(actor.gestionar_reservas)) throw U.error("No tenés permiso de recepción.", 403);
  const codigos = serviciosDe(predio);
  if (!codigos.length) throw U.error("Este predio no tiene servicios asignados.", 403);
  try {
    if (accion === "opciones") return opciones(c, codigos);
    if (accion === "familia") return familia(c, b.q, predio.id);
    if (accion === "listar") return listar(c, codigos, {
      ...b,
      predioId: predio.id
    });
    if (accion === "detalle") {
      const r = await detalle(c, codigos, U.id(b.id));
      const eventos = await todos(c, "SELECT fecha,actor,anterior,actual,motivo FROM recepcion_reserva_evento WHERE reserva_id=? ORDER BY id DESC", [r.id]);
      return {
        reserva: r,
        historial: eventos.map(e => ({
          fecha: e.fecha,
          actor: e.actor,
          motivo: e.motivo,
          cambios: resumenCambios(JSON.parse(e.anterior), JSON.parse(e.actual))
        }))
      };
    }
    if (accion === "cotizar") {
      await c.query("SAVEPOINT recepcion_previa");
      try {
        return await guardar(c, predio, actor, b, codigos, true);
      } finally {
        await c.query("ROLLBACK TO SAVEPOINT recepcion_previa");
        await c.query("RELEASE SAVEPOINT recepcion_previa");
      }
    }
    if (accion === "guardar") return await guardar(c, predio, actor, b, codigos, false);
    throw U.error("Operación de recepción desconocida.", 404);
  } catch (e) {
    if (e.statusCode) throw U.error(e.message, e.statusCode);
    throw e;
  }
}
module.exports = {
  operar,
  detalle,
  resumenCambios,
  cotizar
};
