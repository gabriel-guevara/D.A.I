/**
 * Papelera, purga definitiva y cola PERSISTENTE de objetos por borrar (tabla objetos_por_borrar).
 *
 * El problema: una purga toca DOS sistemas que no comparten transacción (PostgreSQL y el almacenamiento,
 * local o R2). Si se borrara primero el objeto y luego fallara la base, quedaría una fila apuntando a un
 * archivo que ya no existe; si se cambiara la base y el proceso muriera antes de borrar el objeto, quedaría
 * un archivo huérfano que nadie recuerda.
 *
 * La solución (patrón "outbox", como apuntar en una lista lo que hay que llevar a la trituradora):
 *   1. UNA transacción en la base: el documento pasa a 'purgado', sus filas dejan de apuntar a los objetos
 *      y las claves de esos objetos se APUNTAN en objetos_por_borrar. O pasa todo o no pasa nada.
 *   2. Después, fuera de la transacción, se borran los objetos de la lista. Si el almacenamiento falla, la
 *      fila sigue en la lista con su error y se reintenta más tarde (al despertar el servicio, al abrir la
 *      papelera o tras otra purga). Nunca se pierde la pista de un objeto.
 *   3. Guarda final: antes de borrar un objeto se comprueba que NINGUNA fila lo usa. Aunque la lista tuviera
 *      un error, jamás se borra un archivo vivo.
 *
 * La misma lista protege las subidas: antes de subir se apunta la clave como "subida_en_curso" con un plazo;
 * si la transacción del documento confirma, se tacha en la MISMA transacción. Si el proceso muere a mitad
 * (Render reinicia o se duerme), pasado el plazo el objeto huérfano se borra solo.
 *
 * Render gratuito se duerme tras 15 minutos sin tráfico y no tiene cron: el mantenimiento (purga por
 * retención + vaciar la lista) corre "al despertar": al arrancar la API, al abrir la papelera y tras cada
 * purga. Sin setInterval: un sondeo mantendría despierta la base de Neon y gastaría horas de cómputo.
 */
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { registrarAuditoria } from './audit.js';
import { almacenamiento } from './storage.js';

const SISTEMA = { user: null, ip: null }; // "petición" para la auditoría de acciones automáticas
export const PLAZO_SUBIDA_EN_CURSO_MIN = 60; // ninguna subida (máx. 100 MB) tarda una hora
const ARRIENDO_MIN = 10; // una fila tomada no la toma otro proceso durante 10 min
const MAX_ESPERA_MIN = 360; // reintentos con espera creciente: 1, 2, 4... hasta 6 h
const LOTE_PURGA = 20;
const MAX_BORRADOS_POR_VUELTA = 200;

let opciones = { diasRetencion: config.papeleraDiasRetencion };

/** Solo para pruebas: cambia los días de retención sin reiniciar. */
export function configurarPapelera({ diasRetencion = config.papeleraDiasRetencion } = {}) {
  opciones = { diasRetencion };
}
export const diasRetencionPapelera = () => opciones.diasRetencion;

/**
 * Fecha a partir de la cual el documento se purga solo (SQL, sobre la tabla documentos con alias d).
 * Si se borró cuando la retención estaba desactivada (purgar_despues_de NULL), cuenta desde eliminado_en.
 * $N = días de retención.
 */
export const SQL_FECHA_PURGA = (n) => `coalesce(d.purgar_despues_de, d.eliminado_en + make_interval(days => $${n}))`;

// ------------------------------------------------------------------------------------- intención de subida

/** Apunta la clave ANTES de subir el objeto. Devuelve el id de la fila (se tacha al confirmar la subida). */
export async function registrarIntencionSubida(clave, driver, documentoId = null) {
  const { rows: [r] } = await query(
    `INSERT INTO objetos_por_borrar (clave, storage_driver, documento_id, motivo, no_antes_de)
     VALUES ($1, $2, $3, 'subida_en_curso', now() + make_interval(mins => $4)) RETURNING id`,
    [clave, driver, documentoId, PLAZO_SUBIDA_EN_CURSO_MIN]);
  return r.id;
}

/** Tacha la intención DENTRO de la transacción que crea las filas: el objeto deja de ser candidato a borrarse. */
export const confirmarSubida = (c, intentoId) => c.query(`DELETE FROM objetos_por_borrar WHERE id = $1`, [intentoId]);

/**
 * La base falló después de subir el objeto: se borra ya. Si tampoco se puede, la fila queda como
 * "subida_fallida" para reintentarlo en el próximo mantenimiento (nunca un huérfano olvidado).
 */
