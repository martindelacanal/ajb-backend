"use strict";

// Esquema único de las tablas del predio. De acá salen las tablas SQLite de la
// notebook del camping y las tablas réplica de MySQL en el sistema general: mismos
// nombres y mismas columnas. Toda fila lleva `predio_id` + `id` (clave compuesta),
// así la réplica central guarda varios predios (Miramar, Parador…) en las mismas tablas.
//
// Tipos: int, str:N, text, money, qty, pct, bool, dt, date. Sufijo "!" = NOT NULL.

const AUDITORIA = {
  fecha_creacion: "dt",
  fecha_modificacion: "dt",
  creado_por: "str:120",
  modificado_por: "str:120",
};

const TABLAS = {
  predio_config: {
    columnas: { clave: "str:60!", valor: "text" },
    unicos: [["clave"]],
  },
  predio_boca: {
    auditoria: true,
    columnas: {
      nombre: "str:80!",
      es_origen: "bool",
      es_destino: "bool",
      es_almacen: "bool",
      margen_venta: "pct",
      descripcion: "str:255",
      activo: "bool",
      orden: "int",
    },
    unicos: [["nombre"]],
  },
  predio_caja: {
    auditoria: true,
    columnas: {
      boca_id: "int!",
      nombre: "str:80!",
      ancho_ticket: "int",
      impresion_automatica: "bool",
      imprimir_comanda: "bool",
      activo: "bool",
    },
    indices: [["boca_id"]],
  },
  predio_usuario: {
    auditoria: true,
    columnas: {
      usuario: "str:60!",
      nombre: "str:120!",
      rol: "str:20!",
      gestionar_reservas: "bool",
      puede_cerrar_caja: "bool!",
      puede_anular_ticket: "bool!",
      debe_cambiar_clave: "bool!",
      password_hash: "str:200",
      activo: "bool",
      es_admin_general: "bool",
      general_usuario_id: "int",
      documento: "str:20",
      ultimo_ingreso: "dt",
    },
    unicos: [["usuario"]],
  },
  predio_usuario_boca: {
    columnas: { usuario_id: "int!", boca_id: "int!" },
    unicos: [["usuario_id", "boca_id"]],
  },
  predio_aviso: {
    columnas: {
      tipo: "str:40!", usuario_id: "int", general_usuario_id: "int", general_documento: "str:20",
      titulo: "str:180!", mensaje: "text!", fecha: "dt!", detalle: "text", resuelto_fecha: "dt",
    },
    indices: [["usuario_id", "fecha"], ["tipo", "fecha"]],
  },
  predio_aviso_lectura: {
    columnas: { aviso_id: "int!", usuario_id: "int!", fecha: "dt!" },
    unicos: [["aviso_id", "usuario_id"]],
  },
  predio_proveedor: {
    auditoria: true,
    columnas: {
      codigo: "str:30",
      razon_social: "str:160!",
      cuit: "str:13",
      telefono: "str:40",
      email: "str:120",
      direccion: "str:200",
      contacto: "str:120",
      observaciones: "text",
      activo: "bool",
    },
    indices: [["razon_social"], ["codigo"]],
  },
  predio_producto: {
    auditoria: true,
    columnas: {
      nombre: "str:160!",
      codigo: "str:60",
      precio_compra: "money",
      margen: "pct",
      precio_venta: "money",
      fecha_revision_precio: "dt",
      destino: "str:20!",
      perecedero: "bool",
      fecha_caducidad: "date",
      dias_aviso_vencimiento: "int",
      stock_minimo: "qty",
      unidad: "str:20",
      activo: "bool",
    },
    indices: [["nombre"], ["codigo"]],
  },
  predio_producto_margen_boca: {
    columnas: { producto_id: "int!", boca_id: "int!", margen: "pct!" },
    unicos: [["producto_id", "boca_id"]],
  },
  predio_precio_historial: {
    columnas: {
      producto_id: "int!",
      boca_id: "int",
      fecha: "dt!",
      precio_compra: "money",
      margen: "pct",
      precio_venta: "money",
      origen: "str:20",
      referencia_id: "int",
      usuario_nombre: "str:120",
    },
    indices: [["producto_id"]],
  },
  predio_precio_control: {
    columnas: { producto_id: "int!", revision_clave: "str:40!", aviso_id: "int", resuelto_fecha: "dt" },
    unicos: [["producto_id"]],
  },
  predio_stock: {
    columnas: {
      boca_id: "int!",
      producto_id: "int!",
      cantidad: "qty!",
      fecha_modificacion: "dt",
    },
    unicos: [["boca_id", "producto_id"]],
    indices: [["producto_id"]],
  },
  predio_movimiento: {
    columnas: {
      fecha: "dt!",
      tipo: "str:30!",
      boca_id: "int!",
      producto_id: "int!",
      cantidad: "qty!",
      saldo: "qty",
      referencia_tipo: "str:20",
      referencia_id: "int",
      motivo: "str:40",
      detalle: "str:255",
      usuario_id: "int",
      usuario_nombre: "str:120",
    },
    indices: [["producto_id"], ["boca_id", "fecha"], ["fecha"]],
  },
  predio_compra: {
    auditoria: true,
    columnas: {
      proveedor_id: "int!",
      boca_id: "int!",
      factura: "str:40",
      fecha_factura: "date",
      remito: "str:40",
      fecha_remito: "date",
      total_factura: "money",
      total_items: "money",
      observaciones: "text",
      estado: "str:15!",
      usuario_id: "int",
      anulada_fecha: "dt",
      anulada_por: "str:120",
      anulacion_motivo: "str:255",
    },
    indices: [["proveedor_id"], ["fecha_factura"]],
  },
  predio_compra_item: {
    columnas: {
      compra_id: "int!",
      producto_id: "int!",
      cantidad: "qty!",
      precio_unitario: "money!",
      precio_anterior: "money",
      venta_anterior: "money",
      historial_anterior_id: "int",
      margen: "pct",
      precio_venta: "money",
      actualizo_precio: "bool",
      subtotal: "money!",
    },
    indices: [["compra_id"], ["producto_id"]],
  },
  predio_solicitud: {
    auditoria: true,
    columnas: {
      lote: "int",
      producto_id: "int!",
      cantidad: "qty!",
      boca_origen_id: "int!",
      boca_destino_id: "int!",
      estado: "str:15!",
      baja_automatica: "bool",
      observaciones: "str:255",
      fecha_solicitud: "dt!",
      usuario_solicitud_id: "int",
      usuario_solicitud: "str:120",
      fecha_despacho: "dt",
      usuario_despacho_id: "int",
      usuario_despacho: "str:120",
      fecha_recepcion: "dt",
      usuario_recepcion_id: "int",
      usuario_recepcion: "str:120",
      fecha_anulacion: "dt",
      usuario_anulacion: "str:120",
      motivo_anulacion: "str:255",
      autorizacion: "str:20",
    },
    indices: [["estado"], ["boca_origen_id"], ["boca_destino_id"], ["producto_id"]],
  },
  predio_baja: {
    auditoria: true,
    columnas: {
      fecha: "dt!",
      boca_id: "int!",
      producto_id: "int!",
      cantidad: "qty!",
      motivo: "str:20!",
      observaciones: "str:255",
      usuario_id: "int",
      usuario_nombre: "str:120",
      solicitud_id: "int",
    },
    indices: [["producto_id"], ["boca_id"]],
  },
  predio_departamental: {
    columnas: { nombre: "str:80!", activo: "bool" },
  },
  predio_afiliado: {
    auditoria: true,
    columnas: {
      usuario_general_id: "int",
      dni: "str:12",
      legajo: "str:30",
      nombre: "str:160!",
      departamental_id: "int",
      limite: "money",
      habilitado_descuento: "bool",
      origen: "str:10!",
      observaciones: "str:255",
    },
    indices: [["dni"], ["legajo"], ["usuario_general_id"]],
  },
  predio_estadia: {
    columnas: {
      afiliado_id: "int!",
      reserva_id: "int",
      servicio: "str:80",
      unidad: "str:80",
      fecha_inicio: "date!",
      fecha_fin: "date!",
      estado: "str:40",
      personas: "int",
      activo: "bool",
      fecha_modificacion: "dt",
    },
    indices: [["afiliado_id"], ["reserva_id"], ["fecha_inicio", "fecha_fin"]],
  },
  predio_limite_historial: {
    columnas: {
      afiliado_id: "int!",
      fecha: "dt!",
      limite_anterior: "money",
      limite_nuevo: "money",
      motivo: "str:20",
      lote: "str:40",
      usuario_nombre: "str:120",
    },
    indices: [["afiliado_id"]],
  },
  predio_turno: {
    columnas: {
      caja_id: "int!",
      boca_id: "int!",
      usuario_id: "int!",
      usuario_nombre: "str:120",
      inicio: "dt!",
      fin: "dt",
      estado: "str:12!",
    },
    indices: [["caja_id"], ["usuario_id"]],
  },
  predio_apertura: {
    auditoria: true,
    columnas: {
      caja_id: "int!",
      fecha: "date!",
      importe: "money!",
      verificacion: "str:15!",
      verificado_por: "str:120",
      verificado_fecha: "dt",
      observacion: "str:255",
      movimiento_id: "int",
    },
    unicos: [["caja_id", "fecha"]],
  },
  predio_caja_movimiento: {
    columnas: {
      caja_id: "int!",
      boca_id: "int!",
      fecha: "dt!",
      concepto: "str:40!",
      tipo: "str:10!",
      importe: "money!",
      recibo: "str:40",
      observaciones: "str:255",
      venta_id: "int",
      cierre_id: "int",
      turno_id: "int",
      usuario_id: "int",
      usuario_nombre: "str:120",
    },
    indices: [["caja_id", "id"], ["fecha"], ["cierre_id"], ["venta_id"]],
  },
  predio_cierre: {
    columnas: {
      caja_id: "int!",
      boca_id: "int!",
      fecha: "dt!",
      usuario_id: "int",
      usuario_nombre: "str:120",
      saldo_inicial: "money",
      ingresos: "money",
      egresos: "money",
      ventas_cantidad: "int",
      ventas_total: "money",
      ventas_efectivo: "money",
      ventas_detalle: "text",
      saldo_esperado: "money",
      efectivo_contado: "money",
      diferencia: "money",
      retiro: "money",
      queda_en_caja: "money",
      observaciones: "str:255",
    },
    indices: [["caja_id"], ["fecha"]],
  },
  predio_venta: {
    columnas: {
      boca_id: "int!",
      caja_id: "int!",
      turno_id: "int",
      usuario_id: "int",
      usuario_nombre: "str:120",
      fecha: "dt!",
      afiliado_id: "int",
      afiliado_dni: "str:12",
      afiliado_legajo: "str:30",
      afiliado_nombre: "str:160",
      afiliado_departamental: "str:80",
      saldo_disponible: "money",
      importe_haberes: "money",
      autorizacion_descuento: "text",
      forma_pago: "str:20!",
      codigo_pago: "str:60",
      total: "money!",
      recibido: "money",
      vuelto: "money",
      estado: "str:12!",
      anulada_fecha: "dt",
      anulada_por: "str:120",
      anulacion_motivo: "str:255",
      anulacion_autorizacion: "str:20",
      liquidacion_id: "int",
      impresiones: "int",
      observaciones: "str:255",
    },
    indices: [["fecha"], ["caja_id", "fecha"], ["afiliado_id"], ["turno_id"], ["liquidacion_id"]],
  },
  predio_recepcion_recibo: { columnas: { clave: "str:64!", huella: "str:64!", respuesta: "text!" }, unicos: [["clave"]] },
  predio_huesped: {
    columnas: { reserva_id: "int!", dni: "str:12!", ultima_revision: "int", legajo: "str:30", nombre: "str:160!", entrada: "date", salida: "date", saldo: "money!", afiliado: "bool", titular: "bool" },
    unicos: [["reserva_id", "dni"]], indices: [["dni"], ["legajo"]],
  },
  predio_estadia_mov: {
    columnas: { reserva_id: "int!", huesped_id: "int", venta_id: "int", liquidacion_id: "int", fecha: "dt!", concepto: "str:40!", medio: "str:20", importe: "money!", detalle: "str:255", usuario_id: "int", usuario_nombre: "str:120",
      // comprobante: número del cobro de artículos (id del primer PAGO_ADICIONAL del cobro); ver recepcion-articulos.js.
      adicional_id: "int", anula_mov_id: "int", comprobante: "int" },
    indices: [["reserva_id", "id"], ["venta_id"]],
  },
  // Devolución de un artículo alquilado (un renglón por reserva y adicional; deshacer la marca la anula).
  predio_adicional_devolucion: {
    columnas: { reserva_id: "int!", adicional_id: "int!", fecha: "date!", detalle: "str:255", anulada: "bool", usuario_id: "int", usuario_nombre: "str:120", registrada: "dt" },
    unicos: [["reserva_id", "adicional_id"]],
  },
  predio_venta_pago: {
    columnas: { venta_id: "int!", forma: "str:20!", importe: "money!", huesped_id: "int" }, indices: [["venta_id"]],
  },
  predio_venta_item: {
    columnas: {
      venta_id: "int!",
      producto_id: "int!",
      descripcion: "str:160",
      codigo: "str:60",
      cantidad: "qty!",
      precio_unitario: "money!",
      subtotal: "money!",
      destino: "str:20",
    },
    indices: [["venta_id"], ["producto_id"]],
  },
  predio_liquidacion: {
    auditoria: true,
    columnas: {
      afiliado_id: "int!",
      fecha: "dt!",
      desde: "date",
      hasta: "date",
      ventas_cantidad: "int",
      total_consumos: "money!",
      porcentaje_descuento: "pct",
      total: "money!",
      forma_pago: "str:20!",
      cuotas: "int!",
      valor_cuota: "money!",
      estado: "str:12!",
      fecha_pago: "dt",
      recibo: "str:40",
      caja_id: "int",
      observaciones: "str:255",
      usuario_nombre: "str:120",
    },
    indices: [["afiliado_id"], ["estado"]],
  },
  predio_permiso: {
    columnas: {
      tipo: "str:30!",
      estado: "str:12!",
      usuario_id: "int",
      usuario_nombre: "str:120",
      boca_id: "int",
      caja_id: "int",
      referencia_id: "int",
      detalle: "str:255",
      fecha_solicitud: "dt!",
      resuelto_por: "str:120",
      resuelto_fecha: "dt",
      metodo: "str:12",
      vence: "dt",
      usado_fecha: "dt",
    },
    indices: [["estado"], ["usuario_id"], ["tipo", "referencia_id", "estado"]],
  },
  predio_auditoria: {
    columnas: {
      fecha: "dt!",
      usuario_id: "int",
      usuario_nombre: "str:120",
      accion: "str:60!",
      entidad: "str:40",
      entidad_id: "int",
      detalle: "text",
      origen: "str:10",
      ip: "str:45",
    },
    indices: [["fecha"], ["entidad", "entidad_id"]],
  },
};

