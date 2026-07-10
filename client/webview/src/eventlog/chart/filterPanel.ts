/**
 * filterPanel.ts -- the U7 in-webview Filter panel: a collapsible right-side overlay
 * over the Sequence Chart canvas (decision record: "In-webview collapsible filter panel
 * replicating FilterEventLogDialog"). DOM-only (like `interactions.ts`/`canvasStack.ts`/
 * `contextMenu.ts`/`dialogs.ts` -- not unit-tested; the pure logic it drives
 * (`filterPanelState.ts`/`filterDescription.ts`) is unit-tested instead).
 *
 * Layout simplification vs. `FilterEventLogDialog.java`'s two-pane (left checkbox-tree
 * navigator, right stacked detail panel, one page visible at a time) modal dialog: a
 * narrow side panel has no room for a wide two-pane layout, so this port uses a
 * single-column list of collapsible sections instead -- each section is its own
 * checkbox + inline field group, expanded exactly when its checkbox is checked (no
 * separate "select a tree node to see its page" navigation step). Every field/section
 * from `FilterPanelState` is present -- see that file's header for the two sections
 * merged (module "by name"+"by ID" -> one tree) and one added (module "by class name")
 * relative to Java's own 14 leaves.
 *
 * Section order matches `FILTER_SECTION_ORDER` (== Java's own top-to-bottom tree order).
 */

import type { ElogModule, FilterHints } from '@omnetpp/shared/elog-protocol';
import { buildFilterDescription } from './filterDescription';
import { buildModuleTreeChecklist } from './moduleTreeWidget';
import {
  applyExcludedEventNumbersToState,
  buildFilterParams,
  DEFAULT_FILTER_PANEL_STATE,
  isAnyFilterActive,
  mergeFilterPanelState,
  type FilterPanelState,
  type FilterSectionFlags,
} from './filterPanelState';

export interface FilterPanelDeps {
  /** Apply the currently-built (non-null, `isAnyFilterActive()` already true) params. */
  onApply(): void;
  /** "Remove Filter" -- equivalent to applying `null`. */
  onRemove(): void;
  onClose(): void;
  /** Fired on every state mutation (checkbox/field edit) -- caller persists it (`stateChanged`, mirrors `displayFlags.ts`'s pattern). */
  onStateChange(state: FilterPanelState): void;
  /** The panel just became visible for the first time this session (or the module tree/hints weren't loaded yet) -- caller should kick off `elog/getModuleTree`/`elog/getFilterHints` if it hasn't already, then call `setModuleTree()`/`setFilterHints()`. */
  requestData(): void;
}

export interface FilterPanelHandle {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  getState(): FilterPanelState;
  /** Replaces the whole state (e.g. rehydrating persisted state on `init`) and re-renders. */
  setState(state: FilterPanelState): void;
  /** Applies a patch function (e.g. a context-menu "Filter Causes/Consequences.../Filter Message..." prefill) and opens the panel so the user sees what was pre-filled. */
  prefillAndOpen(patch: (state: FilterPanelState) => FilterPanelState): void;
  setModuleTree(tree: ElogModule | null): void;
  setFilterHints(hints: FilterHints | null): void;
  /** Toggles the Apply/Remove/Cancel busy state (`elog/setFilter` in flight). */
  setBusy(busy: boolean, onCancel?: () => void): void;
  /** ADDITIVE (phase U7): called on every `elog/progress` notification received while busy -- ticks the busy label so a long-running filter visibly shows liveness (`ElogProgressParams` carries no percentage to show a real bar with). No-op if not currently busy. */
  tickBusy(): void;
  /** Reflects `LogSummary.filtered` -- enables/disables "Remove Filter". */
  setFiltered(filtered: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------
// small parsing helpers (comma-separated id lists, per the phase brief)
// ---------------------------------------------------------------------------------

function parseNumberList(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n));
}

function formatNumberList(numbers: number[]): string {
  return numbers.join(', ');
}

