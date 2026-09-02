#!/usr/bin/env node
"use strict";

// Datos de ejemplo de turismo para que el cliente pruebe el módulo completo
// (temporada baja "Primavera 2026", temporada alta "Verano 2027", un sorteo
// con inscripción abierta, bloques de venta directa, cupos de camping y
// adicionales por recurso) en los 4 servicios propios del catálogo.
//
// Idempotente: cada pieza lleva el marcador [AJB-CLIENTE-2026] en el nombre y
// se omite si ya existe. Los rangos de tarifa se recortan para no solaparse
// con las temporadas ya cargadas (mismo criterio que la pantalla de
// temporadas: nunca dos temporadas generales o de bloque activo sobre el
// mismo recurso y noche).
//
// Uso (dry-run por defecto):
//   DB_HOST=localhost DB_USER=root DB_PASSWORD=... DB_DATABASE=db_miajb node scripts/seed-turismo-cliente-2026.js
//   ... --apply --confirm=APLICAR_SEED_TURISMO_2026                 → escribe en develop
//   ... --apply --confirm=APLICAR_SEED_TURISMO_2026 --allow-production  → escribe en una base no local

require("dotenv").config();
const mysql = require("mysql2/promise");

const MARCADOR = "[AJB-CLIENTE-2026]";
const CONFIRMACION = "APLICAR_SEED_TURISMO_2026";
const args = process.argv.slice(2);
const aplicar = args.includes("--apply");
const permiteProduccion = args.includes("--allow-production");
const confirmacion = (args.find((arg) => arg.startsWith("--confirm=")) || "").slice("--confirm=".length);
const ADMIN_USUARIO_ID = 1;

// --- Definición de datos ------------------------------------------------------

const TIPOS_PERSONA = {
  AFILIADOS: 1,
  INVITADOS_FAMILIARES: 2,
  INVITADOS_GENERALES: 3,
  PRECIO_LISTA: 4,
  MENORES_2: 5,
};

const REGIMENES = { MEDIA_PENSION: 1, PENSION_COMPLETA: 2, UNICO: 3 };

// Descuento por tipo de persona sobre el precio de lista.
const PORCENTAJES_BAJA = { 1: 35, 2: 20, 3: 0, 4: 0, 5: 100 };
const PORCENTAJES_ALTA = { 1: 25, 2: 10, 3: 0, 4: 0, 5: 100 };

const ADICIONALES = [
  "Mascota",
  "Curso de yoga",
  "Cochera cubierta",
  "Ropa de cama y toallas",
  "Cuna para bebé",
  "Bicicleta (por día)",
  "Excursión guiada",
  "Desayuno buffet",
];

// Precio de lista por persona y noche (adulto) por servicio y régimen.
const SERVICIOS = [
  {
    codigo: "PARADOR_MONTANA",
    regimenes: [
      { id: REGIMENES.MEDIA_PENSION, baja: 55000, alta: 78000 },
      { id: REGIMENES.PENSION_COMPLETA, baja: 70000, alta: 98000 },
    ],
    adicionales: {
      "Cochera cubierta": 4000,
      "Ropa de cama y toallas": 6000,
      "Cuna para bebé": 2500,
      "Excursión guiada": 15000,
    },
  },
  {
    codigo: "HOTEL_SOLIS",
    regimenes: [{ id: REGIMENES.UNICO, baja: 42000, alta: 52000 }],
    adicionales: {
      "Cochera cubierta": 9000,
      "Desayuno buffet": 7500,
      "Cuna para bebé": 2500,
    },
  },
  {
    codigo: "MIRAMAR_CABANAS",
    regimenes: [{ id: REGIMENES.UNICO, baja: 48000, alta: 85000 }],
    // Los dormis (sin baño) valen menos que las cabañas.
    precioPorRecurso: (recurso) => (recurso.codigo.startsWith("MIR-DORMI") ? { baja: 30000, alta: 52000 } : null),
    adicionales: {
      Mascota: 5000,
      "Curso de yoga": 8000,
      "Ropa de cama y toallas": 6000,
      "Bicicleta (por día)": 4500,
    },
  },
  {
    codigo: "MIRAMAR_CAMPING",
    regimenes: [{ id: REGIMENES.UNICO, baja: 12000, alta: 18000 }],
    camping: { parcelasBaja: 60, parcelasAlta: 80 },
    adicionales: {
      Mascota: 3000,
      "Curso de yoga": 8000,
      "Cochera cubierta": 3500,
      "Bicicleta (por día)": 4500,
    },
  },
];

