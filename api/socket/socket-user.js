const users = [];
 
const addUser = ({id, usuario, rol}) => {
    rol = rol.trim().toLowerCase();
    if (rol === "cliente"){
        room = "cliente";
    } else {
        room = "admin";
    }
    const existingUser = users.find((user) => {
        user.usuario === usuario
    });
 
    if(existingUser) {
        return{error: "Username is taken"};
    }
    const user = {id,usuario,rol,room};
 
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
        .find((user) => user.usuario === usuario);
 
const getUsersInRoom = (room) => users
        .filter((user) => user.room === room);
 
module.exports = {addUser, removeUser,
        getUser, getUsers, getUsersInRoom, getUserByUsuario};