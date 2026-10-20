/**
 * EMERGENCIA: restablece el 2FA de UNA cuenta desde la terminal (npm run admin:reset-2fa -- correo@dominio).
 *
 * Para el caso en que nadie puede hacerlo desde la aplicación: el ÚNICO Super Administrador perdió su
 * teléfono y sus códigos de recuperación. Restablecer no da acceso a nadie: borra el secreto y los códigos de
 * recuperación, cierra las sesiones abiertas, y en el próximo ingreso (con la contraseña) el sistema le obliga a
 * configurar un autenticador nuevo. Queda auditado (accion "restablecer_2fa", via "script_emergencia").
 *
 *   Desarrollo:  npm run admin:reset-2fa -- correo@dominio
 *                (exige APP_ENV=development y DATABASE_URL === DB_HOST_PERMITIDO, como db:setup)
 *   Producción:  DAI_PROD_DATABASE_URL='postgres://...' npm run admin:reset-2fa -- correo@dominio --produccion
 *                La cadena SOLO se acepta en el comando (nunca desde .env) y hay que escribir el host a mano.
 *
 * No imprime la cadena de conexión ni ningún secreto. No usa MFA_ENCRYPTION_KEY.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  conexionProduccionDesdeComando, confirmacionHostValida, ErrorEntorno, exigirEntornoDesarrollo,
} from '../src/lib/entorno.js';
import { quitar2fa } from '../src/lib/mfa-quitar.js';
import { ALERTAS, insertarAlerta } from '../src/lib/alertas-seguridad.js';

const args = process.argv.slice(2);
const produccion = args.includes('--produccion');
const email = args.find((a) => !a.startsWith('--'));

function salir(mensaje) {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) salir('Uso: npm run admin:reset-2fa -- correo@dominio [--produccion]');

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
    if (e instanceof ErrorEntorno) salir(e.message);
    throw e;
  }
  console.log(`⚠ Vas a restablecer el 2FA de ${email} en PRODUCCIÓN (host: ${host}).`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const escrito = await rl.question('Escribe el host exacto para confirmar: ');
  rl.close();
  if (!confirmacionHostValida(escrito, host)) salir('El host no coincide. No se hizo ningún cambio.');
} else {
  dotenv.config({ path: rutaEnv });
  ({ host } = exigirEntornoDesarrollo('admin:reset-2fa'));
  url = process.env.DATABASE_URL;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: [u] } = await client.query(
    `SELECT id, email, mfa_secreto IS NOT NULL AS tenia FROM usuarios WHERE lower(email) = lower($1) FOR UPDATE`, [email]);
  if (!u) {
    await client.query('ROLLBACK');
    salir(`No existe una cuenta con el correo ${email}. No se hizo ningún cambio.`);
  }
  await quitar2fa(client, u.id);
  await client.query(
    `INSERT INTO auditoria (usuario_id, accion, ip, detalle) VALUES (NULL, 'restablecer_2fa', 'script', $1)`,
    [JSON.stringify({ usuarioId: String(u.id), email: u.email, teniaActivo: u.tenia, via: 'script_emergencia', produccion })]);
  await client.query('COMMIT');
  // Después del COMMIT: el aviso al afectado nunca debe deshacer el restablecimiento.
  await insertarAlerta(client, u.id, ALERTAS.dosPasosRestablecido(), 'script de emergencia del servidor');
  console.log(`✔ 2FA restablecido para ${u.email}. En su próximo ingreso deberá configurar un autenticador nuevo.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✖ Error:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
