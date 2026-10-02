export interface CompositeOptions {
    layout: 'vertical' | 'grid';
    quality: number;
    pagesPerImage: number;
    labels: boolean;
    padding: number;
}

/** Page dimensions are pixels at the requested PDF.js rendering scale. */
export interface CompositePage {
    page: number;
    width: number;
    height: number;
}

export interface CompositePlacement extends CompositePage {
    x: number;
    y: number;
    /** Horizontal text center and alphabetic text baseline for the page label. */
    labelX: number;
    labelY: number;
}

export interface CompositePlan {
    width: number;
    height: number;
    pages: CompositePlacement[];
}

/**
 * Arrange pages without lowering their requested resolution. Oversized groups
 * are split into consecutive smaller groups within conservative canvas limits.
 * Keep every runtime dependency inside this function: the webview embeds its
 * compiled source directly, so it must also work without the module wrapper.
 */
export function planCompositeImages(pages: CompositePage[], options: CompositeOptions): CompositePlan[] {
    const maxDimension = 8192;
    const maxPixels = 32_000_000;

    if (!options || (options.layout !== 'vertical' && options.layout !== 'grid')) {
        throw new Error('Composite layout must be vertical or grid.');
    }
    if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 4) {
        throw new Error('Composite resolution must be an integer from 1 to 4.');
    }
    const maxPages = options.layout === 'grid' ? 4 : 16;
    if (!Number.isInteger(options.pagesPerImage) || options.pagesPerImage < 1 || options.pagesPerImage > maxPages) {
        throw new Error(`Pages per composite image must be an integer from 1 to ${maxPages}.`);
    }
    if (!Number.isFinite(options.padding) || options.padding < 0 || options.padding > 48) {
        throw new Error('Composite padding must be between 0 and 48.');
    }
    if (typeof options.labels !== 'boolean') {
        throw new Error('Composite page labels must be enabled or disabled.');
    }
    if (!Array.isArray(pages)) {
        throw new Error('Composite pages must be an array.');
    }

    const pageNumbers = new Set<number>();
    for (const page of pages) {
        if (!page || !Number.isInteger(page.page) || page.page < 1 || pageNumbers.has(page.page)) {
            throw new Error('Composite page numbers must be unique positive integers.');
        }
        if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
            throw new Error(`Page ${page.page} must have finite positive dimensions.`);
        }
        pageNumbers.add(page.page);
    }

    const padding = Math.ceil(options.padding * options.quality);
    const labelHeight = options.labels ? 24 * options.quality : 0;

    function planGroup(group: CompositePage[]): CompositePlan {
        const cellWidth = Math.max(...group.map(page => Math.ceil(page.width)));
        const pageHeight = Math.max(...group.map(page => Math.ceil(page.height)));
        const cellHeight = pageHeight + labelHeight;
        const columns = options.layout === 'grid' && group.length > 1 ? 2 : 1;
        const rows = Math.ceil(group.length / columns);
        return {
            width: columns * cellWidth + (columns + 1) * padding,
            height: rows * cellHeight + (rows + 1) * padding,
            pages: group.map((page, index) => {
                const width = Math.ceil(page.width);
                const height = Math.ceil(page.height);
                const cellX = padding + (index % columns) * (cellWidth + padding);
                const cellY = padding + Math.floor(index / columns) * (cellHeight + padding);
                return {
                    page: page.page,
                    width,
                    height,
                    x: cellX + Math.floor((cellWidth - width) / 2),
                    y: cellY + Math.floor((pageHeight - height) / 2),
                    labelX: cellX + cellWidth / 2,
                    labelY: cellY + pageHeight + (options.labels ? 18 * options.quality : 0)
                };
            })
        };
    }

    const plans: CompositePlan[] = [];
    let start = 0;
    while (start < pages.length) {
        let count = Math.min(options.pagesPerImage, pages.length - start);
        let plan = planGroup(pages.slice(start, start + count));
        while (plan.width > maxDimension || plan.height > maxDimension || plan.width * plan.height > maxPixels) {
            if (count === 1) {
                throw new Error(`Page ${pages[start].page} is too large for a composite image. Reduce the resolution and try again.`);
            }
            count--;
            plan = planGroup(pages.slice(start, start + count));
        }
        plans.push(plan);
        start += count;
    }
    return plans;
}
