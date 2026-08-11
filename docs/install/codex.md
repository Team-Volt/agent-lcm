# Install Agent LCM in Codex

## What setup does

Run:

```sh
agent-lcm setup codex
```

This runs the Codex native lifecycle against the installed Agent LCM package
directory when the CLI is available and its plugin probe succeeds. Codex does
not accept hooks in its plugin manifest, so setup
also installs or repairs the capture hooks at `~/.codex/hooks.json`. If the native
probe is unavailable, setup reports `manual-required` with this guide while
keeping that hook path available for capture.

## Native install and inspection

Use the documented Codex plugin flow with the local directory that contains
Agent LCM's `plugin.json`. For a global npm install, `npm root --global` prints
the `<global-node-modules>` part of this path:

```sh
codex plugin marketplace add <global-node-modules>/@team-volt/agent-lcm
codex plugin add agent-lcm@agent-lcm
codex plugin list
```

Do not type the angle-bracket placeholder as written. If you run Agent LCM from
a source checkout, use that checkout's root instead. The first two commands add
the local package and the last command lists installed plugins. See the [Codex plugin installation reference](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/plugin-creator/references/installing-and-updating.md).

After installation, start a new Codex thread so it picks up the plugin. If
Codex asks you to trust plugin-owned commands, review the commands and approve
them only if you expect them.

## Remove Agent LCM

The Agent LCM command removes the native plugin and only Agent LCM's entries
from `~/.codex/hooks.json`:

```sh
agent-lcm remove codex
```

If the Codex CLI is unavailable, the command removes the hooks, reports
`manual-required`, and links back here. Finish the native removal with:

```sh
codex plugin remove agent-lcm@agent-lcm
```

Check the result with `agent-lcm setup status` and `agent-lcm doctor --json`.
