import { Router } from 'express';
import { query } from '../db.js';
import { fechaCorta } from '../lib/format.js';

const router = Router();

const COLUMNAS = `
  d.id, d.nombre, d.folio, d.formato, d.ruta, d.responsable, d.autor_nombre, d.nota_extra, d.version_actual,
  d.ocr_procesado, d.cifrado_aes, d.hash_sha256, d.actualizado_en,
  c.nombre AS clasif, c.badge_clase, t.nombre AS tipo`;
const FROM = `
  FROM documentos d
  LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
  LEFT JOIN tipos_documentales t ON t.id = d.tipo_id`;
const ACCESO = `d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)`;

const base = (r) => ({
  docId: String(r.id), title: r.nombre,
  badge: (r.clasif ?? 'Sin clasificar').toUpperCase(), badgeColor: r.badge_clase ?? 'bg-slate-400 text-white',
  formatLabel: r.ocr_procesado ? `${r.formato.toUpperCase()} con OCR Verificado` : r.cifrado_aes ? 'Cifrado AES-256' : r.formato.toUpperCase(),
  hashLabel: r.hash_sha256 ? 'SHA-256 Validado' : r.folio,
  expediente: r.folio, ruta: r.ruta ?? '', actualizado: fechaCorta(r.actualizado_en),
  responsable: r.responsable ?? r.autor_nombre, extra: r.nota_extra ?? `Versión: ${r.version_actual}`,
  tipo: r.tipo, clasificacion: r.clasif,
});
const pagina = (r) => `Página ${r.pagina}${r.seccion ? ` · ${r.seccion}` : ''}`;

/** ts_headline marca coincidencias con << >>; tomamos desde la primera hasta la última. */
function partirFragmento(s) {
  const i = s.indexOf('<<');
  const j = s.lastIndexOf('>>');
  if (i < 0 || j < 0) return { before: '', highlight: s, after: '' };
  return { before: s.slice(0, i), highlight: s.slice(i, j + 2).replace(/<<|>>/g, ''), after: s.slice(j + 2) };
}

/** Búsqueda avanzada. Sin q devuelve todos los documentos (como hacía el front). */
router.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  const algoritmo = req.query.algoritmo === 'exacta' ? 'exacta' : 'semantica';
  const rango = req.user.rango;
  let out;

  if (!q) {
    const { rows } = await query(
      `SELECT ${COLUMNAS}, pg.pagina, pg.seccion, left(pg.texto, 200) AS fragmento
       ${FROM}
       LEFT JOIN LATERAL (SELECT pagina, seccion, texto FROM documento_paginas WHERE documento_id = d.id ORDER BY pagina LIMIT 1) pg ON true
       WHERE ${ACCESO} ORDER BY d.actualizado_en DESC LIMIT 50`, [rango]);
    out = rows.map((r) => ({ ...base(r), pagina: r.pagina ? pagina(r) : '', score: '', before: r.fragmento ?? '', highlight: '', after: '' }));
  } else if (algoritmo === 'semantica') {
    // Full-text en español con ranking. (Para semántica "real" con embeddings, ver README: pgvector.)
    const { rows } = await query(
      `SELECT ${COLUMNAS}, pg.pagina, pg.seccion, pg.fragmento, pg.rank
       ${FROM}
       JOIN LATERAL (
         SELECT p.pagina, p.seccion,
                ts_headline('spanish', p.texto, plainto_tsquery('spanish', $2),
                            'StartSel=<<,StopSel=>>,MaxFragments=1,MinWords=12,MaxWords=30') AS fragmento,
                ts_rank(p.tsv, plainto_tsquery('spanish', $2), 32) AS rank
           FROM documento_paginas p
          WHERE p.documento_id = d.id AND p.tsv @@ plainto_tsquery('spanish', $2)
          ORDER BY rank DESC LIMIT 1) pg ON true
       WHERE ${ACCESO} ORDER BY pg.rank DESC LIMIT 50`, [rango, q]);
    // El score se expresa relativo al mejor resultado (el primero = 100 %)
    const mejor = Math.max(...rows.map((r) => Number(r.rank)), 1e-9);
    out = rows.map((r) => ({
      ...base(r), pagina: pagina(r),
      score: `Score Semántico ${((Number(r.rank) / mejor) * 100).toFixed(1)}%`,
      ...partirFragmento(r.fragmento),
    }));
  } else {
    const { rows } = await query(
      `SELECT ${COLUMNAS}, pg.pagina, pg.seccion, pg.texto, pg.pos
       ${FROM}
       JOIN LATERAL (
         SELECT p.pagina, p.seccion, p.texto, position(lower($2) in lower(p.texto)) AS pos
           FROM documento_paginas p
          WHERE p.documento_id = d.id AND position(lower($2) in lower(p.texto)) > 0
          ORDER BY p.pagina LIMIT 1) pg ON true
       WHERE ${ACCESO} ORDER BY d.actualizado_en DESC LIMIT 50`, [rango, q]);
    out = rows.map((r) => {
      const ini = r.pos - 1, fin = ini + q.length;
      return {
        ...base(r), pagina: pagina(r), score: `Posición de caracteres: [${ini} - ${fin}]`,
        before: r.texto.slice(Math.max(0, ini - 80), ini), highlight: r.texto.slice(ini, fin), after: r.texto.slice(fin, fin + 160),
      };
    });
  }

  if (q) {
    await query(`INSERT INTO busquedas (usuario_id, termino, algoritmo, resultados) VALUES ($1,$2,$3,$4)`,
      [req.user.id, q, algoritmo, out.length]);
  }
  res.json(out);
});

/** Filtros laterales y términos frecuentes. */
router.get('/facetas', async (req, res) => {
  const [tipos, clasifs, frecuentes] = await Promise.all([
    query(
      `SELECT t.nombre AS label,
              count(d.id) FILTER (WHERE d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1))::int AS count
         FROM tipos_documentales t
         LEFT JOIN documentos d ON d.tipo_id = t.id
         LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
        GROUP BY t.id ORDER BY t.id`, [req.user.rango]),
    query(`SELECT nombre AS label, punto_clase AS color FROM clasificaciones WHERE nivel_minimo <= $1 ORDER BY nivel_minimo DESC`, [req.user.rango]),
    query(`SELECT termino FROM busquedas GROUP BY termino ORDER BY count(*) DESC, max(creado_en) DESC LIMIT 4`),
  ]);
  res.json({
    tiposDocumentales: tipos.rows,
    clasificaciones: clasifs.rows,
    terminosFrecuentes: frecuentes.rows.map((r) => r.termino),
  });
});

export default router;
