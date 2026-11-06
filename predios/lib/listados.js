"use strict";

// Motor de listados: cada tabla del sistema (productos, ventas, solicitudes, caja…)
// se declara una sola vez con sus columnas, filtros, búsqueda y resumen. El mismo
// motor responde la página JSON, el CSV completo y el CSV resumido, en SQLite y MySQL.

const { error, hoy, sumarDias, esFechaIso, redondear } = require("./util");
const { limiteRevision, fechaRevisionSql, historialRevisionSql } = require("./precios");

const DESTINOS = [
  { valor: "VENTA_DIRECTA", texto: "Venta directa" },
  { valor: "VENTA_COMPUESTA", texto: "Venta compuesta" },
  { valor: "USO_INTERNO", texto: "Uso interno" },
  { valor: "ALQUILER", texto: "Alquiler" },
];
const FORMAS_PAGO = [
  { valor: "SALDO", texto: "Saldo de estadía" }, { valor: "MIXTO", texto: "Pago combinado" },
  { valor: "EFECTIVO", texto: "Efectivo" },
  { valor: "QR", texto: "QR" },
  { valor: "TARJETA_DEBITO", texto: "Tarjeta de débito" },
  { valor: "TARJETA_CREDITO", texto: "Tarjeta de crédito" },
  { valor: "TRANSFERENCIA", texto: "Transferencia" },
  { valor: "DESCUENTO", texto: "Descuento de haberes" },
];
const MOTIVOS_BAJA = [
  { valor: "ROTURA", texto: "Rotura" },
  { valor: "VENCIMIENTO", texto: "Vencimiento" },
  { valor: "MATERIA_PRIMA", texto: "Materia prima" },
  { valor: "INSUMO", texto: "Insumo" },
  { valor: "CONSUMO_DESTINO", texto: "Consumo en destino" },
  { valor: "OTROS", texto: "Otros motivos" },
];
const ESTADOS_SOLICITUD = [
  { valor: "PENDIENTE", texto: "Pendiente" },
  { valor: "DESPACHADA", texto: "Despachada" },
  { valor: "RECIBIDA", texto: "Recibida" },
  { valor: "RECHAZADA", texto: "Rechazada" },
  { valor: "ANULADA", texto: "Anulada" },
];
const TIPOS_MOVIMIENTO = [
  { valor: "ALTA_INICIAL", texto: "Alta inicial" },
  { valor: "COMPRA", texto: "Compra" },
  { valor: "ANULACION_COMPRA", texto: "Anulación de compra" },
  { valor: "VENTA", texto: "Venta" },
  { valor: "ANULACION_VENTA", texto: "Anulación de venta" },
  { valor: "TRASPASO_SALIDA", texto: "Traspaso (salida)" },
  { valor: "TRASPASO_ENTRADA", texto: "Traspaso (entrada)" },
  { valor: "BAJA", texto: "Baja" },
  { valor: "AJUSTE", texto: "Ajuste manual" },
];
const CONCEPTOS_CAJA = [
  { valor: "SALDO_APERTURA", texto: "Saldo de apertura" },
  { valor: "VENTA", texto: "Venta en efectivo" },
  { valor: "ANULACION_VENTA", texto: "Anulación de venta" },
  { valor: "CIERRE_CAJA", texto: "Cierre de caja" },
  { valor: "INGRESO_DINERO", texto: "Ingreso de dinero" },
  { valor: "RETIRO_DINERO", texto: "Retiro de dinero" },
  { valor: "COBRO_LIQUIDACION", texto: "Cobro de liquidación" },
  { valor: "SALDO_ESTADIA", texto: "Anticipo o retiro de saldo de estadía" },
  { valor: "LIQUIDACION_ESTADIA", texto: "Liquidación de consumos de estadía" },
  { valor: "DIFERENCIA_RESERVA", texto: "Diferencia de alojamiento" },
  { valor: "OTROS", texto: "Otros" },
];
const FORMAS_LIQUIDACION = [
  { valor: "DESCUENTO_HABERES", texto: "Descuento de haberes" },
  { valor: "EFECTIVO", texto: "Efectivo" },
  { valor: "TARJETA_DEBITO", texto: "Tarjeta de débito" },
  { valor: "TARJETA_CREDITO", texto: "Tarjeta de crédito" },
  { valor: "QR", texto: "QR" },
  { valor: "TRANSFERENCIA", texto: "Transferencia" },
];
const ESTADOS_LIQUIDACION = [
  { valor: "PENDIENTE", texto: "Pendiente de pago" },
  { valor: "PAGADA", texto: "Pagada" },
  { valor: "ANULADA", texto: "Anulada" },
];
const TIPOS_PERMISO = [
  { valor: "SOLICITUD_PRODUCTO", texto: "Pedir productos" },
  { valor: "ANULAR_VENTA", texto: "Anular una venta" },
  { valor: "VER_VENTAS_CAJA", texto: "Ver todas las ventas de la caja" },
];

const SI_NO = [{ valor: "1", texto: "Sí" }, { valor: "0", texto: "No" }];

// Autor de lo que vino del sistema anterior (creado_por): permite filtrarlo para revisarlo.
const IMPORTADOR = "Sistema anterior (importación)";
// Un producto "se usó" si tiene ventas, compras, solicitudes, bajas o movimientos que no sean
// la carga inicial o un ajuste manual. Mismo criterio que api/eliminar.js.
const PRODUCTO_USADO = ["predio_venta_item", "predio_compra_item", "predio_solicitud", "predio_baja"]
  .map((t) => `EXISTS (SELECT 1 FROM ${t} u WHERE u.predio_id = p.predio_id AND u.producto_id = p.id)`)
  .concat("EXISTS (SELECT 1 FROM predio_movimiento u WHERE u.predio_id = p.predio_id AND u.producto_id = p.id AND u.tipo NOT IN ('ALTA_INICIAL', 'AJUSTE'))")
  .join(" OR ");

function textoDe(lista, valor) {
  const item = lista.find((i) => i.valor === valor);
  return item ? item.texto : valor;
}

const esAdmin = (ctx) => ctx.usuario?.rol === "ADMIN";
const bocasDe = (ctx) => (ctx.usuario?.bocas || []).map(Number).filter(Boolean);

function alcanceBocas(expr) {
  return (ctx) => {
    if (esAdmin(ctx)) return null;
    const bocas = bocasDe(ctx);
    if (!bocas.length) return { sql: "1 = 0", params: [] };
    return { sql: `${expr} IN (${bocas.map(() => "?").join(", ")})`, params: bocas };
  };
}

// ---------------------------------------------------------------- definiciones

const L = {};

const FECHA_REVISION = fechaRevisionSql();
const PRECIO_PENDIENTE = `p.activo = 1 AND COALESCE(st.positivo, 0) > 0 AND (${FECHA_REVISION} IS NULL OR ${FECHA_REVISION} < pl.fecha)`;

L.productos = {
  roles: ["ADMIN"],
  titulo: "Productos y stock general",
  from: `predio_producto p
    LEFT JOIN (SELECT producto_id, SUM(cantidad) AS total, SUM(CASE WHEN cantidad > 0 THEN cantidad ELSE 0 END) AS positivo FROM predio_stock WHERE predio_id = :pid GROUP BY producto_id) st ON st.producto_id = p.id
    LEFT JOIN predio_stock sa ON sa.predio_id = p.predio_id AND sa.producto_id = p.id AND sa.boca_id = :almacen
    ${historialRevisionSql()}
    LEFT JOIN (SELECT :revision_limite AS fecha) pl ON 1 = 1`,
  where: "p.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "p.id", tipo: "int" },
    { clave: "nombre", titulo: "Nombre", expr: "p.nombre", buscar: true },
    { clave: "codigo", titulo: "Código", expr: "p.codigo", buscar: true },
    { clave: "precio_compra", titulo: "Compra", expr: "p.precio_compra", tipo: "money" },
    { clave: "margen", titulo: "Margen", expr: "p.margen", tipo: "pct" },
    { clave: "precio_venta", titulo: "Venta", expr: "p.precio_venta", tipo: "money" },
    { clave: "revision_precio", titulo: "Revisión de precio", expr: `CASE WHEN ${PRECIO_PENDIENTE} THEN 'Revisar: más de 4 meses o sin fecha' WHEN COALESCE(st.positivo, 0) <= 0 THEN 'Sin stock' ELSE 'Al día' END` },
    { clave: "fecha_revision_precio", titulo: "Última revisión de precio", expr: FECHA_REVISION, tipo: "dt", oculta: true },
    { clave: "stock", titulo: "Stock", expr: "COALESCE(st.total, 0)", tipo: "qty" },
    { clave: "destino", titulo: "Destino", expr: "p.destino", tipo: "opcion", opciones: DESTINOS },
    { clave: "perecedero", titulo: "Perecedero", expr: "p.perecedero", tipo: "bool" },
    { clave: "fecha_caducidad", titulo: "Caducidad", expr: "p.fecha_caducidad", tipo: "date" },
    { clave: "activo", titulo: "Activo", expr: "p.activo", tipo: "bool", oculta: true },
    { clave: "fecha_modificacion", titulo: "Modificado", expr: "p.fecha_modificacion", tipo: "dt", oculta: true },
  ],
  filtros: [
    { clave: "revision_precio", titulo: "Revisión de precio", tipo: "opciones", opciones: [
      { valor: "pendiente", texto: "Con stock y precio para revisar", sql: PRECIO_PENDIENTE },
      { valor: "vigente", texto: "Con stock y precio revisado", sql: `p.activo = 1 AND COALESCE(st.positivo, 0) > 0 AND ${FECHA_REVISION} >= pl.fecha` },
    ] },
    { clave: "destino", titulo: "Destino", tipo: "opciones", expr: "p.destino", opciones: DESTINOS },
    { clave: "perecedero", titulo: "Perecedero", tipo: "opciones", expr: "p.perecedero", opciones: SI_NO },
    {
      clave: "stock", titulo: "Stock", tipo: "opciones",
      opciones: [
        { valor: "con", texto: "Con stock", sql: "COALESCE(st.total, 0) > 0" },
        { valor: "sin", texto: "Sin stock", sql: "COALESCE(st.total, 0) = 0" },
        { valor: "negativo", texto: "Negativo (revisar)", sql: "COALESCE(st.total, 0) < 0" },
        { valor: "bajo", texto: "Bajo el mínimo", sql: "p.stock_minimo > 0 AND COALESCE(st.total, 0) < p.stock_minimo" },
      ],
    },
    {
      clave: "vencimiento", titulo: "Caducidad", tipo: "opciones",
      opciones: [
        { valor: "vencidos", texto: "Vencidos", sql: "p.fecha_caducidad IS NOT NULL AND p.fecha_caducidad < :hoy" },
        { valor: "7", texto: "Vencen en 7 días", sql: "p.fecha_caducidad IS NOT NULL AND p.fecha_caducidad >= :hoy AND p.fecha_caducidad <= :hoy7" },
        { valor: "30", texto: "Vencen en 30 días", sql: "p.fecha_caducidad IS NOT NULL AND p.fecha_caducidad >= :hoy AND p.fecha_caducidad <= :hoy30" },
      ],
    },
    {
      clave: "precio", titulo: "Precio", tipo: "opciones",
      opciones: [
        { valor: "sin", texto: "Sin precio de venta", sql: "COALESCE(p.precio_venta, 0) <= 0" },
        { valor: "con", texto: "Con precio de venta", sql: "COALESCE(p.precio_venta, 0) > 0" },
      ],
    },
    {
      clave: "uso", titulo: "Uso", tipo: "opciones",
      opciones: [
        { valor: "nunca", texto: "Nunca usados", sql: `NOT (${PRODUCTO_USADO})` },
        { valor: "usados", texto: "Con ventas, compras o movimientos", sql: PRODUCTO_USADO },
      ],
    },
    {
      // Se conserva para las herramientas de importación y selección masiva, fuera de la tabla.
      clave: "origen", titulo: "Origen", tipo: "opciones", oculto: true,
      opciones: [
        { valor: "importado", texto: "Del sistema anterior", sql: `p.creado_por = '${IMPORTADOR}'` },
        { valor: "nuevo", texto: "Cargados en este sistema", sql: `COALESCE(p.creado_por, '') <> '${IMPORTADOR}'` },
      ],
    },
    { clave: "activo", titulo: "Estado", tipo: "opciones", expr: "p.activo", opciones: [{ valor: "1", texto: "Activos" }, { valor: "0", texto: "Dados de baja" }] },
  ],
  orden: { clave: "nombre", dir: "asc" },
  resumen: {
    grupos: [
      { clave: "destino", titulo: "Destino", expr: "p.destino", opciones: DESTINOS },
      { clave: "perecedero", titulo: "Perecedero", expr: "p.perecedero", tipo: "bool" },
    ],
    medidas: [
      { titulo: "Productos", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Unidades en stock", expr: "SUM(COALESCE(st.total, 0))", tipo: "qty" },
      { titulo: "Unidades en almacén", expr: "SUM(COALESCE(sa.cantidad, 0))", tipo: "qty" },
      { titulo: "Valor a costo", expr: "SUM(COALESCE(st.total, 0) * COALESCE(p.precio_compra, 0))", tipo: "money" },
    ],
  },
};

