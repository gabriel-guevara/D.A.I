/**
 * Fase 3 de punta a punta: la app REAL por HTTP contra PostgreSQL en un esquema temporal.
 * Alta de 2FA (pendiente → confirmado), códigos TOTP (correcto, incorrecto, reutilizado, fuera de ventana),
 * cifrado en reposo, códigos de recuperación, límites por cuenta y por IP, cambio de contraseña con invalidación
 * de sesiones, restablecimiento por super-admin y auditoría sin secretos.
 *
 * Los códigos se calculan aquí con el mismo algoritmo que la app autenticadora (RFC 6238).
 * Cada petición sale de una IP distinta (X-Forwarded-For; la app confía en 1 proxy, como en Render) para que
 * el límite por IP no se mezcle entre pruebas; la prueba del límite por IP usa una IP fija.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { crearBaseDePrueba } from './helpers/base-prueba.js';

process.env.JWT_SECRET ??= 'secreto-de-pruebas-suficientemente-largo-0123456789';
process.env.STORAGE_DRIVER = 'local';
process.env.MFA_DEV_CODE = '123456'; // ya no se usa: las pruebas comprueban que NO abre ninguna puerta

let base, servidor, url, totp, cifrado, config, firmarToken;
const PASSWORD = 'Clave-Inicial-2025';
const sensibles = new Set([PASSWORD]); // todo lo que NUNCA debe aparecer en la auditoría ni en claro en la base
const silenciar = async (fn) => {
  const [e, w] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.warn] = [e, w]; }
};

before(async () => {
  base = await crearBaseDePrueba();
  const db = await silenciar(() => import('../src/db.js')); // config.js avisa que MFA_DEV_CODE ya no se usa
  db.usarPool(base.pool);
  const migrate = await import('../src/migrate.js');
  await migrate.aplicarMigraciones(base.pool, { log: () => {} });
  totp = await import('../src/lib/totp.js');
  cifrado = await import('../src/lib/cifrado-mfa.js');
  ({ config } = await import('../src/config.js'));
  ({ firmarToken } = await import('../src/middleware/auth.js'));
  const { crearApp } = await import('../src/app.js');
  servidor = crearApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  url = `http://127.0.0.1:${servidor.address().port}/api`;
});

after(async () => {
  await new Promise((r) => servidor?.close(r));
  const db = await import('../src/db.js');
  await db.pool.end();
  await base?.cerrar();
});

// ---------------------------------------------------------------------------------------------- utilidades
let ip = 0;
const nuevaIp = () => `10.${(++ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`;

async function pedir(metodo, ruta, { cuerpo, token, desde } = {}) {
  const r = await fetch(`${url}${ruta}`, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': desde ?? nuevaIp(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
}
const post = (ruta, cuerpo, opciones = {}) => pedir('POST', ruta, { cuerpo, ...opciones });
const get = (ruta, token) => pedir('GET', ruta, { token });

let n = 0;
async function crearUsuario(rol = 'read-only', nivel = 'Nivel 2 Confidencial') {
  const email = `usuario${++n}@prueba.test`;
  const { rows: [u] } = await base.pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol_id, nivel_id)
     VALUES ($1, $2, $3, (SELECT id FROM roles WHERE clave = $4), (SELECT id FROM niveles_acceso WHERE nombre = $5)) RETURNING id`,
    [`Usuario ${n}`, email, bcrypt.hashSync(PASSWORD, 4), rol, nivel]);
  return { id: String(u.id), email, password: PASSWORD };
}

/** Evita generar un código justo antes de que cambie el paso de 30 s (la prueba se volvería intermitente). */
async function lejosDelBorde() {
  const resto = Date.now() % 30_000;
  if (resto > 26_000) await new Promise((r) => setTimeout(r, 30_000 - resto + 250));
}
/** Código de la app con el reloj desplazado "desfase" pasos de 30 s. */
const codigo = (secreto, desfase = 0) => {
  const c = totp.codigoPara(secreto, Date.now() + desfase * 30_000);
  sensibles.add(c);
  return c;
};
const usuarioDb = async (id) => (await base.pool.query(`SELECT * FROM usuarios WHERE id = $1`, [id])).rows[0];
/** Simula que pasó el tiempo: permite volver a usar pasos ya consumidos por pruebas anteriores del mismo usuario. */
const olvidarPaso = (id) => base.pool.query(`UPDATE usuarios SET mfa_ultimo_paso = NULL WHERE id = $1`, [id]);
const auditorias = async (accion, usuarioId) =>
  (await base.pool.query(`SELECT * FROM auditoria WHERE accion = $1 AND ($2::bigint IS NULL OR usuario_id = $2) ORDER BY id`,
    [accion, usuarioId ?? null])).rows;

