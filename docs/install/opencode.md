# Install Agent LCM in OpenCode

## What setup does

This integration targets stable OpenCode plugins. It does not target OpenCode 2
beta and does not provide historical session import. Setup automates live
capture and configures the Agent LCM MCP server when OpenCode uses a supported
JSON configuration.

Run:

```sh
agent-lcm setup opencode
```

Setup writes the generated global plugin to:

```text
~/.config/opencode/plugins/agent-lcm.ts
```

Use `--home PATH` when OpenCode uses another configuration directory. For
OpenCode, `--home` means that configuration directory, so the plugin is written
to `<PATH>/plugins/agent-lcm.ts`; it does not select the Agent LCM store.

It also adds or updates `mcp.agent-lcm` in `<PATH>/opencode.json`:

```json
{
  "mcp": {
    "agent-lcm": {
      "type": "local",
      "command": ["node", "/absolute/path/to/agent-lcm", "mcp"],
      "enabled": true
    }
  }
}
```

Existing configuration and unrelated MCP entries are preserved. Re-running
setup updates the owned command when the installed Agent LCM binary moves.
The plugin captures stable session, prompt, and tool events exposed by OpenCode.
`agent-lcm setup status` reports both plugin and MCP state for OpenCode.

## JSONC configuration

If `<PATH>/opencode.jsonc` exists, setup edits that file instead of creating
`opencode.json`. It preserves comments, trailing commas, and unrelated settings.
The command completes with exit `0` after it enables capture and configures MCP.

See the official [OpenCode plugin documentation](https://opencode.ai/docs/plugins/)
and [OpenCode configuration documentation](https://opencode.ai/docs/config/) for
the plugin location and configuration model.

## Remove Agent LCM

Run:

```sh
agent-lcm remove opencode
```

For a non-default configuration directory, pass the same `--home PATH` used for
setup. Removal disables capture with the durable
`.agent-lcm-opencode-plugin.state` marker instead of deleting the generated
plugin path, then removes only the exact owned `mcp.agent-lcm` entry. Unrelated
configuration and plugin files are preserved. If `opencode.jsonc` exists,
removal deletes only the exact owned MCP entry from it. It also cleans an exact
owned entry from `opencode.json` when both files exist.
