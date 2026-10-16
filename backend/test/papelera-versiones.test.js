/**
 * Fase 4 de punta a punta: la app REAL por HTTP, PostgreSQL en un esquema temporal y el driver "local" en una
 * carpeta temporal. Versiones (subir, listar, ver/descargar una concreta con su hash, restaurar), búsqueda
 * coherente con la versión actual, papelera (eliminar, listar con permisos, restaurar, purgar con 2FA, vaciar,
 * retención legal y purga automática), consistencia ante fallos del almacenamiento o de la base y auditoría.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { crearPdf, sha256 } from './helpers/pdf-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.MAX_UPLOAD_MB = '2';
process.env.STORAGE_DRIVER = 'local';

const SECRETO_ADMIN = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let base, servidor, url, raiz, st, db, ix, pap, totp;
const tokens = {};
const ids = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  await (await import('../src/migrate.js')).aplicarMigraciones(base.pool, { log: () => {} });
  const storage = await import('../src/lib/storage.js');
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase4-'));
  st = await storage.inicializarAlmacenamiento({ driver: 'local', raiz });
  ix = await import('../src/lib/indexador.js');
  pap = await import('../src/lib/papelera.js');
  totp = await import('../src/lib/totp.js');
  const { cifrarSecreto } = await import('../src/lib/cifrado-mfa.js');

  const { firmarToken } = await import('../src/middleware/auth.js');
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'],
    ['admin3', 'super-admin', 'Nivel 3 Alto'],
    ['cumplimiento', 'compliance', 'Nivel 3 Alto'],
    ['operador', 'ocr-operator', 'Nivel 2 Auditoría'],
    ['lector3', 'read-only', 'Nivel 3 Restringido'],
  ]) {
    const { rows: [u] } = await base.pool.query(
      `INSERT INTO usuarios (nombre, email, rol_id, nivel_id)
       VALUES ($1, $2, (SELECT id FROM roles WHERE clave = $3), (SELECT id FROM niveles_acceso WHERE nombre = $4)) RETURNING id`,
      [`Usuario ${clave}`, `${clave}@prueba.test`, rol, nivel]);
    ids[clave] = String(u.id);
    tokens[clave] = firmarToken({ sub: String(u.id) }, 'access', '1h');
  }
  // El administrador tiene 2FA real (secreto cifrado como en producción): purgar exige su código.
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2, mfa_activado_en = now() WHERE id = $1`,
    [ids.admin, cifrarSecreto(SECRETO_ADMIN, ids.admin)]);

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

beforeEach(() => {
  ix.configurarIndexador();
  pap.configurarPapelera({ diasRetencion: 30 });
});

// ---------------------------------------------------------------------------------------------- utilidades
const auth = (quien) => ({ Authorization: `Bearer ${tokens[quien]}` });
async function pedir(metodo, ruta, quien = 'admin', cuerpo) {
  const r = await fetch(`${url}${ruta}`, {
    method: metodo,
    headers: { ...auth(quien), ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
}
const get = (ruta, quien) => pedir('GET', ruta, quien);
const post = (ruta, quien, cuerpo) => pedir('POST', ruta, quien, cuerpo);
const del = (ruta, quien) => pedir('DELETE', ruta, quien);

/** Código TOTP del administrador. Se "olvida" el último paso usado: cada purga de la prueba es un momento distinto. */
async function codigoAdmin() {
  await base.pool.query(`UPDATE usuarios SET mfa_ultimo_paso = NULL WHERE id = $1`, [ids.admin]);
  return totp.codigoPara(SECRETO_ADMIN, Date.now());
}

let folio = 0;
const pdf = (texto) => crearPdf({ textos: [texto ?? `Contenido ${++folio} ${Math.random()}`], relleno: 16 * 1024 });

async function subirDoc({ texto, clasificacion = 'Uso Interno General', quien = 'admin', nombre = 'Contrato.pdf' } = {}) {
  const bytes = pdf(texto);
  const f = new FormData();
  f.append('clasificacion', clasificacion);
  f.append('archivo', new Blob([bytes], { type: 'application/pdf' }), nombre);
  const r = await fetch(`${url}/digitalizacion/documentos`, { method: 'POST', headers: auth(quien), body: f });
  const cuerpo = await r.json();
  assert.equal(r.status, 201, JSON.stringify(cuerpo));
  return { ...cuerpo, bytes };
}

function subirVersion(id, { bytes = pdf(), comentario = 'Ajuste de cláusulas', quien = 'admin', nombre = 'Contrato v2.pdf' } = {}) {
  const f = new FormData();
  if (comentario !== null) f.append('comentario', comentario); // null = sin el campo (undefined tomaría el valor por defecto)
  if (bytes) f.append('archivo', new Blob([bytes], { type: 'application/pdf' }), nombre);
  return fetch(`${url}/documentos/${id}/versiones`, { method: 'POST', headers: auth(quien), body: f })
    .then(async (r) => ({ status: r.status, cuerpo: await r.json().catch(() => null), bytes }));
}

