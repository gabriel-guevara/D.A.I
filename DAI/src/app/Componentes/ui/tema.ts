import { Injectable, signal } from '@angular/core';

/**
 * Tema claro/oscuro (solo interfaz). index.html aplica la clase `dark` antes de pintar;
 * este servicio la alterna y recuerda la elección del usuario en este navegador.
 */
@Injectable({ providedIn: 'root' })
export class Tema {
  private readonly clave = 'dai-tema';
  readonly oscuro = signal(typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));

  alternar(): void {
    const oscuro = !this.oscuro();
    this.oscuro.set(oscuro);
    document.documentElement.classList.toggle('dark', oscuro);
    try {
      localStorage.setItem(this.clave, oscuro ? 'oscuro' : 'claro');
    } catch {
      // Navegación privada o almacenamiento bloqueado: el tema vale solo para esta sesión.
    }
  }
}
