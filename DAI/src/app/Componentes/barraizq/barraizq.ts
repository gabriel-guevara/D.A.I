import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NotificacionesEstado } from '../../shared/notificaciones-estado';

interface NavItem {
  id: string;
  label: string;
  route: string;
}

@Component({
  selector: 'app-barraizq',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './barraizq.html',
})
export class Barraizq {
  @Input() active = 'dashboard';

  private estado = inject(NotificacionesEstado);

  constructor() {
    this.estado.iniciar();
  }

  /** Número que muestra el indicador rojo de un ítem; 0 = no se muestra (solo Notificaciones lo tiene). */
  badgeDe(id: string): number {
    return id === 'notificaciones' ? this.estado.noLeidas() : 0;
  }

  textoBadge(n: number): string {
    return n > 99 ? '99+' : String(n);
  }

  navItems: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', route: '/dashboard' },
    { id: 'biblioteca', label: 'Biblioteca', route: '/biblioteca' },
    { id: 'busqueda', label: 'Búsqueda Avanzada', route: '/busqueda' },
    { id: 'ocr', label: 'Digitalización (OCR)', route: '/digitalizacion' },
    { id: 'notificaciones', label: 'Notificaciones', route: '/notificaciones' },
    { id: 'roles', label: 'Roles y Permisos', route: '/roles' },
  ];
}
