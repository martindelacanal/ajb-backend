/* Recepción: movimientos de reservas y estadías (Turismo, recepción y cuenta). */
(function () {
  "use strict";

  if (window.__SIN_SOPORTE) return;
  var P = window.P, h = P.h, R = P.recepcion, pesos = P.f.pesos, fecha = P.f.fecha;
  var MEDIOS = R.MEDIOS, CONCEPTOS = R.CONCEPTOS, MODALIDAD = R.MODALIDAD, opciones = R.opciones, lista = R.lista, sel = R.sel, input = R.input,
    texto = R.texto, btn = R.btn, grid = R.grid, tabla = R.tabla, get = R.get, cabecera = R.cabecera, nuevaClave = R.nuevaClave, opSelect = R.opSelect,
    detalleArticulo = R.detalleArticulo, periodo = R.periodo;
  function espacio(v) { return h("span", v); }

  var ORIGEN_MOV = { RECEPCION: "Recepción", TURISMO: "Turismo", CUENTA: "Cuenta de estadía" };
  var CONCEPTO_CUENTA = {
    CARGA: "Carga de saldo", RETIRO: "Retiro de saldo", REPARTO: "Reparto de saldo",
    COMPRA: "Compra", ANULACION: "Anulación de compra", SALDAR_CONSUMOS: "Liquidación de consumos",
    PAGO_RESERVA: "Pago de diferencia", DIFERENCIAL: "Diferencia de precio",
    CIERRE_SALIDA: "Cierre de cuenta por salida", PAGO_SALIDA_CONSUMOS: "Consumos liquidados al salir",
    TRASPASO_ALOJAMIENTO: "Traslado de deuda de alojamiento", TRASPASO_CONSUMOS: "Traslado de deuda de consumos"
  };
  function conceptoMovimiento(f) {
    return f.origen === "CUENTA" ? CONCEPTO_CUENTA[f.concepto] || CONCEPTOS[f.concepto] || f.concepto : f.concepto;
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
    c.appendChild(cabecera("Movimientos de reservas y estadías", {
      volver: ["Reservas y estadías", "/recepcion"],
      subtitulo: "Historial de Turismo, operaciones de recepción y movimientos de cuenta."
    }));
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
})();