const fila = async (sql, params) => (await base.pool.query(sql, params)).rows[0];
const filas = async (sql, params) => (await base.pool.query(sql, params)).rows;
const documento = (id) => fila(`SELECT * FROM documentos WHERE id = $1`, [id]);
const versionesDb = (id) => filas(`SELECT * FROM documento_versiones WHERE documento_id = $1 ORDER BY id`, [id]);
const existe = (clave) => st.existe(clave);
async function objetos() {
  const lista = await fs.readdir(raiz, { recursive: true, withFileTypes: true }).catch(() => []);
  return lista.filter((e) => e.isFile()).length;
}
const auditorias = (accion, docId) =>
  filas(`SELECT a.detalle, a.usuario_id, u.email FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
          WHERE a.accion = $1 AND ($2::bigint IS NULL OR a.documento_id = $2) ORDER BY a.id`, [accion, docId ?? null]);
const cola = () => filas(`SELECT * FROM objetos_por_borrar ORDER BY id`);
const silenciar = async (fn) => {
  const [e, w] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.warn] = [e, w]; }
};
async function bytesDe(ruta, quien = 'admin') {
  const r = await fetch(`${url}${ruta}`, { headers: auth(quien) });
  return { status: r.status, cabeceras: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
}
const buscar = async (q, quien = 'admin') =>
  (await get(`/busqueda?q=${encodeURIComponent(q)}&algoritmo=exacta`, quien)).cuerpo.map((x) => x.docId);

// ---------------------------------------------------------------------------------------------- versiones
test('subir versión: v2.0 pasa a ser la actual, la v1.0 y su archivo se conservan; auditado y notificado', async () => {
  const doc = await subirDoc();
  const antes = await documento(doc.id);
  const r = await subirVersion(doc.id, { quien: 'operador', comentario: '  Ajuste   de cláusula 7  ' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.version, 'v2.0');
  assert.equal(r.cuerpo.anterior, 'v1.0');
  assert.equal(r.cuerpo.hash, sha256(r.bytes));
  assert.equal(r.cuerpo.comentario, 'Ajuste de cláusula 7'); // espacios normalizados

  const d = await documento(doc.id);
  assert.equal(d.version_actual, 'v2.0');
  assert.equal(d.hash_sha256, sha256(r.bytes));
  assert.equal(Number(d.tamano_bytes), r.bytes.length);
  assert.equal(d.nombre_original, 'Contrato v2.pdf');
  assert.notEqual(d.storage_path, antes.storage_path);
  assert.match(d.storage_path, new RegExp(`^docs/${doc.id}/${r.cuerpo.id}/[0-9a-f-]{36}\\.pdf$`));
  assert.ok(await existe(antes.storage_path), 'el archivo de la v1.0 sigue en el almacenamiento');
  assert.ok(await existe(d.storage_path));

  const vs = await versionesDb(doc.id);
  assert.deepEqual(vs.map((v) => v.version), ['v1.0', 'v2.0']);
  assert.equal(vs[0].storage_path, antes.storage_path);
  assert.equal(vs[0].nombre_original, 'Contrato.pdf');
  assert.equal(vs[1].paginas, 1);

  const [a] = await auditorias('subir_version', doc.id);
  assert.equal(a.email, 'operador@prueba.test');
  assert.deepEqual([a.detalle.version, a.detalle.anterior, a.detalle.sha256], ['v2.0', 'v1.0', sha256(r.bytes)]);
  const n = await filas(`SELECT titulo FROM notificaciones WHERE documento_id = $1 AND categoria = 'version'`, [doc.id]);
  assert.ok(n.length >= 1 && n[0].titulo.startsWith('Nueva versión v2.0'));
  assert.equal((await cola()).filter((f) => f.motivo === 'subida_en_curso').length, 0, 'la intención de subida se tachó');
});

test('historial: lista todas con la actual marcada, hash, autor y fecha en hora de Colombia', async () => {
  const doc = await subirDoc();
  const v2 = await subirVersion(doc.id);
  const r = await get(`/documentos/${doc.id}/versiones`, 'lector3');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.versionActual, 'v2.0');
  assert.equal(r.cuerpo.puedeGestionar, false); // lector: solo consulta
  assert.deepEqual(r.cuerpo.versiones.map((v) => [v.version, v.actual, v.tieneArchivo]), [['v2.0', true, true], ['v1.0', false, true]]);
  assert.equal(r.cuerpo.versiones[0].hash, v2.cuerpo.hash);
  assert.equal(r.cuerpo.versiones[1].hash, doc.hash);
  assert.equal(r.cuerpo.versiones[0].autor, 'Usuario admin');
  assert.match(r.cuerpo.versiones[0].fecha, /^\d{2} \w{3} \d{4}, \d{1,2}:\d{2} (a|p)\. m\.$/);
  assert.equal((await get(`/documentos/${doc.id}/versiones`, 'operador')).cuerpo.puedeGestionar, true);
});

test('ver y descargar una versión concreta: bytes exactos (su SHA-256), nombre con la versión y auditado', async () => {
  const doc = await subirDoc({ nombre: 'Póliza.pdf' });
  const v2 = await subirVersion(doc.id, { nombre: 'Póliza.pdf' });
  const { cuerpo: { versiones } } = await get(`/documentos/${doc.id}/versiones`);
  const v1 = versiones.find((v) => v.version === 'v1.0');

  const r = await bytesDe(`/documentos/${doc.id}/versiones/${v1.id}/descarga`, 'lector3');
  assert.equal(r.status, 200);
  assert.equal(sha256(r.bytes), v1.hash);
  assert.equal(sha256(r.bytes), doc.hash);
  assert.equal(r.cabeceras.get('content-disposition'), `attachment; filename="Poliza (v1.0).pdf"; filename*=UTF-8''P%C3%B3liza%20%28v1.0%29.pdf`);
  assert.equal(r.cabeceras.get('cache-control'), 'private, no-store');

  const inline = await bytesDe(`/documentos/${doc.id}/versiones/${v1.id}/archivo`);
  assert.equal(inline.cabeceras.get('content-disposition').split(';')[0], 'inline');
  assert.equal(sha256(inline.bytes), doc.hash);
  // El archivo "actual" ya es la v2.0
  assert.equal(sha256((await bytesDe(`/documentos/${doc.id}/archivo`)).bytes), v2.cuerpo.hash);

  const desc = await auditorias('descargar', doc.id);
  assert.equal(desc.length, 1);
  assert.equal(desc[0].detalle.version, 'v1.0');
  assert.equal(desc[0].email, 'lector3@prueba.test');
  assert.equal((await auditorias('ver_archivo', doc.id)).find((a) => a.detalle.version)?.detalle.version, 'v1.0');

  // Versión de otro documento, inexistente o id no numérico: 404
  const otro = await subirDoc();
  assert.equal((await bytesDe(`/documentos/${otro.id}/versiones/${v1.id}/descarga`)).status, 404);
  assert.equal((await bytesDe(`/documentos/${doc.id}/versiones/999999/descarga`)).status, 404);
  assert.equal((await bytesDe(`/documentos/${doc.id}/versiones/abc/descarga`)).status, 404);
});

test('restaurar una versión anterior: vuelve a ser la actual sin copiar archivos; la siguiente subida es v3.0', async () => {
  const doc = await subirDoc();
  await subirVersion(doc.id);
  const v1 = (await versionesDb(doc.id))[0];
  const objetosAntes = await objetos();

  let r = await post(`/documentos/${doc.id}/versiones/${v1.id}/restaurar`, 'operador');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.version, r.cuerpo.anterior], ['v1.0', 'v2.0']);
  const d = await documento(doc.id);
  assert.equal(d.version_actual, 'v1.0');
  assert.equal(d.hash_sha256, doc.hash);
  assert.equal(d.storage_path, v1.storage_path);
  assert.equal(d.nombre_original, 'Contrato.pdf');
  assert.equal(await objetos(), objetosAntes, 'restaurar no copia archivos');
  assert.equal((await versionesDb(doc.id)).length, 2, 'el historial se conserva');
  assert.equal(sha256((await bytesDe(`/documentos/${doc.id}/archivo`)).bytes), doc.hash);
  const [a] = await auditorias('restaurar_version', doc.id);
  assert.deepEqual([a.detalle.version, a.detalle.anterior, a.email], ['v1.0', 'v2.0', 'operador@prueba.test']);

  // Ya es la actual: 409. Lector o cumplimiento: 403.
  assert.equal((await post(`/documentos/${doc.id}/versiones/${v1.id}/restaurar`)).cuerpo.codigo, 'ya_actual');
  for (const quien of ['lector3', 'cumplimiento'])
    assert.equal((await post(`/documentos/${doc.id}/versiones/${v1.id}/restaurar`, quien)).status, 403);

  const v3 = await subirVersion(doc.id);
  assert.equal(v3.cuerpo.version, 'v3.0', 'nunca se reutiliza un número de versión');
});

