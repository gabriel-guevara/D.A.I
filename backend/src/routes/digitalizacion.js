import { Router } from 'express';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { formatBytes, hashCorto, idValido } from '../lib/format.js';
import { almacenamiento, generarClaveObjeto } from '../lib/storage.js';
import { ErrorPdf, inspeccionarPdf } from '../lib/pdf.js';
import { ErrorSubida, recibirPdf, tomarCupoDeSubida } from '../lib/subida.js';
import { sanearNombreArchivo } from '../lib/archivo-http.js';

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

const CAMPOS_SUBIDA = ['titulo', 'folio', 'departamento', 'tipoDocumental', 'clasificacion'];
const FOLIO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._\/-]{2,59}$/;
const textoLimpio = (v, max) =>
  typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Valida los metadatos contra los catálogos. Devuelve { error, status } o los ids resueltos. */
async function validarMetadatos(campos, usuario) {
  const buscar = async (tabla, valor, extra = '') =>
    (await query(`SELECT id${extra} FROM ${tabla} WHERE nombre = $1`, [valor])).rows[0] ?? null;

  const clasificacion = textoLimpio(campos.clasificacion, 100);
  if (!clasificacion) return { status: 400, error: 'La clasificación es obligatoria: define quién podrá ver el documento.' };
  const c = await buscar('clasificaciones', clasificacion, ', nivel_minimo');
  if (!c) return { status: 400, error: 'La clasificación indicada no existe.' };
  // Nadie puede clasificar por encima de su propio nivel: perdería el acceso a lo que acaba de subir.
  if (c.nivel_minimo > usuario.rango)
    return { status: 403, error: 'No puedes clasificar un documento por encima de tu nivel de acceso.' };

  let departamentoId = null;
  const departamento = textoLimpio(campos.departamento, 100);
  if (departamento) {
    departamentoId = (await buscar('departamentos', departamento))?.id;
    if (!departamentoId) return { status: 400, error: 'El departamento indicado no existe.' };
  }
  let tipoId = null;
  const tipo = textoLimpio(campos.tipoDocumental, 100);
  if (tipo) {
    tipoId = (await buscar('tipos_documentales', tipo))?.id;
    if (!tipoId) return { status: 400, error: 'El tipo documental indicado no existe.' };
  }
  const folio = textoLimpio(campos.folio, 60);
  if (folio && !FOLIO_VALIDO.test(folio))
    return { status: 400, error: 'Folio no válido: de 3 a 60 caracteres, solo letras, números y . _ / -' };
  if (folio && (await query(`SELECT 1 FROM documentos WHERE folio = $1`, [folio])).rowCount)
    return { status: 409, error: 'Ya existe un documento con ese folio.' };

  return { clasificacionId: c.id, departamentoId, tipoId, folio: folio || null, titulo: textoLimpio(campos.titulo, 200) || null };
}

/**
 * "Aprobar e Indexar en DAI": sube un PDF real y crea el documento (multipart: campo "archivo" + metadatos).
 *
 * Orden pensado para no dejar huérfanos:
 *  1. Todo se valida ANTES de tocar el almacenamiento o la base (tamaño, firma, apertura, contraseña, metadatos).
 *  2. Se reservan los ids (nextval) para construir la clave docs/{doc}/{ver}/{uuid}.pdf.
 *  3. Se sube el objeto. Si falla, no se ha creado ninguna fila.
 *  4. Se insertan documento + versión en UNA transacción. Si falla, se borra el objeto recién subido.
 * Reservar ids en lugar de abrir la transacción antes evita tener una conexión de la base ocupada
 * mientras el archivo viaja a R2 (que puede tardar segundos).
 */
