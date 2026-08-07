# Troubleshooting

## Start with doctor

```sh
node bin/agent-lcm doctor --json
node bin/agent-lcm setup status
node bin/agent-lcm daemon status
```

`doctor` checks Codex plugin wiring, the recall skill, the shared daemon, the
capture queue, quarantine, SQLite, and summary indexing. `setup status` reports
the harness hook files separately.

## The MCP server is missing

An Agent Plugins client should discover `mcp.json` at the plugin root. Restart
the harness after installing or refreshing the checkout.

For manual MCP configuration, use a stdio server with an absolute path:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/agent-lcm/bin/agent-lcm", "mcp"]
}
```

Run `node bin/agent-lcm --help` with the same Node installation if the server
fails to start. Agent LCM requires Node 22.18 or newer.

## Hooks are not capturing

Install or repair the harness hook file, then restart the harness:

```sh
node "$PWD/bin/agent-lcm" setup codex
node "$PWD/bin/agent-lcm" setup cursor
node "$PWD/bin/agent-lcm" setup vscode
node "$PWD/bin/agent-lcm" setup copilot
node "$PWD/bin/agent-lcm" setup kiro
```

Use only the harnesses you need. VS Code and GitHub Copilot share
`~/.copilot/hooks/agent-lcm.json`, and the generated hook detects which one sent
the event. Setup refuses malformed existing JSON instead of overwriting it.

Codex and Cursor may ask you to review or trust plugin-owned commands. Capture
will not run until the harness allows those hooks.

Check whether events reach the queue and daemon:

```sh
node bin/agent-lcm daemon start
node bin/agent-lcm daemon status
node bin/agent-lcm health --json
```

A nonzero `queue_depth` means capture succeeded but the daemon has not drained
the inbox. A nonzero `quarantine_count` means the daemon rejected one or more
queue records; inspect `~/.agent-lcm/quarantine/` before removing them.

## Isolate a storage problem

Use a temporary home so tests do not touch your normal store:

```sh
AGENT_LCM_HOME=/private/tmp/agent-lcm-check node bin/agent-lcm daemon start
AGENT_LCM_HOME=/private/tmp/agent-lcm-check node bin/agent-lcm health --json
AGENT_LCM_HOME=/private/tmp/agent-lcm-check node bin/agent-lcm daemon stop
```

`events.jsonl` and manifest-listed segments are the source of truth. If SQLite
cannot open, captured queue files remain durable and raw events already appended
remain available for a rebuild.

## The daemon is duplicated or stuck

Agent LCM uses an authenticated local endpoint plus a SQLite ownership lock.
Independent starters should converge on one process.

```sh
node bin/agent-lcm daemon status
node bin/agent-lcm daemon stop
node bin/agent-lcm daemon start
```

Do not delete runtime or lock files while `daemon status` reports a responsive
process. If the process was killed, the next start validates the endpoint and
recovers stale metadata.

## Import finds no sessions

Use a source path when the harness has no stable default export location:

```sh
node bin/agent-lcm import --harness cursor /path/to/chat.md --dry-run
node bin/agent-lcm import --harness vscode /path/to/export.json --dry-run
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
node bin/agent-lcm health --json
node bin/agent-lcm maintain --once --json
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
node bin/agent-lcm cleanup --json
```

If the preview is sound, apply it:

```sh
node bin/agent-lcm cleanup --apply --json
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
