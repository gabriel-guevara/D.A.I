/**
 * Papelera (montado en /api/papelera). Enviar a la papelera es DELETE /api/documentos/:id.
 *
 *  GET    /                  documentos en la papelera que el usuario alcanza por nivel
 *  POST   /:id/restaurar     vuelve a estar activo tal cual (archivo, versiones y texto intactos)
 *  POST   /:id/purgar        borrado DEFINITIVO de un documento (pide código 2FA)
 *  POST   /vaciar            purga todo lo que se pueda de la papelera (pide código 2FA)
 *
 * Quién puede qué (y por qué):
 *  - Ver y restaurar: Super Administrador y Oficial de Cumplimiento, los mismos que pueden enviar a la papelera.
 *    Restaurar es reversible (se puede volver a eliminar), así que no exige más.
 *  - Purgar y vaciar: SOLO el Super Administrador, y confirmando con su segundo factor ("step-up"). Es lo único
 *    irreversible del sistema: destruye el archivo, todas sus versiones y su texto. Separación de funciones:
 *    Cumplimiento custodia (ve y restaura) pero no destruye evidencia.
 *  - Nadie purga un documento con retención legal vigente (vence_retencion en el futuro), ni a mano ni en la
 *    purga automática.
 *
 * Un documento purgado no se borra de la tabla: queda como "lápida" (estado 'purgado', nombre, folio, huellas
 * y quién/cuándo) para que la auditoría siga teniendo a qué referirse. Su contenido sí desaparece.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { notificarGestores } from '../lib/notify.js';
import { fechaDeDia, fechaHoraCO, formatBytes, haceCuanto, idValido } from '../lib/format.js';
import { exigirSegundoFactor } from '../lib/step-up.js';
import {
  despertarMantenimiento, detallePurga, diasRetencionPapelera, purgarEnTransaccion, resumenBorrados, SQL_FECHA_PURGA,
} from '../lib/papelera.js';
import { ROLES_PAPELERA } from './documentos.js';
import { limitadorIp } from './auth.js';

const router = Router();
export const ROLES_PURGAR = ['super-admin'];
export const MAX_VACIAR = 100; // por petición: una petición larga en Render gratuito puede cortarse

const FROM = `
  FROM documentos d
  LEFT JOIN departamentos dep ON dep.id = d.departamento_id
  LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id`;
// $1 = rango del usuario
const EN_PAPELERA = `d.estado = 'papelera' AND (c.id IS NULL OR c.nivel_minimo <= $1)`;
const EN_RETENCION = `(d.vence_retencion IS NOT NULL AND d.vence_retencion > current_date)`;

const NO_ENCONTRADO = { error: 'Documento no encontrado en la papelera' };
const retencionVigente = (fecha) => ({
  error: `Retención legal vigente hasta el ${fecha}: no se puede purgar antes. Puede restaurarlo o esperar al vencimiento.`,
  codigo: 'retencion',
});

/** Documento de la papelera visible para el usuario, con su retención legal. */
async function enPapelera(req) {
  if (!idValido(req.params.id)) return null;
  const { rows: [d] } = await query(
    `SELECT d.id, ${EN_RETENCION} AS en_retencion, to_char(d.vence_retencion, 'YYYY-MM-DD') AS vence
     ${FROM} WHERE d.id = $2 AND ${EN_PAPELERA}`, [req.user.rango, req.params.id]);
  return d ?? null;
}

router.use(requireRole(...ROLES_PAPELERA));

// ---------------------------------------------------------------------------------------------- listar

router.get('/', async (req, res) => {
  despertarMantenimiento(); // Render pudo estar dormido: se aprovecha la visita para la purga por retención
  const dias = diasRetencionPapelera();
  const { rows } = await query(
    `SELECT d.id, d.nombre, d.folio, d.formato, d.version_actual, d.tiene_archivo, d.eliminado_en,
            dep.nombre AS departamento, c.nombre AS clasificacion, u.nombre AS eliminado_por,
            CASE WHEN $2::int > 0 THEN ${SQL_FECHA_PURGA(2)} END AS purga_en,
            ${EN_RETENCION} AS en_retencion, to_char(d.vence_retencion, 'YYYY-MM-DD') AS vence,
            (SELECT count(*)::int FROM documento_versiones v WHERE v.documento_id = d.id) AS versiones,
            (SELECT coalesce(sum(v.tamano_bytes), 0) FROM documento_versiones v
              WHERE v.documento_id = d.id AND v.storage_path IS NOT NULL) AS bytes_archivos
     ${FROM} LEFT JOIN usuarios u ON u.id = d.eliminado_por
      WHERE ${EN_PAPELERA}
      ORDER BY d.eliminado_en DESC NULLS LAST, d.id DESC LIMIT 500`, [req.user.rango, dias]);

  const puedePurgar = ROLES_PURGAR.includes(req.user.rol);
  res.json({
    diasRetencion: dias,
    puedePurgar,
    // Objetos que aún se están borrando del almacenamiento (solo para quien puede purgar).
    borrado: puedePurgar ? await resumenBorrados() : null,
    documentos: rows.map((r) => ({
      id: String(r.id), nombre: r.nombre, folio: r.folio, formato: r.formato, version: r.version_actual,
      departamento: r.departamento ?? 'Sin departamento', clasificacion: r.clasificacion ?? 'Sin clasificar',
      eliminadoPor: r.eliminado_por ?? '—', eliminadoEn: fechaHoraCO(r.eliminado_en), haceCuanto: haceCuanto(r.eliminado_en, true),
      purgaAutomatica: r.purga_en && !r.en_retencion ? fechaHoraCO(r.purga_en) : null,
      retencionHasta: r.en_retencion ? fechaDeDia(r.vence) : null,
      versiones: r.versiones, tamanoArchivos: formatBytes(r.bytes_archivos), tieneArchivo: r.tiene_archivo,
    })),
  });
});

