import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { Biblioteca } from './biblioteca';
import type {
  ArbolCarpetas, Carpeta, ContenidoCarpeta, DocumentoBiblioteca, PermisosCarpetas, RespuestaBiblioteca, SolicitudMovimiento,
} from '../../shared/api';

const doc = (id: string, extra: Partial<DocumentoBiblioteca> = {}): DocumentoBiblioteca => ({
  id, name: `Doc ${id}.pdf`, version: 'v1.0', format: 'pdf', hashLabel: 'SHA-256: abcd...ef01', folio: `EXP-${id}`,
  departamento: 'Legal', departamentoColor: '', autor: 'Ana', autorEmail: '', tamano: '1 MB', carpeta: null,
  tieneArchivo: true, nombreOriginal: `original-${id}.pdf`, actualizado: '16 Oct 2026, 9:00 a. m.', ...extra,
});
const pagina = (docs: DocumentoBiblioteca[], extra: Partial<RespuestaBiblioteca> = {}): RespuestaBiblioteca => ({
  documentos: docs, total: docs.length, pagina: 1, porPagina: 25, resumen: { total: 1420, actualizados30: 892 }, ...extra,
});
const LEGAL = { id: '3', nombre: 'Legal' };
const L2024 = { id: '7', nombre: '2024' };
/** Árbol de prueba: Legal › 2024 › Contratos; Finanzas en la raíz. */
const ARBOL: ArbolCarpetas = {
  maxNivel: 5,
  carpetas: [
    { id: '8', nombre: 'Finanzas', padreId: null },
    { id: '3', nombre: 'Legal', padreId: null },
    { id: '7', nombre: '2024', padreId: '3' },
    { id: '9', nombre: 'Contratos', padreId: '7' },
  ],
};
/** Contenido de una carpeta (ruta [] = la raíz). */
const contenido = (ruta: { id: string; nombre: string }[], carpetas: Carpeta[], permisos: Partial<PermisosCarpetas> = {}): ContenidoCarpeta => ({
  carpeta: ruta.length ? { ...ruta[ruta.length - 1], nivel: ruta.length, ruta } : null,
  carpetas, documentosAqui: 0, maxNivel: 5,
  permisos: { gestionar: false, eliminar: false, solicitar: false, resolver: false, ...permisos },
});
const raiz = (permisos: Partial<PermisosCarpetas> = {}) => contenido([], [
  { id: '8', nombre: 'Finanzas', documentos: 0, subcarpetas: 0 }, { id: '3', nombre: 'Legal', documentos: 2, subcarpetas: 1 },
], permisos);
const solicitud = (id: string, extra: Partial<SolicitudMovimiento> = {}): SolicitudMovimiento => ({
  id, documento: { id: '9', nombre: 'Dictamen.docx', folio: 'EXP-9' }, carpetaActual: null,
  carpetaDestino: { ...L2024, ruta: [LEGAL, L2024] },
  solicitante: 'Mateo', motivo: 'Es del cierre de auditoría', estado: 'pendiente', fecha: '16 Oct 2026, 8:00 a. m.',
  resueltoPor: null, resueltoEn: null, respuesta: null, puedeResolver: true, ...extra,
});
const GESTOR: Partial<PermisosCarpetas> = { gestionar: true, eliminar: true, resolver: true };

