// Builds small, real PDFs for tests: pages of text lines in Helvetica or
// Helvetica-Bold at given sizes and positions, so the pdf adapter can be
// tested end to end without binary fixtures.

/**
 * @param {Array<Array<{ text: string, size?: number, bold?: boolean, x?: number, y: number }>>} pages
 * @param {{ title?: string }} [options]
 * @returns {Buffer}
 */
export function makePdf(pages, { title } = {}) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add('');
  const pagesObj = add('');
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = pages.map((lines) => {
    const stream = lines
      .map((l) => `BT /${l.bold ? 'F2' : 'F1'} ${l.size ?? 10} Tf ${l.x ?? 72} ${l.y} Td (${escape(l.text)}) Tj ET`)
      .join('\n');
    const contents = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contents} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = title ? add(`<< /Title (${escape(title)}) >>`) : null;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function escape(text) {
  return text.replace(/[\\()]/g, '\\$&');
}
