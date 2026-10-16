import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService, RespuestaLogin, SegundoFactor, SesionAbierta } from './api';

export interface CurrentUser {
  name: string;
  role: string;
  email: string;
  rolClave?: string; // 'super-admin' | 'compliance' | 'ocr-operator' | 'read-only'
  nivel?: string;
}

const TOKEN_KEY = 'dai_token';
const USER_KEY = 'dai_user';

/** Lee de sessionStorage sin romper si no está disponible. */
function leer(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

/**
 * Estado de la sesión (signals) y los pasos del login que la ABREN. Las peticiones HTTP las hace ApiService
 * (único punto HTTP); este servicio solo decide qué guardar cuando el servidor entrega un token.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(ApiService);

  // Estado de sesión expuesto como signals de solo lectura
  private _token = signal<string | null>(leer(TOKEN_KEY));
  private _currentUser = signal<CurrentUser | null>(this.restaurarUsuario());

  token = this._token.asReadonly();
  isAuthenticated = computed(() => this._token() !== null);
  currentUser = this._currentUser.asReadonly();

  /** Paso 1: usuario y contraseña. Responde si toca pedir el código o configurar el 2FA. */
  login(username: string, password: string): Observable<RespuestaLogin> {
    return this.api.login(username, password);
  }

  /** Paso 2: código de la app (o de recuperación) → abre la sesión. */
  verify2fa(mfaToken: string, factor: SegundoFactor): Observable<SesionAbierta> {
    return this.api.verificar2fa(mfaToken, factor).pipe(tap(({ token, user }) => this.abrirSesion(token, user)));
  }

  /** Alta obligatoria: confirma la app autenticadora → abre la sesión y trae los códigos de recuperación. */
  confirmarAlta(enrolToken: string, code: string): Observable<SesionAbierta> {
    return this.api.confirmarAlta2fa(enrolToken, code).pipe(tap(({ token, user }) => this.abrirSesion(token, user)));
  }

  /** Tras cambiar la contraseña el servidor entrega un token nuevo (el anterior ya no vale). */
  renovarToken(token: string): void {
    this._token.set(token);
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* sin storage disponible */ }
  }

  logout(): void {
    this._token.set(null);
    this._currentUser.set(null);
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch { /* sin storage disponible */ }
  }

  private abrirSesion(token: string, user: CurrentUser): void {
    this._token.set(token);
    this._currentUser.set(user);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* sin storage disponible */ }
  }

  private restaurarUsuario(): CurrentUser | null {
    const raw = leer(USER_KEY);
    if (!raw || !leer(TOKEN_KEY)) return null;
    try { return JSON.parse(raw) as CurrentUser; } catch { return null; }
  }
}
