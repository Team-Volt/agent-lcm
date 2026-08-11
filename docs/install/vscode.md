# Install Agent LCM in VS Code

## What setup does

Run:

```sh
agent-lcm setup vscode
```

When Copilot CLI is available, setup builds a private Copilot-format package
with the absolute installed Agent LCM command and installs it into the shared
plugin store. The package includes the recall skill, capture hooks, and MCP
server. VS Code discovers that store, so setup does not add duplicate shared
hooks after native installation. The legacy
fallback path is `~/.copilot/hooks/agent-lcm.json`; setup preserves an existing
fallback when native installation is unavailable, adds no new duplicate, and
reports `manual-required` with this guide.

## Native install and inspection

VS Code automatically discovers plugins installed by Copilot CLI from
`~/.copilot/installed-plugins/`. If setup reports that `copilot` is missing,
install Copilot CLI using GitHub's [official install guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli),
then rerun:

```sh
agent-lcm setup vscode
copilot plugin list
```

Do not use the repository root from the VS Code command palette as a substitute
for setup. VS Code detects its Agent Plugins manifest, whose portable
components do not include hooks. Setup creates the Copilot-format package that
includes capture hooks and absolute local commands. You can
inspect, enable, disable, or uninstall it in VS Code's Agent Plugins view. See
the [VS Code agent plugin guide](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

If VS Code asks you to trust a new marketplace or repository, review the source
before confirming. The official guide does not require a restart. If the plugin
does not appear, use the documented Installed view and Command Palette refresh
actions as troubleshooting.

`agent-lcm setup status` reports legacy `hooksConfigured` state, not live
native plugin health. `false` is expected after a successful native install;
use the Agent Plugins - Installed view or `copilot plugin list` for the native
check.

> Warning: VS Code and GitHub Copilot share the native Copilot plugin store. A deliberate native uninstall affects both harnesses. Do not uninstall the shared plugin when you mean to remove only VS Code. A legacy `~/.copilot/hooks/agent-lcm.json` fallback, if present, is separate.

## Remove Agent LCM

The safe single-harness command retains the shared native plugin:

```sh
agent-lcm remove vscode
```

It reports `shared-retained`, leaves the shared store unchanged, and does not
edit a legacy fallback hook file. To deliberately remove the shared native
installation from both harnesses, use the Copilot command:

```sh
copilot plugin uninstall agent-lcm
```

Then manage any legacy fallback hook file only after reviewing both harnesses'
needs.
