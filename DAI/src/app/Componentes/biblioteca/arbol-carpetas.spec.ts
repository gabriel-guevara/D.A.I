import type { CarpetaPlana } from '../../shared/api';
import { alturaSubarbol, conDescendientes, filasArbol, rutaEnArbol, textoCarpeta, textoRuta, ubicacion } from './arbol-carpetas';

/** Legal › 2024 › Contratos › Proveedores; Finanzas › 2024; Personal (vacía). */
const P: CarpetaPlana[] = [
  { id: '1', nombre: 'Finanzas', padreId: null },
  { id: '2', nombre: 'Legal', padreId: null },
  { id: '3', nombre: 'Personal', padreId: null },
  { id: '4', nombre: '2024', padreId: '1' },
  { id: '5', nombre: '2024', padreId: '2' },
  { id: '6', nombre: 'Contratos', padreId: '5' },
  { id: '7', nombre: 'Proveedores', padreId: '6' },
];

describe('Árbol de carpetas (funciones puras)', () => {
  it('descendientes, altura del subárbol y ruta desde la raíz', () => {
    expect([...conDescendientes(P, '2')].sort()).toEqual(['2', '5', '6', '7']);
    expect([...conDescendientes(P, '3')]).toEqual(['3']);
    expect([alturaSubarbol(P, '2'), alturaSubarbol(P, '6'), alturaSubarbol(P, '3')]).toEqual([4, 2, 1]);
    expect(rutaEnArbol(P, '7').map((c) => c.nombre)).toEqual(['Legal', '2024', 'Contratos', 'Proveedores']);
    expect(rutaEnArbol(P, null)).toEqual([]);
    expect(rutaEnArbol(P, '999')).toEqual([]);
  });

  it('texto de la ruta: «Legal › 2024» y «Inicio» para la raíz', () => {
    expect(textoRuta(rutaEnArbol(P, '5'))).toBe('«Legal › 2024»');
    expect(textoRuta([])).toBe('«Inicio»');
    expect(textoCarpeta(null)).toBe('«Inicio»');
    expect(textoCarpeta({ id: '4', nombre: '2024', ruta: [{ id: '1', nombre: 'Finanzas' }, { id: '4', nombre: '2024' }] })).toBe('«Finanzas › 2024»');
    expect(ubicacion({ id: '4', nombre: '2024', ruta: [{ id: '1', nombre: 'Finanzas' }, { id: '4', nombre: '2024' }] })).toBe('Inicio › Finanzas › 2024');
    expect(ubicacion(null)).toBe('Inicio');
  });

  it('filas: Inicio primero, en orden de árbol y con su nivel; las plegadas ocultan a sus hijas', () => {
    const filas = filasArbol(P, { maxNivel: 5 });
    expect(filas.map((f) => `${'-'.repeat(f.nivel)}${f.nombre}`)).toEqual(
      ['Inicio', '-Finanzas', '--2024', '-Legal', '--2024', '---Contratos', '----Proveedores', '-Personal']);
    expect(filas.every((f) => !f.deshabilitada)).toBe(true); // al mover documentos todo destino vale
    const plegada = filasArbol(P, { maxNivel: 5, plegadas: new Set(['2']) });
    expect(plegada.map((f) => f.nombre)).toEqual(['Inicio', 'Finanzas', '2024', 'Legal', 'Personal']);
    expect(plegada.find((f) => f.id === '2')).toMatchObject({ tieneHijas: true, plegada: true });
  });

  it('mover una carpeta: ella y sus descendientes deshabilitadas, y los destinos donde no cabe', () => {
    // "2024" de Legal tiene 3 niveles (2024 › Contratos › Proveedores): cabe hasta en un destino de nivel 2.
    const filas = filasArbol(P, { maxNivel: 5, movida: '5' });
    const estado = Object.fromEntries(filas.map((f) => [f.id ?? 'inicio', f.motivo]));
    expect(estado).toEqual({
      inicio: '', '1': '', '4': '', '2': '', '5': 'es la carpeta que mueve',
      '6': 'está dentro de la carpeta que mueve', '7': 'está dentro de la carpeta que mueve', '3': '',
    });
    // Con un máximo de 4 niveles, en Finanzas › 2024 (nivel 2) llegaría al 5: no cabe.
    const justo = filasArbol(P, { maxNivel: 4, movida: '5' });
    expect(justo.find((f) => f.id === '4')).toMatchObject({ deshabilitada: true, motivo: 'no cabe: superaría 4 niveles' });
    expect(justo.find((f) => f.id === '1')?.deshabilitada).toBe(false);
    expect(justo[0].deshabilitada).toBe(false); // Inicio siempre
  });
});
