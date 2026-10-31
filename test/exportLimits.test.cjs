const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { createExportLimits } = require('../out/exportLimits.js');

const providerSource = readFileSync(path.resolve(__dirname, '../src/pdfEditorProvider.ts'), 'utf8');
const exportSource = providerSource.slice(
    providerSource.indexOf('        async function extractPagesAsImages('),
    providerSource.indexOf('        // Event listeners')
);
const imageUrl = 'data:image/png;base64,aW1hZ2U=';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const dataUrlWithLength = length => {
    const prefix = 'data:image/png;base64,';
    return prefix + 'A'.repeat(length - prefix.length);
};

class FakeImageBitmap {
    constructor(width, height) { this.width = width; this.height = height; }
}

class FakeVideoFrame {
    constructor(displayWidth, displayHeight) {
        this.displayWidth = displayWidth;
        this.displayHeight = displayHeight;
        this.codedWidth = displayWidth + 16;
        this.codedHeight = displayHeight + 16;
        this.closed = false;
    }
    close() { this.closed = true; }
}

function createHarness(config = {}) {
    const messages = [];
    const canvases = [];
    const requests = [];
    const viewports = [];
    const renders = [];
    const encodings = [];
    const warnings = [];
    const pixelBuffers = [];

    class Canvas {
        constructor() {
            this.w = 300;
            this.h = 150;
            canvases.push(this);
        }
        get width() { return this.w; }
        set width(value) {
            assert.ok(Number.isFinite(value) && value >= 0 && value <= 8192,
                `Unsafe width reached canvas assignment: ${value}`);
            this.w = Math.trunc(value);
            assert.ok(this.w * this.h <= 32_000_000, 'Unsafe pixel count reached canvas assignment');
        }
        get height() { return this.h; }
        set height(value) {
            assert.ok(Number.isFinite(value) && value >= 0 && value <= 8192,
                `Unsafe height reached canvas assignment: ${value}`);
            this.h = Math.trunc(value);
            assert.ok(this.w * this.h <= 32_000_000, 'Unsafe pixel count reached canvas assignment');
        }
        getContext() {
            if (config.noContext) return null;
            const canvas = this;
            return {
                canvas,
                fillRect() {},
                drawImage(source) {
                    if (config.draw) config.draw(source);
                    canvas.drawnSource = source;
                },
                createImageData(width, height) {
                    assert.ok(width * height <= 32_000_000, 'Unsafe image-data allocation');
                    const data = new Uint8ClampedArray(width * height * 4);
                    pixelBuffers.push({ width, height, data });
                    return { data };
                },
                putImageData() {}
            };
        }
        toDataURL(mimeType, quality) {
            encodings.push({ mimeType, quality, width: this.width, height: this.height });
            return config.encode ? config.encode(this, encodings.length) : imageUrl;
        }
    }

    const pdfDoc = {
        async getPage(number) {
            requests.push(number);
            if (config.getPage) await config.getPage(number, requests.length);
            return {
                getViewport({ scale }) {
                    viewports.push({ number, scale });
                    return config.viewport?.(number, scale) ?? { width: 100 * scale, height: 200 * scale };
                },
                render(params) {
                    renders.push({ number, ...params });
                    return { promise: Promise.resolve(config.render?.(number, params, renders.length)) };
                },
                async getOperatorList() {
                    if (config.operators) return config.operators(number);
                    const images = config.images?.(number) ?? [];
                    return { fnArray: images.map(() => 86), argsArray: images.map(value => [value]) };
                },
                objs: {
                    get(name, callback) {
                        const value = config.object?.(number, name);
                        if (callback) callback(value);
                        else return value;
                    }
                },
                cleanup() { throw new Error('Exports must preserve PDF.js page.objs'); }
            };
        }
    };
    // Exercise the browser function bodies actually embedded by the provider,
    // with the helper reconstructed from its compiled, dependency-free source.
    const api = runInNewContext(
        'const exportLimits = (' + createExportLimits.toString() + ')();\n' + exportSource
        + '\n({ extractPagesAsImages, extractEmbeddedImages, acknowledge: id => exportLimits.acknowledge(id) });',
        {
            pdfDoc, totalPages: config.totalPages ?? 1,
            document: { createElement(tag) { assert.equal(tag, 'canvas'); return new Canvas(); } },
            ImageBitmap: FakeImageBitmap,
            VideoFrame: config.withoutVideoFrame ? undefined : FakeVideoFrame,
            vscode: {
                postMessage(message) {
                    if (config.postMessage) config.postMessage(message);
                    messages.push(structuredClone(message));
                    if (config.autoAck !== false && (message.type === 'extractedPages' || message.type === 'extractedImages')) {
                        assert.equal(api.acknowledge(message.extractionId), true, 'The batch must wait for its host acknowledgement before posting');
                    }
                }
            },
            console: { error: (...args) => warnings.push(args), warn: (...args) => warnings.push(args) },
            setTimeout, clearTimeout
        }
    );
    return {
        api, messages, canvases, requests, viewports, renders, encodings, pixelBuffers, warnings,
        results: () => messages.filter(message => message.type === 'extractedPages' || message.type === 'extractedImages'),
        assertReleased() {
            for (const canvas of canvases) {
                assert.equal(canvas.width, 0, 'Temporary canvas width must be released');
                assert.equal(canvas.height, 0, 'Temporary canvas height must be released');
            }
        },
        assertAborted() {
            const errors = messages.filter(message => message.type === 'error');
            assert.equal(errors.length, 1, 'A resource failure reports one operation error');
            assert.match(errors[0].message, /lower resolution or select fewer pages/i);
            assert.equal(this.results().length, 0, 'A resource failure must never send a partial batch to the file writer');
            this.assertReleased();
        }
    };
}

