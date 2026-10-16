import { HttpClient, HttpErrorResponse, HttpEvent, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { API_URL } from './config';
import type { CurrentUser } from './auth';

// Se reexporta para que el resto de archivos puedan seguir importándola desde './api'
export { API_URL };

type Params = Record<string, string | number | boolean | null | undefined>;

/** Metadatos del formulario "Aprobar e Indexar". La clasificación es obligatoria (el servidor también lo exige). */
export interface MetadatosSubida {
  clasificacion: string;
  folio?: string;
  titulo?: string;
  departamento?: string;
  tipoDocumental?: string;
}

/** Respuesta de POST /digitalizacion/documentos. */
export interface DocumentoSubido {
  id: string;
  folio: string;
  nombre: string;
  nombreOriginal: string;
  hash: string;
  hashCorto: string;
  tamanoBytes: number;
  tamano: string;
  paginas: number;
  /** La extracción de texto corre en segundo plano después de responder: siempre llega 'pendiente'. */
  indexacion: 'pendiente';
}

/** Estado de la extracción de texto de un documento con archivo (detalle y GET /documentos/:id/indexacion). */
export type EstadoTexto = 'pendiente' | 'procesando' | 'procesado' | 'sin_texto' | 'error';
export interface EstadoIndexacion {
  estado: EstadoTexto;
  etiqueta: string;
  descripcion: string;
  /** Aviso cuando se alcanzó un límite (páginas, caracteres o tiempo) y parte del documento no se indexó. */
  aviso: string | null;
  paginasConTexto: number | null;
  paginasTotales: number | null;
  caracteres: number | null;
  errorCodigo: string | null;
  fecha: string;
}

/** Trozo de un fragmento de búsqueda; "resaltado" = coincide con lo buscado. Se pinta sin innerHTML. */
export interface SegmentoFragmento {
  texto: string;
  resaltado: boolean;
}

export interface ResultadoIntegridad {
  integro: boolean;
  hashEsperado: string;
  hashCalculado: string;
  tamanoEsperado: number;
  tamanoCalculado: number;
  verificadoEn: string;
}

/** Cuerpo de error de la API: { error, codigo? }. */
export interface ErrorApi {
  error?: string;
  codigo?: string;
}

/**
 * Lee el cuerpo de error de una respuesta. Con responseType 'blob' (archivos) el JSON de error llega como Blob,
 * así que hay que leerlo como texto antes de interpretarlo.
 */
export async function leerErrorApi(err: unknown): Promise<ErrorApi> {
  const cuerpo = err instanceof HttpErrorResponse ? err.error : null;
  try {
    if (cuerpo instanceof Blob) return JSON.parse(await cuerpo.text()) as ErrorApi;
    if (cuerpo && typeof cuerpo === 'object') return cuerpo as ErrorApi;
  } catch {
    /* cuerpo no JSON */
  }
  return {};
}

// ---------------------------------------------------------------------------- Seguridad (Fase 3)

/** Paso 1 del login: con 2FA activo se pide el código; sin 2FA hay que configurarlo en ese momento. */
export type RespuestaLogin = (
  | { paso: '2fa'; mfaToken: string; metodo: string }
  | { paso: 'enrolar'; enrolToken: string }
) & {
  /** Hora del servidor (ms desde 1970). Sirve para sincronizar el contador de 30 s con el de la app del teléfono. */
  ahora?: number;
};

/** Segundo factor: código de 6 dígitos de la app o un código de recuperación (XXXXX-XXXXX). */
export type SegundoFactor = { code: string } | { codigoRecuperacion: string };

/** Datos para configurar la app autenticadora. El secreto solo vive en memoria mientras se muestra. */
export interface AltaDosPasos {
  secreto: string;
  otpauthUri: string;
  cuenta: string;
  emisor: string;
  caducaEnMinutos: number;
}

export interface SesionAbierta {
  token: string;
  user: CurrentUser;
  /** Solo al activar el 2FA: se muestran UNA vez. */
  codigosRecuperacion?: string[];
  /** Solo si se entró con un código de recuperación. */
  codigosRestantes?: number;
}

export interface EstadoSeguridadCuenta {
  nombre: string;
  email: string;
  mfaActivo: boolean;
  /** Fecha y hora de Colombia, 12 h (la formatea el servidor). */
  mfaActivadoEn: string | null;
  codigosRestantes: number;
  passwordCambiadoEn: string | null;
  politicaContrasena: { minimo: number; maximoBytes: number };
}

// ---------------------------------------------------------------------------- Versiones y papelera (Fase 4)

/** Una versión del historial (GET /documentos/:id/versiones). Fechas en hora de Colombia, 12 h. */
export interface VersionDocumento {
  id: string;
  version: string;
  /** true = es la versión que hoy se ve, se descarga y se indexa. */
  actual: boolean;
  /** Solo para versiones con archivo real; null en registros históricos sin PDF. */
  hash: string | null;
  hashCorto: string | null;
  tamanoBytes: number;
  tamano: string;
  paginas: number | null;
  nombreOriginal: string | null;
  comentario: string | null;
  autor: string;
  fecha: string;
  tieneArchivo: boolean;
}

export interface HistorialVersiones {
  versionActual: string;
  /** Subir y restaurar versiones (Super Administrador y Operador OCR); el servidor lo vuelve a comprobar. */
  puedeGestionar: boolean;
  versiones: VersionDocumento[];
}

/** Respuesta de POST /documentos/:id/versiones. */
export interface VersionSubida {
  id: string;
  version: string;
  anterior: string;
  hash: string;
  hashCorto: string;
  tamanoBytes: number;
  tamano: string;
  paginas: number;
  nombreOriginal: string;
  comentario: string;
  indexacion: 'pendiente';
}

export interface DocumentoEnPapelera {
  id: string;
  nombre: string;
  folio: string;
  formato: string;
  version: string;
  departamento: string;
  clasificacion: string;
  eliminadoPor: string;
  eliminadoEn: string;
  haceCuanto: string;
  /** Cuándo se purgará solo; null si la purga automática está desactivada o hay retención legal. */
  purgaAutomatica: string | null;
  /** Fecha hasta la que la ley obliga a conservarlo; mientras tanto no se puede purgar. */
  retencionHasta: string | null;
  versiones: number;
  tamanoArchivos: string;
  tieneArchivo: boolean;
}

export interface EstadoPapelera {
  diasRetencion: number;
  /** Solo el Super Administrador purga (con su código 2FA). */
  puedePurgar: boolean;
  /** Objetos aún por borrar del almacenamiento (solo para quien puede purgar). */
  borrado: { pendientes: number; con_error: number } | null;
  documentos: DocumentoEnPapelera[];
}

export interface ResultadoVaciado {
  ok: boolean;
  purgados: number;
  enRetencion: number;
  restantes: number;
}

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
  paginaDocumento<T = unknown>(id: string, pagina: number) {
    return this.get<T>(`/documentos/${encodeURIComponent(id)}/paginas/${pagina}`);
  }
  /**
   * PDF real como Blob. Se pide con HttpClient (y no con un <iframe src="...">) para que el interceptor
   * adjunte el JWT: el navegador no envía cabeceras Authorization en las peticiones de un iframe.
   */
  archivoDocumento(id: string): Observable<Blob> {
    return this.http.get(`${API_URL}/documentos/${encodeURIComponent(id)}/archivo`, { responseType: 'blob' });
  }
  descargarDocumento(id: string): Observable<Blob> {
    return this.http.get(`${API_URL}/documentos/${encodeURIComponent(id)}/descarga`, { responseType: 'blob' });
  }
  verificarIntegridad(id: string): Observable<ResultadoIntegridad> {
    return this.http.post<ResultadoIntegridad>(`${API_URL}/documentos/${encodeURIComponent(id)}/verificar-integridad`, {});
  }
  /** Estado de la extracción de texto (ligero, sin auditoría: se consulta cada pocos segundos mientras está pendiente). */
  indexacionDocumento(id: string): Observable<EstadoIndexacion> {
    return this.http.get<EstadoIndexacion>(`${API_URL}/documentos/${encodeURIComponent(id)}/indexacion`);
  }
  /** Vuelve a extraer el texto del PDF (solo Super Administrador y Operador OCR; queda auditado). */
  reindexarDocumento(id: string): Observable<EstadoIndexacion> {
    return this.http.post<EstadoIndexacion>(`${API_URL}/documentos/${encodeURIComponent(id)}/reindexar`, {});
  }
  /** Envía el documento a la papelera (Super Administrador y Oficial de Cumplimiento). No borra nada. */
  eliminarDocumento(id: string): Observable<void> {
    return this.http.delete<void>(`${API_URL}/documentos/${encodeURIComponent(id)}`);
  }

  // Versiones
  versionesDocumento(id: string): Observable<HistorialVersiones> {
    return this.http.get<HistorialVersiones>(`${API_URL}/documentos/${encodeURIComponent(id)}/versiones`);
  }
  /** Sube una versión nueva (multipart). Igual que subirDocumento: emite el progreso para la barra. */
  subirVersion(id: string, archivo: File, comentario: string): Observable<HttpEvent<VersionSubida>> {
    const form = new FormData();
    form.append('comentario', comentario.trim()); // antes del archivo: el servidor lo tiene aunque el PDF sea grande
    form.append('archivo', archivo, archivo.name);
    return this.http.post<VersionSubida>(`${API_URL}/documentos/${encodeURIComponent(id)}/versiones`, form, {
      reportProgress: true, observe: 'events',
    });
  }
  archivoVersion(id: string, versionId: string): Observable<Blob> {
    return this.http.get(`${API_URL}/documentos/${encodeURIComponent(id)}/versiones/${encodeURIComponent(versionId)}/archivo`, { responseType: 'blob' });
  }
  descargarVersion(id: string, versionId: string): Observable<Blob> {
    return this.http.get(`${API_URL}/documentos/${encodeURIComponent(id)}/versiones/${encodeURIComponent(versionId)}/descarga`, { responseType: 'blob' });
  }
  restaurarVersion(id: string, versionId: string): Observable<{ ok: boolean; version: string; anterior: string }> {
    return this.http.post<{ ok: boolean; version: string; anterior: string }>(
      `${API_URL}/documentos/${encodeURIComponent(id)}/versiones/${encodeURIComponent(versionId)}/restaurar`, {});
  }

  // Papelera
  papelera(): Observable<EstadoPapelera> {
    return this.http.get<EstadoPapelera>(`${API_URL}/papelera`);
  }
  restaurarDesdePapelera(id: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>(`${API_URL}/papelera/${encodeURIComponent(id)}/restaurar`, {});
  }
  /** Purga DEFINITIVA (irreversible): pide el código 2FA del Super Administrador. */
  purgarDocumento(id: string, factor: SegundoFactor): Observable<{ ok: boolean; versiones: number; objetos: number }> {
    return this.http.post<{ ok: boolean; versiones: number; objetos: number }>(`${API_URL}/papelera/${encodeURIComponent(id)}/purgar`, factor);
  }
  vaciarPapelera(factor: SegundoFactor): Observable<ResultadoVaciado> {
    return this.http.post<ResultadoVaciado>(`${API_URL}/papelera/vaciar`, factor);
  }

  // Búsqueda avanzada
  buscar<T = unknown>(q: string, algoritmo: 'semantica' | 'exacta') { return this.get<T>('/busqueda', { q, algoritmo }); }
  facetasBusqueda<T = unknown>() { return this.get<T>('/busqueda/facetas'); }

  // Notificaciones
  notificaciones<T = unknown>() { return this.get<T>('/notificaciones'); }
  notificacionesResumen<T = unknown>() { return this.get<T>('/notificaciones/resumen'); }
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

  // Alta y modificación de usuarios (solo Super Administrador; Cumplimiento puede crear con límites)
  catalogos<T = unknown>() { return this.get<T>('/catalogos'); }
  crearUsuario(body: Record<string, unknown>) {
    return this.http.post<{ id: string }>(`${API_URL}/seguridad/usuarios`, body);
  }
  modificarUsuario(id: string, body: Record<string, unknown>) {
    return this.http.patch<{ ok: boolean }>(`${API_URL}/seguridad/usuarios/${encodeURIComponent(id)}`, body);
  }

  /** Restablece el 2FA de otro usuario (solo Super Administrador, confirmando con su propio código). */
  restablecer2faUsuario(id: string, factor: SegundoFactor) {
    return this.http.post<{ ok: boolean }>(`${API_URL}/seguridad/usuarios/${encodeURIComponent(id)}/restablecer-2fa`, factor);
  }

  // Autenticación (login en dos pasos y alta obligatoria de 2FA)
  login(username: string, password: string): Observable<RespuestaLogin> {
    return this.http.post<RespuestaLogin>(`${API_URL}/auth/login`, { username, password });
  }
  verificar2fa(mfaToken: string, factor: SegundoFactor): Observable<SesionAbierta> {
    return this.http.post<SesionAbierta>(`${API_URL}/auth/verify-2fa`, { mfaToken, ...factor });
  }
  iniciarAlta2fa(enrolToken: string): Observable<AltaDosPasos> {
    return this.http.post<AltaDosPasos>(`${API_URL}/auth/2fa/enrolar/iniciar`, { enrolToken });
  }
  confirmarAlta2fa(enrolToken: string, code: string): Observable<SesionAbierta> {
    return this.http.post<SesionAbierta>(`${API_URL}/auth/2fa/enrolar/confirmar`, { enrolToken, code });
  }

  // Seguridad de mi cuenta
  seguridadCuenta(): Observable<EstadoSeguridadCuenta> {
    return this.get<EstadoSeguridadCuenta>('/cuenta/seguridad');
  }
  /** Devuelve un token nuevo: las demás sesiones (otros equipos) quedan cerradas. */
  cambiarContrasena(actual: string, nueva: string, factor: SegundoFactor): Observable<{ ok: boolean; token: string }> {
    return this.http.post<{ ok: boolean; token: string }>(`${API_URL}/cuenta/password`, { actual, nueva, ...factor });
  }
  iniciarReconfiguracion2fa(password: string, factor: SegundoFactor): Observable<AltaDosPasos> {
    return this.http.post<AltaDosPasos>(`${API_URL}/cuenta/2fa/reconfigurar/iniciar`, { password, ...factor });
  }
  confirmarReconfiguracion2fa(code: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${API_URL}/cuenta/2fa/reconfigurar/confirmar`, { code });
  }
  regenerarCodigosRecuperacion(factor: SegundoFactor): Observable<{ codigosRecuperacion: string[] }> {
    return this.http.post<{ codigosRecuperacion: string[] }>(`${API_URL}/cuenta/2fa/codigos-recuperacion`, factor);
  }

  // Digitalización (OCR)
  colaOcr<T = unknown>() { return this.get<T>('/digitalizacion/cola'); }
  /**
   * "Aprobar e Indexar": sube el PDF con sus metadatos (multipart/form-data).
   * observe: 'events' + reportProgress emite el avance de la subida para la barra de progreso.
   * Los campos van ANTES del archivo: así el servidor los tiene aunque el archivo sea grande.
   */
  subirDocumento(archivo: File, meta: MetadatosSubida): Observable<HttpEvent<DocumentoSubido>> {
    const form = new FormData();
    for (const [k, v] of Object.entries(meta)) if (typeof v === 'string' && v.trim()) form.append(k, v.trim());
    form.append('archivo', archivo, archivo.name);
    return this.http.post<DocumentoSubido>(`${API_URL}/digitalizacion/documentos`, form, { reportProgress: true, observe: 'events' });
  }
}
