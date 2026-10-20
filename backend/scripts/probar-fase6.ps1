<#
  Comprobaciones de la Fase 6 (carpetas y subcarpetas) contra la API LOCAL, desde PowerShell.
  Escrito para Windows PowerShell 5.1 y PowerShell 7. No guarda contraseñas ni códigos en ningún archivo.
  Se guarda en UTF-8 CON BOM: así Windows PowerShell 5.1 lee bien las tildes de los mensajes.

  Uso (desde la carpeta backend, con la API corriendo en otra ventana: npm run dev):
      powershell -ExecutionPolicy Bypass -File .\scripts\probar-fase6.ps1
      powershell -ExecutionPolicy Bypass -File .\scripts\probar-fase6.ps1 -Correo c.mendez@dai.corp
  (-ExecutionPolicy Bypass solo afecta a ESTA ejecución; no cambia la configuración de Windows.)

  Con permisos de gestión (Super Admin, Operador OCR) crea un árbol TEMPORAL «Prueba F6 <hora>» de 5 niveles,
  prueba los límites (400/409), mueve una subcarpeta y, si el rol puede eliminar (Super Admin), lo borra todo al final.
  Con Cumplimiento o Lector solo explora y comprueba que crear y mover dan 403. No toca documentos.
#>
param(
  [string]$Api = 'http://127.0.0.1:3000/api',
  [string]$Correo = 'e.ramos@dai.corp'
)

$ErrorActionPreference = 'Stop'
# Sin barra de progreso: en PowerShell 5.1 hace muy lentas las peticiones y tapa los mensajes de error.
$ProgressPreference = 'SilentlyContinue'
$script:H = @{}
$script:Fallos = 0

# Llama a la API (cuerpo en UTF-8) y devuelve @{ Estado = código HTTP; R = JSON de la respuesta o $null }.
# Nunca detiene el script por un 4xx: lo que se comprueba es justamente el código.
function Llamar([string]$Metodo, [string]$Ruta, $Cuerpo = $null) {
  $params = @{ Method = $Metodo; Uri = "$Api$Ruta"; Headers = $script:H; UseBasicParsing = $true }
  if ($null -ne $Cuerpo) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [Text.Encoding]::UTF8.GetBytes(($Cuerpo | ConvertTo-Json -Compress -Depth 5))
  }
  try {
    $w = Invoke-WebRequest @params
    $texto = [Text.Encoding]::UTF8.GetString($w.RawContentStream.ToArray())
    $json = $null
    if ($texto) { $json = $texto | ConvertFrom-Json }
    return @{ Estado = [int]$w.StatusCode; R = $json }
  } catch {
    $estado = 0
    try { $estado = [int]$_.Exception.Response.StatusCode } catch { }
    $json = $null
    try { $json = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
    if ($estado -eq 0) { Write-Host "  Sin respuesta de la API: $($_.Exception.Message)" -ForegroundColor Red }
    return @{ Estado = $estado; R = $json }
  }
}

# Comprueba el código HTTP esperado y lo informa en una línea.
function Esperar($Respuesta, [int]$Codigo, [string]$Que) {
  if ($Respuesta.Estado -eq $Codigo) { Write-Host "  OK ($Codigo) $Que" -ForegroundColor Green; return }
  $script:Fallos++
  $msg = ''
  if ($Respuesta.R -and $Respuesta.R.error) { $msg = $Respuesta.R.error }
  Write-Host "  FALLO: se esperaba $Codigo y llegó $($Respuesta.Estado) — $Que. $msg" -ForegroundColor Red
}

function Migas($Ruta) { return 'Inicio › ' + ((@($Ruta) | ForEach-Object { $_.nombre }) -join ' › ') }
function ErrorDe($Respuesta) { if ($Respuesta.R -and $Respuesta.R.error) { return $Respuesta.R.error } return '' }

# ------------------------------------------------------------------------------------------- login
Write-Host "API: $Api   Usuario: $Correo" -ForegroundColor Cyan
$seguro = Read-Host 'Contraseña' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
$plano = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$l = Llamar 'Post' '/auth/login' @{ username = $Correo; password = $plano }
$plano = $null
if ($l.Estado -ne 200) { Write-Host "  ERROR $($l.Estado): $(ErrorDe $l)" -ForegroundColor Red; exit 1 }
if ($l.R.paso -ne '2fa') { Write-Host 'Este usuario aún no tiene 2FA: entra primero por la web y configúralo.' -ForegroundColor Yellow; exit 1 }
$s = Llamar 'Post' '/auth/verify-2fa' @{ mfaToken = $l.R.mfaToken; code = (Read-Host 'Código de 6 dígitos de tu app').Trim() }
if ($s.Estado -ne 200) { Write-Host "  ERROR $($s.Estado): $(ErrorDe $s)" -ForegroundColor Red; exit 1 }
$script:H = @{ Authorization = "Bearer $($s.R.token)" }
Write-Host "Sesión abierta como $($s.R.user.name) ($($s.R.user.role), $($s.R.user.nivel))." -ForegroundColor Green

