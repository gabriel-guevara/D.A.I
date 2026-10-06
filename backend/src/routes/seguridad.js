import { Router } from 'express';
import { query } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { fechaCorta, haceCuanto, iniciales } from '../lib/format.js';

const router = Router();
router.use(requireRole('super-admin', 'compliance'));   // pantalla "Roles y Permisos"

/** Tarjetas de roles con cantidad de usuarios asignados. */
router.get('/roles', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.clave, r.nombre, r.etiqueta, r.color_clase, r.icono, r.descripcion,
            count(u.id) FILTER (WHERE u.activo)::int AS asignados
       FROM roles r LEFT JOIN usuarios u ON u.rol_id = r.id
      GROUP BY r.id ORDER BY r.id`);
  res.json(rows.map((r) => ({
    key: r.clave, name: r.nombre, badge: r.etiqueta, badgeColor: r.color_clase,
    icon: r.icono ?? '', description: r.descripcion ?? '', assignedCount: r.asignados,
  })));
});

/** Tabla de usuarios (misma forma que SecurityUser del front). */
router.get('/usuarios', async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.nombre, u.email, u.avatar_clase, u.mfa_metodo, u.ultimo_acceso, u.activo,
            dep.nombre AS departamento, r.clave AS rol, r.nombre AS rol_nombre, r.color_clase AS rol_color,
            n.nombre AS nivel, n.color_clase AS nivel_color
       FROM usuarios u
       JOIN roles r ON r.id = u.rol_id
       JOIN niveles_acceso n ON n.id = u.nivel_id
       LEFT JOIN departamentos dep ON dep.id = u.departamento_id
      ORDER BY u.nombre`);
  res.json(rows.map((u) => {
    const dias = u.ultimo_acceso ? (Date.now() - new Date(u.ultimo_acceso)) / 86_400_000 : null;
    return {
      id: String(u.id), name: u.nombre, email: u.email, initials: iniciales(u.nombre), avatarColor: u.avatar_clase,
      departamento: u.departamento ?? '—', rol: u.rol, rolLabel: u.rol_nombre, rolColor: u.rol_color,
      mfaMethod: u.mfa_metodo, nivel: u.nivel, nivelColor: u.nivel_color,
      ultimoAcceso: !u.activo ? 'Invitación pendiente' : dias === null ? 'Nunca' : dias < 2 ? haceCuanto(u.ultimo_acceso) : fechaCorta(u.ultimo_acceso),
    };
  }));
});

/** Invita a un usuario: queda inactivo y sin contraseña hasta que active su cuenta. */
router.post('/usuarios/invitar', requireRole('super-admin'), async (req, res) => {
  const { nombre, email, rol, departamento, nivel } = req.body ?? {};
  if (typeof nombre !== 'string' || !nombre.trim() || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Nombre y correo válidos son obligatorios.' });
  }
  try {
    const { rows: [u] } = await query(
      `INSERT INTO usuarios (nombre, email, rol_id, nivel_id, departamento_id, activo)
       SELECT $1, $2, r.id, n.id, (SELECT id FROM departamentos WHERE nombre = $5), false
         FROM roles r, niveles_acceso n
        WHERE r.clave = $3 AND n.nombre = $4
       RETURNING id`, [nombre.trim(), email.trim(), rol ?? 'read-only', nivel ?? 'Nivel 2 Confidencial', departamento ?? null]);
    if (!u) return res.status(400).json({ error: 'Rol o nivel inexistente.' });
    await registrarAuditoria(req, 'invitar_usuario', null, { email });
    // TODO: aquí se enviaría el correo con el enlace de activación (SMTP / servicio de email).
    res.status(201).json({ id: String(u.id) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw e;
  }
});

export default router;
