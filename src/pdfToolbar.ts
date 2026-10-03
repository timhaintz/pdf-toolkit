/** Runs inside the PDF webview; keep this function independent of module state. */
export function setupPdfToolbar(): { closeScreenshot: () => void; focusSearch: () => void } {
    const shell = document.getElementById('toolbar-shell')!;
    const viewport = document.getElementById('toolbar-viewport')!;
    const toolbar = document.getElementById('pdf-toolbar')!;
    const trigger = document.getElementById('screenshot-btn')!;
    const menu = document.getElementById('screenshot-dropdown')!;
    const more = document.getElementById('toolbar-more-btn') as HTMLButtonElement;
    const overflow = document.getElementById('toolbar-overflow')!;
    const fileInfo = document.getElementById('file-info')!;
    const search = document.getElementById('search-input') as HTMLInputElement;
    const buttons = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const overflowItems = () => Array.from(overflow.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
    // Removal priority differs from the visual order, which stays the same in both locations.
    const groups = ['rotation-controls', 'reset-controls', 'appearance-controls', 'search-controls'].map(id => {
        const element = document.getElementById(id)!;
        const anchor = document.createComment(id);
        element.before(anchor);
        return { element, anchor };
    });
    const visualOrder = Array.from(toolbar.children).filter(element => groups.some(group => group.element === element));
    const inlineOrder = Array.from(toolbar.children) as HTMLElement[];
    // Measure invisible copies instead of disturbing live controls on every search result update.
    const measurement = document.createElement('div');
    measurement.className = 'pdf-controls';
    measurement.setAttribute('aria-hidden', 'true');
    measurement.inert = true;
    measurement.style.cssText = 'position:fixed;left:-10000px;top:-10000px;display:flex;width:max-content;visibility:hidden;pointer-events:none;';
    const measuredToolbar = document.createElement('div');
    measuredToolbar.className = toolbar.className;
    measuredToolbar.style.width = 'max-content';
    measurement.append(measuredToolbar);
    document.body.append(measurement);
    let layoutFrame = 0;
    let composing = false;
    let deferredLayout = false;

    function measurementCopy(source: HTMLElement): HTMLElement {
        const copy = source.cloneNode(true) as HTMLElement;
        for (const element of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))]) {
            element.removeAttribute('id');
            element.removeAttribute('for');
            element.removeAttribute('list');
            for (const attribute of Array.from(element.attributes)) {
                if (attribute.name.startsWith('aria-')) element.removeAttribute(attribute.name);
            }
            if (element.matches('button, input, a, [tabindex]')) element.tabIndex = -1;
        }
        return copy;
    }

    function revealControl(element: HTMLElement): void {
        const scroller = viewport.contains(element) ? viewport
            : overflow.contains(element) ? overflow
            : menu.contains(element) ? menu
            : undefined;
        if (!scroller) return;
        const control = element.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        const left = bounds.left + scroller.clientLeft;
        const right = left + scroller.clientWidth;
        const top = bounds.top + scroller.clientTop;
        const bottom = top + scroller.clientHeight;
        // Scroll only this controls container, and only if the control is clipped.
        // Repeated scrollIntoView calls can interrupt the PDF's smooth match navigation.
        if (control.left < left) scroller.scrollLeft += control.left - left;
        else if (control.right > right) scroller.scrollLeft += control.right - right;
        if (scroller !== viewport) {
            if (control.top < top) scroller.scrollTop += control.top - top;
            else if (control.bottom > bottom) scroller.scrollTop += control.bottom - bottom;
        }
    }

    function focusControl(element: HTMLElement | undefined): void {
        if (!element) return;
        element.focus({ preventScroll: true });
        revealControl(element);
    }

    function closeScreenshot(restoreFocus = false): void {
        menu.classList.remove('show');
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) focusControl(trigger);
    }

    function closeOverflow(restoreFocus = false): void {
        overflow.classList.remove('show');
        more.setAttribute('aria-expanded', 'false');
        if (restoreFocus) {
            focusControl(more.hidden ? document.getElementById('browse-extracted-btn')! : more);
        }
    }

    function positionPopup(popup: HTMLElement, button: HTMLElement): void {
        if (!popup.classList.contains('show')) return;
        const anchor = button.getBoundingClientRect();
        const margin = 8;
        const scrollTop = popup.scrollTop;
        const focused = popup.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
        popup.style.maxWidth = Math.max(0, window.innerWidth - margin * 2) + 'px';
        popup.style.maxHeight = Math.max(0, window.innerHeight - margin * 2) + 'px';
        const size = popup.getBoundingClientRect();
        const below = window.innerHeight - anchor.bottom - margin - 4;
        const above = anchor.top - margin - 4;
        const opensAbove = below < size.height && above > below;
        const height = Math.min(size.height, Math.max(0, opensAbove ? above : below));
        popup.style.maxHeight = height + 'px';
        const constrainedWidth = popup.getBoundingClientRect().width;
        popup.style.left = Math.max(margin, Math.min(anchor.left, window.innerWidth - constrainedWidth - margin)) + 'px';
        popup.style.top = (opensAbove ? Math.max(margin, anchor.top - height - 4) : anchor.bottom + 4) + 'px';
        if (popup.scrollTop !== scrollTop) popup.scrollTop = scrollTop;
        if (focused) revealControl(focused);
    }

    function positionMenu(): void {
        if (!menu.classList.contains('show')) return;
        const anchor = trigger.getBoundingClientRect();
        const visible = viewport.getBoundingClientRect();
        if (anchor.right <= visible.left || anchor.left >= visible.right) {
            closeScreenshot(menu.contains(document.activeElement));
            return;
        }
        positionPopup(menu, trigger);
    }

    function showOverflow(): void {
        if (more.hidden) return;
        closeScreenshot();
        overflow.classList.add('show');
        more.setAttribute('aria-expanded', 'true');
        positionPopup(overflow, more);
    }

    function openOverflow(focusLast = false): void {
        showOverflow();
        const items = overflowItems();
        focusControl(focusLast ? items.at(-1) : items[0]);
    }

    function layout(): void {
        layoutFrame = 0;
        if (composing) {
            deferredLayout = true;
            return;
        }
        const active = document.activeElement as HTMLElement | null;
        const input = active instanceof HTMLInputElement ? active : undefined;
        // Number inputs have no text selection, whereas search and zoom do.
        const selection = input && input.selectionStart !== null
            ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
            : undefined;
        const wasOpen = overflow.classList.contains('show');
        const scrollLeft = viewport.scrollLeft;
        const copies = new Map(inlineOrder.map(element => [element, measurementCopy(element)]));
        measuredToolbar.replaceChildren(...copies.values());
        const measuredMore = measurementCopy(more);
        measuredMore.hidden = false;
        measurement.append(measuredMore);
        const available = shell.clientWidth;
        const naturalWidth = () => measuredToolbar.getBoundingClientRect().width;
        const measuredInfo = copies.get(fileInfo)!;
        measuredInfo.hidden = false;
        // Filename metadata yields space before any interactive controls do.
        const hideInfo = naturalWidth() > available + 1;
        measuredInfo.hidden = hideInfo;
        const moved = new Set<Element>();
        if (naturalWidth() > available + 1) {
            const moreStyle = getComputedStyle(measuredMore);
            const reserved = measuredMore.getBoundingClientRect().width + parseFloat(moreStyle.marginLeft) + parseFloat(moreStyle.marginRight);
            for (const group of groups) {
                if (naturalWidth() <= available - reserved + 1) break;
                copies.get(group.element)!.hidden = true;
                moved.add(group.element);
            }
        }
        measuredMore.remove();
        fileInfo.hidden = hideInfo;
        more.hidden = moved.size === 0;

        for (const group of groups) {
            if (!moved.has(group.element) && group.element.parentElement !== toolbar) group.anchor.after(group.element);
        }
        let next: Element | null = null;
        for (const element of [...visualOrder].reverse()) {
            if (!moved.has(element)) continue;
            if (element.parentElement !== overflow || element.nextElementSibling !== next) overflow.insertBefore(element, next);
            next = element;
        }

        const activeMoved = active !== null && overflow.contains(active);
        if (moved.size === 0) closeOverflow();
        else if (wasOpen || activeMoved) showOverflow();

        if (viewport.scrollLeft !== scrollLeft) viewport.scrollLeft = scrollLeft;
        if (active === more && more.hidden) {
            focusControl(document.getElementById('browse-extracted-btn')!);
        } else if (active && document.activeElement !== active) {
            active.focus({ preventScroll: true });
            if (selection) input!.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
        }
        if (active && (toolbar.contains(active) || overflow.contains(active))) {
            revealControl(active);
        }
        positionMenu();
        positionPopup(overflow, more);
    }

    function scheduleLayout(): void {
        if (composing) {
            deferredLayout = true;
            return;
        }
        if (!layoutFrame) layoutFrame = requestAnimationFrame(layout);
    }

    search.addEventListener('compositionstart', () => { composing = true; });
    search.addEventListener('compositionend', () => {
        composing = false;
        if (deferredLayout) {
            deferredLayout = false;
            scheduleLayout();
        }
    });

    function openScreenshot(focusLast = false): void {
        closeOverflow();
        revealControl(trigger);
        menu.classList.add('show');
        trigger.setAttribute('aria-expanded', 'true');
        positionMenu();
        const items = buttons();
        focusControl(focusLast ? items.at(-1) : items[0]);
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
            focusControl(trigger);
            closeScreenshot();
        }
        if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            focusControl(items[next]);
        }
    });
    menu.addEventListener('click', event => {
        if ((event.target as Element).closest('button')) closeScreenshot(true);
    });
    more.addEventListener('click', event => {
        event.stopPropagation();
        if (overflow.classList.contains('show')) closeOverflow();
        else openOverflow();
    });
    more.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            openOverflow(event.key === 'ArrowUp');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeOverflow(true);
        }
    });
    overflow.addEventListener('keydown', event => {
        if (composing || event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeOverflow(true);
        } else if (event.key === 'Tab') {
            const items = overflowItems();
            const active = document.activeElement;
            if ((event.shiftKey && active === items[0]) || (!event.shiftKey && active === items.at(-1))) {
                // Exit the secondary controls through their pinned trigger's normal tab order.
                focusControl(more);
                closeOverflow();
            }
        }
        // Arrow/Home/End keys keep their native text-editing behavior in search.
    });
    document.addEventListener('click', event => {
        const target = event.target as Node;
        if (!trigger.contains(target) && !menu.contains(target)) closeScreenshot();
        if (!more.contains(target) && !overflow.contains(target)) closeOverflow();
    });
    viewport.addEventListener('focusin', event => {
        revealControl(event.target as HTMLElement);
    });
    overflow.addEventListener('focusin', event => {
        revealControl(event.target as HTMLElement);
    });
    menu.addEventListener('focusin', event => { revealControl(event.target as HTMLElement); });
    viewport.addEventListener('scroll', positionMenu, { passive: true });
    window.addEventListener('resize', () => {
        scheduleLayout();
        positionMenu();
        positionPopup(overflow, more);
    });
    new ResizeObserver(positionMenu).observe(viewport);
    // Watching the shell avoids feedback from our own More button changing viewport width.
    new ResizeObserver(scheduleLayout).observe(shell);
    const textObserver = new MutationObserver(scheduleLayout);
    for (const id of ['page-count', 'search-results']) {
        textObserver.observe(document.getElementById(id)!, { childList: true, characterData: true, subtree: true });
    }
    void document.fonts.ready.then(scheduleLayout);
    scheduleLayout();
    return {
        closeScreenshot: () => closeScreenshot(true),
        focusSearch: () => {
            closeScreenshot();
            if (overflow.contains(search)) showOverflow();
            focusControl(search);
        }
    };
}
