// Command-line handling for the language server bundle, which ships both as the
// extension's server (spawned with --node-ipc) and as the opp_lsp tool for other
// editors, which usually start it with no arguments or with --stdio.
import { resolve } from 'node:path';
import { readNedPathSetting, resolveNedPath, splitNedPath } from '@omnetpp/shared/node';

const USAGE = `opp_lsp — language server for OMNeT++ NED, MSG and INI files

Usage:
  opp_lsp [options]

Speaks the Language Server Protocol; start it from an editor, not interactively.
Logs go to the editor through LSP (window/logMessage), never to stdout.

Options:
  --stdio             Communicate over stdin/stdout (the default).
  --socket=<port>     Connect to a socket server on this port instead.
  --pipe=<name>       Communicate over this named pipe / Unix socket instead.
  --ned-path=<dirs>   Extra NED source roots (libraries), ';'-separated
                      (or ':' outside Windows). Relative paths are resolved against
                      the current directory. Defaults to the OMNETPP_NED_PATH
                      environment variable, then to "omnetpp.nedPath" in the
                      project's .vscode/settings.json. A non-empty nedPath sent
                      by the editor takes precedence over all of these. Relative
                      entries of the editor value and of the settings file are
                      resolved against the (first) workspace folder.
  -h, --help          Show this help.

Editor settings (all optional):
  initializationOptions:              { "nedPath": "...", "installDir": "...",
                                        "diagnostics": { "scope": "workspace" },
                                        "codeLens": { "iniParams": true } }
  workspace/didChangeConfiguration:   { "omnetpp": { <same keys> } }`;

const TRANSPORT_FLAGS = ['--stdio', '--node-ipc', '--socket', '--pipe'];

export interface CommandLine {
  /** NED path from --ned-path or OMNETPP_NED_PATH, with absolute entries. */
  nedPath: string;
}

/** Handles --help, and selects stdio in `argv` when no transport flag was given,
 *  so `createConnection()` must be called after this. */
export function parseCommandLine(argv: string[], env: NodeJS.ProcessEnv): CommandLine {
  let nedPath = env.OMNETPP_NED_PATH ?? '';
  for (const a of argv.slice(2)) {
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a.startsWith('--ned-path=')) {
      nedPath = a.slice('--ned-path='.length);
    }
  }
  if (!argv.slice(2).some((a) => TRANSPORT_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)))) argv.push('--stdio');
  return { nedPath: splitNedPath(nedPath).map((p) => resolve(p)).join(';') };
}

/** The NED path the server indexes: the editor's value, else the command line, else the
 *  project's settings file. Editor and settings entries are relative to `projectDir`. */
export function effectiveNedPath(editorValue: string | undefined, commandLine: CommandLine, projectDir: string): string {
  return (
    resolveNedPath(editorValue ?? '', projectDir) ||
    commandLine.nedPath ||
    resolveNedPath(readNedPathSetting(projectDir), projectDir)
  );
}
