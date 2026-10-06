import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { formatBytes, idValido } from '../lib/format.js';

const router = Router();
router.use(requireRole('super-admin', 'ocr-operator'));

/** Cola pendiente + contadores (QueueItem, processedCount, totalInQueue del front). */
async function estadoCola(db) {
  const [pend, cont] = await Promise.all([
    db.query(`SELECT id, nombre_archivo, papel, dpi, tamano_bytes, estado FROM ocr_trabajos
               WHERE estado IN ('en_foco','en_espera') ORDER BY (estado = 'en_foco') DESC, id`),
    db.query(`SELECT count(*) FILTER (WHERE estado = 'procesado')::int AS procesados, count(*)::int AS total FROM ocr_trabajos`),
  ]);
  return {
    queue: pend.rows.map((j) => ({
      id: String(j.id), name: j.nombre_archivo, status: j.estado,
      meta: `${j.papel} · ${j.dpi} DPI · ${formatBytes(j.tamano_bytes)}`,
    })),
    processedCount: cont.rows[0].procesados,
    totalInQueue: cont.rows[0].total,
  };
}

router.get('/cola', async (_req, res) => res.json(await estadoCola({ query })));

/** Agrega un archivo a la cola (los metadatos; la subida física del archivo va aparte). */
router.post('/trabajos', async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.nombre !== 'string' || !b.nombre.trim()) return res.status(400).json({ error: 'Falta el nombre del archivo.' });
  const dpi = Math.min(Math.max(Number(b.dpi) || 300, 72), 1200);
  const { rows: [j] } = await query(
    `INSERT INTO ocr_trabajos (usuario_id, nombre_archivo, canal, papel, dpi, tamano_bytes, preprocesamiento, estado)
     VALUES ($1,$2,$3,$4,$5,$6,coalesce($7::jsonb, '{"deskew":true,"denoise":true,"binarization":true,"orientation":false}'::jsonb),
             CASE WHEN EXISTS (SELECT 1 FROM ocr_trabajos WHERE estado = 'en_foco') THEN 'en_espera' ELSE 'en_foco' END)
     RETURNING id`,
    [req.user.id, b.nombre.trim().slice(0, 200), b.canal === 'scanner' ? 'scanner' : 'file', String(b.papel ?? 'A4').slice(0, 10),
     dpi, Math.max(Number(b.tamanoBytes) || 0, 0), b.preprocesamiento ? JSON.stringify(b.preprocesamiento) : null]);
  res.status(201).json({ id: String(j.id) });
});

/** "Aprobar e Indexar en DAI": crea el documento a partir del trabajo OCR. */
router.post('/trabajos/:id/aprobar', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Trabajo no encontrado' });
  const b = req.body ?? {};
  try {
    const resultado = await withTransaction(async (c) => {
      const { rows: [j] } = await c.query(`SELECT * FROM ocr_trabajos WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!j) return { status: 404, error: 'Trabajo no encontrado' };
      if (j.estado === 'procesado') return { status: 409, error: 'El trabajo ya fue aprobado.' };

      const { rows: [u] } = await c.query(`SELECT nombre, email FROM usuarios WHERE id = $1`, [req.user.id]);
      const ext = j.nombre_archivo.split('.').pop().toLowerCase();
      const formato = ext === 'tif' ? 'tiff' : ['pdf', 'xlsx', 'docx', 'tiff'].includes(ext) ? ext : 'pdf';
      const folio = String(b.folio || `EXP-${new Date().getFullYear()}-OCR-${j.id}`).slice(0, 60);
      const id = async (tabla, valor) =>
        valor ? (await c.query(`SELECT id FROM ${tabla} WHERE nombre = $1`, [valor])).rows[0]?.id ?? null : null;
      // Si no se indica (o no existe) la clasificación, se usa una por defecto: nunca queda sin clasificar.
      const clasificacionId = (await id('clasificaciones', b.clasificacion)) ?? (await id('clasificaciones', 'Confidencial Nivel 2'));

      const { rows: [d] } = await c.query(
        `INSERT INTO documentos (nombre, folio, formato, departamento_id, tipo_id, clasificacion_id, autor_id, autor_nombre, autor_email,
                                 origen, tamano_bytes, ocr_procesado, storage_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Digitalización OCR',$10,true,$11) RETURNING id`,
        [j.nombre_archivo, folio, formato, await id('departamentos', b.departamento), await id('tipos_documentales', b.tipoDocumental),
         clasificacionId, req.user.id, u.nombre, u.email, j.tamano_bytes, `ocr/${j.id}/${j.nombre_archivo}`]);

      if (typeof b.textoRaw === 'string' && b.textoRaw.trim()) {
        await c.query(`INSERT INTO documento_paginas (documento_id, pagina, texto, confianza) VALUES ($1,1,$2,$3)`,
          [d.id, b.textoRaw, Number(b.confianza) || null]);
      }
      await c.query(
        `UPDATE ocr_trabajos SET estado = 'procesado', aprobado_en = now(), documento_id = $2,
                texto_raw = $3, campos = $4, confianza = $5 WHERE id = $1`,
        [j.id, d.id, b.textoRaw ?? null, b.campos ? JSON.stringify(b.campos) : null, Number(b.confianza) || null]);
      // El siguiente en espera pasa a "en foco"
      await c.query(`UPDATE ocr_trabajos SET estado = 'en_foco'
                      WHERE id = (SELECT id FROM ocr_trabajos WHERE estado = 'en_espera' ORDER BY id LIMIT 1)
                        AND NOT EXISTS (SELECT 1 FROM ocr_trabajos WHERE estado = 'en_foco')`);
      return { status: 200, documentoId: String(d.id), ...(await estadoCola(c)) };
    });

    if (resultado.status !== 200) return res.status(resultado.status).json({ error: resultado.error });
    await registrarAuditoria(req, 'aprobar_ocr', Number(resultado.documentoId), { trabajo: req.params.id });
    const { status, ...cuerpo } = resultado;
    res.json(cuerpo);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un documento con ese folio.' });
    throw e;
  }
});

export default router;
