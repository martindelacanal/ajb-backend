"use strict";

const crypto = require("crypto");
const path = require("path");
const zlib = require("zlib");
const ExcelJS = require("exceljs");
const { parseString } = require("fast-csv");
const jwt = require("jsonwebtoken");
const { esDniValido, DNI_MENSAJE } = require("../security/dni");
const { normalizarFechaCivil, calcularEdadEnFecha, obtenerFechaCivilArgentina,
  validarCuitCuil, validarCbu } = require("./valores-dominio");

const MAX_FILAS = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const COLUMNAS = ["nombre", "apellido", "documento", "email", "fecha_nacimiento", "departamental_id",
  "tipo_persona_id", "telefono", "legajo", "direccion", "dependencia_judicial", "cuil", "cbu"];
const REQUERIDAS = ["nombre", "apellido", "documento", "email", "fecha_nacimiento"];
const ALIAS = { dni: "documento", correo: "email", correo_electronico: "email", mail: "email",
  nombres: "nombre", apellidos: "apellido", nacimiento: "fecha_nacimiento", fecha_de_nacimiento: "fecha_nacimiento",
  departamental: "departamental_id", tipo_persona: "tipo_persona_id", tipo_de_persona: "tipo_persona_id",
  celular: "telefono", dependencia: "dependencia_judicial" };
const errorImportacion = (mensaje, statusCode = 400, detalles) => Object.assign(new Error(mensaje), { statusCode, detalles });
const texto = (valor) => String(valor ?? "").trim();
const clave = (valor) => texto(valor).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "_");

function autorizarImportacion(actor) {
  if (!actor || !["departamental", "auditor", "admin", "admin-central"].includes(actor.rol)
    || ["N", "0"].includes(String(actor.habilitado)) || actor.bloqueo_tipo === "total"
    || Number(actor.requiere_cambio_clave) === 1) throw errorImportacion("No tenés permisos para importar afiliados.", 403);
  if (actor.rol === "departamental" && !(Number(actor.departamental_id) > 0)) {
    throw errorImportacion("Tu usuario no tiene una departamental asignada.", 403);
  }
}

// Se comprueba la expansión real del ZIP antes de entregarlo al lector XLSX.
// Los tamaños declarados en el directorio ZIP por sí solos no evitan archivos bomba.
function validarZipExcel(buffer) {
  const maxExpandido = 25 * 1024 * 1024;
  let fin = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0 || buffer.readUInt16LE(fin + 4) !== 0 || buffer.readUInt16LE(fin + 6) !== 0) throw new Error("ZIP inválido");
  const cantidad = buffer.readUInt16LE(fin + 10);
  let posicion = buffer.readUInt32LE(fin + 16);
  let total = 0;
  if (!cantidad || cantidad > 1000 || posicion >= fin) throw new Error("ZIP demasiado grande");
  for (let i = 0; i < cantidad; i++) {
    if (posicion + 46 > fin || buffer.readUInt32LE(posicion) !== 0x02014b50) throw new Error("ZIP inválido");
    const flags = buffer.readUInt16LE(posicion + 8);
    const metodo = buffer.readUInt16LE(posicion + 10);
    const comprimido = buffer.readUInt32LE(posicion + 20);
    const expandido = buffer.readUInt32LE(posicion + 24);
    const local = buffer.readUInt32LE(posicion + 42);
    if (flags & 1 || ![0, 8].includes(metodo) || expandido > maxExpandido - total
      || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP no admitido");
    const inicio = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (inicio + comprimido > posicion) throw new Error("ZIP inválido");
    const contenido = buffer.subarray(inicio, inicio + comprimido);
    const longitud = metodo === 0 ? contenido.length
      : zlib.inflateRawSync(contenido, { maxOutputLength: Math.max(1, maxExpandido - total) }).length;
    total += longitud;
    if (longitud !== expandido || total > maxExpandido) throw new Error("ZIP demasiado grande");
    posicion += 46 + buffer.readUInt16LE(posicion + 28) + buffer.readUInt16LE(posicion + 30) + buffer.readUInt16LE(posicion + 32);
  }
}

