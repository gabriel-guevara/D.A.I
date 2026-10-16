import { config } from './config.js';
import { pool } from './db.js';
import { aplicarMigraciones } from './migrate.js';
import { inicializarAlmacenamiento } from './lib/storage.js';
import { crearApp } from './app.js';

// Antes de aceptar peticiones: almacenamiento configurado y esquema al día. Si algo falla, la API NO
// arranca: es preferible a servir con columnas que faltan o escribir archivos en el sitio equivocado.
try {
  const st = await inicializarAlmacenamiento(config.storage);
  console.log(`Almacenamiento: ${st.driver}${st.bucket ? ` (bucket ${st.bucket})` : ''} · APP_ENV=${config.appEnv}`);
  await aplicarMigraciones(pool);
} catch (e) {
  console.error('✖ La API no puede arrancar:', e.message);
  process.exit(1);
}

crearApp().listen(config.port, () => console.log(`API DAI escuchando en http://localhost:${config.port}`));
