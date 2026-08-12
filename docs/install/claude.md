# Install Agent LCM in Claude Code

## What setup does

Run:

```sh
agent-lcm setup claude
```

Setup uses Claude Code's native plugin commands. It adds the installed Agent
LCM package as the user marketplace when needed, then installs or updates the
user-scoped `agent-lcm@agent-lcm` plugin. Run the same command after upgrading
Agent LCM. Setup detects Claude Code when `~/.claude` exists during:

```sh
agent-lcm setup all
```

Use `--home PATH` when Claude uses another configuration directory. For Claude
Code, this option sets `CLAUDE_CONFIG_DIR` to that directory. It does not select
the Agent LCM store and it does not edit `settings.json`.

If the `claude` executable is missing, setup reports `manual-required` and
prints this guide. A successful setup reports `complete`.

## Native install and inspection

The npm package includes the Claude Code package surface:

- `.claude-plugin/plugin.json` contains the Claude plugin metadata.
- `.claude-plugin/marketplace.json` names the local marketplace and uses `.` as
  the plugin source.
- `hooks/hooks.json` contains exactly `SessionStart`, `UserPromptSubmit`,
  `PostToolUse`, and `Stop`.
- `mcp.claude.json` starts `bin/agent-lcm mcp` through
  `${CLAUDE_PLUGIN_ROOT}`.

To install the package with Claude Code's documented CLI, resolve the global
npm package directory and add it as a user marketplace:

```sh
CLAUDE_PACKAGE_ROOT="$(npm root --global)/@team-volt/agent-lcm"
claude plugin marketplace add "$CLAUDE_PACKAGE_ROOT" --scope user
claude plugin install agent-lcm@agent-lcm --scope user
claude plugin list --json
```

The official [Claude Code plugin marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces)
documents local marketplace paths and these CLI commands. Review the package
source before allowing its hooks or MCP server.

After installing or updating, run `/reload-plugins` in Claude Code. If the
plugin still does not appear, start a new Claude Code session or restart the
client, then run `claude plugin list --json` again.

`agent-lcm setup status` does not inspect Claude's native plugin cache. It
always reports `hooksConfigured: false` with the Claude `settings.json` path;
this is a display path, not a file that setup manages. `agent-lcm doctor --json`
also reports Claude native plugin health as `unknown`. Use
`claude plugin list --json` or Claude Code's installed-plugin view for that
check.

## Capture scope

Claude Code support is live capture only. Agent LCM receives these four native
events:

- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `Stop`

Agent LCM has no historical Claude Code importer. Sessions from before the
plugin was installed remain outside the shared store.

## Remove Agent LCM

Run:

```sh
agent-lcm remove claude
```

The command lists Claude's plugins and uninstalls only the user-scoped
`agent-lcm@agent-lcm` plugin. It leaves the `agent-lcm` marketplace configured.
If the Claude CLI is unavailable, finish the native removal manually:

```sh
claude plugin list --json
claude plugin uninstall agent-lcm@agent-lcm --scope user
```

Do not remove the marketplace unless you intend to remove that configuration as
well. The setup command creates it at user scope, so use the matching scope:

```sh
claude plugin marketplace remove agent-lcm --scope user
```

After removal, confirm the native state with `claude plugin list --json` and
confirm Agent LCM's local report with `agent-lcm setup status`.
