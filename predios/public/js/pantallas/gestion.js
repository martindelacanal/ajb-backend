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
    VENTA_COMPUESTA: "Se arma con otros productos (por ejemplo un plato): se vende sin descontar stock propio.",
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
    c.appendChild(h("div.pagina-cabecera", h("div", h("h1.titulo-pagina", "Gestión"), h("p.subtitulo", "Productos, stock, proveedores, afiliados y bocas del predio."))));
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
  function botonEliminar(clave, id, modal, alEliminar) {
    var b = P.btn("Eliminar", { tipo: "peligro", icono: "borrar", onclick: function () {
      modal().cerrar();
      P.eliminarRegistros(clave, { ids: [id] }, alEliminar);
    } });
    b.classList.add("izquierda");
    return b;
  }

  P.formProducto = function (base, alGuardar, alEliminar) {
    base = base || {};
    var editar = !!base.id;
    var cargar = editar ? P.get("/productos/" + base.id) : Promise.resolve(null);
    cargar.then(function (detalle) {
      var p = detalle ? detalle.producto : base;
      var nombre = P.input({ valor: p.nombre, max: 160, placeholder: "Ej.: Agua mineral 500 ml" });
      var codigo = P.input({ valor: p.codigo, max: 60, placeholder: "Escaneá el código de barras o escribí uno propio" });
      codigo.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); compra.focus(); } });
      var compra = P.dinero({ valor: p.precio_compra !== undefined && p.precio_compra !== null ? P.f.numero(p.precio_compra) : "" });
      var margen = P.input({ inputmode: "decimal", valor: p.margen !== undefined && p.margen !== null ? P.f.numero(p.margen) : "", placeholder: "0" });
      margen.style.textAlign = "right";
      var venta = P.dinero({ soloLectura: true });
      var manual = P.check("Fijar el precio de venta a mano", false, "Si no, se calcula: compra + margen.");
      var destino = P.select(DESTINOS, p.destino || "VENTA_DIRECTA");
      var ayudaDestino = h("span.campo-ayuda", AYUDA_DESTINO[destino.value]);
      destino.addEventListener("change", function () { ayudaDestino.textContent = AYUDA_DESTINO[destino.value]; });
      var cantidad = P.input({ inputmode: "decimal", valor: editar ? P.f.numero(stockAlmacenDe(detalle)) : "0" });
      cantidad.style.textAlign = "right";
      var perecedero = P.check("Es perecedero", Number(p.perecedero) === 1, null, function (v) { zonaVence.hidden = !v; });
      var vence = P.input({ tipo: "date", valor: p.fecha_caducidad || "" });
      var zonaVence = P.campo("Fecha de caducidad (opcional)", vence);
      zonaVence.hidden = Number(p.perecedero) !== 1;
      var minimo = P.input({ inputmode: "decimal", valor: p.stock_minimo ? P.f.numero(p.stock_minimo) : "", placeholder: "Opcional" });
      var activo = P.check("Producto activo", editar ? Number(p.activo) === 1 : true, "Los dados de baja no aparecen para vender ni comprar.");

      function calcular() {
        if (manual.input.checked) { venta.readOnly = false; return; }
        venta.readOnly = true;
        var c = P.numeroDe(compra.value), mg = P.numeroDe(margen.value);
        venta.value = isNaN(c) ? "" : P.f.numero(P.redondear(c * (1 + (isNaN(mg) ? 0 : mg) / 100)));
      }
      [compra, margen].forEach(function (i) { i.addEventListener("input", calcular); });
      manual.input.addEventListener("change", function () { calcular(); if (manual.input.checked) venta.focus(); });
      if (editar && p.precio_venta !== undefined) {
        var calc = P.redondear(Number(p.precio_compra || 0) * (1 + Number(p.margen || 0) / 100));
        if (Math.abs(calc - Number(p.precio_venta)) > 0.01) { manual.input.checked = true; venta.readOnly = false; venta.value = P.f.numero(p.precio_venta); }
        else calcular();
      } else calcular();

      var formulario = h("div.columna",
        h("div.grilla.grilla-2", P.campo("Nombre", nombre, { requerido: true }), P.campo("Código de barras o único", codigo)),
        h("div.grilla.grilla-3",
          P.campo("Precio de compra", h("div.campo-con-prefijo", h("span", "$"), compra)),
          P.campo("Margen de utilidad (%)", margen),
          P.campo("Precio de venta", h("div.campo-con-prefijo", h("span", "$"), venta), { ayuda: "Calculado automáticamente" })),
        manual,
        h("div.grilla.grilla-2", P.campo("Destino del producto", h("div", destino, ayudaDestino)),
          P.campo(editar ? "Cantidad en almacén (ajuste)" : "Cantidad en almacén", cantidad, { ayuda: editar ? "Si la cambiás, queda registrado como ajuste manual." : "El almacén recibe los productos: ahí empieza su recorrido." })),
        h("div.grilla.grilla-2", h("div.columna", perecedero, zonaVence), P.campo("Stock mínimo (para avisos)", minimo)),
        editar ? activo : null);

      var contenido = formulario;
      if (detalle) {
        var stockLista = h("ul.lista-simple", detalle.stock.map(function (s) { return h("li", h("span", s.boca), h("strong.numero", P.f.numero(s.cantidad))); }));
        var precios = h("ul.lista-simple", detalle.precios.map(function (x) {
          return h("li", h("div", h("strong", P.f.fechaHora(x.fecha)), h("div.texto-3.chico", (({ ALTA: "Alta", EDICION: "Edición", COMPRA: "Compra N° " + x.referencia_id, IMPORTACION: "Último precio en el sistema anterior" })[x.origen] || x.origen) + " · " + (x.usuario_nombre || ""))),
            h("div", { style: { textAlign: "right" } }, h("div", "Compra " + P.f.pesos(x.precio_compra) + " · " + P.f.pct(x.margen)), h("strong", "Venta " + P.f.pesos(x.precio_venta))));
        }));
        var solapa = P.segmentado([{ valor: "datos", texto: "Datos" }, { valor: "stock", texto: "Stock por boca" }, { valor: "precios", texto: "Historial de precios" }], "datos", function (v) {
          formulario.hidden = v !== "datos"; stockLista.hidden = v !== "stock"; precios.hidden = v !== "precios";
        });
        stockLista.hidden = true;
        precios.hidden = true;
        contenido = h("div.columna", solapa, formulario, stockLista, precios,
          h("p.texto-3.chico", { style: { margin: 0 } }, "Creado " + P.f.fechaHora(p.fecha_creacion) + " por " + (p.creado_por || "—") + " · Modificado " + P.f.fechaHora(p.fecha_modificacion) + " por " + (p.modificado_por || "—")));
      }
      var m = P.modal({
        titulo: editar ? p.nombre : "Nuevo producto", subtitulo: editar ? "ID " + p.id + (p.codigo ? " · Código " + p.codigo : "") : null,
        ancho: "ancha", contenido: contenido,
        acciones: [editar && alEliminar ? botonEliminar("productos", p.id, function () { return m; }, alEliminar) : null,
          P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn(editar ? "Guardar cambios" : "Crear producto", { tipo: "primario", icono: "check", onclick: function (ev) {
          var cuerpo = {
            nombre: nombre.value, codigo: codigo.value, precio_compra: P.numeroDe(compra.value) || 0, margen: P.numeroDe(margen.value) || 0,
            destino: destino.value, perecedero: perecedero.input.checked, fecha_caducidad: perecedero.input.checked ? vence.value || null : null,
            stock_minimo: P.numeroDe(minimo.value) || 0, cantidad_almacen: P.numeroDe(cantidad.value) || 0,
            precio_venta_manual: manual.input.checked ? P.numeroDe(venta.value) : null,
          };
          if (editar) { cuerpo.activo = activo.input.checked; if (P.numeroDe(cantidad.value) === stockAlmacenDe(detalle)) delete cuerpo.cantidad_almacen; }
          if (!cuerpo.nombre.trim()) { nombre.classList.add("invalido"); nombre.focus(); return; }
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
    }).catch(P.error);
  };
  function stockAlmacenDe(detalle) {
    if (!detalle) return 0;
    var fila = detalle.stock.filter(function (s) { return Number(s.es_almacen) === 1; })[0];
    return fila ? Number(fila.cantidad) : 0;
  }

  P.ruta.registrar(/^\/gestion\/productos$/, function (c) {
    P.solapasGestion(c, "/gestion/productos");
    var tabla = P.tabla({
      listado: "productos",
      alClickFila: function (f) { P.formProducto({ id: f.id }, function () { tabla.recargar(); }, function () { tabla.recargar(); }); },
      placeholderBuscar: "Nombre o código",
      seleccion: seleccionEliminar("productos"),
      celdas: {
        stock: function (v, f) { return h("span.numero" + (Number(v) < 0 ? ".negativo" : ""), P.f.numero(v)); },
        fecha_caducidad: function (v) {
          if (!v) return "";
          var vencido = v < P.hoy();
          var pronto = !vencido && v <= P.sumarDias(P.hoy(), 7);
          return vencido ? P.chip(P.f.fecha(v), "ANULADA") : pronto ? P.chip(P.f.fecha(v), "PENDIENTE") : P.f.fecha(v);
        },
      },
      barra: [],
    });
    c.appendChild(h("div.fila", { style: { marginBottom: "14px" } },
      P.btn("Nuevo producto", { tipo: "primario", icono: "mas", onclick: function () { P.formProducto({}, function () { tabla.recargar(); }); } }),
      P.btn("Administrar solicitudes", { tipo: "secundario", icono: "solicitud", onclick: function () { P.ruta.ir("/gestion/solicitudes"); } }),
      P.btn("Traspasos entre bocas", { tipo: "secundario", icono: "traspaso", onclick: function () { P.formSolicitud("traspaso", function () { tabla.recargar(); }); } }),
      P.btn("Bajar stock", { tipo: "secundario", icono: "baja", onclick: function () { P.formBaja(function () { tabla.recargar(); }); } }),
      h("div.espacio"),
      P.btn("Más", { tipo: "texto", icono: "lista", onclick: function (ev) {
        P.menuFlotante(ev.currentTarget, [
          { texto: "Stock por boca", icono: "stock", accion: function () { P.ruta.ir("/gestion/stock"); } },
          { texto: "Movimientos de stock", icono: "historial", accion: function () { P.ruta.ir("/gestion/movimientos"); } },
          { texto: "Bajas registradas", icono: "baja", accion: function () { P.ruta.ir("/gestion/bajas"); } },
        ]);
      } })));
    c.appendChild(tabla.el);
  }, { admin: true, titulo: "Productos y stock" });

  function subpagina(c, titulo, subtitulo, acciones) {
    c.appendChild(h("div.pagina-cabecera", h("div",
      h("a.volver", { href: "#/gestion/productos" }, P.icono("volver"), "Productos y stock general"),
      h("h1.titulo-pagina", titulo), h("p.subtitulo", subtitulo)), h("div.pagina-acciones", acciones || [])));
  }

  P.ruta.registrar(/^\/gestion\/solicitudes$/, function (c) {
    var v = null;
    subpagina(c, "Solicitudes", "Todas las solicitudes entre bocas. Como administrador podés despachar y recibir cualquiera.", [
      P.btn("Nueva solicitud", { tipo: "secundario", icono: "mas", onclick: function () { P.formSolicitud("pedido", function () { v.recargar(); }); } }),
      P.btn("Traspaso directo", { tipo: "primario", icono: "traspaso", onclick: function () { P.formSolicitud("traspaso", function () { v.recargar(); }); } }),
    ]);
    v = P.vistaSolicitudes(c, { admin: true });
  }, { admin: true, titulo: "Solicitudes" });

  P.ruta.registrar(/^\/gestion\/stock$/, function (c) {
    subpagina(c, "Stock por boca", "Cuánto hay de cada producto en cada boca, según los movimientos.");
    c.appendChild(P.tabla({ listado: "stock" }).el);
  }, { admin: true, titulo: "Stock por boca" });

  P.ruta.registrar(/^\/gestion\/movimientos$/, function (c) {
    subpagina(c, "Movimientos de stock", "Compras, ventas, traspasos, bajas y ajustes. Filtrá por el almacén para ver sus movimientos.");
    c.appendChild(P.tabla({ listado: "movimientos" }).el);
  }, { admin: true, titulo: "Movimientos" });

  P.ruta.registrar(/^\/gestion\/bajas$/, function (c) {
    var t = null;
    subpagina(c, "Bajas de stock", "Productos rotos, vencidos o usados como materia prima o insumo.", [
      P.btn("Bajar stock", { tipo: "primario", icono: "baja", onclick: function () { P.formBaja(function () { t.recargar(); }); } }),
    ]);
    t = P.tabla({ listado: "bajas" });
    c.appendChild(t.el);
  }, { admin: true, titulo: "Bajas" });

  // ------------------------------------------------------------------ proveedores
  P.formProveedor = function (base, alGuardar, alEliminar) {
    base = base || {};
    var editar = !!base.id;
    (editar ? P.get("/proveedores/" + base.id).then(function (r) { return r.proveedor; }) : Promise.resolve(base)).then(function (p) {
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
        titulo: editar ? p.razon_social : "Nuevo proveedor", ancho: "ancha",
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
    }).catch(P.error);
  };

  P.ruta.registrar(/^\/gestion\/proveedores$/, function (c) {
    P.solapasGestion(c, "/gestion/proveedores");
    var t = P.tabla({
      listado: "proveedores",
      alClickFila: function (f) { P.formProveedor({ id: f.id }, function () { t.recargar(); }, function () { t.recargar(); }); },
      seleccion: seleccionEliminar("proveedores"),
    });
    c.appendChild(h("div.fila", { style: { marginBottom: "14px" } }, P.btn("Nuevo proveedor", { tipo: "primario", icono: "mas", onclick: function () { P.formProveedor({}, function () { t.recargar(); }); } }),
      P.btn("Compras por proveedor", { tipo: "texto", icono: "estadisticas", onclick: function () { P.cache["compras:vista"] = "compras"; P.ruta.ir("/compras"); } })));
    c.appendChild(t.el);
  }, { admin: true, titulo: "Proveedores" });

  // ------------------------------------------------------------------ bocas y cajas
  function formBoca(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    var nombre = P.input({ valor: base.nombre, max: 80 });
    var sentidoInicial = editar ? (Number(base.es_origen) && Number(base.es_destino) ? "AMBOS" : Number(base.es_origen) ? "ORIGEN" : "DESTINO") : "AMBOS";
    var sentido = P.segmentado([{ valor: "ORIGEN", texto: "Sólo origen" }, { valor: "DESTINO", texto: "Sólo destino" }, { valor: "AMBOS", texto: "Origen y destino" }], sentidoInicial);
    var almacen = P.check("Es el almacén (recibe las compras)", Number(base.es_almacen) === 1, "Sólo puede haber un almacén.");
    var desc = P.input({ valor: base.descripcion, max: 255, placeholder: "Opcional" });
    var activo = P.check("Boca activa", editar ? Number(base.activo) === 1 : true);
    var m = P.modal({
      titulo: editar ? base.nombre : "Nueva boca de expendio",
      contenido: h("div.columna", P.campo("Nombre", nombre, { requerido: true }),
        P.campo("Sentido", sentido, { ayuda: "Origen: entrega productos (tiene stock). Destino: recibe o consume productos." }),
        almacen, P.campo("Descripción", desc), editar ? activo : null),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", onclick: function (ev) {
        var cuerpo = { nombre: nombre.value, sentido: sentido.valor(), es_almacen: almacen.input.checked, descripcion: desc.value };
        if (editar) cuerpo.activo = activo.input.checked;
        P.ejecutar(ev.currentTarget, function () {
          return (editar ? P.put("/bocas/" + base.id, cuerpo) : P.post("/bocas", cuerpo)).then(function (r) { if (!r.encolado) P.aviso(r.mensaje, "ok"); P.olvidarOpciones(); m.cerrar(); if (alGuardar) alGuardar(); });
        }).catch(function () {});
      } })],
    });
  }
  function formCaja(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    P.opciones("bocas", true).then(function (bocas) {
      var boca = P.select(bocas, base.boca_id, { vacio: "Elegí la boca" });
      var nombre = P.input({ valor: base.nombre || "Caja 1", max: 80 });
      var ancho = P.segmentado([{ valor: 80, texto: "80 mm" }, { valor: 58, texto: "58 mm" }], base.ancho_ticket || 80);
      var auto = P.check("Imprimir el ticket automáticamente al cobrar", editar ? Number(base.impresion_automatica) === 1 : true);
      var activo = P.check("Caja activa", editar ? Number(base.activo) === 1 : true);
      var m = P.modal({
        titulo: editar ? "Editar caja" : "Nueva caja",
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
    }).catch(P.error);
  }

  P.ruta.registrar(/^\/gestion\/bocas$/, function (c) {
    P.solapasGestion(c, "/gestion/bocas");
    var tBocas = P.tabla({
      listado: "bocas",
      alClickFila: function (f) { P.get("/bocas/" + f.id).then(function (r) { formBoca(r.boca, function () { tBocas.recargar(); }); }).catch(P.error); },
    });
    var tCajas = P.tabla({
      listado: "cajas",
      alClickFila: function (f) { P.get("/cajas/" + f.id).then(function (r) { formCaja(r.caja, function () { tCajas.recargar(); }); }).catch(P.error); },
    });
    c.appendChild(h("div.fila-separada", { style: { marginBottom: "12px" } }, h("h2.seccion-titulo", "Bocas de expendio"),
      P.btn("Nueva boca", { tipo: "primario", icono: "mas", onclick: function () { formBoca({}, function () { tBocas.recargar(); }); } })));
    c.appendChild(tBocas.el);
    c.appendChild(h("div.fila-separada", { style: { margin: "26px 0 12px" } }, h("h2.seccion-titulo", "Cajas"),
      P.btn("Nueva caja", { tipo: "primario", icono: "mas", onclick: function () { formCaja({}, function () { tCajas.recargar(); }); } })));
    c.appendChild(h("p.texto-3", { style: { marginTop: "-6px" } }, "Cada boca puede tener varias cajas. Al ingresar, el usuario elige en qué caja trabaja."));
    c.appendChild(tCajas.el);
  }, { admin: true, titulo: "Bocas y cajas" });

  // ------------------------------------------------------------------ usuarios
  function formUsuario(base, alGuardar) {
    base = base || {};
    var editar = !!base.id;
    Promise.all([P.opciones("bocas", true), editar ? P.get("/usuarios/" + base.id) : Promise.resolve(null)]).then(function (r) {
      var bocas = r[0];
      var u = r[1] ? r[1].usuario : {};
      var asignadas = r[1] ? r[1].bocas : [];
      if (Number(u.es_admin_general)) {
        P.modal({ titulo: u.nombre, contenido: P.mensaje("Es un administrador del sistema general: entra con su DNI y su contraseña de Mi AJB y se gestiona desde ahí.") });
        return;
      }
      var usuario = P.input({ valor: u.usuario, max: 60, placeholder: "Ej.: maria.comedor" });
      var nombre = P.input({ valor: u.nombre, max: 120 });
      var rol = P.segmentado([{ valor: "CAJERO", texto: "Usuario de boca" }, { valor: "ADMIN", texto: "Administrador" }], u.rol || "CAJERO", function (v) { zonaBocas.hidden = v === "ADMIN"; });
      var clave = P.inputClave({ placeholder: editar ? "Dejala vacía para no cambiarla" : "Al menos 4 caracteres" });
      var checks = bocas.map(function (b) { var ch = P.check(b.texto, asignadas.indexOf(b.valor) >= 0); ch.valor = b.valor; return ch; });
      var zonaBocas = P.campo("Bocas que atiende", h("div.grilla.grilla-2", { style: { gap: "8px" } }, checks), { ayuda: "Al ingresar va directo a su boca. Si tiene varias, elige." });
      zonaBocas.hidden = (u.rol || "CAJERO") === "ADMIN";
      var activo = P.check("Usuario habilitado", editar ? Number(u.activo) === 1 : true);
      var m = P.modal({
        titulo: editar ? u.nombre : "Nuevo usuario", ancho: "ancha",
        contenido: h("div.columna",
          h("div.grilla.grilla-2", P.campo("Nombre y apellido", nombre, { requerido: true }), P.campo("Usuario (para ingresar)", usuario, { requerido: true })),
          P.campo("Rol", rol, { ayuda: "El administrador del camping ve todo el predio pero no entra al sistema general." }),
          zonaBocas,
          P.campo(editar ? "Nueva contraseña" : "Contraseña", clave, { requerido: !editar }),
          editar ? activo : null,
          editar ? h("p.texto-3.chico", "Último ingreso: " + (u.ultimo_ingreso ? P.f.fechaHora(u.ultimo_ingreso) : "nunca")) : null),
        acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar", { tipo: "primario", icono: "check", onclick: function (ev) {
          var cuerpo = {
            usuario: usuario.value, nombre: nombre.value, rol: rol.valor(), password: clave.input.value || undefined,
            bocas: checks.filter(function (ch) { return ch.input.checked; }).map(function (ch) { return ch.valor; }),
          };
          if (editar) cuerpo.activo = activo.input.checked;
          P.ejecutar(ev.currentTarget, function () {
            return (editar ? P.put("/usuarios/" + base.id, cuerpo) : P.post("/usuarios", cuerpo)).then(function (x) { if (!x.encolado) P.aviso(x.mensaje, "ok"); m.cerrar(); if (alGuardar) alGuardar(); });
          }).catch(function () {});
        } })],
      });
    }).catch(P.error);
  }

  P.ruta.registrar(/^\/usuarios$/, function (c) {
    var t = P.tabla({ listado: "usuarios", alClickFila: function (f) { formUsuario({ id: f.id }, function () { t.recargar(); }); } });
    c.appendChild(h("div.pagina-cabecera",
      h("div", h("h1.titulo-pagina", "Usuarios"), h("p.subtitulo", "Los usuarios del camping. Cada usuario de boca entra directo a la boca que tiene asignada.")),
      h("div.pagina-acciones", P.btn("Nuevo usuario", { tipo: "primario", icono: "mas", onclick: function () { formUsuario({}, function () { t.recargar(); }); } }))));
    c.appendChild(t.el);
  }, { admin: true, titulo: "Usuarios" });
})();
