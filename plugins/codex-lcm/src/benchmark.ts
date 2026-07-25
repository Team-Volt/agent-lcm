import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { normalizeHookEvent } from "./events.ts";
import { createStorage } from "./storage.ts";

const BENCHMARK_SESSION_ID = "codex-lcm-benchmark-long-context";
const BENCHMARK_CWD = "/tmp/codex-lcm-benchmark";
const BENCHMARK_NEEDLE = "BENCHMARK-NEEDLE recursive evidence recovery source event";
const BENCHMARK_QUERY = "BENCHMARK-NEEDLE recursive evidence recovery";
const RETRIEVAL_BENCHMARK_CWD = "/tmp/codex-lcm-retrieval-quality";

type RetrievalCategory = "exact" | "cross-session" | "temporal" | "paraphrase";

const RETRIEVAL_CORPUS = [
  ["retrieval-storage", "SQLite WAL concurrent readers were chosen for local session storage."],
  ["retrieval-websocket", "WebSocket reconnect jitter prevents synchronized client retries."],
  ["retrieval-pool", "The pool chemistry pH target is 7.4 after probe calibration."],
  ["retrieval-overflow", "Overflow payload integrity uses a content hash before bounded recovery."],
  ["retrieval-release-old", "The release signing certificate belongs to the legacy build account."],
  ["retrieval-release-new", "The release signing certificate moved to the production build account."],
  ["retrieval-migration-old", "Schema migration rollback used a manual database snapshot."],
  ["retrieval-migration-new", "Schema migration rollback now uses the automated restore job."],
  ["retrieval-backoff", "Failed requests retry with exponential delay and random spread."],
] as const;

const RETRIEVAL_QUERIES: ReadonlyArray<{
  id: string;
  category: RetrievalCategory;
  query: string;
  expectedSessionId: string;
}> = [
  { id: "exact-storage", category: "exact", query: "SQLite WAL concurrent readers", expectedSessionId: "retrieval-storage" },
  { id: "exact-websocket", category: "exact", query: "WebSocket reconnect jitter", expectedSessionId: "retrieval-websocket" },
  { id: "cross-pool", category: "cross-session", query: "pool chemistry pH target", expectedSessionId: "retrieval-pool" },
  { id: "cross-overflow", category: "cross-session", query: "overflow payload integrity hash", expectedSessionId: "retrieval-overflow" },
  { id: "temporal-release", category: "temporal", query: "release signing certificate", expectedSessionId: "retrieval-release-new" },
  { id: "temporal-migration", category: "temporal", query: "schema migration rollback", expectedSessionId: "retrieval-migration-new" },
  { id: "paraphrase-overflow", category: "paraphrase", query: "retain oversized command output", expectedSessionId: "retrieval-overflow" },
  { id: "paraphrase-backoff", category: "paraphrase", query: "randomized backoff for failed calls", expectedSessionId: "retrieval-backoff" },
];

export type LongContextBenchmarkOptions = {
  events?: number;
  budgetTokens?: number;
  home?: string;
};

export type LongContextBenchmarkResult = {
  name: "long-context";
  session_id: string;
  generated_events: number;
  query: string;
  recovered: boolean;
  summary_node_count: number;
  max_summary_depth: number | null;
  packed_estimated_tokens: number;
  duration_ms: number;
  storage_home?: string;
};

export type RetrievalQualityMetrics = {
  queries: number;
  recall_at_1: number;
  recall_at_5: number;
  mean_reciprocal_rank: number;
};

export type RetrievalQualityBenchmarkResult = RetrievalQualityMetrics & {
  name: "retrieval-quality";
  corpus_version: 1;
  sessions: number;
  by_category: Record<RetrievalCategory, RetrievalQualityMetrics>;
  cases: Array<{
    id: string;
    category: RetrievalCategory;
    query: string;
    expected_session_id: string;
    rank: number | null;
    top_session_ids: string[];
  }>;
  duration_ms: number;
  storage_home?: string;
};

