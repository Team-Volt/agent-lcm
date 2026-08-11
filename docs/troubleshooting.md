# Troubleshooting

## Start with doctor

```sh
agent-lcm doctor --json
agent-lcm setup status
agent-lcm daemon status
```

`doctor` checks Codex plugin wiring, the recall skill, the shared daemon, the
capture queue, quarantine, SQLite, and summary indexing. `setup status` reports
the harness hook files separately.

## The MCP server is missing

An Agent Plugins client should discover `mcp.json` at the plugin root. Restart
the harness after installing or updating the plugin.

For manual MCP configuration, use a stdio server with an absolute path:

```json
{
  "command": "agent-lcm",
  "args": ["mcp"]
}
```

Run `agent-lcm --help` in a new terminal if the server fails to start. Agent LCM
requires Node 22.18 or newer. GUI apps may not inherit your npm global `PATH`;
prefer native plugin installation when that happens.

## Hooks are not capturing

Install or repair the harness hook file, then restart the harness:

```sh
agent-lcm setup all
```

`setup all` skips harnesses it cannot detect. If Codex is installed in a custom
home, configure it explicitly and pass that directory:

```sh
agent-lcm setup codex --home /path/to/codex-home
```

Codex loads `~/.codex/hooks.json`; Cursor loads `~/.cursor/hooks.json`. VS Code and GitHub Copilot share
`~/.copilot/hooks/agent-lcm.json`, and the generated hook detects which one sent
the event. Setup refuses malformed existing JSON instead of overwriting it.
Before changing a valid existing file, setup saves a timestamped
`-pre-agent-lcm-` backup in the same directory.

Codex and Cursor may ask you to review or trust plugin-owned commands. Capture
will not run until the harness allows those hooks.

Check whether events reach the queue and daemon:

```sh
agent-lcm daemon start
agent-lcm daemon status
agent-lcm health --json
```

A nonzero `queue_depth` means capture succeeded but the daemon has not drained
the inbox. A nonzero `quarantine_count` means the daemon rejected one or more
queue records; inspect `~/.agent-lcm/quarantine/` before removing them.

## Setup or removal needs manual work

Run the harness-specific command and read its report:

```sh
agent-lcm setup codex
agent-lcm setup copilot
agent-lcm setup vscode
agent-lcm setup cursor
agent-lcm setup kiro
agent-lcm remove codex
```

Replace `codex` with the harness you want to remove.

Exit status `0` means the requested work completed. Exit status `2` means the
native step is `manual-required`, or Copilot/VS Code removal returned
`shared-retained` so the shared plugin was left in place. Exit status `1` means
the command failed; its stderr is the error record. Use `--json` for stable
automation fields.

Codex setup probes `codex plugin list`, then runs the marketplace-add and
plugin-add commands. Removal runs `codex plugin remove agent-lcm@agent-lcm`.
Copilot and VS Code probe and install through `copilot plugin`; they share the
same plugin store and `~/.copilot/hooks/agent-lcm.json`, so either
`agent-lcm remove copilot` or `agent-lcm remove vscode` is intentionally
conservative and does not uninstall the shared plugin. Review both clients
before using the documented Copilot uninstall command. Cursor Marketplace and
Kiro Powers installation/removal stay manual.

Setup validates the existing JSON before starting a native CLI. It changes only
exact Agent LCM-owned hook entries and preserves unrelated or near-matching
entries. A changed file gets a collision-safe `-pre-agent-lcm-` backup. Setup
also refuses symlinked or non-regular targets and uses a per-file SQLite lock
at `<target>.lock.sqlite`, with a ten-second bound, plus unique, fsynced
temporary publication; a predictable temporary symlink cannot redirect the
write. Hook commands must use an absolute shell-safe binary path. If validation
fails, the original file and native CLI invocation remain unchanged.

## Isolate a storage problem

Use a temporary home so tests do not touch your normal store:

```sh
AGENT_LCM_HOME=/private/tmp/agent-lcm-check agent-lcm daemon start
AGENT_LCM_HOME=/private/tmp/agent-lcm-check agent-lcm health --json
AGENT_LCM_HOME=/private/tmp/agent-lcm-check agent-lcm daemon stop
```

`events.jsonl` and manifest-listed segments are the source of truth. If SQLite
cannot open, captured queue files remain durable and raw events already appended
remain available for a rebuild.

## The daemon is duplicated or stuck

Agent LCM uses an authenticated local endpoint plus a SQLite ownership lock.
Independent starters should converge on one process.

```sh
agent-lcm daemon status
agent-lcm daemon stop
agent-lcm daemon start
```

Do not delete runtime or lock files while `daemon status` reports a responsive
process. If the process was killed, the next start validates the endpoint and
recovers stale metadata.

## Import finds no sessions

Use a source path when the harness has no stable default export location:

```sh
agent-lcm import --harness cursor /path/to/chat.md --dry-run
agent-lcm import --harness vscode /path/to/export.json --dry-run
```

Codex defaults to `~/.codex/sessions`, GitHub Copilot to
`~/.copilot/session-state`, and Kiro to `~/.kiro/sessions/cli`. `CODEX_HOME`
changes the Codex root. The JSON report separates missing files, rejected
records, duplicates, and harnesses that need an export.

Imports do not edit source files. Repeating a successful import is safe.

## Storage keeps growing

The active raw log rotates at 64 MiB. Closed segments should move from
`plain_segment_count` to `compressed_segment_count`, and archived SQLite rows
should keep locators instead of full duplicate JSON.

```sh
agent-lcm health --json
agent-lcm maintain --once --json
```

`migration_state`, `active_bytes`, `archive_bytes`, and the segment counts show
maintenance progress. Do not remove `segments/legacy.jsonl` when migration
reports an error; it remains the source for any quarantined record.

Raw history is unlimited by default. To expire closed source segments, create
`~/.agent-lcm/.env`:

```dotenv
AGENT_LCM_RETENTION_DAYS=90
```

A process environment value overrides the file. Invalid values appear as
`config_error` and block deletion.

## The SQLite index is much larger than expected

Preview derived-index cleanup:

```sh
agent-lcm cleanup --json
```

If the preview is sound, apply it:

```sh
agent-lcm cleanup --apply --json
```

Cleanup rebuilds high-signal FTS rows, clears old duplicate event text, refreshes
summaries, and vacuums SQLite. It preserves retained raw sources. Stop other
work against the store if SQLite reports that the database is busy.

## Development checks

```sh
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

Node's built-in SQLite module may emit an experimental warning on supported Node
22 releases. Project commands use `--no-warnings` where that warning could
interfere with MCP stdout.