function parseNullableInt(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ---------------------------------------------------------------------------------
// module tree tri-state widget: extracted to `moduleTreeWidget.ts` in phase U8 so the
// "Select Modules…" dialog reuses the exact same component (see that file's header).
// ---------------------------------------------------------------------------------
// DOM builder
// ---------------------------------------------------------------------------------

export function buildFilterPanel(parent: HTMLElement, deps: FilterPanelDeps): FilterPanelHandle {
  let state: FilterPanelState = DEFAULT_FILTER_PANEL_STATE;
  let moduleTree: ElogModule | null = null;
  let hints: FilterHints | null = null;
  let open = false;
  let dataRequested = false;

  const root = document.createElement('div');
  root.className = 'elog-filter-panel';
  root.style.display = 'none';
  parent.appendChild(root);

  const header = document.createElement('div');
  header.className = 'elog-filter-panel-header';
  header.innerHTML = '<span class="elog-filter-panel-title">Filter Event Log</span>';
  const closeButton = document.createElement('button');
  closeButton.className = 'elog-filter-panel-close';
  closeButton.title = 'Close (Esc)';
  closeButton.innerHTML = '<span class="codicon codicon-close"></span>';
  closeButton.addEventListener('click', () => handle.close());
  header.appendChild(closeButton);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'elog-filter-panel-body';
  root.appendChild(body);

  const descriptionEl = document.createElement('div');
  descriptionEl.className = 'elog-filter-description';

  const busyRow = document.createElement('div');
  busyRow.className = 'elog-filter-busy';
  busyRow.style.display = 'none';
  const busyLabel = document.createElement('span');
  busyLabel.textContent = 'Applying filter…';
  let busyTicks = 0;
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  busyRow.appendChild(busyLabel);
  busyRow.appendChild(cancelButton);

  const footer = document.createElement('div');
  footer.className = 'elog-filter-panel-footer';
  const applyButton = document.createElement('button');
  applyButton.textContent = 'Apply';
  applyButton.className = 'primary';
  applyButton.addEventListener('click', () => {
    if (isAnyFilterActive(state) && buildFilterParams(state) !== null) deps.onApply();
  });
  const removeButton = document.createElement('button');
  removeButton.textContent = 'Remove Filter';
  removeButton.addEventListener('click', () => deps.onRemove());
  const closeFooterButton = document.createElement('button');
  closeFooterButton.textContent = 'Close';
  closeFooterButton.addEventListener('click', () => handle.close());
  footer.appendChild(removeButton);
  footer.appendChild(closeFooterButton);
  footer.appendChild(applyButton);

  function notifyChanged(): void {
    deps.onStateChange(state);
    renderDescription();
    updateApplyEnabled();
  }

  function updateApplyEnabled(): void {
    applyButton.disabled = !(isAnyFilterActive(state) && buildFilterParams(state) !== null);
  }

  function resolveModuleName(id: number): string | null {
    return findModuleById(moduleTree, id)?.fullName ?? null;
  }

  function renderDescription(): void {
    descriptionEl.textContent = buildFilterDescription(state, resolveModuleName);
  }

  function setFlag<K extends keyof FilterSectionFlags>(key: K, value: boolean): void {
    state = { ...state, enabled: { ...state.enabled, [key]: value } };
    render();
    notifyChanged();
  }

  function setField<K extends keyof FilterPanelState>(key: K, value: FilterPanelState[K]): void {
    state = { ...state, [key]: value };
    notifyChanged();
  }

  // ---- generic small-field builders --------------------------------------------------

  function sectionHeader(container: HTMLElement, key: keyof FilterSectionFlags, label: string): HTMLInputElement {
    const row = document.createElement('div');
    row.className = 'elog-filter-section-header';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.enabled[key];
    checkbox.addEventListener('change', () => setFlag(key, checkbox.checked));
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.addEventListener('click', () => checkbox.click());
    row.appendChild(checkbox);
    row.appendChild(labelEl);
    container.appendChild(row);
    return checkbox;
  }

  function fieldRow(container: HTMLElement, label: string, input: HTMLElement): void {
    const row = document.createElement('div');
    row.className = 'elog-filter-field-row';
    if (label.length > 0) {
      const labelEl = document.createElement('label');
      labelEl.textContent = label;
      row.appendChild(labelEl);
    }
    row.appendChild(input);
    container.appendChild(row);
  }

  function numberInput(value: number | null, onChange: (v: number | null) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'elog-filter-input-number';
    input.value = value === null ? '' : String(value);
    input.placeholder = '(none)';
    input.addEventListener('change', () => onChange(parseNullableInt(input.value)));
    return input;
  }

  function textInput(value: string, placeholder: string, datalistId: string | undefined, onChange: (v: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'elog-filter-input-text';
    input.value = value;
    input.placeholder = placeholder;
    if (datalistId) input.setAttribute('list', datalistId);
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  function commaListInput(values: number[], onChange: (v: number[]) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'elog-filter-input-text';
    input.value = formatNumberList(values);
    input.placeholder = 'e.g. 12, 34, 56';
    input.addEventListener('change', () => onChange(parseNumberList(input.value)));
    return input;
  }

  function checkboxField(checked: boolean, label: string, onChange: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'elog-filter-field-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.addEventListener('click', () => checkbox.click());
    row.appendChild(checkbox);
    row.appendChild(labelEl);
    return row;
  }

  function multiSelectList(options: string[], selected: string[], onChange: (v: string[]) => void): HTMLElement {
    const list = document.createElement('div');
    list.className = 'elog-filter-multiselect';
    if (options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'elog-filter-hint-empty';
      empty.textContent = '(none encountered so far)';
      list.appendChild(empty);
      return list;
    }
    const selectedSet = new Set(selected);
    for (const option of options) {
      const row = document.createElement('label');
      row.className = 'elog-filter-multiselect-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedSet.has(option);
      checkbox.addEventListener('change', () => {
        const next = new Set(selectedSet);
        if (checkbox.checked) next.add(option);
        else next.delete(option);
        onChange([...next]);
      });
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(option));
      list.appendChild(row);
    }
    return list;
  }

  function moduleTreeWidget(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'elog-filter-moduletree';
    buildModuleTreeChecklist(container, moduleTree, {
      getCheckedIds: () => new Set(state.moduleIds),
      onToggle: (ids, checked) => {
        const next = new Set(state.moduleIds);
        for (const id of ids) {
          if (checked) next.add(id);
          else next.delete(id);
        }
        setField('moduleIds', [...next]);
        render();
      },
    });
    return container;
  }

  function datalist(id: string, values: string[]): HTMLElement {
    const el = document.createElement('datalist');
    el.id = id;
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      el.appendChild(opt);
    }
    return el;
  }

  // ---- section builders (order matches FILTER_SECTION_ORDER / Java's own tree) ------

  function buildCollectionLimitsSection(container: HTMLElement): void {
    sectionHeader(container, 'collectionLimits', 'Collection limits');
    const detail = document.createElement('div');
    detail.className = 'elog-filter-section-detail';
    detail.appendChild(checkboxField(state.collectMessageReuses, 'Collect message reuse dependencies', (v) => setField('collectMessageReuses', v)));
    fieldRow(detail, 'Maximum depth of message dependencies:', numberInput(state.maximumDepth, (v) => setField('maximumDepth', v ?? DEFAULT_FILTER_PANEL_STATE.maximumDepth)));
    fieldRow(detail, 'Maximum number of message dependencies:', numberInput(state.maximumNumber, (v) => setField('maximumNumber', v ?? DEFAULT_FILTER_PANEL_STATE.maximumNumber)));
    fieldRow(detail, 'Maximum collection time (ms):', numberInput(state.maximumCollectionTimeMs, (v) => setField('maximumCollectionTimeMs', v ?? DEFAULT_FILTER_PANEL_STATE.maximumCollectionTimeMs)));
    container.appendChild(detail);
  }

  function buildRangeSection(container: HTMLElement): void {
    sectionHeader(container, 'rangeEventNumbers', 'Range filter (by event numbers)');
    const eventNumberDetail = document.createElement('div');
    eventNumberDetail.className = 'elog-filter-section-detail';
    fieldRow(eventNumberDetail, 'Lower event number limit:', numberInput(state.firstConsideredEventNumber, (v) => setField('firstConsideredEventNumber', v)));
    fieldRow(eventNumberDetail, 'Upper event number limit:', numberInput(state.lastConsideredEventNumber, (v) => setField('lastConsideredEventNumber', v)));
    container.appendChild(eventNumberDetail);

    sectionHeader(container, 'rangeSimulationTime', 'Range filter (by simulation time)');
    const simTimeDetail = document.createElement('div');
    simTimeDetail.className = 'elog-filter-section-detail';
    fieldRow(simTimeDetail, 'Lower simulation time limit:', textInput(state.lowerSimulationTimeLimit, '(none)', undefined, (v) => setField('lowerSimulationTimeLimit', v)));
    fieldRow(simTimeDetail, 'Upper simulation time limit:', textInput(state.upperSimulationTimeLimit, '(none)', undefined, (v) => setField('upperSimulationTimeLimit', v)));
    container.appendChild(simTimeDetail);
  }

  function buildEventFilterSection(container: HTMLElement): void {
    sectionHeader(container, 'excludedEventNumbers', 'Event filter (exclude by event number)');
    const detail = document.createElement('div');
    detail.className = 'elog-filter-section-detail';
    fieldRow(detail, 'Excluded event numbers:', commaListInput(state.excludedEventNumbers, (v) => setField('excludedEventNumbers', v)));
    container.appendChild(detail);
  }

  function buildModuleFilterSection(container: HTMLElement): void {
    const group = document.createElement('div');
    group.className = 'elog-filter-group';
    const groupTitle = document.createElement('div');
    groupTitle.className = 'elog-filter-group-title';
    groupTitle.textContent = 'Module filter';
    group.appendChild(groupTitle);

    sectionHeader(group, 'moduleExpression', 'by expression');
    const exprDetail = document.createElement('div');
    exprDetail.className = 'elog-filter-section-detail';
    const exprListId = 'elog-filter-module-expr-hints';
    fieldRow(exprDetail, 'Expression:', textInput(state.moduleExpression, 'e.g. className(Fifo)', exprListId, (v) => setField('moduleExpression', v)));
    exprDetail.appendChild(datalist(exprListId, [...(hints?.moduleClassNames ?? []), ...(hints?.moduleNedTypeNames ?? [])]));
    group.appendChild(exprDetail);

    sectionHeader(group, 'moduleNedType', 'by NED type');
    const nedDetail = document.createElement('div');
    nedDetail.className = 'elog-filter-section-detail';
    nedDetail.appendChild(multiSelectList(hints?.moduleNedTypeNames ?? [], state.moduleNedTypeNames, (v) => setField('moduleNedTypeNames', v)));
    group.appendChild(nedDetail);

    sectionHeader(group, 'moduleTree', 'by module (tree)');
    const treeDetail = document.createElement('div');
    treeDetail.className = 'elog-filter-section-detail';
    treeDetail.appendChild(moduleTreeWidget());
    group.appendChild(treeDetail);

    sectionHeader(group, 'moduleClassName', 'by class name');
    const classDetail = document.createElement('div');
    classDetail.className = 'elog-filter-section-detail';
    classDetail.appendChild(multiSelectList(hints?.moduleClassNames ?? [], state.moduleClassNames, (v) => setField('moduleClassNames', v)));
    group.appendChild(classDetail);

    container.appendChild(group);
  }

  function buildMessageFilterSection(container: HTMLElement): void {
    const group = document.createElement('div');
    group.className = 'elog-filter-group';
    const groupTitle = document.createElement('div');
    groupTitle.className = 'elog-filter-group-title';
    groupTitle.textContent = 'Message filter';
    group.appendChild(groupTitle);

    sectionHeader(group, 'messageExpression', 'by expression');
    const exprDetail = document.createElement('div');
    exprDetail.className = 'elog-filter-section-detail';
    const exprListId = 'elog-filter-message-expr-hints';
    fieldRow(exprDetail, 'Expression:', textInput(state.messageExpression, 'e.g. className(cMessage)', exprListId, (v) => setField('messageExpression', v)));
    exprDetail.appendChild(datalist(exprListId, [...(hints?.messageClassNames ?? []), ...(hints?.messageNames ?? [])]));
    group.appendChild(exprDetail);

    sectionHeader(group, 'messageClassName', 'by class name');
    const classDetail = document.createElement('div');
    classDetail.className = 'elog-filter-section-detail';
    classDetail.appendChild(multiSelectList(hints?.messageClassNames ?? [], state.messageClassNames, (v) => setField('messageClassNames', v)));
    group.appendChild(classDetail);

    sectionHeader(group, 'messageName', 'by name');
    const nameDetail = document.createElement('div');
    nameDetail.className = 'elog-filter-section-detail';
    nameDetail.appendChild(multiSelectList(hints?.messageNames ?? [], state.messageNames, (v) => setField('messageNames', v)));
    group.appendChild(nameDetail);

    sectionHeader(group, 'messageId', 'by ID');
    const idDetail = document.createElement('div');
    idDetail.className = 'elog-filter-section-detail';
    fieldRow(idDetail, 'Message IDs:', commaListInput(state.messageIds, (v) => setField('messageIds', v)));
    group.appendChild(idDetail);

    sectionHeader(group, 'messageTreeId', 'by tree ID');
    const treeIdDetail = document.createElement('div');
    treeIdDetail.className = 'elog-filter-section-detail';
    fieldRow(treeIdDetail, 'Message tree IDs:', commaListInput(state.messageTreeIds, (v) => setField('messageTreeIds', v)));
    group.appendChild(treeIdDetail);

    sectionHeader(group, 'messageEncapsulationId', 'by encapsulation ID');
    const encIdDetail = document.createElement('div');
    encIdDetail.className = 'elog-filter-section-detail';
    fieldRow(encIdDetail, 'Message encapsulation IDs:', commaListInput(state.messageEncapsulationIds, (v) => setField('messageEncapsulationIds', v)));
    group.appendChild(encIdDetail);

    sectionHeader(group, 'messageEncapsulationTreeId', 'by encapsulation tree ID');
    const encTreeIdDetail = document.createElement('div');
    encTreeIdDetail.className = 'elog-filter-section-detail';
    fieldRow(encTreeIdDetail, 'Message encapsulation tree IDs:', commaListInput(state.messageEncapsulationTreeIds, (v) => setField('messageEncapsulationTreeIds', v)));
    group.appendChild(encTreeIdDetail);

    container.appendChild(group);
  }

  function buildTraceSection(container: HTMLElement): void {
    sectionHeader(container, 'trace', 'Cause/consequence filter');
    const detail = document.createElement('div');
    detail.className = 'elog-filter-section-detail';
    fieldRow(detail, 'Event number to be traced:', numberInput(state.tracedEventNumber, (v) => setField('tracedEventNumber', v)));
    detail.appendChild(checkboxField(state.traceCauses, 'Include cause events', (v) => setField('traceCauses', v)));
    detail.appendChild(checkboxField(state.traceConsequences, 'Include consequence events', (v) => setField('traceConsequences', v)));
    detail.appendChild(checkboxField(state.traceMessageReuses, 'Follow message reuse dependencies', (v) => setField('traceMessageReuses', v)));
    detail.appendChild(checkboxField(state.traceSelfMessages, 'Follow self-message dependencies', (v) => setField('traceSelfMessages', v)));

    // "Event number limits" / "Simulation time limits" groups (FilterEventLogDialog.java's
    // two `Group`s at the bottom of the trace filter page).
    const eventNumberLimitsGroup = document.createElement('div');
    eventNumberLimitsGroup.className = 'elog-filter-group';
    const eventNumberLimitsTitle = document.createElement('div');
    eventNumberLimitsTitle.className = 'elog-filter-group-title';
    eventNumberLimitsTitle.textContent = 'Event number limits';
    eventNumberLimitsGroup.appendChild(eventNumberLimitsTitle);
    fieldRow(eventNumberLimitsGroup, 'Cause event number delta limit:', numberInput(state.causeEventNumberDelta, (v) => setField('causeEventNumberDelta', v)));
    fieldRow(eventNumberLimitsGroup, 'Consequence event number delta limit:', numberInput(state.consequenceEventNumberDelta, (v) => setField('consequenceEventNumberDelta', v)));
    detail.appendChild(eventNumberLimitsGroup);

    const simTimeLimitsGroup = document.createElement('div');
    simTimeLimitsGroup.className = 'elog-filter-group';
    const simTimeLimitsTitle = document.createElement('div');
    simTimeLimitsTitle.className = 'elog-filter-group-title';
    simTimeLimitsTitle.textContent = 'Simulation time limits';
    simTimeLimitsGroup.appendChild(simTimeLimitsTitle);
    fieldRow(simTimeLimitsGroup, 'Cause simulation time delta limit:', textInput(state.causeSimulationTimeDelta, '(none)', undefined, (v) => setField('causeSimulationTimeDelta', v)));
    fieldRow(simTimeLimitsGroup, 'Consequence simulation time delta limit:', textInput(state.consequenceSimulationTimeDelta, '(none)', undefined, (v) => setField('consequenceSimulationTimeDelta', v)));
    detail.appendChild(simTimeLimitsGroup);

    container.appendChild(detail);
  }

  function render(): void {
    body.innerHTML = '';
    buildCollectionLimitsSection(body);
    buildRangeSection(body);
    buildEventFilterSection(body);
    buildModuleFilterSection(body);
    buildMessageFilterSection(body);
    buildTraceSection(body);

    // reflect section-enabled -> show/hide detail via a class rather than removing the
    // DOM, so the values stay mounted/readable even while a section is unchecked
    // (matches Java's "disable, don't hide" -- see filterPanelState.ts's header).
    for (const el of body.querySelectorAll<HTMLElement>('.elog-filter-section-header')) {
      const checkbox = el.querySelector('input[type=checkbox]') as HTMLInputElement;
      const detail = el.nextElementSibling as HTMLElement | null;
      if (detail?.classList.contains('elog-filter-section-detail')) detail.classList.toggle('enabled', checkbox.checked);
    }

    body.appendChild(descriptionEl);
    body.appendChild(busyRow);
    renderDescription();
    updateApplyEnabled();
  }

  root.appendChild(footer);

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      handle.close();
      e.stopPropagation();
    }
  }
  root.addEventListener('keydown', onKeyDown);

  const handle: FilterPanelHandle = {
    element: root,
    open(): void {
      open = true;
      root.style.display = 'flex';
      if (!dataRequested) {
        dataRequested = true;
        deps.requestData();
      }
      render();
    },
    close(): void {
      open = false;
      root.style.display = 'none';
      deps.onClose();
    },
    toggle(): void {
      if (open) handle.close();
      else handle.open();
    },
    isOpen(): boolean {
      return open;
    },
    getState(): FilterPanelState {
      return state;
    },
    setState(next: FilterPanelState): void {
      state = mergeFilterPanelState(next);
      if (open) render();
    },
    prefillAndOpen(patch): void {
      state = patch(state);
      notifyChanged();
      handle.open();
    },
    setModuleTree(tree): void {
      moduleTree = tree;
      if (open) render();
    },
    setFilterHints(next): void {
      hints = next;
      if (open) render();
    },
    setBusy(busy, onCancel): void {
      busyRow.style.display = busy ? 'flex' : 'none';
      applyButton.disabled = busy || !(isAnyFilterActive(state) && buildFilterParams(state) !== null);
      removeButton.disabled = busy;
      cancelButton.onclick = busy && onCancel ? onCancel : null;
      if (busy) {
        busyTicks = 0;
        busyLabel.textContent = 'Applying filter…';
      }
    },
    tickBusy(): void {
      if (busyRow.style.display === 'none') return;
      busyTicks++;
      busyLabel.textContent = `Applying filter${'.'.repeat((busyTicks % 3) + 1)}`;
    },
    setFiltered(filtered): void {
      removeButton.disabled = !filtered;
    },
    dispose(): void {
      root.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };

  render();
  return handle;
}

function findModuleById(node: ElogModule | null, id: number): ElogModule | null {
  if (!node) return null;
  if (node.moduleId === id) return node;
  for (const child of node.children) {
    const found = findModuleById(child, id);
    if (found) return found;
  }
  return null;
}