const NOMBRES_TABLAS = Object.keys(TABLAS);

// Un archivo completo anterior a los márgenes no tenía tabla de excepciones.
// Al restaurarlo, no deben quedar reglas vinculadas a IDs del catálogo reemplazado.
function tablasDeInstantanea(tablas = {}) {
  if (!Object.hasOwn(tablas, "predio_producto_margen_boca") && Array.isArray(tablas.predio_producto)
      && Array.isArray(tablas.predio_compra) && Array.isArray(tablas.predio_boca)
      && tablas.predio_boca.every(b => !Object.hasOwn(b, "margen_venta"))) {
    return { ...tablas, predio_producto_margen_boca: [] };
  }
  return tablas;
}

function columnasDe(tabla) {
  const def = TABLAS[tabla];
  if (!def) throw new Error(`Tabla desconocida: ${tabla}`);
  const cols = { predio_id: "int!", id: "int!", ...def.columnas };
  if (def.auditoria) Object.assign(cols, AUDITORIA);
  return cols;
}

function parsearTipo(tipo) {
  const requerido = tipo.endsWith("!");
  const base = requerido ? tipo.slice(0, -1) : tipo;
  const [nombre, largo] = base.split(":");
  return { nombre, largo: largo ? Number(largo) : null, requerido };
}

