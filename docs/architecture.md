# Architecture

## Package surfaces

The repository root is an Agent Plugins 1.0 package:

```text
plugin.json                   portable package manifest
mcp.json                      portable MCP server configuration
skills/lcm-recall/            portable recall skill
hooks.json                    shared lower-camel hook shape for client adapters
.codex-plugin/plugin.json     Codex native compatibility manifest
.cursor-plugin/plugin.json    Cursor native compatibility manifest
hooks/                        harness-specific hook manifests
bin/agent-lcm                 source and npm CLI entry point
dist/                         generated npm runtime
```

Agent Plugins 1.0 standardizes skills and MCP servers. Hooks remain
client-specific, so `agent-lcm setup <harness>` installs the matching capture
configuration when a client does not load a bundled hook manifest.

The npm package and each native plugin copy can start the same per-user daemon.
Daemon protocol compatibility, not package release version, decides whether a
running daemon can be reused. This prevents independently cached plugin versions
from replacing one another while preserving orderly replacement for an
incompatible protocol.

## Harness lifecycle

`agent-lcm setup <harness>` probes and, where supported, runs the client's native
plugin commands before updating legacy capture hooks. Codex uses `codex plugin
list`, adds the installed package directory as a local marketplace, then runs
`codex plugin add agent-lcm@agent-lcm`. Copilot CLI and VS Code use the shared
Copilot store and install that same local package directory after `copilot
plugin list` succeeds.
Cursor and Kiro run version-only probes for `cursor-agent` and `kiro-cli`.
Their Marketplace or Powers steps remain manual, so their native result is
`manual-required`.

`agent-lcm remove <harness>` removes only exact Agent LCM-owned legacy hooks.
Codex runs `codex plugin remove agent-lcm@agent-lcm`. Copilot and VS Code share a
native store, so either single-harness removal returns `shared-retained` and
does not invoke an uninstall. Deliberate shared removal remains a documented
manual Copilot action after both clients are reviewed.

Lifecycle reports use exit status `0` for `complete`, `2` for
`manual-required` or `shared-retained`, and `1` for an error. Existing hook
configuration is validated before native work. Unrelated entries and
near-matching commands remain untouched; only an exact harness/event/command
registration is changed.

Setup files use `<target>.lock.sqlite` with a SQLite `BEGIN IMMEDIATE` lock
(bounded to ten seconds). Publication writes a unique `wx` temporary file with
restrictive permissions, fsyncs it, renames it, and fsyncs the parent directory.
Symlinked or non-regular targets are refused, hook commands must be absolute and
shell-safe, and changed files receive a collision-safe `-pre-agent-lcm-` backup.

## Capture and retrieval flow

1. A harness invokes `agent-lcm capture --harness ...` with a lifecycle event.
2. The adapter maps the native event to the shared schema and adds harness
   provenance to the session ID and event row.
3. Redaction and size limits run before any durable write.
4. The hook atomically publishes the sanitized event to `inbox/`. It never
   opens the raw archive or SQLite.
5. The hook ensures that one per-user daemon is running and returns.
6. The daemon drains complete inbox files, appends new events to the raw
   archive, and updates the derived SQLite index.
7. MCP bridges and storage CLI commands authenticate over local IPC and use the
   same daemon.

The inbox separates fast harness hooks from database work. Atomic publication
also gives the daemon a clear rule: a `.json` file is complete, while temporary
files are not ready to consume.

Daemon requests run through one promise chain. A SQLite ownership transaction
prevents a second daemon from taking the same store, and an endpoint token
authenticates local requests. The default endpoint is a Unix socket; Windows
uses a named pipe. Long Unix home paths use a short private socket directory.

## Event schema

Every event includes:

- `schema_version`
- `event_id`
- `timestamp`
- `harness`
- `native_event`
- `hook_event`
- a harness-prefixed `session_id`
- `cwd`
- optional repository, branch, turn, tool, and agent metadata
- sanitized `payload`
- redaction and truncation records
- source hash and byte counts

Harness-prefixed session IDs prevent native ID collisions. Retrieval results
also carry harness provenance. Search, listing, context packing, usage, and
query expansion accept optional `harnesses` filters; no filter means all
harnesses.

## Shared storage

The default home is `~/.agent-lcm`:

```text
events.jsonl                  active raw append target, capped at 64 MiB
segments/
  manifest.json
  *.jsonl.gz                  verified closed segments
index.sqlite                  derived search and summary data
overflow/                     bounded sanitized large values
inbox/                        durable capture queue
quarantine/                   invalid inbox records
runtime/                      daemon endpoint, token, and ownership data
```

`AGENT_LCM_HOME` selects another store. One home maps to one daemon and one
cross-harness database.

The active log and manifest-listed segments are authoritative. SQLite is
derived and can be rebuilt. A raw append completes before index work, so an
index failure does not discard the captured event.

When the active log reaches its cap, the writer closes it as a manifest-listed
segment and opens a fresh `events.jsonl`. Daemon maintenance then:

1. verifies the segment checksum and event locations;
2. compresses the segment with gzip level 1;
3. confirms that archived events can be read through their byte locators; and
4. clears duplicate full event JSON from the corresponding SQLite rows.

This keeps one compressed source copy plus the smaller derived data. A
resumable migration handles an older single-file development store. Malformed
legacy records go to a segment quarantine instead of being silently dropped.

Raw retention is unlimited unless `AGENT_LCM_RETENTION_DAYS` is a positive
integer. Retention applies only to closed source segments. It removes detailed
event rows and orphaned overflow files for expired segments but preserves
session and summary rows.

## Derived index

SQLite stores sessions, event metadata and locators, FTS rows, file references,
session summaries, and multi-depth summary nodes. The main tables are:

- `sessions`
- `events`
- `event_fts`
- `session_summaries`
- `session_summary_fts`
- `summary_nodes`
- `summary_node_fts`
- `file_refs`

Full-text search indexes discovery signals such as prompts, outcomes, and
compaction summaries. Large tool payloads remain in the raw archive or local
overflow files instead of being copied into every search surface.

Session summaries are deterministic and extractive. D0 summary nodes cover
bounded groups of high-signal events; deeper nodes summarize lower-depth nodes.
Each node records its source IDs, so retrieval can return the compact summary
first and expand only the matching lineage.

The graph is derived on read. It contains session, turn, event, checkpoint, and
summary nodes with `contains`, `next`, `tool_result`, `checkpoint`, and
`summary_source` edges. Agent LCM does not persist a second graph projection.

## Import flow

Importers read source files without modifying them, normalize records through
the same harness adapters, and send bounded authenticated batches to the shared
daemon. The daemon bulk-ingests each batch, defers summary work, and rebuilds
each touched session once after the import. Imports are idempotent and do not
create one inbox file per event; hooks still use the durable inbox.

Codex, GitHub Copilot, and Kiro have default local search paths. Cursor accepts
chat Markdown exports. VS Code accepts JSON conversation exports or OTLP JSON.
Malformed JSONL records are rejected individually so later valid records still
import.

## MCP protocol

The stdio server accepts newline-delimited JSON-RPC and Content-Length framed
messages. It implements `initialize`, `ping`, `tools/list`, and `tools/call`.
The bridge does not open storage directly; each tool request goes to the shared
daemon.

The preferred retrieval path is `lcm_grep` to `lcm_describe` to `lcm_expand`.
`lcm_expand_query` selects and expands matching lineage in one bounded request,
while `lcm_pack_context` produces model-ready Markdown for recovery after
compaction, interruption, or handoff.
