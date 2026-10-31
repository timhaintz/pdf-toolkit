const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { setupPdfPreview } = require('../out/pdfPreview.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// Exercise the actual browser-serialized controller, including allocation setters,
// PDF task boundaries, DOM attachment, and scrolling. No large bitmap is allocated.
function harness(config = {}) {
    const canvases = [];
    const errors = [];
    const published = new Map();
    const evicted = [];
    const requests = [];
    const renders = [];
    const texts = [];
    const stats = { peakPixels: 0, peakWrappers: 0, peakActive: 0, active: 0, renderCancels: 0, textCancels: 0, scrolls: [] };
    let scale = config.scale ?? 1;
    let selected = 1;
    let frame;
    class Element {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.dataset = {};
            this.style = { setProperty(name, value) { this[name] = value; } };
            this.className = '';
            this.id = '';
            this.scrollTop = 0;
            this.clientHeight = 800;
            this.listeners = new Map();
            this.ownerDocument = doc;
            this.classList = {
                add: name => { this.className += ' ' + name; },
                remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); }
            };
        }
        get firstElementChild() { return this.children[0]; }
        setAttribute() {}
        addEventListener(name, fn) { this.listeners.set(name, fn); }
        removeEventListener(name) { this.listeners.delete(name); }
        append(...nodes) {
            for (const node of nodes) {
                node.remove();
                node.parentElement = this;
                this.children.push(node);
            }
            stats.peakWrappers = Math.max(stats.peakWrappers, container?.children.filter(child => child.className.includes('page-wrapper')).length ?? 0);
        }
        replaceChildren(...nodes) {
            for (const child of this.children) child.parentElement = undefined;
            this.children = [];
            this.append(...nodes);
        }
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = undefined;
        }
        get height() {
            if (this.style.display === 'none') return 0;
            if (this.className.includes('page-wrapper')) return this.children.reduce((sum, node) => sum + node.height, 0);
            if (this.className === 'page-number') return 30;
            return Number.parseFloat(this.style.height) || 0;
        }
        getBoundingClientRect() {
            if (this === container) return { top: 0, bottom: 800, height: 800, width: 1000 };
            const parent = this.parentElement;
            let top = 20 - (parent?.scrollTop || 0);
            if (parent && parent !== container) top = parent.getBoundingClientRect().top;
            if (parent === container) {
                for (const sibling of parent.children) {
                    if (sibling === this) break;
                    if (sibling.style.display !== 'none') top += sibling.height + 20;
                }
            }
            return { top, bottom: top + this.height, height: this.height, width: Number.parseFloat(this.style.width) || 1000 };
        }
        scrollIntoView() {
            stats.scrolls.push(this.id);
            container.scrollTop = Math.max(0, container.scrollTop + this.getBoundingClientRect().top - 20);
        }
    }
    function allocation() {
        const pixels = canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
        stats.peakPixels = Math.max(stats.peakPixels, pixels);
        assert.ok(pixels <= 24_000_000, `aggregate resident/in-flight allocation ${pixels}`);
    }
    class Canvas extends Element {
        constructor() {
            super('canvas');
            this.w = 300;
            this.h = 150;
            canvases.push(this);
            allocation();
        }
        get width() { return this.w; }
        set width(value) {
            assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 8192, `canvas width ${value}`);
            this.w = value;
            assert.ok(this.w * this.h <= 8_000_000, 'per-page canvas area');
            allocation();
        }
        get height() { return this.h; }
        set height(value) {
            assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 8192, `canvas height ${value}`);
            this.h = value;
            assert.ok(this.w * this.h <= 8_000_000, 'per-page canvas area');
            allocation();
        }
        getContext() { return { canvas: this }; }
    }
    const doc = { createElement: tag => tag === 'canvas' ? new Canvas() : new Element(tag) };
    let container = new Element('container');
    const pdf = {
        numPages: config.count ?? 5,
        async getPage(number) {
            requests.push(number);
            if (config.beforeGetPage) await config.beforeGetPage(number, requests.length);
            const [width, height] = config.pageSize?.(number) ?? [config.width ?? 240, config.height ?? 320];
            let viewports = 0;
            return {
                getViewport({ scale }) {
                    viewports++;
                    return config.viewport?.(number, scale, viewports) ?? { width: width * scale, height: height * scale, scale };
                },
                cleanup() { throw new Error('Preview must not clear shared PDF page objects used by image exports.'); },
                render(params) {
                    renders.push({ number, ...params });
                    stats.active++;
                    stats.peakActive = Math.max(stats.peakActive, stats.active);
                    const result = config.render?.(number, renders.length) ?? Promise.resolve();
                    return {
                        promise: Promise.resolve(result).finally(() => { stats.active--; }),
                        cancel() { stats.renderCancels++; }
                    };
                },
                async getTextContent() {
                    if (config.textContent) await config.textContent(number);
                    return { number };
                }
            };
        }
    };
    const setup = runInNewContext('(' + setupPdfPreview.toString() + ')', {
        requestAnimationFrame(fn) { frame = fn; return 1; },
        cancelAnimationFrame() { frame = undefined; }
    });
    const preview = setup({
        container,
        getDocument: () => pdf,
        getScale: () => scale,
        getRotation: () => config.rotation ?? 0,
        getCurrentPage: () => selected,
        createTextLayer(params) {
            texts.push(params);
            const task = {
                textDivs: [new Element('span')], textContentItemsStr: ['Page ' + params.textContentSource.number],
                render() { return config.textRender?.(params.textContentSource.number, texts.length) ?? Promise.resolve(); },
                cancel() { stats.textCancels++; }
            };
            params.container.append(...task.textDivs);
            return task;
        },
        onText: (number, data) => published.set(number, data),
        onEvict(number) { published.delete(number); evicted.push(number); },
        onError: message => errors.push(message)
    });
    return {
        preview, container, canvases, errors, published, evicted, requests, renders, texts, stats,
        setScale(value) { scale = value; }, setSelected(value) { selected = value; },
        async scrollToOffset(value) { container.scrollTop = value; container.listeners.get('scroll')(); frame?.(); await tick(); },
        wrappers: () => container.children.filter(child => child.className.includes('page-wrapper'))
    };
}

