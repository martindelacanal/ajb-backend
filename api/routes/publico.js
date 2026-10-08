"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// PORTADA PÚBLICA · consultas sin sesión (/api/publico/*)
// El visitante puede recorrer turismo, salud, subsidios, beneficios y las sedes
// sin iniciar sesión; para reservar o pedir algo el front le pide el login.
// Sólo lectura y sólo campos no sensibles: los mapeos de services/publico.js y
// services/turismo-placas.js arman cada respuesta campo por campo.
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const mysqlConnection = require("../connection/connection");
const { registrarErrorRuta } = require("../services/errores");
const { construirVisibilidadServicioSql, normalizarIdPositivo } = require("../services/turismo-catalogo");
const {
  CABECERA_PUBLICA,
  CONDICION_BENEFICIO_PUBLICO,
  CONDICION_VIAJE_PUBLICO,
  MAX_BENEFICIOS_PUBLICOS,
  MAX_IMAGENES_POR_ITEM,
  TIPOS_SERVICIO_RESERVABLES,
  agruparPor,
  mapearAlojamientoSalud,
  mapearBeneficioPublico,
  mapearConvenioPublico,
  mapearDepartamentalPublica,
  mapearRubroPublico,
  mapearServicioPublico,
  mapearTipoReintegroPublico,
  mapearViajePublico,
  normalizarBusqueda,
} = require("../services/publico");
const { MAX_PLACAS_PUBLICAS, mapearPlacaPublica } = require("../services/turismo-placas");

const router = express.Router();

// ── S3 ─────────────────────────────────────────────────────────────────────
const s3SignedUrlExpiresConfigurado = Number(process.env.S3_SIGNED_URL_EXPIRES_SECONDS || "3600");
const S3_SIGNED_URL_EXPIRES_SECONDS = Number.isSafeInteger(s3SignedUrlExpiresConfigurado)
  && s3SignedUrlExpiresConfigurado >= 60
  && s3SignedUrlExpiresConfigurado <= 86400
  ? s3SignedUrlExpiresConfigurado
  : 3600;

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  region: process.env.BUCKET_REGION,
});

// Firma tolerante: una key rota nunca tumba un listado
async function firmarSeguro(key) {
  if (!key) return null;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }),
      { expiresIn: S3_SIGNED_URL_EXPIRES_SECONDS }
    );
  } catch (error) {
    console.error("No se pudo firmar una imagen pública", { key, code: error?.name || error?.code });
    return null;
  }
}

async function firmarLista(keys) {
  const firmadas = await Promise.all((keys || []).map((key) => firmarSeguro(key)));
  return firmadas.filter(Boolean);
}

// Mismo criterio que habilitarCachePublica de noticias.js (sin CDN propio): caché
// corta, porque las URLs de S3 vienen firmadas y vencen.
function habilitarCachePublica(res) {
  res.removeHeader("Pragma");
  res.set("Cache-Control", "public, max-age=15, s-maxage=30, must-revalidate");
}

function marcadores(lista) {
  return lista.map(() => "?").join(",");
}

// ── Consultas compartidas ──────────────────────────────────────────────────

/** Alojamientos visibles con descuento por salud habilitado (reservables por el sistema). */
async function obtenerAlojamientoSalud(db) {
  const visibilidad = construirVisibilidadServicioSql(CABECERA_PUBLICA, "s");
  const [filas] = await db.query(
    `SELECT s.id, s.nombre, s.lugar
       FROM servicio s
       INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id AND ts.activo = 1
      WHERE ${visibilidad.sql}
        AND ts.codigo IN (${marcadores(TIPOS_SERVICIO_RESERVABLES)})
        AND s.descuento_salud_estado = 'HABILITADO'
      ORDER BY s.orden ASC, s.nombre ASC`,
    [...visibilidad.params, ...TIPOS_SERVICIO_RESERVABLES]
  );
  return filas.map(mapearAlojamientoSalud);
}

