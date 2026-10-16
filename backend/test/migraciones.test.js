import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarMigraciones, MIGRACIONES } from '../src/migrate.js';
import { crearBaseDePrueba } from './helpers/base-prueba.js';
import { descifrarSecreto, estaCifrado } from '../src/lib/cifrado-mfa.js';
import { codigoPara, pasoDelCodigo } from '../src/lib/totp.js';

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
  assert.deepEqual(r, { total: 13, con_archivo: 0, con_clave: 0, cifrados: 0 });
  // Fase 4: uno de demostración está en la papelera, con su plazo de purga.
  const { rows: [p] } = await base.pool.query(
    `SELECT count(*)::int AS n, count(purgar_despues_de)::int AS con_plazo FROM documentos WHERE estado = 'papelera'`);
  assert.deepEqual(p, { n: 1, con_plazo: 1 });
  const { rows: [v] } = await base.pool.query(`SELECT count(storage_path)::int AS n FROM documento_versiones`);
  assert.equal(v.n, 0);
  // Fase 5: carpetas demo, una solicitud pendiente, sin cola de escáner inventada ni notificaciones con botones,
  // y ninguna notificación revela un documento por encima del nivel de quien la recibe.
  const { rows: [f5] } = await base.pool.query(
    `SELECT (SELECT count(*)::int FROM carpetas) AS carpetas, (SELECT count(*)::int FROM documentos WHERE carpeta_id IS NOT NULL) AS en_carpeta,
            (SELECT count(*)::int FROM solicitudes_movimiento WHERE estado = 'pendiente') AS pendientes,
            (SELECT count(*)::int FROM ocr_trabajos) AS cola,
            (SELECT count(*)::int FROM notificaciones WHERE acciones <> '[]'::jsonb) AS con_acciones,
            (SELECT count(*)::int FROM usuarios WHERE mfa_metodo <> 'TOTP') AS mfa_inventado,
            (SELECT count(*)::int FROM notificaciones n JOIN usuarios u ON u.id = n.usuario_id JOIN niveles_acceso na ON na.id = u.nivel_id
               JOIN documentos d ON d.id = n.documento_id JOIN clasificaciones c ON c.id = d.clasificacion_id
              WHERE c.nivel_minimo > na.rango) AS filtradas`);
  assert.deepEqual(f5, { carpetas: 3, en_carpeta: 4, pendientes: 1, cola: 0, con_acciones: 0, mfa_inventado: 0, filtradas: 0 });
});

test('003: base de producción sin la tabla de indexación ni el origen del texto; aditiva e idempotente', async () => {
  await base.pool.query(`DROP TABLE documento_indexacion`);
  await base.pool.query(`ALTER TABLE documento_paginas DROP CONSTRAINT documento_paginas_origen_check, DROP COLUMN origen`);
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '003_texto_indexacion'`);
  const doc = async (folio, conArchivo) => (await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, tiene_archivo, storage_path, storage_driver, hash_sha256, nombre_original)
     VALUES ($1, $1, 'pdf', 1, 'X', $2, $3, $4, $5, $6) RETURNING id`,
    [folio, conArchivo, conArchivo ? 'docs/1/1/a.pdf' : null, conArchivo ? 'r2' : null, conArchivo ? 'a'.repeat(64) : null, conArchivo ? 'a.pdf' : null])).rows[0].id;
  const demo = await doc('EXP-003-DEMO', false);
  const real = await doc('EXP-003-REAL', true);
  const manual = await doc('EXP-003-OCR', false);
  await base.pool.query(`INSERT INTO documento_paginas (documento_id, pagina, texto) VALUES ($1, 1, 'demo'), ($2, 1, 'ocr')`, [demo, manual]);
  await base.pool.query(`INSERT INTO ocr_trabajos (nombre_archivo, documento_id, estado) VALUES ('x.pdf', $1, 'procesado')`, [manual]);

  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['003_texto_indexacion']);
  const origen = async (id) => (await base.pool.query(`SELECT origen FROM documento_paginas WHERE documento_id = $1`, [id])).rows[0].origen;
  assert.equal(await origen(demo), 'demo');
  assert.equal(await origen(manual), 'manual');
  const { rows } = await base.pool.query(`SELECT documento_id::int, estado, motivo FROM documento_indexacion`);
  assert.deepEqual(rows, [{ documento_id: Number(real), estado: 'pendiente', motivo: 'backfill' }]); // solo los que tienen archivo
  await assert.rejects(base.pool.query(`UPDATE documento_indexacion SET estado = 'otro'`), /documento_indexacion_estado_check/);
  await assert.rejects(base.pool.query(`UPDATE documento_paginas SET origen = 'otro'`), /documento_paginas_origen_check/);

  // Volver a aplicarla (sin registro de control) no duplica ni falla.
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '003_texto_indexacion'`);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['003_texto_indexacion']);
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM documento_indexacion`)).rows[0].n, 1);
});

