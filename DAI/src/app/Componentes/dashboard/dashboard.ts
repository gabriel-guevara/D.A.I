import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../shared/auth';
import { ApiService } from '../../shared/api';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';

// Interfaces para los documentos y las tarjetas de estadísticas
interface DocRow {
  id: string;
  name: string;
  category: string;
  categoryColor: string;
  user: string;
  time: string;
  size: string;
}

interface StatCard {
  label: string;
  value: string;
  sub: string;
  accent: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar],
  templateUrl: './dashboard.html',
})
// Son los label que aparecen en la parte superior de la pagina principal del dashboard, con sus respectivos valores y subtextos.
export class Dashboard {
  stats = signal<StatCard[]>([]);

  // Son los documentos que aparecen en la parte inferior de la pagina principal del dashboard
  documents = signal<DocRow[]>([]);

  // Constructor que inyecta el servicio de enrutamiento y el servicio de autenticación
  constructor(private router: Router, public auth: AuthService, private api: ApiService) {
    this.api.dashboard<{ stats: StatCard[]; documents: DocRow[] }>().subscribe({
      next: (d) => {
        this.stats.set(d.stats);
        this.documents.set(d.documents);
      },
      error: (err) => console.error('No se pudo cargar el dashboard', err),
    });
  }

    goToBiblioteca(): void {
    this.router.navigate(['/biblioteca']);
  }


  openDocument(doc: DocRow): void {
    this.router.navigate(['/documento', doc.id]);
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
