import { Component, Input, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NotificacionesEstado } from '../../shared/notificaciones-estado';
import { AuthService } from '../../shared/auth';

interface NavItem {
  id: string;
  label: string;
  route: string;
  /** Si se indica, solo lo ven estos roles (el servidor también lo exige). */
  roles?: string[];
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
  private auth = inject(AuthService);

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
    { id: 'ocr', label: 'Digitalización (OCR)', route: '/digitalizacion', roles: ['super-admin', 'ocr-operator'] },
    { id: 'notificaciones', label: 'Notificaciones', route: '/notificaciones' },
    { id: 'papelera', label: 'Papelera', route: '/papelera', roles: ['super-admin', 'compliance'] },
    { id: 'roles', label: 'Roles y Permisos', route: '/roles', roles: ['super-admin', 'compliance'] },
    { id: 'cuenta', label: 'Seguridad de mi cuenta', route: '/cuenta/seguridad' },
  ];

  /** Ítems visibles para el rol de la sesión. */
  itemsVisibles = computed(() => {
    const rol = this.auth.currentUser()?.rolClave ?? '';
    return this.navItems.filter((i) => !i.roles || i.roles.includes(rol));
  });
}
