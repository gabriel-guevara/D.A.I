import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../shared/auth';
import { ApiService, DashboardDatos, FormatoDoc } from '../../shared/api';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { Icono } from '../ui/icono';

/** Tarjeta de indicador (todas sus cifras vienen del servidor; nada fijo en la plantilla). */
interface Indicador {
  label: string;
  value: string;
  sub: string;
  accent: string;
}

const ETIQUETA_FORMATO: Record<FormatoDoc, string> = { pdf: 'PDF', xlsx: 'Excel', docx: 'Word', tiff: 'TIFF' };
const ROLES_SUBEN = ['super-admin', 'ocr-operator'];
// Separador de miles de Colombia (1.420). Intl no necesita registrar datos de idioma en Angular.
const numero = new Intl.NumberFormat('es-CO');

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar, Icono],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  /** Fecha de hoy para el encabezado ("miércoles, 22 de octubre"). */
  hoy = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  private router = inject(Router);
  private api = inject(ApiService);
  auth = inject(AuthService);

  datos = signal<DashboardDatos | null>(null);
  error = signal('');
  documents = computed(() => this.datos()?.recientes ?? []);
  puedeSubir = computed(() => ROLES_SUBEN.includes(this.auth.currentUser()?.rolClave ?? ''));

  indicadores = computed<Indicador[]>(() => {
    const d = this.datos()?.documentos;
    if (!d) return [];
    const n = (x: number) => numero.format(x);
    return [
      { label: 'Documentos visibles', value: n(d.visibles), sub: 'Según su nivel de acceso', accent: 'text-ink' },
      { label: 'Altas este mes', value: n(d.altasMes), sub: 'Calendario de Colombia', accent: 'text-ink' },
      { label: 'Con archivo original', value: n(d.conArchivo), sub: `${n(d.sinArchivo)} solo con metadatos`, accent: 'text-ink' },
      { label: 'Fuera de plazo', value: n(d.fueraDePlazo), sub: d.fueraDePlazo > 0 ? 'Fecha límite vencida' : 'Al día', accent: d.fueraDePlazo > 0 ? 'text-danger' : 'text-ok' },
    ];
  });

  /** Ancho de las barras: proporción respecto del total de documentos visibles. */
  porcentaje(valor: number): number {
    const total = this.datos()?.documentos.visibles ?? 0;
    return total > 0 ? Math.round((valor / total) * 100) : 0;
  }

  n(x: number): string {
    return numero.format(x);
  }

  etiquetaFormato(f: FormatoDoc): string {
    return ETIQUETA_FORMATO[f] ?? f.toUpperCase();
  }

  constructor() {
    this.api.dashboard().subscribe({
      next: (d) => this.datos.set(d),
      error: () => this.error.set('No se pudieron cargar los indicadores del dashboard.'),
    });
  }

  goToBiblioteca(): void {
    this.router.navigate(['/biblioteca']);
  }

  goToDigitalizacion(): void {
    this.router.navigate(['/digitalizacion']);
  }

  gotoBusqueda(): void {
    this.router.navigate(['/busqueda']);
  }

  goToNotificaciones(): void {
    this.router.navigate(['/notificaciones']);
  }

  openDocument(id: string): void {
    this.router.navigate(['/documento', id]);
  }
}
