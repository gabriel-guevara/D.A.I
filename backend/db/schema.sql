-- =====================================================================
-- DAI · Esquema PostgreSQL (14+)
-- Solo incluye lo que el front realmente usa (8 pantallas).
-- Se ejecuta con:  npm run db:setup   (¡borra y recrea el esquema public!)
-- El borrado (DROP SCHEMA public) lo hace db/setup.js tras verificar el entorno;
-- este archivo solo crea objetos, así las pruebas lo pueden cargar en un esquema temporal.
-- Las bases YA existentes no usan este archivo: se actualizan con src/migrate.js al arrancar la API.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- Control de migraciones (src/migrate.js) ----------
CREATE TABLE migraciones_aplicadas (
  nombre      text PRIMARY KEY,
  aplicada_en timestamptz NOT NULL DEFAULT now()
);

-- ---------- Catálogos (los *_clase son clases Tailwind que usa el front) ----------
CREATE TABLE roles (
  id          smallserial PRIMARY KEY,
  clave       text NOT NULL UNIQUE,            -- super-admin | compliance | ocr-operator | read-only
  nombre      text NOT NULL,
  etiqueta    text NOT NULL,                   -- badge de la tarjeta (ROOT LEVEL, BASE, ...)
  color_clase text NOT NULL,
  icono       text,
  descripcion text
);

CREATE TABLE niveles_acceso (
  id          smallserial PRIMARY KEY,
  nombre      text NOT NULL UNIQUE,            -- "Nivel 5 Secreto", "Nivel 3 Alto", ...
  rango       smallint NOT NULL,               -- 1..5, se compara con clasificaciones.nivel_minimo
  color_clase text NOT NULL
);

CREATE TABLE departamentos (
  id          smallserial PRIMARY KEY,
  nombre      text NOT NULL UNIQUE,
  color_clase text NOT NULL DEFAULT 'bg-slate-100 text-slate-600'
);

CREATE TABLE clasificaciones (
  id           smallserial PRIMARY KEY,
  nombre       text NOT NULL UNIQUE,
  nivel_minimo smallint NOT NULL,              -- rango mínimo del usuario para ver el documento
  punto_clase  text NOT NULL,                  -- bg-red-500 (filtro lateral)
  badge_clase  text NOT NULL                   -- bg-red-500 text-white (resultado)
);

CREATE TABLE tipos_documentales (
  id     smallserial PRIMARY KEY,
  nombre text NOT NULL UNIQUE
);

-- ---------- Usuarios ----------
CREATE TABLE usuarios (
  id               bigserial PRIMARY KEY,
  nombre           text NOT NULL,
  email            text NOT NULL,
  password_hash    text,                       -- NULL = invitado que aún no activa su cuenta
  avatar_clase     text NOT NULL DEFAULT 'bg-slate-100 text-slate-600',
  departamento_id  smallint REFERENCES departamentos(id),
  rol_id           smallint NOT NULL REFERENCES roles(id),
  nivel_id         smallint NOT NULL REFERENCES niveles_acceso(id),
  mfa_metodo       text NOT NULL DEFAULT 'TOTP',
  mfa_secreto      text,                       -- secreto TOTP CONFIRMADO, cifrado AES-256-GCM (v1:...). NULL = sin 2FA
  mfa_secreto_pendiente text,                  -- secreto recién generado (cifrado); no sirve hasta confirmarlo
  mfa_pendiente_en timestamptz,                -- el pendiente caduca a los 15 min
  mfa_activado_en  timestamptz,
  mfa_ultimo_paso  bigint,                     -- último paso TOTP aceptado (anti-reutilización de códigos)
  sesion_version   integer NOT NULL DEFAULT 0, -- +1 = se invalidan todas las sesiones abiertas
  password_cambiado_en timestamptz,
  activo           boolean NOT NULL DEFAULT true,
  ultimo_acceso    timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usuarios_email_uq ON usuarios (lower(email));

-- Códigos de recuperación 2FA: solo su huella HMAC-SHA256; cada uno sirve una vez.
CREATE TABLE mfa_codigos_recuperacion (
  id          bigserial PRIMARY KEY,
  usuario_id  bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  huella      char(64) NOT NULL,
  usado_en    timestamptz,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, huella)
);

