/**
 * Hilo de trabajo (worker_threads) que extrae el texto de un PDF página a página con pdf.js.
 * Lo arranca extraerTextoPdf() (texto.js); nunca se importa desde el hilo principal.
 *
 * Mensajes al hilo principal:
 *   { tipo: 'inicio', paginasTotales }
 *   { tipo: 'pagina', pagina, texto }      (solo páginas con texto; las vacías o escaneadas se omiten)
 *   { tipo: 'fin', limite }                limite: null | 'paginas' | 'caracteres' | 'tiempo'
 *   { tipo: 'error', mensaje }
 * Las páginas se envían una a una: si el hilo principal tiene que cortar por tiempo, conserva lo ya extraído.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { caracteresSignificativos, normalizarTexto, recortar } from './texto-normalizar.js';

const { datos, limites } = workerData;
const limiteTiempo = Date.now() + limites.tiempoMaximoMs;
const enviar = (m) => parentPort.postMessage(m);

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
// "datos" ya es una copia propia (transferida desde el hilo principal): pdf.js puede quedársela.
const tarea = getDocument({ data: datos, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });

try {
  const doc = await tarea.promise;
  enviar({ tipo: 'inicio', paginasTotales: doc.numPages });
  const ultima = Math.min(doc.numPages, limites.maxPaginas);
  let limite = doc.numPages > limites.maxPaginas ? 'paginas' : null;
  let acumulado = 0;

  for (let n = 1; n <= ultima; n++) {
    if (Date.now() > limiteTiempo) {
      limite = 'tiempo';
      break;
    }
    const pagina = await doc.getPage(n);
    let bruto;
    try {
      const contenido = await pagina.getTextContent();
      // hasEOL = pdf.js detectó fin de línea; lo conservamos para poder unir "docu-\nmento".
      bruto = contenido.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
    } finally {
      pagina.cleanup(); // libera fuentes y operadores de la página: memoria estable aunque el PDF tenga 500 páginas
    }
    const limpio = normalizarTexto(bruto);
    if (caracteresSignificativos(limpio) < limites.minCaracteresPagina) continue;

    const cupo = Math.min(limites.maxCaracteresPagina, limites.maxCaracteresDocumento - acumulado);
    const texto = recortar(limpio, cupo);
    if (texto.length < limpio.length) limite ??= 'caracteres';
    if (!texto) break;
    acumulado += texto.length;
    enviar({ tipo: 'pagina', pagina: n, texto });
    if (acumulado >= limites.maxCaracteresDocumento) {
      if (n < ultima) limite = 'caracteres';
      break;
    }
  }
  enviar({ tipo: 'fin', limite });
} catch (e) {
  enviar({ tipo: 'error', mensaje: String(e?.message ?? e).slice(0, 300) });
} finally {
  await tarea.destroy().catch(() => {});
}
