/**
 * Genera PDFs mínimos y VÁLIDOS para las pruebas (sin dependencias): objetos numerados, tabla xref con los
 * desplazamientos exactos y trailer. Así no hace falta guardar archivos binarios en el repositorio.
 */
import crypto from 'node:crypto';

/**
 * @param {{ paginas?: number, protegido?: boolean, relleno?: number, textos?: (string|string[]|null)[] }} [opciones]
 *  - paginas:   número de páginas en blanco
 *  - textos:    texto REAL por página (una línea, o un arreglo de líneas; null = página sin texto, como un escaneo).
 *               Usa Helvetica con WinAnsiEncoding, así las tildes y la ñ llegan tal cual (latin1 ≈ WinAnsi).
 *               Si se indica, manda sobre "paginas".
 *  - protegido: añade un diccionario /Encrypt (Standard, RC4 40 bits) cuya clave de usuario NO es la vacía,
 *               así cualquier lector pide contraseña (es exactamente lo que hace un PDF "con contraseña de apertura")
 *  - relleno:   bytes extra (comentario) para fabricar PDFs grandes en la prueba de tamaño
 * @returns {Buffer}
 */
export function crearPdf({ paginas = 1, protegido = false, relleno = 0, textos = null } = {}) {
  if (textos) paginas = textos.length;
  const objetos = [];
  // Objetos: 1 catálogo, 2 páginas, 3..(2+n) cada página, (3+n) la fuente, después los flujos de contenido.
  const kids = Array.from({ length: paginas }, (_, i) => `${3 + i} 0 R`).join(' ');
  const fuente = 3 + paginas;
  objetos.push('<< /Type /Catalog /Pages 2 0 R >>');
  objetos.push(`<< /Type /Pages /Kids [${kids}] /Count ${paginas} >>`);
  const contenidos = [];
  for (let i = 0; i < paginas; i++) {
    const lineas = textos?.[i] == null ? null : [].concat(textos[i]);
    if (!lineas) {
      objetos.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
      continue;
    }
    const escapar = (t) => t.replace(/[\\()]/g, '\\$&');
    const flujo = `BT /F1 11 Tf 14 TL 72 740 Td ${lineas.map((l) => `(${escapar(l)}) Tj T*`).join(' ')} ET`;
    contenidos.push(flujo);
    objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fuente} 0 R >> >> /Contents ${fuente + contenidos.length} 0 R >>`);
  }
  if (textos) {
    objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    for (const f of contenidos) objetos.push(`<< /Length ${Buffer.byteLength(f, 'latin1')} >>\nstream\n${f}\nendstream`);
  }
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
