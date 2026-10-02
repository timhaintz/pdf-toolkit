const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vscode = require('vscode');
const { createPdf, fixturePageColors } = require('../fixtures/createPdf.cjs');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function withTimeout(promise, label, timeout = 35000) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

async function waitForFile(filename) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (fs.existsSync(filename) && fs.statSync(filename).size > 100) return;
        await pause(100);
    }
    assert.fail(`Screenshot was not created: ${filename}`);
}

const pageProbe = (x, y, page, variant = 'sample') => ({ x, y, page, variant, rgb: fixturePageColors(variant)[page - 1] });

function readRenderedPng(filename, probes) {
    assert.ok(probes.length > 0, 'Every screenshot must verify expected page content');
    const png = fs.readFileSync(filename);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'Valid PNG signature');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(png[24], 8, 'Canvas PNG has 8-bit channels');
    assert.ok(png[25] === 2 || png[25] === 6, 'Canvas PNG is RGB or RGBA');
    assert.equal(png[28], 0, 'Canvas PNG is not interlaced');
    const channels = png[25] === 6 ? 4 : 3;
    for (const probe of probes) {
        assert.ok(probe.x >= 0 && probe.x < width && probe.y >= 0 && probe.y < height, 'Page color probe is within the PNG');
    }
    const chunks = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
    }
    const raw = zlib.inflateSync(Buffer.concat(chunks));
    const stride = width * channels;
    assert.equal(raw.length, height * (stride + 1));
    let previous = Buffer.alloc(stride);
    let coloredPixels = 0;
    const sampledPixels = new Map();
    const paeth = (left, above, upperLeft) => {
        const prediction = left + above - upperLeft;
        const distances = [Math.abs(prediction - left), Math.abs(prediction - above), Math.abs(prediction - upperLeft)];
        return distances[0] <= distances[1] && distances[0] <= distances[2] ? left
            : distances[1] <= distances[2] ? above : upperLeft;
    };
    for (let y = 0; y < height; y++) {
        const offset = y * (stride + 1);
        const filter = raw[offset];
        assert.ok(filter <= 4, 'Known PNG row filter');
        const row = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? row[x - channels] : 0;
            const above = previous[x];
            const upperLeft = x >= channels ? previous[x - channels] : 0;
            const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
            row[x] = (raw[offset + 1 + x] + predictor) & 255;
        }
        for (let x = 0; x < stride; x += channels) {
            const rgb = [row[x], row[x + 1], row[x + 2]];
            if (Math.max(...rgb) - Math.min(...rgb) > 40) coloredPixels++;
        }
        for (const probe of probes.filter(probe => probe.y === y)) {
            const pixelOffset = probe.x * channels;
            sampledPixels.set(probe, [...row.subarray(pixelOffset, pixelOffset + 3)]);
            if (channels === 4) assert.equal(row[pixelOffset + 3], 255, 'Rendered PDF page is opaque');
        }
        previous = row;
    }
    assert.ok(coloredPixels > 1000, `PDF page content was rendered in ${path.basename(filename)}`);
    for (const probe of probes) {
        const actual = sampledPixels.get(probe);
        assert.ok(actual && actual.every((channel, index) => Math.abs(channel - probe.rgb[index]) <= 3),
            `${path.basename(filename)} cell at (${probe.x}, ${probe.y}) contains ${probe.variant} page ${probe.page}; expected RGB ${probe.rgb}, got ${actual}`);
    }
    return { width, height, coloredPixels };
}

