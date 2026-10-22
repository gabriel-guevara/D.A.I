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
    <ol class="text-base text-ink-2 space-y-1.5 list-decimal pl-5 mb-5 marker:text-ink-3 marker:font-medium">
      <li>Abra una app autenticadora (Google Authenticator, Microsoft Authenticator, Authy…).</li>
      <li>Escanee el código QR o escriba la clave manual.</li>
      <li>Escriba el código de 6 dígitos que muestra la app para confirmar.</li>
    </ol>

    <div class="flex flex-col items-center gap-3">
      <app-qr-codigo [texto]="alta().otpauthUri" [tamano]="184" etiqueta="Código QR para la app autenticadora" />

      <div class="w-full rounded-lg bg-sunken border border-line p-3">
        <p class="text-sm text-ink-3 mb-1">Clave manual · cuenta <span class="font-medium text-ink-2">{{ alta().cuenta }}</span></p>
        <div class="flex items-center justify-between gap-2">
          <code class="code text-base text-ink tracking-wider">{{ claveAgrupada() }}</code>
          <button type="button" (click)="copiar()" class="btn btn-ghost btn-sm shrink-0 text-accent-ink">{{ copiado() ? 'Copiada' : 'Copiar' }}</button>
        </div>
        <p class="text-xs text-ink-3 mt-1">Tipo: basada en tiempo · 6 dígitos · 30 segundos · emisor {{ alta().emisor }}</p>
      </div>
      <p class="text-xs text-ink-3">Este código QR caduca en {{ alta().caducaEnMinutos }} minutos. No lo comparta con nadie.</p>
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
