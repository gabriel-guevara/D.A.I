import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SeguridadCuenta } from './seguridad-cuenta';
import { AuthService } from '../../shared/auth';
import { authInterceptor } from '../../shared/auth-interceptor';

const ESTADO = {
  nombre: 'Ana', email: 'ana@dai.corp', mfaActivo: true, mfaActivadoEn: '15 Oct 2026, 4:42 p. m.',
  codigosRestantes: 2, passwordCambiadoEn: null, politicaContrasena: { minimo: 10, maximoBytes: 72 },
};

describe('SeguridadCuenta', () => {
  let component: SeguridadCuenta;
  let fixture: ComponentFixture<SeguridadCuenta>;
  let http: HttpTestingController;
  let auth: AuthService;

  async function crear(queryParams: Record<string, string> = {}) {
    await TestBed.configureTestingModule({
      imports: [SeguridadCuenta],
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    fixture = TestBed.createComponent(SeguridadCuenta);
    component = fixture.componentInstance;
    http.expectOne('/api/cuenta/seguridad').flush(ESTADO);
    // La barra lateral y la de navegación piden sus propios datos; aquí no interesan.
    http.match(() => true).forEach((r) => r.flush({}));
  }

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('dai_token', 'viejo');
    sessionStorage.setItem('dai_user', JSON.stringify({ name: 'Ana', role: 'Lector', email: 'ana@dai.corp' }));
  });

  // sessionStorage se comparte entre archivos de prueba: sin esto, los siguientes "heredarían" la sesión.
  afterEach(() => sessionStorage.clear());

  it('muestra el estado del 2FA y avisa cuando quedan pocos códigos', async () => {
    await crear();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('Activa');
    expect(texto).toContain('15 Oct 2026, 4:42 p. m.');
    expect(component.pocosCodigos()).toBe(true);
  });

  it('muestra el aviso si se entró con un código de recuperación', async () => {
    await crear({ recuperacion: '3' });
    expect(component.avisoRecuperacion()).toBe(3);
  });

  it('valida la nueva contraseña antes de llamar al servidor', async () => {
    await crear();
    component.actual.set('Actual-Clave-1');
    component.nueva.set('corta1');
    component.repetir.set('corta1');
    component.cambiarContrasena();
    expect(component.errorPassword()).toContain('entre 10 y 72');
    http.expectNone('/api/cuenta/password');
  });

  it('cambia la contraseña con el código 2FA y renueva el token de esta pestaña', async () => {
    await crear();
    component.actual.set('Actual-Clave-1');
    component.nueva.set('Nueva-Clave-2026');
    component.repetir.set('Nueva-Clave-2026');
    component.parcheFactor('password', { valor: '123456' });
    component.cambiarContrasena();
    const req = http.expectOne('/api/cuenta/password');
    expect(req.request.body).toEqual({ actual: 'Actual-Clave-1', nueva: 'Nueva-Clave-2026', code: '123456' });
    req.flush({ ok: true, token: 'nuevo' });
    http.expectOne('/api/cuenta/seguridad').flush(ESTADO);
    expect(auth.token()).toBe('nuevo');
    expect(component.okPassword()).toContain('otros equipos');
    expect(component.actual()).toBe('');
  });

  it('una contraseña actual incorrecta (403) muestra el error SIN cerrar la sesión', async () => {
    await crear();
    component.actual.set('Mala-Clave-01');
    component.nueva.set('Nueva-Clave-2026');
    component.repetir.set('Nueva-Clave-2026');
    component.parcheFactor('password', { valor: '123456' });
    component.cambiarContrasena();
    http.expectOne('/api/cuenta/password').flush({ error: 'La contraseña actual no es correcta.' }, { status: 403, statusText: 'Forbidden' });
    expect(component.errorPassword()).toBe('La contraseña actual no es correcta.');
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('cambiar de teléfono: identidad → QR nuevo → confirmar', async () => {
    await crear();
    component.abrirPanel('reconfigurar');
    component.passwordReconf.set('Actual-Clave-1');
    component.parcheFactor('reconf', { usarRecuperacion: true });
    component.parcheFactor('reconf', { valor: 'ABCDE-FGHJK' });
    component.iniciarReconfiguracion();
    const ini = http.expectOne('/api/cuenta/2fa/reconfigurar/iniciar');
    expect(ini.request.body).toEqual({ password: 'Actual-Clave-1', codigoRecuperacion: 'ABCDE-FGHJK' });
    ini.flush({ secreto: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/DAI:a?secret=X', cuenta: 'ana@dai.corp', emisor: 'DAI', caducaEnMinutos: 15 });
    expect(component.alta()).not.toBeNull();
    component.codigoNuevaApp.set('111222');
    component.confirmarReconfiguracion();
    http.expectOne('/api/cuenta/2fa/reconfigurar/confirmar').flush({ ok: true });
    http.expectOne('/api/cuenta/seguridad').flush(ESTADO);
    expect(component.alta()).toBeNull();
    expect(component.ok2fa()).toContain('app nueva');
  });

  it('regenera los códigos de recuperación y los muestra una vez', async () => {
    await crear();
    component.abrirPanel('codigos');
    component.parcheFactor('codigos', { valor: '123456' });
    component.regenerarCodigos();
    http.expectOne('/api/cuenta/2fa/codigos-recuperacion').flush({ codigosRecuperacion: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] });
    http.expectOne('/api/cuenta/seguridad').flush(ESTADO);
    expect(component.codigosNuevos()).toEqual(['AAAAA-BBBBB', 'CCCCC-DDDDD']);
    component.cerrarPanel();
    expect(component.codigosNuevos()).toEqual([]);
  });
});
