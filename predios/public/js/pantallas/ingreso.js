/* Ingreso: inicio de sesión, configuración inicial y elección de boca y caja.
   Misma cara que el ingreso de Mi AJB: cabecera blanca, cielo celeste con olas, el formulario en
   una tarjeta y al lado la galería de fotos del sistema general (o el logo si no hay fotos). */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;
  var NS = "http://www.w3.org/2000/svg";

  function olas() {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 1440 110");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    [
      ["#8ed3f2", ".3", "M0,64 C120,88 260,40 420,52 C580,64 660,96 820,88 C980,80 1080,36 1220,44 C1320,50 1400,70 1440,76 L1440,110 L0,110 Z"],
      ["#cdeaf9", ".75", "M0,80 C160,60 300,92 470,84 C640,76 740,44 900,56 C1060,68 1180,96 1320,88 C1370,85 1420,78 1440,74 L1440,110 L0,110 Z"],
      ["#ffffff", "1", "M0,96 C180,78 340,102 520,94 C700,86 820,66 1000,74 C1180,82 1320,100 1440,92 L1440,110 L0,110 Z"],
    ].forEach(function (o) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("fill", o[0]);
      p.setAttribute("fill-opacity", o[1]);
      p.setAttribute("d", o[2]);
      svg.appendChild(p);
    });
    return h("div.lg-olas", { "aria-hidden": "true" }, svg);
  }

  function chipConexion(estado) {
    var enLinea = estado && estado.en_linea;
    var texto = enLinea ? "Conectado con Mi AJB" : (estado && estado.vinculado ? "Sin conexión con Mi AJB" : "Red del camping");
    return h("span.conexion.lg-conexion" + (enLinea ? ".en-linea" : ".sin-linea"), { title: texto }, h("i"), h("span", texto));
  }

  // Galería: las fotos que el administrador carga en Mi AJB, guardadas en la notebook.
  // Mientras no hay ninguna (o sin internet la primera vez) se ve el logo completo.
  var INTERVALO_FOTOS = 3000;
  var TRANSICION_FOTOS = 1600;
  function galeria(nombre) {
    var velo = h("div.lg-visual-velo");
    var marco = h("div.lg-visual-marco",
      h("div.lg-visual-respaldo", h("img.lg-visual-logo", { src: "img/logo-completo.webp", alt: "", width: "960", height: "535" })),
      velo,
      h("div.lg-visual-pie", h("p.lg-visual-lema", h("span", nombre + ","), h("span", "siempre en marcha."))));
    var fotos = [];
    var activa = -1;
    var reloj = null;
    function mostrar(i) {
      var anterior = activa >= 0 ? fotos[activa] : null;
      activa = i;
      fotos.forEach(function (f, j) {
        f.classList.toggle("activa", j === i);
        f.classList.toggle("previa", f === anterior);
      });
      if (anterior) setTimeout(function () { anterior.classList.remove("previa"); }, TRANSICION_FOTOS + 100);
      marco.classList.add("con-fotos");
      if (!reloj && fotos.length > 1) reloj = setInterval(siguiente, INTERVALO_FOTOS + TRANSICION_FOTOS);
    }
    function siguiente() {
      if (!document.body.contains(marco)) { clearInterval(reloj); return; }
      for (var k = 1; k < fotos.length; k++) {
        var j = (activa + k) % fotos.length;
        if (fotos[j].cargada) { mostrar(j); return; }
      }
    }
    P.get("/login/imagenes", { sinRedireccion: true }).then(function (r) {
      (r.imagenes || []).forEach(function (im, i) {
        var img = h("img.lg-visual-foto", { alt: "", decoding: "async" });
        img.addEventListener("load", function () { img.cargada = true; if (activa < 0) mostrar(i); });
        marco.insertBefore(img, velo);
        fotos.push(img);
        img.src = P.apiBase + "/" + im.url;
      });
    }).catch(function () { /* queda el logo */ });
    return h("aside.lg-visual", { "aria-hidden": "true" }, marco);
  }

  // Campo con ícono a la izquierda (y, en la contraseña, el ojo adentro del recuadro).
  function campoLg(etiqueta, icono, input, conOjo) {
    input.classList.add("lg-input");
    var control = h("div.lg-control", P.icono(icono, "lg-control-icono"), input);
    if (conOjo) {
      var ojo = h("button.lg-ojo", { type: "button", "aria-label": "Mostrar contraseña", "aria-pressed": "false" }, P.icono("ojo"));
      ojo.addEventListener("click", function () {
        var ver = input.type === "password";
        input.type = ver ? "text" : "password";
        ojo.setAttribute("aria-label", ver ? "Ocultar contraseña" : "Mostrar contraseña");
        ojo.setAttribute("aria-pressed", String(ver));
        P.reemplazar(ojo, P.icono(ver ? "ojo-tachado" : "ojo"));
        input.focus();
      });
      control.appendChild(ojo);
    }
    return h("label.lg-campo", h("span.lg-etiqueta", etiqueta), control);
  }

  function cajaError() {
    var caja = h("p.lg-error", { role: "alert", hidden: true });
    caja.mostrar = function (texto) { P.reemplazar(caja, P.icono("alerta"), h("span", texto)); caja.hidden = false; };
    caja.ocultar = function () { caja.hidden = true; };
    return caja;
  }

  function botonIngresar(texto) {
    return h("button.lg-submit", { type: "submit" }, h("span", texto), P.icono("flecha", "lg-submit-flecha"));
  }

  P.pantallaIngreso = function (app, estado) {
    var nombre = estado.nombre || "Camping";
    var tarjeta;
    if (!estado.configurado && estado.local) tarjeta = formularioPrimerUso();
    else if (!estado.configurado) {
      tarjeta = h("div",
        h("h1.lg-titulo#lg-titulo", "Todavía no está listo"),
        h("p.lg-bajada", "El sistema todavía no está configurado: terminá la configuración inicial en la notebook servidor."));
    } else tarjeta = formularioIngreso(nombre);
    P.reemplazar(app, h("main.lg",
      h("header.lg-cabecera", h("div.lg-cabecera-interior",
        h("div.lg-marca",
          h("img", { src: "img/logo-isotipo-color.png", alt: "", width: "60", height: "72" }),
          h("span.lg-marca-texto", h("strong", nombre), h("span", "Sistema del predio"))),
        chipConexion(estado))),
      h("div.lg-escenario",
        h("div.lg-interior",
          h("section.lg-tarjeta", { "aria-labelledby": "lg-titulo" }, tarjeta),
          galeria(nombre)),
        olas())));
    var primero = app.querySelector(".lg-input");
    if (primero) setTimeout(function () { try { primero.focus(); } catch (e) { /* nada */ } }, 60);
  };

  function formularioIngreso(nombre) {
    var usuario = P.input({ placeholder: "Usuario o DNI", autocomplete: "username" });
    usuario.setAttribute("autocapitalize", "none");
    usuario.setAttribute("spellcheck", "false");
    var clave = P.input({ tipo: "password", placeholder: "Tu contraseña", autocomplete: "current-password" });
    var recordar = h("input.lg-recordar-check", { type: "checkbox", checked: true });
    var error = cajaError();
    var boton = botonIngresar("Ingresar");
    var form = h("form.lg-form", { novalidate: true },
      h("h1.lg-titulo#lg-titulo", (P.saludo ? P.saludo() : "Hola") + "."),
      h("p.lg-bajada", "Ingresá al sistema de " + nombre + " con tu usuario y tu contraseña."),
      campoLg("Usuario", "persona", usuario),
      campoLg("Contraseña", "candado", clave, true),
      h("label.lg-recordar", recordar, h("span", "Mantener sesión iniciada")),
      error,
      boton);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      error.ocultar();
      if (!usuario.value.trim() || !clave.value) { error.mostrar("Escribí tu usuario y tu contraseña."); (usuario.value.trim() ? clave : usuario).focus(); return; }
      P.ejecutar(boton, function () {
        return P.post("/login", Object.assign({ usuario: usuario.value.trim(), password: clave.value, recordar: recordar.checked }, P.equipo.datos()), { sinRedireccion: true }).then(function (r) {
          P.sesion.guardar(r.token, recordar.checked);
          P.alIngresar(r, clave.value);
        });
      }).catch(function (e) { error.mostrar(e.message); clave.select(); });
    });
    return form;
  }

  function formularioPrimerUso() {
    var nombre = P.input({ placeholder: "Nombre y apellido" });
    var usuario = P.input({ placeholder: "Por ejemplo: administracion" });
    usuario.setAttribute("autocapitalize", "none");
    var clave = P.input({ tipo: "password", placeholder: "Al menos 6 caracteres", autocomplete: "new-password" });
    var repetir = P.input({ tipo: "password", placeholder: "Otra vez la misma", autocomplete: "new-password" });
    var error = cajaError();
    var boton = botonIngresar("Crear administrador e ingresar");
    var form = h("form.lg-form", { novalidate: true },
      h("h1.lg-titulo.lg-titulo-chico#lg-titulo", "Configuración inicial"),
      h("p.lg-bajada", "Todavía no hay usuarios. Este usuario administra el camping: crea los usuarios de cada boca, carga productos y ve la caja."),
      campoLg("Nombre", "persona", nombre),
      campoLg("Usuario", "credencial", usuario),
      campoLg("Contraseña", "candado", clave, true),
      campoLg("Repetí la contraseña", "candado", repetir, true),
      error,
      boton);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      error.ocultar();
      if (clave.value !== repetir.value) { error.mostrar("Las contraseñas no coinciden."); repetir.focus(); return; }
      P.ejecutar(boton, function () {
        return P.post("/primer-uso", { nombre: nombre.value, usuario: usuario.value, password: clave.value, recordar: true }).then(function (r) {
          P.sesion.guardar(r.token, true);
          P.aviso("¡Listo! Ya podés cargar bocas, cajas, productos y usuarios.", "ok");
          P.alIngresar(r);
        });
      }).catch(function (e) { error.mostrar(e.message); });
    });
    return form;
  }

  P.pantallaCambioClave = function (app, claveDeIngreso) {
    var actual = claveDeIngreso ? null : P.input({ tipo: "password", autocomplete: "current-password" });
    var nueva = P.input({ tipo: "password", autocomplete: "new-password" });
    var repetir = P.input({ tipo: "password", autocomplete: "new-password" });
    var boton = botonIngresar("Guardar mi contraseña");
    var error = cajaError();
    var form = h("form.lg-form", h("h1.lg-titulo.lg-titulo-chico", "Elegí tu contraseña"),
      h("p.lg-bajada", "Usá al menos 6 caracteres. Evitá tu usuario, secuencias y repeticiones."),
      actual ? campoLg("Contraseña temporal", "candado", actual, true) : null,
      campoLg("Nueva contraseña", "candado", nueva, true), campoLg("Repetí la nueva contraseña", "candado", repetir, true), error, boton);
    function cerrar() {
      P.post("/logout", {}, { sinRedireccion: true }).then(reingresar).catch(function (e) {
        if (e.status === 401) reingresar();
        else error.mostrar(e.message);
      });
    }
    function reingresar() {
      P.sesion.borrar();
      if (P.notificarCierreRemoto) P.notificarCierreRemoto();
      else location.reload();
    }
    var salir = P.btn("Cerrar sesión", { tipo: "texto", onclick: cerrar });
    var tarjeta = h("section.lg-tarjeta", form, salir);
    P.reemplazar(app, h("main.lg", h("div.lg-escenario", h("div.lg-interior.lg-interior-centrado", tarjeta))));
    (actual || nueva).focus();
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      error.ocultar();
      if (nueva.value !== repetir.value) { error.mostrar("Las contraseñas no coinciden."); repetir.focus(); return; }
      P.ejecutar(boton, function () {
        return P.post("/sesion/clave", { actual: claveDeIngreso || actual.value, nueva: nueva.value }).then(function (r) {
          if (P.modo === "remoto") {
            P.reemplazar(tarjeta, h("h1.lg-titulo.lg-titulo-chico", r.encolado ? "Cambio pendiente" : "Contraseña actualizada"),
              h("p.lg-bajada", r.encolado ? "Tu cambio quedó pendiente de sincronización con el camping. Cuando se aplique, ingresá con tu nueva contraseña." : "Volvé a ingresar a Mi AJB con tu nueva contraseña."),
              P.btn("Volver al ingreso", { tipo: "primario", onclick: reingresar }));
            return;
          }
          return P.get("/sesion").then(function (ses) { P.alIngresar(ses); });
        });
      }).catch(function (e) { error.mostrar(e.message); });
    });
  };

  // ------------------------------------------------------------------ elegir boca y caja
  P.elegirPuesto = function (boca_id, caja_id) {
    return P.post("/sesion/puesto", Object.assign({ boca_id: boca_id, caja_id: caja_id || null }, P.equipo.datos())).then(function (r) {
      P.estado.sesion = Object.assign({}, P.estado.sesion, r);
      P.equipo.recordarPuesto(r.puesto);
      return r;
    });
  };

  P.pantallaPuesto = function (contenedor) {
    var ses = P.estado.sesion;
    var puestos = (ses.puestos || []).filter(function (p) { return P.puedeGestionarCajas() ? p.cajas.length : true; });
    contenedor.appendChild(h("div.pagina-cabecera", h("div",
      h("h1.titulo-pagina", P.puedeGestionarCajas() ? "Trabajar en una caja" : "¿Dónde trabajás hoy?"),
      h("p.subtitulo", P.puedeGestionarCajas() ? "Elegí la caja para operar." : "Elegí tu boca y caja. Al cerrar tu turno, la caja queda disponible para el relevo."))));
    if (P.puesto() && P.puesto().caja_id) {
      contenedor.appendChild(P.btn(P.puedeGestionarCajas() ? "Cerrar " + P.puesto().caja : "Cierre temporal", { tipo: "primario", icono: "candado", onclick: function () { P.cerrarCaja(P.puesto().caja_id); } }));
      return;
    }
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
