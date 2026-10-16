/**
 * Fase 1 de punta a punta: la app de Express REAL (crearApp) contra PostgreSQL en un esquema temporal y el
 * driver de almacenamiento "local" en una carpeta temporal. Las peticiones son HTTP de verdad (fetch).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { crearPdf, sha256 } from './helpers/pdf-prueba.js';

// Antes de importar config.js (valida al cargarse). dotenv no pisa lo que ya está definido.
process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.MAX_UPLOAD_MB = '1';
process.env.STORAGE_DRIVER = 'local';

const MB = 1024 * 1024;
let base, servidor, url, raiz, raizRota, st, db, storage;
const tokens = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  const { aplicarMigraciones } = await import('../src/migrate.js');
  await aplicarMigraciones(base.pool, { log: () => {} });

  storage = await import('../src/lib/storage.js');
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-archivos-'));
  raizRota = path.join(raiz, 'no-soy-carpeta');
  await fs.writeFile(raizRota, 'x'); // una raíz que es un ARCHIVO: cualquier guardar() falla
  st = await storage.inicializarAlmacenamiento({ driver: 'local', raiz: path.join(raiz, 'objetos') });

  const { firmarToken } = await import('../src/middleware/auth.js');
  // rol, nivel (rango): super-admin 5, compliance 3, ocr-operator 2, read-only 3 y read-only 2
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'],
    ['cumplimiento', 'compliance', 'Nivel 3 Alto'],
    ['operador', 'ocr-operator', 'Nivel 2 Auditoría'],
    ['lector3', 'read-only', 'Nivel 3 Restringido'],
    ['lector2', 'read-only', 'Nivel 2 Confidencial'],
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
  await new Promise((r) => servidor?.close(r));
  await db?.pool.end();
  await base?.cerrar();
  await fs.rm(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------- utilidades
const auth = (quien) => ({ Authorization: `Bearer ${tokens[quien]}` });

function formulario(bytes, { nombre = 'Contrato.pdf', tipo = 'application/pdf', ...campos } = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ clasificacion: 'Uso Interno General', ...campos })) if (v !== undefined) f.append(k, v);
  if (bytes) f.append('archivo', new Blob([bytes], { type: tipo }), nombre);
  return f;
}
const subir = (quien, bytes, opciones) =>
  fetch(`${url}/digitalizacion/documentos`, { method: 'POST', headers: auth(quien), body: formulario(bytes, opciones) });

// Con relleno: el Buffer tiene su propio ArrayBuffer (como un PDF real), no el bloque compartido de Node.
async function subirOk(opciones = {}, quien = 'operador', bytes = crearPdf({ paginas: 3, relleno: 64 * 1024 })) {
  const r = await subir(quien, bytes, opciones);
  const cuerpo = await r.json();
  assert.equal(r.status, 201, JSON.stringify(cuerpo));
  return { ...cuerpo, bytes };
}

const contar = async (sql, params = []) => (await base.pool.query(sql, params)).rows[0].n;
const documentos = () => contar(`SELECT count(*)::int AS n FROM documentos`);
async function objetos() {
  const dir = path.join(raiz, 'objetos');
  const lista = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return lista.filter((e) => e.isFile()).length;
}
const auditorias = (accion, docId) =>
  base.pool.query(`SELECT a.detalle, u.email FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
                    WHERE a.accion = $1 AND a.documento_id = $2 ORDER BY a.id`, [accion, docId]).then((r) => r.rows);

/** Comprueba que una subida rechazada no dejó ni fila ni objeto. */
async function sinRastro(promesa, status, mensaje) {
  const [antesDocs, antesObj] = [await documentos(), await objetos()];
  const r = await promesa;
  const cuerpo = await r.json();
  assert.equal(r.status, status, JSON.stringify(cuerpo));
  if (mensaje) assert.match(cuerpo.error, mensaje);
  assert.equal(await documentos(), antesDocs, 'no debe crearse la fila');
  assert.equal(await objetos(), antesObj, 'no debe quedar ningún objeto');
  return cuerpo;
}

