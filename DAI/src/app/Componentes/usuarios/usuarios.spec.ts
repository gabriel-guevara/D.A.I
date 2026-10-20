import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UsuariosGestion } from './usuarios';

const catalogos = {
  departamentos: [{ id: 1, nombre: 'Legal' }],
  niveles: [{ id: 1, nombre: 'Nivel 5 Secreto', rango: 5 }, { id: 5, nombre: 'Nivel 2 Confidencial', rango: 2 }],
  roles: [{ id: 1, clave: 'super-admin', nombre: 'Super Administrador' }, { id: 4, clave: 'read-only', nombre: 'Lector Restringido' }],
};
const formulario = { nombre: 'Pepe Pérez', email: 'p@dai.corp', password: 'ClaveSegura-2026', rol: 'read-only', departamento: '', nivel: '', mfaMetodo: 'TOTP', activo: true };

describe('UsuariosGestion', () => {
  let component: UsuariosGestion;
  let fixture: ComponentFixture<UsuariosGestion>;
  let http: HttpTestingController;

  async function crear(rolClave?: string) {
    sessionStorage.clear();
    if (rolClave) {
      sessionStorage.setItem('dai_token', 't');
      sessionStorage.setItem('dai_user', JSON.stringify({ name: 'Ana', role: 'x', email: 'ana@dai.corp', rolClave }));
    }
    await TestBed.configureTestingModule({
      imports: [UsuariosGestion],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(UsuariosGestion);
    component = fixture.componentInstance;
    http.expectOne('/api/catalogos').flush(catalogos);
    if (rolClave === 'super-admin') http.expectOne('/api/seguridad/usuarios').flush([]);
    await fixture.whenStable();
  }

  afterEach(() => {
    http.match('/api/notificaciones/resumen');
    http.verify();
    sessionStorage.clear();
  });

  it('sin sesión de Super Administrador no permite modificar ni crear (el servidor da 403)', async () => {
    await crear('compliance');
    component.setTab('modificar');
    expect(component.tab()).toBe('crear');
    component.formCrear.set({ ...formulario, nivel: 'Nivel 2 Confidencial' });
    component.crearUsuario();
    expect(component.mensajeError()).toBe('Solo el Super Administrador puede crear usuarios.');
    fixture.detectChanges();
    const t = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(t).toContain('Solo el Super Administrador puede crear y modificar usuarios.');
    expect(t).not.toContain('Usted puede crear cuentas'); // el texto falso de antes
  });

  it('el formulario tiene el select NIVEL con los niveles del catálogo', async () => {
    await crear('super-admin');
    fixture.detectChanges();
    const opciones = [...(fixture.nativeElement as HTMLElement).querySelectorAll('select option')].map((o) => o.textContent?.trim());
    expect(opciones).toContain('Seleccione un nivel…');
    expect(opciones).toContain('Nivel 5 Secreto');
    expect(opciones).toContain('Nivel 2 Confidencial');
  });

  it('sin nivel no se envía (era el 400 de "Crear usuario"); con nivel se envía y se crea', async () => {
    await crear('super-admin');
    component.formCrear.set({ ...formulario });
    component.crearUsuario();
    expect(component.mensajeError()).toBe('Seleccione un nivel de confidencialidad.');
    http.expectNone('/api/seguridad/usuarios');

    component.formCrear.set({ ...formulario, nivel: 'Nivel 2 Confidencial' });
    component.crearUsuario();
    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/seguridad/usuarios');
    expect(req.request.body).toEqual({
      nombre: 'Pepe Pérez', email: 'p@dai.corp', password: 'ClaveSegura-2026', rol: 'read-only', nivel: 'Nivel 2 Confidencial',
      departamento: null, mfaMetodo: 'TOTP',
    });
    req.flush({ id: '7' }, { status: 201, statusText: 'Created' });
    http.expectOne('/api/seguridad/usuarios').flush([]);
    expect(component.mensajeOk()).toContain('creado');
  });

  it('restablecer 2FA exige el código 6 dígitos del administrador antes de llamar al servidor', async () => {
    await crear('super-admin');
    component.seleccionado.set({
      id: '7', name: 'Pepe', email: 'p@dai.corp', initials: 'P', avatarColor: '', departamento: '—', rol: 'read-only',
      rolLabel: 'Lector', mfaMethod: 'TOTP', mfaActivo: true, nivel: 'Nivel 2 Confidencial', activo: true, ultimoAcceso: 'Nunca',
    });
    component.codigoRestablecer.set('12');
    component.restablecer2fa();
    expect(component.mensajeError()).toContain('6 dígitos');
  });

  it('la contraseña inicial sigue la política del servidor (mínimo 10) y valida los obligatorios', async () => {
    await crear('super-admin');
    component.formCrear.set({ ...formulario, password: 'Corta123', nivel: 'x' });
    component.crearUsuario();
    expect(component.mensajeError()).toContain('entre 10 y 72');
    component.formCrear.set({ ...formulario, nombre: '' });
    component.crearUsuario();
    expect(component.mensajeError()).toContain('nombre');
  });
});
