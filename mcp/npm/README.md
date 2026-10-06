# @omnetpp/opp-tools

Command-line tools for [OMNeT++](https://omnetpp.org) simulation models. They use the same
analyzers as the
[OMNeT++ extension for VS Code](https://marketplace.visualstudio.com/items?itemName=opensim.omnetpp-vscode)
and need **no OMNeT++ installation**.

| Command | Purpose |
| --- | --- |
| `opp_lint` | Lint NED, MSG, and INI files — for CI, pre-commit hooks, and scripts. |
| `opp_neddoc` | Generate documentation (HTML, Markdown, or reStructuredText) from NED and MSG files. |
| `opp_ide_mcp` | MCP (Model Context Protocol) stdio server that lets AI agents query and refactor an OMNeT++ model and read eventlog (`.elog`) files. |

## Install

Requires Node.js 18 or newer.

```bash
npm install -g @omnetpp/opp-tools
```

## Usage

```bash
opp_lint src/                                   # lint a project; exit code 1 on errors
opp_lint --format=json --fail-on=warning src/   # machine-readable, stricter
opp_neddoc -o doc/neddoc src/                   # generate HTML documentation
```

To use `opp_ide_mcp`, register it as a stdio MCP server in your AI client, for example:

```json
{ "command": "opp_ide_mcp", "args": ["/path/to/project"] }
```

Run any command with `--help` for all options. Library NED folders (for example the
INET Framework) can be given with `--ned-path=<dirs>` or the `OMNETPP_NED_PATH`
environment variable.

## License

Free for noncommercial use (teaching, academic research, personal non-profit use), on the
same conditions of use as the OMNeT++ simulation kernel's Academic Public License. Commercial use
requires a valid commercial [OMNEST](https://omnest.com) license. See the `LICENSE` file
for the full terms, and `THIRD_PARTY_NOTICES.md` for the third-party components.
