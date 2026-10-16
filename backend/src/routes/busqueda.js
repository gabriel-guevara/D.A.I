import { Router } from 'express';
import { query } from '../db.js';
import { escapeLike, fechaCorta } from '../lib/format.js';

const router = Router();

const COLUMNAS = `
  d.id, d.nombre, d.folio, d.formato, d.ruta, d.responsable, d.autor_nombre, d.nota_extra, d.version_actual,
  d.ocr_procesado, d.tiene_archivo, d.storage_driver, d.hash_sha256, d.actualizado_en,
  c.nombre AS clasif, c.badge_clase, t.nombre AS tipo`;
const FROM = `
  FROM documentos d
  LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
  LEFT JOIN tipos_documentales t ON t.id = d.tipo_id`;
// Mismas reglas que el resto de la API: solo activos y de un nivel que el usuario alcanza ($1 = su rango).
const ACCESO = `d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)`;
const MAX_RESULTADOS = 50;
const MAX_TERMINO = 200;

// Marcas del resaltado. Son caracteres de control: normalizarTexto() los elimina de todo texto guardado, así
// que nunca chocan con el contenido (un documento puede contener "<<" o ">>" literalmente).
const INI = '\u0001';
const FIN = '\u0002';
const OPCIONES_HEADLINE = `StartSel=${INI},StopSel=${FIN},MaxFragments=2,MinWords=8,MaxWords=24,FragmentDelimiter=" … "`;

const ORIGENES = {
  pdf: 'Texto extraído del PDF',
  manual: 'Texto capturado manualmente (OCR)',
  demo: 'Texto de demostración',
};

const base = (r) => ({
  docId: String(r.id), title: r.nombre,
  badge: (r.clasif ?? 'Sin clasificar').toUpperCase(), badgeColor: r.badge_clase ?? 'bg-slate-400 text-white',
  // "Cifrado" solo cuando hay archivo real en R2 (R2 cifra en reposo con AES-256); los del seed no tienen archivo.
  formatLabel: r.ocr_procesado ? `${r.formato.toUpperCase()} con OCR Verificado`
    : r.tiene_archivo && r.storage_driver === 'r2' ? 'Cifrado en reposo AES-256 (R2)' : r.formato.toUpperCase(),
  hashLabel: r.tiene_archivo && r.hash_sha256 ? 'SHA-256 del archivo' : r.folio,
  expediente: r.folio, ruta: r.ruta ?? '', actualizado: fechaCorta(r.actualizado_en),
  responsable: r.responsable ?? r.autor_nombre, extra: r.nota_extra ?? `Versión: ${r.version_actual}`,
  tipo: r.tipo, clasificacion: r.clasif,
});

/** Datos de la página donde está la coincidencia (número para que el visor salte a ella). */
const pagina = (r) => ({
  pagina: r.pagina ? `Página ${r.pagina}${r.seccion ? ` · ${r.seccion}` : ''}` : '',
  numeroPagina: r.pagina ?? null,
  paginasCoincidentes: r.paginas_coinc ? Number(r.paginas_coinc) : null,
  origenTexto: r.origen ?? null,
  origenEtiqueta: r.origen ? ORIGENES[r.origen] : null,
});

const unaLinea = (s) => s.replace(/\s+/g, ' ');

/**
 * "a \u0001b\u0002 c" → [{texto:'a ', resaltado:false}, {texto:'b', resaltado:true}, {texto:' c', resaltado:false}].
 * Segmentos en lugar de HTML: el front los pinta con interpolación normal (sin innerHTML ni riesgo de XSS).
 */
export function segmentosDeFragmento(s) {
  const out = [];
  const agregar = (texto, resaltado) => texto && out.push({ texto, resaltado });
  for (const [i, trozo] of unaLinea(s ?? '').split(INI).entries()) {
    const fin = trozo.indexOf(FIN);
    if (i === 0 || fin < 0) agregar(trozo, false); // texto antes de la primera marca (o marca sin cerrar)
    else {
      agregar(trozo.slice(0, fin), true);
      agregar(trozo.slice(fin + 1), false);
    }
  }
  return out;
}

