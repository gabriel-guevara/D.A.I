import { pareceUnPdf } from './archivo-pdf';

describe('pareceUnPdf', () => {
  it('reconoce la firma %PDF- solo al inicio', async () => {
    expect(await pareceUnPdf(new Blob(['%PDF-1.7 ...']))).toBe(true);
    expect(await pareceUnPdf(new Blob([' %PDF-1.7']))).toBe(false);
    expect(await pareceUnPdf(new Blob(['%PD']))).toBe(false);
  });
});
