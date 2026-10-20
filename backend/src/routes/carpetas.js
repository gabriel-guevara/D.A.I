/**
 * Carpetas y subcarpetas (Fases 5 y 6): hasta 5 niveles y SOLO para organizar. NO cambian permisos: quién ve un
 * documento lo sigue decidiendo su clasificación frente al nivel del usuario, esté en la carpeta que esté.
 *
 *  - Crear (también dentro de otra), renombrar y mover documentos o carpetas: Super Administrador y Operador OCR.
 *  - Eliminar (solo si está vacía: sin subcarpetas, documentos ni solicitudes pendientes): Super Administrador.
 *  - El Oficial de Cumplimiento NO mueve: envía una solicitud con motivo, que aprueba o rechaza un Super
 *    Administrador u Operador OCR que alcance el nivel del documento. Quien solicita nunca resuelve.
 * Todo queda auditado y notificado (los avisos de carpetas nunca llevan nombres de documentos).
 */
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { registrarAuditoria } from '../lib/audit.js';
import { notificarUsuarios } from '../lib/notify.js';
import { fechaHoraCO, idValido, textoLimpio } from '../lib/format.js';
import { CANDADO_ARBOL, MAX_NIVEL, alturaSubarbol, rutaDe, nombresRuta, rutasDe, textoRuta } from '../lib/carpetas-arbol.js';

const router = Router();

export const ROLES_CARPETAS = ['super-admin', 'ocr-operator'];   // crear, renombrar, mover y resolver solicitudes
export const ROLES_ELIMINAR_CARPETA = ['super-admin'];
export const ROLES_SOLICITAR = ['compliance'];
// Quienes reciben los avisos de carpetas (los mismos que gestionan o supervisan la organización).
const ROLES_AVISO = ['super-admin', 'compliance', 'ocr-operator'];
const MAX_MOVER = 100;

// $1 = rango del usuario. Mismo criterio de acceso que la biblioteca: activo y de su nivel o inferior.
const VISIBLE = `d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)`;
const NO_ENCONTRADA = 'Carpeta no encontrada.';
const DUPLICADA = 'Ya existe una carpeta con ese nombre en esa ubicación (no se distinguen mayúsculas).';
const PROFUNDIDAD = `Las carpetas admiten como máximo ${MAX_NIVEL} niveles.`;
/** «Legal › 2024» de una carpeta de destino (con su ruta) o «Inicio» (null = sin carpeta). */
const nombreDestino = (carpeta) => textoRuta(carpeta?.ruta);

/** Nombre de carpeta: una línea, 2 a 80 caracteres, y no puede llamarse como la raíz ("Inicio") ni "Sin carpeta". */
function validarNombre(v) {
  const nombre = textoLimpio(v, 81);
  if (nombre.length < 2 || nombre.length > 80) return { error: 'El nombre de la carpeta debe tener entre 2 y 80 caracteres.' };
  if (['sin carpeta', 'inicio'].includes(nombre.toLowerCase())) return { error: 'Ese nombre está reservado. Elija otro.' };
  return { nombre };
}

/** carpetaId del cuerpo: null (a la raíz, "Inicio") o un id. */
function leerCarpetaId(v) {
  if (v === null) return { id: null };
  if ((typeof v === 'string' || typeof v === 'number') && idValido(v)) return { id: String(v) };
  return { error: 'Indique la carpeta de destino (carpetaId) o null para dejar el documento en Inicio (sin carpeta).' };
}

/** padreId del cuerpo: undefined o null = la raíz; o un id. */
function leerPadreId(v) {
  if (v === undefined || v === null) return { id: null };
  if ((typeof v === 'string' || typeof v === 'number') && idValido(v)) return { id: String(v) };
  return { error: 'Carpeta de destino no válida (padreId debe ser el id de una carpeta o null para Inicio).' };
}

/** Bloquea la estructura del árbol hasta el fin de la transacción: crear, mover o eliminar, de uno en uno. */
const bloquearArbol = (c) => c.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_ARBOL]);

/** Carpeta existente (bloqueada FOR SHARE: nadie la elimina mientras se usa como destino) con su ruta, o null. */
async function carpetaDestino(c, id) {
  const { rows: [ca] } = await c.query(`SELECT id, nombre FROM carpetas WHERE id = $1 FOR SHARE`, [id]);
  return ca ? { id: String(ca.id), nombre: ca.nombre, ruta: await rutaDe(c, ca.id) } : null;
}

// --------------------------------------------------------------------------------------------- explorar

/**
 * Explorador: el contenido de UNA carpeta (?padre=<id>, o la raíz sin padre / ?padre=raiz): su ruta (migas de pan),
 * sus subcarpetas directas con cuántos documentos VISIBLES para el usuario tiene cada una y cuántas subcarpetas,
 * cuántos documentos visibles hay directamente aquí y qué puede hacer el usuario.
 */
