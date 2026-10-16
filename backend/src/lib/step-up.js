/**
 * "Step-up": pedir el segundo factor otra vez justo antes de una acción IRREVERSIBLE (purgar, vaciar la papelera).
 * Con una sesión robada (un equipo sin bloquear, un token filtrado) no basta: hace falta además el teléfono
 * del usuario (código TOTP) o uno de sus códigos de recuperación.
 *
 * Reutiliza las piezas de la Fase 3: lectura y verificación del factor (anti-reutilización incluida) y el
 * límite de fallos POR CUENTA. Un código incorrecto responde 403, no 401: la sesión sigue siendo válida y
 * el front no debe cerrarla por un error al teclear.
 */
import { query } from '../db.js';
import { registrarAuditoria } from './audit.js';
import { leerSegundoFactor, verificarSegundoFactor } from './mfa.js';
import { BLOQUEO_MIN, clave2fa, estaBloqueado, limpiarFallos, MENSAJE_BLOQUEO, registrarFallo } from './intentos.js';

/**
 * Verifica el segundo factor del cuerpo de la petición. Si falla, RESPONDE y devuelve null.
 * @param {string} accion  nombre de la acción protegida (solo para la auditoría del fallo)
 * @returns {Promise<'totp'|'recuperacion'|null>} el tipo de factor usado, o null si ya se respondió con un error
 */
export async function exigirSegundoFactor(req, res, accion) {
  const factor = leerSegundoFactor(req.body);
  if (factor.error) {
    res.status(400).json({ error: factor.error });
    return null;
  }
  const { rows: [u] } = await query(`SELECT mfa_secreto IS NOT NULL AS activo FROM usuarios WHERE id = $1`, [req.user.id]);
  if (!u?.activo) {
    res.status(409).json({ error: 'Active primero la verificación en dos pasos para confirmar esta acción.' });
    return null;
  }
  const clave = clave2fa(req.user.id);
  if (await estaBloqueado(clave)) {
    res.status(429).json({ error: MENSAJE_BLOQUEO });
    return null;
  }
  if (!(await verificarSegundoFactor(req.user.id, factor))) {
    const f = await registrarFallo(clave);
    await registrarAuditoria(req, '2fa_fallido', null, { tipo: factor.tipo, accion });
    if (f.recienBloqueado) await registrarAuditoria(req, 'bloqueo_temporal', null, { motivo: factor.tipo, minutos: BLOQUEO_MIN });
    res.status(403).json({
      error: factor.tipo === 'recuperacion'
        ? 'Código de recuperación incorrecto o ya usado.'
        : 'Código de verificación incorrecto o ya usado. Espere el siguiente código de su app.',
    });
    return null;
  }
  await limpiarFallos(clave);
  return factor.tipo;
}
