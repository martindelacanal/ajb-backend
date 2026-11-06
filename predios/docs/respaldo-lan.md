# Respaldo local y reemplazo del servidor

Decisión del usuario: una instalación sola sigue funcionando como hasta ahora. Se
pueden agregar las PCs de respaldo que quieran. Para el reemplazo automático se
instala un testigo liviano en una PC de caja; no contiene la base comercial. El
administrador debe recibir el cambio de equipo y, cuando vuelve la PC preferida,
primero se actualiza y luego retoma el servicio. No se fusionan bases divergentes.

## Contrato de seguridad y recuperación

- Un único testigo persistente arbitra el grupo; no es una elección por mera falta
  de respuesta ni una implementación parcial de Raft. Sin testigo disponible no
  se puede acreditar una nueva autoridad. El modo de un servidor no cambia hasta
  que el administrador haya completado explícitamente la configuración del grupo.
- El testigo mantiene grupo, miembros, equipo preferido, término, escritor y
  última instantánea confirmada `{indice, sha256}`. Persistencia atómica con fsync.
  Tras reiniciarse espera más que la duración máxima de cualquier permiso previo.
- Permiso del testigo: máximo 15 segundos; el escritor sólo lo usa 5 segundos
  contados desde el envío de su solicitud, nunca desde la recepción. Revisa el
  término y el permiso antes de comenzar/confirmar transacciones. Al perderlo deja
  de aceptar operaciones. Reinicios/suspensiones no conservan permisos en memoria.
- Normalmente la instantánea debe estar durable en el escritor y en un respaldo
  antes de confirmar la operación. Para continuar con dos servidores cuando uno
  falla, la configuración explícita `permitirDegradado` permite continuar con una
  copia durable local y el índice/hash confirmado por el testigo. Se avisa a
  administración que se perdió redundancia. El testigo nunca permite activar una
  copia atrasada: una segunda falla antes de recuperar el otro equipo requiere
  recuperar la última base, no inventar ni fusionar datos.
- Retorno: el preferido recibe la última copia; el escritor actual drena sus
  operaciones y entrega el control. Sólo entonces el testigo cambia el término.
  El anterior vuelve a respaldo, no a testigo.
- Cada PC conserva identidad física y credenciales propias. Las instantáneas
  replican SQLite completo (incluidos outbox, sesiones y deduplicación), no las
  credenciales/identidad física del receptor. Sólo el escritor sincroniza central.
- Las órdenes remotas y sus resultados son transaccionales. Las peticiones de
  escritura tienen identificador persistente por usuario para repetir la respuesta
  sin repetir una venta ante una respuesta perdida.
- Emparejamiento administrativo de un solo uso; protocolo LAN autenticado y con
  rechazo de replay. Copias cifradas. No incluir `.env` ni clave de firma central.

## Piezas de implementación

- `respaldo-local.js`: archivo portable cifrado y validado; restauración en carpeta
  nueva detenida con `restauracion_pendiente`. Exportación independiente del grupo.
- `testigo-lan.js`: árbitro HTTP local liviano, estado durable y permisos firmados;
  no SQL ni datos comerciales. Configuración privada por grupo, miembros explícitos.
- `respaldo-lan.js`: copias locales, cliente del testigo, réplica durable y permisos
  del escritor. Estado de recuperación fuera de la SQLite reemplazada.
- `acceso-lan.js`: acceso local de las cajas; conserva el origen del navegador y
  deriva al servidor acreditado por el testigo. No reenvía un cobro a ciegas.
- Windows: instalación principal normal, respaldo o testigo/acceso de caja, con
  arranque automático y ACL de SYSTEM/administradores.
- Central: reconocer delegación de un miembro registrado sin exigir internet en
  el cambio local; rechazar términos anteriores y conservar instancia lógica.

## Verificación requerida

Copia con WAL y transacción en curso; estado íntegro/outbox pendiente; destino ya
existente; clave/tamper/ruta inválidos; pérdida de respuesta; caída del escritor;
respaldo atrasado; partición de red; reinicio del testigo; regreso de la PC preferida;
falla de disco; ninguna operación confirmada ausente en el reemplazo; central sin
duplicación. El instalador no activa una copia por el mero hecho de ejecutarla.

## Compatibilidad de actualizaciones

El manifiesto fija la huella del esquema y del formato LAN. Una copia de otro
modelo se conserva, pero no se instala ni habilita escritura, traspaso o promoción.
El agente de un respaldo puede consultar sólo código/versiones firmados mientras
está en espera. Las actualizaciones de UI y lógica con el mismo esquema se aplican
normalmente; las que cambian el esquema requieren una transición de grupo que esta
primera versión retiene antes de instalar. No se degrada silenciosamente el esquema.

La activación portable reinicia también el supervisor, después de instalar el
lanzador actual. El lanzador exige soporte HA para cualquier versión, rollback o
fallback cuando existe configuración HA o una intención persistente de activación.
