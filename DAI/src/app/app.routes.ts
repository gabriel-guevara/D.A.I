import { Routes } from '@angular/router';
import { Login } from './Componentes/login/login';
import { Dashboard } from './Componentes/dashboard/dashboard';
import { Biblioteca } from './Componentes/biblioteca/biblioteca';
import { Digitalizacion } from './Componentes/digitalizacion/digitalizacion';
import { Busqueda } from './Componentes/busqueda/busqueda';
import { Notificaciones } from './Componentes/notificaciones/notificaciones';
import { roles } from './Componentes/roles/roles';
import { authGuard } from './shared/auth-guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: Login },
  { path: 'dashboard', component: Dashboard, canActivate: [authGuard] },
  { path: 'biblioteca', component: Biblioteca, canActivate: [authGuard] },
  { path: 'digitalizacion', component: Digitalizacion, canActivate: [authGuard] },
  { path: 'busqueda', component: Busqueda, canActivate: [authGuard] },
  { path: 'notificaciones', component: Notificaciones, canActivate: [authGuard] },
  // Solo administradores: carga diferida.
  {
    path: 'roles/usuarios',
    loadComponent: () => import('./Componentes/usuarios/usuarios').then((m) => m.UsuariosGestion),
    canActivate: [authGuard],
  },
  { path: 'roles', component: roles, canActivate: [authGuard] },
  // Papelera (Fase 4): solo Super Administrador y Oficial de Cumplimiento; carga diferida.
  {
    path: 'papelera',
    loadComponent: () => import('./Componentes/papelera/papelera').then((m) => m.Papelera),
    canActivate: [authGuard],
  },
  // Detalle del documento (visor, metadatos, versiones): carga diferida desde la Fase 4, porque el historial de
  // versiones lo hizo crecer y el paquete inicial está al límite del presupuesto de 500 kB.
  {
    path: 'documento/:id',
    loadComponent: () => import('./Componentes/detalles/detalles').then((m) => m.detalles),
    canActivate: [authGuard],
  },
  // Carga diferida: se descarga solo al abrir la pantalla (no pesa en el arranque de la app).
  {
    path: 'cuenta/seguridad',
    loadComponent: () => import('./Componentes/seguridad-cuenta/seguridad-cuenta').then((m) => m.SeguridadCuenta),
    canActivate: [authGuard],
  },
  { path: '**', redirectTo: 'login' },
];
