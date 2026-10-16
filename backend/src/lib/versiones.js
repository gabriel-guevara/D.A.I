/**
 * Numeración de versiones. Funciones PURAS (se prueban aisladas).
 *
 * Las versiones son "vMAYOR.MENOR" (v1.0 al subir; los datos heredados traen v3.2, v4.1...). Cada versión
 * nueva sube el número MAYOR por encima del más alto que haya existido: si se restauró la v1.0 sobre la v3.0,
 * la siguiente es la v4.0 (nunca se reutiliza un número, así un número identifica siempre el mismo archivo).
 */
const PATRON = /^v(\d{1,6})(?:\.(\d{1,6}))?$/i;

/** Número mayor de una etiqueta ("v3.2" → 3) o null si no tiene el formato. */
export function mayorDeVersion(etiqueta) {
  const m = PATRON.exec(String(etiqueta ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** Siguiente etiqueta a partir de TODAS las existentes del documento (incluida la actual). */
export function siguienteVersion(etiquetas) {
  const mayores = etiquetas.map(mayorDeVersion).filter((n) => n !== null);
  return `v${(mayores.length ? Math.max(...mayores) : 0) + 1}.0`;
}

/** "Contrato.pdf" + "v2.0" → "Contrato (v2.0).pdf": al descargar una versión antigua no se confunde con la actual. */
export function nombreConVersion(nombre, version) {
  const base = String(nombre).replace(/\.pdf$/i, '');
  return `${base} (${version}).pdf`;
}
