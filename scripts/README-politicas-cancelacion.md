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

Se usan días calendario de Argentina, con rangos iniciales 0–6 días: 0%; 7–14: 50%; 15 o más: 100%. Las reservas anteriores sin aceptación registrada conservan la última política del servicio publicada antes de su fecha de creación en BD y registran `origen_politica: "HISTORICA_RESERVA_ANTERIOR"`; no se atribuye un consentimiento inexistente. Si la reserva precede todas las políticas, se aplica la primera registrada para el servicio. A igualdad de segundo entre reserva y publicación se prefiere la política anterior; publicaciones con la misma fecha desempatan por la menor versión e id. Si falta el historial o la fecha de creación de la reserva, la cotización se bloquea para revisión, sin aplicar una política nueva. Los snapshots aceptados y las cancelaciones registradas permanecen inmutables.

Permisos SQL mínimos del usuario de ejecución (además de los existentes):

- `politica_cancelacion`: SELECT, INSERT; sin UPDATE para runtime. La corrección inicial usa la cuenta de migración.
- `politica_cancelacion_vigente`: SELECT, UPDATE, para serializar publicaciones y conservar último ID global.
- `politica_cancelacion_servicio`: SELECT, INSERT.
- `politica_cancelacion_servicio_vigente`: SELECT, INSERT, UPDATE.
- `politica_cancelacion_autoria_auditoria`: SELECT; runtime no escribe correcciones.
- `reserva_politica_cancelacion` y `reserva_cancelacion_politica`: SELECT, INSERT.
- `reserva_politica_cancelacion_historica`: SELECT; sólo la migración congela condiciones históricas, sin registrar una aceptación.
- `politica_cancelacion_migracion`: sin permisos runtime.

La cuenta de migración necesita CREATE, ALTER, SELECT, INSERT y UPDATE para las tablas involucradas. Las nuevas columnas de importes no requieren grants adicionales cuando los permisos existentes se concedieron por tabla.

Pruebas focales: `node --test test/politica-cancelacion.test.js test/politica-cancelacion-rutas.test.js test/politica-cancelacion-migracion.test.js test/reservas-autorizacion-rutas.test.js`.

## Reinicio administrativo del historial (2026-10-15)

`node scripts/reiniciar-historial-politicas-cancelacion.js --check` inspecciona sin escribir. Para aplicar, usar `--apply --backup=RUTA_ABSOLUTA_NUEVA` y, si corresponde, `--allow-production`. El CLI usa exclusivamente las variables activas de `.env`. También se puede importar `ejecutarReinicio(connection, { checkOnly, backupPath, log })` con una conexión explícita a develop o producción; el módulo no carga `.env` al importarlo y toma/libera su propio advisory lock.

El reinicio conserva todas las políticas vigentes por servicio, sus IDs, reglas, título, motivo, autor y fecha. Cada política conservada pasa a versión 1: hospedajes y convenios pueden tener distintas condiciones iniciales con ese mismo número. Se reemplaza el índice único global de versión por un índice normal `(version, id)`. Las publicaciones posteriores siguen serializadas por el puntero global y usan `MAX(version) + 1`.

Se quitan las asignaciones que ya no están vigentes, las políticas sin servicios vigentes y las correcciones administrativas de autoría, con copia previa de las tablas involucradas y del índice de políticas. No se crean aceptaciones ficticias ni se modifican snapshots, versiones aceptadas o cancelaciones registradas. Si esos registros referencian una política que se eliminaría, el reinicio se detiene.

Para las reservas sin aceptación, compara las reglas que resuelve el historial actual con las del historial reducido. Cuando cambian, congela la política histórica y su servicio en `reserva_politica_cancelacion_historica`, siempre que el ID original se conserve; de lo contrario aborta para evitar romper una futura cancelación. Esa tabla tiene `reserva_id`, `snapshot_json` y `registrada_en`; no lleva usuario ni fecha de aceptación. El runtime consulta primero la aceptación y luego este snapshot, conservando el origen `HISTORICA_RESERVA_ANTERIOR`. Los snapshots históricos ya existentes se incluyen en el backup y se conservan. Los servicios que ya no tenían política y las reservas sin fecha conservan su situación.

Ejecutar con el backend detenido brevemente y una cuenta administrativa con SELECT, DELETE, UPDATE, INSERT, CREATE y ALTER sobre las tablas correspondientes. Otorgar SELECT al runtime sobre la nueva tabla histórica antes de reiniciar el backend. Mantener el backup fuera del repositorio y con acceso restringido. MySQL confirma DDL implícitamente; por eso la copia y validación preceden al cambio de índice y a la creación de la tabla histórica si falta. Los snapshots históricos nuevos, la eliminación y la renumeración ocurren en una transacción posterior. Esa segunda transacción vuelve a bloquear e inspeccionar los datos: si detecta actividad durante DDL, revierte los datos y exige un nuevo backup para reintentar. El esquema puede haber quedado migrado; ese estado intermedio es reanudable. La marca en `politica_cancelacion_migracion` impide repetir un reinicio completado y protege publicaciones futuras.

