# Acceso de mantenimiento a Miramar

Preparación: 10 de noviembre de 2026. Solicitado por Martín para poder administrar la notebook y acceder a servicios de la LAN sin controlar el escritorio con RustDesk.

## Estado verificado

**10/11/2026, 17:34:39 ART: acceso SSH, forward HTTP, servicios de ambas PCs y reconexión verificados.** `Conectar-Predio.ps1 hostname` devolvió `ajbmiramar` desde la PC de Martín, usando el salto AWS y la identidad de host fijada. El sistema del predio funciona con la notebook como único servidor con escritura.

- Notebook: paquete `1.1.0+f01fe05af5` instalado. La orden 35 de preparación SSH (`ssh-03`) terminó correctamente a las 17:19:03 ART; se configuraron la cuenta de mantenimiento, las claves, el servicio y la tarea de túnel.
- AWS: servicio `ajb-miramar-relay` instalado, activo y habilitado. La clave pública del túnel de la notebook está autorizada; el listener 22222 está restringido a ese usuario y al reenvío remoto `127.0.0.1:22099`. La regla EC2 es `sgr-02ba3581e1b4bc7d7`, grupo `sg-0b5c02df518400a6e`. El acceso administrativo SSH22 existente sigue funcionando.
- PC de Martín: clave de operador y configuración SSH fuera de Git; identidades de AWS y de la notebook verificadas y fijadas en `ajb_predio_known_hosts`. Los fingerprints se documentan abajo.
- Sistema del predio: recuperación comprobada en la interfaz a las 17:00 ART; compras y formulario de proveedores responden, aparece “Sincronizado” y Sistema muestra únicamente la notebook como servidor. Las consultas autenticadas de las 17:32 confirmaron ingreso/cierre de sesión correctos, 5 compras, 48 proveedores, 1804 productos y autorización de escritura. La central estaba sin pendientes a las 17:33:51. Las consultas de coordinación informaron `soloPrincipal=true`, `regresoAutomatico=false`, un único votante y dos `Nonvoter`; no reactivar respaldos para resolver el mantenimiento SSH.
- SSH: la cuenta `AJBMIRAMAR\ajbmantenimiento` tiene administración; `sshd` está en inicio automático y escucha sólo `127.0.0.1:2222`. Las tareas `AJB Predio` y `AJB Mantenimiento SSH Tunel` están en ejecución como SYSTEM. El forward local `127.0.0.1:18080` devolvió HTTP200 y se cerró al terminar la prueba; ambas PCs respondieron por TCP8080 y HTTP200 a `/api/estado-publico`.
- Reconexión: se reinició únicamente el relay AWS a las 17:33:47; SSH volvió a responder `hostname` a las 17:34:04. Los PID y fechas de creación de los procesos Node permanecieron iguales: la aplicación no se reinició. La comprobación completa de las 17:34:39 volvió a confirmar SSH, tareas, aplicación en línea, servidor único y ambas PCs accesibles.
- RustDesk conserva la conexión de recuperación y se verificó que su teclado volvió a **Modo mapa**. El arranque automático de SSH está configurado. El reinicio de Windows fue anterior a la instalación de SSH; la prueba efectuada fue la reconexión del túnel, no un arranque de Windows con SSH ya instalado.

La primera preparación (orden 25) se canceló durante la carga elevada de Windows Update/Defender. Los diagnósticos firmados 30 y 32 confirmaron que OpenSSH estaba presente. La orden 31 falló porque la descripción de `New-LocalUser` excedía el límite de 48 caracteres; la corrección quedó en `26e623e` y la preparación 35 completó ese paso. La recuperación del sistema y el acceso de mantenimiento son independientes del relevo de servidores.

Evidencia local desde la raíz del proyecto: `output/verificacion-ssh-lan-20261110.json`, `output/verificacion-ssh-lan-reconexion-20261110.json`, el consolidado `output/verificacion-reconexion-20261110.json` y la captura `output/sistema-solo-notebook-final-20261110.png`. La captura final muestra “Sincronizado” y la notebook como único servidor. El helper `-Estado` volvió a responder correctamente a las 17:36:40 con SSH, túnel y predio en `Running`, sin mensajes de progreso CLIXML. Son observaciones de esos momentos; para una intervención futura volver a consultar el estado.

