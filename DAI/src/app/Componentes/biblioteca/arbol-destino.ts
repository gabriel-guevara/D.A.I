import { Component, computed, input, model, signal } from '@angular/core';
import type { CarpetaPlana } from '../../shared/api';
import { FilaArbol, filasArbol } from './arbol-carpetas';
import { Icono } from '../ui/icono';

let siguienteId = 0;

/**
 * Árbol de carpetas de destino para "Mover", "Solicitar movimiento" y "Mover carpeta" (sin arrastrar y soltar).
 *
 * Cada carpeta es un botón de opción (radio) nativo dentro de un grupo: el navegador ya da la accesibilidad con
 * teclado (Tab entra al grupo, las flechas recorren las opciones saltándose las deshabilitadas) y el lector de
 * pantalla anuncia "botón de opción, 3 de 9". La sangría dibuja el árbol y cada rama se puede plegar.
 */
@Component({
  selector: 'app-arbol-destino',
  standalone: true,
  imports: [Icono],
  template: `
    <div class="border border-line rounded-lg bg-surface max-h-72 overflow-y-auto p-1" role="radiogroup" [attr.aria-label]="etiqueta()">
      @for (f of filas(); track f.id ?? 'raiz') {
        <div class="flex items-center gap-1 pr-2 rounded-md transition-colors" [style.padding-left.px]="4 + f.nivel * 18"
          [class]="seleccion() === f.id ? 'bg-accent-soft' : 'hover:bg-sunken'">
          @if (f.tieneHijas && f.id) {
            <button type="button" (click)="plegar(f.id)" class="w-6 h-6 shrink-0 grid place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
              [attr.aria-expanded]="!f.plegada" [attr.aria-label]="(f.plegada ? 'Mostrar' : 'Ocultar') + ' las subcarpetas de ' + f.nombre">
              <app-icono [nombre]="f.plegada ? 'chevron-derecha' : 'chevron-abajo'" [tamano]="14" />
            </button>
          } @else {
            <span class="w-6 shrink-0"></span>
          }
          <label class="flex-1 min-w-0 flex items-center gap-2 text-base py-1.5"
            [class]="f.deshabilitada ? 'text-ink-3 opacity-70 cursor-not-allowed' : 'text-ink cursor-pointer'">
            <input type="radio" [name]="nombreGrupo" class="shrink-0" [checked]="seleccion() === f.id" [disabled]="f.deshabilitada"
              (change)="seleccion.set(f.id)" [attr.aria-describedby]="f.motivo ? nombreGrupo + '-' + (f.id ?? 'raiz') : null" />
            <app-icono [nombre]="f.id ? 'carpeta' : 'casa'" [tamano]="16" [class]="f.deshabilitada ? '' : 'text-accent'" />
            <span class="truncate">{{ f.nombre }}</span>
            @if (f.id === actual()) {
              <span class="text-xs text-ink-3 shrink-0">(ubicación actual)</span>
            }
            @if (f.motivo) {
              <span class="text-xs text-ink-3 shrink-0" [id]="nombreGrupo + '-' + (f.id ?? 'raiz')">— {{ f.motivo }}</span>
            }
          </label>
        </div>
      }
    </div>
  `,
})
export class ArbolDestino {
  /** Lista plana de GET /carpetas/arbol. */
  carpetas = input.required<CarpetaPlana[]>();
  maxNivel = input(5);
  /** Carpeta que se mueve (null al mover documentos): ella, sus descendientes y los destinos sin espacio no se eligen. */
  movida = input<string | null>(null);
  /** Dónde está ahora lo que se mueve (null = Inicio; undefined = varias ubicaciones o no se sabe). */
  actual = input<string | null | undefined>(undefined);
  etiqueta = input('Carpeta de destino');
  /** Destino elegido: id, null = Inicio, undefined = sin elegir. */
  seleccion = model<string | null | undefined>(undefined);

  readonly nombreGrupo = `arbol-destino-${++siguienteId}`;
  private plegadas = signal<ReadonlySet<string>>(new Set());

  filas = computed<FilaArbol[]>(() =>
    filasArbol(this.carpetas(), { maxNivel: this.maxNivel(), movida: this.movida(), plegadas: this.plegadas() }));

  plegar(id: string): void {
    this.plegadas.update((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
}
