import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { CanActivateFn, Router, provideRouter } from '@angular/router';
import { authGuard } from './auth-guard';

/** Componente vacío: solo sirve para que la ruta `login` exista en el router de prueba. */
@Component({ template: '' })
class LoginFalso {}

describe('authGuard', () => {
  const executeGuard: CanActivateFn = (...guardParameters) =>
    TestBed.runInInjectionContext(() => authGuard(...guardParameters));

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      // El guard redirige a /login, así que el router de prueba debe conocer esa ruta;
      // si no, la navegación se rechaza con NG04002 y queda como error no manejado.
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'login', component: LoginFalso }]),
      ],
    });
  });

  it('should be created', () => {
    expect(executeGuard).toBeTruthy();
  });

  it('bloquea el acceso sin sesión y redirige a /login', async () => {
    const router = TestBed.inject(Router);
    const navegar = vi.spyOn(router, 'navigate');

    expect(executeGuard({} as never, {} as never)).toBe(false);
    expect(navegar).toHaveBeenCalledWith(['/login']);

    // Esperamos a que la navegación termine para que no quede una promesa pendiente.
    await expect(navegar.mock.results[0].value).resolves.toBe(true);
    expect(router.url).toBe('/login');
  });

  it('permite el acceso con sesión abierta', () => {
    // AuthService restaura el token desde sessionStorage al crearse.
    sessionStorage.setItem('dai_token', 'jwt-de-prueba');
    const navegar = vi.spyOn(TestBed.inject(Router), 'navigate');

    expect(executeGuard({} as never, {} as never)).toBe(true);
    expect(navegar).not.toHaveBeenCalled();
  });
});
