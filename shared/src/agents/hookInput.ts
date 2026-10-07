// The JSON that agent post-edit hooks (Claude Code, Codex, Devin) send on stdin
// names the edited files in different ways: Claude's Edit/Write/MultiEdit give
// `tool_input.file_path`, while Codex reports every edit as `apply_patch` with
// the patch text, whose `*** Update File: <path>` headers name the files.

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;

/** Paths of the files an edit tool wrote, as given (possibly relative to the hook's `cwd`).
 *  Files deleted by a patch are not included. */
export function editedFiles(hookInput: unknown): string[] {
  const toolInput = (hookInput as { tool_input?: unknown } | null)?.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(toolInput as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (key === 'file_path' || key === 'path') out.push(value);
    else if (value.includes('*** Begin Patch')) {
      for (const m of value.matchAll(PATCH_FILE)) out.push(m[1].trim());
    }
  }
  return [...new Set(out)];
}
