# Predios — sistema local de los campings

Sistema de ventas, caja, stock, compras y afiliados de cada predio (Camping Miramar, y
más adelante el Parador de la Montaña). Corre en una notebook dentro de la red del
camping, funciona sin internet y se sincroniza con el sistema general.

## Piezas

| Carpeta | Qué es |
|---|---|
| `servidor.js` | Servidor HTTP local (API + pantallas). Node 22, **sin dependencias npm**. |
| `lanzador.js` | Supervisor: mantiene vivo el servidor, aplica actualizaciones y vuelve a la versión anterior si una nueva no arranca. En la notebook se copia como `arranque.js`. |
| `lib/esquema.js` | Definición única de las 26 tablas `predio_*`. Genera SQLite (notebook) y MySQL (réplica central). |
| `lib/api/` | La API del predio. **La misma** corre en la notebook (SQLite) y en el sistema general (MySQL, modo remoto). |
| `lib/listados.js` | Motor de listados: paginación, orden, filtros, buscador, CSV completo y CSV resumido. |
| `lib/agente.js` | Sincronización con el sistema general (subida de cambios, órdenes remotas, afiliados, actualizaciones, archivos para pendrive). |
| `public/` | Pantallas (HTML + CSS + JavaScript sin compilar, compatible con Chrome 80+ / Firefox 78+). |
| `windows/` | Instalador (`INSTALAR.bat` + `instalar.ps1`) y utilidades para la notebook y las PCs de caja. |

En el backend central: `api/routes/predios.js` (administración general, cuentas propias,
sincronización y pantalla remota) y `api/services/predios-central.js`. La migración del modelo
es `scripts/migrar-predios.js`; las sesiones de cuentas propias usan
`scripts/migrar-predios-acceso.js`. En el front Angular: `src/app/components/predios/`.

## Cómo se sincroniza

- **La notebook es la dueña de los datos.** Cada cambio en una tabla queda anotado por un
  disparador en `predio_outbox`. Con internet, el agente lo sube cada ~6 s (cada 2 s si alguien
  está mirando el predio a distancia) a `POST /api/predios-sync/push`, que lo aplica a la réplica
  MySQL (`predio_* ` con `predio_id`).
- **Cambios hechos a distancia** (Mi AJB → Predios → panel): las lecturas salen de la réplica; las
  escrituras se guardan como orden en `predio_comando`, la notebook las ejecuta con la misma lógica
  y devuelve el resultado (en segundos si está conectada; si no, quedan en cola).
- **Antes de instalar la notebook** el sistema general es el dueño (`predio.escritor = 'CENTRAL'`):
  lo que se cargue a distancia se escribe directo en la réplica. Al conectarse por primera vez, la
  notebook descarga todo y toma el control (`escritor = 'LOCAL'`).
- **Afiliados**: el sistema general manda los afiliados con reserva en los servicios del predio
  (`MIRAMAR_CAMPING`, `MIRAMAR_CABANAS`), sus estadías y las departamentales. Un afiliado cargado a
  mano se une solo con su ficha cuando coincide el DNI o el legajo.
- **Administradores generales**: entran en el camping con DNI y contraseña de Mi AJB. La primera
  vez se valida contra el sistema general; después queda un hash local para entrar sin internet.
- **Administradores propios del predio**: también pueden entrar por el login de Mi AJB con su
  usuario y contraseña del camping. Se abre únicamente su predio. La cuenta debe estar activa,
  tener rol `ADMIN` y haber llegado a la réplica central mediante la sincronización. Si hay
  cuentas con las mismas credenciales en varios predios, el login pide elegir uno. Ver
  [Ingreso remoto de cuentas propias](docs/acceso-remoto.md), incluida la actualización necesaria
  para aplicar sus órdenes en el camping.
- **Sin internet por días**: en el camping, Sistema → *Exportar datos* (`.ajbpredio`) para subir en
  Mi AJB; y en Mi AJB, *Descargar paquete* (`.ajbpaquete`: afiliados, órdenes en cola y, opcional,
  la versión nueva) para cargar en el camping.
- **Actualizaciones**: la versión es `package.json` + huella del contenido. Cada deploy del backend
  publica la versión nueva; la notebook la descarga, la instala en `app/versiones/<versión>/` y se
  reinicia sola. Si no arranca dos veces seguidas, el lanzador vuelve a la anterior.

## Firma de actualizaciones y paquetes

