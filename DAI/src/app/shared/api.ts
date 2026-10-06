import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Base de la API. En desarrollo `ng serve` la redirige al backend (ver proxy.conf.json).
 * En producción sirve el front y la API bajo el mismo dominio (reverse proxy: /api -> backend)
 * o cambia esta constante por la URL absoluta de la API.
 */
export const API_URL = 'https://d-a-i.onrender.com/api';

type Params = Record<string, string | number | boolean | null | undefined>;

/** Único punto de acceso HTTP al backend. Cada método devuelve un Observable tipado por quien lo llama. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private get<T>(path: string, params: Params = {}): Observable<T> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') p = p.set(k, String(v));
    }
    return this.http.get<T>(`${API_URL}${path}`, { params: p });
  }

  // Dashboard
  dashboard<T = unknown>() { return this.get<T>('/dashboard'); }

  // Biblioteca / documentos
  biblioteca<T = unknown>(filtros: { q?: string; departamento?: string; formato?: string; dias?: number } = {}) {
    return this.get<T>('/documentos', filtros);
  }
  documento<T = unknown>(id: string) { return this.get<T>(`/documentos/${encodeURIComponent(id)}`); }
  auditoriaDocumento<T = unknown>(id: string) { return this.get<T>(`/documentos/${encodeURIComponent(id)}/auditoria`); }
  eliminarDocumento(id: string): Observable<void> {
    return this.http.delete<void>(`${API_URL}/documentos/${encodeURIComponent(id)}`);
  }

  // Búsqueda avanzada
  buscar<T = unknown>(q: string, algoritmo: 'semantica' | 'exacta') { return this.get<T>('/busqueda', { q, algoritmo }); }
  facetasBusqueda<T = unknown>() { return this.get<T>('/busqueda/facetas'); }

  // Notificaciones
  notificaciones<T = unknown>() { return this.get<T>('/notificaciones'); }
  marcarLeida(id: string): Observable<void> {
    return this.http.patch<void>(`${API_URL}/notificaciones/${encodeURIComponent(id)}/leida`, {});
  }
  marcarTodasLeidas(): Observable<void> {
    return this.http.post<void>(`${API_URL}/notificaciones/leer-todas`, {});
  }

  // Roles y permisos
  rolesTarjetas<T = unknown>() { return this.get<T>('/seguridad/roles'); }
  usuarios<T = unknown>() { return this.get<T>('/seguridad/usuarios'); }
  invitarUsuario(body: { nombre: string; email: string; rol?: string; departamento?: string; nivel?: string }) {
    return this.http.post<{ id: string }>(`${API_URL}/seguridad/usuarios/invitar`, body);
  }

  // Digitalización (OCR)
  colaOcr<T = unknown>() { return this.get<T>('/digitalizacion/cola'); }
  aprobarOcr<T = unknown>(trabajoId: string, body: Record<string, unknown> = {}) {
    return this.http.post<T>(`${API_URL}/digitalizacion/trabajos/${encodeURIComponent(trabajoId)}/aprobar`, body);
  }
}
