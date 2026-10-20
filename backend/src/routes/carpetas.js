/**
 * Carpetas (Fase 5): UN solo nivel y solo para organizar. NO cambian permisos: quién ve un documento lo sigue
 * decidiendo su clasificación frente al nivel del usuario, esté en la carpeta que esté.
 *
 *  - Crear, renombrar y mover: Super Administrador y Operador OCR.
 *  - Eliminar (solo si está vacía): Super Administrador.
 *  - El Oficial de Cumplimiento NO mueve: envía una solicitud con motivo, que aprueba o rechaza un Super
 *    Administrador u Operador OCR que alcance el nivel del documento. Quien solicita nunca resuelve.
 * Todo queda auditado y notificado.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { notificarUsuarios } from '../lib/notify.js';
import { fechaHoraCO, idValido, textoLimpio } from '../lib/format.js';

const router = Router();

export const ROLES_CARPETAS = ['super-admin', 'ocr-operator'];   // crear, renombrar, mover y resolver solicitudes
export const ROLES_ELIMINAR_CARPETA = ['super-admin'];
export const ROLES_SOLICITAR = ['compliance'];
// Quienes reciben los avisos de carpetas (los mismos que gestionan o supervisan la organización).
const ROLES_AVISO = ['super-admin', 'compliance', 'ocr-operator'];
const MAX_MOVER = 100;

// $1 = rango del usuario. Mismo criterio de acceso que la biblioteca: activo y de su nivel o inferior.
const VISIBLE = `d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)`;
const nombreDestino = (carpeta) => (carpeta ? `«${carpeta.nombre}»` : '«Sin carpeta»');

/** Nombre de carpeta: una línea, 2 a 80 caracteres, y no puede llamarse como la opción "Sin carpeta". */
function validarNombre(v) {
  const nombre = textoLimpio(v, 81);
  if (nombre.length < 2 || nombre.length > 80) return { error: 'El nombre de la carpeta debe tener entre 2 y 80 caracteres.' };
  if (nombre.toLowerCase() === 'sin carpeta') return { error: 'Ese nombre está reservado. Elija otro.' };
  return { nombre };
}
const DUPLICADA = 'Ya existe una carpeta con ese nombre (no se distinguen mayúsculas).';

/** carpetaId del cuerpo: null (sacar de la carpeta) o un id. undefined = no vino o no es válido. */
function leerCarpetaId(v) {
  if (v === null) return { id: null };
  if ((typeof v === 'string' || typeof v === 'number') && idValido(v)) return { id: String(v) };
  return { error: 'Indique la carpeta de destino (carpetaId) o null para dejar el documento sin carpeta.' };
}

// --------------------------------------------------------------------------------------------- carpetas

/** Lista de carpetas con cuántos documentos VISIBLES para el usuario tiene cada una, y qué puede hacer él. */
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT ca.id, ca.nombre, count(d.id)::int AS documentos
       FROM carpetas ca
       LEFT JOIN documentos d ON d.carpeta_id = ca.id AND d.estado = 'activo'
         AND EXISTS (SELECT 1 FROM clasificaciones c WHERE c.id = d.clasificacion_id AND c.nivel_minimo <= $1)
      GROUP BY ca.id ORDER BY lower(ca.nombre), ca.id`, [req.user.rango]);
  const { rows: [sin] } = await query(
    `SELECT count(*)::int AS n FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
      WHERE d.carpeta_id IS NULL AND ${VISIBLE}`, [req.user.rango]);
  const rol = req.user.rol;
  res.json({
    carpetas: rows.map((r) => ({ id: String(r.id), nombre: r.nombre, documentos: r.documentos })),
    sinCarpeta: sin.n,
    permisos: {
      gestionar: ROLES_CARPETAS.includes(rol),          // crear, renombrar y mover
      eliminar: ROLES_ELIMINAR_CARPETA.includes(rol),
      solicitar: ROLES_SOLICITAR.includes(rol),
      resolver: ROLES_CARPETAS.includes(rol),
    },
  });
});

router.post('/', requireRole(...ROLES_CARPETAS), async (req, res) => {
  const v = validarNombre(req.body?.nombre);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const { rows: [ca] } = await query(
      `INSERT INTO carpetas (nombre, creado_por) VALUES ($1, $2) RETURNING id, nombre`, [v.nombre, req.user.id]);
    await registrarAuditoria(req, 'crear_carpeta', null, { carpetaId: String(ca.id), nombre: ca.nombre });
    await notificarUsuarios({
      roles: ROLES_AVISO, titulo: `Carpeta creada: ${ca.nombre}`,
      descripcion: 'Nueva carpeta para organizar documentos. No cambia quién puede ver cada documento.',
    });
    res.status(201).json({ id: String(ca.id), nombre: ca.nombre, documentos: 0 });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: DUPLICADA });
    throw e;
  }
});

router.patch('/:id', requireRole(...ROLES_CARPETAS), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Carpeta no encontrada.' });
  const v = validarNombre(req.body?.nombre);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await withTransaction(async (c) => {
      const { rows: [antes] } = await c.query(`SELECT id, nombre FROM carpetas WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!antes) return null;
      await c.query(`UPDATE carpetas SET nombre = $2, actualizado_en = now() WHERE id = $1`, [antes.id, v.nombre]);
      return antes;
    });
    if (!r) return res.status(404).json({ error: 'Carpeta no encontrada.' });
    if (r.nombre !== v.nombre) {
      await registrarAuditoria(req, 'renombrar_carpeta', null, { carpetaId: String(r.id), anterior: r.nombre, nombre: v.nombre });
      await notificarUsuarios({
        roles: ROLES_AVISO, titulo: `Carpeta renombrada: ${r.nombre} → ${v.nombre}`,
        descripcion: 'Los documentos que contiene no cambian.',
      });
    }
    res.json({ id: String(r.id), nombre: v.nombre });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: DUPLICADA });
    throw e;
  }
});

