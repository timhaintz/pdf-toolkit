import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Represents an opened PDF document
 */
class PdfDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;
    private _data: Uint8Array;

    constructor(uri: vscode.Uri, data: Uint8Array) {
        this.uri = uri;
        this._data = data;
    }

    public get data(): Uint8Array {
        return this._data;
    }

    dispose(): void {
        // Clean up resources
    }
}

/**
 * PDF Editor Provider - Handles rendering PDF files in VS Code
 */
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    public static readonly viewType = 'pdfToolkit.pdfCustomEditor';
    public static readonly SCREENSHOTS_FOLDER = 'PDF Screenshots';
    
    private _activeWebview: vscode.WebviewPanel | undefined;
    private _activeDocument: PdfDocument | undefined;
    private _currentZoom: number = 1.0;
    private _totalPages: number = 0;
    private _currentPage: number = 1;

    constructor(public readonly context: vscode.ExtensionContext) {}

    /**
     * Get the list of extracted PDFs from workspace state
     */
    public getExtractedPdfs(): { name: string; path: string; pageCount: number; extractedAt: string }[] {
        return this.context.workspaceState.get('extractedPdfs', []);
    }

    /**
     * Add a PDF to the extracted list
     */
    private async addExtractedPdf(name: string, outputPath: string, pageCount: number): Promise<void> {
        const extracted = this.getExtractedPdfs();
        const existing = extracted.findIndex(p => p.name === name);
        
        const entry = {
            name,
            path: outputPath,
            pageCount,
            extractedAt: new Date().toISOString()
        };

        if (existing >= 0) {
            extracted[existing] = entry;
        } else {
            extracted.push(entry);
        }

        await this.context.workspaceState.update('extractedPdfs', extracted);
    }

    /**
     * Remove a PDF from the extracted list
     */
    public async removeExtractedPdf(name: string): Promise<void> {
        const extracted = this.getExtractedPdfs();
        const filtered = extracted.filter(p => p.name !== name);
        await this.context.workspaceState.update('extractedPdfs', filtered);
    }

    /**
     * Get the screenshots output directory
     */
    private getScreenshotsDir(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return path.join(workspaceFolders[0].uri.fsPath, PdfEditorProvider.SCREENSHOTS_FOLDER);
        }
        // Fallback to PDF's directory if no workspace
        if (this._activeDocument) {
            return path.join(path.dirname(this._activeDocument.uri.fsPath), PdfEditorProvider.SCREENSHOTS_FOLDER);
        }
        throw new Error('No workspace or document available');
    }

    /**
     * Called when a PDF file is opened
     */
    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<PdfDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new PdfDocument(uri, data);
    }

    /**
     * Called to render the PDF in the webview
     */
    async resolveCustomEditor(
        document: PdfDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        this._activeWebview = webviewPanel;
        this._activeDocument = document;

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist'),
            ]
        };

        // Get URIs for PDF.js resources
        const pdfJsUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs')
        );
        const pdfWorkerUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')
        );

        // Convert PDF data to base64 for embedding
        const pdfBase64 = Buffer.from(document.data).toString('base64');

        webviewPanel.webview.html = this.getHtmlContent(
            webviewPanel.webview,
            pdfJsUri,
            pdfWorkerUri,
            pdfBase64
        );

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'ready':
                        console.log('PDF Viewer is ready');
                        break;
                    case 'error':
                        vscode.window.showErrorMessage(`PDF Error: ${message.message}`);
                        break;
                    case 'pageCount':
                        this._totalPages = message.count;
                        console.log(`PDF has ${message.count} pages`);
                        break;
                    case 'currentPage':
                        this._currentPage = message.page;
                        break;
                    case 'extractedPages':
                        await this.saveExtractedPages(message.pages, message.format);
                        break;
                    case 'openCustomMenu':
                        // Trigger the custom extraction wizard command
                        vscode.commands.executeCommand('pdfToolkit.openCustomWizard', message.totalPages, message.currentPage);
                        break;
                    case 'browseExtracted':
                        // Open the browse extracted PDFs menu
                        vscode.commands.executeCommand('pdfToolkit.browseExtracted');
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    public zoomIn(): void {
        this._currentZoom = Math.min(this._currentZoom + 0.25, 5.0);
        this.sendZoomUpdate();
    }

    public zoomOut(): void {
        this._currentZoom = Math.max(this._currentZoom - 0.25, 0.25);
        this.sendZoomUpdate();
    }

    public resetZoom(): void {
        this._currentZoom = 1.0;
        this.sendZoomUpdate();
    }

    private sendZoomUpdate(): void {
        if (this._activeWebview) {
            this._activeWebview.webview.postMessage({
                type: 'zoom',
                scale: this._currentZoom
            });
        }
    }

    /**
     * Extract pages from the PDF as images
     */
    public async extractPages(mode: 'all' | 'selected' | 'current', pageRange?: string): Promise<void> {
        if (!this._activeWebview || !this._activeDocument) {
            vscode.window.showErrorMessage('No PDF is currently open');
            return;
        }

        const config = vscode.workspace.getConfiguration('pdfViewer');
        const quality = config.get<number>('extractionQuality', 2.0);
        const format = config.get<string>('extractionFormat', 'png');

        let pages: number[] = [];

        if (mode === 'all') {
            for (let i = 1; i <= this._totalPages; i++) {
                pages.push(i);
            }
        } else if (mode === 'current') {
            pages = [this._currentPage];
        } else if (mode === 'selected' && pageRange) {
            pages = this.parsePageRange(pageRange, this._totalPages);
        }

        if (pages.length === 0) {
            vscode.window.showErrorMessage('No valid pages selected');
            return;
        }

        vscode.window.showInformationMessage(`Extracting ${pages.length} page(s) as images...`);

        this._activeWebview.webview.postMessage({
            type: 'extractPages',
            pages: pages,
            quality: quality,
            format: format
        });
    }

    /**
     * Extract pages with custom settings (from wizard)
     */
    public async extractPagesCustom(pageRange: string, quality: number, format: string): Promise<void> {
        if (!this._activeWebview || !this._activeDocument) {
            vscode.window.showErrorMessage('No PDF is currently open');
            return;
        }

        let pages: number[] = [];

        if (pageRange === 'all') {
            for (let i = 1; i <= this._totalPages; i++) {
                pages.push(i);
            }
        } else {
            pages = this.parsePageRange(pageRange, this._totalPages);
        }

        if (pages.length === 0) {
            vscode.window.showErrorMessage('No valid pages selected');
            return;
        }

        vscode.window.showInformationMessage(`Extracting ${pages.length} page(s) at ${quality * 72} DPI as ${format.toUpperCase()}...`);

        this._activeWebview.webview.postMessage({
            type: 'extractPages',
            pages: pages,
            quality: quality,
            format: format
        });
    }

    /**
     * Parse page range string like "1,3,5-10" into array of page numbers
     */
    private parsePageRange(rangeStr: string, maxPage: number): number[] {
        const pages: Set<number> = new Set();
        const parts = rangeStr.split(',');

        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes('-')) {
                const [start, end] = trimmed.split('-').map(s => parseInt(s.trim()));
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.max(1, start); i <= Math.min(maxPage, end); i++) {
                        pages.add(i);
                    }
                }
            } else {
                const page = parseInt(trimmed);
                if (!isNaN(page) && page >= 1 && page <= maxPage) {
                    pages.add(page);
                }
            }
        }

        return Array.from(pages).sort((a, b) => a - b);
    }

    /**
     * Save extracted pages to files
     */
    private async saveExtractedPages(pages: { page: number; data: string }[], format: string): Promise<void> {
        if (!this._activeDocument) {
            return;
        }

        const pdfUri = this._activeDocument.uri;
        const pdfName = path.basename(pdfUri.fsPath, '.pdf');
        
        // Use centralized PDF Screenshots folder
        const screenshotsDir = this.getScreenshotsDir();
        const outputDir = path.join(screenshotsDir, pdfName);

        try {
            // Create parent PDF Screenshots folder if needed
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(screenshotsDir));
        } catch {
            // Directory might already exist
        }

        try {
            // Create PDF-specific subfolder
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));
        } catch {
            // Directory might already exist
        }

        // Check which files already exist
        const existingFiles: string[] = [];
        const newPages: { page: number; data: string }[] = [];

        for (const pageData of pages) {
            const fileName = `page_${pageData.page.toString().padStart(3, '0')}.${format}`;
            const filePath = path.join(outputDir, fileName);
            
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                // File exists
                existingFiles.push(fileName);
            } catch {
                // File doesn't exist, add to new pages
                newPages.push(pageData);
            }
        }

        // If all files already exist, notify user and return
        if (existingFiles.length === pages.length) {
            const action = await vscode.window.showWarningMessage(
                `All ${existingFiles.length} page(s) already exist in: ${outputDir}`,
                'Open Folder',
                'Overwrite All'
            );

            if (action === 'Open Folder') {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
                return;
            } else if (action === 'Overwrite All') {
                // User chose to overwrite, proceed with all pages
                newPages.push(...pages);
            } else {
                return; // User cancelled
            }
        } else if (existingFiles.length > 0) {
            // Some files exist, some are new
            const action = await vscode.window.showWarningMessage(
                `${existingFiles.length} of ${pages.length} page(s) already exist. ${newPages.length} new page(s) to extract.`,
                'Extract New Only',
                'Overwrite All',
                'Cancel'
            );

            if (action === 'Overwrite All') {
                // Add back the existing pages to overwrite them
                for (const pageData of pages) {
                    const fileName = `page_${pageData.page.toString().padStart(3, '0')}.${format}`;
                    if (existingFiles.includes(fileName) && !newPages.some(p => p.page === pageData.page)) {
                        newPages.push(pageData);
                    }
                }
            } else if (action === 'Cancel' || !action) {
                return; // User cancelled
            }
            // 'Extract New Only' - just proceed with newPages as-is
        }

        if (newPages.length === 0) {
            vscode.window.showInformationMessage('No new pages to extract.');
            return;
        }

        const savedFiles: string[] = [];

        for (const { page, data } of newPages) {
            const fileName = `page_${page.toString().padStart(3, '0')}.${format}`;
            const filePath = path.join(outputDir, fileName);
            
            const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), buffer);
            savedFiles.push(fileName);
        }

        // Track this extraction in workspace state
        const totalPagesInFolder = existingFiles.length + savedFiles.length;
        await this.addExtractedPdf(pdfName, outputDir, totalPagesInFolder);

        // Store the full paths for potential Copilot Chat integration
        const savedFilePaths = savedFiles.map(f => path.join(outputDir, f));

        const skippedMsg = existingFiles.length > 0 ? ` (${existingFiles.length} already existed)` : '';
        const message = `Extracted ${savedFiles.length} page(s) to: ${outputDir}${skippedMsg}`;
        const action = await vscode.window.showInformationMessage(
            message,
            'Open Folder',
            'Copy for Copilot Chat',
            'Open First Image'
        );

        if (action === 'Open Folder') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
        } else if (action === 'Copy for Copilot Chat') {
            await this.copyImagesForCopilotChat(savedFilePaths);
        } else if (action === 'Open First Image' && savedFiles.length > 0) {
            const firstImage = path.join(outputDir, savedFiles[0]);
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(firstImage));
        }
    }

    /**
     * Copy image file references for use in GitHub Copilot Chat
     */
    private async copyImagesForCopilotChat(filePaths: string[]): Promise<void> {
        // Get workspace folder to create relative paths
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let references: string[] = [];

        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            references = filePaths.map(fp => {
                // Create relative path from workspace
                const relativePath = path.relative(workspaceRoot, fp).replace(/\\/g, '/');
                return `#file:${relativePath}`;
            });
        } else {
            // No workspace, use full paths
            references = filePaths.map(fp => `#file:${fp.replace(/\\/g, '/')}`);
        }

        const clipboardText = references.join(' ');
        await vscode.env.clipboard.writeText(clipboardText);

        const openChatAction = await vscode.window.showInformationMessage(
            `Copied ${filePaths.length} image reference(s) to clipboard! Paste into Copilot Chat to share context.`,
            'Open Copilot Chat'
        );

        if (openChatAction === 'Open Copilot Chat') {
            await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
        }
    }

    private getHtmlContent(
        webview: vscode.Webview,
        pdfJsUri: vscode.Uri,
        pdfWorkerUri: vscode.Uri,
        pdfBase64: string
    ): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob:; style-src 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; worker-src blob:;">
    <title>PDF Viewer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 16px;
            background-color: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-titleBar-border);
            min-height: 40px;
            flex-shrink: 0;
        }

        .toolbar button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 13px;
        }

        .toolbar button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .toolbar button.extract-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            position: relative;
        }

        .toolbar button.extract-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .screenshot-menu {
            position: relative;
            display: inline-block;
        }

        .screenshot-dropdown {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 3px;
            min-width: 180px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 1000;
            margin-top: 4px;
        }

        .screenshot-dropdown.show {
            display: block;
        }

        .screenshot-dropdown button {
            display: block;
            width: 100%;
            text-align: left;
            padding: 8px 12px;
            background: none;
            border: none;
            color: var(--vscode-dropdown-foreground);
            cursor: pointer;
            font-size: 13px;
        }

        .screenshot-dropdown button:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .screenshot-dropdown .divider {
            height: 1px;
            background-color: var(--vscode-dropdown-border);
            margin: 4px 0;
        }

        .toolbar-separator {
            width: 1px;
            height: 24px;
            background-color: var(--vscode-titleBar-border);
            margin: 0 4px;
        }

        .toolbar-info {
            margin-left: auto;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        .page-input {
            width: 50px;
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            text-align: center;
        }

        .zoom-display {
            min-width: 60px;
            max-width: 70px;
            text-align: center;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            padding: 4px 6px;
            font-size: 13px;
        }

        .zoom-display:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .zoom-display::-webkit-inner-spin-button,
        .zoom-display::-webkit-outer-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        #pdf-container {
            flex: 1;
            overflow: auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
            gap: 20px;
            background-color: var(--vscode-editor-background);
        }

        .page-wrapper {
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            background-color: white;
        }

        .page-canvas {
            display: block;
        }

        .loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 16px;
        }

        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--vscode-progressBar-background);
            border-top: 3px solid var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .error {
            color: var(--vscode-errorForeground);
            text-align: center;
            padding: 20px;
        }

        .page-number {
            text-align: center;
            padding: 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="prev-page" title="Previous Page">◀ Prev</button>
        <span>Page</span>
        <input type="number" id="page-input" class="page-input" min="1" value="1">
        <span>of <span id="page-count">-</span></span>
        <button id="next-page" title="Next Page">Next ▶</button>
        <div class="toolbar-separator"></div>
        <button id="zoom-out" title="Zoom Out">−</button>
        <input type="text" id="zoom-display" class="zoom-display" value="100%" title="Zoom level (25% - 500%). Type a value and press Enter.">
        <button id="zoom-in" title="Zoom In">+</button>
        <button id="zoom-fit" title="Fit to Width">Fit Width</button>
        <button id="zoom-reset" title="Reset Zoom">Reset</button>
        <div class="toolbar-separator"></div>
        <div class="screenshot-menu">
            <button id="screenshot-btn" class="extract-btn" title="Take screenshot of PDF pages">📷 Screenshot ▾</button>
            <div id="screenshot-dropdown" class="screenshot-dropdown">
                <button id="screenshot-current" title="Screenshot current page only">📄 Current Page</button>
                <button id="screenshot-all" title="Screenshot all pages">📚 All Pages</button>
                <div class="divider"></div>
                <button id="screenshot-custom" title="Custom screenshot options">⚙️ Custom...</button>
            </div>
        </div>
        <button id="browse-extracted-btn" class="extract-btn" title="Browse previously extracted PDFs">📁 Extracted</button>
        <span class="toolbar-info" id="file-info"></span>
    </div>
    <div id="pdf-container">
        <div class="loading">
            <div class="loading-spinner"></div>
            <span>Loading PDF...</span>
        </div>
    </div>

    <script nonce="${nonce}" type="module">
        import * as pdfjsLib from '${pdfJsUri}';
        
        // Set up the worker
        pdfjsLib.GlobalWorkerOptions.workerSrc = '${pdfWorkerUri}';

        const vscode = acquireVsCodeApi();
        const container = document.getElementById('pdf-container');
        const pageInput = document.getElementById('page-input');
        const pageCountSpan = document.getElementById('page-count');
        const zoomDisplay = document.getElementById('zoom-display');
        const fileInfo = document.getElementById('file-info');

        let pdfDoc = null;
        let currentPage = 1;
        let totalPages = 0;
        let currentScale = 1.0;
        let pageCanvases = [];

        // PDF data embedded as base64
        const pdfBase64 = '${pdfBase64}';

        async function loadPdf() {
            try {
                // Convert base64 to Uint8Array
                const binaryString = atob(pdfBase64);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // Load the PDF
                const loadingTask = pdfjsLib.getDocument({ data: bytes });
                pdfDoc = await loadingTask.promise;
                totalPages = pdfDoc.numPages;
                
                pageCountSpan.textContent = totalPages;
                pageInput.max = totalPages;
                fileInfo.textContent = totalPages + ' page(s)';

                vscode.postMessage({ type: 'pageCount', count: totalPages });
                vscode.postMessage({ type: 'ready' });

                // Render all pages
                await renderAllPages();

            } catch (error) {
                container.innerHTML = '<div class="error">Failed to load PDF: ' + error.message + '</div>';
                vscode.postMessage({ type: 'error', message: error.message });
            }
        }

        async function renderAllPages() {
            container.innerHTML = '';
            pageCanvases = [];

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                const pageWrapper = document.createElement('div');
                pageWrapper.className = 'page-wrapper';
                pageWrapper.id = 'page-' + pageNum;

                const canvas = document.createElement('canvas');
                canvas.className = 'page-canvas';
                pageWrapper.appendChild(canvas);

                const pageNumber = document.createElement('div');
                pageNumber.className = 'page-number';
                pageNumber.textContent = 'Page ' + pageNum + ' of ' + totalPages;
                pageWrapper.appendChild(pageNumber);

                container.appendChild(pageWrapper);
                pageCanvases.push(canvas);

                await renderPage(pageNum, canvas);
            }
        }

        async function renderPage(pageNum, canvas) {
            try {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: currentScale * 1.5 }); // 1.5x for better quality

                canvas.height = viewport.height;
                canvas.width = viewport.width;

                const context = canvas.getContext('2d');
                const renderContext = {
                    canvasContext: context,
                    viewport: viewport
                };

                await page.render(renderContext).promise;
            } catch (error) {
                console.error('Error rendering page ' + pageNum + ':', error);
            }
        }

        async function updateZoom(newScale) {
            // Clamp to valid range: 25% (0.25) to 500% (5.0)
            currentScale = Math.max(0.25, Math.min(5.0, newScale));
            zoomDisplay.value = Math.round(currentScale * 100) + '%';
            await renderAllPages();
        }

        function scrollToPage(pageNum) {
            const pageElement = document.getElementById('page-' + pageNum);
            if (pageElement) {
                pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                currentPage = pageNum;
                pageInput.value = pageNum;
                vscode.postMessage({ type: 'currentPage', page: currentPage });
            }
        }

        async function extractPagesAsImages(pageNumbers, quality, format) {
            const extractedPages = [];

            for (let i = 0; i < pageNumbers.length; i++) {
                const pageNum = pageNumbers[i];

                try {
                    const page = await pdfDoc.getPage(pageNum);
                    const viewport = page.getViewport({ scale: quality * 1.5 });

                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;

                    const context = canvas.getContext('2d');
                    context.fillStyle = 'white';
                    context.fillRect(0, 0, canvas.width, canvas.height);

                    await page.render({
                        canvasContext: context,
                        viewport: viewport
                    }).promise;

                    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
                    const dataUrl = canvas.toDataURL(mimeType, 0.95);

                    extractedPages.push({
                        page: pageNum,
                        data: dataUrl
                    });
                } catch (error) {
                    console.error('Error extracting page ' + pageNum + ':', error);
                }
            }

            vscode.postMessage({
                type: 'extractedPages',
                pages: extractedPages,
                format: format
            });
        }

        // Event listeners
        document.getElementById('prev-page').addEventListener('click', () => {
            if (currentPage > 1) {
                scrollToPage(currentPage - 1);
            }
        });

        document.getElementById('next-page').addEventListener('click', () => {
            if (currentPage < totalPages) {
                scrollToPage(currentPage + 1);
            }
        });

        pageInput.addEventListener('change', () => {
            let page = parseInt(pageInput.value);
            if (page >= 1 && page <= totalPages) {
                scrollToPage(page);
            } else {
                pageInput.value = currentPage;
            }
        });

        document.getElementById('zoom-in').addEventListener('click', () => {
            updateZoom(Math.min(currentScale + 0.25, 5.0));
        });

        document.getElementById('zoom-out').addEventListener('click', () => {
            updateZoom(Math.max(currentScale - 0.25, 0.25));
        });

        // Zoom input - allow user to type custom zoom value
        zoomDisplay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const value = zoomDisplay.value.replace('%', '').trim();
                const numValue = parseInt(value, 10);
                
                if (!isNaN(numValue) && numValue >= 25 && numValue <= 500) {
                    updateZoom(numValue / 100);
                } else {
                    // Invalid value - show warning and reset to current
                    vscode.postMessage({ type: 'error', message: 'Zoom must be between 25% and 500%' });
                    zoomDisplay.value = Math.round(currentScale * 100) + '%';
                }
                zoomDisplay.blur();
            } else if (e.key === 'Escape') {
                // Cancel editing - reset to current value
                zoomDisplay.value = Math.round(currentScale * 100) + '%';
                zoomDisplay.blur();
            }
        });

        // Select all text when focusing the zoom input
        zoomDisplay.addEventListener('focus', () => {
            zoomDisplay.select();
        });

        // Reset to current value if focus is lost without pressing Enter
        zoomDisplay.addEventListener('blur', () => {
            zoomDisplay.value = Math.round(currentScale * 100) + '%';
        });

        document.getElementById('zoom-reset').addEventListener('click', () => {
            updateZoom(1.0);
        });

        document.getElementById('zoom-fit').addEventListener('click', async () => {
            if (pdfDoc) {
                const page = await pdfDoc.getPage(1);
                const viewport = page.getViewport({ scale: 1.0 });
                const containerWidth = container.clientWidth - 60; // Account for padding
                const newScale = containerWidth / viewport.width;
                updateZoom(newScale);
            }
        });

        // Screenshot dropdown menu
        const screenshotBtn = document.getElementById('screenshot-btn');
        const screenshotDropdown = document.getElementById('screenshot-dropdown');

        screenshotBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            screenshotDropdown.classList.toggle('show');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!screenshotBtn.contains(e.target) && !screenshotDropdown.contains(e.target)) {
                screenshotDropdown.classList.remove('show');
            }
        });

        document.getElementById('screenshot-current').addEventListener('click', () => {
            screenshotDropdown.classList.remove('show');
            extractPagesAsImages([currentPage], 2.0, 'png');
        });

        document.getElementById('screenshot-all').addEventListener('click', () => {
            screenshotDropdown.classList.remove('show');
            const allPages = [];
            for (let i = 1; i <= totalPages; i++) {
                allPages.push(i);
            }
            extractPagesAsImages(allPages, 2.0, 'png');
        });

        document.getElementById('screenshot-custom').addEventListener('click', () => {
            screenshotDropdown.classList.remove('show');
            vscode.postMessage({ type: 'openCustomMenu', totalPages: totalPages, currentPage: currentPage });
        });

        // Browse extracted PDFs button
        document.getElementById('browse-extracted-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'browseExtracted' });
        });

        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'zoom':
                    updateZoom(message.scale);
                    break;
                case 'extractPages':
                    extractPagesAsImages(message.pages, message.quality, message.format);
                    break;
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                if (currentPage > 1) scrollToPage(currentPage - 1);
            } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
                if (currentPage < totalPages) scrollToPage(currentPage + 1);
            } else if (e.key === 'Home') {
                scrollToPage(1);
            } else if (e.key === 'End') {
                scrollToPage(totalPages);
            } else if (e.key === '+' || e.key === '=') {
                updateZoom(Math.min(currentScale + 0.25, 5.0));
            } else if (e.key === '-') {
                updateZoom(Math.max(currentScale - 0.25, 0.25));
            }
        });

        // Track current page based on scroll position
        container.addEventListener('scroll', () => {
            const containerRect = container.getBoundingClientRect();
            for (let i = 0; i < pageCanvases.length; i++) {
                const pageElement = document.getElementById('page-' + (i + 1));
                if (pageElement) {
                    const rect = pageElement.getBoundingClientRect();
                    if (rect.top <= containerRect.top + 100 && rect.bottom > containerRect.top) {
                        if (currentPage !== i + 1) {
                            currentPage = i + 1;
                            pageInput.value = currentPage;
                        }
                        break;
                    }
                }
            }
        });

        // Load the PDF when the page loads
        loadPdf();
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
