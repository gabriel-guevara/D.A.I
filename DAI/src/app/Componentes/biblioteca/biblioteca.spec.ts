import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { Biblioteca } from './biblioteca';
import type { DocumentoBiblioteca, ListaCarpetas, RespuestaBiblioteca, SolicitudMovimiento } from '../../shared/api';

const doc = (id: string, extra: Partial<DocumentoBiblioteca> = {}): DocumentoBiblioteca => ({
  id, name: `Doc ${id}.pdf`, version: 'v1.0', format: 'pdf', hashLabel: 'SHA-256: abcd...ef01', folio: `EXP-${id}`,
  departamento: 'Legal', departamentoColor: '', autor: 'Ana', autorEmail: '', tamano: '1 MB', carpeta: null,
  tieneArchivo: true, nombreOriginal: `original-${id}.pdf`, actualizado: '16 Oct 2026, 9:00 a. m.', ...extra,
});
const pagina = (docs: DocumentoBiblioteca[], extra: Partial<RespuestaBiblioteca> = {}): RespuestaBiblioteca => ({
  documentos: docs, total: docs.length, pagina: 1, porPagina: 25, resumen: { total: 1420, actualizados30: 892 }, ...extra,
});
const carpetas = (permisos: Partial<ListaCarpetas['permisos']> = {}): ListaCarpetas => ({
  carpetas: [{ id: '3', nombre: 'Contratos', documentos: 2 }, { id: '4', nombre: 'Auditorías', documentos: 0 }],
  sinCarpeta: 5,
  permisos: { gestionar: false, eliminar: false, solicitar: false, resolver: false, ...permisos },
});
const solicitud = (id: string, extra: Partial<SolicitudMovimiento> = {}): SolicitudMovimiento => ({
  id, documento: { id: '9', nombre: 'Dictamen.docx', folio: 'EXP-9' }, carpetaActual: null, carpetaDestino: { id: '4', nombre: 'Auditorías' },
  solicitante: 'Mateo', motivo: 'Es del cierre de auditoría', estado: 'pendiente', fecha: '16 Oct 2026, 8:00 a. m.',
  resueltoPor: null, resueltoEn: null, respuesta: null, puedeResolver: true, ...extra,
});

