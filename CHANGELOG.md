# Changelog

All notable changes to PDF Toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-02-08

### Added
- **Branding header**: PDF Toolkit logo and name displayed above the toolbar; clickable to open the extension details page
- **Debug logging setting**: New `pdfToolkit.debug` setting to enable diagnostic logging to the Output panel (PDF Toolkit Debug channel) — zero overhead when disabled

### Changed
- **Zero-copy PDF loading**: PDFs are now served to the webview via URI instead of base64 encoding, eliminating ~4x memory overhead for large files
- **Multi-editor support**: Opening multiple PDFs simultaneously now works correctly; zoom, extraction, and screenshots target the focused editor
- **Screenshot buttons** now respect user-configured quality and format settings instead of hardcoding 2.0x PNG

### Fixed
- **Search highlighting**: Rewrote search to use PDF.js built-in `TextLayer` API with proper span-splitting highlights — matches are now accurately highlighted on the correct text
- **Config namespace**: Screenshot extraction settings now read from the correct `pdfToolkit` namespace (was incorrectly reading `pdfViewer`)
- **Memory leak**: `PdfDocument` no longer holds file data in memory after the webview is set up
- **Image filter threshold**: Increased minimum image size from 1x1 to 10x10 pixels to avoid capturing noise artefacts

### Improved
- Removed `console.log` statements from production code
- Replaced `require('path')` with static ES module imports in extension.ts
- Added per-page progress messages during multi-page screenshot extraction
- Methods now receive explicit document/panel references instead of relying on mutable class state

## [2.0.0] - 2026-02-08

### Added
- **🖼️ Image Extraction**: Extract embedded raster images (photos, bitmaps, pre-rendered figures) directly from PDFs at native resolution
  - New "Extract Images" option in the Screenshot dropdown menu
  - Scans all pages for embedded image objects (JPEG, PNG, inline images)
  - Saves to `PDF-Screenshots/[filename]/` folder alongside page screenshots
  - Filenames include image index, page number, and dimensions (e.g., `image_001_page3_800x600.png`)
  - Option to add extracted images directly to GitHub Copilot Chat
  - Duplicate detection: skips already-extracted images with option to overwrite

### Fixed
- **PDF.js v5 compatibility**: Image extraction now correctly handles `ImageBitmap` objects returned by pdfjs-dist v5.x (previously silently failed to detect any images)
- **Image object availability**: Pages are re-rendered before extraction to ensure PDF.js page objects are populated (fixes timeout errors on large PDFs)
- **Inline image support**: Now detects inline images (OPS code 86) and image repeats (OPS code 88) in addition to standard XObject images
- **Improved error reporting**: Extraction failures now log warnings to the console instead of being silently swallowed; user-facing message explains the difference between raster images and vector graphics

### Changed
- Major version bump to reflect significant new functionality
- Screenshot dropdown menu now includes image extraction option
- "No images found" message now explains that vector graphics require Screenshot instead, with a one-click "Screenshot Current Page" action

## [1.10.0] - 2026-01-28

### Added
- **Search (Ctrl+F)**: Search within PDF documents with real-time highlighting, match count, and prev/next navigation
- **Outline/TOC Panel**: Toggle document outline sidebar with the 📑 button or `O` key - click headings to jump to sections (available when PDF has bookmarks)

### Changed
- Toolbar now includes search bar and outline toggle button
- Added keyboard shortcuts: `Ctrl+F` for search, `O` for outline toggle

## [1.9.0] - 2026-01-27

### Added
- **Page Rotation**: Rotate pages 90° clockwise or counter-clockwise with toolbar buttons (↶ ↷) or keyboard shortcuts (`R` / `Shift+R`)
- **Dark Mode**: Toggle dark mode for comfortable reading with the 🌙 button or `D` key - inverts colours while preserving readability
- **Text Selection**: Select and copy text from PDFs - enabled via PDF.js text layer rendering

### Changed
- Keyboard shortcuts now skip when user is typing in input fields
- Page rendering now includes text layer overlay for selection

## [1.8.0] - 2026-01-26

### Added
- **Direct Copilot Chat Integration**: New "Add to Copilot Chat" option that programmatically attaches extracted images directly to GitHub Copilot Chat using VS Code's built-in `workbench.action.chat.open` command

### Changed
- Primary workflow now uses direct attachment instead of clipboard-based `#file:` references
- Updated README with new workflow instructions

