/**
 * Capa de almacenamiento de archivos: UNA interfaz, dos implementaciones ("drivers").
 *
 *   guardar(clave, cuerpo, { tamano, tipo })  -> { clave, tamano }
 *   info(clave)                               -> { tamano } | null
 *   existe(clave)                             -> boolean
 *   leer(clave, { inicio, fin })              -> { stream, tamano, inicio, fin, longitud }
 *                                                (lanza ErrorObjetoNoEncontrado si no existe)
 *   borrar(clave)                             -> void (idempotente: borrar algo inexistente no falla)
 *
 * El resto del backend solo conoce esta interfaz; cambiar de disco local a R2 es cambiar STORAGE_DRIVER.
 * Las claves las genera SIEMPRE el servidor (generarClaveObjeto): nunca se usa el nombre que envía el usuario.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ErrorEntorno } from './entorno.js';

export const DRIVERS = ['local', 'r2'];
export const SUFIJO_BUCKET_DEV = '-dev';
const RAIZ_LOCAL_POR_DEFECTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.storage');

export class ErrorObjetoNoEncontrado extends Error {
  constructor(clave) {
    super('Archivo no disponible en este entorno');
    this.name = 'ErrorObjetoNoEncontrado';
    this.clave = clave;
    this.status = 404;
  }
}

export class ErrorRangoInvalido extends Error {
  constructor(tamano) {
    super('Rango solicitado no válido');
    this.name = 'ErrorRangoInvalido';
    this.tamano = tamano;
    this.status = 416;
  }
}

// ------------------------------------------------------------------------------------------
// Claves de objeto
// ------------------------------------------------------------------------------------------

/** docs/{documentoId}/{versionId}/{uuid}.pdf — la genera el servidor. */
export function generarClaveObjeto(documentoId, versionId, extension = 'pdf') {
  const id = (v, nombre) => {
    if (!/^\d{1,18}$/.test(String(v))) throw new TypeError(`${nombre} debe ser un id numérico`);
    return String(v);
  };
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new TypeError('extensión no válida');
  return `docs/${id(documentoId, 'documentoId')}/${id(versionId, 'versionId')}/${crypto.randomUUID()}.${extension}`;
}

/**
 * Lista blanca de caracteres y sin segmentos "." / ".." ni "/" inicial: evita path traversal en el
 * driver local y claves raras en R2. Acepta también las claves heredadas ("demo/EXP-.../v3.2").
 */
export function validarClave(clave) {
  if (typeof clave !== 'string' || clave.length === 0 || clave.length > 512) throw new TypeError('clave de objeto no válida');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.\-]*$/.test(clave)) throw new TypeError('clave de objeto no válida');
  if (clave.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new TypeError('clave de objeto no válida');
  return clave;
}

/** Normaliza { inicio, fin } contra el tamaño real (fin inclusivo, como en HTTP Range). */
function resolverRango(tamano, { inicio, fin } = {}) {
  if (inicio === undefined && fin === undefined) return { inicio: 0, fin: Math.max(tamano - 1, 0), parcial: false };
  const i = inicio ?? 0;
  const f = Math.min(fin ?? tamano - 1, tamano - 1);
  if (!Number.isInteger(i) || !Number.isInteger(f) || i < 0 || i > f || i >= tamano) throw new ErrorRangoInvalido(tamano);
  return { inicio: i, fin: f, parcial: true };
}

// ------------------------------------------------------------------------------------------
// Validación de configuración (pura: recibe las variables, no lee process.env por su cuenta)
// ------------------------------------------------------------------------------------------

/**
 * Reglas:
 *  - NODE_ENV=production o APP_ENV=production  => solo "r2" (el disco de Render es efímero).
 *  - "r2" exige R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 *  - APP_ENV=development + r2 => el bucket DEBE terminar en "-dev".
 *  - APP_ENV=production  + r2 => el bucket NO puede terminar en "-dev".
 * @returns configuración lista para crearAlmacenamiento(). Lanza ErrorEntorno con todos los problemas.
 */
