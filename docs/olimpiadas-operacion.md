# Operación de Olimpiadas

## Publicación y privacidad

Una edición aparece sin iniciar sesión cuando `eliminado = 0`, `habilitado = 'Y'` y `publicada_publico = 1`. Las nuevas ediciones quedan publicadas **por defecto** (`publicada_publico = 1`) para promocionar las Olimpiadas. La administración puede ocultar una edición expresamente desde su configuración; editar otros campos no cambia esa decisión. El vencimiento de las fechas no retira una edición del portal público ni invalida su enlace compartido.

La migración `migrar-olimpiadas-publicacion.js` cambia el valor por defecto y publica, una sola vez, las ediciones existentes habilitadas y no eliminadas, incluida «Olimpiadas 2026». El texto de edición «Demo» no condiciona su visibilidad. La migración respalda los valores anteriores y registra cada publicación en el historial. Su marca persistente evita que una nueva ejecución vuelva a publicar una edición ocultada posteriormente por la administración.

El portal público permite consultar ediciones anteriores, cronograma, sedes, actividades, secciones visibles, noticias publicadas cuya fecha de publicación ya llegó, enlaces, fotos, videos, reglamentos, fixture y partidos en vivo. La publicación del sorteo se controla además con `sorteo_publicado`.

El **medallero** y las **tablas de posiciones** se reservan: mientras `olimpiada.medallero_publicado = 0` el medallero sólo lo ve la administración provincial (admin y admin-central); afiliados, departamentales, veedores y público reciben una respuesta vacía con `reservado: true`. Las posiciones por partidos sólo salen de la gestión con `olimpiada.posiciones_publicas = 1`. Ambos interruptores están en Fixture › Medallero (`PUT /olimpiadas/:id/competicion/ajustes`).

Los oponentes se muestran públicamente como departamentales o como equipos interdepartamentales (con su nombre combinado). `mostrar_nombres_publico = 1` es una autorización explícita por partido; sólo la administración puede cambiarla. Los colaboradores no pueden publicar nombres. Un partido legado sin departamental identificada muestra «A confirmar», aunque tenga un nombre cargado en el campo libre; un lado que todavía depende de otro resultado muestra el texto que arma el sistema («Ganador de Semifinal 1», «1.º de Zona A»). Se excluyen de los partidos públicos las referencias a inscripciones, observaciones privadas y campos que no estén expresamente permitidos. No se publican DNI, salud, certificados, datos de inscripción, compradores de bonos ni cuentas de colaboradores. Los contactos de organización cargados en la sección de datos útiles sí forman parte del contenido de la edición publicada.

Las respuestas de seguimiento llevan `Cache-Control: no-store`. El cliente vuelve a consultar los resultados periódicamente: no existe una conexión de eventos del servidor ni un proceso de actualización independiente.

## Inscripciones y gafetes

Las solicitudes de afiliados se crean «En revisión» (`PENDIENTE`) y requieren la aprobación del personal autorizado en todas las ediciones. La API ignora `olimpiada.requiere_aprobacion` al crear o editar la edición y en Bonos › Reglas, y lo devuelve fijo en 1 en todas sus respuestas (también en `GET /olimpiadas/actual`). La columna se conserva por historial: una edición que haya quedado en 0 (se podía apagar en Bonos › Reglas antes del 22/10) se corrige a 1 la próxima vez que se guarda la edición (`PUT /olimpiadas/:id`, que deja historial). Si el afiliado edita una inscripción aprobada y cambia algún dato (categoría, disciplinas, acompañantes, ficha sanitaria, observaciones, lugar de trabajo, foto o certificado), vuelve a `PENDIENTE` y el personal recibe el aviso «… actualizada y de vuelta en revisión» con lo que cambió; el historial registra el motivo. Guardar sin cambios no modifica el estado, no reescribe datos ni deja historial. Para decidir si hubo cambios, los textos ignoran los espacios de los extremos y el tipo de salto de línea, el documento de un acompañante se compara sólo con sus dígitos, el vínculo vacío equivale a «Otro» y los bonos calculados por edad no cuentan. Los bonos que el personal fijó a mano se conservan mientras el afiliado no cambie los datos de ese acompañante. Las ediciones del personal no cambian el estado. La respuesta de `PUT /olimpiadas/inscripciones/:id` informa `hubo_cambios`, `volvio_a_revision` y el `estado` final. El detalle de la inscripción trae una `version` (el estado y todo lo que el formulario reenvía) y el formulario la devuelve al guardar: si no coincide, alguien cambió la inscripción mientras estaba abierta y el PUT responde 409 sin guardar nada (sin `version`, se guarda como antes). La presión arterial es obligatoria también al editar: en blanco, el PUT responde 400 como el alta. Sólo una inscripción aprobada (`VALIDADO`) puede elegirse como participante individual o generar un gafete. El afiliado descarga su propia credencial; administración y personal autorizado pueden generar las de la edición o su departamental según sus permisos. El PDF incluye identificación, foto cuando existe y disciplinas, sin información médica.

