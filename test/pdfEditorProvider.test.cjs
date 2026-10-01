const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');

function createHarness(settings = {}) {
    const errors = [];
    const information = [];
    const state = new Map();
    const writes = new Map();
    const makeUri = fsPath => ({ fsPath, toString: () => `webview:${fsPath}` });
    const vscode = {
        Uri: {
            file: makeUri,
            joinPath: (base, ...segments) => makeUri(path.join(base.fsPath, ...segments))
        },
        workspace: {
            workspaceFolders: [{ uri: makeUri('/workspace') }],
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
            fs: {
                createDirectory: async () => {},
                stat: async uri => {
                    if (!writes.has(uri.fsPath)) throw new Error('File not found');
                    return {};
                },
                writeFile: async (uri, data) => writes.set(uri.fsPath, data)
            }
        },
        window: {
            showErrorMessage: message => errors.push(message),
            showInformationMessage: async message => { information.push(message); },
            showWarningMessage: async () => undefined
        }
    };
    const context = {
        extensionUri: makeUri('/extension'),
        subscriptions: [],
        workspaceState: {
            get: (key, fallback) => state.get(key) ?? fallback,
            update: async (key, value) => state.set(key, value)
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
                postMessage: message => { messages.push(message); return Promise.resolve(true); },
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
            dispose: () => onDispose()
        };
    }

    return { provider, openPdf, errors, information, writes };
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
    assert.ok(html.includes(`script-src 'nonce-${nonce}' blob:`));
    assert.ok(html.includes("import * as pdfjsLib from 'webview:/extension/node_modules/pdfjs-dist/build/pdf.min.mjs'"));
    assert.ok(html.includes("workerSrc = 'webview:/extension/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'"));
    assert.ok(html.includes("const pdfUrl = 'webview:/documents/report.pdf'"));
    assert.equal(panel.webview.options.enableScripts, true);
    assert.ok(panel.webview.options.localResourceRoots.some(uri => uri.fsPath === '/extension/node_modules/pdfjs-dist'));
});
