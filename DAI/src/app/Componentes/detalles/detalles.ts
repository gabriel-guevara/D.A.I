import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService, EstadoIndexacion, EstadoTexto, ResultadoIntegridad, leerErrorApi } from '../../shared/api';
import { UrlPdf, guardarComo, paginaDeConsulta } from '../../shared/archivo-pdf';
import { VersionParaVer, VersionesDocumento } from './versiones-documento';

/** Qué muestra el visor. "sin_archivo": solo metadatos (seed/heredados) → capa de texto. */
type EstadoVisor = 'cargando' | 'listo' | 'sin_archivo' | 'no_disponible' | 'error';

interface ArchivoInfo {
  nombreOriginal: string;
  tamanoBytes: number;
  almacenamiento: 'local' | 'r2';
  cifradoEnReposo: boolean;
}

interface PaginaTexto {
  pagina: number;
  totalPaginas: number;
  seccion: string | null;
  texto: string;
  confianza: number | null;
  origen?: 'pdf' | 'manual' | 'demo';
}

interface DocDetalle {
  id: string;
  nombre: string;
  version: string;
  folio: string;
  departamento: string | null;
  clasificacion: string | null;
  hash: string | null;
  autorLinea: string;
  fechaCreacion: string;
  tamano: string;
  paginas: number;
  etiquetas: string[];
  retencion: string | null;
  carpeta?: { id: string; nombre: string } | null;
  tieneArchivo: boolean;
  archivo: ArchivoInfo | null;
  puedeVerificar: boolean;
  ultimaVerificacion: { resultado: 'integro' | 'alterado' | 'no_disponible'; fecha: string } | null;
  /** null = sin archivo: su texto es de demostración (seed) o heredado, no extraído de un PDF. */
  indexacion?: EstadoIndexacion | null;
  textoOrigen?: 'pdf' | 'demo';
  puedeReindexar?: boolean;
  /** Fase 4: subir/restaurar versiones (Super Administrador y Operador OCR) y enviar a la papelera (Admin y Cumplimiento). */
  puedeGestionarVersiones?: boolean;
  puedeEliminar?: boolean;
}

/** Mientras el texto está en cola o extrayéndose se consulta su estado: cada 4 s, como mucho 5 minutos. */
const INTERVALO_SONDEO_MS = 4000;
const MAX_SONDEOS = 75;

const CLASES_ESTADO_TEXTO: Record<EstadoTexto, string> = {
  pendiente: 'bg-slate-100 text-slate-600',
  procesando: 'bg-blue-50 text-blue-700',
  procesado: 'bg-emerald-50 text-emerald-700',
  sin_texto: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
};

interface RegistroAuditoria {
  id: string;
  accion: string;
  usuario: string;
  ip: string | null;
  cuando: string;
  fecha: string;
}

const ETIQUETAS_ACCION: Record<string, string> = {
  login: 'Inicio de sesión',
  ver_documento: 'Consulta del documento',
  descargar: 'Descarga del original',
  ver_archivo: 'Visualización del original',
  subir_documento: 'Carga del original',
  verificar_integridad: 'Verificación de integridad',
  editar_version: 'Edición de versión',
  eliminar: 'Envío a la papelera',
  restaurar_documento: 'Restaurado desde la papelera',
  purgar_documento: 'Purga definitiva',
  borrar_objeto: 'Borrado del archivo en el almacenamiento (sistema)',
  subir_version: 'Nueva versión subida',
  restaurar_version: 'Versión anterior restaurada como actual',
  aprobar_ocr: 'Aprobación e indexación OCR',
  indexar_texto: 'Extracción del texto para búsqueda (sistema)',
  reindexar_texto: 'Reproceso del texto solicitado',
  invitar_usuario: 'Invitación de usuario',
  mover_documento: 'Movido de carpeta',
  solicitar_movimiento: 'Movimiento de carpeta solicitado',
  aprobar_movimiento: 'Solicitud de movimiento aprobada',
  rechazar_movimiento: 'Solicitud de movimiento rechazada',
};

