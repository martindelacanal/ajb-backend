# Integridad financiera e histórica

Los comandos están separados deliberadamente:

- `verificar-integridad-financiera.js`: auditoría exclusivamente de lectura;
- `migrar-integridad-financiera.js`: migración idempotente de esquema, dry-run por defecto;
- `corregir-doble-adicional-reservas.js`: corrección monetaria por manifiesto aprobado, dry-run por defecto;
- `configurar-usuario-runtime.js`: provisión de una cuenta de aplicación con privilegios mínimos.

Los scripts cargan `BACKEND/.env`, admiten TLS verificable mediante
`DB_SSL_MODE=verify-ca|verify-full` y `DB_SSL_CA_PATH`, y no imprimen
credenciales. Ningún comando escribe sin `--apply` y confirmación literal.

## Orden seguro

Detener la API durante la migración y la corrección. Hacer primero un backup
completo y comprobar su restauración.

```powershell
Set-Location "C:\Users\marti\Desktop\TRABAJO\PROYECTOS\AJB\BACKEND"

# 1. Preflight y estado actual, sólo lectura.
node scripts/verificar-integridad-financiera.js --json

# 2. Plan de DDL/DML, sin cambios.
node scripts/migrar-integridad-financiera.js

# 3. Migración explícita.
node scripts/migrar-integridad-financiera.js --apply --confirm=APLICAR_INTEGRIDAD_FINANCIERA

# 4. Debe finalizar con registro, checksum y contrato exacto en OK.
node scripts/verificar-integridad-financiera.js --require-migrated --json

# 5. Generar el manifiesto de la base concreta, siempre de nuevo en cada ambiente.
node scripts/corregir-doble-adicional-reservas.js

# 6. Copiar literalmente el SHA-256 emitido por el paso anterior.
node scripts/corregir-doble-adicional-reservas.js --apply `
  --confirm=CORREGIR_DOBLE_ADICIONAL `
  --manifest-sha256=<SHA256_DEL_DRY_RUN>
```

En `NODE_ENV=production`, los dos comandos con escritura exigen además
`--allow-production`. El manifiesto local no se puede reutilizar en producción:
los IDs y cualquier dato pueden diferir aunque la cantidad de filas coincida.

Después de migrar y antes de arrancar la API nueva, otorgar al usuario runtime
sólo `SELECT` e `INSERT` sobre `ajb_reserva_version_archivo`, y `SELECT`,
`INSERT`, `DELETE` sobre `ajb_reserva_mutacion_guard`. No debe tener `UPDATE` ni
`DELETE` sobre el archivo. El usuario de migración sí necesita DDL y privilegio
para crear triggers con el `DEFINER` elegido. Puede fijarse
`DB_TRIGGER_DEFINER=usuario@host`; si se omite, se registra `CURRENT_USER()`.

El configurador incluido crea una contraseña aleatoria, revoca cualquier grant
anterior, concede privilegios por tabla, prueba la conexión limitada y comprueba
que el archivo inmutable rechaza `UPDATE`. Nunca imprime la contraseña y cambia
`.env` sólo después de guardar las credenciales administrativas en una ruta
absoluta fuera del repositorio:

```powershell
# Vista previa, sólo lectura.
node scripts/configurar-usuario-runtime.js `
  --runtime-host=localhost,127.0.0.1

# Aplicación explícita. En producción usar la IP privada exacta de la API.
node scripts/configurar-usuario-runtime.js `
  --apply `
  --confirm=CONFIGURAR_USUARIO_RUNTIME `
  --runtime-user=miajb_runtime `
  --runtime-host=<HOST_ORIGEN_API> `
  --admin-env-backup=<RUTA_ABSOLUTA_SEGURA>

# Producción: además exige TLS verificable, CORS HTTPS exacto, NODE_ENV y un
# JWT de al menos 64 caracteres (lo rota sólo si el existente es débil).
node scripts/configurar-usuario-runtime.js `
  --apply `
  --confirm=CONFIGURAR_USUARIO_RUNTIME `
  --runtime-user=miajb_runtime `
  --runtime-host=<IP_PRIVADA_API> `
  --admin-env-backup=<RUTA_ABSOLUTA_SEGURA> `
  --production-hardening `
  --cors-origin=https://d2bnjhvusxwgza.cloudfront.net `
  --db-ca-path=/home/ubuntu/miajb-config/rds-global-bundle.pem
