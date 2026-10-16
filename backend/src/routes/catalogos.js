import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  const [departamentos, tipos, clasificaciones, niveles, roles] = await Promise.all([
    query(`SELECT id, nombre, color_clase AS "colorClase" FROM departamentos ORDER BY nombre`),
    query(`SELECT id, nombre FROM tipos_documentales ORDER BY id`),
    // "permitida": el usuario puede clasificar con ella (no supera su nivel). El servidor lo vuelve a validar al subir.
    query(`SELECT id, nombre, punto_clase AS "puntoClase", nivel_minimo <= $1 AS permitida
             FROM clasificaciones ORDER BY nivel_minimo DESC`, [req.user.rango]),
    query(`SELECT id, nombre, rango, color_clase AS "colorClase" FROM niveles_acceso ORDER BY rango DESC, nombre`),
    query(`SELECT id, clave, nombre FROM roles ORDER BY id`),
  ]);
  res.json({
    departamentos: departamentos.rows, tiposDocumentales: tipos.rows,
    clasificaciones: clasificaciones.rows, niveles: niveles.rows, roles: roles.rows,
    subida: { maxMb: config.maxUploadBytes / (1024 * 1024) },
  });
});

export default router;