test('validaciones de la subida de versión: comentario, idéntico, no PDF, roles, nivel, papelera y formato', async () => {
  const doc = await subirDoc();
  let antes = [await objetos(), (await versionesDb(doc.id)).length];
  const sinCambios = async (promesa, status, patron) => {
    const r = await promesa;
    assert.equal(r.status, status, JSON.stringify(r.cuerpo));
    if (patron) assert.match(r.cuerpo.error, patron);
    assert.deepEqual([await objetos(), (await versionesDb(doc.id)).length], antes, 'sin objetos ni filas nuevas');
    assert.equal((await documento(doc.id)).version_actual, 'v1.0');
    return r;
  };
  await sinCambios(subirVersion(doc.id, { comentario: null }), 400, /comentario/);
  await sinCambios(subirVersion(doc.id, { comentario: ' a ' }), 400, /mínimo 3/);
  const ident = await sinCambios(subirVersion(doc.id, { bytes: doc.bytes }), 409, /idéntico/);
  assert.equal(ident.cuerpo.codigo, 'sin_cambios');
  await sinCambios(subirVersion(doc.id, { bytes: Buffer.from('no soy un pdf') }), 415, /no es un PDF/);
  await sinCambios(subirVersion(doc.id, { bytes: null }), 400, /ningún archivo/);
  for (const quien of ['lector3', 'cumplimiento']) await sinCambios(subirVersion(doc.id, { quien }), 403);

  const secreto = await subirDoc({ clasificacion: 'Secreto Corporativo' });
  assert.equal((await subirVersion(secreto.id, { quien: 'operador' })).status, 404); // nivel 2 < 5: ni sabe que existe
  assert.equal((await get(`/documentos/${secreto.id}/versiones`, 'operador')).status, 404);

  const { rows: [docx] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre) VALUES ('Hoja.xlsx', 'EXP-F4-XLSX', 'xlsx', 3, 'X') RETURNING id`);
  assert.equal((await subirVersion(docx.id)).cuerpo.codigo, 'formato');
  antes = [await objetos(), antes[1]]; // el documento Secreto añadió su propio objeto

  await del(`/documentos/${doc.id}`, 'admin');
  await sinCambios(subirVersion(doc.id), 404);
  assert.equal((await get(`/documentos/${doc.id}/versiones`)).status, 404);
  await post(`/papelera/${doc.id}/restaurar`, 'admin');
});

test('un documento heredado sin archivo (PDF) recibe su primer original como versión nueva', async () => {
  const { rows: [d] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, version_actual, clasificacion_id, autor_nombre) VALUES ('Acta.pdf', 'EXP-F4-ACTA', 'pdf', 'v3.2', 3, 'X') RETURNING id`);
  await base.pool.query(`INSERT INTO documento_versiones (documento_id, version, comentario) VALUES ($1, 'v3.2', 'Heredada'), ($1, 'v3.1', 'Heredada')`, [d.id]);
  await base.pool.query(`INSERT INTO documento_paginas (documento_id, pagina, texto) VALUES ($1, 1, 'texto de demostración')`, [d.id]);
  const r = await subirVersion(d.id);
  assert.equal(r.cuerpo.version, 'v4.0');
  const doc = await documento(d.id);
  assert.equal(doc.tiene_archivo, true);
  assert.equal((await filas(`SELECT 1 FROM documento_paginas WHERE documento_id = $1`, [d.id])).length, 0, 'el texto de demostración se reemplaza');
  const v32 = (await versionesDb(d.id)).find((v) => v.version === 'v3.2');
  assert.equal((await post(`/documentos/${d.id}/versiones/${v32.id}/restaurar`)).cuerpo.codigo, 'sin_archivo');
  assert.equal((await bytesDe(`/documentos/${d.id}/versiones/${v32.id}/archivo`)).status, 404);
});

