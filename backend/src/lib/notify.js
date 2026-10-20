import { query } from '../db.js';
import { insertarAlerta } from './alertas-seguridad.js';
import { rolesCon } from './categorias-notificaciones.js';

// La matriz rol → categorías vive en un módulo sin base de datos (también la usa el seed); aquí se reexporta.
export { CATEGORIAS, CATEGORIAS_POR_ROL, categoriasDe, rolesCon } from './categorias-notificaciones.js';

/** Estilos por categoría (mismas clases que usa la pantalla de Notificaciones). */
const ESTILOS = {
  eliminado: { borde: 'border-l-red-500', badge: 'Papelera', badgeClase: 'bg-red-50 text-red-700', icono: '🗑️' },
  version: { borde: 'border-l-blue-500', badge: 'Versiones', badgeClase: 'bg-blue-50 text-blue-700', icono: '📄' },
  edicion: { borde: 'border-l-amber-500', badge: 'Carpetas', badgeClase: 'bg-amber-50 text-amber-700', icono: '📁' },
  solicitud: { borde: 'border-l-indigo-500', badge: 'Solicitudes', badgeClase: 'bg-indigo-50 text-indigo-700', icono: '📨' },
  consulta: { borde: 'border-l-blue-500', badge: 'Consulta', badgeClase: 'bg-blue-50 text-blue-700', icono: '👁️' },
};

/**
 * Condición SQL "este destinatario alcanza el nivel del documento" ($p = id del documento; NULL = no aplica).
 * Requiere el alias n = niveles_acceso del usuario. Así ningún aviso revela el nombre de un documento a quien no puede verlo.
 */
const ALCANZA_DOCUMENTO = (p) => `(${p}::bigint IS NULL OR n.rango >= (
  SELECT coalesce(c.nivel_minimo, 1) FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id WHERE d.id = ${p}::bigint))`;

/**
 * Avisa en tiempo real (el front consulta cada pocos segundos) a quienes supervisan las consultas (Admin y
 * Cumplimiento) que alguien abrió un documento, si alcanzan su nivel. A quien lo abrió le llega como "Consultaste ...".
 * Si la misma persona abre el mismo documento varias veces en 30 s, se avisa solo una vez. Nunca rompe la petición.
 */
export async function notificarConsulta(req, doc) {
  try {
    const { rows: [quien] } = await query(
      `SELECT u.nombre, r.nombre AS rol FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1`, [req.user.id]);
    if (!quien) return;

    const tituloPropio = `Consultaste ${doc.nombre}`;
    const tituloAjeno = `${quien.nombre} consultó ${doc.nombre}`;
    const meta = [`Usuario: ${quien.nombre}`, `Rol: ${quien.rol}`, `Folio: ${doc.folio}`, `IP: ${req.ip}`];
    const e = ESTILOS.consulta;

    await query(
      `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, icono, titulo, descripcion, meta, acciones, documento_id)
       SELECT u.id, 'consulta', $8, $9, $10, $11,
              CASE WHEN u.id = $1 THEN $2 ELSE $3 END,
              $4, $5::jsonb, '[]'::jsonb, $6
         FROM usuarios u JOIN roles r ON r.id = u.rol_id JOIN niveles_acceso n ON n.id = u.nivel_id
        WHERE r.clave = ANY($7::text[]) AND u.activo AND ${ALCANZA_DOCUMENTO('$6')}
          AND NOT EXISTS (
            SELECT 1 FROM notificaciones x
             WHERE x.usuario_id = u.id AND x.documento_id = $6 AND x.categoria = 'consulta'
               AND x.titulo = CASE WHEN u.id = $1 THEN $2 ELSE $3 END
               AND x.creado_en > now() - interval '30 seconds')`,
      [req.user.id, tituloPropio, tituloAjeno, `Acceso de lectura al expediente ${doc.folio}.`, JSON.stringify(meta), doc.id,
        rolesCon('consulta'), e.borde, e.badge, e.badgeClase, e.icono]);
  } catch (err) {
    console.error('No se pudo registrar la notificación de consulta:', err.message);
  }
}

/**
 * Notificación para un grupo de usuarios activos: por rol (roles) o por id (usuarioIds). Siempre se filtra además por
 * la matriz CATEGORIAS_POR_ROL y, si hay documento, por su nivel (o por nivelMinimo si se indica): nadie se entera por
 * una notificación de algo que no le corresponde o de un documento que no puede ver.
 * Nunca rompe la petición principal: la acción ya ocurrió y quedó auditada.
 * @param {{ categoria?: 'edicion'|'eliminado'|'version'|'solicitud', roles?: string[], usuarioIds?: (string|number)[],
 *           nivelMinimo?: number|null, titulo: string, descripcion: string, meta?: string[], documentoId?: string|number|null }} n
 */
