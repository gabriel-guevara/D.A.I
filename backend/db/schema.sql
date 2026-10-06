-- =====================================================================
-- DAI · Esquema PostgreSQL (14+)
-- Solo incluye lo que el front realmente usa (8 pantallas).
-- Se ejecuta con:  npm run db:setup   (¡borra y recrea el esquema public!)
-- =====================================================================
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
  mfa_secreto      text,                       -- secreto TOTP base32 (cifrarlo en producción)
  activo           boolean NOT NULL DEFAULT true,
  ultimo_acceso    timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usuarios_email_uq ON usuarios (lower(email));

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
  cifrado_aes      boolean NOT NULL DEFAULT true,
  firmado_por      text,
  firma_valida     boolean NOT NULL DEFAULT false,
  retencion_anios  smallint,
  vence_retencion  date,
  fecha_limite     date,                       -- "Fuera de plazo" del dashboard
  estado           text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','papelera','purgado')),
  eliminado_en     timestamptz,
  eliminado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  storage_path     text,                       -- clave del archivo físico (disco, S3, ...)
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documentos_estado_idx   ON documentos (estado, actualizado_en DESC);
CREATE INDEX documentos_nombre_trgm  ON documentos USING gin (nombre gin_trgm_ops);
CREATE INDEX documentos_folio_trgm   ON documentos USING gin (folio gin_trgm_ops);

CREATE TABLE documento_versiones (
  id           bigserial PRIMARY KEY,
  documento_id bigint NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  version      text NOT NULL,
  hash_sha256  char(64),
  tamano_bytes bigint,
  storage_path text,
  autor_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  comentario   text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (documento_id, version)
);

-- Texto OCR por página: alimenta la Búsqueda Avanzada (full-text en español)
CREATE TABLE documento_paginas (
  documento_id bigint NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  pagina       integer NOT NULL,
  seccion      text,                           -- "Párrafo 3", "Cláusula Vigésima Cuarta"
  texto        text NOT NULL,
  confianza    numeric(4,1),
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('spanish', texto)) STORED,
  PRIMARY KEY (documento_id, pagina)
);
CREATE INDEX documento_paginas_tsv  ON documento_paginas USING gin (tsv);
CREATE INDEX documento_paginas_trgm ON documento_paginas USING gin (texto gin_trgm_ops);

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
  categoria    text NOT NULL CHECK (categoria IN ('edicion','version','eliminado','seguridad')),
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
CREATE FUNCTION set_actualizado_en() RETURNS trigger AS $$
BEGIN NEW.actualizado_en = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

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
