const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { createSecurityPdf, LATE_SEARCH_TERM } = require('../fixtures/createSecurityPdf.cjs');
const { createJpxPdf } = require('../fixtures/createJpxPdf.cjs');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// This runs before PDF.js imports in the fixture only. Reject an unsafe native
// allocation before Chromium can attempt it, while recording actual dimensions.
// A regression therefore fails with evidence instead of exhausting a CI machine.
function installCanvasBoundary() {
    const canvases = new Set();
    const blocked = [];
    let allocations = 0;
    let peakCanvasPixels = 0;
    let peakAllCanvasPixels = 0;
    const originalCreate = document.createElement;
    document.createElement = function (...args) {
        const element = originalCreate.apply(this, args);
        if (element instanceof HTMLCanvasElement) canvases.add(element);
        return element;
    };
    for (const dimension of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension);
        Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
            ...descriptor,
            set(value) {
                const width = dimension === 'width' ? Number(value) : this.width;
                const height = dimension === 'height' ? Number(value) : this.height;
                if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0 ||
                    width > 8192 || height > 8192 || width * height > 32_000_000) {
                    const attempt = { dimension, value, width, height, className: this.className };
                    blocked.push(attempt);
                    throw new Error(`Security fixture blocked an unsafe canvas allocation: ${JSON.stringify(attempt)}`);
                }
                descriptor.set.call(this, value);
                canvases.add(this);
                allocations++;
                peakCanvasPixels = Math.max(peakCanvasPixels, this.width * this.height);
                let total = 0;
                for (const canvas of canvases) total += canvas.width * canvas.height;
                peakAllCanvasPixels = Math.max(peakAllCanvasPixels, total);
            }
        });
    }
    window.canvasBoundary = { report: () => ({ allocations, peakCanvasPixels, peakAllCanvasPixels,
        canvases: canvases.size, blocked: [...blocked] }) };
}

