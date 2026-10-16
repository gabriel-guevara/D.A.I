/**
 * Operaciones de 2FA sobre la base: alta (secreto pendiente → confirmado), verificación con anti-reutilización
 * y códigos de recuperación. Las rutas (auth.js, cuenta.js, seguridad.js) solo orquestan; la lógica vive aquí.
 *
 * Columnas de usuarios que se usan (migración 004):
 *  - mfa_secreto            secreto CONFIRMADO, cifrado (v1:...). NULL = el usuario aún no tiene 2FA.
 *  - mfa_secreto_pendiente  secreto recién generado, cifrado, que NO sirve para entrar hasta confirmarlo.
 *  - mfa_pendiente_en       cuándo se generó el pendiente (caduca a los 15 min).
 *  - mfa_ultimo_paso        último paso TOTP aceptado: solo se aceptan pasos MAYORES (anti-reutilización).
 *  - mfa_activado_en        fecha de alta.
 *  - sesion_version         se incrementa para invalidar todas las sesiones abiertas.
 */
import { query, withTransaction } from '../db.js';
import {
  cifrarSecreto, descifrarSecreto, huellaCodigoRecuperacion, normalizarCodigoRecuperacion,
  nuevoCodigoRecuperacion, PROPOSITO_PENDIENTE,
} from './cifrado-mfa.js';
import { generarSecreto, pasoDelCodigo, uriOtpauth } from './totp.js';

export const CANTIDAD_CODIGOS = 10;
export const VIDA_PENDIENTE_MIN = 15;

/**
 * Genera un secreto nuevo y lo deja PENDIENTE (reemplaza uno pendiente anterior). El secreto confirmado,
 * si existe, sigue funcionando hasta que se confirme el nuevo: así cambiar de teléfono no deja a nadie fuera.
 * @returns {Promise<{ secreto: string, otpauthUri: string, cuenta: string }>}
 */
export async function iniciarAlta(usuario) {
  const secreto = generarSecreto();
  await query(`UPDATE usuarios SET mfa_secreto_pendiente = $2, mfa_pendiente_en = now() WHERE id = $1`,
    [usuario.id, cifrarSecreto(secreto, usuario.id, { proposito: PROPOSITO_PENDIENTE })]);
  return { secreto, otpauthUri: uriOtpauth(usuario.email, secreto), cuenta: usuario.email };
}

/**
 * Acepta un paso TOTP solo si es mayor que el último aceptado. Es un UPDATE condicional: aunque lleguen dos
 * peticiones a la vez con el mismo código, solo una lo consigue.
 */
async function consumirPaso(db, usuarioId, paso) {
  const { rowCount } = await db.query(
    `UPDATE usuarios SET mfa_ultimo_paso = $2 WHERE id = $1 AND (mfa_ultimo_paso IS NULL OR mfa_ultimo_paso < $2)`,
    [usuarioId, paso]);
  return rowCount === 1;
}

/** Verifica un código TOTP contra el secreto CONFIRMADO. Un código ya usado (o más viejo) se rechaza. */
export async function verificarTotp(usuarioId, codigo, ahora = Date.now()) {
  const { rows: [u] } = await query(`SELECT mfa_secreto FROM usuarios WHERE id = $1`, [usuarioId]);
  if (!u?.mfa_secreto) return false;
  let secreto;
  try {
    secreto = descifrarSecreto(u.mfa_secreto, usuarioId);
  } catch (e) {
    // Secreto en claro, alterado o cifrado con otra clave: nunca se usa. Se avisa sin mostrar el valor.
    console.error(`2FA: el secreto del usuario ${usuarioId} no se pudo descifrar (${e.message}).`);
    return false;
  }
  const paso = pasoDelCodigo(codigo, secreto, ahora);
  return paso !== null && consumirPaso({ query }, usuarioId, paso);
}

/**
 * Confirma el secreto pendiente con un código de la app. Si es correcto, pasa a ser el secreto activo.
 * @returns {Promise<'ok'|'sin_pendiente'|'caducado'|'codigo_incorrecto'>}
 */
