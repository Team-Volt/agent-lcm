# Install Agent LCM in GitHub Copilot CLI

## What setup does

Run:

```sh
agent-lcm setup copilot
```

When the CLI is available, setup builds a private Copilot-format package with
the absolute installed Agent LCM command, then runs `copilot plugin install`.
The package includes the recall skill, capture hooks, and MCP server. Copilot
CLI copies it into its plugin store, so setup removes the temporary source
after installation. Setup does not add duplicate shared hooks. The legacy
fallback path is `~/.copilot/hooks/agent-lcm.json`; setup preserves an existing fallback when
native installation is unavailable, adds no new duplicate, and reports
`manual-required` with this guide.

## Native install and inspection

If setup reports that `copilot` is missing, install Copilot CLI using GitHub's
[official install guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli),
then rerun setup:

```sh
agent-lcm setup copilot
copilot plugin list
```

Do not use the repository root as a substitute for setup. Its Agent Plugins
manifest contains portable skills and MCP but no hooks. Setup writes the
client-specific hooks and the absolute installed command into a Copilot-format
package. The list command shows the installed plugin. See the
[Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
for the supported command set.

The Copilot CLI reference does not require a restart after installation. If a
new plugin is not visible, start a new Copilot session as troubleshooting and
run `copilot plugin list` again.

`agent-lcm setup status` reports legacy `hooksConfigured` state, not live
native plugin health. `false` is expected after a successful native install;
use `copilot plugin list` for the native check.

> Warning: GitHub Copilot CLI and VS Code share the native Copilot plugin store. A deliberate native uninstall affects both harnesses. Do not uninstall the shared plugin when you mean to remove only Copilot CLI. A legacy `~/.copilot/hooks/agent-lcm.json` fallback, if present, is separate.

## Remove Agent LCM

The safe single-harness command retains the shared native plugin:

```sh
agent-lcm remove copilot
```

It reports `shared-retained`, leaves the shared store unchanged, and does not
edit a legacy fallback hook file. To deliberately remove the shared native
installation from both harnesses, run:

```sh
copilot plugin uninstall agent-lcm
```

Review both harnesses before removing the shared hook file. Do not delete
unrelated entries from `~/.copilot/hooks/agent-lcm.json`.