// The same-origin fake.html/client-id setup matches toolbar.cjs. All rendering,
// scrolling, searching and exports use production HTML and production handlers.
function browserSecurityChecks() {
    const api = acquireVsCodeApi();
    const frame = document.getElementById('viewer');
    const scenario = window.securityScenario;
    const assertions = [];
    const samples = [];
    const messages = [];
    const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    let doc;
    let win;
    let monitor;
    let peak = { wrappers: 0, canvases: 0, textLayers: 0, pixels: 0 };
    const isWorkerFallbackWarning = message => {
        if (message.type !== 'fixtureError' ||
            typeof message.filename !== 'string' || !message.filename.startsWith('blob:') || !win) return false;
        try {
            // vscode.Uri escapes '+' in the resource authority; Chromium's
            // import error reports the URL parser's canonical authority.
            const expectedWorkerUri = new URL(window.expectedWorkerUri).href;
            if (message.message !== `Uncaught TypeError: Failed to fetch dynamically imported module: ${expectedWorkerUri}`) return false;
            const blobSource = new URL(message.filename.slice(5));
            return blobSource.protocol === win.location.protocol && blobSource.host === win.location.host;
        } catch { return false; }
    };
    const summarize = message => ({ type: message.type, message: message.message, extractionId: message.extractionId,
        filename: message.filename, source: message.source,
        count: message.count, page: message.page, pages: message.pages?.length,
        images: message.images?.map(image => ({ page: image.page, width: image.width, height: image.height })),
        totalFound: message.totalFound });
    const metrics = () => {
        const canvases = [...doc?.querySelectorAll('.page-canvas') || []];
        return { wrappers: doc?.querySelectorAll('.page-wrapper').length || 0,
            canvases: canvases.length, textLayers: doc?.querySelectorAll('.textLayer').length || 0,
            pixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
            rasters: canvases.map(canvas => ({ page: canvas.closest('.page-wrapper')?.dataset.page,
                width: canvas.width, height: canvas.height, cssWidth: canvas.style.width, cssHeight: canvas.style.height })),
            page: doc?.getElementById('page-input')?.value, zoom: doc?.getElementById('zoom-display')?.value,
            query: doc?.getElementById('search-input')?.value, results: doc?.getElementById('search-results')?.textContent,
            scrollTop: doc?.getElementById('pdf-container')?.scrollTop,
            scrollHeight: doc?.getElementById('pdf-container')?.scrollHeight,
            container: doc?.getElementById('pdf-container')?.getBoundingClientRect().toJSON(),
            selected: [...doc?.querySelectorAll('.highlight.selected') || []].map(element => ({
                page: element.closest('.page-wrapper')?.dataset.page, text: element.textContent,
                bounds: element.getBoundingClientRect().toJSON(), connected: element.isConnected
            })),
            iframe: frame.getBoundingClientRect().toJSON(),
            viewport: { width: win?.innerWidth, height: win?.innerHeight, parentWidth: window.innerWidth,
                parentHeight: window.innerHeight, parentScrollTop: document.scrollingElement?.scrollTop },
            workerResource: { configured: window.expectedWorkerUri,
                canonical: window.expectedWorkerUri ? new URL(window.expectedWorkerUri).href : undefined,
                frameLocation: win?.location.href, frameProtocol: win?.location.protocol, frameHost: win?.location.host },
            browserErrors: messages.filter(message => ['fixtureError', 'fixtureRejection', 'fixtureCspViolation'].includes(message.type)),
            boundary: win?.canvasBoundary?.report() };
    };
    const evidence = () => ({ scenario, metrics: metrics(), peak, samples, messages: messages.slice(-15),
        workerFallbackWarnings: messages.filter(isWorkerFallbackWarning) });
    const check = (condition, label, details) => {
        if (!condition) throw new Error(`${label}; metrics: ${JSON.stringify({ ...evidence(), details })}`);
        assertions.push(label);
    };
    async function waitFor(condition, label, timeout = 20000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (condition()) return;
            await pause(50);
        }
        throw new Error(`Timed out waiting for ${label}; metrics: ${JSON.stringify(evidence())}`);
    }
    function observe() {
        const current = metrics();
        for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key]);
    }
    function sample(label) {
        observe();
        const current = metrics();
        samples.push({ label, ...current });
        check(current.wrappers <= 12 && current.canvases <= 12 && current.textLayers <= 12,
            `${label}: at most twelve real page wrappers, rasters and text layers are mounted`);
        check(current.pixels <= 24_000_000 && current.rasters.every(canvas =>
            canvas.width <= 8192 && canvas.height <= 8192 && canvas.width * canvas.height <= 8_000_000),
        `${label}: actual resident preview pixels and individual canvas dimensions are bounded`);
        check(current.boundary.blocked.length === 0, `${label}: the fixture allocation guard never substitutes for production validation`);
        api.postMessage({ type: 'securityProgress', label, metrics: current, peak });
    }
    window.addEventListener('message', event => {
        if (event.source === frame.contentWindow && event.data?.securityFixture) {
            messages.push(summarize(event.data.message));
            // Forward genuine viewer messages into resolveCustomEditor's real
            // listener, including native PNG data and screenshot commands.
            api.postMessage(event.data.message);
        } else if (event.source !== frame.contentWindow && typeof event.data?.type === 'string') {
            messages.push({ ...summarize(event.data), type: `host:${event.data.type}` });
            frame.contentWindow.postMessage(event.data, '*');
        }
    });
    (async () => {
        frame.style.height = `${Math.min(900, window.innerHeight)}px`;
        await new Promise((resolve, reject) => {
            const writeFixture = () => {
                frame.removeEventListener('load', writeFixture);
                try {
                    frame.contentDocument.open();
                    frame.contentDocument.write(window.viewerHtml);
                    frame.contentDocument.close();
                    resolve();
                } catch (error) { reject(error); }
            };
            frame.addEventListener('load', writeFixture);
            const currentUrl = new URL(location.href);
            const fixtureUrl = new URL('./fake.html', currentUrl);
            fixtureUrl.searchParams.set('id', currentUrl.searchParams.get('id'));
            if (currentUrl.searchParams.has('vscode-coi')) fixtureUrl.searchParams.set('vscode-coi', currentUrl.searchParams.get('vscode-coi'));
            frame.src = fixtureUrl.href;
        });
        doc = frame.contentDocument;
        win = frame.contentWindow;
        const theme = getComputedStyle(document.body);
        for (const property of theme) {
            if (property.startsWith('--vscode-')) doc.documentElement.style.setProperty(property, theme.getPropertyValue(property));
        }
        const byId = id => doc.getElementById(id);
        const container = byId('pdf-container');
        const rect = element => element.getBoundingClientRect();
        const hasText = page => !!doc.querySelector(`#page-${page} .textLayer span`) &&
            !!doc.querySelector(`#page-${page} .page-canvas`)?.width;
        const visible = element => {
            const bounds = rect(element);
            const viewport = rect(container);
            return bounds.top >= viewport.top - 2 && bounds.bottom <= viewport.bottom + 2 &&
                bounds.left >= viewport.left - 2 && bounds.right <= viewport.right + 2;
        };
        const key = (element, value) => element.dispatchEvent(new win.KeyboardEvent('keydown',
            { key: value, bubbles: true, cancelable: true }));
        const jump = async page => {
            byId('page-input').value = String(page);
            byId('page-input').dispatchEvent(new win.Event('change', { bubbles: true }));
            await waitFor(() => hasText(page), `page ${page} native navigation and text rendering`);
            await pause(200);
            sample(`navigate to page ${page}`);
        };
        const zoom = async percentage => {
            const oldCanvas = doc.querySelector('.page-canvas');
            byId('zoom-display').value = `${percentage}%`;
            key(byId('zoom-display'), 'Enter');
            await waitFor(() => !oldCanvas.isConnected && doc.querySelector('.textLayer span'), `${percentage}% new preview generation`);
            await pause(150);
            sample(`zoom ${percentage}%`);
        };
        async function assertTextAlignment(page, rotation, label) {
            await waitFor(() => hasText(page), `${label} text layer`);
            const wrapper = byId(`page-${page}`);
            const canvas = wrapper.querySelector('canvas');
            const span = wrapper.querySelector('.highlight.selected') || wrapper.querySelector('.textLayer span');
            const range = doc.createRange();
            range.selectNodeContents(span);
            const text = range.getBoundingClientRect();
            const image = rect(canvas);
            // Invert the shared CSS quarter-turn to compare text's real DOM
            // geometry with the underlying PDF.js raster's black glyph pixels.
            let left, top, width, height;
            if (rotation === 90) {
                left = (text.top - image.top) / image.height;
                top = (image.right - text.right) / image.width;
                width = text.height / image.height;
                height = text.width / image.width;
            } else {
                left = (text.left - image.left) / image.width;
                top = (text.top - image.top) / image.height;
                width = text.width / image.width;
                height = text.height / image.height;
            }
            const x = Math.max(0, Math.floor(left * canvas.width) - 2);
            const y = Math.max(0, Math.floor(top * canvas.height) - 2);
            const w = Math.min(canvas.width - x, Math.ceil(width * canvas.width) + 4);
            const h = Math.min(canvas.height - y, Math.ceil(height * canvas.height) + 4);
            const detail = { page, rotation, text: text.toJSON(), image: image.toJSON(),
                raster: { width: canvas.width, height: canvas.height }, sample: { x, y, w, h } };
            check(w > 0 && h > 0 && w * h < 1_000_000 && left >= -0.01 && top >= -0.01 &&
                left + width <= 1.01 && top + height <= 1.01, `${label}: selectable text occupies the PDF raster's geometry`, detail);
            const pixels = canvas.getContext('2d').getImageData(x, y, w, h).data;
            let ink = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
                if (pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100 && pixels[offset + 3] > 0) ink++;
            }
            detail.ink = ink;
            check(ink > 15, `${label}: actual black PDF glyphs occur beneath the selectable text`, detail);
            samples.push({ label: `${label} text alignment`, ...detail });
        }
        monitor = setInterval(observe, 30);
        await waitFor(() => byId('page-count')?.textContent === String(scenario.pages) && hasText(1), 'real PDF.js initial preview');
        await waitFor(() => Array.from({ length: Math.min(12, scenario.pages) }, (_, index) => hasText(index + 1)).every(Boolean),
            'the complete initial raster and text render window');
        sample('initial load');

        if (scenario.kind === 'many-pages') {
            check(!byId('page-50'), 'Page fifty is initially outside the mounted preview window');
            await assertTextAlignment(1, 0, 'initial mixed-size page');
            await jump(35);
            check(!byId('page-1'), 'Distant native page navigation evicts the original DOM page');
            container.scrollTop = 0;
            container.dispatchEvent(new win.Event('scroll'));
            await waitFor(() => hasText(1), 'native scroll returns through virtual spacers to page one');
            await pause(250);
            sample('scroll through virtual spacers');
            await jump(1);
            const search = byId('search-input');
            search.value = scenario.query;
            search.dispatchEvent(new win.Event('input', { bubbles: true }));
            await waitFor(() => byId('search-results').textContent === '1 of 1' &&
                doc.querySelector('#page-50 .highlight.selected'), 'full-document search finds page fifty outside the preview cache');
            await waitFor(() => visible(doc.querySelector('#page-50 .highlight.selected')),
                'late-page selected match is visible in the real viewport');
            check(byId('page-input').value === '50', 'Offscreen search updates native page navigation to page fifty');
            sample('offscreen search selected and visible');
            await assertTextAlignment(50, 0, 'offscreen selected search text');
            // As in toolbar.cjs, let Chromium finish search's smooth centering
            // before issuing an unrelated page navigation request.
            await pause(900);
            byId('search-close').click();
            await jump(2);
            await assertTextAlignment(2, 0, 'returned mixed-size page');
            for (const percentage of [200, 500, 125, 300, 100]) await zoom(percentage);
            // Start another generation before the previous render can finish.
            // This exercises cancellation using actual PDF.js tasks and canvases.
            for (const percentage of [400, 150, 100]) {
                byId('zoom-display').value = `${percentage}%`;
                key(byId('zoom-display'), 'Enter');
            }
            await waitFor(() => hasText(2), 'rapid zoom cancellation leaves a usable current page');
            await pause(350);
            sample('rapid zoom generations');
            await assertTextAlignment(2, 0, 'after repeated zoom and cancellation');
            byId('rotate-cw').click();
            byId('dark-mode').click();
            await pause(150);
            check(byId('page-2').classList.contains('rotated-90') && container.classList.contains('dark-mode'),
                'Rotation and dark appearance operate after distant navigation and repeated zoom');
            await assertTextAlignment(2, 90, 'rotated dark page');
            byId('rotate-ccw').click();
            byId('dark-mode').click();
            sample('restored rotation and appearance');
            check(peak.wrappers <= 12 && peak.canvases <= 12 && peak.textLayers <= 12 && peak.pixels <= 24_000_000,
                'Continuous real-DOM observations stay within page and aggregate raster limits');
            check(metrics().boundary.peakCanvasPixels <= 8_000_000,
                'Even detached and canceled preview canvas allocations stay within the page pixel limit');
        } else if (scenario.kind === 'huge-page') {
            const canvas = doc.querySelector('.page-canvas');
            check(parseFloat(canvas.style.width) >= 1_000_000 && canvas.width < parseFloat(canvas.style.width) / 100,
                'Genuine PDF UserUnit dimensions are downsampled before preview allocation');
            const start = messages.length;
            const allocations = metrics().boundary.allocations;
            byId('screenshot-current').click();
            await waitFor(() => messages.slice(start).some(message => message.type === 'error'), 'oversized ordinary screenshot resource error');
            const errors = messages.slice(start).filter(message => message.type === 'error');
            check(errors.some(message => /limit|resolution|dimensions/i.test(message.message)),
                'Oversized ordinary screenshot reports its resource limit', errors);
            check(!messages.slice(start).some(message => message.type === 'extractedPages'),
                'Oversized ordinary screenshot never emits a partial image batch');
            check(metrics().boundary.allocations === allocations && metrics().boundary.blocked.length === 0,
                'Oversized ordinary screenshot is rejected by production before any canvas allocation');
            sample('oversized ordinary export rejected');
        } else if (scenario.kind === 'dot-path') {
            let start = messages.length;
            byId('screenshot-current').click();
            await waitFor(() => messages.slice(start).some(message => message.type === 'extractedPages' && message.pages === 1),
                'ordinary native screenshot dispatches a real PNG batch');
            const ordinary = messages.slice(start).find(message => message.type === 'extractedPages');
            await waitFor(() => messages.some(message => message.type === 'fixtureExtractionAcknowledged' &&
                message.extractionId === ordinary.extractionId), 'ordinary native screenshot is consumed by its real provider writer');
            start = messages.length;
            byId('extract-images').click();
            await waitFor(() => messages.slice(start).some(message => message.type === 'extractedImages' && message.images?.length === 1),
                'JPEG 2000 embedded bitmap extraction dispatches a real PNG batch');
            const embedded = messages.slice(start).find(message => message.type === 'extractedImages');
            check(embedded.images[0].width === 16 && embedded.images[0].height === 16,
                'Embedded JPEG 2000 export retains native bitmap dimensions');
            await waitFor(() => messages.some(message => message.type === 'fixtureExtractionAcknowledged' &&
                message.extractionId === embedded.extractionId), 'embedded native bitmap is consumed by its real provider writer');
            sample('native ordinary and embedded exports');
        }
        const unexpectedErrors = messages.filter(message =>
            ['fixtureError', 'fixtureRejection', 'fixtureCspViolation'].includes(message.type) && !isWorkerFallbackWarning(message));
        // Nested VS Code resource workers can fail their blob import while
        // PDF.js successfully imports that exact worker on the main thread.
        // Record only this precise bootstrap failure separately. All actual
        // raster, glyph, search and export checks above remain mandatory.
        check(unexpectedErrors.length === 0,
            'The actual PDF.js fixture has no unexpected browser errors, rejections or policy violations', unexpectedErrors);
        clearInterval(monitor);
        api.postMessage({ type: 'securityTestResult', ok: true, scenario, assertions, ...evidence() });
    })().catch(error => {
        clearInterval(monitor);
        api.postMessage({ type: 'securityTestResult', ok: false, error: error.stack || String(error), assertions, ...evidence() });
    });
}

