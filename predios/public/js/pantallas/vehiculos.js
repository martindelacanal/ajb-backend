/* Control de estacionamiento, QR de la reserva y ficha para Seguridad.
   El QR identifica la reserva: al escanearlo, Seguridad ve sus vehículos, sus personas y su deuda. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P, h = P.h;
  var RUTA = "/recepcion/vehiculos";
  var PREFIJO = "AJB-PREDIO:";
  var SVG = "http://www.w3.org/2000/svg";
  var scripts = {};
  var comparador = new Intl.Collator("es-AR", { numeric: true, sensitivity: "base" });
  var CONCEPTOS = {
    DIFERENCIAL: "Diferencia de alojamiento",
    PAGO_RESERVA: "Saldo de la reserva",
    CONSUMOS: "Consumos",
    TRASLADO: "Deuda trasladada"
  };

  function cargarScript(nombre, variable) {
    if (!scripts[nombre]) scripts[nombre] = new Promise(function (resolver, rechazar) {
      var script = h("script", { src: "js/vendor/" + nombre + "?v=" + encodeURIComponent(document.documentElement.dataset.version || "") });
      function fallar() {
        script.remove();
        delete scripts[nombre];
        rechazar(Error("No se pudo cargar la herramienta de códigos QR. Volvé a intentar."));
      }
      script.onload = function () { if (typeof window[variable] === "function") resolver(window[variable]); else fallar(); };
      script.onerror = fallar;
      document.head.appendChild(script);
    });
    return scripts[nombre];
  }
  // Acepta el texto de la etiqueta («AJB-PREDIO:…»), el código solo o un enlace que lo contenga.
  function tokenDe(texto, etiqueta) {
    var codigo = String(texto || "").trim();
    if (codigo.indexOf(PREFIJO) === 0) codigo = codigo.slice(PREFIJO.length);
    else {
      var enlace = /\/qr\/([A-Za-z0-9_-]{32})(?:[/?#]|$)/.exec(codigo);
      if (enlace) codigo = enlace[1];
      else if (etiqueta) return null;
    }
    return /^[A-Za-z0-9_-]{32}$/.test(codigo) ? codigo : null;
  }
  function dibujoQR(generar, token) {
    var qr = generar(0, "M");
    qr.addData(PREFIJO + token);
    qr.make();
    var lado = qr.getModuleCount();
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 " + (lado + 8) + " " + (lado + 8));
    svg.setAttribute("aria-label", "Código QR de la reserva");
    svg.setAttribute("role", "img");
    svg.setAttribute("shape-rendering", "crispEdges");
    var fondo = document.createElementNS(SVG, "rect");
    fondo.setAttribute("width", String(lado + 8));
    fondo.setAttribute("height", String(lado + 8));
    fondo.setAttribute("fill", "#fff");
    svg.appendChild(fondo);
    var modulos = [];
    for (var fila = 0; fila < lado; fila++) {
      for (var col = 0; col < lado; col++) {
        if (qr.isDark(fila, col)) modulos.push("M" + (col + 4) + " " + (fila + 4) + "h1v1h-1z");
      }
    }
    var forma = document.createElementNS(SVG, "path");
    forma.setAttribute("d", modulos.join(""));
    forma.setAttribute("fill", "#000");
    svg.appendChild(forma);
    return svg;
  }
  function lugar(r) {
    return [r.numero_parcela ? "Parcela " + r.numero_parcela : null, r.ubicacion].filter(Boolean).join(" · ");
  }
  function recursoYParcela(nombre, numero) { return P.recepcion.recursoYParcela(nombre, numero); }

  /**
   * Imprime etiquetas con el QR de la reserva: una para la carpa o la cabaña (opcional) y una
   * por cada vehículo elegido. Todas llevan el mismo código.
   */
  P.imprimirQRReserva = function (r, patentes, conReserva) {
    var vehiculos = (r.vehiculos || []).filter(function (v) { return !v.salida && (!patentes || patentes.indexOf(v.patente) >= 0); });
    if (!patentes) conReserva = true;
    if (!conReserva && !vehiculos.length) return Promise.reject(Error("Elegí al menos una etiqueta."));
    return Promise.all([
      cargarScript("qrcode-generator-1.4.4.min.js", "qrcode"),
      P.post("/recepcion/" + r.id + "/qr", {})
    ]).then(function (res) {
      if (res[1].encolado) throw Error("Todavía no se pudo emitir el QR. Volvé a intentar cuando se restablezca la conexión.");
      var token = tokenDe(res[1].token);
      if (!token) throw Error("No se recibió un código válido para la etiqueta.");
      var titular = String(r.titular_nombre || r.titular || "");
      var etiquetas = [];
      if (conReserva) etiquetas.push(h("div.etiqueta", h("strong", "Reserva T-" + r.id), dibujoQR(res[0], token),
        h("small", titular), lugar(r) ? h("small", lugar(r)) : null));
      vehiculos.forEach(function (v) {
        etiquetas.push(h("div.etiqueta", h("strong", v.patente), dibujoQR(res[0], token),
          h("small", "AJB · Reserva T-" + r.id), h("small", titular)));
      });
      return P.imprimirHtml(h("div.etiquetas", etiquetas), "body{margin:0;color:#000;font:12pt sans-serif}" +
        ".etiquetas{display:flex;flex-wrap:wrap;gap:4mm}" +
        ".etiqueta{width:40mm;text-align:center;border:1px dotted #777;padding:2mm 0;break-inside:avoid}" +
        ".etiqueta strong{display:block;font-size:11pt}" +
        ".etiqueta svg{display:block;width:34mm;height:34mm;margin:auto}.etiqueta small{display:block;font-size:8pt;overflow-wrap:anywhere;padding:0 1mm}",
      "QR de la reserva T-" + r.id);
    });
  };
  P.imprimirQRVehiculo = function (r) { return P.imprimirQRReserva(r); };

  /** Ventana para elegir qué etiquetas imprimir. */
  P.elegirEtiquetasQR = function (r) {
    var vehiculos = (r.vehiculos || []).filter(function (v) { return !v.salida; });
    var reserva = P.check("Etiqueta de la reserva", true, "Para la carpa, la casa rodante o la cabaña" + (lugar(r) ? " · " + lugar(r) : ""));
    var porVehiculo = vehiculos.map(function (v) {
      return { patente: v.patente, check: P.check("Vehículo " + v.patente, true, [v.marca, v.color].filter(Boolean).join(" · ") + " · para el parabrisas") };
    });
    var imprimir = P.btn("Imprimir", { tipo: "primario", icono: "imprimir", onclick: function (e) {
      P.ejecutar(e.currentTarget, function () {
        var elegidas = porVehiculo.filter(function (x) { return x.check.input.checked; }).map(function (x) { return x.patente; });
        if (!reserva.input.checked && !elegidas.length) throw Error("Elegí al menos una etiqueta.");
        return P.imprimirQRReserva(r, elegidas, reserva.input.checked).then(function () { m.cerrar(); });
      }).catch(function () {});
    } });
    var m = P.modal({
      titulo: "QR de la reserva T-" + r.id,
      subtitulo: "Todas las etiquetas llevan el mismo código: al escanearlo se abre esta reserva.",
      contenido: h("div.columna", reserva, porVehiculo.map(function (x) { return x.check; }),
        vehiculos.length ? null : h("p.texto-3.chico", "La reserva no tiene vehículos en el predio. Si llegan en auto, agregalo en la ficha.")),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), imprimir]
    });
    return m;
  };

  function escanear(alEncontrar) {
    var video = h("video.vehiculo-video", { autoplay: true, muted: true, playsinline: true, hidden: true, "aria-label": "Vista previa de la cámara" });
    video.muted = true;
    var estado = h("p.texto-2", { role: "status" }, "Apuntá al QR de la etiqueta.");
    var foto = P.input({ tipo: "file" });
    foto.accept = "image/*";
    var codigo = P.input({ max: 200, placeholder: "Código de la etiqueta" });
    var lienzo = document.createElement("canvas");
    var ctx = lienzo.getContext("2d", { willReadFrequently: true });
    var flujo, reloj, cerrado = false, consultando = false, ultimoIntento;
    var lector = cargarScript("jsqr-1.4.0.min.js", "jsQR");

    function mostrarEstado(mensaje) { if (!cerrado) estado.textContent = mensaje; }
    function detener() {
      clearInterval(reloj);
      if (flujo) flujo.getTracks().forEach(function (track) { track.stop(); });
      flujo = null;
      video.srcObject = null;
    }
    function leer(imagen, ancho, alto, decodificar) {
      var escala = Math.min(1, 960 / Math.max(ancho, alto));
      lienzo.width = Math.max(1, Math.round(ancho * escala));
      lienzo.height = Math.max(1, Math.round(alto * escala));
      ctx.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
      var pixeles = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
      var leido = decodificar(pixeles.data, pixeles.width, pixeles.height, { inversionAttempts: "dontInvert" });
      return leido && tokenDe(leido.data, true);
    }
    function buscar(token, automatica) {
      if (cerrado || consultando || (automatica && token === ultimoIntento)) return;
      if (!token) { mostrarEstado("No se encontró un QR de reserva válido."); return; }
      ultimoIntento = token;
      consultando = true;
      mostrarEstado("Buscando la reserva…");
      P.get(RUTA + "/qr/" + token).then(function (fila) {
        if (cerrado) return;
        ventana.cerrar();
        alEncontrar(fila);
      }).catch(function (e) { mostrarEstado(e.message); }).finally(function () { consultando = false; });
    }
    var ventana = P.modal({
      titulo: "Escanear QR de la reserva",
      contenido: h("div.columna", estado, video, P.campo("Leer desde una foto", foto),
        h("form.fila.vehiculo-codigo", { onsubmit: function (e) { e.preventDefault(); buscar(tokenDe(codigo.value), false); } },
          P.campo("Ingresar el código o usar un lector externo", codigo), h("button.btn.btn-secundario", { type: "submit" }, "Buscar"))),
      alCerrar: function () { cerrado = true; detener(); },
      acciones: [P.btn("Cerrar", { onclick: function () { ventana.cerrar(); } })]
    });
    foto.onchange = function () {
      var archivo = foto.files[0];
      if (!archivo) return;
      var url = URL.createObjectURL(archivo);
      var imagen = new Image();
      imagen.onload = function () {
        URL.revokeObjectURL(url);
        lector.then(function (decodificar) {
          if (!cerrado) buscar(leer(imagen, imagen.naturalWidth, imagen.naturalHeight, decodificar), false);
        }).catch(function (e) { mostrarEstado(e.message); });
      };
      imagen.onerror = function () { URL.revokeObjectURL(url); mostrarEstado("No se pudo abrir la imagen."); };
      imagen.src = url;
      foto.value = "";
    };
    lector.then(function (decodificar) {
      if (cerrado) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        mostrarEstado("La cámara no está disponible en esta conexión. Podés sacar una foto del QR o usar un lector externo.");
        return;
      }
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(function (stream) {
        flujo = stream;
        if (cerrado) { detener(); return; }
        video.srcObject = stream;
        video.hidden = false;
        video.play().catch(function () {
          if (cerrado) return;
          detener();
          video.hidden = true;
          mostrarEstado("No se pudo reproducir la cámara. Podés sacar una foto del QR o usar un lector externo.");
        });
        reloj = setInterval(function () {
          if (consultando || video.readyState < 2 || !video.videoWidth) return;
          try {
            var token = leer(video, video.videoWidth, video.videoHeight, decodificar);
            if (token) buscar(token, true);
          } catch (_e) {
            detener();
            video.hidden = true;
            mostrarEstado("No se pudo leer la cámara. Podés sacar una foto del QR o usar un lector externo.");
          }
        }, 250);
      }).catch(function () { mostrarEstado("No se pudo abrir la cámara. Podés sacar una foto del QR o usar un lector externo."); });
    }).catch(function (e) { mostrarEstado(e.message); });
    return ventana;
  }

  function situacion(deuda) {
    if (deuda.desactualizada) return "sin_verificar";
    return Number(deuda.total) > 0 ? "con_deuda" : "sin_deuda";
  }
  function chipDeuda(deuda) {
    if (deuda.desactualizada) return P.chip("Saldo sin verificar", "PENDIENTE");
    return Number(deuda.total) > 0 ? P.chip(P.f.pesos(deuda.total), "VENCIDO") : P.chip("Sin deuda", true);
  }
  function movimientos(titulo, filas) {
    if (!filas || !filas.length) return null;
    return h("div.columna", h("h4", titulo), h("ul.vehiculo-detalle", filas.map(function (d) {
      return h("li", h("div", h("strong", CONCEPTOS[d.concepto] || d.concepto),
        d.detalle ? h("div.texto-2.chico", d.detalle) : null, d.fecha ? h("div.texto-2.chico", P.f.fechaHora(d.fecha)) : null),
        h("strong.sin-corte", P.f.pesos(d.importe)));
    })));
  }
  function estadoPersona(p) {
    return p.salida ? "Salió el " + P.f.fecha(p.salida) : p.entrada ? "En el predio" : "Sin ingreso";
  }
  function estadoVehiculo(v) {
    return v.salida ? h("span.texto-2", "Salió el " + P.f.fecha(v.salida)) : v.en_predio ? P.chip("En el predio", "ABIERTO") : h("span.texto-2", "Sin ingreso");
  }

  /** Ficha de la reserva para Seguridad: estadía, vehículos, personas y deuda. */
  function ficha(f, recargar, resaltar) {
    var admin = P.puedeGestionarCajas() && P.puedeGestionarReservas();
    var deuda = f.deuda || {};
    var ventana;
    function volverAAbrir() {
      return P.get(RUTA + "/" + f.id).then(function (vigente) {
        ventana.cerrar();
        ficha(vigente, recargar, resaltar);
        if (recargar) recargar();
      });
    }
    function registrarSalida(v) {
      return P.confirmar("¿Confirmás que el vehículo " + v.patente + " ya salió del predio?", {
        titulo: "Salida del vehículo", aceptar: "Registrar salida"
      }).then(function (confirmado) {
        if (!confirmado) return;
        return P.post(RUTA + "/" + f.id + "/salida", { patente: v.patente, operacion: P.recepcion.nuevaClave() }).then(function (r) {
          if (r.encolado) { ventana.cerrar(); return; }
          P.aviso("Salida del vehículo " + v.patente + " registrada.", "ok");
          return volverAAbrir();
        });
      });
    }
    var vehiculos = (f.vehiculos || []).slice().sort(function (a, b) {
      return (b.patente === resaltar) - (a.patente === resaltar) || (b.en_predio ? 1 : 0) - (a.en_predio ? 1 : 0);
    });
    var datosUbicacion = f.es_parcela ? h("div.dato.rec-dato-ubicacion", h("span", "Ubicación"), h("strong", f.ubicacion || "—"),
      admin ? P.btn(f.ubicacion ? "Cambiar" : "Indicar ubicación", { tipo: "texto", chico: true, icono: "editar", onclick: function () {
        P.recepcion.editarUbicacion({ id: f.id, ubicacion: f.ubicacion, titular_nombre: f.titular, numero_parcela: f.numero_parcela }, volverAAbrir);
      } }) : null) : null;
    ventana = P.modal({
      titulo: "Reserva T-" + f.id,
      subtitulo: f.titular + (f.titular_dni ? " · DNI " + f.titular_dni : ""),
      ancho: "ancha",
      contenido: h("div.columna.vehiculo-ficha",
        h("div.datos.rec-datos",
          P.dato("Servicio / recurso", [f.servicio, recursoYParcela(f.recurso, f.numero_parcela)].filter(Boolean).join(" · ") || "—"),
          datosUbicacion,
          P.dato("Estadía", P.f.fecha(f.fecha_inicio) + " – " + P.f.fecha(f.fecha_fin))),
        h("div.columna.vehiculo-resumen", h("h3", vehiculos.length === 1 ? "Vehículo" : "Vehículos"),
          vehiculos.length ? h("ul.vehiculo-detalle", vehiculos.map(function (v) {
            return h("li" + (v.patente === resaltar ? ".vehiculo-resaltado" : ""),
              h("div", h("strong", v.patente), h("div.texto-2.chico", [[v.marca, v.color].filter(Boolean).join(" "), v.sector ? "Sector " + v.sector : null].filter(Boolean).join(" · "))),
              h("div.vehiculo-estado", estadoVehiculo(v), admin && v.en_predio ? P.btn("Registrar salida", { chico: true, onclick: function (e) {
                P.ejecutar(e.currentTarget, function () { return registrarSalida(v); }).catch(function () {});
              } }) : null));
          })) : h("p.texto-2", "La reserva no tiene vehículos registrados.")),
        h("div.columna.vehiculo-resumen", h("h3", "Personas de la reserva"),
          f.personas.length ? h("ul.vehiculo-detalle", f.personas.map(function (p) {
            return h("li", h("div", h("strong", p.nombre), h("div.texto-2.chico", ["DNI " + p.dni, p.edad != null ? p.edad + " años" : null, p.vinculo].filter(Boolean).join(" · "))),
              h("div.vehiculo-estado", h("span", estadoPersona(p)), !p.salida && p.salida_prevista ? h("span.texto-2.chico", "Sale el " + P.f.fecha(p.salida_prevista)) : null));
          })) : h("p.texto-2", "No hay personas registradas.")),
        h("div.columna.vehiculo-resumen", h("div.fila-separada", h("h3", "Deuda de la reserva"), chipDeuda(deuda)),
          deuda.desactualizada ? P.mensaje("El saldo está pendiente de verificación. Consultá con recepción antes de autorizar la salida.", "aviso") : null,
          deuda.replicada && deuda.ultima_sincronizacion ? h("p.texto-2.chico", "Última actualización de consumos: " + P.f.fechaHora(deuda.ultima_sincronizacion)) : null,
          h("div.rec-grid", P.dato("Saldo de alojamiento", deuda.reserva == null ? "Sin verificar" : P.f.pesos(deuda.reserva)),
            P.dato("Saldo de consumos", deuda.consumos == null ? "Sin verificar" : P.f.pesos(deuda.consumos))),
          movimientos("Movimientos recientes", deuda.detalle),
          movimientos("Traslados entre integrantes", deuda.traspasos))),
      acciones: [
        P.btn("Cerrar", { onclick: function () { ventana.cerrar(); } }),
        admin ? P.btn("Abrir la reserva", { tipo: "primario", icono: "flecha", onclick: function () { ventana.cerrar(); P.ruta.ir("/recepcion/" + f.id); } }) : null
      ]
    });
    return ventana;
  }

  function normalizar(texto) {
    return String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function filas() { return P.get(RUTA).then(function (datos) { return datos.filas; }); }
  function listado(filasActuales, p) {
    var palabras = normalizar(p.q).split(/\s+/).filter(Boolean);
    var coincidencias = filasActuales.filter(function (f) {
      var buscable = normalizar([f.vehiculo.patente, f.vehiculo.marca, f.vehiculo.color, f.vehiculo.sector, "T-" + f.id, f.titular,
        f.ubicacion, f.numero_parcela ? "parcela " + f.numero_parcela : "", f.personas.map(function (x) { return x.nombre; }).join(" ")].join(" "));
      return (!p.f_deuda || situacion(f.deuda) === p.f_deuda) && (!p.f_sector || (f.vehiculo.sector || "Sin sector") === p.f_sector) &&
        palabras.every(function (x) { return buscable.indexOf(x) >= 0; });
    });
    function valor(fila) {
      if (p.orden === "deuda") return Number(fila.deuda.total);
      if (p.orden === "id") return Number(fila.id);
      if (p.orden === "titular") return fila.titular;
      if (p.orden === "sector") return fila.vehiculo.sector;
      return fila.vehiculo.patente;
    }
    coincidencias.sort(function (a, b) {
      var va = valor(a), vb = valor(b);
      var orden = typeof va === "number" ? va - vb : comparador.compare(va || "", vb || "");
      return orden * (p.dir === "desc" ? -1 : 1) || Number(a.id) - Number(b.id);
    });
    var total = coincidencias.length, paginas = Math.max(1, Math.ceil(total / p.tam)), pagina = Math.min(p.pagina, paginas);
    return { filas: coincidencias.slice((pagina - 1) * p.tam, pagina * p.tam), total: total, paginas: paginas, pagina: pagina, tam: p.tam };
  }
  P.ruta.registrar(/^\/vehiculos$/, function (c) {
    var primerasFilas, abierta;
    P.alSalir(function () { if (abierta) abierta.cerrar(); });
    function abrir(fila, patente) { abierta = ficha(fila, t.recargar, patente || (fila.vehiculo && fila.vehiculo.patente)); }
    var t = P.tabla({
      listado: "vehiculos", exportar: false, placeholderBuscar: "Patente, persona, reserva o parcela…",
      tituloVacio: "No hay vehículos en el predio", iconoVacio: "tag",
      cargarMeta: function () {
        return filas().then(function (datos) {
          primerasFilas = datos;
          var sectores = Array.from(new Set(datos.map(function (f) { return f.vehiculo.sector || "Sin sector"; })));
          sectores.sort(comparador.compare);
          return {
            titulo: "vehículos", buscador: true, orden: { clave: "patente", dir: "asc" },
            columnas: [
              { clave: "patente", titulo: "Vehículo" }, { clave: "sector", titulo: "Sector" },
              { clave: "id", titulo: "Reserva" }, { clave: "titular", titulo: "Titular" },
              { clave: "deuda", titulo: "Deuda", tipo: "money" }
            ],
            filtros: [
              { clave: "deuda", titulo: "Deuda", tipo: "opciones", opciones: [
                { valor: "con_deuda", texto: "Con deuda" }, { valor: "sin_deuda", texto: "Sin deuda" },
                { valor: "sin_verificar", texto: "Saldo sin verificar" }
              ] },
              { clave: "sector", titulo: "Sector", tipo: "opciones", opciones: sectores.map(function (s) { return { valor: s, texto: s }; }) }
            ]
          };
        });
      },
      consultar: function (p) {
        var datos = primerasFilas ? Promise.resolve(primerasFilas) : filas();
        primerasFilas = null;
        return datos.then(function (r) { return listado(r, p); });
      },
      celdas: {
        patente: function (_valor, f) {
          return h("div", h("strong", f.vehiculo.patente), h("div.texto-2.chico", [f.vehiculo.marca, f.vehiculo.color].filter(Boolean).join(" · ")));
        },
        sector: function (_valor, f) { return f.vehiculo.sector || "—"; },
        id: function (id, f) {
          var donde = [f.numero_parcela ? "Parcela " + f.numero_parcela : null, f.ubicacion].filter(Boolean).join(" · ");
          return h("div.vehiculo-reserva", h("strong", "T-" + id), donde ? h("div.texto-2.chico", donde) : null,
            f.otros_vehiculos && f.otros_vehiculos.length ? h("div.texto-3.chico", "También: " + f.otros_vehiculos.join(", ")) : null);
        },
        deuda: chipDeuda
      },
      acciones: function (f) {
        return P.btn("Ver detalle", { chico: true, onclick: function (e) {
          P.ejecutar(e.currentTarget, function () {
            return P.get(RUTA + "/" + f.id).then(function (vigente) {
              if (c.isConnected) abrir(vigente, f.vehiculo.patente);
            }).catch(function (e) { if (e.status === 404) t.recargar(); throw e; });
          }).catch(function () {});
        } });
      }
    });
    c.appendChild(P.cabeceraConAcciones("Vehículos en el predio", "Escaneá el QR de la reserva o buscá la patente para ver sus vehículos, sus personas y su deuda.",
      h("div.fila",
        P.btn("Actualizar", { icono: "refrescar", onclick: t.recargar }),
        P.btn("Escanear QR", { tipo: "primario", icono: "qr", onclick: function () { abierta = escanear(function (fila) { abrir(fila, null); }); } }))));
    c.appendChild(t.el);
  }, { titulo: "Vehículos en el predio" });
})();
