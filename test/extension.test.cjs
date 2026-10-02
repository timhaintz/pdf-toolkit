const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { compileFunction } = require('node:vm');

const workspacePath = path.join(path.parse(process.cwd()).root, 'workspace #1');
const pageFiles = count => Array.from({ length: count }, (_, index) =>
    `page_${String(index + 1).padStart(3, '0')}.png`);

function createHarness(folders, settings = {}) {
    const commands = new Map();
    const executed = [];
    const picks = [];
    const pickResponses = [];
    const inputResponses = [];
    const warningResponses = [];
    const warnings = [];
    const information = [];
    const errors = [];
    const state = new Map();
    const screenshotsPath = path.join(workspacePath, settings.folderName ?? 'PDF-Screenshots');
    const directories = new Map();
    const makeUri = fsPath => ({ fsPath, toString: () => pathToFileURL(fsPath).href });

    directories.set(screenshotsPath, Object.keys(folders).map(name => [name, 2]));
    for (const [name, entries] of Object.entries(folders)) {
        directories.set(path.join(screenshotsPath, name), entries.map(entry =>
            typeof entry === 'string' ? [entry, 1] : entry));
    }

    const vscode = {
        FileType: { File: 1, Directory: 2 },
        QuickPickItemKind: { Separator: -1 },
        Uri: { file: makeUri },
        commands: {
            registerCommand: (name, handler) => {
                commands.set(name, handler);
                return { dispose() {} };
            },
            executeCommand: async (name, ...args) => {
                executed.push({ name, args });
            }
        },
        workspace: {
            workspaceFolders: [{ uri: makeUri(workspacePath) }],
            fs: {
                readDirectory: async uri => {
                    const entries = directories.get(uri.fsPath);
                    if (!entries) throw new Error('Not found');
                    return entries;
                },
                stat: async uri => {
                    if (!directories.has(uri.fsPath)) throw new Error('Not found');
                    return { type: 2, mtime: Date.UTC(2026, 9, 3) };
                }
            }
        },
        window: {
            registerCustomEditorProvider: () => ({ dispose() {} }),
            showQuickPick: async (items, options) => {
                picks.push({ items, options });
                assert.ok(pickResponses.length, `Unexpected picker: ${options.title}`);
                const response = pickResponses.shift();
                return typeof response === 'function' ? response(items, options) : response;
            },
            showInputBox: async () => inputResponses.shift(),
            showWarningMessage: async (message, ...choices) => {
                warnings.push({ message, choices });
                return warningResponses.shift();
            },
            showInformationMessage: message => { information.push(message); },
            showErrorMessage: message => { errors.push(message); }
        }
    };
    const context = {
        subscriptions: [],
        workspaceState: {
            get: (key, fallback) => state.get(key) ?? fallback,
            update: async (key, value) => { state.set(key, value); }
        }
    };
    class PdfEditorProvider {
        static viewType = 'pdfToolkit.pdfCustomEditor';
        static getScreenshotsFolderName() { return settings.folderName ?? 'PDF-Screenshots'; }
        constructor(extensionContext) { this.context = extensionContext; }
    }

    // Exercise the actual registered commands, including folder discovery and
    // attachment construction, while replacing the editor and Copilot boundary.
    const filename = path.resolve(__dirname, '../out/extension.js');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const load = compileFunction(readFileSync(filename, 'utf8'),
        ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
    load(module.exports, name => {
        if (name === 'vscode') return vscode;
        if (name === './pdfEditorProvider') return { PdfEditorProvider };
        return realRequire(name);
    }, module, filename, path.dirname(filename));
    module.exports.activate(context);

    const chats = () => executed.filter(command => command.name === 'workbench.action.chat.open');
    function browse(folder, action, selection) {
        pickResponses.push(
            items => {
                const result = items.find(item => item.pdfData?.name === folder);
                assert.ok(result, `Folder ${folder} was not discovered`);
                return result;
            },
            items => {
                const result = items.find(item => item.action === action);
                assert.ok(result, `Action ${action} was not offered`);
                return result;
            }
        );
        if (arguments.length > 2) pickResponses.push(selection);
        return commands.get('pdfToolkit.browseExtracted')();
    }
    function assertAttachments(folder, expectedNames) {
        assert.equal(chats().length, 1);
        const [args] = chats()[0].args;
        assert.equal(args.query, '');
        assert.deepEqual(args.attachFiles.map(uri => uri.fsPath),
            expectedNames.map(name => path.join(screenshotsPath, folder, name)));
    }

    return {
        commands, picks, pickResponses, inputResponses, warningResponses,
        warnings, information, errors, state, chats, browse, assertAttachments,
        screenshotsPath
    };
}

const selectFiles = filenames => items => filenames.map(filename => {
    const result = items.find(item => item.filename === filename);
    assert.ok(result, `Image ${filename} was not offered`);
    return result;
});

test('Browse attaches only the checked images from a 49-page PDF', async () => {
    const harness = createHarness({ 'large-report': pageFiles(49) });
    const selected = ['page_001.png', 'page_017.png', 'page_049.png'];
    await harness.browse('large-report', 'attachSelectedToCopilot', (items, options) => {
        assert.equal(options.canPickMany, true);
        assert.equal(items.length, 49);
        assert.ok(items.every(item => !item.picked), 'No images should start selected');
        return selectFiles(selected)(items);
    });
    harness.assertAttachments('large-report', selected);
    assert.equal(harness.warnings.length, 0);
    assert.equal(harness.errors.length, 0);
});

test('exactly 20 selected images can be attached', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    const selected = pageFiles(20);
    await harness.browse('report', 'attachSelectedToCopilot', selectFiles(selected));
    harness.assertAttachments('report', selected);
    assert.equal(harness.warnings.length, 0);
});

