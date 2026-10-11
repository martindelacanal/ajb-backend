# Importación de nuevos afiliados

La tabla de usuarios permite importar archivos CSV UTF-8 o Excel `.xlsx` de una sola hoja, hasta 2 MB y 200 filas por lote. Los `.xls` deben guardarse como `.xlsx`. Pueden usarla admin, admin-central, auditor y departamental; este último solo puede dar altas en su propia sede. El servidor consulta los permisos actuales en la vista previa y en la confirmación.

## Plantilla

Columnas obligatorias: `nombre,apellido,documento,email,fecha_nacimiento`.

Columnas opcionales: `departamental` (nombre exacto o ID; también acepta `departamental_id`), `tipo_persona` (nombre o ID, predeterminado 1, afiliado titular), `telefono`, `legajo`, `direccion`, `dependencia_judicial`, `cuil`, `cbu`. Las sedes globales pueden elegir la departamental predeterminada fuera del archivo. Una sede indicada en una fila prevalece sobre ese valor; la persona departamental nunca puede importar fuera de su sede. No se admiten tipos familiares (2, 5), roles, contraseñas ni columnas de privilegios.

Fechas: `AAAA-MM-DD`, `DD/MM/AAAA` o celdas de fecha Excel. No se ejecutan ni se aceptan fórmulas. El lector Excel limita también la expansión real del ZIP a 25 MB antes de procesarlo. El CSV acepta coma, punto y coma o tabulación, con comillas y BOM UTF-8.

## API

`POST /api/usuarios/importacion/preview` recibe multipart `archivo` y `departamental_id` opcional. Devuelve `success`, `token`, `total`, `validos`, `errores` (cantidad de filas con errores) y `filas` con número de fila, datos normalizados y lista `errores` por fila. No escribe usuarios, historial ni correo. El token vence a los 15 minutos y está firmado para ese actor, archivo y selección de sede.

`POST /api/usuarios/importacion/confirmar` recibe el mismo archivo y selección, más `token` y `enviarBienvenida` (`true` o `false`). Devuelve HTTP 201 con `creados`, `emailsPendientes` y `emailsFallidos` (0 al encolar). Ante una validación que cambió desde la vista previa devuelve 409 y los detalles de filas. Se importa el lote completo o ninguno: no se actualizan usuarios existentes. DNI/email repetidos dentro del archivo o ya registrados bloquean el lote.

La confirmación toma un bloqueo de importación en MySQL y revalida bajo transacción con bloqueo de filas. Repetir la confirmación encuentra los DNI/emails ya registrados y no vuelve a crear usuarios ni correos. Una falla de historial o de encolado revierte el lote. Los correos elegidos se encolan en la misma transacción mediante `usuarios-bienvenida.encolarBienvenida`; el trabajador los envía después del commit.

Se crean cuentas habilitadas con rol fijo `afiliado` y una credencial inicial inutilizable y aleatoria de 44 caracteres (192 bits). No se guardan ni envían contraseñas temporales. La persona establece su contraseña mediante «Olvidé mi contraseña», tanto si recibió bienvenida como si el personal optó por no enviarla. No se exige un segundo cambio de clave después de la recuperación. La longitud diferente de 60 evita que bcryptjs trate el marcador como un hash y permite rechazar el acceso sin error interno.

## Migración y seguimiento de ingresos

Antes de desplegar el código, aplicar la migración que agrega `usuario.primer_ingreso`, `usuario.ultimo_ingreso` y la tabla `correo_bienvenida`. La migración es repetible y exige un bloqueo MySQL; `--check` solo verifica el esquema y falla si falta algún campo o la unicidad de bienvenida por usuario.

```sh
node scripts/migrar-usuarios-alta-v1.js --apply --target=develop --confirm=APLICAR_USUARIOS_ALTA
node scripts/migrar-usuarios-alta-v1.js --check --target=develop
node scripts/migrar-usuarios-alta-v1.js --apply --target=production --allow-production --confirm=APLICAR_USUARIOS_ALTA
node scripts/migrar-usuarios-alta-v1.js --check --target=production --allow-production
```

Las conexiones se leen de los bloques DEVELOP/PRODUCCION del `.env`, igual que las migraciones de autenticación. Se puede indicar `--env-file=/ruta/archivo.env`. No versionar credenciales.

Cada inicio de sesión correcto registra el primer ingreso, sin sobrescribirlo, y el último ingreso. La migración recupera evidencia previa de `auth_sesion` y del último uso de las credenciales WebAuthn. Un registro sin fecha significa **sin ingreso registrado**: no permite afirmar que una cuenta histórica nunca haya ingresado antes de que existiera esa evidencia. Las renovaciones silenciosas de sesión no cuentan como un nuevo ingreso.

