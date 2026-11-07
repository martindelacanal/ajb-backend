/* Afiliados del predio: los que tienen reserva (vienen del sistema general) y los cargados a
   mano; límite de descuento de haberes, modificación masiva, consumos y liquidaciones. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  var FORMAS_LIQ = [
    { valor: "DESCUENTO_HABERES", texto: "Descuento de haberes" }, { valor: "EFECTIVO", texto: "Efectivo" },
    { valor: "TARJETA_DEBITO", texto: "Débito" }, { valor: "TARJETA_CREDITO", texto: "Crédito" },
    { valor: "QR", texto: "QR" }, { valor: "TRANSFERENCIA", texto: "Transferencia" },
  ];

  function formAfiliado(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    var sistema = base.origen === "SISTEMA";
    var dni = P.input({ valor: base.dni, inputmode: "numeric", max: 10, soloLectura: sistema });
    var legajo = P.input({ valor: base.legajo, max: 30, soloLectura: sistema });
    var nombre = P.input({ valor: base.nombre, max: 160, placeholder: "Apellido, Nombre", soloLectura: sistema });
    var limite = P.dinero({ valor: base.limite !== undefined ? P.f.numero(base.limite) : "" });
    var departamental = P.combo({ fuente: "departamentales", placeholder: "Elegí la departamental", valor: base.departamental_id, texto: base.departamental || "" });
    var habilitado = P.check("Puede comprar con descuento de haberes", base.habilitado_descuento === undefined ? true : Number(base.habilitado_descuento) === 1);
    var obs = P.input({ valor: base.observaciones, max: 250, placeholder: "Opcional" });
    var m = P.modal({
      titulo: editar ? base.nombre : "Nuevo afiliado",
      reanudar: { id: "afiliado-formulario" },
      subtitulo: sistema ? "Sus datos vienen del sistema general: acá sólo cambia el límite." : (editar ? "Cargado a mano." : "Para quien todavía no aparece por sincronización. Cuando llegue del sistema general se une solo por DNI o legajo."),
      ancho: "ancha",
      contenido: h("div.columna",
        h("div.grilla.grilla-3", P.campo("DNI", dni), P.campo("Legajo", legajo), P.campo("Nombre", nombre, { requerido: true })),
        h("div.grilla.grilla-2", P.campo("Límite de descuento", h("div.campo-con-prefijo", h("span", "$"), limite), { ayuda: "Lo que puede consumir con descuento de haberes." }),
          sistema ? P.campo("Departamental", P.input({ valor: base.departamental, soloLectura: true })) : P.campo("Departamental", departamental.el)),
        habilitado, P.campo("Observaciones", obs)),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", icono: "check", onclick: function (ev) {
        var cuerpo = sistema ? { limite: P.numeroDe(limite.value) || 0, habilitado_descuento: habilitado.input.checked, observaciones: obs.value }
          : { dni: dni.value, legajo: legajo.value, nombre: nombre.value, limite: P.numeroDe(limite.value) || 0, departamental_id: departamental.valor(), habilitado_descuento: habilitado.input.checked, observaciones: obs.value };
        P.ejecutar(ev.currentTarget, function () {
          return (editar ? P.put("/afiliados/" + base.id, cuerpo) : P.post("/afiliados", cuerpo)).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); m.cerrar(); if (alGuardar) alGuardar(r); });
        }).catch(function () {});
      } })],
    });
    return m;
  }

  // ------------------------------------------------------------------ modificación masiva de límites
  function limitesMasivos(alTerminar) {
    var op = P.select([{ valor: "", texto: "Cualquier límite" }, { valor: "eq", texto: "Igual a" }, { valor: "gte", texto: "Mayor o igual a" }, { valor: "lte", texto: "Menor o igual a" }], "");
    var monto = P.dinero({ placeholder: "Monto actual" });
    var desde = P.input({ tipo: "date" });
    var hasta = P.input({ tipo: "date" });
    var ubicacion = P.select([{ valor: "", texto: "Todos" }, { valor: "1", texto: "En el predio hoy" }, { valor: "proximos", texto: "Llegan en los próximos 7 días" }, { valor: "con_estadia", texto: "Con estadía reciente o próxima" }], "");
    var departamental = P.select([], "", { vacio: "Todas" });
    P.opciones("departamentales").then(function (ops) { ops.forEach(function (o) { departamental.appendChild(h("option", { value: o.valor }, o.texto)); }); });
    var origen = P.select([{ valor: "", texto: "Todos" }, { valor: "SISTEMA", texto: "Del sistema general" }, { valor: "MANUAL", texto: "Cargados a mano" }], "");
    var nuevo = P.dinero({ placeholder: "Nuevo límite" });
    var vista = h("div");
    function filtros() {
      var f = {};
      if (op.value && monto.value) f.limite = op.value + ":" + P.numeroDe(monto.value);
      if (desde.value) f.estadia_desde = desde.value;
      if (hasta.value) f.estadia_hasta = hasta.value;
      if (ubicacion.value) f.en_predio = ubicacion.value;
      if (departamental.value) f.departamental = departamental.value;
      if (origen.value) f.origen = origen.value;
      return f;
    }
    function previa(boton) {
      return P.ejecutar(boton, function () {
        return P.post("/afiliados/limites/previa", { filtros: filtros() }).then(function (r) {
          P.reemplazar(vista, h("div.columna",
            P.mensaje(r.cantidad ? r.cantidad + " afiliado(s) coinciden (suman " + P.f.pesos(r.suma_limites) + " de límite hoy)." : "Ningún afiliado coincide con esos filtros.", r.cantidad ? null : "aviso"),
            r.muestra.length ? h("ul.lista-simple", r.muestra.map(function (a) {
              return h("li", h("div", h("strong", a.nombre), h("div.texto-3.chico", [a.dni, a.legajo ? "Leg. " + a.legajo : null, a.departamental].filter(Boolean).join(" · "))), h("span.dinero", P.f.pesos(a.limite)));
            })) : null,
            r.cantidad > r.muestra.length ? h("p.texto-3.chico", "…y " + (r.cantidad - r.muestra.length) + " más.") : null));
          return r;
        });
      });
    }
    var m = P.modal({
      titulo: "Modificar límites masivamente",
      subtitulo: "Elegí a quiénes (por límite actual, fechas de estadía, departamental…) y el nuevo monto.",
      ancho: "ancha",
      contenido: h("div.columna",
        h("div.grilla.grilla-2", P.campo("Límite actual", h("div.fila", { style: { flexWrap: "nowrap", gap: "6px" } }, op, monto)), P.campo("Ubicación", ubicacion)),
        h("div.filtro-rango-fechas", { role: "group", "aria-label": "Fechas de estadía" }, P.campo("Con estadía desde", desde), P.campo("Hasta", hasta)),
        h("div.grilla.grilla-2", P.campo("Departamental", departamental), P.campo("Origen", origen)),
        P.campo("Nuevo límite", h("div.campo-con-prefijo.campo-grande", h("span", "$"), nuevo), { requerido: true }),
        vista),
      acciones: [
        P.btn("Ver a quiénes afecta", { tipo: "secundario", icono: "ojo", onclick: function (ev) { previa(ev.currentTarget).catch(function () {}); } }),
        P.btn("Aplicar", { tipo: "primario", icono: "check", onclick: function (ev) {
          var boton = ev.currentTarget;
          if (!nuevo.value.trim()) { nuevo.classList.add("invalido"); nuevo.focus(); return; }
          previa(boton).then(function (r) {
            if (!r.cantidad) return;
            return P.confirmar("Se va a cambiar el límite de " + r.cantidad + " afiliado(s) a " + P.f.pesos(P.numeroDe(nuevo.value)) + ". Queda registrado en el historial.", { aceptar: "Aplicar a " + r.cantidad }).then(function (ok) {
              if (!ok) return;
              return P.post("/afiliados/limites/masivo", { filtros: filtros(), nuevo_limite: P.numeroDe(nuevo.value) }).then(function (x) {
                if (!x.encolado) P.aviso(x.mensaje, "ok");
                m.cerrar();
                if (alTerminar) alTerminar();
              });
            });
          }).catch(P.error);
        } }),
      ],
    });
  }

  // ------------------------------------------------------------------ listado
  P.ruta.registrar(/^\/gestion\/afiliados$/, function (c, _p, q) {
    P.solapasGestion(c, "/gestion/afiliados");
    if (q.en_predio) P.cache["tabla:afiliados"] = { filtros: { en_predio: q.en_predio } };
    function abrirAfiliado() { return formAfiliado({}, function () { t.recargar(); }); }
    var t = P.tabla({
      listado: "afiliados", placeholderBuscar: "Nombre, DNI, legajo o departamental",
      alClickFila: function (f) { P.ruta.ir("/afiliados/" + f.id); },
      celdas: {
        en_predio: function (v) { return Number(v) ? P.chip("En el predio", "CONFIRMADA") : ""; },
        disponible: function (v) { return h("span.dinero.fuerte" + (Number(v) <= 0 ? ".negativo" : ""), P.f.pesos(v)); },
        origen: function (v) { return v === "MANUAL" ? P.chip("Manual", "PENDIENTE") : "Sistema"; },
      },
      tituloVacio: "No hay afiliados con estos filtros", textoVacio: "Los afiliados con reserva en el camping o en las cabañas llegan solos del sistema general.",
    });
    c.appendChild(h("div.gestion-acciones",
      h("div.gestion-acciones-grupo",
      P.btn("Modificar límites", { tipo: "suave", chico: true, icono: "descuento", onclick: function () { limitesMasivos(function () { t.recargar(); }); } }),
      P.btn("Liquidaciones y deudas", { tipo: "suave", chico: true, icono: "planilla", onclick: function () { P.ruta.ir("/gestion/liquidaciones"); } }),
      P.btn("Historial de límites", { tipo: "suave", chico: true, icono: "historial", onclick: function () { P.ruta.ir("/gestion/limites"); } })),
      h("div.gestion-accion-nueva", P.btn("Nuevo afiliado", { tipo: "primario", icono: "mas", onclick: abrirAfiliado }))));
    c.appendChild(t.el);
    P.continuidad.registrarVentana("afiliado-formulario", abrirAfiliado);
  }, { admin: true, titulo: "Afiliados" });

  P.ruta.registrar(/^\/gestion\/limites$/, function (c) {
    c.appendChild(h("div.pagina-cabecera", h("div", h("a.volver", { href: "#/gestion/afiliados" }, P.icono("volver"), "Afiliados"), h("h1.titulo-pagina", "Historial de límites"))));
    c.appendChild(P.tabla({ listado: "limites" }).el);
  }, { admin: true, titulo: "Historial de límites" });

  P.ruta.registrar(/^\/gestion\/liquidaciones$/, function (c) {
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/gestion/afiliados" }, P.icono("volver"), "Afiliados"),
      h("h1.titulo-pagina", "Liquidaciones y deudas"),
      h("p.subtitulo", "Quién debe cuánto, en cuántas cuotas y cómo paga. Exportá el CSV filtrado para la sede o las departamentales."))));
    c.appendChild(P.tabla({
      listado: "liquidaciones",
      alClickFila: function (f) { P.get("/liquidaciones/" + f.id).then(P.imprimirLiquidacion).catch(P.error); },
      acciones: function (f, recargar) { return accionesLiquidacion(f, recargar); },
    }).el);
  }, { admin: true, titulo: "Liquidaciones" });

  function accionesLiquidacion(f, recargar) {
    return [
      P.btn("", { tipo: "texto", chico: true, icono: "imprimir", etiqueta: "Imprimir", onclick: function () { P.get("/liquidaciones/" + f.id).then(P.imprimirLiquidacion).catch(P.error); } }),
      f.estado === "PENDIENTE" ? P.btn("Pagada", { tipo: "suave", chico: true, icono: "check", onclick: function () {
        P.pedirTexto("Marcar pagada la liquidación N° " + f.id, { etiqueta: "N° de recibo (opcional)", aceptar: "Marcar pagada" }).then(function (recibo) {
          if (recibo === null) return;
          P.post("/liquidaciones/" + f.id + "/pagar", { recibo: recibo }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); recargar(); }).catch(P.error);
        });
      } }) : null,
      f.estado !== "ANULADA" ? P.btn("", { tipo: "texto", chico: true, icono: "borrar", etiqueta: "Anular", onclick: function () {
        P.pedirTexto("Anular la liquidación N° " + f.id, { etiqueta: "Motivo", requerido: true, aceptar: "Anular", peligro: true, subtitulo: "Los consumos vuelven a quedar pendientes de liquidar." }).then(function (motivo) {
          if (!motivo) return;
          P.post("/liquidaciones/" + f.id + "/anular", { motivo: motivo }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); recargar(); }).catch(P.error);
        });
      } }) : null,
    ];
  }

  // ------------------------------------------------------------------ ficha del afiliado
  P.ruta.registrar(/^\/afiliados\/(\d+)$/, function (c, params) {
    var id = Number(params[0]);
    var cargar = P.get("/afiliados/" + id);
    function abrirAfiliado() {
      return cargar.then(function (d) { return formAfiliado(d.afiliado, function () { P.ruta.ir("/afiliados/" + id); }); });
    }
    P.continuidad.registrarVentana("afiliado-formulario", abrirAfiliado);
    return cargar.then(function (d) {
      var a = d.afiliado;
      var disp = d.disponible;
      var hoy = P.hoy();
      var enPredio = d.estadias.some(function (e) { return Number(e.activo) && e.fecha_inicio <= hoy && e.fecha_fin >= hoy; });
      c.appendChild(h("div.pagina-cabecera",
        h("div", h("a.volver", { href: "#/gestion/afiliados" }, P.icono("volver"), "Afiliados"),
          h("h1.titulo-pagina", a.nombre),
          h("p.subtitulo", [a.dni ? "DNI " + P.documento(a.dni) : null, a.legajo ? "Legajo " + a.legajo : null, a.departamental].filter(Boolean).join(" · "), " ",
            enPredio ? P.chip("En el predio", "CONFIRMADA") : null, " ", a.origen === "MANUAL" ? P.chip("Cargado a mano", "PENDIENTE") : null)),
        h("div.pagina-acciones", P.btn("Editar / límite", { tipo: "secundario", icono: "editar", onclick: abrirAfiliado }))));
      c.appendChild(h("div.grilla.grilla-4",
        P.cifra("Límite de descuento", P.f.pesos(disp.limite), disp.habilitado ? "Habilitado para descuento" : "No habilitado"),
        P.cifra("Consumido sin liquidar", P.f.pesos(disp.pendiente), d.pendiente_liquidar.cantidad + " compra(s) con descuento"),
        P.cifra("Disponible", h("span" + (disp.disponible <= 0 ? ".negativo" : ""), P.f.pesos(disp.disponible)), disp.disponible <= 0 ? "Tiene que pagar de otra forma" : "Para seguir consumiendo"),
        P.cifra("Consumos totales", P.f.pesos(d.consumos.reduce(function (s, x) { return s + x.total; }, 0)), d.consumos.map(function (x) { return (P.FORMAS[x.forma_pago] || x.forma_pago) + ": " + x.cantidad; }).join(" · ") || "Sin consumos")));

      // Estadías
      c.appendChild(h("div.hoja.hoja-cuerpo", { style: { marginTop: "16px" } }, h("h2.seccion-titulo", "Estadías"),
        d.estadias.length ? h("ul.lista-simple", d.estadias.map(function (e) {
          var ahora = Number(e.activo) && e.fecha_inicio <= hoy && e.fecha_fin >= hoy;
          return h("li", h("div", h("strong", (e.servicio || "Estadía") + (e.unidad ? " · " + e.unidad : "")), h("div.texto-3.chico", "Del " + P.f.fecha(e.fecha_inicio) + " al " + P.f.fecha(e.fecha_fin) + (e.personas ? " · " + e.personas + " persona(s)" : "") + (e.reserva_id ? " · Reserva T-" + e.reserva_id : ""))),
            Number(e.activo) ? P.chip(ahora ? "En curso" : e.estado || "Vigente", ahora ? "CONFIRMADA" : "DESPACHADA") : P.chip(e.estado || "Sin reserva", "VENCIDO"));
        })) : h("p.texto-3", "No tiene estadías registradas (afiliado cargado a mano o sin reservas en el predio).")));

      // Pago de consumos con descuento
      var pendiente = d.pendiente_liquidar;
      var zonaPago = h("div.hoja.hoja-cuerpo", { style: { marginTop: "16px" } });
      c.appendChild(zonaPago);
      if (!pendiente.cantidad) {
        zonaPago.appendChild(h("h2.seccion-titulo", "Pago de los consumos con descuento"));
        zonaPago.appendChild(h("p.texto-3", { style: { marginBottom: 0 } }, "No tiene consumos con descuento de haberes pendientes de liquidar."));
      } else {
        var forma = P.segmentado(FORMAS_LIQ, "DESCUENTO_HABERES", function () { actualizar(); });
        var pct = P.input({ inputmode: "decimal", valor: "0" });
        pct.style.textAlign = "right";
        var cuotas = P.select(Array.apply(null, { length: 12 }).map(function (_x, i) { return { valor: i + 1, texto: (i + 1) + (i ? " cuotas" : " cuota") }; }), 1);
        var pagada = P.check("Ya pagó", false, "Si paga ahora (efectivo, tarjeta, QR o transferencia).", function () { actualizar(); });
        var recibo = P.input({ max: 40, placeholder: "N° de recibo (opcional)" });
        var cajaSel = P.select([], "", { vacio: "No registrar en caja" });
        P.opciones("cajas").then(function (ops) { ops.forEach(function (o) { cajaSel.appendChild(h("option", { value: o.valor }, o.texto)); }); });
        var obs = P.input({ max: 250, placeholder: "Opcional" });
        var calculo = h("div.resumen-cuentas");
        var zonaPagada = h("div.grilla.grilla-2", P.campo("Recibo", recibo), P.campo("Cobro en efectivo en la caja", cajaSel));
        [pct].forEach(function (i) { i.addEventListener("input", actualizar); });
        cuotas.addEventListener("change", actualizar);
        function valores() {
          var p = Math.min(100, Math.max(0, P.numeroDe(pct.value) || 0));
          var total = P.redondear(pendiente.total * (1 - p / 100));
          var n = Number(cuotas.value) || 1;
          return { pct: p, total: total, cuotas: n, cuota: P.redondear(total / n) };
        }
        function actualizar() {
          var v = valores();
          var esHaberes = forma.valor() === "DESCUENTO_HABERES";
          pagada.hidden = esHaberes;
          if (esHaberes) pagada.input.checked = false;
          zonaPagada.hidden = esHaberes || !pagada.input.checked;
          P.reemplazar(calculo,
            h("div", h("span", "Consumido (" + pendiente.cantidad + " compras, " + P.f.fecha(pendiente.desde) + " al " + P.f.fecha(pendiente.hasta) + ")"), h("strong.dinero", P.f.pesos(pendiente.total))),
            v.pct ? h("div", h("span", "Descuento " + P.f.pct(v.pct)), h("strong.dinero", "− " + P.f.pesos(pendiente.total - v.total))) : null,
            h("div.fuerte", h("span", "Total a pagar"), h("span.dinero", P.f.pesos(v.total))),
            h("div.fuerte", h("span", v.cuotas + (v.cuotas === 1 ? " cuota de" : " cuotas de")), h("span.dinero", P.f.pesos(v.cuota))));
        }
        zonaPago.appendChild(h("div.fila-separada", h("h2.seccion-titulo", "Pago de los consumos con descuento"), P.chip(P.f.pesos(pendiente.total) + " pendientes", "PENDIENTE")));
        zonaPago.appendChild(h("p.texto-3", "Elegí cómo paga lo que consumió con descuento de haberes. Al generar, se imprime el comprobante para llevar a la sede de su departamental."));
        zonaPago.appendChild(h("div.grilla", { style: { gridTemplateColumns: "minmax(0,1.3fr) minmax(260px,1fr)", alignItems: "start" } },
          h("div.columna",
            P.campo("Forma de pago", forma),
            h("div.grilla.grilla-2", P.campo("Descuento (%)", pct, { ayuda: "Por ejemplo, por pagar en efectivo." }), P.campo("Cantidad de cuotas", cuotas)),
            pagada, zonaPagada, P.campo("Observaciones", obs)),
          h("div.columna", calculo,
            P.btn("Generar e imprimir", { tipo: "primario", grande: true, icono: "imprimir", onclick: function (ev) {
              var v = valores();
              P.ejecutar(ev.currentTarget, function () {
                return P.post("/afiliados/" + id + "/liquidaciones", {
                  forma_pago: forma.valor(), porcentaje_descuento: v.pct, cuotas: v.cuotas, pagada: pagada.input.checked,
                  recibo: recibo.value, caja_id: cajaSel.value || null, observaciones: obs.value,
                }).then(function (r) {
                  if (r.encolado) return;
                  P.aviso(r.mensaje, "ok");
                  return P.get("/liquidaciones/" + r.id).then(P.imprimirLiquidacion).then(function () { P.ruta.ir("/afiliados/" + id); });
                });
              }).catch(function () {});
            } }))));
        actualizar();
      }

      // Consumos y liquidaciones
      var vista = "consumos";
      var zonaTabla = h("div", { style: { marginTop: "12px" } });
      c.appendChild(h("div", { style: { marginTop: "22px" } }, P.segmentado([{ valor: "consumos", texto: "Consumos en el predio" }, { valor: "liquidaciones", texto: "Liquidaciones" }, { valor: "limites", texto: "Cambios de límite" }], vista, function (v) { vista = v; pintar(); })));
      c.appendChild(zonaTabla);
      function pintar() {
        var t;
        if (vista === "consumos") t = P.tabla({ listado: "afiliado_consumos", claveEstado: "consumos-" + id, filtrosFijos: { f_afiliado: id }, alClickFila: function (f) { P.verVenta(f.id); } });
        else if (vista === "liquidaciones") t = P.tabla({ listado: "liquidaciones", claveEstado: "liq-" + id, filtrosFijos: { f_afiliado: id }, columnasOcultas: ["afiliado", "dni", "legajo", "departamental"], acciones: accionesLiquidacion });
        else t = P.tabla({ listado: "limites", claveEstado: "lim-" + id, filtrosFijos: { f_afiliado: id }, columnasOcultas: ["afiliado"] });
        P.reemplazar(zonaTabla, t.el);
      }
      pintar();
    });
  }, { admin: true, titulo: "Afiliado" });
})();
