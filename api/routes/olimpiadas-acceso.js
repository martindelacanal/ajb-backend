"use strict";
const bcrypt = require("bcryptjs");
const { autenticarVoluntario, cargarCuentaVoluntario } = require("../security/olimpiadas-voluntarios");
const { buscarCuentaVoluntario, crearSesionVoluntario, renovarSesionVoluntario, cerrarSesionVoluntario } = require("../security/olimpiadas-acceso");
const { crearServicioRecuperacion, MENSAJE_SOLICITUD } = require("../security/recuperacion-password");
const { crearServicioRecuperacionExterna } = require("../security/olimpiadas-recuperacion");
const { esCorreoValido } = require("../services/correo/config");
const { validarPassword } = require("../security/password-policy");
const { crearErrorHttp } = require("../services/olimpiadas-comun");
const { registrarPasskeysVoluntarios } = require("./olimpiadas-passkeys");
const HASH_FICTICIO = "$2a$12$5WoEYBFTIUBIirQmH.M9BuQ3csYvrZlCZZh3uT7ld3vPvVYpBpD1O";
const PREFIJO = "/olimpiadas/voluntarios";

function registrarAccesoVoluntarios({ router, db, jwtSecret, enviar, manejar, limitador, cuentaPublica, asignacionesDe, webauthnLib, origenesPermitidos }) {
  const bearer = (req) => /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ""))?.[1];
  const autenticar = (req) => autenticarVoluntario({ token: bearer(req), db, jwtSecret });
  const responderSesion = async (res, sesion, cuenta) => {
    const asignaciones = await asignacionesDe(db, cuenta.id);
    if (!asignaciones.length) throw crearErrorHttp("No tenés disciplinas asignadas. Contactá a la organización de las Olimpiadas.", 403);
    res.set("Cache-Control", "no-store");
    res.json({ ...sesion, voluntario: cuentaPublica(cuenta), asignaciones });
  };
  router.post(`${PREFIJO}/login`, manejar(async (req, res) => {
    const identificador = typeof req.body?.identificador === "string" ? req.body.identificador.trim().toLowerCase() : "";
    await limitador(db, `voluntarios:login:ip:${req.ip}`, 60, 900, jwtSecret);
    await limitador(db, `voluntarios:login:cuenta:${identificador.slice(0,254)}`, 15, 900, jwtSecret);
    if (!identificador || identificador.length>254 || typeof req.body?.password!=="string" || Buffer.byteLength(req.body.password)>72) throw crearErrorHttp("Usuario o contraseña incorrectos", 401);
    let cuenta;
    try { cuenta = await buscarCuentaVoluntario(db, identificador); }
    catch (e) { if (!e.statusCode) throw e; }
    const valido = await bcrypt.compare(req.body.password, cuenta?.password_hash || HASH_FICTICIO);
    if (!cuenta || !valido || Number(cuenta.habilitado)!==1) throw crearErrorHttp("Usuario o contraseña incorrectos", 401);
    const asignaciones = await asignacionesDe(db, cuenta.id);
    if (!asignaciones.length) throw crearErrorHttp("No tenés disciplinas asignadas. Contactá a la organización de las Olimpiadas.", 403);
    const sesion = await crearSesionVoluntario({ db, cuenta, recordar: req.body?.recordar === true, jwtSecret });
    await responderSesion(res, sesion, cuenta);
  }));
  router.post(`${PREFIJO}/sesion/renovar`, manejar(async (req, res) => {
    await limitador(db, `voluntarios:renovar:ip:${req.ip}`, 200, 900, jwtSecret);
    const { cuenta, ...sesion } = await renovarSesionVoluntario({ db, refreshToken: req.body?.refreshToken, jwtSecret });
    await responderSesion(res, sesion, cuenta);
  }));
  router.post(`${PREFIJO}/sesion/cerrar`, manejar(async (req, res) => {
    await cerrarSesionVoluntario({ db, jwtSecret, token: bearer(req), refreshToken: req.body?.refreshToken });
    res.status(204).end();
  }));
  router.put(`${PREFIJO}/perfil`, manejar(async (req, res) => {
    const auth = await autenticar(req);
    const cx = await db.getConnection();
    try {
      await cx.beginTransaction();
      const cuenta = await cargarCuentaVoluntario(cx, auth.voluntario_id, true);
      if (!cuenta || Number(cuenta.habilitado)!==1 || Number(cuenta.sesion_version)!==auth.sesion_version) throw crearErrorHttp("Volvé a ingresar", 401);
      if (cuenta.usuario_sistema_id) throw crearErrorHttp("Tus datos y tu contraseña se administran desde la configuración de tu cuenta habitual de Mi AJB.", 409);
      const nombre = String(req.body?.nombre ?? cuenta.nombre).trim();
      const email = String(req.body?.email ?? cuenta.email).trim().toLowerCase();
      if (!nombre || nombre.length>160) throw crearErrorHttp("Ingresá un nombre de hasta 160 caracteres");
      if (!esCorreoValido(email) || email.length>254 || /[,;\r\n]/.test(email)) throw crearErrorHttp("Ingresá un correo válido");
      const cambiaClave = req.body?.password !== undefined && req.body.password !== "";
      const revocar = cambiaClave || email!==cuenta.email.trim().toLowerCase();
      if (revocar) {
        await limitador(db, `voluntarios:perfil:cuenta:${cuenta.id}`, 10, 900, jwtSecret);
        if (typeof req.body?.password_actual!=="string" || Buffer.byteLength(req.body.password_actual)>72 || !await bcrypt.compare(req.body.password_actual, cuenta.password_hash)) throw crearErrorHttp("La contraseña actual no es correcta", 400);
      }
      if (cambiaClave) validarPassword(req.body.password, "personal");
      const hash = cambiaClave ? await bcrypt.hash(req.body.password, 12) : cuenta.password_hash;
      await cx.query("UPDATE olimpiada_voluntario SET nombre=?,email=?,password_hash=?,sesion_version=sesion_version+? WHERE id=? AND usuario_sistema_id IS NULL", [nombre,email,hash,revocar?1:0,cuenta.id]);
      if (revocar) {
        await cx.query("UPDATE olimpiada_voluntario_sesion SET revocado_en=NOW(6) WHERE voluntario_id=?", [cuenta.id]);
        await cx.query("DELETE FROM olimpiada_voluntario_passkey WHERE voluntario_id=?", [cuenta.id]);
      }
      await cx.commit();
      res.json({ mensaje: revocar ? "Datos actualizados. Volvé a ingresar y registrá nuevamente tu biometría." : "Tus datos fueron actualizados.", requiere_login: revocar });
    } catch (e) { await cx.rollback(); throw e; } finally { cx.release(); }
  }));
  const enviarCodigo = ({para,codigo}) => enviar({ para, autenticacion:true,
    asunto:"Tu código de acceso al equipo de Olimpiadas", titulo:"Recuperá tu acceso de colaboración", saludo:"Hola,",
    parrafos:["Usá este código para elegir una nueva contraseña. Vence en diez minutos y sólo se puede usar una vez.","Si no pediste recuperar tu cuenta, ignorá este correo."],
    datos:[{etiqueta:"Código de seguridad",valor:codigo}] });
  const externo = crearServicioRecuperacionExterna({ db,jwtSecret,enviarCodigo });
  const sistema = crearServicioRecuperacion({ db,jwtSecret,enviarCodigo });
  async function resolverRecuperacion(identificador) {
    if (typeof identificador!=="string" || identificador.length>254) return { servicio:externo,identificador:"",prefijo:"o." };
    // Recuperar una clave también debe funcionar cuando Mi AJB exige cambiarla.
    // Resolver identidad no equivale a autenticar: cada servicio valida la cuenta
    // y su código antes de autorizar cualquier cambio.
    const valor=identificador.trim().toLowerCase();
    const [rows]=await db.query(`SELECT v.id,v.usuario_sistema_id,u.documento FROM olimpiada_voluntario v
      LEFT JOIN usuario u ON u.id=v.usuario_sistema_id WHERE v.habilitado=1 AND
      ((v.usuario_sistema_id IS NULL AND (v.usuario=? OR v.email=?)) OR
       (v.usuario_sistema_id IS NOT NULL AND (CAST(u.documento AS CHAR)=? OR LOWER(TRIM(u.email))=?))) LIMIT 2`,[valor,valor,valor,valor]);
    const cuenta=rows.length===1?rows[0]:null;
    if (cuenta?.usuario_sistema_id) return { servicio:sistema,identificador:String(cuenta.documento),prefijo:"s." };
    if (rows.length!==1) return { servicio:externo,identificador:"",prefijo:"o." };
    return { servicio:externo,identificador,prefijo:"o." };
  }
  router.post(`${PREFIJO}/recuperacion/solicitar`, manejar(async (req,res) => {
    const inicio = Date.now();
    await limitador(db,`oli-recuperacion:ip:${req.ip}`,12,3600,jwtSecret);
    const r = await resolverRecuperacion(req.body?.identificador);
    const envio = await r.servicio.solicitar({identificador:r.identificador,ip:req.ip});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,350-(Date.now()-inicio))));
    res.json({mensaje:MENSAJE_SOLICITUD,reintentarEn:60});
    void r.servicio.entregar(envio).catch(()=>console.error("[olimpiadas] No se pudo entregar recuperación"));
  }));
  router.post(`${PREFIJO}/recuperacion/verificar`, manejar(async (req,res) => {
    await limitador(db,`oli-recuperacion-verificar:ip:${req.ip}`,40,900,jwtSecret);
    const r = await resolverRecuperacion(req.body?.identificador);
    const resultado = await r.servicio.verificar({ identificador:r.identificador,codigo:req.body?.codigo,ip:req.ip });
    res.json({...resultado,resetToken:r.prefijo+resultado.resetToken});
  }));
  router.post(`${PREFIJO}/recuperacion/restablecer`, manejar(async (req,res) => {
    const token = String(req.body?.resetToken || "");
    if (!/^[os]\.[A-Za-z0-9_-]{43}$/.test(token)) throw crearErrorHttp("El código no es válido o venció.");
    res.json(await (token.startsWith("s.")?sistema:externo).restablecer({resetToken:token.slice(2),password:req.body?.password,ip:req.ip}));
  }));
  registrarPasskeysVoluntarios({router,db,jwtSecret,manejar,limitador,autenticar,responderSesion,asignacionesDe,webauthnLib,origenesPermitidos});
}
module.exports = { registrarAccesoVoluntarios };