/** Deja la base como estaba en producción antes de la Fase 3 (sin columnas ni tablas nuevas, 004 sin aplicar). */
async function baseAntesDeFase3() {
  await base.pool.query(`DROP TABLE IF EXISTS mfa_codigos_recuperacion, intentos_acceso`);
  await base.pool.query(`ALTER TABLE usuarios DROP COLUMN IF EXISTS mfa_secreto_pendiente, DROP COLUMN IF EXISTS mfa_pendiente_en,
                           DROP COLUMN IF EXISTS mfa_activado_en, DROP COLUMN IF EXISTS mfa_ultimo_paso,
                           DROP COLUMN IF EXISTS sesion_version, DROP COLUMN IF EXISTS password_cambiado_en`);
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '004_mfa_totp_real'`);
}
const insertarUsuario = async (email, secreto) => (await base.pool.query(
  `INSERT INTO usuarios (nombre, email, rol_id, nivel_id, mfa_secreto) VALUES ('Admin', $1, 1, 1, $2) RETURNING id`, [email, secreto])).rows[0].id;

test('004: cifra el secreto en claro del administrador SIN cambiarlo (su app sigue sirviendo) y es idempotente', async () => {
  await baseAntesDeFase3();
  // El puente manual: secreto base32 escrito a mano (minúsculas y espacios, como lo muestran algunas apps).
  const enClaro = 'jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp';
  const normal = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const admin = await insertarUsuario('admin-004@ejemplo.test', enClaro);
  const sinMfa = await insertarUsuario('sin-mfa-004@ejemplo.test', null);

  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['004_mfa_totp_real']);
  const fila = async (id) => (await base.pool.query(`SELECT * FROM usuarios WHERE id = $1`, [id])).rows[0];
  const a = await fila(admin);
  assert.ok(estaCifrado(a.mfa_secreto));
  assert.ok(!a.mfa_secreto.toUpperCase().replace(/\s/g, '').includes(normal));
  assert.equal(descifrarSecreto(a.mfa_secreto, admin), normal);
  assert.ok(a.mfa_activado_en);
  assert.equal(a.sesion_version, 0, 'las sesiones abiertas antes del despliegue siguen valiendo');
  // Un código generado por la app del administrador (con el secreto ORIGINAL) se valida con el descifrado.
  const ahora = Date.now();
  assert.notEqual(pasoDelCodigo(codigoPara(normal, ahora), descifrarSecreto(a.mfa_secreto, admin), ahora), null);
  assert.equal((await fila(sinMfa)).mfa_secreto, null);

  // Idempotente: aplicarla de nuevo (sin registro de control) no vuelve a cifrar lo cifrado.
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '004_mfa_totp_real'`);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['004_mfa_totp_real']);
  assert.equal((await fila(admin)).mfa_secreto, a.mfa_secreto);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), []);
  await base.pool.query(`DELETE FROM usuarios WHERE id IN ($1, $2)`, [admin, sinMfa]);
});

