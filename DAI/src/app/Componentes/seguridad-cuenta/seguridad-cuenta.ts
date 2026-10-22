import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { Icono } from '../ui/icono';
import { AltaDosPasos, ApiService, EstadoSeguridadCuenta, SegundoFactor } from '../../shared/api';
import { AuthService } from '../../shared/auth';
import { Alta2fa } from '../../shared/alta-2fa';
import { CodigosRecuperacion } from '../../shared/codigos-recuperacion';

/** Qué formulario de la tarjeta 2FA está abierto. */
type Panel2fa = 'ninguno' | 'reconfigurar' | 'codigos';

/** Lo que el usuario escribe como segundo factor: código de la app o de recuperación. */
interface FactorForm {
  usarRecuperacion: boolean;
  valor: string;
}

const MIN_CONTRASENA = 10; // el servidor manda la política real en /cuenta/seguridad; esto es solo el valor inicial

/** Convierte lo escrito en el cuerpo que espera la API, o devuelve el mensaje de error. */
function leerFactor(f: FactorForm): SegundoFactor | string {
  const v = f.valor.trim();
  if (f.usarRecuperacion) return /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(v) ? { codigoRecuperacion: v } : 'El código de recuperación tiene la forma XXXXX-XXXXX.';
  return /^\d{6}$/.test(v) ? { code: v } : 'Escriba el código de 6 dígitos de su app.';
}

