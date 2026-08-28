const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('./app');
const mysqlConnection = require('./api/connection/connection');
const {
    obtenerOrigenesPermitidos,
    crearValidadorCors,
} = require('./api/security/http-config');

const port = process.env.PORT || 3000;

const server = http.createServer(app);

const socketio = require('socket.io');
const { addUser, removeUser, getUser, getUsersByUsuario } = require("./api/socket/socket-user");
const { registrarEventosChatTiempoReal } = require("./api/socket/chat-tiempo-real");
const { iniciarMantenimientoReservas } = require("./api/services/reservas-turismo");
const { verificarCorreo } = require("./api/services/correo");
const {
    obtenerSnapshotDisponibilidad,
    parsearParametrosBusquedaDisponibilidad,
    parsearServicioIdsCsv,
} = require("./api/services/servicios-disponibilidad");

const intervaloConfigurado = Number.parseInt(process.env.SOCKET_DISPONIBILIDAD_INTERVALO_MS || "15000", 10);
const SOCKET_DISPONIBILIDAD_INTERVALO_MS = Number.isInteger(intervaloConfigurado)
    ? Math.min(300000, Math.max(5000, intervaloConfigurado))
    : 15000;
const MAX_SUSCRIPCIONES_DISPONIBILIDAD = 5;
const MAX_SERVICIOS_POR_SUSCRIPCION = 50;
const ROLES_STAFF_SOCKET = new Set(["admin", "admin-central", "departamental"]);
// Mismo gate que el GET /servicios/disponibilidad del REST
const ROLES_DISPONIBILIDAD = new Set(["admin", "afiliado", "departamental"]);

function tieneAccesoTurismoSocket(auth) {
    if (auth?.rol === "afiliado") {
        return auth.modulo_turismo == null || Number(auth.modulo_turismo) === 1;
    }
    if (auth?.rol === "departamental" || auth?.rol === "admin-central") {
        return auth.area_turismo == null || Number(auth.area_turismo) === 1;
    }
    return auth?.rol === "admin";
}

function callbackSeguro(callback) {
    return typeof callback === "function" ? callback : () => { };
}

function extraerTokenSocket(socket) {
    const tokenAuth = socket.handshake?.auth?.token;
    const authorization = socket.handshake?.headers?.authorization;
    const valor = typeof tokenAuth === "string" ? tokenAuth : authorization;
    if (typeof valor !== "string" || valor.length > 8192) {
        return null;
    }
    return valor.replace(/^Bearer\s+/i, "").trim() || null;
}

function parsearDatosToken(payload) {
    try {
        const datos = typeof payload?.data === "string" ? JSON.parse(payload.data) : payload?.data;
        const id = Number(datos?.id);
        if (!Number.isInteger(id) || id <= 0) {
            return null;
        }
        return { id };
    } catch (_error) {
        return null;
    }
}

function normalizarMensajeSocket(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        return null;
    }
    try {
        const serializado = JSON.stringify(message);
        if (serializado.length > 10000) {
            return null;
        }
        return JSON.parse(serializado);
    } catch (_error) {
        return null;
    }
}

function crearClaveSuscripcionDisponibilidad(payload) {
    const idsOrdenados = [...payload.servicio_ids].sort((a, b) => a - b);
    return [
        payload.lugar || "",
        payload.fecha_inicio,
        payload.fecha_fin,
        payload.adultos,
        payload.ninos,
        payload.bebes,
        idsOrdenados.join(","),
        payload.reserva_excluir_id || "",
    ].join("|");
}