test('004: un secreto en claro que no es base32 detiene la migración sin cambios y sin mostrar el valor', async () => {
  await baseAntesDeFase3();
  const raro = 'esto-no-es-base32!!';
  const id = await insertarUsuario('raro-004@ejemplo.test', raro);
  await assert.rejects(aplicarMigraciones(base.pool, { log: silencio }), (e) => {
    assert.match(e.message, new RegExp(`004_mfa_totp_real.*usuario ${id} no es base32`));
    assert.ok(!e.message.includes(raro));
    return true;
  });
  const { rows: [c] } = await base.pool.query(`SELECT to_regclass('intentos_acceso') AS t`);
  assert.equal(c.t, null, 'la transacción revirtió también las tablas nuevas');
  assert.equal((await base.pool.query(`SELECT mfa_secreto FROM usuarios WHERE id = $1`, [id])).rows[0].mfa_secreto, raro);
  await base.pool.query(`DELETE FROM usuarios WHERE id = $1`, [id]);
});

test('004: sin MFA_ENCRYPTION_KEY no se puede cifrar lo que hay en claro: la migración falla y no deja nada a medias', async () => {
  await baseAntesDeFase3();
  const id = await insertarUsuario('sin-clave-004@ejemplo.test', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  const clave = process.env.MFA_ENCRYPTION_KEY;
  delete process.env.MFA_ENCRYPTION_KEY;
  try {
    await assert.rejects(aplicarMigraciones(base.pool, { log: silencio }), /004_mfa_totp_real.*Falta MFA_ENCRYPTION_KEY/);
  } finally {
    process.env.MFA_ENCRYPTION_KEY = clave;
  }
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['004_mfa_totp_real']);
  assert.ok(estaCifrado((await base.pool.query(`SELECT mfa_secreto FROM usuarios WHERE id = $1`, [id])).rows[0].mfa_secreto));
});