// ---------------------------------------------------------------------------------------------- subida
test('subida válida: hash SHA-256, tamaño y páginas reales; clave generada por el servidor; auditada', async () => {
  const doc = await subirOk({ nombre: '../../C:\\fakepath\\Contrato <Marco> Ñandú\u202E.pdf', folio: 'EXP-2026-PR-001', departamento: 'Legal' });
  assert.equal(doc.hash, sha256(doc.bytes));
  assert.equal(doc.tamanoBytes, doc.bytes.length);
  assert.equal(doc.paginas, 3);
  assert.equal(doc.nombreOriginal, 'Contrato _Marco_ Ñandú.pdf');

  const { rows: [r] } = await base.pool.query(`SELECT * FROM documentos WHERE id = $1`, [doc.id]);
  assert.equal(r.tiene_archivo, true);
  assert.equal(r.storage_driver, 'local');
  assert.equal(r.cifrado_aes, false); // local no cifra; solo r2
  assert.equal(r.hash_sha256, doc.hash);
  assert.equal(Number(r.tamano_bytes), doc.bytes.length);
  assert.equal(r.paginas, 3);
  assert.equal(r.folio, 'EXP-2026-PR-001');
  assert.match(r.storage_path, new RegExp(`^docs/${doc.id}/\\d+/[0-9a-f-]{36}\\.pdf$`)); // nada del nombre del usuario
  const { rows: [v] } = await base.pool.query(`SELECT * FROM documento_versiones WHERE documento_id = $1`, [doc.id]);
  assert.equal(v.storage_path, r.storage_path);
  assert.equal(v.hash_sha256, doc.hash);
  assert.deepEqual(await (await st.leer(r.storage_path)).stream.toArray().then(Buffer.concat), doc.bytes);

  const [a] = await auditorias('subir_documento', doc.id);
  assert.equal(a.email, 'operador@prueba.test');
  assert.equal(a.detalle.sha256, doc.hash);
});

test('sin folio se genera uno; sin título se usa el nombre original', async () => {
  const doc = await subirOk({ nombre: 'informe anual.pdf' });
  assert.equal(doc.folio, `EXP-${new Date().getFullYear()}-DIG-${doc.id}`);
  assert.equal(doc.nombre, 'informe anual.pdf');
});

test('rechaza un archivo que no es PDF (texto plano)', () =>
  sinRastro(subir('operador', Buffer.from('hola, soy un .txt'), { nombre: 'notas.txt', tipo: 'text/plain' }), 415, /no es un PDF/));

test('rechaza una extensión falsa: PNG renombrado a .pdf con Content-Type application/pdf', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  return sinRastro(subir('operador', png, { nombre: 'factura.pdf' }), 415, /firma "%PDF-"/);
});

test('rechaza un PDF que supera MAX_UPLOAD_MB (1 MB en la prueba)', () =>
  sinRastro(subir('operador', crearPdf({ relleno: 1.2 * MB })), 413, /tamaño máximo/));

test('rechaza un PDF protegido con contraseña con un mensaje claro', async () => {
  const c = await sinRastro(subir('operador', crearPdf({ protegido: true })), 422, /protegido con contraseña/);
  assert.equal(c.codigo, 'protegido');
});

test('rechaza un archivo con firma %PDF- que no se puede abrir', async () => {
  const c = await sinRastro(subir('operador', Buffer.from('%PDF-1.7\nesto no es un pdf de verdad\n')), 422, /no se pudo abrir/);
  assert.equal(c.codigo, 'invalido');
});

test('rechaza peticiones sin archivo, sin multipart o con dos archivos', async () => {
  await sinRastro(subir('operador', null), 400, /No se recibió ningún archivo/);
  await sinRastro(fetch(`${url}/digitalizacion/documentos`, {
    method: 'POST', headers: { ...auth('operador'), 'Content-Type': 'application/json' }, body: '{}',
  }), 415, /multipart/);
  const f = formulario(crearPdf());
  f.append('archivo', new Blob([crearPdf()]), 'otro.pdf');
  await sinRastro(fetch(`${url}/digitalizacion/documentos`, { method: 'POST', headers: auth('operador'), body: f }), 400, /único archivo/);
});