-- Fallos de acceso por cuenta (contraseña por huella del correo, 2FA por id) y bloqueo temporal.
CREATE TABLE intentos_acceso (
  clave           text PRIMARY KEY,
  fallos          integer NOT NULL DEFAULT 0,
  ventana_inicio  timestamptz NOT NULL DEFAULT now(),
  bloqueado_hasta timestamptz
);

-- ---------- Carpetas (Fase 5): un solo nivel, solo organizan; NO cambian permisos ----------
CREATE TABLE carpetas (
  id             bigserial PRIMARY KEY,
  nombre         text NOT NULL,
  creado_por     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carpetas_nombre_check CHECK (char_length(nombre) BETWEEN 2 AND 80)
);
CREATE UNIQUE INDEX carpetas_nombre_uq ON carpetas (lower(nombre));   -- único sin distinguir mayúsculas

-- ---------- Documentos ----------
CREATE TABLE documentos (
  id               bigserial PRIMARY KEY,
  nombre           text NOT NULL,
  folio            text NOT NULL UNIQUE,       -- EXP-2024-LE-889
  formato          text NOT NULL CHECK (formato IN ('pdf','xlsx','docx','tiff')),
  version_actual   text NOT NULL DEFAULT 'v1.0',
  departamento_id  smallint REFERENCES departamentos(id),
  tipo_id          smallint REFERENCES tipos_documentales(id),
  clasificacion_id smallint NOT NULL REFERENCES clasificaciones(id),   -- obligatoria: define quién puede verlo
  autor_id         bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  autor_nombre     text NOT NULL,              -- también autores externos (notaría, KPMG...)
  autor_email      text,
  responsable      text,
  nota_extra       text,                       -- "Vigencia: 2029", "Versión: v4.2 Aprobada"
  origen           text,                       -- "Captura Dispositivo Industrial" (si no hay hash)
  ruta             text,                       -- /Legal/Contratos/Proveedores/Cloud/
  tamano_bytes     bigint NOT NULL DEFAULT 0,
  paginas          integer NOT NULL DEFAULT 1,
  hash_sha256      char(64),
  ocr_procesado    boolean NOT NULL DEFAULT false,
  cifrado_aes      boolean NOT NULL DEFAULT false, -- true solo si el archivo real está en R2 (cifrado en reposo AES-256)
  firmado_por      text,
  firma_valida     boolean NOT NULL DEFAULT false,
  retencion_anios  smallint,
  vence_retencion  date,
  fecha_limite     date,                       -- "Fuera de plazo" del dashboard
  estado           text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','papelera','purgado')),
  eliminado_en     timestamptz,
  eliminado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  storage_path     text,                       -- clave del objeto (docs/{doc}/{ver}/{uuid}.pdf), la genera el servidor
  tiene_archivo    boolean NOT NULL DEFAULT false, -- false: solo metadatos (seed, heredados); true: PDF real subido
  nombre_original  text,                       -- nombre del archivo que subió el usuario, saneado (solo para mostrar/descargar)
  storage_driver   text,                       -- 'local' | 'r2': dónde se guardó
  purgar_despues_de timestamptz,               -- papelera: desde cuándo se puede purgar automáticamente (NULL = nunca)
  purgado_en       timestamptz,                -- purga definitiva: la fila queda como "lápida" sin archivo ni texto
  purgado_por      bigint REFERENCES usuarios(id) ON DELETE SET NULL,  -- NULL = purga automática por retención
  carpeta_id       bigint REFERENCES carpetas(id) ON DELETE SET NULL,  -- NULL = "Sin carpeta"
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documentos_storage_driver_check CHECK (storage_driver IS NULL OR storage_driver IN ('local','r2')),
  CONSTRAINT documentos_archivo_completo_check CHECK (NOT tiene_archivo OR
    (storage_path IS NOT NULL AND storage_driver IS NOT NULL AND hash_sha256 IS NOT NULL AND nombre_original IS NOT NULL)),
  CONSTRAINT documentos_purgado_sin_archivo_check CHECK (estado <> 'purgado' OR (NOT tiene_archivo AND storage_path IS NULL))
);
CREATE INDEX documentos_estado_idx   ON documentos (estado, actualizado_en DESC);
CREATE INDEX documentos_papelera_idx ON documentos (purgar_despues_de) WHERE estado = 'papelera';
CREATE INDEX documentos_nombre_trgm  ON documentos USING gin (nombre gin_trgm_ops);
CREATE INDEX documentos_folio_trgm   ON documentos USING gin (folio gin_trgm_ops);
CREATE INDEX documentos_carpeta_idx  ON documentos (carpeta_id) WHERE carpeta_id IS NOT NULL;

