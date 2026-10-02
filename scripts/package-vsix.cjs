const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const outputDir = path.join(root, 'artifacts');
mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `${manifest.name}-${manifest.version}.vsix`);
const cli = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(process.execPath, [cli, 'package', '--out', outputPath], {
    cwd: root,
    stdio: 'inherit'
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Local package ready: ${outputPath}`);
