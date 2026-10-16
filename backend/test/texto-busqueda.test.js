/**
 * Fase 2 de punta a punta: la app REAL por HTTP, PostgreSQL en un esquema temporal y el driver "local".
 * Subida → extracción en segundo plano → documento_paginas → búsqueda con acceso por nivel, reprocesos y backfill.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { crearPdf } from './helpers/pdf-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.MAX_UPLOAD_MB = '5';
process.env.STORAGE_DRIVER = 'local';

let base, servidor, url, raiz, st, db, ix, migrate;
const tokens = {};

before(async () => {
  base = await crearBaseDePrueba();
  db = await import('../src/db.js');
  db.usarPool(base.pool);
  migrate = await import('../src/migrate.js');
  await migrate.aplicarMigraciones(base.pool, { log: () => {} });
  const storage = await import('../src/lib/storage.js');
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'dai-texto-'));
  st = await storage.inicializarAlmacenamiento({ driver: 'local', raiz });
  ix = await import('../src/lib/indexador.js');

  const { firmarToken } = await import('../src/middleware/auth.js');
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
  await ix?.detenerIndexador(); // nada en segundo plano después de cerrar el pool
  await new Promise((r) => servidor?.close(r));
  await db?.pool.end();
  await base?.cerrar();
  await fs.rm(raiz, { recursive: true, force: true });
});

beforeEach(() => ix.configurarIndexador()); // cada prueba empieza con el extractor y límites reales

// ---------------------------------------------------------------------------------------------- utilidades
const auth = (quien) => ({ Authorization: `Bearer ${tokens[quien]}` });
const get = async (ruta, quien = 'admin') => {
  const r = await fetch(`${url}${ruta}`, { headers: auth(quien) });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
};
const post = async (ruta, quien) => {
  const r = await fetch(`${url}${ruta}`, { method: 'POST', headers: auth(quien) });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
};

async function subir({ textos, paginas, clasificacion = 'Uso Interno General', quien = 'admin', nombre = 'doc.pdf' }) {
  const f = new FormData();
  f.append('clasificacion', clasificacion);
  // relleno: ArrayBuffer propio, como un PDF real (ver el hallazgo del buffer transferido de la Fase 1)
  f.append('archivo', new Blob([crearPdf({ textos, paginas, relleno: 64 * 1024 })], { type: 'application/pdf' }), nombre);
  const r = await fetch(`${url}/digitalizacion/documentos`, { method: 'POST', headers: auth(quien), body: f });
  const cuerpo = await r.json();
  assert.equal(r.status, 201, JSON.stringify(cuerpo));
  return cuerpo;
}
/** Sube y espera a que el indexador termine. */
async function subirIndexado(opciones) {
  const doc = await subir(opciones);
  await ix.esperarIndexador();
  return doc;
}
const estado = async (id) => (await base.pool.query(`SELECT * FROM documento_indexacion WHERE documento_id = $1`, [id])).rows[0];
const paginasDe = async (id) =>
  (await base.pool.query(`SELECT pagina, texto, origen FROM documento_paginas WHERE documento_id = $1 ORDER BY pagina`, [id])).rows;
const auditorias = async (accion, id) =>
  (await base.pool.query(`SELECT a.detalle, u.email FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
                           WHERE a.accion = $1 AND a.documento_id = $2 ORDER BY a.id`, [accion, id])).rows;
const buscar = async (q, quien = 'admin', algoritmo = 'semantica') =>
  (await get(`/busqueda?q=${encodeURIComponent(q)}&algoritmo=${algoritmo}`, quien)).cuerpo;
const silenciarConsola = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

// ---------------------------------------------------------------------------------------------- extracción
test('la subida deja el texto real de cada página en documento_paginas (tildes, ñ, origen pdf) y lo audita', async () => {
  const doc = await subir({ textos: [['Contrato de arrendamiento con el señor Muñoz', 'en Bogotá.'], null, 'Cláusula de penalización por incumplimiento'] });
  assert.equal(doc.indexacion, 'pendiente'); // la respuesta no espera a la extracción
  await ix.esperarIndexador();

  assert.deepEqual(await paginasDe(doc.id), [
    { pagina: 1, texto: 'Contrato de arrendamiento con el señor Muñoz\nen Bogotá.', origen: 'pdf' },
    { pagina: 3, texto: 'Cláusula de penalización por incumplimiento', origen: 'pdf' },
  ]);
  const e = await estado(doc.id);
  assert.equal(e.estado, 'procesado');
  assert.equal(e.motivo, 'subida');
  assert.equal(e.paginas_totales, 3);
  assert.equal(e.paginas_con_texto, 2);
  assert.equal(e.hash_sha256, doc.hash);
  assert.equal(e.limite, null);

  const [a] = await auditorias('indexar_texto', doc.id);
  assert.equal(a.email, null); // acción del sistema
  assert.equal(a.detalle.resultado, 'procesado');
  assert.equal(a.detalle.paginasConTexto, 2);

  const det = (await get(`/documentos/${doc.id}`)).cuerpo;
  assert.equal(det.textoOrigen, 'pdf');
  assert.equal(det.indexacion.estado, 'procesado');
  assert.equal(det.indexacion.descripcion, '2 de 3 páginas con texto buscable.');
  assert.equal(det.puedeReindexar, true);
});