test('metadatos: clasificación obligatoria, existente y no superior al nivel de quien sube; folio único', async () => {
  await sinRastro(subir('operador', crearPdf(), { clasificacion: '' }), 400, /clasificación es obligatoria/);
  await sinRastro(subir('operador', crearPdf(), { clasificacion: 'Inventada' }), 400, /no existe/);
  await sinRastro(subir('operador', crearPdf(), { clasificacion: 'Secreto Corporativo' }), 403, /por encima de tu nivel/);
  await sinRastro(subir('operador', crearPdf(), { departamento: 'Nada' }), 400, /departamento/);
  await sinRastro(subir('operador', crearPdf(), { folio: 'a' }), 400, /Folio no válido/);
  await subirOk({ folio: 'EXP-UNICO-1' });
  await sinRastro(subir('operador', crearPdf(), { folio: 'EXP-UNICO-1' }), 409, /folio/);
});

test('solo super-admin y operador OCR pueden subir', async () => {
  for (const quien of ['lector3', 'cumplimiento']) await sinRastro(subir(quien, crearPdf()), 403);
  await subirOk({}, 'admin');
});

// ---------------------------------------------------------------------------------------------- huérfanos
test('si la base falla DESPUÉS de subir, el objeto se borra (sin huérfanos)', async () => {
  await base.pool.query(`CREATE FUNCTION falla_version() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fallo simulado de la base'; END $$ LANGUAGE plpgsql`);
  await base.pool.query(`CREATE TRIGGER falla_version BEFORE INSERT ON documento_versiones FOR EACH ROW EXECUTE FUNCTION falla_version()`);
  const errorOriginal = console.error;
  console.error = () => {}; // el 500 se registra en consola; aquí es esperado
  try {
    await sinRastro(subir('operador', crearPdf()), 500);
  } finally {
    console.error = errorOriginal;
    await base.pool.query(`DROP TRIGGER falla_version ON documento_versiones; DROP FUNCTION falla_version()`);
  }
});

test('si el almacenamiento falla, no se crea la fila', async () => {
  await storage.inicializarAlmacenamiento({ driver: 'local', raiz: raizRota });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    await sinRastro(subir('operador', crearPdf()), 502, /No se creó el documento/);
  } finally {
    console.error = errorOriginal;
    st = await storage.inicializarAlmacenamiento({ driver: 'local', raiz: path.join(raiz, 'objetos') });
  }
});

// ---------------------------------------------------------------------------------------------- ver y descargar
test('ver inline y descargar: cabeceras correctas, bytes exactos y cada acceso auditado', async () => {
  const doc = await subirOk({ nombre: 'Póliza 2026.pdf' });
  for (const [ruta, tipo, accion] of [['archivo', 'inline', 'ver_archivo'], ['descarga', 'attachment', 'descargar']]) {
    const r = await fetch(`${url}/documentos/${doc.id}/${ruta}`, { headers: auth('lector2') });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-disposition'), `${tipo}; filename="Poliza 2026.pdf"; filename*=UTF-8''P%C3%B3liza%202026.pdf`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(Number(r.headers.get('content-length')), doc.bytes.length);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), doc.bytes);
    const registros = await auditorias(accion, doc.id);
    assert.equal(registros.length, 1);
    assert.equal(registros[0].email, 'lector2@prueba.test');
  }
});

