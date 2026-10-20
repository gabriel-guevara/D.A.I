/**
 * Claves de la tabla intentos_acceso (límite de fallos por cuenta). Módulo SIN dependencias de config.js ni del
 * pool: lo usan la API (lib/intentos.js) y el script de emergencia admin:reset-password, que quita el bloqueo.
 *  - contrasena:<sha256 del correo en minúsculas>  → mismo trato exista o no la cuenta (no revela usuarios)
 *  - 2fa:<id de usuario>                            → códigos TOTP o de recuperación
 */
import crypto from 'node:crypto';

export const claveContrasena = (email) =>
  `contrasena:${crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex')}`;
export const clave2fa = (usuarioId) => `2fa:${String(usuarioId)}`;