async function login(u, password = u.password) {
  return post('/auth/login', { username: u.email, password });
}

/** Usuario nuevo con 2FA activo. Devuelve secreto, token de sesión y códigos de recuperación. */
async function usuarioConDosPasos(rol, nivel) {
  const u = await crearUsuario(rol, nivel);
  const l = await login(u);
  assert.equal(l.cuerpo.paso, 'enrolar');
  const ini = await post('/auth/2fa/enrolar/iniciar', { enrolToken: l.cuerpo.enrolToken });
  assert.equal(ini.status, 200);
  await lejosDelBorde();
  const conf = await post('/auth/2fa/enrolar/confirmar', { enrolToken: l.cuerpo.enrolToken, code: codigo(ini.cuerpo.secreto) });
  assert.equal(conf.status, 200, JSON.stringify(conf.cuerpo));
  sensibles.add(ini.cuerpo.secreto);
  conf.cuerpo.codigosRecuperacion.forEach((c) => sensibles.add(c));
  await olvidarPaso(u.id);
  return { ...u, secreto: ini.cuerpo.secreto, token: conf.cuerpo.token, codigos: conf.cuerpo.codigosRecuperacion };
}

/** Login completo con un código (desfase en pasos) → respuesta del paso 2. */
async function entrar(u, { desfase = 0, password } = {}) {
  const l = await login(u, password);
  assert.equal(l.status, 200, JSON.stringify(l.cuerpo));
  assert.equal(l.cuerpo.paso, '2fa');
  await lejosDelBorde();
  return post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: codigo(u.secreto, desfase) });
}

// ---------------------------------------------------------------------------------------------- alta (enrolamiento)
test('usuario sin 2FA: tras la contraseña debe configurarlo; el token de alta no sirve como sesión ni como paso 2', async () => {
  const u = await crearUsuario();
  const l = await login(u);
  assert.equal(l.status, 200);
  assert.equal(l.cuerpo.paso, 'enrolar');
  assert.equal(l.cuerpo.mfaToken, undefined);
  assert.equal((await get('/auth/me', l.cuerpo.enrolToken)).status, 401);
  assert.equal((await get('/cuenta/seguridad', l.cuerpo.enrolToken)).status, 401);
  const v = await post('/auth/verify-2fa', { mfaToken: l.cuerpo.enrolToken, code: '123456' });
  assert.equal(v.status, 401);
  assert.equal(v.cuerpo.reiniciar, true);
});

