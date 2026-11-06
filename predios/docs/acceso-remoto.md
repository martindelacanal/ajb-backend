# Ingreso remoto de administradores propios del predio

Una cuenta administradora creada en el camping puede ingresar por el login habitual
de Mi AJB usando su **usuario del predio y su misma contraseña**. El acceso abre
directamente la administración de ese predio y conserva su identidad local para
avisos, permisos y auditoría. No requiere crear una cuenta del sistema general.

## Cómo ingresar

1. En Mi AJB, escribir el usuario del camping en **Documento o usuario del predio**
   y completar la contraseña.
2. Si esas credenciales corresponden a más de un predio, elegir el predio que
   muestra el formulario y volver a ingresar. La selección aparece después de
   comprobar la contraseña.
3. Se abre **Administración del predio**, con la pantalla remota del predio elegido.
   Desde allí se puede cerrar la sesión; cerrarla dentro del panel también cierra
   el acceso de Mi AJB.

Este acceso corresponde a cuentas propias activas con rol `ADMIN`. Las cuentas de
caja continúan entrando desde las PCs del camping. El administrador propio no recibe
el menú ni los permisos generales de Mi AJB y no puede abrir otro predio con esa sesión.

Los DNI de cuentas generales existentes conservan su ingreso habitual. Una contraseña
incorrecta de esa cuenta no se prueba contra una identidad local homónima. Para entrar
como administrador propio, usar el nombre de usuario del predio.

## Sincronización inicial y cambios de cuenta

El login remoto valida la **réplica central** de `predio_usuario`, incluida la
contraseña guardada como hash con sal. La sincronización replica ese hash y nunca
la contraseña en claro. Por eso, antes del primer ingreso remoto de una cuenta creada en el
camping, el servidor debe conectarse a Mi AJB y completar la subida de esa cuenta.

Las altas, modificaciones, contraseñas nuevas y bajas realizadas sin internet se
reflejan a distancia cuando se sincronizan. Si una cuenta funciona en la red del
camping pero todavía no entra por Mi AJB, comprobar su rol y estado, la conexión del
servidor y los cambios pendientes de subir. Esperar esa sincronización antes de
probar de nuevo; no hace falta duplicar la cuenta en el sistema general.

Cada petición remota vuelve a comprobar el predio, la cuenta y la sesión persistida.
Un cambio de contraseña o una modificación auditada de la cuenta invalida sus
sesiones anteriores cuando llega a la réplica; reactivar la cuenta con la misma
contraseña no recupera esas sesiones. El camping también revalida la cuenta al
ejecutar cada orden, contra su base actual.

Sin **Mantener sesión iniciada**, el acceso dura hasta ocho horas. Con esa opción,
los tokens de acceso duran quince minutos y se renuevan mediante una sesión persistida. Cerrar
sesión revoca también el acceso del panel remoto. La renovación actualiza su token
sin recargar el panel ni perder un formulario abierto.

## Consultas y cambios pendientes

Las consultas muestran los datos que alcanzaron la réplica central; no requieren
que el camping esté conectado en ese momento. Cuando el servidor del camping es el
dueño de los datos, un cambio remoto queda como orden pendiente hasta que pueda
ejecutarlo y devolver su resultado. El aviso **quedó en cola** confirma que la orden
se guardó, no que el dato ya cambió en el camping.

Esta versión identifica las órdenes del administrador propio con su predio, usuario
local, credencial y revisión de cuenta. El agente actualizado anuncia la capacidad
`cuentas-predio-v1`. Una instalación anterior **no recibe esas órdenes**: permanecen
pendientes hasta que el servidor del camping se actualice y sincronice por internet.
Las órdenes habituales de administradores generales conservan su flujo anterior.

Los paquetes `.ajbpaquete` para pendrive excluyen las órdenes de cuentas propias,
incluso cuando incluyen código nuevo. Se puede usar el paquete para actualizar el
camping; después, esas órdenes se reciben mediante la sincronización por internet.
No se debe volver a cargar un cambio sólo porque sigue en cola: revisar primero su
resultado en la administración general del predio.

Si la cuenta cambió, fue dada de baja o perdió el rol `ADMIN` después de enviar la
orden, el camping la rechaza y conserva el resultado como error. La operación no
se ejecuta con otra identidad. Tras revisar el error, ingresar nuevamente y enviar
el cambio con la cuenta vigente si todavía corresponde hacerlo.

Antes de instalar un servidor local, cuando el dueño es `CENTRAL`, las operaciones
se aplican directamente sobre la base central con la identidad propia del predio.
Las operaciones reservadas a las PCs del camping siguen requiriendo acceso local.

## Publicación y comprobación

1. Aplicar en cada base central la migración
   `scripts/migrar-predios-acceso.js`, con `--allow-production` para producción o
   un host remoto. Su `--check` verifica sin escribir. Los targets y TLS se toman
   de los bloques de entorno de las migraciones centrales.
2. Publicar backend y frontend. La tabla nueva `predio_acceso_sesion` sólo guarda
   sesiones centrales; esta función no modifica el esquema local ni el del grupo
   de respaldo.
3. Actualizar el servidor del camping y completar la sincronización de las cuentas.
   Hasta que anuncie `cuentas-predio-v1`, las órdenes propias quedan pendientes.
4. Comprobar con un `ADMIN` propio: ingreso a su predio, selector si tiene homónimos,
   rechazo de otro predio y del menú general, y avisos de su propia identidad.
   Comprobar también que una cuenta de caja no obtiene este acceso y que un
   administrador general sigue ingresando con su DNI.

La firma, audiencia y tabla de sesiones de este acceso están separadas de las
generales. Los identificadores se contrastan como `(predio_id, usuario_id)` aunque
coincidan con el id de otro predio o con el de una cuenta general. Para los contratos
y casos de regresión, ver `api/security/predios-acceso.js`,
`test/predios-acceso.test.js`, `test/predios-signin.test.js` y
`test/predios-cuenta-remota.test.js`.
