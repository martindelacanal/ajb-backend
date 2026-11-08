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
    { valor: "SALDO", texto: "Saldo", icono: "saldo" },
  ];

  function vacia() { return { items: [], huesped: null, forma: "EFECTIVO", recibido: "", codigo: "" }; }

  P.ruta.registrar(/^\/vender$/, function (c) {
    var puesto = P.puesto();
    if (!puesto || !puesto.caja_id) {
      c.appendChild(P.vacio("caja", "Elegí una caja para vender", "Las ventas quedan registradas en la caja en la que estás trabajando.",
        P.btn("Elegir caja", { tipo: "primario", onclick: function () { P.ruta.ir("/puesto"); } })));
      return;
    }
    var claveBorrador = "predio.venta." + puesto.caja_id;
    var datosPrevios = P.continuidad.datosPantalla();
    if (datosPrevios && datosPrevios.caja !== puesto.caja_id) datosPrevios = null;
    var estado = vacia();
    if (datosPrevios && datosPrevios.venta) estado = Object.assign(estado, datosPrevios.venta);
    else {
      try { var b = JSON.parse(sessionStorage.getItem(claveBorrador) || "null"); if (b && b.items) estado = Object.assign(estado, b); } catch (e) { /* nada */ }
    }
    if (estado.forma === "DESCUENTO" || estado.segunda === "DESCUENTO") {
      if (estado.forma === "DESCUENTO") estado.forma = "SALDO";
      if (estado.segunda === "DESCUENTO") estado.segunda = "SALDO";
      estado.huesped = null;
    }
    if (estado.segunda === estado.forma) estado.segunda = null;
    var ultimaVenta = datosPrevios ? datosPrevios.ultimaVenta : null;
    if (!ultimaVenta) {
      try { ultimaVenta = Number(sessionStorage.getItem("predio.ultima-venta." + puesto.caja_id)) || null; } catch (e) { /* nada */ }
    }

    function guardarBorrador() {
      try { sessionStorage.setItem(claveBorrador, JSON.stringify(estado)); } catch (e) { /* sin almacenamiento */ }
    }

    // ---------------------------------------------------------------- cabecera
    c.appendChild(h("div.vender-cabecera",
      h("div.vender-titulo", h("h1.titulo-pagina", "Vender"),
        P.btn(P.puedeGestionarCajas() ? "Cerrar caja" : "Cierre temporal", { tipo: "secundario", icono: "candado", onclick: function () { P.cerrarCaja(puesto.caja_id); } }))));
    c.appendChild(h("nav.vender-acciones", { "aria-label": "Acciones de caja" },
      P.btn("Reimprimir último", { tipo: "suave", chico: true, icono: "imprimir", onclick: function () {
        if (!ultimaVenta) { P.aviso("Todavía no hiciste ventas en esta caja desde esta PC. Buscalas en Caja > Mis ventas.", "error"); return; }
        P.reimprimirVenta(ultimaVenta);
      } }),
      P.btn("Stock", { tipo: "suave", chico: true, icono: "stock", onclick: function () { P.ruta.ir("/stock"); } }),
      P.btn("Caja", { tipo: "suave", chico: true, icono: "caja", onclick: function () { P.ruta.ir("/mi-caja"); } })));

    // ---------------------------------------------------------------- productos
    var combo = P.comboProducto({
      venta: true, mostrarStock: true, limpiarAlElegir: true, autofocus: true, abrirAlEnfocar: false,
      bocaId: function () { return puesto.boca_id; },
      placeholder: "Escaneá el código o escribí el producto  (F2)",
      alElegir: function (o) { agregar(o.dato); },
      alEnterSinCoincidencia: function (texto) { if (texto) buscarProductoAusente(texto); },
    });
    var tablaItems = h("div.vender-items");
    var camposCantidad = [];
    var izquierda = h("div.columna",
      h("div.hoja.vender-buscador", combo.el,
        h("div.vender-ayuda",
          P.btn("¿No aparece el producto?", { tipo: "texto", chico: true, icono: "buscar", onclick: function () { buscarProductoAusente(combo.input.value.trim()); } }))),
      h("div.hoja", tablaItems));

    function buscarProductoAusente(texto, anterior) {
      combo.limpiar();
      var avisosPrevios = document.getElementById("avisos");
      if (avisosPrevios) P.vaciar(avisosPrevios);
      var consulta = { producto: null, estado: "NO_ENCONTRADO" };
      var busquedaResuelta = null;
      var pedidoConsulta = 0;
      var enviando = false;
      var buscador = P.combo({
        placeholder: "Escaneá el código o buscá en todos los productos", textoLibre: true, elegirUnico: false, abrirAlEnfocar: true,
        buscar: function (busqueda) {
          return P.get("/productos/buscar" + P.qs({ q: busqueda, contexto: "aviso", boca_id: puesto.boca_id })).then(function (productos) {
            return productos.map(function (p) {
              return { valor: p.id, texto: p.nombre, codigo: p.codigo, exacto: p.exacto, requiereEleccion: !!p.sugerido, dato: p, busqueda: busqueda,
                detalle: [p.codigo ? "Código " + p.codigo : null, p.stock_oculto ? null : "Stock: " + P.f.cantidad(p.stock_boca, p.unidad), Number(p.precio_venta) > 0 ? null : "Sin precio", p.destino === "USO_INTERNO" ? "Uso interno" : null].filter(Boolean).join(" · "),
                lado: Number(p.precio_venta) > 0 ? P.f.pesos(p.precio_venta) : "Sin precio" };
            });
          });
        },
        alCambiarTexto: function () { pedidoConsulta++; busquedaResuelta = null; consulta = { producto: null, estado: "NO_ENCONTRADO" }; pintarConsulta(); },
        alElegir: function (o) { fijarProducto(o.dato, o.busqueda); },
        alEnterSinCoincidencia: function () { consultar().catch(function (e) { P.reemplazar(informacion, P.mensaje(e.message, "error")); }); },
      });
      buscador.input.value = texto || "";
      var informacion = h("div.columna", { "aria-live": "polite" });
      var enviar = P.btn("Enviar aviso", { tipo: "primario", icono: "mensaje", onclick: function () {
        if (enviando) return;
        var busqueda = busquedaResuelta || buscador.input.value.trim();
        if (!consulta.producto && busqueda.length < 2) { buscador.foco(); return; }
        if (soloInformar()) { m.cerrar(); return; }
        enviando = true;
        buscador.input.disabled = true;
        P.ejecutar(enviar, function () {
          return consultar().then(function (r) {
            if (soloInformar()) return;
            if (r.estado === "DISPONIBLE" && r.producto) { m.cerrar(); combo.limpiar(); agregar(r.producto); return; }
            return P.post("/ventas/avisar-sin-stock", { producto_id: r.producto ? r.producto.id : null, busqueda: busqueda, cantidad: 1, confirmar: true }).then(function (aviso) {
              m.cerrar(); combo.limpiar();
              P.aviso(aviso.mensaje || "Aviso enviado al administrador", "ok");
            });
          });
        }).catch(function (e) { P.reemplazar(informacion, P.mensaje(e.message, "error")); }).finally(function () { enviando = false; buscador.input.disabled = false; enviar.disabled = !consulta.producto && buscador.input.value.trim().length < 2; });
      } });
      function soloInformar() {
        var p = consulta.producto;
        return consulta.estado === "CODIGO_DUPLICADO" || (p && p.destino === "USO_INTERNO") || (consulta.estado === "SIN_PRECIO" && !(p && Number(p.stock_boca) <= 0));
      }
      function pintarConsulta() {
        var p = consulta.producto;
        var sinPrecio = consulta.estado === "SIN_PRECIO";
        var duplicado = consulta.estado === "CODIGO_DUPLICADO";
        var disponible = consulta.estado === "DISPONIBLE";
        var interno = p && p.destino === "USO_INTERNO";
        P.reemplazar(enviar, P.icono(disponible ? "mas" : soloInformar() ? "check" : "mensaje"), disponible ? "Agregar a la venta" : soloInformar() ? "Entendido" : "Enviar aviso");
        enviar.disabled = enviando || (!p && buscador.input.value.trim().length < 2);
        P.reemplazar(informacion,
          p ? h("div.datos", P.dato("Producto", p.nombre), P.dato("Código de barras", p.codigo), p.stock_oculto ? null : P.dato("Stock en la boca", P.f.cantidad(p.stock_boca, p.unidad))) : null,
          P.mensaje(interno ? "Este producto es de uso interno y no se vende. Su ficha se muestra sólo para consultar."
            : sinPrecio
            ? "«" + p.nombre + "» no tiene precio de venta cargado. Pedile al administrador que lo cargue antes de venderlo."
            : duplicado ? "Este código está asociado a más de un producto. Pedile al administrador que revise los códigos del catálogo antes de venderlo."
            : disponible ? "El producto ahora tiene precio y stock suficiente. Podés agregarlo a la venta."
              : p ? "Este producto no tiene stock suficiente registrado en esta boca. Al enviar el aviso, el administrador recibirá el producto, tu usuario, la boca, la caja y el horario para revisar los movimientos."
                : "Buscá y elegí el producto de la lista. Acá podés consultar todo el catálogo, incluidos los productos agotados o sin precio.", "aviso"),
          !soloInformar() && !disponible ? h("p.texto-3.chico", p ? (sinPrecio ? "También figura sin stock. Podés enviar el aviso al administrador; el producto no se agregará a la venta hasta que tenga precio." : "Podrás venderlo cuando haya stock en esta boca.") : "Si tampoco lo encontrás en el catálogo, podés enviar la búsqueda al administrador.") : null);
      }
      function fijarProducto(p, busqueda) {
        var estadoProducto = p.estado_venta || (p.destino === "USO_INTERNO" ? "USO_INTERNO" : !(Number(p.precio_venta) > 0) ? "SIN_PRECIO" : Number(p.stock_boca) <= 0 ? "SIN_STOCK" : "DISPONIBLE");
        consulta = { producto: p, estado: estadoProducto };
        busquedaResuelta = busqueda || p.codigo || p.nombre;
        buscador.fijar(p.id, p.nombre, { dato: p, codigo: p.codigo });
        pintarConsulta();
      }
      function consultar() {
        if (consulta.producto && Number(buscador.valor()) === Number(consulta.producto.id)) return Promise.resolve(consulta);
        var busqueda = buscador.input.value.trim();
        if (busquedaResuelta === busqueda) return Promise.resolve(consulta);
        var n = ++pedidoConsulta;
        var promesa = /^\d{4,60}$/.test(busqueda)
          ? P.get("/productos/consultar-codigo" + P.qs({ codigo: busqueda }))
          : Promise.resolve({ producto: null, estado: "NO_ENCONTRADO" });
        return promesa.then(function (r) {
          if (n === pedidoConsulta) {
            if (r.producto) fijarProducto(r.producto, busqueda);
            else { consulta = r; busquedaResuelta = busqueda; pintarConsulta(); }
          }
          return r;
        });
      }
      var m = P.modal({
        titulo: "Producto que no aparece",
        subtitulo: puesto.boca + " · " + puesto.caja,
        reanudar: { id: "venta-producto-ausente", campos: false, datos: function () {
          return { caja: puesto.caja_id, texto: buscador.input.value, consulta: consulta, busqueda: busquedaResuelta };
        } },
        contenido: h("div.columna",
          P.campo("Producto o código de barras", buscador.el), informacion),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), enviar],
        alCerrar: function () { pedidoConsulta++; buscador.limpiar(); combo.foco(); },
      });
      if (anterior) {
        if (anterior.consulta.producto) fijarProducto(anterior.consulta.producto, anterior.busqueda);
        else { consulta = anterior.consulta; busquedaResuelta = anterior.busqueda; pintarConsulta(); }
      } else {
        pintarConsulta();
        consultar().catch(function (e) { P.reemplazar(informacion, P.mensaje(e.message, "error")); });
      }
      return m;
    }
    P.continuidad.registrarVentana("venta-producto-ausente", function (datos) {
      if (datos.caja === puesto.caja_id) return buscarProductoAusente(datos.texto, datos);
    });

    function agregar(p) {
      if (!p) return;
      if (p.destino === "USO_INTERNO") { P.aviso("«" + p.nombre + "» es de uso interno y no se vende", "error"); return; }
      if (!(Number(p.precio_venta) > 0)) { P.aviso("«" + p.nombre + "» no tiene precio de venta: pedile al administrador que lo cargue", "error"); combo.foco(); return; }
      var pesable = p.unidad === "KG";
      // Etiqueta de balanza: cada paquete es un renglón con el peso de la etiqueta.
      if (p.etiqueta && pesable) {
        var repetida = estado.items.some(function (i) { return i.etiqueta === p.etiqueta; });
        var sumarEtiqueta = function () {
          estado.items.push({ producto: p, cantidad: P.redondear(p.peso, 3), etiqueta: p.etiqueta });
          estado.resaltar = p.id;
          pintarTodo();
          combo.foco();
        };
        if (!repetida) { sumarEtiqueta(); return; }
        P.confirmar("Esta etiqueta (" + P.f.kilos(p.peso) + " de «" + p.nombre + "») ya está en la venta. ¿Es otro paquete con el mismo peso?", { titulo: "Etiqueta repetida", aceptar: "Sí, es otro paquete" })
          .then(function (ok) { if (ok) sumarEtiqueta(); else combo.foco(); });
        return;
      }
      if (p.etiqueta) P.aviso("La etiqueta de balanza trae " + P.f.kilos(p.peso) + ", pero «" + p.nombre + "» se vende por unidad: se sumó 1. Revisá la cantidad.", "info", 7000);
      // Pesable sin etiqueta (no se pudo leer o se pesó en otra balanza): se escribe el peso.
      if (pesable) {
        pedirPeso(p).then(function (kg) {
          if (kg) {
            var manual = estado.items.filter(function (i) { return i.producto.id === p.id && !i.etiqueta; })[0];
            if (manual) manual.cantidad = P.redondear(manual.cantidad + kg, 3);
            else estado.items.push({ producto: p, cantidad: kg });
            estado.resaltar = p.id;
            pintarTodo();
          }
          combo.foco();
        });
        return;
      }
      var existente = estado.items.filter(function (i) { return i.producto.id === p.id && !i.etiqueta; })[0];
      if (existente) existente.cantidad = P.redondear(existente.cantidad + 1, 3);
      else { existente = { producto: p, cantidad: 1 }; estado.items.push(existente); }
      estado.resaltar = p.id;
      pintarTodo();
      combo.foco();
    }

    // Peso de un producto que se vende por kilo, en kilos o en gramos, con el importe a la vista.
    function pedirPeso(p) {
      return new Promise(function (resolver) {
        var unidad = "kg";
        var listo = null;
        var valor = P.input({ inputmode: "decimal", placeholder: "Ej.: 0,250", autofocus: true });
        var importe = h("p.texto-3", { "aria-live": "polite" }, "Precio: " + P.f.pesos(p.precio_venta) + " por kilo.");
        var selector = P.segmentado([{ valor: "kg", texto: "Kilos" }, { valor: "g", texto: "Gramos" }], unidad, function (v) {
          unidad = v;
          valor.placeholder = v === "g" ? "Ej.: 250" : "Ej.: 0,250";
          calcular();
          valor.focus();
        });
        function kilos() {
          var n = P.numeroDe(valor.value);
          if (!(n > 0)) return null;
          return P.redondear(unidad === "g" ? n / 1000 : n, 3);
        }
        function calcular() {
          var kg = kilos();
          importe.textContent = kg ? P.f.kilos(kg) + " × " + P.f.pesos(p.precio_venta) + "/kg = " + P.f.pesos(P.redondear(p.precio_venta * kg, 2)) : "Precio: " + P.f.pesos(p.precio_venta) + " por kilo.";
        }
        valor.addEventListener("input", calcular);
        var aceptar = P.btn("Agregar", { tipo: "primario", icono: "mas", onclick: function () {
          var kg = kilos();
          if (!kg || kg > 99.999) { valor.classList.add("invalido"); valor.focus(); P.aviso("Escribí el peso (hasta 99,999 kg)", "error"); return; }
          listo = kg;
          m.cerrar();
        } });
        valor.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); aceptar.click(); } });
        var m = P.modal({
          titulo: "¿Cuánto pesa?", subtitulo: p.nombre + (p.codigo ? " · Código " + p.codigo : ""),
          contenido: h("div.columna", P.campo("Peso", h("div.fila", valor, selector)), importe,
            h("p.texto-3.chico", { style: { margin: 0 } }, "Si tenés la etiqueta de la balanza, escaneala: carga el peso sola y queda registrada.")),
          acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), aceptar],
          alCerrar: function () { resolver(listo); },
        });
      });
    }

    function pintarItems() {
      P.vaciar(tablaItems);
      camposCantidad = [];
      if (!estado.items.length) {
        tablaItems.appendChild(h("div.items-vacio",
          ilustracionVacia(),
          h("strong", "Escaneá el primer producto"),
          h("span.chico", "También podés buscarlo por nombre y elegirlo en la lista. Un código completo que coincide se carga con Enter.")));
        return;
      }
      // Cuánto se pide de cada producto entre todos sus renglones (varias etiquetas del mismo fiambre).
      var pedidoPorProducto = {};
      estado.items.forEach(function (it) { pedidoPorProducto[it.producto.id] = P.redondear((pedidoPorProducto[it.producto.id] || 0) + it.cantidad, 3); });
      var filas = estado.items.map(function (it, i) {
        var pesable = it.producto.unidad === "KG";
        var sinStock = !it.producto.stock_oculto && it.producto.stock_boca < pedidoPorProducto[it.producto.id];
        var quitar = h("td.acciones", P.btn("", { tipo: "texto", chico: true, icono: "cerrar", etiqueta: "Quitar", onclick: function () { estado.items.splice(i, 1); pintarTodo(); combo.foco(); } }));
        var detalle = h("div.texto-3.chico", [it.producto.codigo, it.etiqueta ? "Etiqueta " + it.etiqueta : (pesable ? "Peso cargado a mano" : null),
          sinStock ? "Stock en la boca: " + P.f.cantidad(it.producto.stock_boca, it.producto.unidad) : null].filter(Boolean).join(" · "));
        var importe = h("td.der.dinero", P.f.pesos(it.producto.precio_venta) + (pesable ? "/kg" : ""));
        if (it.etiqueta) {
          // El peso de la etiqueta no se edita: si está mal, se quita el renglón y se vuelve a pesar.
          camposCantidad[i] = null;
          return h("tr" + (estado.resaltar === it.producto.id ? ".nuevo" : ""),
            h("td", h("div.cant.cant-balanza", { title: "Peso de la etiqueta de balanza" }, P.icono("candado"), h("strong.numero", P.f.kilos(it.cantidad)))),
            h("td", h("strong", it.producto.nombre), detalle), importe,
            h("td.der.dinero.fuerte", P.f.pesos(subtotal(it))), quitar);
        }
        var cant = h("input.campo-control", { value: P.f.numero(it.cantidad), inputmode: "decimal", "aria-label": (pesable ? "Kilos de " : "Cantidad de ") + it.producto.nombre });
        camposCantidad[i] = cant;
        if (pesable) {
          cant.addEventListener("change", function () {
            var n = P.numeroDe(cant.value);
            if (!(n > 0)) { cant.value = P.f.numero(it.cantidad); return; }
            it.cantidad = P.redondear(n, 3);
            pintarTodo();
          });
          cant.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cant.blur(); combo.foco(); } });
          return h("tr" + (estado.resaltar === it.producto.id ? ".nuevo" : ""),
            h("td", h("div.cant.cant-peso", cant, h("span.cant-unidad", "kg"))),
            h("td", h("strong", it.producto.nombre), detalle), importe,
            h("td.der.dinero.fuerte", P.f.pesos(subtotal(it))), quitar);
        }
        cant.addEventListener("change", function () {
          var n = P.numeroDe(cant.value);
          if (!(n > 0)) { cant.value = P.f.numero(it.cantidad); return; }
          it.cantidad = P.redondear(n, 3);
          pintarTodo();
        });
        cant.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cant.blur(); combo.foco(); } });
        return h("tr" + (estado.resaltar === it.producto.id ? ".nuevo" : ""),
          h("td", h("div.cant",
            P.btn("", { tipo: "texto", chico: true, icono: "menos", etiqueta: "Restar uno", onclick: function () { if (it.cantidad > 1) { it.cantidad = P.redondear(it.cantidad - 1, 3); pintarTodo(); } } }),
            cant,
            P.btn("", { tipo: "texto", chico: true, icono: "mas", etiqueta: "Sumar uno", onclick: function () { it.cantidad = P.redondear(it.cantidad + 1, 3); pintarTodo(); } }))),
          h("td", h("strong", it.producto.nombre), detalle), importe,
          h("td.der.dinero.fuerte", P.f.pesos(subtotal(it))), quitar);
      });
      var vaciarItems = P.btn("", { tipo: "texto", chico: true, icono: "borrar", etiqueta: "Vaciar lista de productos", onclick: function () {
        P.confirmar("¿Sacar todos los productos de la venta en curso?", { aceptar: "Vaciar", peligro: true }).then(function (ok) {
          if (!ok) return;
          estado = vacia();
          pintarTodo();
          combo.foco();
        });
      } });
      tablaItems.appendChild(h("div.tabla-desplazable", h("table.tabla.items",
        h("thead", h("tr", h("th", "Cantidad"), h("th", "Producto"), h("th.der", "Importe"), h("th.der", "Subtotal"),
          h("th.acciones", { scope: "col" }, vaciarItems))),
        h("tbody", filas))));
      estado.resaltar = null;
    }

    function subtotal(it) {
      return P.redondear(it.producto.precio_venta * it.cantidad, 2);
    }
    function total() {
      return P.redondear(estado.items.reduce(function (s, it) { return s + subtotal(it); }, 0), 2);
    }

    // ---------------------------------------------------------------- cuenta
    var cuenta = h("aside.hoja.cuenta", { "aria-label": "Cobro" });

    var buscarHuesped = P.combo({
      abrirAlEnfocar: false, elegirExactoAlEscribir: true, elegirUnico: false,
      buscar: function (texto) {
        if (!texto) return Promise.resolve([]);
        return P.get("/saldos/presentes" + P.qs({ q: texto })).then(function (filas) {
          return filas.map(function (p) {
            return { valor: p.id, texto: p.nombre, exacto: p.exacto, dato: p,
              detalle: ["DNI " + p.dni, p.legajo ? "Legajo " + p.legajo : "", "T-" + p.reserva_id].filter(Boolean).join(" · "),
              lado: P.f.pesos(p.saldo) };
          });
        });
      },
      alElegir: function (opcion) {
        estado.huesped = opcion.dato;
        pintarTodo();
        (document.getElementById("parte-pago") || (botonCobrar.disabled ? document.getElementById("dividir-pago") : botonCobrar)).focus();
      }
    });
    buscarHuesped.input.maxLength = 30;
    P.alSalir(buscarHuesped.limpiar);
    var recibido = P.dinero({ placeholder: "Monto recibido" });
    recibido.addEventListener("input", function () { estado.recibido = recibido.value; pintarTotales(); guardarBorrador(); });
    recibido.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cobrar(); } });
    var codigo = P.input({ placeholder: "Opcional: número de operación", max: 60 });
    codigo.addEventListener("input", function () { estado.codigo = codigo.value; guardarBorrador(); });
    codigo.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); cobrar(); } });

    var zonaAfiliado = h("div.cuenta-bloque");
    var zonaFormas = h("div.cuenta-bloque");
    var dividir = P.check("Dividir entre dos formas de pago", !!estado.segunda, null, function (marcado) {
      estado.segunda = marcado ? (estado.forma === "EFECTIVO" ? "QR" : "EFECTIVO") : null;
      estado.parte = "";
      estado.recibido = "";
      pintarTodo();
      if (marcado) document.getElementById("parte-pago").focus();
    });
    dividir.input.id = "dividir-pago";
    var zonaPago = h("div");
    var zonaTotal = h("div");
    var botonCobrar = P.btn("Cobrar", { tipo: "primario", grande: true, icono: "check", tecla: "F9", onclick: function () { cobrar(); } });
    botonCobrar.style.width = "100%";
    var comanda = P.check("Imprimir comanda", !!puesto.imprimir_comanda, null, function (valor) {
      var anterior = !!puesto.imprimir_comanda;
      comanda.input.disabled = true;
      P.post("/cajas/" + puesto.caja_id + "/comanda", { imprimir_comanda: valor }).then(function (r) {
        puesto.imprimir_comanda = !!r.imprimir_comanda;
        comanda.input.checked = puesto.imprimir_comanda;
        if (P.estado.sesion.puesto) P.estado.sesion.puesto.imprimir_comanda = puesto.imprimir_comanda;
      }).catch(function (e) { comanda.input.checked = anterior; P.error(e); }).finally(function () { comanda.input.disabled = false; });
    });
    comanda.input.setAttribute("data-sin-reanudar", "");

    function partes() {
      var n = estado.segunda ? P.importeDe(estado.parte) : total();
      var a=[{forma:estado.forma,importe:n}];
      if(estado.segunda)a.push({forma:estado.segunda,importe:P.redondear(total()-n,2)});
      return a.map(function(p){if(p.forma==="SALDO")p.huesped_id=estado.huesped&&estado.huesped.id;return p;});
    }
    function usaSaldo(){return estado.forma === "SALDO" || estado.segunda === "SALDO";}
    function pintarAfiliado() {
      P.vaciar(zonaAfiliado);
      zonaAfiliado.hidden = !usaSaldo();
      if (zonaAfiliado.hidden) {
        estado.huesped = null;
        buscarHuesped.limpiar();
        return;
      }
      if (!estado.huesped) zonaAfiliado.appendChild(P.campo("DNI o legajo del huésped", buscarHuesped.el));
      else zonaAfiliado.appendChild(h("div.columna", h("strong", estado.huesped.nombre + " · T-" + estado.huesped.reserva_id),
        h("span", "Saldo: " + P.f.pesos(estado.huesped.saldo)), P.btn("Cambiar persona", { tipo: "texto", onclick: function () {
          estado.huesped = null; buscarHuesped.limpiar(); pintarTodo(); buscarHuesped.foco();
        }})));
    }
    function pintarFormas() {
      P.vaciar(zonaFormas);
      zonaFormas.appendChild(h("h2", "Forma de pago"));
      zonaFormas.appendChild(h("div.formas", { style: { marginTop: "10px" } }, FORMAS.map(function (f) {
        return h("button.forma", { type: "button", "aria-pressed": String(estado.forma === f.valor), onclick: function () {
          estado.forma = f.valor; if(estado.segunda===f.valor)estado.segunda=null;
          pintarTodo();
          if (usaSaldo() && !estado.huesped) buscarHuesped.foco();
          else if (f.valor === "EFECTIVO") recibido.focus();
          else zonaFormas.querySelector('[aria-pressed="true"]').focus();
        } }, P.icono(f.icono), f.texto);
      })));
    }

    function pintarPago() {
      P.vaciar(zonaPago);
      dividir.input.checked = !!estado.segunda;
      if(estado.segunda){
        var segundo = P.select(FORMAS.filter(function (f) { return f.valor !== estado.forma; }), estado.segunda, {
          alCambiar: function (v) {
            estado.segunda = v;
            pintarTodo();
            if (usaSaldo() && !estado.huesped) buscarHuesped.foco();
            else document.getElementById("segundo-pago").focus();
          }
        });
        segundo.id = "segundo-pago";
        var parte=P.dinero({valor:estado.parte,placeholder:"0,00",id:"parte-pago"});
        parte.addEventListener("input",function(){estado.parte=parte.value;pintarTotales();guardarBorrador();});
        zonaPago.appendChild(h("div.cuenta-bloque.columna", P.campo("Importe con " + FORMAS.find(function(f){return f.valor===estado.forma;}).texto, parte),
          P.campo("Segunda forma de pago", segundo), h("p#resto-pago", {"aria-live":"polite"})));
      }
      if(estado.forma==="EFECTIVO"||estado.segunda==="EFECTIVO"){
        recibido.value=estado.recibido;zonaPago.appendChild(h("div.cuenta-bloque",P.campo("Efectivo recibido",recibido,{ayuda:"Dejalo vacío si recibís el importe justo."}),h("div#vuelto")));
      }
      if(estado.forma!=="EFECTIVO"&&estado.forma!=="SALDO"&&!estado.segunda){codigo.value=estado.codigo;zonaPago.appendChild(P.campo("Código de pago (opcional)",codigo));}
    }
    function pintarTotales() {
      var t = total();
      P.reemplazar(zonaTotal, h("div.total", h("span", "Total"), h("strong", P.f.pesos(t))));
      var v = document.getElementById("vuelto");
      var habilitado = estado.items.length > 0;
      var pagos=partes();var cash=pagos.find(function(p){return p.forma==="EFECTIVO";});
      var resto = document.getElementById("resto-pago");
      if (resto) {
        var segundoMedio = FORMAS.find(function (f) { return f.valor === estado.segunda; }).texto;
        resto.textContent = !Number.isFinite(pagos[0].importe) ? "Ingresá el primer importe para calcular el resto." :
          pagos[1].importe < 0 ? "El primer importe supera el total." : "Resto con " + segundoMedio + ": " + P.f.pesos(pagos[1].importe);
      }
      if(pagos.some(function(p){return !(p.importe>0)||(p.forma==="SALDO"&&(!estado.huesped||p.importe>Number(estado.huesped.saldo)));}))habilitado=false;
      var problema="";
      if (estado.segunda && pagos.some(function (p) { return !(p.importe > 0); })) problema = "Ingresá un importe mayor que cero y menor que el total, con hasta dos decimales.";
      pagos.forEach(function(p){if(p.forma!=="SALDO")return;
        var disponible=estado.huesped ? Number(estado.huesped.saldo) : 0;
        if(!estado.huesped)problema="Elegí un huésped para completar el cobro.";
        else if(p.importe>disponible)problema="Faltan "+P.f.pesos(p.importe-disponible)+" en el saldo de la estadía. Podés cambiar la distribución.";
      });
      if (v && cash) {
        P.vaciar(v);
        v.className = "";
        var r = P.importeDe(estado.recibido);
        if (estado.recibido && !Number.isFinite(r)) problema = "Corregí el efectivo recibido: usá un importe con hasta dos decimales.";
        else if (estado.recibido && Number.isFinite(cash.importe)) {
          if (r >= cash.importe) { v.className = "vuelto"; v.appendChild(h("span", "Vuelto")); v.appendChild(h("strong", P.f.pesos(r - cash.importe))); }
          else { v.className = "vuelto falta"; v.appendChild(h("span", "Falta")); v.appendChild(h("strong", P.f.pesos(cash.importe - r))); habilitado = false; }
        }
      }
      if(problema&&estado.items.length){zonaTotal.appendChild(h("p.texto-3",{"aria-live":"polite"},problema));habilitado=false;}
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

    cuenta.appendChild(zonaFormas);
    cuenta.appendChild(dividir);
    cuenta.appendChild(zonaAfiliado);
    cuenta.appendChild(zonaPago);
    cuenta.appendChild(zonaTotal);
    cuenta.appendChild(h("div.cuenta-bloque", comanda));
    cuenta.appendChild(botonCobrar);

    c.appendChild(h("div.vender", izquierda, cuenta));
    pintarTodo();
    if (datosPrevios) {
      combo.input.value = datosPrevios.producto;
      if (usaSaldo() && !estado.huesped) buscarHuesped.input.value = datosPrevios.huesped;
    }
    P.continuidad.guardarPantalla(function () {
      var items = estado.items.map(function (it, i) {
        if (!camposCantidad[i]) return it;
        var valor = camposCantidad[i].value;
        if (valor === P.f.numero(it.cantidad)) return it;
        var cantidad = P.redondear(P.numeroDe(valor), 3);
        if (!(cantidad > 0)) throw new Error("Cantidad en edición");
        return Object.assign({}, it, { cantidad: cantidad });
      });
      return { caja: puesto.caja_id, producto: combo.input.value, huesped: buscarHuesped.input.value,
        venta: Object.assign({}, estado, { items: items }), ultimaVenta: ultimaVenta };
    });

    // ---------------------------------------------------------------- cobrar
    var cobrando = false;
    function identificarVenta(cuerpo) {
      var firma = JSON.stringify(cuerpo);
      if (!estado.intento || estado.intento.firma !== firma) {
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        estado.intento = { firma: firma, clave: Array.prototype.map.call(bytes, function (n) {
          return ("0" + n.toString(16)).slice(-2);
        }).join("") };
        guardarBorrador();
      }
      return estado.intento.clave;
    }
    function cobrar() {
      if (cobrando || botonCobrar.disabled || !estado.items.length) return;
      cobrando = true;
      var cuerpo = {
        items: estado.items.map(function (it) { return { producto_id: it.producto.id, cantidad: it.cantidad, precio_unitario: it.producto.precio_venta, etiqueta: it.etiqueta || undefined }; }),
        forma_pago: estado.segunda ? "MIXTO" : estado.forma,
        pagos: partes(),
        recibido: (estado.forma === "EFECTIVO" || estado.segunda === "EFECTIVO") && estado.recibido ? P.importeDe(estado.recibido) : null,
        codigo_pago: !estado.segunda && estado.forma !== "EFECTIVO" && estado.forma !== "SALDO" ? estado.codigo : null,
      };
      P.ejecutar(botonCobrar, function () {
        cuerpo.operacion = identificarVenta(cuerpo);
        return P.post("/ventas", cuerpo).catch(informarFaltantes).then(function (r) {
          if (!r) return;
          ultimaVenta = r.id;
          try { sessionStorage.setItem("predio.ultima-venta." + puesto.caja_id, String(r.id)); } catch (e) { /* nada */ }
          estado = vacia();
          pintarTodo();
          ventaHecha(r);
        });
      }).catch(function (e) {
        if (e.codigo === "PRECIOS_CAMBIARON" && Array.isArray(e.datos.precios)) {
          e.datos.precios.forEach(function (p) {
            estado.items.forEach(function (linea) { if (Number(linea.producto.id) === Number(p.producto_id)) linea.producto.precio_venta = p.precio_venta; });
          });
          pintarTodo();
        } else if (usaSaldo() && e.status === 409) {
          estado.huesped = null; buscarHuesped.limpiar(); pintarTodo();
        }
      }).finally(function () { cobrando = false; pintarTotales(); });
    }

    function informarFaltantes(e) {
      var faltantes = (e.datos && e.datos.faltantes) || [];
      if (e.codigo !== "SIN_STOCK" || !faltantes.length) throw e;
      return P.confirmar(h("div.columna",
        P.mensaje(h("div", "La venta sigue pendiente. Revisá las cantidades o pedí una reposición.", h("ul", faltantes.map(function (f) {
          return h("li", h("strong", f.producto), " · se necesitan " + P.f.numero(f.pedido) + " · disponible " + P.f.numero(f.disponible));
        }))), "aviso")), {
        titulo: "Stock insuficiente en esta boca", aceptar: "Avisar al administrador",
      }).then(function (aceptado) {
        if (!aceptado) return null;
        return faltantes.reduce(function (promesa, f) {
          return promesa.then(function () {
            return P.post("/ventas/avisar-sin-stock", { producto_id: f.producto_id, busqueda: f.producto, cantidad: f.pedido, insumo: !!f.insumo, confirmar: true });
          });
        }, Promise.resolve()).then(function () { P.aviso("Aviso enviado al administrador.", "ok"); return null; });
      });
    }

    function ventaHecha(r) {
      var auto = !!(puesto.impresion_automatica === undefined ? 1 : Number(puesto.impresion_automatica));
      if (auto) P.imprimirVenta(r.id).catch(P.error);
      mostrarVentaHecha({ caja: puesto.caja_id, id: r.id, total: r.total, vuelto: r.vuelto, auto: auto });
    }
    function mostrarVentaHecha(r) {
      var m = P.modal({
        titulo: "Venta N° " + r.id + " registrada",
        reanudar: { id: "venta-registrada", datos: r },
        contenido: h("div.columna",
          h("div.total", h("span", "Total"), h("strong", P.f.pesos(r.total))),
          r.vuelto ? h("div.vuelto", h("span", "Vuelto"), h("strong", P.f.pesos(r.vuelto))) : null,
          r.auto ? h("p.texto-3.chico", { style: { margin: 0 } }, "El ticket se está imprimiendo.") : null),
        acciones: [
          P.btn(r.auto ? "Imprimir otra copia" : "Imprimir ticket", { tipo: "secundario", icono: "imprimir", onclick: function () { P.imprimirVenta(r.id).catch(P.error); } }),
          P.btn("Nueva venta", { tipo: "primario", tecla: "Enter", onclick: function () { m.cerrar(); } }),
        ],
        alCerrar: function () { setTimeout(function () { combo.foco(); }, 50); },
      });
      return m;
    }
    P.continuidad.registrarVentana("venta-registrada", function (datos) {
      if (datos.caja === puesto.caja_id && datos.id === ultimaVenta) return mostrarVentaHecha(datos);
    });

    // ---------------------------------------------------------------- teclado
    function teclas(ev) {
      if (P.hayVentana()) return;
      if (ev.key === "F2") { ev.preventDefault(); combo.foco(); }
      else if (ev.key === "F4") { ev.preventDefault(); if (usaSaldo()&&!estado.huesped) buscarHuesped.foco(); }
      else if (ev.key === "F9") { ev.preventDefault(); cobrar(); }
    }
    document.addEventListener("keydown", teclas);
    P.alSalir(function () { document.removeEventListener("keydown", teclas); });
    function mostrarAtajos() {
      var movil = window.innerWidth <= 760;
      combo.input.placeholder = "Escaneá el código o escribí el producto" + (movil ? "" : "  (F2)");
      buscarHuesped.input.placeholder = "DNI o legajo" + (movil ? "" : "  (F4)");
    }
    mostrarAtajos();
    window.addEventListener("resize", mostrarAtajos);
    P.alSalir(function () { window.removeEventListener("resize", mostrarAtajos); });
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
