/**
 * Indexador de texto: cola PERSISTENTE (tabla documento_indexacion) + un único proceso en segundo plano.
 *
 * Flujo:
 *   subida ──(misma transacción que el documento)──► fila "pendiente" ──► despertarIndexador()
 *   bucle: toma 1 pendiente → "procesando" → lee el objeto → extrae en un worker → guarda páginas → "procesado"
 *          | "sin_texto" | "error"  (todo en una transacción; las páginas viejas se reemplazan, nunca se mezclan)
 *
 * Decisiones (Render gratuito y Neon gratuito):
 *  - SEGUNDO PLANO: la subida responde en cuanto el PDF está guardado y validado; un fallo de extracción NUNCA
 *    deshace una subida válida, solo deja el estado "error" con opción de reprocesar.
 *  - UNO A LA VEZ: con 0,1 CPU y 512 MB, dos extracciones en paralelo solo se estorbarían.
 *  - SIN SONDEO PERIÓDICO: no hay setInterval consultando la base. Neon apaga su cómputo tras 5 min sin
 *    consultas; un sondeo cada minuto lo mantendría encendido y gastaría horas de cómputo. Se despierta al
 *    arrancar, tras una subida, al pedir un reproceso y cuando alguien consulta el estado de un pendiente.
 *  - TOLERANTE A REINICIOS: si Render duerme o reinicia el servicio a mitad, la fila queda "procesando" con
 *    iniciado_en antiguo; pasado el umbral se vuelve a tomar. Tras MAX_INTENTOS se marca error (un PDF que
 *    tumba el proceso no se reintenta para siempre).
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { registrarAuditoria } from './audit.js';
import { fechaHoraCO } from './format.js';
import { almacenamiento, ErrorObjetoNoEncontrado } from './storage.js';
import { extraerTextoPdf, LIMITES_TEXTO } from './texto.js';

export const ESTADOS_INDEXACION = ['pendiente', 'procesando', 'procesado', 'sin_texto', 'error'];
export const MAX_INTENTOS = 3;
const MAX_BYTES_LECTURA = 100 * 1024 * 1024; // igual que el tope absoluto de MAX_UPLOAD_MB
const SISTEMA = { user: null, ip: null }; // "petición" para la auditoría de acciones automáticas

let opciones = { limites: {}, extraer: extraerTextoPdf };
let ejecucion = null; // promesa del bucle en curso (null = en reposo)
let otraVuelta = false;
let detenido = false;

/** Umbral para considerar abandonada una fila "procesando" (proceso reiniciado o dormido a mitad). */
const umbralAbandonoSeg = () => Math.ceil(((opciones.limites.tiempoMaximoMs ?? LIMITES_TEXTO.tiempoMaximoMs) + 120_000) / 1000);

/** Solo para pruebas: límites más bajos o un extractor simulado que falla. */
export function configurarIndexador({ limites = {}, extraer = extraerTextoPdf } = {}) {
  opciones = { limites, extraer };
}

/**
 * Deja (o vuelve a dejar) el documento en la cola. Idempotente: si ya estaba, reinicia intentos y error.
 * @param {{ query: Function }} db  pool o cliente de una transacción (la subida lo hace dentro de la suya)
 */
export async function solicitarIndexacion(db, documentoId, { motivo, usuarioId = null }) {
  await db.query(
    `INSERT INTO documento_indexacion (documento_id, estado, motivo, solicitado_por, solicitado_en)
     VALUES ($1, 'pendiente', $2, $3, now())
     ON CONFLICT (documento_id) DO UPDATE
        SET estado = 'pendiente', motivo = EXCLUDED.motivo, solicitado_por = EXCLUDED.solicitado_por,
            solicitado_en = now(), intentos = 0, iniciado_en = NULL, error_codigo = NULL, error = NULL`,
    [documentoId, motivo, usuarioId]);
}

/** Arranca el bucle si está en reposo; si ya corre, le pide una vuelta más. Nunca lanza ni bloquea. */
export function despertarIndexador() {
  if (detenido) return;
  if (ejecucion) {
    otraVuelta = true;
    return;
  }
  otraVuelta = false;
  ejecucion = bucle().finally(() => {
    ejecucion = null;
    if (otraVuelta) despertarIndexador();
  });
}

/** Espera a que la cola quede vacía (pruebas y script de backfill). */
export async function esperarIndexador() {
  while (ejecucion) await ejecucion;
}