test('alta: el secreto pendiente no sirve hasta confirmarse; se guarda cifrado; confirmar entrega sesión y 10 códigos', async () => {
  const u = await crearUsuario();
  const { cuerpo: { enrolToken } } = await login(u);

  const sinIniciar = await post('/auth/2fa/enrolar/confirmar', { enrolToken, code: '000000' });
  assert.equal(sinIniciar.status, 400);
  assert.equal(sinIniciar.cuerpo.nuevoQr, true);

  const ini = await post('/auth/2fa/enrolar/iniciar', { enrolToken });
  assert.equal(ini.status, 200);
  const { secreto, otpauthUri } = ini.cuerpo;
  sensibles.add(secreto);
  assert.match(secreto, /^[A-Z2-7]{32}$/);
  assert.equal(new URL(otpauthUri).searchParams.get('secret'), secreto);
  assert.equal(ini.cuerpo.emisor, 'DAI');

  let fila = await usuarioDb(u.id);
  assert.equal(fila.mfa_secreto, null, 'pendiente ≠ activo');
  assert.ok(cifrado.estaCifrado(fila.mfa_secreto_pendiente));
  assert.ok(!fila.mfa_secreto_pendiente.includes(secreto));

  // Con el secreto solo pendiente, el login sigue pidiendo el alta (no hay paso 2 que saltarse).
  assert.equal((await login(u)).cuerpo.paso, 'enrolar');

  assert.equal((await post('/auth/2fa/enrolar/confirmar', { enrolToken, code: 'abc' })).status, 400);
  await lejosDelBorde();
  const malo = await post('/auth/2fa/enrolar/confirmar', { enrolToken, code: codigo(secreto, -3) });
  assert.equal(malo.status, 401);
  const ok = await post('/auth/2fa/enrolar/confirmar', { enrolToken, code: codigo(secreto) });
  assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
  assert.equal(ok.cuerpo.user.email, u.email);
  assert.equal(ok.cuerpo.codigosRecuperacion.length, 10);
  ok.cuerpo.codigosRecuperacion.forEach((c) => sensibles.add(c));
  assert.equal((await get('/auth/me', ok.cuerpo.token)).status, 200);

  fila = await usuarioDb(u.id);
  assert.ok(cifrado.estaCifrado(fila.mfa_secreto));
  assert.ok(!fila.mfa_secreto.includes(secreto));
  assert.equal(cifrado.descifrarSecreto(fila.mfa_secreto, u.id), secreto);
  assert.equal(fila.mfa_secreto_pendiente, null);
  assert.ok(fila.mfa_activado_en);

  // El mismo token de alta ya no sirve: la cuenta tiene 2FA.
  const otra = await post('/auth/2fa/enrolar/iniciar', { enrolToken });
  assert.equal(otra.status, 409);
  assert.equal((await login(u)).cuerpo.paso, '2fa');

  const [a] = await auditorias('2fa_activado', u.id);
  assert.equal(a.detalle.via, 'login');
  assert.equal(a.detalle.cantidadCodigos, 10);

  const { rows } = await base.pool.query(`SELECT huella FROM mfa_codigos_recuperacion WHERE usuario_id = $1`, [u.id]);
  assert.equal(rows.length, 10);
  for (const c of ok.cuerpo.codigosRecuperacion) assert.ok(!rows.some((r) => r.huella.includes(c.replace('-', ''))));
});

test('alta: un secreto pendiente caducado (más de 15 min) no se puede confirmar', async () => {
  const u = await crearUsuario();
  const { cuerpo: { enrolToken } } = await login(u);
  const { cuerpo: { secreto } } = await post('/auth/2fa/enrolar/iniciar', { enrolToken });
  sensibles.add(secreto);
  await base.pool.query(`UPDATE usuarios SET mfa_pendiente_en = now() - interval '16 minutes' WHERE id = $1`, [u.id]);
  await lejosDelBorde();
  const r = await post('/auth/2fa/enrolar/confirmar', { enrolToken, code: codigo(secreto) });
  assert.equal(r.status, 400);
  assert.equal(r.cuerpo.nuevoQr, true);
  assert.equal((await usuarioDb(u.id)).mfa_secreto, null);
});

// ---------------------------------------------------------------------------------------------- códigos TOTP
test('código correcto, incorrecto, reutilizado, anterior al último usado y fuera de ventana', async () => {
  const u = await usuarioConDosPasos();

  const l = await login(u);
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: '12345' })).status, 400);
  await lejosDelBorde();
  const mal = await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: codigo(u.secreto, -3) });
  assert.equal(mal.status, 401, 'fuera de ventana (90 s atrás)');
  assert.equal(mal.cuerpo.error, 'Código de verificación incorrecto.');
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: codigo(u.secreto, 2) })).status, 401, '60 s adelante');

  await lejosDelBorde();
  const actual = codigo(u.secreto);
  const ok = await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: actual });
  assert.equal(ok.status, 200);
  assert.ok(ok.cuerpo.token);

  // Mismo código otra vez (aunque sea con otro token de paso 1): rechazado.
  const l2 = await login(u);
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l2.cuerpo.mfaToken, code: actual })).status, 401);
  // Reloj 30 s adelantado: aceptado (tolerancia); después, el código del paso anterior ya no sirve.
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l2.cuerpo.mfaToken, code: codigo(u.secreto, 1) })).status, 200);
  const l3 = await login(u);
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l3.cuerpo.mfaToken, code: codigo(u.secreto, 0) })).status, 401);
});