/** Búsqueda avanzada. Sin q devuelve los documentos más recientes (como hacía el front). */
router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? unaLinea(req.query.q).trim().slice(0, MAX_TERMINO) : '';
  const algoritmo = req.query.algoritmo === 'exacta' ? 'exacta' : 'semantica';
  const rango = req.user.rango;
  let out;

  if (!q) {
    // Primero los 50 documentos, después (LATERAL) su primera página: no se lee texto de documentos que no se muestran.
    const { rows } = await query(
      `SELECT top.*, pg.pagina, pg.seccion, pg.origen, left(pg.texto, 200) AS fragmento
         FROM (SELECT ${COLUMNAS} ${FROM} WHERE ${ACCESO} ORDER BY d.actualizado_en DESC, d.id DESC LIMIT ${MAX_RESULTADOS}) top
         LEFT JOIN LATERAL (SELECT pagina, seccion, origen, texto FROM documento_paginas
                             WHERE documento_id = top.id ORDER BY pagina LIMIT 1) pg ON true
        ORDER BY top.actualizado_en DESC, top.id DESC`, [rango]);
    out = rows.map((r) => ({
      ...base(r), ...pagina(r), score: '',
      segmentos: r.fragmento ? [{ texto: unaLinea(r.fragmento), resaltado: false }] : [],
    }));
  } else if (algoritmo === 'semantica') {
    // Full-text en español (raíces: "contratos" encuentra "contrato"). Orden de trabajo pensado para el índice:
    //  1. coinc: páginas que coinciden, por el índice GIN de tsv; la mejor página de cada documento.
    //  2. top:   reglas de acceso y los 50 mejores.
    //  3. ts_headline (caro: vuelve a analizar el texto) SOLO para esos 50.
    const { rows } = await query(
      `WITH q AS (SELECT plainto_tsquery('spanish', $2) AS tsq),
       coinc AS (
         SELECT DISTINCT ON (p.documento_id) p.documento_id, p.pagina, p.seccion, p.origen,
                ts_rank(p.tsv, q.tsq, 32) AS rank, count(*) OVER (PARTITION BY p.documento_id) AS paginas_coinc
           FROM documento_paginas p CROSS JOIN q
          WHERE p.tsv @@ q.tsq
          ORDER BY p.documento_id, rank DESC, p.pagina),
       top AS (
         SELECT ${COLUMNAS}, coinc.pagina, coinc.seccion, coinc.origen, coinc.rank, coinc.paginas_coinc
           ${FROM} JOIN coinc ON coinc.documento_id = d.id
          WHERE ${ACCESO}
          ORDER BY coinc.rank DESC, d.id LIMIT ${MAX_RESULTADOS})
       SELECT top.*, ts_headline('spanish', p.texto, q.tsq, $3) AS fragmento
         FROM top JOIN documento_paginas p ON p.documento_id = top.id AND p.pagina = top.pagina CROSS JOIN q
        ORDER BY top.rank DESC, top.id`, [rango, q, OPCIONES_HEADLINE]);
    // El score se expresa relativo al mejor resultado (el primero = 100 %)
    const mejor = Math.max(...rows.map((r) => Number(r.rank)), 1e-9);
    out = rows.map((r) => ({
      ...base(r), ...pagina(r),
      score: `Score Semántico ${((Number(r.rank) / mejor) * 100).toFixed(1)}%`,
      segmentos: segmentosDeFragmento(r.fragmento),
    }));
  } else {
    // Exacta: ILIKE usa el índice trigram (gin_trgm_ops) con 3+ caracteres. El fragmento se corta EN SQL
    // (substr cuenta caracteres; JavaScript contaría unidades UTF-16 y se desfasaría con algunos símbolos).
    const { rows } = await query(
      `WITH coinc AS (
         SELECT DISTINCT ON (p.documento_id) p.documento_id, p.pagina, p.seccion, p.origen,
                strpos(lower(p.texto), lower($2)) AS pos, count(*) OVER (PARTITION BY p.documento_id) AS paginas_coinc
           FROM documento_paginas p
          WHERE p.texto ILIKE $3
          ORDER BY p.documento_id, p.pagina),
       top AS (
         SELECT ${COLUMNAS}, coinc.pagina, coinc.seccion, coinc.origen, coinc.pos, coinc.paginas_coinc
           ${FROM} JOIN coinc ON coinc.documento_id = d.id
          WHERE ${ACCESO} AND coinc.pos > 0
          ORDER BY d.actualizado_en DESC, d.id DESC LIMIT ${MAX_RESULTADOS})
       SELECT top.*,
              substr(p.texto, greatest(top.pos - 80, 1), least(top.pos - 1, 80)) AS antes,
              substr(p.texto, top.pos, char_length($2)) AS coincide,
              substr(p.texto, top.pos + char_length($2), 160) AS despues
         FROM top JOIN documento_paginas p ON p.documento_id = top.id AND p.pagina = top.pagina
        ORDER BY top.actualizado_en DESC, top.id DESC`, [rango, q, `%${escapeLike(q)}%`]);
    out = rows.map((r) => ({
      ...base(r), ...pagina(r),
      score: `Posición de caracteres: [${r.pos - 1} - ${r.pos - 1 + q.length}]`,
      segmentos: [
        { texto: unaLinea(`${r.pos > 81 ? '… ' : ''}${r.antes}`), resaltado: false },
        { texto: unaLinea(r.coincide), resaltado: true },
        { texto: unaLinea(r.despues), resaltado: false },
      ].filter((s) => s.texto),
    }));
  }

  if (q) {
    await query(`INSERT INTO busquedas (usuario_id, termino, algoritmo, resultados) VALUES ($1,$2,$3,$4)`,
      [req.user.id, q, algoritmo, out.length]);
  }
  res.json(out);
});

