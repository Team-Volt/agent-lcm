# Install Agent LCM in Kiro

## What setup does

Run:

```sh
agent-lcm setup kiro
```

This installs or repairs the Kiro capture hooks at
`~/.kiro/hooks/agent-lcm.json`. Kiro's native Power install remains a manual UI
step, so setup reports `manual-required` for that step.

## Native install and inspection

Open [Kiro Powers](https://kiro.dev/docs/powers/) in Kiro or on kiro.dev. Use
the Powers UI to browse the marketplace or install from a GitHub repository,
enter `https://github.com/Team-Volt/agent-lcm`, and click Install. The same
Powers UI shows the installed Power state.

The official Powers guide does not define a command-line install or a required
restart. If the Power or hooks look stale, close and reopen Kiro as
troubleshooting, then check `agent-lcm setup status`.

## Remove Agent LCM

Use the Powers UI's documented management control to remove Agent LCM. Kiro's
official Powers documentation does not define a native removal CLI. Then remove
only the Agent LCM hooks:

```sh
agent-lcm remove kiro
```

The command preserves unrelated entries in `~/.kiro/hooks/agent-lcm.json`.
