# PDF Toolkit for VS Code

A powerful PDF viewer extension for Visual Studio Code with native rendering and page-to-image extraction capabilities designed for AI-assisted workflows.

**Author:** Tim Haintz  
**License:** MIT

## Table of Contents

- [Why PDF Toolkit?](#why-pdf-toolkit)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Opening PDFs](#opening-pdfs)
  - [Toolbar Controls](#toolbar-controls)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Commands](#commands)
  - [Custom Screenshot Wizard](#custom-screenshot-wizard)
  - [Page Extraction](#page-extraction)
  - [Composite Screenshots](#composite-screenshots)
  - [Attach Selected Images to Copilot Chat](#attach-selected-images-to-copilot-chat)
- [Configuration](#configuration)
  - [Debug Logging](#debug-logging)
  - [Changing the Screenshots Folder](#changing-the-screenshots-folder)
- [Technical Details](#technical-details)
- [Requirements](#requirements)
- [Responsible Use](#responsible-use)
- [Contributing](#contributing)
- [Development and Testing](DEVELOPMENT.md)
- [Issues & Feature Requests](#issues--feature-requests)
- [License](#license)
- [Author](#author)

## Why PDF Toolkit?

**The Problem:** VS Code cannot natively display PDF files, and AI assistants like GitHub Copilot cannot read PDF content directly.

**The Solution:** PDF Toolkit provides:

1. **Native PDF Viewing** - View PDFs directly in VS Code without leaving your editor
2. **AI-Ready Screenshots** - Extract PDF pages as images and attach them directly to GitHub Copilot Chat, enabling AI to "read" and analyze your PDF content

### Use Case: Share PDFs with GitHub Copilot

1. Open a PDF in VS Code
2. Click **📷 Screenshot** → **All Pages** to extract pages as images
3. Click **Add to Copilot Chat** in the notification
4. The images are automatically attached to Copilot Chat - the AI can now see and analyse your PDF content!

To share only some of the saved images, use **📁 Extracted → select a folder → Add Selected Pages to Copilot Chat** and check the files you want to attach. PDF Toolkit allows up to 20 image files per attachment action.

This is perfect for:
- 📚 Research papers and academic articles
- 📋 Technical documentation and specifications
- 📊 Reports with charts and diagrams
- 📝 Any PDF you want AI assistance with

## Features

### PDF Viewing
- **Native PDF Rendering**: View PDF files directly in VS Code using Mozilla PDF.js
- **Full Image Support**: All embedded images, graphics, and diagrams render correctly
- **Scroll-based Viewing**: Scroll through all pages continuously
- **Text Selection**: Select and copy text directly from PDFs
- **Dark Mode**: Toggle inverted colours for comfortable reading (🌙 button or `D` key)

### Navigation and Zoom
- **Zoom Controls**: Zoom in, zoom out, fit to width, and reset zoom
- **Page Navigation**: Jump to any page using toolbar or keyboard
- **Page Rotation**: Rotate pages 90° clockwise (`R`) or counter-clockwise (`Shift+R`)
- **Keyboard Shortcuts**: Full keyboard support for efficient navigation

### Search and Outline
- **Search (Ctrl+F)**: Find text within PDF documents with real-time highlighting
- **Match Navigation**: Navigate between search matches with prev/next buttons or Enter key
- **Match Counter**: See current match position and total count (e.g., "3 of 17")
- **Outline/TOC Panel**: Toggle document outline sidebar to navigate via bookmarks (`O` key)

### Page Extraction (Screenshot to Images)
- **Screenshot Menu**: Click the 📷 Screenshot button for quick access to all export options
- **Current Page**: Save the currently viewed page as a PNG/JPEG image
- **All Pages**: Export every page of a PDF as individual images
- **Custom Wizard**: Multi-step wizard to select specific pages, resolution (72-288 DPI), and format (PNG/JPEG)
- **Composite PNGs**: Combine up to 16 pages per image in a vertical stack, or up to 4 in a 2×2 grid, with optional spacing and page labels. Group longer selections into multiple images automatically; image size limits can split groups further.
- **Selected Copilot Attachments**: Choose individual saved PNG/JPEG files with checkboxes before attaching them to GitHub Copilot Chat, including page screenshots, embedded images, and composites.

### Image Extraction
- **Extract Embedded Images**: Extract embedded raster images (photos, bitmaps, pre-rendered figures) directly from PDFs at their native resolution
- **Automatic Detection**: Scans all pages for embedded image objects (JPEG, PNG, inline images) using PDF.js operator analysis
- **Smart Naming**: Filenames include image index, page number, and dimensions (e.g., `image_001_page3_800x600.png`)
- **Copilot Integration**: Add extracted images directly to GitHub Copilot Chat for AI analysis
- **Duplicate Detection**: Skips images that have already been extracted, with options to overwrite

> **Note:** "Extract Images" finds embedded **raster** images (photos, bitmaps) stored inside the PDF. Charts and diagrams drawn as **vector graphics** (common from matplotlib, R/ggplot, Excel, LaTeX/TikZ) are not embedded images — use **Screenshot** to capture those pages instead.

## Installation

### From VS Code Marketplace (Recommended)
1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "PDF Toolkit"
4. Click **Install**

Or install directly via the command line:

**Bash / macOS / Linux:**
```bash
code --install-extension TimHaintz.pdf-toolkit
```

**PowerShell:**
```powershell
code --install-extension TimHaintz.pdf-toolkit
```

**Command Prompt (cmd):**
```cmd
code --install-extension TimHaintz.pdf-toolkit
```

### From VSIX File
1. Download the `.vsix` file
2. Open VS Code
3. Press `Ctrl+Shift+P` and type "Install from VSIX"
4. Select the downloaded `.vsix` file

## Usage

### Opening PDFs
Simply open any `.pdf` file in VS Code. The PDF Toolkit will automatically display it.

### Toolbar Controls

| Button | Action |
|--------|--------|
| Prev / Next | Navigate between pages |
| Page Input | Jump to a specific page |
| - / + | Zoom out / in |
| Fit Width | Zoom to fit the page width |
| Reset | Reset zoom to 100% |
| 📷 Screenshot ▾ | Opens screenshot menu with options: |
| └ 📄 Current Page | Extract current page as image |
| └ 📚 All Pages | Extract all pages as images |
| └ ⚙️ Custom... | Open multi-step wizard for custom extraction |
| └ ▦ Composite... | Combine selected pages into PNG images |
| └ 🖼️ Extract Images | Extract embedded raster images (photos, bitmaps) |
| ↶ / ↷ | Rotate pages counter-clockwise / clockwise |
| 🌙 | Toggle dark mode |
| 🔍 Search | Search text within the PDF (Ctrl+F) |
| 📑 Outline | Toggle document outline/TOC sidebar |
| 📁 Extracted | Browse previously extracted PDFs |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Left Arrow or Page Up | Previous page |
| Right Arrow or Page Down | Next page |
| Home | First page |
| End | Last page |
| + or = | Zoom in |
| - | Zoom out |
| R | Rotate pages clockwise (90°) |
| Shift + R | Rotate pages counter-clockwise (90°) |
| D | Toggle dark mode |
| Ctrl + F | Focus search input |
| O | Toggle outline/TOC panel |
| Escape | Clear search / Close outline |

### Commands

Access via Command Palette (`Ctrl+Shift+P`):

- `PDF Toolkit: Open PDF` - Open a PDF file using file picker
- `PDF Toolkit: Screenshot Menu` - Open screenshot options menu
- `PDF Toolkit: Screenshot All Pages` - Export all pages as images
- `PDF Toolkit: Screenshot Current Page` - Export currently viewed page
- `PDF Toolkit: Screenshot Custom...` - Open multi-step wizard for custom extraction
- `PDF Toolkit: Screenshot Composite...` - Combine selected pages into PNG images
- `PDF Toolkit: Browse Extracted PDFs` - View and manage previously extracted PDFs
- `PDF Toolkit: Attach Extracted Pages to Copilot Chat` - Choose an extracted folder and optionally filter its images by page range
- `PDF Toolkit: Zoom In` - Increase zoom level
- `PDF Toolkit: Zoom Out` - Decrease zoom level
- `PDF Toolkit: Reset Zoom` - Reset to 100% zoom

### Custom Screenshot Wizard

The **Custom** option in the screenshot menu opens a 3-step wizard:

1. **Select Pages**: Enter page numbers or ranges (e.g., `1,3,5-10`) or type `all`
2. **Select Resolution**: Choose from:
   - Standard (72 DPI) - Smaller files
   - High (144 DPI) - Balanced quality
   - Very High (216 DPI) - Better quality
   - Maximum (288 DPI) - Best quality
3. **Select Format**: Choose PNG (lossless) or JPEG (smaller size)

### Page Extraction

When you extract pages, they are saved to a `PDF-Screenshots/<pdf-name>/` folder in your workspace. Extracted embedded images are also saved to the same folder with descriptive filenames. The extension tracks your extractions so you can easily:

- Browse previously extracted PDFs via the **📁 Extracted** button
- Attach all saved images or choose individual files for Copilot Chat
- Manage your extraction history

### Composite Screenshots

Choose **📷 Screenshot → Composite...**, or run **PDF Toolkit: Screenshot Composite...**.
Select pages/ranges (such as `1-16`), a layout, maximum pages per image, resolution,
and appearance. The number of pages selected is separate from the maximum number
combined into each output image:

| Layout | Maximum pages per image | Example with 10 selected pages |
| --- | --- | --- |
| 2×2 Grid | Choose 1–4 | With 4 pages/image, normally three PNGs contain 4 + 4 + 2 pages. |
| Vertical Stack | Choose 1–16 | With 10 pages/image, one tall PNG contains all 10 if it fits the image size limits. |

Grid uses up to two columns; it does not automatically expand into a larger grid
for longer selections. The final image can contain fewer pages than the chosen
maximum. For example, a 16-page selection grouped four at a time produces four
PNGs, subject to the size limits below.

Composites use a white background and are saved separately in
`PDF-Screenshots/<pdf-name>-composites/`, so browsing and attaching them does not
mix them with individual page screenshots. Filenames identify the included pages,
layout, resolution, and appearance. Existing files require an overwrite decision.
Each image keeps the selected resolution; groups split further if they would exceed
8,192 pixels on either side or 32 million pixels. If a single page is too large,
choose a lower resolution. Large stitched images may become harder to read when
an assistant resizes them; use smaller groups or higher resolution as appropriate.

Use **Add to Copilot Chat** after export, or select the composite folder in
**📁 Extracted** and choose **Add Selected Pages to Copilot Chat** to pick individual
composite files. The **Attach Extracted Pages to Copilot Chat** command also supports
page filtering: it attaches an entire composite if it contains any selected page.
Creating a PNG only saves it locally; attaching it to chat is a separate action.

### Attach Selected Images to Copilot Chat

1. Click **📁 Extracted**, or run **PDF Toolkit: Browse Extracted PDFs** from the Command Palette.
2. Select the folder containing your saved page screenshots, embedded images, or composites.
3. Choose **Add Selected Pages to Copilot Chat**.
4. Check the image files you want to attach, then press **Enter**. The list shows each filename, its page information, and PNG/JPEG format. No files are checked initially.

Only the checked files are attached. Press **Escape** to cancel, or confirm with
nothing checked to finish without attaching anything. Selecting more than 20
files displays a warning and reopens the list with your checks preserved, so you
can reduce the selection. **Add All Images to Copilot Chat** attaches every image
in the folder and offers **Select Images** when there are more than 20 files.
The limit applies to the files selected for this attachment action.

A composite is one image file and counts as one attachment, even when it contains
several PDF pages. Selecting that file attaches the whole image; it does not
extract individual pages from the composite. Choose individual page screenshots
when you need to share only one page from an existing composite.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `pdfToolkit.defaultZoom` | `1.0` | Default zoom level |
| `pdfToolkit.showToolbar` | `true` | Show the PDF toolbar |
| `pdfToolkit.extractionQuality` | `2.0` | Quality scale (1.0=72dpi, 2.0=144dpi, 3.0=216dpi) |
| `pdfToolkit.extractionFormat` | `png` | Image format (`png` or `jpeg`) |
| `pdfToolkit.screenshotsFolder` | `PDF-Screenshots` | Folder name for storing extracted screenshots |
| `pdfToolkit.debug` | `false` | Enable debug logging to the Output panel (PDF Toolkit Debug channel) |

### Debug Logging

To enable debug logging:
1. Open **Settings** (`Ctrl+,`) and search for `pdfToolkit.debug`
2. Check the box to enable it
3. Reopen any PDF file (the setting is applied when a PDF is opened)
4. Open **View → Output** and select **PDF Toolkit Debug** from the dropdown

Debug output includes search match details, text layer diagnostics, and other internal state useful for troubleshooting. Set `pdfToolkit.debug` to `false` (unchecked) to disable — there is zero overhead when disabled.

### Changing the Screenshots Folder

You can change the folder name where screenshots are saved:
1. Click **📁 Extracted** button in the PDF viewer
2. Select **⚙️ Change Folder Name...**
3. Enter your preferred folder name
4. Click **🔄 Refresh** to scan the new folder

Or change it directly in VS Code Settings: search for "PDF Toolkit Screenshots Folder".

## Technical Details

This extension uses:
- **PDF.js**: Mozilla PDF rendering library
- **VS Code Custom Editor API**: For seamless editor integration
- **Webview**: For rendering PDF content

## Requirements

- VS Code 1.96.0 or higher

## Responsible Use

PDF Toolkit is a tool for viewing and extracting images from PDF files. Users are responsible for ensuring their use complies with applicable laws and policies.

### ✅ Generally Appropriate Use
- Your own documents and creations
- Public domain materials
- Documents you have explicit permission to copy
- Fair use purposes (research, education, commentary, criticism)
- Work documents you're authorized to access and share

### ⚠️ Consider Before Extracting
- **Copyrighted materials** - Respect intellectual property rights
- **Confidential documents** - Follow NDA and confidentiality agreements
- **Personal data** - Be mindful of privacy regulations (GDPR, etc.)
- **Corporate sensitive data** - Follow your organisation's data handling policies

### 🤖 When Sharing with AI Services
When pasting extracted images into AI assistants like GitHub Copilot:
- Content may be processed by external servers
- Check your organisation's AI usage policies
- Avoid sharing confidential, proprietary, or personal data
- Review your AI service's data handling and privacy policies

**Disclaimer:** This tool does not bypass any PDF security or DRM protections. Users are solely responsible for ensuring their use of extracted content complies with copyright laws, licensing agreements, and organizational policies.

## Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

Please ensure your code follows the existing style and includes appropriate tests.

Run the same checks as CI with Node.js 22:

```bash
npm ci --ignore-scripts
npm run lint
npm test
npm audit --audit-level=moderate
```

`npm test` compiles the extension and tests editor behavior with a VS Code adapter.
CodeQL analyzes TypeScript/JavaScript and GitHub Actions on pull requests, pushes
to `main`, and a weekly schedule.

For isolated VS Code testing, real rendering checks, and testing the packaged
extension before release, follow [Development and Testing](DEVELOPMENT.md).

## Issues & Feature Requests

Found a bug or have an idea for a new feature?

- 🐛 **Report bugs**: [Open an issue](https://github.com/timhaintz/pdf-toolkit/issues/new?labels=bug)
- 💡 **Request features**: [Open an issue](https://github.com/timhaintz/pdf-toolkit/issues/new?labels=enhancement)
- 📖 **Ask questions**: [Start a discussion](https://github.com/timhaintz/pdf-toolkit/discussions)

## License

MIT License - see LICENSE for details.

## Author

**Tim Haintz**

- GitHub: [https://github.com/timhaintz](https://github.com/timhaintz)
