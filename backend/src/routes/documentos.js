import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { query } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { notificarConsulta } from '../lib/notify.js';
import { escapeLike, fechaCorta, fechaHoraCO, formatBytes, hashCorto, haceCuanto, idValido } from '../lib/format.js';
import { almacenamiento, ErrorObjetoNoEncontrado, ErrorRangoInvalido } from '../lib/storage.js';
import { contentDisposition, interpretarRango, sha256DeStream } from '../lib/archivo-http.js';
import { COLUMNAS_INDEXACION, despertarIndexador, presentarIndexacion, solicitarIndexacion } from '../lib/indexador.js';

const router = Router();

const FROM = `
  FROM documentos d
  LEFT JOIN departamentos dep ON dep.id = d.departamento_id
  LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
  LEFT JOIN tipos_documentales t ON t.id = d.tipo_id`;
// $1 siempre es el rango del usuario: solo ve documentos de su nivel o inferior
const ACCESO = `(c.id IS NULL OR c.nivel_minimo <= $1)`;
const ROLES_INTEGRIDAD = ['super-admin', 'compliance'];
// Reprocesar el texto: quienes ingresan documentos (operador OCR) y el administrador. Cumplimiento y lectores
// solo consultan: reprocesar cambia el índice de búsqueda (no el original), y es tarea de la ingesta.
const ROLES_REINDEXAR = ['super-admin', 'ocr-operator'];
const NO_DISPONIBLE = 'Archivo no disponible en este entorno';
const SIN_ARCHIVO = 'Este documento no tiene archivo original cargado (solo metadatos y capa de texto).';

