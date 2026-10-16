import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Digitalizacion } from './digitalizacion';

const catalogos = {
  departamentos: [{ id: 1, nombre: 'Legal' }], tiposDocumentales: [], subida: { maxMb: 1 },
  clasificaciones: [{ id: 1, nombre: 'Secreto Corporativo', permitida: false }, { id: 3, nombre: 'Uso Interno General', permitida: true }],
};
const pdf = (bytes = '%PDF-1.4 contenido', nombre = 'acta.pdf') => new File([bytes], nombre, { type: 'application/pdf' });

describe('Digitalizacion (subida real)', () => {
  let component: Digitalizacion;
  let fixture: ComponentFixture<Digitalizacion>;
  let http: HttpTestingController;

  beforeEach(async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:previa'), revokeObjectURL: vi.fn() });
    await TestBed.configureTestingModule({
      imports: [Digitalizacion],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Digitalizacion);
    component = fixture.componentInstance;
    http.expectOne('/api/catalogos').flush(catalogos);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  it('rechaza en el navegador un archivo que no empieza por %PDF- o que supera el máximo', async () => {
    await component.elegirArchivo(new File(['\x89PNG....'], 'falso.pdf', { type: 'application/pdf' }));
    expect(component.estado()).toBe('vacio');
    expect(component.mensajeError()).toContain('%PDF-');
    await component.elegirArchivo(pdf('%PDF-' + 'x'.repeat(1024 * 1024 + 1)));
    expect(component.mensajeError()).toContain('1 MB');
  });

  it('exige clasificación antes de habilitar "Aprobar e Indexar"', async () => {
    await component.elegirArchivo(pdf());
    expect(component.estado()).toBe('listo');
    expect(component.puedeEnviar()).toBe(false);
    component.actualizar('clasificacion', 'Uso Interno General');
    expect(component.puedeEnviar()).toBe(true);
  });

  it('envía multipart con los metadatos, muestra el progreso y el resultado', async () => {
    await component.elegirArchivo(pdf());
    component.actualizar('clasificacion', 'Uso Interno General');
    component.actualizar('departamento', 'Legal');
    component.aprobarEIndexar();

    const req = http.expectOne('/api/digitalizacion/documentos');
    const cuerpo = req.request.body as FormData;
    expect(cuerpo.get('clasificacion')).toBe('Uso Interno General');
    expect(cuerpo.get('departamento')).toBe('Legal');
    expect((cuerpo.get('archivo') as File).name).toBe('acta.pdf');
    expect(req.request.reportProgress).toBe(true);

    req.event({ type: HttpEventType.UploadProgress, loaded: 50, total: 100 });
    expect(component.progreso()).toBe(50);
    req.flush({ id: '9', folio: 'EXP-1', nombre: 'acta', nombreOriginal: 'acta.pdf', hash: 'f'.repeat(64), hashCorto: 'ffff...ffff', tamanoBytes: 18, tamano: '18 B', paginas: 1 });
    expect(component.estado()).toBe('exito');
    expect(component.resultado()?.id).toBe('9');
    http.expectNone('/api/digitalizacion/cola'); // la cola de escáner inventada ya no existe
  });

  it('muestra el mensaje del servidor y conserva el archivo para reintentar', async () => {
    await component.elegirArchivo(pdf());
    component.actualizar('clasificacion', 'Uso Interno General');
    component.aprobarEIndexar();
    http.expectOne('/api/digitalizacion/documentos').flush(
      { error: 'El PDF está protegido con contraseña de apertura.', codigo: 'protegido' }, { status: 422, statusText: 'Unprocessable' });
    await vi.waitFor(() => expect(component.mensajeError()).toContain('contraseña'));
    expect(component.estado()).toBe('listo');
    expect(component.archivo()).not.toBeNull();
  });
});
