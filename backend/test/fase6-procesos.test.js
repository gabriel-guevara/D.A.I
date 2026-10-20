/**
 * Fase 6 con un PROCESO real: `node src/server.js` (como en Render) contra un esquema temporal "como producción tras la
 * Fase 5" (una carpeta de un nivel con un documento). Al arrancar aplica la migración 007; después, login real con TOTP,
 * subcarpetas, subida, mover a una subcarpeta, explorador, biblioteca con la ruta, mover carpeta y eliminar por HTTP.
 * El driver local usa su carpeta por defecto (backend/.storage, ignorada por git) con ids propios que se limpian al final.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { crearPdf } from './helpers/pdf-prueba.js';
import { codigoPara } from '../src/lib/totp.js';
import { cifrarSecreto } from '../src/lib/cifrado-mfa.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = path.join(RAIZ, '.storage');
const SECRETO = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const INICIO_IDS = 800_000_000 + crypto.randomInt(99_999_999); // ids de documento propios: no chocan con datos locales
let vacia, base, subido;

before(async () => {
  vacia = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase6-'));
  base = await crearBaseDePrueba();
});
after(async () => {
  await fs.rm(vacia, { recursive: true, force: true });
  if (subido) await fs.rm(path.join(STORAGE, 'docs', subido), { recursive: true, force: true });
  await base?.cerrar();
});

function urlEsquema() {
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set('options', `-c search_path=${base.esquema},public`);
  return u.toString();
}

test('humo: node src/server.js real — migración 007, subcarpetas, mover y biblioteca con la ruta por HTTP', { timeout: 120_000 }, async () => {
  // Base "como producción tras la Fase 5": sin padre_id, nombre único global y 007 sin registrar; una carpeta con un documento.
  await base.pool.query(`DROP INDEX ${base.esquema}.carpetas_nombre_padre_uq`);
  await base.pool.query(`ALTER TABLE ${base.esquema}.carpetas DROP CONSTRAINT carpetas_padre_check, DROP COLUMN padre_id`);
  await base.pool.query(`CREATE UNIQUE INDEX carpetas_nombre_uq ON ${base.esquema}.carpetas (lower(nombre))`);
  await (await import('../src/migrate.js')).aplicarMigraciones(base.pool, {
    migraciones: (await import('../src/migrate.js')).MIGRACIONES.filter((m) => m.nombre !== '007_subcarpetas'), log: () => {},
  });
  const { rows: [f5] } = await base.pool.query(`INSERT INTO carpetas (nombre) VALUES ('Legal F5') RETURNING id`);
  await base.pool.query(`SELECT setval(pg_get_serial_sequence('documentos', 'id'), $1)`, [INICIO_IDS]);
  const { rows: [antiguo] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, carpeta_id)
     VALUES ('Antiguo.pdf', 'EXP-F6-HUMO', 'pdf', (SELECT id FROM clasificaciones WHERE nombre = 'Uso Interno General'), 'X', $1) RETURNING id`, [f5.id]);
  const password = 'Humo-Fase6-2026';
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id)
     VALUES ('Humo 6', 'humo6@prueba.test', $1, (SELECT id FROM roles WHERE clave = 'super-admin'),
             (SELECT id FROM niveles_acceso ORDER BY rango DESC LIMIT 1)) RETURNING id`, [bcrypt.hashSync(password, 4)]);
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2, mfa_activado_en = now() WHERE id = $1`, [u.id, cifrarSecreto(SECRETO, u.id)]);

  const puerto = 44_000 + crypto.randomInt(5_000);
  const hijo = spawn(process.execPath, [path.join(RAIZ, 'src/server.js')], {
    cwd: vacia,
    env: {
      PATH: process.env.PATH, APP_ENV: 'development', DB_HOST_PERMITIDO: new URL(process.env.DATABASE_URL).hostname,
      DATABASE_URL: urlEsquema(), JWT_SECRET: 'j'.repeat(48), STORAGE_DRIVER: 'local', MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
      PORT: String(puerto), MAX_UPLOAD_MB: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  hijo.stderr.on('data', (d) => { salida += d; });
  try {
    await new Promise((ok, mal) => {
      const t = setTimeout(() => mal(new Error(`la API no arrancó:\n${salida}`)), 30_000);
      hijo.stdout.on('data', () => { if (salida.includes('escuchando')) { clearTimeout(t); ok(); } });
      hijo.once('exit', (c) => { clearTimeout(t); mal(new Error(`la API terminó (${c}):\n${salida}`)); });
    });
    assert.match(salida, /Migración aplicada: 007_subcarpetas/);
    assert.doesNotMatch(salida, /Migración aplicada: 00[1-6]/, 'solo la nueva');

    const api = `http://127.0.0.1:${puerto}/api`;
    const enviar = (metodo, ruta, { token, cuerpo, form } = {}) => fetch(`${api}${ruta}`, {
      method: metodo,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
      body: form ?? (cuerpo ? JSON.stringify(cuerpo) : undefined),
    }).then(async (r) => ({ status: r.status, cuerpo: await r.json().catch(() => null) }));

    const l = await enviar('POST', '/auth/login', { cuerpo: { username: 'humo6@prueba.test', password } });
    const v = await enviar('POST', '/auth/verify-2fa', { cuerpo: { mfaToken: l.cuerpo.mfaToken, code: codigoPara(SECRETO, Date.now() - 30_000) } });
    assert.equal(v.status, 200, JSON.stringify(v.cuerpo));
    const token = v.cuerpo.token;

    // La carpeta de la Fase 5 aparece en la raíz con su documento.
    const raiz = await enviar('GET', '/carpetas', { token });
    assert.deepEqual(raiz.cuerpo.carpetas, [{ id: String(f5.id), nombre: 'Legal F5', documentos: 1, subcarpetas: 0 }]);

    const sub = await enviar('POST', '/carpetas', { token, cuerpo: { nombre: '2026', padreId: String(f5.id) } });
    assert.equal(sub.status, 201, JSON.stringify(sub.cuerpo));
    const f = new FormData();
    f.append('clasificacion', 'Uso Interno General');
    f.append('archivo', new Blob([crearPdf({ textos: ['Humo fase seis'] })], { type: 'application/pdf' }), 'HumoF6.pdf');
    const doc = await enviar('POST', '/digitalizacion/documentos', { token, form: f });
    assert.equal(doc.status, 201, JSON.stringify(doc.cuerpo));
    subido = doc.cuerpo.id;

    assert.deepEqual((await enviar('POST', '/carpetas/mover', { token, cuerpo: { ids: [subido], carpetaId: sub.cuerpo.id } })).cuerpo,
      { movidos: 1, sinCambios: 0, omitidos: [] });
    const lista = await enviar('GET', `/documentos?carpeta=${sub.cuerpo.id}`, { token });
    assert.deepEqual([lista.cuerpo.total, lista.cuerpo.documentos[0].id, lista.cuerpo.documentos[0].carpeta.ruta.map((x) => x.nombre)],
      [1, subido, ['Legal F5', '2026']]);
    const dentro = await enviar('GET', `/carpetas?padre=${f5.id}`, { token });
    assert.deepEqual([dentro.cuerpo.documentosAqui, dentro.cuerpo.carpetas[0].documentos], [1, 1]);
    const todo = await enviar('GET', `/documentos?carpeta=${f5.id}&subcarpetas=1&orden=nombre`, { token });
    assert.deepEqual(todo.cuerpo.documentos.map((x) => x.id), [String(antiguo.id), subido]);

    assert.equal((await enviar('DELETE', `/carpetas/${f5.id}`, { token })).cuerpo.codigo, 'subcarpetas');
    const movida = await enviar('PATCH', `/carpetas/${sub.cuerpo.id}`, { token, cuerpo: { padreId: null } });
    assert.deepEqual([movida.status, movida.cuerpo.padreId], [200, null]);
    assert.equal((await enviar('GET', `/carpetas/${sub.cuerpo.id}/ruta`, { token })).cuerpo.ruta.length, 1);

    await enviar('POST', '/carpetas/mover', { token, cuerpo: { ids: [subido], carpetaId: null } });
    assert.equal((await enviar('DELETE', `/carpetas/${sub.cuerpo.id}`, { token })).status, 204);
  } finally {
    hijo.kill('SIGTERM');
  }
});
