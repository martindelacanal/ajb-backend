# SES de pruebas y cambio al dominio definitivo

Decision actualizada el 28/08/2026: usar `miajbpruebas.com.ar`, cuyo registro inicio
Martin en NIC Argentina, con DNS en Route 53. No depender de cambios de Cesar o
Maxi para probar el nuevo sistema. `miajb.org.ar` sigue siendo el dominio final.

Este documento actualiza la estrategia de pruebas del brief `MIGRACION-SES.md`;
no autoriza cambios sobre los dominios ni el correo del sistema anterior.

## Estado de ejecucion al 28/08/2026

- Registro NIC pagado y habilitado: `miajbpruebas.com.ar`, a nombre de Martin,
  alta 28/08/2026 y vencimiento 28/08/2027. Se cargaron los cuatro NS de esta
  zona Route 53 y se ejecutaron los cambios; NIC muestra `Delegado: SI`.
  La propagacion publica todavia esta pendiente en el ultimo control DNS.
- Zona publica Route 53 creada: `Z0437381NTV12Q65HVMT`,
  `miajbpruebas.com.ar`, con los seis registros de autenticacion de correo.
  Los cuatro NS responden y los seis registros se comprobaron directamente
  contra dos NS de AWS: 12/12 verificaciones correctas. Esto no sustituye
  la delegacion en NIC ni la verificacion publica de SES.
- Identidad SES `miajbpruebas.com.ar` creada en `sa-east-1`: Easy DKIM RSA 2048,
  MAIL FROM `envios.miajbpruebas.com.ar` y configuration set `miajb-envios`.
  Identidad, DKIM y MAIL FROM pendientes de verificacion publica.
- AWS SES en `sa-east-1` sigue en sandbox: 200 destinatarios por 24 horas y 1/s.
  El Gmail de pruebas esta Verified y la identidad final sigue pendiente.
- Politica SMTP `AmazonSesSendingAccess` actualizada y releida en el grupo
  `AWSSESSendingGroupDoNotRename`: permite solo los remitentes exactos de
  pruebas y final, sus identidades SES y el configuration set `miajb-envios`.
  Se conservaron el usuario y las credenciales existentes.
- Destino `miajb-rebotes-quejas` habilitado para rebotes permanentes y quejas;
  SNS `miajb-correo-eventos` conserva la suscripcion Gmail Confirmed y permite
  publicar a SES solo desde la cuenta y configuration set previstos.
- Modo seguro y perfiles implementados; 228/228 pruebas del backend aprobadas
  nuevamente sin conexiones externas ni carga del `.env` real. El `.env` local
  ya tiene SES, modo de pruebas, una sola casilla de redireccion y envios
  desactivados. Se guardo un respaldo privado fuera del repositorio.
  El servidor EC2 y los dominios actuales aun no se modificaron.
- La credencial SMTP del CSV existente autentico correctamente por TLS en SES.
  Se uso solo en memoria para EHLO/AUTH; no se envio ningun mensaje. Esto no
  confirma aun permiso para el remitente nuevo ni entrega de correo.
- Pendientes propagacion DNS, verificacion SES, despliegue/configuracion EC2,
  activacion y prueba de entrega. La zona Route 53 creada cuesta USD 0,50/mes
  mas consultas e impuestos; el registro NIC autorizado es ARS 8.500 el primer ano.

El control del dominio anterior confirmo sus cuatro NS de `afraid.org`,
su A/MX anteriores y respuesta HTTP 200 del login. El backend EC2 sigue con
el SMTP anterior: aun no se desplegaron el codigo ni el perfil SES de pruebas.
El 28/08 a las 15:15 (UTC-03), despues de ejecutar la delegacion en NIC,
`c.dns.ar`, `d.dns.ar`, Cloudflare y Google
seguian respondiendo NXDOMAIN para el dominio nuevo: aun no habia delegacion
publicada. Esto no indica que el pago haya fallado.

