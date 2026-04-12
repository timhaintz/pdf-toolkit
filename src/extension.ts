import * as vscode from 'vscode';
import * as path from 'path';
import { PdfEditorProvider } from './pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {

    // Register the custom editor provider for PDF files
    const pdfEditorProvider = new PdfEditorProvider(context);
    
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            PdfEditorProvider.viewType,
            pdfEditorProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: true,
            }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.openPdf', async () => {
            const uri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'PDF Files': ['pdf']
                }
            });
            if (uri && uri[0]) {
                await vscode.commands.executeCommand('vscode.openWith', uri[0], PdfEditorProvider.viewType);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.zoomIn', () => {
            pdfEditorProvider.zoomIn();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.zoomOut', () => {
            pdfEditorProvider.zoomOut();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.resetZoom', () => {
            pdfEditorProvider.resetZoom();
        })
    );

    // Screenshot menu command
    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.screenshotMenu', async () => {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '$(file) Current Page', description: 'Export the currently viewed page', value: 'current' },
                    { label: '$(files) All Pages', description: 'Export all pages as images', value: 'all' },
                    { label: '$(settings-gear) Custom...', description: 'Choose pages, resolution, and format', value: 'custom' }
                ],
                {
                    title: '📷 Take Screenshot',
                    placeHolder: 'Select screenshot option'
                }
            );

            if (!choice) return;

            if (choice.value === 'current') {
                pdfEditorProvider.extractPages('current');
            } else if (choice.value === 'all') {
                pdfEditorProvider.extractPages('all');
            } else if (choice.value === 'custom') {
                // Multi-step wizard for custom extraction
                await runCustomExtractionWizard(pdfEditorProvider);
            }
        })
    );

    // Individual commands for command palette access
    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.extractCurrentPage', () => {
            pdfEditorProvider.extractPages('current');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.extractAllPages', () => {
            pdfEditorProvider.extractPages('all');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.extractCustom', async () => {
            await runCustomExtractionWizard(pdfEditorProvider);
        })
    );

    // Command triggered from webview Custom menu option
    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.openCustomWizard', async (totalPages: number, currentPage: number) => {
            await runCustomExtractionWizard(pdfEditorProvider, totalPages, currentPage);
        })
    );

    // Browse extracted PDFs command
    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.browseExtracted', async () => {
            await browseExtractedPdfs(pdfEditorProvider);
        })
    );

    // Programmatic command to attach extracted PDF images to Copilot Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('pdfToolkit.attachExtractedToCopilot', async (args?: {
            pdf?: string;
            folder?: string;
            pages?: string;
            files?: string[];
        }) => {
            await attachExtractedToCopilot(pdfEditorProvider, args);
        })
    );
}

/**
 * Browse previously extracted PDFs
 */