L.stock = {
  titulo: "Stock por boca",
  from: `predio_stock s
    JOIN predio_producto p ON p.predio_id = s.predio_id AND p.id = s.producto_id
    JOIN predio_boca b ON b.predio_id = s.predio_id AND b.id = s.boca_id`,
  where: "s.predio_id = :pid",
  alcance: alcanceBocas("s.boca_id"),
  columnas: [
    { clave: "boca", titulo: "Boca", expr: "b.nombre", buscar: true },
    { clave: "producto_id", titulo: "ID", expr: "p.id", tipo: "int" },
    { clave: "producto", titulo: "Producto", expr: "p.nombre", buscar: true },
    { clave: "codigo", titulo: "Código", expr: "p.codigo", buscar: true },
    { clave: "cantidad", titulo: "Cantidad", expr: "s.cantidad", tipo: "qty" },
    { clave: "precio_venta", titulo: "Precio de venta", expr: "p.precio_venta", tipo: "money" },
    { clave: "valor", titulo: "Valor a costo", expr: "s.cantidad * COALESCE(p.precio_compra, 0)", tipo: "money", soloAdmin: true },
    { clave: "destino", titulo: "Destino", expr: "p.destino", tipo: "opcion", opciones: DESTINOS },
    { clave: "fecha_caducidad", titulo: "Caducidad", expr: "p.fecha_caducidad", tipo: "date" },
    { clave: "fecha_modificacion", titulo: "Último movimiento", expr: "s.fecha_modificacion", tipo: "dt" },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "s.boca_id", fuente: "bocas" },
    { clave: "destino", titulo: "Destino", tipo: "opciones", expr: "p.destino", opciones: DESTINOS },
    {
      clave: "estado", titulo: "Cantidad", tipo: "opciones",
      opciones: [
        { valor: "con", texto: "Con stock", sql: "s.cantidad > 0" },
        { valor: "sin", texto: "En cero", sql: "s.cantidad = 0" },
        { valor: "negativo", texto: "Negativo (revisar)", sql: "s.cantidad < 0" },
      ],
    },
  ],
  orden: { clave: "producto", dir: "asc" },
  totales: [{ clave: "cantidad", expr: "SUM(s.cantidad)" }, { clave: "valor", expr: "SUM(s.cantidad * COALESCE(p.precio_compra, 0))", soloAdmin: true }],
  resumen: {
    grupos: [
      { clave: "boca", titulo: "Boca", expr: "b.nombre" },
      { clave: "producto", titulo: "Producto", expr: "p.nombre" },
      { clave: "destino", titulo: "Destino", expr: "p.destino", opciones: DESTINOS },
    ],
    medidas: [
      { titulo: "Productos", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Unidades", expr: "SUM(s.cantidad)", tipo: "qty" },
      { titulo: "Valor a costo", expr: "SUM(s.cantidad * COALESCE(p.precio_compra, 0))", tipo: "money", soloAdmin: true },
    ],
  },
};

L.proveedores = {
  roles: ["ADMIN"],
  titulo: "Proveedores",
  from: `predio_proveedor pr
    LEFT JOIN (SELECT proveedor_id, COUNT(*) AS compras, SUM(total_items) AS total, MAX(fecha_factura) AS ultima
      FROM predio_compra WHERE predio_id = :pid AND estado = 'CARGADA' GROUP BY proveedor_id) c ON c.proveedor_id = pr.id`,
  where: "pr.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "pr.id", tipo: "int", oculta: true },
    { clave: "codigo", titulo: "Código", expr: "pr.codigo", buscar: true },
    { clave: "razon_social", titulo: "Razón social", expr: "pr.razon_social", buscar: true },
    { clave: "cuit", titulo: "CUIT", expr: "pr.cuit", buscar: true },
    { clave: "telefono", titulo: "Teléfono", expr: "pr.telefono" },
    { clave: "compras", titulo: "Compras", expr: "COALESCE(c.compras, 0)", tipo: "int" },
    { clave: "total", titulo: "Total comprado", expr: "COALESCE(c.total, 0)", tipo: "money" },
    { clave: "ultima", titulo: "Última compra", expr: "c.ultima", tipo: "date" },
    { clave: "activo", titulo: "Activo", expr: "pr.activo", tipo: "bool", oculta: true },
  ],
  filtros: [
    {
      clave: "uso", titulo: "Compras", tipo: "opciones",
      opciones: [
        { valor: "sin", texto: "Sin compras", sql: "COALESCE(c.compras, 0) = 0" },
        { valor: "con", texto: "Con compras", sql: "COALESCE(c.compras, 0) > 0" },
      ],
    },
    {
      clave: "origen", titulo: "Origen", tipo: "opciones",
      opciones: [
        { valor: "importado", texto: "Del sistema anterior", sql: `pr.creado_por = '${IMPORTADOR}'` },
        { valor: "nuevo", texto: "Cargados en este sistema", sql: `COALESCE(pr.creado_por, '') <> '${IMPORTADOR}'` },
      ],
    },
    { clave: "activo", titulo: "Estado", tipo: "opciones", expr: "pr.activo", opciones: [{ valor: "1", texto: "Activos" }, { valor: "0", texto: "Dados de baja" }] },
  ],
  orden: { clave: "razon_social", dir: "asc" },
};

const columnaEstadoCompra = { clave: "estado", titulo: "Estado", expr: "c.estado", tipo: "opcion", opciones: [{ valor: "CARGADA", texto: "Cargada" }, { valor: "ANULADA", texto: "Anulada" }] };
const filtroEstadoCompra = { clave: "estado", titulo: "Estado", tipo: "opciones", expr: "c.estado", opciones: [{ valor: "CARGADA", texto: "Cargadas" }, { valor: "ANULADA", texto: "Anuladas" }] };

L.compras = {
  titulo: "Compras",
  alcance: alcanceBocas("c.boca_id"),
  from: `predio_compra c
    JOIN predio_proveedor pr ON pr.predio_id = c.predio_id AND pr.id = c.proveedor_id
    LEFT JOIN (SELECT compra_id, COUNT(*) AS items FROM predio_compra_item WHERE predio_id = :pid GROUP BY compra_id) it ON it.compra_id = c.id`,
  where: "c.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "c.id", tipo: "int" },
    { clave: "fecha_factura", titulo: "Fecha factura", expr: "c.fecha_factura", tipo: "date" },
    { clave: "proveedor", titulo: "Proveedor", expr: "pr.razon_social", buscar: true },
    { clave: "factura", titulo: "Factura", expr: "c.factura", buscar: true },
    { clave: "remito", titulo: "Remito", expr: "c.remito", buscar: true },
    { clave: "fecha_remito", titulo: "Fecha remito", expr: "c.fecha_remito", tipo: "date", oculta: true },
    { clave: "items", titulo: "Productos", expr: "COALESCE(it.items, 0)", tipo: "int" },
    { clave: "total", titulo: "Total", expr: "c.total_items", tipo: "money" },
    columnaEstadoCompra,
    { clave: "creado_por", titulo: "Cargó", expr: "c.creado_por" },
    { clave: "fecha_creacion", titulo: "Fecha de carga", expr: "c.fecha_creacion", tipo: "dt" },
  ],
  filtros: [
    { clave: "proveedor", titulo: "Proveedor", tipo: "id", expr: "c.proveedor_id", fuente: "proveedores" },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "c.fecha_factura" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "c.fecha_factura" },
    filtroEstadoCompra,
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "total", expr: "SUM(c.total_items)" }, { clave: "items", expr: "SUM(COALESCE(it.items, 0))" }],
  resumen: {
    grupos: [
      { clave: "proveedor", titulo: "Proveedor", expr: "pr.razon_social" },
      { clave: "mes", titulo: "Mes", expr: "SUBSTR(c.fecha_factura, 1, 7)" },
    ],
    medidas: [
      { titulo: "Compras", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Total", expr: "SUM(c.total_items)", tipo: "money" },
    ],
  },
};