// ---------------------------------------------------------------------------------------------- restaurar

router.post('/:id/restaurar', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json(NO_ENCONTRADO);
  const d = await withTransaction(async (c) => {
    // FOR UPDATE: si alguien lo está purgando, se espera y se vuelve a comprobar que siga en la papelera.
    const { rows: [doc] } = await c.query(
      `SELECT d.id, d.nombre, d.folio, d.eliminado_en, d.eliminado_por
       ${FROM} WHERE d.id = $2 AND ${EN_PAPELERA} FOR UPDATE OF d`, [req.user.rango, req.params.id]);
    if (!doc) return null;
    await c.query(
      `UPDATE documentos SET estado = 'activo', eliminado_en = NULL, eliminado_por = NULL, purgar_despues_de = NULL WHERE id = $1`, [doc.id]);
    return doc;
  });
  if (!d) return res.status(404).json(NO_ENCONTRADO);

  await registrarAuditoria(req, 'restaurar_documento', Number(d.id), {
    nombre: d.nombre, folio: d.folio, eliminadoEn: d.eliminado_en, eliminadoPor: d.eliminado_por ? String(d.eliminado_por) : null,
  });
  await notificarGestores({
    categoria: 'eliminado', documentoId: d.id,
    titulo: `Documento restaurado desde la Papelera: ${d.nombre}`,
    descripcion: 'Vuelve a estar disponible en la biblioteca y la búsqueda con su archivo, versiones y texto.',
    meta: [`Folio: ${d.folio}`],
  });
  res.json({ ok: true, id: String(d.id) });
});

// ---------------------------------------------------------------------------------------------- purgar

/**
 * Purga definitiva. Orden: 1) comprobar que existe y no tiene retención (antes de gastar el código 2FA),
 * 2) step-up, 3) transacción (lápida + cola de borrado), 4) auditoría, 5) borrar objetos en segundo plano.
 */
router.post('/:id/purgar', requireRole(...ROLES_PURGAR), limitadorIp, async (req, res) => {
  const d = await enPapelera(req);
  if (!d) return res.status(404).json(NO_ENCONTRADO);
  if (d.en_retencion) return res.status(409).json(retencionVigente(fechaDeDia(d.vence)));

  const factor = await exigirSegundoFactor(req, res, 'purgar_documento');
  if (!factor) return;

  const r = await withTransaction((c) => purgarEnTransaccion(c, d.id, { usuarioId: req.user.id }));
  if (r.error === 'retencion') return res.status(409).json(retencionVigente(fechaDeDia(d.vence)));
  if (r.error) return res.status(404).json(NO_ENCONTRADO); // restaurado o purgado por otro mientras tanto

  await registrarAuditoria(req, 'purgar_documento', r.documento.id, { ...detallePurga(r, 'manual'), segundoFactor: factor });
  await notificarGestores({
    categoria: 'eliminado', documentoId: r.documento.id,
    titulo: `Documento purgado definitivamente: ${r.documento.nombre}`,
    descripcion: `Se eliminaron su archivo, ${r.versiones.length} ${r.versiones.length === 1 ? 'versión' : 'versiones'} y su texto. Queda el registro en la auditoría.`,
    meta: [`Folio: ${r.documento.folio}`, `IP de Origen: ${req.ip}`],
  });
  despertarMantenimiento(); // borra los objetos después de responder
  res.json({ ok: true, versiones: r.versiones.length, objetos: r.objetos });
});

/** Vaciar: purga hasta MAX_VACIAR documentos de la papelera (los de retención legal se quedan). */
router.post('/vaciar', requireRole(...ROLES_PURGAR), limitadorIp, async (req, res) => {
  const contar = async () => (await query(
    `SELECT count(*) FILTER (WHERE NOT ${EN_RETENCION})::int AS purgables, count(*) FILTER (WHERE ${EN_RETENCION})::int AS en_retencion
     ${FROM} WHERE ${EN_PAPELERA}`, [req.user.rango])).rows[0];
  const antes = await contar();
  if (!antes.purgables)
    return res.status(409).json({ error: antes.en_retencion
      ? 'Todo lo que hay en la papelera tiene retención legal vigente: no hay nada que se pueda purgar.'
      : 'La papelera está vacía.', codigo: 'nada_que_purgar' });

  const factor = await exigirSegundoFactor(req, res, 'vaciar_papelera');
  if (!factor) return;

  const { rows } = await query(
    `SELECT d.id ${FROM} WHERE ${EN_PAPELERA} AND NOT ${EN_RETENCION}
      ORDER BY d.eliminado_en NULLS FIRST, d.id LIMIT ${MAX_VACIAR}`, [req.user.rango]);
  let purgados = 0;
  for (const { id } of rows) {
    const r = await withTransaction((c) => purgarEnTransaccion(c, id, { usuarioId: req.user.id }));
    if (r.error) continue;
    purgados++;
    await registrarAuditoria(req, 'purgar_documento', r.documento.id, { ...detallePurga(r, 'vaciar'), segundoFactor: factor });
  }
  const despues = await contar();
  await registrarAuditoria(req, 'vaciar_papelera', null, {
    purgados, enRetencion: despues.en_retencion, restantes: despues.purgables, segundoFactor: factor,
  });
  despertarMantenimiento();
  res.json({ ok: true, purgados, enRetencion: despues.en_retencion, restantes: despues.purgables });
});

export default router;
