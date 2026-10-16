<#
  Pruebas manuales de la Fase 5 (biblioteca en servidor, carpetas, mover, solicitudes, dashboard real y
  "Crear usuario" con nivel) contra la API LOCAL, desde PowerShell.
  Escrito para Windows PowerShell 5.1 y PowerShell 7. No guarda contraseñas ni códigos en ningún archivo.
  Se guarda en UTF-8 CON BOM: así Windows PowerShell 5.1 lee bien las tildes de los mensajes.

  Uso (desde la carpeta backend, con la API corriendo en otra ventana: npm run dev):
      powershell -ExecutionPolicy Bypass -File .\scripts\probar-fase5.ps1
      powershell -ExecutionPolicy Bypass -File .\scripts\probar-fase5.ps1 -Correo m.valdes@dai.corp
  (-ExecutionPolicy Bypass solo afecta a ESTA ejecución; no cambia la configuración de Windows.)

  Para probar los permisos, ejecútalo una vez por rol: e.ramos (Super Admin), c.mendez (Operador OCR),
  m.valdes (Cumplimiento) y f.vega (Lector). Cada uno debe tener ya su 2FA configurado (entra antes por la web).
#>
param(
  [string]$Api = 'http://127.0.0.1:3000/api',
  [string]$Correo = 'e.ramos@dai.corp'
)

$ErrorActionPreference = 'Stop'
# Sin barra de progreso: en PowerShell 5.1 hace muy lentas las peticiones y tapa los mensajes de error.
$ProgressPreference = 'SilentlyContinue'
$script:H = @{}

