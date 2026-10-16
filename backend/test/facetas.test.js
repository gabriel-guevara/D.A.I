/**
 * GET /api/busqueda/facetas: "terminosFrecuentes" sale SOLO de las búsquedas del propio usuario.
 * Antes agregaba las de todos, y un read-only de nivel 2 veía lo que un super-admin buscaba (fuga de información).
 * La app REAL por HTTP contra un esquema temporal, igual que texto-busqueda.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearBaseDePrueba } from './helpers/base-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';

let base, servidor, url, db;
const tokens = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  const migrate = await import('../src/migrate.js');
  await migrate.aplicarMigraciones(base.pool, { log: () => {} });

  const { firmarToken } = await import('../src/middleware/auth.js');
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'],
    ['lector2', 'read-only', 'Nivel 2 Confidencial'],
  ]) {
    const { rows: [u] } = await base.pool.query(
      `INSERT INTO usuarios (nombre, email, rol_id, nivel_id)
       VALUES ($1, $2, (SELECT id FROM roles WHERE clave = $3), (SELECT id FROM niveles_acceso WHERE nombre = $4)) RETURNING id`,
      [`Usuario ${clave}`, `${clave}@prueba.test`, rol, nivel]);
    tokens[clave] = firmarToken({ sub: String(u.id) }, 'access', '1h');
  }
  const { crearApp } = await import('../src/app.js');
  servidor = crearApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  url = `http://127.0.0.1:${servidor.address().port}/api`;
});

after(async () => {
  await new Promise((r) => servidor?.close(r));
  await db?.pool.end();
  await base?.cerrar();
});

const get = async (ruta, quien) => {
  const r = await fetch(`${url}${ruta}`, { headers: { Authorization: `Bearer ${tokens[quien]}` } });
  const cuerpo = await r.json().catch(() => null);
  assert.equal(r.status, 200, JSON.stringify(cuerpo));
  return cuerpo;
};
const buscar = (q, quien) => get(`/busqueda?q=${encodeURIComponent(q)}&algoritmo=exacta`, quien);
const frecuentes = async (quien) => (await get('/busqueda/facetas', quien)).terminosFrecuentes;

test('los términos frecuentes de un usuario no aparecen en las facetas de otro', async () => {
  // El super-admin busca varias veces un nombre en clave (más búsquedas que nadie: encabezaría el ranking global).
  for (let i = 0; i < 3; i++) await buscar('operación cóndor', 'admin');
  await buscar('presupuesto anual', 'lector2');

  const delAdmin = await frecuentes('admin');
  const delLector = await frecuentes('lector2');

  assert.ok(delAdmin.includes('operación cóndor'), 'el admin ve sus propios términos');
  assert.ok(!delAdmin.includes('presupuesto anual'), 'el admin no ve los términos del lector');
  assert.deepEqual(delLector, ['presupuesto anual'], 'el lector solo ve los suyos, nunca el nombre en clave');
});

test('sin búsquedas propias, la lista de términos frecuentes llega vacía', async () => {
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, rol_id, nivel_id)
     VALUES ('Usuario nuevo', 'nuevo@prueba.test', (SELECT id FROM roles WHERE clave = 'read-only'),
             (SELECT id FROM niveles_acceso WHERE nombre = 'Nivel 2 Confidencial')) RETURNING id`);
  const { firmarToken } = await import('../src/middleware/auth.js');
  tokens.nuevo = firmarToken({ sub: String(u.id) }, 'access', '1h');

  assert.deepEqual(await frecuentes('nuevo'), []);
});
