/**
 * Versiones de un documento (montado en /api/documentos/:id/versiones).
 *
 *  GET    /                    historial (cualquiera que pueda ver el documento)
 *  POST   /                    subir una versión nueva (multipart: "archivo" + "comentario")
 *  GET    /:vid/archivo        ver una versión concreta (inline)        ┐ auditado, con la versión
 *  GET    /:vid/descarga       descargar una versión concreta           ┘ en el detalle
 *  POST   /:vid/restaurar      volver a una versión anterior como actual
 *
 * Modelo: cada versión es una fila de documento_versiones con SU objeto (docs/{doc}/{ver}/{uuid}.pdf); los
 * objetos de versiones anteriores NUNCA se sobrescriben ni se borran mientras el documento exista. La fila de
 * documentos guarda una copia de los datos de la versión ACTUAL (clave, huella, tamaño, páginas, nombre): así
 * el visor, la descarga, la integridad y el indexador siguen funcionando igual que en las fases 1 y 2.
 * Restaurar = esa copia vuelve a apuntar a una versión anterior (sin copiar archivos: no gasta almacenamiento).
 *
 * Texto y búsqueda: el índice refleja SOLO la versión actual. Al subir o restaurar, en la MISMA transacción se
 * borra el texto anterior y el documento vuelve a la cola del indexador; hasta que termine, la búsqueda no lo
 * encuentra por contenido (mejor eso que encontrarlo por un texto que ya no tiene).
 *
 * Permisos: subir y restaurar = quienes ingresan documentos (Super Administrador y Operador OCR), siempre que
 * alcancen el nivel del documento. Ver y descargar versiones = cualquiera que pueda ver el documento.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { notificarGestores } from '../lib/notify.js';
import { fechaHoraCO, formatBytes, hashCorto, idValido, textoLimpio } from '../lib/format.js';
import { almacenamiento, generarClaveObjeto } from '../lib/storage.js';
import { ErrorPdf, inspeccionarPdf } from '../lib/pdf.js';
import { ErrorSubida, recibirPdf, tomarCupoDeSubida } from '../lib/subida.js';
import { sanearNombreArchivo } from '../lib/archivo-http.js';
import { despertarIndexador, solicitarIndexacion } from '../lib/indexador.js';
import { confirmarSubida, descartarSubida, registrarIntencionSubida } from '../lib/papelera.js';
import { enviarPdf, NO_DISPONIBLE } from '../lib/enviar-archivo.js';
import { nombreConVersion, siguienteVersion } from '../lib/versiones.js';

const router = Router({ mergeParams: true });

export const ROLES_VERSIONES = ['super-admin', 'ocr-operator'];
export const MIN_COMENTARIO = 3;
export const MAX_COMENTARIO = 300;

/** Documento ACTIVO que el usuario alcanza por nivel. Con bloquear (dentro de una transacción) lo bloquea. */
async function documentoVisible(req, db = { query }, bloquear = false) {
  if (!idValido(req.params.id)) return null;
  const { rows: [d] } = await db.query(
    `SELECT d.id, d.nombre, d.folio, d.formato, d.version_actual, d.hash_sha256, d.tiene_archivo, d.nombre_original
       FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
      WHERE d.id = $1 AND d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $2)${bloquear ? ' FOR UPDATE OF d' : ''}`,
    [req.params.id, req.user.rango]);
  return d ?? null;
}

async function versionDe(documentoId, vid, db = { query }, bloquear = false) {
  if (!idValido(vid)) return null;
  const { rows: [v] } = await db.query(
    `SELECT id, version, hash_sha256, tamano_bytes, paginas, nombre_original, storage_path, storage_driver
       FROM documento_versiones WHERE id = $1 AND documento_id = $2${bloquear ? ' FOR UPDATE' : ''}`, [vid, documentoId]);
  return v ?? null;
}

const NO_ENCONTRADO = { error: 'Documento no encontrado' };
const VERSION_NO_ENCONTRADA = { error: 'Versión no encontrada' };

/** Copia los datos de una versión a la fila del documento (pasa a ser la actual). */
const SQL_HACER_ACTUAL = `
  UPDATE documentos SET version_actual = $2, storage_path = $3, storage_driver = $4, hash_sha256 = $5,
         tamano_bytes = $6, paginas = $7, nombre_original = $8, tiene_archivo = true, cifrado_aes = ($4 = 'r2'), formato = 'pdf'
   WHERE id = $1`;