test('PDF escaneado (sin capa de texto): estado sin_texto, sin páginas', async () => {
  const doc = await subirIndexado({ paginas: 3 });
  assert.equal((await estado(doc.id)).estado, 'sin_texto');
  assert.deepEqual(await paginasDe(doc.id), []);
  const det = (await get(`/documentos/${doc.id}`)).cuerpo;
  assert.equal(det.indexacion.estado, 'sin_texto');
  assert.match(det.indexacion.descripcion, /escaneo/);
});

test('PDF grande con límites: se indexan las primeras páginas y se avisa', async () => {
  ix.configurarIndexador({ limites: { maxPaginas: 4 } });
  const textos = Array.from({ length: 30 }, (_, i) => `Página número ${i + 1} del informe anual de auditoría`);
  const doc = await subirIndexado({ textos });
  const e = await estado(doc.id);
  assert.equal(e.estado, 'procesado');
  assert.equal(e.limite, 'paginas');
  assert.equal(e.paginas_totales, 30);
  assert.deepEqual((await paginasDe(doc.id)).map((p) => p.pagina), [1, 2, 3, 4]);
  assert.match((await get(`/documentos/${doc.id}`)).cuerpo.indexacion.aviso, /primeras/);
});

test('un fallo de extracción NO deshace la subida: documento y archivo siguen; estado error', async () => {
  ix.configurarIndexador({ extraer: async () => { throw new Error('se cayó el extractor'); } });
  const doc = await silenciarConsola(() => subirIndexado({ textos: ['texto que no llegará'] }));
  const { rows: [d] } = await base.pool.query(`SELECT tiene_archivo, storage_path FROM documentos WHERE id = $1`, [doc.id]);
  assert.equal(d.tiene_archivo, true);
  assert.equal(await st.existe(d.storage_path), true);
  assert.equal((await fetch(`${url}/documentos/${doc.id}/archivo`, { headers: auth('admin') })).status, 200);
  assert.equal((await estado(doc.id)).error_codigo, 'interno'); // excepción inesperada: error, y la cola sigue
  // El caso normal (el extractor devuelve un error) queda registrado con su código:
  ix.configurarIndexador({ extraer: async () => ({ error: { codigo: 'memoria', mensaje: 'Sin memoria.' }, paginas: [] }) });
  const otro = await subirIndexado({ textos: ['otro texto'] });
  const e = await estado(otro.id);
  assert.equal(e.estado, 'error');
  assert.equal(e.error_codigo, 'memoria');
  assert.equal((await get(`/documentos/${otro.id}`)).cuerpo.indexacion.estado, 'error');
  assert.equal((await auditorias('indexar_texto', otro.id))[0].detalle.error, 'memoria');
});

test('objeto inexistente en el entorno o con otro driver: error claro "no_disponible", sin fallar', async () => {
  const doc = await subirIndexado({ textos: ['algo'] });
  const { rows: [d] } = await base.pool.query(`SELECT storage_path FROM documentos WHERE id = $1`, [doc.id]);
  await st.borrar(d.storage_path);
  await ix.solicitarIndexacion(base.pool, doc.id, { motivo: 'script' });
  ix.despertarIndexador();
  await ix.esperarIndexador();
  let e = await estado(doc.id);
  assert.equal(e.estado, 'error');
  assert.equal(e.error_codigo, 'no_disponible');
  assert.equal(e.error, 'Archivo no disponible en este entorno.');
  assert.equal((await paginasDe(doc.id)).length, 1, 'un error no borra el texto que ya había');

  const otro = await subirIndexado({ textos: ['algo más'] });
  await base.pool.query(`UPDATE documentos SET storage_driver = 'r2' WHERE id = $1`, [otro.id]);
  await ix.solicitarIndexacion(base.pool, otro.id, { motivo: 'script' });
  ix.despertarIndexador();
  await ix.esperarIndexador();
  e = await estado(otro.id);
  assert.equal(e.error_codigo, 'no_disponible');
});

