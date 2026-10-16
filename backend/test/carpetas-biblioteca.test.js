/**
 * Fase 5 de punta a punta (la app REAL por HTTP contra PostgreSQL en un esquema temporal):
 * biblioteca con filtros, orden y paginación en el servidor; carpetas; mover; solicitudes de movimiento;
 * notificaciones con documentoId; y "Crear usuario" con nivel (el formulario antes no lo enviaba: 400).
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
  // Enviar a la papelera despierta el mantenimiento, que necesita el almacenamiento (aquí vacío, en una carpeta temporal).
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-fase5-'));
  await (await import('../src/lib/storage.js')).inicializarAlmacenamiento({ driver: 'local', raiz });
  pap = await import('../src/lib/papelera.js');
  const { firmarToken } = await import('../src/middleware/auth.js');
  for (const [clave, rol, nivel] of [
    ['admin', 'super-admin', 'Nivel 5 Secreto'],
    ['admin2', 'super-admin', 'Nivel 2 Confidencial'],
    ['operador', 'ocr-operator', 'Nivel 2 Auditoría'],
    ['operador5', 'ocr-operator', 'Nivel 5 Secreto'],
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
  // Una clasificación de nivel 3: la ve Cumplimiento (3) pero no el Operador (2). Sirve para probar el nivel al resolver.
  await base.pool.query(`INSERT INTO clasificaciones (nombre, nivel_minimo, punto_clase, badge_clase) VALUES ('Reservado Nivel 3', 3, 'x', 'x')`);
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
const hace = (dias) => new Date(Date.now() - dias * 86_400_000);
const nombres = (r) => r.cuerpo.documentos.map((d) => d.name);
const biblioteca = (qs, quien) => get(`/documentos?${new URLSearchParams(qs)}`, quien);

let folios = 0;
/** Inserta un documento con los valores exactos que se quieren probar (fechas, tamaño, nivel...). */
async function crearDoc({ nombre, formato = 'pdf', clasif = 'Uso Interno General', dep = null, tamano = 1000, actualizado = hace(1), estado = 'activo', creado }) {
  const { rows: [d] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, departamento_id, autor_nombre, tamano_bytes, estado, creado_en, actualizado_en)
     VALUES ($1, $2, $3, (SELECT id FROM clasificaciones WHERE nombre = $4), (SELECT id FROM departamentos WHERE nombre = $5), 'Autor', $6, $7, $8, $9)
     RETURNING id`, [nombre, `EXP-F5-${++folios}`, formato, clasif, dep, tamano, estado, creado ?? actualizado, actualizado]);
  return String(d.id);
}
const auditorias = (accion, docId) =>
  filas(`SELECT a.detalle, a.documento_id, u.email FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
          WHERE a.accion = $1 AND ($2::bigint IS NULL OR a.documento_id = $2) ORDER BY a.id`, [accion, docId ?? null]);
const notifsPara = (quien, patron) =>
  filas(`SELECT titulo, descripcion, documento_id, categoria, badge, acciones FROM notificaciones WHERE usuario_id = $1 AND titulo LIKE $2 ORDER BY id`,
    [ids[quien], patron]);

// ---------------------------------------------------------------------------------------------- biblioteca
const docs = {};
test('biblioteca: lista paginada con total y resumen, respetando el nivel de cada usuario', async () => {
  const mismaFecha = hace(5);
  docs.A = await crearDoc({ nombre: 'Acta junta.pdf', dep: 'Legal', tamano: 300, actualizado: mismaFecha });
  docs.B = await crearDoc({ nombre: 'Balance anual.xlsx', formato: 'xlsx', clasif: 'Confidencial Nivel 2', dep: 'Finanzas', tamano: 900, actualizado: hace(40) });
  docs.C = await crearDoc({ nombre: 'contrato cloud.pdf', clasif: 'Secreto Corporativo', dep: 'Legal', tamano: 500, actualizado: hace(100) });
  docs.D = await crearDoc({ nombre: 'Dictamen fiscal.docx', formato: 'docx', dep: 'Finanzas', tamano: 900, actualizado: hace(200) });
  docs.E = await crearDoc({ nombre: 'Expediente RH.tiff', formato: 'tiff', clasif: 'Confidencial Nivel 2', tamano: 100, actualizado: mismaFecha });
  docs.F = await crearDoc({ nombre: 'Fuera.pdf', estado: 'papelera', actualizado: hace(2) });

  const r = await biblioteca({});
  assert.equal(r.status, 200);
  assert.deepEqual([r.cuerpo.total, r.cuerpo.pagina, r.cuerpo.porPagina], [5, 1, 25]);
  // Reciente: A y E tienen la MISMA fecha → desempate por id descendente (E se creó después).
  assert.deepEqual(nombres(r), ['Expediente RH.tiff', 'Acta junta.pdf', 'Balance anual.xlsx', 'contrato cloud.pdf', 'Dictamen fiscal.docx']);
  assert.deepEqual(r.cuerpo.resumen, { total: 5, actualizados30: 2 });
  const a = r.cuerpo.documentos.find((d) => d.id === docs.A);
  assert.equal(a.carpeta, null);
  assert.equal(a.tieneArchivo, false);
  assert.equal(a.nombreOriginal, null);
  assert.equal(a.departamento, 'Legal');
  assert.match(a.actualizado, /^\d{2} \w{3} \d{4}, \d{1,2}:\d{2} (a|p)\. m\.$/);

  // Nivel 2: no ve el Secreto ni en la lista, ni en el total, ni en el resumen.
  const l = await biblioteca({}, 'lector2');
  assert.equal(l.cuerpo.total, 4);
  assert.ok(!l.cuerpo.documentos.some((d) => d.id === docs.C));
  assert.deepEqual(l.cuerpo.resumen, { total: 4, actualizados30: 2 });
});

test('biblioteca: filtros por texto, departamento, formato y periodo (también con el nivel)', async () => {
  assert.deepEqual(nombres(await biblioteca({ q: 'contrato' })), ['contrato cloud.pdf']);
  const oculto = await biblioteca({ q: 'contrato' }, 'lector2');
  assert.deepEqual([oculto.cuerpo.total, oculto.cuerpo.documentos.length], [0, 0]);
  assert.equal((await biblioteca({ q: 'EXP-F5-1' })).cuerpo.documentos[0].id, docs.A, 'también por folio');
  assert.equal((await biblioteca({ q: '%' })).cuerpo.total, 0, 'el % se busca literal, no es comodín');
  assert.deepEqual(nombres(await biblioteca({ departamento: 'Legal', orden: 'nombre' })), ['Acta junta.pdf', 'contrato cloud.pdf']);
  assert.deepEqual(nombres(await biblioteca({ formato: 'xlsx' })), ['Balance anual.xlsx']);
  assert.equal((await biblioteca({ dias: '30' })).cuerpo.total, 2);
  assert.equal((await biblioteca({ dias: '90' })).cuerpo.total, 3);
  assert.equal((await biblioteca({ dias: '180' })).cuerpo.total, 4);
  assert.equal((await biblioteca({ dias: 'todo' })).cuerpo.total, 5);
  const combinado = await biblioteca({ departamento: 'Finanzas', dias: '90' });
  assert.deepEqual([combinado.cuerpo.total, nombres(combinado)], [1, ['Balance anual.xlsx']]);
});

test('biblioteca: los cuatro órdenes, siempre estables con desempate por id', async () => {
  assert.deepEqual(nombres(await biblioteca({ orden: 'antiguo' })),
    ['Dictamen fiscal.docx', 'contrato cloud.pdf', 'Balance anual.xlsx', 'Acta junta.pdf', 'Expediente RH.tiff']);
  // B y D pesan lo mismo (900): primero el de id mayor (D).
  assert.deepEqual(nombres(await biblioteca({ orden: 'tamano' })),
    ['Dictamen fiscal.docx', 'Balance anual.xlsx', 'contrato cloud.pdf', 'Acta junta.pdf', 'Expediente RH.tiff']);
  // Sin distinguir mayúsculas: "contrato" va entre "Balance" y "Dictamen".
  assert.deepEqual(nombres(await biblioteca({ orden: 'nombre' })),
    ['Acta junta.pdf', 'Balance anual.xlsx', 'contrato cloud.pdf', 'Dictamen fiscal.docx', 'Expediente RH.tiff']);
});

test('biblioteca: paginación real (25/50/100), sin solapes, y página fuera de rango vacía con el total', async () => {
  for (let i = 0; i < 30; i++) await crearDoc({ nombre: `Lote ${String(i).padStart(2, '0')}.pdf`, actualizado: hace(300) });
  const p1 = await biblioteca({ q: 'Lote', orden: 'nombre', porPagina: '25', pagina: '1' });
  const p2 = await biblioteca({ q: 'Lote', orden: 'nombre', porPagina: '25', pagina: '2' });
  assert.deepEqual([p1.cuerpo.total, p1.cuerpo.documentos.length, p2.cuerpo.documentos.length], [30, 25, 5]);
  assert.equal(p1.cuerpo.documentos[0].name, 'Lote 00.pdf');
  assert.equal(p2.cuerpo.documentos[0].name, 'Lote 25.pdf');
  const todos = new Set([...p1.cuerpo.documentos, ...p2.cuerpo.documentos].map((d) => d.id));
  assert.equal(todos.size, 30, 'ningún documento se repite ni se pierde entre páginas');
  const p3 = await biblioteca({ q: 'Lote', porPagina: '25', pagina: '3' });
  assert.deepEqual([p3.status, p3.cuerpo.total, p3.cuerpo.documentos.length, p3.cuerpo.pagina], [200, 30, 0, 3]);
  assert.equal((await biblioteca({ q: 'Lote', porPagina: '50' })).cuerpo.documentos.length, 30);
  assert.equal((await biblioteca({ porPagina: '100' })).cuerpo.porPagina, 100);
});

test('biblioteca: parámetros inválidos → 400 en español (nada llega al SQL)', async () => {
  for (const [qs, patron] of [
    [{ orden: 'id; DROP TABLE documentos' }, /Orden no válido/],
    [{ porPagina: '10' }, /Filas por página/],
    [{ porPagina: '1000' }, /Filas por página/],
    [{ pagina: '0' }, /Página no válida/],
    [{ pagina: 'abc' }, /Página no válida/],
    [{ dias: '45' }, /Periodo no válido/],
    [{ formato: 'exe' }, /Formato no válido/],
    [{ carpeta: 'abc' }, /Carpeta no válida/],
    [{ q: 'x'.repeat(201) }, /máximo 200/],
  ]) {
    const r = await biblioteca(qs);
    assert.equal(r.status, 400, JSON.stringify(qs));
    assert.match(r.cuerpo.error, patron);
  }
  assert.equal((await get('/documentos?orden=nombre&orden=tamano')).status, 400, 'un parámetro repetido no es válido');
});

// ---------------------------------------------------------------------------------------------- carpetas
const carpetas = {};
test('carpetas: crear (Admin y Operador), duplicado sin distinguir mayúsculas → 409, validaciones y permisos', async () => {
  let r = await post('/carpetas', 'operador', { nombre: '  Contratos   vigentes ' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.nombre, 'Contratos vigentes'); // espacios normalizados
  carpetas.contratos = r.cuerpo.id;
  const [a] = await auditorias('crear_carpeta');
  assert.deepEqual([a.email, a.detalle.nombre], ['operador@prueba.test', 'Contratos vigentes']);
  assert.equal((await notifsPara('cumplimiento', 'Carpeta creada: Contratos vigentes')).length, 1);

  r = await post('/carpetas', 'admin', { nombre: 'CONTRATOS VIGENTES' });
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Ya existe una carpeta con ese nombre (no se distinguen mayúsculas).']);
  for (const nombre of ['a', 'x'.repeat(81), '', null, 'Sin carpeta', 'sin CARPETA'])
    assert.equal((await post('/carpetas', 'admin', { nombre })).status, 400, String(nombre));
  for (const quien of ['cumplimiento', 'lector2']) assert.equal((await post('/carpetas', quien, { nombre: 'Prohibida' })).status, 403);

  carpetas.auditorias = (await post('/carpetas', 'admin', { nombre: 'Auditorías' })).cuerpo.id;
  carpetas.vacia = (await post('/carpetas', 'admin', { nombre: 'Temporal' })).cuerpo.id;
});

test('carpetas: renombrar (409 duplicado, 404 inexistente) y listado con nº de documentos VISIBLES', async () => {
  let r = await patch(`/carpetas/${carpetas.vacia}`, 'operador', { nombre: 'Temporal 2026' });
  assert.deepEqual([r.status, r.cuerpo.nombre], [200, 'Temporal 2026']);
  const [a] = await auditorias('renombrar_carpeta');
  assert.deepEqual([a.detalle.anterior, a.detalle.nombre], ['Temporal', 'Temporal 2026']);
  assert.equal((await patch(`/carpetas/${carpetas.vacia}`, 'admin', { nombre: 'auditorías' })).status, 409);
  assert.equal((await patch('/carpetas/999999', 'admin', { nombre: 'Nueva' })).status, 404);
  assert.equal((await patch(`/carpetas/${carpetas.vacia}`, 'cumplimiento', { nombre: 'Nueva' })).status, 403);

  await base.pool.query(`UPDATE documentos SET carpeta_id = $1 WHERE id = ANY($2::bigint[])`, [carpetas.contratos, [docs.A, docs.C]]);
  const cuenta = async (quien) => {
    const l = (await get('/carpetas', quien)).cuerpo;
    return [l.carpetas.find((c) => c.id === carpetas.contratos).documentos, l.permisos];
  };
  const [nAdmin, pAdmin] = await cuenta('admin');
  const [nLector, pLector] = await cuenta('lector2');
  assert.equal(nAdmin, 2);
  assert.equal(nLector, 1, 'el lector de nivel 2 no cuenta el documento Secreto');
  assert.deepEqual(pAdmin, { gestionar: true, eliminar: true, solicitar: false, resolver: true });
  assert.deepEqual(pLector, { gestionar: false, eliminar: false, solicitar: false, resolver: false });
  assert.deepEqual((await get('/carpetas', 'cumplimiento')).cuerpo.permisos, { gestionar: false, eliminar: false, solicitar: true, resolver: false });
  // Filtro de la biblioteca por carpeta y por "sin carpeta"
  assert.deepEqual(nombres(await biblioteca({ carpeta: carpetas.contratos, orden: 'nombre' })), ['Acta junta.pdf', 'contrato cloud.pdf']);
  assert.deepEqual(nombres(await biblioteca({ carpeta: carpetas.contratos }, 'lector2')), ['Acta junta.pdf']);
  assert.ok(!nombres(await biblioteca({ carpeta: 'sin', porPagina: '100' })).includes('Acta junta.pdf'));
  const detalle = (await biblioteca({ q: 'Acta junta' })).cuerpo.documentos[0];
  assert.deepEqual(detalle.carpeta, { id: carpetas.contratos, nombre: 'Contratos vigentes' });
  assert.deepEqual((await get(`/documentos/${docs.A}`)).cuerpo.carpeta, { id: carpetas.contratos, nombre: 'Contratos vigentes' });
});

test('carpetas: eliminar solo vacía (409 si tiene documentos, incluso en la papelera) y solo Super Administrador', async () => {
  assert.equal((await del(`/carpetas/${carpetas.vacia}`, 'operador')).status, 403);
  let r = await del(`/carpetas/${carpetas.contratos}`, 'admin');
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /no está vacía: contiene 2 documentos/);
  // Un documento en la papelera también cuenta (si se restaura, volvería a esta carpeta).
  await base.pool.query(`UPDATE documentos SET carpeta_id = $1 WHERE id = $2`, [carpetas.vacia, docs.F]);
  assert.equal((await del(`/carpetas/${carpetas.vacia}`, 'admin')).status, 409);
  await base.pool.query(`UPDATE documentos SET carpeta_id = NULL WHERE id = $1`, [docs.F]);
  r = await del(`/carpetas/${carpetas.vacia}`, 'admin');
  assert.equal(r.status, 204);
  assert.equal(await fila(`SELECT 1 FROM carpetas WHERE id = $1`, [carpetas.vacia]), undefined);
  const [a] = await auditorias('eliminar_carpeta');
  assert.equal(a.detalle.nombre, 'Temporal 2026');
  assert.equal((await del(`/carpetas/${carpetas.vacia}`, 'admin')).status, 404);
});

// ---------------------------------------------------------------------------------------------- mover
test('mover: en una transacción, omite lo no visible o no activo, audita por documento y no toca "actualizado"', async () => {
  const antes = await fila(`SELECT actualizado_en FROM documentos WHERE id = $1`, [docs.B]);
  // El operador (nivel 2) pide mover B (visible), C (Secreto: no visible), F (papelera) y uno inexistente.
  const r = await post('/carpetas/mover', 'operador', { ids: [docs.B, docs.C, docs.F, '999999', docs.B], carpetaId: carpetas.auditorias });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo, { movidos: 1, sinCambios: 0, omitidos: [docs.C, docs.F, '999999'] });
  const b = await fila(`SELECT carpeta_id, actualizado_en FROM documentos WHERE id = $1`, [docs.B]);
  assert.equal(String(b.carpeta_id), carpetas.auditorias);
  assert.equal(b.actualizado_en.getTime(), antes.actualizado_en.getTime(), 'organizar no cuenta como modificar');
  assert.equal(String((await fila(`SELECT carpeta_id FROM documentos WHERE id = $1`, [docs.C])).carpeta_id), carpetas.contratos, 'C no se tocó');
  const aud = await auditorias('mover_documento');
  assert.equal(aud.length, 1);
  assert.deepEqual([String(aud[0].documento_id), aud[0].detalle.a, aud[0].detalle.aNombre, aud[0].email],
    [docs.B, carpetas.auditorias, 'Auditorías', 'operador@prueba.test']);
  const n = await notifsPara('admin', 'Documento movido a «Auditorías»');
  assert.equal(n.length, 1);
  assert.deepEqual([n[0].categoria, n[0].badge, n[0].acciones], ['edicion', 'Carpetas', []]);

  // Repetir: ya está ahí → sin cambios y sin auditoría nueva. Sacarlo de la carpeta (null).
  assert.deepEqual((await post('/carpetas/mover', 'admin', { ids: [docs.B], carpetaId: carpetas.auditorias })).cuerpo, { movidos: 0, sinCambios: 1, omitidos: [] });
  assert.equal((await auditorias('mover_documento')).length, 1);
  assert.equal((await post('/carpetas/mover', 'admin', { ids: [docs.B], carpetaId: null })).cuerpo.movidos, 1);
  assert.equal((await fila(`SELECT carpeta_id FROM documentos WHERE id = $1`, [docs.B])).carpeta_id, null);
  assert.equal((await auditorias('mover_documento')).at(-1).detalle.a, null);
  // El trigger de "actualizado" sigue funcionando para cambios reales.
  await base.pool.query(`UPDATE documentos SET nombre = nombre WHERE id = $1`, [docs.D]);
  assert.ok((await fila(`SELECT actualizado_en FROM documentos WHERE id = $1`, [docs.D])).actualizado_en > hace(1));
});

test('mover: validaciones y permisos (Cumplimiento y Lector no mueven)', async () => {
  for (const quien of ['cumplimiento', 'lector2'])
    assert.equal((await post('/carpetas/mover', quien, { ids: [docs.A], carpetaId: null })).status, 403);
  for (const cuerpo of [{}, { ids: [], carpetaId: null }, { ids: ['abc'], carpetaId: null }, { ids: [docs.A] },
    { ids: [docs.A], carpetaId: 'x' }, { ids: Array.from({ length: 101 }, (_, i) => String(i + 1)), carpetaId: null }])
    assert.equal((await post('/carpetas/mover', 'admin', cuerpo)).status, 400, JSON.stringify(cuerpo).slice(0, 80));
  assert.equal((await post('/carpetas/mover', 'admin', { ids: [docs.A], carpetaId: '999999' })).status, 404);
});

// ---------------------------------------------------------------------------------------------- solicitudes
const sol = {};
test('solicitudes: Cumplimiento solicita con motivo; duplicada → 409; notifica a quien puede resolver y alcanza el nivel', async () => {
  docs.R = await crearDoc({ nombre: 'Reservado.pdf', clasif: 'Reservado Nivel 3' });
  let r = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.E, carpetaId: carpetas.auditorias, motivo: 'Pertenece al cierre de auditoría.' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  sol.E = r.cuerpo.id;
  const [a] = await auditorias('solicitar_movimiento', docs.E);
  assert.deepEqual([a.email, a.detalle.motivo, a.detalle.a], ['cumplimiento@prueba.test', 'Pertenece al cierre de auditoría.', carpetas.auditorias]);
  for (const quien of ['admin', 'operador']) assert.equal((await notifsPara(quien, 'Solicitud de movimiento: Expediente RH.tiff')).length, 1, quien);
  assert.equal((await notifsPara('lector2', 'Solicitud de movimiento:%')).length, 0);
  const n = (await notifsPara('operador', 'Solicitud de movimiento: Expediente RH.tiff'))[0];
  assert.equal(String(n.documento_id), docs.E);

  r = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.E, carpetaId: carpetas.contratos, motivo: 'Otra solicitud distinta.' });
  assert.deepEqual([r.status, r.cuerpo.codigo], [409, 'duplicada']);

  // Documento de nivel 3: el operador (nivel 2) NO recibe aviso; el admin sí.
  r = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.R, carpetaId: carpetas.contratos, motivo: 'Corresponde a contratos.' });
  assert.equal(r.status, 201);
  sol.R = r.cuerpo.id;
  assert.equal((await notifsPara('operador', 'Solicitud de movimiento: Reservado.pdf')).length, 0);
  assert.equal((await notifsPara('admin', 'Solicitud de movimiento: Reservado.pdf')).length, 1);

  // Validaciones
  assert.equal((await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.D, carpetaId: carpetas.auditorias, motivo: 'corto' })).status, 400);
  assert.equal((await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.D, motivo: 'Motivo suficientemente largo' })).status, 400);
  assert.equal((await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.C, carpetaId: null, motivo: 'Motivo suficientemente largo' })).status, 404, 'Secreto: no lo ve');
  assert.equal((await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.D, carpetaId: '999999', motivo: 'Motivo suficientemente largo' })).status, 404);
  r = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.D, carpetaId: null, motivo: 'Motivo suficientemente largo' });
  assert.deepEqual([r.status, r.cuerpo.codigo], [409, 'sin_cambios'], 'ya está sin carpeta');
  for (const quien of ['admin', 'operador', 'lector2'])
    assert.equal((await post('/carpetas/solicitudes', quien, { documentoId: docs.D, carpetaId: carpetas.auditorias, motivo: 'Motivo suficientemente largo' })).status, 403);
});

test('solicitudes: listado según rol (resolutor por nivel, Cumplimiento solo las suyas, Lector 403)', async () => {
  const deAdmin = (await get('/carpetas/solicitudes', 'admin')).cuerpo;
  assert.deepEqual(deAdmin.map((s) => s.id).sort(), [sol.E, sol.R].sort());
  const e = deAdmin.find((s) => s.id === sol.E);
  assert.deepEqual([e.documento.id, e.carpetaDestino.nombre, e.carpetaActual, e.solicitante, e.estado, e.puedeResolver],
    [docs.E, 'Auditorías', null, 'Usuario cumplimiento', 'pendiente', true]);
  assert.deepEqual((await get('/carpetas/solicitudes', 'operador')).cuerpo.map((s) => s.id), [sol.E], 'el nivel 3 no aparece para el nivel 2');
  const propias = (await get('/carpetas/solicitudes', 'cumplimiento')).cuerpo;
  assert.equal(propias.length, 2);
  assert.ok(propias.every((s) => s.puedeResolver === false));
  assert.equal((await get('/carpetas/solicitudes', 'lector2')).status, 403);
  assert.equal((await get('/carpetas/solicitudes?estado=otra', 'admin')).status, 400);
});

test('solicitudes: aprobar aplica el movimiento en la misma transacción, audita y avisa al solicitante', async () => {
  // El operador de nivel 2 no puede resolver la de nivel 3 (ni sabe que existe).
  assert.equal((await post(`/carpetas/solicitudes/${sol.R}/aprobar`, 'operador', {})).status, 404);
  assert.equal((await post(`/carpetas/solicitudes/${sol.E}/aprobar`, 'cumplimiento', {})).status, 403);

  const antes = await fila(`SELECT actualizado_en FROM documentos WHERE id = $1`, [docs.E]);
  const r = await post(`/carpetas/solicitudes/${sol.E}/aprobar`, 'operador', { respuesta: 'De acuerdo' });
  assert.deepEqual([r.status, r.cuerpo.estado], [200, 'aprobada']);
  const d = await fila(`SELECT carpeta_id, actualizado_en FROM documentos WHERE id = $1`, [docs.E]);
  assert.equal(String(d.carpeta_id), carpetas.auditorias);
  assert.equal(d.actualizado_en.getTime(), antes.actualizado_en.getTime());
  const s = await fila(`SELECT estado, resuelto_por, resuelto_en, respuesta FROM solicitudes_movimiento WHERE id = $1`, [sol.E]);
  assert.deepEqual([s.estado, String(s.resuelto_por), !!s.resuelto_en, s.respuesta], ['aprobada', ids.operador, true, 'De acuerdo']);
  assert.equal((await auditorias('aprobar_movimiento', docs.E)).length, 1);
  assert.equal((await auditorias('mover_documento', docs.E)).at(-1).detalle.solicitudId, sol.E);
  const n = await notifsPara('cumplimiento', 'Solicitud aprobada: Expediente RH.tiff');
  assert.equal(n.length, 1);
  assert.match(n[0].descripcion, /se movió a «Auditorías»/);

  // Ya resuelta: 409. Y ya no figura entre las pendientes.
  assert.equal((await post(`/carpetas/solicitudes/${sol.E}/rechazar`, 'admin', { respuesta: 'Tarde' })).cuerpo.codigo, 'resuelta');
  assert.ok(!(await get('/carpetas/solicitudes', 'admin')).cuerpo.some((x) => x.id === sol.E));
  assert.equal((await get('/carpetas/solicitudes?estado=aprobada', 'cumplimiento')).cuerpo[0].resueltoPor, 'Usuario operador');
});

test('solicitudes: rechazar exige motivo y no mueve; quien solicita nunca resuelve; documento en papelera no se aprueba', async () => {
  assert.equal((await post(`/carpetas/solicitudes/${sol.R}/rechazar`, 'admin', {})).status, 400);
  const r = await post(`/carpetas/solicitudes/${sol.R}/rechazar`, 'admin', { respuesta: 'Debe quedarse donde está' });
  assert.deepEqual([r.status, r.cuerpo.estado], [200, 'rechazada']);
  assert.equal((await fila(`SELECT carpeta_id FROM documentos WHERE id = $1`, [docs.R])).carpeta_id, null);
  assert.equal((await auditorias('rechazar_movimiento', docs.R))[0].detalle.respuesta, 'Debe quedarse donde está');
  const n = await notifsPara('cumplimiento', 'Solicitud rechazada: Reservado.pdf');
  assert.match(n[0].descripcion, /no se movió\. Motivo: Debe quedarse donde está/);

  // Aunque al solicitante le cambien el rol a uno que resuelve, no puede resolver SU propia solicitud.
  const nueva = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.D, carpetaId: carpetas.auditorias, motivo: 'Es un dictamen de auditoría.' });
  await base.pool.query(`UPDATE usuarios SET rol_id = (SELECT id FROM roles WHERE clave = 'super-admin') WHERE id = $1`, [ids.cumplimiento]);
  try {
    const propia = await post(`/carpetas/solicitudes/${nueva.cuerpo.id}/aprobar`, 'cumplimiento', {});
    assert.equal(propia.status, 403);
    assert.match(propia.cuerpo.error, /no puede resolver su propia solicitud/);
  } finally {
    await base.pool.query(`UPDATE usuarios SET rol_id = (SELECT id FROM roles WHERE clave = 'compliance') WHERE id = $1`, [ids.cumplimiento]);
  }
  // Mientras haya una pendiente hacia la carpeta, no se puede eliminar.
  const vacia = (await post('/carpetas', 'admin', { nombre: 'Destino pendiente' })).cuerpo.id;
  const otra = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.B, carpetaId: vacia, motivo: 'Motivo suficientemente largo' });
  const borrar = await del(`/carpetas/${vacia}`, 'admin');
  assert.equal(borrar.status, 409);
  assert.match(borrar.cuerpo.error, /solicitudes de movimiento pendientes/);
  // El documento pasa a la papelera: aprobar → 409; rechazar sí se puede.
  await base.pool.query(`UPDATE documentos SET estado = 'papelera' WHERE id = $1`, [docs.D]);
  assert.equal((await post(`/carpetas/solicitudes/${nueva.cuerpo.id}/aprobar`, 'admin', {})).cuerpo.codigo, 'no_activo');
  assert.equal((await post(`/carpetas/solicitudes/${nueva.cuerpo.id}/rechazar`, 'admin', { respuesta: 'Está en la papelera' })).status, 200);
  await base.pool.query(`UPDATE documentos SET estado = 'activo' WHERE id = $1`, [docs.D]);
  assert.equal((await post(`/carpetas/solicitudes/${otra.cuerpo.id}/rechazar`, 'admin', { respuesta: 'No procede' })).status, 200);
  assert.equal((await del(`/carpetas/${vacia}`, 'admin')).status, 204);
});

test('solicitudes: dos aprobaciones simultáneas → solo una gana (FOR UPDATE)', async () => {
  const s = await post('/carpetas/solicitudes', 'cumplimiento', { documentoId: docs.A, carpetaId: null, motivo: 'Sacarlo de contratos, no es uno.' });
  const [r1, r2] = await Promise.all([
    post(`/carpetas/solicitudes/${s.cuerpo.id}/aprobar`, 'admin', {}),
    post(`/carpetas/solicitudes/${s.cuerpo.id}/aprobar`, 'operador5', {}),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((await auditorias('aprobar_movimiento', docs.A)).length, 1);
  assert.equal((await fila(`SELECT carpeta_id FROM documentos WHERE id = $1`, [docs.A])).carpeta_id, null);
});

// ---------------------------------------------------------------------------------------------- otros
test('notificaciones: devuelven documentoId; la de papelera usa la etiqueta "Papelera"', async () => {
  const lista = (await get('/notificaciones', 'cumplimiento')).cuerpo;
  const n = lista.find((x) => x.title === 'Solicitud aprobada: Expediente RH.tiff');
  assert.equal(n.documentoId, docs.E);
  assert.deepEqual(n.actions, []);
  assert.equal(lista.find((x) => x.title.startsWith('Carpeta creada')).documentoId, null);
  await base.pool.query(`UPDATE documentos SET estado = 'activo' WHERE id = $1`, [docs.F]);
  assert.equal((await del(`/documentos/${docs.F}`, 'admin')).status, 204);
  const p = (await get('/notificaciones', 'admin')).cuerpo.find((x) => x.title === 'Documento enviado a la Papelera: Fuera.pdf');
  assert.deepEqual([p.badge, p.documentoId], ['Papelera', docs.F]);
});

test('crear usuario: con nivel → 201 (el fallo del formulario era no enviarlo); sin nivel → 400; solo TOTP', async () => {
  const base1 = { nombre: 'Ana Prueba', email: 'ana.f5@prueba.test', password: 'ClaveSegura-2026', rol: 'read-only' };
  let r = await post('/seguridad/usuarios', 'admin', base1);
  assert.deepEqual([r.status, r.cuerpo.error], [400, 'Seleccione un nivel de confidencialidad.']);
  r = await post('/seguridad/usuarios', 'admin', { ...base1, nivel: 'Nivel 2 Confidencial' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const u = await fila(`SELECT n.nombre AS nivel, u.mfa_metodo FROM usuarios u JOIN niveles_acceso n ON n.id = u.nivel_id WHERE u.id = $1`, [r.cuerpo.id]);
  assert.deepEqual(u, { nivel: 'Nivel 2 Confidencial', mfa_metodo: 'TOTP' });
  assert.equal((await post('/seguridad/usuarios', 'cumplimiento', { ...base1, email: 'otra@prueba.test', nivel: 'Nivel 2 Confidencial' })).status, 403);
  r = await post('/seguridad/usuarios', 'admin', { ...base1, email: 'fido@prueba.test', nivel: 'Nivel 2 Confidencial', mfaMetodo: 'FIDO2 Yubikey' });
  assert.equal(r.status, 400);
  assert.match(r.cuerpo.error, /TOTP/);
});
