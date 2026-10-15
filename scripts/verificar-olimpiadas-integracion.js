"use strict";

// Integración real, exclusivamente LOCAL DEVELOP. Crea datos QA identificados,
// prueba la API completa y los elimina por IDs capturados en finally. Nunca manda correo.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { parsearBloquesEnv } = require("./migrar-webauthn-v1");

async function main() {
  if (!process.argv.includes("--run-local")) throw new Error("Usar --run-local para crear y limpiar registros QA en develop local");
  const env = fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8");
  const develop = parsearBloquesEnv(env).develop;
  if (!["localhost", "127.0.0.1", "::1"].includes(develop.DB_HOST) || /prod/i.test(develop.DB_DATABASE || "")) throw new Error("Sólo se admite develop en localhost");
  Object.assign(process.env, dotenv.parse(env), develop, { NODE_ENV: "development", MAIL_ENABLED: "false", JWT_SECRET: crypto.randomBytes(48).toString("hex") });
  const app = require("../app");
  const pool = require("../api/connection/connection").promise();
  const { fechaHoyBuenosAires } = require("../api/services/olimpiadas-comun");
  const { huella } = require("../api/security/auth-crypto");
  const nonce = crypto.randomBytes(5).toString("hex");
  const prefijo = `QA-OLI-${nonce}`;
  const username = `qa.${nonce}`;
  const password = `Qa!${crypto.randomBytes(12).toString("hex")}7a`;
  const ip = `198.18.${parseInt(nonce.slice(0, 2), 16)}.${parseInt(nonce.slice(2, 4), 16)}`;
  const ids = {};
  const resultados = [];
  let server;
  let fallo;
  let limpiado = false;
  const registrar = (prueba, detalle) => { resultados.push({ prueba, resultado: "OK", ...(detalle ? { detalle } : {}) }); console.log(`[QA develop] OK ${prueba}`); };
  try {
    const [[admin]] = await pool.query(`SELECT u.id FROM usuario u INNER JOIN rol r ON r.id=u.rol_id
      WHERE r.nombre IN ('admin','admin-central') AND u.habilitado='Y' AND COALESCE(u.requiere_cambio_clave,0)=0
      AND (u.bloqueo_tipo IS NULL OR u.bloqueo_tipo NOT IN ('total','modulos')) LIMIT 1`);
    const [disciplinas] = await pool.query("SELECT d.id,d.tipo_id FROM olimpiada_disciplina d INNER JOIN olimpiada_disciplina_tipo t ON t.id=d.tipo_id WHERE d.habilitado='Y' AND t.habilitado='Y' ORDER BY d.id LIMIT 2");
    const [deps] = await pool.query("SELECT id FROM departamental ORDER BY id LIMIT 2");
    const [[afiliado]] = await pool.query("SELECT u.id,u.departamental_id,u.nombre,u.apellido FROM usuario u INNER JOIN rol r ON r.id=u.rol_id WHERE r.nombre='afiliado' AND u.departamental_id IS NOT NULL ORDER BY u.id LIMIT 1");
    assert.ok(admin && afiliado && disciplinas.length === 2 && deps.length === 2, "Faltan catálogos o cuentas en develop");
    const adminToken = jwt.sign({ data: JSON.stringify({ id: admin.id, rol: "admin" }) }, process.env.JWT_SECRET, { expiresIn: "10m" });
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function api(metodo, ruta, body, token = adminToken, esperado = 200) {
      const response = await fetch(`${base}${ruta}`, { method: metodo, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const contenido = await response.text();
      let data; try { data = JSON.parse(contenido); } catch { data = contenido; }
      assert.equal(response.status, esperado, `${metodo} ${ruta}: ${response.status}; ${typeof data === "string" ? data.slice(0, 220) : data?.mensaje || "respuesta inesperada"}`);
      return data;
    }
    const hoy = fechaHoyBuenosAires();
    const edicion = { nombre: prefijo, fecha_inicio: hoy, fecha_fin: hoy, fecha_inicio_inscripcion: hoy, fecha_fin_inscripcion: hoy,
      descripcion: "Integración automatizada temporal en develop", localidad: "Predio QA", requiere_aprobacion: 0, exigir_bonos_para_validar: 0,
      publicada_publico: 0, disciplinas: disciplinas.map((d) => ({ disciplina_id: d.id, max_por_departamental: null })) };
    ids.edicion = (await api("POST", "/olimpiadas", edicion, adminToken, 201)).id;
    const [[persistida]] = await pool.query("SELECT requiere_aprobacion FROM olimpiada WHERE id=?", [ids.edicion]);
    assert.equal(Number(persistida.requiere_aprobacion), 1);
    await api("GET", `/olimpiadas/publico/${ids.edicion}/fixture`, null, null, 404);
    registrar("edición creada con aprobación obligatoria y publicación privada");

    ids.lugar = (await api("POST", "/olimpiadas/competicion/lugares", { nombre: `${prefijo} Cancha`, predio: "Predio QA", direccion: "Ubicación de prueba" }, adminToken, 201)).id;
    ids.instancia = (await api("POST", "/olimpiadas/competicion/instancias", { nombre: `${prefijo} Semifinal`, orden: 0 }, adminToken, 201)).id;
    ids.torneo = (await api("POST", `/olimpiadas/${ids.edicion}/torneos`, { nombre: `${prefijo} Torneo`, disciplina_id: disciplinas[0].id, formato: "ELIMINACION", instancia_ids: [ids.instancia] }, adminToken, 201)).id;
    registrar("lugar, instancia y torneo creados por API");

    const alta = { nombre: `${prefijo} Colaborador`, usuario: username, email: `${username}@example.invalid`, password, disciplina_ids: [disciplinas[0].id] };
    ids.voluntario = (await api("POST", `/olimpiadas/${ids.edicion}/voluntarios`, alta, adminToken, 201)).id;
    const login = () => api("POST", "/olimpiadas/voluntarios/login", { identificador: username, password }, null);
    await api("POST", "/olimpiadas/voluntarios/login", { identificador: username, password: "Invalida-2026!" }, null, 401);
    let sesion = await login();
    assert.equal(sesion.asignaciones.length, 1);
    assert.deepEqual(sesion.asignaciones[0].disciplinas.map((d) => d.id), [disciplinas[0].id]);
    assert.equal(sesion.voluntario.password_hash, undefined);
    await api("GET", "/sesion/permisos", null, sesion.token, 401);
    await api("GET", `/olimpiadas/${ids.edicion}/portal`, null, sesion.token, 401);
    await api("GET", `/olimpiadas/${ids.edicion}/fixture?disciplina_id=${disciplinas[1].id}`, null, sesion.token, 403);
    registrar("login válido/inválido y aislamiento de otros módulos y disciplinas");

    ids.partido = (await api("POST", `/olimpiadas/${ids.edicion}/partidos`, { disciplina_id: disciplinas[0].id, torneo_id: ids.torneo,
      instancia_id: ids.instancia, lugar_id: ids.lugar, departamental1_id: deps[0].id, departamental2_id: deps[1].id,
      fecha: hoy, hora_inicio: "14:00", hora_fin: "15:00" }, sesion.token, 201)).id;
    await api("PUT", `/olimpiadas/partidos/${ids.partido}/resultado`, { estado: "FINALIZADO", resultado1: "3", resultado2: "1" }, sesion.token);
    const posiciones = await api("GET", `/olimpiadas/${ids.edicion}/posiciones`, null, sesion.token);
    assert.equal(posiciones.tabla[0].departamental_id, deps[0].id);
    assert.equal(posiciones.tabla[0].puntos, 3);
    const historial = await api("GET", `/olimpiadas/${ids.edicion}/competicion/historial`, null, sesion.token);
    assert.ok(historial.results.some((h) => String(h.observacion).includes(`Voluntario #${ids.voluntario}`)));
    registrar("colaborador crea partido, carga resultado y deja auditoría; tabla otorga 3 puntos");

    const [inscripcion] = await pool.query("INSERT INTO olimpiada_inscripcion (olimpiada_id,usuario_id,departamental_id,creado_por_usuario_id,estado,categoria_tipo_id) VALUES (?,?,?,?,?,?)", [ids.edicion, afiliado.id, afiliado.departamental_id, admin.id, "PENDIENTE", disciplinas[0].tipo_id]);
    ids.inscripcion = inscripcion.insertId;
    await pool.query("INSERT INTO olimpiada_inscripcion_disciplina (inscripcion_id,disciplina_id) VALUES (?,?)", [ids.inscripcion, disciplinas[0].id]);
    const rival = { disciplina_id: disciplinas[0].id, inscripcion1_id: ids.inscripcion, departamental2_id: deps.find((d) => d.id !== afiliado.departamental_id)?.id || deps[0].id };
    await api("POST", `/olimpiadas/${ids.edicion}/partidos`, rival, adminToken, 400);
    await api("GET", `/olimpiadas/inscripciones/${ids.inscripcion}/gafete.pdf`, null, adminToken, 409);
    await pool.query("UPDATE olimpiada_inscripcion SET estado='VALIDADO' WHERE id=? AND olimpiada_id=?", [ids.inscripcion, ids.edicion]);
    ids.partidoIndividual = (await api("POST", `/olimpiadas/${ids.edicion}/partidos`, rival, adminToken, 201)).id;
    await api("PUT", `/olimpiadas/${ids.edicion}`, { ...edicion, publicada_publico: 1 });
    const fixturePrivado = await api("GET", `/olimpiadas/${ids.edicion}/fixture`, null, sesion.token);
    const privadoIndividual = fixturePrivado.partidos.find((p) => p.id === ids.partidoIndividual);
    const fixturePublico = await api("GET", `/olimpiadas/publico/${ids.edicion}/fixture`, null, null);
    const publicoIndividual = fixturePublico.partidos.find((p) => p.id === ids.partidoIndividual);
    assert.equal(publicoIndividual.participante1, privadoIndividual.departamental1_nombre);
    assert.equal(publicoIndividual.inscripcion1_id, undefined);
    assert.equal(publicoIndividual.observacion, undefined);
    await api("PUT", `/olimpiadas/partidos/${ids.partidoIndividual}`, { mostrar_nombres_publico: 1 }, sesion.token, 403);
    await api("PUT", `/olimpiadas/partidos/${ids.partidoIndividual}`, { mostrar_nombres_publico: 1 });
    const conNombres = await api("GET", `/olimpiadas/publico/${ids.edicion}/fixture`, null, null);
    assert.equal(conNombres.partidos.find((p) => p.id === ids.partidoIndividual).participante1, privadoIndividual.participante1);
    registrar("inscripción pendiente no participa ni genera gafete; nombres públicos sólo con decisión admin");

    if (process.argv.includes("--pause-for-preview")) {
      await api("PUT", `/olimpiadas/partidos/${ids.partidoIndividual}`, { mostrar_nombres_publico: 0 });
      const ready = path.resolve(__dirname, "../../output/qa-olimpiadas-preview.json");
      const release = path.resolve(__dirname, `../../output/qa-olimpiadas-${nonce}.release`);
      fs.mkdirSync(path.dirname(ready), { recursive: true });
      fs.writeFileSync(ready, JSON.stringify({ olimpiada_id: ids.edicion, torneo_id: ids.torneo, release_file: release, vence_en: new Date(Date.now() + 300000).toISOString() }, null, 2));
      console.log(`[QA develop] PREVIEW edición=${ids.edicion} torneo=${ids.torneo}; espera hasta5min o archivo ${release}`);
      const hasta = Date.now() + 300000;
      while (!fs.existsSync(release) && Date.now() < hasta) await new Promise((resolve) => setTimeout(resolve, 500));
      if (fs.existsSync(release)) fs.unlinkSync(release);
    }

    await api("PUT", `/olimpiadas/${ids.edicion}`, { ...edicion, fecha_inicio: "2020-01-01", fecha_fin: "2020-01-02", fecha_inicio_inscripcion: "2019-12-01", fecha_fin_inscripcion: "2019-12-31", publicada_publico: 1 });
    const pasado = await api("GET", `/olimpiadas/${ids.edicion}/fixture`, null, sesion.token);
    assert.equal(pasado.puede_editar, false);
    await api("PUT", `/olimpiadas/partidos/${ids.partido}/resultado`, { estado: "FINALIZADO", resultado1: "0", resultado2: "3" }, sesion.token, 403);
    registrar("evento finalizado conserva lectura y bloquea cambios de resultados");

    await api("PUT", `/olimpiadas/${ids.edicion}/voluntarios/${ids.voluntario}`, { disciplina_ids: [disciplinas[1].id] });
    await api("GET", "/olimpiadas/voluntarios/me", null, sesion.token, 401);
    sesion = await login();
    assert.deepEqual(sesion.asignaciones[0].disciplinas.map((d) => d.id), [disciplinas[1].id]);
    await api("GET", `/olimpiadas/${ids.edicion}/fixture?disciplina_id=${disciplinas[0].id}`, null, sesion.token, 403);
    await api("PUT", `/olimpiadas/${ids.edicion}/voluntarios/${ids.voluntario}`, { habilitado: 0, disciplina_ids: [disciplinas[1].id] });
    await api("GET", "/olimpiadas/voluntarios/me", null, sesion.token, 401);
    await api("POST", "/olimpiadas/voluntarios/login", { identificador: username, password }, null, 401);
    registrar("reasignar invalida sesiones; deshabilitar revoca acceso y login");
  } catch (error) {
    fallo = error;
    resultados.push({ prueba: "integración", resultado: "ERROR", detalle: error.message });
    console.error(`[QA develop] ERROR ${error.message}`);
  } finally {
    if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    try {
      if (ids.edicion) {
        const [[edicion]] = await pool.query("SELECT nombre FROM olimpiada WHERE id=?", [ids.edicion]);
        assert.equal(edicion?.nombre, prefijo, "La limpieza sólo puede operar sobre la edición QA capturada");
        await pool.query("DELETE FROM olimpiada_historial WHERE olimpiada_id=?", [ids.edicion]);
        await pool.query("DELETE FROM olimpiada_partido WHERE olimpiada_id=?", [ids.edicion]);
        await pool.query("DELETE ti FROM olimpiada_torneo_instancia ti INNER JOIN olimpiada_torneo t ON t.id=ti.torneo_id WHERE t.olimpiada_id=?", [ids.edicion]);
        await pool.query("DELETE FROM olimpiada_torneo WHERE olimpiada_id=?", [ids.edicion]);
        await pool.query("DELETE FROM olimpiada_inscripcion WHERE olimpiada_id=?", [ids.edicion]);
        await pool.query("DELETE FROM olimpiada_voluntario_disciplina WHERE olimpiada_id=?", [ids.edicion]);
        for (const tabla of ["olimpiada_disciplina_config", "olimpiada_bono_tramo", "olimpiada_seccion"]) await pool.query(`DELETE FROM ${tabla} WHERE olimpiada_id=?`, [ids.edicion]);
        await pool.query("DELETE FROM olimpiada WHERE id=? AND nombre=?", [ids.edicion, prefijo]);
      }
      if (ids.voluntario) await pool.query("DELETE FROM olimpiada_voluntario WHERE id=? AND usuario=?", [ids.voluntario, username]);
      for (const [tipo, entidad] of [["lugar", "LUGAR"], ["instancia", "INSTANCIA"]]) {
        if (ids[tipo]) {
          await pool.query("DELETE FROM olimpiada_historial WHERE entidad=? AND entidad_id=? AND olimpiada_id IS NULL", [entidad, ids[tipo]]);
          await pool.query(`DELETE FROM olimpiada_${tipo} WHERE id=? AND nombre LIKE ?`, [ids[tipo], `${prefijo}%`]);
        }
      }
      for (const clave of [`voluntarios:login:ip:${ip}`, `voluntarios:login:cuenta:${username}`]) await pool.query("DELETE FROM auth_limite WHERE clave=?", [huella(clave, "auth-rate", process.env.JWT_SECRET)]);
      const [[quedan]] = await pool.query("SELECT COUNT(*) AS cantidad FROM olimpiada WHERE nombre=?", [prefijo]);
      assert.equal(Number(quedan.cantidad), 0);
      limpiado = true;
      registrar("datos QA eliminados por IDs capturados; sin cambios a cuentas existentes");
    } catch (error) { fallo ||= error; console.error(`[QA develop] ERROR limpieza: ${error.message}`); }
    await pool.end();
    const salida = path.resolve(__dirname, "../../output/qa-olimpiadas-develop.json");
    fs.mkdirSync(path.dirname(salida), { recursive: true });
    fs.writeFileSync(salida, JSON.stringify({ entorno: "develop local", ejecutado_en: new Date().toISOString(), correos_enviados: 0, limpiado, exito: !fallo, resultados }, null, 2));
    console.log(`[QA develop] ${resultados.filter((r) => r.resultado === "OK").length} comprobaciones; limpieza=${limpiado}; reporte=${salida}`);
  }
  if (fallo) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(`[QA develop] ${error.message}`); process.exitCode = 1; });