/** Solo vacía: sin documentos (tampoco en la papelera, que podrían restaurarse a ella) ni solicitudes pendientes hacia ella. */
router.delete('/:id', requireRole(...ROLES_ELIMINAR_CARPETA), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Carpeta no encontrada.' });
  const r = await withTransaction(async (c) => {
    const { rows: [ca] } = await c.query(`SELECT id, nombre FROM carpetas WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!ca) return { status: 404, error: 'Carpeta no encontrada.' };
    // FOR UPDATE de la carpeta + FOR SHARE en mover/aprobar: nadie mete un documento mientras se comprueba que está vacía.
    const { rows: [n] } = await c.query(
      `SELECT count(*)::int AS docs FROM documentos WHERE carpeta_id = $1 AND estado <> 'purgado'`, [ca.id]);
    if (n.docs > 0)
      return { status: 409, error: `La carpeta no está vacía: contiene ${n.docs} ${n.docs === 1 ? 'documento' : 'documentos'} (se cuentan también los de la papelera). Muévalos antes de eliminarla.` };
    const { rows: [s] } = await c.query(
      `SELECT count(*)::int AS n FROM solicitudes_movimiento WHERE carpeta_destino_id = $1 AND estado = 'pendiente'`, [ca.id]);
    if (s.n > 0) return { status: 409, error: 'Hay solicitudes de movimiento pendientes hacia esta carpeta. Resuélvalas antes de eliminarla.' };
    await c.query(`DELETE FROM carpetas WHERE id = $1`, [ca.id]);
    return { status: 204, carpeta: ca };
  });
  if (r.status !== 204) return res.status(r.status).json({ error: r.error });
  await registrarAuditoria(req, 'eliminar_carpeta', null, { carpetaId: String(r.carpeta.id), nombre: r.carpeta.nombre });
  await notificarUsuarios({ roles: ROLES_AVISO, titulo: `Carpeta eliminada: ${r.carpeta.nombre}`, descripcion: 'Estaba vacía.' });
  res.status(204).end();
});

// --------------------------------------------------------------------------------------------- mover

/**
 * Mueve hasta 100 documentos a una carpeta (o los saca de la suya) en UNA transacción. Los que el usuario no puede
 * ver o que no están activos se devuelven en "omitidos" sin decir por qué (no se revela si existen).
 */
router.post('/mover', requireRole(...ROLES_CARPETAS), async (req, res) => {
  const { ids, carpetaId } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Seleccione al menos un documento.' });
  if (ids.length > MAX_MOVER) return res.status(400).json({ error: `Como máximo ${MAX_MOVER} documentos por operación.` });
  if (!ids.every((x) => (typeof x === 'string' || typeof x === 'number') && idValido(x)))
    return res.status(400).json({ error: 'Hay identificadores de documento no válidos.' });
  const destino = leerCarpetaId(carpetaId);
  if (destino.error) return res.status(400).json({ error: destino.error });
  const pedidos = [...new Set(ids.map(String))];

  const r = await withTransaction(async (c) => {
    let carpeta = null;
    if (destino.id) {
      // FOR SHARE: la carpeta no puede eliminarse mientras se mueven documentos a ella.
      ({ rows: [carpeta] } = await c.query(`SELECT id, nombre FROM carpetas WHERE id = $1 FOR SHARE`, [destino.id]));
      if (!carpeta) return { status: 404, error: 'La carpeta de destino no existe.' };
    }
    const { rows: docs } = await c.query(
      `SELECT d.id, d.nombre, d.folio, d.carpeta_id, ca.nombre AS carpeta_nombre
         FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id LEFT JOIN carpetas ca ON ca.id = d.carpeta_id
        WHERE d.id = ANY($2::bigint[]) AND ${VISIBLE}
        ORDER BY d.id FOR UPDATE OF d`, [req.user.rango, pedidos]);
    const visibles = new Set(docs.map((d) => String(d.id)));
    const aMover = docs.filter((d) => String(d.carpeta_id ?? '') !== String(destino.id ?? ''));
    if (aMover.length) {
      await c.query(`SET LOCAL dai.conservar_actualizado = 'on'`); // organizar no es modificar el documento
      await c.query(`UPDATE documentos SET carpeta_id = $2 WHERE id = ANY($1::bigint[])`, [aMover.map((d) => d.id), destino.id]);
    }
    return { status: 200, carpeta, aMover, sinCambios: docs.length - aMover.length, omitidos: pedidos.filter((id) => !visibles.has(id)) };
  });
  if (r.status !== 200) return res.status(r.status).json({ error: r.error });

  for (const d of r.aMover)
    await registrarAuditoria(req, 'mover_documento', d.id, {
      de: d.carpeta_id ? String(d.carpeta_id) : null, deNombre: d.carpeta_nombre ?? null,
      a: destino.id, aNombre: r.carpeta?.nombre ?? null,
    });
  if (r.aMover.length) {
    // Un solo aviso por operación y SIN nombres de documentos: así no revela nada a quien no alcanza su nivel.
    await notificarUsuarios({
      roles: ROLES_AVISO,
      titulo: r.aMover.length === 1 ? `Documento movido a ${nombreDestino(r.carpeta)}` : `${r.aMover.length} documentos movidos a ${nombreDestino(r.carpeta)}`,
      descripcion: 'Organización de la biblioteca. Mover un documento no cambia quién puede verlo.',
      meta: [`Folios: ${r.aMover.slice(0, 5).map((d) => d.folio).join(', ')}${r.aMover.length > 5 ? '…' : ''}`],
    });
  }
  res.json({ movidos: r.aMover.length, sinCambios: r.sinCambios, omitidos: r.omitidos });
});

// --------------------------------------------------------------------------------------------- solicitudes

/** Fila de solicitud presentada para el front. */
const presentar = (s, usuario) => ({
  id: String(s.id),
  documento: { id: String(s.documento_id), nombre: s.documento_nombre, folio: s.folio },
  carpetaActual: s.actual_id ? { id: String(s.actual_id), nombre: s.actual_nombre } : null,
  carpetaDestino: s.carpeta_destino_id ? { id: String(s.carpeta_destino_id), nombre: s.destino_nombre } : null,
  solicitante: s.solicitante ?? 'Usuario eliminado',
  motivo: s.motivo,
  estado: s.estado,
  fecha: fechaHoraCO(s.creado_en),
  resueltoPor: s.resolutor ?? null,
  resueltoEn: s.resuelto_en ? fechaHoraCO(s.resuelto_en) : null,
  respuesta: s.respuesta ?? null,
  puedeResolver: s.estado === 'pendiente' && ROLES_CARPETAS.includes(usuario.rol) && String(s.solicitante_id) !== String(usuario.id),
});

const SELECT_SOLICITUD = `
  SELECT s.*, d.nombre AS documento_nombre, d.folio, d.carpeta_id AS actual_id, ca.nombre AS actual_nombre,
         cd.nombre AS destino_nombre, us.nombre AS solicitante, ur.nombre AS resolutor
    FROM solicitudes_movimiento s
    JOIN documentos d ON d.id = s.documento_id
    LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
    LEFT JOIN carpetas ca ON ca.id = d.carpeta_id
    LEFT JOIN carpetas cd ON cd.id = s.carpeta_destino_id
    LEFT JOIN usuarios us ON us.id = s.solicitante_id
    LEFT JOIN usuarios ur ON ur.id = s.resuelto_por`;

/** Pedir que un documento se mueva (solo Cumplimiento). Motivo obligatorio; una sola pendiente por documento. */
router.post('/solicitudes', requireRole(...ROLES_SOLICITAR), async (req, res) => {
  const { documentoId, carpetaId } = req.body ?? {};
  if (!((typeof documentoId === 'string' || typeof documentoId === 'number') && idValido(documentoId)))
    return res.status(400).json({ error: 'Indique el documento (documentoId).' });
  const destino = leerCarpetaId(carpetaId);
  if (destino.error) return res.status(400).json({ error: destino.error });
  const motivo = textoLimpio(req.body?.motivo, 501);
  if (motivo.length < 10 || motivo.length > 500) return res.status(400).json({ error: 'El motivo debe tener entre 10 y 500 caracteres.' });

  let r;
  try {
    r = await withTransaction(async (c) => {
      const { rows: [d] } = await c.query(
        `SELECT d.id, d.nombre, d.folio, d.carpeta_id, coalesce(c.nivel_minimo, 1) AS nivel
           FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
          WHERE d.id = $2 AND ${VISIBLE} FOR UPDATE OF d`, [req.user.rango, String(documentoId)]);
      if (!d) return { status: 404, error: 'Documento no encontrado.' };
      let carpeta = null;
      if (destino.id) {
        ({ rows: [carpeta] } = await c.query(`SELECT id, nombre FROM carpetas WHERE id = $1 FOR SHARE`, [destino.id]));
        if (!carpeta) return { status: 404, error: 'La carpeta de destino no existe.' };
      }
      if (String(d.carpeta_id ?? '') === String(destino.id ?? ''))
        return { status: 409, error: `El documento ya está en ${nombreDestino(carpeta)}.`, codigo: 'sin_cambios' };
      const { rows: [s] } = await c.query(
        `INSERT INTO solicitudes_movimiento (documento_id, carpeta_destino_id, solicitante_id, motivo)
         VALUES ($1, $2, $3, $4) RETURNING id`, [d.id, destino.id, req.user.id, motivo]);
      return { status: 201, id: s.id, doc: d, carpeta };
    });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'Ya hay una solicitud de movimiento pendiente para este documento.', codigo: 'duplicada' });
    throw e;
  }
  if (r.status !== 201) return res.status(r.status).json({ error: r.error, codigo: r.codigo });

  await registrarAuditoria(req, 'solicitar_movimiento', r.doc.id, { solicitudId: String(r.id), a: destino.id, aNombre: r.carpeta?.nombre ?? null, motivo });
  // A quienes pueden resolverla Y alcanzan el nivel del documento.
  await notificarUsuarios({
    roles: ROLES_CARPETAS, nivelMinimo: r.doc.nivel, documentoId: r.doc.id,
    titulo: `Solicitud de movimiento: ${r.doc.nombre}`,
    descripcion: `Se pide moverlo a ${nombreDestino(r.carpeta)}. Motivo: ${motivo}`,
    meta: [`Folio: ${r.doc.folio}`, 'Apruébela o recházela desde la Biblioteca'],
  });
  res.status(201).json({ id: String(r.id) });
});

/**
 * Solicitudes. Quien resuelve (Admin/Operador) ve las de documentos de su nivel; Cumplimiento ve las suyas.
 * ?estado=pendiente (por defecto) | aprobada | rechazada | todas
 */
router.get('/solicitudes', requireRole(...ROLES_CARPETAS, ...ROLES_SOLICITAR), async (req, res) => {
  const estado = typeof req.query.estado === 'string' ? req.query.estado : 'pendiente';
  if (!['pendiente', 'aprobada', 'rechazada', 'todas'].includes(estado)) return res.status(400).json({ error: 'Estado no válido.' });
  const params = [req.user.rango];
  const where = ['(c.id IS NULL OR c.nivel_minimo <= $1)'];
  if (estado !== 'todas') { params.push(estado); where.push(`s.estado = $${params.length}`); }
  if (!ROLES_CARPETAS.includes(req.user.rol)) { params.push(req.user.id); where.push(`s.solicitante_id = $${params.length}`); }
  const { rows } = await query(`${SELECT_SOLICITUD} WHERE ${where.join(' AND ')} ORDER BY s.creado_en DESC, s.id DESC LIMIT 100`, params);
  res.json(rows.map((s) => presentar(s, req.user)));
});

/** Aprobar o rechazar. Bloquea la solicitud (FOR UPDATE): dos gestores a la vez no la resuelven dos veces. */
const resolver = (aprobar) => async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  const respuesta = textoLimpio(req.body?.respuesta, 501);
  if (respuesta.length > 500) return res.status(400).json({ error: 'La respuesta admite como máximo 500 caracteres.' });
  if (!aprobar && respuesta.length < 3) return res.status(400).json({ error: 'Indique el motivo del rechazo (mínimo 3 caracteres).' });

  const r = await withTransaction(async (c) => {
    const { rows: [s] } = await c.query(
      `SELECT s.*, d.nombre AS documento_nombre, d.folio, d.estado AS documento_estado, d.carpeta_id AS actual_id,
              coalesce(cl.nivel_minimo, 1) AS nivel
         FROM solicitudes_movimiento s JOIN documentos d ON d.id = s.documento_id
         LEFT JOIN clasificaciones cl ON cl.id = d.clasificacion_id
        WHERE s.id = $1 FOR UPDATE OF s, d`, [req.params.id]);
    // Fuera de su nivel: 404, igual que si no existiera.
    if (!s || s.nivel > req.user.rango) return { status: 404, error: 'Solicitud no encontrada.' };
    if (String(s.solicitante_id) === String(req.user.id))
      return { status: 403, error: 'Quien solicita un movimiento no puede resolver su propia solicitud.' };
    if (s.estado !== 'pendiente') return { status: 409, error: 'Esta solicitud ya fue resuelta.', codigo: 'resuelta' };

    let carpeta = null;
    if (aprobar) {
      if (s.documento_estado !== 'activo')
        return { status: 409, error: 'El documento ya no está activo (por ejemplo, está en la papelera). Rechace la solicitud.', codigo: 'no_activo' };
      if (s.carpeta_destino_id) {
        ({ rows: [carpeta] } = await c.query(`SELECT id, nombre FROM carpetas WHERE id = $1 FOR SHARE`, [s.carpeta_destino_id]));
        if (!carpeta) return { status: 409, error: 'La carpeta de destino ya no existe. Rechace la solicitud.' };
      }
      // El movimiento se aplica en la MISMA transacción que la aprobación: o pasan las dos cosas o ninguna.
      if (String(s.actual_id ?? '') !== String(s.carpeta_destino_id ?? '')) {
        await c.query(`SET LOCAL dai.conservar_actualizado = 'on'`);
        await c.query(`UPDATE documentos SET carpeta_id = $2 WHERE id = $1`, [s.documento_id, s.carpeta_destino_id]);
      }
    }
    await c.query(
      `UPDATE solicitudes_movimiento SET estado = $2, resuelto_por = $3, resuelto_en = now(), respuesta = $4 WHERE id = $1`,
      [s.id, aprobar ? 'aprobada' : 'rechazada', req.user.id, respuesta || null]);
    return { status: 200, s, carpeta };
  });
  if (r.status !== 200) return res.status(r.status).json({ error: r.error, codigo: r.codigo });

  const { s, carpeta } = r;
  const detalle = { solicitudId: String(s.id), a: s.carpeta_destino_id ? String(s.carpeta_destino_id) : null, respuesta: respuesta || null };
  await registrarAuditoria(req, aprobar ? 'aprobar_movimiento' : 'rechazar_movimiento', s.documento_id, detalle);
  if (aprobar && String(s.actual_id ?? '') !== String(s.carpeta_destino_id ?? ''))
    await registrarAuditoria(req, 'mover_documento', s.documento_id, {
      de: s.actual_id ? String(s.actual_id) : null, a: detalle.a, aNombre: carpeta?.nombre ?? null, solicitudId: String(s.id),
    });
  if (s.solicitante_id)
    await notificarUsuarios({
      usuarioIds: [s.solicitante_id], nivelMinimo: s.nivel, documentoId: s.documento_id,
      titulo: `${aprobar ? 'Solicitud aprobada' : 'Solicitud rechazada'}: ${s.documento_nombre}`,
      descripcion: aprobar
        ? `El documento se movió a ${nombreDestino(carpeta)}.${respuesta ? ` Comentario: ${respuesta}` : ''}`
        : `El documento no se movió. Motivo: ${respuesta}`,
      meta: [`Folio: ${s.folio}`],
    });
  res.json({ ok: true, estado: aprobar ? 'aprobada' : 'rechazada' });
};

router.post('/solicitudes/:id/aprobar', requireRole(...ROLES_CARPETAS), resolver(true));
router.post('/solicitudes/:id/rechazar', requireRole(...ROLES_CARPETAS), resolver(false));

export default router;