`POST /api/tabla/usuarios` devuelve `email`, `primer_ingreso`, `ultimo_ingreso`, `estado_email` y `email_estado_detalle`. Admite `estado_ingreso=nunca|ingreso` y `estado_email=no_enviado|pendiente|enviado|entregado|rebotado|error|queja` en el cuerpo JSON. El valor API `nunca` selecciona cuentas sin primer ingreso registrado. Los filtros y los totales respetan el alcance departamental.

## Bienvenida y eventos de correo

El trabajador de `server.js` consulta la cola cada 15 segundos, toma hasta diez pendientes y usa un bloqueo MySQL para evitar envíos simultáneos entre procesos. Comprueba que el email siga siendo el declarado, que la cuenta esté habilitada y que no tenga bloqueo total antes de enviar. La plantilla explica cómo recibir el código de recuperación y elegir una contraseña personal; nunca contiene contraseñas.

El envío requiere SMTP configurado con `MAIL_ENABLED=true`, `MAIL_TEST_MODE=false`, `MAIL_REDIRECT_TO` vacío, `MAIL_TLS_ESTRICTO=true` y `MAIL_DEBUG=false`. Si esas condiciones dejan de cumplirse, los pendientes se conservan sin enviarse. Los errores SMTP quedan visibles como `error`; un envío interrumpido cuyo resultado no puede confirmarse tampoco se reintenta automáticamente, para evitar duplicados.

Para correlacionar eventos de Amazon SES con las bienvenidas:

```dotenv
MAIL_SES_CONFIGURATION_SET=miajb-envios
MAIL_SNS_TOPIC_ARN=arn:aws:sns:sa-east-1:337909740711:miajb-correo-eventos
```

Estos valores identifican los recursos previstos; deben coincidir con el configuration set y el topic reales del entorno. La configuración AWS y la suscripción son independientes del despliegue de código. En `sa-east-1`, suscribir el endpoint HTTPS `https://api.miajbpruebas.com.ar/api/correo/eventos-ses` al topic SNS, conservando la envoltura SNS (sin entrega de mensaje sin formato). El endpoint valida topic, firma SNS y origen del certificado antes de confirmar la suscripción. No hace falta autenticación de usuario en esta ruta.

El destino SES debe publicar Bounce y Complaint para registrar rebotes y quejas. El código también admite Delivery, Reject y Rendering Failure si el destino está configurado para publicarlos. Conservar los destinos y las suscripciones existentes: agregar tipos de eventos al mismo topic también los distribuye a sus otras suscripciones. Verificar las suscripciones confirmadas y los tipos efectivamente habilitados después de configurar AWS.

Cada bienvenida lleva la etiqueta SES `bienvenida_id`. El receptor correlaciona esa etiqueta o el identificador SES del mensaje con el destinatario; un identificador ya guardado debe coincidir. Las notificaciones repetidas o fuera de orden no revierten un rebote ni una queja. `enviado` significa aceptado por SMTP, mientras que `entregado` exige una confirmación Delivery de SES. Si falta la suscripción SNS o el tipo de evento, el sistema no puede inferir una entrega o un rebote a partir de la aceptación SMTP.

## Verificación

`node --test test/usuarios-importacion.test.js` prueba CSV y Excel reales, límites, fórmulas, permisos, ámbito, duplicados, modificación del archivo/token, vencimiento, reintentos y rollback de usuarios/historial/bienvenida. Usa una base simulada transaccional y transporte HTTP local; no accede a las bases operativas ni envía correo.

`node --test test/usuarios-bienvenida.test.js test/correo-eventos.test.js` verifica la cola y sus bloqueos, las restricciones SMTP, la migración repetible, el registro de ingresos, firmas SNS reales con claves de prueba, validación de certificados/topic/cuenta, confirmación de suscripción, correlación e idempotencia de eventos. No envía correo ni consulta AWS.

`node scripts/verificar-importacion-afiliados-integracion.js` verifica contra MySQL local con un esquema temporal aislado. Copia solo estructuras del bloque DEVELOP del `.env`, crea datos sintéticos y comprueba altas, historial, cola persistida, recuperación completa y rollback real. Rechaza servidores no locales, no inicia trabajadores ni envía correo, y elimina su esquema temporal al finalizar. Requiere la migración `migrar-usuarios-alta-v1` aplicada en la base local de referencia.
