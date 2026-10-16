/**
 * Envía un PDF del almacenamiento por HTTP: modo "inline" (visor) o "attachment" (descarga), con Range (206/416).
 * Lo usan el documento actual (GET /documentos/:id/archivo) y cada versión (GET /documentos/:id/versiones/:vid/archivo).
 * Cada acceso se audita: ver_archivo o descargar.
 */
import { pipeline } from 'node:stream/promises';
import { registrarAuditoria } from './audit.js';
import { almacenamiento, ErrorObjetoNoEncontrado, ErrorRangoInvalido } from './storage.js';
import { contentDisposition, interpretarRango } from './archivo-http.js';

export const NO_DISPONIBLE = 'Archivo no disponible en este entorno';

/**
 * @param {{ documentoId: number|string, clave: string, driver: string, tamano: number, nombre: string,
 *           modo: 'inline'|'attachment', detalle?: object }} o
 */
export async function enviarPdf(req, res, { documentoId, clave, driver, tamano, nombre, modo, detalle = {} }) {
  const st = almacenamiento();
  // Subido con otro driver (p. ej. en local y ahora se usa R2): el objeto no está aquí.
  if (driver !== st.driver) return res.status(404).json({ error: NO_DISPONIBLE, codigo: 'no_disponible' });

  const rango = interpretarRango(req.headers.range, tamano);
  const no416 = () => res.status(416).set('Content-Range', `bytes */${tamano}`).json({ error: 'Rango solicitado no válido' });
  if (rango === 'no-satisfacible') return no416();

  let r;
  try {
    r = await st.leer(clave, rango);
  } catch (e) {
    if (e instanceof ErrorObjetoNoEncontrado) return res.status(404).json({ error: NO_DISPONIBLE, codigo: 'no_disponible' });
    if (e instanceof ErrorRangoInvalido) return no416();
    throw e;
  }

  await registrarAuditoria(req, modo === 'attachment' ? 'descargar' : 'ver_archivo', documentoId,
    { ...detalle, ...(r.parcial ? { rango: `${r.inicio}-${r.fin}`, tamano: r.tamano } : { tamano: r.tamano }) });

  res.status(r.parcial ? 206 : 200).set({
    'Content-Type': 'application/pdf',
    'Content-Length': String(r.longitud),
    'Content-Disposition': contentDisposition(modo, nombre),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store', // nunca en cachés compartidas ni en el disco del navegador
    'X-Content-Type-Options': 'nosniff', // el navegador no "adivina" otro tipo
  });
  if (r.parcial) res.set('Content-Range', `bytes ${r.inicio}-${r.fin}/${r.tamano}`);
  if (req.method === 'HEAD') {
    r.stream.destroy?.();
    return res.end();
  }
  try {
    await pipeline(r.stream, res);
  } catch (e) {
    // Cliente que cierra a mitad (cambia de página, cancela): no es un error del servidor.
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Error enviando archivo:', e.message);
    res.destroy();
  }
}
