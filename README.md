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
- [Configuration](#configuration)
- [Technical Details](#technical-details)
- [Requirements](#requirements)
- [Responsible Use](#responsible-use)
- [Contributing](#contributing)
- [Issues & Feature Requests](#issues--feature-requests)
- [License](#license)
- [Author](#author)

## Why PDF Toolkit?

**The Problem:** VS Code cannot natively display PDF files, and AI assistants like GitHub Copilot cannot read PDF content directly.

**The Solution:** PDF Toolkit provides:
1. **Native PDF Viewing** - View PDFs directly in VS Code without leaving your editor
2. **AI-Ready Screenshots** - Extract PDF pages as images that can be shared with GitHub Copilot Chat using `#file:` references, enabling AI to "read" and analyze your PDF content

### Use Case: Share PDFs with GitHub Copilot

1. Open a PDF in VS Code
2. Click **📷 Screenshot** → **All Pages** to extract pages as images
3. Click **Add to Copilot Chat** in the notification
4. The images are automatically attached to Copilot Chat - the AI can now see and analyse your PDF content!

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

### Navigation and Zoom
- **Zoom Controls**: Zoom in, zoom out, fit to width, and reset zoom
- **Page Navigation**: Jump to any page using toolbar or keyboard
- **Keyboard Shortcuts**: Full keyboard support for efficient navigation

### Page Extraction (Screenshot to Images)
- **Screenshot Menu**: Click the 📷 Screenshot button for quick access to all export options
- **Current Page**: Save the currently viewed page as a PNG/JPEG image
- **All Pages**: Export every page of a PDF as individual images
- **Custom Wizard**: Multi-step wizard to select specific pages, resolution (72-288 DPI), and format (PNG/JPEG)
- **Quality Settings**: Configurable DPI for extracted images

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

### Commands

Access via Command Palette (`Ctrl+Shift+P`):

- `PDF Toolkit: Open PDF` - Open a PDF file using file picker
- `PDF Toolkit: Screenshot Menu` - Open screenshot options menu
- `PDF Toolkit: Screenshot All Pages` - Export all pages as images
- `PDF Toolkit: Screenshot Current Page` - Export currently viewed page
- `PDF Toolkit: Screenshot Custom...` - Open multi-step wizard for custom extraction
- `PDF Toolkit: Browse Extracted PDFs` - View and manage previously extracted PDFs
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

When you extract pages, they are saved to a `PDF-Screenshots/<pdf-name>` folder in your workspace. The extension tracks your extractions so you can easily:
- Browse previously extracted PDFs via the **📁 Extracted** button
- Copy image references for Copilot Chat with one click
- Manage your extraction history

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `pdfToolkit.defaultZoom` | `1.0` | Default zoom level |
| `pdfToolkit.showToolbar` | `true` | Show the PDF toolbar |
| `pdfToolkit.extractionQuality` | `2.0` | Quality scale (1.0=72dpi, 2.0=144dpi, 3.0=216dpi) |
| `pdfToolkit.extractionFormat` | `png` | Image format (`png` or `jpeg`) |
| `pdfToolkit.screenshotsFolder` | `PDF-Screenshots` | Folder name for storing extracted screenshots |

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
