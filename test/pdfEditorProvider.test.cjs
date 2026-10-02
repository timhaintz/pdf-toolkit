const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');

function createHarness(settings = {}, behavior = {}) {
    const errors = [];
    const information = [];
    const warnings = [];
    const state = new Map();
    const writes = new Map();
    const directories = [];
    const operations = [];
    const makeUri = fsPath => ({ fsPath, toString: () => `webview:${fsPath}` });
    const vscode = {
        FileType: { File: 1, Directory: 2 },
        Uri: {
            file: makeUri,
            joinPath: (base, ...segments) => makeUri(path.join(base.fsPath, ...segments))
        },
        workspace: {
            workspaceFolders: [{ uri: makeUri('/workspace') }],
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
            fs: {
                createDirectory: async uri => { directories.push(uri.fsPath); },
                stat: async uri => {
                    if (!writes.has(uri.fsPath)) throw new Error('File not found');
                    return {};
                },
                readDirectory: async uri => Array.from(writes.keys())
                    .filter(filename => path.dirname(filename) === uri.fsPath)
                    .map(filename => [path.basename(filename), vscode.FileType.File]),
                writeFile: async (uri, data) => {
                    if (behavior.beforeWrite) await behavior.beforeWrite(uri.fsPath, data);
                    if (behavior.writeFailure) throw behavior.writeFailure;
                    writes.set(uri.fsPath, data);
                    operations.push({ type: 'write', path: uri.fsPath });
                }
            }
        },
        window: {
            showErrorMessage: message => errors.push(message),
            showInformationMessage: async message => { information.push(message); return behavior.informationResult; },
            showWarningMessage: async (message, ...choices) => {
                warnings.push({ message, choices });
                return behavior.warningChoice;
            }
        }
    };
    const context = {
        extensionUri: makeUri('/extension'),
        subscriptions: [],
        workspaceState: {
            get: (key, fallback) => state.get(key) ?? fallback,
            update: async (key, value) => {
                if (behavior.beforeStateUpdate) await behavior.beforeStateUpdate(key, value);
                state.set(key, value);
                operations.push({ type: 'state', key });
            }
        }
    };

    // Load the compiled extension with a per-module VS Code adapter. No live
    // editor, filesystem writes, or Copilot connection are needed by these tests.
    const filename = path.resolve(__dirname, '../out/pdfEditorProvider.js');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const load = compileFunction(readFileSync(filename, 'utf8'),
        ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
    load(module.exports, name => name === 'vscode' ? vscode : realRequire(name),
        module, filename, path.dirname(filename));
    const provider = new module.exports.PdfEditorProvider(context);

    async function openPdf(filename = 'example.pdf') {
        let onMessage;
        let onFocus;
        let onDispose;
        const messages = [];
        const panel = {
            active: true,
            webview: {
                cspSource: 'https://webview.example',
                asWebviewUri: uri => uri,
                postMessage: message => {
                    messages.push(message);
                    operations.push({ type: 'message', message });
                    return Promise.resolve(behavior.postMessageResult ?? true);
                },
                onDidReceiveMessage: listener => { onMessage = listener; }
            },
            onDidChangeViewState: listener => { onFocus = listener; },
            onDidDispose: listener => { onDispose = listener; }
        };
        const uri = makeUri(path.join('/documents', filename));
        const document = await provider.openCustomDocument(uri, {}, {});
        assert.equal(document.uri, uri);
        await provider.resolveCustomEditor(document, panel, {});
        return {
            panel,
            messages,
            receive: message => onMessage(message),
            focus: () => onFocus(),
            dispose: () => {
                if (behavior.disposeWebviewGetterThrows) {
                    Object.defineProperty(panel, 'webview', {
                        get: () => { throw new Error('The webview has been disposed.'); }
                    });
                }
                return onDispose();
            }
        };
    }

    return { provider, openPdf, errors, information, warnings, writes, directories, operations, state };
}

test('page ranges are sorted, deduplicated, and limited to the document', () => {
    const { provider } = createHarness();
    assert.deepEqual(provider.parsePageRange('5, 1-3, 2, 4-9, 0, 12', 6), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(provider.parsePageRange('0-3', 2), [1, 2]);
    assert.deepEqual(provider.parsePageRange('oops, 4-2, 0, 9', 5), []);
    assert.deepEqual(provider.parsePageRange('', 0), []);
});

test('extraction uses the focused PDF and preserves each panel state', async () => {
    const { provider, openPdf } = createHarness({ extractionQuality: 3, extractionFormat: 'jpeg' });
    const first = await openPdf('first.pdf');
    await first.receive({ type: 'pageCount', count: 3 });
    await first.receive({ type: 'currentPage', page: 2 });
    const second = await openPdf('second.pdf');
    await second.receive({ type: 'pageCount', count: 5 });
    await second.receive({ type: 'currentPage', page: 4 });

    await provider.extractPages('current');
    assert.deepEqual(second.messages.at(-1), {
        type: 'extractPages', pages: [4], quality: 3, format: 'jpeg'
    });
    assert.equal(first.messages.length, 0);

    first.focus();
    await provider.extractPages('all');
    assert.deepEqual(first.messages.at(-1).pages, [1, 2, 3]);
    await provider.extractPages('selected', '3, 1-2, 99');
    assert.deepEqual(first.messages.at(-1).pages, [1, 2, 3]);
});

test('custom extraction keeps its requested format and quality', async () => {
    const { provider, openPdf, errors } = createHarness();
    const pdf = await openPdf();
    await pdf.receive({ type: 'pageCount', count: 4 });
    await provider.extractPagesCustom('all', 4, 'jpeg');
    assert.deepEqual(pdf.messages.at(-1), {
        type: 'extractPages', pages: [1, 2, 3, 4], quality: 4, format: 'jpeg'
    });
    await provider.extractPagesCustom('99', 2, 'png');
    assert.equal(pdf.messages.length, 1);
    assert.equal(errors.at(-1), 'No valid pages selected');
});

test('zoom is bounded and routed only to the active PDF', async () => {
    const { provider, openPdf } = createHarness();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');
    for (let i = 0; i < 30; i++) provider.zoomIn();
    assert.deepEqual(second.messages.at(-1), { type: 'zoom', scale: 5 });
    for (let i = 0; i < 30; i++) provider.zoomOut();
    assert.deepEqual(second.messages.at(-1), { type: 'zoom', scale: 0.25 });
    assert.equal(first.messages.length, 0);
    first.focus();
    provider.zoomIn();
    assert.deepEqual(first.messages.at(-1), { type: 'zoom', scale: 1.25 });
    provider.resetZoom();
    assert.deepEqual(first.messages.at(-1), { type: 'zoom', scale: 1 });
});

test('closing the active PDF rejects extraction until another PDF is focused', async () => {
    const { provider, openPdf, errors } = createHarness();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');
    await first.receive({ type: 'pageCount', count: 2 });
    second.dispose();
    await provider.extractPages('all');
    assert.equal(errors.at(-1), 'No PDF is currently open');
    assert.equal(first.messages.length, 0);
    first.focus();
    await provider.extractPages('all');
    assert.deepEqual(first.messages.at(-1).pages, [1, 2]);
});

test('extracted pages are decoded to the workspace and tracked in history', async () => {
    const { provider, openPdf, writes } = createHarness({ screenshotsFolder: 'Screenshots' });
    const pdf = await openPdf('report.pdf');
    await pdf.receive({
        type: 'extractedPages',
        format: 'png',
        pages: [{ page: 2, data: `data:image/png;base64,${Buffer.from('image bytes').toString('base64')}` }]
    });
    assert.equal(writes.get('/workspace/Screenshots/report/page_002.png').toString(), 'image bytes');
    const history = provider.getExtractedPdfs();
    assert.equal(history.length, 1);
    assert.equal(history[0].name, 'report');
    assert.equal(history[0].path, '/workspace/Screenshots/report');
    assert.equal(history[0].pageCount, 1);
    await provider.removeExtractedPdf('report');
    assert.deepEqual(provider.getExtractedPdfs(), []);
});

test('webview loads local PDF.js assets and authorizes its script with a CSP nonce', async () => {
    const { openPdf } = createHarness();
    const { panel } = await openPdf('report.pdf');
    const html = panel.webview.html;
    const nonce = html.match(/<script nonce="([A-Za-z0-9]+)" type="module">/)[1];
    assert.equal(nonce.length, 32);
    assert.ok(html.includes(`script-src 'nonce-${nonce}' 'wasm-unsafe-eval' blob:`));
    assert.ok(!html.includes("'unsafe-eval'"), 'JavaScript evaluation remains disabled');
    assert.ok(html.includes("import * as pdfjsLib from 'webview:/extension/node_modules/pdfjs-dist/build/pdf.min.mjs'"));
    assert.ok(html.includes("workerSrc = 'webview:/extension/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'"));
    assert.ok(html.includes("getDocument({ url: pdfUrl, wasmUrl: 'webview:/extension/node_modules/pdfjs-dist/wasm/' })"));
    assert.ok(html.includes("const pdfUrl = 'webview:/documents/report.pdf'"));
    assert.equal(panel.webview.options.enableScripts, true);
    assert.ok(panel.webview.options.localResourceRoots.some(uri => uri.fsPath === '/extension/node_modules/pdfjs-dist'));
});

const compositeOptions = overrides => ({
    layout: 'vertical', quality: 2, pagesPerImage: 2, labels: true, padding: 12,
    ...overrides
});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// The host checks the PNG envelope and dimensions. These transport fixtures
// deliberately stop at IHDR; the native integration suite verifies real PNGs.
function fakePNG(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

async function compositePrepare(pdf) {
    await nextTurn();
    const message = pdf.messages.findLast(message => message.type === 'prepareComposite');
    assert.ok(message, 'The export should send a prepareComposite request.');
    return message;
}

async function compositePlan(pdf, requestId, groups) {
    await pdf.receive({ type: 'compositePlan', requestId, groups });
}

async function compositeImage(pdf, requestId, index, width, height) {
    await pdf.receive({ type: 'compositeImage', requestId, index, data: fakePNG(width, height) });
}

test('composite export keeps the source captured before the active PDF changes', async () => {
    const { provider, openPdf, writes } = createHarness();
    const first = await openPdf('first.pdf');
    await first.receive({ type: 'pageCount', count: 3 });
    await first.receive({ type: 'currentPage', page: 2 });
    const source = await provider.getCompositeSource();
    assert.equal(source.panel, first.panel);
    assert.equal(source.currentPage, 2);
    const second = await openPdf('second.pdf');
    await second.receive({ type: 'pageCount', count: 5 });

    const pending = provider.extractComposite('2', compositeOptions(), source.panel);
    const prepare = await compositePrepare(first);
    assert.deepEqual(prepare.pages, [2]);
    assert.equal(second.messages.length, 0);
    await compositePlan(first, prepare.requestId, [{ width: 100, height: 200, pages: [2] }]);
    // Even a valid result from another PDF panel must not complete this export.
    await compositeImage(second, prepare.requestId, 0, 100, 200);
    assert.equal(writes.size, 0);
    await compositeImage(first, prepare.requestId, 0, 100, 200);
    assert.deepEqual(await pending, [
        '/workspace/PDF-Screenshots/first-composites/composite_vertical_pages_002_144dpi_labels.png'
    ]);
});

test('composite output names describe settings, use a sibling folder, and resolve after writes and history', async () => {
    const write = deferred();
    const history = deferred();
    const { provider, openPdf, writes, directories, information } = createHarness({ screenshotsFolder: 'Screenshots' }, {
        beforeWrite: () => write.promise,
        beforeStateUpdate: () => history.promise,
        informationResult: new Promise(() => {})
    });
    const ordinaryPath = '/workspace/Screenshots/report/page_001.png';
    writes.set(ordinaryPath, Buffer.from('ordinary screenshot'));
    const pdf = await openPdf('report.pdf');
    await pdf.receive({ type: 'pageCount', count: 3 });
    const opts = compositeOptions({ layout: 'grid', quality: 3, padding: 0 });
    const pending = provider.extractComposite('1,3', opts);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    const prepare = await compositePrepare(pdf);
    assert.deepEqual(prepare.options, opts);
    await compositePlan(pdf, prepare.requestId, [{ width: 200, height: 200, pages: [1, 3] }]);
    const receiving = compositeImage(pdf, prepare.requestId, 0, 200, 200);
    await nextTurn();
    const outputPath = '/workspace/Screenshots/report-composites/composite_grid_pages_001-003_216dpi_labels_pad0.png';
    assert.equal(settled, false);
    assert.equal(writes.has(outputPath), false);
    write.resolve();
    await nextTurn();
    assert.equal(writes.has(outputPath), true);
    assert.equal(settled, false);
    assert.deepEqual(provider.getExtractedPdfs(), []);
    history.resolve();
    await receiving;
    assert.deepEqual(await pending, [outputPath]);
    assert.equal(writes.get(ordinaryPath).toString(), 'ordinary screenshot');
    assert.deepEqual(directories, ['/workspace/Screenshots/report-composites']);
    const [entry] = provider.getExtractedPdfs();
    assert.equal(entry.name, 'report-composites');
    assert.equal(entry.path, '/workspace/Screenshots/report-composites');
    assert.equal(entry.pageCount, 1);
    assert.match(entry.extractedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(information.at(-1), /Saved 1 composite image/);
});

test('multiple composite groups render only after the preceding image and history are saved', async () => {
    const { provider, openPdf, operations } = createHarness();
    const pdf = await openPdf('report.pdf');
    await pdf.receive({ type: 'pageCount', count: 3 });
    const pending = provider.extractComposite('all', compositeOptions({ labels: false }));
    const { requestId } = await compositePrepare(pdf);
    await compositePlan(pdf, requestId, [
        { width: 100, height: 400, pages: [1, 2] },
        { width: 100, height: 200, pages: [3] }
    ]);
    assert.deepEqual(pdf.messages.filter(message => message.type === 'compositeRender').map(message => message.index), [0]);
    operations.length = 0;
    await compositeImage(pdf, requestId, 0, 100, 400);
    assert.deepEqual(operations.map(operation => operation.type), ['write', 'state', 'message']);
    assert.equal(operations[2].message.type, 'compositeRender');
    assert.equal(operations[2].message.index, 1);
    assert.equal(provider.getExtractedPdfs()[0].pageCount, 1);
    await compositeImage(pdf, requestId, 1, 100, 200);
    assert.deepEqual(await pending, [
        '/workspace/PDF-Screenshots/report-composites/composite_vertical_pages_001-002_144dpi.png',
        '/workspace/PDF-Screenshots/report-composites/composite_vertical_pages_003_144dpi.png'
    ]);
    assert.equal(provider.getExtractedPdfs()[0].pageCount, 2);
    assert.equal(pdf.messages.at(-1).type, 'compositeCancel');
});

test('composite history counts images already in its output folder', async () => {
    const { provider, openPdf, writes } = createHarness();
    writes.set('/workspace/PDF-Screenshots/report-composites/earlier.PNG', Buffer.from('old image'));
    writes.set('/workspace/PDF-Screenshots/report-composites/notes.txt', Buffer.from('notes'));
    const pdf = await openPdf('report.pdf');
    await pdf.receive({ type: 'pageCount', count: 1 });
    const pending = provider.extractComposite('all', compositeOptions());
    const { requestId } = await compositePrepare(pdf);
    await compositePlan(pdf, requestId, [{ width: 100, height: 200, pages: [1] }]);
    await compositeImage(pdf, requestId, 0, 100, 200);
    await pending;
    assert.equal(provider.getExtractedPdfs()[0].pageCount, 2);
});

test('composite PNG responses must use PNG data and match planned image dimensions', async t => {
    const invalid = [
        ['wrong media type', 'data:image/jpeg;base64,AAAA', /Invalid composite PNG/],
        ['invalid PNG signature', 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', /could not be encoded/],
        ['truncated PNG', 'data:image/png;base64,iVBORw0KGgo=', /could not be encoded/],
        ['mismatched dimensions', fakePNG(101, 200), /could not be encoded/]
    ];
    for (const [name, data, expected] of invalid) {
        await t.test(name, async () => {
            const { provider, openPdf, writes } = createHarness();
            const pdf = await openPdf();
            await pdf.receive({ type: 'pageCount', count: 1 });
            const pending = provider.extractComposite('all', compositeOptions());
            const rejected = assert.rejects(pending, expected);
            const { requestId } = await compositePrepare(pdf);
            await compositePlan(pdf, requestId, [{ width: 100, height: 200, pages: [1] }]);
            await pdf.receive({ type: 'compositeImage', requestId, index: 0, data });
            await rejected;
            assert.equal(writes.size, 0);
            assert.deepEqual(provider.getExtractedPdfs(), []);
            assert.equal(pdf.messages.at(-1).type, 'compositeCancel');
        });
    }
});

test('composite plans must contain every selected page in order within canvas limits', async t => {
    const invalid = [
        ['missing selected page', [{ width: 100, height: 200, pages: [1] }], /selected pages/],
        ['reordered selected pages', [{ width: 100, height: 200, pages: [2, 1] }], /selected pages/],
        ['duplicate selected page', [{ width: 100, height: 200, pages: [1, 1] }], /selected pages/],
        ['too many pages in group', [{ width: 100, height: 200, pages: [1, 2, 3] }], /dimensions or pages/],
        ['dimension too large', [{ width: 8193, height: 200, pages: [1, 2] }], /dimensions or pages/],
        ['area too large', [{ width: 6000, height: 6000, pages: [1, 2] }], /dimensions or pages/],
        ['fractional canvas size', [{ width: 100.5, height: 200, pages: [1, 2] }], /dimensions or pages/],
        ['empty layout', [], /layout response/]
    ];
    for (const [name, groups, expected] of invalid) {
        await t.test(name, async () => {
            const { provider, openPdf, writes } = createHarness();
            const pdf = await openPdf();
            await pdf.receive({ type: 'pageCount', count: 2 });
            const pending = provider.extractComposite('all', compositeOptions());
            const rejected = assert.rejects(pending, expected);
            const { requestId } = await compositePrepare(pdf);
            await compositePlan(pdf, requestId, groups);
            await rejected;
            assert.equal(writes.size, 0);
            assert.equal(pdf.messages.some(message => message.type === 'compositeRender'), false);
        });
    }
});

test('two PDF panels cannot export concurrently into the same composite folder', async () => {
    const { provider, openPdf } = createHarness();
    const first = await openPdf('one/report.pdf');
    await first.receive({ type: 'pageCount', count: 1 });
    const second = await openPdf('two/report.pdf');
    await second.receive({ type: 'pageCount', count: 1 });
    const pending = provider.extractComposite('all', compositeOptions(), first.panel);
    const rejected = assert.rejects(pending, /PDF was closed/);
    await compositePrepare(first);
    await assert.rejects(provider.extractComposite('all', compositeOptions(), second.panel), /already running/);
    assert.equal(second.messages.length, 0);
    first.dispose();
    await rejected;

    // Disposing the previous source must release its directory lock.
    const retry = provider.extractComposite('all', compositeOptions(), second.panel);
    const { requestId } = await compositePrepare(second);
    await compositePlan(second, requestId, [{ width: 100, height: 200, pages: [1] }]);
    await compositeImage(second, requestId, 0, 100, 200);
    assert.equal((await retry).length, 1);
});

test('closing a PDF rejects its pending composite export and ignores stale results', async () => {
    const { provider, openPdf, writes } = createHarness({}, { disposeWebviewGetterThrows: true });
    const pdf = await openPdf();
    await pdf.receive({ type: 'pageCount', count: 1 });
    const pending = provider.extractComposite('all', compositeOptions());
    const rejected = assert.rejects(pending, /PDF was closed during export/);
    const { requestId } = await compositePrepare(pdf);
    await compositePlan(pdf, requestId, [{ width: 100, height: 200, pages: [1] }]);
    pdf.dispose();
    await rejected;
    await compositeImage(pdf, requestId, 0, 100, 200);
    await compositePlan(pdf, requestId, [{ width: 100, height: 200, pages: [1] }]);
    assert.equal(writes.size, 0);
    assert.deepEqual(provider.getExtractedPdfs(), []);
    assert.equal(pdf.messages.filter(message => message.type === 'compositeRender').length, 1);
});

test('cancelling or dismissing the overwrite prompt quietly preserves files and allows retry', async t => {
    for (const choice of ['Cancel', undefined]) {
        await t.test(choice ?? 'dismiss', async () => {
            const behavior = { warningChoice: choice };
            const { provider, openPdf, writes, warnings, errors, information } = createHarness({}, behavior);
            const filename = '/workspace/PDF-Screenshots/report-composites/composite_vertical_pages_001_144dpi_labels.png';
            writes.set(filename, Buffer.from('existing image'));
            const pdf = await openPdf('report.pdf');
            await pdf.receive({ type: 'pageCount', count: 1 });
            const pending = provider.extractComposite('all', compositeOptions());
            const { requestId } = await compositePrepare(pdf);
            await compositePlan(pdf, requestId, [{ width: 100, height: 200, pages: [1] }]);
            assert.deepEqual(await pending, []);
            await compositeImage(pdf, requestId, 0, 100, 200);
            assert.equal(writes.get(filename).toString(), 'existing image');
            assert.deepEqual(warnings, [{
                message: '1 composite image(s) already exist.',
                choices: ['Save New Only', 'Overwrite All', 'Cancel']
            }]);
            assert.equal(pdf.messages.some(message => message.type === 'compositeRender'), false);
            assert.equal(pdf.messages.at(-1).type, 'compositeCancel');
            assert.deepEqual(provider.getExtractedPdfs(), []);
            assert.deepEqual(errors, []);
            assert.deepEqual(information, []);

            behavior.warningChoice = 'Overwrite All';
            const retry = provider.extractComposite('all', compositeOptions());
            const preparedRetry = await compositePrepare(pdf);
            assert.notEqual(preparedRetry.requestId, requestId);
            await compositePlan(pdf, preparedRetry.requestId, [{ width: 100, height: 200, pages: [1] }]);
            await compositeImage(pdf, preparedRetry.requestId, 0, 100, 200);
            assert.deepEqual(await retry, [filename]);
            assert.equal(writes.get(filename).readUInt32BE(16), 100);
        });
    }
});

test('a later render failure reports the count and location of images already saved', async () => {
    const { provider, openPdf, writes } = createHarness();
    const pdf = await openPdf('report.pdf');
    await pdf.receive({ type: 'pageCount', count: 3 });
    const pending = provider.extractComposite('all', compositeOptions());
    const rejected = assert.rejects(pending, error => {
        assert.match(error.message, /Rendering page 3 failed/);
        assert.match(error.message, /1 image\(s\) were already saved to \/workspace\/PDF-Screenshots\/report-composites/);
        return true;
    });
    const { requestId } = await compositePrepare(pdf);
    await compositePlan(pdf, requestId, [
        { width: 100, height: 400, pages: [1, 2] },
        { width: 100, height: 200, pages: [3] }
    ]);
    await compositeImage(pdf, requestId, 0, 100, 400);
    await pdf.receive({ type: 'compositeError', requestId, message: 'Rendering page 3 failed.' });
    await rejected;
    assert.equal(writes.size, 1);
    assert.equal(provider.getExtractedPdfs()[0].pageCount, 1);
});

test('filesystem write failures reject composite exports and release the directory for retry', async () => {
    const behavior = { writeFailure: new Error('Disk full') };
    const { provider, openPdf, writes } = createHarness({}, behavior);
    const pdf = await openPdf();
    await pdf.receive({ type: 'pageCount', count: 1 });
    const pending = provider.extractComposite('all', compositeOptions());
    const rejected = assert.rejects(pending, /^Error: Disk full$/);
    const { requestId } = await compositePrepare(pdf);
    await compositePlan(pdf, requestId, [{ width: 100, height: 200, pages: [1] }]);
    await compositeImage(pdf, requestId, 0, 100, 200);
    await rejected;
    assert.equal(writes.size, 0);
    assert.deepEqual(provider.getExtractedPdfs(), []);

    behavior.writeFailure = undefined;
    const retry = provider.extractComposite('all', compositeOptions());
    const preparedRetry = await compositePrepare(pdf);
    assert.notEqual(preparedRetry.requestId, requestId);
    await compositePlan(pdf, preparedRetry.requestId, [{ width: 100, height: 200, pages: [1] }]);
    await compositeImage(pdf, preparedRetry.requestId, 0, 100, 200);
    assert.equal((await retry).length, 1);
});

test('a webview that cannot receive messages rejects its composite export promptly', async () => {
    const { provider, openPdf, writes } = createHarness({}, { postMessageResult: false });
    const pdf = await openPdf();
    await pdf.receive({ type: 'pageCount', count: 1 });
    await assert.rejects(provider.extractComposite('all', compositeOptions()), /could not receive the export request/);
    assert.equal(writes.size, 0);
    assert.deepEqual(provider.getExtractedPdfs(), []);
    assert.equal(pdf.messages.at(-1).type, 'compositeCancel');
});
