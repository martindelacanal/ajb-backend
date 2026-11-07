/* Gestión: productos y stock general, proveedores, bocas y cajas; y usuarios. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  var DESTINOS = [
    { valor: "VENTA_DIRECTA", texto: "Venta directa" }, { valor: "VENTA_COMPUESTA", texto: "Venta compuesta" },
    { valor: "USO_INTERNO", texto: "Uso interno" }, { valor: "ALQUILER", texto: "Alquiler" },
  ];
  var AYUDA_DESTINO = {
    VENTA_DIRECTA: "Se vende tal cual y descuenta stock de la boca.",
    VENTA_COMPUESTA: "Descuenta las porciones de esta boca o, si elegís un insumo base, la fracción estimada que usa cada porción.",
    USO_INTERNO: "Insumos del predio (limpieza, oficina): no se venden.",
    ALQUILER: "Se alquila y vuelve (sombrillas, reposeras): se cobra sin descontar stock.",
  };

  P.solapasGestion = function (c, actual) {
    var solapas = [
      { ruta: "/gestion/productos", texto: "Productos y stock general" },
      { ruta: "/gestion/proveedores", texto: "Proveedores" },
      { ruta: "/gestion/afiliados", texto: "Afiliados" },
      { ruta: "/gestion/bocas", texto: "Bocas y cajas" },
    ];
    c.appendChild(h("div.pagina-cabecera.gestion-cabecera", h("h1.titulo-pagina", "Gestión")));
    c.appendChild(h("nav.solapas", { "aria-label": "Secciones de gestión" }, solapas.map(function (s) {
      return h("a.solapa", { href: "#" + s.ruta, "aria-current": actual === s.ruta ? "page" : null }, s.texto);
    })));
  };

  P.ruta.registrar(/^\/gestion$/, function () { P.ruta.ir("/gestion/productos"); }, { admin: true });

  // ------------------------------------------------------------------ eliminar
  // eleccion = { ids: [...] } o { consulta: parametros de la tabla } (todos los que coinciden).
  var ELIMINABLES = {
    productos: { ruta: "/productos/eliminar", singular: "producto", plural: "productos" },
    proveedores: { ruta: "/proveedores/eliminar", singular: "proveedor", plural: "proveedores" },
  };
  P.eliminarRegistros = function (clave, eleccion, alTerminar) {
    var cfg = ELIMINABLES[clave];
    var cuerpo = eleccion.ids ? { ids: eleccion.ids } : { consulta: eleccion.consulta };
    P.post(cfg.ruta + "/previa", cuerpo).then(function (pr) {
      var cuantos = function (n) { return P.f.entero(n) + " " + (n === 1 ? cfg.singular : cfg.plural); };
      var lista = function (muestra, total) {
        return h("ul.lista-simple", muestra.map(function (x) {
          return h("li", h("span", x.nombre), x.usos ? h("span.texto-3.chico", "tiene " + x.usos.join(", ")) : (x.codigo ? h("span.texto-3.chico", x.codigo) : null));
        }).concat(total > muestra.length ? [h("li.texto-3", "y " + P.f.entero(total - muestra.length) + " más")] : []));
      };
      var bloques = [];
      if (pr.se_borran) {
        bloques.push(h("div.columna", { style: { gap: "6px" } },
          h("strong", "Se borran del todo: " + cuantos(pr.se_borran)),
          h("p.texto-3", { style: { margin: 0 } }, "Nunca se usaron: desaparecen del sistema."),
          lista(pr.muestra_borrar, pr.se_borran)));
      }
      if (pr.se_dan_de_baja) {
        bloques.push(h("div.columna", { style: { gap: "6px" } },
          h("strong", "Se dan de baja: " + cuantos(pr.se_dan_de_baja)),
          h("p.texto-3", { style: { margin: 0 } }, "Ya tienen ventas, compras o movimientos. Para no perder ese historial quedan como «Dados de baja»: no aparecen más para vender ni comprar."),
          lista(pr.muestra_baja, pr.se_dan_de_baja)));
      }
      if (pr.sin_cambios) {
        bloques.push(P.mensaje(cuantos(pr.sin_cambios) + (pr.sin_cambios === 1 ? " ya estaba dado de baja y tiene" : " ya estaban dados de baja y tienen") + " historial: queda" + (pr.sin_cambios === 1 ? "" : "n") + " como está" + (pr.sin_cambios === 1 ? "" : "n") + ".", "info"));
      }
      var accionables = pr.se_borran + pr.se_dan_de_baja;
      var unico = pr.cantidad === 1 ? (pr.muestra_borrar[0] || pr.muestra_baja[0] || pr.muestra_sin_cambios[0]) : null;
      var m = P.modal({
        titulo: unico ? "Eliminar «" + unico.nombre + "»" : "Eliminar " + cuantos(pr.cantidad),
        subtitulo: pr.se_borran ? "Lo que se borra no se puede recuperar." : null,
        contenido: h("div.columna", bloques.length ? bloques : [P.mensaje("No hay nada para eliminar.", "info")]),
        acciones: [
          P.btn("Cancelar", { onclick: function () { m.cerrar(); } }),
          accionables ? P.btn(accionables === 1 ? "Eliminar" : "Eliminar " + cuantos(accionables), { tipo: "peligro-lleno", icono: "borrar", onclick: function (ev) {
            P.ejecutar(ev.currentTarget, function () {
              return P.post(cfg.ruta, cuerpo).then(function (r) {
                if (!r.encolado) P.aviso(r.mensaje, "ok");
                P.olvidarOpciones();
                m.cerrar();
                if (alTerminar) alTerminar(r);
              });
            }).catch(function () {});
          } }) : null,
        ],
      });
    }).catch(P.error);
  };
  function seleccionEliminar(clave) {
    var cfg = ELIMINABLES[clave];
    return {
      singular: cfg.singular, plural: cfg.plural,
      acciones: [{ texto: "Eliminar", icono: "borrar", tipo: "peligro", accion: function (eleccion, despues) {
        P.eliminarRegistros(clave, eleccion, function () { despues(); });
      } }],
    };
  }

  // ------------------------------------------------------------------ productos
  P.cantidadPorBoca = function (cantidad, fila) {
    var fisico = h("strong.numero" + (Number(cantidad) < 0 ? ".negativo" : ""), P.f.numero(cantidad));
    if (fila.porciones_disponibles == null) return fisico;
    var porciones = Number(fila.porciones_disponibles);
    return h("div.der", h("div", fisico, " en stock físico"),
      h("div.chico", P.f.numero(porciones) + (porciones === 1 ? " porción estimada" : " porciones estimadas")));
  };
  function porcentajeOpcional(control) {
    return control.value.trim() ? P.numeroDe(control.value) : null;
  }
  function porcentajeValido(valor) {
    return valor === null || (Number.isFinite(valor) && valor >= -100 && valor <= 10000);
  }
  function marcarMargenInvalido(control) {
    P.aviso("Ingresá un margen entre −100 % y 10.000 %, o dejá el campo vacío para heredar el precio.", "error");
    control.classList.add("invalido");
    control.focus();
  }
  function valorEditable(n) { return n == null ? "" : String(Number(n)).replace(".", ","); }

  function botonEliminar(clave, id, modal, alEliminar) {
    var b = P.btn("Eliminar", { tipo: "peligro", icono: "borrar", onclick: function () {
      modal().cerrar();
      P.eliminarRegistros(clave, { ids: [id] }, alEliminar);
    } });
    b.classList.add("izquierda");
    return b;
  }

  P.formProducto = function (base, alGuardar, alEliminar, reanudar) {
    base = base || {};
    var editar = !!base.id;
    var cargar = editar ? P.get("/productos/" + base.id) : P.opciones("bocas", true);
    return cargar.then(function (datos) {
      var detalle = editar ? datos : null;
      var p = detalle ? detalle.producto : base;
      var bocas = detalle ? detalle.margenes_boca : datos.map(function (b) {
        return { boca_id: b.valor, boca: b.texto, margen_boca: b.margen_venta, margen: null, activo: 1 };
      });
      var nombre = P.input({ valor: p.nombre, max: 160, placeholder: "Ej.: Agua mineral 500 ml" });
      var codigo = P.input({ valor: p.codigo, max: 60, placeholder: "Escaneá o escribí el código si lo tiene" });
      codigo.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); compra.focus(); } });
      var compra = P.dinero({ valor: valorEditable(p.precio_compra) });
      var margen = P.input({ inputmode: "decimal", valor: valorEditable(p.margen), placeholder: "0" });
      margen.style.textAlign = "right";
      var venta = P.dinero({ soloLectura: true });
      var manual = P.check("Fijar el precio de venta a mano", false);
      var ayudaVenta = h("span", "Redondeado hacia arriba a $100.");
      var precioIntervenido = false;
      var destino = P.select(DESTINOS, p.destino || "VENTA_DIRECTA");
      var ayudaDestino = h("span.campo-ayuda", AYUDA_DESTINO[destino.value]);
      var zonaReceta = h("div.columna"), insumo, rendimiento;
      var recetaInicial = p.receta;
      function configurarPorcion() {
        ayudaDestino.textContent = AYUDA_DESTINO[destino.value];
        zonaReceta.hidden = destino.value !== "VENTA_COMPUESTA";
        if (zonaReceta.hidden || insumo) return;
        insumo = P.comboProducto({ abrirAlEnfocar: false, textoLibre: true, placeholder: "Ej.: paquete de café (opcional)" });
        if (recetaInicial) insumo.fijar(recetaInicial.insumo_id, recetaInicial.nombre);
        rendimiento = P.input({ inputmode: "numeric", valor: recetaInicial ? String(recetaInicial.rendimiento) : "", placeholder: "Ej.: 40" });
        var ayuda = h("span.campo-ayuda");
        function mostrarConsumo() {
          var rinde = Number(rendimiento.value);
          ayuda.textContent = Number.isInteger(rinde) && rinde > 0 && rinde <= 1000
            ? "Consumo estimado por porción: " + P.f.numero(1 / rinde) + " unidades del insumo."
            : "Estimá cuántas porciones de este tamaño salen de una unidad del insumo.";
        }
        rendimiento.addEventListener("input", mostrarConsumo);
        mostrarConsumo();
        zonaReceta.appendChild(h("div.grilla.grilla-2", P.campo("Insumo base", insumo.el, { ayuda: "Sin insumo se descuenta una porción del stock propio." }),
          P.campo("Porciones por unidad de insumo", h("div", rendimiento, ayuda))));
      }
      destino.addEventListener("change", configurarPorcion);
      configurarPorcion();
      var cantidad = P.input({ inputmode: "decimal", valor: editar ? valorEditable(stockAlmacenDe(detalle)) : "0" });
      cantidad.style.textAlign = "right";
      var perecedero = P.check("Es perecedero", Number(p.perecedero) === 1, null, function (v) {
        zonaVence.hidden = !v;
        zonaAviso.hidden = !v;
        filaCaducidad.classList.toggle("con-fecha", v);
      });
      var vence = P.input({ tipo: "date", valor: p.fecha_caducidad || "" });
      var zonaVence = P.campo("Fecha de caducidad (opcional)", vence);
      zonaVence.hidden = Number(p.perecedero) !== 1;
      var diasAviso = P.input({ inputmode: "numeric", valor: p.dias_aviso_vencimiento == null ? "" : String(p.dias_aviso_vencimiento), placeholder: "7" });
      var zonaAviso = P.campo("Avisar al predio con cuántos días de anticipación", diasAviso, { ayuda: "Por defecto se avisa 7 días antes. Con 0, se avisa el día del vencimiento." });
      zonaAviso.hidden = zonaVence.hidden;
      var filaCaducidad = h("div.grilla.grilla-2.producto-caducidad" + (Number(p.perecedero) === 1 ? ".con-fecha" : ""), perecedero, zonaVence);
      var minimo = P.input({ inputmode: "decimal", valor: p.stock_minimo ? valorEditable(p.stock_minimo) : "", placeholder: "Opcional" });
      var activo = P.check("Producto activo", editar ? Number(p.activo) === 1 : true, "Los dados de baja no aparecen para vender ni comprar.");

      var margenesEditados = false;
      var preciosBoca = (bocas || []).map(function (boca) {
        var input = P.input({ inputmode: "decimal", valor: valorEditable(boca.margen) });
        input.addEventListener("input", function () { margenesEditados = true; actualizarPorBoca(); });
        var total = h("strong.numero");
        return {
          boca: boca, input: input, total: total,
          fila: h("div.precio-boca-fila",
            P.campo(boca.boca + (Number(boca.activo) === 0 ? " (inactiva)" : ""), input),
            h("div.precio-boca-total", h("span.campo-ayuda", "Precio en caja"), total)),
        };
      });
      function actualizarPorBoca() {
        var costo = P.importeDe(compra.value);
        var general = P.importeDe(venta.value);
        preciosBoca.forEach(function (f) {
          var excepcion = porcentajeOpcional(f.input);
          var usaBoca = f.boca.margen_boca != null;
          f.input.placeholder = usaBoca ? "De la boca: " + P.f.pct(f.boca.margen_boca) : "General del producto";
          var porcentaje = excepcion != null ? excepcion : usaBoca ? Number(f.boca.margen_boca) : null;
          var usaPrecioGeneral = porcentaje == null || !(costo > 0);
          var base = usaPrecioGeneral ? general : costo;
          f.total.textContent = porcentajeValido(porcentaje) && Number.isFinite(base) ? P.f.pesos(P.precioDeVenta(base, usaPrecioGeneral ? null : porcentaje)) : "—";
        });
      }
      function calcular() {
        venta.readOnly = !manual.input.checked;
        if (manual.input.checked) {
          var importe = P.importeDe(venta.value);
          ayudaVenta.textContent = Number.isFinite(importe) ? "Precio en caja: " + P.f.pesos(P.precioDeVenta(importe)) : "Redondeado hacia arriba a $100.";
        } else {
          var c = P.importeDe(compra.value), mg = porcentajeOpcional(margen);
          ayudaVenta.textContent = "Redondeado hacia arriba a $100.";
          venta.value = !Number.isFinite(c) || !porcentajeValido(mg) ? "" : valorEditable(P.precioDeVenta(c, mg));
        }
        actualizarPorBoca();
      }
      [compra, margen].forEach(function (i) { i.addEventListener("input", function () { precioIntervenido = true; calcular(); }); });
      manual.input.addEventListener("change", function () { precioIntervenido = true; calcular(); if (manual.input.checked) venta.focus(); });
      venta.addEventListener("input", calcular);
      if (editar && p.precio_venta !== undefined) {
        venta.value = valorEditable(p.precio_venta);
        if (P.precioDeVenta(p.precio_compra, p.margen) !== Number(p.precio_venta)) ayudaVenta.textContent = "Precio guardado. Se recalcula al cambiar la compra o el margen.";
        actualizarPorBoca();
      } else calcular();

      var formulario = h("div.columna",
        h("div.grilla.grilla-2", P.campo("Nombre", nombre, { requerido: true }), P.campo("Código de barras o interno (opcional)", codigo)),
        h("div.grilla.grilla-2", P.campo("Destino del producto", h("div", destino, ayudaDestino)),
          P.campo(editar ? "Cantidad en proveeduría (ajuste)" : "Cantidad en proveeduría", cantidad, { ayuda: editar ? "Si la cambiás, queda registrado como ajuste manual." : "Stock inicial en la boca que recibe las compras." })),
        zonaReceta,
        h("div.grilla.grilla-2",
          P.campo("Precio de compra", h("div.campo-con-prefijo", h("span", "$"), compra)),
          P.campo("Margen de utilidad (%)", margen)),
        h("div.grilla.grilla-2.producto-venta", manual,
          P.campo("Precio de venta", h("div.campo-con-prefijo", h("span", "$"), venta), { ayuda: ayudaVenta })),
        filaCaducidad, zonaAviso,
        P.campo("Stock mínimo para avisos", minimo, { ayuda: "Avisa al personal de la boca y a administración cuando el stock queda por debajo de esta cantidad. Con 0, no se generan avisos de stock mínimo." }),
        editar ? activo : null);

      var panelBocas = h("div.columna",
        h("span.texto-3", "Ingresá el margen especial (%) de este producto para cada boca. Si lo dejás vacío, se usa el margen de la boca o el precio general del producto."),
        h("div.precios-bocas", preciosBoca.map(function (f) { return f.fila; })));
      var desplegableBocas, contenido;
      function mostrarPanel(v) {
        if (!editar) { desplegableBocas.open = v === "bocas"; return; }
        formulario.hidden = v !== "datos";
        stockLista.hidden = v !== "stock";
        precios.hidden = v !== "precios";
        panelBocas.hidden = v !== "bocas";
        solapa.fijar(v);
      }
      if (detalle) {
        var stockLista = h("ul.lista-simple.stock-del-producto", detalle.stock.map(function (s) {
          return h("li", h("span", s.boca + (Number(s.activo) === 0 ? " (inactiva)" : "")),
            P.cantidadPorBoca(s.cantidad, s));
        }));
        var precios = h("ul.lista-simple", detalle.precios.map(function (x) {
          var actor = /sistema (anterior|actual)/i.test(x.usuario_nombre || "") ? "" : x.usuario_nombre;
          var origen = ({ ALTA: "Alta", EDICION: "Edición", COMPRA: "Compra N° " + x.referencia_id, IMPORTACION: "Precio registrado",
            ANULACION_COMPRA: "Anulación de compra", ANULACION_BOCA: "Anulación de compra", MARGEN_BOCA: "Cambio de margen de la boca",
            MARGEN_PRODUCTO: "Cambio de margen del producto", COMPRA_BOCA: "Compra N° " + x.referencia_id, EDICION_BOCA: "Edición", ALTA_BOCA: "Alta" })[x.origen] || x.origen;
          return h("li", h("div", h("strong", P.f.fechaHora(x.fecha)), h("div.texto-3.chico", origen + (x.boca ? " · " + x.boca : " · General") + (actor ? " · " + actor : ""))),
            h("div", { style: { textAlign: "right" } }, h("div", "Compra " + P.f.pesos(x.precio_compra) + " · " + P.f.pct(x.margen)), h("strong", "Venta " + P.f.pesos(x.precio_venta))));
        }));
        var solapa = P.segmentado([{ valor: "datos", texto: "Datos" }, { valor: "stock", texto: "Stock por boca" },
          { valor: "bocas", texto: "Precios por boca" }, { valor: "precios", texto: "Historial de precios" }], "datos", mostrarPanel);
        stockLista.hidden = true;
        precios.hidden = true;
        panelBocas.hidden = true;
        var creacion = P.f.fechaHora(p.fecha_creacion);
        var modificacion = P.f.fechaHora(p.fecha_modificacion);
        contenido = h("div.columna", solapa, formulario, stockLista, panelBocas, precios,
          h("p.texto-3.chico", { style: { margin: 0 } }, "Creado el " + (creacion || "—") + (modificacion && modificacion !== creacion ? " · Modificado el " + modificacion : "")));
      } else {
        desplegableBocas = h("details.precios-nuevo", h("summary", "Precios por boca"), panelBocas);
        contenido = h("div.columna", formulario, desplegableBocas);
      }
      var m = P.modal({
        titulo: editar ? p.nombre : "Nuevo producto", subtitulo: editar ? "ID " + p.id + (p.codigo ? " · Código " + p.codigo : "") : null,
        ancho: "ancha", contenido: contenido, reanudar: reanudar,
        acciones: [editar && alEliminar ? botonEliminar("productos", p.id, function () { return m; }, alEliminar) : null,
          P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn(editar ? "Guardar cambios" : "Crear producto", { tipo: "primario", icono: "check", onclick: function (ev) {
          if (!porcentajeValido(porcentajeOpcional(margen))) { mostrarPanel("datos"); marcarMargenInvalido(margen); return; }
          var invalido = preciosBoca.find(function (f) { return !porcentajeValido(porcentajeOpcional(f.input)); });
          if (invalido) {
            mostrarPanel("bocas");
            marcarMargenInvalido(invalido.input); return;
          }
          var compraIngresada = P.importeDe(compra.value), manualIngresado = P.importeDe(venta.value);
          if ((compra.value.trim() && !Number.isFinite(compraIngresada)) || (manual.input.checked && !Number.isFinite(manualIngresado))) {
            mostrarPanel("datos");
            (compra.value.trim() && !Number.isFinite(compraIngresada) ? compra : venta).focus();
            P.aviso("Revisá el precio ingresado. Usá un importe con hasta dos decimales.", "error"); return;
          }
          var cuerpo = {
            nombre: nombre.value, codigo: codigo.value.trim() || null, precio_compra: compraIngresada || 0, margen: porcentajeOpcional(margen) || 0,
            destino: destino.value, perecedero: perecedero.input.checked, fecha_caducidad: perecedero.input.checked ? vence.value || null : null,
            dias_aviso_vencimiento: perecedero.input.checked ? diasAviso.value || null : null,
            stock_minimo: P.numeroDe(minimo.value) || 0, cantidad_almacen: P.numeroDe(cantidad.value) || 0,
            precio_venta_manual: manual.input.checked ? P.precioDeVenta(manualIngresado) : null,
          };
          if (destino.value === "VENTA_COMPUESTA") {
            if (insumo.input.value.trim() && !insumo.valor()) { mostrarPanel("datos"); insumo.foco(); P.aviso("Elegí el insumo de la lista", "error"); return; }
            var elegido = insumo.valor(), rinde = Number(rendimiento.value);
            if (elegido && (!Number.isInteger(rinde) || rinde < 1 || rinde > 1000)) {
              mostrarPanel("datos"); rendimiento.focus(); P.aviso("Ingresá entre 1 y 1000 porciones por unidad.", "error"); return;
            }
            if (!elegido && rendimiento.value.trim()) { mostrarPanel("datos"); insumo.foco(); P.aviso("Elegí el insumo al que corresponde este rendimiento.", "error"); return; }
            if (Number(elegido) !== Number((recetaInicial && recetaInicial.insumo_id) || 0) || (elegido && rinde !== Number(recetaInicial && recetaInicial.rendimiento))) {
              cuerpo.receta = elegido ? { insumo_id: Number(elegido), rendimiento: rinde } : null;
            }
          }
          if (margenesEditados) cuerpo.margenes_boca = preciosBoca.filter(function (f) { return f.input.value.trim() !== ""; }).map(function (f) {
            return { boca_id: f.boca.boca_id, margen: porcentajeOpcional(f.input) };
          });
          if (editar) {
            cuerpo.activo = activo.input.checked;
            if (P.numeroDe(cantidad.value) === stockAlmacenDe(detalle)) delete cuerpo.cantidad_almacen;
            // Guardar nombre, stock u otros datos no debe cambiar un precio ya fijado.
            if (!precioIntervenido) { delete cuerpo.precio_compra; delete cuerpo.margen; delete cuerpo.precio_venta_manual; }
          }
          if (!cuerpo.nombre.trim()) { mostrarPanel("datos"); nombre.classList.add("invalido"); nombre.focus(); return; }
          P.ejecutar(ev.currentTarget, function () {
            return (editar ? P.put("/productos/" + p.id, cuerpo) : P.post("/productos", cuerpo)).then(function (r) {
              if (!r.encolado) P.aviso(r.mensaje, "ok");
              P.olvidarOpciones();
              m.cerrar();
              if (alGuardar) alGuardar({ id: r.id || p.id, nombre: cuerpo.nombre, codigo: cuerpo.codigo });
            });
          }).catch(function () {});
        } })],
      });
      return m;
    }).catch(P.error);
  };
  function stockAlmacenDe(detalle) {
    if (!detalle) return 0;
    var fila = detalle.stock.filter(function (s) { return Number(s.es_almacen) === 1; })[0];
    return fila ? Number(fila.cantidad) : 0;
  }

  P.ruta.registrar(/^\/gestion\/productos$/, function (c) {
    P.solapasGestion(c, "/gestion/productos");
    function recargar() { tabla.recargar(); }
    function abrirProducto(base) {
      return P.formProducto(base, recargar, base.id ? recargar : null, { id: "gestion-producto", datos: base });
    }
    var tabla = P.tabla({
      listado: "productos",
      alClickFila: function (f) { abrirProducto({ id: f.id }); },
      placeholderBuscar: "Nombre o código",
      seleccion: seleccionEliminar("productos"),
      celdas: {
        stock: function (v, f) { return h("span.numero" + (Number(v) < 0 ? ".negativo" : ""), P.f.numero(v)); },
        revision_precio: function (v) { return /^Revisar/.test(v || "") ? P.chip(v, "PENDIENTE") : (v || ""); },
        fecha_caducidad: function (v, f) {
          if (!v) return "";
          var vencido = v < P.hoy();
          var pronto = !vencido && v <= P.sumarDias(P.hoy(), Number(f.dias_aviso_vencimiento));
          return vencido ? P.chip(P.f.fecha(v), "ANULADA") : pronto ? P.chip(P.f.fecha(v), "PENDIENTE") : P.f.fecha(v);
        },
      },
    });
    c.appendChild(h("div.gestion-acciones",
      h("div.gestion-acciones-grupo",
      P.btn("Administrar solicitudes", { tipo: "suave", chico: true, icono: "solicitud", onclick: function () { P.ruta.ir("/gestion/solicitudes"); } }),
      P.btn("Traspasos entre bocas", { tipo: "suave", chico: true, icono: "traspaso", onclick: function () { P.formSolicitud("traspaso", function () { tabla.recargar(); }); } }),
      P.btn("Sumar stock", { tipo: "suave", chico: true, icono: "mas", onclick: function () { P.formAjusteStock(true, function () { tabla.recargar(); }); } }),
      P.btn("Bajar stock", { tipo: "suave", chico: true, icono: "baja", onclick: function () { P.formAjusteStock(false, function () { tabla.recargar(); }); } }),
      P.btn("Más", { tipo: "suave", chico: true, icono: "lista", onclick: function (ev) {
        P.menuFlotante(ev.currentTarget, [
          { texto: "Stock por boca", icono: "stock", accion: function () { P.ruta.ir("/gestion/stock"); } },
          { texto: "Movimientos de stock", icono: "historial", accion: function () { P.ruta.ir("/gestion/movimientos"); } },
          { texto: "Bajas registradas", icono: "baja", accion: function () { P.ruta.ir("/gestion/bajas"); } },
        ]);
      } })),
      h("div.gestion-accion-nueva", P.btn("Nuevo producto", { tipo: "primario", icono: "mas", onclick: function () { abrirProducto({}); } }))));
    c.appendChild(tabla.el);
    P.continuidad.registrarVentana("gestion-producto", abrirProducto);
  }, { admin: true, titulo: "Productos y stock" });

  function subpagina(c, titulo, subtitulo, acciones) {
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/gestion/productos" }, P.icono("volver"), "Productos y stock general"),
      h("h1.titulo-pagina", titulo), h("p.subtitulo", subtitulo)), h("div.pagina-acciones", acciones || [])));
  }

  P.ruta.registrar(/^\/gestion\/solicitudes$/, function (c) {
    var v = null;
    subpagina(c, "Solicitudes", "Todas las solicitudes entre bocas. Como administrador podés despachar y recibir cualquiera.", [
      P.btn("Traspaso directo", { tipo: "primario", icono: "traspaso", onclick: function () { P.formSolicitud("traspaso", function () { v.recargar(); }); } }),
      P.btn("Nueva solicitud", { tipo: "secundario", icono: "mas", onclick: function () { P.formSolicitud("pedido", function () { v.recargar(); }); } }),
    ]);
    v = P.vistaSolicitudes(c, { admin: true });
  }, { admin: true, titulo: "Solicitudes" });

  P.ruta.registrar(/^\/gestion\/stock$/, function (c) {
    subpagina(c, "Stock por boca", "Cuánto hay de cada producto en cada boca, según los movimientos.");
    c.appendChild(P.tabla({ listado: "stock", celdas: { cantidad: P.cantidadPorBoca } }).el);
  }, { admin: true, titulo: "Stock por boca" });

  P.ruta.registrar(/^\/gestion\/movimientos$/, function (c) {
    subpagina(c, "Movimientos de stock", "Compras, ventas, traspasos, bajas y ajustes. Filtrá por el almacén para ver sus movimientos.");
    c.appendChild(P.tabla({ listado: "movimientos" }).el);
  }, { admin: true, titulo: "Movimientos" });

  P.ruta.registrar(/^\/gestion\/bajas$/, function (c) {
    var t = null;
    subpagina(c, "Bajas de stock", "Productos rotos, vencidos o usados como materia prima o insumo.", [
      P.btn("Bajar stock", { tipo: "primario", icono: "baja", onclick: function () { P.formAjusteStock(false, function () { t.recargar(); }); } }),
    ]);
    t = P.tabla({ listado: "bajas" });
    c.appendChild(t.el);
  }, { admin: true, titulo: "Bajas" });

  // ------------------------------------------------------------------ proveedores
  P.formProveedor = function (base, alGuardar, alEliminar, reanudar) {
    base = base || {};
    var editar = !!base.id;
    return (editar ? P.get("/proveedores/" + base.id).then(function (r) { return r.proveedor; }) : Promise.resolve(base)).then(function (p) {
      var codigo = P.input({ valor: p.codigo, max: 30, placeholder: editar ? "" : "Se asigna solo si lo dejás vacío" });
      var razon = P.input({ valor: p.razon_social, max: 160 });
      var cuit = P.input({ valor: p.cuit, max: 13, placeholder: "20-12345678-9", inputmode: "numeric" });
      var tel = P.input({ valor: p.telefono, max: 40 });
      var mail = P.input({ valor: p.email, max: 120, tipo: "email" });
      var dir = P.input({ valor: p.direccion, max: 200 });
      var contacto = P.input({ valor: p.contacto, max: 120 });
      var obs = h("textarea.campo-control", { maxlength: 2000 }, p.observaciones || "");
      var activo = P.check("Proveedor activo", editar ? Number(p.activo) === 1 : true);
      var m = P.modal({
        titulo: editar ? p.razon_social : "Nuevo proveedor", ancho: "ancha", reanudar: reanudar,
        contenido: h("div.columna",
          h("div.grilla.grilla-3", P.campo("Código", codigo), P.campo("Razón social", razon, { requerido: true }), P.campo("CUIT", cuit)),
          h("div.grilla.grilla-3", P.campo("Teléfono", tel), P.campo("Correo", mail), P.campo("Contacto", contacto)),
          P.campo("Dirección", dir), P.campo("Observaciones", obs), editar ? activo : null),
        acciones: [editar && alEliminar ? botonEliminar("proveedores", p.id, function () { return m; }, alEliminar) : null,
          P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn(editar ? "Guardar" : "Crear proveedor", { tipo: "primario", icono: "check", onclick: function (ev) {
          var cuerpo = { codigo: codigo.value, razon_social: razon.value, cuit: cuit.value, telefono: tel.value, email: mail.value, direccion: dir.value, contacto: contacto.value, observaciones: obs.value };
          if (editar) cuerpo.activo = activo.input.checked;
          P.ejecutar(ev.currentTarget, function () {
            return (editar ? P.put("/proveedores/" + p.id, cuerpo) : P.post("/proveedores", cuerpo)).then(function (r) {
              if (!r.encolado) P.aviso(r.mensaje, "ok");
              P.olvidarOpciones();
              m.cerrar();
              if (alGuardar) alGuardar({ id: r.id || p.id, razon_social: cuerpo.razon_social });
            });
          }).catch(function () {});
        } })],
      });
      return m;
    }).catch(P.error);
  };

  P.ruta.registrar(/^\/gestion\/proveedores$/, function (c) {
    P.solapasGestion(c, "/gestion/proveedores");
    function recargar() { t.recargar(); }
    function abrirProveedor(base) {
      return P.formProveedor(base, recargar, base.id ? recargar : null, { id: "gestion-proveedor", datos: base });
    }
    var t = P.tabla({
      listado: "proveedores",
      alClickFila: function (f) { abrirProveedor({ id: f.id }); },
      seleccion: seleccionEliminar("proveedores"),
    });
    c.appendChild(h("div.gestion-acciones",
      h("div.gestion-acciones-grupo", P.btn("Compras por proveedor", { tipo: "suave", chico: true, icono: "estadisticas", onclick: function () { P.cache["compras:vista"] = "compras"; P.ruta.ir("/compras"); } })),
      h("div.gestion-accion-nueva", P.btn("Nuevo proveedor", { tipo: "primario", icono: "mas", onclick: function () { abrirProveedor({}); } }))));
    c.appendChild(t.el);
    P.continuidad.registrarVentana("gestion-proveedor", abrirProveedor);
  }, { admin: true, titulo: "Proveedores" });

  // ------------------------------------------------------------------ bocas y cajas
  function formBoca(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    var nombre = P.input({ valor: base.nombre, max: 80 });
    var sentidoInicial = editar ? (Number(base.es_origen) && Number(base.es_destino) ? "AMBOS" : Number(base.es_origen) ? "ORIGEN" : "DESTINO") : "AMBOS";
    var sentido = P.segmentado([{ valor: "ORIGEN", texto: "Sólo origen" }, { valor: "DESTINO", texto: "Sólo destino" }, { valor: "AMBOS", texto: "Origen y destino" }], sentidoInicial);
    var esProveeduria = Number(base.es_almacen) === 1;
    var almacen = P.check("Usar como proveeduría", esProveeduria, esProveeduria ? "Esta boca recibe las compras. Para cambiarla, elegí otra boca como proveeduría." : "Recibirá el stock de las nuevas compras y reemplazará a la proveeduría actual.");
    almacen.input.disabled = esProveeduria;
    var margen = P.input({ inputmode: "decimal", valor: valorEditable(base.margen_venta), placeholder: "Usar precio general" });
    var desc = P.input({ valor: base.descripcion, max: 255, placeholder: "Opcional" });
    var activo = P.check("Boca activa", editar ? Number(base.activo) === 1 : true);
    var m = P.modal({
      titulo: editar ? base.nombre : "Nueva boca de expendio",
      reanudar: { id: "gestion-boca", datos: { id: base.id } },
      contenido: h("div.columna", P.campo("Nombre", nombre, { requerido: true }),
        P.campo("Sentido", sentido, { ayuda: "Origen: entrega productos (tiene stock). Destino: recibe o consume productos." }),
        almacen, P.campo("Margen de venta de la boca (%)", margen, { ayuda: "Se aplica al costo de referencia de cada producto. Podés definir un margen especial en su ficha." }),
        P.campo("Descripción", desc), editar ? activo : null),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", onclick: function (ev) {
        var valorMargen = porcentajeOpcional(margen);
        if (!porcentajeValido(valorMargen)) { marcarMargenInvalido(margen); return; }
        var cuerpo = { nombre: nombre.value, sentido: sentido.valor(), es_almacen: almacen.input.checked, descripcion: desc.value, margen_venta: valorMargen };
        if (editar) cuerpo.activo = activo.input.checked;
        P.ejecutar(ev.currentTarget, function () {
          return (editar ? P.put("/bocas/" + base.id, cuerpo) : P.post("/bocas", cuerpo)).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); P.olvidarOpciones(); m.cerrar(); if (alGuardar) alGuardar(); });
        }).catch(function () {});
      } })],
    });
    return m;
  }
  function formCaja(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    return P.opciones("bocas", true).then(function (bocas) {
      var boca = P.select(bocas, base.boca_id, { vacio: "Elegí la boca" });
      var nombre = P.input({ valor: base.nombre || "Caja 1", max: 80 });
      var ancho = P.segmentado([{ valor: 80, texto: "80 mm" }, { valor: 58, texto: "58 mm" }], base.ancho_ticket || 80);
      var auto = P.check("Imprimir el ticket automáticamente al cobrar", editar ? Number(base.impresion_automatica) === 1 : true);
      var activo = P.check("Caja activa", editar ? Number(base.activo) === 1 : true);
      var m = P.modal({
        titulo: editar ? "Editar caja" : "Nueva caja",
        reanudar: { id: "gestion-caja", datos: { id: base.id } },
        contenido: h("div.columna", P.campo("Boca", boca, { requerido: true }), P.campo("Nombre", nombre, { requerido: true }),
          P.campo("Ancho del papel de la tiquetera", ancho), auto, editar ? activo : null),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", onclick: function (ev) {
          var cuerpo = { boca_id: boca.value, nombre: nombre.value, ancho_ticket: ancho.valor(), impresion_automatica: auto.input.checked };
          if (editar) cuerpo.activo = activo.input.checked;
          P.ejecutar(ev.currentTarget, function () {
            return (editar ? P.put("/cajas/" + base.id, cuerpo) : P.post("/cajas", cuerpo)).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); P.olvidarOpciones(); m.cerrar(); if (alGuardar) alGuardar(); });
          }).catch(function () {});
        } })],
      });
      return m;
    }).catch(P.error);
  }

  P.ruta.registrar(/^\/gestion\/bocas$/, function (c) {
    P.solapasGestion(c, "/gestion/bocas");
    function abrirBoca(datos) {
      var cargar = datos.id ? P.get("/bocas/" + datos.id).then(function (r) { return r.boca; }) : Promise.resolve({});
      return cargar.then(function (boca) { return formBoca(boca, function () { tBocas.recargar(); }); }).catch(P.error);
    }
    function abrirCaja(datos) {
      var cargar = datos.id ? P.get("/cajas/" + datos.id).then(function (r) { return r.caja; }) : Promise.resolve({});
      return cargar.then(function (caja) { return formCaja(caja, function () { tCajas.recargar(); }); }).catch(P.error);
    }
    var tBocas = P.tabla({
      listado: "bocas",
      celdas: { margen_venta: function (valor) { return valor == null ? "General" : P.f.pct(valor); } },
      alClickFila: function (f) { abrirBoca({ id: f.id }); },
    });
    var tCajas = P.tabla({
      listado: "cajas",
      alClickFila: function (f) { abrirCaja({ id: f.id }); },
    });
    c.appendChild(h("div.fila-separada", { style: { marginBottom: "12px" } }, h("h2.seccion-titulo", "Bocas de expendio"),
      P.btn("Nueva boca", { tipo: "primario", icono: "mas", onclick: function () { abrirBoca({}); } })));
    c.appendChild(tBocas.el);
    c.appendChild(h("div.fila-separada", { style: { margin: "26px 0 12px" } }, h("h2.seccion-titulo", "Cajas"),
      P.btn("Nueva caja", { tipo: "primario", icono: "mas", onclick: function () { abrirCaja({}); } })));
    c.appendChild(h("p.texto-3", { style: { marginTop: "-6px" } }, "Cada boca puede tener varias cajas. Al ingresar, el usuario elige en qué caja trabaja."));
    c.appendChild(tCajas.el);
    P.continuidad.registrarVentana("gestion-boca", abrirBoca);
    P.continuidad.registrarVentana("gestion-caja", abrirCaja);
  }, { admin: true, titulo: "Bocas y cajas" });

  // ------------------------------------------------------------------ usuarios
  function formUsuario(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    var reanudar = { id: "gestion-usuario", datos: { id: base.id } };
    return Promise.all([P.opciones("bocas", true), editar ? P.get("/usuarios/" + base.id) : Promise.resolve(null)]).then(function (r) {
      var bocas = r[0];
      var u = r[1] ? r[1].usuario : {};
      var asignadas = r[1] ? r[1].bocas : [];
      if (Number(u.es_admin_general)) {
        return P.modal({ titulo: u.nombre, reanudar: reanudar, contenido: P.mensaje("Es un administrador del sistema general: entra con su DNI y su contraseña de Mi AJB y se gestiona desde ahí.") });
      }
      var usuario = P.input({ valor: u.usuario, max: 60, placeholder: "Ej.: maria.comedor" });
      var nombre = P.input({ valor: u.nombre, max: 120 });
      var rol = P.segmentado([
        { valor: "CAJERO", texto: "Usuario de boca" },
        { valor: "ADMIN", texto: "Administrador" },
        { valor: "SEGURIDAD", texto: "Seguridad" }
      ], u.rol || "CAJERO", function (v) { zonaBocas.hidden = permisos.hidden = v !== "CAJERO"; });
      var clave = P.inputClave({ placeholder: editar ? "Dejala vacía para no cambiarla" : "Al menos 6 caracteres", autocomplete: "new-password" });
      var recepcion = P.check("Gestionar reservas, ingresos, salidas y saldos", !!Number(u.gestionar_reservas));
      var cierre = P.check("Confirmar cierres de caja", !!Number(u.puede_cerrar_caja));
      var anulacion = P.check("Anular tickets", !!Number(u.puede_anular_ticket));
      var permisos = P.campo("Permisos del usuario", h("div.columna", recepcion, cierre, anulacion));
      var checks = bocas.map(function (b) { var ch = P.check(b.texto, asignadas.indexOf(b.valor) >= 0); ch.valor = b.valor; return ch; });
      var zonaBocas = P.campo("Bocas que atiende", h("div.grilla.grilla-2", { style: { gap: "8px" } }, checks), { ayuda: "Al ingresar va directo a su boca. Si tiene varias, elige." });
      zonaBocas.hidden = permisos.hidden = (u.rol || "CAJERO") !== "CAJERO";
      var activo = P.check("Usuario habilitado", editar ? Number(u.activo) === 1 : true);
      var m = P.modal({
        titulo: editar ? u.nombre : "Nuevo usuario", ancho: "ancha", reanudar: reanudar,
        contenido: h("div.columna",
          h("div.grilla.grilla-2", P.campo("Nombre y apellido", nombre, { requerido: true }), P.campo("Usuario (para ingresar)", usuario, { requerido: true })),
          P.campo("Rol", rol, { ayuda: "Seguridad puede consultar vehículos y deudas. Administración gestiona todo el predio." }),
          zonaBocas, permisos,
          P.campo(editar ? "Restablecer contraseña temporal" : "Contraseña temporal", clave, { requerido: !editar, ayuda: "El usuario deberá elegir su propia contraseña al ingresar." }),
          editar ? activo : null,
          editar ? h("p.texto-3.chico", "Último ingreso: " + (u.ultimo_ingreso ? P.f.fechaHora(u.ultimo_ingreso) : "nunca")) : null),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", icono: "check", onclick: function (ev) {
          var cuerpo = {
            usuario: usuario.value, nombre: nombre.value, rol: rol.valor(), password: clave.input.value || undefined,
            gestionar_reservas: recepcion.input.checked,
            puede_cerrar_caja: cierre.input.checked, puede_anular_ticket: anulacion.input.checked,
            bocas: checks.filter(function (ch) { return ch.input.checked; }).map(function (ch) { return ch.valor; }),
          };
          if (editar) cuerpo.activo = activo.input.checked;
          P.ejecutar(ev.currentTarget, function () {
            return (editar ? P.put("/usuarios/" + base.id, cuerpo) : P.post("/usuarios", cuerpo)).then(function (x) { if (!x.encolado) P.aviso(x.mensaje, "ok"); m.cerrar(); if (alGuardar) alGuardar(); });
          }).catch(function () {});
        } })],
      });
      return m;
    }).catch(P.error);
  }

  P.ruta.registrar(/^\/usuarios$/, function (c) {
    function abrirUsuario(base) { return formUsuario(base, function () { t.recargar(); }); }
    var t = P.tabla({ listado: "usuarios", sinEtiquetaBuscar: true, alClickFila: function (f) { abrirUsuario({ id: f.id }); } });
    c.appendChild(P.cabeceraConAcciones("Usuarios", null,
      P.btn("Nuevo usuario", { tipo: "primario", icono: "mas", onclick: function () { abrirUsuario({}); } })));
    c.appendChild(t.el);
    P.continuidad.registrarVentana("gestion-usuario", abrirUsuario);
  }, { admin: true, titulo: "Usuarios" });
})();