const TEMPORADA_BAJA = {
  nombre: `${MARCADOR} Primavera 2026`,
  inicio: "2026-09-08",
  fin: "2026-12-14",
  tipo: "baja",
};
const TEMPORADA_ALTA = {
  nombre: `${MARCADOR} Verano 2027`,
  inicio: "2026-12-15",
  fin: "2027-03-07",
  tipo: "alta",
};

const SORTEO = {
  nombre: `${MARCADOR} Sorteo Verano 2027 · 1ª quincena de enero`,
  descripcion: "Inscribite y participá por una semana en enero en Miramar o en el Parador de la Montaña. Se adjudica por sorteo al cierre de la inscripción.",
  inscripcionDesde: "2026-09-02",
  inscripcionHasta: "2026-10-31",
};

const BLOQUES = [
  {
    nombre: `${MARCADOR} Miramar · 1ª quincena de enero`,
    servicio: "MIRAMAR_CABANAS",
    modalidad: "SORTEO",
    inicio: "2027-01-02",
    fin: "2027-01-09",
    recursos: ["MIR-CAB-001", "MIR-CAB-002", "MIR-CAB-003", "MIR-CAB-004"],
    tipo: "alta",
  },
  {
    nombre: `${MARCADOR} Parador · 1ª quincena de enero`,
    servicio: "PARADOR_MONTANA",
    modalidad: "SORTEO",
    inicio: "2027-01-02",
    fin: "2027-01-09",
    recursos: ["PAR-CAB-005", "PAR-CAB-006", "PAR-CAB-007"],
    tipo: "alta",
  },
  {
    nombre: `${MARCADOR} Miramar · Carnaval 2027`,
    servicio: "MIRAMAR_CABANAS",
    modalidad: "BLOQUE",
    inicio: "2027-02-13",
    fin: "2027-02-17",
    recursos: ["MIR-CAB-005", "MIR-CAB-011-NUEVA", "MIR-CAB-012-NUEVA"],
    tipo: "alta",
  },
  {
    nombre: `${MARCADOR} Parador · Semana Santa 2027`,
    servicio: "PARADOR_MONTANA",
    modalidad: "BLOQUE",
    inicio: "2027-03-31",
    fin: "2027-04-05",
    recursos: ["PAR-CAB-008", "PAR-CAB-009", "PAR-CAB-010"],
    tipo: "alta",
  },
];

// --- Utilidades ---------------------------------------------------------------

function sumarDias(fecha, dias) {
  const [a, m, d] = fecha.split("-").map(Number);
  const utc = new Date(Date.UTC(a, m - 1, d) + dias * 86400000);
  return utc.toISOString().slice(0, 10);
}

function redondear(valor) {
  return Math.round(valor * 100) / 100;
}

/** Recorta [inicio, fin] quitando los tramos ocupados (inclusivos). */
function recortarRangos(inicio, fin, ocupados) {
  let libres = [{ inicio, fin }];
  for (const ocupado of ocupados) {
    const siguiente = [];
    for (const rango of libres) {
      if (ocupado.fin < rango.inicio || ocupado.inicio > rango.fin) {
        siguiente.push(rango);
        continue;
      }
      if (ocupado.inicio > rango.inicio) siguiente.push({ inicio: rango.inicio, fin: sumarDias(ocupado.inicio, -1) });
      if (ocupado.fin < rango.fin) siguiente.push({ inicio: sumarDias(ocupado.fin, 1), fin: rango.fin });
    }
    libres = siguiente;
  }
  return libres.filter((rango) => rango.inicio <= rango.fin);
}

