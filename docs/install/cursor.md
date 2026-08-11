# Install Agent LCM in Cursor

## What setup does

Run:

```sh
agent-lcm setup cursor
```

Cursor plugins package their hooks. Setup probes `cursor-agent --version`, then
validates and preserves any legacy
capture file at `~/.cursor/hooks.json`, but it does not add another copy of the
same hooks. Cursor has no stable native install or remove CLI in the supported
documentation, so setup reports `manual-required` for the native step.

## Native install and inspection

Open Cursor's Customize page and install Agent LCM if it is available in a
marketplace you trust. Until it is listed, Cursor documents this local plugin
path for development installs:

```sh
mkdir -p ~/.cursor/plugins/local
git clone https://github.com/Team-Volt/agent-lcm.git ~/.cursor/plugins/local/agent-lcm
```

On Windows, use `%USERPROFILE%\.cursor\plugins\local\agent-lcm` as the target.
If the target already exists, inspect it instead of replacing it. Run
`Developer: Reload Window`, then verify Agent LCM under Customize. Cursor's
[plugin guide](https://cursor.com/docs/plugins) documents the local path and
reload step.

If Cursor shows a trust prompt, review the plugin source before accepting it.
The Marketplace documentation does not establish a required restart. If the
plugin or hooks look stale, close and reopen Cursor as troubleshooting, then
check `agent-lcm setup status`.

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
