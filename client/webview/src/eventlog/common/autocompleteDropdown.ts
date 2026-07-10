/**
 * A lightweight, DOM-based autocomplete dropdown for a plain `<input>`: recomputes its
 * item list from a caller-supplied `computeProposals(text, cursorOffset)` on every
 * relevant keystroke/cursor-move, and lets the user pick with the mouse or the
 * standard keyboard trio (Up/Down to navigate, Enter/Tab to accept, Escape to
 * dismiss). Built for the Event Log Table's Custom-filter box (phase U10,
 * `entryProposals.ts`'s `computeEntryProposals()`), which needs POSITION-aware
 * completion a browser-native `<datalist>` can't provide (its suggestions are matched
 * against the whole field value, not the token under the cursor) -- see `tableView.ts`
 * for the wiring.
 *
 * Reuses the context-menu framework's `.elog-menu`/`.elog-menu-item`/`.elog-menu-label`
 * CSS classes (`common/contextMenu.ts`, `webviewHtml.ts`'s shared `<style>` block) for
 * visual consistency, but is otherwise independent of it: `contextMenu.ts` is a
 * click-to-open, static-content, multi-level (submenu) framework built around a stack
 * of already-decided menu entries; this is a live-filtered, single-level,
 * keystroke-driven widget recomputed from scratch on every input event -- different
 * enough interaction models that adapting `contextMenu.ts` itself would have meant
 * threading this one through code that also has to support submenus/checkmarks/icons
 * it doesn't need.
 *
 * KEYDOWN INTERCEPTION: `toolbar.ts`'s own `<input>` already has a `keydown` listener
 * that commits the filter value on Enter (bubble phase, added when the input was
 * built, BEFORE this module ever sees the element). For this dropdown's Enter/Tab-to-
 * accept and Up/Down-to-navigate to take priority over that (and to stop Escape from
 * bubbling to anything else) while the dropdown is open, this attaches its OWN
 * `keydown` listener on `document` with `capture: true` (the same trick
 * `contextMenu.ts` uses for its own keyboard nav) -- a capture-phase listener on an
 * ANCESTOR runs before the event ever reaches the input's bubble-phase listeners, so
 * `stopPropagation()` there genuinely pre-empts `toolbar.ts`'s commit-on-Enter. A
 * same-element listener could NOT do this: two listeners on the same element fire in
 * REGISTRATION order regardless of the `capture` flag, and toolbar.ts's was registered
 * first.
 */

export interface AutocompleteItem {
  /** Full text to insert in place of the replaced range. */
  text: string;
  /** Display label. */
  label: string;
}

export interface AutocompleteProposals {
  /** Offset into the input's current value where the replacement should start. */
  replaceStart: number;
  /** Offset into the input's current value where the replacement should end (the range `[replaceStart, replaceEnd)` is replaced by the accepted item's `text`). */
  replaceEnd: number;
  items: AutocompleteItem[];
}

export interface AutocompleteHandle {
  /** Closes the dropdown (if open) and removes every listener this attached -- call before the input itself is torn down. */
  dispose(): void;
}