test('el mismo código enviado dos veces a la vez solo abre UNA sesión', async () => {
  const u = await usuarioConDosPasos();
  const [a, b] = await Promise.all([login(u), login(u)]);
  await lejosDelBorde();
  const c = codigo(u.secreto);
  const r = await Promise.all([
    post('/auth/verify-2fa', { mfaToken: a.cuerpo.mfaToken, code: c }),
    post('/auth/verify-2fa', { mfaToken: b.cuerpo.mfaToken, code: c }),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 401]);
});

test('códigos de recuperación: cada uno sirve una vez, se auditan y se pueden regenerar con un código de la app', async () => {
  const u = await usuarioConDosPasos();
  const l = await login(u);
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, codigoRecuperacion: 'corto' })).status, 400);
  const ok = await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, codigoRecuperacion: u.codigos[0].toLowerCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.cuerpo.codigosRestantes, 9);

  const l2 = await login(u);
  const otra = await post('/auth/verify-2fa', { mfaToken: l2.cuerpo.mfaToken, codigoRecuperacion: u.codigos[0] });
  assert.equal(otra.status, 401);
  assert.match(otra.cuerpo.error, /ya usado/);
  const [a] = await auditorias('2fa_codigo_recuperacion_usado', u.id);
  assert.deepEqual(a.detalle, { restantes: 9 });

  // Regenerar: exige segundo factor; los anteriores dejan de servir.
  assert.equal((await post('/cuenta/2fa/codigos-recuperacion', {}, { token: ok.cuerpo.token })).status, 400);
  await lejosDelBorde();
  const nuevos = await post('/cuenta/2fa/codigos-recuperacion', { code: codigo(u.secreto) }, { token: ok.cuerpo.token });
  assert.equal(nuevos.status, 200);
  assert.equal(nuevos.cuerpo.codigosRecuperacion.length, 10);
  nuevos.cuerpo.codigosRecuperacion.forEach((c) => sensibles.add(c));
  const l3 = await login(u);
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l3.cuerpo.mfaToken, codigoRecuperacion: u.codigos[1] })).status, 401);
  assert.equal((await post('/auth/verify-2fa', { mfaToken: l3.cuerpo.mfaToken, codigoRecuperacion: nuevos.cuerpo.codigosRecuperacion[0] })).status, 200);
  assert.equal((await get('/cuenta/seguridad', ok.cuerpo.token)).cuerpo.codigosRestantes, 9);
});

// ---------------------------------------------------------------------------------------------- límites de intentos
test('límite por cuenta en el 2FA: 5 códigos malos (desde IPs distintas) bloquean incluso el código correcto', async () => {
  const u = await usuarioConDosPasos();
  for (let i = 0; i < 5; i++) {
    const l = await login(u);
    assert.equal((await post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: '000000' })).status, 401);
  }
  const bloqueado = await entrar(u);
  assert.equal(bloqueado.status, 429);
  assert.match(bloqueado.cuerpo.error, /Demasiados intentos/);
  assert.equal((await auditorias('2fa_fallido', u.id)).length, 5);
  const [b] = await auditorias('bloqueo_temporal', u.id);
  assert.deepEqual(b.detalle, { motivo: 'totp', minutos: 15 });

  // Al vencer el bloqueo, el código correcto vuelve a funcionar.
  await base.pool.query(`UPDATE intentos_acceso SET bloqueado_hasta = now() - interval '1 second' WHERE clave = $1`, [`2fa:${u.id}`]);
  assert.equal((await entrar(u, { desfase: 1 })).status, 200);
});

