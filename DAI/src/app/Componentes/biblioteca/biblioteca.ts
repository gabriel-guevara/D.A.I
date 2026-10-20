import { Component, DestroyRef, HostListener, Injector, afterNextRender, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, map, of, switchMap } from 'rxjs';
import {
  ApiService, ArbolCarpetas, Carpeta, ContenidoCarpeta, DocumentoBiblioteca, FiltrosBiblioteca, FormatoDoc,
  PermisosCarpetas, RespuestaBiblioteca, SolicitudMovimiento, leerErrorApi,
} from '../../shared/api';
import { AuthService } from '../../shared/auth';
import { guardarComo } from '../../shared/archivo-pdf';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ArbolDestino } from './arbol-destino';
import { rutaEnArbol, textoCarpeta, textoRuta, ubicacion } from './arbol-carpetas';
import {
  ETIQUETA_DIAS, ETIQUETA_FORMATO, ETIQUETA_ORDEN, FILTROS_POR_DEFECTO, filtrosDesdeUrl, paginasVisibles, queryParamsDe,
} from './biblioteca-filtros';

/** Diálogo abierto (uno a la vez). renombrar, eliminar y moverCarpeta actúan sobre carpetaObjetivo. */
type Dialogo = 'crear' | 'renombrar' | 'eliminar' | 'moverCarpeta' | 'mover' | 'solicitar' | null;
type Aviso = { tipo: 'ok' | 'error'; texto: string } | null;

export const MAX_DESCARGAS = 20;
const MAX_MOVER = 100;
const ROLES_SUBEN = ['super-admin', 'ocr-operator'];
const ESPERA_BUSQUEDA_MS = 350;
const numero = new Intl.NumberFormat('es-CO'); // 1.420 (separador de miles de Colombia)
const SIN_PERMISOS: PermisosCarpetas = { gestionar: false, eliminar: false, solicitar: false, resolver: false };

/** Mensaje de error de la API en español (o uno genérico). */
async function mensajeDe(err: unknown, porDefecto: string): Promise<string> {
  if (err instanceof HttpErrorResponse && err.status === 0) return 'No se pudo conectar con el servidor. Inténtelo de nuevo en unos segundos.';
  return (await leerErrorApi(err)).error ?? porDefecto;
}