function filasTarifaPersona({ recursoId, regimenId, temporadaId, rango, lista, porcentajes, parcelas }) {
  const filas = [];
  for (const tipoPersonaId of [1, 2, 3, 4]) {
    const porcentaje = porcentajes[tipoPersonaId] || 0;
    const usaPorcentaje = porcentaje > 0 ? 1 : 0;
    const precioAdulto = redondear(lista * (1 - porcentaje / 100));
    const precioNino = redondear(lista * 0.5 * (1 - porcentaje / 100));
    filas.push([recursoId, tipoPersonaId, regimenId, temporadaId, 6, null, precioAdulto, rango.inicio, rango.fin, "Y", usaPorcentaje, usaPorcentaje ? porcentaje : null, parcelas]);
    filas.push([recursoId, tipoPersonaId, regimenId, temporadaId, 2, 5, precioNino, rango.inicio, rango.fin, "Y", usaPorcentaje, usaPorcentaje ? porcentaje : null, parcelas]);
  }
  // Menores de 2 años: sin cargo.
  filas.push([recursoId, TIPOS_PERSONA.MENORES_2, regimenId, temporadaId, 0, 1, 0, rango.inicio, rango.fin, "Y", 1, 100, parcelas]);
  return filas;
}

async function main() {
  const host = process.env.DB_HOST || "localhost";
  const esLocal = ["localhost", "127.0.0.1"].includes(host);
  if (!esLocal && aplicar && !permiteProduccion) {
    throw new Error(`DB_HOST=${host} no es local: agregá --allow-production para escribir`);
  }
  if (aplicar && confirmacion !== CONFIRMACION) {
    throw new Error(`Para aplicar usá --confirm=${CONFIRMACION}`);
  }

  const connection = await mysql.createConnection({
    host,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    dateStrings: true,
  });

  const resumen = { temporadas: 0, tarifas: 0, adicionales: 0, tarifasAdicionales: 0, cupos: 0, sorteos: 0, bloques: 0, omitidos: [] };
  try {
    await connection.beginTransaction();

    // Catálogo
    const [serviciosRows] = await connection.query(
      `SELECT s.id, s.codigo, s.nombre, ts.codigo AS tipo_codigo
         FROM servicio s INNER JOIN tipo_servicio ts ON ts.id = s.tipo_servicio_id`
    );
    const serviciosPorCodigo = new Map(serviciosRows.map((row) => [row.codigo, row]));
    for (const definicion of SERVICIOS) {
      if (!serviciosPorCodigo.has(definicion.codigo)) throw new Error(`No existe el servicio ${definicion.codigo}`);
    }
    const [recursosRows] = await connection.query(
      "SELECT id, servicio_id, codigo, nombre, activo, es_recurso_principal FROM recurso ORDER BY servicio_id, orden, id"
    );
    const recursosPorServicio = new Map();
    const recursosPorCodigo = new Map();
    for (const recurso of recursosRows) {
      if (!recursosPorServicio.has(Number(recurso.servicio_id))) recursosPorServicio.set(Number(recurso.servicio_id), []);
      recursosPorServicio.get(Number(recurso.servicio_id)).push(recurso);
      recursosPorCodigo.set(`${recurso.servicio_id}:${recurso.codigo}`, recurso);
    }
    const [regimenesServicio] = await connection.query("SELECT servicio_id, regimen_id FROM servicio_regimen");
    const regimenesPorServicio = new Map();
    for (const fila of regimenesServicio) {
      if (!regimenesPorServicio.has(Number(fila.servicio_id))) regimenesPorServicio.set(Number(fila.servicio_id), new Set());
      regimenesPorServicio.get(Number(fila.servicio_id)).add(Number(fila.regimen_id));
    }
    const [tiposPersona] = await connection.query("SELECT id FROM tipo_persona");
    const tiposExistentes = new Set(tiposPersona.map((row) => Number(row.id)));
    for (const id of [1, 2, 3, 4, 5]) {
      if (!tiposExistentes.has(id)) throw new Error(`Falta el tipo de persona ${id}`);
    }

    // Adicionales
    const [adicionalesRows] = await connection.query("SELECT id, nombre FROM adicional");
    const adicionalesPorNombre = new Map(adicionalesRows.map((row) => [String(row.nombre).trim().toLowerCase(), Number(row.id)]));
    for (const nombre of ADICIONALES) {
      const clave = nombre.toLowerCase();
      if (adicionalesPorNombre.has(clave)) continue;
      const [resultado] = await connection.query("INSERT INTO adicional (nombre) VALUES (?)", [nombre]);
      adicionalesPorNombre.set(clave, Number(resultado.insertId));
      resumen.adicionales += 1;
    }

    // Tarifas existentes que no se pueden pisar (generales o de bloque activo)
    const [tarifasExistentes] = await connection.query(
      `SELECT t.recurso_id, t.regimen_id, t.fecha_inicio, t.fecha_fin, tt.nombre
         FROM tarifa t
         INNER JOIN temporada_tarifa tt ON tt.id = t.temporada_tarifa_id
        WHERE t.fecha_fin >= '2026-09-01'
          AND (COALESCE(tt.origen, 'GENERAL') = 'GENERAL'
               OR EXISTS (SELECT 1 FROM bloque_fecha bf WHERE bf.temporada_tarifa_id = tt.id AND bf.estado = 'ACTIVO'))`
    );
    const ocupadosPorRecurso = new Map();
    for (const fila of tarifasExistentes) {
      const clave = Number(fila.recurso_id);
      if (!ocupadosPorRecurso.has(clave)) ocupadosPorRecurso.set(clave, []);
      ocupadosPorRecurso.get(clave).push({ inicio: fila.fecha_inicio, fin: fila.fecha_fin, nombre: fila.nombre });
    }

    const [temporadasExistentes] = await connection.query("SELECT id, nombre FROM temporada_tarifa WHERE nombre LIKE ?", [`${MARCADOR}%`]);
    const temporadasPorNombre = new Map(temporadasExistentes.map((row) => [row.nombre, Number(row.id)]));

    // Bloques → sus rangos quedan fuera de la temporada general de sus recursos.
    const rangosBloquePorRecurso = new Map();
    for (const bloque of BLOQUES) {
      const servicio = serviciosPorCodigo.get(bloque.servicio);
      for (const codigo of bloque.recursos) {
        const recurso = recursosPorCodigo.get(`${servicio.id}:${codigo}`);
        if (!recurso) throw new Error(`No existe el recurso ${codigo} en ${bloque.servicio}`);
        if (!rangosBloquePorRecurso.has(Number(recurso.id))) rangosBloquePorRecurso.set(Number(recurso.id), []);
        rangosBloquePorRecurso.get(Number(recurso.id)).push({ inicio: bloque.inicio, fin: bloque.fin });
      }
    }

    async function crearTemporadaGeneral(definicionTemporada) {
      if (temporadasPorNombre.has(definicionTemporada.nombre)) {
        resumen.omitidos.push(`Temporada ya cargada: ${definicionTemporada.nombre}`);
        return temporadasPorNombre.get(definicionTemporada.nombre);
      }
      const porcentajes = definicionTemporada.tipo === "alta" ? PORCENTAJES_ALTA : PORCENTAJES_BAJA;
      const [resultado] = await connection.query(
        "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin, origen) VALUES (?, ?, ?, 'GENERAL')",
        [definicionTemporada.nombre, definicionTemporada.inicio, definicionTemporada.fin]
      );
      const temporadaId = Number(resultado.insertId);
      resumen.temporadas += 1;
      await connection.query(
        "INSERT INTO historial_temporada (temporada_id, usuario_id, operacion, campo_afectado, valor_anterior, valor_nuevo, fecha_cambio) VALUES (?, ?, 'CREATE', 'temporada', NULL, ?, NOW())",
        [temporadaId, ADMIN_USUARIO_ID, JSON.stringify({ nombre_campania: definicionTemporada.nombre, fecha_inicio: definicionTemporada.inicio, fecha_fin: definicionTemporada.fin, origen: "GENERAL", seed: MARCADOR })]
      );
      for (const [tipoPersonaId, porcentaje] of Object.entries(porcentajes)) {
        await connection.query(
          "INSERT INTO temporada_tipo_persona_porcentaje (temporada_tarifa_id, tipo_persona_id, porcentaje) VALUES (?, ?, ?)",
          [temporadaId, Number(tipoPersonaId), porcentaje]
        );
      }

      for (const definicion of SERVICIOS) {
        const servicio = serviciosPorCodigo.get(definicion.codigo);
        const recursos = (recursosPorServicio.get(Number(servicio.id)) || []).filter((recurso) => Number(recurso.activo) === 1);
        const regimenesValidos = regimenesPorServicio.get(Number(servicio.id)) || new Set();
        const esCamping = servicio.tipo_codigo === "CUPO_NUMERADO";
        const parcelas = esCamping
          ? (definicionTemporada.tipo === "alta" ? definicion.camping.parcelasAlta : definicion.camping.parcelasBaja)
          : null;
        for (const recurso of recursos) {
          if (esCamping && Number(recurso.es_recurso_principal) !== 1) continue;
          const ocupados = [
            ...(ocupadosPorRecurso.get(Number(recurso.id)) || []),
            ...(rangosBloquePorRecurso.get(Number(recurso.id)) || []),
          ];
          const rangos = recortarRangos(definicionTemporada.inicio, definicionTemporada.fin, ocupados);
          if (rangos.length === 0) {
            resumen.omitidos.push(`${definicionTemporada.nombre}: ${recurso.nombre} ya tiene precios en todo el período`);
            continue;
          }
          for (const regimen of definicion.regimenes) {
            if (!regimenesValidos.has(regimen.id)) throw new Error(`El régimen ${regimen.id} no pertenece a ${definicion.codigo}`);
            const precioRecurso = definicion.precioPorRecurso ? definicion.precioPorRecurso(recurso) : null;
            const lista = (precioRecurso || regimen)[definicionTemporada.tipo];
            for (const rango of rangos) {
              const filas = filasTarifaPersona({
                recursoId: recurso.id,
                regimenId: regimen.id,
                temporadaId,
                rango,
                lista,
                porcentajes,
                parcelas,
              });
              await connection.query(
                `INSERT INTO tarifa (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id, edad_minima, edad_maxima,
                   precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
                 VALUES ?`,
                [filas]
              );
              resumen.tarifas += filas.length;
              const factorAdicional = definicionTemporada.tipo === "alta" ? 1.3 : 1;
              const filasAdicionales = Object.entries(definicion.adicionales).map(([nombre, precio]) => [
                temporadaId, recurso.id, regimen.id, adicionalesPorNombre.get(nombre.toLowerCase()),
                rango.inicio, rango.fin, redondear(precio * factorAdicional), 1,
              ]);
              if (filasAdicionales.some((fila) => !fila[3])) throw new Error("Adicional no resuelto");
              await connection.query(
                `INSERT INTO tarifa_adicional (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio, activo)
                 VALUES ?`,
                [filasAdicionales]
              );
              resumen.tarifasAdicionales += filasAdicionales.length;
            }
          }
          // Cupos del camping para los mismos tramos.
          if (esCamping) {
            for (const rango of rangos) {
              const [cuposSolapados] = await connection.query(
                `SELECT id FROM recurso_cupo_periodo WHERE recurso_id = ? AND activo = 1 AND fecha_inicio <= ? AND fecha_fin >= ? LIMIT 1`,
                [recurso.id, rango.fin, rango.inicio]
              );
              if (cuposSolapados.length) {
                resumen.omitidos.push(`Cupo ya existente para ${recurso.nombre} en ${rango.inicio}..${rango.fin}`);
                continue;
              }
              await connection.query(
                "INSERT INTO recurso_cupo_periodo (recurso_id, fecha_inicio, fecha_fin, cupo_total, activo) VALUES (?, ?, ?, ?, 1)",
                [recurso.id, rango.inicio, rango.fin, parcelas]
              );
              resumen.cupos += 1;
            }
          }
        }
      }
      return temporadaId;
    }

    await crearTemporadaGeneral(TEMPORADA_BAJA);
    await crearTemporadaGeneral(TEMPORADA_ALTA);

    // Sorteo
    const [sorteosExistentes] = await connection.query("SELECT id FROM sorteo WHERE nombre = ? LIMIT 1", [SORTEO.nombre]);
    let sorteoId = sorteosExistentes[0] ? Number(sorteosExistentes[0].id) : null;
    if (!sorteoId) {
      const [resultado] = await connection.query(
        "INSERT INTO sorteo (nombre, descripcion, fecha_inicio_inscripcion, fecha_fin_inscripcion, estado) VALUES (?, ?, ?, ?, 'ACTIVO')",
        [SORTEO.nombre, SORTEO.descripcion, SORTEO.inscripcionDesde, SORTEO.inscripcionHasta]
      );
      sorteoId = Number(resultado.insertId);
      resumen.sorteos += 1;
    } else {
      resumen.omitidos.push(`Sorteo ya cargado: ${SORTEO.nombre}`);
    }

    // Bloques (cada uno con su temporada de origen BLOQUE)
    for (const bloque of BLOQUES) {
      const [bloquesExistentes] = await connection.query("SELECT id FROM bloque_fecha WHERE nombre = ? LIMIT 1", [bloque.nombre]);
      if (bloquesExistentes.length) {
        resumen.omitidos.push(`Bloque ya cargado: ${bloque.nombre}`);
        continue;
      }
      const servicio = serviciosPorCodigo.get(bloque.servicio);
      const definicion = SERVICIOS.find((item) => item.codigo === bloque.servicio);
      const recursos = bloque.recursos.map((codigo) => recursosPorCodigo.get(`${servicio.id}:${codigo}`));
      // Un recurso no puede estar en dos bloques activos que se solapen.
      const [solapados] = await connection.query(
        `SELECT bf.nombre FROM bloque_fecha_recurso bfr INNER JOIN bloque_fecha bf ON bf.id = bfr.bloque_fecha_id
          WHERE bfr.recurso_id IN (?) AND bf.estado = 'ACTIVO' AND bf.fecha_inicio < ? AND bf.fecha_fin > ? LIMIT 1`,
        [recursos.map((recurso) => recurso.id), bloque.fin, bloque.inicio]
      );
      if (solapados.length) {
        resumen.omitidos.push(`Bloque ${bloque.nombre} omitido: recursos ya en "${solapados[0].nombre}"`);
        continue;
      }
      const porcentajes = bloque.tipo === "alta" ? PORCENTAJES_ALTA : PORCENTAJES_BAJA;
      const [temporadaResultado] = await connection.query(
        "INSERT INTO temporada_tarifa (nombre, fecha_inicio, fecha_fin, origen) VALUES (?, ?, ?, 'BLOQUE')",
        [`Bloque ${bloque.nombre}`.slice(0, 45), bloque.inicio, bloque.fin]
      );
      const temporadaBloqueId = Number(temporadaResultado.insertId);
      resumen.temporadas += 1;
      for (const [tipoPersonaId, porcentaje] of Object.entries(porcentajes)) {
        await connection.query(
          "INSERT INTO temporada_tipo_persona_porcentaje (temporada_tarifa_id, tipo_persona_id, porcentaje) VALUES (?, ?, ?)",
          [temporadaBloqueId, Number(tipoPersonaId), porcentaje]
        );
      }
      const rango = { inicio: bloque.inicio, fin: bloque.fin };
      for (const recurso of recursos) {
        for (const regimen of definicion.regimenes) {
          const precioRecurso = definicion.precioPorRecurso ? definicion.precioPorRecurso(recurso) : null;
          const lista = (precioRecurso || regimen)[bloque.tipo];
          const filas = filasTarifaPersona({ recursoId: recurso.id, regimenId: regimen.id, temporadaId: temporadaBloqueId, rango, lista, porcentajes, parcelas: null });
          await connection.query(
            `INSERT INTO tarifa (recurso_id, tipo_persona_id, regimen_id, temporada_tarifa_id, edad_minima, edad_maxima,
               precio, fecha_inicio, fecha_fin, precio_por_persona, usa_porcentaje, porcentaje_descuento, parcelas_disponibles)
             VALUES ?`,
            [filas]
          );
          resumen.tarifas += filas.length;
          const filasAdicionales = Object.entries(definicion.adicionales).map(([nombre, precio]) => [
            temporadaBloqueId, recurso.id, regimen.id, adicionalesPorNombre.get(nombre.toLowerCase()),
            rango.inicio, rango.fin, redondear(precio * 1.3), 1,
          ]);
          await connection.query(
            `INSERT INTO tarifa_adicional (temporada_tarifa_id, recurso_id, regimen_id, adicional_id, fecha_inicio, fecha_fin, precio, activo)
             VALUES ?`,
            [filasAdicionales]
          );
          resumen.tarifasAdicionales += filasAdicionales.length;
        }
      }
      const [bloqueResultado] = await connection.query(
        `INSERT INTO bloque_fecha (sorteo_id, servicio_id, temporada_tarifa_id, nombre, modalidad, fecha_inicio, fecha_fin, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVO')`,
        [bloque.modalidad === "SORTEO" ? sorteoId : null, servicio.id, temporadaBloqueId, bloque.nombre, bloque.modalidad, bloque.inicio, bloque.fin]
      );
      for (const recurso of recursos) {
        await connection.query(
          "INSERT INTO bloque_fecha_recurso (bloque_fecha_id, recurso_id, estado) VALUES (?, ?, ?)",
          [bloqueResultado.insertId, recurso.id, bloque.modalidad === "SORTEO" ? "SORTEO" : "DISPONIBLE"]
        );
      }
      resumen.bloques += 1;
    }

    // Verificación: ninguna tarifa general/bloque activo duplicada por recurso, régimen, tipo, edad y noche.
    const [ambiguas] = await connection.query(
      `SELECT t1.recurso_id, t1.regimen_id, t1.tipo_persona_id, t1.fecha_inicio, t2.fecha_inicio AS otra
         FROM tarifa t1
         INNER JOIN tarifa t2 ON t2.id > t1.id AND t2.recurso_id = t1.recurso_id AND t2.regimen_id = t1.regimen_id
              AND t2.tipo_persona_id = t1.tipo_persona_id
              AND COALESCE(t2.edad_minima, -1) = COALESCE(t1.edad_minima, -1)
              AND COALESCE(t2.edad_maxima, 999) = COALESCE(t1.edad_maxima, 999)
              AND t2.fecha_inicio <= t1.fecha_fin AND t2.fecha_fin >= t1.fecha_inicio
         INNER JOIN temporada_tarifa tt1 ON tt1.id = t1.temporada_tarifa_id
         INNER JOIN temporada_tarifa tt2 ON tt2.id = t2.temporada_tarifa_id
        WHERE t1.fecha_fin >= '2026-09-01'
          AND COALESCE(tt1.origen, 'GENERAL') = 'GENERAL' AND COALESCE(tt2.origen, 'GENERAL') = 'GENERAL'
        LIMIT 5`
    );
    if (ambiguas.length) {
      throw new Error(`Quedarían tarifas generales solapadas: ${JSON.stringify(ambiguas)}`);
    }

    console.log(JSON.stringify({ target: host, aplicar, resumen }, null, 2));
    if (aplicar) {
      await connection.commit();
      console.log("Seed aplicado.");
    } else {
      await connection.rollback();
      console.log("Dry-run: no se escribió nada (usá --apply --confirm=... para aplicar).");
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
