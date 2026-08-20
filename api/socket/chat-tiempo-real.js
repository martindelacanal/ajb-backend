const MODULOS_CHAT = new Set(["turismo", "coseguro", "traslados", "olimpiadas"]);
const MAX_MENSAJES_SINCRONIZACION = 100;
const ESTADOS_COSEGURO_AUDITOR = new Set([7, 8, 9, 10]);

const CONFIGURACION_CHAT = {
    turismo: {
        entidadSql: `SELECT r.usuario_id, u.departamental_id
                     FROM reserva r
                     LEFT JOIN usuario u ON u.id = r.usuario_id
                     WHERE r.id = ?
                     LIMIT 1`,
        mensajesSql: `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje,
                             o.estado_reserva_id, o.fecha_creacion,
                             u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
                             er.nombre AS estado_nombre
                      FROM reserva_observacion o
                      LEFT JOIN usuario u ON u.id = o.usuario_id
                      LEFT JOIN estado_reserva er ON er.id = o.estado_reserva_id
                      WHERE o.reserva_id = ? AND o.id > ?
                      ORDER BY o.id ASC
                      LIMIT ${MAX_MENSAJES_SINCRONIZACION}`,
    },
    coseguro: {
        entidadSql: `SELECT usuario_id, departamental_id, estado_id
                     FROM coseguro_solicitud
                     WHERE id = ? AND eliminado = 0
                     LIMIT 1`,
        mensajesSql: `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje,
                             o.estado_id, o.fecha_creacion,
                             u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
                             e.nombre AS estado_nombre
                      FROM coseguro_observacion o
                      LEFT JOIN usuario u ON u.id = o.usuario_id
                      LEFT JOIN coseguro_estado e ON e.id = o.estado_id
                      WHERE o.solicitud_id = ? AND o.id > ?
                      ORDER BY o.id ASC
                      LIMIT ${MAX_MENSAJES_SINCRONIZACION}`,
    },
    traslados: {
        entidadSql: `SELECT usuario_id, departamental_origen_id, departamental_destino_id
                     FROM traslado_solicitud
                     WHERE id = ? AND eliminado = 0
                     LIMIT 1`,
        mensajesSql: `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje,
                             o.estado_id, o.fecha_creacion,
                             u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
                             e.nombre AS estado_nombre
                      FROM traslado_observacion o
                      LEFT JOIN usuario u ON u.id = o.usuario_id
                      LEFT JOIN traslado_estado e ON e.id = o.estado_id
                      WHERE o.solicitud_id = ? AND o.id > ?
                      ORDER BY o.id ASC
                      LIMIT ${MAX_MENSAJES_SINCRONIZACION}`,
    },
    olimpiadas: {
        entidadSql: `SELECT usuario_id, departamental_id
                     FROM olimpiada_inscripcion
                     WHERE id = ? AND eliminado = 0
                     LIMIT 1`,
        mensajesSql: `SELECT o.id, o.usuario_id, o.usuario_rol, o.mensaje,
                             o.fecha_creacion,
                             u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
                             NULL AS estado_nombre
                      FROM olimpiada_inscripcion_observacion o
                      LEFT JOIN usuario u ON u.id = o.usuario_id
                      WHERE o.inscripcion_id = ? AND o.id > ?
                      ORDER BY o.id ASC
                      LIMIT ${MAX_MENSAJES_SINCRONIZACION}`,
    },
};

function callbackSeguro(callback) {
    return typeof callback === "function" ? callback : () => { };
}

function normalizarId(valor, permitirCero = false) {
    if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) {
        return null;
    }
    const numero = Number(valor);
    if (!Number.isSafeInteger(numero) || numero < (permitirCero ? 0 : 1)) {
        return null;
    }
    return numero;
}

function normalizarConversacion(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
    }

    const modulo = String(payload.modulo || "").trim().toLowerCase();
    const entidadId = normalizarId(payload.entidad_id ?? payload.entidadId);
    const desdeId = normalizarId(payload.desde_id ?? payload.desdeId ?? 0, true);
    if (!MODULOS_CHAT.has(modulo) || entidadId === null || desdeId === null) {
        return null;
    }

    return { modulo, entidadId, desdeId };
}

function crearSalaChat(conversacion) {
    return `chat:${conversacion.modulo}:${conversacion.entidadId}`;
}

function idsIguales(a, b) {
    const primero = normalizarId(a);
    const segundo = normalizarId(b);
    return primero !== null && segundo !== null && primero === segundo;
}

