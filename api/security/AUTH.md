# Sesiones y recuperación de acceso

La opción «Mantener sesión iniciada» guarda una credencial de renovación de 256 bits sin vencimiento calendario. El JWT de acceso dura 15 minutos; el cliente lo renueva automáticamente. No existe un JWT eterno: la credencial permanente se puede revocar. La sesión continúa entre visitas mientras el navegador conserve los datos del sitio, la cuenta siga habilitada y no se cierre sesión ni se cambie/recupere la contraseña. Borrar solo archivos de caché no borra necesariamente el almacenamiento del sitio. Sin recordar, el JWT y su registro de sesión vencen a las ocho horas y el cliente los conserva en sessionStorage.

Los JWT nuevos contienen un UUID de sesión y una huella HMAC de la contraseña. Cada petición HTTP vuelve a validar usuario, permisos, contraseña, revocación y registro de sesión. Socket.IO usa la misma validación en el handshake, antes de cada evento y cada 15 segundos durante conexiones inactivas. Los cambios de contraseña/habilitación por la edición centralizada también actualizan `usuario.auth_revocado_desde`, invalidando sesiones anteriores y JWT emitidos antes de esta implementación. Recuperar una cuenta revoca sus sesiones y elimina las passkeys anteriores; el usuario puede registrarlas nuevamente.

Las credenciales de renovación se guardan en MySQL únicamente como HMAC. Se rotan transaccionalmente y conservan un único predecesor, devolviendo el mismo sucesor a pestañas concurrentes. Durante los primeros 60 segundos no se vuelve a rotar la credencial actual. El frontend comparte una única renovación entre las peticiones de cada pestaña; entre pestañas, la rotación del servidor devuelve el mismo sucesor. Si la respuesta de una rotación A→B se pierde y el dispositivo queda sin conexión, A permite recuperar B incluso después de 60 segundos. Cuando B rota a C, A deja de ser válido. Este compromiso mantiene el acceso frente a respuestas perdidas: un predecesor robado también puede recuperar la credencial actual hasta esa siguiente rotación, y continúa sujeto a cierre y revocación de sesión. No se revoca automáticamente la sesión completa ante un predecesor ya descartado, para evitar que una petición antigua cierre otros navegadores legítimos.

El transporte de renovación continúa la arquitectura Bearer existente: body HTTPS y localStorage para recordar. Esto mantiene compatibilidad con el dominio CloudFront y los dominios propios, sin depender de cookies de terceros. Una vulnerabilidad XSS del frontend podría leer esa credencial; mantener CSP, escape de contenido y dependencias actualizadas es relevante. Nunca colocar JWT, códigos o credenciales de renovación en URL ni logs. Todos los endpoints `/api` responden `Cache-Control: no-store`.

## Contrato HTTP (prefijo `/api`)

- `POST /signin` conserva `{documento,password,recordar}`. Devuelve `{token,data,refreshToken?}`; la credencial de renovación existe solamente con recordar. WebAuthn devuelve el mismo contrato y obtiene recordar de su ceremonia previamente persistida.
- `POST /sesion/renovar` recibe `{refreshToken}` y devuelve `{token,data,refreshToken}`. Guardar el sucesor junto con el nuevo JWT. Un 401 invalida la sesión; un error transitorio 5xx no debe borrar credenciales.
- `POST /sesion/cerrar` recibe `{refreshToken?}` y/o Bearer. Revoca la sesión correspondiente y devuelve 204, incluso si ya estaba cerrada. Para sesiones sin recordar enviar su Bearer antes de borrar almacenamiento.
- `POST /auth/recuperacion/solicitar` recibe `{identificador}` (documento sin puntos o correo). Siempre responde 200 `{mensaje,reintentarEn:60}` para inexistente, deshabilitado, correo inválido/ambiguo o envío solicitado. Los límites generales pueden responder 429 con `Retry-After`.
- `POST /auth/recuperacion/verificar` recibe `{identificador,codigo}`. El código es un string de seis dígitos, incluidos ceros iniciales. Devuelve `{resetToken,venceEn:600}` o 400 con `{mensaje}` genérico. El código queda inutilizado después de una verificación exitosa.
- `POST /auth/recuperacion/restablecer` recibe `{resetToken,password}`. La contraseña requiere al menos 12 caracteres Unicode y como máximo 72 bytes UTF-8 (límite real de bcrypt). Devuelve `{mensaje}` y exige iniciar sesión nuevamente. No acepta el ticket como token de acceso.

