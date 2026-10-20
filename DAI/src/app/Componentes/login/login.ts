import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../../shared/auth';
import { AltaDosPasos, ApiService, SegundoFactor } from '../../shared/api';
import { Alta2fa } from '../../shared/alta-2fa';
import { CodigosRecuperacion } from '../../shared/codigos-recuperacion';

/**
 * Login en dos pasos con 2FA TOTP real:
 *  credentials → twofactor (ya tiene 2FA)            → dashboard
 *  credentials → enrolar (no tiene 2FA: obligatorio) → codigos (recuperación, una vez) → dashboard
 */
type LoginStep = 'credentials' | 'twofactor' | 'enrolar' | 'codigos';

const PASO_TOTP_S = 30;
/** Desfase a partir del cual se avisa que la hora del computador está mal (la del teléfono suele ser automática). */
const AVISO_DESFASE_S = 10;
const DIGITOS_VACIOS = ['', '', '', '', '', ''];

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, Alta2fa, CodigosRecuperacion],
  templateUrl: './login.html',
})
export class Login implements OnDestroy {
  private router = inject(Router);
  private auth = inject(AuthService);
  private api = inject(ApiService);

  step = signal<LoginStep>('credentials');

  username = signal('');
  password = signal('');
  showPassword = signal(false);
  errorMessage = signal('');

  // Debe declararse antes de "countdown", que la usa al inicializarse.
  /** ms que hay que sumar a Date.now() para obtener la hora del servidor. */
  private desfaseMs = 0;
  otpDigits = signal<string[]>([...DIGITOS_VACIOS]);
  /** Segundos que le quedan al código actual de la app (los códigos TOTP cambian cada 30 s, a la vez en todo el mundo). */
  countdown = signal(this.segundosRestantes());
  /** Segundos que el reloj de este computador va adelantado (+) o atrasado (−) respecto al servidor. */
  desfaseSegundos = signal(0);
  relojDesfasado = computed(() => Math.abs(this.desfaseSegundos()) >= AVISO_DESFASE_S);
  isVerifying = signal(false);
  isSubmitting = signal(false);

  // Paso 2 con código de recuperación (perdió el teléfono)
  usarRecuperacion = signal(false);
  codigoRecuperacion = signal('');

  // Alta obligatoria
  alta = signal<AltaDosPasos | null>(null);
  cargandoAlta = signal(false);
  codigosNuevos = signal<string[]>([]);
  codigosGuardados = signal(false);

  // Tokens temporales que entrega el backend tras la contraseña (no se guardan en ningún almacenamiento)
  private mfaToken: string | null = null;
  private enrolToken: string | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  otpComplete = computed(() => this.otpDigits().every((d) => d !== ''));

  ngOnDestroy(): void {
    this.clearCountdown();
  }

  togglePassword(): void {
    this.showPassword.set(!this.showPassword());
  }

  onSubmitCredentials(): void {
    this.errorMessage.set('');
    if (!this.username().trim() || !this.password().trim()) {
      this.errorMessage.set('Ingrese su correo corporativo y su contraseña.');
      return;
    }

    this.isSubmitting.set(true);
    const enviado = Date.now();
    this.auth.login(this.username().trim(), this.password()).subscribe({
      next: (r) => {
        this.isSubmitting.set(false);
        this.sincronizarReloj(r.ahora, enviado, Date.now());
        this.password.set(''); // ya no hace falta en memoria
        this.otpDigits.set([...DIGITOS_VACIOS]);
        if (r.paso === '2fa') {
          this.mfaToken = r.mfaToken;
          this.step.set('twofactor');
        } else {
          this.enrolToken = r.enrolToken;
          this.step.set('enrolar');
          this.generarQr();
        }
        this.startCountdown();
        this.enfocarPrimerDigito();
      },
      error: (err: HttpErrorResponse) => {
        this.isSubmitting.set(false);
        this.errorMessage.set(this.mensajeDeError(err));
      },
    });
  }

  // ------------------------------------------------------------------ contador real del código TOTP
  /**
   * Los códigos TOTP cambian cada 30 s según la hora REAL. El teléfono la toma de la red; el computador puede
   * estar desfasado. Se usa la hora del servidor: su respuesta llegó, en promedio, a mitad del viaje de ida y vuelta.
   */
  sincronizarReloj(ahoraServidor: number | undefined, enviado: number, recibido: number): void {
    if (typeof ahoraServidor !== 'number' || !Number.isFinite(ahoraServidor)) return;
    this.desfaseMs = ahoraServidor + (recibido - enviado) / 2 - recibido;
    this.desfaseSegundos.set(Math.round(-this.desfaseMs / 1000));
    this.countdown.set(this.segundosRestantes());
  }

  private segundosRestantes(): number {
    const ahora = Date.now() + this.desfaseMs;
    return PASO_TOTP_S - (Math.floor(ahora / 1000) % PASO_TOTP_S);
  }

  startCountdown(): void {
    this.clearCountdown();
    this.countdown.set(this.segundosRestantes());
    // Cada 250 ms: con 1 s el número podía ir hasta un segundo por detrás del de la app.
    this.countdownTimer = setInterval(() => this.countdown.set(this.segundosRestantes()), 250);
  }

