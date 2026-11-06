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
    HABERES: "Planilla de descuento de haberes"
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
      return h("tr", row.map(function (v) {
        return h("td", v);
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
  P.ruta.registrar(/^\/recepcion$/, function (c) {
    var q = input(""),
      desde = input(P.hoy(), "date"),
      hasta = input("", "date"),
      tipo = sel(opciones(TIPOS), "", "Todos"),
      serv = sel([], "", "Todos"),
      presencia = sel(opciones({
        PRESENTE: "Con huéspedes presentes",
        SALIDA: "Con salidas registradas"
      }), "", "Cualquier situación"),
      at = P.check("Solo operaciones atípicas", false);
    var out = h("div.columna", {
        "aria-live": "polite"
      }),
      pag = 1;
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
          }, "T-" + x.id + " · " + x.titular)), fecha(x.fecha_inicio) + " – " + fecha(x.fecha_fin), [x.servicio, x.recurso].filter(Boolean).join(" · "), TIPOS[x.tipo || "GENERAL"], x.estado, pesos(x.precio_total)];
        })) : P.mensaje("No hay reservas con esos filtros. Podés cambiar las fechas o crear una reserva.", "info"), h("div.fila", ant, espacio("Página " + pag), sig));
      });
    }
    var seq = 0;
    function filtrar() {
      pag = 1;
      return cargar();
    }
    c.appendChild(cab("Reservas y estadías", "Recepción del predio", btn("Crear reserva", function () {
      ir("nueva");
    }, "primario")));
    var form = h("form.hoja.rec-seccion", {
      onsubmit: function (e) {
        e.preventDefault();
        filtrar().catch(P.error);
      }
    }, grid(P.campo("Titular, DNI o reserva", q), P.campo("Desde", desde), P.campo("Hasta", hasta), P.campo("Servicio", serv), P.campo("Tipo", tipo), P.campo("Ocupación", presencia)), h("div.fila", at, h("button.btn.btn-secundario", {
      type: "submit"
    }, "Aplicar filtros")));
    c.appendChild(form);
    c.appendChild(out);
    return get("opciones").then(function (o) {
      o.servicios.forEach(function (s) {
        serv.appendChild(h("option", {
          value: s.id
        }, s.nombre));
      });
      return cargar();
    });
  }, {
    titulo: "Reservas y estadías"
  });
  function formulario(c, o, r) {
    r = r || {};
    var hoy = P.hoy(),
      viajeros = (r.personas || []).map(function (p) {
        return Object.assign({}, p);
      }),
      extras = (r.adicionales || []).map(function (a) {
        return Object.assign({}, a);
      });
    var familia = [],
      titular = r.id ? {
        dni: r.titular_dni
      } : null,
      particular = null,
      opId = nuevaClave();
    var tipo = sel(opciones(TIPOS), r.tipo || "GENERAL"),
      serv = sel(lista(o.servicios), r.servicio_id, "Elegí un servicio"),
      rec = sel([], null),
      reg = sel(lista(o.regimenes), r.regimen_id || 3, "Sin régimen");
    var inicio = input(r.fecha_inicio || hoy, "date"),
      fin = input(r.fecha_fin || hoy, "date"),
      entidad = input(r.entidad),
      cantidad = input(r.cantidad || 1, "number"),
      traslado = input(hoy, "date");
    var dni = input(r.titular_dni),
      nom = input(""),
      ape = input(""),
      nac = input("", "date"),
      veh = r.vehiculo || {},
      marca = input(veh.marca),
      color = input(veh.color),
      patente = input(veh.patente),
      sector = input(veh.sector);
    var manual = input(r.manual == null ? "" : r.manual, "number");
    manual.min = "0";
    manual.step = "0.01";
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
    function opSelect(el, items, value, vacio) {
      P.vaciar(el);
      el.appendChild(h("option", {
        value: ""
      }, vacio));
      items.forEach(function (x) {
        el.appendChild(h("option", {
          value: x.valor
        }, x.texto));
      });
      el.value = value == null ? "" : String(value);
    }
    function pintarAdicionales() {
      opSelect(selectExtra, lista(o.adicionales.filter(function (x) {
        return String(x.recurso_id) === rec.value && String(x.regimen_id) === reg.value;
      })), null, "Elegí un adicional");
      P.reemplazar(cargos, extras.map(function (a, i) {
        var n = input(a.cantidad || 1, "number");
        n.min = "1";
        n.oninput = function () {
          a.cantidad = n.value;
        };
        return h("div.fila", P.campo(a.nombre, n), btn("Quitar " + a.nombre, function () {
          extras.splice(i, 1);
          pintarAdicionales();
        }, "texto"));
      }), h("div.fila", P.campo("Adicional disponible", selectExtra), btn("Agregar adicional", function () {
        var x = o.adicionales.find(function (a) {
          return a.id === Number(selectExtra.value);
        });
        if (x && !extras.some(function (a) {
          return a.adicional_id === x.id;
        })) extras.push({
          adicional_id: x.id,
          nombre: x.nombre,
          cantidad: 1
        });
        pintarAdicionales();
      })));
    }
    function recursos(v) {
      opSelect(rec, lista(o.recursos.filter(function (x) {
        return String(x.servicio_id) === serv.value;
      })), v, "Sin recurso");
      pintarAdicionales();
    }
    function pintarPersonas() {
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
        return h("fieldset.rec-viajero", h("legend", "Pasajero " + (i + 1) + (p.apellido ? " · " + p.apellido : "")), grid(campo("dni", "text", "DNI"), campo("nombre", "text", "Nombre"), campo("apellido", "text", "Apellido"), campo("fecha_nacimiento", "date", "Nacimiento"), P.campo("Vínculo", parentesco)), grid(campo("entrada", "date", "Ingreso efectivo"), campo("salida", "date", "Salida efectiva")), h("div.fila", btn("Ingresó hoy", function () {
          p.entrada = hoy;
          pintarPersonas();
        }, "texto"), btn("Salió hoy", function () {
          p.salida = hoy;
          pintarPersonas();
        }, "texto"), btn("Quitar pasajero", function () {
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
      })));
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
        P.vaciar(part);
        if (f.titular) {
          P.reemplazar(estadoTit, h("strong", f.titular.apellido + ", " + f.titular.nombre + " · " + (Number(f.titular.afiliado) ? "Afiliado" : "Particular")));
          if (!editar) {
            dni.value = f.titular.dni;
            viajeros = [Object.assign({}, f.titular)];
          }
        } else if (!editar) {
          P.reemplazar(estadoTit, P.mensaje("No encontramos una ficha. Podés registrar un particular sin acceso a Mi AJB.", "info"));
          P.reemplazar(part, grid(P.campo("Nombre", nom), P.campo("Apellido", ape), P.campo("Nacimiento", nac)), btn("Usar este particular", function () {
            if (!nom.value || !ape.value || !nac.value || !/^\d{6,10}$/.test(dni.value)) throw Error("Completá DNI, nombre, apellido y nacimiento.");
            particular = {
              nombre: nom.value,
              apellido: ape.value,
              fecha_nacimiento: nac.value,
              dni: dni.value,
              parentesco_id: 1,
              tipo_persona_id: 4
            };
            titular = particular;
            familia = [particular];
            viajeros = [Object.assign({}, particular)];
            P.reemplazar(estadoTit, h("strong", ape.value + ", " + nom.value + " · Particular"));
            P.vaciar(part);
            pintarPersonas();
          }));
        }
        pintarPersonas();
      });
    }
    dni.oninput = function () {
      titular = null;
      particular = null;
      familia = [];
      viajeros = [];
      P.vaciar(estadoTit);
      P.vaciar(part);
      pintarPersonas();
    };
    function cuerpo() {
      if (!r.id && !titular) throw Error("Buscá o registrá al titular antes de continuar.");
      return {
        operacion: opId,
        id: r.id,
        version: r.version,
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
        adicionales: tipo.value === "GENERAL" ? extras : [],
        manual: manual.value,
        motivo: motivo.value,
        observaciones: obs.value
      };
    }
    var guardar = btn("Revisar importe", function () {
      var b = cuerpo();
      return P.post("/recepcion/cotizar", b).then(function (x) {
        var confirmar = btn(r.id ? "Guardar cambios" : "Crear reserva aprobada", function () {
          var nuevo = cuerpo();
          if (JSON.stringify(nuevo) !== JSON.stringify(b)) {
            P.vaciar(pre);
            throw Error("Cambiaste el formulario. Revisá el importe de nuevo.");
          }
          return P.post("/recepcion/guardar", b).then(function (res) {
            if (res.encolado) {
              ir();
              return;
            }
            P.aviso(res.mensaje, "ok");
            ir(res.id);
          });
        }, "primario");
        P.reemplazar(pre, h("div.rec-cotizacion", h("h3", "Revisión del importe"), h("div.datos", P.dato("Tarifa calculada", pesos(x.automatico)), P.dato("Precio final", pesos(x.total)), P.dato(x.diferencia < 0 ? "A devolver" : "A cobrar", pesos(Math.abs(x.diferencia)))), x.personas.map(function (p) {
          return h("div", p.nombre + " · " + pesos(p.precio));
        }), x.adicionales ? h("div", "Adicionales: " + pesos(x.adicionales)) : null, confirmar));
        confirmar.focus();
      });
    }, "primario");
    var gExtra = grupo("Adicionales", "Elegí el recurso y el régimen para ver los disponibles.", cargos);
    var contingente = grid(P.campo("Integrantes totales (incluye responsables)", cantidad), P.campo("Entidad (opcional)", entidad));
    function modalidad() {
      contingente.hidden = tipo.value !== "CONTINGENTE";
      gExtra.hidden = tipo.value !== "GENERAL";
      manual.required = tipo.value !== "GENERAL";
    }
    tipo.onchange = modalidad;
    serv.onchange = function () {
      extras = [];
      recursos(null);
    };
    rec.onchange = reg.onchange = function () {
      extras = [];
      pintarAdicionales();
    };
    c.appendChild(cab(r.id ? "Editar T-" + r.id : "Nueva reserva", r.id ? "Modificá los datos y revisá el diferencial antes de guardar." : "La reserva queda aprobada al confirmarla.", btn("Volver", function () {
      ir(r.id);
    })));
    c.appendChild(base);
    base.appendChild(grupo("Titular", "Puede ser distinto de quienes viajan.", h("div.columna", r.id ? h("span", "DNI " + r.titular_dni) : h("div.fila", P.campo("DNI o legajo", dni), btn("Buscar titular", function () {
      return buscarTitular(dni.value.trim());
    })), estadoTit, part)));
    base.appendChild(grupo("Estadía", null, h("div.columna", grid(P.campo("Tipo de reserva", tipo), P.campo("Servicio", serv), P.campo("Recurso", rec), P.campo("Régimen", reg)), grid(P.campo("Desde", inicio), P.campo("Hasta", fin), r.id ? P.campo("Fecha efectiva del traslado", traslado) : null), contingente)));
    base.appendChild(grupo("Personas que viajan", "Registrá el ingreso y la salida de cada persona con la fecha real. Dejá la salida vacía mientras esté en el predio.", grupoViaje));
    base.appendChild(grupo("Vehículo", "Si llegan sin auto, dejá los cuatro campos vacíos.", grid(P.campo("Marca", marca), P.campo("Color", color), P.campo("Patente", patente), P.campo("Sector de estacionamiento", sector))));
    base.appendChild(gExtra);
    base.appendChild(grupo("Importe y observaciones", null, h("div.columna", grid(P.campo("Precio acordado ($)", manual, {
      ayuda: "En una reserva general, dejalo vacío para usar la tarifa. Cero indica gratuidad."
    }), P.campo("Motivo del cambio o de la salida", motivo), P.campo("Observaciones de la reserva", obs)), guardar, pre)));
    recursos(r.recurso_id);
    pintarPersonas();
    modalidad();
    if (r.id) return buscarTitular(String(r.titular_dni), true);
  }
  P.ruta.registrar(/^\/recepcion\/nueva$/, function (c) {
    return get("opciones").then(function (o) {
      formulario(c, o);
    });
  }, {
    titulo: "Nueva reserva"
  });
  P.ruta.registrar(/^\/recepcion\/(\d+)\/editar$/, function (c, p) {
    return Promise.all([get("opciones"), get("detalle", {
      id: p[0]
    })]).then(function (v) {
      return formulario(c, v[0], v[1].reserva);
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
  function operarCuenta(r, a, accion, refrescar) {
    var presentes = a.personas.filter(function (p) {
      return p.entrada && !p.salida;
    });
    var origen = sel(lista((accion === "CARGA" ? presentes : a.personas).map(function (p) {
      return {
        id: p.id,
        nombre: p.nombre + " · " + pesos(p.saldo)
      };
    })), null, "Elegí una persona");
    var dest = sel(lista(presentes), null, "Elegí quién lo recibe"),
      imp = P.dinero({}),
      nota = input("");
    var met = {
        EFECTIVO: MEDIOS.EFECTIVO,
        TRANSFERENCIA: MEDIOS.TRANSFERENCIA
      },
      liquidar = accion === "LIQUIDAR" || accion === "PAGO_RESERVA",
      n = accion === "LIQUIDAR" ? a.neto_consumos : a.pendiente;
    if (Number(r.afiliado)) {
      if (liquidar && n > 0) met.HABERES = MEDIOS.HABERES;else if (!liquidar) met.AL_SALIR = MEDIOS.AL_SALIR;
    }
    var medio = sel(opciones(met)),
      caja = sel([], null, "Elegí una caja"),
      campoCaja = P.campo("Caja de efectivo", caja);
    P.opciones("cajas").then(function (xs) {
      xs.forEach(function (x) {
        caja.appendChild(h("option", {
          value: x.valor
        }, x.texto));
      });
      if (P.puesto() && P.puesto().caja_id) caja.value = P.puesto().caja_id;
    }).catch(P.error);
    function actualizar() {
      campoCaja.hidden = medio.value !== "EFECTIVO" || accion === "REPARTIR" || liquidar && Number(n) === 0;
    }
    medio.onchange = actualizar;
    actualizar();
    var key = nuevaClave();
    var m = P.modal({
      titulo: ACC[accion],
      contenido: h("div.columna", liquidar ? h("div.rec-resumen", n < 0 ? "A devolver" : n > 0 ? "A cobrar" : "Sin diferencia de dinero", h("strong", pesos(Math.abs(n)))) : grid(P.campo(accion === "REPARTIR" ? "Desde" : "Persona", origen), P.campo("Importe ($)", imp)), accion === "REPARTIR" ? P.campo("Hacia", dest) : P.campo("Medio", medio), campoCaja, P.campo("Observación", nota), accion === "LIQUIDAR" ? P.mensaje("Se cancelarán los saldos disponibles de todos los integrantes. Solo se liquida lo consumido, descontando los anticipos.", "info") : null),
      acciones: [btn("Volver", function () {
        m.cerrar();
      }), btn("Confirmar", function () {
        return P.post("/recepcion/" + r.id + "/cuenta", {
          operacion: key,
          accion: accion,
          medio: medio.value,
          caja_id: caja.value,
          huesped_id: origen.value,
          destino_id: dest.value,
          importe: imp.value ? P.numeroDe(imp.value) : null,
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
  }
  P.ruta.registrar(/^\/recepcion\/(\d+)$/, function (c, param) {
    var id = param[0];
    function cargar() {
      return get("detalle", {
        id: id
      }).then(function (d) {
        var r = d.reserva,
          a = d.cuenta;
        var pasajeros = r.personas.map(function (p) {
          var s = a.personas.find(function (x) {
            return String(x.dni) === String(p.dni);
          });
          return [p.apellido + ", " + p.nombre, String(p.dni), p.entrada ? fecha(p.entrada) : "Sin ingreso", p.salida ? fecha(p.salida) : p.entrada ? "En el predio" : "—", pesos(p.precio), pesos(s ? s.saldo : 0)];
        });
        var vh = r.vehiculo || {},
          timeline = d.historial.map(function (e) {
            return h("details.rec-evento", h("summary", P.f.fechaHora(e.fecha) + " · " + e.actor), e.motivo ? h("p", e.motivo) : null, tabla(["Campo", "Antes", "Después"], e.cambios.map(function (f) {
              return f.map(texto);
            })));
          });
        P.reemplazar(c, cab("Reserva T-" + r.id, r.titular_nombre + " · DNI " + r.titular_dni, h("div.fila", btn("Todas las reservas", function () {
          ir();
        }), btn("Editar / registrar ingreso o salida", function () {
          ir(id + "/editar");
        }, "primario"))), grupo("Datos de la estadía", null, h("div.columna", grid(P.dato("Servicio", r.servicio), P.dato("Recurso", texto(r.recurso) + (r.numero_parcela ? " · Parcela " + r.numero_parcela : "")), P.dato("Estadía", fecha(r.fecha_inicio) + " – " + fecha(r.fecha_fin)), P.dato("Estado", r.estado), P.dato("Tipo", TIPOS[r.tipo]), P.dato("Total de personas", r.cantidad), r.entidad ? P.dato("Entidad", r.entidad) : null, P.dato("Precio final", pesos(r.precio_total))), vh.patente ? espacio([vh.marca, vh.color, vh.patente, "Sector " + vh.sector].join(" · ")) : null, r.observaciones ? h("p", r.observaciones) : null)), grupo("Pasajeros", null, tabla(["Nombre", "DNI", "Ingreso", "Salida", "Estadía", "Saldo"], pasajeros)), r.adicionales.length ? grupo("Adicionales", null, tabla(["Concepto", "Cantidad", "Subtotal"], r.adicionales.map(function (x) {
          return [x.nombre, x.cantidad, pesos(x.subtotal)];
        }))) : null, grupo("Cuenta de la estadía", "El saldo disponible se utiliza en caja con el DNI o legajo de cada huésped presente.", h("div.columna", grid(P.dato("Saldo para compras", pesos(a.saldo)), P.dato("Consumos", pesos(a.consumos)), P.dato(a.neto_consumos < 0 ? "Anticipo sin consumir" : "Consumos por saldar", pesos(Math.abs(a.neto_consumos))), P.dato(a.pendiente < 0 ? "Reserva: a devolver" : "Reserva: a cobrar", pesos(Math.abs(a.pendiente)))), h("div.fila", Object.keys(ACC).map(function (k) {
          return btn(ACC[k], function () {
            operarCuenta(r, a, k, cargar);
          });
        })), a.movimientos.length ? tabla(["Fecha", "Movimiento", "Medio", "Importe", "Empleado / detalle"], a.movimientos.map(function (m) {
          return [P.f.fechaHora(m.fecha), ACC[m.concepto] || {
            SALDAR_CONSUMOS: "Liquidación de consumos",
            REPARTO: "Reparto",
            DIFERENCIAL: "Diferencia de precio",
            COMPRA: "Compra",
            ANULACION: "Anulación"
          }[m.concepto] || m.concepto, MEDIOS[m.medio] || m.medio || "—", pesos(m.importe), h("div", m.usuario_nombre + (m.detalle ? " · " + m.detalle : ""), m.liquidacion_id ? btn("Imprimir planilla", function () {
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