test('Range: 206 con Content-Range, sufijo "-n" y 416 si no se puede satisfacer', async () => {
  const doc = await subirOk();
  const pedir = (range) => fetch(`${url}/documentos/${doc.id}/archivo`, { headers: { ...auth('operador'), Range: range } });

  let r = await pedir('bytes=0-9');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-9/${doc.bytes.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), doc.bytes.subarray(0, 10));

  r = await pedir('bytes=-6');
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), doc.bytes.subarray(-6));

  r = await pedir(`bytes=${doc.bytes.length}-`);
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), `bytes */${doc.bytes.length}`);

  r = await pedir('bytes=0-1,5-6'); // varios rangos: se ignora y va completo
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, doc.bytes.length);
  // Cada petición, parcial o no, queda auditada (con el rango en el detalle).
  const registros = await auditorias('ver_archivo', doc.id);
  assert.equal(registros.length, 3);
  assert.equal(registros[0].detalle.rango, '0-9');
});

test('objeto inexistente: 404 "Archivo no disponible en este entorno", nunca 500', async () => {
  const doc = await subirOk();
  const { rows: [r] } = await base.pool.query(`SELECT storage_path FROM documentos WHERE id = $1`, [doc.id]);
  await st.borrar(r.storage_path);
  for (const ruta of ['archivo', 'descarga']) {
    const resp = await fetch(`${url}/documentos/${doc.id}/${ruta}`, { headers: auth('admin') });
    assert.equal(resp.status, 404);
    assert.deepEqual(await resp.json(), { error: 'Archivo no disponible en este entorno', codigo: 'no_disponible' });
  }
  // Subido con otro driver (dev con datos copiados de producción): tampoco está aquí.
  await base.pool.query(`UPDATE documentos SET storage_driver = 'r2' WHERE id = $1`, [doc.id]);
  const resp = await fetch(`${url}/documentos/${doc.id}/archivo`, { headers: auth('admin') });
  assert.equal(resp.status, 404);
  assert.equal((await resp.json()).codigo, 'no_disponible');
});