/** Deja de tomar trabajos y espera al que esté en curso (apagado ordenado y pruebas). */
export async function detenerIndexador() {
  detenido = true;
  await esperarIndexador();
}

export function reanudarIndexador() {
  detenido = false;
}

async function bucle() {
  try {
    while (!detenido) {
      const trabajo = await tomarSiguiente();
      if (!trabajo) break;
      try {
        await procesar(trabajo);
      } catch (e) {
        // Fallo inesperado con ESTE documento: se marca y se sigue con el siguiente (no bloquea la cola).
        console.error(`Indexador: fallo inesperado con el documento ${trabajo.documento_id}:`, e.message);
        await guardarResultado(trabajo.documento_id, {
          estado: 'error', codigo: 'interno', mensaje: 'Fallo inesperado al extraer el texto. Intenta reprocesar.',
          motivo: trabajo.motivo, inicio: Date.now(),
        });
      }
    }
  } catch (e) {
    // La base no responde (p. ej. Neon despertando): se reintenta en el próximo despertar; la fila sigue en cola.
    console.error('Indexador de texto detenido por un error:', e.message);
  }
}

/** Toma la siguiente fila pendiente (o abandonada) de forma atómica: dos instancias nunca toman la misma. */
async function tomarSiguiente() {
  const { rows: [t] } = await query(
    `UPDATE documento_indexacion i
        SET estado = 'procesando', intentos = i.intentos + 1, iniciado_en = now()
      WHERE i.documento_id = (
              SELECT documento_id FROM documento_indexacion
               WHERE estado = 'pendiente'
                  OR (estado = 'procesando' AND iniciado_en < now() - make_interval(secs => $1))
               ORDER BY solicitado_en, documento_id
               LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING i.documento_id, i.intentos, i.motivo`, [umbralAbandonoSeg()]);
  return t ?? null;
}

/** Lee el objeto completo en un ArrayBuffer propio (se transfiere al worker sin copiarlo) y calcula su SHA-256. */
async function leerObjeto(st, clave, tamanoEsperado) {
  const { stream, tamano } = await st.leer(clave);
  if (tamano > MAX_BYTES_LECTURA || tamano !== tamanoEsperado) {
    stream.destroy?.();
    throw Object.assign(new Error('El tamaño del archivo no coincide con el registrado.'), { codigo: 'integridad' });
  }
  const datos = new Uint8Array(tamano);
  const hash = crypto.createHash('sha256');
  let pos = 0;
  for await (const trozo of stream) {
    if (pos + trozo.length > tamano) {
      stream.destroy?.();
      throw Object.assign(new Error('El archivo es más grande que lo registrado.'), { codigo: 'integridad' });
    }
    datos.set(trozo, pos);
    hash.update(trozo);
    pos += trozo.length;
  }
  if (pos !== tamano) throw Object.assign(new Error('El archivo está incompleto.'), { codigo: 'integridad' });
  return { datos, sha256: hash.digest('hex') };
}

async function procesar({ documento_id: id, intentos, motivo }) {
  const inicio = Date.now();
  const fallar = (codigo, mensaje) => guardarResultado(id, { estado: 'error', codigo, mensaje, motivo, inicio });

  if (intentos > MAX_INTENTOS)
    return fallar('interrumpido', 'La extracción se interrumpió varias veces (posible falta de memoria o reinicio del servidor).');

  const { rows: [d] } = await query(
    `SELECT tiene_archivo, storage_path, storage_driver, tamano_bytes, hash_sha256 FROM documentos WHERE id = $1`, [id]);
  if (!d?.tiene_archivo) return fallar('sin_archivo', 'El documento no tiene archivo original.');

  const st = almacenamiento();
  let leido;
  try {
    if (d.storage_driver !== st.driver) throw new ErrorObjetoNoEncontrado(d.storage_path);
    leido = await leerObjeto(st, d.storage_path, Number(d.tamano_bytes));
  } catch (e) {
    if (e instanceof ErrorObjetoNoEncontrado) return fallar('no_disponible', 'Archivo no disponible en este entorno.');
    if (e.codigo === 'integridad') return fallar('integridad', e.message);
    console.error(`Indexador: no se pudo leer el documento ${id}:`, e.message);
    return fallar('almacenamiento', 'No se pudo leer el archivo del almacenamiento. Intenta reprocesar más tarde.');
  }
  // Solo se indexa el archivo que corresponde a la huella registrada: si alguien lo alteró, no se le cree.
  if (leido.sha256 !== d.hash_sha256.trim())
    return fallar('integridad', 'El archivo no coincide con su huella SHA-256 registrada; no se indexa su texto.');

  const r = await opciones.extraer(leido.datos, opciones.limites);
  leido = null; // el ArrayBuffer ya se transfirió al worker; no retener referencias
  if (r.error) return fallar(r.error.codigo, r.error.mensaje);

  await guardarResultado(id, {
    estado: r.paginas.length ? 'procesado' : 'sin_texto', motivo, inicio, hash: d.hash_sha256.trim(),
    paginas: r.paginas, paginasTotales: r.paginasTotales, limite: r.limite,
  });
}

