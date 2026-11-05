# Exporta del sistema anterior del camping (AJBGestion, base Access .mdb) lo necesario
# para importar el catalogo: productos, proveedores y la actividad reciente (ventas,
# compras y solicitudes) que sirve para elegir que productos siguen en uso.
#
# Uso (en una PC con Windows; el driver Jet de Access es de 32 bits y el script se
# relanza solo en PowerShell de 32 bits):
#   powershell -ExecutionPolicy Bypass -File exportar-access.ps1 -Mdb "C:\...\Data.mdb" -Clave "..." -Salida C:\temp\access -Desde 2024-12-01
# Despues: node convertir.js --entrada C:\temp\access --salida catalogo.json
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [string]$Clave = "",
  [Parameter(Mandatory = $true)][string]$Salida,
  [string]$Desde = "2024-12-01"
)
$ErrorActionPreference = "Stop"

if ([Environment]::Is64BitProcess) {
  $ps32 = Join-Path $env:WINDIR "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  & $ps32 -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Mdb $Mdb -Clave $Clave -Salida $Salida -Desde $Desde
  exit $LASTEXITCODE
}

if ($Desde -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "-Desde tiene que ser una fecha AAAA-MM-DD" }
New-Item -ItemType Directory -Force $Salida | Out-Null
$cadena = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$Mdb;Mode=Read"
if ($Clave) { $cadena += ";Jet OLEDB:Database Password=$Clave" }
$cn = New-Object System.Data.OleDb.OleDbConnection($cadena)
$cn.Open()

function Exportar([string]$sql, [string]$archivo) {
  $cmd = $cn.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 600
  $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
  $dt = New-Object System.Data.DataTable
  [void]$da.Fill($dt)
  $sb = New-Object System.Text.StringBuilder
  $cols = @($dt.Columns | ForEach-Object { $_.ColumnName })
  [void]$sb.AppendLine(($cols -join "`t"))
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  foreach ($r in $dt.Rows) {
    $vals = foreach ($c in $cols) {
      $v = $r[$c]
      if ($v -is [DBNull]) { "" }
      elseif ($v -is [DateTime]) { $v.ToString("yyyy-MM-dd HH:mm:ss") }
      elseif ($v -is [double] -or $v -is [decimal] -or $v -is [single]) { $v.ToString($inv) }
      else { ([string]$v) -replace "[`t`r`n]", " " }
    }
    [void]$sb.AppendLine(($vals -join "`t"))
  }
  $ruta = Join-Path $Salida $archivo
  [System.IO.File]::WriteAllText($ruta, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ("{0,7} filas  {1}" -f $dt.Rows.Count, $archivo)
}

$f = "#$Desde#"
Exportar "SELECT ID_PRODUCTO, DESC_PRODUCTO, CODIGO, VALOR_COMPRA, VALOR_VENTA, TIPO_DESTINO, PERECEDERO, MARGEN FROM ABM_PRODUCTOS" "productos.tsv"
Exportar "SELECT * FROM PROVEEDORES" "proveedores.tsv"
Exportar "SELECT d.PRODUCTO, h.PROVEEDOR, h.FACTURA_FECHA, h.FECHA_CARGA, d.PRECIO_UNITARIO FROM COMPRAS_DETALLE d INNER JOIN COMPRAS_HEADER h ON (d.CODIGO = h.CODIGO AND d.ID_EMPRESA = h.ID_EMPRESA) WHERE h.FECHA_ANULACION IS NULL AND d.FECHA_ANULACION IS NULL AND (h.FACTURA_FECHA >= $f OR h.FECHA_CARGA >= $f)" "compras.tsv"
Exportar "SELECT PRODUCTO, MAX(FECHA_SOLICITUD) AS ULTIMA FROM SOLICITUDES WHERE FECHA_SOLICITUD >= $f GROUP BY PRODUCTO" "solicitudes.tsv"
$tablas = $cn.GetSchema("Tables") | Where-Object { $_.TABLE_TYPE -eq "TABLE" -and $_.TABLE_NAME -like "VENTAS_*" } | ForEach-Object { $_.TABLE_NAME }
foreach ($t in $tablas) {
  Exportar "SELECT DESCRIPCION, FECHA, PRECIO FROM [$t] WHERE FECHA_ANULADA IS NULL AND FECHA >= $f" ("ventas-" + $t.Substring(7).ToLower() + ".tsv")
}
$cn.Close()
Write-Output "Listo: $Salida"
