/* Estado de una pestaña, transferido una sola vez cuando cambia la versión local. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var clave = "ajb.predio.recarga";
  var version = decodeURIComponent(document.documentElement.dataset.version || "");
  var limite = 5 * 60 * 1000;
  var anterior = null;
  var pantalla = null;
  var editados = new WeakSet();
  var aplicandoCampos = false;
  var componiendo = false;
  var recargando = false;
  var avisada = false;
  var selector = "input, select, textarea, .segmentado, details";
  var desplazables = ".tabla-desplazable, .tabla-desliz, .rec-tabla, .ventana-cuerpo";

  if (P.modo === "local") {
    try {
      var guardado = sessionStorage.getItem(clave);
      sessionStorage.removeItem(clave);
      var datos = JSON.parse(guardado);
      if (datos && datos.version !== version && Date.now() - datos.fecha < limite) anterior = datos;
    } catch (_e) { /* Almacenamiento deshabilitado o estado inválido. */ }
  }

  function identidad() {
    var sesion = P.estado.sesion || {};
    var usuario = sesion.usuario || {};
    var puesto = sesion.puesto || {};
    return JSON.stringify([location.pathname, location.search, location.hash, usuario.id, usuario.rol, usuario.debe_cambiar_clave,
      puesto.boca_id, puesto.caja_id, puesto.turno_id]);
  }

  function esSecreto(el) {
    return el.type === "password" || el.closest(".campo-clave") || /password/.test(el.autocomplete || "");
  }

  function campos(raiz) {
    var repetidos = new Map();
    return Array.from(raiz.querySelectorAll(selector)).filter(function (el) {
      return !el.closest("[data-sin-reanudar]") && !esSecreto(el) && !el.readOnly && !el.disabled &&
        !/^(?:hidden|file|button|submit|reset)$/.test(el.type);
    }).map(function (el) {
      var etiqueta = el.closest("label");
      var texto = etiqueta && (etiqueta.querySelector(".campo-etiqueta") || etiqueta.querySelector("span"));
      var resumen = el.tagName === "DETAILS" && el.querySelector("summary");
      var nombre = JSON.stringify([el.tagName, el.type, el.id, el.name, el.getAttribute("data-sel"),
        el.getAttribute("aria-label"), el.getAttribute("placeholder"), texto && texto.textContent,
        el.type === "radio" ? el.value : null, el.restaurarSegmento ? el.textContent : resumen && resumen.textContent]);
      var indice = repetidos.get(nombre) || 0;
      repetidos.set(nombre, indice + 1);
      return { el: el, id: nombre + indice };
    });
  }

  function opcionesMarcadas(el) {
    return Array.from(el.selectedOptions, function (op) { return op.value; });
  }

  function capturar(raiz, incluirCampos) {
    var activos = campos(raiz);
    var foco = activos.find(function (c) { return c.el === document.activeElement; });
    return {
      campos: incluirCampos ? activos.filter(function (c) { return editados.has(c.el); }).map(function (c) {
        var el = c.el;
        return { id: c.id, valor: el.restaurarSegmento ? el.valor() : el.tagName === "DETAILS" ? el.open :
          el.type === "checkbox" || el.type === "radio" ? el.checked : el.multiple ? opcionesMarcadas(el) : el.value,
        combo: el.capturarCombo ? el.capturarCombo() : null };
      }) : [],
      foco: foco ? { id: foco.id, desde: foco.el.selectionStart, hasta: foco.el.selectionEnd,
        desplegado: foco.el.getAttribute("aria-expanded") === "true" } : null,
      scroll: Array.from(raiz.querySelectorAll(desplazables)).map(function (el, i) {
        return { i: i, x: el.scrollLeft, y: el.scrollTop };
      }).filter(function (p) { return p.x || p.y; }),
    };
  }

  function aplicarCampos(raiz, guardados) {
    aplicandoCampos = true;
    try {
      guardados.forEach(function (dato) {
        // Un selector puede reconstruir los campos que dependen de él.
        var campo = campos(raiz).find(function (c) { return c.id === dato.id; });
        if (!campo) return;
        var el = campo.el;
        editados.add(el);
        if (el.restaurarSegmento) {
          el.restaurarSegmento(dato.valor);
          return;
        }
        if (el.tagName === "DETAILS") {
          el.open = dato.valor;
          return;
        }
        if (el.restaurarCombo && dato.combo) {
          el.restaurarCombo(dato.combo);
          return;
        } else if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked === dato.valor) return;
          el.checked = dato.valor;
        } else if (el.multiple) {
          Array.from(el.options).forEach(function (op) { op.selected = dato.valor.indexOf(op.value) >= 0; });
        } else {
          if (el.value === dato.valor) return;
          if (el.tagName === "SELECT" && !Array.from(el.options).some(function (op) { return op.value === dato.valor; })) return;
          el.value = dato.valor;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } finally { aplicandoCampos = false; }
  }

  function restituirVista(raiz, vista) {
    var zonas = raiz.querySelectorAll(desplazables);
    vista.scroll.forEach(function (p) { if (zonas[p.i]) zonas[p.i].scrollTo(p.x, p.y); });
    if (!vista.foco) return;
    var campo = campos(raiz).find(function (c) { return c.id === vista.foco.id; });
    if (!campo) return;
    if (campo.el.restaurarFocoCombo) campo.el.restaurarFocoCombo(vista.foco.desplegado);
    else campo.el.focus({ preventScroll: true });
    if (typeof vista.foco.desde === "number" && typeof campo.el.setSelectionRange === "function") {
      campo.el.setSelectionRange(vista.foco.desde, vista.foco.hasta);
    }
  }

  function montar(actual, carga) {
    var estado = actual.estado;
    if (!estado) return;
    var observador = new MutationObserver(programar);
    var espera;
    var lista = !carga || typeof carga.then !== "function";
    var terminada = false;
    var maximo = setTimeout(restaurar, 5000);
    observador.observe(actual.raiz, { childList: true, subtree: true });
    if (!lista) carga.then(cargada, cargada);
    programar();

    function cargada() { lista = true; programar(); }

    function programar() {
      clearTimeout(espera);
      if (!terminada && lista && actual.raiz.firstChild && !actual.raiz.querySelector(".cargando")) espera = setTimeout(restaurar, 60);
    }

    async function restaurar() {
      terminada = true;
      clearTimeout(espera);
      clearTimeout(maximo);
      observador.disconnect();
      if (pantalla !== actual || identidad() !== estado.identidad) return;
      try {
        aplicarCampos(actual.raiz, estado.vista.campos);
        var ventanas = [];
        for (var i = 0; i < estado.ventanas.length; i++) {
          var guardada = estado.ventanas[i];
          var abrir = actual.ventanas.get(guardada.id);
          if (!abrir) throw new Error("La ventana cambió en esta versión");
          var modal = await abrir(guardada.datos);
          if (pantalla !== actual) {
            if (modal) modal.cerrar();
            return;
          }
          if (!modal || !modal.ventana) throw new Error("La ventana ya no está disponible");
          aplicarCampos(modal.ventana, guardada.vista.campos);
          ventanas.push({ modal: modal.ventana, vista: guardada.vista });
        }
        // Dejá que los diálogos terminen de enfocar sus controles por defecto.
        await new Promise(function (resolver) { setTimeout(resolver, 40); });
        if (pantalla !== actual) return;
        restituirVista(actual.raiz, estado.vista);
        ventanas.forEach(function (v) { restituirVista(v.modal, v.vista); });
        window.scrollTo(estado.x, estado.y);
        if (estado.menu) {
          var boton = document.querySelector(".barra-menu[aria-expanded='false']");
          if (boton) P.abrirMenu();
        }
        P.aviso("El sistema del predio se actualizó.", "ok");
      } catch (_e) {
        P.aviso("El sistema se actualizó. Parte de la pantalla anterior ya no está disponible.", "info");
      } finally { actual.estado = null; }
    }
  }

  function avisarEspera() {
    if (!avisada) P.aviso("Hay una actualización lista. Se aplicará cuando pueda conservarse tu trabajo.", "info", 9000);
    avisada = true;
  }

  P.continuidad = {
    entrar: function (raiz) {
      pantalla = { raiz: raiz, estado: anterior && anterior.identidad === identidad() ? anterior : null, ventanas: new Map(), guardar: null };
      anterior = null;
      if (pantalla.estado) Object.assign(P.cache, pantalla.estado.cache);
    },
    desmontar: function () { pantalla = null; },
    montada: function (carga) { if (pantalla) montar(pantalla, carga); },
    datosPantalla: function () { return pantalla && pantalla.estado && pantalla.estado.datos; },
    guardarPantalla: function (guardar) { if (pantalla) pantalla.guardar = guardar; },
    registrarVentana: function (id, abrir) { if (pantalla) pantalla.ventanas.set(id, abrir); },
    campoEditado: function (el) { editados.add(el); },
    aplicandoCampos: function () { return aplicandoCampos; },
    comprobar: function (estado) {
      if (P.modo !== "local" || recargando || !version || !estado.version || estado.version === version || !pantalla) return;
      if (pantalla.estado || componiendo || P.hayTrabajoEnCurso()) { avisarEspera(); return; }
      var ventanas = P.ventanasAbiertas();
      var camposAbiertos = Array.from(document.querySelectorAll(selector));
      if (ventanas.some(function (m) { return !m.reanudar || !pantalla.ventanas.has(m.reanudar.id); }) ||
        camposAbiertos.some(function (el) { return (esSecreto(el) && el.value) || (el.type === "file" && el.files.length); })) {
        avisarEspera();
        return;
      }

      try {
        var cache = {};
        Object.keys(P.cache).forEach(function (k) {
          if (/^(?:tabla:|estadisticas$)|:vista$/.test(k)) cache[k] = P.cache[k];
        });
        var datos = {
          version: version, fecha: Date.now(), identidad: identidad(), cache: cache,
          x: window.scrollX, y: window.scrollY, menu: Boolean(document.querySelector(".riel.abierto")),
          datos: pantalla.guardar ? pantalla.guardar() : null,
          vista: capturar(pantalla.raiz, !pantalla.guardar),
          ventanas: ventanas.map(function (m) {
            var r = m.reanudar;
            return { id: r.id, datos: typeof r.datos === "function" ? r.datos() : r.datos, vista: capturar(m.ventana, r.campos !== false) };
          }),
        };
        sessionStorage.setItem(clave, JSON.stringify(datos));
      } catch (_e) { avisarEspera(); return; }
      recargando = true;
      location.reload();
    },
  };

  function anotar(ev) { if (ev.target.matches && ev.target.matches(selector)) editados.add(ev.target); }
  document.addEventListener("input", anotar, true);
  document.addEventListener("change", anotar, true);
  document.addEventListener("toggle", anotar, true);
  document.addEventListener("compositionstart", function () { componiendo = true; });
  document.addEventListener("compositionend", function () { componiendo = false; });
})();
