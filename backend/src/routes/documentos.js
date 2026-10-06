import { Router } from 'express';
import { query } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { escapeLike, fechaCorta, fechaHoraUTC, formatBytes, hashCorto, haceCuanto, idValido } from '../lib/format.js';

const router = Router();

const FROM = `
  FROM documentos d
  LEFT JOIN departamentos dep ON dep.id = d.departamento_id
  LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
  LEFT JOIN tipos_documentales t ON t.id = d.tipo_id`;
// $1 siempre es el rango del usuario: solo ve documentos de su nivel o inferior
const ACCESO = `(c.id IS NULL OR c.nivel_minimo <= $1)`;

/** Biblioteca: lista de documentos (misma forma que LibraryDoc del front, sin "selected"). */
router.get('/', async (req, res) => {
  const { q, departamento, formato, dias } = req.query;
  const params = [req.user.rango];
  const where = [`d.estado = 'activo'`, ACCESO];

  if (typeof q === 'string' && q.trim()) {
    params.push(`%${escapeLike(q.trim())}%`);
    where.push(`(d.nombre ILIKE $${params.length} OR d.folio ILIKE $${params.length})`);
  }
  if (typeof departamento === 'string' && departamento) {
    params.push(departamento);
    where.push(`dep.nombre = $${params.length}`);
  }
  if (['pdf', 'xlsx', 'docx', 'tiff'].includes(formato)) {
    params.push(formato);
    where.push(`d.formato = $${params.length}`);
  }
  if (/^\d{1,4}$/.test(dias ?? '')) {
    params.push(Number(dias));
    where.push(`d.actualizado_en >= now() - ($${params.length} || ' days')::interval`);
  }
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const { rows } = await query(
    `SELECT d.id, d.nombre, d.version_actual, d.formato, d.hash_sha256, d.origen, d.folio,
            dep.nombre AS departamento, dep.color_clase AS dep_color,
            d.autor_nombre, d.autor_email, d.tamano_bytes
     ${FROM} WHERE ${where.join(' AND ')}
     ORDER BY d.actualizado_en DESC LIMIT ${limit} OFFSET ${offset}`, params);

  res.json(rows.map((r) => ({
    id: String(r.id), name: r.nombre, version: r.version_actual, format: r.formato,
    hashLabel: r.hash_sha256 ? `SHA-256: ${hashCorto(r.hash_sha256)}` : (r.origen ?? 'Sin hash'),
    folio: r.folio, departamento: r.departamento ?? 'Sin departamento',
    departamentoColor: r.dep_color ?? 'bg-slate-100 text-slate-600',
    autor: r.autor_nombre, autorEmail: r.autor_email ?? '', tamano: formatBytes(r.tamano_bytes),
  })));
});

/** Detalle de un documento (panel de metadatos de la pantalla de visualización). */
router.get('/:id', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Documento no encontrado' });
  const { rows: [r] } = await query(
    `SELECT d.*, dep.nombre AS departamento, c.nombre AS clasificacion, t.nombre AS tipo
     ${FROM} WHERE d.id = $2 AND d.estado = 'activo' AND ${ACCESO}`, [req.user.rango, req.params.id]);
  if (!r) return res.status(404).json({ error: 'Documento no encontrado' });

  const tags = await query(
    `SELECT e.nombre FROM documento_etiquetas de JOIN etiquetas e ON e.id = de.etiqueta_id
      WHERE de.documento_id = $1 ORDER BY e.nombre`, [r.id]);
  await registrarAuditoria(req, 'ver_documento', r.id);

  res.json({
    id: String(r.id), nombre: r.nombre, version: r.version_actual, folio: r.folio, formato: r.formato,
    departamento: r.departamento ?? null, tipo: r.tipo ?? null, clasificacion: r.clasificacion ?? null,
    hash: r.hash_sha256, hashCorto: hashCorto(r.hash_sha256),
    autor: r.autor_nombre, autorLinea: `${r.autor_nombre}${r.departamento ? ` — ${r.departamento}` : ''}`,
    fechaCreacion: fechaHoraUTC(r.creado_en), tamano: formatBytes(r.tamano_bytes), paginas: r.paginas,
    etiquetas: tags.rows.map((x) => x.nombre),
    retencion: r.retencion_anios ? `${r.retencion_anios} Años${r.vence_retencion ? ` (Vence ${new Date(r.vence_retencion).getUTCFullYear()})` : ''}` : null,
    cifrado: r.cifrado_aes, ocr: r.ocr_procesado, firmadoPor: r.firmado_por, firmaValida: r.firma_valida,
  });
});

