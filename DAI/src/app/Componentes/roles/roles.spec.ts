import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { roles } from './roles';

const usuario = (id: string, rol: string) => ({
  id, name: `Usuario ${id}`, email: `u${id}@dai.corp`, initials: 'U', avatarColor: '', departamento: '—', rol, rolLabel: rol,
  rolColor: '', mfaMethod: 'TOTP', nivel: 'Nivel 2 Confidencial', nivelColor: '', activo: true, ultimoAcceso: 'Nunca',
});

describe('roles', () => {
  let component: roles;
  let fixture: ComponentFixture<roles>;
  let http: HttpTestingController;
  const texto = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  const crear = async (rolClave: string) => {
    sessionStorage.setItem('dai_token', 't');
    sessionStorage.setItem('dai_user', JSON.stringify({ name: 'Ana', role: 'x', email: 'a@b.c', rolClave }));
    await TestBed.configureTestingModule({
      imports: [roles],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(roles);
    component = fixture.componentInstance;
    http.expectOne('/api/seguridad/roles').flush([]);
    http.expectOne('/api/catalogos').flush({ roles: [{ id: 1, clave: 'super-admin', nombre: 'Super Administrador' }, { id: 4, clave: 'read-only', nombre: 'Lector Restringido' }] });
    http.expectOne('/api/seguridad/usuarios').flush([usuario('1', 'super-admin'), usuario('2', 'read-only'), usuario('3', 'read-only')]);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  afterEach(() => {
    http.match('/api/notificaciones/resumen');
    http.verify();
    sessionStorage.clear();
  });

  it('total REAL de usuarios (nada de "de 45 operadores"), sin paginación falsa y roles desde /catalogos', async () => {
    await crear('super-admin');
    expect(texto()).toContain('Mostrando 3 de 3 usuarios');
    expect(texto()).not.toContain('45');
    const opciones = [...(fixture.nativeElement as HTMLElement).querySelectorAll('select option')].map((o) => o.textContent?.trim());
    expect(opciones).toEqual(['Todos los Roles', 'Super Administrador', 'Lector Restringido']);
    component.selectedRole.set('read-only');
    fixture.detectChanges();
    expect(texto()).toContain('Mostrando 2 de 3 usuarios');
    expect(texto()).toContain('Crear Usuario');
  });

  it('Cumplimiento no ve "Crear Usuario" (el servidor le responde 403)', async () => {
    await crear('compliance');
    expect(texto()).not.toContain('Crear Usuario');
  });
});
