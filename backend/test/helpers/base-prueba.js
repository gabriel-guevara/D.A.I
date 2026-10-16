/**
 * Base de datos para pruebas: un ESQUEMA TEMPORAL propio (dai_test_<marca>_<aleatorio>) dentro de la base
 * de DATABASE_URL. Nunca toca las tablas del esquema public (tus datos de la rama dev) y se borra al terminar.
 *
 * Antes de conectar exige el mismo entorno que las operaciones destructivas:
 * APP_ENV=development y host de DATABASE_URL === DB_HOST_PERMITIDO.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verificarEntornoDestructivo } from '../../src/lib/entorno.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREFIJO = 'dai_test_';
const UNA_HORA_MS = 60 * 60 * 1000;

/**
 * Neon: el host "-pooler" pasa por PgBouncer en modo transacción, donde un SET search_path no se conserva
 * entre consultas. Para las pruebas se usa el host directo de la MISMA rama (solo cambia el sufijo).
 */
function urlDirecta(url) {
  const u = new URL(url);
  const [primero, ...resto] = u.hostname.split('.');
  u.hostname = [primero.replace(/-pooler$/, ''), ...resto].join('.');
  return u.toString();
}

/** Crea el esquema temporal y un pool cuyo search_path apunta a él. */
export async function crearBaseDePrueba({ conSchemaSql = true } = {}) {
  verificarEntornoDestructivo('npm test');
  const url = urlDirecta(process.env.DATABASE_URL);
  const esquema = `${PREFIJO}${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await limpiarEsquemasHuerfanos(admin);
    await admin.query(`CREATE SCHEMA ${esquema}`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: url, max: 3 });
  // "public" queda detrás solo para encontrar extensiones ya instaladas (pg_trgm); lo nuevo se crea en el temporal.
  pool.on('connect', (c) => c.query(`SET search_path TO ${esquema}, public`));

  if (conSchemaSql) await pool.query(fs.readFileSync(path.join(RAIZ, 'db/schema.sql'), 'utf8'));

  return {
    pool,
    esquema,
    async cerrar() {
      await pool.end();
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(`DROP SCHEMA IF EXISTS ${esquema} CASCADE`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Borra esquemas de pruebas que quedaron de una ejecución interrumpida (solo dai_test_* de más de 1 hora). */
async function limpiarEsquemasHuerfanos(c) {
  const { rows } = await c.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`${PREFIJO}%`]);
  for (const { nspname } of rows) {
    const marca = Number(nspname.slice(PREFIJO.length).split('_')[0]);
    if (/^dai_test_\d+_[0-9a-f]{8}$/.test(nspname) && Date.now() - marca > UNA_HORA_MS)
      await c.query(`DROP SCHEMA IF EXISTS ${nspname} CASCADE`);
  }
}
