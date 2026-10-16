/**
 * Dashboard real (Fase 5) con datos CONTROLADOS en un esquema temporal propio: las cifras deben ser exactas.
 * Archivos reales (driver local en una carpeta temporal) para "con archivo" y para el almacenamiento.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { crearPdf } from './helpers/pdf-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.STORAGE_DRIVER = 'local';

let base, servidor, url, db, raiz, ix, pap;
const tokens = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  await (await import('../src/migrate.js')).aplicarMigraciones(base.pool, { log: () => {} });
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-dashboard-'));
  await (await import('../src/lib/storage.js')).inicializarAlmacenamiento({ driver: 'local', raiz });
  ix = await import('../src/lib/indexador.js');
  pap = await import('../src/lib/papelera.js');
  const { firmarToken } = await import('../src/middleware/auth.js');
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'], ['cumplimiento', 'compliance', 'Nivel 3 Alto'],
    ['operador', 'ocr-operator', 'Nivel 2 Auditoría'], ['lector2', 'read-only', 'Nivel 2 Confidencial'],
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
  await ix?.detenerIndexador();
  await pap?.detenerMantenimiento();
  await new Promise((r) => servidor?.close(r));
  await db?.pool.end();
  await base?.cerrar();
  await fs.rm(raiz, { recursive: true, force: true });
});

const auth = (quien) => ({ Authorization: `Bearer ${tokens[quien]}` });
const dashboard = async (quien) => {
  const r = await fetch(`${url}/dashboard`, { headers: auth(quien) });
  return { status: r.status, cuerpo: await r.json() };
};
async function subir(nombre, campos = {}) {
  const f = new FormData();
  f.append('clasificacion', 'Uso Interno General');
  for (const [k, v] of Object.entries(campos)) f.append(k, v);
  f.append('archivo', new Blob([crearPdf({ textos: [nombre], relleno: 4096 })], { type: 'application/pdf' }), nombre);
  const r = await fetch(`${url}/digitalizacion/documentos`, { method: 'POST', headers: auth('admin'), body: f });
  const cuerpo = await r.json();
  assert.equal(r.status, 201, JSON.stringify(cuerpo));
  return cuerpo;
}

test('dashboard: cifras exactas por nivel y almacenamiento real solo para Admin y Cumplimiento', async () => {
  // d1: con archivo, Legal, alta de este mes, con una segunda versión (2 objetos).
  const d1 = await subir('Uno.pdf', { departamento: 'Legal' });
  const f = new FormData();
  f.append('comentario', 'Segunda versión');
  f.append('archivo', new Blob([crearPdf({ textos: ['Uno v2'], relleno: 8192 })], { type: 'application/pdf' }), 'Uno.pdf');
  assert.equal((await fetch(`${url}/documentos/${d1.id}/versiones`, { method: 'POST', headers: auth('admin'), body: f })).status, 201);
  // d5: con archivo y en la papelera (ocupa espacio, no cuenta como visible).
  const d5 = await subir('Cinco.pdf');
  assert.equal((await fetch(`${url}/documentos/${d5.id}`, { method: 'DELETE', headers: auth('admin') })).status, 204);
  // Sin archivo: d2 Secreto (este mes, vencido), d3 Confidencial (hace 70 días, vencido), d4 Uso interno (no vence aún).
  const hoyCO = `(now() AT TIME ZONE 'America/Bogota')::date`;
  await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, departamento_id, autor_nombre, creado_en, fecha_limite) VALUES
     ('Dos.pdf', 'EXP-D-2', 'pdf', (SELECT id FROM clasificaciones WHERE nombre = 'Secreto Corporativo'), (SELECT id FROM departamentos WHERE nombre = 'Legal'), 'X', now(), ${hoyCO} - 1),
     ('Tres.xlsx', 'EXP-D-3', 'xlsx', (SELECT id FROM clasificaciones WHERE nombre = 'Confidencial Nivel 2'), (SELECT id FROM departamentos WHERE nombre = 'Finanzas'), 'X', now() - interval '70 days', ${hoyCO} - 1),
     ('Cuatro.docx', 'EXP-D-4', 'docx', (SELECT id FROM clasificaciones WHERE nombre = 'Uso Interno General'), NULL, 'X', now() - interval '70 days', ${hoyCO} + 1)`);

  const a = await dashboard('admin');
  assert.equal(a.status, 200);
  assert.deepEqual(a.cuerpo.documentos, { visibles: 4, altasMes: 2, conArchivo: 1, sinArchivo: 3, fueraDePlazo: 2 });
  assert.deepEqual(a.cuerpo.porDepartamento.map((x) => [x.nombre, x.total]), [['Legal', 2], ['Finanzas', 1], ['Sin departamento', 1]]);
  assert.deepEqual(a.cuerpo.porFormato.map((x) => [x.formato, x.total]), [['pdf', 2], ['docx', 1], ['xlsx', 1]]);
  assert.equal(a.cuerpo.recientes.length, 4);
  assert.ok(!a.cuerpo.recientes.some((x) => x.id === d5.id), 'lo de la papelera no aparece');

  // Almacenamiento: SOLO objetos que existen (v1 y v2 de d1 + v1 de d5), con los bytes reales de cada versión.
  const { rows: [esperado] } = await base.pool.query(
    `SELECT sum(tamano_bytes)::bigint AS bytes, count(*)::int AS n,
            sum(tamano_bytes) FILTER (WHERE documento_id = $1)::bigint AS papelera
       FROM documento_versiones WHERE storage_path IS NOT NULL`, [d5.id]);
  const objetosEnDisco = (await fs.readdir(raiz, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const bytesEnDisco = (await Promise.all(objetosEnDisco.map((e) => fs.stat(path.join(e.parentPath ?? e.path, e.name))))).reduce((s, x) => s + x.size, 0);
  const s = a.cuerpo.almacenamiento;
  assert.equal(esperado.n, 3);
  assert.deepEqual([s.objetos, s.bytes], [objetosEnDisco.length, bytesEnDisco], 'coincide con lo que hay de verdad en el disco');
  assert.equal(s.bytes, Number(esperado.bytes));
  assert.deepEqual([s.papelera.documentos, s.papelera.bytes], [1, Number(esperado.papelera)]);
  assert.deepEqual([s.cuotaBytes, s.cuota], [5497558138880, '5 TB']);
  assert.equal(s.driver, 'local');
  assert.equal(s.cifradoEnReposo, false);
  assert.match(s.cifrado, /sin cifrar/);
  assert.ok(!JSON.stringify(a.cuerpo).includes('Encriptado'), 'nada de "Almacenamiento Encriptado"');

  // Nivel 2: no ve el Secreto (ni en los totales) y no recibe el almacenamiento.
  const l = await dashboard('lector2');
  assert.deepEqual(l.cuerpo.documentos, { visibles: 3, altasMes: 1, conArchivo: 1, sinArchivo: 2, fueraDePlazo: 1 });
  assert.deepEqual(l.cuerpo.porDepartamento.map((x) => [x.nombre, x.total]), [['Finanzas', 1], ['Legal', 1], ['Sin departamento', 1]]);
  assert.ok(!l.cuerpo.recientes.some((x) => x.name === 'Dos.pdf'));
  assert.equal(l.cuerpo.almacenamiento, null);
  assert.equal((await dashboard('operador')).cuerpo.almacenamiento, null);
  const c = await dashboard('cumplimiento');
  assert.equal(c.cuerpo.almacenamiento.objetos, 3, 'Cumplimiento sí ve el almacenamiento');
  assert.equal(c.cuerpo.documentos.visibles, 3, 'pero sus documentos siguen siendo los de su nivel (3: sin el Secreto)');
});

test('dashboard: texto del cifrado honesto según el driver', async () => {
  const { textoCifrado } = await import('../src/routes/dashboard.js');
  assert.match(textoCifrado('r2'), /Cloudflare R2 cifra en reposo/);
  assert.match(textoCifrado('local'), /sin cifrar/);
});
