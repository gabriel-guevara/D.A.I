#!/usr/bin/env bash
# Comprobaciones de la Fase 6 (carpetas y subcarpetas) contra la API LOCAL, desde bash (Linux, macOS o Git Bash).
# Necesita curl y node (ya instalado para el backend). No guarda contraseñas ni códigos en ningún archivo.
#
# Uso (desde la carpeta backend, con la API corriendo en otra terminal: npm run dev):
#     bash scripts/probar-fase6.sh                       # como e.ramos@dai.corp (Super Admin): la secuencia completa
#     bash scripts/probar-fase6.sh c.mendez@dai.corp     # Operador OCR: crea y mueve, pero no elimina (403)
#     bash scripts/probar-fase6.sh m.valdes@dai.corp     # Cumplimiento: solo explora; crear y mover dan 403
#     API=http://127.0.0.1:3000/api bash scripts/probar-fase6.sh
#
# Con permisos de gestión crea un árbol TEMPORAL «Prueba F6 <hora>» (5 niveles), prueba los límites (400/409), mueve
# una subcarpeta y, si el rol puede eliminar, lo borra todo al final (de abajo arriba). No toca documentos.
set -u
API="${API:-http://127.0.0.1:3000/api}"
CORREO="${1:-e.ramos@dai.corp}"
TOKEN=""
CUERPO="$(mktemp)"
trap 'rm -f "$CUERPO"' EXIT
FALLOS=0

# pedir METODO RUTA [JSON] → deja el cuerpo en $CUERPO y devuelve el código HTTP en $ESTADO
pedir() {
  local args=(-s -o "$CUERPO" -w '%{http_code}' -X "$1" "$API$2")
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ $# -ge 3 ] && args+=(-H 'Content-Type: application/json; charset=utf-8' --data-binary "$3")
  ESTADO="$(curl "${args[@]}")"
}
# js 'expresión con r (el JSON de la respuesta)' → imprime el resultado
js() { node -e "const r = JSON.parse(require('fs').readFileSync('$CUERPO', 'utf8') || 'null'); const v = ($1); console.log(typeof v === 'string' ? v : JSON.stringify(v));"; }
# json clave valor ... → objeto JSON con valores de texto bien escapados ("null" = null)
json() { node -e 'const a = process.argv.slice(1); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1] === "null" ? null : a[i + 1]; console.log(JSON.stringify(o));' "$@"; }
error() { echo "  ERROR $ESTADO : $(js 'r && r.error' 2>/dev/null)"; }
esperado() { if [ "$ESTADO" = "$1" ]; then echo "  OK ($ESTADO) $2"; else echo "  FALLO: se esperaba $1 y llegó $ESTADO — $2"; error; FALLOS=$((FALLOS + 1)); fi; }
migas() { js '"Inicio › " + r.ruta.map((c) => c.nombre).join(" › ")'; }

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