/** Attaches a position-aware autocomplete dropdown to `input`, backed by `computeProposals`. An empty `items` list closes the dropdown (nothing to show). */
export function attachAutocomplete(input: HTMLInputElement, computeProposals: (text: string, cursorOffset: number) => AutocompleteProposals): AutocompleteHandle {
  let popup: HTMLElement | undefined;
  let items: AutocompleteItem[] = [];
  let replaceStart = 0;
  let replaceEnd = 0;
  let highlighted = -1;

  function isOpen(): boolean {
    return popup !== undefined;
  }

  function render(): void {
    if (!popup) return;
    popup.innerHTML = '';
    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'elog-menu-item' + (i === highlighted ? ' highlighted' : '');
      el.setAttribute('role', 'option');
      const label = document.createElement('span');
      label.className = 'elog-menu-label';
      label.textContent = item.label;
      el.appendChild(label);
      // mousedown (not click) + preventDefault(): the standard trick to select an item
      // WITHOUT ever blurring `input` -- see this file's header on why that matters
      // (accept() below needs `input` to still be the focused/live element).
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        accept(item);
      });
      popup!.appendChild(el);
    });
  }

  function position(): void {
    if (!popup) return;
    const rect = input.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom}px`;
    popup.style.minWidth = `${rect.width}px`;
  }

  function open(): void {
    if (popup) return;
    popup = document.createElement('div');
    popup.className = 'elog-menu elog-autocomplete';
    popup.setAttribute('role', 'listbox');
    document.body.appendChild(popup);
    position();
    document.addEventListener('keydown', onDocKeyDown, true);
    document.addEventListener('mousedown', onDocMouseDown, true);
  }

  function close(): void {
    if (!popup) return;
    popup.remove();
    popup = undefined;
    items = [];
    highlighted = -1;
    document.removeEventListener('keydown', onDocKeyDown, true);
    document.removeEventListener('mousedown', onDocMouseDown, true);
  }

  function accept(item: AutocompleteItem): void {
    const value = input.value;
    const newValue = value.slice(0, replaceStart) + item.text + value.slice(replaceEnd);
    input.value = newValue;
    const newCursor = replaceStart + item.text.length;
    input.setSelectionRange(newCursor, newCursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    // Chain immediately into whatever comes next (e.g. accepting "BS " re-opens
    // showing "=~ "/AND/OR) -- standard IDE-autocomplete UX.
    schedule();
  }

  function schedule(): void {
    const cursor = input.selectionStart ?? input.value.length;
    const result = computeProposals(input.value, cursor);
    items = result.items;
    replaceStart = result.replaceStart;
    replaceEnd = result.replaceEnd;
    highlighted = items.length > 0 ? 0 : -1;
    if (items.length === 0) {
      close();
      return;
    }
    open();
    position();
    render();
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    if (!isOpen()) return;
    switch (e.key) {
      case 'ArrowDown':
        highlighted = (highlighted + 1) % items.length;
        render();
        e.preventDefault();
        e.stopPropagation();
        break;
      case 'ArrowUp':
        highlighted = (highlighted - 1 + items.length) % items.length;
        render();
        e.preventDefault();
        e.stopPropagation();
        break;
      case 'Enter':
      case 'Tab':
        // schedule() always leaves `highlighted` at 0 (or closes) whenever items is
        // non-empty, and onDocKeyDown only runs while isOpen() -- so `highlighted` is
        // always a valid index here.
        accept(items[highlighted]);
        e.preventDefault();
        e.stopPropagation();
        break;
      case 'Escape':
        close();
        e.preventDefault();
        e.stopPropagation();
        break;
      default:
        break;
    }
  }

  function onDocMouseDown(e: MouseEvent): void {
    if (!isOpen()) return;
    const target = e.target as Node;
    if (input.contains(target) || popup?.contains(target)) return;
    close();
  }

  const onInput = (): void => schedule();
  const onFocus = (): void => schedule();
  const onClick = (): void => schedule();
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') schedule();
  };
  const onBlur = (): void => {
    // A blur caused by clicking an item never reaches here (the item's mousedown
    // preventDefault() above keeps focus on `input` throughout accept()) -- this only
    // fires for a genuine "focus moved elsewhere" (Tab past the input, clicking
    // another control), where dismissing without accepting is the right call.
    close();
  };

  input.addEventListener('input', onInput);
  input.addEventListener('focus', onFocus);
  input.addEventListener('click', onClick);
  input.addEventListener('keyup', onKeyUp);
  input.addEventListener('blur', onBlur);

  return {
    dispose(): void {
      close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('click', onClick);
      input.removeEventListener('keyup', onKeyUp);
      input.removeEventListener('blur', onBlur);
    },
  };
}
