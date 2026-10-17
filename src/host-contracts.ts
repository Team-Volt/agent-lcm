export const EXPANDABLE_PLUGIN_ROOT_TOKENS = [
  "${PLUGIN_ROOT}",
  "${CURSOR_PLUGIN_ROOT}",
  "${CLAUDE_PLUGIN_ROOT}",
] as const;

export type ExpandablePluginRootToken = (typeof EXPANDABLE_PLUGIN_ROOT_TOKENS)[number];

export type PluginRootBinding =
  | { readonly kind: "expandable"; readonly token: ExpandablePluginRootToken }
  | { readonly kind: "relative" }
  | { readonly kind: "absolute-command" };

export type HookSchema =
  | "codex-nested"
  | "cursor-plugin-nested"
  | "cursor-setup-flat"
  | "portable-v1"
  | "claude-args"
  | "copilot-generated-v1";

export const HOST_IDS = [
  "codex",
  "cursorPlugin",
  "cursorSetup",
  "claude",
  "portable",
  "copilotGenerated",
] as const;

export type HostId = (typeof HOST_IDS)[number];

export type HostFile = {
  readonly path: string;
  readonly pluginRoot: PluginRootBinding;
};

export type HostContract = {
  readonly id: HostId;
  readonly hookSchema: HookSchema;
  readonly files: readonly HostFile[];
};

const PLUGIN_ROOT = { kind: "expandable", token: "${PLUGIN_ROOT}" } as const satisfies PluginRootBinding;
const CURSOR_PLUGIN_ROOT = { kind: "expandable", token: "${CURSOR_PLUGIN_ROOT}" } as const satisfies PluginRootBinding;
const CLAUDE_PLUGIN_ROOT = { kind: "expandable", token: "${CLAUDE_PLUGIN_ROOT}" } as const satisfies PluginRootBinding;
const RELATIVE = { kind: "relative" } as const satisfies PluginRootBinding;

export const HOST_CONTRACTS = {
  codex: {
    id: "codex",
    hookSchema: "codex-nested",
    files: [
      { path: "hooks/codex.json", pluginRoot: PLUGIN_ROOT },
      { path: ".mcp.json", pluginRoot: RELATIVE },
    ],
  },
  cursorPlugin: {
    id: "cursorPlugin",
    hookSchema: "cursor-plugin-nested",
    files: [
      { path: "hooks/cursor.json", pluginRoot: CURSOR_PLUGIN_ROOT },
      { path: "mcp.cursor.json", pluginRoot: CURSOR_PLUGIN_ROOT },
    ],
  },
  cursorSetup: {
    id: "cursorSetup",
    hookSchema: "cursor-setup-flat",
    files: [],
  },
  claude: {
    id: "claude",
    hookSchema: "claude-args",
    files: [
      { path: "hooks/hooks.json", pluginRoot: CLAUDE_PLUGIN_ROOT },
      { path: "mcp.claude.json", pluginRoot: CLAUDE_PLUGIN_ROOT },
    ],
  },
  portable: {
    id: "portable",
    hookSchema: "portable-v1",
    files: [
      { path: "hooks.json", pluginRoot: PLUGIN_ROOT },
      { path: "mcp.json", pluginRoot: PLUGIN_ROOT },
    ],
  },
  copilotGenerated: {
    id: "copilotGenerated",
    hookSchema: "copilot-generated-v1",
    files: [],
  },
} satisfies Record<HostId, HostContract>;

export function expandableToken(binding: PluginRootBinding): ExpandablePluginRootToken | undefined {
  return binding.kind === "expandable" ? binding.token : undefined;
}

export function foreignPluginRootTokens(binding: PluginRootBinding): ExpandablePluginRootToken[] {
  const own = expandableToken(binding);
  return EXPANDABLE_PLUGIN_ROOT_TOKENS.filter((token) => token !== own);
}

export function hookEventKeys(schema: HookSchema): readonly string[] {
  switch (schema) {
    case "codex-nested":
      return ["PostCompact", "PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"];
    case "cursor-plugin-nested":
    case "claude-args":
      return ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"];
    case "portable-v1":
    case "copilot-generated-v1":
      return ["postToolUse", "sessionEnd", "sessionStart", "userPromptSubmitted"];
    case "cursor-setup-flat":
      return ["beforeSubmitPrompt", "postToolUse", "sessionStart", "stop"];
  }
}

export function assertPackedFileHonorsContract(file: HostFile, text: string): void {
  for (const token of foreignPluginRootTokens(file.pluginRoot)) {
    if (text.includes(token)) {
      throw new Error(`${file.path} contains foreign plugin-root token ${token}.`);
    }
  }
  const own = expandableToken(file.pluginRoot);
  if (own !== undefined && !text.includes(own)) {
    throw new Error(`${file.path} must contain ${own}.`);
  }
}
