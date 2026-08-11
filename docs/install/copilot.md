# Install Agent LCM in GitHub Copilot CLI

## What setup does

Run:

```sh
agent-lcm setup copilot
```

This runs the Copilot native lifecycle when the CLI is available and its plugin
probe succeeds. Copilot CLI auto-loads the bundled hooks, so setup does not add
duplicate shared hooks after native installation. The manual fallback path is
`~/.copilot/hooks/agent-lcm.json`; setup preserves an existing fallback when
native installation is unavailable, adds no new duplicate, and reports
`manual-required` with this guide.

## Native install and inspection

Use the documented Copilot CLI commands:

```sh
copilot plugin install Team-Volt/agent-lcm
copilot plugin list
```

The list command shows installed plugins. See the [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) for the command set and plugin specification.

The Copilot CLI reference does not require a restart after installation. If a
new plugin is not visible, start a new Copilot session as troubleshooting and
run `copilot plugin list` again.

> Warning: GitHub Copilot CLI and VS Code share the Copilot plugin store and the hook file `~/.copilot/hooks/agent-lcm.json`. A deliberate native uninstall affects both harnesses. Do not uninstall the shared plugin when you mean to remove only Copilot CLI.

## Remove Agent LCM

The safe single-harness command retains the shared plugin and hook resources:

```sh
agent-lcm remove copilot
```

It reports `shared-retained` and leaves the shared store and hook file
unchanged. To deliberately remove the shared native installation from both
harnesses, run:

```sh
copilot plugin uninstall agent-lcm
```

Review both harnesses before removing the shared hook file. Do not delete
unrelated entries from `~/.copilot/hooks/agent-lcm.json`.
