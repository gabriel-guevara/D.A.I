import { DomSanitizer } from '@angular/platform-browser';
import { UrlPdf, fragmentoPagina, paginaDeConsulta, pareceUnPdf } from './archivo-pdf';

describe('pareceUnPdf', () => {
  it('reconoce la firma %PDF- solo al inicio', async () => {
    expect(await pareceUnPdf(new Blob(['%PDF-1.7 ...']))).toBe(true);
    expect(await pareceUnPdf(new Blob([' %PDF-1.7']))).toBe(false);
    expect(await pareceUnPdf(new Blob(['%PD']))).toBe(false);
  });
});

describe('página del visor (#page=N)', () => {
  it('fragmentoPagina solo acepta enteros positivos', () => {
    expect(fragmentoPagina(3)).toBe('#page=3');
    for (const n of [0, -1, 1.5, NaN, null, undefined]) expect(fragmentoPagina(n as number)).toBe('');
  });

  it('paginaDeConsulta valida el ?pagina= de la ruta', () => {
    expect(paginaDeConsulta('12')).toBe(12);
    for (const v of [null, '', '0', '-2', '3a', '1e3', '9999999', '2#x']) expect(paginaDeConsulta(v)).toBeNull();
  });

  it('UrlPdf: crea con #page, irAPagina crea un URL nuevo y revoca el anterior', () => {
    let n = 0;
    const crear = vi.fn(() => `blob:url-${++n}`);
    const revocar = vi.fn();
    Object.assign(URL, { createObjectURL: crear, revokeObjectURL: revocar });
    const sanitizer = { bypassSecurityTrustResourceUrl: (u: string) => u } as unknown as DomSanitizer;
    const pdf = new UrlPdf(sanitizer);

    expect(pdf.irAPagina(2)).toBeNull(); // aún no hay PDF
    expect(pdf.crear(new Blob(['%PDF-']), 5)).toBe('blob:url-1#page=5');
    expect(pdf.irAPagina(9)).toBe('blob:url-2#page=9');
    expect(revocar).toHaveBeenCalledWith('blob:url-1');
    pdf.revocar();
    expect(revocar).toHaveBeenCalledWith('blob:url-2');
  });
});