test('límite por cuenta en la contraseña: mismo trato exista o no el usuario (no revela cuentas)', async () => {
  const u = await crearUsuario();
  const fantasma = { email: 'no-existe@prueba.test', password: PASSWORD };
  const respuestas = { real: [], fantasma: [] };
  for (let i = 0; i < 5; i++) {
    respuestas.real.push(await login(u, 'Incorrecta-123'));
    respuestas.fantasma.push(await login(fantasma, 'Incorrecta-123'));
  }
  assert.deepEqual(respuestas.real, respuestas.fantasma);
  assert.deepEqual(respuestas.real[0], { status: 401, cuerpo: { error: 'Usuario o contraseña incorrectos.' } });

  const real = await login(u); // contraseña CORRECTA, pero la cuenta está bloqueada
  const nada = await login(fantasma);
  assert.equal(real.status, 429);
  assert.deepEqual(real, nada);
  // Un usuario inactivo con la contraseña correcta recibe el mismo mensaje que una contraseña mala.
  const inactivo = await crearUsuario();
  await base.pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [inactivo.id]);
  assert.deepEqual(await login(inactivo), respuestas.real[0]);
  const { rows } = await base.pool.query(`SELECT clave FROM intentos_acceso`);
  assert.ok(rows.every((r) => !r.clave.includes('@')), 'no guarda correos escritos por el usuario');
  assert.equal((await auditorias('login_fallido', u.id)).length, 5);
});

test('límite por IP: 20 fallos desde la misma IP bloquean esa IP para cualquier cuenta', async () => {
  const desde = '203.0.113.77';
  for (let i = 0; i < 20; i++) {
    const r = await post('/auth/login', { username: `nadie${i}@prueba.test`, password: 'x' }, { desde });
    assert.equal(r.status, 401);
  }
  const u = await crearUsuario();
  const r = await post('/auth/login', { username: u.email, password: u.password }, { desde });
  assert.equal(r.status, 429);
  assert.match(r.cuerpo.error, /Demasiados intentos/);
  assert.equal((await login(u)).status, 200, 'otra IP no está afectada');
});

// ---------------------------------------------------------------------------------------------- MFA_DEV_CODE
test('MFA_DEV_CODE se ignora (también simulando producción): no hay atajo para cuentas sin 2FA', async () => {
  const u = await crearUsuario();
  for (const isProd of [false, true]) {
    const antes = config.isProd;
    config.isProd = isProd;
    try {
      const l = await login(u);
      assert.equal(l.cuerpo.paso, 'enrolar', 'sin 2FA se exige el alta, nunca un código fijo');
      // Aun falsificando un token de paso 2 (firmado con el JWT_SECRET), el código fijo no abre sesión.
      const forjado = firmarToken({ sub: u.id, ver: 0 }, 'mfa', '5m');
      assert.equal((await post('/auth/verify-2fa', { mfaToken: forjado, code: '123456' })).status, 401);
      const conf = await post('/auth/2fa/enrolar/confirmar', { enrolToken: l.cuerpo.enrolToken, code: '123456' });
      assert.equal(conf.status, 400, 'sin secreto pendiente no hay nada que confirmar');
      assert.equal((await usuarioDb(u.id)).mfa_secreto, null);
    } finally {
      config.isProd = antes;
    }
  }
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM auditoria WHERE usuario_id = $1 AND accion = 'login'`, [u.id])).rows[0].n, 0);
});

test('un secreto guardado en claro en la base (fuera de la migración) nunca se usa para entrar', async () => {
  const u = await crearUsuario();
  const secreto = totp.generarSecreto();
  sensibles.add(secreto);
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = $2 WHERE id = $1`, [u.id, secreto]);
  const l = await login(u);
  assert.equal(l.cuerpo.paso, '2fa');
  await lejosDelBorde();
  const r = await silenciar(() => post('/auth/verify-2fa', { mfaToken: l.cuerpo.mfaToken, code: codigo(secreto) }));
  assert.equal(r.status, 401);
  // Ni el cifrado de OTRO usuario copiado a esta fila (el AAD lo ata a su dueño).
  const otro = await usuarioConDosPasos();
  await base.pool.query(`UPDATE usuarios SET mfa_secreto = (SELECT mfa_secreto FROM usuarios WHERE id = $2) WHERE id = $1`, [u.id, otro.id]);
  const l2 = await login(u);
  await lejosDelBorde();
  assert.equal((await silenciar(() => post('/auth/verify-2fa', { mfaToken: l2.cuerpo.mfaToken, code: codigo(otro.secreto) }))).status, 401);
});

