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

See `src/AGENTS.md` and `tests/AGENTS.md` for more specific rules.

## Harness integration changes

- Inspect the relevant Git history and merged PR validation before changing a
  client manifest, hook schema, path token, or launch command.
- Treat a successful live-client validation as a compatibility invariant. Do
  not replace it based only on documentation or a synthetic test; reconcile the
  conflict or preserve the proven behavior.
- Tests for bundled commands must use the client's real path expansion and a
  working directory that does not accidentally make relative paths succeed.
- Changing an existing integration expectation requires an explicit root-cause
  explanation and evidence that the replacement works in the target client.
- When a live client cannot be exercised, keep the PR in draft and state the
  unverified boundary rather than claiming end-to-end compatibility.

## Pull request gate

Before creating a pull request:

1. Freeze the candidate diff and run the complete validation suite.
2. Run an independent adversarial review whose goal is to find reasons the
   change should not merge. The reviewer must inspect Git history, altered test
   expectations, host contracts, packaging behavior, and unsupported claims.
3. Address every finding, rerun validation, and perform a second adversarial
   pass over the resulting diff.
4. Create the PR only when the second pass has no unresolved correctness or
   regression findings. Record untestable boundaries in the PR description and
   keep the PR draft when a required live integration was not exercised.

The implementer must not treat a reviewer that edited the code as independent,
and a passing test suite does not override contradictory live-client evidence.

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