Servidores DNS reales asignados a esta zona (solo para `miajbpruebas.com.ar`):

```text
ns-258.awsdns-32.com
ns-829.awsdns-39.net
ns-1891.awsdns-44.co.uk
ns-1357.awsdns-41.org
```

Registros de correo publicados en esa zona (valores reales generados por SES):

| Nombre | Tipo | Valor | TTL |
| --- | --- | --- | --- |
| `hpisya4bdhwlwxpmk3ttgiserstzakox._domainkey.miajbpruebas.com.ar` | CNAME | `hpisya4bdhwlwxpmk3ttgiserstzakox.dkim.amazonses.com` | 1800 |
| `7ox5vxknbzyj4ztwt5wg65pcgapr7se5._domainkey.miajbpruebas.com.ar` | CNAME | `7ox5vxknbzyj4ztwt5wg65pcgapr7se5.dkim.amazonses.com` | 1800 |
| `7b7tdlaitdrqqw2aymdavpewh42xaucm._domainkey.miajbpruebas.com.ar` | CNAME | `7b7tdlaitdrqqw2aymdavpewh42xaucm.dkim.amazonses.com` | 1800 |
| `envios.miajbpruebas.com.ar` | MX | `10 feedback-smtp.sa-east-1.amazonses.com` | 300 |
| `envios.miajbpruebas.com.ar` | TXT | `v=spf1 include:amazonses.com ~all` | 300 |
| `_dmarc.miajbpruebas.com.ar` | TXT | `v=DMARC1; p=none;` | 300 |

En Route 53 los TXT se cargaron entre comillas. Estos seis registros NO son
servidores DNS para pegar en la delegacion de NIC.

## Configuracion por etapa

| Dato | Pruebas | Produccion final |
| --- | --- | --- |
| Identidad SES | `miajbpruebas.com.ar` | `miajb.org.ar` |
| From | `no-responder@miajbpruebas.com.ar` | `no-responder@miajb.org.ar` |
| MAIL FROM de SES | `envios.miajbpruebas.com.ar` | `envios.miajb.org.ar` |
| Region / SMTP | `sa-east-1` / `email-smtp.sa-east-1.amazonaws.com:465` | Los mismos |
| Configuration set | `miajb-envios` | El mismo |
| Enlaces de los correos | CloudFront actual, hasta publicar la web de pruebas con HTTPS | `https://miajb.org.ar` |
| Destinatarios | Solo la casilla de pruebas de Martin | Afiliados autorizados, despues de la migracion |

Las plantillas de `perfiles/ses-pruebas.env.example` y
`perfiles/ses-produccion.env.example` son ejemplos, no archivos cargados por el
backend. Hay que aplicar las variables a su `.env` real y reiniciar el proceso.
Ambas se entregan con `MAIL_ENABLED=false` y sin credenciales.

## Proteccion del entorno de pruebas

- Definir `MAIL_TEST_MODE=true` y `MAIL_REDIRECT_TO` con una casilla verificada
  y controlada por Martin. En sandbox se puede usar su Gmail ya verificado.
- Con modo pruebas activo y redireccion ausente/invalida, el modulo bloquea el
  envio y la verificacion SMTP. No queda habilitado por tener credenciales.
- Con redireccion valida, To, CC y BCC se reemplazan por esa unica casilla.
  El asunto identifica el desvio; el mensaje conserva la trazabilidad existente.
- El modo de pruebas es independiente de `NODE_ENV`: una EC2 ejecutada con
  `NODE_ENV=production` tambien puede alojar un entorno de pruebas seguro.
- El modo no se activa automaticamente por el nombre del dominio. Aplicar
  expresamente el perfil correcto en cada entorno.
- Mientras SES siga en sandbox: 200 destinatarios por 24 horas y 1 por segundo.
  El perfil de ejemplo usa 30 mensajes/minuto y una conexion. La cuota diaria
  sigue siendo la de AWS; el limitador local no mantiene un contador diario.

## Registro y DNS del dominio nuevo

