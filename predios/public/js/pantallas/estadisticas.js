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

  function panelEstadias(desde, hasta, estado) {
    var servicio = P.select([], "", { vacio: "Todos los servicios" });
    var recurso = P.select([], "", { vacio: "Todos los recursos" });
    var adicional = P.select([], "", { vacio: "Todos los adicionales" });
    var controles = [servicio, recurso, adicional];
    var seleccion = estado.filtrosEstadias || {};
    var opciones, solicitud = 0;
    var resultados = h("div", { "aria-live": "polite" });
    // Cifras de la selección (antes estaban arriba de la tabla de reservas) y gráficos de ocupación.
    var resumen = h("div", { "aria-live": "polite" });
    var periodo = h("p.texto-2");
    var raiz = h("section", { style: { marginTop: "24px" } },
      h("h2.seccion-titulo", "Reservas y estadías"), periodo,
      h("div.tabla-filtros.tabla-periodo-controles", P.campo("Servicio", servicio), P.campo("Recurso", recurso), P.campo("Adicional", adicional)),
      resumen, resultados);
    controles.forEach(function (el) { el.disabled = true; });

    function completar(select, filas, valor) {
      while (select.options.length > 1) select.remove(1);
      filas.forEach(function (fila) { select.appendChild(h("option", { value: fila.id }, fila.nombre)); });
      select.value = valor || "";
      if (select.selectedIndex < 0) select.selectedIndex = 0;
    }
    function recursos() {
      completar(recurso, opciones.recursos.filter(function (fila) {
        return !servicio.value || String(fila.servicio_id) === servicio.value;
      }), seleccion.recurso_id);
    }
    function tabla(titulo, nota, columnas, filas, vacio) {
      return h("div.hoja.hoja-cuerpo", { style: { minWidth: 0 } }, h("h3.seccion-titulo", titulo), h("p.texto-2", nota),
        filas.length ? h("div.tabla-desplazable", { tabindex: "0", role: "region", "aria-label": titulo, style: { maxHeight: "320px" } },
          h("table.tabla", h("thead", h("tr", columnas.map(function (col) { return h("th", { scope: "col" }, col); }))),
            h("tbody", filas.map(function (fila) { return h("tr", fila.map(function (valor) { return h("td", valor); })); }))))
          : h("p.texto-3", vacio));
    }
    function pintar(datos) {
      var ingresos = datos.ingresos.reduce(function (total, dia) { return total + dia.personas; }, 0);
      P.reemplazar(resultados, h("div.grilla.grilla-2",
        tabla("Ingresos registrados · " + P.f.entero(ingresos), "Personas con ingreso registrado. Cada persona cuenta una vez por día.",
          ["Fecha de ingreso", "Personas"], datos.ingresos.map(function (dia) { return [P.f.fecha(dia.dia), P.f.entero(dia.personas)]; }),
          "Sin ingresos registrados para esta selección."),
        tabla("Adicionales contratados", "Las unidades se cuentan por reserva. Los días de uso se suman por cada unidad.",
          ["Adicional", "Unidades", "Días de uso", "Importe"], datos.adicionales.map(function (a) {
            return [P.textoTabla(a.nombre), P.f.entero(a.unidades), P.f.entero(a.unidades_dia), P.f.pesos(a.importe)];
          }), "Sin adicionales contratados para esta selección.")),
        datos.sin_detalle ? h("p.texto-2", "Los adicionales antiguos sin detalle diario se contabilizan en la fecha de inicio de la reserva.") : null);
    }
    function pintarResumen(d) {
      var k = d.kpi;
      var TIPOS = { GENERAL: "General", PASA_EL_DIA: "Pasa el día", CONTINGENTE: "Contingente", FEDERACION: "Federación" };
      function tarjeta(titulo, contenido) { return h("div.hoja.hoja-cuerpo", { style: { minWidth: 0 } }, h("h3.seccion-titulo", { style: { marginBottom: "14px" } }, titulo), contenido); }
      var porDia = d.por_dia.map(function (x) { return { etiqueta: P.f.fecha(x.dia) + " (" + x.reservas + " reservas)", corta: x.dia.slice(8, 10) + "/" + x.dia.slice(5, 7), valor: x.personas }; });
      P.reemplazar(resumen,
        h("div.grilla.grilla-4", { style: { marginBottom: "16px" } },
          P.cifra("Reservas", P.f.entero(k.reservas), P.f.entero(k.personas) + " personas · " + P.f.entero(k.noches) + " noches en el período"),
          P.cifra("Importe de la selección", P.f.pesos(k.importe), "Promedio por reserva " + P.f.pesos(k.promedio)),
          P.cifra("Alquileres y adicionales", P.f.pesos(k.adicionales), "Alojamiento " + P.f.pesos(k.alojamiento)),
          P.cifra("En el predio ahora", P.f.entero(k.presentes_personas), P.f.entero(k.presentes_reservas) + " reservas con huéspedes · " + P.f.entero(k.atipicas) + " atípicas")),
        tarjeta("Personas por día", P.graficoBarras(porDia, { formato: function (v) { return P.f.entero(v) + " personas"; }, formatoEje: P.f.numero })),
        h("div.grilla.grilla-2", { style: { margin: "16px 0" } },
          tarjeta("Por servicio", P.barrasH(d.por_servicio.map(function (x) { return { etiqueta: x.nombre + " (" + x.reservas + " · " + x.personas + " pers.)", valor: x.importe }; }), { formato: P.f.pesos })),
          tarjeta("Por tipo de reserva", P.barrasH(d.por_tipo.map(function (x) { return { etiqueta: (TIPOS[x.clave] || x.clave) + " (" + x.reservas + ")", valor: x.importe }; }), { formato: P.f.pesos }))));
    }
    var solicitudResumen = 0;
    function cargarResumen() {
      var actual = ++solicitudResumen;
      return P.get("/recepcion/estadisticas" + P.qs(Object.assign({ desde: desde.value, hasta: hasta.value }, seleccion)), { sinRedireccion: true })
        .then(function (d) { if (actual === solicitudResumen) pintarResumen(d); })
        .catch(function () { if (actual === solicitudResumen) P.vaciar(resumen); });
    }
    function cargar() {
      var actual = ++solicitud;
      cargarResumen();
      P.reemplazar(resultados, P.cargando());
      return P.get("/estadisticas/estadias" + P.qs(Object.assign({
        desde: desde.value, hasta: hasta.value, opciones: opciones ? "" : "1"
      }, seleccion))).then(function (datos) {
        if (actual !== solicitud) return;
        periodo.textContent = "Del " + P.f.fecha(datos.desde) + " al " + P.f.fecha(datos.hasta);
        if (datos.opciones) {
          opciones = datos.opciones;
          completar(servicio, opciones.servicios, seleccion.servicio_id);
          recursos();
          completar(adicional, opciones.adicionales, seleccion.adicional_id);
          controles.forEach(function (el) { el.disabled = false; });
        }
        pintar(datos);
      }).catch(function (error) {
        if (actual === solicitud) P.reemplazar(resultados, P.mensaje(error.message, "error"),
          P.btn("Reintentar", { tipo: "suave", chico: true, onclick: cargar }));
      });
    }
    controles.forEach(function (el) {
      el.addEventListener("change", function () {
        seleccion = { servicio_id: servicio.value, recurso_id: el === servicio ? "" : recurso.value, adicional_id: adicional.value };
        if (el === servicio) recursos();
        estado.filtrosEstadias = seleccion;
        cargar();
      });
    });
    return { el: raiz, cargar: cargar };
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
    c.appendChild(P.cabeceraConAcciones("Estadísticas", null, botonPeriodo));
    c.appendChild(filtrosPeriodo);
    [desde, hasta, boca].forEach(function (el) { el.addEventListener("change", cargar); });
    var cifras = h("div.grilla.grilla-4", P.cargando());
    var graficos = h("div");
    var estadias = panelEstadias(desde, hasta, estado);
    c.appendChild(cifras);
    c.appendChild(estadias.el);
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
      Object.assign(estado, { desde: desde.value, hasta: hasta.value, boca: boca.value });
      P.cache["estadisticas"] = estado;
      ["est-ventas", "est-compras", "est-almacen", "est-ventas_productos", "est-solicitudes", "est-bajas"].forEach(function (k) { delete P.cache["tabla:" + k]; });
      pintarListado();
      estadias.cargar();
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
