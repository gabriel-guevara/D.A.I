/**
 * Genera PDFs mínimos y VÁLIDOS para las pruebas (sin dependencias): objetos numerados, tabla xref con los
 * desplazamientos exactos y trailer. Así no hace falta guardar archivos binarios en el repositorio.
 */
import crypto from 'node:crypto';

/**
 * @param {{ paginas?: number, protegido?: boolean, relleno?: number }} [opciones]
 *  - paginas:   número de páginas en blanco
 *  - protegido: añade un diccionario /Encrypt (Standard, RC4 40 bits) cuya clave de usuario NO es la vacía,
 *               así cualquier lector pide contraseña (es exactamente lo que hace un PDF "con contraseña de apertura")
 *  - relleno:   bytes extra (comentario) para fabricar PDFs grandes en la prueba de tamaño
 * @returns {Buffer}
 */
export function crearPdf({ paginas = 1, protegido = false, relleno = 0 } = {}) {
  const objetos = [];
  const kids = Array.from({ length: paginas }, (_, i) => `${3 + i} 0 R`).join(' ');
  objetos.push('<< /Type /Catalog /Pages 2 0 R >>');
  objetos.push(`<< /Type /Pages /Kids [${kids}] /Count ${paginas} >>`);
  for (let i = 0; i < paginas; i++) objetos.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  let encrypt = '';
  if (protegido) {
    objetos.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${hex(32)}> /U <${hex(32)}> >>`);
    encrypt = ` /Encrypt ${objetos.length} 0 R`;
  }

  let cuerpo = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  if (relleno > 0) cuerpo += `%${'x'.repeat(relleno)}\n`;
  const offsets = [];
  objetos.forEach((o, i) => {
    offsets.push(Buffer.byteLength(cuerpo, 'latin1'));
    cuerpo += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(cuerpo, 'latin1');
  cuerpo += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) cuerpo += `${String(off).padStart(10, '0')} 00000 n \n`;
  cuerpo += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R${encrypt} /ID [<${hex(16)}> <${hex(16)}>] >>\n`;
  cuerpo += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(cuerpo, 'latin1');
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
