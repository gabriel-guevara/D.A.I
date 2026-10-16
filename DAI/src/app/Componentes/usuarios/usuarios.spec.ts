import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UsuariosGestion } from './usuarios';

describe('UsuariosGestion', () => {
  let component: UsuariosGestion;
  let fixture: ComponentFixture<UsuariosGestion>;

  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [UsuariosGestion],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(UsuariosGestion);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('sin sesión de Super Administrador no permite la pestaña de modificar', () => {
    component.setTab('modificar');
    expect(component.tab()).toBe('crear');
  });

  it('restablecer 2FA exige el código 6 dígitos del administrador antes de llamar al servidor', () => {
    component.seleccionado.set({
      id: '7', name: 'Pepe', email: 'p@dai.corp', initials: 'P', avatarColor: '', departamento: '—', rol: 'read-only',
      rolLabel: 'Lector', mfaMethod: 'TOTP', mfaActivo: true, nivel: 'Nivel 2 Confidencial', activo: true, ultimoAcceso: 'Nunca',
    });
    component.codigoRestablecer.set('12');
    component.restablecer2fa();
    expect(component.mensajeError()).toContain('6 dígitos');
  });

  it('la contraseña inicial sigue la política del servidor (mínimo 10)', () => {
    component.formCrear.set({ nombre: 'Pepe Pérez', email: 'p@dai.corp', password: 'Corta123', rol: 'read-only', departamento: '', nivel: 'x', mfaMetodo: 'TOTP', activo: true });
    component.crearUsuario();
    expect(component.mensajeError()).toContain('entre 10 y 72');
  });

  it('valida los campos obligatorios antes de crear', () => {
    component.crearUsuario();
    expect(component.mensajeError()).toContain('nombre');
  });
});
