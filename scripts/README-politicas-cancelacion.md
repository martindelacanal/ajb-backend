# Políticas de cancelación por servicio

Las publicaciones son versiones inmutables con reglas que cubren todos los días previos al ingreso. Cada publicación selecciona uno o varios servicios; los demás conservan su política vigente. Las reservas guardan el contenido aceptado, y una nueva publicación no lo modifica.

## Migración

`node scripts/migrar-politicas-cancelacion-servicios.js --check` sólo inspecciona. `--apply` aplica; un destino remoto requiere también `--allow-production`. El CLI usa las variables activas de `.env`: no interpreta bloques comentados de otros entornos. Verificar el host y el esquema antes de usarlo.

Para operar conexiones explícitas de develop/producción por separado, importar `ejecutarMigracion(connection, { checkOnly, log })`. El módulo no carga `.env` al importarlo. El operador debe tomar `GET_LOCK(MIGRATION_LOCK, 10)` y liberarlo en la misma conexión; el CLI ya lo hace. No ejecutar versiones distintas de migraciones simultáneamente.

La migración incluye la inicialización v1 si falta, crea las asignaciones y columnas de importes y asigna la política global actual a todos los servicios existentes (incluso inactivos). Un marcador transaccional evita resembrar o sobrescribir asignaciones al repetirla. Servicios creados después requieren publicación desde administración; la última política publicada para otros servicios no se hereda automáticamente.

Se resuelve el único usuario con rol `admin` y nombre `Nahuel`; una identidad ambigua o diferente impide continuar. La versión inicial sin autor recibe ese usuario mediante una corrección administrativa documentada en `politica_cancelacion_autoria_auditoria`, con ejecutor `MIGRACION`, autor anterior nulo, autor nuevo y fecha de corrección. El texto aclara que el registro inicial fue automático y que esta atribución no es una publicación realizada por Nahuel en la fecha original. No cambia reglas ni fecha original y no reemplaza una autoría existente de otra persona.

Las cancelaciones previas conservan sus datos originales. No se rellenan importes históricos con el precio actual de la reserva. La migración no modifica ni envía correos.

## Contrato HTTP

- `GET /turismo/politica-cancelacion?servicio_id=ID`: política vigente de ese servicio, incluyendo `servicio_id`; sin identidad del administrador ni motivo de auditoría. El servicio es obligatorio.
- `GET /admin/turismo/politicas-cancelacion`: `servicios`, `vigentes` e `historial`. Cada entrada histórica incluye servicios de aplicación original, `servicios_vigentes_ids`, autor y `correcciones_autoria`. `vigente` se conserva como última publicación para compatibilidad; no significa que aplique a todos los servicios.
- `POST /admin/turismo/politicas-cancelacion`: `{ servicios_ids, versiones_actuales: [{ servicio_id, version }], titulo, motivo, reglas }`. Debe incluir exactamente una versión por servicio seleccionado, o `null` si no tiene política. Una versión obsoleta devuelve `409 POLITICA_ACTUALIZADA`. Sólo administradores de Turismo pueden publicar/leer auditoría.
- Altas de reserva: mantienen `politica_cancelacion_aceptada: true`, `politica_cancelacion_id` y `politica_cancelacion_version`. El backend deriva el servicio del recurso, bloque o hotel autorizado; no acepta una política de otro servicio.
- `GET /reserva/:id/cancelacion-cotizacion`: devuelve porcentaje, `fecha_calculo` (y alias `fecha_actual`), fecha de ingreso, días previos, política y huella de confirmación. Agrega `monto_base`, `monto_reintegro`, `tipo_base: "TOTAL_RESERVA"`, `moneda: "ARS"`, `es_estimado: true`.
- `PUT /reserva/:id/estado`: al cancelar verifica nuevamente la huella e inserta cálculo y transición en la misma transacción. Fecha civil, estado, ingreso, reglas y montos forman parte de la huella.
- `GET /reserva/:id/resumen`: después de autorizar el acceso agrega `cancelacion` con fecha/hora real, fecha civil de cálculo, días, porcentaje, importes y política guardados. Nunca recalcula según el día de consulta. Sin registro devuelve `null`; un registro anterior sin montos devuelve montos nulos y `tipo_base: "NO_REGISTRADO_HISTORICO"`.

## Cálculo y límites

El reintegro es **estimado sobre el total neto de la reserva** (`reserva.precio_total`), que ya incluye adicionales y descuentos. No acredita dinero abonado ni inicia un pago. Usa centavos enteros y porcentajes con dos decimales, con redondeo al centavo más cercano (medio centavo hacia arriba). Base e importe resultante quedan congelados al confirmar la cancelación.

Se usan días calendario de Argentina, con rangos iniciales 0–6 días: 0%; 7–14: 50%; 15 o más: 100%. Las reservas anteriores sin aceptación registrada consultan la política vigente de su servicio y registran `origen_politica: "VIGENTE_RESERVA_ANTERIOR"`; no se atribuye un consentimiento inexistente.

Permisos SQL mínimos del usuario de ejecución (además de los existentes):

- `politica_cancelacion`: SELECT, INSERT; sin UPDATE para runtime. La corrección inicial usa la cuenta de migración.
- `politica_cancelacion_vigente`: SELECT, UPDATE, para serializar publicaciones y conservar último ID global.
- `politica_cancelacion_servicio`: SELECT, INSERT.
- `politica_cancelacion_servicio_vigente`: SELECT, INSERT, UPDATE.
- `politica_cancelacion_autoria_auditoria`: SELECT; runtime no escribe correcciones.
- `reserva_politica_cancelacion` y `reserva_cancelacion_politica`: SELECT, INSERT.
- `politica_cancelacion_migracion`: sin permisos runtime.

La cuenta de migración necesita CREATE, ALTER, SELECT, INSERT y UPDATE para las tablas involucradas. Las nuevas columnas de importes no requieren grants adicionales cuando los permisos existentes se concedieron por tabla.

Pruebas focales: `node --test test/politica-cancelacion.test.js test/politica-cancelacion-rutas.test.js test/politica-cancelacion-migracion.test.js test/reservas-autorizacion-rutas.test.js`.