// ---------------------------------------------------------------------------------------------- búsqueda
test('búsqueda e indexación siguen a la versión ACTUAL: subir y restaurar reemplazan el texto', async () => {
  const doc = await subirDoc({ texto: 'Clausula ornitorrinco original' });
  await ix.esperarIndexador();
  assert.deepEqual(await buscar('ornitorrinco'), [doc.id]);

  const v2 = await subirVersion(doc.id, { bytes: pdf('Clausula ajolote corregida') });
  assert.equal(v2.status, 201);
  // En la misma transacción se borró el texto viejo: ya no aparece por algo que el documento dejó de decir.
  assert.deepEqual(await buscar('ornitorrinco'), []);
  await ix.esperarIndexador();
  assert.deepEqual(await buscar('ajolote'), [doc.id]);
  assert.deepEqual(await buscar('ornitorrinco'), []);
  const ixFila = await fila(`SELECT estado, motivo, hash_sha256 FROM documento_indexacion WHERE documento_id = $1`, [doc.id]);
  assert.deepEqual([ixFila.estado, ixFila.motivo, ixFila.hash_sha256], ['procesado', 'version', v2.cuerpo.hash]);

  const v1 = (await versionesDb(doc.id))[0];
  await post(`/documentos/${doc.id}/versiones/${v1.id}/restaurar`);
  assert.deepEqual(await buscar('ajolote'), []);
  await ix.esperarIndexador();
  assert.deepEqual(await buscar('ornitorrinco'), [doc.id]);
  assert.deepEqual(await buscar('ajolote'), []);
  assert.equal((await fila(`SELECT motivo FROM documento_indexacion WHERE documento_id = $1`, [doc.id])).motivo, 'restaurar_version');
  const det = await get(`/documentos/${doc.id}`);
  assert.equal(det.cuerpo.version, 'v1.0');
  assert.equal(det.cuerpo.indexacion.estado, 'procesado');
});

// ---------------------------------------------------------------------------------------------- consistencia de versiones
test('si el almacenamiento falla al subir una versión: 502 y nada cambia', async () => {
  const doc = await subirDoc();
  const guardar = st.guardar;
  st.guardar = async () => { throw new Error('R2 no responde (simulado)'); };
  try {
    const antes = await objetos();
    const r = await silenciar(() => subirVersion(doc.id));
    assert.equal(r.status, 502);
    assert.match(r.cuerpo.error, /No se creó la versión/);
    assert.equal((await versionesDb(doc.id)).length, 1);
    assert.equal((await documento(doc.id)).version_actual, 'v1.0');
    assert.equal(await objetos(), antes);
  } finally {
    st.guardar = guardar;
  }
  assert.equal((await cola()).length, 0, 'la intención de subida se descartó');
});

test('si la base falla DESPUÉS de subir la versión: el objeto se borra y no queda nada a medias', async () => {
  const doc = await subirDoc();
  const antes = await objetos();
  await base.pool.query(`CREATE FUNCTION falla_v() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fallo simulado de la base'; END $$ LANGUAGE plpgsql`);
  await base.pool.query(`CREATE TRIGGER falla_v BEFORE INSERT ON documento_versiones FOR EACH ROW EXECUTE FUNCTION falla_v()`);
  try {
    const r = await silenciar(() => subirVersion(doc.id));
    assert.equal(r.status, 500);
  } finally {
    await base.pool.query(`DROP TRIGGER falla_v ON documento_versiones; DROP FUNCTION falla_v()`);
  }
  assert.equal(await objetos(), antes, 'sin huérfanos');
  assert.equal((await versionesDb(doc.id)).length, 1);
  assert.equal((await documento(doc.id)).version_actual, 'v1.0');
  assert.equal((await cola()).length, 0);
});