/** Texto OCR de una página (capa de texto del visor). */
router.get('/:id/paginas/:n', async (req, res) => {
  if (!idValido(req.params.id) || !idValido(req.params.n)) return res.status(404).json({ error: 'No encontrado' });
  const { rows: [p] } = await query(
    `SELECT p.pagina, p.seccion, p.texto, p.confianza, d.paginas AS total
       FROM documento_paginas p
       JOIN documentos d ON d.id = p.documento_id
       LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
      WHERE p.documento_id = $2 AND p.pagina = $3 AND d.estado = 'activo' AND ${ACCESO}`,
    [req.user.rango, req.params.id, req.params.n]);
  if (!p) return res.status(404).json({ error: 'Página sin texto OCR' });
  res.json({ pagina: p.pagina, totalPaginas: p.total, seccion: p.seccion, texto: p.texto, confianza: p.confianza && Number(p.confianza) });
});

/** Historial de versiones. */
router.get('/:id/versiones', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
  const { rows } = await query(
    `SELECT v.version, v.tamano_bytes, v.comentario, v.creado_en, u.nombre AS autor
       FROM documento_versiones v
       JOIN documentos d ON d.id = v.documento_id
       LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
       LEFT JOIN usuarios u ON u.id = v.autor_id
      WHERE v.documento_id = $2 AND ${ACCESO}
      ORDER BY v.creado_en DESC`, [req.user.rango, req.params.id]);
  res.json(rows.map((v) => ({ version: v.version, tamano: formatBytes(v.tamano_bytes), comentario: v.comentario, autor: v.autor, fecha: fechaCorta(v.creado_en) })));
});

/** Historial de auditoría del documento (solo admin / cumplimiento). */
router.get('/:id/auditoria', requireRole('super-admin', 'compliance'), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
  const { rows } = await query(
    `SELECT a.id, a.accion, a.ip, a.creado_en, u.nombre AS usuario
       FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.documento_id = $1 ORDER BY a.creado_en DESC LIMIT 100`, [req.params.id]);
  res.json(rows.map((a) => ({ id: `AUD-${a.id}`, accion: a.accion, usuario: a.usuario, ip: a.ip, cuando: haceCuanto(a.creado_en, true) })));
});

/** Enviar a la papelera de seguridad (borrado lógico) y avisar a admin/cumplimiento. */
router.delete('/:id', requireRole('super-admin', 'compliance'), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Documento no encontrado' });
  const { rows: [d] } = await query(
    `UPDATE documentos d SET estado = 'papelera', eliminado_en = now(), eliminado_por = $2
       FROM (SELECT d2.id FROM documentos d2 LEFT JOIN clasificaciones c ON c.id = d2.clasificacion_id
              WHERE d2.id = $1 AND d2.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $3)) ok
      WHERE d.id = ok.id RETURNING d.id, d.nombre`, [req.params.id, req.user.id, req.user.rango]);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });

  await registrarAuditoria(req, 'eliminar', d.id, { nombre: d.nombre });
  await query(
    `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, icono, titulo, descripcion, meta, acciones, documento_id)
     SELECT u.id, 'eliminado', 'border-l-red-500', 'ISO 27001 Sec. 8.3', 'bg-red-50 text-red-700', '🗑️',
            $2, 'El expediente permanecerá bloqueado en retención inmutable antes de cualquier purga.', $3::jsonb,
            '[{"label":"Restaurar Documento","style":"border"}]'::jsonb, $1
       FROM usuarios u JOIN roles r ON r.id = u.rol_id
      WHERE r.clave IN ('super-admin','compliance') AND u.activo`,
    [d.id, `Documento enviado a Papelera de Seguridad: ${d.nombre}`, JSON.stringify([`IP de Origen: ${req.ip}`])]);
  res.status(204).end();
});

export default router;
