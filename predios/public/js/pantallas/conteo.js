/* Conteo de stock al cerrar la caja.
   - Cajero: antes del cierre temporal cuenta los productos que pide el sistema, a ciegas
     (no ve lo que dice el stock). Los pesables se cargan en kilos o en gramos.
   - Supervisión y Administración: ven el avance de la vuelta de cada boca, los conteos y
     deciden qué hacer con cada diferencia (ajustar el stock a lo contado o mantenerlo). */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  var ESTADOS = { PENDIENTE: "En curso", COMPLETO: "Sin diferencias", CON_DIFERENCIAS: "Con diferencias", REVISADO: "Revisado", ANULADO: "Sin contar" };
  var ESTADOS_ITEM = { PENDIENTE: "Sin contar", OK: "Coincide", DIFERENCIA: "No coincide", AJUSTADO: "Stock ajustado", DESCARTADO: "Se mantuvo el sistema" };

  function claveBorrador(id) { return "predio.conteo." + id; }
  function leerBorrador(id) { try { return JSON.parse(sessionStorage.getItem(claveBorrador(id)) || "{}") || {}; } catch (e) { return {}; } }
  function guardarBorrador(id, datos) { try { sessionStorage.setItem(claveBorrador(id), JSON.stringify(datos)); } catch (e) { /* sin almacenamiento */ } }
  function borrarBorrador(id) { try { sessionStorage.removeItem(claveBorrador(id)); } catch (e) { /* nada */ } }

  // ------------------------------------------------------------------ cajero
  // Devuelve una promesa: true para seguir con el cierre, false si el cajero lo dejó para después.
  P.conteoDeCierre = function (cajaId) {
    if (P.puedeGestionarCajas()) return Promise.resolve(true);
    return P.post("/conteos/cierre", { caja_id: cajaId }).then(function (r) {
      if (!r.requerido || r.completo || !r.conteo) return true;
      return new Promise(function (resolver) { modalConteo(r.conteo, resolver); });
    });
  };

  function modalConteo(conteo, resolver) {
    var borrador = leerBorrador(conteo.id);
    var terminado = false;
    var filas = conteo.items.map(function (it) {
      var previo = borrador[it.id] || {};
      var pesable = it.unidad === "KG";
      var unidad = previo.unidad || (pesable ? "kg" : "u");
      var input = P.input({ inputmode: "decimal", valor: previo.valor || "", placeholder: pesable ? (unidad === "g" ? "Ej.: 2350" : "Ej.: 2,350") : "Unidades" });
      input.classList.add("conteo-cantidad");
      input.setAttribute("aria-label", "Cantidad de " + it.nombre);
      var selector = pesable ? P.segmentado([{ valor: "kg", texto: "kg" }, { valor: "g", texto: "g" }], unidad, function (v) {
        unidad = v;
        input.placeholder = v === "g" ? "Ej.: 2350" : "Ej.: 2,350";
        guardar();
      }) : h("span.conteo-unidad", "unid.");
      var fila = { item: it, input: input, unidad: function () { return unidad; } };
      fila.el = h("li.conteo-fila",
        h("div.conteo-producto", h("strong", it.nombre), h("span.texto-3.chico", [it.codigo ? "Código " + it.codigo : null, pesable ? "Se pesa" : null].filter(Boolean).join(" · "))),
        h("div.conteo-ingreso", input, selector));
      input.addEventListener("input", function () { input.classList.remove("invalido"); guardar(); });
      input.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        var i = filas.indexOf(fila);
        if (filas[i + 1]) filas[i + 1].input.focus(); else enviar.focus();
      });
      return fila;
    });
    var progreso = h("p.conteo-progreso", { "aria-live": "polite" });
    function valorDe(f) {
      var t = f.input.value.trim();
      if (!t) return null;
      var n = P.numeroDe(t);
      if (!Number.isFinite(n) || n < 0) return NaN;
      if (f.item.unidad === "KG" && f.unidad() === "g") n = n / 1000;
      return P.redondear(n, 3);
    }
    function guardar() {
      var datos = {};
      filas.forEach(function (f) { if (f.input.value.trim() || f.unidad() !== (f.item.unidad === "KG" ? "kg" : "u")) datos[f.item.id] = { valor: f.input.value, unidad: f.unidad() }; });
      guardarBorrador(conteo.id, datos);
      var hechos = filas.filter(function (f) { return f.input.value.trim(); }).length;
      progreso.textContent = "Cargaste " + hechos + " de " + filas.length + (hechos === filas.length ? ". Revisá y enviá el conteo." : ".");
    }
    var enviar = P.btn("Enviar conteo", { tipo: "primario", icono: "check", onclick: function (ev) {
      var invalida = null;
      var items = filas.map(function (f) {
        var v = valorDe(f);
        if ((v === null || Number.isNaN(v)) && !invalida) invalida = f;
        var texto = f.input.value.trim();
        return { id: f.item.id, cantidad: v, ingreso: texto ? texto + " " + (f.item.unidad === "KG" ? f.unidad() : "u.") : null };
      });
      if (invalida) {
        invalida.input.classList.add("invalido");
        invalida.input.focus();
        P.aviso(Number.isNaN(valorDe(invalida)) ? "Revisá la cantidad de «" + invalida.item.nombre + "»." : "Falta la cantidad de «" + invalida.item.nombre + "». Si no hay, poné 0.", "error");
        return;
      }
      var boton = ev.currentTarget;
      P.confirmar("Una vez enviado no se puede cambiar. ¿Contaste todo lo que hay en la boca?", { titulo: "Enviar el conteo", aceptar: "Enviar" }).then(function (ok) {
        if (!ok) return;
        P.ejecutar(boton, function () {
          return P.post("/conteos/" + conteo.id + "/enviar", { items: items }).then(function (r) {
            borrarBorrador(conteo.id);
            terminado = true;
            m.cerrar();
            P.aviso(r.mensaje, r.diferencias ? "info" : "ok", 6000);
            resolver(true);
          });
        }).catch(function (e) {
          if (e.codigo === "CONTEO_ENVIADO") { terminado = true; m.cerrar(); resolver(true); }
        });
      });
    } });
    var m = P.modal({
      titulo: "Conteo de stock antes de cerrar",
      subtitulo: [conteo.boca, conteo.caja, "Conteo N° " + conteo.id].filter(Boolean).join(" · "),
      ancho: "ancha", modalFijo: true,
      contenido: h("div.columna.conteo",
        P.mensaje("Contá lo que hay físicamente en la boca y escribilo. No vas a ver lo que dice el sistema: si algo no coincide, lo revisa Supervisión. Si no hay nada de un producto, poné 0. Los que se pesan podés cargarlos en kilos o en gramos.", "info"),
        h("ol.conteo-lista", filas.map(function (f) { return f.el; })),
        progreso),
      acciones: [P.btn("Ahora no", { onclick: function () { m.cerrar(); } }), enviar],
      alCerrar: function () { if (!terminado) resolver(false); },
    });
    guardar();
  }

  // ------------------------------------------------------------------ Supervisión y Administración
  function textoCantidad(v, unidad) { return v == null ? "—" : P.f.cantidad(v, unidad) + (unidad === "KG" ? "" : " u."); }

  P.verConteo = function (id, alTerminar) {
    return P.get("/conteos/" + id).then(function (d) {
      var c = d.conteo;
      var pendientes = d.items.filter(function (i) { return i.estado === "DIFERENCIA"; });
      var decisiones = {};
      var motivo = P.input({ max: 250, placeholder: "Obligatorio si mantenés el stock del sistema" });
      var conValor = d.items.some(function (i) { return i.valor !== undefined; });
      var tabla = h("div.tabla-desplazable", h("table.tabla.conteo-detalle",
        h("thead", h("tr", h("th", "Producto"), h("th.der", "Sistema"), h("th.der", "Contado"), h("th.der", "Diferencia"),
          conValor ? h("th.der", "A costo") : null, h("th", "Estado"))),
        h("tbody", d.items.map(function (i) {
          var dif = i.diferencia;
          var estado = i.estado === "DIFERENCIA" && c.estado === "CON_DIFERENCIAS"
            ? P.segmentado([{ valor: "AJUSTAR", texto: "Ajustar al conteo" }, { valor: "MANTENER", texto: "Mantener" }], null, function (v) { decisiones[i.id] = v; })
            : h("div", P.chip(ESTADOS_ITEM[i.estado] || i.estado, i.estado),
              i.resuelto_por ? h("div.texto-3.chico", i.resuelto_por + (i.resolucion_motivo ? " · " + i.resolucion_motivo : "")) : null);
          return h("tr", h("td", h("strong", i.nombre), h("div.texto-3.chico", [i.codigo, i.ingreso ? "Escribió «" + i.ingreso + "»" : null, "Vuelta " + i.ronda].filter(Boolean).join(" · "))),
            h("td.der.numero", textoCantidad(i.sistema, i.unidad)), h("td.der.numero", textoCantidad(i.contado, i.unidad)),
            h("td.der.numero" + (dif < 0 ? ".negativo" : ""), dif == null ? "—" : (dif > 0 ? "+" : "") + textoCantidad(dif, i.unidad)),
            conValor ? h("td.der.dinero" + (i.valor < 0 ? ".negativo" : ""), i.valor == null ? "—" : P.f.pesos(i.valor)) : null,
            h("td", estado));
        }))));
      var revisar = c.estado === "CON_DIFERENCIAS" && pendientes.length;
      var m = P.modal({
        titulo: "Conteo N° " + c.id + " · " + c.boca + (c.caja ? " · " + c.caja : ""),
        subtitulo: (c.usuario_nombre || "") + (c.fecha_fin ? " · " + P.f.fechaHora(c.fecha_fin) : "") + " · " + (ESTADOS[c.estado] || c.estado),
        ancho: "ancha",
        contenido: h("div.columna",
          revisar ? P.mensaje("«Ajustar al conteo» suma o resta la diferencia al stock actual de la boca (queda como «Ajuste por conteo» en Movimientos). «Mantener» deja el stock como está; contá por qué.", "info") : null,
          tabla,
          revisar ? P.campo("Motivo u observación", motivo) : null,
          c.revisado_por ? h("p.texto-3.chico", "Revisó " + c.revisado_por + " el " + P.f.fechaHora(c.revisado_fecha) + ".") : null),
        acciones: [P.btn("Cerrar", { onclick: function () { m.cerrar(); } }),
          revisar ? P.btn("Guardar decisiones", { tipo: "primario", icono: "check", onclick: function (ev) {
            var items = Object.keys(decisiones).map(function (k) { return { id: Number(k), accion: decisiones[k] }; });
            if (!items.length) { P.aviso("Elegí qué hacer con al menos una diferencia", "error"); return; }
            if (items.some(function (x) { return x.accion === "MANTENER"; }) && !motivo.value.trim()) { motivo.classList.add("invalido"); motivo.focus(); P.aviso("Contá por qué mantenés el stock del sistema", "error"); return; }
            P.ejecutar(ev.currentTarget, function () {
              return P.post("/conteos/" + c.id + "/resolver", { items: items, motivo: motivo.value }).then(function (r) {
                if (!r.encolado) P.aviso(r.mensaje, "ok");
                m.cerrar();
                if (alTerminar) alTerminar(r);
              });
            }).catch(function () {});
          } }) : null],
      });
    }).catch(P.error);
  };

  function panelProgreso(cont) {
    return P.get("/conteos/progreso").then(function (r) {
      var avisoApagado = !r.config.activo ? P.mensaje(h("span", "El conteo al cerrar la caja está apagado. ",
        P.esAdmin() ? h("a", { href: "#/sistema/configuracion" }, "Activalo en Sistema → Configuración.") : "Lo activa Administración."), "aviso") : null;
      var tarjetas = r.bocas.map(function (b) {
        var pct = b.productos ? Math.round(b.contados_ronda * 100 / b.productos) : 0;
        return h("li.conteo-boca",
          h("div.conteo-boca-cabecera", h("strong", b.boca), b.por_revisar ? P.chip(b.por_revisar + (b.por_revisar === 1 ? " por revisar" : " por revisar"), "CON_DIFERENCIAS") : null),
          h("div.conteo-barra", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": "Avance de la vuelta en " + b.boca },
            h("span", { style: { width: pct + "%" } })),
          h("div.texto-3.chico", b.productos
            ? "Vuelta " + b.ronda + ": " + P.f.entero(b.contados_ronda) + " de " + P.f.entero(b.productos) + " productos contados · " + P.f.entero(b.por_cierre) + " por cierre"
            : "Sin productos con stock"),
          h("div.texto-3.chico", b.ultimo_conteo ? "Último conteo: " + P.f.fechaHora(b.ultimo_conteo) : "Todavía sin conteos"));
      });
      P.reemplazar(cont, avisoApagado,
        h("p.texto-3", { style: { margin: 0 } }, "Cada cierre pide el " + P.f.numero(r.config.porcentaje) + " % de los productos con stock de la boca, sin repetir hasta completar la vuelta. Tolerancia en pesables: " + P.f.numero(r.config.tolerancia) + " %."),
        tarjetas.length ? h("ul.conteo-bocas", tarjetas) : null);
    }).catch(function (e) { P.reemplazar(cont, P.mensaje(e.message, "error")); });
  }

  P.ruta.registrar(/^\/gestion\/conteos$/, function (c) {
    var q = P.ruta.query();
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/gestion/productos" }, P.icono("volver"), "Productos y stock general"),
      h("h1.titulo-pagina", "Conteos de stock"),
      h("p.subtitulo", "Lo que contaron los cajeros al cerrar la caja. Las diferencias se ajustan o se mantienen desde cada conteo."))));
    var progreso = h("div.hoja.hoja-cuerpo.columna", P.cargando());
    c.appendChild(progreso);
    var tabla = P.tabla({
      listado: "conteos",
      filtrosIniciales: q.estado ? { estado: q.estado } : {},
      alClickFila: function (f) { P.verConteo(f.id, function () { tabla.recargar(); panelProgreso(progreso); }); },
    });
    c.appendChild(tabla.el);
    panelProgreso(progreso);
    if (q.id) P.verConteo(Number(q.id), function () { tabla.recargar(); panelProgreso(progreso); });
  }, { cajas: true, titulo: "Conteos de stock" });
})();
