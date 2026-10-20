import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query } from '../db.js';
import { firmarToken, verificarToken, requireAuth, versionVigente } from '../middleware/auth.js';
import { registrarAuditoriaDe } from '../lib/audit.js';
import { alertarSeguridad } from '../lib/notify.js';
import { ALERTAS } from '../lib/alertas-seguridad.js';
import { EMISOR } from '../lib/totp.js';
import {
  codigosRestantes, confirmarAlta, generarCodigosRecuperacion, iniciarAlta, leerSegundoFactor,
  verificarSegundoFactor, VIDA_PENDIENTE_MIN,
} from '../lib/mfa.js';
import {
  BLOQUEO_MIN, clave2fa, claveContrasena, estaBloqueado, limpiarFallos, MENSAJE_BLOQUEO, registrarFallo,
} from '../lib/intentos.js';

const router = Router();

/**
 * Límite por IP (además del límite por cuenta de lib/intentos.js). Solo cuentan las respuestas con error
 * (skipSuccessfulRequests): un ingreso normal hace 2-3 peticiones correctas y no debe gastar cupo, mientras
 * que quien prueba contraseñas o códigos falla siempre y se frena a los 20 intentos en 15 minutos.
 */
export const limitadorIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: MENSAJE_BLOQUEO },
});

// Hash falso para que el tiempo de respuesta sea parecido exista o no el usuario
const HASH_FALSO = bcrypt.hashSync('contraseña-inexistente', 12);

// Vida de los tokens intermedios: el del código 2FA y el de alta obligatoria (escanear el QR toma más tiempo).
const VIDA_MFA = '5m';
const VIDA_ENROLAR = '10m';

export const USUARIO_SQL = `
  SELECT u.id, u.nombre, u.email, u.activo, u.password_hash, u.mfa_secreto, u.mfa_metodo, u.sesion_version,
         r.clave AS rol, r.nombre AS rol_nombre, n.rango, n.nombre AS nivel
  FROM usuarios u
  JOIN roles r ON r.id = u.rol_id
  JOIN niveles_acceso n ON n.id = u.nivel_id`;

const usuarioPublico = (u) => ({ name: u.nombre, role: u.rol_nombre, email: u.email, rolClave: u.rol, nivel: u.nivel });

/** Token de sesión (incluye la versión de sesión: si sube en la base, este token deja de valer). */
export const tokenDeAcceso = (u) =>
  firmarToken({ sub: String(u.id), rol: u.rol, rango: u.rango, ver: u.sesion_version }, 'access', config.jwtExpiresIn);

/** Bloqueo temporal de la cuenta: se audita una sola vez, cuando empieza. */
async function fallo(req, usuarioId, clave, accion, detalle) {
  const f = await registrarFallo(clave);
  if (usuarioId) {
    await registrarAuditoriaDe(req, usuarioId, accion, detalle);
    if (f.recienBloqueado) {
      await registrarAuditoriaDe(req, usuarioId, 'bloqueo_temporal', { motivo: detalle.tipo ?? accion, minutos: BLOQUEO_MIN });
      await alertarSeguridad(req, usuarioId, ALERTAS.bloqueo(BLOQUEO_MIN));
    }
  }
  return f;
}

/**
 * Valida un token intermedio ('mfa' o 'enrolar') y carga al usuario. null = hay que volver a empezar
 * (token vencido, cuenta desactivada o la contraseña cambió entre medias).
 */
async function usuarioDelToken(token, typ) {
  let payload;
  try {
    payload = verificarToken(token, typ);
  } catch {
    return null;
  }
  const { rows: [u] } = await query(`${USUARIO_SQL} WHERE u.id = $1`, [payload.sub]);
  if (!u || !u.activo || !u.password_hash || !versionVigente(payload, u)) return null;
  return u;
}

const REINICIAR = { error: 'La verificación expiró. Vuelva a ingresar usuario y contraseña.', reiniciar: true };

async function abrirSesion(req, res, u, detalle, extra = {}) {
  await query(`UPDATE usuarios SET ultimo_acceso = now() WHERE id = $1`, [u.id]);
  await registrarAuditoriaDe(req, u.id, 'login', detalle);
  await alertarSeguridad(req, u.id, ALERTAS.ingreso(detalle.metodo));
  res.json({ token: tokenDeAcceso(u), user: usuarioPublico(u), ...extra });
}

/**
 * Paso 1: usuario + contraseña.
 *  - Con 2FA activo → { paso: '2fa', mfaToken } (5 min) para el paso 2.
 *  - Sin 2FA        → { paso: 'enrolar', enrolToken } (10 min): DEBE configurarlo ahora para entrar.
 * El mensaje de error es el mismo exista o no la cuenta, esté inactiva o bloqueada por intentos.
 */