router.get('/', async (req, res) => {
  const p = typeof req.query.padre === 'string' ? req.query.padre : req.query.padre === undefined ? '' : null;
  if (p === null || (p !== '' && p !== 'raiz' && !idValido(p))) return res.status(400).json({ error: 'Carpeta no válida.' });
  const padre = p === '' || p === 'raiz' ? null : p;

  let carpeta = null;
  if (padre) {
    const ruta = await rutaDe({ query }, padre);
    if (!ruta.length) return res.status(404).json({ error: NO_ENCONTRADA });
    carpeta = { id: padre, nombre: ruta.at(-1).nombre, nivel: ruta.length, ruta };
  }
  const [hijas, aqui] = await Promise.all([
    query(
      `SELECT ca.id, ca.nombre,
              (SELECT count(*) FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
                WHERE d.carpeta_id = ca.id AND ${VISIBLE})::int AS documentos,
              (SELECT count(*) FROM carpetas h WHERE h.padre_id = ca.id)::int AS subcarpetas
         FROM carpetas ca WHERE ca.padre_id IS NOT DISTINCT FROM $2::bigint
        ORDER BY lower(ca.nombre), ca.id`, [req.user.rango, padre]),
    query(
      `SELECT count(*)::int AS n FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
        WHERE d.carpeta_id IS NOT DISTINCT FROM $2::bigint AND ${VISIBLE}`, [req.user.rango, padre]),
  ]);
  const rol = req.user.rol;
  res.json({
    carpeta,
    carpetas: hijas.rows.map((r) => ({ id: String(r.id), nombre: r.nombre, documentos: r.documentos, subcarpetas: r.subcarpetas })),
    documentosAqui: aqui.rows[0].n,
    maxNivel: MAX_NIVEL,
    permisos: {
      gestionar: ROLES_CARPETAS.includes(rol),          // crear, renombrar y mover
      eliminar: ROLES_ELIMINAR_CARPETA.includes(rol),
      solicitar: ROLES_SOLICITAR.includes(rol),
      resolver: ROLES_CARPETAS.includes(rol),
    },
  });
});

/** Todas las carpetas en lista plana (id, nombre, padreId), para el diálogo "Mover a…" que dibuja el árbol. */
router.get('/arbol', async (_req, res) => {
  const { rows } = await query(`SELECT id, nombre, padre_id FROM carpetas ORDER BY lower(nombre), id`);
  res.json({
    carpetas: rows.map((r) => ({ id: String(r.id), nombre: r.nombre, padreId: r.padre_id ? String(r.padre_id) : null })),
    maxNivel: MAX_NIVEL,
  });
});

/** Migas de pan: de la raíz a la carpeta. */
router.get('/:id/ruta', async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: NO_ENCONTRADA });
  const ruta = await rutaDe({ query }, req.params.id);
  if (!ruta.length) return res.status(404).json({ error: NO_ENCONTRADA });
  res.json({ ruta });
});

// --------------------------------------------------------------------------------------------- gestionar

/** Crear una carpeta en la raíz o dentro de otra (padreId), sin pasar de MAX_NIVEL niveles. */
router.post('/', requireRole(...ROLES_CARPETAS), async (req, res) => {
  const v = validarNombre(req.body?.nombre);
  if (v.error) return res.status(400).json({ error: v.error });
  const padre = leerPadreId(req.body?.padreId);
  if (padre.error) return res.status(400).json({ error: padre.error });

  let r;
  try {
    r = await withTransaction(async (c) => {
      await bloquearArbol(c);
      let destino = null;
      if (padre.id) {
        destino = await carpetaDestino(c, padre.id);
        if (!destino) return { status: 404, error: 'La carpeta donde quiere crearla no existe.' };
        if (destino.ruta.length >= MAX_NIVEL)
          return { status: 400, error: `${PROFUNDIDAD} «${destino.nombre}» ya está en el nivel ${MAX_NIVEL}.`, codigo: 'profundidad' };
      }
      const { rows: [ca] } = await c.query(
        `INSERT INTO carpetas (nombre, padre_id, creado_por) VALUES ($1, $2, $3) RETURNING id, nombre`, [v.nombre, padre.id, req.user.id]);
      return { status: 201, ca, ruta: [...(destino?.ruta ?? []), { id: String(ca.id), nombre: ca.nombre }] };
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: DUPLICADA });
    throw e;
  }
  if (r.status !== 201) return res.status(r.status).json({ error: r.error, codigo: r.codigo });

  await registrarAuditoria(req, 'crear_carpeta', null, {
    carpetaId: String(r.ca.id), nombre: r.ca.nombre, padreId: padre.id, ruta: textoRuta(r.ruta),
  });
  await notificarUsuarios({
    roles: ROLES_AVISO, titulo: `Carpeta creada: ${nombresRuta(r.ruta)}`,
    descripcion: 'Nueva carpeta para organizar documentos. No cambia quién puede ver cada documento.',
  });
  res.status(201).json({ id: String(r.ca.id), nombre: r.ca.nombre, padreId: padre.id, documentos: 0, subcarpetas: 0 });
});