Se creó un respaldo manual a las 17:21:20 y se descargó por SCP a `respaldos/20261110-solo-notebook-final/predio-2026-11-10-17-21-20-manual.db`, en la PC de Martín y fuera de Git. Tamaño: 2621440 bytes; `PRAGMA quick_check` devolvió `ok`. El SHA256 local coincidió con el remoto: `69e4358e506ca1a907e81d2886dc7e98d5fc52b30490387d539fd6b2fa4b6003`.

## Conectarse desde la PC de Martín

El proyecto raíz tiene `Conectar-Predio.ps1`; su copia versionada está en `BACKEND/predios/scripts/Conectar-Predio.ps1`. La configuración privada de conexión está en `C:\Users\marti\.ssh\ajb_predio_config` y usa el alias `ajb-miramar`.

```powershell
.\Conectar-Predio.ps1 -Estado
.\Conectar-Predio.ps1 hostname
ssh.exe -F "$env:USERPROFILE\.ssh\ajb_predio_config" ajb-miramar
```

La sesión remota es Windows. Para comandos de PowerShell complejos usar `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>`; así se evita que `cmd.exe` interprete comillas o variables. `Conectar-Predio.ps1 -Estado` sirve de ejemplo. No imprimir contraseñas, tokens de la aplicación, claves privadas ni archivos de configuración completos.

Para scripts largos, no enviar todo el contenido en `-EncodedCommand`: la línea completa puede superar el límite de unos 8KB de `cmd.exe`. Enviar el script UTF8 como Base64 por stdin y usar sólo un cargador corto en `-EncodedCommand`:

```powershell
$codigo = Get-Content -LiteralPath '.\consulta.ps1' -Raw -Encoding UTF8
$contenidoBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($codigo))
$cargador = @'
$ProgressPreference = 'SilentlyContinue'
& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))))
'@
$cargadorBase64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cargador))
$contenidoBase64 | ssh.exe -F "$env:USERPROFILE\.ssh\ajb_predio_config" ajb-miramar powershell.exe -NoProfile -NonInteractive -EncodedCommand $cargadorBase64
```

Las identidades verificadas se guardan en `C:\Users\marti\.ssh\ajb_predio_known_hosts`. La notebook usa `HostKeyAlias ajb-miramar-mantenimiento`; AWS usa `52.67.192.228`. Fingerprints Ed25519 verificados:

- Host AWS: `SHA256:jTJ6QfY3IC5JukhgRg+ObYsDGuO74cQdGJqI5EoPlHs`.
- Host de la notebook: `SHA256:OcEGXO0pZ3AB1crkGIRg+aNjFe5iV0ZEtCbldHhFBP8`.
- Clave de cliente del túnel de la notebook, autorizada en AWS: `SHA256:F/qrUm7AXuUEMy/YqCvgl5HK+fMFE4zaXlwqBzL5J4Y`.

No aceptar un resultado de `ssh-keyscan` sin cotejarlo con un canal previamente confiable.

Claves privadas, fuera de Git:

- Operador de la notebook: `C:\Users\marti\.ssh\ajb_miramar_mantenimiento` (ACL de usuario y SYSTEM).
- Salto AWS existente: `C:\Users\marti\Desktop\miajb-backend.pem`.
- Identidad de túnel: `C:\ProgramData\AJB\Mantenimiento\tunel_ed25519`, exclusivamente en la notebook. No extraerla.

Una IA que trabaje en esta PC puede usar estos archivos sin RustDesk. Un entorno remoto o una PC distinta no obtiene acceso por leer este documento: necesita una clave de operador autorizada y acceso al salto AWS. No copiar claves privadas al repositorio, a chats, a paquetes del predio ni a servicios externos.

## Recorrido de la conexión

```text
PC de Martín -- SSH22 / ubuntu --> AWS 52.67.192.228
                                 127.0.0.1:22099
                                         |
                         túnel SSH iniciado por la notebook
                                         |
                              notebook 127.0.0.1:2222
                              usuario ajbmantenimiento
                                         |
                               servicios 192.168.1.x
```

La notebook sale hacia `52.67.192.228:22222` como `ajb-miramar-tunnel`. Ese usuario sólo puede publicar `127.0.0.1:22099`; no puede abrir una consola en AWS, usar SFTP ni redirigir otros puertos. El puerto 22099 no se publica en Internet. El listener 22222 acepta únicamente la clave pública de túnel autorizada. El SSH22 administrativo conserva sus restricciones de origen existentes.