/** Documento visible para el usuario (mismas reglas de estado y nivel que el detalle), con los datos de su archivo. */
async function documentoConArchivo(req) {
  if (!idValido(req.params.id)) return null;
  const { rows: [r] } = await query(
    `SELECT d.id, d.tiene_archivo, d.storage_path, d.storage_driver, d.nombre_original, d.tamano_bytes, d.hash_sha256
     ${FROM} WHERE d.id = $2 AND d.estado = 'activo' AND ${ACCESO}`, [req.user.rango, req.params.id]);
  return r ?? null;
}

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
    `SELECT d.id, d.nombre, d.version_actual, d.formato, d.hash_sha256, d.origen, d.folio, d.tiene_archivo,
            dep.nombre AS departamento, dep.color_clase AS dep_color,
            d.autor_nombre, d.autor_email, d.tamano_bytes
     ${FROM} WHERE ${where.join(' AND ')}
     ORDER BY d.actualizado_en DESC LIMIT ${limit} OFFSET ${offset}`, params);

  res.json(rows.map((r) => ({
    id: String(r.id), name: r.nombre, version: r.version_actual, format: r.formato,
    // Solo se muestra la huella de documentos con archivo real; la del seed no corresponde a ningún archivo.
    hashLabel: r.tiene_archivo && r.hash_sha256 ? `SHA-256: ${hashCorto(r.hash_sha256)}` : (r.origen ?? 'Sin archivo original'),
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
  const verif = await query(
    `SELECT detalle, creado_en FROM auditoria WHERE documento_id = $1 AND accion = 'verificar_integridad'
      ORDER BY creado_en DESC, id DESC LIMIT 1`, [r.id]);
  const indexacion = r.tiene_archivo ? await leerIndexacion(r.id) : null;
  await registrarAuditoria(req, 'ver_documento', r.id);
  await notificarConsulta(req, { id: r.id, nombre: r.nombre, folio: r.folio });

  res.json({
    id: String(r.id), nombre: r.nombre, version: r.version_actual, folio: r.folio, formato: r.formato,
    departamento: r.departamento ?? null, tipo: r.tipo ?? null, clasificacion: r.clasificacion ?? null,
    hash: r.hash_sha256, hashCorto: hashCorto(r.hash_sha256),
    autor: r.autor_nombre, autorLinea: `${r.autor_nombre}${r.departamento ? ` — ${r.departamento}` : ''}`,
    fechaCreacion: fechaHoraCO(r.creado_en), tamano: formatBytes(r.tamano_bytes), paginas: r.paginas,
    etiquetas: tags.rows.map((x) => x.nombre),
    tieneArchivo: r.tiene_archivo,
    archivo: r.tiene_archivo ? {
      nombreOriginal: r.nombre_original, tamanoBytes: Number(r.tamano_bytes), almacenamiento: r.storage_driver,
      // R2 cifra todo objeto en reposo con AES-256 (claves gestionadas por Cloudflare); el disco local de desarrollo no.
      cifradoEnReposo: r.storage_driver === 'r2',
    } : null,
    puedeVerificar: r.tiene_archivo && ROLES_INTEGRIDAD.includes(req.user.rol),
    ultimaVerificacion: verif.rows[0] ? { resultado: verif.rows[0].detalle.resultado, fecha: fechaHoraCO(verif.rows[0].creado_en) } : null,
    // Texto para la búsqueda: con archivo, su estado de extracción; sin archivo, el texto es de demostración.
    indexacion,
    textoOrigen: r.tiene_archivo ? 'pdf' : 'demo',
    puedeReindexar: r.tiene_archivo && ROLES_REINDEXAR.includes(req.user.rol),
    retencion: r.retencion_anios ? `${r.retencion_anios} Años${r.vence_retencion ? ` (Vence ${new Date(r.vence_retencion).getUTCFullYear()})` : ''}` : null,
    cifrado: r.tiene_archivo && r.storage_driver === 'r2', ocr: r.ocr_procesado, firmadoPor: r.firmado_por, firmaValida: r.firma_valida,
  });
});

/**
 * Envía el PDF real. modo "inline" (visor) o "attachment" (descarga). Soporta Range (206/416).
 * Cada acceso se audita: ver_archivo o descargar.
 */
const servirArchivo = (modo) => async (req, res) => {
  const d = await documentoConArchivo(req);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
  if (!d.tiene_archivo) return res.status(404).json({ error: SIN_ARCHIVO, codigo: 'sin_archivo' });

  const st = almacenamiento();
  // Subido con otro driver (p. ej. en local y ahora se usa R2): el objeto no está aquí.
  if (d.storage_driver !== st.driver) return res.status(404).json({ error: NO_DISPONIBLE, codigo: 'no_disponible' });

  const tamanoEsperado = Number(d.tamano_bytes);
  const rango = interpretarRango(req.headers.range, tamanoEsperado);
  const no416 = () => res.status(416).set('Content-Range', `bytes */${tamanoEsperado}`).json({ error: 'Rango solicitado no válido' });
  if (rango === 'no-satisfacible') return no416();

  let r;
  try {
    r = await st.leer(d.storage_path, rango);
  } catch (e) {
    if (e instanceof ErrorObjetoNoEncontrado) return res.status(404).json({ error: NO_DISPONIBLE, codigo: 'no_disponible' });
    if (e instanceof ErrorRangoInvalido) return no416();
    throw e;
  }

  await registrarAuditoria(req, modo === 'attachment' ? 'descargar' : 'ver_archivo', d.id,
    r.parcial ? { rango: `${r.inicio}-${r.fin}`, tamano: r.tamano } : { tamano: r.tamano });

  res.status(r.parcial ? 206 : 200).set({
    'Content-Type': 'application/pdf',
    'Content-Length': String(r.longitud),
    'Content-Disposition': contentDisposition(modo, d.nombre_original),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store', // nunca en cachés compartidas ni en el disco del navegador
    'X-Content-Type-Options': 'nosniff', // el navegador no "adivina" otro tipo
  });
  if (r.parcial) res.set('Content-Range', `bytes ${r.inicio}-${r.fin}/${r.tamano}`);
  if (req.method === 'HEAD') {
    r.stream.destroy?.();
    return res.end();
  }
  try {
    await pipeline(r.stream, res);
  } catch (e) {
    // Cliente que cierra a mitad (cambia de página, cancela): no es un error del servidor.
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Error enviando archivo:', e.message);
    res.destroy();
  }
};

router.get('/:id/archivo', servirArchivo('inline'));
router.get('/:id/descarga', servirArchivo('attachment'));

/**
 * Verificación de integridad (solo Super Administrador y Oficial de Cumplimiento): relee el objeto completo,
 * recalcula su SHA-256 y lo compara con el registrado al subirlo. El resultado queda en la auditoría.
 */
router.post('/:id/verificar-integridad', requireRole(...ROLES_INTEGRIDAD), async (req, res) => {
  const d = await documentoConArchivo(req);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
  if (!d.tiene_archivo) return res.status(409).json({ error: `${SIN_ARCHIVO} No hay nada que verificar.`, codigo: 'sin_archivo' });

  const st = almacenamiento();
  let calculado;
  try {
    if (d.storage_driver !== st.driver) throw new ErrorObjetoNoEncontrado(d.storage_path);
    calculado = await sha256DeStream((await st.leer(d.storage_path)).stream);
  } catch (e) {
    if (!(e instanceof ErrorObjetoNoEncontrado)) throw e;
    await registrarAuditoria(req, 'verificar_integridad', d.id, { resultado: 'no_disponible' });
    return res.status(404).json({ error: NO_DISPONIBLE, codigo: 'no_disponible' });
  }

  const esperado = d.hash_sha256.trim();
  const integro = calculado.sha256 === esperado && calculado.bytes === Number(d.tamano_bytes);
  await registrarAuditoria(req, 'verificar_integridad', d.id, {
    resultado: integro ? 'integro' : 'alterado', sha256Calculado: calculado.sha256, bytesCalculados: calculado.bytes,
  });
  res.json({
    integro, hashEsperado: esperado, hashCalculado: calculado.sha256,
    tamanoEsperado: Number(d.tamano_bytes), tamanoCalculado: calculado.bytes, verificadoEn: fechaHoraCO(new Date()),
  });
});

/** Estado de indexación (fila presentada) o null si el documento nunca entró en la cola. */
async function leerIndexacion(id) {
  const { rows: [f] } = await query(`SELECT ${COLUMNAS_INDEXACION} FROM documento_indexacion WHERE documento_id = $1`, [id]);
  // Pendiente = hay trabajo: se despierta el indexador (por si el servicio se reinició). Sin sondeo periódico.
  if (f?.estado === 'pendiente') despertarIndexador();
  return presentarIndexacion(f ?? null);
}

/**
 * Estado de la extracción de texto (el detalle lo consulta cada pocos segundos mientras está pendiente).
 * Ligero y SIN auditoría ni notificación, a diferencia de GET /:id.
 */
router.get('/:id/indexacion', async (req, res) => {
  const d = await documentoConArchivo(req);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
  if (!d.tiene_archivo) return res.status(404).json({ error: SIN_ARCHIVO, codigo: 'sin_archivo' });
  res.json(await leerIndexacion(d.id));
});

/** Volver a extraer el texto del PDF (tras un error, un "sin texto" dudoso o una mejora del extractor). Auditado. */
router.post('/:id/reindexar', requireRole(...ROLES_REINDEXAR), async (req, res) => {
  const d = await documentoConArchivo(req);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
  if (!d.tiene_archivo) return res.status(409).json({ error: `${SIN_ARCHIVO} No hay texto que extraer.`, codigo: 'sin_archivo' });

  const { rows: [antes] } = await query(`SELECT estado FROM documento_indexacion WHERE documento_id = $1`, [d.id]);
  if (antes?.estado === 'procesando')
    return res.status(409).json({ error: 'El texto de este documento ya se está extrayendo. Espera a que termine.', codigo: 'en_proceso' });
  // Ya en cola: no se duplica ni se audita otra vez (doble clic). Idempotente.
  if (antes?.estado !== 'pendiente') {
    await solicitarIndexacion({ query }, d.id, { motivo: 'reproceso', usuarioId: req.user.id });
    await registrarAuditoria(req, 'reindexar_texto', d.id, { estadoAnterior: antes?.estado ?? null });
  }
  despertarIndexador();
  res.status(202).json(await leerIndexacion(d.id));
});

/** Texto OCR de una página (capa de texto del visor). */
router.get('/:id/paginas/:n', async (req, res) => {
  if (!idValido(req.params.id) || !idValido(req.params.n)) return res.status(404).json({ error: 'No encontrado' });
  const { rows: [p] } = await query(
    `SELECT p.pagina, p.seccion, p.texto, p.confianza, p.origen, d.paginas AS total
       FROM documento_paginas p
       JOIN documentos d ON d.id = p.documento_id
       LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
      WHERE p.documento_id = $2 AND p.pagina = $3 AND d.estado = 'activo' AND ${ACCESO}`,
    [req.user.rango, req.params.id, req.params.n]);
  if (!p) return res.status(404).json({ error: 'Página sin texto OCR' });
  res.json({ pagina: p.pagina, totalPaginas: p.total, seccion: p.seccion, texto: p.texto, origen: p.origen, confianza: p.confianza && Number(p.confianza) });
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
  res.json(rows.map((a) => ({
    id: `AUD-${a.id}`, accion: a.accion, usuario: a.usuario ?? 'Sistema', ip: a.ip,
    cuando: haceCuanto(a.creado_en, true), fecha: fechaHoraCO(a.creado_en),
  })));
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