exports.run = async function run() {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspace, 'An isolated fixture workspace is open');
    const extension = vscode.extensions.getExtension('TimHaintz.pdf-toolkit');
    assert.ok(extension, 'PDF Toolkit was discovered by the real extension host');
    assert.equal(fs.realpathSync(extension.extensionPath),
        fs.realpathSync(process.env.PDF_TOOLKIT_TEST_EXTENSION_PATH), 'The expected source or VSIX installation is loaded');
    await withTimeout(extension.activate(), 'Extension activation');
    assert.ok(extension.isActive, 'Extension activates without error');
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['openPdf', 'zoomIn', 'zoomOut', 'resetZoom', 'extractCurrentPage',
        'extractAllPages', 'extractCustom', 'extractComposite', 'browseExtracted', 'attachExtractedToCopilot']) {
        assert.ok(commands.includes(`pdfToolkit.${command}`), `Command registered: ${command}`);
    }
    const sample = vscode.Uri.file(path.join(workspace, 'sample.pdf'));
    const second = vscode.Uri.file(path.join(workspace, 'second.pdf'));
    fs.writeFileSync(sample.fsPath, createPdf());
    fs.writeFileSync(second.fsPath, createPdf('second'));
    const screenshotRoot = path.join(workspace, 'PDF-Screenshots');
    // Test workspaces contain only generated fixtures and their generated outputs.
    fs.rmSync(screenshotRoot, { recursive: true, force: true });
    const openPdf = uri => withTimeout(vscode.commands.executeCommand('vscode.openWith', uri,
        'pdfToolkit.pdfCustomEditor', { preview: false, viewColumn: vscode.ViewColumn.One }), 'Opening PDF editor');
    const exportComposite = options => withTimeout(vscode.commands.executeCommand('pdfToolkit.extractComposite', options),
        `Composite export (${options.layout}, pages ${options.pages})`);

    await openPdf(sample);
    const grid = await exportComposite({ pages: '1-4', quality: 1, layout: 'grid', pagesPerImage: 4, labels: true, padding: 12 });
    assert.deepEqual(grid.map(filename => path.basename(filename)), ['composite_grid_pages_001-002-003-004_72dpi_labels.png']);
    assert.equal(path.dirname(grid[0]), path.join(screenshotRoot, 'sample-composites'));
    const gridPng = readRenderedPng(grid[0], [
        pageProbe(132, 172, 1), pageProbe(384, 172, 2), pageProbe(132, 528, 3), pageProbe(384, 528, 4)
    ]);
    assert.deepEqual({ width: gridPng.width, height: gridPng.height }, { width: 516, height: 724 },
        'Four-page grid includes 72-DPI pages, labels, padding and gutters');

    const vertical = await exportComposite({ pages: '2,4', quality: 1, layout: 'vertical', pagesPerImage: 4, labels: false, padding: 12 });
    assert.deepEqual(vertical.map(filename => path.basename(filename)), ['composite_vertical_pages_002-004_72dpi.png']);
    const verticalPng = readRenderedPng(vertical[0], [pageProbe(132, 172, 2), pageProbe(132, 504, 4)]);
    assert.deepEqual({ width: verticalPng.width, height: verticalPng.height }, { width: 264, height: 676 },
        'Selected pages form one vertical column without labels');
    const grouped = await exportComposite({ pages: '1-5', quality: 1, layout: 'grid', pagesPerImage: 4, labels: false, padding: 12 });
    assert.deepEqual(grouped.map(filename => path.basename(filename)), [
        'composite_grid_pages_001-002-003-004_72dpi.png', 'composite_grid_pages_005_72dpi.png'
    ]);
    readRenderedPng(grouped[0], [
        pageProbe(132, 172, 1), pageProbe(384, 172, 2), pageProbe(132, 504, 3), pageProbe(384, 504, 4)
    ]);
    readRenderedPng(grouped[1], [pageProbe(132, 172, 5)]);

    await vscode.commands.executeCommand('pdfToolkit.extractAllPages');
    for (let page = 1; page <= 5; page++) {
        const filename = path.join(screenshotRoot, 'sample', `page_${String(page).padStart(3, '0')}.png`);
        await waitForFile(filename);
        const { width, height } = readRenderedPng(filename, [pageProbe(180, 240, page)]);
        assert.deepEqual({ width, height }, { width: 360, height: 480 },
            'Ordinary screenshots retain their existing resolution');
    }
    await openPdf(second);
    for (const command of ['zoomIn', 'zoomOut', 'resetZoom']) await vscode.commands.executeCommand(`pdfToolkit.${command}`);
    const secondOutput = await exportComposite({ pages: '5', quality: 1, layout: 'grid', pagesPerImage: 1, labels: false, padding: 4 });
    assert.equal(path.dirname(secondOutput[0]), path.join(screenshotRoot, 'second-composites'), 'Export follows focused PDF');
    readRenderedPng(secondOutput[0], [pageProbe(124, 164, 5, 'second')]);
    await openPdf(sample);
    const refocused = await exportComposite({ pages: '2', quality: 1, layout: 'grid', pagesPerImage: 1, labels: false, padding: 6 });
    assert.equal(path.dirname(refocused[0]), path.join(screenshotRoot, 'sample-composites'), 'Refocusing restores the first PDF');
    readRenderedPng(refocused[0], [pageProbe(126, 166, 2)]);
    console.log(`PASS: ${process.env.PDF_TOOLKIT_TEST_MODE}, VS Code ${vscode.version}; activation, commands, PDF.js rendering, grid/vertical/grouped composites, ordinary screenshots and multiple PDFs.`);
    console.log(`Rendered grid: ${gridPng.width} x ${gridPng.height}; vertical: ${verticalPng.width} x ${verticalPng.height}. Outputs: ${screenshotRoot}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
};
