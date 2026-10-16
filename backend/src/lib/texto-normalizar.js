/**
 * Limpieza del texto que sale de un PDF antes de guardarlo e indexarlo. Funciones PURAS (sin E/S): las usa el
 * worker de extracción y la aprobación OCR manual, y se prueban por separado.
 *
 * Por qué hace falta: un PDF guarda "dibujos de letras" en posiciones, no párrafos. Al sacar el texto aparecen
 * espacios repetidos, guiones de corte de línea ("docu-\nmento"), ligaduras (U+FB01, la "fi" en un solo glifo), caracteres invisibles y de
 * control (un \u0000 haría fallar a PostgreSQL). Si no se limpia, la búsqueda no encuentra "documento".
 */

const INVISIBLES = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g; // guion suave y caracteres de ancho cero
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g; // todo control salvo \t y \n
const USO_PRIVADO = /\p{Co}/gu; // glifos sin equivalente Unicode (fuentes incrustadas raras)
const ESPACIOS = /[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;
// "docu-\nmento" → "documento": letra + guion + salto + MINÚSCULA = palabra cortada por el ancho de línea.
// Con mayúscula detrás ("Norte-\nSur") se respeta el guion: suele ser un compuesto o un nombre propio.
const GUION_FIN_DE_LINEA = /(\p{L})[-\u2010\u2011] ?\n(\p{Ll})/gu;

/** @param {string} s @returns {string} texto en NFKC, sin control ni invisibles, espacios simples y párrafos conservados */
export function normalizarTexto(s) {
  if (typeof s !== 'string' || !s) return '';
  return s
    .toWellFormed() // sustitutos sueltos (UTF-16 roto) → U+FFFD; PostgreSQL solo acepta UTF-8 válido
    .normalize('NFKC') // ligaduras (U+FB01) → "fi", anchos completos → normales: así coincide con lo que se teclea
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(INVISIBLES, '')
    .replace(CONTROL, ' ')
    .replace(USO_PRIVADO, '')
    .replace(ESPACIOS, ' ')
    .replace(/ *\n */g, '\n')
    .replace(GUION_FIN_DE_LINEA, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Letras y números: lo que de verdad cuenta como "texto" (para detectar páginas escaneadas sin capa de texto). */
export const caracteresSignificativos = (s) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Corta a como mucho `max` caracteres sin partir una palabra (si hay un espacio razonablemente cerca). */
export function recortar(s, max) {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const corte = s.slice(0, max);
  if (/\s/.test(s[max])) return corte.trimEnd(); // el corte ya cae entre dos palabras
  const espacio = Math.max(corte.lastIndexOf(' '), corte.lastIndexOf('\n'));
  return (espacio > max * 0.8 ? corte.slice(0, espacio) : corte).trimEnd();
}
