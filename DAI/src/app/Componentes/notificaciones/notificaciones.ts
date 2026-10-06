import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';


type NotifCategory = 'todas' | 'edicion' | 'version' | 'eliminado' | 'seguridad';

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

  constructor() {
    this.api.notificaciones<Notification[]>().subscribe({
      next: (n) => this.notifications.set(n),
      error: (err) => console.error('No se pudieron cargar las notificaciones', err),
    });
  }

  notifications = signal<Notification[]>([]);

  filtered = computed(() => {
    const tab = this.activeTab();
    const list = this.notifications();
    return tab === 'todas' ? list : list.filter((n) => n.category === tab);
  });

  counts = computed(() => {
    const list = this.notifications();
    return {
      todas: list.length,
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
    this.api.marcarLeida(id).subscribe({ error: (err) => console.error('No se pudo marcar como leída', err) });
  }

  markAllAsRead(): void {
    this.notifications.update((list) => list.map((n) => ({ ...n, read: true })));
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
