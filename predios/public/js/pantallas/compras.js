/* Compras: una compra por factura. Lista dinámica de productos con el precio anterior,
   el margen y el control de que la suma coincida con el total de la factura. */
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
                h("td.der.texto-3", P.f.pesos(i.precio_anterior)), h("td.der", P.f.pct(i.margen)), h("td.der", P.f.pesos(i.precio_venta)), h("td.der.fuerte", P.f.pesos(i.subtotal)));
            })),
            h("tfoot", h("tr", h("td", { colspan: "6" }, "Total"), h("td.der", P.f.pesos(c.total_items)))))),
          c.observaciones ? P.mensaje(c.observaciones) : null),
        acciones: [
          P.esAdmin() && c.estado !== "ANULADA" ? P.btn("Anular compra", { tipo: "peligro", icono: "borrar", onclick: function () {
            P.pedirTexto("Anular la compra N° " + c.id, { etiqueta: "Motivo", requerido: true, aceptar: "Anular", peligro: true, subtitulo: "Se descuenta del almacén lo que había ingresado. Los precios no se modifican." }).then(function (motivo) {
              if (!motivo) return;
              P.post("/compras/" + c.id + "/anular", { motivo: motivo }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); m.cerrar(); if (alCambiar) alCambiar(); }).catch(P.error);
            });
          } }) : null,
          P.btn("Imprimir", { tipo: "secundario", icono: "imprimir", onclick: function () { P.imprimirCompra(d); } }),
        ],
      });
    }).catch(P.error);
  };

  P.ruta.registrar(/^\/compras$/, function (c) {
    c.appendChild(h("div.pagina-cabecera",
      h("div", h("h1.titulo-pagina", "Compras"), h("p.subtitulo", "Una compra por factura. Lo comprado entra al almacén y actualiza el precio de cada producto.")),
      h("div.pagina-acciones", puedeComprar() ? P.btn("Cargar compra", { tipo: "primario", icono: "mas", onclick: function () { P.ruta.ir("/compras/nueva"); } }) : null)));
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
    if (!puedeComprar()) { c.appendChild(P.vacio("candado", "Las compras las carga el almacén o un administrador", "")); return; }
    var CLAVE = "predio.compra-borrador";
    var estado = { proveedor: null, factura: "", fecha_factura: P.hoy(), remito: "", fecha_remito: "", total_factura: "", observaciones: "", lineas: [] };
    try { var b = JSON.parse(sessionStorage.getItem(CLAVE) || "null"); if (b && b.lineas) estado = Object.assign(estado, b); } catch (e) { /* nada */ }
    function guardar() { try { sessionStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (e) { /* nada */ } }

    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/compras" }, P.icono("volver"), "Compras"),
      h("h1.titulo-pagina", "Cargar compra"), h("p.subtitulo", "Completá los datos de la factura y agregá los productos uno por uno (podés usar el escáner)."))));

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
        ayudaProducto.textContent = "Precio anterior: " + P.f.pesos(elegido.precio_compra) + " · Margen: " + P.f.pct(elegido.margen) + " · Venta actual: " + P.f.pesos(elegido.precio_venta);
        if (!unitario.value) unitario.value = elegido.precio_compra ? P.f.numero(elegido.precio_compra) : "";
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
      var precio = P.numeroDe(unitario.value);
      if (!(cant > 0)) { P.aviso("La cantidad tiene que ser mayor que cero", "error"); cantidad.focus(); return; }
      if (!(precio >= 0)) { P.aviso("Cargá el precio unitario", "error"); unitario.focus(); return; }
      var existente = estado.lineas.filter(function (l) { return l.producto.id === elegido.id; })[0];
      if (existente) { existente.cantidad = P.redondear(existente.cantidad + cant, 3); existente.precio_unitario = precio; }
      else estado.lineas.push({ producto: elegido, cantidad: cant, precio_unitario: precio, margen: elegido.margen });
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
      h("div", { style: { marginTop: "16px" } }, tablaLineas)));
    c.appendChild(h("div.grilla", { style: { gridTemplateColumns: "minmax(0,1fr) minmax(280px, 380px)", marginTop: "16px", alignItems: "start" } },
      problemas, h("div.columna", resumen, P.btn("Cargar compra", { tipo: "primario", grande: true, icono: "check", id: "cargar-compra", onclick: function (ev) { enviar(ev.currentTarget); } }))));

    function pintarLineas() {
      P.vaciar(tablaLineas);
      if (!estado.lineas.length) {
        tablaLineas.appendChild(h("p.texto-3", { style: { margin: 0 } }, "Todavía no agregaste productos."));
        pintarResumen();
        return;
      }
      tablaLineas.appendChild(h("div.tabla-desplazable", h("table.tabla.lineas",
        h("thead", h("tr", h("th.der", "Cantidad"), h("th", "Producto"), h("th.der", "Unitario"), h("th.der", "Anterior"), h("th.der", "Margen %"), h("th.der", "Venta nueva"), h("th.der", "Total"), h("th"))),
        h("tbody", estado.lineas.map(function (l, i) {
          function numero(clave, clase) {
            var input = h("input.campo-control." + clase, { value: P.f.numero(l[clave]), inputmode: "decimal" });
            input.addEventListener("change", function () {
              var v = P.numeroDe(input.value);
              if (isNaN(v) || v < (clave === "margen" ? -100 : 0)) { input.value = P.f.numero(l[clave]); return; }
              l[clave] = v; guardar(); pintarLineas();
            });
            return input;
          }
          var venta = P.redondear(l.precio_unitario * (1 + (Number(l.producto.margen) || 0) / 100));
          var subio = l.producto.precio_compra && l.precio_unitario !== l.producto.precio_compra;
          return h("tr",
            h("td.der", numero("cantidad", "num")),
            h("td", h("strong", l.producto.nombre), h("div.texto-3.chico", l.producto.codigo || "")),
            h("td.der", numero("precio_unitario", "num")),
            h("td.der", h("span" + (subio ? (l.precio_unitario > l.producto.precio_compra ? ".negativo" : ".positivo") : ".texto-3"), P.f.pesos(l.producto.precio_compra))),
            h("td.der", P.f.pct(l.producto.margen)),
            h("td.der", P.f.pesos(venta), h("div.texto-3.chico", "Hoy " + P.f.pesos(l.producto.precio_venta))),
            h("td.der.fuerte", P.f.pesos(l.cantidad * l.precio_unitario)),
            h("td.acciones", P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Quitar", onclick: function () { estado.lineas.splice(i, 1); guardar(); pintarLineas(); } })));
        })))));
      pintarResumen();
    }

    function suma() { return P.redondear(estado.lineas.reduce(function (s, l) { return s + l.cantidad * l.precio_unitario; }, 0)); }
    function pintarResumen() {
      var s = suma();
      var t = P.numeroDe(estado.total_factura);
      var dif = isNaN(t) ? null : P.redondear(t - s);
      P.reemplazar(resumen, h("div.resumen-cuentas",
        h("div", h("span", "Productos"), h("strong", String(estado.lineas.length))),
        h("div", h("span", "Suma de los productos"), h("strong.dinero", P.f.pesos(s))),
        h("div", h("span", "Total de la factura"), h("strong.dinero", isNaN(t) ? "—" : P.f.pesos(t))),
        dif === null ? h("div.texto-3.chico", "Cargá el total de la factura para controlar las cuentas.")
          : Math.abs(dif) <= 0.05 ? h("div.fuerte.cuadra", P.icono("check"), h("span", "Las cuentas cierran"))
            : h("div.fuerte.no-cuadra", h("span", dif > 0 ? "Faltan" : "Sobran"), h("span.dinero", P.f.pesos(Math.abs(dif))))));
    }

    function enviar(boton) {
      P.vaciar(problemas);
      var cuerpo = {
        proveedor_id: estado.proveedor ? estado.proveedor.valor : null,
        factura: estado.factura, fecha_factura: estado.fecha_factura || null, remito: estado.remito, fecha_remito: estado.fecha_remito || null,
        total_factura: estado.total_factura === "" ? null : P.numeroDe(estado.total_factura), observaciones: estado.observaciones,
        items: estado.lineas.map(function (l) { return { producto_id: l.producto.id, cantidad: l.cantidad, precio_unitario: l.precio_unitario }; }),
      };
      if (!cuerpo.proveedor_id) { P.reemplazar(problemas, P.mensaje("Elegí el proveedor de la factura.", "error")); return; }
      P.ejecutar(boton, function () {
        return P.post("/compras", cuerpo).then(function (r) {
          try { sessionStorage.removeItem(CLAVE); } catch (e) { /* nada */ }
          P.aviso(r.mensaje || "Compra cargada", "ok");
          (r.avisos || []).forEach(function (a) { P.aviso(a, "cola", 9000); });
          P.ruta.ir("/compras");
        });
      }).catch(function (e) {
        var lista = e.datos && e.datos.problemas;
        P.reemplazar(problemas, h("div.mensaje.mensaje-error", P.icono("alerta"), h("div", h("strong", "Revisá la compra antes de cargarla"),
          lista && lista.length ? h("ul", lista.map(function (x) { return h("li", x); })) : h("div", e.message))));
        problemas.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }

    pintarLineas();
  }, { titulo: "Cargar compra" });
})();
