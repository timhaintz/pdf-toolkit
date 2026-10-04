# Publishing PDF Toolkit to the VS Code Marketplace

This guide covers the complete process from setting up your publisher account to publishing and updating the extension.

The current release candidate is **2.4.0**. PDF Toolkit uses the existing
**TimHaintz** publisher and **PDF Toolkit** extension. The default update path is
to build and test a VSIX, then upload that exact file manually as described in
[section 6](#6-build-test-and-upload-the-release). Account setup and CLI login
below are only needed when setting up a publisher or choosing CLI publication.

## Prerequisites

- [Node.js](https://nodejs.org/) installed
- A Microsoft account
- The `@vscode/vsce` tool (included as a dev dependency, or install globally with `npm install -g @vscode/vsce`)

## 1. Create an Azure DevOps Organisation

1. Go to https://dev.azure.com
2. Sign in with your Microsoft account (or create one)
3. If you don't have an organisation, create one (any name works)

## 2. Create a Publisher

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with the **same Microsoft account** used for Azure DevOps
3. Click **Create Publisher**
4. Fill in:
   - **ID**: Your publisher ID (this goes in `package.json` as `"publisher"`)
   - **Display Name**: Your name or organisation
5. Accept the Marketplace Publisher Agreement

## 3. Create a Personal Access Token (PAT)

1. Go to https://dev.azure.com → click your profile icon (top right) → **Personal Access Tokens**
2. Click **+ New Token**
3. Set:
   - **Name**: `vsce-publish` (or any descriptive name)
   - **Organization**: **All accessible organizations** (important — must not be scoped to a single org)
   - **Expiration**: Your preference (maximum 1 year)
   - **Scopes**: Click **Show all scopes** → find **Marketplace** → check **Manage**
4. Click **Create** → **copy the token** immediately (you only see it once)

## 4. Prepare the Extension for Publishing

Ensure `package.json` has these key fields:

```json
{
  "name": "pdf-toolkit",
  "displayName": "PDF Toolkit",
  "publisher": "TimHaintz",
  "version": "2.4.0",
  "engines": { "vscode": "^1.96.0" },
  "icon": "images/icon.png",
  "repository": { "type": "git", "url": "https://github.com/timhaintz/pdf-toolkit" },
  "license": "MIT"
}
```

Required files:

| File | Purpose |
|------|---------|
| `README.md` | Packaged content for the Marketplace Details page |
| `CHANGELOG.md` | Packaged release history for VS Code and Marketplace release-notes surfaces |
| `LICENSE` | Required for publishing |
| `images/icon.png` | Extension icon (at least 128×128px) |
| `images/pdf-toolkit-workflow.gif` | Recorded walkthrough referenced by the README |

Include the current README and changelog in the tested VSIX. They travel with the
package; no separate text paste is needed during manual upload. Verify how the
published listing and installed extension display them after upload.

Include the walkthrough GIF in the VSIX and confirm that the packaged README's
rewritten HTTPS GitHub image URL resolves to that asset from merged `main`.
Check the demonstration displays on the Marketplace Details page after upload.

## 5. Login with vsce

```powershell
npx @vscode/vsce login <PublisherID>
```

Paste your PAT when prompted.

To verify your PAT is still valid:

```powershell
npx @vscode/vsce verify-pat <PublisherID>
```

## 6. Build, Test, and Upload the Release

### Package only (without publishing)

Prepare the release version and dated changelog before packaging, and preserve
the previously released VSIX. Move the release notes from `Unreleased` into the
dated version section, then remove the empty `Unreleased` heading so the latest
release appears first in the packaged changelog. Restore or add an `Unreleased`
section when development for the next release starts.

From clean, synced `main` after the approved release changes have merged, build
the final `.vsix`:

```powershell
npm run package:vsix
```

This runs lint and Node tests and writes
`artifacts/pdf-toolkit-2.4.0.vsix` for the current candidate. Test source and the
actual installed VSIX in temporary VS Code profiles and workspaces:

```powershell
npm run test:integration -- --packaged
```

Record the release commit, file size, SHA256, VS Code/OS, test results, and final
CI links. Inspect the packaged and installed manifests for version `2.4.0`, and
check that README, changelog, compiled code, and PDF.js assets are included.
Once the file passes testing, keep it unchanged; a rebuild is a new candidate
that must be verified again.

### Manual update (default)

1. Open [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage) and sign in to the existing publisher account.
2. Select **TimHaintz** and locate the existing **PDF Toolkit** extension.
3. Use the existing extension's update/upload action and select the exact tested `artifacts/pdf-toolkit-2.4.0.vsix`. Confirm version `2.4.0` and submit the update. Follow the labels shown by the current UI; do not create another extension or publisher.
4. Wait for Marketplace verification to finish, then complete [section 7](#7-verify). A **Verifying** status does not mean the release is publicly available.

### CLI publication (optional)

If CLI publication is explicitly chosen instead, use the existing tested package
after authenticating:

```powershell
npx @vscode/vsce publish --packagePath artifacts/pdf-toolkit-2.4.0.vsix
```

For later releases, replace `2.4.0` with that release's version. Plain
`vsce publish` and version-bump forms package again and can change version/commit
metadata, so they bypass this tested-file handoff.

## 7. Verify

After verification completes, confirm the public version and the packaged
README/changelog content at:

- **Extension page**: https://marketplace.visualstudio.com/items?itemName=TimHaintz.pdf-toolkit
- **Management hub**: https://marketplace.visualstudio.com/manage/publishers/TimHaintz/extensions/pdf-toolkit/hub

It may take a few minutes for the listing to fully propagate.
Install or update from the Marketplace in a disposable verification environment
and check startup and the affected feature before recording the release as public.

## Update Workflow (for future releases)

1. Create a feature branch from current `main` and make the change.
2. Run `npm run lint` and `npm test` (compilation alone does not run tests).
3. Run `npm run test:integration` to verify startup, real PDF rendering, and exports in an isolated VS Code instance.
4. Press F5 using **Run Extension (temporary profile)** and complete the manual checks in [DEVELOPMENT.md](DEVELOPMENT.md), including Copilot attachment when relevant.
5. Update the manifest and lockfile version together, move the release notes from Unreleased to a dated changelog section, and review README instructions.
6. Review the PR and final-head CI, then merge the approved release changes. From clean, synced `main`, preserve the previous VSIX, run `npm run package:vsix`, and run `npm run test:integration -- --packaged` to verify source and the actual distributable. These commands do not publish.
7. Record and retain the exact tested artifact, then manually update the existing Marketplace extension using [section 6](#manual-update-default). Verify publication separately after upload.

The GitHub Actions workflows run Linux/Windows validation, package integration,
and CodeQL on PRs and `main`.
They do not publish to the VS Code Marketplace. Publishing is a separate,
authenticated step; merging a PR or pushing to `main` alone does not release it.

Keep the previously released VSIX available. If the new release needs to be
reverted, restore the previous behavior and publish a higher patch version;
installed clients normally update to increasing versions.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| PAT expired | Create a new one at Azure DevOps → Personal Access Tokens |
| `not authorized` error | PAT needs **All accessible organizations** and **Marketplace → Manage** scope |
| `publisher not found` | Create publisher at https://marketplace.visualstudio.com/manage |
| Changes not visible during development | Use the isolated F5 profile, verify the development extension is active, and reload the development host after compilation |
| `verify-pat` hangs or fails | Try `npx @vscode/vsce login <PublisherID>` with a fresh PAT |

## References

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) — official VS Code docs
- [vsce CLI Reference](https://github.com/microsoft/vscode-vsce) — GitHub repository
- [Marketplace Publisher Management](https://marketplace.visualstudio.com/manage) — manage your extensions
