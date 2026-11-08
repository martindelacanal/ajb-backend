/* Stock entre bocas: solicitudes (pedir, despachar, recibir), traspasos directos, bajas,
   stock por boca y las ventas del cajero. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  var MOTIVOS = [
    { valor: "ROTURA", texto: "Rotura" }, { valor: "VENCIMIENTO", texto: "Vencimiento" }, { valor: "MATERIA_PRIMA", texto: "Materia prima" },
    { valor: "INSUMO", texto: "Insumo" }, { valor: "OTROS", texto: "Otros motivos" },
  ];

  function misBocas() { return (P.estado.sesion.usuario.bocas || []).map(Number); }

  // ------------------------------------------------------------------ formulario de solicitud / traspaso
  // modo: "pedido" (cualquier usuario, con autorización), "traspaso" (admin: se mueve en el momento)
  P.formSolicitud = function (modo, alTerminar, autorizacion) {
    var esTraspaso = modo === "traspaso";
    Promise.all([P.opciones("bocas_origen"), P.opciones("bocas_destino")]).then(function (r) {
      var origenes = r[0], destinos = r[1];
      var puesto = P.puesto() || {};
      var almacen = origenes.filter(function (b) { return b.es_almacen; })[0];
      var origenDefecto = almacen ? almacen.valor : (origenes[0] || {}).valor;
      var destinoDefecto = puesto.boca_id && destinos.some(function (d) { return d.valor === puesto.boca_id; }) && puesto.boca_id !== origenDefecto ? puesto.boca_id : null;
      var origen = P.select(origenes, origenDefecto);
      var destino = P.select(destinos, destinoDefecto, { vacio: "Elegí el destino" });
      var lineas = [];
      var elegido = null;
      var disponible = h("div.campo-ayuda");
      var cantidad = P.input({ inputmode: "decimal", valor: "1" });
      cantidad.style.width = "100px";
      var combo = P.comboProducto({
        abrirAlEnfocar: false,
        placeholder: "Escaneá o buscá el producto",
        bocaId: function () { return Number(origen.value); }, mostrarStock: true,
        alCambiarTexto: function () { elegido = null; disponible.textContent = ""; },
        alElegir: function (o) { elegido = o.dato; mostrarDisponible(); cantidad.focus(); cantidad.select(); },
      });
      function mostrarDisponible() {
        if (!elegido) { disponible.textContent = ""; return; }
        var productoConsultado = elegido, origenConsultado = origen.value;
        var nombreOrigen = origen.options[origen.selectedIndex].textContent;
        disponible.textContent = "Consultando stock…";
        P.get("/stock/disponible" + P.qs({ boca_id: origen.value, producto_id: elegido.id })).then(function (x) {
          if (elegido !== productoConsultado || origen.value !== origenConsultado) return;
          elegido.disponible = x.cantidad;
          disponible.textContent = "Disponible en " + nombreOrigen + ": " + P.f.numero(x.cantidad);
          disponible.style.color = x.cantidad <= 0 ? "var(--error)" : "";
        }).catch(function () { disponible.textContent = ""; });
      }
      origen.addEventListener("change", function () {
        if (elegido) elegido.disponible = undefined;
        var id = origen.value;
        lineas.forEach(function (l) {
          l.disponible = undefined;
          P.get("/stock/disponible" + P.qs({ boca_id: id, producto_id: l.producto.id })).then(function (r) {
            if (origen.value === id) { l.disponible = r.cantidad; pintar(); }
          }).catch(P.error);
        });
        mostrarDisponible(); pintar();
      });
      var lista = h("div.tabla-desplazable");
      function agregar() {
        if (!elegido) { combo.foco(); return; }
        var n = P.numeroDe(cantidad.value);
        if (!(n > 0)) { cantidad.focus(); return; }
        var ex = lineas.filter(function (l) { return l.producto.id === elegido.id; })[0];
        if (ex) ex.cantidad = P.redondear(ex.cantidad + n, 3);
        else lineas.push({ producto: elegido, cantidad: n, disponible: elegido.disponible });
        elegido = null;
        combo.limpiar();
        cantidad.value = "1";
        disponible.textContent = "";
        pintar();
        combo.foco();
      }
      cantidad.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); agregar(); } });
      function pintar() {
        P.vaciar(lista);
        if (!lineas.length) { lista.appendChild(h("p.texto-3", "Agregá los productos de a uno (podés usar el escáner).")); return; }
        lista.appendChild(h("table.tabla", h("thead", h("tr", h("th", "Producto"), h("th.der", "Cantidad"), h("th.der", "Disponible en origen"), h("th"))),
          h("tbody", lineas.map(function (l, i) {
            var falta = l.disponible !== undefined && l.cantidad > l.disponible;
            return h("tr", h("td", h("strong", l.producto.nombre)), h("td.der", P.f.numero(l.cantidad)),
              h("td.der" + (falta ? ".negativo" : ""), l.disponible === undefined ? "—" : P.f.numero(l.disponible) + (falta ? " (no alcanza)" : "")),
              h("td.acciones", P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Quitar", onclick: function () { lineas.splice(i, 1); pintar(); } })));
          }))));
      }
      pintar();
      var baja = P.check("Dar de baja automáticamente en el stock", false, "Para destinos que consumen todo (por ejemplo, Limpieza): al recibirlo se descuenta del stock del destino.");
      var obs = P.input({ max: 250, placeholder: "Opcional" });
      var m = P.modal({
        titulo: esTraspaso ? "Traspaso entre bocas" : "Pedir productos",
        subtitulo: esTraspaso ? "Mueve el stock en el momento: queda despachado y recibido." : "El producto sale de la boca de origen y llega a la de destino. Origen lo despacha; destino confirma que lo recibió.",
        ancho: "ancha",
        contenido: h("div.columna",
          h("div.grilla.grilla-2", P.campo("Sale de (boca de origen)", origen), P.campo("Llega a (boca de destino)", destino)),
          h("div.fila-campos", P.campo("Producto", h("div", combo.el, disponible), { clase: "crece" }), P.campo("Cantidad", cantidad, { ayuda: "Ej.: 0,5 para media unidad." }),
            h("div.campo", h("span.campo-etiqueta", " "), P.btn("Agregar", { tipo: "celeste", icono: "mas", onclick: agregar }))),
          lista,
          P.esAdmin() ? baja : null,
          P.campo("Observaciones", obs)),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn(esTraspaso ? "Registrar traspaso" : "Enviar solicitud", { tipo: "primario", icono: esTraspaso ? "traspaso" : "despachar", onclick: function (ev) {
          if (elegido && P.numeroDe(cantidad.value) > 0) agregar();
          if (!destino.value) { P.aviso("Elegí la boca de destino", "error"); destino.focus(); return; }
          if (!lineas.length) { P.aviso("Agregá al menos un producto", "error"); return; }
          var cuerpo = Object.assign({
            boca_origen_id: Number(origen.value), boca_destino_id: Number(destino.value), baja_automatica: baja.input.checked, observaciones: obs.value,
            lineas: lineas.map(function (l) { return { producto_id: l.producto.id, cantidad: l.cantidad }; }),
          }, autorizacion || {});
          P.ejecutar(ev.currentTarget, function () {
            return P.conConfirmacionStock(function (confirmar) {
              return P.post(esTraspaso ? "/traspasos" : "/solicitudes", Object.assign({}, cuerpo, esTraspaso ? { confirmar_fraccionado: confirmar } : { confirmar_sin_stock: confirmar }));
            }, esTraspaso ? "Confirmar saldo negativo" : "Pedir igual").then(function (x) {
              if (!x.encolado) P.aviso(x.mensaje, "ok");
              m.cerrar();
              if (alTerminar) alTerminar();
            });
          }).catch(function () {});
        } })],
      });
    }).catch(P.error);
  };

  P.pedirProductos = function (alTerminar) {
    P.autorizar("SOLICITUD_PRODUCTO", {}).then(function (aut) { P.formSolicitud("pedido", alTerminar, aut); }).catch(function (e) { if (e.status !== -1) P.error(e); });
  };

  P.formAjusteStock = function (alta, alTerminar) {
    P.opciones("bocas").then(function (bocas) {
      var almacen = bocas.filter(function (b) { return b.es_almacen; })[0];
      var boca = P.select(bocas, almacen ? almacen.valor : null);
      var elegido = null;
      var disp = h("div.campo-ayuda");
      var combo = P.comboProducto({
        abrirAlEnfocar: false, bocaId: function () { return Number(boca.value); }, mostrarStock: true,
        alCambiarTexto: function () { elegido = null; disp.textContent = ""; },
        alElegir: function (o) { elegido = o.dato; disp.textContent = "Stock en la boca: " + P.f.numero(o.dato.stock_boca); cantidad.focus(); },
      });
      var cantidad = P.input({ inputmode: "decimal", valor: "1" });
      var motivo = alta ? P.select([{ valor: "DONACION", texto: "Donación" }, { valor: "RECUENTO", texto: "Diferencia de recuento" }, { valor: "OTROS", texto: "Otro motivo" }], "DONACION") : P.select(MOTIVOS, "VENCIMIENTO");
      var obs = P.input({ max: 250, placeholder: alta ? "Ej.: caja donada por un proveedor" : "Ej.: botella rota en el traslado" });
      boca.addEventListener("change", function () { elegido = null; disp.textContent = ""; combo.limpiar(); });
      var m = P.modal({
        titulo: alta ? "Sumar stock" : "Bajar stock",
        subtitulo: alta ? "Indicá cuántas unidades ingresaron a la boca." : "Para productos que se rompieron, vencieron o se usaron como materia prima o insumo.",
        contenido: h("div.columna", P.campo("Boca", boca), P.campo("Producto", h("div", combo.el, disp)), P.campo("Cantidad", cantidad, { ayuda: "Ej.: 0,5 para media unidad." }), P.campo("Motivo", motivo), P.campo("Observaciones", obs)),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn(alta ? "Registrar alta" : "Dar de baja", { tipo: alta ? "primario" : "peligro-lleno", icono: alta ? "mas" : "baja", onclick: function (ev) {
          if (!elegido) { P.aviso("Elegí el producto", "error"); combo.foco(); return; }
          var cuerpo = { boca_id: Number(boca.value), producto_id: elegido.id, cantidad: P.numeroDe(cantidad.value), motivo: motivo.value, observaciones: obs.value };
          P.ejecutar(ev.currentTarget, function () {
            return P.post(alta ? "/altas" : "/bajas", cuerpo).then(function (r) {
              if (!r.encolado) P.aviso(r.mensaje, "ok");
              m.cerrar();
              if (alTerminar) alTerminar();
            });
          }).catch(function () {});
        } })],
      });
    }).catch(P.error);
  };

  // ------------------------------------------------------------------ vista de solicitudes
  P.vistaSolicitudes = function (c, opciones) {
    opciones = opciones || {};
    var puesto = P.puesto() || {};
    var vista = P.cache["solicitudes:vista"] || "todas";
    var zona = h("div", { style: { marginTop: "14px" } });
    var tabla = null;
    function filtrosDe(v) {
      if (v === "despachar") return Object.assign({ estado: "PENDIENTE" }, !P.esAdmin() && puesto.boca_id ? { origen: String(puesto.boca_id) } : {});
      if (v === "recibir") return Object.assign({ estado: "DESPACHADA" }, !P.esAdmin() && puesto.boca_id ? { destino: String(puesto.boca_id) } : {});
      if (v === "no_recibidas") return { recibida: "0" };
      return {};
    }
    function acciones(f, recargar) {
      var mias = misBocas();
      var botones = [];
      if (f.estado === "PENDIENTE" && (P.esAdmin() || mias.indexOf(f.boca_origen_id) >= 0)) {
        botones.push(P.btn("Despachar", { tipo: "primario", chico: true, icono: "despachar", onclick: function (ev) { despachar(ev.currentTarget, f, recargar); } }));
        botones.push(P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Rechazar", onclick: function () { cambiar(f, "rechazar", recargar); } }));
      }
      if (f.estado === "DESPACHADA" && (P.esAdmin() || mias.indexOf(f.boca_destino_id) >= 0)) {
        botones.push(P.btn("Recibí", { tipo: "ok", chico: true, icono: "recibir", onclick: function (ev) {
          P.ejecutar(ev.currentTarget, function () { return P.post("/solicitudes/" + f.id + "/recibir", {}).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); recargar(); }); }).catch(function () {});
        } }));
      }
      return botones;
    }
    function despachar(boton, f, recargar) {
      var cant = P.input({ inputmode: "decimal", valor: P.f.numero(f.cantidad) });
      var m = P.modal({
        titulo: "Despachar solicitud N° " + f.id, subtitulo: f.producto + " · de " + f.origen + " a " + f.destino,
        contenido: P.campo("Cantidad que despachás", cant, { ayuda: "Si no alcanza, podés mandar menos de lo pedido." }),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Despachar", { tipo: "primario", icono: "despachar", onclick: function (ev) {
          P.ejecutar(ev.currentTarget, function () {
            return P.conConfirmacionStock(function (confirmar) {
              return P.post("/solicitudes/" + f.id + "/despachar", { cantidad: P.numeroDe(cant.value), confirmar_fraccionado: confirmar });
            }, "Confirmar saldo negativo").then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); m.cerrar(); recargar(); });
          }).catch(function () {});
        } })],
      });
    }
    function cambiar(f, accion, recargar) {
      P.pedirTexto(accion === "rechazar" ? "Rechazar la solicitud N° " + f.id : "Anular la solicitud N° " + f.id, { etiqueta: "Motivo", aceptar: accion === "rechazar" ? "Rechazar" : "Anular", peligro: true }).then(function (motivo) {
        if (motivo === null) return;
        P.post("/solicitudes/" + f.id + "/" + accion, { motivo: motivo }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); recargar(); }).catch(P.error);
      });
    }
    function pintar() {
      tabla = P.tabla({
        listado: "solicitudes", claveEstado: "solicitudes-" + vista, filtrosIniciales: filtrosDe(vista),
        acciones: acciones,
        tituloVacio: vista === "despachar" ? "No hay nada para despachar" : vista === "recibir" ? "No hay nada en camino" : "No hay solicitudes",
      });
      P.reemplazar(zona, tabla.el);
    }
    c.appendChild(P.segmentado([
      { valor: "despachar", texto: "Para despachar" }, { valor: "recibir", texto: "Para recibir" }, { valor: "no_recibidas", texto: "No recibidas" }, { valor: "todas", texto: "Todas" },
    ], vista, function (v) { vista = v; P.cache["solicitudes:vista"] = v; pintar(); }));
    c.appendChild(zona);
    pintar();
    P.alAvisos = function () { if (tabla && (vista === "despachar" || vista === "recibir")) tabla.recargar(); };
    P.alSalir(function () { P.alAvisos = null; });
    return { recargar: function () { if (tabla) tabla.recargar(); } };
  };

  P.ruta.registrar(/^\/solicitudes$/, function (c) {
    var v = null;
    c.appendChild(h("div.pagina-cabecera",
      h("div", h("h1.titulo-pagina", "Solicitudes"), h("p.subtitulo", "Pedidos de productos entre bocas. La boca de origen despacha y la de destino confirma que lo recibió.")),
      h("div.pagina-acciones", P.btn("Pedir productos", { tipo: "primario", icono: "mas", onclick: function () { P.pedirProductos(function () { v.recargar(); }); } }))));
    v = P.vistaSolicitudes(c);
  }, { titulo: "Solicitudes" });

  P.ruta.registrar(/^\/stock$/, function (c) {
    var puesto = P.puesto() || {};
    c.appendChild(h("div.pagina-cabecera", h("div", h("h1.titulo-pagina", "Stock"), h("p.subtitulo", "Lo que figura en el sistema para tus bocas."))));
    c.appendChild(P.tabla({ listado: "stock", claveEstado: "stock-cajero-" + (puesto.boca_id || "todas"),
      filtrosIniciales: puesto.boca_id ? { boca: String(puesto.boca_id) } : {}, celdas: { cantidad: P.cantidadPorBoca } }).el);
  }, { titulo: "Stock" });

  // ------------------------------------------------------------------ mis ventas (cajero)
  function puedeAnular() {
    return P.esAdmin() || !!Number(P.estado.sesion.usuario.puede_anular_ticket);
  }

  P.anularVenta = function (f, alTerminar) {
    var directa = puedeAnular();
    var pedido = f.solicitud_anulacion;
    var titulo = (directa ? "Anular la venta N° " : "Solicitar anulación de la venta N° ") + f.id;
    var nota = directa ? "Si se cobró en efectivo, la devolución se registra en " + f.caja + "." : "El administrador revisará la venta y el motivo del pedido.";
    P.pedirTexto(titulo, { etiqueta: "Motivo", requerido: true, valor: pedido ? pedido.detalle : "", aceptar: directa ? "Confirmar anulación" : "Enviar pedido",
      peligro: directa, subtitulo: "Total " + P.f.pesos(f.total) + ". " + nota }).then(function (motivo) {
      if (!motivo) return;
      var accion = directa ? P.post("/ventas/" + f.id + "/anular", { motivo: motivo, solicitud_id: pedido && pedido.id })
        : P.post("/permisos", { tipo: "ANULAR_VENTA", referencia_id: f.id, detalle: motivo });
      accion.then(function (r) {
        if (!r.encolado) P.aviso(r.mensaje + (r.devolver_efectivo ? ". Corresponde devolver " + P.f.pesos(r.devolver_efectivo) + " en efectivo." : ""), "ok", 8000);
        if (alTerminar) alTerminar();
        if (P.consultarAvisos) P.consultarAvisos();
      }).catch(P.error);
    });
  };

  P.verVenta = function (id, alCambiar) {
    P.get("/ventas/" + id).then(function (d) {
      var v = d.venta;
      var pedido = v.solicitud_anulacion;
      var accion = puedeAnular() ? (pedido ? "Confirmar anulación" : "Anular ticket") : "Solicitar anulación";
      var m = P.modal({
        titulo: "Venta N° " + v.id, subtitulo: P.f.fechaHora(v.fecha) + " · " + v.boca + " · " + v.caja + " · " + v.usuario_nombre,
        ancho: "ancha",
        contenido: h("div.columna",
          v.estado === "ANULADA" ? P.mensaje("Anulada por " + v.anulada_por + " el " + P.f.fechaHora(v.anulada_fecha) + ": " + (v.anulacion_motivo || ""), "error") : null,
          pedido ? P.mensaje("Pendiente de anulación. " + pedido.usuario_nombre + " la solicitó el " + P.f.fechaHora(pedido.fecha_solicitud) + ". Motivo: " + (pedido.detalle || "Sin detalle"), "aviso") : null,
          h("div.tabla-desplazable", h("table.tabla", h("thead", h("tr", h("th", "Producto"), h("th.der", "Cantidad"), h("th.der", "Unitario"), h("th.der", "Subtotal"))),
            h("tbody", d.items.map(function (i) { return h("tr", h("td", i.descripcion), h("td.der", P.f.numero(i.cantidad)), h("td.der", P.f.pesos(i.precio_unitario)), h("td.der", P.f.pesos(i.subtotal))); })),
            h("tfoot", h("tr", h("td", { colspan: "3" }, "Total"), h("td.der", P.f.pesos(v.total)))))),
          h("div.datos",
            P.dato("Forma de pago", P.FORMAS[v.forma_pago] || v.forma_pago), v.codigo_pago ? P.dato("Código de pago", v.codigo_pago) : null,
            v.forma_pago === "EFECTIVO" ? P.dato("Recibido / vuelto", P.f.pesos(v.recibido) + " / " + P.f.pesos(v.vuelto)) : null,
            d.afiliado ? P.dato("Afiliado", d.afiliado.nombre + (d.afiliado.legajo ? " · Leg. " + d.afiliado.legajo : "")) : null,
            P.dato("Tickets impresos", String(v.impresiones || 0)))),
        acciones: [
          v.estado !== "ANULADA" && (!pedido || puedeAnular()) ? P.btn(accion, { tipo: puedeAnular() ? "peligro" : "secundario", icono: "borrar", onclick: function () { m.cerrar(); P.anularVenta(v, alCambiar); } }) : null,
          P.btn("Imprimir ticket", { tipo: "primario", icono: "imprimir", onclick: function () { P.reimprimirVenta(v.id); } }),
        ],
      });
    }).catch(P.error);
  };

  function tablaVentasCaja(clave, alcance, alError) {
    var tabla = P.tabla({
      listado: "ventas", claveEstado: clave, filtrosFijos: alcance, filtrosOcultos: ["boca", "caja", "usuario"],
      columnasOcultas: ["boca"],
      alClickFila: function (f) { P.verVenta(f.id, tabla.recargar); },
      alError: alError,
    });
    return tabla;
  }

  P.ruta.registrar(/^\/caja\/(\d+)\/ventas$/, function (c, params) {
    var cajaId = params[0];
    return P.get("/cajas/" + cajaId).then(function (d) {
      c.appendChild(h("div.pagina-cabecera", h("div",
        h("a.volver", { href: "#/caja/" + cajaId }, P.icono("volver"), "Volver a la caja"),
        h("h1.titulo-pagina", "Ventas de " + d.caja.nombre))));
      c.appendChild(tablaVentasCaja("ventas-caja-" + cajaId, { f_caja: cajaId }).el);
    });
  }, { cajas: true, titulo: "Ventas de la caja" });

  P.ruta.registrar(/^\/mis-ventas$/, function (c) {
    var ambito = "turno";
    var zona = h("div", { style: { marginTop: "14px" } });
    var selector = P.segmentado([{ valor: "turno", texto: "Mi turno" }, { valor: "caja", texto: "Todas las de la caja" }], ambito, function (v) {
      if (v === "caja" && !P.puedeGestionarCajas()) {
        P.conAutorizacion("VER_VENTAS_CAJA", { detalle: "Ver todas las ventas de la caja" }, function (aut) { return P.post("/ventas/ver-caja", aut); })
          .then(function () { ambito = "caja"; pintar(); })
          .catch(function (e) { selector.fijar(ambito); if (e.status !== -1) P.error(e); });
        return;
      }
      ambito = v;
      pintar();
    });
    if (!P.puedeGestionarCajas()) selector.setAttribute("data-sin-reanudar", "");
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/mi-caja" }, P.icono("volver"), "Volver a la caja"),
      h("h1.titulo-pagina", "Mis ventas"), h("p.subtitulo", "Tocá una venta para ver el detalle, reimprimir el ticket o gestionar su anulación."))));
    c.appendChild(selector);
    c.appendChild(zona);
    function pintar() {
      var tabla = tablaVentasCaja("mis-ventas-" + ambito, { ambito: ambito }, function (e) {
        if (e.codigo === "SIN_AUTORIZACION") { ambito = "turno"; selector.fijar("turno"); pintar(); }
      });
      P.reemplazar(zona, tabla.el);
    }
    pintar();
  }, { titulo: "Mis ventas", local: true });
})();