function tipoSql(tipo, dialecto) {
  const t = parsearTipo(tipo);
  let sql;
  if (dialecto === "mysql") {
    sql = {
      int: "INT",
      str: `VARCHAR(${t.largo || 255})`,
      text: "MEDIUMTEXT",
      money: "DECIMAL(14,2)",
      qty: "DECIMAL(14,3)",
      pct: "DECIMAL(7,2)",
      bool: "TINYINT(1)",
      dt: "DATETIME",
      date: "DATE",
    }[t.nombre];
  } else {
    sql = {
      int: "INTEGER",
      str: "TEXT",
      text: "TEXT",
      money: "NUMERIC",
      qty: "NUMERIC",
      pct: "NUMERIC",
      bool: "INTEGER",
      dt: "TEXT",
      date: "TEXT",
    }[t.nombre];
  }
  if (!sql) throw new Error(`Tipo desconocido: ${tipo}`);
  let def = sql;
  if (t.requerido) {
    def += " NOT NULL";
    if (["money", "qty", "pct", "bool", "int"].includes(t.nombre)) def += " DEFAULT 0";
  } else if (t.nombre === "bool") {
    def += " DEFAULT 0";
  }
  return def;
}

function q(nombre, dialecto) {
  return dialecto === "mysql" ? `\`${nombre}\`` : `"${nombre}"`;
}