// ---------------------------------------------------------------------------------------------- cambio de contraseña
test('cambio de contraseña: exige la actual y un código; cierra TODAS las sesiones anteriores y entrega un token nuevo', async () => {
  const u = await usuarioConDosPasos();
  const otraSesion = (await entrar(u)).cuerpo.token; // p. ej. otro equipo
  const nueva = 'Nueva-Clave-Segura-2026';
  sensibles.add(nueva);
  const cambiar = (cuerpo) => post('/cuenta/password', cuerpo, { token: u.token });

  assert.match((await cambiar({ actual: u.password, nueva: 'corta1', code: '000000' })).cuerpo.error, /entre 10 y 72/);
  assert.match((await cambiar({ actual: u.password, nueva: u.password, code: '000000' })).cuerpo.error, /distinta/);
  assert.equal((await cambiar({ actual: u.password, nueva })).status, 400, 'sin código');
  await lejosDelBorde();
  const malActual = await cambiar({ actual: 'No-Es-La-Actual-1', nueva, code: codigo(u.secreto, 1) });
  assert.equal(malActual.status, 403, '403 y no 401: el front no debe cerrar la sesión por un error al escribir');
  assert.match(malActual.cuerpo.error, /contraseña actual/);
  assert.equal((await cambiar({ actual: u.password, nueva, code: '000000' })).status, 403);

  const ok = await cambiar({ actual: u.password, nueva, code: codigo(u.secreto, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
  assert.ok(ok.cuerpo.token);

  assert.equal((await get('/auth/me', u.token)).status, 401, 'la sesión con que se cambió también se renueva');
  const vieja = await get('/auth/me', otraSesion);
  assert.equal(vieja.status, 401);
  assert.match(vieja.cuerpo.error, /cambio de seguridad/);
  assert.equal((await get('/auth/me', ok.cuerpo.token)).status, 200);

  assert.equal((await login(u)).status, 401, 'la contraseña anterior ya no sirve');
  assert.equal((await login(u, nueva)).cuerpo.paso, '2fa');
  const seg = (await get('/cuenta/seguridad', ok.cuerpo.token)).cuerpo;
  assert.match(seg.passwordCambiadoEn, /\d{1,2}:\d{2} [ap]\. m\./);
  assert.equal(seg.mfaActivo, true);
  const [a] = await auditorias('cambiar_contrasena', u.id);
  assert.deepEqual(a.detalle, { segundoFactor: 'totp' });
  assert.equal((await auditorias('cambiar_contrasena_fallido', u.id)).length, 2);
});

// ---------------------------------------------------------------------------------------------- cambiar de teléfono
test('reconfigurar el autenticador: el anterior sigue valiendo hasta confirmar el nuevo, después ya no', async () => {
  const u = await usuarioConDosPasos();
  await lejosDelBorde();
  const mal = await post('/cuenta/2fa/reconfigurar/iniciar', { password: 'Otra-Cosa-123', code: codigo(u.secreto, -1) }, { token: u.token });
  assert.equal(mal.status, 403);
  const ini = await post('/cuenta/2fa/reconfigurar/iniciar', { password: u.password, code: codigo(u.secreto, -1) }, { token: u.token });
  assert.equal(ini.status, 200);
  const nuevo = ini.cuerpo.secreto;
  sensibles.add(nuevo);
  assert.notEqual(nuevo, u.secreto);

  assert.equal((await entrar(u)).status, 200, 'sin confirmar, el autenticador anterior sigue funcionando');
  assert.equal((await post('/cuenta/2fa/reconfigurar/confirmar', { code: '000000' }, { token: u.token })).status, 403);
  await lejosDelBorde();
  assert.equal((await post('/cuenta/2fa/reconfigurar/confirmar', { code: codigo(nuevo, 1) }, { token: u.token })).status, 200);
  await olvidarPaso(u.id);
  assert.equal((await entrar(u)).status, 401, 'el autenticador anterior ya no sirve');
  assert.equal((await entrar({ ...u, secreto: nuevo }, { desfase: 1 })).status, 200);
  assert.equal((await auditorias('2fa_reconfigurado', u.id)).length, 1);
});

// ---------------------------------------------------------------------------------------------- restablecer (super-admin)
test('restablecer el 2FA de otro usuario: solo super-admin, con su propio código, auditado; el usuario no queda bloqueado', async () => {
  const admin = await usuarioConDosPasos('super-admin', 'Nivel 5 Secreto');
  const cumplimiento = await usuarioConDosPasos('compliance', 'Nivel 3 Alto');
  const victima = await usuarioConDosPasos();
  const ruta = `/seguridad/usuarios/${victima.id}/restablecer-2fa`;

  assert.equal((await post(ruta, { code: '000000' }, { token: cumplimiento.token })).status, 403);
  assert.equal((await post(ruta, {}, { token: admin.token })).status, 400);
  assert.equal((await post(ruta, { code: '000000' }, { token: admin.token })).status, 403);
  await lejosDelBorde();
  assert.equal((await post(`/seguridad/usuarios/${admin.id}/restablecer-2fa`, { code: codigo(admin.secreto) }, { token: admin.token })).status, 400, 'a sí mismo no');
  assert.equal((await post('/seguridad/usuarios/999999/restablecer-2fa', { code: codigo(admin.secreto, 1) }, { token: admin.token })).status, 404);
  await olvidarPaso(admin.id);
  await lejosDelBorde();
  const ok = await post(ruta, { code: codigo(admin.secreto) }, { token: admin.token });
  assert.equal(ok.status, 200);

  const fila = await usuarioDb(victima.id);
  assert.equal(fila.mfa_secreto, null);
  assert.equal((await base.pool.query(`SELECT count(*)::int AS n FROM mfa_codigos_recuperacion WHERE usuario_id = $1`, [victima.id])).rows[0].n, 0);
  assert.equal((await get('/auth/me', victima.token)).status, 401, 'sus sesiones abiertas se cierran');
  assert.equal((await login(victima)).cuerpo.paso, 'enrolar', 'en su próximo ingreso configura uno nuevo');

  const [a] = await auditorias('restablecer_2fa', admin.id);
  assert.deepEqual(a.detalle, { usuarioId: victima.id, email: victima.email, teniaActivo: true });
  const lista = (await get('/seguridad/usuarios', admin.token)).cuerpo;
  assert.equal(lista.find((x) => x.id === victima.id).mfaActivo, false);
  assert.equal(lista.find((x) => x.id === admin.id).mfaActivo, true);
});

test('una contraseña restablecida por el super-admin también cierra las sesiones de ese usuario y cumple la política', async () => {
  const admin = await usuarioConDosPasos('super-admin', 'Nivel 5 Secreto');
  const u = await usuarioConDosPasos();
  const ruta = `/seguridad/usuarios/${u.id}`;
  const corta = await pedir('PATCH', ruta, { cuerpo: { password: 'Corta123' }, token: admin.token });
  assert.equal(corta.status, 400);
  assert.match(corta.cuerpo.error, /entre 10 y 72/);
  const ok = await pedir('PATCH', ruta, { cuerpo: { password: 'Restablecida-2026' }, token: admin.token });
  assert.equal(ok.status, 200);
  sensibles.add('Restablecida-2026');
  assert.equal((await get('/auth/me', u.token)).status, 401);
});

// ---------------------------------------------------------------------------------------------- al final: nada sensible guardado
test('auditoría y base: ningún secreto, código ni contraseña quedó registrado o en claro', async () => {
  const { rows: a } = await base.pool.query(`SELECT accion, detalle::text AS d FROM auditoria`);
  assert.ok(a.length > 30);
  const acciones = new Set(a.map((r) => r.accion));
  for (const esperada of ['login', 'login_fallido', '2fa_fallido', '2fa_alta_iniciada', '2fa_activado', 'bloqueo_temporal',
    'cambiar_contrasena', '2fa_reconfigurado', '2fa_codigos_regenerados', 'restablecer_2fa', '2fa_codigo_recuperacion_usado'])
    assert.ok(acciones.has(esperada), `falta auditar ${esperada}`);
  assert.ok(sensibles.size > 50);
  const variantes = (s) => [s, s.replace('-', ''), s.toLowerCase()];
  for (const r of a) for (const s of sensibles) for (const v of variantes(s)) assert.ok(!r.d.includes(v), `"${r.accion}" contiene un dato sensible`);

  // Ninguna fila de usuarios contiene un secreto TOTP en claro (salvo la que la prueba anterior plantó a propósito y se reemplazó).
  const { rows: u } = await base.pool.query(`SELECT u::text AS t FROM usuarios u`);
  for (const r of u) for (const s of sensibles) if (/^[A-Z2-7]{32}$/.test(s)) assert.ok(!r.t.includes(s));
});
