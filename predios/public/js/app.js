/* Arranque y marco de la aplicación: menú del administrador, cabecera de caja, rutas y avisos. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;
  var app = document.getElementById("app");
  var limpiezas = [];
  var temporizadores = [];
  var pagina = null;
  var ultimoPermisoVisto = 0;
  var ultimoAvisoVisto = 0;

  P.alSalir = function (fn) { limpiezas.push(fn); };
  P.intervalo = function (fn, ms) { var t = setInterval(fn, ms); limpiezas.push(function () { clearInterval(t); }); return t; };

  // ------------------------------------------------------------------ navegación
  function itemsAdmin() {
    var items = [
      { ruta: "/inicio", texto: "Inicio", icono: "inicio" },
      P.modo === "local" ? { ruta: "/vender", texto: "Vender", icono: "vender" } : null,
      { ruta: "/caja", texto: "Caja", icono: "caja" },
      { ruta: "/compras", texto: "Compras", icono: "compras" },
      { ruta: "/gestion", texto: "Gestión", icono: "gestion" },
      { ruta: "/usuarios", texto: "Usuarios", icono: "usuarios" },
      { ruta: "/estadisticas", texto: "Estadísticas", icono: "estadisticas" },
      { ruta: "/sistema", texto: "Sistema", icono: "sistema" },
    ];
    return items.filter(Boolean);
  }
  function itemsCajero() {
    var puesto = P.puesto() || {};
    var ses = P.estado.sesion;
    var almacen = (ses.puestos || []).some(function (p) { return p.es_almacen; });
    return [
      puesto.caja_id ? { ruta: "/vender", texto: "Vender", icono: "vender" } : null,
      { ruta: "/solicitudes", texto: "Solicitudes", icono: "solicitud", contador: "solicitudes" },
      { ruta: "/stock", texto: "Stock", icono: "stock" },
      puesto.caja_id ? { ruta: "/mi-caja", texto: "Caja", icono: "caja" } : null,
      almacen ? { ruta: "/compras", texto: "Compras", icono: "compras" } : null,
    ].filter(Boolean);
  }

  function activo(ruta) {
    var actual = P.ruta.actual();
    if (actual === "/mis-ventas" || actual === "/mi-caja") return ruta === (P.esAdmin() ? "/caja" : "/mi-caja");
    return actual === ruta || actual.indexOf(ruta + "/") === 0 || (ruta === "/gestion" && /^\/(afiliados|productos)/.test(actual));
  }

  function chipConexion() {
    return h("span.conexion#conexion", h("i"), h("span", "…"));
  }
  function actualizarConexion() {
    var el = document.getElementById("conexion");
    if (!el) return;
    var c = P.estado.conexion;
    el.classList.remove("en-linea", "sin-linea");
    var texto;
    if (P.modo === "remoto") {
      var r = P.estado.remoto || {};
      el.classList.add(r.en_linea ? "en-linea" : "sin-linea");
      texto = r.escritor === "CENTRAL" ? "Camping sin instalar" : r.en_linea ? "Camping conectado" : "Camping sin conexión";
    } else if (!c || !c.vinculado) { texto = "Red local"; }
    else {
      el.classList.add(c.en_linea ? "en-linea" : "sin-linea");
      texto = c.en_linea ? "Sincronizado" : "Sin internet";
    }
    el.lastChild.textContent = texto;
    el.title = P.modo === "remoto" ? "Último contacto del camping: " + P.f.relativo((P.estado.remoto || {}).ultima_conexion)
      : c && c.vinculado ? (c.en_linea ? "Conectado al sistema general" : "Sin conexión con el sistema general: todo queda guardado y se sube solo cuando vuelve internet") : "Sin vincular al sistema general";
  }

  function menuUsuario(boton) {
    var ses = P.estado.sesion;
    var items = [];
    if (P.modo === "local") {
      items.push({ texto: P.esAdmin() ? "Trabajar en una caja" : "Cambiar de boca o caja", icono: "caja", accion: function () { P.ruta.ir("/puesto"); } });
      if (P.esAdmin() && P.puesto() && P.puesto().caja_id) items.push({ texto: "Salir de caja y volver a administración", icono: "salir", accion: function () { P.salirDeCaja().catch(P.error); } });
      if (P.puesto() && P.puesto().caja_id) items.push({ texto: "Ver saldo de apertura", icono: "efectivo", accion: function () { P.verificarApertura(true); } });
      if (!ses.usuario.es_admin_general) items.push({ texto: "Cambiar mi contraseña", icono: "candado", accion: cambiarClave });
      items.push("-");
      items.push({ texto: "Cerrar sesión", icono: "salir", accion: salir });
    } else {
      items.push({ texto: "Actualizar datos", icono: "refrescar", accion: function () { P.ruta.ir(P.ruta.actual()); } });
    }
    P.menuFlotante(boton, items);
  }

  function cambiarClave() {
    var actual = P.inputClave({ autocomplete: "current-password" });
    var nueva = P.inputClave();
    var repetir = P.inputClave();
    var m = P.modal({
      titulo: "Cambiar mi contraseña",
      contenido: h("div.columna", P.campo("Contraseña actual", actual), P.campo("Contraseña nueva", nueva, { ayuda: "Al menos 4 caracteres" }), P.campo("Repetí la nueva", repetir)),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", onclick: function (ev) {
        if (nueva.input.value !== repetir.input.value) { P.aviso("Las contraseñas nuevas no coinciden", "error"); return; }
        P.ejecutar(ev.currentTarget, function () {
          return P.post("/sesion/clave", { actual: actual.input.value, nueva: nueva.input.value }).then(function (r) { P.aviso(r.mensaje, "ok"); m.cerrar(); });
        });
      } })],
    });
  }

  function salir() {
    P.post("/logout", {}, { sinRedireccion: true }).catch(function () {}).then(function () {
      P.sesion.borrar();
      P.estado.sesion = null;
      if (typeof P.notificarCierreRemoto === "function") P.notificarCierreRemoto();
      location.hash = "";
      iniciar();
    });
  }

  function botonUsuario(oscuro) {
    var ses = P.estado.sesion;
    var b = h("button.usuario-boton", { type: "button", "aria-haspopup": "menu" },
      h("span.avatar", P.iniciales(ses.usuario.nombre)),
      h("span.usuario-nombre", ses.usuario.nombre.replace(" (sistema general)", ""), h("small", ses.usuario.rol === "ADMIN" ? (ses.usuario.es_admin_general ? "Administración general" : "Administración") : "Usuario de boca")));
    b.addEventListener("click", function () { menuUsuario(b); });
    return b;
  }

  function campana() {
    var b = h("button.btn.btn-texto.btn-icono.campana#campana", { type: "button", "aria-label": "Avisos" }, P.icono("campana"));
    b.addEventListener("click", function () { panelAvisos(b); });
    return b;
  }

  function panelAvisos(ancla) {
    var a = P.estado.avisos || {};
    var items = [];
    (a.recientes || a.notificaciones || []).slice(0, 10).forEach(function (n) {
      items.push({ texto: h("span.aviso-resumen" + (!n.leido && !n.resuelto_fecha ? ".aviso-no-leido" : ""),
        h("strong", n.titulo), h("span.chico.texto-3", P.f.fechaHora(n.fecha) + " · " + (n.resuelto_fecha ? "Resuelta" : n.leido ? "Leída" : "Sin leer"))),
        icono: n.leido || n.resuelto_fecha ? "check" : "alerta", accion: function () { verNotificacion(n); } });
    });
    if (items.length) items.push("-");
    (a.permisos || []).forEach(function (p) {
      items.push({ texto: p.usuario_nombre + " pide autorización (" + (p.boca || "") + ")", icono: "llave", accion: function () { P.resolverPermiso(p); } });
    });
    (a.aperturas || []).forEach(function (x) {
      items.push({ texto: x.boca + " · " + x.caja + ": el saldo de apertura no coincide", icono: "alerta", accion: function () { P.ruta.ir("/caja"); } });
    });
    if (a.solicitudes_despachar) items.push({ texto: a.solicitudes_despachar + " solicitud(es) para despachar", icono: "despachar", accion: function () { P.ruta.ir(P.esAdmin() ? "/gestion/solicitudes" : "/solicitudes"); } });
    if (a.solicitudes_recibir) items.push({ texto: a.solicitudes_recibir + " solicitud(es) para recibir", icono: "recibir", accion: function () { P.ruta.ir(P.esAdmin() ? "/gestion/solicitudes" : "/solicitudes"); } });
    if (a.vencimientos) items.push({ texto: a.vencimientos + " producto(s) vencidos o por vencer", icono: "reloj", accion: function () { P.cache["tabla:productos"] = { filtros: { vencimiento: "7" } }; P.ruta.ir("/gestion/productos"); } });
    if (a.stock_negativo) items.push({ texto: a.stock_negativo + " producto(s) con stock negativo en alguna boca", icono: "alerta", accion: function () { P.cache["tabla:stock"] = { filtros: { estado: "negativo" } }; P.ruta.ir("/gestion/stock"); } });
    if (items[items.length - 1] === "-") items.pop();
    if (!items.length) items.push({ texto: "Todavía no hay notificaciones", icono: "check", accion: function () {} });
    items.push({ texto: "Ver historial de notificaciones", icono: "lista", accion: function () { P.ruta.ir("/notificaciones"); } });
    var desplegable = P.menuFlotante(ancla, items);
    var menu = document.querySelector(".menu-flotante");
    if (menu) {
      menu.classList.add("menu-avisos");
      menu.lastElementChild.classList.add("menu-avisos-historial");
      menu.setAttribute("aria-label", "Notificaciones recientes y avisos pendientes");
      var r = ancla.getBoundingClientRect();
      menu.style.left = Math.max(12, Math.min(window.innerWidth - menu.offsetWidth - 12, r.right - menu.offsetWidth)) + "px";
      menu.style.top = (Math.max(12, Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 12)) + window.scrollY) + "px";
      menu.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") { ev.preventDefault(); desplegable.cerrar(); ancla.focus(); }
      });
      var primero = menu.querySelector("button");
      if (primero) primero.focus();
    }
  }

  function verNotificacion(n, alLeer) {
    var d = n.detalle || {};
    var m = P.modal({
      titulo: n.titulo, subtitulo: P.f.fechaHora(n.fecha) + " · Hora de Argentina",
      contenido: h("div.columna", h("p", n.mensaje),
        d.intentos_recientes && d.intentos_recientes.length ? h("div.columna",
          h("strong", "Intentos registrados"),
          d.intentos_recientes.map(function (x) {
            return h("p.chico", P.f.fechaHora(x.fecha) + " · " + (x.boca || "Sin boca registrada") + (x.caja ? " · " + x.caja : "") + " · IP " + (x.ip || "sin datos"));
          })) : null,
        d.origen_puesto ? h("p.texto-3.chico", d.origen_puesto + (d.puesto_registrado_en ? ": " + P.f.fechaHora(d.puesto_registrado_en) : "") + ". Esta referencia identifica el último puesto usado; no confirma quién intentó ingresar.") : null,
        d.agente ? h("p.texto-3.chico", "Navegador: " + d.agente) : null),
      acciones: [
        P.btn("Cerrar", { onclick: function () { m.cerrar(); } }),
        !n.leido ? P.btn("Marcar como leída", { tipo: "primario", onclick: function (ev) {
          P.ejecutar(ev.currentTarget, function () {
            return P.post("/avisos/" + n.id + "/leer", {}).then(function (r) {
              m.cerrar();
              if (!r.encolado) {
                consultarAvisos();
                if (alLeer) alLeer();
              }
            });
          });
        } }) : null,
      ],
    });
  }
  P.verNotificacion = verNotificacion;

  P.resolverPermiso = function (p) {
    var tipos = { SOLICITUD_PRODUCTO: "pedir productos", ANULAR_VENTA: "anular una venta", VER_VENTAS_CAJA: "ver todas las ventas de su caja" };
    var m = P.modal({
      titulo: "Autorización pedida",
      subtitulo: p.usuario_nombre + (p.boca ? " · " + p.boca : "") + (p.caja ? " · " + p.caja : ""),
      contenido: h("div.columna", h("p", { style: { margin: 0 } }, "Pide permiso para ", h("strong", tipos[p.tipo] || p.tipo), "."), p.detalle ? P.mensaje(p.detalle) : null,
        h("p.texto-3.chico", "Pedido " + P.f.relativo(p.fecha_solicitud) + ".")),
      acciones: [
        P.btn("Rechazar", { tipo: "peligro", onclick: function (ev) { resolver(ev.currentTarget, false); } }),
        P.btn("Aprobar", { tipo: "ok", icono: "check", onclick: function (ev) { resolver(ev.currentTarget, true); } }),
      ],
    });
    function resolver(b, aprobar) {
      P.ejecutar(b, function () {
        return P.post("/permisos/" + p.id + "/resolver", { aprobar: aprobar }).then(function (r) {
          if (!r.encolado) P.aviso(r.mensaje, "ok");
          m.cerrar();
          consultarAvisos();
        });
      });
    }
  };

  function contadorNav(clave) {
    var a = P.estado.avisos || {};
    if (clave === "inicio") return (a.permisos || []).length + (a.aperturas || []).length;
    if (clave === "solicitudes") return (a.solicitudes_despachar || 0) + (a.solicitudes_recibir || 0);
    return 0;
  }

  function pintarContadores() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-contador]"), function (el) {
      var n = contadorNav(el.getAttribute("data-contador"));
      el.textContent = n > 99 ? "99+" : String(n);
      el.hidden = !n;
    });
    var c = document.getElementById("campana");
    if (c) {
      var viejo = c.querySelector(".campana-numero");
      if (viejo) viejo.remove();
      var a = P.estado.avisos || {};
      var total = (typeof a.notificaciones_no_leidas === "number" ? a.notificaciones_no_leidas : (a.notificaciones || []).length) + (a.permisos || []).length + (a.aperturas || []).length + (a.solicitudes_despachar || 0) + (a.solicitudes_recibir || 0);
      if (total) c.appendChild(h("span.campana-numero", total > 99 ? "99+" : String(total)));
    }
  }

  function consultarAvisos() {
    if (!P.estado.sesion) return;
    return P.get("/avisos", { sinRedireccion: true }).then(function (a) {
      var antes = P.estado.avisos;
      P.estado.avisos = a;
      pintarContadores();
      if (a.notificaciones && a.notificaciones.length) {
        var aviso = a.notificaciones[0];
        if (aviso.id > ultimoAvisoVisto) {
          P.aviso(aviso.titulo + ". Tocá la campana para ver el detalle.", "cola", 10000);
          ultimoAvisoVisto = aviso.id;
        }
      }
      if (P.esAdmin() && a.permisos && a.permisos.length) {
        var max = Math.max.apply(null, a.permisos.map(function (p) { return p.id; }));
        if (antes && max > ultimoPermisoVisto) {
          var p = a.permisos.filter(function (x) { return x.id === max; })[0];
          P.aviso(p.usuario_nombre + " pide autorización. Tocá la campana para responder.", "cola", 8000);
        }
        ultimoPermisoVisto = Math.max(ultimoPermisoVisto, max);
      }
      if (P.alAvisos) P.alAvisos(a);
    }).catch(function () {});
  }
  P.consultarAvisos = consultarAvisos;

  function consultarConexion() {
    if (P.modo === "remoto") {
      return P.get("/estado-remoto", { sinRedireccion: true }).then(function (r) { P.estado.remoto = r; actualizarConexion(); pintarBandaRemota(); }).catch(function () {});
    }
    return P.get("/estado-publico", { sinRedireccion: true }).then(function (r) { P.estado.conexion = r; actualizarConexion(); }).catch(function () {
      P.estado.conexion = null;
      var el = document.getElementById("conexion");
      if (el) { el.classList.remove("en-linea"); el.classList.add("sin-linea"); el.lastChild.textContent = "Sin servidor"; }
    });
  }

  function pintarBandaRemota() {
    var banda = document.getElementById("banda-remota");
    if (!banda) return;
    var r = P.estado.remoto || {};
    var estado = r.escritor === "CENTRAL"
      ? "Todavía no hay notebook instalada en el camping: los cambios se guardan directo en el sistema general."
      : r.en_linea ? "El camping está conectado: los cambios se aplican allá en segundos."
        : "El camping está sin conexión (último contacto " + P.f.relativo(r.ultima_conexion) + "). Lo que ves es lo último que subió; los cambios quedan en cola.";
    P.reemplazar(banda, P.icono("nube"), h("span", h("strong", "Vista remota de " + (r.nombre || "el predio") + ". "), estado),
      r.cambios_en_cola ? h("span.chip.chip-accion", r.cambios_en_cola + " cambio(s) en cola") : null);
  }

  // ------------------------------------------------------------------ marco
  function marcoAdmin() {
    var ses = P.estado.sesion;
    var riel = h("nav.riel#riel", { "aria-label": "Menú principal" },
      h("a.riel-marca", { href: "#/inicio" }, h("img", { src: "img/logo-blanco-isotipo.png", alt: "" }), h("span", h("strong", ses.predio.nombre || "Predio"), h("span", "Sistema del predio · AJB"))),
      h("div.nav", itemsAdmin().map(function (it) {
        var contador = it.ruta === "/inicio" ? h("span.nav-contador", { "data-contador": "inicio", hidden: true }) : null;
        return h("a.nav-item", { href: "#" + it.ruta, "data-ruta": it.ruta, onclick: function () { cerrarMenu(); } }, P.icono(it.icono), it.texto, contador);
      })),
      h("div.riel-pie", P.modo === "remoto" ? "Abierto desde Mi AJB" : "Funciona en la red del camping"));
    // En el celular el menú es un cajón: se cierra tocando afuera, arrastrándolo a la izquierda o con Escape.
    var veloMenu = h("div.riel-velo", { "aria-hidden": "true", onclick: function () { cerrarMenu(); } });
    function abrirMenu() { riel.classList.add("abierto"); veloMenu.classList.add("abierto"); botonMenu.setAttribute("aria-expanded", "true"); }
    function cerrarMenu() {
      riel.classList.remove("abierto");
      veloMenu.classList.remove("abierto");
      riel.style.transform = "";
      veloMenu.style.opacity = "";
      botonMenu.setAttribute("aria-expanded", "false");
    }
    var toque = null;
    riel.addEventListener("touchstart", function (ev) {
      if (!riel.classList.contains("abierto") || ev.touches.length !== 1) return;
      toque = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, dx: 0, horizontal: null };
    }, { passive: true });
    riel.addEventListener("touchmove", function (ev) {
      if (!toque) return;
      var dx = ev.touches[0].clientX - toque.x;
      var dy = ev.touches[0].clientY - toque.y;
      if (toque.horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        toque.horizontal = Math.abs(dx) > Math.abs(dy);
        if (toque.horizontal) riel.classList.add("arrastrando");
      }
      if (!toque.horizontal) return;
      toque.dx = Math.min(0, dx);
      riel.style.transform = "translateX(" + toque.dx + "px)";
      veloMenu.style.opacity = String(Math.max(0, 1 + toque.dx / (riel.offsetWidth || 280)));
    }, { passive: true });
    function soltar() {
      if (!toque) return;
      var dx = toque.dx;
      toque = null;
      riel.classList.remove("arrastrando");
      if (dx < -60) cerrarMenu();
      else { riel.style.transform = ""; veloMenu.style.opacity = ""; }
    }
    riel.addEventListener("touchend", soltar);
    riel.addEventListener("touchcancel", soltar);
    var botonMenu = P.btn("", { tipo: "texto", icono: "menu", etiqueta: "Menú", onclick: function () {
      if (riel.classList.contains("abierto")) cerrarMenu(); else abrirMenu();
    } });
    botonMenu.classList.add("barra-menu");
    botonMenu.setAttribute("aria-controls", "riel");
    botonMenu.setAttribute("aria-expanded", "false");
    P.cerrarMenu = cerrarMenu;
    var puesto = P.puesto();
    pagina = h("div#pagina");
    return h("div.estructura", riel, veloMenu, h("div.contenido",
      P.modo === "remoto" ? h("div.remoto#banda-remota") : null,
      h("header.barra", botonMenu,
        puesto && puesto.caja_id ? h("span.puesto-chip", P.icono("caja"), h("span", puesto.boca + " · " + puesto.caja)) : null,
        h("div.espacio"), chipConexion(), campana(), botonUsuario()),
      pagina));
  }

  function marcoCajero() {
    var ses = P.estado.sesion;
    var puesto = P.puesto() || {};
    pagina = h("div#pagina");
    return h("div",
      h("header.cabecera-caja",
        h("a.riel-marca", { href: "#/vender" }, h("img", { src: "img/logo-blanco-isotipo.png", alt: "" }), h("span", h("strong", ses.predio.nombre || "Predio"))),
        h("nav.pestanas-caja", { "aria-label": "Secciones" }, itemsCajero().map(function (it) {
          return h("a.pestana", { href: "#" + it.ruta, "data-ruta": it.ruta }, P.icono(it.icono), it.texto,
            it.contador ? h("span.nav-contador", { "data-contador": it.contador, hidden: true }) : null);
        })),
        h("div.espacio"),
        puesto.boca ? h("span.puesto-chip", h("span", puesto.boca + (puesto.caja ? " · " + puesto.caja : "")), P.btn("Cambiar", { tipo: "texto", chico: true, onclick: function () { P.ruta.ir("/puesto"); } })) : null,
        chipConexion(), campana(), botonUsuario()),
      pagina);
  }

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && P.cerrarMenu && document.querySelector(".riel.abierto") && !P.hayVentana()) P.cerrarMenu();
  });

  P.repintarMarco = function () {
    var ses = P.estado.sesion;
    if (!ses) return;
    P.reemplazar(app, ses.usuario.rol === "ADMIN" ? marcoAdmin() : marcoCajero());
    actualizarConexion();
    pintarContadores();
    if (P.modo === "remoto") pintarBandaRemota();
  };

  // ------------------------------------------------------------------ rutas
  function marcarActivo() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-ruta]"), function (el) {
      if (activo(el.getAttribute("data-ruta"))) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    });
  }

  function navegar() {
    if (!P.estado.sesion) return;
    limpiezas.splice(0).forEach(function (fn) { try { fn(); } catch (e) { /* nada */ } });
    var ruta = P.ruta.actual();
    if (ruta === "/" || ruta === "") {
      P.ruta.ir(P.esAdmin() ? "/inicio" : (P.puesto() && P.puesto().caja_id ? "/vender" : P.puesto() ? "/solicitudes" : "/puesto"));
      return;
    }
    var encontrada = null;
    var params = null;
    for (var i = 0; i < P.rutas.length; i++) {
      var m = P.rutas[i].patron.exec(ruta);
      if (m) { encontrada = P.rutas[i]; params = m.slice(1); break; }
    }
    if (!pagina || !document.body.contains(pagina)) P.repintarMarco();
    var nueva = h("div.pagina");
    P.reemplazar(pagina, nueva);
    marcarActivo();
    window.scrollTo(0, 0);
    if (!encontrada) {
      nueva.appendChild(P.vacio("info", "No encontramos esa pantalla", "", P.btn("Ir al inicio", { tipo: "primario", onclick: function () { P.ruta.ir("/"); } })));
      return;
    }
    if (encontrada.admin && !P.esAdmin()) {
      nueva.appendChild(P.vacio("candado", "Esta sección es del administrador", ""));
      return;
    }
    if (encontrada.local && P.modo !== "local") {
      nueva.appendChild(P.vacio("info", "Esta pantalla se usa en las PCs del camping", "Desde el sistema general podés ver las ventas en Estadísticas o en Caja."));
      return;
    }
    if (encontrada.titulo) document.title = encontrada.titulo + " · " + ((P.estado.sesion.predio || {}).nombre || "Predio");
    try {
      var r = encontrada.pantalla(nueva, params, P.ruta.query());
      if (r && r.catch) r.catch(function (e) { P.reemplazar(nueva, P.mensaje(e.message, "error")); });
    } catch (e) {
      P.reemplazar(nueva, P.mensaje("No se pudo mostrar la pantalla: " + e.message, "error"));
      if (window.console) console.error(e);
    }
  }
  window.addEventListener("hashchange", navegar);
  P.ruta.registrar(/^\/puesto$/, function (c) { P.pantallaPuesto(c); }, { titulo: "Elegir caja", local: true });

  // ------------------------------------------------------------------ sesión
  P.sesionVencida = function (mensaje) {
    if (!P.estado.sesion) return;
    P.sesion.borrar();
    P.estado.sesion = null;
    if (P.modo === "remoto") {
      P.reemplazar(app, h("div.pagina", P.vacio("candado", "La sesión remota terminó", mensaje || "Volvé a abrir el predio desde Mi AJB > Predios.")));
      return;
    }
    P.aviso(mensaje || "Tu sesión terminó. Volvé a ingresar.", "error");
    iniciar();
  };

  P.alIngresar = function (r) {
    P.estado.avisos = null;
    ultimoAvisoVisto = 0;
    P.estado.sesion = r;
    P.equipo.recordarPuesto(r.puesto);
    var ses = r;
    if (ses.usuario.rol !== "ADMIN" && !ses.puesto) {
      var puestos = ses.puestos || [];
      if (puestos.length === 1 && puestos[0].cajas.length <= 1) {
        return P.elegirPuesto(puestos[0].boca_id, puestos[0].cajas[0] ? puestos[0].cajas[0].caja_id : null).then(function () {
          arrancarMarco();
          if (P.puesto().caja_id) { P.ruta.ir("/vender"); setTimeout(function () { P.verificarApertura(false); }, 400); }
          else P.ruta.ir("/solicitudes");
        }).catch(function (e) { P.error(e); arrancarMarco(); P.ruta.ir("/puesto"); });
      }
      arrancarMarco();
      P.ruta.ir("/puesto");
      return;
    }
    arrancarMarco();
    if (!location.hash || location.hash === "#" || location.hash === "#/") P.ruta.ir(ses.usuario.rol === "ADMIN" ? "/inicio" : "/vender");
    else navegar();
  };

  function arrancarMarco() {
    temporizadores.forEach(clearInterval);
    temporizadores = [];
    P.repintarMarco();
    consultarAvisos();
    consultarConexion();
    temporizadores.push(setInterval(consultarAvisos, 10000));
    temporizadores.push(setInterval(consultarConexion, P.modo === "remoto" ? 10000 : 20000));
  }

  function iniciar() {
    temporizadores.forEach(clearInterval);
    temporizadores = [];
    P.reemplazar(app, P.cargando("Abriendo el sistema del predio…"));
    if (P.modo === "remoto") {
      if (!P.sesion.token()) {
        P.reemplazar(app, h("div.pagina", P.vacio("candado", "Abrí el predio desde Mi AJB", "Entrá a Mi AJB > Predios y tocá «Abrir el panel del predio».")));
        return;
      }
      P.get("/sesion").then(function (r) {
        P.estado.remoto = r.remoto;
        P.alIngresar(r);
      }).catch(function (e) { if (e.status !== 401) P.reemplazar(app, h("div.pagina", P.mensaje(e.message, "error"))); });
      return;
    }
    P.get("/estado-publico", { sinRedireccion: true }).then(function (estado) {
      P.estado.conexion = estado;
      document.title = (estado.nombre || "Predio") + " · AJB";
      if (!P.sesion.token()) { P.pantallaIngreso(app, estado); return; }
      return P.get("/sesion", { sinRedireccion: true }).then(function (r) { P.alIngresar(r); }).catch(function () {
        P.sesion.borrar();
        P.pantallaIngreso(app, estado);
      });
    }).catch(function (e) {
      P.reemplazar(app, h("div.pagina", P.vacio("alerta", "No se puede conectar con el servidor del camping", e.message,
        P.btn("Reintentar", { tipo: "primario", icono: "refrescar", onclick: iniciar }))));
    });
  }

  P.alRenovarSesionRemota = function () {
    if (P.modo === "remoto" && !P.estado.sesion) iniciar();
  };
  iniciar();
})();
