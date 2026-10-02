const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { planCompositeImages } = require('../out/compositeLayout.js');

const defaults = {
    layout: 'vertical', quality: 1, pagesPerImage: 4, labels: false, padding: 0
};
const options = overrides => ({ ...defaults, ...overrides });
const page = (number, width = 100, height = 200) => ({ page: number, width, height });

test('vertical composites preserve mixed page sizes and center them in uniform cells', () => {
    const pages = [page(2, 100, 200), page(5, 80, 100)];
    const original = structuredClone(pages);
    const [plan] = planCompositeImages(pages, options({ quality: 2, labels: true, padding: 10 }));
    assert.equal(plan.width, 140);
    assert.equal(plan.height, 556);
    assert.deepEqual(plan.pages, [
        { page: 2, width: 100, height: 200, x: 20, y: 20, labelX: 70, labelY: 256 },
        { page: 5, width: 80, height: 100, x: 30, y: 338, labelX: 70, labelY: 524 }
    ]);
    assert.deepEqual(pages, original);
});

test('grid composites use two columns and retain an empty cell for odd page counts', () => {
    const [plan] = planCompositeImages([
        page(1, 100, 200), page(2, 200, 100), page(3, 60, 80)
    ], options({ layout: 'grid', padding: 10 }));
    assert.equal(plan.width, 430);
    assert.equal(plan.height, 430);
    assert.deepEqual(plan.pages.map(({ page, x, y, width, height }) => ({ page, x, y, width, height })), [
        { page: 1, x: 60, y: 10, width: 100, height: 200 },
        { page: 2, x: 220, y: 60, width: 200, height: 100 },
        { page: 3, x: 80, y: 280, width: 60, height: 80 }
    ]);
    const [single] = planCompositeImages([page(1)], options({ layout: 'grid', padding: 10 }));
    assert.equal(single.width, 120);
    assert.equal(single.height, 220);
});

test('grid labels reserve a separate row below each cell and scale with quality', () => {
    const [plan] = planCompositeImages([page(1), page(2), page(3), page(4)],
        options({ layout: 'grid', quality: 3, labels: true, padding: 4 }));
    assert.equal(plan.width, 236);
    assert.equal(plan.height, 580);
    assert.deepEqual(plan.pages.map(({ labelX, labelY }) => [labelX, labelY]), [
        [62, 266], [174, 266], [62, 550], [174, 550]
    ]);
});

test('rounding up page sizes and padding provides integer canvas sizes without clipping', () => {
    const [plan] = planCompositeImages([page(1, 100.2, 200.9)], options({ quality: 2, padding: 0.1 }));
    assert.equal(plan.width, 103);
    assert.equal(plan.height, 203);
    assert.deepEqual(plan.pages[0], {
        page: 1, width: 101, height: 201, x: 1, y: 1, labelX: 51.5, labelY: 202
    });
});

test('page groups follow the requested count and preserve selected page order', () => {
    const pages = [7, 2, 9, 4, 1].map(number => page(number));
    const plans = planCompositeImages(pages, options({ pagesPerImage: 2 }));
    assert.deepEqual(plans.map(plan => plan.pages.map(page => page.page)), [[7, 2], [9, 4], [1]]);
    assert.deepEqual(planCompositeImages([], options()), []);
});

test('groups split at the canvas dimension limit without changing page resolution', () => {
    const pages = Array.from({ length: 10 }, (_, index) => page(index + 1, 1000, 2000));
    const plans = planCompositeImages(pages, options({ pagesPerImage: 10 }));
    assert.deepEqual(plans.map(plan => plan.pages.length), [4, 4, 2]);
    assert.deepEqual(plans.map(plan => plan.height), [8000, 8000, 4000]);
    for (const plan of plans) {
        assert.ok(plan.pages.every(page => page.width === 1000 && page.height === 2000));
    }
});