function normalizarPayloadSuscripcionDisponibilidad(payload = {}) {
    const parseo = parsearParametrosBusquedaDisponibilidad(payload, {
        requireFechas: true,
        requirePersonas: true,
    });

    if (parseo.error) {
        return { error: parseo.error };
    }

    const servicio_ids = [...new Set(parsearServicioIdsCsv(payload.servicio_ids))];
    if (servicio_ids.length > MAX_SERVICIOS_POR_SUSCRIPCION) {
        return { error: `No se permiten mas de ${MAX_SERVICIOS_POR_SUSCRIPCION} servicios por suscripcion` };
    }

    // Al editar una reserva, el snapshot no debe contarla como ocupación
    const reservaExcluirIdRaw = Number(payload.reserva_excluir_id);
    const reserva_excluir_id =
        Number.isInteger(reservaExcluirIdRaw) && reservaExcluirIdRaw > 0 ? reservaExcluirIdRaw : null;

    return {
        value: {
            lugar: payload.lugar || null,
            fecha_inicio: parseo.value.fecha_inicio,
            fecha_fin: parseo.value.fecha_fin,
            adultos: parseo.value.adultos,
            ninos: parseo.value.ninos,
            bebes: parseo.value.bebes,
            total_personas: parseo.value.total_personas,
            servicio_ids,
            reserva_excluir_id,
        },
    };
}

async function obtenerActualizacionesDisponibilidad(payloadNormalizado) {
    const db = mysqlConnection.promise();
    return obtenerSnapshotDisponibilidad(db, {
        lugar: payloadNormalizado.lugar,
        servicioIds: payloadNormalizado.servicio_ids,
        fechaInicio: payloadNormalizado.fecha_inicio,
        fechaFin: payloadNormalizado.fecha_fin,
        adultos: payloadNormalizado.adultos,
        ninos: payloadNormalizado.ninos,
        bebes: payloadNormalizado.bebes,
        totalPersonas: payloadNormalizado.total_personas,
        reservaExcluirId: payloadNormalizado.reserva_excluir_id || null,
    });
}

async function emitirSuscripcionDisponibilidad(socket, suscripcion, forzar = false) {
    const actualizaciones = await obtenerActualizacionesDisponibilidad(suscripcion.payload);
    const hashActual = JSON.stringify(actualizaciones);

    if (forzar || suscripcion.hashAnterior !== hashActual) {
        suscripcion.hashAnterior = hashActual;
        socket.emit("servicios:disponibilidad", { actualizaciones });
    }
}

function limpiarTimerDisponibilidad(socket) {
    if (socket.data.disponibilidadTimer) {
        clearInterval(socket.data.disponibilidadTimer);
        socket.data.disponibilidadTimer = null;
    }
}

function asegurarTimerDisponibilidad(socket) {
    if (socket.data.disponibilidadTimer) {
        return;
    }

    socket.data.disponibilidadTimer = setInterval(async () => {
        if (socket.data.procesandoDisponibilidad) {
            return;
        }

        if (!socket.data.disponibilidadSubs || socket.data.disponibilidadSubs.size === 0) {
            limpiarTimerDisponibilidad(socket);
            return;
        }

        socket.data.procesandoDisponibilidad = true;
        try {
            for (const suscripcion of socket.data.disponibilidadSubs.values()) {
                await emitirSuscripcionDisponibilidad(socket, suscripcion, false);
            }
        } catch (error) {
            console.log("Error actualizando disponibilidad por socket:", error);
        } finally {
            socket.data.procesandoDisponibilidad = false;
        }
    }, SOCKET_DISPONIBILIDAD_INTERVALO_MS);
}

const io = socketio(server, {
    cors: {
        origin: crearValidadorCors(obtenerOrigenesPermitidos()),
        methods: ["GET", "POST"],
        allowedHeaders: ["Authorization"],
        credentials: false,
    },
    maxHttpBufferSize: 100000,
});