test('archivo alterado (no coincide con su SHA-256): no se indexa', async () => {
  const doc = await subirIndexado({ textos: ['original'] });
  const { rows: [d] } = await base.pool.query(`SELECT storage_path, tamano_bytes FROM documentos WHERE id = $1`, [doc.id]);
  const alterado = await (await st.leer(d.storage_path)).stream.toArray().then(Buffer.concat);
  alterado[100] ^= 0xff;
  await st.guardar(d.storage_path, alterado);
  await ix.solicitarIndexacion(base.pool, doc.id, { motivo: 'script' });
  ix.despertarIndexador();
  await ix.esperarIndexador();
  assert.equal((await estado(doc.id)).error_codigo, 'integridad');
});

test('fila "procesando" abandonada (reinicio) se retoma; tras MAX_INTENTOS se marca interrumpido', async () => {
  const doc = await subirIndexado({ textos: ['Expediente retomado tras reinicio'] });
  await base.pool.query(`DELETE FROM documento_paginas WHERE documento_id = $1`, [doc.id]);
  await base.pool.query(`UPDATE documento_indexacion SET estado = 'procesando', intentos = 1, iniciado_en = now() - interval '1 hour'
                          WHERE documento_id = $1`, [doc.id]);
  ix.despertarIndexador();
  await ix.esperarIndexador();
  assert.equal((await estado(doc.id)).estado, 'procesado');
  assert.equal((await paginasDe(doc.id)).length, 1);

  // Reciente (otra instancia trabajando en él): NO se toma.
  await base.pool.query(`UPDATE documento_indexacion SET estado = 'procesando', iniciado_en = now() WHERE documento_id = $1`, [doc.id]);
  ix.despertarIndexador();
  await ix.esperarIndexador();
  assert.equal((await estado(doc.id)).estado, 'procesando');

  await base.pool.query(`UPDATE documento_indexacion SET intentos = ${ix.MAX_INTENTOS}, iniciado_en = now() - interval '1 hour'
                          WHERE documento_id = $1`, [doc.id]);
  ix.despertarIndexador();
  await ix.esperarIndexador();
  const e = await estado(doc.id);
  assert.equal(e.estado, 'error');
  assert.equal(e.error_codigo, 'interrumpido');
});