test('restaurar una versión cuyo objeto falta: 409 y el documento NO pasa a apuntar a un archivo inexistente', async () => {
  const doc = await subirDoc();
  await subirVersion(doc.id);
  const [v1, v2] = await versionesDb(doc.id);
  await st.borrar(v1.storage_path);
  const r = await post(`/documentos/${doc.id}/versiones/${v1.id}/restaurar`);
  assert.equal(r.status, 409);
  assert.equal(r.cuerpo.codigo, 'no_disponible');
  const d = await documento(doc.id);
  assert.deepEqual([d.version_actual, d.storage_path], ['v2.0', v2.storage_path]);
  assert.equal((await auditorias('restaurar_version', doc.id)).length, 0);
});

// ---------------------------------------------------------------------------------------------- papelera
test('eliminar: pasa a la papelera sin borrar nada; desaparece de biblioteca, detalle, búsqueda y archivo', async () => {
  const doc = await subirDoc({ texto: 'Expediente quetzal unico' });
  await ix.esperarIndexador();
  const objetosAntes = await objetos();
  assert.equal((await del(`/documentos/${doc.id}`, 'operador')).status, 403);
  assert.equal((await del(`/documentos/${doc.id}`, 'cumplimiento')).status, 204);
  assert.equal((await del(`/documentos/${doc.id}`, 'cumplimiento')).status, 404, 'ya no está activo');

  const d = await documento(doc.id);
  assert.equal(d.estado, 'papelera');
  assert.equal(d.eliminado_por, ids.cumplimiento);
  assert.ok(d.eliminado_en);
  const dias = (new Date(d.purgar_despues_de) - new Date(d.eliminado_en)) / 86_400_000;
  assert.ok(Math.abs(dias - 30) < 0.01, `purga programada a 30 días (${dias})`);
  assert.equal(await objetos(), objetosAntes, 'el archivo NO se borra');
  assert.ok((await filas(`SELECT 1 FROM documento_paginas WHERE documento_id = $1`, [doc.id])).length, 'el texto se conserva para restaurar');

  assert.ok(!(await get('/documentos')).cuerpo.some((x) => x.id === doc.id));
  assert.equal((await get(`/documentos/${doc.id}`)).status, 404);
  assert.equal((await bytesDe(`/documentos/${doc.id}/archivo`)).status, 404);
  assert.deepEqual(await buscar('quetzal'), []);
  const [a] = await auditorias('eliminar', doc.id);
  assert.equal(a.email, 'cumplimiento@prueba.test');
  assert.ok(a.detalle.purgaAutomatica);
});

test('listar la papelera: solo super-admin y cumplimiento, y solo hasta su nivel', async () => {
  const interno = await subirDoc({ nombre: 'Interno.pdf' });
  const secreto = await subirDoc({ clasificacion: 'Secreto Corporativo', nombre: 'Secreto.pdf' });
  await subirVersion(interno.id);
  await del(`/documentos/${interno.id}`, 'admin');
  await del(`/documentos/${secreto.id}`, 'admin');

  for (const quien of ['operador', 'lector3']) assert.equal((await get('/papelera', quien)).status, 403, quien);
  const admin = await get('/papelera', 'admin');
  assert.equal(admin.status, 200);
  assert.equal(admin.cuerpo.puedePurgar, true);
  assert.equal(admin.cuerpo.diasRetencion, 30);
  assert.ok(admin.cuerpo.borrado);
  const ids_ = admin.cuerpo.documentos.map((x) => x.id);
  assert.ok(ids_.includes(interno.id) && ids_.includes(secreto.id));
  const fila_ = admin.cuerpo.documentos.find((x) => x.id === interno.id);
  assert.equal(fila_.eliminadoPor, 'Usuario admin');
  assert.equal(fila_.versiones, 2);
  assert.match(fila_.eliminadoEn, /(a|p)\. m\.$/);
  assert.match(fila_.purgaAutomatica, /(a|p)\. m\.$/);
  assert.equal(fila_.retencionHasta, null);

  const cumpl = await get('/papelera', 'cumplimiento');
  assert.equal(cumpl.cuerpo.puedePurgar, false);
  assert.equal(cumpl.cuerpo.borrado, null);
  const idsC = cumpl.cuerpo.documentos.map((x) => x.id);
  assert.ok(idsC.includes(interno.id));
  assert.ok(!idsC.includes(secreto.id), 'nivel 3 no ve un documento Secreto ni en la papelera');
  assert.equal((await post(`/papelera/${secreto.id}/restaurar`, 'cumplimiento')).status, 404);
  await post(`/papelera/${secreto.id}/restaurar`, 'admin');
  await post(`/papelera/${interno.id}/restaurar`, 'admin');
});

