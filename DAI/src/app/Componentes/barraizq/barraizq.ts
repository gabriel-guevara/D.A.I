import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

interface NavItem {
  id: string;
  label: string;
  route: string;
  badge?: number;
}

@Component({
  selector: 'app-barraizq',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './barraizq.html',
})
export class Barraizq {
  @Input() active = 'dashboard';

  navItems: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', route: '/dashboard' },
    { id: 'biblioteca', label: 'Biblioteca', route: '/biblioteca' },
    { id: 'busqueda', label: 'Búsqueda Avanzada', route: '/busqueda' },
    { id: 'ocr', label: 'Digitalización (OCR)', route: '/digitalizacion' },
    { id: 'notificaciones', label: 'Notificaciones', route: '/notificaciones', badge: 2 },
    { id: 'roles', label: 'Roles y Permisos', route: '/roles' },
  ];
}