test('export limit factory works when serialized without module bindings', () => {
    const limits = runInNewContext('(' + createExportLimits.toString() + ')()');
    const id = limits.begin();
    assert.ok(typeof id === 'string' && id.length > 0);
    limits.assertDimensions(8000, 4000, 'Page');
    limits.retainDataUrl(imageUrl);
    limits.end(id);
});

test('export dimensions accept ordinary geometry and enforce finite positive per-image bounds', () => {
    const limits = createExportLimits();
    for (const [width, height] of [[1, 1], [8192, 1], [8000, 4000], [100.75, 200.25]]) {
        limits.assertDimensions(width, height, 'Page');
    }
    for (const [width, height] of [
        [8193, 1], [1, 8193], [8001, 4000], [0, 1], [1, 0], [-1, 1],
        [0.5, 1], [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], [-Infinity, 1]
    ]) {
        assert.throws(() => limits.assertDimensions(width, height, 'Page'), error => {
            assert.equal(limits.isResourceLimitError(error), true);
            assert.match(error.message, /lower resolution or select fewer pages/i);
            return true;
        });
    }
    assert.equal(limits.isResourceLimitError(new Error('ordinary rendering error')), false);
});

test('scan scale preserves ordinary pages and bounds only the discarded scan raster', () => {
    const limits = createExportLimits();
    assert.equal(limits.scanScale(100, 200), 1);
    assert.equal(limits.scanScale(8000, 4000), 1);
    for (const [width, height] of [[40_000, 20_000], [100_000, 100], [100, 100_000]]) {
        const scale = limits.scanScale(width, height);
        assert.ok(scale > 0 && scale < 1);
        limits.assertDimensions(width * scale, height * scale, 'Bounded scan');
    }
    for (const [width, height] of [[NaN, 100], [100, Infinity], [0, 100], [100, -1]]) {
        assert.throws(() => limits.scanScale(width, height), /invalid image dimensions/);
    }
});

test('retained encoded image bytes stop at 64 MiB and reset between guarded batches', () => {
    const limits = createExportLimits();
    const halfBatch = dataUrlWithLength(32 * 1024 * 1024);
    const id = limits.begin();
    assert.equal(id, 'extraction-1');
    assert.equal(limits.begin(), undefined);
    limits.retainDataUrl(halfBatch);
    limits.retainDataUrl(halfBatch);
    assert.throws(() => limits.retainDataUrl(imageUrl), /64 MiB/);
    limits.end(id);
    const nextId = limits.begin();
    assert.equal(nextId, 'extraction-2');
    limits.retainDataUrl(halfBatch);
    limits.end(nextId);
    for (const invalid of ['data:,', '', null]) {
        assert.throws(() => limits.retainDataUrl(invalid), /could not be encoded/);
    }
});

