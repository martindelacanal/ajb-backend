"use strict";

// Catálogo: productos, proveedores, bocas, cajas, usuarios, configuración y
// las listas de opciones de los desplegables.

const U = require("../util");
const N = require("../negocio");
const Porciones = require("../porciones");
const PB = require("../precio-boca");
const { DESTINOS } = require("../listados");
const { gtinValido, proximidadCodigo } = require("../codigo-barras");
const { resolverRevisionProducto } = require("../precios");
const { revisarProducto: revisarStockMinimoProducto, bloquearStockProducto } = require("../stock-minimo");
const { exigirAdmin, esAdmin, bocasDe, exigirPuesto, exigirBoca } = require("./comun");

const DESTINOS_VALIDOS = DESTINOS.map((d) => d.valor);

// El costo de compra y el margen los ve el administrador y quien carga compras (el almacén).
async function veCostos(db, ctx) {
  if (esAdmin(ctx)) return true;
  const bocas = bocasDe(ctx);
  if (!bocas.length) return false;
  const fila = await db.get(
    `SELECT COUNT(*) AS n FROM predio_boca WHERE predio_id = ? AND es_almacen = 1 AND id IN (${bocas.map(() => "?").join(", ")})`,
    [ctx.pid, ...bocas]);
  return Number(fila?.n || 0) > 0;
}

// ------------------------------------------------------------------ opciones

async function opciones(ctx) {
  const fuente = ctx.params.fuente;
  const db = ctx.db;
  const pid = ctx.pid;
  switch (fuente) {
    case "bocas":
    case "bocas_origen":
    case "bocas_destino":
    case "bocas_venta": {
      let extra = "";
      if (fuente === "bocas_origen") extra = " AND b.es_origen = 1";
      if (fuente === "bocas_destino") extra = " AND b.es_destino = 1";
      if (fuente === "bocas_venta") extra = " AND EXISTS (SELECT 1 FROM predio_caja c WHERE c.predio_id = b.predio_id AND c.boca_id = b.id AND c.activo = 1)";
      const filas = await db.all(
        `SELECT b.id, b.nombre, b.es_origen, b.es_destino, b.es_almacen, b.margen_venta FROM predio_boca b
         WHERE b.predio_id = ? AND b.activo = 1${extra} ORDER BY b.nombre`, [pid]);
      return filas.map((f) => ({ valor: f.id, texto: f.nombre, es_origen: !!Number(f.es_origen), es_destino: !!Number(f.es_destino),
        es_almacen: !!Number(f.es_almacen), margen_venta: esAdmin(ctx) ? f.margen_venta : undefined }));
    }
    case "cajas": {
      const filas = await db.all(
        `SELECT c.id, c.nombre, c.boca_id, b.nombre AS boca FROM predio_caja c
         JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
         WHERE c.predio_id = ? AND c.activo = 1 ORDER BY b.nombre, c.nombre`, [pid]);
      return filas.map((f) => ({ valor: f.id, texto: `${f.boca} · ${f.nombre}`, boca_id: f.boca_id }));
    }
    case "proveedores": {
      const filas = await db.all(
        "SELECT id, razon_social, codigo, cuit FROM predio_proveedor WHERE predio_id = ? AND activo = 1 ORDER BY razon_social", [pid]);
      return filas.map((f) => ({ valor: f.id, texto: f.razon_social, detalle: [f.codigo, f.cuit].filter(Boolean).join(" · ") }));
    }
    case "productos": {
      const filas = await db.all(
        "SELECT id, nombre, codigo, precio_venta, precio_compra, margen, destino FROM predio_producto WHERE predio_id = ? AND activo = 1 ORDER BY nombre", [pid]);
      const costos = await veCostos(db, ctx);
      return filas.map((f) => ({
        valor: f.id, texto: f.nombre, codigo: f.codigo, precio_venta: PB.redondearVenta(f.precio_venta),
        precio_compra: costos ? Number(f.precio_compra || 0) : undefined, margen: costos ? Number(f.margen || 0) : undefined, destino: f.destino,
      }));
    }
    case "usuarios": {
      const filas = await db.all("SELECT id, nombre FROM predio_usuario WHERE predio_id = ? ORDER BY nombre", [pid]);
      return filas.map((f) => ({ valor: f.id, texto: f.nombre }));
    }
    case "departamentales": {
      const filas = await db.all("SELECT id, nombre FROM predio_departamental WHERE predio_id = ? AND activo = 1 ORDER BY nombre", [pid]);
      return filas.map((f) => ({ valor: f.id, texto: f.nombre }));
    }
    default:
      throw U.error("Lista desconocida", 404);
  }
}

// ------------------------------------------------------------------ productos

