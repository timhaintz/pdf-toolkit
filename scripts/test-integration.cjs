const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');
const { createPdf } = require('../test/fixtures/createPdf.cjs');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const argv = process.argv.slice(2);
assert.ok(argv.length === 0 || (argv.length === 1 && argv[0] === '--packaged') || (argv.length === 2 && argv[0] === '--vsix'),
    'Usage: npm run test:integration -- [--packaged | --vsix path/to/extension.vsix]');
const vsix = argv[0] === '--packaged' ? path.join(root, 'artifacts', `${manifest.name}-${manifest.version}.vsix`)
    : argv[0] === '--vsix' ? path.resolve(argv[1]) : undefined;
if (vsix) assert.ok(fs.existsSync(vsix), `VSIX does not exist: ${vsix}`);

async function resolveExecutable() {
    if (process.env.PDF_TOOLKIT_VSCODE_EXECUTABLE) {
        const executable = path.resolve(process.env.PDF_TOOLKIT_VSCODE_EXECUTABLE);
        assert.ok(fs.existsSync(executable), `VS Code executable does not exist: ${executable}`);
        return executable;
    }
    // An explicit version requests a downloadable VS Code build, useful for testing
    // the minimum supported VS Code as well as the version installed locally.
    if (!process.env.PDF_TOOLKIT_VSCODE_VERSION && process.platform === 'darwin') {
        const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
        if (fs.existsSync(installed)) return installed;
        const legacy = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
        if (fs.existsSync(legacy)) return legacy;
    }
    const cachePath = path.join(root, '.vscode-test', 'downloads');
    fs.mkdirSync(cachePath, { recursive: true });
    return downloadAndUnzipVSCode({
        version: process.env.PDF_TOOLKIT_VSCODE_VERSION || 'stable',
        cachePath
    });
}

function createRun(mode) {
    const runsDir = path.join(root, '.vscode-test', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const directory = fs.mkdtempSync(path.join(runsDir, `${mode}-`));
    const workspace = path.join(directory, 'workspace');
    const userData = path.join(directory, 'user-data');
    const extensions = path.join(directory, 'extensions');
    for (const folder of [workspace, userData, extensions, path.join(workspace, '.vscode')]) {
        fs.mkdirSync(folder, { recursive: true });
    }
    fs.writeFileSync(path.join(workspace, 'sample.pdf'), createPdf());
    fs.writeFileSync(path.join(workspace, 'second.pdf'), createPdf('second'));
    fs.copyFileSync(path.join(root, 'test/fixtures/.vscode/settings.json'),
        path.join(workspace, '.vscode/settings.json'));
    return { directory, workspace, userData, extensions };
}

function installVsix(executable, run) {
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
    const result = spawnSync(cli, [...cliArgs, '--install-extension', vsix, '--force',
        '--user-data-dir', run.userData, '--extensions-dir', run.extensions], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        timeout: 60000
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Installing the VSIX into the isolated profile failed');
    const candidates = fs.readdirSync(run.extensions).filter(name => {
        const candidate = path.join(run.extensions, name, 'package.json');
        if (!fs.existsSync(candidate)) return false;
        const installed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return installed.publisher === manifest.publisher && installed.name === manifest.name;
    });
    assert.equal(candidates.length, 1, 'Expected exactly one isolated installation of PDF Toolkit');
    return path.join(run.extensions, candidates[0]);
}

async function main() {
    const executable = await resolveExecutable();
    console.log(`VS Code executable: ${executable}`);
    for (const mode of vsix ? ['development', 'packaged'] : ['development']) {
        const run = createRun(mode);
        const extensionPath = mode === 'packaged' ? installVsix(executable, run) : root;
        console.log(`Testing ${mode} extension: ${extensionPath}`);
        console.log(`Isolated workspace and logs: ${run.directory}`);
        await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: extensionPath,
            extensionTestsPath: path.join(root, 'test/integration/suite.cjs'),
            reuseMachineInstall: true,
            launchArgs: [run.workspace, '--new-window',
                `--user-data-dir=${run.userData}`, `--extensions-dir=${run.extensions}`,
                '--disable-extension=github.copilot', '--disable-extension=github.copilot-chat'],
            extensionTestsEnv: {
                ELECTRON_RUN_AS_NODE: undefined,
                PDF_TOOLKIT_TEST_EXTENSION_PATH: extensionPath,
                PDF_TOOLKIT_TEST_MODE: mode
            }
        });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
