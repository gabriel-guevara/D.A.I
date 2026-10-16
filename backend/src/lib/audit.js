import { query } from '../db.js';

// Red de seguridad: estos campos NUNCA llegan a la auditoría aunque alguien los pase por error.
const CAMPOS_PROHIBIDOS = new Set([
  'secreto', 'secret', 'code', 'codigo', 'codigoRecuperacion', 'codigosRecuperacion',
  'password', 'actual', 'nueva', 'token', 'mfaToken', 'enrolToken', 'otpauthUri',
]);
const limpiar = (detalle) => Object.fromEntries(Object.entries(detalle ?? {}).filter(([k]) => !CAMPOS_PROHIBIDOS.has(k)));

/** Registra una acción en la tabla de auditoría. Nunca debe romper la petición principal. */
export async function registrarAuditoria(req, accion, documentoId = null, detalle = {}) {
  return registrarAuditoriaDe(req, req.user?.id ?? null, accion, detalle, documentoId);
}

/** Igual, pero indicando el usuario a mano (login y alta de 2FA, donde aún no hay sesión en req.user). */
export async function registrarAuditoriaDe(req, usuarioId, accion, detalle = {}, documentoId = null) {
  try {
    await query(
      `INSERT INTO auditoria (usuario_id, documento_id, accion, ip, detalle) VALUES ($1,$2,$3,$4,$5)`,
      [usuarioId, documentoId, accion, req.ip, JSON.stringify(limpiar(detalle))]
    );
  } catch (e) {
    console.error('No se pudo registrar auditoría:', e.message);
  }
}
