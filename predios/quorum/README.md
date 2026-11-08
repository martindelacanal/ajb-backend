# Coordinador LAN de Predios

El instalador portable incluye `windows/ajb-quorum.exe`. La aplicación supervisa
este proceso y le entrega su configuración por un pipe. El coordinador mantiene
un registro Raft durable para el grupo. La base de ventas se replica aparte con
el protocolo de copias cifradas de Predios.

Para reconstruir el binario distribuido con Go 1.26.10 desde esta carpeta:

```powershell
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
go build -buildvcs=false -trimpath -ldflags '-s -w' -o ../windows/ajb-quorum.exe .
```

Las licencias de las dependencias compiladas se distribuyen en
`windows/ajb-quorum-licencias.txt`. El paquete firmado de Predios incluye el
binario, sus licencias y los scripts Windows.
