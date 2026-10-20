/**
 * Fase 6 de punta a punta (la app REAL por HTTP contra PostgreSQL en un esquema temporal): carpetas y subcarpetas
 * hasta 5 niveles, nombre único por carpeta padre, migas de pan, explorador con conteos por nivel de acceso, mover
 * carpetas (sin ciclos ni exceso de profundidad), eliminar solo vacías, biblioteca y búsqueda con la ruta, permisos,
 * auditoría y notificaciones (sin nombres de documentos).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crearBaseDePrueba } from './helpers/base-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.STORAGE_DRIVER = 'local';

let base, servidor, url, db, raiz, pap;
const tokens = {};
const ids = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  await (await import('../src/migrate.js')).aplicarMigraciones(base.pool, { log: () => {} });
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase6-'));
  await (await import('../src/lib/storage.js')).inicializarAlmacenamiento({ driver: 'local', raiz });
  pap = await import('../src/lib/papelera.js');
  const { firmarToken } = await import('../src/middleware/auth.js');
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'],
    ['operador', 'ocr-operator', 'Nivel 2 Auditoría'],
    ['cumplimiento', 'compliance', 'Nivel 3 Alto'],
    ['lector2', 'read-only', 'Nivel 2 Confidencial'],
  ]) {
    const { rows: [u] } = await base.pool.query(
      `INSERT INTO usuarios (nombre, email, rol_id, nivel_id)
       VALUES ($1, $2, (SELECT id FROM roles WHERE clave = $3), (SELECT id FROM niveles_acceso WHERE nombre = $4)) RETURNING id`,
      [`Usuario ${clave}`, `${clave}@prueba.test`, rol, nivel]);
    ids[clave] = String(u.id);
    tokens[clave] = firmarToken({ sub: String(u.id) }, 'access', '1h');
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
async function pedir(metodo, ruta, quien = 'admin', cuerpo) {
  const r = await fetch(`${url}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${tokens[quien]}`, ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
}
const get = (ruta, quien) => pedir('GET', ruta, quien);
const post = (ruta, quien, cuerpo) => pedir('POST', ruta, quien, cuerpo);
const patch = (ruta, quien, cuerpo) => pedir('PATCH', ruta, quien, cuerpo);
const del = (ruta, quien) => pedir('DELETE', ruta, quien);
const fila = async (sql, params) => (await base.pool.query(sql, params)).rows[0];
const filas = async (sql, params) => (await base.pool.query(sql, params)).rows;
const nombres = (r) => r.cuerpo.documentos.map((d) => d.name).sort();
const biblioteca = (qs, quien) => get(`/documentos?${new URLSearchParams(qs)}`, quien);
const crear = async (nombre, padreId, quien = 'admin') => {
  const r = await post('/carpetas', quien, padreId === undefined ? { nombre } : { nombre, padreId });
  assert.equal(r.status, 201, `${nombre}: ${JSON.stringify(r.cuerpo)}`);
  return r.cuerpo.id;
};
const nombresRuta = (ruta) => ruta.map((c) => c.nombre).join(' › ');

let folios = 0;
async function crearDoc({ nombre, clasif = 'Uso Interno General', carpeta = null, estado = 'activo' }) {
  const { rows: [d] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, estado, carpeta_id, actualizado_en)
     VALUES ($1, $2, 'pdf', (SELECT id FROM clasificaciones WHERE nombre = $3), 'Autor', $4, $5, now() - interval '3 days')
     RETURNING id`, [nombre, `EXP-F6-${++folios}`, clasif, estado, carpeta]);
  return String(d.id);
}
const auditorias = (accion) =>
  filas(`SELECT a.detalle, a.documento_id, u.email FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id WHERE a.accion = $1 ORDER BY a.id`, [accion]);
const notifsPara = (quien, patron) =>
  filas(`SELECT titulo, descripcion, documento_id FROM notificaciones WHERE usuario_id = $1 AND titulo LIKE $2 ORDER BY id`, [ids[quien], patron]);

// ---------------------------------------------------------------------------------------------- crear
const c = {};
test('crear anidadas hasta 5 niveles; la 6.ª → 400 (profundidad); padre inexistente 404 y no válido 400', async () => {
  c.legal = await crear('Legal');
  c.l2024 = await crear('2024', c.legal, 'operador');
  c.n3 = await crear('Contratos', c.l2024);
  c.n4 = await crear('Proveedores', c.n3);
  c.n5 = await crear('Cloud', c.n4);
  const sexta = await post('/carpetas', 'admin', { nombre: 'Demasiado', padreId: c.n5 });
  assert.equal(sexta.status, 400);
  assert.equal(sexta.cuerpo.codigo, 'profundidad');
  assert.match(sexta.cuerpo.error, /como máximo 5 niveles/);
  assert.equal(await fila(`SELECT 1 FROM carpetas WHERE nombre = 'Demasiado'`), undefined);

  assert.equal((await post('/carpetas', 'admin', { nombre: 'Huérfana', padreId: '999999' })).status, 404);
  for (const padreId of ['abc', -1, { id: 1 }, true]) assert.equal((await post('/carpetas', 'admin', { nombre: 'Rara', padreId })).status, 400, String(padreId));
  for (const nombre of ['Inicio', 'INICIO', 'Sin carpeta']) assert.equal((await post('/carpetas', 'admin', { nombre, padreId: c.legal })).status, 400, nombre);
  for (const quien of ['cumplimiento', 'lector2']) assert.equal((await post('/carpetas', quien, { nombre: 'Prohibida', padreId: c.legal })).status, 403);

  const [a] = (await auditorias('crear_carpeta')).filter((x) => x.detalle.carpetaId === c.l2024);
  assert.deepEqual([a.email, a.detalle.padreId, a.detalle.ruta], ['operador@prueba.test', c.legal, '«Legal › 2024»']);
  assert.equal((await notifsPara('cumplimiento', 'Carpeta creada: Legal › 2024')).length, 1);
  assert.equal((await notifsPara('lector2', 'Carpeta creada:%')).length, 0, 'el lector no recibe avisos de carpetas');
});

test('nombre único POR CARPETA: duplicado en el mismo padre → 409; el mismo nombre en padres distintos sí', async () => {
  let r = await post('/carpetas', 'admin', { nombre: ' 2024 ', padreId: c.legal });
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Ya existe una carpeta con ese nombre en esa ubicación (no se distinguen mayúsculas).']);
  assert.equal((await post('/carpetas', 'admin', { nombre: 'LEGAL' })).status, 409, 'en la raíz también');
  c.finanzas = await crear('Finanzas');
  c.f2024 = await crear('2024', c.finanzas);
  c.contratosRaiz = await crear('Contratos'); // hay otra "Contratos" en Legal › 2024: no chocan
  r = await patch(`/carpetas/${c.f2024}`, 'admin', { nombre: 'Contratos' }); // renombrar no choca con la de otro padre
  assert.equal(r.status, 200);
  assert.equal((await patch(`/carpetas/${c.f2024}`, 'admin', { nombre: '2024' })).status, 200);
  assert.equal((await patch(`/carpetas/${c.contratosRaiz}`, 'admin', { nombre: 'finanzas' })).status, 409, 'renombrar a una hermana existente');
});

// ---------------------------------------------------------------------------------------------- explorar
const d = {};
test('explorador: subcarpetas directas con nº de documentos VISIBLES y de subcarpetas, ruta y documentos de aquí', async () => {
  d.raiz = await crearDoc({ nombre: 'En la raíz.pdf' });
  d.legal = await crearDoc({ nombre: 'Política legal.pdf', carpeta: c.legal });
  d.secreto = await crearDoc({ nombre: 'Secreto 2024.pdf', clasif: 'Secreto Corporativo', carpeta: c.l2024 });
  d.l2024 = await crearDoc({ nombre: 'Acta 2024.pdf', carpeta: c.l2024 });
  d.papelera = await crearDoc({ nombre: 'Borrado 2024.pdf', carpeta: c.l2024, estado: 'papelera' });
  d.cloud = await crearDoc({ nombre: 'Contrato cloud.pdf', carpeta: c.n5 });

  const r = await get('/carpetas');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.carpeta, null, 'la raíz no tiene carpeta');
  assert.deepEqual(r.cuerpo.carpetas.map((x) => x.nombre), ['Contratos', 'Finanzas', 'Legal']);
  assert.deepEqual(r.cuerpo.carpetas.find((x) => x.id === c.legal), { id: c.legal, nombre: 'Legal', documentos: 1, subcarpetas: 1 });
  assert.equal(r.cuerpo.documentosAqui, 1);
  assert.equal(r.cuerpo.maxNivel, 5);
  assert.deepEqual((await get('/carpetas?padre=raiz')).cuerpo.carpetas, r.cuerpo.carpetas);

  const dentro = async (quien) => (await get(`/carpetas?padre=${c.legal}`, quien)).cuerpo;
  const admin = await dentro('admin');
  assert.deepEqual(admin.carpeta, { id: c.legal, nombre: 'Legal', nivel: 1, ruta: [{ id: c.legal, nombre: 'Legal' }] });
  assert.deepEqual(admin.carpetas, [{ id: c.l2024, nombre: '2024', documentos: 2, subcarpetas: 1 }], 'el de la papelera no cuenta');
  assert.equal(admin.documentosAqui, 1);
  const lector = await dentro('lector2');
  assert.equal(lector.carpetas[0].documentos, 1, 'el lector de nivel 2 no cuenta el Secreto');
  assert.deepEqual(lector.permisos, { gestionar: false, eliminar: false, solicitar: false, resolver: false });

  const hoja = (await get(`/carpetas?padre=${c.n5}`)).cuerpo;
  assert.deepEqual([hoja.carpeta.nivel, nombresRuta(hoja.carpeta.ruta), hoja.carpetas.length, hoja.documentosAqui], [5, 'Legal › 2024 › Contratos › Proveedores › Cloud', 0, 1]);

  assert.equal((await get('/carpetas?padre=999999')).status, 404);
  for (const padre of ['abc', '1;DROP']) assert.equal((await get(`/carpetas?padre=${encodeURIComponent(padre)}`)).status, 400);
  assert.equal((await get('/carpetas?padre=1&padre=2')).status, 400, 'parámetro repetido');
});

test('ruta (migas de pan) y árbol para el diálogo de mover', async () => {
  const r = await get(`/carpetas/${c.n4}/ruta`, 'lector2');
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo.ruta, [
    { id: c.legal, nombre: 'Legal' }, { id: c.l2024, nombre: '2024' }, { id: c.n3, nombre: 'Contratos' }, { id: c.n4, nombre: 'Proveedores' }]);
  assert.equal((await get('/carpetas/999999/ruta')).status, 404);
  assert.equal((await get('/carpetas/abc/ruta')).status, 404);

  const a = (await get('/carpetas/arbol', 'cumplimiento')).cuerpo;
  assert.equal(a.maxNivel, 5);
  assert.equal(a.carpetas.length, 8); // Legal, 2024, Contratos, Proveedores, Cloud, Finanzas, 2024 y Contratos (raíz)
  assert.deepEqual(a.carpetas.find((x) => x.id === c.n3), { id: c.n3, nombre: 'Contratos', padreId: c.l2024 });
  assert.equal(a.carpetas.find((x) => x.id === c.legal).padreId, null);
});

test('biblioteca: carpeta = solo los directos; subcarpetas=1 = con todo lo de dentro; "sin" = la raíz; ruta en cada documento', async () => {
  assert.deepEqual(nombres(await biblioteca({ carpeta: c.l2024 })), ['Acta 2024.pdf', 'Secreto 2024.pdf']);
  assert.deepEqual(nombres(await biblioteca({ carpeta: c.l2024 }, 'lector2')), ['Acta 2024.pdf']);
  assert.deepEqual(nombres(await biblioteca({ carpeta: c.legal, subcarpetas: '1' })),
    ['Acta 2024.pdf', 'Contrato cloud.pdf', 'Política legal.pdf', 'Secreto 2024.pdf']);
  assert.equal((await biblioteca({ carpeta: c.legal, subcarpetas: '1' }, 'lector2')).cuerpo.total, 3);
  assert.deepEqual(nombres(await biblioteca({ carpeta: 'sin' })), ['En la raíz.pdf']);
  assert.equal((await biblioteca({ carpeta: 'sin', subcarpetas: '1' })).cuerpo.total, 5, 'desde la raíz con subcarpetas: toda la biblioteca');
  assert.deepEqual(nombres(await biblioteca({ carpeta: c.legal, subcarpetas: '1', q: 'cloud' })), ['Contrato cloud.pdf'], 'filtro + subcarpetas');
  for (const sub of ['2', 'si', 'true']) assert.equal((await biblioteca({ carpeta: c.legal, subcarpetas: sub })).status, 400);

  const cloud = (await biblioteca({ q: 'Contrato cloud' })).cuerpo.documentos[0];
  assert.equal(cloud.carpeta.id, c.n5);
  assert.equal(nombresRuta(cloud.carpeta.ruta), 'Legal › 2024 › Contratos › Proveedores › Cloud');
  assert.equal((await biblioteca({ q: 'En la raíz' })).cuerpo.documentos[0].carpeta, null);
  const det = (await get(`/documentos/${d.cloud}`)).cuerpo;
  assert.equal(nombresRuta(det.carpeta.ruta), 'Legal › 2024 › Contratos › Proveedores › Cloud');
});

test('búsqueda: cada resultado trae su carpeta con la ruta', async () => {
  const r = await get('/busqueda');
  assert.equal(r.status, 200);
  const cloud = r.cuerpo.find((x) => x.docId === d.cloud);
  assert.equal(cloud.carpeta.nombre, 'Cloud');
  assert.equal(nombresRuta(cloud.carpeta.ruta), 'Legal › 2024 › Contratos › Proveedores › Cloud');
  assert.equal(r.cuerpo.find((x) => x.docId === d.raiz).carpeta, null);
  assert.ok(!('carpetaId' in cloud), 'el campo interno no se filtra en la respuesta');
});

// ---------------------------------------------------------------------------------------------- mover carpetas
test('mover carpeta: ciclos → 409 (en sí misma o en una subcarpeta suya); subárbol que no cabe → 400; destino inexistente 404', async () => {
  let r = await patch(`/carpetas/${c.legal}`, 'admin', { padreId: c.legal });
  assert.deepEqual([r.status, r.cuerpo.codigo], [409, 'ciclo']);
  r = await patch(`/carpetas/${c.legal}`, 'admin', { padreId: c.n4 });
  assert.deepEqual([r.status, r.cuerpo.codigo], [409, 'ciclo']);
  assert.match(r.cuerpo.error, /dentro de una de sus propias subcarpetas/);
  // 2024 tiene 4 niveles (2024 › Contratos › Proveedores › Cloud): dentro de Finanzas › 2024 (nivel 2) llegaría al 6.
  r = await patch(`/carpetas/${c.l2024}`, 'admin', { padreId: c.f2024 });
  assert.deepEqual([r.status, r.cuerpo.codigo], [400, 'profundidad']);
  assert.match(r.cuerpo.error, /llegaría al nivel 6/);
  assert.equal((await patch(`/carpetas/${c.l2024}`, 'admin', { padreId: '999999' })).status, 404);
  for (const cuerpo of [{}, { padreId: 'x' }, { padreId: 3.5 }])
    assert.equal((await patch(`/carpetas/${c.l2024}`, 'admin', cuerpo)).status, 400, JSON.stringify(cuerpo));
  assert.equal((await fila(`SELECT padre_id FROM carpetas WHERE id = $1`, [c.l2024])).padre_id.toString(), c.legal, 'nada cambió');
  assert.equal((await auditorias('mover_carpeta')).length, 0);
});

test('mover carpeta: con su contenido, sin tocar los documentos; duplicado en el destino → 409; auditado y notificado', async () => {
  // "Contratos" (nivel 3, con 3 niveles debajo de ella incluida) → a la raíz: ya hay una "Contratos" allí.
  let r = await patch(`/carpetas/${c.n3}`, 'operador', { padreId: null });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /en esa ubicación/);
  const antes = await fila(`SELECT actualizado_en FROM documentos WHERE id = $1`, [d.cloud]);
  // Proveedores (con Cloud dentro) pasa de Legal › 2024 › Contratos a Finanzas › 2024.
  r = await patch(`/carpetas/${c.n4}`, 'operador', { padreId: c.f2024 });
  assert.deepEqual([r.status, r.cuerpo], [200, { id: c.n4, nombre: 'Proveedores', padreId: c.f2024 }]);
  const doc = await fila(`SELECT carpeta_id, actualizado_en FROM documentos WHERE id = $1`, [d.cloud]);
  assert.equal(String(doc.carpeta_id), c.n5, 'el documento sigue en su carpeta');
  assert.equal(doc.actualizado_en.getTime(), antes.actualizado_en.getTime(), 'organizar no modifica documentos');
  assert.equal(nombresRuta((await get(`/carpetas/${c.n5}/ruta`)).cuerpo.ruta), 'Finanzas › 2024 › Proveedores › Cloud');
  assert.deepEqual(nombres(await biblioteca({ carpeta: c.finanzas, subcarpetas: '1' })), ['Contrato cloud.pdf']);

  const [a] = await auditorias('mover_carpeta');
  assert.deepEqual([a.email, a.detalle.carpetaId, a.detalle.de, a.detalle.deRuta, a.detalle.a, a.detalle.aRuta],
    ['operador@prueba.test', c.n4, c.n3, '«Legal › 2024 › Contratos»', c.f2024, '«Finanzas › 2024»']);
  const [n] = await notifsPara('cumplimiento', 'Carpeta movida: Proveedores%');
  assert.equal(n.titulo, 'Carpeta movida: Proveedores → «Finanzas › 2024»');
  assert.match(n.descripcion, /Antes estaba en «Legal › 2024 › Contratos»/);
  assert.ok(!/Contrato cloud/.test(n.titulo + n.descripcion), 'el aviso no nombra documentos');

  // Mover a la raíz y renombrar en la misma petición: dos auditorías (renombrar y mover).
  r = await patch(`/carpetas/${c.n4}`, 'admin', { padreId: null, nombre: 'Proveedores TI' });
  assert.deepEqual([r.status, r.cuerpo.padreId, r.cuerpo.nombre], [200, null, 'Proveedores TI']);
  assert.equal((await auditorias('renombrar_carpeta')).at(-1).detalle.nombre, 'Proveedores TI');
  assert.equal((await auditorias('mover_carpeta')).at(-1).detalle.aRuta, '«Inicio»');
  // Al mismo sitio: sin cambios, sin auditoría.
  const total = (await auditorias('mover_carpeta')).length;
  assert.equal((await patch(`/carpetas/${c.n4}`, 'admin', { padreId: null })).status, 200);
  assert.equal((await auditorias('mover_carpeta')).length, total);

  for (const quien of ['cumplimiento', 'lector2']) assert.equal((await patch(`/carpetas/${c.n4}`, quien, { padreId: c.legal })).status, 403);
});

test('mover carpeta: dos movimientos cruzados a la vez (A dentro de B y B dentro de A) nunca dejan un ciclo', async () => {
  const A = await crear('Cruce A');
  const B = await crear('Cruce B');
  const [r1, r2] = await Promise.all([
    patch(`/carpetas/${A}`, 'admin', { padreId: B }),
    patch(`/carpetas/${B}`, 'operador', { padreId: A }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const { rows } = await base.pool.query(`SELECT id, padre_id FROM carpetas WHERE id IN ($1, $2)`, [A, B]);
  assert.equal(rows.filter((x) => x.padre_id === null).length, 1, 'exactamente una sigue en la raíz');
});

// ---------------------------------------------------------------------------------------------- eliminar
test('eliminar: con subcarpetas → 409; vacía → 204 (solo Super Administrador), auditada con su ruta', async () => {
  let r = await del(`/carpetas/${c.f2024}`, 'admin');
  assert.equal(r.status, 204, 'Finanzas › 2024 quedó vacía tras mover Proveedores');
  r = await del(`/carpetas/${c.legal}`, 'admin');
  assert.deepEqual([r.status, r.cuerpo.codigo], [409, 'subcarpetas']);
  assert.match(r.cuerpo.error, /tiene 1 subcarpeta/);
  const vacia = await crear('Vacía', c.n3);
  assert.equal((await del(`/carpetas/${vacia}`, 'operador')).status, 403);
  assert.equal((await del(`/carpetas/${vacia}`, 'admin')).status, 204);
  const [a] = (await auditorias('eliminar_carpeta')).filter((x) => x.detalle.carpetaId === vacia);
  assert.equal(a.detalle.ruta, '«Legal › 2024 › Contratos › Vacía»');
  assert.equal((await notifsPara('admin', 'Carpeta eliminada: Legal › 2024 › Contratos › Vacía')).length, 1);
  // Con un documento en la papelera dentro: tampoco.
  const conPapelera = await crear('Con papelera');
  await crearDoc({ nombre: 'Tirado.pdf', carpeta: conPapelera, estado: 'papelera' });
  assert.equal((await del(`/carpetas/${conPapelera}`, 'admin')).status, 409);
  // La base también lo impide: no se puede borrar una carpeta con hijas (ON DELETE RESTRICT).
  await assert.rejects(base.pool.query(`DELETE FROM carpetas WHERE id = $1`, [c.legal]), /carpetas_padre_id_fkey/);
});

// ---------------------------------------------------------------------------------------------- documentos
test('mover documentos y solicitudes a una subcarpeta: avisos con la ruta y sin revelar nombres a quien no alcanza el nivel', async () => {
  let r = await post('/carpetas/mover', 'admin', { ids: [d.raiz], carpetaId: c.n3 });
  assert.deepEqual(r.cuerpo, { movidos: 1, sinCambios: 0, omitidos: [] });
  const [n] = await notifsPara('operador', 'Documento movido a%');
  assert.equal(n.titulo, 'Documento movido a «Legal › 2024 › Contratos»');
  assert.ok(!n.titulo.includes('En la raíz'));
  assert.equal((await auditorias('mover_documento')).at(-1).detalle.aRuta, '«Legal › 2024 › Contratos»');

  r = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: d.legal, carpetaId: c.l2024, motivo: 'Corresponde al año 2024.' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const [s] = (await get('/carpetas/solicitudes', 'admin')).cuerpo;
  assert.deepEqual([nombresRuta(s.carpetaDestino.ruta), nombresRuta(s.carpetaActual.ruta)], ['Legal › 2024', 'Legal']);
  assert.match((await notifsPara('admin', 'Solicitud de movimiento: Política legal.pdf'))[0].descripcion, /moverlo a «Legal › 2024»/);
  // Una pendiente hacia la carpeta impide eliminarla aunque esté vacía de documentos.
  const destino = await crear('Destino pendiente', c.legal);
  await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: d.l2024, carpetaId: destino, motivo: 'Motivo suficientemente largo' });
  assert.match((await del(`/carpetas/${destino}`, 'admin')).cuerpo.error, /solicitudes de movimiento pendientes/);
  r = await post(`/carpetas/solicitudes/${s.id}/aprobar`, 'operador', {});
  assert.equal(r.status, 200);
  assert.match((await notifsPara('cumplimiento', 'Solicitud aprobada: Política legal.pdf'))[0].descripcion, /se movió a «Legal › 2024»/);
  // A la raíz: «Inicio».
  r = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: d.raiz, carpetaId: null, motivo: 'Debe volver a la raíz.' });
  assert.equal(r.status, 201);
  assert.match((await notifsPara('admin', 'Solicitud de movimiento: En la raíz.pdf'))[0].descripcion, /moverlo a «Inicio»/);
});
