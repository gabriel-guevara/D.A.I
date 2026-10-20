/**
 * Árbol de carpetas (Fase 6): rutas (migas de pan), profundidad y descendientes con CTE recursivas.
 *
 * Una carpeta guarda solo a su padre (padre_id; NULL = raíz). Es como un árbol genealógico donde cada persona
 * anota solo quién es su madre: para saber la línea completa hasta la raíz se sube de madre en madre (CTE
 * "hacia arriba") y para conocer a toda la descendencia se baja de hijos en nietos (CTE "hacia abajo").
 *
 * Cada función recibe "db": el pool (query de db.js) o el cliente de una transacción (para leer bajo sus candados).
 */

/** Profundidad máxima: una carpeta en la raíz es el nivel 1; las de nivel 5 ya no admiten subcarpetas. */
export const MAX_NIVEL = 5;
// Red de seguridad de las CTE: si por un error de datos hubiera un ciclo, la recursión se corta aquí.
const TOPE = MAX_NIVEL + 5;

/** Candado consultivo de la ESTRUCTURA (crear con padre, mover o eliminar carpetas): uno a la vez, sin carreras. */
export const CANDADO_ARBOL = 4_241_006;

/**
 * Rutas desde la raíz de varias carpetas a la vez.
 * @returns {Promise<Map<string, {id: string, nombre: string}[]>>} id → [raíz, …, la carpeta]
 */
export async function rutasDe(db, ids) {
  const unicos = [...new Set(ids.filter(Boolean).map(String))];
  const out = new Map();
  if (!unicos.length) return out;
  const { rows } = await db.query(
    `WITH RECURSIVE r AS (
       SELECT c.id AS hoja, c.id, c.nombre, c.padre_id, 0 AS prof FROM carpetas c WHERE c.id = ANY($1::bigint[])
       UNION ALL
       SELECT r.hoja, p.id, p.nombre, p.padre_id, r.prof + 1 FROM carpetas p JOIN r ON p.id = r.padre_id WHERE r.prof < ${TOPE})
     SELECT hoja, id, nombre FROM r ORDER BY hoja, prof DESC`, [unicos]);
  for (const f of rows) {
    const k = String(f.hoja);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ id: String(f.id), nombre: f.nombre });
  }
  return out;
}

/** Ruta de una carpeta ([] si no existe). */
export async function rutaDe(db, id) {
  return (await rutasDe(db, [id])).get(String(id)) ?? [];
}

/** Altura del subárbol: 1 si no tiene subcarpetas, 2 si tiene hijas sin nietas, etc. */
export async function alturaSubarbol(db, id) {
  const { rows: [r] } = await db.query(
    `WITH RECURSIVE s AS (
       SELECT id, 1 AS alt FROM carpetas WHERE id = $1
       UNION ALL
       SELECT c.id, s.alt + 1 FROM carpetas c JOIN s ON c.padre_id = s.id WHERE s.alt < ${TOPE})
     SELECT coalesce(max(alt), 0)::int AS altura FROM s`, [id]);
  return r.altura;
}

/** SQL de los ids de una carpeta y TODAS sus descendientes ($n = id de la carpeta), para usar en "IN (...)". */
export const sqlConDescendientes = (p) => `WITH RECURSIVE sub AS (
    SELECT id, 1 AS prof FROM carpetas WHERE id = ${p}
    UNION ALL
    SELECT c.id, sub.prof + 1 FROM carpetas c JOIN sub ON c.padre_id = sub.id WHERE sub.prof < ${TOPE})
  SELECT id FROM sub`;

/** "Legal › 2024" (o "Inicio" para la raíz). Para avisos y mensajes; nunca incluye nombres de documentos. */
export const nombresRuta = (ruta) => (ruta?.length ? ruta.map((c) => c.nombre).join(' › ') : 'Inicio');
/** La misma ruta entre comillas angulares: «Legal › 2024». */
export const textoRuta = (ruta) => `«${nombresRuta(ruta)}»`;
