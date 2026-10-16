/**
 * Dashboard con cifras REALES (Fase 5). Para todos, siempre según su nivel: documentos visibles, altas del mes,
 * con/sin archivo original, fuera de plazo, reparto por departamento y por formato, y los recientes.
 * Solo Super Administrador y Oficial de Cumplimiento: el almacenamiento real (bytes de los objetos guardados,
 * cuántos son, la cuota y lo que ocupa la papelera) y un texto HONESTO sobre el cifrado según el driver.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { formatBytes, haceCuanto } from '../lib/format.js';
import { almacenamiento as storage } from '../lib/storage.js';

const router = Router();
export const ROLES_ALMACENAMIENTO = ['super-admin', 'compliance'];
const ZONA = 'America/Bogota';
// $1 = rango del usuario
const VISIBLE = `d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)`;
const FROM = `FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id`;

/** Lo que el sistema puede afirmar sobre el cifrado en reposo, sin exagerar. */
export function textoCifrado(driver) {
  return driver === 'r2'
    ? 'Cloudflare R2 cifra en reposo todos los objetos (AES-256, claves gestionadas por Cloudflare).'
    : 'Almacenamiento local de desarrollo: los archivos se guardan sin cifrar en el disco del servidor.';
}

/** Driver con el que la API guarda HOY los archivos (el ya inicializado; si no, el configurado). */
function driverActual() {
  try {
    return storage().driver;
  } catch {
    return config.storage?.driver ?? 'local';
  }
}

router.get('/', async (req, res) => {
  const rango = req.user.rango;
  const [conteos, departamentos, formatos, recientes] = await Promise.all([
    // "Este mes" y "fuera de plazo" se calculan con el calendario de Colombia, no con el del servidor (UTC).
    query(
      `SELECT count(*)::int AS visibles,
              count(*) FILTER (WHERE d.creado_en >= date_trunc('month', now() AT TIME ZONE '${ZONA}') AT TIME ZONE '${ZONA}')::int AS altas_mes,
              count(*) FILTER (WHERE d.tiene_archivo)::int AS con_archivo,
              count(*) FILTER (WHERE d.fecha_limite < (now() AT TIME ZONE '${ZONA}')::date)::int AS fuera_de_plazo
       ${FROM} WHERE ${VISIBLE}`, [rango]),
    query(
      `SELECT coalesce(dep.nombre, 'Sin departamento') AS nombre, coalesce(dep.color_clase, 'bg-slate-100 text-slate-600') AS color,
              count(*)::int AS total
       ${FROM} LEFT JOIN departamentos dep ON dep.id = d.departamento_id
        WHERE ${VISIBLE} GROUP BY 1, 2 ORDER BY total DESC, nombre`, [rango]),
    query(`SELECT d.formato, count(*)::int AS total ${FROM} WHERE ${VISIBLE} GROUP BY 1 ORDER BY total DESC, d.formato`, [rango]),
    query(
      `SELECT d.id, d.nombre, d.formato, d.autor_nombre, d.tamano_bytes, d.actualizado_en,
              dep.nombre AS categoria, dep.color_clase AS categoria_color
       ${FROM} LEFT JOIN departamentos dep ON dep.id = d.departamento_id
        WHERE ${VISIBLE} ORDER BY d.actualizado_en DESC, d.id DESC LIMIT 5`, [rango]),
  ]);
  const k = conteos.rows[0];

  let almacenamiento = null;
  if (ROLES_ALMACENAMIENTO.includes(req.user.rol)) {
    // Solo objetos que EXISTEN: versiones con storage_path (las purgadas y los registros sin original no ocupan nada).
    const { rows: [s] } = await query(
      `SELECT coalesce(sum(v.tamano_bytes), 0)::bigint AS bytes, count(*)::int AS objetos,
              coalesce(sum(v.tamano_bytes) FILTER (WHERE d.estado = 'papelera'), 0)::bigint AS bytes_papelera,
              (SELECT count(*)::int FROM documentos WHERE estado = 'papelera') AS docs_papelera,
              (SELECT valor::bigint FROM configuracion WHERE clave = 'cuota_bytes') AS cuota
         FROM documento_versiones v JOIN documentos d ON d.id = v.documento_id
        WHERE v.storage_path IS NOT NULL`);
    const bytes = Number(s.bytes);
    const cuota = s.cuota === null ? null : Number(s.cuota);
    const driver = driverActual();
    almacenamiento = {
      bytes, usado: formatBytes(bytes), objetos: s.objetos,
      cuotaBytes: cuota, cuota: cuota ? formatBytes(cuota) : null,
      porcentaje: cuota ? Math.min(100, Math.round((bytes / cuota) * 1000) / 10) : null,
      papelera: { documentos: s.docs_papelera, bytes: Number(s.bytes_papelera), usado: formatBytes(s.bytes_papelera) },
      driver, cifrado: textoCifrado(driver), cifradoEnReposo: driver === 'r2',
    };
  }

  res.json({
    documentos: {
      visibles: k.visibles, altasMes: k.altas_mes, conArchivo: k.con_archivo,
      sinArchivo: k.visibles - k.con_archivo, fueraDePlazo: k.fuera_de_plazo,
    },
    porDepartamento: departamentos.rows,
    porFormato: formatos.rows,
    recientes: recientes.rows.map((r) => ({
      id: String(r.id), name: r.nombre, formato: r.formato, category: r.categoria ?? 'Sin departamento',
      categoryColor: r.categoria_color ?? 'bg-slate-100 text-slate-600',
      user: r.autor_nombre, time: haceCuanto(r.actualizado_en), size: formatBytes(r.tamano_bytes),
    })),
    almacenamiento,
  });
});

export default router;