// Búsqueda rápida para los desplegables con escáner: el código exacto va primero.
async function buscarProductos(ctx) {
  const q = String(ctx.query.q || "").trim().slice(0, 80);
  let bocaId = Number(ctx.query.boca_id) || null;
  const soloVenta = ctx.query.venta === "1";
  const catalogoAviso = ctx.query.contexto === "aviso";
  const sinStock = soloVenta && ctx.query.sin_stock === "1";
  if (soloVenta || catalogoAviso) {
    const puesto = exigirPuesto(ctx);
    if (bocaId && bocaId !== Number(puesto.boca_id)) throw U.error("La búsqueda de ventas corresponde a la boca de tu caja", 403);
    bocaId = Number(puesto.boca_id);
    exigirBoca(ctx, bocaId);
    // Los productos agotados no forman un catálogo alternativo de ventas.
    if (sinStock) return [];
    if (soloVenta && q && /^\d{1,60}$/.test(q)) {
      const puntual = await consultarCodigo({ ...ctx, query: { codigo: q } });
      // Un código exacto no vendible debe explicar su problema; no sugerir otro
      // producto de código parecido como si el escaneo no hubiera encontrado nada.
      if (["SIN_PRECIO", "SIN_STOCK", "CODIGO_DUPLICADO"].includes(puntual.estado)) return [];
    }
  } else if (bocaId) exigirBoca(ctx, bocaId);
  const db = ctx.db;
  const params = [bocaId || -1, ctx.pid];
  const enCaja = soloVenta || catalogoAviso;
  const stockSql = enCaja ? Porciones.stockVentaSql : "COALESCE(s.cantidad, 0)";
  const uniones = `LEFT JOIN predio_boca b ON b.predio_id = p.predio_id AND b.id = ?
    ${PB.joinMargenSql} ${enCaja ? Porciones.joinStockVenta : "LEFT JOIN predio_stock s ON s.predio_id = p.predio_id AND s.producto_id = p.id AND s.boca_id = b.id"}`;
  const costos = await veCostos(db, ctx);
  const ultimoCosto = costos && !soloVenta && !catalogoAviso
    ? `(SELECT ci.precio_unitario FROM predio_compra_item ci JOIN predio_compra c ON c.predio_id = ci.predio_id AND c.id = ci.compra_id
        WHERE ci.predio_id = p.predio_id AND ci.producto_id = p.id AND c.estado = 'CARGADA' ORDER BY ci.id DESC LIMIT 1)` : "NULL";
  const columnas = `p.id, p.nombre, p.codigo, ${PB.precioBocaSql} AS precio_venta, p.precio_compra, ${ultimoCosto} AS ultimo_costo,
    p.margen, p.destino, p.perecedero, p.fecha_caducidad, ${stockSql} AS stock_boca`;
  let where = "p.predio_id = ? AND p.activo = 1";
  if (soloVenta) {
    where += ` AND p.destino <> 'USO_INTERNO' AND (${PB.precioBocaSql}) > 0`;
    where += ` AND (${stockSql}) > 0`;
  }
  const baseWhere = where;
  let orden = "p.nombre";
  if (q) {
    const palabras = q.split(/\s+/).slice(0, 5);
    const condiciones = palabras.map(() => `(${db.buscar("p.nombre")} LIKE ? OR p.codigo LIKE ?)`);
    where += ` AND (p.codigo = ? OR (${condiciones.join(" AND ")}))`;
    params.push(q);
    for (const p of palabras) params.push(`%${db.normParam(p)}%`, `${p}%`);
    orden = "CASE WHEN p.codigo = ? THEN 0 ELSE 1 END, p.nombre";
  }
  const sql = `SELECT ${columnas} FROM predio_producto p ${uniones}
    WHERE ${where} ORDER BY ${orden} LIMIT 30`;
  if (q) params.push(q);
  const filas = await db.all(sql, params);
  // La consulta normal conserva su contrato. Al escanear un código más largo que
  // el importado, se agregan como máximo ocho sugerencias, nunca coincidencias exactas.
  if (/^\d{8,60}$/.test(q) && !filas.some((f) => f.codigo === q)) {
    const candidatos = await db.all(
      `SELECT ${columnas} FROM predio_producto p ${uniones}
       WHERE ${baseWhere} AND p.codigo IS NOT NULL AND LENGTH(p.codigo) BETWEEN ? AND ?`,
      [bocaId || -1, ctx.pid, Math.max(6, q.length - 6), Math.min(60, q.length + 1)]);
    const ids = new Set(filas.map((f) => Number(f.id)));
    const cercanos = candidatos.map((f) => ({ fila: f, distancia: proximidadCodigo(f.codigo, q) }))
      .filter((f) => f.distancia !== null && f.distancia > 0 && !ids.has(Number(f.fila.id)))
      .sort((a, b) => a.distancia - b.distancia || a.fila.nombre.localeCompare(b.fila.nombre))
      .slice(0, 8).map((f) => f.fila);
    filas.push(...cercanos);
  }
  return filas.slice(0, 30).map((f) => ({
    id: f.id, nombre: f.nombre, codigo: f.codigo, precio_venta: Number(f.precio_venta || 0),
    ultimo_costo: costos ? (f.ultimo_costo == null ? null : Number(f.ultimo_costo)) : undefined,
    precio_compra: costos ? Number(f.precio_compra || 0) : undefined, margen: costos ? Number(f.margen || 0) : undefined, destino: f.destino,
    perecedero: !!Number(f.perecedero), fecha_caducidad: f.fecha_caducidad, stock_boca: Number(f.stock_boca || 0),
    exacto: !!q && f.codigo === q,
    sugerido: !!q && f.codigo !== q && proximidadCodigo(f.codigo, q) !== null,
    coincidencia: !!q && f.codigo === q ? "EXACTA" : (proximidadCodigo(f.codigo, q) !== null ? "CODIGO_APROXIMADO" : "TEXTO"),
    estado_venta: catalogoAviso ? (f.destino === "USO_INTERNO" ? "USO_INTERNO" : Number(f.precio_venta || 0) <= 0 ? "SIN_PRECIO" : Number(f.stock_boca || 0) <= 0 ? "SIN_STOCK" : "DISPONIBLE") : undefined,
  }));
}