## Recuperación y correo

Código generado con `crypto.randomInt`, seis dígitos, HMAC vinculado a cuenta, vigencia diez minutos, cinco errores máximos. El ticket posterior usa otros 256 bits, otro ámbito HMAC, diez minutos de vigencia y un único consumo. Código/ticket se vinculan a la contraseña y correo vigentes; cambiarlos invalida el proceso en curso. Las verificaciones y el cambio de contraseña usan locks y transacciones; bcrypt usa coste 12. Un correo compartido por varias cuentas no permite elegir una automáticamente; usar documento.

Los límites persisten en MySQL: solicitudes 12 por IP/hora, 5 por identificador/hora y 5 por cuenta/hora; verificaciones 40 por IP/15 min y 15 por identificador/15 min, además de los cinco errores del código; cambios 20 por IP/15 min. Un reenvío dentro de 60 segundos conserva el código anterior. Las claves del limitador son HMAC (sin IP/documento/correo legibles) y se eliminan gradualmente al vencer. Configurar `TRUST_PROXY` exclusivamente para el proxy real; el valor predeterminado es loopback.

La solicitud responde con el mismo texto y un mínimo de 350 ms antes de enviar SMTP, evitando exponer la existencia de la cuenta por la latencia del proveedor. No es una cola durable: si el proceso se reinicia justo después de responder, el usuario puede pedir otro código al terminar el cooldown. Un fallo SMTP invalida el código y deja un aviso operativo sin secretos. Para códigos de acceso el servicio de correo falla cerrado si hay `MAIL_TEST_MODE=true`, redirección, depuración SMTP o TLS no estricto. No se desvía nunca un código a otra casilla. `MAIL_SECURE=false` con TLS estricto exige STARTTLS.

## Despliegue y migración

Aplicar antes de arrancar este backend; la versión anterior tolera las tablas/columna adicionales. La migración es aditiva e idempotente, usa advisory lock y verifica columnas, motor e índices. No borra datos. Usa los bloques DEVELOP/PRODUCCION del archivo `.env`, igual que WebAuthn.

```sh
node scripts/migrar-auth-v1.js --apply --target=production --allow-production --confirm=APLICAR_AUTH --env-file=/ruta/segura/.env
node scripts/migrar-auth-v1.js --check --target=production --allow-production --env-file=/ruta/segura/.env
```

Para aplicar en desarrollo: `npm run migrate:auth:apply`. Exporta `aplicarMigracion(connection)` y `verificarEsquema(connection)` para runners con conexión administrativa existente. Requiere que `usuario` sea InnoDB y `usuario.id` INT con signo. Debe existir `webauthn_credencial` de la migración WebAuthn anterior.

Si el runtime usa permisos por tabla, otorgar desde una cuenta administrativa (adaptar base/host al despliegue):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON base.auth_sesion TO 'miajb_runtime'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON base.auth_recuperacion TO 'miajb_runtime'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON base.auth_limite TO 'miajb_runtime'@'%';
```

El runtime también necesita su permiso existente UPDATE sobre usuario y DELETE sobre webauthn_credencial. No necesita DDL. Usar el host ya configurado para la cuenta, no crear otra cuenta. Verificar los grants antes de reiniciar. No cambiar JWT_SECRET: hacerlo cerraría también los dispositivos recordados.

Mantenimiento opcional: depurar registros de `auth_sesion` revocados o vencidos hace más de 30 días y `auth_recuperacion` consumidos/vencidos con antigüedad de más de 30 días. No depurar sesiones activas con `vence_en IS NULL`. Los límites vencidos se limpian en la aplicación.

Socket.IO emite `sesion:expirada` al vencer JWT y `sesion:finalizada` al revocarse; el cliente puede renovar y reconectar solo el primero. Fallas de infraestructura cierran el transporte para permitir reconexión, sin emitir revocación.