// ---------------------------------------------------------------------------------------------- reproceso
test('reprocesar: roles, nivel, documentos sin archivo, en proceso, idempotencia y auditoría', async () => {
  ix.configurarIndexador({ extraer: async () => ({ error: { codigo: 'pdf', mensaje: 'No se pudo leer el texto del PDF.' }, paginas: [] }) });
  const doc = await subirIndexado({ textos: ['Acta de la junta directiva'], clasificacion: 'Confidencial Nivel 2' });
  assert.equal((await estado(doc.id)).estado, 'error');
  ix.configurarIndexador();

  for (const quien of ['cumplimiento', 'lector3', 'lector2']) assert.equal((await post(`/documentos/${doc.id}/reindexar`, quien)).status, 403, quien);
  const secreto = await subirIndexado({ textos: ['Plan secreto'], clasificacion: 'Secreto Corporativo' });
  assert.equal((await post(`/documentos/${secreto.id}/reindexar`, 'operador')).status, 404); // nivel 2 < 5

  ix.detenerIndexador(); // así se observa el "pendiente" antes de que el indexador lo procese
  const r = await post(`/documentos/${doc.id}/reindexar`, 'operador');
  assert.equal(r.status, 202);
  assert.equal(r.cuerpo.estado, 'pendiente');
  assert.equal((await post(`/documentos/${doc.id}/reindexar`, 'operador')).status, 202); // doble clic: sin duplicar
  const a = await auditorias('reindexar_texto', doc.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].email, 'operador@prueba.test');
  assert.equal(a[0].detalle.estadoAnterior, 'error');
  assert.equal((await estado(doc.id)).motivo, 'reproceso');

  ix.reanudarIndexador();
  ix.despertarIndexador();
  await ix.esperarIndexador();
  assert.equal((await estado(doc.id)).estado, 'procesado');
  assert.equal((await get(`/documentos/${doc.id}/indexacion`, 'lector2')).cuerpo.estado, 'procesado');
  assert.equal((await post(`/documentos/${doc.id}/reindexar`, 'admin')).status, 202);
  await ix.esperarIndexador();

  await base.pool.query(`UPDATE documento_indexacion SET estado = 'procesando', iniciado_en = now() WHERE documento_id = $1`, [doc.id]);
  const enProceso = await post(`/documentos/${doc.id}/reindexar`, 'admin');
  assert.equal(enProceso.status, 409);
  assert.equal(enProceso.cuerpo.codigo, 'en_proceso');
  await base.pool.query(`UPDATE documento_indexacion SET estado = 'procesado' WHERE documento_id = $1`, [doc.id]);

  const { rows: [demo] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre) VALUES ('Demo', 'EXP-DEMO-RX', 'pdf', 3, 'X') RETURNING id`);
  assert.equal((await post(`/documentos/${demo.id}/reindexar`, 'admin')).status, 409);
  const detDemo = (await get(`/documentos/${demo.id}`)).cuerpo;
  assert.equal(detDemo.indexacion, null);
  assert.equal(detDemo.textoOrigen, 'demo');
  assert.equal(detDemo.puedeReindexar, false);
});

test('GET /indexacion: mismo acceso que el detalle y sin auditoría ni notificaciones', async () => {
  const doc = await subirIndexado({ textos: ['Informe técnico'], clasificacion: 'Secreto Corporativo' });
  assert.equal((await get(`/documentos/${doc.id}/indexacion`, 'lector3')).status, 404);
  const r = await get(`/documentos/${doc.id}/indexacion`, 'admin');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.estado, 'procesado');
  assert.equal((await auditorias('ver_documento', doc.id)).length, 0);
});

// ---------------------------------------------------------------------------------------------- backfill
test('backfill (migración 003): documentos con archivo previos quedan pendientes y se procesan; idempotente', async () => {
  const doc = await subirIndexado({ textos: ['Documento de la fase uno sobre presupuesto'] });
  // Simula un documento subido en la Fase 1: sin fila de indexación ni páginas.
  await base.pool.query(`DELETE FROM documento_indexacion WHERE documento_id = $1`, [doc.id]);
  await base.pool.query(`DELETE FROM documento_paginas WHERE documento_id = $1`, [doc.id]);
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '003_texto_indexacion'`);
  const antes = (await base.pool.query(`SELECT count(*)::int AS n FROM documento_indexacion`)).rows[0].n;

  assert.deepEqual(await migrate.aplicarMigraciones(base.pool, { log: () => {} }), ['003_texto_indexacion']);
  let e = await estado(doc.id);
  assert.equal(e.estado, 'pendiente');
  assert.equal(e.motivo, 'backfill');
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM documento_indexacion`)).rows[0].n, antes + 1); // no toca los demás

  ix.despertarIndexador();
  await ix.esperarIndexador();
  assert.equal((await estado(doc.id)).estado, 'procesado');
  // Repetir el backfill (script --todos) no duplica páginas.
  for (let i = 0; i < 2; i++) {
    await ix.solicitarIndexacion(base.pool, doc.id, { motivo: 'script' });
    ix.despertarIndexador();
    await ix.esperarIndexador();
  }
  assert.equal((await paginasDe(doc.id)).length, 1);
  assert.equal((await auditorias('indexar_texto', doc.id)).at(-1).detalle.motivo, 'script');
});

// ---------------------------------------------------------------------------------------------- búsqueda
test('búsqueda semántica: texto real, página exacta, fragmento resaltado en segmentos y origen', async () => {
  const doc = await subirIndexado({
    nombre: 'Póliza.pdf',
    textos: ['Portada sin datos relevantes', ['Condiciones generales de la póliza.', 'El asegurado deberá notificar el siniestro', 'en un plazo máximo de diez días hábiles.']],
  });
  const res = await buscar('siniestros notificados');
  const r = res.find((x) => x.docId === doc.id);
  assert.ok(r, 'el documento debe aparecer');
  assert.equal(r.numeroPagina, 2);
  assert.equal(r.pagina, 'Página 2');
  assert.equal(r.origenTexto, 'pdf');
  assert.equal(r.origenEtiqueta, 'Texto extraído del PDF');
  assert.equal(r.paginasCoincidentes, 1);
  const resaltados = r.segmentos.filter((s) => s.resaltado).map((s) => s.texto.toLowerCase());
  assert.ok(resaltados.includes('siniestro') && resaltados.includes('notificar'), JSON.stringify(r.segmentos));
  assert.ok(r.segmentos.every((s) => !/[\u0000-\u001f]/.test(s.texto)), 'sin marcas ni saltos en los segmentos');
  assert.equal(r.before, undefined); // formato antiguo retirado
});

test('búsqueda exacta: posición, fragmento cortado en SQL con tildes y comodines escapados', async () => {
  const doc = await subirIndexado({ textos: [['Introducción', 'La compañía acordó el 100% de la inversión en Medellín.']] });
  const r = (await buscar('inversión en Medellín', 'admin', 'exacta')).find((x) => x.docId === doc.id);
  assert.ok(r);
  assert.equal(r.numeroPagina, 1);
  assert.deepEqual(r.segmentos.filter((s) => s.resaltado), [{ texto: 'inversión en Medellín', resaltado: true }]);
  assert.match(r.segmentos[0].texto, /acordó el 100% de la $/);
  // "%" y "_" son literales, no comodines de LIKE
  assert.ok((await buscar('100%', 'admin', 'exacta')).some((x) => x.docId === doc.id));
  assert.ok(!(await buscar('1_0', 'admin', 'exacta')).some((x) => x.docId === doc.id));
});

test('búsqueda con acceso por nivel: quien no alcanza el nivel no ve resultados; papelera tampoco', async () => {
  const secreto = await subirIndexado({ textos: ['Estrategia de adquisición hostil zafiro'], clasificacion: 'Secreto Corporativo' });
  const confidencial = await subirIndexado({ textos: ['Nómina confidencial zafiro'], clasificacion: 'Confidencial Nivel 2' });
  const ids = async (quien, alg) => (await buscar('zafiro', quien, alg)).map((r) => r.docId);
  for (const alg of ['semantica', 'exacta']) {
    assert.deepEqual((await ids('admin', alg)).sort(), [secreto.id, confidencial.id].sort(), alg);
    for (const quien of ['cumplimiento', 'lector3', 'lector2', 'operador']) assert.deepEqual(await ids(quien, alg), [confidencial.id], `${quien} ${alg}`);
  }
  await base.pool.query(`UPDATE documentos SET estado = 'papelera' WHERE id = $1`, [confidencial.id]);
  assert.deepEqual(await ids('admin', 'semantica'), [secreto.id]);
  // Sin q tampoco se listan
  const todos = (await get('/busqueda', 'lector2')).cuerpo.map((r) => r.docId);
  assert.ok(!todos.includes(secreto.id) && !todos.includes(confidencial.id));
});

test('texto de demostración y manual se distinguen del extraído del PDF', async () => {
  const { rows: [demo] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre) VALUES ('Demo', 'EXP-DEMO-TX', 'pdf', 3, 'X') RETURNING id`);
  await base.pool.query(`INSERT INTO documento_paginas (documento_id, pagina, texto) VALUES ($1, 1, 'Texto inventado sobre catastro rural')`, [demo.id]);
  const pdf = await subirIndexado({ textos: ['Registro de catastro rural real'] });
  const res = await buscar('catastro rural');
  assert.equal(res.find((r) => r.docId === demo.id).origenTexto, 'demo'); // valor por defecto de la columna
  assert.equal(res.find((r) => r.docId === demo.id).origenEtiqueta, 'Texto de demostración');
  assert.equal(res.find((r) => r.docId === pdf.id).origenTexto, 'pdf');

  const facetas = (await get('/busqueda/facetas', 'admin')).cuerpo;
  assert.ok(facetas.documentosConTexto >= facetas.documentosConTextoReal && facetas.documentosConTextoReal >= 1);
});

