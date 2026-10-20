import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Notificaciones } from './notificaciones';

const notif = (id: string, extra: object = {}) => ({
  id, category: 'edicion', borderColor: 'border-l-amber-500', badge: 'Carpetas', badgeColor: '', icon: '📁',
  title: `Aviso ${id}`, description: 'Organización de la biblioteca.', time: 'Hace 1 minuto', fecha: '16 Oct 2026, 9:00 a. m.',
  creadoEn: new Date().toISOString(), meta: ['Folio: EXP-1'], read: true, documentoId: null, ...extra,
});

describe('Notificaciones', () => {
  let component: Notificaciones;
  let fixture: ComponentFixture<Notificaciones>;
  let http: HttpTestingController;
  const texto = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Notificaciones],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Notificaciones);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy(); // detiene el sondeo cada 5 s
    http.match(() => true);
    sessionStorage.clear();
  });

  it('"Abrir documento" solo si hay documentoId; las acciones antiguas (botones sin función) no se pintan', async () => {
    http.expectOne('/api/notificaciones').flush([
      notif('1', { documentoId: '42', actions: [{ label: 'Descargar Certificado de Integridad', style: 'border' }] }),
      notif('2'),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(texto()).not.toContain('Descargar Certificado de Integridad');
    const botones = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].filter((b) => b.textContent?.includes('Abrir documento'));
    expect(botones.length).toBe(1);
    const navegar = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    botones[0].click();
    expect(navegar).toHaveBeenCalledWith(['/documento', '42']);
  });

  it('pestañas según el rol: solo las categorías que el servidor indica, con su contador', async () => {
    http.expectOne('/api/notificaciones/categorias').flush({ categorias: ['seguridad', 'solicitud', 'edicion', 'version'] });
    http.expectOne('/api/notificaciones').flush([
      notif('1'), notif('2', { category: 'seguridad', title: 'Nuevo inicio de sesión en tu cuenta' }), notif('3', { category: 'edicion' }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const pestanas = [...(fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]')].map((b) => b.textContent?.trim());
    expect(pestanas).toEqual(['Todas 3', 'Alertas de Seguridad 1', 'Solicitudes 0', 'Carpetas y Movimientos 2', 'Nuevas Versiones 0']);
    expect(texto()).not.toContain('Consultas de Documentos');
    expect(texto()).not.toContain('Papelera');
    component.setTab('seguridad');
    fixture.detectChanges();
    expect(component.filtered().map((n) => n.title)).toEqual(['Nuevo inicio de sesión en tu cuenta']);
  });

  it('Lector: solo "Todas" y "Alertas de Seguridad"', async () => {
    http.expectOne('/api/notificaciones/categorias').flush({ categorias: ['seguridad'] });
    http.expectOne('/api/notificaciones').flush([]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect([...(fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]')].map((b) => b.textContent?.trim()))
      .toEqual(['Todas 0', 'Alertas de Seguridad 0']);
  });

  it('sin paneles inventados: ni "Configurar alertas", ni "Actividad Semanal", ni e-IDAS, ni ticket', async () => {
    http.expectOne('/api/notificaciones').flush([]);
    fixture.detectChanges();
    await fixture.whenStable();
    for (const falso of ['Configurar alertas', 'Actividad Semanal', '1,842', '+12%', 'e-IDAS', 'ticket prioritario'])
      expect(texto()).not.toContain(falso);
    expect(texto()).toContain('Contacte al administrador del sistema');
    expect(component.notifications()).toEqual([]);
  });
});