// Diagnóstico puntual del código leído, sin enumerar los productos excluidos.
async function consultarCodigo(ctx) {
  const puesto = exigirPuesto(ctx);
  exigirBoca(ctx, puesto.boca_id);
  const codigo = U.texto(ctx.query.codigo, { max: 60, requerido: true, campo: "El código escaneado" });
  const filas = await ctx.db.all(
    `SELECT p.id, p.nombre, p.codigo, ${PB.precioBocaSql} AS precio_venta, p.destino, ${Porciones.stockVentaSql} AS stock_boca
     FROM predio_producto p JOIN predio_boca b ON b.predio_id = p.predio_id AND b.id = ? ${PB.joinMargenSql}
     ${Porciones.joinStockVenta}
     WHERE p.predio_id = ? AND p.activo = 1 AND p.destino <> 'USO_INTERNO' AND p.codigo = ? LIMIT 2`, [puesto.boca_id, ctx.pid, codigo]);
  if (filas.length !== 1) return { producto: null, estado: filas.length ? "CODIGO_DUPLICADO" : "NO_ENCONTRADO" };
  const p = filas[0];
  p.precio_venta = Number(p.precio_venta || 0);
  p.stock_boca = Number(p.stock_boca || 0);
  return { producto: p, estado: p.precio_venta <= 0 ? "SIN_PRECIO" : (p.stock_boca <= 0 ? "SIN_STOCK" : "DISPONIBLE") };
}

// Serializa todas las altas/ediciones de códigos del catálogo en los dos motores.
// No se usa un índice UNIQUE: el catálogo histórico puede contener repetidos inactivos.
async function bloquearCodigos(t, ctx) {
  await t.run(`${t.insertIgnore} INTO predio_secuencia (predio_id, tabla, ultimo) VALUES (?, 'codigos_producto', 0)`, [ctx.pid]);
  await t.get(`SELECT ultimo FROM predio_secuencia WHERE predio_id = ? AND tabla = 'codigos_producto'${t.forUpdate}`, [ctx.pid]);
}

async function corregirCodigoBarras(ctx) {
  if (ctx.body.confirmar !== true) throw U.error("Confirmá que cotejaste el producto y su código con el envase");
  const id = U.id(ctx.params.id);
  const anterior = U.texto(ctx.body.codigo_anterior, { max: 60, requerido: true, campo: "El código anterior" });
  const nuevo = U.texto(ctx.body.codigo_nuevo, { max: 60, requerido: true, campo: "El código escaneado" });
  if (!esAdmin(ctx)) {
    const puesto = exigirPuesto(ctx);
    exigirBoca(ctx, puesto.boca_id);
  }
  if (!/^\d{8,60}$/.test(nuevo)) throw U.error("Volvé a escanear el código completo del envase");
  if ([8, 12, 13, 14].includes(nuevo.length) && !gtinValido(nuevo)) {
    throw U.error("El dígito de control del código escaneado no es válido. Revisá el envase y volvé a escanear.", 400, { codigo: "CODIGO_BARRAS_INVALIDO" });
  }
  return ctx.db.tx(async (t) => {
    await bloquearCodigos(t, ctx);
    if (!esAdmin(ctx)) {
      const caja = await N.exigir(t, ctx, "predio_caja", ctx.sesion.caja_id, "La caja ya no existe");
      const boca = await N.exigir(t, ctx, "predio_boca", ctx.sesion.boca_id, "La boca ya no existe");
      if (!Number(caja.activo) || !Number(boca.activo) || Number(caja.boca_id) !== Number(boca.id)) {
        throw U.error("Elegí nuevamente la boca y la caja", 409, { codigo: "SIN_PUESTO" });
      }
    }
    const p = await N.exigir(t, ctx, "predio_producto", id, "No encontramos el producto", { bloquear: true });
    if (!Number(p.activo)) throw U.error("El producto está dado de baja", 409);
    if (String(p.codigo || "") !== anterior) throw U.error("El código del producto cambió mientras lo revisabas. Volvé a buscarlo.", 409, { codigo: "CODIGO_MODIFICADO", codigo_actual: p.codigo });
    if (!esAdmin(ctx) && p.destino === "USO_INTERNO") throw U.error("Este producto se corrige desde Gestión", 403);
    if (proximidadCodigo(anterior, nuevo) === null) throw U.error("El código no es próximo al guardado. Pedile al administrador que revise la ficha del producto.", 409);
    const dup = await codigoDuplicado(t, ctx, nuevo, id);
    if (dup) throw U.error(`Ese código ya pertenece a «${dup.nombre}». No se modificó el producto.`, 409, { codigo: "CODIGO_DUPLICADO" });
    if (nuevo !== anterior) {
      await N.actualizar(t, ctx, "predio_producto", id, { codigo: nuevo });
      await N.auditar(t, ctx, "Corrección de código de barras cotejado con el envase", "producto", id, {
        producto: p.nombre, codigo: { antes: anterior, despues: nuevo },
        boca_id: ctx.sesion?.boca_id || null, caja_id: ctx.sesion?.caja_id || null,
      });
    }
    return { id, codigo: nuevo, mensaje: "Código de barras actualizado" };
  });
}