test('aprobación OCR heredada: el texto manual se limpia, se limita y queda con origen manual', async () => {
  const { rows: [t] } = await base.pool.query(`INSERT INTO ocr_trabajos (nombre_archivo, estado) VALUES ('escaneo.pdf', 'en_foco') RETURNING id`);
  const r = await fetch(`${url}/digitalizacion/trabajos/${t.id}/aprobar`, {
    method: 'POST', headers: { ...auth('operador'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ textoRaw: `Acta\u0000  de   entrega${' palabra'.repeat(3000)}`, clasificacion: 'Uso Interno General' }),
  });
  const { documentoId } = await r.json();
  assert.equal(r.status, 200);
  const [p] = await paginasDe(documentoId);
  assert.equal(p.origen, 'manual');
  assert.ok(p.texto.startsWith('Acta de entrega palabra'));
  assert.ok(p.texto.length <= 10_000);
});

test('términos raros no rompen la búsqueda: solo palabras vacías, comillas, operadores y 1.000 caracteres', async () => {
  for (const q of ['de la el', `"'!&|:*()`, 'x'.repeat(1000), '<script>alert(1)</script>'])
    for (const alg of ['semantica', 'exacta']) {
      const r = await get(`/busqueda?q=${encodeURIComponent(q)}&algoritmo=${alg}`);
      assert.equal(r.status, 200, `${alg} ${q.slice(0, 20)}`);
      assert.ok(Array.isArray(r.cuerpo));
    }
  const { rows: [b] } = await base.pool.query(`SELECT max(char_length(termino))::int AS n FROM busquedas`);
  assert.ok(b.n <= 200);
});
