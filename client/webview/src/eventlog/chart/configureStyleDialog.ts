/**
 * configureStyleDialog.ts -- the "Configure Style" dialog, port of
 * `ConfigureStyleDialog.java` (`omnetpp-dev/ui/org.omnetpp.sequencechart/src/org/
 * omnetpp/sequencechart/widgets/ConfigureStyleDialog.java`, read in full -- see
 * `shared/src/eventlog/styleRules.ts`'s header for the exact model/semantics this
 * ports, verified against the Java source, not assumed).
 *
 * Java's shape: a `CheckboxTreeViewer` with one "Coloring" root plus six leaf nodes
 * (Axes / Axis headers / Events / Self events / Message sends / Method calls), each
 * leaf showing its own `TableViewer` (two free-text columns -- Expression, Colors --
 * both plain `TextCellEditor`s, no picker) with Add/Remove/Top/Up/Down/Bottom buttons.
 * This port collapses the tree-of-panels into a simple TAB STRIP (one button per
 * category, only the active category's table shown) -- functionally identical
 * (six independently-manageable ordered rule lists, each individually enable-able),
 * just without replicating SWT's specific `CheckboxTreeViewer` widget. Follows this
 * codebase's established list-editing precedent, `reorderDialog.ts`'s
 * `openListReorderDialog()` (selection + Top/Up/Down/Bottom side buttons), extended
 * with Add/Remove (reorderDialog's list is fixed-membership; this one lets rules be
 * created/deleted) and per-row pattern/colors text inputs (reorderDialog's rows are
 * read-only labels; these are editable, matching Java's inline `TextCellEditor`s).
 *
 * ADAPTATION (documented deviation): Java's "Colors" column is a bare text cell (no
 * color picker at all -- verified by reading the dialog's `EditingSupport`s). This
 * port keeps that same free-text field (so typing `"light"`/`"dark"`/`"red, blue"`
 * still works exactly as in Java) but ALSO adds a small native `<input type="color">`
 * swatch button next to it purely as an entry aid -- picking a color appends its
 * `#rrggbb` hex to the text field rather than replacing Java's semantics with a
 * single-color-only picker. This is the "check what color-input mechanism this
 * webview already uses elsewhere" question the task brief raises: there wasn't one
 * (no existing color-picker widget anywhere in this codebase) -- a plain
 * CSP-safe `<input type="color">` is the reasonable web-native adaptation.
 *
 * Not unit-tested (DOM-only glue, same convention as `reorderDialog.ts`/
 * `customNonlinearDialog.ts`/`dialogs.ts`'s prompt UI) -- the pure rule model +
 * evaluator it edits (`StyleRuleSettings`/`StyleRuleResolver`) is thoroughly tested in
 * `shared/src/test/eventlog/styleRules.test.ts`.
 */

import { defaultStyleRuleSettings, STYLE_CATEGORIES, type StyleCategory, type StyleCategorySettings, type StyleRule, type StyleRuleSettings } from '@omnetpp/shared/style-rules';
import { openDialogShell } from '../common/dialogs';

function cloneCategorySettings(settings: StyleCategorySettings | undefined): StyleCategorySettings {
  return { enabled: settings?.enabled ?? false, rules: (settings?.rules ?? []).map((r) => ({ ...r })) };
}

function cloneSettings(settings: StyleRuleSettings): StyleRuleSettings {
  const result = defaultStyleRuleSettings();
  for (const { id } of STYLE_CATEGORIES) result[id] = cloneCategorySettings(settings[id]);
  return result;
}

/**
 * Opens the six-category style-rule editor seeded with `initial`. `onSubmit` fires
 * once, only on OK, with the FULL edited `StyleRuleSettings` (all six categories,
 * whether or not they were visited/changed) -- Cancel/Escape/outside-click discard the
 * in-progress edits entirely (matches Java: `ConfigureStyleDialog.okPressed()` is the
 * only path that writes back to `SequenceChartSettings`).
 */
