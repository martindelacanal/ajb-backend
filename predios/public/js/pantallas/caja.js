/* Caja: saldo de apertura (lo carga quien gestiona la caja y lo confirma el cajero), ajustes,
   cierres y movimientos. El cajero hace un cierre temporal (dos bolsas con su ticket).
   El cierre definitivo lo hace un administrador o supervisor desde su cuenta. */
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
  var aperturaEnPantalla = null;
  P.verificarApertura = function (forzar) {
    var puesto = P.puesto();
    if (!puesto || !puesto.caja_id) return Promise.resolve();
    return P.get("/caja/estado").then(function (r) {
      var a = r.apertura;
      if (!a) {
        var sinCambio = !(Number(r.resumen.saldo_esperado) > 0);
        var texto = sinCambio
          ? puesto.caja + " arranca sin cambio. Si lo necesitás, pedile al administrador que cargue el saldo de apertura: puede hacerlo a distancia y te va a aparecer acá para confirmarlo."
          : "El administrador todavía no cargó el saldo de apertura de esta jornada para " + puesto.caja + ". Podés empezar a vender igual.";
        if (forzar) P.modal({ titulo: "Saldo de apertura", contenido: P.mensaje(texto, "aviso") });
        else if (sinCambio) P.aviso(texto, "info", 10000);
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
      // El pedido puede llegar a la vez al entrar a la caja y por el aviso del administrador.
      if (aperturaEnPantalla === a.id) return;
      aperturaEnPantalla = a.id;
      var encontrado = P.dinero({ placeholder: "¿Cuánto encontraste? (opcional)" });
      var nota = P.input({ placeholder: "Comentario (opcional)", max: 200 });
      var zonaNo = h("div.columna", { hidden: true }, P.campo("Efectivo que hay en la caja", h("div.campo-con-prefijo", h("span", "$"), encontrado)), P.campo("Comentario", nota),
        P.mensaje("Comunicate con el administrador antes de empezar a cobrar. Queda registrado que el saldo no coincide.", "aviso"));
      var m = P.modal({
        titulo: "Saldo de apertura de la caja",
        subtitulo: "Contá el efectivo de " + puesto.caja + " y confirmá si coincide con lo que cargó el administrador.",
        modalFijo: true,
        alCerrar: function () { aperturaEnPantalla = null; },
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
  // El efectivo esperado se separa en dos: el cambio (saldo inicial y lo que se agregó
  // durante la jornada) y lo cobrado (ventas y demás cobros en efectivo).
  function filaImporte(texto, importe, clase) {
    var n = Number(importe) || 0;
    return h("div" + (clase ? "." + clase : ""), h("span", texto), h("strong.dinero", (n < 0 ? "− " : "") + P.f.pesos(Math.abs(n))));
  }

  function aEntrada(n) { return String(P.redondear(n)).replace(".", ","); }

  P.resumenEfectivoCierre = function (ef) {
    if (!ef) return null;
    return h("div.cierre-efectivo",
      h("div.cierre-grupo",
        filaImporte("Efectivo de cambio", ef.cambio, "cierre-grupo-titulo"),
        filaImporte("Saldo inicial", ef.saldo_inicial),
        filaImporte("Agregados durante la jornada", ef.agregados)),
      h("div.cierre-grupo",
        filaImporte("Efectivo de ventas y cobros", ef.cobros, "cierre-grupo-titulo"),
        filaImporte("Ventas en efectivo", ef.ventas),
        Number(ef.anulaciones) ? filaImporte("Anulaciones", -ef.anulaciones) : null,
        Number(ef.otros_cobros) ? filaImporte("Otros cobros y devoluciones", ef.otros_cobros) : null),
      Number(ef.retiros) ? h("div.cierre-grupo", filaImporte("Retiros durante la jornada", -ef.retiros)) : null);
  };

  function resumenVentas(s, ventasPorForma) {
    return [
      h("hr.cierre-separador"),
      h("div", h("span", "Ventas"), h("strong", s.ventas_cantidad + " · " + P.f.pesos(s.ventas_total))),
      (ventasPorForma || []).map(function (v) { return h("div.texto-3.chico", h("span", (P.FORMAS[v.forma_pago] || v.forma_pago) + " (" + v.cantidad + ")"), h("span.dinero", P.f.pesos(v.total))); }),
      s.ventas_anuladas ? h("div.texto-3.chico", h("span", "Ventas anuladas"), h("span", String(s.ventas_anuladas))) : null,
    ];
  }

  // Muestra la diferencia entre lo contado y lo esperado.
  function pintarDiferencia(el, contado, esperado, prefijo) {
    P.vaciar(el);
    el.className = "";
    if (isNaN(contado)) return;
    var d = P.redondear(contado - esperado);
    el.className = "vuelto vuelto-chico" + (d < 0 ? " falta" : "");
    var texto = d === 0 ? "Sin diferencia" : d > 0 ? "Sobrante" : "Faltante";
    el.appendChild(h("span", prefijo ? prefijo + ": " + texto.toLowerCase() : texto));
    el.appendChild(h("strong", P.f.pesos(Math.abs(d))));
  }

  function liberarPuesto(cajaId) {
    if (P.puesto() && Number(P.puesto().caja_id) === Number(cajaId)) {
      P.estado.sesion.puesto = null;
      P.repintarMarco();
      P.ruta.ir(P.puedeGestionarCajas() ? "/caja" : "/puesto");
    }
  }

  function cierreTemporalListo(d) {
    var c = d.cierre;
    var m = P.modal({
      titulo: "Caja cerrada en forma temporal",
      subtitulo: "Cierre temporal N° " + c.id + " · " + c.boca + " · " + c.caja,
      modalFijo: true,
      contenido: h("div.columna",
        h("div.cierre-bolsas",
          h("div.cierre-bolsa", h("span", "Bolsa 1 · Recaudación"), h("strong.dinero", P.f.pesos(c.efectivo_ventas))),
          h("div.cierre-bolsa", h("span", "Bolsa 2 · Cambio"), h("strong.dinero", P.f.pesos(c.efectivo_cambio)))),
        P.mensaje("Guardá cada bolsa con su ticket. Administración o Supervisión las va a recibir y hacer el cierre definitivo. La caja quedó libre y en $ 0: quien sigue abre su propio turno y recibe su propio saldo de apertura.", "ok")),
      acciones: [
        P.btn("Reimprimir tickets", { tipo: "suave", icono: "imprimir", onclick: function () { P.imprimirCierre(d, { bolsas: true }).catch(P.error); } }),
        P.btn("Elegir otra caja", { tipo: "secundario", onclick: function () { m.cerrar(); P.ruta.ir("/puesto"); } }),
        P.btn("Cerrar sesión", { tipo: "primario", icono: "salir", onclick: function () { m.cerrar(); if (P.salir) P.salir(); } }),
      ],
    });
  }

  P.cerrarCaja = function (cajaId, alTerminar) {
    var definitivo = P.puedeGestionarCajas();
    return P.get("/caja/cierre/previa" + P.qs({ caja_id: cajaId })).then(function (r) {
      if (!definitivo && !r.puede_temporal) { P.aviso("El cierre temporal se hace desde tu turno.", "info"); return; }
      var s = r.resumen;
      var ef = s.efectivo;
      var obs = P.input({ max: 250, placeholder: "Opcional" });
      var corte = { caja_id: r.caja.id, revision: r.revision, turno_id: r.turno ? r.turno.id : null, ultimo_cierre_id: s.ultimo_cierre ? s.ultimo_cierre.id : null };
      var formulario;
      var botonCierre;

      if (definitivo) {
        var contado = P.dinero({ placeholder: "Contá el efectivo" });
        var queda = P.dinero({ valor: "0", placeholder: "0" });
        var diferencia = h("div");
        contado.addEventListener("input", function () { pintarDiferencia(diferencia, P.numeroDe(contado.value), s.saldo_esperado); });
        formulario = h("div.columna",
          P.campo("Efectivo contado", h("div.campo-con-prefijo.campo-grande", h("span", "$"), contado), { requerido: true }),
          diferencia,
          P.campo("Queda en caja para el próximo turno", h("div.campo-con-prefijo", h("span", "$"), queda), { ayuda: "Lo demás se registra como retiro de la recaudación." }),
          Number(ef.esperado_cambio) > 0 ? h("div", P.btn("Dejar el cambio en la caja (" + P.f.pesos(ef.esperado_cambio) + ")", { tipo: "texto", chico: true, onclick: function () { queda.value = aEntrada(ef.esperado_cambio); } })) : null);
        botonCierre = P.btn("Cerrar definitivamente e imprimir", { tipo: "primario", icono: "imprimir", onclick: function (ev) {
          var c = P.numeroDe(contado.value);
          if (isNaN(c)) { contado.classList.add("invalido"); contado.focus(); return; }
          P.ejecutar(ev.currentTarget, function () {
            return P.post("/caja/cierre", Object.assign({ efectivo_contado: c, queda_en_caja: P.numeroDe(queda.value) || 0, observaciones: obs.value }, corte)).then(function (x) {
              m.cerrar();
              if (x.encolado) return;
              P.aviso(x.mensaje, x.diferencia === 0 ? "ok" : "error", 8000);
              if (x.id) P.get("/caja/cierres/" + x.id).then(function (d) { return P.imprimirCierre(d); }).catch(P.error);
              liberarPuesto(r.caja.id);
              if (alTerminar) alTerminar(x);
            });
          }).catch(function () {});
        } });
      } else {
        var bolsaVentas = P.dinero({ placeholder: "Contá la bolsa" });
        var bolsaCambio = P.dinero({ placeholder: "Contá la bolsa" });
        var difVentas = h("div"), difCambio = h("div"), difTotal = h("div");
        var calcularTemporal = function () {
          var v = P.numeroDe(bolsaVentas.value), c = P.numeroDe(bolsaCambio.value);
          pintarDiferencia(difVentas, v, ef.esperado_ventas);
          pintarDiferencia(difCambio, c, ef.esperado_cambio);
          pintarDiferencia(difTotal, isNaN(v) || isNaN(c) ? NaN : v + c, s.saldo_esperado, "En total");
        };
        bolsaVentas.addEventListener("input", calcularTemporal);
        bolsaCambio.addEventListener("input", calcularTemporal);
        formulario = h("div.columna",
          P.mensaje("Separá lo cobrado y el cambio en dos bolsas. Se imprime un ticket para cada bolsa y el resumen del cierre. Administración o Supervisión hace el cierre definitivo cuando las recibe.", "info"),
          P.campo("Bolsa 1 · Recaudación (ventas y cobros)", h("div.campo-con-prefijo.campo-grande", h("span", "$"), bolsaVentas),
            { requerido: true, ayuda: "El sistema espera " + P.f.pesos(ef.esperado_ventas) + (Number(ef.retiros) ? ", ya descontados los retiros." : ".") }),
          difVentas,
          P.campo("Bolsa 2 · Cambio (saldo inicial y agregados)", h("div.campo-con-prefijo.campo-grande", h("span", "$"), bolsaCambio),
            { requerido: true, ayuda: "El sistema espera " + P.f.pesos(ef.esperado_cambio) + "." }),
          difCambio, difTotal);
        botonCierre = P.btn("Cerrar temporalmente e imprimir", { tipo: "primario", icono: "imprimir", onclick: function (ev) {
          var v = P.numeroDe(bolsaVentas.value), c = P.numeroDe(bolsaCambio.value);
          if (isNaN(v)) { bolsaVentas.classList.add("invalido"); bolsaVentas.focus(); return; }
          if (isNaN(c)) { bolsaCambio.classList.add("invalido"); bolsaCambio.focus(); return; }
          P.ejecutar(ev.currentTarget, function () {
            return P.post("/caja/cierre/temporal", Object.assign({ efectivo_ventas: v, efectivo_cambio: c, observaciones: obs.value }, corte)).then(function (x) {
              m.cerrar();
              liberarPuesto(r.caja.id);
              if (alTerminar) alTerminar(x);
              return P.get("/caja/cierres/" + x.id).then(function (d) {
                cierreTemporalListo(d);
                P.imprimirCierre(d, { bolsas: true }).catch(P.error);
              });
            });
          }).catch(function () {});
        } });
      }

      var m = P.modal({
        titulo: (definitivo ? "Cerrar caja · " : "Cierre temporal · ") + r.caja.nombre,
        subtitulo: s.ultimo_cierre ? "Desde el cierre N° " + s.ultimo_cierre.id + " (" + P.f.fechaHora(s.ultimo_cierre.fecha) + ")" : "Primer cierre de esta caja",
        ancho: "ancha",
        contenido: h("div.grilla.grilla-2",
          h("div.resumen-cuentas.cierre-resumen",
            P.resumenEfectivoCierre(ef),
            h("div.fuerte", h("span", "Efectivo esperado en la caja"), h("span.dinero", P.f.pesos(s.saldo_esperado))),
            resumenVentas(s, s.ventas_por_forma)),
          h("div.columna", formulario, P.campo("Observaciones", obs))),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), botonCierre],
      });
    }).catch(P.error);
  };

  // Recepción de bolsas y confirmación de un cierre temporal.
  P.recibirTemporal = function (c, alTerminar) {
    var recVentas = P.dinero({ placeholder: "Contá la bolsa" });
    var recCambio = P.dinero({ placeholder: "Contá la bolsa" });
    var difVentas = h("div"), difCambio = h("div");
    var obs = P.input({ max: 250, placeholder: "Opcional" });
    function calcular() {
      pintarDiferencia(difVentas, P.numeroDe(recVentas.value), Number(c.efectivo_ventas), "Frente a lo declarado");
      pintarDiferencia(difCambio, P.numeroDe(recCambio.value), Number(c.efectivo_cambio), "Frente a lo declarado");
    }
    recVentas.addEventListener("input", calcular);
    recCambio.addEventListener("input", calcular);
    function imprimir(opciones) {
      return P.get("/caja/cierres/" + c.id).then(function (d) { return P.imprimirCierre(d, opciones); }).catch(P.error);
    }
    var m = P.modal({
      titulo: "Cierre definitivo · temporal N° " + c.id,
      subtitulo: c.boca + " · " + c.caja + " · lo cerró " + c.usuario_nombre + " el " + P.f.fechaHora(c.fecha),
      ancho: "ancha",
      contenido: h("div.grilla.grilla-2",
        h("div.resumen-cuentas.cierre-resumen",
          c.turno_inicio ? h("div.texto-3.chico", h("span", "Turno desde"), h("span", P.f.fechaHora(c.turno_inicio))) : null,
          P.resumenEfectivoCierre(c.efectivo),
          h("div.fuerte", h("span", "Efectivo esperado"), h("span.dinero", P.f.pesos(c.saldo_esperado))),
          h("hr.cierre-separador"),
          filaImporte("Declaró en la bolsa 1 · Recaudación", c.efectivo_ventas),
          filaImporte("Declaró en la bolsa 2 · Cambio", c.efectivo_cambio),
          filaImporte(Number(c.diferencia) === 0 ? "Sin diferencia al cerrar" : Number(c.diferencia) > 0 ? "Sobrante al cerrar" : "Faltante al cerrar", c.diferencia),
          c.observaciones ? h("p.texto-3.chico", { style: { margin: 0 } }, "Observaciones: " + c.observaciones) : null),
        h("div.columna",
          P.mensaje("Contá cada bolsa y anotá lo que encontraste. La caja no se toca: puede seguir trabajando.", "info"),
          P.campo("Bolsa 1 · Recaudación recibida", h("div.campo-con-prefijo.campo-grande", h("span", "$"), recVentas), { requerido: true, ayuda: "Declarado: " + P.f.pesos(c.efectivo_ventas) + "." }),
          difVentas,
          P.campo("Bolsa 2 · Cambio recibido", h("div.campo-con-prefijo.campo-grande", h("span", "$"), recCambio), { requerido: true, ayuda: "Declarado: " + P.f.pesos(c.efectivo_cambio) + "." }),
          difCambio,
          h("div", P.btn("Coinciden con lo declarado", { tipo: "texto", chico: true, icono: "check", onclick: function () {
            recVentas.value = aEntrada(c.efectivo_ventas); recCambio.value = aEntrada(c.efectivo_cambio); calcular();
          } })),
          P.campo("Observaciones", obs),
          h("p.texto-3.chico", { style: { margin: 0 } }, "Si el cambio vuelve a una caja, cargalo después como saldo de apertura."))),
      acciones: [
        P.btn("Cancelar", { onclick: function () { m.cerrar(); } }),
        P.btn("Reimprimir tickets", { tipo: "suave", icono: "imprimir", onclick: function () { imprimir({ bolsas: true }); } }),
        P.btn("Cerrar definitivamente e imprimir", { tipo: "primario", icono: "check", onclick: function (ev) {
          var v = P.numeroDe(recVentas.value), k = P.numeroDe(recCambio.value);
          if (isNaN(v)) { recVentas.classList.add("invalido"); recVentas.focus(); return; }
          if (isNaN(k)) { recCambio.classList.add("invalido"); recCambio.focus(); return; }
          P.ejecutar(ev.currentTarget, function () {
            return P.post("/caja/cierres/" + c.id + "/definitivo", { recibido_ventas: v, recibido_cambio: k, observaciones: obs.value }).then(function (x) {
              m.cerrar();
              if (alTerminar) alTerminar(x);
              if (x.encolado) return;
              P.aviso(x.mensaje, x.diferencia_recepcion === 0 ? "ok" : "error", 8000);
              imprimir();
            });
          }).catch(function () {});
        } }),
      ],
    });
    return m;
  };

  // Lista de cierres temporales que esperan que se reciban las bolsas.
  function seccionTemporales(temporales, alTerminar) {
    if (!temporales.length) return null;
    return h("section.hoja.hoja-cuerpo.cierres-temporales",
      h("div.fila-separada",
        h("div", h("h2.seccion-titulo", "Cierres temporales por recibir"),
          h("p.texto-3.chico", { style: { margin: "2px 0 0" } }, "Cada uno tiene dos bolsas con su ticket: recaudación y cambio. Recibilas y cerralos de a uno. Si alguien sigue en esa caja y necesita cambio, cargáselo desde acá.")),
        P.chip(temporales.length + (temporales.length === 1 ? " pendiente" : " pendientes"), "PENDIENTE")),
      h("ul.lista-simple", temporales.map(function (c) {
        return h("li",
          h("div",
            h("strong", "N° " + c.id + " · " + c.boca + " · " + c.caja),
            h("div.texto-3.chico", c.usuario_nombre + " · " + P.f.fechaHora(c.fecha) + (Number(c.diferencia) ? " · " + (Number(c.diferencia) > 0 ? "sobrante " : "faltante ") + P.f.pesos(Math.abs(c.diferencia)) : ""))),
          h("div.cierre-temporal-montos",
            h("span.texto-3.chico", "Recaudación"), h("strong.dinero", P.f.pesos(c.efectivo_ventas)),
            h("span.texto-3.chico", "Cambio"), h("strong.dinero", P.f.pesos(c.efectivo_cambio))),
          h("div.fila.cierre-temporal-acciones",
            P.btn("Cargar cambio", { tipo: "suave", chico: true, icono: "efectivo", onclick: function () { P.cargarApertura(c.caja_id, alTerminar); } }),
            P.btn("Recibir y cerrar", { tipo: "primario", chico: true, icono: "check", onclick: function () { P.recibirTemporal(c, alTerminar); } })));
      })));
  }

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
      if (!c.isConnected) return;
      var nombre = r.boca.nombre + " · " + r.caja.nombre;
      var esPropia = P.puesto() && Number(P.puesto().caja_id) === Number(cajaId);
      var caja = [{ valor: cajaId, texto: nombre }];
      var acciones = [P.btn(desdePanel ? "Ventas de la caja" : "Mis ventas", { tipo: "suave", chico: true, icono: "lista", onclick: function () { P.ruta.ir(desdePanel ? "/caja/" + cajaId + "/ventas" : "/mis-ventas"); } })];
      if (desdePanel) {
        registrarFormulariosCaja(function () { return caja; }, refrescar);
        acciones.push(
          P.btn("Saldo de apertura", { tipo: "suave", chico: true, icono: "efectivo", onclick: function () { modalApertura(caja, cajaId, refrescar); } }),
          P.btn("Ajuste de caja", { tipo: "suave", chico: true, icono: "transferencia", onclick: function () { modalAjuste(caja, cajaId, refrescar); } }));
      } else {
        acciones.push(P.btn("Ver saldo de apertura", { tipo: "suave", chico: true, icono: "efectivo", onclick: function () { P.verificarApertura(true); } }));
      }
      acciones.push(P.btn(P.puedeGestionarCajas() ? "Cerrar caja" : "Cierre temporal", { tipo: "primario", icono: "candado", onclick: function () { P.cerrarCaja(cajaId, refrescar); } }));
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

  P.ruta.registrar(/^\/caja\/(\d+)$/, function (c, params) { return detalleCaja(c, Number(params[0]), true); }, { cajas: true, titulo: "Caja" });

  // ------------------------------------------------------------------ panel de cajas
  function registrarFormulariosCaja(opciones, alTerminar) {
    function reabrir(formulario) {
      return function (datos) {
        var cajas = opciones();
        if (datos.cajaId != null) cajas = cajas.filter(function (c) { return String(c.valor) === String(datos.cajaId); });
        if (!cajas.some(function (c) { return String(c.valor) === datos.seleccion; })) return null;
        return formulario(cajas, datos.cajaId, alTerminar, datos);
      };
    }
    P.continuidad.registrarVentana("caja-apertura", reabrir(modalApertura));
    P.continuidad.registrarVentana("caja-ajuste", reabrir(modalAjuste));
  }
  P.cargarApertura = function (cajaId, alTerminar) {
    return P.opciones("cajas", true).then(function (cajas) {
      var elegida = cajas.filter(function (c) { return String(c.valor) === String(cajaId); });
      return modalApertura(elegida.length ? elegida : cajas, cajaId, alTerminar);
    }).catch(P.error);
  };

  function modalApertura(cajas, cajaId, alTerminar, previo) {
    var caja = P.select(cajas, previo ? previo.seleccion : cajaId);
    var fecha = P.input({ tipo: "date", valor: previo ? previo.fecha : P.hoy() });
    var importe = P.dinero({ autofocus: true });
    var obs = P.input({ max: 200, placeholder: "Opcional" });
    var m = P.modal({
      reanudar: { id: "caja-apertura", datos: function () { return { cajaId: cajaId, seleccion: caja.value, fecha: fecha.value }; } },
      titulo: "Saldo de apertura",
      subtitulo: "El efectivo de cambio con el que arranca la caja. No cambia lo que ya se cobró: si alguien está atendiendo, lo ve y lo confirma al momento.",
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
    return m;
  }

  function modalAjuste(cajas, cajaId, alTerminar, previo) {
    if (previo && !CONCEPTOS_AJUSTE.some(function (c) { return c.valor === previo.concepto; })) return null;
    var caja = P.select(cajas, previo ? previo.seleccion : cajaId);
    var concepto = P.select(CONCEPTOS_AJUSTE, previo ? previo.concepto : "CIERRE_CAJA");
    var tipo = P.segmentado([{ valor: "INGRESO", texto: "Ingreso" }, { valor: "EGRESO", texto: "Egreso" }], previo ? previo.tipo : "EGRESO");
    concepto.addEventListener("change", function () { tipo.fijar(CONCEPTOS_AJUSTE.filter(function (x) { return x.valor === concepto.value; })[0].tipo); });
    var importe = P.dinero({ autofocus: true });
    var recibo = P.input({ max: 40, placeholder: "N° de recibo (opcional)" });
    var obs = P.input({ max: 250, placeholder: "Opcional" });
    var m = P.modal({
      reanudar: { id: "caja-ajuste", datos: function () { return { cajaId: cajaId, seleccion: caja.value, concepto: concepto.value, tipo: tipo.valor() }; } },
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
    return m;
  }

  P.verCierre = function (id, alCambiar) {
    P.get("/caja/cierres/" + id).then(function (d) {
      var ci = d.cierre;
      var temporal = ci.tipo === "TEMPORAL";
      var pendiente = temporal && ci.estado === "PENDIENTE";
      var estado = pendiente ? P.chip("Temporal · falta el cierre definitivo", "PENDIENTE")
        : temporal ? P.chip("Temporal · cerrado por " + (ci.definitivo_usuario_nombre || "un administrador"), "CORRECTO")
          : P.chip("Definitivo" + (ci.definitivo_usuario_nombre && ci.definitivo_usuario_nombre !== ci.usuario_nombre ? " · autorizó " + ci.definitivo_usuario_nombre : ""), "CORRECTO");
      var m = P.modal({
        titulo: (temporal ? "Cierre temporal N° " : "Cierre N° ") + ci.id,
        subtitulo: ci.boca + " · " + ci.caja + " · " + P.f.fechaHora(ci.fecha) + " · " + ci.usuario_nombre,
        contenido: h("div.columna",
          h("div", estado),
          h("div.resumen-cuentas.cierre-resumen",
            ci.turno_inicio ? h("div.texto-3.chico", h("span", "Turno desde"), h("span", P.f.fechaHora(ci.turno_inicio))) : null,
            d.efectivo ? P.resumenEfectivoCierre(d.efectivo) : [
              h("div", h("span", "Saldo inicial"), h("strong", P.f.pesos(ci.saldo_inicial))),
              h("div", h("span", "Ingresos"), h("strong", P.f.pesos(ci.ingresos))),
              h("div", h("span", "Egresos"), h("strong", P.f.pesos(ci.egresos)))],
            h("div.fuerte", h("span", "Efectivo esperado"), h("span", P.f.pesos(ci.saldo_esperado))),
            temporal ? [
              filaImporte("Bolsa 1 · Recaudación (declarado)", ci.efectivo_ventas),
              filaImporte("Bolsa 2 · Cambio (declarado)", ci.efectivo_cambio),
            ] : h("div", h("span", "Contado"), h("strong", P.f.pesos(ci.efectivo_contado))),
            h("div", h("span", "Diferencia"), h("strong" + (Number(ci.diferencia) < 0 ? ".negativo" : ""), P.f.pesos(ci.diferencia))),
            temporal ? null : h("div", h("span", "Retiro"), h("strong", P.f.pesos(ci.retiro))),
            h("div", h("span", "Queda en caja"), h("strong", P.f.pesos(ci.queda_en_caja))),
            temporal && !pendiente ? [
              h("hr.cierre-separador"),
              h("div.texto-3.chico", h("span", "Cierre definitivo"), h("span", (ci.definitivo_usuario_nombre || "") + " · " + P.f.fechaHora(ci.definitivo_fecha))),
              filaImporte("Bolsa 1 · Recaudación (recibido)", ci.recibido_ventas),
              filaImporte("Bolsa 2 · Cambio (recibido)", ci.recibido_cambio),
              filaImporte("Diferencia frente a lo declarado", ci.diferencia_recepcion),
              ci.observaciones_definitivo ? h("div.texto-3", ci.observaciones_definitivo) : null,
            ] : null,
            resumenVentas(ci, d.ventas_por_forma),
            ci.observaciones ? h("div.texto-3", ci.observaciones) : null)),
        acciones: [
          temporal ? P.btn("Tickets de las bolsas", { tipo: "suave", icono: "imprimir", onclick: function () { P.imprimirCierre(d, { resumen: false, bolsas: true }).catch(P.error); } }) : null,
          P.btn("Imprimir resumen", { tipo: pendiente && P.puedeGestionarCajas() ? "secundario" : "primario", icono: "imprimir", onclick: function () { P.imprimirCierre(d).catch(P.error); } }),
          pendiente && P.puedeGestionarCajas() ? P.btn("Hacer el cierre definitivo", { tipo: "primario", icono: "check", onclick: function () {
            m.cerrar();
            P.recibirTemporal(Object.assign({}, ci, { efectivo: d.efectivo }), alCambiar);
          } }) : null,
        ],
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
    var zonaTemporales = h("div");
    c.appendChild(zonaTemporales);
    var tarjetas = h("div.grilla", { style: { gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" } }, P.cargando());
    c.appendChild(tarjetas);
    var zonaTabla = h("div", { style: { marginTop: "18px" } });
    var selector = P.segmentado([{ valor: "movimientos", texto: "Movimientos de caja" }, { valor: "cierres", texto: "Cierres de caja" }], vista, function (v) { vista = v; P.cache["caja:vista"] = v; pintarTabla(); });
    c.appendChild(h("div", { style: { marginTop: "22px" } }, selector));
    c.appendChild(zonaTabla);
    var tabla = null;
    function pintarTabla() {
      tabla = vista === "movimientos"
        ? P.tabla({ listado: "caja", sinEtiquetaBuscar: true, alClickFila: function (f) { if (f.cierre_id) P.verCierre(f.cierre_id, refrescar); } })
        : P.tabla({ listado: "cierres", sinEtiquetaBuscar: true, alClickFila: function (f) { P.verCierre(f.id, refrescar); } });
      P.reemplazar(zonaTabla, tabla.el);
    }
    function cargarTarjetas() {
      return Promise.all([P.get("/caja/panel"), P.opciones("cajas", true)]).then(function (r) {
        if (!c.isConnected) return;
        cajasOp = r[1];
        registrarFormulariosCaja(function () { return cajasOp; }, refrescar);
        P.reemplazar(zonaTemporales, seccionTemporales(r[0].temporales || [], refrescar));
        if (!r[0].cajas.length) {
          P.reemplazar(tarjetas, P.vacio("caja", "No hay cajas disponibles", P.esAdmin() ? "Creá las cajas de cada boca en Gestión > Bocas y cajas." : "Se muestran las cajas activas de las bocas que tenés asignadas."));
          return;
        }
        P.reemplazar(tarjetas, r[0].cajas.map(function (cj) {
          var ap = cj.apertura;
          var cajaElegida = [{ valor: cj.id, texto: cj.boca + " · " + cj.nombre }];
          return h("div.hoja.hoja-cuerpo.caja-tarjeta",
            h("div.fila-separada", h("div", h("a.caja-enlace", { href: "#/caja/" + cj.id, "aria-label": "Ver " + cj.boca + " · " + cj.nombre }, h("strong", cj.boca)), h("div.texto-3.chico", cj.nombre)),
              !ap ? P.chip("Sin apertura", "VENCIDO") : ap.verificacion === "CORRECTO" ? P.chip("Apertura OK", "CORRECTO") : ap.verificacion === "NO_COINCIDE" ? P.chip("No coincide", "NO_COINCIDE") : P.chip("Sin confirmar", "PENDIENTE")),
            h("div.cifra-valor", { style: { fontSize: "24px" } }, P.f.pesos(cj.saldo)),
            h("div.texto-3.chico", P.f.entero(cj.ventas_cantidad) + (cj.ventas_cantidad === 1 ? " venta" : " ventas")),
            h("div.texto-3.chico", P.f.pesos(cj.ventas_total) + " desde el último cierre"),
            h("div.texto-3.chico", cj.turno ? "Atiende " + cj.turno.usuario_nombre + " desde " + P.f.fechaHora(cj.turno.inicio) : "Disponible"),
            cj.temporales_pendientes ? h("div", { style: { marginTop: "6px" } }, P.chip(cj.temporales_pendientes + (cj.temporales_pendientes === 1 ? " cierre temporal por recibir" : " cierres temporales por recibir"), "PENDIENTE")) : null,
            h("div.fila", { style: { marginTop: "12px", gap: "6px" } },
              P.btn("Apertura", { tipo: "suave", chico: true, onclick: function () { modalApertura(cajaElegida, cj.id, refrescar); } }),
              P.btn("Ajuste", { tipo: "suave", chico: true, onclick: function () { modalAjuste(cajaElegida, cj.id, refrescar); } }),
              P.btn("Cerrar", { tipo: "suave", chico: true, onclick: function () { P.cerrarCaja(cj.id, refrescar); } })));
        }));
      });
    }
    function refrescar() { cargarTarjetas().catch(P.error); if (tabla) tabla.recargar(); }
    pintarTabla();
    P.intervalo(function () { cargarTarjetas().catch(function () {}); }, 20000);
    return cargarTarjetas();
  }, { cajas: true, titulo: "Caja" });
})();