test('restaurar desde la papelera: vuelve tal cual (archivo, versiones y texto) y queda auditado', async () => {
  const doc = await subirDoc({ texto: 'Informe capibara restaurable' });
  await subirVersion(doc.id, { bytes: pdf('Informe capibara restaurable segunda') });
  await ix.esperarIndexador();
  await del(`/documentos/${doc.id}`, 'admin');
  for (const quien of ['operador', 'lector3']) assert.equal((await post(`/papelera/${doc.id}/restaurar`, quien)).status, 403);

  const r = await post(`/papelera/${doc.id}/restaurar`, 'cumplimiento');
  assert.equal(r.status, 200);
  const d = await documento(doc.id);
  assert.deepEqual([d.estado, d.eliminado_en, d.eliminado_por, d.purgar_despues_de, d.version_actual], ['activo', null, null, null, 'v2.0']);
  assert.deepEqual(await buscar('capibara'), [doc.id]);
  assert.equal((await bytesDe(`/documentos/${doc.id}/archivo`)).status, 200);
  assert.equal((await get(`/documentos/${doc.id}/versiones`)).cuerpo.versiones.length, 2);
  assert.equal((await post(`/papelera/${doc.id}/restaurar`, 'admin')).status, 404, 'ya no está en la papelera');
  const [a] = await auditorias('restaurar_documento', doc.id);
  assert.equal(a.email, 'cumplimiento@prueba.test');
  assert.equal(a.detalle.eliminadoPor, ids.admin);
});

test('purgar: solo super-admin con su código 2FA; borra TODAS las versiones del almacenamiento y deja rastro', async () => {
  const doc = await subirDoc({ texto: 'Acta tapir para purgar' });
  await subirVersion(doc.id);
  await ix.esperarIndexador();
  const claves = (await versionesDb(doc.id)).map((v) => v.storage_path);
  await del(`/documentos/${doc.id}`, 'admin');

  assert.equal((await post(`/papelera/${doc.id}/purgar`, 'cumplimiento', { code: '123456' })).status, 403);
  assert.equal((await post(`/papelera/${doc.id}/purgar`, 'admin', {})).status, 400);
  const mal = await post(`/papelera/${doc.id}/purgar`, 'admin', { code: '000000' });
  assert.equal(mal.status, 403, 'código incorrecto: 403 (la sesión sigue siendo válida)');
  assert.equal((await auditorias('2fa_fallido')).at(-1).detalle.accion, 'purgar_documento');
  assert.equal((await documento(doc.id)).estado, 'papelera');
  // Un super-admin SIN 2FA activo no puede confirmar la purga.
  assert.equal((await post(`/papelera/${doc.id}/purgar`, 'admin3', { code: '123456' })).status, 409);

  const r = await post(`/papelera/${doc.id}/purgar`, 'admin', { code: await codigoAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.versiones, r.cuerpo.objetos], [2, 2]);

  // La base ya no apunta a ningún objeto (lápida) y el contenido indexado desapareció.
  const d = await documento(doc.id);
  assert.deepEqual([d.estado, d.tiene_archivo, d.storage_path, d.storage_driver, d.purgado_por], ['purgado', false, null, null, ids.admin]);
  assert.ok(d.purgado_en);
  assert.equal(d.hash_sha256, (await versionesDb(doc.id))[1].hash_sha256, 'la huella queda como evidencia');
  assert.ok((await versionesDb(doc.id)).every((v) => v.storage_path === null));
  assert.equal((await filas(`SELECT 1 FROM documento_paginas WHERE documento_id = $1`, [doc.id])).length, 0);
  assert.equal((await filas(`SELECT 1 FROM documento_indexacion WHERE documento_id = $1`, [doc.id])).length, 0);

  // Los objetos se borran después de responder (cola de borrado).
  await pap.esperarMantenimiento();
  for (const c of claves) assert.equal(await existe(c), false, c);
  assert.equal((await cola()).length, 0);
  const [p] = await auditorias('purgar_documento', doc.id);
  assert.equal(p.email, 'admin@prueba.test');
  assert.deepEqual([p.detalle.motivo, p.detalle.objetos, p.detalle.segundoFactor], ['manual', 2, 'totp']);
  assert.deepEqual(p.detalle.versiones.map((v) => v.version), ['v1.0', 'v2.0']);
  assert.ok(!JSON.stringify(p.detalle).includes('docs/'), 'sin claves de objeto en la purga');
  const borrados = await auditorias('borrar_objeto', doc.id);
  assert.deepEqual(borrados.map((b) => b.detalle.clave).sort(), [...claves].sort());
  assert.ok(borrados.every((b) => b.usuario_id === null && b.detalle.motivo === 'purga'));

  // Purgado = no existe para nadie y no se puede restaurar; la auditoría del documento sigue disponible.
  assert.equal((await get(`/documentos/${doc.id}`)).status, 404);
  assert.equal((await post(`/papelera/${doc.id}/restaurar`, 'admin')).status, 404);
  assert.equal((await post(`/papelera/${doc.id}/purgar`, 'admin', { code: await codigoAdmin() })).status, 404);
  assert.ok(!(await get('/papelera')).cuerpo.documentos.some((x) => x.id === doc.id));
  assert.ok((await get(`/documentos/${doc.id}/auditoria`)).cuerpo.some((x) => x.accion === 'purgar_documento'));
  assert.deepEqual(await buscar('tapir'), []);
});

test('purgar con un código de recuperación también vale (y se gasta)', async () => {
  const { generarCodigosRecuperacion } = await import('../src/lib/mfa.js');
  const [codigo] = await generarCodigosRecuperacion(ids.admin);
  const doc = await subirDoc();
  await del(`/documentos/${doc.id}`, 'admin');
  assert.equal((await post(`/papelera/${doc.id}/purgar`, 'admin', { codigoRecuperacion: codigo })).status, 200);
  const otro = await subirDoc();
  await del(`/documentos/${otro.id}`, 'admin');
  assert.equal((await post(`/papelera/${otro.id}/purgar`, 'admin', { codigoRecuperacion: codigo })).status, 403, 'un solo uso');
  await pap.esperarMantenimiento();
});

