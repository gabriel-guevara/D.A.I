/**
 * Generador de códigos QR (ISO/IEC 18004) SIN dependencias, para dibujar en el navegador el QR del alta 2FA.
 *
 * ¿Por qué propio y no una librería (p. ej. "qrcode")? El QR contiene el SECRETO TOTP: generarlo aquí evita
 * mandarlo a un servicio externo de imágenes y evita sumar una dependencia (y su cadena de suministro) para
 * ~250 líneas de lógica conocida. Basado en el algoritmo de referencia de Project Nayuki (MIT).
 *
 * Alcance deliberadamente acotado: modo byte (UTF-8), corrección de errores nivel M (recupera ~15 % de
 * daño), versión elegida automáticamente (1–40) y máscara con la menor penalización, como manda la norma.
 */

// Tablas de la norma para el nivel M, índice = versión (0 no se usa).
const ECC_POR_BLOQUE_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOQUES_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const BITS_FORMATO_M = 0; // L=1, M=0, Q=3, H=2

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

/** Módulos de datos disponibles en una versión (todo menos patrones fijos). */
function modulosDeDatos(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const palabrasDeDatos = (ver: number) => Math.floor(modulosDeDatos(ver) / 8) - ECC_POR_BLOQUE_M[ver] * BLOQUES_M[ver];

// ---------------------------------------------------------------------------- Reed-Solomon sobre GF(2^8)
function multiplicar(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function divisorRS(grado: number): number[] {
  const r = new Array<number>(grado).fill(0);
  r[grado - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < grado; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = multiplicar(r[j], raiz);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    raiz = multiplicar(raiz, 0x02);
  }
  return r;
}
function restoRS(datos: number[], divisor: number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0);
  for (const b of datos) {
    const factor = b ^ (r.shift() as number);
    r.push(0);
    divisor.forEach((coef, i) => (r[i] ^= multiplicar(coef, factor)));
  }
  return r;
}

/** Divide en bloques, añade la corrección de errores de cada uno e intercala como pide la norma. */
function conCorreccion(datos: number[], ver: number): number[] {
  const bloques = BLOQUES_M[ver];
  const largoEcc = ECC_POR_BLOQUE_M[ver];
  const total = Math.floor(modulosDeDatos(ver) / 8);
  const cortos = bloques - (total % bloques);
  const largoCorto = Math.floor(total / bloques);
  const div = divisorRS(largoEcc);
  const todos: number[][] = [];
  for (let i = 0, k = 0; i < bloques; i++) {
    const dat = datos.slice(k, k + largoCorto - largoEcc + (i < cortos ? 0 : 1));
    k += dat.length;
    const ecc = restoRS(dat, div);
    if (i < cortos) dat.push(0);
    todos.push(dat.concat(ecc));
  }
  const r: number[] = [];
  for (let i = 0; i < todos[0].length; i++)
    todos.forEach((b, j) => {
      if (i !== largoCorto - largoEcc || j >= cortos) r.push(b[i]);
    });
  return r;
}

// ---------------------------------------------------------------------------- matriz
class Matriz {
  readonly m: boolean[][];
  readonly fija: boolean[][];
  constructor(readonly tam: number) {
    this.m = Array.from({ length: tam }, () => new Array<boolean>(tam).fill(false));
    this.fija = Array.from({ length: tam }, () => new Array<boolean>(tam).fill(false));
  }
  poner(x: number, y: number, oscuro: boolean): void {
    this.m[y][x] = oscuro;
    this.fija[y][x] = true;
  }
}

function posicionesAlineacion(ver: number, tam: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const paso = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const r = [6];
  for (let p = tam - 7; r.length < n; p -= paso) r.splice(1, 0, p);
  return r;
}

function dibujarFormato(q: Matriz, mascara: number): void {
  const datos = (BITS_FORMATO_M << 3) | mascara;
  let rem = datos;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((datos << 10) | rem) ^ 0x5412;
  const t = q.tam;
  for (let i = 0; i <= 5; i++) q.poner(8, i, bit(bits, i));
  q.poner(8, 7, bit(bits, 6));
  q.poner(8, 8, bit(bits, 7));
  q.poner(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) q.poner(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) q.poner(t - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) q.poner(8, t - 15 + i, bit(bits, i));
  q.poner(8, t - 8, true); // módulo oscuro fijo
}

function dibujarPatrones(q: Matriz, ver: number): void {
  const t = q.tam;
  for (let i = 0; i < t; i++) {
    q.poner(6, i, i % 2 === 0);
    q.poner(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [t - 4, 3], [3, t - 4]]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < t && y >= 0 && y < t) q.poner(x, y, d !== 2 && d !== 4);
      }
  }
  const pos = posicionesAlineacion(ver, t);
  const ult = pos.length - 1;
  pos.forEach((px, i) =>
    pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === ult) || (i === ult && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) q.poner(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  dibujarFormato(q, 0); // reserva el espacio; se reescribe con la máscara elegida
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = t - 11 + (i % 3);
      const b = Math.floor(i / 3);
      q.poner(a, b, bit(bits, i));
      q.poner(b, a, bit(bits, i));
    }
  }
}