async function browseExtractedPdfs(pdfEditorProvider: PdfEditorProvider): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showInformationMessage('No workspace folder open. Open a folder first.');
        return;
    }

    const folderName = PdfEditorProvider.getScreenshotsFolderName();
    const screenshotsDir = path.join(
        workspaceFolders[0].uri.fsPath, 
        folderName
    );

    // Scan the PDF-Screenshots folder to discover all extracted PDFs
    const discovered = await scanScreenshotsFolder(screenshotsDir);

    if (discovered.length === 0) {
        vscode.window.showInformationMessage('No screenshots found. Use the Screenshot button to extract pages from a PDF.');
        return;
    }

    // Update workspace state with discovered folders
    await pdfEditorProvider.context.workspaceState.update('extractedPdfs', discovered);

    interface ExtractedPdfItem extends vscode.QuickPickItem {
        pdfData?: { name: string; path: string; pageCount: number; extractedAt: string };
        action?: string;
    }

    const items: ExtractedPdfItem[] = discovered.map(pdf => ({
        label: `$(file-media) ${pdf.name}`,
        description: `${pdf.pageCount} page(s)`,
        detail: `Last modified: ${new Date(pdf.extractedAt).toLocaleDateString()}`,
        pdfData: pdf
    }));

    // Add actions at the bottom
    items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(sync) Refresh List', action: 'refresh' },
        { label: `$(folder) Open Folder: ${folderName}`, action: 'openFolder' },
        { label: '$(gear) Change Folder Name...', action: 'changeFolder' }
    );

    const selected = await vscode.window.showQuickPick(items, {
        title: `📁 Extracted PDFs (${folderName})`,
        placeHolder: 'Select a PDF to view options'
    });

    if (!selected) return;

    if (selected.action === 'refresh') {
        // Re-run the function to refresh
        await browseExtractedPdfs(pdfEditorProvider);
        return;
    }

    if (selected.action === 'openFolder') {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(screenshotsDir));
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(screenshotsDir));
        } catch {
            vscode.window.showInformationMessage(`The ${folderName} folder does not exist. Extract some PDF pages first.`);
        }
        return;
    }

    if (selected.action === 'changeFolder') {
        const newFolderName = await vscode.window.showInputBox({
            prompt: 'Enter the new folder name for PDF screenshots',
            value: folderName,
            placeHolder: 'e.g., PDF-Screenshots, Screenshots, PDFImages',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Folder name cannot be empty';
                }
                // Check for invalid characters
                if (/[<>:"|?*\\\/]/.test(value)) {
                    return 'Folder name contains invalid characters';
                }
                return undefined;
            }
        });

        if (newFolderName && newFolderName !== folderName) {
            const config = vscode.workspace.getConfiguration('pdfToolkit');
            await config.update('screenshotsFolder', newFolderName, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Screenshots folder changed to "${newFolderName}". Use Refresh to scan the new folder.`);
            // Refresh the list with new folder
            await browseExtractedPdfs(pdfEditorProvider);
        }
        return;
    }

    if (selected.pdfData) {
        await showPdfActions(pdfEditorProvider, selected.pdfData);
    }
}

/**
 * Scan the PDF-Screenshots folder to discover all extracted PDFs
 */
async function scanScreenshotsFolder(screenshotsDir: string): Promise<{ name: string; path: string; pageCount: number; extractedAt: string }[]> {
    const discovered: { name: string; path: string; pageCount: number; extractedAt: string }[] = [];
    
    try {
        const dirUri = vscode.Uri.file(screenshotsDir);
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        
        for (const [name, type] of entries) {
            if (type === vscode.FileType.Directory) {
                const folderPath = path.join(screenshotsDir, name);
                
                // Count PNG/JPEG files in the folder
                try {
                    const folderUri = vscode.Uri.file(folderPath);
                    const files = await vscode.workspace.fs.readDirectory(folderUri);
                    const imageFiles = files.filter(([fileName]) => 
                        fileName.endsWith('.png') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
                    );
                    
                    if (imageFiles.length > 0) {
                        // Get folder modification time
                        const stat = await vscode.workspace.fs.stat(folderUri);
                        
                        discovered.push({
                            name: name,
                            path: folderPath,
                            pageCount: imageFiles.length,
                            extractedAt: new Date(stat.mtime).toISOString()
                        });
                    }
                } catch {
                    // Skip folders we can't read
                }
            }
        }
    } catch {
        // Screenshots folder doesn't exist yet
    }
    
    // Sort by most recently modified first
    discovered.sort((a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime());
    
    return discovered;
}

/**
 * Show actions for a specific extracted PDF
 */
async function showPdfActions(
    pdfEditorProvider: PdfEditorProvider,
    pdf: { name: string; path: string; pageCount: number; extractedAt: string }
): Promise<void> {
    const fs = vscode.workspace.fs;

    // Get list of images in the folder
    let imageFiles: string[] = [];
    try {
        const files = await fs.readDirectory(vscode.Uri.file(pdf.path));
        imageFiles = files
            .filter(([name, type]) => type === vscode.FileType.File && /\.(png|jpe?g)$/i.test(name))
            .map(([name]) => name)
            .sort();
    } catch {
        // Folder might not exist anymore
    }

    interface PdfActionItem extends vscode.QuickPickItem {
        action?: string;
    }

    const actions: PdfActionItem[] = [
        { label: '$(comment-discussion) Add to Copilot Chat', description: `Attach all ${imageFiles.length} images to GitHub Copilot`, action: 'attachToCopilot' },
        { label: '$(folder-opened) Open Folder', description: 'Reveal folder in file explorer', action: 'folder' },
        { label: '$(file-media) View First Image', description: 'Open the first page image', action: 'viewFirst' },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(trash) Remove from List', description: 'Remove from history (keeps files)', action: 'remove' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
        title: `📄 ${pdf.name} (${imageFiles.length} images)`,
        placeHolder: 'Select an action'
    });

    if (!selected) return;

    switch (selected.action) {
        case 'attachToCopilot':
            if (imageFiles.length === 0) {
                vscode.window.showWarningMessage('No images found in this folder.');
                return;
            }
            // Create URIs for all image files
            const imageUris = imageFiles.map(f => vscode.Uri.file(path.join(pdf.path, f)));
            
            // Use VS Code's built-in command to open chat with files attached
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: '',
                attachFiles: imageUris
            });
            vscode.window.showInformationMessage(`Added ${imageFiles.length} image(s) to Copilot Chat!`);
            break;

        case 'folder':
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pdf.path));
            break;

        case 'viewFirst':
            if (imageFiles.length > 0) {
                const firstImage = path.join(pdf.path, imageFiles[0]);
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(firstImage));
            } else {
                vscode.window.showWarningMessage('No images found in this folder.');
            }
            break;

        case 'remove':
            await pdfEditorProvider.removeExtractedPdf(pdf.name);
            vscode.window.showInformationMessage(`Removed "${pdf.name}" from history.`);
            break;
    }
}

/**
 * Multi-step wizard for custom screenshot extraction
 */
async function runCustomExtractionWizard(pdfEditorProvider: PdfEditorProvider, totalPages?: number, currentPage?: number): Promise<void> {
    // Step 1: Select pages
    const placeholder = totalPages 
        ? `e.g., 1,3,5-${totalPages} or "all" for all ${totalPages} pages${currentPage ? ` (current: ${currentPage})` : ''}`
        : 'e.g., 1,3,5-10 or "all" for all pages';
    
    const pageRange = await vscode.window.showInputBox({
        title: 'Step 1/3: Select Pages',
        prompt: 'Enter page numbers or ranges',
        placeHolder: placeholder,
        validateInput: (value) => {
            if (value.toLowerCase() === 'all') return null;
            if (!/^[\d,\s\-]+$/.test(value)) {
                return 'Enter valid page numbers/ranges (e.g., "1,3,5-10") or "all"';
            }
            return null;
        }
    });

    if (!pageRange) return;

    // Step 2: Select resolution
    const resolution = await vscode.window.showQuickPick(
        [
            { label: 'Standard (72 DPI)', description: 'Smaller file size, suitable for screen viewing', value: 1.0 },
            { label: 'High (144 DPI)', description: 'Good balance of quality and size', value: 2.0 },
            { label: 'Very High (216 DPI)', description: 'Best quality, larger files', value: 3.0 },
            { label: 'Maximum (288 DPI)', description: 'Highest quality, very large files', value: 4.0 }
        ],
        {
            title: 'Step 2/3: Select Resolution',
            placeHolder: 'Choose image quality'
        }
    );

    if (!resolution) return;

    // Step 3: Select format
    const format = await vscode.window.showQuickPick(
        [
            { label: 'PNG', description: 'Lossless compression, best for text and diagrams', value: 'png' },
            { label: 'JPEG', description: 'Smaller files, good for photos', value: 'jpeg' }
        ],
        {
            title: 'Step 3/3: Select Format',
            placeHolder: 'Choose image format'
        }
    );

    if (!format) return;

    // Execute extraction with custom settings
    pdfEditorProvider.extractPagesCustom(
        pageRange.toLowerCase() === 'all' ? 'all' : pageRange,
        resolution.value,
        format.value
    );
}

/**
 * Programmatically attach extracted PDF images to Copilot Chat.
 * 
 * Accepts args:
 * - pdf: name of a previously extracted PDF (matches subfolder name)
 * - folder: explicit absolute path to a folder of images
 * - pages: page range string like "1,3,5-8" to filter images
 * - files: explicit list of filenames to attach
 */
async function attachExtractedToCopilot(
    pdfEditorProvider: PdfEditorProvider,
    args?: {
        pdf?: string;
        folder?: string;
        pages?: string;
        files?: string[];
    }
): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    // If no args provided, show interactive picker
    if (!args || (!args.pdf && !args.folder)) {
        const folderName = PdfEditorProvider.getScreenshotsFolderName();
        const screenshotsDir = path.join(workspaceFolders[0].uri.fsPath, folderName);
        const discovered = await scanScreenshotsFolder(screenshotsDir);

        if (discovered.length === 0) {
            vscode.window.showInformationMessage('No extracted PDFs found. Use the Screenshot button to extract pages from a PDF first.');
            return;
        }

        const pdfPick = await vscode.window.showQuickPick(
            discovered.map(pdf => ({
                label: pdf.name,
                description: `${pdf.pageCount} page(s)`,
                pdf
            })),
            { title: '📎 Attach to Copilot Chat', placeHolder: 'Select an extracted PDF' }
        );
        if (!pdfPick) { return; }

        // Ask for optional page selection
        const pageRange = await vscode.window.showInputBox({
            title: 'Select Pages (optional)',
            prompt: `Enter page numbers/ranges to attach, or leave empty for all ${pdfPick.pdf.pageCount} page(s)`,
            placeHolder: 'e.g., 1,3,5-8 or leave empty for all'
        });
        if (pageRange === undefined) { return; } // cancelled

        args = {
            pdf: pdfPick.pdf.name,
            pages: pageRange || undefined
        };
    }

    let targetFolder: string;

    if (args.folder) {
        targetFolder = args.folder;
    } else {
        // Resolve from the screenshots directory using the pdf name
        const folderName = PdfEditorProvider.getScreenshotsFolderName();
        targetFolder = path.join(workspaceFolders[0].uri.fsPath, folderName, args.pdf!);
    }

    // Verify the folder exists
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(targetFolder));
    } catch {
        vscode.window.showErrorMessage(`Folder not found: ${targetFolder}`);
        return;
    }

    // Read image files from the folder
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(targetFolder));
    } catch {
        vscode.window.showErrorMessage(`Cannot read folder: ${targetFolder}`);
        return;
    }

    let imageFiles = entries
        .filter(([name, type]) => type === vscode.FileType.File && /\.(png|jpe?g)$/i.test(name))
        .map(([name]) => name)
        .sort();

    if (imageFiles.length === 0) {
        vscode.window.showWarningMessage('No image files found in the specified folder.');
        return;
    }

    // Filter by explicit file list
    if (args.files && args.files.length > 0) {
        const requestedSet = new Set(args.files);
        imageFiles = imageFiles.filter(f => requestedSet.has(f));
    }

    // Filter by page range
    if (args.pages) {
        const pageNumbers = parsePageRangeForAttach(args.pages);
        if (pageNumbers.length > 0) {
            imageFiles = imageFiles.filter(f => {
                const match = f.match(/page_(\d+)/);
                if (match) {
                    return pageNumbers.includes(parseInt(match[1], 10));
                }
                return false;
            });
        }
    }

    if (imageFiles.length === 0) {
        vscode.window.showWarningMessage('No images match the specified selection.');
        return;
    }

    if (imageFiles.length > 20) {
        vscode.window.showWarningMessage(
            `Selection contains ${imageFiles.length} images, which exceeds Copilot Chat's 20-image limit. Please narrow your selection.`
        );
        return;
    }

    const imageUris = imageFiles.map(f => vscode.Uri.file(path.join(targetFolder, f)));

    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '',
        attachFiles: imageUris
    });
    vscode.window.showInformationMessage(`Attached ${imageFiles.length} image(s) to Copilot Chat.`);
}

/**
 * Parse a page range string (e.g. "1,3,5-8") into an array of page numbers.
 * Used by the programmatic attach command — no maxPage cap needed since
 * we filter against actual filenames.
 */
function parsePageRangeForAttach(rangeStr: string): number[] {
    const pages: Set<number> = new Set();
    const parts = rangeStr.split(',');

    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.includes('-')) {
            const [startStr, endStr] = trimmed.split('-').map(s => s.trim());
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (!isNaN(start) && !isNaN(end) && start >= 1 && end >= start) {
                for (let i = start; i <= end; i++) {
                    pages.add(i);
                }
            }
        } else {
            const page = parseInt(trimmed, 10);
            if (!isNaN(page) && page >= 1) {
                pages.add(page);
            }
        }
    }

    return Array.from(pages).sort((a, b) => a - b);
}

export function deactivate() {}
