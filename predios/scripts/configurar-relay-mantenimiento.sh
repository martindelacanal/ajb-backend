#!/usr/bin/env bash
# Relay dedicado de mantenimiento de Miramar. Ejecutar como root en el EC2
# cuyo host key ya fue verificado. No modifica /etc/ssh/sshd_config, ssh.service,
# ssh.socket, el puerto 22 ni los Security Groups de AWS.
#
# Instalar sin habilitar ninguna clave:
#   sudo bash configurar-relay-mantenimiento.sh --install
# Instalar y autorizar la clave pública ED25519 de la notebook:
#   sudo bash configurar-relay-mantenimiento.sh --install --authorize-key /ruta/notebook.pub
# Reemplazar la única clave autorizada (revoca conexiones anteriores):
#   sudo bash configurar-relay-mantenimiento.sh --authorize-key /ruta/notebook.pub
#
# Rollback operativo, sin borrar evidencias ni tocar el SSH administrativo:
#   sudo systemctl disable --now ajb-miramar-relay.service
#   sudo ufw delete allow 22222/tcp comment 'ajb-miramar-relay-v1'
# Conservar /etc/ajb-miramar-relay y la cuenta sin shell para auditoría.
# Eliminar también la regla 22222 del SG desde AWS si se había agregado allí.
#
# OpenSSH: MaxSessions 0 bloquea shell/exec/subsystems y permite forwarding.
# PermitListen distingue 127.0.0.1 de localhost: el cliente debe usar
# -R 127.0.0.1:22099:127.0.0.1:<puerto-local> y -N.
# https://man.openbsd.org/sshd_config https://man.openbsd.org/sshd
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

