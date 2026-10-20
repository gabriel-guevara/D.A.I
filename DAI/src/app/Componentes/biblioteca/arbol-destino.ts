import { Component, computed, input, model, signal } from '@angular/core';
import type { CarpetaPlana } from '../../shared/api';
import { FilaArbol, filasArbol } from './arbol-carpetas';

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
  template: `
    <div class="border border-slate-200 rounded-lg max-h-72 overflow-y-auto py-1" role="radiogroup" [attr.aria-label]="etiqueta()">
      @for (f of filas(); track f.id ?? 'raiz') {
        <div class="flex items-center gap-1 pr-2 py-0.5" [style.padding-left.px]="8 + f.nivel * 18"
          [class.bg-blue-50]="seleccion() === f.id">
          @if (f.tieneHijas && f.id) {
            <button type="button" (click)="plegar(f.id)" class="w-5 h-5 shrink-0 rounded text-[12px] text-slate-500 hover:bg-slate-100"
              [attr.aria-expanded]="!f.plegada" [attr.aria-label]="(f.plegada ? 'Mostrar' : 'Ocultar') + ' las subcarpetas de ' + f.nombre">
              {{ f.plegada ? '▸' : '▾' }}
            </button>
          } @else {
            <span class="w-5 shrink-0"></span>
          }
          <label class="flex-1 min-w-0 flex items-center gap-2 text-[13px] py-1"
            [class]="f.deshabilitada ? 'text-slate-400 cursor-not-allowed' : 'text-slate-700 cursor-pointer'">
            <input type="radio" [name]="nombreGrupo" class="shrink-0" [checked]="seleccion() === f.id" [disabled]="f.deshabilitada"
              (change)="seleccion.set(f.id)" [attr.aria-describedby]="f.motivo ? nombreGrupo + '-' + (f.id ?? 'raiz') : null" />
            <span class="truncate">{{ f.id ? '📁' : '🏠' }} {{ f.nombre }}</span>
            @if (f.id === actual()) {
              <span class="text-[12px] text-slate-400 shrink-0">(ubicación actual)</span>
            }
            @if (f.motivo) {
              <span class="text-[12px] text-slate-400 shrink-0" [id]="nombreGrupo + '-' + (f.id ?? 'raiz')">— {{ f.motivo }}</span>
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
