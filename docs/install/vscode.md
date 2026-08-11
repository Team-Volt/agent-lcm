# Install Agent LCM in VS Code

## What setup does

Run:

```sh
agent-lcm setup vscode
```

This runs the Copilot native lifecycle when the CLI is available and its plugin
probe succeeds. VS Code auto-loads hooks from the Copilot plugin store, so setup
does not add duplicate shared hooks after native installation. The manual
fallback path is `~/.copilot/hooks/agent-lcm.json`; setup preserves an existing
fallback when native installation is unavailable, adds no new duplicate, and
reports `manual-required` with this guide.

## Native install and inspection

VS Code automatically discovers plugins installed by Copilot CLI from
`~/.copilot/installed-plugins/`. To install through that shared store, run:

```sh
copilot plugin install Team-Volt/agent-lcm
copilot plugin list
```

You can install from the VS Code UI instead. Open Extensions and search for
`@agentPlugins`, or run `Chat: Install Plugin From Source` from the Command
Palette and enter `https://github.com/Team-Volt/agent-lcm`. Inspect the result in
the Agent Plugins - Installed view. See the [VS Code agent plugin guide](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

If VS Code asks you to trust a new marketplace or repository, review the source
before confirming. The official guide does not require a restart. If the plugin
does not appear, use the documented Installed view and Command Palette refresh
actions as troubleshooting.

> Warning: VS Code and GitHub Copilot share the Copilot plugin store and the hook file `~/.copilot/hooks/agent-lcm.json`. A deliberate native uninstall affects both harnesses. Do not uninstall the shared plugin when you mean to remove only VS Code.

## Remove Agent LCM

The safe single-harness command retains the shared plugin and hook resources:

```sh
agent-lcm remove vscode
```

It reports `shared-retained` and leaves the shared store and hook file
unchanged. To deliberately remove the shared native installation from both
harnesses, use the Copilot command:

```sh
copilot plugin uninstall agent-lcm
```

Then manage the shared hook file only after reviewing both harnesses' needs.