function filasCsv(buffer) {
  let contenido;
  try { contenido = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch (_) { throw errorImportacion("Guardá el CSV con codificación UTF-8 y volvé a cargarlo."); }
  contenido = contenido.replace(/^\uFEFF/, "");
  const cabecera = contenido.split(/\r?\n/, 1)[0];
  const separador = [",", ";", "\t"].sort((a, b) => cabecera.split(b).length - cabecera.split(a).length)[0];
  return new Promise((resolve, reject) => {
    const filas = [];
    parseString(contenido, { delimiter: separador, trim: true, ignoreEmpty: true, maxRows: MAX_FILAS + 2 })
      .on("error", () => reject(errorImportacion("El CSV no es válido. Revisá las comillas y los separadores.")))
      .on("data", (valores) => filas.push({ fila: filas.length + 1, valores }))
      .on("end", () => resolve(filas));
  });
}

async function leerArchivo(archivo) {
  if (!archivo?.buffer?.length) throw errorImportacion("Seleccioná un archivo Excel (.xlsx) o CSV.");
  if (archivo.buffer.length > MAX_BYTES) throw errorImportacion("El archivo supera el máximo de 2 MB.", 413);
  const extension = path.extname(archivo.originalname || "").toLowerCase();
  let filas;
  if (extension === ".csv") filas = await filasCsv(archivo.buffer);
  else if (extension === ".xlsx") {
    try {
      validarZipExcel(archivo.buffer);
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(archivo.buffer);
      const hojas = libro.worksheets.filter((hoja) => hoja.actualRowCount > 0);
      if (hojas.length !== 1) throw errorImportacion("El Excel debe tener una única hoja con datos.");
      const hoja = hojas[0];
      if (hoja.rowCount > MAX_FILAS + 1 || hoja.columnCount > 30) throw errorImportacion(`El archivo admite hasta ${MAX_FILAS} afiliados y 30 columnas.`);
      filas = [];
      hoja.eachRow((fila, numero) => filas.push({ fila: numero, valores: Array.from({ length: hoja.columnCount }, (_, i) => {
        const valor = fila.getCell(i + 1).value;
        if (valor != null && typeof valor === "object" && !(valor instanceof Date)) {
          throw errorImportacion(`La fila ${numero} contiene fórmulas u objetos. Pegá los datos como valores y volvé a cargarla.`);
        }
        return valor ?? "";
      }) }));
    } catch (error) {
      if (error.statusCode) throw error;
      throw errorImportacion("No pudimos leer el Excel. Usá un archivo .xlsx válido, sin contraseña y de hasta 200 filas.");
    }
  } else throw errorImportacion("Formato no admitido. Usá Excel .xlsx o CSV (guardá los .xls como .xlsx).");
  if (filas.length < 2) throw errorImportacion("El archivo no contiene afiliados para importar.");
  if (filas.length > MAX_FILAS + 1) throw errorImportacion(`Podés importar hasta ${MAX_FILAS} afiliados por archivo.`);
  const encabezados = filas.shift().valores.map((valor) => ALIAS[clave(valor)] || clave(valor));
  // Excel suele conservar columnas vacías por formato; no son columnas de datos.
  while (encabezados.length && !encabezados.at(-1)) encabezados.pop();
  if (encabezados.length > 30 || encabezados.some((encabezado) => !COLUMNAS.includes(encabezado))) {
    throw errorImportacion("El archivo contiene columnas no admitidas. Usá los encabezados de la plantilla.");
  }
  if (new Set(encabezados).size !== encabezados.length) throw errorImportacion("Hay columnas repetidas en el archivo.");
  const faltantes = REQUERIDAS.filter((columna) => !encabezados.includes(columna));
  if (faltantes.length) throw errorImportacion(`Faltan columnas obligatorias: ${faltantes.join(", ")}.`);
  return filas.map(({ fila, valores }) => {
    if (valores.length > encabezados.length && valores.slice(encabezados.length).some((valor) => texto(valor))) {
      throw errorImportacion(`La fila ${fila} tiene datos sin un encabezado de columna.`);
    }
    return { fila, ...Object.fromEntries(encabezados.map((encabezado, i) => [encabezado, valores[i] ?? ""])) };
  });
}

function resolverCatalogo(valor, catalogo) {
  if (!texto(valor)) return null;
  const encontrados = catalogo.filter((item) => /^\d+$/.test(texto(valor)) ? Number(item.id) === Number(valor) : clave(item.nombre) === clave(valor));
  return encontrados.length === 1 ? Number(encontrados[0].id) : null;
}

function normalizarFilas(filas, { actor, departamentales, tipos, departamentalId, hoy = obtenerFechaCivilArgentina() }) {
  const documentos = new Map();
  const emails = new Map();
  const resultado = filas.map((original) => {
    const fila = { fila: original.fila, errores: [] };
    for (const campo of COLUMNAS) fila[campo] = texto(original[campo]);
    for (const [campo, largo] of [["nombre", 45], ["apellido", 45], ["email", 45], ["telefono", 15], ["legajo", 45], ["direccion", 50], ["dependencia_judicial", 50]]) {
      if (fila[campo].length > largo || (["nombre", "apellido", "email"].includes(campo) && !fila[campo])) {
        fila.errores.push(`${campo}: ${["nombre", "apellido", "email"].includes(campo) ? "obligatorio, " : ""}máximo ${largo} caracteres.`);
      }
    }
    fila.documento = fila.documento.replace(/[.\s]/g, "");
    if (!esDniValido(fila.documento) || Number(fila.documento) === 0) fila.errores.push(DNI_MENSAJE);
    fila.documento = esDniValido(fila.documento) ? String(Number(fila.documento)) : fila.documento;
    fila.email = fila.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fila.email)) fila.errores.push("Email inválido.");
    let nacimiento = original.fecha_nacimiento;
    if (typeof nacimiento === "string") nacimiento = nacimiento.trim().replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1");
    fila.fecha_nacimiento = normalizarFechaCivil(nacimiento);
    if (!fila.fecha_nacimiento || calcularEdadEnFecha(fila.fecha_nacimiento, hoy) === null) fila.errores.push("Fecha de nacimiento inválida. Usá AAAA-MM-DD o DD/MM/AAAA.");
    const seleccion = fila.departamental_id || departamentalId || (actor.rol === "departamental" ? actor.departamental_id : "");
    fila.departamental_id = resolverCatalogo(seleccion, departamentales);
    if (!fila.departamental_id) fila.errores.push("Elegí una departamental habilitada o indicála en la columna departamental.");
    if (actor.rol === "departamental" && fila.departamental_id !== Number(actor.departamental_id)) fila.errores.push("Solo podés importar afiliados de tu departamental.");
    fila.tipo_persona_id = resolverCatalogo(fila.tipo_persona_id || "1", tipos);
    if (!fila.tipo_persona_id) fila.errores.push("Tipo de persona inexistente.");
    // La importación da de alta titulares afiliados, no integrantes del grupo familiar.
    if ([2, 5].includes(fila.tipo_persona_id)) fila.errores.push("Usá un tipo de persona titular; los familiares se agregan desde su grupo familiar.");
    if (fila.cuil && !validarCuitCuil(fila.cuil)) fila.errores.push("CUIL inválido.");
    if (fila.cbu && !validarCbu(fila.cbu)) fila.errores.push("CBU inválido.");
    for (const [valor, indice] of [[fila.documento, documentos], [fila.email, emails]]) {
      if (valor) { if (!indice.has(valor)) indice.set(valor, []); indice.get(valor).push(fila); }
    }
    return fila;
  });
  for (const [indice, etiqueta] of [[documentos, "DNI"], [emails, "Email"]]) {
    for (const repetidos of indice.values()) if (repetidos.length > 1) {
      for (const fila of repetidos) fila.errores.push(`${etiqueta} repetido dentro del archivo (filas ${repetidos.map((f) => f.fila).join(", ")}).`);
    }
  }
  return resultado;
}

