/**
 * Construye la app de Express SIN ponerla a escuchar. server.js la arranca; las pruebas la levantan en un
 * puerto aleatorio contra su esquema temporal. Así se prueba exactamente el mismo código que corre en Render.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { query } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { ErrorObjetoNoEncontrado } from './lib/storage.js';
import auth from './routes/auth.js';
import catalogos from './routes/catalogos.js';
import dashboard from './routes/dashboard.js';
import documentos from './routes/documentos.js';
import busqueda from './routes/busqueda.js';
import notificaciones from './routes/notificaciones.js';
import seguridad from './routes/seguridad.js';
import digitalizacion from './routes/digitalizacion.js';

export function crearApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', async (_req, res) => {
    await query('SELECT 1');
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
    // Un objeto que falta en el almacenamiento es un 404 claro, nunca un 500 (red de seguridad: las rutas ya lo tratan).
    if (err instanceof ErrorObjetoNoEncontrado) {
      if (res.headersSent) return res.destroy();
      return res.status(404).json({ error: err.message, codigo: 'no_disponible' });
    }
    console.error(err);
    if (res.headersSent) return res.destroy(); // a mitad de enviar un archivo: se corta la conexión
    res.status(500).json({ error: config.isProd ? 'Error interno del servidor' : err.message });
  });

  return app;
}
