# Install Agent LCM in GitHub Copilot CLI

## What setup does

Run:

```sh
agent-lcm setup copilot
```

This runs the Copilot native lifecycle against the installed Agent LCM package
directory when the CLI is available and its plugin probe succeeds. Copilot CLI
auto-loads the bundled hooks, so setup does not add
duplicate shared hooks after native installation. The manual fallback path is
`~/.copilot/hooks/agent-lcm.json`; setup preserves an existing fallback when
native installation is unavailable, adds no new duplicate, and reports
`manual-required` with this guide.

## Native install and inspection

Use the documented Copilot CLI commands with the local directory that contains
Agent LCM's `plugin.json`. For a global npm install, `npm root --global` prints
the `<global-node-modules>` part of this path:

```sh
copilot plugin install <global-node-modules>/@team-volt/agent-lcm
copilot plugin list
```

Do not type the angle-bracket placeholder as written. If you run Agent LCM from
a source checkout, use that checkout's root instead. The list command shows
installed plugins. See the [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) for the command set and plugin specification.

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
