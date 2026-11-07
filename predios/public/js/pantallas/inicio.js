/* Inicio del administrador: el día en el predio de un vistazo. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  P.saludo = function () {
    var hora = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
    if (hora >= 19 || hora < 4) return "Buenas noches";
    if (hora < 12) return "Buenos días";
    return "Buenas tardes";
  };

  P.ruta.registrar(/^\/inicio$/, function (c) {
    var ses = P.estado.sesion;
    var nombre = String(ses.usuario.nombre || "").replace(" (sistema general)", "").split(" ")[0];
    c.appendChild(h("div.pagina-cabecera", h("h1.titulo-pagina", P.saludo() + ", " + nombre)));
    var cifras = h("div.grilla.inicio-cifras");
    var cuerpo = h("div.grilla.inicio-cuerpo");
    c.appendChild(cifras);
    c.appendChild(cuerpo);
    cifras.appendChild(P.cargando());

    function cargar() {
      return Promise.all([P.get("/inicio"), P.get("/caja/panel"), P.get("/avisos")]).then(function (r) {
        var d = r[0], panel = r[1], avisos = r[2];
        P.reemplazar(cifras,
          P.cifra("Ventas de hoy", P.f.entero(d.hoy.ventas)),
          P.cifra("Vendido hoy", P.f.pesos(d.hoy.total)),
          P.cifra("Efectivo en cajas", P.f.pesos(d.efectivo_en_cajas)),
          P.cifra("Afiliados en el predio", P.f.entero(d.afiliados_en_predio)));
        var porBoca = h("section.hoja.hoja-cuerpo", h("h2.seccion-titulo", "Ventas de hoy por boca"),
          P.barrasH(d.hoy.por_boca.map(function (b) { return { etiqueta: b.boca + " (" + b.ventas + ")", valor: b.total }; }), { formato: P.f.pesos }));
        var ultimas = h("section.hoja.hoja-cuerpo", h("h2.seccion-titulo", "Últimas ventas"),
            d.ultimas_ventas.length ? h("ul.lista-simple", d.ultimas_ventas.map(function (v) {
              return h("li", h("div", h("strong", "N° " + v.id + " · " + v.boca), h("div.texto-3.chico", P.f.fechaHora(v.fecha) + " · " + (P.FORMAS[v.forma_pago] || v.forma_pago) + (v.afiliado_nombre ? " · " + v.afiliado_nombre : ""))),
                h("strong.dinero", P.f.pesos(v.total)));
            })) : h("p.texto-3", "Todavía no hay ventas."));
        var pendientes = [];
        (avisos.permisos || []).forEach(function (p) {
          pendientes.push(h("li", h("div", h("strong", p.usuario_nombre), h("div.texto-3.chico", ({ SOLICITUD_PRODUCTO: "Pide permiso para pedir productos", ANULAR_VENTA: "Pide anular la venta N° " + p.referencia_id, VER_VENTAS_CAJA: "Pide ver las ventas de la caja" })[p.tipo] + (p.boca ? " · " + p.boca : "") + (p.detalle ? " · " + p.detalle : ""))),
            h("div.fila", { style: { gap: "6px", flexWrap: "nowrap" } },
              P.btn("Rechazar", { tipo: "peligro", chico: true, onclick: function (ev) { resolver(ev.currentTarget, p, false); } }),
              P.btn(p.tipo === "ANULAR_VENTA" ? "Ver venta" : "Aprobar", { tipo: "ok", chico: true, icono: "check", onclick: function (ev) {
                if (p.tipo === "ANULAR_VENTA") P.verVenta(p.referencia_id, cargar);
                else resolver(ev.currentTarget, p, true);
              } }))));
        });
        (avisos.aperturas || []).forEach(function (a) {
          pendientes.push(h("li", h("div", h("strong", a.boca + " · " + a.caja), h("div.texto-3.chico", "El saldo de apertura (" + P.f.pesos(a.importe) + ") no coincide" + (a.observacion ? ": " + a.observacion : ""))),
            P.btn("Revisar", { tipo: "secundario", chico: true, onclick: function () { P.ruta.ir("/caja"); } })));
        });
        if (avisos.solicitudes_despachar || avisos.solicitudes_recibir) {
          pendientes.push(h("li", h("div", h("strong", "Solicitudes entre bocas"), h("div.texto-3.chico", avisos.solicitudes_despachar + " para despachar · " + avisos.solicitudes_recibir + " en camino")),
            P.btn("Ver", { tipo: "secundario", chico: true, onclick: function () { P.ruta.ir("/gestion/solicitudes"); } })));
        }
        if (avisos.vencimientos) {
          pendientes.push(h("li", h("div", h("strong", "Vencimientos"), h("div.texto-3.chico", avisos.vencimientos + " producto(s) vencidos o dentro del plazo de aviso")),
            P.btn("Ver", { tipo: "secundario", chico: true, onclick: function () { P.cache["tabla:productos"] = { filtros: { vencimiento: "aviso" } }; P.ruta.ir("/gestion/productos"); } })));
        }
        P.reemplazar(cuerpo, porBoca,
          h("section.hoja.hoja-cuerpo", h("h2.seccion-titulo", "Para resolver"),
            pendientes.length ? h("ul.lista-simple", pendientes) : h("p.texto-3", { style: { marginBottom: 0 } }, "Nada pendiente por ahora.")),
          ultimas, h("section.hoja.hoja-cuerpo", h("h2.seccion-titulo", "Cajas"),
            panel.cajas.length ? h("ul.lista-simple.inicio-cajas", panel.cajas.map(function (cj) {
              var ap = cj.apertura;
              return h("li", h("div",
                h("strong", cj.boca + " · " + cj.nombre),
                h("div.texto-3.chico", cj.turno ? "Atiende " + cj.turno.usuario_nombre : "Sin turno abierto")),
                h("div", { style: { textAlign: "right" } }, h("strong.dinero", P.f.pesos(cj.saldo)), h("div", { style: { marginTop: "4px" } },
                  !ap ? P.chip("Sin saldo de apertura", "VENCIDO") : ap.verificacion === "CORRECTO" ? P.chip("Apertura confirmada", "CORRECTO") : ap.verificacion === "NO_COINCIDE" ? P.chip("Apertura no coincide", "NO_COINCIDE") : P.chip("Apertura sin confirmar", "PENDIENTE"))));
            })) : h("p.texto-3", "No hay cajas. Crealas en Gestión > Bocas y cajas.")));
      });
    }
    function resolver(b, p, aprobar) {
      P.ejecutar(b, function () {
        return P.post("/permisos/" + p.id + "/resolver", { aprobar: aprobar }).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); cargar(); });
      }).catch(function () {});
    }
    P.intervalo(function () { cargar().catch(function () {}); }, 15000);
    return cargar();
  }, { admin: true, titulo: "Inicio" });
})();