echo; echo '1) Explorador: la raíz (Inicio)'
pedir GET /carpetas; esperado 200 'contenido de Inicio'
echo "$(js 'r.carpetas.map((c) => "  📁 " + c.nombre + " (#" + c.id + "): " + c.documentos + " documento(s) visible(s) · " + c.subcarpetas + " subcarpeta(s)").join("\n") || "  (sin carpetas)"')"
echo "  Documentos directamente en Inicio: $(js r.documentosAqui) · Máximo de niveles: $(js r.maxNivel)"
echo "  Permisos: $(js 'r.permisos')"
GESTIONAR="$(js r.permisos.gestionar)"; ELIMINAR="$(js r.permisos.eliminar)"
pedir GET '/carpetas?padre=abc'; esperado 400 'padre no válido'
pedir GET '/carpetas?padre=999999999'; esperado 404 'carpeta inexistente'
pedir GET /carpetas/arbol; esperado 200 "árbol completo: $(js 'r.carpetas.length') carpetas"
pedir GET '/documentos?carpeta=sin&subcarpetas=1'; esperado 200 "toda la biblioteca desde Inicio: $(js r.total) documentos"
pedir GET '/documentos?subcarpetas=si'; esperado 400 'subcarpetas solo admite 1'

if [ "$GESTIONAR" != true ]; then
  echo; echo '2) Este rol no gestiona carpetas'
  pedir POST /carpetas "$(json nombre 'No debería crearse')"; esperado 403 'crear'
  pedir PATCH /carpetas/1 "$(json padreId null)"; esperado 403 'mover carpeta'
  echo; [ "$FALLOS" = 0 ] && echo 'Listo: todo como se esperaba.' || echo "Listo, con $FALLOS fallo(s)."
  exit 0
fi

echo; echo '2) Crear un árbol temporal de 5 niveles'
RAIZ="Prueba F6 $(date +%H%M%S)"
pedir POST /carpetas "$(json nombre "$RAIZ")"; esperado 201 "nivel 1: «$RAIZ»"
IDS=("$(js r.id)")
for n in 2 3 4 5; do
  pedir POST /carpetas "$(json nombre "Nivel $n" padreId "${IDS[${#IDS[@]}-1]}")"; esperado 201 "nivel $n"
  IDS+=("$(js r.id)")
done
pedir GET "/carpetas/${IDS[4]}/ruta"; esperado 200 "migas: $(migas)"
pedir POST /carpetas "$(json nombre 'Nivel 6' padreId "${IDS[4]}")"; esperado 400 "sexto nivel: $(js 'r && r.error')"
pedir POST /carpetas "$(json nombre 'NIVEL 2' padreId "${IDS[0]}")"; esperado 409 'duplicado en la misma carpeta (sin distinguir mayúsculas)'
pedir POST /carpetas "$(json nombre 'Nivel 2' padreId "${IDS[1]}")"; esperado 201 'el mismo nombre en otra carpeta sí se permite'
IDS+=("$(js r.id)")   # IDS[5] = «Nivel 2» dentro de «Nivel 2»
pedir GET "/carpetas?padre=${IDS[1]}"; esperado 200 "dentro de «Nivel 2»: $(js 'r.carpetas.map((c) => c.nombre + " (" + c.subcarpetas + " subcarpeta(s))").join(", ")')"

echo; echo '3) Mover carpetas: ciclos, profundidad y destino'
pedir PATCH "/carpetas/${IDS[0]}" "$(json padreId "${IDS[0]}")"; esperado 409 'dentro de sí misma'
pedir PATCH "/carpetas/${IDS[0]}" "$(json padreId "${IDS[3]}")"; esperado 409 'dentro de una subcarpeta suya'
pedir PATCH "/carpetas/${IDS[1]}" "$(json padreId "${IDS[5]}")"; esperado 409 'dentro de una subcarpeta suya (más abajo)'
pedir PATCH "/carpetas/${IDS[2]}" "$(json padreId "${IDS[5]}")"; esperado 400 "no cabe: $(js 'r && r.error')"
pedir PATCH "/carpetas/${IDS[5]}" "$(json padreId "${IDS[0]}")"; esperado 409 'ya hay una «Nivel 2» en el destino'
pedir PATCH "/carpetas/${IDS[5]}" "$(json padreId "${IDS[3]}" nombre 'Movida')"; esperado 200 'mover y renombrar a la vez'
pedir GET "/carpetas/${IDS[5]}/ruta"; echo "  Ahora: $(migas)"

echo; echo '4) Eliminar (solo vacía; solo Super Administrador)'
pedir DELETE "/carpetas/${IDS[0]}"
if [ "$ELIMINAR" = true ]; then
  esperado 409 "con subcarpetas: $(js 'r && r.error')"
  for i in 4 5 3 2 1 0; do pedir DELETE "/carpetas/${IDS[$i]}"; esperado 204 "eliminar #${IDS[$i]}"; done
else
  esperado 403 'este rol no elimina carpetas'
  echo "  Quedó el árbol «$RAIZ»: elimínelo como Super Administrador (de abajo arriba)."
fi

echo; [ "$FALLOS" = 0 ] && echo 'Listo: todo como se esperaba.' || echo "Listo, con $FALLOS fallo(s)."