async function detalleProducto(ctx) {
  const id = U.id(ctx.params.id);
  const db = ctx.db;
  const p = await N.exigir(db, ctx, "predio_producto", id, "No encontramos el producto");
  const stock = await db.all(
    `SELECT b.id AS boca_id, b.nombre AS boca, b.es_almacen, b.activo, COALESCE(fis.cantidad, 0) AS cantidad,
            ${Porciones.porcionesDisponiblesSql} AS porciones_disponibles
     FROM predio_producto p JOIN predio_boca b ON b.predio_id = p.predio_id
     LEFT JOIN predio_stock fis ON fis.predio_id = p.predio_id AND fis.boca_id = b.id AND fis.producto_id = p.id
     ${Porciones.joinStockVenta}
     WHERE p.predio_id = ? AND p.id = ? AND (b.activo = 1 OR fis.id IS NOT NULL) ORDER BY b.es_almacen DESC, b.nombre`,
    [ctx.pid, id]);
  const precios = await db.all(
    `SELECT h.fecha, h.precio_compra, h.margen, h.precio_venta, h.origen, h.referencia_id, h.usuario_nombre, h.boca_id, b.nombre AS boca
     FROM predio_precio_historial h LEFT JOIN predio_boca b ON b.predio_id = h.predio_id AND b.id = h.boca_id
     WHERE h.predio_id = ? AND h.producto_id = ? ORDER BY h.id DESC LIMIT 100`,
    [ctx.pid, id]);
  return { producto: { ...p, receta: p.destino === "VENTA_COMPUESTA" ? await Porciones.leer(db, ctx, id) : null, precio_venta: PB.redondearVenta(p.precio_venta) }, stock, precios,
    margenes_boca: await PB.preciosDeProducto(db, ctx, id) };
}

function validarProducto(body, { parcial = false } = {}) {
  const datos = {};
  if (!parcial || body.nombre !== undefined) datos.nombre = U.texto(body.nombre, { max: 160, campo: "El nombre", requerido: true });
  if (!parcial || body.codigo !== undefined) datos.codigo = U.texto(body.codigo, { max: 60, campo: "El código" });
  if (!parcial || body.precio_compra !== undefined) datos.precio_compra = U.numero(body.precio_compra ?? 0, { min: 0, max: 99999999, campo: "El precio de compra" });
  if (!parcial || body.margen !== undefined) datos.margen = U.numero(body.margen ?? 0, { min: -100, max: 10000, campo: "El margen" });
  if (!parcial || body.destino !== undefined) datos.destino = U.opcion(body.destino || "VENTA_DIRECTA", DESTINOS_VALIDOS, "El destino");
  if (!parcial || body.perecedero !== undefined) datos.perecedero = U.bool(body.perecedero);
  if (!parcial || body.fecha_caducidad !== undefined) datos.fecha_caducidad = U.fecha(body.fecha_caducidad, { campo: "La fecha de caducidad" });
  if (!parcial || body.stock_minimo !== undefined) datos.stock_minimo = U.numero(body.stock_minimo ?? 0, { min: 0, max: 9999999, decimales: 3, campo: "El stock mínimo" });
  if (!parcial || body.unidad !== undefined) datos.unidad = U.texto(body.unidad, { max: 20 });
  if (datos.perecedero === 0 && body.fecha_caducidad === undefined) datos.fecha_caducidad = null;
  if (datos.perecedero === 0) datos.fecha_caducidad = null;
  return datos;
}

async function codigoDuplicado(t, ctx, codigo, exceptoId) {
  if (!codigo) return null;
  return t.get(
    "SELECT id, nombre FROM predio_producto WHERE predio_id = ? AND codigo = ? AND activo = 1 AND id <> ? LIMIT 1",
    [ctx.pid, codigo, exceptoId || -1]);
}

async function crearProducto(ctx) {
  exigirAdmin(ctx);
  const datos = validarProducto(ctx.body);
  const cantidadAlmacen = U.numero(ctx.body.cantidad_almacen ?? 0, { min: 0, max: 9999999, decimales: 3, campo: "La cantidad en almacén" });
  datos.precio_venta = ctx.body.precio_venta_manual !== undefined && ctx.body.precio_venta_manual !== null && ctx.body.precio_venta_manual !== ""
    ? PB.redondearVenta(U.numero(ctx.body.precio_venta_manual, { min: 0, campo: "El precio de venta" }))
    : PB.precioVenta(datos.precio_compra, datos.margen);
  return ctx.db.tx(async (t) => {
    await PB.bloquearPrecios(t, ctx);
    await bloquearCodigos(t, ctx);
    const dup = await codigoDuplicado(t, ctx, datos.codigo);
    if (dup) throw U.error(`Ese código ya lo tiene «${dup.nombre}». Revisá el código ingresado.`, 409);
    const nombreDup = await t.get("SELECT id FROM predio_producto WHERE predio_id = ? AND LOWER(nombre) = LOWER(?) AND activo = 1", [ctx.pid, datos.nombre]);
    if (nombreDup) throw U.error("Ya hay un producto activo con ese nombre", 409);
    const id = await N.insertar(t, ctx, "predio_producto", { ...datos, activo: 1, fecha_revision_precio: U.fechaHora() });
    if (ctx.body.receta) await Porciones.guardar(t, ctx, id, datos.destino, ctx.body.receta);
    await PB.guardarExcepciones(t, ctx, id, ctx.body.margenes_boca, await PB.preciosDeProducto(t, ctx, id));
    await PB.registrarCambioProducto(t, ctx, id, [], "ALTA_BOCA");
    await N.insertar(t, ctx, "predio_precio_historial", {
      producto_id: id, fecha: U.fechaHora(), precio_compra: datos.precio_compra, margen: datos.margen,
      precio_venta: datos.precio_venta, origen: "ALTA", usuario_nombre: N.nombreActor(ctx),
    });
    if (cantidadAlmacen > 0) {
      const almacen = await N.bocaAlmacen(t, ctx);
      if (!almacen) throw U.error("Primero marcá una boca como almacén en Gestión → Bocas", 409);
      await N.moverStock(t, ctx, {
        bocaId: almacen.id, productoId: id, cantidad: cantidadAlmacen, tipo: "ALTA_INICIAL",
        referenciaTipo: "producto", referenciaId: id, detalle: "Cantidad inicial al crear el producto",
      });
    }
    await N.auditar(t, ctx, "Alta de producto", "producto", id, { ...datos, receta: ctx.body.receta || undefined, cantidad_almacen: cantidadAlmacen });
    return { id, mensaje: "Producto creado" };
  });
}

