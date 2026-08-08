const users = [];
 
const addUser = ({id, usuario, rol}) => {
    const rolNormalizado = String(rol || "").trim().toLowerCase();
    if (rolNormalizado !== "cliente" && rolNormalizado !== "admin") {
        return { error: "Rol invalido" };
    }

    const idNormalizado = String(id || "").trim();
    const usuarioNormalizado = String(usuario || "").trim();
    if (!idNormalizado || !usuarioNormalizado) {
        return { error: "Usuario invalido" };
    }

    const existingSocket = users.find((user) => user.id === idNormalizado);
    if (existingSocket) {
        return { user: existingSocket };
    }

    const user = {
        id: idNormalizado,
        usuario: usuarioNormalizado,
        rol: rolNormalizado,
        room: rolNormalizado,
    };
 
    users.push(user);
    return {user};
 
}
 
const removeUser = (id) => {
    const index = users.findIndex((user) => {
        return user.id === id
    });
    if(index !== -1) {
        return users.splice(index,1)[0];
    }
}

const getUsers = () => users;

const getUser = (id) => users
        .find((user) => user.id === id);
        
const getUserByUsuario = (usuario) => users
        .find((user) => user.usuario === String(usuario));

const getUsersByUsuario = (usuario) => users
        .filter((user) => user.usuario === String(usuario));
 
const getUsersInRoom = (room) => users
        .filter((user) => user.room === room);
 
module.exports = {addUser, removeUser,
        getUser, getUsers, getUsersInRoom, getUserByUsuario, getUsersByUsuario};
