// Datos de DEMOSTRACIÓN: reproducen lo que el front tenía "quemado" en cada pantalla.
// Contraseña de todos los usuarios demo: Dai2024!   |   Código 2FA (dev): MFA_DEV_CODE del .env
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ago = (min) => new Date(Date.now() - min * 60_000);
const MB = 1024 * 1024;
const DEMO_PASSWORD = 'Dai2024!';

export async function seed(db) {
  const idOf = async (table, col, val) =>
    val == null ? null : (await db.query(`SELECT id FROM ${table} WHERE ${col} = $1`, [val])).rows[0]?.id ?? null;

  // ---------------- Usuarios ----------------
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const usuarios = [
    ['Dra. Elena Ramos',   'e.ramos@dai.corp',   'bg-blue-100 text-blue-700',     'Operaciones TI & Ciberseguridad', 'super-admin',  'Nivel 5 Secreto',      'FIDO2 Yubikey',        ago(4)],
    ['Lic. Mateo Valdés',  'm.valdes@dai.corp',  'bg-indigo-100 text-indigo-700', 'Dirección Jurídica & Compliance', 'compliance',   'Nivel 3 Alto',         'TOTP 2 Dispositivos',  ago(200)],
    ['Ing. Carlos Méndez', 'c.mendez@dai.corp',  'bg-purple-100 text-purple-700', 'Digitalización & Archivo Central','ocr-operator', 'Nivel 2 Auditoría',    'Push OTP Dispositivo', ago(280)],
    ['Lic. Sofía Restrepo','s.restrepo@dai.corp','bg-rose-100 text-rose-700',     'Tesorería & Finanzas Públicas',   'read-only',    'Nivel 3 Restringido',  'SMS Backup',           new Date('2024-10-12T10:00:00Z')],
    ['Mtro. Fernando Vega','f.vega@dai.corp',    'bg-amber-100 text-amber-700',   'Gestión del Talento Humano',      'read-only',    'Nivel 2 Confidencial', 'eOTP CorpID',          new Date('2024-10-14T10:00:00Z')],
  ];
  const uid = {};
  for (const [nombre, email, avatar, dep, rol, nivel, mfa, acceso] of usuarios) {
    const r = await db.query(
      `INSERT INTO usuarios (nombre,email,password_hash,avatar_clase,departamento_id,rol_id,nivel_id,mfa_metodo,ultimo_acceso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [nombre, email, hash, avatar, await idOf('departamentos', 'nombre', dep),
       await idOf('roles', 'clave', rol), await idOf('niveles_acceso', 'nombre', nivel), mfa, acceso]);
    uid[email] = r.rows[0].id;
  }
  const elena = uid['e.ramos@dai.corp'];

  // ---------------- Documentos ----------------
  const docs = [
    { nombre: 'Contrato_Marco_Servicios_2025.pdf', folio: 'EXP-2024-LE-089', formato: 'pdf', version: 'v3.2', dep: 'Legal',
      tipo: 'Contratos y Convenios', clasif: 'Secreto Corporativo', autor: 'Dra. Elena Ramos', autorEmail: 'e.ramos@dai.corp',
      ruta: '/Legal/Contratos/Proveedores/Cloud/', mb: 4.2, paginas: 18, ocr: true, firmadoPor: 'Dra. Elena Ramos', firmaValida: true,
      retencion: 10, vence: '2035-01-15', limite: null, tags: ['Contratos', 'Servicios Cloud'],
      creado: new Date('2025-01-15T09:42:00Z'), actualizado: ago(12),
      textos: [
        [1, 'Encabezado', 'CONTRATO MARCO DE SERVICIOS CLOUD. En la ciudad de Madrid, a 15 de enero de 2025, comparecen de una parte el Proveedor de Infraestructura Digital y de otra el Cliente institucional, debidamente conforme al expediente EXP-2024-LE-089.'],
        [2, 'Cláusula 1.1', 'CLÁUSULA 1.1 MARCO DEL SERVICIO Y GOBERNANZA CLOUD. El presente acuerdo obliga a la provisión, auditoría continua y salvaguarda de repositorios heterogéneos bajo normativas europeas ISO 27001 y el Reglamento General de Protección de Datos (GDPR). Todas las operaciones de transformación documental u OCR se ejecutan dentro del cifrado activo AES-256.'],
      ] },
    { nombre: 'Contrato_Prestacion_Servicios_Tecnologicos_2024.pdf', folio: 'EXP-2024-LE-889', formato: 'pdf', version: 'v2.4', dep: 'Legal',
      tipo: 'Contratos y Convenios', clasif: 'Secreto Corporativo', autor: 'Lic. Mateo Salinas', autorEmail: 'msalinas@dai.corp',
      responsable: 'Asesoría Jurídica Global', extra: 'Vigencia: 2029', ruta: '/Legal/Contratos/Proveedores/Cloud/',
      mb: 4.8, paginas: 40, ocr: true, retencion: 10, vence: '2034-10-14', limite: null, tags: ['Contratos'],
      creado: new Date('2024-09-02T15:00:00Z'), actualizado: new Date('2024-10-14T15:00:00Z'),
      textos: [[14, 'Párrafo 3', 'Conforme a lo estipulado en el punto 8.2, cualquier custodio de información sensible, código fuente y estructuras operacionales queda sujeto a la cláusula de confidencialidad y no divulgación por un plazo ininterrumpido de 10 años, prohibiendo toda reproducción o difusión no autorizada a terceros ajenos a la firma.']] },
    { nombre: 'Auditoria_Financiera_Consolidada_Q3.xlsx', folio: 'EXP-2024-FN-412', formato: 'xlsx', version: 'v3.1', dep: 'Finanzas',
      tipo: 'Informes de Auditoría', clasif: 'Confidencial Nivel 2', autor: 'MSc. Andrea Cárdenas', autorEmail: 'acardenas@dai.corp',
      ruta: '/Finanzas/Auditoria/2024/', mb: 12.2, paginas: 12, ocr: false, retencion: 7, vence: '2031-10-01', limite: '2024-09-30', tags: ['Auditoría'],
      creado: new Date('2024-10-01T12:00:00Z'), actualizado: ago(60 * 26),
      textos: [[1, 'Resumen', 'Informe de auditoría financiera consolidada del tercer trimestre. Se verificaron saldos, conciliaciones bancarias y cumplimiento de la norma ISO 27001 en los controles de acceso a tesorería.']] },
    { nombre: 'Expediente_Laboral_Personal_Clave.pdf', folio: 'EXP-2024-RH-014', formato: 'pdf', version: 'v1.0', dep: 'Talento & RH',
      tipo: null, clasif: 'Confidencial Nivel 2', autor: 'Dra. Elena Ramos', autorEmail: 'e.ramos@dai.corp',
      ruta: '/RH/Expedientes/', mb: 1.1, paginas: 22, ocr: true, retencion: 20, vence: '2044-05-01', limite: '2024-10-01', tags: ['Personal'],
      creado: new Date('2024-05-01T09:00:00Z'), actualizado: ago(40),
      textos: [[1, 'Portada', 'Expediente laboral de personal clave. Contiene datos personales sujetos a la cláusula de confidencialidad y no divulgación del reglamento interno.']] },
    { nombre: 'Acta_Constitutiva_Certificada_Notario.pdf', folio: 'EXP-2023-LE-001', formato: 'tiff', version: 'v1.2', dep: 'Legal',
      tipo: 'Actas de Directorio', clasif: 'Confidencial Nivel 2', autor: 'Notaría No. 44 CDMX', autorEmail: 'certificados@not44.mx',
      origen: 'TIFF/OCR Indexado', ruta: '/Legal/Actas/', mb: 18.4, paginas: 30, ocr: true, hashNull: true, retencion: 99, vence: null, limite: null, tags: ['Actas'],
      creado: new Date('2023-02-10T09:00:00Z'), actualizado: ago(60 * 24 * 40),
      textos: [[1, 'Acta', 'Acta constitutiva certificada ante notario. Se protocoliza la constitución de la sociedad y la designación del Consejo de Administración.']] },
    { nombre: 'Politica_Operaciones_Continuidad_Negocio.docx', folio: 'EXP-2024-OP-118', formato: 'docx', version: 'v4.8', dep: 'Operaciones',
      tipo: null, clasif: 'Uso Interno General', autor: 'Ing. Javier Solís', autorEmail: 'jsolis@dai.corp',
      ruta: '/Operaciones/Politicas/', mb: 0.82, paginas: 14, ocr: false, retencion: 5, vence: '2029-06-01', limite: null, tags: ['Políticas'],
      creado: new Date('2024-06-01T09:00:00Z'), actualizado: ago(60 * 24 * 12),
      textos: [[1, 'Alcance', 'Política de operaciones y continuidad del negocio. Define los planes de recuperación ante desastres y los tiempos máximos de interrupción tolerable.']] },
    { nombre: 'Comprobante_Fiscal_Auditoria_Fisica_004.tiff', folio: 'EXP-2024-FN-499', formato: 'tiff', version: 'v1.0', dep: 'Finanzas',
      tipo: 'Facturas y Comprobantes', clasif: 'Confidencial Nivel 2', autor: 'Auditoría Externa KPMG', autorEmail: 'audit_kpmg@dai.corp',
      origen: 'Captura Dispositivo Industrial', ruta: '/Finanzas/Comprobantes/', mb: 32.6, paginas: 1, ocr: true, hashNull: true, retencion: 7, vence: '2031-10-20', limite: null, tags: ['Fiscal'],
      creado: new Date('2024-10-20T09:00:00Z'), actualizado: ago(60 * 24 * 3),
      textos: [[1, 'Comprobante', 'Comprobante fiscal digitalizado de auditoría física. Base imponible, impuestos retenidos y sello digital verificados.']] },
    { nombre: 'Acuerdo_Socios_Estatutos_Generales.pdf', folio: 'EXP-2023-SOB-0012', formato: 'pdf', version: 'v4.2', dep: 'Gobierno Corporativo',
      tipo: 'Actas de Directorio', clasif: 'Confidencial Nivel 2', autor: 'Secretaría de Junta General', autorEmail: null,
      responsable: 'Secretaría de Junta General', extra: 'Versión: v4.2 Aprobada', ruta: '/Gobierno_Corporativo/Estatutos/',
      mb: 6.3, paginas: 60, ocr: false, retencion: 99, vence: null, limite: null, tags: ['Estatutos'],
      creado: new Date('2023-02-22T09:00:00Z'), actualizado: new Date('2024-02-22T09:00:00Z'),
      textos: [[28, 'Cláusula Vigésima Cuarta (Penalidades)', 'La inobservancia de la obligación fijada para los miembros del Consejo facultará la exclusión societaria inmediata y, ante la cláusula de confidencialidad y no divulgación, la indemnización tasada por daños y perjuicios comerciales equivalente al 25% del capital aportado.']] },
    { nombre: 'Anexo_Seguridad_Informacion_GDPR.docx', folio: 'EXP-2024-CISO-1102', formato: 'docx', version: 'v1.0', dep: 'Auditoría',
      tipo: 'Anexos Técnicos & GDPR', clasif: 'Confidencial Nivel 2', autor: 'Oficina de Cumplimiento DPO', autorEmail: null,
      responsable: 'Auditor Líder: Oficina de Cumplimiento DPO', extra: 'Algoritmo: KMS Hardware HSM', ruta: '/Auditoria/Ciberseguridad/Politicas/',
      mb: 2.4, paginas: 16, ocr: false, retencion: 5, vence: '2029-01-03', limite: null, tags: ['GDPR', 'Ciberseguridad'],
      creado: new Date('2024-01-03T09:00:00Z'), actualizado: new Date('2024-01-03T09:00:00Z'),
      textos: [[4, 'Apartado Técnico 8.4 (Tratamiento de Datos)', 'En correspondencia con el RGPD / LOPDGDD, el encargado del tratamiento asume sin reservas la cláusula de confidencialidad y no divulgación de datos de categoría especial procesados en sus clusters de almacenamiento, exigiendo autenticación MFA y llaves FIPS 140-3.']] },
    { nombre: 'Dictamen_Auditoria_Q3_Tributaria.docx', folio: 'EXP-2024-AU-310', formato: 'docx', version: 'v1.1', dep: 'Auditoría',
      tipo: 'Informes de Auditoría', clasif: 'Confidencial Nivel 2', autor: 'Lic. Marcos Cano', autorEmail: 'mcano@dai.corp',
      ruta: '/Auditoria/Tributaria/', mb: 1.8, paginas: 9, ocr: false, retencion: 7, vence: '2031-10-05', limite: '2024-10-10', tags: ['Auditoría'],
      creado: new Date('2024-10-05T09:00:00Z'), actualizado: ago(34),
      textos: [[1, 'Dictamen', 'Dictamen de auditoría tributaria del tercer trimestre. No se identificaron desviaciones materiales en las declaraciones presentadas.']] },
    { nombre: 'Expediente_Catastral_Folio_2692.tiff', folio: 'EXP-2024-CA-2692', formato: 'tiff', version: 'v1.0', dep: 'Catastro',
      tipo: null, clasif: 'Uso Interno General', autor: 'Ing. Gabriela DAI', autorEmail: 'gdai@dai.corp',
      origen: 'Digitalización por lote', ruta: '/Catastro/', mb: 9.1, paginas: 5, ocr: true, hashNull: true, retencion: 99, vence: null, limite: '2024-09-15', tags: ['Catastro'],
      creado: new Date('2024-09-01T09:00:00Z'), actualizado: ago(60),
      textos: [[1, 'Folio', 'Expediente catastral folio 2692. Plano y colindancias del predio digitalizados a 400 DPI.']] },
    { nombre: 'Poliza_Seguro_Responsabilidad_Civil.pdf', folio: 'EXP-2024-RI-077', formato: 'pdf', version: 'v1.0', dep: 'Riesgos',
      tipo: null, clasif: 'Uso Interno General', autor: 'Auditoría Interna', autorEmail: null,
      ruta: '/Riesgos/Polizas/', mb: 1.1, paginas: 8, ocr: false, retencion: 10, vence: '2034-03-01', limite: '2024-08-30', tags: ['Seguros'],
      creado: new Date('2024-03-01T09:00:00Z'), actualizado: ago(180),
      textos: [[1, 'Condiciones', 'Póliza de seguro de responsabilidad civil. Cobertura por daños a terceros, límites asegurados y exclusiones generales.']] },
  ];

  const docId = {};
  for (const d of docs) {
    const bytes = Math.round(d.mb * MB);
    const r = await db.query(
      `INSERT INTO documentos (nombre,folio,formato,version_actual,departamento_id,tipo_id,clasificacion_id,autor_id,autor_nombre,autor_email,
         responsable,nota_extra,origen,ruta,tamano_bytes,paginas,hash_sha256,ocr_procesado,firmado_por,firma_valida,
         retencion_anios,vence_retencion,fecha_limite,storage_path,creado_en,actualizado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
      [d.nombre, d.folio, d.formato, d.version, await idOf('departamentos', 'nombre', d.dep), await idOf('tipos_documentales', 'nombre', d.tipo),
       await idOf('clasificaciones', 'nombre', d.clasif), uid[d.autorEmail] ?? null, d.autor, d.autorEmail ?? null,
       d.responsable ?? null, d.extra ?? null, d.origen ?? null, d.ruta, bytes, d.paginas, d.hashNull ? null : sha(d.nombre + d.version),
       d.ocr, d.firmadoPor ?? null, d.firmaValida ?? false, d.retencion ?? null, d.vence ?? null, d.limite ?? null,
       `demo/${d.folio}/${d.version}`, d.creado, d.actualizado]);
    const id = r.rows[0].id;
    docId[d.nombre] = id;

    await db.query(`INSERT INTO documento_versiones (documento_id,version,hash_sha256,tamano_bytes,storage_path,autor_id,comentario,creado_en)
                    VALUES ($1,$2,$3,$4,$5,$6,'Versión vigente',$7)`,
      [id, d.version, d.hashNull ? null : sha(d.nombre + d.version), bytes, `demo/${d.folio}/${d.version}`, uid[d.autorEmail] ?? null, d.actualizado]);
    for (const [pagina, seccion, texto] of d.textos)
      await db.query(`INSERT INTO documento_paginas (documento_id,pagina,seccion,texto,confianza) VALUES ($1,$2,$3,$4,98.9)`, [id, pagina, seccion, texto]);
    for (const tag of d.tags) {
      const t = await db.query(`INSERT INTO etiquetas (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`, [tag]);
      await db.query(`INSERT INTO documento_etiquetas VALUES ($1,$2)`, [id, t.rows[0].id]);
    }
  }

  // Versiones anteriores del contrato marco (para "Historial")
  const cm = docId['Contrato_Marco_Servicios_2025.pdf'];
  for (const [v, dias] of [['v3.1', 9], ['v3.0', 30]])
    await db.query(`INSERT INTO documento_versiones (documento_id,version,hash_sha256,tamano_bytes,autor_id,comentario,creado_en) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cm, v, sha('cm' + v), 4 * MB, elena, 'Ajuste de cláusulas', ago(60 * 24 * dias)]);

  // ---------------- Notificaciones (para cada usuario) ----------------
  const notifs = [
    ['version', 'border-l-blue-500', 'Cripto-firmado', 'bg-emerald-50 text-emerald-700', '📄',
      'Nueva versión v3.2 publicada en Contrato_Marco_Servicios_2025.pdf',
      'Dra. Elena Ramos ha cargado una versión actualizada con modificaciones en la cláusula de indemnización y reajuste de jurisdicción.',
      ['Asesoría Jurídica', 'SHA-256: 7f8a...9c2d (Verificado)', 'Tamaño: 4.2 MB'],
      [{ label: 'Ver Comparación de Cambios', style: 'border' }, { label: 'Descargar v3.2', style: 'solid' }], cm, 12],
    ['edicion', 'border-l-amber-500', 'Confidencialidad', 'bg-amber-50 text-amber-700', '🏷️',
      'Metadatos modificados en Expediente_Laboral_Personal_Clave.pdf',
      'Se actualizaron las directivas de seguridad; etiquetas de confidencialidad elevadas a "Nivel 3 - Acceso Restringido".',
      ['Modificado por: Lic. Marcos Cano', 'Registro de auditoría: #AUD-9921'],
      [{ label: 'Revisar Metadatos', style: 'border' }, { label: 'Aprobar Política', style: 'solid' }], docId['Expediente_Laboral_Personal_Clave.pdf'], 40],
    ['eliminado', 'border-l-red-500', 'ISO 27001 Sec. 8.3', 'bg-red-50 text-red-700', '🗑️',
      'Documento enviado a Papelera de Seguridad: Borrador_Presupuestario_2024_rev.docx',
      'Eliminado por usuario de rol temporal. El expediente permanecerá bloqueado en retención inmutable bajo custodia antes de cualquier purga.',
      ['IP de Origen: 192.168.10.45 (VLAN Finanzas)', 'Auto-purga programada: 14 Mayo 2025'],
      [{ label: 'Restaurar Documento', style: 'border' }, { label: 'Confirmar Purga Permanente (Requiere Admin)', style: 'danger' }], null, 120],
    ['seguridad', 'border-l-emerald-500', 'Cero Anomalías', 'bg-emerald-50 text-emerald-700', '✅',
      'Auditoría de Integridad Exitosa: 1,420 documentos verificados',
      'Ninguna firma criptográfica alterada. Cadena de custodia 100% íntegra con registros de sello de tiempo RFC 3161 revalidados en el repositorio institucional.',
      ['Proceso automatizado del sistema cron::daily_audit', 'Tiempo de barrido: 42 segundos'],
      [{ label: 'Descargar Certificado de Integridad', style: 'border' }, { label: 'Métricas de Validación', style: 'border' }], null, 360],
  ];
  for (const u of Object.values(uid))
    for (const [cat, borde, badge, badgeCl, icono, titulo, desc, meta, acciones, doc, min] of notifs)
      await db.query(
        `INSERT INTO notificaciones (usuario_id,categoria,borde_clase,badge,badge_clase,icono,titulo,descripcion,meta,acciones,documento_id,creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [u, cat, borde, badge, badgeCl, icono, titulo, desc, JSON.stringify(meta), JSON.stringify(acciones), doc, ago(min)]);

  // ---------------- Auditoría ----------------
  for (const [accion, min] of [['ver_documento', 5], ['descargar', 90], ['editar_version', 60 * 24 * 9]])
    await db.query(`INSERT INTO auditoria (usuario_id,documento_id,accion,ip,creado_en) VALUES ($1,$2,$3,'192.168.10.20',$4)`, [elena, cm, accion, ago(min)]);

  // ---------------- Cola OCR ----------------
  const cola = [
    ['FAC-2024-00892.tiff', 300, 2.4, 'en_foco'], ['ANEXO_TECNICO_02.pdf', 400, 4.1, 'en_espera'],
    ['PAGARE_0041.tiff', 300, 1.9, 'en_espera'], ['ACTA_JUNTA_2024_03.pdf', 300, 3.2, 'procesado'],
  ];
  for (const [n, dpi, mb, estado] of cola)
    await db.query(`INSERT INTO ocr_trabajos (usuario_id,nombre_archivo,canal,dpi,tamano_bytes,estado) VALUES ($1,$2,'scanner',$3,$4,$5)`,
      [uid['c.mendez@dai.corp'], n, dpi, Math.round(mb * MB), estado]);

  // ---------------- Búsquedas frecuentes ----------------
  const terminos = [['auditoría forense ISO 27001', 9], ['acuerdo accionistas cláusula 12', 7], ['declaración de conformidad RGPD', 5], ['pagarés no endosables 2023-2024', 3]];
  for (const [t, n] of terminos)
    for (let i = 0; i < n; i++) await db.query(`INSERT INTO busquedas (usuario_id,termino,resultados) VALUES ($1,$2,1)`, [elena, t]);

  console.log(`   ${usuarios.length} usuarios · ${docs.length} documentos · ${notifs.length * usuarios.length} notificaciones`);
  console.log(`   Login demo: e.ramos@dai.corp / ${DEMO_PASSWORD}  (2FA dev: MFA_DEV_CODE)`);
}
