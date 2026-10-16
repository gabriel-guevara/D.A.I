import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { contentDisposition, interpretarRango, sanearNombreArchivo, sha256DeStream } from '../src/lib/archivo-http.js';
import { ErrorPdf, inspeccionarPdf, tieneFirmaPdf } from '../src/lib/pdf.js';
import { MAX_SUBIDAS_SIMULTANEAS, tomarCupoDeSubida } from '../src/lib/subida.js';
import { crearPdf, sha256 } from './helpers/pdf-prueba.js';

test('interpretarRango: formas válidas, ignoradas y no satisfacibles', () => {
  assert.equal(interpretarRango(undefined, 100), undefined);
  assert.deepEqual(interpretarRango('bytes=0-9', 100), { inicio: 0, fin: 9 });
  assert.deepEqual(interpretarRango('bytes=90-', 100), { inicio: 90, fin: 99 });
  assert.deepEqual(interpretarRango('bytes=95-500', 100), { inicio: 95, fin: 99 }); // se recorta al final
  assert.deepEqual(interpretarRango('bytes=-10', 100), { inicio: 90, fin: 99 });
  assert.deepEqual(interpretarRango('bytes=-500', 100), { inicio: 0, fin: 99 });
  for (const ignorada of ['items=0-9', 'bytes=0-1,4-5', 'bytes=-', 'bytes=9-3', 'basura'])
    assert.equal(interpretarRango(ignorada, 100), undefined, ignorada);
  for (const mala of ['bytes=100-', 'bytes=500-600', 'bytes=-0'])
    assert.equal(interpretarRango(mala, 100), 'no-satisfacible', mala);
});

test('sanearNombreArchivo: rutas, control, bidi, reservados, extensión y longitud', () => {
  assert.equal(sanearNombreArchivo('C:\\fakepath\\Acta.pdf'), 'Acta.pdf');
  assert.equal(sanearNombreArchivo('../../etc/passwd'), 'passwd.pdf');
  assert.equal(sanearNombreArchivo('fact\u202Efdp.exe'), 'factfdp.exe.pdf'); // sin el truco de inversión
  assert.equal(sanearNombreArchivo('a<b>:"c"|?*.PDF'), 'a_b___c____.PDF');
  assert.equal(sanearNombreArchivo('  muchos    espacios .pdf  '), 'muchos espacios .pdf');
  assert.equal(sanearNombreArchivo('...'), 'documento.pdf');
  assert.equal(sanearNombreArchivo(undefined), 'documento.pdf');
  assert.equal(sanearNombreArchivo('n\u0303'), '\u00f1.pdf'); // NFC
  const largo = sanearNombreArchivo(`${'á'.repeat(300)}.pdf`);
  assert.equal(Array.from(largo).length, 180);
  assert.ok(largo.endsWith('.pdf'));
});

test('contentDisposition: filename ASCII + filename* UTF-8', () => {
  assert.equal(contentDisposition('attachment', 'Año "fiscal" ñ.pdf'),
    `attachment; filename="Ano _fiscal_ n.pdf"; filename*=UTF-8''A%C3%B1o%20%22fiscal%22%20%C3%B1.pdf`);
  assert.equal(contentDisposition('inline', "o'(x)*.pdf"), `inline; filename="o'(x)*.pdf"; filename*=UTF-8''o%27%28x%29%2A.pdf`);
});

test('sha256DeStream calcula sin acumular', async () => {
  const datos = Buffer.from('abcdef');
  assert.deepEqual(await sha256DeStream(Readable.from([datos.subarray(0, 2), datos.subarray(2)])), { sha256: sha256(datos), bytes: 6 });
});

test('firma PDF e inspección: páginas, protegido, inválido; el buffer queda intacto', async () => {
  assert.equal(tieneFirmaPdf(Buffer.from('%PDF-1.7')), true);
  assert.equal(tieneFirmaPdf(Buffer.from(' %PDF-1.7')), false);
  assert.equal(tieneFirmaPdf(Buffer.from('%PD')), false);

  // Pequeño (Node lo guarda en un bloque compartido) y grande (ArrayBuffer propio, que pdf.js puede TRANSFERIR
  // y dejar vacío). Si el buffer se vaciara, subiríamos un archivo de 0 bytes: esto lo detecta.
  for (const pdf of [crearPdf({ paginas: 5 }), crearPdf({ paginas: 5, relleno: 256 * 1024 })]) {
    const huella = sha256(pdf);
    const tamano = pdf.length;
    assert.deepEqual(await inspeccionarPdf(pdf), { paginas: 5 });
    assert.equal(pdf.length, tamano);
    assert.equal(sha256(pdf), huella);
  }

  await assert.rejects(inspeccionarPdf(crearPdf({ protegido: true })), (e) => e instanceof ErrorPdf && e.codigo === 'protegido' && e.status === 422);
  await assert.rejects(inspeccionarPdf(Buffer.from('%PDF-1.4 roto')), (e) => e instanceof ErrorPdf && e.codigo === 'invalido');
  await assert.rejects(inspeccionarPdf(Buffer.from('GIF89a')), (e) => e instanceof ErrorPdf && e.codigo === 'firma' && e.status === 415);
});

test('cupo de subidas simultáneas: se agota y se libera una sola vez', () => {
  const liberar = Array.from({ length: MAX_SUBIDAS_SIMULTANEAS }, () => tomarCupoDeSubida());
  assert.ok(liberar.every(Boolean));
  assert.equal(tomarCupoDeSubida(), null);
  liberar[0]();
  liberar[0](); // liberar dos veces no regala un cupo extra
  const otra = tomarCupoDeSubida();
  assert.ok(otra);
  assert.equal(tomarCupoDeSubida(), null);
  otra();
  liberar.slice(1).forEach((f) => f());
});
