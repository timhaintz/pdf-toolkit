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

Open this repository in VS Code, select **Run Extension (temporary profile)** in
Run and Debug, and press F5. The TypeScript watcher builds the extension, and an
Extension Development Host opens the small PDF fixture workspace with the
development extension loaded from this checkout.

The launch uses `--profile-temp` to give the test window disposable preferences
and extension enablement, as described in [VS Code's extension-debugging guidance](https://code.visualstudio.com/updates/v1_72#_extension-debugging-in-a-clean-environment).
Application-scoped settings still inherit the default User settings, and account
authentication can be shared. The integration runner below provides a separate
VS Code process with its own User data and extensions directories.

Open `sample.pdf`, use **Screenshot → Composite...**, and try both
layouts. Reload the development host after changing extension code; compilation
does not automatically restart the running extension.

F5 opens this repository's `test/fixtures/` workspace: screenshots are ignored under
`test/fixtures/PDF-Screenshots/`, while the fixture PDFs and workspace settings
are tracked source files. Use sample documents for testing. The fixture's
Workspace settings contain PDF preferences and valid workspace options.

The integration runner starts separate VS Code processes with disposable User
data, extensions directories, and workspaces under `.vscode-test/runs/`. It
prepares those processes' User settings for extension updates, experiments, and
telemetry; these Application-scoped settings belong in User settings. F5 does
not run that preparation step or change your everyday User settings.

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
`xvfb-run -a npm run test:integration -- --packaged`. CI runs these checks on
Linux and Windows, in addition to lint, Node tests, packaging, and dependency
audit. The Windows job downloads and starts real VS Code, installs the local
VSIX, and verifies rendered image dimensions and colors. It runs on a
GitHub-hosted machine, so contributors do not need their own Windows computer.

To check a particular supported VS Code release, select it explicitly, for example:

```bash
PDF_TOOLKIT_VSCODE_VERSION=1.96.0 npm run test:integration
```

The package is `artifacts/pdf-toolkit-<version>.vsix`. To select another local
package, run `npm run test:integration -- --vsix /absolute/path/to/extension.vsix`.
Packaging and installing in the temporary test profile do not publish a release.

## Manual checks before release

Check the exact package intended for release, using representative documents:

These short cases exercise the wizard options in the same Extension Development
Host. Run them again against the exact release package:

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
  document. Start the composite wizard and switch PDFs: losing focus may dismiss
  the wizard without output. If it remains open, completing it must export the
  original document. Close a PDF during an export and check the error handling.
- Export current/all/custom screenshots in PNG and JPEG. Check selected ranges,
  quality, embedded-image extraction, duplicate handling, and browsing history.
- Export composites with mixed page sizes, both layouts, labels/spacing on and
  off, a partial last group, and high resolution. Check page order and readability,
  overwrite/skip/cancel, and messages for invalid or oversized selections.
- For chat integration, copy `test/fixtures/` into an ignored disposable workspace
  under `.vscode-test/manual-qa/<date>/copilot-workspace/`. Copy the temporary-profile
  launch configuration, point its workspace argument at that copy, remove its two
  `--disable-extension=github.copilot` / `github.copilot-chat` arguments, and set
  `chat.disableAIFeatures` to `false` in the copied workspace settings. Keep the
  tracked fixture settings unchanged. Enable/install Copilot in the temporary
  profile and sign in if needed; existing authentication may be available.
  Verify attachment using sample images. Automated tests do not send documents
  to Copilot or validate the chat service.

Use that disposable Copilot workspace for the selected-image attachment checks
below. Open **📁 Extracted**, select the saved-image folder, and choose
**Add Selected Pages to Copilot Chat**. Confirm which image attachments appear in
chat; sending a prompt is only necessary when checking image readability. Start
a fresh chat for each case so attachment counts remain unambiguous.

| Check | What to select | Expected result |
| --- | --- | --- |
| Individual selection | Export all five pages from `sample.pdf`, then check only the page 2 and page 4 files | No files start checked. Exactly two images attach, showing green and purple; the other pages are absent. |
| Cancellation and empty selection | Open the image picker and press Escape; reopen and confirm with nothing checked | Both finish quietly without attaching images or opening chat. |
| File types and descriptions | Use a folder with PNG/JPEG page screenshots, embedded images, and composites | Filenames and descriptions distinguish the files and identify their format and page information. Only checked files attach. |
| 20-image boundary | Create 21 distinct valid image-file copies in an ignored test extraction folder; check 20 | Exactly 20 images attach successfully. |
| Selection above the limit | In the same folder, check all 21 files; after the warning, uncheck one and confirm | The picker reopens with the original checks preserved. No images attach before correction; exactly 20 attach after correction. |
| All-images limit recovery | Choose **Add All Images to Copilot Chat** with 21 files, then **Select Images** in the warning | The selected-image picker opens, and checking a smaller subset attaches only that subset. |
| Composite attachment | Export the five-page sample in 2×2 Grid groups of 4, then check only the pages 1–4 composite file | One attachment contains all four pages. The page 5 composite is absent; selecting a composite never crops individual PDF pages. |

The composite grouping controls allow 1–4 pages per grid image and 1–16 per
vertical image. A ten-page selection with grid groups of 4 normally produces
4 + 4 + 2 pages across three files. A vertical group of 10 can produce one tall
image, subject to the existing dimension/pixel limits. Check automatic splitting
independently of total pages selected.

The automated suite establishes startup and rendering/export behavior; it does
not replace checking all toolbar interactions, representative large PDFs, chat
integration, and your supported operating systems and VS Code versions.
macOS rendering has local automated coverage; the CI matrix checks Linux and
Windows source and installed-VSIX rendering. Confirm both CI jobs pass on the
release commit. Computer-use visual and Copilot checks were performed on macOS.
Test the final versioned VSIX before publishing. When only the version, changelog,
and release documentation change after functional QA, rerun packaged integration
and confirm the compiled runtime and PDF.js assets match the manually tested
package. Repeat the affected manual checks when runtime code or dependencies change.

Record the tested commit, VS Code version, OS, automated results, manual checks,
and remaining limits in the PR. Follow [PUBLISHING.md](PUBLISHING.md) for the final
release. Keep the previous package available for recovery.

### Computer-use procedure

1. Launch **Run Extension (temporary profile)** and record the development commit
   or VSIX hash, VS Code version, and OS. Keep one computer-use controller on the
   test window, and reload that window after changing extension code.
2. Run the matrix above through the visible toolbar, input boxes, quick picks,
   and notifications. Use `sample.pdf` and `second.pdf` for deterministic page
   colors; add public PDFs with dense text, diagrams, and actual photos. Keep
   downloaded documents and disposable mixed-size/oversized fixtures under an
   ignored `.vscode-test/manual-qa/<date>/inputs/` directory.
3. Inspect the saved images independently: verify format, dimensions, page order,
   content, labels, spacing, and readability. Before duplicate tests, record file
   counts, SHA256 hashes, and modification times. Cancel and Save New Only must
   preserve existing files; Overwrite All must rewrite the selected outputs.
4. Exercise selection, search, navigation, outline links, zoom, rotation, dark
   mode, ordinary PNG/JPEG screenshots, embedded-image extraction, and extraction
   history. For Copilot, use the copied-workspace setup described above and record
   both attachment and the response's ability to read every included page.
5. Save a dated result with observed outcomes and unresolved checks. Keep local
   screenshots, before/after images, and a JSON evidence index in the ignored QA
   directory; commit the testing record, without committing downloaded PDFs or
   generated exports. Verify the final versioned VSIX using the release checks above.

### Computer-use test record: 2 October 2026

Tested on macOS 27.0.1 (build 26A434), VS Code 1.140.0, using the source Extension
Development Host and `test/fixtures/` workspace. Testing began at `7a32de8`;
the two fixes below were reloaded and retested at `1d09a64`. All actions in this
record used VS Code's visible UI, with separate inspection of exported files.
The Workspace-settings warning about `extensions.autoUpdate` did not recur.

The original F5 launch did not provide a separate User profile: VS Code reused
process/User state despite the directory arguments. Copilot testing used
the existing authentication/profile with a copied disposable fixture workspace.
This caveat applies to this manual run. The integration runner uses separate
process profiles and independently checks their isolation. The corrected F5
temporary-profile launch was then checked separately with the updated launch
configuration from the working tree before its commit; the earlier Copilot check
was not repeated in that profile.

| Check | Observed result |
| --- | --- |
| Layouts, grouping, and duplicate handling | Passed: vertical pages `2,4` at 144 DPI produced a 480×1280 PNG without added labels/gaps. The five-page grid produced 1032×1448 and 528×736 PNGs with correct page order/labels. Save New Only added only page 5; Cancel preserved hashes/times; Overwrite All rewrote both grid files. |
| Invalid input and document focus | Passed: page `6` was rejected in the five-page fixture, and Escape created no output. Switching between sample/second PDFs exported page 1 into separate folders with blue/amber content. |
| Existing screenshot flows and history | Passed: current-page and all-page PNG exports, including Extract New Only, produced five correct 360×480 images. Custom JPEG pages `2,4` produced valid 720×960 images. The existing screenshot renderer uses an additional 1.5 scale factor. Browsing NASA extraction showed 72 images; Add All correctly warned that more than 20 must be narrowed before chat attachment. |
| Mixed sizes and size limits | Passed: four portrait/landscape pages retained their proportions and order in grid (1352×1448) and vertical (640×2560) exports. A 5000×320-point page was rejected at 144 DPI without output; retrying at 72 DPI succeeded at 5024×344. |
| High-resolution automatic splitting | Passed: TraceMonkey pages `1-6`, Vertical Stack, 16 pages/image, 288 DPI, and labels split automatically into three 2544×6672 PNGs containing pages 1–2, 3–4, and 5–6. All pages/labels appeared once in order, with readable text and diagrams. |
| Real text, diagrams, and viewer controls | Passed: TraceMonkey pages 1–4 exported at 144 DPI as a readable 2520×3336 grid. Drag selection highlighted text; search reported 39 matches; next-page/direct-page entry, 50% zoom, rotation, and dark mode worked. NASA's Foreword outline bookmark navigated to the foreword. |
| Real photos and embedded images | Passed after the JPEG 2000 fix: NASA pages `8,12` exported at 216 DPI as a 3780×2520 PNG with both photos, text, captions, and labels intact. Native extraction produced 72 valid PNGs, including the 675×641 astronaut photo and 574×820 rocket photo. |
| Export lifecycle | Passed: closing a PDF while the duplicate decision was pending reported that the PDF was closed during export. A stale Overwrite All click preserved the existing file's size, hash, and modification time. Reopening and restarting reached a fresh duplicate prompt; Cancel returned quietly. |
| Copilot | Passed using existing authentication/profile and a copied disposable fixture workspace: Add to Copilot Chat attached the four-page sample composite and reported Added 1. An image-only prompt forbade workspace access, edits, and tools; GPT-5.6 Sol identified pages 1–4 as blue, green, red-orange, and purple in order. No extra installation/login was needed. |
| Corrected F5 profile and wizard focus | Passed: the new launch showed Temp 1 in the title/Profile menu and zero installed extensions while the development PDF Toolkit rendered. Switching from sample to second PDF dismissed the open wizard quietly. All 89 previous outputs retained their hashes/times; a fresh second-PDF export added only the expected amber 240×320 PNG. Application settings/authentication remain shared as described above. |

Computer use exposed two defects that were fixed and retested: cancelling an
existing-output prompt displayed an error notification, and JPEG 2000 photos
were absent because PDF.js's bundled decoder assets lacked the required
`wasmUrl` and webview content-security-policy configuration. Cancellation now
returns quietly with files intact; both NASA photos render and export.
Runtime rechecks at `1d09a64` passed all 46 Node tests, lint, and dependency
audit (zero reported vulnerabilities). Real VS Code integration passed from
source on 1.140.0 and the minimum supported 1.96.0, and from the rebuilt VSIX on
1.140.0. These checks include JPEG 2000 composite and ordinary screenshot
rendering with decoded-color assertions. After the launch/manifest/documentation
updates, source and installed-package integration were repeated successfully on
1.140.0. The pre-release testing package was `artifacts/pdf-toolkit-2.1.0.vsix`
(11,668,960 bytes), SHA256
`5543d32e88a213cb739b6656a03b28d123a32a72e83dffeee0aa44e2c31c0ce0`.

The public inputs were [Mozilla's TraceMonkey sample](https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf)
(14 pages) and [NASA's Artemis I reference guide](https://www.nasa.gov/wp-content/uploads/2023/03/Artemis20I20Reference20Guide_Inter.pdf)
(90 pages). Inputs, generated fixtures, before/after PNGs, and timestamped
hash/dimension evidence remain locally under `.vscode-test/manual-qa/2026-10-02/`;
`evidence-index.json` lists the evidence and exported-file metadata.

The computer-use run above did not exercise a Windows desktop. Windows automated
source and installed-VSIX rendering is now part of CI; its run links and results
are recorded on the PR. Copilot's attachment/response check passed
with the existing profile; it was not repeated inside the corrected temporary
profile. The existing automated grouping/size-limit tests supplement this record.

### Final 2.2.0 package verification: 2 October 2026

The release package is `artifacts/pdf-toolkit-2.2.0.vsix` (11,669,278 bytes),
SHA256 `dc5b702c094d79788ed6abce8bf8c2d919e2965dd77e995f0d71d1978f55c2a9`.
Lint and all 46 Node tests passed during packaging. Source and installed-VSIX
integration passed again on macOS, VS Code 1.140.0, including activation, real
PDF.js and JPEG 2000 rendering, grid/vertical/grouped composites, ordinary
screenshots, and multiple PDFs. The isolated installation's version was verified
as 2.2.0.

Comparing both VSIX archives confirmed identical file membership, compiled
runtime, and PDF.js assets. Only the package manifests, changelog, and publishing
documentation changed from the package used for functional QA. The manual test
record above therefore remains applicable. Final Windows/Linux CI results and
the tested release commit are recorded on PR #8 before manual Marketplace upload.
The GitHub workflows validate the extension; they do not publish it.

References: [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
and [publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Issue #3 attachment QA: 3 October 2026

Tested the unreleased selected-image attachment flow through the source extension
and visible VS Code UI on macOS, VS Code 1.140.0. A disposable workspace was used
with the existing VS Code profile and Copilot authentication.

| Check | Observed result |
| --- | --- |
| Large extraction folder | Passed: the synthetic folder listed all 49 PNG files, with none initially checked. |
| Cancellation and empty selection | Passed: Escape and confirming an empty selection produced no attachments. |
| Individual selection | Passed: checking page 2 and page 4 produced exactly two direct image attachments in the chat composer. |
| More than 20 files | Passed: checking all 21 files in a separate synthetic folder was blocked before attachment. The picker immediately reopened with all 21 checks preserved. |
| Correcting the selection | Passed: unchecking page 1 and confirming attached exactly 20 images, corresponding to pages 2–21. |
| All-images limit recovery | Passed: **Add All Images to Copilot Chat** reported the 49-file selection and 20-file limit, offering **Select Images**. That action opened all 49 files unchecked; choosing pages 2 and 4 attached exactly those two images. |
| JPEG discovery and filtering | Passed: `page_002.JPEG` and `page_004.JPEG` appeared as exactly two selectable JPEG files. `notes.txt` and the `skip.png` directory were excluded. Selecting both produced exactly two JPEG chat attachments. |
| Composite attachment | Passed: the pages 1–4 composite description listed every included page and explained that the complete composite counts as one image. Selecting it produced exactly one composite PNG chat attachment. |

Lint and all 64 Node tests passed, including 18 attachment checks. Isolated native
integration passed on macOS, VS Code 1.140.0, both from source and from a custom
installed VSIX. These checks cover activation and registered commands, PDF.js
and JPEG 2000 rendering, grid/vertical/grouped composites, ordinary screenshots,
and multiple PDFs.

The manual run verified selection and chat attachments on macOS; it did not
exercise a Windows desktop or ask a model to analyse the images. A short `Add All`
text was accidentally submitted during a focus change and cancelled; no workspace
edits resulted. The existing profile/authentication caveat applies to this run.
Test attachments were cleared and the Extension Development Host was closed
after the checks.
