const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { validateMarketplaceAssets } = require('../scripts/validate-marketplace-assets.cjs');

const icon = 'images/icon.png';

function fixture(t, size) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pdf-toolkit-marketplace-icon-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'images'));
    if (size !== undefined) writeFileSync(path.join(root, icon), Buffer.alloc(size));
    return root;
}

test('extensions without an icon retain optional-icon packaging behavior', t => {
    const root = fixture(t);
    assert.doesNotThrow(() => validateMarketplaceAssets(root, {}));
});

test('a regular icon below the Marketplace size limit is accepted', t => {
    const root = fixture(t, 1024 * 1024 - 1);
    assert.doesNotThrow(() => validateMarketplaceAssets(root, { icon }));
});

test('an icon exactly at the 1024 KB Marketplace limit is accepted', t => {
    const root = fixture(t, 1024 * 1024);
    assert.doesNotThrow(() => validateMarketplaceAssets(root, { icon }));
});

test('one byte over the limit reports the icon path, actual size and limit', t => {
    const root = fixture(t, 1024 * 1024 + 1);
    assert.throws(() => validateMarketplaceAssets(root, { icon }), error => {
        assert.match(error.message, /images\/icon\.png/);
        assert.match(error.message, /1048577 bytes/);
        assert.match(error.message, /maximum of 1048576 bytes \(1024 KB\)/);
        return true;
    });
});

test('the originally rejected 1449729-byte icon fails Marketplace asset validation', t => {
    const root = fixture(t, 1_449_729);
    assert.throws(() => validateMarketplaceAssets(root, { icon }), /1449729 bytes.*1048576 bytes/);
});

test('the actual package command rejects an oversized icon before touching the VSIX or invoking vsce', t => {
    const root = fixture(t, 1_449_729);
    const output = path.join(root, 'artifacts', 'pdf-toolkit-2.4.1.vsix');
    mkdirSync(path.dirname(output));
    writeFileSync(output, 'previous tested package');
    const calls = [];
    const load = name => {
        if (name === 'node:path') return path;
        if (name === 'node:fs') return { mkdirSync: (...args) => { calls.push('mkdir'); return mkdirSync(...args); } };
        if (name === 'node:child_process') return { spawnSync: () => { calls.push('vsce'); return { status: 0 }; } };
        if (name === './validate-marketplace-assets.cjs') return { validateMarketplaceAssets };
        if (name === '../package.json') return { name: 'pdf-toolkit', version: '2.4.1', icon };
        throw new Error(`Unexpected module: ${name}`);
    };
    load.resolve = () => { calls.push('resolve vsce'); return '/unused/vsce'; };
    const script = readFileSync(path.join(__dirname, '../scripts/package-vsix.cjs'), 'utf8');
    assert.throws(() => runInNewContext(script, {
        __dirname: path.join(root, 'scripts'), require: load,
        process: { execPath: process.execPath, exit: code => { throw new Error(`Unexpected exit: ${code}`); } },
        console: { log() {} }
    }), /1449729 bytes.*1048576 bytes/);
    assert.deepEqual(calls, [], 'Validation must happen before package directory work or vsce resolution/execution');
    assert.equal(readFileSync(output, 'utf8'), 'previous tested package');
});

test('a missing configured icon has a clear failure', t => {
    const root = fixture(t);
    assert.throws(() => validateMarketplaceAssets(root, { icon }), /Marketplace icon 'images\/icon\.png' was not found/);
});

test('a directory cannot be packaged as an icon', t => {
    const root = fixture(t);
    mkdirSync(path.join(root, icon));
    assert.throws(() => validateMarketplaceAssets(root, { icon }), /Marketplace icon 'images\/icon\.png' must be a regular file/);
});

test('the actual extension icon satisfies the Marketplace file-size contract', () => {
    const root = path.resolve(__dirname, '..');
    const manifest = require('../package.json');
    assert.doesNotThrow(() => validateMarketplaceAssets(root, manifest));
});