export function openConfigureStyleDialog(initial: StyleRuleSettings, onSubmit: (settings: StyleRuleSettings) => void): void {
  const working = cloneSettings(initial);
  const selectedIndex: Record<StyleCategory, number> = { axes: -1, axisHeaders: -1, events: -1, selfEvents: -1, messageSends: -1, methodCalls: -1 };
  let activeCategory: StyleCategory = STYLE_CATEGORIES[0].id;

  const { panel, close } = openDialogShell('Configure Style');

  const messageEl = document.createElement('div');
  messageEl.className = 'elog-dialog-row';
  messageEl.textContent = 'Per-module/message/method-name pattern rules override the chart\'s default colors. Rules are tried top to bottom; the first matching pattern wins.';
  panel.appendChild(messageEl);

  const tabsRow = document.createElement('div');
  tabsRow.style.cssText = 'display:flex;gap:2px;margin:6px 0;flex-wrap:wrap;';
  panel.appendChild(tabsRow);

  const bodyEl = document.createElement('div');
  panel.appendChild(bodyEl);

  const tabButtons = new Map<StyleCategory, HTMLButtonElement>();
  for (const { id, label } of STYLE_CATEGORIES) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      activeCategory = id;
      renderBody();
    });
    tabsRow.appendChild(b);
    tabButtons.set(id, b);
  }

  function updateTabStyles(): void {
    for (const [id, b] of tabButtons) {
      const isActive = id === activeCategory;
      b.style.fontWeight = isActive ? 'bold' : 'normal';
      b.style.textDecoration = isActive ? 'underline' : 'none';
    }
  }

  function moveRule(category: StyleCategory, toIndex: number): void {
    const rules = working[category].rules;
    const from = selectedIndex[category];
    if (from < 0 || toIndex < 0 || toIndex >= rules.length || toIndex === from) return;
    const [rule] = rules.splice(from, 1);
    rules.splice(toIndex, 0, rule);
    selectedIndex[category] = toIndex;
    renderBody();
  }

  function renderBody(): void {
    updateTabStyles();
    bodyEl.innerHTML = '';
    const category = activeCategory;
    const catSettings = working[category];

    const enableRow = document.createElement('div');
    enableRow.className = 'elog-dialog-row';
    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.checked = catSettings.enabled;
    enableCheckbox.id = `elog-style-enable-${category}`;
    enableCheckbox.addEventListener('change', () => {
      catSettings.enabled = enableCheckbox.checked;
    });
    const enableLabel = document.createElement('label');
    enableLabel.textContent = ' Enable coloring for this category';
    enableLabel.htmlFor = enableCheckbox.id;
    enableRow.appendChild(enableCheckbox);
    enableRow.appendChild(enableLabel);
    bodyEl.appendChild(enableRow);

    const tableArea = document.createElement('div');
    tableArea.style.cssText = 'display:flex;gap:8px;margin:6px 0;';
    bodyEl.appendChild(tableArea);

    const listEl = document.createElement('div');
    listEl.setAttribute('role', 'listbox');
    listEl.style.cssText = 'flex:1;min-width:420px;max-height:40vh;overflow:auto;border:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,0.4));';
    tableArea.appendChild(listEl);

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;gap:4px;padding:2px 4px;font-weight:bold;border-bottom:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,0.4));';
    const patternHeader = document.createElement('div');
    patternHeader.textContent = 'Expression';
    patternHeader.style.cssText = 'flex:1;';
    const colorsHeader = document.createElement('div');
    colorsHeader.textContent = 'Colors';
    colorsHeader.style.cssText = 'flex:1;';
    headerRow.appendChild(patternHeader);
    headerRow.appendChild(colorsHeader);
    listEl.appendChild(headerRow);

    catSettings.rules.forEach((rule: StyleRule, index: number) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;padding:2px 4px;';
      if (index === selectedIndex[category]) {
        row.style.background = 'var(--vscode-list-activeSelectionBackground,#04395e)';
      }
      row.addEventListener('mousedown', (e) => {
        // Selecting the row (for Top/Up/Down/Bottom) must not steal focus from the
        // pattern/colors inputs, and -- critically -- must not swallow the per-row
        // Remove (✕) button's click: `renderBody()` replaces `bodyEl.innerHTML`
        // synchronously, so if this fired on the button's own `mousedown` the button
        // would already be detached by the time `mouseup`/`click` would otherwise fire
        // on it, silently no-op'ing Remove. Only re-select on a plain background/label
        // click -- anything landing on an `<input>` or `<button>` inside the row is
        // left alone.
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
        selectedIndex[category] = index;
        renderBody();
      });

      const patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.value = rule.pattern;
      patternInput.placeholder = 'e.g. "node*" or c =~ "TicMsg"';
      patternInput.style.cssText = 'flex:1;';
      patternInput.addEventListener('input', () => {
        rule.pattern = patternInput.value;
      });

      const colorsInput = document.createElement('input');
      colorsInput.type = 'text';
      colorsInput.value = rule.colors;
      colorsInput.placeholder = 'e.g. red, #00ff00, light, dark';
      colorsInput.style.cssText = 'flex:1;';
      colorsInput.addEventListener('input', () => {
        rule.colors = colorsInput.value;
      });

      // Convenience color-picker swatch (see this file's header ADAPTATION note) --
      // appends the picked color to the Colors text field rather than replacing it.
      const colorPicker = document.createElement('input');
      colorPicker.type = 'color';
      colorPicker.title = 'Pick a color to add to the list';
      colorPicker.style.cssText = 'width:24px;height:22px;padding:0;border:none;';
      colorPicker.addEventListener('input', () => {
        const picked = colorPicker.value;
        colorsInput.value = colorsInput.value.trim().length > 0 ? `${colorsInput.value.trim()}, ${picked}` : picked;
        rule.colors = colorsInput.value;
      });

      const removeButton = document.createElement('button');
      removeButton.textContent = '✕';
      removeButton.title = 'Remove this rule';
      removeButton.addEventListener('click', () => {
        catSettings.rules.splice(index, 1);
        if (selectedIndex[category] >= catSettings.rules.length) selectedIndex[category] = catSettings.rules.length - 1;
        renderBody();
      });

      row.appendChild(patternInput);
      row.appendChild(colorsInput);
      row.appendChild(colorPicker);
      row.appendChild(removeButton);
      listEl.appendChild(row);
    });

    const buttonsCol = document.createElement('div');
    buttonsCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    tableArea.appendChild(buttonsCol);

    const sideButton = (label: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', onClick);
      buttonsCol.appendChild(b);
    };
    sideButton('Add', () => {
      catSettings.rules.push({ pattern: '', colors: '' });
      selectedIndex[category] = catSettings.rules.length - 1;
      renderBody();
    });
    sideButton('Remove', () => {
      const i = selectedIndex[category];
      if (i < 0) return;
      catSettings.rules.splice(i, 1);
      selectedIndex[category] = Math.min(i, catSettings.rules.length - 1);
      renderBody();
    });
    sideButton('Top', () => moveRule(category, 0));
    sideButton('Up', () => moveRule(category, selectedIndex[category] - 1));
    sideButton('Down', () => moveRule(category, selectedIndex[category] + 1));
    sideButton('Bottom', () => moveRule(category, catSettings.rules.length - 1));
  }

  renderBody();

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'elog-dialog-buttons';
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  const okButton = document.createElement('button');
  okButton.textContent = 'OK';
  buttonsRow.appendChild(cancelButton);
  buttonsRow.appendChild(okButton);
  panel.appendChild(buttonsRow);

  cancelButton.addEventListener('click', close);
  okButton.addEventListener('click', () => {
    onSubmit(working);
    close();
  });
}
