const { obtenerEstadoRecursoTrasLiberacion } = require("./sorteos-vigencia");
const { crearNotificacion } = require("./notificaciones");
const { normalizarFechaCivil } = require("./valores-dominio");

const PLAZO_RESPUESTA_HORAS = 72;
const ESTADO_INICIADA = "Iniciada";
const ESTADO_VERIFICADA = "Verificada";
const ESTADO_APROBADA = "Aprobada";
const ESTADO_RECHAZADA = "Rechazada";
const ESTADO_CANCELADA = "Cancelada";
const ESTADO_PROPUESTA_CONVENIO = "Propuesta convenio";
const ESTADO_CONVENIO_RECHAZADO = "Convenio rechazado";
// Id 15 (migrar-firma-condiciones-reserva.js): la carga del staff espera que la
// persona afiliada la firme desde Mi AJB. El código la busca por nombre.
const ESTADO_PENDIENTE_FIRMA = "Pendiente de firma";
// Lo que la persona afiliada puede cancelar desde la app. El staff da de baja
// lo mismo a su pedido, y además una reserva que todavía espera la firma.
const ESTADOS_CANCELABLES_AFILIADO = new Set(["iniciada", "verificada", "aprobada", "pendiente_aprobacion_titular"]);
const ESTADOS_CANCELABLES_A_PEDIDO = new Set([...ESTADOS_CANCELABLES_AFILIADO, normalizarEstado(ESTADO_PENDIENTE_FIRMA)]);
// Cómo pidió la persona afiliada la baja que carga el staff.
const CANALES_PEDIDO_CANCELACION = Object.freeze(["PRESENCIAL", "TELEFONO", "ESCRITO"]);
const ORIGEN_CANCELACION_AFILIADO = "AFILIADO";
const ORIGEN_CANCELACION_STAFF_A_PEDIDO = "STAFF_A_PEDIDO";
const REGLA_CANCELACION_POLITICA = "POLITICA";
const REGLA_CANCELACION_SIN_FIRMA = "SIN_FIRMA";
const MODALIDAD_FECHA_LIBRE = "FECHA_LIBRE";
const MODALIDADES_TURISMO_REGULAR = new Set([MODALIDAD_FECHA_LIBRE, "BLOQUE"]);
const FILTRO_SQL_MODALIDAD_TURISMO_REGULAR = `(
  r.modalidad IN ('FECHA_LIBRE', 'BLOQUE')
  OR r.modalidad IS NULL
  OR TRIM(CAST(r.modalidad AS CHAR)) = ''
)`;
const LOCK_EXPIRACION = "ajb:reservas:expiracion-72h:v1";

