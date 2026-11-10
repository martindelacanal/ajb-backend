"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { validarSolicitud, prepararAccesoSsh, resultadoPublico, resultadoDiagnostico } = require("../lib/mantenimiento-ssh");
const { execFileSync } = require("node:child_process");
const { generarPar, firmar } = require("../lib/firma");
const { crearSqlite, asegurarEsquema, escribirMeta } = require("../lib/db-sqlite");
const { crearAgente } = require("../lib/agente");

function claveSsh() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return "ssh-ed25519 " + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), raw]).toString("base64");
}
function escenario() {
  const claves = generarPar(), ahora = Date.parse("2026-11-10T18:00:00.000Z");
  const solicitud = { version: 1, accion: "PREPARAR_ACCESO_SSH", equipoId: "a".repeat(64),
    instanciaId: "8cde1609-0b4e-4c5a-b03c-d7d2a71892f7", predioCodigo: "MIRAMAR", operadorPublicKey: claveSsh(),
    relayHost: "52.67.192.228", relayPort: 22222, relayUser: "ajb-miramar-tunnel", relayHostKey: claveSsh(),
    reversePort: 22099, sshPort: 2222, usuarioWindows: "ajbmantenimiento", expiresAt: "2026-11-10T19:00:00.000Z", nonce: "b".repeat(64) };
  const config = { clave_publica: claves.publica, predio_codigo: "MIRAMAR", predio_id: 1 };
  const contexto = { config, equipoId: solicitud.equipoId, instanciaId: solicitud.instanciaId, propietarioId: solicitud.equipoId,
    restauracionPendiente: false, plataforma: "win32", ahora };
  function sobre(cambios = {}, clave = claves.privada) {
    const raw = Buffer.from(JSON.stringify({ ...solicitud, ...cambios }));
    return { solicitud: raw.toString("base64"), firma: firmar(raw, clave) };
  }
  const salida = { estado: "ACTIVO", usuarioWindows: solicitud.usuarioWindows, sshPort: solicitud.sshPort, reversePort: solicitud.reversePort,
    tunnelPublicKey: claveSsh(), sshHostPublicKey: claveSsh(), hostname: "ajbmiramar", carpeta: "C:\\ProgramData\\AJB\\Mantenimiento" };
  return { claves, solicitud, config, contexto, sobre, salida, ahora };
}

function diagnostico() {
  return { estado: "DIAGNOSTICO", fecha: "2026-11-10T19:01:47.1234567Z", hostname: "AJBMIRAMAR", usuarioExiste: false, reinicioPendiente: false, marca: "INSTALANDO",
    archivos: [{ nombre: "SSHD", existe: false, tamano: 0 }],
    servicios: [{ nombre: "TrustedInstaller", estado: "Running", inicio: "Manual" }],
    tareas: [{ nombre: "AJB Predio", estado: "Running" }],
    procesos: [{ nombre: "tiworker.exe", pid: 100, padre: 200 }],
    capacidades: [{ paquete: "Microsoft-Windows-OpenSSH-Server-Package~31bf3856ad364e35~amd64~~10.0.26100.1", codigoEstado: 112 }],
    eventos: [{ origen: "DISM", evento: "ERROR_DISM", fecha: "2026-11-10 19:01:47", codigo: "0x800f0954" }],
    erroresLectura: [] };
}

test("el diagnóstico exige su acción firmada y ejecuta sólo la lectura fija sin alterar archivos ni SQLite", async t => {
  const s = escenario(), db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  const base = path.join(os.tmpdir(), "ajb-ssh-no-escribir-" + crypto.randomUUID());
  assert.equal(fs.existsSync(base), false);
  const cambios = db.conexion.prepare("SELECT total_changes() AS n").get().n;
  let llamadas = 0;
  const deps = { plataforma: "win32", ahora: s.ahora, async ejecutarArchivo(exe, args, opciones) {
    llamadas++;
    assert.equal(exe, "powershell.exe");
    assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.resolve(__dirname, "../windows/diagnosticar-mantenimiento-ssh.ps1")]);
    assert.equal(opciones.timeout, 90000);
    return JSON.stringify(diagnostico());
  } };
  const sobre = s.sobre({ accion: "DIAGNOSTICAR_ACCESO_SSH" });
  const parametros = { cuerpo: sobre, config: s.config, db, base, equipoId: s.solicitud.equipoId, instanciaId: s.solicitud.instanciaId };
  assert.deepEqual(await prepararAccesoSsh(parametros, deps), diagnostico());
  const adulterado = s.sobre();
  adulterado.solicitud = sobre.solicitud;
  for (const cuerpo of [adulterado, s.sobre({ accion: "DIAGNOSTICAR_ACCESO_SSH", equipoId: "c".repeat(64) }),
    s.sobre({ accion: "DIAGNOSTICAR_ACCESO_SSH", expiresAt: "2026-11-10T17:00:00.000Z" }),
    s.sobre({ accion: "DIAGNOSTICAR_ACCESO_SSH", script: "comando ajeno" })]) {
    await assert.rejects(prepararAccesoSsh({ ...parametros, cuerpo }, deps), e => e.status === 403);
  }
  assert.equal(llamadas, 1, "una firma, destino, vigencia o esquema inválidos no ejecutan el script");
  assert.equal(db.conexion.prepare("SELECT total_changes() AS n").get().n, cambios);
  assert.equal(fs.existsSync(base), false, "el diagnóstico no crea staging ni cambia ACL");
  await assert.rejects(prepararAccesoSsh(parametros, { ...deps, ejecutarArchivo: async () => { throw Error("PRIVATE KEY inesperada en stderr"); } }),
    e => e.status === 500 && e.message === "No se pudo completar el diagnóstico SSH en la notebook");
});

