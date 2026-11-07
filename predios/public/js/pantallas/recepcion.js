/* Recepción: reservas y estadías, ingreso y salida, cuenta y artículos alquilados o comprados.
   Controles nativos, sin animaciones ni dependencias (Chrome 80+ / Firefox 78+, Windows 7 en adelante). */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P,
    h = P.h,
    pesos = P.f.pesos,
    fecha = P.f.fecha;
  var TIPOS = {
    GENERAL: "General",
    PASA_EL_DIA: "Pasa el día",
    CONTINGENTE: "Contingente",
    FEDERACION: "Federación"
  };
  var MEDIOS = {
    EFECTIVO: "Efectivo",
    TRANSFERENCIA: "Transferencia",
    AL_SALIR: "A saldar al salir",
    HABERES: "Planilla de descuento de haberes",
    SALDO: "Saldo de la estadía",
    CEDIDO: "Trasladado",
    RECIBIDO: "Recibido"
  };
  var ESTADO_CHIP = {
    Aprobada: "APROBADO", Adjudicada: "APROBADO", Verificada: "DESPACHADA", Iniciada: "PENDIENTE",
    Cancelada: "CANCELADO", "No adjudicada": "CANCELADO", Rechazada: "RECHAZADA"
  };
  var MODALIDAD = { ALQUILER: "Alquiler", VENTA: "Compra" };
  function opciones(obj) {
    return Object.keys(obj).map(function (k) {
      return { valor: k, texto: obj[k] };
    });
  }
  function lista(xs) {
    return xs.map(function (x) {
      return { valor: x.id, texto: x.nombre };
    });
  }
  function sel(xs, v, vacio) {
    return P.select(xs, v, vacio == null ? {} : { vacio: vacio });
  }
  function input(v, t) {
    return P.input({ valor: v, tipo: t || "text" });
  }
  function texto(s) {
    return s == null || s === "" ? "—" : String(s);
  }
  function btn(s, fn, t, extra) {
    var b = P.btn(s, Object.assign({
      tipo: t || "secundario",
      onclick: function (e) {
        P.ejecutar(e.currentTarget, fn).catch(function () {});
      }
    }, extra || {}));
    return b;
  }
  function grupo(t, info, contenido, extra) {
    return h("section.hoja.rec-seccion" + (extra || ""), h("div.rec-seccion-cabecera", h("h2", t), info && info.nodeType ? info : null),
      info && !info.nodeType ? h("p.texto-3.rec-ayuda", info) : null, contenido);
  }
  function grid() {
    return h("div.rec-grid", Array.prototype.slice.call(arguments));
  }
  function ir(id) {
    P.ruta.ir("/recepcion" + (id ? "/" + id : ""));
  }
  // Cabecera de las pantallas de recepción: el «volver» va arriba del título, como en Compras.
  function cabecera(t, o) {
    o = o || {};
    return h("div.pagina-cabecera.pagina-cabecera-con-acciones.rec-cabecera",
      o.volver ? h("a.volver", { href: "#" + o.volver[1] }, P.icono("volver"), o.volver[0]) : null,
      h("div.cabecera-titulo-acciones", h("h1.titulo-pagina", t), o.acciones && o.acciones.filter(Boolean).length ? h("div.rec-acciones", o.acciones) : null),
      o.subtitulo ? h("p.subtitulo", o.subtitulo) : null);
  }
  function tabla(cols, filas, clase) {
    return h("div.rec-tabla" + (clase || ""), h("table", h("thead", h("tr", cols.map(function (s) {
      var der = /^\$|Importe|Subtotal|Saldo|Pagado|Debe|Unidades|Días|Precio/.test(s);
      return h("th" + (der ? ".der" : ""), { scope: "col" }, s);
    }))), h("tbody", filas.map(function (row) {
      return h("tr", row.map(function (v, i) {
        var der = /^\$|Importe|Subtotal|Saldo|Pagado|Debe|Unidades|Días|Precio/.test(cols[i]);
        return h("td" + (der ? ".der" : ""), h("span.rec-etiqueta-movil", { "aria-hidden": "true" }, cols[i]), h("div.rec-valor", P.textoTabla(v)));
      }));
    }))));
  }
  function nuevaClave() {
    var a = new Uint32Array(4);
    window.crypto.getRandomValues(a);
    return Array.from(a).map(function (x) {
      return ("00000000" + x.toString(16)).slice(-8);
    }).join("");
  }
  function get(k, b) {
    return P.get("/recepcion/" + k + P.qs(b || {}));
  }
  // «Parcela 2» cuando el recurso ya se llama Parcela; si no, «Sector A · Parcela 2».
  function recursoYParcela(nombre, numero) {
    if (!numero) return nombre || "";
    return nombre && /parcela/i.test(nombre) ? nombre + " " + numero : [nombre, "Parcela " + numero].filter(Boolean).join(" · ");
  }
  function nombresRecursos(r) {
    return (r.recursos || []).map(function (x) { return x.nombre; }).join(", ") || r.recurso || "";
  }
  function vencida(r) {
    var hoy = P.hoy();
    return (r.personas || []).some(function (p) { return p.entrada && !p.salida && (p.salida_prevista || r.fecha_fin) < hoy; });
  }
  function espacio(v) {
    return h("span", v);
  }
  function dias(desde, hasta) {
    return Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
  }
  function periodo(a) {
    if (!a.fecha_desde) return "Toda la estadía";
    if (a.modalidad === "VENTA" || a.fecha_desde === a.fecha_hasta) return fecha(a.fecha_desde);
    return fecha(a.fecha_desde) + " al " + fecha(a.fecha_hasta);
  }
  function detalleArticulo(a) {
    var n = Number(a.cantidad);
    if (a.modalidad === "VENTA") return n + (n === 1 ? " unidad" : " unidades");
    var d = a.dias != null ? Number(a.dias) : a.fecha_desde ? dias(a.fecha_desde, a.fecha_hasta) : null;
    return n + (n === 1 ? " unidad" : " unidades") + (d ? " × " + d + (d === 1 ? " día" : " días") : "");
  }
  P.recepcion = { TIPOS: TIPOS, MEDIOS: MEDIOS, MODALIDAD: MODALIDAD, cabecera: cabecera, get: get, nuevaClave: nuevaClave, periodo: periodo, detalleArticulo: detalleArticulo,
    recursoYParcela: recursoYParcela, opciones: opciones, lista: lista, sel: sel, input: input, texto: texto, btn: btn, grupo: grupo, grid: grid, tabla: tabla, ir: ir, dias: dias };

  // ------------------------------------------------------------------ cuenta de la estadía

  var CONCEPTOS = {
    CARGA: "Carga de saldo",
    RETIRO: "Reducción de saldo",
    REPARTO: "Reparto entre integrantes",
    SALDAR_CONSUMOS: "Liquidación de consumos",
    PAGO_RESERVA: "Pago de diferencia de reserva",
    PAGO_ADICIONAL: "Pago de artículo",
    DIFERENCIAL: "Cambio en el precio de la reserva",
    COMPRA: "Compra con saldo",
    ANULACION: "Anulación de compra",
    CIERRE_SALIDA: "Cierre de cuenta por salida",
    PAGO_SALIDA_CONSUMOS: "Consumos liquidados al salir",
    TRASPASO_ALOJAMIENTO: "Traslado de deuda de alojamiento",
    TRASPASO_CONSUMOS: "Traslado de deuda de consumos",
    NC_CONSUMOS: "Devolución sobre consumos"
  };

  // Liquidación: lo que se usó, lo que se pagó y lo que queda por cobrar o devolver.
  // datos: { total, adicionales: [{ nombre, modalidad, cantidad, dias, fecha_desde, fecha_hasta, subtotal, base_turismo }],
  //          cuenta, diferencia (opcional: variación que agregaría una edición pendiente) }
  function liquidacion(datos) {
    var a = datos.cuenta || { movimientos: [], pendiente: 0, neto_consumos: 0, consumos: 0 };
    var diferencia = Number(datos.diferencia || 0);
    var total = Number(datos.total || 0);
    // Con precio acordado, los adicionales de toda la estadía quedan incluidos en ese precio.
    var articulos = (datos.adicionales || []).filter(function (x) { return x.fecha_desde || (datos.manual == null && Number(x.subtotal)); });
    var enArticulos = articulos.reduce(function (s, x) { return s + Number(x.subtotal || 0); }, 0);
    var diferenciales = 0, pagos = [];
    (a.movimientos || []).forEach(function (m) {
      if (m.concepto === "DIFERENCIAL") diferenciales += Number(m.importe);
      if (m.concepto === "PAGO_RESERVA" || m.concepto === "PAGO_ADICIONAL") pagos.push(m);
    });
    var turismo = P.redondear(total - diferencia - diferenciales);
    var pendiente = P.redondear(Number(a.pendiente) + diferencia);
    var consumos = Number(a.consumos || 0);
    var neto = Number(a.neto_consumos || 0);
    var final = P.redondear(pendiente + neto);
    var filas = [];
    function fila(concepto, detalle, importe, clase) {
      filas.push(h("tr" + (clase || ""), h("th", { scope: "row" }, concepto, detalle ? h("span.rec-liq-detalle", detalle) : null), h("td.der", importe == null ? "" : pesos(importe))));
    }
    fila("Alojamiento", datos.detalleAlojamiento || "", P.redondear(total - enArticulos));
    articulos.forEach(function (x) {
      fila(x.nombre + (x.modalidad === "VENTA" ? " (compra)" : x.fecha_desde ? " (alquiler)" : ""), detalleArticulo(x) + " · " + periodo(x), Number(x.subtotal || 0));
    });
    fila("Total de la estadía", null, total, ".rec-liq-subtotal");
    if (Math.abs(turismo) >= 0.01) fila(turismo > 0 ? "Importe de la reserva en Turismo" : "Ajuste de la reserva", "Se paga y se verifica en Mi AJB", -turismo);
    pagos.slice().reverse().forEach(function (m) {
      fila((Number(m.importe) < 0 ? "Devolución · " : "") + (m.concepto === "PAGO_ADICIONAL" ? "Pago de artículo" : "Pago en el predio"),
        [P.f.fechaHora(m.fecha), MEDIOS[m.medio] || m.medio, m.detalle].filter(Boolean).join(" · "), -Number(m.importe));
    });
    fila(pendiente < 0 ? "Reserva: a devolver" : "Reserva: por cobrar", null, Math.abs(pendiente), ".rec-liq-subtotal");
    if (consumos || neto) {
      fila("Consumos con saldo en proveeduría", null, consumos);
      if (P.redondear(consumos - neto)) fila("Saldo cargado (anticipos)", null, -P.redondear(consumos - neto));
      fila(neto < 0 ? "Consumos: anticipo a devolver" : "Consumos: por cobrar", null, Math.abs(neto), ".rec-liq-subtotal");
    }
    var caja = h("div.rec-liquidacion",
      h("table", h("thead", h("tr", h("th", { scope: "col" }, "Concepto"), h("th.der", { scope: "col" }, "Importe"))),
        h("tbody", filas),
        h("tfoot", h("tr", h("th", { scope: "row" }, final < 0 ? "Total a devolver en el predio" : final > 0 ? "Total a cobrar en el predio" : "La cuenta está saldada"),
          h("td.der", pesos(Math.abs(final)))))));
    caja.total = final;
    return caja;
  }
  P.recepcion.liquidacion = liquidacion;
  P.recepcion.CONCEPTOS = CONCEPTOS;

  P.recepcion.opSelect = opSelect;
  function opSelect(el, items, value, vacio) {
    P.vaciar(el);
    if (vacio != null) el.appendChild(h("option", { value: "" }, vacio));
    items.forEach(function (x) { el.appendChild(h("option", { value: x.valor }, x.texto)); });
    el.value = value == null ? "" : String(value);
    if (vacio == null && !el.value && items.length) el.value = String(items[0].valor);
  }
  function liquidacionSalida(salida, borrador) {
    var total = Number(salida.total);
    var hayMovimientos = total !== 0 || Number(salida.alojamiento) !== 0 || Number(salida.consumos) !== 0;
    var puedeTrasladar = total > 0 && salida.presentes.length > 0;
    var resolver = sel([{ valor: "COBRAR", texto: total < 0 ? "Devolver ahora" : "Cobrar ahora" }]
      .concat(puedeTrasladar ? [{ valor: "TRASLADAR", texto: "Dejar pendiente para quienes siguen" }] : []),
    borrador.accion || (puedeTrasladar ? "" : "COBRAR"), puedeTrasladar ? "Elegí qué hacer con el importe" : null);
    var medio = sel(opciones({ EFECTIVO: MEDIOS.EFECTIVO, TRANSFERENCIA: MEDIOS.TRANSFERENCIA }), borrador.medio, "Elegí un medio");
    var caja = sel([], null, "Elegí una caja");
    var campoMedio = P.campo("Medio de pago", medio), campoCaja = P.campo("Caja de efectivo", caja);
    // Vehículos en el predio: si no queda nadie salen todos; si no, recepción elige uno por uno.
    var pendientes = salida.vehiculos_pendientes || [];
    var elegirVehiculos = pendientes.length > 0 && salida.presentes.length > 0;
    borrador.vehiculos = borrador.vehiculos || {};
    var selectsVehiculo = pendientes.map(function (v) {
      var control = sel([{ valor: "SALE", texto: "Sale con quienes se van" }, { valor: "PERMANECE", texto: "Permanece en el predio" }],
        borrador.vehiculos[v.patente] || "", "Elegí una opción");
      control.onchange = function () { borrador.vehiculos[v.patente] = control.value; };
      return { vehiculo: v, control: control };
    });
    var cajasCargadas = false;
    function actualizar() {
      campoMedio.hidden = !total || resolver.value !== "COBRAR";
      campoCaja.hidden = campoMedio.hidden || medio.value !== "EFECTIVO";
      if (campoCaja.hidden || cajasCargadas) return;
      cajasCargadas = true;
      P.opciones("cajas").then(function (xs) {
        var asignada = P.puesto() && P.puesto().caja_id;
        if (!P.esAdmin()) xs = xs.filter(function (x) { return asignada && String(x.valor) === String(asignada); });
        var preferida = borrador.caja_id || asignada || (xs.length === 1 ? xs[0].valor : "");
        opSelect(caja, xs, preferida, "Elegí una caja");
        borrador.caja_id = caja.value;
      }).catch(function (e) { cajasCargadas = false; P.error(e); });
    }
    resolver.onchange = function () { borrador.accion = resolver.value; actualizar(); };
    medio.onchange = function () { borrador.medio = medio.value; actualizar(); };
    caja.onchange = function () { borrador.caja_id = caja.value; };
    actualizar();
    return {
      vista: h("div.rec-cotizacion.columna",
        h("h3", salida.presentes.length ? "Salida de " + salida.personas.length + (salida.personas.length === 1 ? " persona" : " personas") : "Cobro de la salida"),
        h("ul.vehiculo-detalle", salida.personas.map(function (p) {
          return h("li", h("div", h("strong", p.nombre),
            h("div.chico.texto-2", "Alojamiento " + pesos(p.alojamiento) + " · Consumos " + pesos(p.consumos)),
            Number(p.trasladado) ? h("div.chico.texto-2", "Incluye " + pesos(p.trasladado) + " de salidas anteriores") : null),
          h("strong.sin-corte", pesos(p.total)));
        })),
        h("p.fuerte", total < 0 ? "Total a devolver: " + pesos(-total) : total > 0 ? "Total a cobrar: " + pesos(total) : "Sin diferencia de dinero"),
        puedeTrasladar ? P.campo("Qué hacer con la deuda", resolver) : null,
        puedeTrasladar ? h("p.chico.texto-2", "Si la dejás pendiente, el importe quedará para " + salida.presentes.map(function (p) { return p.nombre; }).join(", ") + ".") : null,
        grid(campoMedio, campoCaja),
        elegirVehiculos ? h("div.columna", h("h4.rec-subtitulo-seccion", pendientes.length === 1 ? "Vehículo en el predio" : "Vehículos en el predio"),
          h("div.rec-grid.rec-grid-vehiculos-salida", selectsVehiculo.map(function (x) {
            return P.campo(x.vehiculo.patente + " · " + [x.vehiculo.marca, x.vehiculo.color].filter(Boolean).join(" "), x.control);
          }))) : pendientes.length ? h("p.chico.texto-2", "Registran su salida " + (pendientes.length === 1 ? "el vehículo " : "los vehículos ") +
          pendientes.map(function (v) { return v.patente; }).join(", ") + ".") : null),
      datos: function () {
        var accion = hayMovimientos ? resolver.value : undefined;
        if (hayMovimientos && !accion) { resolver.focus(); throw Error("Elegí si se cobra ahora o se traslada la deuda."); }
        if (!campoMedio.hidden && !medio.value) { medio.focus(); throw Error("Elegí cómo se registra el pago."); }
        if (!campoCaja.hidden && !caja.value) { caja.focus(); throw Error(P.esAdmin() ? "Elegí una caja para registrar el efectivo." : "Ingresá a tu caja para registrar el efectivo de recepción."); }
        var sinElegir = elegirVehiculos && selectsVehiculo.filter(function (x) { return !x.control.value; })[0];
        if (sinElegir) { sinElegir.control.focus(); throw Error("Indicá si el vehículo " + sinElegir.vehiculo.patente + " se va o permanece en el predio."); }
        return { accion: accion, medio: campoMedio.hidden ? undefined : medio.value, caja_id: campoCaja.hidden ? undefined : caja.value,
          vehiculos_salen: !pendientes.length ? undefined : elegirVehiculos ? selectsVehiculo.filter(function (x) { return x.control.value === "SALE"; })
            .map(function (x) { return x.vehiculo.patente; }) : pendientes.map(function (v) { return v.patente; }) };
      }
    };
  }

  // ------------------------------------------------------------------ listado

  function avisos(zona, r) {
    P.vaciar(zona);
    if (Number(r.vencidas) && P.ruta.query().ocupacion !== "VENCIDA") zona.appendChild(P.mensaje(h("div.fila-separada",
      h("strong", Number(r.vencidas) === 1 ? "1 estadía vencida sin salida" : r.vencidas + " estadías vencidas sin salida"),
      btn("Ver estadías vencidas", function () { P.ruta.ir("/recepcion?ocupacion=VENCIDA"); }, "secundario", { chico: true })), "aviso"));
    if (Number(r.adicionales)) zona.appendChild(P.mensaje(h("div.fila-separada",
      h("strong", P.textoAdicionalesPendientes(r.adicionales)),
      btn("Ver artículos", function () { P.ruta.ir("/recepcion/adicionales/pendientes"); }, "secundario", { chico: true })), "aviso"));
  }

  P.ruta.registrar(/^\/recepcion$/, function (c) {
    P.recepcion.descartarBorrador();
    var soloVencidas = P.ruta.query().ocupacion === "VENCIDA";
    var zonaAvisos = h("div.rec-avisos", { "aria-live": "polite" });
    var servicios = [];
    c.appendChild(cabecera(soloVencidas ? "Estadías vencidas sin salida" : "Reservas y estadías", {
      volver: soloVencidas ? ["Reservas y estadías", "/recepcion"] : null,
      acciones: [P.btn("Movimientos", { tipo: "secundario", icono: "historial", onclick: function () { ir("movimientos"); } }),
        P.esAdmin() ? P.btn("Catálogo de adicionales", { tipo: "secundario", icono: "tag", onclick: function () { ir("adicionales"); } }) : null,
        P.btn("Crear reserva", { tipo: "primario", icono: "mas", onclick: function () { ir("nueva"); } })]
    }));
    c.appendChild(zonaAvisos);
    var zona = h("div");
    c.appendChild(zona);
    // Los avisos se piden aparte: no esperan a la tabla ni dependen de sus filtros.
    get("vencidas").then(function (r) {
      P.actualizarEstadiasVencidas(r.cantidad, r.adicionales);
      avisos(zonaAvisos, { vencidas: r.cantidad, adicionales: r.adicionales });
    }).catch(function () {});
    return get("opciones").then(function (o) {
      if (!c.isConnected) return;
      // Al recargar por una actualización se recupera la tabla como estaba (búsqueda, filtros, orden y página).
      var claveTabla = soloVencidas ? "recepcion-vencidas" : "recepcion-reservas";
      var previo = P.continuidad.datosPantalla();
      if (previo && previo.tabla) P.cache["tabla:" + claveTabla] = previo.tabla;
      P.continuidad.guardarPantalla(function () { return { tabla: P.cache["tabla:" + claveTabla] }; });
      servicios = o.servicios.map(function (s) { return { valor: String(s.id), texto: s.nombre }; });
      var meta = {
        titulo: "Reservas y estadías",
        buscador: true,
        orden: { clave: "fecha_inicio", dir: "desc" },
        columnas: [
          { clave: "id", titulo: "ID" },
          { clave: "titular", titulo: "Titular" },
          { clave: "fecha_inicio", titulo: "Fecha inicio", tipo: "date" },
          { clave: "fecha_fin", titulo: "Fecha final", tipo: "date" },
          { clave: "servicio", titulo: "Servicio" },
          { clave: "recurso", titulo: "Recurso" },
          { clave: "tipo", titulo: "Tipo", tipo: "opcion", opciones: opciones(TIPOS) },
          { clave: "estado", titulo: "Estado" },
          { clave: "importe", titulo: "Importe", tipo: "money" }
        ],
        filtros: [
          { clave: "desde", titulo: "Desde", tipo: "desde" },
          { clave: "hasta", titulo: "Hasta", tipo: "hasta" },
          { clave: "servicio", titulo: "Servicio", tipo: "opciones", opciones: servicios },
          { clave: "tipo", titulo: "Tipo", tipo: "opciones", opciones: opciones(TIPOS) },
          { clave: "ocupacion", titulo: "Ocupación", tipo: "opciones", opciones: opciones({
            PRESENTE: "Con huéspedes en el predio",
            SALIDA: "Con salidas registradas",
            VENCIDA: "Estadía vencida sin salida"
          }) },
          { clave: "atipicas", titulo: "Operaciones", tipo: "opciones", opciones: [{ valor: "1", texto: "Solo atípicas del predio" }] }
        ]
      };
      var t = P.tabla({
        claveEstado: claveTabla,
        filtrosIniciales: soloVencidas ? { ocupacion: "VENCIDA" } : { desde: P.hoy() },
        placeholderBuscar: "Buscar por titular, DNI o reserva…",
        tituloVacio: "No hay reservas con esos filtros",
        textoVacio: "Podés cambiar las fechas o crear una reserva.",
        iconoVacio: "lista",
        alClickFila: function (f) { ir(f.id); },
        celdas: {
          id: function (v) { return h("span.rec-codigo", "T-" + v); },
          estado: function (v, f) {
            if (Number(f.vencida)) return h("div.rec-celda-estado", P.chip("Vencida sin salida", "VENCIDO"),
              (f.huespedes_pendientes || []).length ? h("span.chico.texto-3", f.huespedes_pendientes.join(", ")) : null);
            return P.chip(v, ESTADO_CHIP[v] || "");
          }
        },
        fuente: {
          meta: meta,
          cargar: function (p) {
            var vencidas = p.f_ocupacion === "VENCIDA";
            return get("listar", {
              q: p.q, desde: vencidas ? "" : p.f_desde, hasta: vencidas ? "" : p.f_hasta, servicio_id: p.f_servicio, tipo: p.f_tipo,
              ocupacion: p.f_ocupacion, atipicas: p.f_atipicas, orden: p.orden, dir: p.dir, pagina: p.pagina, tam: p.tam
            }).then(function (r) {
              P.actualizarEstadiasVencidas(r.vencidas);
              var total = Number(r.total != null ? r.total : r.cantidad) || 0;
              var tam = Number(r.tam || p.tam || 40);
              return {
                filas: r.filas.map(function (x) {
                  return Object.assign({}, x, { recurso: [recursoYParcela(nombresRecursos(x), x.numero_parcela), x.ubicacion].filter(Boolean).join(" · "),
                    tipo: x.tipo || "GENERAL", importe: x.precio_total });
                }),
                total: total, pagina: Number(r.pagina) || 1, tam: tam, paginas: Number(r.paginas) || Math.max(1, Math.ceil(total / tam))
              };
            });
          }
        }
      });
      P.reemplazar(zona, t.el);
    });
  }, {
    titulo: "Reservas y estadías"
  });

  // ------------------------------------------------------------------ alta y edición

  // Reserva a medio cargar mientras se pasa por el catálogo de adicionales: al volver al
  // formulario (con el enlace o con «atrás») se recupera tal como estaba.
  var CLAVE_BORRADOR = "recepcion:borrador", VIGENCIA_BORRADOR = 4 * 3600000;
  function borrador() {
    var b = P.cache[CLAVE_BORRADOR];
    return b && Date.now() - b.fecha <= VIGENCIA_BORRADOR ? b : null;
  }
  function tomarBorrador() {
    var b = borrador();
    if (!b || b.hash !== location.hash) return null;
    delete P.cache[CLAVE_BORRADOR];
    return Object.assign({}, b.datos, { cotizacion: null, desdeBorrador: true });
  }
  P.recepcion.borrador = borrador;
  P.recepcion.descartarBorrador = function () { delete P.cache[CLAVE_BORRADOR]; };
  function esParcelaServicio(o, servicioId) {
    var s = o.servicios.filter(function (x) { return String(x.id) === String(servicioId); })[0];
    return !!s && s.tipo_codigo === "CUPO_NUMERADO";
  }

  function formulario(c, o, r, cuenta, accion, lineasCuenta) {
    if (!c.isConnected) return;
    r = r || {};
    var previo = P.continuidad.datosPantalla() || tomarBorrador();
    var hoy = P.hoy(),
      viajeros = previo ? previo.viajeros : (r.personas || []).map(function (p) {
        return Object.assign({}, p);
      }),
      extras = previo ? previo.extras : (r.adicionales_vigentes || r.adicionales || []).map(function (a) {
        var modalidad = a.modalidad || (o.adicionales.filter(function (x) { return Number(x.id) === Number(a.adicional_id); })[0] || {}).modalidad;
        return Object.assign({}, a, { modalidad: modalidad || "ALQUILER", porDia: !!(a.fecha_desde || a.fecha_hasta) });
      });
    var iniciada = (r.personas || []).some(function (p) { return p.entrada; });
    var recursosFijos = !!r.bloque_fecha_id;
    var checkout = accion === "salida", editarFechas = accion === "fechas";
    var ajustesSalida = previo && previo.ajustesSalida || {};
    var familia = previo ? previo.familia : [],
      titular = previo ? previo.titular : r.id ? {
        dni: r.titular_dni
      } : null,
      particular = previo ? previo.particular : null,
      titularMostrado = previo ? previo.titularMostrado : null,
      particularSinFicha = previo ? previo.particularSinFicha : false,
      cotizacion = previo ? previo.cotizacion : null,
      opId = previo ? previo.opId : nuevaClave(),
      versionInicial = previo ? previo.versionInicial : r.version;
    var tipo = sel(opciones(TIPOS), r.tipo || "GENERAL"),
      serv = sel(lista(o.servicios), r.servicio_id, "Elegí un servicio"),
      rec = sel([], null),
      reg = sel([], null);
    var campoRegimen = P.campo("Régimen", reg);
    var campoTraslado = null;
    var inicio = input(r.fecha_inicio || hoy, "date"),
      fin = input(r.fecha_fin || P.sumarDias(hoy, 1), "date"),
      entidad = input(r.entidad),
      cantidad = input(r.cantidad || 1, "number"),
      traslado = input(hoy, "date");
    if (!previo && accion === "extender") {
      fin.value = P.sumarDias(fin.value < hoy ? hoy : fin.value, 1);
    }
    var dni = input(r.titular_dni),
      nom = input(""),
      ape = input(""),
      nac = input("", "date"),
      ubic = input(r.ubicacion),
      vehiculosPrevios = r.vehiculos || [],
      vehiculos = previo && previo.vehiculos ? previo.vehiculos : vehiculosPrevios.map(function (v) { return Object.assign({}, v); }),
      grupoVehiculos = h("div.columna");
    ubic.maxLength = 120;
    ubic.placeholder = "Ej.: bajo los pinos, frente al quincho";
    var campoUbicacion = P.campo("Ubicación en la parcela (opcional)", ubic, {
      clase: "rec-campo-ubicacion", ayuda: "Dónde arman la carpa. Se puede completar ahora, al ingresar o después desde el QR." });
    var manual = P.dinero({ valor: r.manual == null ? "" : P.f.numero(r.manual) });
    var motivo = input(""),
      obs = input(r.observaciones),
      base = h("div.rec-formulario"),
      grupoViaje = h("div.columna"),
      cargos = h("div.columna"),
      part = h("div.columna"),
      estadoTit = h("div", {
        "aria-live": "polite"
      }),
      pre = h("div", {
        "aria-live": "polite"
      });
    var selectFamilia = sel([], null, "Familiares y acompañantes"),
      selectExtra = sel([], null, "Elegí un artículo");
    var campos = { tipo: tipo, servicio: serv, regimen: reg, inicio: inicio, fin: fin, entidad: entidad, cantidad: cantidad,
      traslado: traslado, dni: dni, nombre: nom, apellido: ape, nacimiento: nac, ubicacion: ubic, precio: manual, motivo: motivo, observaciones: obs };
    function esParcela() { return esParcelaServicio(o, serv.value); }
    function algunaPresente() { return viajeros.some(function (p) { return p.entrada && !p.salida; }); }
    function inicioAlquiler() {
      return inicio.value && hoy < inicio.value ? inicio.value : fin.value && hoy > fin.value ? fin.value : hoy;
    }
    function regimenes() {
      var ids = (o.servicio_regimenes || []).filter(function (x) { return String(x.servicio_id) === serv.value; }).map(function (x) { return Number(x.regimen_id); });
      return o.regimenes.filter(function (x) { return !ids.length || ids.indexOf(Number(x.id)) >= 0; });
    }
    function pintarRegimen(valor) {
      var xs = regimenes();
      opSelect(reg, lista(xs), valor != null ? valor : reg.value || (xs[0] && xs[0].id), xs.length > 1 ? "Elegí un régimen" : null);
      // Con un solo régimen no hay nada que elegir: queda fijo y no se muestra.
      campoRegimen.hidden = xs.length <= 1;
    }
    function pintarAdicionales() {
      var tarifas = o.adicionales.filter(function (x) { return String(x.recurso_id) === rec.value && String(x.regimen_id) === reg.value; });
      var disponibles = new Map();
      tarifas.forEach(function (x) {
        if (extras.some(function (a) { return Number(a.adicional_id) === Number(x.id); })) return;
        var item = disponibles.get(Number(x.id)) || { valor: x.id, nombre: x.nombre, modalidad: x.modalidad || "ALQUILER", precios: [] };
        var dia = inicioAlquiler();
        if (x.precio != null && (!x.fecha_desde || x.fecha_desde <= dia && (!x.fecha_hasta || x.fecha_hasta >= dia)) && item.precios.indexOf(Number(x.precio)) < 0) item.precios.push(Number(x.precio));
        disponibles.set(Number(x.id), item);
      });
      opSelect(selectExtra, Array.from(disponibles.values()).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es"); }).map(function (x) {
        return { valor: x.valor, texto: x.nombre + (x.modalidad === "VENTA" ? " · compra" : "") +
          (x.precios.length === 1 ? " · " + pesos(x.precios[0]) + (x.modalidad === "VENTA" ? " c/u" : " por día") : "") };
      }), null, "Elegí un artículo");
      P.reemplazar(cargos, extras.length ? h("div.rec-articulos", extras.map(function (a, i) {
        var venta = a.modalidad === "VENTA";
        var n = input(a.cantidad, "number"), de = input(a.fecha_desde, "date"), hasta = input(venta ? a.fecha_desde : a.fecha_hasta, "date");
        var resumen = h("span.texto-3.chico", { "aria-live": "polite" });
        function cambiar() {
          a.cantidad = n.value; a.fecha_desde = de.value; a.fecha_hasta = venta ? de.value : hasta.value;
          var d = a.fecha_desde && a.fecha_hasta ? dias(a.fecha_desde, a.fecha_hasta) : 0;
          resumen.textContent = venta ? "Se cobra una vez por unidad." : d >= 1 ? d + (d === 1 ? " día de uso" : " días de uso") :
            !a.fecha_desde && !a.fecha_hasta && !a.porDia ? "Incluido en toda la estadía" : "Completá el período de uso.";
        }
        n.min = "1"; n.step = "1";
        de.min = hasta.min = inicio.value; de.max = hasta.max = fin.value;
        n.oninput = de.oninput = hasta.oninput = cambiar;
        cambiar();
        var quitar = P.btn("", { tipo: "texto", icono: "borrar", etiqueta: "Quitar " + a.nombre, onclick: function () { extras.splice(i, 1); pintarAdicionales(); } });
        return h("div.rec-articulo",
          h("div.rec-articulo-nombre", h("strong", a.nombre), h("span.chip.chip-sin-punto", venta ? "Compra" : "Alquiler")),
          P.campo("Unidades", n, { clase: "rec-campo-corto" }),
          P.campo(venta ? "Fecha de la compra" : "Primer día", de),
          venta ? null : P.campo("Último día", hasta),
          h("div.rec-articulo-pie", resumen, quitar));
      })) : null, h("div.rec-agregar",
        disponibles.size ? P.campo("Artículo", selectExtra, { clase: "rec-campo-ancho" }) : h("span.texto-3", !rec.value || !reg.value ? "Elegí el servicio y el recurso para ver los artículos." :
          extras.length ? "No hay más artículos con precio para esta selección." : "No hay artículos con precio para esta selección."),
        disponibles.size ? P.btn("Agregar", { tipo: "secundario", icono: "mas", onclick: function () {
          var x = disponibles.get(Number(selectExtra.value));
          if (!x) { selectExtra.focus(); P.aviso("Elegí el artículo que querés sumar.", "error"); return; }
          extras.push({ adicional_id: x.valor, nombre: x.nombre, modalidad: x.modalidad, cantidad: 1, fecha_desde: inicioAlquiler(), fecha_hasta: inicioAlquiler(), porDia: true });
          pintarAdicionales();
        } }) : null),
        P.esAdmin() ? h("p.texto-3.chico.rec-ayuda", "¿Falta un artículo o un precio? Cargalo en el ", h("a", { href: "#/recepcion/adicionales", onclick: function (e) {
          e.preventDefault();
          P.cache[CLAVE_BORRADOR] = { hash: location.hash, fecha: Date.now(), datos: instantanea(), titulo: r.id ? "Reserva T-" + r.id : "Nueva reserva" };
          ir("adicionales");
        } }, "Catálogo de adicionales"), ". Lo que ya cargaste en esta reserva se conserva para cuando vuelvas.") : null);
    }
    function recursos(v) {
      opSelect(rec, lista(o.recursos.filter(function (x) {
        return String(x.servicio_id) === serv.value;
      })), v, "Sin recurso");
      pintarRegimen(previo ? null : r.servicio_id && String(r.servicio_id) === serv.value ? r.regimen_id : null);
      campoUbicacion.hidden = !esParcela();
      pintarAdicionales();
    }
    function pintarPersonas() {
      if (checkout || editarFechas) {
        var seleccionables = viajeros.filter(function (p) {
          var anterior = r.personas.find(function (v) { return String(v.dni) === String(p.dni); });
          return anterior && !anterior.salida && (!checkout || anterior.entrada);
        });
        P.reemplazar(grupoViaje, seleccionables.length ? seleccionables.map(function (p) {
          var nombre = p.apellido + ", " + p.nombre;
          if (editarFechas) {
            var prevista = input(p.salida_prevista, "date");
            prevista.min = p.entrada || inicio.value;
            prevista.oninput = function () { p.salida_prevista = prevista.value; };
            return h("fieldset.rec-viajero", h("legend", nombre),
              P.campo("Salida prevista individual", prevista, { ayuda: "Si queda vacía, se usa " + fecha(fin.value) + ", la fecha de la reserva." }));
          }
          var elegido = P.check("Registrar salida de " + nombre, !!p.salida);
          var efectiva = input(p.salida || hoy, "date");
          efectiva.min = p.entrada;
          efectiva.max = hoy;
          efectiva.required = true;
          efectiva.disabled = !elegido.input.checked;
          efectiva.oninput = function () { p.salida = efectiva.value; };
          elegido.input.onchange = function () {
            efectiva.disabled = !elegido.input.checked;
            p.salida = elegido.input.checked ? efectiva.value || hoy : "";
            if (elegido.input.checked) { efectiva.value = p.salida; efectiva.focus(); }
          };
          return h("fieldset.rec-viajero", h("legend", nombre), h("div.rec-grid.rec-grid-fechas", h("div.rec-check-salida", elegido),
            P.campo("Fecha efectiva de salida", efectiva, { ayuda: "Salida prevista: " + fecha(p.salida_prevista || fin.value) })));
        }) : P.mensaje(checkout ? "No quedan huéspedes presentes." : "No quedan fechas de salida por modificar.", "info"));
        return;
      }
      opSelect(selectFamilia, familia.filter(function (x) {
        return !viajeros.some(function (v) {
          return String(v.dni) === String(x.dni);
        });
      }).map(function (p) {
        return {
          valor: p.dni,
          texto: p.apellido + ", " + p.nombre + " · " + p.dni
        };
      }), null, "Familiares y acompañantes");
      P.reemplazar(grupoViaje, viajeros.map(function (p, i) {
        function campo(key, t, label) {
          var el = input(p[key], t);
          el.addEventListener("input", function () {
            p[key] = el.value;
          });
          if (p.id && ["nombre", "apellido", "fecha_nacimiento", "dni"].indexOf(key) >= 0) el.readOnly = true;
          return P.campo(label, el);
        }
        var parentesco = sel(lista(o.parentescos), p.parentesco_id || 5);
        parentesco.disabled = !!p.id;
        parentesco.onchange = function () {
          p.parentesco_id = Number(parentesco.value);
        };
        var entrada = campo("entrada", "date", "Ingreso efectivo"),
          salida = campo("salida", "date", "Salida efectiva"),
          prevista = campo("salida_prevista", "date", "Salida prevista (si es otra)"),
          yaSalio = (r.personas || []).some(function (anterior) { return anterior.salida && String(anterior.dni) === String(p.dni); }),
          yaIngreso = (r.personas || []).some(function (anterior) { return anterior.entrada && String(anterior.dni) === String(p.dni); });
        prevista.querySelector("input").readOnly = yaSalio;
        function marcarHoy(key, etiqueta) {
          p[key] = hoy;
          var control = etiqueta.querySelector("input");
          control.value = hoy;
          control.focus();
        }
        return h("fieldset.rec-viajero", h("legend", "Pasajero " + (i + 1) + (p.apellido ? " · " + p.apellido + (p.nombre ? ", " + p.nombre : "") : "")),
          h("div.rec-grid.rec-grid-persona", campo("dni", "text", "DNI"), campo("nombre", "text", "Nombre"), campo("apellido", "text", "Apellido"),
            campo("fecha_nacimiento", "date", "Nacimiento"), P.campo("Vínculo", parentesco)),
          h("div.rec-grid.rec-grid-fechas", entrada, prevista, salida),
          h("div.rec-botones-fecha", btn("Ingresó hoy", function () {
            if (p.salida && p.salida < hoy) throw Error("El ingreso debe ser anterior o igual a la salida.");
            marcarHoy("entrada", entrada);
          }, "suave", { chico: true }), btn("Salió hoy", function () {
            if (!p.entrada) { entrada.querySelector("input").focus(); throw Error("Registrá primero la fecha de ingreso."); }
            marcarHoy("salida", salida);
          }, "suave", { chico: true }), yaIngreso ? null : btn("Quitar", function () {
            viajeros.splice(i, 1);
            pintarPersonas();
          }, "texto", { chico: true, icono: "borrar" })));
      }), h("div.rec-agregar", P.campo("Agregar desde la ficha del titular", selectFamilia, { clase: "rec-campo-ancho" }), btn("Incluir", function () {
        var p = familia.find(function (x) {
          return String(x.dni) === selectFamilia.value;
        });
        if (!p) { selectFamilia.focus(); throw Error("Elegí la persona que viaja."); }
        viajeros.push(Object.assign({}, p));
        pintarPersonas();
      }), btn("Cargar otra persona", function () {
        viajeros.push({
          parentesco_id: 5
        });
        pintarPersonas();
        grupoViaje.querySelectorAll("fieldset")[viajeros.length - 1].querySelector("input").focus();
      }, "secundario", { icono: "mas" })));
    }
    function pintarVehiculos() {
      P.reemplazar(grupoVehiculos, vehiculos.map(function (v, i) {
        var previoV = vehiculosPrevios.filter(function (x) { return x.patente === v.patente; })[0];
        function campo(key, label, t, extra) {
          var el = input(v[key], t);
          if (key === "patente") { el.maxLength = 20; el.autocapitalize = "characters"; }
          else if (t !== "date") el.maxLength = 50;
          el.addEventListener("input", function () {
            v[key] = key === "patente" ? el.value.toUpperCase() : el.value;
            if (key === "patente") titulo.textContent = "Vehículo " + (i + 1) + (v.patente ? " · " + v.patente : "");
          });
          if (key === "patente" && previoV) el.readOnly = true;
          if (t === "date") { el.min = inicio.value; el.max = hoy; }
          return P.campo(label, el, extra);
        }
        var titulo = h("legend", "Vehículo " + (i + 1) + (v.patente ? " · " + v.patente : ""));
        var entrada = campo("entrada", "Ingreso del vehículo", "date"), salida = campo("salida", "Salida del vehículo", "date");
        // Un vehículo que ya ingresó no se borra: se registra su salida (salvo un error del mismo día).
        var ingresoPrevio = previoV && (previoV.entrada || (iniciada ? r.fecha_inicio : null));
        var borrable = !previoV || !previoV.salida && (!ingresoPrevio || ingresoPrevio === hoy);
        function marcarHoy(key, etiqueta) {
          v[key] = hoy;
          var control = etiqueta.querySelector("input");
          control.value = hoy;
          control.focus();
        }
        return h("fieldset.rec-viajero.rec-vehiculo", titulo,
          h("div.rec-grid", campo("patente", "Patente"), campo("marca", "Marca"), campo("color", "Color"),
            campo("sector", "Sector de estacionamiento (opcional)")),
          h("div.rec-grid.rec-grid-fechas", entrada, salida),
          h("div.rec-botones-fecha", v.entrada ? null : btn("Ingresó hoy", function () { marcarHoy("entrada", entrada); }, "suave", { chico: true }),
            v.salida ? null : btn("Salió hoy", function () {
              if (!v.entrada && !algunaPresente()) { entrada.querySelector("input").focus(); throw Error("Registrá primero el ingreso del vehículo."); }
              marcarHoy("salida", salida);
            }, "suave", { chico: true }),
            borrable ? btn("Quitar", function () { vehiculos.splice(i, 1); pintarVehiculos(); }, "texto", { chico: true, icono: "borrar" }) : null));
      }), h("div.rec-agregar", btn("Agregar vehículo", function () {
        if (vehiculos.length >= 20) throw Error("Una reserva admite hasta veinte vehículos.");
        vehiculos.push({ patente: "", marca: "", color: "", sector: "", entrada: algunaPresente() ? hoy : "", salida: "" });
        pintarVehiculos();
        grupoVehiculos.querySelectorAll("fieldset")[vehiculos.length - 1].querySelector("input").focus();
      }, "secundario", { icono: "mas" }), vehiculos.length ? null : h("span.texto-3", "Sin vehículos. Si llegan en auto, agregalo con su patente.")));
    }
    function instantanea() {
      var valores = {};
      Object.keys(campos).forEach(function (clave) { valores[clave] = campos[clave].value; });
      return { campos: valores, recurso: rec.value, familiarElegido: selectFamilia.value, adicionalElegido: selectExtra.value,
        familia: familia, titular: titular, particular: particular, titularMostrado: titularMostrado, particularSinFicha: particularSinFicha,
        viajeros: viajeros, extras: extras, vehiculos: vehiculos, cotizacion: cotizacion, ajustesSalida: ajustesSalida, opId: opId, versionInicial: versionInicial };
    }
    function mostrarTitular(p) {
      P.reemplazar(estadoTit, h("div.rec-titular", P.icono("persona"), h("strong", p.apellido + ", " + p.nombre),
        r.id ? h("span.texto-3", "DNI " + p.dni) : null, h("span.chip.chip-sin-punto", Number(p.afiliado) ? "Afiliado" : "Particular")));
    }
    function mostrarParticular() {
      P.reemplazar(estadoTit, P.mensaje("No encontramos una ficha con ese DNI o legajo. Podés registrar un particular sin acceso a Mi AJB.", "info"));
      P.reemplazar(part, grid(P.campo("Nombre", nom), P.campo("Apellido", ape), P.campo("Nacimiento", nac)), h("div.rec-pie-acciones", btn("Usar este particular", function () {
        if (!nom.value || !ape.value || !nac.value || !/^\d{6,10}$/.test(dni.value)) throw Error("Completá DNI, nombre, apellido y nacimiento.");
        particular = { nombre: nom.value, apellido: ape.value, fecha_nacimiento: nac.value, dni: dni.value, parentesco_id: 1, tipo_persona_id: 4 };
        titular = titularMostrado = particular;
        particularSinFicha = false;
        familia = [particular];
        viajeros = [Object.assign({}, particular)];
        mostrarTitular(particular);
        P.vaciar(part);
        pintarPersonas();
      })));
    }
    function buscarTitular(q, editar) {
      return get("familia", {
        q: q
      }).then(function (f) {
        if (!editar && dni.value.trim() !== String(q)) return;
        if (!editar) {
          titular = f.titular;
          particular = null;
          viajeros = [];
        }
        familia = f.personas;
        titularMostrado = f.titular;
        particularSinFicha = !editar && !f.titular;
        P.vaciar(part);
        if (f.titular) {
          mostrarTitular(f.titular);
          if (!editar) {
            dni.value = f.titular.dni;
            viajeros = [Object.assign({}, f.titular)];
          }
        } else if (particularSinFicha) mostrarParticular();
        pintarPersonas();
      });
    }
    dni.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); botonBuscar.click(); } });
    dni.oninput = function () {
      titular = null;
      particular = null;
      titularMostrado = null;
      particularSinFicha = false;
      familia = [];
      viajeros = [];
      P.vaciar(estadoTit);
      P.vaciar(part);
      pintarPersonas();
    };
    function cuerpo() {
      if (!r.id && !titular) throw Error("Buscá o registrá al titular antes de continuar.");
      if (checkout) {
        var invalida = Array.from(grupoViaje.querySelectorAll('input[type="date"]:not(:disabled)')).find(function (control) { return !control.checkValidity(); });
        if (invalida) { invalida.reportValidity(); throw Error("Revisá la fecha efectiva de salida."); }
      }
      if (checkout && !viajeros.some(function (p) {
        return p.salida && r.personas.some(function (anterior) { return String(anterior.dni) === String(p.dni) && !anterior.salida; });
      })) throw Error("Indicá la fecha efectiva de al menos una salida.");
      var precio = manual.value.trim() ? P.importeDe(manual.value) : null;
      if (precio === null && tipo.value !== "GENERAL" || precio !== null && !Number.isFinite(precio)) {
        manual.focus();
        throw Error("Indicá el precio acordado en pesos, con hasta dos decimales. Para gratuidad ingresá 0.");
      }
      var salidaGrupo = viajeros.length && viajeros.every(function (p) { return p.salida; });
      var seleccion = extras.map(function (a) {
        if (!Number.isInteger(Number(a.cantidad)) || Number(a.cantidad) < 1) throw Error("Indicá cuántas unidades lleva de " + a.nombre + ".");
        if (a.porDia || a.fecha_desde || a.fecha_hasta) {
          if (a.modalidad === "VENTA") a.fecha_hasta = a.fecha_desde;
          if (!a.fecha_desde || !a.fecha_hasta || a.fecha_desde > a.fecha_hasta || a.fecha_desde < inicio.value || !salidaGrupo && a.fecha_hasta > fin.value) {
            throw Error((a.modalidad === "VENTA" ? "Revisá la fecha de compra de " : "Revisá los días de uso de ") + a.nombre + ". Deben estar dentro de la estadía.");
          }
        }
        return { adicional_id: Number(a.adicional_id), cantidad: Number(a.cantidad), fecha_desde: a.fecha_desde || null, fecha_hasta: a.fecha_hasta || null };
      });
      return {
        operacion: opId,
        id: r.id,
        version: versionInicial,
        titular_dni: titular && String(titular.dni),
        particular: particular,
        tipo: tipo.value,
        servicio_id: serv.value,
        recurso_id: rec.value,
        regimen_id: reg.value,
        fecha_inicio: inicio.value,
        fecha_fin: fin.value,
        cantidad: cantidad.value,
        entidad: entidad.value,
        traslado: traslado.value,
        vehiculos: vehiculos.map(function (v) {
          return { patente: String(v.patente || "").trim(), marca: String(v.marca || "").trim(), color: String(v.color || "").trim(),
            sector: String(v.sector || "").trim(), entrada: v.entrada || null, salida: v.salida || null };
        }),
        ubicacion: esParcela() ? ubic.value.trim() : null,
        personas: viajeros.map(function (x) {
          var edadBebe = x.fecha_nacimiento && inicio.value && inicio.value < String(Number(x.fecha_nacimiento.slice(0, 4)) + 2) + x.fecha_nacimiento.slice(4);
          return Object.assign({}, x, {
            tipo_persona_id: edadBebe ? 5 : x.tipo_persona_id || (particular ? 4 : [2, 3, 4].indexOf(Number(x.parentesco_id)) >= 0 ? 2 : 3)
          });
        }),
        adicionales: seleccion,
        manual: precio,
        motivo: motivo.value,
        observaciones: obs.value
      };
    }
    function pintarCotizacion(b, x, enfocar) {
      cotizacion = { cuerpo: b, resultado: x };
      var salidaPersonas = x.salida ? liquidacionSalida(x.salida, ajustesSalida) : null;
      var confirmar = btn(x.salida ? "Confirmar salida" : r.id ? "Guardar cambios" : "Crear reserva aprobada", function () {
        var nuevo = cuerpo();
        if (JSON.stringify(nuevo) !== JSON.stringify(b)) {
          cotizacion = null;
          P.vaciar(pre);
          throw Error("Cambiaste el formulario. Revisá el importe de nuevo.");
        }
        return P.post("/recepcion/guardar", Object.assign({}, b, {
          cotizacion_esperada: x.cotizacion_esperada, cuenta_esperada: x.cuenta, salida: salidaPersonas ? salidaPersonas.datos() : undefined
        })).then(function (res) {
          if (res.encolado) {
            ir();
            return;
          }
          P.aviso(res.mensaje, "ok");
          var ingresoNuevo = b.personas.some(function (p) {
            return p.entrada && !(r.personas || []).some(function (a) { return String(a.dni) === String(p.dni) && a.entrada; });
          });
          P.ruta.ir("/recepcion/" + res.id + (checkout ? "?salida=1" + (res.comprobante ? "&comprobante=" + res.comprobante.id : "") : ingresoNuevo ? "?ingreso=1" : ""));
        });
      }, "primario", { icono: "check" });
      var saldo = Object.assign({}, cuenta || {}, x.cuenta || {});
      if (cuenta && cuenta.movimientos) saldo.movimientos = cuenta.movimientos;
      if (cuenta && cuenta.consumos != null) saldo.consumos = cuenta.consumos;
      var articulos = (x.detalle_alquileres || []).map(function (a) {
        var original = extras.filter(function (e) { return Number(e.adicional_id) === Number(a.adicional_id); })[0] || {};
        return Object.assign({}, a, { modalidad: original.modalidad });
      });
      var salenTodos = !x.salida || !x.salida.presentes.length;
      var sinDevolver = checkout && salenTodos ? (lineasCuenta || []).filter(function (l) { return l.modalidad !== "VENTA" && l.fecha_desde && !l.devuelto; }) : [];
      P.reemplazar(pre, h("div.rec-revision",
        h("h3", checkout ? "Liquidación de salida" : "Revisión del importe"),
        h("div.rec-grid.rec-cifras",
          P.dato("Precio final de la reserva", pesos(x.total)),
          x.adicionales ? P.dato("Incluye artículos", pesos(x.adicionales)) : null,
          r.id ? P.dato(x.diferencia < 0 ? "Disminución del precio" : "Aumento del precio", pesos(Math.abs(x.diferencia))) : null,
          x.fecha_fin && x.fecha_fin !== b.fecha_fin ? P.dato("Nueva fecha de fin de la reserva", fecha(x.fecha_fin)) : null),
        x.personas.length > 1 || x.personas.some(function (p) { return Number(p.precio); }) ? h("p.texto-3.chico", x.personas.map(function (p) { return p.nombre + ": " + pesos(p.precio); }).join(" · ")) : null,
        // La cuenta completa se muestra cuando no queda nadie: en una salida parcial manda la liquidación por persona.
        r.id && salenTodos ? liquidacion({ total: x.total, diferencia: x.diferencia, adicionales: articulos, cuenta: saldo, manual: b.manual,
          detalleAlojamiento: [nombresRecursos(r) || r.servicio, fecha(inicio.value) + " al " + fecha(x.fecha_fin || fin.value)].filter(Boolean).join(" · ") }) :
          articulos.length ? tabla(["Artículo", "Detalle", "Subtotal"], articulos.map(function (a) { return [a.nombre, detalleArticulo(a) + " · " + periodo(a), pesos(a.subtotal)]; })) : null,
        salidaPersonas ? salidaPersonas.vista : null,
        sinDevolver.length ? P.mensaje("Sin devolver: " + sinDevolver.map(function (l) { return l.nombre + " (" + l.cantidad + ")"; }).join(", ") +
          ". Registrá la devolución desde la ficha de la reserva.", "aviso") : null,
        r.id ? h("p.texto-3.chico", "Si la reserva se creó en Turismo, el importe original se verifica en Mi AJB. Este saldo incluye los cambios hechos en el predio, los artículos y los consumos con saldo.") : null,
        h("div.rec-pie-acciones", confirmar)));
      if (enfocar) confirmar.focus();
    }
    var guardar = btn("Revisar importe", function () {
      var b = cuerpo();
      return P.post("/recepcion/cotizar", b).then(function (x) {
        ajustesSalida = {};
        pintarCotizacion(b, x, true);
      });
    }, "primario");
    var gExtra = grupo("Alquileres y compras", "Un alquiler se cobra por unidad y por día, incluidos el primero y el último. Una compra se cobra una vez por unidad.", cargos);
    var contingente = h("div.rec-grid", P.campo("Integrantes (con responsables)", cantidad), P.campo("Entidad (opcional)", entidad));
    function modalidad(conservarFechas) {
      contingente.hidden = tipo.value !== "CONTINGENTE";
      manual.required = tipo.value !== "GENERAL";
      if (conservarFechas !== true) {
        if (tipo.value === "PASA_EL_DIA") fin.value = inicio.value;
        else if (tipo.value === "GENERAL" && inicio.value && fin.value <= inicio.value) fin.value = P.sumarDias(inicio.value, 1);
      }
      fin.readOnly = tipo.value === "PASA_EL_DIA";
      pintarAdicionales();
    }
    tipo.onchange = modalidad;
    inicio.onchange = modalidad;
    fin.onchange = pintarAdicionales;
    serv.onchange = function () {
      recursos(null);
    };
    rec.onchange = function () {
      if (campoTraslado) campoTraslado.hidden = !r.recurso_id || rec.value === String(r.recurso_id);
      pintarAdicionales();
    };
    reg.onchange = pintarAdicionales;
    rec.disabled = serv.disabled = recursosFijos;
    var tituloEdicion = checkout ? "Registrar salida · T-" : editarFechas ? "Modificar días por persona · T-" : accion === "extender" ? "Extender estadía · T-" : "Editar T-";
    c.appendChild(cabecera(r.id ? tituloEdicion + r.id : "Nueva reserva", {
      volver: r.id ? ["Reserva T-" + r.id, "/recepcion/" + r.id] : ["Reservas y estadías", "/recepcion"],
      subtitulo: checkout ? "Elegí quién sale. Al revisar el importe vas a ver la liquidación, qué hacer con el saldo y con el vehículo." : editarFechas ?
        "Elegí una fecha de salida para cada persona que tenga días distintos a los de la reserva." :
        r.id ? (r.titular_nombre ? r.titular_nombre + " · " : "") + "Revisá el importe antes de guardar los cambios." : "La reserva queda aprobada al confirmarla."
    }));
    if (checkout && vencida(r) && (r.tipo === "PASA_EL_DIA" || r.bloque_fecha_id)) c.appendChild(
      P.mensaje("La salida tardía de esta reserva conserva las fechas y el precio de alojamiento acordados.", "info"));
    c.appendChild(base);
    if (iniciada && !recursosFijos) {
      campoTraslado = P.campo("Fecha del traslado", traslado, { ayuda: "Día en que pasa al recurso nuevo." });
      campoTraslado.hidden = true;
    }
    var botonBuscar = btn("Buscar titular", function () {
      return buscarTitular(dni.value.trim());
    });
    if (!checkout && !editarFechas) {
      base.appendChild(grupo("Titular", r.id ? null : "Puede ser distinto de quienes viajan.", h("div.columna", r.id ? null :
        h("div.rec-agregar", P.campo("DNI o legajo", dni, { clase: "rec-campo-ancho" }), botonBuscar), estadoTit, part)));
      base.appendChild(grupo("Estadía", "Cada reserva tiene un recurso. Para otro recurso, creá otra reserva y asignale las personas que lo usarán.", h("div.columna",
        h("div.rec-grid", P.campo("Tipo de reserva", tipo), P.campo("Servicio", serv), P.campo("Recurso", rec), campoRegimen),
        h("div.rec-grid", P.campo("Ingreso", inicio), P.campo("Salida prevista", fin), campoTraslado),
        campoUbicacion,
        contingente)));
    }
    base.appendChild(grupo(checkout ? "Personas presentes" : "Personas que viajan", checkout || editarFechas ? null :
      "Registrá el ingreso y la salida de cada persona con la fecha real. Si alguien se va otro día que el resto, cargá su salida prevista.", grupoViaje));
    if (!checkout && !editarFechas) base.appendChild(grupo("Vehículos", "Cargá cada vehículo con su patente, marca y color; el sector de estacionamiento es opcional. " +
      "Si durante la estadía llega otro auto, agregalo con su fecha de ingreso; si uno se va antes, registrá su salida.", grupoVehiculos));
    var enPredio = vehiculosPrevios.filter(function (v) { return v.en_predio; });
    if (checkout && enPredio.length) base.appendChild(grupo(enPredio.length === 1 ? "Vehículo en el predio" : "Vehículos en el predio", null,
      tabla(["Patente", "Vehículo", "Estacionamiento"], enPredio.map(function (v) { return [h("strong", v.patente), [v.marca, v.color].filter(Boolean).join(" · "), texto(v.sector)]; }))));
    if (!editarFechas) base.appendChild(gExtra);
    base.appendChild(grupo(checkout ? "Liquidación" : "Importe y observaciones", null, h("div.columna", h("div.rec-grid", !checkout && !editarFechas ? P.campo("Precio acordado ($)", manual, {
      ayuda: "En General, vacío usa la tarifa. En las otras modalidades es obligatorio; cero es gratuidad. Los alquileres se suman aparte."
    }) : null, P.campo(checkout ? "Observación de la salida" : "Motivo del cambio", motivo), !checkout && !editarFechas ? P.campo("Observaciones de la reserva", obs) : null),
      h("div.rec-pie-acciones", guardar), pre)));
    if (previo) {
      Object.keys(campos).forEach(function (clave) { if (previo.campos[clave] !== undefined) campos[clave].value = previo.campos[clave]; });
      if (titularMostrado) mostrarTitular(titularMostrado);
      else if (particularSinFicha) mostrarParticular();
    }
    recursos(previo ? previo.recurso : r.recurso_id);
    pintarPersonas();
    pintarVehiculos();
    modalidad(!!previo);
    P.continuidad.guardarPantalla(instantanea);
    if (previo && previo.desdeBorrador) c.insertBefore(P.mensaje(h("div.fila-separada",
      h("span", "Recuperamos lo que habías cargado antes de ir al catálogo de adicionales."),
      btn("Empezar de nuevo", function () { P.ruta.ir(location.hash.slice(1)); }, "texto", { chico: true })), "info"), base);
    if (previo) {
      selectFamilia.value = previo.familiarElegido;
      selectExtra.value = previo.adicionalElegido;
      if (cotizacion && (!checkout || cotizacion.resultado.salida)) pintarCotizacion(cotizacion.cuerpo, cotizacion.resultado, false);
      return;
    }
    if (accion === "extender") fin.focus();
    if (r.id && !checkout && !editarFechas) return buscarTitular(String(r.titular_dni), true);
  }
  P.ruta.registrar(/^\/recepcion\/nueva$/, function (c) {
    return get("opciones").then(function (o) {
      return formulario(c, o);
    });
  }, {
    titulo: "Nueva reserva"
  });
  P.ruta.registrar(/^\/recepcion\/(\d+)\/editar$/, function (c, p) {
    return Promise.all([get("opciones"), get("detalle", {
      id: p[0]
    })]).then(function (v) {
      return formulario(c, v[0], v[1].reserva, v[1].cuenta, P.ruta.query().accion, v[1].adicionales);
    });
  }, {
    titulo: "Editar reserva"
  });
  // ------------------------------------------------------------------ operaciones de la cuenta

  var ACC = {
    CARGA: "Cargar saldo",
    RETIRO: "Reducir saldo",
    REPARTIR: "Repartir entre integrantes",
    LIQUIDAR: "Saldar consumos y cerrar saldo",
    PAGO_RESERVA: "Cobrar diferencia de reserva"
  };
  function accionesCuenta(r, a, cargar) {
    var presentes = a.personas.filter(function (p) { return p.entrada && !p.salida; });
    var conSaldo = a.personas.filter(function (p) { return Number(p.saldo) > 0; });
    var puedeRepartir = conSaldo.some(function (p) { return presentes.some(function (otro) { return otro.id !== p.id; }); });
    var inactivo = {
      CARGA: !presentes.length && "Registrá el ingreso de un huésped para cargarle saldo.",
      RETIRO: !conSaldo.length && "No hay saldo disponible para reducir.",
      REPARTIR: !puedeRepartir && "Necesitás una persona con saldo y otro integrante presente que lo reciba.",
      LIQUIDAR: a.cierre_pendiente === false && "La cuenta está al día.",
      PAGO_RESERVA: !Number(a.pendiente) && "La reserva no tiene diferencias pendientes."
    };
    P.continuidad.registrarVentana("recepcion-operar-cuenta", function (datos) {
      if (!Object.prototype.hasOwnProperty.call(ACC, datos.accion) || inactivo[datos.accion]) return null;
      return operarCuenta(r, a, datos.accion, cargar, datos.operacion);
    });
    // Sólo se muestran las operaciones posibles: menos botones y ninguno deshabilitado sin explicación.
    var botones = Object.keys(ACC).filter(function (k) { return !inactivo[k]; }).map(function (k) {
      return btn(k === "PAGO_RESERVA" && Number(a.pendiente) < 0 ? "Devolver diferencia de reserva" : ACC[k], function () { return operarCuenta(r, a, k, cargar); },
        k === "PAGO_RESERVA" || k === "LIQUIDAR" ? "primario" : "secundario", { chico: true });
    });
    var ingresaron = a.personas.filter(function (p) { return p.entrada; });
    var termino = ingresaron.length > 0 && ingresaron.every(function (p) { return p.salida; });
    if (!botones.length) return h("p.texto-3.chico", presentes.length || termino ? "La cuenta está al día." : "Registrá el ingreso de un huésped para cargarle saldo.");
    return h("div.rec-botonera", botones);
  }
  function operarCuenta(r, a, accion, refrescar, operacion) {
    var presentes = a.personas.filter(function (p) {
      return p.entrada && !p.salida;
    });
    var repartir = accion === "REPARTIR";
    var posibles = accion === "CARGA" ? presentes : a.personas.filter(function (p) {
      return Number(p.saldo) > 0 && (!repartir || presentes.some(function (d) { return d.id !== p.id; }));
    });
    var origen = sel(lista(posibles.map(function (p) {
      return {
        id: p.id,
        nombre: p.nombre + " · " + pesos(p.saldo)
      };
    })), null, "Elegí una persona");
    if (posibles.length === 1) origen.value = posibles[0].id;
    var dest = sel([], null, "Elegí quién lo recibe"),
      imp = P.dinero({}),
      nota = input(""),
      vistaReparto = h("p.texto-2", { "aria-live": "polite", hidden: true });
    function persona(control) {
      return a.personas.find(function (p) { return String(p.id) === control.value; });
    }
    function mostrarReparto() {
      var de = persona(origen), hacia = persona(dest), importe = P.importeDe(imp.value);
      vistaReparto.hidden = !de || !hacia || !(importe > 0);
      if (!vistaReparto.hidden) vistaReparto.textContent = importe > Number(de.saldo) ?
        "El importe supera el saldo disponible." :
        "Después del reparto: " + de.nombre + ", " + pesos(Number(de.saldo) - importe) + " · " + hacia.nombre + ", " + pesos(Number(hacia.saldo) + importe) + ".";
    }
    function destinos() {
      var opciones = presentes.filter(function (p) { return String(p.id) !== origen.value; });
      P.vaciar(dest);
      dest.appendChild(h("option", { value: "" }, "Elegí quién lo recibe"));
      opciones.forEach(function (p) { dest.appendChild(h("option", { value: p.id }, p.nombre + " · " + pesos(p.saldo))); });
      if (opciones.length === 1) dest.value = opciones[0].id;
      mostrarReparto();
    }
    if (repartir) {
      origen.onchange = destinos;
      dest.onchange = imp.oninput = mostrarReparto;
      destinos();
    }
    var met = {
        EFECTIVO: MEDIOS.EFECTIVO,
        TRANSFERENCIA: MEDIOS.TRANSFERENCIA
      },
      liquidar = accion === "LIQUIDAR" || accion === "PAGO_RESERVA",
      n = accion === "LIQUIDAR" ? a.neto_consumos : a.pendiente;
    if (Number(r.afiliado)) {
      if (liquidar && n > 0) met.HABERES = MEDIOS.HABERES;else if (!liquidar) met.AL_SALIR = MEDIOS.AL_SALIR;
    }
    var medio = sel(opciones(met), accion === "LIQUIDAR" && met.HABERES ? "HABERES" : null),
      caja = sel([], null, "Elegí una caja"),
      campoCaja = P.campo("Caja de efectivo", caja);
    var cargarCajas = !repartir && (!liquidar || n) ? P.opciones("cajas").then(function (xs) {
      var asignada = P.puesto() && P.puesto().caja_id;
      if (!P.esAdmin()) xs = xs.filter(function (x) { return asignada && String(x.valor) === String(asignada); });
      xs.forEach(function (x) {
        caja.appendChild(h("option", {
          value: x.valor
        }, x.texto));
      });
      if (asignada && xs.some(function (x) { return String(x.valor) === String(asignada); })) caja.value = asignada;
      else if (xs.length === 1) caja.value = xs[0].valor;
    }).catch(P.error) : Promise.resolve();
    function actualizar() {
      campoCaja.hidden = medio.value !== "EFECTIVO" || accion === "REPARTIR" || liquidar && Number(n) === 0;
    }
    medio.onchange = actualizar;
    actualizar();
    var key = operacion || nuevaClave();
    var m = P.modal({
      reanudar: { id: "recepcion-operar-cuenta", datos: { accion: accion, operacion: key } },
      titulo: ACC[accion],
      contenido: h("div.columna", liquidar ? h("div.rec-resumen", n < 0 ? "A devolver" : n > 0 ? "A cobrar" : "Sin diferencia de dinero", h("strong", pesos(Math.abs(n)))) : grid(P.campo(repartir ? "Desde" : "Persona", origen), repartir ? P.campo("Hacia", dest) : null, P.campo("Importe ($)", imp)), repartir ? vistaReparto : liquidar && !n ? null : P.campo("Medio", medio), campoCaja, P.campo("Observación", nota), accion === "LIQUIDAR" ? P.mensaje("Se cancelarán los saldos disponibles de todos los integrantes. Solo se liquida lo consumido, descontando los anticipos.", "info") : null),
      acciones: [btn("Volver", function () {
        m.cerrar();
      }), btn("Confirmar", function () {
        var importe = P.importeDe(imp.value);
        if (!liquidar) {
          if (!persona(origen)) { origen.focus(); throw Error("Elegí la persona."); }
          if (repartir && !persona(dest)) { dest.focus(); throw Error("Elegí quién recibe el saldo."); }
          if (!(importe > 0)) { imp.focus(); throw Error("Ingresá un importe mayor que cero, con hasta dos decimales."); }
          if (accion !== "CARGA" && importe > Number(persona(origen).saldo)) { imp.focus(); throw Error("El saldo disponible no alcanza."); }
        }
        if (!campoCaja.hidden && !caja.value) { caja.focus(); throw Error(P.esAdmin() ? "Elegí la caja donde se registra el efectivo." : "Ingresá a tu caja para registrar el efectivo de recepción."); }
        return P.post("/recepcion/" + r.id + "/cuenta", {
          operacion: key,
          accion: accion,
          medio: medio.value,
          caja_id: caja.value,
          huesped_id: origen.value,
          destino_id: dest.value,
          importe: liquidar ? null : importe,
          esperado: n,
          detalle: nota.value
        }).then(function (x) {
          m.cerrar();
          if (!x.encolado) {
            if (x.comprobante) P.contable.emitido(x);
            else P.aviso(x.mensaje + (x.liquidacion_id ? " · Planilla N° " + x.liquidacion_id : ""), "ok");
            return refrescar();
          }
        });
      }, "primario")]
    });
    return cargarCajas.then(function () { return m; });
  }

  // ------------------------------------------------------------------ ubicación y vehículos sin cotizar

  var ESTADOS_ACTIVOS = ["Aprobada", "Verificada", "Iniciada", "Adjudicada"];
  function puedeAjustar(r) {
    return ESTADOS_ACTIVOS.indexOf(r.estado) >= 0 && (P.esAdmin() || !!Number((P.estado.sesion.usuario || {}).gestionar_reservas));
  }
  // Ubicación y vehículos no cambian el precio: se guardan sin revisar el importe.
  function ajustarEstadia(r, datos) {
    return P.post("/recepcion/" + r.id + "/estadia", Object.assign({ operacion: nuevaClave(), version: r.version }, datos));
  }
  function datosVehiculo(v) {
    return { patente: v.patente, marca: v.marca, color: v.color, sector: v.sector || "", entrada: v.entrada || null, salida: v.salida || null };
  }
  function editarUbicacion(r, alGuardar) {
    var campo = input(r.ubicacion);
    campo.maxLength = 120;
    campo.placeholder = "Ej.: bajo los pinos, frente al quincho";
    var guardar = btn("Guardar ubicación", function () {
      return ajustarEstadia(r, { ubicacion: campo.value.trim() }).then(function (x) {
        m.cerrar();
        if (x.encolado) return;
        P.aviso(x.sin_cambios ? x.mensaje : "Ubicación guardada.", "ok");
        return alGuardar && alGuardar();
      });
    }, "primario", { icono: "check" });
    var m = P.modal({
      titulo: "Ubicación en la parcela",
      subtitulo: "Reserva T-" + r.id + " · " + r.titular_nombre + (r.numero_parcela ? " · Parcela " + r.numero_parcela : ""),
      contenido: h("form.columna", { onsubmit: function (e) { e.preventDefault(); guardar.click(); } },
        P.campo("Dónde está la carpa", campo, { ayuda: "Dejalo vacío si todavía no se sabe." })),
      acciones: [btn("Cancelar", function () { m.cerrar(); }), guardar]
    });
    setTimeout(function () { campo.focus(); }, 30);
    return m;
  }
  P.recepcion.editarUbicacion = editarUbicacion;
  function agregarVehiculo(r, alGuardar) {
    var presentes = (r.personas || []).some(function (p) { return p.entrada && !p.salida; });
    var patente = input(""), marca = input(""), color = input(""), sector = input(""), entrada = input(presentes ? P.hoy() : "", "date");
    patente.maxLength = 20; marca.maxLength = color.maxLength = sector.maxLength = 50;
    entrada.min = r.fecha_inicio; entrada.max = P.hoy();
    var guardar = btn("Agregar vehículo", function () {
      if (!patente.value.trim() || !marca.value.trim() || !color.value.trim()) throw Error("Completá patente, marca y color. El sector es opcional.");
      var nuevo = { patente: patente.value.trim().toUpperCase(), marca: marca.value.trim(), color: color.value.trim(), sector: sector.value.trim(),
        entrada: entrada.value || null, salida: null };
      return ajustarEstadia(r, { vehiculos: (r.vehiculos || []).map(datosVehiculo).concat([nuevo]) }).then(function (x) {
        m.cerrar();
        if (x.encolado) return;
        P.aviso("Vehículo " + nuevo.patente + " agregado.", "ok");
        return alGuardar && alGuardar();
      });
    }, "primario", { icono: "mas" });
    var m = P.modal({
      titulo: "Agregar vehículo",
      subtitulo: "Reserva T-" + r.id + " · " + r.titular_nombre,
      contenido: h("form.columna", { onsubmit: function (e) { e.preventDefault(); guardar.click(); } },
        grid(P.campo("Patente", patente), P.campo("Marca", marca), P.campo("Color", color), P.campo("Sector de estacionamiento (opcional)", sector),
          P.campo("Ingreso del vehículo", entrada, { ayuda: presentes ? "Hoy, si llega ahora." : "Si queda vacío, entra con el grupo." }))),
      acciones: [btn("Cancelar", function () { m.cerrar(); }), guardar]
    });
    setTimeout(function () { patente.focus(); }, 30);
    return m;
  }
  function salidaVehiculo(r, v, alGuardar) {
    var dia = input(P.hoy(), "date");
    dia.min = v.entrada || r.fecha_inicio; dia.max = P.hoy();
    var m = P.modal({
      titulo: "Salida del vehículo " + v.patente,
      subtitulo: [v.marca, v.color].filter(Boolean).join(" · ") + " · Reserva T-" + r.id,
      contenido: h("div.columna", P.campo("Fecha de salida", dia), h("p.texto-2.chico", "Las personas de la reserva no cambian: sólo se registra que este vehículo ya no está en el predio.")),
      acciones: [btn("Cancelar", function () { m.cerrar(); }), btn("Registrar salida", function () {
        if (!dia.value) { dia.focus(); throw Error("Indicá la fecha de salida."); }
        return ajustarEstadia(r, { vehiculos: (r.vehiculos || []).map(function (x) {
          return x.patente === v.patente ? Object.assign(datosVehiculo(x), { salida: dia.value }) : datosVehiculo(x);
        }) }).then(function (x) {
          m.cerrar();
          if (x.encolado) return;
          P.aviso("Salida del vehículo " + v.patente + " registrada.", "ok");
          return alGuardar && alGuardar();
        });
      }, "primario", { icono: "check" })]
    });
    return m;
  }
  function estadoVehiculo(v) {
    return v.salida ? "Salió el " + fecha(v.salida) : v.en_predio ? P.chip("En el predio", "ABIERTO") : v.entrada ? "Ingreso " + fecha(v.entrada) : "Sin ingreso";
  }
  function seccionVehiculos(r, cargar) {
    var vehiculos = r.vehiculos || [];
    var editable = puedeAjustar(r);
    var filas = vehiculos.map(function (v) {
      var menu = editable && !v.salida ? P.btn("", { tipo: "texto", chico: true, icono: "menu", etiqueta: "Acciones del vehículo " + v.patente }) : null;
      if (menu) menu.addEventListener("click", function () {
        P.menuFlotante(menu, [
          { texto: "Registrar salida", icono: "salir", accion: function () { salidaVehiculo(r, v, cargar); } },
          { texto: "Imprimir etiqueta", icono: "qr", accion: function () { P.imprimirQRReserva(r, [v.patente]).catch(P.error); } }
        ]);
      });
      return [h("strong.rec-codigo", v.patente), texto([v.marca, v.color].filter(Boolean).join(" · ")), texto(v.sector),
        v.entrada ? fecha(v.entrada) : "Con el grupo", estadoVehiculo(v), menu || ""];
    });
    return h("div.columna",
      vehiculos.length ? tabla(["Patente", "Vehículo", "Estacionamiento", "Ingreso", "Estado", ""], filas, ".rec-tabla-vehiculos") : null,
      editable ? h("div.rec-botonera", btn("Agregar vehículo", function () { agregarVehiculo(r, cargar); }, "secundario", { chico: true, icono: "mas" })) : null);
  }

  // ------------------------------------------------------------------ detalle

  P.ruta.registrar(/^\/recepcion\/(\d+)$/, function (c, param) {
    var id = param[0];
    var recienSalida = P.ruta.query().salida === "1";
    var recienIngreso = P.ruta.query().ingreso === "1";
    var comprobanteSalida = recienSalida ? Number(P.ruta.query().comprobante) || null : null;
    function cargar() {
      return get("detalle", { id: id }).then(function (d) {
        if (!c.isConnected) return;
        var r = d.reserva,
          a = d.cuenta,
          lineas = d.adicionales || r.adicionales || [];
        var pasajeros = r.personas.map(function (p) {
          var s = a.personas.find(function (x) {
            return String(x.dni) === String(p.dni);
          });
          return [h("strong", P.textoTabla(p.apellido + ", " + p.nombre)), String(p.dni), p.entrada ? fecha(p.entrada) : "Sin ingreso",
            fecha(p.salida_prevista || r.fecha_fin), p.salida ? fecha(p.salida) : p.entrada ? P.chip("En el predio", "ABIERTO") : "—", pesos(p.precio), pesos(s ? s.saldo : 0)];
        });
        var eventos = d.historial.map(function (e) {
            return h("details.rec-evento", h("summary", P.f.fechaHora(e.fecha) + " · " + e.actor), e.motivo ? h("p", e.motivo) : null, tabla(["Campo", "Antes", "Después"], e.cambios.map(function (f) {
              return f.map(texto);
            })));
          });
        var presentes = r.personas.some(function (p) { return p.entrada && !p.salida; });
        var salieron = r.personas.some(function (p) { return p.entrada; }) && !presentes;
        var salidaReal = salieron ? r.personas.map(function (p) { return p.salida || ""; }).sort().pop() : null;
        var datosLiq = { total: r.precio_total, adicionales: lineas, cuenta: a, manual: r.manual,
          detalleAlojamiento: [nombresRecursos(r) || r.servicio, fecha(r.fecha_inicio) + " al " + fecha(salidaReal || r.fecha_fin), (r.cantidad || r.personas.length) + " personas"].join(" · ") };
        var imprimir = P.btn("Imprimir liquidación", { tipo: salieron ? "primario" : "secundario", icono: "imprimir", onclick: function (e) {
          P.ejecutar(e.currentTarget, function () { return P.imprimirComprobanteEstadia(Object.assign({ reserva: r, empresa: d.empresa, predio: (P.estado.sesion.predio || {}).nombre }, datosLiq)); }).catch(function () {});
        } });
        var acciones = [
          presentes ? btn("Registrar salida", function () { ir(id + "/editar?accion=salida"); }, "primario", { icono: "salir" }) : null,
          r.tipo !== "PASA_EL_DIA" && r.personas.some(function (p) { return !p.salida; }) ? btn("Modificar días por persona", function () { ir(id + "/editar?accion=fechas"); }) : null,
          btn("Editar reserva", function () { ir(id + "/editar"); }, "secundario", { icono: "editar" }),
          !salieron && ESTADOS_ACTIVOS.indexOf(r.estado) >= 0 ? btn("Imprimir QR", function () { return P.elegirEtiquetasQR(r); }, "secundario", { icono: "qr" }) : null,
          imprimir];
        var vencidos = lineas.filter(function (l) { return l.sin_devolver; });
        function atraso(l) { return l.dias_atraso ? " (" + l.dias_atraso + (l.dias_atraso === 1 ? " día" : " días") + " de atraso)" : ""; }
        var liq = liquidacion(datosLiq);
        P.reemplazar(c, cabecera("Reserva T-" + r.id, {
            volver: ["Reservas y estadías", "/recepcion"],
            acciones: acciones,
            subtitulo: h("span.rec-subtitulo", h("span", r.titular_nombre + " · DNI " + r.titular_dni), P.chip(r.estado, ESTADO_CHIP[r.estado] || ""))
          }),
          recienIngreso && !salieron ? P.mensaje(h("div.fila-separada", h("span", "Ingreso registrado. Imprimí el QR de la reserva para el parabrisas o la carpa: Seguridad lo escanea para ver vehículos, personas y deuda."),
            btn("Imprimir QR", function () { return P.elegirEtiquetasQR(r); }, "primario", { chico: true, icono: "qr" })), "ok") : null,
          recienSalida ? P.mensaje(h("div.fila-separada", h("span", comprobanteSalida ? "Salida registrada. El cobro de la salida quedó en su comprobante: imprimilo para el titular." :
            liq.total ? "Salida registrada. Revisá la liquidación, cobrá o devolvé lo pendiente e imprimí la liquidación." : "Salida registrada. La cuenta está saldada: podés imprimir la liquidación."),
            comprobanteSalida ? btn("Imprimir comprobante", function () { return P.contable.imprimir(comprobanteSalida, false); }, "primario", { chico: true, icono: "imprimir" }) : null), "ok") : null,
          vencida(r) ? P.mensaje("Quedan huéspedes con su fecha prevista vencida y sin salida registrada.", "aviso") : null,
          vencidos.length ? P.mensaje("Artículos sin devolver: " + vencidos.map(function (l) { return l.nombre + atraso(l); }).join(", ") + ". Registralo desde el menú de cada artículo.", "aviso") : null,
          grupo("Estadía", null, h("div.columna",
            h("div.datos.rec-datos",
              P.dato("Servicio", r.servicio), P.dato("Recurso", texto(recursoYParcela(nombresRecursos(r), r.numero_parcela))),
              r.es_parcela ? h("div.dato.rec-dato-ubicacion", h("span", "Ubicación"), h("strong", texto(r.ubicacion)),
                puedeAjustar(r) ? btn(r.ubicacion ? "Cambiar" : "Indicar ubicación", function () { editarUbicacion(r, cargar); }, "texto", { chico: true, icono: "editar" }) : null) : null,
              P.dato("Ingreso", fecha(r.fecha_inicio)), salidaReal ? P.dato("Salida", fecha(salidaReal) + (salidaReal !== r.fecha_fin ? " (prevista " + fecha(r.fecha_fin) + ")" : "")) : P.dato("Salida prevista", fecha(r.fecha_fin)),
              P.dato("Tipo", TIPOS[r.tipo] || r.tipo), P.dato("Personas", r.cantidad),
              r.entidad ? P.dato("Entidad", r.entidad) : null),
            r.observaciones ? h("p.rec-observaciones", h("strong", "Observaciones: "), r.observaciones) : null)),
          (r.vehiculos || []).length || puedeAjustar(r) ? grupo((r.vehiculos || []).length === 1 ? "Vehículo" : "Vehículos",
            (r.vehiculos || []).length ? null : "Sin vehículos registrados.", seccionVehiculos(r, cargar)) : null,
          grupo("Pasajeros", null, tabla(["Nombre", "DNI", "Ingreso", "Salida prevista", "Salida efectiva", "Estadía", "Saldo"], pasajeros)),
          grupo("Alquileres y compras", lineas.length ? null : "Sin artículos. Para sumarlos, editá la reserva.", lineas.length ? P.recepcion.tablaArticulos(r, a, lineas, cargar) : null),
          grupo("Cuenta de la estadía", null, h("div.columna", liq, accionesCuenta(r, a, cargar),
            a.movimientos.length ? h("details.rec-movimientos", { open: a.movimientos.length <= 6 ? "" : null },
              h("summary", "Movimientos de la cuenta (" + a.movimientos.length + ")"),
              tabla(["Fecha", "Movimiento", "Medio", "Importe", "Empleado y detalle"], a.movimientos.map(function (m) {
                var quien = a.personas.find(function (p) { return Number(p.id) === Number(m.huesped_id); });
                return [P.f.fechaHora(m.fecha), CONCEPTOS[m.concepto] || m.concepto, MEDIOS[m.medio] || m.medio || "—", pesos(m.importe),
                  h("div", P.textoTabla([m.usuario_nombre, quien && quien.nombre, m.detalle].filter(Boolean).join(" · ")), m.liquidacion_id ? btn("Imprimir planilla", function () {
                    return P.get("/recepcion/" + id + "/planilla/" + m.liquidacion_id).then(P.imprimirLiquidacion);
                  }, "texto", { chico: true, icono: "imprimir" }) : null)];
              }))) : null), "#rec-cuenta"),
          (d.comprobantes || []).length ? grupo("Comprobantes", "Recibos de lo cobrado y notas de crédito de lo devuelto. No son facturas.", P.contable.listaReserva(d.comprobantes)) : null,
          h("details.hoja.rec-seccion.rec-historial", h("summary", h("h2", "Historial de recepción"), h("span.texto-3.chico", eventos.length ? eventos.length + (eventos.length === 1 ? " cambio" : " cambios") : "Sin cambios desde el predio")),
            eventos.length ? h("div.columna", h("p.texto-3.chico", "Cada operación conserva el empleado, la fecha y los valores anteriores y nuevos."), eventos) : null));
        if (recienSalida) {
          var cuentaEl = document.getElementById("rec-cuenta");
          if (cuentaEl && cuentaEl.scrollIntoView) setTimeout(function () { cuentaEl.scrollIntoView({ block: "start" }); }, 60);
        }
      });
    }
    return cargar();
  }, {
    titulo: "Detalle de estadía"
  });
})();
