// Headless smoke test for common/autocompleteDropdown.ts's DOM/event-listener
// behavior (phase U10, the Event Log Table's Custom-filter content-assist popup) --
// specifically the part NO OTHER test in this repo touches: real keydown
// interception (does the dropdown's document-level, capture-phase listener actually
// pre-empt toolbar.ts's own bubble-phase Enter-commit listener, registered on the
// SAME <input> BEFORE attachAutocomplete() is ever called?) and accept-via-click text
// replacement.
//
// Why a standalone script and not a bun:test file: this repo's `bun test` gate
// deliberately keeps DOM-dependent code untested there (see contextMenu.ts's header:
// "Not unit-tested (DOM-dependent, same convention as interactions.ts/canvasStack.ts)"
// -- happy-dom usage elsewhere in this repo, e.g. eventlog-webview-smoke.mjs, is
// always a standalone script for exactly this reason: it registers globals
// (globalThis.document/window/KeyboardEvent/...) that would leak across `bun test`'s
// single shared process if done inside the `bun run test` gate. This script imports
// autocompleteDropdown.ts directly (no bundle/dev:build needed) with a scripted fake
// `computeProposals`, so unlike eventlog-webview-smoke.mjs it needs no worker/session
// at all.
//
// Usage: bun scripts/autocomplete-dropdown-smoke.mjs
import { Window } from 'happy-dom';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

// ---------- DOM environment (scoped to this script's own process) ----------
const win = new Window({ url: 'https://webview.local/' });
globalThis.window = win;
globalThis.document = win.document;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.MouseEvent = win.MouseEvent;
globalThis.Event = win.Event;
globalThis.Node = win.Node;
globalThis.HTMLElement = win.HTMLElement;

const { attachAutocomplete } = await import(resolve(repo, 'client/webview/src/eventlog/common/autocompleteDropdown.ts'));

function popupEl() {
  return win.document.querySelector('.elog-autocomplete');
}

function itemEls() {
  return [...(popupEl()?.querySelectorAll('.elog-menu-item') ?? [])];
}

// A scripted, deterministic proposal source: "B" -> two items ("BS ", "BU "); "" (or
// after accepting one of them) -> no items, so the dropdown closes -- lets tests
// exercise both the "open" and "auto-close" paths without a real grammar/schema.
function computeProposals(text, cursorOffset) {
  if (text.toUpperCase().startsWith('B') && cursorOffset === text.length && text.length <= 2) {
    return {
      replaceStart: 0,
      replaceEnd: cursorOffset,
      items: [
        { text: 'BS ', label: 'BS' },
        { text: 'BU ', label: 'BU' },
      ],
    };
  }
  return { replaceStart: cursorOffset, replaceEnd: cursorOffset, items: [] };
}

function freshInput() {
  const input = win.document.createElement('input');
  input.type = 'text';
  win.document.body.appendChild(input);
  return input;
}

// ---------- 1. opening + accept-via-mousedown replaces [replaceStart, replaceEnd) ----------
{
  const input = freshInput();
  attachAutocomplete(input, computeProposals);

  input.value = 'B';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));

  assert(popupEl() !== null, 'accept-via-click: dropdown opens after typing "B"');
  assert(itemEls().length === 2, `accept-via-click: dropdown shows both proposals, got ${itemEls().length}`);

  // Accept the SECOND item ("BU ") via mousedown (the widget's actual accept path --
  // see autocompleteDropdown.ts's header on why mousedown, not click).
  itemEls()[1].dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  assert(input.value === 'BU ', `accept-via-click: input.value becomes "BU ", got "${input.value}"`);
  assert(input.selectionStart === 3 && input.selectionEnd === 3, `accept-via-click: cursor lands right after the inserted text, got [${input.selectionStart}, ${input.selectionEnd}]`);
  assert(popupEl() === null, 'accept-via-click: dropdown closes once the (post-accept) proposal list is empty');
}

// ---------- 2. keydown preemption: Enter while open must NOT reach a competing ----------
// ---------- bubble-phase listener registered on the input BEFORE attachAutocomplete ----
{
  const input = freshInput();
  let competingFired = 0;
  // Registered FIRST, mirroring toolbar.ts's own keydown listener, which is wired
  // onto the <input> by buildToolbar() BEFORE tableView.ts ever calls
  // attachAutocomplete() on that same element.
  input.addEventListener('keydown', () => {
    competingFired++;
  });

  attachAutocomplete(input, computeProposals);

  // Positive control FIRST (dropdown closed): a keydown must reach the competing
  // listener normally -- proves this harness can actually observe propagation at all,
  // so a later "did not fire" assertion means something.
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  assert(competingFired === 1, `keydown preemption: positive control -- a keydown with the dropdown CLOSED reaches the competing listener normally, got ${competingFired} calls`);
  competingFired = 0;

  input.value = 'B';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert(popupEl() !== null, 'keydown preemption: dropdown is open before the Enter test');

  const enterEvent = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(enterEvent);

  assert(competingFired === 0, `keydown preemption: Enter while the dropdown is OPEN must be intercepted (document capture-phase stopPropagation) before it ever reaches the input's own bubble-phase listener -- got ${competingFired} calls (toolbar.ts's real Enter-commit handler would otherwise have fired with a stale, pre-accept value)`);
  assert(input.value === 'BS ', `keydown preemption: Enter accepted the highlighted (first, index 0) item, got "${input.value}"`);
}

// ---------- 3. ArrowDown/ArrowUp navigate the highlighted item ----------
{
  const input = freshInput();
  attachAutocomplete(input, computeProposals);
  input.value = 'B';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));

  assert(itemEls()[0].classList.contains('highlighted'), 'ArrowDown/Up: item 0 is highlighted by default when the dropdown opens');
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert(itemEls()[1].classList.contains('highlighted'), 'ArrowDown/Up: ArrowDown moves the highlight to item 1');
  assert(!itemEls()[0].classList.contains('highlighted'), 'ArrowDown/Up: item 0 is no longer highlighted');
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert(itemEls()[0].classList.contains('highlighted'), 'ArrowDown/Up: ArrowDown from the last item wraps back to item 0');
}

// ---------- 4. Escape closes without accepting ----------
{
  const input = freshInput();
  attachAutocomplete(input, computeProposals);
  input.value = 'B';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert(popupEl() !== null, 'Escape: dropdown is open before Escape');

  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert(popupEl() === null, 'Escape: dropdown closes');
  assert(input.value === 'B', 'Escape: input value is unchanged (nothing accepted)');
}

// ---------- 5. an outside mousedown closes the dropdown ----------
{
  const input = freshInput();
  attachAutocomplete(input, computeProposals);
  input.value = 'B';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert(popupEl() !== null, 'outside click: dropdown is open beforehand');

  win.document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert(popupEl() === null, 'outside click: dropdown closes on a mousedown outside both the input and the popup');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nautocomplete-dropdown-smoke PASSED');
}
