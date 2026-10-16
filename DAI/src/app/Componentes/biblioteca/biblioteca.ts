import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, map, of, switchMap } from 'rxjs';
import {
  ApiService, DocumentoBiblioteca, FiltrosBiblioteca, FormatoDoc, ListaCarpetas, RespuestaBiblioteca, SolicitudMovimiento, leerErrorApi,
} from '../../shared/api';
import { AuthService } from '../../shared/auth';
import { guardarComo } from '../../shared/archivo-pdf';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import {
  ETIQUETA_DIAS, ETIQUETA_FORMATO, ETIQUETA_ORDEN, FILTROS_POR_DEFECTO, filtrosDesdeUrl, paginasVisibles, queryParamsDe,
} from './biblioteca-filtros';

/** Diálogo abierto (uno a la vez). */
type Dialogo = 'crear' | 'renombrar' | 'eliminar' | 'mover' | 'solicitar' | null;
type Aviso = { tipo: 'ok' | 'error'; texto: string } | null;

export const MAX_DESCARGAS = 20;
const MAX_MOVER = 100;
const ROLES_SUBEN = ['super-admin', 'ocr-operator'];
const ESPERA_BUSQUEDA_MS = 350;
const numero = new Intl.NumberFormat('es-CO'); // 1.420 (separador de miles de Colombia)

/** Mensaje de error de la API en español (o uno genérico). */
async function mensajeDe(err: unknown, porDefecto: string): Promise<string> {
  if (err instanceof HttpErrorResponse && err.status === 0) return 'No se pudo conectar con el servidor. Inténtelo de nuevo en unos segundos.';
  return (await leerErrorApi(err)).error ?? porDefecto;
}

