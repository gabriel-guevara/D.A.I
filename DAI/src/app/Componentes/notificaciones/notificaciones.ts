import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, exhaustMap, tap, timer } from 'rxjs';
import { CommonModule } from '@angular/common';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';
import { NotificacionesEstado } from '../../shared/notificaciones-estado';


type NotifCategory = 'todas' | 'consulta' | 'edicion' | 'version' | 'eliminado' | 'seguridad';

const CADA_MS = 5000;
const ZONA = 'America/Bogota';
const formatoHora = new Intl.DateTimeFormat('es-CO', {
  timeZone: ZONA, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});

interface NotifAction {
  label: string;
  style: 'border' | 'solid' | 'danger';
}

interface Notification {
  id: string;
  category: Exclude<NotifCategory, 'todas'>;
  borderColor: string;
  badge: string;
  badgeColor: string;
  icon: string;
  title: string;
  description: string;
  time: string;
  fecha: string; // fecha y hora de Colombia, ya formateada por el servidor
  creadoEn: string; // ISO, para calcular "hace X" en vivo
  meta: string[];
  actions: NotifAction[];
  read: boolean;
}

@Component({
  selector: 'app-notificaciones',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar],
  templateUrl: './notificaciones.html',
})
export class Notificaciones {
  activeTab = signal<NotifCategory>('todas');

  private api = inject(ApiService);
  private estado = inject(NotificacionesEstado);

  notifications = signal<Notification[]>([]);

  /** Reloj para que el "hace X min" avance solo, y última vez que se consultó al servidor. */
  ahora = signal(Date.now());
  ultimaActualizacion = signal<number | null>(null);
  ultimaHora = computed(() => {
    const t = this.ultimaActualizacion();
    return t === null ? '—' : formatoHora.format(t);
  });

  constructor() {
    // "Tiempo real": consulta al servidor cada 5 s (pausa si la pestaña no está visible).
    // exhaustMap evita que se amontonen peticiones si el servidor tarda en responder.
    timer(0, CADA_MS)
      .pipe(
        takeUntilDestroyed(),
        tap(() => this.ahora.set(Date.now())),
        exhaustMap(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return EMPTY;
          return this.api.notificaciones<Notification[]>().pipe(
            catchError((err) => {
              console.error('No se pudieron cargar las notificaciones', err);
              return EMPTY;
            }),
          );
        }),
      )
      .subscribe((lista) => this.aplicar(lista));
  }

  /**
   * Combina lo que llega del servidor con lo que ya se ve en pantalla.
   * Mientras el usuario está en este panel, el servidor marca todo como leído (el indicador rojo
   * de la barra lateral se apaga), pero aquí las notificaciones nuevas siguen resaltadas
   * hasta que se recargue la página o se pulse "Marcar como leída".
   */
  private aplicar(servidor: Notification[]): void {
    const previas = new Map(this.notifications().map((n) => [n.id, n]));
    this.notifications.set(
      servidor.map((n) => {
        const antes = previas.get(n.id);
        return antes ? { ...n, read: antes.read } : n;
      }),
    );
    this.ultimaActualizacion.set(Date.now());

    if (servidor.some((n) => !n.read)) {
      this.estado.limpiar();
      this.api.marcarTodasLeidas().subscribe({
        next: () => this.estado.refrescar(),
        error: (err) => console.error('No se pudieron marcar como leídas', err),
      });
    }
  }

  /** "Hace 3 min", calculado en el navegador con el reloj que avanza solo. */
  relativo(n: Notification): string {
    const seg = Math.max(0, Math.floor((this.ahora() - new Date(n.creadoEn).getTime()) / 1000));
    if (seg < 10) return 'Ahora mismo';
    if (seg < 60) return `Hace ${seg} s`;
    const min = Math.floor(seg / 60);
    if (min < 60) return `Hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `Hace ${h} h`;
    const d = Math.floor(h / 24);
    return d < 2 ? 'Ayer' : `Hace ${d} días`;
  }

  filtered = computed(() => {
    const tab = this.activeTab();
    const list = this.notifications();
    return tab === 'todas' ? list : list.filter((n) => n.category === tab);
  });

  counts = computed(() => {
    const list = this.notifications();
    return {
      todas: list.length,
      consulta: list.filter((n) => n.category === 'consulta').length,
      edicion: list.filter((n) => n.category === 'edicion').length,
      version: list.filter((n) => n.category === 'version').length,
      eliminado: list.filter((n) => n.category === 'eliminado').length,
      seguridad: list.filter((n) => n.category === 'seguridad').length,
    };
  });

  unreadCount = computed(() => this.notifications().filter((n) => !n.read).length);

  setTab(tab: NotifCategory): void {
    this.activeTab.set(tab);
  }

  markAsRead(id: string): void {
    this.notifications.update((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)));
    this.api.marcarLeida(id).subscribe({
      next: () => this.estado.refrescar(),
      error: (err) => console.error('No se pudo marcar como leída', err),
    });
  }

  markAllAsRead(): void {
    this.notifications.update((list) => list.map((n) => ({ ...n, read: true })));
    this.estado.limpiar();
    this.api.marcarTodasLeidas().subscribe({ error: (err) => console.error('No se pudieron marcar como leídas', err) });
  }

  actionButtonClass(style: NotifAction['style']): string {
    switch (style) {
      case 'solid':
        return 'bg-blue-900 hover:bg-blue-950 text-white';
      case 'danger':
        return 'bg-red-600 hover:bg-red-700 text-white';
      default:
        return 'border border-slate-200 text-slate-600 hover:bg-slate-50';
    }
  }
}