test('operation IDs accept only a matching acknowledgement after the batch is handed to the host', () => {
    const limits = createExportLimits();
    const first = limits.begin();
    assert.equal(first, 'extraction-1');
    assert.equal(limits.acknowledge(first), false, 'An early acknowledgement cannot unlock rendering');
    limits.end('some-other-operation');
    assert.equal(limits.begin(), undefined);
    limits.waitForHost(first);
    for (const invalid of [undefined, null, {}, '', 'extraction-0']) {
        assert.equal(limits.acknowledge(invalid), false);
        assert.equal(limits.begin(), undefined);
    }
    assert.equal(limits.acknowledge(first), true);
    assert.equal(limits.acknowledge(first), false, 'Duplicate completion has no effect');

    const second = limits.begin();
    assert.equal(second, 'extraction-2');
    assert.equal(limits.acknowledge(first), false, 'A stale completion cannot unlock the next operation');
    limits.end(first);
    assert.equal(limits.begin(), undefined, 'A stale end cannot clear the next operation');
    limits.waitForHost(second);
    assert.equal(limits.acknowledge(first), false);
    assert.equal(limits.acknowledge(second), true);

    const third = limits.begin();
    limits.end(third); // Rendering failed or was canceled before a batch was sent.
    const fourth = limits.begin();
    assert.equal(fourth, 'extraction-4');
    limits.end(fourth);
});

test('ordinary PNG and JPEG exports preserve page order, scale, quality and canvas geometry', async () => {
    for (const format of ['png', 'jpeg']) {
        const h = createHarness();
        await h.api.extractPagesAsImages([3, 1], 2, format);
        assert.deepEqual(h.requests, [3, 1]);
        assert.deepEqual(h.viewports, [{ number: 3, scale: 3 }, { number: 1, scale: 3 }]);
        assert.deepEqual(h.encodings, Array.from({ length: 2 }, () => ({
            mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality: 0.95, width: 300, height: 600
        })));
        assert.deepEqual(h.results(), [{ type: 'extractedPages', extractionId: 'extraction-1', format,
            pages: [{ page: 3, data: imageUrl }, { page: 1, data: imageUrl }] }]);
        h.assertReleased();
    }
});

test('unsafe screenshot geometry aborts before canvas allocation and emits no batch', async () => {
    for (const [width, height] of [[8193, 1], [1, 8193], [8001, 4000], [NaN, 100], [100, Infinity], [0, 100]]) {
        const h = createHarness({ viewport: () => ({ width, height }) });
        await h.api.extractPagesAsImages([1, 2], 1, 'png');
        h.assertAborted();
        assert.deepEqual(h.requests, [1]);
        assert.equal(h.canvases.length, 0, 'Validate both dimensions before creating the canvas');
    }
});

test('a later screenshot resource failure discards earlier pages and permits a retry', async () => {
    let bad = true;
    const h = createHarness({ viewport: number => ({ width: bad && number === 2 ? 100_000 : 100, height: 100 }) });
    await h.api.extractPagesAsImages([1, 2, 3], 1, 'png');
    h.assertAborted();
    assert.deepEqual(h.requests, [1, 2]);
    bad = false;
    await h.api.extractPagesAsImages([1], 1, 'png');
    assert.equal(h.results().length, 1);
    h.assertReleased();
});

test('oversized screenshot batches are rejected before any batch is sent', async () => {
    const encoded = dataUrlWithLength(32 * 1024 * 1024 + 1);
    const h = createHarness({ encode: () => encoded });
    await h.api.extractPagesAsImages([1, 2, 3], 1, 'png');
    h.assertAborted();
    assert.deepEqual(h.requests, [1, 2]);
    assert.equal(h.encodings.length, 2);
});

test('failed image encoding aborts the complete screenshot batch and releases its canvas', async () => {
    const h = createHarness({ encode: () => 'data:,' });
    await h.api.extractPagesAsImages([1, 2], 1, 'png');
    h.assertAborted();
    assert.deepEqual(h.requests, [1]);
    assert.equal(h.canvases.length, 1);
});

