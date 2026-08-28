# Módulo de correo automático

Envío de correo saliente de Mi AJB mediante SMTP configurable, preparado para
Amazon SES en `sa-east-1`. El dominio de pruebas es `miajbpruebas.com.ar` y el
remitente definitivo será `Mi AJB <no-responder@miajb.org.ar>`.
La integración sigue usando Nodemailer: SES reemplaza al proveedor SMTP, no la
API pública del módulo.

La estrategia vigente y las plantillas de configuración por entorno están en
[`SES-PRUEBAS.md`](./SES-PRUEBAS.md). Cambiar los ejemplos del repositorio no
activa el correo: hay que verificar SES, aplicar el `.env` y validar la entrega.

## Archivos

| Archivo | Rol |
| --- | --- |
| `config.js` | Lee y normaliza las variables `MAIL_*` del `.env`. |
| `transporte.js` | Pool de conexiones SMTP (nodemailer), compartido por todo el backend. |
| `plantilla.js` | Plantilla HTML de marca (tablas + estilos en línea) y derivación a texto plano. |
| `index.js` | API pública: `enviarCorreo`, `enviarCorreoPlantilla`, `verificarCorreo`, `estadoCorreo`, `urlAplicacion`. |
| `assets/logo-ajb.png` | Logo que viaja embebido como `cid:` en el encabezado. |

## Configuración (`.env`)

```
MAIL_HOST = email-smtp.sa-east-1.amazonaws.com
MAIL_PORT = 465               # 465 = SSL/TLS implícito; 587 = STARTTLS (MAIL_SECURE = false)
MAIL_SECURE = true
MAIL_USER = ...               # usuario SMTP generado por SES; no es una casilla
MAIL_PASSWORD = ...           # contraseña SMTP de SES; no es la secret access key
MAIL_FROM = no-responder@miajb.org.ar
MAIL_FROM_NAME = Mi AJB
MAIL_REPLY_TO =               # ausente o vacío: esta dirección no recibe respuestas
MAIL_HELO_NAME = miajb.org.ar  # nombre con el que el backend se presenta en EHLO
MAIL_ENABLED = true           # false apaga el envío sin tocar código
MAIL_TEST_MODE = false        # true exige MAIL_REDIRECT_TO válida y evita envíos a afiliados
MAIL_REDIRECT_TO =            # pruebas: desvía To/CC/BCC a esa casilla
MAIL_APP_URL = https://d2bnjhvusxwgza.cloudfront.net
MAIL_MAX_POR_MINUTO = 300     # solo tras confirmar una cuota SES de al menos 5 por segundo
MAIL_MAX_CONEXIONES = 5
MAIL_TLS_ESTRICTO = true
MAIL_DEBUG = false            # true vuelca el diálogo SMTP en consola
```

`MAIL_USER` y `MAIL_PASSWORD` deben ser las credenciales SMTP de SES de
`sa-east-1`. Como el usuario de SES no es una dirección de correo,
`MAIL_FROM` debe definirse expresamente con una identidad verificada. Nunca se
versionan las credenciales ni se copian a logs.

El limitador reparte `MAIL_MAX_POR_MINUTO` según la concurrencia efectiva. Con
los valores anteriores salen como máximo 5 mensajes por segundo. Esos valores
se aplican únicamente después de salir del sandbox y confirmar en el panel que
la cuota concedida admite al menos ese ritmo; en sandbox la cuota observada es
1 mensaje por segundo y 200 por día. SES contabiliza destinatarios, por lo que
los envíos masivos deben generar un mensaje por afiliado y respetar también la
cuota vigente de la cuenta.

En pruebas usar `MAIL_TEST_MODE=true` y `MAIL_REDIRECT_TO` con la casilla propia:
los correos se generan igual, pero To/CC/BCC se desvían a esa única casilla (el
asunto queda prefijado con `[DESARROLLO -> destinatario_original]`). Si el modo
de pruebas está activo y falta una redirección válida, se bloquean los envíos y
la verificación SMTP. Es independiente de `NODE_ENV`.

## Uso

