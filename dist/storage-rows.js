export function rowToSessionSummary(row) {
    const record = recordValue(row);
    return {
        session_id: String(record.session_id),
        harness: (record.harness === "cursor" || record.harness === "vscode" || record.harness === "copilot" || record.harness === "kiro" || record.harness === "claude" || record.harness === "mcp" || record.harness === "import") ? record.harness : "codex",
        first_seen: String(record.first_seen),
        last_seen: String(record.last_seen),
        cwd: String(record.cwd),
        ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
        ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
        event_count: Number(record.event_count),
        ...(record.parent_session_id ? { parent_session_id: String(record.parent_session_id) } : {}),
        ...(record.agent_role ? { agent_role: String(record.agent_role) } : {}),
        ...(record.agent_nickname ? { agent_nickname: String(record.agent_nickname) } : {}),
        ...(record.model ? { model: String(record.model) } : {}),
        ...(record.reasoning_effort ? { reasoning_effort: String(record.reasoning_effort) } : {}),
        ...optionalNumber(record, "total_input_tokens"),
        ...optionalNumber(record, "cached_input_tokens"),
        ...optionalNumber(record, "output_tokens"),
        ...optionalNumber(record, "reasoning_output_tokens"),
        ...optionalNumber(record, "total_tokens"),
        ...optionalNumber(record, "match_count"),
        ...(record.summary_title ? {
            summary: {
                updated_at: String(record.summary_updated_at),
                title: String(record.summary_title),
                overview: String(record.summary_overview),
                topics: parseStringArray(record.summary_topics_json),
                key_prompts: parseStringArray(record.summary_key_prompts_json),
                outcomes: parseStringArray(record.summary_outcomes_json),
                source_event_count: parseStringArray(record.summary_source_event_ids_json).length,
            },
        } : {}),
    };
}
export function rowToSessionMemorySummary(row) {
    const record = recordValue(row);
    return {
        session_id: String(record.session_id),
        updated_at: String(record.updated_at),
        cwd: String(record.cwd),
        ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
        ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
        title: String(record.title),
        overview: String(record.overview),
        topics: parseStringArray(record.topics_json),
        key_prompts: parseStringArray(record.key_prompts_json),
        outcomes: parseStringArray(record.outcomes_json),
        tools: parseStringArray(record.tools_json),
        source_event_ids: parseStringArray(record.source_event_ids_json),
    };
}
export function rowToSummaryNode(row) {
    const record = recordValue(row);
    return {
        node_id: String(record.node_id),
        session_id: String(record.session_id),
        depth: Number(record.depth),
        summary_text: String(record.summary_text),
        token_count: Number(record.token_count),
        source_token_count: Number(record.source_token_count),
        source_type: String(record.source_type) === "nodes" ? "nodes" : "events",
        source_ids: parseStringArray(record.source_ids_json),
        source_event_ids: parseStringArray(record.source_event_ids_json),
        earliest_at: String(record.earliest_at),
        latest_at: String(record.latest_at),
        created_at: String(record.created_at),
        cwd: String(record.cwd),
        ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
        ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
        topics: parseStringArray(record.topics_json),
    };
}
export function rowToFileReference(row) {
    const record = recordValue(row);
    return {
        file_ref_id: String(record.file_ref_id),
        session_id: String(record.session_id),
        observed_event_id: String(record.observed_event_id),
        timestamp: String(record.timestamp),
        path: String(record.path),
        mime_type: String(record.mime_type),
        byte_count: Number(record.byte_count),
        sha256: String(record.sha256),
        exploration_summary: String(record.exploration_summary),
        metadata: parseMetadata(record.metadata_json),
    };
}
function optionalNumber(record, key) {
    const value = record[key];
    return value === null || value === undefined ? {} : { [key]: Number(value) };
}
function parseMetadata(value) {
    if (typeof value !== "string")
        return {};
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : {};
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return {};
        throw error;
    }
}
export function parseStringArray(value) {
    if (typeof value !== "string")
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return [];
        throw error;
    }
}
export function recordValue(value) {
    return isRecord(value) ? value : {};
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
