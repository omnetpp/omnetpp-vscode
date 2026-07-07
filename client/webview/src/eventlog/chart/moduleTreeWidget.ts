/**
 * moduleTreeWidget.ts (phase U8) — a reusable tri-state module checkbox tree,
 * EXTRACTED from `filterPanel.ts`'s previously-inline `moduleTreeWidget()` closure
 * (deliberate refactor over copy-paste: the U8 "Select Modules…" dialog needs the
 * exact same widget over a different checked-set/state owner, so the DOM builder now
 * takes `(tree, getCheckedIds, onCheckedChange)` instead of closing over the filter
 * panel's state). Tri-state semantics unchanged: standard "container checked"
 * propagation — checking a compound module checks its whole subtree; a parent shows
 * indeterminate when only some of its subtree is checked (the JFace
 * `ContainerCheckedTreeViewer` behavior both Java dialogs — the filter dialog's "by
 * module" tree AND `SelectModules`' open-axis-modules tree — build on).
 *
 * The tri-state helpers are PURE (unit-tested via the filter suite); only
 * `buildModuleTreeChecklist()` touches the DOM.
 */

import type { ElogModule } from '@omnetpp/shared/elog-protocol';

export function collectModuleIds(node: ElogModule, into: number[] = []): number[] {
  into.push(node.moduleId);
  for (const child of node.children) collectModuleIds(child, into);
  return into;
}

export function moduleTriState(node: ElogModule, checked: ReadonlySet<number>): { checked: boolean; indeterminate: boolean } {
  if (node.children.length === 0) return { checked: checked.has(node.moduleId), indeterminate: false };
  const childStates = node.children.map((c) => moduleTriState(c, checked));
  const selfChecked = checked.has(node.moduleId);
  const allChecked = selfChecked && childStates.every((s) => s.checked);
  const anyChecked = selfChecked || childStates.some((s) => s.checked || s.indeterminate);
  if (allChecked) return { checked: true, indeterminate: false };
  return { checked: false, indeterminate: anyChecked };
}

export interface ModuleTreeChecklistDeps {
  /** The CURRENT checked module-id set (read fresh on every render). */
  getCheckedIds(): ReadonlySet<number>;
  /** Fired when a checkbox toggles: `ids` is the toggled node's whole subtree, `checked` the new state. The owner updates its set and this widget re-renders itself. */
  onToggle(ids: readonly number[], checked: boolean): void;
  /** Row label; defaults to `"fullName (nedTypeName)"` (the filter panel's format). */
  labelOf?(node: ElogModule): string;
}

/**
 * Renders (or re-renders) the tri-state module checkbox tree into `container`.
 * Returns a `rerender` function the owner calls after mutating its checked set.
 */
export function buildModuleTreeChecklist(container: HTMLElement, tree: ElogModule | null, deps: ModuleTreeChecklistDeps): () => void {
  const labelOf = deps.labelOf ?? ((node: ElogModule) => `${node.fullName} (${node.nedTypeName})`);

  function render(): void {
    container.innerHTML = '';
    if (!tree) {
      const empty = document.createElement('div');
      empty.className = 'elog-filter-hint-empty';
      empty.textContent = '(module tree not loaded yet)';
      container.appendChild(empty);
      return;
    }
    const checkedIds = deps.getCheckedIds();

    function renderNode(node: ElogModule, depth: number): HTMLElement {
      const row = document.createElement('div');
      row.className = 'elog-filter-moduletree-row';
      row.style.paddingLeft = `${depth * 14}px`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const triState = moduleTriState(node, checkedIds);
      checkbox.checked = triState.checked;
      checkbox.indeterminate = triState.indeterminate;
      checkbox.addEventListener('change', () => {
        deps.onToggle(collectModuleIds(node), checkbox.checked);
        render();
      });
      const label = document.createElement('span');
      label.textContent = labelOf(node);
      row.appendChild(checkbox);
      row.appendChild(label);
      const wrapper = document.createElement('div');
      wrapper.appendChild(row);
      for (const child of node.children) wrapper.appendChild(renderNode(child, depth + 1));
      return wrapper;
    }
    container.appendChild(renderNode(tree, 0));
  }

  render();
  return render;
}