test("el diagnóstico limita listas y tipos y no transmite líneas de logs, comandos o secretos", () => {
  const r = diagnostico(), secreta = "PRIVATE_KEY_NO_PUBLICAR";
  const datos = { ...r, stdout: secreta, privateKey: secreta,
    procesos: [{ ...r.procesos[0], CommandLine: secreta }], eventos: [{ ...r.eventos[0], mensaje: secreta }] };
  const publicos = resultadoDiagnostico(JSON.stringify(datos));
  assert.deepEqual(publicos, r);
  assert.ok(!JSON.stringify(publicos).includes(secreta));
  for (const cambio of [{ estado: "ACTIVO" }, { eventos: [null] }, { eventos: [{ ...r.eventos[0], codigo: ["0x800f0954"] }] },
    { eventos: [{ ...r.eventos[0], evento: secreta }] }, { eventos: [{ ...r.eventos[0], codigo: secreta }] },
    { archivos: [{ ...r.archivos[0], nombre: "C:\\secreto" }] }, { procesos: [{ ...r.procesos[0], nombre: "cmd.exe" }] },
    { procesos: [{ ...r.procesos[0], pid: -1 }] }, { capacidades: [{ ...r.capacidades[0], paquete: "../../secreto" }] },
    { procesos: Array(65).fill(r.procesos[0]) }, { tunnelPublicKey: secreta }, { erroresLectura: [secreta] }, { reinicioPendiente: "true" }]) {
    assert.throws(() => resultadoDiagnostico(JSON.stringify({ ...r, ...cambio })),
      e => e.status === 500 && e.message === "El diagnóstico SSH no devolvió un resultado verificable");
  }
  const publicKey = claveSsh();
  assert.equal(resultadoDiagnostico(JSON.stringify({ ...r, tunnelPublicKey: publicKey })).tunnelPublicKey, publicKey);
});

