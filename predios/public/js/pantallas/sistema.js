/* Sistema: sincronización con el sistema general, archivos para pendrive, actualizaciones,
   respaldos, configuración del predio, autorizaciones y auditoría. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  function solapas(c, actual) {
    var items = [
      { ruta: "/sistema", texto: P.modo === "local" ? "Estado y sincronización" : "Estado" },
      { ruta: "/sistema/configuracion", texto: "Configuración" },
      { ruta: "/sistema/autorizaciones", texto: "Autorizaciones" },
      { ruta: "/sistema/auditoria", texto: "Auditoría" },
    ];
    c.appendChild(h("div.pagina-cabecera", h("div", h("h1.titulo-pagina", "Sistema"), h("p.subtitulo", "Conexión con el sistema general, respaldos, configuración y registro de todo lo que se hizo."))));
    c.appendChild(h("nav.solapas", items.map(function (s) { return h("a.solapa", { href: "#" + s.ruta, "aria-current": actual === s.ruta ? "page" : null }, s.texto); })));
  }

  // Nombre de la notebook en la red: las PCs entran con http://nombre:puerto en lugar de la IP.
  function reiniciarNotebook() {
    P.confirmar("La notebook se reinicia en 20 segundos. Mientras tanto nadie puede vender ni cobrar; el sistema vuelve solo en uno o dos minutos.", { titulo: "¿Reiniciar la notebook ahora?", aceptar: "Reiniciar ahora", peligro: true }).then(function (ok) {
      if (!ok) return;
      P.post("/sistema/reiniciar-equipo").then(function (r) { P.aviso(r.mensaje, "ok", 15000); }).catch(P.error);
    });
  }
  function formNombreRed(red, alGuardar) {
    var puerto = (/:(\d+)$/.exec(red.por_nombre) || [])[1];
    var input = P.input({ valor: red.pendiente || red.nombre, max: 15, placeholder: "Por ejemplo: CAMPING" });
    input.setAttribute("autocapitalize", "characters");
    input.setAttribute("spellcheck", "false");
    var vista = h("strong");
    function pintarVista() { vista.textContent = "http://" + (input.value.trim() || "nombre").toLowerCase() + (puerto ? ":" + puerto : ""); }
    input.addEventListener("input", pintarVista);
    pintarVista();
    var m = P.modal({
      titulo: "Nombre de la notebook en la red",
      subtitulo: "Las PCs del camping van a poder entrar escribiendo el nombre en lugar de los números de la IP.",
      contenido: h("div.columna",
        P.campo("Nombre", input, { ayuda: "De 2 a 15 letras, números o guiones, empezando con una letra." }),
        h("p", { style: { margin: 0 } }, "Las PCs van a entrar a: ", vista),
        P.mensaje("Para que tome el nombre nuevo hay que reiniciar la notebook (tarda uno o dos minutos y el sistema vuelve solo). Si en alguna PC no abre con el nombre, sigue funcionando con la IP.", "info")),
      acciones: [P.btn("Cancelar", { onclick: function () { m.cerrar(); } }), P.btn("Guardar nombre", { tipo: "primario", icono: "check", onclick: function (ev) {
        P.ejecutar(ev.currentTarget, function () {
          return P.post("/sistema/red", { nombre: input.value.trim() }).then(function (r) {
            m.cerrar();
            P.aviso(r.mensaje, "ok", 9000);
            if (alGuardar) alGuardar();
            if (r.pendiente) reiniciarNotebook();
          });
        }).catch(function () {});
      } })],
    });
  }

  function tamano(b) {
    if (b > 1024 * 1024) return P.f.numero(P.redondear(b / 1024 / 1024, 1)) + " MB";
    return P.f.entero(b / 1024) + " KB";
  }

  P.ruta.registrar(/^\/sistema$/, function (c) {
    solapas(c, "/sistema");
    if (P.modo === "remoto") {
      var r = P.estado.remoto || {};
      c.appendChild(h("div.hoja.hoja-cuerpo", h("div.datos",
        P.dato("Estado del camping", r.escritor === "CENTRAL" ? "Sin notebook instalada" : r.en_linea ? "Conectado" : "Sin conexión"),
        P.dato("Último contacto", P.f.relativo(r.ultima_conexion)), P.dato("Última subida de datos", P.f.relativo(r.ultimo_push)),
        P.dato("Equipo", r.equipo), P.dato("Versión instalada", String(r.version_local || "—").split("+")[0]),
        P.dato("Cambios en cola para el camping", String(r.cambios_en_cola || 0))),
        h("p.texto-3", { style: { marginBottom: 0 } }, "Para actualizar, reiniciar, descargar el instalador o mover datos por pendrive, usá los botones de Mi AJB > Predios (fuera de este panel).")));
      return;
    }
    var zona = h("div.columna", P.cargando());
    c.appendChild(zona);
    function cargar() {
      return P.get("/sistema/estado").then(function (d) {
        var s = d.sincronizacion;
        var versionInstalada = String(s.version || "").split("+")[0];
        var hayNueva = s.version_disponible && s.version_disponible !== s.version;
        var archivo = h("input", { type: "file", accept: ".ajbpaquete,application/octet-stream", hidden: true });
        archivo.addEventListener("change", function () {
          var f = archivo.files[0];
          if (!f) return;
          P.confirmar("Se van a cargar los datos del archivo «" + f.name + "» (afiliados, cambios pendientes y, si trae, la versión nueva). Antes se hace un respaldo automático.", { aceptar: "Cargar paquete" }).then(function (ok) {
            if (!ok) { archivo.value = ""; return; }
            P.api("POST", "/sistema/importar", f).then(function (r) {
              var x = r.resumen || {};
              P.aviso("Paquete aplicado: " + (x.maestros ? (x.maestros.afiliados_nuevos + x.maestros.afiliados_unidos + x.maestros.afiliados_actualizados) + " afiliado(s) actualizados, " : "") + x.comandos + " cambio(s) aplicados" + (x.errores ? " (" + x.errores + " con error)" : "") + (x.actualizacion && x.actualizacion.actualizado ? ". Se instaló una versión nueva: el sistema se reinicia." : ""), "ok", 10000);
              archivo.value = "";
              cargar();
            }).catch(function (e) { archivo.value = ""; P.error(e); });
          });
        });
        P.reemplazar(zona,
          h("div.grilla.grilla-2",
            h("div.hoja.hoja-cuerpo",
              h("div.fila-separada", h("h2.seccion-titulo", "Sincronización con el sistema general"),
                !s.vinculado ? P.chip("Sin vincular", "VENCIDO") : s.en_linea ? P.chip("Conectado", "CONFIRMADA") : P.chip("Sin internet", "PENDIENTE")),
              s.conflicto ? h("div", { style: { marginTop: "12px" } }, P.mensaje(s.conflicto, "error")) : null,
              !s.vinculado ? h("p.texto-3", "Esta instalación no tiene la clave del sistema general. Descargá el instalador desde Mi AJB > Predios para vincularla.") : null,
              h("div.datos", { style: { marginTop: "14px" } },
                P.dato("Último contacto", P.f.relativo(s.ultimo_contacto)),
                P.dato("Última subida", P.f.relativo(s.ultima_subida)),
                P.dato("Cambios por subir", P.f.entero(s.pendientes)),
                P.dato("Afiliados con reserva", s.maestros ? P.f.entero(s.maestros.afiliados) + " (" + P.f.relativo(s.maestros.fecha) + ")" : "—")),
              s.ultimo_error && !s.en_linea ? h("p.texto-3.chico", "Último error: " + s.ultimo_error) : null,
              h("p.texto-3.chico", "Sin internet el sistema funciona igual: todo se guarda en esta notebook y se sube solo cuando vuelve la conexión."),
              h("div.fila", { style: { marginTop: "6px" } },
                P.btn("Sincronizar ahora", { tipo: "primario", icono: "refrescar", deshabilitado: !s.vinculado, onclick: function (ev) {
                  P.ejecutar(ev.currentTarget, function () { return P.post("/sistema/sincronizar").then(function (r) { P.aviso(r.mensaje, "ok"); cargar(); }); }).catch(function () {});
                } }))),
            h("div.hoja.hoja-cuerpo",
              h("div.fila-separada", h("h2.seccion-titulo", "Versión"), hayNueva ? P.chip("Hay una versión nueva", "PENDIENTE") : P.chip("Al día", "CONFIRMADA")),
              h("div.datos", { style: { marginTop: "14px" } },
                P.dato("Instalada", versionInstalada), P.dato("Disponible", s.version_disponible ? String(s.version_disponible).split("+")[0] : "—"),
                P.dato("Actualización automática", s.actualizaciones_automaticas ? "Sí" : "No"), P.dato("En marcha desde", P.f.fechaHora(d.servidor.iniciado))),
              h("p.texto-3.chico", "Las actualizaciones llegan solas desde el sistema general y se instalan con un reinicio de segundos. Si una versión falla, vuelve sola a la anterior."),
              P.btn("Buscar actualización ahora", { tipo: "secundario", icono: "descargar", deshabilitado: !s.vinculado, onclick: function (ev) {
                P.ejecutar(ev.currentTarget, function () {
                  return P.post("/sistema/actualizar").then(function (r) {
                    P.aviso(r.mensaje, "ok", 9000);
                    if (r.reiniciando) setTimeout(function () { location.reload(); }, 9000);
                  });
                }).catch(function () {});
              } }))),
          h("div.grilla.grilla-2",
            h("div.hoja.hoja-cuerpo",
              h("h2.seccion-titulo", "Sin internet: pasar datos en pendrive"),
              h("p.texto-3", "Exportá los datos del camping para subirlos en Mi AJB > Predios, o cargá el paquete que bajaste de ahí (afiliados con reserva, cambios hechos a distancia y actualizaciones)."),
              h("div.fila",
                P.btn("Exportar datos para el sistema general", { tipo: "primario", icono: "descargar", onclick: function (ev) {
                  P.ejecutar(ev.currentTarget, function () { return P.descargar("/sistema/exportar", "predio.ajbpredio").then(function () { P.aviso("Archivo generado. Copialo al pendrive.", "ok"); }); }).catch(function () {});
                } }),
                P.btn("Cargar paquete del sistema general", { tipo: "secundario", icono: "subir", onclick: function () { archivo.click(); } }), archivo)),
            h("div.hoja.hoja-cuerpo",
              h("h2.seccion-titulo", "Direcciones para las PCs del camping"),
              h("p.texto-3", "En cada PC, abrí el navegador y entrá a:"),
              h("ul.lista-simple",
                d.red ? h("li", h("strong", d.red.por_nombre), h("span.texto-3.chico", "con el nombre de la notebook")) : null,
                d.servidor.direcciones.map(function (x) { return h("li", h("strong", x.url), h("span.texto-3.chico", "IP · " + x.interfaz)); })),
              d.red && d.red.pendiente ? h("div", { style: { marginTop: "10px" } }, P.mensaje(h("span", "El nombre nuevo, ", h("strong", d.red.pendiente), ", se aplica cuando se reinicie la notebook."), "aviso")) : null,
              h("div.fila", { style: { marginTop: "12px" } },
                P.btn("Cambiar el nombre en la red", { tipo: "secundario", icono: "red", deshabilitado: !(d.red && d.red.puede_cambiar), onclick: function () { formNombreRed(d.red, cargar); } }),
                d.red && d.red.pendiente ? P.btn("Reiniciar la notebook", { tipo: "texto", icono: "refrescar", onclick: reiniciarNotebook }) : null),
              h("p.texto-3.chico", { style: { marginBottom: 0 } }, "Equipo " + d.equipo.nombre + " · " + d.equipo.sistema + " · Node " + d.equipo.node))),
          h("div.hoja.hoja-cuerpo",
            h("div.fila-separada", h("h2.seccion-titulo", "Respaldos de la base de datos"),
              P.btn("Crear respaldo ahora", { tipo: "secundario", icono: "historial", onclick: function (ev) {
                P.ejecutar(ev.currentTarget, function () { return P.post("/sistema/respaldo").then(function (r) { P.aviso(r.mensaje, "ok"); cargar(); }); }).catch(function () {});
              } })),
            h("p.texto-3", "Se hace una copia por día automáticamente (se guardan 30). Base actual: " + tamano(d.base_datos.tamano) + "."),
            d.respaldos.length ? h("ul.lista-simple", d.respaldos.slice(0, 12).map(function (x) {
              return h("li", h("span", x.nombre), h("div.fila", h("span.texto-3.chico", tamano(x.tamano)),
                P.btn("", { tipo: "texto", chico: true, icono: "descargar", etiqueta: "Descargar", onclick: function () { P.descargar("/sistema/respaldos/" + encodeURIComponent(x.nombre), x.nombre).catch(P.error); } })));
            })) : h("p.texto-3", "Todavía no hay respaldos.")));
      }).catch(function (e) { P.reemplazar(zona, P.mensaje(e.message, "error")); });
    }
    P.intervalo(function () { cargar(); }, 15000);
    return cargar();
  }, { admin: true, titulo: "Sistema" });

  P.ruta.registrar(/^\/sistema\/configuracion$/, function (c) {
    solapas(c, "/sistema/configuracion");
    return P.get("/config").then(function (r) {
      var cf = r.config;
      var campos = {
        nombre_predio: P.input({ valor: cf.nombre_predio, max: 120 }),
        razon_social: P.input({ valor: cf.razon_social, max: 160 }),
        cuit: P.input({ valor: cf.cuit, max: 13 }),
        direccion: P.input({ valor: cf.direccion, max: 200 }),
        leyenda_ticket: P.input({ valor: cf.leyenda_ticket, max: 200 }),
        texto_autorizacion: h("textarea.campo-control", { maxlength: 1000 }, cf.texto_autorizacion || ""),
        minutos_permiso: P.input({ valor: cf.minutos_permiso, inputmode: "numeric", max: 4 }),
      };
      var sinStock = P.check("Permitir vender aunque el sistema marque que no hay stock (pide confirmación)", cf.vender_sin_stock !== "0");
      c.appendChild(h("div.hoja.hoja-cuerpo",
        h("div.grilla.grilla-2",
          P.campo("Nombre del predio", campos.nombre_predio, { ayuda: "Aparece en el ingreso y en los tickets." }),
          P.campo("Razón social", campos.razon_social),
          P.campo("CUIT", campos.cuit), P.campo("Dirección", campos.direccion)),
        h("div", { style: { marginTop: "14px" } }, P.campo("Leyenda al pie del ticket", campos.leyenda_ticket)),
        h("div", { style: { marginTop: "14px" } }, P.campo("Texto de autorización del descuento de haberes", campos.texto_autorizacion, { ayuda: "Sale en el ticket de las compras con descuento y en la liquidación." })),
        h("div.grilla.grilla-2", { style: { marginTop: "14px" } }, P.campo("Minutos que dura una autorización aprobada", campos.minutos_permiso), h("div", { style: { paddingTop: "24px" } }, sinStock)),
        h("div.fila", { style: { marginTop: "18px", justifyContent: "flex-end" } }, P.btn("Guardar configuración", { tipo: "primario", icono: "check", onclick: function (ev) {
          var cuerpo = {};
          Object.keys(campos).forEach(function (k) { cuerpo[k] = campos[k].value; });
          cuerpo.vender_sin_stock = sinStock.input.checked ? "1" : "0";
          P.ejecutar(ev.currentTarget, function () { return P.put("/config", cuerpo).then(function (x) { if (!x.encolado) P.aviso(x.mensaje, "ok"); }); }).catch(function () {});
        } }))));
      c.appendChild(h("div.hoja.hoja-cuerpo", h("h2.seccion-titulo", "Clave del día"),
        h("p.texto-3", { style: { marginBottom: 0 } }, "Cuando un usuario de boca necesita autorización (pedir productos, anular una venta, ver todas las ventas de la caja), el administrador puede escribir en esa PC la clave del día: es la fecha de hoy sin barras ni ceros adelante. Por ejemplo, el 5/11/2026 la clave es 5112026. También puede aprobarlo a distancia desde la campana de avisos.")));
    });
  }, { admin: true, titulo: "Configuración" });

  P.ruta.registrar(/^\/sistema\/autorizaciones$/, function (c) {
    solapas(c, "/sistema/autorizaciones");
    var t = P.tabla({
      listado: "permisos",
      acciones: function (f, recargar) {
        if (f.estado !== "PENDIENTE") return [];
        return [P.btn("Responder", { tipo: "primario", chico: true, onclick: function () {
          P.resolverPermiso(Object.assign({}, f));
          setTimeout(recargar, 2500);
        } })];
      },
    });
    c.appendChild(t.el);
  }, { admin: true, titulo: "Autorizaciones" });

  P.ruta.registrar(/^\/sistema\/auditoria$/, function (c) {
    solapas(c, "/sistema/auditoria");
    c.appendChild(h("p.texto-3", { style: { marginTop: "-6px" } }, "Todo lo que se hizo en el sistema, quién y cuándo (también los cambios hechos a distancia desde el sistema general)."));
    c.appendChild(P.tabla({
      listado: "auditoria",
      alClickFila: function (f) {
        var detalle = f.detalle;
        try { detalle = JSON.stringify(JSON.parse(f.detalle), null, 2); } catch (e) { /* texto */ }
        P.modal({ titulo: f.accion, subtitulo: P.f.fechaHora(f.fecha) + " · " + f.usuario_nombre + (f.entidad ? " · " + f.entidad + " " + (f.entidad_id || "") : ""), ancho: "ancha",
          contenido: h("pre", { style: { margin: 0, padding: "14px", background: "var(--papel)", borderRadius: "8px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "13px" } }, detalle || "Sin detalle") });
      },
    }).el);
  }, { admin: true, titulo: "Auditoría" });
})();