El servidor Windows escucha exclusivamente en `127.0.0.1:2222`, admite sólo `ajbmantenimiento` y autentica con claves. Esta cuenta es administradora de la notebook. Tiene una contraseña aleatoria que no se guarda ni se usa para el acceso. El usuario SSH de AWS no obtiene por sí solo acceso administrativo a Windows.

La tarea SYSTEM `AJB Mantenimiento SSH Tunel` inicia al arrancar Windows, reintenta 10 segundos después de terminar una conexión y vuelve a lanzarse cada 5 minutos si terminó. SSH comprueba la conexión cada 30 segundos y tolera tres respuestas perdidas. El servicio `sshd` arranca automáticamente; el supervisor del túnel no lo reinicia. Ambos son independientes de `AJB Predio`. La notebook debe estar encendida, despierta y con Internet para acceder desde fuera. Una caída de Internet no cambia el funcionamiento local del sistema del predio.

## Equipos conocidos y acceso a la LAN

| Equipo | Dirección observada | Función |
| --- | --- | --- |
| `ajbmiramar` | `192.168.1.99` | Notebook, único servidor con escritura |
| `desktop-mn7m56l` | `192.168.1.122` | PC cliente; relevo automático suspendido |
| `dm` | `192.168.1.69` | PC cliente; relevo automático suspendido |

Las direcciones son las observadas en noviembre de 2026; confirmar si cambia DHCP. Servicios del predio: HTTP8080 y HTTPS8443. El 10/11 se verificaron TCP8080 y HTTP200 a `/api/estado-publico` en `192.168.1.122` y `192.168.1.69`, también después de reconectar el túnel. Estas PCs pueden responder como proxy de la notebook; esa respuesta no las convierte en escritoras. Los respaldos no pueden asumir escritura mientras siga el modo `soloPrincipal` sostenido.

Ejemplo para acceder al HTTP del predio desde esta PC (mantener la terminal abierta):

```powershell
ssh.exe -F "$env:USERPROFILE\.ssh\ajb_predio_config" -N -L 127.0.0.1:18080:127.0.0.1:8080 ajb-miramar
# Abrir http://127.0.0.1:18080
```

Para llegar a un servicio de otra PC, cambiar el destino:

```powershell
ssh.exe -F "$env:USERPROFILE\.ssh\ajb_predio_config" -N -L 127.0.0.1:18122:192.168.1.122:8080 ajb-miramar
ssh.exe -F "$env:USERPROFILE\.ssh\ajb_predio_config" -N -D 127.0.0.1:1080 ajb-miramar
```

El segundo comando habilita un proxy SOCKS5 local. Un cliente compatible puede usarlo para servicios TCP de la LAN. No convierte esta PC en miembro de la LAN para broadcast, UDP o descubrimiento automático. Tampoco elimina la autenticación de las otras PCs: administrar sus Windows exige sus credenciales o una clave autorizada y que SSH/RDP/WinRM esté configurado en cada una. No se habilitan esos servicios automáticamente.

## Archivos y diagnóstico

Notebook: `C:\ProgramData\AJB\Mantenimiento` (ACL SYSTEM/Administradores).

- `conexion.json`, `known_hosts`, `ssh_config`: parámetros del túnel y pin de AWS.
- `authorized_keys`: claves públicas de operadores autorizados.
- `ssh_host_ed25519_key.pub`: identidad pública de la notebook.
- `mantener-tunel-ssh.ps1`: supervisor independiente.
- `instalacion.json`, `instalacion.log`, `tunel.log`, `ssh-cliente.log`: instalación y diagnóstico. Los logs del túnel rotan a 2MB al reconectar.
- `C:\ProgramData\ssh\sshd_config`: configuración Windows marcada `AJB_MANTENIMIENTO_SSH_V1`.

AWS: servicio `ajb-miramar-relay.service`. Consultar los nombres exactos de configuración, autorización y recuperación en `predios/scripts/configurar-relay-mantenimiento.sh`. SSH22 y el servicio de la aplicación se mantienen separados.

```bash
sudo systemctl status ajb-miramar-relay.service --no-pager
sudo journalctl -u ajb-miramar-relay.service -n 50 --no-pager
sudo ss -ltnp 'sport = :22099'
```

