"use strict";

// Informa las reservas de presentación instaladas en Miramar. En una base vacía
// el recorrido de prueba se realiza dentro de una transacción que se revierte.
const U = require("../predios/lib/util");
const N = require("../predios/lib/negocio");
const { crearMysql } = require("../predios/lib/db-mysql");
const { ejecutar } = require("../predios/lib/api");
const { operar } = require("../api/services/recepcion");
const CODIGO = "MIRAMAR_DEMO";
const SERVICIO = "DEMO_RECEPCION_CABANAS";
const NOMBRE = "Miramar · Demostración";
const SERVICIO_MIRAMAR = "MIRAMAR_CABANAS";

async function sembrar(pool, aplicar) {
  const db = crearMysql(pool, { predioId: 0 });
  const prueba = new Error("ROLLBACK_DEMO");
  let resumen;
  try {
    return await db.tx(async t => {
      const listarReservas = () => t.all("SELECT r.id,r.precio_total FROM reserva r JOIN servicio s ON s.id=r.servicio_id WHERE s.codigo=? ORDER BY r.id", [SERVICIO]);
      const miramar = await t.get("SELECT servicio_codigos FROM predio WHERE codigo='MIRAMAR'");
      if (miramar && JSON.parse(miramar.servicio_codigos || "[]").includes(SERVICIO_MIRAMAR)) {
        const reservas = await t.all(`SELECT r.id,r.precio_total FROM reserva r
          JOIN servicio s ON s.id=r.servicio_id JOIN usuario u ON u.id=r.usuario_id
          WHERE s.codigo=? AND u.documento IN (?,?,?,?,?) ORDER BY r.id`,
          [SERVICIO_MIRAMAR, "99067310", "99067311", "99067312", "99067313", "99067314"]);
        if (reservas.length) return { existente: true, predio: "MIRAMAR", servicio: SERVICIO_MIRAMAR, reservas };
      }
      if (miramar && JSON.parse(miramar.servicio_codigos || "[]").includes(SERVICIO)) {
        return { existente: true, predio: "MIRAMAR", reservas: await listarReservas() };
      }
      const existente = await t.get("SELECT id,nombre,escritor,servicio_codigos FROM predio WHERE codigo=? FOR UPDATE", [CODIGO]);
      if (existente) {
        if (existente.nombre !== NOMBRE || existente.servicio_codigos !== JSON.stringify([SERVICIO])) throw Error("El código de la demostración ya pertenece a otro predio.");
        // No repone reservas ni pagos que haya modificado el usuario durante la presentación.
        return { existente: true, predio: CODIGO, reservas: await listarReservas() };
      }
      if (aplicar) throw Error("La presentación corresponde a Camping Miramar. Este script sólo permite simular la carga o consultar los ejemplos existentes.");
      if (await t.get("SELECT id FROM servicio WHERE codigo=?", [SERVICIO])) throw Error("Ya existe el código de servicio de demostración.");
      const hoy = U.hoy(), dia = n => U.sumarDias(hoy, n);
      const desde = dia(-30), hasta = dia(100);
      const servicioId = (await t.run(`INSERT INTO servicio (codigo,nombre,descripcion,lugar,tipo_servicio_id,alcance_departamental,modelo_tarifa,unidad_cobro)
        VALUES (?, 'Cabañas · Demostración','Servicio ficticio para la presentación de Recepción.','Miramar',
        (SELECT id FROM tipo_servicio WHERE codigo='ALOJAMIENTO_RECURSO'),'SELECCIONADAS','TEMPORADAS','POR_RECURSO_NOCHE')`, [SERVICIO])).insertId;
      const pid = (await t.run("INSERT INTO predio(codigo,nombre,servicio_codigos) VALUES (?,?,?)", [CODIGO,NOMBRE,JSON.stringify([SERVICIO])])).insertId;
      const predio = { id: pid, nombre: NOMBRE, servicio_codigos: JSON.stringify([SERVICIO]) };
      const actor = { id: null, rol: "ADMIN", nombre: "Recepción · Demostración", bocas: [] };
      const ctx = { db: t, pid, modo: "central", origen: "DEMO", usuario: actor, sesion: {},
        servicios: { recepcion: (accion, b, usuario, tx) => operar(tx.conexionTurismo, predio, usuario, accion, b) } };
      const call = (metodo, ruta, cuerpo = {}, query = {}) => ejecutar({ ...ctx, body: cuerpo, query }, metodo, ruta);
      const { id: regimen } = await t.get("SELECT id FROM regimen WHERE nombre='Único'");
      await t.run("INSERT INTO servicio_regimen(servicio_id,regimen_id) VALUES(?,?)",[servicioId,regimen]);
      const temporada = (await t.run("INSERT INTO temporada_tarifa(nombre,fecha_inicio,fecha_fin,origen) VALUES ('Recepción · Demostración',?,?,'GENERAL')",[desde,hasta])).insertId;
      const recursos = [];
      for (const [i,nombre] of ["Los Aromos", "El Pinar", "Las Dunas"].entries()) {
        const id = (await t.run("INSERT INTO recurso(servicio_id,codigo,nombre,cupo_maximo,orden) VALUES(?,?,?,?,?)", [servicioId,"DEMO_CAB_"+(i+1),"Cabaña "+nombre,4,i+1])).insertId;
        recursos.push(id);
        await t.run(`INSERT INTO tarifa(recurso_id,tipo_persona_id,regimen_id,temporada_tarifa_id,precio,fecha_inicio,fecha_fin,precio_por_persona,usa_porcentaje)
          VALUES (?,4,?,?,?,?,?,'N',0)`,[id,regimen,temporada,18000+i*2000,desde,hasta]);
      }
      // Las tarifas pertenecen sólo a los recursos de este predio.
      const extras = [];
      for (const [nombre,precio] of [["Sombrilla · Demo",3500],["Reposera · Demo",1800],["Bicicleta · Demo",5500]]) {
        if (await t.get("SELECT id FROM adicional WHERE nombre=?",[nombre])) throw Error("Nombre de artículo de demo ya existente: "+nombre);
        let creado;
        for (const recurso_id of recursos) creado = await call("POST","/recepcion/adicionales",{
          servicio_id:servicioId,recurso_id,regimen_id:regimen,nombre,precio,fecha_desde:desde,fecha_hasta:hasta
        });
        extras.push(creado.id);
      }
      const almacen = await N.insertar(t,ctx,"predio_boca",{nombre:"Almacén",es_almacen:1,es_origen:1,es_destino:1,activo:1,orden:1});
      const prov = await N.insertar(t,ctx,"predio_boca",{nombre:"Proveeduría",es_origen:1,es_destino:1,activo:1,orden:2});
      const recep = await N.insertar(t,ctx,"predio_boca",{nombre:"Recepción",es_origen:1,es_destino:1,activo:1,orden:3});
      for (const boca_id of [prov,recep]) await N.insertar(t,ctx,"predio_caja",{nombre:"Caja 1",boca_id,activo:1,ancho_ticket:80});
      await N.guardarConfig(t,ctx,"nombre_predio",NOMBRE);
      const proveedor = await call("POST","/proveedores",{razon_social:"Cooperativa del Faro · Demo",codigo:"DEMO-01"});
      const productos = [];
      for (const [i,[nombre,precio]] of [["Agua mineral",800],["Alfajor de chocolate",1000],["Yerba mate",3200]].entries()) {
        productos.push((await call("POST","/productos",{nombre,codigo:"DEMO"+(1001+i),precio_compra:precio,margen:50,destino:"VENTA_DIRECTA",cantidad_almacen:0})).id);
      }
      await call("POST","/compras",{proveedor_id:proveedor.id,factura:"DEMO-0001",fecha_factura:hoy,total_factura:24*800+24*1000+10*3200,
        items:productos.map((producto_id,i)=>({producto_id,cantidad:[24,24,10][i],precio_unitario:[800,1000,3200][i]}))});
      await call("POST","/traspasos",{boca_origen_id:almacen,boca_destino_id:prov,lineas:productos.map(producto_id=>({producto_id,cantidad:5}))});
      const articulo = (i,cantidad,a,b) => ({adicional_id:extras[i],cantidad,fecha_desde:dia(a),fecha_hasta:dia(b)});
      const casos = [
        { nombre:"Mila",apellido:"Arenas Demo",ini:-1,fin:4,ingreso:-1,rec:[0],ad:[articulo(0,1,-1,0),articulo(1,2,0,1)],nota:"Una huésped, una cabaña y artículos con distintos días de uso." },
        { nombre:"Bruno",apellido:"Médano Demo",ini:-4,fin:-1,ingreso:-4,rec:[2],ad:[articulo(1,1,-3,-2)],nota:"Salida prevista vencida. Se puede ampliar sin superponer la próxima reserva." },
        { nombre:"Luz",apellido:"Ribera Demo",ini:7,fin:10,rec:[0],ad:[articulo(2,1,8,8)],nota:"Próximo ingreso con una bicicleta reservada por un día." },
        { nombre:"Vera",apellido:"Salinas Demo",ini:-8,fin:-6,ingreso:-8,salida:-6,rec:[0],ad:[articulo(0,1,-7,-7)],pago:true,nota:"Estadía finalizada y abonada por transferencia." },
        { nombre:"Felipe",apellido:"Faro Demo",tipo:"CONTINGENTE",ini:0,fin:0,ingreso:0,rec:[],cantidad:12,manual:48000,nota:"Visita en el día de un grupo de doce personas." }
      ];
      const reservas = [];
      for (const [i,s] of casos.entries()) {
        const dni = String(99067310 + i);
        if (await t.get("SELECT id FROM usuario WHERE documento=?",[dni])) throw Error("El DNI ficticio ya está en uso.");
        const persona = { dni,nombre:s.nombre,apellido:s.apellido,fecha_nacimiento:"1987-03-12",parentesco_id:1,tipo_persona_id:4,
          entrada:s.ingreso!=null?dia(s.ingreso):null,salida:s.salida!=null?dia(s.salida):null };
        const ids = s.rec.map(j=>recursos[j]);
        const alta = await call("POST","/recepcion/guardar",{operacion:U.uuid(),tipo:s.tipo||"GENERAL",servicio_id:servicioId,
          titular_dni:dni,particular:persona,personas:[persona],fecha_inicio:dia(s.ini),fecha_fin:dia(s.fin),recursos_ids:ids,
          recurso_id:ids[0]||null,regimen_id:ids.length?regimen:null,adicionales:s.ad||[],cantidad:s.cantidad||1,
          manual:s.manual??null,entidad:s.tipo?"Taller del Faro · Demo":null,observaciones:s.nota});
        if (s.pago) await call("POST","/recepcion/"+alta.id+"/cuenta",{operacion:U.uuid(),accion:"PAGO_RESERVA",medio:"TRANSFERENCIA",esperado:alta.diferencia,detalle:"Pago ficticio de la estadía finalizada."});
        reservas.push({id:alta.id,titular:s.nombre+" "+s.apellido,total:alta.total});
      }
      resumen = {predio:CODIGO,hoy,reservas};
      // Ensayar el recorrido completo antes de revertir la transacción.
      const assert = require("node:assert/strict");
      const detalle = id => call("GET","/recepcion/detalle",{}, {id});
      const filtrar = () => call("GET","/recepcion/listar",{}, {ocupacion:"VENCIDA"});
      const vencida = reservas[1].id;
      assert.deepEqual((await filtrar()).filas.map(r=>r.id),[vencida]);
      assert.equal((await detalle(reservas[3].id)).cuenta.pendiente,0);
      const armar = r => ({id:r.id,version:r.version,tipo:r.tipo,servicio_id:r.servicio_id,
        recurso_id:r.recurso_id,recursos_ids:r.recursos.map(x=>x.id),regimen_id:r.regimen_id,
        titular_dni:r.titular_dni,personas:r.personas,fecha_inicio:r.fecha_inicio,fecha_fin:r.fecha_fin,
        adicionales:r.adicionales_vigentes,operacion:U.uuid()});
      const cotizar = b => call("POST","/recepcion/cotizar",b);
      const confirmar = (b,cot) => call("POST","/recepcion/guardar",{...b,cuenta_esperada:cot.cuenta,cotizacion_esperada:cot.cotizacion_esperada});
      const individual = (await detalle(reservas[0].id)).reserva;
      assert.equal(individual.personas.length,1);
      assert.equal(individual.recursos.length,1);
      const futura = armar((await detalle(reservas[2].id)).reserva);
      await assert.rejects(cotizar({...futura,fecha_inicio:hoy,fecha_fin:dia(2),recurso_id:recursos[0],recursos_ids:[recursos[0]],adicionales:[]}),/ocupad|reserva|disponib/i);
      const ampliar = armar((await detalle(vencida)).reserva);
      ampliar.fecha_fin = dia(1);
      ampliar.adicionales[0].fecha_hasta = hoy;
      const revision = await cotizar(ampliar);
      assert.ok(revision.diferencia>0);
      await confirmar(ampliar,revision);
      assert.equal((await filtrar()).cantidad,0);
      const salida = armar((await detalle(vencida)).reserva);
      salida.fecha_fin=hoy;
      salida.personas[0].salida=hoy;
      const final = await cotizar(salida);
      await confirmar(salida,final);
      assert.equal((await detalle(vencida)).cuenta.pendiente,final.total);
      await call("POST","/recepcion/"+vencida+"/cuenta",{accion:"PAGO_RESERVA",medio:"TRANSFERENCIA",esperado:final.total,operacion:U.uuid()});
      assert.equal((await detalle(vencida)).cuenta.pendiente,0);
      resumen.verificado = {recursos:individual.recursos.length,vencidas_tras_prorroga:0,checkout:final.total,saldo_tras_cobro:0};
      throw prueba;
    });
  } catch (e) {
    if (e === prueba) return { ...resumen, simulacion:true };
    throw e;
  }
}

if (require.main === module) (async () => {
  const f = process.argv.find(s=>s.startsWith("--env-file="))?.slice(11) || ".env";
  if (process.argv.includes("--target=develop")) {
    const env = require("./migrar-webauthn-v1").parsearBloquesEnv(require("node:fs").readFileSync(f,"utf8")).develop;
    if (!["localhost","127.0.0.1","::1"].includes(env.DB_HOST)) throw Error("Se esperaba una base local de desarrollo.");
    Object.assign(process.env,env);
  } else require("dotenv").config({ path:f });
  const apply = process.argv.includes("--apply");
  if (apply && !["localhost","127.0.0.1","::1"].includes(process.env.DB_HOST) && !process.argv.includes("--allow-production")) throw Error("Un destino remoto exige --allow-production.");
  const pool = require("../api/connection/connection").promise();
  try { console.log(JSON.stringify(await sembrar(pool,apply),null,2)); } finally { await pool.end(); }
})().catch(e=>{console.error(e.code||"",e.message);process.exitCode=1;});
module.exports = { sembrar };