1. Completar el registro y pago de `miajbpruebas.com.ar` en NIC. El titular de
   este dominio de pruebas sera Martin; no se transfiere `miajb.org.ar`.
2. Crear una zona publica Route 53 exactamente para `miajbpruebas.com.ar`.
3. Delegar SOLO ese dominio en NIC a los cuatro NS que AWS asigne a ESA zona.
   No inventar NS, no copiar los de otra zona, no usar destinos DKIM o SMTP
   como servidores DNS. Guardar y ejecutar los cambios en NIC.
4. En SES `sa-east-1`, crear la identidad nueva con Easy DKIM RSA 2048,
   `miajb-envios` como configuration set predeterminado y MAIL FROM
   `envios.miajbpruebas.com.ar`. Mantener el fallback a MAIL FROM predeterminado.
5. Publicar los tres CNAME exactos que genere SES, y el MX/TXT del MAIL FROM en
   Route 53. Se puede usar la publicacion automatica de SES si muestra la zona
   correcta. No reutilizar los tokens DKIM de `miajb.org.ar`.
6. Agregar TXT `_dmarc.miajbpruebas.com.ar` con `v=DMARC1; p=none;` durante
   la validacion. No declarar una casilla de reportes que no exista.

El MX de `envios.miajbpruebas.com.ar` es el que indique SES en esa region
(`10 feedback-smtp.sa-east-1.amazonses.com`); su TXT SPF es
`v=spf1 include:amazonses.com ~all`. Estos registros pertenecen al subdominio
de rebotes, no al dominio raiz. SES de salida no crea una bandeja de entrada.

No modificar registros, delegaciones ni casillas de `ajb.org.ar` o
`miajb.org.ar`. Registrar el dominio nuevo tampoco publica automaticamente la
web: la configuracion de CloudFront, API y certificados HTTPS es separada.

## Credenciales y permisos

Reutilizar las credenciales SMTP existentes de `sa-east-1` solo despues de
comprobar su estado y permisos. El CSV descargado no se sube al repositorio,
no se comparte con terceros y no se muestra en los logs.

Politica aplicada el 28/08/2026: `perfiles/ses-smtp-policy.json`. Es la politica
inline `AmazonSesSendingAccess` del grupo `AWSSESSendingGroupDoNotRename`,
que contiene al usuario `ses-smtp-user.miajb`. La vista Permissions de ese
usuario muestra una sola politica, heredada de ese grupo; no se observaron
politicas adicionales de envio ni acceso a la consola habilitado.

La politica tiene dos statements acotados a `ses:SendRawEmail`: conserva
`no-responder@miajb.org.ar` y agrega `no-responder@miajbpruebas.com.ar`.
Cada uno autoriza el ARN de su identidad y el del configuration set utilizado,
con condicion exacta `ses:FromAddress`. No contiene `ses:*`, recursos comodin
ni un permiso para cualquier remitente. La politica anterior se respaldo
fuera del repositorio antes de actualizarla.

La consola confirmo la actualizacion y se releyo el JSON guardado. La prueba
de envio real sigue pendiente: AUTH correcto o politica guardada no acreditan
por si solos la verificacion del dominio ni la entrega del mensaje.

Mantener el destino SNS existente de rebotes/quejas y la supresion de cuenta
para BOUNCE y COMPLAINT. El configuration set predeterminado evita depender
de cabeceras particulares en cada llamada del backend.

## Verificacion antes de activar

- NIC muestra registro completado y la delegacion publica contiene solo los
  cuatro NS correctos del dominio nuevo.
- Los registros se resuelven desde DNS publico y los servidores autoritativos.
- SES: identidad Verified, DKIM Successful y custom MAIL FROM Successful.
- `npm run mail:verificar` autentica; esto por si solo NO prueba que un envio
  este autorizado ni que los DNS de correo esten verificados.
- Con el perfil de pruebas y una redireccion valida, habilitar temporalmente
  el envio y ejecutar `npm run mail:probar -- <casilla-verificada>`.
