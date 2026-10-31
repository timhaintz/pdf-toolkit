const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const providerSource = readFileSync(path.resolve(__dirname, '../src/pdfEditorProvider.ts'), 'utf8');
const searchSource = providerSource.slice(
    providerSource.indexOf('        async function performSearch('),
    providerSource.indexOf('        // Outline functions')
);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
};

// Execute the actual webview search/highlight functions. Only mounted text spans
// have DOM adapters; a large text-content fixture never creates a large DOM.
function harness(config = {}) {
    const resident = {};
    const ensured = [];
    const requested = [];
    const scrolls = [];
    const messages = [];
    const listeners = new Map();
    const results = { textContent: '' };

    class Node {
        constructor(tag, text = '') {
            this.tag = tag;
            this.children = [];
            this.value = text;
            this.className = '';
            this.dataset = {};
            this.style = {};
        }
        get textContent() {
            return this.children.length ? this.children.map(child => child.textContent).join('') : this.value;
        }
        set textContent(value) { this.value = value; this.children = []; }
        appendChild(node) {
            if (node.tag === 'fragment') {
                for (const child of node.children) this.appendChild(child);
            } else {
                this.children.push(node);
                node.parentElement = this;
            }
        }
        querySelector() { return this.children.find(child => child.className.split(' ').includes('highlight')); }
        scrollIntoView(options) { scrolls.push({ text: this.textContent, options }); }
    }

    function mount(page, strings, divCount = strings.length) {
        resident[page] = {
            textContentItemsStr: strings,
            textDivs: strings.slice(0, divCount).map(value => new Node('div', value))
        };
    }
    function highlights() {
        return Object.values(resident).flatMap(data => data.textDivs.flatMap(div => div.children))
            .filter(node => node.className.split(' ').includes('highlight'));
    }
    const stringsAt = number => config.strings?.(number) ?? ['ordinary page'];
    const api = runInNewContext(`
        let searchGeneration = 0;
        let matchNavigationGeneration = 0;
        let searchMatches = [];
        let currentMatchIndex = -1;
        let currentPage = 1;
        const pageInput = { value: 1 };
        const pageTextData = resident;
        ${searchSource}
        ({ performSearch, highlightMatches, goToCurrentMatch,
            state: () => ({ searchMatches, currentMatchIndex, currentPage, pageInput }),
            setMatches: matches => { searchMatches = matches; currentMatchIndex = 0; }
        });`, {
        resident, totalPages: config.count ?? 1, DEBUG_ENABLED: false,
        container: { addEventListener: (name, handler) => listeners.set(name, handler) },
        pdfDoc: {
            async getPage(number) {
                requested.push(number);
                return {
                    async getTextContent() {
                        if (config.textContent) await config.textContent(number);
                        return { items: stringsAt(number).map(str => ({ str })) };
                    }
                };
            }
        },
        preview: {
            async ensurePage(number) {
                ensured.push(number);
                if (config.ensurePage) await config.ensurePage(number);
                if (config.mountOnEnsure) mount(number, stringsAt(number));
            }
        },
        document: {
            getElementById(id) {
                if (id === 'search-results') return results;
                const page = Number(id.replace('page-', ''));
                return resident[page] ? { id } : undefined;
            },
            querySelectorAll(selector) {
                const index = selector.match(/data-match-index="(\d+)"/)[1];
                return highlights().filter(node => String(node.dataset.matchIndex) === index);
            },
            createDocumentFragment: () => new Node('fragment'),
            createTextNode: value => new Node('text', value),
            createElement: tag => new Node(tag)
        },
        console: { warn() {} },
        vscode: { postMessage: message => messages.push(structuredClone(message)) },
        setTimeout
    });
    return {
        api, resident, ensured, requested, scrolls, messages, results, mount, highlights,
        wheelIntent() {
            assert.ok(listeners.has('wheel'), 'Exercise the real registered wheel handler');
            listeners.get('wheel')({ type: 'wheel', isTrusted: true });
        },
        state: () => structuredClone(api.state())
    };
}

test('search does not index an inaccessible cross-item match beyond the PDF.js text-layer limit', async () => {
    // PDF.js checks >100000 before appending, so exactly 100001 text divs can
    // exist. The query below starts after the last renderable string.
    const strings = Array(100_001).fill('x');
    strings.push('nee', 'dle');
    const h = harness({ strings: () => strings });
    await h.api.performSearch('needle');
    assert.deepEqual(h.state().searchMatches, []);
    assert.deepEqual(h.ensured, [], 'An inaccessible match must never trigger page navigation');
    assert.equal(h.results.textContent, '');
    assert.equal(Object.keys(h.resident).length, 0, 'The large fixture requires no text DOM');
});

