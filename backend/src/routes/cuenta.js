/**
 * "Seguridad de mi cuenta": lo que cada usuario hace sobre SU propia cuenta (requiere sesión).
 *
 * Toda acción sensible pide reautenticación ("step-up"): con solo robar una sesión abierta (un equipo sin
 * bloquear, un token filtrado) no se puede cambiar la contraseña ni el autenticador. Hace falta además la
 * contraseña actual y/o un código de la app (o de recuperación), con los mismos límites de intentos que el login.
 *
 * Un dato de reautenticación incorrecto responde 403 y NO 401: 401 significa "no hay sesión" y el front cierra
 * la sesión al recibirlo; equivocarse al escribir la contraseña actual no debe sacar a nadie.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db.js';
import { registrarAuditoria } from '../lib/audit.js';
import { fechaHoraCO } from '../lib/format.js';
import { errorContrasena, MAX_BYTES_CONTRASENA, MIN_CONTRASENA } from '../lib/contrasena.js';
import { EMISOR } from '../lib/totp.js';
import {
  codigosRestantes, confirmarAlta, generarCodigosRecuperacion, iniciarAlta, leerSegundoFactor,
  verificarSegundoFactor, VIDA_PENDIENTE_MIN,
} from '../lib/mfa.js';
import {
  BLOQUEO_MIN, clave2fa, claveContrasena, estaBloqueado, limpiarFallos, MENSAJE_BLOQUEO, registrarFallo,
} from '../lib/intentos.js';
import { limitadorIp, tokenDeAcceso, USUARIO_SQL } from './auth.js';

const router = Router();

async function cargarYo(req) {
  const { rows: [u] } = await query(`${USUARIO_SQL} WHERE u.id = $1`, [req.user.id]);
  return u;
}

/** Cuenta un fallo y audita el bloqueo cuando empieza. */
async function fallo(req, clave, accion, detalle) {
  const f = await registrarFallo(clave);
  await registrarAuditoria(req, accion, null, detalle);
  if (f.recienBloqueado) await registrarAuditoria(req, 'bloqueo_temporal', null, { motivo: detalle.tipo, minutos: BLOQUEO_MIN });
}

/**
 * Reautenticación. Devuelve null si todo está bien o { status, error } para responder.
 * @param {{ password?: string|false, factor?: ReturnType<typeof leerSegundoFactor> }} pruebas
 */
async function reautenticar(req, u, { password = false, factor }, accionFallo) {
  const clavePwd = claveContrasena(u.email);
  const clave2 = clave2fa(u.id);
  if ((password !== false && (await estaBloqueado(clavePwd))) || (factor && (await estaBloqueado(clave2))))
    return { status: 429, error: MENSAJE_BLOQUEO };

  if (password !== false) {
    if (!u.password_hash || !(await bcrypt.compare(password, u.password_hash))) {
      await fallo(req, clavePwd, accionFallo, { tipo: 'contrasena' });
      return { status: 403, error: 'La contraseña actual no es correcta.' };
    }
    await limpiarFallos(clavePwd);
  }
  if (factor) {
    if (!(await verificarSegundoFactor(u.id, factor))) {
      await fallo(req, clave2, accionFallo, { tipo: factor.tipo });
      return { status: 403, error: factor.tipo === 'recuperacion' ? 'Código de recuperación incorrecto o ya usado.' : 'Código de verificación incorrecto.' };
    }
    await limpiarFallos(clave2);
  }
  return null;
}

/** Estado de seguridad de la cuenta. */
router.get('/seguridad', async (req, res) => {
  const { rows: [u] } = await query(
    `SELECT nombre, email, mfa_secreto IS NOT NULL AS mfa_activo, mfa_activado_en, password_cambiado_en
       FROM usuarios WHERE id = $1`, [req.user.id]);
  res.json({
    nombre: u.nombre,
    email: u.email,
    mfaActivo: u.mfa_activo,
    mfaActivadoEn: u.mfa_activado_en ? fechaHoraCO(u.mfa_activado_en) : null,
    codigosRestantes: await codigosRestantes(req.user.id),
    passwordCambiadoEn: u.password_cambiado_en ? fechaHoraCO(u.password_cambiado_en) : null,
    politicaContrasena: { minimo: MIN_CONTRASENA, maximoBytes: MAX_BYTES_CONTRASENA },
  });
});

