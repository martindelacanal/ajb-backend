"use strict";
// MySQL local aislado: copia estructuras, crea identidades sintéticas y elimina
// exclusivamente su base temporal. SMTP simulado; WebAuthn usa firmas reales P-256.
const fs=require("node:fs"); const path=require("node:path"); const crypto=require("node:crypto");
const assert=require("node:assert/strict"); const mysql=require("mysql2/promise"); const bcrypt=require("bcryptjs");
const express=require("express"); const {isoCBOR}=require("@simplewebauthn/server/helpers");
const {parsearBloquesEnv,crearOpcionesConexion}=require("./migrar-webauthn-v1");
const schema=`ajb_test_oli_acceso_${Date.now()}`;
const source=parsearBloquesEnv(fs.readFileSync(path.resolve(__dirname,"../.env"),"utf8")).develop;
const secret=crypto.randomBytes(48).toString("hex");
const clave="Prueba!Olimpiadas2026"; const nueva="Nueva!Olimpiadas2026";
const origin="http://localhost:4200"; const mensajes=[]; const checks=[];
let intercalarRegistro=null;
let admin,db,server,base,poolDefault;
function ok(texto){checks.push(texto);console.log(`[QA acceso] OK ${texto}`);}
async function api(ruta,body,token,esperado=200,metodo=body===undefined?"GET":"POST",headers={}) {
  const r=await fetch(base+ruta,{method:metodo,headers:{"Content-Type":"application/json",Origin:origin,...(token?{Authorization:`Bearer ${token}`} : {}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await r.text(); let data;try{data=JSON.parse(raw);}catch(_){data=raw;}
  assert.equal(r.status,esperado,`${metodo} ${ruta} ${r.status}: ${JSON.stringify(data)}`);return data;
}
const auth=(path)=>`/olimpiadas/voluntarios${path}`;
const login=(identificador="qa.externo",password=clave,recordar=true)=>api(auth("/login"),{identificador,password,recordar});
const b64=(buffer)=>Buffer.from(buffer).toString("base64url");
const sha=(buffer)=>crypto.createHash("sha256").update(buffer).digest();
function crearAutenticador() {
  const {privateKey,publicKey}=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const jwk=publicKey.export({format:"jwk"}); const id=crypto.randomBytes(32);let counter=0;
  const cose=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,"base64url")],[-3,Buffer.from(jwk.y,"base64url")]]));
  return {id:b64(id),cose:Buffer.from(cose),userHandle:null,
    registro(options){this.userHandle=options.user.id;const len=Buffer.alloc(2);len.writeUInt16BE(id.length);
      const authData=Buffer.concat([sha("localhost"),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),len,id,Buffer.from(cose)]);
      const client=Buffer.from(JSON.stringify({type:"webauthn.create",challenge:options.challenge,origin,crossOrigin:false}));
      const attestation=isoCBOR.encode(new Map([["fmt","none"],["attStmt",new Map()],["authData",authData]]));
      return {id:b64(id),rawId:b64(id),type:"public-key",response:{attestationObject:b64(attestation),clientDataJSON:b64(client),transports:["internal"]},clientExtensionResults:{}};},
    firma(options,{uv=true,challenge=options.challenge}={}){counter++;const count=Buffer.alloc(4);count.writeUInt32BE(counter);
      const authData=Buffer.concat([sha("localhost"),Buffer.from([uv?0x05:0x01]),count]);
      const client=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin,crossOrigin:false}));
      const signature=crypto.sign("sha256",Buffer.concat([authData,sha(client)]),privateKey);
      return {id:b64(id),rawId:b64(id),type:"public-key",response:{authenticatorData:b64(authData),clientDataJSON:b64(client),signature:b64(signature),userHandle:this.userHandle},clientExtensionResults:{}};}
  };
}
async function setup(){
  if(!process.argv.includes("--run-local") || !["localhost","127.0.0.1","::1"].includes(source.DB_HOST)) throw new Error("Sólo ejecutar --run-local contra develop localhost");
  const options=crearOpcionesConexion({...source,DB_SSL_MODE:"disabled",DB_SSL_CA_PATH:""});
  admin=await mysql.createConnection(options);await admin.query(`CREATE DATABASE ${admin.escapeId(schema)}`);
  db=mysql.createPool({...options,database:schema,connectionLimit:8});
  db.on("connection",c=>c.query("SET SESSION time_zone='-03:00'"));
  for(const tabla of ["rol","departamental","usuario","olimpiada","olimpiada_disciplina_tipo","olimpiada_disciplina","olimpiada_disciplina_config","olimpiada_historial","olimpiada_voluntario","olimpiada_voluntario_disciplina","auth_limite","auth_recuperacion","auth_sesion","webauthn_credencial"])
    await db.query(`CREATE TABLE ${db.escapeId(tabla)} LIKE ${db.escapeId(source.DB_DATABASE)}.${db.escapeId(tabla)}`);
  await db.query("INSERT INTO rol(id,nombre) VALUES (1,'admin'),(2,'afiliado'),(3,'departamental'),(4,'invitado')");
  await db.query("INSERT INTO departamental(id,nombre) VALUES(1,'QA Departamental')");
  const hash=await bcrypt.hash(clave,4);
  for(const [id,rol] of [[1,1],[2,3],[3,2],[4,4]]) await db.query("INSERT INTO usuario (id,rol_id,departamental_id,nombre,apellido,documento,email,password,habilitado) VALUES(?,?,1,'QA','Cuenta',?,?,?,'Y')",[id,rol,99001000+id,`qa-${id}@example.invalid`,hash]);
  await db.query("INSERT INTO olimpiada(id,nombre,fecha_inicio,fecha_fin,fecha_inicio_inscripcion,fecha_fin_inscripcion,habilitado) VALUES(1,'QA Olimpiadas',CURDATE(),CURDATE(),CURDATE(),CURDATE(),'Y')");
  await db.query("INSERT INTO olimpiada_disciplina_tipo(id,nombre,habilitado) VALUES(1,'QA categoría','Y')");
  await db.query("INSERT INTO olimpiada_disciplina(id,nombre,tipo_id,habilitado) VALUES(1,'QA Tejo',1,'Y')");
  await db.query("INSERT INTO olimpiada_disciplina_config(olimpiada_id,disciplina_id) VALUES(1,1)");
  const cx=await db.getConnection();try{const migration=require("./migrar-olimpiadas-acceso-v2");await migration.aplicarMigracion(cx);await migration.aplicarMigracion(cx);}finally{cx.release();}
  Object.assign(process.env,source,{DB_DATABASE:schema,DB_SSL_MODE:"disabled",JWT_SECRET:secret,MAIL_ENABLED:"false",NODE_ENV:"test"});
  const {crearRouterVoluntarios}=require("../api/routes/olimpiadas-voluntarios");
  poolDefault=require("../api/connection/connection").promise();
  const app=express(); app.use(express.json());
  app.use(crearRouterVoluntarios({db,jwtSecret:secret,origenesPermitidos:new Set([origin]),
    webauthnLib:{...require("@simplewebauthn/server"),verifyRegistrationResponse:async(args)=>{
      const resultado=await require("@simplewebauthn/server").verifyRegistrationResponse(args);
      if(intercalarRegistro){const intercalar=intercalarRegistro;intercalarRegistro=null;await intercalar();}
      return resultado;
    }},
    verificarAdmin:(req,_res,next)=>{req.data={data:JSON.stringify({id:1,rol:"admin"})};next();},
    enviar:async(mensaje)=>{mensajes.push(mensaje);return {enviado:true};}}));
  const {crearVerificadorCompeticion}=require("../api/security/olimpiadas-voluntarios");
  app.post("/olimpiadas/probe-write",crearVerificadorCompeticion({db,jwtSecret:secret,verificarNormal:(_req,res)=>res.sendStatus(401)}),(_req,res)=>res.json({ok:true}));
  server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}`;
  ok("migración idempotente sobre estructuras reales y datos sintéticos");
}
async function verify(){
  const alta=await api("/olimpiadas/1/voluntarios",{nombre:"QA Externo",usuario:"qa.externo",email:"qa-externo@example.invalid",password:clave,disciplina_ids:[1]},null,201);
  let sesion=await login();assert.ok(sesion.refreshToken);assert.equal(sesion.voluntario.cuenta_sistema,false);
  await api(auth("/me"),undefined,sesion.token);
  const s2=await api(auth("/sesion/renovar"),{refreshToken:sesion.refreshToken});assert.notEqual(s2.refreshToken,sesion.refreshToken);
  const s3=await api(auth("/sesion/renovar"),{refreshToken:sesion.refreshToken});assert.equal(s3.refreshToken,s2.refreshToken);
  await db.query("UPDATE olimpiada_voluntario_sesion SET gracia_hasta=DATE_SUB(NOW(6),INTERVAL 1 SECOND)");
  await api(auth("/sesion/renovar"),{refreshToken:sesion.refreshToken},null,401);
  await api(auth("/sesion/cerrar"),{refreshToken:s2.refreshToken},sesion.token,204);
  await api(auth("/me"),undefined,sesion.token,401);await api(auth("/sesion/renovar"),{refreshToken:s2.refreshToken},null,401);
  sesion=await login("qa.externo",clave,false);assert.equal(sesion.refreshToken,undefined);
  ok("mantener sesión rota refresh con pestañas concurrentes y cierre revoca JWT y refresh");
  const autenticador=crearAutenticador();
  await api(auth("/passkeys/registration/options"),{},sesion.token,403,"POST",{Origin:"https://intruso.invalid"});
  const ro=await api(auth("/passkeys/registration/options"),{},sesion.token);assert.equal(ro.opciones.authenticatorSelection.userVerification,"required");
  const rv={ceremonia_id:ro.ceremonia_id,respuesta:autenticador.registro(ro.opciones),nombre:"Dispositivo QA"};
  await api(auth("/passkeys/registration/verify"),rv,sesion.token,201);
  await api(auth("/passkeys/registration/verify"),rv,sesion.token,400);
  const ao=await api(auth("/passkeys/authentication/options"),{recordar:true});assert.equal(ao.opciones.userVerification,"required");
  const av={ceremonia_id:ao.ceremonia_id,respuesta:autenticador.firma(ao.opciones)};
  const biometrica=await api(auth("/passkeys/authentication/verify"),av);assert.ok(biometrica.refreshToken);
  await api(auth("/passkeys/authentication/verify"),av,null,400);
  for(const invalido of [{uv:false},{challenge:"incorrecto"}]){
    const o=await api(auth("/passkeys/authentication/options"),{});
    await api(auth("/passkeys/authentication/verify"),{ceremonia_id:o.ceremonia_id,respuesta:autenticador.firma(o.opciones,invalido)},null,401);
  }
  ok("WebAuthn real P-256: registro/acceso correctos; rechaza origen ajeno, replay, challenge alterado y sin verificación de persona");
  const antes=mensajes.length;
  await api(auth("/recuperacion/solicitar"),{identificador:"inexistente"});assert.equal(mensajes.length,antes);
  await api(auth("/recuperacion/solicitar"),{identificador:"qa.externo"});
  await new Promise(resolve=>setTimeout(resolve,30));const codigo=mensajes.at(-1).datos[0].valor;
  await api(auth("/recuperacion/verificar"),{identificador:"qa.externo",codigo:"000xyz"},null,400);
  const ticket=await api(auth("/recuperacion/verificar"),{identificador:"qa.externo",codigo});assert.equal(ticket.politicaPassword,"personal");
  await api(auth("/recuperacion/verificar"),{identificador:"qa.externo",codigo},null,400);
  await api(auth("/recuperacion/restablecer"),{resetToken:ticket.resetToken,password:nueva});
  await api(auth("/recuperacion/restablecer"),{resetToken:ticket.resetToken,password:nueva},null,400);
  await api(auth("/me"),undefined,sesion.token,401);await api(auth("/sesion/renovar"),{refreshToken:biometrica.refreshToken},null,401);
  sesion=await login("qa.externo",nueva);assert.equal((await api(auth("/passkeys"),undefined,sesion.token)).length,0);
  await api(auth("/perfil"),{nombre:"Nombre actualizado"},sesion.token,200,"PUT");
  await api(auth("/perfil"),{email:"nuevo@example.invalid",password_actual:"errónea"},sesion.token,400,"PUT");
  const p=await api(auth("/perfil"),{email:"nuevo@example.invalid",password_actual:nueva},sesion.token,200,"PUT");assert.equal(p.requiere_login,true);
  await api(auth("/me"),undefined,sesion.token,401);
  ok("recuperación no enumera cuentas, código/ticket son de un uso; revoca sesiones y passkeys; perfil exige contraseña actual");
  const linked=await api("/olimpiadas/1/voluntarios/vincular",{usuario_sistema_id:2,disciplina_ids:[1]},null,201);
  const linkedAgain=await api("/olimpiadas/1/voluntarios/vincular",{usuario_sistema_id:2,disciplina_ids:[1]},null,201);assert.equal(linked.id,linkedAgain.id);
  await api("/olimpiadas/1/voluntarios/vincular",{usuario_sistema_id:3,disciplina_ids:[1]},null,201);
  await api("/olimpiadas/1/voluntarios/vincular",{usuario_sistema_id:4,disciplina_ids:[1]},null,400);
  const busqueda=await api("/olimpiadas/1/usuarios-disponibles?q=QA");assert.ok(busqueda.some(u=>u.id===2));assert.ok(busqueda.some(u=>u.id===3));assert.ok(!busqueda.some(u=>u.id===4));
  let sistema=await login("99001002");assert.equal(sistema.voluntario.usuario_sistema_id,2);
  // Credencial que ya pertenece al login general; reutilizarla nunca emite JWT general.
  const habitual=crearAutenticador();habitual.userHandle=b64("miajb-usuario:2");
  await db.query(`INSERT INTO webauthn_credencial(usuario_id,rp_id,webauthn_usuario_id,credential_id,clave_publica,contador,tipo_dispositivo,respaldada,nombre)
    VALUES(2,'localhost',?,?,?,0,'singleDevice',0,'Clave habitual QA')`,[habitual.userHandle,habitual.id,habitual.cose]);
  async function usarHabitual(esperado=200){const op=await api(auth("/passkeys/authentication/options"),{recordar:true});return api(auth("/passkeys/authentication/verify"),{ceremonia_id:op.ceremonia_id,respuesta:habitual.firma(op.opciones)},null,esperado);}
  const porClaveHabitual=await usarHabitual();assert.equal(porClaveHabitual.voluntario.usuario_sistema_id,2);
  assert.throws(()=>require("jsonwebtoken").verify(porClaveHabitual.token,secret),/signature/);
  await db.query("DELETE FROM olimpiada_voluntario_disciplina WHERE voluntario_id=?",[linked.id]);await usarHabitual(403);
  await db.query("INSERT INTO olimpiada_voluntario_disciplina(voluntario_id,olimpiada_id,disciplina_id) VALUES(?,1,1)",[linked.id]);
  const noVinculada=crearAutenticador();noVinculada.userHandle=b64("miajb-usuario:1");
  await db.query(`INSERT INTO webauthn_credencial(usuario_id,rp_id,webauthn_usuario_id,credential_id,clave_publica,contador,tipo_dispositivo,respaldada,nombre)
    VALUES(1,'localhost',?,?,?,0,'singleDevice',0,'Sin vínculo QA')`,[noVinculada.userHandle,noVinculada.id,noVinculada.cose]);
  const opNo=await api(auth("/passkeys/authentication/options"),{});await api(auth("/passkeys/authentication/verify"),{ceremonia_id:opNo.ceremonia_id,respuesta:noVinculada.firma(opNo.opciones)},null,401);
  ok("passkey habitual de Mi AJB reutilizada sólo con vínculo y disciplinas; emite token aislado y rechaza cuentas sin vínculo");
  const [[antesCuenta]]=await db.query("SELECT password,rol_id FROM usuario WHERE id=2");
  await api("/olimpiadas/1/voluntarios/enviar-bienvenida",{voluntario_ids:[linked.id]});
  assert.ok(!mensajes.at(-1).datos.some(d=>/contraseña/i.test(d.etiqueta)));
  const [[despuesCuenta]]=await db.query("SELECT password,rol_id FROM usuario WHERE id=2");assert.deepEqual(antesCuenta,despuesCuenta);
  await api(`/olimpiadas/1/voluntarios/${linked.id}`,{password:nueva,disciplina_ids:[1]},null,400,"PUT");
  await api(auth("/perfil"),{nombre:"No cambia"},sistema.token,409,"PUT");
  const llaveSistema=crearAutenticador();const registroSistema=await api(auth("/passkeys/registration/options"),{},sistema.token);
  intercalarRegistro=async()=>db.query("UPDATE usuario SET password=? WHERE id=2",[await bcrypt.hash(nueva,4)]);
  await api(auth("/passkeys/registration/verify"),{ceremonia_id:registroSistema.ceremonia_id,respuesta:llaveSistema.registro(registroSistema.opciones)},sistema.token,401);
  await db.query("UPDATE usuario SET password=? WHERE id=2",[antesCuenta.password]);
  assert.equal((await api(auth("/passkeys"),undefined,sistema.token)).length,0);
  ok("registro biométrico rechaza contraseña habitual cambiada durante la verificación criptográfica");
  await db.query("UPDATE usuario SET requiere_cambio_clave=1 WHERE id=2");
  await api(auth("/recuperacion/solicitar"),{identificador:"qa-2@example.invalid"});await new Promise(resolve=>setTimeout(resolve,30));
  const sistemaTicket=await api(auth("/recuperacion/verificar"),{identificador:"qa-2@example.invalid",codigo:mensajes.at(-1).datos[0].valor});
  const errorPolitica=await api(auth("/recuperacion/restablecer"),{resetToken:sistemaTicket.resetToken,password:"Nueva!Clave99001002"},null,400);
  assert.equal(errorPolitica.code,"PASSWORD_POLICY");
  await api(auth("/recuperacion/restablecer"),{resetToken:sistemaTicket.resetToken,password:clave});
  sistema=await login("99001002");
  ok("recuperación de cuenta vinculada con cambio obligatorio usa flujo habitual y conserva ticket ante política de contraseña");
  ok("reutiliza personal y afiliado, excluye invitado; bienvenida y administración no cambian clave ni rol originales");
  await db.query("UPDATE usuario SET bloqueo_tipo='modulos',bloqueo_modulos='[\"olimpiadas\"]' WHERE id=2");
  await api("/olimpiadas/probe-write",{},sistema.token,403);await api(auth("/me"),undefined,sistema.token);
  await db.query("UPDATE usuario SET bloqueo_tipo='total' WHERE id=2");await api(auth("/me"),undefined,sistema.token,403);
  await db.query("UPDATE usuario SET bloqueo_tipo=NULL,bloqueo_modulos=NULL,habilitado='N' WHERE id=2");await api(auth("/me"),undefined,sistema.token,401);
  await db.query("UPDATE usuario SET habilitado='Y',auth_revocado_desde=NOW(6) WHERE id=2");await api(auth("/me"),undefined,sistema.token,401);
  await api(auth("/sesion/renovar"),{refreshToken:sistema.refreshToken},null,401);
  sistema=await login("qa-2@example.invalid");await db.query("UPDATE usuario SET password=? WHERE id=2",[await bcrypt.hash(nueva,4)]);
  await api(auth("/me"),undefined,sistema.token,401);
  ok("cuenta vinculada respeta bloqueo de módulo, bloqueo total, deshabilitación, revocación y cambio de contraseña en cada acceso");
  // Caducidad y máximo de intentos con el mismo flujo persistente.
  await db.query("UPDATE olimpiada_voluntario_recuperacion SET solicitado_en=DATE_SUB(NOW(6),INTERVAL 61 SECOND) WHERE usuario_id=?",[alta.id]);
  await api(auth("/recuperacion/solicitar"),{identificador:"qa.externo"});await new Promise(resolve=>setTimeout(resolve,30));
  const correcto=mensajes.at(-1).datos[0].valor;
  await db.query("UPDATE olimpiada_voluntario_recuperacion SET vence_en=DATE_SUB(NOW(6),INTERVAL 1 SECOND) WHERE usuario_id=?",[alta.id]);
  await api(auth("/recuperacion/verificar"),{identificador:"qa.externo",codigo:correcto},null,400);
  await db.query("UPDATE olimpiada_voluntario_recuperacion SET vence_en=DATE_ADD(NOW(6),INTERVAL 10 MINUTE) WHERE usuario_id=?",[alta.id]);
  for(let n=0;n<5;n++) await api(auth("/recuperacion/verificar"),{identificador:"qa.externo",codigo:correcto==="111111"?"222222":"111111"},null,400);
  await api(auth("/recuperacion/verificar"),{identificador:"qa.externo",codigo:correcto},null,400);
  const {limitar}=require("../api/security/recuperacion-password");await limitar(db,"qa:limite",1,60,secret);await assert.rejects(limitar(db,"qa:limite",1,60,secret),{statusCode:429});
  ok("MySQL aplica vencimiento, cinco intentos máximos y límites persistentes");
}
async function cleanup(){
  if(server)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
  if(poolDefault)await poolDefault.end();if(db)await db.end();
  if(admin){assert.match(schema,/^ajb_test_oli_acceso_\d+$/);await admin.query(`DROP DATABASE ${admin.escapeId(schema)}`);await admin.end();}
}
(async()=>{let error;try{await setup();await verify();}catch(e){error=e;console.error(e.stack);}finally{try{await cleanup();}catch(e){error||=e;console.error(e.message);}
  const out=path.resolve(__dirname,"../../output/qa-olimpiadas-acceso.json");fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({exito:!error,checks,limpieza_completada:!error,correos_reales:0,fecha:new Date().toISOString()},null,2));}
  if(error)process.exitCode=1;})();
