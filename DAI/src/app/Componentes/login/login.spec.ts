import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Login } from './login';

const USUARIO = { name: 'Ana', role: 'Lector', email: 'ana@dai.corp' };
const ALTA = {
  secreto: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/DAI:ana%40dai.corp?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=DAI',
  cuenta: 'ana@dai.corp', emisor: 'DAI', caducaEnMinutos: 15,
};

describe('Login', () => {
  let component: Login;
  let fixture: ComponentFixture<Login>;
  let http: HttpTestingController;
  let navegar: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Login);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    navegar = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  const credenciales = (respuesta: object) => {
    component.username.set('ana@dai.corp');
    component.password.set('Clave-Segura-1');
    component.onSubmitCredentials();
    http.expectOne('/api/auth/login').flush(respuesta);
  };

  it('pide el correo CORPORATIVO (no "institucional")', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Correo corporativo');
    expect(el.querySelector('input[name="username"]')?.getAttribute('placeholder')).toBe('Su correo corporativo');
    expect(el.textContent?.toLowerCase()).not.toContain('institucional');
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('el contador muestra los segundos reales que le quedan al código (1 a 30)', () => {
    expect(component.countdown()).toBeGreaterThanOrEqual(1);
    expect(component.countdown()).toBeLessThanOrEqual(30);
  });

  it('sincroniza el contador con la hora del servidor y avisa si el equipo está desfasado', () => {
    vi.useFakeTimers();
    try {
      // Equipo 20 s atrasado: el servidor marca el segundo 05 de su paso; el equipo, el 45 del anterior.
      vi.setSystemTime(new Date('2026-10-16T12:00:45.000Z'));
      const recibido = Date.now();
      component.sincronizarReloj(Date.parse('2026-10-16T12:01:05.000Z'), recibido, recibido);
      expect(component.countdown()).toBe(25); // 30 − 5, como en la app del teléfono
      expect(component.desfaseSegundos()).toBe(-20);
      expect(component.relojDesfasado()).toBe(true);

      component.sincronizarReloj(Date.now() + 2_000, recibido, recibido);
      expect(component.relojDesfasado()).toBe(false); // 2 s no merecen aviso
      component.sincronizarReloj(undefined, recibido, recibido); // API antigua sin "ahora": no rompe
    } finally {
      vi.useRealTimers();
    }
  });

  it('con 2FA activo pasa al código y abre sesión', () => {
    credenciales({ paso: '2fa', mfaToken: 'mfa', metodo: 'TOTP' });
    expect(component.step()).toBe('twofactor');
    expect(component.password()).toBe(''); // la contraseña no se queda en memoria
    component.otpDigits.set('123456'.split(''));
    component.onVerify();
    const req = http.expectOne('/api/auth/verify-2fa');
    expect(req.request.body).toEqual({ mfaToken: 'mfa', code: '123456' });
    req.flush({ token: 'jwt', user: USUARIO });
    expect(navegar).toHaveBeenCalledWith(['/dashboard']);
  });

  it('con un código de recuperación lleva a "Seguridad de mi cuenta" avisando cuántos quedan', () => {
    credenciales({ paso: '2fa', mfaToken: 'mfa', metodo: 'TOTP' });
    component.toggleRecuperacion();
    component.codigoRecuperacion.set('abcde');
    component.onVerify();
    expect(component.errorMessage()).toContain('XXXXX-XXXXX');
    component.codigoRecuperacion.set('ABCDE-FGHJK');
    component.onVerify();
    http.expectOne('/api/auth/verify-2fa').flush({ token: 'jwt', user: USUARIO, codigosRestantes: 9 });
    expect(navegar).toHaveBeenCalledWith(['/cuenta/seguridad'], { queryParams: { recuperacion: 9 } });
  });

  it('sin 2FA obliga a configurarlo: QR, confirmación y códigos de recuperación antes de entrar', async () => {
    credenciales({ paso: 'enrolar', enrolToken: 'enrol' });
    expect(component.step()).toBe('enrolar');
    const ini = http.expectOne('/api/auth/2fa/enrolar/iniciar');
    expect(ini.request.body).toEqual({ enrolToken: 'enrol' });
    ini.flush(ALTA);
    const html: HTMLElement = fixture.nativeElement;
    // El generador de QR se descarga con import() dinámico: se espera a que aparezca el SVG.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(html.querySelector('app-qr-codigo svg path')?.getAttribute('d')).toMatch(/^M4 4h1v1h-1z/);
    });
    expect(html.textContent).toContain('JBSW Y3DP EHPK 3PXP');

    component.otpDigits.set('654321'.split(''));
    component.confirmarAlta();
    const conf = http.expectOne('/api/auth/2fa/enrolar/confirmar');
    expect(conf.request.body).toEqual({ enrolToken: 'enrol', code: '654321' });
    const codigos = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBBB`.replace(/\d/, 'C'));
    conf.flush({ token: 'jwt', user: USUARIO, codigosRecuperacion: codigos });

    expect(component.step()).toBe('codigos');
    expect(component.alta()).toBeNull(); // el secreto ya no está en pantalla
    fixture.detectChanges();
    expect(html.querySelectorAll('app-codigos-recuperacion li').length).toBe(10);
    const continuar = [...html.querySelectorAll('button')].find((b) => b.textContent?.includes('Continuar al sistema'))!;
    expect(continuar.disabled).toBe(true);
    component.codigosGuardados.set(true);
    fixture.detectChanges();
    expect(continuar.disabled).toBe(false);
    component.continuarTrasCodigos();
    expect(navegar).toHaveBeenCalledWith(['/dashboard']);
  });

  it('si el QR caducó, genera uno nuevo automáticamente', () => {
    credenciales({ paso: 'enrolar', enrolToken: 'enrol' });
    http.expectOne('/api/auth/2fa/enrolar/iniciar').flush(ALTA);
    component.otpDigits.set('654321'.split(''));
    component.confirmarAlta();
    http.expectOne('/api/auth/2fa/enrolar/confirmar').flush({ error: 'El código QR caducó. Genere uno nuevo.', nuevoQr: true }, { status: 400, statusText: 'Bad Request' });
    http.expectOne('/api/auth/2fa/enrolar/iniciar').flush(ALTA);
    expect(component.errorMessage()).toContain('caducó');
    expect(component.otpDigits().join('')).toBe('');
  });

  it('si el paso 1 venció vuelve a usuario y contraseña', () => {
    credenciales({ paso: '2fa', mfaToken: 'mfa', metodo: 'TOTP' });
    component.otpDigits.set('123456'.split(''));
    component.onVerify();
    http.expectOne('/api/auth/verify-2fa').flush({ error: 'La verificación expiró.', reiniciar: true }, { status: 401, statusText: 'Unauthorized' });
    expect(component.step()).toBe('credentials');
    expect(component.errorMessage()).toContain('expiró');
  });

  it('pegar 6 dígitos llena todas las casillas', () => {
    const evento = { clipboardData: { getData: () => ' 987 654 ' }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    component.onDigitPaste(evento);
    expect(component.otpDigits().join('')).toBe('987654');
  });

  it('sin maquetas: ni "¿Olvidó su contraseña?" falso, ni dominios ni correos de soporte inventados', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(el.querySelector('a[href^="mailto:"]')).toBeNull();
    for (const falso of ['@empresa.gob', '@corporacion.com', 't.soto@empresa.com', 'soporte@dai'])
      expect(el.innerHTML).not.toContain(falso);
    expect(el.textContent).toContain('Contacte al administrador del sistema');
  });
});
