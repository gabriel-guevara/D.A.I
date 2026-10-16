/**
 * Piezas puras de la Fase 3 (sin base de datos): cifrado AES-256-GCM, TOTP con su ventana, códigos de
 * recuperación y política de contraseñas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  cifrarSecreto, descifrarSecreto, errorClaveMfa, estaCifrado, huellaCodigoRecuperacion, normalizarCodigoRecuperacion,
  normalizarSecretoBase32, nuevoCodigoRecuperacion, PROPOSITO_PENDIENTE,
} from '../src/lib/cifrado-mfa.js';
import { codigoPara, generarSecreto, pasoDe, pasoDelCodigo, uriOtpauth } from '../src/lib/totp.js';
import { errorContrasena } from '../src/lib/contrasena.js';

const clave = crypto.randomBytes(32);
const otraClave = crypto.randomBytes(32);

test('MFA_ENCRYPTION_KEY: exige 32 bytes en base64 estricto y nunca repite el valor en el mensaje', () => {
  assert.equal(errorClaveMfa(crypto.randomBytes(32).toString('base64')), null);
  assert.match(errorClaveMfa(undefined), /Falta MFA_ENCRYPTION_KEY/);
  assert.match(errorClaveMfa(''), /Falta/);
  for (const malo of [crypto.randomBytes(16).toString('base64'), crypto.randomBytes(32).toString('hex'), 'no es base64 !!!!',
    crypto.randomBytes(33).toString('base64')]) {
    const e = errorClaveMfa(malo);
    assert.match(e, /32 bytes en base64/);
    assert.ok(!e.includes(malo));
  }
  assert.match(errorClaveMfa(Buffer.alloc(32).toString('base64')), /repetido/);
});

test('cifrado: ida y vuelta, IV distinto cada vez y el texto en claro no aparece', () => {
  const secreto = generarSecreto();
  const a = cifrarSecreto(secreto, 7, { clave });
  const b = cifrarSecreto(secreto, 7, { clave });
  assert.ok(estaCifrado(a));
  assert.notEqual(a, b); // IV aleatorio: el mismo secreto no produce el mismo cifrado
  assert.ok(!a.includes(secreto));
  assert.equal(descifrarSecreto(a, 7, { clave }), secreto);
});

test('cifrado: falla con otra clave, otro usuario, otro propósito o un bit alterado', () => {
  const secreto = generarSecreto();
  const c = cifrarSecreto(secreto, 7, { clave });
  assert.throws(() => descifrarSecreto(c, 7, { clave: otraClave }));
  assert.throws(() => descifrarSecreto(c, 8, { clave }), 'copiar el cifrado a la fila de otro usuario no sirve');
  assert.throws(() => descifrarSecreto(c, 7, { clave, proposito: PROPOSITO_PENDIENTE }));
  const [v, iv, tag, datos] = c.split(':');
  const alterado = Buffer.from(datos, 'base64');
  alterado[0] ^= 1;
  assert.throws(() => descifrarSecreto([v, iv, tag, alterado.toString('base64')].join(':'), 7, { clave }));
  assert.throws(() => descifrarSecreto(secreto, 7, { clave }), /no está cifrado/);
});

test('secretos escritos a mano se normalizan; lo que no es base32 se rechaza', () => {
  assert.equal(normalizarSecretoBase32('jbsw y3dp-ehpk 3pxp===='), 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizarSecretoBase32('JBSWY3DP'), null); // demasiado corto
  assert.equal(normalizarSecretoBase32('JBSWY3DPEHPK3PX1'), null); // "1" no existe en base32
  assert.equal(normalizarSecretoBase32(null), null);
});

test('TOTP: tolera ±1 paso (30 s) y rechaza fuera de la ventana; devuelve el paso exacto', () => {
  const s = generarSecreto();
  const t = 1_800_000_015_000; // instante fijo, en mitad de un paso
  const paso = pasoDe(t);
  assert.equal(pasoDelCodigo(codigoPara(s, t), s, t), paso);
  assert.equal(pasoDelCodigo(codigoPara(s, t - 30_000), s, t), paso - 1, 'reloj del teléfono 30 s atrasado');
  assert.equal(pasoDelCodigo(codigoPara(s, t + 30_000), s, t), paso + 1, 'reloj del teléfono 30 s adelantado');
  assert.equal(pasoDelCodigo(codigoPara(s, t - 60_000), s, t), null, '2 pasos atrás: fuera de ventana');
  assert.equal(pasoDelCodigo(codigoPara(s, t + 90_000), s, t), null);
  assert.equal(pasoDelCodigo('12345', s, t), null);
  assert.equal(pasoDelCodigo('abcdef', s, t), null);
  assert.equal(pasoDelCodigo(codigoPara(s, t), generarSecreto(), t), null);
});

test('URI otpauth: emisor DAI, cuenta y secreto (lo que lee la app al escanear el QR)', () => {
  const s = generarSecreto();
  const u = new URL(uriOtpauth('e.ramos@dai.corp', s));
  assert.equal(u.protocol, 'otpauth:');
  assert.equal(u.searchParams.get('secret'), s);
  assert.equal(u.searchParams.get('issuer'), 'DAI');
  assert.equal(u.searchParams.get('digits'), '6');
  assert.equal(u.searchParams.get('period'), '30');
  assert.match(decodeURIComponent(u.pathname), /DAI:e\.ramos@dai\.corp/);
});

test('códigos de recuperación: formato XXXXX-XXXXX, únicos y huella estable sin importar guiones ni mayúsculas', () => {
  const codigos = Array.from({ length: 200 }, nuevoCodigoRecuperacion);
  assert.equal(new Set(codigos).size, 200);
  for (const c of codigos) assert.match(c, /^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
  const c = codigos[0];
  assert.equal(huellaCodigoRecuperacion(c, clave), huellaCodigoRecuperacion(c.toLowerCase().replace('-', ' '), clave));
  assert.notEqual(huellaCodigoRecuperacion(c, clave), huellaCodigoRecuperacion(c, otraClave), 'la huella depende de la clave del servidor');
  assert.match(huellaCodigoRecuperacion(c, clave), /^[0-9a-f]{64}$/);
  assert.equal(normalizarCodigoRecuperacion('AAAA-AAAA'), null);
  assert.equal(normalizarCodigoRecuperacion('OOOOO-IIIII'), null); // letras ambiguas no forman parte del alfabeto
});

test('política de contraseñas', () => {
  assert.equal(errorContrasena('Archivo-Central-77'), null);
  assert.match(errorContrasena('Corta1'), /entre 10 y 72/);
  assert.match(errorContrasena('a1'.repeat(37)), /entre 10 y 72/); // 74 bytes: bcrypt ignoraría el resto
  assert.match(errorContrasena('ñ'.repeat(36) + '1'), /entre 10 y 72/); // la ñ ocupa 2 bytes
  assert.match(errorContrasena('solamenteletras'), /letra y un número/);
  assert.match(errorContrasena('12345678901'), /letra y un número/);
  assert.match(errorContrasena('Password123'), /común/);
  assert.match(errorContrasena('eramos-2025-segura', { email: 'eramos@dai.corp' }), /usuario/);
  assert.match(errorContrasena(undefined), /entre 10 y 72/);
});
