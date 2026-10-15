"use strict";
const crypto = require("crypto");
const simpleWebAuthn = require("@simplewebauthn/server");
const { resolverContextoWebAuthn } = require("../security/webauthn-origen");
const { cargarCuentaVoluntario } = require("../security/olimpiadas-voluntarios");
const { crearSesionVoluntario } = require("../security/olimpiadas-acceso");
const { igualesSeguros, huellaPassword } = require("../security/auth-crypto");
const { crearErrorHttp, normalizarIdPositivo } = require("../services/olimpiadas-comun");
const PREFIJO = "/olimpiadas/voluntarios/passkeys";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^[A-Za-z0-9_-]{1,1400}$/;
const TRANSPORTES = new Set(["ble","cable","hybrid","internal","nfc","smart-card","usb"]);
function transportes(valor) {
  try { const datos=typeof valor==="string"?JSON.parse(valor):valor; return Array.isArray(datos)?[...new Set(datos.filter(t=>TRANSPORTES.has(t)))]:[]; } catch(_){return [];}
}
function publica(c) { return {id:Number(c.id),nombre:c.nombre,dominio:c.rp_id,tipo_dispositivo:c.tipo_dispositivo,respaldada:Boolean(c.respaldada),creada_en:c.fecha_creacion,ultimo_uso_en:c.fecha_ultimo_uso}; }
function nombre(valor) { return (typeof valor==="string"?valor.trim().replace(/\s+/g," ").slice(0,100):"") || "Clave de acceso"; }
async function guardarDesafio(db,{tipo,cuenta=null,opciones,contexto,recordar=false,jwtSecret}) {
  await db.query("DELETE FROM olimpiada_voluntario_desafio WHERE vence_en<DATE_SUB(NOW(6),INTERVAL 1 DAY) LIMIT 100");
  const id=crypto.randomUUID();
  await db.query(`INSERT INTO olimpiada_voluntario_desafio
    (id,tipo,voluntario_id,challenge,webauthn_usuario_id,origen,rp_id,recordar,sesion_version,password_version,vence_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,DATE_ADD(NOW(6),INTERVAL 5 MINUTE))`,
  [id,tipo,cuenta?.id||null,opciones.challenge,opciones.user?.id||null,contexto.origen,contexto.rpID,recordar?1:0,cuenta?.sesion_version||null,cuenta?huellaPassword(cuenta.password_hash,jwtSecret):null]);
  return id;
}
async function consumirDesafio(db,{id,tipo,contexto,voluntarioId=null,version=null}) {
  if(!UUID.test(String(id||""))) throw crearErrorHttp("La solicitud de biometría venció. Volvé a intentar.",400);
  const [r]=await db.query(`UPDATE olimpiada_voluntario_desafio SET consumido_en=NOW(6)
    WHERE id=? AND tipo=? AND origen=? AND rp_id=? AND consumido_en IS NULL AND vence_en>NOW(6)
    ${tipo==="REGISTRO"?"AND voluntario_id=? AND sesion_version=?":""}`,
  [id,tipo,contexto.origen,contexto.rpID,...(tipo==="REGISTRO"?[voluntarioId,version]:[])]);
  if(Number(r.affectedRows)!==1) throw crearErrorHttp("La solicitud de biometría venció o ya fue utilizada.",400);
  const [rows]=await db.query("SELECT * FROM olimpiada_voluntario_desafio WHERE id=? LIMIT 1",[id]);
  if(!rows[0]) throw crearErrorHttp("La solicitud de biometría no es válida.",400);
  return rows[0];
}
function registrarPasskeysVoluntarios({router,db,jwtSecret,manejar,limitador,autenticar,responderSesion,asignacionesDe,webauthnLib=simpleWebAuthn,origenesPermitidos}) {
  const contexto=req=>resolverContextoWebAuthn(req,origenesPermitidos);
  const limitado=async(req,operacion)=>limitador(db,`oli-passkeys:${operacion}:ip:${req.ip}`,60,900,jwtSecret);
  router.get(PREFIJO,manejar(async(req,res)=>{
    const auth=await autenticar(req);
    const [rows]=await db.query("SELECT id,nombre,rp_id,tipo_dispositivo,respaldada,fecha_creacion,fecha_ultimo_uso FROM olimpiada_voluntario_passkey WHERE voluntario_id=? ORDER BY fecha_creacion DESC",[auth.voluntario_id]);
    res.set("Cache-Control","no-store"); res.json(rows.map(publica));
  }));
  router.delete(`${PREFIJO}/:id`,manejar(async(req,res)=>{
    const auth=await autenticar(req); const id=normalizarIdPositivo(req.params.id);
    if(!id) throw crearErrorHttp("La clave de acceso no es válida");
    const [r]=await db.query("DELETE FROM olimpiada_voluntario_passkey WHERE id=? AND voluntario_id=?",[id,auth.voluntario_id]);
    if(Number(r.affectedRows)!==1) throw crearErrorHttp("No encontramos esa clave de acceso",404);
    res.json({success:true});
  }));
  router.post(`${PREFIJO}/registration/options`,manejar(async(req,res)=>{
    const ctx=contexto(req); const auth=await autenticar(req); await limitado(req,"registro");
    const cuenta=await cargarCuentaVoluntario(db,auth.voluntario_id);
    const [existentes]=await db.query("SELECT credential_id,transportes,rp_id FROM olimpiada_voluntario_passkey WHERE voluntario_id=?",[cuenta.id]);
    if(existentes.length>=10) throw crearErrorHttp("Ya registraste diez claves de acceso. Eliminá una para agregar otra.",409);
    const opciones=await webauthnLib.generateRegistrationOptions({rpName:"Mi AJB · Colaboradores de Olimpiadas",rpID:ctx.rpID,
      userID:Buffer.from(`miajb-olimpiadas:${cuenta.id}`,"utf8"),userName:cuenta.usuario,userDisplayName:cuenta.nombre,
      timeout:300000,attestationType:"none",supportedAlgorithmIDs:[-7,-257],
      excludeCredentials:existentes.filter(c=>c.rp_id===ctx.rpID).map(c=>({id:c.credential_id,transports:transportes(c.transportes)})),
      authenticatorSelection:{residentKey:"required",userVerification:"required"}});
    res.json({ceremonia_id:await guardarDesafio(db,{tipo:"REGISTRO",cuenta,opciones,contexto:ctx,jwtSecret}),opciones});
  }));
  router.post(`${PREFIJO}/registration/verify`,manejar(async(req,res)=>{
    const ctx=contexto(req); const auth=await autenticar(req); await limitado(req,"registro-verificar");
    const desafio=await consumirDesafio(db,{id:req.body?.ceremonia_id,tipo:"REGISTRO",contexto:ctx,voluntarioId:auth.voluntario_id,version:auth.sesion_version});
    if(!CREDENTIAL.test(String(req.body?.respuesta?.id||""))) throw crearErrorHttp("No se pudo registrar la clave de acceso");
    let verificacion;
    try { verificacion=await webauthnLib.verifyRegistrationResponse({response:req.body.respuesta,expectedChallenge:desafio.challenge,
      expectedOrigin:desafio.origen,expectedRPID:desafio.rp_id,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]}); }
    catch(_){throw crearErrorHttp("No se pudo registrar la clave de acceso");}
    const info=verificacion?.registrationInfo; const credencial=info?.credential;
    if(!verificacion?.verified || !credencial?.publicKey || !CREDENTIAL.test(String(credencial.id||""))) throw crearErrorHttp("No se pudo registrar la clave de acceso");
    const cx=await db.getConnection();
    try {
      await cx.beginTransaction();
      const cuenta=await cargarCuentaVoluntario(cx,auth.voluntario_id,true);
      if(!cuenta || Number(cuenta.habilitado)!==1 || Number(cuenta.sesion_version)!==auth.sesion_version
        || !igualesSeguros(desafio.password_version,huellaPassword(cuenta.password_hash,jwtSecret))) throw crearErrorHttp("Tu acceso cambió. Volvé a ingresar.",401);
      const [totales]=await cx.query("SELECT COUNT(*) AS total FROM olimpiada_voluntario_passkey WHERE voluntario_id=?",[cuenta.id]);
      if(Number(totales[0]?.total)>=10) throw crearErrorHttp("Ya registraste diez claves de acceso",409);
      const [r]=await cx.query(`INSERT INTO olimpiada_voluntario_passkey
        (voluntario_id,rp_id,webauthn_usuario_id,credential_id,clave_publica,contador,tipo_dispositivo,respaldada,transportes,nombre,password_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[cuenta.id,ctx.rpID,desafio.webauthn_usuario_id,credencial.id,Buffer.from(credencial.publicKey),Number(credencial.counter||0),
        info.credentialDeviceType||"unknown",info.credentialBackedUp?1:0,JSON.stringify(transportes(credencial.transports)),nombre(req.body?.nombre),huellaPassword(cuenta.password_hash,jwtSecret)]);
      await cx.commit();
      res.status(201).json({id:Number(r.insertId),nombre:nombre(req.body?.nombre),dominio:ctx.rpID,creada_en:new Date().toISOString(),ultimo_uso_en:null,tipo_dispositivo:info.credentialDeviceType,respaldada:Boolean(info.credentialBackedUp)});
    } catch(e){await cx.rollback();throw e;} finally{cx.release();}
  }));
  router.post(`${PREFIJO}/authentication/options`,manejar(async(req,res)=>{
    const ctx=contexto(req); await limitado(req,"autenticar");
    const opciones=await webauthnLib.generateAuthenticationOptions({rpID:ctx.rpID,timeout:300000,userVerification:"required",allowCredentials:[]});
    res.json({ceremonia_id:await guardarDesafio(db,{tipo:"AUTENTICACION",opciones,contexto:ctx,recordar:req.body?.recordar===true}),opciones});
  }));
  router.post(`${PREFIJO}/authentication/verify`,manejar(async(req,res)=>{
    const ctx=contexto(req); await limitado(req,"autenticar-verificar");
    const desafio=await consumirDesafio(db,{id:req.body?.ceremonia_id,tipo:"AUTENTICACION",contexto:ctx});
    const respuesta=req.body?.respuesta;
    if(!CREDENTIAL.test(String(respuesta?.id||""))) throw crearErrorHttp("No se pudo validar la clave de acceso",401);
    const cx=await db.getConnection();
    try {
      await cx.beginTransaction();
      // Cuenta antes que credencial: conserva el orden de bloqueo de registro y recuperación.
      let [candidatos]=await cx.query("SELECT voluntario_id FROM olimpiada_voluntario_passkey WHERE credential_id=? AND rp_id=? LIMIT 1",[respuesta.id,ctx.rpID]);
      let claveHabitual=false;
      if(!candidatos.length){
        [candidatos]=await cx.query(`SELECT v.id AS voluntario_id FROM webauthn_credencial c
          INNER JOIN olimpiada_voluntario v ON v.usuario_sistema_id=c.usuario_id
          WHERE c.credential_id=? AND c.rp_id=? LIMIT 1`,[respuesta.id,ctx.rpID]);
        claveHabitual=true;
      }
      const cuenta=candidatos[0]?await cargarCuentaVoluntario(cx,candidatos[0].voluntario_id,true):null;
      if(!cuenta || Number(cuenta.habilitado)!==1) throw crearErrorHttp("No se pudo validar la clave de acceso",401);
      // Una credencial habitual sólo autentica a su dueño ya vinculado. El JWT
      // resultante conserva la clave y audiencia exclusivas de Olimpiadas.
      const tabla=claveHabitual?"webauthn_credencial":"olimpiada_voluntario_passkey";
      const [rows]=await cx.query(`SELECT * FROM ${tabla} WHERE credential_id=? AND rp_id=? AND ${claveHabitual?"usuario_id":"voluntario_id"}=? LIMIT 1 FOR UPDATE`,[respuesta.id,ctx.rpID,claveHabitual?cuenta.usuario_sistema_id:cuenta.id]);
      const c=rows[0];
      if(!c || !igualesSeguros(respuesta?.response?.userHandle,c.webauthn_usuario_id)
        || (!claveHabitual && !igualesSeguros(c.password_version,huellaPassword(cuenta.password_hash,jwtSecret)))
        || (cuenta.usuario_sistema?.auth_revocado_desde && new Date(c.fecha_creacion)<=new Date(cuenta.usuario_sistema.auth_revocado_desde))) throw crearErrorHttp("No se pudo validar la clave de acceso. Si cambiaste tu contraseña, registrala nuevamente.",401);
      let verificacion;
      try {verificacion=await webauthnLib.verifyAuthenticationResponse({response:respuesta,expectedChallenge:desafio.challenge,expectedOrigin:ctx.origen,expectedRPID:ctx.rpID,
        credential:{id:c.credential_id,publicKey:new Uint8Array(c.clave_publica),counter:Number(c.contador),transports:transportes(c.transportes)},requireUserVerification:true});}
      catch(_){throw crearErrorHttp("No se pudo validar la clave de acceso",401);}
      const info=verificacion?.authenticationInfo;
      if(!verificacion?.verified || !Number.isSafeInteger(info?.newCounter) || info.newCounter<0 || !["singleDevice","multiDevice"].includes(info.credentialDeviceType) || typeof info.credentialBackedUp!=="boolean") throw crearErrorHttp("No se pudo validar la clave de acceso",401);
      if(!(await asignacionesDe(cx,cuenta.id)).length) throw crearErrorHttp("No tenés disciplinas asignadas. Contactá a la organización de las Olimpiadas.",403);
      await cx.query(`UPDATE ${tabla} SET contador=?,tipo_dispositivo=?,respaldada=?,fecha_ultimo_uso=NOW(6) WHERE id=?`,[info.newCounter,info.credentialDeviceType,info.credentialBackedUp?1:0,c.id]);
      const sesion=await crearSesionVoluntario({db:cx,cuenta,recordar:Boolean(desafio.recordar),jwtSecret});
      await cx.commit();
      await responderSesion(res,sesion,cuenta);
    } catch(e){await cx.rollback();throw e;} finally{cx.release();}
  }));
}
module.exports={registrarPasskeysVoluntarios,consumirDesafio,transportes};