El sistema general firma con Ed25519 el código que publica y los paquetes para pendrive; la
notebook verifica con la `clave_publica` que trae su `config.json` (la pone el instalador) y
rechaza lo que no coincide. La clave privada está en el `.env` del EC2 como
`PREDIOS_FIRMA_PRIVADA` (PEM en base64). **No cambiarla**: las notebooks ya instaladas dejarían de
aceptar actualizaciones y habría que reinstalarlas. Sin la variable (desarrollo), se genera una en
`.cache/predios/firma-privada.pem`.

## Desarrollo

```sh
cd predios
node herramientas/semilla-local.js --base .local --productos   # base de prueba con bocas, cajas y productos
node servidor.js --base .local --puerto 8090                    # http://localhost:8090 (primer uso: crear admin)
node --test                                                     # recorrido completo de la API
```

Para probarlo vinculado al sistema general: descargar el instalador desde Mi AJB > Predios,
descomprimirlo, cambiar `servidor` en `config.json` y correr `node arranque.js`.

## Base central

```sh
node scripts/migrar-predios.js --check                       # qué falta
node scripts/migrar-predios.js                                # develop
DB_HOST=… DB_USER=admin DB_PASSWORD=… node scripts/migrar-predios.js --allow-production
```

La migración es idempotente: crea/completa las tablas, siembra MIRAMAR (14 bocas, 6 cajas) y
otorga DML a `miajb_runtime` en cada host que tenga. Si se agregan columnas a `lib/esquema.js`,
volver a correrla en las dos bases (la notebook se actualiza sola al arrancar).

Para habilitar el ingreso de administradores propios desde Mi AJB, aplicar además la migración
de sesiones **sólo en las bases centrales**, antes de publicar el acceso:

```sh
node scripts/migrar-predios-acceso.js --check --target=develop
node scripts/migrar-predios-acceso.js --apply --target=develop
# Producción: usa su bloque del .env y exige TLS verify-full.
node scripts/migrar-predios-acceso.js --apply --target=production --allow-production
```

Esta migración crea `predio_acceso_sesion` y concede DML sobre esa tabla a `miajb_runtime`.
Conserva las cuentas existentes y el esquema de las notebooks; no crea usuarios generales.

## Catálogo del sistema anterior

El catálogo de AJBGestion (Access) se pasa en tres pasos:

```sh
# 1. Exportar (Windows; se relanza solo en PowerShell de 32 bits por el driver de Access)
powershell -ExecutionPolicy Bypass -File predios/herramientas/sistema-anterior/exportar-access.ps1 -Mdb "…\Data.mdb" -Clave "…" -Salida C:\temp\access -Desde 2024-12-01
# 2. Convertir: productos usados desde esa fecha o con precio vigente (nunca los «VIEJO - …»),
#    proveedores con compras desde esa fecha
node predios/herramientas/sistema-anterior/convertir.js --entrada C:\temp\access --salida catalogo.json --desde 2024-12-01
# 3. Importar (sin --aplicar sólo simula). Antes de instalar la notebook, en el sistema general:
node scripts/importar-catalogo-predio.js --predio MIRAMAR --archivo catalogo.json --aplicar [--allow-production]
#    Con la notebook instalada, en la notebook:
node predios/herramientas/importar-catalogo.js --base C:\AJB-Predio --archivo catalogo.json --aplicar
```

Lo importado queda con `creado_por = "Sistema anterior (importación)"` (filtro «Origen» de las
tablas de productos y proveedores) y el último precio conocido en el historial de precios. Lo que
ya existe (mismo nombre, código o CUIT) se saltea, así que se puede volver a correr. Los productos
sin precio de venta no se pueden vender hasta que el administrador lo cargue.

**Eliminar**: en Gestión se eligen filas (o «todos los que coinciden» con el filtro) y se eliminan;
también desde la ficha. Lo que nunca se usó se borra del todo; lo que tiene ventas, compras,
solicitudes, bajas o movimientos se da de baja para no romper el historial (`lib/api/eliminar.js`).

## Ingreso y red local

- El ingreso es igual al de Mi AJB. Las fotos salen de la galería del login del sistema general
  (`GET {servidor}/login/imagenes`). La notebook las baja al arrancar y cada 6 horas a
  `datos/galeria/` y las sirve en `/api/login/imagenes`, así se ven aunque no haya internet.
  Sin fotos, se ve el logo.
- **Nombre en la red**: Sistema → «Cambiar el nombre en la red» renombra la notebook
  (`Rename-Computer`, corre como SYSTEM) y abre UDP 137/5353/5355 en el firewall.
  Las PCs entran con `http://nombre:puerto`, que Windows resuelve solo por NetBIOS/LLMNR.
  El nombre nuevo se aplica al reiniciar, y desde la misma pantalla se puede reiniciar la notebook.
