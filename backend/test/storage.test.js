import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
  crearAlmacenamiento, configAlmacenamientoDesdeEnv, generarClaveObjeto, validarClave,
  ErrorObjetoNoEncontrado, ErrorRangoInvalido,
} from '../src/lib/storage.js';
import { ErrorEntorno } from '../src/lib/entorno.js';

let raiz;
let st;
before(async () => {
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-storage-'));
  st = await crearAlmacenamiento({ driver: 'local', raiz });
});
after(() => fs.rm(raiz, { recursive: true, force: true }));

test('generarClaveObjeto: formato docs/{doc}/{version}/{uuid}.pdf y siempre distinta', () => {
  const a = generarClaveObjeto(15, 7);
  assert.match(a, /^docs\/15\/7\/[0-9a-f-]{36}\.pdf$/);
  assert.notEqual(a, generarClaveObjeto(15, 7));
  assert.throws(() => generarClaveObjeto('../1', 7), TypeError);
});

test('validarClave rechaza path traversal y rutas absolutas', () => {
  for (const mala of ['../etc/passwd', '/abs', 'docs/../../x', 'docs//x', 'docs/./x', 'a\\b', '', 'docs/x y'])
    assert.throws(() => validarClave(mala), TypeError, mala);
  assert.equal(validarClave('demo/EXP-2024-LE-089/v3.2'), 'demo/EXP-2024-LE-089/v3.2'); // claves heredadas del seed
});

test('local: guardar (Buffer), existe, info y leer completo', async () => {
  const clave = generarClaveObjeto(1, 1);
  const datos = Buffer.from('%PDF-1.7 contenido de prueba');
  assert.equal(await st.existe(clave), false);
  assert.deepEqual(await st.guardar(clave, datos), { clave, tamano: datos.length });
  assert.equal(await st.existe(clave), true);
  assert.deepEqual(await st.info(clave), { tamano: datos.length });
  const r = await st.leer(clave);
  assert.equal(r.parcial, false);
  assert.equal(r.longitud, datos.length);
  assert.equal(await text(r.stream), datos.toString());
});

test('local: guardar desde stream y verificar el tamaño declarado', async () => {
  const clave = generarClaveObjeto(1, 2);
  await st.guardar(clave, Readable.from([Buffer.from('abc'), Buffer.from('def')]), { tamano: 6 });
  assert.deepEqual(await st.info(clave), { tamano: 6 });
  // Si el tamaño no cuadra, no queda ni el objeto ni el temporal.
  const otra = generarClaveObjeto(1, 3);
  await assert.rejects(st.guardar(otra, Readable.from([Buffer.from('abc')]), { tamano: 99 }), /Tamaño inesperado/);
  assert.equal(await st.existe(otra), false);
  const restos = await fs.readdir(path.join(raiz, 'docs/1/3'));
  assert.deepEqual(restos, []);
});

test('local: lectura por rangos (fin inclusivo, como HTTP Range)', async () => {
  const clave = generarClaveObjeto(2, 1);
  await st.guardar(clave, Buffer.from('0123456789'));
  const r = await st.leer(clave, { inicio: 2, fin: 5 });
  assert.deepEqual([r.inicio, r.fin, r.longitud, r.tamano, r.parcial], [2, 5, 4, 10, true]);
  assert.equal(await text(r.stream), '2345');
  // "bytes=7-" (sin fin) y fin mayor que el archivo se recortan al final
  assert.equal(await text((await st.leer(clave, { inicio: 7 })).stream), '789');
  assert.equal(await text((await st.leer(clave, { inicio: 8, fin: 500 })).stream), '89');
  await assert.rejects(st.leer(clave, { inicio: 10 }), ErrorRangoInvalido);
  await assert.rejects(st.leer(clave, { inicio: 5, fin: 2 }), ErrorRangoInvalido);
});

test('local: objeto inexistente => ErrorObjetoNoEncontrado (404), nunca un 500', async () => {
  await assert.rejects(st.leer('docs/9/9/no-existe.pdf'), (e) => e instanceof ErrorObjetoNoEncontrado && e.status === 404);
  assert.equal(await st.info('demo/EXP-2024-LE-089/v3.2'), null);
});

test('local: borrar es idempotente', async () => {
  const clave = generarClaveObjeto(3, 1);
  await st.guardar(clave, crypto.randomBytes(32));
  await st.borrar(clave);
  await st.borrar(clave);
  assert.equal(await st.existe(clave), false);
});

// ---------------------------- Configuración y reglas de buckets ----------------------------

const R2 = { R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'id-ficticio', R2_SECRET_ACCESS_KEY: 'secreto-ficticio' };

test('config: en desarrollo el driver por defecto es local', () => {
  assert.equal(configAlmacenamientoDesdeEnv({ APP_ENV: 'development' }).driver, 'local');
});

test('config: en producción solo se permite r2', () => {
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'production', STORAGE_DRIVER: 'local' }), /solo se permite STORAGE_DRIVER=r2/);
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'development', NODE_ENV: 'production', STORAGE_DRIVER: 'local' }), ErrorEntorno);
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'production' }), /STORAGE_DRIVER debe ser/);
});

test('config: r2 sin variables se niega y las nombra todas', () => {
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'development', STORAGE_DRIVER: 'r2' }), (err) => {
    assert.ok(err instanceof ErrorEntorno);
    for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) assert.match(err.message, new RegExp(k));
    return true;
  });
  // Con un bucket inválido, el mensaje nunca repite el secreto.
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'development', STORAGE_DRIVER: 'r2', R2_BUCKET: 'prod', ...R2 }),
    (err) => !err.message.includes('secreto-ficticio'));
});

test('regla de buckets: en desarrollo r2 rechaza el bucket de producción', () => {
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'development', STORAGE_DRIVER: 'r2', R2_BUCKET: 'dai-documentos', ...R2 }),
    /debe terminar en "-dev"/);
  assert.equal(configAlmacenamientoDesdeEnv({ APP_ENV: 'development', STORAGE_DRIVER: 'r2', R2_BUCKET: 'dai-documentos-dev', ...R2 }).bucket,
    'dai-documentos-dev');
});

test('regla de buckets: en producción r2 rechaza el bucket "-dev"', () => {
  assert.throws(() => configAlmacenamientoDesdeEnv({ APP_ENV: 'production', STORAGE_DRIVER: 'r2', R2_BUCKET: 'dai-documentos-dev', ...R2 }),
    /NO puede terminar en "-dev"/);
  assert.equal(configAlmacenamientoDesdeEnv({ APP_ENV: 'production', NODE_ENV: 'production', STORAGE_DRIVER: 'r2', R2_BUCKET: 'dai-documentos', ...R2 }).driver,
    'r2');
});

test('defensa en profundidad: crearAlmacenamiento también aplica la regla de buckets', async () => {
  await assert.rejects(crearAlmacenamiento({ driver: 'r2', appEnv: 'development', bucket: 'dai-documentos', accountId: 'a'.repeat(32),
    accessKeyId: 'x', secretAccessKey: 'y' }), ErrorEntorno);
  // Con un bucket válido se crea el cliente (sin tocar la red: no se envía ninguna petición).
  const r2 = await crearAlmacenamiento({ driver: 'r2', appEnv: 'development', bucket: 'dai-documentos-dev', accountId: 'a'.repeat(32),
    accessKeyId: 'x', secretAccessKey: 'y' });
  assert.equal(r2.driver, 'r2');
  await assert.rejects(r2.guardar('docs/1/1/x.pdf', Readable.from([])), /indicar \{ tamano \}/);
});