L.compras_productos = {
  roles: ["ADMIN"],
  titulo: "Compras por producto",
  from: `predio_compra_item i
    JOIN predio_compra c ON c.predio_id = i.predio_id AND c.id = i.compra_id
    JOIN predio_proveedor pr ON pr.predio_id = c.predio_id AND pr.id = c.proveedor_id
    JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id`,
  where: "i.predio_id = :pid",
  columnas: [
    { clave: "compra_id", titulo: "Compra", expr: "c.id", tipo: "int" },
    { clave: "fecha_factura", titulo: "Fecha", expr: "c.fecha_factura", tipo: "date" },
    { clave: "proveedor", titulo: "Proveedor", expr: "pr.razon_social", buscar: true },
    { clave: "producto", titulo: "Producto", expr: "p.nombre", buscar: true },
    { clave: "cantidad", titulo: "Cantidad", expr: "i.cantidad", tipo: "qty" },
    { clave: "precio_unitario", titulo: "Unitario", expr: "i.precio_unitario", tipo: "money" },
    { clave: "precio_anterior", titulo: "Anterior", expr: "i.precio_anterior", tipo: "money" },
    { clave: "subtotal", titulo: "Total", expr: "i.subtotal", tipo: "money" },
    columnaEstadoCompra,
  ],
  filtros: [
    { clave: "proveedor", titulo: "Proveedor", tipo: "id", expr: "c.proveedor_id", fuente: "proveedores" },
    { clave: "producto", titulo: "Producto", tipo: "id", expr: "i.producto_id", fuente: "productos" },
    filtroEstadoCompra,
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "c.fecha_factura" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "c.fecha_factura" },
  ],
  orden: { clave: "fecha_factura", dir: "desc" },
  totales: [{ clave: "cantidad", expr: "SUM(i.cantidad)" }, { clave: "subtotal", expr: "SUM(i.subtotal)" }],
  resumen: {
    grupos: [
      { clave: "producto", titulo: "Producto", expr: "p.nombre" },
      { clave: "proveedor", titulo: "Proveedor", expr: "pr.razon_social" },
    ],
    medidas: [
      { titulo: "Unidades", expr: "SUM(i.cantidad)", tipo: "qty" },
      { titulo: "Total", expr: "SUM(i.subtotal)", tipo: "money" },
      { titulo: "Precio promedio", expr: "SUM(i.subtotal) / NULLIF(SUM(i.cantidad), 0)", tipo: "money" },
    ],
  },
};

L.solicitudes = {
  titulo: "Solicitudes y traspasos",
  from: `predio_solicitud s
    JOIN predio_producto p ON p.predio_id = s.predio_id AND p.id = s.producto_id
    JOIN predio_boca bo ON bo.predio_id = s.predio_id AND bo.id = s.boca_origen_id
    JOIN predio_boca bd ON bd.predio_id = s.predio_id AND bd.id = s.boca_destino_id`,
  where: "s.predio_id = :pid",
  alcance: (ctx) => {
    if (esAdmin(ctx)) return null;
    const bocas = bocasDe(ctx);
    if (!bocas.length) return { sql: "1 = 0", params: [] };
    const l = bocas.map(() => "?").join(", ");
    return { sql: `(s.boca_origen_id IN (${l}) OR s.boca_destino_id IN (${l}))`, params: [...bocas, ...bocas] };
  },
  columnas: [
    { clave: "id", titulo: "ID", expr: "s.id", tipo: "int" },
    { clave: "producto", titulo: "Producto", expr: "p.nombre", buscar: true },
    { clave: "cantidad", titulo: "Cantidad", expr: "s.cantidad", tipo: "qty" },
    { clave: "origen", titulo: "Boca origen", expr: "bo.nombre", buscar: true },
    { clave: "destino", titulo: "Boca destino", expr: "bd.nombre", buscar: true },
    { clave: "fecha_solicitud", titulo: "Solicitada", expr: "s.fecha_solicitud", tipo: "dt" },
    { clave: "usuario_solicitud", titulo: "Pidió", expr: "s.usuario_solicitud", buscar: true },
    { clave: "fecha_despacho", titulo: "Despachada", expr: "s.fecha_despacho", tipo: "dt" },
    { clave: "usuario_despacho", titulo: "Despachó", expr: "s.usuario_despacho", oculta: true },
    { clave: "usuario_recepcion", titulo: "Recibió", expr: "s.usuario_recepcion" },
    { clave: "recibida", titulo: "Recibida", expr: "CASE WHEN s.estado = 'RECIBIDA' THEN 1 ELSE 0 END", tipo: "bool" },
    { clave: "estado", titulo: "Estado", expr: "s.estado", tipo: "opcion", opciones: ESTADOS_SOLICITUD },
    { clave: "baja_automatica", titulo: "Baja automática", expr: "s.baja_automatica", tipo: "bool", oculta: true },
    { clave: "boca_origen_id", titulo: "Origen ID", expr: "s.boca_origen_id", tipo: "int", oculta: true, interna: true },
    { clave: "boca_destino_id", titulo: "Destino ID", expr: "s.boca_destino_id", tipo: "int", oculta: true, interna: true },
    { clave: "fecha_recepcion", titulo: "Fecha de recepción", expr: "s.fecha_recepcion", tipo: "dt", oculta: true },
  ],
  filtros: [
    {
      clave: "recibida", titulo: "Recibida", tipo: "opciones",
      opciones: [
        { valor: "1", texto: "Recibidas", sql: "s.estado = 'RECIBIDA'" },
        { valor: "0", texto: "No recibidas", sql: "s.estado IN ('PENDIENTE', 'DESPACHADA')" },
      ],
    },
    { clave: "estado", titulo: "Estado", tipo: "opciones", expr: "s.estado", opciones: ESTADOS_SOLICITUD },
    { clave: "origen", titulo: "Origen", tipo: "id", expr: "s.boca_origen_id", fuente: "bocas_origen" },
    { clave: "destino", titulo: "Destino", tipo: "id", expr: "s.boca_destino_id", fuente: "bocas_destino" },
    { clave: "producto", titulo: "Producto", tipo: "id", expr: "s.producto_id", fuente: "productos" },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "s.fecha_solicitud" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "s.fecha_solicitud" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "cantidad", expr: "SUM(s.cantidad)" }],
  resumen: {
    grupos: [
      { clave: "producto", titulo: "Producto", expr: "p.nombre" },
      { clave: "origen_destino", titulo: "Origen → destino", expr: "bo.nombre", extra: { expr: "bd.nombre", titulo: "Destino" }, tituloExpr: "Origen" },
      { clave: "destino", titulo: "Boca destino", expr: "bd.nombre" },
      { clave: "estado", titulo: "Estado", expr: "s.estado", opciones: ESTADOS_SOLICITUD },
    ],
    medidas: [
      { titulo: "Solicitudes", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Unidades", expr: "SUM(s.cantidad)", tipo: "qty" },
      { titulo: "Unidades recibidas", expr: "SUM(CASE WHEN s.estado = 'RECIBIDA' THEN s.cantidad ELSE 0 END)", tipo: "qty" },
    ],
  },
};

