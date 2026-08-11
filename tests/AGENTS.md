# Test guidance

Tests run with Node's built-in `node:test` runner against TypeScript files.
Keep tests dependency-free and use `node:assert/strict`; do not add a test
framework, fixture library, or custom runner.

## Running suites

- Run the full package suite from the repository root with `npm test`.
- Run one file with `node --no-warnings --test tests/storage.test.ts` (replace
  the path for the target suite).
- Route tests by surface: storage behavior belongs in `storage.test.ts` or
  `storage-api.test.ts`, protocol behavior in `mcp.test.ts`, and real command
  or hook behavior in `hook-cli.test.ts`.
- Native lifecycle adapter contracts and fake-CLI argv/outcome checks belong
  in `setup-adapters.test.ts`. End-to-end setup/remove reports, exit statuses,
  exact-owned hook edits, shared-retained behavior, lock handling, backups,
  and symlink-safe publication belong in `setup.test.ts`.
- Keep manifest, event, redaction, summary, and import coverage in their
  existing focused files instead of growing a catch-all suite.

## Isolation and fixtures

- Start each test that writes state with `tempHome()`. Pass that path as `home`
  to direct storage calls or as `AGENT_LCM_HOME` to CLI and subprocess helpers;
  never read or write a user's live LCM home.
- Use fixed session IDs, paths, payloads, and `now` callbacks so ordering and
  timestamps stay deterministic. Avoid `Date.now()`, random IDs, and sleeps.
- Close every `createStorage()` result, preferably in `try/finally`, and
  terminate workers and child processes before the test returns.
- Release simulated lock files, preload files, and other fault-injection
  artifacts after the assertion that uses them. Temporary homes may live under
  the OS temp directory, never inside the repository.
- Reuse helpers from `helpers.ts` (`tempHome`, `runCli`, `runMcp`,
  `readJsonl`, and `assertCliOk`) before adding another test utility.

## Real boundaries

- Use `runCli()` for the actual `bin/agent-lcm` subprocess and assert its exit
  status, stderr, and parsed stdout. Set a bounded timeout for lock or worker
  scenarios.
- Fake `codex`, `copilot`, `cursor-agent`, and `kiro-cli` executables must record
  argv and fail on demand; use them to prove the exact documented command
  vectors without touching a user's installed clients.
- Distribution tests must prove the npm artifact omits root `plugin.json`, keeps
  both native manifests, and runs bundled Codex hooks without creating a user
  hook file.
- Copilot setup tests must inspect the generated package during the fake
  install, assert its stable `agent-lcm` source basename and absolute hook/MCP
  command, and then confirm the temporary source was removed.
- Setup-file race tests may inject faults into the helper only through a
  disposable child-process preload; never add a production test bypass.
- Use `runMcp()` or `runCli(["mcp"], ...)` with newline or framed JSON to test
  the real stdio MCP server. Assert response IDs, errors, and continuation
  after malformed input; do not call dispatch functions directly for protocol
  coverage.
- Keep subprocess environments explicit: merge `AGENT_LCM_HOME` with the
  inherited environment through the helper rather than mutating `process.env`.

## Failure and concurrency cases

- Test `DatabaseSync` failures with a controlled injector or invalid fixture,
  then assert the exact observable error and the durable state left behind.
- Test raw-log locking with a known lock owner or worker boundary, not a blind
  race. Assert timeout status and message, release the owner, retry, and verify
  exactly-once persistence.
- For fsync or publication faults, assert the failed subprocess leaves no
  acknowledged event, then run the normal retry and verify one raw and one
  indexed event.
- For setup-file symlink races, swap the path at the old path-check/read or
  chmod boundary and prove descriptor-bound I/O neither reads nor changes the
  victim.
- Prefer direct assertions on counts, IDs, paths, and JSON fields over broad
  snapshots; preserve security checks that prove secrets are absent.

## Anti-patterns

- Do not depend on network, wall-clock timing, global files, or test order.
- Do not mock the CLI, MCP transport, filesystem durability, or lock protocol
  when the test claims to cover that boundary.
- Do not leave open `DatabaseSync` handles, workers, subprocesses, or lock
  files; leaked resources make later suites flaky.
- Do not claim native setup or removal coverage from unit calls alone: include
  the real CLI boundary and assert `0` for `complete`, `2` for
  `manual-required` or `shared-retained`, and `1` for command errors.
- Do not add generated databases, raw logs, overflow files, or ad hoc scripts
  to the checkout. Keep changes and fixtures local to the test that needs them.