function normalizarRol(valor) {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

function normalizarEstado(valor) {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

function esEstadoPendienteFirma(estado) {
  return normalizarEstado(estado) === normalizarEstado(ESTADO_PENDIENTE_FIRMA);
}

function normalizarModalidadTurismo(modalidad) {
  if (modalidad === null || modalidad === undefined) return MODALIDAD_FECHA_LIBRE;
  if (typeof modalidad !== "string") return "";
  const normalizada = modalidad.trim().toUpperCase();
  return normalizada || MODALIDAD_FECHA_LIBRE;
}

function esModalidadTurismoRegular(modalidad) {
  return MODALIDADES_TURISMO_REGULAR.has(normalizarModalidadTurismo(modalidad));
}

function obtenerEstadoAltaTurismo(rol) {
  return normalizarRol(rol) === "departamental" ? ESTADO_VERIFICADA : ESTADO_INICIADA;
}

/**
 * Valida el flujo de estados de las reservas regulares de turismo.
 *
 * "Cancelada" es la baja que pide la persona afiliada: la confirma ella desde
 * la app sobre su reserva activa, o la carga el staff (admin o departamental)
 * a su pedido (aPedidoAfiliado, con el canal por el que lo pidió). El resultado
 * es el mismo en los dos casos: misma política, mismo cálculo y mismas
 * liberaciones. Una reserva que todavía espera la firma se da de baja sin
 * penalidad (regla SIN_FIRMA) y sólo por el staff: la persona afiliada la
 * rechaza desde la pantalla de firma.
 *
 * "Rechazada" es la baja que decide Turismo. La departamental rechaza las
 * Iniciadas y también sus propias cargas ya Verificadas
 * (cargaPropiaDepartamental: un error de carga no se disfraza de pedido).
 */
function validarTransicionTurismo({
  rol,
  usuarioId,
  propietarioId,
  estadoActual,
  estadoSolicitado,
  modalidad,
  aPedidoAfiliado = false,
  cargaPropiaDepartamental = false,
}) {
  const rolNormalizado = normalizarRol(rol);
  const actual = normalizarEstado(estadoActual);
  const solicitado = normalizarEstado(estadoSolicitado);
  const esCancelacion = solicitado === "cancelada";
  const destino = esCancelacion ? normalizarEstado(ESTADO_CANCELADA) : solicitado;
  const esPropietario = Number(usuarioId) > 0 && Number(usuarioId) === Number(propietarioId);

  if (!esModalidadTurismoRegular(modalidad)) {
    return {
      valido: false,
      statusCode: 409,
      codigo: "FLUJO_RESERVA_ESPECIAL",
      mensaje: "Esta reserva debe gestionarse desde su flujo especifico",
    };
  }

  if (!["admin", "departamental", "afiliado"].includes(rolNormalizado)) {
    return { valido: false, statusCode: 403, codigo: "ROL_NO_AUTORIZADO", mensaje: "No autorizado" };
  }

  if (destino === normalizarEstado(ESTADO_VERIFICADA)) {
    if (!["admin", "departamental"].includes(rolNormalizado)) {
      return {
        valido: false,
        statusCode: 403,
        codigo: "TRANSICION_NO_AUTORIZADA",
        mensaje: "Solo Turismo puede verificar una reserva",
      };
    }
    if (actual !== normalizarEstado(ESTADO_INICIADA)) {
      return {
        valido: false,
        statusCode: 409,
        codigo: "TRANSICION_INVALIDA",
        mensaje: "Solo se pueden verificar reservas iniciadas",
      };
    }
    return { valido: true, estadoDestino: ESTADO_VERIFICADA, accion: "VERIFICAR" };
  }

  if (destino === normalizarEstado(ESTADO_APROBADA)) {
    if (rolNormalizado !== "admin") {
      return {
        valido: false,
        statusCode: 403,
        codigo: "TRANSICION_NO_AUTORIZADA",
        mensaje: "Solo un administrador puede aprobar una reserva verificada",
      };
    }
    if (actual !== normalizarEstado(ESTADO_VERIFICADA)) {
      return {
        valido: false,
        statusCode: 409,
        codigo: "TRANSICION_INVALIDA",
        mensaje: "Solo se pueden aprobar reservas verificadas",
      };
    }
    return { valido: true, estadoDestino: ESTADO_APROBADA, accion: "APROBAR" };
  }

  if (esCancelacion) {
    if (rolNormalizado === "afiliado") {
      // Una reserva que espera la firma no se cancela por acá: se rechaza desde
      // la pantalla de firma («No la quiero»).
      if (!esPropietario || !ESTADOS_CANCELABLES_AFILIADO.has(actual)) {
        return {
          valido: false,
          statusCode: 403,
          codigo: "TRANSICION_NO_AUTORIZADA",
          mensaje: "Solo puedes cancelar una reserva propia que esté activa",
        };
      }
      return {
        valido: true,
        estadoDestino: ESTADO_CANCELADA,
        accion: "CANCELAR",
        origen: ORIGEN_CANCELACION_AFILIADO,
        regla: REGLA_CANCELACION_POLITICA,
      };
    }
    // Turismo no cancela por su cuenta: para eso está «Rechazar».
    if (!aPedidoAfiliado) {
      return {
        valido: false,
        statusCode: 400,
        codigo: "CANCELACION_SIN_PEDIDO",
        mensaje: "Turismo sólo cancela a pedido de la persona afiliada. Indicá cómo te lo pidió",
      };
    }
    if (!ESTADOS_CANCELABLES_A_PEDIDO.has(actual)) {
      return {
        valido: false,
        statusCode: 409,
        codigo: "TRANSICION_INVALIDA",
        mensaje: "La reserva no se puede cancelar desde su estado actual",
      };
    }
    return {
      valido: true,
      estadoDestino: ESTADO_CANCELADA,
      accion: "CANCELAR_A_PEDIDO",
      origen: ORIGEN_CANCELACION_STAFF_A_PEDIDO,
      regla: esEstadoPendienteFirma(actual) ? REGLA_CANCELACION_SIN_FIRMA : REGLA_CANCELACION_POLITICA,
    };
  }

  if (destino === normalizarEstado(ESTADO_RECHAZADA)) {
    if (rolNormalizado === "afiliado") {
      return {
        valido: false,
        statusCode: 403,
        codigo: "TRANSICION_NO_AUTORIZADA",
        mensaje: "Solo puedes cancelar una reserva propia que esté activa",
      };
    }
    if (actual === normalizarEstado(ESTADO_VERIFICADA) && rolNormalizado !== "admin" && !cargaPropiaDepartamental) {
      return {
        valido: false,
        statusCode: 403,
        codigo: "TRANSICION_NO_AUTORIZADA",
        mensaje: "Solo un administrador puede rechazar una reserva verificada",
      };
    }
    if (rolNormalizado === "departamental" && ![
      normalizarEstado(ESTADO_INICIADA),
      normalizarEstado(ESTADO_VERIFICADA),
    ].includes(actual)) {
      return {
        valido: false,
        statusCode: 403,
        codigo: "TRANSICION_NO_AUTORIZADA",
        mensaje: "La departamental solo puede rechazar reservas iniciadas o sus propias cargas verificadas",
      };
    }
    if (rolNormalizado === "admin" && ![
      normalizarEstado(ESTADO_INICIADA),
      normalizarEstado(ESTADO_VERIFICADA),
      normalizarEstado(ESTADO_APROBADA),
    ].includes(actual)) {
      return {
        valido: false,
        statusCode: 409,
        codigo: "TRANSICION_INVALIDA",
        mensaje: "La reserva no admite rechazo desde su estado actual",
      };
    }

    return { valido: true, estadoDestino: ESTADO_RECHAZADA, accion: "RECHAZAR" };
  }

  return {
    valido: false,
    statusCode: 400,
    codigo: "ESTADO_INVALIDO",
    mensaje: "Estado no valido. Usa Verificada, Aprobada, Rechazada o Cancelada",
  };
}

/**
 * La reserva es una carga de la departamental del actor: la creó alguien con
 * rol departamental de esa misma departamental (no la persona afiliada).
 * `creador` = { rol, departamental_id } de reserva.creado_por_usuario_id.
 */
function esCargaPropiaDepartamental({ creador, departamentalActorId }) {
  const departamentalCreador = Number(creador?.departamental_id);
  return normalizarRol(creador?.rol) === "departamental"
    && Number.isSafeInteger(departamentalCreador) && departamentalCreador > 0
    && departamentalCreador === Number(departamentalActorId);
}

/**
 * Misma regla que PUT /reserva/:id/estado para el staff, para que el detalle
 * muestre «Cancelar a pedido de la persona afiliada» sólo cuando el backend la
 * va a aceptar. La jurisdicción de la departamental se controla aparte.
 */
function puedeCancelarAPedido({ rol, estado, modalidad, fechaInicio, hoy }) {
  if (!["admin", "departamental"].includes(normalizarRol(rol))) return false;
  const transicion = validarTransicionTurismo({
    rol,
    estadoActual: estado,
    estadoSolicitado: ESTADO_CANCELADA,
    modalidad,
    aPedidoAfiliado: true,
  });
  if (!transicion.valido) return false;
  // Sin firma no hay nada que cobrar: se da de baja aunque haya pasado el ingreso.
  if (transicion.regla === REGLA_CANCELACION_SIN_FIRMA) return true;
  const inicio = normalizarFechaCivil(typeof fechaInicio === "string" ? fechaInicio.slice(0, 10) : fechaInicio);
  const fechaHoy = normalizarFechaCivil(hoy);
  return Boolean(inicio && fechaHoy && inicio >= fechaHoy);
}

function mapearReservaIniciada(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    numero_reserva: String(row.id),
    estado: row.estado || ESTADO_INICIADA,
    modalidad: normalizarModalidadTurismo(row.modalidad),
    servicio: row.servicio || null,
    recurso: row.recurso || null,
    fecha_inicio: row.fecha_inicio || null,
    fecha_fin: row.fecha_fin || null,
    fecha_creacion: row.fecha_creacion || null,
  };
}

async function obtenerEstadosReserva(connection, nombres) {
  const unicos = [...new Set(nombres)];
  const [rows] = await connection.query(
    "SELECT id, nombre FROM estado_reserva WHERE nombre IN (?)",
    [unicos]
  );
  const mapa = new Map(rows.map((row) => [row.nombre, Number(row.id)]));
  for (const nombre of unicos) {
    if (!mapa.has(nombre)) {
      const error = new Error(`No existe el estado de reserva requerido: ${nombre}`);
      error.code = "ESTADO_RESERVA_FALTANTE";
      throw error;
    }
  }
  return mapa;
}

async function insertarHistorialAutomatico(connection, {
  reservaId,
  campo,
  valorAnterior,
  valorNuevo,
  observaciones,
}) {
  await connection.query(
    `INSERT INTO historial_reserva
      (reserva_id, tipo_operacion, campo_modificado, valor_anterior, valor_nuevo,
       usuario_modificador_id, observaciones)
     VALUES (?, 'UPDATE', ?, ?, ?, NULL, ?)`,
    [reservaId, campo, valorAnterior, valorNuevo, observaciones]
  );
}

async function insertarNotificacion(connection, usuarioId, tipo, titulo, mensaje, payload) {
  return crearNotificacion(connection, { usuarioId, tipo, titulo, mensaje, payload });
}

async function liberarRecursoBloque(connection, reservaId) {
  const [recursos] = await connection.query(
    `SELECT bfr.bloque_fecha_id,
            bfr.recurso_id,
            bf.modalidad,
            bf.estado AS bloque_estado,
            s.estado AS sorteo_estado
       FROM bloque_fecha_recurso bfr
       INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
       LEFT JOIN sorteo s ON s.id = bf.sorteo_id
      WHERE bfr.reserva_id = ?
      FOR UPDATE`,
    [reservaId]
  );

  for (const recurso of recursos) {
    const estado = obtenerEstadoRecursoTrasLiberacion({
      modalidad: recurso.modalidad,
      estadoBloque: recurso.bloque_estado,
      estadoSorteo: recurso.sorteo_estado,
    });
    await connection.query(
      `UPDATE bloque_fecha_recurso
          SET estado = ?, reserva_id = NULL
        WHERE bloque_fecha_id = ?
          AND recurso_id = ?
          AND reserva_id = ?`,
      [estado, recurso.bloque_fecha_id, recurso.recurso_id, reservaId]
    );
  }
}

async function expirarReservaTurismoEnTransaccion(connection, reserva, estadoRechazadaId) {
  const [resultado] = await connection.query(
    `UPDATE reserva
        SET estado_reserva_id = ?, fecha_modificacion = NOW()
      WHERE id = ? AND estado_reserva_id = ?`,
    [estadoRechazadaId, reserva.id, reserva.estado_reserva_id]
  );
  if (resultado.affectedRows !== 1) return false;

  await liberarRecursoBloque(connection, reserva.id);
  const motivo = "La reserva fue rechazada automaticamente porque la departamental no respondio dentro de las 72 horas.";
  await insertarHistorialAutomatico(connection, {
    reservaId: reserva.id,
    campo: "estado_reserva_id",
    valorAnterior: reserva.estado_reserva_id,
    valorNuevo: estadoRechazadaId,
    observaciones: motivo,
  });
  await insertarNotificacion(
    connection,
    reserva.usuario_id,
    "RESERVA_RECHAZADA_SIN_RESPUESTA",
    `Reserva #${reserva.id} rechazada por falta de respuesta`,
    "Tu reserva fue rechazada porque no recibio respuesta de la departamental dentro de las 72 horas. El recurso ya fue liberado y podes iniciar una nueva reserva.",
    { reserva_id: Number(reserva.id), estado: ESTADO_RECHAZADA, motivo: "SIN_RESPUESTA_72H" }
  );
  return true;
}

async function expirarPropuestaConvenioEnTransaccion(connection, reserva, propuesta, estadoRechazadoId) {
  const [respuesta] = await connection.query(
    `UPDATE reserva_convenio_propuesta
        SET respuesta = 'RECHAZADA', fecha_respuesta = COALESCE(fecha_respuesta, NOW())
      WHERE reserva_id = ? AND respuesta = 'PENDIENTE'`,
    [reserva.id]
  );
  if (respuesta.affectedRows !== 1) return false;

  await connection.query(
    "UPDATE reserva SET estado_reserva_id = ?, fecha_modificacion = NOW() WHERE id = ?",
    [estadoRechazadoId, reserva.id]
  );
  await connection.query(
    `UPDATE notificacion
        SET leida = 1, fecha_lectura = COALESCE(fecha_lectura, NOW())
      WHERE usuario_id = ?
        AND tipo = 'CONVENIO_PROPUESTA'
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reserva_id')) = ?`,
    [reserva.usuario_id, String(reserva.id)]
  );

  const motivo = "La propuesta de cotizacion fue rechazada automaticamente porque no se respondio dentro de las 72 horas.";
  await insertarHistorialAutomatico(connection, {
    reservaId: reserva.id,
    campo: "reserva_convenio_propuesta.respuesta",
    valorAnterior: "PENDIENTE",
    valorNuevo: "RECHAZADA",
    observaciones: motivo,
  });
  await insertarHistorialAutomatico(connection, {
    reservaId: reserva.id,
    campo: "estado_reserva_id",
    valorAnterior: reserva.estado_reserva_id,
    valorNuevo: estadoRechazadoId,
    observaciones: motivo,
  });
  await insertarNotificacion(
    connection,
    reserva.usuario_id,
    "CONVENIO_PROPUESTA_VENCIDA",
    "Cotizacion vencida",
    "La propuesta de cotizacion vencio porque no fue respondida dentro de las 72 horas. Podes iniciar una nueva solicitud cuando quieras.",
    { reserva_id: Number(reserva.id), estado: ESTADO_CONVENIO_RECHAZADO, motivo: "SIN_RESPUESTA_72H" }
  );
  return true;
}

/**
 * Serializa por usuario el alta de reservas regulares. Tambien sanea una
 * reserva vencida que todavia no haya sido tomada por el worker periodico.
 */
async function asegurarSinReservaIniciadaAfiliado(connection, usuarioId) {
  const [usuarios] = await connection.query(
    "SELECT id FROM usuario WHERE id = ? FOR UPDATE",
    [usuarioId]
  );
  if (usuarios.length === 0) {
    const error = new Error("El afiliado no existe");
    error.statusCode = 404;
    error.codigo = "AFILIADO_NO_ENCONTRADO";
    throw error;
  }

  const estados = await obtenerEstadosReserva(connection, [ESTADO_INICIADA, ESTADO_RECHAZADA]);
  // Las 72 horas corren desde la aprobación del titular, la firma de la persona
  // afiliada o la creación: el mismo fragmento que el mantenimiento y el detalle.
  const { sqlInicioPlazoVerificacion } = require("./reservas-firma");
  const [reservas] = await connection.query(
    `SELECT r.id,
            r.usuario_id,
            r.estado_reserva_id,
            r.modalidad,
            DATE_FORMAT(r.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
            DATE_FORMAT(r.fecha_fin, '%Y-%m-%d') AS fecha_fin,
            r.fecha_creacion,
            (${sqlInicioPlazoVerificacion("r")} <= DATE_SUB(NOW(), INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR)) AS vencida
       FROM reserva r
      WHERE r.usuario_id = ?
        AND r.estado_reserva_id = ?
        AND ${FILTRO_SQL_MODALIDAD_TURISMO_REGULAR}
      ORDER BY r.fecha_creacion ASC, r.id ASC
      FOR UPDATE`,
    [usuarioId, estados.get(ESTADO_INICIADA)]
  );

  if (reservas.length === 0) return null;

  for (const reserva of reservas) {
    if (!Number(reserva.vencida)) continue;
    await expirarReservaTurismoEnTransaccion(
      connection,
      reserva,
      estados.get(ESTADO_RECHAZADA)
    );
  }

  const activa = reservas.find((reserva) => !Number(reserva.vencida));
  if (!activa) return null;

  const [detalles] = await connection.query(
    `SELECT ? AS estado,
            COALESCE(s.nombre, 'Turismo') AS servicio,
            COALESCE(rec.nombre, 'Recurso de turismo') AS recurso
       FROM reserva r
       LEFT JOIN recurso rec ON rec.id = r.recurso_id
       LEFT JOIN servicio s ON s.id = COALESCE(r.servicio_id, rec.servicio_id)
      WHERE r.id = ?
      LIMIT 1`,
    [ESTADO_INICIADA, activa.id]
  );
  return mapearReservaIniciada({ ...activa, ...(detalles[0] || {}) });
}

async function expirarPendientes72Horas(db, { limite = 100 } = {}) {
  const limiteSeguro = Number.isInteger(Number(limite))
    ? Math.max(1, Math.min(500, Number(limite)))
    : 100;
  const connection = await db.getConnection();
  let lockTomado = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK(?, 0) AS adquirido", [LOCK_EXPIRACION]);
    lockTomado = Number(locks[0]?.adquirido) === 1;
    if (!lockTomado) return { ejecutado: false, turismo: 0, convenios: 0 };

    await connection.beginTransaction();
    const estados = await obtenerEstadosReserva(connection, [
      ESTADO_INICIADA,
      ESTADO_RECHAZADA,
      ESTADO_PROPUESTA_CONVENIO,
      ESTADO_CONVENIO_RECHAZADO,
    ]);

    // Mismo inicio del plazo que el alta y el detalle: titular, firma o creación.
    const { sqlInicioPlazoVerificacion } = require("./reservas-firma");
    const [reservasTurismo] = await connection.query(
      `SELECT r.id, r.usuario_id, r.estado_reserva_id
         FROM reserva r
        WHERE r.estado_reserva_id = ?
          AND ${FILTRO_SQL_MODALIDAD_TURISMO_REGULAR}
          AND ${sqlInicioPlazoVerificacion("r")} <= DATE_SUB(NOW(), INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR)
        ORDER BY r.fecha_creacion ASC, r.id ASC
        LIMIT ${limiteSeguro}
        FOR UPDATE SKIP LOCKED`,
      [estados.get(ESTADO_INICIADA)]
    );

    let turismo = 0;
    for (const reserva of reservasTurismo) {
      if (await expirarReservaTurismoEnTransaccion(
        connection,
        reserva,
        estados.get(ESTADO_RECHAZADA)
      )) turismo += 1;
    }

    const [propuestas] = await connection.query(
      `SELECT r.id, r.usuario_id, r.estado_reserva_id, p.fecha_propuesta
         FROM reserva r
         STRAIGHT_JOIN reserva_convenio_propuesta p ON p.reserva_id = r.id
        WHERE p.respuesta = 'PENDIENTE'
          AND p.fecha_propuesta IS NOT NULL
          AND p.fecha_propuesta <= DATE_SUB(NOW(), INTERVAL ${PLAZO_RESPUESTA_HORAS} HOUR)
          AND r.estado_reserva_id = ?
        ORDER BY p.fecha_propuesta ASC, r.id ASC
        LIMIT ${limiteSeguro}
        FOR UPDATE SKIP LOCKED`,
      [estados.get(ESTADO_PROPUESTA_CONVENIO)]
    );

    let convenios = 0;
    for (const propuesta of propuestas) {
      if (await expirarPropuestaConvenioEnTransaccion(
        connection,
        propuesta,
        propuesta,
        estados.get(ESTADO_CONVENIO_RECHAZADO)
      )) convenios += 1;
    }

    await connection.commit();
    return { ejecutado: true, turismo, convenios };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // La conexion puede haberse cerrado luego del error original.
    }
    throw error;
  } finally {
    if (lockTomado) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_EXPIRACION]);
      } catch (_) {
        // El lock de sesion se libera igualmente al cerrar la conexion.
      }
    }
    connection.release();
  }
}

