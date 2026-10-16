import { Component, input, signal } from '@angular/core';

/**
 * Muestra los códigos de recuperación UNA sola vez (el servidor solo guarda su huella y no puede volver a
 * mostrarlos). Permite copiarlos o descargarlos en un .txt para guardarlos fuera del teléfono.
 */
@Component({
  selector: 'app-codigos-recuperacion',
  standalone: true,
  template: `
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800 mb-3">
      Guarde estos códigos en un lugar seguro (gestor de contraseñas o impresos). Cada uno sirve
      <strong>una sola vez</strong> para entrar si pierde su teléfono. No se volverán a mostrar.
    </div>
    <ul class="grid grid-cols-2 gap-2 mb-3" aria-label="Códigos de recuperación">
      @for (c of codigos(); track c) {
        <li class="font-mono text-[13px] text-slate-800 bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 text-center tracking-wider">{{ c }}</li>
      }
    </ul>
    <div class="flex flex-wrap gap-2">
      <button type="button" (click)="copiar()"
        class="text-[13px] border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 hover:bg-slate-50">
        {{ copiado() ? 'Copiados' : 'Copiar' }}
      </button>
      <button type="button" (click)="descargar()"
        class="text-[13px] border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 hover:bg-slate-50">
        Descargar .txt
      </button>
    </div>
  `,
})
export class CodigosRecuperacion {
  codigos = input.required<string[]>();
  cuenta = input('');
  copiado = signal(false);

  private texto(): string {
    return [`Códigos de recuperación DAI ${this.cuenta()}`.trim(), '(cada uno sirve una sola vez)', '', ...this.codigos()].join('\n');
  }

  copiar(): void {
    navigator.clipboard?.writeText(this.texto()).then(
      () => this.copiado.set(true),
      () => this.copiado.set(false),
    );
  }

  descargar(): void {
    const url = URL.createObjectURL(new Blob([this.texto()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dai-codigos-recuperacion.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
}
