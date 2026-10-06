import { Routes } from '@angular/router';
import { Login } from './Componentes/login/login';
import { Dashboard } from './Componentes/dashboard/dashboard';
import { Biblioteca } from './Componentes/biblioteca/biblioteca';
import { Digitalizacion } from './Componentes/digitalizacion/digitalizacion';
import { Busqueda } from './Componentes/busqueda/busqueda';
import { Notificaciones } from './Componentes/notificaciones/notificaciones';
import { roles } from './Componentes/roles/roles';
import { detalles } from './Componentes/detalles/detalles';
import { authGuard } from './shared/auth-guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: Login },
  { path: 'dashboard', component: Dashboard, canActivate: [authGuard] },
  { path: 'biblioteca', component: Biblioteca, canActivate: [authGuard] },
  { path: 'digitalizacion', component: Digitalizacion, canActivate: [authGuard] },
  { path: 'busqueda', component: Busqueda, canActivate: [authGuard] },
  { path: 'notificaciones', component: Notificaciones, canActivate: [authGuard] },
  { path: 'roles', component: roles, canActivate: [authGuard] },
  { path: 'documento/:id', component: detalles, canActivate: [authGuard] },
  { path: '**', redirectTo: 'login' },
];
