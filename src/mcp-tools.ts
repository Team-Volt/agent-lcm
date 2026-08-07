import { compactDescription, toolResult, withoutMarkdown } from "./mcp-result.ts";
import { HARNESS_NAMES, type HarnessName } from "./events.ts";
import type { LcmStorage } from "./storage.ts";

export function callTool(storage: LcmStorage, params: Record<string, unknown>): ReturnType<typeof toolResult> {
  const name = stringArg(params.name, "name");
  const args = isRecord(params.arguments) ? params.arguments : {};
  switch (name) {
    case "lcm_health": {
      const health = storage.health();
      return toolResult(`Agent LCM has ${health.event_count} events across ${health.session_count} sessions.`, { health });
    }
    case "lcm_stats": {
      const stats = storage.stats();
      return toolResult(
        `Agent LCM has ${stats.event_count} events, ${stats.summary_node_count ?? 0} summary nodes, and ${stats.graph_node_count ?? 0} graph nodes.`,
        { stats },
      );
    }
    case "lcm_list_sessions": {
      const page = storage.listSessions({
        since: optionalString(args.since),
        until: optionalString(args.until),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        parentSessionId: optionalString(args.parentSessionId),
        harnesses: optionalHarnessArray(args.harnesses),
        rootsOnly: optionalBoolean(args.rootsOnly),
        includeSummaries: optionalBoolean(args.includeSummaries),
        limit: optionalNumber(args.limit),
        cursor: optionalString(args.cursor),
      });
      return toolResult(`Loaded ${page.sessions.length} sessions.`, { page });
    }
    case "lcm_usage": {
      const usage = storage.usage({
        since: optionalString(args.since),
        until: optionalString(args.until),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        parentSessionId: optionalString(args.parentSessionId),
        harnesses: optionalHarnessArray(args.harnesses),
        rootsOnly: optionalBoolean(args.rootsOnly),
      });
      return toolResult(`Captured ${usage.totals.total_tokens} tokens across ${usage.totals.sessions} sessions.`, { usage });
    }
    case "lcm_grep": {
      const scope = contentScope(args.contentScope);
      const query = optionalString(args.query);
      const matches = scope === "overflow"
        ? []
        : storage.searchSessions({
          query,
          limit: optionalNumber(args.limit),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          excludeCurrentSession: optionalBoolean(args.excludeCurrentSession),
          excludeSessionIds: optionalStringArray(args.excludeSessionIds),
          harnesses: optionalHarnessArray(args.harnesses),
        });
      const overflowMatches = scope === "memory"
        ? []
        : storage.searchOverflow({
          query: query ?? "",
          limit: optionalNumber(args.limit),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          harnesses: optionalHarnessArray(args.harnesses),
        });
      return toolResult(
        `Found ${matches.length} LCM matches and ${overflowMatches.length} overflow matches.`,
        { matches, overflow_matches: overflowMatches },
      );
    }
    case "lcm_describe": {
      const description = storage.describeMemory({
        sessionId: optionalString(args.sessionId),
        nodeId: optionalString(args.nodeId),
        fileId: optionalString(args.fileId),
        limit: optionalNumber(args.limit),
        offset: optionalNumber(args.offset),
        maxBytes: optionalNumber(args.maxBytes),
      });
      const target = description.target === "session"
        ? description.session?.session_id ?? args.sessionId
        : description.target === "summary_node"
          ? description.node.node_id
          : description.target === "file_ref"
            ? description.file_ref.file_ref_id
            : description.overflow_ref.file_ref_id;
      return toolResult(`Described ${description.target} ${target}.`, {
        description: optionalBoolean(args.includeLineage) ? description : compactDescription(description),
      });
    }
    case "lcm_expand": {
      const expansion = storage.expandMemory({
        nodeId: stringArg(args.nodeId, "nodeId"),
        query: optionalString(args.query),
        limit: optionalNumber(args.limit),
      });
      return toolResult(expansion.markdown, { expansion: withoutMarkdown(expansion) });
    }
    case "lcm_expand_query": {
      const expansion = storage.expandQuery({
        query: stringArg(args.query, "query"),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        sessionIds: optionalStringArray(args.sessionIds),
        budgetTokens: optionalNumber(args.budgetTokens),
        limit: optionalNumber(args.limit),
        sourceLimit: optionalNumber(args.sourceLimit),
        overview: optionalBoolean(args.overview),
        harnesses: optionalHarnessArray(args.harnesses),
      });
      return toolResult(expansion.markdown, { expansion: withoutMarkdown(expansion) });
    }
    case "lcm_context_plan": {
      const plan = storage.getContextPlan({
        sessionId: optionalString(args.sessionId),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        modelContextWindow: optionalNumber(args.modelContextWindow),
        autoCompactTokenLimit: optionalNumber(args.autoCompactTokenLimit),
        recentEventLimit: optionalNumber(args.recentEventLimit),
      });
      return toolResult(`Context plan state: ${plan.state}. ${plan.recommendation}`, { plan });
    }
    case "lcm_current_session": {
      const session = storage.getCurrentSession({
        sessionId: optionalString(args.sessionId),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
      });
      return toolResult(session ? `Current session: ${session.session_id}` : "No matching session found.", { session });
    }
    case "lcm_search_sessions": {
      const matches = storage.searchSessions({
        query: optionalString(args.query),
        limit: optionalNumber(args.limit),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        excludeCurrentSession: optionalBoolean(args.excludeCurrentSession),
        excludeSessionIds: optionalStringArray(args.excludeSessionIds),
        harnesses: optionalHarnessArray(args.harnesses),
      });
      return toolResult(`Found ${matches.length} matching sessions.`, { matches });
    }
    case "lcm_get_session": {
      const session = storage.getSession(stringArg(args.sessionId, "sessionId"), {
        limit: optionalNumber(args.limit),
        cursor: optionalString(args.cursor),
      });
      return toolResult(`Loaded ${session.events.length} events.`, session);
    }
    case "lcm_get_session_summary": {
      const summary = storage.getSessionMemorySummary(stringArg(args.sessionId, "sessionId"));
      return toolResult(summary ? `Loaded summary for ${summary.session_id}.` : "No summary found.", { summary });
    }
    case "lcm_get_session_graph": {
      const graph = storage.getSessionGraph(stringArg(args.sessionId, "sessionId"), {
        limit: optionalNumber(args.limit),
      });
      return toolResult(`Loaded graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`, graph);
    }
    case "lcm_get_recent_context": {
      const context = storage.getRecentContext({
        sessionId: optionalString(args.sessionId),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        limit: optionalNumber(args.limit),
      });
      return toolResult(`Loaded ${context.events.length} recent events.`, context);
    }
    case "lcm_pack_context": {
      const packed = storage.packContext({
        query: optionalString(args.query),
        sessionIds: optionalStringArray(args.sessionIds),
        currentThreadId: optionalString(args.currentThreadId) ?? currentThreadId(),
        budgetTokens: optionalNumber(args.budgetTokens),
        cwd: optionalString(args.cwd),
        harnesses: optionalHarnessArray(args.harnesses),
      });
      return toolResult("Packed context is in structuredContent.markdown.", packed);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error("value must be an array of non-empty strings.");
  }
  return value.map((item) => item.trim());
}

function optionalHarnessArray(value: unknown): HarnessName[] | undefined {
  const values = optionalStringArray(value);
  if (!values) return undefined;
  if (values.some((harness) => !(HARNESS_NAMES as readonly string[]).includes(harness))) {
    throw new Error(`harnesses must contain only: ${HARNESS_NAMES.join(", ")}.`);
  }
  return values as HarnessName[];
}

function contentScope(value: unknown): "memory" | "overflow" | "both" {
  if (value === undefined) return "memory";
  if (value === "memory" || value === "overflow" || value === "both") return value;
  throw new Error("contentScope must be memory, overflow, or both.");
}

function currentThreadId(): string | undefined {
  return optionalString(process.env.CODEX_THREAD_ID);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
