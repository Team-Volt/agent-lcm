# Install Agent LCM in Cursor

## What setup does

Run:

```sh
agent-lcm setup cursor
```

Cursor plugins package their hooks. Setup probes `cursor-agent --version`, then
validates and preserves any legacy capture file at `~/.cursor/hooks.json`, but
it does not add another copy. Cursor has no documented noninteractive plugin
install or remove command, so setup reports `manual-required` for the native
step.

## Native install and inspection

Open Cursor's Customize page and install Agent LCM if it is available in a
marketplace you trust. Until it is listed, Cursor documents loading a plugin
from `~/.cursor/plugins/local`. First run `npm root --global` and confirm the
Agent LCM package exists below the printed directory. Then, only if the target
does not already exist, link it on macOS or Linux:

```sh
mkdir -p ~/.cursor/plugins/local
ln -s <global-node-modules>/@team-volt/agent-lcm ~/.cursor/plugins/local/agent-lcm
```

Do not type the angle-bracket placeholder as written. On Windows, copy the
installed npm package into
`%USERPROFILE%\.cursor\plugins\local\agent-lcm` only after confirming the
target does not exist. Do not clone the repository root for this step: its
portable manifest contains skills and MCP only, so Cursor would not load the
native hook manifest. Run `Developer: Reload Window`, then verify Agent LCM
under Customize. Cursor's [plugin guide](https://cursor.com/docs/plugins)
documents the local path, both supported manifest formats, and the reload step.

If Cursor shows a trust prompt, review the plugin source before accepting it.
The Marketplace documentation does not establish a required restart. If the
plugin or hooks look stale, close and reopen Cursor as troubleshooting, then
check the plugin in Customize. `agent-lcm setup status` reports only legacy
hook-file state.

If an older Agent LCM version already configured `~/.cursor/hooks.json`, run
`agent-lcm remove cursor` immediately before installing the native plugin. That
removes only the legacy Agent LCM entries and avoids running both copies.

## Remove Agent LCM

Use Customize to remove a marketplace install. For a local install, move the
`~/.cursor/plugins/local/agent-lcm` directory out of the local plugin folder and
reload Cursor. Then remove only its capture hooks:

```sh
agent-lcm remove cursor
```

The command preserves unrelated entries in `~/.cursor/hooks.json`.