test('groups also split at the pixel area limit even when both dimensions fit', () => {
    const plans = planCompositeImages([page(1, 6000, 2000), page(2, 6000, 2000), page(3, 6000, 2000)],
        options({ pagesPerImage: 3 }));
    assert.deepEqual(plans.map(plan => plan.pages.length), [2, 1]);
    assert.equal(plans[0].width, 6000);
    assert.equal(plans[0].height, 4000);
});

test('grid splitting recomputes uniform cells from each resulting group', () => {
    const plans = planCompositeImages([page(1, 4100, 1000), page(2, 100, 200), page(3, 100, 200)],
        options({ layout: 'grid' }));
    assert.deepEqual(plans.map(plan => plan.pages.map(page => page.page)), [[1], [2, 3]]);
    assert.deepEqual(plans.map(({ width, height }) => ({ width, height })), [
        { width: 4100, height: 1000 }, { width: 200, height: 200 }
    ]);
});

test('canvas dimensions and area are inclusive at their limits', () => {
    assert.equal(planCompositeImages([page(1, 8192, 100)], options())[0].width, 8192);
    const [areaLimit] = planCompositeImages([page(1, 8000, 4000)], options());
    assert.equal(areaLimit.width * areaLimit.height, 32_000_000);
});

test('a single oversized page reports how to recover instead of lowering resolution', () => {
    for (const oversized of [page(1, 8193, 100), page(1, 6000, 6000), page(1, 8192, 100)]) {
        const opts = options({ padding: oversized.width === 8192 ? 1 : 0 });
        assert.throws(() => planCompositeImages([oversized], opts), /Page 1.*Reduce the resolution/);
    }
});

test('invalid composite options are rejected before planning', () => {
    const cases = [
        [{ layout: 'diagonal' }, /layout/],
        [{ quality: 0 }, /resolution/],
        [{ quality: 5 }, /resolution/],
        [{ quality: 1.5 }, /resolution/],
        [{ quality: Infinity }, /resolution/],
        [{ pagesPerImage: 0 }, /Pages per/],
        [{ pagesPerImage: 17 }, /Pages per/],
        [{ pagesPerImage: 1.5 }, /Pages per/],
        [{ layout: 'grid', pagesPerImage: 5 }, /1 to 4/],
        [{ padding: -1 }, /padding/],
        [{ padding: 49 }, /padding/],
        [{ padding: NaN }, /padding/],
        [{ padding: Infinity }, /padding/],
        [{ labels: 'yes' }, /labels/]
    ];
    for (const [overrides, message] of cases) {
        assert.throws(() => planCompositeImages([page(1)], options(overrides)), message);
    }
    assert.throws(() => planCompositeImages([page(1)], null), /layout/);
});

test('invalid dimensions or duplicate page identifiers are rejected', () => {
    for (const dimensions of [[0, 200], [-1, 200], [NaN, 200], [Infinity, 200], [100, 0], [100, -1], [100, NaN], [100, Infinity]]) {
        assert.throws(() => planCompositeImages([page(1, ...dimensions)], options()), /finite positive dimensions/);
    }
    for (const number of [0, -1, 1.5, Infinity, NaN]) {
        assert.throws(() => planCompositeImages([page(number)], options()), /unique positive integers/);
    }
    assert.throws(() => planCompositeImages([page(1), page(1)], options()), /unique positive integers/);
    assert.throws(() => planCompositeImages([null], options()), /unique positive integers/);
    assert.throws(() => planCompositeImages(null, options()), /array/);
});

test('serialized function executes in a fresh webview context without module dependencies', () => {
    const pages = [page(1, 200, 300), page(3, 300, 200), page(5, 250, 250)];
    const opts = options({ layout: 'grid', quality: 2, labels: true, padding: 8 });
    const serialized = `(${planCompositeImages.toString()})(${JSON.stringify(pages)}, ${JSON.stringify(opts)})`;
    // Cross-realm object prototypes differ, so compare their serialized values.
    assert.equal(JSON.stringify(runInNewContext(serialized)), JSON.stringify(planCompositeImages(pages, opts)));
});