/**
 * Guarda el resultado en UNA transacción: páginas nuevas (reemplazando las anteriores) + estado. La condición
 * estado = 'procesando' evita pisar una petición de reproceso que llegó mientras tanto.
 */
async function guardarResultado(id, { estado, codigo = null, mensaje = null, motivo, inicio, hash = null, paginas = [], paginasTotales = null, limite = null }) {
  const caracteres = paginas.reduce((n, p) => n + p.texto.length, 0);
  const duracionMs = Date.now() - inicio;
  const guardado = await withTransaction(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE documento_indexacion
          SET estado = $2, procesado_en = now(), hash_sha256 = $3, paginas_totales = $4, paginas_con_texto = $5,
              caracteres = $6, limite = $7, error_codigo = $8, error = $9, duracion_ms = $10
        WHERE documento_id = $1 AND estado = 'procesando'`,
      [id, estado, hash, paginasTotales, paginas.length, caracteres, limite, codigo, mensaje, duracionMs]);
    if (!rowCount) return false;
    if (estado !== 'error') {
      await c.query(`DELETE FROM documento_paginas WHERE documento_id = $1`, [id]);
      if (paginas.length)
        await c.query(
          `INSERT INTO documento_paginas (documento_id, pagina, texto, origen)
           SELECT $1, n, t, 'pdf' FROM unnest($2::int[], $3::text[]) AS x(n, t)`,
          [id, paginas.map((p) => p.pagina), paginas.map((p) => p.texto)]);
    }
    return true;
  });
  if (guardado)
    await registrarAuditoria(SISTEMA, 'indexar_texto', Number(id), {
      resultado: estado, motivo, paginasConTexto: paginas.length, paginasTotales, caracteres, limite,
      ...(codigo ? { error: codigo } : {}), duracionMs,
    });
}

// ------------------------------------------------------------------------------------------ presentación

const ETIQUETAS = {
  pendiente: 'Pendiente', procesando: 'Extrayendo texto…', procesado: 'Texto indexado',
  sin_texto: 'Sin capa de texto', error: 'Error al extraer',
};
const AVISOS_LIMITE = {
  paginas: `Solo se indexaron las primeras ${LIMITES_TEXTO.maxPaginas} páginas.`,
  caracteres: 'Se alcanzó el máximo de texto por documento o por página; el resto no se indexó.',
  tiempo: 'La extracción alcanzó el tiempo máximo; se indexaron las páginas leídas hasta entonces.',
};

/** Forma pública del estado (detalle y GET /:id/indexacion). null = documento sin archivo (texto de demostración). */
export function presentarIndexacion(fila) {
  if (!fila) return null;
  const descripcion = {
    pendiente: 'El texto se extraerá en segundo plano en unos instantes.',
    procesando: 'Se está leyendo el texto del PDF para la búsqueda.',
    procesado: `${fila.paginas_con_texto} de ${fila.paginas_totales} páginas con texto buscable.`,
    sin_texto: 'El PDF no tiene capa de texto (probablemente es un escaneo). No aparecerá en búsquedas por contenido.',
    error: fila.error ?? 'No se pudo extraer el texto.',
  }[fila.estado];
  return {
    estado: fila.estado,
    etiqueta: ETIQUETAS[fila.estado],
    descripcion,
    aviso: fila.estado === 'procesado' && fila.limite ? AVISOS_LIMITE[fila.limite] : null,
    paginasConTexto: fila.paginas_con_texto ?? null,
    paginasTotales: fila.paginas_totales ?? null,
    caracteres: fila.caracteres ?? null,
    errorCodigo: fila.error_codigo ?? null,
    fecha: fechaHoraCO(fila.procesado_en ?? fila.solicitado_en),
  };
}

export const COLUMNAS_INDEXACION =
  'estado, paginas_con_texto, paginas_totales, caracteres, limite, error_codigo, error, procesado_en, solicitado_en';
