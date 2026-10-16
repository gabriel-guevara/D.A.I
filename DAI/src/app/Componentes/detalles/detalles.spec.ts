import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { detalles } from './detalles';

const base = {
  id: '7', nombre: 'Contrato.pdf', version: 'v1.0', folio: 'EXP-1', departamento: 'Legal', clasificacion: 'Uso Interno General',
  hash: 'a'.repeat(64), autorLinea: 'Ana', fechaCreacion: '16 Oct 2026, 9:00 a. m.', tamano: '4 KB', paginas: 2,
  etiquetas: [], retencion: null, firmadoPor: null, ultimaVerificacion: null,
};
const conArchivo = {
  ...base, tieneArchivo: true, puedeVerificar: true,
  archivo: { nombreOriginal: 'Contrato.pdf', tamanoBytes: 4096, almacenamiento: 'r2', cifradoEnReposo: true },
};
const sinArchivo = { ...base, tieneArchivo: false, archivo: null, puedeVerificar: false };

describe('detalles (visor de documento)', () => {
  let fixture: ComponentFixture<detalles>;
  let component: detalles;
  let http: HttpTestingController;
  const crearUrl = vi.fn(() => 'blob:prueba');
  const revocarUrl = vi.fn();

  beforeEach(async () => {
    // jsdom no implementa object URLs: se simulan para comprobar que se crean y se revocan.
    Object.assign(URL, { createObjectURL: crearUrl, revokeObjectURL: revocarUrl });
    crearUrl.mockClear();
    revocarUrl.mockClear();
    await TestBed.configureTestingModule({
      imports: [detalles],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: '7' }) } } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(detalles);
    component = fixture.componentInstance;
  });

  afterEach(() => http.verify());

  it('con archivo: pide el PDF como blob, lo muestra y revoca el object URL al destruirse', async () => {
    http.expectOne('/api/documentos/7').flush(conArchivo);
    const req = http.expectOne('/api/documentos/7/archivo');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));

    expect(component.visor()).toBe('listo');
    expect(crearUrl).toHaveBeenCalledTimes(1);
    expect(component.etiquetaCifrado()).toContain('Cloudflare R2');
    fixture.destroy();
    expect(revocarUrl).toHaveBeenCalledWith('blob:prueba');
  });

  it('objeto inexistente en este entorno: estado "no_disponible"', async () => {
    http.expectOne('/api/documentos/7').flush(conArchivo);
    const cuerpo = new Blob([JSON.stringify({ error: 'Archivo no disponible en este entorno', codigo: 'no_disponible' })]);
    http.expectOne('/api/documentos/7/archivo').flush(cuerpo, { status: 404, statusText: 'Not Found' });
    await vi.waitFor(() => expect(component.visor()).toBe('no_disponible'));
  });

  it('sin archivo: no pide el PDF, muestra la capa de texto y no ofrece cifrado', () => {
    http.expectOne('/api/documentos/7').flush(sinArchivo);
    http.expectNone('/api/documentos/7/archivo');
    http.expectOne('/api/documentos/7/paginas/1').flush({ pagina: 1, totalPaginas: 2, seccion: null, texto: 'Hola', confianza: null });
    expect(component.visor()).toBe('sin_archivo');
    expect(component.paginaTexto()?.texto).toBe('Hola');
    expect(component.etiquetaCifrado()).toBeNull();
    component.nextPage();
    http.expectOne('/api/documentos/7/paginas/2').flush({}, { status: 404, statusText: 'Not Found' });
    expect(component.paginaTextoError()).toContain('no tiene texto');
  });

  it('verificar integridad: muestra el resultado', () => {
    http.expectOne('/api/documentos/7').flush(conArchivo);
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-']));
    component.verificarIntegridad();
    const req = http.expectOne('/api/documentos/7/verificar-integridad');
    expect(req.request.method).toBe('POST');
    req.flush({ integro: false, hashEsperado: 'a', hashCalculado: 'b', tamanoEsperado: 1, tamanoCalculado: 1, verificadoEn: 'ahora' });
    expect(component.verificacion()?.integro).toBe(false);
  });
});