```js
const { enviarCorreoPlantilla, urlAplicacion } = require("../services/correo");

const resultado = await enviarCorreoPlantilla({
  para: usuario.email,
  asunto: "Tu solicitud de traslado tiene novedades",
  titulo: "Novedades en tu solicitud",
  saludo: `Hola, ${usuario.nombre}`,
  parrafos: ["Tu departamental respondió la solicitud TR-2026-0031."],
  datos: [
    { etiqueta: "Expediente", valor: "TR-2026-0031" },
    { etiqueta: "Estado", valor: "En análisis" },
  ],
  boton: { texto: "Ver mis gestiones", url: urlAplicacion("/mis-gestiones") },
  aviso: "Podés responder desde el chat del expediente.",
});

if (!resultado.enviado) {
  // resultado.motivo: sin_configurar | deshabilitado | destino_pruebas_invalido |
  //                   destinatario_invalido | asunto_invalido | cuerpo_vacio | error_smtp
}
```

Para HTML propio (sin la plantilla de marca) está `enviarCorreo({ para, asunto, html, texto, adjuntos, cc, cco, responderA })`.

### Contrato importante

Ninguna función **lanza** por un fallo de SMTP: siempre devuelven
`{ enviado, motivo, error }`. Un servidor de correo caído nunca debe tumbar una
operación de negocio (una reserva no puede fallar porque el mail no salió).
Quien necesite reaccionar mira `resultado.enviado`.

Otras garantías:

- El asunto se limpia de `CR`/`LF` (evita inyección de cabeceras) y se corta en 200 caracteres.
- Los destinatarios se validan, normalizan a minúsculas y deduplican (máx. 50).
- Todo lo que entra a la plantilla se escapa; los botones solo aceptan `http(s):` y `mailto:`.
- Cada mensaje lleva `Auto-Submitted: auto-generated` para no disparar respuestas automáticas.
- El envío es multipart: HTML + alternativa en texto plano + logo embebido.

## Probar

```bash
npm run mail:verificar                                  # solo credenciales y conexión
npm run mail:probar -- martin.delacanalerbetta@gmail.com   # envía un correo de prueba completo
npm test -- test/correo.test.js                         # pruebas offline del módulo
```

El servidor además deja una línea en el log al arrancar (`[correo] SMTP listo ...`).

## Configuración de Amazon SES

La identidad de dominio, Easy DKIM, custom MAIL FROM, DMARC, credenciales SMTP,
salida del sandbox y eventos de rebote/queja se configuran siguiendo
[`SES-PRUEBAS.md`](./SES-PRUEBAS.md). El brief original
[`MIGRACION-SES.md`](./MIGRACION-SES.md) se conserva como antecedente, pero su
plan de usar el dominio final desde el inicio fue reemplazado por el dominio
independiente de pruebas. Los recursos SES viven en `sa-east-1` y sus secretos
no forman parte del repositorio.

Antes de habilitar envíos reales se deben completar las pruebas de aceptación
del documento: conexión SMTP, entrega a Gmail con SPF/DKIM/DMARC en PASS y evento
de rebote en SNS. La casilla SMTP anterior se conserva solo como respaldo durante
la migración.

## Por qué existe `MAIL_HELO_NAME` (antecedente del 26/08/2026)

Síntoma: el servidor aceptaba todo con `250 OK id=...`, pero **nada llegaba** a Gmail
ni a verificadores externos, y tampoco volvía ningún rebote a la casilla.

Causa: nodemailer se presenta en `EHLO` con `os.hostname()`, y si ese nombre no tiene
punto (una PC con Windows, una EC2 `ip-172-31-x-x`) manda `EHLO [127.0.0.1]`. El correo
de `ajb.org.ar` sale por el relay `cloudfilter.net` (HostGator/Newfold), cuyo filtro de
salida descarta en silencio los mensajes cuyo `Received` muestra `helo=[127.0.0.1]`.

Prueba que lo demuestra (mismo texto, misma casilla, un minuto de diferencia, ambos
enviados a `check-auth@verifier.port25.com`, que contesta por mail a la casilla remitente):

| Variante | `EHLO` | Resultado |
| --- | --- | --- |
| D y D2 | `[127.0.0.1]` (defecto de nodemailer) | `250 OK`, ninguna respuesta, ningún rebote |
| E | `ajb.org.ar` | Respuesta en 4 segundos: SPF **pass**, DKIM **pass**, iprev **pass** |

Desde entonces el transporte pasa `name: MAIL_HELO_NAME` (por defecto, el dominio del
remitente). La configuración SES mantiene este comportamiento con `miajb.org.ar`. Si
algún día vuelve a "enviar pero no llegar", lo primero es mirar qué `helo=` aparece
en el `Received` del mensaje (`npm run mail:probar` imprime el nombre en uso).
