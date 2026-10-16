import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../shared/auth';


@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './navbar.html',
})
export class Navbar {
  searchQuery = signal('');

  /** "GG" para "Gabriel Guevara"; ignora títulos como "Dra." o "Ing.". */
  iniciales = computed(() => {
    const nombre = (this.auth.currentUser()?.name ?? '').replace(/^(Dra?\.|Lic\.|Ing\.|Mtro\.|MSc\.)\s+/i, '').trim();
    return nombre.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
  });

  constructor(private router: Router, public auth: AuthService) {}

  /**
   * Al buscar desde el navbar (Enter o clic en la lupa) siempre se navega
   * a la Búsqueda Avanzada con el término como query param `q`.
   * Si ya se está en esa pantalla, Angular solo actualiza los query params
   * y el componente de Búsqueda reacciona a ese cambio.
   */
  /** "Nuevo Documento" lleva a Digitalización (OCR), donde se ingresan los documentos. */
  nuevoDocumento(): void {
    this.router.navigate(['/digitalizacion']);
  }

  onSearchSubmit(): void {
    const query = this.searchQuery().trim();
    this.router.navigate(['/busqueda'], {
      queryParams: { q: query || null },
      queryParamsHandling: 'merge',
    });
  }

  cerrarSesion(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