test("el clasificador PowerShell devuelve sólo etiquetas y códigos sin el texto del log", { skip: process.platform !== "win32" }, () => {
  const script = path.resolve(__dirname, "../windows/diagnosticar-mantenimiento-ssh.ps1").replace(/'/g, "''");
  const comando = `$ProgressPreference='SilentlyContinue'; $tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'El diagnostico no es sintaxis valida de Windows PowerShell'}
$funcion=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Evento-Seguro'},$true)
. ([scriptblock]::Create($funcion.Extent.Text))
if ($null -ne (Evento-Seguro '2026-11-10 19:01:47 HRESULT=0x00000000' 'DISM')) { throw 'HRESULT de exito clasificado como error' }
if ($null -ne (Evento-Seguro '2026-11-10 19:01:47 HRESULT=0x00000001' 'DISM')) { throw 'S_FALSE clasificado como error' }
@((Evento-Seguro '2026-11-10T19:01:47.1234567Z ERROR: access is denied PRIVATE_KEY_NO_PUBLICAR 0x80070005' 'INSTALACION'),(Evento-Seguro '2026-11-10 19:01:47 Failed PASSWORD_NO_PUBLICAR 0x800f0954' 'DISM'),(Evento-Seguro '2026-11-10 19:01:47 HRESULT=0x80070005' 'DISM')) | ConvertTo-Json -Compress`;
  const salida = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(comando, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.deepEqual(JSON.parse(salida), [
    { origen: "INSTALACION", evento: "ERROR_PERMISOS", fecha: "2026-11-10T19:01:47.1234567Z", codigo: "0x80070005" },
    { origen: "DISM", evento: "ERROR_DISM", fecha: "2026-11-10 19:01:47", codigo: "0x800f0954" },
    { origen: "DISM", evento: "ERROR_DISM", fecha: "2026-11-10 19:01:47", codigo: "0x80070005" },
  ]);
  assert.ok(!salida.includes("NO_PUBLICAR"));
});

test("la autorización SSH verifica exactamente los bytes firmados y las identidades fijadas", () => {
  const s = escenario();
  assert.deepEqual(validarSolicitud(s.sobre(), s.contexto), s.solicitud);
  assert.throws(() => validarSolicitud(s.sobre({}, generarPar().privada), s.contexto), /firma válida/);
  const alterado = s.sobre(); alterado.solicitud = Buffer.from(JSON.stringify({ ...s.solicitud, relayHost: "127.0.0.1" })).toString("base64");
  assert.throws(() => validarSolicitud(alterado, s.contexto), /firma válida/);
  assert.throws(() => validarSolicitud({ ...s.sobre(), script: "código externo" }, s.contexto), /debe estar firmada/);
  assert.throws(() => validarSolicitud({ ...s.sobre(), firma: s.sobre().firma.slice(0, -1) }, s.contexto), /formato válido/);
});

test("rechaza otro equipo, otra instalación, restauraciones y los destinos o campos no autorizados", () => {
  const s = escenario();
  for (const cambio of [{ equipoId: "c".repeat(64) }, { instanciaId: crypto.randomUUID() }, { predioCodigo: "OTRO" },
    { relayHost: "example.com" }, { relayPort: 22 }, { reversePort: 22 }, { sshPort: 22 }, { relayUser: "root" },
    { usuarioWindows: "Administrator" }, { version: 2 }, { accion: "REINICIAR" }, { script: "x" }, { nonce: "x" }]) {
    assert.throws(() => validarSolicitud(s.sobre(cambio), s.contexto), e => e.status === 403, JSON.stringify(cambio));
  }
  for (const cambio of [{ propietarioId: "c".repeat(64) }, { restauracionPendiente: true }, { plataforma: "linux" }, { config: { ...s.config, clave_publica: null } }]) {
    assert.throws(() => validarSolicitud(s.sobre(), { ...s.contexto, ...cambio }), e => e.status === 403);
  }
});

test("rechaza claves no Ed25519, claves inyectadas y autorizaciones vencidas o demasiado largas", () => {
  const s = escenario();
  for (const clave of ["ssh-rsa AAAA", "ssh-ed25519 " + Buffer.alloc(51).toString("base64"), s.solicitud.operadorPublicKey + "\nssh-ed25519 AAAA", "restrict " + s.solicitud.operadorPublicKey]) {
    assert.throws(() => validarSolicitud(s.sobre({ operadorPublicKey: clave }), s.contexto), /claves públicas/);
    assert.throws(() => validarSolicitud(s.sobre({ relayHostKey: clave }), s.contexto), /claves públicas/);
  }
  for (const expiresAt of ["2026-11-10T17:59:59.999Z", "2026-11-10T18:00:00.000Z", "2026-11-11T18:00:00.001Z", "10/11/2026", "nunca"]) {
    assert.throws(() => validarSolicitud(s.sobre({ expiresAt }), s.contexto), /vigencia/);
  }
});

test("guarda la solicitud protegida y sólo ejecuta el instalador fijo con argumentos separados", async t => {
  const s = escenario();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-ssh-test-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  escribirMeta(db, "equipo_propietario_id", s.solicitud.equipoId);
  const llamadas = [];
  const deps = { plataforma: "win32", ahora: s.ahora, async ejecutarArchivo(exe, args, opciones) {
    llamadas.push({ exe, args, opciones });
    if (exe === "icacls.exe") { assert.equal(args[0], path.join(base, "mantenimiento-ssh")); return ""; }
    assert.equal(exe, "powershell.exe");
    assert.ok(args[args.indexOf("-File") + 1].endsWith(path.join("windows", "configurar-mantenimiento-ssh.ps1")));
    assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf("-PolicyFile") + 1], "utf8")), s.solicitud);
    assert.equal(opciones.timeout, 900000);
    assert.equal(llamadas.filter(l => l.exe === "icacls.exe").length % 2, 0);
    return JSON.stringify({ ...s.salida, privateKey: "NO DEBE SALIR", password: "NO DEBE SALIR" });
  } };
  const parametros = { cuerpo: s.sobre(), config: s.config, db, base, equipoId: s.solicitud.equipoId, instanciaId: s.solicitud.instanciaId };
  const r = await prepararAccesoSsh(parametros, deps);
  assert.equal(r.estado, "ACTIVO"); assert.equal(r.tunnelPublicKey, s.salida.tunnelPublicKey); assert.ok(!JSON.stringify(r).includes("NO DEBE SALIR"));
  assert.deepEqual(await prepararAccesoSsh(parametros, deps), r, "repetir el alta conserva el resultado sin acumular archivos temporales");
  assert.deepEqual(fs.readdirSync(path.join(base, "mantenimiento-ssh")), ["policy.json"]);
  assert.equal(llamadas.length, 6);
  await assert.rejects(prepararAccesoSsh({ ...parametros, cuerpo: s.sobre({ equipoId: "c".repeat(64) }) }, deps), /otro equipo/);
  assert.equal(llamadas.length, 6, "una solicitud inválida no escribe ni ejecuta procesos");
});

