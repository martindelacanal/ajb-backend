/* Estadísticas: cifras, gráficos y listados (ventas, por producto, compras por proveedor,
   movimientos de almacén y entre bocas). */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;
  var siguientePeriodo = 0;

  var LISTADOS = [
    { valor: "ventas", texto: "Ventas" },
    { valor: "ventas_productos", texto: "Ventas por producto" },
    { valor: "compras", texto: "Compras por proveedor" },
    { valor: "almacen", texto: "Movimientos de almacén" },
    { valor: "solicitudes", texto: "Movimientos entre bocas" },
    { valor: "bajas", texto: "Bajas" },
  ];

  function temporadaActual() {
    var hoy = P.hoy();
    var anio = Number(hoy.slice(0, 4));
    var mes = Number(hoy.slice(5, 7));
    var inicio = mes >= 7 ? anio + "-12-01" : (anio - 1) + "-12-01";
    return { desde: inicio, hasta: hoy < inicio ? hoy : hoy };
  }

  function pantalla(c, params, q, vistaInicial) {
    var estado = P.cache["estadisticas"] || { desde: P.sumarDias(P.hoy(), -29), hasta: P.hoy(), boca: "" };
    var desde = P.input({ tipo: "date", valor: estado.desde });
    var hasta = P.input({ tipo: "date", valor: estado.hasta });
    var boca = P.select([], estado.boca, { vacio: "Todas las bocas" });
    P.opciones("bocas_venta").then(function (ops) { ops.forEach(function (o) { var op = h("option", { value: o.valor }, o.texto); if (String(o.valor) === String(estado.boca)) op.selected = true; boca.appendChild(op); }); });
    function rango(d, hs) { desde.value = d; hasta.value = hs; cargar(); }
    var idPeriodo = "estadisticas-periodo-" + (++siguientePeriodo);
    var filtrosPeriodo = h("div.tabla-filtros.tabla-periodo-controles", { id: idPeriodo, hidden: true },
      h("div.filtro-rango-fechas", { role: "group", "aria-label": "Período" }, P.campo("Desde", desde), P.campo("Hasta", hasta)), P.campo("Boca", boca),
      h("div.campo", h("span.campo-etiqueta", "Período rápido"), h("div.fila", { style: { gap: "6px" } },
        P.btn("Hoy", { tipo: "suave", chico: true, onclick: function () { rango(P.hoy(), P.hoy()); } }),
        P.btn("7 días", { tipo: "suave", chico: true, onclick: function () { rango(P.sumarDias(P.hoy(), -6), P.hoy()); } }),
        P.btn("30 días", { tipo: "suave", chico: true, onclick: function () { rango(P.sumarDias(P.hoy(), -29), P.hoy()); } }),
        P.btn("Temporada", { tipo: "suave", chico: true, onclick: function () { var t = temporadaActual(); rango(t.desde, t.hasta); } }))));
    var botonPeriodo = P.btn("Período y boca", { tipo: "secundario", icono: "filtro", onclick: function () {
      filtrosPeriodo.hidden = !filtrosPeriodo.hidden;
      botonPeriodo.setAttribute("aria-expanded", String(!filtrosPeriodo.hidden));
    } });
    botonPeriodo.id = idPeriodo + "-boton";
    botonPeriodo.setAttribute("aria-controls", idPeriodo);
    botonPeriodo.setAttribute("aria-expanded", "false");
    filtrosPeriodo.setAttribute("role", "region");
    filtrosPeriodo.setAttribute("aria-labelledby", botonPeriodo.id);
    c.appendChild(P.cabeceraConAcciones("Estadísticas", "Cómo vienen las ventas, las compras y el stock del predio.", botonPeriodo));
    c.appendChild(filtrosPeriodo);
    [desde, hasta, boca].forEach(function (el) { el.addEventListener("change", cargar); });
    var cifras = h("div.grilla.grilla-4", P.cargando());
    var graficos = h("div");
    c.appendChild(cifras);
    c.appendChild(graficos);

    var vista = vistaInicial || P.cache["estadisticas:vista"] || "ventas";
    var zonaListado = h("div", { style: { marginTop: "12px" } });
    c.appendChild(h("div", { style: { marginTop: "26px" } }, h("h2.seccion-titulo", { style: { marginBottom: "10px" } }, "Listados"),
      P.segmentado(LISTADOS, vista, function (v) { vista = v; P.cache["estadisticas:vista"] = v; pintarListado(); })));
    c.appendChild(zonaListado);

    function pintarListado() {
      var filtros = { desde: desde.value, hasta: hasta.value };
      if (boca.value && (vista === "ventas" || vista === "ventas_productos")) filtros.boca = boca.value;
      var t;
      if (vista === "almacen") {
        P.opciones("bocas").then(function (ops) {
          var a = ops.filter(function (o) { return o.es_almacen; })[0];
          t = P.tabla({ listado: "movimientos", claveEstado: "est-almacen", filtrosIniciales: Object.assign({}, filtros, a ? { boca: String(a.valor) } : {}) });
          P.reemplazar(zonaListado, t.el);
        });
        return;
      }
      if (vista === "compras") {
        t = P.tabla({ listado: "compras", claveEstado: "est-compras", filtrosIniciales: filtros, alClickFila: function (f) { P.verCompra(f.id); } });
      } else if (vista === "ventas") {
        t = P.tabla({ listado: "ventas", claveEstado: "est-ventas", filtrosIniciales: filtros, alClickFila: function (f) { P.verVenta(f.id); } });
      } else {
        t = P.tabla({ listado: vista, claveEstado: "est-" + vista, filtrosIniciales: filtros });
      }
      P.reemplazar(zonaListado, t.el);
    }

    function cargar() {
      botonPeriodo.title = "Del " + P.f.fecha(desde.value) + " al " + P.f.fecha(hasta.value);
      estado = { desde: desde.value, hasta: hasta.value, boca: boca.value };
      P.cache["estadisticas"] = estado;
      ["est-ventas", "est-compras", "est-almacen", "est-ventas_productos", "est-solicitudes", "est-bajas"].forEach(function (k) { delete P.cache["tabla:" + k]; });
      pintarListado();
      return P.get("/estadisticas" + P.qs({ desde: estado.desde, hasta: estado.hasta, boca_id: estado.boca })).then(function (d) {
        var k = d.kpi;
        P.reemplazar(cifras,
          P.cifra("Vendido", P.f.pesos(k.total), P.f.entero(k.ventas) + " ventas · ticket promedio " + P.f.pesos(k.promedio)),
          P.cifra("Ganancia estimada", P.f.pesos(k.ganancia), "Venta menos costo de compra actual"),
          P.cifra("Compras", P.f.pesos(k.compras_total), P.f.entero(k.compras) + " facturas en el período"),
          P.cifra("Stock valorizado", P.f.pesos(k.stock_valor), P.f.entero(k.stock_productos) + " productos con stock"));
        var porDia = [];
        for (var dia = d.desde; dia <= d.hasta; dia = P.sumarDias(dia, 1)) {
          var fila = d.por_dia.filter(function (x) { return x.dia === dia; })[0];
          porDia.push({ etiqueta: P.f.fecha(dia), corta: dia.slice(8, 10) + "/" + dia.slice(5, 7), valor: fila ? fila.total : 0 });
          if (porDia.length > 400) break;
        }
        var porHora = [];
        for (var hr = 6; hr <= 23; hr++) {
          var fh = d.por_hora.filter(function (x) { return Number(x.hora) === hr; })[0];
          porHora.push({ etiqueta: hr + " h", valor: fh ? fh.total : 0 });
        }
        function tarjeta(titulo, contenido) { return h("div.hoja.hoja-cuerpo", h("h2.seccion-titulo", { style: { marginBottom: "14px" } }, titulo), contenido); }
        P.reemplazar(graficos,
          h("div", { style: { marginTop: "16px" } }, tarjeta("Ventas por día", P.graficoBarras(porDia, { formato: P.f.pesos, formatoEje: function (v) { return "$" + P.f.entero(v); } }))),
          h("div.grilla.grilla-2", { style: { marginTop: "16px" } },
            tarjeta("Por boca", P.barrasH(d.por_boca.map(function (x) { return { etiqueta: x.clave + " (" + x.ventas + ")", valor: x.total }; }), { formato: P.f.pesos })),
            tarjeta("Por forma de pago", P.barrasH(d.por_forma.map(function (x) { return { etiqueta: (P.FORMAS[x.clave] || x.clave) + " (" + x.ventas + ")", valor: x.total }; }), { formato: P.f.pesos })),
            tarjeta("Productos más vendidos", P.barrasH(d.top_productos.map(function (x) { return { etiqueta: x.producto + " (" + P.f.numero(x.unidades) + ")", valor: x.total }; }), { formato: P.f.pesos })),
            tarjeta("Horarios de venta", P.graficoBarras(porHora, { formato: P.f.pesos, formatoEje: function (v) { return "$" + P.f.entero(v); } })),
            tarjeta("Compras por proveedor", P.barrasH(d.compras_proveedor.map(function (x) { return { etiqueta: x.clave + " (" + x.compras + ")", valor: x.total }; }), { formato: P.f.pesos })),
            tarjeta("Bajas por motivo (a costo)", P.barrasH(d.bajas.map(function (x) { return { etiqueta: ({ ROTURA: "Rotura", VENCIMIENTO: "Vencimiento", MATERIA_PRIMA: "Materia prima", INSUMO: "Insumo", CONSUMO_DESTINO: "Consumo en destino", OTROS: "Otros" })[x.clave] + " (" + x.cantidad + ")", valor: x.total }; }), { formato: P.f.pesos }))));
      }).catch(function (e) { P.reemplazar(cifras, P.mensaje(e.message, "error")); });
    }
    return cargar();
  }

  P.ruta.registrar(/^\/estadisticas$/, function (c, p, q) { return pantalla(c, p, q); }, { admin: true, titulo: "Estadísticas" });
  P.ruta.registrar(/^\/estadisticas\/ventas$/, function (c, p, q) { return pantalla(c, p, q, "ventas"); }, { admin: true, titulo: "Estadísticas" });
})();
