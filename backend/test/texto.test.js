/**
 * Fase 2, unidad: limpieza del texto y extracción por página en el worker (sin base de datos).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caracteresSignificativos, normalizarTexto, recortar } from '../src/lib/texto-normalizar.js';
import { extraerTextoPdf, LIMITES_TEXTO } from '../src/lib/texto.js';
import { crearPdf } from './helpers/pdf-prueba.js';

/** Bytes en un ArrayBuffer propio, como los entrega el indexador (se transfieren al worker). */
const propio = (buf) => new Uint8Array(buf);

// ---------------------------------------------------------------------------------------------- normalización
test('normalizarTexto: espacios, control, invisibles, ligaduras y guiones de fin de línea', () => {
  assert.equal(normalizarTexto('  Hola \t   mundo  '), 'Hola mundo');
  assert.equal(normalizarTexto('a\u0000b\u0007c\u009Fd'), 'a b c d'); // \u0000 haría fallar a PostgreSQL
  assert.equal(normalizarTexto('pa­la​bra﻿'), 'palabra');
  assert.equal(normalizarTexto('ﬁnanzas ﬂujo'), 'finanzas flujo'); // ligaduras → NFKC
  assert.equal(normalizarTexto('el docu-\nmento y la ac-\nción'), 'el documento y la acción');
  assert.equal(normalizarTexto('Norte-\nSur'), 'Norte-\nSur'); // mayúscula detrás: se respeta
  assert.equal(normalizarTexto('línea 1  \n   línea 2\n\n\n\n\nfin'), 'línea 1\nlínea 2\n\nfin');
  assert.equal(normalizarTexto('a\r\nb c'), 'a\nb\nc');
  assert.equal(normalizarTexto('roto \uD800 aquí'), 'roto � aquí'); // sustituto suelto → U+FFFD
  assert.equal(normalizarTexto('gliforaro'), 'gliforaro'); // uso privado
  assert.equal(normalizarTexto('Señor Muñoz'), 'Señor Muñoz');
  assert.equal(normalizarTexto('Señor'), 'Señor'); // n + tilde combinable → ñ precompuesta
  assert.equal(normalizarTexto(null), '');
});

test('recortar no parte palabras y caracteresSignificativos cuenta letras y números', () => {
  assert.equal(recortar('uno dos tres cuatro', 12), 'uno dos tres');
  assert.equal(recortar('uno dos tres cuatro', 14), 'uno dos tres');
  assert.equal(recortar('corto', 50), 'corto');
  assert.equal(recortar('abcdefghij', 4), 'abcd');
  assert.equal(recortar('lo que sea', 0), '');
  assert.equal(caracteresSignificativos(' - . 3 ñ'), 2);
});

// ---------------------------------------------------------------------------------------------- extracción
test('extrae el texto real de cada página con tildes y ñ, une guiones y omite páginas sin texto', async () => {
  const pdf = crearPdf({
    textos: [['Señor Muñoz: acción (urgente)', 'Información del docu-', 'mento en Bogotá'], null, 'Página tres: año fiscal 2026'],
    relleno: 64 * 1024,
  });
  const datos = propio(pdf);
  const r = await extraerTextoPdf(datos);
  assert.equal(r.error, null);
  assert.equal(r.paginasTotales, 3);
  assert.equal(r.limite, null);
  assert.deepEqual(r.paginas, [
    { pagina: 1, texto: 'Señor Muñoz: acción (urgente)\nInformación del documento en Bogotá' },
    { pagina: 3, texto: 'Página tres: año fiscal 2026' },
  ]);
  // Los bytes se TRANSFIRIERON al worker: aquí quedan vacíos (por eso el indexador nunca reutiliza "datos").
  assert.equal(datos.byteLength, 0);
  assert.ok(pdf.length > 64 * 1024, 'el original del llamador no se toca');
});

test('PDF sin capa de texto (escaneado): ninguna página', async () => {
  const r = await extraerTextoPdf(propio(crearPdf({ paginas: 4, relleno: 64 * 1024 })));
  assert.equal(r.error, null);
  assert.equal(r.paginasTotales, 4);
  assert.deepEqual(r.paginas, []);
});

test('límites: páginas, caracteres por página y por documento', async () => {
  const largo = Array.from({ length: 40 }, (_, i) => `línea ${i} con bastante texto de relleno para crecer`);
  const pdf = crearPdf({ textos: Array.from({ length: 12 }, () => largo), relleno: 64 * 1024 });

  let r = await extraerTextoPdf(propio(pdf), { maxPaginas: 5 });
  assert.equal(r.limite, 'paginas');
  assert.equal(r.paginasTotales, 12);
  assert.deepEqual(r.paginas.map((p) => p.pagina), [1, 2, 3, 4, 5]);

  r = await extraerTextoPdf(propio(pdf), { maxCaracteresPagina: 100 });
  assert.equal(r.limite, 'caracteres');
  assert.equal(r.paginas.length, 12);
  assert.ok(r.paginas.every((p) => p.texto.length <= 100));

  r = await extraerTextoPdf(propio(pdf), { maxCaracteresDocumento: 3000 });
  assert.equal(r.limite, 'caracteres');
  assert.ok(r.paginas.length < 12);
  assert.ok(r.paginas.reduce((n, p) => n + p.texto.length, 0) <= 3000);
});

test('tiempo agotado sin texto es un error; los fallos vuelven como error y nunca rechazan', async () => {
  let r = await extraerTextoPdf(propio(crearPdf({ textos: ['hola mundo'], relleno: 64 * 1024 })), { tiempoMaximoMs: 0 });
  assert.equal(r.error?.codigo, 'tiempo');

  r = await extraerTextoPdf(propio(Buffer.from('%PDF-1.7\nesto no es un pdf\n')));
  assert.equal(r.error?.codigo, 'pdf');
  assert.deepEqual(r.paginas, []);
});

test('los límites por defecto son los documentados', () => {
  assert.deepEqual({ ...LIMITES_TEXTO }, {
    maxPaginas: 500, maxCaracteresPagina: 10_000, maxCaracteresDocumento: 500_000,
    minCaracteresPagina: 3, tiempoMaximoMs: 180_000, memoriaMb: 192,
  });
});
