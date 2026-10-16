/**
 * Quita el 2FA de una cuenta y cierra todas sus sesiones (sube sesion_version). Módulo SIN dependencias de
 * config.js ni del pool: lo usan la API (restablecer por super-admin) y el script de emergencia, que se conecta
 * por su cuenta. Recibe un cliente/pool de pg; conviene llamarlo dentro de una transacción.
 */
export async function quitar2fa(db, usuarioId) {
  await db.query(`DELETE FROM mfa_codigos_recuperacion WHERE usuario_id = $1`, [usuarioId]);
  const { rowCount } = await db.query(
    `UPDATE usuarios SET mfa_secreto = NULL, mfa_secreto_pendiente = NULL, mfa_pendiente_en = NULL,
            mfa_ultimo_paso = NULL, mfa_activado_en = NULL, sesion_version = sesion_version + 1
      WHERE id = $1`, [usuarioId]);
  return rowCount === 1;
}