function iniciarMantenimientoReservas(db, {
  intervaloMs = Number(process.env.RESERVAS_EXPIRACION_INTERVALO_MS || 300000),
  demoraInicialMs = Number(process.env.RESERVAS_EXPIRACION_DEMORA_INICIAL_MS || 10000),
} = {}) {
  const intervaloSeguro = Number.isFinite(intervaloMs)
    ? Math.max(60000, Math.min(3600000, Math.trunc(intervaloMs)))
    : 300000;
  const demoraSegura = Number.isFinite(demoraInicialMs)
    ? Math.max(0, Math.min(60000, Math.trunc(demoraInicialMs)))
    : 10000;
  let ejecutando = false;

  const ejecutar = async () => {
    if (ejecutando) return;
    ejecutando = true;
    try {
      const resultado = await expirarPendientes72Horas(db);
      if (resultado.turismo || resultado.convenios) {
        console.log(
          `Mantenimiento de reservas: ${resultado.turismo} turismo y ${resultado.convenios} convenios vencidos`
        );
      }
    } catch (error) {
      console.error("Error en mantenimiento de reservas de 72 horas:", error?.code || error?.message);
    }
    // «Pendiente de firma» vencidas: bloque aparte, así un error de uno no frena
    // el otro. Sin la migración este bloque no hace nada (omitido: 'SIN_MIGRACION').
    // El de 72 h tampoco corre, porque su inicio del plazo lee reserva_firma_afiliado
    // (ER_NO_SUCH_TABLE, o ER_TABLEACCESS_DENIED_ERROR si falta el GRANT): por eso la
    // migración va antes que el backend.
    try {
      const { expirarFirmasVencidas } = require("./reservas-firma");
      const resultado = await expirarFirmasVencidas(db);
      if (resultado.firmas) {
        console.log(`Mantenimiento de reservas: ${resultado.firmas} reservas sin firmar dadas de baja`);
      }
      if (resultado.omitido) {
        // Que quede a la vista: sin la migración las firmas vencidas no se dan de baja.
        console.warn(`Vencimiento de firmas omitido: ${resultado.omitido}${resultado.codigo ? ` (${resultado.codigo})` : ""}`);
      }
    } catch (error) {
      console.error("Error en mantenimiento de firmas pendientes:", error?.code || error?.message);
    } finally {
      ejecutando = false;
    }
  };

  const inicio = setTimeout(() => {
    void ejecutar();
  }, demoraSegura);
  const intervalo = setInterval(() => {
    void ejecutar();
  }, intervaloSeguro);
  inicio.unref?.();
  intervalo.unref?.();

  return () => {
    clearTimeout(inicio);
    clearInterval(intervalo);
  };
}

module.exports = {
  CANALES_PEDIDO_CANCELACION,
  ESTADO_APROBADA,
  ESTADO_CANCELADA,
  ESTADO_CONVENIO_RECHAZADO,
  ESTADO_INICIADA,
  ESTADO_PENDIENTE_FIRMA,
  ESTADO_RECHAZADA,
  ESTADO_VERIFICADA,
  ORIGEN_CANCELACION_AFILIADO,
  ORIGEN_CANCELACION_STAFF_A_PEDIDO,
  PLAZO_RESPUESTA_HORAS,
  REGLA_CANCELACION_POLITICA,
  REGLA_CANCELACION_SIN_FIRMA,
  asegurarSinReservaIniciadaAfiliado,
  esCargaPropiaDepartamental,
  esEstadoPendienteFirma,
  esModalidadTurismoRegular,
  puedeCancelarAPedido,
  expirarPendientes72Horas,
  expirarPropuestaConvenioEnTransaccion,
  expirarReservaTurismoEnTransaccion,
  iniciarMantenimientoReservas,
  liberarRecursoBloque,
  normalizarModalidadTurismo,
  obtenerEstadoAltaTurismo,
  validarTransicionTurismo,
};
