# Publishing PDF Toolkit to the VS Code Marketplace

This guide covers the complete process from setting up your publisher account to publishing and updating the extension.

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
  "version": "2.1.0",
  "engines": { "vscode": "^1.96.0" },
  "icon": "images/icon.png",
  "repository": { "type": "git", "url": "https://github.com/timhaintz/pdf-toolkit" },
  "license": "MIT"
}
```

Required files:

| File | Purpose |
|------|---------|
| `README.md` | Marketplace landing page |
| `CHANGELOG.md` | Shown on the Changelog tab |
| `LICENSE` | Required for publishing |
| `images/icon.png` | Extension icon (at least 128×128px) |

## 5. Login with vsce

```powershell
npx @vscode/vsce login <PublisherID>
```

Paste your PAT when prompted.

To verify your PAT is still valid:

```powershell
npx @vscode/vsce verify-pat <PublisherID>
```

## 6. Publish

### First-time or manual version

```powershell
npx @vscode/vsce publish
```

This compiles (via `vscode:prepublish` script), packages, and uploads in one step.

### Auto-bump version and publish

```powershell
npx @vscode/vsce publish patch   # e.g. 2.1.0 → 2.1.1
npx @vscode/vsce publish minor   # e.g. 2.1.0 → 2.2.0
npx @vscode/vsce publish major   # e.g. 2.1.0 → 3.0.0
```

This updates `package.json`, creates a git commit and tag, then publishes.

### Package only (without publishing)

To build a `.vsix` file for local testing or manual upload:

```powershell
npx @vscode/vsce package
```

Install it locally with:

```powershell
code --install-extension pdf-toolkit-<version>.vsix --force
```

## 7. Verify

After publishing, check your extension at:

- **Extension page**: https://marketplace.visualstudio.com/items?itemName=TimHaintz.pdf-toolkit
- **Management hub**: https://marketplace.visualstudio.com/manage/publishers/TimHaintz/extensions/pdf-toolkit/hub

It may take a few minutes for the listing to fully propagate.

## Update Workflow (for future releases)

1. Make code changes
2. Update `CHANGELOG.md`
3. Compile and test: `npm run compile`
4. Commit and push to git
5. Publish: `npx @vscode/vsce publish patch` (or `minor` / `major`)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| PAT expired | Create a new one at Azure DevOps → Personal Access Tokens |
| `not authorized` error | PAT needs **All accessible organizations** and **Marketplace → Manage** scope |
| `publisher not found` | Create publisher at https://marketplace.visualstudio.com/manage |
| Changes not visible after install | An older installed VSIX can silently override dev code — package and install locally first |
| `verify-pat` hangs or fails | Try `npx @vscode/vsce login <PublisherID>` with a fresh PAT |

## References

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) — official VS Code docs
- [vsce CLI Reference](https://github.com/microsoft/vscode-vsce) — GitHub repository
- [Marketplace Publisher Management](https://marketplace.visualstudio.com/manage) — manage your extensions