## Disciplinas

En fixture, medallero y asignación de veedores sólo aparecen las disciplinas que se juegan: las de un tipo con `olimpiada_disciplina_tipo.competitiva = 1` y `habilitado = 'Y'`. Las categorías que no son deporte (Acompañante, Coordinación, Organización, Prensa) siguen existiendo para las inscripciones, pero no entran en la competencia. «Acompañante de afiliadx» se retiró del catálogo (los acompañantes se cargan dentro de la inscripción del afiliado).

Cada disciplina dice cómo se carga su resultado (`olimpiada_disciplina.tipo_marcador`, editable en su ficha):

| Valor | Deportes | Qué se carga |
| --- | --- | --- |
| `TANTOS` | fútbol, básquet, hándbol, truco… | un número por lado |
| `SETS` | vóley, pádel, tenis, tenis de mesa… | el tanteo de cada set (`olimpiada_partido.sets`, JSON `[[25,18],[25,20]]`); el resultado global (2 a 0) se cuenta solo |
| `GANADOR` | ajedrez, baile, pesca… | sólo quién ganó (o empate), sin puntaje |

El reglamento de una disciplina es texto y, opcionalmente, un PDF (`reglamento_archivo`, campo `REGLAMENTO`).

## Torneos, lugares e instancias

`olimpiada_lugar` y `olimpiada_instancia` son catálogos reutilizables entre ediciones. Los lugares distinguen predio, nombre del espacio/cancha, dirección y mapa. Los datos importados de Miramar 2025 son referencias históricas: verificar disponibilidad para cada nueva edición. Crear una disciplina en el catálogo no la habilita automáticamente para una edición.

Sedes y lugares pueden llevar el punto marcado en el mapa (`lat`, `lng`) además del enlace. Cada partido sale con los datos de su cancha y de su sede (la del partido o, si no tiene, la de la disciplina) para abrir el «cómo llegar» desde el fixture.

Un torneo pertenece a una edición y disciplina; admite formato `ELIMINACION`, `GRUPOS`, `LIGA` o `MIXTO`, y una lista ordenada de instancias. Se pueden reutilizar y ordenar fases de grupos, octavos, cuartos, semifinal, tercer puesto y final, además de crear otras. No se permite quitar una instancia que todavía contiene partidos ni cambiar la disciplina de un torneo que tiene partidos.

Cada partido admite fecha, hora de inicio y fin, sede, lugar específico, fase, zona, torneo, disciplina y dos rivales. Cada rival es una departamental, un **equipo interdepartamental**, una inscripción aprobada en esa misma edición y disciplina, o un lugar que se completa solo (ver más abajo). El sistema deriva nombre y departamental desde la inscripción, evitando referencias mezcladas. El marcador acepta valores numéricos y también texto como «W.O.»; para resultados no numéricos debe elegirse el ganador expresamente.

Un partido figura **en vivo** si alguien lo marcó «en juego» o si, estando programado, la hora actual (Buenos Aires) cae dentro de su horario; sin hora de fin se asume una hora y media. El servidor lo calcula en cada respuesta (`partido.en_vivo`, `disciplina.en_vivo`).

### Equipos interdepartamentales

Dos o más departamentales (hasta seis) que compiten juntas en UNA disciplina de una edición: `olimpiada_equipo` + `olimpiada_equipo_departamental`. Sin nombre propio se llaman como sus departamentales («Dolores + Mar del Plata»). En el partido ocupan un lado con `equipo1_id` / `equipo2_id` (y `departamentalN_id` en `NULL`). Llevan un escudo propio: el del sistema o el que suba la administración (`olimpiada_config.logo_interdepartamental_archivo`). Al importar partidos desde texto, un participante como «Dolores + Mar del Plata» crea o reutiliza el equipo, y un nombre que coincide con una departamental queda vinculado a ella.

### Clasificación automática

Con el cuadro precargado, **al cargar un resultado el sistema arma solo los cruces siguientes**. Cada lado de un partido puede decir de dónde sale:

- `origenN_tipo = GANADOR` o `PERDEDOR` + `partido_origenN_id`: el ganador (o el perdedor, para el tercer puesto) de otro partido de la misma disciplina y torneo.
- `origenN_tipo = POSICION` + `origenN_zona` + `origenN_posicion`: el puesto N de una zona. Se completa cuando terminaron todos los partidos con esa `zona` (victoria 3 puntos, empate 1; desempata por partidos ganados, diferencia y tantos a favor).

Mientras el origen no esté definido el lado muestra «Ganador de Semifinal 1» o «1.º de Zona A». Corregir o reabrir un resultado vuelve a calcular todo lo que depende de él; si el partido siguiente ya tenía marcador, la respuesta lo avisa. Un empate exacto en el corte de una zona también se avisa: el sistema elige por orden alfabético y la organización lo corrige a mano. Elegir a mano el participante de un lado le quita el origen (deja de actualizarse solo). No se admiten círculos (un partido que dependa de su propio resultado). La lógica es pura y está en `api/services/olimpiadas-competicion.js` (`resolverClasificacion`); se aplica en la misma transacción que guarda el partido y deja historial.

## Posiciones y medallero

La tabla de posiciones se calcula al leer los partidos y puede filtrarse por disciplina o torneo. Otorga 3 puntos por victoria y 1 por empate; informa jugados, ganados, empatados, perdidos, tantos a favor/en contra y diferencia. Ordena por puntos, victorias, diferencia, tantos a favor y nombre. Cuenta sólo partidos `FINALIZADO` con ganador/empate definido y ambos lados identificados y diferentes (departamental o equipo interdepartamental). Un encuentro interno entre afiliados de la misma departamental no suma puntos para esa tabla. Los marcadores no numéricos pueden sumar la victoria asignada, pero no tantos.

El medallero es siempre **por departamental**:

- **Puntos por puesto**: `olimpiada_puntos_puesto` (de 3 a 10 puestos; oro, plata, bronce, 4.º…). `puntos_oro/plata/bronce` de `olimpiada` se mantienen sincronizados por compatibilidad.
- **Equipos interdepartamentales**: las filas de `olimpiada_medalla` con el mismo `equipo_id` son un equipo. Cada departamental suma la medalla y los puntos del puesto se reparten entre la cantidad de departamentales (no de jugadores) según `olimpiada.medallero_division`: `EXACTA` (10 entre 3 = 3,33), `REDONDEO` (3), `ABAJO` (3), `ARRIBA` (4) o `COMPLETO` (10 cada una). Entre dos, 5 y 5. Filas sin `equipo_id` en el mismo puesto son ganadores distintos (dos bronces) y se llevan los puntos completos.
- **Cálculo automático**: en cada disciplina con una única final, la final define oro y plata y el partido por el tercer puesto, bronce y cuarto (`origen = 'AUTO'`). Se recalcula al cargar o corregir resultados.
- **Carga manual**: la administración puede fijar los ganadores de cada puesto (`origen = 'MANUAL'`); desde ese momento esa disciplina no se recalcula sola hasta que elija «volver al cálculo automático». También puede ajustar a mano los puntos que una medalla le suma a una departamental (`puntos_manual`).
- **Historial**: cada cambio de medallas, puntos, regla de reparto y publicación queda en `olimpiada_historial` (entidades `MEDALLA` y `AJUSTE`), consultable en `GET /olimpiadas/:id/competicion/historial?ambito=medallero`.

## Veedores

Las cuentas de veedor se guardan en `olimpiada_voluntario` (el nombre de las tablas y de las rutas `…/voluntarios` es anterior), separadas de los usuarios generales, y se reutilizan en futuras ediciones mediante asignaciones de edición y disciplina. Una disciplina puede tener varios veedores; el fixture muestra sus nombres.

**Veedores con cuenta en Mi AJB (lo habitual).** La administración busca la cuenta y la vincula (`usuario_sistema_id`). La persona entra a Mi AJB con su documento y contraseña de siempre, va a Olimpiadas y presiona el botón «Veedor»: `GET /olimpiadas/veedor/mi-acceso` decide si se muestra y `POST /olimpiadas/veedor/ingresar` abre la sesión de veedor sin pedir otra clave. Esa sesión sigue siendo la limitada (firma y audiencia propias): sólo los partidos de sus disciplinas, sin acceso al resto del sistema ni al medallero. La vinculación conserva su rol y contraseña habituales; desde Olimpiadas sólo se administran sus asignaciones y la habilitación.