describe('Biblioteca (explorador de carpetas)', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let comp: Biblioteca;
  const el = () => harness.routeNativeElement as HTMLElement;
  const texto = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const esDocumentos = (r: { url: string }) => r.url === '/api/documentos';
  const url = () => TestBed.inject(Router).url;

  /** Monta la biblioteca y responde catálogos y el contenido de la carpeta de la URL. */
  async function abrir(ruta = '/biblioteca', rolClave = 'super-admin', c: ContenidoCarpeta = raiz(GESTOR)) {
    sessionStorage.setItem('dai_token', 'token-de-prueba');
    sessionStorage.setItem('dai_user', JSON.stringify({ name: 'Ana', role: 'x', email: 'a@b.c', rolClave, nivel: 'Nivel 5 Secreto' }));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: 'biblioteca', component: Biblioteca }])],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    comp = await harness.navigateByUrl(ruta, Biblioteca);
    await harness.fixture.whenStable();
    http.expectOne('/api/catalogos').flush({ departamentos: [{ id: 1, nombre: 'Legal' }, { id: 2, nombre: 'Finanzas' }] });
    await responderCarpeta(c);
  }

  /** Responde la petición en curso del contenido de una carpeta (?padre=raiz o ?padre=<id>). */
  async function responderCarpeta(c: ContenidoCarpeta) {
    http.expectOne(`/api/carpetas?padre=${c.carpeta?.id ?? 'raiz'}`).flush(c);
    await harness.fixture.whenStable();
  }

  /** La petición de la lista que está en curso. */
  const lista = () => http.expectOne(esDocumentos);
  const responder = async (req: TestRequest, r: RespuestaBiblioteca) => {
    req.flush(r);
    await harness.fixture.whenStable();
    harness.detectChanges();
  };

  afterEach(() => {
    http.match('/api/notificaciones/resumen'); // la barra lateral: no interesa aquí
    http.verify();
    sessionStorage.clear(); // se comparte entre archivos de specs
  });

  it('filtros desde la URL → petición al servidor, chips reales y tarjetas con el resumen', async () => {
    await abrir('/biblioteca?formato=pdf&departamento=Legal&carpeta=7&subcarpetas=1&orden=nombre&pagina=2&porPagina=50&dias=90', 'super-admin',
      contenido([LEGAL, L2024], [], GESTOR));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    const req = lista();
    const p = req.request.params;
    expect([p.get('formato'), p.get('departamento'), p.get('carpeta'), p.get('subcarpetas'), p.get('orden'), p.get('pagina'), p.get('porPagina'), p.get('dias')])
      .toEqual(['pdf', 'Legal', '7', '1', 'nombre', '2', '50', '90']);
    expect(p.has('q')).toBe(false); // vacío: no se envía
    await responder(req, pagina([doc('1')], { total: 60, pagina: 2, porPagina: 50 }));
    expect(comp.chips().map((c) => c.texto)).toEqual(['Departamento: Legal', 'Formato: PDF', 'Últimos 3 meses', 'Incluye subcarpetas']);
    expect(texto()).toContain('1.420'); // resumen real, con separador de miles de Colombia
    expect(texto()).toContain('892');
    expect(texto()).toContain('Mostrando 51–60 de 60 documentos');
  });

  it('en la raíz pide los documentos sin carpeta ("sin") y la casilla "Incluir subcarpetas" va a la URL', async () => {
    await abrir('/biblioteca', 'read-only', raiz());
    const r1 = lista();
    expect([r1.request.params.get('carpeta'), r1.request.params.has('subcarpetas')]).toEqual(['sin', false]);
    await responder(r1, pagina([doc('1')]));
    (el().querySelector('input[type=checkbox][class="rounded"]:not([aria-label])') as HTMLInputElement).click();
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?subcarpetas=1');
    const r2 = lista();
    expect([r2.request.params.get('carpeta'), r2.request.params.get('subcarpetas')]).toEqual(['sin', '1']);
    await responder(r2, pagina([doc('1'), doc('2')]));
    // Cambiar un filtro no vuelve a pedir el contenido de la carpeta (sigue en Inicio).
    http.expectNone('/api/carpetas?padre=raiz');
  });

  it('migas de pan ⇄ URL: muestra Inicio › Legal › 2024; volver a una miga cambia ?carpeta y recarga', async () => {
    await abrir('/biblioteca?carpeta=7&formato=pdf', 'read-only', contenido([LEGAL, L2024], []));
    expect(lista().request.params.get('carpeta')).toBe('7');
    harness.detectChanges();
    const nav = el().querySelector('nav[aria-label="Ubicación"]') as HTMLElement;
    expect(nav.textContent?.replace(/\s+/g, '')).toBe('Inicio›Legal›2024');
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toContain('2024');

    // Clic en "Legal": va a ?carpeta=3 conservando el filtro y vuelve a la página 1.
    [...nav.querySelectorAll('button')].find((b) => b.textContent?.includes('Legal'))!.click();
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?formato=pdf&carpeta=3');
    await responderCarpeta(contenido([LEGAL], [{ id: '7', nombre: '2024', documentos: 1, subcarpetas: 0 }]));
    http.match(esDocumentos).forEach((r) => r.flush(pagina([])));
    harness.detectChanges();

    // Y "Inicio": sin ?carpeta (la raíz).
    comp.irACarpeta(null);
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?formato=pdf');
    await responderCarpeta(raiz());
    const r = lista();
    expect(r.request.params.get('carpeta')).toBe('sin');
    await responder(r, pagina([]));
    expect(comp.migas().map((m) => m.nombre)).toEqual(['Inicio']);
  });

  it('tarjetas de subcarpetas: nombre, documentos visibles y subcarpetas; entrar en una cambia la URL', async () => {
    await abrir('/biblioteca', 'read-only', raiz());
    await responder(lista(), pagina([]));
    const tarjetas = [...el().querySelectorAll('section[aria-label="Carpetas"] li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(tarjetas).toEqual(['Finanzas 0 documentos · 0 subcarpetas', 'Legal 2 documentos · 1 subcarpeta']);
    expect(el().querySelector('[aria-label="Acciones de la carpeta Legal"]')).toBeNull(); // el lector no gestiona
    (el().querySelector('[aria-label="Abrir la carpeta Legal"]') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?carpeta=3');
    await responderCarpeta(contenido([LEGAL], []));
    await responder(lista(), pagina([doc('5', { carpeta: { ...LEGAL, ruta: [LEGAL] } })]));
    expect(texto()).toContain('Inicio › Legal');
  });

  it('carpeta inexistente (404): avisa y ofrece volver a Inicio', async () => {
    await abrir('/biblioteca', 'read-only', raiz());
    await responder(lista(), pagina([]));
    comp.irACarpeta('999');
    await harness.fixture.whenStable();
    http.expectOne('/api/carpetas?padre=999').flush({ error: 'Carpeta no encontrada.' }, { status: 404, statusText: 'Not Found' });
    await responder(lista(), pagina([]));
    expect(texto()).toContain('Esta carpeta no existe');
    [...el().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Ir a Inicio')!.click();
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca');
    await responderCarpeta(raiz());
    await responder(lista(), pagina([]));
  });

  it('crear carpeta DENTRO de la actual; en el nivel 5 el botón queda deshabilitado', async () => {
    await abrir('/biblioteca?carpeta=7', 'ocr-operator', contenido([LEGAL, L2024], [], { gestionar: true, resolver: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([]));
    comp.abrir('crear');
    harness.detectChanges();
    expect(texto()).toContain('Nueva carpeta en «Legal › 2024»');
    comp.nombreCarpeta.set('Contratos');
    const promesa = comp.crearCarpeta();
    const req = http.expectOne('/api/carpetas');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ nombre: 'Contratos', padreId: '7' });
    req.flush({ id: '9', nombre: 'Contratos', padreId: '7', documentos: 0, subcarpetas: 0 });
    await promesa;
    expect(comp.aviso()?.texto).toBe('Carpeta «Contratos» creada en «Legal › 2024».');
    await harness.fixture.whenStable();
    await responderCarpeta(contenido([LEGAL, L2024], [{ id: '9', nombre: 'Contratos', documentos: 0, subcarpetas: 0 }], { gestionar: true, resolver: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([]));
    expect(comp.subcarpetas().map((c) => c.nombre)).toEqual(['Contratos']);

    // Nivel 5: no admite subcarpetas.
    const cinco = ['1', '2', '3', '4', '5'].map((id) => ({ id, nombre: `N${id}` }));
    comp.irACarpeta('5');
    await harness.fixture.whenStable();
    await responderCarpeta(contenido(cinco, [], { gestionar: true, resolver: true }));
    await responder(lista(), pagina([]));
    const boton = [...el().querySelectorAll('button')].find((b) => b.textContent?.includes('Nueva carpeta')) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(boton.title).toContain('nivel 5');
  });

  it('teclado: el diálogo recibe el foco al abrirse, Esc lo cierra y devuelve el foco; Esc también cierra el menú', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([]));
    const boton = [...el().querySelectorAll('button')].find((b) => b.textContent?.includes('Nueva carpeta')) as HTMLButtonElement;
    boton.focus();
    boton.click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(document.activeElement).toBe(el().querySelector('[role="dialog"] input[type="text"]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    harness.detectChanges();
    expect(comp.dialogo()).toBeNull();
    expect(document.activeElement).toBe(boton);

    (el().querySelector('[aria-label="Acciones de la carpeta Legal"]') as HTMLButtonElement).click();
    harness.detectChanges();
    expect(el().querySelector('[role="menu"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    harness.detectChanges();
    expect(el().querySelector('[role="menu"]')).toBeNull();
  });

  it('crear carpeta: muestra el error del servidor (duplicada) dentro del diálogo', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1')]));
    comp.abrir('crear');
    comp.nombreCarpeta.set('legal');
    const promesa = comp.crearCarpeta();
    http.expectOne('/api/carpetas').flush({ error: 'Ya existe una carpeta con ese nombre en esa ubicación (no se distinguen mayúsculas).' }, { status: 409, statusText: 'Conflict' });
    await promesa;
    expect(comp.dialogo()).toBe('crear');
    expect(comp.errorDialogo()).toContain('Ya existe una carpeta');
  });

  it('menú de la carpeta: mover con el árbol, que deshabilita la carpeta movida y sus descendientes', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([]));
    (el().querySelector('[aria-label="Acciones de la carpeta Legal"]') as HTMLButtonElement).click();
    harness.detectChanges();
    const menu = el().querySelector('[role="menu"]') as HTMLElement;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim())).toEqual(['Renombrar', 'Mover a…', 'Eliminar']);
    ([...menu.querySelectorAll('button')].find((b) => b.textContent?.includes('Mover')) as HTMLButtonElement).click();
    harness.detectChanges();
    http.expectOne('/api/carpetas/arbol').flush(ARBOL);
    await harness.fixture.whenStable();
    harness.detectChanges();

    const opciones = [...el().querySelectorAll('[role="radiogroup"] label')].map((l) => ({
      texto: l.textContent?.replace(/\s+/g, ''), deshabilitada: (l.querySelector('input') as HTMLInputElement).disabled,
    }));
    expect(opciones).toEqual([
      { texto: 'Inicio(ubicaciónactual)', deshabilitada: false },
      { texto: 'Finanzas', deshabilitada: false },
      { texto: 'Legal—eslacarpetaquemueve', deshabilitada: true },
      { texto: '2024—estádentrodelacarpetaquemueve', deshabilitada: true },
      { texto: 'Contratos—estádentrodelacarpetaquemueve', deshabilitada: true },
    ]);
    // Elegir su ubicación actual no es un movimiento.
    (el().querySelectorAll('[role="radiogroup"] input')[0] as HTMLInputElement).click();
    await comp.moverCarpeta();
    expect(comp.errorDialogo()).toContain('ya está ahí');

    (el().querySelectorAll('[role="radiogroup"] input')[1] as HTMLInputElement).click();
    expect(comp.destino()).toBe('8');
    const promesa = comp.moverCarpeta();
    const req = http.expectOne('/api/carpetas/3');
    expect([req.request.method, req.request.body]).toEqual(['PATCH', { padreId: '8' }]);
    req.flush({ id: '3', nombre: 'Legal', padreId: '8' });
    await promesa;
    expect(comp.aviso()?.texto).toBe('Carpeta «Legal» movida a «Finanzas» con sus subcarpetas y documentos.');
    await harness.fixture.whenStable();
    await responderCarpeta(contenido([], [{ id: '8', nombre: 'Finanzas', documentos: 0, subcarpetas: 1 }], GESTOR));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([]));
  });

  it('eliminar carpeta con subcarpetas: el 409 del servidor se muestra en el diálogo', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([]));
    comp.accionCarpeta(comp.subcarpetas()[1], 'eliminar');
    const promesa = comp.eliminarCarpeta();
    http.expectOne('/api/carpetas/3').flush({ error: 'La carpeta no está vacía: tiene 1 subcarpeta. Muévalas o elimínelas antes.', codigo: 'subcarpetas' },
      { status: 409, statusText: 'Conflict' });
    await promesa;
    expect(comp.dialogo()).toBe('eliminar');
    expect(comp.errorDialogo()).toContain('tiene 1 subcarpeta');
  });

  it('cambiar un filtro lo escribe en la URL, vuelve a la página 1 y quitar el chip lo borra', async () => {
    await abrir('/biblioteca?pagina=3', 'read-only', raiz());
    await responder(lista(), pagina([doc('1')], { total: 80, pagina: 3 }));
    comp.aplicar({ formato: 'xlsx' });
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?formato=xlsx'); // pagina=1 es el valor por defecto: no aparece
    const req = lista();
    expect([req.request.params.get('formato'), req.request.params.get('pagina')]).toEqual(['xlsx', '1']);
    await responder(req, pagina([doc('2', { format: 'xlsx' })]));
    comp.quitarFiltro('formato');
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca');
    await responder(lista(), pagina([doc('1')]));
  });

  it('limpiar filtros no saca de la carpeta actual', async () => {
    await abrir('/biblioteca?carpeta=3&q=acta&subcarpetas=1', 'read-only', contenido([LEGAL], []));
    await responder(lista(), pagina([]));
    comp.limpiarFiltros();
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?carpeta=3');
    await responder(lista(), pagina([]));
  });

  it('paginación real: siguiente página por la URL y, si la página quedó vacía, salta a la última', async () => {
    await abrir('/biblioteca', 'read-only', raiz());
    await responder(lista(), pagina(Array.from({ length: 25 }, (_, i) => doc(String(i + 1))), { total: 30 }));
    expect([comp.desde(), comp.hasta(), comp.totalPaginas()]).toEqual([1, 25, 2]);
    comp.irAPagina(2);
    await harness.fixture.whenStable();
    expect(url()).toBe('/biblioteca?pagina=2');
    // Entre tanto alguien movió documentos: la página 2 ya no tiene nada y el total bajó a 20.
    await responder(lista(), pagina([], { total: 20, pagina: 2 }));
    expect(url()).toBe('/biblioteca');
    await responder(lista(), pagina(Array.from({ length: 20 }, (_, i) => doc(String(i + 1))), { total: 20 }));
    expect([comp.desde(), comp.hasta(), comp.totalPaginas()]).toEqual([1, 20, 1]);
  });

  it('mover documentos (Admin/Operador) con el árbol: envía ids y carpeta, informa con la ruta y recarga', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1'), doc('2')]));
    comp.toggleSelectAll();
    comp.abrir('mover');
    http.expectOne('/api/carpetas/arbol').flush(ARBOL);
    harness.detectChanges();
    // Al mover documentos ninguna carpeta se deshabilita; los dos están en Inicio.
    expect([...el().querySelectorAll('[role="radiogroup"] input')].some((i) => (i as HTMLInputElement).disabled)).toBe(false);
    expect(el().querySelector('[role="radiogroup"] label')?.textContent?.replace(/\s+/g, '')).toBe('Inicio(ubicaciónactual)');
    await comp.moverSeleccion();
    expect(comp.errorDialogo()).toContain('Elija la carpeta');
    comp.destino.set('7');
    const promesa = comp.moverSeleccion();
    const req = http.expectOne('/api/carpetas/mover');
    expect(req.request.body).toEqual({ ids: ['1', '2'], carpetaId: '7' });
    req.flush({ movidos: 1, sinCambios: 0, omitidos: ['2'] });
    await promesa;
    expect(comp.dialogo()).toBeNull();
    expect(comp.aviso()?.texto).toBe('Se movió 1 documento a «Legal › 2024». 1 se omitieron (sin acceso o ya no están activos).');
    await harness.fixture.whenStable();
    await responderCarpeta(raiz(GESTOR));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('2')]));
    expect(comp.selectedCount()).toBe(0);
  });

  it('Cumplimiento no mueve: solicita con motivo (una por documento) y ve "Solicitar movimiento"', async () => {
    await abrir('/biblioteca', 'compliance', raiz({ solicitar: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([solicitud('5', { puedeResolver: false })]);
    await responder(lista(), pagina([doc('1'), doc('2')]));
    comp.toggleSelectAll();
    harness.detectChanges();
    expect(texto()).toContain('Solicitar movimiento');
    expect(texto()).not.toContain('↔ Mover');
    expect(texto()).toContain('Mis solicitudes de movimiento pendientes');
    expect(texto()).toContain('De «Inicio» a «Legal › 2024»');
    expect(texto()).not.toContain('Aprobar y mover');
    expect(texto()).not.toContain('Nueva carpeta');

    comp.abrir('solicitar');
    http.expectOne('/api/carpetas/arbol').flush(ARBOL);
    comp.destino.set(null); // Inicio
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
    expect(comp.aviso()?.texto).toContain('Se envió 1 solicitud de movimiento a «Inicio»');
    expect(comp.aviso()?.texto).toContain('Doc 2.pdf: Ya hay una solicitud de movimiento pendiente');
    await harness.fixture.whenStable();
    await responderCarpeta(raiz({ solicitar: true }));
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([]);
    await responder(lista(), pagina([doc('1'), doc('2')]));
  });

  it('aprobar y rechazar solicitudes (el rechazo exige motivo)', async () => {
    await abrir();
    http.expectOne('/api/carpetas/solicitudes?estado=pendiente').flush([solicitud('5'), solicitud('6')]);
    await responder(lista(), pagina([doc('1')]));
    expect(texto()).toContain('Solicitudes de movimiento por resolver');

    const aprobar = comp.aprobar(comp.solicitudes()[0]);
    http.expectOne('/api/carpetas/solicitudes/5/aprobar').flush({ ok: true, estado: 'aprobada' });
    await aprobar;
    expect(comp.aviso()?.texto).toBe('Solicitud aprobada: «Dictamen.docx» se movió a «Legal › 2024».');
    await harness.fixture.whenStable();
    await responderCarpeta(raiz(GESTOR));
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
    await abrir('/biblioteca', 'read-only', raiz());
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

  it('Lector: sin "Nueva carpeta", sin "Subir Archivo", sin menú de carpetas y sin mover ni solicitar', async () => {
    await abrir('/biblioteca', 'read-only', raiz());
    await responder(lista(), pagina([doc('1')]));
    comp.toggleSelectAll();
    harness.detectChanges();
    const t = texto();
    expect(t).not.toContain('Nueva carpeta');
    expect(t).not.toContain('Subir Archivo');
    expect(t).not.toContain('Mover');
    expect(t).not.toContain('Solicitar movimiento');
    expect(el().querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(t).toContain('Descargar archivos');
  });
});
