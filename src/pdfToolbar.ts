/** Runs inside the PDF webview; keep this function independent of module state. */
export function setupPdfToolbar(): { closeScreenshot: () => void } {
    const viewport = document.getElementById('toolbar-viewport')!;
    const trigger = document.getElementById('screenshot-btn')!;
    const menu = document.getElementById('screenshot-dropdown')!;
    const buttons = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));

    function closeScreenshot(restoreFocus = false): void {
        menu.classList.remove('show');
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) trigger.focus();
    }

    function positionMenu(): void {
        if (!menu.classList.contains('show')) return;
        const anchor = trigger.getBoundingClientRect();
        const visible = viewport.getBoundingClientRect();
        if (anchor.right <= visible.left || anchor.left >= visible.right) {
            closeScreenshot(menu.contains(document.activeElement));
            return;
        }
        const margin = 8;
        const scrollTop = menu.scrollTop;
        const focused = menu.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
        menu.style.maxWidth = Math.max(0, window.innerWidth - margin * 2) + 'px';
        menu.style.maxHeight = Math.max(0, window.innerHeight - margin * 2) + 'px';
        const size = menu.getBoundingClientRect();
        const below = window.innerHeight - anchor.bottom - margin - 4;
        const above = anchor.top - margin - 4;
        const opensAbove = below < size.height && above > below;
        const height = Math.min(size.height, Math.max(0, opensAbove ? above : below));
        menu.style.maxHeight = height + 'px';
        const constrainedWidth = menu.getBoundingClientRect().width;
        menu.style.left = Math.max(margin, Math.min(anchor.left, window.innerWidth - constrainedWidth - margin)) + 'px';
        menu.style.top = (opensAbove ? Math.max(margin, anchor.top - height - 4) : anchor.bottom + 4) + 'px';
        menu.scrollTop = scrollTop;
        focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function openScreenshot(focusLast = false): void {
        trigger.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        menu.classList.add('show');
        trigger.setAttribute('aria-expanded', 'true');
        positionMenu();
        const items = buttons();
        (focusLast ? items.at(-1) : items[0])?.focus();
    }

    trigger.addEventListener('click', event => {
        event.stopPropagation();
        if (menu.classList.contains('show')) closeScreenshot();
        else openScreenshot();
    });
    trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            openScreenshot(event.key === 'ArrowUp');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeScreenshot(true);
        }
    });
    menu.addEventListener('keydown', event => {
        const items = buttons();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === 'ArrowDown') next = (index + 1) % items.length;
        else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeScreenshot(true);
        } else if (event.key === 'Tab') {
            // Leave the menu through its trigger's normal toolbar tab order.
            trigger.focus();
            closeScreenshot();
        }
        if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            items[next]?.focus();
        }
    });
    menu.addEventListener('click', event => {
        if ((event.target as Element).closest('button')) closeScreenshot(true);
    });
    document.addEventListener('click', event => {
        if (!trigger.contains(event.target as Node) && !menu.contains(event.target as Node)) closeScreenshot();
    });
    viewport.addEventListener('focusin', event => {
        (event.target as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    viewport.addEventListener('scroll', positionMenu, { passive: true });
    window.addEventListener('resize', positionMenu);
    new ResizeObserver(positionMenu).observe(viewport);
    return { closeScreenshot: () => closeScreenshot(true) };
}
