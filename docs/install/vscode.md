# Install Agent LCM in VS Code

## What setup does

Run:

```sh
agent-lcm setup vscode
```

This runs the Copilot native lifecycle against the installed Agent LCM package
directory when the CLI is available and its plugin probe succeeds. VS Code
auto-loads hooks from the Copilot plugin store, so setup
does not add duplicate shared hooks after native installation. The manual
fallback path is `~/.copilot/hooks/agent-lcm.json`; setup preserves an existing
fallback when native installation is unavailable, adds no new duplicate, and
reports `manual-required` with this guide.

## Native install and inspection

VS Code automatically discovers plugins installed by Copilot CLI from
`~/.copilot/installed-plugins/`. To install through that shared store, use the
local directory that contains Agent LCM's `plugin.json`. For a global npm
install, `npm root --global` prints the `<global-node-modules>` part:

```sh
copilot plugin install <global-node-modules>/@team-volt/agent-lcm
copilot plugin list
```

Do not type the angle-bracket placeholder as written. If you run Agent LCM from
a source checkout, use that checkout's root instead.

You can install from the VS Code UI instead. Open Extensions and search for
`@agentPlugins`, or run `Chat: Install Plugin From Source` from the Command
Palette and enter `https://github.com/Team-Volt/agent-lcm`. Inspect the result in
the Agent Plugins - Installed view. See the [VS Code agent plugin guide](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

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
