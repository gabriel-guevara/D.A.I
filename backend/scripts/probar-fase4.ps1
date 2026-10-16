<#
  Pruebas manuales de la Fase 4 (versiones y papelera) contra la API LOCAL, desde PowerShell.
  Funciona en Windows PowerShell 5.1 y en PowerShell 7. No guarda contraseñas ni códigos en ningún archivo.

  Uso (desde la carpeta backend, con la API corriendo en otra ventana: npm run dev):
      powershell -ExecutionPolicy Bypass -File .\scripts\probar-fase4.ps1
  (-ExecutionPolicy Bypass solo afecta a ESTA ejecución; no cambia la configuración de Windows.)

  Ojo con el código 2FA: cada código sirve UNA vez. Si acabas de usarlo para entrar, espera a que tu app
  muestre el siguiente (máx. 30 s) antes de purgar o vaciar; si no, el servidor responde "ya usado".
#>
param(
  [string]$Api = 'http://127.0.0.1:3000/api',
  [string]$Correo = 'e.ramos@dai.corp'
)

$ErrorActionPreference = 'Stop'
$script:H = @{}

# Llama a la API con el cuerpo en UTF-8 (en PowerShell 5.1, una contraseña con "ñ" o tildes llegaría mal).
# Si el servidor responde con error, muestra su mensaje en español y devuelve $null en lugar de detener el script.
function Llamar([string]$Metodo, [string]$Ruta, $Cuerpo = $null) {
  $params = @{ Method = $Metodo; Uri = "$Api$Ruta"; Headers = $script:H }
  if ($null -ne $Cuerpo) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [Text.Encoding]::UTF8.GetBytes(($Cuerpo | ConvertTo-Json -Compress))
  }
  try { return Invoke-RestMethod @params }
  catch { Mostrar-Error $_; return $null }
}

function Mostrar-Error($e) {
  $estado = $null
  try { $estado = [int]$e.Exception.Response.StatusCode } catch { }
  $mensaje = $e.ErrorDetails.Message
  try { $mensaje = ($mensaje | ConvertFrom-Json).error } catch { }
  if (-not $mensaje) { $mensaje = $e.Exception.Message }
  Write-Host "  ERROR $estado : $mensaje" -ForegroundColor Red
}

function Pedir-Codigo([string]$Para) {
  return (Read-Host "Código de 6 dígitos de tu app para $Para (si ya usaste el actual, espera al siguiente)").Trim()
}

function Pedir-Id([string]$Que) {
  $id = (Read-Host "Id del $Que (el número que aparece en la URL o en la lista)").Trim()
  if ($id -notmatch '^\d+$') { Write-Host '  Debe ser un número.' -ForegroundColor Yellow; return $null }
  return $id
}

# ------------------------------------------------------------------------------------------- login
Write-Host "API: $Api   Usuario: $Correo" -ForegroundColor Cyan
$seguro = Read-Host 'Contraseña' -AsSecureString
$plano = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro))
$l = Llamar 'Post' '/auth/login' @{ username = $Correo; password = $plano }
$plano = $null
if (-not $l) { exit 1 }
if ($l.paso -ne '2fa') { Write-Host 'Este usuario aún no tiene 2FA: entra primero por la web y configúralo.' -ForegroundColor Yellow; exit 1 }
$s = Llamar 'Post' '/auth/verify-2fa' @{ mfaToken = $l.mfaToken; code = (Pedir-Codigo 'ENTRAR') }
if (-not $s) { exit 1 }
$script:H = @{ Authorization = "Bearer $($s.token)" }
Write-Host "Sesión abierta como $($s.user.name) ($($s.user.role))." -ForegroundColor Green

# ------------------------------------------------------------------------------------------- pasos
function Paso7 {
  $id = Pedir-Id 'documento'; if (-not $id) { return }
  $h = Llamar 'Get' "/documentos/$id/versiones"; if (-not $h) { return }
  foreach ($v in $h.versiones) {
    if (-not $v.tieneArchivo) { Write-Host "  $($v.version): sin archivo original (registro histórico)"; continue }
    $destino = Join-Path ([IO.Path]::GetTempPath()) "dai-$id-$($v.version).pdf"
    try {
      # -UseBasicParsing: en PowerShell 5.1 evita el error del motor de Internet Explorer.
      Invoke-WebRequest -UseBasicParsing -Uri "$Api/documentos/$id/versiones/$($v.id)/descarga" -Headers $script:H -OutFile $destino
    } catch { Mostrar-Error $_; continue }
    $calculado = (Get-FileHash $destino -Algorithm SHA256).Hash.ToLower()   # Get-FileHash lo da en MAYÚSCULAS
    $ok = $calculado -eq $v.hash
    $actual = ''; if ($v.actual) { $actual = ' (actual)' }
    Write-Host ("  {0}{1}: {2}" -f $v.version, $actual, $(if ($ok) { 'COINCIDE' } else { 'NO COINCIDE' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
    Write-Host "     servidor : $($v.hash)"
    Write-Host "     calculado: $calculado"
    Write-Host "     archivo  : $destino"
  }
}

function Lista-Papelera {
  $p = Llamar 'Get' '/papelera'; if (-not $p) { return $null }
  if (-not $p.documentos.Count) { Write-Host '  La papelera está vacía.' }
  $p.documentos | Select-Object id, nombre, folio, retencionHasta, purgaAutomatica | Format-Table -AutoSize | Out-Host
  return $p
}

function Paso14 {
  $p = Lista-Papelera; if (-not $p -or -not $p.documentos.Count) { return }
  $id = Pedir-Id 'documento a PURGAR (irreversible)'; if (-not $id) { return }
  $r = Llamar 'Post' "/papelera/$id/purgar" @{ code = (Pedir-Codigo 'PURGAR') }
  if ($r) { Write-Host "  Purgado: $($r.versiones) versión(es), $($r.objetos) archivo(s) a borrar del almacenamiento." -ForegroundColor Green }
}

function Paso15 {
  $id = Pedir-Id 'documento'; if (-not $id) { return }
  $a = Llamar 'Get' "/documentos/$id/auditoria"
  if ($a) { $a | Select-Object fecha, accion, usuario | Format-Table -AutoSize | Out-Host }
}

function Paso17 {
  $p = Lista-Papelera; if (-not $p -or -not $p.documentos.Count) { return }
  if ((Read-Host 'Escribe VACIAR para purgar todo lo purgable') -cne 'VACIAR') { Write-Host '  Cancelado.'; return }
  $r = Llamar 'Post' '/papelera/vaciar' @{ code = (Pedir-Codigo 'VACIAR') }
  if ($r) { Write-Host "  Purgados: $($r.purgados). Con retención legal (se conservan): $($r.enRetencion). Restantes: $($r.restantes)." -ForegroundColor Green }
}

while ($true) {
  Write-Host ''
  Write-Host '7) Descargar las versiones de un documento y comparar su SHA-256'
  Write-Host 'P) Ver la papelera'
  Write-Host '14) Purgar un documento de la papelera (pide código 2FA)'
  Write-Host '15) Ver la auditoría de un documento (también purgado)'
  Write-Host '17) Vaciar la papelera (pide código 2FA)'
  Write-Host 'S) Salir'
  switch ((Read-Host 'Opción').Trim().ToUpper()) {
    '7'  { Paso7 }
    'P'  { [void](Lista-Papelera) }
    '14' { Paso14 }
    '15' { Paso15 }
    '17' { Paso17 }
    'S'  { exit 0 }
    default { Write-Host '  Opción no válida.' }
  }
}