export function configAlmacenamientoDesdeEnv(env = process.env) {
  const appEnv = env.APP_ENV;
  const esProduccion = env.NODE_ENV === 'production' || appEnv === 'production';
  const driver = (env.STORAGE_DRIVER || (appEnv === 'development' ? 'local' : '')).trim();
  const problemas = [];

  if (!DRIVERS.includes(driver)) {
    problemas.push(`STORAGE_DRIVER debe ser "local" o "r2" (valor actual: ${driver ? `"${driver}"` : 'sin definir'}).`);
  } else if (driver === 'local' && esProduccion) {
    problemas.push('En producción (NODE_ENV o APP_ENV = production) solo se permite STORAGE_DRIVER=r2: el disco del servidor es efímero.');
  }

  if (driver === 'r2') {
    for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'])
      if (!env[k]?.trim()) problemas.push(`Falta la variable ${k} (requerida con STORAGE_DRIVER=r2).`);
    if (env.R2_ACCOUNT_ID && !/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID.trim()))
      problemas.push('R2_ACCOUNT_ID no tiene el formato esperado (32 caracteres hexadecimales).');
    problemas.push(...erroresReglaBucket(appEnv, env.R2_BUCKET?.trim()));
  }

  if (problemas.length)
    throw new ErrorEntorno(`Configuración de almacenamiento inválida:\n  - ${problemas.join('\n  - ')}`);

  return driver === 'r2'
    ? {
        driver,
        accountId: env.R2_ACCOUNT_ID.trim(),
        accessKeyId: env.R2_ACCESS_KEY_ID.trim(),
        secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim(),
        bucket: env.R2_BUCKET.trim(),
        appEnv,
      }
    : { driver, raiz: RAIZ_LOCAL_POR_DEFECTO, appEnv };
}

/** Regla de buckets: desarrollo SOLO "-dev"; producción NUNCA "-dev". */
export function erroresReglaBucket(appEnv, bucket) {
  if (!bucket) return [];
  const esDev = bucket.endsWith(SUFIJO_BUCKET_DEV);
  if (appEnv === 'development' && !esDev)
    return [`Con APP_ENV=development el bucket debe terminar en "${SUFIJO_BUCKET_DEV}" (actual: "${bucket}"). Así una purga en desarrollo nunca alcanza archivos reales.`];
  if (appEnv === 'production' && esDev)
    return [`Con APP_ENV=production el bucket NO puede terminar en "${SUFIJO_BUCKET_DEV}" (actual: "${bucket}").`];
  if (!['development', 'production'].includes(appEnv))
    return ['APP_ENV debe ser "development" o "production" para usar R2.'];
  return [];
}

// ------------------------------------------------------------------------------------------
// Driver "local": solo desarrollo y pruebas
// ------------------------------------------------------------------------------------------