Después de aplicar, verificar que sólo queden políticas versión 1 y asignaciones vigentes, que sus reglas y metadatos coincidan con el backup y que aceptaciones/cancelaciones no hayan cambiado. Pruebas del reinicio: `node --test test/politica-cancelacion-reinicio.test.js`.

## Cancelar a pedido de la persona afiliada y constancia (2026-10-22)

Columnas y tabla nuevas en `scripts/migrar-firma-condiciones-reserva.js` (con GRANT al runtime sobre las tablas nuevas).

- Regla: cancelar a pedido da **el mismo resultado** que si la persona afiliada cancelara desde la app (misma política, cálculo, huella y liberaciones). Sólo se agrega quién lo cargó, cómo lo pidió y el motivo. La decisión propia de Turismo sigue siendo «Rechazar».
- `GET /reserva/:id/cancelacion-cotizacion`: también para admin y la departamental de la reserva (admin-central no). Agrega `regla: "POLITICA" | "SIN_FIRMA"`.
- `PUT /reserva/:id/estado` con `estado: "Cancelada"` del staff: exige `cancelacion_canal` (`PRESENCIAL` | `TELEFONO` | `ESCRITO`; 400 `CANCELACION_CANAL_REQUERIDO` / `CANCELACION_CANAL_INVALIDO`) y la huella; `observaciones` es el motivo (hasta 1000 caracteres, 400 `MOTIVO_DEMASIADO_LARGO`). Estados: Iniciada, Verificada, Aprobada, Pendiente_Aprobacion_Titular y «Pendiente de firma» (este último sin penalidad, `regla = SIN_FIRMA`, aunque haya pasado el ingreso; la solicitud de firma queda `CANCELADA`). Un staff sin canal no cancela (`CANCELACION_SIN_PEDIDO`). La persona afiliada cancela como siempre (se guarda `AFILIADO`/`APP`) y no puede cancelar una «Pendiente de firma» por esta vía.
- `reserva_cancelacion_politica` guarda `origen` (`AFILIADO` | `STAFF_A_PEDIDO`), `canal`, `cancelada_por_rol`, `motivo` y `regla`. El motivo de una cancelación ya no pisa `reserva.observaciones`.
- La departamental también puede «Rechazar» sus propias cargas «Verificada» (las creó un usuario departamental de su misma departamental: `reserva.creado_por_usuario_id`).
- Avisos: `RESERVA_CANCELADA_A_PEDIDO` (categoría «estados») a la persona afiliada con el reintegro y «Si no pediste esta cancelación, comunicate con tu departamental», a su titular si la reserva es de un familiar y a Turismo sin el autor. `RESERVA_VERIFICAR/APROBAR/RECHAZAR` van en «estados».
- `GET /reserva/:id/resumen` agrega `es_propietario`, `puede_cancelar_a_pedido`, `puede_rechazar` y `condiciones_cancelacion` (política, tramos con fechas reales de `calcularTramosCondiciones`, aceptación, firma, carga, solicitud de firma y constancia). `cancelacion` suma `origen`, `canal`, `motivo`, `regla` y `cancelada_por_rol`. Los nombres de personas (`aceptada_por_nombre`, `firmante_nombre`, `carga.nombre`, `cancelada_por_nombre`, autores de la constancia) sólo van al staff. Con una aceptación `CARGA_ADMINISTRATIVA`, `aceptacion.aceptada_por_rol` dice a todos el rol de quien la registró, que puede no ser quien cargó (una reserva enviada a firmar que otro firmó en pantalla).
- Constancia OPCIONAL (`api/routes/reserva-condiciones.js`, staff de Turismo con jurisdicción): `GET /reserva/:id/condiciones/constancia` devuelve el PDF A4 (409 si la reserva espera la firma o está cerrada); `POST /reserva/:id/condiciones/constancia-firmada` (multipart `archivos`, 1 a 3 por vez, hasta 5 vigentes, JPG/PNG/WebP/PDF de hasta 10 MB con control de bytes); `DELETE /reserva/:id/condiciones/constancia-firmada/:archivoId` es un borrado lógico (el objeto de S3 queda) que sólo hace quien la subió o un admin. Las dos dejan historial (`constancia_condiciones`). El recuadro del staff lleva el nombre de quien cargó la reserva, salvo que la firma telefónica la haya registrado otra persona: entonces dice «Firma y sello de quien registró la aceptación» con su nombre.

Pruebas: `node --test test/reservas-cancelacion-a-pedido.test.js test/reserva-condiciones.test.js`.
