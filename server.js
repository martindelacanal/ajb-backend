const http = require('http');
const app = require('./app');
const mysqlConnection = require('./api/connection/connection');

const port = process.env.PORT || 3000;

const server = http.createServer(app);

const socketio = require('socket.io');
const { addUser, removeUser, getUser, getUsers, getUsersInRoom, getUserByUsuario } = require("./api/socket/socket-user");
const {
    obtenerSnapshotDisponibilidad,
    parsearParametrosBusquedaDisponibilidad,
    parsearServicioIdsCsv,
} = require("./api/services/servicios-disponibilidad");

const SOCKET_DISPONIBILIDAD_INTERVALO_MS = Number.parseInt(
    process.env.SOCKET_DISPONIBILIDAD_INTERVALO_MS || "15000",
    10
);

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

    const servicio_ids = Array.isArray(payload.servicio_ids)
        ? payload.servicio_ids
        : parsearServicioIdsCsv(payload.servicio_ids);

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
        origin: '*'
    }
});

io.on("connection", (socket) => {
    console.log("Nuevo usuario conectado ", socket.id);
    socket.data.disponibilidadSubs = new Map();
    socket.data.disponibilidadTimer = null;
    socket.data.procesandoDisponibilidad = false;

    socket.on('join', ({ usuario, rol }, callback) => {
        console.log(usuario, rol, socket.id);
        const { error, user } = addUser({ id: socket.id, usuario, rol });

        if (error) return callback(error);
        // // Emit will send message to the user
        // // who had joined
        // socket.emit('message', { user: 'admin', text: `${user.usuario}, welcome to room ${user.room}.`});

        // // Broadcast will send message to everyone
        // // in the room except the joined user
        // socket.broadcast.to(user.room).emit('message', { user: "admin", text: `${user.name}, has joined`});

        socket.join(user.room);
        console.log("USUARIOS ", getUsers())
        console.log("CLIENTES ", getUsersInRoom("cliente"));
        console.log("ADMIN ", getUsersInRoom("admin"));
     
        callback();
    })

    socket.on('sendMessageToAdmin', (message, callback) => {

        const user = getUser(socket.id);
        console.log("MENSAJE ", message);
        if(user){
            io.in("admin").emit('getMessage', message);
            // socket.to("admin").emit('getMessage', { user: user.usuario, text: "1" });
        }
        callback();
    })
    socket.on('sendMessageToClient', (message, callback) => {
        console.log(message);
        const user = getUserByUsuario(message.cliente);
        if(user){
            io.to(user.id).emit('getMessage', message );
            // socket.broadcast.to(user.id).emit('getMessage', { somedata: somedata_server });
        }
        callback();
    })

    socket.on("servicios:disponibilidad:subscribe", async (payload = {}, callback = () => { }) => {
        try {
            const normalizado = normalizarPayloadSuscripcionDisponibilidad(payload);
            if (normalizado.error) {
                callback({ error: normalizado.error });
                return;
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
        console.log("USUARIOS ", getUsers());
        if (user) {
            if (user.rol === "cliente") {
                socket.leave("cliente");
            } else {
                socket.leave("admin");
            }
            console.log(`el usuario ${user.usuario} se fue`);
        }
        console.log("CLIENTES ", getUsersInRoom("cliente"));
        console.log("ADMIN ", getUsersInRoom("admin"));
    })
    

})

server.listen(port);