test('21 selected images are rejected before chat opens and can be corrected', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    const tooMany = pageFiles(21);
    const corrected = ['page_002.png', 'page_049.png'];
    harness.pickResponses.push(
        items => items.find(item => item.pdfData?.name === 'report'),
        items => items.find(item => item.action === 'attachSelectedToCopilot'),
        selectFiles(tooMany),
        items => {
            assert.equal(harness.chats().length, 0);
            assert.equal(harness.warnings.length, 1);
            assert.match(harness.warnings[0].message, /21/);
            assert.match(harness.warnings[0].message, /20/);
            assert.deepEqual(items.filter(item => item.picked).map(item => item.filename), tooMany);
            return selectFiles(corrected)(items);
        }
    );
    await harness.commands.get('pdfToolkit.browseExtracted')();
    harness.assertAttachments('report', corrected);
});

test('an undismissed size warning does not block reopening and correcting the selection', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    const corrected = ['page_002.png', 'page_049.png'];
    // Native showWarningMessage resolves only when its notification is dismissed.
    // Leave it pending to prove users can immediately correct their selection.
    harness.warningResponses.push(new Promise(() => {}));
    harness.pickResponses.push(
        items => items.find(item => item.pdfData?.name === 'report'),
        items => items.find(item => item.action === 'attachSelectedToCopilot'),
        selectFiles(pageFiles(21)),
        items => {
            assert.equal(harness.chats().length, 0);
            assert.equal(items.filter(item => item.picked).length, 21);
            return selectFiles(corrected)(items);
        }
    );
    const command = harness.commands.get('pdfToolkit.browseExtracted')();
    // Drain the asynchronous filesystem/picker work without waiting for the
    // unresolved notification or relying on a wall-clock timeout.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.picks.length, 4, 'The correction picker must open immediately');
    harness.assertAttachments('report', corrected);
    await command;
});

test('cancelling an oversized selection does not open chat or report an attachment', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    harness.pickResponses.push(
        items => items.find(item => item.pdfData?.name === 'report'),
        items => items.find(item => item.action === 'attachSelectedToCopilot'),
        selectFiles(pageFiles(21)),
        undefined
    );
    await harness.commands.get('pdfToolkit.browseExtracted')();
    assert.equal(harness.chats().length, 0);
    assert.equal(harness.warnings.length, 1);
    assert.equal(harness.information.length, 0);
});

test('cancel and empty selections leave chat closed', async t => {
    for (const selection of [undefined, []]) {
        await t.test(selection === undefined ? 'cancel' : 'empty', async () => {
            const harness = createHarness({ report: pageFiles(3) });
            await harness.browse('report', 'attachSelectedToCopilot', selection);
            assert.equal(harness.chats().length, 0);
            assert.equal(harness.information.length, 0);
            assert.equal(harness.warnings.length, 0);
        });
    }
});

test('discovery and picker offer PNG/JPEG files, excluding directories and other files', async () => {
    const imageNames = ['page_2.JPG', 'page_10.png', 'page_1.PNG', 'image_002.JPEG'];
    const harness = createHarness({
        report: [...imageNames, 'notes.txt', 'report.pdf', ['page_003.png', 2]],
        'directories-only': [['page_001.png', 2]],
        'uppercase-only': ['page_001.PNG']
    });
    await harness.browse('report', 'attachSelectedToCopilot', items => {
        assert.deepEqual(new Set(items.map(item => item.filename)), new Set(imageNames));
        const orderedPages = items.filter(item => /^page_/.test(item.filename)).map(item => item.filename);
        assert.deepEqual(orderedPages, ['page_1.PNG', 'page_2.JPG', 'page_10.png']);
        return selectFiles(['page_2.JPG', 'image_002.JPEG'])(items);
    });
    const discovered = harness.state.get('extractedPdfs');
    assert.equal(discovered.find(pdf => pdf.name === 'report').pageCount, 4);
    assert.ok(discovered.some(pdf => pdf.name === 'uppercase-only'));
    assert.ok(!discovered.some(pdf => pdf.name === 'directories-only'));
    harness.assertAttachments('report', ['image_002.JPEG', 'page_2.JPG']);
});

