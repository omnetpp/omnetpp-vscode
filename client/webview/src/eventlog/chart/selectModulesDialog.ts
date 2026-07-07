/**
 * selectModulesDialog.ts (phase U8) — the "Select Modules…" dialog, port of
 * `SequenceChartContributor.createSelectModulesAction()`'s inline `TitleAreaDialog`
 * (`SequenceChartContributor.java:444-491`, read in full): a checkbox `ModuleTreeViewer`
 * over the whole module tree, pre-checked with the CURRENT open axis modules; OK
 * replaces the open set wholesale (`sequenceChart.setOpenAxisModules(checkedItems)`).
 * Title/message strings ported verbatim. The tree widget is the shared tri-state
 * component extracted from the U7 filter panel (`moduleTreeWidget.ts`).
 *
 * The checked-set -> open-set mapping is literal (every checked module is an open
 * module, exactly the set the tri-state propagation produced), returned in module-tree
 * DFS order for determinism (Java returns the viewer's own item order; the ordering
 * strategies applied downstream make the base order irrelevant — see
 * `openAxisModules.ts`'s header).
 */

import type { ElogModule } from '@omnetpp/shared/elog-protocol';
import { openDialogShell } from '../common/dialogs';
import { buildModuleTreeChecklist, collectModuleIds } from './moduleTreeWidget';

export function openSelectModulesDialog(tree: ElogModule | null, currentOpenIds: readonly number[], onOk: (openModuleIds: number[]) => void): void {
  const { panel, close } = openDialogShell('Select open modules');

  const message = document.createElement('div');
  message.className = 'elog-dialog-row';
  message.textContent = 'The sequence chart will have separate axis for the selected modules';
  panel.appendChild(message);

  const treeHost = document.createElement('div');
  treeHost.className = 'elog-filter-moduletree';
  treeHost.style.cssText = 'max-height:50vh;overflow:auto;min-width:320px;margin:6px 0;';
  panel.appendChild(treeHost);

  const checked = new Set<number>(currentOpenIds);
  buildModuleTreeChecklist(treeHost, tree, {
    getCheckedIds: () => checked,
    onToggle: (ids, isChecked) => {
      for (const id of ids) {
        if (isChecked) checked.add(id);
        else checked.delete(id);
      }
    },
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
    // checked set in module-tree DFS order (see this file's header)
    const ordered = tree ? collectModuleIds(tree).filter((id) => checked.has(id)) : [...checked];
    onOk(ordered);
    close();
  });
}