function ddlTabla(tabla, dialecto) {
  const def = TABLAS[tabla];
  const cols = columnasDe(tabla);
  const lineas = Object.entries(cols).map(([c, t]) => `  ${q(c, dialecto)} ${tipoSql(t, dialecto)}`);
  lineas.push(`  PRIMARY KEY (${q("predio_id", dialecto)}, ${q("id", dialecto)})`);
  if (dialecto === "mysql") {
    for (const u of def.unicos || []) {
      lineas.push(`  UNIQUE KEY ${q(`uq_${tabla}_${u.join("_")}`, dialecto)} (${["predio_id", ...u].map((c) => q(c, dialecto)).join(", ")})`);
    }
    for (const i of def.indices || []) {
      lineas.push(`  KEY ${q(`ix_${tabla}_${i.join("_")}`, dialecto)} (${["predio_id", ...i].map((c) => q(c, dialecto)).join(", ")})`);
    }
    return `CREATE TABLE IF NOT EXISTS ${q(tabla, dialecto)} (\n${lineas.join(",\n")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
  }
  return `CREATE TABLE IF NOT EXISTS ${q(tabla, dialecto)} (\n${lineas.join(",\n")}\n)`;
}

function indicesSqlite(tabla) {
  const def = TABLAS[tabla];
  const sentencias = [];
  for (const u of def.unicos || []) {
    sentencias.push(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_${tabla}_${u.join("_")}" ON "${tabla}" (${["predio_id", ...u].map((c) => `"${c}"`).join(", ")})`);
  }
  for (const i of def.indices || []) {
    sentencias.push(`CREATE INDEX IF NOT EXISTS "ix_${tabla}_${i.join("_")}" ON "${tabla}" (${["predio_id", ...i].map((c) => `"${c}"`).join(", ")})`);
  }
  return sentencias;
}

module.exports = {
  TABLAS,
  NOMBRES_TABLAS,
  tablasDeInstantanea,
  columnasDe,
  tipoSql,
  parsearTipo,
  ddlTabla,
  indicesSqlite,
};
