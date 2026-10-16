/**
 * Verificaciones de entorno. Funciones PURAS: reciben el objeto de variables (por defecto process.env)
 * y lanzan ErrorEntorno con un mensaje claro. No importan config.js para poder usarse desde scripts
 * y pruebas sin efectos secundarios.
 *
 * Variables:
 *  - APP_ENV            "development" | "production". Dice CONTRA QUÉ datos se trabaja.
 *  - DB_HOST_PERMITIDO  host (solo el nombre) de la base donde se permiten operaciones destructivas.
 *  - DATABASE_URL       cadena de conexión. Nunca se imprime completa: solo su host.
 */

export const APP_ENVS = ['development', 'production'];

export class ErrorEntorno extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorEntorno';
  }
}

/** Host (en minúsculas) de una cadena de conexión, sin usuario, contraseña ni base. null si no se puede leer. */
export function hostDeUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Neon da dos hosts por rama: el directo (ep-xxx.region...) y el agrupado (ep-xxx-pooler.region...).
 * Son la MISMA base, así que se comparan sin el sufijo "-pooler" del primer segmento.
 */
export function normalizarHost(host) {
  if (!host) return null;
  const [primero, ...resto] = String(host).trim().toLowerCase().split('.');
  return [primero.replace(/-pooler$/, ''), ...resto].join('.');
}

export const mismoHost = (a, b) => !!a && !!b && normalizarHost(a) === normalizarHost(b);

/**
 * Exige un entorno de DESARROLLO antes de una operación destructiva (db:setup, purgas masivas, pruebas).
 * Reúne TODOS los problemas en un solo mensaje para que se puedan corregir de una vez.
 * @returns {{ host: string }} el host verificado
 */
export function verificarEntornoDestructivo(operacion, env = process.env) {
  const problemas = [];
  const appEnv = env.APP_ENV;
  const host = hostDeUrl(env.DATABASE_URL);
  const permitido = (env.DB_HOST_PERMITIDO || '').trim();

  if (appEnv !== 'development')
    problemas.push(`APP_ENV debe ser "development" (valor actual: ${appEnv ? `"${appEnv}"` : 'sin definir'}).`);
  if (env.NODE_ENV === 'production')
    problemas.push('NODE_ENV es "production": las operaciones destructivas nunca corren así.');
  if (!host)
    problemas.push('DATABASE_URL no está definida o no es una URL válida.');
  if (!permitido)
    problemas.push('DB_HOST_PERMITIDO no está definida (pon solo el host de tu rama de desarrollo).');
  else if (permitido.includes('/') || permitido.includes('@') || permitido.includes(':'))
    problemas.push('DB_HOST_PERMITIDO debe ser SOLO el nombre del host, sin usuario, contraseña, puerto ni base.');
  if (host && permitido && !mismoHost(host, permitido))
    problemas.push(`El host de DATABASE_URL ("${host}") no coincide con DB_HOST_PERMITIDO ("${permitido}").`);

  if (problemas.length)
    throw new ErrorEntorno(
      `Operación "${operacion}" bloqueada por seguridad. Revisa tu .env:\n  - ${problemas.join('\n  - ')}`);
  return { host };
}

/**
 * Para scripts de línea de comandos: verifica y, si no se cumple, imprime el motivo y termina con código 1.
 */
export function exigirEntornoDesarrollo(operacion, env = process.env) {
  try {
    const r = verificarEntornoDestructivo(operacion, env);
    console.log(`✔ Entorno verificado para "${operacion}" (host: ${r.host}).`);
    return r;
  } catch (e) {
    if (!(e instanceof ErrorEntorno)) throw e;
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
}

/**
 * Reglas del arranque de la API (no destructivo). Devuelve la lista de errores (vacía si todo bien).
 *  - APP_ENV obligatorio y válido.
 *  - NODE_ENV=production exige APP_ENV=production (no se puede correr "producción" contra datos de desarrollo).
 *  - En desarrollo, la base DEBE ser la permitida: así una API local con atajos de desarrollo nunca toca producción.
 *  - En producción, si alguien dejó DB_HOST_PERMITIDO y coincide, la API apunta a la rama dev por error.
 */
export function erroresEntornoApi(env = process.env) {
  const errores = [];
  const appEnv = env.APP_ENV;
  if (!APP_ENVS.includes(appEnv)) {
    errores.push(`APP_ENV debe ser "development" o "production" (valor actual: ${appEnv ? `"${appEnv}"` : 'sin definir'}).`);
    return errores;
  }
  if (env.NODE_ENV === 'production' && appEnv !== 'production')
    errores.push('NODE_ENV=production exige APP_ENV=production.');

  const host = hostDeUrl(env.DATABASE_URL);
  const permitido = (env.DB_HOST_PERMITIDO || '').trim();
  if (appEnv === 'development') {
    if (!permitido) errores.push('Con APP_ENV=development debes definir DB_HOST_PERMITIDO (host de tu rama dev).');
    else if (!mismoHost(host, permitido))
      errores.push(`Con APP_ENV=development, el host de DATABASE_URL ("${host}") debe coincidir con DB_HOST_PERMITIDO ("${permitido}").`);
  } else if (permitido && mismoHost(host, permitido)) {
    errores.push('APP_ENV=production pero DATABASE_URL apunta al host de desarrollo (DB_HOST_PERMITIDO). Revisa las variables en Render.');
  }
  return errores;
}

// ---------------------------------------------------------------------------------------------
// Excepción controlada (script de emergencia admin:reset-2fa, Fase 3): apuntar a producción
// solo con --produccion, con la cadena tomada de una variable del COMANDO (no del .env)
// y confirmando el host escrito a mano.
// ---------------------------------------------------------------------------------------------

/** Nombre de la variable que el comando debe traer cuando se usa --produccion. */
export const VAR_URL_PRODUCCION = 'DAI_PROD_DATABASE_URL';

/**
 * Obtiene la cadena de producción para un script de emergencia.
 * @param {Record<string,string|undefined>} envComando variables del proceso SIN las que cargó dotenv
 * @param {Set<string>} clavesDelDotenv claves que vinieron del archivo .env (se rechazan)
 */
export function conexionProduccionDesdeComando(envComando, clavesDelDotenv = new Set()) {
  if (clavesDelDotenv.has(VAR_URL_PRODUCCION))
    throw new ErrorEntorno(`${VAR_URL_PRODUCCION} no puede venir del archivo .env; pásala solo en el comando.`);
  const url = envComando[VAR_URL_PRODUCCION];
  const host = hostDeUrl(url);
  if (!host) throw new ErrorEntorno(`Con --produccion debes pasar ${VAR_URL_PRODUCCION} en el mismo comando.`);
  return { url, host };
}

/** El usuario debe escribir el host EXACTO (se ignoran espacios y mayúsculas). */
export const confirmacionHostValida = (escrito, host) =>
  typeof escrito === 'string' && escrito.trim().toLowerCase() === String(host).toLowerCase();