# Llama a la API con el cuerpo en UTF-8 (en PowerShell 5.1, una "ñ" o una tilde llegarían mal).
# Si el servidor responde con error, muestra su código y su mensaje en español y devuelve $null sin detener el script.
function Llamar([string]$Metodo, [string]$Ruta, $Cuerpo = $null) {
  $params = @{ Method = $Metodo; Uri = "$Api$Ruta"; Headers = $script:H }
  if ($null -ne $Cuerpo) {
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [Text.Encoding]::UTF8.GetBytes(($Cuerpo | ConvertTo-Json -Compress -Depth 5))
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

function Pedir([string]$Texto) { return (Read-Host $Texto).Trim() }

function Pedir-Id([string]$Que) {
  $id = Pedir "Id $Que"
  if ($id -notmatch '^\d+$') { Write-Host '  Debe ser un número.' -ForegroundColor Yellow; return $null }
  return $id
}

# Carpeta de destino: un id, o "sin" para dejar el documento sin carpeta (se envía null).
function Pedir-Destino {
  $d = Pedir 'Carpeta de destino (id, o "sin" para Sin carpeta)'
  if ($d -eq 'sin') { return @{ ok = $true; id = $null } }
  if ($d -notmatch '^\d+$') { Write-Host '  Escriba un id numérico o "sin".' -ForegroundColor Yellow; return @{ ok = $false } }
  return @{ ok = $true; id = $d }
}

# ------------------------------------------------------------------------------------------- login
Write-Host "API: $Api   Usuario: $Correo" -ForegroundColor Cyan
$seguro = Read-Host 'Contraseña' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
$plano = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$l = Llamar 'Post' '/auth/login' @{ username = $Correo; password = $plano }
$plano = $null
if (-not $l) { exit 1 }
if ($l.paso -ne '2fa') { Write-Host 'Este usuario aún no tiene 2FA: entra primero por la web y configúralo.' -ForegroundColor Yellow; exit 1 }
$s = Llamar 'Post' '/auth/verify-2fa' @{ mfaToken = $l.mfaToken; code = (Pedir 'Código de 6 dígitos de tu app') }
if (-not $s) { exit 1 }
$script:H = @{ Authorization = "Bearer $($s.token)" }
Write-Host "Sesión abierta como $($s.user.name) ($($s.user.role), $($s.user.nivel))." -ForegroundColor Green

# ------------------------------------------------------------------------------------------- pasos
function Biblioteca {
  # Mismas consultas que hace la pantalla: los filtros, el orden y la paginación los aplica el SERVIDOR.
  $consultas = @(
    '?orden=reciente&porPagina=25&pagina=1',
    '?orden=nombre&porPagina=25&pagina=1',
    '?orden=tamano&porPagina=25&pagina=1',
    '?formato=pdf&dias=todo',
    '?carpeta=sin',
    '?porPagina=25&pagina=999'
  )
  foreach ($q in $consultas) {
    $r = Llamar 'Get' "/documentos$q"; if (-not $r) { continue }
    Write-Host ("  {0,-42} total={1,-4} pagina={2} porPagina={3} -> {4} en esta página" -f $q, $r.total, $r.pagina, $r.porPagina, @($r.documentos).Count)
    @($r.documentos) | Select-Object -First 3 | ForEach-Object { Write-Host "      $($_.name)  [$($_.folio)]  carpeta: $(if ($_.carpeta) { $_.carpeta.nombre } else { 'Sin carpeta' })" }
  }
  $r = Llamar 'Get' '/documentos?porPagina=25'
  if ($r) { Write-Host "  Resumen (tarjetas): total=$($r.resumen.total)  actualizados30=$($r.resumen.actualizados30)" -ForegroundColor Green }
  Write-Host '  Parámetros inválidos (deben dar 400):'
  [void](Llamar 'Get' '/documentos?orden=id')
  [void](Llamar 'Get' '/documentos?porPagina=10')
}

function Carpetas {
  $c = Llamar 'Get' '/carpetas'; if (-not $c) { return $null }
  $c.carpetas | Select-Object id, nombre, documentos | Format-Table -AutoSize | Out-Host
  Write-Host "  Sin carpeta: $($c.sinCarpeta).  Permisos: gestionar=$($c.permisos.gestionar) eliminar=$($c.permisos.eliminar) solicitar=$($c.permisos.solicitar) resolver=$($c.permisos.resolver)"
  return $c
}

function Crear-Carpeta {
  $r = Llamar 'Post' '/carpetas' @{ nombre = (Pedir 'Nombre de la carpeta nueva') }
  if ($r) { Write-Host "  Creada: id=$($r.id) nombre=$($r.nombre)" -ForegroundColor Green }
}

function Renombrar-Carpeta {
  $id = Pedir-Id 'de la carpeta'; if (-not $id) { return }
  $r = Llamar 'Patch' "/carpetas/$id" @{ nombre = (Pedir 'Nuevo nombre') }
  if ($r) { Write-Host "  Renombrada: $($r.nombre)" -ForegroundColor Green }
}

function Eliminar-Carpeta {
  $id = Pedir-Id 'de la carpeta (solo si está vacía)'; if (-not $id) { return }
  $r = Llamar 'Delete' "/carpetas/$id"
  # 204 sin cuerpo: Invoke-RestMethod devuelve una cadena vacía (no $null) cuando sale bien.
  if ($null -ne $r) { Write-Host '  Carpeta eliminada.' -ForegroundColor Green }
}

function Mover {
  $ids = @((Pedir 'Ids de documentos separados por coma (máximo 100)') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $d = Pedir-Destino; if (-not $d.ok) { return }
  $r = Llamar 'Post' '/carpetas/mover' @{ ids = $ids; carpetaId = $d.id }
  if ($r) { Write-Host "  Movidos: $($r.movidos)  Ya estaban: $($r.sinCambios)  Omitidos (sin acceso o no activos): $(@($r.omitidos) -join ', ')" -ForegroundColor Green }
}

function Solicitar {
  $doc = Pedir-Id 'del documento'; if (-not $doc) { return }
  $d = Pedir-Destino; if (-not $d.ok) { return }
  $r = Llamar 'Post' '/carpetas/solicitudes' @{ documentoId = $doc; carpetaId = $d.id; motivo = (Pedir 'Motivo (10 a 500 caracteres)') }
  if ($r) { Write-Host "  Solicitud enviada: id=$($r.id)" -ForegroundColor Green }
}

function Solicitudes {
  $estado = Pedir 'Estado (pendiente, aprobada, rechazada, todas) [pendiente]'
  if (-not $estado) { $estado = 'pendiente' }
  $r = Llamar 'Get' "/carpetas/solicitudes?estado=$estado"; if ($null -eq $r) { return }
  if (-not @($r).Count) { Write-Host '  No hay solicitudes.'; return }
  @($r) | ForEach-Object {
    $destino = if ($_.carpetaDestino) { $_.carpetaDestino.nombre } else { 'Sin carpeta' }
    Write-Host "  #$($_.id) [$($_.estado)] $($_.documento.nombre) -> $destino  (de $($_.solicitante), $($_.fecha))  puedeResolver=$($_.puedeResolver)"
    Write-Host "      Motivo: $($_.motivo)"
    if ($_.respuesta) { Write-Host "      Respuesta: $($_.respuesta)" }
  }
}

function Resolver([bool]$Aprobar) {
  $id = Pedir-Id 'de la solicitud'; if (-not $id) { return }
  if ($Aprobar) { $r = Llamar 'Post' "/carpetas/solicitudes/$id/aprobar" @{ respuesta = (Pedir 'Comentario (opcional)') } }
  else { $r = Llamar 'Post' "/carpetas/solicitudes/$id/rechazar" @{ respuesta = (Pedir 'Motivo del rechazo (obligatorio)') } }
  if ($r) { Write-Host "  Solicitud $($r.estado)." -ForegroundColor Green }
}

function Dashboard {
  $d = Llamar 'Get' '/dashboard'; if (-not $d) { return }
  $k = $d.documentos
  Write-Host "  Visibles=$($k.visibles)  AltasMes=$($k.altasMes)  ConArchivo=$($k.conArchivo)  SinArchivo=$($k.sinArchivo)  FueraDePlazo=$($k.fueraDePlazo)"
  Write-Host '  Por departamento:'; @($d.porDepartamento) | ForEach-Object { Write-Host "      $($_.nombre): $($_.total)" }
  Write-Host '  Por formato:'; @($d.porFormato) | ForEach-Object { Write-Host "      $($_.formato): $($_.total)" }
  if ($d.almacenamiento) {
    $a = $d.almacenamiento
    Write-Host "  Almacenamiento: $($a.usado) en $($a.objetos) archivo(s); cuota $($a.cuota) ($($a.porcentaje) %); papelera $($a.papelera.usado) en $($a.papelera.documentos) documento(s)" -ForegroundColor Green
    Write-Host "  Cifrado: $($a.cifrado)"
  } else {
    Write-Host '  Almacenamiento: no disponible para este rol (solo Super Administrador y Oficial de Cumplimiento).' -ForegroundColor Yellow
  }
}

function Crear-Usuario {
  $correoNuevo = Pedir 'Correo del usuario de prueba (p. ej. prueba.f5@dai.corp)'
  $base = @{ nombre = 'Usuario Prueba Fase 5'; email = $correoNuevo; password = 'ClaveSegura-2026'; rol = 'read-only' }
  Write-Host '  1) Sin nivel (así fallaba el formulario antes): debe dar 400'
  [void](Llamar 'Post' '/seguridad/usuarios' $base)
  Write-Host '  2) Con nivel: debe crearse (201)'
  $base.nivel = 'Nivel 2 Confidencial'
  $r = Llamar 'Post' '/seguridad/usuarios' $base
  if ($r) { Write-Host "  Usuario creado: id=$($r.id) (desactívalo después desde Roles y Permisos)" -ForegroundColor Green }
}

function Auditoria {
  $id = Pedir-Id 'del documento'; if (-not $id) { return }
  $a = Llamar 'Get' "/documentos/$id/auditoria"
  if ($a) { $a | Select-Object fecha, accion, usuario | Format-Table -AutoSize | Out-Host }
}

while ($true) {
  Write-Host ''
  Write-Host '1) Biblioteca: filtros, orden y paginación en el servidor (y 400 con parámetros inválidos)'
  Write-Host '2) Ver carpetas y mis permisos'
  Write-Host '3) Crear carpeta            4) Renombrar carpeta        5) Eliminar carpeta (solo vacía)'
  Write-Host '6) Mover documentos'
  Write-Host '7) Solicitar movimiento (Cumplimiento)'
  Write-Host '8) Ver solicitudes          9) Aprobar solicitud       10) Rechazar solicitud'
  Write-Host '11) Dashboard (cifras reales y almacenamiento)'
  Write-Host '12) Crear usuario sin nivel (400) y con nivel (201)'
  Write-Host '13) Auditoría de un documento (mover_documento, solicitar/aprobar/rechazar)'
  Write-Host 'S) Salir'
  switch ((Read-Host 'Opción').Trim().ToUpper()) {
    '1'  { Biblioteca }
    '2'  { [void](Carpetas) }
    '3'  { Crear-Carpeta }
    '4'  { Renombrar-Carpeta }
    '5'  { Eliminar-Carpeta }
    '6'  { Mover }
    '7'  { Solicitar }
    '8'  { Solicitudes }
    '9'  { Resolver $true }
    '10' { Resolver $false }
    '11' { Dashboard }
    '12' { Crear-Usuario }
    '13' { Auditoria }
    'S'  { exit 0 }
    default { Write-Host '  Opción no válida.' }
  }
}