  private clearCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  // ------------------------------------------------------------------ casillas del código de 6 dígitos
  onDigitInput(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/[^0-9]/g, '').slice(-1);
    const digits = [...this.otpDigits()];
    digits[index] = value;
    this.otpDigits.set(digits);
    input.value = value;
    if (value && index < 5) (document.getElementById('otp-' + (index + 1)) as HTMLInputElement | null)?.focus();
  }

  onDigitKeydown(index: number, event: KeyboardEvent): void {
    if (event.key === 'Backspace' && !this.otpDigits()[index] && index > 0) {
      (document.getElementById('otp-' + (index - 1)) as HTMLInputElement | null)?.focus();
    }
    if (event.key === 'Enter' && this.otpComplete()) this.enviarCodigo();
  }

  /** Pegar "123456" (copiado de la app) llena las 6 casillas de una vez. */
  onDigitPaste(event: ClipboardEvent): void {
    const pegado = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '');
    if (pegado.length < 6) return;
    event.preventDefault();
    this.otpDigits.set(pegado.slice(0, 6).split(''));
    (document.getElementById('otp-5') as HTMLInputElement | null)?.focus();
  }

  private enfocarPrimerDigito(): void {
    setTimeout(() => (document.getElementById('otp-0') as HTMLInputElement | null)?.focus());
  }

  private limpiarDigitos(): void {
    this.otpDigits.set([...DIGITOS_VACIOS]);
    this.enfocarPrimerDigito();
  }

  /** Botón principal del paso actual (verificar el 2FA o confirmar el alta). */
  enviarCodigo(): void {
    if (this.step() === 'enrolar') this.confirmarAlta();
    else this.onVerify();
  }

  // ------------------------------------------------------------------ paso 2: verificar
  toggleRecuperacion(): void {
    this.usarRecuperacion.set(!this.usarRecuperacion());
    this.codigoRecuperacion.set('');
    this.errorMessage.set('');
  }

  onVerify(): void {
    let factor: SegundoFactor;
    if (this.usarRecuperacion()) {
      const c = this.codigoRecuperacion().trim();
      if (!/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(c)) {
        this.errorMessage.set('El código de recuperación tiene la forma XXXXX-XXXXX.');
        return;
      }
      factor = { codigoRecuperacion: c };
    } else {
      if (!this.otpComplete()) {
        this.errorMessage.set('Complete el código de verificación de 6 dígitos.');
        return;
      }
      factor = { code: this.otpDigits().join('') };
    }
    if (!this.mfaToken) return this.backToCredentials();

    this.isVerifying.set(true);
    this.errorMessage.set('');
    this.auth.verify2fa(this.mfaToken, factor).subscribe({
      next: (r) => {
        this.isVerifying.set(false);
        // Entró con un código de recuperación: se le lleva a "Seguridad de mi cuenta" para que configure
        // un autenticador nuevo y vea cuántos códigos le quedan.
        if (r.codigosRestantes !== undefined) {
          this.router.navigate(['/cuenta/seguridad'], { queryParams: { recuperacion: r.codigosRestantes } });
        } else {
          this.router.navigate(['/dashboard']);
        }
      },
      error: (err: HttpErrorResponse) => {
        this.isVerifying.set(false);
        if (err.error?.reiniciar) this.backToCredentials();
        else this.limpiarDigitos();
        this.errorMessage.set(this.mensajeDeError(err));
      },
    });
  }

  // ------------------------------------------------------------------ alta obligatoria
  generarQr(): void {
    if (!this.enrolToken) return this.backToCredentials();
    this.cargandoAlta.set(true);
    this.alta.set(null);
    this.api.iniciarAlta2fa(this.enrolToken).subscribe({
      next: (a) => {
        this.cargandoAlta.set(false);
        this.alta.set(a);
      },
      error: (err: HttpErrorResponse) => {
        this.cargandoAlta.set(false);
        if (err.error?.reiniciar) this.backToCredentials();
        this.errorMessage.set(this.mensajeDeError(err));
      },
    });
  }

  confirmarAlta(): void {
    if (!this.otpComplete()) {
      this.errorMessage.set('Escriba el código de 6 dígitos que muestra su app.');
      return;
    }
    if (!this.enrolToken) return this.backToCredentials();
    this.isVerifying.set(true);
    this.errorMessage.set('');
    this.auth.confirmarAlta(this.enrolToken, this.otpDigits().join('')).subscribe({
      next: (r) => {
        this.isVerifying.set(false);
        this.alta.set(null); // el secreto deja de estar en pantalla y en memoria
        this.enrolToken = null;
        this.clearCountdown();
        this.codigosNuevos.set(r.codigosRecuperacion ?? []);
        this.step.set('codigos');
      },
      error: (err: HttpErrorResponse) => {
        this.isVerifying.set(false);
        if (err.error?.reiniciar) return this.backToCredentials(this.mensajeDeError(err));
        if (err.error?.nuevoQr) this.generarQr();
        this.limpiarDigitos();
        this.errorMessage.set(this.mensajeDeError(err));
      },
    });
  }

  continuarTrasCodigos(): void {
    this.codigosNuevos.set([]);
    this.router.navigate(['/dashboard']);
  }

  private mensajeDeError(err: HttpErrorResponse): string {
    if (err.status === 0) return 'No se pudo conectar con el servidor. Verifique que la API esté en ejecución.';
    return err.error?.error ?? 'Ocurrió un error inesperado. Inténtelo de nuevo.';
  }

  backToCredentials(mensaje = ''): void {
    this.clearCountdown();
    this.mfaToken = null;
    this.enrolToken = null;
    this.alta.set(null);
    this.usarRecuperacion.set(false);
    this.codigoRecuperacion.set('');
    this.errorMessage.set(mensaje);
    this.otpDigits.set([...DIGITOS_VACIOS]);
    this.step.set('credentials');
  }
}
