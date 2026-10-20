import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';
import { AuthService } from '../../shared/auth';

type RoleKey = 'super-admin' | 'compliance' | 'ocr-operator' | 'read-only';

interface RoleCard {
  key: RoleKey;
  name: string;
  badge: string;
  badgeColor: string;
  icon: string;
  description: string;
  assignedCount: number;
}

interface SecurityUser {
  id: string;
  name: string;
  email: string;
  initials: string;
  avatarColor: string;
  departamento: string;
  rol: RoleKey;
  rolLabel: string;
  rolColor: string;
  mfaMethod: string;
  nivel: string;
  nivelColor: string;
  activo?: boolean;
  ultimoAcceso: string;
}

@Component({
  selector: 'app-roles',
  standalone: true,
  imports: [CommonModule, FormsModule, Barraizq, Navbar],
  templateUrl: './roles.html',
})
export class roles {
  private api = inject(ApiService);
  private router = inject(Router);
  private auth = inject(AuthService);

  /** Solo el Super Administrador ve los botones de edición (el servidor también lo exige). */
  esSuperAdmin = computed(() => this.auth.currentUser()?.rolClave === 'super-admin');

  constructor() {
    // Solo Administrador y Oficial de Cumplimiento pueden ver esta pantalla)
    this.api.rolesTarjetas<RoleCard[]>().subscribe({
      next: (r) => this.roleCards.set(r),
      error: (err) => console.error('No se pudieron cargar los roles', err),
    });
    this.api.catalogos().subscribe({
      next: (c) => this.rolesCatalogo.set(c.roles),
      error: () => this.rolesCatalogo.set([]),
    });
    this.api.usuarios<SecurityUser[]>().subscribe({
      next: (u) => this.users.set(u),
      error: (err) => console.error('No se pudieron cargar los usuarios', err),
    });
  }

  searchText = signal('');
  selectedRole = signal<RoleKey | 'todos'>('todos');
  selectedNivel = signal<string>('todos');
  selectedMfa = signal<string>('todos');
  confirmationMessage = signal<string | null>(null);

  roleCards = signal<RoleCard[]>([]);
  /** Roles del filtro: los reales de la base (GET /catalogos), no una lista escrita a mano. */
  rolesCatalogo = signal<{ clave: string; nombre: string }[]>([]);

  roleLabels: Record<RoleKey, string> = {
    'super-admin': 'Administrador',
    compliance: 'Oficial Cumplimiento',
    'ocr-operator': 'Operador OCR / Ingesta',
    'read-only': 'Lector Restringido',
  };

  users = signal<SecurityUser[]>([]);

  filteredUsers = computed(() => {
    const term = this.searchText().trim().toLowerCase();
    const role = this.selectedRole();
    const nivel = this.selectedNivel();

    return this.users().filter((u) => {
      const matchesTerm =
        !term || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term);
      const matchesRole = role === 'todos' || u.rol === role;
      const matchesNivel = nivel === 'todos' || u.nivel === nivel;
      return matchesTerm && matchesRole && matchesNivel;
    });
  });

  cuentasEnRiesgo = computed(() => this.users().filter((u) => u.mfaMethod === 'SMS Backup').length);

  /** Clic en "Ver matriz →" de una tarjeta de rol: filtra la tabla por ese rol. */
  filterByRole(key: RoleKey): void {
    this.selectedRole.set(this.selectedRole() === key ? 'todos' : key);
  }

  resetFiltros(): void {
    this.searchText.set('');
    this.selectedRole.set('todos');
    this.selectedNivel.set('todos');
    this.selectedMfa.set('todos');
  }

  /** "Crear Usuario": abre la pantalla de gestión en la pestaña de alta. */
  crearUsuario(): void {
    this.router.navigate(['/roles/usuarios'], { queryParams: { tab: 'crear' } });
  }

  /** "Editar" en una fila: abre la pestaña de modificación con ese usuario ya seleccionado. */
  editarUsuario(id: string): void {
    this.router.navigate(['/roles/usuarios'], { queryParams: { tab: 'modificar', id } });
  }
}