@Component({
  selector: 'app-biblioteca',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, Barraizq, Navbar],
  templateUrl: './biblioteca.html',
})
export class Biblioteca {
  private api = inject(ApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private auth = inject(AuthService);

  readonly etiquetaFormato = ETIQUETA_FORMATO;
  readonly etiquetaDias = ETIQUETA_DIAS;
  readonly etiquetaOrden = ETIQUETA_ORDEN;
  readonly formatos = Object.keys(ETIQUETA_FORMATO) as FormatoDoc[];
  readonly maxDescargas = MAX_DESCARGAS;

  // ------------------------------------------------------------------ filtros (la URL manda)
  private params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  filtros = computed(() => filtrosDesdeUrl(this.params()));
  /** Lo que se escribe en el buscador; se aplica (va a la URL) tras una pausa al teclear. */
  textoBusqueda = signal('');
  private esperaBusqueda: ReturnType<typeof setTimeout> | null = null;
  /** Sube en cada acción que cambia datos (mover, crear carpeta...) para volver a pedir la misma página. */
  private version = signal(0);

  // ------------------------------------------------------------------ datos
  respuesta = signal<RespuestaBiblioteca | null>(null);
  cargando = signal(true);
  errorCarga = signal('');
  documentos = computed(() => this.respuesta()?.documentos ?? []);
  total = computed(() => this.respuesta()?.total ?? 0);
  resumen = computed(() => this.respuesta()?.resumen ?? null);
  departamentos = signal<string[]>([]);
  carpetasInfo = signal<ListaCarpetas | null>(null);
  carpetas = computed(() => this.carpetasInfo()?.carpetas ?? []);
  permisos = computed(() => this.carpetasInfo()?.permisos ?? { gestionar: false, eliminar: false, solicitar: false, resolver: false });
  solicitudes = signal<SolicitudMovimiento[]>([]);
  puedeSubir = computed(() => ROLES_SUBEN.includes(this.auth.currentUser()?.rolClave ?? ''));
  /** Carpeta elegida en el filtro (para renombrarla o eliminarla). */
  carpetaFiltrada = computed(() => this.carpetas().find((c) => c.id === this.filtros().carpeta) ?? null);

  // ------------------------------------------------------------------ paginación
  totalPaginas = computed(() => Math.max(1, Math.ceil(this.total() / this.filtros().porPagina)));
  desde = computed(() => (this.total() === 0 ? 0 : (this.filtros().pagina - 1) * this.filtros().porPagina + 1));
  hasta = computed(() => Math.min(this.filtros().pagina * this.filtros().porPagina, this.total()));
  paginas = computed(() => paginasVisibles(this.filtros().pagina, this.totalPaginas()));

  /** Chips de "Filtros activos", derivados del estado REAL (cada uno se puede quitar). */
  chips = computed(() => {
    const f = this.filtros();
    const out: { clave: keyof FiltrosBiblioteca; texto: string }[] = [];
    if (f.q) out.push({ clave: 'q', texto: `Texto: "${f.q}"` });
    if (f.departamento) out.push({ clave: 'departamento', texto: `Departamento: ${f.departamento}` });
    if (f.formato) out.push({ clave: 'formato', texto: `Formato: ${ETIQUETA_FORMATO[f.formato]}` });
    if (f.dias !== 'todo') out.push({ clave: 'dias', texto: ETIQUETA_DIAS[f.dias] });
    if (f.carpeta) out.push({ clave: 'carpeta', texto: f.carpeta === 'sin' ? 'Sin carpeta' : `Carpeta: ${this.carpetaFiltrada()?.nombre ?? '…'}` });
    return out;
  });

  // ------------------------------------------------------------------ selección y acciones
  seleccion = signal<Map<string, DocumentoBiblioteca>>(new Map());
  selectedCount = computed(() => this.seleccion().size);
  allSelected = computed(() => this.documentos().length > 0 && this.documentos().every((d) => this.seleccion().has(d.id)));
  dialogo = signal<Dialogo>(null);
  nombreCarpeta = signal('');
  destino = signal(''); // '' sin elegir · 'sin' = sin carpeta · id
  motivo = signal('');
  errorDialogo = signal('');
  trabajando = signal(false);
  progreso = signal('');
  aviso = signal<Aviso>(null);
  rechazandoId = signal<string | null>(null);
  respuestaRechazo = signal('');

  constructor() {
    // El buscador refleja la URL (al llegar con ?q=..., al usar Atrás o al quitar el chip).
    effect(() => this.textoBusqueda.set(this.filtros().q));

    // Cada cambio de filtros (o de versión) pide la página al servidor; switchMap descarta respuestas viejas.
    toObservable(computed(() => ({ f: this.filtros(), v: this.version() })))
      .pipe(
        switchMap(({ f }) => {
          this.cargando.set(true);
          return this.api.biblioteca(f).pipe(
            map((r) => ({ r, err: null as unknown })),
            catchError((err: unknown) => of({ r: null, err })),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe(async ({ r, err }) => {
        this.cargando.set(false);
        if (!r) {
          this.respuesta.set(null);
          this.errorCarga.set(await mensajeDe(err, 'No se pudo cargar la biblioteca.'));
          return;
        }
        this.errorCarga.set('');
        // Página fuera de rango (por ejemplo, tras mover los últimos de la última página): se va a la última que existe.
        if (r.documentos.length === 0 && r.total > 0 && r.pagina > 1) {
          this.aplicar({ pagina: Math.ceil(r.total / r.porPagina) }, false);
          return;
        }
        this.respuesta.set(r);
        this.seleccion.set(new Map());
      });

    this.api.catalogos().subscribe({
      next: (c) => this.departamentos.set(c.departamentos.map((d) => d.nombre)),
      error: () => this.departamentos.set([]),
    });
    this.cargarCarpetas();
    inject(DestroyRef).onDestroy(() => this.esperaBusqueda && clearTimeout(this.esperaBusqueda));
  }

  // ------------------------------------------------------------------ carga
  private cargarCarpetas(): void {
    this.api.carpetas().subscribe({
      next: (c) => {
        this.carpetasInfo.set(c);
        if (c.permisos.resolver || c.permisos.solicitar) this.cargarSolicitudes();
      },
      error: () => this.carpetasInfo.set(null),
    });
  }

  cargarSolicitudes(): void {
    this.api.solicitudesMovimiento('pendiente').subscribe({
      next: (s) => this.solicitudes.set(s),
      error: () => this.solicitudes.set([]),
    });
  }

  private refrescar(): void {
    this.version.update((v) => v + 1);
    this.cargarCarpetas();
  }

  // ------------------------------------------------------------------ filtros
  /** Cambia filtros en la URL. Cualquier cambio que no sea de página vuelve a la página 1. */
  aplicar(cambios: Partial<FiltrosBiblioteca>, reiniciarPagina = true): void {
    const nuevo: FiltrosBiblioteca = { ...this.filtros(), ...cambios };
    if (reiniciarPagina) nuevo.pagina = 1;
    this.router.navigate([], { relativeTo: this.route, queryParams: queryParamsDe(nuevo) });
  }

  alEscribir(texto: string): void {
    this.textoBusqueda.set(texto);
    if (this.esperaBusqueda) clearTimeout(this.esperaBusqueda);
    this.esperaBusqueda = setTimeout(() => this.buscarAhora(), ESPERA_BUSQUEDA_MS);
  }

  buscarAhora(): void {
    if (this.esperaBusqueda) clearTimeout(this.esperaBusqueda);
    this.esperaBusqueda = null;
    const q = this.textoBusqueda().trim();
    if (q !== this.filtros().q) this.aplicar({ q });
  }

  quitarFiltro(clave: keyof FiltrosBiblioteca): void {
    this.aplicar({ [clave]: FILTROS_POR_DEFECTO[clave] });
  }

  limpiarFiltros(): void {
    const { q, departamento, formato, dias, carpeta } = FILTROS_POR_DEFECTO;
    this.aplicar({ q, departamento, formato, dias, carpeta });
  }

  cambiarPorPagina(valor: number | string): void {
    const n = Number(valor);
    if (n === 25 || n === 50 || n === 100) this.aplicar({ porPagina: n });
  }

  irAPagina(n: number | '…'): void {
    if (n === '…' || n < 1 || n > this.totalPaginas() || n === this.filtros().pagina) return;
    this.aplicar({ pagina: n }, false);
  }

  // ------------------------------------------------------------------ selección
  estaSeleccionado(doc: DocumentoBiblioteca): boolean {
    return this.seleccion().has(doc.id);
  }

  toggleSelectDoc(doc: DocumentoBiblioteca): void {
    this.seleccion.update((m) => {
      const n = new Map(m);
      n.has(doc.id) ? n.delete(doc.id) : n.set(doc.id, doc);
      return n;
    });
  }

  toggleSelectAll(): void {
    const marcar = !this.allSelected();
    this.seleccion.update((m) => {
      const n = new Map(m);
      for (const d of this.documentos()) marcar ? n.set(d.id, d) : n.delete(d.id);
      return n;
    });
  }

  clearSelection(): void {
    this.seleccion.set(new Map());
  }

  openDocument(doc: DocumentoBiblioteca): void {
    this.router.navigate(['/documento', doc.id]);
  }

  // ------------------------------------------------------------------ descarga múltiple
  /**
   * Descarga los seleccionados UNO A UNO con la misma petición auditada que "Descargar Original" (cada descarga
   * queda en la auditoría). Secuencial a propósito: no satura el servidor gratuito ni el navegador.
   */
  async descargarSeleccion(): Promise<void> {
    const docs = [...this.seleccion().values()];
    const conArchivo = docs.filter((d) => d.tieneArchivo);
    const sinArchivo = docs.length - conArchivo.length;
    this.aviso.set(null);
    if (conArchivo.length === 0)
      return this.aviso.set({ tipo: 'error', texto: 'Ninguno de los documentos seleccionados tiene archivo original para descargar.' });
    if (conArchivo.length > MAX_DESCARGAS)
      return this.aviso.set({ tipo: 'error', texto: `Como máximo ${MAX_DESCARGAS} archivos por vez (seleccionó ${conArchivo.length} con archivo).` });

    this.trabajando.set(true);
    let ok = 0;
    const fallidos: string[] = [];
    for (const [i, d] of conArchivo.entries()) {
      this.progreso.set(`Descargando ${i + 1} de ${conArchivo.length}…`);
      try {
        const blob = await firstValueFrom(this.api.descargarDocumento(d.id));
        guardarComo(blob, d.nombreOriginal ?? `${d.folio}.pdf`);
        ok++;
      } catch {
        fallidos.push(d.name);
      }
    }
    this.trabajando.set(false);
    this.progreso.set('');
    const partes = [`Se ${ok === 1 ? 'descargó 1 archivo' : `descargaron ${ok} archivos`}.`];
    if (sinArchivo) partes.push(`${sinArchivo} ${sinArchivo === 1 ? 'documento no tiene' : 'documentos no tienen'} archivo original y se omitieron.`);
    if (fallidos.length) partes.push(`No se pudieron descargar: ${fallidos.join(', ')}.`);
    this.aviso.set({ tipo: fallidos.length ? 'error' : 'ok', texto: partes.join(' ') });
  }

  // ------------------------------------------------------------------ diálogos
  abrir(d: Exclude<Dialogo, null>): void {
    this.errorDialogo.set('');
    this.aviso.set(null);
    this.nombreCarpeta.set(d === 'renombrar' ? this.carpetaFiltrada()?.nombre ?? '' : '');
    this.destino.set('');
    this.motivo.set('');
    this.dialogo.set(d);
  }

  cerrarDialogo(): void {
    if (!this.trabajando()) this.dialogo.set(null);
  }

  /** Ejecuta una acción del diálogo: bloquea el botón, muestra el error del servidor o cierra con un aviso. */
  private async ejecutar(accion: () => Promise<string>, porDefecto: string): Promise<void> {
    this.trabajando.set(true);
    this.errorDialogo.set('');
    try {
      const texto = await accion();
      this.trabajando.set(false);
      this.dialogo.set(null);
      this.aviso.set({ tipo: 'ok', texto });
      this.refrescar();
    } catch (err) {
      this.trabajando.set(false);
      this.errorDialogo.set(await mensajeDe(err, porDefecto));
    }
  }

  crearCarpeta(): Promise<void> {
    const nombre = this.nombreCarpeta().trim();
    if (nombre.length < 2) return Promise.resolve(this.errorDialogo.set('El nombre debe tener al menos 2 caracteres.'));
    return this.ejecutar(async () => {
      const c = await firstValueFrom(this.api.crearCarpeta(nombre));
      return `Carpeta «${c.nombre}» creada.`;
    }, 'No se pudo crear la carpeta.');
  }

  renombrarCarpeta(): Promise<void> {
    const c = this.carpetaFiltrada();
    const nombre = this.nombreCarpeta().trim();
    if (!c) return Promise.resolve();
    if (nombre.length < 2) return Promise.resolve(this.errorDialogo.set('El nombre debe tener al menos 2 caracteres.'));
    return this.ejecutar(async () => {
      const r = await firstValueFrom(this.api.renombrarCarpeta(c.id, nombre));
      return `Carpeta renombrada a «${r.nombre}».`;
    }, 'No se pudo renombrar la carpeta.');
  }

  eliminarCarpeta(): Promise<void> {
    const c = this.carpetaFiltrada();
    if (!c) return Promise.resolve();
    return this.ejecutar(async () => {
      await firstValueFrom(this.api.eliminarCarpeta(c.id));
      this.aplicar({ carpeta: '' });
      return `Carpeta «${c.nombre}» eliminada.`;
    }, 'No se pudo eliminar la carpeta.');
  }

  private destinoId(): string | null {
    return this.destino() === 'sin' ? null : this.destino();
  }

  private nombreDestino(): string {
    return this.destino() === 'sin' ? '«Sin carpeta»' : `«${this.carpetas().find((c) => c.id === this.destino())?.nombre ?? ''}»`;
  }

  moverSeleccion(): Promise<void> {
    const ids = [...this.seleccion().keys()];
    if (!this.destino()) return Promise.resolve(this.errorDialogo.set('Elija la carpeta de destino.'));
    if (ids.length > MAX_MOVER) return Promise.resolve(this.errorDialogo.set(`Como máximo ${MAX_MOVER} documentos por operación.`));
    return this.ejecutar(async () => {
      const r = await firstValueFrom(this.api.moverDocumentos(ids, this.destinoId()));
      const partes = [`${r.movidos === 1 ? 'Se movió 1 documento' : `Se movieron ${r.movidos} documentos`} a ${this.nombreDestino()}.`];
      if (r.sinCambios) partes.push(`${r.sinCambios} ya ${r.sinCambios === 1 ? 'estaba' : 'estaban'} ahí.`);
      if (r.omitidos.length) partes.push(`${r.omitidos.length} se omitieron (sin acceso o ya no están activos).`);
      return partes.join(' ');
    }, 'No se pudieron mover los documentos.');
  }

  /** Cumplimiento: una solicitud por documento (el servidor rechaza duplicadas o sin cambios y se informa). */
  solicitarSeleccion(): Promise<void> {
    const docs = [...this.seleccion().values()];
    const motivo = this.motivo().trim();
    if (!this.destino()) return Promise.resolve(this.errorDialogo.set('Elija la carpeta de destino.'));
    if (motivo.length < 10) return Promise.resolve(this.errorDialogo.set('Explique el motivo (mínimo 10 caracteres).'));
    if (docs.length > MAX_MOVER) return Promise.resolve(this.errorDialogo.set(`Como máximo ${MAX_MOVER} documentos por operación.`));
    return this.ejecutar(async () => {
      let ok = 0;
      const problemas: string[] = [];
      for (const d of docs) {
        try {
          await firstValueFrom(this.api.solicitarMovimiento(d.id, this.destinoId(), motivo));
          ok++;
        } catch (err) {
          problemas.push(`${d.name}: ${await mensajeDe(err, 'no se pudo enviar')}`);
        }
      }
      if (ok === 0) throw new Error(problemas.join(' · '));
      const texto = `${ok === 1 ? 'Se envió 1 solicitud' : `Se enviaron ${ok} solicitudes`} de movimiento a ${this.nombreDestino()}. Las resolverá un administrador u operador.`;
      return problemas.length ? `${texto} No enviadas: ${problemas.join(' · ')}` : texto;
    }, 'No se pudieron enviar las solicitudes.');
  }

  // ------------------------------------------------------------------ resolver solicitudes
  async aprobar(s: SolicitudMovimiento): Promise<void> {
    this.aviso.set(null);
    try {
      await firstValueFrom(this.api.aprobarSolicitud(s.id));
      this.aviso.set({ tipo: 'ok', texto: `Solicitud aprobada: «${s.documento.nombre}» se movió a ${s.carpetaDestino ? `«${s.carpetaDestino.nombre}»` : '«Sin carpeta»'}.` });
      this.refrescar();
    } catch (err) {
      this.aviso.set({ tipo: 'error', texto: await mensajeDe(err, 'No se pudo aprobar la solicitud.') });
      this.cargarSolicitudes();
    }
  }

  empezarRechazo(s: SolicitudMovimiento): void {
    this.rechazandoId.set(s.id);
    this.respuestaRechazo.set('');
  }

  async rechazar(s: SolicitudMovimiento): Promise<void> {
    const respuesta = this.respuestaRechazo().trim();
    if (respuesta.length < 3) return this.aviso.set({ tipo: 'error', texto: 'Indique el motivo del rechazo (mínimo 3 caracteres).' });
    this.aviso.set(null);
    try {
      await firstValueFrom(this.api.rechazarSolicitud(s.id, respuesta));
      this.rechazandoId.set(null);
      this.aviso.set({ tipo: 'ok', texto: `Solicitud rechazada: «${s.documento.nombre}» no se movió.` });
      this.cargarSolicitudes();
    } catch (err) {
      this.aviso.set({ tipo: 'error', texto: await mensajeDe(err, 'No se pudo rechazar la solicitud.') });
      this.cargarSolicitudes();
    }
  }

  n(x: number): string {
    return numero.format(x);
  }

  formatIconClass(format: FormatoDoc): string {
    switch (format) {
      case 'pdf':
        return 'bg-red-50 text-red-600';
      case 'xlsx':
        return 'bg-emerald-50 text-emerald-600';
      case 'docx':
        return 'bg-blue-50 text-blue-600';
      case 'tiff':
        return 'bg-amber-50 text-amber-600';
    }
  }
}
