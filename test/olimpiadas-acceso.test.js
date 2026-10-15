"use strict";
const test=require("node:test");const assert=require("node:assert/strict");const jwt=require("jsonwebtoken");
const {huella,huellaPassword}=require("../api/security/auth-crypto");
const {crearTokenVoluntario,autenticarVoluntario}=require("../api/security/olimpiadas-voluntarios");
const {renovarSesionVoluntario,cerrarSesionVoluntario}=require("../api/security/olimpiadas-acceso");
const {consumirDesafio}=require("../api/routes/olimpiadas-passkeys");
const secret="pruebas-olimpiadas-acceso-secreto"; const tokenA="a".repeat(43);const tokenB="b".repeat(43);
function casoSesion(){
  const v={id:5,nombre:"Ana",usuario:"ana",email:"ana@example.invalid",password_hash:"hash-vigente",sesion_version:2,habilitado:1};
  const s={id:"c7785590-8158-4adb-af89-6c4c47989e35",voluntario_id:5,refresh_hash:huella(tokenB,"oli-refresh",secret),
    refresh_anterior_hash:huella(tokenA,"oli-refresh",secret),password_version:huellaPassword(v.password_hash,secret),sesion_version:2,en_gracia:0};
  let updates=0; const cx={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},query:async(sql)=>{
    if(sql.startsWith("SELECT voluntario_id"))return [[{voluntario_id:5}]];
    if(sql.includes("FROM olimpiada_voluntario WHERE"))return [[v]];
    if(sql.includes("FROM olimpiada_voluntario_sesion"))return [[s]];
    if(sql.startsWith("UPDATE")){updates++;return [{affectedRows:1}];}throw new Error(sql);
  }};return {v,s,db:{getConnection:async()=>cx,query:cx.query},updates:()=>updates};
}
test("refresh predecesor fuera de gracia no renueva ni modifica la sesión actual",async()=>{
  const c=casoSesion();await assert.rejects(renovarSesionVoluntario({db:c.db,refreshToken:tokenA,jwtSecret:secret}),{statusCode:401});assert.equal(c.updates(),0);
});
test("refresh vigente rota y predecesor en gracia converge al mismo sucesor",async()=>{
  const c=casoSesion();c.s.refresh_hash=huella(tokenA,"oli-refresh",secret);
  const primero=await renovarSesionVoluntario({db:c.db,refreshToken:tokenA,jwtSecret:secret});
  c.s.refresh_hash=huella(primero.refreshToken,"oli-refresh",secret);c.s.en_gracia=1;
  const segundo=await renovarSesionVoluntario({db:c.db,refreshToken:tokenA,jwtSecret:secret});
  assert.equal(primero.refreshToken,segundo.refreshToken);assert.equal(c.updates(),1);assert.throws(()=>jwt.verify(primero.token,secret),/signature/);
});
test("refresh revoca por cambio de versión o contraseña antes de emitir JWT",async()=>{
  for(const cambiar of [c=>{c.v.sesion_version=3;},c=>{c.v.password_hash="otro-hash";},c=>{c.v.habilitado=0;}]){
    const c=casoSesion();cambiar(c);await assert.rejects(renovarSesionVoluntario({db:c.db,refreshToken:tokenB,jwtSecret:secret}),{statusCode:401});assert.equal(c.updates(),0);
  }
});
test("sesión con sid exige huella actual y registro persistido incluso con JWT firmado",async()=>{
  const c=casoSesion();const token=crearTokenVoluntario(c.v,secret,c.s.id);
  assert.equal((await autenticarVoluntario({token,db:c.db,jwtSecret:secret})).voluntario_id,5);
  c.v.password_hash="nuevo";await assert.rejects(autenticarVoluntario({token,db:c.db,jwtSecret:secret}),{statusCode:401});
});
test("cierre acepta refresh independiente y nunca revoca un sid de token con firma general",async()=>{
  const consultas=[];const db={query:async(sql,args)=>{consultas.push({sql,args});return [{affectedRows:1}];}};
  const token=jwt.sign({sid:"c7785590-8158-4adb-af89-6c4c47989e35"},secret);
  await cerrarSesionVoluntario({db,token,refreshToken:tokenA,jwtSecret:secret});assert.equal(consultas.length,1);assert.ok(consultas[0].sql.includes("refresh_hash"));
});
test("cerrar token anterior sin sid revoca su generación con firma aislada válida",async()=>{
  const consultas=[];const c=casoSesion();const db={query:async(sql,args)=>{consultas.push({sql,args});return [{affectedRows:1}];}};
  await cerrarSesionVoluntario({db,token:crearTokenVoluntario(c.v,secret),jwtSecret:secret});
  assert.equal(consultas.length,1);assert.match(consultas[0].sql,/sesion_version=sesion_version\+1/);assert.deepEqual(consultas[0].args,["5",2]);
});
test("desafío de registro consume una vez y está ligado a origen, RP, persona y versión",async()=>{
  let usado=false;let parametros;
  const db={query:async(sql,args)=>{
    if(sql.startsWith("UPDATE")){parametros=args;const affectedRows=usado?0:1;usado=true;return [{affectedRows}];}
    return [[{challenge:"desafio"}]];
  }};
  const data={id:"c7785590-8158-4adb-af89-6c4c47989e35",tipo:"REGISTRO",contexto:{origen:"https://miajb.test",rpID:"miajb.test"},voluntarioId:5,version:2};
  await consumirDesafio(db,data);assert.deepEqual(parametros,[data.id,"REGISTRO","https://miajb.test","miajb.test",5,2]);
  await assert.rejects(consumirDesafio(db,data),{statusCode:400});
});