@Component({
  selector: 'app-document-detail',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar, VersionesDocumento],
  templateUrl: './detalles.html',
})
export class detalles {
  documentId = signal<string | null>(null);
  doc = signal<DocDetalle | null>(null);
  error = signal('');
  currentPage = signal(1);
  totalPages = signal(18);
  zoom = signal(100);

  // Visor del PDF real
  visor = signal<EstadoVisor>('cargando');
  pdfUrl = signal<SafeResourceUrl | null>(null);
  private pdf = new UrlPdf(inject(DomSanitizer));

  /** Página de la coincidencia cuando se llega desde la búsqueda (?pagina=N). */
  paginaObjetivo = signal<number | null>(null);

  // Estado de la extracción de texto y reproceso
  indexacion = signal<EstadoIndexacion | null>(null);
  sondeoAgotado = signal(false);
  reindexando = signal(false);
  reindexarError = signal('');
  private sondeo: ReturnType<typeof setTimeout> | null = null;
  private sondeos = 0;

  // Capa de texto (documentos sin archivo)
  paginaTexto = signal<PaginaTexto | null>(null);
  paginaTextoError = signal('');

  // Descarga e integridad
  descargando = signal(false);
  descargaError = signal('');
  verificando = signal(false);
  verificacion = signal<ResultadoIntegridad | null>(null);
  verificacionError = signal('');

  /** Texto honesto del cifrado: solo hay cifrado en reposo si el archivo real está en R2. */
  etiquetaCifrado = computed(() => {
    const d = this.doc();
    if (!d) return null;
    if (d.archivo?.cifradoEnReposo) return 'Cifrado en reposo AES-256 (gestionado por Cloudflare R2)';
    if (d.archivo) return 'Almacenamiento local de desarrollo (sin cifrado en reposo)';
    return null;
  });

  /** Versión que se está viendo en el visor cuando NO es la actual (desde el historial de versiones). */
  versionViendo = signal<string | null>(null);

  // Enviar a la papelera
  confirmandoEliminar = signal(false);
  eliminando = signal(false);
  eliminarError = signal('');

  // Panel "Historial de Auditoría"
  auditOpen = signal(false);
  auditLoading = signal(false);
  auditError = signal('');
  auditRows = signal<RegistroAuditoria[]>([]);

  constructor(private route: ActivatedRoute, private router: Router, private api: ApiService) {
    // El object URL vive mientras el componente exista; al salir se libera la memoria del PDF.
    inject(DestroyRef).onDestroy(() => {
      this.pdf.revocar();
      this.detenerSondeo();
    });

    const id = this.route.snapshot.paramMap.get('id');
    this.documentId.set(id);
    this.paginaObjetivo.set(paginaDeConsulta(this.route.snapshot.queryParamMap?.get('pagina') ?? null));
    if (id) this.cargarDocumento(id);
  }

  /** Carga (o recarga, tras subir o restaurar una versión) el detalle y el visor. */
  cargarDocumento(id: string): void {
    this.api.documento<DocDetalle>(id).subscribe({
      next: (d) => {
        this.doc.set(d);
        this.totalPages.set(d.paginas);
        this.indexacion.set(d.indexacion ?? null);
        this.sondeos = 0;
        this.sondeoAgotado.set(false);
        this.vigilarIndexacion();
        if (d.tieneArchivo) this.cargarPdf(id);
        else {
          this.visor.set('sin_archivo');
          // Desde la búsqueda: abrir la capa de texto en la página de la coincidencia.
          const objetivo = this.paginaObjetivo();
          if (objetivo) this.currentPage.set(Math.min(objetivo, Math.max(d.paginas, 1)));
          this.cargarTexto();
        }
      },
      error: (err) => {
        this.visor.set('error');
        this.error.set(err.status === 404 ? 'Documento no encontrado o sin permisos de acceso.' : 'No se pudo cargar el documento.');
      },
    });
  }

  /** Se subió o restauró una versión: el documento cambió (versión, huella, texto). */
  versionCambiada(): void {
    const id = this.documentId();
    if (!id) return;
    this.verificacion.set(null);
    this.cargarDocumento(id);
  }