- Confirmar recepcion y SPF/DKIM/DMARC PASS en el original de Gmail, remitente
  nuevo y enlaces al entorno correcto. SMTP aceptado no equivale a entregado.
- Probar un rebote contra el simulador de SES en un proceso de diagnostico
  separado: la redireccion normal impediria que llegara al simulador. Nunca
  quitar la proteccion de la aplicacion para esta prueba. Verificar el evento SNS.
- Aplicar la configuracion validada al backend nuevo, con copia de seguridad
  privada del `.env` anterior y sin versionar secretos. Reiniciar y comprobar.

### Precaucion con PM2 y el entorno efectivo

`app.js` y `scripts/probar-correo.js` cargan dotenv sin `override`: una variable
`MAIL_*` ya heredada del proceso prevalece sobre `.env`. `pm2 restart --update-env`
no debe tratarse como una garantia de volver a leer ese archivo. Al desplegar,
cargar el perfil completo y pasar expresamente sus variables `MAIL_*` al entorno
del reinicio, incluidos los valores vacios, conservando el resto de variables.

El primer reinicio debe mantener `MAIL_ENABLED=false`, `MAIL_TEST_MODE=true`
y una redireccion valida. Comprobar la configuracion efectiva antes de habilitar
los envios redirigidos y de guardar PM2. No imprimir `pm2 env`, el `.env` completo
ni credenciales. Los scripts de diagnostico imprimen el usuario SMTP en su tabla
de estado: usar salida filtrada o un envoltorio con campos expresamente permitidos.

## Cambio final a miajb.org.ar

1. Coordinar con quien controla el DNS final los registros exclusivos de SES:
   tres CNAME DKIM, MX/TXT del MAIL FROM y DMARC compatible con el sistema viejo.
   Conservar los A, MX y demas registros existentes durante esa preparacion.
2. Esperar y verificar la identidad final en SES. Prepararlo con anticipacion:
   DNS/DKIM y MAIL FROM pueden tardar hasta 72 horas; no prometer un cambio
   instantaneo ni depender de hacerlo todo el dia de la salida.
3. Obtener y comprobar acceso a produccion SES en `sa-east-1` antes de enviar
   a afiliados no verificados. Es por cuenta/region, no por dominio. Verificar
   un dominio no elimina el sandbox y AWS no garantiza una fecha de aprobacion.
4. En el cambio de sitio, confirmar web/API/HTTPS/CORS y datos migrados. Cambiar
   `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_HELO_NAME` y `MAIL_APP_URL` al perfil final.
   Los afiliados siguen usando `miajb.org.ar`; no necesitan el dominio de pruebas.
5. Primero hacer una prueba a la casilla propia manteniendo `MAIL_TEST_MODE=true`.
   Solo tras validarla, pasar `MAIL_TEST_MODE=false`, vaciar `MAIL_REDIRECT_TO` y
   habilitar los destinatarios reales. Ajustar el ritmo a la cuota concedida.
6. No dar de baja el dominio de pruebas hasta retirar sus dependencias. No
   eliminar las credenciales ni el SMTP anterior mientras sean necesarios para
   volver atras. Guardar respaldos fuera del control de versiones.

El cambio de remitente no exige reemplazar Nodemailer ni migrar a otra API.
Para campañas masivas, revisar consentimiento, bajas, supresion y cuotas reales
antes de habilitarlas; la entrega transaccional de pruebas no certifica ese flujo.

## Referencias

- [Registro en NIC](https://nic.ar/es/ayuda/instructivos/registro-de-dominio)
- [Delegacion en NIC](https://nic.ar/es/ayuda/instructivos/delegacion-de-dominios)
- [Crear y verificar una identidad SES](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [Permisos de envio SES](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)
- [Permiso del configuration set predeterminado](https://docs.aws.amazon.com/ses/latest/dg/eb-policies.html)
- [Sandbox y acceso a produccion](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