test('selection preserves filenames with spaces and punctuation and stays in the chosen PDF folder', async () => {
    const filename = 'figure #1 (draft) & review.PNG';
    const harness = createHarness({
        'first report #1': [filename, 'page_001.png'],
        'second report': [filename, 'page_002.png']
    }, { folderName: 'Screenshot Exports' });
    await harness.browse('second report', 'attachSelectedToCopilot', selectFiles([filename]));
    harness.assertAttachments('second report', [filename]);
    const attachedUri = harness.chats()[0].args[0].attachFiles[0];
    assert.match(attachedUri.toString(), /%20/);
    assert.match(attachedUri.toString(), /%23/);
    assert.equal(harness.errors.length, 0);
});

test('composites are selected as complete files and identify their included pages', async () => {
    const composite = 'composite_grid_pages_001-002-003-004_144dpi_labels_pad12.png';
    const embedded = 'image_001_page2_480x640.png';
    const harness = createHarness({ report: [composite, 'page_002.png', embedded] });
    await harness.browse('report', 'attachSelectedToCopilot', items => {
        const item = items.find(candidate => candidate.filename === composite);
        assert.ok(item);
        assert.match(`${item.description} ${item.detail}`, /composite/i);
        assert.match(`${item.description} ${item.detail}`, /(?:1.*2.*3.*4|1[–-]4)/);
        assert.match(`${item.description} ${item.detail}`, /(?:full|whole|complete|entire)/i);
        assert.match(items.find(candidate => candidate.filename === 'page_002.png').description, /page.*2/i);
        assert.match(items.find(candidate => candidate.filename === embedded).description, /embedded/i);
        return [item];
    });
    harness.assertAttachments('report', [composite]);
});

test('the existing Add All action still attaches every image in folders of 20 or fewer', async () => {
    const harness = createHarness({ report: pageFiles(20) });
    await harness.browse('report', 'attachToCopilot');
    harness.assertAttachments('report', pageFiles(20));
    assert.equal(harness.picks.length, 2);
    assert.equal(harness.warnings.length, 0);
});

test('Add All blocks large folders and offers selected-image recovery', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    const selected = ['page_010.png', 'page_049.png'];
    harness.warningResponses.push('Select Images');
    harness.pickResponses.push(selectFiles(selected));
    // Queue folder/action before the recovery picker.
    harness.pickResponses.unshift(
        items => items.find(item => item.pdfData?.name === 'report'),
        items => items.find(item => item.action === 'attachToCopilot')
    );
    await harness.commands.get('pdfToolkit.browseExtracted')();
    assert.equal(harness.warnings.length, 1);
    assert.ok(harness.warnings[0].choices.includes('Select Images'));
    harness.assertAttachments('report', selected);
});

test('dismissing the Add All size warning does not open chat', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    await harness.browse('report', 'attachToCopilot');
    assert.equal(harness.chats().length, 0);
    assert.equal(harness.picks.length, 2);
    assert.equal(harness.warnings.length, 1);
    assert.equal(harness.information.length, 0);
});

test('programmatic files remain exact-name selections with no traversal or directory attachments', async () => {
    const harness = createHarness({ report: ['page_001.png', 'page_002.jpeg', ['fake.png', 2]] });
    await harness.commands.get('pdfToolkit.attachExtractedToCopilot')({
        pdf: 'report', files: ['../outside.png', 'fake.png', 'page_002.jpeg', 'page_002.jpeg']
    });
    harness.assertAttachments('report', ['page_002.jpeg']);
});

test('programmatic page filtering attaches an entire matching composite', async () => {
    const composite = 'composite_grid_pages_001-002-003-004_144dpi_labels_pad12.png';
    const harness = createHarness({ report: [composite, 'page_002.png', 'page_005.png'] });
    await harness.commands.get('pdfToolkit.attachExtractedToCopilot')({ pdf: 'report', pages: '2' });
    harness.assertAttachments('report', [composite, 'page_002.png']);
});

test('programmatic selections over 20 images remain blocked', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    await harness.commands.get('pdfToolkit.attachExtractedToCopilot')({ pdf: 'report', pages: '1-21' });
    assert.equal(harness.chats().length, 0);
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0].message, /21/);
    assert.match(harness.warnings[0].message, /20/);
    assert.equal(harness.information.length, 0);
});

test('the existing interactive attachment command preserves page-range selection', async () => {
    const harness = createHarness({ report: pageFiles(49) });
    harness.pickResponses.push(items => items.find(item => item.pdf.name === 'report'));
    harness.inputResponses.push('2,49');
    await harness.commands.get('pdfToolkit.attachExtractedToCopilot')();
    harness.assertAttachments('report', ['page_002.png', 'page_049.png']);
    assert.equal(harness.picks.length, 1);
    assert.equal(harness.warnings.length, 0);
});