export async function confirmarAlta(usuarioId, codigo, ahora = Date.now()) {
  return withTransaction(async (c) => {
    const { rows: [u] } = await c.query(
      `SELECT mfa_secreto_pendiente, mfa_pendiente_en < now() - make_interval(mins => $2) AS caducado
         FROM usuarios WHERE id = $1 FOR UPDATE`, [usuarioId, VIDA_PENDIENTE_MIN]);
    if (!u?.mfa_secreto_pendiente) return 'sin_pendiente';
    if (u.caducado) return 'caducado';
    const secreto = descifrarSecreto(u.mfa_secreto_pendiente, usuarioId, { proposito: PROPOSITO_PENDIENTE });
    const paso = pasoDelCodigo(codigo, secreto, ahora);
    if (paso === null) return 'codigo_incorrecto';
    // El paso con que se confirma queda "usado": ese mismo código no sirve después para iniciar sesión.
    await c.query(
      `UPDATE usuarios SET mfa_secreto = $2, mfa_secreto_pendiente = NULL, mfa_pendiente_en = NULL,
              mfa_ultimo_paso = GREATEST(coalesce(mfa_ultimo_paso, 0), $3), mfa_activado_en = now()
        WHERE id = $1`, [usuarioId, cifrarSecreto(secreto, usuarioId), paso]);
    return 'ok';
  });
}

/** Reemplaza TODOS los códigos de recuperación del usuario por 10 nuevos. Devuelve los códigos en claro (una sola vez). */
export async function generarCodigosRecuperacion(usuarioId, db = { query }) {
  const codigos = Array.from({ length: CANTIDAD_CODIGOS }, nuevoCodigoRecuperacion);
  await db.query(`DELETE FROM mfa_codigos_recuperacion WHERE usuario_id = $1`, [usuarioId]);
  await db.query(
    `INSERT INTO mfa_codigos_recuperacion (usuario_id, huella) SELECT $1, unnest($2::text[])`,
    [usuarioId, codigos.map((c) => huellaCodigoRecuperacion(c))]);
  return codigos;
}

/** Gasta un código de recuperación (un solo uso). */
export async function consumirCodigoRecuperacion(usuarioId, codigo) {
  if (!normalizarCodigoRecuperacion(codigo)) return false;
  const { rowCount } = await query(
    `UPDATE mfa_codigos_recuperacion SET usado_en = now()
      WHERE usuario_id = $1 AND huella = $2 AND usado_en IS NULL`, [usuarioId, huellaCodigoRecuperacion(codigo)]);
  return rowCount === 1;
}

export async function codigosRestantes(usuarioId) {
  const { rows: [r] } = await query(
    `SELECT count(*)::int AS n FROM mfa_codigos_recuperacion WHERE usuario_id = $1 AND usado_en IS NULL`, [usuarioId]);
  return r.n;
}

/**
 * Segundo factor enviado en el cuerpo: { code: '123456' } o { codigoRecuperacion: 'XXXXX-XXXXX' }.
 * @returns {{ tipo: 'totp'|'recuperacion', valor: string } | { error: string }}
 */
export function leerSegundoFactor(body) {
  const { code, codigoRecuperacion } = body ?? {};
  if (typeof codigoRecuperacion === 'string' && codigoRecuperacion.trim()) {
    return normalizarCodigoRecuperacion(codigoRecuperacion)
      ? { tipo: 'recuperacion', valor: codigoRecuperacion }
      : { error: 'El código de recuperación tiene la forma XXXXX-XXXXX.' };
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { error: 'Complete el código de verificación de 6 dígitos.' };
  return { tipo: 'totp', valor: code };
}

/** Verifica el segundo factor ya leído. */
export const verificarSegundoFactor = (usuarioId, factor) =>
  factor.tipo === 'recuperacion' ? consumirCodigoRecuperacion(usuarioId, factor.valor) : verificarTotp(usuarioId, factor.valor);

// Restablecer (super-admin y script de emergencia) vive aparte porque el script no puede cargar config.js.
export { quitar2fa } from './mfa-quitar.js';
