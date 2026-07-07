import type { LogSummary } from '@omnetpp/shared/elog-protocol';

/**
 * Renders a `LogSummary` into the status-strip DOM (`.elog-status`, styled by
 * `webviewHtml.ts`). Shared by `chart/chartMain.ts` and `table/tableMain.ts`
 * so both status strips show identical fields (per the U1 goal: "a status
 * strip with real data (file name, event count range, simtime range)").
 */
export function renderSummaryStrip(container: HTMLElement, fileName: string, summary: LogSummary | null): void {
  container.innerHTML = '';
  container.classList.add('elog-status');
  if (!summary) {
    const placeholder = document.createElement('span');
    placeholder.className = 'placeholder';
    placeholder.textContent = fileName ? `${fileName} — loading…` : 'No event log open.';
    container.appendChild(placeholder);
    return;
  }

  const fields: [string, string][] = [
    ['File', fileName],
    ['Events', summary.isEmpty ? '0' : `${summary.firstEventNumber} – ${summary.lastEventNumber} (${summary.approximateNumberOfEvents.toLocaleString()})`],
    ['Simulation time', summary.isEmpty ? '—' : `${summary.firstSimulationTime} – ${summary.lastSimulationTime}`],
  ];
  if (summary.filtered) fields.push(['Filter', 'active']);

  for (const [label, value] of fields) {
    const span = document.createElement('span');
    span.textContent = `${label}: ${value}`;
    container.appendChild(span);
  }
}