test('si el almacenamiento falla al purgar: la base queda consistente y los objetos se borran al reintentar', async () => {
  const doc = await subirDoc();
  const clave = (await documento(doc.id)).storage_path;
  await del(`/documentos/${doc.id}`, 'admin');
  const borrar = st.borrar;
  st.borrar = async () => { throw new Error('R2 no responde (simulado)'); };
  try {
    const r = await silenciar(async () => {
      const x = await post(`/papelera/${doc.id}/purgar`, 'admin', { code: await codigoAdmin() });
      await pap.esperarMantenimiento();
      return x;
    });
    assert.equal(r.status, 200);
  } finally {
    st.borrar = borrar;
  }
  // Base: purgado, sin referencias. Almacenamiento: el objeto sigue, pero APUNTADO en la cola con su error.
  assert.equal((await documento(doc.id)).estado, 'purgado');
  assert.equal(await existe(clave), true);
  const [f] = await cola();
  assert.deepEqual([f.clave, f.motivo, f.intentos], [clave, 'purga', 1]);
  assert.match(f.ultimo_error, /simulado/);
  assert.ok(new Date(f.no_antes_de) > new Date(), 'reintento con espera');

  // Más tarde (se adelanta el reloj de la fila) el mantenimiento lo reintenta y lo consigue.
  await base.pool.query(`UPDATE objetos_por_borrar SET no_antes_de = now() - interval '1 second'`);
  pap.despertarMantenimiento();
  await pap.esperarMantenimiento();
  assert.equal(await existe(clave), false);
  assert.equal((await cola()).length, 0);
  assert.equal((await auditorias('borrar_objeto', doc.id))[0].detalle.intentos, 2);
});

test('retención legal vigente: no se purga ni a mano ni al vaciar ni automáticamente', async () => {
  const doc = await subirDoc();
  await base.pool.query(`UPDATE documentos SET vence_retencion = current_date + 400 WHERE id = $1`, [doc.id]);
  await del(`/documentos/${doc.id}`, 'admin');
  const lista = (await get('/papelera')).cuerpo.documentos.find((x) => x.id === doc.id);
  assert.match(lista.retencionHasta, /^\d{2} \w{3} \d{4}$/);
  assert.equal(lista.purgaAutomatica, null);

  const r = await post(`/papelera/${doc.id}/purgar`, 'admin', { code: '000000' });
  assert.equal(r.status, 409, 'se responde ANTES de pedir el código: no cuenta como fallo');
  assert.equal(r.cuerpo.codigo, 'retencion');
  await base.pool.query(`UPDATE documentos SET purgar_despues_de = now() - interval '1 day' WHERE id = $1`, [doc.id]);
  pap.despertarMantenimiento();
  await pap.esperarMantenimiento();
  assert.equal((await documento(doc.id)).estado, 'papelera');
  await post(`/papelera/${doc.id}/restaurar`, 'admin');
});

test('purga automática por retención: al vencer el plazo se purga sola (auditada como Sistema); 0 días la desactiva', async () => {
  const doc = await subirDoc();
  const clave = (await documento(doc.id)).storage_path;
  await del(`/documentos/${doc.id}`, 'admin');
  await base.pool.query(`UPDATE documentos SET purgar_despues_de = now() - interval '1 minute' WHERE id = $1`, [doc.id]);

  pap.configurarPapelera({ diasRetencion: 0 });
  pap.despertarMantenimiento();
  await pap.esperarMantenimiento();
  assert.equal((await documento(doc.id)).estado, 'papelera', 'con 0 días no hay purga automática');
  assert.equal((await get('/papelera')).cuerpo.documentos.find((x) => x.id === doc.id).purgaAutomatica, null);

  pap.configurarPapelera({ diasRetencion: 30 });
  assert.equal((await get('/papelera')).status, 200); // abrir la papelera despierta el mantenimiento (Render dormido)
  await pap.esperarMantenimiento();
  const d = await documento(doc.id);
  assert.deepEqual([d.estado, d.purgado_por], ['purgado', null]);
  assert.equal(await existe(clave), false);
  const [p] = await auditorias('purgar_documento', doc.id);
  assert.deepEqual([p.usuario_id, p.detalle.motivo], [null, 'retencion']);

  // Con la retención desactivada al eliminar, el plazo cuenta desde eliminado_en si luego se activa.
  pap.configurarPapelera({ diasRetencion: 0 });
  const otro = await subirDoc();
  await del(`/documentos/${otro.id}`, 'admin');
  assert.equal((await documento(otro.id)).purgar_despues_de, null);
  await base.pool.query(`UPDATE documentos SET eliminado_en = now() - interval '31 days' WHERE id = $1`, [otro.id]);
  pap.configurarPapelera({ diasRetencion: 30 });
  await pap.purgarVencidos();
  assert.equal((await documento(otro.id)).estado, 'purgado');
  await pap.esperarMantenimiento();
});

