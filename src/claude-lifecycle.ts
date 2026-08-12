import path from "node:path";

export class ClaudeLifecycleOutputError extends Error {
  readonly name = "ClaudeLifecycleOutputError";
  readonly argv: readonly string[];

  constructor(argv: readonly string[]) {
    super("Claude CLI returned malformed lifecycle JSON.");
    this.argv = argv;
  }
}

type ClaudeMarketplace = {
  readonly name: string;
  readonly source: string;
  readonly path: string;
  readonly installLocation: string;
};

type ClaudePlugin = {
  readonly id: string;
  readonly version: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly installPath: string;
  readonly installedAt: string;
  readonly lastUpdated: string;
};

export function runClaudeLifecycle(
  action: "setup" | "remove",
  packageRoot: string,
  run: (argv: readonly string[]) => string,
): void {
  if (action === "remove") {
    const argv = ["plugin", "list", "--json"] as const;
    const plugins = parseRecords(run(argv), argv, isClaudePlugin);
    if (hasUserPlugin(plugins)) run(["plugin", "uninstall", "agent-lcm@agent-lcm", "--scope", "user"]);
    return;
  }

  const marketplaceArgv = ["plugin", "marketplace", "list", "--json"] as const;
  const marketplaces = parseRecords(run(marketplaceArgv), marketplaceArgv, isClaudeMarketplace);
  const marketplace = marketplaces.find((entry) => entry.name === "agent-lcm");
  if (marketplace !== undefined && path.resolve(marketplace.path) !== packageRoot) {
    throw new ClaudeLifecycleOutputError(marketplaceArgv);
  }
  if (marketplace === undefined) run(["plugin", "marketplace", "add", packageRoot, "--scope", "user"]);

  const pluginArgv = ["plugin", "list", "--json"] as const;
  const plugins = parseRecords(run(pluginArgv), pluginArgv, isClaudePlugin);
  run(["plugin", hasUserPlugin(plugins) ? "update" : "install", "agent-lcm@agent-lcm", "--scope", "user"]);
}

function parseRecords<T>(stdout: string, argv: readonly string[], isRecordType: (value: unknown) => value is T): readonly T[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ClaudeLifecycleOutputError(argv);
  }
  if (!Array.isArray(value) || !value.every(isRecordType)) throw new ClaudeLifecycleOutputError(argv);
  return value;
}

function hasUserPlugin(plugins: readonly ClaudePlugin[]): boolean {
  return plugins.some((plugin) => plugin.id === "agent-lcm@agent-lcm" && plugin.scope === "user");
}

function isClaudeMarketplace(value: unknown): value is ClaudeMarketplace {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.source === "string"
    && typeof value.path === "string"
    && typeof value.installLocation === "string";
}

function isClaudePlugin(value: unknown): value is ClaudePlugin {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.version === "string"
    && typeof value.scope === "string"
    && typeof value.enabled === "boolean"
    && typeof value.installPath === "string"
    && typeof value.installedAt === "string"
    && typeof value.lastUpdated === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