export async function descartarSubida(st, clave, intentoId) {
  try {
    await st.borrar(clave);
    await query(`DELETE FROM objetos_por_borrar WHERE id = $1`, [intentoId]);
  } catch (e) {
    console.error(`No se pudo borrar el objeto de una subida fallida (${clave}); queda en la cola de borrado:`, e.message);
    await query(
      `UPDATE objetos_por_borrar SET motivo = 'subida_fallida', no_antes_de = now(), ultimo_error = left($2, 300) WHERE id = $1`,
      [intentoId, e.message]).catch((err) => console.error('Tampoco se pudo actualizar la cola de borrado:', err.message));
  }
}

// ------------------------------------------------------------------------------------- purga

/**
 * Purga definitiva DENTRO de una transacción (c). El documento debe estar en la papelera y fuera de retención legal.
 * Deja la fila como "lápida" (estado 'purgado', con nombre, folio y huellas como evidencia) y borra su CONTENIDO:
 * texto indexado, estado de indexación y referencias a objetos de todas sus versiones (que pasan a la cola).
 * @returns {Promise<{ error: 'no_encontrado'|'retencion', venceRetencion?: Date } | { documento: object, versiones: object[], objetos: number }>}
 */
export async function purgarEnTransaccion(c, documentoId, { usuarioId = null } = {}) {
  const { rows: [d] } = await c.query(
    `SELECT id, nombre, folio, estado, version_actual, storage_path, storage_driver, hash_sha256, vence_retencion,
            vence_retencion IS NOT NULL AND vence_retencion > current_date AS en_retencion
       FROM documentos WHERE id = $1 FOR UPDATE`, [documentoId]);
  if (!d || d.estado !== 'papelera') return { error: 'no_encontrado' };
  if (d.en_retencion) return { error: 'retencion', venceRetencion: d.vence_retencion };

  const { rows: versiones } = await c.query(
    `SELECT version, hash_sha256, storage_path, storage_driver FROM documento_versiones WHERE documento_id = $1 ORDER BY id`, [d.id]);
  // Claves REALES (con driver): las heredadas sin driver nunca apuntaron a un objeto.
  const objetos = new Map();
  for (const o of [d, ...versiones]) if (o.storage_path && o.storage_driver) objetos.set(`${o.storage_driver}:${o.storage_path}`, o);
  if (objetos.size)
    await c.query(
      `INSERT INTO objetos_por_borrar (clave, storage_driver, documento_id, motivo)
       SELECT clave, driver, $1, 'purga' FROM unnest($2::text[], $3::text[]) AS x(clave, driver)`,
      [d.id, [...objetos.values()].map((o) => o.storage_path), [...objetos.values()].map((o) => o.storage_driver)]);

  await c.query(`UPDATE documento_versiones SET storage_path = NULL, storage_driver = NULL WHERE documento_id = $1`, [d.id]);
  await c.query(`DELETE FROM documento_paginas WHERE documento_id = $1`, [d.id]);
  await c.query(`DELETE FROM documento_indexacion WHERE documento_id = $1`, [d.id]);
  await c.query(
    `UPDATE documentos SET estado = 'purgado', purgado_en = now(), purgado_por = $2, purgar_despues_de = NULL,
            tiene_archivo = false, storage_path = NULL, storage_driver = NULL, cifrado_aes = false
      WHERE id = $1`, [d.id, usuarioId]);

  return {
    documento: { id: Number(d.id), nombre: d.nombre, folio: d.folio, version: d.version_actual },
    versiones: versiones.map((v) => ({ version: v.version, sha256: v.hash_sha256?.trim() ?? null })),
    objetos: objetos.size,
  };
}

/** Detalle de auditoría de una purga (sin claves de objeto: basta con las huellas). */
export const detallePurga = (r, motivo) => ({
  motivo, nombre: r.documento.nombre, folio: r.documento.folio, versionActual: r.documento.version,
  versiones: r.versiones, objetos: r.objetos,
});

/** Purga automática de lo que cumplió su plazo en la papelera (y no está en retención legal). */
export async function purgarVencidos({ limite = LOTE_PURGA } = {}) {
  if (!opciones.diasRetencion) return 0;
  const { rows } = await query(
    `SELECT d.id FROM documentos d
      WHERE d.estado = 'papelera' AND ${SQL_FECHA_PURGA(1)} <= now()
        AND (d.vence_retencion IS NULL OR d.vence_retencion <= current_date)
      ORDER BY ${SQL_FECHA_PURGA(1)}, d.id LIMIT $2`, [opciones.diasRetencion, limite]);
  let purgados = 0;
  for (const { id } of rows) {
    const r = await withTransaction((c) => purgarEnTransaccion(c, id));
    if (r.error) continue; // alguien lo restauró o purgó mientras tanto
    purgados++;
    await registrarAuditoria(SISTEMA, 'purgar_documento', r.documento.id, detallePurga(r, 'retencion'));
  }
  return purgados;
}

