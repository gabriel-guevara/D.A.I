/**
 * Fase 5 con un PROCESO real: `node src/server.js` (como en Render) contra un esquema temporal. Al arrancar aplica
 * la migración 006; después, login real con TOTP, carpetas, subida, mover, biblioteca filtrada y dashboard por HTTP.
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
  vacia = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase5-'));
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

test('humo: node src/server.js real — migración 006, carpetas, mover, biblioteca y dashboard por HTTP', { timeout: 120_000 }, async () => {
  // Base "como producción antes de la Fase 5": sin las tablas de carpetas y sin 006 registrada.
  await base.pool.query(`DROP TABLE solicitudes_movimiento`);
  await base.pool.query(`ALTER TABLE documentos DROP COLUMN carpeta_id`);
  await base.pool.query(`DROP TABLE carpetas`);
  await (await import('../src/migrate.js')).aplicarMigraciones(base.pool, {
    migraciones: (await import('../src/migrate.js')).MIGRACIONES.filter((m) => m.nombre !== '006_carpetas'), log: () => {},
  });
  const password = 'Humo-Fase5-2026';
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id)
     VALUES ('Humo 5', 'humo5@prueba.test', $1, (SELECT id FROM roles WHERE clave = 'super-admin'),
             (SELECT id FROM niveles_acceso ORDER BY rango DESC LIMIT 1)) RETURNING id`, [bcrypt.hashSync(password, 4)]);
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2, mfa_activado_en = now() WHERE id = $1`, [u.id, cifrarSecreto(SECRETO, u.id)]);
  await base.pool.query(`SELECT setval(pg_get_serial_sequence('documentos', 'id'), $1)`, [INICIO_IDS]);

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
    assert.match(salida, /Migración aplicada: 006_carpetas/);

    const api = `http://127.0.0.1:${puerto}/api`;
    const enviar = (metodo, ruta, { token, cuerpo, form } = {}) => fetch(`${api}${ruta}`, {
      method: metodo,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
      body: form ?? (cuerpo ? JSON.stringify(cuerpo) : undefined),
    }).then(async (r) => ({ status: r.status, cuerpo: await r.json().catch(() => null) }));

    const l = await enviar('POST', '/auth/login', { cuerpo: { username: 'humo5@prueba.test', password } });
    const v = await enviar('POST', '/auth/verify-2fa', { cuerpo: { mfaToken: l.cuerpo.mfaToken, code: codigoPara(SECRETO, Date.now() - 30_000) } });
    assert.equal(v.status, 200, JSON.stringify(v.cuerpo));
    const token = v.cuerpo.token;

    const carpeta = await enviar('POST', '/carpetas', { token, cuerpo: { nombre: 'Humo F5' } });
    assert.equal(carpeta.status, 201, JSON.stringify(carpeta.cuerpo));
    const f = new FormData();
    f.append('clasificacion', 'Uso Interno General');
    f.append('archivo', new Blob([crearPdf({ textos: ['Humo fase cinco'] })], { type: 'application/pdf' }), 'HumoF5.pdf');
    const doc = await enviar('POST', '/digitalizacion/documentos', { token, form: f });
    assert.equal(doc.status, 201, JSON.stringify(doc.cuerpo));
    subido = doc.cuerpo.id;
    assert.ok(Number(subido) > INICIO_IDS);

    const mover = await enviar('POST', '/carpetas/mover', { token, cuerpo: { ids: [subido], carpetaId: carpeta.cuerpo.id } });
    assert.deepEqual(mover.cuerpo, { movidos: 1, sinCambios: 0, omitidos: [] });
    const lista = await enviar('GET', `/documentos?carpeta=${carpeta.cuerpo.id}&orden=nombre&porPagina=25&pagina=1`, { token });
    assert.equal(lista.status, 200);
    assert.deepEqual([lista.cuerpo.total, lista.cuerpo.documentos[0].id, lista.cuerpo.documentos[0].tieneArchivo, lista.cuerpo.documentos[0].nombreOriginal],
      [1, subido, true, 'HumoF5.pdf']);
    assert.equal((await enviar('DELETE', `/carpetas/${carpeta.cuerpo.id}`, { token })).status, 409, 'no está vacía');

    const dash = await enviar('GET', '/dashboard', { token });
    assert.deepEqual([dash.cuerpo.documentos.visibles, dash.cuerpo.documentos.conArchivo, dash.cuerpo.almacenamiento.objetos], [1, 1, 1]);
    assert.match(dash.cuerpo.almacenamiento.cifrado, /sin cifrar/);

    await enviar('POST', '/carpetas/mover', { token, cuerpo: { ids: [subido], carpetaId: null } });
    assert.equal((await enviar('DELETE', `/carpetas/${carpeta.cuerpo.id}`, { token })).status, 204);
  } finally {
    hijo.kill('SIGTERM');
  }
});
