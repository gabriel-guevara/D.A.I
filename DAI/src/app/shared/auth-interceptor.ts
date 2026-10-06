import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { API_URL } from './api';
import { AuthService } from './auth';

/** Adjunta el JWT a cada petición a la API y cierra la sesión si el servidor responde 401. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const esApi = req.url.startsWith(API_URL);
  const token = auth.token();
  const peticion = esApi && token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(peticion).pipe(
    catchError((err) => {
      // Un 401 en /auth/* es "credenciales incorrectas" y lo maneja el login; en el resto = sesión vencida
      if (err.status === 401 && esApi && !req.url.startsWith(`${API_URL}/auth/`)) {
        auth.logout();
        router.navigate(['/login']);
      }
      return throwError(() => err);
    }),
  );
};
