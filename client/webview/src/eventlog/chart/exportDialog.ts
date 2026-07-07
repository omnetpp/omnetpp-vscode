/**
 * exportDialog.ts (phase U9) -- the "Export to SVG..." range-choice dialog, DOM glue
 * over `svgExport.ts`'s pure `resolveExportRange()`/`exceedsExportWidthCap()`. Port of
 * `ExportToSVGDialog` (`SequenceChartContributor.java:2318-2403`, read in full): three
 * radio buttons (disabled per `isExportRangeAvailable()`, matching Java's own
 * `.setEnabled(sequenceChart.getSelectedEvents().size() == 2)` for the "two selected
 * events" choice) + an "extra space in pixels" field, ADDITIONALLY gated (beyond Java)
 * by a pixel-cap confirmation the port plan's U9 row asks for: a whole-chart (or any
 * other) range whose resolved width exceeds `EXPORT_WIDTH_CAP_PX` disables OK until an
 * explicit "export anyway" checkbox is ticked, so accidentally exporting a multi-
 * million-pixel-wide SVG from a huge log isn't a silent footgun.
 */

import { openDialogShell } from '../common/dialogs';
import {
  computeExportWidthPx,
  EXPORT_WIDTH_CAP_PX,
  exceedsExportWidthCap,
  isExportRangeAvailable,
  resolveExportRange,
  type ExportRangeContext,
  type ExportRangeKind,
} from './svgExport';

export interface ExportDialogResult {
  kind: ExportRangeKind;
  extraSpacePx: number;
}

const RANGE_OPTIONS: [ExportRangeKind, string][] = [
  ['selected', 'Range of two selected events'],
  ['visible', 'Visible area only'],
  ['whole', 'Whole event log'],
];

export function openExportRangeDialog(ctx: ExportRangeContext, onSubmit: (result: ExportDialogResult) => void): void {
  const { panel, close } = openDialogShell('Export to SVG');

  const message = document.createElement('div');
  message.className = 'elog-dialog-row';
  message.textContent = 'Select which part of the sequence chart to export.';
  panel.appendChild(message);

  const group = document.createElement('div');
  group.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:2px 0 8px;';
  panel.appendChild(group);

  let selected: ExportRangeKind = isExportRangeAvailable('visible', ctx) ? 'visible' : isExportRangeAvailable('whole', ctx) ? 'whole' : 'selected';

  for (const [kind, label] of RANGE_OPTIONS) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'elogExportRange';
    input.disabled = !isExportRangeAvailable(kind, ctx);
    input.checked = kind === selected;
    input.addEventListener('change', () => {
      selected = kind;
      revalidate();
    });
    const text = document.createElement('span');
    text.textContent = label;
    row.append(input, text);
    group.appendChild(row);
  }

  const extraRow = document.createElement('div');
  extraRow.className = 'elog-dialog-row';
  const extraLabel = document.createElement('label');
  extraLabel.textContent = 'Extra space (px) around both ends:';
  const extraInput = document.createElement('input');
  extraInput.type = 'text';
  extraInput.value = '10';
  extraRow.append(extraLabel, extraInput);
  panel.appendChild(extraRow);

  const warningEl = document.createElement('div');
  warningEl.className = 'elog-dialog-error';
  panel.appendChild(warningEl);

  const confirmRow = document.createElement('div');
  confirmRow.className = 'elog-dialog-row';
  confirmRow.style.display = 'none';
  const confirmInput = document.createElement('input');
  confirmInput.type = 'checkbox';
  const confirmLabel = document.createElement('label');
  confirmLabel.textContent = 'Export anyway (may be slow, produces a very large file)';
  confirmRow.append(confirmInput, confirmLabel);
  panel.appendChild(confirmRow);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'elog-dialog-buttons';
  const okButton = document.createElement('button');
  okButton.textContent = 'Export...';
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  buttonsRow.append(cancelButton, okButton);
  panel.appendChild(buttonsRow);

  function extraSpacePx(): number {
    const n = Number(extraInput.value.trim());
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 10;
  }

  function revalidate(): void {
    const range = resolveExportRange(selected, { ...ctx, extraSpacePx: extraSpacePx() });
    const exceeds = range !== null && exceedsExportWidthCap(range, ctx.pixelsPerTc);
    confirmRow.style.display = exceeds ? 'flex' : 'none';
    if (exceeds) {
      const widthPx = computeExportWidthPx(range!, ctx.pixelsPerTc);
      warningEl.textContent = `This export would be ~${widthPx.toLocaleString()}px wide (cap: ${EXPORT_WIDTH_CAP_PX.toLocaleString()}px).`;
    } else {
      warningEl.textContent = '';
      confirmInput.checked = false;
    }
    okButton.disabled = range === null || (exceeds && !confirmInput.checked);
  }
  confirmInput.addEventListener('change', revalidate);
  extraInput.addEventListener('input', revalidate);

  okButton.addEventListener('click', () => {
    if (okButton.disabled) return;
    onSubmit({ kind: selected, extraSpacePx: extraSpacePx() });
    close();
  });
  cancelButton.addEventListener('click', close);

  revalidate();
}
