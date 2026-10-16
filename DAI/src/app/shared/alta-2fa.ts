import { Component, computed, input, signal } from '@angular/core';
import { AltaDosPasos } from './api';
import { QrCodigo } from './qr-codigo';

/**
 * Panel para configurar la app autenticadora: QR + clave manual (para quien no puede escanear).
 * Es solo de presentación: el código de confirmación lo pide y envía el componente padre (login o Mi cuenta).
 */
@Component({
  selector: 'app-alta-2fa',
  standalone: true,
  imports: [QrCodigo],
  template: `
    <ol class="text-[13px] text-slate-600 space-y-1 list-decimal pl-5 mb-4">
      <li>Abra una app autenticadora (Google Authenticator, Microsoft Authenticator, Authy…).</li>
      <li>Escanee el código QR o escriba la clave manual.</li>
      <li>Escriba el código de 6 dígitos que muestra la app para confirmar.</li>
    </ol>

    <div class="flex flex-col items-center gap-3">
      <app-qr-codigo [texto]="alta().otpauthUri" [tamano]="184" etiqueta="Código QR para la app autenticadora" />

      <div class="w-full rounded-lg bg-slate-50 border border-slate-200 p-3">
        <p class="text-[12px] text-slate-500 mb-1">Clave manual · cuenta <span class="font-medium text-slate-700">{{ alta().cuenta }}</span></p>
        <div class="flex items-center justify-between gap-2">
          <code class="font-mono text-[13px] text-slate-800 tracking-wider">{{ claveAgrupada() }}</code>
          <button type="button" (click)="copiar()"
            class="shrink-0 text-[12px] font-medium text-blue-700 hover:underline">{{ copiado() ? 'Copiada' : 'Copiar' }}</button>
        </div>
        <p class="text-[11px] text-slate-400 mt-1">Tipo: basada en tiempo · 6 dígitos · 30 segundos · emisor {{ alta().emisor }}</p>
      </div>
      <p class="text-[11px] text-slate-400">Este código QR caduca en {{ alta().caducaEnMinutos }} minutos. No lo comparta con nadie.</p>
    </div>
  `,
})
export class Alta2fa {
  alta = input.required<AltaDosPasos>();
  copiado = signal(false);

  /** "JBSW Y3DP EHPK ..." es más fácil de transcribir que 32 letras seguidas. */
  claveAgrupada = computed(() => this.alta().secreto.replace(/(.{4})/g, '$1 ').trim());

  copiar(): void {
    navigator.clipboard?.writeText(this.alta().secreto).then(
      () => this.copiado.set(true),
      () => this.copiado.set(false),
    );
  }
}
