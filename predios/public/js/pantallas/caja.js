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
        if (forzar) P.modal({ titulo: "Saldo de apertura", contenido: P.mensaje("El administrador todavía no cargó el saldo de apertura de esta jornada para " + puesto.caja + ". Podés empezar a vender igual.", "aviso") });
        return;
      }
      if (a.verificacion !== "PENDIENTE" && !forzar) return;
      var importe = h("div.total", h("span", "Saldo de apertura"), h("strong", P.f.pesos(a.importe)));
      if (a.verificacion !== "PENDIENTE") {
        P.modal({ titulo: "Saldo de apertura · " + P.f.fecha(a.fecha), subtitulo: puesto.boca + " · " + puesto.caja, contenido: h("div.columna", importe,
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
  function mostrarClave(cajaId, nombre, boton) {
    return P.ejecutar(boton, function () {
      return P.get("/caja/cierre/previa" + P.qs({ caja_id: cajaId })).then(function (p) {
        return P.post("/caja/cierre/clave", { caja_id: cajaId, turno_id: p.turno ? p.turno.id : null, ultimo_cierre_id: p.resumen.ultimo_cierre ? p.resumen.ultimo_cierre.id : null });
      }).then(function (r) {
        if (r.encolado) { P.aviso("Cuando el predio esté conectado, volvé a generar la clave.", "info"); return; }
        P.modal({ titulo: "Clave de cierre · " + nombre, contenido: h("div.columna",
          h("strong.cifra-valor", r.clave), h("p", "Ingresá esta clave al confirmar el cierre. Vence a las " + P.f.hora(r.vence) + ".")) });
      });
    });
  }

  P.cerrarCaja = function (cajaId, alTerminar) {
    return P.get("/caja/cierre/previa" + P.qs({ caja_id: cajaId })).then(function (r) {
      var s = r.resumen;
      var contado = P.dinero({ placeholder: "Contá el efectivo" });
      var queda = P.dinero({ valor: "0", placeholder: "0" });
      var obs = P.input({ max: 250, placeholder: "Opcional" });
      var requiereClave = P.esAdmin() || !P.estado.sesion.usuario.puede_cerrar_caja;
      var clave = requiereClave ? P.inputClave({ inputmode: "numeric", max: 8, autocomplete: "one-time-code" }) : null;
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
            P.campo("Queda en caja para el próximo turno", h("div.campo-con-prefijo", h("span", "$"), queda), { ayuda: "Lo demás se registra como retiro de la recaudación." }),
            P.campo("Observaciones", obs),
            clave ? P.campo("Clave temporal del administrador", clave, { requerido: true, ayuda: "El administrador puede generarla en Caja para este cierre." }) : null,
            clave && P.esAdmin() ? P.btn("Generar clave de cierre", { tipo: "suave", onclick: function (ev) { mostrarClave(r.caja.id, r.caja.nombre, ev.currentTarget); } }) : null)),
        acciones: [
          P.btn("Cancelar", { onclick: function () { m.cerrar(); } }),
          P.btn("Cerrar caja e imprimir", { tipo: "primario", icono: "imprimir", onclick: function (ev) {
            var c = P.numeroDe(contado.value);
            if (isNaN(c)) { contado.classList.add("invalido"); contado.focus(); return; }
            if (clave && !/^\d{8}$/.test(clave.input.value.trim())) { P.aviso("Ingresá los ocho dígitos de la clave de cierre.", "error"); clave.input.focus(); return; }
            P.ejecutar(ev.currentTarget, function () {
              return P.post("/caja/cierre", { caja_id: r.caja.id, efectivo_contado: c, queda_en_caja: P.numeroDe(queda.value) || 0,
                revision: r.revision, turno_id: r.turno ? r.turno.id : null, ultimo_cierre_id: s.ultimo_cierre ? s.ultimo_cierre.id : null,
                observaciones: obs.value, clave: clave ? clave.input.value.trim() : undefined }).then(function (x) {
                m.cerrar();
                if (x.encolado) return;
                P.aviso(x.mensaje, x.diferencia === 0 ? "ok" : "error", 8000);
                if (x.id) P.get("/caja/cierres/" + x.id).then(P.imprimirCierre).catch(P.error);
                if (P.puesto() && Number(P.puesto().caja_id) === Number(r.caja.id)) {
                  P.estado.sesion.puesto = null;
                  P.repintarMarco();
                  P.ruta.ir(P.esAdmin() ? "/caja" : "/puesto");
                }
                if (alTerminar) alTerminar(x);
              });
            });
          } }),
        ],
      });
    }).catch(P.error);
  };

  // El mismo detalle se abre desde el puesto o desde el panel, sin cambiar de turno.
  function detalleCaja(c, cajaId, desdePanel) {
    var rutaEstado = "/caja/estado" + P.qs({ caja_id: cajaId });
    var cifras = h("div.grilla.grilla-4");
    var tabla;
    function refrescar() {
      P.get(rutaEstado).then(mostrarCifras).catch(P.error);
      tabla.recargar();
    }
    function mostrarCifras(r) {
      var a = r.apertura;
      P.reemplazar(cifras,
        P.cifra("Efectivo en la caja", P.f.pesos(r.resumen.saldo_esperado)),
        P.cifra("Ventas desde el último cierre", P.f.entero(r.resumen.ventas_cantidad)),
        desdePanel ? P.cifra("Ventas en efectivo", P.f.pesos(r.resumen.ventas_efectivo)) :
          P.cifra("Tu turno", r.turno ? P.f.pesos(r.turno.total) : "—"),
        P.cifra("Saldo de apertura", a ? P.f.pesos(a.importe) : "Sin cargar"));
    }
    c.appendChild(h("a.volver", { href: desdePanel ? "#/caja" : "#/vender" }, P.icono("volver"), desdePanel ? "Todas las cajas" : "Vender"));
    return P.get(rutaEstado).then(function (r) {
      var nombre = r.boca.nombre + " · " + r.caja.nombre;
      var esPropia = P.puesto() && Number(P.puesto().caja_id) === Number(cajaId);
      var caja = [{ valor: cajaId, texto: nombre }];
      var acciones = [P.btn("Mis ventas", { tipo: "suave", chico: true, icono: "lista", onclick: function () { P.ruta.ir(desdePanel ? "/caja/" + cajaId + "/ventas" : "/mis-ventas"); } })];
      if (desdePanel) {
        acciones.push(
          P.btn("Saldo de apertura", { tipo: "suave", chico: true, icono: "efectivo", onclick: function () { modalApertura(caja, cajaId, refrescar); } }),
          P.btn("Ajuste de caja", { tipo: "suave", chico: true, icono: "transferencia", onclick: function () { modalAjuste(caja, cajaId, refrescar); } }));
      } else {
        acciones.push(P.btn("Ver saldo de apertura", { tipo: "suave", chico: true, icono: "efectivo", onclick: function () { P.verificarApertura(true); } }));
      }
      if (desdePanel) acciones.push(P.btn("Generar clave de cierre", { tipo: "suave", chico: true, icono: "llave", onclick: function (ev) { mostrarClave(cajaId, nombre, ev.currentTarget); } }));
      acciones.push(P.btn("Cerrar caja", { tipo: "primario", icono: "candado", onclick: function () { P.cerrarCaja(cajaId, refrescar); } }));
      c.appendChild(P.cabeceraConAcciones(esPropia ? "Mi caja" : "Caja", esPropia ? null : nombre, acciones));
      mostrarCifras(r);
      c.appendChild(cifras);
      tabla = P.tabla({ listado: "caja", sinEtiquetaBuscar: true, filtrosFijos: { f_caja: cajaId }, columnasOcultas: ["boca", "caja"],
        filtrosOcultos: ["boca", "caja"], claveEstado: "detalle-caja-" + cajaId, alClickFila: function (f) { if (f.cierre_id) P.verCierre(f.cierre_id); } });
      c.appendChild(h("div", { style: { marginTop: "16px" } }, tabla.el));
    });
  }

  P.ruta.registrar(/^\/mi-caja$/, function (c) {
    var puesto = P.puesto();
    if (!puesto || !puesto.caja_id) { c.appendChild(P.vacio("caja", "No estás trabajando en una caja", "", P.btn("Elegir caja", { tipo: "primario", onclick: function () { P.ruta.ir("/puesto"); } }))); return; }
    return detalleCaja(c, puesto.caja_id, false);
  }, { titulo: "Mi caja", local: true });

  P.ruta.registrar(/^\/caja\/(\d+)$/, function (c, params) { return detalleCaja(c, Number(params[0]), true); }, { admin: true, titulo: "Caja" });

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
    c.appendChild(P.cabeceraConAcciones("Caja", null, [
      P.btn("Saldo de apertura", { tipo: "secundario", icono: "efectivo", onclick: function () { modalApertura(cajasOp, null, refrescar); } }),
      P.btn("Ajuste de caja", { tipo: "primario", icono: "transferencia", onclick: function () { modalAjuste(cajasOp, null, refrescar); } }),
    ]));
    var tarjetas = h("div.grilla", { style: { gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" } }, P.cargando());
    c.appendChild(tarjetas);
    var zonaTabla = h("div", { style: { marginTop: "18px" } });
    var selector = P.segmentado([{ valor: "movimientos", texto: "Movimientos de caja" }, { valor: "cierres", texto: "Cierres de caja" }], vista, function (v) { vista = v; P.cache["caja:vista"] = v; pintarTabla(); });
    c.appendChild(h("div", { style: { marginTop: "22px" } }, selector));
    c.appendChild(zonaTabla);
    var tabla = null;
    function pintarTabla() {
      tabla = vista === "movimientos"
        ? P.tabla({ listado: "caja", sinEtiquetaBuscar: true, alClickFila: function (f) { if (f.cierre_id) P.verCierre(f.cierre_id); } })
        : P.tabla({ listado: "cierres", sinEtiquetaBuscar: true, alClickFila: function (f) { P.verCierre(f.id); } });
      P.reemplazar(zonaTabla, tabla.el);
    }
    function cargarTarjetas() {
      return Promise.all([P.get("/caja/panel"), P.opciones("cajas", true)]).then(function (r) {
        cajasOp = r[1];
        if (!r[0].cajas.length) { P.reemplazar(tarjetas, P.vacio("caja", "No hay cajas", "Creá las cajas de cada boca en Gestión > Bocas y cajas.")); return; }
        P.reemplazar(tarjetas, r[0].cajas.map(function (cj) {
          var ap = cj.apertura;
          var cajaElegida = [{ valor: cj.id, texto: cj.boca + " · " + cj.nombre }];
          return h("div.hoja.hoja-cuerpo.caja-tarjeta",
            h("div.fila-separada", h("div", h("a.caja-enlace", { href: "#/caja/" + cj.id, "aria-label": "Ver " + cj.boca + " · " + cj.nombre }, h("strong", cj.boca)), h("div.texto-3.chico", cj.nombre)),
              !ap ? P.chip("Sin apertura", "VENCIDO") : ap.verificacion === "CORRECTO" ? P.chip("Apertura OK", "CORRECTO") : ap.verificacion === "NO_COINCIDE" ? P.chip("No coincide", "NO_COINCIDE") : P.chip("Sin confirmar", "PENDIENTE")),
            h("div.cifra-valor", { style: { fontSize: "24px" } }, P.f.pesos(cj.saldo)),
            h("div.texto-3.chico", cj.ventas_cantidad + " venta(s) · " + P.f.pesos(cj.ventas_total) + " desde el último cierre"),
            h("div.texto-3.chico", cj.turno ? "Atiende " + cj.turno.usuario_nombre + " desde " + P.f.fechaHora(cj.turno.inicio) : "Disponible"),
            h("div.fila", { style: { marginTop: "12px", gap: "6px" } },
              P.btn("Apertura", { tipo: "suave", chico: true, onclick: function () { modalApertura(cajaElegida, cj.id, refrescar); } }),
              P.btn("Ajuste", { tipo: "suave", chico: true, onclick: function () { modalAjuste(cajaElegida, cj.id, refrescar); } }),
              P.btn("Clave de cierre", { tipo: "suave", chico: true, onclick: function (ev) { mostrarClave(cj.id, cj.nombre, ev.currentTarget); } }),
              P.btn("Cerrar", { tipo: "suave", chico: true, onclick: function () { P.cerrarCaja(cj.id, refrescar); } })));
        }));
      });
    }
    function refrescar() { cargarTarjetas().catch(P.error); if (tabla) tabla.recargar(); }
    pintarTabla();
    P.intervalo(function () { cargarTarjetas().catch(function () {}); }, 20000);
    return cargarTarjetas();
  }, { admin: true, titulo: "Caja" });
})();
