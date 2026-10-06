import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';

interface DocDetalle {
  id: string;
  nombre: string;
  version: string;
  folio: string;
  departamento: string | null;
  clasificacion: string | null;
  hash: string | null;
  autorLinea: string;
  fechaCreacion: string;
  tamano: string;
  paginas: number;
  etiquetas: string[];
  retencion: string | null;
  firmadoPor: string | null;
}

@Component({
  selector: 'app-document-detail',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar],
  templateUrl: './detalles.html',
})
export class detalles {
  documentId = signal<string | null>(null);
  doc = signal<DocDetalle | null>(null);
  error = signal('');
  currentPage = signal(1);
  totalPages = signal(18);
  zoom = signal(100);

  constructor(private route: ActivatedRoute, private router: Router, private api: ApiService) {
    const id = this.route.snapshot.paramMap.get('id');
    this.documentId.set(id);
    if (!id) return;

    this.api.documento<DocDetalle>(id).subscribe({
      next: (d) => {
        this.doc.set(d);
        this.totalPages.set(d.paginas);
      },
      error: (err) =>
        this.error.set(err.status === 404 ? 'Documento no encontrado o sin permisos de acceso.' : 'No se pudo cargar el documento.'),
    });
  }

  backToDashboard(): void {
    this.router.navigate(['/dashboard']);
  }

  prevPage(): void {
    if (this.currentPage() > 1) this.currentPage.set(this.currentPage() - 1);
  }

  nextPage(): void {
    if (this.currentPage() < this.totalPages()) this.currentPage.set(this.currentPage() + 1);
  }

  zoomIn(): void {
    this.zoom.set(Math.min(200, this.zoom() + 10));
  }

  zoomOut(): void {
    this.zoom.set(Math.max(50, this.zoom() - 10));
  }
}