L.bajas = {
  roles: ["ADMIN"],
  titulo: "Bajas de stock",
  from: `predio_baja x
    JOIN predio_producto p ON p.predio_id = x.predio_id AND p.id = x.producto_id
    JOIN predio_boca b ON b.predio_id = x.predio_id AND b.id = x.boca_id`,
  where: "x.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "x.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "x.fecha", tipo: "dt" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre", buscar: true },
    { clave: "producto", titulo: "Producto", expr: "p.nombre", buscar: true },
    { clave: "cantidad", titulo: "Cantidad", expr: "x.cantidad", tipo: "qty" },
    { clave: "motivo", titulo: "Motivo", expr: "x.motivo", tipo: "opcion", opciones: MOTIVOS_BAJA },
    { clave: "valor", titulo: "Valor a costo", expr: "x.cantidad * COALESCE(p.precio_compra, 0)", tipo: "money" },
    { clave: "observaciones", titulo: "Observaciones", expr: "x.observaciones", buscar: true },
    { clave: "usuario_nombre", titulo: "Usuario", expr: "x.usuario_nombre" },
  ],
  filtros: [
    { clave: "motivo", titulo: "Motivo", tipo: "opciones", expr: "x.motivo", opciones: MOTIVOS_BAJA },
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "x.boca_id", fuente: "bocas" },
    { clave: "producto", titulo: "Producto", tipo: "id", expr: "x.producto_id", fuente: "productos" },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "x.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "x.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "cantidad", expr: "SUM(x.cantidad)" }, { clave: "valor", expr: "SUM(x.cantidad * COALESCE(p.precio_compra, 0))" }],
  resumen: {
    grupos: [
      { clave: "motivo", titulo: "Motivo", expr: "x.motivo", opciones: MOTIVOS_BAJA },
      { clave: "producto", titulo: "Producto", expr: "p.nombre" },
      { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    ],
    medidas: [
      { titulo: "Bajas", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Unidades", expr: "SUM(x.cantidad)", tipo: "qty" },
      { titulo: "Valor a costo", expr: "SUM(x.cantidad * COALESCE(p.precio_compra, 0))", tipo: "money" },
    ],
  },
};

L.movimientos = {
  titulo: "Movimientos de stock",
  from: `predio_movimiento m
    JOIN predio_producto p ON p.predio_id = m.predio_id AND p.id = m.producto_id
    JOIN predio_boca b ON b.predio_id = m.predio_id AND b.id = m.boca_id`,
  where: "m.predio_id = :pid",
  alcance: alcanceBocas("m.boca_id"),
  columnas: [
    { clave: "id", titulo: "ID", expr: "m.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "m.fecha", tipo: "dt" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre", buscar: true },
    { clave: "tipo", titulo: "Tipo", expr: "m.tipo", tipo: "opcion", opciones: TIPOS_MOVIMIENTO },
    { clave: "producto", titulo: "Producto", expr: "p.nombre", buscar: true },
    { clave: "cantidad", titulo: "Cantidad", expr: "m.cantidad", tipo: "qty", signo: true },
    { clave: "saldo", titulo: "Saldo", expr: "m.saldo", tipo: "qty" },
    { clave: "detalle", titulo: "Detalle", expr: "m.detalle", buscar: true },
    { clave: "usuario_nombre", titulo: "Usuario", expr: "m.usuario_nombre" },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "m.boca_id", fuente: "bocas" },
    { clave: "tipo", titulo: "Tipo", tipo: "opciones", expr: "m.tipo", opciones: TIPOS_MOVIMIENTO },
    { clave: "producto", titulo: "Producto", tipo: "id", expr: "m.producto_id", fuente: "productos" },
    {
      clave: "sentido", titulo: "Sentido", tipo: "opciones",
      opciones: [{ valor: "entradas", texto: "Entradas", sql: "m.cantidad > 0" }, { valor: "salidas", texto: "Salidas", sql: "m.cantidad < 0" }],
    },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "m.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "m.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  resumen: {
    grupos: [
      { clave: "producto", titulo: "Producto", expr: "p.nombre" },
      { clave: "tipo", titulo: "Tipo", expr: "m.tipo", opciones: TIPOS_MOVIMIENTO },
      { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    ],
    medidas: [
      { titulo: "Movimientos", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Entradas", expr: "SUM(CASE WHEN m.cantidad > 0 THEN m.cantidad ELSE 0 END)", tipo: "qty" },
      { titulo: "Salidas", expr: "SUM(CASE WHEN m.cantidad < 0 THEN -m.cantidad ELSE 0 END)", tipo: "qty" },
      { titulo: "Neto", expr: "SUM(m.cantidad)", tipo: "qty" },
    ],
  },
};

L.ventas = {
  titulo: "Ventas",
  from: `predio_venta v
    JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
    JOIN predio_caja c ON c.predio_id = v.predio_id AND c.id = v.caja_id
    LEFT JOIN (SELECT venta_id, COUNT(*) AS items, SUM(cantidad) AS unidades FROM predio_venta_item WHERE predio_id = :pid GROUP BY venta_id) it ON it.venta_id = v.id`,
  where: "v.predio_id = :pid",
  alcance: (ctx, query) => {
    const admin = esAdmin(ctx);
    // Sólo el listado general del administrador abarca otras cajas.
    if (admin && !query?.ambito) return null;
    const sesion = ctx.sesion || {};
    if (query?.ambito === "caja" && (admin || ctx.verVentasCaja)) {
      return { sql: "v.caja_id = ?", params: [sesion.caja_id || -1] };
    }
    return { sql: "v.turno_id = ?", params: [sesion.turno_id || -1] };
  },
  columnas: [
    { clave: "id", titulo: "ID", expr: "v.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "v.fecha", tipo: "dt" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    { clave: "caja", titulo: "Caja", expr: "c.nombre" },
    { clave: "usuario_nombre", titulo: "Cajero", expr: "v.usuario_nombre", buscar: true },
    { clave: "afiliado", titulo: "Afiliado", expr: "v.afiliado_nombre", buscar: true },
    { clave: "afiliado_legajo", titulo: "Legajo", expr: "v.afiliado_legajo", buscar: true, oculta: true },
    { clave: "afiliado_dni", titulo: "DNI", expr: "v.afiliado_dni", buscar: true, oculta: true },
    { clave: "items", titulo: "Ítems", expr: "COALESCE(it.unidades, 0)", tipo: "qty" },
    { clave: "forma_pago", titulo: "Forma de pago", expr: "v.forma_pago", tipo: "opcion", opciones: FORMAS_PAGO },
    { clave: "codigo_pago", titulo: "Código de pago", expr: "v.codigo_pago", buscar: true, oculta: true },
    { clave: "total", titulo: "Importe", expr: "v.total", tipo: "money" },
    { clave: "estado", titulo: "Estado", expr: "v.estado", tipo: "opcion", opciones: [{ valor: "CONFIRMADA", texto: "Confirmada" }, { valor: "ANULADA", texto: "Anulada" }] },
    { clave: "caja_id", titulo: "Caja ID", expr: "v.caja_id", tipo: "int", oculta: true, interna: true },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "v.boca_id", fuente: "bocas_venta" },
    { clave: "caja", titulo: "Caja", tipo: "id", expr: "v.caja_id", fuente: "cajas" },
    { clave: "forma_pago", titulo: "Forma de pago", tipo: "opciones", expr: "v.forma_pago", opciones: FORMAS_PAGO },
    { clave: "estado", titulo: "Estado", tipo: "opciones", expr: "v.estado", opciones: [{ valor: "CONFIRMADA", texto: "Confirmadas" }, { valor: "ANULADA", texto: "Anuladas" }] },
    {
      clave: "afiliado", titulo: "Comprador", tipo: "opciones",
      opciones: [{ valor: "si", texto: "Afiliados", sql: "v.afiliado_id IS NOT NULL" }, { valor: "no", texto: "No afiliados", sql: "v.afiliado_id IS NULL" }],
    },
    { clave: "usuario", titulo: "Cajero", tipo: "id", expr: "v.usuario_id", fuente: "usuarios" },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "v.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "v.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "total", expr: "SUM(v.total)" }, { clave: "items", expr: "SUM(COALESCE(it.unidades, 0))" }],
  resumen: {
    grupos: [
      { clave: "dia", titulo: "Día", expr: "SUBSTR(v.fecha, 1, 10)" },
      { clave: "forma_pago", titulo: "Forma de pago", expr: "v.forma_pago", opciones: FORMAS_PAGO },
      { clave: "boca", titulo: "Boca", expr: "b.nombre" },
      { clave: "caja", titulo: "Caja", expr: "c.nombre" },
      { clave: "cajero", titulo: "Cajero", expr: "v.usuario_nombre" },
    ],
    medidas: [
      { titulo: "Ventas", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Importe", expr: "SUM(v.total)", tipo: "money" },
      { titulo: "Ticket promedio", expr: "AVG(v.total)", tipo: "money" },
    ],
  },
};

L.ventas_productos = {
  roles: ["ADMIN"],
  titulo: "Ventas por producto",
  from: `predio_venta_item i
    JOIN predio_venta v ON v.predio_id = i.predio_id AND v.id = i.venta_id
    JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id
    LEFT JOIN predio_producto p ON p.predio_id = i.predio_id AND p.id = i.producto_id`,
  where: "i.predio_id = :pid AND v.estado = 'CONFIRMADA'",
  columnas: [
    { clave: "venta_id", titulo: "Venta", expr: "v.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "v.fecha", tipo: "dt" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    { clave: "producto", titulo: "Producto", expr: "i.descripcion", buscar: true },
    { clave: "codigo", titulo: "Código", expr: "i.codigo", buscar: true, oculta: true },
    { clave: "cantidad", titulo: "Cantidad", expr: "i.cantidad", tipo: "qty" },
    { clave: "precio_unitario", titulo: "Unitario", expr: "i.precio_unitario", tipo: "money" },
    { clave: "subtotal", titulo: "Subtotal", expr: "i.subtotal", tipo: "money" },
    { clave: "forma_pago", titulo: "Forma de pago", expr: "v.forma_pago", tipo: "opcion", opciones: FORMAS_PAGO },
    { clave: "ganancia", titulo: "Ganancia estimada", expr: "i.subtotal - i.cantidad * COALESCE(p.precio_compra, 0)", tipo: "money", oculta: true },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "v.boca_id", fuente: "bocas_venta" },
    { clave: "producto", titulo: "Producto", tipo: "id", expr: "i.producto_id", fuente: "productos" },
    { clave: "forma_pago", titulo: "Forma de pago", tipo: "opciones", expr: "v.forma_pago", opciones: FORMAS_PAGO },
    { clave: "destino", titulo: "Destino", tipo: "opciones", expr: "i.destino", opciones: DESTINOS },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "v.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "v.fecha" },
  ],
  orden: { clave: "fecha", dir: "desc" },
  totales: [{ clave: "cantidad", expr: "SUM(i.cantidad)" }, { clave: "subtotal", expr: "SUM(i.subtotal)" }],
  resumen: {
    grupos: [
      { clave: "producto", titulo: "Producto", expr: "i.descripcion" },
      { clave: "boca", titulo: "Boca", expr: "b.nombre" },
      { clave: "dia", titulo: "Día", expr: "SUBSTR(v.fecha, 1, 10)" },
    ],
    medidas: [
      { titulo: "Unidades", expr: "SUM(i.cantidad)", tipo: "qty" },
      { titulo: "Importe", expr: "SUM(i.subtotal)", tipo: "money" },
      { titulo: "Ganancia estimada", expr: "SUM(i.subtotal - i.cantidad * COALESCE(p.precio_compra, 0))", tipo: "money" },
    ],
  },
};

L.caja = {
  titulo: "Movimientos de caja",
  from: `(SELECT m.*, SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.importe ELSE -m.importe END)
          OVER (PARTITION BY m.caja_id ORDER BY m.id) AS saldo
        FROM predio_caja_movimiento m WHERE m.predio_id = :pid) m
    JOIN predio_caja c ON c.predio_id = m.predio_id AND c.id = m.caja_id
    JOIN predio_boca b ON b.predio_id = m.predio_id AND b.id = m.boca_id
    LEFT JOIN predio_cierre ci ON ci.predio_id = m.predio_id AND ci.id = m.cierre_id`,
  where: "1 = 1",
  alcance: (ctx) => (esAdmin(ctx) ? null : { sql: "m.caja_id = ?", params: [ctx.sesion?.caja_id || -1] }),
  columnas: [
    { clave: "fecha", titulo: "Fecha", expr: "m.fecha", tipo: "dt" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    { clave: "caja", titulo: "Caja", expr: "c.nombre" },
    { clave: "concepto", titulo: "Concepto", expr: "m.concepto", tipo: "opcion", opciones: CONCEPTOS_CAJA },
    { clave: "ingreso", titulo: "Ingreso", expr: "CASE WHEN m.tipo = 'INGRESO' THEN m.importe ELSE 0 END", tipo: "money" },
    { clave: "egreso", titulo: "Egreso", expr: "CASE WHEN m.tipo = 'EGRESO' THEN m.importe ELSE 0 END", tipo: "money" },
    { clave: "saldo", titulo: "Saldo", expr: "m.saldo", tipo: "money" },
    { clave: "cierre_id", titulo: "ID cierre", expr: "m.cierre_id", tipo: "int" },
    { clave: "id", titulo: "ID registro", expr: "m.id", tipo: "int" },
    { clave: "fecha_cierre", titulo: "Fecha cierre", expr: "ci.fecha", tipo: "dt" },
    { clave: "usuario_nombre", titulo: "Usuario", expr: "m.usuario_nombre", buscar: true },
    { clave: "recibo", titulo: "Recibo", expr: "m.recibo", buscar: true, oculta: true },
    { clave: "observaciones", titulo: "Observaciones", expr: "m.observaciones", buscar: true, oculta: true },
    { clave: "venta_id", titulo: "Venta", expr: "m.venta_id", tipo: "int", oculta: true },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "m.boca_id", fuente: "bocas_venta" },
    { clave: "caja", titulo: "Caja", tipo: "id", expr: "m.caja_id", fuente: "cajas" },
    {
      clave: "vista", titulo: "Ver", tipo: "opciones",
      opciones: [
        { valor: "movimientos", texto: "Movimientos (sin cierres)", sql: "m.concepto <> 'CIERRE_CAJA'" },
        { valor: "cierres", texto: "Sólo cierres de caja", sql: "m.concepto = 'CIERRE_CAJA'" },
        { valor: "ajustes", texto: "Sólo ajustes manuales", sql: "m.concepto IN ('INGRESO_DINERO', 'RETIRO_DINERO', 'OTROS', 'SALDO_APERTURA')" },
        { valor: "abiertos", texto: "Sin cerrar", sql: "m.cierre_id IS NULL" },
      ],
    },
    { clave: "concepto", titulo: "Concepto", tipo: "opciones", expr: "m.concepto", opciones: CONCEPTOS_CAJA },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "m.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "m.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [
    { clave: "ingreso", expr: "SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.importe ELSE 0 END)" },
    { clave: "egreso", expr: "SUM(CASE WHEN m.tipo = 'EGRESO' THEN m.importe ELSE 0 END)" },
  ],
  resumen: {
    grupos: [
      { clave: "concepto", titulo: "Concepto", expr: "m.concepto", opciones: CONCEPTOS_CAJA },
      { clave: "caja", titulo: "Caja", expr: "c.nombre" },
      { clave: "dia", titulo: "Día", expr: "SUBSTR(m.fecha, 1, 10)" },
    ],
    medidas: [
      { titulo: "Movimientos", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Ingresos", expr: "SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.importe ELSE 0 END)", tipo: "money" },
      { titulo: "Egresos", expr: "SUM(CASE WHEN m.tipo = 'EGRESO' THEN m.importe ELSE 0 END)", tipo: "money" },
    ],
  },
};

L.cierres = {
  titulo: "Cierres de caja",
  from: `predio_cierre ci
    JOIN predio_caja c ON c.predio_id = ci.predio_id AND c.id = ci.caja_id
    JOIN predio_boca b ON b.predio_id = ci.predio_id AND b.id = ci.boca_id`,
  where: "ci.predio_id = :pid",
  alcance: alcanceBocas("ci.boca_id"),
  columnas: [
    { clave: "id", titulo: "ID", expr: "ci.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "ci.fecha", tipo: "dt" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    { clave: "caja", titulo: "Caja", expr: "c.nombre" },
    { clave: "usuario_nombre", titulo: "Cerró", expr: "ci.usuario_nombre", buscar: true },
    { clave: "ventas_cantidad", titulo: "Ventas", expr: "ci.ventas_cantidad", tipo: "int" },
    { clave: "ventas_total", titulo: "Vendido", expr: "ci.ventas_total", tipo: "money" },
    { clave: "saldo_esperado", titulo: "Efectivo esperado", expr: "ci.saldo_esperado", tipo: "money" },
    { clave: "efectivo_contado", titulo: "Contado", expr: "ci.efectivo_contado", tipo: "money" },
    { clave: "diferencia", titulo: "Diferencia", expr: "ci.diferencia", tipo: "money", signo: true },
    { clave: "retiro", titulo: "Retiro", expr: "ci.retiro", tipo: "money" },
    { clave: "saldo", titulo: "Saldo", expr: "ci.queda_en_caja", tipo: "money" },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "ci.boca_id", fuente: "bocas_venta" },
    { clave: "caja", titulo: "Caja", tipo: "id", expr: "ci.caja_id", fuente: "cajas" },
    {
      clave: "diferencia", titulo: "Diferencias", tipo: "opciones",
      opciones: [{ valor: "con", texto: "Con diferencia", sql: "ci.diferencia <> 0" }, { valor: "sin", texto: "Sin diferencia", sql: "ci.diferencia = 0" }],
    },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "ci.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "ci.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "ventas_total", expr: "SUM(ci.ventas_total)" }, { clave: "diferencia", expr: "SUM(ci.diferencia)" }, { clave: "retiro", expr: "SUM(ci.retiro)" }],
};

const SQL_CONSUMO = `LEFT JOIN (SELECT afiliado_id,
      SUM(COALESCE(importe_haberes,total)) AS consumido,
      SUM(CASE WHEN liquidacion_id IS NULL THEN COALESCE(importe_haberes,total) ELSE 0 END) AS pendiente
    FROM predio_venta WHERE predio_id = :pid AND (forma_pago='DESCUENTO' OR importe_haberes>0) AND estado = 'CONFIRMADA' GROUP BY afiliado_id) v ON v.afiliado_id = a.id
  LEFT JOIN (SELECT afiliado_id, MIN(fecha_inicio) AS desde, MAX(fecha_fin) AS hasta,
      MAX(CASE WHEN fecha_inicio <= :hoy AND fecha_fin >= :hoy THEN 1 ELSE 0 END) AS en_predio
    FROM predio_estadia WHERE predio_id = :pid AND activo = 1 AND fecha_fin >= :hace60 GROUP BY afiliado_id) e ON e.afiliado_id = a.id
  LEFT JOIN predio_departamental d ON d.predio_id = a.predio_id AND d.id = a.departamental_id`;

const FILTROS_AFILIADO = [
  {
    clave: "en_predio", titulo: "Ubicación", tipo: "opciones",
    opciones: [
      { valor: "1", texto: "En el predio hoy", sql: "COALESCE(e.en_predio, 0) = 1" },
      { valor: "proximos", texto: "Llegan en los próximos 7 días", sql: "e.desde > :hoy AND e.desde <= :hoy7" },
      { valor: "con_estadia", texto: "Con estadía reciente o próxima", sql: "e.desde IS NOT NULL" },
    ],
  },
  { clave: "departamental", titulo: "Departamental", tipo: "id", expr: "a.departamental_id", fuente: "departamentales" },
  { clave: "origen", titulo: "Origen", tipo: "opciones", expr: "a.origen", opciones: [{ valor: "SISTEMA", texto: "Sistema general" }, { valor: "MANUAL", texto: "Carga manual" }] },
  { clave: "limite", titulo: "Límite", tipo: "monto", expr: "COALESCE(a.limite, 0)" },
  {
    clave: "deuda", titulo: "Consumos por descuento", tipo: "opciones",
    opciones: [
      { valor: "pendiente", texto: "Con consumos sin liquidar", sql: "COALESCE(v.pendiente, 0) > 0" },
      { valor: "agotado", texto: "Sin disponible", sql: "COALESCE(a.limite, 0) - COALESCE(v.pendiente, 0) <= 0" },
    ],
  },
  {
    clave: "estadia_desde", titulo: "Estadía desde", tipo: "personalizado",
    aplicar: (valor) => esFechaIso(valor)
      ? { sql: "EXISTS (SELECT 1 FROM predio_estadia es WHERE es.predio_id = a.predio_id AND es.afiliado_id = a.id AND es.activo = 1 AND es.fecha_fin >= ?)", params: [valor] }
      : null,
  },
  {
    clave: "estadia_hasta", titulo: "Estadía hasta", tipo: "personalizado",
    aplicar: (valor) => esFechaIso(valor)
      ? { sql: "EXISTS (SELECT 1 FROM predio_estadia es WHERE es.predio_id = a.predio_id AND es.afiliado_id = a.id AND es.activo = 1 AND es.fecha_inicio <= ?)", params: [valor] }
      : null,
  },
];

L.afiliados = {
  titulo: "Afiliados",
  roles: ["ADMIN"],
  from: `predio_afiliado a ${SQL_CONSUMO}`,
  where: "a.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "a.id", tipo: "int", oculta: true },
    { clave: "nombre", titulo: "Afiliado", expr: "a.nombre", buscar: true },
    { clave: "dni", titulo: "DNI", expr: "a.dni", buscar: true },
    { clave: "legajo", titulo: "Legajo", expr: "a.legajo", buscar: true },
    { clave: "departamental", titulo: "Departamental", expr: "d.nombre", buscar: true },
    { clave: "desde", titulo: "Estadía desde", expr: "e.desde", tipo: "date" },
    { clave: "hasta", titulo: "Hasta", expr: "e.hasta", tipo: "date" },
    { clave: "en_predio", titulo: "En el predio", expr: "COALESCE(e.en_predio, 0)", tipo: "bool" },
    { clave: "limite", titulo: "Límite", expr: "COALESCE(a.limite, 0)", tipo: "money" },
    { clave: "pendiente", titulo: "Consumido sin liquidar", expr: "COALESCE(v.pendiente, 0)", tipo: "money" },
    { clave: "disponible", titulo: "Disponible", expr: "COALESCE(a.limite, 0) - COALESCE(v.pendiente, 0)", tipo: "money" },
    { clave: "origen", titulo: "Origen", expr: "a.origen", tipo: "opcion", opciones: [{ valor: "SISTEMA", texto: "Sistema" }, { valor: "MANUAL", texto: "Manual" }] },
  ],
  filtros: FILTROS_AFILIADO,
  orden: { clave: "nombre", dir: "asc" },
  totales: [{ clave: "limite", expr: "SUM(COALESCE(a.limite, 0))" }, { clave: "pendiente", expr: "SUM(COALESCE(v.pendiente, 0))" }],
  resumen: {
    grupos: [
      { clave: "departamental", titulo: "Departamental", expr: "d.nombre" },
      { clave: "en_predio", titulo: "En el predio", expr: "COALESCE(e.en_predio, 0)", tipo: "bool" },
      { clave: "origen", titulo: "Origen", expr: "a.origen" },
    ],
    medidas: [
      { titulo: "Afiliados", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Límite asignado", expr: "SUM(COALESCE(a.limite, 0))", tipo: "money" },
      { titulo: "Consumido sin liquidar", expr: "SUM(COALESCE(v.pendiente, 0))", tipo: "money" },
    ],
  },
};

L.afiliado_consumos = {
  titulo: "Consumos del afiliado",
  roles: ["ADMIN"],
  from: `predio_venta v JOIN predio_boca b ON b.predio_id = v.predio_id AND b.id = v.boca_id`,
  where: "v.predio_id = :pid",
  requiere: "afiliado",
  columnas: [
    { clave: "id", titulo: "ID", expr: "v.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "v.fecha", tipo: "dt" },
    { clave: "forma_pago", titulo: "Forma de pago", expr: "v.forma_pago", tipo: "opcion", opciones: FORMAS_PAGO },
    { clave: "total", titulo: "Importe", expr: "v.total", tipo: "money" },
    { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    { clave: "estado", titulo: "Estado", expr: "v.estado", tipo: "opcion", opciones: [{ valor: "CONFIRMADA", texto: "Confirmada" }, { valor: "ANULADA", texto: "Anulada" }] },
    { clave: "liquidacion_id", titulo: "Liquidación", expr: "v.liquidacion_id", tipo: "int" },
  ],
  filtros: [
    { clave: "afiliado", titulo: "Afiliado", tipo: "id", expr: "v.afiliado_id", oculto: true },
    { clave: "forma_pago", titulo: "Forma de pago", tipo: "opciones", expr: "v.forma_pago", opciones: FORMAS_PAGO },
    { clave: "estado", titulo: "Estado", tipo: "opciones", expr: "v.estado", opciones: [{ valor: "CONFIRMADA", texto: "Confirmadas" }, { valor: "ANULADA", texto: "Anuladas" }] },
    {
      clave: "liquidada", titulo: "Liquidación", tipo: "opciones",
      opciones: [{ valor: "no", texto: "Sin liquidar", sql: "v.liquidacion_id IS NULL" }, { valor: "si", texto: "Liquidadas", sql: "v.liquidacion_id IS NOT NULL" }],
    },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "v.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "v.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "total", expr: "SUM(v.total)" }],
};

L.liquidaciones = {
  titulo: "Liquidaciones de consumos",
  roles: ["ADMIN"],
  from: `predio_liquidacion l
    JOIN predio_afiliado a ON a.predio_id = l.predio_id AND a.id = l.afiliado_id
    LEFT JOIN predio_departamental d ON d.predio_id = a.predio_id AND d.id = a.departamental_id`,
  where: "l.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "N°", expr: "l.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "l.fecha", tipo: "dt" },
    { clave: "afiliado", titulo: "Afiliado", expr: "a.nombre", buscar: true },
    { clave: "dni", titulo: "DNI", expr: "a.dni", buscar: true },
    { clave: "legajo", titulo: "Legajo", expr: "a.legajo", buscar: true },
    { clave: "departamental", titulo: "Departamental", expr: "d.nombre" },
    { clave: "total_consumos", titulo: "Consumido", expr: "l.total_consumos", tipo: "money" },
    { clave: "porcentaje_descuento", titulo: "Desc. %", expr: "l.porcentaje_descuento", tipo: "pct" },
    { clave: "total", titulo: "A pagar", expr: "l.total", tipo: "money" },
    { clave: "forma_pago", titulo: "Forma", expr: "l.forma_pago", tipo: "opcion", opciones: FORMAS_LIQUIDACION },
    { clave: "cuotas", titulo: "Cuotas", expr: "l.cuotas", tipo: "int" },
    { clave: "valor_cuota", titulo: "Valor cuota", expr: "l.valor_cuota", tipo: "money" },
    { clave: "estado", titulo: "Estado", expr: "l.estado", tipo: "opcion", opciones: ESTADOS_LIQUIDACION },
    { clave: "fecha_pago", titulo: "Pagada", expr: "l.fecha_pago", tipo: "dt", oculta: true },
    { clave: "recibo", titulo: "Recibo", expr: "l.recibo", oculta: true },
  ],
  filtros: [
    { clave: "estado", titulo: "Estado", tipo: "opciones", expr: "l.estado", opciones: ESTADOS_LIQUIDACION },
    { clave: "forma_pago", titulo: "Forma", tipo: "opciones", expr: "l.forma_pago", opciones: FORMAS_LIQUIDACION },
    { clave: "cuotas", titulo: "Cuotas", tipo: "monto", expr: "l.cuotas" },
    { clave: "total", titulo: "Monto a pagar", tipo: "monto", expr: "l.total" },
    { clave: "departamental", titulo: "Departamental", tipo: "id", expr: "a.departamental_id", fuente: "departamentales" },
    { clave: "afiliado", titulo: "Afiliado", tipo: "id", expr: "l.afiliado_id", oculto: true },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "l.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "l.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
  totales: [{ clave: "total", expr: "SUM(l.total)" }, { clave: "total_consumos", expr: "SUM(l.total_consumos)" }],
  resumen: {
    grupos: [
      { clave: "departamental", titulo: "Departamental", expr: "d.nombre" },
      { clave: "forma_pago", titulo: "Forma", expr: "l.forma_pago", opciones: FORMAS_LIQUIDACION },
      { clave: "cuotas", titulo: "Cuotas", expr: "l.cuotas" },
      { clave: "estado", titulo: "Estado", expr: "l.estado", opciones: ESTADOS_LIQUIDACION },
    ],
    medidas: [
      { titulo: "Liquidaciones", expr: "COUNT(*)", tipo: "int" },
      { titulo: "Total a pagar", expr: "SUM(l.total)", tipo: "money" },
      { titulo: "Valor de cuotas (suma)", expr: "SUM(l.valor_cuota)", tipo: "money" },
    ],
  },
};

L.usuarios = {
  titulo: "Usuarios",
  roles: ["ADMIN"],
  from: "predio_usuario u",
  where: "u.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "u.id", tipo: "int", oculta: true },
    { clave: "usuario", titulo: "Usuario", expr: "u.usuario", buscar: true },
    { clave: "nombre", titulo: "Nombre", expr: "u.nombre", buscar: true },
    { clave: "rol", titulo: "Rol", expr: "u.rol", tipo: "opcion", opciones: [{ valor: "ADMIN", texto: "Administrador" }, { valor: "CAJERO", texto: "Usuario de boca" }] },
    { clave: "es_admin_general", titulo: "Sistema general", expr: "u.es_admin_general", tipo: "bool" },
    { clave: "ultimo_ingreso", titulo: "Último ingreso", expr: "u.ultimo_ingreso", tipo: "dt" },
    { clave: "activo", titulo: "Activo", expr: "u.activo", tipo: "bool" },
  ],
  filtros: [
    { clave: "rol", titulo: "Rol", tipo: "opciones", expr: "u.rol", opciones: [{ valor: "ADMIN", texto: "Administradores" }, { valor: "CAJERO", texto: "Usuarios de boca" }] },
    { clave: "activo", titulo: "Estado", tipo: "opciones", expr: "u.activo", opciones: [{ valor: "1", texto: "Activos" }, { valor: "0", texto: "Deshabilitados" }] },
  ],
  orden: { clave: "nombre", dir: "asc" },
};

L.bocas = {
  titulo: "Bocas de expendio",
  roles: ["ADMIN"],
  from: `predio_boca b
    LEFT JOIN (SELECT boca_id, COUNT(*) AS cajas FROM predio_caja WHERE predio_id = :pid AND activo = 1 GROUP BY boca_id) c ON c.boca_id = b.id`,
  where: "b.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "b.id", tipo: "int" },
    { clave: "nombre", titulo: "Boca", expr: "b.nombre", buscar: true },
    { clave: "es_origen", titulo: "Origen", expr: "b.es_origen", tipo: "bool" },
    { clave: "es_destino", titulo: "Destino", expr: "b.es_destino", tipo: "bool" },
    { clave: "cajas", titulo: "Cajas", expr: "COALESCE(c.cajas, 0)", tipo: "int" },
    { clave: "activo", titulo: "Activa", expr: "b.activo", tipo: "bool" },
  ],
  filtros: [
    {
      clave: "sentido", titulo: "Sentido", tipo: "opciones",
      opciones: [
        { valor: "origen", texto: "Sólo origen", sql: "b.es_origen = 1 AND b.es_destino = 0" },
        { valor: "destino", texto: "Sólo destino", sql: "b.es_origen = 0 AND b.es_destino = 1" },
        { valor: "ambos", texto: "Origen y destino", sql: "b.es_origen = 1 AND b.es_destino = 1" },
      ],
    },
    { clave: "activo", titulo: "Estado", tipo: "opciones", expr: "b.activo", opciones: [{ valor: "1", texto: "Activas" }, { valor: "0", texto: "Inactivas" }] },
  ],
  orden: { clave: "nombre", dir: "asc" },
};

L.cajas = {
  titulo: "Cajas",
  roles: ["ADMIN"],
  from: `predio_caja c
    JOIN predio_boca b ON b.predio_id = c.predio_id AND b.id = c.boca_id
    LEFT JOIN (SELECT caja_id, COUNT(*) AS ventas, SUM(total) AS total FROM predio_venta WHERE predio_id = :pid AND estado = 'CONFIRMADA' GROUP BY caja_id) v ON v.caja_id = c.id`,
  where: "c.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "c.id", tipo: "int" },
    { clave: "nombre", titulo: "Caja", expr: "c.nombre", buscar: true },
    { clave: "boca", titulo: "Boca", expr: "b.nombre", buscar: true },
    { clave: "ancho_ticket", titulo: "Ticket (mm)", expr: "c.ancho_ticket", tipo: "int" },
    { clave: "ventas", titulo: "Ventas", expr: "COALESCE(v.ventas, 0)", tipo: "int" },
    { clave: "total", titulo: "Total vendido", expr: "COALESCE(v.total, 0)", tipo: "money" },
    { clave: "activo", titulo: "Activa", expr: "c.activo", tipo: "bool" },
  ],
  filtros: [
    { clave: "boca", titulo: "Boca", tipo: "id", expr: "c.boca_id", fuente: "bocas" },
    { clave: "activo", titulo: "Estado", tipo: "opciones", expr: "c.activo", opciones: [{ valor: "1", texto: "Activas" }, { valor: "0", texto: "Inactivas" }] },
  ],
  orden: { clave: "boca", dir: "asc" },
};

