#!/usr/bin/env bash
# Comprobaciones de la Fase 5 contra la API LOCAL, desde bash (Linux, macOS o Git Bash en Windows).
# Necesita curl y node (ya instalado para el backend). No guarda contraseñas ni códigos en ningún archivo.
#
# Uso (desde la carpeta backend, con la API corriendo en otra terminal: npm run dev):
#     bash scripts/probar-fase5.sh                       # como e.ramos@dai.corp (Super Admin)
#     bash scripts/probar-fase5.sh m.valdes@dai.corp     # como Oficial de Cumplimiento
#     API=http://127.0.0.1:3000/api bash scripts/probar-fase5.sh
#
# Hace una secuencia fija: biblioteca (filtros, orden, paginación y 400), carpetas y permisos; si el rol puede
# gestionar carpetas, crea una temporal, prueba el duplicado (409), la renombra y la elimina; dashboard y solicitudes.
set -u
API="${API:-http://127.0.0.1:3000/api}"
CORREO="${1:-e.ramos@dai.corp}"
TOKEN=""
CUERPO="$(mktemp)"
trap 'rm -f "$CUERPO"' EXIT

# pedir METODO RUTA [JSON] → deja el cuerpo en $CUERPO y devuelve el código HTTP en $ESTADO
pedir() {
  local args=(-s -o "$CUERPO" -w '%{http_code}' -X "$1" "$API$2")
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ $# -ge 3 ] && args+=(-H 'Content-Type: application/json; charset=utf-8' --data-binary "$3")
  ESTADO="$(curl "${args[@]}")"
}
# js 'expresión con r (el JSON de la respuesta)' → imprime el resultado
js() { node -e "const r = JSON.parse(require('fs').readFileSync('$CUERPO', 'utf8') || 'null'); const v = ($1); console.log(typeof v === 'string' ? v : JSON.stringify(v));"; }
# json clave valor ... → objeto JSON con valores de texto bien escapados (tildes, comillas)
json() { node -e 'const a = process.argv.slice(1); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1] === "null" ? null : a[i + 1]; console.log(JSON.stringify(o));' "$@"; }
error() { echo "  ERROR $ESTADO : $(js 'r && r.error' 2>/dev/null)"; }
esperado() { if [ "$ESTADO" = "$1" ]; then echo "  OK ($ESTADO) $2"; else echo "  FALLO: se esperaba $1 y llegó $ESTADO — $2"; error; fi; }

echo "API: $API   Usuario: $CORREO"
read -r -s -p 'Contraseña: ' CLAVE; echo
pedir POST /auth/login "$(json username "$CORREO" password "$CLAVE")"; CLAVE=""
[ "$ESTADO" = 200 ] || { error; exit 1; }
[ "$(js r.paso)" = 2fa ] || { echo 'Este usuario aún no tiene 2FA: entra primero por la web y configúralo.'; exit 1; }
MFA="$(js r.mfaToken)"
read -r -p 'Código de 6 dígitos de tu app: ' CODIGO
pedir POST /auth/verify-2fa "$(json mfaToken "$MFA" code "$CODIGO")"
[ "$ESTADO" = 200 ] || { error; exit 1; }
TOKEN="$(js r.token)"
echo "Sesión abierta como $(js 'r.user.name + " (" + r.user.role + ", " + r.user.nivel + ")"')"

echo; echo '1) Biblioteca: filtros, orden y paginación en el servidor'
for q in '?orden=reciente&porPagina=25&pagina=1' '?orden=nombre' '?orden=tamano' '?formato=pdf' '?carpeta=sin' '?pagina=999'; do
  pedir GET "/documentos$q"
  echo "  $q → $(js '"total=" + r.total + " pagina=" + r.pagina + " en esta página=" + r.documentos.length + " primero=" + (r.documentos[0] ? r.documentos[0].name : "—")')"
done
pedir GET /documentos; echo "  Resumen (tarjetas): $(js 'r.resumen')"
pedir GET '/documentos?orden=id'; esperado 400 'orden inválido'
pedir GET '/documentos?porPagina=10'; esperado 400 'filas por página inválidas'

echo; echo '2) Carpetas y permisos'
pedir GET /carpetas
echo "$(js 'r.carpetas.map((c) => "  #" + c.id + " " + c.nombre + " (" + c.documentos + " visibles)").join("\n")')"
echo "  Permisos: $(js 'r.permisos')"
if [ "$(js r.permisos.gestionar)" = true ]; then
  NOMBRE="Prueba bash $(date +%H%M%S)"
  pedir POST /carpetas "$(json nombre "$NOMBRE")"; esperado 201 "crear «$NOMBRE»"
  ID="$(js r.id)"
  pedir POST /carpetas "$(json nombre "$(echo "$NOMBRE" | tr '[:lower:]' '[:upper:]')")"; esperado 409 'duplicado sin distinguir mayúsculas'
  pedir PATCH "/carpetas/$ID" "$(json nombre "$NOMBRE (renombrada)")"; esperado 200 'renombrar'
  pedir DELETE "/carpetas/$ID"
  if [ "$ESTADO" = 204 ]; then echo '  OK (204) eliminar la carpeta vacía'; elif [ "$ESTADO" = 403 ]; then echo '  OK (403) solo el Super Administrador elimina carpetas (bórrala luego como admin)'; else error; fi
else
  pedir POST /carpetas "$(json nombre 'No debería crearse')"; esperado 403 'este rol no crea carpetas'
fi

echo; echo '3) Dashboard'
pedir GET /dashboard
echo "  Documentos: $(js 'r.documentos')"
echo "  Almacenamiento: $(js 'r.almacenamiento ? r.almacenamiento.usado + " en " + r.almacenamiento.objetos + " archivo(s) · " + r.almacenamiento.cifrado : "no disponible para este rol"')"

echo; echo '4) Solicitudes de movimiento pendientes'
pedir GET /carpetas/solicitudes
if [ "$ESTADO" = 200 ]; then echo "$(js 'r.length ? r.map((s) => "  #" + s.id + " " + s.documento.nombre + " → " + (s.carpetaDestino ? s.carpetaDestino.nombre : "Sin carpeta") + " (puedeResolver=" + s.puedeResolver + ")").join("\n") : "  No hay solicitudes pendientes."')"
else error; fi
echo; echo 'Listo. Para mover, solicitar, aprobar o rechazar con ids concretos use scripts/probar-fase5.ps1 o la web.'
