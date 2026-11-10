# Acceso de mantenimiento a Miramar

Preparación: 10 de noviembre de 2026. Solicitado por Martín para poder administrar la notebook y acceder a servicios de la LAN sin controlar el escritorio con RustDesk.

## Estado verificado de la preparación

**10/11/2026, 16:35 ART: conexión SSH a la notebook pendiente. No considerar este documento prueba de instalación completada.** Las secciones siguientes describen la configuración preparada y su uso previsto; todavía no se verificaron las rutas de acceso a Windows ni a las otras PCs.

- AWS: servicio `ajb-miramar-relay` instalado, activo y habilitado; listener 22222 restringido al usuario de túnel y al reenvío remoto `127.0.0.1:22099`. La lista de claves autorizadas sigue vacía. La regla EC2 es `sgr-02ba3581e1b4bc7d7`, grupo `sg-0b5c02df518400a6e`. El acceso administrativo SSH22 existente sigue funcionando.
- PC de Martín: clave de operador y configuración SSH creadas fuera de Git; identidad AWS verificada. Falta fijar la clave pública de host de la notebook en `ajb_predio_known_hosts`.
- Notebook: paquete `1.1.0+43490e7c85` instalado. La orden central 25 `PREPARAR_ACCESO_SSH`, iniciada aproximadamente a las 16:01 ART, no devolvió resultado. Se canceló en la central para impedir reentrega. No se confirmó qué fase de OpenSSH alcanzó. No iniciar otro DISM sin comprobar los procesos y registros existentes.
- Durante la preparación se observó CPU 97–99% con Windows Update/Defender y respuestas intermitentes de la aplicación. Se reinició solamente `servidor.js` (PID612 a PID9264), conservando su supervisor. HTTPS volvió a escuchar a las 16:26:38; el último heartbeat central observado fue 16:30:04, sin pendientes. El diagnóstico público aún no respondió de forma verificable desde el escritorio.
- Los logs confirman que la notebook conserva el único voto y las otras dos PCs son `Nonvoter`. No reactivar respaldos para resolver el mantenimiento SSH. El resultado de `SUBIR_LOGS` 26 fue OK; extracto local en `output/diagnostico-servidor-26.json` desde la raíz del proyecto.
- El control de escritorio se detuvo por una restricción de la herramienta al no poder identificar con certeza la URL del navegador. RustDesk queda abierto. Se había cambiado temporalmente su modo de teclado a **Modo heredado**; el modo original era **Modo mapa**.

Para continuar: verificar salud local y carga de Windows; leer `C:\ProgramData\AJB\Mantenimiento\instalacion.log`, estado de OpenSSH/sshd/tarea y procesos de servicing sin lanzar otra instalación; terminar la preparación idempotente si procede; autorizar sólo la clave pública del túnel en AWS; fijar la clave pública del host Windows obtenida por canal confiable; probar `hostname`, estado del sistema, acceso LAN y reconexión. No declarar operativo el acceso antes de estas comprobaciones.

## Conectarse desde la PC de Martín

El proyecto raíz tiene `Conectar-Predio.ps1`. La configuración privada de conexión está en `C:\Users\marti\.ssh\ajb_predio_config` y usa el alias `ajb-miramar`.

```powershell
.\Conectar-Predio.ps1 -Estado
.\Conectar-Predio.ps1 hostname
ssh.exe -F "$env:USERPROFILE\.ssh\ajb_predio_config" ajb-miramar
```

La sesión remota es Windows. Para comandos de PowerShell complejos usar `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>`; así se evita que `cmd.exe` interprete comillas o variables. `Conectar-Predio.ps1 -Estado` sirve de ejemplo. No imprimir contraseñas, tokens de la aplicación, claves privadas ni archivos de configuración completos.

Las identidades verificadas se guardan en `C:\Users\marti\.ssh\ajb_predio_known_hosts`. La notebook usa `HostKeyAlias ajb-miramar-mantenimiento`; AWS usa `52.67.192.228`. El fingerprint Ed25519 de AWS es `SHA256:jTJ6QfY3IC5JukhgRg+ObYsDGuO74cQdGJqI5EoPlHs`. No aceptar un resultado de `ssh-keyscan` sin cotejarlo con un canal previamente confiable.

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

Las direcciones son las observadas en noviembre de 2026; confirmar si cambia DHCP. Servicios del predio: HTTP8080 y HTTPS8443. Los respaldos no pueden asumir escritura mientras siga el modo `soloPrincipal` sostenido.

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

Fuentes de configuración: [OpenSSH en Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration), [claves de Windows OpenSSH](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) y [opciones de sshd](https://man.openbsd.org/sshd_config).
