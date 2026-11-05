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

En el backend central: `api/routes/predios.js` (tres routers) y `api/services/predios-central.js`;
la migración es `scripts/migrar-predios.js`. En el front Angular: `src/app/components/predios/`.

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
- Las contraseñas de usuarios del camping tienen como mínimo 4 caracteres.

## Reglas de negocio que conviene recordar

- Solicitud entre bocas: el producto **sale** de la boca de origen (que lo despacha) y **llega** a
  la de destino (que confirma la recepción). El stock baja al despachar y sube al recibir.
  «Dar de baja automáticamente» consume lo recibido en el destino (Limpieza, Cabañas…).
- Venta directa descuenta stock de la boca; venta compuesta y alquiler no; uso interno no se vende.
- Disponible de un afiliado = límite − consumos con descuento todavía sin liquidar.
- Clave del día (autorizaciones en la PC de caja): día + mes + año sin ceros, p. ej. 5/11/2026 → `5112026`.
