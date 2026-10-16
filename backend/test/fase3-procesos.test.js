/**
 * Fase 3 con PROCESOS reales:
 *  - la API se niega a arrancar sin MFA_ENCRYPTION_KEY válida (sin mostrar el valor);
 *  - el script de emergencia admin:reset-2fa y sus candados;
 *  - prueba de humo: `node src/server.js` de verdad, login completo con un TOTP calculado aquí.
 *
 * Los procesos que deben FALLAR antes de conectar usan hosts ficticios (.invalid nunca resuelve) y una carpeta
 * sin .env. Los que conectan usan un esquema temporal (search_path en la cadena de conexión), nunca public.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { codigoPara } from '../src/lib/totp.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = 'dev-ejemplo.invalid';
const PROD = 'prod-ejemplo.invalid';
const url = (h) => `postgres://u:p@${h}:5432/db`;
const CLAVE = crypto.randomBytes(32).toString('base64');

let vacia, base;
before(async () => {
  vacia = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase3-'));
  base = await crearBaseDePrueba();
});
after(async () => {
  await fs.rm(vacia, { recursive: true, force: true });
  await base?.cerrar();
});

function correr(script, env, { args = [], input, cwd = vacia } = {}) {
  const r = spawnSync(process.execPath, [path.join(RAIZ, script), ...args], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20_000, input,
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}

/** Cadena de conexión real que deja al proceso hijo dentro del esquema temporal. */
function urlEsquema() {
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set('options', `-c search_path=${base.esquema},public`);
  return u.toString();
}
const ENV_DEV = () => ({
  APP_ENV: 'development', DB_HOST_PERMITIDO: new URL(process.env.DATABASE_URL).hostname, DATABASE_URL: urlEsquema(),
  JWT_SECRET: 'j'.repeat(48), STORAGE_DRIVER: 'local', MFA_ENCRYPTION_KEY: CLAVE,
});

// ---------------------------------------------------------------------------------------------- arranque
const API_BASE = { APP_ENV: 'development', DATABASE_URL: url(DEV), DB_HOST_PERMITIDO: DEV, JWT_SECRET: 'x'.repeat(40) };

test('la API no arranca sin MFA_ENCRYPTION_KEY (desarrollo ni producción)', () => {
  for (const env of [API_BASE, { ...API_BASE, DB_HOST_PERMITIDO: '', DATABASE_URL: url(PROD), APP_ENV: 'production', NODE_ENV: 'production' }]) {
    const r = correr('src/server.js', env);
    assert.equal(r.codigo, 1);
    assert.match(r.salida, /Falta MFA_ENCRYPTION_KEY/);
  }
});

test('la API no arranca con una MFA_ENCRYPTION_KEY mal formada y no la imprime', () => {
  const mala = crypto.randomBytes(24).toString('base64');
  const r = correr('src/server.js', { ...API_BASE, MFA_ENCRYPTION_KEY: mala });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /MFA_ENCRYPTION_KEY debe ser 32 bytes en base64/);
  assert.ok(!r.salida.includes(mala));
});

test('MFA_DEV_CODE ya no existe: si sigue en el entorno solo se avisa', () => {
  const r = correr('src/server.js', { ...API_BASE, MFA_ENCRYPTION_KEY: CLAVE, MFA_DEV_CODE: '123456', DATABASE_URL: url(PROD) });
  assert.equal(r.codigo, 1); // falla por otra razón (host), pero el aviso aparece
  assert.match(r.salida, /MFA_DEV_CODE ya no se usa/);
});

// ---------------------------------------------------------------------------------------------- script de emergencia
test('admin:reset-2fa exige un correo', () => {
  const r = correr('scripts/admin-reset-2fa.js', API_BASE);
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /Uso: npm run admin:reset-2fa/);
});

test('admin:reset-2fa sin --produccion se niega fuera de desarrollo', () => {
  const r = correr('scripts/admin-reset-2fa.js', { APP_ENV: 'production', DATABASE_URL: url(PROD), DB_HOST_PERMITIDO: DEV }, { args: ['a@b.co'] });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /Operación "admin:reset-2fa" bloqueada/);
});

test('admin:reset-2fa --produccion: la cadena solo vale desde el comando y hay que escribir el host exacto', async () => {
  let r = correr('scripts/admin-reset-2fa.js', {}, { args: ['a@b.co', '--produccion'] });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /debes pasar DAI_PROD_DATABASE_URL/);

  const conEnv = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase3-env-'));
  try {
    await fs.writeFile(path.join(conEnv, '.env'), `DAI_PROD_DATABASE_URL=${url(PROD)}\n`);
    r = correr('scripts/admin-reset-2fa.js', { DAI_PROD_DATABASE_URL: url(PROD) }, { args: ['a@b.co', '--produccion'], cwd: conEnv });
    assert.equal(r.codigo, 1);
    assert.match(r.salida, /no puede venir del archivo .env/);
  } finally {
    await fs.rm(conEnv, { recursive: true, force: true });
  }

  r = correr('scripts/admin-reset-2fa.js', { DAI_PROD_DATABASE_URL: url(PROD) }, { args: ['a@b.co', '--produccion'], input: 'ep-otro-host\n' });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /El host no coincide. No se hizo ningún cambio/);
  assert.ok(!r.salida.includes('u:p@'), 'no imprime credenciales');
});