Si SSH22 no responde desde esta PC, comprobar la IP pública actual contra el grupo AWS `sg-0b5c02df518400a6e`. No abrir el puerto administrativo a todo Internet. Si SSH22 responde pero no 22099, revisar la notebook, su Internet y la tarea del túnel. Si falta acceso remoto completo, RustDesk sigue siendo una vía de recuperación.

## Revocar o reactivar

Para revocar desde la notebook, crear el archivo `C:\ProgramData\AJB\Mantenimiento\DESHABILITADO`, deshabilitar y detener la tarea `AJB Mantenimiento SSH Tunel`, y detener `sshd`. Finalizar también el cliente SSH del túnel si sigue vivo; identificarlo por su línea de comandos y no detener otros procesos SSH indiscriminadamente. El archivo evita reconexiones futuras; no corta por sí solo una sesión ya establecida. Deshabilitar la cuenta `ajbmantenimiento` si se quiere revocar también la identidad Windows.

Para cortar inmediatamente desde AWS, ejecutar `sudo systemctl disable --now ajb-miramar-relay.service`. Su configuración `KillMode=control-group` termina también las sesiones hijas. Quitar la regla de entrada TCP22222 y la clave pública autorizada si se retira definitivamente. No borrar las claves del predio ni cambiar `soloPrincipal`: mantenimiento y relevo son mecanismos independientes.

Para reactivar Windows, revisar las claves autorizadas, retirar deliberadamente `DESHABILITADO`, habilitar la cuenta/servicio/tarea y comprobar los fingerprints. En AWS, restaurar la clave pública con `configurar-relay-mantenimiento.sh --authorize-key <archivo.pub>`, comprobar UFW y la regla TCP22222 del SG, y ejecutar `sudo systemctl enable --now ajb-miramar-relay.service`. Después verificar `Conectar-Predio.ps1 -Estado` y un forward. Nunca usar `StrictHostKeyChecking=no` ante un cambio de identidad.

Repetir el instalador con otra clave pública de operador agrega esa clave a `authorized_keys`; no revoca la anterior. Una rotación requiere retirar explícitamente la línea anterior y terminar las sesiones correspondientes.

## Cómo se instaló

El paquete firmado del predio incluye los scripts Windows pero no los ejecuta por una actualización normal. Una orden `PREPARAR_ACCESO_SSH` dirigida a la identidad física y a la instancia original de MIRAMAR contiene una autorización Ed25519 con vencimiento. El agente verifica esa firma con la clave pública fijada y ejecuta únicamente el instalador local fijo. No recibe comandos arbitrarios ni scripts desde la central. La orden devuelve sólo claves públicas y estado; las claves privadas se generan en su equipo de uso.

La misma ruta admite la acción firmada `DIAGNOSTICAR_ACCESO_SSH`. Ejecuta `diagnosticar-mantenimiento-ssh.ps1` con lecturas fijas y devuelve presencia de archivos, servicios, tareas, procesos, estados numéricos CBS, reinicio pendiente y eventos de log clasificados. No devuelve líneas de log libres, contraseñas ni claves privadas; no instala componentes ni invoca DISM. Este diagnóstico ya se ejecutó correctamente en la notebook mediante las órdenes 30 y 32.

El instalador usa `Add-WindowsCapability -LimitAccess`: no inicia búsquedas ni descargas en Windows Update/WSUS. Si falta el contenido local, registra la necesidad de revisar una fuente oficial **Features on Demand (FoD)** correspondiente a la versión de Windows. Primero obtener el diagnóstico; no repetir instalaciones a ciegas ni cambiar las políticas de Windows Update. [Opciones oficiales de DISM](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/dism-capabilities-package-servicing-command-line-options?view=windows-11)

Un mutex impide dos preparaciones AJB simultáneas. Antes de invocar DISM se comprueba si hay `TiWorker`, `dism` o `dismhost`; si aparecen, el instalador termina con HRESULT `-2147023278` (Windows 1618, instalación en curso). Esta comprobación es conservadora: puede rechazar un `TiWorker` ocioso y no impide que Windows inicie otra operación después. Los estados pendientes o parciales de OpenSSH devuelven `-2147021886` (Windows 3010) sin repetir `Add-WindowsCapability`; completar primero el servicing de Windows y verificar si requiere reinicio. Se evalúan ambos componentes antes de instalar cualquiera y nunca se reinicia Windows automáticamente.

Fuentes de configuración: [OpenSSH en Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration), [claves de Windows OpenSSH](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) y [opciones de sshd](https://man.openbsd.org/sshd_config).
