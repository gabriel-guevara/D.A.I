import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { Icono } from '../ui/icono';
import { ApiService, DocumentoEnPapelera, EstadoPapelera, SegundoFactor } from '../../shared/api';

/** Qué se va a purgar: un documento concreto o toda la papelera. */
type Purga = { tipo: 'uno'; doc: DocumentoEnPapelera } | { tipo: 'todo' };

/** Mensaje del servidor (todos en español) o uno por defecto. */
const mensajeDe = (err: unknown, porDefecto: string): string =>
  (err instanceof HttpErrorResponse && typeof err.error?.error === 'string' ? err.error.error : null) ?? porDefecto;

/**
 * Papelera: documentos eliminados (que conservan archivo, versiones y texto) para restaurarlos o purgarlos.
 * Restaurar: Super Administrador y Oficial de Cumplimiento. Purgar/vaciar: solo Super Administrador con su código
 * 2FA (el servidor lo exige; aquí solo se adapta la interfaz). Se carga en diferido (loadComponent).
 */
@Component({
  selector: 'app-papelera',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, Barraizq, Navbar, Icono],
  templateUrl: './papelera.html',
})
export class Papelera {
  private api = inject(ApiService);

  estado = signal<EstadoPapelera | null>(null);
  cargando = signal(true);
  errorCarga = signal('');
  sinPermiso = signal(false);
  aviso = signal('');
  filtro = signal('');

  /** Id del documento que se está restaurando (para deshabilitar solo su botón). */
  restaurando = signal<string | null>(null);
  errorFila = signal<{ id: string; mensaje: string } | null>(null);

  // Diálogo de purga con segundo factor
  purga = signal<Purga | null>(null);
  codigo = signal('');
  usarRecuperacion = signal(false);
  purgando = signal(false);
  errorPurga = signal('');

  documentos = computed(() => {
    const q = this.filtro().trim().toLowerCase();
    const lista = this.estado()?.documentos ?? [];
    return q ? lista.filter((d) => `${d.nombre} ${d.folio} ${d.departamento}`.toLowerCase().includes(q)) : lista;
  });
  /** Documentos que "Vaciar" puede purgar (los de retención legal se quedan). */
  purgables = computed(() => (this.estado()?.documentos ?? []).filter((d) => !d.retencionHasta).length);
  codigoValido = computed(() =>
    this.usarRecuperacion() ? /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(this.codigo().trim()) : /^\d{6}$/.test(this.codigo().trim()));

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.errorCarga.set('');
    this.api.papelera().subscribe({
      next: (e) => {
        this.estado.set(e);
        this.cargando.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.cargando.set(false);
        if (err.status === 403) this.sinPermiso.set(true);
        else this.errorCarga.set(mensajeDe(err, 'No se pudo cargar la papelera.'));
      },
    });
  }

  restaurar(doc: DocumentoEnPapelera): void {
    if (this.restaurando()) return;
    this.restaurando.set(doc.id);
    this.errorFila.set(null);
    this.aviso.set('');
    this.api.restaurarDesdePapelera(doc.id).subscribe({
      next: () => {
        this.restaurando.set(null);
        this.quitarDeLaLista(doc.id);
        this.aviso.set(`«${doc.nombre}» se restauró: vuelve a estar en la biblioteca con su archivo, versiones y texto.`);
      },
      error: (err) => {
        this.restaurando.set(null);
        this.errorFila.set({ id: doc.id, mensaje: mensajeDe(err, 'No se pudo restaurar el documento.') });
      },
    });
  }

  abrirPurga(p: Purga): void {
    this.purga.set(p);
    this.codigo.set('');
    this.usarRecuperacion.set(false);
    this.errorPurga.set('');
    this.aviso.set('');
  }

  @HostListener('document:keydown.escape')
  cerrarPurga(): void {
    if (!this.purgando()) this.purga.set(null);
  }

  alternarRecuperacion(): void {
    this.usarRecuperacion.update((v) => !v);
    this.codigo.set('');
    this.errorPurga.set('');
  }

  confirmarPurga(): void {
    const p = this.purga();
    if (!p || this.purgando() || !this.codigoValido()) return;
    const factor: SegundoFactor = this.usarRecuperacion()
      ? { codigoRecuperacion: this.codigo().trim().toUpperCase() }
      : { code: this.codigo().trim() };
    this.purgando.set(true);
    this.errorPurga.set('');

    const fallo = (err: unknown) => {
      this.purgando.set(false);
      this.codigo.set('');
      this.errorPurga.set(mensajeDe(err, 'No se pudo completar la purga.'));
    };
    if (p.tipo === 'uno') {
      this.api.purgarDocumento(p.doc.id, factor).subscribe({
        next: (r) => {
          this.terminarPurga();
          this.quitarDeLaLista(p.doc.id);
          this.aviso.set(`«${p.doc.nombre}» se purgó definitivamente (${r.versiones} ${r.versiones === 1 ? 'versión' : 'versiones'}). Queda el registro en la auditoría.`);
        },
        error: fallo,
      });
    } else {
      this.api.vaciarPapelera(factor).subscribe({
        next: (r) => {
          this.terminarPurga();
          const partes = [`Se purgaron ${r.purgados} ${r.purgados === 1 ? 'documento' : 'documentos'}.`];
          if (r.enRetencion) partes.push(`${r.enRetencion} con retención legal vigente se conservan.`);
          if (r.restantes) partes.push(`Quedan ${r.restantes} por purgar: vuelva a vaciar.`);
          this.aviso.set(partes.join(' '));
          this.cargar();
        },
        error: fallo,
      });
    }
  }

  private terminarPurga(): void {
    this.purgando.set(false);
    this.purga.set(null);
  }

  private quitarDeLaLista(id: string): void {
    this.estado.update((e) => (e ? { ...e, documentos: e.documentos.filter((d) => d.id !== id) } : e));
  }
}
