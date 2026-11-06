/* Caja: saldo de apertura (lo carga el administrador y lo confirma el cajero), ajustes,
   cierre de caja y movimientos. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  var CONCEPTOS_AJUSTE = [
    { valor: "CIERRE_CAJA", texto: "Cierre de caja (retiro de la recaudación)", tipo: "EGRESO" },
    { valor: "INGRESO_DINERO", texto: "Ingreso de dinero (cambio, refuerzo)", tipo: "INGRESO" },
    { valor: "RETIRO_DINERO", texto: "Retiro de dinero", tipo: "EGRESO" },
    { valor: "OTROS", texto: "Otros", tipo: "INGRESO" },
  ];

  // ------------------------------------------------------------------ saldo de apertura (cajero)
  P.verificarApertura = function (forzar) {
    var puesto = P.puesto();
    if (!puesto || !puesto.caja_id) return Promise.resolve();
    return P.get("/caja/estado").then(function (r) {
      var a = r.apertura;
      if (!a) {
        if (forzar) P.modal({ titulo: "Saldo de apertura", contenido: P.mensaje("El administrador todavía no cargó el saldo de apertura de hoy para " + puesto.caja + ". Podés empezar a vender igual.", "aviso") });
        return;
      }
      if (a.verificacion !== "PENDIENTE" && !forzar) return;
      var importe = h("div.total", h("span", "Saldo de apertura"), h("strong", P.f.pesos(a.importe)));
      if (a.verificacion !== "PENDIENTE") {
        P.modal({ titulo: "Saldo de apertura de hoy", subtitulo: puesto.boca + " · " + puesto.caja, contenido: h("div.columna", importe,
          a.verificacion === "CORRECTO" ? P.mensaje("Confirmado por " + (a.verificado_por || "") + " " + P.f.relativo(a.verificado_fecha) + ".", "ok")
            : P.mensaje("Se informó que no coincide. Comunicate con el administrador.", "error")) });
        return;
      }
      var encontrado = P.dinero({ placeholder: "¿Cuánto encontraste? (opcional)" });
      var nota = P.input({ placeholder: "Comentario (opcional)", max: 200 });
      var zonaNo = h("div.columna", { hidden: true }, P.campo("Efectivo que hay en la caja", h("div.campo-con-prefijo", h("span", "$"), encontrado)), P.campo("Comentario", nota),
        P.mensaje("Comunicate con el administrador antes de empezar a cobrar. Queda registrado que el saldo no coincide.", "aviso"));
      var m = P.modal({
        titulo: "Saldo de apertura de la caja",
        subtitulo: "Contá el efectivo de " + puesto.caja + " y confirmá si coincide con lo que cargó el administrador.",
        modalFijo: true,
        contenido: h("div.columna", importe, zonaNo),
        acciones: [
          P.btn("No coincide", { tipo: "peligro", onclick: function (ev) {
            if (zonaNo.hidden) { zonaNo.hidden = false; encontrado.focus(); return; }
            P.ejecutar(ev.currentTarget, function () {
              return P.post("/caja/apertura/" + a.id + "/verificar", { correcto: false, efectivo_encontrado: encontrado.value ? P.numeroDe(encontrado.value) : null, observacion: nota.value }).then(function (x) {
                m.cerrar();
                P.modal({ titulo: "Comunicate con el administrador", contenido: P.mensaje(x.mensaje, "error") });
              });
            });
          } }),
          P.btn("Sí, es correcto", { tipo: "ok", icono: "check", onclick: function (ev) {
            P.ejecutar(ev.currentTarget, function () {
              return P.post("/caja/apertura/" + a.id + "/verificar", { correcto: true }).then(function (x) { m.cerrar(); P.aviso(x.mensaje, "ok"); });
            });
          } }),
        ],
      });
    }).catch(P.error);
  };

  // ------------------------------------------------------------------ cierre de caja
  P.cerrarCaja = function (cajaId, alTerminar) {
    return P.get("/caja/cierre/previa" + P.qs({ caja_id: cajaId })).then(function (r) {
      var s = r.resumen;
      var contado = P.dinero({ placeholder: "Contá el efectivo" });
      var queda = P.dinero({ valor: "0", placeholder: "0" });
      var obs = P.input({ max: 250, placeholder: "Opcional" });
      var diferencia = h("div");
      function calcular() {
        var c = P.numeroDe(contado.value);
        P.vaciar(diferencia);
        if (isNaN(c)) return;
        var d = P.redondear(c - s.saldo_esperado);
        diferencia.className = "vuelto" + (d < 0 ? " falta" : "");
        diferencia.appendChild(h("span", d === 0 ? "Sin diferencia" : d > 0 ? "Sobrante" : "Faltante"));
        diferencia.appendChild(h("strong", P.f.pesos(Math.abs(d))));
      }
      contado.addEventListener("input", calcular);
      var m = P.modal({
        titulo: "Cerrar caja · " + r.caja.nombre,
        subtitulo: s.ultimo_cierre ? "Desde el cierre N° " + s.ultimo_cierre.id + " (" + P.f.fechaHora(s.ultimo_cierre.fecha) + ")" : "Primer cierre de esta caja",
        ancho: "ancha",
        contenido: h("div.grilla.grilla-2",
          h("div.resumen-cuentas",
            h("div", h("span", "Saldo inicial"), h("strong.dinero", P.f.pesos(s.saldo_inicial))),
            h("div", h("span", "Ingresos (ventas en efectivo y otros)"), h("strong.dinero", P.f.pesos(s.ingresos))),
            h("div", h("span", "Egresos"), h("strong.dinero", "− " + P.f.pesos(s.egresos))),
            h("div.fuerte", h("span", "Efectivo esperado"), h("span.dinero", P.f.pesos(s.saldo_esperado))),
            h("hr", { style: { border: 0, borderTop: "1px solid var(--borde)", width: "100%" } }),
            h("div", h("span", "Ventas"), h("strong", s.ventas_cantidad + " · " + P.f.pesos(s.ventas_total))),
            s.ventas_por_forma.map(function (v) { return h("div.texto-3.chico", h("span", (P.FORMAS[v.forma_pago] || v.forma_pago) + " (" + v.cantidad + ")"), h("span.dinero", P.f.pesos(v.total))); }),
            s.ventas_anuladas ? h("div.texto-3.chico", h("span", "Ventas anuladas"), h("span", String(s.ventas_anuladas))) : null),
          h("div.columna",
            P.campo("Efectivo contado", h("div.campo-con-prefijo.campo-grande", h("span", "$"), contado), { requerido: true }),
            diferencia,
            P.campo("Queda en la caja para mañana (cambio)", h("div.campo-con-prefijo", h("span", "$"), queda), { ayuda: "Lo demás se registra como retiro de la recaudación." }),
            P.campo("Observaciones", obs))),
        acciones: [
          P.btn("Cancelar", { onclick: function () { m.cerrar(); } }),
          P.btn("Cerrar caja e imprimir", { tipo: "primario", icono: "imprimir", onclick: function (ev) {
            var c = P.numeroDe(contado.value);
            if (isNaN(c)) { contado.classList.add("invalido"); contado.focus(); return; }
            P.ejecutar(ev.currentTarget, function () {
              return P.post("/caja/cierre", { caja_id: cajaId || undefined, efectivo_contado: c, queda_en_caja: P.numeroDe(queda.value) || 0, observaciones: obs.value }).then(function (x) {
                m.cerrar();
                P.aviso(x.mensaje, x.diferencia === 0 ? "ok" : "error", 8000);
                if (x.id) P.get("/caja/cierres/" + x.id).then(P.imprimirCierre).catch(P.error);
                if (alTerminar) alTerminar(x);
              });
            });
          } }),
        ],
      });
    }).catch(P.error);
  };

  // ------------------------------------------------------------------ caja del cajero
  P.ruta.registrar(/^\/mi-caja$/, function (c) {
    var puesto = P.puesto();
    if (!puesto || !puesto.caja_id) { c.appendChild(P.vacio("caja", "No estás trabajando en una caja", "", P.btn("Elegir caja", { tipo: "primario", onclick: function () { P.ruta.ir("/puesto"); } }))); return; }
    c.appendChild(h("div.pagina-cabecera",
      h("div", h("h1.titulo-pagina", "Caja"), h("p.subtitulo", puesto.boca + " · " + puesto.caja)),
      h("div.pagina-acciones",
        P.btn("Ver saldo de apertura", { tipo: "secundario", icono: "efectivo", onclick: function () { P.verificarApertura(true); } }),
        P.btn("Cerrar caja", { tipo: "primario", icono: "candado", onclick: function () { P.cerrarCaja(null, function () { cargar(); tabla.recargar(); }); } }))));
    var cifras = h("div.grilla.grilla-4");
    c.appendChild(cifras);
    var tabla = P.tabla({ listado: "caja", columnasOcultas: ["boca", "caja"], filtrosOcultos: ["boca", "caja"], claveEstado: "mi-caja" });
    c.appendChild(h("div", { style: { marginTop: "16px" } }, tabla.el));
    function cargar() {
      return P.get("/caja/estado").then(function (r) {
        var a = r.apertura;
        P.reemplazar(cifras,
          P.cifra("Efectivo en la caja", P.f.pesos(r.resumen.saldo_esperado), "Según los movimientos"),
          P.cifra("Ventas desde el último cierre", P.f.entero(r.resumen.ventas_cantidad), P.f.pesos(r.resumen.ventas_total)),
          P.cifra("Tu turno", r.turno ? P.f.pesos(r.turno.total) : "—", r.turno ? r.turno.cantidad + " venta(s)" : ""),
          P.cifra("Saldo de apertura", a ? P.f.pesos(a.importe) : "Sin cargar",
            a ? (a.verificacion === "CORRECTO" ? "Confirmado" : a.verificacion === "NO_COINCIDE" ? "No coincide: avisá al administrador" : h("a", { href: "#", onclick: function (ev) { ev.preventDefault(); P.verificarApertura(true); } }, "Confirmalo")) : "Lo carga el administrador"));
      });
    }
    return cargar();
  }, { titulo: "Caja", local: true });

  // ------------------------------------------------------------------ caja del administrador
  function modalApertura(cajas, cajaId, alTerminar) {
    var caja = P.select(cajas, cajaId);
    var fecha = P.input({ tipo: "date", valor: P.hoy() });
    var importe = P.dinero({});
    var obs = P.input({ max: 200, placeholder: "Opcional" });
    var m = P.modal({
      titulo: "Saldo de apertura",
      subtitulo: "El efectivo con el que arranca la caja. El cajero lo va a ver y confirmar.",
      contenido: h("div.columna", P.campo("Caja", caja), P.campo("Día", fecha), P.campo("Importe", h("div.campo-con-prefijo.campo-grande", h("span", "$"), importe), { requerido: true }), P.campo("Observación", obs)),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", onclick: function (ev) {
        P.ejecutar(ev.currentTarget, function () {
          return P.post("/caja/apertura", { caja_id: caja.value, fecha: fecha.value, importe: P.numeroDe(importe.value), observacion: obs.value }).then(function (r) {
            if (!r.encolado) P.aviso(r.mensaje, "ok");
            m.cerrar(); if (alTerminar) alTerminar();
          });
        });
      } })],
    });
    setTimeout(function () { importe.focus(); }, 60);
  }

  function modalAjuste(cajas, cajaId, alTerminar) {
    var caja = P.select(cajas, cajaId);
    var concepto = P.select(CONCEPTOS_AJUSTE, "CIERRE_CAJA");
    var tipo = P.segmentado([{ valor: "INGRESO", texto: "Ingreso" }, { valor: "EGRESO", texto: "Egreso" }], "EGRESO");
    concepto.addEventListener("change", function () { tipo.fijar(CONCEPTOS_AJUSTE.filter(function (x) { return x.valor === concepto.value; })[0].tipo); });
    var importe = P.dinero({});
    var recibo = P.input({ max: 40, placeholder: "N° de recibo (opcional)" });
    var obs = P.input({ max: 250, placeholder: "Opcional" });
    var m = P.modal({
      titulo: "Ajuste de caja",
      subtitulo: "Para dejar asentado cuando ponés o sacás dinero de una caja.",
      contenido: h("div.columna", P.campo("Caja", caja), P.campo("Concepto", concepto), P.campo("Tipo", tipo),
        P.campo("Importe", h("div.campo-con-prefijo.campo-grande", h("span", "$"), importe), { requerido: true }),
        h("div.grilla.grilla-2", P.campo("Recibo", recibo), P.campo("Observaciones", obs))),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Registrar", { tipo: "primario", onclick: function (ev) {
        var cuerpo = { caja_id: caja.value, concepto: concepto.value, tipo: tipo.valor(), importe: P.numeroDe(importe.value), recibo: recibo.value, observaciones: obs.value };
        P.ejecutar(ev.currentTarget, function () {
          return P.post("/caja/ajuste", cuerpo).catch(function (e) {
            if (e.codigo !== "SALDO_NEGATIVO") throw e;
            return P.confirmar(e.message + ". ¿Registrarlo igual?", { aceptar: "Registrar igual" }).then(function (ok) {
              if (!ok) throw P.ErrorApi("Cancelado", -1);
              return P.post("/caja/ajuste", Object.assign(cuerpo, { confirmar_saldo_negativo: true }));
            });
          }).then(function (r) {
            if (!r.encolado) P.aviso(r.mensaje + (r.saldo !== undefined ? ". Saldo: " + P.f.pesos(r.saldo) : ""), "ok");
            m.cerrar(); if (alTerminar) alTerminar();
          });
        }).catch(function () {});
      } })],
    });
    setTimeout(function () { importe.focus(); }, 60);
  }

  P.verCierre = function (id) {
    P.get("/caja/cierres/" + id).then(function (d) {
      var ci = d.cierre;
      P.modal({
        titulo: "Cierre N° " + ci.id, subtitulo: ci.boca + " · " + ci.caja + " · " + P.f.fechaHora(ci.fecha) + " · " + ci.usuario_nombre,
        contenido: h("div.resumen-cuentas",
          h("div", h("span", "Saldo inicial"), h("strong", P.f.pesos(ci.saldo_inicial))),
          h("div", h("span", "Ingresos"), h("strong", P.f.pesos(ci.ingresos))),
          h("div", h("span", "Egresos"), h("strong", P.f.pesos(ci.egresos))),
          h("div.fuerte", h("span", "Efectivo esperado"), h("span", P.f.pesos(ci.saldo_esperado))),
          h("div", h("span", "Contado"), h("strong", P.f.pesos(ci.efectivo_contado))),
          h("div", h("span", "Diferencia"), h("strong" + (Number(ci.diferencia) < 0 ? ".negativo" : ""), P.f.pesos(ci.diferencia))),
          h("div", h("span", "Retiro"), h("strong", P.f.pesos(ci.retiro))),
          h("div", h("span", "Queda en caja"), h("strong", P.f.pesos(ci.queda_en_caja))),
          h("div", h("span", "Ventas"), h("strong", ci.ventas_cantidad + " · " + P.f.pesos(ci.ventas_total))),
          d.ventas_por_forma.map(function (v) { return h("div.texto-3.chico", h("span", (P.FORMAS[v.forma_pago] || v.forma_pago) + " (" + v.cantidad + ")"), h("span", P.f.pesos(v.total))); }),
          ci.observaciones ? h("div.texto-3", ci.observaciones) : null),
        acciones: [P.btn("Imprimir", { tipo: "primario", icono: "imprimir", onclick: function () { P.imprimirCierre(d).catch(P.error); } })],
      });
    }).catch(P.error);
  };

  P.ruta.registrar(/^\/caja$/, function (c) {
    var cajasOp = [];
    var vista = P.cache["caja:vista"] || "movimientos";
    c.appendChild(h("div.pagina-cabecera",
      h("div", h("h1.titulo-pagina", "Caja"), h("p.subtitulo", "Todas las cajas de todas las bocas: aperturas, ajustes, cierres y movimientos.")),
      h("div.pagina-acciones",
        P.btn("Saldo de apertura", { tipo: "secundario", icono: "efectivo", onclick: function () { modalApertura(cajasOp, null, refrescar); } }),
        P.btn("Ajuste de caja", { tipo: "primario", icono: "transferencia", onclick: function () { modalAjuste(cajasOp, null, refrescar); } }))));
    var tarjetas = h("div.grilla", { style: { gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" } }, P.cargando());
    c.appendChild(tarjetas);
    var zonaTabla = h("div", { style: { marginTop: "18px" } });
    var selector = P.segmentado([{ valor: "movimientos", texto: "Movimientos de caja" }, { valor: "cierres", texto: "Cierres de caja" }], vista, function (v) { vista = v; P.cache["caja:vista"] = v; pintarTabla(); });
    c.appendChild(h("div", { style: { marginTop: "22px" } }, selector));
    c.appendChild(zonaTabla);
    var tabla = null;
    function pintarTabla() {
      tabla = vista === "movimientos"
        ? P.tabla({ listado: "caja", alClickFila: function (f) { if (f.cierre_id) P.verCierre(f.cierre_id); } })
        : P.tabla({ listado: "cierres", alClickFila: function (f) { P.verCierre(f.id); } });
      P.reemplazar(zonaTabla, tabla.el);
    }
    function cargarTarjetas() {
      return Promise.all([P.get("/caja/panel"), P.opciones("cajas", true)]).then(function (r) {
        cajasOp = r[1];
        if (!r[0].cajas.length) { P.reemplazar(tarjetas, P.vacio("caja", "No hay cajas", "Creá las cajas de cada boca en Gestión > Bocas y cajas.")); return; }
        P.reemplazar(tarjetas, r[0].cajas.map(function (cj) {
          var ap = cj.apertura;
          return h("div.hoja.hoja-cuerpo",
            h("div.fila-separada", h("div", h("strong", cj.boca), h("div.texto-3.chico", cj.nombre)),
              !ap ? P.chip("Sin apertura", "VENCIDO") : ap.verificacion === "CORRECTO" ? P.chip("Apertura OK", "CORRECTO") : ap.verificacion === "NO_COINCIDE" ? P.chip("No coincide", "NO_COINCIDE") : P.chip("Sin confirmar", "PENDIENTE")),
            h("div.cifra-valor", { style: { fontSize: "24px" } }, P.f.pesos(cj.saldo)),
            h("div.texto-3.chico", cj.ventas_cantidad + " venta(s) · " + P.f.pesos(cj.ventas_total) + " desde el último cierre"),
            h("div.texto-3.chico", cj.turno ? "Atiende " + cj.turno.usuario_nombre + " desde " + P.f.hora(cj.turno.inicio) : "Sin turno abierto"),
            h("div.fila", { style: { marginTop: "12px", gap: "6px" } },
              P.btn("Apertura", { tipo: "suave", chico: true, onclick: function () { modalApertura(cajasOp, cj.id, refrescar); } }),
              P.btn("Ajuste", { tipo: "suave", chico: true, onclick: function () { modalAjuste(cajasOp, cj.id, refrescar); } }),
              P.modo === "local" ? P.btn("Cerrar", { tipo: "suave", chico: true, onclick: function () { P.cerrarCaja(cj.id, refrescar); } }) : null));
        }));
      });
    }
    function refrescar() { cargarTarjetas().catch(P.error); if (tabla) tabla.recargar(); }
    pintarTabla();
    P.intervalo(function () { cargarTarjetas().catch(function () {}); }, 20000);
    return cargarTarjetas();
  }, { admin: true, titulo: "Caja" });
})();