// ---------------------------------------------------------------------------------------------- historial

router.get('/', async (req, res) => {
  const d = await documentoVisible(req);
  if (!d) return res.status(404).json(NO_ENCONTRADO);
  const { rows } = await query(
    `SELECT v.id, v.version, v.hash_sha256, v.tamano_bytes, v.paginas, v.nombre_original, v.comentario, v.creado_en,
            v.storage_path IS NOT NULL AS tiene_archivo, u.nombre AS autor
       FROM documento_versiones v LEFT JOIN usuarios u ON u.id = v.autor_id
      WHERE v.documento_id = $1
      ORDER BY v.creado_en DESC, v.id DESC`, [d.id]);
  res.json({
    versionActual: d.version_actual,
    puedeGestionar: d.formato === 'pdf' && ROLES_VERSIONES.includes(req.user.rol),
    versiones: rows.map((v) => {
      // Solo se muestra la huella de versiones con archivo real; la de los datos heredados no corresponde a ningún archivo.
      const hash = v.tiene_archivo ? v.hash_sha256?.trim() ?? null : null;
      return {
        id: String(v.id), version: v.version, actual: v.version === d.version_actual,
        hash, hashCorto: hashCorto(hash), tamanoBytes: Number(v.tamano_bytes ?? 0), tamano: formatBytes(v.tamano_bytes),
        paginas: v.paginas, nombreOriginal: v.nombre_original, comentario: v.comentario,
        autor: v.autor ?? 'Sistema', fecha: fechaHoraCO(v.creado_en), tieneArchivo: v.tiene_archivo,
      };
    }),
  });
});

// ---------------------------------------------------------------------------------------------- subir

/**
 * Nueva versión. Mismo orden anti-huérfanos que la subida inicial (routes/digitalizacion.js):
 *  1. Se valida TODO antes de tocar el almacenamiento (documento, PDF, comentario, que no sea idéntico).
 *  2. Se apunta la clave en la cola de borrado ("subida_en_curso") y se sube el objeto.
 *  3. UNA transacción: bloquea el documento, numera, inserta la versión, la hace actual, borra el texto viejo,
 *     pide la indexación y tacha la clave de la cola. Si algo falla, se descarta el objeto.
 */
