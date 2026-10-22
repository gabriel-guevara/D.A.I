import { Component, Input, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NotificacionesEstado } from '../../shared/notificaciones-estado';
import { AuthService } from '../../shared/auth';
import { Icono, NombreIcono } from '../ui/icono';

interface NavItem {
  id: string;
  label: string;
  route: string;
  icono: NombreIcono;
  /** Si se indica, solo lo ven estos roles (el servidor también lo exige). */
  roles?: string[];
}

@Component({
  selector: 'app-barraizq',
  standalone: true,
  imports: [CommonModule, RouterLink, Icono],
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

  /** Posición del ítem activo en la lista visible (para colocar el indicador detrás de él); -1 si no está. */
  indiceActivo(): number {
    return this.itemsVisibles().findIndex((i) => i.id === this.active);
  }

  textoBadge(n: number): string {
    return n > 99 ? '99+' : String(n);
  }

  navItems: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', route: '/dashboard', icono: 'inicio' },
    { id: 'biblioteca', label: 'Biblioteca', route: '/biblioteca', icono: 'biblioteca' },
    { id: 'busqueda', label: 'Búsqueda Avanzada', route: '/busqueda', icono: 'buscar' },
    { id: 'ocr', label: 'Digitalización (OCR)', route: '/digitalizacion', icono: 'digitalizar', roles: ['super-admin', 'ocr-operator'] },
    { id: 'notificaciones', label: 'Notificaciones', route: '/notificaciones', icono: 'notificacion' },
    { id: 'papelera', label: 'Papelera', route: '/papelera', icono: 'papelera', roles: ['super-admin', 'compliance'] },
    { id: 'roles', label: 'Roles y Permisos', route: '/roles', icono: 'roles', roles: ['super-admin', 'compliance'] },
    { id: 'cuenta', label: 'Seguridad de mi cuenta', route: '/cuenta/seguridad', icono: 'candado' },
  ];

  /** Ítems visibles para el rol de la sesión. */
  itemsVisibles = computed(() => {
    const rol = this.auth.currentUser()?.rolClave ?? '';
    return this.navItems.filter((i) => !i.roles || i.roles.includes(rol));
  });
}
