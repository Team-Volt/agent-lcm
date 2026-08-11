# Install Agent LCM in Kiro

## What setup does

Run:

```sh
agent-lcm setup kiro
```

This probes `kiro-cli --version`, then installs or repairs the Kiro capture hooks at
`~/.kiro/hooks/agent-lcm.json`. Kiro's native Power install remains a manual UI
step, so setup reports `manual-required` for that step.

## Native install and inspection

Open [Kiro Powers](https://kiro.dev/docs/powers/) in Kiro or on kiro.dev. Use
the Powers UI to browse the marketplace or install from a GitHub repository,
enter `https://github.com/Team-Volt/agent-lcm`, and click Install. The same
Powers UI shows the installed Power state. For Kiro, the repository root is
intentional: its `plugin.json`, `skills/`, and `mcp.json` form the Power. Hooks
remain in Kiro's separate hook file because Agent Plugins does not define them.

The official Powers guide does not define a command-line install or a required
restart. If the Power or hooks look stale, close and reopen Kiro as
troubleshooting, then check `agent-lcm setup status`.

## Remove Agent LCM

Kiro's official Powers installation page does not publish a CLI or a fixed UI
sequence for uninstalling a Power. Open the Powers panel, select Agent LCM, and
use the removal control shown by your installed Kiro version. Then remove only
the Agent LCM hooks:

```sh
agent-lcm remove kiro
```

The command preserves unrelated entries in `~/.kiro/hooks/agent-lcm.json`.