L.auditoria = {
  titulo: "Auditoría",
  roles: ["ADMIN"],
  from: "predio_auditoria x",
  where: "x.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "x.id", tipo: "int" },
    { clave: "fecha", titulo: "Fecha", expr: "x.fecha", tipo: "dt" },
    { clave: "usuario_nombre", titulo: "Usuario", expr: "x.usuario_nombre", buscar: true },
    { clave: "accion", titulo: "Acción", expr: "x.accion", buscar: true },
    { clave: "entidad", titulo: "Sobre", expr: "x.entidad" },
    { clave: "entidad_id", titulo: "ID", expr: "x.entidad_id", tipo: "int" },
    { clave: "origen", titulo: "Desde", expr: "x.origen", tipo: "opcion", opciones: [{ valor: "LOCAL", texto: "Camping" }, { valor: "REMOTO", texto: "Remoto" }, { valor: "SISTEMA", texto: "Sistema" }] },
    { clave: "detalle", titulo: "Detalle", expr: "x.detalle", tipo: "json", buscar: true },
  ],
  filtros: [
    { clave: "entidad", titulo: "Sobre", tipo: "opciones", expr: "x.entidad", opciones: [
      { valor: "producto", texto: "Productos" }, { valor: "proveedor", texto: "Proveedores" }, { valor: "compra", texto: "Compras" },
      { valor: "venta", texto: "Ventas" }, { valor: "caja", texto: "Caja" }, { valor: "solicitud", texto: "Solicitudes" },
      { valor: "afiliado", texto: "Afiliados" }, { valor: "usuario", texto: "Usuarios" }, { valor: "boca", texto: "Bocas" },
      { valor: "permiso", texto: "Permisos" }, { valor: "sesion", texto: "Sesiones" }, { valor: "sistema", texto: "Sistema" },
    ] },
    { clave: "origen", titulo: "Desde", tipo: "opciones", expr: "x.origen", opciones: [{ valor: "LOCAL", texto: "Camping" }, { valor: "REMOTO", texto: "Remoto" }] },
    { clave: "entidad_id", titulo: "ID", tipo: "id", expr: "x.entidad_id", oculto: true },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "x.fecha" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "x.fecha" },
  ],
  orden: { clave: "id", dir: "desc" },
};

