export function toolResult(text, structuredContent) {
    return {
        content: [{ type: "text", text }],
        structuredContent,
    };
}
export function withoutMarkdown(value) {
    const { markdown: _markdown, ...rest } = value;
    return rest;
}
export function compactDescription(description) {
    if (description.target === "file_ref" || description.target === "overflow_ref")
        return description;
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
function compactSummaryNode(node) {
    const { source_ids: sourceIds, source_event_ids: sourceEventIds, ...rest } = node;
    return {
        ...rest,
        source_count: sourceIds.length,
        source_event_count: sourceEventIds.length,
    };
}
function compactSessionSummary(summary) {
    const { source_event_ids: sourceEventIds, ...rest } = summary;
    return { ...rest, source_event_count: sourceEventIds.length };
}
