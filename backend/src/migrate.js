/**
 * Migraciones ordenadas. Se aplican al arrancar la API, así una base ya creada (por ejemplo en Neon)
 * se actualiza sola al desplegar, sin correr SQL a mano.
 *
 * Reglas para escribir una migración nueva:
 *  1. Se AÑADE al final de MIGRACIONES; nunca se edita ni se reordena una ya publicada.
 *  2. Debe ser ADITIVA (agregar columnas/tablas/índices; nada de DROP de datos) e IDEMPOTENTE
 *     (IF NOT EXISTS, DROP CONSTRAINT IF EXISTS...), porque una base nueva creada con schema.sql
 *     también las recorre.
 *  3. Se prueba primero en la rama dev de Neon; producción la aplica sola al arrancar tras el despliegue.
 *
 * Cada migración corre en su propia transacción junto con el INSERT en migraciones_aplicadas:
 * o se aplica entera y queda registrada, o no se aplica nada.
 */

/** @type {{ nombre: string, up: (c: import('pg').ClientBase) => Promise<void> }[]} */
export const MIGRACIONES = [
  {
    // Antes vivía como SQL suelto en aplicarMigraciones(). Es idempotente, así que en bases que ya la
    // tenían (producción) simplemente se vuelve a aplicar una vez y queda registrada.
    nombre: '001_notificaciones_categoria_consulta',
    async up(c) {
      await c.query(`ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_categoria_check`);
      await c.query(`ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_categoria_check
                     CHECK (categoria IN ('edicion','version','eliminado','seguridad','consulta'))`);
    },
  },
];

// Número arbitrario y fijo para el candado consultivo: si arrancan dos instancias a la vez,
// la segunda espera a que la primera termine en lugar de aplicar lo mismo en paralelo.
const CANDADO_MIGRACIONES = 4_241_001;

/**
 * Aplica las migraciones pendientes en orden.
 * @param {import('pg').Pool} pool
 * @param {{ migraciones?: typeof MIGRACIONES, log?: (m: string) => void }} [opciones]
 * @returns {Promise<string[]>} nombres de las migraciones aplicadas en esta ejecución
 */
export async function aplicarMigraciones(pool, { migraciones = MIGRACIONES, log = console.log } = {}) {
  const nombres = migraciones.map((m) => m.nombre);
  if (new Set(nombres).size !== nombres.length) throw new Error('Hay migraciones con nombre repetido.');

  const c = await pool.connect();
  const aplicadas = [];
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
                     nombre      text PRIMARY KEY,
                     aplicada_en timestamptz NOT NULL DEFAULT now())`);
    for (const m of migraciones) {
      await c.query('BEGIN');
      try {
        await c.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_MIGRACIONES]);
        const { rowCount } = await c.query('SELECT 1 FROM migraciones_aplicadas WHERE nombre = $1', [m.nombre]);
        if (rowCount) {
          await c.query('COMMIT');
          continue;
        }
        await m.up(c);
        await c.query('INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)', [m.nombre]);
        await c.query('COMMIT');
        aplicadas.push(m.nombre);
        log(`→ Migración aplicada: ${m.nombre}`);
      } catch (e) {
        await c.query('ROLLBACK');
        e.message = `Migración "${m.nombre}" falló (no se aplicó nada de ella): ${e.message}`;
        throw e;
      }
    }
  } finally {
    c.release();
  }
  return aplicadas;
}
