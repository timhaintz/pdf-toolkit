import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Represents an opened PDF document
 */
class PdfDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;

    constructor(uri: vscode.Uri) {
        this.uri = uri;
    }

    dispose(): void {
        // No resources to free — PDF is loaded directly by the webview via URI
    }
}

/**
 * PDF Editor Provider - Handles rendering PDF files in VS Code
 */
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    public static readonly viewType = 'pdfToolkit.pdfCustomEditor';
    
    /**
     * Get the configured screenshots folder name from settings
     */
    public static getScreenshotsFolderName(): string {
        const config = vscode.workspace.getConfiguration('pdfToolkit');
        return config.get<string>('screenshotsFolder', 'PDF-Screenshots');
    }
    
    /** Per-panel state to support multiple PDFs open simultaneously */
    private _panels: Map<vscode.WebviewPanel, { document: PdfDocument; zoom: number; totalPages: number; currentPage: number }> = new Map();
    private _activePanel: vscode.WebviewPanel | undefined;

    constructor(public readonly context: vscode.ExtensionContext) {}

    /**
     * Get the active panel and its state, or undefined if no panel is focused
     */
    private getActiveState(): { panel: vscode.WebviewPanel; state: { document: PdfDocument; zoom: number; totalPages: number; currentPage: number } } | undefined {
        if (this._activePanel && this._panels.has(this._activePanel)) {
            return { panel: this._activePanel, state: this._panels.get(this._activePanel)! };
        }
        return undefined;
    }

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
    private getScreenshotsDir(document?: PdfDocument): string {
        const folderName = PdfEditorProvider.getScreenshotsFolderName();
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return path.join(workspaceFolders[0].uri.fsPath, folderName);
        }
        // Fallback to PDF's directory if no workspace
        if (document) {
            return path.join(path.dirname(document.uri.fsPath), folderName);
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
        return new PdfDocument(uri);
    }

    /**
     * Called to render the PDF in the webview
     */
    async resolveCustomEditor(
        document: PdfDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Track this panel and its state
        this._panels.set(webviewPanel, {
            document,
            zoom: 1.0,
            totalPages: 0,
            currentPage: 1
        });
        this._activePanel = webviewPanel;

        // Track focus changes to route commands to the correct panel
        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this._activePanel = webviewPanel;
            }
        }, undefined, this.context.subscriptions);

        // Clean up when panel is closed
        webviewPanel.onDidDispose(() => {
            this._panels.delete(webviewPanel);
            if (this._activePanel === webviewPanel) {
                this._activePanel = undefined;
            }
        }, undefined, this.context.subscriptions);

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist'),
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
            ]
        };

        // Get URIs for PDF.js resources
        const pdfJsUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs')
        );
        const pdfWorkerUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')
        );

        // Serve the PDF file directly to the webview via URI — no base64 copy needed
        const pdfUri = webviewPanel.webview.asWebviewUri(document.uri);

        webviewPanel.webview.html = this.getHtmlContent(
            webviewPanel.webview,
            pdfJsUri,
            pdfWorkerUri,
            pdfUri
        );

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                const panelState = this._panels.get(webviewPanel);
                if (!panelState) return;

                switch (message.type) {
                    case 'ready':
                        break;
                    case 'error':
                        vscode.window.showErrorMessage(`PDF Error: ${message.message}`);
                        break;
                    case 'pageCount':
                        panelState.totalPages = message.count;
                        break;
                    case 'currentPage':
                        panelState.currentPage = message.page;
                        break;
                    case 'extractedPages':
                        await this.saveExtractedPages(panelState.document, message.pages, message.format);
                        break;
                    case 'extractedImages':
                        await this.saveExtractedImages(panelState.document, webviewPanel, message.images, message.totalFound);
                        break;
                    case 'screenshotCurrent':
                        this.extractPages('current', undefined, webviewPanel);
                        break;
                    case 'screenshotAll':
                        this.extractPages('all', undefined, webviewPanel);
                        break;
                    case 'status':
                        vscode.window.setStatusBarMessage(message.message, 3000);
                        break;
                    case 'openCustomMenu':
                        vscode.commands.executeCommand('pdfToolkit.openCustomWizard', message.totalPages, message.currentPage);
                        break;
                    case 'browseExtracted':
                        vscode.commands.executeCommand('pdfToolkit.browseExtracted');
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    public zoomIn(): void {
        const active = this.getActiveState();
        if (!active) return;
        active.state.zoom = Math.min(active.state.zoom + 0.25, 5.0);
        this.sendZoomUpdate(active.panel, active.state.zoom);
    }

    public zoomOut(): void {
        const active = this.getActiveState();
        if (!active) return;
        active.state.zoom = Math.max(active.state.zoom - 0.25, 0.25);
        this.sendZoomUpdate(active.panel, active.state.zoom);
    }

    public resetZoom(): void {
        const active = this.getActiveState();
        if (!active) return;
        active.state.zoom = 1.0;
        this.sendZoomUpdate(active.panel, active.state.zoom);
    }

    private sendZoomUpdate(panel: vscode.WebviewPanel, scale: number): void {
        panel.webview.postMessage({
            type: 'zoom',
            scale: scale
        });
    }

    /**
     * Extract pages from the PDF as images
     */
    public async extractPages(mode: 'all' | 'selected' | 'current', pageRange?: string, panel?: vscode.WebviewPanel): Promise<void> {
        const targetPanel = panel || this._activePanel;
        const state = targetPanel ? this._panels.get(targetPanel) : undefined;

        if (!targetPanel || !state) {
            vscode.window.showErrorMessage('No PDF is currently open');
            return;
        }

        const config = vscode.workspace.getConfiguration('pdfToolkit');
        const quality = config.get<number>('extractionQuality', 2.0);
        const format = config.get<string>('extractionFormat', 'png');

        let pages: number[] = [];

        if (mode === 'all') {
            for (let i = 1; i <= state.totalPages; i++) {
                pages.push(i);
            }
        } else if (mode === 'current') {
            pages = [state.currentPage];
        } else if (mode === 'selected' && pageRange) {
            pages = this.parsePageRange(pageRange, state.totalPages);
        }

        if (pages.length === 0) {
            vscode.window.showErrorMessage('No valid pages selected');
            return;
        }

        vscode.window.showInformationMessage(`Extracting ${pages.length} page(s) as ${format.toUpperCase()} images...`);

        targetPanel.webview.postMessage({
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
        const active = this.getActiveState();
        if (!active) {
            vscode.window.showErrorMessage('No PDF is currently open');
            return;
        }

        let pages: number[] = [];

        if (pageRange === 'all') {
            for (let i = 1; i <= active.state.totalPages; i++) {
                pages.push(i);
            }
        } else {
            pages = this.parsePageRange(pageRange, active.state.totalPages);
        }

        if (pages.length === 0) {
            vscode.window.showErrorMessage('No valid pages selected');
            return;
        }

        vscode.window.showInformationMessage(`Extracting ${pages.length} page(s) at ${quality * 72} DPI as ${format.toUpperCase()}...`);

        active.panel.webview.postMessage({
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
    private async saveExtractedPages(document: PdfDocument, pages: { page: number; data: string }[], format: string): Promise<void> {
        const pdfUri = document.uri;
        const pdfName = path.basename(pdfUri.fsPath, '.pdf');
        
        // Use centralized PDF Screenshots folder
        const screenshotsDir = this.getScreenshotsDir(document);
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
            'Add to Copilot Chat',
            'Open First Image'
        );

        if (action === 'Open Folder') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
        } else if (action === 'Add to Copilot Chat') {
            await this.addImagesToCopilotChat(savedFilePaths);
        } else if (action === 'Open First Image' && savedFiles.length > 0) {
            const firstImage = path.join(outputDir, savedFiles[0]);
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(firstImage));
        }
    }

    /**
     * Add image files directly to GitHub Copilot Chat using VS Code's built-in command
     */
    private async addImagesToCopilotChat(filePaths: string[]): Promise<void> {
        // Create URIs for all image files
        const imageUris = filePaths.map(fp => vscode.Uri.file(fp));
        
        // Use VS Code's built-in command to open chat with files attached
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: '',
            attachFiles: imageUris
        });
        vscode.window.showInformationMessage(`Added ${filePaths.length} image(s) to Copilot Chat!`);
    }

    /**
     * Save extracted embedded images (charts, figures, photos) from PDF
     */
    private async saveExtractedImages(document: PdfDocument, panel: vscode.WebviewPanel, images: Array<{ index: number; page: number; width: number; height: number; data: string }>, totalFound: number): Promise<void> {
        if (images.length === 0) {
            const action = await vscode.window.showInformationMessage(
                'No embedded raster images found. Charts and diagrams drawn as vector graphics won\'t appear here — use Screenshot (📷) to capture those pages instead.',
                'Screenshot Current Page'
            );
            if (action === 'Screenshot Current Page') {
                this.extractPages('current', undefined, panel);
            }
            return;
        }

        // Get the screenshots folder name from settings
        const config = vscode.workspace.getConfiguration('pdfToolkit');
        const screenshotsFolderName = config.get<string>('screenshotsFolder', 'PDF-Screenshots');

        // Create output directory
        const pdfName = path.basename(document.uri.fsPath, '.pdf');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(document.uri.fsPath);
        const outputDir = path.join(workspaceFolder, screenshotsFolderName, pdfName);

        // Ensure directory exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

        const savedFiles: string[] = [];
        const skippedFiles: string[] = [];

        for (const img of images) {
            const fileName = `image_${img.index.toString().padStart(3, '0')}_page${img.page}_${img.width}x${img.height}.png`;
            const filePath = path.join(outputDir, fileName);

            // Check if file already exists
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                skippedFiles.push(fileName);
                continue; // Skip existing files
            } catch {
                // File doesn't exist, proceed with saving
            }

            try {
                const base64Data = img.data.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), buffer);
                savedFiles.push(filePath);
            } catch (error) {
                console.error(`Failed to save image ${fileName}:`, error);
            }
        }

        if (savedFiles.length === 0 && skippedFiles.length > 0) {
            const action = await vscode.window.showWarningMessage(
                `All ${skippedFiles.length} image(s) already exist in: ${outputDir}`,
                'Open Folder',
                'Add to Copilot Chat'
            );

            if (action === 'Open Folder') {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
            } else if (action === 'Add to Copilot Chat') {
                const existingPaths = skippedFiles.map(f => path.join(outputDir, f));
                await this.addImagesToCopilotChat(existingPaths);
            }
            return;
        }

        const skippedMsg = skippedFiles.length > 0 ? ` (${skippedFiles.length} already existed)` : '';
        const message = `Extracted ${savedFiles.length} embedded image(s) to: ${outputDir}${skippedMsg}`;
        const action = await vscode.window.showInformationMessage(
            message,
            'Open Folder',
            'Add to Copilot Chat',
            'Open First Image'
        );

        if (action === 'Open Folder') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
        } else if (action === 'Add to Copilot Chat') {
            await this.addImagesToCopilotChat(savedFiles);
        } else if (action === 'Open First Image' && savedFiles.length > 0) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(savedFiles[0]));
        }
    }

    private getHtmlContent(
        webview: vscode.Webview,
        pdfJsUri: vscode.Uri,
        pdfWorkerUri: vscode.Uri,
        pdfUri: vscode.Uri
    ): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob:; style-src 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; connect-src ${webview.cspSource}; worker-src blob:;">
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
            position: relative;
        }

        .page-wrapper.rotated-90 {
            transform: rotate(90deg);
        }

        .page-wrapper.rotated-180 {
            transform: rotate(180deg);
        }

        .page-wrapper.rotated-270 {
            transform: rotate(270deg);
        }

        .page-content {
            position: relative;
        }

        .page-canvas {
            display: block;
        }

        /* Text layer for text selection */
        .textLayer {
            position: absolute;
            left: 0;
            top: 0;
            right: 0;
            bottom: 0;
            overflow: hidden;
            opacity: 0.2;
            line-height: 1.0;
            user-select: text;
        }

        .textLayer > span {
            color: transparent;
            position: absolute;
            white-space: pre;
            cursor: text;
            transform-origin: 0% 0%;
        }

        .textLayer ::selection {
            background: rgba(0, 0, 255, 0.3);
        }

        /* Dark mode styles */
        #pdf-container.dark-mode .page-wrapper {
            filter: invert(1) hue-rotate(180deg);
        }

        /* Search bar styles */
        .search-container {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .search-input {
            width: 150px;
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
        }

        .search-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .search-results {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            min-width: 60px;
        }

        .search-nav {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px 6px;
            font-size: 10px;
            opacity: 0.7;
        }

        .search-nav:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
            border-radius: 3px;
        }

        .search-nav:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }

        /* Search highlight styles */
        .textLayer mark.search-highlight {
            background-color: rgba(255, 255, 0, 0.4);
            border-radius: 2px;
            color: inherit;
        }

        .textLayer mark.search-highlight.current {
            background-color: rgba(255, 165, 0, 0.6);
            outline: 2px solid orange;
        }

        /* Outline panel styles */
        .main-container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .outline-panel {
            width: 250px;
            background-color: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-sideBar-border);
            overflow-y: auto;
            display: none;
            flex-shrink: 0;
        }

        .outline-panel.show {
            display: block;
        }

        .outline-header {
            padding: 10px 12px;
            font-weight: bold;
            font-size: 13px;
            border-bottom: 1px solid var(--vscode-sideBar-border);
            color: var(--vscode-sideBarTitle-foreground);
        }

        .outline-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .outline-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .outline-item.level-1 { padding-left: 12px; }
        .outline-item.level-2 { padding-left: 24px; font-size: 12px; }
        .outline-item.level-3 { padding-left: 36px; font-size: 12px; }
        .outline-item.level-4 { padding-left: 48px; font-size: 11px; }

        .outline-empty {
            padding: 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            font-style: italic;
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
        <button id="rotate-ccw" title="Rotate Counter-Clockwise (Shift+R)">↶</button>
        <button id="rotate-cw" title="Rotate Clockwise (R)">↷</button>
        <button id="dark-mode" title="Toggle Dark Mode (D)">🌙</button>
        <div class="toolbar-separator"></div>
        <button id="toggle-outline" title="Toggle Outline/TOC (O)">📑</button>
        <div class="search-container">
            <input type="text" id="search-input" class="search-input" placeholder="Search... (Ctrl+F)" title="Search in PDF">
            <span id="search-results" class="search-results"></span>
            <button id="search-prev" class="search-nav" title="Previous match (Shift+Enter)">▲</button>
            <button id="search-next" class="search-nav" title="Next match (Enter)">▼</button>
            <button id="search-close" class="search-nav" title="Close search (Escape)">✕</button>
        </div>
        <div class="toolbar-separator"></div>
        <div class="screenshot-menu">
            <button id="screenshot-btn" class="extract-btn" title="Take screenshot of PDF pages">📷 Screenshot ▾</button>
            <div id="screenshot-dropdown" class="screenshot-dropdown">
                <button id="screenshot-current" title="Screenshot current page only">📄 Current Page</button>
                <button id="screenshot-all" title="Screenshot all pages">📚 All Pages</button>
                <div class="divider"></div>
                <button id="screenshot-custom" title="Custom screenshot options">⚙️ Custom...</button>
                <div class="divider"></div>
                <button id="extract-images" title="Extract embedded raster images (photos, bitmaps) at native resolution. For vector charts/diagrams, use Screenshot instead.">🖼️ Extract Images</button>
            </div>
        </div>
        <button id="browse-extracted-btn" class="extract-btn" title="Browse previously extracted PDFs">📁 Extracted</button>
        <span class="toolbar-info" id="file-info"></span>
    </div>
    <div class="main-container">
        <div id="outline-panel" class="outline-panel">
            <div class="outline-header">📑 Outline</div>
            <div id="outline-content"></div>
        </div>
        <div id="pdf-container">
            <div class="loading">
                <div class="loading-spinner"></div>
                <span>Loading PDF...</span>
            </div>
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
        let currentRotation = 0; // 0, 90, 180, 270 degrees
        let isDarkMode = false;

        // Search state
        let searchMatches = [];  // Array of { pageNum, textContent, positions }
        let currentMatchIndex = -1;
        let pageTextContents = []; // Cache text content for each page

        // Outline state
        let outlineItems = [];

        // PDF served directly via webview URI — no base64 copy in memory
        const pdfUrl = '${pdfUri}';

        async function loadPdf() {
            try {
                // Load the PDF directly from webview URI
                const loadingTask = pdfjsLib.getDocument(pdfUrl);
                pdfDoc = await loadingTask.promise;
                totalPages = pdfDoc.numPages;
                
                pageCountSpan.textContent = totalPages;
                pageInput.max = totalPages;
                fileInfo.textContent = totalPages + ' page(s)';

                vscode.postMessage({ type: 'pageCount', count: totalPages });
                vscode.postMessage({ type: 'ready' });

                // Load outline/TOC
                await loadOutline();

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
                applyRotation(pageWrapper);

                // Container for canvas and text layer
                const pageContent = document.createElement('div');
                pageContent.className = 'page-content';

                const canvas = document.createElement('canvas');
                canvas.className = 'page-canvas';
                pageContent.appendChild(canvas);

                // Text layer for text selection
                const textLayer = document.createElement('div');
                textLayer.className = 'textLayer';
                textLayer.id = 'text-layer-' + pageNum;
                pageContent.appendChild(textLayer);

                pageWrapper.appendChild(pageContent);

                const pageNumber = document.createElement('div');
                pageNumber.className = 'page-number';
                pageNumber.textContent = 'Page ' + pageNum + ' of ' + totalPages;
                pageWrapper.appendChild(pageNumber);

                container.appendChild(pageWrapper);
                pageCanvases.push(canvas);

                await renderPage(pageNum, canvas, textLayer);
            }
        }

        async function renderPage(pageNum, canvas, textLayer) {
            try {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: currentScale * 1.5 }); // 1.5x for better quality

                canvas.height = viewport.height;
                canvas.width = viewport.width;

                // Set up the page content container size
                const pageContent = canvas.parentElement;
                pageContent.style.width = viewport.width + 'px';
                pageContent.style.height = viewport.height + 'px';

                const context = canvas.getContext('2d');
                const renderContext = {
                    canvasContext: context,
                    viewport: viewport
                };

                await page.render(renderContext).promise;

                // Render text layer for text selection
                if (textLayer) {
                    textLayer.innerHTML = '';
                    textLayer.style.width = viewport.width + 'px';
                    textLayer.style.height = viewport.height + 'px';

                    const textContent = await page.getTextContent();
                    
                    // Render each text item
                    textContent.items.forEach(item => {
                        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                        const span = document.createElement('span');
                        span.textContent = item.str;
                        span.style.left = tx[4] + 'px';
                        span.style.top = (viewport.height - tx[5]) + 'px';
                        span.style.fontSize = Math.abs(tx[0]) + 'px';
                        span.style.fontFamily = item.fontName || 'sans-serif';
                        textLayer.appendChild(span);
                    });
                }
            } catch (error) {
                console.error('Error rendering page ' + pageNum + ':', error);
            }
        }

        // Rotation functions
        function applyRotation(pageWrapper) {
            pageWrapper.classList.remove('rotated-90', 'rotated-180', 'rotated-270');
            if (currentRotation === 90) {
                pageWrapper.classList.add('rotated-90');
            } else if (currentRotation === 180) {
                pageWrapper.classList.add('rotated-180');
            } else if (currentRotation === 270) {
                pageWrapper.classList.add('rotated-270');
            }
        }

        function rotatePages(clockwise) {
            if (clockwise) {
                currentRotation = (currentRotation + 90) % 360;
            } else {
                currentRotation = (currentRotation - 90 + 360) % 360;
            }
            
            // Apply rotation to all page wrappers
            document.querySelectorAll('.page-wrapper').forEach(wrapper => {
                applyRotation(wrapper);
            });
        }

        // Dark mode function
        function toggleDarkMode() {
            isDarkMode = !isDarkMode;
            if (isDarkMode) {
                container.classList.add('dark-mode');
                document.getElementById('dark-mode').textContent = '☀️';
                document.getElementById('dark-mode').title = 'Toggle Light Mode (D)';
            } else {
                container.classList.remove('dark-mode');
                document.getElementById('dark-mode').textContent = '🌙';
                document.getElementById('dark-mode').title = 'Toggle Dark Mode (D)';
            }
        }

        // Search functions
        async function performSearch(query) {
            if (!query || query.length < 2) {
                clearSearchHighlights();
                searchMatches = [];
                currentMatchIndex = -1;
                updateSearchResults();
                return;
            }

            searchMatches = [];
            currentMatchIndex = -1;
            clearSearchHighlights();

            const lowerQuery = query.toLowerCase();

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                const page = await pdfDoc.getPage(pageNum);
                const textContent = await page.getTextContent();
                
                textContent.items.forEach((item, itemIndex) => {
                    const text = item.str.toLowerCase();
                    let pos = 0;
                    while ((pos = text.indexOf(lowerQuery, pos)) !== -1) {
                        searchMatches.push({
                            pageNum: pageNum,
                            itemIndex: itemIndex,
                            position: pos,
                            length: query.length
                        });
                        pos += 1;
                    }
                });
            }

            if (searchMatches.length > 0) {
                currentMatchIndex = 0;
                highlightMatches();
                goToCurrentMatch();
            }

            updateSearchResults();
        }

        function highlightMatches() {
            // Group matches by page and item so we can insert multiple <mark> elements per span
            const bySpan = new Map(); // key: 'page-item' -> sorted array of {position, length, globalIndex}
            searchMatches.forEach((match, globalIndex) => {
                const key = match.pageNum + '-' + match.itemIndex;
                if (!bySpan.has(key)) {
                    bySpan.set(key, { pageNum: match.pageNum, itemIndex: match.itemIndex, hits: [] });
                }
                bySpan.get(key).hits.push({ position: match.position, length: match.length, globalIndex: globalIndex });
            });

            bySpan.forEach((group) => {
                const textLayer = document.getElementById('text-layer-' + group.pageNum);
                if (!textLayer) return;
                const span = textLayer.children[group.itemIndex];
                if (!span) return;

                // Store original text for later restoration
                if (!span.dataset.originalText) {
                    span.dataset.originalText = span.textContent;
                }
                const originalText = span.dataset.originalText;

                // Sort hits by position descending isn't needed; build from left to right
                const hits = group.hits.sort((a, b) => a.position - b.position);
                let html = '';
                let cursor = 0;
                for (const hit of hits) {
                    // Escape and add text before this match
                    html += escapeHtml(originalText.substring(cursor, hit.position));
                    const matchedText = originalText.substring(hit.position, hit.position + hit.length);
                    const currentClass = hit.globalIndex === currentMatchIndex ? ' current' : '';
                    html += '<mark class="search-highlight' + currentClass + '" data-match-index="' + hit.globalIndex + '">' + escapeHtml(matchedText) + '</mark>';
                    cursor = hit.position + hit.length;
                }
                html += escapeHtml(originalText.substring(cursor));
                span.innerHTML = html;
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function clearSearchHighlights() {
            // Restore original text content for all spans that were modified
            document.querySelectorAll('.textLayer span[data-original-text]').forEach(span => {
                span.textContent = span.dataset.originalText;
                delete span.dataset.originalText;
            });
        }

        function goToCurrentMatch() {
            if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length) return;
            
            const match = searchMatches[currentMatchIndex];
            
            // Remove 'current' class from all marks, add to current
            document.querySelectorAll('mark.search-highlight.current').forEach(el => {
                el.classList.remove('current');
            });
            
            const mark = document.querySelector('mark[data-match-index="' + currentMatchIndex + '"]');
            if (mark) {
                mark.classList.add('current');
                mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            
            // Update page indicator
            currentPage = match.pageNum;
            pageInput.value = currentPage;
        }

        function nextMatch() {
            if (searchMatches.length === 0) return;
            currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
            goToCurrentMatch();
            updateSearchResults();
        }

        function prevMatch() {
            if (searchMatches.length === 0) return;
            currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
            goToCurrentMatch();
            updateSearchResults();
        }

        function updateSearchResults() {
            const resultsSpan = document.getElementById('search-results');
            if (searchMatches.length === 0) {
                resultsSpan.textContent = '';
            } else {
                resultsSpan.textContent = (currentMatchIndex + 1) + ' of ' + searchMatches.length;
            }
        }

        function clearSearch() {
            document.getElementById('search-input').value = '';
            clearSearchHighlights();
            searchMatches = [];
            currentMatchIndex = -1;
            updateSearchResults();
        }

        // Outline functions
        async function loadOutline() {
            const outlineContent = document.getElementById('outline-content');
            
            try {
                const outline = await pdfDoc.getOutline();
                
                if (!outline || outline.length === 0) {
                    outlineContent.innerHTML = '<div class="outline-empty">No outline available for this PDF.</div>';
                    return;
                }

                outlineItems = outline;
                await renderOutline(outline, outlineContent, 1);
            } catch (error) {
                outlineContent.innerHTML = '<div class="outline-empty">Could not load outline.</div>';
            }
        }

        async function renderOutline(items, container, level) {
            for (const item of items) {
                const div = document.createElement('div');
                div.className = 'outline-item level-' + Math.min(level, 4);
                div.textContent = item.title;
                div.title = item.title;
                
                // Get destination page number
                if (item.dest) {
                    try {
                        let destRef = item.dest;
                        if (typeof destRef === 'string') {
                            destRef = await pdfDoc.getDestination(destRef);
                        }
                        if (destRef && destRef[0]) {
                            const pageIndex = await pdfDoc.getPageIndex(destRef[0]);
                            div.dataset.page = pageIndex + 1;
                        }
                    } catch (e) {
                        // Destination parsing failed, skip
                    }
                }
                
                div.addEventListener('click', () => {
                    const pageNum = parseInt(div.dataset.page);
                    if (pageNum && pageNum >= 1 && pageNum <= totalPages) {
                        scrollToPage(pageNum);
                    }
                });
                
                container.appendChild(div);
                
                // Recursively render children
                if (item.items && item.items.length > 0) {
                    await renderOutline(item.items, container, level + 1);
                }
            }
        }

        function toggleOutline() {
            const panel = document.getElementById('outline-panel');
            panel.classList.toggle('show');
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

                if (pageNumbers.length > 1) {
                    vscode.postMessage({ type: 'status', message: 'Extracting page ' + (i + 1) + ' of ' + pageNumbers.length + '...' });
                }

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

        // Extract embedded images from PDF (charts, figures, photos)
        async function extractEmbeddedImages() {
            const extractedImages = [];
            let imageIndex = 0;

            vscode.postMessage({ type: 'status', message: 'Scanning PDF for embedded images...' });

            // PDF.js OPS constants
            const OPS_paintJpegXObject = 82;
            const OPS_paintImageXObject = 85;
            const OPS_paintInlineImageXObject = 86;
            const OPS_paintImageXObjectRepeat = 88;

            // Helper: convert any image source to a PNG data URL via canvas
            function imageToDataUrl(source, width, height) {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(source, 0, 0);
                return canvas.toDataURL('image/png');
            }

            // Helper: convert raw pixel data to a PNG data URL
            function rawDataToDataUrl(data, width, height) {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                const imageData = ctx.createImageData(width, height);

                const pixelCount = width * height;
                const dataLength = data.length;

                if (dataLength === pixelCount * 4) {
                    // RGBA data
                    imageData.data.set(data);
                } else if (dataLength === pixelCount * 3) {
                    // RGB data - add alpha channel
                    for (let j = 0, k = 0; j < dataLength; j += 3, k += 4) {
                        imageData.data[k]     = data[j];
                        imageData.data[k + 1] = data[j + 1];
                        imageData.data[k + 2] = data[j + 2];
                        imageData.data[k + 3] = 255;
                    }
                } else {
                    // Grayscale or other format
                    const bytesPerPixel = dataLength / pixelCount;
                    for (let j = 0; j < pixelCount; j++) {
                        const gray = data[Math.floor(j * bytesPerPixel)];
                        imageData.data[j * 4]     = gray;
                        imageData.data[j * 4 + 1] = gray;
                        imageData.data[j * 4 + 2] = gray;
                        imageData.data[j * 4 + 3] = 255;
                    }
                }

                ctx.putImageData(imageData, 0, 0);
                return canvas.toDataURL('image/png');
            }

            // Helper: extract data URL from an imgData object (handles v5 ImageBitmap, raw data, and src)
            function resolveImageData(imgData) {
                if (!imgData) return null;

                let width  = imgData.width  || 0;
                let height = imgData.height || 0;

                // PDF.js v5: ImageBitmap returned directly
                if (typeof ImageBitmap !== 'undefined' && imgData instanceof ImageBitmap) {
                    width = imgData.width;
                    height = imgData.height;
                    return { dataUrl: imageToDataUrl(imgData, width, height), width, height };
                }

                // PDF.js v5: object with a .bitmap property (ImageBitmap)
                if (imgData.bitmap && typeof ImageBitmap !== 'undefined' && imgData.bitmap instanceof ImageBitmap) {
                    width  = imgData.bitmap.width  || width;
                    height = imgData.bitmap.height || height;
                    return { dataUrl: imageToDataUrl(imgData.bitmap, width, height), width, height };
                }

                // Legacy: already a data URL (JPEG)
                if (imgData.src) {
                    return { dataUrl: imgData.src, width, height };
                }

                // Legacy: raw pixel data
                if (imgData.data && width && height) {
                    return { dataUrl: rawDataToDataUrl(imgData.data, width, height), width, height };
                }

                return null;
            }

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                try {
                    const page = await pdfDoc.getPage(pageNum);

                    // Render page off-screen so PDF.js populates page.objs with image data.
                    // Without this, objs may have been cleaned up since the initial render.
                    const viewport = page.getViewport({ scale: 1.0 });
                    const tmpCanvas = document.createElement('canvas');
                    tmpCanvas.width  = viewport.width;
                    tmpCanvas.height = viewport.height;
                    const tmpCtx = tmpCanvas.getContext('2d');
                    await page.render({ canvasContext: tmpCtx, viewport: viewport }).promise;

                    const operatorList = await page.getOperatorList();

                    // Track already-processed XObject names to avoid duplicates on the same page
                    const processedNames = new Set();

                    for (let i = 0; i < operatorList.fnArray.length; i++) {
                        const fn = operatorList.fnArray[i];

                        // --- XObject images (referenced by name in page.objs) ---
                        if (fn === OPS_paintImageXObject || fn === OPS_paintJpegXObject || fn === OPS_paintImageXObjectRepeat) {
                            const imgName = operatorList.argsArray[i][0];
                            if (processedNames.has(imgName)) continue;
                            processedNames.add(imgName);

                            try {
                                let imgData = null;

                                // Try synchronous get first (object already resolved after render)
                                try {
                                    imgData = page.objs.get(imgName);
                                } catch {
                                    // Fall back to callback-based get with timeout
                                    imgData = await new Promise((resolve, reject) => {
                                        const timer = setTimeout(() => reject(new Error('Timeout waiting for image ' + imgName)), 8000);
                                        page.objs.get(imgName, (data) => {
                                            clearTimeout(timer);
                                            if (data) { resolve(data); }
                                            else { reject(new Error('No data for ' + imgName)); }
                                        });
                                    });
                                }

                                const result = resolveImageData(imgData);
                                if (result && result.width > 10 && result.height > 10) {
                                    imageIndex++;
                                    extractedImages.push({
                                        index: imageIndex,
                                        page: pageNum,
                                        width: result.width,
                                        height: result.height,
                                        data: result.dataUrl
                                    });
                                }
                            } catch (imgError) {
                                console.warn('[PDF Toolkit] Failed to extract XObject image "' + imgName + '" on page ' + pageNum + ':', imgError);
                            }
                        }

                        // --- Inline images (data embedded directly in the operator list) ---
                        else if (fn === OPS_paintInlineImageXObject) {
                            try {
                                const imgData = operatorList.argsArray[i][0];
                                if (!imgData) continue;

                                const result = resolveImageData(imgData);
                                if (result && result.width > 10 && result.height > 10) {
                                    imageIndex++;
                                    extractedImages.push({
                                        index: imageIndex,
                                        page: pageNum,
                                        width: result.width,
                                        height: result.height,
                                        data: result.dataUrl
                                    });
                                }
                            } catch (imgError) {
                                console.warn('[PDF Toolkit] Failed to extract inline image on page ' + pageNum + ':', imgError);
                            }
                        }
                    }

                    // Free temporary canvas memory
                    tmpCanvas.width = 0;
                    tmpCanvas.height = 0;
                } catch (pageError) {
                    console.error('[PDF Toolkit] Error scanning page ' + pageNum + ':', pageError);
                }

                // Update progress
                if (totalPages > 3) {
                    vscode.postMessage({ type: 'status', message: 'Scanning page ' + pageNum + ' of ' + totalPages + '...' });
                }
            }

            vscode.postMessage({
                type: 'extractedImages',
                images: extractedImages,
                totalFound: extractedImages.length
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

        // Rotation event listeners
        document.getElementById('rotate-cw').addEventListener('click', () => {
            rotatePages(true);
        });

        document.getElementById('rotate-ccw').addEventListener('click', () => {
            rotatePages(false);
        });

        // Dark mode event listener
        document.getElementById('dark-mode').addEventListener('click', () => {
            toggleDarkMode();
        });

        // Outline toggle event listener
        document.getElementById('toggle-outline').addEventListener('click', () => {
            toggleOutline();
        });

        // Search event listeners
        const searchInput = document.getElementById('search-input');
        let searchTimeout;

        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                performSearch(searchInput.value);
            }, 300); // Debounce search
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                    prevMatch();
                } else {
                    nextMatch();
                }
            } else if (e.key === 'Escape') {
                clearSearch();
                searchInput.blur();
            }
        });

        document.getElementById('search-next').addEventListener('click', nextMatch);
        document.getElementById('search-prev').addEventListener('click', prevMatch);
        document.getElementById('search-close').addEventListener('click', clearSearch);

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
            vscode.postMessage({ type: 'screenshotCurrent' });
        });

        document.getElementById('screenshot-all').addEventListener('click', () => {
            screenshotDropdown.classList.remove('show');
            vscode.postMessage({ type: 'screenshotAll' });
        });

        document.getElementById('screenshot-custom').addEventListener('click', () => {
            screenshotDropdown.classList.remove('show');
            vscode.postMessage({ type: 'openCustomMenu', totalPages: totalPages, currentPage: currentPage });
        });

        document.getElementById('extract-images').addEventListener('click', () => {
            screenshotDropdown.classList.remove('show');
            extractEmbeddedImages();
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
            // Ctrl+F to focus search - always works
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                document.getElementById('search-input').focus();
                return;
            }

            // Skip other shortcuts if user is typing in an input
            if (e.target.tagName === 'INPUT') return;

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
            } else if (e.key === 'r' || e.key === 'R') {
                // R = rotate clockwise, Shift+R = rotate counter-clockwise
                rotatePages(!e.shiftKey);
            } else if (e.key === 'd' || e.key === 'D') {
                toggleDarkMode();
            } else if (e.key === 'o' || e.key === 'O') {
                toggleOutline();
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
