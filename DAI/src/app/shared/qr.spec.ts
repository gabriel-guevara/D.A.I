import { generarQr, trazadoSvgQr } from './qr';

/** Comprueba un patrón de posición (cuadro 7×7) con su esquina superior izquierda en (x, y). */
function esPatronDePosicion(m: boolean[][], x: number, y: number): boolean {
  for (let dy = 0; dy < 7; dy++)
    for (let dx = 0; dx < 7; dx++) {
      const borde = dx === 0 || dy === 0 || dx === 6 || dy === 6;
      const centro = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (m[y + dy][x + dx] !== (borde || centro)) return false;
    }
  return true;
}

describe('generarQr (sin dependencias)', () => {
  // La decodificación real se validó con un lector QR independiente (jsQR) durante el desarrollo;
  // aquí se fijan las propiedades estructurales de la norma.
  it('elige la versión mínima: texto corto = versión 1 (21×21)', () => {
    expect(generarQr('hola').length).toBe(21);
  });

  it('una URI otpauth típica cabe en una versión pequeña y la matriz es cuadrada', () => {
    const uri = 'otpauth://totp/DAI:e.ramos%40dai.corp?secret=JUOUKGQIJBATIKY3GAHWIYILBBFCYKKN&period=30&digits=6&algorithm=SHA1&issuer=DAI';
    const m = generarQr(uri);
    expect(m.length).toBe(45); // versión 7 con nivel M
    expect(m.every((fila) => fila.length === m.length)).toBe(true);
  });

  it('tiene los tres patrones de posición, el patrón de sincronización y el módulo oscuro fijo', () => {
    const m = generarQr('Seguridad DAI');
    const t = m.length;
    expect(esPatronDePosicion(m, 0, 0)).toBe(true);
    expect(esPatronDePosicion(m, t - 7, 0)).toBe(true);
    expect(esPatronDePosicion(m, 0, t - 7)).toBe(true);
    for (let i = 8; i < t - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[t - 8][8]).toBe(true);
  });

  it('es determinista y admite UTF-8 (tildes, ñ)', () => {
    expect(generarQr('Bogotá — ñandú')).toEqual(generarQr('Bogotá — ñandú'));
  });

  it('rechaza textos que no caben en un QR', () => {
    expect(() => generarQr('x'.repeat(3000))).toThrowError(/demasiado largo/);
  });

  it('trazado SVG con zona de silencio de 4 módulos', () => {
    const { d, lado } = trazadoSvgQr(generarQr('hola'));
    expect(lado).toBe(29);
    expect(d.startsWith('M4 4h1v1h-1z')).toBe(true); // esquina del primer patrón de posición
  });
});