L.permisos = {
  titulo: "Autorizaciones",
  roles: ["ADMIN"],
  from: `predio_permiso x
    LEFT JOIN predio_boca b ON b.predio_id = x.predio_id AND b.id = x.boca_id
    LEFT JOIN predio_caja c ON c.predio_id = x.predio_id AND c.id = x.caja_id`,
  where: "x.predio_id = :pid",
  columnas: [
    { clave: "id", titulo: "ID", expr: "x.id", tipo: "int" },
    { clave: "fecha_solicitud", titulo: "Pedido", expr: "x.fecha_solicitud", tipo: "dt" },
    { clave: "tipo", titulo: "Para", expr: "x.tipo", tipo: "opcion", opciones: TIPOS_PERMISO },
    { clave: "usuario_nombre", titulo: "Usuario", expr: "x.usuario_nombre", buscar: true },
    { clave: "boca", titulo: "Boca", expr: "b.nombre" },
    { clave: "caja", titulo: "Caja", expr: "c.nombre" },
    { clave: "detalle", titulo: "Detalle", expr: "x.detalle", buscar: true },
    { clave: "estado", titulo: "Estado", expr: "x.estado", tipo: "opcion", opciones: [
      { valor: "PENDIENTE", texto: "Pendiente" }, { valor: "APROBADO", texto: "Aprobado" }, { valor: "RECHAZADO", texto: "Rechazado" },
      { valor: "USADO", texto: "Usado" }, { valor: "VENCIDO", texto: "Vencido" },
    ] },
    { clave: "metodo", titulo: "Cómo", expr: "x.metodo", tipo: "opcion", opciones: [{ valor: "REMOTO", texto: "Desde la cuenta del admin" }, { valor: "CLAVE", texto: "Clave del día" }] },
    { clave: "resuelto_por", titulo: "Resolvió", expr: "x.resuelto_por" },
  ],
  filtros: [
    { clave: "estado", titulo: "Estado", tipo: "opciones", expr: "x.estado", opciones: [
      { valor: "PENDIENTE", texto: "Pendientes" }, { valor: "APROBADO", texto: "Aprobados" }, { valor: "RECHAZADO", texto: "Rechazados" }, { valor: "USADO", texto: "Usados" },
    ] },
    { clave: "tipo", titulo: "Para", tipo: "opciones", expr: "x.tipo", opciones: TIPOS_PERMISO },
    { clave: "desde", titulo: "Desde", tipo: "desde", expr: "x.fecha_solicitud" },
    { clave: "hasta", titulo: "Hasta", tipo: "hasta", expr: "x.fecha_solicitud" },
  ],
  orden: { clave: "id", dir: "desc" },
};

