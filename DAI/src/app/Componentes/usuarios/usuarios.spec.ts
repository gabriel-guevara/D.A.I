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

  it('valida los campos obligatorios antes de crear', () => {
    component.crearUsuario();
    expect(component.mensajeError()).toContain('nombre');
  });
});
