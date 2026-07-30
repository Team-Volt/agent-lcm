import type { LcmDescription, SummaryNode } from "./storage.ts";

export function toolResult(text: string, structuredContent: unknown) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

export function withoutMarkdown<T extends { markdown: string }>(value: T): Omit<T, "markdown"> {
  const { markdown: _markdown, ...rest } = value;
  return rest;
}

export function compactDescription(description: LcmDescription): unknown {
  if (description.target === "file_ref" || description.target === "overflow_ref") return description;
  if (description.target === "summary_node") {
    return {
      ...description,
      node: compactSummaryNode(description.node),
      source_nodes: description.source_nodes.map(compactSummaryNode),
    };
  }
  return {
    ...description,
    summary: description.summary ? compactSessionSummary(description.summary) : undefined,
    summary_nodes: description.summary_nodes.map(compactSummaryNode),
  };
}

function compactSummaryNode(node: SummaryNode): Omit<SummaryNode, "source_ids" | "source_event_ids"> & {
  readonly source_count: number;
  readonly source_event_count: number;
} {
  const { source_ids: sourceIds, source_event_ids: sourceEventIds, ...rest } = node;
  return {
    ...rest,
    source_count: sourceIds.length,
    source_event_count: sourceEventIds.length,
  };
}

function compactSessionSummary<T extends { source_event_ids: string[] }>(
  summary: T,
): Omit<T, "source_event_ids"> & { readonly source_event_count: number } {
  const { source_event_ids: sourceEventIds, ...rest } = summary;
  return { ...rest, source_event_count: sourceEventIds.length };
}