**Veedores invitados (sin cuenta en Mi AJB).** La administración crea nombre, usuario y contraseña. A pedido de la organización la contraseña puede ser de un solo carácter («1», «123»): los veedores usan el teléfono y la cuenta dura lo que dura el evento. El correo es opcional; sin correo la cuenta guarda una dirección interna (`veedor-<usuario>@cuentas.internas.invalid`) que nunca se muestra ni recibe mensajes, y el usuario y la clave se entregan en persona. Riesgo aceptado: una clave tan corta se puede adivinar; lo acotan el límite de intentos de ingreso, el alcance (sólo resultados de sus disciplinas, sólo mientras la carga está abierta) y el historial de cada cambio.

La **escritura** de un veedor se habilita entre las fechas de inicio y fin de la edición inclusive (fecha civil de Buenos Aires) o cuando la administración activa `olimpiada.veedores_carga_abierta` (para precargar o probar antes del evento). Fuera de eso conserva sólo lectura de sus disciplinas. La administración siempre puede corregir información histórica con auditoría.

El envío de bienvenida es una acción explícita, individual o por selección de cuentas. **Para cuentas invitadas con correo, cada envío exitoso genera una nueva contraseña, la comunica por correo y revoca las sesiones previas de esa cuenta.** Un envío fallido no reemplaza la contraseña. Para cuentas vinculadas, la bienvenida indica que entren por Mi AJB con sus credenciales habituales. Una cuenta sin correo no admite bienvenida.

El acceso de invitados en `/olimpiadas-veedores/ingresar` reutiliza el módulo de login con textos específicos (las direcciones anteriores `/olimpiadas-colaboradores…` redirigen). Se puede mantener la sesión, recuperar la contraseña por código de correo y registrar claves de acceso (huella, rostro o PIN). Los códigos y renovaciones se guardan como hashes; el cierre de sesión revoca el acceso en el servidor. Los bloqueos y cambios de contraseña de la cuenta Mi AJB vinculada se comprueban también en sus accesos de veedor.

La pantalla del veedor (`/olimpiadas-veedores/:id`) muestra sólo su disciplina y sus partidos, sin los menús del resto del sistema, pensada para el teléfono. `/olimpiadas-veedores/configuracion` muestra los datos mínimos de una cuenta invitada.

El historial registra actor, fecha, campo y valores anteriores/nuevos de partidos, torneos y equipos. Para veedores incluye nombre y número de cuenta en la observación; no guarda contraseñas. El historial de competición admite filtro por disciplina y páginas de 50 registros.

## Videos

Los videos de una edición se guardan en el sistema (`olimpiada_video`, archivos en S3 bajo `olimpiadas/videos/`), no en una carpeta externa. Como pesan cientos de megas, el navegador los sube en partes de 8 MB: `POST /olimpiadas/:id/videos` abre la subida, `PUT /olimpiadas/videos/:videoId/partes/:n` recibe cada parte (cuerpo binario) y la pasa a S3, y `POST /olimpiadas/videos/:videoId/completar` une las partes. Formatos: MP4, WebM o MOV (se verifica el contenido de la primera parte); hasta 1,5 GB por video y 40 por edición. Se reproducen dentro del portal con una dirección firmada de seis horas. Las fotos admiten hasta 15 MB cada una (80 MB por tanda).

## Gafetes

El gafete en PDF lleva un QR. Quien lo escanea abre `/olimpiadas-publicas/gafete/<número>-<firma>` y ve, sin iniciar sesión, si la inscripción sigue aprobada y en qué disciplinas participa (lo mismo que el gafete lleva impreso, sin foto ni datos médicos). La firma (HMAC del número con el secreto del sistema) impide consultar otras inscripciones cambiando el número. El gafete impreso sigue sirviendo sin señal: el QR es una verificación adicional.

## API

Todas las rutas siguientes están bajo `/api`.