test('ordinary screenshot render and encoding errors still skip bad pages and release their canvases', async () => {
    for (const failure of ['render', 'encode']) {
        const h = createHarness({
            render(number) { if (failure === 'render' && number === 1) throw new Error('bad rendering'); },
            encode(canvas, call) { if (failure === 'encode' && call === 1) throw new Error('bad encoding'); return imageUrl; }
        });
        await h.api.extractPagesAsImages([1, 2], 1, 'png');
        assert.deepEqual(h.results()[0].pages, [{ page: 2, data: imageUrl }]);
        assert.equal(h.messages.filter(message => message.type === 'error').length, 0);
        h.assertReleased();
    }
});

test('native embedded image paths retain native dimensions, raw colors and XObject deduplication', async () => {
    const bitmap = new FakeImageBitmap(24, 12);
    const wrapped = { width: 999, height: 999, bitmap: new FakeImageBitmap(25, 13) };
    const raw = { width: 12, height: 11, data: new Uint8Array(12 * 11 * 3).fill(77) };
    const legacy = { width: 26, height: 14, src: 'data:image/jpeg;base64,bGVnYWN5' };
    const h = createHarness({
        operators: () => ({ fnArray: [85, 85, 86, 86, 86], argsArray: [['photo'], ['photo'], [wrapped], [raw], [legacy]] }),
        object: () => bitmap
    });
    await h.api.extractEmbeddedImages();
    const [result] = h.results();
    assert.equal(result.totalFound, 4);
    assert.deepEqual(result.images.map(({ index, page, width, height }) => ({ index, page, width, height })), [
        { index: 1, page: 1, width: 24, height: 12 },
        { index: 2, page: 1, width: 25, height: 13 },
        { index: 3, page: 1, width: 12, height: 11 },
        { index: 4, page: 1, width: 26, height: 14 }
    ]);
    assert.equal(result.images[3].data, legacy.src);
    assert.deepEqual(h.viewports, [{ number: 1, scale: 1 }]);
    assert.deepEqual(h.encodings.map(({ width, height }) => [width, height]), [[24, 12], [25, 13], [12, 11]]);
    assert.deepEqual(Array.from(h.pixelBuffers[0].data.subarray(0, 4)), [77, 77, 77, 255]);
    h.assertReleased();
});

test('large poster pages use a bounded scan canvas while extracted bitmaps keep native dimensions', async () => {
    const bitmap = new FakeImageBitmap(120, 80);
    const h = createHarness({
        viewport: (number, scale) => ({ width: 40_000 * scale, height: 20_000 * scale }),
        images: () => [bitmap]
    });
    await h.api.extractEmbeddedImages();
    assert.equal(h.renders.length, 1);
    const scan = h.renders[0].viewport;
    assert.ok(scan.width <= 8192 && scan.height <= 8192 && scan.width * scan.height <= 32_000_000);
    assert.equal(h.viewports[0].scale, 1);
    assert.ok(h.viewports[1].scale > 0 && h.viewports[1].scale < 1);
    const [image] = h.results()[0].images;
    assert.deepEqual({ width: image.width, height: image.height }, { width: 120, height: 80 });
    assert.deepEqual(h.encodings.map(({ width, height }) => [width, height]), [[120, 80]]);
    h.assertReleased();
});

