/**
 * reorderDialog.ts (phase U8) — the "Manual Axis Ordering" list-reorder dialog, port
 * of `ListReorderDialog.java` as used by `ManualAxisOrder.showManualOrderDialog()`
 * (both read in full): a selectable list of the CURRENT visible axes (labeled
 * `"<fullPath> (id = <n>)"`, Java's exact label format) with Up / Down / Top / Bottom
 * buttons and a "Revert to original" reset. OK hands the reordered id list back; the
 * caller splices it into the persistent manual order (`axisOrder.ts`'s
 * `updateManualOrder()`) — Cancel changes nothing (and, per
 * `SequenceChartContributor`'s "Manual..." radio handler, the caller must NOT switch
 * the ordering mode on cancel).
 */

import { openDialogShell } from '../common/dialogs';

export interface ReorderItem {
  id: number;
  label: string;
}

export function openListReorderDialog(title: string, message: string, items: readonly ReorderItem[], onOk: (orderedIds: number[]) => void): void {
  const { panel, close } = openDialogShell(title);

  const messageEl = document.createElement('div');
  messageEl.className = 'elog-dialog-row';
  messageEl.textContent = message;
  panel.appendChild(messageEl);

  const body = document.createElement('div');
  body.style.cssText = 'display:flex;gap:8px;margin:6px 0;';
  panel.appendChild(body);

  const listEl = document.createElement('div');
  listEl.setAttribute('role', 'listbox');
  listEl.style.cssText = 'flex:1;min-width:320px;max-height:50vh;overflow:auto;border:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,0.4));';
  body.appendChild(listEl);

  const buttonsCol = document.createElement('div');
  buttonsCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  body.appendChild(buttonsCol);

  let order = [...items];
  let selectedIndex = -1;

  function renderList(): void {
    listEl.innerHTML = '';
    order.forEach((item, index) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.textContent = item.label;
      row.style.cssText = 'padding:2px 6px;cursor:pointer;white-space:nowrap;';
      if (index === selectedIndex) {
        row.style.background = 'var(--vscode-list-activeSelectionBackground,#04395e)';
        row.style.color = 'var(--vscode-list-activeSelectionForeground,#ffffff)';
      }
      row.addEventListener('click', () => {
        selectedIndex = index;
        renderList();
      });
      listEl.appendChild(row);
    });
  }

  function moveSelected(toIndex: number): void {
    if (selectedIndex < 0 || toIndex < 0 || toIndex >= order.length || toIndex === selectedIndex) return;
    const [item] = order.splice(selectedIndex, 1);
    order.splice(toIndex, 0, item);
    selectedIndex = toIndex;
    renderList();
  }

  const sideButton = (label: string, onClick: () => void): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    buttonsCol.appendChild(b);
  };
  sideButton('Top', () => moveSelected(0));
  sideButton('Up', () => moveSelected(selectedIndex - 1));
  sideButton('Down', () => moveSelected(selectedIndex + 1));
  sideButton('Bottom', () => moveSelected(order.length - 1));
  sideButton('Revert', () => {
    order = [...items];
    renderList();
  });

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'elog-dialog-buttons';
  const okButton = document.createElement('button');
  okButton.textContent = 'OK';
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  buttonsRow.appendChild(cancelButton);
  buttonsRow.appendChild(okButton);
  panel.appendChild(buttonsRow);

  cancelButton.addEventListener('click', close);
  okButton.addEventListener('click', () => {
    onOk(order.map((item) => item.id));
    close();
  });

  renderList();
}