/** Deja la base como producción antes de la Fase 4 (sin columnas, tabla ni CHECK nuevos; 005 sin aplicar). */
async function baseAntesDeFase4() {
  await base.pool.query(`DROP TABLE IF EXISTS objetos_por_borrar`);
  await base.pool.query(`DROP INDEX IF EXISTS documentos_papelera_idx`);
  await base.pool.query(`ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_purgado_sin_archivo_check,
                           DROP COLUMN IF EXISTS purgar_despues_de, DROP COLUMN IF EXISTS purgado_en, DROP COLUMN IF EXISTS purgado_por`);
  await base.pool.query(`ALTER TABLE documento_versiones DROP COLUMN IF EXISTS nombre_original, DROP COLUMN IF EXISTS paginas`);
  await base.pool.query(`ALTER TABLE documento_indexacion DROP CONSTRAINT documento_indexacion_motivo_check`);
  await base.pool.query(`ALTER TABLE documento_indexacion ADD CONSTRAINT documento_indexacion_motivo_check
                           CHECK (motivo IN ('subida','reproceso','backfill','script'))`);
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '005_papelera_versiones'`);
}

test('005: base como producción (papelera con datos, versión con archivo, lápida heredada); aditiva e idempotente', async () => {
  await baseAntesDeFase4();
  const insertar = async (folio, extra = {}) => {
    const c = { estado: 'activo', tiene: false, path: null, driver: null, hash: null, nombre: null, paginas: 1, eliminado: null, ...extra };
    return (await base.pool.query(
      `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, estado, tiene_archivo, storage_path, storage_driver,
                               hash_sha256, nombre_original, paginas, eliminado_en)
       VALUES ($1, $1, 'pdf', 1, 'X', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [folio, c.estado, c.tiene, c.path, c.driver, c.hash, c.nombre, c.paginas, c.eliminado])).rows[0].id;
  };
  // En la papelera desde hace 90 días: NO debe purgarse al desplegar (recibe un plazo completo).
  const viejo = await insertar('EXP-005-PAPELERA', { estado: 'papelera', eliminado: new Date(Date.now() - 90 * 86_400_000) });
  const conArchivo = await insertar('EXP-005-REAL', { tiene: true, path: 'docs/5/5/a.pdf', driver: 'r2', hash: 'b'.repeat(64), nombre: 'Real.pdf', paginas: 7 });
  await base.pool.query(`INSERT INTO documento_versiones (documento_id, version, storage_path, storage_driver, hash_sha256)
                         VALUES ($1, 'v1.0', 'docs/5/5/a.pdf', 'r2', $2)`, [conArchivo, 'b'.repeat(64)]);
  // Lápida heredada que NO cumpliría la regla nueva (purgado con clave ficticia): la migración no debe fallar.
  const lapida = await insertar('EXP-005-LAPIDA', { estado: 'purgado', path: 'demo/heredado/v1' });

  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['005_papelera_versiones']);
  const { rows: [p] } = await base.pool.query(
    `SELECT purgar_despues_de > now() + interval '29 days' AS plazo_completo FROM documentos WHERE id = $1`, [viejo]);
  assert.equal(p.plazo_completo, true);
  const { rows: [v] } = await base.pool.query(`SELECT nombre_original, paginas FROM documento_versiones WHERE documento_id = $1`, [conArchivo]);
  assert.deepEqual(v, { nombre_original: 'Real.pdf', paginas: 7 });
  assert.equal((await base.pool.query(`SELECT storage_path FROM documentos WHERE id = $1`, [lapida])).rows[0].storage_path, 'demo/heredado/v1');
  // Las reglas nuevas rigen para lo que se escriba desde ahora.
  await assert.rejects(base.pool.query(`UPDATE documentos SET estado = 'purgado' WHERE id = $1`, [conArchivo]), /documentos_purgado_sin_archivo_check/);
  await base.pool.query(`INSERT INTO documento_indexacion (documento_id, motivo) VALUES ($1, 'version')`, [conArchivo]);
  await assert.rejects(base.pool.query(`INSERT INTO objetos_por_borrar (clave, storage_driver, motivo) VALUES ('x', 's3', 'purga')`), /objetos_por_borrar_driver_check/);

  // Idempotente: aplicarla otra vez (sin registro de control) no cambia los plazos ni falla.
  const antes = (await base.pool.query(`SELECT purgar_despues_de FROM documentos WHERE id = $1`, [viejo])).rows[0].purgar_despues_de;
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '005_papelera_versiones'`);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['005_papelera_versiones']);
  assert.deepEqual((await base.pool.query(`SELECT purgar_despues_de FROM documentos WHERE id = $1`, [viejo])).rows[0].purgar_despues_de, antes);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), []);
  await base.pool.query(`DELETE FROM documentos WHERE id IN ($1, $2, $3)`, [viejo, conArchivo, lapida]);
});

/** Deja la base como producción antes de la Fase 5 (sin carpetas ni solicitudes, trigger antiguo; 006 sin aplicar). */
async function baseAntesDeFase5() {
  await base.pool.query(`DROP TABLE IF EXISTS solicitudes_movimiento`);
  await base.pool.query(`ALTER TABLE documentos DROP COLUMN IF EXISTS carpeta_id`);
  await base.pool.query(`DROP TABLE IF EXISTS carpetas`);
  await base.pool.query(`CREATE OR REPLACE FUNCTION set_actualizado_en() RETURNS trigger AS $$
                         BEGIN NEW.actualizado_en = now(); RETURN NEW; END $$ LANGUAGE plpgsql`);
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '006_carpetas'`);
}

