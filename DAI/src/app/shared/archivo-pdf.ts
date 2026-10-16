import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

/**
 * Administra UN object URL (blob:...) de un PDF que ya está en memoria del navegador.
 *
 * Analogía: URL.createObjectURL es como dejar una copia del archivo en un casillero y recibir la llave.
 * Mientras no devuelvas la llave (revokeObjectURL), el navegador guarda la copia aunque ya no la uses.
 * Esta clase garantiza devolver la llave anterior al crear otra y al destruir el componente.
 */
export class UrlPdf {
  private url: string | null = null;
  private datos: Blob | null = null;

  constructor(private readonly sanitizer: DomSanitizer) {}

  /**
   * Crea el URL para el <iframe>. El Blob se re-etiqueta como application/pdf: así el navegador SIEMPRE lo
   * abre con su visor de PDF y nunca lo interpreta como HTML, aunque el servidor ya haya validado el contenido.
   * bypassSecurityTrustResourceUrl es seguro aquí porque el URL lo generamos nosotros a partir de bytes PDF.
   *
   * pagina: añade "#page=N" (parámetro de apertura de PDF). Lo respetan el visor de Chrome/Edge y el de Firefox
   * (pdf.js); Safari lo ignora y abre en la página 1. Ver fragmentoPagina().
   */
  crear(datos: Blob, pagina?: number | null): SafeResourceUrl {
    this.revocar();
    this.datos = new Blob([datos], { type: 'application/pdf' });
    this.url = URL.createObjectURL(this.datos);
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.url + fragmentoPagina(pagina));
  }

  /**
   * Vuelve a abrir el MISMO PDF (ya en memoria, sin pedirlo otra vez al servidor) en otra página.
   * Se crea un object URL nuevo a propósito: cambiar solo el "#page=N" de un iframe que ya muestra el PDF no
   * siempre hace que el visor nativo salte (es una navegación "dentro del mismo documento"); un URL nuevo sí.
   */
  irAPagina(pagina: number): SafeResourceUrl | null {
    return this.datos ? this.crear(this.datos, pagina) : null;
  }

  revocar(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}

/** "#page=N" solo para enteros positivos (el número viene de la URL de la app: nunca se confía en él). */
export function fragmentoPagina(pagina?: number | null): string {
  return Number.isInteger(pagina) && (pagina as number) >= 1 && (pagina as number) <= 100_000 ? `#page=${pagina}` : '';
}

/** Lee ?pagina=N de la ruta: entero positivo o null. */
export function paginaDeConsulta(valor: string | null): number | null {
  if (!valor || !/^\d{1,6}$/.test(valor)) return null;
  const n = Number(valor);
  return n >= 1 ? n : null;
}

/** Ofrece un Blob como descarga con el nombre indicado y libera el object URL enseguida. */
export function guardarComo(datos: Blob, nombre: string): void {
  const url = URL.createObjectURL(new Blob([datos], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // El navegador ya tomó el archivo; un pequeño margen evita cancelar la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** ¿Empieza el archivo por "%PDF-"? Comprobación rápida en el navegador (UX); el servidor valida de verdad. */
export async function pareceUnPdf(archivo: Blob): Promise<boolean> {
  const cabecera = new Uint8Array(await archivo.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...cabecera) === '%PDF-';
}