function areaHabilitada(auth, campo) {
    if (!["departamental", "admin-central"].includes(auth.rol)) {
        return true;
    }
    const valor = auth[campo];
    return valor === undefined || valor === null || Number(valor) === 1;
}

function moduloHabilitado(auth, campo) {
    if (auth.rol !== "afiliado") return true;
    const valor = auth[campo];
    return valor === undefined || valor === null || Number(valor) === 1;
}

async function obtenerAutorizacionActualChat(db, auth) {
    const usuarioId = normalizarId(auth?.id);
    if (usuarioId === null) return null;

    const [usuarios] = await db.query(
        `SELECT u.id, u.documento, u.departamental_id, u.area_turismo, u.area_coseguro,
                u.modulo_turismo, u.modulo_coseguro, u.modulo_olimpiadas,
                r.nombre AS rol
           FROM usuario u
           INNER JOIN rol r ON r.id = u.rol_id
          WHERE u.id = ? AND u.habilitado = 'Y'
          LIMIT 1`,
        [usuarioId]
    );
    if (!Array.isArray(usuarios) || usuarios.length !== 1) return null;

    const usuario = usuarios[0];
    return {
        id: Number(usuario.id),
        documento: String(usuario.documento),
        rol: String(usuario.rol || "").trim().toLowerCase(),
        departamentalId: usuario.departamental_id == null
            ? null
            : Number(usuario.departamental_id),
        area_turismo: usuario.area_turismo,
        area_coseguro: usuario.area_coseguro,
        modulo_turismo: usuario.modulo_turismo,
        modulo_coseguro: usuario.modulo_coseguro,
        modulo_olimpiadas: usuario.modulo_olimpiadas,
    };
}

function puedeAccederSegunEntidad(auth, conversacion, entidad) {
    switch (conversacion.modulo) {
        case "turismo":
            if (!moduloHabilitado(auth, "modulo_turismo")) return false;
            if (auth.rol === "admin") return true;
            if (auth.rol === "afiliado") return idsIguales(entidad.usuario_id, auth.id);
            return auth.rol === "departamental"
                && areaHabilitada(auth, "area_turismo")
                && idsIguales(entidad.departamental_id, auth.departamentalId);
        case "coseguro":
            if (!moduloHabilitado(auth, "modulo_coseguro")) return false;
            if (!areaHabilitada(auth, "area_coseguro")) return false;
            if (["admin", "admin-central"].includes(auth.rol)) return true;
            if (auth.rol === "auditor") return ESTADOS_COSEGURO_AUDITOR.has(Number(entidad.estado_id));
            if (auth.rol === "departamental") return idsIguales(entidad.departamental_id, auth.departamentalId);
            return auth.rol === "afiliado" && idsIguales(entidad.usuario_id, auth.id);
        case "traslados":
            return auth.rol === "admin";
        case "olimpiadas":
            if (!moduloHabilitado(auth, "modulo_olimpiadas")) return false;
            if (auth.rol === "admin") return true;
            if (auth.rol === "departamental") return idsIguales(entidad.departamental_id, auth.departamentalId);
            return auth.rol === "afiliado" && idsIguales(entidad.usuario_id, auth.id);
        default:
            return false;
    }
}

async function puedeAccederConversacion(db, auth, conversacion) {
    const configuracion = CONFIGURACION_CHAT[conversacion.modulo];
    if (!configuracion || !auth) return false;

    const [filas] = await db.query(configuracion.entidadSql, [conversacion.entidadId]);
    if (!Array.isArray(filas) || filas.length !== 1) return false;
    return puedeAccederSegunEntidad(auth, conversacion, filas[0]);
}

function normalizarMensajePersistido(fila) {
    const id = normalizarId(fila?.id);
    if (id === null) return null;
    return {
        id,
        usuario_id: normalizarId(fila.usuario_id),
        usuario_rol: fila.usuario_rol == null ? null : String(fila.usuario_rol),
        mensaje: String(fila.mensaje || ""),
        fecha_creacion: fila.fecha_creacion,
        usuario_nombre: fila.usuario_nombre == null ? null : String(fila.usuario_nombre),
        usuario_apellido: fila.usuario_apellido == null ? null : String(fila.usuario_apellido),
        estado_nombre: fila.estado_nombre == null ? null : String(fila.estado_nombre),
    };
}