  /** Muestra en el visor el PDF de una versión del historial. */
  verVersion(v: VersionParaVer): void {
    this.pdfUrl.set(this.pdf.crear(v.blob, null));
    this.visor.set('listo');
    this.versionViendo.set(v.actual ? null : v.version);
  }

  volverAVersionActual(): void {
    this.versionViendo.set(null);
    this.cargarPdf();
  }

  /** "Nueva versión" (cabecera): lleva al panel de versiones, donde está el formulario. */
  irAVersiones(): void {
    document.getElementById('versiones')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  /** Envía el documento a la papelera (se puede restaurar desde allí) y vuelve a la biblioteca. */
  eliminar(): void {
    const id = this.documentId();
    if (!id || this.eliminando()) return;
    this.eliminando.set(true);
    this.eliminarError.set('');
    this.api.eliminarDocumento(id).subscribe({
      next: () => {
        this.eliminando.set(false);
        this.router.navigate(['/biblioteca']);
      },
      error: (err) => {
        this.eliminando.set(false);
        this.confirmandoEliminar.set(false);
        this.eliminarError.set(
          err.status === 403 ? 'Solo el Super Administrador y el Oficial de Cumplimiento pueden enviar documentos a la papelera.'
            : err.error?.error ?? 'No se pudo enviar el documento a la papelera.');
      },
    });
  }

  /**
   * El PDF se pide con HttpClient como Blob (el interceptor añade el JWT) y se muestra con un object URL
   * en el visor nativo del navegador (<iframe>).
   */
  cargarPdf(id = this.documentId()): void {
    if (!id) return;
    this.versionViendo.set(null);
    this.visor.set('cargando');
    this.api.archivoDocumento(id).subscribe({
      next: (blob) => {
        this.pdfUrl.set(this.pdf.crear(blob, this.paginaObjetivo()));
        this.visor.set('listo');
      },
      error: async (err) => {
        const cuerpo = await leerErrorApi(err);
        this.visor.set(err.status === 404 && cuerpo.codigo === 'no_disponible' ? 'no_disponible' : 'error');
      },
    });
  }

  /** Reabre el PDF ya descargado en la página de la coincidencia (sin volver a pedirlo al servidor). */
  irAPaginaCoincidencia(): void {
    const n = this.paginaObjetivo();
    const url = n ? this.pdf.irAPagina(n) : null;
    if (url) this.pdfUrl.set(url);
  }

  claseEstadoTexto(estado: EstadoTexto): string {
    return CLASES_ESTADO_TEXTO[estado];
  }

  /** Programa la siguiente consulta del estado si sigue en cola o en curso. Sin bucles infinitos: tope de 5 min. */
  private vigilarIndexacion(): void {
    this.detenerSondeo();
    const id = this.documentId();
    const estado = this.indexacion()?.estado;
    if (!id || (estado !== 'pendiente' && estado !== 'procesando')) return;
    if (this.sondeos >= MAX_SONDEOS) {
      this.sondeoAgotado.set(true);
      return;
    }
    this.sondeo = setTimeout(() => {
      this.sondeos++;
      this.api.indexacionDocumento(id).subscribe({
        next: (i) => {
          this.indexacion.set(i);
          this.vigilarIndexacion();
        },
        error: () => this.sondeoAgotado.set(true), // sin red o sin permisos: se ofrece "Actualizar estado"
      });
    }, INTERVALO_SONDEO_MS);
  }

  private detenerSondeo(): void {
    if (this.sondeo) clearTimeout(this.sondeo);
    this.sondeo = null;
  }

  /** Botón "Actualizar estado" tras agotar el sondeo automático. */
  actualizarIndexacion(): void {
    this.sondeos = 0;
    this.sondeoAgotado.set(false);
    const id = this.documentId();
    if (!id) return;
    this.api.indexacionDocumento(id).subscribe({
      next: (i) => {
        this.indexacion.set(i);
        this.vigilarIndexacion();
      },
      error: () => this.sondeoAgotado.set(true),
    });
  }

  /** Vuelve a extraer el texto (Super Administrador y Operador OCR; el servidor lo valida y lo audita). */
  reindexar(): void {
    const id = this.documentId();
    if (!id || this.reindexando()) return;
    this.reindexando.set(true);
    this.reindexarError.set('');
    this.api.reindexarDocumento(id).subscribe({
      next: (i) => {
        this.reindexando.set(false);
        this.indexacion.set(i);
        this.sondeos = 0;
        this.sondeoAgotado.set(false);
        this.vigilarIndexacion();
      },
      error: (err) => {
        this.reindexando.set(false);
        this.reindexarError.set(
          err.status === 403 ? 'Solo el Super Administrador y el Operador OCR pueden reprocesar el texto.'
            : err.error?.error ?? 'No se pudo solicitar el reproceso.');
      },
    });
  }

  /** Capa de texto actual (documentos sin archivo real). */
  private cargarTexto(): void {
    const id = this.documentId();
    if (!id || this.visor() !== 'sin_archivo') return;
    this.paginaTextoError.set('');
    this.api.paginaDocumento<PaginaTexto>(id, this.currentPage()).subscribe({
      next: (p) => this.paginaTexto.set(p),
      error: (err) => {
        this.paginaTexto.set(null);
        this.paginaTextoError.set(err.status === 404 ? 'Esta página no tiene texto registrado.' : 'No se pudo cargar el texto de la página.');
      },
    });
  }

  descargar(): void {
    const d = this.doc();
    if (!d?.archivo || this.descargando()) return;
    this.descargando.set(true);
    this.descargaError.set('');
    this.api.descargarDocumento(d.id).subscribe({
      next: (blob) => {
        guardarComo(blob, d.archivo!.nombreOriginal);
        this.descargando.set(false);
      },
      error: async (err) => {
        const cuerpo = await leerErrorApi(err);
        this.descargaError.set(cuerpo.error ?? 'No se pudo descargar el archivo.');
        this.descargando.set(false);
      },
    });
  }

  verificarIntegridad(): void {
    const id = this.documentId();
    if (!id || this.verificando()) return;
    this.verificando.set(true);
    this.verificacionError.set('');
    this.api.verificarIntegridad(id).subscribe({
      next: (r) => {
        this.verificacion.set(r);
        this.verificando.set(false);
      },
      error: (err) => {
        this.verificacion.set(null);
        this.verificacionError.set(
          err.status === 403 ? 'Solo el Super Administrador y el Oficial de Cumplimiento pueden verificar la integridad.'
            : err.error?.error ?? 'No se pudo verificar la integridad.');
        this.verificando.set(false);
      },
    });
  }

  /** "4.2 MB" a partir de los bytes reales. */
  tamanoLegible(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  openAudit(): void {
    const id = this.documentId();
    if (!id) return;
    this.auditOpen.set(true);
    this.auditLoading.set(true);
    this.auditError.set('');

    // Solo Super Administrador y Oficial de Cumplimiento: para el resto el servidor responde 403
    this.api.auditoriaDocumento<RegistroAuditoria[]>(id).subscribe({
      next: (rows) => {
        this.auditRows.set(rows);
        this.auditLoading.set(false);
      },
      error: (err) => {
        this.auditRows.set([]);
        this.auditLoading.set(false);
        this.auditError.set(
          err.status === 403
            ? 'Solo el Super Administrador y el Oficial de Cumplimiento pueden consultar la auditoría.'
            : 'No se pudo cargar el historial de auditoría.',
        );
      },
    });
  }

  @HostListener('document:keydown.escape')
  closeAudit(): void {
    this.auditOpen.set(false);
  }

  accionLabel(accion: string): string {
    return ETIQUETAS_ACCION[accion] ?? accion;
  }

  backtoBilbioteca(): void {
    this.router.navigate(['/biblioteca']);
  }

  prevPage(): void {
    if (this.currentPage() > 1) {
      this.currentPage.set(this.currentPage() - 1);
      this.cargarTexto();
    }
  }

  nextPage(): void {
    if (this.currentPage() < this.totalPages()) {
      this.currentPage.set(this.currentPage() + 1);
      this.cargarTexto();
    }
  }

  zoomIn(): void {
    this.zoom.set(Math.min(200, this.zoom() + 10));
  }

  zoomOut(): void {
    this.zoom.set(Math.max(50, this.zoom() - 10));
  }
}