# ------------------------------------------------------------------------------------------- 1) explorar
Write-Host ''; Write-Host '1) Explorador: la raíz (Inicio)' -ForegroundColor Cyan
$r = Llamar 'Get' '/carpetas'; Esperar $r 200 'contenido de Inicio'
if ($r.Estado -ne 200) { exit 1 }
@($r.R.carpetas) | ForEach-Object { Write-Host "  📁 $($_.nombre) (#$($_.id)): $($_.documentos) documento(s) visible(s) · $($_.subcarpetas) subcarpeta(s)" }
Write-Host "  Documentos directamente en Inicio: $($r.R.documentosAqui) · Máximo de niveles: $($r.R.maxNivel)"
$p = $r.R.permisos
Write-Host "  Permisos: gestionar=$($p.gestionar) eliminar=$($p.eliminar) solicitar=$($p.solicitar) resolver=$($p.resolver)"
Esperar (Llamar 'Get' '/carpetas?padre=abc') 400 'padre no válido'
Esperar (Llamar 'Get' '/carpetas?padre=999999999') 404 'carpeta inexistente'
$a = Llamar 'Get' '/carpetas/arbol'; Esperar $a 200 "árbol completo: $(@($a.R.carpetas).Count) carpetas"
$t = Llamar 'Get' '/documentos?carpeta=sin&subcarpetas=1'; Esperar $t 200 "toda la biblioteca desde Inicio: $($t.R.total) documentos"
Esperar (Llamar 'Get' '/documentos?subcarpetas=si') 400 'subcarpetas solo admite 1'

if (-not $p.gestionar) {
  Write-Host ''; Write-Host '2) Este rol no gestiona carpetas' -ForegroundColor Cyan
  Esperar (Llamar 'Post' '/carpetas' @{ nombre = 'No debería crearse' }) 403 'crear'
  Esperar (Llamar 'Patch' '/carpetas/1' @{ padreId = $null }) 403 'mover carpeta'
} else {
  # ----------------------------------------------------------------------------------------- 2) crear
  Write-Host ''; Write-Host '2) Crear un árbol temporal de 5 niveles' -ForegroundColor Cyan
  $raiz = "Prueba F6 PS $(Get-Date -Format HHmmss)"
  $c = Llamar 'Post' '/carpetas' @{ nombre = $raiz }; Esperar $c 201 "nivel 1: «$raiz»"
  if ($c.Estado -ne 201) { exit 1 }
  $ids = New-Object System.Collections.ArrayList
  [void]$ids.Add($c.R.id)
  foreach ($n in 2..5) {
    $c = Llamar 'Post' '/carpetas' @{ nombre = "Nivel $n"; padreId = $ids[$ids.Count - 1] }; Esperar $c 201 "nivel $n"
    [void]$ids.Add($c.R.id)
  }
  $m = Llamar 'Get' "/carpetas/$($ids[4])/ruta"; Esperar $m 200 "migas: $(Migas $m.R.ruta)"
  $c = Llamar 'Post' '/carpetas' @{ nombre = 'Nivel 6'; padreId = $ids[4] }; Esperar $c 400 "sexto nivel: $(ErrorDe $c)"
  Esperar (Llamar 'Post' '/carpetas' @{ nombre = 'NIVEL 2'; padreId = $ids[0] }) 409 'duplicado en la misma carpeta (sin distinguir mayúsculas)'
  $c = Llamar 'Post' '/carpetas' @{ nombre = 'Nivel 2'; padreId = $ids[1] }; Esperar $c 201 'el mismo nombre en otra carpeta sí se permite'
  [void]$ids.Add($c.R.id)   # $ids[5] = «Nivel 2» dentro de «Nivel 2»
  $d = Llamar 'Get' "/carpetas?padre=$($ids[1])"
  Esperar $d 200 ("dentro de «Nivel 2»: " + ((@($d.R.carpetas) | ForEach-Object { "$($_.nombre) ($($_.subcarpetas) subcarpeta(s))" }) -join ', '))

  # ----------------------------------------------------------------------------------------- 3) mover
  Write-Host ''; Write-Host '3) Mover carpetas: ciclos, profundidad y destino' -ForegroundColor Cyan
  Esperar (Llamar 'Patch' "/carpetas/$($ids[0])" @{ padreId = $ids[0] }) 409 'dentro de sí misma'
  Esperar (Llamar 'Patch' "/carpetas/$($ids[0])" @{ padreId = $ids[3] }) 409 'dentro de una subcarpeta suya'
  Esperar (Llamar 'Patch' "/carpetas/$($ids[1])" @{ padreId = $ids[5] }) 409 'dentro de una subcarpeta suya (más abajo)'
  $x = Llamar 'Patch' "/carpetas/$($ids[2])" @{ padreId = $ids[5] }; Esperar $x 400 "no cabe: $(ErrorDe $x)"
  Esperar (Llamar 'Patch' "/carpetas/$($ids[5])" @{ padreId = $ids[0] }) 409 'ya hay una «Nivel 2» en el destino'
  Esperar (Llamar 'Patch' "/carpetas/$($ids[5])" @{ padreId = $ids[3]; nombre = 'Movida' }) 200 'mover y renombrar a la vez'
  $m = Llamar 'Get' "/carpetas/$($ids[5])/ruta"; Write-Host "  Ahora: $(Migas $m.R.ruta)"

  # ----------------------------------------------------------------------------------------- 4) eliminar
  Write-Host ''; Write-Host '4) Eliminar (solo vacía; solo Super Administrador)' -ForegroundColor Cyan
  $e = Llamar 'Delete' "/carpetas/$($ids[0])"
  if ($p.eliminar) {
    Esperar $e 409 "con subcarpetas: $(ErrorDe $e)"
    foreach ($i in 4, 5, 3, 2, 1, 0) { Esperar (Llamar 'Delete' "/carpetas/$($ids[$i])") 204 "eliminar #$($ids[$i])" }
  } else {
    Esperar $e 403 'este rol no elimina carpetas'
    Write-Host "  Quedó el árbol «$raiz»: elimínelo como Super Administrador (de abajo arriba)." -ForegroundColor Yellow
  }
}

Write-Host ''
if ($script:Fallos -eq 0) { Write-Host 'Listo: todo como se esperaba.' -ForegroundColor Green }
else { Write-Host "Listo, con $($script:Fallos) fallo(s)." -ForegroundColor Red }
