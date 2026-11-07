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
          h("div.der", h("h1", "Liquidación de la estadía"), h("div", h("strong", "Reserva T-" + r.id)), h("div.gris", "Emitido el " + emitido),
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
          "Liquidación interna de la estadía; cada pago tiene su recibo numerado. Los importes de la reserva original se verifican en Mi AJB."));
    }
    return imprimirHtml(h("div", copia("ORIGINAL"), copia("DUPLICADO")), ESTILO_COMPROBANTE, "Liquidacion T-" + r.id);
  };

  // ------------------------------------------------------------------ recibos y notas de crédito

  // Importe en letras para el «Son pesos…» del comprobante (hasta 99.999.999,99).
  var UNIDADES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce",
    "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro",
    "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
  var DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
  var CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];
  function menorMil(n, apocope) {
    if (!n) return "";
    if (n === 100) return "cien";
    var c = Math.floor(n / 100), r = n % 100, partes = [];
    if (c) partes.push(CENTENAS[c]);
    if (r) {
      var t = r < 30 ? UNIDADES[r] : DECENAS[Math.floor(r / 10)] + (r % 10 ? " y " + UNIDADES[r % 10] : "");
      // «veintiún mil», «treinta y un mil»: delante de «mil» y «millones» va la forma corta.
      if (apocope) t = t.replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");
      partes.push(t);
    }
    return partes.join(" ");
  }
  function enLetras(importe) {
    var centavos = Math.round(Math.abs(Number(importe) || 0) * 100);
    var n = Math.floor(centavos / 100), resto = centavos % 100;
    var millones = Math.floor(n / 1000000), miles = Math.floor((n % 1000000) / 1000), unidades = n % 1000, partes = [];
    if (millones) partes.push(millones === 1 ? "un millón" : menorMil(millones, true) + " millones");
    if (miles) partes.push(miles === 1 ? "mil" : menorMil(miles, true) + " mil");
    if (unidades) partes.push(menorMil(unidades, false));
    return (partes.length ? partes.join(" ") : "cero") + " con " + ("0" + resto).slice(-2) + "/100";
  }
  P.enLetras = enLetras;

  // Original y duplicado entran en una A4 con línea de corte (como el talonario); si hay muchos renglones, el duplicado pasa a otra hoja.
  var ESTILO_RECIBO = "@page { size: A4; margin: 8mm 10mm; } * { box-sizing: border-box; } body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; font-size: 10px; color: #12344d; }" +
    ".copia { position: relative; border: 1.3px solid #0d5482; border-radius: 9px; padding: 7px 10px 6px; break-inside: avoid; page-break-inside: avoid; overflow: hidden; }" +
    ".corte { margin: 4mm 0; border-top: 1px dashed #7b8ea3; text-align: center; line-height: 0; } .corte span { background: #fff; padding: 0 8px; font-size: 8px; color: #7b8ea3; letter-spacing: .08em; }" +
    ".cab { display: grid; grid-template-columns: 1.35fr 1fr; gap: 10px; align-items: stretch; }" +
    ".emisor h1 { margin: 0; font-size: 13px; letter-spacing: .03em; text-transform: uppercase; color: #0d5482; } .emisor div { line-height: 1.3; color: #36556f; }" +
    ".emisor .predio { margin-top: 3px; font-size: 11.5px; font-weight: 800; color: #12344d; } .emisor .iva { margin-top: 2px; font-weight: 700; text-transform: uppercase; font-size: 8.5px; letter-spacing: .05em; }" +
    ".doc { border: 1.3px solid #0d5482; border-radius: 7px; padding: 5px 9px; line-height: 1.3; } .doc .tipo { font-size: 14px; font-weight: 800; letter-spacing: .08em; color: #0d5482; }" +
    ".doc .numero { font-size: 14.5px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: .02em; } .doc .no-fiscal { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #5d7690; }" +
    ".copia-tipo { display: inline-block; margin-top: 3px; padding: 0 8px; border: 1.3px solid #0d5482; border-radius: 5px; font-size: 8.5px; font-weight: 800; letter-spacing: .1em; color: #0d5482; }" +
    ".cliente { margin-top: 6px; display: grid; grid-template-columns: 1.7fr 1fr 1fr 1.2fr; gap: 2px 10px; padding: 5px 9px; border: 1px solid #bcd9ec; border-radius: 7px; }" +
    ".cliente span { display: block; font-size: 8px; text-transform: uppercase; letter-spacing: .05em; color: #5d7690; } .cliente strong { font-size: 10.5px; }" +
    ".estadia, .corrige, .observacion { margin-top: 4px; line-height: 1.35; } .estadia b, .corrige b, .observacion b { color: #36556f; }" +
    ".corrige { padding: 3px 8px; border-left: 3px solid #0d5482; background: #f3f8fc; }" +
    "table { width: 100%; border-collapse: collapse; margin-top: 5px; } th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: .05em; color: #36556f; border-bottom: 1.3px solid #0d5482; padding: 2px 6px; }" +
    "td { padding: 3px 6px; border-bottom: 1px solid #e6f1f9; vertical-align: top; } .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } td small { display: block; color: #5d7690; font-size: 8.5px; }" +
    "tfoot td { border-bottom: 0; border-top: 1.6px solid #0d5482; font-size: 12.5px; font-weight: 800; color: #0d5482; padding-top: 4px; }" +
    ".letras { margin-top: 3px; font-style: italic; } .saldo { margin-top: 2px; color: #36556f; }" +
    ".firmas { display: grid; grid-template-columns: 1fr 1fr; gap: 34px; margin-top: 22px; } .firmas div { border-top: 1px solid #12344d; padding-top: 2px; text-align: center; font-size: 8.5px; color: #36556f; }" +
    ".pie { margin-top: 5px; display: flex; justify-content: space-between; gap: 12px; font-size: 8px; color: #5d7690; } .pie .leyenda { font-weight: 700; }" +
    ".sello { position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%) rotate(-14deg); padding: 2px 20px; border: 4px solid rgba(179, 38, 30, .28); border-radius: 12px;" +
    " font-size: 44px; font-weight: 900; letter-spacing: .14em; color: rgba(179, 38, 30, .28); white-space: nowrap; }";

  function dato(etiqueta, valor) { return h("div", h("span", etiqueta), h("strong", valor === null || valor === undefined || valor === "" ? "—" : valor)); }

  /**
   * Recibo o nota de crédito (no fiscal) con original para el titular y duplicado para el predio, uno debajo
   * del otro con línea de corte (si no entran, el duplicado sale en otra hoja).
   * c: GET /contable/comprobantes/:id o `datos` de la operación recién hecha. opciones: { reimpresion }
   */
  P.imprimirComprobante = function (c, opciones) {
    opciones = opciones || {};
    var e = c.emisor || {}, cl = c.cliente || {}, es = c.estadia || {}, nc = c.tipo === "NOTA_CREDITO";
    var ahora = P.f.fechaHora(new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace("T", " "));
    var medio = FORMAS[c.medio] || c.medio || "—";
    var recurso = [es.recurso, es.numero_parcela ? (/parcela/i.test(es.recurso || "") ? "N° " : "Parcela ") + es.numero_parcela : null].filter(Boolean).join(" ");
    var estadia = [es.servicio, recurso || null, es.ubicacion ? "Ubicación: " + es.ubicacion : null,
      es.fecha_inicio ? "del " + P.f.fecha(es.fecha_inicio) + " al " + P.f.fecha(es.fecha_fin) : null,
      es.personas ? es.personas + (es.personas === 1 ? " persona" : " personas") : null].filter(Boolean).join(" · ");
    var vehiculos = (es.vehiculos || []).map(function (v) { return v.patente + (v.sector ? " (sector " + v.sector + ")" : ""); }).join(", ");
    var saldo = c.saldo ? Number(c.saldo.total) : null;
    var devoluciones = (c.notas_credito || []).filter(function (n) { return n.estado === "EMITIDO"; });
    var sello = c.estado === "ANULADO" ? (nc ? "ANULADA" : "ANULADO") : null;
    function renglon(l) {
      var a = l.articulo;
      var extra = a ? [a.modalidad === "VENTA" ? "Compra" : "Alquiler", P.recepcion ? P.recepcion.detalleArticulo(a) : null, a.fecha_desde && P.recepcion ? P.recepcion.periodo(a) : null].filter(Boolean).join(" · ") : l.detalle;
      return h("tr", h("td", l.texto, extra ? h("small", extra) : null), h("td.num", P.f.pesos(l.importe)));
    }
    function copia(tipo) {
      return h("div.copia",
        sello ? h("div.sello", sello) : null,
        h("div.cab",
          h("div.emisor",
            h("h1", e.razon_social || "Asociación Judicial Bonaerense"),
            e.domicilio_legal ? h("div", e.domicilio_legal) : null,
            e.telefono || e.correo ? h("div", [e.telefono ? "Tel. " + e.telefono : null, e.correo].filter(Boolean).join(" · ")) : null,
            h("div.predio", e.nombre_predio || ""),
            e.direccion ? h("div", e.direccion) : null,
            e.condicion_iva ? h("div.iva", e.condicion_iva) : null),
          h("div.doc",
            h("div.tipo", nc ? "NOTA DE CRÉDITO" : "RECIBO"),
            h("div.numero", "N° " + c.codigo),
            h("div", "Fecha: " + P.f.fechaHora(c.fecha)),
            e.cuit ? h("div", "CUIT: " + e.cuit) : null,
            e.iibb ? h("div", "Ingresos Brutos (Conv. Multilateral): " + e.iibb) : null,
            e.inicio_actividades ? h("div", "Inicio de actividades: " + e.inicio_actividades) : null,
            h("div.no-fiscal", "Comprobante no válido como factura"),
            h("div.copia-tipo", tipo))),
        h("div.cliente",
          dato("Señor/a", cl.nombre ? cl.nombre + (cl.afiliado ? " (afiliado)" : " (particular)") : null), dato("DNI", documento(cl.dni) || null), dato("Legajo", cl.legajo),
          dato("Condición frente al IVA", cl.condicion_iva || "Consumidor final"),
          dato("Domicilio", cl.domicilio), dato(cl.afiliado ? "Departamental" : "Localidad", cl.departamental),
          dato(nc ? "Se devuelve en" : "Forma de pago", medio), dato("Reserva", es.reserva_id ? "T-" + es.reserva_id : null)),
        estadia || vehiculos ? h("div.estadia", estadia ? [h("b", "Estadía: "), estadia] : null, vehiculos ? [estadia ? " · " : null, h("b", "Vehículos: "), vehiculos] : null) : null,
        nc && (c.origen || c.motivo) ? h("div.corrige", c.origen ? [h("b", "Corrige al recibo "), c.origen.codigo + " del " + P.f.fecha(c.origen.fecha) + " por " + P.f.pesos(c.origen.total) + ". "] : null,
          c.motivo ? [h("b", "Motivo: "), c.motivo] : null) : null,
        h("table", h("thead", h("tr", h("th", nc ? "Concepto devuelto" : "Concepto"), h("th.num", "Importe"))),
          h("tbody", (c.renglones || []).map(renglon)),
          h("tfoot", h("tr", h("td", nc ? "Total devuelto" : "Total recibido"), h("td.num", P.f.pesos(c.total))))),
        h("div.letras", (nc ? "Se devuelve la suma de pesos " : "Recibimos la suma de pesos ") + enLetras(c.total) + "."),
        saldo == null ? null : h("div.saldo", "Saldo de la estadía después de este comprobante: " +
          (Math.abs(saldo) < 0.005 ? "saldada." : saldo > 0 ? P.f.pesos(saldo) + " por cobrar." : P.f.pesos(-saldo) + " a favor del titular.")),
        devoluciones.length ? h("div.saldo", "Devoluciones de este recibo: " + devoluciones.map(function (n) { return n.codigo + " por " + P.f.pesos(n.total); }).join(", ") + ".") : null,
        c.observacion ? h("div.observacion", h("b", "Observación: "), c.observacion) : null,
        h("div.firmas", nc ? [h("div", "Recibí conforme la devolución · Firma y aclaración del titular"), h("div", "Firma y sello por el predio")]
          : [h("div", "Firma y aclaración de quien recibe por el predio"), h("div", "Sello del predio")]),
        h("div.pie", h("span.leyenda", e.leyenda_comprobante || "Documento no válido como factura."),
          h("span", (tipo === "ORIGINAL" ? "Original para el titular" : "Duplicado para el predio") + (c.usuario_nombre ? " · Emitió " + c.usuario_nombre : "") +
            (opciones.reimpresion ? " · Reimpreso el " + ahora : ""))));
    }
    return imprimirHtml(h("div", copia("ORIGINAL"), h("div.corte", h("span", "✂ CORTAR AQUÍ")), copia("DUPLICADO")), ESTILO_RECIBO, c.nombre + " " + c.codigo);
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
