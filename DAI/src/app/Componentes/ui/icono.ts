import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/*
  Iconos de DAI: una sola familia (trazos estilo Lucide, licencia ISC), rejilla de 24, trazo 1.75, puntas redondeadas.
  Cada icono es una lista de trazados SVG. Sin dependencias: solo se envían los que están aquí.
  Uso: <app-icono nombre="buscar" />  ·  <app-icono nombre="papelera" [tamano]="16" etiqueta="Eliminar" />
*/

/** Círculo como trazado (cx, cy, r). */
const c = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
/** Rectángulo redondeado como trazado (x, y, ancho, alto, radio). */
const r = (x: number, y: number, w: number, h: number, rx: number) =>
  `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${rx} 0 0 1 ${rx} ${rx}v${h - 2 * rx}a${rx} ${rx} 0 0 1 ${-rx} ${rx}h${-(w - 2 * rx)}a${rx} ${rx} 0 0 1 ${-rx} ${-rx}v${-(h - 2 * rx)}a${rx} ${rx} 0 0 1 ${rx} ${-rx}z`;

const CARPETA = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const ESCUDO =
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';
const BANDEJA = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4';
const GIRO = 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8';

export const ICONOS = {
  inicio: [r(3, 3, 7, 9, 1), r(14, 3, 7, 5, 1), r(14, 12, 7, 9, 1), r(3, 16, 7, 5, 1)],
  biblioteca: ['m16 6 4 14', 'M12 6v14', 'M8 8v12', 'M4 4v16'],
  buscar: [c(11, 11, 8), 'm21 21-4.3-4.3'],
  digitalizar: [
    'M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2',
    'M7 8h8', 'M7 12h10', 'M7 16h6',
  ],
  notificacion: [
    'M10.268 21a2 2 0 0 0 3.464 0',
    'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
  ],
  papelera: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  roles: [ESCUDO, 'm9 12 2 2 4-4'],
  escudo: [ESCUDO],
  usuarios: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', c(9, 7, 4), 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  usuario: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', c(12, 7, 4)],
  'usuario-mas': ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', c(9, 7, 4), 'M19 8v6', 'M22 11h-6'],
  candado: [r(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 10 0v4'],
  llave: [
    'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
    c(16.5, 7.5, 0.5),
  ],
  movil: [r(5, 2, 14, 20, 2), 'M12 18h.01'],
  documento: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  carpeta: [CARPETA],
  'carpeta-mas': [CARPETA, 'M12 10v6', 'M9 13h6'],
  mover: [
    'M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1',
    'M2 13h10', 'm9 16 3-3-3-3',
  ],
  subir: [BANDEJA, 'm17 8-5-5-5 5', 'M12 3v12'],
  descargar: [BANDEJA, 'm7 10 5 5 5-5', 'M12 15V3'],
  versiones: [GIRO, 'M3 3v5h5', 'M12 7v5l4 2'],
  restaurar: [GIRO, 'M3 3v5h5'],
  refrescar: [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5',
  ],
  ojo: ['M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0', c(12, 12, 3)],
  'ojo-off': [
    'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
    'M14.084 14.158a3 3 0 0 1-4.242-4.242',
    'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
    'm2 2 20 20',
  ],
  salir: ['m16 17 5-5-5-5', 'M21 12H9', 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'],
  mas: ['M5 12h14', 'M12 5v14'],
  cerrar: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  'check-doble': ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
  'chevron-derecha': ['m9 18 6-6-6-6'],
  'chevron-izquierda': ['m15 18-6-6 6-6'],
  'chevron-abajo': ['m6 9 6 6 6-6'],
  'flecha-derecha': ['M5 12h14', 'm12 5 7 7-7 7'],
  'flecha-izquierda': ['m12 19-7-7 7-7', 'M19 12H5'],
  filtro: ['M3 6h18', 'M7 12h10', 'M10 18h4'],
  ordenar: ['m21 16-4 4-4-4', 'M17 20V4', 'm3 8 4-4 4 4', 'M7 4v16'],
  'mas-opciones': [c(12, 5, 1), c(12, 12, 1), c(12, 19, 1)],
  editar: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
  copiar: [r(8, 8, 14, 14, 2), 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  alerta: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: [c(12, 12, 10), 'M12 16v-4', 'M12 8h.01'],
  ayuda: [c(12, 12, 10), 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  sol: [
    c(12, 12, 4), 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41',
    'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41',
  ],
  luna: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  calendario: ['M8 2v4', 'M16 2v4', r(3, 4, 18, 18, 2), 'M3 10h18'],
  reloj: [c(12, 12, 10), 'M12 6v6l4 2'],
  almacenamiento: [
    'M22 12H2',
    'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
    'M6 16h.01', 'M10 16h.01',
  ],
  etiqueta: [
    'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    c(7.5, 7.5, 0.5),
  ],
  casa: [
    'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8',
    'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  ],
  cuadricula: [r(3, 3, 7, 7, 1), r(14, 3, 7, 7, 1), r(14, 14, 7, 7, 1), r(3, 14, 7, 7, 1)],
  lista: ['M3 6h.01', 'M3 12h.01', 'M3 18h.01', 'M8 6h13', 'M8 12h13', 'M8 18h13'],
  'enlace-externo': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  correo: [r(2, 4, 20, 16, 2), 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  firma: ['m9 15 2 2 4-4', 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
} as const satisfies Record<string, readonly string[]>;

export type NombreIcono = keyof typeof ICONOS;

@Component({
  selector: 'app-icono',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-linecap="round" stroke-linejoin="round" focusable="false"
      [attr.width]="tamano()" [attr.height]="tamano()" [attr.stroke-width]="trazo()"
      [attr.role]="etiqueta() ? 'img' : null" [attr.aria-label]="etiqueta() || null" [attr.aria-hidden]="etiqueta() ? null : 'true'">
      @for (d of trazos(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
})
export class Icono {
  nombre = input.required<NombreIcono>();
  tamano = input<number>(18);
  trazo = input<number>(1.75);
  /** Si el icono va solo (sin texto al lado), descríbalo aquí; si no, queda oculto a lectores de pantalla. */
  etiqueta = input<string>('');

  trazos = computed<readonly string[]>(() => ICONOS[this.nombre()] ?? []);
}