router.post('/', requireRole(...ROLES_VERSIONES), async (req, res) => {
  const previo = await documentoVisible(req);
  if (!previo) return res.status(404).json(NO_ENCONTRADO);
  if (previo.formato !== 'pdf') return res.status(409).json({ error: 'Solo los documentos PDF admiten versiones nuevas.', codigo: 'formato' });

  const liberar = tomarCupoDeSubida();
  if (!liberar)
    return res.status(503).set('Retry-After', '10').json({ error: 'Hay otras subidas en curso. Intenta de nuevo en unos segundos.' });
  try {
    let recibido;
    try {
      recibido = await recibirPdf(req, { maxBytes: config.maxUploadBytes, camposPermitidos: ['comentario'], maxLongitudCampo: MAX_COMENTARIO * 4 });
    } catch (e) {
      if (e instanceof ErrorSubida) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const { campos, archivo } = recibido;
    const comentario = textoLimpio(campos.comentario, MAX_COMENTARIO);
    if (comentario.length < MIN_COMENTARIO)
      return res.status(400).json({ error: `Escribe un comentario (mínimo ${MIN_COMENTARIO} caracteres) que explique qué cambia en esta versión.` });

    let paginas;
    try {
      ({ paginas } = await inspeccionarPdf(archivo.buffer));
    } catch (e) {
      if (e instanceof ErrorPdf) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
      throw e;
    }
    const identico = (d) => d.tiene_archivo && d.hash_sha256?.trim() === archivo.sha256;
    const SIN_CAMBIOS = { status: 409, error: 'El archivo es idéntico a la versión actual (mismo SHA-256). No se creó una versión nueva.', codigo: 'sin_cambios' };
    if (identico(previo)) return res.status(409).json({ error: SIN_CAMBIOS.error, codigo: SIN_CAMBIOS.codigo });

    const nombreOriginal = sanearNombreArchivo(archivo.nombre);
    const { rows: [ids] } = await query(`SELECT nextval(pg_get_serial_sequence('documento_versiones', 'id'))::text AS ver`);
    const clave = generarClaveObjeto(previo.id, ids.ver);
    const st = almacenamiento();
    const intento = await registrarIntencionSubida(clave, st.driver, previo.id);
    try {
      await st.guardar(clave, archivo.buffer, { tamano: archivo.tamano, tipo: 'application/pdf' });
    } catch (e) {
      console.error('No se pudo guardar la versión en el almacenamiento:', e.message);
      await descartarSubida(st, clave, intento);
      return res.status(502).json({ error: 'No se pudo guardar el archivo en el almacenamiento. No se creó la versión; intenta de nuevo.' });
    }

    let r;
    try {
      r = await withTransaction(async (c) => {
        // Se vuelve a leer BLOQUEADO: pudo ir a la papelera o recibir otra versión mientras el archivo subía.
        const d = await documentoVisible(req, c, true);
        if (!d) return { status: 404, ...NO_ENCONTRADO };
        if (identico(d)) return SIN_CAMBIOS;
        const { rows } = await c.query(`SELECT version FROM documento_versiones WHERE documento_id = $1`, [d.id]);
        const version = siguienteVersion([d.version_actual, ...rows.map((x) => x.version)]);
        await c.query(
          `INSERT INTO documento_versiones (id, documento_id, version, hash_sha256, tamano_bytes, storage_path, storage_driver,
                                            nombre_original, paginas, autor_id, comentario)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [ids.ver, d.id, version, archivo.sha256, archivo.tamano, clave, st.driver, nombreOriginal, paginas, req.user.id, comentario]);
        await c.query(SQL_HACER_ACTUAL, [d.id, version, clave, st.driver, archivo.sha256, archivo.tamano, paginas, nombreOriginal]);
        await c.query(`DELETE FROM documento_paginas WHERE documento_id = $1`, [d.id]);
        await solicitarIndexacion(c, d.id, { motivo: 'version', usuarioId: req.user.id });
        await confirmarSubida(c, intento);
        return { status: 201, version, anterior: d.version_actual, documento: d };
      });
    } catch (e) {
      await descartarSubida(st, clave, intento);
      if (e.code === '23505') return res.status(409).json({ error: 'Se creó otra versión al mismo tiempo. Recarga e inténtalo de nuevo.' });
      throw e;
    }
    if (r.status !== 201) {
      await descartarSubida(st, clave, intento);
      return res.status(r.status).json({ error: r.error, ...(r.codigo ? { codigo: r.codigo } : {}) });
    }

    await registrarAuditoria(req, 'subir_version', Number(r.documento.id), {
      version: r.version, anterior: r.anterior, sha256: archivo.sha256, tamano: archivo.tamano, paginas,
      nombreOriginal, comentario, almacenamiento: st.driver,
    });
    await notificarGestores({
      categoria: 'version', documentoId: r.documento.id,
      titulo: `Nueva versión ${r.version} de ${r.documento.nombre}`,
      descripcion: comentario,
      meta: [`Folio: ${r.documento.folio}`, `Anterior: ${r.anterior}`, `SHA-256: ${hashCorto(archivo.sha256)}`, `Tamaño: ${formatBytes(archivo.tamano)}`],
    });
    res.status(201).json({
      id: ids.ver, version: r.version, anterior: r.anterior, hash: archivo.sha256, hashCorto: hashCorto(archivo.sha256),
      tamanoBytes: archivo.tamano, tamano: formatBytes(archivo.tamano), paginas, nombreOriginal, comentario, indexacion: 'pendiente',
    });
  } finally {
    liberar();
  }
  despertarIndexador(); // el texto de la versión nueva se extrae después de responder
});

// ---------------------------------------------------------------------------------------------- ver / descargar

const servirVersion = (modo) => async (req, res) => {
  const d = await documentoVisible(req);
  if (!d) return res.status(404).json(NO_ENCONTRADO);
  const v = await versionDe(d.id, req.params.vid);
  if (!v) return res.status(404).json(VERSION_NO_ENCONTRADA);
  if (!v.storage_path)
    return res.status(404).json({ error: 'Esta versión no tiene archivo original (registro histórico sin PDF).', codigo: 'sin_archivo' });
  const base = v.nombre_original ?? d.nombre_original ?? d.nombre;
  await enviarPdf(req, res, {
    documentoId: d.id, clave: v.storage_path, driver: v.storage_driver, tamano: Number(v.tamano_bytes), modo,
    // La actual con su nombre; una anterior con la versión en el nombre, para no confundirlas al guardarlas.
    nombre: v.version === d.version_actual ? base : nombreConVersion(base, v.version),
    detalle: { version: v.version },
  });
};

router.get('/:vid/archivo', servirVersion('inline'));
router.get('/:vid/descarga', servirVersion('attachment'));

// ---------------------------------------------------------------------------------------------- restaurar

/**
 * Restaura una versión anterior como actual. Antes de tocar la base se comprueba que su objeto EXISTE y tiene el
 * tamaño registrado: nunca se deja el documento apuntando a un archivo inexistente. (La huella completa la
 * comprueba el indexador al leerlo, y "Verificar integridad" a petición.)
 */
router.post('/:vid/restaurar', requireRole(...ROLES_VERSIONES), async (req, res) => {
  const previo = await documentoVisible(req);
  if (!previo) return res.status(404).json(NO_ENCONTRADO);
  const v = await versionDe(previo.id, req.params.vid);
  if (!v) return res.status(404).json(VERSION_NO_ENCONTRADA);
  if (v.version === previo.version_actual) return res.status(409).json({ error: 'Esta versión ya es la actual.', codigo: 'ya_actual' });
  if (!v.storage_path)
    return res.status(409).json({ error: 'Esta versión no tiene archivo original; no se puede restaurar.', codigo: 'sin_archivo' });

  const st = almacenamiento();
  const info = v.storage_driver === st.driver ? await st.info(v.storage_path) : null;
  if (!info || info.tamano !== Number(v.tamano_bytes))
    return res.status(409).json({
      error: `${NO_DISPONIBLE}: el archivo de esta versión falta o no coincide con su tamaño registrado. No se restauró.`, codigo: 'no_disponible',
    });

  const r = await withTransaction(async (c) => {
    const d = await documentoVisible(req, c, true);
    if (!d) return { status: 404, ...NO_ENCONTRADO };
    const vv = await versionDe(d.id, v.id, c, true);
    if (!vv?.storage_path) return { status: 409, error: 'Esta versión ya no tiene archivo; no se restauró.', codigo: 'sin_archivo' };
    if (vv.version === d.version_actual) return { status: 409, error: 'Esta versión ya es la actual.', codigo: 'ya_actual' };
    await c.query(SQL_HACER_ACTUAL, [d.id, vv.version, vv.storage_path, vv.storage_driver, vv.hash_sha256.trim(), vv.tamano_bytes,
      vv.paginas ?? 1, vv.nombre_original ?? d.nombre_original ?? 'documento.pdf']);
    await c.query(`DELETE FROM documento_paginas WHERE documento_id = $1`, [d.id]);
    await solicitarIndexacion(c, d.id, { motivo: 'restaurar_version', usuarioId: req.user.id });
    return { status: 200, version: vv.version, anterior: d.version_actual, sha256: vv.hash_sha256.trim(), documento: d };
  });
  if (r.status !== 200) return res.status(r.status).json({ error: r.error, ...(r.codigo ? { codigo: r.codigo } : {}) });

  await registrarAuditoria(req, 'restaurar_version', Number(r.documento.id), { version: r.version, anterior: r.anterior, sha256: r.sha256 });
  await notificarGestores({
    categoria: 'version', documentoId: r.documento.id,
    titulo: `Versión ${r.version} restaurada como actual en ${r.documento.nombre}`,
    descripcion: `La versión ${r.anterior} se conserva en el historial; el texto para la búsqueda se vuelve a extraer.`,
    meta: [`Folio: ${r.documento.folio}`, `SHA-256: ${hashCorto(r.sha256)}`],
  });
  despertarIndexador();
  res.json({ ok: true, version: r.version, anterior: r.anterior, indexacion: 'pendiente' });
});

export default router;
