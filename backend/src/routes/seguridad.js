import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { fechaCorta, haceCuanto, iniciales, idValido } from '../lib/format.js';

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
      mfaMethod: u.mfa_metodo, nivel: u.nivel, nivelColor: u.nivel_color, activo: u.activo,
      ultimoAcceso: !u.activo ? 'Invitación pendiente' : dias === null ? 'Nunca' : dias < 2 ? haceCuanto(u.ultimo_acceso) : fechaCorta(u.ultimo_acceso),
    };
  }));
});

// ---------------------------------------------------------------------------------------------
// Crear y modificar usuarios
// ---------------------------------------------------------------------------------------------
const MFA_METODOS = ['TOTP', 'TOTP 2 Dispositivos', 'FIDO2 Yubikey', 'Push OTP Dispositivo', 'SMS Backup', 'eOTP CorpID'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valida el cuerpo. En "crear" nombre, email, contraseña, rol y nivel son obligatorios; en "modificar" todo es opcional. */
function validarUsuario(b, crear) {
  const d = {};
  const err = (error) => ({ error });

  if (crear || b.nombre !== undefined) {
    if (typeof b.nombre !== 'string' || b.nombre.trim().length < 2 || b.nombre.trim().length > 120) return err('El nombre debe tener entre 2 y 120 caracteres.');
    d.nombre = b.nombre.trim();
  }
  if (crear || b.email !== undefined) {
    if (typeof b.email !== 'string' || !EMAIL_RE.test(b.email.trim()) || b.email.trim().length > 160) return err('Ingrese un correo institucional válido.');
    d.email = b.email.trim();
  }
  if (crear || (typeof b.password === 'string' && b.password !== '')) {
    const p = b.password;
    // bcrypt solo usa los primeros 72 bytes: por eso ese es el máximo
    if (typeof p !== 'string' || p.length < 8 || Buffer.byteLength(p) > 72) return err('La contraseña debe tener entre 8 y 72 caracteres.');
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return err('La contraseña debe incluir al menos una letra y un número.');
    d.password = p;
  }
  if (crear || b.rol !== undefined) {
    if (typeof b.rol !== 'string' || !b.rol) return err('Seleccione un rol.');
    d.rol = b.rol;
  }
  if (crear || b.nivel !== undefined) {
    if (typeof b.nivel !== 'string' || !b.nivel) return err('Seleccione un nivel de confidencialidad.');
    d.nivel = b.nivel;
  }
  if (b.departamento !== undefined) {
    if (b.departamento !== null && typeof b.departamento !== 'string') return err('Departamento no válido.');
    d.departamento = b.departamento ? b.departamento : null;
  }
  if (b.mfaMetodo !== undefined || crear) {
    const m = b.mfaMetodo ?? 'TOTP';
    if (!MFA_METODOS.includes(m)) return err('Método de 2FA no válido.');
    d.mfaMetodo = m;
  }
  if (b.activo !== undefined) {
    if (typeof b.activo !== 'boolean') return err('Estado de la cuenta no válido.');
    d.activo = b.activo;
  }
  return { datos: d };
}

/** Busca rol, nivel y departamento por nombre/clave. Devuelve undefined en los que no se pidieron. */
async function resolverCatalogos(db, d) {
  const uno = async (sql, valor) => (valor === undefined || valor === null ? undefined : (await db.query(sql, [valor])).rows[0] ?? false);
  return {
    rol: await uno('SELECT id, clave FROM roles WHERE clave = $1', d.rol),
    nivel: await uno('SELECT id, rango FROM niveles_acceso WHERE nombre = $1', d.nivel),
    dep: await uno('SELECT id FROM departamentos WHERE nombre = $1', d.departamento),
  };
}

/** Crea un usuario activo con contraseña inicial (solo Super Administrador). */
router.post('/usuarios', requireRole('super-admin'), async (req, res) => {
  const v = validarUsuario(req.body ?? {}, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;

  const { rol, nivel, dep } = await resolverCatalogos({ query }, d);
  if (!rol) return res.status(400).json({ error: 'El rol seleccionado no existe.' });
  if (!nivel) return res.status(400).json({ error: 'El nivel seleccionado no existe.' });
  if (d.departamento && !dep) return res.status(400).json({ error: 'El departamento seleccionado no existe.' });

  const hash = await bcrypt.hash(d.password, 12);
  try {
    const { rows: [u] } = await query(
      `INSERT INTO usuarios (nombre, email, password_hash, departamento_id, rol_id, nivel_id, mfa_metodo, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
      [d.nombre, d.email, hash, dep?.id ?? null, rol.id, nivel.id, d.mfaMetodo]);
    await registrarAuditoria(req, 'crear_usuario', null, { usuarioId: u.id, email: d.email, rol: rol.clave });
    res.status(201).json({ id: String(u.id) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw e;
  }
});

/** Modifica un usuario (solo Super Administrador). Todos los campos son opcionales. */
router.patch('/usuarios/:id', requireRole('super-admin'), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const v = validarUsuario(req.body ?? {}, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  if (Object.keys(d).length === 0) return res.status(400).json({ error: 'No hay cambios que guardar.' });

  try {
    const resultado = await withTransaction(async (c) => {
      const { rows: [t] } = await c.query(
        `SELECT u.id, u.activo, u.password_hash, r.clave AS rol
           FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1 FOR UPDATE OF u`, [req.params.id]);
      if (!t) return { status: 404, error: 'Usuario no encontrado.' };

      const { rol, nivel, dep } = await resolverCatalogos(c, d);
      if (rol === false) return { status: 400, error: 'El rol seleccionado no existe.' };
      if (nivel === false) return { status: 400, error: 'El nivel seleccionado no existe.' };
      if (dep === false) return { status: 400, error: 'El departamento seleccionado no existe.' };

      // Evita que un administrador se deje sin acceso a sí mismo
      const esYo = String(t.id) === String(req.user.id);
      const nuevoRol = rol?.clave ?? t.rol;
      const nuevoActivo = d.activo ?? t.activo;
      if (esYo && (nuevoRol !== t.rol || nuevoActivo === false)) {
        return { status: 400, error: 'No puedes desactivar tu propia cuenta ni cambiar tu propio rol.' };
      }
      // Una cuenta sin contraseña (invitación pendiente) no se puede activar si no se le asigna una
      if (nuevoActivo && !t.password_hash && !d.password) {
        return { status: 400, error: 'Asigne una contraseña para poder activar esta cuenta.' };
      }

      const sets = [];
      const params = [];
      const poner = (columna, valor) => { params.push(valor); sets.push(`${columna} = $${params.length}`); };
      if (d.nombre !== undefined) poner('nombre', d.nombre);
      if (d.email !== undefined) poner('email', d.email);
      if (rol) poner('rol_id', rol.id);
      if (nivel) poner('nivel_id', nivel.id);
      if (d.departamento !== undefined) poner('departamento_id', dep?.id ?? null);
      if (d.mfaMetodo !== undefined) poner('mfa_metodo', d.mfaMetodo);
      if (d.activo !== undefined) poner('activo', d.activo);
      if (d.password !== undefined) poner('password_hash', await bcrypt.hash(d.password, 12));

      params.push(t.id);
      await c.query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      return { status: 200 };
    });

    if (resultado.status !== 200) return res.status(resultado.status).json({ error: resultado.error });
    const campos = Object.keys(d).map((k) => (k === 'password' ? 'contraseña restablecida' : k));
    await registrarAuditoria(req, 'modificar_usuario', null, { usuarioId: req.params.id, campos });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw e;
  }
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
