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

1. `lcm_grep` searches the current cwd or repository first, then retries globally
   when the scoped search is empty.
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

## Install the CLI

```sh
npm install --global @team-volt/agent-lcm
agent-lcm setup all
```

You can also install the current source directly from GitHub:

```sh
npm install --global github:Team-Volt/agent-lcm
agent-lcm setup all
```

The npm package provides the stable `agent-lcm` command used by capture hooks,
imports, diagnostics, and daemon administration. Native plugins provide MCP and
skills from their managed caches. Every copy uses the same `~/.agent-lcm` store;
you never need to find or reference a harness cache path.

## Install in each harness

Agent Plugins 1.0 defines the package, not one shared installer. Run the setup
command for each harness you use, then follow its guide for native installation,
trust, and removal:

| Harness | Setup command | Guide |
| --- | --- | --- |
| Codex | `agent-lcm setup codex` | [Codex guide](docs/install/codex.md) |
| Cursor | `agent-lcm setup cursor` | [Cursor guide](docs/install/cursor.md) |
| VS Code | `agent-lcm setup vscode` | [VS Code guide](docs/install/vscode.md) |
| GitHub Copilot CLI | `agent-lcm setup copilot` | [Copilot guide](docs/install/copilot.md) |
| Kiro IDE | `agent-lcm setup kiro` | [Kiro guide](docs/install/kiro.md) |

The guides follow the current [Codex plugin](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/plugin-creator/references/installing-and-updating.md),
[Copilot CLI plugin](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference),
[VS Code agent plugin](https://code.visualstudio.com/docs/agent-customization/agent-plugins),
[Cursor Marketplace](https://cursor.com/marketplace), and
[Kiro Powers](https://kiro.dev/docs/powers/) documentation. If setup cannot run a
supported native command, it reports the guide and uses the manual hook path
when that harness needs one.

Compatible clients discover the same portable components:

- `skills/lcm-recall/SKILL.md`
- the `agent-lcm` stdio server in `mcp.json`

Codex and Cursor compatibility manifests are included for their native plugin
layouts. If a client cannot install the plugin, add this stdio MCP server:

```json
{
  "command": "agent-lcm",
  "args": ["mcp"]
}
```

The harness must inherit a `PATH` that contains the npm global binary. Native
plugin installation is more reliable for GUI apps because it uses the bundled
command. Use the relevant guide's trust or refresh note after installation; a
restart is not a general requirement documented by every harness.

## Enable automatic capture

`agent-lcm setup all` detects the harnesses installed under your home directory
and completes native setup where supported, with manual hook wiring only where
that harness needs it. It does not create configuration directories for clients
you do not use. To configure a harness that setup cannot detect, run its
command directly:

```sh
agent-lcm setup codex
agent-lcm setup cursor
agent-lcm setup vscode
agent-lcm setup copilot
agent-lcm setup kiro
```

Run only the commands for the harnesses you use. The manual VS Code and GitHub
Copilot fallback shares `~/.copilot/hooks/agent-lcm.json`; native plugin hooks
are loaded from the plugin store instead of being duplicated there. Setup
preserves unrelated hook entries, is safe to run again, and writes private
files containing the absolute Agent LCM command when manual wiring is needed.
If a target file already exists and needs changes, setup first saves a
timestamped `-pre-agent-lcm-` backup beside it.

Setup-managed and legacy user hook locations are:

| Harness | Hook file |
| --- | --- |
| Codex | `~/.codex/hooks.json` |
| Cursor | `~/.cursor/hooks.json` |
| VS Code | `~/.copilot/hooks/agent-lcm.json` |
| GitHub Copilot | `~/.copilot/hooks/agent-lcm.json` |
| Kiro | `~/.kiro/hooks/agent-lcm.json` |

Cursor, Copilot, and VS Code native plugins carry their own hooks. Setup does
not add a second user-level copy after native installation.

Check the result:

```sh
agent-lcm setup status
agent-lcm doctor --json
```

Hooks start the daemon on demand. You can also manage it directly:

```sh
agent-lcm daemon start
agent-lcm daemon restart
agent-lcm daemon status
agent-lcm daemon stop
```

After upgrading the npm package, restart the daemon once so the new runtime
becomes the owner. Native plugin copies with the same daemon protocol will reuse
it instead of replacing it:

```sh
npm install --global @team-volt/agent-lcm@latest
agent-lcm daemon restart
```

## Import existing sessions

Start with a dry run. Import never changes the source files, and rerunning it
skips event IDs already in the shared store.

```sh
agent-lcm import --harness codex --dry-run
agent-lcm import --harness codex
```

Known default locations are available for Codex, GitHub Copilot, and Kiro:

```sh
agent-lcm import --harness copilot
agent-lcm import --harness kiro
```

Cursor and VS Code need an exported file because their local session formats
are not stable public import surfaces. Pass a Cursor chat Markdown export or a
VS Code JSON/OTLP export:

```sh
agent-lcm import --harness cursor /path/to/chat.md --dry-run
agent-lcm import --harness vscode /path/to/export.json --dry-run
```

To scan the known locations for every directly readable harness under a home
directory:

```sh
agent-lcm import --all --dry-run
agent-lcm import --all
```

The report lists scanned and imported sessions, imported and duplicate events,
rejected records, failures, and harnesses that still need an export. The legacy
Codex-only command remains available during initial migration work:

```sh
agent-lcm import-codex-sessions --dry-run --json
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
agent-lcm health --json
agent-lcm maintain --once --json
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
agent-lcm --help
agent-lcm doctor --json
agent-lcm health --json
agent-lcm stats --json
agent-lcm sessions --include-summaries --json
agent-lcm usage --json
agent-lcm cleanup --json
```

`cleanup` compacts the derived search index; it does not delete retained raw
events. Use `cleanup --apply` only after reviewing the preview.

## Development

```sh
git clone git@github.com:Team-Volt/agent-lcm.git
cd agent-lcm
npm ci
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
