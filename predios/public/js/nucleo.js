/* Núcleo de la pantalla del predio: DOM, API, formato, avisos, ventanas, rutas y sesión.
   JavaScript sin compilar (ES2017) para que funcione en Chrome 80+, Edge y Firefox 78+. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;

  var raiz = document.documentElement;
  var P = (window.P = {});
  P.modo = raiz.getAttribute("data-modo") === "remoto" ? "remoto" : "local";
  P.apiBase = raiz.getAttribute("data-api") || "/api";
  P.predioCodigo = raiz.getAttribute("data-predio") || null;
  P.estado = { sesion: null, avisos: null, conexion: null, remoto: null };
  P.rutas = [];
  P.cache = {};

  // ------------------------------------------------------------------ DOM
  function agregarHijo(el, hijo) {
    if (hijo === null || hijo === undefined || hijo === false) return;
    if (Array.isArray(hijo)) { hijo.forEach(function (x) { agregarHijo(el, x); }); return; }
    if (hijo instanceof Node) { el.appendChild(hijo); return; }
    el.appendChild(document.createTextNode(String(hijo)));
  }

  P.h = function (etiqueta, atributos) {
    var partes = String(etiqueta).split(/(?=[.#])/);
    var el = document.createElement(partes[0] || "div");
    for (var i = 1; i < partes.length; i++) {
      if (partes[i][0] === ".") el.classList.add(partes[i].slice(1));
      else if (partes[i][0] === "#") el.id = partes[i].slice(1);
    }
    var hijos = Array.prototype.slice.call(arguments, 2);
    if (atributos && (atributos instanceof Node || Array.isArray(atributos) || typeof atributos !== "object")) {
      hijos.unshift(atributos);
      atributos = null;
    }
    if (atributos) {
      Object.keys(atributos).forEach(function (k) {
        var v = atributos[k];
        if (v === undefined || v === null || v === false) return;
        if (k === "class" || k === "className") String(v).split(/\s+/).filter(Boolean).forEach(function (c) { el.classList.add(c); });
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "dataset") Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k === "value") el.value = v;
        else if (k === "checked") el.checked = !!v;
        else if (k === "html") throw new Error("No usar html");
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, v);
      });
    }
    agregarHijo(el, hijos);
    return el;
  };

  P.vaciar = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  P.reemplazar = function (el) { P.vaciar(el); agregarHijo(el, Array.prototype.slice.call(arguments, 1)); return el; };

  var SVG = "http://www.w3.org/2000/svg";
  var ICONOS = {
    inicio: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
    vender: "M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2|M9 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1zM17 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
    caja: "M3 7h18v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z|M3 7l2-3h14l2 3|M8 13h8",
    compras: "M3 4h11v11H3z|M14 8h4l3 3v4h-7|M7.5 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    gestion: "M21 8 12 3 3 8l9 5 9-5z|M3 8v8l9 5 9-5V8|M12 13v8",
    proveedores: "M2 7h13v9H2z|M15 10h4l3 3v3h-7|M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    afiliados: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20|M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z|M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35|M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
    bocas: "M4 9 5.5 4h13L20 9|M4 9h16v2a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0z|M5 13v7h14v-7|M10 20v-4h4v4",
    usuarios: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M5 21v-1a6 6 0 0 1 9-5.2|M19 15v6M16 18h6",
    estadisticas: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    sistema: "M7 18a5 5 0 0 1-.7-9.95A6 6 0 0 1 18 7.5a4.5 4.5 0 0 1-.5 10.5z|M12 11v6M9.5 14.5 12 17l2.5-2.5",
    salir: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4|M10 17l5-5-5-5|M15 12H3",
    mas: "M12 5v14M5 12h14",
    menos: "M5 12h14",
    buscar: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|M20 20l-3.5-3.5",
    cerrar: "M6 6l12 12M18 6 6 18",
    editar: "M4 20h4L19 9l-4-4L4 16z|M13.5 6.5l4 4",
    borrar: "M4 7h16|M10 11v6M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3",
    imprimir: "M7 9V3h10v6|M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2|M7 14h10v7H7z",
    descargar: "M12 3v12|M7 10l5 5 5-5|M4 21h16",
    subir: "M12 21V9|M7 14l5-5 5 5|M4 3h16",
    check: "M5 12.5 10 17.5 19.5 7",
    alerta: "M12 3 2 20h20z|M12 10v4|M12 17.5v.5",
    info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 11v6|M12 7.5v.5",
    reloj: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 7v5l3 2",
    campana: "M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8|M10 21a2 2 0 0 0 4 0",
    traspaso: "M4 8h13l-3-3|M20 16H7l3 3",
    baja: "M12 4v12|M7 11l5 5 5-5|M5 20h14",
    solicitud: "M9 4h6v3H9z|M15 5h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3|M9 12h6M9 16h4",
    stock: "M12 2 2 7l10 5 10-5z|M2 12l10 5 10-5|M2 17l10 5 10-5",
    llave: "M15 9a4 4 0 1 0-3.9 4.9L4 21h3v-2h2v-2h2l1.1-1.1A4 4 0 0 0 15 9z|M15.5 8.5h.01",
    menu: "M4 6h16M4 12h16M4 18h16",
    ojo: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    efectivo: "M3 6h18v12H3z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 9v.01M18 15v.01",
    qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z|M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
    tarjeta: "M3 6h18v12H3z|M3 10h18|M7 15h4",
    transferencia: "M7 7h13l-3-3|M17 17H4l3 3",
    descuento: "M19 5 5 19|M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    credencial: "M3 5h18v14H3z|M9 12a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 9 12z|M5.5 16.5a3.6 3.6 0 0 1 7 0|M15 9h3M15 13h3",
    refrescar: "M20 11a8 8 0 0 0-14.6-4.5L4 8|M4 4v4h4|M4 13a8 8 0 0 0 14.6 4.5L20 16|M20 20v-4h-4",
    filtro: "M3 5h18l-7 8v6l-4 2v-8z",
    planilla: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z|M14 3v5h5|M8 13h8M8 17h8M12 11v8",
    recibir: "M21 8 12 3 3 8l9 5 9-5z|M3 8v8l9 5 9-5V8|M8.5 12.5l2.5 2.5 4.5-4.5",
    despachar: "M22 2 11 13|M22 2 15 22l-4-9-9-4z",
    volver: "M19 12H5|M11 18l-6-6 6-6",
    nube: "M7 18a5 5 0 0 1-.7-9.95A6 6 0 0 1 18 7.5a4.5 4.5 0 0 1-.5 10.5z",
    candado: "M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4",
    tienda: "M4 9 5.5 4h13L20 9|M4 9h16v2a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0z|M5 13v7h14v-7",
    historial: "M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l3 2",
    lista: "M8 6h13M8 12h13M8 18h13|M3.5 6h.01M3.5 12h.01M3.5 18h.01",
    tag: "M3 3h8l10 10-8 8L3 11z|M7.5 7.5h.01",
    mensaje: "M4 4h16v12H8l-4 4z",
    escudo: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z",
  };
  P.icono = function (nombre, clase) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icono" + (clase ? " " + clase : ""));
    String(ICONOS[nombre] || ICONOS.info).split("|").forEach(function (d) {
      var p = document.createElementNS(SVG, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  };

  // Botón estándar: P.btn("Guardar", { tipo: "primario", icono: "check", onclick })
  P.btn = function (texto, opciones) {
    opciones = opciones || {};
    var clases = ["btn", "btn-" + (opciones.tipo || "secundario")];
    if (opciones.chico) clases.push("btn-chico");
    if (opciones.grande) clases.push("btn-grande");
    if (!texto && opciones.icono) clases.push("btn-icono");
    var b = P.h("button", {
      type: opciones.submit ? "submit" : "button", class: clases.join(" "), onclick: opciones.onclick,
      title: opciones.titulo || (!texto ? opciones.etiqueta : null), "aria-label": !texto ? (opciones.etiqueta || opciones.titulo) : null,
      disabled: opciones.deshabilitado, id: opciones.id,
    }, opciones.icono ? P.icono(opciones.icono) : null, texto || null, opciones.tecla ? P.h("span.tecla", opciones.tecla) : null);
    return b;
  };

  // ------------------------------------------------------------------ formato
  var fmtPesos = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtNumero = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 });
  var fmtEntero = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
  P.f = {
    pesos: function (v) { return fmtPesos.format(Number(v) || 0).replace(/ /g, " "); },
    numero: function (v) { return fmtNumero.format(Number(v) || 0); },
    entero: function (v) { return fmtEntero.format(Number(v) || 0); },
    pct: function (v) { return fmtNumero.format(Number(v) || 0) + " %"; },
    fecha: function (v) {
      if (!v) return "";
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
      return m ? m[3] + "/" + m[2] + "/" + m[1] : String(v);
    },
    fechaHora: function (v) {
      if (!v) return "";
      var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v));
      return m ? m[3] + "/" + m[2] + "/" + m[1] + " " + m[4] + ":" + m[5] : String(v);
    },
    hora: function (v) { var m = /[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? m[1] + ":" + m[2] : ""; },
    relativo: function (v) {
      if (!v) return "nunca";
      var t = new Date(String(v).replace(" ", "T") + "-03:00").getTime();
      var s = Math.round((Date.now() - t) / 1000);
      if (s < 10) return "recién";
      if (s < 60) return "hace " + s + " s";
      if (s < 3600) return "hace " + Math.round(s / 60) + " min";
      if (s < 86400) return "hace " + Math.round(s / 3600) + " h";
      return "el " + P.f.fechaHora(v);
    },
  };
  P.numeroDe = function (v) {
    if (typeof v === "number") return v;
    var t = String(v || "").trim();
    if (!t) return NaN;
    if (t.indexOf(",") >= 0) t = t.replace(/\./g, "").replace(",", ".");
    return Number(t);
  };
  P.hoy = function () {
    var d = new Date(Date.now() - 3 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  };
  P.sumarDias = function (iso, n) {
    var d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  P.redondear = function (v, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round((Number(v) + Number.EPSILON) * f) / f; };
  P.iniciales = function (nombre) {
    var partes = String(nombre || "?").replace(/\(.*\)/, "").trim().split(/[\s,]+/).filter(Boolean);
    return ((partes[0] || "?")[0] + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
  };

  // ------------------------------------------------------------------ sesión
  var CLAVE = P.modo === "remoto" ? "predio.remoto." + (P.predioCodigo || "") : "predio.sesion";
  P.sesion = {
    token: function () {
      try { return sessionStorage.getItem(CLAVE) || localStorage.getItem(CLAVE); } catch (e) { return null; }
    },
    guardar: function (token, recordar) {
      try {
        sessionStorage.removeItem(CLAVE); localStorage.removeItem(CLAVE);
        (recordar && P.modo === "local" ? localStorage : sessionStorage).setItem(CLAVE, token);
      } catch (e) { /* sin almacenamiento */ }
    },
    borrar: function () {
      try { sessionStorage.removeItem(CLAVE); localStorage.removeItem(CLAVE); } catch (e) { /* nada */ }
    },
  };
  if (P.modo === "remoto") {
    var m = /[#&]t=([^&]+)/.exec(location.hash);
    if (m) {
      P.sesion.guardar(decodeURIComponent(m[1]), false);
      history.replaceState(null, "", location.pathname + "#/inicio");
    }
  }

  // ------------------------------------------------------------------ API
  function ErrorApi(mensaje, status, datos) {
    var e = new Error(mensaje);
    e.status = status;
    e.datos = datos || {};
    e.codigo = (datos && datos.codigo) || null;
    return e;
  }
  P.ErrorApi = ErrorApi;

  P.api = function (metodo, ruta, cuerpo, opciones) {
    opciones = opciones || {};
    var cabeceras = {};
    var token = P.sesion.token();
    if (token) cabeceras.Authorization = "Bearer " + token;
    var body;
    if (cuerpo !== undefined && cuerpo !== null) {
      if (cuerpo instanceof Blob || cuerpo instanceof ArrayBuffer) { body = cuerpo; cabeceras["Content-Type"] = "application/octet-stream"; }
      else { body = JSON.stringify(cuerpo); cabeceras["Content-Type"] = "application/json"; }
    }
    return fetch(P.apiBase + ruta, { method: metodo, headers: cabeceras, body: body, cache: "no-store" })
      .catch(function () {
        throw ErrorApi(P.modo === "local"
          ? "No hay conexión con el servidor del camping. Revisá que la notebook servidor esté prendida y en la red."
          : "No hay conexión con el sistema general.", 0);
      })
      .then(function (r) {
        if (opciones.blob) {
          if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw ErrorApi(j.mensaje || "No se pudo descargar", r.status, j); });
          return r.blob().then(function (b) {
            var disp = r.headers.get("Content-Disposition") || "";
            var n = /filename="?([^";]+)"?/.exec(disp);
            return { blob: b, nombre: n ? n[1] : opciones.nombre || "archivo" };
          });
        }
        return r.text().then(function (texto) {
          var datos = null;
          try { datos = texto ? JSON.parse(texto) : null; } catch (e) { datos = { mensaje: texto }; }
          if (r.status === 202 && datos && datos.encolado) {
            P.aviso(datos.mensaje, "cola", 7000);
            return datos;
          }
          if (!r.ok) {
            var mensaje = (datos && (datos.mensaje || datos.message)) || "No se pudo completar la operación";
            var err = ErrorApi(mensaje, r.status, datos);
            if (r.status === 401 && !opciones.sinRedireccion) P.sesionVencida(mensaje);
            throw err;
          }
          return datos;
        });
      });
  };
  P.get = function (ruta, opciones) { return P.api("GET", ruta, null, opciones); };
  P.post = function (ruta, cuerpo, opciones) { return P.api("POST", ruta, cuerpo || {}, opciones); };
  P.put = function (ruta, cuerpo, opciones) { return P.api("PUT", ruta, cuerpo || {}, opciones); };
  P.qs = function (obj) {
    var partes = [];
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null || v === "") return;
      partes.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    return partes.length ? "?" + partes.join("&") : "";
  };

  P.guardarArchivo = function (blob, nombre) {
    var url = URL.createObjectURL(blob);
    var a = P.h("a", { href: url, download: nombre, style: { display: "none" } });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  };
  P.descargar = function (ruta, nombre) {
    return P.api("GET", ruta, null, { blob: true, nombre: nombre }).then(function (r) {
      P.guardarArchivo(r.blob, r.nombre || nombre);
      return r;
    });
  };

  P.opciones = function (fuente, forzar) {
    if (!forzar && P.cache["op:" + fuente]) return Promise.resolve(P.cache["op:" + fuente]);
    return P.get("/opciones/" + fuente).then(function (r) { P.cache["op:" + fuente] = r; return r; });
  };
  P.olvidarOpciones = function () {
    Object.keys(P.cache).forEach(function (k) { if (k.indexOf("op:") === 0) delete P.cache[k]; });
  };

  // ------------------------------------------------------------------ avisos
  P.aviso = function (texto, tipo, duracion) {
    var cont = document.getElementById("avisos");
    var icono = tipo === "ok" ? "check" : tipo === "error" ? "alerta" : tipo === "cola" ? "reloj" : "info";
    var el = P.h("div.aviso" + (tipo ? ".aviso-" + tipo : ""), P.icono(icono), P.h("div", texto),
      P.h("button.aviso-cerrar", { type: "button", "aria-label": "Cerrar", onclick: function () { cerrar(); } }, "×"));
    function cerrar() { el.classList.add("saliendo"); setTimeout(function () { el.remove(); }, 220); }
    cont.appendChild(el);
    setTimeout(cerrar, duracion || (tipo === "error" ? 7000 : 4200));
  };
  P.error = function (e) {
    if (e && e.status === 401) return;
    P.aviso((e && e.message) || String(e), "error");
  };

  // ------------------------------------------------------------------ ventanas
  var abiertas = [];
  P.modal = function (opciones) {
    var anterior = document.activeElement;
    var velo = P.h("div.velo", { role: "presentation" });
    var cuerpo = P.h("div.ventana-cuerpo");
    var pie = P.h("div.ventana-pie");
    var ventana = P.h("div.ventana" + (opciones.ancho ? ".ventana-" + opciones.ancho : ""), { role: "dialog", "aria-modal": "true", "aria-label": opciones.titulo },
      P.h("div.ventana-cabecera",
        P.h("div", P.h("h2", opciones.titulo), opciones.subtitulo ? P.h("p", opciones.subtitulo) : null),
        opciones.sinCerrar ? null : P.btn("", { tipo: "texto", icono: "cerrar", etiqueta: "Cerrar", onclick: function () { api.cerrar(); } })),
      cuerpo, pie);
    if (opciones.contenido) P.reemplazar(cuerpo, opciones.contenido);
    (opciones.acciones || []).forEach(function (a) { if (a) pie.appendChild(a instanceof Node ? a : P.btn(a.texto, a)); });
    if (!pie.childNodes.length) pie.remove();
    velo.appendChild(ventana);
    velo.addEventListener("mousedown", function (ev) { if (ev.target === velo && !opciones.sinCerrar && !opciones.modalFijo) api.cerrar(); });
    document.body.appendChild(velo);
    var api = {
      velo: velo, cuerpo: cuerpo, pie: pie, ventana: ventana,
      cerrar: function (valor) {
        if (!velo.parentNode) return;
        velo.remove();
        abiertas.splice(abiertas.indexOf(api), 1);
        if (anterior && anterior.focus) try { anterior.focus(); } catch (e) { /* nada */ }
        if (opciones.alCerrar) opciones.alCerrar(valor);
      },
    };
    abiertas.push(api);
    setTimeout(function () {
      var foco = ventana.querySelector("[autofocus]") || ventana.querySelector("input:not([type=checkbox]):not([readonly]), select, textarea") || ventana.querySelector(".ventana-pie .btn-primario");
      if (foco) foco.focus();
    }, 30);
    return api;
  };
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && abiertas.length) {
      var ultima = abiertas[abiertas.length - 1];
      if (!ultima.velo.querySelector(".combo-lista")) { ev.preventDefault(); ultima.cerrar(); }
    }
  });
  P.hayVentana = function () { return abiertas.length > 0; };

  P.confirmar = function (texto, opciones) {
    opciones = opciones || {};
    return new Promise(function (resolver) {
      var m = P.modal({
        titulo: opciones.titulo || "¿Confirmás?",
        contenido: typeof texto === "string" ? P.h("p", { style: { margin: "0" } }, texto) : texto,
        alCerrar: function (v) { resolver(v === true); },
        acciones: [
          P.btn(opciones.cancelar || "Cancelar", { tipo: "secundario", onclick: function () { m.cerrar(false); } }),
          P.btn(opciones.aceptar || "Confirmar", { tipo: opciones.peligro ? "peligro-lleno" : "primario", onclick: function () { m.cerrar(true); } }),
        ],
      });
    });
  };

  P.pedirTexto = function (titulo, opciones) {
    opciones = opciones || {};
    return new Promise(function (resolver) {
      var input = P.h(opciones.largo ? "textarea.campo-control" : "input.campo-control", { value: opciones.valor || "", placeholder: opciones.placeholder || "", maxlength: opciones.max || 255 });
      var m = P.modal({
        titulo: titulo, subtitulo: opciones.subtitulo,
        contenido: P.h("label.campo", P.h("span.campo-etiqueta", opciones.etiqueta || "Detalle"), input),
        alCerrar: function (v) { resolver(v === undefined ? null : v); },
        acciones: [
          P.btn("Cancelar", { onclick: function () { m.cerrar(null); } }),
          P.btn(opciones.aceptar || "Aceptar", { tipo: opciones.peligro ? "peligro-lleno" : "primario", onclick: function () {
            var v = input.value.trim();
            if (opciones.requerido && !v) { input.classList.add("invalido"); input.focus(); return; }
            m.cerrar(v);
          } }),
        ],
      });
      input.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && !opciones.largo) { ev.preventDefault(); m.pie.querySelector(".btn-primario, .btn-peligro-lleno").click(); } });
    });
  };

  // Ejecuta una acción mostrando errores; si el servidor pide confirmar (stock), pregunta y reintenta.
  P.ejecutar = function (boton, trabajo) {
    if (boton) boton.disabled = true;
    return Promise.resolve().then(trabajo).catch(function (e) { P.error(e); throw e; }).finally(function () { if (boton) boton.disabled = false; });
  };

  // ------------------------------------------------------------------ autorizaciones (clave del día o aprobación a distancia)
  P.autorizar = function (tipo, opciones) {
    opciones = opciones || {};
    if (P.esAdmin()) return Promise.resolve({});
    var textos = {
      SOLICITUD_PRODUCTO: "Para pedir productos hace falta la autorización del administrador.",
      ANULAR_VENTA: "Para anular una venta hace falta la autorización del administrador.",
      VER_VENTAS_CAJA: "Para ver todas las ventas de la caja hace falta la autorización del administrador.",
    };
    return new Promise(function (resolver, rechazar) {
      var resuelto = false;
      var sondeo = null;
      var clave = P.h("input.campo-control", { type: "password", inputmode: "numeric", autocomplete: "off", placeholder: "Clave del administrador", style: { fontSize: "20px", letterSpacing: ".2em", textAlign: "center" } });
      var errorClave = P.h("div.campo-error", { hidden: true });
      var zonaRemota = P.h("div");
      function terminar(valor) {
        resuelto = true;
        if (sondeo) clearInterval(sondeo);
        m.cerrar();
        resolver(valor);
      }
      function probar() {
        var v = clave.value.trim();
        if (!v) { clave.focus(); return; }
        P.post("/permisos/probar-clave", { clave: v }).then(function () { terminar({ clave: v }); }).catch(function (e) {
          errorClave.hidden = false;
          errorClave.textContent = e.message;
          clave.select();
        });
      }
      function pedirRemoto(boton) {
        P.ejecutar(boton, function () {
          return P.post("/permisos", { tipo: tipo, referencia_id: opciones.referencia_id, detalle: opciones.detalle }).then(function (r) {
            P.reemplazar(zonaRemota, P.h("div.esperando", P.h("div.girando"),
              P.h("strong", "Esperando la respuesta del administrador…"),
              P.h("span.texto-3.chico", "Le llegó el aviso en su cuenta (en el camping o en Mi AJB). Esta ventana sigue sola cuando lo apruebe.")));
            sondeo = setInterval(function () {
              P.get("/permisos/" + r.id, { sinRedireccion: true }).then(function (x) {
                if (x.permiso.estado === "APROBADO") { P.aviso("El administrador aprobó tu pedido", "ok"); terminar({ permiso_id: r.id }); }
                else if (x.permiso.estado === "RECHAZADO") {
                  clearInterval(sondeo);
                  P.reemplazar(zonaRemota, P.h("div.mensaje.mensaje-error", P.icono("alerta"), P.h("div", "El administrador rechazó el pedido.")));
                }
              }).catch(function () { /* reintenta */ });
            }, 3000);
          });
        });
      }
      P.reemplazar(zonaRemota, P.btn("Pedir permiso al administrador a distancia", { tipo: "suave", icono: "mensaje", onclick: function (ev) { pedirRemoto(ev.currentTarget); } }));
      var m = P.modal({
        titulo: "Autorización del administrador",
        subtitulo: textos[tipo] || opciones.texto,
        contenido: P.h("div.columna",
          P.h("div.campo", P.h("span.campo-etiqueta", "Si el administrador está acá, que escriba la clave del día"), clave, errorClave),
          P.h("div.fila", P.h("div.espacio", { style: { height: "1px", background: "var(--linea)" } }), P.h("span.texto-3.chico", "o"), P.h("div.espacio", { style: { height: "1px", background: "var(--linea)" } })),
          zonaRemota),
        alCerrar: function () { if (sondeo) clearInterval(sondeo); if (!resuelto) rechazar(ErrorApi("Autorización cancelada", -1)); },
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Usar la clave", { tipo: "primario", icono: "llave", onclick: probar })],
      });
      clave.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); probar(); } });
    });
  };

  // Llama a la API agregando la autorización cuando el servidor la pide.
  P.conAutorizacion = function (tipo, opciones, llamada) {
    return llamada({}).catch(function (e) {
      if (e.codigo !== "SIN_AUTORIZACION" && e.codigo !== "CLAVE_INCORRECTA") throw e;
      return P.autorizar(tipo, opciones).then(function (aut) { return llamada(aut); });
    });
  };

  // Si el servidor avisa que falta stock, pregunta y reintenta con confirmar_sin_stock.
  P.conConfirmacionStock = function (llamada, textoAccion) {
    return llamada(false).catch(function (e) {
      if (e.codigo !== "STOCK_INSUFICIENTE") throw e;
      var lista = P.h("ul", (e.datos.faltantes || []).map(function (f) {
        return P.h("li", P.h("strong", f.producto), ": pedís " + P.f.numero(f.pedido) + " y el sistema tiene " + P.f.numero(f.disponible) + ".");
      }));
      return P.confirmar(P.h("div.columna", P.h("div.mensaje.mensaje-aviso", P.icono("alerta"), P.h("div", e.message, lista)),
        P.h("p", { style: { margin: 0 } }, "¿Estás seguro de la cantidad? Podés seguir igual: queda registrado.")), {
        titulo: "Revisá las cantidades", aceptar: textoAccion || "Seguir igual",
      }).then(function (ok) {
        if (!ok) throw ErrorApi("Operación cancelada", -1);
        return llamada(true);
      });
    });
  };

  // ------------------------------------------------------------------ rutas
  P.ruta = {
    registrar: function (patron, pantalla, opciones) {
      P.rutas.push(Object.assign({ patron: patron, pantalla: pantalla }, opciones || {}));
    },
    ir: function (ruta) {
      if (location.hash === "#" + ruta) window.dispatchEvent(new HashChangeEvent("hashchange"));
      else location.hash = ruta;
    },
    actual: function () { return (location.hash || "#/").slice(1).split("?")[0] || "/"; },
    query: function () {
      var q = (location.hash.split("?")[1] || "");
      var salida = {};
      q.split("&").filter(Boolean).forEach(function (p) { var kv = p.split("="); salida[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); });
      return salida;
    },
  };

  P.esAdmin = function () { return !!(P.estado.sesion && P.estado.sesion.usuario && P.estado.sesion.usuario.rol === "ADMIN"); };
  P.puesto = function () { return P.estado.sesion && P.estado.sesion.puesto; };
})();