export async function notificarUsuarios({ categoria = 'edicion', roles = [], usuarioIds = [], nivelMinimo = null, titulo, descripcion, meta = [], documentoId = null }) {
  const e = ESTILOS[categoria];
  try {
    await query(
      `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, icono, titulo, descripcion, meta, acciones, documento_id)
       SELECT u.id, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, $9
         FROM usuarios u JOIN roles r ON r.id = u.rol_id JOIN niveles_acceso n ON n.id = u.nivel_id
        WHERE u.activo AND (r.clave = ANY($10::text[]) OR u.id = ANY($11::bigint[]))
          AND r.clave = ANY($13::text[])
          AND ($12::int IS NULL OR n.rango >= $12::int) AND ${ALCANZA_DOCUMENTO('$9')}`,
      [categoria, e.borde, e.badge, e.badgeClase, e.icono, titulo, descripcion, JSON.stringify(meta), documentoId,
        roles, usuarioIds.map(String), nivelMinimo, rolesCon(categoria)]);
  } catch (err) {
    console.error('No se pudo registrar la notificación:', err.message);
  }
}

/** Papelera y versiones: a todos los roles que admiten la categoría (según la matriz) y alcanzan el nivel del documento. */
export async function notificarGestores({ categoria, titulo, descripcion, meta = [], documentoId }) {
  await notificarUsuarios({ categoria, roles: rolesCon(categoria), titulo, descripcion, meta, documentoId });
}

/**
 * Alerta de seguridad de la PROPIA cuenta (textos en lib/alertas-seguridad.js), con la IP de la petición.
 * @example await alertarSeguridad(req, u.id, ALERTAS.ingreso('totp'))
 */
export const alertarSeguridad = (req, usuarioId, alerta) => insertarAlerta({ query }, usuarioId, alerta, `IP ${req.ip}`);

/**
 * "Documentos movidos" a quienes pueden mover (roles), en UN solo INSERT: cada destinatario ve cuántos documentos y
 * qué folios alcanza SU nivel; si no alcanza ninguno, no recibe aviso (no se entera de que se movió algo que no ve).
 * @param {{ roles: string[], docs: { folio: string, nivel: number }[], destino: string, descripcion: string }} m
 */
export async function notificarMovimiento({ roles, docs, destino, descripcion }) {
  const e = ESTILOS.edicion;
  try {
    await query(
      `WITH m AS (SELECT * FROM unnest($1::text[], $2::int[]) WITH ORDINALITY AS t(folio, nivel, orden))
       INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, icono, titulo, descripcion, meta, acciones)
       SELECT v.id, 'edicion', $3, $4, $5, $6,
              CASE WHEN v.cuantos = 1 THEN 'Documento movido a ' || $7 ELSE v.cuantos || ' documentos movidos a ' || $7 END,
              $8, jsonb_build_array('Folios: ' || v.folios || CASE WHEN v.cuantos > 5 THEN '…' ELSE '' END), '[]'::jsonb
         FROM (SELECT u.id,
                      (SELECT count(*) FROM m WHERE m.nivel <= n.rango)::int AS cuantos,
                      (SELECT string_agg(x.folio, ', ' ORDER BY x.orden)
                         FROM (SELECT folio, orden FROM m WHERE m.nivel <= n.rango ORDER BY orden LIMIT 5) x) AS folios
                 FROM usuarios u JOIN roles r ON r.id = u.rol_id JOIN niveles_acceso n ON n.id = u.nivel_id
                WHERE u.activo AND r.clave = ANY($9::text[]) AND r.clave = ANY($10::text[])) v
        WHERE v.cuantos > 0`,
      [docs.map((d) => d.folio), docs.map((d) => d.nivel), e.borde, e.badge, e.badgeClase, e.icono, destino, descripcion,
        roles, rolesCon('edicion')]);
  } catch (err) {
    console.error('No se pudo registrar la notificación de movimiento:', err.message);
  }
}

/** Estilo de una categoría (para quien inserte notificaciones fuera de este archivo, como el seed). */
export const estiloDe = (categoria) => ESTILOS[categoria];