| Acceso | Rutas principales |
| --- | --- |
| Público | `GET /olimpiadas/publico/ediciones` |
| Público por edición | `GET /olimpiadas/publico/:id/{portal,fixture,en-vivo,torneos,posiciones,medallero,novedades,eventos,sedes,contactos,secciones,enlaces,fotos,videos,premios}` y `/bonos/reglas` (posiciones y medallero vacíos hasta que se publiquen) |
| Verificación de gafete | `GET /olimpiadas/publico/gafete/:codigo` |
| Competición, sesión general o colaboración | `GET /olimpiadas/:id/{fixture,en-vivo,torneos,posiciones}` |
| Gestión de competición | `GET /olimpiadas/:id/competicion/catalogos` y `/competicion/historial` |
| Torneos | `POST /olimpiadas/:id/torneos`, `PUT/DELETE /olimpiadas/torneos/:torneoId` |
| Partidos | `POST /olimpiadas/:id/partidos`, `POST /olimpiadas/:id/partidos/importar`, `PUT/DELETE /olimpiadas/partidos/:partidoId`, `PUT /olimpiadas/partidos/:partidoId/resultado` |
| Catálogos, sólo administración | `GET/POST /olimpiadas/competicion/{lugares,instancias}`, `PUT /olimpiadas/competicion/{lugares,instancias}/:catalogoId` |
| Equipos interdepartamentales | `GET/POST /olimpiadas/:id/equipos`, `PUT/DELETE /olimpiadas/equipos/:equipoId` |
| Ajustes de la competencia, sólo administración | `PUT /olimpiadas/:id/competicion/ajustes` (`veedores_carga_abierta`, `medallero_publicado`, `posiciones_publicas`, `medallero_division`) |
| Medallero, sólo administración | `PUT /olimpiadas/:id/medallero/puntos`, `PUT /olimpiadas/:id/medallero/:disciplinaId`, `POST /olimpiadas/:id/medallero/:disciplinaId/automatico`, `PUT /olimpiadas/medallas/:medallaId/puntos` |
| Escudos, sólo administración | `GET /olimpiadas/escudos`, `PUT /olimpiadas/escudos/departamentales/:id`, `PUT/DELETE /olimpiadas/escudos/interdepartamental` |
| Reglamento en PDF | `POST/DELETE /olimpiadas/:id/disciplinas/:disciplinaId/reglamento-archivo` |
| Videos | `GET/POST /olimpiadas/:id/videos`, `PUT /olimpiadas/videos/:videoId/partes/:n`, `POST /olimpiadas/videos/:videoId/{completar,poster}`, `PUT/DELETE /olimpiadas/videos/:videoId` |
| Veedor desde Mi AJB | `GET /olimpiadas/veedor/mi-acceso`, `POST /olimpiadas/veedor/ingresar` |
| Acceso de veedores invitados | `POST /olimpiadas/voluntarios/login`, `GET /olimpiadas/voluntarios/me` |
| Sesión de veedor | `POST /olimpiadas/voluntarios/sesion/{renovar,cerrar}` |
| Cuenta y recuperación | `PUT /olimpiadas/voluntarios/perfil`, `POST /olimpiadas/voluntarios/recuperacion/{solicitar,verificar,restablecer}` |
| Claves de acceso | `GET /olimpiadas/voluntarios/passkeys`, `DELETE /olimpiadas/voluntarios/passkeys/:id`, `POST /olimpiadas/voluntarios/passkeys/{registration,authentication}/{options,verify}` |
| Administración de veedores | `GET/POST /olimpiadas/:id/voluntarios`, `PUT /olimpiadas/:id/voluntarios/:voluntarioId`, `POST /olimpiadas/:id/voluntarios/enviar-bienvenida` |
| Vinculación de cuentas existentes | `GET /olimpiadas/:id/usuarios-disponibles?q=`, `POST /olimpiadas/:id/voluntarios/vincular` |
| Gafetes autorizados | `GET /olimpiadas/inscripciones/:id/gafete.pdf`, `GET /olimpiadas/:id/gafetes.pdf` |

Los listados de competición admiten `disciplina_id`; fixture y posiciones admiten `torneo_id`, y fixture también `lugar_id`. Los listados públicos de fotos admiten `page`, `pageSize` (máximo 60), `disciplina_id`, `fecha` y `etiqueta`. Los campos publicados se proyectan explícitamente, sin exponer las filas completas de inscripción.

## Migración e importación

Ejecutar desde `BACKEND` con los entornos administrativos configurados. La cuenta de ejecución de la API no debe recibir permisos DDL. La operación consolidada utiliza un bloqueo de MySQL, respalda el catálogo previo en `output/olimpiadas-migracion`, crea el esquema faltante, otorga los permisos DML necesarios a las cuentas `miajb_runtime` existentes e importa datos de forma aditiva. Los logos se guardan localmente en `output/olimpiadas-legado` y se suben a S3; no se reemplaza un logo ya asignado.

