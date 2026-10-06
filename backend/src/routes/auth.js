import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { authenticator } from 'otplib';
import { config } from '../config.js';
import { query } from '../db.js';
import { firmarToken, verificarToken, requireAuth } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';

const router = Router();

// Frena fuerza bruta de contraseña y de código 2FA (por IP)
const limitador = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.' },
});

// Hash falso para que el tiempo de respuesta sea parecido exista o no el usuario
const HASH_FALSO = bcrypt.hashSync('contraseña-inexistente', 12);

const USUARIO_SQL = `
  SELECT u.id, u.nombre, u.email, u.activo, u.mfa_secreto, u.mfa_metodo,
         r.clave AS rol, r.nombre AS rol_nombre, n.rango, n.nombre AS nivel
  FROM usuarios u
  JOIN roles r ON r.id = u.rol_id
  JOIN niveles_acceso n ON n.id = u.nivel_id`;

const usuarioPublico = (u) => ({ name: u.nombre, role: u.rol_nombre, email: u.email, rolClave: u.rol, nivel: u.nivel });

/** Paso 1: usuario + contraseña -> token temporal para el paso 2FA */
router.post('/login', limitador, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Ingrese su usuario institucional y su contraseña.' });
  }
  const { rows: [u] } = await query(
    `SELECT id, password_hash, activo, mfa_metodo FROM usuarios WHERE lower(email) = lower($1)`, [username.trim()]);
  const ok = await bcrypt.compare(password, u?.password_hash ?? HASH_FALSO);
  if (!u || !u.password_hash || !u.activo || !ok) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  res.json({ mfaToken: firmarToken({ sub: String(u.id) }, 'mfa', '5m'), metodo: u.mfa_metodo });
});

/** Paso 2: código de 6 dígitos -> token de sesión */
router.post('/verify-2fa', limitador, async (req, res) => {
  const { mfaToken, code } = req.body ?? {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Complete el código de verificación de 6 dígitos.' });
  }
  let payload;
  try {
    payload = verificarToken(mfaToken, 'mfa');
  } catch {
    return res.status(401).json({ error: 'La verificación expiró. Vuelva a ingresar usuario y contraseña.', reiniciar: true });
  }
  const { rows: [u] } = await query(`${USUARIO_SQL} WHERE u.id = $1`, [payload.sub]);
  if (!u || !u.activo) return res.status(401).json({ error: 'Cuenta no disponible.', reiniciar: true });

  // Con secreto TOTP se valida el código real. Sin secreto, solo en desarrollo se acepta MFA_DEV_CODE.
  const valido = u.mfa_secreto
    ? authenticator.check(code, u.mfa_secreto)
    : !config.isProd && config.mfaDevCode !== null && code === config.mfaDevCode;
  if (!valido) return res.status(401).json({ error: 'Código de verificación incorrecto.' });

  await query(`UPDATE usuarios SET ultimo_acceso = now() WHERE id = $1`, [u.id]);
  req.user = { id: u.id };
  await registrarAuditoria(req, 'login');

  const token = firmarToken({ sub: String(u.id), rol: u.rol, rango: u.rango }, 'access', config.jwtExpiresIn);
  res.json({ token, user: usuarioPublico(u) });
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows: [u] } = await query(`${USUARIO_SQL} WHERE u.id = $1 AND u.activo`, [req.user.id]);
  if (!u) return res.status(401).json({ error: 'Sesión inválida' });
  res.json(usuarioPublico(u));
});

export default router;