/**
 * Renombrar ({ nombre }) y/o mover ({ padreId }: id o null = Inicio) una carpeta, con todo su contenido.
 * Mover rechaza ciclos (dentro de sí misma o de una subcarpeta suya), que el subárbol pase de MAX_NIVEL niveles
 * y un nombre repetido en el destino. Los documentos que contiene no cambian (ni sus permisos ni sus fechas).
 */
router.patch('/:id', requireRole(...ROLES_CARPETAS), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: NO_ENCONTRADA });
  const cuerpo = req.body ?? {};
  const renombrar = cuerpo.nombre !== undefined;
  const mover = cuerpo.padreId !== undefined;
  if (!renombrar && !mover) return res.status(400).json({ error: 'Indique el nuevo nombre (nombre) o el destino (padreId).' });
  const v = renombrar ? validarNombre(cuerpo.nombre) : {};
  if (v.error) return res.status(400).json({ error: v.error });
  const padre = mover ? leerPadreId(cuerpo.padreId) : {};
  if (padre.error) return res.status(400).json({ error: padre.error });

  let r;
  try {
    r = await withTransaction(async (c) => {
      if (mover) await bloquearArbol(c);
      const { rows: [antes] } = await c.query(`SELECT id, nombre, padre_id FROM carpetas WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!antes) return { status: 404, error: NO_ENCONTRADA };
      const id = String(antes.id);
      const dePadre = antes.padre_id ? String(antes.padre_id) : null;
      const deRuta = dePadre ? await rutaDe(c, dePadre) : [];
      let aPadre = dePadre;
      let aRuta = deRuta;
      if (mover && padre.id !== dePadre) {
        if (padre.id === id)
          return { status: 409, error: 'Una carpeta no puede moverse dentro de sí misma.', codigo: 'ciclo' };
        if (padre.id) {
          const destino = await carpetaDestino(c, padre.id);
          if (!destino) return { status: 404, error: 'La carpeta de destino no existe.' };
          if (destino.ruta.some((x) => x.id === id))
            return { status: 409, error: `No se puede mover «${antes.nombre}» dentro de una de sus propias subcarpetas.`, codigo: 'ciclo' };
          aRuta = destino.ruta;
        } else aRuta = [];
        const niveles = aRuta.length + (await alturaSubarbol(c, id));
        if (niveles > MAX_NIVEL)
          return { status: 400, error: `${PROFUNDIDAD} Con sus subcarpetas, «${antes.nombre}» llegaría al nivel ${niveles}.`, codigo: 'profundidad' };
        aPadre = padre.id;
      }
      const nombre = renombrar ? v.nombre : antes.nombre;
      if (nombre === antes.nombre && aPadre === dePadre) return { status: 200, antes, nombre, dePadre, aPadre, deRuta, aRuta };
      await c.query(`UPDATE carpetas SET nombre = $2, padre_id = $3, actualizado_en = now() WHERE id = $1`, [id, nombre, aPadre]);
      return { status: 200, antes, nombre, dePadre, aPadre, deRuta, aRuta };
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: DUPLICADA });
    throw e;
  }
  if (r.status !== 200) return res.status(r.status).json({ error: r.error, codigo: r.codigo });

  const id = String(r.antes.id);
  if (r.nombre !== r.antes.nombre) {
    await registrarAuditoria(req, 'renombrar_carpeta', null, { carpetaId: id, anterior: r.antes.nombre, nombre: r.nombre });
    await notificarUsuarios({
      roles: ROLES_AVISO, titulo: `Carpeta renombrada: ${r.antes.nombre} → ${r.nombre}`,
      descripcion: 'Los documentos que contiene no cambian.',
    });
  }
  if (r.aPadre !== r.dePadre) {
    await registrarAuditoria(req, 'mover_carpeta', null, {
      carpetaId: id, nombre: r.nombre, de: r.dePadre, deRuta: textoRuta(r.deRuta), a: r.aPadre, aRuta: textoRuta(r.aRuta),
    });
    await notificarUsuarios({
      roles: ROLES_AVISO, titulo: `Carpeta movida: ${r.nombre} → ${textoRuta(r.aRuta)}`,
      descripcion: `Antes estaba en ${textoRuta(r.deRuta)}. Se movió con sus subcarpetas y documentos; nadie gana ni pierde acceso.`,
    });
  }
  res.json({ id, nombre: r.nombre, padreId: r.aPadre });
});

/**
 * Solo vacía: sin subcarpetas, sin documentos (tampoco en la papelera, que podrían restaurarse a ella) y sin
 * solicitudes pendientes hacia ella.
 */
router.delete('/:id', requireRole(...ROLES_ELIMINAR_CARPETA), async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ error: NO_ENCONTRADA });
  const r = await withTransaction(async (c) => {
    await bloquearArbol(c); // nadie crea ni mueve una subcarpeta hacia ella mientras se comprueba
    const { rows: [ca] } = await c.query(`SELECT id, nombre, padre_id FROM carpetas WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!ca) return { status: 404, error: NO_ENCONTRADA };
    const { rows: [h] } = await c.query(`SELECT count(*)::int AS n FROM carpetas WHERE padre_id = $1`, [ca.id]);
    if (h.n > 0)
      return { status: 409, error: `La carpeta no está vacía: tiene ${h.n} ${h.n === 1 ? 'subcarpeta' : 'subcarpetas'}. Muévalas o elimínelas antes.`, codigo: 'subcarpetas' };
    // FOR UPDATE de la carpeta + FOR SHARE en mover/aprobar: nadie mete un documento mientras se comprueba que está vacía.
    const { rows: [n] } = await c.query(
      `SELECT count(*)::int AS docs FROM documentos WHERE carpeta_id = $1 AND estado <> 'purgado'`, [ca.id]);
    if (n.docs > 0)
      return { status: 409, error: `La carpeta no está vacía: contiene ${n.docs} ${n.docs === 1 ? 'documento' : 'documentos'} (se cuentan también los de la papelera). Muévalos antes de eliminarla.` };
    const { rows: [s] } = await c.query(
      `SELECT count(*)::int AS n FROM solicitudes_movimiento WHERE carpeta_destino_id = $1 AND estado = 'pendiente'`, [ca.id]);
    if (s.n > 0) return { status: 409, error: 'Hay solicitudes de movimiento pendientes hacia esta carpeta. Resuélvalas antes de eliminarla.' };
    const ruta = await rutaDe(c, ca.id);
    await c.query(`DELETE FROM carpetas WHERE id = $1`, [ca.id]);
    return { status: 204, carpeta: ca, ruta };
  });
  if (r.status !== 204) return res.status(r.status).json({ error: r.error, codigo: r.codigo });
  await registrarAuditoria(req, 'eliminar_carpeta', null, {
    carpetaId: String(r.carpeta.id), nombre: r.carpeta.nombre, ruta: textoRuta(r.ruta),
  });
  await notificarUsuarios({ roles: ROLES_AVISO, titulo: `Carpeta eliminada: ${nombresRuta(r.ruta)}`, descripcion: 'Estaba vacía.' });
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
      carpeta = await carpetaDestino(c, destino.id);
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
      a: destino.id, aNombre: r.carpeta?.nombre ?? null, aRuta: nombreDestino(r.carpeta),
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

/** Fila de solicitud presentada para el front (rutas: id de carpeta → migas, de rutasDe). */
const presentar = (s, usuario, rutas) => ({
  id: String(s.id),
  documento: { id: String(s.documento_id), nombre: s.documento_nombre, folio: s.folio },
  carpetaActual: s.actual_id ? { id: String(s.actual_id), nombre: s.actual_nombre, ruta: rutas.get(String(s.actual_id)) ?? [] } : null,
  carpetaDestino: s.carpeta_destino_id
    ? { id: String(s.carpeta_destino_id), nombre: s.destino_nombre, ruta: rutas.get(String(s.carpeta_destino_id)) ?? [] } : null,
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
        carpeta = await carpetaDestino(c, destino.id);
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

  await registrarAuditoria(req, 'solicitar_movimiento', r.doc.id, { solicitudId: String(r.id), a: destino.id, aNombre: r.carpeta?.nombre ?? null, aRuta: nombreDestino(r.carpeta), motivo });
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
  const rutas = await rutasDe({ query }, rows.flatMap((s) => [s.actual_id, s.carpeta_destino_id]));
  res.json(rows.map((s) => presentar(s, req.user, rutas)));
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
        carpeta = await carpetaDestino(c, s.carpeta_destino_id);
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
      de: s.actual_id ? String(s.actual_id) : null, a: detalle.a, aNombre: carpeta?.nombre ?? null, aRuta: nombreDestino(carpeta), solicitudId: String(s.id),
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
