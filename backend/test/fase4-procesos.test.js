/**
 * Fase 4 con PROCESOS reales:
 *  - la API se niega a arrancar con PAPELERA_DIAS_RETENCION inválida;
 *  - prueba de humo: `node src/server.js` de verdad. Al arrancar (= "despertar" en Render) purga lo vencido de la
 *    papelera y borra su objeto; después, login real con TOTP, versión nueva, papelera y restauración por HTTP.
 *
 * El proceso hijo usa el driver local con su carpeta por defecto (backend/.storage, ignorada por git) y claves de
 * objeto propias de la prueba, que se limpian al terminar. La base es un esquema temporal (nunca public).
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
import { crearPdf, sha256 } from './helpers/pdf-prueba.js';
import { codigoPara } from '../src/lib/totp.js';
import { cifrarSecreto } from '../src/lib/cifrado-mfa.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = path.join(RAIZ, '.storage');
const SECRETO = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DOC_PRUEBA = String(900_000_000 + crypto.randomInt(99_999_999)); // id propio: no choca con nada real
let vacia, base;

before(async () => {
  vacia = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase4-'));
  base = await crearBaseDePrueba();
});
after(async () => {
  await fs.rm(vacia, { recursive: true, force: true });
  await fs.rm(path.join(STORAGE, 'docs', DOC_PRUEBA), { recursive: true, force: true });
  await base?.cerrar();
});

function urlEsquema() {
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set('options', `-c search_path=${base.esquema},public`);
  return u.toString();
}
const ENV_DEV = () => ({
  APP_ENV: 'development', DB_HOST_PERMITIDO: new URL(process.env.DATABASE_URL).hostname, DATABASE_URL: urlEsquema(),
  JWT_SECRET: 'j'.repeat(48), STORAGE_DRIVER: 'local', MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
});

test('la API no arranca con PAPELERA_DIAS_RETENCION inválida', () => {
  for (const valor of ['abc', '-1', '3651', '2.5']) {
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'src/server.js')], {
      cwd: vacia, env: { PATH: process.env.PATH, ...ENV_DEV(), DATABASE_URL: 'postgres://u:p@dev.invalid:5432/db', DB_HOST_PERMITIDO: 'dev.invalid', PAPELERA_DIAS_RETENCION: valor },
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(r.status, 1, valor);
    assert.match(`${r.stdout}${r.stderr}`, /PAPELERA_DIAS_RETENCION debe ser un entero entre 0 y 3650/);
  }
});

test('humo: node src/server.js real — purga al despertar, versiones y papelera por HTTP', { timeout: 120_000 }, async () => {
  // Administrador con contraseña y 2FA ya activo.
  const password = 'Humo-Fase4-2026';
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id)
     VALUES ('Humo 4', 'humo4@prueba.test', $1, (SELECT id FROM roles WHERE clave = 'super-admin'),
             (SELECT id FROM niveles_acceso ORDER BY rango DESC LIMIT 1)) RETURNING id`, [bcrypt.hashSync(password, 4)]);
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2, mfa_activado_en = now() WHERE id = $1`, [u.id, cifrarSecreto(SECRETO, u.id)]);

  // Documento en la papelera con el plazo VENCIDO y su objeto real en .storage: debe purgarse al arrancar.
  const bytes = crearPdf({ paginas: 1 });
  const clave = `docs/${DOC_PRUEBA}/${DOC_PRUEBA}/${crypto.randomUUID()}.pdf`;
  await fs.mkdir(path.dirname(path.join(STORAGE, clave)), { recursive: true });
  await fs.writeFile(path.join(STORAGE, clave), bytes);
  await base.pool.query(
    `INSERT INTO documentos (id, nombre, folio, formato, clasificacion_id, autor_nombre, estado, eliminado_en, purgar_despues_de,
                             tiene_archivo, storage_path, storage_driver, hash_sha256, nombre_original, tamano_bytes)
     VALUES ($1, 'Vencido.pdf', 'EXP-HUMO-4', 'pdf', 3, 'X', 'papelera', now() - interval '40 days', now() - interval '10 days',
             true, $2, 'local', $3, 'Vencido.pdf', $4)`, [DOC_PRUEBA, clave, sha256(bytes), bytes.length]);
  await base.pool.query(`INSERT INTO documento_versiones (documento_id, version, storage_path, storage_driver, hash_sha256, tamano_bytes)
                         VALUES ($1, 'v1.0', $2, 'local', $3, $4)`, [DOC_PRUEBA, clave, sha256(bytes), bytes.length]);
  // Los documentos que suba el servidor tendrán ids a partir de DOC_PRUEBA + 1: sus carpetas en .storage nunca
  // coinciden con las de tus datos locales de desarrollo (ids pequeños) y se pueden borrar sin riesgo al terminar.
  await base.pool.query(`SELECT setval(pg_get_serial_sequence('documentos', 'id'), $1)`, [DOC_PRUEBA]);

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
    assert.match(salida, /Migración aplicada: 005_papelera_versiones/);

    // 1) Purga al despertar: sin ninguna petición, el mantenimiento del arranque purga y borra el objeto.
    let estado;
    for (let i = 0; i < 60; i++) {
      estado = (await base.pool.query(`SELECT estado FROM documentos WHERE id = $1`, [DOC_PRUEBA])).rows[0].estado;
      const quedan = (await base.pool.query(`SELECT count(*)::int AS n FROM objetos_por_borrar`)).rows[0].n;
      if (estado === 'purgado' && quedan === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(estado, 'purgado');
    await assert.rejects(fs.stat(path.join(STORAGE, clave)), { code: 'ENOENT' });
    const { rows: aud } = await base.pool.query(
      `SELECT accion, usuario_id FROM auditoria WHERE documento_id = $1 ORDER BY id`, [DOC_PRUEBA]);
    assert.deepEqual(aud.map((a) => [a.accion, a.usuario_id]), [['purgar_documento', null], ['borrar_objeto', null]]);

    // 2) Login real con TOTP.
    const api = `http://127.0.0.1:${puerto}/api`;
    const json = async (r) => ({ status: r.status, cuerpo: await r.json().catch(() => null) });
    const enviar = (metodo, ruta, { token, cuerpo, form } = {}) => fetch(`${api}${ruta}`, {
      method: metodo,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
      body: form ?? (cuerpo ? JSON.stringify(cuerpo) : undefined),
    }).then(json);
    const l = await enviar('POST', '/auth/login', { cuerpo: { username: 'humo4@prueba.test', password } });
    assert.equal(l.cuerpo.paso, '2fa');
    const v = await enviar('POST', '/auth/verify-2fa', { cuerpo: { mfaToken: l.cuerpo.mfaToken, code: codigoPara(SECRETO, Date.now() - 30_000) } });
    assert.equal(v.status, 200, JSON.stringify(v.cuerpo));
    const token = v.cuerpo.token;

    // 3) Subida + versión nueva + historial + descarga de la v1.0 con su hash.
    const formulario = (campos, pdf, nombre) => {
      const f = new FormData();
      for (const [k, val] of Object.entries(campos)) f.append(k, val);
      f.append('archivo', new Blob([pdf], { type: 'application/pdf' }), nombre);
      return f;
    };
    const v1 = crearPdf({ textos: ['Humo primera version'] });
    const doc = await enviar('POST', '/digitalizacion/documentos', { token, form: formulario({ clasificacion: 'Uso Interno General' }, v1, 'Humo.pdf') });
    assert.equal(doc.status, 201, JSON.stringify(doc.cuerpo));
    const v2 = await enviar('POST', `/documentos/${doc.cuerpo.id}/versiones`,
      { token, form: formulario({ comentario: 'Prueba de humo' }, crearPdf({ textos: ['Humo segunda version'] }), 'Humo.pdf') });
    assert.equal(v2.status, 201, JSON.stringify(v2.cuerpo));
    assert.equal(v2.cuerpo.version, 'v2.0');
    const hist = await enviar('GET', `/documentos/${doc.cuerpo.id}/versiones`, { token });
    const anterior = hist.cuerpo.versiones.find((x) => x.version === 'v1.0');
    const descarga = await fetch(`${api}/documentos/${doc.cuerpo.id}/versiones/${anterior.id}/descarga`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(sha256(Buffer.from(await descarga.arrayBuffer())), sha256(v1));

    // 4) Papelera: eliminar, listar, restaurar.
    assert.equal((await fetch(`${api}/documentos/${doc.cuerpo.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 204);
    const lista = await enviar('GET', '/papelera', { token });
    assert.ok(lista.cuerpo.documentos.some((x) => x.id === doc.cuerpo.id));
    assert.equal((await enviar('POST', `/papelera/${doc.cuerpo.id}/restaurar`, { token })).status, 200);
    assert.equal((await enviar('GET', `/documentos/${doc.cuerpo.id}`, { token })).cuerpo.version, 'v2.0');
    assert.ok(Number(doc.cuerpo.id) > Number(DOC_PRUEBA));
    await fs.rm(path.join(STORAGE, 'docs', String(doc.cuerpo.id)), { recursive: true, force: true });
  } finally {
    hijo.kill('SIGTERM');
  }
});
