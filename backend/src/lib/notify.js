import { query } from '../db.js';

/**
 * Avisa en tiempo real (el front consulta cada pocos segundos) a los Super Administradores y
 * Oficiales de Cumplimiento que alguien consultó un documento. También le llega a quien lo abrió
 * (con texto "Consultaste ...") para que pueda ver su propia actividad.
 * Si la misma persona abre el mismo documento varias veces en 30 s, se avisa solo una vez.
 * Nunca debe romper la petición principal.
 */
export async function notificarConsulta(req, doc) {
  try {
    const { rows: [quien] } = await query(
      `SELECT u.nombre, r.nombre AS rol FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1`, [req.user.id]);
    if (!quien) return;

    const tituloPropio = `Consultaste ${doc.nombre}`;
    const tituloAjeno = `${quien.nombre} consultó ${doc.nombre}`;
    const meta = [`Usuario: ${quien.nombre}`, `Rol: ${quien.rol}`, `Folio: ${doc.folio}`, `IP: ${req.ip}`];

    await query(
      `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, icono, titulo, descripcion, meta, acciones, documento_id)
       SELECT u.id, 'consulta', 'border-l-blue-500', 'Consulta', 'bg-blue-50 text-blue-700', '👁️',
              CASE WHEN u.id = $1 THEN $2 ELSE $3 END,
              $4, $5::jsonb, '[]'::jsonb, $6
         FROM usuarios u JOIN roles r ON r.id = u.rol_id
        WHERE r.clave IN ('super-admin', 'compliance') AND u.activo
          AND NOT EXISTS (
            SELECT 1 FROM notificaciones n
             WHERE n.usuario_id = u.id AND n.documento_id = $6 AND n.categoria = 'consulta'
               AND n.titulo = CASE WHEN u.id = $1 THEN $2 ELSE $3 END
               AND n.creado_en > now() - interval '30 seconds')`,
      [req.user.id, tituloPropio, tituloAjeno, `Acceso de lectura al expediente ${doc.folio}.`, JSON.stringify(meta), doc.id]);
  } catch (e) {
    console.error('No se pudo registrar la notificación de consulta:', e.message);
  }
}