### Removed
- Removed clipboard-based `#file:` reference method (was not working reliably with Copilot Chat)

## [1.7.0] - 2026-01-26

### Added
- Auto-discovery of extracted PDFs by scanning the screenshots folder
- "Refresh List" option in Browse Extracted PDFs menu for users to rescan the folder
- "Change Folder Name..." option to let users customise the screenshots folder
- New setting `pdfToolkit.screenshotsFolder` to configure the folder name (default: `PDF-Screenshots`)
- Extracted PDFs are now sorted by most recently modified first

### Changed
- Renamed screenshots folder from `PDF Screenshots` to `PDF-Screenshots` for better compatibility with `#file:` references in Copilot Chat
- Browse Extracted PDFs now scans the folder directly instead of relying only on workspace state history
- Improved reliability when folders are renamed or moved

### Removed
- "Clear History" option (no longer needed as folder scanning is automatic)

## [1.6.2] - 2026-01-13

### Added
- Table of Contents in README for better navigation
- Updated description to highlight AI assistant integration

### Changed
- Icon updated with transparent background for better display with rounded corners
- README improvements with clearer installation instructions

### Fixed
- Folder existence validation in "Browse Extracted PDFs" feature - deleted folders no longer appear in the list

## [1.6.1] - 2026-01-12

### Added
- Editable zoom percentage field in toolbar (25%-500% range)
- Users can now type a custom zoom percentage directly

### Changed
- Zoom input field is now editable instead of read-only

## [1.6.0] - 2026-01-12

### Changed
- Upgraded pdfjs-dist from v4 to v5.4.530 (latest version)
- Improved PDF rendering performance

## [1.5.0] - 2026-01-12

### Changed
- Renamed all internal command identifiers from `pdfViewer.*` to `pdfToolkit.*`
- Consistent naming across all commands and settings

## [1.4.0] - 2026-01-12

### Added
- Custom extension icon with PDF symbol design
- Screenshot menu with QuickPick interface
- Three screenshot options: Current Page, All Pages, Custom Wizard
- Multi-step Custom Wizard for page extraction:
  - Step 1: Select specific pages (e.g., "1,3,5-10" or "all")
  - Step 2: Choose resolution (72-288 DPI)
  - Step 3: Select format (PNG/JPEG)
- Browse Extracted PDFs command to view extraction history
- "Copy for Copilot Chat" button in extraction notifications

### Changed
- Improved toolbar UI with dropdown screenshot menu
- Better organization of extraction commands

## [1.3.0] - 2026-01-11

### Changed
- Renamed extension from "PDF Viewer" to "PDF Toolkit"
- Updated publisher to "TimHaintz"
- Updated author information

## [1.2.0] - 2026-01-11

### Added
- Improved workflow for AI-assisted document analysis

## [1.1.0] - 2026-01-11

### Added
- Page extraction/screenshot feature
- Toolbar buttons for extracting current page and all pages
- PNG and JPEG export formats
- Configurable extraction quality (DPI settings)
- "PDF Screenshots" folder organization by PDF name

## [1.0.0] - 2026-01-11

### Added
- Initial release of PDF Toolkit
- Native PDF rendering in VS Code using Mozilla PDF.js
- Full image and graphics support
- Zoom controls (in, out, fit width, reset)
- Page navigation with toolbar buttons
- Keyboard shortcuts for navigation:
  - Arrow keys and Page Up/Down for page navigation
  - Home/End for first/last page
  - +/- for zoom control
- Jump to specific page via toolbar input
- Scroll-based continuous viewing
- Configuration settings for default zoom, toolbar visibility, and extraction quality

---

## Release Notes

### 1.6.x - Quality of Life Improvements
Focus on user experience improvements including editable zoom, folder validation, and documentation updates.

### 1.5.x - Command Consistency
Standardized all command identifiers to use `pdfToolkit.*` prefix for consistency.

### 1.4.x - Screenshot Workflow
Major feature release adding the screenshot menu, custom wizard, and Copilot Chat integration.

### 1.3.x - Rebranding
Renamed extension and updated publisher/author information.

### 1.2.x - AI Integration
Enhanced workflow for using extracted pages with AI assistants.

### 1.1.x - Page Extraction
Added the core screenshot/extraction functionality.

### 1.0.x - Foundation
Initial release with core PDF viewing capabilities.