async function runBrowserScenario(extension, workspace, filename, scenario) {
    const extensionUri = vscode.Uri.file(extension.extensionPath);
    const { PdfEditorProvider } = require(path.join(extension.extensionPath, 'out', 'pdfEditorProvider.js'));
    const state = new Map();
    const subscriptions = [];
    const provider = new PdfEditorProvider({ extensionUri, subscriptions, workspaceState: {
        get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
        update: async (key, value) => { state.set(key, value); }
    } });
    const panel = vscode.window.createWebviewPanel('pdfToolkit.securityTests', `PDF boundary: ${scenario.kind}`,
        vscode.ViewColumn.One, { enableScripts: true });
    const cancellation = new vscode.CancellationTokenSource();
    let html;
    const getHtmlContent = provider.getHtmlContent;
    // Capture the exact production document without briefly loading a second,
    // uninstrumented viewer before the fixture replaces its transport.
    provider.getHtmlContent = function (...arguments_) {
        html = getHtmlContent.apply(this, arguments_);
        return '';
    };
    let listener;
    let timer;
    let latestProgress;
    const evidencePath = path.join(workspace, `security-${scenario.name}-results.json`);
    try {
        await provider.resolveCustomEditor({ uri: vscode.Uri.file(filename), dispose() {} }, panel, cancellation.token);
        assert.ok(html.includes('const vscode = acquireVsCodeApi();'), 'Security fixture recognizes the production transport');
        html = html.replace('const vscode = acquireVsCodeApi();',
            'const vscode = { postMessage: message => parent.postMessage({ securityFixture: true, message }, "*") };');
        const nonce = html.match(/<script nonce="([A-Za-z0-9]+)" type="module">/)[1];
        const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
        const workerUri = html.match(/GlobalWorkerOptions\.workerSrc = '([^']+)'/)[1];
        html = html.replace('<style>', `<script nonce="${nonce}">
            (${installCanvasBoundary.toString()})();
            const report = message => parent.postMessage({ securityFixture: true, message }, '*');
            window.addEventListener('message', event => {
                if (event.data?.type === 'extractionComplete') queueMicrotask(() => report({
                    type: 'fixtureExtractionAcknowledged', extractionId: event.data.extractionId
                }));
            });
            window.addEventListener('error', event => report({ type: 'fixtureError',
                message: event.message || 'Resource failed: ' + event.target?.src,
                filename: event.filename, source: event.target?.src }), true);
            window.addEventListener('unhandledrejection', event => report({ type: 'fixtureRejection', message: String(event.reason) }));
            document.addEventListener('securitypolicyviolation', event => report({ type: 'fixtureCspViolation', message: event.violatedDirective + ': ' + event.blockedURI }));
            </script><style>`);
        const resultPromise = new Promise((resolve, reject) => {
            listener = panel.webview.onDidReceiveMessage(message => {
                if (message.type === 'securityTestResult') resolve(message);
                if (message.type === 'securityProgress') latestProgress = message;
            });
            timer = setTimeout(() => reject(new Error(`${scenario.name} real-webview security checks timed out after 90s; metrics: ${JSON.stringify(latestProgress)}`)), 90000);
        });
        panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="${csp} frame-src 'self';">
            <style>body { margin: 0; overflow: hidden; } #viewer { width: 1600px; height: 900px; border: 0; }</style>
            </head><body><iframe id="viewer" title="Production PDF resource and path boundary fixture"></iframe>
            <script nonce="${nonce}">window.viewerHtml = ${JSON.stringify(html).replace(/</g, '\\u003c')};
            window.expectedWorkerUri = ${JSON.stringify(workerUri)};
            window.securityScenario = ${JSON.stringify(scenario)}; (${browserSecurityChecks.toString()})();</script></body></html>`;
        panel.reveal(vscode.ViewColumn.One, false);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        const result = await resultPromise;
        fs.writeFileSync(evidencePath, JSON.stringify({ mode: process.env.PDF_TOOLKIT_TEST_MODE,
            vscodeVersion: vscode.version, extensionPath: extension.extensionPath, ...result }, null, 2));
        assert.ok(result.ok, result.error);
        return { result, evidencePath };
    } catch (error) {
        if (!fs.existsSync(evidencePath)) fs.writeFileSync(evidencePath, JSON.stringify({ scenario,
            mode: process.env.PDF_TOOLKIT_TEST_MODE, error: error.stack || String(error) }, null, 2));
        throw error;
    } finally {
        clearTimeout(timer);
        listener?.dispose();
        panel.dispose();
        cancellation.dispose();
        for (const subscription of subscriptions) subscription.dispose();
    }
}

async function waitForFile(filename) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (fs.existsSync(filename) && fs.statSync(filename).size > 50) return;
        await pause(50);
    }
    assert.fail(`Native export was not written: ${filename}`);
}

function pngDimensions(filename) {
    const data = fs.readFileSync(filename);
    assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `Real PNG written: ${filename}`);
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

exports.testSecurity = async function testSecurity(extension, workspace) {
    const fixtures = path.join(workspace, 'security-fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const screenshotsRoot = path.join(workspace, 'PDF-Screenshots');
    const many = path.join(fixtures, 'mixed-fifty.pdf');
    const huge = path.join(fixtures, 'huge-user-unit.pdf');
    fs.writeFileSync(many, createSecurityPdf());
    fs.writeFileSync(huge, createSecurityPdf({ huge: true }));
    const summary = [];
    for (const [filename, scenario] of [
        [many, { name: 'many-pages', kind: 'many-pages', pages: 50, query: LATE_SEARCH_TERM }],
        [huge, { name: 'huge-user-unit', kind: 'huge-page', pages: 1 }]
    ]) {
        const { result, evidencePath } = await runBrowserScenario(extension, workspace, filename, scenario);
        summary.push({ name: scenario.name, assertions: result.assertions.length, peak: result.peak,
            workerFallbackWarnings: result.workerFallbackWarnings, evidencePath });
    }
    assert.ok(!fs.existsSync(path.join(screenshotsRoot, 'huge-user-unit')),
        'Rejected oversized ordinary export creates no output directory or partial files');
    for (const [index, name] of ['...pdf', '..pdf'].entries()) {
        const filename = path.join(fixtures, name);
        fs.writeFileSync(filename, createJpxPdf());
        const outputDir = path.join(screenshotsRoot, 'document');
        fs.rmSync(outputDir, { recursive: true, force: true });
        const scenario = { name: `dot-path-${index + 1}`, kind: 'dot-path', pages: 1, filename: name };
        const { result, evidencePath } = await runBrowserScenario(extension, workspace, filename, scenario);
        const screenshot = path.join(outputDir, 'page_001.png');
        const embedded = path.join(outputDir, 'image_001_page1_16x16.png');
        await waitForFile(screenshot);
        await waitForFile(embedded);
        const quality = vscode.workspace.getConfiguration('pdfToolkit').get('extractionQuality', 2.0);
        assert.deepEqual(pngDimensions(screenshot), { width: Math.floor(240 * quality * 1.5), height: Math.floor(320 * quality * 1.5) },
            `${name}: native ordinary screenshot preserves its configured dimensions`);
        assert.deepEqual(pngDimensions(embedded), { width: 16, height: 16 }, `${name}: native JPEG 2000 bitmap dimensions are preserved`);
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['image_001_page1_16x16.png', 'page_001.png'],
            `${name}: both actual provider writers use the normalized PDF child directory`);
        for (const file of [screenshot, embedded]) {
            assert.equal(path.dirname(fs.realpathSync(file)), fs.realpathSync(outputDir), `${name}: the real PNG is a direct child of the document directory`);
        }
        for (const ancestor of [screenshotsRoot, workspace, path.dirname(workspace)]) {
            assert.ok(!fs.existsSync(path.join(ancestor, 'page_001.png')) && !fs.existsSync(path.join(ancestor, 'image_001_page1_16x16.png')),
                `${name}: neither actual writer placed files in the parent ${ancestor}`);
        }
        summary.push({ name: scenario.name, filename: name, assertions: result.assertions.length,
            workerFallbackWarnings: result.workerFallbackWarnings,
            writes: [screenshot, embedded].map(file => ({ filename: file, ...pngDimensions(file), bytes: fs.statSync(file).size })), evidencePath });
    }
    const summaryPath = path.join(workspace, 'security-regression-results.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ mode: process.env.PDF_TOOLKIT_TEST_MODE,
        vscodeVersion: vscode.version, cases: summary }, null, 2));
    console.log(`PASS: native PDF resource/search/navigation and dot-name output boundaries; evidence: ${summaryPath}`);
};
