# Normalización de edades de temporadas

`migrar-temporadas-edades.js` normaliza las temporadas existentes y los valores
predeterminados de alta y baja a bebés de 0–1 años, menores de 2–17 y adultos
desde los 18 años. Está destinado a las temporadas de prueba existentes.

```powershell
node scripts/migrar-temporadas-edades.js --check --target=develop --env-file=.env
node scripts/migrar-temporadas-edades.js --apply --target=develop --env-file=.env --confirm=APLICAR_EDADES_TEMPORADAS
node scripts/migrar-temporadas-edades.js --check --target=production --allow-production --env-file=.env --ca-path=C:/ruta/rds-global-bundle.pem
node scripts/migrar-temporadas-edades.js --apply --target=production --allow-production --env-file=.env --ca-path=C:/ruta/rds-global-bundle.pem --confirm=APLICAR_EDADES_TEMPORADAS
```

La configuración se obtiene del bloque `# DEVELOP` o `# PRODUCCION` del archivo
indicado. Producción exige TLS verificado. La CA pública de RDS está disponible
en `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`.

El modo predeterminado es de consulta, con una transacción de solo lectura. El
modo de aplicación obtiene un bloqueo, realiza los cambios en una transacción
y vuelve a construir el plan antes de confirmar. Si quedan cambios pendientes
o se altera una reserva, revierte la transacción.

Se conservan temporadas, tipos de persona, recursos, regímenes, fechas y tarifas
referenciadas por reservas. Las bandas redundantes se eliminan únicamente cuando
no tienen referencias. Las bandas faltantes se crean con precios existentes;
cuando usan porcentajes se calculan a partir del precio de lista correspondiente.
Los bebés quedan sin cargo y sin porcentaje. Las tarifas globales por recurso
no se convierten en tarifas por edad.

Los valores predeterminados conservan su regla y sus porcentajes; se remapean los
órdenes de base y tope a las dos nuevas bandas. No se crean registros de auditoría.

Antes de escribir se comprueban las edades, fechas, importes por noche y totales
de las reservas, incluyendo adicionales y descuentos. Los IDs reservados se
asignan a su banda correspondiente para mantener personas, precios y snapshots.
Si una tarifa está compartida entre categorías diferentes, o varias tarifas
reservadas no pueden consolidarse sin alterar snapshots, el script se detiene
sin modificar datos y requiere una conciliación específica.

Después de aplicar, repetir `--check`: las cantidades de tarifas actualizadas,
agregadas y consolidadas, y de reglas predeterminadas actualizadas deben ser cero.

```powershell
node --test test/migrar-temporadas-edades.test.js
```
