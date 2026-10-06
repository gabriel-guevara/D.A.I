import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth';

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it('should be created y sin sesión al inicio', () => {
    expect(service).toBeTruthy();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('abre sesión al verificar el 2FA', () => {
    service.verify2fa('mfa-token', '123456').subscribe();
    const req = http.expectOne('/api/auth/verify-2fa');
    expect(req.request.body).toEqual({ mfaToken: 'mfa-token', code: '123456' });
    req.flush({ token: 'jwt', user: { name: 'Ana', role: 'Lector', email: 'a@dai.corp' } });

    expect(service.isAuthenticated()).toBe(true);
    expect(service.currentUser()?.name).toBe('Ana');
    service.logout();
    expect(service.isAuthenticated()).toBe(false);
  });
});