-- Solicitudes de movimiento (Fase 5): el Oficial de Cumplimiento pide mover un documento con un motivo;
-- un Super Administrador u Operador OCR con nivel suficiente la aprueba (y se aplica) o la rechaza.
CREATE TABLE solicitudes_movimiento (
  id                 bigserial PRIMARY KEY,
  documento_id       bigint NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  carpeta_destino_id bigint REFERENCES carpetas(id) ON DELETE SET NULL,  -- NULL = sacarlo de su carpeta
  solicitante_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo             text NOT NULL,
  estado             text NOT NULL DEFAULT 'pendiente',
  resuelto_por       bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  resuelto_en        timestamptz,
  respuesta          text,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT solicitudes_movimiento_estado_check CHECK (estado IN ('pendiente','aprobada','rechazada'))
);
CREATE UNIQUE INDEX solicitudes_movimiento_pendiente_uq ON solicitudes_movimiento (documento_id) WHERE estado = 'pendiente';

CREATE TABLE documento_versiones (
  id           bigserial PRIMARY KEY,
  documento_id bigint NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  version      text NOT NULL,
  hash_sha256  char(64),
  tamano_bytes bigint,
  storage_path text,                          -- NULL: registro histórico sin original, o versión purgada
  storage_driver text,
  nombre_original text,                       -- nombre del archivo de ESTA versión (para restaurarla como actual)
  paginas      integer,
  autor_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  comentario   text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (documento_id, version),
  CONSTRAINT documento_versiones_storage_driver_check CHECK (storage_driver IS NULL OR storage_driver IN ('local','r2'))
);

-- Texto OCR por página: alimenta la Búsqueda Avanzada (full-text en español)
CREATE TABLE documento_paginas (
  documento_id bigint NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  pagina       integer NOT NULL,
  seccion      text,                           -- "Párrafo 3", "Cláusula Vigésima Cuarta"
  texto        text NOT NULL,
  confianza    numeric(4,1),
  origen       text NOT NULL DEFAULT 'demo',   -- 'pdf' extraído del archivo real | 'manual' (aprobación OCR) | 'demo' (seed)
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('spanish', texto)) STORED,
  PRIMARY KEY (documento_id, pagina),
  CONSTRAINT documento_paginas_origen_check CHECK (origen IN ('demo','pdf','manual'))
);
CREATE INDEX documento_paginas_tsv  ON documento_paginas USING gin (tsv);
CREATE INDEX documento_paginas_trgm ON documento_paginas USING gin (texto gin_trgm_ops);

-- Estado de la extracción de texto de cada documento CON archivo (cola persistente del indexador, src/lib/indexador.js)
CREATE TABLE documento_indexacion (
  documento_id      bigint PRIMARY KEY REFERENCES documentos(id) ON DELETE CASCADE,
  estado            text NOT NULL DEFAULT 'pendiente',  -- pendiente | procesando | procesado | sin_texto | error
  motivo            text NOT NULL DEFAULT 'backfill',   -- subida | reproceso | backfill | script | version | restaurar_version
  solicitado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  solicitado_en     timestamptz NOT NULL DEFAULT now(),
  intentos          smallint NOT NULL DEFAULT 0,
  iniciado_en       timestamptz,
  procesado_en      timestamptz,
  hash_sha256       char(64),                           -- huella del archivo cuyo texto se indexó
  paginas_totales   integer,
  paginas_con_texto integer,
  caracteres        integer,
  limite            text,                               -- límite alcanzado: paginas | caracteres | tiempo
  error_codigo      text,
  error             text,
  duracion_ms       integer,
  CONSTRAINT documento_indexacion_estado_check CHECK (estado IN ('pendiente','procesando','procesado','sin_texto','error')),
  CONSTRAINT documento_indexacion_motivo_check CHECK (motivo IN ('subida','reproceso','backfill','script','version','restaurar_version')),
  CONSTRAINT documento_indexacion_limite_check CHECK (limite IS NULL OR limite IN ('paginas','caracteres','tiempo'))
);
CREATE INDEX documento_indexacion_cola ON documento_indexacion (solicitado_en, documento_id) WHERE estado IN ('pendiente','procesando');