@Component({
  selector: 'app-seguridad-cuenta',
  standalone: true,
  imports: [CommonModule, FormsModule, Barraizq, Navbar, Alta2fa, CodigosRecuperacion, Icono],
  templateUrl: './seguridad-cuenta.html',
})
export class SeguridadCuenta {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);

  estado = signal<EstadoSeguridadCuenta | null>(null);
  errorCarga = signal('');
  /** Llegó aquí tras entrar con un código de recuperación: cuántos le quedan. */
  avisoRecuperacion = signal<number | null>(null);

  // ------------------------------------------------------------------ 2FA
  panel = signal<Panel2fa>('ninguno');
  ocupado2fa = signal(false);
  error2fa = signal('');
  ok2fa = signal('');
  passwordReconf = signal('');
  factorReconf = signal<FactorForm>({ usarRecuperacion: false, valor: '' });
  alta = signal<AltaDosPasos | null>(null);
  codigoNuevaApp = signal('');
  factorCodigos = signal<FactorForm>({ usarRecuperacion: false, valor: '' });
  codigosNuevos = signal<string[]>([]);

  // ------------------------------------------------------------------ contraseña
  actual = signal('');
  nueva = signal('');
  repetir = signal('');
  verPassword = signal(false);
  factorPassword = signal<FactorForm>({ usarRecuperacion: false, valor: '' });
  ocupadoPassword = signal(false);
  errorPassword = signal('');
  okPassword = signal('');

  private minimo = computed(() => this.estado()?.politicaContrasena.minimo ?? MIN_CONTRASENA);

  /** Reglas en vivo (las mismas que valida el servidor, que es quien decide). */
  reglas = computed(() => {
    const p = this.nueva();
    return [
      { texto: `Entre ${this.minimo()} y 72 caracteres`, ok: p.length >= this.minimo() && new TextEncoder().encode(p).length <= 72 },
      { texto: 'Al menos una letra y un número', ok: /\p{L}/u.test(p) && /\d/.test(p) },
      { texto: 'Distinta de la actual', ok: !!p && p !== this.actual() },
      { texto: 'Las dos contraseñas nuevas coinciden', ok: !!p && p === this.repetir() },
    ];
  });

  pocosCodigos = computed(() => {
    const e = this.estado();
    return !!e && e.mfaActivo && e.codigosRestantes <= 3;
  });

  constructor() {
    const r = this.route.snapshot.queryParamMap.get('recuperacion');
    if (r !== null && /^\d+$/.test(r)) this.avisoRecuperacion.set(Number(r));
    this.cargar();
  }

  cargar(): void {
    this.api.seguridadCuenta().subscribe({
      next: (e) => this.estado.set(e),
      error: (err: HttpErrorResponse) => this.errorCarga.set(this.textoError(err, 'No se pudo cargar el estado de seguridad de su cuenta.')),
    });
  }

  private textoError(err: HttpErrorResponse, porDefecto = 'No se pudo completar la operación.'): string {
    if (err.status === 0) return 'No se pudo conectar con el servidor. Inténtelo de nuevo en unos segundos.';
    return err.error?.error ?? porDefecto;
  }

  parcheFactor(cual: 'reconf' | 'codigos' | 'password', cambios: Partial<FactorForm>): void {
    const s = cual === 'reconf' ? this.factorReconf : cual === 'codigos' ? this.factorCodigos : this.factorPassword;
    s.update((f) => ({ ...f, ...cambios, ...(cambios.usarRecuperacion !== undefined ? { valor: '' } : {}) }));
  }

  // ------------------------------------------------------------------ 2FA: abrir / cerrar paneles
  abrirPanel(p: Panel2fa): void {
    this.cerrarPanel();
    this.panel.set(p);
  }

  cerrarPanel(): void {
    this.panel.set('ninguno');
    this.error2fa.set('');
    this.ok2fa.set('');
    this.passwordReconf.set('');
    this.factorReconf.set({ usarRecuperacion: false, valor: '' });
    this.factorCodigos.set({ usarRecuperacion: false, valor: '' });
    this.alta.set(null);
    this.codigoNuevaApp.set('');
    this.codigosNuevos.set([]);
  }

  // ------------------------------------------------------------------ 2FA: cambiar de teléfono / app
  iniciarReconfiguracion(): void {
    const factor = leerFactor(this.factorReconf());
    if (!this.passwordReconf()) return this.error2fa.set('Ingrese su contraseña actual.');
    if (typeof factor === 'string') return this.error2fa.set(factor);
    this.ocupado2fa.set(true);
    this.error2fa.set('');
    this.api.iniciarReconfiguracion2fa(this.passwordReconf(), factor).subscribe({
      next: (a) => {
        this.ocupado2fa.set(false);
        this.passwordReconf.set('');
        this.alta.set(a);
      },
      error: (err: HttpErrorResponse) => {
        this.ocupado2fa.set(false);
        this.error2fa.set(this.textoError(err));
      },
    });
  }

  confirmarReconfiguracion(): void {
    const code = this.codigoNuevaApp().trim();
    if (!/^\d{6}$/.test(code)) return this.error2fa.set('Escriba el código de 6 dígitos que muestra la app NUEVA.');
    this.ocupado2fa.set(true);
    this.error2fa.set('');
    this.api.confirmarReconfiguracion2fa(code).subscribe({
      next: () => {
        this.ocupado2fa.set(false);
        this.cerrarPanel();
        this.ok2fa.set('Listo: desde ahora los códigos válidos son los de la app nueva. Puede borrar la cuenta DAI de la app anterior.');
        this.avisoRecuperacion.set(null);
        this.cargar();
      },
      error: (err: HttpErrorResponse) => {
        this.ocupado2fa.set(false);
        if (err.error?.nuevoQr) this.alta.set(null);
        this.codigoNuevaApp.set('');
        this.error2fa.set(this.textoError(err));
      },
    });
  }

  // ------------------------------------------------------------------ 2FA: códigos de recuperación
  regenerarCodigos(): void {
    const factor = leerFactor(this.factorCodigos());
    if (typeof factor === 'string') return this.error2fa.set(factor);
    this.ocupado2fa.set(true);
    this.error2fa.set('');
    this.api.regenerarCodigosRecuperacion(factor).subscribe({
      next: ({ codigosRecuperacion }) => {
        this.ocupado2fa.set(false);
        this.factorCodigos.set({ usarRecuperacion: false, valor: '' });
        this.codigosNuevos.set(codigosRecuperacion);
        this.cargar();
      },
      error: (err: HttpErrorResponse) => {
        this.ocupado2fa.set(false);
        this.error2fa.set(this.textoError(err));
      },
    });
  }

  // ------------------------------------------------------------------ contraseña
  cambiarContrasena(): void {
    this.errorPassword.set('');
    this.okPassword.set('');
    if (!this.actual()) return this.errorPassword.set('Ingrese su contraseña actual.');
    const pendiente = this.reglas().find((r) => !r.ok);
    if (pendiente) return this.errorPassword.set(`Revise la nueva contraseña: ${pendiente.texto.toLowerCase()}.`);
    const factor = leerFactor(this.factorPassword());
    if (typeof factor === 'string') return this.errorPassword.set(factor);

    this.ocupadoPassword.set(true);
    this.api.cambiarContrasena(this.actual(), this.nueva(), factor).subscribe({
      next: ({ token }) => {
        this.ocupadoPassword.set(false);
        this.auth.renovarToken(token); // esta pestaña sigue con sesión; las demás quedaron cerradas
        this.actual.set('');
        this.nueva.set('');
        this.repetir.set('');
        this.factorPassword.set({ usarRecuperacion: false, valor: '' });
        this.okPassword.set('Contraseña actualizada. Por seguridad se cerraron sus sesiones en otros equipos.');
        this.cargar();
      },
      error: (err: HttpErrorResponse) => {
        this.ocupadoPassword.set(false);
        this.parcheFactor('password', { valor: '' });
        this.errorPassword.set(this.textoError(err));
      },
    });
  }
}
