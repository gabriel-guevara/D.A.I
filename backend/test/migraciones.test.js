import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarMigraciones, MIGRACIONES } from '../src/migrate.js';
import { crearBaseDePrueba } from './helpers/base-prueba.js';

const silencio = () => {};
let base;
before(async () => { base = await crearBaseDePrueba(); });
after(() => base?.cerrar());

const aplicados = async () => (await base.pool.query('SELECT nombre FROM migraciones_aplicadas ORDER BY nombre')).rows.map((r) => r.nombre);

test('las pruebas corren en un esquema temporal, no en public', async () => {
  const { rows: [r] } = await base.pool.query('SELECT current_schema() AS s');
  assert.equal(r.s, base.esquema);
});

test('base nueva (schema.sql): aplica todas y una segunda ejecución no hace nada', async () => {
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), MIGRACIONES.map((m) => m.nombre));
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), []);
  assert.deepEqual(await aplicados(), MIGRACIONES.map((m) => m.nombre).sort());
});

test('base heredada que ya tenía la categoría "consulta" pero no la tabla de control', async () => {
  await base.pool.query('DROP TABLE migraciones_aplicadas');
  // Todas son idempotentes: sin tabla de control se vuelven a aplicar sobre lo que ya existe sin fallar.
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), MIGRACIONES.map((m) => m.nombre));
  // La restricción sigue aceptando 'consulta' y rechazando categorías desconocidas.
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, rol_id, nivel_id) VALUES ('Prueba', 'prueba@ejemplo.test', 1, 1) RETURNING id`);
  const insertar = (cat) => base.pool.query(
    `INSERT INTO notificaciones (usuario_id, categoria, borde_clase, badge, badge_clase, titulo, descripcion)
     VALUES ($1, $2, 'b', 'b', 'b', 't', 'd')`, [u.id, cat]);
  await insertar('consulta');
  await assert.rejects(insertar('inventada'), /notificaciones_categoria_check/);
});

test('una migración que falla no deja cambios a medias ni queda registrada', async () => {
  const fallida = {
    nombre: '999_prueba_fallida',
    async up(c) {
      await c.query('CREATE TABLE tabla_a_medias (id int)');
      throw new Error('fallo simulado');
    },
  };
  await assert.rejects(aplicarMigraciones(base.pool, { migraciones: [...MIGRACIONES, fallida], log: silencio }), /999_prueba_fallida.*fallo simulado/);
  const { rows: [t] } = await base.pool.query(`SELECT to_regclass('tabla_a_medias') AS t`);
  assert.equal(t.t, null);
  assert.ok(!(await aplicados()).includes('999_prueba_fallida'));
});

test('nombres repetidos se rechazan antes de tocar la base', async () => {
  await assert.rejects(aplicarMigraciones(base.pool, { migraciones: [MIGRACIONES[0], MIGRACIONES[0]], log: silencio }), /nombre repetido/);
});

test('002: base heredada sin las columnas de archivo se actualiza y los documentos existentes quedan sin archivo', async () => {
  // Simula producción antes de la Fase 1: sin las columnas nuevas y con un storage_path ficticio.
  await base.pool.query(`ALTER TABLE documentos DROP CONSTRAINT documentos_archivo_completo_check,
                           DROP CONSTRAINT documentos_storage_driver_check,
                           DROP COLUMN tiene_archivo, DROP COLUMN nombre_original, DROP COLUMN storage_driver`);
  await base.pool.query(`ALTER TABLE documento_versiones DROP CONSTRAINT documento_versiones_storage_driver_check, DROP COLUMN storage_driver`);
  await base.pool.query(`ALTER TABLE documentos ALTER COLUMN cifrado_aes SET DEFAULT true`);
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '002_documentos_archivo_real'`);
  const { rows: [doc] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, storage_path)
     VALUES ('Heredado.pdf', 'EXP-HEREDADO-1', 'pdf', 1, 'Alguien', 'ocr/7/nombre del usuario.pdf') RETURNING id`);

  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['002_documentos_archivo_real']);
  const { rows: [r] } = await base.pool.query(`SELECT tiene_archivo, storage_path, nombre_original FROM documentos WHERE id = $1`, [doc.id]);
  assert.equal(r.tiene_archivo, false);
  assert.equal(r.storage_path, 'ocr/7/nombre del usuario.pdf'); // aditiva: no borra datos
  assert.equal(r.nombre_original, null);

  // Un documento "con archivo" debe tener clave, driver, hash y nombre original.
  await assert.rejects(base.pool.query(`UPDATE documentos SET tiene_archivo = true WHERE id = $1`, [doc.id]), /documentos_archivo_completo_check/);
  await assert.rejects(base.pool.query(`UPDATE documentos SET storage_driver = 's3' WHERE id = $1`, [doc.id]), /documentos_storage_driver_check/);
  const { rows: [d] } = await base.pool.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'documentos' AND column_name = 'cifrado_aes'`);
  assert.equal(d.column_default, 'false');
  await base.pool.query(`DELETE FROM documentos WHERE id = $1`, [doc.id]);
});

test('seed: los documentos de demostración no tienen archivo ni clave ficticia', async () => {
  const { seed } = await import('../db/seed.js');
  await seed(base.pool);
  const { rows: [r] } = await base.pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE tiene_archivo)::int AS con_archivo,
            count(storage_path)::int AS con_clave, count(*) FILTER (WHERE cifrado_aes)::int AS cifrados FROM documentos`);
  assert.deepEqual(r, { total: 12, con_archivo: 0, con_clave: 0, cifrados: 0 });
  const { rows: [v] } = await base.pool.query(`SELECT count(storage_path)::int AS n FROM documento_versiones`);
  assert.equal(v.n, 0);
});
