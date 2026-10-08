# Preferencias de notificaciones

Aplicar con la cuenta administrativa antes de desplegar. La cuenta de ejecución necesita `SELECT, INSERT, UPDATE` sobre `usuario_notificacion_preferencia`; la migración otorga estos permisos a todas las cuentas existentes `miajb_runtime`.

```powershell
node scripts/migrar-notificaciones-preferencias.js --check
node scripts/migrar-notificaciones-preferencias.js --apply --confirm=APLICAR_NOTIFICACIONES_PREFERENCIAS
```

Para un host remoto agregar `--allow-production`. `--skip-grants` permite administrar los permisos por separado. Usar la configuración operativa `DB_*` del backend, incluido TLS.

No requiere copiar usuarios: la ausencia de fila equivale a todas las categorías habilitadas. La configuración pertenece al usuario de la sesión; los endpoints no aceptan identificadores de otros usuarios. Los cambios afectan solamente avisos nuevos, sin modificar notificaciones existentes, mensajes ni historial de trámites. Las gestiones y aprobaciones permanecen disponibles en sus módulos aunque se silencien sus avisos.

Categorías: mensajes del chat y observaciones; cambios de estado, respuestas y adjudicaciones; gestiones nuevas o pendientes de revisión; novedades y comunicados. Todas se habilitan por defecto. La comprobación de entrega ocurre en cada inserción dentro de la misma transacción del trámite.