test('search includes the last string that PDF.js can render at the text-layer limit', async () => {
    const strings = Array(100_000).fill('x');
    strings.push('needle', 'unrendered');
    const h = harness({ strings: () => strings });
    await h.api.performSearch('needle');
    assert.deepEqual(h.state().searchMatches, [{
        pageNum: 1, startDivIdx: 100_000, startCharIdx: 0, endDivIdx: 100_000, endCharIdx: 6
    }]);
    assert.deepEqual(h.ensured, [1]);
});

test('highlighting ignores an out-of-range cross-item match without throwing or drawing a partial match', () => {
    for (const strings of [['ab'], ['ab', 'cd', 'ef']]) {
        const h = harness();
        h.mount(1, strings, 1);
        h.api.setMatches([{ pageNum: 1, startDivIdx: 0, startCharIdx: 1, endDivIdx: 2, endCharIdx: 1 }]);
        assert.doesNotThrow(() => h.api.highlightMatches());
        assert.equal(h.highlights().length, 0);
        assert.equal(h.resident[1].textDivs[0].textContent, 'ab');
    }
});

test('legitimate cross-item search highlights each original span and navigates to the selected match', async () => {
    const strings = ['start nee', 'd', 'le finish'];
    const h = harness({ strings: () => strings });
    h.mount(1, strings);
    await h.api.performSearch('needle');
    assert.deepEqual(h.state().searchMatches, [{
        pageNum: 1, startDivIdx: 0, startCharIdx: 6, endDivIdx: 2, endCharIdx: 2
    }]);
    assert.deepEqual(h.highlights().map(node => node.textContent), ['nee', 'd', 'le']);
    assert.ok(h.highlights()[0].className.includes('begin'));
    assert.ok(h.highlights()[1].className.includes('middle'));
    assert.ok(h.highlights()[2].className.includes('end'));
    assert.ok(h.highlights().every(node => node.className.includes('selected')));
    assert.deepEqual(h.resident[1].textDivs.map(div => div.textContent), strings);
    assert.deepEqual(h.ensured, [1]);
    assert.equal(h.scrolls.length, 1);
    assert.equal(h.results.textContent, '1 of 1');
});

test('search discovers a late unmounted page independently of resident preview text', async () => {
    const h = harness({
        count: 25,
        strings: number => number === 25 ? ['late nee', 'dle'] : ['ordinary page'],
        mountOnEnsure: true
    });
    h.mount(1, ['ordinary page']);
    await h.api.performSearch('needle');
    assert.equal(h.requested.length, 25);
    assert.equal(h.state().searchMatches[0].pageNum, 25);
    assert.deepEqual(h.ensured, [25]);
    assert.equal(h.state().currentPage, 25);
    assert.equal(h.scrolls.length, 1);
    assert.deepEqual(h.highlights().map(node => node.textContent), ['nee', 'dle']);
});

test('wheel navigation intent during text search keeps results without later automatic navigation', async () => {
    const gate = deferred();
    const h = harness({ strings: () => ['needle'], textContent: () => gate.promise });
    const searching = h.api.performSearch('needle');
    await tick();
    h.wheelIntent();
    gate.resolve();
    await searching;
    assert.equal(h.state().searchMatches.length, 1);
    assert.equal(h.results.textContent, '1 of 1');
    assert.deepEqual(h.ensured, []);
    assert.equal(h.scrolls.length, 0);
});

test('wheel navigation intent while a search target is rendering suppresses its late scroll', async () => {
    const gate = deferred();
    const h = harness({ count: 2, strings: number => number === 2 ? ['needle'] : ['ordinary page'],
        mountOnEnsure: true, ensurePage: () => gate.promise });
    const searching = h.api.performSearch('needle');
    await tick();
    assert.deepEqual(h.ensured, [2]);
    assert.equal(h.state().currentPage, 2);
    assert.equal(h.state().pageInput.value, 2, 'The target indicator updates immediately while its page is loading');
    h.wheelIntent();
    gate.resolve();
    await searching;
    assert.equal(h.state().searchMatches.length, 1);
    assert.equal(h.scrolls.length, 0, 'Settling an old ensurePage must not scroll against newer wheel intent');
});