test('vaciar la papelera: purga todo lo purgable con un solo código; respeta nivel y retención', async () => {
  // Se parte de una papelera vacía (lo que dejaron otras pruebas se restaura).
  for (const x of (await get('/papelera')).cuerpo.documentos) await post(`/papelera/${x.id}/restaurar`, 'admin');
  assert.equal((await post('/papelera/vaciar', 'admin', { code: '000000' })).cuerpo.codigo, 'nada_que_purgar');

  const a = await subirDoc();
  const b = await subirDoc();
  const retenido = await subirDoc();
  const secreto = await subirDoc({ clasificacion: 'Secreto Corporativo' });
  await base.pool.query(`UPDATE documentos SET vence_retencion = current_date + 10 WHERE id = $1`, [retenido.id]);
  for (const d of [a, b, retenido, secreto]) await del(`/documentos/${d.id}`, 'admin');

  assert.equal((await post('/papelera/vaciar', 'cumplimiento', { code: '123456' })).status, 403);
  assert.equal((await post('/papelera/vaciar', 'admin', { code: '000000' })).status, 403);
  const r = await post('/papelera/vaciar', 'admin', { code: await codigoAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.purgados, r.cuerpo.enRetencion, r.cuerpo.restantes], [3, 1, 0]);
  for (const d of [a, b, secreto]) assert.equal((await documento(d.id)).estado, 'purgado');
  assert.equal((await documento(retenido.id)).estado, 'papelera');
  const [v] = await auditorias('vaciar_papelera');
  assert.equal(v.detalle.purgados, 3);
  assert.equal((await auditorias('purgar_documento', a.id))[0].detalle.motivo, 'vaciar');
  await pap.esperarMantenimiento();
  assert.equal((await cola()).length, 0);
  await post(`/papelera/${retenido.id}/restaurar`, 'admin');
});

test('vaciar como super-admin de nivel 3: no alcanza (ni purga) lo Secreto', async () => {
  const { cifrarSecreto } = await import('../src/lib/cifrado-mfa.js');
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2 WHERE id = $1`, [ids.admin3, cifrarSecreto(SECRETO_ADMIN, ids.admin3)]);
  const secreto = await subirDoc({ clasificacion: 'Secreto Corporativo' });
  const interno = await subirDoc();
  await del(`/documentos/${secreto.id}`, 'admin');
  await del(`/documentos/${interno.id}`, 'admin');
  const r = await post('/papelera/vaciar', 'admin3', { code: totp.codigoPara(SECRETO_ADMIN, Date.now()) });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.purgados, 1);
  assert.equal((await documento(secreto.id)).estado, 'papelera');
  assert.equal((await documento(interno.id)).estado, 'purgado');
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = NULL WHERE id = $1`, [ids.admin3]);
  await post(`/papelera/${secreto.id}/restaurar`, 'admin');
  await pap.esperarMantenimiento();
});

// ---------------------------------------------------------------------------------------------- huérfanos
test('subida interrumpida (el proceso murió entre subir y guardar la fila): el objeto huérfano se borra pasado el plazo', async () => {
  const clave = 'docs/987654/987654/00000000-0000-4000-8000-000000000000.pdf';
  await st.guardar(clave, pdf());
  await pap.registrarIntencionSubida(clave, 'local');
  // Dentro del plazo no se toca (podría ser una subida en curso).
  pap.despertarMantenimiento();
  await pap.esperarMantenimiento();
  assert.equal(await existe(clave), true);
  await base.pool.query(`UPDATE objetos_por_borrar SET no_antes_de = now() - interval '1 second' WHERE clave = $1`, [clave]);
  pap.despertarMantenimiento();
  await pap.esperarMantenimiento();
  assert.equal(await existe(clave), false);
  assert.equal((await cola()).length, 0);
  assert.equal((await auditorias('borrar_objeto')).at(-1).detalle.motivo, 'subida_en_curso');
});

test('guarda final: una fila de la cola cuya clave está EN USO nunca borra el objeto', async () => {
  const doc = await subirDoc();
  const clave = (await documento(doc.id)).storage_path;
  await base.pool.query(`INSERT INTO objetos_por_borrar (clave, storage_driver, motivo) VALUES ($1, 'local', 'purga')`, [clave]);
  await silenciar(async () => {
    pap.despertarMantenimiento();
    await pap.esperarMantenimiento();
  });
  assert.equal(await existe(clave), true);
  assert.equal((await cola()).length, 0);
  assert.equal((await bytesDe(`/documentos/${doc.id}/archivo`)).status, 200);
});

test('una fila de otro driver (datos copiados de producción) no se toca desde este entorno', async () => {
  await base.pool.query(`INSERT INTO objetos_por_borrar (clave, storage_driver, motivo) VALUES ('docs/1/1/x.pdf', 'r2', 'purga')`);
  pap.despertarMantenimiento();
  await pap.esperarMantenimiento();
  const [f] = await cola();
  assert.deepEqual([f.storage_driver, f.intentos], ['r2', 0]);
  assert.deepEqual((await get('/papelera')).cuerpo.borrado, { pendientes: 0, con_error: 0 }, 'el resumen cuenta solo el driver actual');
  await base.pool.query(`DELETE FROM objetos_por_borrar`);
});

test('detalle: expone los permisos de versiones y papelera según el rol', async () => {
  const doc = await subirDoc();
  const ver = async (quien) => {
    const { cuerpo } = await get(`/documentos/${doc.id}`, quien);
    return [cuerpo.puedeGestionarVersiones, cuerpo.puedeEliminar];
  };
  assert.deepEqual(await ver('admin'), [true, true]);
  assert.deepEqual(await ver('operador'), [true, false]);
  assert.deepEqual(await ver('cumplimiento'), [false, true]);
  assert.deepEqual(await ver('lector3'), [false, false]);
});
