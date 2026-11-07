/* Recepción: alquileres y compras de una reserva (tabla, cobros con comprobante, devoluciones). */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P, h = P.h, R = P.recepcion, pesos = P.f.pesos, fecha = P.f.fecha;
  var MEDIOS = R.MEDIOS, MODALIDAD = R.MODALIDAD, opciones = R.opciones, sel = R.sel, input = R.input,
    btn = R.btn, tabla = R.tabla, nuevaClave = R.nuevaClave, detalleArticulo = R.detalleArticulo, periodo = R.periodo;

  function selectorCaja(caja) {
    P.opciones("cajas").then(function (xs) {
      var asignada = P.puesto() && P.puesto().caja_id;
      if (!P.esAdmin()) xs = xs.filter(function (x) { return asignada && String(x.valor) === String(asignada); });
      xs.forEach(function (x) {
        caja.appendChild(h("option", { value: x.valor }, x.texto));
      });
      if (asignada && xs.some(function (x) { return String(x.valor) === String(asignada); })) caja.value = asignada;
      else if (xs.length === 1) caja.value = xs[0].valor;
    }).catch(P.error);
  }
  function operarArticulo(r, a, linea, accion, refrescar, pago) {
    var key = nuevaClave();
    var nota = input("");
    var cuerpoModal, titulo, datos = {};
    if (accion === "ANULAR_PAGO") {
      var caja2 = sel([], null, "Elegí una caja"), campoCaja2 = P.campo("Caja que devuelve el efectivo", caja2);
      campoCaja2.hidden = pago.medio !== "EFECTIVO";
      if (pago.medio === "EFECTIVO") selectorCaja(caja2);
      titulo = "Anular pago · " + linea.nombre;
      cuerpoModal = h("div.columna", h("div.rec-resumen", "Pago del " + P.f.fechaHora(pago.fecha) + " · " + (MEDIOS[pago.medio] || pago.medio), h("strong", pesos(pago.importe))),
        P.mensaje((pago.medio === "EFECTIVO" ? "Se registra la devolución del efectivo en la caja elegida." : "El importe vuelve a quedar pendiente de pago.") +
          (pago.comprobante ? " Se emite una nota de crédito sobre su recibo, para imprimir y que firme el titular." : ""), "info"), campoCaja2, P.campo("Motivo", nota));
      datos = function () {
        if (!campoCaja2.hidden && !caja2.value) { caja2.focus(); throw Error("Elegí la caja que devuelve el efectivo."); }
        return { movimiento_id: pago.id, caja_id: caja2.value };
      };
    } else {
      var dia = input(P.hoy() < linea.fecha_hasta ? P.hoy() : linea.fecha_hasta, "date");
      dia.max = P.hoy();
      dia.min = linea.fecha_desde;
      titulo = (accion === "DEVOLVER" ? "Registrar devolución · " : "Quitar devolución · ") + linea.nombre;
      cuerpoModal = h("div.columna", accion === "DEVOLVER" ? P.campo("Fecha de devolución", dia, { ayuda: detalleArticulo(linea) + " · " + periodo(linea) }) :
        P.mensaje("El artículo vuelve a figurar como no devuelto.", "info"), P.campo("Observación", nota));
      datos = function () { return accion === "DEVOLVER" ? { fecha: dia.value } : {}; };
    }
    var m = P.modal({
      titulo: titulo,
      contenido: cuerpoModal,
      acciones: [btn("Volver", function () { m.cerrar(); }), btn("Confirmar", function () {
        return P.post("/recepcion/" + r.id + "/adicional", Object.assign({ operacion: key, accion: accion, adicional_id: linea.adicional_id, detalle: nota.value }, datos()))
          .then(function (x) {
            m.cerrar();
            if (!x.encolado) {
              if (x.comprobante) P.contable.emitido(x);
              else P.aviso(x.mensaje, "ok");
              return refrescar();
            }
          });
      }, accion === "ANULAR_PAGO" ? "peligro" : "primario")]
    });
  }

  // ------------------------------------------------------------------ cobro de artículos con comprobante

  function adeudados(lineas) {
    return lineas.filter(function (l) { return Number(l.adeudado) > 0; });
  }
  /* La persona paga en el momento uno o varios artículos: un solo cobro y un solo recibo.
     `solo`: el artículo desde cuyo menú se abrió («Registrar pago»): se cobra sólo ese. */
  function cobrarArticulos(r, lineas, refrescar, solo) {
    var key = nuevaClave();
    var pendientes = solo ? [solo] : adeudados(lineas);
    var unico = pendientes.length === 1;
    var filas = pendientes.map(function (l) {
      var imp = P.dinero({ valor: P.f.numero(l.adeudado) });
      imp.setAttribute("aria-label", "Importe a cobrar de " + l.nombre);
      var marca = P.check(l.nombre, true, [MODALIDAD[l.modalidad], detalleArticulo(l), periodo(l)].filter(Boolean).join(" · "), actualizar);
      // Con un solo artículo no hay nada que elegir: la casilla queda marcada y oculta.
      if (unico) { marca.input.disabled = true; marca.input.style.display = "none"; }
      var fila = { linea: l, marca: marca.input, imp: imp };
      imp.addEventListener("input", actualizar);
      fila.nodo = h("div.rec-cobro-item" + (unico ? ".unico" : ""), marca,
        h("div.rec-cobro-importe", h("span.rec-cobro-debe", "Debe " + pesos(l.adeudado)), imp));
      return fila;
    });
    var total = h("strong", pesos(0)), cantidad = h("span");
    var medio = sel(opciones({ EFECTIVO: MEDIOS.EFECTIVO, TRANSFERENCIA: MEDIOS.TRANSFERENCIA }), "EFECTIVO");
    var caja = sel([], null, "Elegí una caja"), campoCaja = P.campo("Caja de efectivo", caja);
    var nota = input("");
    selectorCaja(caja);
    medio.onchange = function () { campoCaja.hidden = medio.value !== "EFECTIVO"; };

    function importeDe(f) { return P.importeDe(f.imp.value); }
    function valido(f) { var n = importeDe(f); return n > 0 && n <= Number(f.linea.adeudado) + 0.001; }
    function actualizar() {
      var suma = 0, n = 0;
      filas.forEach(function (f) {
        f.imp.disabled = !f.marca.checked;
        f.nodo.classList.toggle("elegido", f.marca.checked);
        f.imp.classList.toggle("invalido", f.marca.checked && !valido(f));
        if (f.marca.checked && valido(f)) { suma += importeDe(f); n++; }
      });
      total.textContent = pesos(P.redondear(suma));
      cantidad.textContent = n === 1 ? "1 artículo" : n + " artículos";
    }
    actualizar();

    var m = P.modal({
      titulo: solo ? "Registrar pago · " + solo.nombre : "Cobrar artículos",
      subtitulo: "Reserva T-" + r.id + " · " + r.titular_nombre,
      contenido: h("div.columna",
        filas.length > 1 ? h("p.texto-3.chico.rec-cobro-ayuda", "Marcá lo que se paga ahora. Podés cobrar una parte de cada artículo.") : null,
        h("div.rec-cobro-lista", filas.map(function (f) { return f.nodo; })),
        h("div.rec-resumen.rec-cobro-total", h("span", "Total a cobrar · ", cantidad), total),
        h("div.rec-grid", P.campo("Medio", medio), campoCaja), P.campo("Observación", nota)),
      acciones: [btn("Volver", function () { m.cerrar(); }), btn("Cobrar", function () {
        var elegidas = filas.filter(function (f) { return f.marca.checked; });
        if (!elegidas.length) throw Error("Marcá al menos un artículo para cobrar.");
        elegidas.forEach(function (f) {
          if (!valido(f)) { f.imp.focus(); throw Error("Revisá el importe de " + f.linea.nombre + ": tiene que ser mayor que cero y no superar lo que falta pagar (" + pesos(f.linea.adeudado) + ")."); }
        });
        if (medio.value === "EFECTIVO" && !caja.value) { caja.focus(); throw Error(P.esAdmin() ? "Elegí la caja donde se registra el efectivo." : "Ingresá a tu caja para registrar el efectivo de recepción."); }
        return P.post("/recepcion/" + r.id + "/articulos/cobrar", {
          operacion: key,
          items: elegidas.map(function (f) { return { adicional_id: f.linea.adicional_id, importe: importeDe(f) }; }),
          medio: medio.value,
          caja_id: medio.value === "EFECTIVO" ? caja.value : null,
          detalle: nota.value
        }).then(function (x) {
          // En cola (sistema general con el predio sin conexión): el comprobante aparece en la lista cuando se aplica.
          if (x.encolado || !x.datos) {
            m.cerrar();
            if (!x.encolado) P.aviso(x.mensaje, "ok");
            return refrescar();
          }
          cobroHecho(m, x);
          return refrescar();
        });
      }, "primario", { icono: "efectivo" })]
    });
  }

  // La ventana queda abierta con el recibo listo para imprimir (original y duplicado).
  function cobroHecho(m, x) {
    var d = x.datos, impreso = false;
    var imprimir = P.btn("Imprimir recibo", { tipo: "primario", icono: "imprimir", onclick: function (e) {
      P.ejecutar(e.currentTarget, function () {
        var reimpresion = impreso;
        impreso = true;
        return P.imprimirComprobante(d, { reimpresion: reimpresion });
      }).catch(function () {});
    } });
    var titulo = m.ventana.querySelector(".ventana-cabecera h2");
    if (titulo) titulo.textContent = "Cobro registrado";
    P.reemplazar(m.cuerpo, h("div.columna",
      P.mensaje(x.mensaje, "ok"),
      h("div.rec-resumen.rec-cobro-total", h("span", "Cobrado · " + (MEDIOS[d.medio] || d.medio)), h("strong", pesos(d.total))),
      h("ul.rec-cobro-hecho", d.renglones.map(function (it) {
        return h("li", h("span", it.texto), h("strong", pesos(it.importe)));
      })),
      h("p.texto-3.chico", "Recibo " + d.codigo + ": sale en una hoja con el original para el titular y el duplicado para el predio. No es válido como factura.")));
    P.reemplazar(m.pie, P.btn("Listo", { tipo: "secundario", onclick: function () { m.cerrar(); } }), imprimir);
    setTimeout(function () { imprimir.focus(); }, 30);
  }

  function chipsArticulo(l) {
    var chips = [];
    if (l.modalidad !== "VENTA" && l.fecha_desde) {
      if (l.devuelto) chips.push(P.chip("Devuelto " + fecha(l.devuelto), "OK"));
      else if (l.sin_devolver) chips.push(P.chip("Sin devolver" + (l.dias_atraso ? " · " + l.dias_atraso + (l.dias_atraso === 1 ? " día" : " días") : ""), "ERROR"));
      else chips.push(P.chip("En uso", "ABIERTO"));
    }
    if (!Number(l.en_predio) && Number(l.subtotal)) chips.push(P.chip("Pagado en Turismo", "OK"));
    else if (Number(l.adeudado)) chips.push(P.chip("Debe " + pesos(l.adeudado), "PENDIENTE"));
    else if (l.saldado_con_reserva) chips.push(P.chip("Saldado con la reserva", "OK"));
    else if (Number(l.en_predio)) chips.push(P.chip("Pagado", "OK"));
    return h("div.rec-chips", chips);
  }

  function tablaArticulos(r, a, lineas, cargar) {
    var pagosDe = function (l) {
      return a.movimientos.filter(function (m) {
        return m.concepto === "PAGO_ADICIONAL" && Number(m.adicional_id) === Number(l.adicional_id) && Number(m.importe) > 0 && (a.pagos_anulados || []).indexOf(Number(m.id)) < 0;
      });
    };
    var deuda = adeudados(lineas);
    var falta = P.redondear(deuda.reduce(function (s, l) { return s + Number(l.adeudado); }, 0));
    var articulos = tabla(["Artículo", "Detalle", "Importe", "Pagado", "Estado", ""], lineas.map(function (l) {
      var items = [];
      if (Number(l.adeudado)) items.push({ texto: "Registrar pago", icono: "efectivo", accion: function () { cobrarArticulos(r, lineas, cargar, l); } });
      pagosDe(l).forEach(function (pg) {
        items.push({ texto: "Anular pago de " + pesos(pg.importe) + " (" + P.f.fecha(pg.fecha) + ")", icono: "cerrar", accion: function () { operarArticulo(r, a, l, "ANULAR_PAGO", cargar, pg); } });
      });
      if (l.modalidad !== "VENTA" && l.fecha_desde) {
        items.push(l.devuelto ? { texto: "Quitar la devolución", icono: "historial", accion: function () { operarArticulo(r, a, l, "DESHACER_DEVOLUCION", cargar); } } :
          { texto: "Registrar devolución", icono: "check", accion: function () { operarArticulo(r, a, l, "DEVOLVER", cargar); } });
      }
      var menu = items.length ? P.btn("", { tipo: "texto", chico: true, icono: "menu", etiqueta: "Acciones de " + l.nombre }) : null;
      if (menu) menu.addEventListener("click", function () { P.menuFlotante(menu, items); });
      return [h("div", h("strong", l.nombre), h("div.texto-3.chico", MODALIDAD[l.modalidad] || "")),
        detalleArticulo(l) + " · " + periodo(l), pesos(l.subtotal), pesos(l.pagado), chipsArticulo(l), menu || ""];
    }), ".rec-tabla-articulos");
    return h("div.columna.rec-articulos-cobro",
      deuda.length ? h("div.rec-cobro-barra",
        h("p.rec-cobro-falta", "Falta pagar ", h("strong", pesos(falta)), " en " + (deuda.length === 1 ? "1 artículo" : deuda.length + " artículos")),
        btn("Cobrar artículos", function () { cobrarArticulos(r, lineas, cargar); }, "primario", { chico: true, icono: "efectivo" })) : null,
      articulos);
  }
  P.recepcion.tablaArticulos = tablaArticulos;
})();
