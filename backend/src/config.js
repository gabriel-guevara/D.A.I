import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_SECRET'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Falta la variable de entorno ${k}. Copia .env.example a .env.`);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET debe tener al menos 32 caracteres en producción.');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  isProd: process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  mfaDevCode: process.env.MFA_DEV_CODE || null,
};
