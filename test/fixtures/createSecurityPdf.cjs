// Original, generated PDFs: no external files, fonts, or user documents.
// Mixed real page sizes exercise virtual spacers independently of page count.
const MIXED_SIZES = [[420, 594], [612, 792], [792, 612], [480, 720], [960, 540]];
const LATE_SEARCH_TERM = 'BoundaryLatePageNeedle';

function createSecurityPdf({ huge = false } = {}) {
    const count = huge ? 1 : 50;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    for (let page = 1; page <= count; page++) {
        const [width, height] = huge ? [960, 720] : MIXED_SIZES[(page - 1) % MIXED_SIZES.length];
        const text = page === 50 ? LATE_SEARCH_TERM : `Boundary fixture page ${page}`;
        const content = `q\n0.2 0.5 0.8 rg\n36 36 120 120 re f\nQ\nBT\n/F1 18 Tf\n36 ${height - 54} Td\n(${text}) Tj\nET\n`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ${huge ? '/UserUnit 1000 ' : ''}/Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    }
    let pdf = '%PDF-1.7\n';
    const offsets = [0];
    for (let index = 0; index < objects.length; index++) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

module.exports = { createSecurityPdf, MIXED_SIZES, LATE_SEARCH_TERM };