```

El verificador estricto inspecciona definiciones de triggers y por eso debe
ejecutarse con la cuenta de migración, no con la cuenta runtime deliberadamente
sin privilegio `TRIGGER`.

## Contratos aplicados

La revisión y el checksum esperados se definen una sola vez en
`integridad-financiera-common.js`. El verificador exige definiciones
canonicalizadas exactas de columnas, defaults, nulabilidad, columnas generadas,
índices, `CHECK`, claves foráneas, triggers, `DEFINER` y `SQL_MODE`; no considera
suficiente que un objeto sólo exista.

La migración:

1. comprueba MySQL 8.0.16+, modo estricto, tablas InnoDB, ausencia de NULL en
   columnas contractualmente obligatorias, rangos monetarios y duplicados;
2. convierte todos los importes de reservas y tarifas que aún eran `FLOAT` o
   `DECIMAL(10,2)` a `DECIMAL(12,2)`, sin redondear datos. Mantiene nullable sólo
   `reserva.precio_total`, porque una solicitud de convenio aún no cotizada usa
   `NULL` como “precio pendiente”, no como cero;
3. hace obligatorias fechas e IDs usados por las ecuaciones y relaciones; las
   columnas que participan en FK conservan exactamente su tipo, por lo que son
   compatibles con las referencias existentes;
4. agrega snapshots inmutables de tarifa a `reserva_familiar_tarifa`. El trigger
   de alta siempre lee la tarifa fuente y no acepta un precio suministrado como
   atajo. El legado sin fuente confiable queda explícitamente marcado;
5. crea `ajb_reserva_version_archivo`, append-only, y
   `ajb_reserva_mutacion_guard`. La edición general archiva dentro de la misma
   transacción una versión completa y canónica de la reserva, familiares,
   tarifas diarias, adicionales, detalles y dependencias antes del primer
   reemplazo. El checksum SHA-256 es reproducible. Un rollback revierte tanto el
   archivo como la guardia;
6. bloquea borrados de familiares, tarifas diarias, adicionales y detalles sin
   una guardia de la misma conexión. También protege el borrado de la cabecera,
   porque MySQL no ejecuta triggers hijos durante cascadas referenciales. Los
   cambios de precio/fechas de la cabecera y de precio familiar también exigen
   archivo previo; esto cubre edición general, propuesta de convenio, subsidio
   de salud y corrector controlado;
7. agrega restricciones numéricas y cronológicas, incluida
   `fin_inscripción <= inicio_olimpiada`, cobertura de coseguro mayor que cero y
   flag de duplicado limitado a `0/1`;
8. crea claims canónicos de comprobantes. Sólo participan solicitudes activas
   con `duplicado_forzado=0`. La excepción de staff se conserva, pero la API
   persiste el flag únicamente cuando el chequeo final bajo lock encontró un
   comprobante realmente duplicado; una coincidencia sólo de archivo no desactiva
   el claim;
9. agrega unicidad segura de inscripciones olímpicas validadas no eliminadas.

La DDL de MySQL hace commits implícitos. Por eso la migración registra cada
etapa en `ajb_schema_migration` y reanuda por introspección. Sólo marca una
migración como `FALLIDA` si esta ejecución alcanzó a registrarla como
`APLICANDO`; un preflight o checksum rechazado no degrada una migración ya
aplicada.

## Corrector por manifiesto

El dry-run usa una transacción de sólo lectura y busca reservas históricas
`FECHA_LIBRE` que cumplen **sin tolerancia**:

```text
precio_actual = suma_familiares + 2 * suma_adicionales
precio_nuevo  = suma_familiares + suma_adicionales
```

El manifiesto incluye ID, estado, modalidad, fechas, importes, cada adicional y
cada detalle. Antes de habilitar el hash valida también:

- `monto_adicionales = SUM(reserva_adicional.subtotal)`;
- subtotal del adicional = suma de sus detalles;
- subtotal del detalle = cantidad × precio unitario;
- cantidad y fechas cubren exactamente todas las noches de la reserva.

La aplicación obtiene primero un advisory lock, abre una transacción
`READ COMMITTED`, bloquea cabeceras y todas las filas de familiares/adicionales,
reconstruye el manifiesto y exige el mismo SHA-256. Luego guarda el manifiesto y
un checksum por fila en `ajb_reserva_precio_backup`, archiva la versión completa
anterior de cada reserva, registra el historial,
actualiza con comparación exacta de estado/fechas/importes y verifica antes del
commit. No presupone siete filas ni IDs iguales entre ambientes. En la copia
local auditada el manifiesto vigente contiene siete filas y un ajuste total de
`4636.00`; eso es evidencia local, no una condición de producción.

## Reversión

Preferir una migración hacia adelante. No reconvertir `DECIMAL` a `FLOAT` ni
eliminar snapshots o archivos históricos después de que la API los use.

Para revertir una corrección, hacerlo en una transacción separada y sólo cuando
el precio actual todavía coincide exactamente con `precio_total_nuevo` del
backup. Bloquear las reservas, registrar el historial inverso y restaurar
`precio_total_anterior`. Si una fila cambió, abortar y revisarla manualmente.