test('ordinary five-page preview preserves every page, label, text layer and display resolution', async () => {
    const h = harness();
    await h.preview.reset();
    assert.deepEqual(h.requests, [1, 2, 3, 4, 5]);
    assert.equal(h.published.size, 5);
    assert.equal(h.canvases.length, 5);
    assert.equal(h.stats.peakActive, 1);
    for (const [index, wrapper] of h.wrappers().entries()) {
        assert.equal(wrapper.id, 'page-' + (index + 1));
        assert.equal(wrapper.dataset.page, String(index + 1));
        assert.equal(wrapper.children[1].textContent, 'Page ' + (index + 1) + ' of 5');
        const [canvas, textLayer] = wrapper.children[0].children;
        assert.equal(canvas.width, 360);
        assert.equal(canvas.height, 480);
        assert.equal(textLayer.id, 'text-layer-' + (index + 1));
        assert.equal(h.texts[index].viewport.width, 360);
    }
    h.preview.dispose();
    assert.equal(h.published.size, 0);
    assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('long mixed documents mount a bounded window and allow distant page jumps and return navigation', async () => {
    const h = harness({ count: 100_000, pageSize: number => number % 2 ? [240, 320] : [500, 150] });
    await h.preview.reset();
    assert.ok(h.requests.length <= 12);
    await h.preview.scrollToPage(90_000);
    assert.ok(h.wrappers().some(wrapper => wrapper.id === 'page-90000'));
    assert.ok(h.published.has(90_000));
    assert.ok(h.container.scrollTop > 0);
    assert.ok(h.requests.length <= 24);
    assert.ok(h.wrappers().length <= 12);
    assert.ok(h.published.size <= 12);
    assert.ok(h.canvases.slice(0, 12).every(canvas => canvas.width === 0 && canvas.height === 0));
    await h.preview.scrollToPage(2);
    assert.ok(h.published.has(2));
    assert.ok(h.stats.peakWrappers <= 12);
    assert.ok(h.stats.peakActive <= 1);
    assert.equal(h.errors.length, 0);
    h.preview.dispose();
});

test('scrolling through compressed distant placeholders selects an actual far page without eager page proxies', async () => {
    const h = harness({ count: 1_000_000 });
    await h.preview.reset();
    await h.scrollToOffset(4_000_000);
    await tick();
    assert.ok(h.requests.some(page => page > 100_000));
    assert.ok(h.requests.length <= 24);
    assert.ok(h.stats.peakWrappers <= 12);
    assert.ok(Number.isFinite(h.container.scrollTop));
    h.preview.dispose();
});

test('oversized and UserUnit-like viewports are downsampled before allocation while text keeps display geometry', async () => {
    for (const size of [20_000, 1e150]) {
        const h = harness({ count: 40, width: size, height: size });
        await h.preview.reset();
        assert.equal(h.errors.length, 0);
        assert.ok(h.canvases.length >= 2 && h.canvases.length <= 3);
        assert.ok(h.stats.peakPixels <= 24_000_000);
        assert.ok(h.canvases.every(canvas => canvas.width * canvas.height <= 8_000_000));
        const first = h.wrappers().find(wrapper => wrapper.id === 'page-1');
        assert.equal(first.children[0].style.width, size * 1.5 + 'px');
        assert.equal(h.texts[0].viewport.width, size * 1.5);
        assert.ok(h.renders[0].viewport.width <= 8192);
        await h.preview.scrollToPage(30);
        assert.ok(h.published.has(30));
        assert.ok(h.canvases.filter(canvas => canvas.width > 0).length <= 3);
        h.preview.dispose();
    }
});

test('invalid display and raster viewports report a page error before canvas creation', async () => {
    for (const value of [NaN, Infinity, -1, 0]) {
        const h = harness({ count: 1, viewport: (_, scale) => ({ width: value, height: 500, scale }) });
        await h.preview.reset();
        assert.equal(h.canvases.length, 0);
        assert.match(h.errors[0], /Page 1.*Invalid page dimensions/);
        h.preview.dispose();
    }
    const h = harness({ count: 1, viewport: (_, scale, call) => ({ width: call === 2 ? Infinity : 500, height: 500, scale }) });
    await h.preview.reset();
    assert.equal(h.canvases.length, 0);
    assert.match(h.errors[0], /raster viewport/);
    h.preview.dispose();
});

test('zoom generations wait for the old getPage before starting fresh bounded work', async () => {
    const gate = deferred();
    const h = harness({ count: 30, beforeGetPage: (_, call) => call === 1 ? gate.promise : undefined });
    const old = h.preview.reset();
    await tick();
    h.setScale(5);
    const current = h.preview.reset();
    await old;
    assert.equal(h.requests.length, 1, 'new work must wait for the single queue');
    assert.equal(h.canvases.length, 0);
    gate.resolve();
    await current;
    assert.ok(h.canvases.every(canvas => canvas.width === 1800 || canvas.width === 0));
    assert.equal(h.stats.peakActive, 1);
    h.preview.dispose();
});

test('reset cancels raster tasks, releases backing stores and ignores late raster publication', async () => {
    const gate = deferred();
    const h = harness({ count: 5, render: (_, call) => call === 1 ? gate.promise : undefined });
    const old = h.preview.reset();
    await tick();
    assert.equal(h.stats.active, 1);
    const canvas = h.canvases[0];
    h.setScale(2);
    const current = h.preview.reset();
    await old;
    assert.equal(h.stats.renderCancels, 1);
    assert.equal(canvas.width, 0);
    assert.equal(h.canvases.length, 1, 'no overlapping generation allocation while cancellation settles');
    gate.resolve();
    await current;
    assert.equal(canvas.width, 0);
    assert.equal(h.texts.length, 5, 'stale raster must never create a text layer');
    assert.equal(h.stats.peakActive, 1);
    h.preview.dispose();
});

test('reset guards asynchronous text content and cancels active TextLayer before stale completion', async () => {
    for (const stage of ['content', 'layer']) {
        const gate = deferred();
        let first = true;
        const delayed = () => {
            if (!first) return;
            first = false;
            return gate.promise;
        };
        const h = harness({ count: 1, textContent: stage === 'content' ? delayed : undefined, textRender: stage === 'layer' ? delayed : undefined });
        const old = h.preview.reset();
        await tick();
        const current = h.preview.reset();
        await old;
        assert.equal(h.published.size, 0);
        if (stage === 'layer') assert.equal(h.stats.textCancels, 1);
        gate.resolve();
        await current;
        assert.equal(h.published.size, 1);
        assert.equal(h.texts.length, stage === 'layer' ? 2 : 1);
        assert.ok(h.canvases[0].width === 0 && h.canvases[0].height === 0);
        h.preview.dispose();
    }
});

test('closing while work is pending cancels tasks and never reattaches stale content', async () => {
    const gate = deferred();
    const h = harness({ count: 50, textRender: () => gate.promise });
    const pending = h.preview.reset();
    await tick();
    h.preview.dispose();
    await pending;
    assert.equal(h.stats.textCancels, 1);
    gate.resolve();
    await tick();
    assert.equal(h.container.children.length, 0);
    assert.equal(h.published.size, 0);
    assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.ok(h.requests.length <= 1);
});

test('repeated completed zoom resets rebuild mounted wrappers in the same page window', async () => {
    const h = harness();
    await h.preview.reset();
    const oldWrappers = h.wrappers();
    h.setScale(2);
    await h.preview.reset();
    assert.equal(h.wrappers().length, 5);
    assert.ok(h.wrappers().every(wrapper => !oldWrappers.includes(wrapper)));
    assert.ok(h.canvases.slice(0, 5).every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.ok(h.canvases.slice(5).every(canvas => canvas.width === 720 && canvas.height === 960));
    assert.equal(h.published.size, 5);
    h.preview.dispose();
});

test('a deferred page in the mounted window can evict a lower-priority raster and publish fresh text', async () => {
    const h = harness({ count: 40, width: 20_000, height: 20_000 });
    await h.preview.reset();
    assert.equal(h.published.has(5), false);
    await h.preview.ensurePage(5);
    assert.equal(h.published.has(5), true);
    assert.ok(h.published.size <= 3);
    assert.ok(h.stats.peakPixels <= 24_000_000);
    await h.preview.ensurePage(1);
    assert.equal(h.published.has(1), true);
    assert.ok(h.published.size <= 3);
    h.preview.dispose();
});

test('moving the window cancels an in-flight page and serializes the new distant render', async () => {
    const gate = deferred();
    const h = harness({ count: 100, render: (_, call) => call === 1 ? gate.promise : undefined });
    const initial = h.preview.reset();
    await tick();
    const oldCanvas = h.canvases[0];
    const jump = h.preview.scrollToPage(80);
    await initial;
    assert.equal(h.stats.renderCancels, 1);
    assert.equal(oldCanvas.width, 0);
    assert.equal(h.canvases.length, 1);
    gate.resolve();
    await jump;
    assert.ok(h.published.has(80));
    assert.equal(h.published.has(1), false);
    assert.equal(h.stats.peakActive, 1);
    h.preview.dispose();
});


test('late navigation completion cannot scroll back over a newer page request', async () => {
    const gate = deferred();
    const h = harness({ render: (_, call) => call === 1 ? gate.promise : undefined });
    const initial = h.preview.reset();
    await tick();
    const earlier = h.preview.scrollToPage(2);
    const latest = h.preview.scrollToPage(3);
    gate.resolve();
    await Promise.all([initial, earlier, latest]);
    assert.equal(h.stats.scrolls.at(-1), 'page-3');
    h.preview.dispose();
});

test('late page navigation does not undo manual scrolling to an adjacent mounted page', async t => {
    const gate = deferred();
    const h = harness({ render: number => number === 2 ? gate.promise : undefined });
    t.after(() => h.preview.dispose());
    const initial = h.preview.reset();
    await tick();
    assert.equal(h.renders.at(-1).number, 2);
    assert.equal(h.published.has(2), false, 'The navigation target must still be rendering');

    const navigation = h.preview.scrollToPage(2);
    await tick();
    assert.equal(h.stats.scrolls.at(-1), 'page-2');
    const adjacent = h.wrappers().find(wrapper => wrapper.id === 'page-3');
    assert.ok(adjacent, 'Manual scrolling stays within the mounted page window');
    const manualOffset = h.container.scrollTop + adjacent.getBoundingClientRect().top - 20;
    await h.scrollToOffset(manualOffset);
    assert.equal(adjacent.getBoundingClientRect().top, 20);
    const programmaticScrollCount = h.stats.scrolls.length;

    gate.resolve();
    await Promise.all([initial, navigation]);
    assert.equal(h.published.has(2), true, 'The old target still finishes rendering');
    assert.equal(h.stats.scrolls.length, programmaticScrollCount,
        'Completing the old navigation must not issue another programmatic scroll');
    assert.equal(h.container.scrollTop, manualOffset, 'The viewport must remain at the manually chosen adjacent page');
    assert.equal(adjacent.getBoundingClientRect().top, 20);
});
