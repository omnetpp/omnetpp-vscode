/**
 * contextMenu.ts (phase U4) — a generic, DOM-based context-menu FRAMEWORK: absolutely
 * positioned, codicon-capable, with submenu flyouts, separators, checkbox/radio-style
 * checkmarks, disabled items, click-away/Esc dismissal, and keyboard navigation
 * (Up/Down/Left/Right/Enter/Esc). Deliberately generic and DOM-only (no chart-specific
 * knowledge) so `client/src/eventlog`'s table view (U6, per the port plan's note "table
 * will reuse in U6") can build its own `MenuEntry[]` and reuse this exact component.
 *
 * Styling lives in `client/src/eventlog/webviewHtml.ts`'s shared CSP'd `<style>` block
 * (the `.elog-menu*` classes) — this module only creates/classes elements, no inline
 * `<style>` (CSP has no `'unsafe-inline'` for style beyond the page's own nonce, which
 * this module doesn't have access to from deep in a webview app's runtime code).
 *
 * Not unit-tested (DOM-dependent, same convention as `interactions.ts`/`canvasStack.ts`)
 * -- the chart-specific menu CONTENT builder (`chartContextMenu.ts`) that decides WHAT
 * items appear is pure and unit-tested instead.
 */

export interface MenuItemSpec {
  id: string;
  label: string;
  /** Codicon name (without the `codicon-` prefix), e.g. `"go-to-file"`. Optional -- most items have none, matching Eclipse's own mix of icon/no-icon actions. */
  icon?: string;
  disabled?: boolean;
  /** Renders a checkmark (checkbox/radio-style item, e.g. a Timeline Mode radio). */
  checked?: boolean;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItemSpec | { separator: true };

function isSeparator(entry: MenuEntry): entry is { separator: true } {
  return 'separator' in entry;
}

export interface ContextMenuHandle {
  dispose(): void;
}

const OPEN_MENUS: HTMLElement[] = []; // stack of currently-open menu <div>s, root first

function closeAll(): void {
  for (const el of OPEN_MENUS) el.remove();
  OPEN_MENUS.length = 0;
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
}

function onDocMouseDown(e: MouseEvent): void {
  if (OPEN_MENUS.some((m) => m.contains(e.target as Node))) return;
  closeAll();
}

function onDocKeyDown(e: KeyboardEvent): void {
  const top = OPEN_MENUS[OPEN_MENUS.length - 1];
  if (!top) return;
  const items = [...top.querySelectorAll<HTMLElement>(':scope > .elog-menu-item:not(.disabled)')];
  const current = top.querySelector<HTMLElement>('.elog-menu-item.highlighted');
  const index = current ? items.indexOf(current) : -1;

  switch (e.key) {
    case 'ArrowDown': {
      const next = items[(index + 1 + items.length) % items.length];
      highlight(top, next);
      e.preventDefault();
      break;
    }
    case 'ArrowUp': {
      const prev = items[(index - 1 + items.length) % items.length];
      highlight(top, prev);
      e.preventDefault();
      break;
    }
    case 'ArrowRight':
      if (current?.dataset.hasSubmenu) openSubmenuFor(top, current);
      e.preventDefault();
      break;
    case 'ArrowLeft':
      if (OPEN_MENUS.length > 1) {
        OPEN_MENUS.pop()!.remove();
        e.preventDefault();
      }
      break;
    case 'Enter':
    case ' ':
      current?.click();
      e.preventDefault();
      break;
    case 'Escape':
      if (OPEN_MENUS.length > 1) OPEN_MENUS.pop()!.remove();
      else closeAll();
      e.preventDefault();
      break;
  }
}

function highlight(menu: HTMLElement, el: HTMLElement | undefined): void {
  menu.querySelectorAll('.elog-menu-item.highlighted').forEach((n) => n.classList.remove('highlighted'));
  el?.classList.add('highlighted');
}

function openSubmenuFor(parentMenu: HTMLElement, itemEl: HTMLElement, submenu?: MenuEntry[]): void {
  // close any already-open deeper submenu first (moving between siblings)
  while (OPEN_MENUS[OPEN_MENUS.length - 1] !== parentMenu) OPEN_MENUS.pop()!.remove();
  const entries: MenuEntry[] | undefined = submenu ?? (itemEl as unknown as { __submenu?: MenuEntry[] }).__submenu;
  if (!entries) return;
  const rect = itemEl.getBoundingClientRect();
  const sub = buildMenuElement(entries, rect.right, rect.top);
  document.body.appendChild(sub);
  clampIntoViewport(sub, rect.right, rect.top);
  OPEN_MENUS.push(sub);
}

function clampAxis(pos: number, size: number, limit: number): number {
  return Math.max(0, pos + size > limit ? limit - size : pos);
}

function clampIntoViewport(el: HTMLElement, x: number, y: number): void {
  const rect = el.getBoundingClientRect();
  el.style.left = `${clampAxis(x, rect.width, window.innerWidth)}px`;
  el.style.top = `${clampAxis(y, rect.height, window.innerHeight)}px`;
}

function buildMenuElement(entries: MenuEntry[], x: number, y: number): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'elog-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.setAttribute('role', 'menu');

  for (const entry of entries) {
    if (isSeparator(entry)) {
      const sep = document.createElement('div');
      sep.className = 'elog-menu-separator';
      menu.appendChild(sep);
      continue;
    }
    const itemEl = document.createElement('div');
    itemEl.className = 'elog-menu-item' + (entry.disabled ? ' disabled' : '');
    itemEl.setAttribute('role', 'menuitem');
    itemEl.tabIndex = -1;

    const check = document.createElement('span');
    check.className = 'elog-menu-check';
    check.textContent = entry.checked ? '✓' : '';
    itemEl.appendChild(check);

    if (entry.icon) {
      const iconEl = document.createElement('span');
      iconEl.className = `codicon codicon-${entry.icon} elog-menu-icon`;
      itemEl.appendChild(iconEl);
    }

    const labelEl = document.createElement('span');
    labelEl.className = 'elog-menu-label';
    labelEl.textContent = entry.label;
    itemEl.appendChild(labelEl);

    if (entry.submenu) {
      itemEl.dataset.hasSubmenu = '1';
      (itemEl as unknown as { __submenu: MenuEntry[] }).__submenu = entry.submenu;
      const arrow = document.createElement('span');
      arrow.className = 'codicon codicon-chevron-right elog-menu-arrow';
      itemEl.appendChild(arrow);
    }

    if (!entry.disabled) {
      itemEl.addEventListener('mouseenter', () => {
        highlight(menu, itemEl);
        if (entry.submenu) openSubmenuFor(menu, itemEl, entry.submenu);
        else while (OPEN_MENUS.length > 0 && OPEN_MENUS[OPEN_MENUS.length - 1] !== menu) OPEN_MENUS.pop()!.remove();
      });
      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (entry.submenu) {
          openSubmenuFor(menu, itemEl, entry.submenu);
          return;
        }
        entry.onSelect?.();
        closeAll();
      });
    }
    menu.appendChild(itemEl);
  }
  return menu;
}

/** Shows a context menu at client (viewport) coordinates `(x, y)`, replacing any menu already open. */
export function showContextMenu(x: number, y: number, entries: MenuEntry[]): ContextMenuHandle {
  closeAll();
  const root = buildMenuElement(entries, x, y);
  document.body.appendChild(root);
  clampIntoViewport(root, x, y);
  OPEN_MENUS.push(root);
  // deferred so the triggering mousedown/contextmenu event itself doesn't immediately close it
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
  }, 0);
  return { dispose: closeAll };
}
