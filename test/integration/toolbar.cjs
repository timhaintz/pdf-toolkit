const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// A real VS Code webview supplies Chromium, theme variables and resource access.
// The nested viewport gives the unmodified viewer's CSS, window.innerWidth,
// media queries and ResizeObserver an exact editor width on every CI platform.
// The VS Code transport is bridged; test input events target the production
// handlers. No test hooks ship in the extension. Native Tab traversal is a
// separate manual check because background Code windows may suppress focusin.
function browserChecks() {
    const api = acquireVsCodeApi();
    const frame = document.getElementById('viewer');
    const assertions = [];
    const samples = [];
    const focusSamples = [];
    const focusEvents = [];
    const syntheticFocusCases = [];
    const messages = [];
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const fail = message => { throw new Error(message); };
    const check = (condition, label, details) => {
        if (!condition) fail(details ? `${label}; metrics: ${JSON.stringify(details)}` : label);
        assertions.push(label);
    };
    async function waitFor(condition, label) {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (condition()) return;
            await pause(50);
        }
        fail(`Timed out waiting for ${label}; viewer messages: ${JSON.stringify(messages)}`);
    }
    window.addEventListener('message', event => {
        if (event.source === frame.contentWindow && event.data?.toolbarFixture) {
            messages.push(event.data.message);
        }
    });
    window.addEventListener('securitypolicyviolation', event => messages.push({ type: 'parentCspViolation',
        directive: event.violatedDirective, blockedURI: event.blockedURI }));
    frame.addEventListener('load', () => {
        try {
            messages.push({ type: 'frameLoaded', url: frame.contentWindow.location.href,
                title: frame.contentDocument?.title, htmlPrefix: frame.contentDocument?.documentElement?.outerHTML.slice(0, 500) });
        } catch (error) { messages.push({ type: 'frameAccessError', error: String(error) }); }
    });
    (async () => {
        // VS Code's webview resource service worker identifies a client by its
        // URL's ?id=. about:srcdoc has no ID and cannot load local PDF.js/PDFs.
        // Match VS Code's own iframe setup: load its same-origin fake.html URL,
        // preserving that ID, then write the production document into it.
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
        await waitFor(() => frame.contentDocument?.getElementById('page-count')?.textContent === '5', 'PDF loading');
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        // Webview theme custom properties are injected into the parent by VS Code.
        // Copy them to this independent document, including the user's UI font.
        const theme = getComputedStyle(document.body);
        for (const property of theme) {
            if (property.startsWith('--vscode-')) doc.documentElement.style.setProperty(property, theme.getPropertyValue(property));
        }
        await waitFor(() => doc.querySelector('#page-5 .textLayer')?.childElementCount > 0, 'all page text layers');
        const byId = id => doc.getElementById(id);
        const viewport = byId('toolbar-viewport');
        const toolbar = byId('pdf-toolbar');
        const trigger = byId('screenshot-btn');
        const popup = byId('screenshot-dropdown');
        const search = byId('search-input');
        const page = byId('page-input');
        const zoom = byId('zoom-display');
        check(!!viewport && !!toolbar && !!trigger && !!popup, 'Production toolbar elements are present');
        viewport.addEventListener('focusin', event => focusEvents.push({ id: event.target.id,
            trusted: event.isTrusted, documentFocused: doc.hasFocus(), scrollLeft: viewport.scrollLeft }));
        const key = (target, value, options = {}) => {
            const event = new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
            target.dispatchEvent(event);
            return event;
        };
        const settle = async () => {
            await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
            await pause(80);
        };
        const rect = element => element.getBoundingClientRect();
        const focusMetrics = element => ({
            id: element.id, activeElement: doc.activeElement?.id, documentFocused: doc.hasFocus(),
            documentVisibility: doc.visibilityState, target: rect(element).toJSON(), viewport: rect(viewport).toJSON(),
            scrollLeft: viewport.scrollLeft, scrollWidth: viewport.scrollWidth, clientWidth: viewport.clientWidth,
            scrollBehavior: win.getComputedStyle(viewport).scrollBehavior,
            iframe: rect(frame).toJSON(), innerWidth: win.innerWidth, outerWidth: window.innerWidth,
            documentWidth: doc.documentElement.clientWidth, documentScrollWidth: doc.documentElement.scrollWidth
        });
        const deliverInactiveFocusEvent = (element, eventStart, cause) => {
            const actualEvents = focusEvents.slice(eventStart);
            if (!doc.hasFocus() && doc.activeElement === element &&
                !actualEvents.some(event => event.id === element.id && event.trusted)) {
                // Chromium in an inactive test window can set activeElement
                // and partially scroll a control without emitting focusin.
                // Exercise the actual reveal handler explicitly in that proven
                // case; retain the identical real-layout visibility assertion.
                syntheticFocusCases.push({ id: element.id, width: win.innerWidth, cause,
                    documentFocused: false, trustedTargetEvents: 0 });
                element.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
            }
        };
        const visibleInToolbar = element => {
            const target = rect(element);
            const clip = rect(viewport);
            return target.width > 0 && target.left >= clip.left - 1 && target.right <= clip.right + 1;
        };
        const menuItems = () => [...popup.querySelectorAll('button')].filter(item => !item.disabled);
        const scrollWithVisibleTrigger = async label => {
            const previousScroll = viewport.scrollLeft;
            const anchor = rect(trigger);
            const clip = rect(viewport);
            const maximum = viewport.scrollWidth - viewport.clientWidth;
            let delta = Math.min(24, maximum - previousScroll, Math.max(0, anchor.left - clip.left - 2));
            if (delta < 1) delta = -Math.min(24, previousScroll, Math.max(0, clip.right - anchor.right - 2));
            check(Math.abs(delta) >= 1, `${label}: the toolbar has room to scroll with a visible Screenshot trigger`);
            viewport.scrollLeft = previousScroll + delta;
            await settle();
            check(Math.abs(viewport.scrollLeft - previousScroll) >= 1, `${label}: horizontal scrolling moves while Screenshot is open`);
            check(visibleInToolbar(trigger), `${label}: scrolling keeps the Screenshot trigger visible`);
        };
        const assertPopup = label => {
            const bounds = rect(popup);
            check(bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.right <= win.innerWidth + 1 &&
                bounds.top >= -1 && bounds.bottom <= win.innerHeight + 1, `${label}: popup fits its viewport`);
            for (const item of [menuItems()[0], menuItems().at(-1)]) {
                const itemBounds = rect(item);
                const hit = doc.elementFromPoint(itemBounds.left + itemBounds.width / 2, itemBounds.top + itemBounds.height / 2);
                check(item.contains(hit), `${label}: ${item.id} is clickable beyond the scrolling toolbar`);
            }
        };

        search.value = 'PDF Toolkit';
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        await waitFor(() => byId('search-results').textContent === '1 of 5', 'search results');
        page.value = '3';
        page.dispatchEvent(new win.Event('change', { bubbles: true }));
        await pause(900); // Production page navigation uses smooth scrolling.
        check(page.value === '3', 'Fixture navigation reaches page 3 before resizing');
        const originalSearch = search;
        const originalPage = page;
        const originalZoom = zoom;
        const expectedZoom = zoom.value;

        for (const width of [1600, 900, 600, 480, 320, 768, 1600]) {
            frame.style.width = `${width}px`;
            await waitFor(() => win.innerWidth === width, `viewport resize to ${width}px`);
            await settle();
            check(doc.documentElement.scrollWidth <= width + 1, `${width}px: the document does not overflow horizontally`);
            check(byId('search-input') === originalSearch && byId('page-input') === originalPage && byId('zoom-display') === originalZoom,
                `${width}px: resizing preserves the existing inputs`);
            check(search.value === 'PDF Toolkit' && byId('search-results').textContent === '1 of 5', `${width}px: resizing preserves search text and results`);
            check(page.value === '3' && zoom.value === expectedZoom, `${width}px: resizing preserves page and zoom state`);
            const centers = ['prev-page', 'page-input', 'next-page', 'zoom-display', 'search-input', 'screenshot-btn', 'browse-extracted-btn']
                .map(id => { const bounds = rect(byId(id)); return bounds.top + bounds.height / 2; });
            check(Math.max(...centers) - Math.min(...centers) < 2, `${width}px: all toolbar controls stay on one row`);
            if (width === 1600) check(viewport.scrollWidth <= viewport.clientWidth + 1, `${width}px: a wide toolbar does not require scrolling`);
            if (width === 320) check(viewport.scrollWidth > viewport.clientWidth, `${width}px: narrow panes retain horizontal scrolling`);

            for (const id of ['prev-page', 'search-input', 'screenshot-btn', 'browse-extracted-btn']) {
                // Focus the nested browsing context itself. In an inactive
                // frame Chromium can set activeElement without delivering
                // focusin, which would bypass the actual toolbar handler.
                win.focus();
                await settle();
                const eventStart = focusEvents.length;
                byId(id).focus();
                const before = focusMetrics(byId(id));
                deliverInactiveFocusEvent(byId(id), eventStart, 'control focus');
                await settle();
                const after = focusMetrics(byId(id));
                focusSamples.push({ width, before, after, events: focusEvents.slice(eventStart) });
                check(doc.activeElement === byId(id) && visibleInToolbar(byId(id)),
                    `${width}px: focus handler reveals ${id}`, { before, after, events: focusEvents.slice(eventStart) });
            }
            trigger.focus();
            await settle();
            trigger.click();
            await settle();
            check(trigger.getAttribute('aria-expanded') === 'true', `${width}px: Screenshot announces its expanded state`);
            assertPopup(`${width}px`);
            if (width === 320) {
                await scrollWithVisibleTrigger(`${width}px`);
                check(trigger.getAttribute('aria-expanded') === 'true', `${width}px: a visible Screenshot trigger keeps its menu open while scrolling`);
                assertPopup(`${width}px after horizontal scroll`);
            }
            const items = menuItems();
            items[0].focus();
            key(items[0], 'ArrowDown');
            check(doc.activeElement === items[1], `${width}px: ArrowDown moves within Screenshot options`);
            key(doc.activeElement, 'End');
            check(doc.activeElement === items.at(-1) && page.value === '3', `${width}px: End reaches the last menu item without changing PDF page`);
            key(doc.activeElement, 'Home');
            check(doc.activeElement === items[0] && page.value === '3', `${width}px: Home reaches the first menu item without changing PDF page`);
            key(doc.activeElement, 'ArrowUp');
            check(doc.activeElement === items.at(-1), `${width}px: ArrowUp wraps through Screenshot options`);
            key(doc.activeElement, 'Escape');
            check(trigger.getAttribute('aria-expanded') === 'false' && doc.activeElement === trigger,
                `${width}px: Escape closes Screenshot and returns trigger focus`);

            trigger.click();
            await settle();
            items[0].focus();
            const tab = key(items[0], 'Tab');
            check(trigger.getAttribute('aria-expanded') === 'false' && !tab.defaultPrevented,
                `${width}px: Tab closes Screenshot without trapping native focus traversal`);
            const searchEventStart = focusEvents.length;
            key(doc.body, 'f', { ctrlKey: true });
            deliverInactiveFocusEvent(search, searchEventStart, 'Ctrl+F handler');
            await settle();
            check(doc.activeElement === search && visibleInToolbar(search), `${width}px: Ctrl+F handler reveals and focuses search`);
            samples.push({ width, toolbarWidth: toolbar.scrollWidth, viewportWidth: viewport.clientWidth,
                scrollLeft: viewport.scrollLeft, page: page.value, query: search.value });
        }

        // Verify the actual action listeners still send their existing host
        // messages after responsive changes and repeated menu interactions.
        for (const [id, type] of [['screenshot-current', 'screenshotCurrent'], ['screenshot-all', 'screenshotAll'],
            ['screenshot-custom', 'openCustomMenu'], ['screenshot-composite', 'openCompositeMenu']]) {
            trigger.click();
            await settle();
            const before = messages.length;
            byId(id).click();
            await waitFor(() => messages.slice(before).some(message => message.type === type), `${id} host message`);
            check(trigger.getAttribute('aria-expanded') === 'false', `${id}: choosing the action closes Screenshot`);
        }
        const beforeBrowse = messages.length;
        byId('browse-extracted-btn').click();
        await waitFor(() => messages.slice(beforeBrowse).some(message => message.type === 'browseExtracted'), 'Browse Extracted host message');
        check(true, 'Browse Extracted retains its host action');

        // A short editor viewport makes the popup itself scroll. Repositioning
        // it must retain its focused last item, rather than reset that item out
        // of view when height constraints or the toolbar's anchor change.
        frame.style.width = '480px';
        await waitFor(() => win.innerWidth === 480, 'short editor width');
        await settle();
        trigger.focus();
        trigger.click();
        await settle();
        key(doc.activeElement, 'End');
        const lastItem = menuItems().at(-1);
        check(doc.activeElement === lastItem, 'Short editor fixture initially focuses the final Screenshot option');
        frame.style.height = '150px';
        await waitFor(() => win.innerHeight === 150, 'short editor height');
        await settle();
        const assertFocusedLast = label => {
            const bounds = rect(lastItem);
            const clip = rect(popup);
            check(trigger.getAttribute('aria-expanded') === 'true' && doc.activeElement === lastItem,
                `${label}: the final Screenshot option retains focus`);
            check(bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1 && bounds.bottom <= win.innerHeight + 1,
                `${label}: the focused final option remains visible in the constrained popup`);
            check(lastItem.contains(doc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
                `${label}: the focused final option remains clickable`);
        };
        assertFocusedLast('150px editor height after resize');
        await scrollWithVisibleTrigger('150px editor height');
        assertFocusedLast('150px editor height after toolbar scrolling');
        key(lastItem, 'Escape');
        frame.style.height = '900px';
        await waitFor(() => win.innerHeight === 900, 'restored editor height');
        await settle();

        // A focused, unfinished input should survive a size change too.
        zoom.focus();
        zoom.value = '137%';
        frame.style.width = '320px';
        await waitFor(() => win.innerWidth === 320, 'focused input resize');
        await settle();
        check(doc.activeElement === zoom && zoom.value === '137%', 'Resize preserves focus and an unfinished zoom value');
        api.postMessage({ type: 'toolbarTestResult', ok: true, assertions, samples, focusSamples, focusEvents,
            syntheticFocusEvents: syntheticFocusCases.length, syntheticFocusCases });
    })().catch(error => api.postMessage({ type: 'toolbarTestResult', ok: false,
        error: error.stack || String(error), assertions, samples, focusSamples, focusEvents, messages,
        syntheticFocusEvents: syntheticFocusCases.length, syntheticFocusCases }));
}

