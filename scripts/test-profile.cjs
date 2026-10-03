const fs = require('node:fs');
const path = require('node:path');
const { applyEdits, modify, parse } = require('jsonc-parser');

// Application-scoped settings must live in the isolated profile's User settings,
// not in the fixture workspace. Existing choices and JSON comments are preserved.
const profileDefaults = {
    // Keep the downloaded/editor version fixed and avoid macOS updater prompts.
    'update.mode': 'none',
    'workbench.enableExperiments': false,
    'extensions.autoCheckUpdates': false,
    // VS Code 1.96 accepts false; newer versions migrate it to "off" in User settings.
    'extensions.autoUpdate': false,
    'telemetry.telemetryLevel': 'off'
};

function prepareTestProfile(userData) {
    const filename = path.join(userData, 'User', 'settings.json');
    const original = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '{}\n';
    const errors = [];
    const settings = parse(original, errors, { allowTrailingComma: true });
    if (errors.length || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error(`Cannot prepare isolated profile: ${filename} must contain a valid JSON settings object (comments are allowed)`);
    }
    let content = original;
    for (const [key, value] of Object.entries(profileDefaults)) {
        if (Object.hasOwn(settings, key)) continue;
        content = applyEdits(content, modify(content, [key], value, {
            formattingOptions: { insertSpaces: true, tabSize: 4, eol: original.includes('\r\n') ? '\r\n' : '\n' }
        }));
    }
    if (content !== original) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
    }
    return filename;
}

module.exports = { prepareTestProfile };
