import { query } from '../db.js';

/** Registra una acción en la tabla de auditoría. Nunca debe romper la petición principal. */
export async function registrarAuditoria(req, accion, documentoId = null, detalle = {}) {
  try {
    await query(
      `INSERT INTO auditoria (usuario_id, documento_id, accion, ip, detalle) VALUES ($1,$2,$3,$4,$5)`,
      [req.user?.id ?? null, documentoId, accion, req.ip, JSON.stringify(detalle)]
    );
  } catch (e) {
    console.error('No se pudo registrar auditoría:', e.message);
  }
}
