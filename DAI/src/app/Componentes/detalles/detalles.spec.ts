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
const sinArchivo = { ...base, tieneArchivo: false, archivo: null, puedeVerificar: false, indexacion: null, textoOrigen: 'demo', puedeReindexar: false };
const ix = (estado: string, extra: object = {}) => ({
  estado, etiqueta: estado, descripcion: `desc ${estado}`, aviso: null, paginasConTexto: null, paginasTotales: null,
  caracteres: null, errorCodigo: null, fecha: '16 Oct 2026, 9:00 a. m.', ...extra,
});

describe('detalles (visor de documento)', () => {
  let fixture: ComponentFixture<detalles>;
  let component: detalles;
  let http: HttpTestingController;
  const crearUrl = vi.fn(() => 'blob:prueba');
  const revocarUrl = vi.fn();
  let consulta: Record<string, string> = {};

  /** Crea el componente (cada prueba elige antes los query params: ?pagina=N viene de la búsqueda). */
  const crear = (q: Record<string, string> = {}) => {
    consulta = q;
    fixture = TestBed.createComponent(detalles);
    component = fixture.componentInstance;
  };

  beforeEach(async () => {
    // jsdom no implementa object URLs: se simulan para comprobar que se crean y se revocan.
    Object.assign(URL, { createObjectURL: crearUrl, revokeObjectURL: revocarUrl });
    crearUrl.mockClear();
    revocarUrl.mockClear();
    await TestBed.configureTestingModule({
      imports: [detalles],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: '7' }), get queryParamMap() { return convertToParamMap(consulta); } } },
        },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('con archivo: pide el PDF como blob, lo muestra y revoca el object URL al destruirse', async () => {
    crear();
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
    crear();
    http.expectOne('/api/documentos/7').flush(conArchivo);
    const cuerpo = new Blob([JSON.stringify({ error: 'Archivo no disponible en este entorno', codigo: 'no_disponible' })]);
    http.expectOne('/api/documentos/7/archivo').flush(cuerpo, { status: 404, statusText: 'Not Found' });
    await vi.waitFor(() => expect(component.visor()).toBe('no_disponible'));
  });

  it('sin archivo: no pide el PDF, muestra la capa de texto y no ofrece cifrado', () => {
    crear();
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
    crear();
    http.expectOne('/api/documentos/7').flush(conArchivo);
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-']));
    component.verificarIntegridad();
    const req = http.expectOne('/api/documentos/7/verificar-integridad');
    expect(req.request.method).toBe('POST');
    req.flush({ integro: false, hashEsperado: 'a', hashCalculado: 'b', tamanoEsperado: 1, tamanoCalculado: 1, verificadoEn: 'ahora' });
    expect(component.verificacion()?.integro).toBe(false);
  });

  it('desde la búsqueda (?pagina=3): abre el PDF en esa página con #page=3 y permite volver a ella', () => {
    crear({ pagina: '3' });
    http.expectOne('/api/documentos/7').flush({ ...conArchivo, indexacion: ix('procesado') });
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-1.4']));
    expect(component.paginaObjetivo()).toBe(3);
    expect(String(component.pdfUrl())).toContain('blob:prueba#page=3');
    component.irAPaginaCoincidencia();
    expect(crearUrl).toHaveBeenCalledTimes(2); // URL nuevo: el visor nativo recarga en la página pedida
    expect(revocarUrl).toHaveBeenCalledTimes(1);
  });

  it('?pagina no numérica se ignora; sin archivo abre la capa de texto en la página pedida', () => {
    crear({ pagina: '2' });
    http.expectOne('/api/documentos/7').flush(sinArchivo);
    http.expectOne('/api/documentos/7/paginas/2').flush({ pagina: 2, totalPaginas: 2, seccion: null, texto: 'Dos', confianza: null, origen: 'demo' });
    expect(component.currentPage()).toBe(2);
    fixture.destroy();
    crear({ pagina: '1;alert(1)' });
    expect(component.paginaObjetivo()).toBeNull();
    http.expectOne('/api/documentos/7').flush(conArchivo);
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-']));
    expect(String(component.pdfUrl())).not.toContain('#page');
  });

  it('texto pendiente: consulta el estado cada 4 s hasta que termina, y deja de consultar al salir', () => {
    vi.useFakeTimers();
    crear();
    http.expectOne('/api/documentos/7').flush({ ...conArchivo, indexacion: ix('pendiente') });
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-']));
    vi.advanceTimersByTime(4000);
    http.expectOne('/api/documentos/7/indexacion').flush(ix('procesando'));
    vi.advanceTimersByTime(4000);
    http.expectOne('/api/documentos/7/indexacion').flush(ix('procesado', { paginasConTexto: 2, paginasTotales: 2 }));
    expect(component.indexacion()?.estado).toBe('procesado');
    vi.advanceTimersByTime(20_000);
    http.expectNone('/api/documentos/7/indexacion'); // terminado: no más consultas

    fixture.destroy();
    crear();
    http.expectOne('/api/documentos/7').flush({ ...conArchivo, indexacion: ix('pendiente') });
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-']));
    fixture.destroy();
    vi.advanceTimersByTime(10_000);
    http.expectNone('/api/documentos/7/indexacion');
  });

  it('reprocesar: POST /reindexar, vuelve a vigilar el estado y muestra el 403 con un mensaje claro', () => {
    vi.useFakeTimers();
    crear();
    http.expectOne('/api/documentos/7').flush({ ...conArchivo, indexacion: ix('error'), puedeReindexar: true });
    http.expectOne('/api/documentos/7/archivo').flush(new Blob(['%PDF-']));
    component.reindexar();
    const req = http.expectOne('/api/documentos/7/reindexar');
    expect(req.request.method).toBe('POST');
    req.flush(ix('pendiente'));
    expect(component.indexacion()?.estado).toBe('pendiente');
    vi.advanceTimersByTime(4000);
    http.expectOne('/api/documentos/7/indexacion').flush(ix('procesado'));

    component.reindexar();
    http.expectOne('/api/documentos/7/reindexar').flush({ error: 'x' }, { status: 403, statusText: 'Forbidden' });
    expect(component.reindexarError()).toContain('Operador OCR');
  });
});
