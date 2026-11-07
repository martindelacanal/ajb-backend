/* Catálogo de adicionales del predio (precios por reglas), su editor y los artículos vencidos o sin pagar. */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P,
    h = P.h,
    pesos = P.f.pesos,
    fecha = P.f.fecha;
  var R = P.recepcion;
  var MODALIDADES = { ALQUILER: "Alquiler por día", VENTA: "Venta por unidad" };
  var ORIGENES = { PREDIO: "Catálogo del predio", TEMPORADA: "Temporadas de Turismo", BLOQUE: "Bloques de temporada alta" };

  function opciones(obj) {
    return Object.keys(obj).map(function (k) { return { valor: k, texto: obj[k] }; });
  }
  function porId(xs) {
    var m = {};
    (xs || []).forEach(function (x) { m[String(x.id)] = x; });
    return m;
  }
  function ir(ruta) { P.ruta.ir("/recepcion/adicionales" + (ruta ? "/" + ruta : "")); }

  // Una fila por regla de precio, con los nombres listos para mostrar, buscar, filtrar y ordenar.
  function filasCatalogo(cat) {
    var servicios = porId(cat.servicios), recursos = porId(cat.recursos), regimenes = porId(cat.regimenes), adicionales = porId(cat.adicionales);
    return cat.reglas.map(function (r, i) {
      var a = adicionales[String(r.adicional_id)] || {};
      var recurso = r.recurso_id ? recursos[String(r.recurso_id)] : null;
      return {
        id: i + 1,
        adicional_id: r.adicional_id,
        nombre: a.nombre || "Adicional",
        modalidad: a.modalidad || "ALQUILER",
        servicio_id: r.servicio_id, recurso_id: r.recurso_id, regimen_id: r.regimen_id,
        servicio: r.servicio_id ? (servicios[String(r.servicio_id)] || {}).nombre || "Servicio" : "Todos",
        recurso: recurso ? recurso.nombre : "Todos",
        regimen: r.regimen_id ? (regimenes[String(r.regimen_id)] || {}).nombre || "Régimen" : "Todos",
        precio: r.precio,
        fecha_inicio: r.fecha_inicio,
        fecha_fin: r.fecha_fin,
        origen: r.origen,
        origen_nombre: r.origen === "PREDIO" ? "Catálogo del predio" : r.origen_nombre,
        editable: !!r.editable
      };
    });
  }

  // ------------------------------------------------------------------ catálogo

  // Si se llegó desde una reserva a medio cargar, el catálogo ofrece volver a ella tal como estaba.
  function avisoBorrador() {
    var b = R.borrador && R.borrador();
    if (!b) return null;
    return P.mensaje(h("div.fila-separada", h("span", h("strong", b.titulo || "Reserva a medio cargar"),
      " · Lo que cargaste se conserva. Cuando termines con el catálogo, volvé para seguir."),
    P.btn("Volver a la reserva", { tipo: "primario", chico: true, icono: "volver", onclick: function () { location.hash = b.hash; } })), "info");
  }

  P.ruta.registrar(/^\/recepcion\/adicionales$/, function (c) {
    c.appendChild(R.cabecera("Catálogo de adicionales", {
      volver: ["Reservas y estadías", "/recepcion"],
      acciones: [P.btn("Crear adicional", { tipo: "primario", icono: "mas", onclick: function () { ir("nuevo"); } })]
    }));
    var aviso = avisoBorrador();
    if (aviso) c.appendChild(h("div.rec-avisos", aviso));
    var zona = h("div", P.cargando());
    c.appendChild(zona);
    return R.get("catalogo").then(function (cat) {
      var filas = filasCatalogo(cat);
      var variosRegimenes = (cat.regimenes || []).length > 1;
      var variosServicios = (cat.servicios || []).length > 1;
      var hoy = P.hoy();
      var recursos = (cat.recursos || []).map(function (x) {
        var s = (cat.servicios || []).filter(function (y) { return Number(y.id) === Number(x.servicio_id); })[0];
        return { valor: String(x.id), texto: (variosServicios && s ? s.nombre + " · " : "") + x.nombre };
      });
      var columnas = [
        { clave: "nombre", titulo: "Artículo" },
        { clave: "modalidad", titulo: "Tipo", tipo: "opcion", opciones: opciones(MODALIDADES) },
        { clave: "servicio", titulo: "Servicio" },
        { clave: "recurso", titulo: "Recurso" },
        variosRegimenes ? { clave: "regimen", titulo: "Régimen" } : null,
        { clave: "precio", titulo: "Precio", tipo: "money" },
        { clave: "fecha_inicio", titulo: "Vigente desde", tipo: "date" },
        { clave: "fecha_fin", titulo: "Vigente hasta", tipo: "date" },
        { clave: "origen_nombre", titulo: "Origen" }
      ].filter(Boolean);
      var filtros = [
        { clave: "servicio", titulo: "Servicio", tipo: "opciones", opciones: (cat.servicios || []).map(function (s) { return { valor: String(s.id), texto: s.nombre }; }) },
        { clave: "recurso", titulo: "Recurso", tipo: "opciones", opciones: recursos },
        variosRegimenes ? { clave: "regimen", titulo: "Régimen", tipo: "opciones", opciones: cat.regimenes.map(function (x) { return { valor: String(x.id), texto: x.nombre }; }) } : null,
        { clave: "modalidad", titulo: "Tipo", tipo: "opciones", opciones: opciones(MODALIDADES) },
        { clave: "precio", titulo: "Precio", tipo: "monto" },
        { clave: "vigencia_desde", titulo: "Vigente desde", tipo: "desde" },
        { clave: "vigencia_hasta", titulo: "Vigente hasta", tipo: "hasta" },
        { clave: "estado", titulo: "Vigencia", tipo: "opciones", opciones: [{ valor: "ACTUAL", texto: "Vigentes y futuros" }, { valor: "VENCIDO", texto: "Vencidos" }] },
        { clave: "origen", titulo: "Origen", tipo: "opciones", opciones: opciones(ORIGENES) }
      ].filter(Boolean);
      var recursoServicio = {};
      (cat.recursos || []).forEach(function (x) { recursoServicio[String(x.id)] = String(x.servicio_id); });
      var t = P.tabla({
        claveEstado: "recepcion-catalogo",
        filtrosIniciales: { estado: "ACTUAL" },
        placeholderBuscar: "Buscar por artículo, servicio o recurso…",
        tituloVacio: "No hay precios con esos filtros",
        textoVacio: "Creá un adicional para cargar sus precios.",
        iconoVacio: "tag",
        alClickFila: function (f) { ir(f.adicional_id); },
        celdas: {
          nombre: function (v) { return h("strong", v); },
          origen_nombre: function (v, f) { return f.editable ? v : h("span.texto-3", v); }
        },
        fuente: P.fuenteLocal({
          meta: { titulo: "Catálogo de adicionales", buscador: true, orden: { clave: "nombre", dir: "asc" }, columnas: columnas, filtros: filtros },
          filas: filas,
          buscar: function (f) { return [f.nombre, f.servicio, f.recurso, f.regimen, f.origen_nombre].join(" "); },
          valor: {
            nombre: function (f) { return f.nombre + " " + f.fecha_inicio; },
            servicio: function (f) { return f.servicio_id ? f.servicio : ""; },
            recurso: function (f) { return f.recurso_id ? f.recurso : ""; }
          },
          filtros: {
            // Un precio para "Todos" también vale para el servicio o recurso elegido.
            servicio: function (f, v) { return !f.servicio_id || String(f.servicio_id) === String(v); },
            recurso: function (f, v) { return f.recurso_id ? String(f.recurso_id) === String(v) : !f.servicio_id || String(f.servicio_id) === recursoServicio[String(v)]; },
            regimen: function (f, v) { return !f.regimen_id || String(f.regimen_id) === String(v); },
            precio: function (f, v) { return P.cumpleMonto(f.precio, v); },
            vigencia_desde: function (f, v) { return f.fecha_fin >= v; },
            vigencia_hasta: function (f, v) { return f.fecha_inicio <= v; },
            estado: function (f, v) { return v === "VENCIDO" ? f.fecha_fin < hoy : f.fecha_fin >= hoy; }
          }
        })
      });
      P.reemplazar(zona, t.el);
    });
  }, { titulo: "Catálogo de adicionales", admin: true });

  // ------------------------------------------------------------------ editor

  function editor(c, cat, datos) {
    var adicional = datos ? datos.adicional : null;
    var servicios = cat.servicios || [], recursos = cat.recursos || [], regimenes = cat.regimenes || [];
    var variosRegimenes = regimenes.length > 1;
    var nombre = P.input({ max: 100, valor: adicional ? adicional.nombre : "" });
    var modalidad = adicional ? adicional.modalidad || "ALQUILER" : "ALQUILER";
    var hoy = P.hoy();
    var reglas = (datos ? datos.reglas : []).map(function (r) { return Object.assign({}, r); });
    if (!reglas.length) reglas.push({ servicio_id: null, recurso_id: null, regimen_id: null, fecha_inicio: hoy, fecha_fin: P.sumarDias(hoy, 120), precio: "" });
    var zonaPrecios = h("div.rec-precios");
    if (variosRegimenes) zonaPrecios.classList.add("con-regimen");
    var aviso = h("div", { "aria-live": "polite" });
    var segmento = P.segmentado(opciones(MODALIDADES), modalidad, function (v) { modalidad = v; pintar(); });
    if (datos && !datos.puede_cambiar_modalidad) segmento.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    if (datos && !datos.puede_renombrar) { nombre.readOnly = true; nombre.title = "El nombre se comparte con Turismo: se cambia desde Mi AJB."; }
    var ayudaModalidad = h("span.campo-ayuda");

    function etiquetaPrecio() { return modalidad === "VENTA" ? "Precio por unidad ($)" : "Precio por unidad y día ($)"; }
    function pintar() {
      ayudaModalidad.textContent = modalidad === "VENTA" ? "Se cobra una sola vez por unidad (por ejemplo, una bolsa de carbón). No se registra devolución." :
        "Se cobra cada unidad por cada día de uso, incluidos el primero y el último, y se registra la devolución.";
      var cabeceraFilas = h("div.rec-precio-fila.rec-precio-encabezado", { "aria-hidden": "true" },
        h("span", "Servicio"), h("span", "Recurso"), variosRegimenes ? h("span", "Régimen") : null, h("span", "Desde"), h("span", "Hasta"), h("span", etiquetaPrecio()), h("span"));
      P.reemplazar(zonaPrecios, cabeceraFilas, reglas.map(function (r, i) {
        var servicio = P.select([{ valor: "", texto: "Todos los servicios" }].concat(servicios.map(function (s) { return { valor: s.id, texto: s.nombre }; })), r.servicio_id || "");
        var recurso = P.select([], null);
        var regimen = P.select([{ valor: "", texto: "Todos" }].concat(regimenes.map(function (x) { return { valor: x.id, texto: x.nombre }; })), r.regimen_id || "");
        var desde = P.input({ tipo: "date", valor: r.fecha_inicio }), hasta = P.input({ tipo: "date", valor: r.fecha_fin });
        var precio = P.dinero({ valor: r.precio === "" || r.precio == null ? "" : P.f.numero(r.precio) });
        function pintarRecursos() {
          P.vaciar(recurso);
          recurso.appendChild(h("option", { value: "" }, servicio.value ? "Todos los recursos" : "Todos"));
          recursos.filter(function (x) { return String(x.servicio_id) === servicio.value; }).forEach(function (x) {
            recurso.appendChild(h("option", { value: x.id }, x.nombre));
          });
          recurso.value = r.recurso_id && servicio.value ? String(r.recurso_id) : "";
          recurso.disabled = !servicio.value;
        }
        pintarRecursos();
        servicio.onchange = function () { r.servicio_id = servicio.value ? Number(servicio.value) : null; r.recurso_id = null; pintarRecursos(); };
        recurso.onchange = function () { r.recurso_id = recurso.value ? Number(recurso.value) : null; };
        regimen.onchange = function () { r.regimen_id = regimen.value ? Number(regimen.value) : null; };
        desde.onchange = function () { r.fecha_inicio = desde.value; };
        hasta.onchange = function () { r.fecha_fin = hasta.value; };
        precio.oninput = function () { r.precio = precio.value; };
        [[servicio, "Servicio"], [recurso, "Recurso"], [regimen, "Régimen"], [desde, "Vigente desde"], [hasta, "Vigente hasta"], [precio, etiquetaPrecio()]].forEach(function (x) {
          x[0].setAttribute("aria-label", x[1] + " del precio " + (i + 1));
        });
        function celda(etiqueta, control) { return h("label.rec-precio-celda", h("span.rec-etiqueta-movil", etiqueta), control); }
        return h("div.rec-precio-fila", { "data-fila": String(i) },
          celda("Servicio", servicio), celda("Recurso", recurso), variosRegimenes ? celda("Régimen", regimen) : null,
          celda("Desde", desde), celda("Hasta", hasta), celda(etiquetaPrecio(), precio),
          h("div.rec-precio-quitar", P.btn("", { tipo: "texto", icono: "borrar", etiqueta: "Quitar el precio " + (i + 1), onclick: function () {
            reglas.splice(i, 1);
            pintar();
          } })));
      }), h("div.rec-pie-acciones.rec-pie-izquierda", P.btn("Agregar precio", { tipo: "suave", icono: "mas", onclick: function () {
        var ultima = reglas[reglas.length - 1];
        var inicio = ultima && ultima.fecha_fin ? P.sumarDias(ultima.fecha_fin, 1) : hoy;
        reglas.push({ servicio_id: ultima ? ultima.servicio_id : null, recurso_id: ultima ? ultima.recurso_id : null, regimen_id: ultima ? ultima.regimen_id : null,
          fecha_inicio: inicio, fecha_fin: P.sumarDias(inicio, 60), precio: "" });
        pintar();
        var filas = zonaPrecios.querySelectorAll(".rec-precio-fila[data-fila]");
        var nueva = filas[filas.length - 1];
        if (nueva) nueva.querySelector("input[type=date]").focus();
      } })));
    }

    function validar() {
      if (!nombre.value.trim()) { nombre.focus(); throw Error("Escribí el nombre del artículo."); }
      var salida = reglas.map(function (r, i) {
        var n = i + 1;
        var importe = P.importeDe(String(r.precio));
        if (!r.fecha_inicio || !r.fecha_fin) throw Error("Completá las fechas del precio " + n + ".");
        if (r.fecha_fin < r.fecha_inicio) throw Error("En el precio " + n + ", la fecha «hasta» es anterior a «desde».");
        if (String(r.precio).trim() === "" || !Number.isFinite(importe) || importe < 0) throw Error("Ingresá un importe válido en el precio " + n + ".");
        return { servicio_id: r.servicio_id || null, recurso_id: r.recurso_id || null, regimen_id: variosRegimenes ? r.regimen_id || null : null,
          fecha_desde: r.fecha_inicio, fecha_hasta: r.fecha_fin, precio: importe };
      });
      // Dos precios con el mismo alcance que se pisan: se avisa acá, antes de ir al servidor.
      for (var i = 0; i < salida.length; i++) {
        for (var j = i + 1; j < salida.length; j++) {
          var a = salida[i], b = salida[j];
          var mismo = a.servicio_id === b.servicio_id && a.recurso_id === b.recurso_id && a.regimen_id === b.regimen_id;
          if (mismo && a.fecha_desde <= b.fecha_hasta && b.fecha_desde <= a.fecha_hasta && a.precio !== b.precio) {
            throw Error("Los precios " + (i + 1) + " y " + (j + 1) + " tienen el mismo alcance y se superponen en las fechas. Ajustá uno de los dos.");
          }
        }
      }
      return salida;
    }
    function guardar(sinPrecios) {
      var cuerpo = { id: adicional ? adicional.id : null, nombre: nombre.value.trim(), modalidad: modalidad, reglas: sinPrecios ? [] : validar() };
      if (!sinPrecios && !cuerpo.reglas.length) throw Error("Agregá al menos un precio, o usá «Quitar del catálogo».");
      return P.post("/recepcion/catalogo/guardar", cuerpo).then(function (x) {
        if (x.encolado) { ir(); return; }
        P.aviso(x.mensaje || "Adicional guardado", "ok");
        ir();
      }).catch(function (e) {
        P.reemplazar(aviso, P.mensaje(e.message, "error"));
        throw e;
      });
    }

    c.appendChild(R.cabecera(adicional ? adicional.nombre : "Nuevo adicional", {
      volver: ["Catálogo de adicionales", "/recepcion/adicionales"],
      subtitulo: adicional && datos.usos && datos.usos.reservas ? "Usado en " + datos.usos.reservas + (datos.usos.reservas === 1 ? " reserva" : " reservas") + ". Cambiar un precio no modifica las reservas ya cotizadas." : null
    }));
    var avisoReserva = avisoBorrador();
    if (avisoReserva) c.appendChild(h("div.rec-avisos", avisoReserva));
    c.appendChild(h("section.hoja.rec-seccion", h("div.rec-seccion-cabecera", h("h2", "Artículo")),
      h("div.rec-grid.rec-grid-articulo", P.campo("Nombre", nombre, { ayuda: nombre.readOnly ? nombre.title : null }),
        h("div.campo", h("span.campo-etiqueta", "Tipo"), segmento, ayudaModalidad))));
    c.appendChild(h("section.hoja.rec-seccion", h("div.rec-seccion-cabecera", h("h2", "Precios")),
      h("p.texto-3.rec-ayuda", "Elegí a qué servicios" + (variosRegimenes ? ", recursos o regímenes" : " y recursos") + " corresponde cada precio y entre qué fechas vale. Si un recurso tiene un precio propio, ese precio reemplaza al general en esas fechas."),
      zonaPrecios));
    if (datos && datos.ajenas && datos.ajenas.length) {
      var srv = porId(servicios), rcs = porId(recursos);
      c.appendChild(h("section.hoja.rec-seccion", h("div.rec-seccion-cabecera", h("h2", "Precios de Turismo")),
        h("p.texto-3.rec-ayuda", "Estos precios se cargaron en las temporadas de Mi AJB y se cambian desde allí. Recepción también los usa."),
        h("div.rec-tabla", h("table", h("thead", h("tr", ["Origen", "Servicio", "Recurso", "Desde", "Hasta", "Precio"].map(function (s, i) { return h("th" + (i === 5 ? ".der" : ""), { scope: "col" }, s); }))),
          h("tbody", datos.ajenas.map(function (r) {
            return h("tr", [r.origen_nombre, r.servicio_id ? (srv[String(r.servicio_id)] || {}).nombre : "Todos", r.recurso_id ? (rcs[String(r.recurso_id)] || {}).nombre : "Todos",
              fecha(r.fecha_inicio), fecha(r.fecha_fin), pesos(r.precio)].map(function (v, i) {
              return h("td" + (i === 5 ? ".der" : ""), h("span.rec-etiqueta-movil", ["Origen", "Servicio", "Recurso", "Desde", "Hasta", "Precio"][i]), h("div.rec-valor", v || "—"));
            }));
          }))))));
    }
    c.appendChild(aviso);
    var acciones = [P.btn("Cancelar", { tipo: "secundario", onclick: function () { ir(); } }),
      P.btn("Guardar", { tipo: "primario", icono: "check", onclick: function (e) { P.ejecutar(e.currentTarget, function () { P.vaciar(aviso); return guardar(false); }).catch(function () {}); } })];
    if (adicional && datos.reglas.length) acciones.unshift(P.btn("Quitar del catálogo", { tipo: "peligro", icono: "borrar", onclick: function (e) {
      var boton = e.currentTarget;
      P.confirmar("Se quitan los precios del predio para «" + adicional.nombre + "». Las reservas ya cotizadas conservan su precio.", { titulo: "Quitar del catálogo", aceptar: "Quitar", peligro: true }).then(function (si) {
        if (si) P.ejecutar(boton, function () { return guardar(true); }).catch(function () {});
      });
    } }));
    c.appendChild(h("div.rec-pie-acciones.rec-pie-editor", acciones));
    pintar();
    if (!adicional) nombre.focus();
  }

  P.ruta.registrar(/^\/recepcion\/adicionales\/nuevo$/, function (c) {
    return R.get("catalogo").then(function (cat) { editor(c, cat, null); });
  }, { titulo: "Nuevo adicional", admin: true });

  P.ruta.registrar(/^\/recepcion\/adicionales\/(\d+)$/, function (c, p) {
    return R.get("catalogo/adicional", { id: p[0] }).then(function (d) { editor(c, d, d); });
  }, { titulo: "Adicional", admin: true });

  // ------------------------------------------------------------------ artículos vencidos o sin pagar

  P.ruta.registrar(/^\/recepcion\/adicionales\/pendientes$/, function (c) {
    c.appendChild(R.cabecera("Artículos vencidos o sin pagar", {
      volver: ["Reservas y estadías", "/recepcion"],
      subtitulo: "Alquileres cuyo último día ya pasó sin devolverse o sin pagarse, y artículos sin pagar de estadías que ya terminaron."
    }));
    var zona = h("div", P.cargando());
    c.appendChild(zona);
    return R.get("adicionales-pendientes").then(function (r) {
      P.actualizarEstadiasVencidas(undefined, r.filas.length);
      var filas = r.filas.map(function (x) {
        return Object.assign({}, x, { situacion: x.sin_devolver && x.sin_pagar ? "AMBOS" : x.sin_devolver ? "DEVOLVER" : "PAGAR" });
      });
      var SITUACION = { DEVOLVER: "Sin devolver", PAGAR: "Sin pagar", AMBOS: "Sin devolver ni pagar" };
      var t = P.tabla({
        claveEstado: "recepcion-adicionales-pendientes",
        placeholderBuscar: "Buscar por titular, reserva o artículo…",
        tituloVacio: "No hay artículos vencidos ni sin pagar",
        textoVacio: "Todo lo alquilado está devuelto y pagado.",
        iconoVacio: "check",
        alClickFila: function (f) { P.ruta.ir("/recepcion/" + f.reserva_id); },
        celdas: {
          reserva_id: function (v) { return h("span.rec-codigo", "T-" + v); },
          situacion: function (v, f) {
            return h("div.rec-chips", f.sin_devolver ? P.chip("Sin devolver", "ERROR") : null, f.sin_pagar ? P.chip(f.salieron ? "Se fue sin pagar" : "Sin pagar", "PENDIENTE") : null);
          },
          dias_atraso: function (v) { return v ? v + (Number(v) === 1 ? " día" : " días") : "—"; }
        },
        fuente: P.fuenteLocal({
          meta: {
            titulo: "Artículos vencidos", buscador: true, orden: { clave: "dias_atraso", dir: "desc" },
            columnas: [
              { clave: "reserva_id", titulo: "Reserva" },
              { clave: "titular", titulo: "Titular" },
              { clave: "nombre", titulo: "Artículo" },
              { clave: "cantidad", titulo: "Unidades", tipo: "int" },
              { clave: "fecha_hasta", titulo: "Último día", tipo: "date" },
              { clave: "dias_atraso", titulo: "Atraso", tipo: "int" },
              { clave: "situacion", titulo: "Situación" },
              { clave: "adeudado", titulo: "Adeudado", tipo: "money" }
            ],
            filtros: [{ clave: "situacion", titulo: "Situación", tipo: "opciones", opciones: [{ valor: "DEVOLVER", texto: "Sin devolver" }, { valor: "PAGAR", texto: "Sin pagar" }] }]
          },
          filas: filas,
          buscar: function (f) { return ["T-" + f.reserva_id, f.titular, f.nombre, f.recurso].join(" "); },
          filtros: {
            situacion: function (f, v) { return v === "DEVOLVER" ? f.sin_devolver : f.sin_pagar; }
          }
        })
      });
      P.reemplazar(zona, t.el);
    });
  }, { titulo: "Artículos vencidos o sin pagar" });
})();
