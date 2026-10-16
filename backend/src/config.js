import 'dotenv/config';
import { erroresEntornoApi } from './lib/entorno.js';
import { configAlmacenamientoDesdeEnv } from './lib/storage.js';

/**
 * Valida TODAS las variables al arrancar y, si algo falla, muestra la lista completa de problemas y
 * se niega a arrancar. Es mejor que la API no levante a que levante "a medias" contra datos equivocados.
 */
const errores = [];
for (const k of ['DATABASE_URL', 'JWT_SECRET'])
  if (!process.env[k]) errores.push(`Falta la variable de entorno ${k}. Copia .env.example a .env.`);
if (process.env.NODE_ENV === 'production' && (process.env.JWT_SECRET?.length ?? 0) < 32)
  errores.push('JWT_SECRET debe tener al menos 32 caracteres en producción.');

errores.push(...erroresEntornoApi(process.env));

let storage = null;
try {
  storage = configAlmacenamientoDesdeEnv(process.env);
} catch (e) {
  errores.push(e.message);
}

const maxUploadMb = process.env.MAX_UPLOAD_MB === undefined || process.env.MAX_UPLOAD_MB === '' ? 20 : Number(process.env.MAX_UPLOAD_MB);
// Tope de 100 MB: Render (plan gratuito) tiene poca memoria y los PDF de un archivo documental rara vez lo superan.
if (!Number.isInteger(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > 100)
  errores.push('MAX_UPLOAD_MB debe ser un entero entre 1 y 100 (por defecto 20).');

if (errores.length) {
  console.error(`✖ La API no puede arrancar:\n  - ${errores.join('\n  - ')}`);
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  isProd: process.env.NODE_ENV === 'production',
  appEnv: process.env.APP_ENV,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  mfaDevCode: process.env.MFA_DEV_CODE || null,
  storage,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
};
