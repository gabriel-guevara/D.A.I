import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { ApiService, HistorialVersiones, VersionDocumento, leerErrorApi } from '../../shared/api';
import { guardarComo } from '../../shared/archivo-pdf';

const MIN_COMENTARIO = 3;
const MAX_COMENTARIO = 300;

/** Lo que el panel le pide al detalle: mostrar en el visor el PDF de una versión concreta. */
export interface VersionParaVer {
  version: string;
  actual: boolean;
  blob: Blob;
}

/**
 * Historial de versiones del detalle: listar, ver/descargar una versión concreta, subir una nueva y restaurar una
 * anterior. Componente aparte (SRP): el detalle solo orquesta el visor; este panel gestiona las versiones.
 * Los permisos los decide el servidor (puedeGestionar solo adapta la interfaz).
 */
@Component({
  selector: 'app-versiones-documento',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './versiones-documento.html',
})
export class VersionesDocumento implements OnInit {
  private api = inject(ApiService);

  documentoId = input.required<string>();
  /** El detalle ya sabe si puede gestionar (evita un parpadeo); el historial lo confirma. */
  puedeGestionarInicial = input(false);
  ver = output<VersionParaVer>();
  /** Se subió o restauró una versión: el detalle debe recargar el documento. */
  cambio = output<string>();

  historial = signal<HistorialVersiones | null>(null);
  cargando = signal(true);
  error = signal('');
  aviso = signal('');
  /** Id de la versión con una acción en curso (ver, descargar o restaurar). */
  ocupada = signal<string | null>(null);
  errorVersion = signal<{ id: string; mensaje: string } | null>(null);
  /** Versión pendiente de confirmar para restaurar. */
  confirmarRestaurar = signal<VersionDocumento | null>(null);

  // Subida de una versión nueva
  archivo = signal<File | null>(null);
  comentario = signal('');
  subiendo = signal(false);
  progreso = signal(0);
  errorSubida = signal('');

  puedeGestionar = computed(() => this.historial()?.puedeGestionar ?? this.puedeGestionarInicial());
  comentarioValido = computed(() => this.comentario().trim().length >= MIN_COMENTARIO);
  readonly maxComentario = MAX_COMENTARIO;

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.api.versionesDocumento(this.documentoId()).subscribe({
      next: (h) => {
        this.historial.set(h);
        this.cargando.set(false);
      },
      error: () => {
        this.cargando.set(false);
        this.error.set('No se pudo cargar el historial de versiones.');
      },
    });
  }

  /** Nombre con el que se guarda: la actual con su nombre; una anterior con la versión, como lo envía el servidor. */
  nombreDescarga(v: VersionDocumento): string {
    const base = v.nombreOriginal ?? 'documento.pdf';
    return v.actual ? base : `${base.replace(/\.pdf$/i, '')} (${v.version}).pdf`;
  }

  verVersion(v: VersionDocumento): void {
    this.accionArchivo(v, 'ver');
  }

  descargar(v: VersionDocumento): void {
    this.accionArchivo(v, 'descargar');
  }

  private accionArchivo(v: VersionDocumento, accion: 'ver' | 'descargar'): void {
    if (this.ocupada()) return;
    this.ocupada.set(v.id);
    this.errorVersion.set(null);
    const peticion = accion === 'ver' ? this.api.archivoVersion(this.documentoId(), v.id) : this.api.descargarVersion(this.documentoId(), v.id);
    peticion.subscribe({
      next: (blob) => {
        this.ocupada.set(null);
        if (accion === 'ver') this.ver.emit({ version: v.version, actual: v.actual, blob });
        else guardarComo(blob, this.nombreDescarga(v));
      },
      error: async (err) => {
        this.ocupada.set(null);
        const cuerpo = await leerErrorApi(err); // con responseType 'blob' el JSON de error llega como Blob
        this.errorVersion.set({ id: v.id, mensaje: cuerpo.error ?? 'No se pudo obtener el archivo de esta versión.' });
      },
    });
  }

  pedirRestaurar(v: VersionDocumento): void {
    this.confirmarRestaurar.set(v);
    this.errorVersion.set(null);
    this.aviso.set('');
  }

  restaurar(): void {
    const v = this.confirmarRestaurar();
    if (!v || this.ocupada()) return;
    this.ocupada.set(v.id);
    this.api.restaurarVersion(this.documentoId(), v.id).subscribe({
      next: (r) => {
        this.ocupada.set(null);
        this.confirmarRestaurar.set(null);
        this.aviso.set(`La versión ${r.version} vuelve a ser la actual (la ${r.anterior} se conserva en el historial). El texto para la búsqueda se está extrayendo de nuevo.`);
        this.cargar();
        this.cambio.emit(r.version);
      },
      error: (err: HttpErrorResponse) => {
        this.ocupada.set(null);
        this.confirmarRestaurar.set(null);
        this.errorVersion.set({ id: v.id, mensaje: err.error?.error ?? 'No se pudo restaurar la versión.' });
      },
    });
  }

  elegirArchivo(evento: Event): void {
    const f = (evento.target as HTMLInputElement).files?.[0] ?? null;
    this.errorSubida.set('');
    // Comprobación rápida en el navegador; la de verdad (firma %PDF-, tamaño, contraseña) la hace el servidor.
    if (f && f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      this.archivo.set(null);
      this.errorSubida.set('Seleccione un archivo PDF.');
      return;
    }
    this.archivo.set(f);
  }

  subir(entrada: HTMLInputElement): void {
    const f = this.archivo();
    if (!f || !this.comentarioValido() || this.subiendo()) return;
    this.subiendo.set(true);
    this.progreso.set(0);
    this.errorSubida.set('');
    this.aviso.set('');
    this.api.subirVersion(this.documentoId(), f, this.comentario()).subscribe({
      next: (e) => {
        if (e.type === HttpEventType.UploadProgress && e.total) this.progreso.set(Math.round((100 * e.loaded) / e.total));
        if (e.type === HttpEventType.Response && e.body) {
          this.subiendo.set(false);
          this.archivo.set(null);
          this.comentario.set('');
          entrada.value = '';
          this.aviso.set(`Versión ${e.body.version} subida (SHA-256 ${e.body.hashCorto}). El texto para la búsqueda se está extrayendo.`);
          this.cargar();
          this.cambio.emit(e.body.version);
        }
      },
      error: (err: HttpErrorResponse) => {
        this.subiendo.set(false);
        this.errorSubida.set(
          err.status === 403 ? 'Solo el Super Administrador y el Operador OCR pueden subir versiones.'
            : err.error?.error ?? 'No se pudo subir la versión.');
      },
    });
  }
}
