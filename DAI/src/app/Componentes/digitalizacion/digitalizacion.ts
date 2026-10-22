import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpEventType } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { Icono } from '../ui/icono';
import { ApiService, DocumentoSubido, MetadatosSubida, leerErrorApi } from '../../shared/api';
import { UrlPdf, pareceUnPdf } from '../../shared/archivo-pdf';

/** vacio → listo (archivo elegido) → subiendo → exito | error */
type EstadoSubida = 'vacio' | 'listo' | 'subiendo' | 'exito' | 'error';

interface Catalogos {
  departamentos: { id: number; nombre: string }[];
  tiposDocumentales: { id: number; nombre: string }[];
  clasificaciones: { id: number; nombre: string; permitida: boolean }[];
  subida: { maxMb: number };
}

@Component({
  selector: 'app-digitalizacion',
  standalone: true,
  imports: [CommonModule, RouterLink, Barraizq, Navbar, Icono],
  templateUrl: './digitalizacion.html',
})
export class Digitalizacion {
  private api = inject(ApiService);
  private urlPdf = new UrlPdf(inject(DomSanitizer));
  private envio: Subscription | null = null;

  // Catálogos para el formulario
  catalogos = signal<Catalogos | null>(null);
  maxMb = computed(() => this.catalogos()?.subida.maxMb ?? 20);

  // Estado de la subida
  estado = signal<EstadoSubida>('vacio');
  archivo = signal<File | null>(null);
  vistaPrevia = signal<SafeResourceUrl | null>(null);
  arrastrando = signal(false);
  progreso = signal(0);
  mensajeError = signal<string | null>(null);
  resultado = signal<DocumentoSubido | null>(null);
  meta = signal<MetadatosSubida>({ clasificacion: '', folio: '', titulo: '', departamento: '', tipoDocumental: '' });

  /** "Aprobar e Indexar" solo con archivo válido y clasificación elegida (el servidor lo vuelve a exigir). */
  puedeEnviar = computed(() => this.estado() === 'listo' && !!this.archivo() && !!this.meta().clasificacion);
  /** La barra llega a 100 % cuando el navegador terminó de enviar; el servidor aún valida y guarda. */
  procesandoEnServidor = computed(() => this.estado() === 'subiendo' && this.progreso() >= 100);

  constructor() {
    this.api.catalogos<Catalogos>().subscribe({
      next: (c) => this.catalogos.set(c),
      error: () => this.mensajeError.set('No se pudieron cargar los catálogos del formulario.'),
    });
    // Al salir de la pantalla: se cancela una subida en curso y se libera la vista previa.
    inject(DestroyRef).onDestroy(() => {
      this.envio?.unsubscribe();
      this.urlPdf.revocar();
    });
  }

  // ------------------------------------------------------------------ selección (clic o arrastrar y soltar)

  alSeleccionar(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = ''; // permite volver a elegir el mismo archivo
    if (f) void this.elegirArchivo(f);
  }

  alArrastrar(evento: DragEvent, encima: boolean): void {
    evento.preventDefault(); // sin esto el navegador abriría el PDF en la pestaña en vez de soltarlo aquí
    if (this.estado() !== 'subiendo') this.arrastrando.set(encima);
  }

  alSoltar(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastrando.set(false);
    if (this.estado() === 'subiendo') return;
    const f = evento.dataTransfer?.files?.[0];
    if (f) void this.elegirArchivo(f);
  }

  /** Comprobaciones rápidas en el navegador para dar respuesta inmediata. NO sustituyen a las del servidor. */
  async elegirArchivo(f: File): Promise<void> {
    this.mensajeError.set(null);
    this.resultado.set(null);
    if (f.size > this.maxMb() * 1024 * 1024) return this.rechazar(`El archivo supera el máximo de ${this.maxMb()} MB.`);
    if (f.size === 0) return this.rechazar('El archivo está vacío.');
    if (!(await pareceUnPdf(f))) return this.rechazar('El archivo no es un PDF (su contenido no empieza por "%PDF-").');

    this.archivo.set(f);
    this.vistaPrevia.set(this.urlPdf.crear(f));
    if (!this.meta().titulo) this.actualizar('titulo', f.name.replace(/\.pdf$/i, ''));
    this.estado.set('listo');
  }

  private rechazar(mensaje: string): void {
    this.quitarArchivo();
    this.mensajeError.set(mensaje);
  }

  quitarArchivo(): void {
    this.envio?.unsubscribe();
    this.urlPdf.revocar();
    this.archivo.set(null);
    this.vistaPrevia.set(null);
    this.progreso.set(0);
    this.estado.set('vacio');
  }

  actualizar(campo: keyof MetadatosSubida, valor: string): void {
    this.meta.update((m) => ({ ...m, [campo]: valor }));
  }

  // ------------------------------------------------------------------ envío

  aprobarEIndexar(): void {
    const f = this.archivo();
    if (!f || !this.puedeEnviar()) return;
    this.estado.set('subiendo');
    this.progreso.set(0);
    this.mensajeError.set(null);

    this.envio = this.api.subirDocumento(f, this.meta()).subscribe({
      next: (e) => {
        if (e.type === HttpEventType.UploadProgress) {
          this.progreso.set(e.total ? Math.round((e.loaded / e.total) * 100) : 0);
        } else if (e.type === HttpEventType.Response && e.body) {
          this.resultado.set(e.body);
          this.urlPdf.revocar();
          this.vistaPrevia.set(null);
          this.archivo.set(null);
          this.meta.set({ clasificacion: '', folio: '', titulo: '', departamento: '', tipoDocumental: '' });
          this.estado.set('exito');
        }
      },
      error: async (err) => {
        const cuerpo = await leerErrorApi(err);
        this.mensajeError.set(
          cuerpo.error ?? (err.status === 0 ? 'Sin conexión con el servidor.' : 'No se pudo indexar el documento.'));
        // El archivo sigue elegido: se pueden corregir los metadatos y reintentar.
        this.estado.set('listo');
        this.progreso.set(0);
      },
    });
  }

  cancelarSubida(): void {
    this.envio?.unsubscribe(); // cancelar la suscripción aborta la petición HTTP
    this.envio = null;
    this.progreso.set(0);
    this.estado.set('listo');
    this.mensajeError.set('Subida cancelada.');
  }

  /** "4.2 MB" para mostrar el archivo elegido. */
  tamanoLegible(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
}
