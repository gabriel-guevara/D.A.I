import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err) => console.error('Error inesperado en el pool de PostgreSQL:', err.message));

// Pool que usan las rutas. Solo las pruebas lo cambian (usarPool) para trabajar en su esquema temporal.
let activo = pool;
export function usarPool(otro) {
  activo = otro;
}

export const query = (text, params) => activo.query(text, params);

/** Ejecuta fn(client) dentro de una transacción. */
export async function withTransaction(fn) {
  const client = await activo.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
