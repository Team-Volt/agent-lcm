# Source Contributor Guide

## Ownership map

- `storage.ts` is the public storage facade and the ingestion/reconciliation boundary.
- `raw-log.ts` and `raw-segments.ts` own segmented JSONL I/O, locators, and the cross-process raw-log lock.
- `maintenance.ts` owns legacy cutover, segment compression, locator verification, and retention.
- `storage-persistence.ts` owns SQLite schema maintenance, derived-index writes, and rebuild helpers.
- `storage-context.ts`, `storage-search.ts`, `storage-sessions.ts`, and `storage-summaries.ts` own read/query and deterministic derived views.
- `storage-graph.ts` derives bounded graph slices from indexed events and summary lineage; it does not persist a graph projection.
- `overflow.ts` owns bounded, content-addressed overflow storage and recovery checks.

- `setup.ts`, `setup-adapters.ts`, `setup-hooks.ts`, and `setup-hook-status.ts` own harness lifecycle reports, native CLI adapters, exact-owned hook edits, and setup status. `setup-files.ts` owns validation, per-file locks, backups, and atomic setup-file publication.

## Storage invariants

- Sanitize and normalize input before inbox publication. Only the daemon drains inbox files into storage.
- Append the sanitized event to the active raw log under `withRawLogLock` before SQLite work.
- The active log and manifest-listed segments are authoritative. SQLite, FTS, session summaries, summary nodes, file references, and graph slices are derived and rebuildable.
- An indexing failure may surface as an index error, but must never discard an event that is already durable in the raw log. Retries must not duplicate raw event IDs.
- Hold the raw-log lock only for the smallest snapshot, duplicate check, append, rotation, or manifest publication. Do not perform SQLite indexing, summaries, or graph work while it is held.
- Treat malformed raw JSONL as evidence loss: permit non-destructive reads and appends, but block destructive index reconciliation until repair.
- Writable open may replay or reconcile derived state from raw JSONL. `readOnly: true` must neither create storage nor rebuild, backfill, compact, or mutate derived state.

## Derived views

- Summaries are deterministic and extractive from sanitized source events. Keep stable ordering, bounded long-session sampling, and exact source event IDs.
- Build graphs on demand from indexed event order and summary lineage. Keep slices bounded and never add a stored node/edge projection.
- Read-only diagnostics and retrieval must fall back to the segmented raw stream when SQLite is absent or fails, without attempting repair.

## Overflow and safety

- Keep oversized content confined to managed overflow storage. References are content-addressed with SHA-256 and recovery accepts only verified regular files inside that directory.
- Preserve byte limits, paging limits, and integrity checks. References rejected before a file read consume no scan bytes; every file actually read, including a hash-invalid payload, counts against the scan budget.
- Keep permissions restrictive for the home, raw log, lock coordinator, SQLite index, and overflow files.

## Source anti-patterns

- Do not make SQLite the source of truth, repair an index by deleting retained raw events, or add a parallel persisted graph.
- Do not silently skip malformed lines during destructive reconciliation.
- Do not let a derived-index transaction cover raw appends, or keep the raw-log lock during expensive work.
- Do not turn a read path into an implicit migration or backfill.

## Harness setup safety

- Probe and invoke only documented commands: Codex uses `codex plugin`; Copilot and VS Code use the shared `copilot plugin` store; Cursor and Kiro use version-only probes and keep plugin changes manual.
- Codex and Cursor native hooks depend on the packed npm artifact omitting the repository-root Agent Plugins manifest. Never add `plugin.json` back to `package.json#files` without redesigning native package selection.
- Native Codex setup removes exact legacy fallback hooks after install and never creates a user hook file.
- Generate the Copilot-format package at setup time so hooks and MCP use the validated absolute Agent LCM command. Keep its source basename `agent-lcm` so repeat direct installs update one native plugin.
- Validate existing setup JSON before starting a native process. Match owned hooks by harness, event, and command shape; preserve unrelated and near-matching entries.
- Native lifecycle state and hook JSON are not one transaction. If the file changes during native work, preserve its bytes and throw an explicit error that says the native action completed and tells the user to repair and rerun.
- Keep setup-file reads, backups, locks, and publication inside the helper process anchored to the validated target directory. A later path identity check does not make a path-based write safe. Refuse symlinked directory components, lock paths, targets, and non-regular files. Use a unique `wx` temporary file, restrictive permissions, fsync, rename, and directory fsync. Backups use the collision-safe `-pre-agent-lcm-` name.
- Build native plugin sources only from the current local package, never from a mutable remote ref. Treat only `ENOENT` as an unavailable CLI; all other native probe or command failures must stop before hook mutation and must not echo client stderr.
- Require an absolute hook binary path and reject shell metacharacters before writing configuration.
- Never uninstall the shared Copilot plugin for a single `copilot` or `vscode` removal; report `shared-retained` instead.
- `setup status` reports legacy/setup-managed `hooksConfigured` state only. Doctor must report native Copilot/VS Code health as unknown unless it has direct native evidence; it must not recommend setup from a missing legacy hook file.

## Test routing

- Storage, raw durability, reconciliation, locks, read-only behavior, cleanup, and overflow: `tests/storage.test.ts`.
- Public storage exports and raw-only scoped reads: `tests/storage-api.test.ts`.
- Deterministic summary selection and ranking: `tests/summary.test.ts`.
- On-demand graph, lineage, bounded packing, and migrations: `tests/dag.test.ts`.