test('native JPEG VideoFrames export direct and wrapped display dimensions without consuming PDF.js frames', async () => {
    const direct = new FakeVideoFrame(28, 16);
    const wrapped = new FakeVideoFrame(30, 18);
    const h = createHarness({
        operators: () => ({ fnArray: [85, 86, 88], argsArray: [['jpeg'], [{ width: 999, height: 999, bitmap: wrapped }], ['jpeg']] }),
        object: () => direct,
        draw(source) { assert.equal(source.closed, false, 'PDF.js-owned frames must remain reusable'); }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        await h.api.extractEmbeddedImages();
        const result = h.results()[attempt];
        assert.equal(result.totalFound, 2, 'Both ImageDecoder forms must be extracted, with repeated XObjects deduplicated');
        assert.deepEqual(result.images.map(({ width, height }) => [width, height]), [[28, 16], [30, 18]]);
        assert.equal(direct.closed, false);
        assert.equal(wrapped.closed, false);
        h.assertReleased();
    }
    assert.deepEqual(h.encodings.map(({ width, height }) => [width, height]), [[28, 16], [30, 18], [28, 16], [30, 18]]);
    assert.equal(h.warnings.length, 0);
    const failing = createHarness({ images: () => [direct], draw() { throw new Error('Image drawing failed'); } });
    await failing.api.extractEmbeddedImages();
    assert.equal(failing.results()[0].totalFound, 0);
    assert.equal(failing.warnings.length, 1);
    assert.equal(direct.closed, false, 'A failed export must not close a PDF.js-owned frame');
    failing.assertReleased();
});

test('ImageBitmap and raw extraction remain available when VideoFrame is not exposed', async () => {
    const bitmap = new FakeImageBitmap(24, 12);
    const raw = { width: 12, height: 11, data: new Uint8Array(12 * 11 * 3).fill(77) };
    const h = createHarness({ withoutVideoFrame: true, images: () => [bitmap, raw] });
    await h.api.extractEmbeddedImages();
    assert.equal(h.results()[0].totalFound, 2);
    assert.deepEqual(h.encodings.map(({ width, height }) => [width, height]), [[24, 12], [12, 11]]);
    assert.equal(h.warnings.length, 0);
    h.assertReleased();
});

test('invalid embedded scan geometry aborts before allocating a scan canvas', async () => {
    for (const [width, height] of [[Infinity, 100], [100, NaN], [0, 100], [100, -1]]) {
        const h = createHarness({ totalPages: 3, viewport: () => ({ width, height }) });
        await h.api.extractEmbeddedImages();
        h.assertAborted();
        assert.deepEqual(h.requests, [1]);
        assert.equal(h.canvases.length, 0);
    }
});

test('oversized and invalid native images abort both inline and XObject extraction', async () => {
    for (const image of [
        new FakeImageBitmap(8193, 20),
        { bitmap: new FakeImageBitmap(20, 8193) },
        new FakeVideoFrame(8193, 20),
        { bitmap: new FakeVideoFrame(20, 8193) },
        { width: 20, height: 20, bitmap: new FakeVideoFrame(8001, 4000) },
        new FakeVideoFrame(Infinity, 20),
        new FakeVideoFrame(NaN, 20),
        new FakeVideoFrame(0, 20),
        { width: 8001, height: 4000, data: [] },
        { width: 20, height: Infinity, data: [] },
        { width: NaN, height: 20, src: imageUrl },
        { width: 8193, height: 20, src: imageUrl }
    ]) {
        for (const kind of ['inline', 'xobject']) {
            const h = createHarness({
                totalPages: 2,
                operators: () => kind === 'inline'
                    ? { fnArray: [86], argsArray: [[image]] }
                    : { fnArray: [85], argsArray: [['bad-image']] },
                object: () => image
            });
            await h.api.extractEmbeddedImages();
            h.assertAborted();
            assert.deepEqual(h.requests, [1]);
            assert.equal(h.canvases.length, 1, 'Only the bounded scan canvas is created');
            assert.equal(h.pixelBuffers.length, 0);
            const frame = image instanceof FakeVideoFrame ? image : image.bitmap;
            if (frame instanceof FakeVideoFrame) assert.equal(frame.closed, false, 'A resource rejection must not consume a frame');
        }
    }
});

test('an embedded batch limit discards previously collected images without later page scans', async () => {
    const src = dataUrlWithLength(32 * 1024 * 1024 + 1);
    const h = createHarness({ totalPages: 3, images: () => [{ width: 12, height: 11, src }] });
    await h.api.extractEmbeddedImages();
    h.assertAborted();
    assert.deepEqual(h.requests, [1, 2]);
});

test('embedded scan, draw and encoding failures release canvases and preserve skip behavior', async () => {
    for (const failure of ['render', 'draw', 'encode']) {
        let draws = 0;
        const h = createHarness({
            totalPages: 2,
            images: () => [new FakeImageBitmap(12, 11)],
            render(number) { if (failure === 'render' && number === 1) throw new Error('bad scan'); },
            draw() { if (failure === 'draw' && ++draws === 1) throw new Error('bad image source'); },
            encode(canvas, call) { if (failure === 'encode' && call === 1) throw new Error('bad image encode'); return imageUrl; }
        });
        await h.api.extractEmbeddedImages();
        assert.equal(h.results()[0].totalFound, 1);
        assert.equal(h.results()[0].images[0].page, 2);
        assert.equal(h.messages.filter(message => message.type === 'error').length, 0);
        h.assertReleased();
    }
});

test('one shared guard prevents overlapping screenshot and embedded batches and releases on completion', async () => {
    let release;
    const pendingRender = new Promise(resolve => { release = resolve; });
    const h = createHarness({ render: (number, params, call) => call === 1 ? pendingRender : undefined });
    const first = h.api.extractPagesAsImages([1], 1, 'png');
    await nextTurn();
    await Promise.all([
        h.api.extractPagesAsImages([2], 1, 'png'),
        h.api.extractEmbeddedImages(),
        h.api.extractEmbeddedImages()
    ]);
    assert.deepEqual(h.requests, [1]);
    assert.equal(h.results().length, 0);
    release();
    await first;
    await h.api.extractEmbeddedImages();
    assert.equal(h.results().length, 2);
    assert.deepEqual(h.requests, [1, 1]);
    h.assertReleased();
});

test('the shared browser guard stays busy after rendering until the host acknowledges the matching batch', async () => {
    for (const firstKind of ['screenshots', 'embedded']) {
        const h = createHarness({ autoAck: false, images: () => [new FakeImageBitmap(12, 11)] });
        if (firstKind === 'screenshots') await h.api.extractPagesAsImages([1], 1, 'png');
        else await h.api.extractEmbeddedImages();
        const firstId = h.results()[0].extractionId;
        assert.equal(typeof firstId, 'string');
        h.assertReleased();

        // Saving may be waiting on an overwrite prompt or filesystem write even
        // though the browser has finished all rendering and released canvases.
        for (const invalid of [undefined, 'extraction-0', { extractionId: firstId }]) {
            assert.equal(h.api.acknowledge(invalid), false);
        }
        await h.api.extractPagesAsImages([2], 1, 'jpeg');
        await h.api.extractEmbeddedImages();
        assert.deepEqual(h.requests, [1]);
        assert.equal(h.results().length, 1);

        assert.equal(h.api.acknowledge(firstId), true);
        assert.equal(h.api.acknowledge(firstId), false);
        await h.api.extractEmbeddedImages();
        const secondId = h.results()[1].extractionId;
        assert.notEqual(secondId, firstId);
        assert.equal(h.api.acknowledge(firstId), false);
        await h.api.extractPagesAsImages([2], 1, 'png');
        assert.deepEqual(h.requests, [1, 1]);
        assert.equal(h.results().length, 2);

        assert.equal(h.api.acknowledge(secondId), true);
        await h.api.extractPagesAsImages([1], 1, 'png');
        assert.equal(h.results().length, 3);
        assert.equal(h.api.acknowledge(h.results()[2].extractionId), true);
        h.assertReleased();
    }
});

test('a failed host handoff releases the operation guard for a retry', async () => {
    let failed = false;
    const h = createHarness({
        postMessage(message) {
            if (!failed && message.type === 'extractedPages') {
                failed = true;
                throw new Error('Host handoff failed');
            }
        }
    });
    await h.api.extractPagesAsImages([1], 1, 'png');
    assert.equal(h.results().length, 0);
    assert.match(h.messages.find(message => message.type === 'error').message, /Host handoff failed/);
    await h.api.extractPagesAsImages([1], 1, 'png');
    assert.equal(h.results().length, 1);
    h.assertReleased();
});

test('the shared guard resets after embedded limit failure so screenshots can run', async () => {
    const h = createHarness({ images: () => [new FakeImageBitmap(8193, 12)] });
    await h.api.extractEmbeddedImages();
    h.assertAborted();
    await h.api.extractPagesAsImages([1], 1, 'png');
    assert.equal(h.results()[0].type, 'extractedPages');
    h.assertReleased();
});
