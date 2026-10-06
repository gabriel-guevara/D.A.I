import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { aplicarMigraciones } from './migrate.js';
import auth from './routes/auth.js';
import catalogos from './routes/catalogos.js';
import dashboard from './routes/dashboard.js';
import documentos from './routes/documentos.js';
import busqueda from './routes/busqueda.js';
import notificaciones from './routes/notificaciones.js';
import seguridad from './routes/seguridad.js';
import digitalizacion from './routes/digitalizacion.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/auth', auth);                       // público (login + 2FA); /me protegido dentro
app.use('/api', requireAuth);                     // todo lo que sigue exige sesión
app.use('/api/catalogos', catalogos);
app.use('/api/dashboard', dashboard);
app.use('/api/documentos', documentos);
app.use('/api/busqueda', busqueda);
app.use('/api/notificaciones', notificaciones);
app.use('/api/seguridad', seguridad);
app.use('/api/digitalizacion', digitalizacion);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Express 5 envía aquí los errores de handlers async
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: config.isProd ? 'Error interno del servidor' : err.message });
});

// Actualiza el esquema si hace falta (idempotente). Si falla, la API arranca igual y lo deja en el log.
await aplicarMigraciones().catch((e) => console.error('Migración no aplicada:', e.message));

app.listen(config.port, () => console.log(`API DAI escuchando en http://localhost:${config.port}`));
