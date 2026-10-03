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
        // Keep vertical geometry within the real webview. Older Chromium walks
        // all scrollIntoView ancestors, including a clipped oversized iframe.
        const fixtureHeight = Math.min(900, window.innerHeight);
        frame.style.height = `${fixtureHeight}px`;
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
        const more = byId('toolbar-more-btn');
        const overflow = byId('toolbar-overflow');
        const secondaryPriority = ['rotation-controls', 'reset-controls', 'appearance-controls', 'search-controls'];
        const secondaryDisplayOrder = ['reset-controls', 'rotation-controls', 'appearance-controls', 'search-controls'];
        const coreGroups = ['page-controls', 'zoom-controls', 'screenshot-controls', 'extracted-controls'];
        const originalGroups = new Map([...coreGroups, ...secondaryPriority].map(id => [id, byId(id)]));
        check(!!viewport && !!toolbar && !!trigger && !!popup && !!more && !!overflow, 'Production responsive toolbar and More controls are present');
        check(overflow.getAttribute('role') === 'group', 'More uses a group for its mixed buttons and search input');
        doc.addEventListener('focusin', event => focusEvents.push({ id: event.target.id,
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
        const visibleInOverflow = element => {
            const target = rect(element);
            const clip = rect(overflow);
            return target.width > 0 && target.height > 0 && target.left >= clip.left - 1 && target.right <= clip.right + 1 &&
                target.top >= clip.top - 1 && target.bottom <= clip.bottom + 1;
        };
        const assertSelectedMatchVisible = async (pageNumber, label) => {
            const selected = [...doc.querySelectorAll('.textLayer .highlight.selected')];
            const clip = rect(byId('pdf-container'));
            check(selected.length > 0 && selected.every(element => byId(`page-${pageNumber}`).contains(element)),
                `${label}: the selected match belongs to page ${pageNumber}`);
            await waitFor(() => {
                const bounds = rect(selected[0]);
                return bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1;
            }, `${label}: smooth scrolling brings the matched text into view`);
            const bounds = rect(selected[0]);
            check(bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1,
                `${label}: matched text is visible in the actual PDF viewport`,
                { match: bounds.toJSON(), container: clip.toJSON(), pageIndicator: page.value });
        };
        const closeMore = async () => {
            if (more.getAttribute('aria-expanded') === 'true') {
                more.click();
                await settle();
            }
        };
        const openMoreFor = async element => {
            if (overflow.contains(element) && more.getAttribute('aria-expanded') !== 'true') {
                more.click();
                await settle();
            }
        };
        const assertMore = label => {
            const bounds = rect(overflow);
            check(more.getAttribute('aria-expanded') === 'true' && bounds.width > 0 && bounds.height > 0,
                `${label}: More announces and displays its expanded state`);
            check(bounds.left >= -1 && bounds.right <= win.innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= win.innerHeight + 1,
                `${label}: More panel fits its viewport`);
            const controls = [...overflow.querySelectorAll('button,input')].filter(element => rect(element).width > 0);
            for (const element of [controls[0], controls.at(-1)]) {
                const bounds = rect(element);
                check(element.contains(doc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
                    `${label}: ${element.id} hit-tests inside More`);
            }
        };
        const menuItems = () => [...popup.querySelectorAll('button')].filter(item => !item.disabled);
        const scrollWithVisibleTrigger = async label => {
            const previousScroll = viewport.scrollLeft;
            const anchor = rect(trigger);
            const clip = rect(viewport);
            const maximum = viewport.scrollWidth - viewport.clientWidth;
            const pinnedMore = more.hidden ? undefined : rect(more);
            let delta = Math.min(24, maximum - previousScroll, Math.max(0, anchor.left - clip.left - 2));
            if (delta < 1) delta = -Math.min(24, previousScroll, Math.max(0, clip.right - anchor.right - 2));
            check(Math.abs(delta) >= 1, `${label}: the toolbar has room to scroll with a visible Screenshot trigger`);
            viewport.scrollLeft = previousScroll + delta;
            await settle();
            check(Math.abs(viewport.scrollLeft - previousScroll) >= 1, `${label}: horizontal scrolling moves while Screenshot is open`);
            check(visibleInToolbar(trigger), `${label}: scrolling keeps the Screenshot trigger visible`);
            if (pinnedMore) {
                const current = rect(more);
                check(Math.abs(current.left - pinnedMore.left) < 1 && Math.abs(current.right - pinnedMore.right) < 1 &&
                    more.contains(doc.elementFromPoint(current.left + current.width / 2, current.top + current.height / 2)),
                    `${label}: More stays pinned and clickable during horizontal toolbar scrolling`);
            }
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
        // Let search's smooth centering complete before the separate page jump;
        // older Chromium otherwise keeps both scrolling requests in flight.
        await pause(900);
        page.value = '3';
        page.dispatchEvent(new win.Event('change', { bubbles: true }));
        await pause(900); // Production page navigation uses smooth scrolling.
        await waitFor(() => Math.abs(rect(byId('page-3')).top - rect(byId('pdf-container')).top) < 2,
            'page 3 scroll alignment');
        check(page.value === '3', 'Fixture navigation reaches page 3 before resizing',
            { value: page.value, page: rect(byId('page-3')).toJSON(), container: rect(byId('pdf-container')).toJSON() });
        const originalSearch = search;
        const originalPage = page;
        const originalZoom = zoom;
        const expectedZoom = zoom.value;

        for (const width of [1600, 1200, 900, 768, 600, 480, 360, 320, 768, 1600]) {
            frame.style.width = `${width}px`;
            await waitFor(() => win.innerWidth === width, `viewport resize to ${width}px`);
            await settle();
            await closeMore();
            check(doc.documentElement.scrollWidth <= width + 1, `${width}px: the document does not overflow horizontally`);
            check(byId('search-input') === originalSearch && byId('page-input') === originalPage && byId('zoom-display') === originalZoom,
                `${width}px: resizing preserves the existing inputs`);
            check(search.value === 'PDF Toolkit' && byId('search-results').textContent === '1 of 5', `${width}px: resizing preserves search text and results`);
            check(page.value === '3' && zoom.value === expectedZoom, `${width}px: resizing preserves page and zoom state`);
            for (const id of coreGroups) {
                check(byId(id) === originalGroups.get(id) && byId(id).parentElement === toolbar,
                    `${width}px: core ${id} remains in the toolbar`);
            }
            const removed = secondaryPriority.filter(id => byId(id).parentElement === overflow);
            check(JSON.stringify(removed) === JSON.stringify(secondaryPriority.slice(0, removed.length)),
                `${width}px: secondary controls move in removal priority`, { removed, secondaryPriority });
            check(secondaryPriority.every(id => byId(id) === originalGroups.get(id) &&
                (byId(id).parentElement === toolbar || byId(id).parentElement === overflow)),
                `${width}px: relocation preserves every secondary control group`);
            const displayedOverflow = [...overflow.children].map(element => element.id).filter(id => secondaryPriority.includes(id));
            check(JSON.stringify(displayedOverflow) === JSON.stringify(secondaryDisplayOrder.filter(id => removed.includes(id))),
                `${width}px: More preserves the familiar toolbar control order`, { displayedOverflow });
            check(more.hidden === (removed.length === 0), `${width}px: More appears exactly when secondary controls overflow`);
            if (width === 1600) check(removed.length === 0, `${width}px: a wide toolbar restores all secondary controls inline`);
            if (width === 320) check(removed.length === 4, `${width}px: all secondary controls move into More before core scrolling`);
            if (removed.length) {
                const bounds = rect(more);
                check(more.parentElement === viewport.parentElement && bounds.left >= -1 && bounds.right <= width + 1 &&
                    more.contains(doc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
                    `${width}px: More stays pinned and clickable outside the toolbar scroller`);
                more.click();
                await settle();
                assertMore(`${width}px`);
                const firstControl = overflow.querySelector('button,input');
                firstControl.focus();
                key(firstControl, 'Escape');
                check(more.getAttribute('aria-expanded') === 'false' && doc.activeElement === more,
                    `${width}px: Escape closes More and restores its trigger focus`);
            }
            const centers = ['prev-page', 'page-input', 'next-page', 'zoom-display', 'search-input', 'screenshot-btn', 'browse-extracted-btn']
                .filter(id => toolbar.contains(byId(id)))
                .map(id => { const bounds = rect(byId(id)); return bounds.top + bounds.height / 2; });
            check(Math.max(...centers) - Math.min(...centers) < 2, `${width}px: inline toolbar controls stay on one row`);
            if (width === 1600) check(viewport.scrollWidth <= viewport.clientWidth + 1, `${width}px: a wide toolbar does not require scrolling`);
            if (width === 320) check(viewport.scrollWidth > viewport.clientWidth, `${width}px: narrow panes retain horizontal scrolling`);

            for (const id of ['prev-page', 'search-input', 'screenshot-btn', 'browse-extracted-btn']) {
                if (!overflow.contains(byId(id))) await closeMore();
                await openMoreFor(byId(id));
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
                const visible = overflow.contains(byId(id)) ? visibleInOverflow(byId(id)) : visibleInToolbar(byId(id));
                check(doc.activeElement === byId(id) && visible,
                    `${width}px: focus handler reveals ${id}`, { before, after, events: focusEvents.slice(eventStart) });
            }
            await closeMore();
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
            check(doc.activeElement === search && (overflow.contains(search) ? visibleInOverflow(search) : visibleInToolbar(search)),
                `${width}px: Ctrl+F handler reveals and focuses search`);
            if (overflow.contains(search)) check(more.getAttribute('aria-expanded') === 'true', `${width}px: Ctrl+F opens More for relocated search`);
            samples.push({ width, toolbarWidth: toolbar.scrollWidth, viewportWidth: viewport.clientWidth,
                scrollLeft: viewport.scrollLeft, page: page.value, query: search.value, overflowGroups: removed });
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

        // Relocated controls must continue to operate on the same PDF and keep
        // their state when restored to the inline toolbar.
        frame.style.width = '320px';
        await waitFor(() => win.innerWidth === 320, 'More action test width');
        await settle();
        await openMoreFor(byId('rotate-cw'));
        byId('rotate-cw').click();
        check([...doc.querySelectorAll('.page-wrapper')].every(element => element.classList.contains('rotated-90')),
            'Rotate Clockwise operates from More on every rendered PDF page');
        await openMoreFor(byId('dark-mode'));
        byId('dark-mode').click();
        check(byId('pdf-container').classList.contains('dark-mode') && byId('dark-mode').title.includes('Light') &&
            byId('dark-mode').getAttribute('aria-pressed') === 'true',
            'Dark Mode operates from More and updates its existing button state');
        frame.style.width = '1600px';
        await waitFor(() => win.innerWidth === 1600, 'restored rotation and appearance controls');
        await settle();
        check([...doc.querySelectorAll('.page-wrapper')].every(element => element.classList.contains('rotated-90')) &&
            byId('pdf-container').classList.contains('dark-mode'), 'Rotation and dark appearance persist when controls return inline');
        check(byId('rotation-controls') === originalGroups.get('rotation-controls') &&
            byId('appearance-controls') === originalGroups.get('appearance-controls'), 'Action controls retain their DOM identity after More use');
        byId('rotate-ccw').click();
        byId('dark-mode').click();
        check(!doc.querySelector('.rotated-90') && !byId('pdf-container').classList.contains('dark-mode') &&
            byId('dark-mode').getAttribute('aria-pressed') === 'false',
            'Restored inline rotation and appearance controls retain their action listeners');

        // Search is a form control in a group, so panel keyboard handling must
        // leave native editing keys available and preserve its selection.
        frame.style.width = '320px';
        await waitFor(() => win.innerWidth === 320, 'More input keyboard test width');
        await settle();
        const lastPageBeforeZoom = byId('page-5');
        zoom.focus();
        zoom.value = '125%';
        key(zoom, 'Enter');
        await waitFor(() => byId('page-5') !== lastPageBeforeZoom &&
            doc.querySelector('#page-5 .textLayer')?.childElementCount > 0, '125 percent PDF rerender');
        check(zoom.value === '125%', 'Core zoom remains operable while secondary controls overflow');
        await openMoreFor(byId('zoom-reset'));
        const lastPageBeforeReset = byId('page-5');
        byId('zoom-reset').click();
        await waitFor(() => byId('page-5') !== lastPageBeforeReset &&
            doc.querySelector('#page-5 .textLayer')?.childElementCount > 0, 'More Reset Zoom PDF rerender');
        check(zoom.value === expectedZoom, 'Reset Zoom operates from More and rerenders the actual PDF at its default scale');
        await openMoreFor(byId('toggle-outline'));
        byId('toggle-outline').click();
        check(byId('outline-panel').classList.contains('show') && byId('toggle-outline').getAttribute('aria-expanded') === 'true',
            'Outline operates from More and announces its expanded state');
        byId('toggle-outline').click();
        check(!byId('outline-panel').classList.contains('show') && byId('toggle-outline').getAttribute('aria-expanded') === 'false',
            'Outline can be closed again from the same More control');
        await openMoreFor(search);
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        await waitFor(() => doc.querySelector('#page-5 .textLayer .highlight'), 'refreshed search highlights after zoom rerender');
        await pause(900);
        await assertSelectedMatchVisible(1, 'Refreshed search after zoom');
        byId('search-next').click();
        check(byId('search-results').textContent === '2 of 5', 'Search Next retains its existing action in More');
        check(page.value === '2', 'Search Next updates the page indicator to its match before smooth scrolling');
        await pause(900);
        // The existing scroll tracker reports the top visible page; centering
        // a match near a page heading can leave the previous page at the top.
        await assertSelectedMatchVisible(2, 'Search Next from More');
        byId('search-prev').click();
        check(byId('search-results').textContent === '1 of 5', 'Search Previous retains its existing action in More');
        check(page.value === '1', 'Search Previous updates the page indicator to its match before smooth scrolling');
        await pause(900);
        await assertSelectedMatchVisible(1, 'Search Previous from More');
        page.value = '3';
        page.dispatchEvent(new win.Event('change', { bubbles: true }));
        await pause(900);
        await openMoreFor(search);
        search.focus();
        search.setSelectionRange(2, 7);
        const pageBeforeEditing = page.value;
        for (const value of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
            const event = key(search, value);
            check(!event.defaultPrevented && doc.activeElement === search && page.value === pageBeforeEditing &&
                search.selectionStart === 2 && search.selectionEnd === 7,
                `More input ${value} remains available to native text editing without PDF navigation`);
        }
        const tabInForm = key(search, 'Tab');
        check(!tabInForm.defaultPrevented && more.getAttribute('aria-expanded') === 'true',
            'Tab inside the More form remains available to native control traversal');
        await closeMore();

        // The input event's existing 300ms debounce is intentionally still
        // pending when the focused search group moves into More.
        frame.style.width = '1600px';
        await waitFor(() => win.innerWidth === 1600, 'inline search before pending query');
        await settle();
        search.focus();
        search.value = 'PDF Toolkit test page 4';
        search.setSelectionRange(4, 11);
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        frame.style.width = '320px';
        await waitFor(() => win.innerWidth === 320, 'focused search moving into More');
        await settle();
        check(byId('search-input') === originalSearch && overflow.contains(search) && doc.activeElement === search &&
            search.value === 'PDF Toolkit test page 4' && search.selectionStart === 4 && search.selectionEnd === 11,
            'Focused search moving into More preserves DOM identity, query and caret selection');
        check(more.getAttribute('aria-expanded') === 'true' && visibleInOverflow(search),
            'Moving a focused search into overflow opens More and reveals the input');
        await waitFor(() => byId('search-results').textContent === '1 of 1', 'pending search debounce after relocation');
        await pause(900);
        await assertSelectedMatchVisible(4, 'Pending search after relocation');
        const settledPage = page.value;
        frame.style.width = '1600px';
        await waitFor(() => win.innerWidth === 1600, 'focused search returning inline');
        await settle();
        check(toolbar.contains(search) && doc.activeElement === search && search.selectionStart === 4 && search.selectionEnd === 11 &&
            search.value === 'PDF Toolkit test page 4' && byId('search-results').textContent === '1 of 1' && page.value === settledPage && zoom.value === expectedZoom,
            'Returning focused search inline preserves caret, query, results, page and zoom');

        // The visible native split-divider test exposed a Chromium case where
        // moving an input retains focus but selects its whole value. Model that
        // browser boundary here because inactive fixture frames normally blur.
        const insertBefore = overflow.insertBefore;
        let focusPreservedMoves = 0;
        overflow.insertBefore = function (element, next) {
            const result = insertBefore.call(this, element, next);
            if (element.contains(search)) {
                search.focus({ preventScroll: true });
                search.select();
                focusPreservedMoves++;
            }
            return result;
        };
        try {
            frame.style.width = '320px';
            await waitFor(() => win.innerWidth === 320, 'focus-preserving search relocation');
            await settle();
            check(focusPreservedMoves === 1 && doc.activeElement === search && overflow.contains(search),
                'Focus-preserved relocation model exercises the real search group move');
            check(search.selectionStart === 4 && search.selectionEnd === 11 && search.value === 'PDF Toolkit test page 4',
                'Relocation restores the saved range when the browser retains input focus but changes selection');
        } finally {
            overflow.insertBefore = insertBefore;
        }

        // Observe the actual node identities. An unnecessary remove/reinsert
        // can end an OS composition even if the final parent and caret look
        // unchanged, and inactive test windows may suppress its focus events.
        frame.style.width = '320px';
        await waitFor(() => win.innerWidth === 320, 'stable overflow result-update width');
        await settle();
        const searchGroup = originalGroups.get('search-controls');
        const searchMoves = [];
        const movementObserver = new win.MutationObserver(records => {
            for (const record of records) {
                if ([...record.removedNodes].some(node => node === searchGroup || node.contains(search))) {
                    searchMoves.push({ from: record.target.id, width: win.innerWidth });
                }
            }
        });
        movementObserver.observe(doc.body, { childList: true, subtree: true });
        try {
            const originalParent = searchGroup.parentElement;
            check(originalParent === overflow && doc.activeElement === search,
                'The result-update regression starts with focused search already in More');
            const resultBefore = byId('search-results').textContent;
            const focusBeforeResult = focusEvents.length;
            byId('search-results').textContent = `${resultBefore} `;
            await settle();
            byId('search-results').textContent = resultBefore;
            await settle();
            check(searchMoves.length === 0 && searchGroup.parentElement === originalParent && doc.activeElement === search &&
                search.selectionStart === 4 && search.selectionEnd === 11,
                'Result updates without a placement change leave the focused search attached with its caret intact', { searchMoves });
            check(!focusEvents.slice(focusBeforeResult).some(event => event.id === search.id),
                'Result updates without a placement change do not refocus the search input');

            frame.style.width = '1600px';
            await waitFor(() => win.innerWidth === 1600, 'inline composition starting width');
            await settle();
            const compositionParent = searchGroup.parentElement;
            check(compositionParent === toolbar && doc.activeElement === search,
                'The composition regression starts with focused inline search');
            const movesBeforeComposition = searchMoves.length;
            const focusBeforeComposition = focusEvents.length;
            search.dispatchEvent(new win.CompositionEvent('compositionstart', { bubbles: true, data: '2' }));
            search.value = 'PDF Toolkit test page 2';
            search.setSelectionRange(5, 13);
            search.dispatchEvent(new win.InputEvent('input', { bubbles: true, isComposing: true,
                inputType: 'insertCompositionText', data: '2' }));
            frame.style.width = '320px';
            await waitFor(() => win.innerWidth === 320, 'resize during search composition');
            await settle();
            await pause(350); // Beyond the real search debounce, while composing.
            check(byId('search-results').textContent === '1 of 1' && searchMoves.length === movesBeforeComposition &&
                searchGroup.parentElement === compositionParent && doc.activeElement === search &&
                search.value === 'PDF Toolkit test page 2' && search.selectionStart === 5 && search.selectionEnd === 13,
                'Composing search defers relocation through narrow resize and pending result updates without losing query or caret',
                { searchMoves, parent: searchGroup.parentElement.id });
            const completedMatches = [...doc.querySelectorAll('.textLayer .highlight.selected')];
            check(completedMatches.length > 0 && completedMatches.every(element => byId('page-4').contains(element)),
                'Partial composition does not replace the completed query or navigate the PDF');
            // Result-label updates still must not relocate the composing input.
            byId('search-results').textContent = '1 of 1 ';
            await settle();
            byId('search-results').textContent = '1 of 1';
            await settle();
            check(searchMoves.length === movesBeforeComposition && searchGroup.parentElement === compositionParent,
                'Result updates during composition keep Search attached until composition ends');
            check(!focusEvents.slice(focusBeforeComposition).some(event => event.id === search.id),
                'Deferred composition layout does not refocus its input');
            search.dispatchEvent(new win.CompositionEvent('compositionend', { bubbles: true, data: '2' }));
            await settle();
            check(secondaryPriority.every(id => byId(id).parentElement === overflow) && overflow.contains(search) &&
                more.getAttribute('aria-expanded') === 'true' && doc.activeElement === search &&
                search.value === 'PDF Toolkit test page 2' && search.selectionStart === 5 && search.selectionEnd === 13,
                'Composition end applies normal overflow priority while preserving the focused query and caret');
            await waitFor(() => !!doc.querySelector('#page-2 .textLayer .highlight.selected'), 'completed composition query');
            await pause(900);
            await assertSelectedMatchVisible(2, 'Composing query after composition end');
            search.dispatchEvent(new win.CompositionEvent('compositionstart', { bubbles: true, data: '2' }));
            key(search, 'Escape', { isComposing: false });
            check(more.getAttribute('aria-expanded') === 'true' && doc.activeElement === search &&
                search.value === 'PDF Toolkit test page 2',
                'Known composition keeps More open even when a key event lacks its composing flag');
            search.dispatchEvent(new win.CompositionEvent('compositionend', { bubbles: true, data: '2' }));
            const queryBeforeEscape = search.value;
            const resultsBeforeEscape = byId('search-results').textContent;
            key(search, 'Escape');
            check(more.getAttribute('aria-expanded') === 'false' && doc.activeElement === more &&
                search.value === queryBeforeEscape && byId('search-results').textContent === resultsBeforeEscape,
                'Escape from More search closes the panel and returns More focus while preserving query and results');
            frame.style.width = '1600px';
            await waitFor(() => win.innerWidth === 1600, 'inline Escape behavior width');
            await settle();
            search.focus();
            key(search, 'Escape');
            check(search.value === '' && byId('search-results').textContent === '',
                'Escape in inline search retains its existing query-clearing behavior');
        } finally {
            movementObserver.disconnect();
        }

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
        frame.style.height = `${fixtureHeight}px`;
        await waitFor(() => win.innerHeight === fixtureHeight, 'restored editor height');
        await settle();

        // A focused, unfinished input should survive a size change too.
        zoom.focus();
        zoom.value = '137%';
        frame.style.width = '320px';
        await waitFor(() => win.innerWidth === 320, 'focused input resize');
        await settle();
        check(doc.activeElement === zoom && zoom.value === '137%', 'Resize preserves focus and an unfinished zoom value');
        api.postMessage({ type: 'toolbarTestResult', ok: true, viewportHeight: fixtureHeight, assertions, samples, focusSamples, focusEvents,
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
