/* Impresión del documento y comprobantes de compras y liquidaciones en A4. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;
  var FORMAS = { SALDO: "Saldo de estadía", MIXTO: "Pago combinado", EFECTIVO: "Efectivo", QR: "QR", TARJETA_DEBITO: "Tarjeta de débito", TARJETA_CREDITO: "Tarjeta de crédito", TRANSFERENCIA: "Transferencia", DESCUENTO: "Descuento de haberes", DESCUENTO_HABERES: "Descuento de haberes" };
  P.FORMAS = FORMAS;

  function imprimirHtml(cuerpo, estilo, titulo) {
    return new Promise(function (resolver, rechazar) {
      var marco = h("iframe", { title: "Impresión", style: { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0", visibility: "hidden" } });
      document.body.appendChild(marco);
      var doc = marco.contentWindow.document;
      doc.open();
      doc.write("<!doctype html><html lang='es'><head><meta charset='utf-8'><title></title></head><body></body></html>");
      doc.close();
      doc.title = titulo || "Comprobante";
      var st = doc.createElement("style");
      st.textContent = estilo;
      doc.head.appendChild(st);
      doc.body.appendChild(doc.importNode(cuerpo, true));
      var listo = false;
      function terminar() { if (listo) return; listo = true; setTimeout(function () { marco.remove(); resolver(); }, 600); }
      marco.contentWindow.onafterprint = terminar;
      setTimeout(function () {
        try {
          marco.contentWindow.focus();
          marco.contentWindow.print();
          if (!listo) setTimeout(terminar, 60000);
        } catch (e) {
          if (listo) return;
          listo = true;
          marco.remove();
          rechazar(new Error("No se pudo imprimir el comprobante. Revisá la tiquetera o impresora y volvé a intentar."));
        }
      }, 120);
    });
  }
  P.imprimirHtml = imprimirHtml;

  function documento(dni) { var d = String(dni || "").replace(/\D/g, ""); return d ? d.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : ""; }
  P.documento = documento;

  var ESTILO_A4 = "@page { size: A4; margin: 16mm 14mm; } * { box-sizing: border-box; } body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; font-size: 12.5px; color: #12344d; }" +
    "h1 { margin: 0; font-size: 20px; color: #0d5482; } h2 { margin: 18px 0 8px; font-size: 14px; color: #0d5482; text-transform: uppercase; letter-spacing: .06em; }" +
    ".cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding-bottom: 12px; border-bottom: 2px solid #0d5482; }" +
    ".cab .der { text-align: right; } .gris { color: #5d7690; } table { width: 100%; border-collapse: collapse; margin-top: 6px; }" +
    "th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #36556f; border-bottom: 1px solid #bcd9ec; padding: 6px; } td { padding: 6px; border-bottom: 1px solid #e6f1f9; }" +
    ".num { text-align: right; font-variant-numeric: tabular-nums; } .datos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 18px; }" +
    ".datos span { display: block; font-size: 11px; color: #5d7690; } .datos strong { font-size: 14px; }" +
    ".totales { margin-left: auto; width: 320px; margin-top: 10px; } .totales div { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #e6f1f9; }" +
    ".totales .final { font-size: 17px; font-weight: 800; color: #0d5482; border-bottom: 0; }" +
    ".autorizacion { margin-top: 22px; padding: 14px; border: 1px solid #bcd9ec; border-radius: 8px; line-height: 1.6; }" +
    ".firmas { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 30px; margin-top: 60px; } .firmas div { border-top: 1px solid #12344d; padding-top: 4px; text-align: center; font-size: 11px; }" +
    ".pie { margin-top: 26px; font-size: 10.5px; color: #5d7690; }";

  P.imprimirLiquidacion = function (datos) {
    var l = datos.liquidacion;
    var a = datos.afiliado || {};
    var e = datos.empresa || {};
    var estadia = datos.estadia;
    var esHaberes = l.forma_pago === "DESCUENTO_HABERES";
    var nodo = h("div",
      h("div.cab",
        h("div", h("h1", (e.razon_social || "Asociación Judicial Bonaerense")), h("div.gris", e.nombre_predio || ""), e.direccion ? h("div.gris", e.direccion) : null),
        h("div.der", h("h1", "Liquidación N° " + l.id), h("div.gris", "Emitida el " + P.f.fechaHora(l.fecha)), h("div", h("strong", l.estado === "PAGADA" ? "PAGADA" : l.estado === "ANULADA" ? "ANULADA" : "PENDIENTE DE PAGO")))),
      h("h2", "Afiliado"),
      h("div.datos",
        h("div", h("span", "Apellido y nombre"), h("strong", a.nombre || "")),
        h("div", h("span", "DNI"), h("strong", documento(a.dni) || "—")),
        h("div", h("span", "Legajo"), h("strong", a.legajo || "—")),
        h("div", h("span", "Departamental"), h("strong", a.departamental || "—")),
        estadia ? h("div", h("span", "Reserva"), h("strong", "T-" + estadia.reserva_id)) : h("div", h("span", "Período de consumos"), h("strong", P.f.fecha(l.desde) + " al " + P.f.fecha(l.hasta))),
        estadia ? null : h("div", h("span", "Consumos"), h("strong", String(l.ventas_cantidad || (datos.ventas || []).length)))),
      h("h2", estadia ? "Detalle del importe de la estadía" : "Detalle de consumos con descuento de haberes"),
      estadia ? h("table", h("thead", h("tr", h("th", "Movimiento"), h("th", "Fecha"), h("th.num", "Importe"))),
        h("tbody", estadia.lineas.map(function (m) {
          return h("tr", h("td", m.concepto), h("td", P.f.fechaHora(m.fecha)), h("td.num", P.f.pesos(m.importe)));
        }))) : h("table", h("thead", h("tr", h("th", "Ticket"), h("th", "Fecha"), h("th", "Boca"), h("th.num", "Importe"))),
        h("tbody", (datos.ventas || []).map(function (v) {
          return h("tr", h("td", "N° " + v.id), h("td", P.f.fechaHora(v.fecha)), h("td", v.boca), h("td.num", P.f.pesos(v.total)));
        }))),
      h("div.totales",
        estadia ? null : h("div", h("span", "Total consumido"), h("strong", P.f.pesos(l.total_consumos))),
        Number(l.porcentaje_descuento) ? h("div", h("span", "Descuento (" + P.f.pct(l.porcentaje_descuento) + ")"), h("strong", "− " + P.f.pesos(Number(l.total_consumos) - Number(l.total)))) : null,
        h("div.final", h("span", "Total a pagar"), h("span", P.f.pesos(l.total))),
        h("div", h("span", "Forma de pago"), h("strong", FORMAS[l.forma_pago] || l.forma_pago)),
        h("div", h("span", "Cuotas"), h("strong", l.cuotas + " de " + P.f.pesos(l.valor_cuota))),
        l.recibo ? h("div", h("span", "Recibo"), h("strong", l.recibo)) : null),
      esHaberes ? h("div.autorizacion",
        h("strong", "Autorización de descuento"), h("br"),
        "Yo, " + (a.nombre || "") + ", DNI " + (documento(a.dni) || "") + (a.legajo ? ", legajo N° " + a.legajo : "") + ". " +
        (e.texto_autorizacion || "") + " Importe total: " + P.f.pesos(l.total) + ", en " + l.cuotas + " cuota" + (Number(l.cuotas) === 1 ? "" : "s") + " de " + P.f.pesos(l.valor_cuota) + ".") : null,
      h("div.firmas", h("div", "Firma del afiliado"), h("div", "Aclaración"), h("div", "Firma y sello AJB")),
      h("div.pie", "Presentar este comprobante en la departamental" + (a.departamental ? " " + a.departamental : "") + " para " + (esHaberes ? "gestionar el descuento en el recibo de haberes." : "registrar el pago.") +
        " Generado por el sistema del predio el " + P.f.fechaHora(l.fecha) + (l.usuario_nombre ? " por " + l.usuario_nombre : "") + "."));
    return imprimirHtml(nodo, ESTILO_A4, "Liquidacion " + l.id);
  };

  // Comprobante de la estadía (no fiscal), con original para el huésped y duplicado para el predio.
  // datos: { reserva, empresa, predio, total, adicionales, cuenta, detalleAlojamiento, manual }
  var ESTILO_COMPROBANTE = ESTILO_A4 + ".copia { page-break-after: always; break-after: page; } .copia:last-child { page-break-after: auto; break-after: auto; }" +
    ".tipo-copia { display: inline-block; margin-top: 6px; padding: 3px 10px; border: 1.5px solid #0d5482; border-radius: 6px; font-weight: 800; letter-spacing: .08em; color: #0d5482; }" +
    ".no-fiscal { margin-top: 4px; font-size: 11px; font-weight: 700; color: #5d7690; text-transform: uppercase; letter-spacing: .04em; }" +
    ".rec-liq-detalle { display: block; font-size: 11px; color: #5d7690; font-weight: 400; } .der { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } tr.rec-liq-subtotal td, tr.rec-liq-subtotal th { font-weight: 800; border-top: 1px solid #bcd9ec; } tfoot td, tfoot th { padding: 9px 6px; font-size: 15px; font-weight: 800; color: #0d5482; border-top: 2px solid #0d5482; }" +
    "tbody th[scope=row] { text-align: left; font-weight: 600; font-size: 12.5px; text-transform: none; letter-spacing: 0; color: #12344d; border-bottom: 1px solid #e6f1f9; }" +
    ".pendiente { margin-top: 14px; padding: 10px 12px; border: 1px solid #f0c27a; border-radius: 8px; background: #fff8ea; }";
  P.imprimirComprobanteEstadia = function (datos) {
    var r = datos.reserva, e = datos.empresa || {}, a = datos.cuenta || { movimientos: [] };
    var emitido = P.f.fechaHora(new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace("T", " "));
    var tabla = P.recepcion.liquidacion(datos).querySelector("table");
    var sinDevolver = (datos.adicionales || []).filter(function (l) { return l.modalidad !== "VENTA" && l.fecha_desde && !l.devuelto; });
    var personas = (r.personas || []).map(function (p) { return p.apellido + ", " + p.nombre; }).join(" · ");
    var ingresaron = (r.personas || []).filter(function (p) { return p.entrada; });
    var salidaReal = ingresaron.length && ingresaron.every(function (p) { return p.salida; }) ? ingresaron.map(function (p) { return p.salida; }).sort().pop() : null;
    function copia(tipo) {
      return h("div.copia",
        h("div.cab",
          h("div", h("h1", e.razon_social || "Asociación Judicial Bonaerense"), h("div.gris", e.nombre_predio || datos.predio || ""), e.direccion ? h("div.gris", e.direccion) : null,
            e.cuit ? h("div.gris", "CUIT " + e.cuit) : null),
          h("div.der", h("h1", "Comprobante de estadía"), h("div", h("strong", "Reserva T-" + r.id)), h("div.gris", "Emitido el " + emitido),
            h("div.no-fiscal", "Documento no válido como factura"), h("div.tipo-copia", tipo))),
        h("h2", "Titular y estadía"),
        h("div.datos",
          h("div", h("span", "Titular"), h("strong", r.titular_nombre || "")),
          h("div", h("span", "DNI"), h("strong", documento(r.titular_dni) || "—")),
          h("div", h("span", "Servicio"), h("strong", r.servicio || "")),
          h("div", h("span", "Recurso"), h("strong", (r.recursos || []).map(function (x) { return x.nombre; }).join(", ") || r.recurso || "—")),
          h("div", h("span", "Ingreso"), h("strong", P.f.fecha(r.fecha_inicio))),
          h("div", h("span", salidaReal ? "Salida" : "Salida prevista"), h("strong", P.f.fecha(salidaReal || r.fecha_fin)))),
        personas ? h("p", h("span.gris", "Pasajeros: "), personas) : null,
        h("h2", "Detalle"),
        tabla.cloneNode(true),
        sinDevolver.length ? h("div.pendiente", h("strong", "Artículos sin devolver: "), sinDevolver.map(function (l) { return l.nombre + " (" + l.cantidad + ")"; }).join(", ")) : null,
        h("div.firmas", h("div", "Firma del huésped"), h("div", "Aclaración"), h("div", "Firma y sello del predio")),
        h("div.pie", (tipo === "ORIGINAL" ? "Original para el huésped. " : "Duplicado para el predio. ") +
          "Comprobante interno de la estadía; los importes de la reserva original se verifican en Mi AJB."));
    }
    return imprimirHtml(h("div", copia("ORIGINAL"), copia("DUPLICADO")), ESTILO_COMPROBANTE, "Comprobante T-" + r.id);
  };

  P.imprimirCompra = function (datos) {
    var c = datos.compra;
    var temporal = c.estado === "TEMPORAL" || c.estado === "DESCARTADA";
    var conFactura = !temporal && c.total_factura != null;
    var ajuste = conFactura ? P.redondear(Number(c.total_factura) - Number(c.total_items), 2) : 0;
    var nodo = h("div",
      h("div.cab", h("div", h("h1", (temporal ? "Recepción temporal N° " : "Compra N° ") + c.id), h("div.gris", c.proveedor + (c.proveedor_cuit ? " · CUIT " + c.proveedor_cuit : ""))),
        h("div.der", c.factura ? h("div", "Factura " + c.factura + " del " + P.f.fecha(c.fecha_factura)) : null, c.remito ? h("div", "Remito " + c.remito + " del " + P.f.fecha(c.fecha_remito)) : null,
          h("div.gris", "Cargada el " + P.f.fechaHora(c.fecha_creacion) + " por " + (c.creado_por || "")))),
      c.estado === "TEMPORAL" ? h("p", "Mercadería recibida. Pendiente de factura definitiva.") : null,
      c.estado === "ANULADA" || c.estado === "DESCARTADA" ? h("p", h("strong", c.estado + " · " + (c.anulacion_motivo || ""))) : null,
      h("table", h("thead", h("tr", h("th", "Producto"), h("th.num", "Cantidad"), h("th.num", "Unitario"), h("th.num", "Anterior"), h("th.num", "Margen"), h("th.num", "Total"))),
        h("tbody", (datos.items || []).map(function (i) {
          return h("tr", h("td", i.producto), h("td.num", P.f.numero(i.cantidad)), h("td.num", P.f.pesos(i.precio_unitario)), h("td.num", P.f.pesos(i.precio_anterior)), h("td.num", P.f.pct(i.margen)), h("td.num", P.f.pesos(i.subtotal)));
        }))),
      h("div.totales",
        ajuste ? h("div", h("span", "Suma de productos"), h("strong", P.f.pesos(c.total_items))) : null,
        ajuste ? h("div", h("span", "Redondeo"), h("strong", P.f.pesos(ajuste))) : null,
        h("div.final", h("span", temporal ? "Total provisorio" : conFactura ? "Total de la factura" : "Total"), h("span", P.f.pesos(conFactura ? c.total_factura : c.total_items)))),
      c.observaciones ? h("p", c.observaciones) : null);
    return imprimirHtml(nodo, ESTILO_A4, "Compra " + c.id);
  };
})();
