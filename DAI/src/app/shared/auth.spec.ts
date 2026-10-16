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

  afterEach(() => http.verify());

  it('should be created y sin sesión al inicio', () => {
    expect(service).toBeTruthy();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('el paso 1 NO abre sesión: solo informa si toca el código o el alta', () => {
    let paso = '';
    service.login('a@dai.corp', 'Clave-Segura-1').subscribe((r) => (paso = r.paso));
    const req = http.expectOne('/api/auth/login');
    expect(req.request.body).toEqual({ username: 'a@dai.corp', password: 'Clave-Segura-1' });
    req.flush({ paso: 'enrolar', enrolToken: 'tok' });
    expect(paso).toBe('enrolar');
    expect(service.isAuthenticated()).toBe(false);
  });

  it('abre sesión al verificar el 2FA con el código de la app', () => {
    service.verify2fa('mfa-token', { code: '123456' }).subscribe();
    const req = http.expectOne('/api/auth/verify-2fa');
    expect(req.request.body).toEqual({ mfaToken: 'mfa-token', code: '123456' });
    req.flush({ token: 'jwt', user: { name: 'Ana', role: 'Lector', email: 'a@dai.corp' } });

    expect(service.isAuthenticated()).toBe(true);
    expect(service.currentUser()?.name).toBe('Ana');
    expect(sessionStorage.getItem('dai_token')).toBe('jwt');
    service.logout();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('acepta un código de recuperación como segundo factor', () => {
    service.verify2fa('mfa-token', { codigoRecuperacion: 'ABCDE-FGHJK' }).subscribe();
    const req = http.expectOne('/api/auth/verify-2fa');
    expect(req.request.body).toEqual({ mfaToken: 'mfa-token', codigoRecuperacion: 'ABCDE-FGHJK' });
    req.flush({ token: 'jwt', user: { name: 'Ana', role: 'Lector', email: 'a@dai.corp' }, codigosRestantes: 9 });
    expect(service.isAuthenticated()).toBe(true);
  });

  it('confirmar el alta abre sesión y entrega los códigos de recuperación', () => {
    let codigos: string[] = [];
    service.confirmarAlta('enrol', '654321').subscribe((r) => (codigos = r.codigosRecuperacion ?? []));
    const req = http.expectOne('/api/auth/2fa/enrolar/confirmar');
    expect(req.request.body).toEqual({ enrolToken: 'enrol', code: '654321' });
    req.flush({ token: 'jwt2', user: { name: 'Ana', role: 'Lector', email: 'a@dai.corp' }, codigosRecuperacion: ['AAAAA-BBBBB'] });
    expect(codigos).toEqual(['AAAAA-BBBBB']);
    expect(service.token()).toBe('jwt2');
  });

  it('renovarToken reemplaza el token tras cambiar la contraseña sin perder el usuario', () => {
    service.verify2fa('m', { code: '111111' }).subscribe();
    http.expectOne('/api/auth/verify-2fa').flush({ token: 'viejo', user: { name: 'Ana', role: 'Lector', email: 'a@dai.corp' } });
    service.renovarToken('nuevo');
    expect(service.token()).toBe('nuevo');
    expect(sessionStorage.getItem('dai_token')).toBe('nuevo');
    expect(service.currentUser()?.email).toBe('a@dai.corp');
  });
});
