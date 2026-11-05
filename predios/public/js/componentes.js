/* Componentes: tabla de listados, desplegable con buscador (y escáner), campos, gráficos. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  // ------------------------------------------------------------------ campos
  P.campo = function (etiqueta, control, opciones) {
    opciones = opciones || {};
    return h("label.campo" + (opciones.clase ? "." + opciones.clase : ""), { style: opciones.estilo },
      etiqueta ? h("span.campo-etiqueta", etiqueta, opciones.requerido ? h("span", { "aria-hidden": "true", style: { color: "var(--error)" } }, " *") : null) : null,
      control,
      opciones.ayuda ? h("span.campo-ayuda", opciones.ayuda) : null);
  };
  P.input = function (opciones) {
    opciones = opciones || {};
    var el = h("input.campo-control", {
      type: opciones.tipo || "text", value: opciones.valor === undefined || opciones.valor === null ? "" : opciones.valor,
      placeholder: opciones.placeholder, maxlength: opciones.max, min: opciones.min, step: opciones.step,
      inputmode: opciones.inputmode, autocomplete: opciones.autocomplete || "off", name: opciones.nombre,
      readonly: opciones.soloLectura, required: opciones.requerido, id: opciones.id, autofocus: opciones.autofocus,
    });
    if (opciones.alCambiar) el.addEventListener("input", function () { opciones.alCambiar(el.value); });
    return el;
  };
  // Contraseña con el botón para verla adentro del recuadro (mismo ancho que los otros campos).
  // Devuelve el contenedor; el input está en .input.
  P.inputClave = function (opciones) {
    var input = P.input(Object.assign({ autocomplete: "new-password" }, opciones || {}, { tipo: "password" }));
    var ojo = h("button.campo-ojo", { type: "button", "aria-label": "Mostrar contraseña", "aria-pressed": "false" }, P.icono("ojo"));
    ojo.addEventListener("click", function () {
      var ver = input.type === "password";
      input.type = ver ? "text" : "password";
      ojo.setAttribute("aria-label", ver ? "Ocultar contraseña" : "Mostrar contraseña");
      ojo.setAttribute("aria-pressed", String(ver));
      P.reemplazar(ojo, P.icono(ver ? "ojo-tachado" : "ojo"));
      input.focus();
    });
    var cont = h("div.campo-clave", input, ojo);
    cont.input = input;
    return cont;
  };
  P.dinero = function (opciones) {
    var input = P.input(Object.assign({ inputmode: "decimal", placeholder: "0,00" }, opciones || {}));
    input.style.textAlign = "right";
    return input;
  };
  P.select = function (opciones, valor, extra) {
    extra = extra || {};
    var el = h("select.campo-control", { name: extra.nombre, id: extra.id });
    if (extra.vacio !== undefined) el.appendChild(h("option", { value: "" }, extra.vacio));
    opciones.forEach(function (o) {
      var op = h("option", { value: o.valor }, o.texto);
      if (String(o.valor) === String(valor)) op.selected = true;
      el.appendChild(op);
    });
    if (extra.alCambiar) el.addEventListener("change", function () { extra.alCambiar(el.value); });
    return el;
  };
  P.check = function (texto, marcado, ayuda, alCambiar) {
    var input = h("input", { type: "checkbox", checked: !!marcado });
    if (alCambiar) input.addEventListener("change", function () { alCambiar(input.checked); });
    var label = h("label.check", input, h("span", texto, ayuda ? h("small", ayuda) : null));
    label.input = input;
    return label;
  };
  P.segmentado = function (opciones, valor, alCambiar) {
    var cont = h("div.segmentado", { role: "group" });
    function pintar() {
      P.vaciar(cont);
      opciones.forEach(function (o) {
        cont.appendChild(h("button", { type: "button", "aria-pressed": String(String(o.valor) === String(valor)), onclick: function () {
          valor = o.valor; pintar(); if (alCambiar) alCambiar(valor);
        } }, o.texto));
      });
    }
    pintar();
    cont.valor = function () { return valor; };
    cont.fijar = function (v) { valor = v; pintar(); };
    return cont;
  };
  P.mensaje = function (texto, tipo, icono) {
    return h("div.mensaje" + (tipo ? ".mensaje-" + tipo : ""), P.icono(icono || (tipo === "error" || tipo === "aviso" ? "alerta" : tipo === "ok" ? "check" : "info")), h("div", texto));
  };
  P.cargando = function (texto) { return h("div.cargando", h("div.girando"), texto || "Cargando…"); };
  P.vacio = function (icono, titulo, texto, accion) {
    return h("div.tabla-vacia", h("div.medallon", P.icono(icono || "lista")), h("div.seccion-titulo", titulo), texto ? h("p", { style: { margin: "6px 0 0" } }, texto) : null,
      accion ? h("div", { style: { marginTop: "14px" } }, accion) : null);
  };
  P.cifra = function (etiqueta, valor, pie) {
    return h("div.hoja.cifra", h("div.cifra-etiqueta", etiqueta), h("div.cifra-valor", valor), pie ? h("div.cifra-pie", pie) : null);
  };
  P.dato = function (etiqueta, valor) { return h("div.dato", h("span", etiqueta), h("strong", valor === null || valor === undefined || valor === "" ? "—" : valor)); };

  var CHIPS = {
    CONFIRMADA: "ok", CARGADA: "ok", RECIBIDA: "ok", APROBADO: "ok", PAGADA: "ok", CORRECTO: "ok", OK: "ok", ABIERTO: "curso",
    ANULADA: "error", RECHAZADA: "error", RECHAZADO: "error", NO_COINCIDE: "error", ERROR: "error",
    PENDIENTE: "accion", DESPACHADA: "curso", ENTREGADO: "curso", USADO: "anillo", VENCIDO: "anillo", CANCELADO: "anillo", CERRADO: "anillo",
  };
  P.chip = function (texto, valor) {
    var tipo = CHIPS[valor] || (valor === true ? "ok" : valor === false ? "anillo" : "");
    return h("span.chip" + (tipo ? ".chip-" + tipo : ""), texto);
  };

  P.formatoCelda = function (col, valor) {
    if (valor === null || valor === undefined || valor === "") return col.tipo === "bool" ? "—" : "";
    switch (col.tipo) {
      case "money": return h("span.dinero" + (col.signo && Number(valor) < 0 ? ".negativo" : ""), P.f.pesos(valor));
      case "qty": return h("span.numero" + (col.signo ? (Number(valor) < 0 ? ".negativo" : ".positivo") : (Number(valor) < 0 ? ".negativo" : "")), (col.signo && Number(valor) > 0 ? "+" : "") + P.f.numero(valor));
      case "pct": return P.f.pct(valor);
      case "int": return P.f.entero(valor);
      case "bool": return Number(valor) ? "Sí" : "—";
      case "date": return P.f.fecha(valor);
      case "dt": return P.f.fechaHora(valor);
      case "opcion": {
        var o = (col.opciones || []).filter(function (x) { return x.valor === valor; })[0];
        return CHIPS[valor] ? P.chip(o ? o.texto : valor, valor) : (o ? o.texto : valor);
      }
      case "json": {
        var t = String(valor);
        try {
          var j = JSON.parse(t);
          if (j && typeof j === "object") t = Object.keys(j).slice(0, 4).map(function (k) {
            var v = j[k];
            if (v && typeof v === "object" && "despues" in v) v = (v.antes === null ? "—" : v.antes) + " → " + (v.despues === null ? "—" : v.despues);
            else if (v && typeof v === "object") v = JSON.stringify(v);
            return k.replace(/_/g, " ") + ": " + v;
          }).join(" · ");
        } catch (e) { /* texto */ }
        return h("span.chico", { title: String(valor) }, t.length > 140 ? t.slice(0, 140) + "…" : t);
      }
      default: return String(valor);
    }
  };
  var ALINEA_DERECHA = ["money", "qty", "pct", "int"];

  // ------------------------------------------------------------------ menú flotante
  P.menuFlotante = function (ancla, items) {
    var previo = document.querySelector(".menu-flotante");
    if (previo) previo.remove();
    var menu = h("div.menu-flotante", { role: "menu" }, items.map(function (it) {
      if (it === "-") return h("hr");
      return h("button", { type: "button", role: "menuitem", onclick: function () { cerrar(); it.accion(); } }, it.icono ? P.icono(it.icono) : null, it.texto);
    }));
    document.body.appendChild(menu);
    var r = ancla.getBoundingClientRect();
    var ancho = menu.offsetWidth;
    var izquierda = Math.min(window.innerWidth - ancho - 12, Math.max(12, r.right - ancho));
    var arriba = r.bottom + 6 + window.scrollY;
    if (r.bottom + menu.offsetHeight + 12 > window.innerHeight) arriba = r.top - menu.offsetHeight - 6 + window.scrollY;
    menu.style.left = izquierda + "px";
    menu.style.top = arriba + "px";
    function cerrar() { menu.remove(); document.removeEventListener("mousedown", fuera, true); }
    function fuera(ev) { if (!menu.contains(ev.target) && ev.target !== ancla) cerrar(); }
    setTimeout(function () { document.addEventListener("mousedown", fuera, true); }, 0);
    return { cerrar: cerrar };
  };

  // ------------------------------------------------------------------ desplegable con buscador (y escáner de códigos)
  // Se puede escribir para filtrar. Si el texto coincide exacto con un código (lo que manda
  // el escáner, que "tipea" y presiona Enter), se elige solo.
  P.combo = function (opciones) {
    var actual = opciones.valor !== undefined && opciones.valor !== null && opciones.valor !== "" ? { valor: opciones.valor, texto: opciones.texto || "" } : null;
    var lista = null;
    var resultados = [];
    var indice = -1;
    var pedido = 0;
    var seleccionando = false;
    var enterPendiente = 0;
    var input = h("input.campo-control", {
      type: "text", placeholder: opciones.placeholder || "Escribí para buscar…", autocomplete: "off", spellcheck: "false",
      role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", id: opciones.id, autofocus: opciones.autofocus,
    });
    if (actual) input.value = actual.texto;
    var cont = h("div.combo" + (opciones.clase ? "." + opciones.clase : ""), input);

    function fuenteLocal(texto) {
      var base = typeof opciones.opciones === "function" ? opciones.opciones() : (opciones.opciones || []);
      return Promise.resolve(base).then(function (todas) {
        var n = normalizar(texto);
        if (!n) return todas.slice(0, opciones.maximo || 200);
        var palabras = n.split(/\s+/);
        return todas.filter(function (o) {
          var hay = normalizar(o.texto + " " + (o.detalle || "") + " " + (o.codigo || ""));
          return palabras.every(function (p) { return hay.indexOf(p) >= 0; });
        }).sort(function (a, b) {
          var ea = a.codigo && String(a.codigo) === texto ? 0 : 1;
          var eb = b.codigo && String(b.codigo) === texto ? 0 : 1;
          return ea - eb;
        }).slice(0, opciones.maximo || 200);
      });
    }
    function normalizar(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }

    function buscar(texto) {
      var n = ++pedido;
      input.setAttribute("aria-busy", "true");
      var promesa = opciones.buscar ? opciones.buscar(texto) : opciones.fuente ? P.opciones(opciones.fuente).then(function (ops) { opciones.opciones = ops; delete opciones.fuente; return fuenteLocal(texto); }) : fuenteLocal(texto);
      return promesa.then(function (r) {
        if (n === pedido && !seleccionando) {
          input.setAttribute("aria-busy", "false");
          resultados = r || []; indice = -1; pintar(texto);
        }
        return r;
      }).catch(function (e) {
        if (n === pedido) { input.setAttribute("aria-busy", "false"); cerrarLista(); }
        throw e;
      });
    }

    // La lista flota sobre la página (position: fixed, en el body): ninguna ventana ni tabla con
    // desplazamiento propio la recorta. Se abre hacia arriba si abajo no entra.
    function abrir() {
      if (!lista) {
        lista = h("div.combo-lista", { role: "listbox" });
        document.body.appendChild(lista);
        input.setAttribute("aria-expanded", "true");
        window.addEventListener("scroll", ubicar, true);
        window.addEventListener("resize", ubicar);
      }
    }
    function ubicar(ev) {
      if (!lista) return;
      if (ev && ev.type === "scroll" && lista.contains(ev.target)) return;
      var r = input.getBoundingClientRect();
      // En el celular, con el teclado abierto, sólo cuenta la parte visible de la pantalla.
      var alto = window.visualViewport ? Math.min(window.innerHeight, window.visualViewport.height + window.visualViewport.offsetTop) : window.innerHeight;
      if (r.bottom < 0 || r.top > alto || !input.offsetParent) { cerrarLista(); return; }
      var abajo = alto - r.bottom - 10;
      var arriba = r.top - 10;
      var deseado = Math.min(340, lista.scrollHeight + 2);
      var haciaArriba = abajo < Math.min(deseado, 220) && arriba > abajo;
      var maximo = Math.max(140, Math.min(340, (haciaArriba ? arriba : abajo) - 6));
      var ancho = Math.min(Math.max(r.width, 280), window.innerWidth - 16);
      lista.style.left = Math.max(8, Math.min(r.left, window.innerWidth - ancho - 8)) + "px";
      lista.style.width = ancho + "px";
      lista.style.maxHeight = maximo + "px";
      if (haciaArriba) { lista.style.top = "auto"; lista.style.bottom = (alto - r.top + 6) + "px"; }
      else { lista.style.bottom = "auto"; lista.style.top = (r.bottom + 6) + "px"; }
    }
    function cerrarLista() {
      pedido++;
      enterPendiente++;
      input.setAttribute("aria-busy", "false");
      if (lista) {
        lista.remove();
        lista = null;
        window.removeEventListener("scroll", ubicar, true);
        window.removeEventListener("resize", ubicar);
      }
      input.setAttribute("aria-expanded", "false");
      indice = -1;
    }
    function pintar(texto) {
      abrir();
      P.vaciar(lista);
      if (!resultados.length) lista.appendChild(h("div.combo-vacio", texto ? "No hay coincidencias para «" + texto + "»" : "No hay opciones"));
      if (resultados.some(function (o) { return o.requiereEleccion; })) {
        lista.appendChild(h("div.combo-ayuda", { role: "status" }, "El código completo no coincide. Revisá el envase y elegí el producto de la lista para continuar."));
      }
      resultados.forEach(function (o, i) {
        lista.appendChild(h("button.combo-opcion", { type: "button", role: "option", "aria-selected": String(i === indice), onclick: function () { elegir(o); }, onmousedown: function (ev) { ev.preventDefault(); } },
          h("div", h("div.combo-opcion-principal", o.texto), o.detalle ? h("div.combo-opcion-detalle", o.detalle) : null),
          o.lado ? h("div.combo-opcion-lado", o.lado) : null));
      });
      if (opciones.accionExtra) {
        lista.appendChild(h("button.combo-accion", { type: "button", onmousedown: function (ev) { ev.preventDefault(); cerrarLista(); opciones.accionExtra.onclick(input.value); } },
          P.icono("mas"), opciones.accionExtra.texto));
      }
      ubicar();
    }
    function mover(d) {
      if (!lista || !resultados.length) return;
      indice = (indice + d + resultados.length) % resultados.length;
      Array.prototype.forEach.call(lista.querySelectorAll(".combo-opcion"), function (el, i) {
        el.setAttribute("aria-selected", String(i === indice));
        if (i === indice) el.scrollIntoView({ block: "nearest" });
      });
    }
    function elegir(o) {
      if (seleccionando) return;
      seleccionando = true;
      cerrarLista();
      Promise.resolve().then(function () { return opciones.antesDeElegir ? opciones.antesDeElegir(o) : true; }).then(function (permitido) {
        if (permitido === false) return;
        actual = o;
        input.value = opciones.limpiarAlElegir ? "" : o.texto;
        if (opciones.alElegir) opciones.alElegir(o);
        if (opciones.limpiarAlElegir) { actual = null; input.focus(); }
      }).catch(P.error).finally(function () { seleccionando = false; });
    }

    var temporizador = null;
    input.addEventListener("input", function () {
      actual = null;
      cerrarLista();
      resultados = [];
      enterPendiente++;
      if (opciones.alCambiarTexto) opciones.alCambiarTexto(input.value);
      clearTimeout(temporizador);
      temporizador = setTimeout(function () { if (!seleccionando) buscar(input.value.trim()).catch(P.error); }, opciones.buscar ? 160 : 40);
    });
    input.addEventListener("focus", function () { if (!seleccionando && opciones.abrirAlEnfocar !== false) buscar(actual ? "" : input.value.trim()).catch(P.error); });
    input.addEventListener("blur", function () {
      setTimeout(function () {
        if (document.activeElement === input) return;
        if (lista && lista.contains(document.activeElement)) return;
        cerrarLista();
        if (!seleccionando && !actual && !opciones.textoLibre && !opciones.limpiarAlElegir) input.value = "";
        if (actual) input.value = actual.texto;
      }, 120);
    });
    input.addEventListener("keydown", function (ev) {
      if (seleccionando) { if (ev.key === "Enter") ev.preventDefault(); return; }
      if (ev.key === "ArrowDown") { ev.preventDefault(); if (!lista) buscar(input.value.trim()).catch(P.error); else mover(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); mover(-1); }
      else if (ev.key === "Escape") { if (lista) { ev.stopPropagation(); cerrarLista(); } }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        var texto = input.value.trim();
        if (lista && indice >= 0 && resultados[indice] && !resultados[indice].requiereEleccion) { elegir(resultados[indice]); return; }
        clearTimeout(temporizador);
        var intento = ++enterPendiente;
        // Escáner: se resuelve con el texto completo, sin esperar la búsqueda en curso.
        buscar(texto).then(function (r) {
          if (intento !== enterPendiente || texto !== input.value.trim() || seleccionando) return;
          r = r || [];
          var exactos = r.filter(function (o) { return !o.requiereEleccion && (o.exacto || (o.codigo && String(o.codigo) === texto)); });
          if (exactos.length === 1) elegir(exactos[0]);
          else if (r.length === 1 && texto && opciones.elegirUnico !== false && !r[0].requiereEleccion) elegir(r[0]);
          else if (r.length && opciones.alEnterConResultados) opciones.alEnterConResultados(texto, r);
          else if (!r.length && opciones.alEnterSinCoincidencia) opciones.alEnterSinCoincidencia(texto);
        }).catch(P.error);
      }
    });

    return {
      el: cont,
      input: input,
      valor: function () { return actual ? actual.valor : null; },
      opcion: function () { return actual; },
      fijar: function (valor, texto, extra) { actual = valor === null || valor === undefined ? null : Object.assign({ valor: valor, texto: texto }, extra || {}); input.value = actual ? texto : ""; },
      limpiar: function () { actual = null; input.value = ""; cerrarLista(); },
      foco: function () { input.focus(); },
      recargar: function (ops) { opciones.opciones = ops; },
    };
  };

  // Una sugerencia nunca cambia el catálogo hasta que la persona compara ambos códigos.
  P.confirmarCodigoProducto = function (producto, codigoLeido) {
    return new Promise(function (resolver) {
      var correcto = P.btn("Corregir y usar producto", { tipo: "primario", icono: "check", onclick: function () {
        continuar.disabled = true;
        P.ejecutar(correcto, function () {
          return P.post("/productos/" + producto.id + "/codigo-barras", {
            codigo_anterior: producto.codigo, codigo_nuevo: codigoLeido, confirmar: true,
          }).then(function (r) {
            if (!r.encolado) { producto.codigo = r.codigo; P.aviso(r.mensaje || "Código de barras corregido", "ok"); }
            m.cerrar(true);
          });
        }).catch(function () {}).finally(function () { continuar.disabled = false; });
      } });
      var continuar = P.btn("Continuar sin modificar", { tipo: "secundario", onclick: function () { m.cerrar(true); } });
      var m = P.modal({
        titulo: "Verificá el código de barras",
        contenido: h("div.columna",
          P.mensaje("La coincidencia es aproximada. Comprobá que el nombre, la presentación y el envase correspondan al mismo producto antes de corregirlo.", "aviso"),
          h("div.datos.codigo-comparacion", P.dato("Producto elegido", producto.nombre), P.dato("Código guardado", producto.codigo || "Sin código"), P.dato("Código leído", codigoLeido)),
          h("p.texto-3.chico", "Si confirmás la corrección, las próximas lecturas de este código encontrarán el producto directamente.")),
        acciones: [continuar, correcto],
        alCerrar: function (v) { resolver(v === true); },
      });
    });
  };

  // Desplegable de productos (busca en el servidor; acepta código de barras).
  P.comboProducto = function (opciones) {
    opciones = opciones || {};
    var config = Object.assign({
      placeholder: "Escaneá el código o escribí el nombre del producto",
      elegirUnico: false,
      buscar: function (texto) {
        return P.get("/productos/buscar" + P.qs({ q: texto, boca_id: opciones.bocaId ? opciones.bocaId() : null, venta: opciones.venta ? 1 : null, sin_stock: opciones.sinStock ? 1 : null })).then(function (r) {
          return r.map(function (p) {
            return {
              valor: p.id, texto: p.nombre, codigo: p.codigo, exacto: p.exacto, dato: p, busqueda: texto,
              requiereEleccion: !!p.sugerido,
              detalle: [p.sugerido ? "Código aproximado: revisá el envase" : null, p.codigo ? "Código " + p.codigo : null, opciones.mostrarStock && opciones.bocaId && opciones.bocaId() ? "Stock en la boca: " + P.f.numero(p.stock_boca) : null].filter(Boolean).join(" · "),
              lado: opciones.ladoCompra ? P.f.pesos(p.precio_compra) : P.f.pesos(p.precio_venta),
            };
          });
        });
      },
    }, opciones);
    config.antesDeElegir = function (o) {
      var comprobacion = o.requiereEleccion ? P.confirmarCodigoProducto(o.dato, o.busqueda) : Promise.resolve(true);
      return comprobacion.then(function (permitido) {
        if (!permitido) return false;
        o.codigo = o.dato.codigo;
        return opciones.antesDeElegir ? opciones.antesDeElegir(o) : true;
      });
    };
    return P.combo(config);
  };

  // ------------------------------------------------------------------ tabla de listados
  var metas = {};
  P.metaListado = function (nombre) {
    if (metas[nombre]) return Promise.resolve(metas[nombre]);
    return P.get("/listados/" + nombre + "/meta").then(function (m) { metas[nombre] = m; return m; });
  };

  // Columnas de nombres largos (productos, proveedores): no se parten en muchos renglones.
  var COLUMNAS_ANCHAS = ["nombre", "producto", "razon_social", "proveedor"];

  P.tabla = function (opciones) {
    var nombre = opciones.listado;
    var claveEstado = "tabla:" + (opciones.claveEstado || nombre);
    var guardado = P.cache[claveEstado] || {};
    var estado = {
      q: guardado.q || "",
      orden: guardado.orden || null,
      dir: guardado.dir || null,
      pagina: guardado.pagina || 1,
      tam: guardado.tam || opciones.tam || 25,
      filtros: Object.assign({}, guardado.filtros || opciones.filtrosIniciales || {}),
    };
    var meta = null;
    var raiz = h("div.hoja.tabla-caja");
    var barra = h("div.tabla-barra");
    var cuerpo = h("div.tabla-desplazable");
    var pie = h("div.tabla-pie");
    // Barra lateral propia + paginador: flotan abajo de la pantalla mientras se recorre una tabla
    // alta, así no hay que bajar hasta el final para moverse a los costados o cambiar de página.
    var desliz = h("div.tabla-desliz", { "aria-hidden": "true" }, h("div.tabla-desliz-ancho"));
    desliz.hidden = true;
    var flotante = h("div.tabla-flotante", desliz, pie);
    raiz.appendChild(barra);
    raiz.appendChild(cuerpo);
    raiz.appendChild(flotante);
    cuerpo.addEventListener("scroll", function () { if (desliz.scrollLeft !== cuerpo.scrollLeft) desliz.scrollLeft = cuerpo.scrollLeft; });
    desliz.addEventListener("scroll", function () { if (cuerpo.scrollLeft !== desliz.scrollLeft) cuerpo.scrollLeft = desliz.scrollLeft; });
    function medirDesliz() {
      var sobra = cuerpo.scrollWidth > cuerpo.clientWidth + 1;
      desliz.hidden = !sobra;
      if (!sobra) return;
      desliz.firstChild.style.width = cuerpo.scrollWidth + "px";
      desliz.scrollLeft = cuerpo.scrollLeft;
    }
    if (window.ResizeObserver) {
      new ResizeObserver(function () { medirDesliz(); }).observe(cuerpo);
    } else {
      var alRedimensionar = function () {
        if (!document.body.contains(raiz)) { window.removeEventListener("resize", alRedimensionar); return; }
        medirDesliz();
      };
      window.addEventListener("resize", alRedimensionar);
    }
    cuerpo.appendChild(P.cargando());
    var pedido = 0;

    // Selección de filas (opciones.seleccion = { singular, plural, acciones: [{ texto, icono, tipo, accion(eleccion, despues) }] }).
    // Se mantiene al cambiar de página u orden; se limpia al cambiar la búsqueda o los filtros.
    var sel = opciones.seleccion ? { ids: {}, cantidad: 0, todos: false } : null;
    var barraSel = h("div.tabla-seleccion", { "aria-live": "polite" });
    barraSel.hidden = true;
    if (sel) raiz.insertBefore(barraSel, cuerpo);
    var ultimos = null;
    var firma = null;

    function firmaConsulta() { return JSON.stringify({ q: estado.q, f: estado.filtros }); }
    function limpiarSeleccion() {
      if (!sel) return;
      sel.ids = {};
      sel.cantidad = 0;
      sel.todos = false;
      pintarSeleccion();
      marcarFilas();
    }
    function alternar(id, si) {
      if (si && !sel.ids[id]) { sel.ids[id] = true; sel.cantidad++; }
      else if (!si && sel.ids[id]) { delete sel.ids[id]; sel.cantidad--; }
    }
    function marcarFilas() {
      if (!sel) return;
      var filas = ultimos ? ultimos.filas : [];
      Array.prototype.forEach.call(cuerpo.querySelectorAll("input[data-sel]"), function (i) {
        i.checked = sel.todos || !!sel.ids[i.getAttribute("data-sel")];
        i.disabled = sel.todos;
      });
      var cabecera = cuerpo.querySelector("input[data-sel-todos]");
      if (cabecera) {
        var marcadas = filas.filter(function (f) { return sel.ids[f.id]; }).length;
        cabecera.checked = sel.todos || (filas.length > 0 && marcadas === filas.length);
        cabecera.indeterminate = !sel.todos && marcadas > 0 && marcadas < filas.length;
      }
    }
    function pintarSeleccion() {
      if (!sel) return;
      P.vaciar(barraSel);
      var total = ultimos ? ultimos.total : 0;
      var n = sel.todos ? total : sel.cantidad;
      barraSel.hidden = !n;
      if (!n) return;
      var cfg = opciones.seleccion;
      var singular = cfg.singular || "registro", plural = cfg.plural || "registros";
      barraSel.appendChild(h("span.tabla-seleccion-texto", sel.todos
        ? "Elegiste los " + P.f.entero(total) + " " + plural + " que coinciden con la búsqueda y los filtros"
        : P.f.entero(n) + " " + (n === 1 ? singular + " elegido" : plural + " elegidos")));
      var filas = ultimos ? ultimos.filas : [];
      var paginaEntera = filas.length > 0 && filas.every(function (f) { return sel.ids[f.id]; });
      if (!sel.todos && paginaEntera && total > filas.length) {
        barraSel.appendChild(P.btn("Elegir los " + P.f.entero(total) + " que coinciden", { tipo: "texto", chico: true, onclick: function () {
          sel.todos = true; pintarSeleccion(); marcarFilas();
        } }));
      }
      barraSel.appendChild(h("div.espacio"));
      (cfg.acciones || []).forEach(function (a) {
        barraSel.appendChild(P.btn(a.texto, { tipo: a.tipo || "secundario", chico: true, icono: a.icono, onclick: function () {
          var eleccion = sel.todos
            ? { consulta: parametros(), cantidad: total }
            : { ids: Object.keys(sel.ids).map(Number), cantidad: sel.cantidad };
          a.accion(eleccion, function () { limpiarSeleccion(); return recargar(); });
        } }));
      });
      barraSel.appendChild(P.btn("Quitar la selección", { tipo: "texto", chico: true, onclick: limpiarSeleccion }));
    }
    function celdaSeleccion(f) {
      var nombre = f.nombre || f.razon_social || f.descripcion || ("ID " + f.id);
      var input = h("input", { type: "checkbox", "data-sel": String(f.id), "aria-label": "Elegir " + nombre, onchange: function () {
        alternar(String(f.id), input.checked); pintarSeleccion(); marcarFilas();
      } });
      return h("td.col-sel", h("label.sel-celda", input));
    }
    function cabeceraSeleccion(filas) {
      var input = h("input", { type: "checkbox", "data-sel-todos": "", "aria-label": "Elegir todos los de esta página", onchange: function () {
        if (sel.todos) { limpiarSeleccion(); return; }
        filas.forEach(function (f) { alternar(String(f.id), input.checked); });
        pintarSeleccion(); marcarFilas();
      } });
      return h("th.col-sel", { scope: "col" }, h("label.sel-celda", input));
    }

    function guardar() { P.cache[claveEstado] = { q: estado.q, orden: estado.orden, dir: estado.dir, pagina: estado.pagina, tam: estado.tam, filtros: estado.filtros }; }

    function parametros(extra) {
      var p = Object.assign({}, opciones.filtrosFijos || {});
      Object.keys(estado.filtros).forEach(function (k) {
        var v = estado.filtros[k];
        if (v !== undefined && v !== null && v !== "") p["f_" + k] = v;
      });
      (meta ? meta.filtros : []).forEach(function (f) {
        if (f.defecto !== undefined && !(f.clave in estado.filtros)) p["f_" + f.clave] = f.defecto;
        if (estado.filtros[f.clave] === "") p["f_" + f.clave] = "todos";
      });
      if (estado.q) p.q = estado.q;
      if (estado.orden) { p.orden = estado.orden; p.dir = estado.dir || "asc"; }
      return Object.assign(p, extra || {});
    }

    function armarBarra() {
      P.vaciar(barra);
      if (meta.buscador && opciones.buscador !== false) {
        var buscar = P.input({ tipo: "search", valor: estado.q, placeholder: opciones.placeholderBuscar || "Buscar…" });
        var t = null;
        buscar.addEventListener("input", function () {
          clearTimeout(t);
          t = setTimeout(function () { estado.q = buscar.value.trim(); estado.pagina = 1; cargar(); }, 300);
        });
        barra.appendChild(P.campo("Buscar", buscar, { clase: "tabla-buscar" }));
      }
      var ocultos = opciones.filtrosOcultos || [];
      meta.filtros.forEach(function (f) {
        if (ocultos.indexOf(f.clave) >= 0) return;
        var valor = f.clave in estado.filtros ? estado.filtros[f.clave] : (f.defecto !== undefined ? f.defecto : "");
        var control;
        if (f.tipo === "opciones") {
          control = P.select(f.opciones, valor, { vacio: "Todos", alCambiar: function (v) { estado.filtros[f.clave] = v; estado.pagina = 1; cargar(); } });
        } else if (f.tipo === "id") {
          control = P.select([], valor, { vacio: "Todos", alCambiar: function (v) { estado.filtros[f.clave] = v; estado.pagina = 1; cargar(); } });
          P.opciones(f.fuente).then(function (ops) {
            ops.forEach(function (o) { var op = h("option", { value: o.valor }, o.texto); if (String(o.valor) === String(valor)) op.selected = true; control.appendChild(op); });
          }).catch(function () {});
        } else if (f.tipo === "desde" || f.tipo === "hasta" || f.tipo === "personalizado") {
          control = P.input({ tipo: "date", valor: valor });
          control.addEventListener("change", function () { estado.filtros[f.clave] = control.value; estado.pagina = 1; cargar(); });
        } else if (f.tipo === "monto") {
          var partes = /^(eq|gte|lte):(.*)$/.exec(valor || "") || [null, "gte", ""];
          var op = P.select([{ valor: "gte", texto: "≥" }, { valor: "lte", texto: "≤" }, { valor: "eq", texto: "=" }], partes[1]);
          op.style.width = "64px";
          op.style.flex = "none";
          var monto = P.input({ inputmode: "decimal", valor: partes[2], placeholder: "Monto" });
          monto.style.width = "110px";
          monto.style.flex = "1 1 80px";
          monto.style.minWidth = "0";
          var aplicar = function () { estado.filtros[f.clave] = monto.value.trim() ? op.value + ":" + P.numeroDe(monto.value) : ""; estado.pagina = 1; cargar(); };
          op.addEventListener("change", aplicar);
          var tm = null;
          monto.addEventListener("input", function () { clearTimeout(tm); tm = setTimeout(aplicar, 400); });
          control = h("div.fila", { style: { gap: "6px", flexWrap: "nowrap" } }, op, monto);
        }
        if (control) barra.appendChild(P.campo(f.titulo, control));
      });
      barra.appendChild(h("div.espacio"));
      (opciones.barra || []).forEach(function (b) { if (b) barra.appendChild(b); });
      if (opciones.exportar !== false) {
        var boton = P.btn("Exportar", { tipo: "secundario", icono: "planilla", chico: true });
        boton.addEventListener("click", function () {
          var items = [{ texto: "CSV completo (lo filtrado)", icono: "descargar", accion: function () { exportar({ formato: "csv", modo: "completo" }); } }];
          if (meta.resumen.length) {
            items.push("-");
            meta.resumen.forEach(function (g) {
              items.push({ texto: "CSV resumido por " + g.titulo.toLowerCase(), icono: "estadisticas", accion: function () { exportar({ formato: "csv", modo: "resumen", grupo: g.clave }); } });
            });
          }
          P.menuFlotante(boton, items);
        });
        barra.appendChild(h("div.campo", h("span.campo-etiqueta", " "), boton));
      }
    }

    function exportar(extra) {
      P.descargar("/listados/" + nombre + P.qs(parametros(extra)), nombre + ".csv").then(function () {
        P.aviso("Archivo descargado", "ok");
      }).catch(P.error);
    }

    function columnasVisibles() {
      var ocultas = opciones.columnasOcultas || [];
      var forzadas = opciones.columnasVisibles || [];
      return meta.columnas.filter(function (c) { return forzadas.indexOf(c.clave) >= 0 || (!c.oculta && ocultas.indexOf(c.clave) < 0); });
    }

    function pintar(datos) {
      var cols = columnasVisibles();
      ultimos = datos;
      P.vaciar(cuerpo);
      if (!datos.filas.length) {
        cuerpo.appendChild(P.vacio(opciones.iconoVacio || "lista", opciones.tituloVacio || "No hay registros", estado.q || Object.keys(estado.filtros).some(function (k) { return estado.filtros[k]; }) ? "Probá con otros filtros o borrá la búsqueda." : opciones.textoVacio));
      } else {
        var thead = h("thead", h("tr", cols.map(function (c) {
          var ordenado = estado.orden === c.clave || (!estado.orden && meta.orden && meta.orden.clave === c.clave);
          var dir = estado.orden === c.clave ? estado.dir : (meta.orden ? meta.orden.dir : "asc");
          return h("th.ordenable" + (ALINEA_DERECHA.indexOf(c.tipo) >= 0 ? ".der" : "") + (COLUMNAS_ANCHAS.indexOf(c.clave) >= 0 ? ".col-ancha" : ""), {
            "aria-sort": ordenado ? (dir === "desc" ? "descending" : "ascending") : null, scope: "col",
            onclick: function () {
              if (estado.orden === c.clave) estado.dir = estado.dir === "asc" ? "desc" : "asc";
              else { estado.orden = c.clave; estado.dir = ALINEA_DERECHA.indexOf(c.tipo) >= 0 || c.tipo === "dt" || c.tipo === "date" ? "desc" : "asc"; }
              cargar();
            },
          }, c.titulo, h("span.flecha", ordenado ? (dir === "desc" ? "▼" : "▲") : "↕"));
        }).concat(opciones.acciones ? [h("th.der", "")] : [])));
        if (sel) thead.firstChild.insertBefore(cabeceraSeleccion(datos.filas), thead.firstChild.firstChild);
        var tbody = h("tbody", datos.filas.map(function (f) {
          var tr = h("tr" + (opciones.alClickFila ? ".clicable" : ""), {
            onclick: opciones.alClickFila ? function (ev) { if (!ev.target.closest("button, a, input, label")) opciones.alClickFila(f); } : null,
          }, sel ? celdaSeleccion(f) : null, cols.map(function (c) {
            var especial = opciones.celdas && opciones.celdas[c.clave];
            var contenido = especial ? especial(f[c.clave], f) : P.formatoCelda(c, f[c.clave]);
            return h("td" + (ALINEA_DERECHA.indexOf(c.tipo) >= 0 ? ".der" : "") + (COLUMNAS_ANCHAS.indexOf(c.clave) >= 0 ? ".col-ancha" : "") + (c.tipo === "opcion" || c.tipo === "dt" || c.tipo === "date" || ALINEA_DERECHA.indexOf(c.tipo) >= 0 ? ".sin-corte" : ""), contenido);
          }));
          if (opciones.acciones) tr.appendChild(h("td.acciones", opciones.acciones(f, recargar)));
          return tr;
        }));
        var tabla = h("table.tabla", thead, tbody);
        if (datos.totales) {
          tabla.appendChild(h("tfoot", h("tr", sel ? h("td") : null, cols.map(function (c, i) {
            if (i === 0) return h("td", "Total (" + P.f.entero(datos.total) + ")");
            if (c.clave in datos.totales) return h("td" + (ALINEA_DERECHA.indexOf(c.tipo) >= 0 ? ".der" : ""), P.formatoCelda(c, datos.totales[c.clave]));
            return h("td");
          }).concat(opciones.acciones ? [h("td")] : []))));
        }
        cuerpo.appendChild(tabla);
      }
      marcarFilas();
      pintarSeleccion();
      P.vaciar(pie);
      var desde = datos.total ? (datos.pagina - 1) * datos.tam + 1 : 0;
      var hasta = Math.min(datos.total, datos.pagina * datos.tam);
      pie.appendChild(h("span", datos.total ? desde + "–" + hasta + " de " + P.f.entero(datos.total) : "Sin resultados"));
      var tam = P.select([10, 25, 50, 100, 200].map(function (n) { return { valor: n, texto: n + " por página" }; }), estado.tam, {
        alCambiar: function (v) { estado.tam = Number(v); estado.pagina = 1; cargar(); },
      });
      tam.classList.add("btn-chico");
      pie.appendChild(h("div.paginador",
        tam,
        P.btn("", { tipo: "texto", chico: true, icono: "volver", etiqueta: "Página anterior", deshabilitado: datos.pagina <= 1, onclick: function () { estado.pagina--; cargar(); } }),
        h("span", "Página " + datos.pagina + " de " + datos.paginas),
        (function () { var b = P.btn("", { tipo: "texto", chico: true, icono: "volver", etiqueta: "Página siguiente", deshabilitado: datos.pagina >= datos.paginas, onclick: function () { estado.pagina++; cargar(); } }); b.firstChild.style.transform = "rotate(180deg)"; return b; })()));
      medirDesliz();
      if (opciones.alCargar) opciones.alCargar(datos);
    }

    function cargar() {
      guardar();
      if (sel) {
        var nueva = firmaConsulta();
        if (firma !== null && nueva !== firma) limpiarSeleccion();
        firma = nueva;
      }
      var n = ++pedido;
      cuerpo.style.opacity = ".55";
      return P.get("/listados/" + nombre + P.qs(Object.assign(parametros(), { pagina: estado.pagina, tam: estado.tam }))).then(function (datos) {
        if (n !== pedido) return;
        cuerpo.style.opacity = "";
        pintar(datos);
      }).catch(function (e) {
        cuerpo.style.opacity = "";
        if (n !== pedido) return;
        P.reemplazar(cuerpo, h("div", { style: { padding: "16px" } }, P.mensaje(e.message, "error")));
        if (opciones.alError) opciones.alError(e);
      });
    }
    function recargar() { return cargar(); }

    P.metaListado(nombre).then(function (m) {
      meta = m;
      armarBarra();
      cargar();
    }).catch(function (e) { P.reemplazar(cuerpo, h("div", { style: { padding: "16px" } }, P.mensaje(e.message, "error"))); });

    return {
      el: raiz,
      recargar: recargar,
      fijarFiltro: function (clave, valor) { estado.filtros[clave] = valor; estado.pagina = 1; if (meta) { armarBarra(); cargar(); } },
      parametros: function () { return parametros(); },
    };
  };

  // ------------------------------------------------------------------ gráficos (SVG propios, sin librerías)
  P.graficoBarras = function (datos, opciones) {
    opciones = opciones || {};
    var ancho = 720, alto = 220, margenIzq = 64, margenAbajo = 28, margenArriba = 12;
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + ancho + " " + alto);
    svg.setAttribute("class", "grafico");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opciones.titulo || "Gráfico de barras");
    function el(tag, attrs, texto) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (texto !== undefined) e.textContent = texto;
      svg.appendChild(e);
      return e;
    }
    var max = Math.max.apply(null, datos.map(function (d) { return Number(d.valor) || 0; }).concat([1]));
    var paso = Math.pow(10, Math.floor(Math.log10(max)));
    var tope = Math.ceil(max / paso) * paso;
    var util = alto - margenAbajo - margenArriba;
    for (var i = 0; i <= 4; i++) {
      var y = margenArriba + util - (util * i) / 4;
      el("line", { x1: margenIzq, x2: ancho, y1: y, y2: y, class: "guia" });
      el("text", { x: margenIzq - 8, y: y + 4, "text-anchor": "end" }, opciones.formatoEje ? opciones.formatoEje((tope * i) / 4) : P.f.entero((tope * i) / 4));
    }
    var n = datos.length || 1;
    var anchoBarra = Math.max(4, Math.min(42, ((ancho - margenIzq) / n) * 0.62));
    var cada = Math.ceil(n / 12);
    datos.forEach(function (d, j) {
      var x = margenIzq + ((ancho - margenIzq) / n) * (j + 0.5) - anchoBarra / 2;
      var hBarra = (util * (Number(d.valor) || 0)) / tope;
      var r = el("rect", { x: x, y: margenArriba + util - hBarra, width: anchoBarra, height: Math.max(0, hBarra), rx: 4, class: "barra-g" });
      var t = document.createElementNS(NS, "title");
      t.textContent = d.etiqueta + ": " + (opciones.formato ? opciones.formato(d.valor) : d.valor);
      r.appendChild(t);
      if (j % cada === 0) el("text", { x: x + anchoBarra / 2, y: alto - 8, "text-anchor": "middle" }, d.corta || d.etiqueta);
    });
    return svg;
  };
  P.barrasH = function (datos, opciones) {
    opciones = opciones || {};
    var max = Math.max.apply(null, datos.map(function (d) { return Number(d.valor) || 0; }).concat([1]));
    if (!datos.length) return h("p.texto-3", "Sin datos en el período.");
    return h("div.barras-h", datos.map(function (d) {
      return h("div.barra-h",
        h("div.barra-h-nombre", { title: d.etiqueta }, d.etiqueta),
        h("div.barra-h-pista", h("div.barra-h-relleno", { style: { width: Math.max(2, (100 * (Number(d.valor) || 0)) / max) + "%" } })),
        h("div.barra-h-valor", opciones.formato ? opciones.formato(d.valor) : P.f.numero(d.valor)));
    }));
  };
})();
