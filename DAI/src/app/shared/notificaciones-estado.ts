import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api';
import { AuthService } from './auth';

const CADA_MS = 5000;

/**
 * Cuántas notificaciones sin leer tiene el usuario. Lo usa el indicador rojo de la barra lateral.
 * Se actualiza solo cada 5 s mientras haya sesión y la pestaña esté visible; cuando llega a 0
 * el indicador desaparece.
 */
@Injectable({ providedIn: 'root' })
export class NotificacionesEstado {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private timer: ReturnType<typeof setInterval> | null = null;

  noLeidas = signal(0);

  /** Idempotente: se puede llamar desde cada pantalla; solo arranca un temporizador. */
  iniciar(): void {
    if (this.timer) return;
    this.refrescar();
    this.timer = setInterval(() => this.refrescar(), CADA_MS);
  }

  refrescar(): void {
    if (!this.auth.isAuthenticated()) {
      this.noLeidas.set(0);
      this.detener();
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.api.notificacionesResumen<{ noLeidas: number }>().subscribe({
      next: (r) => this.noLeidas.set(r.noLeidas),
      error: () => { /* un fallo puntual de red no debe romper la pantalla */ },
    });
  }

  /** Para cuando el usuario marca todo como leído: el indicador se apaga al instante. */
  limpiar(): void {
    this.noLeidas.set(0);
  }

  private detener(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
