import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService, ResultadoIntegridad, leerErrorApi } from '../../shared/api';
import { UrlPdf, guardarComo } from '../../shared/archivo-pdf';

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
  firmadoPor: string | null;
  tieneArchivo: boolean;
  archivo: ArchivoInfo | null;
  puedeVerificar: boolean;
  ultimaVerificacion: { resultado: 'integro' | 'alterado' | 'no_disponible'; fecha: string } | null;
}

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
  eliminar: 'Envío a papelera de seguridad',
  aprobar_ocr: 'Aprobación e indexación OCR',
  invitar_usuario: 'Invitación de usuario',
};

@Component({
  selector: 'app-document-detail',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar],
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

  // Panel "Historial de Auditoría"
  auditOpen = signal(false);
  auditLoading = signal(false);
  auditError = signal('');
  auditRows = signal<RegistroAuditoria[]>([]);

  constructor(private route: ActivatedRoute, private router: Router, private api: ApiService) {
    // El object URL vive mientras el componente exista; al salir se libera la memoria del PDF.
    inject(DestroyRef).onDestroy(() => this.pdf.revocar());

    const id = this.route.snapshot.paramMap.get('id');
    this.documentId.set(id);
    if (!id) return;

    this.api.documento<DocDetalle>(id).subscribe({
      next: (d) => {
        this.doc.set(d);
        this.totalPages.set(d.paginas);
        if (d.tieneArchivo) this.cargarPdf(id);
        else {
          this.visor.set('sin_archivo');
          this.cargarTexto();
        }
      },
      error: (err) => {
        this.visor.set('error');
        this.error.set(err.status === 404 ? 'Documento no encontrado o sin permisos de acceso.' : 'No se pudo cargar el documento.');
      },
    });
  }

  /**
   * El PDF se pide con HttpClient como Blob (el interceptor añade el JWT) y se muestra con un object URL
   * en el visor nativo del navegador (<iframe>).
   */
  cargarPdf(id = this.documentId()): void {
    if (!id) return;
    this.visor.set('cargando');
    this.api.archivoDocumento(id).subscribe({
      next: (blob) => {
        this.pdfUrl.set(this.pdf.crear(blob));
        this.visor.set('listo');
      },
      error: async (err) => {
        const cuerpo = await leerErrorApi(err);
        this.visor.set(err.status === 404 && cuerpo.codigo === 'no_disponible' ? 'no_disponible' : 'error');
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

  backToDashboard(): void {
    this.router.navigate(['/dashboard']);
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
