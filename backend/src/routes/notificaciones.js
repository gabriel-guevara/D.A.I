import { Router } from 'express';
import { query } from '../db.js';
import { haceCuanto, idValido } from '../lib/format.js';

const router = Router();
const CATEGORIAS = ['edicion', 'version', 'eliminado', 'seguridad'];

/** Lista del usuario autenticado (misma forma que Notification del front). */
router.get('/', async (req, res) => {
  const params = [req.user.id];
  let filtro = '';
  if (CATEGORIAS.includes(req.query.categoria)) {
    params.push(req.query.categoria);
    filtro = 'AND categoria = $2';
  }
  const { rows } = await query(
    `SELECT * FROM notificaciones WHERE usuario_id = $1 ${filtro} ORDER BY creado_en DESC LIMIT 200`, params);
  res.json(rows.map((n) => ({
    id: String(n.id), category: n.categoria, borderColor: n.borde_clase, badge: n.badge, badgeColor: n.badge_clase,
    icon: n.icono ?? '🔔', title: n.titulo, description: n.descripcion, time: haceCuanto(n.creado_en, true),
    meta: n.meta, actions: n.acciones, read: n.leida,
  })));
});

/** Para el contador de la barra lateral. */
router.get('/resumen', async (req, res) => {
  const { rows: [r] } = await query(`SELECT count(*)::int AS no_leidas FROM notificaciones WHERE usuario_id = $1 AND NOT leida`, [req.user.id]);
  res.json({ noLeidas: r.no_leidas });
});

router.post('/leer-todas', async (req, res) => {
  await query(`UPDATE notificaciones SET leida = true WHERE usuario_id = $1 AND NOT leida`, [req.user.id]);
  res.status(204).end();
});

router.patch('/:id/leida', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'No encontrada' });
  const { rowCount } = await query(`UPDATE notificaciones SET leida = true WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.user.id]);
  rowCount ? res.status(204).end() : res.status(404).json({ error: 'No encontrada' });
});

export default router;
