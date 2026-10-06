import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../shared/api';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';

interface LibraryDoc {
  id: string;
  name: string;
  version: string;
  format: 'pdf' | 'xlsx' | 'docx' | 'tiff';
  hashLabel: string;
  folio: string;
  departamento: string;
  departamentoColor: string;
  autor: string;
  autorEmail: string;
  tamano: string;
  selected: boolean;
}

@Component({
  selector: 'app-biblioteca',
  standalone: true,
  imports: [CommonModule, FormsModule, Barraizq, Navbar],
  templateUrl: './biblioteca.html',
})
export class Biblioteca {
  searchText = signal('');
  activeFilters = signal<string[]>(['Últimos 30 días', 'Auditoría 2024', 'Confidencial', 'OCR Procesado']);

  documents = signal<LibraryDoc[]>([]);

  // Documentos visibles según el texto de búsqueda (por nombre o folio).
  visibleDocuments = computed(() => {
    const term = this.searchText().trim().toLowerCase();
    if (!term) return this.documents();
    return this.documents().filter(
      (d) => d.name.toLowerCase().includes(term) || d.folio.toLowerCase().includes(term)
    );
  });

  selectedCount = computed(() => this.documents().filter((d) => d.selected).length);
  allSelected = computed(
    () => this.visibleDocuments().length > 0 && this.visibleDocuments().every((d) => d.selected)
  );

  constructor(private router: Router, private api: ApiService) {
    this.cargarDocumentos();
  }

  /** Carga la lista desde el backend (PostgreSQL). `selected` es solo estado de la interfaz. */
  private cargarDocumentos(): void {
    this.api.biblioteca<Omit<LibraryDoc, 'selected'>[]>().subscribe({
      next: (docs) => this.documents.set(docs.map((d) => ({ ...d, selected: false }))),
      error: (err) => console.error('No se pudo cargar la biblioteca', err),
    });
  }

  toggleSelectAll(): void {
    const newState = !this.allSelected();
    const visibleIds = new Set(this.visibleDocuments().map((d) => d.id));
    this.documents.update((docs) =>
      docs.map((d) => (visibleIds.has(d.id) ? { ...d, selected: newState } : d))
    );
  }

  toggleSelectDoc(doc: LibraryDoc): void {
    this.documents.update((docs) =>
      docs.map((d) => (d.id === doc.id ? { ...d, selected: !d.selected } : d))
    );
  }

  removeFilter(filter: string): void {
    this.activeFilters.update((filters) => filters.filter((f) => f !== filter));
  }

  clearFilters(): void {
    this.activeFilters.set([]);
  }

  clearSelection(): void {
    this.documents.update((docs) => docs.map((d) => ({ ...d, selected: false })));
  }

  /** Al hacer clic en un documento, se navega a su visualización (no hay preview inline). */
  openDocument(doc: LibraryDoc): void {
    this.router.navigate(['/documento', doc.id]);
  }

  formatIconClass(format: LibraryDoc['format']): string {
    switch (format) {
      case 'pdf':
        return 'bg-red-50 text-red-600';
      case 'xlsx':
        return 'bg-emerald-50 text-emerald-600';
      case 'docx':
        return 'bg-blue-50 text-blue-600';
      case 'tiff':
        return 'bg-amber-50 text-amber-600';
    }
  }
}
