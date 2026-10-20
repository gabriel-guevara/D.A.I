/**
 * Notificaciones por rol (la app REAL por HTTP contra PostgreSQL en un esquema temporal). Criterio: "recibes avisos de
 * lo que haces o de lo que supervisas" (src/lib/categorias-notificaciones.js):
 *   Admin: todo · Cumplimiento: seguridad, solicitudes, consultas, versiones, papelera · Operador: seguridad,
 *   solicitudes, carpetas y movimientos, versiones · Lector: seguridad.
 * Además: ningún aviso con el nombre de un documento llega a quien no alcanza su nivel, y las alertas de seguridad
 * (ingreso, bloqueo, contraseña, 2FA) le llegan a la propia persona.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { crearBaseDePrueba } from './helpers/base-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.STORAGE_DRIVER = 'local';

const SECRETO = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'Clave-Notif-2026!';
let base, servidor, url, db, raiz, pap, totp, notify;
const tokens = {};
const ids = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  await (await import('../src/migrate.js')).aplicarMigraciones(base.pool, { log: () => {} });
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-notif-'));
  await (await import('../src/lib/storage.js')).inicializarAlmacenamiento({ driver: 'local', raiz });
  pap = await import('../src/lib/papelera.js');
  totp = await import('../src/lib/totp.js');
  notify = await import('../src/lib/notify.js');
  const { cifrarSecreto } = await import('../src/lib/cifrado-mfa.js');
  const { firmarToken } = await import('../src/middleware/auth.js');
  const hash = bcrypt.hashSync(PASSWORD, 4);
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'],
    ['admin2', 'super-admin', 'Nivel 2 Confidencial'],
    ['cumplimiento', 'compliance', 'Nivel 3 Alto'],
    ['operador', 'ocr-operator', 'Nivel 2 Auditoría'],
    ['operador5', 'ocr-operator', 'Nivel 5 Secreto'],
    ['lector', 'read-only', 'Nivel 5 Secreto'],
  ]) {
    const { rows: [u] } = await base.pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id)
       VALUES ($1, $2, $3, (SELECT id FROM roles WHERE clave = $4), (SELECT id FROM niveles_acceso WHERE nombre = $5)) RETURNING id`,
      [`Usuario ${clave}`, `${clave}@prueba.test`, hash, rol, nivel]);
    ids[clave] = String(u.id);
    tokens[clave] = firmarToken({ sub: String(u.id) }, 'access', '1h');
    await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2, mfa_activado_en = now() WHERE id = $1`, [u.id, cifrarSecreto(SECRETO, u.id)]);
  }
  const { crearApp } = await import('../src/app.js');
  servidor = crearApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  url = `http://127.0.0.1:${servidor.address().port}/api`;
});

after(async () => {
  await pap?.detenerMantenimiento();
  await new Promise((r) => servidor?.close(r));
  await db?.pool.end();
  await base?.cerrar();
  await fs.rm(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------- utilidades
let ip = 0;
async function pedir(metodo, ruta, quien, cuerpo) {
  const r = await fetch(`${url}${ruta}`, {
    method: metodo,
    headers: {
      'x-forwarded-for': `10.9.${(++ip >> 8) & 255}.${ip & 255}`, // una IP por petición: el límite por IP no interfiere
      ...(quien ? { Authorization: `Bearer ${tokens[quien]}` } : {}),
      ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
}
const get = (ruta, quien) => pedir('GET', ruta, quien);
const post = (ruta, quien, cuerpo) => pedir('POST', ruta, quien, cuerpo);
const filas = async (sql, params) => (await base.pool.query(sql, params)).rows;
const notifs = (quien, patron = '%') =>
  filas(`SELECT titulo, descripcion, categoria, meta FROM notificaciones WHERE usuario_id = $1 AND titulo LIKE $2 ORDER BY id`, [ids[quien], patron]);
const titulos = async (quien, patron) => (await notifs(quien, patron)).map((n) => n.titulo);
const TODOS = ['admin', 'admin2', 'cumplimiento', 'operador', 'operador5', 'lector'];
/** Quiénes (de TODOS) tienen al menos una notificación con ese título. */
const quienesRecibieron = async (patron) => {
  const out = [];
  for (const q of TODOS) if ((await notifs(q, patron)).length) out.push(q);
  return out;
};
let folios = 0;
async function crearDoc(nombre, clasif = 'Uso Interno General') {
  const { rows: [d] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre)
     VALUES ($1, $2, 'pdf', (SELECT id FROM clasificaciones WHERE nombre = $3), 'Autor') RETURNING id, folio`,
    [nombre, `EXP-NT-${++folios}`, clasif]);
  return { id: String(d.id), folio: d.folio };
}
// Código TOTP sin repetir paso (la app rechaza un código ya usado): cada llamada avanza un paso de 30 s hacia atrás.
let pasos = 0;
const codigo = () => totp.codigoPara(SECRETO, Date.now() - 30_000 * (pasos++ % 2));

// ---------------------------------------------------------------------------------------------- matriz
test('categorías por rol: Admin todo, Cumplimiento sin carpetas, Operador sin consultas ni papelera, Lector solo seguridad', async () => {
  const cats = async (q) => (await get('/notificaciones/categorias', q)).cuerpo.categorias;
  assert.deepEqual(await cats('admin'), ['seguridad', 'solicitud', 'consulta', 'edicion', 'version', 'eliminado']);
  assert.deepEqual(await cats('cumplimiento'), ['seguridad', 'solicitud', 'consulta', 'version', 'eliminado']);
  assert.deepEqual(await cats('operador'), ['seguridad', 'solicitud', 'edicion', 'version']);
  assert.deepEqual(await cats('lector'), ['seguridad']);
  assert.equal((await get('/notificaciones/categorias')).status, 401);
});

test('lo que no corresponde al rol queda oculto en la lista, el contador y "leer todas" (no se borra)', async () => {
  // Notificaciones antiguas de todas las categorías para el lector (p. ej. de cuando tenía otro rol).
  for (const cat of ['seguridad', 'solicitud', 'consulta', 'edicion', 'version', 'eliminado'])
    await base.pool.query(
      `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, titulo, descripcion)
       VALUES ($1, $2, 'b', 'b', 'b', $3, 'd')`, [ids.lector, cat, `Antigua ${cat}`]);
  const lista = (await get('/notificaciones', 'lector')).cuerpo;
  assert.deepEqual(lista.map((n) => n.title), ['Antigua seguridad']);
  assert.equal((await get('/notificaciones?categoria=consulta', 'lector')).cuerpo.length, 1, 'pedir otra categoría no la revela');
  assert.equal((await get('/notificaciones/resumen', 'lector')).cuerpo.noLeidas, 1);
  assert.equal((await post('/notificaciones/leer-todas', 'lector')).status, 204);
  const [{ n }] = await filas(`SELECT count(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND NOT leida`, [ids.lector]);
  assert.equal(n, 5, 'las ocultas siguen en la base, sin tocar');
  await base.pool.query(`DELETE FROM notificaciones WHERE usuario_id = $1`, [ids.lector]);
});

// ---------------------------------------------------------------------------------------------- carpetas
test('carpetas: crear, renombrar, mover y eliminar solo avisan a quienes pueden mover (Admin y Operador)', async () => {
  const a = (await post('/carpetas', 'admin', { nombre: 'Notif A' })).cuerpo.id;
  const b = (await post('/carpetas', 'operador', { nombre: 'Notif B' })).cuerpo.id;
  await pedir('PATCH', `/carpetas/${b}`, 'admin', { nombre: 'Notif B2' });
  await pedir('PATCH', `/carpetas/${b}`, 'admin', { padreId: a });
  await pedir('DELETE', `/carpetas/${b}`, 'admin');
  const movedores = ['admin', 'admin2', 'operador', 'operador5'];
  for (const patron of ['Carpeta creada: Notif A', 'Carpeta renombrada: Notif B → Notif B2', 'Carpeta movida: Notif B2%', 'Carpeta eliminada: Notif A › Notif B2'])
    assert.deepEqual(await quienesRecibieron(patron), movedores, patron);
  await pedir('DELETE', `/carpetas/${a}`, 'admin');
});

test('documentos movidos: cada destinatario cuenta y ve solo los folios de su nivel; si no alcanza ninguno, no recibe aviso', async () => {
  const destino = (await post('/carpetas', 'admin', { nombre: 'Destino notif' })).cuerpo.id;
  const pub = await crearDoc('Público.pdf');
  const sec = await crearDoc('Secreto.pdf', 'Secreto Corporativo');
  assert.equal((await post('/carpetas/mover', 'admin', { ids: [pub.id, sec.id], carpetaId: destino })).cuerpo.movidos, 2);
  const [n5] = await notifs('operador5', '%movido%');
  assert.deepEqual([n5.titulo, n5.meta], ['2 documentos movidos a «Destino notif»', [`Folios: ${pub.folio}, ${sec.folio}`]]);
  const [n2] = await notifs('operador', '%movido%');
  assert.deepEqual([n2.titulo, n2.meta], ['Documento movido a «Destino notif»', [`Folios: ${pub.folio}`]], 'el folio Secreto no le llega al nivel 2');
  assert.deepEqual(await quienesRecibieron('%movido%'), ['admin', 'admin2', 'operador', 'operador5']);

  // Solo el Secreto: el nivel 2 no se entera de que se movió algo.
  const otro = (await post('/carpetas', 'admin', { nombre: 'Otro destino' })).cuerpo.id;
  await post('/carpetas/mover', 'admin', { ids: [sec.id], carpetaId: otro });
  assert.deepEqual(await quienesRecibieron('%movido a «Otro destino»'), ['admin', 'operador5']);
  assert.ok(!(await notifs('operador')).some((n) => /Secreto/.test(n.titulo + n.descripcion)));
});

// ---------------------------------------------------------------------------------------------- solicitudes
test('solicitudes: categoría propia; las reciben quienes resuelven (con su nivel) y el solicitante recibe el resultado', async () => {
  const d = await crearDoc('Para solicitar.pdf');
  const carpeta = (await post('/carpetas', 'admin', { nombre: 'Destino solicitud' })).cuerpo.id;
  const s = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: d.id, carpetaId: carpeta, motivo: 'Corresponde a esa carpeta.' });
  assert.equal(s.status, 201, JSON.stringify(s.cuerpo));
  assert.deepEqual(await quienesRecibieron('Solicitud de movimiento: Para solicitar.pdf'), ['admin', 'admin2', 'operador', 'operador5']);
  assert.equal((await notifs('operador', 'Solicitud de movimiento:%'))[0].categoria, 'solicitud');
  assert.equal((await post(`/carpetas/solicitudes/${s.cuerpo.id}/aprobar`, 'operador', {})).status, 200);
  const [r] = await notifs('cumplimiento', 'Solicitud aprobada: Para solicitar.pdf');
  assert.equal(r.categoria, 'solicitud');
  const enLista = (await get('/notificaciones', 'cumplimiento')).cuerpo.find((n) => n.title.startsWith('Solicitud aprobada'));
  assert.deepEqual([enLista.category, enLista.badge], ['solicitud', 'Solicitudes']);
  assert.deepEqual(await quienesRecibieron('Solicitud aprobada:%'), ['cumplimiento']);
});

// ---------------------------------------------------------------------------------------------- versiones, papelera, consultas
test('versiones: Admin, Cumplimiento y Operador; nunca a quien no alcanza el nivel del documento', async () => {
  const pub = await crearDoc('Versionado.pdf');
  const sec = await crearDoc('Versionado secreto.pdf', 'Secreto Corporativo');
  await notify.notificarGestores({ categoria: 'version', documentoId: pub.id, titulo: 'Nueva versión v2 de Versionado.pdf', descripcion: 'x' });
  await notify.notificarGestores({ categoria: 'version', documentoId: sec.id, titulo: 'Nueva versión v2 de Versionado secreto.pdf', descripcion: 'x' });
  assert.deepEqual(await quienesRecibieron('Nueva versión v2 de Versionado.pdf'), ['admin', 'admin2', 'cumplimiento', 'operador', 'operador5']);
  assert.deepEqual(await quienesRecibieron('Nueva versión v2 de Versionado secreto.pdf'), ['admin', 'operador5'], 'solo nivel 5');
});

test('papelera (por HTTP): Admin y Cumplimiento con su nivel; el Operador no (no la puede usar)', async () => {
  const pub = await crearDoc('A la papelera.pdf');
  const sec = await crearDoc('Secreto a la papelera.pdf', 'Secreto Corporativo');
  assert.equal((await pedir('DELETE', `/documentos/${pub.id}`, 'cumplimiento')).status, 204);
  assert.equal((await pedir('DELETE', `/documentos/${sec.id}`, 'admin')).status, 204);
  assert.deepEqual(await quienesRecibieron('Documento enviado a la Papelera: A la papelera.pdf'), ['admin', 'admin2', 'cumplimiento']);
  assert.deepEqual(await quienesRecibieron('Documento enviado a la Papelera: Secreto a la papelera.pdf'), ['admin']);
  assert.equal((await post(`/papelera/${pub.id}/restaurar`, 'cumplimiento', {})).status, 200);
  assert.deepEqual(await quienesRecibieron('Documento restaurado desde la Papelera: A la papelera.pdf'), ['admin', 'admin2', 'cumplimiento']);
});

test('consultas: avisan a Admin y Cumplimiento que alcanzan el nivel; el Lector y el Operador no las reciben', async () => {
  const pub = await crearDoc('Consultado.pdf');
  const sec = await crearDoc('Consultado secreto.pdf', 'Secreto Corporativo');
  assert.equal((await get(`/documentos/${pub.id}`, 'lector')).status, 200);
  assert.equal((await get(`/documentos/${sec.id}`, 'lector')).status, 200);
  assert.deepEqual(await quienesRecibieron('Usuario lector consultó Consultado.pdf'), ['admin', 'admin2', 'cumplimiento']);
  assert.deepEqual(await quienesRecibieron('Usuario lector consultó Consultado secreto.pdf'), ['admin'], 'nivel 5: ni el admin de nivel 2 ni Cumplimiento (3)');
  assert.deepEqual(await titulos('lector', 'Consultaste%'), [], 'el lector no tiene la categoría consultas');
});

// ---------------------------------------------------------------------------------------------- seguridad
test('seguridad: cada inicio de sesión le llega a la propia persona (también al Lector) con la fecha y la IP', async () => {
  const l = await post('/auth/login', null, { username: 'lector@prueba.test', password: PASSWORD });
  assert.equal(l.cuerpo.paso, '2fa');
  const v = await post('/auth/verify-2fa', null, { mfaToken: l.cuerpo.mfaToken, code: codigo() });
  assert.equal(v.status, 200, JSON.stringify(v.cuerpo));
  const [n] = await notifs('lector', 'Nuevo inicio de sesión%');
  assert.equal(n.categoria, 'seguridad');
  assert.match(n.descripcion, /código de la app autenticadora. Si no fuiste tú/);
  assert.match(n.meta[0], /^Fecha: \d{2} \w{3} \d{4}, \d{1,2}:\d{2} (a|p)\. m\.$/);
  assert.match(n.meta[1], /^Origen: IP 10\.9\./);
  assert.deepEqual((await get('/notificaciones', 'lector')).cuerpo.map((x) => x.category), ['seguridad']);
  assert.deepEqual(await quienesRecibieron('Nuevo inicio de sesión%'), ['lector'], 'solo a quien ingresó');
});

test('seguridad: varios intentos fallidos → "Tu cuenta se bloqueó temporalmente" (una sola vez)', async () => {
  for (let i = 0; i < 6; i++) await post('/auth/login', null, { username: 'operador@prueba.test', password: 'incorrecta' });
  assert.deepEqual(await titulos('operador', 'Tu cuenta se bloqueó%'), ['Tu cuenta se bloqueó temporalmente']);
  await base.pool.query(`DELETE FROM intentos_acceso`);
});

test('seguridad: cambiar la propia contraseña y que un administrador la restablezca avisan al afectado (sin datos sensibles)', async () => {
  const r = await post('/cuenta/password', 'cumplimiento', { actual: PASSWORD, nueva: 'Otra-Clave-Segura-2026', code: codigo() });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  tokens.cumplimiento = r.cuerpo.token;
  assert.deepEqual(await titulos('cumplimiento', 'Tu contraseña cambió'), ['Tu contraseña cambió']);

  const p = await pedir('PATCH', `/seguridad/usuarios/${ids.operador5}`, 'admin', { password: 'Restablecida-Por-Admin-2026' });
  assert.equal(p.status, 200, JSON.stringify(p.cuerpo));
  assert.deepEqual(await quienesRecibieron('Un administrador restableció tu contraseña'), ['operador5']);
  const todas = JSON.stringify(await filas(`SELECT titulo, descripcion, meta FROM notificaciones WHERE categoria = 'seguridad'`));
  for (const secreto of ['Otra-Clave-Segura-2026', 'Restablecida-Por-Admin-2026', PASSWORD, SECRETO]) assert.ok(!todas.includes(secreto));
});

test('seguridad: restablecer el 2FA de otra persona le avisa a ella, no al administrador', async () => {
  const r = await post(`/seguridad/usuarios/${ids.lector}/restablecer-2fa`, 'admin', { code: codigo() });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(await quienesRecibieron('Un administrador restableció tu verificación en dos pasos'), ['lector']);
});
