import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Papelera } from './papelera';
import type { DocumentoEnPapelera, EstadoPapelera } from '../../shared/api';

const doc = (id: string, extra: Partial<DocumentoEnPapelera> = {}): DocumentoEnPapelera => ({
  id, nombre: `Doc ${id}.pdf`, folio: `EXP-${id}`, formato: 'pdf', version: 'v2.0', departamento: 'Legal',
  clasificacion: 'Uso Interno General', eliminadoPor: 'Ana', eliminadoEn: '16 Oct 2026, 9:00 a. m.', haceCuanto: 'Hace 5 minutos',
  purgaAutomatica: '15 Nov 2026, 9:00 a. m.', retencionHasta: null, versiones: 2, tamanoArchivos: '40 KB', tieneArchivo: true, ...extra,
});
const estado = (extra: Partial<EstadoPapelera> = {}): EstadoPapelera => ({
  diasRetencion: 30, puedePurgar: true, borrado: { pendientes: 0, con_error: 0 },
  documentos: [doc('1'), doc('2', { retencionHasta: '01 Mar 2034', purgaAutomatica: null })], ...extra,
});

describe('Papelera', () => {
  let fixture: ComponentFixture<Papelera>;
  let component: Papelera;
  let http: HttpTestingController;
  const texto = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Papelera],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Papelera);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear(); // se comparte entre archivos de specs
  });

  /** Primera carga de la papelera (más las peticiones de la barra lateral, que se ignoran). */
  const cargar = async (e: EstadoPapelera = estado()) => {
    http.expectOne('/api/papelera').flush(e);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('lista los documentos con su plazo de purga o su retención legal', async () => {
    await cargar();
    expect(component.documentos().length).toBe(2);
    expect(texto()).toContain('Purga automática: 15 Nov 2026, 9:00 a. m.');
    expect(texto()).toContain('Retención legal hasta 01 Mar 2034');
    expect(texto()).toContain('a los 30 días');
    expect(component.purgables()).toBe(1); // el retenido no cuenta para "Vaciar"
  });

  it('sin permiso (403): muestra el aviso y no la lista', async () => {
    http.expectOne('/api/papelera').flush({ error: 'No tienes permisos para esta acción' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();
    expect(component.sinPermiso()).toBe(true);
    expect(texto()).toContain('Sin acceso a la papelera');
  });

  it('cumplimiento: puede restaurar pero no ve los botones de purgar ni vaciar', async () => {
    await cargar(estado({ puedePurgar: false, borrado: null }));
    expect(texto()).not.toContain('Vaciar papelera');
    expect(texto()).not.toContain('Purgar');
    expect(texto()).toContain('Restaurar');
  });

  it('restaurar: llama a la API y quita el documento de la lista con un aviso', async () => {
    await cargar();
    component.restaurar(component.documentos()[0]);
    const req = http.expectOne('/api/papelera/1/restaurar');
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, id: '1' });
    expect(component.documentos().map((d) => d.id)).toEqual(['2']);
    expect(component.aviso()).toContain('se restauró');
  });

  it('purgar: exige un código de 6 dígitos, lo envía y retira el documento', async () => {
    await cargar();
    component.abrirPurga({ tipo: 'uno', doc: component.documentos()[0] });
    fixture.detectChanges();
    expect(texto()).toContain('Esta acción no se puede deshacer');
    component.codigo.set('12a');
    expect(component.codigoValido()).toBe(false);
    component.confirmarPurga(); // no envía nada con un código inválido
    component.codigo.set('123456');
    component.confirmarPurga();
    const req = http.expectOne('/api/papelera/1/purgar');
    expect(req.request.body).toEqual({ code: '123456' });
    req.flush({ ok: true, versiones: 2, objetos: 2 });
    expect(component.purga()).toBeNull();
    expect(component.documentos().map((d) => d.id)).toEqual(['2']);
    expect(component.aviso()).toContain('purgó definitivamente (2 versiones)');
  });

  it('purgar con código incorrecto: muestra el mensaje del servidor, limpia el código y deja el diálogo abierto', async () => {
    await cargar();
    component.abrirPurga({ tipo: 'uno', doc: component.documentos()[0] });
    component.codigo.set('000000');
    component.confirmarPurga();
    http.expectOne('/api/papelera/1/purgar').flush(
      { error: 'Código de verificación incorrecto o ya usado. Espere el siguiente código de su app.' }, { status: 403, statusText: 'Forbidden' });
    expect(component.purga()).not.toBeNull();
    expect(component.errorPurga()).toContain('incorrecto');
    expect(component.codigo()).toBe('');
    expect(component.documentos().length).toBe(2);
  });

  it('con código de recuperación envía codigoRecuperacion en mayúsculas', async () => {
    await cargar();
    component.abrirPurga({ tipo: 'uno', doc: component.documentos()[0] });
    component.alternarRecuperacion();
    component.codigo.set('abcde-12345');
    component.confirmarPurga();
    const req = http.expectOne('/api/papelera/1/purgar');
    expect(req.request.body).toEqual({ codigoRecuperacion: 'ABCDE-12345' });
    req.flush({ ok: true, versiones: 1, objetos: 1 });
  });

  it('vaciar: envía el código, resume el resultado y recarga la lista', async () => {
    await cargar();
    component.abrirPurga({ tipo: 'todo' });
    component.codigo.set('654321');
    component.confirmarPurga();
    const req = http.expectOne('/api/papelera/vaciar');
    expect(req.request.body).toEqual({ code: '654321' });
    req.flush({ ok: true, purgados: 1, enRetencion: 1, restantes: 0 });
    expect(component.aviso()).toContain('Se purgaron 1 documento.');
    expect(component.aviso()).toContain('1 con retención legal vigente se conservan');
    http.expectOne('/api/papelera').flush(estado({ documentos: [doc('2', { retencionHasta: '01 Mar 2034' })] }));
    expect(component.documentos().length).toBe(1);
  });

  it('el filtro busca por nombre, folio o departamento', async () => {
    await cargar();
    component.filtro.set('exp-2');
    expect(component.documentos().map((d) => d.id)).toEqual(['2']);
    component.filtro.set('nada');
    fixture.detectChanges();
    expect(texto()).toContain('Ningún documento coincide');
  });
});
