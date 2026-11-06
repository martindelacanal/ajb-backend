/* Historial privado del usuario, conservado en la base del predio y sincronizado. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  P.ruta.registrar(/^\/notificaciones$/, function (c) {
    var pagina = 1;
    var estado = "todos";
    var pedido = 0;
    var cerrado = false;
    P.alSalir(function () { cerrado = true; });
    var listado = h("div.hoja");
    var filtro = P.select([
      { valor: "todos", texto: "Todas" },
      { valor: "no_leidos", texto: "Sin leer" },
      { valor: "leidos", texto: "Leídas" },
    ], estado, { alCambiar: function (valor) { estado = valor; pagina = 1; cargar().catch(P.error); } });
    c.appendChild(P.cabeceraConAcciones("Historial de notificaciones", "Tus notificaciones, incluidas las leídas y las resueltas. Los horarios corresponden a Argentina.",
      P.btn("Actualizar", { tipo: "secundario", icono: "refrescar", onclick: function (ev) { P.ejecutar(ev.currentTarget, cargar); } })));
    c.appendChild(h("div.fila.notificaciones-filtros", P.campo("Estado", filtro)));
    c.appendChild(listado);

    function cargar() {
      var actual = ++pedido;
      listado.setAttribute("aria-busy", "true");
      return P.get("/avisos/historial" + P.qs({ pagina: pagina, tam: 20, estado: estado })).then(function (datos) {
        if (cerrado || actual !== pedido) return;
        pagina = datos.pagina;
        P.reemplazar(listado,
          datos.filas.length ? h("ul.notificaciones-lista", datos.filas.map(function (n) {
            var estadoTexto = n.resuelto_fecha ? "Resuelta" : n.leido ? "Leída" : "Sin leer";
            return h("li.notificacion-fila", h("div.notificacion-texto",
              h("h2", n.titulo), h("p.chico.texto-3", P.f.fechaHora(n.fecha) + " · " + estadoTexto),
              h("p", n.mensaje)),
              P.btn("Ver detalle", { tipo: "secundario", onclick: function () { P.verNotificacion(n, function () { cargar().catch(P.error); }); } }));
          })) : P.vacio("campana", estado === "todos" ? "Todavía no tenés notificaciones" : "No hay notificaciones con este estado", ""),
          h("div.fila-separada.notificaciones-pie",
            h("span.chico.texto-3", datos.total + " notificación(es)"),
            h("div.fila", { "aria-label": "Paginación del historial" },
              P.btn("Anterior", { tipo: "texto", deshabilitado: pagina <= 1, onclick: function () { pagina--; cargar().catch(P.error); } }),
              h("span.chico", "Página " + pagina + " de " + datos.paginas),
              P.btn("Siguiente", { tipo: "texto", deshabilitado: pagina >= datos.paginas, onclick: function () { pagina++; cargar().catch(P.error); } }))));
        listado.setAttribute("aria-busy", "false");
      }).catch(function (e) {
        if (!cerrado && actual === pedido) {
          listado.setAttribute("aria-busy", "false");
          P.reemplazar(listado, P.mensaje(e.message, "error"), P.btn("Reintentar", { onclick: function () { cargar().catch(P.error); } }));
        }
        throw e;
      });
    }
    return cargar();
  }, { titulo: "Notificaciones" });
})();