test("no publica resultados malformados ni errores libres del instalador", async t => {
  const s = escenario();
  assert.throws(() => resultadoPublico("progreso\n" + JSON.stringify(s.salida), s.solicitud), /verificable/);
  assert.throws(() => resultadoPublico(JSON.stringify({ ...s.salida, reversePort: 22 }), s.solicitud), /no corresponde/);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ajb-ssh-test-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  const db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  await assert.rejects(prepararAccesoSsh({ cuerpo: s.sobre(), config: s.config, db, base, equipoId: s.solicitud.equipoId, instanciaId: s.solicitud.instanciaId },
    { plataforma: "win32", ahora: s.ahora, ejecutarArchivo: async () => { throw new Error("PRIVATE KEY no debe filtrarse"); } }),
  e => e.status === 500 && !e.message.includes("PRIVATE KEY"));
});

test("el diagnóstico conserva sólo la fase prevista y el código fijo o numérico", () => {
  const s = escenario();
  for (const codigo of ["FALLO_INSTALACION", 5, -2147024891, 4294967295]) {
    assert.throws(() => resultadoPublico(JSON.stringify({ estado: "ERROR", fase: "CAPACIDAD_OPENSSH", codigo,
      mensaje: "PRIVATE KEY: secreto", stderr: "contraseña privada", password: "no publicar" }), s.solicitud), e => {
      assert.equal(e.status, 500);
      assert.equal(e.fase, "CAPACIDAD_OPENSSH");
      assert.equal(e.codigo, codigo);
      assert.equal(e.message, `No se pudo preparar el acceso SSH. Fase: CAPACIDAD_OPENSSH; código: ${codigo}`);
      assert.ok(!JSON.stringify(e).includes("secreto"));
      assert.ok(!("stderr" in e));
      return true;
    });
  }
  for (const cambio of [{ fase: "PRIVATE_KEY" }, { codigo: "PRIVATE_KEY" }, { codigo: -2147483649 },
    { codigo: 4294967296 }, { codigo: 1.5 }, { codigo: { secreto: "privado" } }, { fase: ["VALIDACION"] }]) {
    assert.throws(() => resultadoPublico(JSON.stringify({ estado: "ERROR", fase: "VALIDACION", codigo: "FALLO_INSTALACION", ...cambio }), s.solicitud),
      e => e.status === 500 && e.message === "El instalador SSH no devolvió un diagnóstico verificable" && !e.fase && !e.codigo);
  }
});

test("el agente reconoce sólo la orden nombrada y conserva su rechazo firmado sin ejecutar procesos", async t => {
  const s = escenario(), db = crearSqlite(":memory:", { predioId: 1 }); asegurarEsquema(db); t.after(() => db.cerrar());
  escribirMeta(db, "instancia_id", s.solicitud.instanciaId);
  escribirMeta(db, "equipo_propietario_id", s.solicitud.equipoId);
  const agente = crearAgente({ db, config: s.config, base: "", version: "test", log: () => {}, api: {}, controlEquipo: { equipoId: s.solicitud.equipoId } });
  const contenido = JSON.stringify({ tipo: "predio-paquete", predio_id: 1,
    comandos: [{ id: 9901, tipo: "SISTEMA", ruta: "PREPARAR_ACCESO_SSH", cuerpo: { solicitud: "no-firmada" } }] });
  const paquete = zlib.gzipSync(Buffer.from(JSON.stringify({ tipo: "predio-paquete-firmado", contenido, firma: firmar(contenido, s.claves.privada) })));
  const resultado = await agente.importarPaquete(paquete);
  assert.equal(resultado.errores, 1);
  const guardado = await db.get("SELECT status,respuesta FROM predio_comando_ejecutado WHERE comando_id=9901");
  assert.equal(guardado.status, 403);
  assert.ok(!guardado.respuesta.includes("Orden desconocida"));
});