@Component({
  selector: 'app-biblioteca',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, Barraizq, Navbar, ArbolDestino],
  templateUrl: './biblioteca.html',
})
export class Biblioteca {
  private api = inject(ApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private auth = inject(AuthService);
  private injector = inject(Injector);
  /** Elemento que tenía el foco al abrir un diálogo: lo recupera al cerrarlo (teclado y lectores de pantalla). */
  private focoPrevio: HTMLElement | null = null;

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
  solicitudes = signal<SolicitudMovimiento[]>([]);
  puedeSubir = computed(() => ROLES_SUBEN.includes(this.auth.currentUser()?.rolClave ?? ''));

  // ------------------------------------------------------------------ explorador de carpetas (Fase 6)
  /** Carpeta que se explora (la URL manda): '' = la raíz (Inicio). */
  carpetaId = computed(() => this.filtros().carpeta);
  contenido = signal<ContenidoCarpeta | null>(null);
  errorCarpeta = signal('');
  /** Subcarpetas de la carpeta actual (las tarjetas de arriba de la tabla). */
  subcarpetas = computed(() => this.contenido()?.carpetas ?? []);
  permisos = computed(() => this.contenido()?.permisos ?? SIN_PERMISOS);
  maxNivel = computed(() => this.contenido()?.maxNivel ?? 5);
  /** Migas de pan: Inicio › Legal › 2024 (id null = Inicio). La última es la carpeta actual. */
  migas = computed<{ id: string | null; nombre: string }[]>(() => [
    { id: null, nombre: 'Inicio' }, ...(this.contenido()?.carpeta?.ruta ?? []),
  ]);
  nivelActual = computed(() => this.contenido()?.carpeta?.nivel ?? 0);
  /** Dentro del último nivel ya no se pueden crear subcarpetas. */
  puedeCrearAqui = computed(() => this.permisos().gestionar && this.nivelActual() < this.maxNivel());
  /** Menú "⋯" abierto (id de la carpeta) y carpeta sobre la que actúan renombrar, mover y eliminar. */
  menuAbierto = signal<string | null>(null);
  carpetaObjetivo = signal<Carpeta | null>(null);
  /** Árbol completo para los diálogos de mover (se pide al abrirlos: así está al día). */
  arbol = signal<ArbolCarpetas | null>(null);
  readonly textoCarpeta = textoCarpeta;
  readonly ubicacion = ubicacion;

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
    if (f.subcarpetas) out.push({ clave: 'subcarpetas', texto: 'Incluye subcarpetas' });
    return out;
  });

  // ------------------------------------------------------------------ selección y acciones
  seleccion = signal<Map<string, DocumentoBiblioteca>>(new Map());
  selectedCount = computed(() => this.seleccion().size);
  allSelected = computed(() => this.documentos().length > 0 && this.documentos().every((d) => this.seleccion().has(d.id)));
  dialogo = signal<Dialogo>(null);
  nombreCarpeta = signal('');
  /** Destino elegido en el árbol: id · null = Inicio · undefined = sin elegir. */
  destino = signal<string | null | undefined>(undefined);
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

    // Contenido de la carpeta actual (migas, tarjetas y permisos): al entrar o salir de una carpeta y tras cada acción.
    // carpetaId es un computed de texto: cambiar otro filtro (formato, página...) NO vuelve a pedirlo.
    let solicitudesCargadas = false;
    toObservable(computed(() => ({ id: this.carpetaId(), v: this.version() })))
      .pipe(
        switchMap(({ id }) => this.api.contenidoCarpeta(id || null).pipe(
          map((c) => ({ c, err: null as unknown })),
          catchError((err: unknown) => of({ c: null, err })),
        )),
        takeUntilDestroyed(),
      )
      .subscribe(async ({ c, err }) => {
        this.menuAbierto.set(null);
        if (!c) {
          this.contenido.set(null);
          this.errorCarpeta.set(err instanceof HttpErrorResponse && err.status === 404
            ? 'Esta carpeta no existe (quizá se eliminó o se movió). Vuelva a Inicio.'
            : await mensajeDe(err, 'No se pudieron cargar las carpetas.'));
          return;
        }
        this.errorCarpeta.set('');
        this.contenido.set(c);
        // Las solicitudes no dependen de la carpeta: se cargan una vez (y al refrescar), si el rol las usa.
        if (!solicitudesCargadas && (c.permisos.resolver || c.permisos.solicitar)) {
          solicitudesCargadas = true;
          this.cargarSolicitudes();
        }
      });
    inject(DestroyRef).onDestroy(() => this.esperaBusqueda && clearTimeout(this.esperaBusqueda));
  }

  // ------------------------------------------------------------------ carga

  cargarSolicitudes(): void {
    this.api.solicitudesMovimiento('pendiente').subscribe({
      next: (s) => this.solicitudes.set(s),
      error: () => this.solicitudes.set([]),
    });
  }

  private refrescar(): void {
    this.version.update((v) => v + 1);
    const p = this.permisos();
    if (p.resolver || p.solicitar) this.cargarSolicitudes();
  }

  // ------------------------------------------------------------------ explorador
  /** Entrar en una carpeta o volver a una de las migas (null = Inicio). Los demás filtros se conservan. */
  irACarpeta(id: string | null): void {
    if ((id ?? '') === this.carpetaId()) return;
    this.aplicar({ carpeta: id ?? '' });
  }

  alternarMenu(c: Carpeta): void {
    this.menuAbierto.update((id) => (id === c.id ? null : c.id));
  }

  /** Abre un diálogo sobre una carpeta (desde su menú "⋯"). */
  accionCarpeta(c: Carpeta, d: 'renombrar' | 'moverCarpeta' | 'eliminar'): void {
    this.menuAbierto.set(null);
    this.carpetaObjetivo.set(c);
    this.abrir(d);
  }

  private cargarArbol(): void {
    this.arbol.set(null);
    this.api.arbolCarpetas().subscribe({
      next: (a) => this.arbol.set(a),
      error: async (err: unknown) => this.errorDialogo.set(await mensajeDe(err, 'No se pudo cargar el árbol de carpetas.')),
    });
  }

  /** «Legal › 2024» del destino elegido en el árbol. */
  private nombreDestino(): string {
    return textoRuta(rutaEnArbol(this.arbol()?.carpetas ?? [], this.destino() ?? null));
  }

  /** Dónde están los documentos seleccionados, si todos están en la misma carpeta (para marcarla en el árbol). */
  ubicacionSeleccion = computed<string | null | undefined>(() => {
    const ids = new Set([...this.seleccion().values()].map((d) => d.carpeta?.id ?? null));
    return ids.size === 1 ? [...ids][0] : undefined;
  });

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
    // La carpeta no es un filtro: es dónde se está. Limpiar no saca al usuario de ella.
    const { q, departamento, formato, dias, subcarpetas } = FILTROS_POR_DEFECTO;
    this.aplicar({ q, departamento, formato, dias, subcarpetas });
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
    this.nombreCarpeta.set(d === 'renombrar' ? this.carpetaObjetivo()?.nombre ?? '' : '');
    this.destino.set(undefined);
    this.motivo.set('');
    if (d === 'mover' || d === 'solicitar' || d === 'moverCarpeta') this.cargarArbol();
    this.focoPrevio = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.dialogo.set(d);
    // El foco entra al diálogo (al campo de texto si lo hay): así Esc, Tab y Enter actúan sobre él y no sobre la página.
    afterNextRender(() => {
      const dlg = document.querySelector<HTMLElement>('[role="dialog"]');
      (dlg?.querySelector<HTMLElement>('input[type="text"], textarea') ?? dlg)?.focus();
    }, { injector: this.injector });
  }

  /** Esc cierra el menú de carpeta abierto o, si no hay, el diálogo. */
  @HostListener('document:keydown.escape')
  alPulsarEscape(): void {
    if (this.menuAbierto()) this.menuAbierto.set(null);
    else if (this.dialogo()) this.cerrarDialogo();
  }

  tituloDialogo(d: Exclude<Dialogo, null>): string {
    const nombre = this.carpetaObjetivo()?.nombre ?? '';
    return {
      crear: 'Nueva carpeta', renombrar: `Renombrar la carpeta ${nombre}`, eliminar: `Eliminar la carpeta ${nombre}`,
      moverCarpeta: `Mover la carpeta ${nombre}`, mover: 'Mover documentos', solicitar: 'Solicitar movimiento',
    }[d];
  }

  cerrarDialogo(): void {
    if (this.trabajando()) return;
    this.dialogo.set(null);
    this.devolverFoco();
  }

  private devolverFoco(): void {
    const f = this.focoPrevio;
    this.focoPrevio = null;
    if (f?.isConnected) f.focus();
  }

  /** Ejecuta una acción del diálogo: bloquea el botón, muestra el error del servidor o cierra con un aviso. */
  private async ejecutar(accion: () => Promise<string>, porDefecto: string): Promise<void> {
    this.trabajando.set(true);
    this.errorDialogo.set('');
    try {
      const texto = await accion();
      this.trabajando.set(false);
      this.dialogo.set(null);
      this.devolverFoco();
      this.aviso.set({ tipo: 'ok', texto });
      this.refrescar();
    } catch (err) {
      this.trabajando.set(false);
      this.errorDialogo.set(await mensajeDe(err, porDefecto));
    }
  }

  /** Crea la carpeta DENTRO de la que se está explorando (en Inicio, en la raíz). */
  crearCarpeta(): Promise<void> {
    const nombre = this.nombreCarpeta().trim();
    if (nombre.length < 2) return Promise.resolve(this.errorDialogo.set('El nombre debe tener al menos 2 caracteres.'));
    const donde = this.contenido()?.carpeta ?? null;
    return this.ejecutar(async () => {
      const c = await firstValueFrom(this.api.crearCarpeta(nombre, donde?.id ?? null));
      return `Carpeta «${c.nombre}» creada en ${textoRuta(donde?.ruta)}.`;
    }, 'No se pudo crear la carpeta.');
  }

  renombrarCarpeta(): Promise<void> {
    const c = this.carpetaObjetivo();
    const nombre = this.nombreCarpeta().trim();
    if (!c) return Promise.resolve();
    if (nombre.length < 2) return Promise.resolve(this.errorDialogo.set('El nombre debe tener al menos 2 caracteres.'));
    return this.ejecutar(async () => {
      const r = await firstValueFrom(this.api.renombrarCarpeta(c.id, nombre));
      return `Carpeta renombrada a «${r.nombre}».`;
    }, 'No se pudo renombrar la carpeta.');
  }

  eliminarCarpeta(): Promise<void> {
    const c = this.carpetaObjetivo();
    if (!c) return Promise.resolve();
    return this.ejecutar(async () => {
      await firstValueFrom(this.api.eliminarCarpeta(c.id));
      return `Carpeta «${c.nombre}» eliminada.`;
    }, 'No se pudo eliminar la carpeta.');
  }

  /** Mueve la carpeta del menú (con todo su contenido) al destino elegido en el árbol. */
  moverCarpeta(): Promise<void> {
    const c = this.carpetaObjetivo();
    const destino = this.destino();
    if (!c) return Promise.resolve();
    if (destino === undefined) return Promise.resolve(this.errorDialogo.set('Elija la carpeta de destino.'));
    if ((destino ?? '') === this.carpetaId()) return Promise.resolve(this.errorDialogo.set('La carpeta ya está ahí. Elija otro destino.'));
    return this.ejecutar(async () => {
      await firstValueFrom(this.api.moverCarpeta(c.id, destino));
      return `Carpeta «${c.nombre}» movida a ${this.nombreDestino()} con sus subcarpetas y documentos.`;
    }, 'No se pudo mover la carpeta.');
  }

  moverSeleccion(): Promise<void> {
    const ids = [...this.seleccion().keys()];
    if (this.destino() === undefined) return Promise.resolve(this.errorDialogo.set('Elija la carpeta de destino.'));
    if (ids.length > MAX_MOVER) return Promise.resolve(this.errorDialogo.set(`Como máximo ${MAX_MOVER} documentos por operación.`));
    return this.ejecutar(async () => {
      const r = await firstValueFrom(this.api.moverDocumentos(ids, this.destino() ?? null));
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
    if (this.destino() === undefined) return Promise.resolve(this.errorDialogo.set('Elija la carpeta de destino.'));
    if (motivo.length < 10) return Promise.resolve(this.errorDialogo.set('Explique el motivo (mínimo 10 caracteres).'));
    if (docs.length > MAX_MOVER) return Promise.resolve(this.errorDialogo.set(`Como máximo ${MAX_MOVER} documentos por operación.`));
    return this.ejecutar(async () => {
      let ok = 0;
      const problemas: string[] = [];
      for (const d of docs) {
        try {
          await firstValueFrom(this.api.solicitarMovimiento(d.id, this.destino() ?? null, motivo));
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
      this.aviso.set({ tipo: 'ok', texto: `Solicitud aprobada: «${s.documento.nombre}» se movió a ${textoCarpeta(s.carpetaDestino)}.` });
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
