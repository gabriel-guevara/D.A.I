import { Component, computed, input, signal } from '@angular/core';

type ModuloQr = typeof import('./qr');

/**
 * Dibuja un código QR como SVG (nítido a cualquier tamaño, sin imágenes externas).
 * El generador (./qr) se descarga con import() dinámico la primera vez que se necesita: solo lo usa quien
 * configura su 2FA, así que no pesa en el arranque de la app para el resto.
 */
@Component({
  selector: 'app-qr-codigo',
  standalone: true,
  template: `
    @if (qr(); as q) {
      <svg [attr.viewBox]="'0 0 ' + q.lado + ' ' + q.lado" [attr.width]="tamano()" [attr.height]="tamano()"
        shape-rendering="crispEdges" role="img" [attr.aria-label]="etiqueta()" class="bg-white rounded-lg border border-line">
        <rect [attr.width]="q.lado" [attr.height]="q.lado" fill="#ffffff"></rect>
        <path [attr.d]="q.d" fill="#0f172a"></path>
      </svg>
    } @else {
      <div class="skeleton flex items-center justify-center text-xs text-ink-3 border border-line"
        [style.width.px]="tamano()" [style.height.px]="tamano()">Generando QR…</div>
    }
  `,
})
export class QrCodigo {
  texto = input.required<string>();
  tamano = input(200);
  etiqueta = input('Código QR');

  private modulo = signal<ModuloQr | null>(null);

  constructor() {
    import('./qr').then((m) => this.modulo.set(m));
  }

  qr = computed(() => {
    const m = this.modulo();
    return m ? m.trazadoSvgQr(m.generarQr(this.texto())) : null;
  });
}
