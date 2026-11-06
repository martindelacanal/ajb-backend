/* Los controladores de texto de las cajas sólo comparten el juego ASCII.
   Armar renglones reales permite conservar espacios, columnas y separadores en papel. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;

  function imprimible(valor) {
    return String(valor == null ? "" : valor).toUpperCase()
      .replace(/N[º°]/g, "NRO.").replace(/[¡¿]/g, "").replace(/×/g, "X")
      .replace(/[·•–—−]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\u2044/g, "/")
      .replace(/[^ -~]/g, " ").replace(/\s+/g, " ").trim();
  }

  function Papel(ancho) {
    this.columnas = Number(ancho) === 58 ? 32 : 40;
    this.lineas = [];
  }

  Papel.prototype.texto = function (valor, alinear) {
    var resto = imprimible(valor);
    while (resto) {
      var corte = resto.length;
      if (corte > this.columnas) {
        corte = resto.lastIndexOf(" ", this.columnas);
        if (corte < 1) corte = this.columnas;
      }
      var renglon = resto.slice(0, corte);
      var libre = this.columnas - renglon.length;
      var margen = alinear === "derecha" ? libre : alinear === "centro" ? Math.floor(libre / 2) : 0;
      this.lineas.push(" ".repeat(margen) + renglon);
      resto = resto.slice(corte).trim();
    }
  };

  Papel.prototype.par = function (izquierda, derecha) {
    var izq = imprimible(izquierda);
    var der = imprimible(derecha);
    var espacio = this.columnas - izq.length - der.length;
    if (izq && der && espacio > 0) this.lineas.push(izq + " ".repeat(espacio) + der);
    else {
      this.texto(izq);
      this.texto(der, "derecha");
    }
  };

  Papel.prototype.separar = function () { this.lineas.push("-".repeat(this.columnas)); };

  Papel.prototype.firma = function (etiqueta) {
    this.lineas.push("", "", "");
    this.lineas.push(etiqueta + ": " + "_".repeat(this.columnas - etiqueta.length - 2));
  };

  Papel.prototype.terminar = function (clase) {
    // La marca final obliga a avanzar el rollo aunque el driver suprima márgenes vacíos.
    var corte = "-" + " ".repeat(this.columnas - 2) + "-";
    return P.h("pre." + clase, this.lineas.concat(["", "", "", "", "", "", corte]).join("\n"));
  };

  function encabezado(p, e, v, marca) {
    p.par("AJB-GESTION", e.nombre_predio);
    p.texto("USO INTERNO", "centro");
    if (marca) p.texto(marca, "centro");
    p.par(v.boca, v.caja);
  }

  function fechaHora(p, fecha) {
    p.par("FECHA: " + P.f.fecha(fecha), "HORA: " + P.f.hora(fecha));
  }

  function referenciaVenta(p, v, reimpresion) {
    p.separar();
    p.texto("TICKET NRO: " + String(v.id).padStart(6, "0"));
    fechaHora(p, v.fecha);
    if (reimpresion) p.texto("*** REIMPRESION ***", "centro");
    if (v.estado === "ANULADA") p.texto("*** VENTA ANULADA ***", "centro");
  }

  function datosAfiliado(p, a) {
    if (a.nombre) p.texto("AFILIADO: " + a.nombre);
    if (a.legajo) p.texto("LEGAJO: " + a.legajo);
    if (a.dni) p.texto("DNI: " + P.documento(a.dni));
    if (a.departamental) p.texto("DEPARTAMENTAL: " + a.departamental);
  }

  function columnasProducto(p, cantidad, unitario, total) {
    var finUnitario = Math.round(p.columnas * 0.62);
    // Ante importes grandes, acortar primero los espacios y conservar cada cifra.
    finUnitario = Math.max(finUnitario, cantidad.length + 1 + unitario.length);
    finUnitario = Math.min(finUnitario, p.columnas - 1 - total.length);
    var espacio = finUnitario - cantidad.length - unitario.length;
    if (espacio >= 1) {
      p.lineas.push(cantidad + " ".repeat(espacio) + unitario + total.padStart(p.columnas - finUnitario));
    } else {
      p.par("CANTIDAD", cantidad);
      p.par("IMP.UNIT.", unitario);
      p.par("IMP.TOTAL", total);
    }
  }

  function importeDetalle(importe) { return imprimible(P.f.pesos(importe)).replace(/^\$\s*/, ""); }

  function comprobante(datos, reimpresion, marca, descuento) {
    var p = new Papel(datos.ancho);
    var v = datos.venta, e = datos.empresa || {};
    encabezado(p, e, v, marca);
    p.texto("PAGO: " + (descuento ? "DESCUENTO" : P.FORMAS[v.forma_pago] || v.forma_pago));
    referenciaVenta(p, v, reimpresion);
    if (v.usuario_nombre) p.texto("ATENDIO: " + v.usuario_nombre);
    p.separar();
    p.texto("DETALLE");
    columnasProducto(p, "CANTIDAD", "IMP.UNIT.", "IMP.TOTAL");
    p.separar();
    (datos.items || []).forEach(function (it) {
      p.texto(it.descripcion);
      columnasProducto(p, imprimible(P.f.numero(it.cantidad)), importeDetalle(it.precio_unitario), importeDetalle(it.subtotal));
    });
    p.separar();
    p.par("IMPORTE TOTAL", P.f.pesos(v.total));
    if (v.forma_pago === "EFECTIVO" && v.recibido != null) {
      p.par("RECIBIDO", P.f.pesos(v.recibido));
      p.par("VUELTO", P.f.pesos(v.vuelto || 0));
    }
    if (v.codigo_pago) p.texto("CODIGO DE PAGO: " + v.codigo_pago);
    if (datos.afiliado && !descuento) { p.separar(); datosAfiliado(p, datos.afiliado); }
    if (e.razon_social || e.cuit || e.direccion || e.leyenda) {
      p.separar();
      p.texto(e.razon_social);
      if (e.cuit) p.texto("CUIT: " + e.cuit);
      p.texto(e.direccion);
      p.texto(e.leyenda);
    }
    return p.terminar(marca === "COMANDA - PREPARACION" ? "comanda" : "cliente");
  }

  function talonDescuento(datos, reimpresion) {
    var p = new Papel(datos.ancho);
    var v = datos.venta, e = datos.empresa || {}, a = datos.afiliado || {};
    encabezado(p, e, v, "TALON DE DESCUENTO");
    referenciaVenta(p, v, reimpresion);
    p.par("IMPORTE", P.f.pesos(v.total));
    if (a.disponible != null) p.par("SALDO DISPONIBLE", P.f.pesos(a.disponible));
    p.separar();
    if (v.estado === "ANULADA") p.texto("DESCUENTO ANULADO", "centro");
    else String(e.texto_autorizacion || "").split(/\r?\n/).forEach(function (linea) { p.texto(linea); });
    p.separar();
    datosAfiliado(p, a);
    if (v.estado !== "ANULADA") p.firma("FIRMA");
    return p.terminar("talon");
  }

  function imprimir(partes, ancho, titulo) {
    var angosto = Number(ancho) === 58;
    var estilo = "@page { size: auto; margin: 0; } * { box-sizing: border-box; }" +
      "html, body { padding: 0; margin: 0; color: #000; background: white; }" +
      "pre { width: " + (angosto ? 48 : 72) + "mm; margin: 0 auto; padding: 2mm 0 0; " +
      "font: " + (angosto ? "7pt" : "8.4pt") + "/4mm 'Courier New', monospace; white-space: pre; orphans: 1; widows: 1; }" +
      ".comanda { page-break-before: always; break-before: page; }";
    return P.imprimirHtml(P.h("div", partes), estilo, titulo);
  }

  P.imprimirTicket = function (datos, opciones) {
    opciones = opciones || {};
    var comanda = opciones.comanda === undefined ? datos.imprimir_comanda : opciones.comanda;
    var reimpresion = opciones.reimpresion || datos.reimpresion;
    var descuento = ["DESCUENTO", "DESCUENTO_HABERES"].includes(datos.venta.forma_pago);
    var partes = [comprobante(datos, reimpresion, comanda ? "CLIENTE" : "", descuento)];
    if (descuento) partes.push(talonDescuento(datos, reimpresion));
    if (comanda) partes.push(comprobante(datos, reimpresion, "COMANDA - PREPARACION", descuento));
    return imprimir(partes, datos.ancho, "Ticket " + datos.venta.id);
  };

  P.imprimirCierre = function (datos) {
    var c = datos.cierre, e = datos.empresa || {};
    var ancho = datos.ancho || (P.puesto() || {}).ancho_ticket;
    var p = new Papel(ancho);
    encabezado(p, e, c, "CIERRE DE CAJA NRO: " + c.id);
    fechaHora(p, c.fecha);
    if (c.usuario_nombre) p.texto("CAJERO: " + c.usuario_nombre);
    p.separar();
    p.par("SALDO INICIAL", P.f.pesos(c.saldo_inicial));
    p.par("INGRESOS", P.f.pesos(c.ingresos));
    p.par("EGRESOS", P.f.pesos(c.egresos));
    p.par("EFECTIVO ESPERADO", P.f.pesos(c.saldo_esperado));
    p.par("EFECTIVO CONTADO", P.f.pesos(c.efectivo_contado));
    p.par(Number(c.diferencia) === 0 ? "SIN DIFERENCIA" : Number(c.diferencia) > 0 ? "SOBRANTE" : "FALTANTE", P.f.pesos(Math.abs(c.diferencia)));
    p.par("RETIRO", P.f.pesos(c.retiro));
    p.par("QUEDA EN CAJA", P.f.pesos(c.queda_en_caja));
    p.separar();
    p.par("VENTAS (" + c.ventas_cantidad + ")", P.f.pesos(c.ventas_total));
    (datos.ventas_por_forma || []).forEach(function (v) {
      p.par((P.FORMAS[v.forma_pago] || v.forma_pago) + " (" + v.cantidad + ")", P.f.pesos(v.total));
    });
    if (c.observaciones) { p.separar(); p.texto("OBSERVACIONES: " + c.observaciones); }
    p.firma("FIRMA DEL CAJERO");
    p.firma("FIRMA DE QUIEN RECIBE");
    return imprimir([p.terminar("cierre")], ancho, "Cierre " + c.id);
  };
})();
