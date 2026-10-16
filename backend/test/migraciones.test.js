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
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['001_notificaciones_categoria_consulta']);
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