router.post('/login', limitadorIp, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Ingrese su correo corporativo y su contraseña.' });
  }
  const clave = claveContrasena(username);
  if (await estaBloqueado(clave)) return res.status(429).json({ error: MENSAJE_BLOQUEO });

  const { rows: [u] } = await query(`${USUARIO_SQL} WHERE lower(u.email) = lower($1)`, [username.trim()]);
  const ok = await bcrypt.compare(password, u?.password_hash ?? HASH_FALSO);
  if (!u || !u.password_hash || !u.activo || !ok) {
    await fallo(req, u?.id, clave, 'login_fallido', { tipo: 'contrasena', motivo: u && !u.activo ? 'cuenta_inactiva' : 'credenciales' });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  await limpiarFallos(clave);

  const base = { sub: String(u.id), ver: u.sesion_version };
  // "ahora" (ms): hora del servidor, para que el contador del front marque los mismos segundos que la app del
  // teléfono aunque el reloj del computador esté desfasado (el servidor es quien valida los códigos).
  const ahora = Date.now();
  if (u.mfa_secreto) return res.json({ paso: '2fa', mfaToken: firmarToken(base, 'mfa', VIDA_MFA), metodo: u.mfa_metodo, ahora });
  res.json({ paso: 'enrolar', enrolToken: firmarToken(base, 'enrolar', VIDA_ENROLAR), ahora });
});

/** Paso 2: código TOTP de 6 dígitos (o un código de recuperación) → token de sesión. */
router.post('/verify-2fa', limitadorIp, async (req, res) => {
  const factor = leerSegundoFactor(req.body);
  if (factor.error) return res.status(400).json({ error: factor.error });
  const u = await usuarioDelToken(req.body?.mfaToken, 'mfa');
  if (!u || !u.mfa_secreto) return res.status(401).json(REINICIAR);

  const clave = clave2fa(u.id);
  if (await estaBloqueado(clave)) return res.status(429).json({ error: MENSAJE_BLOQUEO });
  if (!(await verificarSegundoFactor(u.id, factor))) {
    await fallo(req, u.id, clave, '2fa_fallido', { tipo: factor.tipo });
    return res.status(401).json({ error: factor.tipo === 'recuperacion' ? 'Código de recuperación incorrecto o ya usado.' : 'Código de verificación incorrecto.' });
  }
  await limpiarFallos(clave);

  if (factor.tipo === 'recuperacion') {
    const restantes = await codigosRestantes(u.id);
    await registrarAuditoriaDe(req, u.id, '2fa_codigo_recuperacion_usado', { restantes });
    await alertarSeguridad(req, u.id, ALERTAS.codigoRecuperacion(restantes));
    return abrirSesion(req, res, u, { metodo: 'recuperacion' }, { codigosRestantes: restantes });
  }
  await abrirSesion(req, res, u, { metodo: 'totp' });
});

// ---------------------------------------------------------------------------------------------
// Alta OBLIGATORIA de 2FA durante el login (usuarios sin 2FA: nuevos, o a quienes se les restableció).
// ---------------------------------------------------------------------------------------------

/** Genera el secreto (pendiente) y devuelve lo necesario para el QR y la clave manual. */
router.post('/2fa/enrolar/iniciar', limitadorIp, async (req, res) => {
  const u = await usuarioDelToken(req.body?.enrolToken, 'enrolar');
  if (!u) return res.status(401).json(REINICIAR);
  if (u.mfa_secreto) return res.status(409).json({ error: 'Esta cuenta ya tiene la verificación en dos pasos activa. Vuelva a iniciar sesión.', reiniciar: true });

  const alta = await iniciarAlta(u);
  await registrarAuditoriaDe(req, u.id, '2fa_alta_iniciada', { via: 'login' });
  res.json({ ...alta, emisor: EMISOR, caducaEnMinutos: VIDA_PENDIENTE_MIN });
});

/** Confirma con un código de la app: activa el 2FA, entrega los códigos de recuperación y abre la sesión. */
router.post('/2fa/enrolar/confirmar', limitadorIp, async (req, res) => {
  const code = req.body?.code;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Complete el código de verificación de 6 dígitos.' });
  const u = await usuarioDelToken(req.body?.enrolToken, 'enrolar');
  if (!u) return res.status(401).json(REINICIAR);
  if (u.mfa_secreto) return res.status(409).json({ error: 'Esta cuenta ya tiene la verificación en dos pasos activa. Vuelva a iniciar sesión.', reiniciar: true });

  const clave = clave2fa(u.id);
  if (await estaBloqueado(clave)) return res.status(429).json({ error: MENSAJE_BLOQUEO });
  const r = await confirmarAlta(u.id, code);
  if (r === 'sin_pendiente' || r === 'caducado')
    return res.status(400).json({ error: 'El código QR caducó. Genere uno nuevo.', nuevoQr: true });
  if (r !== 'ok') {
    await fallo(req, u.id, clave, '2fa_fallido', { tipo: 'alta' });
    return res.status(401).json({ error: 'Código incorrecto. Revise que la hora de su teléfono esté en automático.' });
  }
  await limpiarFallos(clave);
  const codigos = await generarCodigosRecuperacion(u.id);
  await registrarAuditoriaDe(req, u.id, '2fa_activado', { via: 'login', cantidadCodigos: codigos.length });
  await alertarSeguridad(req, u.id, ALERTAS.dosPasosActivado());
  await abrirSesion(req, res, u, { metodo: 'alta_2fa' }, { codigosRecuperacion: codigos });
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows: [u] } = await query(`${USUARIO_SQL} WHERE u.id = $1 AND u.activo`, [req.user.id]);
  if (!u) return res.status(401).json({ error: 'Sesión inválida' });
  res.json(usuarioPublico(u));
});

export default router;