test('006: base como producción (documentos existentes); aditiva, idempotente y el trigger sigue igual salvo al mover', async () => {
  await baseAntesDeFase5();
  const hace = new Date(Date.now() - 7 * 86_400_000);
  const { rows: [doc] } = await base.pool.query(
    `INSERT INTO documentos (nombre, folio, formato, clasificacion_id, autor_nombre, creado_en, actualizado_en)
     VALUES ('Prod.pdf', 'EXP-006-PROD', 'pdf', 1, 'X', $1, $1) RETURNING id, actualizado_en`, [hace]);
  const antes = (await base.pool.query(`SELECT count(*)::int AS n FROM documentos`)).rows[0].n;

  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['006_carpetas']);
  const fila = async () => (await base.pool.query(`SELECT carpeta_id, actualizado_en FROM documentos WHERE id = $1`, [doc.id])).rows[0];
  const f = await fila();
  assert.equal(f.carpeta_id, null, 'lo existente queda "Sin carpeta"');
  assert.equal(f.actualizado_en.getTime(), doc.actualizado_en.getTime(), 'la migración no toca las fechas');
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM documentos`)).rows[0].n, antes, 'no borra nada');

  // Reglas nuevas: nombre único sin distinguir mayúsculas, longitud, estado válido y una sola pendiente por documento.
  const { rows: [ca] } = await base.pool.query(`INSERT INTO carpetas (nombre) VALUES ('Contratos') RETURNING id`);
  await assert.rejects(base.pool.query(`INSERT INTO carpetas (nombre) VALUES ('CONTRATOS')`), /carpetas_nombre_uq/);
  await assert.rejects(base.pool.query(`INSERT INTO carpetas (nombre) VALUES ('x')`), /carpetas_nombre_check/);
  const { rows: [u] } = await base.pool.query(`INSERT INTO usuarios (nombre, email, rol_id, nivel_id) VALUES ('S', 's-006@ejemplo.test', 2, 2) RETURNING id`);
  const pedir = () => base.pool.query(`INSERT INTO solicitudes_movimiento (documento_id, carpeta_destino_id, solicitante_id, motivo)
                                       VALUES ($1, $2, $3, 'motivo de prueba')`, [doc.id, ca.id, u.id]);
  await pedir();
  await assert.rejects(pedir(), /solicitudes_movimiento_pendiente_uq/);
  await assert.rejects(base.pool.query(`UPDATE solicitudes_movimiento SET estado = 'otra'`), /solicitudes_movimiento_estado_check/);
  await base.pool.query(`UPDATE solicitudes_movimiento SET estado = 'rechazada'`);
  await pedir(); // resuelta la anterior, se puede pedir otra

  // Trigger: un cambio real sigue actualizando la fecha; mover con SET LOCAL no.
  const c = await base.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL dai.conservar_actualizado = 'on'`);
    await c.query(`UPDATE documentos SET carpeta_id = $2 WHERE id = $1`, [doc.id, ca.id]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  assert.equal((await fila()).actualizado_en.getTime(), doc.actualizado_en.getTime());
  await base.pool.query(`UPDATE documentos SET nombre = 'Prod v2.pdf' WHERE id = $1`, [doc.id]);
  assert.ok((await fila()).actualizado_en > doc.actualizado_en, 'el ajuste era LOCAL: no se quedó pegado a la conexión');

  // Idempotente: aplicarla otra vez (sin registro de control) no falla ni pierde lo asignado.
  await base.pool.query(`DELETE FROM migraciones_aplicadas WHERE nombre = '006_carpetas'`);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), ['006_carpetas']);
  assert.equal(String((await fila()).carpeta_id), String(ca.id));
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM solicitudes_movimiento`)).rows[0].n, 2);
  assert.deepEqual(await aplicarMigraciones(base.pool, { log: silencio }), []);
  await base.pool.query(`DELETE FROM solicitudes_movimiento`);
  await base.pool.query(`DELETE FROM carpetas WHERE id = $1`, [ca.id]);
  assert.equal((await fila()).carpeta_id, null, 'borrar una carpeta deja el documento "Sin carpeta" (ON DELETE SET NULL)');
  await base.pool.query(`DELETE FROM documentos WHERE id = $1`, [doc.id]);
  await base.pool.query(`DELETE FROM usuarios WHERE id = $1`, [u.id]);
});
