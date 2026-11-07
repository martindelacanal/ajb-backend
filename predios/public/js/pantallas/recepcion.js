/* Recepción usa controles nativos, sin animaciones ni dependencias. */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P,
    h = P.h,
    pesos = P.f.pesos,
    fecha = P.f.fecha;
  var TIPOS = {
    GENERAL: "General",
    PASA_EL_DIA: "Pasa el día",
    CONTINGENTE: "Contingente",
    FEDERACION: "Federación"
  };
  var MEDIOS = {
    EFECTIVO: "Efectivo",
    TRANSFERENCIA: "Transferencia",
    AL_SALIR: "A saldar al salir",
    HABERES: "Planilla de descuento de haberes",
    CEDIDO: "Trasladado",
    RECIBIDO: "Recibido"
  };
  function opciones(obj) {
    return Object.keys(obj).map(function (k) {
      return {
        valor: k,
        texto: obj[k]
      };
    });
  }
  function lista(xs) {
    return xs.map(function (x) {
      return {
        valor: x.id,
        texto: x.nombre
      };
    });
  }
  function sel(xs, v, vacio) {
    return P.select(xs, v, vacio == null ? {} : {
      vacio: vacio
    });
  }
  function input(v, t) {
    return P.input({
      valor: v,
      tipo: t || "text"
    });
  }
  function texto(s) {
    return s == null || s === "" ? "—" : String(s);
  }
  function btn(s, fn, t) {
    return P.btn(s, {
      tipo: t || "secundario",
      onclick: function (e) {
        P.ejecutar(e.currentTarget, fn).catch(function () {});
      }
    });
  }
  function grupo(t, info, contenido) {
    return h("section.hoja.rec-seccion", h("h2", t), info ? h("p.texto-3", info) : null, contenido);
  }
  function grid() {
    return h("div.rec-grid", Array.prototype.slice.call(arguments));
  }
  function ir(id) {
    P.ruta.ir("/recepcion" + (id ? "/" + id : ""));
  }
  function tabla(cols, filas) {
    return h("div.rec-tabla", h("table", h("thead", h("tr", cols.map(function (s) {
      return h("th", {
        scope: "col"
      }, s);
    }))), h("tbody", filas.map(function (row) {
      return h("tr", row.map(function (v, i) {
        return h("td", h("span.rec-etiqueta-movil", { "aria-hidden": "true" }, cols[i]), h("div.rec-valor", P.textoTabla(v)));
      }));
    }))));
  }
  function nuevaClave() {
    var a = new Uint32Array(4);
    window.crypto.getRandomValues(a);
    return Array.from(a).map(function (x) {
      return ("00000000" + x.toString(16)).slice(-8);
    }).join("");
  }
  function get(k, b) {
    return P.get("/recepcion/" + k + P.qs(b || {}));
  }
  function cab(t, sub, acciones) {
    return P.cabeceraConAcciones(t, sub, h("div.fila", acciones));
  }
  function espacio(v) {
    return h("span", v);
  }
  function nombresRecursos(r) {
    return (r.recursos || []).map(function (x) { return x.nombre; }).join(", ") || r.recurso || "";
  }
  function vencida(r) {
    var hoy = P.hoy();
    return (r.personas || []).some(function (p) { return p.entrada && !p.salida && (p.salida_prevista || r.fecha_fin) < hoy; });
  }
  function cobroFinal(pendiente, consumos) {
    var neto = Math.round((Number(pendiente) + Number(consumos)) * 100) / 100;
    return h("div.rec-cotizacion", h("h3", "Liquidación de salida"),
      grid(P.dato(pendiente < 0 ? "Reserva a devolver" : "Reserva por cobrar", pesos(Math.abs(pendiente))),
        P.dato(consumos < 0 ? "Anticipo a devolver" : "Consumos por cobrar", pesos(Math.abs(consumos))),
        P.dato(neto < 0 ? "Total a devolver en el predio" : "Total a cobrar en el predio", pesos(Math.abs(neto)))),
      h("p.chico", "Si la reserva se creó en Turismo, verificá allí el pago original. Este saldo incluye las diferencias de la reserva y los consumos registrados por el predio."));
  }
  function liquidacionSalida(salida, borrador) {
    var total = Number(salida.total);
    var hayMovimientos = total !== 0 || Number(salida.alojamiento) !== 0 || Number(salida.consumos) !== 0;
    var puedeTrasladar = total > 0 && salida.presentes.length > 0;
    var resolver = sel([{ valor: "COBRAR", texto: total < 0 ? "Devolver ahora" : "Cobrar ahora" }]
      .concat(puedeTrasladar ? [{ valor: "TRASLADAR", texto: "Dejar pendiente para quienes siguen" }] : []),
    borrador.accion || (puedeTrasladar ? "" : "COBRAR"), puedeTrasladar ? "Elegí qué hacer con el importe" : null);
    var medio = sel(opciones({ EFECTIVO: MEDIOS.EFECTIVO, TRANSFERENCIA: MEDIOS.TRANSFERENCIA }), borrador.medio, "Elegí un medio");
    var caja = sel([], null, "Elegí una caja");
    var campoMedio = P.campo("Medio de pago", medio), campoCaja = P.campo("Caja de efectivo", caja);
    var vehiculo = sel([{ valor: "SALE", texto: "Sale del predio" }]
      .concat(salida.presentes.length ? [{ valor: "PERMANECE", texto: "Permanece en el predio" }] : []),
    borrador.vehiculo || (salida.presentes.length ? "" : "SALE"), salida.presentes.length ? "Elegí una opción" : null);
    var cajasCargadas = false;
    function actualizar() {
      campoMedio.hidden = !total || resolver.value !== "COBRAR";
      campoCaja.hidden = campoMedio.hidden || medio.value !== "EFECTIVO";
      if (campoCaja.hidden || cajasCargadas) return;
      cajasCargadas = true;
      P.opciones("cajas").then(function (xs) {
        var asignada = P.puesto() && P.puesto().caja_id;
        if (!P.esAdmin()) xs = xs.filter(function (x) { return asignada && String(x.valor) === String(asignada); });
        var preferida = borrador.caja_id || asignada || (xs.length === 1 ? xs[0].valor : "");
        opSelect(caja, xs, preferida, "Elegí una caja");
        borrador.caja_id = caja.value;
      }).catch(function (e) { cajasCargadas = false; P.error(e); });
    }
    resolver.onchange = function () { borrador.accion = resolver.value; actualizar(); };
    medio.onchange = function () { borrador.medio = medio.value; actualizar(); };
    caja.onchange = function () { borrador.caja_id = caja.value; };
    vehiculo.onchange = function () { borrador.vehiculo = vehiculo.value; };
    actualizar();
    return {
      vista: h("div.rec-cotizacion.columna",
        h("h3", "Liquidación de salida"),
        h("ul.vehiculo-detalle", salida.personas.map(function (p) {
          return h("li", h("div", h("strong", p.nombre),
            h("div.chico.texto-2", "Alojamiento " + pesos(p.alojamiento) + " · Consumos " + pesos(p.consumos)),
            Number(p.trasladado) ? h("div.chico.texto-2", "Incluye " + pesos(p.trasladado) + " de salidas anteriores") : null),
          h("strong.sin-corte", pesos(p.total)));
        })),
        h("p.fuerte", total < 0 ? "Total a devolver: " + pesos(-total) : total > 0 ? "Total a cobrar: " + pesos(total) : "Sin diferencia de dinero"),
        puedeTrasladar ? P.campo("Qué hacer con la deuda", resolver) : null,
        puedeTrasladar ? h("p.chico.texto-2", "Si la dejás pendiente, el importe quedará para " + salida.presentes.map(function (p) { return p.nombre; }).join(", ") + ".") : null,
        grid(campoMedio, campoCaja, salida.vehiculo_pendiente ? P.campo("Salida del vehículo", vehiculo) : null)),
      datos: function () {
        var accion = hayMovimientos ? resolver.value : undefined;
        if (hayMovimientos && !accion) { resolver.focus(); throw Error("Elegí si se cobra ahora o se traslada la deuda."); }
        if (!campoMedio.hidden && !medio.value) { medio.focus(); throw Error("Elegí cómo se registra el pago."); }
        if (!campoCaja.hidden && !caja.value) { caja.focus(); throw Error(P.esAdmin() ? "Elegí una caja para registrar el efectivo." : "Ingresá a tu caja para registrar el efectivo de recepción."); }
        if (salida.vehiculo_pendiente && !vehiculo.value) { vehiculo.focus(); throw Error("Indicá si el vehículo se va o permanece en el predio."); }
        return { accion: accion, medio: campoMedio.hidden ? undefined : medio.value, caja_id: campoCaja.hidden ? undefined : caja.value,
          vehiculo: salida.vehiculo_pendiente ? vehiculo.value : undefined };
      }
    };
  }
  P.ruta.registrar(/^\/recepcion$/, function (c) {
    var soloVencidas = P.ruta.query().ocupacion === "VENCIDA";
    var q = P.input({ tipo: "search", max: 80, placeholder: "Buscar por titular, DNI o reserva…" }),
      desde = input(soloVencidas ? "" : P.hoy(), "date"),
      hasta = input("", "date"),
      tipo = sel(opciones(TIPOS), "", "Todos"),
      serv = sel([], "", "Todos"),
      presencia = sel(opciones({
        PRESENTE: "Con huéspedes presentes",
        SALIDA: "Con salidas registradas",
        VENCIDA: "Estadía vencida sin salida"
      }), soloVencidas ? "VENCIDA" : "", "Cualquier situación"),
      at = P.check("Solo operaciones atípicas", false);
    var out = h("div.columna", {
        "aria-live": "polite"
      }),
      pag = 1, aviso = h("div", { "aria-live": "polite" });
    function cargar() {
      var turno = ++seq;
      return get("listar", {
        q: q.value,
        desde: desde.value,
        hasta: hasta.value,
        tipo: tipo.value,
        servicio_id: serv.value,
        ocupacion: presencia.value,
        atipicas: at.input.checked ? "1" : "",
        pagina: pag
      }).then(function (r) {
        if (turno !== seq) return;
        P.actualizarEstadiasVencidas(r.vencidas);
        P.vaciar(aviso);
        if (r.vencidas && presencia.value !== "VENCIDA") aviso.appendChild(
          P.mensaje(h("div.fila", h("strong", Number(r.vencidas) === 1 ? "1 estadía vencida sin salida" : r.vencidas + " estadías vencidas sin salida"),
            btn("Ver estadías vencidas", function () { P.ruta.ir("/recepcion?ocupacion=VENCIDA"); })), "aviso"));
        var ant = btn("Anterior", function () {
            pag--;
            return cargar();
          }),
          sig = btn("Siguiente", function () {
            pag++;
            return cargar();
          });
        ant.disabled = pag <= 1;
        sig.disabled = pag * 40 >= r.cantidad;
        P.reemplazar(out, h("div.rec-resumen", h("strong", r.cantidad + (Number(r.cantidad) === 1 ? " reserva" : " reservas")), espacio((r.viajeros || 0) + " personas"), espacio("Importe de la selección: " + pesos(r.importe))), r.filas.length ? tabla(["Reserva / titular", "Estadía", "Servicio / recurso", "Tipo", "Estado", "Importe"], r.filas.map(function (x) {
          return [h("div", h("a", {
            href: "#/recepcion/" + x.id
          }, P.textoTabla("T-" + x.id + " · " + x.titular))), fecha(x.fecha_inicio) + " – " + fecha(x.fecha_fin), [x.servicio, nombresRecursos(x)].filter(Boolean).join(" · "), TIPOS[x.tipo || "GENERAL"],
            Number(x.vencida) ? h("div.columna", P.chip("Vencida sin salida", "VENCIDO"), h("span.chico", P.textoTabla((x.huespedes_pendientes || []).join(", ")))) : x.estado, pesos(x.precio_total)];
        })) : P.mensaje("No hay reservas con esos filtros. Podés cambiar las fechas o crear una reserva.", "info"), h("div.fila", ant, espacio("Página " + pag), sig));
      });
    }
    var seq = 0, espera;
    function filtrar() {
      clearTimeout(espera);
      pag = 1;
      actualizarBoton();
      cargar().catch(P.error);
    }
    P.alSalir(function () { clearTimeout(espera); seq++; });
    c.appendChild(cab(soloVencidas ? "Estadías vencidas sin salida" : "Reservas y estadías", null,
      [soloVencidas ? btn("Todas las reservas", function () { ir(); }) : null,
        P.btn("Movimientos", { icono: "historial", onclick: function () { ir("movimientos"); } }),
        P.esAdmin() ? btn("Catálogo de adicionales", function () { ir("adicionales"); }) : null,
        P.btn("Crear reserva", { tipo: "primario", icono: "mas", onclick: function () { ir("nueva"); } })]));
    c.appendChild(aviso);
    q.setAttribute("aria-label", "Buscar por titular, DNI o reserva");
    q.addEventListener("input", function () { clearTimeout(espera); seq++; espera = setTimeout(filtrar, 300); });
    q.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); filtrar(); } });
    var panel = h("div.tabla-filtros#recepcion-filtros", { role: "region", "aria-label": "Filtros de reservas", hidden: true },
      h("div.filtro-rango-fechas", { role: "group", "aria-label": "Rango de fechas" }, P.campo("Desde", desde), P.campo("Hasta", hasta)),
      P.campo("Servicio", serv), P.campo("Tipo", tipo), P.campo("Ocupación", presencia), at);
    panel.addEventListener("change", filtrar);
    presencia.onchange = function () {
      if (presencia.value === "VENCIDA") { desde.value = ""; hasta.value = ""; }
      if (soloVencidas && presencia.value !== "VENCIDA") c.querySelector("h1").textContent = "Reservas y estadías";
    };
    var cantidad = h("span.tabla-filtros-numero", { "aria-hidden": "true" });
    var filtros = P.btn("Filtros", { tipo: "secundario", icono: "filtro", onclick: function () { panel.hidden = !panel.hidden; actualizarBoton(); } });
    filtros.classList.add("tabla-boton-filtros");
    filtros.setAttribute("aria-controls", panel.id);
    filtros.appendChild(cantidad);
    function actualizarBoton() {
      var n = [desde.value, hasta.value, serv.value, tipo.value, presencia.value, at.input.checked].filter(Boolean).length;
      cantidad.textContent = String(n);
      cantidad.hidden = !n;
      filtros.setAttribute("aria-label", "Filtros" + (n ? " (" + n + " activos)" : ""));
      filtros.setAttribute("aria-expanded", String(!panel.hidden));
    }
    actualizarBoton();
    c.appendChild(h("div.hoja.rec-listado-filtros", h("div.tabla-barra", P.campo(null, q, { clase: "tabla-buscar" }), filtros), panel));
    c.appendChild(out);
    return get("opciones").then(function (o) {
      if (!c.isConnected) return;
      o.servicios.forEach(function (s) {
        serv.appendChild(h("option", {
          value: s.id
        }, s.nombre));
      });
      var previo = P.continuidad.datosPantalla();
      if (previo) {
        q.value = previo.q;
        desde.value = previo.desde;
        hasta.value = previo.hasta;
        tipo.value = previo.tipo;
        serv.value = previo.servicio;
        presencia.value = previo.presencia;
        at.input.checked = previo.atipicas;
        panel.hidden = previo.filtrosOcultos;
        pag = previo.pagina;
        if (soloVencidas && presencia.value !== "VENCIDA") c.querySelector("h1").textContent = "Reservas y estadías";
        actualizarBoton();
      }
      P.continuidad.guardarPantalla(function () {
        return { q: q.value, desde: desde.value, hasta: hasta.value, tipo: tipo.value, servicio: serv.value,
          presencia: presencia.value, atipicas: at.input.checked, filtrosOcultos: panel.hidden, pagina: pag };
      });
      return cargar();
    });
  }, {
    titulo: "Reservas y estadías"
  });
  var ORIGEN_MOV = { RECEPCION: "Recepción", TURISMO: "Turismo", CUENTA: "Cuenta de estadía" };
  var CONCEPTO_CUENTA = {
    CARGA: "Carga de saldo", RETIRO: "Retiro de saldo", REPARTO: "Reparto de saldo",
    COMPRA: "Compra", ANULACION: "Anulación de compra", SALDAR_CONSUMOS: "Liquidación de consumos",
    PAGO_RESERVA: "Pago de diferencia", DIFERENCIAL: "Diferencia de precio",
    CIERRE_SALIDA: "Cierre de cuenta por salida", PAGO_SALIDA_CONSUMOS: "Consumos liquidados al salir",
    TRASPASO_ALOJAMIENTO: "Traslado de deuda de alojamiento", TRASPASO_CONSUMOS: "Traslado de deuda de consumos"
  };
  function conceptoMovimiento(f) {
    return f.origen === "CUENTA" ? CONCEPTO_CUENTA[f.concepto] || f.concepto : f.concepto;
  }
  function verMovimiento(f) {
    P.modal({
      titulo: conceptoMovimiento(f),
      subtitulo: "Reserva T-" + f.reserva_id + " · " + P.f.fechaHora(f.fecha),
      ancho: "ancha",
      contenido: h("div.columna", grid(P.dato("Origen", ORIGEN_MOV[f.origen]), P.dato("Registró", texto(f.actor)),
        P.dato("Servicio", texto(f.servicio)), P.dato("Recurso", texto(f.recurso)),
        f.adicionales ? P.dato("Adicionales", f.adicionales) : null,
        f.importe == null ? null : P.dato("Importe", pesos(f.importe)),
        f.medio ? P.dato("Medio", MEDIOS[f.medio] || f.medio) : null),
      f.detalle ? h("p", f.detalle) : null,
      f.cambios && f.cambios.length ? tabla(["Campo", "Antes", "Después"], f.cambios.map(function (cambio) {
        return cambio.map(function (v) { return h("span", texto(v)); });
      })) : null)
    });
  }

  P.ruta.registrar(/^\/recepcion\/movimientos$/, function (c) {
    var clave = "tabla:recepcion-movimientos",
      guardado = P.cache[clave] || {},
      aplicados = guardado.filtros || {},
      q = P.input({ tipo: "search", max: 80, valor: aplicados.q, placeholder: "Reserva, titular o empleado…" }),
      desde = input(aplicados.desde, "date"), hasta = input(aplicados.hasta, "date"),
      serv = sel([], "", "Todos"), recurso = sel([], "", "Todos"), adicional = sel([], "", "Todos"),
      origen = sel(opciones(ORIGEN_MOV), aplicados.origen, "Todos"),
      out = h("div.columna", { "aria-live": "polite" }),
      catalogo, seq = 0;
    function cargarRecursos(valor) {
      if (!catalogo) return;
      opSelect(recurso, lista(catalogo.recursos.filter(function (r) {
        return !serv.value || String(r.servicio_id) === serv.value;
      })), valor, "Todos");
    }
    function cargar(pag) {
      var turno = ++seq;
      out.setAttribute("aria-busy", "true");
      P.reemplazar(out, P.cargando("Cargando movimientos…"));
      return get("movimientos", Object.assign({}, aplicados, { pagina: pag, filtros: catalogo ? "" : "1" })).then(function (d) {
        if (turno !== seq || !c.isConnected) return;
        if (d.filtros) {
          catalogo = d.filtros;
          opSelect(serv, lista(catalogo.servicios), aplicados.servicio_id, "Todos");
          cargarRecursos(aplicados.recurso_id);
          opSelect(adicional, lista(catalogo.adicionales), aplicados.adicional_id, "Todos");
        }
        P.cache[clave] = { filtros: aplicados, pagina: d.pagina };
        P.reemplazar(out, d.filas.length ? tabla(
          ["Fecha", "Reserva / titular", "Servicio / recurso", "Adicionales", "Movimiento", "Registró", "Importe", "Detalle"],
          d.filas.map(function (f) {
            return [P.f.fechaHora(f.fecha), h("a", { href: "#/recepcion/" + f.reserva_id },
              P.textoTabla("T-" + f.reserva_id + " · " + f.titular)),
              [f.servicio, f.recurso].filter(Boolean).join(" · "), texto(f.adicionales),
              conceptoMovimiento(f), texto(f.actor), f.importe == null ? "—" : pesos(f.importe),
              P.btn("Ver", { chico: true, tipo: "texto", titulo: "Ver detalle del movimiento", onclick: function () { verMovimiento(f); } })];
          })) : P.mensaje("No hay movimientos con esos filtros.", "info"),
          d.pagina > 1 || d.siguiente ? h("div.fila",
            P.btn("Anterior", { deshabilitado: d.pagina <= 1, onclick: function () { cargar(d.pagina - 1); } }),
            espacio("Página " + d.pagina),
            P.btn("Siguiente", { deshabilitado: !d.siguiente, onclick: function () { cargar(d.pagina + 1); } })) : null);
      }).catch(function (e) {
        if (turno === seq && c.isConnected) P.reemplazar(out, P.mensaje(e.message || "No se pudieron cargar los movimientos.", "error"));
      }).finally(function () {
        if (turno === seq) out.removeAttribute("aria-busy");
      });
    }
    P.alSalir(function () { seq++; });
    serv.onchange = function () { cargarRecursos(recurso.value); };
    c.appendChild(cab("Movimientos de reservas y estadías",
      "Historial de Turismo, operaciones de recepción y movimientos de cuenta.", P.btn("Reservas y estadías", {
        icono: "volver", onclick: function () { ir(); }
      })));
    c.appendChild(h("form.hoja.rec-listado-filtros", {
      onsubmit: function (e) {
        e.preventDefault();
        aplicados = { q: q.value, desde: desde.value, hasta: hasta.value, servicio_id: serv.value,
          recurso_id: recurso.value, adicional_id: adicional.value, origen: origen.value };
        cargar(1);
      }
    }, h("div.tabla-barra", P.campo("Buscar", q, { clase: "tabla-buscar" })),
    h("div.tabla-filtros",
      h("div.filtro-rango-fechas", { role: "group", "aria-label": "Fecha del movimiento" }, P.campo("Desde", desde), P.campo("Hasta", hasta)),
      P.campo("Servicio", serv), P.campo("Recurso", recurso), P.campo("Adicional", adicional), P.campo("Origen", origen),
      h("div.tabla-filtros-acciones", P.btn("Filtrar", { icono: "filtro", submit: true })))));
    c.appendChild(out);
    return cargar(guardado.pagina || 1);
  }, { titulo: "Movimientos de reservas y estadías" });

  function opSelect(el, items, value, vacio) {
    P.vaciar(el);
    el.appendChild(h("option", { value: "" }, vacio));
    items.forEach(function (x) { el.appendChild(h("option", { value: x.valor }, x.texto)); });
    el.value = value == null ? "" : String(value);
  }
  function crearAdicional(o, seleccion, alGuardar) {
    var servicio = sel(lista(o.servicios), seleccion.servicio_id, "Elegí un servicio"),
      recurso = sel([], null), regimen = sel(lista(o.regimenes), seleccion.regimen_id, "Elegí un régimen"),
      nombre = P.input({ max: 100 }), precio = P.dinero(),
      desde = input(seleccion.fecha_desde || P.hoy(), "date"), hasta = input("", "date");
    function cargarRecursos(valor) {
      opSelect(recurso, lista(o.recursos.filter(function (x) {
        return String(x.servicio_id) === servicio.value;
      })), valor, "Elegí un recurso");
    }
    cargarRecursos(seleccion.recurso_id);
    servicio.onchange = function () { cargarRecursos(null); };
    var m = P.modal({
      reanudar: { id: "recepcion-crear-adicional", datos: seleccion },
      titulo: "Crear adicional", subtitulo: "La tarifa se guarda también en Turismo.",
      contenido: h("div.columna", grid(P.campo("Artículo", nombre), P.campo("Precio por unidad y día ($)", precio)),
        grid(P.campo("Servicio", servicio), P.campo("Recurso", recurso), P.campo("Régimen", regimen)),
        grid(P.campo("Tarifa vigente desde", desde), P.campo("Vigente hasta (opcional)", hasta))),
      acciones: [btn("Cancelar", function () { m.cerrar(); }), btn("Guardar en catálogo", function () {
        if (!nombre.value.trim()) { nombre.focus(); throw Error("Escribí el nombre del artículo."); }
        var importe = P.importeDe(precio.value);
        if (!precio.value.trim() || !Number.isFinite(importe) || importe < 0) { precio.focus(); throw Error("Ingresá un precio diario válido."); }
        if (!servicio.value || !recurso.value || !regimen.value) throw Error("Elegí servicio, recurso y régimen para guardar la tarifa.");
        if (!desde.value || hasta.value && hasta.value < desde.value) throw Error("Revisá las fechas de vigencia de la tarifa.");
        return P.post("/recepcion/adicionales", {
          servicio_id: Number(servicio.value), recurso_id: Number(recurso.value), regimen_id: Number(regimen.value),
          nombre: nombre.value.trim(), precio: importe, fecha_desde: desde.value, fecha_hasta: hasta.value || null
        }).then(function (x) {
          m.cerrar();
          if (x.encolado) return;
          P.aviso("Adicional guardado en el catálogo de Turismo.", "ok");
          return alGuardar(x);
        });
      }, "primario")]
    });
    return m;
  }
  P.ruta.registrar(/^\/recepcion\/adicionales$/, function (c) {
    var servicio, recurso, catalogo, out = h("div");
    function pintar() {
      var nombres = new Map(catalogo.recursos.map(function (x) { return [Number(x.id), x]; }));
      var regimenes = new Map(catalogo.regimenes.map(function (x) { return [Number(x.id), x.nombre]; }));
      var tarifas = catalogo.adicionales.filter(function (a) {
        var rec = nombres.get(Number(a.recurso_id));
        return rec && (!servicio.value || String(rec.servicio_id) === servicio.value) && (!recurso.value || String(rec.id) === recurso.value);
      });
      P.reemplazar(out, tarifas.length ? tabla(["Artículo", "Servicio / recurso", "Régimen", "Precio diario", "Vigencia"], tarifas.map(function (a) {
        var rec = nombres.get(Number(a.recurso_id)), serv = catalogo.servicios.find(function (s) { return Number(s.id) === Number(rec.servicio_id); });
        return [a.nombre, [serv && serv.nombre, rec.nombre].filter(Boolean).join(" · "), regimenes.get(Number(a.regimen_id)) || "—",
          a.precio == null ? "—" : pesos(a.precio), a.fecha_desde ? fecha(a.fecha_desde) + (a.fecha_hasta ? " – " + fecha(a.fecha_hasta) : " en adelante") : "—"];
      })) : P.mensaje("No hay adicionales para esta selección.", "info"));
    }
    function alServicio() {
      opSelect(recurso, lista(catalogo.recursos.filter(function (x) { return String(x.servicio_id) === servicio.value; })), null, "Todos");
      recurso.disabled = !servicio.value;
      pintar();
    }
    return get("opciones").then(function (o) {
      if (!c.isConnected) return;
      catalogo = o;
      servicio = sel(lista(o.servicios), null, "Todos");
      recurso = sel([], null, "Todos");
      servicio.onchange = alServicio; recurso.onchange = pintar;
      function abrirAdicional(seleccion) {
        return crearAdicional(catalogo, seleccion, function () {
          return get("opciones").then(function (v) { catalogo = v; pintar(); });
        });
      }
      P.continuidad.registrarVentana("recepcion-crear-adicional", abrirAdicional);
      var previo = P.continuidad.datosPantalla();
      P.continuidad.guardarPantalla(function () {
        return { servicio: servicio.value, recurso: recurso.value };
      });
      c.appendChild(cab("Catálogo de adicionales", null, [
        btn("Todas las reservas", function () { ir(); }), btn("Crear adicional", function () {
          return abrirAdicional({ servicio_id: servicio.value, recurso_id: recurso.value });
        }, "primario")]));
      c.appendChild(grupo("Tarifas por día", null, h("div.columna", grid(P.campo("Servicio", servicio), P.campo("Recurso", recurso)), out)));
      if (previo) servicio.value = previo.servicio;
      alServicio();
      if (previo) { recurso.value = previo.recurso; pintar(); }
    });
  }, { titulo: "Catálogo de adicionales", admin: true });
  function formulario(c, o, r, cuenta, accion) {
    if (!c.isConnected) return;
    r = r || {};
    var previo = P.continuidad.datosPantalla();
    var hoy = P.hoy(),
      viajeros = previo ? previo.viajeros : (r.personas || []).map(function (p) {
        return Object.assign({}, p);
      }),
      extras = previo ? previo.extras : (r.adicionales_vigentes || r.adicionales || []).map(function (a) {
        return Object.assign({}, a, { porDia: !!(a.fecha_desde || a.fecha_hasta) });
      });
    var iniciada = (r.personas || []).some(function (p) { return p.entrada; });
    var recursosFijos = !!r.bloque_fecha_id;
    var checkout = accion === "salida", editarFechas = accion === "fechas";
    var ajustesSalida = previo && previo.ajustesSalida || {};
    var familia = previo ? previo.familia : [],
      titular = previo ? previo.titular : r.id ? {
        dni: r.titular_dni
      } : null,
      particular = previo ? previo.particular : null,
      titularMostrado = previo ? previo.titularMostrado : null,
      particularSinFicha = previo ? previo.particularSinFicha : false,
      cotizacion = previo ? previo.cotizacion : null,
      opId = previo ? previo.opId : nuevaClave(),
      versionInicial = previo ? previo.versionInicial : r.version;
    var tipo = sel(opciones(TIPOS), r.tipo || "GENERAL"),
      serv = sel(lista(o.servicios), r.servicio_id, "Elegí un servicio"),
      rec = sel([], null),
      reg = sel(lista(o.regimenes), r.regimen_id || 3, "Sin régimen");
    var inicio = input(r.fecha_inicio || hoy, "date"),
      fin = input(r.fecha_fin || P.sumarDias(hoy, 1), "date"),
      entidad = input(r.entidad),
      cantidad = input(r.cantidad || 1, "number"),
      traslado = input(hoy, "date");
    if (!previo && accion === "extender") {
      fin.value = P.sumarDias(fin.value < hoy ? hoy : fin.value, 1);
    }
    var dni = input(r.titular_dni),
      nom = input(""),
      ape = input(""),
      nac = input("", "date"),
      veh = r.vehiculo || {},
      marca = input(veh.marca),
      color = input(veh.color),
      patente = input(veh.patente),
      sector = input(veh.sector);
    var manual = P.dinero({ valor: r.manual == null ? "" : P.f.numero(r.manual) });
    var motivo = input(""),
      obs = input(r.observaciones),
      base = h("div.columna"),
      grupoViaje = h("div.columna"),
      cargos = h("div.columna"),
      part = h("div.columna"),
      estadoTit = h("div", {
        "aria-live": "polite"
      }),
      pre = h("div", {
        "aria-live": "polite"
      });
    var selectFamilia = sel([], null, "Elegí una persona"),
      selectExtra = sel([], null, "Elegí un adicional");
    var campos = { tipo: tipo, servicio: serv, regimen: reg, inicio: inicio, fin: fin, entidad: entidad, cantidad: cantidad,
      traslado: traslado, dni: dni, nombre: nom, apellido: ape, nacimiento: nac, marca: marca, color: color, patente: patente,
      sector: sector, precio: manual, motivo: motivo, observaciones: obs };
    function inicioAlquiler() {
      return inicio.value && hoy < inicio.value ? inicio.value : fin.value && hoy > fin.value ? fin.value : hoy;
    }
    function pintarAdicionales() {
      var tarifas = o.adicionales.filter(function (x) { return String(x.recurso_id) === rec.value && String(x.regimen_id) === reg.value; });
      var disponibles = new Map();
      tarifas.forEach(function (x) {
        if (extras.some(function (a) { return Number(a.adicional_id) === Number(x.id); })) return;
        var item = disponibles.get(Number(x.id)) || { valor: x.id, nombre: x.nombre, precios: [] };
        if (x.precio != null && item.precios.indexOf(Number(x.precio)) < 0) item.precios.push(Number(x.precio));
        disponibles.set(Number(x.id), item);
      });
      opSelect(selectExtra, Array.from(disponibles.values()).map(function (x) {
        return { valor: x.valor, texto: x.nombre + (x.precios.length === 1 ? " · " + pesos(x.precios[0]) + " por día" : "") };
      }), null, "Elegí un adicional");
      P.reemplazar(cargos, extras.map(function (a, i) {
        var n = input(a.cantidad, "number"), de = input(a.fecha_desde, "date"), hasta = input(a.fecha_hasta, "date");
        var dias = h("span.texto-2", { "aria-live": "polite" });
        function cambiar() {
          a.cantidad = n.value; a.fecha_desde = de.value; a.fecha_hasta = hasta.value;
          var cantidadDias = (Date.parse(hasta.value) - Date.parse(de.value)) / 86400000 + 1;
          dias.textContent = cantidadDias >= 1 ? cantidadDias + (cantidadDias === 1 ? " día de uso" : " días de uso") :
            !a.fecha_desde && !a.fecha_hasta && !a.porDia ? "Adicional de toda la estadía" : "Completá el período de uso.";
        }
        n.min = "1"; n.step = "1";
        de.min = hasta.min = inicio.value; de.max = hasta.max = fin.value;
        n.oninput = de.oninput = hasta.oninput = cambiar;
        cambiar();
        return h("fieldset.rec-viajero", h("legend", a.nombre), grid(P.campo("Unidades", n), P.campo("Primer día de uso", de), P.campo("Último día de uso", hasta)),
          h("div.fila-separada", dias, btn("Quitar " + a.nombre, function () {
          extras.splice(i, 1);
          pintarAdicionales();
        }, "texto")));
      }), disponibles.size ? h("div.fila", P.campo("Artículo disponible", selectExtra), btn("Agregar alquiler", function () {
        var x = disponibles.get(Number(selectExtra.value));
        if (!x) { selectExtra.focus(); throw Error("Elegí el artículo que querés alquilar."); }
        extras.push({ adicional_id: x.valor, nombre: x.nombre, cantidad: 1, fecha_desde: inicioAlquiler(), fecha_hasta: inicioAlquiler(), porDia: true });
        pintarAdicionales();
      })) : h("span.texto-2", !rec.value || !reg.value ? "Elegí un recurso y un régimen para ver los artículos." :
          extras.length ? "No hay más artículos disponibles para esta selección." : "No hay artículos disponibles para esta selección."),
        P.esAdmin() && rec.value && reg.value ? btn("Crear adicional en el catálogo", function () {
          return abrirAdicional({ servicio_id: serv.value, recurso_id: rec.value, regimen_id: reg.value, fecha_desde: inicioAlquiler() });
        }, "texto") : null);
    }
    function abrirAdicional(seleccion) {
      return crearAdicional(o, seleccion, function (x) {
        return get("opciones").then(function (v) {
          o.adicionales = v.adicionales;
          pintarAdicionales();
          selectExtra.value = String(x.id);
        });
      });
    }
    function recursos(v) {
      opSelect(rec, lista(o.recursos.filter(function (x) {
        return String(x.servicio_id) === serv.value;
      })), v, "Sin recurso");
      pintarAdicionales();
    }
    function pintarPersonas() {
      if (checkout || editarFechas) {
        var seleccionables = viajeros.filter(function (p) {
          var anterior = r.personas.find(function (v) { return String(v.dni) === String(p.dni); });
          return anterior && !anterior.salida && (!checkout || anterior.entrada);
        });
        P.reemplazar(grupoViaje, seleccionables.length ? seleccionables.map(function (p) {
          var nombre = p.apellido + ", " + p.nombre;
          if (editarFechas) {
            var prevista = input(p.salida_prevista, "date");
            prevista.min = p.entrada || inicio.value;
            prevista.oninput = function () { p.salida_prevista = prevista.value; };
            return h("fieldset.rec-viajero", h("legend", nombre),
              P.campo("Salida prevista individual", prevista, { ayuda: "Si queda vacía, se usa " + fecha(fin.value) + ", la fecha de la reserva." }));
          }
          var elegido = P.check("Registrar salida de " + nombre, !!p.salida);
          var efectiva = input(p.salida || hoy, "date");
          efectiva.min = p.entrada;
          efectiva.max = hoy;
          efectiva.required = true;
          efectiva.disabled = !elegido.input.checked;
          efectiva.oninput = function () { p.salida = efectiva.value; };
          elegido.input.onchange = function () {
            efectiva.disabled = !elegido.input.checked;
            p.salida = elegido.input.checked ? efectiva.value || hoy : "";
            if (elegido.input.checked) { efectiva.value = p.salida; efectiva.focus(); }
          };
          return h("fieldset.rec-viajero", h("legend", nombre), grid(elegido,
            P.campo("Fecha efectiva de salida", efectiva, { ayuda: "Salida prevista: " + fecha(p.salida_prevista || fin.value) })));
        }) : P.mensaje(checkout ? "No quedan huéspedes presentes." : "No quedan fechas de salida por modificar.", "info"));
        return;
      }
      opSelect(selectFamilia, familia.filter(function (x) {
        return !viajeros.some(function (v) {
          return String(v.dni) === String(x.dni);
        });
      }).map(function (p) {
        return {
          valor: p.dni,
          texto: p.apellido + ", " + p.nombre + " · " + p.dni
        };
      }), null, "Familiares y acompañantes");
      P.reemplazar(grupoViaje, viajeros.map(function (p, i) {
        function campo(key, t, label) {
          var el = input(p[key], t);
          el.addEventListener("input", function () {
            p[key] = el.value;
          });
          if (p.id && ["nombre", "apellido", "fecha_nacimiento", "dni"].indexOf(key) >= 0) el.readOnly = true;
          return P.campo(label, el);
        }
        var parentesco = sel(lista(o.parentescos), p.parentesco_id || 5);
        parentesco.disabled = !!p.id;
        parentesco.onchange = function () {
          p.parentesco_id = Number(parentesco.value);
        };
        var entrada = campo("entrada", "date", "Ingreso efectivo"),
          salida = campo("salida", "date", "Salida efectiva"),
          prevista = campo("salida_prevista", "date", "Salida prevista individual (opcional)"),
          yaSalio = (r.personas || []).some(function (anterior) { return anterior.salida && String(anterior.dni) === String(p.dni); }),
          yaIngreso = (r.personas || []).some(function (anterior) { return anterior.entrada && String(anterior.dni) === String(p.dni); });
        prevista.querySelector("input").readOnly = yaSalio;
        function marcarHoy(key, etiqueta) {
          p[key] = hoy;
          var control = etiqueta.querySelector("input");
          control.value = hoy;
          control.focus();
        }
        return h("fieldset.rec-viajero", h("legend", "Pasajero " + (i + 1) + (p.apellido ? " · " + p.apellido : "")), grid(campo("dni", "text", "DNI"), campo("nombre", "text", "Nombre"), campo("apellido", "text", "Apellido"), campo("fecha_nacimiento", "date", "Nacimiento"), P.campo("Vínculo", parentesco)), grid(entrada, prevista, salida), h("div.fila", btn("Ingresó hoy", function () {
          if (p.salida && p.salida < hoy) throw Error("El ingreso debe ser anterior o igual a la salida.");
          marcarHoy("entrada", entrada);
        }, "texto"), btn("Salió hoy", function () {
          if (!p.entrada) { entrada.querySelector("input").focus(); throw Error("Registrá primero la fecha de ingreso."); }
          marcarHoy("salida", salida);
        }, "texto"), yaIngreso ? null : btn("Quitar pasajero", function () {
          viajeros.splice(i, 1);
          pintarPersonas();
        }, "texto")));
      }), h("div.fila", P.campo("Agregar desde la ficha del titular", selectFamilia), btn("Incluir", function () {
        var p = familia.find(function (x) {
          return String(x.dni) === selectFamilia.value;
        });
        if (p) viajeros.push(Object.assign({}, p));
        pintarPersonas();
      }), btn("Cargar otra persona", function () {
        viajeros.push({
          parentesco_id: 5
        });
        pintarPersonas();
        grupoViaje.querySelectorAll("fieldset")[viajeros.length - 1].querySelector("input").focus();
      })));
    }
    function mostrarTitular(p) {
      P.reemplazar(estadoTit, h("strong", p.apellido + ", " + p.nombre + " · " + (Number(p.afiliado) ? "Afiliado" : "Particular")));
    }
    function mostrarParticular() {
      P.reemplazar(estadoTit, P.mensaje("No encontramos una ficha. Podés registrar un particular sin acceso a Mi AJB.", "info"));
      P.reemplazar(part, grid(P.campo("Nombre", nom), P.campo("Apellido", ape), P.campo("Nacimiento", nac)), btn("Usar este particular", function () {
        if (!nom.value || !ape.value || !nac.value || !/^\d{6,10}$/.test(dni.value)) throw Error("Completá DNI, nombre, apellido y nacimiento.");
        particular = { nombre: nom.value, apellido: ape.value, fecha_nacimiento: nac.value, dni: dni.value, parentesco_id: 1, tipo_persona_id: 4 };
        titular = titularMostrado = particular;
        particularSinFicha = false;
        familia = [particular];
        viajeros = [Object.assign({}, particular)];
        mostrarTitular(particular);
        P.vaciar(part);
        pintarPersonas();
      }));
    }
    function buscarTitular(q, editar) {
      return get("familia", {
        q: q
      }).then(function (f) {
        if (!editar && dni.value.trim() !== String(q)) return;
        if (!editar) {
          titular = f.titular;
          particular = null;
          viajeros = [];
        }
        familia = f.personas;
        titularMostrado = f.titular;
        particularSinFicha = !editar && !f.titular;
        P.vaciar(part);
        if (f.titular) {
          mostrarTitular(f.titular);
          if (!editar) {
            dni.value = f.titular.dni;
            viajeros = [Object.assign({}, f.titular)];
          }
        } else if (particularSinFicha) mostrarParticular();
        pintarPersonas();
      });
    }
    dni.oninput = function () {
      titular = null;
      particular = null;
      titularMostrado = null;
      particularSinFicha = false;
      familia = [];
      viajeros = [];
      P.vaciar(estadoTit);
      P.vaciar(part);
      pintarPersonas();
    };
    function cuerpo() {
      if (!r.id && !titular) throw Error("Buscá o registrá al titular antes de continuar.");
      if (checkout) {
        var invalida = Array.from(grupoViaje.querySelectorAll('input[type="date"]:not(:disabled)')).find(function (control) { return !control.checkValidity(); });
        if (invalida) { invalida.reportValidity(); throw Error("Revisá la fecha efectiva de salida."); }
      }
      if (checkout && !viajeros.some(function (p) {
        return p.salida && r.personas.some(function (anterior) { return String(anterior.dni) === String(p.dni) && !anterior.salida; });
      })) throw Error("Indicá la fecha efectiva de al menos una salida.");
      var precio = manual.value.trim() ? P.importeDe(manual.value) : null;
      if (precio === null && tipo.value !== "GENERAL" || precio !== null && !Number.isFinite(precio)) {
        manual.focus();
        throw Error("Indicá el precio acordado en pesos, con hasta dos decimales. Para gratuidad ingresá 0.");
      }
      var salidaGrupo = viajeros.length && viajeros.every(function (p) { return p.salida; });
      var seleccion = extras.map(function (a) {
        if (!Number.isInteger(Number(a.cantidad)) || Number(a.cantidad) < 1) throw Error("Indicá cuántas unidades se alquilan de " + a.nombre + ".");
        if (a.porDia || a.fecha_desde || a.fecha_hasta) {
          if (!a.fecha_desde || !a.fecha_hasta || a.fecha_desde > a.fecha_hasta || a.fecha_desde < inicio.value || !salidaGrupo && a.fecha_hasta > fin.value) {
            throw Error("Revisá los días de uso de " + a.nombre + ". Deben estar dentro de la estadía.");
          }
        }
        return { adicional_id: Number(a.adicional_id), cantidad: Number(a.cantidad), fecha_desde: a.fecha_desde || null, fecha_hasta: a.fecha_hasta || null };
      });
      return {
        operacion: opId,
        id: r.id,
        version: versionInicial,
        titular_dni: titular && String(titular.dni),
        particular: particular,
        tipo: tipo.value,
        servicio_id: serv.value,
        recurso_id: rec.value,
        regimen_id: reg.value,
        fecha_inicio: inicio.value,
        fecha_fin: fin.value,
        cantidad: cantidad.value,
        entidad: entidad.value,
        traslado: traslado.value,
        vehiculo: {
          marca: marca.value,
          color: color.value,
          patente: patente.value,
          sector: sector.value
        },
        personas: viajeros.map(function (x) {
          var edadBebe = x.fecha_nacimiento && inicio.value && inicio.value < String(Number(x.fecha_nacimiento.slice(0, 4)) + 2) + x.fecha_nacimiento.slice(4);
          return Object.assign({}, x, {
            tipo_persona_id: edadBebe ? 5 : x.tipo_persona_id || (particular ? 4 : [2, 3, 4].indexOf(Number(x.parentesco_id)) >= 0 ? 2 : 3)
          });
        }),
        adicionales: seleccion,
        manual: precio,
        motivo: motivo.value,
        observaciones: obs.value
      };
    }
    function pintarCotizacion(b, x, enfocar) {
      cotizacion = { cuerpo: b, resultado: x };
      var liquidacion = x.salida ? liquidacionSalida(x.salida, ajustesSalida) : null;
      var confirmar = btn(x.salida ? "Confirmar salida" : r.id ? "Guardar cambios" : "Crear reserva aprobada", function () {
        var nuevo = cuerpo();
        if (JSON.stringify(nuevo) !== JSON.stringify(b)) {
          cotizacion = null;
          P.vaciar(pre);
          throw Error("Cambiaste el formulario. Revisá el importe de nuevo.");
        }
        return P.post("/recepcion/guardar", Object.assign({}, b, {
          cotizacion_esperada: x.cotizacion_esperada, cuenta_esperada: x.cuenta, salida: liquidacion ? liquidacion.datos() : undefined
        })).then(function (res) {
          if (res.encolado) {
            ir();
            return;
          }
          P.aviso(res.mensaje, "ok");
          ir(res.id);
        });
      }, "primario");
      var saldo = x.cuenta || cuenta;
      P.reemplazar(pre, h("div.columna", h("div.rec-cotizacion", h("h3", "Revisión del importe"),
        grid(P.dato("Precio final de la reserva", pesos(x.total)), P.dato("Incluye adicionales", pesos(x.adicionales || 0)),
          r.id ? P.dato(x.diferencia < 0 ? "Disminución del precio" : "Aumento del precio", pesos(Math.abs(x.diferencia))) : null,
          x.fecha_fin && x.fecha_fin !== b.fecha_fin ? P.dato("Nueva fecha de fin de la reserva", fecha(x.fecha_fin)) : null), x.personas.map(function (p) {
        return h("div", p.nombre + " · " + pesos(p.precio));
      })), x.detalle_alquileres && x.detalle_alquileres.length ? tabla(
        ["Artículo", "Unidades", "Primer día", "Último día", "Días cobrados", "Subtotal"], x.detalle_alquileres.map(function (a) {
          return [a.nombre, a.cantidad, fecha(a.fecha_desde), fecha(a.fecha_hasta), a.dias, pesos(a.subtotal)];
        })) : null,
        liquidacion ? liquidacion.vista : saldo ? cobroFinal(Number(saldo.pendiente) + Number(x.diferencia), Number(saldo.neto_consumos)) : null, confirmar));
      if (enfocar) confirmar.focus();
    }
    var guardar = btn("Revisar importe", function () {
      var b = cuerpo();
      return P.post("/recepcion/cotizar", b).then(function (x) {
        ajustesSalida = {};
        pintarCotizacion(b, x, true);
      });
    }, "primario");
    var gExtra = grupo("Alquiler de artículos y adicionales", "Se cobra cada unidad por cada día de uso, incluidos el primero y el último.", cargos);
    var contingente = grid(P.campo("Integrantes totales (incluye responsables)", cantidad), P.campo("Entidad (opcional)", entidad));
    function modalidad(conservarFechas) {
      contingente.hidden = tipo.value !== "CONTINGENTE";
      manual.required = tipo.value !== "GENERAL";
      if (conservarFechas !== true) {
        if (tipo.value === "PASA_EL_DIA") fin.value = inicio.value;
        else if (tipo.value === "GENERAL" && inicio.value && fin.value <= inicio.value) fin.value = P.sumarDias(inicio.value, 1);
      }
      fin.readOnly = tipo.value === "PASA_EL_DIA";
      pintarAdicionales();
    }
    tipo.onchange = modalidad;
    inicio.onchange = modalidad;
    fin.onchange = pintarAdicionales;
    serv.onchange = function () {
      recursos(null);
    };
    rec.onchange = function () {
      pintarAdicionales();
    };
    reg.onchange = pintarAdicionales;
    rec.disabled = serv.disabled = recursosFijos;
    var tituloEdicion = checkout ? "Registrar salida · T-" : editarFechas ? "Modificar días por persona · T-" : accion === "extender" ? "Extender estadía · T-" : "Editar T-";
    c.appendChild(cab(r.id ? tituloEdicion + r.id : "Nueva reserva", checkout ?
      "Elegí quién sale. Al revisar el importe vas a ver el saldo y qué hacer con el vehículo." : editarFechas ?
      "Elegí una fecha de salida para cada persona que tenga días distintos a los de la reserva." :
      r.id ? "Revisá el importe antes de guardar los cambios." : "La reserva queda aprobada al confirmarla.", btn("Volver", function () {
      ir(r.id);
    })));
    if (checkout && vencida(r) && (r.tipo === "PASA_EL_DIA" || r.bloque_fecha_id)) c.appendChild(
      P.mensaje("La salida tardía de esta reserva conserva las fechas y el precio de alojamiento acordados.", "info"));
    c.appendChild(base);
    if (!checkout && !editarFechas) {
      base.appendChild(grupo("Titular", "Puede ser distinto de quienes viajan.", h("div.columna", r.id ? h("span", "DNI " + r.titular_dni) : h("div.fila", P.campo("DNI o legajo", dni), btn("Buscar titular", function () {
        return buscarTitular(dni.value.trim());
      })), estadoTit, part)));
      base.appendChild(grupo("Estadía", "Cada reserva tiene un recurso. Para otro recurso, creá otra reserva y asignale las personas que lo usarán.", h("div.columna", grid(P.campo("Tipo de reserva", tipo), P.campo("Servicio", serv), P.campo("Recurso", rec), P.campo("Régimen", reg)),
        grid(P.campo("Desde", inicio), P.campo("Salida prevista de la reserva", fin), iniciada && !recursosFijos ? P.campo("Fecha efectiva del traslado", traslado) : null), contingente)));
    }
    base.appendChild(grupo(checkout ? "Personas presentes" : "Personas que viajan", checkout || editarFechas ? null :
      "Registrá el ingreso y la salida de cada persona con la fecha real. Si la salida prevista individual queda vacía, se usa la fecha de la reserva.", grupoViaje));
    if (!checkout && !editarFechas) base.appendChild(grupo("Vehículo", "Si llegan sin auto, dejá los cuatro campos vacíos.", grid(P.campo("Marca", marca), P.campo("Color", color), P.campo("Patente", patente), P.campo("Sector de estacionamiento", sector))));
    if (checkout && veh.en_predio) base.appendChild(grupo("Vehículo en el predio", null, h("div.rec-grid", P.dato("Patente", veh.patente), P.dato("Estacionamiento", texto(veh.sector)))));
    if (!editarFechas) base.appendChild(gExtra);
    base.appendChild(grupo("Importe y observaciones", null, h("div.columna", grid(!checkout && !editarFechas ? P.campo("Precio acordado sin alquileres por día ($)", manual, {
      ayuda: "En General, dejalo vacío para usar la tarifa. En las otras modalidades es obligatorio. Cero indica gratuidad del alojamiento."
    }) : null, P.campo("Motivo del cambio o de la salida", motivo), !checkout && !editarFechas ? P.campo("Observaciones de la reserva", obs) : null), guardar, pre)));
    if (previo) {
      Object.keys(campos).forEach(function (clave) { campos[clave].value = previo.campos[clave]; });
      if (titularMostrado) mostrarTitular(titularMostrado);
      else if (particularSinFicha) mostrarParticular();
    }
    recursos(previo ? previo.recurso : r.recurso_id);
    pintarPersonas();
    modalidad(!!previo);
    if (P.esAdmin()) P.continuidad.registrarVentana("recepcion-crear-adicional", abrirAdicional);
    P.continuidad.guardarPantalla(function () {
      var valores = {};
      Object.keys(campos).forEach(function (clave) { valores[clave] = campos[clave].value; });
      return { campos: valores, recurso: rec.value, familiarElegido: selectFamilia.value, adicionalElegido: selectExtra.value,
        familia: familia, titular: titular, particular: particular, titularMostrado: titularMostrado, particularSinFicha: particularSinFicha,
        viajeros: viajeros, extras: extras, cotizacion: cotizacion, ajustesSalida: ajustesSalida, opId: opId, versionInicial: versionInicial };
    });
    if (previo) {
      selectFamilia.value = previo.familiarElegido;
      selectExtra.value = previo.adicionalElegido;
      if (cotizacion && (!checkout || cotizacion.resultado.salida)) pintarCotizacion(cotizacion.cuerpo, cotizacion.resultado, false);
      return;
    }
    if (accion === "extender") fin.focus();
    if (r.id && !checkout && !editarFechas) return buscarTitular(String(r.titular_dni), true);
  }
  P.ruta.registrar(/^\/recepcion\/nueva$/, function (c) {
    return get("opciones").then(function (o) {
      return formulario(c, o);
    });
  }, {
    titulo: "Nueva reserva"
  });
  P.ruta.registrar(/^\/recepcion\/(\d+)\/editar$/, function (c, p) {
    return Promise.all([get("opciones"), get("detalle", {
      id: p[0]
    })]).then(function (v) {
      return formulario(c, v[0], v[1].reserva, v[1].cuenta, P.ruta.query().accion);
    });
  }, {
    titulo: "Editar reserva"
  });
  var ACC = {
    CARGA: "Cargar saldo",
    RETIRO: "Reducir saldo",
    REPARTIR: "Repartir entre integrantes",
    LIQUIDAR: "Saldar consumos y cerrar saldo",
    PAGO_RESERVA: "Saldar diferencia de reserva"
  };
  function accionesCuenta(r, a, cargar) {
    var presentes = a.personas.filter(function (p) { return p.entrada && !p.salida; });
    var conSaldo = a.personas.filter(function (p) { return Number(p.saldo) > 0; });
    var puedeRepartir = conSaldo.some(function (p) { return presentes.some(function (otro) { return otro.id !== p.id; }); });
    var inactivo = {
      CARGA: !presentes.length && "Registrá el ingreso de un huésped para cargarle saldo.",
      RETIRO: !conSaldo.length && "No hay saldo disponible para reducir.",
      REPARTIR: !puedeRepartir && "Necesitás una persona con saldo y otro integrante presente que lo reciba.",
      LIQUIDAR: a.cierre_pendiente === false && "La cuenta está al día.",
      PAGO_RESERVA: !Number(a.pendiente) && "La reserva no tiene diferencias pendientes."
    };
    P.continuidad.registrarVentana("recepcion-operar-cuenta", function (datos) {
      if (!Object.prototype.hasOwnProperty.call(ACC, datos.accion) || inactivo[datos.accion]) return null;
      return operarCuenta(r, a, datos.accion, cargar, datos.operacion);
    });
    return h("div", !presentes.length && !a.movimientos.length ? h("p.texto-2", inactivo.CARGA) : null,
      a.cierre_pendiente === false && a.movimientos.some(function (m) { return m.concepto === "SALDAR_CONSUMOS"; }) ? h("p.fuerte", "Cuenta de consumos saldada") : null,
      h("div.fila", Object.keys(ACC).map(function (k) {
        var boton = btn(ACC[k], function () { return operarCuenta(r, a, k, cargar); });
        if (inactivo[k]) { boton.disabled = true; boton.title = inactivo[k]; }
        return boton;
      })));
  }
  function operarCuenta(r, a, accion, refrescar, operacion) {
    var presentes = a.personas.filter(function (p) {
      return p.entrada && !p.salida;
    });
    var repartir = accion === "REPARTIR";
    var posibles = accion === "CARGA" ? presentes : a.personas.filter(function (p) {
      return Number(p.saldo) > 0 && (!repartir || presentes.some(function (d) { return d.id !== p.id; }));
    });
    var origen = sel(lista(posibles.map(function (p) {
      return {
        id: p.id,
        nombre: p.nombre + " · " + pesos(p.saldo)
      };
    })), null, "Elegí una persona");
    if (posibles.length === 1) origen.value = posibles[0].id;
    var dest = sel([], null, "Elegí quién lo recibe"),
      imp = P.dinero({}),
      nota = input(""),
      vistaReparto = h("p.texto-2", { "aria-live": "polite", hidden: true });
    function persona(control) {
      return a.personas.find(function (p) { return String(p.id) === control.value; });
    }
    function mostrarReparto() {
      var de = persona(origen), hacia = persona(dest), importe = P.importeDe(imp.value);
      vistaReparto.hidden = !de || !hacia || !(importe > 0);
      if (!vistaReparto.hidden) vistaReparto.textContent = importe > Number(de.saldo) ?
        "El importe supera el saldo disponible." :
        "Después del reparto: " + de.nombre + ", " + pesos(Number(de.saldo) - importe) + " · " + hacia.nombre + ", " + pesos(Number(hacia.saldo) + importe) + ".";
    }
    function destinos() {
      var opciones = presentes.filter(function (p) { return String(p.id) !== origen.value; });
      P.vaciar(dest);
      dest.appendChild(h("option", { value: "" }, "Elegí quién lo recibe"));
      opciones.forEach(function (p) { dest.appendChild(h("option", { value: p.id }, p.nombre + " · " + pesos(p.saldo))); });
      if (opciones.length === 1) dest.value = opciones[0].id;
      mostrarReparto();
    }
    if (repartir) {
      origen.onchange = destinos;
      dest.onchange = imp.oninput = mostrarReparto;
      destinos();
    }
    var met = {
        EFECTIVO: MEDIOS.EFECTIVO,
        TRANSFERENCIA: MEDIOS.TRANSFERENCIA
      },
      liquidar = accion === "LIQUIDAR" || accion === "PAGO_RESERVA",
      n = accion === "LIQUIDAR" ? a.neto_consumos : a.pendiente;
    if (Number(r.afiliado)) {
      if (liquidar && n > 0) met.HABERES = MEDIOS.HABERES;else if (!liquidar) met.AL_SALIR = MEDIOS.AL_SALIR;
    }
    var medio = sel(opciones(met), accion === "LIQUIDAR" && met.HABERES ? "HABERES" : null),
      caja = sel([], null, "Elegí una caja"),
      campoCaja = P.campo("Caja de efectivo", caja);
    var cargarCajas = !repartir && (!liquidar || n) ? P.opciones("cajas").then(function (xs) {
      var asignada = P.puesto() && P.puesto().caja_id;
      if (!P.esAdmin()) xs = xs.filter(function (x) { return asignada && String(x.valor) === String(asignada); });
      xs.forEach(function (x) {
        caja.appendChild(h("option", {
          value: x.valor
        }, x.texto));
      });
      if (asignada && xs.some(function (x) { return String(x.valor) === String(asignada); })) caja.value = asignada;
      else if (xs.length === 1) caja.value = xs[0].valor;
    }).catch(P.error) : Promise.resolve();
    function actualizar() {
      campoCaja.hidden = medio.value !== "EFECTIVO" || accion === "REPARTIR" || liquidar && Number(n) === 0;
    }
    medio.onchange = actualizar;
    actualizar();
    var key = operacion || nuevaClave();
    var m = P.modal({
      reanudar: { id: "recepcion-operar-cuenta", datos: { accion: accion, operacion: key } },
      titulo: ACC[accion],
      contenido: h("div.columna", liquidar ? h("div.rec-resumen", n < 0 ? "A devolver" : n > 0 ? "A cobrar" : "Sin diferencia de dinero", h("strong", pesos(Math.abs(n)))) : grid(P.campo(repartir ? "Desde" : "Persona", origen), repartir ? P.campo("Hacia", dest) : null, P.campo("Importe ($)", imp)), repartir ? vistaReparto : liquidar && !n ? null : P.campo("Medio", medio), campoCaja, P.campo("Observación", nota), accion === "LIQUIDAR" ? P.mensaje("Se cancelarán los saldos disponibles de todos los integrantes. Solo se liquida lo consumido, descontando los anticipos.", "info") : null),
      acciones: [btn("Volver", function () {
        m.cerrar();
      }), btn("Confirmar", function () {
        var importe = P.importeDe(imp.value);
        if (!liquidar) {
          if (!persona(origen)) { origen.focus(); throw Error("Elegí la persona."); }
          if (repartir && !persona(dest)) { dest.focus(); throw Error("Elegí quién recibe el saldo."); }
          if (!(importe > 0)) { imp.focus(); throw Error("Ingresá un importe mayor que cero, con hasta dos decimales."); }
          if (accion !== "CARGA" && importe > Number(persona(origen).saldo)) { imp.focus(); throw Error("El saldo disponible no alcanza."); }
        }
        if (!campoCaja.hidden && !caja.value) { caja.focus(); throw Error(P.esAdmin() ? "Elegí la caja donde se registra el efectivo." : "Ingresá a tu caja para registrar el efectivo de recepción."); }
        return P.post("/recepcion/" + r.id + "/cuenta", {
          operacion: key,
          accion: accion,
          medio: medio.value,
          caja_id: caja.value,
          huesped_id: origen.value,
          destino_id: dest.value,
          importe: liquidar ? null : importe,
          esperado: n,
          detalle: nota.value
        }).then(function (x) {
          m.cerrar();
          if (!x.encolado) {
            P.aviso(x.mensaje + (x.liquidacion_id ? " · Planilla N° " + x.liquidacion_id : ""), "ok");
            return refrescar();
          }
        });
      }, "primario")]
    });
    return cargarCajas.then(function () { return m; });
  }
  P.ruta.registrar(/^\/recepcion\/(\d+)$/, function (c, param) {
    var id = param[0];
    function cargar() {
      return get("detalle", {
        id: id
      }).then(function (d) {
        if (!c.isConnected) return;
        var r = d.reserva,
          a = d.cuenta;
        var pasajeros = r.personas.map(function (p) {
          var s = a.personas.find(function (x) {
            return String(x.dni) === String(p.dni);
          });
          return [p.apellido + ", " + p.nombre, String(p.dni), p.entrada ? fecha(p.entrada) : "Sin ingreso",
            fecha(p.salida_prevista || r.fecha_fin), p.salida ? fecha(p.salida) : p.entrada ? "En el predio" : "—",
            pesos(p.precio), pesos(s ? s.saldo : 0)];
        });
        var vh = r.vehiculo || {},
          timeline = d.historial.map(function (e) {
            return h("details.rec-evento", h("summary", P.f.fechaHora(e.fecha) + " · " + e.actor), e.motivo ? h("p", e.motivo) : null, tabla(["Campo", "Antes", "Después"], e.cambios.map(function (f) {
              return f.map(texto);
            })));
          });
        var presentes = r.personas.some(function (p) { return p.entrada && !p.salida; });
        var acciones = [btn("Todas las reservas", function () { ir(); }),
          btn("Editar reserva e ingresos", function () { ir(id + "/editar"); }, presentes ? "secundario" : "primario"),
          r.tipo !== "PASA_EL_DIA" && r.personas.some(function (p) { return !p.salida; }) ?
            btn("Modificar días por persona", function () { ir(id + "/editar?accion=fechas"); }) : null,
          presentes ? btn("Registrar salida", function () { ir(id + "/editar?accion=salida"); }, "primario") : null];
        P.reemplazar(c, cab("Reserva T-" + r.id, r.titular_nombre + " · DNI " + r.titular_dni, acciones),
          vencida(r) ? P.mensaje("Quedan huéspedes con su fecha prevista vencida y sin salida registrada.", "aviso") : null,
          grupo("Datos de la estadía", null, h("div.columna",
            grid(P.dato("Servicio", r.servicio), P.dato("Recursos", texto(nombresRecursos(r)) + (r.numero_parcela ? " · Parcela " + r.numero_parcela : "")),
              P.dato("Estadía", fecha(r.fecha_inicio) + " – " + fecha(r.fecha_fin)), P.dato("Estado", r.estado), P.dato("Tipo", TIPOS[r.tipo]),
              P.dato("Total de personas", r.cantidad), r.entidad ? P.dato("Entidad", r.entidad) : null, P.dato("Precio final", pesos(r.precio_total))),
            r.observaciones ? h("p", r.observaciones) : null)),
          vh.patente ? grupo("Vehículo", null, h("div.columna",
            grid(P.dato("Patente", vh.patente), P.dato("Marca y color", texto([vh.marca, vh.color].filter(Boolean).join(" · "))),
              P.dato("Estacionamiento", texto(vh.sector)), P.dato("Estado", vh.salida ? "Salió el " + fecha(vh.salida) : vh.en_predio ? "En el predio" : "Sin ingreso")),
            !vh.salida ? h("div.fila", P.btn("Imprimir etiqueta QR", { icono: "imprimir", onclick: function (e) {
              P.ejecutar(e.currentTarget, function () { return P.imprimirQRVehiculo(r); }).catch(function () {});
            } })) : null)) : null,
          grupo("Pasajeros", null, tabla(["Nombre", "DNI", "Ingreso", "Salida prevista", "Salida efectiva", "Estadía", "Saldo"], pasajeros)),
          r.adicionales.length ? grupo("Alquileres y adicionales", null, tabla(["Artículo", "Unidades", "Período de uso", "Días", "Subtotal"], r.adicionales.map(function (x) {
            return [x.nombre, x.cantidad, x.fecha_desde && x.fecha_hasta ? fecha(x.fecha_desde) + " – " + fecha(x.fecha_hasta) : "Toda la estadía",
              x.dias == null ? "—" : x.dias, pesos(x.subtotal)];
          }))) : null,
          grupo("Cuenta de la estadía", null, h("div.columna", cobroFinal(a.pendiente, a.neto_consumos),
            grid(P.dato("Saldo para compras", pesos(a.saldo)), P.dato("Consumos", pesos(a.consumos))),
            accionesCuenta(r, a, cargar), a.movimientos.length ? tabla(["Fecha", "Movimiento", "Medio", "Importe", "Empleado / detalle"], a.movimientos.map(function (m) {
          var quien = a.personas.find(function (p) { return Number(p.id) === Number(m.huesped_id); });
          return [P.f.fechaHora(m.fecha), ACC[m.concepto] || CONCEPTO_CUENTA[m.concepto] || m.concepto,
            MEDIOS[m.medio] || m.medio || "—", pesos(m.importe), h("div", P.textoTabla([m.usuario_nombre, quien && quien.nombre, m.detalle].filter(Boolean).join(" · ")), m.liquidacion_id ? btn("Imprimir planilla", function () {
            return P.get("/recepcion/" + id + "/planilla/" + m.liquidacion_id).then(P.imprimirLiquidacion);
          }, "texto") : null)];
        })) : null)), grupo("Historial de recepción", "Cada operación conserva el empleado, la fecha y los valores anteriores y nuevos.", timeline.length ? h("div.columna", timeline) : espacio("Todavía no hay modificaciones desde el predio.")));
      });
    }
    return cargar();
  }, {
    titulo: "Detalle de estadía"
  });
})();
