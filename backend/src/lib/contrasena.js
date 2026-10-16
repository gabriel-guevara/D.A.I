/**
 * Política de contraseñas (la misma para el cambio por el propio usuario y para la que asigna un administrador).
 * Inspirada en NIST SP 800-63B: lo que más protege es la LONGITUD y evitar contraseñas conocidas, no obligar
 * a mezclar símbolos raros (eso produce "Password1!"). Se mantiene "una letra y un número" porque el sistema
 * ya lo exigía y no estorba.
 *
 *  - 10 a 72 bytes. 72 es el límite real de bcrypt: lo que pase de ahí se ignoraría en silencio.
 *  - Al menos una letra y un número.
 *  - No puede ser una contraseña muy común ni contener la parte local del correo (antes de la @).
 */
export const MIN_CONTRASENA = 10;
export const MAX_BYTES_CONTRASENA = 72;

// Lista corta de las más usadas (y variantes del propio sistema). Se compara en minúsculas.
const COMUNES = new Set([
  '1234567890', '12345678910', '123456789a', 'a123456789', 'qwerty1234', 'qwertyuiop1', 'password1', 'password12',
  'password123', 'password1234', 'contrasena1', 'contraseña1', 'contrasena123', 'contraseña123', 'iloveyou12',
  'admin12345', 'administrador1', 'bienvenido1', 'bienvenido123', 'colombia123', 'colombia2024', 'colombia2025',
  'colombia2026', 'dai2024!dai', 'dai12345678', 'abc1234567', 'abcd123456', '1q2w3e4r5t', 'q1w2e3r4t5',
]);

/**
 * @returns {string|null} mensaje para el usuario o null si cumple
 * @param {unknown} p
 * @param {{ email?: string }} [contexto]
 */
export function errorContrasena(p, { email } = {}) {
  if (typeof p !== 'string' || p.length < MIN_CONTRASENA || Buffer.byteLength(p) > MAX_BYTES_CONTRASENA)
    return `La contraseña debe tener entre ${MIN_CONTRASENA} y ${MAX_BYTES_CONTRASENA} caracteres.`;
  if (!/\p{L}/u.test(p) || !/\d/.test(p)) return 'La contraseña debe incluir al menos una letra y un número.';
  const baja = p.toLowerCase();
  if (COMUNES.has(baja)) return 'Esa contraseña es demasiado común. Elija otra.';
  const local = typeof email === 'string' ? email.split('@')[0].toLowerCase() : '';
  if (local.length >= 3 && baja.includes(local)) return 'La contraseña no puede contener su usuario.';
  return null;
}
