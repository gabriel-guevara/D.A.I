// Crea el esquema (db/schema.sql) y, con --seed, los datos de demostración (db/seed.js).
// DESTRUCTIVO: borra todo el esquema public. Solo corre en desarrollo y contra el host permitido.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { exigirEntornoDesarrollo } from '../src/lib/entorno.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const conSeed = process.argv.includes('--seed');

// Antes de abrir cualquier conexión: APP_ENV=development y host de DATABASE_URL === DB_HOST_PERMITIDO.
exigirEntornoDesarrollo(conSeed ? 'db:setup:demo' : 'db:setup');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  console.log('→ Recreando el esquema public ...');
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  console.log('→ Aplicando schema.sql ...');
  await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (conSeed) {
    console.log('→ Cargando datos de demostración ...');
    const { seed } = await import('./seed.js');
    await seed(client);
  }
  console.log('✔ Base de datos lista.');
} catch (err) {
  console.error('✖ Error:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
