import { ParamMap, Params } from '@angular/router';
import type { DiasBiblioteca, FiltrosBiblioteca, FormatoDoc, OrdenBiblioteca } from '../../shared/api';

/**
 * Filtros de la biblioteca ⇄ query params de la URL.
 *
 * La URL es la "fuente de verdad": compartir o recargar /biblioteca?formato=pdf&pagina=2 muestra lo mismo, y el
 * botón Atrás del navegador deshace un cambio de filtro. Como cualquiera puede escribir la URL a mano, cada valor
 * se valida aquí (y el servidor lo vuelve a validar): lo que no es válido vuelve a su valor por defecto.
 *
 * Fase 6: ?carpeta=<id> es la carpeta que se está explorando; sin ella, la raíz ("Inicio"). Los enlaces viejos de la
 * Fase 5 con ?carpeta=sin ("Sin carpeta") significan lo mismo que la raíz.
 */
export const FILTROS_POR_DEFECTO: FiltrosBiblioteca = {
  q: '', departamento: '', formato: '', dias: 'todo', carpeta: '', subcarpetas: false, orden: 'reciente', pagina: 1, porPagina: 25,
};

const FORMATOS: FormatoDoc[] = ['pdf', 'xlsx', 'docx', 'tiff'];
const DIAS: DiasBiblioteca[] = ['30', '90', '180', 'todo'];
const ORDENES: OrdenBiblioteca[] = ['reciente', 'antiguo', 'tamano', 'nombre'];
const POR_PAGINA = [25, 50, 100] as const;

export const ETIQUETA_FORMATO: Record<FormatoDoc, string> = { pdf: 'PDF', xlsx: 'Excel', docx: 'Word', tiff: 'TIFF' };
export const ETIQUETA_DIAS: Record<DiasBiblioteca, string> = {
  '30': 'Últimos 30 días', '90': 'Últimos 3 meses', '180': 'Últimos 6 meses', todo: 'Todo el histórico',
};
export const ETIQUETA_ORDEN: Record<OrdenBiblioteca, string> = {
  reciente: 'Más reciente', antiguo: 'Más antiguo', tamano: 'Tamaño (mayor primero)', nombre: 'Nombre (A–Z)',
};

const incluido = <T extends string>(lista: readonly T[], v: string | null): v is T => v !== null && (lista as readonly string[]).includes(v);

/** Lee y valida los filtros de la URL. */
export function filtrosDesdeUrl(p: ParamMap): FiltrosBiblioteca {
  const texto = (k: string, max: number) => (p.get(k) ?? '').trim().slice(0, max);
  const carpeta = texto('carpeta', 20);
  const pagina = Number(p.get('pagina'));
  const porPagina = Number(p.get('porPagina'));
  const formato = p.get('formato');
  const dias = p.get('dias');
  const orden = p.get('orden');
  return {
    q: texto('q', 200),
    departamento: texto('departamento', 100),
    formato: incluido(FORMATOS, formato) ? formato : '',
    dias: incluido(DIAS, dias) ? dias : 'todo',
    carpeta: /^\d{1,18}$/.test(carpeta) ? carpeta : '',
    subcarpetas: p.get('subcarpetas') === '1',
    orden: incluido(ORDENES, orden) ? orden : 'reciente',
    pagina: Number.isInteger(pagina) && pagina >= 1 && pagina <= 100_000 ? pagina : 1,
    porPagina: (POR_PAGINA as readonly number[]).includes(porPagina) ? (porPagina as FiltrosBiblioteca['porPagina']) : 25,
  };
}

/**
 * Query params para router.navigate: los valores por defecto se quitan (null) para que la URL quede corta y
 * "/biblioteca" a secas signifique "sin filtros".
 */
export function queryParamsDe(f: FiltrosBiblioteca): Params {
  const out: Params = {};
  for (const k of Object.keys(FILTROS_POR_DEFECTO) as (keyof FiltrosBiblioteca)[])
    out[k] = f[k] === FILTROS_POR_DEFECTO[k] || f[k] === '' ? null : f[k] === true ? '1' : String(f[k]);
  return out;
}

/** Números de página a mostrar: siempre la primera y la última, y hasta dos a cada lado de la actual. */
export function paginasVisibles(actual: number, total: number): (number | '…')[] {
  const out: (number | '…')[] = [];
  for (let n = 1; n <= total; n++) {
    if (n === 1 || n === total || Math.abs(n - actual) <= 2) out.push(n);
    else if (out[out.length - 1] !== '…') out.push('…');
  }
  return out;
}
