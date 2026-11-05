/* Ingreso: inicio de sesión, configuración inicial y elección de boca y caja. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;
  var NS = "http://www.w3.org/2000/svg";

  function s(tag, attrs, hijos) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    (hijos || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  // Bosque de pinos (el vivero de Miramar) como silueta: triángulos escalonados.
  function bosque(y, alto, semilla, ancho) {
    var d = "M0 900 L0 " + y;
    var x = 0;
    var r = semilla;
    function azar() { r = (r * 9301 + 49297) % 233280; return r / 233280; }
    while (x < ancho) {
      var w = 34 + azar() * 46;
      var t = alto * (0.55 + azar() * 0.6);
      d += " L" + (x + w * 0.5).toFixed(1) + " " + (y - t).toFixed(1) + " L" + (x + w).toFixed(1) + " " + (y - t * 0.08).toFixed(1);
      x += w * 0.78;
    }
    return d + " L" + ancho + " 900 Z";
  }

  function ola(y, amplitud, largo, ancho) {
    var d = "M0 " + y;
    for (var x = 0; x < ancho * 2; x += largo) {
      d += " Q" + (x + largo / 4) + " " + (y - amplitud) + " " + (x + largo / 2) + " " + y + " T" + (x + largo) + " " + y;
    }
    return d + " L" + ancho * 2 + " 900 L0 900 Z";
  }

  function escena() {
    var A = 1200;
    var svg = s("svg", { viewBox: "0 0 1200 900", preserveAspectRatio: "xMidYMax slice", "aria-hidden": "true" });
    var defs = s("defs");
    var mar = s("linearGradient", { id: "g-mar", x1: "0", y1: "0", x2: "0", y2: "1" }, [
      s("stop", { offset: "0", "stop-color": "#2b9fda" }), s("stop", { offset: "1", "stop-color": "#0d7fc0" })]);
    var sol = s("radialGradient", { id: "g-sol" }, [
      s("stop", { offset: "0", "stop-color": "#fff6d6" }), s("stop", { offset: "1", "stop-color": "#fff6d6", "stop-opacity": "0" })]);
    defs.appendChild(mar);
    defs.appendChild(sol);
    svg.appendChild(defs);
    svg.appendChild(s("circle", { cx: "760", cy: "260", r: "190", fill: "url(#g-sol)" }));
    svg.appendChild(s("circle", { cx: "760", cy: "260", r: "58", fill: "#ffd36b" }));
    var nubes = s("g", { class: "nube", opacity: ".92" });
    [[150, 170, 1], [520, 120, .8], [1350, 190, 1.1], [1720, 130, .9]].forEach(function (n) {
      nubes.appendChild(s("g", { transform: "translate(" + n[0] + " " + n[1] + ") scale(" + n[2] + ")" }, [
        s("ellipse", { cx: "0", cy: "0", rx: "70", ry: "20", fill: "#fff" }),
        s("ellipse", { cx: "-24", cy: "-14", rx: "34", ry: "24", fill: "#fff" }),
        s("ellipse", { cx: "22", cy: "-18", rx: "40", ry: "30", fill: "#fff" })]));
    });
    svg.appendChild(nubes);
    svg.appendChild(s("rect", { x: "0", y: "450", width: String(A), height: "260", fill: "url(#g-mar)" }));
    svg.appendChild(s("path", { class: "ola ola-2", d: ola(500, 9, 120, A), fill: "#59b9ea", opacity: ".75" }));
    svg.appendChild(s("path", { class: "ola", d: ola(540, 12, 160, A), fill: "#8ad0f2", opacity: ".8" }));
    svg.appendChild(s("path", { d: "M0 600 C 200 570, 420 590, 640 585 S 1000 560, 1200 590 L1200 900 L0 900 Z", fill: "#eef8fe" }));
    svg.appendChild(s("path", { class: "ola", d: ola(598, 5, 90, A), fill: "#ffffff", opacity: ".7" }));
    // Carpas sobre la playa
    [[300, 690, 1], [392, 700, .8], [880, 682, 1.05]].forEach(function (c) {
      svg.appendChild(s("g", { transform: "translate(" + c[0] + " " + c[1] + ") scale(" + c[2] + ")" }, [
        s("path", { d: "M-44 0 L0 -54 L44 0 Z", fill: "#ffffff", stroke: "#0d5482", "stroke-width": "4", "stroke-linejoin": "round" }),
        s("path", { d: "M0 -54 L-10 0 L10 0 Z", fill: "#0097de" })]));
    });
    svg.appendChild(s("path", { d: bosque(790, 95, 7, A), fill: "#0a5c8f" }));
    svg.appendChild(s("path", { d: bosque(835, 120, 31, A), fill: "#0d5482" }));
    svg.appendChild(s("path", { d: bosque(880, 80, 57, A), fill: "#0a4469" }));
    return svg;
  }

  function pieConexion(estado) {
    var enLinea = estado && estado.en_linea;
    return h("div.ingreso-pie",
      h("span.conexion" + (enLinea ? ".en-linea" : ".sin-linea"), h("i"), h("span", enLinea ? "Conectado al sistema general" : (estado && estado.vinculado ? "Sin internet: el sistema funciona igual" : "Funcionando en la red del camping"))),
      estado && estado.version ? h("span.texto-3.chico", "Versión " + String(estado.version).split("+")[0]) : null);
  }

  P.pantallaIngreso = function (app, estado) {
    var error = h("div", { hidden: true });
    var usuario = P.input({ placeholder: "Usuario o DNI", autocomplete: "username", autofocus: true });
    var clave = P.input({ tipo: "password", placeholder: "Contraseña", autocomplete: "current-password" });
    var ver = P.btn("", { tipo: "texto", icono: "ojo", etiqueta: "Mostrar contraseña", onclick: function () { clave.type = clave.type === "password" ? "text" : "password"; } });
    var recordar = P.check("Mantener la sesión iniciada", true, "En PCs compartidas, destildalo.");
    var boton = P.btn("Ingresar", { tipo: "primario", grande: true, submit: true });
    var form = h("form", { novalidate: true },
      h("div", h("h1", estado.nombre || "Camping"), h("p.subtitulo", "Ingresá con tu usuario de la boca o de administración.")),
      error,
      P.campo("Usuario", usuario),
      P.campo("Contraseña", h("div.fila", { style: { flexWrap: "nowrap", gap: "6px" } }, clave, ver)),
      recordar,
      boton);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      error.hidden = true;
      if (!usuario.value.trim() || !clave.value) { mostrarError("Escribí tu usuario y tu contraseña."); return; }
      P.ejecutar(boton, function () {
        return P.post("/login", { usuario: usuario.value.trim(), password: clave.value, recordar: recordar.input.checked }, { sinRedireccion: true }).then(function (r) {
          P.sesion.guardar(r.token, recordar.input.checked);
          P.alIngresar(r);
        });
      }).catch(function (e) { mostrarError(e.message); clave.select(); });
    });
    function mostrarError(texto) { P.reemplazar(error, P.mensaje(texto, "error")); error.hidden = false; }

    var panel = h("div.ingreso-panel",
      h("img.ingreso-logo", { src: "img/logo-color.png", alt: "Mi AJB" }),
      !estado.configurado ? h("div", { style: { maxWidth: "400px", marginBottom: "16px" } },
        P.mensaje(estado.local ? "Todavía no hay usuarios. Creá el administrador del camping para empezar." : "El sistema todavía no está configurado: terminá la configuración inicial en la notebook servidor.", "aviso")) : null,
      !estado.configurado && estado.local ? formularioPrimerUso() : form,
      h("p.ingreso-nota", "¿Sos administrador del sistema general? Ingresá con tu DNI y tu contraseña de Mi AJB (la primera vez, con internet)."),
      pieConexion(estado));
    P.reemplazar(app, h("main.ingreso",
      h("section.ingreso-escena", escena(), h("div.ingreso-leyenda",
        h("h2", estado.nombre || "Camping"),
        h("p", "Ventas, caja, stock y afiliados del predio. Sigue funcionando aunque se corte internet."))),
      panel));
  };

  function formularioPrimerUso() {
    var nombre = P.input({ placeholder: "Nombre y apellido", autofocus: true });
    var usuario = P.input({ placeholder: "Por ejemplo: administracion" });
    var clave = P.input({ tipo: "password", placeholder: "Al menos 6 caracteres" });
    var repetir = P.input({ tipo: "password" });
    var error = h("div", { hidden: true });
    var boton = P.btn("Crear administrador e ingresar", { tipo: "primario", grande: true, submit: true });
    var form = h("form", { novalidate: true },
      h("div", h("h1", "Configuración inicial"), h("p.subtitulo", "Este usuario administra el camping: crea los usuarios de cada boca, carga productos y ve la caja.")),
      error,
      P.campo("Nombre", nombre), P.campo("Usuario", usuario), P.campo("Contraseña", clave), P.campo("Repetí la contraseña", repetir),
      boton);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (clave.value !== repetir.value) { P.reemplazar(error, P.mensaje("Las contraseñas no coinciden.", "error")); error.hidden = false; return; }
      P.ejecutar(boton, function () {
        return P.post("/primer-uso", { nombre: nombre.value, usuario: usuario.value, password: clave.value, recordar: true }).then(function (r) {
          P.sesion.guardar(r.token, true);
          P.aviso("¡Listo! Ya podés cargar bocas, cajas, productos y usuarios.", "ok");
          P.alIngresar(r);
        });
      }).catch(function (e) { P.reemplazar(error, P.mensaje(e.message, "error")); error.hidden = false; });
    });
    return form;
  }

  // ------------------------------------------------------------------ elegir boca y caja
  P.elegirPuesto = function (boca_id, caja_id) {
    return P.post("/sesion/puesto", { boca_id: boca_id, caja_id: caja_id || null }).then(function (r) {
      P.estado.sesion = Object.assign({}, P.estado.sesion, r);
      return r;
    });
  };

  P.pantallaPuesto = function (contenedor) {
    var ses = P.estado.sesion;
    var puestos = (ses.puestos || []).filter(function (p) { return P.esAdmin() ? p.cajas.length : true; });
    contenedor.appendChild(h("div.pagina-cabecera", h("div",
      h("h1.titulo-pagina", P.esAdmin() ? "Trabajar en una caja" : "¿Dónde trabajás hoy?"),
      h("p.subtitulo", P.esAdmin() ? "Elegí la caja para vender o cerrar caja como administrador." : "Elegí tu boca y la caja. Podés cambiarla después desde tu nombre, arriba a la derecha."))));
    if (!puestos.length) {
      contenedor.appendChild(h("div.hoja.hoja-cuerpo", P.mensaje("No tenés bocas asignadas. Pedile al administrador que te asigne una.", "aviso")));
      return;
    }
    contenedor.appendChild(h("div.puestos", puestos.map(function (p) {
      return h("div.hoja.puesto",
        h("div.fila", { style: { marginTop: 0 } }, h("span.medallon", { style: { width: "42px", height: "42px" } }, P.icono(p.es_almacen ? "stock" : "tienda")), h("h3", p.boca)),
        h("div.fila",
          p.cajas.length ? p.cajas.map(function (c) {
            return P.btn(c.caja, { tipo: "primario", icono: "caja", onclick: function (ev) {
              P.ejecutar(ev.currentTarget, function () { return P.elegirPuesto(p.boca_id, c.caja_id).then(function () { P.despuesDePuesto(); }); });
            } });
          }) : P.btn("Entrar (sin caja)", { tipo: "secundario", onclick: function (ev) {
            P.ejecutar(ev.currentTarget, function () { return P.elegirPuesto(p.boca_id, null).then(function () { P.ruta.ir(p.es_almacen ? "/compras" : "/solicitudes"); P.repintarMarco(); }); });
          } })));
    })));
  };

  P.despuesDePuesto = function () {
    P.repintarMarco();
    P.ruta.ir("/vender");
    setTimeout(function () { if (P.verificarApertura) P.verificarApertura(false); }, 300);
  };
})();
