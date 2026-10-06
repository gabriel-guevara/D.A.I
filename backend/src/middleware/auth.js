import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/** Exige un JWT de acceso válido (Authorization: Bearer ...). Deja el usuario en req.user. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (p.typ !== 'access') throw new Error('tipo de token inválido');
    req.user = { id: p.sub, rol: p.rol, rango: p.rango };
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

/** Limita una ruta a ciertos roles (claves de la tabla roles). */
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.rol) ? next() : res.status(403).json({ error: 'No tienes permisos para esta acción' });

export const firmarToken = (payload, typ, expiresIn) =>
  jwt.sign({ ...payload, typ }, config.jwtSecret, { algorithm: 'HS256', expiresIn });

export const verificarToken = (token, typ) => {
  const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (p.typ !== typ) throw new Error('tipo de token inválido');
  return p;
};
