# Módulo de correo automático

Envío de correo saliente de Mi AJB sobre la casilla institucional
`miajbnotificaciones@ajb.org.ar` (servidor cPanel/Exim del hosting de `ajb.org.ar`).

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
MAIL_HOST = mail.ajb.org.ar
MAIL_PORT = 465               # 465 = SSL/TLS implícito; 587 = STARTTLS (MAIL_SECURE = false)
MAIL_SECURE = true
MAIL_USER = miajbnotificaciones@ajb.org.ar
MAIL_PASSWORD = ...           # la contraseña termina en punto: el punto es parte de la clave
MAIL_FROM = miajbnotificaciones@ajb.org.ar
MAIL_FROM_NAME = Mi AJB
MAIL_REPLY_TO =               # casilla de respuesta (opcional)
MAIL_HELO_NAME = ajb.org.ar   # nombre con el que el backend se presenta en EHLO (ver "Estado de la entrega")
MAIL_ENABLED = true           # false apaga el envío sin tocar código
MAIL_REDIRECT_TO =            # solo desarrollo: desvía TODO a esa casilla
MAIL_APP_URL = https://d2bnjhvusxwgza.cloudfront.net
MAIL_MAX_POR_MINUTO = 20      # techo del hosting compartido
MAIL_MAX_CONEXIONES = 2
MAIL_TLS_ESTRICTO = true
MAIL_DEBUG = false            # true vuelca el diálogo SMTP en consola
```

En desarrollo conviene poner `MAIL_REDIRECT_TO` con la casilla propia: los correos
se generan igual, pero ninguno llega a un afiliado real (el asunto queda prefijado
con `[DESARROLLO -> destinatario_original]`).

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
  // resultado.motivo: sin_configurar | deshabilitado | destinatario_invalido |
  //                   asunto_invalido | cuerpo_vacio | error_smtp
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

## Estado de la entrega (verificado el 21/08/2026)

- SPF, DKIM (`default._domainkey`) y DMARC (`p=none`) están publicados en `ajb.org.ar`.
- El SPF autoriza al servidor de envío por el mecanismo `+mx` (`mail.ajb.org.ar` → `192.185.166.137`).
- Casilla con cuota de 400 MB: el cliente la limpia periódicamente. Como el módulo
  solo envía, lo único que se acumula ahí son los rebotes.

## Por qué existe `MAIL_HELO_NAME` (diagnóstico del 26/08/2026)

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
remitente). Si algún día vuelve a "enviar pero no llegar", lo primero es mirar qué
`helo=` aparece en el `Received` del mensaje (`npm run mail:probar` imprime el nombre en uso).