async function editarProducto(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const datos = validarProducto(ctx.body, { parcial: true });
  if (ctx.body.activo !== undefined) datos.activo = U.bool(ctx.body.activo);
  return ctx.db.tx(async (t) => {
    await PB.bloquearPrecios(t, ctx);
    if (datos.codigo !== undefined || datos.activo === 1) await bloquearCodigos(t, ctx);
    const antes = await N.exigir(t, ctx, "predio_producto", id, "No encontramos el producto", { bloquear: true });
    const cambiaReceta = ctx.body.receta !== undefined || (datos.destino !== undefined && datos.destino !== antes.destino);
    let recetaAntes;
    if (cambiaReceta) {
      recetaAntes = await Porciones.leer(t, ctx, id);
      if (datos.destino === "ALQUILER" && await Porciones.esInsumo(t, ctx, id)) throw U.error("Este producto se usa como insumo de una porción.");
      await Porciones.guardar(t, ctx, id, datos.destino || antes.destino, ctx.body.receta);
    }
    const preciosAntes = await PB.preciosDeProducto(t, ctx, id);
    if (datos.stock_minimo !== undefined || datos.activo !== undefined) await bloquearStockProducto(t, ctx, id);
    const compra = datos.precio_compra !== undefined ? datos.precio_compra : Number(antes.precio_compra || 0);
    const margen = datos.margen !== undefined ? datos.margen : Number(antes.margen || 0);
    if (ctx.body.precio_venta_manual !== undefined && ctx.body.precio_venta_manual !== null && ctx.body.precio_venta_manual !== "") {
      datos.precio_venta = PB.redondearVenta(U.numero(ctx.body.precio_venta_manual, { min: 0, campo: "El precio de venta" }));
    } else if (datos.precio_compra !== undefined || datos.margen !== undefined) {
      datos.precio_venta = PB.precioVenta(compra, margen);
    }
    if (datos.codigo || datos.activo === 1) {
      const dup = await codigoDuplicado(t, ctx, datos.codigo === undefined ? antes.codigo : datos.codigo, id);
      if (dup) throw U.error(`Ese código ya lo tiene «${dup.nombre}»`, 409);
    }
    const revisarPrecio = ctx.body.confirmar_revision_precio === true || ["precio_compra", "margen", "precio_venta"].some((c) => datos[c] !== undefined && Number(datos[c] || 0) !== Number(antes[c] || 0));
    if (revisarPrecio) datos.fecha_revision_precio = U.fechaHora();
    await N.actualizar(t, ctx, "predio_producto", id, datos);
    await PB.guardarExcepciones(t, ctx, id, ctx.body.margenes_boca, preciosAntes);
    if (revisarPrecio || ctx.body.margenes_boca !== undefined)
      await PB.registrarCambioProducto(t, ctx, id, preciosAntes, ctx.body.margenes_boca !== undefined ? "MARGEN_PRODUCTO" : "EDICION_BOCA");
    const despues = await N.obtener(t, ctx, "predio_producto", id);
    const cambios = N.diferencias(antes, despues);
    if (cambiaReceta) {
      const recetaDespues = await Porciones.leer(t, ctx, id);
      if (JSON.stringify(recetaAntes) !== JSON.stringify(recetaDespues)) cambios.receta = { antes: recetaAntes, despues: recetaDespues };
    }
    if (revisarPrecio) {
      await N.insertar(t, ctx, "predio_precio_historial", {
        producto_id: id, fecha: U.fechaHora(), precio_compra: despues.precio_compra, margen: despues.margen,
        precio_venta: despues.precio_venta, origen: "EDICION", usuario_nombre: N.nombreActor(ctx),
      });
      await resolverRevisionProducto(t, ctx, id);
    }
    // Ajuste manual de la cantidad en almacén (queda como movimiento "Ajuste manual").
    if (ctx.body.cantidad_almacen !== undefined && ctx.body.cantidad_almacen !== null && ctx.body.cantidad_almacen !== "") {
      const nueva = U.numero(ctx.body.cantidad_almacen, { min: 0, max: 9999999, decimales: 3, campo: "La cantidad en almacén" });
      const almacen = await N.bocaAlmacen(t, ctx);
      if (almacen) {
        const actual = await N.bloquearSaldoStock(t, ctx, almacen.id, id);
        const delta = U.redondear(nueva - actual, 3);
        if (delta) {
          await N.moverStock(t, ctx, {
            bocaId: almacen.id, productoId: id, cantidad: delta, tipo: "AJUSTE", referenciaTipo: "producto", referenciaId: id,
            detalle: `Ajuste manual desde la ficha (de ${actual} a ${nueva})`,
          });
          cambios.cantidad_almacen = { antes: actual, despues: nueva };
        }
      }
    }
    if (datos.stock_minimo !== undefined || datos.activo !== undefined) await revisarStockMinimoProducto(t, ctx, id);
    if (Object.keys(cambios).length) await N.auditar(t, ctx, "Modificación de producto", "producto", id, cambios);
    return { id, mensaje: "Producto actualizado", cambios };
  });
}

// ------------------------------------------------------------------ proveedores