function resumen(filas) {
  const errores = filas.filter((fila) => fila.errores.length > 0).length;
  return { total: filas.length, validos: filas.length - errores, errores, filas };
}

function crearServicioImportacionUsuarios({ db, jwtSecret = process.env.JWT_SECRET, encolar,
  ahora = () => Date.now(), generarPassword = () => `!sin-acceso:${crypto.randomBytes(24).toString("base64url")}` }) {
  async function actorActual(connection, actorId, bloquear = false) {
    const [actores] = await connection.query(`SELECT u.id, r.nombre AS rol, u.departamental_id,
      u.habilitado, u.bloqueo_tipo, u.requiere_cambio_clave FROM usuario u
      INNER JOIN rol r ON r.id = u.rol_id WHERE u.id = ?${bloquear ? " FOR UPDATE" : ""}`, [actorId]);
    autorizarImportacion(actores[0]);
    return actores[0];
  }

  async function validar(connection, filas, actor, departamentalId, bloquear = false) {
    const [departamentales] = await connection.query("SELECT id, nombre FROM departamental WHERE habilitado = 'Y'");
    const [tipos] = await connection.query("SELECT id, nombre FROM tipo_persona");
    const normalizadas = normalizarFilas(filas, { actor, departamentales, tipos, departamentalId });
    const documentos = normalizadas.map((fila) => fila.documento).filter((dni) => /^\d+$/.test(dni)).map(Number);
    const emails = normalizadas.map((fila) => fila.email).filter(Boolean);
    if (documentos.length || emails.length) {
      const [existentes] = await connection.query(`SELECT documento, email FROM usuario
        WHERE documento IN (?) OR LOWER(TRIM(email)) IN (?)${bloquear ? " FOR UPDATE" : ""}`, [documentos.length ? documentos : [0], emails.length ? emails : [""]]);
      const dniExistentes = new Set(existentes.map((usuario) => String(usuario.documento)));
      const emailsExistentes = new Set(existentes.map((usuario) => texto(usuario.email).toLowerCase()).filter(Boolean));
      for (const fila of normalizadas) {
        if (dniExistentes.has(fila.documento)) fila.errores.push("El DNI ya está registrado. No se modificará el usuario existente.");
        if (emailsExistentes.has(fila.email)) fila.errores.push("El email ya está registrado. No se modificará el usuario existente.");
      }
    }
    return resumen(normalizadas);
  }

  function huella(archivo, departamentalId) {
    return crypto.createHash("sha256").update(archivo.buffer).update("\0").update(path.extname(archivo.originalname).toLowerCase()).update("\0").update(texto(departamentalId)).digest("hex");
  }

  async function preview({ actorId, archivo, departamentalId }) {
    const actor = await actorActual(db, actorId);
    const filas = await leerArchivo(archivo);
    const resultado = await validar(db, filas, actor, departamentalId);
    const token = jwt.sign({ actorId: Number(actorId), huella: huella(archivo, departamentalId), iat: Math.floor(ahora() / 1000) }, jwtSecret,
      { algorithm: "HS256", expiresIn: "15m", audience: "usuarios-importacion", issuer: "mi-ajb" });
    return { success: true, token, ...resultado };
  }

  async function confirmar({ actorId, archivo, departamentalId, token, enviarBienvenida }) {
    if (![true, false, "true", "false"].includes(enviarBienvenida)) throw errorImportacion("Indicá si querés enviar el email de bienvenida.");
    let firmado;
    try {
      firmado = jwt.verify(token, jwtSecret, { algorithms: ["HS256"], audience: "usuarios-importacion", issuer: "mi-ajb", clockTimestamp: Math.floor(ahora() / 1000) });
      if (!archivo?.buffer || firmado.actorId !== Number(actorId) || firmado.huella !== huella(archivo, departamentalId)) throw new Error("Preview diferente");
    } catch (_) { throw errorImportacion("La vista previa venció o el archivo cambió. Volvé a revisar el archivo antes de importar.", 409); }
    // Autorizar antes de procesar el archivo y otra vez bajo bloqueo para cubrir cambios simultáneos.
    await actorActual(db, actorId);
    const filas = await leerArchivo(archivo);
    const connection = await db.getConnection();
    let bloqueado = false;
    let transaccion = false;
    try {
      const [locks] = await connection.query("SELECT GET_LOCK('ajb:importacion-afiliados', 5) AS tomado");
      bloqueado = Number(locks[0]?.tomado) === 1;
      if (!bloqueado) throw errorImportacion("Hay otra importación en curso. Volvé a intentar en unos segundos.", 409);
      await connection.beginTransaction();
      transaccion = true;
      const actor = await actorActual(connection, actorId, true);
      const resultado = await validar(connection, filas, actor, departamentalId, true);
      if (resultado.errores) throw errorImportacion("No se importó ningún afiliado. Corregí las filas señaladas y volvé a cargar el archivo.", 409, resultado);
      const [roles] = await connection.query("SELECT id FROM rol WHERE nombre = 'afiliado' LIMIT 1");
      if (!roles[0]) throw errorImportacion("El rol afiliado no está configurado.", 409);
      const bienvenida = enviarBienvenida === true || enviarBienvenida === "true";
      for (const fila of resultado.filas) {
        const [creado] = await connection.query(`INSERT INTO usuario
          (rol_id, departamental_id, tipo_persona_id, nombre, apellido, documento, email, fecha_nacimiento,
           telefono, legajo, direccion, dependencia_judicial, cuil, cbu, password, habilitado, requiere_cambio_clave)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Y', 0)`,
        [roles[0].id, fila.departamental_id, fila.tipo_persona_id, fila.nombre, fila.apellido, Number(fila.documento),
          fila.email, fila.fecha_nacimiento, fila.telefono || null, fila.legajo || null, fila.direccion || null,
          fila.dependencia_judicial || null, fila.cuil || null, fila.cbu || null, await generarPassword()]);
        await connection.query(`INSERT INTO historial_usuario
          (usuario_id, tipo_operacion, tabla_afectada, campo_modificado, valor_anterior, valor_nuevo, usuario_modificador_id, observaciones)
          VALUES (?, 'CREATE', 'usuario', 'importacion', NULL, ?, ?, ?)`,
        [creado.insertId, JSON.stringify({ documento: fila.documento, departamental_id: fila.departamental_id, rol: "afiliado", bienvenida }), actorId,
          `Alta de afiliado mediante importación; fila ${fila.fila}`]);
        if (bienvenida) {
          const encolarCorreo = encolar || require("./usuarios-bienvenida").encolarBienvenida;
          await encolarCorreo({ connection, usuarioId: creado.insertId, para: fila.email, nombre: fila.nombre, apellido: fila.apellido });
        }
      }
      await connection.commit();
      transaccion = false;
      return { success: true, total: resultado.total, creados: resultado.total,
        emailsPendientes: bienvenida ? resultado.total : 0, emailsFallidos: 0,
        mensaje: `Se importaron ${resultado.total} afiliados.${bienvenida ? " Los emails de bienvenida quedaron pendientes de envío automático." : " No se enviaron emails de bienvenida."}` };
    } catch (error) {
      if (transaccion) await connection.rollback();
      if (["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code)) {
        throw errorImportacion("Los datos cambiaron durante la importación. No se importó ningún afiliado; volvé a revisar el archivo.", 409);
      }
      throw error;
    } finally {
      try { if (bloqueado) await connection.query("SELECT RELEASE_LOCK('ajb:importacion-afiliados')"); }
      finally { connection.release(); }
    }
  }
  return { preview, confirmar };
}

module.exports = { MAX_FILAS, MAX_BYTES, COLUMNAS, autorizarImportacion, validarZipExcel, leerArchivo, normalizarFilas, crearServicioImportacionUsuarios };
