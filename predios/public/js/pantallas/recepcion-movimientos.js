/* Recepción: movimientos de reservas y estadías (Turismo, recepción y cuenta). */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P, h = P.h, R = P.recepcion, pesos = P.f.pesos;
  var MEDIOS = R.MEDIOS, CONCEPTOS = R.CONCEPTOS, opciones = R.opciones, texto = R.texto, grid = R.grid, tabla = R.tabla,
    get = R.get, cabecera = R.cabecera;

  var ORIGEN_MOV = { RECEPCION: "Recepción", TURISMO: "Turismo", CUENTA: "Cuenta de estadía" };
  var CONCEPTO_CUENTA = {
    CARGA: "Carga de saldo", RETIRO: "Retiro de saldo", REPARTO: "Reparto de saldo",
    COMPRA: "Compra", ANULACION: "Anulación de compra", SALDAR_CONSUMOS: "Liquidación de consumos",
    PAGO_RESERVA: "Pago de diferencia", DIFERENCIAL: "Diferencia de precio",
    CIERRE_SALIDA: "Cierre de cuenta por salida", PAGO_SALIDA_CONSUMOS: "Consumos liquidados al salir",
    TRASPASO_ALOJAMIENTO: "Traslado de deuda de alojamiento", TRASPASO_CONSUMOS: "Traslado de deuda de consumos",
    NC_CONSUMOS: "Devolución sobre consumos"
  };
  function conceptoMovimiento(f) {
    return f.origen === "CUENTA" ? CONCEPTO_CUENTA[f.concepto] || CONCEPTOS[f.concepto] || f.concepto : f.concepto;
  }
  function verMovimiento(f) {
    P.modal({
      titulo: conceptoMovimiento(f),
      subtitulo: "Reserva T-" + f.reserva_id + " · " + P.f.fechaHora(f.fecha),
      ancho: "ancha",
      contenido: h("div.columna", grid(P.dato("Origen", ORIGEN_MOV[f.origen]), P.dato("Registró", texto(f.actor)),
        P.dato("Servicio", texto(f.servicio)), P.dato("Recurso", texto(f.recurso)),
        f.adicionales ? P.dato("Adicionales", f.adicionales) : null,
        f.importe == null ? null : P.dato("Importe", pesos(f.importe)),
        f.medio ? P.dato("Medio", MEDIOS[f.medio] || f.medio) : null),
      f.detalle ? h("p", f.detalle) : null,
      f.cambios && f.cambios.length ? tabla(["Campo", "Antes", "Después"], f.cambios.map(function (cambio) {
        return cambio.map(function (v) { return h("span", texto(v)); });
      })) : null)
    });
  }

  function comparar(a, b) {
    return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
  }
  function itemsDe(xs) {
    return (xs || []).map(function (x) { return { valor: String(x.id), texto: x.nombre }; });
  }
  // El catálogo incluye servicios, recursos y adicionales que ya no se ofrecen. Los filtros son
  // independientes: con más de un servicio, cada recurso lleva el nombre de su servicio adelante.
  function metaMovimientos(catalogo) {
    var servicios = catalogo.servicios || [], nombreServicio = {};
    servicios.forEach(function (s) { nombreServicio[s.id] = s.nombre; });
    var conServicio = servicios.length > 1;
    var recursos = (catalogo.recursos || []).map(function (r) {
      return { valor: String(r.id), servicio: nombreServicio[r.servicio_id] || "", nombre: r.nombre };
    }).sort(function (a, b) {
      return comparar(a.servicio, b.servicio) || comparar(a.nombre, b.nombre);
    }).map(function (r) {
      return { valor: r.valor, texto: conServicio && r.servicio ? r.servicio + " · " + r.nombre : r.nombre };
    });
    return {
      titulo: "Movimientos de reservas y estadías",
      buscador: true,
      orden: { clave: "fecha", dir: "desc" },
      columnas: [
        { clave: "fecha", titulo: "Fecha", tipo: "dt" },
        { clave: "reserva_id", titulo: "Reserva" },
        { clave: "titular", titulo: "Titular" },
        { clave: "servicio", titulo: "Servicio" },
        { clave: "recurso", titulo: "Recurso" },
        { clave: "adicionales", titulo: "Adicionales" },
        { clave: "concepto", titulo: "Movimiento" },
        { clave: "origen", titulo: "Origen", tipo: "opcion", opciones: opciones(ORIGEN_MOV) },
        { clave: "actor", titulo: "Registró" },
        { clave: "importe", titulo: "Importe", tipo: "money" }
      ],
      filtros: [
        { clave: "desde", titulo: "Desde", tipo: "desde" },
        { clave: "hasta", titulo: "Hasta", tipo: "hasta" },
        { clave: "servicio", titulo: "Servicio", tipo: "opciones", opciones: itemsDe(servicios) },
        { clave: "recurso", titulo: "Recurso", tipo: "opciones", opciones: recursos },
        { clave: "adicional", titulo: "Adicional", tipo: "opciones", opciones: itemsDe(catalogo.adicionales) },
        { clave: "origen", titulo: "Origen", tipo: "opciones", opciones: opciones(ORIGEN_MOV) }
      ]
    };
  }

  P.ruta.registrar(/^\/recepcion\/movimientos$/, function (c) {
    // Al recargar por una actualización se recupera la tabla como estaba (búsqueda, filtros, orden y página).
    var claveTabla = "recepcion-movimientos";
    var previo = P.continuidad.datosPantalla();
    if (previo && previo.tabla) P.cache["tabla:" + claveTabla] = previo.tabla;
    P.continuidad.guardarPantalla(function () { return { tabla: P.cache["tabla:" + claveTabla] }; });
    c.appendChild(cabecera("Movimientos de reservas y estadías", {
      volver: ["Reservas y estadías", "/recepcion"],
      subtitulo: "Historial de Turismo, operaciones de recepción y movimientos de cuenta."
    }));
    var t = P.tabla({
      claveEstado: claveTabla,
      placeholderBuscar: "Buscar por reserva, titular o empleado…",
      tituloVacio: "No hay movimientos con esos filtros",
      textoVacio: "Acá aparecen los cambios de Turismo, los ingresos, salidas y cambios de recepción y los movimientos de cuenta.",
      iconoVacio: "historial",
      alClickFila: verMovimiento,
      celdas: {
        // La reserva sigue siendo un enlace a su ficha; el resto de la fila abre el detalle.
        reserva_id: function (v) { return h("a.rec-codigo.rec-enlace", { href: "#/recepcion/" + v, title: "Abrir la reserva T-" + v }, "T-" + v); },
        concepto: function (_v, f) { return conceptoMovimiento(f); }
      },
      fuente: {
        meta: function () {
          return get("movimientos", { filtros: "1", solo_filtros: "1" }).then(function (r) { return metaMovimientos(r.filtros || {}); });
        },
        cargar: function (p) {
          return get("movimientos", {
            q: p.q, desde: p.f_desde, hasta: p.f_hasta, servicio_id: p.f_servicio, recurso_id: p.f_recurso,
            adicional_id: p.f_adicional, origen: p.f_origen, orden: p.orden, dir: p.dir, pagina: p.pagina, tam: p.tam
          }).then(function (r) {
            // Un Turismo anterior pagina de a 40 y sólo informa si hay una página siguiente.
            var tam = Number(r.tam) || 40, pagina = Number(r.pagina) || 1;
            var total = r.total != null ? Number(r.total) : (pagina - 1) * tam + r.filas.length + (r.siguiente ? 1 : 0);
            return { filas: r.filas, total: total, pagina: pagina, tam: tam, paginas: Number(r.paginas) || Math.max(1, Math.ceil(total / tam)) };
          });
        }
      }
    });
    c.appendChild(t.el);
  }, { titulo: "Movimientos de reservas y estadías" });
})();
