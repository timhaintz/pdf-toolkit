const { deflateSync } = require('node:zlib');

// Original 16 x 16 RGB bitmaps: Flate/JPEG XObjects and an unfiltered inline image.
// Deliberately different colors distinguish the extraction paths and order.
const RASTER_IMAGES = [
    { name: 'Flate RGB XObject', top: [51, 128, 204], bottom: [204, 77, 51] },
    { name: 'inline RGB image', top: [51, 179, 102], bottom: [153, 77, 204] },
    { name: 'JPEG RGB XObject', top: [204, 153, 51], bottom: [51, 179, 179] }
];
const RASTER_PAGE_SIZE = { width: 360, height: 320 };
const RASTER_PREVIEW_PROBES = [
    { x: 72, y: 112, rgb: RASTER_IMAGES[0].top },
    { x: 72, y: 208, rgb: RASTER_IMAGES[0].bottom },
    { x: 180, y: 112, rgb: RASTER_IMAGES[1].top },
    { x: 180, y: 208, rgb: RASTER_IMAGES[1].bottom },
    { x: 288, y: 112, rgb: RASTER_IMAGES[2].top },
    { x: 288, y: 208, rgb: RASTER_IMAGES[2].bottom }
];
// Created once with @napi-rs/canvas at JPEG quality 100. The self-contained bytes
// keep CI independent of a JPEG encoder; source colors decode within one level.
const JPEG_IMAGE = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAAQABADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAkK/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AuhB9RABP7Ugx3gP/2Q==',
    'base64'
);

function rgbHalves({ top, bottom }) {
    const pixels = Buffer.alloc(16 * 16 * 3);
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const rgb = y < 8 ? top : bottom;
            for (let channel = 0; channel < 3; channel++) pixels[(y * 16 + x) * 3 + channel] = rgb[channel];
        }
    }
    return pixels;
}

function createRasterPdf() {
    const xobject = deflateSync(rgbHalves(RASTER_IMAGES[0]));
    const content = Buffer.concat([
        Buffer.from('q\n96 0 0 192 24 64 cm\n/Raster Do\nQ\nq\n96 0 0 192 132 64 cm\n'
            + 'BI /W 16 /H 16 /CS /RGB /BPC 8 /I false ID\n'),
        rgbHalves(RASTER_IMAGES[1]),
        Buffer.from('\nEI\nQ\nq\n96 0 0 192 240 64 cm\n/Photo Do\nQ\n')
    ]);
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${RASTER_PAGE_SIZE.width} ${RASTER_PAGE_SIZE.height}] /Resources << /XObject << /Raster 5 0 R /Photo 6 0 R >> >> /Contents 4 0 R >>`,
        Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('endstream')]),
        Buffer.concat([
            Buffer.from('<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB '
                + `/BitsPerComponent 8 /Interpolate false /Filter /FlateDecode /Length ${xobject.length} >>\nstream\n`),
            xobject,
            Buffer.from('\nendstream')
        ]),
        Buffer.concat([
            Buffer.from('<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB '
                + `/BitsPerComponent 8 /Interpolate false /Filter /DCTDecode /Length ${JPEG_IMAGE.length} >>\nstream\n`),
            JPEG_IMAGE,
            Buffer.from('\nendstream')
        ])
    ];
    const parts = [Buffer.from('%PDF-1.4\n')];
    const offsets = [0];
    let size = parts[0].length;
    for (let index = 0; index < objects.length; index++) {
        offsets.push(size);
        const object = Buffer.concat([
            Buffer.from(`${index + 1} 0 obj\n`),
            Buffer.isBuffer(objects[index]) ? objects[index] : Buffer.from(objects[index]),
            Buffer.from('\nendobj\n')
        ]);
        parts.push(object);
        size += object.length;
    }
    parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
    return Buffer.concat(parts);
}

module.exports = { createRasterPdf, RASTER_IMAGES, RASTER_PAGE_SIZE, RASTER_PREVIEW_PROBES };