/** Filtros laterales, términos frecuentes y cuántos documentos (visibles para el usuario) tienen texto buscable. */
router.get('/facetas', async (req, res) => {
  const [tipos, clasifs, frecuentes, indexados] = await Promise.all([
    query(
      `SELECT t.nombre AS label,
              count(d.id) FILTER (WHERE d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1))::int AS count
         FROM tipos_documentales t
         LEFT JOIN documentos d ON d.tipo_id = t.id
         LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
        GROUP BY t.id ORDER BY t.id`, [req.user.rango]),
    query(`SELECT nombre AS label, punto_clase AS color FROM clasificaciones WHERE nivel_minimo <= $1 ORDER BY nivel_minimo DESC`, [req.user.rango]),
    // Solo las búsquedas del propio usuario: agregarlas de todos filtraría términos que alguien de mayor nivel
    // escribió buscando documentos que este usuario no puede ver (p. ej. el nombre en clave de un secreto).
    query(
      `SELECT termino FROM busquedas WHERE usuario_id = $1
        GROUP BY termino ORDER BY count(*) DESC, max(creado_en) DESC LIMIT 4`, [req.user.id]),
    query(
      `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM documento_paginas p WHERE p.documento_id = d.id))::int AS con_texto,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM documento_paginas p WHERE p.documento_id = d.id AND p.origen = 'pdf'))::int AS con_texto_real
         ${FROM} WHERE ${ACCESO}`, [req.user.rango]),
  ]);
  res.json({
    tiposDocumentales: tipos.rows,
    clasificaciones: clasifs.rows,
    terminosFrecuentes: frecuentes.rows.map((r) => r.termino),
    documentosConTexto: indexados.rows[0].con_texto,
    documentosConTextoReal: indexados.rows[0].con_texto_real,
  });
});

export default router;
