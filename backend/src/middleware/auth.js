import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

/**
 * Exige un JWT de acceso válido (Authorization: Bearer ...). Deja el usuario en req.user.
 * El rol, el nivel y el estado se leen de la base de datos en cada petición (no del token), así un
 * usuario desactivado o con el rol cambiado pierde el acceso de inmediato, sin esperar a que expire.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (payload.typ !== 'access') throw new Error('tipo de token inválido');
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }

  const { rows: [u] } = await query(
    `SELECT u.activo, u.sesion_version, r.clave AS rol, n.rango
       FROM usuarios u JOIN roles r ON r.id = u.rol_id JOIN niveles_acceso n ON n.id = u.nivel_id
      WHERE u.id = $1`, [payload.sub]);
  if (!u || !u.activo) return res.status(401).json({ error: 'Cuenta desactivada o inexistente' });
  // Versión de sesión: al cambiar la contraseña (o restablecer el 2FA) sube en la base y todos los tokens
  // emitidos antes dejan de valer. Los tokens anteriores a la Fase 3 no traen "ver": cuentan como 0.
  if (!versionVigente(payload, u)) return res.status(401).json({ error: 'Sesión cerrada por un cambio de seguridad. Vuelva a iniciar sesión.' });

  req.user = { id: payload.sub, rol: u.rol, rango: u.rango };
  next();
}

/** Limita una ruta a ciertos roles (claves de la tabla roles). */
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.rol) ? next() : res.status(403).json({ error: 'No tienes permisos para esta acción' });

/** El token pertenece a la versión de sesión actual del usuario. */
export const versionVigente = (payload, usuario) => (payload.ver ?? 0) === usuario.sesion_version;

export const firmarToken = (payload, typ, expiresIn) =>
  jwt.sign({ ...payload, typ }, config.jwtSecret, { algorithm: 'HS256', expiresIn });

export const verificarToken = (token, typ) => {
  const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (p.typ !== typ) throw new Error('tipo de token inválido');
  return p;
};