L.limites = {
  titulo: "Historial de límites",
  roles: ["ADMIN"],
  from: `predio_limite_historial h JOIN predio_afiliado a ON a.predio_id = h.predio_id AND a.id = h.afiliado_id`,
  where: "h.predio_id = :pid",
  columnas: [
    { clave: "fecha", titulo: "Fecha", expr: "h.fecha", tipo: "dt" },
    { clave: "afiliado", titulo: "Afiliado", expr: "a.nombre", buscar: true },
    { clave: "limite_anterior", titulo: "Antes", expr: "h.limite_anterior", tipo: "money" },
    { clave: "limite_nuevo", titulo: "Ahora", expr: "h.limite_nuevo", tipo: "money" },
    { clave: "motivo", titulo: "Cómo", expr: "h.motivo", tipo: "opcion", opciones: [{ valor: "INDIVIDUAL", texto: "Individual" }, { valor: "MASIVO", texto: "Masivo" }, { valor: "ALTA", texto: "Alta" }] },
    { clave: "usuario_nombre", titulo: "Usuario", expr: "h.usuario_nombre" },
  ],
  filtros: [
    { clave: "afiliado", titulo: "Afiliado", tipo: "id", expr: "h.afiliado_id", oculto: true },
    { clave: "motivo", titulo: "Cómo", tipo: "opciones", expr: "h.motivo", opciones: [{ valor: "INDIVIDUAL", texto: "Individual" }, { valor: "MASIVO", texto: "Masivo" }] },
  ],
  orden: { clave: "fecha", dir: "desc" },
};

// ------------------------------------------------------------------ motor

function parametrosBase(ctx) {
  const h = hoy();
  return {
    pid: ctx.pid,
    hoy: h,
    hoy7: sumarDias(h, 7),
    hoy30: sumarDias(h, 30),
    hace60: sumarDias(h, -60),
    almacen: ctx.almacenId || -1,
    revision_limite: limiteRevision(ctx.ahora || new Date()),
  };
}

function traducir(sql, valores, nombres) {
  return sql.replace(/:([a-z][a-z0-9_]*)\b/g, (_m, n) => {
    if (!(n in nombres)) throw new Error(`Parámetro desconocido :${n}`);
    valores.push(nombres[n]);
    return "?";
  });
}

function construirWhere(def, ctx, query, db) {
  const nombres = parametrosBase(ctx);
  const partes = [];
  const valores = [];
  partes.push(traducir(def.where, valores, nombres));

  const alcance = def.alcance ? def.alcance(ctx, query) : null;
  if (alcance) {
    partes.push(alcance.sql);
    valores.push(...alcance.params);
  }

  if (def.requiere) {
    const v = query[`f_${def.requiere}`];
    if (!v) throw error("Falta indicar a quién corresponde el listado");
  }

  for (const f of def.filtros || []) {
    let valor = query[`f_${f.clave}`];
    if (valor === undefined || valor === null || valor === "" || valor === "todos") continue;
    valor = String(valor);
    if (f.tipo === "opciones") {
      const op = f.opciones.find((o) => o.valor === valor);
      if (!op) continue;
      if (op.sql) partes.push(traducir(op.sql, valores, nombres));
      else { partes.push(`${f.expr} = ?`); valores.push(op.valor); }
    } else if (f.tipo === "id") {
      const n = Number(valor);
      if (!Number.isSafeInteger(n)) continue;
      partes.push(`${f.expr} = ?`);
      valores.push(n);
    } else if (f.tipo === "desde") {
      if (!esFechaIso(valor)) continue;
      partes.push(`${f.expr} >= ?`);
      valores.push(valor);
    } else if (f.tipo === "hasta") {
      if (!esFechaIso(valor)) continue;
      partes.push(`${f.expr} < ?`);
      valores.push(sumarDias(valor, 1));
    } else if (f.tipo === "monto") {
      const m = /^(eq|gte|lte|gt|lt):(-?\d+(?:[.,]\d+)?)$/.exec(valor);
      if (!m) continue;
      const op = { eq: "=", gte: ">=", lte: "<=", gt: ">", lt: "<" }[m[1]];
      partes.push(`${f.expr} ${op} ?`);
      valores.push(Number(m[2].replace(",", ".")));
    } else if (f.tipo === "personalizado") {
      const r = f.aplicar(valor, ctx);
      if (r) { partes.push(r.sql); valores.push(...r.params); }
    }
  }

  const q = String(query.q || "").trim().slice(0, 80);
  if (q) {
    const buscables = def.columnas.filter((c) => c.buscar);
    if (buscables.length) {
      const palabras = q.split(/\s+/).slice(0, 5);
      for (const palabra of palabras) {
        partes.push(`(${buscables.map((c) => `${db.buscar(`COALESCE(${c.expr}, '')`)} LIKE ?`).join(" OR ")})`);
        for (let i = 0; i < buscables.length; i++) valores.push(`%${db.normParam(palabra)}%`);
      }
    }
  }
  return { sql: partes.map((p) => `(${p})`).join(" AND "), valores, nombres };
}

