/**
 * Alertas de seguridad de la PROPIA cuenta (categoría "seguridad"): ingresos, bloqueos, contraseña y 2FA.
 * Sirven para que cada persona detecte un acceso que no reconoce. Nunca llevan secretos, códigos ni contraseñas.
 *
 * No importa db.js a propósito: la usan también los scripts de emergencia (scripts/admin-reset-*.js), que abren su
 * propia conexión. Quien llama pasa "db" (el pool o un cliente con .query).
 */
import { fechaHoraCO } from './format.js';

const ESTILO = { borde: 'border-l-rose-500', badge: 'Seguridad', badgeClase: 'bg-rose-50 text-rose-700', icono: '🔐' };
const SI_NO_FUISTE = 'Si no fuiste tú, cambia tu contraseña de inmediato y avisa al administrador.';
const METODOS = { totp: 'código de la app autenticadora', recuperacion: 'código de recuperación', alta_2fa: 'configuración de la verificación en dos pasos' };

/** Textos de cada alerta. */
export const ALERTAS = {
  ingreso: (metodo) => ({
    titulo: 'Nuevo inicio de sesión en tu cuenta',
    descripcion: `Se ingresó con tu contraseña y ${METODOS[metodo] ?? 'segundo factor'}. ${SI_NO_FUISTE}`,
  }),
  bloqueo: (minutos) => ({
    titulo: 'Tu cuenta se bloqueó temporalmente',
    descripcion: `Hubo varios intentos fallidos de contraseña o de código. Los intentos quedan bloqueados ${minutos} minutos. ${SI_NO_FUISTE}`,
  }),
  codigoRecuperacion: (restantes) => ({
    titulo: 'Se usó un código de recuperación',
    descripcion: `Se ingresó con uno de tus códigos de recuperación (ya no sirve). Te quedan ${restantes}. ${SI_NO_FUISTE}`,
  }),
  dosPasosActivado: () => ({
    titulo: 'Verificación en dos pasos activada',
    descripcion: 'Tu cuenta ya pide el código de tu app autenticadora en cada ingreso.',
  }),
  dosPasosReconfigurado: () => ({
    titulo: 'Cambiaste tu app autenticadora',
    descripcion: `Desde ahora solo sirven los códigos de la app nueva. ${SI_NO_FUISTE}`,
  }),
  codigosRegenerados: () => ({
    titulo: 'Generaste nuevos códigos de recuperación',
    descripcion: `Los códigos anteriores dejaron de servir. ${SI_NO_FUISTE}`,
  }),
  contrasenaCambiada: () => ({
    titulo: 'Tu contraseña cambió',
    descripcion: `Se cerraron las demás sesiones abiertas. ${SI_NO_FUISTE}`,
  }),
  contrasenaRestablecida: () => ({
    titulo: 'Un administrador restableció tu contraseña',
    descripcion: 'Se cerraron tus sesiones abiertas. Si no lo solicitaste, contacta al administrador del sistema.',
  }),
  dosPasosRestablecido: () => ({
    titulo: 'Un administrador restableció tu verificación en dos pasos',
    descripcion: 'En tu próximo ingreso deberás configurar de nuevo tu app autenticadora. Si no lo solicitaste, contacta al administrador.',
  }),
};

/**
 * Inserta la alerta para ese usuario. origen: la IP de la petición o un texto ("script de emergencia del servidor").
 * Nunca rompe la acción principal: ya ocurrió y quedó auditada.
 */
export async function insertarAlerta(db, usuarioId, { titulo, descripcion }, origen) {
  if (!usuarioId) return;
  try {
    await db.query(
      `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, icono, titulo, descripcion, meta, acciones)
       VALUES ($1, 'seguridad', $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb)`,
      [usuarioId, ESTILO.borde, ESTILO.badge, ESTILO.badgeClase, ESTILO.icono, titulo, descripcion,
        JSON.stringify([`Fecha: ${fechaHoraCO(new Date())}`, `Origen: ${origen}`])]);
  } catch (err) {
    console.error('No se pudo registrar la alerta de seguridad:', err.message);
  }
}
