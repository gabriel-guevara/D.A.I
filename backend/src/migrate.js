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
  {
    // Fase 1: archivos PDF reales. storage_path (ya existía) pasa a ser la clave del objeto que genera el
    // servidor (docs/{doc}/{ver}/{uuid}.pdf). Los documentos existentes (seed o heredados) quedan con
    // tiene_archivo = false: su storage_path era ficticio y NO se usa para servir nada.
    nombre: '002_documentos_archivo_real',
    async up(c) {
      await c.query(`ALTER TABLE documentos ADD COLUMN IF NOT EXISTS tiene_archivo boolean NOT NULL DEFAULT false`);
      await c.query(`ALTER TABLE documentos ADD COLUMN IF NOT EXISTS nombre_original text`);
      await c.query(`ALTER TABLE documentos ADD COLUMN IF NOT EXISTS storage_driver text`);
      await c.query(`ALTER TABLE documento_versiones ADD COLUMN IF NOT EXISTS storage_driver text`);
      // Sin archivo no hay cifrado en reposo que anunciar: el valor por defecto deja de ser true.
      // (Solo cambia el DEFAULT para filas nuevas; no modifica ningún dato existente.)
      await c.query(`ALTER TABLE documentos ALTER COLUMN cifrado_aes SET DEFAULT false`);
      for (const [tabla, nombre, check] of [
        ['documentos', 'documentos_storage_driver_check', `storage_driver IS NULL OR storage_driver IN ('local','r2')`],
        ['documento_versiones', 'documento_versiones_storage_driver_check', `storage_driver IS NULL OR storage_driver IN ('local','r2')`],
        // Un documento "con archivo" siempre sabe dónde está, con qué driver, su huella y su nombre original.
        ['documentos', 'documentos_archivo_completo_check',
          `NOT tiene_archivo OR (storage_path IS NOT NULL AND storage_driver IS NOT NULL AND hash_sha256 IS NOT NULL AND nombre_original IS NOT NULL)`],
      ]) {
        await c.query(`ALTER TABLE ${tabla} DROP CONSTRAINT IF EXISTS ${nombre}`);
        await c.query(`ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre} CHECK (${check})`);
      }
    },
  },
  {
    // Fase 2: texto real de los PDF. Una cola/estado por documento con archivo (documento_indexacion, tabla
    // aparte para no tocar documentos: su trigger cambiaría "actualizado_en" en cada cambio de estado) y el
    // ORIGEN de cada página de texto, para no confundir texto real con el de demostración.
    // Backfill: los documentos con archivo que ya existían quedan "pendiente" y la API los procesa al arrancar.
    nombre: '003_texto_indexacion',
    async up(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS documento_indexacion (
        documento_id      bigint PRIMARY KEY REFERENCES documentos(id) ON DELETE CASCADE,
        estado            text NOT NULL DEFAULT 'pendiente',
        motivo            text NOT NULL DEFAULT 'backfill',
        solicitado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
        solicitado_en     timestamptz NOT NULL DEFAULT now(),
        intentos          smallint NOT NULL DEFAULT 0,
        iniciado_en       timestamptz,
        procesado_en      timestamptz,
        hash_sha256       char(64),
        paginas_totales   integer,
        paginas_con_texto integer,
        caracteres        integer,
        limite            text,
        error_codigo      text,
        error             text,
        duracion_ms       integer)`);
      for (const [nombre, check] of [
        ['documento_indexacion_estado_check', `estado IN ('pendiente','procesando','procesado','sin_texto','error')`],
        ['documento_indexacion_motivo_check', `motivo IN ('subida','reproceso','backfill','script')`],
        ['documento_indexacion_limite_check', `limite IS NULL OR limite IN ('paginas','caracteres','tiempo')`],
      ]) {
        await c.query(`ALTER TABLE documento_indexacion DROP CONSTRAINT IF EXISTS ${nombre}`);
        await c.query(`ALTER TABLE documento_indexacion ADD CONSTRAINT ${nombre} CHECK (${check})`);
      }
      // Índice parcial: la cola solo mira las filas por hacer, que son pocas aunque la tabla crezca.
      await c.query(`CREATE INDEX IF NOT EXISTS documento_indexacion_cola
                       ON documento_indexacion (solicitado_en, documento_id) WHERE estado IN ('pendiente','procesando')`);

      // ADD COLUMN con DEFAULT constante no reescribe la tabla (PostgreSQL 11+). Lo existente es demostración...
      await c.query(`ALTER TABLE documento_paginas ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'demo'`);
      await c.query(`ALTER TABLE documento_paginas DROP CONSTRAINT IF EXISTS documento_paginas_origen_check`);
      await c.query(`ALTER TABLE documento_paginas ADD CONSTRAINT documento_paginas_origen_check CHECK (origen IN ('demo','pdf','manual'))`);
      // ...salvo el texto que un operador escribió al aprobar un trabajo OCR (heredado): es "manual".
      await c.query(`UPDATE documento_paginas SET origen = 'manual'
                      WHERE origen = 'demo' AND documento_id IN (SELECT documento_id FROM ocr_trabajos WHERE documento_id IS NOT NULL)`);

      await c.query(`INSERT INTO documento_indexacion (documento_id, motivo)
                     SELECT id, 'backfill' FROM documentos WHERE tiene_archivo
                     ON CONFLICT (documento_id) DO NOTHING`);
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