// ------------------------------------------------------------------------------------- cola de borrado

/** Toma la siguiente fila vencida del driver actual con un "arriendo": dos procesos nunca toman la misma. */
async function tomarSiguienteBorrado(driver) {
  const { rows: [f] } = await query(
    `UPDATE objetos_por_borrar o SET no_antes_de = now() + make_interval(mins => $2), intentos = o.intentos + 1
      WHERE o.id = (SELECT id FROM objetos_por_borrar
                     WHERE no_antes_de <= now() AND storage_driver = $1
                     ORDER BY no_antes_de, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.clave, o.documento_id, o.motivo, o.intentos`, [driver, ARRIENDO_MIN]);
  return f ?? null;
}

/**
 * Borra los objetos apuntados en la cola. Solo los del driver actual: una fila "r2" vista desde un entorno
 * local (datos copiados de producción) no se puede ni se debe tocar desde aquí.
 * @returns {Promise<{ borrados: number, fallidos: number, omitidos: number }>}
 */
export async function procesarBorrados({ maximo = MAX_BORRADOS_POR_VUELTA } = {}) {
  const st = almacenamiento();
  const r = { borrados: 0, fallidos: 0, omitidos: 0 };
  for (let i = 0; i < maximo; i++) {
    const f = await tomarSiguienteBorrado(st.driver);
    if (!f) break;
    // Guarda final: si alguna fila usa la clave (p. ej. una subida que sí confirmó), el objeto NO se borra.
    const { rows: [uso] } = await query(
      `SELECT EXISTS (SELECT 1 FROM documentos WHERE storage_path = $1)
           OR EXISTS (SELECT 1 FROM documento_versiones WHERE storage_path = $1) AS en_uso`, [f.clave]);
    if (uso.en_uso) {
      await query(`DELETE FROM objetos_por_borrar WHERE id = $1`, [f.id]);
      console.warn(`Cola de borrado: la clave ${f.clave} está en uso; se descarta la fila sin borrar el objeto.`);
      r.omitidos++;
      continue;
    }
    try {
      await st.borrar(f.clave); // idempotente: borrar lo que ya no existe no falla
    } catch (e) {
      await query(
        `UPDATE objetos_por_borrar SET ultimo_error = left($2, 300), no_antes_de = now() + make_interval(mins => $3) WHERE id = $1`,
        [f.id, e.message, Math.min(2 ** (f.intentos - 1), MAX_ESPERA_MIN)]);
      console.error(`Cola de borrado: no se pudo borrar ${f.clave} (intento ${f.intentos}):`, e.message);
      r.fallidos++;
      continue;
    }
    await query(`DELETE FROM objetos_por_borrar WHERE id = $1`, [f.id]);
    await registrarAuditoria(SISTEMA, 'borrar_objeto', f.documento_id ? Number(f.documento_id) : null,
      { motivo: f.motivo, clave: f.clave, almacenamiento: st.driver, intentos: f.intentos });
    r.borrados++;
  }
  return r;
}

/** Objetos aún por borrar del driver actual (para que el administrador vea si algo se atascó). */
export async function resumenBorrados() {
  const { rows: [r] } = await query(
    `SELECT count(*)::int AS pendientes, count(*) FILTER (WHERE ultimo_error IS NOT NULL)::int AS con_error
       FROM objetos_por_borrar WHERE storage_driver = $1 AND motivo <> 'subida_en_curso'`, [almacenamiento().driver]);
  return r;
}

// ------------------------------------------------------------------------------------- mantenimiento

let ejecucion = null;
let otraVuelta = false;
let detenido = false;

async function vuelta() {
  try {
    await purgarVencidos();
    await procesarBorrados();
  } catch (e) {
    // Base o almacenamiento sin responder: lo pendiente sigue apuntado y se reintenta en el próximo despertar.
    console.error('Mantenimiento de la papelera detenido por un error:', e.message);
  }
}

/** Arranca una vuelta de mantenimiento si no hay otra en curso. Nunca lanza ni bloquea a quien lo llama. */
export function despertarMantenimiento() {
  if (detenido) return;
  if (ejecucion) {
    otraVuelta = true;
    return;
  }
  otraVuelta = false;
  ejecucion = vuelta().finally(() => {
    ejecucion = null;
    if (otraVuelta) despertarMantenimiento();
  });
}

/** Espera a que termine la vuelta en curso (pruebas). */
export async function esperarMantenimiento() {
  while (ejecucion) await ejecucion;
}

/** Deja de arrancar vueltas y espera la que esté en curso (apagado ordenado y pruebas). */
export async function detenerMantenimiento() {
  detenido = true;
  await esperarMantenimiento();
}

export function reanudarMantenimiento() {
  detenido = false;
}