export function runLongContextBenchmark(options: LongContextBenchmarkOptions = {}): LongContextBenchmarkResult {
  const eventCount = Math.max(16, Math.floor(options.events ?? 128));
  const budgetTokens = Math.max(64, Math.floor(options.budgetTokens ?? 1200));
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-benchmark-"));
  const cleanup = options.home === undefined;
  const startedAt = performance.now();
  const storage = createStorage({ home });

  try {
    const events = Array.from({ length: eventCount }, (_, index) => normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: BENCHMARK_SESSION_ID,
        cwd: BENCHMARK_CWD,
        prompt: index === 3
          ? BENCHMARK_NEEDLE
          : `benchmark filler ${index} source lineage summary retrieval ${index % 7}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));

    storage.ingestMany(events);
    const stats = storage.stats();
    const packed = storage.packContext({
      query: BENCHMARK_QUERY,
      sessionIds: [BENCHMARK_SESSION_ID],
      budgetTokens,
    });

    return {
      name: "long-context",
      session_id: BENCHMARK_SESSION_ID,
      generated_events: eventCount,
      query: BENCHMARK_QUERY,
      recovered: packed.markdown.includes(BENCHMARK_NEEDLE),
      summary_node_count: stats.summary_node_count ?? 0,
      max_summary_depth: stats.max_summary_depth,
      packed_estimated_tokens: packed.estimated_tokens,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(cleanup ? {} : { storage_home: home }),
    };
  } finally {
    storage.close();
    if (cleanup) fs.rmSync(home, { recursive: true, force: true });
  }
}

export function runRetrievalQualityBenchmark(options: { home?: string } = {}): RetrievalQualityBenchmarkResult {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-retrieval-quality-"));
  const cleanup = options.home === undefined;
  const startedAt = performance.now();
  const storage = createStorage({ home });

  try {
    storage.ingestMany(RETRIEVAL_CORPUS.map(([sessionId, prompt], index) => normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: sessionId,
        cwd: RETRIEVAL_BENCHMARK_CWD,
        prompt,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 6, 1, 12, index)),
    })));
    const cases = RETRIEVAL_QUERIES.map((entry) => {
      const topSessionIds = storage.searchSessions({
        query: entry.query,
        cwd: RETRIEVAL_BENCHMARK_CWD,
        limit: 5,
      }).map((match) => match.session_id);
      const index = topSessionIds.indexOf(entry.expectedSessionId);
      return {
        id: entry.id,
        category: entry.category,
        query: entry.query,
        expected_session_id: entry.expectedSessionId,
        rank: index < 0 ? null : index + 1,
        top_session_ids: topSessionIds,
      };
    });
    return {
      name: "retrieval-quality",
      corpus_version: 1,
      sessions: RETRIEVAL_CORPUS.length,
      ...retrievalMetrics(cases),
      by_category: {
        exact: retrievalMetrics(cases.filter((entry) => entry.category === "exact")),
        "cross-session": retrievalMetrics(cases.filter((entry) => entry.category === "cross-session")),
        temporal: retrievalMetrics(cases.filter((entry) => entry.category === "temporal")),
        paraphrase: retrievalMetrics(cases.filter((entry) => entry.category === "paraphrase")),
      },
      cases,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(cleanup ? {} : { storage_home: home }),
    };
  } finally {
    storage.close();
    if (cleanup) fs.rmSync(home, { recursive: true, force: true });
  }
}

function retrievalMetrics(cases: ReadonlyArray<{ rank: number | null }>): RetrievalQualityMetrics {
  const queries = cases.length;
  return {
    queries,
    recall_at_1: ratio(cases.filter((entry) => entry.rank === 1).length, queries),
    recall_at_5: ratio(cases.filter((entry) => entry.rank !== null && entry.rank <= 5).length, queries),
    mean_reciprocal_rank: ratio(cases.reduce((sum, entry) => sum + (entry.rank ? 1 / entry.rank : 0), 0), queries),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}
