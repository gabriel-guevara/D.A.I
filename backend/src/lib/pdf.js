/**
 * Validación de PDF en el servidor. Nunca se confía en la extensión ni en el Content-Type que manda el navegador:
 *  1. Firma: los primeros bytes deben ser "%PDF-" (el "número mágico" del formato).
 *  2. Apertura real con pdf.js: si no se puede abrir y contar páginas, no es un PDF utilizable.
 *  3. Si pide contraseña para abrirse, se rechaza: nadie podría verlo en el visor ni indexarlo después.
 */
export const FIRMA_PDF = Buffer.from('%PDF-', 'latin1');

export class ErrorPdf extends Error {
  /** @param {'firma'|'protegido'|'invalido'|'tiempo'} codigo */
  constructor(codigo, mensaje) {
    super(mensaje);
    this.name = 'ErrorPdf';
    this.codigo = codigo;
    this.status = codigo === 'firma' ? 415 : 422;
  }
}

export const MENSAJE_NO_PDF = 'El archivo no es un PDF: su contenido no empieza por la firma "%PDF-" (la extensión o el tipo declarado no bastan).';

/** ¿Empiezan los bytes por "%PDF-"? */
export const tieneFirmaPdf = (buf) => Buffer.isBuffer(buf) && buf.length >= FIRMA_PDF.length && buf.subarray(0, FIRMA_PDF.length).equals(FIRMA_PDF);

// pdf.js pesa varios MB en memoria: se carga la primera vez que se necesita, no al arrancar la API.
let pdfjs = null;
const cargarPdfjs = async () => (pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs'));

/**
 * Abre el PDF y cuenta sus páginas. No renderiza nada (no necesita canvas ni fuentes).
 * @param {Buffer} buf bytes completos del archivo (ya limitados por MAX_UPLOAD_MB)
 * @returns {Promise<{ paginas: number }>}
 * @throws {ErrorPdf}
 */
export async function inspeccionarPdf(buf, { tiempoMaximoMs = 15_000 } = {}) {
  if (!tieneFirmaPdf(buf)) throw new ErrorPdf('firma', MENSAJE_NO_PDF);
  const { getDocument } = await cargarPdfjs();
  // COPIA de los bytes: pdf.js TRANSFIERE el ArrayBuffer que recibe y lo deja vacío (byteLength 0). Si le
  // pasáramos el original, después subiríamos un archivo de 0 bytes. Duplica la memoria solo mientras se
  // analiza (como mucho 2 × MAX_UPLOAD_MB por subida); la copia se libera al terminar.
  const tarea = getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false, // nunca evaluar código generado a partir del archivo
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0, // solo errores en la consola
  });
  let temporizador;
  try {
    const doc = await Promise.race([
      tarea.promise,
      new Promise((_, rechazar) => {
        temporizador = setTimeout(
          () => rechazar(new ErrorPdf('tiempo', 'El PDF tardó demasiado en analizarse; puede estar dañado.')), tiempoMaximoMs);
      }),
    ]);
    if (!Number.isInteger(doc.numPages) || doc.numPages < 1) throw new ErrorPdf('invalido', 'El PDF no contiene páginas.');
    return { paginas: doc.numPages };
  } catch (e) {
    if (e instanceof ErrorPdf) throw e;
    if (e?.name === 'PasswordException')
      throw new ErrorPdf('protegido',
        'El PDF está protegido con contraseña de apertura. Quita la contraseña (por ejemplo, abriéndolo y usando "Imprimir como PDF") y vuelve a subirlo.');
    throw new ErrorPdf('invalido', 'El archivo no se pudo abrir como PDF: está dañado o su estructura no es válida.');
  } finally {
    clearTimeout(temporizador);
    await tarea.destroy().catch(() => {});
  }
}
