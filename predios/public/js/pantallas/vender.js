/* Vender: punto de venta de cada caja. Pensado para el teclado y el escáner de códigos:
   el escáner "escribe" el código y presiona Enter; el producto se agrega solo y, si se
   repite, se suma a la misma fila. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  var FORMAS = [
    { valor: "EFECTIVO", texto: "Efectivo", icono: "efectivo" },
    { valor: "QR", texto: "QR", icono: "qr" },
    { valor: "TARJETA_DEBITO", texto: "Débito", icono: "tarjeta" },
    { valor: "TARJETA_CREDITO", texto: "Crédito", icono: "tarjeta" },
    { valor: "TRANSFERENCIA", texto: "Transferencia", icono: "transferencia" },
    { valor: "DESCUENTO", texto: "Descuento", icono: "descuento" },
  ];

  function vacia() { return { items: [], afiliado: null, devolucion: false, forma: "EFECTIVO", recibido: "", codigo: "" }; }

  P.ruta.registrar(/^\/vender$/, function (c) {
    var puesto = P.puesto();
    if (!puesto || !puesto.caja_id) {
      c.appendChild(P.vacio("caja", "Elegí una caja para vender", "Las ventas quedan registradas en la caja en la que estás trabajando.",
        P.btn("Elegir caja", { tipo: "primario", onclick: function () { P.ruta.ir("/puesto"); } })));
      return;
    }
    var claveBorrador = "predio.venta." + puesto.caja_id;
    var estado = vacia();
    try { var b = JSON.parse(sessionStorage.getItem(claveBorrador) || "null"); if (b && b.items) estado = Object.assign(vacia(), b); } catch (e) { /* nada */ }
    var ultimaVenta = null;
    try { ultimaVenta = Number(sessionStorage.getItem("predio.ultima-venta." + puesto.caja_id)) || null; } catch (e) { /* nada */ }

    function guardarBorrador() {
      try { sessionStorage.setItem(claveBorrador, JSON.stringify(estado)); } catch (e) { /* sin almacenamiento */ }
    }

    // ---------------------------------------------------------------- cabecera
    var turno = h("span.texto-3");
    c.appendChild(h("div.pagina-cabecera",
      h("div", h("h1.titulo-pagina", "Vender"), h("p.subtitulo", puesto.boca + " · " + puesto.caja + " · ", turno)),
      h("div.pagina-acciones",
        P.btn("Vaciar", { tipo: "texto", icono: "borrar", onclick: function () {
          if (!estado.items.length) return;
          P.confirmar("¿Sacar todos los productos de la venta en curso?", { aceptar: "Vaciar", peligro: true }).then(function (ok) { if (ok) { estado = vacia(); pintarTodo(); combo.foco(); } });
        } }))));
    function cargarTurno() {
      P.get("/inicio").then(function (r) {
        if (r.turno) turno.textContent = "Tu turno: " + r.turno.ventas + " venta" + (r.turno.ventas === 1 ? "" : "s") + " · " + P.f.pesos(r.turno.total);
      }).catch(function () {});
    }
    cargarTurno();

    // ---------------------------------------------------------------- productos
    var combo = P.comboProducto({
      venta: true, mostrarStock: true, limpiarAlElegir: true, autofocus: true, abrirAlEnfocar: false,
      bocaId: function () { return puesto.boca_id; },
      placeholder: "Escaneá el código o escribí el producto  (F2)",
      alElegir: function (o) { agregar(o.dato); },
      alEnterSinCoincidencia: function (texto) { if (texto) P.aviso("No encontramos un producto con «" + texto + "»", "error"); },
    });
    var tablaItems = h("div.items");
    var izquierda = h("div.columna",
      h("div.hoja.vender-buscador", combo.el),
      h("div.hoja", tablaItems));

    function agregar(p) {
      if (!p) return;
      if (p.destino === "USO_INTERNO") { P.aviso("«" + p.nombre + "» es de uso interno y no se vende", "error"); return; }
      if (!(Number(p.precio_venta) > 0)) { P.aviso("«" + p.nombre + "» no tiene precio de venta: pedile al administrador que lo cargue", "error"); combo.foco(); return; }
      var existente = estado.items.filter(function (i) { return i.producto.id === p.id; })[0];
      if (existente) existente.cantidad = P.redondear(existente.cantidad + 1, 3);
      else estado.items.push({ producto: p, cantidad: 1 });
      estado.resaltar = p.id;
      pintarTodo();
      combo.foco();
    }

    function pintarItems() {
      P.vaciar(tablaItems);
      if (!estado.items.length) {
        tablaItems.appendChild(h("div.items-vacio",
          ilustracionVacia(),
          h("strong", "Escaneá el primer producto"),
          h("span.chico", "O escribí parte del nombre y elegilo con Enter. Los productos repetidos se suman solos.")));
        return;
      }
      var filas = estado.items.map(function (it, i) {
        var cant = h("input.campo-control", { value: P.f.numero(it.cantidad), inputmode: "decimal", "aria-label": "Cantidad de " + it.producto.nombre });
        cant.addEventListener("change", function () {
          var n = P.numeroDe(cant.value);
          if (!(n > 0)) { cant.value = P.f.numero(it.cantidad); return; }
          it.cantidad = P.redondear(n, 3);
          pintarTodo();
        });
        cant.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cant.blur(); combo.foco(); } });
        var sinStock = it.producto.destino === "VENTA_DIRECTA" && it.producto.stock_boca < it.cantidad;
        return h("tr" + (estado.resaltar === it.producto.id ? ".nuevo" : ""),
          h("td", h("div.cant",
            P.btn("", { tipo: "texto", chico: true, icono: "menos", etiqueta: "Restar uno", onclick: function () { if (it.cantidad > 1) { it.cantidad = P.redondear(it.cantidad - 1, 3); pintarTodo(); } } }),
            cant,
            P.btn("", { tipo: "texto", chico: true, icono: "mas", etiqueta: "Sumar uno", onclick: function () { it.cantidad = P.redondear(it.cantidad + 1, 3); pintarTodo(); } }))),
          h("td", h("strong", it.producto.nombre), h("div.texto-3.chico", [it.producto.codigo, sinStock ? "Stock en la boca: " + P.f.numero(it.producto.stock_boca) : null].filter(Boolean).join(" · "))),
          h("td.der.dinero", P.f.pesos(it.producto.precio_venta)),
          h("td.der.dinero.fuerte", P.f.pesos(it.producto.precio_venta * it.cantidad)),
          h("td.acciones", P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Quitar", onclick: function () { estado.items.splice(i, 1); pintarTodo(); combo.foco(); } })));
      });
      tablaItems.appendChild(h("div.tabla-desplazable", h("table.tabla.items",
        h("thead", h("tr", h("th", "Cantidad"), h("th", "Producto"), h("th.der", "Importe"), h("th.der", "Subtotal"), h("th"))),
        h("tbody", filas))));
      estado.resaltar = null;
    }

    function total() {
      return P.redondear(estado.items.reduce(function (s, it) { return s + it.producto.precio_venta * it.cantidad; }, 0), 2);
    }

    // ---------------------------------------------------------------- cuenta
    var cuenta = h("aside.hoja.cuenta", { "aria-label": "Cobro" });

    var buscarAfiliado = P.input({ placeholder: "DNI o legajo  (F4)", inputmode: "numeric" });
    buscarAfiliado.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); buscarAf(); } });
    function buscarAf() {
      var q = buscarAfiliado.value.trim();
      if (!q) return;
      P.get("/afiliados/buscar" + P.qs({ q: q })).then(function (r) {
        if (!r.resultados.length) {
          P.aviso("No encontramos un afiliado con «" + q + "». Podés vender igual sin afiliado.", "error");
          return;
        }
        if (r.resultados.length === 1) { elegirAfiliado(r.resultados[0]); return; }
        var m = P.modal({
          titulo: "Elegí el afiliado",
          contenido: h("ul.lista-simple", r.resultados.map(function (a) {
            return h("li", h("div", h("strong", a.nombre), h("div.texto-3.chico", [a.dni ? "DNI " + P.documento(a.dni) : null, a.legajo ? "Legajo " + a.legajo : null, a.departamental].filter(Boolean).join(" · "))),
              P.btn("Elegir", { tipo: "primario", chico: true, onclick: function () { m.cerrar(); elegirAfiliado(a); } }));
          })),
        });
      }).catch(P.error);
    }
    function elegirAfiliado(a) {
      estado.afiliado = a;
      buscarAfiliado.value = "";
      if (!a.habilitado_descuento || a.disponible <= 0) estado.devolucion = false;
      pintarTodo();
      combo.foco();
    }

    var recibido = P.dinero({ placeholder: "Monto recibido" });
    recibido.addEventListener("input", function () { estado.recibido = recibido.value; pintarTotales(); guardarBorrador(); });
    recibido.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cobrar(); } });
    var codigo = P.input({ placeholder: "Opcional: número de operación", max: 60 });
    codigo.addEventListener("input", function () { estado.codigo = codigo.value; guardarBorrador(); });
    codigo.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cobrar(); } });

    var zonaAfiliado = h("div.cuenta-bloque");
    var zonaFormas = h("div.cuenta-bloque");
    var zonaPago = h("div");
    var zonaTotal = h("div");
    var botonCobrar = P.btn("Cobrar", { tipo: "primario", grande: true, icono: "check", tecla: "F9", onclick: function () { cobrar(); } });
    botonCobrar.style.width = "100%";

    function pintarAfiliado() {
      P.vaciar(zonaAfiliado);
      zonaAfiliado.appendChild(h("h2", "Afiliado (opcional)"));
      if (!estado.afiliado) {
        zonaAfiliado.appendChild(h("div.fila", { style: { marginTop: "10px", flexWrap: "nowrap" } }, buscarAfiliado, P.btn("", { tipo: "secundario", icono: "buscar", etiqueta: "Buscar afiliado", onclick: buscarAf })));
        return;
      }
      var a = estado.afiliado;
      var t = total();
      var sinDisponible = !a.habilitado_descuento || a.disponible <= 0;
      var check = P.check("Devolución: usar su descuento de haberes", estado.devolucion,
        sinDisponible ? "No tiene disponible: tiene que pagar de otra forma." : "Disponible: " + P.f.pesos(a.disponible),
        function (v) { estado.devolucion = v; estado.forma = v ? "DESCUENTO" : "EFECTIVO"; pintarTodo(); });
      check.input.disabled = sinDisponible;
      zonaAfiliado.appendChild(h("div.afiliado-tarjeta", { style: { marginTop: "10px" } },
        h("span.avatar", P.iniciales(a.nombre)),
        h("div.espacio",
          h("strong", a.nombre),
          h("div.texto-3.chico", [a.dni ? "DNI " + P.documento(a.dni) : null, a.legajo ? "Legajo " + a.legajo : null].filter(Boolean).join(" · ")),
          h("div.texto-3.chico", [a.departamental, a.en_predio ? "En el predio" : (a.estadia ? "Estadía " + P.f.fecha(a.estadia.fecha_inicio) + " al " + P.f.fecha(a.estadia.fecha_fin) : null)].filter(Boolean).join(" · "))),
        P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Quitar afiliado", onclick: function () { estado.afiliado = null; estado.devolucion = false; if (estado.forma === "DESCUENTO") estado.forma = "EFECTIVO"; pintarTodo(); } })));
      zonaAfiliado.appendChild(h("div", { style: { marginTop: "10px" } }, check));
      if (estado.devolucion && t > a.disponible) {
        zonaAfiliado.appendChild(h("div", { style: { marginTop: "10px" } }, P.mensaje("La compra (" + P.f.pesos(t) + ") supera su disponible (" + P.f.pesos(a.disponible) + "). Tiene que pagar de otra forma o sacar productos.", "error")));
      }
    }

    function pintarFormas() {
      P.vaciar(zonaFormas);
      zonaFormas.appendChild(h("h2", "Forma de pago"));
      zonaFormas.appendChild(h("div.formas", { style: { marginTop: "10px" } }, FORMAS.filter(function (f) { return f.valor !== "DESCUENTO" || estado.devolucion; }).map(function (f) {
        return h("button.forma", { type: "button", "aria-pressed": String(estado.forma === f.valor), onclick: function () {
          estado.forma = f.valor;
          if (f.valor !== "DESCUENTO") estado.devolucion = false;
          pintarTodo();
          if (f.valor === "EFECTIVO") recibido.focus(); else if (f.valor !== "DESCUENTO") codigo.focus();
        } }, P.icono(f.icono), f.texto);
      })));
    }

    function pintarPago() {
      P.vaciar(zonaPago);
      var t = total();
      if (estado.forma === "EFECTIVO") {
        recibido.value = estado.recibido;
        var sugeridos = [];
        [1000, 2000, 5000, 10000, 20000].forEach(function (m) { var v = Math.ceil(t / m) * m; if (v > t && sugeridos.indexOf(v) < 0) sugeridos.push(v); });
        zonaPago.appendChild(h("div.cuenta-bloque",
          P.campo("Efectivo recibido", h("div.campo-con-prefijo", h("span", "$"), recibido)),
          h("div.rapidos",
            P.btn("Justo", { tipo: "suave", chico: true, onclick: function () { estado.recibido = P.f.numero(t); recibido.value = estado.recibido; pintarTotales(); } }),
            sugeridos.slice(0, 3).map(function (v) { return P.btn(P.f.pesos(v).replace(",00", ""), { tipo: "suave", chico: true, onclick: function () { estado.recibido = String(v); recibido.value = estado.recibido; pintarTotales(); } }); })),
          h("div#vuelto")));
      } else if (estado.forma !== "DESCUENTO") {
        codigo.value = estado.codigo;
        zonaPago.appendChild(h("div.cuenta-bloque", P.campo("Código de pago", codigo, { ayuda: "Si el posnet o la app te da un número de operación, anotalo: queda en el ticket." })));
      }
    }

    function pintarTotales() {
      var t = total();
      P.reemplazar(zonaTotal, h("div.total", h("span", "Total"), h("strong", P.f.pesos(t))));
      var v = document.getElementById("vuelto");
      var habilitado = estado.items.length > 0;
      if (v && estado.forma === "EFECTIVO") {
        P.vaciar(v);
        v.className = "";
        var r = P.numeroDe(estado.recibido);
        if (estado.recibido && !isNaN(r)) {
          if (r >= t) { v.className = "vuelto"; v.appendChild(h("span", "Vuelto")); v.appendChild(h("strong", P.f.pesos(r - t))); }
          else { v.className = "vuelto falta"; v.appendChild(h("span", "Falta")); v.appendChild(h("strong", P.f.pesos(t - r))); habilitado = false; }
        }
      }
      if (estado.devolucion && estado.afiliado && t > estado.afiliado.disponible) habilitado = false;
      botonCobrar.disabled = !habilitado;
    }

    function pintarTodo() {
      pintarItems();
      pintarAfiliado();
      pintarFormas();
      pintarPago();
      pintarTotales();
      guardarBorrador();
    }

    cuenta.appendChild(zonaAfiliado);
    cuenta.appendChild(zonaFormas);
    cuenta.appendChild(zonaPago);
    cuenta.appendChild(zonaTotal);
    cuenta.appendChild(botonCobrar);
    cuenta.appendChild(h("div.atajos",
      P.btn("Mis ventas", { tipo: "suave", chico: true, icono: "lista", onclick: function () { P.ruta.ir("/mis-ventas"); } }),
      P.btn("Reimprimir último", { tipo: "suave", chico: true, icono: "imprimir", onclick: function () {
        if (!ultimaVenta) { P.aviso("Todavía no hiciste ventas en esta caja desde esta PC. Buscalas en Mis ventas.", "error"); return; }
        P.reimprimirVenta(ultimaVenta);
      } }),
      P.btn("Anular venta", { tipo: "suave", chico: true, icono: "borrar", onclick: function () { P.ruta.ir("/mis-ventas"); } }),
      P.btn("Stock", { tipo: "suave", chico: true, icono: "stock", onclick: function () { P.ruta.ir("/stock"); } }),
      P.btn("Caja", { tipo: "suave", chico: true, icono: "caja", onclick: function () { P.ruta.ir("/mi-caja"); } })));

    c.appendChild(h("div.vender", izquierda, cuenta));
    pintarTodo();

    // ---------------------------------------------------------------- cobrar
    var cobrando = false;
    function cobrar() {
      if (cobrando || botonCobrar.disabled || !estado.items.length) return;
      cobrando = true;
      var cuerpo = {
        items: estado.items.map(function (it) { return { producto_id: it.producto.id, cantidad: it.cantidad }; }),
        forma_pago: estado.forma,
        devolucion: estado.devolucion,
        afiliado_id: estado.afiliado ? estado.afiliado.id : null,
        recibido: estado.forma === "EFECTIVO" && estado.recibido ? P.numeroDe(estado.recibido) : null,
        codigo_pago: estado.forma !== "EFECTIVO" && estado.forma !== "DESCUENTO" ? estado.codigo : null,
      };
      P.ejecutar(botonCobrar, function () {
        return P.conConfirmacionStock(function (confirmar) {
          return P.post("/ventas", Object.assign({}, cuerpo, { confirmar_sin_stock: confirmar }));
        }, "Vender igual").then(function (r) {
          ultimaVenta = r.id;
          try { sessionStorage.setItem("predio.ultima-venta." + puesto.caja_id, String(r.id)); } catch (e) { /* nada */ }
          estado = vacia();
          pintarTodo();
          cargarTurno();
          ventaHecha(r);
        });
      }).catch(function (e) {
        if (e.codigo === "SIN_DISPONIBLE" && estado.afiliado) { estado.afiliado.disponible = Number(e.datos.disponible || 0); pintarTodo(); }
      }).finally(function () { cobrando = false; });
    }

    function ventaHecha(r) {
      var auto = !!(puesto.impresion_automatica === undefined ? 1 : Number(puesto.impresion_automatica));
      if (auto) P.imprimirVenta(r.id).catch(P.error);
      var m = P.modal({
        titulo: "Venta N° " + r.id + " registrada",
        contenido: h("div.columna",
          h("div.total", h("span", "Total"), h("strong", P.f.pesos(r.total))),
          r.vuelto ? h("div.vuelto", h("span", "Vuelto"), h("strong", P.f.pesos(r.vuelto))) : null,
          auto ? h("p.texto-3.chico", { style: { margin: 0 } }, "El ticket se está imprimiendo.") : null),
        acciones: [
          P.btn(auto ? "Imprimir otra copia" : "Imprimir ticket", { tipo: "secundario", icono: "imprimir", onclick: function () { P.imprimirVenta(r.id).catch(P.error); } }),
          P.btn("Nueva venta", { tipo: "primario", tecla: "Enter", onclick: function () { m.cerrar(); } }),
        ],
        alCerrar: function () { setTimeout(function () { combo.foco(); }, 50); },
      });
    }

    // ---------------------------------------------------------------- teclado
    function teclas(ev) {
      if (P.hayVentana()) return;
      if (ev.key === "F2") { ev.preventDefault(); combo.foco(); }
      else if (ev.key === "F4") { ev.preventDefault(); if (!estado.afiliado) buscarAfiliado.focus(); }
      else if (ev.key === "F9") { ev.preventDefault(); cobrar(); }
    }
    document.addEventListener("keydown", teclas);
    P.alSalir(function () { document.removeEventListener("keydown", teclas); });
  }, { titulo: "Vender", local: true });

  function ilustracionVacia() {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 140 90");
    svg.setAttribute("aria-hidden", "true");
    var partes = [
      ["rect", { x: "18", y: "20", width: "104", height: "52", rx: "8", fill: "#eaf6fd", stroke: "#bcd9ec", "stroke-width": "2" }],
      ["path", { d: "M32 32v28M38 32v28M46 32v28M50 32v28M58 32v28M66 32v28M70 32v28M78 32v28M86 32v28M90 32v28M98 32v28M104 32v28", stroke: "#0d5482", "stroke-width": "2.4", "stroke-linecap": "round" }],
      ["path", { d: "M10 46h120", stroke: "#0097de", "stroke-width": "2.5", "stroke-linecap": "round", opacity: ".8" }],
    ];
    partes.forEach(function (p) {
      var e = document.createElementNS(NS, p[0]);
      Object.keys(p[1]).forEach(function (k) { e.setAttribute(k, p[1][k]); });
      svg.appendChild(e);
    });
    return svg;
  }

  // Imprime una venta registrando la impresión (la segunda vez sale como "Reimpresión").
  P.imprimirVenta = function (id) {
    var promesa = P.modo === "remoto" ? P.get("/ventas/" + id) : P.post("/ventas/" + id + "/impresion", {});
    return promesa.then(function (datos) { return P.imprimirTicket(datos, { reimpresion: datos.reimpresion || P.modo === "remoto" }); });
  };
  P.reimprimirVenta = function (id) { return P.imprimirVenta(id).catch(P.error); };
})();