describe('Biblioteca', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let comp: Biblioteca;
  const texto = () => (harness.routeNativeElement as HTMLElement).textContent ?? '';
  const esDocumentos = (r: { url: string }) => r.url === '/api/documentos';

  async function abrir(url = '/biblioteca', rolClave = 'super-admin', permisos: Partial<ListaCarpetas['permisos']> = { gestionar: true, eliminar: true, resolver: true }) {
    sessionStorage.setItem('dai_token', 'token-de-prueba');
    sessionStorage.setItem('dai_user', JSON.stringify({ name: 'Ana', role: 'x', email: 'a@b.c', rolClave, nivel: 'Nivel 5 Secreto' }));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: 'biblioteca', component: Biblioteca }])],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    comp = await harness.navigateByUrl(url, Biblioteca);
    await harness.fixture.whenStable();
    http.expectOne('/api/catalogos').flush({ departamentos: [{ id: 1, nombre: 'Legal' }, { id: 2, nombre: 'Finanzas' }] });
    http.expectOne('/api/carpetas').flush(carpetas(permisos));
  }

  /** La petición de la lista que está en curso. */
  const lista = () => http.expectOne(esDocumentos);
  const responder = async (req: TestRequest, r: RespuestaBiblioteca) => {
    req.flush(r);
    await harness.fixture.whenStable();
  };

  afterEach(() => {
    http.match('/api/notificaciones/resumen'); // la barra lateral: no interesa aquí
    http.verify();
    sessionStorage.clear(); // se comparte entre archivos de specs
  });

  it('filtros desde la URL → petición al servidor, chips reales y tarjetas con el resumen', async () => {
    await abrir('/biblioteca?formato=pdf&departamento=Legal&carpeta=3&orden=nombre&pagina=2&porPagina=50&dias=90', 'super-admin');
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    const req = lista();
    expect(req.request.params.get('formato')).toBe('pdf');
    expect(req.request.params.get('departamento')).toBe('Legal');
    expect(req.request.params.get('carpeta')).toBe('3');
    expect(req.request.params.get('orden')).toBe('nombre');
    expect(req.request.params.get('pagina')).toBe('2');
    expect(req.request.params.get('porPagina')).toBe('50');
    expect(req.request.params.get('dias')).toBe('90');
    expect(req.request.params.has('q')).toBe(false); // vacío: no se envía
    await responder(req, pagina([doc('1')], { total: 60, pagina: 2, porPagina: 50 }));
    harness.detectChanges();
    expect(comp.chips().map((c) => c.texto)).toEqual(['Departamento: Legal', 'Formato: PDF', 'Últimos 3 meses', 'Carpeta: Contratos']);
    expect(texto()).toContain('1.420'); // resumen real, con separador de miles de Colombia
    expect(texto()).toContain('892');
    expect(texto()).toContain('Mostrando 51–60 de 60 documentos');
  });

  it('cambiar un filtro lo escribe en la URL, vuelve a la página 1 y quitar el chip lo borra', async () => {
    await abrir('/biblioteca?pagina=3', 'read-only', {});
    await responder(lista(), pagina([doc('1')], { total: 80, pagina: 3 }));
    const router = TestBed.inject(Router);

    comp.aplicar({ formato: 'xlsx' });
    await harness.fixture.whenStable();
    expect(router.url).toBe('/biblioteca?formato=xlsx'); // pagina=1 es el valor por defecto: no aparece
    const req = lista();
    expect(req.request.params.get('formato')).toBe('xlsx');
    expect(req.request.params.get('pagina')).toBe('1');
    await responder(req, pagina([doc('2', { format: 'xlsx' })]));

    comp.quitarFiltro('formato');
    await harness.fixture.whenStable();
    expect(router.url).toBe('/biblioteca');
    await responder(lista(), pagina([doc('1')]));
  });

  it('paginación real: siguiente página por la URL y, si la página quedó vacía, salta a la última', async () => {
    await abrir('/biblioteca', 'read-only', {});
    await responder(lista(), pagina(Array.from({ length: 25 }, (_, i) => doc(String(i + 1))), { total: 30 }));
    expect([comp.desde(), comp.hasta(), comp.totalPaginas()]).toEqual([1, 25, 2]);
    comp.irAPagina(2);
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/biblioteca?pagina=2');
    // Entre tanto alguien movió documentos: la página 2 ya no tiene nada y el total bajó a 20.
    await responder(lista(), pagina([], { total: 20, pagina: 2 }));
    expect(TestBed.inject(Router).url).toBe('/biblioteca');
    await responder(lista(), pagina(Array.from({ length: 20 }, (_, i) => doc(String(i + 1))), { total: 20 }));
    expect([comp.desde(), comp.hasta(), comp.totalPaginas()]).toEqual([1, 20, 1]);
  });

  it('mover (Admin/Operador): envía los ids y la carpeta, informa el resultado y recarga', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1'), doc('2')]));
    comp.toggleSelectAll();
    comp.abrir('mover');
    await comp.moverSeleccion();
    expect(comp.errorDialogo()).toContain('Elija la carpeta');
    comp.destino.set('3');
    const promesa = comp.moverSeleccion();
    const req = http.expectOne('/api/carpetas/mover');
    expect(req.request.body).toEqual({ ids: ['1', '2'], carpetaId: '3' });
    req.flush({ movidos: 1, sinCambios: 0, omitidos: ['2'] });
    await promesa;
    expect(comp.dialogo()).toBeNull();
    expect(comp.aviso()?.texto).toBe('Se movió 1 documento a «Contratos». 1 se omitieron (sin acceso o ya no están activos).');
    await harness.fixture.whenStable();
    http.expectOne('/api/carpetas').flush(carpetas({ gestionar: true, resolver: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1', { carpeta: { id: '3', nombre: 'Contratos' } }), doc('2')]));
    expect(comp.selectedCount()).toBe(0);
  });

  it('Cumplimiento no mueve: solicita con motivo (una por documento) y ve "Solicitar movimiento"', async () => {
    await abrir('/biblioteca', 'compliance', { solicitar: true });
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([solicitud('5', { puedeResolver: false })]);
    await responder(lista(), pagina([doc('1'), doc('2')]));
    comp.toggleSelectAll();
    harness.detectChanges();
    expect(texto()).toContain('Solicitar movimiento');
    expect(texto()).not.toContain('↔ Mover');
    expect(texto()).toContain('Mis solicitudes de movimiento pendientes');
    expect(texto()).not.toContain('Aprobar y mover');

    comp.abrir('solicitar');
    comp.destino.set('sin');
    comp.motivo.set('corto');
    await comp.solicitarSeleccion();
    expect(comp.errorDialogo()).toContain('mínimo 10');
    comp.motivo.set('Ya no pertenece a ninguna carpeta');
    const promesa = comp.solicitarSeleccion();
    const r1 = http.expectOne('/api/carpetas/solicitudes');
    expect(r1.request.body).toEqual({ documentoId: '1', carpetaId: null, motivo: 'Ya no pertenece a ninguna carpeta' });
    r1.flush({ id: '10' });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
    http.expectOne('/api/carpetas/solicitudes').flush({ error: 'Ya hay una solicitud de movimiento pendiente para este documento.' }, { status: 409, statusText: 'Conflict' });
    await promesa;
    expect(comp.aviso()?.texto).toContain('Se envió 1 solicitud de movimiento a «Sin carpeta»');
    expect(comp.aviso()?.texto).toContain('Doc 2.pdf: Ya hay una solicitud de movimiento pendiente');
    await harness.fixture.whenStable();
    http.expectOne('/api/carpetas').flush(carpetas({ solicitar: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1'), doc('2')]));
  });

  it('aprobar y rechazar solicitudes (el rechazo exige motivo)', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([solicitud('5'), solicitud('6')]);
    await responder(lista(), pagina([doc('1')]));
    harness.detectChanges();
    expect(texto()).toContain('Solicitudes de movimiento por resolver');

    const aprobar = comp.aprobar(comp.solicitudes()[0]);
    http.expectOne('/api/carpetas/solicitudes/5/aprobar').flush({ ok: true, estado: 'aprobada' });
    await aprobar;
    expect(comp.aviso()?.texto).toBe('Solicitud aprobada: «Dictamen.docx» se movió a «Auditorías».');
    await harness.fixture.whenStable();
    http.expectOne('/api/carpetas').flush(carpetas({ gestionar: true, resolver: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([solicitud('6')]);
    await responder(lista(), pagina([doc('1')]));

    const s6 = comp.solicitudes()[0];
    comp.empezarRechazo(s6);
    await comp.rechazar(s6);
    expect(comp.aviso()?.texto).toContain('motivo del rechazo');
    comp.respuestaRechazo.set('No procede');
    const rechazar = comp.rechazar(s6);
    const req = http.expectOne('/api/carpetas/solicitudes/6/rechazar');
    expect(req.request.body).toEqual({ respuesta: 'No procede' });
    req.flush({ ok: true, estado: 'rechazada' });
    await rechazar;
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    expect(comp.aviso()?.texto).toContain('no se movió');
  });

  it('descarga múltiple: secuencial, omite los que no tienen archivo e informa; máximo 20', async () => {
    await abrir('/biblioteca', 'read-only', {});
    await responder(lista(), pagina([doc('1'), doc('2', { tieneArchivo: false, nombreOriginal: null }), doc('3')]));
    const clics: string[] = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:prueba'), revokeObjectURL: vi.fn() });
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clics.push(this.download); };
    try {
      comp.toggleSelectAll();
      const promesa = comp.descargarSeleccion();
      // Secuencial: la segunda no se pide hasta que llega la primera.
      http.expectOne('/api/documentos/1/descarga').flush(new Blob(['%PDF-1']));
      http.expectNone('/api/documentos/3/descarga');
      await new Promise((r) => setTimeout(r));
      http.expectOne('/api/documentos/3/descarga').flush(new Blob(['%PDF-3']));
      await promesa;
      expect(clics).toEqual(['original-1.pdf', 'original-3.pdf']);
      expect(comp.aviso()).toEqual({ tipo: 'ok', texto: 'Se descargaron 2 archivos. 1 documento no tiene archivo original y se omitieron.' });
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }

    // Más de 20 con archivo: no se descarga nada y se explica.
    comp.seleccion.set(new Map(Array.from({ length: 21 }, (_, i) => [String(i), doc(String(i))])));
    await comp.descargarSeleccion();
    expect(comp.aviso()?.texto).toBe('Como máximo 20 archivos por vez (seleccionó 21 con archivo).');
  });

  it('Lector: sin "Crear Carpeta", sin "Subir Archivo" y sin mover ni solicitar', async () => {
    await abrir('/biblioteca', 'read-only', {});
    await responder(lista(), pagina([doc('1')]));
    comp.toggleSelectAll();
    harness.detectChanges();
    const t = texto();
    expect(t).not.toContain('Crear Carpeta');
    expect(t).not.toContain('Subir Archivo');
    expect(t).not.toContain('Mover');
    expect(t).not.toContain('Solicitar movimiento');
    expect(t).toContain('Descargar archivos');
  });

  it('crear carpeta: muestra el error del servidor (duplicada) dentro del diálogo', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1')]));
    comp.abrir('crear');
    comp.nombreCarpeta.set('contratos');
    const promesa = comp.crearCarpeta();
    http.expectOne('/api/carpetas').flush({ error: 'Ya existe una carpeta con ese nombre (no se distinguen mayúsculas).' }, { status: 409, statusText: 'Conflict' });
    await promesa;
    expect(comp.dialogo()).toBe('crear');
    expect(comp.errorDialogo()).toContain('Ya existe una carpeta');
  });
});
