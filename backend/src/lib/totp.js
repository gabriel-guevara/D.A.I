/**
 * TOTP (RFC 6238) con otplib: 6 dígitos, pasos de 30 s, SHA-1. Es lo que esperan Google Authenticator,
 * Microsoft Authenticator, Authy, 1Password, etc. (SHA-256 no lo soportan todas las apps).
 *
 * Tolerancia de reloj: ±1 paso (window: 1). Se acepta el código del paso anterior, el actual y el siguiente:
 * cubre unos 30 s de desfase del reloj del teléfono y el tiempo que tarda la persona en escribir. Más
 * ventana = más códigos válidos a la vez = más fácil adivinar; menos ventana = rechazos por relojes atrasados.
 *
 * La función devuelve el NÚMERO DE PASO que coincidió (no solo true/false): la base guarda el último paso
 * aceptado de cada usuario para que el mismo código (o uno anterior) no se pueda usar dos veces.
 */
import { authenticator } from 'otplib';

export const PASO_SEGUNDOS = 30;
export const VENTANA_PASOS = 1;
export const EMISOR = 'DAI';

const base = authenticator.clone({ step: PASO_SEGUNDOS, window: VENTANA_PASOS, digits: 6 });

/** Secreto nuevo: 20 bytes aleatorios (160 bits, lo que recomienda el RFC 4226) en base32. */
export const generarSecreto = () => base.generateSecret(20);

/** URI otpauth:// que se convierte en el QR que escanea la app autenticadora. */
export const uriOtpauth = (cuenta, secreto) => base.keyuri(cuenta, EMISOR, secreto);

export const pasoDe = (ms = Date.now()) => Math.floor(ms / 1000 / PASO_SEGUNDOS);

/**
 * Paso (contador) que coincide con el código dentro de la ventana, o null.
 * @param {string} codigo  6 dígitos
 * @param {string} secreto base32 en claro (solo en memoria)
 * @param {number} [ahora] ms; las pruebas lo cambian para simular relojes adelantados o atrasados
 */
export function pasoDelCodigo(codigo, secreto, ahora = Date.now()) {
  if (typeof codigo !== 'string' || !/^\d{6}$/.test(codigo)) return null;
  const delta = base.clone({ epoch: ahora }).checkDelta(codigo, secreto);
  return delta === null ? null : pasoDe(ahora) + delta;
}

/** Código válido para un instante dado (pruebas y prueba de humo). */
export const codigoPara = (secreto, ahora = Date.now()) => base.clone({ epoch: ahora }).generate(secreto);
