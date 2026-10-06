import { Component, OnDestroy, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../../shared/auth';

type LoginStep = 'credentials' | 'twofactor';
type TwoFactorMethod = 'totp' | 'yubikey' | 'sms';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
})
export class Login implements OnDestroy {

  // Esto es para el login de dos pasos, primero se ingresa usuario y contraseña, luego se ingresa el token de seguridad
  step = signal<LoginStep>('credentials');

  username = signal('');
  password = signal('');
  showPassword = signal(false);
  errorMessage = signal('');

  twoFactorMethod = signal<TwoFactorMethod>('totp');
  otpDigits = signal<string[]>(['', '', '', '', '', '']);
  countdown = signal(44);
  isVerifying = signal(false);
  isSubmitting = signal(false);

  // Token temporal que entrega el backend tras validar usuario/contraseña (se envía junto con el código 2FA)
  private mfaToken: string | null = null;

  // Timer para el countdown del token de seguridad
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  passwordStrength = computed(() => {
    const pwd = this.password();
    if (pwd.length === 0) return { label: '', percent: 0, color: '' };
    if (pwd.length < 6) return { label: 'Débil', percent: 33, color: 'bg-red-500' };
    if (pwd.length < 10) return { label: 'Media', percent: 66, color: 'bg-yellow-500' };
    return { label: 'Robusta', percent: 100, color: 'bg-emerald-500' };
  });

  // Esto es para el paso de credenciales y segundo factor
  otpComplete = computed(() => this.otpDigits().every((d) => d !== ''));

  constructor(private router: Router, private auth: AuthService) { }

  // Limpiar el timer aqui es donde se resetea me da pereza cambiarlo tons yo creo que por el momento esta bien asi
  ngOnDestroy(): void {
    this.clearCountdown();
  }

  togglePassword(): void {
    this.showPassword.set(!this.showPassword());
  }
  // Esta es la parte del segundo factor
  selectMethod(method: TwoFactorMethod): void {
    this.twoFactorMethod.set(method);
  }

  onSubmitCredentials(): void {
    this.errorMessage.set('');

    if (!this.username().trim() || !this.password().trim()) {
      this.errorMessage.set('Ingrese su usuario institucional y su contraseña.');
      return;
    }

    // Valida usuario y contraseña contra el backend (PostgreSQL). Si son correctos, pasa al segundo factor.
    this.isSubmitting.set(true);
    this.auth.login(this.username().trim(), this.password()).subscribe({
      next: ({ mfaToken }) => {
        this.mfaToken = mfaToken;
        this.isSubmitting.set(false);
        this.step.set('twofactor');
        this.startCountdown();
      },
      error: (err: HttpErrorResponse) => {
        this.isSubmitting.set(false);
        this.errorMessage.set(this.mensajeDeError(err));
      },
    });
  }

  // Inicia el countdown esta es la logica del conteo
  startCountdown(): void {
    this.clearCountdown();
    this.countdown.set(44);
    this.countdownTimer = setInterval(() => {
      const current = this.countdown();
      this.countdown.set(current <= 1 ? 44 : current - 1);
    }, 1000);
  }

  // Limpiar el timer
  private clearCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  // Aqui es donde se ingresan los numeros lo de borrar los numeros tambien esta raro pero como solo es para ejemplo esta bien
  onDigitInput(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/[^0-9]/g, '').slice(-1);

    const digits = [...this.otpDigits()];
    digits[index] = value;
    this.otpDigits.set(digits);

    if (value && index < 5) {
      const next = document.getElementById('otp-' + (index + 1)) as HTMLInputElement | null;
      next?.focus();
    }
  }

  // Esta es la logica de borrar los numeros
  onDigitKeydown(index: number, event: KeyboardEvent): void {
    if (event.key === 'Backspace' && !this.otpDigits()[index] && index > 0) {
      const prev = document.getElementById('otp-' + (index - 1)) as HTMLInputElement | null;
      prev?.focus();
    }
  }

  // Esta es la logica de verificar el token de seguridad y si es correcto te lleva al dashboard
  onVerify(): void {
    if (!this.otpComplete()) {
      this.errorMessage.set('Complete el código de verificación de 6 dígitos.');
      return;
    }

    this.isVerifying.set(true);
    this.errorMessage.set('');

    if (!this.mfaToken) {
      this.isVerifying.set(false);
      this.backToCredentials();
      return;
    }

    // El backend valida el código; si es correcto devuelve el token de sesión (JWT)
    this.auth.verify2fa(this.mfaToken, this.otpDigits().join('')).subscribe({
      next: () => {
        this.isVerifying.set(false);
        this.password.set('');
        this.router.navigate(['/dashboard']);
      },
      error: (err: HttpErrorResponse) => {
        this.isVerifying.set(false);
        if (err.error?.reiniciar) {
          this.backToCredentials(); // el token temporal venció: hay que repetir el paso 1
        } else {
          this.otpDigits.set(['', '', '', '', '', '']);
        }
        this.errorMessage.set(this.mensajeDeError(err));
      },
    });
  }

  private mensajeDeError(err: HttpErrorResponse): string {
    if (err.status === 0) return 'No se pudo conectar con el servidor. Verifique que la API esté en ejecución.';
    return err.error?.error ?? 'Ocurrió un error inesperado. Inténtelo de nuevo.';
  }

  backToCredentials(): void {
    this.clearCountdown();
    this.mfaToken = null;
    this.errorMessage.set('');
    this.otpDigits.set(['', '', '', '', '', '']);
    this.step.set('credentials');
  }
}