function dibujarDatos(q: Matriz, datos: number[]): void {
  const t = q.tam;
  let i = 0;
  for (let derecha = t - 1; derecha >= 1; derecha -= 2) {
    if (derecha === 6) derecha = 5;
    for (let v = 0; v < t; v++)
      for (let j = 0; j < 2; j++) {
        const x = derecha - j;
        const subiendo = ((derecha + 1) & 2) === 0;
        const y = subiendo ? t - 1 - v : v;
        if (!q.fija[y][x] && i < datos.length * 8) {
          q.m[y][x] = bit(datos[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
  }
}

const MASCARAS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function aplicarMascara(q: Matriz, k: number): void {
  for (let y = 0; y < q.tam; y++)
    for (let x = 0; x < q.tam; x++) if (!q.fija[y][x] && MASCARAS[k](x, y)) q.m[y][x] = !q.m[y][x];
}

/** Penalización de la norma: rachas largas, bloques 2×2, falsos patrones de posición y desbalance de color. */
function penalizacion(m: boolean[][]): number {
  const t = m.length;
  let p = 0;
  const lineas: boolean[][] = [];
  for (let i = 0; i < t; i++) {
    lineas.push(m[i]);
    lineas.push(m.map((fila) => fila[i]));
  }
  const patronA = [true, false, true, true, true, false, true, false, false, false, false];
  const patronB = [false, false, false, false, true, false, true, true, true, false, true];
  for (const l of lineas) {
    let racha = 1;
    for (let i = 1; i <= t; i++) {
      if (i < t && l[i] === l[i - 1]) racha++;
      else {
        if (racha >= 5) p += 3 + (racha - 5);
        racha = 1;
      }
    }
    for (let i = 0; i + 11 <= t; i++)
      if (patronA.every((v, k) => l[i + k] === v) || patronB.every((v, k) => l[i + k] === v)) p += 40;
  }
  for (let y = 0; y + 1 < t; y++)
    for (let x = 0; x + 1 < t; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  const oscuros = m.reduce((s, fila) => s + fila.filter(Boolean).length, 0);
  const total = t * t;
  p += (Math.ceil(Math.abs(oscuros * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/**
 * Matriz del QR para un texto (true = módulo oscuro), sin la zona de silencio.
 * Lanza un Error si el texto no cabe (más de ~2.300 bytes con nivel M).
 */
export function generarQr(texto: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(texto));
  let ver = 1;
  for (; ver <= 40; ver++) {
    const bitsConteo = ver <= 9 ? 8 : 16;
    if (4 + bitsConteo + bytes.length * 8 <= palabrasDeDatos(ver) * 8) break;
  }
  if (ver > 40) throw new Error('Texto demasiado largo para un código QR.');

  // Segmento en modo byte: 0100 + longitud + datos, terminador, relleno a byte y bytes de relleno 0xEC/0x11.
  const bits: number[] = [];
  const agregar = (valor: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((valor >>> i) & 1);
  };
  agregar(0b0100, 4);
  agregar(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach((b) => agregar(b, 8));
  const capacidad = palabrasDeDatos(ver) * 8;
  agregar(0, Math.min(4, capacidad - bits.length));
  agregar(0, (8 - (bits.length % 8)) % 8);
  for (let relleno = 0xec; bits.length < capacidad; relleno ^= 0xec ^ 0x11) agregar(relleno, 8);
  const datos: number[] = [];
  for (let i = 0; i < bits.length; i += 8) datos.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const q = new Matriz(ver * 4 + 17);
  dibujarPatrones(q, ver);
  dibujarDatos(q, conCorreccion(datos, ver));

  let mejor = 0;
  let menor = Infinity;
  for (let k = 0; k < 8; k++) {
    aplicarMascara(q, k);
    dibujarFormato(q, k);
    const pen = penalizacion(q.m);
    if (pen < menor) {
      menor = pen;
      mejor = k;
    }
    aplicarMascara(q, k); // XOR: aplicarla otra vez la deshace
  }
  aplicarMascara(q, mejor);
  dibujarFormato(q, mejor);
  return q.m;
}

/** Trazado SVG (un cuadrado por módulo oscuro) con zona de silencio de 4 módulos. */
export function trazadoSvgQr(matriz: boolean[][], margen = 4): { d: string; lado: number } {
  let d = '';
  matriz.forEach((fila, y) =>
    fila.forEach((oscuro, x) => {
      if (oscuro) d += `M${x + margen} ${y + margen}h1v1h-1z`;
    }),
  );
  return { d, lado: matriz.length + margen * 2 };
}
