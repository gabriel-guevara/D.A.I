import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  const [departamentos, tipos, clasificaciones, niveles, roles] = await Promise.all([
    query(`SELECT id, nombre, color_clase AS "colorClase" FROM departamentos ORDER BY nombre`),
    query(`SELECT id, nombre FROM tipos_documentales ORDER BY id`),
    query(`SELECT id, nombre, punto_clase AS "puntoClase" FROM clasificaciones ORDER BY nivel_minimo DESC`),
    query(`SELECT id, nombre, color_clase AS "colorClase" FROM niveles_acceso ORDER BY rango DESC, nombre`),
    query(`SELECT id, clave, nombre FROM roles ORDER BY id`),
  ]);
  res.json({
    departamentos: departamentos.rows, tiposDocumentales: tipos.rows,
    clasificaciones: clasificaciones.rows, niveles: niveles.rows, roles: roles.rows,
  });
});

export default router;
