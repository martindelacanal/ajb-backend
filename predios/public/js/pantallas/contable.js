/* Contable: recibos y notas de crédito de la recepción (listado, detalle con historial, nota de crédito y anulación). */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P, h = P.h, pesos = P.f.pesos, R = P.recepcion;
  var MEDIOS = { EFECTIVO: "Efectivo", TRANSFERENCIA: "Transferencia" };
  var OPERACIONES = {
    DIFERENCIA_RESERVA: "Diferencia de la reserva", ARTICULOS: "Alquileres y compras", SALDO: "Saldo para consumos",
    LIQUIDACION: "Liquidación de consumos", SALIDA: "Cuenta al salir", NOTA_CREDITO: "Corrección de un recibo", ANULACION: "Anulación de un recibo"
  };
  // Qué pasa en la cuenta de la estadía cuando se devuelve cada tipo de renglón.
  var EFECTO = {
    ALOJAMIENTO: "Vuelve a quedar como deuda de la reserva hasta que la corrijas (si ya la corregiste, salda lo que estaba a favor).",
    ARTICULO: "El artículo vuelve a figurar como no pagado hasta que corrijas la reserva o lo cobres de nuevo.",
    SALDO: "Se descuenta del saldo para consumos de la persona: tiene que tenerlo disponible.",
    CONSUMOS: "Se toma como un descuento sobre lo consumido: no vuelve a generar deuda."
  };
  var ACCIONES_HISTORIAL = {
    "Recibo emitido": "Emitido", "Nota de crédito emitida": "Emitida", "Devolución con nota de crédito": "Devolución",
    "Recibo anulado": "Anulado", "Nota de crédito anulada": "Anulada", "Recibo vigente otra vez": "Vigente otra vez"
  };

  function codigoDe(f) { return (f.tipo === "NOTA_CREDITO" ? "NC-" : "R-") + ("00000000" + f.numero).slice(-8); }
  function nombreDe(f) { return f.tipo === "NOTA_CREDITO" ? "Nota de crédito" : "Recibo"; }
  function chipEstado(c) {
    return c.estado === "ANULADO" ? P.chip(c.tipo === "NOTA_CREDITO" ? "Anulada" : "Anulado", "ANULADA") : P.chip("Vigente", "OK");
  }
  function importeConSigno(c) { return (c.tipo === "NOTA_CREDITO" ? "− " : "") + pesos(c.total); }
  function ir(ruta) { P.ruta.ir(ruta); }
  function imprimir(id, reimpresion) {
    return P.get("/contable/comprobantes/" + id).then(function (c) { return P.imprimirComprobante(c, { reimpresion: reimpresion }); });
  }
  function selectorCaja(caja, campo) {
    return P.opciones("cajas").then(function (xs) {
      var asignada = P.puesto() && P.puesto().caja_id;
      if (!P.esAdmin()) xs = xs.filter(function (x) { return asignada && String(x.valor) === String(asignada); });
      R.opSelect(caja, xs, asignada && xs.some(function (x) { return String(x.valor) === String(asignada); }) ? asignada : xs.length === 1 ? xs[0].valor : "", "Elegí una caja");
      if (campo) campo.dataset.cargado = "1";
    }).catch(P.error);
  }

  /* Después de un cobro o una devolución: el comprobante queda listo para imprimir (original y duplicado). */
  function emitido(x, titulo) {
    if (!x || !x.comprobante) return null;
    var c = x.comprobante, impreso = false, nc = c.tipo === "NOTA_CREDITO";
    var boton = P.btn(nc ? "Imprimir nota de crédito" : "Imprimir recibo", { tipo: "primario", icono: "imprimir", onclick: function (e) {
      P.ejecutar(e.currentTarget, function () {
        var re = impreso;
        impreso = true;
        return x.datos ? P.imprimirComprobante(x.datos, { reimpresion: re }) : imprimir(c.id, re);
      }).catch(function () {});
    } });
    var m = P.modal({
      titulo: titulo || (nc ? "Nota de crédito emitida" : "Recibo emitido"),
      contenido: h("div.columna",
        P.mensaje(x.mensaje, "ok"),
        h("div.rec-resumen.rec-cobro-total", h("span", (nc ? "Nota de crédito " : "Recibo ") + c.codigo), h("strong", pesos(c.total))),
        h("p.texto-3.chico", "Sale en una hoja con el original para el titular y el duplicado para el predio. " +
          (nc ? "El titular firma el original como constancia de la devolución." : "No es válido como factura."))),
      acciones: [P.btn("Listo", { tipo: "secundario", onclick: function () { m.cerrar(); } }), boton]
    });
    setTimeout(function () { boton.focus(); }, 30);
    return m;
  }

  /* Comprobantes de una reserva, para su ficha. */
  function listaReserva(comprobantes) {
    return R.tabla(["Comprobante", "Fecha", "Concepto", "Importe", "Medio", "Estado", ""], comprobantes.map(function (c) {
      var codigo = P.esAdmin() ? h("a.rec-codigo.rec-enlace", { href: "#/contable/" + c.id, title: "Abrir en Contable" }, c.codigo) : h("strong.rec-codigo", c.codigo);
      return [codigo, P.f.fechaHora(c.fecha), (OPERACIONES[c.operacion] || nombreDe(c)) + (c.corrige ? " · corrige " + c.corrige : ""), importeConSigno(c),
        MEDIOS[c.medio] || c.medio || "—", chipEstado(c),
        R.btn("Imprimir", function () { return imprimir(c.id, true); }, "texto", { chico: true, icono: "imprimir", etiqueta: "Imprimir " + nombreDe(c).toLowerCase() + " " + c.codigo })];
    }), ".rec-tabla-comprobantes");
  }

  P.contable = { emitido: emitido, imprimir: imprimir, listaReserva: listaReserva, chipEstado: chipEstado, OPERACIONES: OPERACIONES };

  // ------------------------------------------------------------------ nota de crédito y anulación

  function campoDevolucion(medioInicial) {
    var medio = R.sel(R.opciones(MEDIOS), medioInicial || "EFECTIVO");
    var caja = R.sel([], null, "Elegí una caja");
    var campoCaja = P.campo("Caja que devuelve el efectivo", caja);
    var cargada = false;
    function actualizar() {
      campoCaja.hidden = medio.value !== "EFECTIVO";
      if (!campoCaja.hidden && !cargada) { cargada = true; selectorCaja(caja); }
    }
    medio.onchange = actualizar;
    actualizar();
    return {
      nodos: R.grid(P.campo("Se devuelve en", medio), campoCaja),
      datos: function () {
        if (!campoCaja.hidden && !caja.value) { caja.focus(); throw Error("Elegí la caja de la que sale el efectivo."); }
        return { medio: medio.value, caja_id: campoCaja.hidden ? null : caja.value };
      }
    };
  }

  function notaCredito(c, recargar) {
    var key = R.nuevaClave();
    var filas = c.renglones.filter(function (l) { return l.disponible > 0; }).map(function (l) {
      var imp = P.dinero({ valor: P.f.numero(l.disponible) });
      imp.setAttribute("aria-label", "Importe a devolver de " + l.texto);
      var marca = P.check(l.texto, true, [l.detalle, "Queda " + pesos(l.disponible) + (l.devuelto ? " · ya se devolvieron " + pesos(l.devuelto) : "")].filter(Boolean).join(" · "), actualizar);
      imp.addEventListener("input", actualizar);
      var f = { l: l, marca: marca.input, imp: imp };
      f.nodo = h("div.rec-cobro-item", marca, h("div.rec-cobro-importe", h("span.rec-cobro-debe", "Hasta " + pesos(l.disponible)), imp),
        h("p.texto-3.chico.contable-efecto", EFECTO[l.rubro] || ""));
      return f;
    });
    var total = h("strong", pesos(0));
    function importeDe(f) { return P.importeDe(f.imp.value); }
    function valido(f) { var n = importeDe(f); return n > 0 && n <= Number(f.l.disponible) + 0.001; }
    function actualizar() {
      var suma = 0;
      filas.forEach(function (f) {
        f.imp.disabled = !f.marca.checked;
        f.nodo.classList.toggle("elegido", f.marca.checked);
        f.imp.classList.toggle("invalido", f.marca.checked && !valido(f));
        if (f.marca.checked && valido(f)) suma += importeDe(f);
      });
      total.textContent = pesos(P.redondear(suma));
    }
    actualizar();
    var devolucion = campoDevolucion(c.medio);
    var motivo = R.input("");
    motivo.maxLength = 200;
    motivo.placeholder = "Ej.: se cobraron dos días y estuvo uno";
    var m = P.modal({
      titulo: "Nota de crédito sobre " + c.codigo,
      subtitulo: [c.cliente && c.cliente.nombre, c.estadia && c.estadia.reserva_id ? "Reserva T-" + c.estadia.reserva_id : null].filter(Boolean).join(" · "),
      contenido: h("div.columna",
        h("p.texto-3.chico.rec-cobro-ayuda", "Marcá lo que se devuelve y cuánto. Para devolver todo y dejar el recibo sin efecto, usá «Anular recibo»."),
        h("div.rec-cobro-lista", filas.map(function (f) { return f.nodo; })),
        h("div.rec-resumen.rec-cobro-total", h("span", "Total a devolver"), total),
        devolucion.nodos,
        P.campo("Motivo", motivo, { ayuda: "Queda en el comprobante y en el historial." })),
      acciones: [R.btn("Volver", function () { m.cerrar(); }), R.btn("Emitir nota de crédito", function () {
        var elegidas = filas.filter(function (f) { return f.marca.checked; });
        if (!elegidas.length) throw Error("Marcá al menos un renglón para devolver.");
        elegidas.forEach(function (f) {
          if (!valido(f)) { f.imp.focus(); throw Error("Revisá el importe de " + f.l.texto + ": tiene que ser mayor que cero y no superar " + pesos(f.l.disponible) + "."); }
        });
        if (!motivo.value.trim()) { motivo.focus(); throw Error("Indicá el motivo de la nota de crédito."); }
        return P.post("/contable/comprobantes/" + c.id + "/nota-credito", Object.assign({
          operacion: key, motivo: motivo.value.trim(),
          renglones: elegidas.map(function (f) { return { movimiento_id: f.l.movimiento_id, importe: importeDe(f) }; })
        }, devolucion.datos())).then(function (x) {
          m.cerrar();
          if (x.encolado) return;
          emitido(x);
          return recargar();
        });
      }, "primario", { icono: "check" })]
    });
    return m;
  }

  function anular(c, recargar) {
    var key = R.nuevaClave(), nc = c.tipo === "NOTA_CREDITO";
    var motivo = R.input("");
    motivo.maxLength = 200;
    motivo.placeholder = nc ? "Ej.: la devolución no se hizo" : "Ej.: se emitió a otro titular";
    var devolucion = nc ? null : campoDevolucion(c.medio);
    var caja = R.sel([], null, "Elegí una caja"), campoCaja = P.campo("Caja que recibe el efectivo", caja);
    if (nc && c.medio === "EFECTIVO") selectorCaja(caja); else campoCaja.hidden = true;
    var explicacion = nc
      ? "Se registra el reintegro de " + pesos(c.total) + (c.medio === "EFECTIVO" ? " en la caja elegida" : "") + " y la cuenta de la estadía vuelve a como estaba antes de la devolución." +
        (c.origen ? " Si esta nota de crédito anuló el recibo " + c.origen.codigo + ", el recibo vuelve a estar vigente." : "")
      : "Se emite una nota de crédito por " + pesos(c.disponible) + (c.devuelto ? " (lo que queda después de las devoluciones anteriores)" : "") +
        " y el recibo queda anulado. Lo cobrado por alojamiento o artículos vuelve a quedar como deuda de la reserva: corregí la reserva y, si corresponde, cobrá de nuevo para emitir el recibo correcto.";
    var m = P.modal({
      titulo: (nc ? "Anular nota de crédito " : "Anular recibo ") + c.codigo,
      subtitulo: [c.cliente && c.cliente.nombre, pesos(c.total)].filter(Boolean).join(" · "),
      contenido: h("div.columna", P.mensaje(explicacion, "aviso"), devolucion ? devolucion.nodos : campoCaja,
        P.campo("Motivo", motivo, { ayuda: "Queda en el comprobante y en el historial." })),
      acciones: [R.btn("Volver", function () { m.cerrar(); }), R.btn(nc ? "Anular nota de crédito" : "Anular recibo", function () {
        if (!motivo.value.trim()) { motivo.focus(); throw Error("Indicá el motivo de la anulación."); }
        var datos = devolucion ? devolucion.datos() : {};
        if (!campoCaja.hidden) {
          if (!caja.value) { caja.focus(); throw Error("Elegí la caja que recibe el efectivo."); }
          datos.caja_id = caja.value;
        }
        return P.post("/contable/comprobantes/" + c.id + "/anular", Object.assign({ operacion: key, motivo: motivo.value.trim() }, datos)).then(function (x) {
          m.cerrar();
          if (x.encolado) return;
          if (x.comprobante) emitido(x, "Recibo anulado");
          else P.aviso(x.mensaje, "ok");
          return recargar();
        });
      }, "peligro", { icono: "cerrar" })]
    });
    return m;
  }

  // ------------------------------------------------------------------ listado

  P.ruta.registrar(/^\/contable$/, function (c) {
    c.appendChild(R.cabecera("Contable", {
      subtitulo: "Recibos y notas de crédito de la recepción. Son comprobantes internos de pago: no son facturas."
    }));
    var t = P.tabla({
      listado: "comprobantes",
      claveEstado: "contable-comprobantes",
      placeholderBuscar: "Buscar por número (R-25, NC-3), reserva (T-114), titular, DNI o empleado…",
      tituloVacio: "No hay comprobantes con esos filtros",
      textoVacio: "Cada cobro de la recepción en efectivo o transferencia emite un recibo, y cada devolución, una nota de crédito.",
      iconoVacio: "planilla",
      alClickFila: function (f) { ir("/contable/" + f.id); },
      celdas: {
        numero: function (_v, f) { return h("strong.rec-codigo", codigoDe(f)); },
        reserva_id: function (v) { return v ? h("a.rec-codigo.rec-enlace", { href: "#/recepcion/" + v, title: "Abrir la reserva T-" + v }, "T-" + v) : "—"; },
        estado: function (_v, f) { return chipEstado(f); },
        origen_numero: function (v) { return v ? "R-" + ("00000000" + v).slice(-8) : "—"; }
      }
    });
    c.appendChild(t.el);
  }, { admin: true, titulo: "Contable" });

  // ------------------------------------------------------------------ detalle

  function textoHistorial(e) {
    var d = e.detalle || {}, partes = [];
    if (d.total != null && e.accion !== "Recibo anulado") partes.push(pesos(d.total));
    if (d.nota_credito) partes.push((e.accion === "Recibo anulado" ? "con " : "") + d.nota_credito + (d.devuelto ? " por " + pesos(d.devuelto) : ""));
    if (d.corrige) partes.push("corrige " + d.corrige);
    if (d.nota_credito_anulada) partes.push("se anuló " + d.nota_credito_anulada);
    if (d.reintegrado) partes.push("reintegro de " + pesos(d.reintegrado));
    if (d.medio) partes.push(MEDIOS[d.medio] || d.medio);
    if (d.motivo) partes.push("Motivo: " + d.motivo);
    return partes.join(" · ");
  }

  P.ruta.registrar(/^\/contable\/(\d+)$/, function (raiz, p) {
    var zona = h("div.columna.contable-detalle");
    raiz.appendChild(zona);
    function cargar() {
      return P.get("/contable/comprobantes/" + p[0]).then(function (c) {
        var nc = c.tipo === "NOTA_CREDITO", es = c.estadia || {}, cl = c.cliente || {};
        var acciones = [
          R.btn("Imprimir", function () { return P.imprimirComprobante(c, { reimpresion: true }); }, "secundario", { icono: "imprimir" }),
          es.reserva_id ? R.btn("Ver reserva", function () { ir("/recepcion/" + es.reserva_id); }, "secundario", { icono: "usuarios" }) : null,
          c.puede_nota_credito ? R.btn("Nota de crédito", function () { notaCredito(c, cargar); }, "secundario", { icono: "transferencia" }) : null,
          c.puede_anular ? R.btn(nc ? "Anular nota de crédito" : "Anular recibo", function () { anular(c, cargar); }, "peligro", { icono: "cerrar" }) : null
        ];
        var avisos = [];
        if (c.anulacion) {
          avisos.push(P.mensaje(h("div", h("strong", (nc ? "Anulada" : "Anulado") + " el " + P.f.fechaHora(c.anulacion.fecha) + (c.anulacion.por ? " por " + c.anulacion.por : "") + ". "),
            c.anulacion.motivo ? "Motivo: " + c.anulacion.motivo + ". " : "",
            c.anulacion.nota_credito ? ["La devolución quedó en ", h("a.rec-enlace", { href: "#/contable/" + c.anulacion.nota_credito.id }, c.anulacion.nota_credito.codigo), " por " + pesos(c.anulacion.nota_credito.total) + "."] : null), "error"));
        }
        if (nc && c.origen) {
          avisos.push(P.mensaje(h("div", "Corrige al recibo ", h("a.rec-enlace", { href: "#/contable/" + c.origen.id }, c.origen.codigo),
            " del " + P.f.fecha(c.origen.fecha) + " por " + pesos(c.origen.total) + (c.origen_actual && c.origen_actual.estado === "ANULADO" ? " (anulado)." : ".")), "info"));
        } else if (nc) {
          avisos.push(P.mensaje("Devolución registrada desde la cuenta de la estadía (no corrige un recibo en particular).", "info"));
        }
        if (!nc && c.devuelto > 0 && c.estado === "EMITIDO") {
          avisos.push(P.mensaje("Se devolvieron " + pesos(c.devuelto) + " con notas de crédito. Queda vigente " + pesos(c.disponible) + ".", "aviso"));
        }
        if (!c.puede_anular && nc && c.estado === "EMITIDO") {
          avisos.push(P.mensaje("Esta devolución se hizo al liquidar la estadía o una salida: no se anula. Si corresponde volver a cobrar, registralo como un cobro nuevo en la reserva.", "info"));
        }
        var columnas = nc ? ["Concepto", "Detalle", "Importe"] : ["Concepto", "Detalle", "Importe", "Devuelto", "Queda"];
        var renglones = R.tabla(columnas, (c.renglones || []).map(function (l) {
          var detalle = l.articulo ? [l.articulo.modalidad === "VENTA" ? "Compra" : "Alquiler", R.detalleArticulo(l.articulo), l.articulo.fecha_desde ? R.periodo(l.articulo) : null].filter(Boolean).join(" · ") : l.detalle;
          var fila = [h("strong", l.texto), R.texto(detalle), pesos(l.importe)];
          if (!nc) fila.push(l.devuelto ? pesos(l.devuelto) : "—", pesos(l.disponible));
          return fila;
        }), ".contable-renglones");
        var saldo = c.saldo ? Number(c.saldo.total) : null;
        var notas = (c.notas_credito || []);
        P.reemplazar(zona, h("div.columna",
          R.cabecera(c.nombre + " " + c.codigo, { volver: ["Contable", "/contable"], acciones: acciones }),
          avisos.length ? h("div.columna", avisos) : null,
          h("section.hoja.rec-seccion",
            h("div.rec-seccion-cabecera", h("h2", "Datos del comprobante"), chipEstado(c)),
            h("div.datos.rec-datos",
              P.dato("Fecha", P.f.fechaHora(c.fecha)), P.dato("Importe", importeConSigno(c)), P.dato(nc ? "Se devolvió en" : "Forma de pago", MEDIOS[c.medio] || c.medio),
              P.dato("Concepto", OPERACIONES[c.operacion] || "—"), P.dato("Emitió", c.usuario_nombre),
              P.dato("Saldo de la estadía al emitir", saldo == null ? null : Math.abs(saldo) < 0.005 ? "Saldada" : saldo > 0 ? pesos(saldo) + " por cobrar" : pesos(-saldo) + " a favor"),
              c.motivo ? P.dato("Motivo", c.motivo) : null, c.observacion ? P.dato("Observación", c.observacion) : null)),
          h("section.hoja.rec-seccion",
            h("div.rec-seccion-cabecera", h("h2", "Titular y estadía")),
            h("div.datos.rec-datos",
              P.dato("Titular", cl.nombre), P.dato("DNI", P.documento(cl.dni)), P.dato("Legajo", cl.legajo), P.dato(cl.afiliado ? "Departamental" : "Localidad", cl.departamental),
              P.dato("Reserva", es.reserva_id ? h("a.rec-codigo.rec-enlace", { href: "#/recepcion/" + es.reserva_id }, "T-" + es.reserva_id) : null),
              P.dato("Estadía", [es.servicio, R.recursoYParcela(es.recurso, es.numero_parcela), es.ubicacion].filter(Boolean).join(" · ")),
              P.dato("Fechas", es.fecha_inicio ? P.f.fecha(es.fecha_inicio) + " al " + P.f.fecha(es.fecha_fin) : null),
              P.dato("Vehículos", (es.vehiculos || []).map(function (v) { return v.patente + (v.sector ? " (sector " + v.sector + ")" : ""); }).join(", ")))),
          h("section.hoja.rec-seccion",
            h("div.rec-seccion-cabecera", h("h2", nc ? "Lo que se devolvió" : "Lo que se cobró")),
            renglones,
            h("div.rec-resumen.contable-total", h("span", nc ? "Total devuelto" : "Total recibido"), h("strong", pesos(c.total)))),
          notas.length ? h("section.hoja.rec-seccion",
            h("div.rec-seccion-cabecera", h("h2", "Notas de crédito de este recibo")),
            R.tabla(["Nota de crédito", "Fecha", "Importe", "Medio", "Motivo", "Estado"], notas.map(function (n) {
              return [h("a.rec-codigo.rec-enlace", { href: "#/contable/" + n.id }, n.codigo), P.f.fechaHora(n.fecha), pesos(n.total), MEDIOS[n.medio] || n.medio || "—", R.texto(n.motivo), chipEstado(n)];
            }))) : null,
          (c.caja || []).length ? h("section.hoja.rec-seccion",
            h("div.rec-seccion-cabecera", h("h2", "Movimientos de caja")),
            R.tabla(["Fecha", "Caja", "Movimiento", "Importe"], c.caja.map(function (m) {
              return [P.f.fechaHora(m.fecha), [m.boca, m.caja].filter(Boolean).join(" · "), m.tipo === "INGRESO" ? "Ingreso" : "Egreso", pesos(m.importe)];
            }))) : null,
          h("section.hoja.rec-seccion",
            h("div.rec-seccion-cabecera", h("h2", "Historial")),
            h("ol.contable-historial", (c.historial || []).map(function (e) {
              return h("li", h("div.contable-historial-cabeza", h("strong", ACCIONES_HISTORIAL[e.accion] || e.accion), h("span.texto-3", P.f.fechaHora(e.fecha) + (e.usuario_nombre ? " · " + e.usuario_nombre : "") + (e.origen === "REMOTO" ? " · desde Mi AJB" : ""))),
                textoHistorial(e) ? h("p.texto-2", textoHistorial(e)) : null);
            })))));
      }).catch(function (e) { P.reemplazar(zona, P.mensaje(e.message, "error")); });
    }
    return cargar();
  }, { admin: true, titulo: "Comprobante" });
})();