async function obtenerMensajesDesde(db, conversacion) {
    const configuracion = CONFIGURACION_CHAT[conversacion.modulo];
    if (!configuracion) return [];
    const [filas] = await db.query(configuracion.mensajesSql, [
        conversacion.entidadId,
        conversacion.desdeId,
    ]);
    return (Array.isArray(filas) ? filas : [])
        .map(normalizarMensajePersistido)
        .filter(Boolean);
}

function esMismaConversacion(actual, solicitada) {
    return Boolean(actual)
        && actual.modulo === solicitada.modulo
        && actual.entidadId === solicitada.entidadId;
}

async function abandonarConversacion(socket) {
    const sala = socket.data.chatSala;
    socket.data.chatConversacion = null;
    socket.data.chatSala = null;
    if (sala) {
        await socket.leave(sala);
    }
}

async function revalidarAccesoConversacion(db, socket, conversacion) {
    const authActual = await obtenerAutorizacionActualChat(db, socket.data.auth);
    if (!authActual) return false;
    socket.data.auth = authActual;
    return puedeAccederConversacion(db, authActual, conversacion);
}

function registrarEventosChatTiempoReal({ io, socket, db }) {
    socket.data.chatConversacion = null;
    socket.data.chatSala = null;
    socket.data.chatSyncEnCurso = false;

    socket.on("chat:join", async (payload = {}, callback) => {
        const responder = callbackSeguro(callback);
        try {
            const conversacion = normalizarConversacion(payload);
            if (!conversacion) {
                responder({ error: "Conversación inválida" });
                return;
            }
            if (!await revalidarAccesoConversacion(db, socket, conversacion)) {
                await abandonarConversacion(socket);
                responder({ error: "No autorizado" });
                return;
            }

            const sala = crearSalaChat(conversacion);
            if (socket.data.chatSala && socket.data.chatSala !== sala) {
                await abandonarConversacion(socket);
            }
            await socket.join(sala);
            socket.data.chatConversacion = {
                modulo: conversacion.modulo,
                entidadId: conversacion.entidadId,
            };
            socket.data.chatSala = sala;

            const mensajes = await obtenerMensajesDesde(db, conversacion);
            responder({ ok: true, mensajes });
        } catch (error) {
            console.error("Error al abrir conversación de chat por socket:", error);
            responder({ error: "No se pudo abrir la conversación" });
        }
    });

    socket.on("chat:sync", async (payload = {}, callback) => {
        const responder = callbackSeguro(callback);
        if (socket.data.chatSyncEnCurso) {
            responder({ error: "Sincronización en curso" });
            return;
        }

        socket.data.chatSyncEnCurso = true;
        try {
            const conversacion = normalizarConversacion(payload);
            if (!conversacion || !esMismaConversacion(socket.data.chatConversacion, conversacion)) {
                responder({ error: "Conversación no suscripta" });
                return;
            }
            if (!await revalidarAccesoConversacion(db, socket, conversacion)) {
                await abandonarConversacion(socket);
                responder({ error: "No autorizado" });
                return;
            }

            const mensajes = await obtenerMensajesDesde(db, conversacion);
            const envoltorioBase = {
                modulo: conversacion.modulo,
                entidad_id: conversacion.entidadId,
            };
            for (const mensaje of mensajes) {
                io.to(socket.data.chatSala).emit("chat:mensaje", {
                    ...envoltorioBase,
                    mensaje,
                });
            }
            responder({ ok: true, mensajes });
        } catch (error) {
            console.error("Error al sincronizar conversación de chat por socket:", error);
            responder({ error: "No se pudo sincronizar la conversación" });
        } finally {
            socket.data.chatSyncEnCurso = false;
        }
    });

    socket.on("chat:leave", async (_payload = {}, callback) => {
        const responder = callbackSeguro(callback);
        try {
            await abandonarConversacion(socket);
            responder({ ok: true });
        } catch (_error) {
            responder({ error: "No se pudo cerrar la conversación" });
        }
    });

    socket.on("disconnect", () => {
        socket.data.chatConversacion = null;
        socket.data.chatSala = null;
        socket.data.chatSyncEnCurso = false;
    });
}

module.exports = {
    MAX_MENSAJES_SINCRONIZACION,
    crearSalaChat,
    normalizarConversacion,
    obtenerAutorizacionActualChat,
    obtenerMensajesDesde,
    puedeAccederSegunEntidad,
    registrarEventosChatTiempoReal,
};