io.use(async (socket, next) => {
    try {
        const token = extraerTokenSocket(socket);
        if (!token || !process.env.JWT_SECRET) {
            next(new Error("No autorizado"));
            return;
        }

        const tokenVerificado = jwt.verify(token, process.env.JWT_SECRET);
        const datosToken = parsearDatosToken(tokenVerificado);
        if (!datosToken) {
            next(new Error("No autorizado"));
            return;
        }

        const [usuarios] = await mysqlConnection.promise().query(
            `SELECT u.id, u.documento, u.departamental_id, u.area_turismo, u.area_coseguro,
                    u.modulo_turismo, u.modulo_coseguro, u.modulo_olimpiadas,
                    r.nombre AS rol
             FROM usuario u
             INNER JOIN rol r ON r.id = u.rol_id
             WHERE u.id = ? AND u.habilitado = 'Y'
             LIMIT 1`,
            [datosToken.id]
        );
        if (usuarios.length !== 1) {
            next(new Error("No autorizado"));
            return;
        }

        socket.data.auth = {
            id: Number(usuarios[0].id),
            documento: String(usuarios[0].documento),
            rol: String(usuarios[0].rol || "").trim().toLowerCase(),
            departamentalId: usuarios[0].departamental_id == null
                ? null
                : Number(usuarios[0].departamental_id),
            area_turismo: usuarios[0].area_turismo,
            area_coseguro: usuarios[0].area_coseguro,
            modulo_turismo: usuarios[0].modulo_turismo,
            modulo_coseguro: usuarios[0].modulo_coseguro,
            modulo_olimpiadas: usuarios[0].modulo_olimpiadas,
        };
        next();
    } catch (_error) {
        next(new Error("No autorizado"));
    }
});