- La contraseña creada o restablecida por administración se reemplaza al ingresar.
  La nueva clave debe tener entre 6 y 128 caracteres. Se rechazan las secuencias,
  las repeticiones simples y el nombre del usuario.
- Desde el quinto intento de contraseña incorrecta se avisa al dueño de la cuenta,
  cualquiera sea su rol. Se informa la cantidad, los horarios, la IP, el dispositivo
  y la última boca/caja registrada. El décimo fallo bloquea la cuenta y la PC durante
  15 minutos completos; el bloqueo se conserva al reiniciar el servidor.
- El navegador y el servidor recuerdan el último puesto de cada PC aun después de
  cerrar sesión. Ese dato identifica el origen de los avisos; no otorga permisos.
- La campana muestra avisos privados de acceso y, a los administradores, los de stock.
  Los avisos se guardan sin internet y se replican; las cuentas de Mi AJB reciben los
  suyos en el sistema general. Marcar un aviso leído no lo borra para los demás.

## Lectores de códigos y stock en ventas

- El lector + Enter carga automáticamente sólo un código exacto y único. Un código
  próximo se muestra como sugerencia y exige elegir el producto explícitamente.
  El diálogo permite cotejar nombre, presentación y códigos y elegir «Corregir y usar
  producto» o «Continuar sin modificar»; cerrarlo cancela la selección.
- La corrección valida el dígito de control de los GTIN, impide duplicados y rechaza
  códigos que hayan cambiado mientras se revisaban. Queda auditada y se sincroniza.
  El mismo selector se usa en compras y movimientos de stock.
- No se completan códigos sólo por longitud: un código de 12 dígitos puede ser un UPC
  válido o un EAN truncado, y un código corto puede ser interno. Para reparaciones ya
  verificadas, la orden de sistema `CORREGIR_CODIGOS_VERIFICADOS` recibe `productos`
  con `producto_id`, `nombre_esperado`, `codigo_anterior` y `codigo_nuevo`; valida todo
  antes de aplicar y admite repetición. Primero actualizar la notebook, luego encolar
  la reparación: las versiones anteriores no conocen esta orden.
- La lista de ventas ofrece productos con precio de venta y stock positivo en la boca elegida,
  incluso cuando se busca por nombre o código. Los agotados y los productos sin precio
  no se agregan al desplegable; un escaneo exacto permite informar el motivo.
  El aviso de falta de precio aparece al escanear ese producto.
  «¿No aparece el producto?» permite buscar en todo el catálogo, incluidos los agotados,
  elegir un producto y enviar el aviso en un solo diálogo. La búsqueda habitual de
  ventas exige stock positivo también para productos compuestos y alquileres.
  Si el stock disponible resulta insuficiente, la caja mantiene el carrito pendiente y
  permite avisar al administrador. El cobro se habilita al corregir cantidades o reponer stock.
  Para vender porciones, en la ficha de la venta compuesta se puede elegir un insumo
  base e indicar cuántas porciones rinde cada unidad. Distintos tamaños pueden compartir
  el mismo paquete. Caja registra las porciones vendidas y el consumo estimado del insumo
  en los movimientos de la boca. Sin insumo configurado descuenta porciones del stock propio.
- Cada caja conserva su opción «Imprimir comanda». El ticket del cliente y la copia
  completa marcada COMANDA se imprimen en un único trabajo. La opción se sincroniza
  y no afecta a las demás cajas.
- Cada caja tiene un responsable hasta el cierre. Si se interrumpe la conexión,
  al volver a ingresar recupera su turno. El panel de cajas muestra quién atiende.
  Un turno que cruza la medianoche conserva su apertura y se cierra a la hora real.
- El **cierre definitivo** lo hace siempre un administrador: desde su cuenta o, en la PC
  del cajero, escribiendo su usuario (o DNI, si es del sistema general) y su contraseña.
  Cinco intentos fallidos bloquean la aprobación en esa PC durante diez minutos.
- Si el cajero se va y no hay un administrador, hace un **cierre temporal**: separa el
  efectivo en dos bolsas (recaudación = ventas y cobros; cambio = saldo inicial y
  agregados) y se imprimen el resumen marcado «CIERRE TEMPORAL» y un ticket para cada
  bolsa. La caja queda en cero (movimiento «Cierre temporal») y libre; el siguiente
  cajero abre su propio turno sin heredar la apertura ni los números del anterior.
  El administrador ve los temporales pendientes en Caja, en Inicio y en la campana;
  cuenta cada bolsa y lo cierra en forma definitiva sin tocar la caja que sigue
  trabajando. Los retiros del día se descuentan primero de la recaudación.