router.post('/documentos', async (req, res) => {
  const liberar = tomarCupoDeSubida();
  if (!liberar)
    return res.status(503).set('Retry-After', '10').json({ error: 'Hay otras subidas en curso. Intenta de nuevo en unos segundos.' });
  try {
    let recibido;
    try {
      recibido = await recibirPdf(req, { maxBytes: config.maxUploadBytes, camposPermitidos: CAMPOS_SUBIDA });
    } catch (e) {
      if (e instanceof ErrorSubida) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const { campos, archivo } = recibido;

    const meta = await validarMetadatos(campos, req.user);
    if (meta.error) return res.status(meta.status).json({ error: meta.error });

    let paginas;
    try {
      ({ paginas } = await inspeccionarPdf(archivo.buffer));
    } catch (e) {
      if (e instanceof ErrorPdf) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
      throw e;
    }

    const nombreOriginal = sanearNombreArchivo(archivo.nombre);
    const { rows: [ids] } = await query(
      `SELECT nextval(pg_get_serial_sequence('documentos', 'id'))::text AS doc,
              nextval(pg_get_serial_sequence('documento_versiones', 'id'))::text AS ver`);
    const clave = generarClaveObjeto(ids.doc, ids.ver);
    const st = almacenamiento();

    try {
      await st.guardar(clave, archivo.buffer, { tamano: archivo.tamano, tipo: 'application/pdf' });
    } catch (e) {
      console.error('No se pudo guardar el archivo en el almacenamiento:', e.message);
      return res.status(502).json({ error: 'No se pudo guardar el archivo en el almacenamiento. No se creó el documento; intenta de nuevo.' });
    }

    const folio = meta.folio ?? `EXP-${new Date().getFullYear()}-DIG-${ids.doc}`;
    try {
      await withTransaction(async (c) => {
        const { rows: [u] } = await c.query(`SELECT nombre, email FROM usuarios WHERE id = $1`, [req.user.id]);
        await c.query(
          `INSERT INTO documentos (id, nombre, folio, formato, version_actual, departamento_id, tipo_id, clasificacion_id,
                                   autor_id, autor_nombre, autor_email, origen, tamano_bytes, paginas, hash_sha256,
                                   cifrado_aes, storage_path, storage_driver, tiene_archivo, nombre_original)
           VALUES ($1,$2,$3,'pdf','v1.0',$4,$5,$6,$7,$8,$9,'Carga digital (PDF)',$10,$11,$12,$13,$14,$15,true,$16)`,
          [ids.doc, meta.titulo ?? nombreOriginal, folio, meta.departamentoId, meta.tipoId, meta.clasificacionId,
           req.user.id, u.nombre, u.email, archivo.tamano, paginas, archivo.sha256,
           st.driver === 'r2', clave, st.driver, nombreOriginal]);
        await c.query(
          `INSERT INTO documento_versiones (id, documento_id, version, hash_sha256, tamano_bytes, storage_path, storage_driver, autor_id, comentario)
           VALUES ($1,$2,'v1.0',$3,$4,$5,$6,$7,'Carga inicial')`,
          [ids.ver, ids.doc, archivo.sha256, archivo.tamano, clave, st.driver, req.user.id]);
      });
    } catch (e) {
      // La base falló DESPUÉS de subir: se borra el objeto para no dejar un archivo sin documento.
      await st.borrar(clave).catch((err) => console.error(`Objeto huérfano sin borrar (${clave}):`, err.message));
      if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un documento con ese folio.' });
      throw e;
    }

    await registrarAuditoria(req, 'subir_documento', Number(ids.doc), {
      nombreOriginal, tamano: archivo.tamano, paginas, sha256: archivo.sha256, almacenamiento: st.driver,
    });
    res.status(201).json({
      id: ids.doc, folio, nombre: meta.titulo ?? nombreOriginal, nombreOriginal,
      hash: archivo.sha256, hashCorto: hashCorto(archivo.sha256),
      tamanoBytes: archivo.tamano, tamano: formatBytes(archivo.tamano), paginas,
    });
  } finally {
    liberar();
  }
});

/**
 * Aprobación HEREDADA de un trabajo OCR sin archivo (solo metadatos). Se mantiene por compatibilidad;
 * ya no inventa una ruta de almacenamiento con el nombre que mandó el usuario: el documento queda sin archivo.
 * La forma de indexar un PDF real es POST /api/digitalizacion/documentos.
 */
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
                                 origen, tamano_bytes, ocr_procesado, cifrado_aes, storage_path, tiene_archivo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Digitalización OCR',$10,true,false,NULL,false) RETURNING id`,
        [j.nombre_archivo, folio, formato, await id('departamentos', b.departamento), await id('tipos_documentales', b.tipoDocumental),
         clasificacionId, req.user.id, u.nombre, u.email, j.tamano_bytes]);

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
