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
        h("div", h("span", "Período de consumos"), h("strong", P.f.fecha(l.desde) + " al " + P.f.fecha(l.hasta))),
        h("div", h("span", "Consumos"), h("strong", String(l.ventas_cantidad || (datos.ventas || []).length)))),
      h("h2", "Detalle de consumos con descuento de haberes"),
      h("table", h("thead", h("tr", h("th", "Ticket"), h("th", "Fecha"), h("th", "Boca"), h("th.num", "Importe"))),
        h("tbody", (datos.ventas || []).map(function (v) {
          return h("tr", h("td", "N° " + v.id), h("td", P.f.fechaHora(v.fecha)), h("td", v.boca), h("td.num", P.f.pesos(v.total)));
        }))),
      h("div.totales",
        h("div", h("span", "Total consumido"), h("strong", P.f.pesos(l.total_consumos))),
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

  P.imprimirCompra = function (datos) {
    var c = datos.compra;
    var nodo = h("div",
      h("div.cab", h("div", h("h1", "Compra N° " + c.id), h("div.gris", c.proveedor + (c.proveedor_cuit ? " · CUIT " + c.proveedor_cuit : ""))),
        h("div.der", c.factura ? h("div", "Factura " + c.factura + " del " + P.f.fecha(c.fecha_factura)) : null, c.remito ? h("div", "Remito " + c.remito + " del " + P.f.fecha(c.fecha_remito)) : null,
          h("div.gris", "Cargada el " + P.f.fechaHora(c.fecha_creacion) + " por " + (c.creado_por || "")))),
      c.estado === "ANULADA" ? h("p", h("strong", "COMPRA ANULADA: " + (c.anulacion_motivo || ""))) : null,
      h("table", h("thead", h("tr", h("th", "Producto"), h("th.num", "Cantidad"), h("th.num", "Unitario"), h("th.num", "Anterior"), h("th.num", "Margen"), h("th.num", "Total"))),
        h("tbody", (datos.items || []).map(function (i) {
          return h("tr", h("td", i.producto), h("td.num", P.f.numero(i.cantidad)), h("td.num", P.f.pesos(i.precio_unitario)), h("td.num", P.f.pesos(i.precio_anterior)), h("td.num", P.f.pct(i.margen)), h("td.num", P.f.pesos(i.subtotal)));
        }))),
      h("div.totales", h("div.final", h("span", "Total"), h("span", P.f.pesos(c.total_items)))),
      c.observaciones ? h("p", c.observaciones) : null);
    return imprimirHtml(nodo, ESTILO_A4, "Compra " + c.id);
  };
})();