-- Cola persistente de objetos por borrar del almacenamiento (src/lib/papelera.js). Primero cambia la base y
-- después se borra el objeto: si el almacenamiento falla, la fila queda aquí y se reintenta (nunca un huérfano
-- "olvidado"). "subida_en_curso" registra la intención ANTES de subir: si el proceso muere a mitad, el objeto
-- que quedó sin documento se borra pasado el plazo (no_antes_de).
CREATE TABLE objetos_por_borrar (
  id             bigserial PRIMARY KEY,
  clave          text NOT NULL,
  storage_driver text NOT NULL,
  documento_id   bigint REFERENCES documentos(id) ON DELETE SET NULL,
  motivo         text NOT NULL,                       -- purga | subida_fallida | subida_en_curso
  no_antes_de    timestamptz NOT NULL DEFAULT now(),
  intentos       integer NOT NULL DEFAULT 0,
  ultimo_error   text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT objetos_por_borrar_driver_check CHECK (storage_driver IN ('local','r2')),
  CONSTRAINT objetos_por_borrar_motivo_check CHECK (motivo IN ('purga','subida_fallida','subida_en_curso'))
);
CREATE INDEX objetos_por_borrar_cola ON objetos_por_borrar (no_antes_de, id);

CREATE TABLE etiquetas (
  id     serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE
);
CREATE TABLE documento_etiquetas (
  documento_id bigint  NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  etiqueta_id  integer NOT NULL REFERENCES etiquetas(id) ON DELETE CASCADE,
  PRIMARY KEY (documento_id, etiqueta_id)
);