test('admin:reset-2fa en desarrollo: quita el 2FA, cierra sesiones y lo audita', async () => {
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, rol_id, nivel_id, mfa_secreto, sesion_version)
     VALUES ('Admin', 'admin-script@prueba.test', 1, 1, 'v1:a:b:c', 3) RETURNING id`);
  await base.pool.query(`INSERT INTO mfa_codigos_recuperacion (usuario_id, huella) VALUES ($1, $2)`, [u.id, 'f'.repeat(64)]);

  const r = correr('scripts/admin-reset-2fa.js', ENV_DEV(), { args: ['ADMIN-script@prueba.test'] });
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /2FA restablecido para admin-script@prueba.test/);
  const { rows: [f] } = await base.pool.query(`SELECT mfa_secreto, sesion_version FROM usuarios WHERE id = $1`, [u.id]);
  assert.deepEqual(f, { mfa_secreto: null, sesion_version: 4 });
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM mfa_codigos_recuperacion WHERE usuario_id = $1`, [u.id])).rows[0].n, 0);
  const { rows: [a] } = await base.pool.query(`SELECT usuario_id, ip, detalle FROM auditoria WHERE accion = 'restablecer_2fa'`);
  assert.equal(a.ip, 'script');
  assert.equal(a.detalle.via, 'script_emergencia');
  assert.equal(a.detalle.usuarioId, String(u.id));

  const nadie = correr('scripts/admin-reset-2fa.js', ENV_DEV(), { args: ['nadie@prueba.test'] });
  assert.equal(nadie.codigo, 1);
  assert.match(nadie.salida, /No existe una cuenta/);
});

// ---------------------------------------------------------------------------------------------- prueba de humo
test('humo: node src/server.js real — alta de 2FA obligatoria y luego login con TOTP', { timeout: 90_000 }, async () => {
  const puerto = 39_000 + crypto.randomInt(5_000);
  const hijo = spawn(process.execPath, [path.join(RAIZ, 'src/server.js')], {
    cwd: vacia, env: { PATH: process.env.PATH, ...ENV_DEV(), PORT: String(puerto), MAX_UPLOAD_MB: '5' }, stdio: ['ignore', 'pipe', 'pipe'],
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
    const api = `http://127.0.0.1:${puerto}/api`;
    const post = async (ruta, cuerpo) => {
      const r = await fetch(`${api}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) });
      return { status: r.status, cuerpo: await r.json() };
    };
    const password = 'Humo-Prueba-2026';
    await base.pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id)
       VALUES ('Humo', 'humo@prueba.test', $1, (SELECT id FROM roles WHERE clave = 'super-admin'), (SELECT id FROM niveles_acceso ORDER BY rango DESC LIMIT 1))`,
      [bcrypt.hashSync(password, 4)]);

    assert.equal((await fetch(`${api}/health`)).status, 200);
    const l1 = await post('/auth/login', { username: 'humo@prueba.test', password });
    assert.equal(l1.cuerpo.paso, 'enrolar');
    const ini = await post('/auth/2fa/enrolar/iniciar', { enrolToken: l1.cuerpo.enrolToken });
    const resto = Date.now() % 30_000; // lejos del cambio de paso de 30 s, para que la prueba no sea intermitente
    if (resto > 25_000) await new Promise((r) => setTimeout(r, 30_000 - resto + 250));
    const ahora = Date.now();
    const conf = await post('/auth/2fa/enrolar/confirmar', { enrolToken: l1.cuerpo.enrolToken, code: codigoPara(ini.cuerpo.secreto, ahora - 30_000) });
    assert.equal(conf.status, 200, JSON.stringify(conf.cuerpo));
    assert.equal(conf.cuerpo.codigosRecuperacion.length, 10);

    const l2 = await post('/auth/login', { username: 'humo@prueba.test', password });
    assert.equal(l2.cuerpo.paso, '2fa');
    const v = await post('/auth/verify-2fa', { mfaToken: l2.cuerpo.mfaToken, code: codigoPara(ini.cuerpo.secreto, Date.now() + 30_000) });
    assert.equal(v.status, 200, JSON.stringify(v.cuerpo));
    const me = await fetch(`${api}/cuenta/seguridad`, { headers: { authorization: `Bearer ${v.cuerpo.token}` } });
    const seg = await me.json();
    assert.equal(seg.mfaActivo, true);
    assert.equal(seg.codigosRestantes, 10);
    assert.match(salida, /Migración aplicada: 004_mfa_totp_real/);
  } finally {
    hijo.kill('SIGTERM');
  }
});