test('documento sin archivo (seed/heredado): 404 claro con código sin_archivo', async () => {
  const { rows: [d] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, storage_path)
     VALUES ('Demo.pdf', 'EXP-DEMO-1', 'pdf', (SELECT id FROM clasificaciones WHERE nombre = 'Uso Interno General'), 'Demo', 'demo/EXP-DEMO-1/v1')
     RETURNING id`);
  const r = await fetch(`${url}/documentos/${d.id}/archivo`, { headers: auth('admin') });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).codigo, 'sin_archivo');
  const det = await (await fetch(`${url}/documentos/${d.id}`, { headers: auth('admin') })).json();
  assert.equal(det.tieneArchivo, false);
  assert.equal(det.archivo, null);
  assert.equal(det.puedeVerificar, false);
  assert.equal(det.cifrado, false);
});

test('control de acceso por nivel: quien no alcanza el nivel recibe 404 (ni siquiera sabe que existe)', async () => {
  const secreto = await subirOk({ clasificacion: 'Secreto Corporativo' }, 'admin');
  const confidencial = await subirOk({ clasificacion: 'Confidencial Nivel 2' }, 'admin');
  for (const ruta of ['archivo', 'descarga']) {
    for (const quien of ['cumplimiento', 'lector3', 'lector2', 'operador'])
      assert.equal((await fetch(`${url}/documentos/${secreto.id}/${ruta}`, { headers: auth(quien) })).status, 404, `${quien} ${ruta}`);
    assert.equal((await fetch(`${url}/documentos/${secreto.id}/${ruta}`, { headers: auth('admin') })).status, 200);
    assert.equal((await fetch(`${url}/documentos/${confidencial.id}/${ruta}`, { headers: auth('lector2') })).status, 200);
  }
  assert.equal((await fetch(`${url}/documentos/${secreto.id}/archivo`)).status, 401); // sin sesión
  assert.equal((await auditorias('ver_archivo', secreto.id)).length, 1); // solo el acceso permitido
  await base.pool.query(`UPDATE documentos SET estado = 'papelera' WHERE id = $1`, [confidencial.id]);
  assert.equal((await fetch(`${url}/documentos/${confidencial.id}/archivo`, { headers: auth('admin') })).status, 404);
});

test('detalle: expone archivo, tamaño, páginas y si el usuario puede verificar', async () => {
  const doc = await subirOk({ nombre: 'detalle.pdf' });
  const det = await (await fetch(`${url}/documentos/${doc.id}`, { headers: auth('cumplimiento') })).json();
  assert.equal(det.tieneArchivo, true);
  assert.deepEqual(det.archivo, { nombreOriginal: 'detalle.pdf', tamanoBytes: doc.bytes.length, almacenamiento: 'local', cifradoEnReposo: false });
  assert.equal(det.hash, doc.hash);
  assert.equal(det.paginas, 3);
  assert.equal(det.puedeVerificar, true);
  const lector = await (await fetch(`${url}/documentos/${doc.id}`, { headers: auth('lector2') })).json();
  assert.equal(lector.puedeVerificar, false);
});

// ---------------------------------------------------------------------------------------------- integridad
test('verificar integridad: íntegro, alterado y no disponible; todo auditado', async () => {
  const doc = await subirOk();
  const verificar = (quien) => fetch(`${url}/documentos/${doc.id}/verificar-integridad`, { method: 'POST', headers: auth(quien) });

  let r = await verificar('cumplimiento');
  let c = await r.json();
  assert.equal(r.status, 200);
  assert.equal(c.integro, true);
  assert.equal(c.hashCalculado, doc.hash);
  assert.equal(c.tamanoCalculado, doc.bytes.length);

  // Alguien modifica el objeto "por detrás" (mismo tamaño, un byte distinto).
  const { rows: [d] } = await base.pool.query(`SELECT storage_path FROM documentos WHERE id = $1`, [doc.id]);
  const alterado = Buffer.from(doc.bytes);
  alterado[alterado.length - 2] ^= 0xff;
  await st.guardar(d.storage_path, alterado);
  r = await verificar('admin');
  c = await r.json();
  assert.equal(c.integro, false);
  assert.equal(c.hashEsperado, doc.hash);
  assert.equal(c.hashCalculado, sha256(alterado));

  await st.borrar(d.storage_path);
  r = await verificar('admin');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'Archivo no disponible en este entorno');

  assert.deepEqual((await auditorias('verificar_integridad', doc.id)).map((a) => a.detalle.resultado), ['integro', 'alterado', 'no_disponible']);
  const det = await (await fetch(`${url}/documentos/${doc.id}`, { headers: auth('admin') })).json();
  assert.equal(det.ultimaVerificacion.resultado, 'no_disponible');
});

test('verificar integridad: permisos (solo super-admin y cumplimiento, y respetando el nivel)', async () => {
  const doc = await subirOk();
  const secreto = await subirOk({ clasificacion: 'Secreto Corporativo' }, 'admin');
  const verificar = (id, quien) => fetch(`${url}/documentos/${id}/verificar-integridad`, { method: 'POST', headers: auth(quien) });
  for (const quien of ['operador', 'lector3', 'lector2']) assert.equal((await verificar(doc.id, quien)).status, 403, quien);
  assert.equal((await verificar(secreto.id, 'cumplimiento')).status, 404); // nivel 3 < 5
  assert.equal((await verificar(secreto.id, 'admin')).status, 200);
  assert.equal((await auditorias('verificar_integridad', doc.id)).length, 0);
});

test('verificar integridad de un documento sin archivo: 409', async () => {
  const { rows: [d] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre) VALUES ('Sin.pdf', 'EXP-SIN-1', 'pdf', 3, 'X') RETURNING id`);
  const r = await fetch(`${url}/documentos/${d.id}/verificar-integridad`, { method: 'POST', headers: auth('admin') });
  assert.equal(r.status, 409);
});

test('catálogos: límite de subida y clasificaciones permitidas según el nivel del usuario', async () => {
  const c = await (await fetch(`${url}/catalogos`, { headers: auth('operador') })).json();
  assert.deepEqual(c.subida, { maxMb: 1 });
  assert.deepEqual(Object.fromEntries(c.clasificaciones.map((x) => [x.nombre, x.permitida])),
    { 'Secreto Corporativo': false, 'Confidencial Nivel 2': true, 'Uso Interno General': true });
});