- En Usuarios se delega «Anular tickets». El permiso histórico «Cerrar caja» ya no
  habilita el cierre definitivo.
- El saldo de apertura fija el **fondo de cambio** del período abierto (lo que quedó del
  último cierre + aperturas cargadas): no absorbe lo ya cobrado. Después de un cierre
  temporal la caja queda en $ 0 y el administrador puede cargarle el cambio a quien
  sigue, también a distancia («Cargar cambio» en la lista de temporales o en el aviso);
  al cajero le aparece enseguida para confirmarlo.
- Un turno sin ventas ni movimientos de caja se libera al salir o al cambiar de caja,
  sin cierre (queda auditado «Turno sin movimientos liberado»).
- Sin permiso de anulación, el cajero solicita anular el ticket e indica el motivo.
  El administrador puede abrir la solicitud desde la campana o filtrar las ventas
  pendientes de anulación. La confirmación revierte el movimiento de la venta.
- En Productos y stock, «Sumar stock» registra unidades recibidas por donación o
  ajuste de recuento. El historial conserva boca, motivo, cantidad y responsable.
  Mi AJB envía a sus administradores el recuento mensual de ajustes por predio.
- En los perecederos con stock y fecha de caducidad, el personal recibe el aviso
  con la anticipación configurada en el producto (7 días por defecto). A los
  administradores de Mi AJB se les avisa con un mes calendario de anticipación.

## Precios, compras y recordatorios

- Cada compra ingresa en la boca marcada como **proveeduría** en Gestión → Bocas y
  cajas. Antes de confirmarla, se eligen los productos que actualizarán su precio en
  caja. Los demás conservan su costo de referencia y su precio de venta. El costo
  efectivamente pagado queda en la factura, también cuando era una oferta.
- Con **Recibir como temporal** la mercadería queda disponible en la proveeduría.
  Desde Compras se pueden corregir cantidades, reemplazar productos y completar
  la factura definitiva. Cada corrección ajusta sólo la diferencia de stock.
  Si hay que retirar más de lo que queda en esa boca, se deben revisar primero
  las ventas y los traspasos.
- Si la factura redondea al peso, la revisión muestra la diferencia entre los
  renglones y el total facturado. Los ajustes mayores a cinco centavos requieren
  confirmación. El comprobante conserva ambos importes.
- Cada boca puede tener un margen de venta sobre el costo de referencia. En Gestión
  → Productos → Precios por boca se puede fijar un margen especial para ese producto.
  Si faltan ambos márgenes, la caja usa el precio general del producto. El precio
  de venta se redondea al siguiente múltiplo de $100 (por ejemplo, $1550 pasa a $1600).
  Los cambios de precio se consultan en el historial de la ficha.
- La revisión de precios se registra aparte de las modificaciones de nombre o código.
  Un cambio real de costo, margen o precio general, una compra con actualización o la confirmación explícita de
  revisión renuevan su fecha. El historial importado aporta la referencia anterior.
- Si un producto activo tiene stock positivo y lleva **más de cuatro meses calendario**
  sin revisar su precio, el administrador recibe un recordatorio. Gestión → Productos
  incluye el filtro «Precios pendientes de revisión» y su fecha. Se puede seguir vendiendo.
  Se revisa periódicamente sin internet; un recordatorio resuelto no se repite hasta
  que vuelva a vencer o reaparezca stock pendiente.

## Arranque, servidor único y HTTPS en la red local

- El instalador configura el arranque con Windows por defecto. La tarea `AJB Predio`
  ejecuta el supervisor y recupera caídas. Se puede instalar sin arranque automático.
  `herramientas/iniciar-servidor.bat`, `detener-servidor.bat`, `reiniciar-servidor.bat`
  y `configurar-arranque.bat` permiten controlarlo manualmente. Detener conserva el
  apagado intencional; reiniciar vuelve a habilitar el arranque automático.
- Cada instalación conserva la identidad de su equipo. Copiar la carpeta o base a otra
  PC no habilita un segundo escritor. Una instalación nueva vinculada debe activar su
  control una vez con Mi AJB; después sigue trabajando sin conexión. La LAN consulta
  servidores del mismo predio con mensajes autenticados y muestra el servidor existente.
  Mi AJB serializa la toma de control; reinstalar otra PC no reemplaza automáticamente
  al servidor dueño del predio.
