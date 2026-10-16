import { convertToParamMap } from '@angular/router';
import { FILTROS_POR_DEFECTO, filtrosDesdeUrl, paginasVisibles, queryParamsDe } from './biblioteca-filtros';

describe('Filtros de la biblioteca ⇄ URL', () => {
  it('sin parámetros: los valores por defecto', () => {
    expect(filtrosDesdeUrl(convertToParamMap({}))).toEqual(FILTROS_POR_DEFECTO);
  });

  it('lee y conserva los valores válidos', () => {
    const f = filtrosDesdeUrl(convertToParamMap({
      q: '  contrato ', departamento: 'Legal', formato: 'pdf', dias: '90', carpeta: '7', orden: 'nombre', pagina: '3', porPagina: '50',
    }));
    expect(f).toEqual({ q: 'contrato', departamento: 'Legal', formato: 'pdf', dias: '90', carpeta: '7', orden: 'nombre', pagina: 3, porPagina: 50 });
  });

  it('una URL escrita a mano con valores inválidos vuelve a los valores por defecto', () => {
    const f = filtrosDesdeUrl(convertToParamMap({
      formato: 'exe', dias: '45', carpeta: '1;DROP', orden: 'id', pagina: '-2', porPagina: '33',
    }));
    expect(f).toEqual(FILTROS_POR_DEFECTO);
    expect(filtrosDesdeUrl(convertToParamMap({ carpeta: 'sin', pagina: 'abc' }))).toEqual({ ...FILTROS_POR_DEFECTO, carpeta: 'sin' });
  });

  it('a la URL solo van los valores distintos del de por defecto (y vuelven iguales)', () => {
    expect(queryParamsDe(FILTROS_POR_DEFECTO)).toEqual({
      q: null, departamento: null, formato: null, dias: null, carpeta: null, orden: null, pagina: null, porPagina: null,
    });
    const f = { ...FILTROS_POR_DEFECTO, formato: 'xlsx' as const, pagina: 2, porPagina: 100 as const };
    const qp = queryParamsDe(f);
    expect(qp).toEqual({ q: null, departamento: null, formato: 'xlsx', dias: null, carpeta: null, orden: null, pagina: '2', porPagina: '100' });
    const ida = Object.fromEntries(Object.entries(qp).filter(([, v]) => v !== null)) as Record<string, string>;
    expect(filtrosDesdeUrl(convertToParamMap(ida))).toEqual(f);
  });

  it('números de página: primera, última y dos a cada lado de la actual', () => {
    expect(paginasVisibles(1, 1)).toEqual([1]);
    expect(paginasVisibles(1, 4)).toEqual([1, 2, 3, 4]);
    expect(paginasVisibles(6, 20)).toEqual([1, '…', 4, 5, 6, 7, 8, '…', 20]);
    expect(paginasVisibles(20, 20)).toEqual([1, '…', 18, 19, 20]);
  });
});