io.on("connection", (socket) => {
    socket.data.disponibilidadSubs = new Map();
    socket.data.disponibilidadTimer = null;
    socket.data.procesandoDisponibilidad = false;
    const rolSala = ROLES_STAFF_SOCKET.has(socket.data.auth.rol) ? "admin" : "cliente";
    const alta = addUser({
        id: socket.id,
        usuario: socket.data.auth.documento,
        rol: rolSala,
    });
    if (!alta.user) {
        socket.disconnect(true);
        return;
    }
    socket.join(alta.user.room);

    registrarEventosChatTiempoReal({
        io,
        socket,
        db: mysqlConnection.promise(),
    });

    // Compatibilidad con clientes antiguos: la identidad y el rol del payload se ignoran.
    socket.on('join', (_payload, callback) => {
        callbackSeguro(callback)({ ok: true });
    });

    socket.on('sendMessageToAdmin', (message, callback) => {
        const responder = callbackSeguro(callback);
        const user = getUser(socket.id);
        const mensajeSeguro = normalizarMensajeSocket(message);
        if (!user || !mensajeSeguro) {
            responder({ error: "Mensaje invalido" });
            return;
        }
        io.in("admin").emit('getMessage', {
            ...mensajeSeguro,
            cliente: user.usuario,
            emisor_id: socket.data.auth.id,
        });
        responder({ ok: true });
    });

    socket.on('sendMessageToClient', (message, callback) => {
        const responder = callbackSeguro(callback);
        if (!ROLES_STAFF_SOCKET.has(socket.data.auth.rol)) {
            responder({ error: "No autorizado" });
            return;
        }
        const mensajeSeguro = normalizarMensajeSocket(message);
        const cliente = String(mensajeSeguro?.cliente || "").trim();
        if (!mensajeSeguro || !/^\d{5,12}$/.test(cliente)) {
            responder({ error: "Mensaje invalido" });
            return;
        }
        const destinatarios = getUsersByUsuario(cliente);
        for (const destinatario of destinatarios) {
            io.to(destinatario.id).emit('getMessage', {
                ...mensajeSeguro,
                emisor_id: socket.data.auth.id,
            });
        }
        responder({ ok: true, entregados: destinatarios.length });
    });

    socket.on("servicios:disponibilidad:subscribe", async (payload = {}, callback = () => { }) => {
        try {
            if (
                !ROLES_DISPONIBILIDAD.has(socket.data.auth.rol)
                || !tieneAccesoTurismoSocket(socket.data.auth)
            ) {
                callback({ error: "No autorizado" });
                return;
            }
            if (socket.data.disponibilidadSubs.size >= MAX_SUSCRIPCIONES_DISPONIBILIDAD) {
                callback({ error: `No se permiten mas de ${MAX_SUSCRIPCIONES_DISPONIBILIDAD} suscripciones simultaneas` });
                return;
            }
            const normalizado = normalizarPayloadSuscripcionDisponibilidad(payload);
            if (normalizado.error) {
                callback({ error: normalizado.error });
                return;
            }

            // El afiliado solo puede excluir del conteo una reserva propia
            if (normalizado.value.reserva_excluir_id && socket.data.auth.rol === "afiliado") {
                const [reservaExcluir] = await mysqlConnection.promise().query(
                    "SELECT usuario_id FROM reserva WHERE id = ?",
                    [normalizado.value.reserva_excluir_id]
                );
                if (Number(reservaExcluir?.[0]?.usuario_id) !== Number(socket.data.auth.id)) {
                    normalizado.value.reserva_excluir_id = null;
                }
            }

            const clave = crearClaveSuscripcionDisponibilidad({
                ...normalizado.value,
                servicio_ids: normalizado.value.servicio_ids || [],
            });

            const suscripcion = socket.data.disponibilidadSubs.get(clave) || {
                clave,
                payload: normalizado.value,
                hashAnterior: null,
            };

            suscripcion.payload = normalizado.value;
            socket.data.disponibilidadSubs.set(clave, suscripcion);

            await emitirSuscripcionDisponibilidad(socket, suscripcion, true);
            asegurarTimerDisponibilidad(socket);
            callback({ ok: true });
        } catch (error) {
            console.log("Error en subscribe de disponibilidad:", error);
            callback({ error: "No se pudo suscribir a disponibilidad" });
        }
    });

    socket.on("servicios:disponibilidad:unsubscribe", (payload = {}, callback = () => { }) => {
        try {
            if (!payload || Object.keys(payload).length === 0) {
                socket.data.disponibilidadSubs.clear();
                limpiarTimerDisponibilidad(socket);
                callback({ ok: true });
                return;
            }

            const normalizado = normalizarPayloadSuscripcionDisponibilidad(payload);
            if (normalizado.error) {
                callback({ error: normalizado.error });
                return;
            }

            const clave = crearClaveSuscripcionDisponibilidad({
                ...normalizado.value,
                servicio_ids: normalizado.value.servicio_ids || [],
            });

            socket.data.disponibilidadSubs.delete(clave);
            if (socket.data.disponibilidadSubs.size === 0) {
                limpiarTimerDisponibilidad(socket);
            }

            callback({ ok: true });
        } catch (error) {
            console.log("Error en unsubscribe de disponibilidad:", error);
            callback({ error: "No se pudo cancelar la suscripcion de disponibilidad" });
        }
    });


    socket.on('disconnect', () => {
        limpiarTimerDisponibilidad(socket);
        if (socket.data.disponibilidadSubs) {
            socket.data.disponibilidadSubs.clear();
        }

        const user = removeUser(socket.id);
        if (user) {
            socket.leave(user.room);
        }
    });
});

server.listen(port);
iniciarMantenimientoReservas(mysqlConnection.promise());

// Chequeo informativo del correo saliente: no bloquea el arranque, solo deja
// registro si la casilla de notificaciones quedo mal configurada.
verificarCorreo().then((resultado) => {
    if (resultado.conectado) {
        const detalle = resultado.detalle;
        const estadoEnvios = detalle.habilitado ? "habilitados" : "desactivados";
        console.log(`[correo] SMTP autenticado (${detalle.remitente} via ${detalle.host}:${detalle.puerto}; envios ${estadoEnvios}${detalle.modoPruebas ? ", modo pruebas" : ""})`);
    } else if (resultado.motivo === "sin_configurar") {
        console.warn("[correo] Sin configuracion SMTP: las notificaciones por mail estan desactivadas.");
    } else {
        console.error("[correo] No se pudo conectar al servidor SMTP:", resultado.error);
    }
}).catch((error) => {
    console.error("[correo] Verificacion de SMTP fallida:", error?.message || error);
});
