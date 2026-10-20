/**
 * Script de emergencia admin:reset-password como PROCESO real: candados de entorno (igual que admin:reset-2fa),
 * contraseña escrita dos veces y validada, hash bcrypt, sesiones cerradas, bloqueos quitados y auditoría sin la
 * contraseña. Los procesos que deben fallar antes de conectar usan hosts ficticios (.invalid); los que conectan,
 * un esquema temporal (search_path en la cadena de conexión), nunca public.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { clave2fa, claveContrasena } from '../src/lib/intentos-claves.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/admin-reset-password.js';
const DEV = 'dev-ejemplo.invalid';
const PROD = 'prod-ejemplo.invalid';
const url = (h) => `postgres://u:p@${h}:5432/db`;
const NUEVA = 'Recuperada-Segura-2026';

let vacia, base;
before(async () => {
  vacia = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-reset-pw-'));
  base = await crearBaseDePrueba();
});
after(async () => {
  await fs.rm(vacia, { recursive: true, force: true });
  await base?.cerrar();
});

function correr(env, { args = [], input = '', cwd = vacia } = {}) {
  const r = spawnSync(process.execPath, [path.join(RAIZ, SCRIPT), ...args], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30_000, input,
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}
function urlEsquema() {
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set('options', `-c search_path=${base.esquema},public`);
  return u.toString();
}
const ENV_DEV = () => ({ APP_ENV: 'development', DB_HOST_PERMITIDO: new URL(process.env.DATABASE_URL).hostname, DATABASE_URL: urlEsquema() });
const fila = async (sql, p) => (await base.pool.query(sql, p)).rows[0];

async function crearAdmin(email) {
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id, mfa_secreto, sesion_version)
     VALUES ('Admin', $1, $2, (SELECT id FROM roles WHERE clave = 'super-admin'), 1, 'v1:a:b:c', 2) RETURNING id`,
    [email, bcrypt.hashSync('Vieja-Olvidada-2020', 4)]);
  // Bloqueado: 5 fallos de contraseña (clave por correo) y de 2FA (clave por id).
  for (const clave of [claveContrasena(email), clave2fa(u.id)])
    await base.pool.query(`INSERT INTO intentos_acceso (clave, fallos, bloqueado_hasta) VALUES ($1, 0, now() + interval '15 minutes')`, [clave]);
  return String(u.id);
}

// ---------------------------------------------------------------------------------------------- candados
test('exige un correo', () => {
  const r = correr({ APP_ENV: 'development', DATABASE_URL: url(DEV), DB_HOST_PERMITIDO: DEV });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /Uso: npm run admin:reset-password/);
});

test('sin --produccion se niega fuera de desarrollo (antes de pedir la contraseña)', () => {
  const r = correr({ APP_ENV: 'production', DATABASE_URL: url(PROD), DB_HOST_PERMITIDO: DEV }, { args: ['a@b.co'] });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /Operación "admin:reset-password" bloqueada/);
  assert.doesNotMatch(r.salida, /Contraseña nueva/);
});

test('--produccion: la cadena solo vale desde el comando y hay que escribir el host exacto', async () => {
  let r = correr({}, { args: ['a@b.co', '--produccion'] });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /debes pasar DAI_PROD_DATABASE_URL/);

  const conEnv = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-reset-pw-env-'));
  try {
    await fs.writeFile(path.join(conEnv, '.env'), `DAI_PROD_DATABASE_URL=${url(PROD)}\n`);
    r = correr({ DAI_PROD_DATABASE_URL: url(PROD) }, { args: ['a@b.co', '--produccion'], cwd: conEnv });
    assert.equal(r.codigo, 1);
    assert.match(r.salida, /no puede venir del archivo .env/);
  } finally {
    await fs.rm(conEnv, { recursive: true, force: true });
  }

  r = correr({ DAI_PROD_DATABASE_URL: url(PROD) }, { args: ['a@b.co', '--produccion'], input: 'ep-otro-host\n' });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /El host no coincide. No se hizo ningún cambio/);
  assert.ok(!r.salida.includes('u:p@'), 'no imprime credenciales');
});

// ---------------------------------------------------------------------------------------------- validación
test('contraseñas distintas, débiles o vacías: no cambia nada', async () => {
  const id = await crearAdmin('valida-pw@prueba.test');
  const antes = await fila(`SELECT password_hash, sesion_version FROM usuarios WHERE id = $1`, [id]);
  for (const [input, patron] of [
    [`${NUEVA}\nOtra-Distinta-2026\n`, /no coinciden/],
    ['corta1\ncorta1\n', /entre 10 y 72/],
    ['password123\npassword123\n', /demasiado común/],
    ['valida-pw-2026\nvalida-pw-2026\n', /no puede contener su usuario/],
    ['', /No se recibió la contraseña/],
  ]) {
    const r = correr(ENV_DEV(), { args: ['valida-pw@prueba.test'], input });
    assert.equal(r.codigo, 1, r.salida);
    assert.match(r.salida, patron);
    assert.match(r.salida, /No se hizo ningún cambio/);
  }
  assert.deepEqual(await fila(`SELECT password_hash, sesion_version FROM usuarios WHERE id = $1`, [id]), antes);
  assert.equal((await fila(`SELECT count(*)::int AS n FROM intentos_acceso WHERE clave = $1`, [clave2fa(id)])).n, 1, 'sigue bloqueado');
});

// ---------------------------------------------------------------------------------------------- cambio
test('restablece: hash bcrypt de la nueva, sesiones cerradas, bloqueos quitados, 2FA intacto y auditoría sin la contraseña', async () => {
  const id = await crearAdmin('olvido@prueba.test');
  const r = correr(ENV_DEV(), { args: ['OLVIDO@prueba.test'], input: `${NUEVA}\n${NUEVA}\n` });
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Contraseña restablecida para olvido@prueba.test/);
  assert.match(r.salida, /Bloqueos por intentos quitados: 2/);
  assert.match(r.salida, /El 2FA no cambió/);
  assert.ok(!r.salida.includes(NUEVA), 'la contraseña nunca se imprime');

  const u = await fila(`SELECT password_hash, sesion_version, password_cambiado_en, mfa_secreto FROM usuarios WHERE id = $1`, [id]);
  assert.ok(bcrypt.compareSync(NUEVA, u.password_hash));
  assert.ok(!bcrypt.compareSync('Vieja-Olvidada-2020', u.password_hash));
  assert.match(u.password_hash, /^\$2[ab]\$12\$/);
  assert.equal(u.sesion_version, 3);
  assert.ok(u.password_cambiado_en);
  assert.equal(u.mfa_secreto, 'v1:a:b:c');
  assert.equal((await fila(`SELECT count(*)::int AS n FROM intentos_acceso WHERE clave = ANY($1)`,
    [[claveContrasena('olvido@prueba.test'), clave2fa(id)]])).n, 0);

  const a = await fila(`SELECT usuario_id, ip, detalle FROM auditoria WHERE accion = 'restablecer_contrasena' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual([a.usuario_id, a.ip, a.detalle.via, a.detalle.usuarioId, a.detalle.bloqueosQuitados], [null, 'script', 'script_emergencia', id, 2]);
  assert.ok(!JSON.stringify(a.detalle).includes(NUEVA));
});

test('--solo-desbloquear: quita el bloqueo sin pedir ni cambiar la contraseña', async () => {
  const id = await crearAdmin('bloqueado@prueba.test');
  const antes = await fila(`SELECT password_hash, sesion_version FROM usuarios WHERE id = $1`, [id]);
  const r = correr(ENV_DEV(), { args: ['bloqueado@prueba.test', '--solo-desbloquear'] });
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Cuenta bloqueado@prueba.test desbloqueada/);
  assert.doesNotMatch(r.salida, /Contraseña nueva/);
  assert.deepEqual(await fila(`SELECT password_hash, sesion_version FROM usuarios WHERE id = $1`, [id]), antes);
  assert.equal((await fila(`SELECT count(*)::int AS n FROM intentos_acceso WHERE clave = $1`, [clave2fa(id)])).n, 0);
  assert.equal((await fila(`SELECT detalle FROM auditoria WHERE accion = 'desbloquear_cuenta' ORDER BY id DESC LIMIT 1`)).detalle.usuarioId, id);
});

test('correo inexistente: no cambia nada', () => {
  const r = correr(ENV_DEV(), { args: ['nadie@prueba.test'], input: `${NUEVA}\n${NUEVA}\n` });
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /No existe una cuenta con el correo nadie@prueba.test/);
});
