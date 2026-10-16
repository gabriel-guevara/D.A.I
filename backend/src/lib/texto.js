/**
 * Extracción del texto de un PDF en un HILO APARTE (worker_threads).
 *
 * Por qué un worker y no llamar a pdf.js aquí mismo (Render gratuito: 512 MB, 0,1 CPU):
 *  - pdf.js en Node analiza en el mismo hilo que lo llama. Un PDF de 300 páginas ocuparía el hilo de la API
 *    durante segundos o minutos y nadie podría ni iniciar sesión. En un worker, la API sigue respondiendo.
 *  - Tiempo máximo REAL: worker.terminate() detiene el análisis de verdad. Un Promise.race solo dejaría de
 *    esperar, pero pdf.js seguiría consumiendo CPU.
 *  - Memoria acotada: resourceLimits hace que un PDF que explota en memoria mate SOLO al worker
 *    (ERR_WORKER_OUT_OF_MEMORY), no a la API entera.
 *
 * Analogía: es como mandar a un ayudante a otra sala a transcribir un expediente. Tú sigues atendiendo la
 * ventanilla; si tarda demasiado lo despides (terminate) y te quedas con las páginas que ya te pasó.
 */
import { Worker } from 'node:worker_threads';

/** Límites por documento. Pensados para Render gratuito y para no llenar los 0,5 GB de Neon gratuito. */
export const LIMITES_TEXTO = Object.freeze({
  maxPaginas: 500, // páginas que se leen como mucho (el resto queda sin indexar y se avisa)
  maxCaracteresPagina: 10_000, // una página densa ronda 3.000-5.000; más suele ser basura de extracción
  maxCaracteresDocumento: 500_000, // ≈ 150-250 páginas densas; acota el tamaño de los índices en la base
  minCaracteresPagina: 3, // menos letras/números que esto = página sin capa de texto (escaneada)
  tiempoMaximoMs: 180_000, // 3 min por documento con 0,1 CPU; al pasarlo se guarda lo extraído hasta ahí
  memoriaMb: 192, // heap del worker; el PDF en sí va fuera del heap (ArrayBuffer transferido)
});

const MARGEN_CORTE_MS = 10_000; // el worker se corta solo al llegar al límite; esto es la red de seguridad
const ERROR_TIEMPO = Object.freeze({ codigo: 'tiempo', mensaje: 'La extracción superó el tiempo máximo sin obtener texto.' });

/**
 * @param {Uint8Array} datos bytes del PDF en un ArrayBuffer PROPIO: se TRANSFIERE al worker y aquí queda vacío.
 * @param {Partial<typeof LIMITES_TEXTO>} [opciones]
 * @returns {Promise<{ paginasTotales: number|null, paginas: {pagina:number, texto:string}[],
 *                     limite: null|'paginas'|'caracteres'|'tiempo', error: null|{codigo:string, mensaje:string} }>}
 *          Nunca rechaza: los fallos vuelven en "error" para que el indexador los registre.
 */
export function extraerTextoPdf(datos, opciones = {}) {
  const limites = { ...LIMITES_TEXTO, ...opciones };
  return new Promise((resolver) => {
    const paginas = [];
    let paginasTotales = null;
    let terminado = false;
    let worker;

    const terminar = ({ limite = null, error = null }) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(corte);
      worker?.terminate().catch(() => {});
      resolver({ paginasTotales, paginas, limite, error });
    };
    const corte = setTimeout(() => terminar(paginas.length ? { limite: 'tiempo' } : { error: ERROR_TIEMPO }),
      limites.tiempoMaximoMs + MARGEN_CORTE_MS);

    try {
      worker = new Worker(new URL('./texto-worker.js', import.meta.url), {
        workerData: { datos, limites },
        transferList: [datos.buffer],
        resourceLimits: { maxOldGenerationSizeMb: limites.memoriaMb },
      });
    } catch (e) {
      return terminar({ error: { codigo: 'interno', mensaje: `No se pudo iniciar la extracción: ${e.message}` } });
    }
    worker.on('message', (m) => {
      if (m.tipo === 'inicio') paginasTotales = m.paginasTotales;
      else if (m.tipo === 'pagina') paginas.push({ pagina: m.pagina, texto: m.texto });
      // Tiempo agotado antes de la primera página con texto: es un error, no un "PDF sin texto".
      else if (m.tipo === 'fin') terminar(m.limite === 'tiempo' && !paginas.length ? { error: ERROR_TIEMPO } : { limite: m.limite });
      else if (m.tipo === 'error') terminar({ error: { codigo: 'pdf', mensaje: 'No se pudo leer el texto del PDF.' } });
    });
    worker.on('error', (e) => terminar({
      error: e?.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? { codigo: 'memoria', mensaje: 'El PDF necesita más memoria de la permitida para extraer su texto.' }
        : { codigo: 'pdf', mensaje: 'No se pudo leer el texto del PDF.' },
    }));
    worker.on('exit', () => terminar({ error: { codigo: 'interno', mensaje: 'La extracción terminó de forma inesperada.' } }));
  });
}