function validarProveedor(body) {
  const cuit = body.cuit ? String(body.cuit).replace(/\D/g, "") : "";
  if (cuit && !U.cuitValido(cuit)) throw U.error("El CUIT no es válido: revisá los 11 números");
  const email = U.texto(body.email, { max: 120, campo: "El correo" });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw U.error("El correo no es válido");
  return {
    codigo: U.texto(body.codigo, { max: 30, campo: "El código" }),
    razon_social: U.texto(body.razon_social, { max: 160, campo: "La razón social", requerido: true }),
    cuit: cuit ? U.formatoCuit(cuit) : null,
    telefono: U.texto(body.telefono, { max: 40 }),
    email,
    direccion: U.texto(body.direccion, { max: 200 }),
    contacto: U.texto(body.contacto, { max: 120 }),
    observaciones: U.textoLargo(body.observaciones, { max: 2000 }),
  };
}

async function siguienteCodigoProveedor(t, ctx) {
  const filas = await t.all("SELECT codigo FROM predio_proveedor WHERE predio_id = ?", [ctx.pid]);
  let max = 0;
  for (const f of filas) {
    const n = Number(String(f.codigo || "").replace(/\D/g, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, "0");
}

async function crearProveedor(ctx) {
  exigirAdmin(ctx);
  const datos = validarProveedor(ctx.body);
  return ctx.db.tx(async (t) => {
    if (!datos.codigo) datos.codigo = await siguienteCodigoProveedor(t, ctx);
    const dupCodigo = await t.get("SELECT id FROM predio_proveedor WHERE predio_id = ? AND codigo = ?", [ctx.pid, datos.codigo]);
    if (dupCodigo) throw U.error("Ya hay un proveedor con ese código", 409);
    if (datos.cuit) {
      const dup = await t.get("SELECT razon_social FROM predio_proveedor WHERE predio_id = ? AND cuit = ? AND activo = 1", [ctx.pid, datos.cuit]);
      if (dup) throw U.error(`Ese CUIT ya está cargado para «${dup.razon_social}»`, 409);
    }
    const id = await N.insertar(t, ctx, "predio_proveedor", { ...datos, activo: 1 });
    await N.auditar(t, ctx, "Alta de proveedor", "proveedor", id, datos);
    return { id, codigo: datos.codigo, mensaje: "Proveedor creado" };
  });
}

async function editarProveedor(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  return ctx.db.tx(async (t) => {
    const antes = await N.exigir(t, ctx, "predio_proveedor", id, "No encontramos el proveedor");
    let datos;
    if (Object.keys(ctx.body).length === 1 && ctx.body.activo !== undefined) datos = { activo: U.bool(ctx.body.activo) };
    else {
      datos = validarProveedor({ ...antes, ...ctx.body });
      if (ctx.body.activo !== undefined) datos.activo = U.bool(ctx.body.activo);
      if (!datos.codigo) datos.codigo = antes.codigo;
      const dupCodigo = await t.get("SELECT id FROM predio_proveedor WHERE predio_id = ? AND codigo = ? AND id <> ?", [ctx.pid, datos.codigo, id]);
      if (dupCodigo) throw U.error("Ya hay otro proveedor con ese código", 409);
    }
    await N.actualizar(t, ctx, "predio_proveedor", id, datos);
    const despues = await N.obtener(t, ctx, "predio_proveedor", id);
    const cambios = N.diferencias(antes, despues);
    if (Object.keys(cambios).length) await N.auditar(t, ctx, "Modificación de proveedor", "proveedor", id, cambios);
    return { id, mensaje: "Proveedor actualizado" };
  });
}

async function detalleProveedor(ctx) {
  exigirAdmin(ctx);
  return { proveedor: await N.exigir(ctx.db, ctx, "predio_proveedor", U.id(ctx.params.id), "No encontramos el proveedor") };
}

// ------------------------------------------------------------------ bocas y cajas

function validarBoca(body) {
  const sentido = String(body.sentido || "").toUpperCase();
  let esOrigen = U.bool(body.es_origen);
  let esDestino = U.bool(body.es_destino);
  if (sentido === "ORIGEN") { esOrigen = 1; esDestino = 0; }
  if (sentido === "DESTINO") { esOrigen = 0; esDestino = 1; }
  if (sentido === "AMBOS") { esOrigen = 1; esDestino = 1; }
  if (!esOrigen && !esDestino) throw U.error("La boca tiene que ser de origen, de destino o de las dos");
  return {
    nombre: U.texto(body.nombre, { max: 80, campo: "El nombre", requerido: true }),
    es_origen: esOrigen,
    es_destino: esDestino,
    es_almacen: U.bool(body.es_almacen),
    margen_venta: U.numero(body.margen_venta, { min: -100, max: 10000, requerido: false, campo: "El margen de la boca" }),
    descripcion: U.texto(body.descripcion, { max: 255 }),
  };
}

async function guardarBoca(ctx) {
  exigirAdmin(ctx);
  const id = ctx.params.id ? U.id(ctx.params.id) : null;
  return ctx.db.tx(async (t) => {
    await PB.bloquearPrecios(t, ctx);
    const antes = id ? await N.exigir(t, ctx, "predio_boca", id, "No encontramos la boca", { bloquear: true }) : null;
    const datos = validarBoca({ ...antes, ...ctx.body });
    if (ctx.body.activo !== undefined) datos.activo = U.bool(ctx.body.activo);
    if (antes?.es_almacen && (!datos.es_almacen || datos.activo === 0)) throw U.error("Elegí otra boca como proveeduría antes de quitar la actual.", 409);
    if (datos.es_almacen && Number(datos.activo ?? antes?.activo ?? 1) === 0) throw U.error("La proveeduría debe estar activa.", 409);
    const dup = await t.get("SELECT id FROM predio_boca WHERE predio_id = ? AND LOWER(nombre) = LOWER(?) AND id <> ?", [ctx.pid, datos.nombre, id || -1]);
    if (dup) throw U.error("Ya hay una boca con ese nombre", 409);
    if (datos.es_almacen) {
      await t.run("UPDATE predio_boca SET es_almacen = 0 WHERE predio_id = ? AND id <> ? AND es_almacen = 1", [ctx.pid, id || -1]);
      datos.es_origen = 1;
    }
    if (id) {
      await N.actualizar(t, ctx, "predio_boca", id, datos);
      const cambios = N.diferencias(antes, await N.obtener(t, ctx, "predio_boca", id));
      if (cambios.margen_venta) await PB.registrarMargenBoca(t, ctx, id);
      if (Object.keys(cambios).length) await N.auditar(t, ctx, "Modificación de boca", "boca", id, cambios);
      return { id, mensaje: "Boca actualizada" };
    }
    const orden = await t.get("SELECT COALESCE(MAX(orden), 0) + 1 AS o FROM predio_boca WHERE predio_id = ?", [ctx.pid]);
    const nuevo = await N.insertar(t, ctx, "predio_boca", { ...datos, activo: 1, orden: Number(orden.o) });
    if (datos.margen_venta != null) await PB.registrarMargenBoca(t, ctx, nuevo);
    await N.auditar(t, ctx, "Alta de boca", "boca", nuevo, datos);
    return { id: nuevo, mensaje: "Boca creada" };
  });
}

async function guardarCaja(ctx) {
  exigirAdmin(ctx);
  const id = ctx.params.id ? U.id(ctx.params.id) : null;
  const datos = {
    boca_id: U.id(ctx.body.boca_id, "La boca"),
    nombre: U.texto(ctx.body.nombre, { max: 80, campo: "El nombre de la caja", requerido: true }),
    ancho_ticket: [58, 80].includes(Number(ctx.body.ancho_ticket)) ? Number(ctx.body.ancho_ticket) : 80,
    impresion_automatica: U.bool(ctx.body.impresion_automatica),
  };
  if (ctx.body.activo !== undefined) datos.activo = U.bool(ctx.body.activo);
  return ctx.db.tx(async (t) => {
    await N.exigir(t, ctx, "predio_boca", datos.boca_id, "No encontramos la boca");
    const dup = await t.get("SELECT id FROM predio_caja WHERE predio_id = ? AND boca_id = ? AND LOWER(nombre) = LOWER(?) AND id <> ?",
      [ctx.pid, datos.boca_id, datos.nombre, id || -1]);
    if (dup) throw U.error("Esa boca ya tiene una caja con ese nombre", 409);
    if (id) {
      const antes = await N.exigir(t, ctx, "predio_caja", id, "No encontramos la caja");
      await N.actualizar(t, ctx, "predio_caja", id, datos);
      const cambios = N.diferencias(antes, await N.obtener(t, ctx, "predio_caja", id));
      if (Object.keys(cambios).length) await N.auditar(t, ctx, "Modificación de caja", "caja", id, cambios);
      return { id, mensaje: "Caja actualizada" };
    }
    const nuevo = await N.insertar(t, ctx, "predio_caja", { ...datos, activo: 1 });
    await N.auditar(t, ctx, "Alta de caja", "caja", nuevo, datos);
    return { id: nuevo, mensaje: "Caja creada" };
  });
}

async function detalleCaja(ctx) {
  exigirAdmin(ctx);
  return { caja: await N.exigir(ctx.db, ctx, "predio_caja", U.id(ctx.params.id), "No encontramos la caja") };
}

async function detalleBoca(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const boca = await N.exigir(ctx.db, ctx, "predio_boca", id, "No encontramos la boca");
  const cajas = await ctx.db.all("SELECT * FROM predio_caja WHERE predio_id = ? AND boca_id = ? ORDER BY nombre", [ctx.pid, id]);
  return { boca, cajas };
}

// ------------------------------------------------------------------ usuarios

async function detalleUsuario(ctx) {
  exigirAdmin(ctx);
  const id = U.id(ctx.params.id);
  const u = await N.exigir(ctx.db, ctx, "predio_usuario", id, "No encontramos el usuario");
  delete u.password_hash;
  const bocas = await ctx.db.all("SELECT boca_id FROM predio_usuario_boca WHERE predio_id = ? AND usuario_id = ?", [ctx.pid, id]);
  return { usuario: u, bocas: bocas.map((b) => Number(b.boca_id)) };
}

async function guardarUsuario(ctx) {
  exigirAdmin(ctx);
  const id = ctx.params.id ? U.id(ctx.params.id) : null;
  const b = ctx.body;
  const datos = {
    usuario: U.texto(b.usuario, { max: 60, min: 3, campo: "El usuario", requerido: true }).toLowerCase().replace(/\s+/g, ""),
    nombre: U.texto(b.nombre, { max: 120, campo: "El nombre", requerido: true }),
    rol: U.opcion(b.rol || "CAJERO", ["ADMIN", "CAJERO"], "El rol"),
  };
  if (!/^[a-z0-9._-]+$/.test(datos.usuario)) throw U.error("El usuario sólo puede tener letras, números, punto, guion o guion bajo");
  if (b.gestionar_reservas !== undefined) datos.gestionar_reservas = U.bool(b.gestionar_reservas);
  if (b.activo !== undefined) datos.activo = U.bool(b.activo);
  const bocas = Array.isArray(b.bocas) ? [...new Set(b.bocas.map((x) => U.id(x, "La boca")))] : [];
  if (datos.rol === "CAJERO" && !bocas.length) throw U.error("Asigná al menos una boca al usuario");
  const password = b.password ? String(b.password) : "";
  if (!id && password.length < 4) throw U.error("La contraseña tiene que tener al menos 4 caracteres");
  if (password && password.length < 4) throw U.error("La contraseña tiene que tener al menos 4 caracteres");
  if (password) datos.password_hash = U.hashPassword(password);
  return ctx.db.tx(async (t) => {
    const dup = await t.get("SELECT id FROM predio_usuario WHERE predio_id = ? AND usuario = ? AND id <> ?", [ctx.pid, datos.usuario, id || -1]);
    if (dup) throw U.error("Ese nombre de usuario ya existe", 409);
    let usuarioId = id;
    if (id) {
      const antes = await N.exigir(t, ctx, "predio_usuario", id, "No encontramos el usuario");
      if (Number(antes.es_admin_general) === 1) throw U.error("Los administradores del sistema general se gestionan desde el sistema general", 409);
      if (Number(ctx.usuario.id) === id && datos.activo === 0) throw U.error("No podés deshabilitar tu propio usuario", 409);
      await N.actualizar(t, ctx, "predio_usuario", id, datos);
      const cambios = N.diferencias(antes, await N.obtener(t, ctx, "predio_usuario", id));
      if (password) cambios.password = "cambiada";
      await N.auditar(t, ctx, "Modificación de usuario", "usuario", id, cambios);
    } else {
      usuarioId = await N.insertar(t, ctx, "predio_usuario", { ...datos, activo: 1, es_admin_general: 0 });
      await N.auditar(t, ctx, "Alta de usuario", "usuario", usuarioId, { usuario: datos.usuario, nombre: datos.nombre, rol: datos.rol, bocas });
    }
    const actuales = (await t.all("SELECT id, boca_id FROM predio_usuario_boca WHERE predio_id = ? AND usuario_id = ?", [ctx.pid, usuarioId]));
    for (const a of actuales) {
      if (!bocas.includes(Number(a.boca_id))) await t.run("DELETE FROM predio_usuario_boca WHERE predio_id = ? AND id = ?", [ctx.pid, a.id]);
    }
    for (const bocaId of bocas) {
      if (!actuales.some((a) => Number(a.boca_id) === bocaId)) {
        await N.exigir(t, ctx, "predio_boca", bocaId, "Una de las bocas no existe");
        await N.insertar(t, ctx, "predio_usuario_boca", { usuario_id: usuarioId, boca_id: bocaId });
      }
    }
    return { id: usuarioId, mensaje: id ? "Usuario actualizado" : "Usuario creado" };
  });
}

// ------------------------------------------------------------------ configuración

const CLAVES_CONFIG = ["nombre_predio", "razon_social", "cuit", "direccion", "leyenda_ticket", "texto_autorizacion", "minutos_permiso"];

async function verConfig(ctx) {
  return { config: await N.leerConfig(ctx.db, ctx) };
}

async function guardarConfigApi(ctx) {
  exigirAdmin(ctx);
  return ctx.db.tx(async (t) => {
    const antes = await N.leerConfig(t, ctx);
    const cambios = {};
    for (const clave of CLAVES_CONFIG) {
      if (ctx.body[clave] === undefined) continue;
      const valor = String(ctx.body[clave] ?? "").slice(0, 2000);
      if (valor !== String(antes[clave] ?? "")) {
        await N.guardarConfig(t, ctx, clave, valor);
        cambios[clave] = { antes: antes[clave], despues: valor };
      }
    }
    if (Object.keys(cambios).length) await N.auditar(t, ctx, "Configuración del predio", "sistema", null, cambios);
    return { mensaje: "Configuración guardada" };
  });
}

module.exports = {
  precioVenta: PB.precioVenta,
  rutas: [
    { m: "GET", p: "/opciones/:fuente", h: opciones },
    { m: "GET", p: "/productos/buscar", h: buscarProductos },
    { m: "GET", p: "/productos/consultar-codigo", h: consultarCodigo, soloLocal: true },
    { m: "POST", p: "/productos/:id/codigo-barras", h: corregirCodigoBarras, escritura: true },
    { m: "GET", p: "/productos/:id", h: detalleProducto, roles: ["ADMIN"] },
    { m: "POST", p: "/productos", h: crearProducto, escritura: true, roles: ["ADMIN"] },
    { m: "PUT", p: "/productos/:id", h: editarProducto, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/proveedores/:id", h: detalleProveedor, roles: ["ADMIN"] },
    { m: "POST", p: "/proveedores", h: crearProveedor, escritura: true, roles: ["ADMIN"] },
    { m: "PUT", p: "/proveedores/:id", h: editarProveedor, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/bocas/:id", h: detalleBoca, roles: ["ADMIN"] },
    { m: "POST", p: "/bocas", h: guardarBoca, escritura: true, roles: ["ADMIN"] },
    { m: "PUT", p: "/bocas/:id", h: guardarBoca, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/cajas/:id", h: detalleCaja, roles: ["ADMIN"] },
    { m: "POST", p: "/cajas", h: guardarCaja, escritura: true, roles: ["ADMIN"] },
    { m: "PUT", p: "/cajas/:id", h: guardarCaja, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/usuarios/:id", h: detalleUsuario, roles: ["ADMIN"] },
    { m: "POST", p: "/usuarios", h: guardarUsuario, escritura: true, roles: ["ADMIN"] },
    { m: "PUT", p: "/usuarios/:id", h: guardarUsuario, escritura: true, roles: ["ADMIN"] },
    { m: "GET", p: "/config", h: verConfig },
    { m: "PUT", p: "/config", h: guardarConfigApi, escritura: true, roles: ["ADMIN"] },
  ],
  esAdmin,
  bocasDe,
};
