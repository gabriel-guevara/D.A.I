/**
 * Backfill / reproceso del texto desde la terminal (npm run texto:indexar).
 *
 * El mecanismo normal es AUTOMÁTICO: la migración 003 deja "pendiente" cada documento con archivo y la API los
 * procesa al arrancar. Este script sirve para hacerlo a demanda y esperar el resultado:
 *
 *   npm run texto:indexar                          procesa los pendientes (lo mismo que hace la API al arrancar)
 *   npm run texto:indexar -- --reintentar-errores  vuelve a poner en cola los que quedaron en "error"
 *   npm run texto:indexar -- --todos               vuelve a extraer TODOS los documentos con archivo
 *
 * Idempotente: correrlo dos veces no duplica páginas (cada extracción reemplaza las anteriores del documento).
 * Si el objeto no está en el almacenamiento de ESTE entorno (p. ej. base dev copiada de producción con
 * STORAGE_DRIVER=local), el documento queda en "error" con "Archivo no disponible en este entorno"; no falla.
 * No borra nada ni imprime la cadena de conexión.
 */
import { config } from '../src/config.js';
import { pool, query } from '../src/db.js';
import { aplicarMigraciones } from '../src/migrate.js';
import { inicializarAlmacenamiento } from '../src/lib/storage.js';
import { despertarIndexador, esperarIndexador } from '../src/lib/indexador.js';

const todos = process.argv.includes('--todos');
const errores = process.argv.includes('--reintentar-errores');

try {
  const st = await inicializarAlmacenamiento(config.storage);
  console.log(`Almacenamiento: ${st.driver} · APP_ENV=${config.appEnv}`);
  await aplicarMigraciones(pool);

  if (todos || errores) {
    // Misma fila que solicitarIndexacion(), en bloque. Los que están "procesando" no se tocan.
    const { rowCount } = await query(
      `INSERT INTO documento_indexacion (documento_id, estado, motivo)
       SELECT d.id, 'pendiente', 'script' FROM documentos d
         LEFT JOIN documento_indexacion i ON i.documento_id = d.id
        WHERE d.tiene_archivo AND (i.documento_id IS NULL OR ${todos ? `i.estado <> 'procesando'` : `i.estado = 'error'`})
       ON CONFLICT (documento_id) DO UPDATE
          SET estado = 'pendiente', motivo = 'script', solicitado_por = NULL, solicitado_en = now(),
              intentos = 0, iniciado_en = NULL, error_codigo = NULL, error = NULL`);
    console.log(`→ ${rowCount} documento(s) puestos en cola.`);
  }

  const { rows: [p] } = await query(`SELECT count(*)::int AS n FROM documento_indexacion WHERE estado = 'pendiente'`);
  console.log(`→ Procesando ${p.n} pendiente(s), uno a la vez...`);
  despertarIndexador();
  await esperarIndexador();

  const { rows } = await query(
    `SELECT estado, coalesce(error_codigo, '') AS codigo, count(*)::int AS n FROM documento_indexacion
      GROUP BY 1, 2 ORDER BY 1, 2`);
  console.log('Estado de la indexación:');
  for (const r of rows) console.log(`  ${r.estado}${r.codigo ? ` (${r.codigo})` : ''}: ${r.n}`);
} catch (e) {
  console.error('✖ Error:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
