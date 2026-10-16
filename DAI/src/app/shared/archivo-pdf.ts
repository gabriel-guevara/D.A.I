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

  constructor(private readonly sanitizer: DomSanitizer) {}

  /**
   * Crea el URL para el <iframe>. El Blob se re-etiqueta como application/pdf: así el navegador SIEMPRE lo
   * abre con su visor de PDF y nunca lo interpreta como HTML, aunque el servidor ya haya validado el contenido.
   * bypassSecurityTrustResourceUrl es seguro aquí porque el URL lo generamos nosotros a partir de bytes PDF.
   */
  crear(datos: Blob): SafeResourceUrl {
    this.revocar();
    this.url = URL.createObjectURL(new Blob([datos], { type: 'application/pdf' }));
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.url);
  }

  revocar(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
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