async function obtenerTiposReintegro(db, { soloSubsidios = false } = {}) {
  const [filas] = await db.query(
    `SELECT t.id, t.nombre, t.icono, t.modo_cobertura, t.porcentaje_cobertura, t.tope_reintegro,
            t.es_subsidio, CAST(t.adjuntos_config AS CHAR) AS adjuntos_config
       FROM coseguro_tipo_reintegro t
      WHERE t.activo = 1${soloSubsidios ? " AND t.es_subsidio = 1" : ""}
      ORDER BY t.orden ASC, t.id ASC`
  );
  return filas.map(mapearTipoReintegroPublico);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /publico/turismo — alojamientos, convenios hoteleros y lugares
// ─────────────────────────────────────────────────────────────────────────────
router.get("/publico/turismo", async (_req, res) => {
  try {
    const db = mysqlConnection.promise();
    const visibilidad = construirVisibilidadServicioSql(CABECERA_PUBLICA, "s");

    const [servicios] = await db.query(
      `SELECT s.id, s.nombre, s.lugar, s.descripcion, ts.codigo AS tipo_codigo
         FROM servicio s
         INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id AND ts.activo = 1
        WHERE ${visibilidad.sql} AND ts.codigo IN (${marcadores(TIPOS_SERVICIO_RESERVABLES)})
        ORDER BY s.orden ASC, s.nombre ASC`,
      [...visibilidad.params, ...TIPOS_SERVICIO_RESERVABLES]
    );

    const [convenios] = await db.query(
      `SELECT ch.id, ch.servicio_id, ch.nombre, ch.ciudad, ch.provincia, ch.descripcion
         FROM convenio_hotel ch
         INNER JOIN servicio s ON s.id = ch.servicio_id
         INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id AND ts.codigo = 'CONVENIO_HOTELERO'
        WHERE ch.activo = 1 AND ${visibilidad.sql}
        ORDER BY ch.nombre ASC`,
      visibilidad.params
    );

    const [lugares] = await db.query(
      `SELECT lugar
         FROM (
           SELECT s.lugar FROM servicio s INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id
            WHERE ${visibilidad.sql} AND ts.codigo <> 'CONVENIO_HOTELERO'
              AND s.lugar IS NOT NULL AND s.lugar <> ''
           UNION
           SELECT ch.ciudad AS lugar FROM convenio_hotel ch
            INNER JOIN servicio s ON s.id = ch.servicio_id
            WHERE ch.activo = 1 AND ${visibilidad.sql}
              AND ch.ciudad IS NOT NULL AND ch.ciudad <> ''
         ) lugares
        ORDER BY lugar ASC`,
      [...visibilidad.params, ...visibilidad.params]
    );

    // Galerías desde imagen_servicio: los convenios visibles siempre tienen servicio y
    // guardan ahí sus fotos (convenio_hotel_imagen sólo aplica a convenios sin servicio,
    // que la visibilidad ya deja afuera). Tope de 6 por ítem.
    const servicioIds = [...new Set([
      ...servicios.map((fila) => Number(fila.id)),
      ...convenios.map((fila) => Number(fila.servicio_id)).filter((id) => id > 0),
    ])];
    let imagenesPorServicio = new Map();
    if (servicioIds.length > 0) {
      const [imagenes] = await db.query(
        `SELECT servicio_id, archivo FROM imagen_servicio
          WHERE servicio_id IN (${marcadores(servicioIds)}) AND archivo IS NOT NULL AND archivo <> ''
          ORDER BY servicio_id ASC, id ASC`,
        servicioIds
      );
      imagenesPorServicio = agruparPor(imagenes, "servicio_id");
    }
    const keysDe = (filas) => (filas || []).slice(0, MAX_IMAGENES_POR_ITEM).map((fila) => fila.archivo);

    const serviciosSalida = await Promise.all(servicios.map(async (fila) => (
      mapearServicioPublico(fila, await firmarLista(keysDe(imagenesPorServicio.get(Number(fila.id)))))
    )));
    const conveniosSalida = await Promise.all(convenios.map(async (fila) => (
      mapearConvenioPublico(fila, await firmarLista(keysDe(imagenesPorServicio.get(Number(fila.servicio_id)))))
    )));

    habilitarCachePublica(res);
    res.status(200).json({
      servicios: serviciosSalida,
      convenios: conveniosSalida,
      lugares: lugares.map((fila) => fila.lugar),
    });
  } catch (error) {
    registrarErrorRuta(error, "publico:turismo");
    res.status(500).json("Error al obtener la información de turismo");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /publico/turismo/placas — carrusel de ofertas vigentes hoy
// ─────────────────────────────────────────────────────────────────────────────
router.get("/publico/turismo/placas", async (_req, res) => {
  try {
    const [filas] = await mysqlConnection.promise().query(
      `SELECT id, titulo, descripcion, imagen_archivo, imagen_ancho, imagen_alto,
              enlace_url, enlace_texto, vigencia_hasta
         FROM turismo_placa
        WHERE eliminado = 0 AND publicado = 1
          AND (vigencia_desde IS NULL OR vigencia_desde <= CURDATE())
          AND (vigencia_hasta IS NULL OR vigencia_hasta >= CURDATE())
        ORDER BY orden ASC, id ASC
        LIMIT ${MAX_PLACAS_PUBLICAS}`
    );
    const placas = await Promise.all(filas.map(async (fila) => (
      mapearPlacaPublica(fila, await firmarSeguro(fila.imagen_archivo))
    )));
    habilitarCachePublica(res);
    res.status(200).json(placas);
  } catch (error) {
    registrarErrorRuta(error, "publico:turismo-placas");
    res.status(500).json("Error al obtener las ofertas de turismo");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /publico/salud — tipos de reintegro con requisitos + alojamiento por salud
// ─────────────────────────────────────────────────────────────────────────────
router.get("/publico/salud", async (_req, res) => {
  try {
    const db = mysqlConnection.promise();
    const tipos = await obtenerTiposReintegro(db);
    const alojamientoSalud = await obtenerAlojamientoSalud(db);
    habilitarCachePublica(res);
    res.status(200).json({ tipos, alojamiento_salud: alojamientoSalud });
  } catch (error) {
    registrarErrorRuta(error, "publico:salud");
    res.status(500).json("Error al obtener la información de salud");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /publico/subsidios — viajes con descuento, obsequios y alojamiento por salud
// ─────────────────────────────────────────────────────────────────────────────
router.get("/publico/subsidios", async (_req, res) => {
  try {
    const db = mysqlConnection.promise();
    const [viajes] = await db.query(
      `SELECT dr.codigo, dr.nombre, dr.descripcion, dr.porcentaje_descuento, dr.requiere_comprobante
         FROM descuento_regla dr
        WHERE ${CONDICION_VIAJE_PUBLICO}
        ORDER BY dr.orden ASC, dr.nombre ASC`
    );
    const obsequios = await obtenerTiposReintegro(db, { soloSubsidios: true });
    const alojamientoSalud = await obtenerAlojamientoSalud(db);
    habilitarCachePublica(res);
    res.status(200).json({
      viajes: viajes.map(mapearViajePublico),
      obsequios,
      alojamiento_salud: alojamientoSalud,
    });
  } catch (error) {
    registrarErrorRuta(error, "publico:subsidios");
    res.status(500).json("Error al obtener los subsidios");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /publico/beneficios?rubro_id=&q= — vidriera pública (sin filtro departamental)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/publico/beneficios", async (req, res) => {
  try {
    const condiciones = [CONDICION_BENEFICIO_PUBLICO];
    const params = [];

    const busqueda = normalizarBusqueda(req.query.q);
    if (busqueda === undefined) return res.status(400).json("La búsqueda no es válida o es demasiado larga");
    if (busqueda) {
      condiciones.push("(b.nombre LIKE ? OR b.descripcion_corta LIKE ? OR r.nombre LIKE ?)");
      params.push(...Array(3).fill(`%${busqueda}%`));
    }
    const rubroInformado = req.query.rubro_id !== undefined && req.query.rubro_id !== null && String(req.query.rubro_id).trim() !== "";
    if (rubroInformado) {
      const rubroId = normalizarIdPositivo(req.query.rubro_id);
      if (!rubroId) return res.status(400).json("El rubro no es válido");
      condiciones.push("b.rubro_id = ?");
      params.push(rubroId);
    }

    const db = mysqlConnection.promise();
    const [filas] = await db.query(
      `SELECT b.id, b.nombre, b.rubro_id, r.nombre AS rubro_nombre, b.descripcion_corta, b.promocion_html,
              b.logo_archivo, b.sitio_web, b.sitio_web_visible, b.fecha_vigencia_hasta, b.cupo_maximo,
              b.alcance_todas, b.mostrar_mapa
         FROM beneficio b
         INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
        WHERE ${condiciones.join(" AND ")}
        ORDER BY b.fecha_creacion DESC, b.id DESC
        LIMIT ${MAX_BENEFICIOS_PUBLICOS}`,
      params
    );

    const ids = filas.map((fila) => Number(fila.id));
    let imagenesPorBeneficio = new Map();
    let departamentalesPorBeneficio = new Map();
    let sucursalesPorBeneficio = new Map();
    if (ids.length > 0) {
      const [imagenes] = await db.query(
        `SELECT beneficio_id, archivo FROM beneficio_imagen
          WHERE beneficio_id IN (${marcadores(ids)})
          ORDER BY beneficio_id, orden, id`,
        ids
      );
      imagenesPorBeneficio = agruparPor(imagenes, "beneficio_id");

      const idsSegmentados = filas.filter((fila) => Number(fila.alcance_todas) !== 1).map((fila) => Number(fila.id));
      if (idsSegmentados.length > 0) {
        const [departamentales] = await db.query(
          `SELECT bd.beneficio_id, d.nombre
             FROM beneficio_departamental bd
             INNER JOIN departamental d ON d.id = bd.departamental_id
            WHERE bd.beneficio_id IN (${marcadores(idsSegmentados)})
            ORDER BY bd.beneficio_id, d.nombre COLLATE utf8mb4_es_0900_ai_ci`,
          idsSegmentados
        );
        departamentalesPorBeneficio = agruparPor(departamentales, "beneficio_id");
      }

      const idsConMapa = filas.filter((fila) => Number(fila.mostrar_mapa) === 1).map((fila) => Number(fila.id));
      if (idsConMapa.length > 0) {
        const [sucursales] = await db.query(
          `SELECT beneficio_id, direccion, latitud, longitud, etiqueta, imagen_archivo
             FROM beneficio_sucursal
            WHERE beneficio_id IN (${marcadores(idsConMapa)})
            ORDER BY beneficio_id, orden, id`,
          idsConMapa
        );
        sucursalesPorBeneficio = agruparPor(sucursales, "beneficio_id");
      }
    }

    const results = await Promise.all(filas.map(async (fila) => {
      const id = Number(fila.id);
      const primeraImagen = (imagenesPorBeneficio.get(id) || [])[0];
      const sucursales = await Promise.all((sucursalesPorBeneficio.get(id) || []).map(async (sucursal) => ({
        ...sucursal,
        imagen_url: await firmarSeguro(sucursal.imagen_archivo),
      })));
      return mapearBeneficioPublico(fila, {
        imagenUrl: await firmarSeguro(primeraImagen?.archivo),
        logoUrl: await firmarSeguro(fila.logo_archivo),
        departamentales: (departamentalesPorBeneficio.get(id) || []).map((dep) => dep.nombre),
        sucursales,
      });
    }));

    const [rubros] = await db.query(
      `SELECT r.id, r.nombre, COUNT(*) AS cantidad
         FROM beneficio b
         INNER JOIN beneficio_rubro r ON r.id = b.rubro_id
        WHERE ${CONDICION_BENEFICIO_PUBLICO}
        GROUP BY r.id, r.nombre
        ORDER BY r.nombre COLLATE utf8mb4_es_0900_ai_ci`
    );

    habilitarCachePublica(res);
    res.status(200).json({ results, rubros: rubros.map(mapearRubroPublico) });
  } catch (error) {
    registrarErrorRuta(error, "publico:beneficios");
    res.status(500).json("Error al obtener los beneficios");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /publico/departamentales — sedes habilitadas (sin "Provincia")
// ─────────────────────────────────────────────────────────────────────────────
router.get("/publico/departamentales", async (_req, res) => {
  try {
    const [filas] = await mysqlConnection.promise().query(
      `SELECT id, nombre, direccion, localidad
         FROM departamental
        WHERE habilitado = 'Y' AND nombre IS NOT NULL AND TRIM(nombre) <> 'Provincia'
        ORDER BY nombre COLLATE utf8mb4_es_0900_ai_ci ASC`
    );
    habilitarCachePublica(res);
    res.status(200).json(filas.map(mapearDepartamentalPublica));
  } catch (error) {
    registrarErrorRuta(error, "publico:departamentales");
    res.status(500).json("Error al obtener las departamentales");
  }
});

module.exports = router;
