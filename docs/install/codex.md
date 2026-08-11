# Install Agent LCM in Codex

## What setup does

Run:

```sh
agent-lcm setup codex
```

This runs the Codex native lifecycle against the installed Agent LCM package
directory when the CLI is available and its plugin probe succeeds. The Codex
manifest includes the recall skill, MCP server, and capture hooks. After native
installation succeeds, setup removes only exact Agent LCM entries left by older
versions in `~/.codex/hooks.json` so capture does not run twice. It does not
create that user hook file. If the native probe is unavailable, setup reports
`manual-required` and leaves any existing fallback untouched.

## Native install and inspection

Use the documented Codex plugin flow with the installed npm package directory.
`npm root --global` prints the `<global-node-modules>` part of this path:

```sh
codex plugin marketplace add <global-node-modules>/@team-volt/agent-lcm
codex plugin add agent-lcm@agent-lcm
codex plugin list
```

Do not type the angle-bracket placeholder as written. The published npm package
omits the repository's portable root manifest so Codex selects
`.codex-plugin/plugin.json`, including its native hooks. Do not substitute a
source checkout: its root `plugin.json` is the Kiro/Agent Plugins package, which
Codex treats as skills and MCP only. The first two commands add the local npm
package and the last command lists installed plugins. See the [Codex plugin installation reference](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/plugin-creator/references/installing-and-updating.md).

After installation, start a new Codex thread so it picks up the plugin. If
Codex asks you to trust plugin-owned commands, review the commands and approve
them only if you expect them.

## Remove Agent LCM

The Agent LCM command removes the native plugin and only exact legacy Agent LCM
entries from `~/.codex/hooks.json`, if that file exists:

```sh
agent-lcm remove codex
```

If the Codex CLI is unavailable, the command removes only those legacy hooks, reports
`manual-required`, and links back here. Finish the native removal with:

```sh
codex plugin remove agent-lcm@agent-lcm
```

Check the native result with `codex plugin list` and `agent-lcm doctor --json`.
`agent-lcm setup status` reports only legacy hook-file state.
