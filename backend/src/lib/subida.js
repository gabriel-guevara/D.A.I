/**
 * Recepción de un PDF por multipart/form-data con busboy.
 *
 * Por qué así (Render gratuito = 512 MB de RAM y disco efímero):
 *  - Nada se escribe en el disco del servidor: los bytes van a memoria con un TOPE ESTRICTO (MAX_UPLOAD_MB).
 *    Si el archivo lo supera, se deja de acumular al instante y el resto se descarta.
 *  - La firma "%PDF-" se comprueba con los primeros bytes: un archivo que no es PDF se descarta sin acumularlo.
 *  - El SHA-256 se calcula mientras llegan los trozos, sobre los bytes reales.
 *  - Como mucho MAX_SUBIDAS_SIMULTANEAS subidas a la vez (tomarCupoDeSubida): memoria acotada a N × límite.
 */
import Busboy from 'busboy';
import crypto from 'node:crypto';
import { FIRMA_PDF, MENSAJE_NO_PDF } from './pdf.js';

export class ErrorSubida extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.name = 'ErrorSubida';
    this.status = status;
  }
}

/** Margen para las cabeceras de cada parte y los campos de texto del formulario. */
const MARGEN_MULTIPART = 64 * 1024;
const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

export const MAX_SUBIDAS_SIMULTANEAS = 2;
let subidasEnCurso = 0;

/**
 * Reserva un hueco para procesar una subida. Devuelve la función que lo libera, o null si no hay hueco
 * (la ruta responde 503 sin leer el cuerpo: Node lo descarta sin guardarlo).
 */
export function tomarCupoDeSubida() {
  if (subidasEnCurso >= MAX_SUBIDAS_SIMULTANEAS) return null;
  subidasEnCurso++;
  let liberado = false;
  return () => {
    if (!liberado) {
      liberado = true;
      subidasEnCurso--;
    }
  };
}

/**
 * Lee la petición y devuelve los campos de texto permitidos y el archivo del campo "archivo".
 * @param {import('express').Request} req
 * @param {{ maxBytes: number, camposPermitidos: string[], maxLongitudCampo?: number }} opciones
 * @returns {Promise<{ campos: Record<string,string>, archivo: { buffer: Buffer, nombre: string, tamano: number, sha256: string } }>}
 * @throws {ErrorSubida}
 */
export function recibirPdf(req, { maxBytes, camposPermitidos, maxLongitudCampo = 300 }) {
  return new Promise((resolver, rechazar) => {
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] ?? ''))
      return rechazar(new ErrorSubida(415, 'La subida debe enviarse como multipart/form-data.'));
    const mensajeTamano = `El archivo supera el tamaño máximo permitido (${mb(maxBytes)}).`;
    // Si el propio navegador declara un cuerpo mayor que el límite, se rechaza sin leer ni un byte.
    const declarado = Number(req.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > maxBytes + MARGEN_MULTIPART) return rechazar(new ErrorSubida(413, mensajeTamano));

    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        // Los navegadores envían el nombre del archivo en UTF-8; busboy por defecto lo leería como latin1 ("Ã±" en vez de "ñ").
        defParamCharset: 'utf8',
        limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 12, fieldSize: maxLongitudCampo },
      });
    } catch {
      return rechazar(new ErrorSubida(400, 'Cuerpo multipart no válido.'));
    }

    const campos = {};
    let archivo = null;
    let error = null;
    let terminado = false;
    const fallar = (e) => { error ??= e; };
    const terminar = () => {
      if (terminado) return;
      terminado = true;
      if (error) return rechazar(error);
      if (!archivo) return rechazar(new ErrorSubida(400, 'No se recibió ningún archivo (campo "archivo").'));
      if (archivo.tamano === 0) return rechazar(new ErrorSubida(400, 'El archivo está vacío.'));
      resolver({ campos, archivo });
    };

    bb.on('field', (nombre, valor, info) => {
      if (info.valueTruncated) return fallar(new ErrorSubida(400, `El campo "${nombre}" es demasiado largo.`));
      if (camposPermitidos.includes(nombre)) campos[nombre] = valor;
    });

    bb.on('file', (nombre, stream, info) => {
      if (nombre !== 'archivo' || archivo) {
        stream.resume(); // se descarta sin guardar
        return fallar(new ErrorSubida(400, 'Envía un único archivo en el campo "archivo".'));
      }
      const hash = crypto.createHash('sha256');
      const trozos = [];
      let tamano = 0;
      let firmaRevisada = false;
      let descartar = false;
      archivo = { nombre: info.filename ?? '', tamano: 0 };

      stream.on('data', (trozo) => {
        if (descartar) return;
        tamano += trozo.length;
        trozos.push(trozo);
        hash.update(trozo);
        if (!firmaRevisada && tamano >= FIRMA_PDF.length) {
          firmaRevisada = true;
          if (!Buffer.concat(trozos).subarray(0, FIRMA_PDF.length).equals(FIRMA_PDF)) {
            descartar = true;
            trozos.length = 0;
            fallar(new ErrorSubida(415, MENSAJE_NO_PDF));
          }
        }
      });
      stream.on('limit', () => {
        descartar = true;
        trozos.length = 0; // se libera lo acumulado de inmediato
        fallar(new ErrorSubida(413, mensajeTamano));
      });
      stream.on('end', () => {
        if (descartar) return;
        if (!firmaRevisada && tamano > 0) return fallar(new ErrorSubida(415, MENSAJE_NO_PDF));
        archivo.buffer = Buffer.concat(trozos, tamano);
        archivo.tamano = tamano;
        archivo.sha256 = hash.digest('hex');
      });
    });

    bb.on('filesLimit', () => fallar(new ErrorSubida(400, 'Envía un único archivo en el campo "archivo".')));
    bb.on('fieldsLimit', () => fallar(new ErrorSubida(400, 'El formulario tiene demasiados campos.')));
    bb.on('partsLimit', () => fallar(new ErrorSubida(400, 'El formulario tiene demasiadas partes.')));
    bb.on('error', () => {
      fallar(new ErrorSubida(400, 'Cuerpo multipart no válido o incompleto.'));
      req.unpipe(bb);
      req.resume(); // descarta lo que quede del cuerpo
      terminar();
    });
    bb.on('close', terminar);
    req.on('aborted', () => {
      fallar(new ErrorSubida(400, 'La subida se interrumpió.'));
      terminar();
    });
    req.pipe(bb);
  });
}
