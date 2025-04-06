const http = require('http');
const app = require('./app');

const port = process.env.PORT || 3000;

const server = http.createServer(app);

const socketio = require('socket.io');
const { addUser, removeUser, getUser, getUsers, getUsersInRoom, getUserByUsuario } = require("./api/socket/socket-user");

const io = socketio(server, {
    cors: {
        origin: '*'
    }
});

io.on("connection", (socket) => {
    console.log("Nuevo usuario conectado ", socket.id);

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


    socket.on('disconnect', () => {
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