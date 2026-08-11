# Agent LCM repository guide

## Overview

Agent LCM is an Agent Plugins 1.0 package that captures sessions from several
coding-agent harnesses into one local per-user store. The repository root is the
package root.

## Layout

```text
plugin.json                 Agent Plugins manifest
mcp.json                    portable MCP server
skills/                     portable Agent Skills
.codex-plugin/              Codex compatibility manifest
.cursor-plugin/             Cursor compatibility manifest
hooks.json, hooks/          capture hook manifests
bin/agent-lcm               executable entry point
src/                        TypeScript implementation
tests/                      Node test suite
docs/                       architecture and troubleshooting
```

## Storage invariants

- `events.jsonl` and manifest-listed segments are authoritative.
- SQLite, FTS, summaries, and graph views are derived and rebuildable.
- Capture hooks publish sanitized inbox files; they do not open storage.
- The shared daemon serializes inbox, MCP, and storage CLI work.
- Retrieval is cross-harness by default. Optional harness filters must preserve
  provenance in every result.
- Do not add `lcm_record_note`; Agent LCM has no note-writing MCP tool.

## Harness setup and removal

- `agent-lcm setup <harness>` uses native lifecycle commands only for Codex and
  the shared Copilot/VS Code store; Cursor Marketplace and Kiro Powers remain
  manual. `agent-lcm remove <harness>` removes only exact Agent LCM-owned hook
  entries.
- Setup reports `complete` with exit `0`; `manual-required` and
  `shared-retained` use exit `2`; command errors use exit `1`.
- Copilot and VS Code share the native plugin store. Single-harness removal
  must retain that plugin and leave any legacy fallback hook file unchanged.
- The repository root manifest declares Agent Plugins 1.0 for Kiro and portable
  skills/MCP clients. The npm artifact must omit it so Codex and Cursor select
  their native hook manifests. Copilot/VS Code setup installs the generated
  native package whose hook and MCP commands use the absolute Agent LCM
  executable.
- Successful native Codex setup must not create `~/.codex/hooks.json`; it may
  remove only exact Agent LCM fallback entries from an existing file.
- Setup-file mutation runs through the directory-anchored helper. Do not
  replace it with path checks followed by later path-based writes.
- Validate existing setup JSON before native work. Preserve unrelated and
  near-matching hooks, reject symlinked or non-regular targets, and publish
  changes under an atomic `<target>.lock` directory through a unique fsynced
  temporary file and rename.
- If a hook file changes during native work, preserve the new bytes and report
  whether the native action completed or setup stopped; never hide it behind a
  generic file error.

See `src/AGENTS.md` and `tests/AGENTS.md` for more specific rules.

## Commands

Run from the repository root:

```sh
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

Use a temporary `AGENT_LCM_HOME` for experiments. Never run destructive checks
against the user's live store.