readonly RELAY_USER=ajb-miramar-tunnel
readonly SERVICE=ajb-miramar-relay.service
readonly RELAY_DIR=/etc/ajb-miramar-relay
readonly CONFIG="$RELAY_DIR/sshd_config"
readonly KEYS="$RELAY_DIR/authorized_keys"
readonly MARKER=ajb-miramar-relay-v1
readonly UNIT="/etc/systemd/system/$SERVICE"
readonly HOST_KEY=/etc/ssh/ssh_host_ed25519_key
# Verificado por el canal SSH administrativo previamente fijado, 2026-11-10.
readonly HOST_FINGERPRINT='SHA256:jTJ6QfY3IC5JukhgRg+ObYsDGuO74cQdGJqI5EoPlHs'
install_requested=0
key_file=
stage=
mutated=0

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'Uso: %s [--install] [--authorize-key ARCHIVO_PUBLICO_ED25519]\n' "$0"
}
while (($#)); do
  case "$1" in
    --install) ((install_requested == 0)) || fail 'Opción --install repetida'; install_requested=1; shift ;;
    --authorize-key)
      [[ $# -ge 2 && -z "$key_file" ]] || fail 'Falta el archivo público o la opción está repetida'
      key_file=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Opción desconocida: $1" ;;
  esac
done
((install_requested)) || [[ -n "$key_file" ]] || { usage >&2; exit 1; }
((EUID == 0)) || fail 'Ejecutar como root'
for command in sshd ssh-keygen systemctl ufw ss flock stat getent id useradd chpasswd chage openssl sudo install mktemp cmp awk grep; do
  command -v "$command" >/dev/null || fail "Falta la herramienta: $command"
done
[[ -x /usr/sbin/nologin ]] || fail 'Falta /usr/sbin/nologin'

safe_root_path() {
  [[ ! -L "$1" && -e "$1" ]] || fail "Ruta inexistente o enlace no permitido: $1"
  [[ $(stat -c %u "$1") == 0 ]] || fail "La ruta no pertenece a root: $1"
  local mode
  mode=$(stat -c %a "$1")
  (( (8#$mode & 0022) == 0 )) || fail "La ruta permite escritura ajena: $1"
}
for parent in /etc /etc/systemd /etc/systemd/system /run; do
  safe_root_path "$parent"
done
readonly LOCK=/run/ajb-miramar-relay-install.lock
if [[ -e "$LOCK" || -L "$LOCK" ]]; then safe_root_path "$LOCK"; fi
exec 9>"$LOCK"
flock -n 9 || fail 'Ya hay otra configuración del relay en curso'
safe_root_path "$HOST_KEY"
fingerprint=$(ssh-keygen -y -f "$HOST_KEY" < /dev/null | ssh-keygen -lf - -E sha256 | awk '{print $2}')
[[ "$fingerprint" == "$HOST_FINGERPRINT" ]] || fail 'La identidad SSH del servidor no coincide con el pin de Miramar'

managed=0
if [[ -e "$RELAY_DIR" || -L "$RELAY_DIR" ]]; then
  safe_root_path "$RELAY_DIR"
  [[ -d "$RELAY_DIR" ]] || fail 'La ruta del relay no es un directorio'
  safe_root_path "$RELAY_DIR/managed-by"
  [[ $(cat "$RELAY_DIR/managed-by") == "$MARKER" ]] || fail 'El directorio corresponde a otro recurso'
  managed=1
fi
((managed || install_requested)) || fail 'Primero ejecutar --install'
load_state= fragment= dropins= control_group=
# systemctl puede devolver código no cero para una unidad todavía inexistente.
# Sólo ese estado explícito es aceptable; no ocultar fallas de conexión al bus.
unit_information=$(systemctl show "$SERVICE" -p LoadState -p FragmentPath -p DropInPaths -p ControlGroup 2>/dev/null) ||
  [[ "$unit_information" == *'LoadState=not-found'* ]] || fail 'No se pudo consultar systemd'
while IFS= read -r property; do
  case "$property" in
    LoadState=*) load_state=${property#*=} ;;
    FragmentPath=*) fragment=${property#*=} ;;
    DropInPaths=*) dropins=${property#*=} ;;
    ControlGroup=*) control_group=${property#*=} ;;
  esac
done <<<"$unit_information"
[[ "$load_state" == loaded || "$load_state" == not-found ]] || fail 'La unidad existente no está en un estado administrable'
[[ -z "$dropins" && ! -e "$UNIT.d" && ! -L "$UNIT.d" ]] || fail 'La unidad tiene overrides ajenos'
[[ -z "$fragment" || "$fragment" == "$UNIT" ]] || fail 'Ya existe una unidad con otro origen'
for target in "$CONFIG" "$KEYS" "$UNIT"; do
  if [[ -e "$target" || -L "$target" ]]; then
    ((managed)) || fail "Ya existe un recurso no administrado: $target"
    safe_root_path "$target"
    [[ -f "$target" ]] || fail "El recurso no es un archivo: $target"
    [[ $(head -n 1 "$target") == "# $MARKER" ]] || fail "Falta la marca de propiedad: $target"
  fi
done
if getent passwd "$RELAY_USER" >/dev/null || getent group "$RELAY_USER" >/dev/null; then
  ((managed)) || fail 'La cuenta o el grupo ya existían y no pertenecen a este relay'
fi

check_account() {
  local entry name password uid gid comment account_home account_shell shadow hash sudo_listing
  entry=$(getent passwd "$RELAY_USER") || fail 'La cuenta del relay no existe'
  IFS=: read -r name password uid gid comment account_home account_shell <<<"$entry"
  [[ "$name" == "$RELAY_USER" && "$comment" == "$MARKER" && "$account_home" == /nonexistent && "$account_shell" == /usr/sbin/nologin ]] || fail 'La identidad de la cuenta no corresponde al relay'
  ((uid > 0 && uid < 1000)) || fail 'La cuenta no es una cuenta de sistema sin privilegios'
  [[ $(id -gn "$RELAY_USER") == "$RELAY_USER" && $(id -Gn "$RELAY_USER") == "$RELAY_USER" ]] || fail 'La cuenta tiene grupos no permitidos'
  shadow=$(getent shadow "$RELAY_USER")
  IFS=: read -r name hash _ <<<"$shadow"
  [[ "$hash" == '$6$'* && "$hash" != *'!'* ]] || fail 'La cuenta está bloqueada o tiene una contraseña fuera de la política del relay'
  # Consultado por root, sudo -l puede devolver 0 incluso ante una denegación.
  # Aceptar únicamente su respuesta negativa explícita en LC_ALL=C; cualquier
  # permiso, error de política o salida ambigua interrumpe la configuración.
  sudo_listing=$(sudo -n -l -U "$RELAY_USER" 2>&1) || true
  [[ "$sudo_listing" =~ ^User\ ajb-miramar-tunnel\ is\ not\ allowed\ to\ run\ sudo\ on\ [^[:space:]]+\.$ ]] || fail 'No se pudo acreditar que la cuenta carezca de permisos sudo'
}
if getent passwd "$RELAY_USER" >/dev/null; then check_account; fi

# No apropiarse de un puerto ocupado por otra unidad, incluso en una reinstalación.
for port in 22222 22099; do
  listeners=$(ss -H -ltnp "sport = :$port")
  if [[ -n "$listeners" ]]; then
    ((managed)) && [[ -n "$control_group" ]] || fail "El puerto $port ya está ocupado"
    pids=$(grep -oE 'pid=[0-9]+' <<<"$listeners" | cut -d= -f2 | sort -u)
    [[ -n "$pids" ]] || fail "No se pudo acreditar el dueño del puerto $port"
    while IFS= read -r process_id; do
      awk -F: -v expected="$control_group" '$3 == expected { found=1 } END { exit !found }' "/proc/$process_id/cgroup" || fail "El puerto $port pertenece a otro servicio"
    done <<<"$pids"
  fi
done
rules=$(ufw show added)
while IFS= read -r rule; do
  if [[ "$rule" == *22222* ]]; then
    [[ "$rule" == "ufw allow 22222/tcp comment '$MARKER'" ]] || fail 'Hay una regla UFW ajena que menciona el puerto 22222'
  fi
done <<<"$rules"

stage=$(mktemp -d /tmp/ajb-miramar-relay.XXXXXXXX)
cleanup() {
  local result=$?
  trap - EXIT
  if ((result != 0 && mutated)); then
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    printf 'El relay dedicado quedó detenido tras el error. SSH administrativo no fue modificado.\n' >&2
  fi
  if [[ -n "$stage" && "$stage" == /tmp/ajb-miramar-relay.* ]]; then
    rm -f -- "$stage/sshd_config" "$stage/service" "$stage/authorized_keys" "$stage/public_key"
    rmdir -- "$stage"
  fi
  exit "$result"
}
trap cleanup EXIT

if [[ -n "$key_file" ]]; then
  [[ -f "$key_file" && ! -L "$key_file" && $(stat -c %s "$key_file") -le 4096 ]] || fail 'El archivo debe contener una sola clave pública pequeña'
  mapfile -t key_lines < "$key_file"
  ((${#key_lines[@]} == 1)) || fail 'Se requiere exactamente una línea de clave pública'
  key_line=${key_lines[0]%$'\r'}
  [[ "$key_line" =~ ^ssh-ed25519[[:space:]]+([A-Za-z0-9+/]+={0,2})([[:space:]].*)?$ ]] || fail 'Sólo se acepta una clave pública ED25519 sin opciones'
  key_blob=${BASH_REMATCH[1]}
  printf 'ssh-ed25519 %s\n' "$key_blob" > "$stage/public_key"
  ssh-keygen -lf "$stage/public_key" -E sha256 >/dev/null || fail 'La clave pública no es válida'
  printf '# %s\nrestrict,port-forwarding,permitlisten="127.0.0.1:22099",command="/usr/sbin/nologin" ssh-ed25519 %s ajb-miramar-notebook\n' "$MARKER" "$key_blob" > "$stage/authorized_keys"
fi

cat > "$stage/sshd_config" <<EOF
# $MARKER
Port 22222
AddressFamily inet
ListenAddress 0.0.0.0
HostKey $HOST_KEY
HostKeyAlgorithms ssh-ed25519
PidFile /run/ajb-miramar-relay/sshd.pid
AllowUsers $RELAY_USER
StrictModes yes
UsePAM no
PermitRootLogin no
PubkeyAuthentication yes
PubkeyAcceptedAlgorithms ssh-ed25519
AuthenticationMethods publickey
AuthorizedKeysFile $KEYS
AuthorizedKeysCommand none
AuthorizedPrincipalsFile none
TrustedUserCAKeys none
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
HostbasedAuthentication no
GSSAPIAuthentication no
MaxSessions 0
ForceCommand /usr/sbin/nologin
PermitTTY no
PermitUserRC no
PermitUserEnvironment no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
AllowTcpForwarding remote
AllowStreamLocalForwarding no
GatewayPorts no
PermitListen 127.0.0.1:22099
PermitOpen none
ClientAliveInterval 30
ClientAliveCountMax 3
TCPKeepAlive yes
LoginGraceTime 30
MaxAuthTries 3
MaxStartups 3:30:10
UseDNS no
PrintMotd no
PrintLastLog no
LogLevel VERBOSE
SyslogFacility AUTHPRIV
EOF
cat > "$stage/service" <<EOF
# $MARKER
[Unit]
Description=AJB Miramar dedicated maintenance SSH relay
After=network.target

[Service]
Type=simple
ExecStartPre=/usr/sbin/sshd -t -f $CONFIG
ExecStart=/usr/sbin/sshd -D -e -f $CONFIG
ExecReload=/bin/kill -HUP \$MAINPID
KillMode=control-group
Restart=on-failure
RestartSec=5s
RuntimeDirectory=ajb-miramar-relay
RuntimeDirectoryMode=0755
UMask=0077
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
# No archivo ni cuenta persistente se modifica antes de validar el candidato.
/usr/sbin/sshd -t -f "$stage/sshd_config"

mutated=1
if ((!managed)); then
  install -d -o root -g root -m 0755 "$RELAY_DIR"
  printf '%s\n' "$MARKER" > "$RELAY_DIR/managed-by"
  chmod 0644 "$RELAY_DIR/managed-by"
fi
if ! getent passwd "$RELAY_USER" >/dev/null; then
  getent group "$RELAY_USER" >/dev/null && fail 'Existe un grupo sin la cuenta administrada'
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment "$MARKER" "$RELAY_USER"
  # UsePAM=no rechaza cuentas con ! en shadow aun usando publickey. Se instala
  # un hash de secreto aleatorio que no se guarda ni se revela; sshd no ofrece
  # autenticación por contraseña y la cuenta no tiene shell ni permisos sudo.
  password_hash=$(openssl rand -base64 48 | openssl passwd -6 -stdin)
  printf '%s:%s\n' "$RELAY_USER" "$password_hash" | chpasswd --encrypted
  unset password_hash
  chage -E -1 -M -1 "$RELAY_USER"
fi
check_account
changed=0
write_managed() {
  local source=$1 destination=$2 temporary
  if [[ ! -e "$destination" ]] || ! cmp -s "$source" "$destination"; then
    temporary=$(mktemp "$destination.tmp.XXXXXXXX")
    install -o root -g root -m 0644 "$source" "$temporary"
    mv -f -- "$temporary" "$destination"
    changed=1
  fi
}
write_managed "$stage/sshd_config" "$CONFIG"
write_managed "$stage/service" "$UNIT"
if [[ -n "$key_file" ]]; then
  write_managed "$stage/authorized_keys" "$KEYS"
elif [[ ! -e "$KEYS" ]]; then
  printf '# %s\n' "$MARKER" > "$stage/authorized_keys"
  write_managed "$stage/authorized_keys" "$KEYS"
fi
/usr/sbin/sshd -t -f "$CONFIG"
systemctl daemon-reload
systemctl enable "$SERVICE"
if ((changed)); then systemctl restart "$SERVICE"; else systemctl start "$SERVICE"; fi
systemctl is-active --quiet "$SERVICE" || fail 'El relay no quedó activo'
ufw allow 22222/tcp comment "$MARKER"
printf 'Relay configurado: %s, usuario %s, escucha 22222/tcp; forward permitido 127.0.0.1:22099.\n' "$SERVICE" "$RELAY_USER"
printf 'Host key fijada: %s\n' "$HOST_FINGERPRINT"
if [[ -n "$key_file" ]]; then ssh-keygen -lf "$stage/public_key" -E sha256; else printf 'Sin cambios en las claves autorizadas.\n'; fi
printf 'El SG de AWS se administra por separado. No se modificó el SSH del puerto 22.\n'
