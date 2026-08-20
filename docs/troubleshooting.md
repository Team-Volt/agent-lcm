# Troubleshooting

## Start with doctor

```sh
agent-lcm doctor --json
agent-lcm setup status
agent-lcm daemon status
```

`doctor` checks Codex plugin wiring, the recall skill, the shared daemon, the
capture queue, quarantine, SQLite, and summary indexing. Claude native plugin
health remains `unknown` in that report. `setup status` reports
`hooksConfigured` for setup-managed or legacy hook files; Claude always reports
`hooksConfigured: false` with its `settings.json` display path. It does not claim
to check native plugin health. OpenCode setup status reports its generated
`mcpConfigured` state and its generated OpenCode plugin state.

## The MCP server is missing

An Agent Plugins client should discover `mcp.json` at the plugin root. Restart
the harness after installing or updating the plugin.

OpenCode setup configures the stable capture plugin and exact local
`mcp.agent-lcm` entry in valid `opencode.json` or `opencode.jsonc`. JSONC edits
preserve comments, trailing commas, and unrelated settings. Removal disables
the plugin and deletes only exact owned MCP entries. This integration targets stable OpenCode plugins,
not OpenCode 2 beta, and has no historical importer.

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

Install or repair Agent LCM, then restart the harness:

```sh
agent-lcm setup all
```

`setup all` skips harnesses it cannot detect. If Codex is installed in a custom
home, configure it explicitly and pass that directory:

```sh
agent-lcm setup codex --home /path/to/codex-home
```

Codex loads hooks from its native plugin; `~/.codex/hooks.json` is only an older
fallback. Kiro uses `~/.kiro/hooks/agent-lcm.json`. Cursor, VS Code, and GitHub
Copilot native plugins carry their own hooks. Cursor setup preserves an older
`~/.cursor/hooks.json` fallback until native installation is complete. A
successful Copilot or VS Code native setup removes only exact older Agent LCM
entries from the shared fallback so capture does not run twice. Setup refuses
malformed existing JSON instead of overwriting it. Before changing a valid
existing file, setup saves a timestamped `-pre-agent-lcm-` backup beside it.

Claude Code, Codex, Cursor, VS Code, and Copilot may ask you to review or trust
plugin-owned commands. OpenCode's stable plugin integration captures session,
prompt, and tool events. Claude Code's hooks cover `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, and `Stop`. Capture
will not run until the harness allows those hooks.

After installing or updating the Claude Code plugin, run `/reload-plugins` in
Claude Code. Start a new session or restart the client if the plugin still does
not appear.

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
agent-lcm setup claude
agent-lcm setup opencode
agent-lcm remove codex
agent-lcm remove claude
agent-lcm remove opencode
```

Replace `codex` with the harness you want to remove.

Exit status `0` means the requested work completed. Exit status `2` means the
native step is `manual-required`, or Copilot/VS Code removal returned
`shared-retained` so the shared plugin was left in place. Exit status `1` means
the command failed; Agent LCM reports the fixed command, exit status, and a
suppressed-stderr marker so a client cannot leak secrets into logs. Use
`--json` for stable automation fields.

Codex setup probes `codex plugin list`, then runs the marketplace-add and
plugin-add commands against the installed npm package. That package omits the
portable root manifest so Codex selects its native hook manifest. Removal runs
`codex plugin remove agent-lcm@agent-lcm`.
Copilot and VS Code probe and install through `copilot plugin`; they share the
same native plugin store, so either `agent-lcm remove copilot` or `agent-lcm
remove vscode` is intentionally conservative and does not uninstall the shared
plugin. A legacy `~/.copilot/hooks/agent-lcm.json` fallback is separate and is
left unchanged. Review both clients before using the documented Copilot
uninstall command. Cursor Marketplace and Kiro Powers installation/removal
stay manual. Claude Code setup uses its marketplace and plugin JSON lists; a
repeat setup updates the user plugin. Claude removal retains the marketplace and
only uninstalls the user plugin. If `--home PATH` is supplied for Claude, it is
the Claude config directory passed through `CLAUDE_CONFIG_DIR`. OpenCode setup
writes `~/.config/opencode/plugins/agent-lcm.ts`, or
`<PATH>/plugins/agent-lcm.ts` when `--home PATH` names the OpenCode config
directory. Setup also manages the exact MCP entry in `<PATH>/opencode.json` or
`<PATH>/opencode.jsonc`.
Removal deactivates the generated plugin with the durable
`.agent-lcm-opencode-plugin.state` marker instead of deleting its path, and
removes only the exact owned MCP entry. If setup
or removal reports a partial update, inspect both components, repair the
incomplete one, and retry the same command. This integration targets stable
OpenCode plugins, not OpenCode 2 beta, and has no historical importer.

Setup validates the existing JSON before starting a native CLI. It changes only
exact Agent LCM-owned hook entries and preserves unrelated or near-matching
entries. A changed file gets a collision-safe `-pre-agent-lcm-` backup. Setup
also refuses symlinked directory components, lock paths, targets, and
non-regular files. It uses an atomic lock directory at `<target>.lock`, with a
ten-second bound, plus unique, fsynced
temporary publication; a predictable temporary symlink cannot redirect the
write. Hook commands must use an absolute shell-safe binary path. If validation
fails, the original file and native CLI invocation remain unchanged.

If another process changes the hook file after that preflight while a native
command is running, Agent LCM does not overwrite the new bytes. It exits `1`
and states whether the native action completed or setup stopped. Repair the
named file if needed, then rerun the same `agent-lcm setup <harness>` or
`agent-lcm remove <harness>` command.

If setup times out on `<target>.lock`, first confirm that no Agent LCM setup or
remove process is running. You may then remove that empty lock directory and
retry. Do not remove it while another process is active.

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
`~/.copilot/session-state`, Kiro to `~/.kiro/sessions/cli`, and Claude Code to
`~/.claude/projects`. `CODEX_HOME` changes the Codex root. The JSON report
separates missing files, rejected records, duplicates, and harnesses that need
an export. For another Claude location, pass its project-session directory or a
session JSONL file:

```sh
agent-lcm import --harness claude /path/to/projects --dry-run
```

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
