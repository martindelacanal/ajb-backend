/* Compras: ingreso de stock por factura y revisión opcional de precios de venta. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  function puedeComprar() {
    if (P.esAdmin()) return true;
    return (P.estado.sesion.puestos || []).some(function (p) { return p.es_almacen; });
  }

  P.verCompra = function (id, alCambiar) {
    P.get("/compras/" + id).then(function (d) {
      var c = d.compra;
      var m = P.modal({
        titulo: "Compra N° " + c.id, subtitulo: c.proveedor + (c.factura ? " · Factura " + c.factura : "") + (c.remito ? " · Remito " + c.remito : ""),
        ancho: "ancha",
        contenido: h("div.columna",
          c.estado === "ANULADA" ? P.mensaje("Compra anulada el " + P.f.fechaHora(c.anulada_fecha) + " por " + c.anulada_por + ": " + (c.anulacion_motivo || ""), "error") : null,
          h("div.datos",
            P.dato("Fecha de factura", P.f.fecha(c.fecha_factura)), P.dato("Fecha de remito", P.f.fecha(c.fecha_remito)),
            P.dato("Total de la factura", P.f.pesos(c.total_factura)), P.dato("Recibió", c.boca), P.dato("Cargó", c.creado_por + " · " + P.f.fechaHora(c.fecha_creacion))),
          h("div.tabla-desplazable", h("table.tabla",
            h("thead", h("tr", h("th", "Producto"), h("th.der", "Cantidad"), h("th.der", "Unitario"), h("th.der", "Anterior"), h("th.der", "Margen"), h("th.der", "Venta"), h("th.der", "Total"))),
            h("tbody", d.items.map(function (i) {
              return h("tr", h("td", h("strong", i.producto), h("div.texto-3.chico", i.codigo || "")), h("td.der", P.f.numero(i.cantidad)), h("td.der", P.f.pesos(i.precio_unitario)),
                h("td.der.texto-3", P.f.pesos(i.precio_anterior)), h("td.der", P.f.pct(i.margen)),
                h("td.der", P.f.pesos(i.precio_venta), h("div.texto-3.chico", Number(i.actualizo_precio) ? "Actualizado" : "Conservado")), h("td.der.fuerte", P.f.pesos(i.subtotal)));
            })),
            h("tfoot", h("tr", h("td", { colspan: "6" }, "Total"), h("td.der", P.f.pesos(c.total_items)))))),
          c.observaciones ? P.mensaje(c.observaciones) : null),
        acciones: [
          P.esAdmin() && c.estado !== "ANULADA" ? P.btn("Anular compra", { tipo: "peligro", icono: "borrar", onclick: function () {
            P.pedirTexto("Anular la compra N° " + c.id, { etiqueta: "Motivo", requerido: true, aceptar: "Anular", peligro: true, subtitulo: "Se descontará el stock ingresado. Se restaurarán los precios que todavía dependan de esta compra." }).then(function (motivo) {
              if (!motivo) return;
              P.post("/compras/" + c.id + "/anular", { motivo: motivo }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); m.cerrar(); if (alCambiar) alCambiar(); }).catch(P.error);
            });
          } }) : null,
          P.btn("Imprimir", { tipo: "secundario", icono: "imprimir", onclick: function () { P.imprimirCompra(d).catch(P.error); } }),
        ],
      });
    }).catch(P.error);
  };

  P.ruta.registrar(/^\/compras$/, function (c) {
    c.appendChild(P.cabeceraConAcciones("Compras", null,
      puedeComprar() ? P.btn("Cargar compra", { tipo: "primario", icono: "mas", onclick: function () { P.ruta.ir("/compras/nueva"); } }) : null));
    var vista = P.cache["compras:vista"] || "compras";
    var zona = h("div", { style: { marginTop: "14px" } });
    c.appendChild(P.segmentado([{ valor: "compras", texto: "Compras" }, { valor: "productos", texto: "Compras por producto" }], vista, function (v) { vista = v; P.cache["compras:vista"] = v; pintar(); }));
    c.appendChild(zona);
    function pintar() {
      var t = vista === "compras"
        ? P.tabla({ listado: "compras", alClickFila: function (f) { P.verCompra(f.id, function () { t.recargar(); }); }, tituloVacio: "Todavía no hay compras", textoVacio: "Cargá la primera con «Cargar compra»." })
        : P.tabla({ listado: "compras_productos", alClickFila: function (f) { P.verCompra(f.compra_id); } });
      P.reemplazar(zona, t.el);
    }
    pintar();
  }, { titulo: "Compras" });

  // ------------------------------------------------------------------ nueva compra
  P.ruta.registrar(/^\/compras\/nueva$/, function (c) {
    if (!puedeComprar()) { c.appendChild(P.vacio("candado", "Las compras las carga la proveeduría o un administrador", "")); return; }
    var CLAVE = "predio.compra-borrador";
    var estado = { proveedor: null, factura: "", fecha_factura: P.hoy(), remito: "", fecha_remito: "", total_factura: "", observaciones: "", lineas: [] };
    try { var b = JSON.parse(sessionStorage.getItem(CLAVE) || "null"); if (b && b.lineas) estado = Object.assign(estado, b); } catch (e) { /* nada */ }
    function guardar() { try { sessionStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (e) { /* nada */ } }

    var destinoStock = h("div.texto-3");
    P.opciones("bocas", true).then(function (bocas) {
      var destino = bocas.find(function (boca) { return boca.es_almacen; });
      destinoStock.textContent = destino ? "Proveeduría que recibe el stock: " + destino.texto : "Falta elegir la proveeduría en Gestión → Bocas y cajas.";
    }).catch(P.error);
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/compras" }, P.icono("volver"), "Compras"),
      h("h1.titulo-pagina", "Cargar compra"))));

    // Factura
    var proveedor = P.combo({
      fuente: "proveedores", placeholder: "Elegí o escribí el proveedor",
      valor: estado.proveedor ? estado.proveedor.valor : null, texto: estado.proveedor ? estado.proveedor.texto : "",
      alElegir: function (o) { estado.proveedor = { valor: o.valor, texto: o.texto }; guardar(); },
      accionExtra: P.esAdmin() ? { texto: "Nuevo proveedor", onclick: function (texto) {
        P.formProveedor({ razon_social: texto }, function (r) {
          P.olvidarOpciones();
          estado.proveedor = { valor: r.id, texto: r.razon_social };
          proveedor.fijar(r.id, r.razon_social);
          guardar();
        });
      } } : null,
    });
    function campoTexto(clave, opciones) {
      var i = P.input(Object.assign({ valor: estado[clave] }, opciones || {}));
      i.addEventListener("input", function () { estado[clave] = i.value; guardar(); pintarResumen(); });
      return i;
    }
    var totalFactura = campoTexto("total_factura", { inputmode: "decimal", placeholder: "0,00" });
    totalFactura.style.textAlign = "right";
    c.appendChild(h("div.hoja.hoja-cuerpo", h("h2.seccion-titulo", "Factura"),
      h("div.grilla.grilla-3", { style: { marginTop: "14px" } },
        P.campo("Proveedor", h("div.fila", { style: { flexWrap: "nowrap", gap: "6px" } }, h("div.espacio", proveedor.el),
          P.esAdmin() ? P.btn("", { tipo: "secundario", icono: "mas", etiqueta: "Nuevo proveedor", onclick: function () {
            P.formProveedor({}, function (r) { P.olvidarOpciones(); estado.proveedor = { valor: r.id, texto: r.razon_social }; proveedor.fijar(r.id, r.razon_social); guardar(); });
          } }) : null), { requerido: true }),
        P.campo("Factura", campoTexto("factura", { placeholder: "Ej.: A-0002-00012345", max: 40 })),
        P.campo("Fecha de la factura", campoTexto("fecha_factura", { tipo: "date" })),
        P.campo("Remito", campoTexto("remito", { placeholder: "N° de remito", max: 40 })),
        P.campo("Fecha del remito", campoTexto("fecha_remito", { tipo: "date" })),
        P.campo("Total de la factura", h("div.campo-con-prefijo", h("span", "$"), totalFactura), { requerido: true, ayuda: "Se compara con la suma de los productos." })),
      h("div", { style: { marginTop: "14px" } }, P.campo("Observaciones", campoTexto("observaciones", { placeholder: "Opcional", max: 500 })))));

    // Agregar productos
    var cantidad = P.input({ inputmode: "decimal", placeholder: "Cant.", valor: "1" });
    cantidad.style.width = "90px";
    var unitario = P.dinero({ placeholder: "Unitario" });
    unitario.style.width = "130px";
    var ayudaProducto = h("div.campo-ayuda");
    var elegido = null;
    var combo = P.comboProducto({
      ladoCompra: true, limpiarAlElegir: false, abrirAlEnfocar: false,
      placeholder: "Escaneá o buscá el producto",
      alCambiarTexto: function () { elegido = null; ayudaProducto.textContent = ""; },
      alElegir: function (o) {
        elegido = o.dato;
        ayudaProducto.textContent = "Costo de referencia: " + P.f.pesos(elegido.precio_compra) + " · Venta general: " + P.f.pesos(elegido.precio_venta);
        unitario.value = P.f.numero(elegido.ultimo_costo != null ? elegido.ultimo_costo : elegido.precio_compra);
        cantidad.focus();
        cantidad.select();
      },
      alEnterSinCoincidencia: function (t) {
        if (!t) return;
        if (P.esAdmin()) {
          P.confirmar("No hay un producto con «" + t + "». ¿Lo creás ahora?", { aceptar: "Crear producto" }).then(function (ok) {
            if (ok) nuevoProducto(/^\d{4,}$/.test(t) ? { codigo: t } : { nombre: t });
          });
        } else P.aviso("No encontramos «" + t + "». Pedile al administrador que lo cree.", "error");
      },
    });
    function nuevoProducto(base) {
      P.formProducto(base || {}, function (r) {
        P.get("/productos/buscar" + P.qs({ q: r.codigo || r.nombre })).then(function (lista) {
          var p = lista.filter(function (x) { return x.id === r.id; })[0] || lista[0];
          if (p) { combo.fijar(p.id, p.nombre, { dato: p }); elegido = p; ayudaProducto.textContent = "Producto nuevo. Cargá cantidad y precio unitario."; cantidad.focus(); }
        });
      });
    }
    function agregarLinea() {
      if (!elegido) { P.aviso("Elegí un producto", "error"); combo.foco(); return; }
      var cant = P.numeroDe(cantidad.value);
      var precio = P.importeDe(unitario.value);
      if (!(cant > 0)) { P.aviso("La cantidad tiene que ser mayor que cero", "error"); cantidad.focus(); return; }
      if (!(precio >= 0)) { P.aviso("Cargá el precio unitario", "error"); unitario.focus(); return; }
      var existente = estado.lineas.filter(function (l) { return l.producto.id === elegido.id; })[0];
      if (existente) { existente.cantidad = P.redondear(existente.cantidad + cant, 3); existente.precio_unitario = precio; existente.producto = elegido; }
      else estado.lineas.push({ producto: elegido, cantidad: cant, precio_unitario: precio });
      elegido = null;
      combo.limpiar();
      cantidad.value = "1";
      unitario.value = "";
      ayudaProducto.textContent = "";
      guardar();
      pintarLineas();
      combo.foco();
    }
    [cantidad, unitario].forEach(function (i) { i.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); if (i === cantidad) unitario.focus(); else agregarLinea(); } }); });

    var tablaLineas = h("div");
    var resumen = h("div");
    var problemas = h("div");
    c.appendChild(h("div.hoja.hoja-cuerpo",
      h("div.fila-separada", h("h2.seccion-titulo", "Productos"),
        P.esAdmin() ? P.btn("Nuevo producto", { tipo: "secundario", chico: true, icono: "mas", onclick: function () { nuevoProducto({}); } }) : null),
      h("div.fila-campos", { style: { marginTop: "14px" } },
        P.campo("Producto", h("div", combo.el, ayudaProducto), { clase: "crece" }),
        P.campo("Cantidad", cantidad), P.campo("Precio unitario", h("div.campo-con-prefijo", h("span", "$"), unitario)),
        h("div.campo", h("span.campo-etiqueta", " "), P.btn("Agregar", { tipo: "celeste", icono: "mas", onclick: agregarLinea }))),
      h("div.compra-lineas", tablaLineas)));
    var revisarCompra = P.btn("Revisar compra", { tipo: "primario", grande: true, icono: "check", id: "cargar-compra", onclick: revisar });
    c.appendChild(h("div.compra-resumen",
      h("div.columna", destinoStock, problemas),
      h("div.columna", resumen, revisarCompra)));

    function oferta(linea) {
      var ultimo = linea.producto.ultimo_costo;
      if (ultimo != null && linea.precio_unitario < Number(ultimo)) return "Costo menor al de la última compra (" + P.f.pesos(ultimo) + ").";
      if (linea.precio_unitario < Number(linea.producto.precio_compra)) return "Costo menor al de referencia (" + P.f.pesos(linea.producto.precio_compra) + ").";
      return "";
    }

    function pintarLineas() {
      P.vaciar(tablaLineas);
      if (!estado.lineas.length) {
        tablaLineas.appendChild(h("p.texto-3", { style: { margin: 0 } }, "Todavía no agregaste productos."));
        pintarResumen();
        return;
      }
      tablaLineas.appendChild(h("div.tabla-desplazable", h("table.tabla.lineas",
        h("thead", h("tr", h("th.der", "Cantidad"), h("th", "Producto"), h("th.der", "Costo unitario"), h("th.der", "Costo de referencia"), h("th.der", "Total"), h("th"))),
        h("tbody", estado.lineas.map(function (l, i) {
          function numero(clave, clase) {
            var mostrar = function (valor) { return String(valor).replace(".", ","); };
            var input = h("input.campo-control." + clase, { value: mostrar(l[clave]), inputmode: "decimal", "aria-label": (clave === "cantidad" ? "Cantidad de " : "Costo unitario de ") + l.producto.nombre });
            input.addEventListener("change", function () {
              var v = clave === "cantidad" ? P.numeroDe(input.value) : P.importeDe(input.value);
              if (!Number.isFinite(v) || v < 0 || (clave === "cantidad" && v === 0)) { input.value = mostrar(l[clave]); return; }
              l[clave] = v; guardar(); pintarLineas();
            });
            return input;
          }
          var alerta = oferta(l);
          return h("tr",
            h("td.der", numero("cantidad", "num")),
            h("td", h("strong", l.producto.nombre), h("div.texto-3.chico", l.producto.codigo || ""), alerta ? h("div.compra-oferta", P.icono("alerta"), alerta) : null),
            h("td.der", numero("precio_unitario", "num")),
            h("td.der.texto-3", P.f.pesos(l.producto.precio_compra)),
            h("td.der.fuerte", P.f.pesos(l.cantidad * l.precio_unitario)),
            h("td.acciones", P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Quitar", onclick: function () { estado.lineas.splice(i, 1); guardar(); pintarLineas(); } })));
        })))));
      pintarResumen();
    }

    function suma() { return P.redondear(estado.lineas.reduce(function (s, l) { return s + P.redondear(l.cantidad * l.precio_unitario); }, 0)); }
    function pintarResumen() {
      var s = suma();
      var t = P.importeDe(estado.total_factura);
      var dif = isNaN(t) ? null : P.redondear(t - s);
      P.reemplazar(resumen, h("div.resumen-cuentas",
        h("div", h("span", "Productos"), h("strong", String(estado.lineas.length))),
        h("div", h("span", "Suma de los productos"), h("strong.dinero", P.f.pesos(s))),
        h("div", h("span", "Total de la factura"), h("strong.dinero", isNaN(t) ? "—" : P.f.pesos(t))),
        dif === null ? h("div.texto-3.chico", "Cargá el total de la factura para controlar las cuentas.")
          : Math.abs(dif) <= 0.05 ? h("div.fuerte.cuadra", P.icono("check"), h("span", "Las cuentas cierran"))
            : h("div.fuerte.no-cuadra", h("span", dif > 0 ? "Faltan" : "Sobran"), h("span.dinero", P.f.pesos(Math.abs(dif))))));
    }

    function revisar() {
      P.vaciar(problemas);
      var error;
      if (!estado.proveedor) error = "Elegí el proveedor de la factura.";
      else if (!estado.lineas.length) error = "Agregá al menos un producto a la compra.";
      else if (!estado.factura.trim() && !estado.remito.trim()) error = "Cargá el número de factura o de remito.";
      else if (!Number.isFinite(P.importeDe(estado.total_factura)) || Math.abs(P.redondear(P.importeDe(estado.total_factura) - suma())) > 0.05) error = "Revisá el total de la factura y la suma de los productos.";
      if (error) { P.reemplazar(problemas, P.mensaje(error, "error")); return; }
      var contador = h("strong", { "aria-live": "polite" });
      var todos = P.check("Seleccionar todos", false, null, function (marcar) {
        controles.forEach(function (control) { control.input.checked = marcar; });
        actualizar();
      });
      var controles = estado.lineas.map(function (linea) {
        var nuevo = P.precioDeVenta(linea.precio_unitario, linea.producto.margen);
        return P.check(linea.producto.nombre, false, "Venta general: " + P.f.pesos(linea.producto.precio_venta) + " → " + P.f.pesos(nuevo), actualizar);
      });
      function actualizar() {
        var n = controles.filter(function (control) { return control.input.checked; }).length;
        todos.input.checked = n === controles.length;
        todos.input.indeterminate = n > 0 && n < controles.length;
        contador.textContent = n ? n + " de " + controles.length + " para actualizar" : "Se conservan todos los precios";
      }
      actualizar();
      var seleccion = h("ul.lista-simple.compra-seleccion", controles.map(function (control, i) {
        var alerta = oferta(estado.lineas[i]);
        return h("li", control, alerta ? h("div.compra-oferta", P.icono("alerta"), alerta) : null);
      }));
      var m = P.modal({
        titulo: "¿Qué precios querés actualizar?",
        subtitulo: "El stock de todos los productos ingresa a la proveeduría. Marcá sólo los que deban cambiar su precio en caja.",
        contenido: h("div.columna",
          estado.lineas.some(oferta) ? P.mensaje("Hay productos con un costo más bajo. Si son ofertas, dejalos sin marcar para conservar su precio de venta.", "aviso") : null,
          h("div.fila-separada", todos, contador), seleccion,
          h("div.texto-3.chico", "Las bocas con margen propio aplican ese margen sobre el nuevo costo. Los precios de venta se redondean hacia arriba a $100.")),
        acciones: [P.btn("Volver", { tipo: "secundario", onclick: function () { m.cerrar(); } }),
          P.btn("Confirmar compra", { tipo: "primario", icono: "check", onclick: function (ev) { enviar(ev.currentTarget, controles, m); } })],
      });
    }

    function enviar(boton, controles, modal) {
      var cuerpo = {
        proveedor_id: estado.proveedor ? estado.proveedor.valor : null,
        factura: estado.factura, fecha_factura: estado.fecha_factura || null, remito: estado.remito, fecha_remito: estado.fecha_remito || null,
        total_factura: P.importeDe(estado.total_factura), observaciones: estado.observaciones,
        items: estado.lineas.map(function (l, i) { return {
          producto_id: l.producto.id, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
          actualizar_precio: controles[i].input.checked, costo_referencia: l.producto.precio_compra,
        }; }),
      };
      revisarCompra.disabled = true;
      P.ejecutar(boton, function () {
        return P.post("/compras", cuerpo).then(function (r) {
          modal.cerrar();
          try { sessionStorage.removeItem(CLAVE); } catch (e) { /* nada */ }
          P.aviso(r.mensaje || "Compra cargada", "ok");
          (r.avisos || []).forEach(function (a) { P.aviso(a, "cola", 9000); });
          P.ruta.ir("/compras");
        });
      }).catch(function (e) {
        modal.cerrar();
        var lista = e.datos && e.datos.problemas;
        P.reemplazar(problemas, h("div.mensaje.mensaje-error", P.icono("alerta"), h("div", h("strong", "Revisá la compra antes de cargarla"),
          lista && lista.length ? h("ul", lista.map(function (x) { return h("li", x); })) : h("div", e.message))));
        problemas.scrollIntoView({ behavior: "smooth", block: "center" });
      }).finally(function () { revisarCompra.disabled = false; });
    }

    pintarLineas();
  }, { titulo: "Cargar compra" });
})();
