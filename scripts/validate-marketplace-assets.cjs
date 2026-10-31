const { statSync } = require('node:fs');
const path = require('node:path');

// The Marketplace rejects icon files larger than 1024 KB, even when vsce
// successfully packages them. Measure the complete file, including metadata.
const MAX_MARKETPLACE_ICON_BYTES = 1024 * 1024;

function validateMarketplaceAssets(root, manifest) {
    const icon = manifest.icon;
    if (icon === undefined || icon === null || icon === '') return;
    if (typeof icon !== 'string') {
        throw new Error('The Marketplace icon path must be a string.');
    }

    let stats;
    try {
        stats = statSync(path.resolve(root, icon));
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
            throw new Error(`Marketplace icon '${icon}' was not found.`);
        }
        throw new Error(`Cannot read Marketplace icon '${icon}': ${error.message}`);
    }

    if (!stats.isFile()) {
        throw new Error(`Marketplace icon '${icon}' must be a regular file.`);
    }
    if (stats.size > MAX_MARKETPLACE_ICON_BYTES) {
        throw new Error(`Marketplace icon '${icon}' is ${stats.size} bytes, exceeding the maximum of ${MAX_MARKETPLACE_ICON_BYTES} bytes (1024 KB). Use a smaller icon before packaging.`);
    }
}

module.exports = { MAX_MARKETPLACE_ICON_BYTES, validateMarketplaceAssets };
