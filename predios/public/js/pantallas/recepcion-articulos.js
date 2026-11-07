/* Recepción: alquileres y compras de una reserva (tabla, pagos, devoluciones). */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P, h = P.h, R = P.recepcion, pesos = P.f.pesos, fecha = P.f.fecha;
  var MEDIOS = R.MEDIOS, CONCEPTOS = R.CONCEPTOS, MODALIDAD = R.MODALIDAD, opciones = R.opciones, lista = R.lista, sel = R.sel, input = R.input,
    texto = R.texto, btn = R.btn, grid = R.grid, tabla = R.tabla, get = R.get, cabecera = R.cabecera, nuevaClave = R.nuevaClave, opSelect = R.opSelect,
    detalleArticulo = R.detalleArticulo, periodo = R.periodo;
  function espacio(v) { return h("span", v); }

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
    if (accion === "PAGAR") {
      var imp = P.dinero({ valor: P.f.numero(linea.adeudado) });
      var medio = sel(opciones({ EFECTIVO: MEDIOS.EFECTIVO, TRANSFERENCIA: MEDIOS.TRANSFERENCIA }), "EFECTIVO");
      var caja = sel([], null, "Elegí una caja"), campoCaja = P.campo("Caja de efectivo", caja);
      selectorCaja(caja);
      medio.onchange = function () { campoCaja.hidden = medio.value !== "EFECTIVO"; };
      titulo = "Registrar pago · " + linea.nombre;
      cuerpoModal = h("div.columna", h("div.rec-resumen", "Falta pagar", h("strong", pesos(linea.adeudado))),
        h("div.rec-grid", P.campo("Importe ($)", imp), P.campo("Medio", medio), campoCaja), P.campo("Observación", nota));
      datos = function () {
        var importe = P.importeDe(imp.value);
        if (!(importe > 0) || importe > Number(linea.adeudado) + 0.001) { imp.focus(); throw Error("Ingresá un importe mayor que cero y que no supere lo que falta pagar."); }
        if (medio.value === "EFECTIVO" && !caja.value) { caja.focus(); throw Error(P.esAdmin() ? "Elegí la caja donde se registra el efectivo." : "Ingresá a tu caja para registrar el efectivo de recepción."); }
        return { importe: importe, medio: medio.value, caja_id: caja.value };
      };
    } else if (accion === "ANULAR_PAGO") {
      var caja2 = sel([], null, "Elegí una caja"), campoCaja2 = P.campo("Caja que devuelve el efectivo", caja2);
      campoCaja2.hidden = pago.medio !== "EFECTIVO";
      if (pago.medio === "EFECTIVO") selectorCaja(caja2);
      titulo = "Anular pago · " + linea.nombre;
      cuerpoModal = h("div.columna", h("div.rec-resumen", "Pago del " + P.f.fechaHora(pago.fecha) + " · " + (MEDIOS[pago.medio] || pago.medio), h("strong", pesos(pago.importe))),
        P.mensaje(pago.medio === "EFECTIVO" ? "Se registra la devolución del efectivo en la caja elegida." : "El importe vuelve a quedar pendiente de pago.", "info"), campoCaja2, P.campo("Motivo", nota));
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
              P.aviso(x.mensaje, "ok");
              return refrescar();
            }
          });
      }, accion === "ANULAR_PAGO" ? "peligro" : "primario")]
    });
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
    return tabla(["Artículo", "Detalle", "Importe", "Pagado", "Estado", ""], lineas.map(function (l) {
      var items = [];
      if (Number(l.adeudado)) items.push({ texto: "Registrar pago", icono: "efectivo", accion: function () { operarArticulo(r, a, l, "PAGAR", cargar); } });
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
  }
  P.recepcion.tablaArticulos = tablaArticulos;
})();
