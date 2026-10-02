# Development and testing

Develop changes on a feature branch from current `main`. Local compilation,
testing, and packaging do not update the Marketplace extension used by other
people. Marketplace publishing is a separate release step.

## Set up

Use Node.js 22 and install the locked dependencies:

```bash
npm ci --ignore-scripts
npm run lint
npm test
```

`npm test` compiles TypeScript and runs the Node tests for editor behavior and
composite layout. These tests use a VS Code adapter; the separate integration
suite exercises an actual VS Code process and PDF.js rendering.

## Try changes interactively

Open this repository in VS Code, select **Run Extension (isolated)** in Run and
Debug, and press F5. The TypeScript watcher builds the extension, and a separate
Extension Development Host opens the small PDF fixture workspace. Its settings,
installed extensions, and screenshots are separate from your everyday VS Code
profile. The development extension is loaded from this checkout.

Open `sample.pdf`, use **Screenshot → Composite...**, and try both
layouts. Reload the development host after changing extension code; compilation
does not automatically restart the running extension.

Generated development profiles live under `.vscode-test/`. F5 opens this
repository's `test/fixtures/` workspace: screenshots are ignored under
`test/fixtures/PDF-Screenshots/`, while the fixture PDFs and workspace settings
are tracked source files. The integration runner uses separate disposable
workspaces under `.vscode-test/runs/`. Use sample documents for testing.

F5 also prepares the isolated profile's User settings. Application-wide settings
for extension updates, experiments, and telemetry belong there; the fixture's
Workspace settings contain PDF preferences and valid workspace options. Existing
preferences in the isolated User settings are preserved. Your everyday VS Code
User settings are outside these test directories.

## Automated rendering and package tests

```bash
npm run test:integration
npm run package:vsix
npm run test:integration -- --packaged
```

The integration runner creates a temporary workspace/profile, activates the
extension, checks its commands, opens PDFs, and verifies actual exported PNG
dimensions and colored pixels. It exercises grid and vertical composites,
automatic grouping, and existing page screenshots with more than one PDF open.
The packaged run installs the VSIX into a separate temporary extensions directory
and runs the same checks against that installed artifact.

The runner uses the installed macOS VS Code application when available, or the
official test runner downloads a stable VS Code build. Override the executable
with `PDF_TOOLKIT_VSCODE_EXECUTABLE` if necessary. On Linux with no display, use
`xvfb-run -a npm run test:integration -- --packaged`. CI runs these checks on Linux
in addition to lint, Node tests, and dependency audit.

To check a particular supported VS Code release, select it explicitly, for example:

```bash
PDF_TOOLKIT_VSCODE_VERSION=1.96.0 npm run test:integration
```

The package is `artifacts/pdf-toolkit-<version>.vsix`. To select another local
package, run `npm run test:integration -- --vsix /absolute/path/to/extension.vsix`.
Packaging and installing in the temporary test profile do not publish a release.

## Manual checks before release

Check the exact package intended for release, using representative documents:

The four-page grid with labels has been checked interactively. These short cases
exercise the remaining wizard options in the same Extension Development Host:

| Check | What to select | Expected result |
| --- | --- | --- |
| Vertical layout | `sample.pdf`, pages `2,4`, Vertical Stack, 4 pages/image, 144 DPI, Pages Only | One PNG with page 2 above page 4, without added labels or gaps. |
| Grouping and final page | `sample.pdf`, `all`, 2×2 Grid, 4 pages/image, 144 DPI, Page Labels and Spacing | Two PNGs: pages 1–4 together, then page 5 alone. Every page appears once. |
| Invalid input and cancelling | Enter page `6` in the five-page sample, then press Escape | Validation rejects the page. Cancelling creates no output. |
| Existing outputs | Repeat an existing export and try Cancel, Save New Only, and Overwrite All | Cancel/skip preserve existing images; overwrite replaces them successfully. |
| Two documents | Open `sample.pdf` and `second.pdf`; export page 1 from each | Separate output folders; sample page 1 is blue, second page 1 is amber. |

Then use a representative real PDF for visual quality and existing commands:

- Open multi-page PDFs with text, photos, and vector diagrams. Confirm rendering,
  text selection, search, outline navigation, page navigation, zoom, rotation,
  and dark mode.
- Keep two PDFs open. Switch between them and verify commands act on the intended
  document. Start the composite wizard, switch PDFs, and confirm it still exports
  its original document. Close a PDF during an export and check the error handling.
- Export current/all/custom screenshots in PNG and JPEG. Check selected ranges,
  quality, embedded-image extraction, duplicate handling, and browsing history.
- Export composites with mixed page sizes, both layouts, labels/spacing on and
  off, a partial last group, and high resolution. Check page order and readability,
  overwrite/skip/cancel, and messages for invalid or oversized selections.
- For chat integration, copy the isolated launch configuration, remove its two
  `--disable-extension=github.copilot` / `github.copilot-chat` arguments, and set
  `chat.disableAIFeatures` to `false` in that fixture workspace. Install/sign into
  Copilot in that isolated profile and
  verify attachment using sample images. Automated tests do not send documents
  to Copilot or validate the chat service. Restore the fixture workspace settings
  after the optional Copilot check.

The automated suite establishes startup and rendering/export behavior; it does
not replace checking all toolbar interactions, representative large PDFs, chat
integration, and your supported operating systems and VS Code versions.
macOS and Linux rendering have automated coverage. A Windows smoke test remains
before a release intended for Windows users. Repeat the important checks against
the final versioned VSIX, including opening real documents and Copilot attachment.

Record the tested commit, VS Code version, OS, automated results, manual checks,
and remaining limits in the PR. Follow [PUBLISHING.md](PUBLISHING.md) for the final
release. Keep the previous package available for recovery.

References: [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
and [publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