function crearLocal({ raiz }) {
  const raizAbs = path.resolve(raiz);
  const ruta = (clave) => {
    const p = path.resolve(raizAbs, validarClave(clave));
    if (!p.startsWith(raizAbs + path.sep)) throw new TypeError('clave de objeto no válida');
    return p;
  };
  const info = async (clave) => {
    try {
      const s = await fsp.stat(ruta(clave));
      return s.isFile() ? { tamano: s.size } : null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };

  return {
    driver: 'local',
    async guardar(clave, cuerpo, { tamano } = {}) {
      const destino = ruta(clave);
      await fsp.mkdir(path.dirname(destino), { recursive: true });
      // Se escribe a un temporal y se renombra: nunca queda un archivo a medias con la clave final.
      const tmp = `${destino}.${crypto.randomUUID()}.tmp`;
      try {
        await pipeline(Buffer.isBuffer(cuerpo) ? Readable.from([cuerpo]) : cuerpo, fs.createWriteStream(tmp, { flags: 'wx' }));
        const real = (await fsp.stat(tmp)).size;
        if (tamano !== undefined && real !== tamano) throw new Error(`Tamaño inesperado: ${real} bytes (se esperaban ${tamano})`);
        await fsp.rename(tmp, destino);
        return { clave, tamano: real };
      } catch (e) {
        await fsp.rm(tmp, { force: true });
        throw e;
      }
    },
    info,
    existe: async (clave) => (await info(clave)) !== null,
    async leer(clave, rango) {
      const i = await info(clave);
      if (!i) throw new ErrorObjetoNoEncontrado(clave);
      const r = resolverRango(i.tamano, rango);
      const stream = i.tamano === 0 ? Readable.from([]) : fs.createReadStream(ruta(clave), { start: r.inicio, end: r.fin });
      return { stream, tamano: i.tamano, inicio: r.inicio, fin: r.fin, longitud: i.tamano === 0 ? 0 : r.fin - r.inicio + 1, parcial: r.parcial };
    },
    async borrar(clave) {
      await fsp.rm(ruta(clave), { force: true });
    },
  };
}

// ------------------------------------------------------------------------------------------
// Driver "r2": Cloudflare R2 por su API compatible con S3
// ------------------------------------------------------------------------------------------

async function crearR2({ accountId, accessKeyId, secretAccessKey, bucket }) {
  // Import dinámico: el SDK solo se carga si de verdad se usa R2 (menos memoria en local/pruebas).
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: 'auto', // R2 no usa regiones de AWS; "auto" es el valor documentado
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  const noExiste = (e) => e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;

  const info = async (clave) => {
    try {
      const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: validarClave(clave) }));
      return { tamano: Number(r.ContentLength) };
    } catch (e) {
      if (noExiste(e)) return null;
      throw e;
    }
  };

  return {
    driver: 'r2',
    bucket,
    async guardar(clave, cuerpo, { tamano, tipo = 'application/octet-stream' } = {}) {
      const longitud = Buffer.isBuffer(cuerpo) ? cuerpo.length : tamano;
      // PutObject con un stream necesita conocer la longitud de antemano; sin ella el SDK lo rechaza.
      if (!Number.isInteger(longitud)) throw new TypeError('Para guardar un stream en R2 hay que indicar { tamano }');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: validarClave(clave), Body: cuerpo, ContentLength: longitud, ContentType: tipo }));
      return { clave, tamano: longitud };
    },
    info,
    existe: async (clave) => (await info(clave)) !== null,
    async leer(clave, rango) {
      const i = await info(clave);
      if (!i) throw new ErrorObjetoNoEncontrado(clave);
      const r = resolverRango(i.tamano, rango);
      try {
        const o = await s3.send(new GetObjectCommand({
          Bucket: bucket, Key: clave, ...(r.parcial ? { Range: `bytes=${r.inicio}-${r.fin}` } : {}),
        }));
        return { stream: o.Body, tamano: i.tamano, inicio: r.inicio, fin: r.fin, longitud: i.tamano === 0 ? 0 : r.fin - r.inicio + 1, parcial: r.parcial };
      } catch (e) {
        if (noExiste(e)) throw new ErrorObjetoNoEncontrado(clave); // borrado entre el HEAD y el GET
        throw e;
      }
    },
    async borrar(clave) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: validarClave(clave) }));
    },
  };
}

// ------------------------------------------------------------------------------------------
// Fábrica + instancia compartida
// ------------------------------------------------------------------------------------------

/** Crea un almacenamiento a partir de una configuración ya validada (ver configAlmacenamientoDesdeEnv). */
export async function crearAlmacenamiento(cfg) {
  if (cfg.driver === 'r2') {
    // Defensa en profundidad: la regla de buckets se vuelve a comprobar aquí, justo antes de crear el cliente.
    const errores = erroresReglaBucket(cfg.appEnv, cfg.bucket);
    if (errores.length) throw new ErrorEntorno(errores.join(' '));
    return crearR2(cfg);
  }
  if (cfg.driver === 'local') return crearLocal(cfg);
  throw new ErrorEntorno(`Driver de almacenamiento desconocido: ${cfg.driver}`);
}

let instancia = null;

/** Se llama una vez al arrancar la API. Si la configuración no es válida, lanza y la API no arranca. */
export async function inicializarAlmacenamiento(cfg) {
  instancia = await crearAlmacenamiento(cfg);
  return instancia;
}

/** Almacenamiento de la API (ya inicializado). */
export function almacenamiento() {
  if (!instancia) throw new Error('El almacenamiento no se ha inicializado (inicializarAlmacenamiento).');
  return instancia;
}
