interface PreviewViewport {
    width: number;
    height: number;
    scale: number;
}
interface PreviewRenderTask {
    promise: Promise<unknown>;
    cancel(): void;
}
interface PreviewPage {
    getViewport(options: { scale: number }): PreviewViewport;
    render(options: { canvasContext: CanvasRenderingContext2D; viewport: PreviewViewport }): PreviewRenderTask;
    getTextContent(): Promise<unknown>;
}
interface PreviewTextTask {
    render(): Promise<unknown>;
    cancel(): void;
    textDivs: HTMLElement[];
    textContentItemsStr: string[];
}
export interface PdfPreviewOptions {
    container: HTMLElement;
    getDocument: () => { numPages: number; getPage(page: number): Promise<PreviewPage> };
    getScale: () => number;
    getRotation: () => number;
    getCurrentPage: () => number;
    createTextLayer: (options: { textContentSource: unknown; container: HTMLElement; viewport: PreviewViewport }) => PreviewTextTask;
    onText: (page: number, data: { textDivs: HTMLElement[]; textContentItemsStr: string[] }) => void;
    onEvict: (page: number) => void;
    onError: (message: string) => void;
}

/** Serialized, bounded preview cache. Keep runtime helpers inside for webview serialization. */
export function setupPdfPreview(options: PdfPreviewOptions): {
    reset(): Promise<void>;
    ensurePage(page: number): Promise<void>;
    scrollToPage(page: number): Promise<void>;
    refresh(): void;
    dispose(): void;
} {
    // At most 96 MB of RGBA preview pixels per panel, including the active render.
    // PDF decoding and export use separate PDF.js resources; never clean up shared page.objs here.
    const maxPages = 12;
    const maxPagePixels = 8_000_000;
    const maxPixels = 24_000_000;
    const maxDimension = 8192;
    const maxScrollExtent = 8_000_000;
    const gap = 20;
    const labelHeight = 30;
    const container = options.container;
    const ownerDocument = container.ownerDocument;
    type Entry = {
        page: number; generation: number; wrapper: HTMLElement; content: HTMLElement;
        label: HTMLElement; canvas?: HTMLCanvasElement; textLayer?: HTMLElement;
        renderTask?: PreviewRenderTask; textTask?: PreviewTextTask; pixels: number;
        state: 'idle' | 'queued' | 'working' | 'ready' | 'error';
        done: Promise<void>; finish: () => void; settled: boolean;
    };
    const entries = new Map<number, Entry>();
    // Measurements are numbers only, never PDF page proxies, canvases, or text arrays.
    const heights = new Map<number, { width: number; height: number }>();
    const topSpacer = ownerDocument.createElement('div');
    const bottomSpacer = ownerDocument.createElement('div');
    for (const spacer of [topSpacer, bottomSpacer]) {
        spacer.className = 'preview-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.flex = '0 0 auto';
        spacer.style.width = '1px';
    }
    let disposed = false;
    let generation = 0;
    let navigation = 0;
    let count = 0;
    let center = 1;
    let first = 1;
    let last = 0;
    let pixels = 0;
    let queue: Entry[] = [];
    let pumping = false;
    let frame = 0;
    let beforeHeight = 0;
    let afterHeight = 0;
    let beforeLogical = 0;
    let afterLogical = 0;
    let estimateWidth = 918;
    let estimateHeight = 1218;

    function current(entry: Entry): boolean {
        return !disposed && entry.generation === generation && entries.get(entry.page) === entry;
    }
    function validPage(page: number): boolean {
        return Number.isSafeInteger(page) && page >= 1 && page <= count;
    }
    function safeExtent(value: number): number {
        return Math.min(1e300, Math.max(0, value));
    }
    function prefix(page: number): number {
        let value = safeExtent(page * (estimateHeight + gap));
        for (const [number, size] of heights) {
            if (number <= page) value = safeExtent(value + size.height - estimateHeight);
        }
        return value;
    }
    function pageAt(offset: number): number {
        let low = 1;
        let high = count;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (prefix(middle) <= offset) low = middle + 1;
            else high = middle;
        }
        return low;
    }
    function applyRotation(entry: Entry): void {
        entry.wrapper.classList.remove('rotated-90', 'rotated-180', 'rotated-270');
        const rotation = options.getRotation();
        if (rotation === 90 || rotation === 180 || rotation === 270) {
            entry.wrapper.classList.add('rotated-' + rotation);
        }
    }
    function release(entry: Entry): void {
        // Cancel both kinds of PDF.js task before dropping any DOM/text references.
        entry.renderTask?.cancel();
        entry.textTask?.cancel();
        if (entry.canvas) {
            entry.canvas.width = 0;
            entry.canvas.height = 0;
            entry.canvas.remove();
            entry.canvas = undefined;
        }
        if (entry.textLayer) {
            entry.textLayer.replaceChildren();
            entry.textLayer.remove();
            entry.textLayer = undefined;
        }
        pixels -= entry.pixels;
        entry.pixels = 0;
        options.onEvict(entry.page);
    }
    function remove(entry: Entry): void {
        entries.delete(entry.page);
        release(entry);
        entry.wrapper.remove();
        entry.finish();
    }
    function makeEntry(page: number): Entry {
        const wrapper = ownerDocument.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.id = 'page-' + page;
        wrapper.dataset.page = String(page);
        wrapper.style.flex = '0 0 auto';
        const content = ownerDocument.createElement('div');
        content.className = 'page-content';
        const size = heights.get(page);
        content.style.width = (size?.width ?? estimateWidth) + 'px';
        content.style.height = Math.max(1, (size?.height ?? estimateHeight) - labelHeight) + 'px';
        const label = ownerDocument.createElement('div');
        label.className = 'page-number';
        label.textContent = 'Page ' + page + ' of ' + count;
        wrapper.append(content, label);
        let finish = () => {};
        const done = new Promise<void>(resolve => { finish = resolve; });
        const entry: Entry = { page, generation, wrapper, content, label, pixels: 0, state: 'idle', done, finish, settled: false };
        applyRotation(entry);
        return entry;
    }
    function updateSpacers(): void {
        beforeLogical = prefix(first - 1);
        afterLogical = Math.max(0, prefix(count) - prefix(last));
        // Browsers have finite scroll ranges. Compress only distant placeholders; the
        // mounted pages retain their real CSS dimensions and text selection geometry.
        const distant = safeExtent(beforeLogical + afterLogical);
        const factor = distant > maxScrollExtent ? maxScrollExtent / distant : 1;
        beforeHeight = Math.max(0, beforeLogical * factor - gap);
        afterHeight = Math.max(0, afterLogical * factor - gap);
        topSpacer.style.height = beforeHeight + 'px';
        bottomSpacer.style.height = afterHeight + 'px';
        topSpacer.style.display = first > 1 ? 'block' : 'none';
        bottomSpacer.style.display = last < count ? 'block' : 'none';
    }
    function priority(entry: Entry): number {
        return Math.abs(entry.page - center);
    }
    function schedule(): void {
        queue = Array.from(entries.values()).filter(entry => entry.state === 'idle' || entry.state === 'queued');
        queue.sort((a, b) => priority(a) - priority(b) || a.page - b.page);
        for (const entry of queue) {
            if (entry.settled) {
                entry.done = new Promise<void>(resolve => { entry.finish = resolve; });
                entry.settled = false;
            }
            entry.state = 'queued';
        }
        void pump();
    }
    function windowAround(page: number, preservePosition = false): void {
        if (disposed || !validPage(page)) return;
        const previousCenter = center;
        center = page;
        const nextFirst = Math.max(1, Math.min(page - 5, count - maxPages + 1));
        const nextLast = Math.min(count, nextFirst + maxPages - 1);
        const oldAnchor = entries.get(page)?.wrapper.getBoundingClientRect().top;
        for (const entry of entries.values()) {
            if (entry.page < nextFirst || entry.page > nextLast) remove(entry);
        }
        const changed = first !== nextFirst || last !== nextLast || container.firstElementChild !== topSpacer;
        first = nextFirst;
        last = nextLast;
        for (let number = first; number <= last; number++) {
            if (!entries.has(number)) entries.set(number, makeEntry(number));
        }
        updateSpacers();
        // Reuse existing wrappers and their text selections when the window moves.
        if (changed) container.replaceChildren(topSpacer, ...Array.from(entries.values()).sort((a, b) => a.page - b.page).map(entry => entry.wrapper), bottomSpacer);
        if (preservePosition && oldAnchor !== undefined) {
            const newAnchor = entries.get(page)!.wrapper.getBoundingClientRect().top;
            container.scrollTop += newAnchor - oldAnchor;
        } else if (preservePosition && changed) {
            entries.get(page)!.wrapper.scrollIntoView({ block: 'start' });
        }
        if (changed || previousCenter !== center) schedule();
    }
    function remember(entry: Entry, viewport: PreviewViewport): void {
        const anchor = entries.get(center)?.wrapper;
        const oldTop = anchor?.getBoundingClientRect().top;
        entry.content.style.width = viewport.width + 'px';
        entry.content.style.height = viewport.height + 'px';
        entry.content.style.setProperty('--total-scale-factor', String(viewport.scale));
        heights.delete(entry.page);
        heights.set(entry.page, { width: viewport.width, height: viewport.height + labelHeight });
        if (heights.size > 512) heights.delete(heights.keys().next().value!);
        updateSpacers();
        if (anchor && oldTop !== undefined) container.scrollTop += anchor.getBoundingClientRect().top - oldTop;
    }
    function reserve(entry: Entry, area: number): boolean {
        const victims = Array.from(entries.values()).filter(other => other !== entry && other.pixels > 0 && other.state === 'ready')
            .sort((a, b) => priority(b) - priority(a));
        for (const victim of victims) {
            if (pixels + area <= maxPixels) break;
            if (priority(victim) <= priority(entry)) break;
            release(victim);
            victim.state = 'idle';
        }
        if (pixels + area > maxPixels) return false;
        pixels += area;
        entry.pixels = area;
        return true;
    }
    async function render(entry: Entry): Promise<void> {
        let allocatedCanvas: HTMLCanvasElement | undefined;
        try {
            const page = await options.getDocument().getPage(entry.page);
            if (!current(entry)) return;
            const scale = options.getScale() * 1.5;
            if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid preview scale.');
            const viewport = page.getViewport({ scale });
            if (![viewport.width, viewport.height, viewport.scale].every(value => Number.isFinite(value) && value > 0)) {
                throw new Error('Invalid page dimensions.');
            }
            remember(entry, viewport);
            // Divide before multiplying: even finite PDF/UserUnit dimensions can have
            // an infinite product. Flooring ensures the allocation stays under each cap.
            const ratio = Math.min(1, maxDimension / viewport.width, maxDimension / viewport.height,
                Math.sqrt(maxPagePixels / viewport.width) / Math.sqrt(viewport.height));
            const width = Math.max(1, Math.floor(viewport.width * ratio));
            const height = Math.max(1, Math.floor(viewport.height * ratio));
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > maxDimension || height > maxDimension || width * height > maxPagePixels) {
                throw new Error('Invalid page raster dimensions.');
            }
            const rasterViewport = page.getViewport({ scale: scale * ratio });
            if (![rasterViewport.width, rasterViewport.height, rasterViewport.scale].every(value => Number.isFinite(value) && value > 0)) {
                throw new Error('Invalid page raster viewport.');
            }
            // A newly created canvas briefly owns its default 300 by 150 backing store.
            if (!reserve(entry, Math.max(width * height, 45_000))) {
                entry.state = 'idle';
                return;
            }
            const canvas = ownerDocument.createElement('canvas');
            allocatedCanvas = canvas;
            // Zero the default backing store before assigning validated dimensions.
            canvas.width = 0;
            canvas.height = 0;
            canvas.width = width;
            canvas.height = height;
            canvas.className = 'page-canvas';
            canvas.style.width = viewport.width + 'px';
            canvas.style.height = viewport.height + 'px';
            entry.canvas = canvas;
            const textLayer = ownerDocument.createElement('div');
            textLayer.className = 'textLayer';
            textLayer.id = 'text-layer-' + entry.page;
            entry.textLayer = textLayer;
            entry.content.append(canvas, textLayer);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Could not create page preview canvas.');
            entry.renderTask = page.render({ canvasContext: context, viewport: rasterViewport });
            await entry.renderTask.promise;
            entry.renderTask = undefined;
            if (!current(entry)) return;
            const textContent = await page.getTextContent();
            if (!current(entry)) return;
            entry.textTask = options.createTextLayer({ textContentSource: textContent, container: textLayer, viewport });
            await entry.textTask.render();
            if (!current(entry)) return;
            options.onText(entry.page, { textDivs: entry.textTask.textDivs, textContentItemsStr: entry.textTask.textContentItemsStr });
            entry.textTask = undefined;
            entry.state = 'ready';
        } catch (error) {
            if (current(entry)) {
                release(entry);
                entry.state = 'error';
                const message = 'Page ' + entry.page + ': ' + (error instanceof Error ? error.message : String(error));
                entry.label.textContent = message;
                options.onError(message);
            }
        } finally {
            // A canceled task may finish late. It must never repopulate the live cache.
            if (!current(entry) && allocatedCanvas) {
                allocatedCanvas.width = 0;
                allocatedCanvas.height = 0;
            }
            entry.renderTask = undefined;
            entry.textTask = undefined;
            entry.settled = true;
            entry.finish();
        }
    }
    async function pump(): Promise<void> {
        if (pumping || disposed) return;
        pumping = true;
        try {
            while (!disposed && queue.length > 0) {
                const entry = queue.shift()!;
                if (!current(entry) || entry.state !== 'queued') continue;
                entry.state = 'working';
                await render(entry);
            }
        } finally {
            pumping = false;
        }
    }
    function visiblePage(): number {
        const bounds = container.getBoundingClientRect();
        const probe = bounds.top + Math.min(100, container.clientHeight / 2);
        for (let page = first; page <= last; page++) {
            const rect = entries.get(page)!.wrapper.getBoundingClientRect();
            if (rect.top <= probe && rect.bottom > bounds.top) return page;
        }
        if (beforeHeight > 0 && container.scrollTop < beforeHeight) {
            return pageAt(beforeLogical * Math.max(0, container.scrollTop) / beforeHeight);
        }
        const bottomTop = bottomSpacer.getBoundingClientRect().top - bounds.top + container.scrollTop;
        if (afterHeight > 0 && container.scrollTop >= bottomTop) {
            return pageAt(prefix(last) + afterLogical * Math.min(1, (container.scrollTop - bottomTop) / afterHeight));
        }
        return center;
    }
    function refresh(): void {
        if (disposed || count === 0) return;
        for (const entry of entries.values()) applyRotation(entry);
        windowAround(visiblePage(), true);
    }
    function onScroll(): void {
        if (!frame && !disposed) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    }
    async function ensurePage(page: number): Promise<void> {
        if (disposed || !validPage(page)) return;
        if (!entries.has(page) || entries.get(page)!.state !== 'ready') windowAround(page, true);
        const entry = entries.get(page)!;
        if (entry.state === 'idle') schedule();
        await entry.done;
    }
    async function scrollToPage(page: number): Promise<void> {
        if (disposed || !validPage(page)) return;
        const request = ++navigation;
        windowAround(page);
        const entry = entries.get(page)!;
        entry.wrapper.scrollIntoView({ block: 'start' });
        await ensurePage(page);
        if (request === navigation && current(entry)) entry.wrapper.scrollIntoView({ block: 'start' });
    }
    async function reset(): Promise<void> {
        if (disposed) return;
        generation++;
        navigation++;
        queue = [];
        for (const entry of entries.values()) remove(entry);
        container.replaceChildren();
        heights.clear();
        count = options.getDocument().numPages;
        if (!Number.isSafeInteger(count) || count < 1) {
            count = 0;
            container.replaceChildren();
            options.onError('Invalid PDF page count.');
            return;
        }
        const scale = options.getScale() * 1.5;
        estimateWidth = Number.isFinite(scale) && scale > 0 ? 612 * scale : 918;
        estimateHeight = Number.isFinite(scale) && scale > 0 ? 792 * scale + labelHeight : 1218;
        const selected = options.getCurrentPage();
        windowAround(validPage(selected) ? selected : 1);
        entries.get(center)!.wrapper.scrollIntoView({ block: 'start' });
        await Promise.all(Array.from(entries.values(), entry => entry.done));
    }
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        generation++;
        navigation++;
        queue = [];
        if (frame) cancelAnimationFrame(frame);
        container.removeEventListener('scroll', onScroll);
        for (const entry of entries.values()) remove(entry);
        heights.clear();
        container.replaceChildren();
    }
    container.addEventListener('scroll', onScroll, { passive: true });
    return { reset, ensurePage, scrollToPage, refresh, dispose };
}
