// A deterministic, self-contained PDF with five 240 x 320 point pages.
// No external fonts, network resources, or private documents are used.
const PAGE_COLORS = [[51, 128, 204], [51, 179, 102], [204, 77, 51], [153, 77, 204], [204, 153, 51]];

function fixturePageColors(variant = 'sample') {
    if (variant !== 'sample' && variant !== 'second') throw new Error(`Unknown fixture: ${variant}`);
    const colors = PAGE_COLORS.map(color => [...color]);
    return variant === 'second' ? colors.reverse() : colors;
}

function createPdf(variant = 'sample') {
    const objects = [];
    const add = value => { objects.push(value); return objects.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('<< /Type /Pages /Count 5 /Kids [4 0 R 6 0 R 8 0 R 10 0 R 12 0 R] >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const colors = fixturePageColors(variant).map(color => color.map(channel => channel / 255).join(' '));
    for (let page = 1; page <= 5; page++) {
        const contentId = objects.length + 2;
        add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
        const content = `q\n${colors[page - 1]} rg\n24 24 192 220 re f\nQ\nBT\n/F1 18 Tf\n24 282 Td\n(PDF Toolkit test page ${page}) Tj\nET\n`;
        add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    }
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

module.exports = { createPdf, fixturePageColors };
if (require.main === module) {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const variant of ['sample', 'second']) fs.writeFileSync(path.join(__dirname, `${variant}.pdf`), createPdf(variant));
}
