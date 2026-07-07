/**
 * A generic, codicon-styled toolbar component (`.elog-toolbar`, styled by
 * `webviewHtml.ts`'s shared CSS). Deliberately generic -- U1 only needs a
 * Home/Zoom/Refresh button row + a Timeline Mode dropdown for the chart, and a
 * bare row for the table, but U2-U5 grow this same toolbar with many more
 * stateful buttons/dropdowns (filter toggle, axis-order picker, follow-end
 * toggle, ...), so the API is a declarative item list + an imperative
 * `setButtonState`/`setDropdownValue` escape hatch rather than one-off DOM
 * code per button.
 */

export interface ToolbarButtonSpec {
  id: string;
  /** Codicon name (without the `codicon-` prefix), e.g. `"home"`, `"refresh"`, `"zoom-in"`. */
  icon: string;
  title: string;
  onClick: () => void;
  /** Rendered with the `.active` class (stateful toggle buttons, e.g. a "follow end" pin). */
  toggled?: boolean;
  disabled?: boolean;
}

export interface ToolbarDropdownOption {
  value: string;
  label: string;
}

export interface ToolbarDropdownSpec {
  id: string;
  title: string;
  options: ToolbarDropdownOption[];
  value: string;
  onChange: (value: string) => void;
}

export type ToolbarItemSpec =
  | { kind: 'button'; button: ToolbarButtonSpec }
  | { kind: 'dropdown'; dropdown: ToolbarDropdownSpec }
  | { kind: 'spacer' }
  | { kind: 'separator' };

export interface ToolbarHandle {
  setButtonState(id: string, patch: { disabled?: boolean; toggled?: boolean; title?: string }): void;
  setDropdownValue(id: string, value: string): void;
}

/** (Re)builds `container` as a toolbar from `items`, wiring click/change handlers, and returns a handle for later imperative updates (e.g. disabling "Refresh" while a request is in flight). */
export function buildToolbar(container: HTMLElement, items: ToolbarItemSpec[]): ToolbarHandle {
  container.innerHTML = '';
  container.classList.add('elog-toolbar');
  const buttons = new Map<string, HTMLButtonElement>();
  const dropdowns = new Map<string, HTMLSelectElement>();

  for (const item of items) {
    switch (item.kind) {
      case 'spacer': {
        const el = document.createElement('div');
        el.className = 'spacer';
        container.appendChild(el);
        break;
      }
      case 'separator': {
        const el = document.createElement('div');
        el.style.cssText = 'width:1px;align-self:stretch;margin:2px 4px;background:var(--vscode-editorWidget-border, rgba(128,128,128,0.4));';
        container.appendChild(el);
        break;
      }
      case 'button': {
        const spec = item.button;
        const el = document.createElement('button');
        el.id = spec.id;
        el.title = spec.title;
        el.setAttribute('aria-label', spec.title);
        el.innerHTML = `<span class="codicon codicon-${spec.icon}"></span>`;
        el.disabled = !!spec.disabled;
        el.classList.toggle('active', !!spec.toggled);
        el.addEventListener('click', spec.onClick);
        buttons.set(spec.id, el);
        container.appendChild(el);
        break;
      }
      case 'dropdown': {
        const spec = item.dropdown;
        const el = document.createElement('select');
        el.id = spec.id;
        el.title = spec.title;
        for (const opt of spec.options) {
          const optionEl = document.createElement('option');
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          if (opt.value === spec.value) optionEl.selected = true;
          el.appendChild(optionEl);
        }
        el.addEventListener('change', () => spec.onChange(el.value));
        dropdowns.set(spec.id, el);
        container.appendChild(el);
        break;
      }
    }
  }

  return {
    setButtonState(id, patch) {
      const el = buttons.get(id);
      if (!el) return;
      if (patch.disabled !== undefined) el.disabled = patch.disabled;
      if (patch.toggled !== undefined) el.classList.toggle('active', patch.toggled);
      if (patch.title !== undefined) {
        el.title = patch.title;
        el.setAttribute('aria-label', patch.title);
      }
    },
    setDropdownValue(id, value) {
      const el = dropdowns.get(id);
      if (el) el.value = value;
    },
  };
}
