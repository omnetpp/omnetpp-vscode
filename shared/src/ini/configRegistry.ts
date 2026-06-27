export type ConfigScope = 'global' | 'per-run' | 'per-object';

export interface ConfigOption {
  name: string;
  type: string; // bool|int|double|string|path|filename|filenames|custom
  unit?: string;
  default: string | null;
  scope: ConfigScope;
  objectKind?: string;
  description: string;
}

/** In-memory registry of OMNeT++ configuration options (from the bundled snapshot). */
export class ConfigRegistry {
  private byName = new Map<string, ConfigOption>();
  private perObjectNames = new Set<string>();
  // options whose name contains '%' (a numeric placeholder), e.g. seed-%-mt
  private patterns: { re: RegExp; option: ConfigOption }[] = [];

  constructor(options: ConfigOption[] = []) {
    this.load(options);
  }

  load(options: ConfigOption[]): void {
    this.byName.clear();
    this.perObjectNames.clear();
    this.patterns = [];
    for (const o of options) {
      this.byName.set(o.name, o);
      if (o.scope === 'per-object') this.perObjectNames.add(o.name);
      if (o.name.includes('%')) {
        const re = new RegExp('^' + o.name.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '\\d+') + '$');
        this.patterns.push({ re, option: o });
      }
    }
  }

  get(name: string): ConfigOption | undefined {
    const exact = this.byName.get(name);
    if (exact) return exact;
    for (const p of this.patterns) if (p.re.test(name)) return p.option;
    return undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** A per-object option name (the segment after the last dot), e.g. 'typename'. */
  isPerObjectOptionName(name: string): boolean {
    if (this.perObjectNames.has(name)) return true;
    for (const p of this.patterns) if (p.option.scope === 'per-object' && p.re.test(name)) return true;
    return false;
  }

  all(): ConfigOption[] {
    return [...this.byName.values()];
  }

  /** Options that appear as bare keys (no module path): global + per-run. */
  sectionOptions(): ConfigOption[] {
    return this.all().filter((o) => o.scope !== 'per-object');
  }
}

/** Section directives that are not configuration options. */
export const INI_SECTION_DIRECTIVES = new Set(['extends', 'description']);
