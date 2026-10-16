/**
 * Cifrado en reposo de los secretos TOTP (AES-256-GCM) y huella de los códigos de recuperación.
 *
 * Funciones PURAS (sin base de datos ni config.js): así las usan la API, la migración 004, los scripts y las
 * pruebas por igual. La clave sale de MFA_ENCRYPTION_KEY: 32 bytes aleatorios en base64
 * (openssl rand -base64 32). config.js la valida al arrancar y la API no levanta si falta o está mal.
 *
 * Formato guardado en la columna:  v1:<iv base64>:<etiqueta base64>:<cifrado base64>
 *  - iv de 12 bytes, nuevo en cada cifrado (con GCM, repetir iv + clave rompe la confidencialidad).
 *  - etiqueta GCM de 16 bytes: si alguien altera un solo bit, descifrar FALLA en lugar de dar basura.
 *  - AAD (datos asociados) = propósito + id del usuario: el cifrado queda "pegado" a su fila. Quien solo
 *    pueda escribir en la base no puede copiar SU secreto cifrado a la fila del administrador: no descifra.
 */
import crypto from 'node:crypto';

const VERSION = 'v1';
const ALGORITMO = 'aes-256-gcm';

export const PROPOSITO_ACTIVO = 'mfa';
export const PROPOSITO_PENDIENTE = 'mfa-pendiente';

/** Mensaje de error si el valor no es una clave válida; null si está bien. Nunca incluye el valor. */
export function errorClaveMfa(valor) {
  if (!valor) return 'Falta MFA_ENCRYPTION_KEY (genérala con: openssl rand -base64 32).';
  const limpio = String(valor).trim();
  const bytes = Buffer.from(limpio, 'base64');
  // Se exige base64 estricto: decodificar y volver a codificar debe dar exactamente lo mismo.
  if (bytes.length !== 32 || bytes.toString('base64') !== limpio)
    return 'MFA_ENCRYPTION_KEY debe ser 32 bytes en base64 (44 caracteres; genérala con: openssl rand -base64 32).';
  if (bytes.every((b) => b === bytes[0])) return 'MFA_ENCRYPTION_KEY no puede ser un valor repetido (usa una clave aleatoria).';
  return null;
}

/** Clave de 32 bytes a partir de las variables de entorno. Lanza si no es válida. */
export function claveMfa(env = process.env) {
  const error = errorClaveMfa(env.MFA_ENCRYPTION_KEY);
  if (error) throw new Error(error);
  return Buffer.from(env.MFA_ENCRYPTION_KEY.trim(), 'base64');
}

const aad = (proposito, usuarioId) => Buffer.from(`dai:${proposito}:usuario:${String(usuarioId)}`, 'utf8');

export const estaCifrado = (valor) => typeof valor === 'string' && valor.startsWith(`${VERSION}:`);

export function cifrarSecreto(secreto, usuarioId, { proposito = PROPOSITO_ACTIVO, clave = claveMfa() } = {}) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGORITMO, clave, iv);
  c.setAAD(aad(proposito, usuarioId));
  const cifrado = Buffer.concat([c.update(secreto, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), cifrado.toString('base64')].join(':');
}

/** Devuelve el secreto en claro (solo en memoria). Lanza si el formato, la clave, el usuario o el propósito no cuadran. */
export function descifrarSecreto(valor, usuarioId, { proposito = PROPOSITO_ACTIVO, clave = claveMfa() } = {}) {
  if (!estaCifrado(valor)) throw new Error('El secreto 2FA no está cifrado.');
  const partes = valor.split(':');
  if (partes.length !== 4) throw new Error('Formato de secreto 2FA no válido.');
  const [, iv, etiqueta, cifrado] = partes.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64')));
  if (iv.length !== 12 || etiqueta.length !== 16) throw new Error('Formato de secreto 2FA no válido.');
  const d = crypto.createDecipheriv(ALGORITMO, clave, iv);
  d.setAAD(aad(proposito, usuarioId));
  d.setAuthTag(etiqueta);
  return Buffer.concat([d.update(cifrado), d.final()]).toString('utf8');
}

/**
 * Normaliza un secreto base32 escrito a mano (espacios, guiones, minúsculas, relleno "=").
 * Devuelve null si no es base32 válido o es demasiado corto (< 80 bits).
 */
export function normalizarSecretoBase32(valor) {
  if (typeof valor !== 'string') return null;
  const s = valor.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  return /^[A-Z2-7]{16,128}$/.test(s) ? s : null;
}

/**
 * Huella de un código de recuperación: HMAC-SHA256 con una subclave derivada (HKDF) de MFA_ENCRYPTION_KEY.
 * Los códigos son aleatorios (50 bits), así que no hace falta un hash lento como bcrypt; el HMAC con una
 * clave que NO está en la base impide probarlos "fuera de línea" si alguien roba solo la base de datos.
 */
export function huellaCodigoRecuperacion(codigo, clave = claveMfa()) {
  const subclave = Buffer.from(crypto.hkdfSync('sha256', clave, Buffer.alloc(0), 'dai:codigos-recuperacion', 32));
  return crypto.createHmac('sha256', subclave).update(normalizarCodigoRecuperacion(codigo) ?? '').digest('hex');
}

// Sin 0/O, 1/I/L ni U: se leen y dictan sin confusión.
const ALFABETO_RECUPERACION = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LARGO_CODIGO_RECUPERACION = 10;

/** "abcde-fghij" / "ABCDE FGHIJ" -> "ABCDEFGHIJ"; null si no tiene la forma de un código. */
export function normalizarCodigoRecuperacion(codigo) {
  if (typeof codigo !== 'string') return null;
  const s = codigo.replace(/[\s-]/g, '').toUpperCase();
  return s.length === LARGO_CODIGO_RECUPERACION && [...s].every((ch) => ALFABETO_RECUPERACION.includes(ch)) ? s : null;
}

/** Código nuevo con forma "XXXXX-XXXXX" (10 símbolos de 30 ≈ 49 bits). */
export function nuevoCodigoRecuperacion() {
  let s = '';
  for (let i = 0; i < LARGO_CODIGO_RECUPERACION; i++) s += ALFABETO_RECUPERACION[crypto.randomInt(ALFABETO_RECUPERACION.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