```powershell
node scripts/migrar-olimpiadas-operacion.js --check --target=develop
node scripts/migrar-olimpiadas-operacion.js --apply --target=develop --confirm=APLICAR_OLIMPIADAS_OPERACION
node scripts/migrar-olimpiadas-operacion.js --check --target=production --allow-production
node scripts/migrar-olimpiadas-operacion.js --apply --target=production --allow-production --confirm=APLICAR_OLIMPIADAS_OPERACION
```

`--target=all` recorre ambos entornos y requiere `--allow-production`. Sin `--apply`, la operación es de consulta. La conexión de producción utiliza la configuración TLS y CA definida para ese entorno. El informe identifica logos sin correspondencia, departamentales sin logo en el origen, disciplinas duplicadas ya existentes, disciplinas/lugares agregados y filas del sitio anterior que no representan departamentales. No fusiona duplicados ni elimina datos.

Después de aplicar, repetir `--check`, ejecutar las pruebas y verificar la API con la cuenta de ejecución. Confirmar que una edición expresamente oculta devuelve 404 por su URL pública, que el índice público incluye las ediciones pasadas publicadas y que un veedor no puede leer otra disciplina ni escribir fuera de fechas.

Veedores, equipos interdepartamentales, clasificación automática, medallero ampliado y videos requieren `migrar-olimpiadas-veedores.js` (idempotente; agrega columnas y las tablas `olimpiada_equipo`, `olimpiada_equipo_departamental`, `olimpiada_puntos_puesto` y `olimpiada_video`, con sus permisos DML para `miajb_runtime`). Aplicarla con la cuenta administrativa **antes** de desplegar el código:

```powershell
node scripts/migrar-olimpiadas-veedores.js --check --target=develop
node scripts/migrar-olimpiadas-veedores.js --apply --target=develop --confirm=APLICAR_OLIMPIADAS_VEEDORES
node scripts/migrar-olimpiadas-veedores.js --apply --target=production --allow-production --confirm=APLICAR_OLIMPIADAS_VEEDORES
```

Sin `--target` usa las variables `DB_*` del entorno (así se corre en el servidor). La primera vez también asigna a cada disciplina su forma de cargar el resultado, marca las categorías que no son deporte y convierte los puestos compartidos ya cargados en equipos interdepartamentales.

Para adoptar la publicación por defecto, ejecutar con la cuenta administrativa:

```powershell
node scripts/migrar-olimpiadas-publicacion.js --check --target=develop
node scripts/migrar-olimpiadas-publicacion.js --apply --target=develop --confirm=APLICAR_OLIMPIADAS_PUBLICACION
node scripts/migrar-olimpiadas-publicacion.js --check --target=production --allow-production
node scripts/migrar-olimpiadas-publicacion.js --apply --target=production --allow-production --confirm=APLICAR_OLIMPIADAS_PUBLICACION
node scripts/migrar-olimpiadas-publicacion.js --check --target=production --allow-production
```

Producción requiere `DB_SSL_MODE=verify-full` y `DB_SSL_CA_PATH` válido. El respaldo se guarda en `output/olimpiadas-publicacion`; no contiene inscripciones ni datos médicos. La publicación y su auditoría se confirman juntas en una transacción. El cambio del valor por defecto usa DDL fuera de esa transacción: ante un fallo se puede volver a ejecutar sin duplicar la publicación. La marca de `ajb_schema_migration` impide alterar ocultamientos posteriores. Para retirar una edición publicada se usa la configuración administrativa habitual; no se elimina esa marca.

La ampliación de acceso requiere además `migrar-olimpiadas-acceso-v2.js`, que agrega la vinculación con usuarios y las tablas de sesiones, recuperación, claves de acceso y desafíos. Aplicarla con una cuenta administrativa antes de desplegar el código y conceder permisos DML de esas tablas a `miajb_runtime`; luego verificar con la cuenta de ejecución. El ajuste del ícono de Tejo reutiliza la referencia S3 de Tejo dobles.

```powershell
node scripts/migrar-olimpiadas-acceso-v2.js --apply --target=develop --confirm=APLICAR_OLIMPIADAS_ACCESO_V2
node scripts/migrar-olimpiadas-acceso-v2.js --apply --target=production --allow-production --confirm=APLICAR_OLIMPIADAS_ACCESO_V2
node scripts/ajustar-icono-tejo.js --apply --target=all --allow-production
```

```powershell
node --test test/olimpiadas-competicion.test.js test/olimpiadas-contenido.test.js test/olimpiadas-voluntarios.test.js test/olimpiadas-veedores.test.js test/olimpiadas-inscripciones.test.js test/olimpiadas-gafetes-autorizacion.test.js
```
