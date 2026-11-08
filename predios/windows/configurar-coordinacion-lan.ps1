# Permite que los miembros del grupo se encuentren y voten dentro de la LAN.
param([Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Puerto)

$ErrorActionPreference = 'Stop'

function Set-AjbReglaLan([string]$Nombre, [string]$Etiqueta, [string]$Protocolo, [int]$PuertoLocal) {
  $opciones = @{
    Name = $Nombre
    Direction = 'Inbound'
    Protocol = $Protocolo
    LocalPort = $PuertoLocal
    RemoteAddress = 'LocalSubnet'
    Action = 'Allow'
    Profile = 'Any'
    Enabled = 'True'
  }
  if (Get-NetFirewallRule -Name $Nombre -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule @opciones | Out-Null
  } else {
    New-NetFirewallRule @opciones -DisplayName $Etiqueta | Out-Null
  }
}

Set-AjbReglaLan 'AJB-Predio-Coordinacion-LAN' 'AJB Predio Coordinacion LAN' 'TCP' $Puerto
Set-AjbReglaLan 'AJB-Predio-Ubicacion-Quorum' 'AJB Predio Ubicacion LAN' 'UDP' 39879
