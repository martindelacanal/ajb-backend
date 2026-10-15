# Operación de Olimpiadas

## Publicación y privacidad

Una edición aparece sin iniciar sesión sólo si `eliminado = 0`, `habilitado = 'Y'` y `publicada_publico = 1`. El último indicador es una decisión explícita de la administración y su valor inicial es **0**, también en ediciones existentes. La edición de demostración «Olimpiadas 2026 / Demo» debe conservarse sin publicación hasta que se reemplace su contenido y la administración decida publicarla. La migración no la publica.

El portal público permite consultar ediciones anteriores, cronograma, sedes, actividades, secciones visibles, noticias publicadas cuya fecha de publicación ya llegó, enlaces, fotos, reglamentos, fixture, partidos en vivo, posiciones y medallero. La publicación del sorteo se controla además con `sorteo_publicado`.

Los oponentes se muestran públicamente como departamentales. `mostrar_nombres_publico = 1` es una autorización explícita por partido; sólo la administración puede cambiarla. Los colaboradores no pueden publicar nombres. Un partido legado sin departamental identificada muestra «A confirmar», aunque tenga un nombre cargado en el campo libre. Se excluyen de los partidos públicos las referencias a inscripciones, observaciones privadas y campos que no estén expresamente permitidos. No se publican DNI, salud, certificados, datos de inscripción, compradores de bonos ni cuentas de colaboradores. Los contactos de organización cargados en la sección de datos útiles sí forman parte del contenido de la edición publicada.

Las respuestas de seguimiento llevan `Cache-Control: no-store`. El cliente vuelve a consultar los resultados periódicamente: no existe una conexión de eventos del servidor ni un proceso de actualización independiente.

## Inscripciones y gafetes

Las solicitudes de afiliados se crean pendientes y requieren validación del personal autorizado. La migración activa `requiere_aprobacion` en las ediciones existentes. Sólo una inscripción aprobada (`VALIDADO`) puede elegirse como participante individual o generar un gafete. El afiliado descarga su propia credencial; administración y personal autorizado pueden generar las de la edición o su departamental según sus permisos. El PDF incluye identificación, foto cuando existe y disciplinas, sin información médica.

## Torneos, lugares e instancias

`olimpiada_lugar` y `olimpiada_instancia` son catálogos reutilizables entre ediciones. Los lugares distinguen predio, nombre del espacio/cancha, dirección y mapa. Los datos importados de Miramar 2025 son referencias históricas: verificar disponibilidad para cada nueva edición. Crear una disciplina en el catálogo no la habilita automáticamente para una edición.

Un torneo pertenece a una edición y disciplina; admite formato `ELIMINACION`, `GRUPOS`, `LIGA` o `MIXTO`, y una lista ordenada de instancias. Se pueden reutilizar y ordenar fases de grupos, octavos, cuartos, semifinal, tercer puesto y final, además de crear otras. No se permite quitar una instancia que todavía contiene partidos ni cambiar la disciplina de un torneo que tiene partidos.

Cada partido admite fecha, hora de inicio y fin, sede, lugar específico, fase, torneo, disciplina y dos rivales. Los rivales pueden ser departamentales o inscripciones aprobadas en esa misma edición y disciplina. El sistema deriva nombre y departamental desde la inscripción, evitando referencias mezcladas. El marcador acepta valores numéricos y también texto como «W.O.»; para resultados no numéricos debe elegirse el ganador expresamente.

Las referencias opcionales `partido_origen1_id` y `partido_origen2_id` describen el cuadro del torneo. Sólo pueden apuntar a partidos creados antes en el mismo torneo y disciplina, para evitar ciclos. **No hay propagación automática de ganadores ni de correcciones al siguiente partido**: el encargado crea o edita el siguiente encuentro y selecciona a sus participantes. Corregir un resultado vuelve a calcular las posiciones, sin cambiar rivales ya cargados.

## Posiciones y medallero

La tabla de posiciones se calcula al leer los partidos y puede filtrarse por disciplina o torneo. Otorga 3 puntos por victoria y 1 por empate; informa jugados, ganados, empatados, perdidos, tantos a favor/en contra y diferencia. Ordena por puntos, victorias, diferencia y nombre. Cuenta sólo partidos `FINALIZADO` con ganador/empate definido y ambas departamentales identificadas y diferentes. Un encuentro interno entre afiliados de la misma departamental no suma puntos para esa tabla. Los marcadores no numéricos pueden sumar la victoria asignada, pero no tantos.

