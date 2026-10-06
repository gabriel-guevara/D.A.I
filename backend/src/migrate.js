import { query } from './db.js';

/**
 * Migraciones idempotentes: se ejecutan al arrancar el servidor, así una base ya creada
 * (por ejemplo en Neon) se actualiza sola al desplegar, sin tener que correr SQL a mano.
 */
export async function aplicarMigraciones() {
  // Nueva categoría de notificación: 'consulta' (alguien abrió un documento)
  await query(`ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_categoria_check`);
  await query(`ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_categoria_check
               CHECK (categoria IN ('edicion','version','eliminado','seguridad','consulta'))`);
}
