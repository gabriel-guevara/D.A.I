/**
 * EMERGENCIA: restablece la CONTRASEÑA de una cuenta desde la terminal y quita sus bloqueos por intentos.
 *
 *   npm run admin:reset-password -- correo@dominio                      (pide la contraseña nueva dos veces)
 *   npm run admin:reset-password -- correo@dominio --solo-desbloquear   (solo quita el bloqueo de 15 min)
 *
 * Para cuando nadie puede hacerlo desde la aplicación (el ÚNICO Super Administrador olvidó su contraseña): si hay
 * otro Super Administrador, que lo haga desde "Roles y Permisos → Editar", que es lo normal.
 *  - La contraseña se escribe sin que se vea, dos veces, y cumple la misma política que la aplicación.
 *  - Se guarda solo su hash bcrypt; nunca se imprime ni llega a la auditoría.
 *  - Cierra las sesiones abiertas (sesion_version + 1) y borra los bloqueos de contraseña y de 2FA de esa cuenta.
 *  - NO toca el 2FA: para entrar sigue haciendo falta el código de la app (si se perdió: admin:reset-2fa).
 *  - Queda auditado (accion "restablecer_contrasena" o "desbloquear_cuenta", via "script_emergencia").
 *
 *   Desarrollo:  exige APP_ENV=development y que el host de DATABASE_URL sea DB_HOST_PERMITIDO (como db:setup).
 *   Producción:  DAI_PROD_DATABASE_URL='postgres://...' npm run admin:reset-password -- correo@dominio --produccion
 *                La cadena SOLO se acepta en el comando (nunca desde .env) y hay que escribir el host a mano.
 *                (PowerShell: $env:DAI_PROD_DATABASE_URL='postgres://...'; npm run admin:reset-password -- correo --produccion;
 *                 Remove-Item Env:DAI_PROD_DATABASE_URL)
 *
 * No imprime la cadena de conexión ni la contraseña. No usa MFA_ENCRYPTION_KEY.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  conexionProduccionDesdeComando, confirmacionHostValida, ErrorEntorno, exigirEntornoDesarrollo,
} from '../src/lib/entorno.js';
import { errorContrasena } from '../src/lib/contrasena.js';
import { clave2fa, claveContrasena } from '../src/lib/intentos-claves.js';

const args = process.argv.slice(2);
const produccion = args.includes('--produccion');
const soloDesbloquear = args.includes('--solo-desbloquear');
const email = args.find((a) => !a.startsWith('--'));

function salir(mensaje) {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  salir('Uso: npm run admin:reset-password -- correo@dominio [--solo-desbloquear] [--produccion]');

// ------------------------------------------------------------------------------------------- entrada
// Un solo lector de líneas para todo el script: funciona igual en una terminal (escribiendo) que con la entrada
// redirigida (pruebas). Con "oculto", lo que se escribe no se muestra (como al pedir una contraseña).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let oculto = false;
const escribirOriginal = rl._writeToOutput.bind(rl);
rl._writeToOutput = (texto) => { if (!oculto) escribirOriginal(texto); };
const pendientes = [];
const esperando = [];
let cerrada = false; // la entrada terminó (Ctrl+D, o fin de lo redirigido): ya no llegarán más líneas
rl.on('line', (l) => (esperando.length ? esperando.shift()(l) : pendientes.push(l)));
rl.on('close', () => {
  cerrada = true;
  while (esperando.length) esperando.shift()(null);
});

function preguntar(texto, { secreto = false } = {}) {
  process.stdout.write(texto);
  oculto = secreto;
  return new Promise((ok) => {
    const responder = (l) => {
      oculto = false;
      if (secreto) process.stdout.write('\n');
      ok(l);
    };
    if (pendientes.length) responder(pendientes.shift());
    else if (cerrada) responder(null);
    else esperando.push(responder);
  });
}

function terminar(codigo, mensaje) {
  rl.close();
  if (mensaje) console.error(`✖ ${mensaje}`);
  process.exit(codigo);
}

// ------------------------------------------------------------------------------------------- conexión
// Variables del COMANDO antes de leer el .env (así se sabe de dónde vino cada una).
const envComando = { ...process.env };
let clavesDelDotenv = new Set();
const rutaEnv = path.join(process.cwd(), '.env');
if (fs.existsSync(rutaEnv)) clavesDelDotenv = new Set(Object.keys(dotenv.parse(fs.readFileSync(rutaEnv))));

let url;
let host;
if (produccion) {
  try {
    ({ url, host } = conexionProduccionDesdeComando(envComando, clavesDelDotenv));
  } catch (e) {
    if (e instanceof ErrorEntorno) terminar(1, e.message);
    throw e;
  }
  console.log(`⚠ Vas a ${soloDesbloquear ? 'desbloquear' : 'restablecer la contraseña de'} ${email} en PRODUCCIÓN (host: ${host}).`);
  const escrito = await preguntar('Escribe el host exacto para confirmar: ');
  if (!confirmacionHostValida(escrito, host)) terminar(1, 'El host no coincide. No se hizo ningún cambio.');
} else {
  dotenv.config({ path: rutaEnv });
  ({ host } = exigirEntornoDesarrollo('admin:reset-password'));
  url = process.env.DATABASE_URL;
}

// ------------------------------------------------------------------------------------------- contraseña
let hash = null;
if (!soloDesbloquear) {
  const nueva = await preguntar('Contraseña nueva (no se verá al escribir): ', { secreto: true });
  const repetida = await preguntar('Repítela: ', { secreto: true });
  if (nueva === null || repetida === null) terminar(1, 'No se recibió la contraseña. No se hizo ningún cambio.');
  if (nueva !== repetida) terminar(1, 'Las dos contraseñas no coinciden. No se hizo ningún cambio.');
  const problema = errorContrasena(nueva, { email });
  if (problema) terminar(1, `${problema} No se hizo ningún cambio.`);
  hash = await bcrypt.hash(nueva, 12);
}
rl.close();

// ------------------------------------------------------------------------------------------- cambio
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: [u] } = await client.query(
    `SELECT id, email, activo, mfa_secreto IS NOT NULL AS con_2fa FROM usuarios WHERE lower(email) = lower($1) FOR UPDATE`, [email]);
  if (!u) {
    await client.query('ROLLBACK');
    console.error(`✖ No existe una cuenta con el correo ${email}. No se hizo ningún cambio.`);
    process.exitCode = 1;
  } else {
    if (hash)
      await client.query(
        `UPDATE usuarios SET password_hash = $2, sesion_version = sesion_version + 1, password_cambiado_en = now() WHERE id = $1`,
        [u.id, hash]);
    // El bloqueo de contraseña se guarda por el correo ESCRITO en el login (en minúsculas): se usan el de la cuenta y el del comando.
    const { rowCount: bloqueos } = await client.query(
      `DELETE FROM intentos_acceso WHERE clave = ANY($1::text[])`,
      [[claveContrasena(u.email), claveContrasena(email), clave2fa(u.id)]]);
    await client.query(
      `INSERT INTO auditoria (usuario_id, accion, ip, detalle) VALUES (NULL, $1, 'script', $2)`,
      [hash ? 'restablecer_contrasena' : 'desbloquear_cuenta',
        JSON.stringify({ usuarioId: String(u.id), email: u.email, bloqueosQuitados: bloqueos, via: 'script_emergencia', produccion })]);
    await client.query('COMMIT');

    console.log(hash
      ? `✔ Contraseña restablecida para ${u.email}. Sus sesiones abiertas se cerraron.`
      : `✔ Cuenta ${u.email} desbloqueada.`);
    console.log(`  Bloqueos por intentos quitados: ${bloqueos}.`);
    console.log(u.con_2fa
      ? '  El 2FA no cambió: para entrar sigue haciendo falta el código de la app autenticadora.'
      : '  Esta cuenta no tiene 2FA: en su próximo ingreso deberá configurarlo.');
    if (!u.activo) console.log('  ⚠ La cuenta está DESACTIVADA: no podrá entrar hasta que un Super Administrador la active.');
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✖ Error:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