El medallero sigue siendo independiente: la administración asigna puestos por disciplina y configura los puntos de oro, plata y bronce. Las posiciones de partidos no generan medallas automáticamente.

## Colaboradores

Las cuentas se guardan en `olimpiada_voluntario`, separadas de los usuarios generales, y se reutilizan en futuras ediciones mediante asignaciones de edición y disciplina. La administración crea nombre, usuario, correo y contraseña, decide las disciplinas y puede deshabilitar la cuenta o cambiar la clave.

El envío de bienvenida es una acción explícita, individual o por selección de cuentas. **Cada envío exitoso genera una nueva contraseña, la comunica por correo y revoca las sesiones previas de esa cuenta.** Nunca se recupera ni se envía la contraseña anterior: sólo se conserva su hash. El correo incluye la edición, disciplinas asignadas y acceso. Un envío fallido no reemplaza la contraseña. El resultado del lote distingue enviados y fallidos, sin mostrar contraseñas en la respuesta.

Los tokens de colaboración usan una firma y audiencia separadas de la sesión general. No dan acceso al resto del sistema. Cada lectura o escritura de competición comprueba la cuenta y sus asignaciones persistidas. La escritura se habilita únicamente entre las fechas de inicio y fin inclusive, con fecha civil de Buenos Aires. Antes del inicio y al terminar, la cuenta conserva **sólo lectura de las disciplinas asignadas**. La administración conserva la posibilidad de corregir información histórica con auditoría; las ediciones pasadas no son inmutables para administradores.

El historial registra actor, fecha, campo y valores anteriores/nuevos de partidos y torneos. Para colaboradores incluye nombre y número de cuenta en la observación; no guarda contraseñas. El historial de competición admite filtro por disciplina y páginas de 50 registros.

## API

Todas las rutas siguientes están bajo `/api`.

| Acceso | Rutas principales |
| --- | --- |
| Público | `GET /olimpiadas/publico/ediciones` |
| Público por edición | `GET /olimpiadas/publico/:id/{portal,fixture,en-vivo,torneos,posiciones,medallero,novedades,eventos,sedes,contactos,secciones,enlaces,fotos,premios}` y `/bonos/reglas` |
| Competición, sesión general o colaboración | `GET /olimpiadas/:id/{fixture,en-vivo,torneos,posiciones}` |
| Gestión de competición | `GET /olimpiadas/:id/competicion/catalogos` y `/competicion/historial` |
| Torneos | `POST /olimpiadas/:id/torneos`, `PUT/DELETE /olimpiadas/torneos/:torneoId` |
| Partidos | `POST /olimpiadas/:id/partidos`, `POST /olimpiadas/:id/partidos/importar`, `PUT/DELETE /olimpiadas/partidos/:partidoId`, `PUT /olimpiadas/partidos/:partidoId/resultado` |
| Catálogos, sólo administración | `GET/POST /olimpiadas/competicion/{lugares,instancias}`, `PUT /olimpiadas/competicion/{lugares,instancias}/:catalogoId` |
| Acceso de colaboración | `POST /olimpiadas/voluntarios/login`, `GET /olimpiadas/voluntarios/me` |
| Administración de colaboradores | `GET/POST /olimpiadas/:id/voluntarios`, `PUT /olimpiadas/:id/voluntarios/:voluntarioId`, `POST /olimpiadas/:id/voluntarios/enviar-bienvenida` |
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

Después de aplicar, repetir `--check`, ejecutar las pruebas y verificar la API con la cuenta de ejecución. Confirmar que una edición no publicada devuelve 404 por su URL pública, que el índice público sólo contiene ediciones publicadas y que un colaborador no puede leer otra disciplina ni escribir fuera de fechas. Publicar una edición se hace después de revisar contenido y privacidad, desde su configuración; no es una consecuencia del despliegue.

```powershell
node --test test/olimpiadas-competicion.test.js test/olimpiadas-contenido.test.js test/olimpiadas-voluntarios.test.js test/olimpiadas-inscripciones.test.js test/olimpiadas-gafetes-autorizacion.test.js
```
