# Agent LCM

Agent LCM gives coding agents one shared, local memory. It captures sessions from
Codex, Cursor, VS Code, GitHub Copilot, and Kiro, then makes that history
searchable from any of those harnesses through MCP.

LCM stands for lossless context memory. The sanitized event archive is the
source of truth. Search indexes, summaries, and graphs are derived from it and
can be rebuilt.

## Why use it

Coding agents lose useful context when a session ends, compacts, or moves to a
different harness. Agent LCM keeps that work available without sending it to a
hosted memory service.

- Resume earlier work with source-backed evidence instead of recollection.
- Search Codex work from Cursor, Copilot work from Kiro, or any other supported
  combination. Cross-harness search is the default.
- Keep one private store per user and machine instead of one database per
  harness or repository.
- Import sessions that existed before Agent LCM was installed.
- Rebuild the SQLite index from the raw archive if the derived data is damaged.
- Run without embeddings, external APIs, or cloud storage.

## How it works

Capture hooks sanitize each event and publish it to a private on-disk inbox.
One authenticated local daemon drains that inbox, appends the event to the raw
archive, and updates SQLite. MCP and storage CLI requests use the same daemon,
so harnesses do not compete as independent database writers.

Retrieval is global unless a caller passes a `harnesses` filter. The usual MCP
flow is:

1. `lcm_grep` finds matching sessions across harnesses.
2. `lcm_describe` inspects a session or summary node.
3. `lcm_expand` follows its source lineage, or `lcm_pack_context` returns a
   bounded context block ready for the agent.

