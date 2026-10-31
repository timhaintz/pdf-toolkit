/**
 * Bounds application-owned export canvases and retained encoded image batches.
 * PDF.js may allocate additional memory while decoding a PDF. Keep this factory
 * self-contained: the webview embeds its compiled source directly.
 */
export function createExportLimits() {
    const maxDimension = 8192;
    const maxPixels = 32_000_000;
    const maxEncodedBytes = 64 * 1024 * 1024;
    let nextId = 0;
    let activeId: string | undefined;
    let waitingForHost = false;
    let encodedBytes = 0;

    class ExportResourceLimitError extends Error {
        constructor(reason: string) {
            super(reason + ' Use a lower resolution or select fewer pages.');
            this.name = 'ExportResourceLimitError';
        }
    }

    function fail(reason: string): never {
        throw new ExportResourceLimitError(reason);
    }

    function assertPositiveDimensions(width: number, height: number, description: string): void {
        if (!Number.isFinite(width) || !Number.isFinite(height)
            || Math.floor(width) < 1 || Math.floor(height) < 1) {
            fail(description + ' has invalid image dimensions.');
        }
    }

    return {
        begin(): string | undefined {
            if (activeId) return undefined;
            activeId = 'extraction-' + ++nextId;
            waitingForHost = false;
            encodedBytes = 0;
            return activeId;
        },
        end(id: string): void {
            if (id !== activeId) return;
            activeId = undefined;
            waitingForHost = false;
            encodedBytes = 0;
        },
        waitForHost(id: string): void {
            if (id === activeId) waitingForHost = true;
        },
        acknowledge(id: unknown): boolean {
            if (!waitingForHost || id !== activeId) return false;
            activeId = undefined;
            waitingForHost = false;
            encodedBytes = 0;
            return true;
        },
        assertDimensions(width: number, height: number, description: string): void {
            assertPositiveDimensions(width, height, description);
            if (width > maxDimension || height > maxDimension || width * height > maxPixels) {
                fail(description + ' exceeds the image limit (8192 pixels per dimension and 32 million pixels per image).');
            }
        },
        scanScale(width: number, height: number): number {
            assertPositiveDimensions(width, height, 'The page image scan');
            const scale = Math.min(1, maxDimension / width, maxDimension / height,
                Math.sqrt(maxPixels / width / height));
            // Only this discarded scan raster may shrink. PDF.js still exposes
            // embedded bitmap objects at their native dimensions. Leave a tiny
            // margin for floating-point rounding at the allocation boundary.
            return scale < 1 ? scale * (1 - 1e-10) : 1;
        },
        retainDataUrl(data: string): void {
            // Canvas image data URLs are ASCII: each encoded character is one
            // byte. This bounds the encoded payload, not all JavaScript memory.
            if (typeof data !== 'string' || !data.startsWith('data:image/')) {
                fail('The image could not be encoded.');
            }
            if (data.length > maxEncodedBytes - encodedBytes) {
                fail('The extracted image batch exceeds the 64 MiB encoded data limit.');
            }
            encodedBytes += data.length;
        },
        isResourceLimitError(error: unknown): boolean {
            return error instanceof ExportResourceLimitError;
        },
        fail
    };
}