-- ---------- Notificaciones (una fila por usuario destino) ----------
CREATE TABLE notificaciones (
  id           bigserial PRIMARY KEY,
  usuario_id   bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  categoria    text NOT NULL CHECK (categoria IN ('edicion','version','eliminado','seguridad','consulta')),
  borde_clase  text NOT NULL,
  badge        text NOT NULL,
  badge_clase  text NOT NULL,
  icono        text,
  titulo       text NOT NULL,
  descripcion  text NOT NULL,
  meta         jsonb NOT NULL DEFAULT '[]',    -- ["Asesoría Jurídica", "Tamaño: 4.8 MB"]
  acciones     jsonb NOT NULL DEFAULT '[]',    -- [{"label":"...","style":"border|solid|danger"}]
  documento_id bigint REFERENCES documentos(id) ON DELETE SET NULL,
  leida        boolean NOT NULL DEFAULT false,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notificaciones_usuario_idx ON notificaciones (usuario_id, leida, creado_en DESC);

-- ---------- Auditoría ("Historial de Auditoría") ----------
CREATE TABLE auditoria (
  id           bigserial PRIMARY KEY,
  usuario_id   bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  documento_id bigint REFERENCES documentos(id) ON DELETE SET NULL,
  accion       text NOT NULL,                  -- login, ver_documento, eliminar, aprobar_ocr...
  ip           text,
  detalle      jsonb NOT NULL DEFAULT '{}',
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_doc_idx ON auditoria (documento_id, creado_en DESC);

-- ---------- Digitalización OCR ----------
CREATE TABLE ocr_trabajos (
  id               bigserial PRIMARY KEY,
  usuario_id       bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  nombre_archivo   text NOT NULL,
  canal            text NOT NULL DEFAULT 'file' CHECK (canal IN ('scanner','file')),
  papel            text NOT NULL DEFAULT 'A4',
  dpi              integer NOT NULL DEFAULT 300,
  tamano_bytes     bigint NOT NULL DEFAULT 0,
  preprocesamiento jsonb NOT NULL DEFAULT '{"deskew":true,"denoise":true,"binarization":true,"orientation":false}',
  estado           text NOT NULL DEFAULT 'en_espera' CHECK (estado IN ('en_espera','en_foco','procesado')),
  texto_raw        text,
  campos           jsonb,                      -- campos estructurados extraídos
  confianza        numeric(4,1),
  documento_id     bigint REFERENCES documentos(id) ON DELETE SET NULL,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  aprobado_en      timestamptz
);

-- ---------- Búsquedas (alimenta "términos frecuentes") ----------
CREATE TABLE busquedas (
  id         bigserial PRIMARY KEY,
  usuario_id bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  termino    text NOT NULL,
  algoritmo  text NOT NULL DEFAULT 'semantica',
  resultados integer NOT NULL DEFAULT 0,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Configuración ----------
CREATE TABLE configuracion (
  clave text PRIMARY KEY,
  valor text NOT NULL
);

-- ---------- Trigger: actualizado_en ----------
-- Mover de carpeta no cuenta como modificación: con SET LOCAL dai.conservar_actualizado = 'on' no se toca.
CREATE FUNCTION set_actualizado_en() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('dai.conservar_actualizado', true), '') = 'on' THEN RETURN NEW; END IF;
  NEW.actualizado_en = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_actualizado BEFORE UPDATE ON documentos
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();

-- =====================================================================
-- Datos de catálogo (necesarios para que el front funcione)
-- =====================================================================
INSERT INTO roles (clave, nombre, etiqueta, color_clase, icono, descripcion) VALUES
 ('super-admin','Super Administrador','ROOT LEVEL','bg-red-50 text-red-700','🛡️','Acceso irrestricto a auditoría interna, tesorería y control de bóveda de llaves AES-256.'),
 ('compliance','Oficial Cumplimiento','CUMPLIMIENTO','bg-blue-50 text-blue-700','✅','Inspección forense de todos los reportes SAR/CTR, expedientes en auditoría y reportes legales.'),
 ('ocr-operator','Operador OCR / Ingesta','AVANZADO','bg-purple-50 text-purple-700','🖨️','Digitalización por lote, validación de conformidad de lectura y extracción de metadatos.'),
 ('read-only','Lector Restringido','BASE','bg-slate-100 text-slate-600','👁️','Consulta de solo lectura sobre expedientes bajo directorio y nivel de control asignado.');

INSERT INTO niveles_acceso (nombre, rango, color_clase) VALUES
 ('Nivel 5 Secreto',5,'bg-red-50 text-red-700'),
 ('Nivel 3 Alto',3,'bg-amber-50 text-amber-700'),
 ('Nivel 3 Restringido',3,'bg-amber-50 text-amber-700'),
 ('Nivel 2 Auditoría',2,'bg-emerald-50 text-emerald-700'),
 ('Nivel 2 Confidencial',2,'bg-blue-50 text-blue-700');

INSERT INTO departamentos (nombre, color_clase) VALUES
 ('Legal','bg-blue-50 text-blue-700'),
 ('Finanzas','bg-emerald-50 text-emerald-700'),
 ('Talento & RH','bg-purple-50 text-purple-700'),
 ('Operaciones','bg-amber-50 text-amber-700'),
 ('Auditoría','bg-purple-50 text-purple-700'),
 ('Catastro','bg-amber-50 text-amber-700'),
 ('Riesgos','bg-rose-50 text-rose-700'),
 ('Gobierno Corporativo','bg-indigo-50 text-indigo-700'),
 ('Operaciones TI & Ciberseguridad','bg-slate-100 text-slate-600'),
 ('Dirección Jurídica & Compliance','bg-slate-100 text-slate-600'),
 ('Digitalización & Archivo Central','bg-slate-100 text-slate-600'),
 ('Tesorería & Finanzas Públicas','bg-slate-100 text-slate-600'),
 ('Gestión del Talento Humano','bg-slate-100 text-slate-600');

INSERT INTO clasificaciones (nombre, nivel_minimo, punto_clase, badge_clase) VALUES
 ('Secreto Corporativo',5,'bg-red-500','bg-red-500 text-white'),
 ('Confidencial Nivel 2',2,'bg-amber-500','bg-amber-500 text-white'),
 ('Uso Interno General',1,'bg-slate-400','bg-slate-400 text-white');

INSERT INTO tipos_documentales (nombre) VALUES
 ('Contratos y Convenios'),('Actas de Directorio'),('Anexos Técnicos & GDPR'),
 ('Facturas y Comprobantes'),('Informes de Auditoría');

INSERT INTO configuracion (clave, valor) VALUES ('cuota_bytes','5497558138880');  -- 5 TB