Agent LCM targets [Agent Plugins 1.0](https://agent-plugins.org/specification).
The portable package surface is `plugin.json`, `skills/`, and `mcp.json`.
Agent Plugins 1.0 does not standardize lifecycle hooks, so this repository also
ships harness-specific hook manifests and an idempotent setup command. See the
[compatible client matrix](https://agent-plugins.org/compatible-clients) for
the component types each client currently loads.

## Requirements

- Node.js 22.18 or newer
- A local checkout of this private repository

```sh
git clone git@github.com:Team-Volt/agent-lcm.git
cd agent-lcm
npm ci
```

## Install the plugin

Point your harness's local Agent Plugins install flow at this checkout. The
standard leaves install commands and UI to each client, but compatible clients
discover the same two portable components:

- `skills/lcm-recall/SKILL.md`
- the `agent-lcm` stdio server in `mcp.json`

Codex and Cursor compatibility manifests are included for clients that still
use their native plugin layout. If a client only supports manual MCP setup, add
a stdio server with this command and arguments:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/agent-lcm/bin/agent-lcm", "mcp"]
}
```

Use an absolute path. Restart the harness after adding the plugin or MCP server.

## Enable automatic capture

If the plugin installer does not load the bundled hooks, run the setup command
for that harness from the checkout:

```sh
node "$PWD/bin/agent-lcm" setup codex
node "$PWD/bin/agent-lcm" setup cursor
node "$PWD/bin/agent-lcm" setup vscode
node "$PWD/bin/agent-lcm" setup copilot
node "$PWD/bin/agent-lcm" setup kiro
```

Run only the commands for the harnesses you use. VS Code and GitHub Copilot
share `~/.copilot/hooks/agent-lcm.json`; either setup command installs the same
auto-detecting hooks. Setup preserves unrelated hook entries, is safe to run
again, and writes private files containing the absolute Agent LCM command.

The hook locations are:

| Harness | Hook file |
| --- | --- |
| Codex | `~/.codex/hooks/agent-lcm.json` |
| Cursor | `~/.cursor/hooks/agent-lcm.json` |
| VS Code | `~/.copilot/hooks/agent-lcm.json` |
| GitHub Copilot | `~/.copilot/hooks/agent-lcm.json` |
| Kiro | `~/.kiro/hooks/agent-lcm.json` |

Check the result, then restart each harness:

```sh
node bin/agent-lcm setup status
node bin/agent-lcm doctor --json
```

Hooks start the daemon on demand. You can also manage it directly:

```sh
node bin/agent-lcm daemon start
node bin/agent-lcm daemon status
node bin/agent-lcm daemon stop
```

## Import existing sessions

Start with a dry run. Import never changes the source files, and rerunning it
skips event IDs already in the shared store.

```sh
node bin/agent-lcm import --harness codex --dry-run
node bin/agent-lcm import --harness codex
```

Known default locations are available for Codex, GitHub Copilot, and Kiro:

```sh
node bin/agent-lcm import --harness copilot
node bin/agent-lcm import --harness kiro
```

Cursor and VS Code need an exported file because their local session formats
are not stable public import surfaces. Pass a Cursor chat Markdown export or a
VS Code JSON/OTLP export:

```sh
node bin/agent-lcm import --harness cursor /path/to/chat.md --dry-run
node bin/agent-lcm import --harness vscode /path/to/export.json --dry-run
```

To scan the known locations for every directly readable harness under a home
directory:

```sh
node bin/agent-lcm import --all --dry-run
node bin/agent-lcm import --all
```

The report lists scanned and imported sessions, imported and duplicate events,
rejected records, failures, and harnesses that still need an export. The legacy
Codex-only command remains available during initial migration work:

```sh
node bin/agent-lcm import-codex-sessions --dry-run --json
```

## Local storage

The default store is `~/.agent-lcm`. Set `AGENT_LCM_HOME` to use another one.

```text
~/.agent-lcm/
  events.jsonl                 active raw append target
  segments/
    manifest.json              archive manifest and migration state
    *.jsonl.gz                 verified compressed raw segments
  index.sqlite                 derived FTS, summaries, and graph metadata
  overflow/                    sanitized large-value spill files
  inbox/                       durable capture queue
  quarantine/                  malformed queue records
  runtime/                     daemon socket, token, and ownership files
```

The active log rotates at 64 MiB. The daemon verifies and compresses closed
segments with gzip level 1, stores byte locators in SQLite, and removes the
duplicate full JSON from archived index rows. The index does not keep a second
full copy of archived event payloads.

Raw history is unlimited by default. To expire closed raw segments after a
fixed number of days, set a positive integer in the process environment or in
`~/.agent-lcm/.env`:

```dotenv
AGENT_LCM_RETENTION_DAYS=90
```

Finite retention removes exact old event sources but keeps session and summary
records. Check `config_error` and migration fields with:

```sh
node bin/agent-lcm health --json
node bin/agent-lcm maintain --once --json
```

## Privacy and safety

Agent LCM stores session content on the local machine. It redacts common secret
fields and token formats before publication, strips credential URI passwords,
and bounds large strings and payloads. Oversized sanitized values use local
overflow files with hashes and byte counts.

Redaction lowers risk but cannot prove that arbitrary tool output contains no
sensitive data. Protect `~/.agent-lcm` as you would protect local source code
and shell history. Agent LCM creates its store directories with mode `0700` and
private files with mode `0600` on platforms that support POSIX permissions.

## Useful commands

```sh
node bin/agent-lcm --help
node bin/agent-lcm doctor --json
node bin/agent-lcm health --json
node bin/agent-lcm stats --json
node bin/agent-lcm sessions --include-summaries --json
node bin/agent-lcm usage --json
node bin/agent-lcm cleanup --json
```

`cleanup` compacts the derived search index; it does not delete retained raw
events. Use `cleanup --apply` only after reviewing the preview.

## Development

```sh
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

The smoke test uses a temporary `AGENT_LCM_HOME`, captures events through the
real CLI, starts the daemon and MCP server, searches the shared store, and
cleans up its processes.

See [Architecture](docs/architecture.md) and
[Troubleshooting](docs/troubleshooting.md) for implementation and recovery
details.

## License

Agent LCM uses the MIT License. See [LICENSE](LICENSE).
