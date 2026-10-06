import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { API_URL } from './api';

export interface CurrentUser {
  name: string;
  role: string;
  email: string;
}

interface LoginStep1 { mfaToken: string; metodo: string; }
interface LoginStep2 { token: string; user: CurrentUser; }

const TOKEN_KEY = 'dai_token';
const USER_KEY = 'dai_user';

/** Lee de sessionStorage sin romper si no está disponible. */
function leer(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  // Estado de sesión expuesto como signals de solo lectura
  private _token = signal<string | null>(leer(TOKEN_KEY));
  private _currentUser = signal<CurrentUser | null>(this.restaurarUsuario());

  token = this._token.asReadonly();
  isAuthenticated = computed(() => this._token() !== null);
  currentUser = this._currentUser.asReadonly();

  /** Paso 1: valida usuario/contraseña. Devuelve un token temporal para el paso 2FA. */
  login(username: string, password: string): Observable<LoginStep1> {
    return this.http.post<LoginStep1>(`${API_URL}/auth/login`, { username, password });
  }

  /** Paso 2: valida el código 2FA y abre la sesión. */
  verify2fa(mfaToken: string, code: string): Observable<void> {
    return this.http
      .post<LoginStep2>(`${API_URL}/auth/verify-2fa`, { mfaToken, code })
      .pipe(
        tap(({ token, user }) => this.abrirSesion(token, user)),
        map(() => undefined),
      );
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
