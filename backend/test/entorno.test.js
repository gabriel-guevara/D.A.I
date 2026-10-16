import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorEntorno, hostDeUrl, normalizarHost, verificarEntornoDestructivo, erroresEntornoApi,
  conexionProduccionDesdeComando, confirmacionHostValida, VAR_URL_PRODUCCION,
} from '../src/lib/entorno.js';

// Hosts inventados con la forma de Neon (no son reales).
const DEV = 'ep-dev-ejemplo-123456.us-east-2.aws.neon.tech';
const PROD = 'ep-prod-ejemplo-654321.us-east-2.aws.neon.tech';
const url = (host) => `postgres://usuario:clave@${host}/neondb?sslmode=require`;
const envDev = (extra = {}) => ({ APP_ENV: 'development', DATABASE_URL: url(DEV), DB_HOST_PERMITIDO: DEV, ...extra });

test('hostDeUrl extrae solo el host, sin credenciales', () => {
  assert.equal(hostDeUrl(url(DEV)), DEV);
  assert.equal(hostDeUrl('no es una url'), null);
  assert.equal(hostDeUrl(undefined), null);
});

test('normalizarHost trata igual el host directo y el "-pooler" de Neon', () => {
  const pooler = DEV.replace('.us-east-2', '-pooler.us-east-2');
  assert.equal(normalizarHost(pooler), DEV);
  assert.doesNotThrow(() => verificarEntornoDestructivo('x', envDev({ DATABASE_URL: url(pooler) })));
});

test('operación destructiva: acepta desarrollo con el host permitido', () => {
  assert.deepEqual(verificarEntornoDestructivo('db:setup', envDev()), { host: DEV });
});

test('operación destructiva: se niega con APP_ENV ausente o production', () => {
  assert.throws(() => verificarEntornoDestructivo('db:setup', envDev({ APP_ENV: undefined })), /APP_ENV debe ser "development"/);
  assert.throws(() => verificarEntornoDestructivo('db:setup', envDev({ APP_ENV: 'production' })), ErrorEntorno);
});

test('operación destructiva: se niega si el host no coincide (producción)', () => {
  assert.throws(() => verificarEntornoDestructivo('purga', envDev({ DATABASE_URL: url(PROD) })), /no coincide con DB_HOST_PERMITIDO/);
});

test('operación destructiva: se niega sin DB_HOST_PERMITIDO o con una URL completa en él', () => {
  assert.throws(() => verificarEntornoDestructivo('x', envDev({ DB_HOST_PERMITIDO: '' })), /DB_HOST_PERMITIDO no está definida/);
  assert.throws(() => verificarEntornoDestructivo('x', envDev({ DB_HOST_PERMITIDO: url(DEV) })), /SOLO el nombre del host/);
});

test('operación destructiva: se niega con NODE_ENV=production aunque lo demás esté bien', () => {
  assert.throws(() => verificarEntornoDestructivo('x', envDev({ NODE_ENV: 'production' })), /NODE_ENV es "production"/);
});

test('el mensaje nunca incluye la contraseña de la cadena de conexión', () => {
  try {
    verificarEntornoDestructivo('x', envDev({ DATABASE_URL: url(PROD) }));
    assert.fail('debía lanzar');
  } catch (e) {
    assert.ok(!e.message.includes('clave'), 'no debe filtrar credenciales');
  }
});

test('arranque de la API: reglas de APP_ENV', () => {
  assert.deepEqual(erroresEntornoApi(envDev()), []);
  assert.match(erroresEntornoApi({ DATABASE_URL: url(DEV) }).join(), /APP_ENV debe ser/);
  assert.match(erroresEntornoApi(envDev({ NODE_ENV: 'production' })).join(), /NODE_ENV=production exige APP_ENV=production/);
  assert.match(erroresEntornoApi(envDev({ DATABASE_URL: url(PROD) })).join(), /debe coincidir/);
  // Producción: no necesita DB_HOST_PERMITIDO, pero si está y coincide es un error de configuración.
  assert.deepEqual(erroresEntornoApi({ APP_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: url(PROD) }), []);
  assert.match(erroresEntornoApi({ APP_ENV: 'production', DATABASE_URL: url(DEV), DB_HOST_PERMITIDO: DEV }).join(), /apunta al host de desarrollo/);
});

test('excepción controlada: la cadena de producción solo vale si viene del comando', () => {
  const env = { [VAR_URL_PRODUCCION]: url(PROD) };
  assert.deepEqual(conexionProduccionDesdeComando(env), { url: url(PROD), host: PROD });
  assert.throws(() => conexionProduccionDesdeComando(env, new Set([VAR_URL_PRODUCCION])), /no puede venir del archivo .env/);
  assert.throws(() => conexionProduccionDesdeComando({}), /debes pasar/);
  assert.equal(confirmacionHostValida(`  ${PROD.toUpperCase()} `, PROD), true);
  assert.equal(confirmacionHostValida('ep-prod', PROD), false);
});
