import { Router } from 'express';
import { query } from '../db.js';
import { formatBytes, haceCuanto } from '../lib/format.js';

const router = Router();
const num = (n) => Number(n).toLocaleString('en-US');

router.get('/', async (req, res) => {
  const rango = req.user.rango;
  const [conteos, almacenamiento, recientes] = await Promise.all([
    query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE d.creado_en >= date_trunc('month', now()))::int AS este_mes,
              count(*) FILTER (WHERE d.fecha_limite < current_date)::int AS vencidos
         FROM documentos d LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
        WHERE d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)`, [rango]),
    query(
      `SELECT coalesce(sum(tamano_bytes), 0)::bigint AS bytes,
              (SELECT valor::bigint FROM configuracion WHERE clave = 'cuota_bytes') AS cuota
         FROM documentos WHERE estado <> 'purgado'`),
    query(
      `SELECT d.id, d.nombre, d.autor_nombre, d.tamano_bytes, d.actualizado_en,
              dep.nombre AS categoria, dep.color_clase AS categoria_color
         FROM documentos d
         LEFT JOIN departamentos dep ON dep.id = d.departamento_id
         LEFT JOIN clasificaciones c ON c.id = d.clasificacion_id
        WHERE d.estado = 'activo' AND (c.id IS NULL OR c.nivel_minimo <= $1)
        ORDER BY d.actualizado_en DESC LIMIT 4`, [rango]),
  ]);

  const { total, este_mes, vencidos } = conteos.rows[0];
  const bytes = Number(almacenamiento.rows[0].bytes);
  const cuota = Number(almacenamiento.rows[0].cuota);
  const previos = total - este_mes;
  const crecimiento = este_mes === 0 ? 'Sin altas este mes' : previos > 0 ? `+${((este_mes / previos) * 100).toFixed(1)}% este mes` : `${este_mes} este mes`;
  const usoPct = cuota > 0 ? Math.round((bytes / cuota) * 100) : 0;

  res.json({
    stats: [
      { label: 'Total Indexados', value: num(total), sub: crecimiento, accent: 'text-blue-600' },
      { label: 'Almacenamiento Encriptado', value: formatBytes(bytes), sub: `de ${formatBytes(cuota)} · ${usoPct}%`, accent: 'text-indigo-600' },
      { label: 'Fuera de Plazo', value: String(vencidos), sub: vencidos > 0 ? 'Prioridad Alta' : 'Al día', accent: 'text-red-600' },
    ],
    documents: recientes.rows.map((r) => ({
      id: String(r.id), name: r.nombre, category: r.categoria ?? 'Sin departamento',
      categoryColor: r.categoria_color ?? 'bg-slate-100 text-slate-600',
      user: r.autor_nombre, time: haceCuanto(r.actualizado_en), size: formatBytes(r.tamano_bytes),
    })),
  });
});

export default router;
