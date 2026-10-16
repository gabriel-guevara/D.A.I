import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VersionesDocumento, VersionParaVer } from './versiones-documento';
import type { HistorialVersiones, VersionDocumento } from '../../shared/api';

const version = (id: string, v: string, actual: boolean, extra: Partial<VersionDocumento> = {}): VersionDocumento => ({
  id, version: v, actual, hash: 'a'.repeat(64), hashCorto: 'aaaa...aaaa', tamanoBytes: 4096, tamano: '4 KB', paginas: 2,
  nombreOriginal: 'Contrato.pdf', comentario: `Comentario ${v}`, autor: 'Ana', fecha: '16 Oct 2026, 9:00 a. m.', tieneArchivo: true, ...extra,
});
const historial = (puedeGestionar = true): HistorialVersiones => ({
  versionActual: 'v2.0', puedeGestionar,
  versiones: [version('11', 'v2.0', true), version('10', 'v1.0', false), version('9', 'v0.9', false, { tieneArchivo: false, hash: null })],
});

describe('VersionesDocumento (historial de versiones del detalle)', () => {
  let fixture: ComponentFixture<VersionesDocumento>;
  let component: VersionesDocumento;
  let http: HttpTestingController;
  const texto = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const crearUrl = vi.fn(() => 'blob:prueba');

  beforeEach(async () => {
    Object.assign(URL, { createObjectURL: crearUrl, revokeObjectURL: vi.fn() });
    crearUrl.mockClear();
    await TestBed.configureTestingModule({
      imports: [VersionesDocumento],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(VersionesDocumento);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('documentoId', '7');
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  const cargar = (h = historial()) => {
    fixture.detectChanges(); // ngOnInit
    http.expectOne('/api/documentos/7/versiones').flush(h);
    fixture.detectChanges();
  };

  it('lista las versiones con la actual marcada; las históricas sin archivo no ofrecen acciones', () => {
    cargar();
    expect(texto()).toContain('Actual');
    expect(texto()).toContain('Comentario v1.0');
    expect(texto()).toContain('Registro histórico sin archivo original');
    expect(texto()).toContain('Restaurar como actual');
    expect(texto()).toContain('Subir nueva versión');
  });

  it('sin permiso de gestión: no muestra subir ni restaurar', () => {
    cargar(historial(false));
    expect(texto()).not.toContain('Restaurar como actual');
    expect(texto()).not.toContain('Subir nueva versión');
  });

  it('Ver: pide el PDF de esa versión y lo entrega al visor del detalle', () => {
    cargar();
    const emitidos: VersionParaVer[] = [];
    component.ver.subscribe((v) => emitidos.push(v));
    component.verVersion(component.historial()!.versiones[1]);
    const req = http.expectOne('/api/documentos/7/versiones/10/archivo');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.4']));
    expect(emitidos.map((e) => [e.version, e.actual])).toEqual([['v1.0', false]]);
  });

  it('Descargar una versión anterior: la guarda con la versión en el nombre', () => {
    cargar();
    const v1 = component.historial()!.versiones[1];
    expect(component.nombreDescarga(v1)).toBe('Contrato (v1.0).pdf');
    expect(component.nombreDescarga(component.historial()!.versiones[0])).toBe('Contrato.pdf');
    component.descargar(v1);
    http.expectOne('/api/documentos/7/versiones/10/descarga').flush(new Blob(['%PDF-1.4']));
    expect(crearUrl).toHaveBeenCalledTimes(1);
  });

  it('error al ver un archivo que no está: muestra el mensaje JSON que llega como Blob', async () => {
    cargar();
    component.verVersion(component.historial()!.versiones[1]);
    const cuerpo = new Blob([JSON.stringify({ error: 'Archivo no disponible en este entorno', codigo: 'no_disponible' })]);
    http.expectOne('/api/documentos/7/versiones/10/archivo').flush(cuerpo, { status: 404, statusText: 'Not Found' });
    await vi.waitFor(() => expect(component.errorVersion()?.mensaje).toBe('Archivo no disponible en este entorno'));
  });

  it('restaurar: pide confirmación, llama a la API, recarga y avisa al detalle', () => {
    cargar();
    const cambios: string[] = [];
    component.cambio.subscribe((v) => cambios.push(v));
    component.pedirRestaurar(component.historial()!.versiones[1]);
    fixture.detectChanges();
    expect(texto()).toContain('¿Hacer de la v1.0 la versión actual?');
    component.restaurar();
    const req = http.expectOne('/api/documentos/7/versiones/10/restaurar');
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, version: 'v1.0', anterior: 'v2.0' });
    http.expectOne('/api/documentos/7/versiones').flush(historial());
    expect(cambios).toEqual(['v1.0']);
    expect(component.aviso()).toContain('La versión v1.0 vuelve a ser la actual');
  });

  it('subir: exige archivo y comentario, envía multipart y avisa al detalle', () => {
    cargar();
    const cambios: string[] = [];
    component.cambio.subscribe((v) => cambios.push(v));
    const entrada = document.createElement('input');
    const archivo = new File(['%PDF-1.4'], 'Contrato v3.pdf', { type: 'application/pdf' });
    component.elegirArchivo({ target: { files: [archivo] } } as unknown as Event);
    component.comentario.set('ab');
    component.subir(entrada);
    http.expectNone('/api/documentos/7/versiones'); // comentario demasiado corto: no se envía
    component.comentario.set('Ajuste de la cláusula 7');
    component.subir(entrada);
    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/documentos/7/versiones');
    const cuerpo = req.request.body as FormData;
    expect(cuerpo.get('comentario')).toBe('Ajuste de la cláusula 7');
    expect((cuerpo.get('archivo') as File).name).toBe('Contrato v3.pdf');
    req.flush({ id: '12', version: 'v3.0', anterior: 'v2.0', hash: 'b'.repeat(64), hashCorto: 'bbbb...bbbb', tamanoBytes: 8, tamano: '8 B',
      paginas: 1, nombreOriginal: 'Contrato v3.pdf', comentario: 'Ajuste de la cláusula 7', indexacion: 'pendiente' });
    http.expectOne((r) => r.method === 'GET' && r.url === '/api/documentos/7/versiones').flush(historial());
    expect(cambios).toEqual(['v3.0']);
    expect(component.aviso()).toContain('Versión v3.0 subida');
    expect(component.archivo()).toBeNull();
  });

  it('subir un archivo idéntico (409): muestra el mensaje del servidor', () => {
    cargar();
    component.elegirArchivo({ target: { files: [new File(['%PDF'], 'x.pdf', { type: 'application/pdf' })] } } as unknown as Event);
    component.comentario.set('Mismo archivo');
    component.subir(document.createElement('input'));
    http.expectOne((r) => r.method === 'POST').flush(
      { error: 'El archivo es idéntico a la versión actual (mismo SHA-256). No se creó una versión nueva.', codigo: 'sin_cambios' },
      { status: 409, statusText: 'Conflict' });
    expect(component.errorSubida()).toContain('idéntico');
  });

  it('rechaza en el navegador un archivo que no es PDF', () => {
    cargar();
    component.elegirArchivo({ target: { files: [new File(['hola'], 'notas.txt', { type: 'text/plain' })] } } as unknown as Event);
    expect(component.archivo()).toBeNull();
    expect(component.errorSubida()).toBe('Seleccione un archivo PDF.');
  });
});