exports.testToolbar = async function testToolbar(extension, workspace) {
    const extensionUri = vscode.Uri.file(extension.extensionPath);
    const { PdfEditorProvider } = require(path.join(extension.extensionPath, 'out', 'pdfEditorProvider.js'));
    const provider = new PdfEditorProvider({ extensionUri, subscriptions: [] });
    const panel = vscode.window.createWebviewPanel('pdfToolkit.toolbarTests', 'PDF Toolkit toolbar tests',
        vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [extensionUri, vscode.Uri.file(workspace)]
        });
    const resource = (...segments) => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
    let html = provider.getHtmlContent(panel.webview,
        resource('node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs'),
        resource('node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
        resource('node_modules', 'pdfjs-dist', 'wasm'),
        panel.webview.asWebviewUri(vscode.Uri.file(path.join(workspace, 'sample.pdf'))),
        resource('images', 'icon.png'));
    assert.ok(html.includes('const vscode = acquireVsCodeApi();'), 'Viewer transport is recognized by the test fixture');
    html = html.replace('const vscode = acquireVsCodeApi();',
        'const vscode = { postMessage: message => parent.postMessage({ toolbarFixture: true, message }, "*") };');
    const nonce = html.match(/<script nonce="([A-Za-z0-9]+)" type="module">/)[1];
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    // Capture failures before the module imports PDF.js. This code exists only
    // in the nested fixture, leaving the shipped viewer unchanged.
    html = html.replace('<style>', `<script nonce="${nonce}">
        const reportFixture = message => parent.postMessage({ toolbarFixture: true, message }, '*');
        reportFixture({ type: 'fixtureStarted', url: location.href });
        window.addEventListener('error', event => reportFixture({ type: 'fixtureError',
            message: event.message || 'Resource load failed', filename: event.filename, source: event.target?.src }), true);
        window.addEventListener('unhandledrejection', event => reportFixture({ type: 'fixtureRejection', message: String(event.reason) }));
        document.addEventListener('securitypolicyviolation', event => reportFixture({ type: 'fixtureCspViolation',
            directive: event.violatedDirective, blockedURI: event.blockedURI }));
        </script><style>`);
    const serializedHtml = JSON.stringify(html).replace(/</g, '\\u003c');
    let listener;
    let timer;
    try {
        const resultPromise = new Promise((resolve, reject) => {
            listener = panel.webview.onDidReceiveMessage(message => {
                if (message.type === 'toolbarTestResult') resolve(message);
            });
            timer = setTimeout(() => reject(new Error('Real webview toolbar layout tests timed out after 90s')), 90000);
        });
        panel.webview.html = `<!DOCTYPE html><html><head>
            <meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp} frame-src 'self';">
            <style>body { margin: 0; overflow: hidden; } #viewer { width: 1600px; height: 900px; border: 0; }</style>
            </head><body><iframe id="viewer" title="Production PDF viewer test viewport"></iframe>
            <script nonce="${nonce}">window.viewerHtml = ${serializedHtml}; (${browserChecks.toString()})();</script>
            </body></html>`;
        panel.reveal(vscode.ViewColumn.One, false);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        const result = await resultPromise;
        fs.writeFileSync(path.join(workspace, 'toolbar-layout-results.json'), JSON.stringify({
            mode: process.env.PDF_TOOLKIT_TEST_MODE, vscodeVersion: vscode.version, extensionPath: extension.extensionPath, ...result
        }, null, 2));
        assert.ok(result.ok, result.error);
        assert.ok(result.assertions.length >= 100, 'Real-layout assertions ran across the required widths');
        console.log(`PASS: ${result.assertions.length} real-webview toolbar layout, scrolling, popup hit-testing, keyboard-handler, state-preservation and action checks; ${result.syntheticFocusEvents} explicit focusin handler events for inactive frames. Native Tab traversal is checked separately. Evidence: ${path.join(workspace, 'toolbar-layout-results.json')}`);
    } finally {
        clearTimeout(timer);
        listener?.dispose();
        panel.dispose();
    }
};
