/**
 * Los scripts destructivos y la API se ejecutan como procesos reales para comprobar que se NIEGAN a correr
 * antes de abrir cualquier conexión. Se lanzan desde una carpeta vacía (sin .env) y con un entorno armado a
 * mano, así lo que haya en tu .env no influye. Los hosts son ficticios (.invalid nunca resuelve).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = 'dev-ejemplo.invalid';
const PROD = 'prod-ejemplo.invalid';
const url = (h) => `postgres://u:p@${h}:5432/db`;

let vacia;
before(async () => { vacia = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-sin-env-')); });
after(() => fs.rm(vacia, { recursive: true, force: true }));

function correr(script, env, args = []) {
  const r = spawnSync(process.execPath, [path.join(RAIZ, script), ...args], {
    cwd: vacia, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20_000,
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}

for (const [nombre, args] of [['db:setup', []], ['db:setup:demo', ['--seed']]]) {
  test(`${nombre} se niega con APP_ENV=production`, () => {
    const r = correr('db/setup.js', { APP_ENV: 'production', DATABASE_URL: url(DEV), DB_HOST_PERMITIDO: DEV }, args);
    assert.equal(r.codigo, 1);
    assert.match(r.salida, new RegExp(`Operación "${nombre}" bloqueada`));
    assert.match(r.salida, /APP_ENV debe ser "development"/);
  });

  test(`${nombre} se niega si DATABASE_URL apunta a otro host`, () => {
    const r = correr('db/setup.js', { APP_ENV: 'development', DATABASE_URL: url(PROD), DB_HOST_PERMITIDO: DEV }, args);
    assert.equal(r.codigo, 1);
    assert.match(r.salida, /no coincide con DB_HOST_PERMITIDO/);
  });
}

test('db:setup se niega sin APP_ENV ni DB_HOST_PERMITIDO y nombra ambas variables', () => {
  const r = correr('db/setup.js', { DATABASE_URL: url(DEV) });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /APP_ENV/);
  assert.match(r.salida, /DB_HOST_PERMITIDO no está definida/);
  assert.ok(!r.salida.includes('u:p@'), 'no debe imprimir credenciales');
});

const API_BASE = { DATABASE_URL: url(DEV), JWT_SECRET: 'x'.repeat(40), DB_HOST_PERMITIDO: DEV };

test('la API no arranca sin APP_ENV', () => {
  const r = correr('src/server.js', API_BASE);
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /La API no puede arrancar/);
  assert.match(r.salida, /APP_ENV debe ser/);
});

test('la API no arranca en producción con el driver local', () => {
  const r = correr('src/server.js', { ...API_BASE, DB_HOST_PERMITIDO: '', DATABASE_URL: url(PROD), APP_ENV: 'production', NODE_ENV: 'production', STORAGE_DRIVER: 'local' });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /solo se permite STORAGE_DRIVER=r2/);
});

test('la API no arranca en desarrollo con r2 apuntando al bucket de producción', () => {
  const r = correr('src/server.js', {
    ...API_BASE, APP_ENV: 'development', STORAGE_DRIVER: 'r2', R2_BUCKET: 'dai-documentos',
    R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secreto-ficticio',
  });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /debe terminar en "-dev"/);
  assert.ok(!r.salida.includes('secreto-ficticio'));
});

test('la API no arranca en desarrollo apuntando a una base que no es la permitida', () => {
  const r = correr('src/server.js', { ...API_BASE, APP_ENV: 'development', DATABASE_URL: url(PROD) });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /debe coincidir con DB_HOST_PERMITIDO/);
});

test('la API no arranca con MAX_UPLOAD_MB fuera de rango', () => {
  const r = correr('src/server.js', { ...API_BASE, APP_ENV: 'development', MAX_UPLOAD_MB: '500' });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /MAX_UPLOAD_MB/);
});
