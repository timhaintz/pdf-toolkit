// Original lossless 16 x 16 RGB JPEG 2000 test image: blue upper half, red lower half.
// Created with Pillow/OpenJPEG; embedded bytes keep CI independent of an encoder.
const JPX_IMAGE = Buffer.from(
    'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAEAAAABAAAwcHAAAAAAAPY29scgEAAAAAABAAAAESanAyY/9P/1EALwAAAAAAEAAAABAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAQEBAAB/1wAEEBASEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAjgAB/5PH1AQFv8HyAgV/x9QEAxun4AQET6H1AIAFp+AGBv9/o+0FAAZCjMOnoPnCAAOR2A+j7QQAA5JavaPtCAAMeDkHEwRO46D5w4APJ5Ds0v9/o+0IAA8oQQcS/xwXo+0JAADUx41Ip3FcH6D5w4ADhMiisqi/o+0JAAOEz41Ip3Fbcf/Z',
    'base64'
);

function createJpxPdf() {
    const content = 'q\n240 0 0 320 0 0 cm\n/Photo Do\nQ\n';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << /XObject << /Photo 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
        Buffer.concat([
            Buffer.from(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${JPX_IMAGE.length} >>\nstream\n`),
            JPX_IMAGE,
            Buffer.from('\nendstream')
        ])
    ];
    const parts = [Buffer.from('%PDF-1.5\n')];
    const offsets = [0];
    let size = parts[0].length;
    for (let i = 0; i < objects.length; i++) {
        offsets.push(size);
        const object = Buffer.concat([
            Buffer.from(`${i + 1} 0 obj\n`),
            Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i]),
            Buffer.from('\nendobj\n')
        ]);
        parts.push(object);
        size += object.length;
    }
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
}

module.exports = { createJpxPdf };
