import { Component, computed, effect, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';

type TipoDocumental = 'Contratos y Convenios' | 'Actas de Directorio' | 'Anexos Técnicos & GDPR' | 'Facturas y Comprobantes' | 'Informes de Auditoría';
type Clasificacion = 'Secreto Corporativo' | 'Confidencial Nivel 2' | 'Uso Interno General';
type Algoritmo = 'semantica' | 'exacta';

interface SearchResult {
  docId: string;
  title: string;
  badge: string;
  badgeColor: string;
  formatLabel: string;
  hashLabel: string;
  expediente: string;
  ruta: string;
  actualizado: string;
  pagina: string;
  score: string;
  before: string;
  highlight: string;
  after: string;
  responsable: string;
  extra: string;
  tipo: TipoDocumental;
  clasificacion: Clasificacion;
}

@Component({
  selector: 'app-busqueda',
  standalone: true,
  imports: [CommonModule, FormsModule,Barraizq , Navbar],
  templateUrl: './busqueda.html',
})
export class Busqueda {
  // Vacío por defecto: sin búsqueda, se muestran todos los documentos.
  searchText = signal('');
  appliedQuery = signal('');
  ocrEnabled = signal(true);
  algoritmo = signal<Algoritmo>('semantica');

  terminosFrecuentes = signal<string[]>([]);

  tiposDocumentales = signal<{ label: TipoDocumental; count: number }[]>([]);

  clasificaciones = signal<{ label: Clasificacion; color: string }[]>([]);

  selectedTipos = signal<Set<TipoDocumental>>(new Set());
  selectedClasificaciones = signal<Set<Clasificacion>>(new Set());

  results = signal<SearchResult[]>([]);

  filteredResults = computed(() => {
    // El texto de búsqueda ya lo filtra el servidor; aquí solo se aplican los filtros laterales
    const tipos = this.selectedTipos();
    const clasificaciones = this.selectedClasificaciones();

    return this.results().filter((r) => {
      const matchesTipo = tipos.size === 0 || tipos.has(r.tipo);
      const matchesClasificacion = clasificaciones.size === 0 || clasificaciones.has(r.clasificacion);
      return matchesTipo && matchesClasificacion;
    });
  });

  private router = inject(Router);
  private route = inject(ActivatedRoute);

  // Refleja el query param `q` (viene del buscador del navbar) en la barra de esta página.
  private queryParamMap = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  private api = inject(ApiService);
  private busquedaSub?: Subscription;

  constructor() {
    // Filtros laterales y términos frecuentes desde la BD
    this.api
      .facetasBusqueda<{
        tiposDocumentales: { label: TipoDocumental; count: number }[];
        clasificaciones: { label: Clasificacion; color: string }[];
        terminosFrecuentes: string[];
      }>()
      .subscribe({
        next: (f) => {
          this.tiposDocumentales.set(f.tiposDocumentales);
          this.clasificaciones.set(f.clasificaciones);
          this.terminosFrecuentes.set(f.terminosFrecuentes);
        },
        error: (err) => console.error('No se pudieron cargar los filtros', err),
      });

    // Se vuelve a buscar cuando cambia el `q` de la URL o el algoritmo elegido
    effect(() => {
      const q = this.queryParamMap().get('q') ?? '';
      this.searchText.set(q);
      this.appliedQuery.set(q);
      this.cargarResultados(q, this.algoritmo());
    });
  }

  private cargarResultados(q: string, algoritmo: Algoritmo): void {
    this.busquedaSub?.unsubscribe(); // descarta respuestas antiguas si el usuario sigue escribiendo
    this.busquedaSub = this.api.buscar<SearchResult[]>(q, algoritmo).subscribe({
      next: (r) => this.results.set(r),
      error: (err) => {
        console.error('Error en la búsqueda', err);
        this.results.set([]);
      },
    });
  }

  useTermino(term: string): void {
    this.searchText.set(term);
    this.performSearch();
  }

  performSearch(): void {
    const query = this.searchText().trim();
    this.appliedQuery.set(query);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: query || null },
      queryParamsHandling: 'merge',
    });
  }

  toggleOcr(): void {
    this.ocrEnabled.set(!this.ocrEnabled());
  }

  setAlgoritmo(algoritmo: Algoritmo): void {
    this.algoritmo.set(algoritmo);
  }

  toggleTipo(tipo: TipoDocumental): void {
    this.selectedTipos.update((set) => {
      const next = new Set(set);
      next.has(tipo) ? next.delete(tipo) : next.add(tipo);
      return next;
    });
  }

  toggleClasificacion(clasificacion: Clasificacion): void {
    this.selectedClasificaciones.update((set) => {
      const next = new Set(set);
      next.has(clasificacion) ? next.delete(clasificacion) : next.add(clasificacion);
      return next;
    });
  }

  resetFiltros(): void {
    this.selectedTipos.set(new Set());
    this.selectedClasificaciones.set(new Set());
  }

  abrirDocumento(docId: string): void {
    this.router.navigate(['/documento', docId]);
  }
}
