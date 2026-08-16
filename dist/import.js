import { daemonRequest, ensureDaemon } from "./daemon-client.js";
import { readImportedSession } from "./import-formats.js";
import { importFiles, importSources } from "./import-sources.js";
const BATCH_SIZE = 5000;
const DAEMON_REQUEST_OVERHEAD_BYTES = 1024;
export async function importSessions(options) {
    if ((options.all === true) === (options.harness !== undefined))
        throw new Error("Pass exactly one of --all or --harness.");
    const report = {
        sessions_scanned: 0,
        sessions_imported: 0,
        events_imported: 0,
        events_skipped_duplicate: 0,
        records_rejected: 0,
        failures: [],
        needs_export: options.all ? ["vscode", "cursor"] : [],
    };
    const selections = importSources(options).map((selection) => ({
        ...selection,
        files: importFiles(selection.harness, selection.paths),
    }));
    const totalSessions = selections.reduce((total, selection) => total + selection.files.length, 0);
    options.onProgress?.({
        phase: "scan",
        totalSessions,
        harnesses: selections.map((selection) => ({ harness: selection.harness, sessions: selection.files.length })),
    });
    if (!options.dryRun)
        await ensureDaemon(options.config);
    const pending = [];
    const maxBatchBytes = options.config.limits.maxInputBytes - DAEMON_REQUEST_OVERHEAD_BYTES;
    let pendingBytes = 2;
    const flush = async () => {
        if (pending.length === 0 || options.dryRun)
            return;
        const ingested = await daemonRequest(options.config, "ingest", { events: pending });
        report.events_imported += ingested.imported;
        report.events_skipped_duplicate += ingested.skippedDuplicate;
        pending.length = 0;
        pendingBytes = 2;
    };
    for (const selection of selections) {
        const files = selection.files;
        const touchedSessions = new Set();
        let sessionsCompleted = 0;
        options.onProgress?.({
            phase: "harness_start", harness: selection.harness, sessionsCompleted, sessionsTotal: files.length,
            sessionsCompletedTotal: report.sessions_scanned, totalSessions,
        });
        if (files.length === 0) {
            if (!selection.optional)
                addFailure(report, selection.paths[0] ?? selection.harness, `No ${selection.harness} session files found.`);
            options.onProgress?.({
                phase: "harness_complete", harness: selection.harness, sessionsCompleted, sessionsTotal: 0,
                sessionsCompletedTotal: report.sessions_scanned, totalSessions,
            });
            continue;
        }
        for (const file of files) {
            report.sessions_scanned += 1;
            sessionsCompleted += 1;
            let events;
            try {
                const parsed = await readImportedSession(selection.harness, file);
                events = [...parsed.events];
                report.records_rejected += parsed.errors.length;
                for (const error of parsed.errors)
                    addFailure(report, error.source, error.error);
            }
            catch (error) {
                report.records_rejected += 1;
                addFailure(report, file, error instanceof Error ? error.message : String(error));
                options.onProgress?.({
                    phase: "session", harness: selection.harness, sessionsCompleted, sessionsTotal: files.length,
                    sessionsCompletedTotal: report.sessions_scanned, totalSessions,
                });
                continue;
            }
            if (events.length > 0)
                report.sessions_imported += 1;
            for (const item of events) {
                if (options.dryRun)
                    continue;
                const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
                if (itemBytes + 2 > maxBatchBytes)
                    throw new Error("Imported event exceeds the daemon request limit.");
                if (pending.length > 0 && (pending.length >= BATCH_SIZE || pendingBytes + 1 + itemBytes > maxBatchBytes)) {
                    await flush();
                }
                pendingBytes += (pending.length > 0 ? 1 : 0) + itemBytes;
                pending.push(item);
                touchedSessions.add(item.session_id);
            }
            options.onProgress?.({
                phase: "session", harness: selection.harness, sessionsCompleted, sessionsTotal: files.length,
                sessionsCompletedTotal: report.sessions_scanned, totalSessions,
            });
        }
        await flush();
        if (!options.dryRun)
            await rebuildImportedSessions(options.config, touchedSessions, maxBatchBytes);
        options.onProgress?.({
            phase: "harness_complete", harness: selection.harness, sessionsCompleted, sessionsTotal: files.length,
            sessionsCompletedTotal: report.sessions_scanned, totalSessions,
        });
    }
    return report;
}
async function rebuildImportedSessions(config, sessions, maxBatchBytes) {
    let batch = [];
    let batchBytes = 2;
    const flush = async () => {
        if (batch.length === 0)
            return;
        await daemonRequest(config, "ingest", { events: [], rebuildSessions: batch });
        batch = [];
        batchBytes = 2;
    };
    for (const sessionId of sessions) {
        const itemBytes = Buffer.byteLength(JSON.stringify(sessionId), "utf8");
        if (itemBytes + 2 > maxBatchBytes)
            throw new Error("Imported session ID exceeds the daemon request limit.");
        if (batch.length > 0 && batchBytes + 1 + itemBytes > maxBatchBytes)
            await flush();
        batchBytes += (batch.length > 0 ? 1 : 0) + itemBytes;
        batch.push(sessionId);
    }
    await flush();
}
function addFailure(report, source, error) {
    report.failures.push({ source, error });
}
