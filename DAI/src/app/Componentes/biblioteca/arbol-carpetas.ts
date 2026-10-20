import type { CarpetaConRuta, CarpetaPlana, CarpetaRef } from '../../shared/api';

/**
 * Árbol de carpetas a partir de la lista plana de GET /carpetas/arbol (cada carpeta solo sabe quién es su padre).
 * Funciones puras: no dependen de Angular, así se prueban sin montar componentes.
 */

/** Una fila del árbol de destino tal como se pinta (en orden, ya "aplanado"). id null = la raíz (Inicio). */
export interface FilaArbol {
  id: string | null;
  nombre: string;
  /** 0 = Inicio; 1 = carpeta en la raíz; … hasta maxNivel. */
  nivel: number;
  tieneHijas: boolean;
  plegada: boolean;
  deshabilitada: boolean;
  /** Por qué no se puede elegir (se muestra junto al nombre). */
  motivo: string;
}

/** Hijas de cada carpeta (clave '' = la raíz), en el orden en que llegan (el servidor ya las ordena por nombre). */
export function hijasPorPadre(planas: CarpetaPlana[]): Map<string, CarpetaPlana[]> {
  const m = new Map<string, CarpetaPlana[]>();
  for (const c of planas) {
    const k = c.padreId ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(c);
  }
  return m;
}

/** La carpeta y TODAS sus descendientes (para no poder mover una carpeta dentro de sí misma). */
export function conDescendientes(planas: CarpetaPlana[], id: string): Set<string> {
  const hijas = hijasPorPadre(planas);
  const out = new Set<string>();
  const pila = [id];
  while (pila.length) {
    const x = pila.pop()!;
    if (out.has(x)) continue; // red de seguridad ante datos con ciclos
    out.add(x);
    for (const h of hijas.get(x) ?? []) pila.push(h.id);
  }
  return out;
}

/** Altura del subárbol: 1 = sin subcarpetas; 2 = con hijas sin nietas; … */
export function alturaSubarbol(planas: CarpetaPlana[], id: string): number {
  const hijas = hijasPorPadre(planas);
  const altura = (x: string, prof: number): number =>
    prof > 50 ? prof : 1 + Math.max(0, ...(hijas.get(x) ?? []).map((h) => altura(h.id, prof + 1)));
  return altura(id, 0);
}

/** Ruta de la raíz a la carpeta: [Legal, 2024]. [] para la raíz o una carpeta desconocida. */
export function rutaEnArbol(planas: CarpetaPlana[], id: string | null): CarpetaRef[] {
  const porId = new Map(planas.map((c) => [c.id, c]));
  const out: CarpetaRef[] = [];
  for (let c = id ? porId.get(id) : undefined; c && out.length < 50; c = c.padreId ? porId.get(c.padreId) : undefined)
    out.unshift({ id: c.id, nombre: c.nombre });
  return out;
}

/** Legal › 2024 (o Inicio para la raíz): para mostrar dónde está algo (tabla, detalle, búsqueda). */
export const rutaPlana = (ruta: CarpetaRef[] | null | undefined): string => (ruta?.length ? ruta.map((c) => c.nombre).join(' › ') : 'Inicio');

/** «Legal › 2024» (o «Inicio»): la misma ruta entre comillas, para mensajes y títulos. */
export const textoRuta = (ruta: CarpetaRef[] | null | undefined): string => `«${rutaPlana(ruta)}»`;

/** Ruta de la carpeta de un documento o de una solicitud, entre comillas: «Inicio» si no tiene. */
export const textoCarpeta = (c: CarpetaConRuta | null | undefined): string => textoRuta(c?.ruta);

/** Lo mismo sin comillas: Inicio › Legal (para la tabla, el detalle y la búsqueda). */
export const ubicacion = (c: CarpetaConRuta | null | undefined): string => (c?.ruta.length ? `Inicio › ${rutaPlana(c.ruta)}` : 'Inicio');

/**
 * Filas visibles del árbol de destino, empezando por "Inicio".
 *  - movida: carpeta que se va a mover (null si se mueven documentos). Ella y sus descendientes quedan deshabilitadas,
 *    y también los destinos donde, con todas sus subcarpetas, pasaría de maxNivel niveles.
 *  - plegadas: carpetas cuyas hijas no se muestran.
 */
export function filasArbol(planas: CarpetaPlana[], opciones: { maxNivel: number; movida?: string | null; plegadas?: ReadonlySet<string> }): FilaArbol[] {
  const { maxNivel, movida = null, plegadas = new Set<string>() } = opciones;
  const hijas = hijasPorPadre(planas);
  const bloqueadas = movida ? conDescendientes(planas, movida) : new Set<string>();
  const altura = movida ? alturaSubarbol(planas, movida) : 0;
  const filas: FilaArbol[] = [{
    id: null, nombre: 'Inicio', nivel: 0, tieneHijas: (hijas.get('') ?? []).length > 0, plegada: false, deshabilitada: false, motivo: '',
  }];
  const visitar = (padre: string, nivel: number) => {
    for (const c of hijas.get(padre) ?? []) {
      let motivo = '';
      if (bloqueadas.has(c.id)) motivo = c.id === movida ? 'es la carpeta que mueve' : 'está dentro de la carpeta que mueve';
      else if (movida && nivel + altura > maxNivel) motivo = `no cabe: superaría ${maxNivel} niveles`;
      const tieneHijas = (hijas.get(c.id) ?? []).length > 0;
      const plegada = plegadas.has(c.id);
      filas.push({ id: c.id, nombre: c.nombre, nivel, tieneHijas, plegada, deshabilitada: !!motivo, motivo });
      if (tieneHijas && !plegada && nivel < 50) visitar(c.id, nivel + 1);
    }
  };
  visitar('', 1);
  return filas;
}