- HTTPS local utiliza un certificado propio del predio, con el nombre de la notebook
  y sus IP, y conserva HTTP para compatibilidad. Para que cada PC deje de advertir sobre
  el certificado hay que instalar una vez la raíz pública desde el paquete
  `certificados-PCs` generado por el servidor, comprobando su huella SHA-256.
  Las claves privadas permanecen en el servidor con permisos de SYSTEM y administradores.
  La renovación del certificado del servidor conserva la misma raíz de confianza.

## PCs de respaldo y reemplazo automático sin internet

Una PC sola conserva el funcionamiento habitual. Para agregar respaldo, desde
**Sistema → PCs de respaldo**, en el servidor del camping:

1. Prepará el instalador de **Testigo** y ejecutalo como administrador en una PC
   de caja que quede encendida. Coordina el grupo y no guarda la base comercial.
2. Prepará un instalador de **Respaldo** por PC y ejecutá `INSTALAR-APOYO.bat`
   en cada una. La incorporación se hace por la red local; el paquete vence en
   una hora y corresponde a una sola PC.
3. Cuando estén incorporadas, elegí **Activar reemplazo automático**. Se pausan
   las operaciones brevemente para copiar la base actual, incluidos los cambios
   todavía pendientes de subir. Un corte durante este paso conserva la pausa y
   reanuda la misma copia al volver a arrancar.
4. Prepará el **Acceso de caja** en las otras PCs y usá el acceso compartido
   «Sistema del Camping - Caja». Abre siempre `http://127.0.0.1:8091` y sigue
   al servidor acreditado, conservando el origen y la sesión del navegador.

Si se interrumpe una instalación, ejecutá `CONTINUAR-INSTALACION.bat` dentro de
la carpeta que creó en esa PC. Reutiliza su identidad y certificados; no borres
esa carpeta para volver a empezar.

El administrador recibe un aviso con la PC que toma el control. Cuando vuelve
la principal, recibe la última copia y retoma el servicio; la otra vuelve a ser
respaldo. Con dos servidores, si uno falla se continúa desde la copia disponible
y se avisa que falta redundancia. Una copia atrasada nunca se activa como si
estuviera al día. El testigo tiene que estar disponible para operar en este modo.

Los datos entre servidores viajan por HTTPS con las autoridades públicas fijadas
durante la incorporación. Las copias completas se conservan cifradas. La identidad
física, claves propias y configuración de cada PC quedan fuera de la base replicada.
El testigo es único: copiar su carpeta a otro hardware no crea una segunda autoridad.

Sólo la PC en servicio sincroniza datos con Mi AJB; los respaldos también pueden
descargar actualizaciones de código firmado. Una actualización que cambie el
esquema requiere una transición coordinada del grupo y se retiene antes de
instalarla, para no migrar una sola PC y dejar respaldos incompatibles. Una versión
sin soporte del grupo nunca se usa como rollback. Las exportaciones `.ajbpredio`
no reemplazan una réplica central que ya tenga un grupo HA registrado.

## Recuperar un respaldo completo en otra PC

En una instalación o paquete completo actualizado, ejecutá
`herramientas/RECUPERAR-RESPALDO.bat` (o el mismo archivo dentro de `instalador`).
Elegí el archivo `.ajbrespaldo`, ingresá su clave y revisá el predio, la fecha y los
cambios pendientes. El asistente crea una carpeta nueva y deja la copia **detenida,
en espera**; conserva la base completa y sus identificadores de operaciones.
Para reincorporar la PC al grupo se usa el instalador de Respaldo con el testigo
disponible. Recuperar el archivo no instala servicios ni habilita otro escritor.

## Reglas de negocio que conviene recordar

- Solicitud entre bocas: el producto **sale** de la boca de origen (que lo despacha) y **llega** a
  la de destino (que confirma la recepción). El stock baja al despachar y sube al recibir.
  «Dar de baja automáticamente» consume lo recibido en el destino (Limpieza, Cabañas…).
- Los traspasos aceptan fracciones como 0,5. El despacho de un compuesto físico o de un insumo
  usado por una porción puede dejar stock negativo en el origen con confirmación explícita.
- La caja comprueba todas las cantidades en la boca del puesto. La venta directa descuenta
  unidades y la compuesta descuenta porciones o su insumo. El alquiler comprueba disponibilidad
  y conserva las unidades para el siguiente alquiler.
- Disponible de un afiliado = límite − consumos con descuento todavía sin liquidar.
- Ya no hay clave del día: las autorizaciones en la PC de caja (pedir productos, ver todas
  las ventas de la caja) las aprueba el administrador con su usuario y su contraseña, o a
  distancia desde su cuenta.