/**
 * Cambio de contraseña: actual + nueva + segundo factor. Sube la versión de sesión (TODAS las sesiones abiertas,
 * en cualquier equipo, quedan cerradas) y devuelve un token nuevo para que ESTA pestaña siga trabajando.
 */
router.post('/password', limitadorIp, async (req, res) => {
  const { actual, nueva } = req.body ?? {};
  if (typeof actual !== 'string' || !actual) return res.status(400).json({ error: 'Ingrese su contraseña actual.' });
  const u = await cargarYo(req);
  const errorPolitica = errorContrasena(nueva, { email: u.email });
  if (errorPolitica) return res.status(400).json({ error: errorPolitica });
  if (nueva === actual) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual.' });
  const factor = leerSegundoFactor(req.body);
  if (factor.error) return res.status(400).json({ error: factor.error });
  if (!u.mfa_secreto) return res.status(409).json({ error: 'Active primero la verificación en dos pasos.' });

  const problema = await reautenticar(req, u, { password: actual, factor }, 'cambiar_contrasena_fallido');
  if (problema) return res.status(problema.status).json({ error: problema.error });

  const hash = await bcrypt.hash(nueva, 12);
  const { rows: [r] } = await query(
    `UPDATE usuarios SET password_hash = $2, sesion_version = sesion_version + 1, password_cambiado_en = now()
      WHERE id = $1 RETURNING sesion_version`, [u.id, hash]);
  await registrarAuditoria(req, 'cambiar_contrasena', null, { segundoFactor: factor.tipo });
  res.json({ ok: true, token: tokenDeAcceso({ ...u, sesion_version: r.sesion_version }) });
});

/** Cambiar de teléfono / app: contraseña + factor actual → secreto nuevo PENDIENTE (el actual sigue valiendo). */
router.post('/2fa/reconfigurar/iniciar', limitadorIp, async (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Ingrese su contraseña actual.' });
  const factor = leerSegundoFactor(req.body);
  if (factor.error) return res.status(400).json({ error: factor.error });
  const u = await cargarYo(req);
  if (!u.mfa_secreto) return res.status(409).json({ error: 'La verificación en dos pasos no está activa. Cierre sesión y vuelva a entrar para configurarla.' });

  const problema = await reautenticar(req, u, { password, factor }, '2fa_reconfigurar_fallido');
  if (problema) return res.status(problema.status).json({ error: problema.error });

  const alta = await iniciarAlta(u);
  await registrarAuditoria(req, '2fa_alta_iniciada', null, { via: 'reconfigurar' });
  res.json({ ...alta, emisor: EMISOR, caducaEnMinutos: VIDA_PENDIENTE_MIN });
});

/** Confirma el autenticador nuevo con un código generado por él. Desde ese momento el anterior deja de servir. */
router.post('/2fa/reconfigurar/confirmar', limitadorIp, async (req, res) => {
  const code = req.body?.code;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Complete el código de verificación de 6 dígitos.' });
  const clave = clave2fa(req.user.id);
  if (await estaBloqueado(clave)) return res.status(429).json({ error: MENSAJE_BLOQUEO });

  const r = await confirmarAlta(req.user.id, code);
  if (r === 'sin_pendiente' || r === 'caducado') return res.status(400).json({ error: 'El código QR caducó. Empiece de nuevo.', nuevoQr: true });
  if (r !== 'ok') {
    await fallo(req, clave, '2fa_fallido', { tipo: 'reconfigurar' });
    return res.status(403).json({ error: 'Código incorrecto. Revise que la hora de su teléfono esté en automático.' });
  }
  await limpiarFallos(clave);
  await registrarAuditoria(req, '2fa_reconfigurado');
  res.json({ ok: true });
});

/** Genera 10 códigos de recuperación nuevos (los anteriores dejan de servir). Pide un código de la app. */
router.post('/2fa/codigos-recuperacion', limitadorIp, async (req, res) => {
  const factor = leerSegundoFactor(req.body);
  if (factor.error) return res.status(400).json({ error: factor.error });
  const u = await cargarYo(req);
  if (!u.mfa_secreto) return res.status(409).json({ error: 'Active primero la verificación en dos pasos.' });

  const problema = await reautenticar(req, u, { factor }, '2fa_codigos_fallido');
  if (problema) return res.status(problema.status).json({ error: problema.error });

  const codigos = await withTransaction((c) => generarCodigosRecuperacion(u.id, c));
  await registrarAuditoria(req, '2fa_codigos_regenerados', null, { cantidad: codigos.length });
  res.json({ codigosRecuperacion: codigos });
});

export default router;
