/**
 * Límite de intentos POR CUENTA (además del límite por IP de express-rate-limit).
 *
 * ¿Por qué otro límite? El de IP no frena a quien prueba desde muchas IP contra UNA misma cuenta, y en una
 * oficina con una sola IP pública castigaría a todos por los errores de uno. Este cuenta los FALLOS de cada
 * cuenta y, al llegar al tope, la bloquea un rato (incluso con la contraseña o el código correctos: si no,
 * el bloqueo no serviría de nada).
 *
 * Vive en PostgreSQL y no en memoria: Render (plan gratuito) reinicia el proceso al dormirse y un contador en
 * memoria se pondría a cero en cada reinicio.
 *
 * Claves (nunca texto escrito por el usuario en claro):
 *  - contrasena:<sha256 del correo en minúsculas>  → mismo trato exista o no la cuenta (no revela usuarios)
 *  - 2fa:<id de usuario>                            → códigos TOTP o de recuperación
 */
import { query } from '../db.js';
import { clave2fa, claveContrasena } from './intentos-claves.js';

export { clave2fa, claveContrasena }; // las rutas las siguen importando desde aquí

export const LIMITE_FALLOS = 5;
export const VENTANA_MIN = 15;
export const BLOQUEO_MIN = 15;

/** true si la clave está bloqueada ahora mismo. */
export async function estaBloqueado(clave) {
  const { rows: [r] } = await query(`SELECT bloqueado_hasta > now() AS b FROM intentos_acceso WHERE clave = $1`, [clave]);
  return r?.b === true;
}

/**
 * Suma un fallo. Si la ventana de 15 min ya pasó, empieza a contar de nuevo.
 * @returns {Promise<{ fallos: number, bloqueado: boolean, recienBloqueado: boolean }>}
 */
export async function registrarFallo(clave) {
  const { rows: [r] } = await query(
    `WITH previo AS (SELECT bloqueado_hasta > now() AS antes FROM intentos_acceso WHERE clave = $1)
     INSERT INTO intentos_acceso AS i (clave, fallos, ventana_inicio) VALUES ($1, 1, now())
     ON CONFLICT (clave) DO UPDATE SET
       fallos = CASE WHEN i.ventana_inicio < now() - make_interval(mins => $2) THEN 1 ELSE i.fallos + 1 END,
       ventana_inicio = CASE WHEN i.ventana_inicio < now() - make_interval(mins => $2) THEN now() ELSE i.ventana_inicio END
     RETURNING i.fallos, coalesce((SELECT antes FROM previo), false) AS antes`,
    [clave, VENTANA_MIN]);
  let bloqueado = r.antes;
  let recienBloqueado = false;
  if (!bloqueado && r.fallos >= LIMITE_FALLOS) {
    await query(`UPDATE intentos_acceso SET bloqueado_hasta = now() + make_interval(mins => $2), fallos = 0, ventana_inicio = now()
                  WHERE clave = $1`, [clave, BLOQUEO_MIN]);
    bloqueado = recienBloqueado = true;
  }
  // Limpieza: filas viejas sin bloqueo vigente (la tabla no crece sin fin con correos inventados).
  await query(`DELETE FROM intentos_acceso WHERE ventana_inicio < now() - interval '1 day'
                AND (bloqueado_hasta IS NULL OR bloqueado_hasta < now())`);
  return { fallos: r.fallos, bloqueado, recienBloqueado };
}

/** Tras un acierto, el contador vuelve a cero. */
export async function limpiarFallos(clave) {
  await query(`DELETE FROM intentos_acceso WHERE clave = $1 AND (bloqueado_hasta IS NULL OR bloqueado_hasta < now())`, [clave]);
}

export const MENSAJE_BLOQUEO = 'Demasiados intentos. Inténtalo de nuevo en unos minutos.';
