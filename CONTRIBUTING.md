# Contributing to Agent LCM

Agent LCM stores local coding-agent history. Changes must preserve raw events,
keep private data out of the repository, and leave existing harness setup alone
unless the change targets it.

## Before you start

Use Node.js 22.18 or newer. Install the development dependencies from the
repository root:

```sh
npm install
```

Read the nearest `AGENTS.md` before editing. The root guide covers repository
rules. `src/AGENTS.md` and `tests/AGENTS.md` add rules for their directories.

Create a branch for your change. Keep unrelated edits out of it, and do not
commit secrets, tokens, real session text, generated stores, or local database
files.

## Make the change

Follow the ownership map in `src/AGENTS.md`. Keep raw JSONL and manifest-listed
segments authoritative; SQLite, search indexes, summaries, and graphs must stay
rebuildable. Capture hooks publish sanitized inbox files and leave storage work
to the shared daemon.

Use synthetic data for fixtures. If you need to inspect a real harness file,
copy it to a temporary directory, avoid printing its content, and delete the
copy after the check. Run experiments with a temporary `AGENT_LCM_HOME`. Stop
its daemon before removing that exact temporary directory.

The repository tracks compiled files in `dist/`. Run `npm run compile` after a
source change and include the matching generated output.

## Test the change

Start with the smallest test that covers the behavior, then run the full checks
from the repository root:

```sh
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

Run one test file with Node's built-in runner:

```sh
node --no-warnings --test tests/import.test.ts
```

Tests must use temporary homes and close databases, workers, daemons, and child
processes. They must not depend on network access, test order, wall-clock sleeps,
or a user's live Agent LCM store.

## Documentation and pull requests

Update README and files under `docs/` when behavior, commands, setup, storage,
or security rules change. Update the relevant `AGENTS.md` when module ownership
or contributor rules change.

Keep commits focused. In the pull request, state the problem, the chosen
behavior, the checks you ran, and any limit that remains. Include a failing test
for a bug or new behavior when one can prove the boundary. Do not weaken a
failing test to make the suite pass.
