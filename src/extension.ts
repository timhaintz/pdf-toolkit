import * as vscode from 'vscode';
import { PdfEditorProvider } from './pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('PDF Viewer extension is now active!');

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
}

/**
 * Browse previously extracted PDFs
 */
async function browseExtractedPdfs(pdfEditorProvider: PdfEditorProvider): Promise<void> {
    const extracted = pdfEditorProvider.getExtractedPdfs();

    if (extracted.length === 0) {
        vscode.window.showInformationMessage('No screenshots have been created from PDF(s). Use the Screenshot button to extract pages from a PDF.');
        return;
    }

    // Validate that folders still exist and filter out missing ones
    const validExtracted: typeof extracted = [];
    const missingFolders: string[] = [];

    for (const pdf of extracted) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(pdf.path));
            validExtracted.push(pdf);
        } catch {
            // Folder no longer exists
            missingFolders.push(pdf.name);
        }
    }

    // Update the stored list if any folders were missing
    if (missingFolders.length > 0) {
        await pdfEditorProvider.context.workspaceState.update('extractedPdfs', validExtracted);
        
        if (missingFolders.length === extracted.length) {
            // All folders were deleted
            vscode.window.showInformationMessage('No screenshots have been created from PDF(s). Previously extracted folders have been removed.');
            return;
        } else {
            // Some folders were deleted
            vscode.window.showWarningMessage(`${missingFolders.length} screenshot folder(s) no longer exist and have been removed from the list.`);
        }
    }

    if (validExtracted.length === 0) {
        vscode.window.showInformationMessage('No screenshots have been created from PDF(s). Use the Screenshot button to extract pages from a PDF.');
        return;
    }

    interface ExtractedPdfItem extends vscode.QuickPickItem {
        pdfData?: { name: string; path: string; pageCount: number; extractedAt: string };
        action?: string;
    }

    const items: ExtractedPdfItem[] = validExtracted.map(pdf => ({
        label: `$(file-media) ${pdf.name}`,
        description: `${pdf.pageCount} page(s)`,
        detail: `Extracted: ${new Date(pdf.extractedAt).toLocaleDateString()}`,
        pdfData: pdf
    }));

    // Add actions at the bottom
    items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(folder) Open PDF Screenshots Folder', action: 'openFolder' },
        { label: '$(trash) Clear History', action: 'clearHistory' }
    );

    const selected = await vscode.window.showQuickPick(items, {
        title: '📁 Extracted PDFs',
        placeHolder: 'Select a PDF to view options'
    });

    if (!selected) return;

    if (selected.action === 'openFolder') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const screenshotsDir = vscode.Uri.file(
                require('path').join(workspaceFolders[0].uri.fsPath, 'PDF Screenshots')
            );
            try {
                await vscode.workspace.fs.stat(screenshotsDir);
                await vscode.commands.executeCommand('revealFileInOS', screenshotsDir);
            } catch {
                vscode.window.showInformationMessage('The PDF Screenshots folder does not exist. Extract some PDF pages first.');
            }
        }
        return;
    }

    if (selected.action === 'clearHistory') {
        const confirm = await vscode.window.showWarningMessage(
            'Clear the extraction history? (This does not delete the image files)',
            'Clear History',
            'Cancel'
        );
        if (confirm === 'Clear History') {
            await pdfEditorProvider.context.workspaceState.update('extractedPdfs', []);
            vscode.window.showInformationMessage('Extraction history cleared.');
        }
        return;
    }

    if (selected.pdfData) {
        await showPdfActions(pdfEditorProvider, selected.pdfData);
    }
}

/**
 * Show actions for a specific extracted PDF
 */
async function showPdfActions(
    pdfEditorProvider: PdfEditorProvider,
    pdf: { name: string; path: string; pageCount: number; extractedAt: string }
): Promise<void> {
    const path = require('path');
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
        { label: '$(clippy) Copy for Copilot Chat', description: `Copy all ${imageFiles.length} images as #file: references`, action: 'copilot' },
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
        case 'copilot':
            if (imageFiles.length === 0) {
                vscode.window.showWarningMessage('No images found in this folder.');
                return;
            }
            const filePaths = imageFiles.map(f => path.join(pdf.path, f));
            
            // Get workspace folder to create relative paths
            const workspaceFolders = vscode.workspace.workspaceFolders;
            let references: string[] = [];

            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspaceRoot = workspaceFolders[0].uri.fsPath;
                references = filePaths.map((fp: string) => {
                    const relativePath = path.relative(workspaceRoot, fp).replace(/\\/g, '/');
                    return `#file:${relativePath}`;
                });
            } else {
                references = filePaths.map((fp: string) => `#file:${fp.replace(/\\/g, '/')}`);
            }

            await vscode.env.clipboard.writeText(references.join(' '));
            const openChat = await vscode.window.showInformationMessage(
                `Copied ${imageFiles.length} image reference(s) to clipboard!`,
                'Open Copilot Chat'
            );
            if (openChat === 'Open Copilot Chat') {
                await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
            }
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

export function deactivate() {}