function convertirValor(col, v) {
  if (v === null || v === undefined) return null;
  if (["money", "qty", "pct"].includes(col.tipo)) return redondear(Number(v), col.tipo === "qty" ? 3 : 2);
  if (col.tipo === "int" || col.tipo === "bool") return Number(v);
  return v;
}

async function ejecutar(ctx, nombre, query = {}) {
  const def = L[nombre];
  if (!def) throw error("El listado no existe", 404);
  if (def.roles && !def.roles.includes(ctx.usuario?.rol)) throw error("No tenés permiso para ver este listado", 403);
  const db = ctx.db;
  const { sql: where, valores, nombres } = construirWhere(def, ctx, query, db);
  const valoresFrom = [];
  const fromSql = traducir(def.from, valoresFrom, nombres);

  const admin = esAdmin(ctx);
  const columnas = def.columnas.filter((c) => admin || !c.soloAdmin);
  const totalesDef = (def.totales || []).filter((t) => admin || !t.soloAdmin);
  const ordenCol = columnas.find((c) => c.clave === query.orden) || columnas.find((c) => c.clave === def.orden?.clave) || columnas[0];
  const dir = (query.dir || (query.orden ? "asc" : def.orden?.dir) || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const desempate = columnas.find((c) => c.clave === "id") || columnas[0];
  const ordenSql = `${ordenCol.expr} ${dir}${desempate !== ordenCol ? `, ${desempate.expr} ${dir}` : ""}`;
  const select = columnas.map((c) => `${c.expr} AS ${c.clave}`).join(", ");

  if (query.formato === "csv") {
    if (query.modo === "resumen") return csvResumen(ctx, def, query, { fromSql, valoresFrom, where, valores, admin });
    const filas = await db.all(
      `SELECT ${select} FROM ${fromSql} WHERE ${where} ORDER BY ${ordenSql} LIMIT 100000`,
      [...valoresFrom, ...valores]
    );
    const visibles = columnas.filter((c) => !c.interna);
    return {
      csv: aCsv(visibles.map((c) => c.titulo), filas.map((f) => visibles.map((c) => celdaCsv(c, f[c.clave])))),
      nombreArchivo: `${nombre}-${hoy()}.csv`,
    };
  }

  const tam = Math.min(200, Math.max(5, Number(query.tam) || 10));
  const pagina = Math.max(1, Number(query.pagina) || 1);
  const conteo = await db.get(`SELECT COUNT(*) AS n FROM ${fromSql} WHERE ${where}`, [...valoresFrom, ...valores]);
  const total = Number(conteo?.n || 0);
  const filas = await db.all(
    `SELECT ${select} FROM ${fromSql} WHERE ${where} ORDER BY ${ordenSql} LIMIT ? OFFSET ?`,
    [...valoresFrom, ...valores, tam, (pagina - 1) * tam]
  );
  let totales = null;
  if (totalesDef.length && total > 0) {
    const fila = await db.get(
      `SELECT ${totalesDef.map((t) => `${t.expr} AS ${t.clave}`).join(", ")} FROM ${fromSql} WHERE ${where}`,
      [...valoresFrom, ...valores]
    );
    totales = {};
    for (const t of totalesDef) totales[t.clave] = redondear(Number(fila?.[t.clave] || 0), 3);
  }
  return {
    filas: filas.map((f) => {
      const salida = {};
      for (const c of columnas) salida[c.clave] = convertirValor(c, f[c.clave]);
      return salida;
    }),
    total,
    pagina,
    tam,
    paginas: Math.max(1, Math.ceil(total / tam)),
    totales,
  };
}

async function csvResumen(ctx, def, query, { fromSql, valoresFrom, where, valores, admin }) {
  if (!def.resumen) throw error("Este listado no tiene resumen");
  const grupo = def.resumen.grupos.find((g) => g.clave === query.grupo) || def.resumen.grupos[0];
  const exprs = [grupo.expr];
  if (grupo.extra) exprs.push(grupo.extra.expr);
  const medidas = def.resumen.medidas.filter((m) => admin || !m.soloAdmin);
  const select = [
    ...exprs.map((e, i) => `${e} AS g${i}`),
    ...medidas.map((m, i) => `${m.expr} AS m${i}`),
  ].join(", ");
  const filas = await ctx.db.all(
    `SELECT ${select} FROM ${fromSql} WHERE ${where} GROUP BY ${exprs.join(", ")} ORDER BY ${exprs.join(", ")} LIMIT 20000`,
    [...valoresFrom, ...valores]
  );
  const titulos = [grupo.tituloExpr || grupo.titulo];
  if (grupo.extra) titulos.push(grupo.extra.titulo);
  titulos.push(...medidas.map((m) => m.titulo));
  const totales = medidas.map(() => 0);
  const cuerpo = filas.map((f) => {
    const celdas = exprs.map((_e, i) => {
      let v = f[`g${i}`];
      if (i === 0 && grupo.opciones) v = textoDe(grupo.opciones, v);
      if (i === 0 && grupo.tipo === "bool") v = Number(v) ? "Sí" : "No";
      return v === null || v === undefined || v === "" ? "(sin dato)" : v;
    });
    medidas.forEach((m, i) => {
      const n = Number(f[`m${i}`] || 0);
      if (m.titulo !== "Precio promedio" && m.titulo !== "Ticket promedio") totales[i] += n;
      celdas.push(numeroCsv(n, m.tipo));
    });
    return celdas;
  });
  const filaTotal = ["TOTAL"];
  if (grupo.extra) filaTotal.push("");
  medidas.forEach((m, i) => filaTotal.push(m.titulo === "Precio promedio" || m.titulo === "Ticket promedio" ? "" : numeroCsv(totales[i], m.tipo)));
  cuerpo.push(filaTotal);
  return {
    csv: aCsv(titulos, cuerpo),
    nombreArchivo: `${def.titulo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-resumen-${hoy()}.csv`,
  };
}

function numeroCsv(n, tipo) {
  const d = tipo === "int" ? 0 : tipo === "qty" ? 3 : 2;
  let s = redondear(Number(n) || 0, d).toFixed(d);
  if (tipo === "qty") s = s.replace(/\.?0+$/, "");
  return s.replace(".", ",");
}

function celdaCsv(col, v) {
  if (v === null || v === undefined) return "";
  if (["money", "qty", "pct", "int"].includes(col.tipo)) return numeroCsv(v, col.tipo);
  if (col.tipo === "bool") return Number(v) ? "Sí" : "No";
  if (col.tipo === "opcion") return textoDe(col.opciones, v);
  if (col.tipo === "date" && /^\d{4}-\d{2}-\d{2}/.test(String(v))) {
    const [y, m, d] = String(v).slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }
  if (col.tipo === "dt" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(v))) {
    const [f, h] = String(v).split(" ");
    const [y, m, d] = f.split("-");
    return `${d}/${m}/${y} ${h.slice(0, 5)}`;
  }
  return v;
}

function escaparCsv(v) {
  const s = v === null || v === undefined ? "" : String(v);
  // Evita la inyección de fórmulas al abrir el archivo en Excel.
  const seguro = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

function aCsv(titulos, filas) {
  const lineas = [titulos.map(escaparCsv).join(";"), ...filas.map((f) => f.map(escaparCsv).join(";"))];
  return `﻿${lineas.join("\r\n")}\r\n`;
}

function meta(ctx, nombre) {
  const def = L[nombre];
  if (!def) throw error("El listado no existe", 404);
  if (def.roles && !def.roles.includes(ctx.usuario?.rol)) throw error("No tenés permiso para ver este listado", 403);
  const admin = esAdmin(ctx);
  return {
    nombre,
    titulo: def.titulo,
    columnas: def.columnas.filter((c) => !c.interna && (admin || !c.soloAdmin)).map((c) => ({
      clave: c.clave, titulo: c.titulo, tipo: c.tipo || "texto", oculta: !!c.oculta, signo: !!c.signo,
      opciones: c.opciones ? c.opciones.map((o) => ({ valor: o.valor, texto: o.texto })) : undefined,
    })),
    filtros: (def.filtros || []).filter((f) => !f.oculto).map((f) => ({
      clave: f.clave, titulo: f.titulo, tipo: f.tipo, fuente: f.fuente,
      opciones: f.opciones ? f.opciones.map((o) => ({ valor: o.valor, texto: o.texto })) : undefined,
    })),
    orden: def.orden,
    buscador: def.columnas.some((c) => c.buscar),
    totales: (def.totales || []).filter((t) => admin || !t.soloAdmin).map((t) => t.clave),
    resumen: def.resumen ? def.resumen.grupos.map((g) => ({ clave: g.clave, titulo: g.titulo })) : [],
  };
}

module.exports = {
  LISTADOS: L,
  ejecutar,
  meta,
  aCsv,
  textoDe,
  DESTINOS,
  FORMAS_PAGO,
  MOTIVOS_BAJA,
  ESTADOS_SOLICITUD,
  TIPOS_MOVIMIENTO,
  CONCEPTOS_CAJA,
  FORMAS_LIQUIDACION,
  ESTADOS_LIQUIDACION,
  TIPOS_PERMISO,
  FILTROS_AFILIADO,
  SQL_CONSUMO,
  construirWhere,
  parametrosBase,
  traducir,
  IMPORTADOR,
};
