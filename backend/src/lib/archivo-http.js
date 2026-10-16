/**
 * Utilidades para servir y nombrar archivos por HTTP: nombre original saneado, Content-Disposition,
 * cabecera Range y SHA-256 sobre un stream. Funciones puras (salvo sha256DeStream) para probarlas aisladas.
 */
import crypto from 'node:crypto';

const LONGITUD_MAXIMA_NOMBRE = 180;

/**
 * Nombre original "presentable" y seguro. Solo se usa para MOSTRARLO y como nombre de descarga:
 * la clave del objeto en el almacenamiento la genera siempre el servidor (generarClaveObjeto).
 *  - quita rutas ("C:\fakepath\x.pdf", "../../x.pdf"), caracteres de control, de formato bidireccional
 *    (el truco "factura\u202Efdp.exe") y los reservados de Windows
 *  - normaliza a NFC (una "ñ" siempre con los mismos bytes), colapsa espacios y garantiza la extensión .pdf
 */
export function sanearNombreArchivo(nombre, porDefecto = 'documento.pdf') {
  let n = typeof nombre === 'string' ? nombre.normalize('NFC') : '';
  n = n.split(/[\\/]/).pop() ?? '';
  n = n
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!n) n = porDefecto;
  if (!/\.pdf$/i.test(n)) n = `${n}.pdf`;
  const letras = Array.from(n); // por letras, no por unidades UTF-16: no parte emojis ni tildes combinadas
  if (letras.length > LONGITUD_MAXIMA_NOMBRE) n = `${letras.slice(0, LONGITUD_MAXIMA_NOMBRE - 4).join('').trimEnd()}.pdf`;
  return n;
}

/**
 * Content-Disposition con los dos parámetros del RFC 6266: "filename" en ASCII para clientes antiguos y
 * "filename*" en UTF-8 (RFC 8187) para conservar tildes y eñes.
 * @param {'inline'|'attachment'} tipo
 */
export function contentDisposition(tipo, nombre) {
  const ascii = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(nombre).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Interpreta la cabecera Range (RFC 9110 §14). Solo un rango de bytes:
 *   "bytes=0-99" | "bytes=100-" | "bytes=-500" (los últimos 500)
 * @returns {undefined | { inicio: number, fin: number } | 'no-satisfacible'}
 *   undefined: enviar el archivo completo (sin Range, sintaxis desconocida o varios rangos: el RFC permite ignorarla)
 *   'no-satisfacible': responder 416
 */
export function interpretarRango(cabecera, tamano) {
  if (typeof cabecera !== 'string') return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(cabecera.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (m[1] === '') {
    const ultimos = Number(m[2]);
    if (ultimos === 0 || tamano === 0) return 'no-satisfacible';
    return { inicio: Math.max(tamano - ultimos, 0), fin: tamano - 1 };
  }
  const inicio = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < inicio) return undefined; // rango mal formado: se ignora
  if (inicio >= tamano) return 'no-satisfacible';
  return { inicio, fin: m[2] === '' ? tamano - 1 : Math.min(Number(m[2]), tamano - 1) };
}

/** SHA-256 de un stream sin acumularlo en memoria (para la verificación de integridad). */
export async function sha256DeStream(stream) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const trozo of stream) {
    hash.update(trozo);
    bytes += trozo.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}
