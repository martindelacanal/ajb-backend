/* PCs de respaldo y testigo local. Consultar esta pantalla no modifica el grupo. */
(function () {
  "use strict";
  if (window.__SIN_SOPORTE) return;
  var P = window.P;
  var h = P.h;

  P.panelGrupoLocal = function () {
    if (P.modo === "remoto") return h("div.hoja.hoja-cuerpo", h("p.texto-3", "Para preparar las PCs de respaldo, abrí Sistema desde una PC de la red del predio."));
    var cerrado = false, consultando = false, trabajando = false, confirmando = false, activando = false;
    var datos = null, huella = null, reinicio = null;
    var estado = h("div", { role: "status", "aria-live": "polite" }, P.chip("Consultando", "PENDIENTE"));
    var mensaje = h("div", { hidden: true });
    var problema = h("div", { hidden: true, role: "alert" });
    var aviso = h("p.texto-3.chico", { role: "status", hidden: true, style: { margin: 0 } });
    var pcServicio = h("strong", "Consultando…"), preferida = h("strong", "—"), pcTestigo = h("strong", "Pendiente de instalar");
    var equipos = h("ul.lista-simple", { hidden: true });
    var sinEquipos = h("p.texto-3.chico", { style: { margin: 0 } }, "Todavía no hay PCs de respaldo agregadas.");
    var reducida = P.mensaje("Protección reducida: no hay una copia de respaldo confirmada disponible. Revisá las PCs de respaldo para recuperar la protección.", "aviso");
    reducida.hidden = true;
    var retorno = h("p.texto-3.chico", { style: { margin: 0 }, hidden: true }, "Cuando vuelve la PC preferida, primero recibe los datos pendientes y después retoma el servicio.");
    var testigo = botonInstalador("Instalar testigo en una PC de caja", "Testigo");
    var respaldo = botonInstalador("Agregar PC de respaldo", "Respaldo");
    var acceso = botonInstalador("Preparar acceso de caja", "Acceso");
    var accesoQuorum = P.btn("Descargar acceso de caja", { tipo: "secundario", icono: "descargar", onclick: descargarAcceso });
    var ayudaAcceso = h("p.texto-3.chico", { hidden: true }, "Para una PC que sólo va a vender, descargá el acceso de caja desde esa misma PC. El acceso encuentra el servidor en servicio y la caja no participa en la votación.");
    var equipo = P.btn("Incorporar esta PC", { tipo: "primario", icono: "descargar", deshabilitado: true, onclick: incorporarEquipo });
    equipo.hidden = true;
    var activar = P.btn("Activar reemplazo automático", { tipo: "primario", icono: "check", deshabilitado: true, onclick: activarGrupo });
    var configurarManual = P.btn("Configurar relevo manual con dos PCs", { tipo: "secundario", icono: "check", deshabilitado: true, onclick: function () { activarGrupo(true); } });
    var revisar = P.btn("Actualizar estado", { tipo: "texto", icono: "refrescar", onclick: function () { cargar(); } });
    var pasos = h("ol", { style: { margin: 0, paddingLeft: "22px" } },
      h("li", "Instalá el testigo en una PC de caja que permanezca encendida. Es liviano y no guarda la base de ventas ni stock."),
      h("li", "Agregá las PCs de respaldo que necesites y completá su incorporación."),
      h("li", "Activá el reemplazo automático y prepará el acceso de cada caja."));
    var ayudaEquipo = h("p.texto-3", { hidden: true }, "Incorporá la PC de caja desde esa misma PC. Con dos equipos podés configurar el relevo manual. El relevo automático se activa con tres equipos listos.");
    var ayudaManual = h("p.texto-3", { hidden: true }, "Mantené las dos PCs conectadas para confirmar cada venta en ambas. Si se apaga la principal, volvé a abrir el acceso de caja en su escritorio y autorizá el relevo con una cuenta de administrador.");
    var ayudaCaja = h("p.texto-3.chico", { style: { margin: 0 } }, "En las cajas, usá «Sistema del Camping - Caja»: abre localhost:8091 y encuentra la PC en servicio.");
    var datosTestigo = h("div.dato", h("span", "Testigo en la red"), pcTestigo);
    var panel = h("section.hoja.hoja-cuerpo.columna", { "aria-label": "PCs de respaldo del predio" },
      h("div.fila-separada", h("h2.seccion-titulo", "PCs de respaldo"), estado),
      h("p.texto-3", { style: { margin: 0 } }, "Podés seguir trabajando con una sola PC. Si agregás respaldos, otra PC puede continuar atendiendo las cajas cuando falle la que está en servicio."),
      h("div.datos", h("div.dato", h("span", "PC en servicio"), pcServicio), h("div.dato", h("span", "PC de origen"), preferida), datosTestigo),
      mensaje, problema, reducida,
      pasos, ayudaEquipo, ayudaManual,
      equipos, sinEquipos, retorno,
      h("div.fila", equipo, testigo, respaldo, acceso, accesoQuorum, activar, configurarManual), ayudaCaja, ayudaAcceso,
      aviso, h("div.fila", revisar));

    function actualizarControles() {
      var ocupado = trabajando || confirmando || activando || !datos;
      var manual = datos && datos.modo === "manual";
      var unificado = !!datos && (manual || datos.modo === "quorum" || datos.puedeIncorporarEquipo);
      equipo.hidden = !unificado || manual;
      equipo.disabled = ocupado || !datos.puedeIncorporarEquipo;
      pasos.hidden = ayudaCaja.hidden = datosTestigo.hidden = testigo.hidden = respaldo.hidden = acceso.hidden = unificado;
      ayudaEquipo.hidden = !unificado || manual;
      ayudaManual.hidden = !manual;
      testigo.disabled = ocupado || !datos.puedePrepararTestigo;
      respaldo.disabled = ocupado || !datos.puedePrepararRespaldo;
      acceso.disabled = ocupado || !datos.testigo;
      accesoQuorum.hidden = ayudaAcceso.hidden = !datos?.puedePrepararAcceso;
      accesoQuorum.disabled = ocupado;
      activar.disabled = ocupado || !datos.puedeActivar;
      activar.hidden = unificado || (!!datos && (datos.estado === "EN_MARCHA" || datos.estado === "SIN_TESTIGO"));
      configurarManual.hidden = !datos || !datos.puedeConfigurarManual;
      configurarManual.disabled = ocupado || configurarManual.hidden;
      revisar.disabled = consultando || activando;
    }
    function descargarAcceso() {
      if (trabajando || cerrado) return;
      trabajando = true; actualizarControles();
      P.ejecutar(accesoQuorum, function () {
        return P.descargarPost("/sistema/grupo-local/acceso-caja", {}, "AJB-Acceso-de-caja.zip").then(function () {
          if (cerrado) return;
          aviso.textContent = "Extraé el ZIP y ejecutá INSTALAR-APOYO.bat en esta caja. Después abrí «Sistema del Camping - Caja» desde el escritorio.";
          aviso.hidden = false;
        });
      }).catch(function () {}).finally(function () { trabajando = false; if (!cerrado) actualizarControles(); });
    }
    function quitarRespaldo(m, boton) {
      if (trabajando || confirmando || activando || cerrado) return;
      confirmando = true; actualizarControles();
      P.confirmar("La PC " + m.nombre + " dejará de contar para la mayoría cuando el grupo confirme la baja.",
        { titulo: "¿Quitar este respaldo?", aceptar: "Quitar respaldo", peligro: true }).then(function (ok) {
        confirmando = false;
        if (!ok || cerrado) { if (!cerrado) actualizarControles(); return; }
        trabajando = true; actualizarControles();
        return P.ejecutar(boton, function () {
          return P.post("/sistema/grupo-local/quitar-respaldo", { equipoId: m.id }).then(function (r) {
            if (cerrado) return;
            aviso.textContent = r.pendiente ? "La baja está pendiente. El grupo espera a que las PCs que quedan guarden la última copia."
              : "La PC fue retirada del grupo de respaldos.";
            aviso.hidden = false;
          });
        }).catch(function () {}).finally(function () { trabajando = false; if (!cerrado) { actualizarControles(); cargar(); } });
      }).catch(function (e) { confirmando = false; if (!cerrado) { actualizarControles(); P.error(e); } });
    }
    function incorporarEquipo() {
      if (trabajando || cerrado) return;
      trabajando = true; actualizarControles();
      P.ejecutar(equipo, function () {
        return P.descargarPost("/sistema/grupo-local/incorporar-equipo", {}, "AJB-Incorporar-esta-PC.zip").then(function () {
          if (cerrado) return;
          aviso.textContent = "Extraé el ZIP, abrí INSTALAR-APOYO.bat y aceptá el permiso de Windows. El acceso de caja aparecerá en el escritorio.";
          aviso.hidden = false;
        });
      }).catch(function () {}).finally(function () { trabajando = false; if (!cerrado) { actualizarControles(); cargar(); } });
    }
    function botonInstalador(texto, rol) {
      var boton = P.btn(texto, { tipo: "secundario", icono: "descargar", deshabilitado: true, onclick: function () {
        if (trabajando || activando || cerrado) return;
        trabajando = true; actualizarControles();
        P.ejecutar(boton, function () {
          return P.descargarPost("/sistema/grupo-local/instalador", { rol: rol }, "AJB-Predio-" + rol + ".zip").then(function () {
            if (cerrado) return;
            aviso.textContent = "Instalador descargado. En la " + (rol === "Testigo" ? "PC de caja elegida para el testigo" : rol === "Respaldo" ? "PC de respaldo" : "PC de caja") + ", descomprimí el ZIP y ejecutá INSTALAR-APOYO.bat como administrador.";
            aviso.hidden = false;
          });
        }).catch(function () {}).finally(function () { trabajando = false; if (!cerrado) { actualizarControles(); cargar(); } });
      } });
      return boton;
    }
    function estadoVisible(d) {
      if (d.modo === "manual" && d.estado === "EN_MARCHA") return [d.manualActivo ? "Caja en relevo manual" : "Relevo manual preparado", "CONFIRMADA"];
      var estados = {
        SIN_CONFIGURAR: ["Una sola PC", "CONFIRMADA"],
        PREPARANDO: ["Preparando las PCs", "PENDIENTE"],
        EN_MARCHA: ["Reemplazo automático activo", "CONFIRMADA"],
        SIN_TESTIGO: ["Testigo sin conexión", "PENDIENTE"],
        ACTIVANDO: ["Copiando los datos iniciales", "PENDIENTE"],
        SIN_MAYORIA: ["Esperando una mayoría de PCs", "PENDIENTE"],
      };
      return estados[d.estado] || ["Revisar configuración", "PENDIENTE"];
    }
    function mostrar(d) {
      datos = d;
      var lista = (d.miembros || []).slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
      var nueva = JSON.stringify({ habilitado: d.habilitado, grupoId: d.grupoId, principal: d.principal, testigo: d.testigo, miembros: lista,
        escritor: d.escritor, degradado: d.degradado, estado: d.estado, puedeActivar: d.puedeActivar, manualActivo: d.manualActivo,
        puedePrepararTestigo: d.puedePrepararTestigo, puedePrepararRespaldo: d.puedePrepararRespaldo, modo: d.modo, mensaje: d.mensaje });
      if (huella !== nueva) {
        huella = nueva;
        var visible = estadoVisible(d);
        P.reemplazar(estado, P.chip(visible[0], visible[1]));
        pcServicio.textContent = (d.escritor && d.escritor.nombre) || (d.estado === "SIN_CONFIGURAR" && d.principal && d.principal.nombre) || "Esperando servidor";
        preferida.textContent = (d.principal && d.principal.nombre) || "Esta PC";
        pcTestigo.textContent = (d.testigo && (d.testigo.nombre || "PC de caja")) || "Pendiente de instalar";
        mensaje.hidden = !d.mensaje && d.estado !== "SIN_TESTIGO";
        if (!mensaje.hidden) P.reemplazar(mensaje, P.mensaje(d.mensaje || "Encendé la PC testigo y verificá que esté conectada a la red del predio.", d.estado === "SIN_TESTIGO" ? "aviso" : "info"));
        reducida.hidden = !d.degradado;
        retorno.hidden = !d.habilitado;
        var otras = lista.filter(function (m) { return !d.principal || m.id !== d.principal.id; });
        equipos.hidden = !otras.length; sinEquipos.hidden = !!otras.length;
        P.reemplazar(equipos, otras.map(function (m) {
          var atendiendo = d.escritor && m.id === d.escritor.id;
          var texto = atendiendo ? "En servicio" : m.retirando ? "Baja pendiente" : d.estado === "PREPARANDO" ? "Incorporada" : m.actualizado === true ? "Copia actualizada" : m.actualizado === false ? "Actualizando copia" : "Esperando confirmación";
          var quitar = m.puedeQuitar && !m.retirando ? P.btn("Quitar respaldo", { tipo: "texto", chico: true, onclick: function () { quitarRespaldo(m, quitar); } }) : null;
          return h("li", h("div", h("strong", m.nombre || "PC de respaldo"), m.preferido ? h("div.texto-3.chico", "PC preferida") : null),
            h("div.fila", P.chip(texto, atendiendo || (m.actualizado === true && !m.retirando) ? "CONFIRMADA" : "PENDIENTE"), quitar));
        }));
      }
      problema.hidden = true;
      actualizarControles();
    }
    function cargar() {
      if (cerrado || consultando || activando) return Promise.resolve();
      consultando = true; actualizarControles();
      return P.get("/sistema/grupo-local", { sinRedireccion: true }).then(function (d) { if (!cerrado) mostrar(d); })
        .catch(function (e) {
          if (cerrado) return;
          problema.hidden = false;
          P.reemplazar(problema, P.mensaje(e.message || "No se pudo consultar el estado de las PCs.", "error"));
        }).finally(function () { consultando = false; if (!cerrado) actualizarControles(); });
    }
    function esperarReinicio(intento) {
      if (cerrado) return;
      reinicio = setTimeout(function () {
        P.get("/sistema/grupo-local", { sinRedireccion: true }).then(function (d) {
          if (cerrado) return;
          if (d.estado !== "EN_MARCHA" && d.estado !== "SIN_TESTIGO") throw new Error("El servidor todavía está preparando el reemplazo");
          activando = false; mostrar(d);
          aviso.textContent = d.modo === "manual" ? "El relevo manual está preparado. La caja recibe una copia de cada venta confirmada."
            : d.estado === "EN_MARCHA" ? "El reemplazo automático está activo. Mantené encendida la PC testigo." : "El servidor volvió. Encendé la PC testigo para habilitar el reemplazo automático.";
          aviso.hidden = false;
        }).catch(function () {
          if (cerrado) return;
          if (intento < 29) { esperarReinicio(intento + 1); return; }
          activando = false; huella = null;
          aviso.textContent = "El servidor todavía no responde. Revisá que las PCs estén encendidas y usá «Actualizar estado» cuando vuelva a estar disponible.";
          aviso.hidden = false; actualizarControles();
        });
      }, 2000);
    }
    function activarGrupo(manual) {
      manual = manual === true;
      if (cerrado || confirmando || trabajando || activando || !datos || !(manual ? datos.puedeConfigurarManual : datos.puedeActivar)) return;
      confirmando = true; actualizarControles();
      P.confirmar(manual ? "La principal se reiniciará después de enviar la copia inicial a la caja. A partir de ahí, cada venta normal se confirma cuando las dos PCs guardaron los datos."
        : "El servidor se reiniciará y las cajas tendrán una interrupción breve. Mantené encendida y conectada a la red la PC que cumple la función de testigo.", {
        titulo: manual ? "¿Configurar el relevo manual?" : "¿Activar el reemplazo automático?", aceptar: "Activar y reiniciar",
      }).then(function (ok) {
        confirmando = false;
        if (!ok || cerrado) { if (!cerrado) actualizarControles(); return; }
        activando = true; actualizarControles();
        P.ejecutar(manual ? configurarManual : activar, function () {
          return P.post(manual ? "/sistema/grupo-local/configurar-relevo-manual" : "/sistema/grupo-local/activar", {}).then(function () {
            if (cerrado) return;
            P.reemplazar(estado, P.chip("Esperando el reinicio", "PENDIENTE"));
            aviso.textContent = "Activación solicitada. Esperando que el servidor vuelva a responder…";
            aviso.hidden = false; esperarReinicio(0);
          });
        }).catch(function (e) {
          if (cerrado) return;
          if (!e.status || e.codigo === "RESULTADO_INCIERTO") {
            aviso.textContent = "Comprobando si el servidor terminó la activación…"; aviso.hidden = false; esperarReinicio(0);
          } else { activando = false; actualizarControles(); }
        }).finally(function () { if (!cerrado) actualizarControles(); });
      }).catch(function (e) { confirmando = false; if (!cerrado) { actualizarControles(); P.error(e); } });
    }
    P.alSalir(function () { cerrado = true; clearTimeout(reinicio); });
    P.intervalo(function () { return cargar(); }, 30000);
    actualizarControles(); cargar();
    return panel;
  };
})();
