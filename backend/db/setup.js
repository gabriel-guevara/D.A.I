// Crea el esquema (db/schema.sql) y, con --seed, los datos de demostración (db/seed.js).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV === 'production') {
  console.error('Por seguridad, db:setup no corre con NODE_ENV=production (borra todo el esquema).');
  process.exit(1);
}

await client.connect();
try {
  console.log('→ Aplicando schema.sql ...');
  await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (process.argv.includes('--seed')) {
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
