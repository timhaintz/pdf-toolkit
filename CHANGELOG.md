# Changelog

All notable changes to PDF Toolkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
