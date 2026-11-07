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

  function filtroProductos(alCambiar) {
    var buscar = P.input({ tipo: "search", placeholder: "Nombre o código" });
    function normalizar(t) { return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
    buscar.addEventListener("input", alCambiar);
    return {
      el: P.campo("Filtrar productos", buscar),
      input: buscar,
      incluye: function (nombre, codigo) {
        var texto = normalizar(nombre + " " + (codigo || ""));
        return normalizar(buscar.value).trim().split(/\s+/).every(function (palabra) { return texto.indexOf(palabra) >= 0; });
      },
    };
  }

  P.verCompra = function (id, alCambiar, reanudar) {
    return P.get("/compras/" + id).then(function (d) {
      var c = d.compra;
      var temporal = c.estado === "TEMPORAL";
      var descartada = c.estado === "DESCARTADA";
      var diferencia = c.total_factura == null ? 0 : P.redondear(c.total_factura - c.total_items);
      var filas = h("tbody");
      var filtro = filtroProductos(pintarDetalle);
      function pintarDetalle() {
        var visibles = d.items.filter(function (i) { return filtro.incluye(i.producto, i.codigo); });
        P.reemplazar(filas, visibles.length ? visibles.map(function (i) {
          return h("tr", h("td", h("strong", i.producto), h("div.texto-3.chico", i.codigo || "")), h("td.der", P.f.numero(i.cantidad)), h("td.der", P.f.pesos(i.precio_unitario)),
            h("td.der.texto-3", P.f.pesos(i.precio_anterior)), h("td.der", P.f.pct(i.margen)),
            h("td.der", P.f.pesos(i.precio_venta), h("div.texto-3.chico", Number(i.actualizo_precio) ? "Actualizado" : "Conservado")), h("td.der.fuerte", P.f.pesos(i.subtotal)));
        }) : h("tr", h("td", { colspan: "7" }, "Ningún producto coincide con el filtro.")));
      }
      pintarDetalle();
      var m = P.modal({
        titulo: (temporal ? "Compra temporal N° " : "Compra N° ") + c.id, subtitulo: c.proveedor + (c.factura ? " · Factura " + c.factura : "") + (c.remito ? " · Remito " + c.remito : ""),
        reanudar: reanudar ? { id: "compra-detalle", datos: { id: c.id } } : null,
        ancho: "ancha",
        contenido: h("div.columna",
          temporal ? P.mensaje("La mercadería ya ingresó al stock. Completá la factura y revisá los productos para finalizar la compra.") : null,
          c.estado === "ANULADA" || descartada ? P.mensaje((descartada ? "Temporal descartada" : "Compra anulada") + " el " + P.f.fechaHora(c.anulada_fecha) + " por " + c.anulada_por + ": " + (c.anulacion_motivo || ""), "error") : null,
          h("div.datos",
            P.dato("Fecha de factura", P.f.fecha(c.fecha_factura)), P.dato("Fecha de remito", P.f.fecha(c.fecha_remito)),
            P.dato("Total de la factura", c.total_factura == null ? "Pendiente" : P.f.pesos(c.total_factura)), P.dato("Recibió", c.boca), P.dato("Cargó", c.creado_por + " · " + P.f.fechaHora(c.fecha_creacion))),
          filtro.el,
          h("div.tabla-desplazable", h("table.tabla",
            h("thead", h("tr", h("th", "Producto"), h("th.der", "Cantidad"), h("th.der", "Unitario"), h("th.der", "Anterior"), h("th.der", "Margen"), h("th.der", "Venta"), h("th.der", "Total"))),
            filas, h("tfoot", h("tr", h("td", { colspan: "6" }, "Suma de todos los productos"), h("td.der", P.f.pesos(c.total_items)))))),
          diferencia && !temporal && !descartada ? P.mensaje("Redondeo de la factura: " + P.f.pesos(diferencia)) : null,
          c.observaciones ? P.mensaje(c.observaciones) : null),
        acciones: [
          temporal && puedeComprar() ? P.btn("Editar o finalizar", { tipo: "primario", icono: "editar", onclick: function () {
            m.cerrar(); P.ruta.ir("/compras/" + c.id + "/editar");
          } }) : null,
          P.esAdmin() && (temporal || c.estado === "CARGADA") ? P.btn(temporal ? "Descartar temporal" : "Anular compra", { tipo: "peligro", icono: "borrar", onclick: function () {
            P.pedirTexto((temporal ? "Descartar la temporal N° " : "Anular la compra N° ") + c.id, { etiqueta: "Motivo", requerido: true, aceptar: temporal ? "Descartar" : "Anular", peligro: true,
              subtitulo: temporal ? "Se descontará toda la mercadería recibida en esta temporal." : "Se descontará el stock ingresado. Se restaurarán los precios que todavía dependan de esta compra." }).then(function (motivo) {
              if (!motivo) return;
              P.post("/compras/" + c.id + "/anular", { motivo: motivo, temporal: temporal, revision: d.revision }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); m.cerrar(); if (alCambiar) alCambiar(); }).catch(P.error);
            });
          } }) : null,
          P.btn("Imprimir", { tipo: "secundario", icono: "imprimir", onclick: function () { P.imprimirCompra(d).catch(P.error); } }),
        ],
      });
      return m;
    }).catch(P.error);
  };

  P.ruta.registrar(/^\/compras$/, function (c) {
    c.appendChild(P.cabeceraConAcciones("Compras", null,
      puedeComprar() ? P.btn("Cargar compra", { tipo: "primario", icono: "mas", onclick: function () { P.ruta.ir("/compras/nueva"); } }) : null));
    var vista = P.esAdmin() ? P.cache["compras:vista"] || "compras" : "compras";
    var zona = h("div", { style: { marginTop: "14px" } });
    var tabla;
    if (P.esAdmin()) c.appendChild(P.segmentado([{ valor: "compras", texto: "Compras" }, { valor: "productos", texto: "Compras por producto" }], vista, function (v) { vista = v; P.cache["compras:vista"] = v; pintar(); }));
    c.appendChild(zona);
    function pintar() {
      tabla = vista === "compras"
        ? P.tabla({ listado: "compras", alClickFila: function (f) { abrirCompra(f.id); }, tituloVacio: "Todavía no hay compras", textoVacio: "Cargá la primera con «Cargar compra»." })
        : P.tabla({ listado: "compras_productos", alClickFila: function (f) { abrirCompra(f.compra_id); } });
      P.reemplazar(zona, tabla.el);
    }
    function abrirCompra(id) {
      var alCambiar = vista === "compras" ? tabla.recargar : null;
      return P.verCompra(id, alCambiar, true);
    }
    pintar();
    P.continuidad.registrarVentana("compra-detalle", function (datos) { return abrirCompra(datos.id); });
  }, { titulo: "Compras" });

  // ------------------------------------------------------------------ nueva compra
  function formulario(c, detalle) {
    if (!puedeComprar()) { c.appendChild(P.vacio("candado", "Las compras las carga la proveeduría o un administrador", "")); return; }
    var compra = detalle && detalle.compra;
    var CLAVE = compra ? null : "predio.compra-borrador";
    var anterior = P.continuidad.datosPantalla();
    var revision = detalle && detalle.revision;
    var estado = { proveedor: null, factura: "", fecha_factura: P.hoy(), remito: "", fecha_remito: "", total_factura: "", observaciones: "", lineas: [] };
    if (compra) {
      estado.proveedor = { valor: compra.proveedor_id, texto: compra.proveedor };
      ["factura", "fecha_factura", "remito", "fecha_remito", "observaciones"].forEach(function (k) { estado[k] = compra[k] || ""; });
      estado.total_factura = compra.total_factura == null ? "" : P.f.numero(compra.total_factura);
      estado.lineas = detalle.items.map(function (l) {
        return { cantidad: Number(l.cantidad), precio_unitario: Number(l.precio_unitario),
          producto: { id: l.producto_id, nombre: l.producto, codigo: l.codigo, precio_compra: Number(l.costo_vigente), margen: Number(l.margen_vigente), precio_venta: Number(l.venta_vigente) } };
      });
    } else {
      try { var b = JSON.parse(sessionStorage.getItem(CLAVE) || "null"); if (b && b.lineas) estado = Object.assign(estado, b); } catch (e) { /* nada */ }
    }
    if (anterior && anterior.estado) {
      estado = Object.assign(estado, anterior.estado);
      // Una edición recuperada mantiene la revisión con la que comenzó.
      revision = anterior.revision;
    }
    function guardar() { try { if (CLAVE) sessionStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (e) { /* nada */ } }

    var destinoStock = h("div.texto-3");
    if (compra) destinoStock.textContent = "Stock recibido en " + compra.boca + ". Sólo se aplicará la diferencia de cantidades.";
    else P.opciones("bocas", true).then(function (bocas) {
      var destino = bocas.find(function (boca) { return boca.es_almacen; });
      destinoStock.textContent = destino ? "Proveeduría que recibe el stock: " + destino.texto : "Falta elegir la proveeduría en Gestión → Bocas y cajas.";
    }).catch(P.error);
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/compras" }, P.icono("volver"), "Compras"),
      h("h1.titulo-pagina", compra ? "Editar compra temporal N° " + compra.id : "Cargar compra"))));

    // Factura
    var proveedor = P.combo({
      fuente: "proveedores", placeholder: "Elegí o escribí el proveedor",
      valor: estado.proveedor ? estado.proveedor.valor : null, texto: estado.proveedor ? estado.proveedor.texto : "",
      alElegir: function (o) { estado.proveedor = { valor: o.valor, texto: o.texto }; guardar(); },
      accionExtra: P.esAdmin() ? { texto: "Nuevo proveedor", onclick: function (texto) {
        nuevoProveedor({ razon_social: texto });
      } } : null,
    });
    function nuevoProveedor(base) {
      return P.formProveedor(base, function (r) {
        P.olvidarOpciones();
        estado.proveedor = { valor: r.id, texto: r.razon_social };
        proveedor.fijar(r.id, r.razon_social);
        guardar();
      }, null, { id: "compra-proveedor-nuevo", datos: base });
    }
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
            nuevoProveedor({});
          } }) : null), { requerido: true }),
        P.campo("Factura", campoTexto("factura", { placeholder: "Ej.: A-0002-00012345", max: 40 })),
        P.campo("Fecha de la factura", campoTexto("fecha_factura", { tipo: "date" })),
        P.campo("Remito", campoTexto("remito", { placeholder: "N° de remito", max: 40 })),
        P.campo("Fecha del remito", campoTexto("fecha_remito", { tipo: "date" })),
        P.campo("Total de la factura", h("div.campo-con-prefijo", h("span", "$"), totalFactura), { ayuda: "Obligatorio para finalizar la compra." })),
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
      return P.formProducto(base, function (r) {
        if (!r.id) { P.aviso("Cuando se sincronice el alta, buscá el producto por su nombre.", "info"); return; }
        P.get("/productos/" + r.id).then(function (detalle) {
          var p = detalle.producto;
          combo.fijar(p.id, p.nombre, { dato: p });
          elegido = p;
          unitario.value = P.f.numero(p.precio_compra);
          ayudaProducto.textContent = "Producto nuevo. Cargá cantidad y precio unitario.";
          cantidad.focus();
        }).catch(P.error);
      }, null, { id: "compra-producto-nuevo", datos: base });
    }
    function agregarLinea() {
      if (!elegido) { P.aviso("Elegí un producto", "error"); combo.foco(); return; }
      var cant = P.numeroDe(cantidad.value);
      var precio = P.importeDe(unitario.value);
      if (!Number.isFinite(cant) || !(P.redondear(cant, 3) > 0)) { P.aviso("La cantidad tiene que ser mayor que cero", "error"); cantidad.focus(); return; }
      cant = P.redondear(cant, 3);
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
    var cambiosEnLineas = [];
    var filtro = filtroProductos(pintarLineas);
    var resumen = h("div");
    var problemas = h("div");
    c.appendChild(h("div.hoja.hoja-cuerpo",
      h("div.fila-separada", h("h2.seccion-titulo", "Productos"),
        P.esAdmin() ? P.btn("Nuevo producto", { tipo: "secundario", chico: true, icono: "mas", onclick: function () { nuevoProducto({}); } }) : null),
      h("div.fila-campos", { style: { marginTop: "14px" } },
        P.campo("Producto", h("div", combo.el, ayudaProducto), { clase: "crece" }),
        P.campo("Cantidad", cantidad), P.campo("Precio unitario", h("div.campo-con-prefijo", h("span", "$"), unitario)),
        h("div.campo", h("span.campo-etiqueta", " "), P.btn("Agregar", { tipo: "celeste", icono: "mas", onclick: agregarLinea }))),
      filtro.el, h("div.compra-lineas", tablaLineas)));
    var revisarCompra = P.btn("Revisar compra", { tipo: "primario", grande: true, icono: "check", id: "cargar-compra", onclick: function () { revisar(); } });
    var guardarTemporal = P.btn(compra ? "Guardar cambios temporales" : "Recibir como temporal", { tipo: "secundario", onclick: revisarTemporal });
    c.appendChild(h("div.compra-resumen",
      h("div.columna", destinoStock, problemas),
      h("div.columna", resumen, guardarTemporal, revisarCompra)));

    function oferta(linea) {
      var ultimo = linea.producto.ultimo_costo;
      if (ultimo != null && linea.precio_unitario < Number(ultimo)) return "Costo menor al de la última compra (" + P.f.pesos(ultimo) + ").";
      if (linea.precio_unitario < Number(linea.producto.precio_compra)) return "Costo menor al de referencia (" + P.f.pesos(linea.producto.precio_compra) + ").";
      return "";
    }

    function pintarLineas() {
      P.vaciar(tablaLineas);
      cambiosEnLineas = [];
      if (!estado.lineas.length) {
        tablaLineas.appendChild(h("p.texto-3", { style: { margin: 0 } }, "Todavía no agregaste productos."));
        pintarResumen();
        return;
      }
      tablaLineas.appendChild(h("div.tabla-desplazable", h("table.tabla.lineas",
        h("thead", h("tr", h("th.der", "Cantidad"), h("th", "Producto"), h("th.der", "Costo unitario"), h("th.der", "Costo de referencia"), h("th.der", "Total"), h("th"))),
        h("tbody", estado.lineas.some(function (l) { return filtro.incluye(l.producto.nombre, l.producto.codigo); }) ? estado.lineas.map(function (l, i) {
          if (!filtro.incluye(l.producto.nombre, l.producto.codigo)) return null;
          function numero(clave, clase) {
            var mostrar = function (valor) { return String(valor).replace(".", ","); };
            var input = h("input.campo-control." + clase, { value: mostrar(l[clave]), inputmode: "decimal", "aria-label": (clave === "cantidad" ? "Cantidad de " : "Costo unitario de ") + l.producto.nombre });
            function leer() {
              var v = clave === "cantidad" ? P.numeroDe(input.value) : P.importeDe(input.value);
              if (clave === "cantidad") v = P.redondear(v, 3);
              return !Number.isFinite(v) || v < 0 || (clave === "cantidad" && v === 0) ? null : v;
            }
            input.addEventListener("change", function () {
              var v = leer();
              if (v === null) { input.value = mostrar(l[clave]); return; }
              l[clave] = v; guardar(); pintarLineas();
            });
            cambiosEnLineas.push(function (lineas) {
              if (input.value === mostrar(l[clave])) return;
              var v = leer();
              if (v === null) throw new Error("Importe o cantidad en edición");
              lineas[i][clave] = v;
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
        }) : h("tr", h("td", { colspan: "6" }, "Ningún producto coincide con el filtro."))))));
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
          : dif === 0 ? h("div.fuerte.cuadra", P.icono("check"), h("span", "Las cuentas cierran"))
            : h("div.fuerte.no-cuadra", h("span", "Diferencia de factura"), h("span.dinero", P.f.pesos(dif)))));
    }

    function revisarTemporal() {
      P.vaciar(problemas);
      if (!estado.proveedor || !estado.lineas.length) {
        P.reemplazar(problemas, P.mensaje("Elegí el proveedor y agregá al menos un producto recibido.", "error")); return;
      }
      if (estado.total_factura && !Number.isFinite(P.importeDe(estado.total_factura))) {
        P.reemplazar(problemas, P.mensaje("Revisá el total de la factura o dejalo pendiente.", "error")); return;
      }
      var m = P.modal({
        titulo: compra ? "Guardar la recepción corregida" : "Recibir mercadería sin factura definitiva",
        reanudar: { id: "compra-revision-temporal" },
        contenido: P.mensaje(compra ? "Se ajustará el stock por las unidades que agregaste o quitaste. La compra seguirá temporal."
          : "El stock de estos productos quedará disponible en la proveeduría. Podés reemplazar los renglones y completar la factura más adelante."),
        acciones: [P.btn("Volver", { tipo: "secundario", onclick: function () { m.cerrar(); } }),
          P.btn("Confirmar recepción temporal", { tipo: "primario", onclick: function (ev) { enviar(ev.currentTarget, null, m); } })],
      });
      return m;
    }

    function revisar(previa) {
      P.vaciar(problemas);
      var total = P.importeDe(estado.total_factura);
      var diferencia = P.redondear(total - suma());
      var limite = P.limiteRedondeoCompra(estado.lineas);
      var error;
      if (!estado.proveedor) error = "Elegí el proveedor de la factura.";
      else if (!estado.lineas.length) error = "Agregá al menos un producto a la compra.";
      else if (!estado.factura.trim() && !estado.remito.trim()) error = "Cargá el número de factura o de remito.";
      else if (estado.factura.trim() && !estado.fecha_factura) error = "Cargá la fecha de la factura.";
      else if (estado.remito.trim() && !estado.fecha_remito) error = "Cargá la fecha del remito.";
      else if (!Number.isFinite(total)) error = "Cargá el total de la factura.";
      else if (Math.abs(diferencia) > limite) error = "La diferencia supera el redondeo admisible de " + P.f.pesos(limite) + ". Revisá las cantidades y los precios unitarios.";
      if (error) { P.reemplazar(problemas, P.mensaje(error, "error")); return; }
      var contador = h("strong", { "aria-live": "polite" });
      var todos = P.check("Seleccionar todos", false, null, function (marcar) {
        controles.forEach(function (control) { control.input.checked = marcar; });
        actualizar();
      });
      var controles = estado.lineas.map(function (linea) {
        var nuevo = P.precioDeVenta(linea.precio_unitario, linea.producto.margen);
        var marcado = previa && previa.productos.indexOf(linea.producto.id) >= 0;
        return P.check(linea.producto.nombre, marcado, "Venta general: " + P.f.pesos(linea.producto.precio_venta) + " → " + P.f.pesos(nuevo), actualizar);
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
      var redondeoAceptado = previa && previa.redondeo === diferencia;
      var aceptarRedondeo = Math.abs(diferencia) > 0.05 ? P.check("Aplicar redondeo de " + P.f.pesos(diferencia), redondeoAceptado, null, function (aceptado) { confirmar.disabled = !aceptado; }) : null;
      var confirmar = P.btn("Confirmar compra", { tipo: "primario", icono: "check", onclick: function (ev) { enviar(ev.currentTarget, controles, m, diferencia); } });
      confirmar.disabled = !!aceptarRedondeo && !redondeoAceptado;
      var m = P.modal({
        titulo: "¿Qué precios querés actualizar?",
        reanudar: { id: "compra-revision-final", campos: false, datos: function () {
          return {
            productos: estado.lineas.filter(function (_linea, i) { return controles[i].input.checked; }).map(function (linea) { return linea.producto.id; }),
            redondeo: aceptarRedondeo && aceptarRedondeo.input.checked ? diferencia : null,
          };
        } },
        subtitulo: (compra ? "El stock se ajustará sólo por las diferencias con la recepción anterior." : "El stock ingresa a la proveeduría.") + " Marcá los precios que deban cambiar en caja.",
        contenido: h("div.columna",
          diferencia ? P.mensaje("Suma de productos: " + P.f.pesos(suma()) + ". Total facturado: " + P.f.pesos(total) + ". Redondeo: " + P.f.pesos(diferencia) + ".", "aviso") : null,
          aceptarRedondeo,
          estado.lineas.some(oferta) ? P.mensaje("Hay productos con un costo más bajo. Si son ofertas, dejalos sin marcar para conservar su precio de venta.", "aviso") : null,
          h("div.fila-separada", todos, contador), seleccion,
          h("div.texto-3.chico", "Las bocas con margen propio aplican ese margen sobre el nuevo costo. Los precios de venta se redondean hacia arriba a $100.")),
        acciones: [P.btn("Volver", { tipo: "secundario", onclick: function () { m.cerrar(); } }),
          confirmar],
      });
      return m;
    }

    function enviar(boton, controles, modal, diferencia) {
      var temporal = !controles;
      if (temporal && !compra && !estado.operacion) {
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        estado.operacion = Array.from(bytes, function (n) { return n.toString(16).padStart(2, "0"); }).join("");
        guardar();
      }
      var cuerpo = {
        temporal: temporal, operacion: temporal && !compra ? estado.operacion : undefined, revision: revision, redondeo_confirmado: diferencia,
        proveedor_id: estado.proveedor ? estado.proveedor.valor : null,
        factura: estado.factura, fecha_factura: estado.fecha_factura || null, remito: estado.remito, fecha_remito: estado.fecha_remito || null,
        total_factura: estado.total_factura === "" ? null : P.importeDe(estado.total_factura), observaciones: estado.observaciones,
        items: estado.lineas.map(function (l, i) { return {
          producto_id: l.producto.id, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
          actualizar_precio: !temporal && controles[i].input.checked, costo_referencia: l.producto.precio_compra,
        }; }),
      };
      revisarCompra.disabled = true;
      guardarTemporal.disabled = true;
      var ruta = compra ? "/compras/" + compra.id + "/revisar" : temporal ? "/compras/temporal" : "/compras";
      P.ejecutar(boton, function () {
        return P.post(ruta, cuerpo).then(function (r) {
          modal.cerrar();
          try { if (CLAVE) sessionStorage.removeItem(CLAVE); } catch (e) { /* nada */ }
          if (!r.encolado) P.aviso(r.mensaje || "Compra cargada", "ok");
          (r.avisos || []).forEach(function (a) { P.aviso(a, "cola", 9000); });
          P.ruta.ir("/compras");
        });
      }).catch(function (e) {
        modal.cerrar();
        var lista = e.datos && e.datos.problemas;
        P.reemplazar(problemas, h("div.mensaje.mensaje-error", P.icono("alerta"), h("div", h("strong", "Revisá la compra antes de cargarla"),
          lista && lista.length ? h("ul", lista.map(function (x) { return h("li", x); })) : h("div", e.message))));
        problemas.scrollIntoView({ behavior: "smooth", block: "center" });
      }).finally(function () { revisarCompra.disabled = false; guardarTemporal.disabled = false; });
    }

    if (anterior) {
      elegido = anterior.producto;
      if (elegido) combo.fijar(elegido.id, elegido.nombre, { dato: elegido });
      combo.input.value = anterior.busquedaProducto;
      ayudaProducto.textContent = anterior.ayudaProducto;
      if (!anterior.proveedorElegido) proveedor.fijar(null);
      proveedor.input.value = anterior.busquedaProveedor;
      cantidad.value = anterior.cantidad;
      unitario.value = anterior.unitario;
      filtro.input.value = anterior.filtro;
    }
    pintarLineas();
    P.continuidad.guardarPantalla(function () {
      var lineas = estado.lineas.map(function (linea) { return Object.assign({}, linea); });
      cambiosEnLineas.forEach(function (capturar) { capturar(lineas); });
      return { estado: Object.assign({}, estado, { lineas: lineas }), revision: revision, producto: elegido, busquedaProducto: combo.input.value,
        ayudaProducto: ayudaProducto.textContent, proveedorElegido: proveedor.valor(), busquedaProveedor: proveedor.input.value,
        cantidad: cantidad.value, unitario: unitario.value, filtro: filtro.input.value };
    });
    P.continuidad.registrarVentana("compra-revision-temporal", revisarTemporal);
    P.continuidad.registrarVentana("compra-revision-final", revisar);
    if (P.esAdmin()) {
      P.continuidad.registrarVentana("compra-proveedor-nuevo", nuevoProveedor);
      P.continuidad.registrarVentana("compra-producto-nuevo", nuevoProducto);
    }
  }
  P.ruta.registrar(/^\/compras\/nueva$/, function (c) { formulario(c); }, { titulo: "Cargar compra" });
  P.ruta.registrar(/^\/compras\/(\d+)\/editar$/, function (c, params) {
    return P.get("/compras/" + params[0]).then(function (d) {
      if (d.compra.estado !== "TEMPORAL") { P.aviso("La compra ya se finalizó o se descartó.", "error"); P.ruta.ir("/compras"); return; }
      formulario(c, d);
    });
  }, { titulo: "Editar compra temporal" });
})();
