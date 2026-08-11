# Install Agent LCM in Cursor

## What setup does

Run:

```sh
agent-lcm setup cursor
```

Cursor plugins package their hooks. Setup validates and preserves any legacy
capture file at `~/.cursor/hooks.json`, but it does not add another copy of the
same hooks. Cursor has no stable native install or remove CLI in the supported
documentation, so setup reports `manual-required` for the native step.

## Native install and inspection

Open the official [Cursor Marketplace](https://cursor.com/marketplace), find
Agent LCM when it is listed, and use the Marketplace UI to install it. Use the
Cursor plugin or Marketplace view to inspect its installed state. Do not use a
shell command for this step.

If Cursor shows a trust prompt, review the plugin source before accepting it.
The Marketplace documentation does not establish a required restart. If the
plugin or hooks look stale, close and reopen Cursor as troubleshooting, then
check `agent-lcm setup status`.

If an older Agent LCM version already configured `~/.cursor/hooks.json`, run
`agent-lcm remove cursor` immediately before installing the native plugin. That
removes only the legacy Agent LCM entries and avoids running both copies.

## Remove Agent LCM

Use Cursor's installed-plugin UI to remove Agent LCM. Then remove only its
capture hooks:

```sh
agent-lcm remove cursor
```

The command preserves unrelated entries in `~/.cursor/hooks.json`.
