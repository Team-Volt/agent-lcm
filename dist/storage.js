import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { createNoteEvent } from "./events.js";
import { cutOverLegacyLog, migrationInProgress } from "./maintenance.js";
import { appendSegmentedEvents, readActiveRawEvents, readAllLocatedRawEvents, readAllRawEvents, readAllRawLog, readRawLog, RawLogLockTimeoutError, withRawLogLock, } from "./raw-log.js";
import { describeMemory as describeStoredMemory, expandMemory as expandStoredMemory, expandQuery as expandStoredQuery, getContextPlan as readContextPlan, getFileRef as readFileRef, getFileRefsForSession as readFileRefsForSession, getOverflowRef as readOverflowRef, getRecentContext as readRecentContext, parseCursor, parseTimestamp, } from "./storage-context.js";
import { packContext as packStoredContext } from "./storage-pack.js";
import { derivedGraphEdgeCounts, derivedGraphNodeCounts, getStoredSessionGraph, } from "./storage-graph.js";
import { DerivedIndexError, appliedCleanupReport, backfillDelegationParents as runDelegationParentBackfill, backfillFileRefs as runFileRefBackfill, backfillSessionMemorySummaries as runSummaryBackfill, cacheRawEventIds, clearDerivedIndex as clearStoredDerivedIndex, currentRawLogState, emptyCleanupReport, indexedEventsById as readIndexedEventsById, indexedActiveLogIsAppendOnly, indexedRawLogState as readIndexedRawLogState, indexEventInTransaction as indexStoredEventInTransaction, initializeIndex, inspectIndexForCleanup, isRawLogIndexed, knownEventIds as readKnownEventIds, optimizeIndex, previewCleanupReport, rawHealth as readRawHealth, recordRawLogState as storeRawLogState, replaceCleanupSearchIndex, rollbackPreservingError, writableIndexHealth, } from "./storage-persistence.js";
import { clampLimit, searchStoredOverflow, searchStoredSessions, } from "./storage-search.js";
import { getSessionMemorySummary as readSessionMemorySummary, getSummaryNodesForSession as readSummaryNodesForSession, rebuildSessionMemorySummary as materializeSessionMemorySummary, } from "./storage-summaries.js";
import { getCurrentStoredSession, getStoredSession, listStoredSessions, sortedSessionIds, storageStats, storedUsage, } from "./storage-sessions.js";
import { registerStoredEventReader } from "./stored-event.js";
export class LcmStorage {
    config;
    db;
    indexError;
    readOnly;
    rawEventIdCache;
    constructor(options = {}) {
        this.config = options.config ?? loadConfig({ home: options.home });
        this.readOnly = options.readOnly ?? false;
        if (!this.readOnly) {
            fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
            fs.chmodSync(this.config.home, 0o700);
            cutOverLegacyLog(this.config);
        }
        if (this.readOnly && !fs.existsSync(this.config.indexPath)) {
            return;
        }
        try {
            this.db = new DatabaseSync(this.config.indexPath, { readOnly: this.readOnly, timeout: 5_000 });
            registerStoredEventReader(this.db, this.config);
            if (!this.readOnly) {
                fs.chmodSync(this.config.indexPath, 0o600);
                this.initialize();
                if (migrationInProgress(this.config)) {
                    const indexedCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0);
                    if (indexedCount === 0)
                        this.rebuildIndexFromRawStream();
                    else
                        this.replayActiveRawLogToIndex();
                }
                else {
                    if (!this.rawLogIsIndexed()) {
                        if (indexedActiveLogIsAppendOnly(this.db, this.config))
                            this.replayActiveRawLogToIndex();
                        else
                            this.rebuildIndexFromRawStream();
                    }
                }
                this.backfillDelegationParents();
                this.backfillFileRefs();
                this.backfillSessionMemorySummaries();
            }
        }
        catch (error) {
            this.db = undefined;
            if (error instanceof RawLogLockTimeoutError)
                throw error;
            this.indexError = error instanceof Error ? error.message : String(error);
        }
    }
    close() {
        this.db?.close();
    }
    hasEvent(eventId) {
        if (this.db) {
            return this.db.prepare("SELECT 1 FROM events WHERE event_id = ?1 LIMIT 1").get(eventId) !== undefined;
        }
        return Array.from(readAllRawEvents(this.config)).some((event) => event.event_id === eventId);
    }
    ingest(event) {
        if (this.readOnly) {
            throw new Error("Cannot ingest events with read-only storage.");
        }
        try {
            this.ingestSerialized([event], "event");
        }
        catch (error) {
            if (!(error instanceof DerivedIndexError))
                throw error;
            let rawDurable;
            try {
                rawDurable = this.readRawEventIds().has(event.event_id);
            }
            catch {
                throw error;
            }
            if (!rawDurable)
                throw error;
            this.indexError = error instanceof Error ? error.message : String(error);
        }
    }
    ingestMany(events, options = {}) {
        if (this.readOnly) {
            throw new Error("Cannot ingest events with read-only storage.");
        }
        return this.ingestSerialized(events, options.rebuildSummaries ?? true ? "sessions" : "deferred");
    }
    ingestSerialized(events, summaryRebuild) {
        if (events.length === 0)
            return { imported: 0, skippedDuplicate: 0, touchedSessions: [] };
        let indexedRawLogState;
        let indexedEventIds = new Set();
        try {
            if (this.db && this.indexError)
                this.replayRawLogToIndex();
            if (this.db) {
                indexedRawLogState = this.indexedRawLogState();
                indexedEventIds = this.knownEventIds(events.map((event) => event.event_id));
            }
        }
        catch (error) {
            if (error instanceof RawLogLockTimeoutError)
                throw error;
            this.indexError = error instanceof Error ? error.message : String(error);
            indexedRawLogState = undefined;
        }
        const rawWrite = withRawLogLock(this.config.rawLogPath, () => {
            const rawLogWasIndexed = indexedRawLogState === JSON.stringify(this.rawLogState());
            const rawEventIds = rawLogWasIndexed ? indexedEventIds : this.readRawEventIds();
            const rawSeen = new Set(rawEventIds);
            const eventsToAppend = [];
            let skippedDuplicate = 0;
            for (const event of events) {
                if (rawSeen.has(event.event_id)) {
                    skippedDuplicate += 1;
                    continue;
                }
                rawSeen.add(event.event_id);
                eventsToAppend.push(event);
            }
            if (eventsToAppend.length > 0) {
                const locations = appendSegmentedEvents(this.config, eventsToAppend);
                this.storeRawEventIds(rawSeen);
                return {
                    eventsToAppend,
                    locationsByEventId: new Map(eventsToAppend.map((event, index) => [event.event_id, locations[index]])),
                    rawLogState: rawLogWasIndexed ? this.rawLogState() : undefined,
                    skippedDuplicate,
                };
            }
            return {
                eventsToAppend,
                locationsByEventId: new Map(),
                rawLogState: rawLogWasIndexed ? this.rawLogState() : undefined,
                skippedDuplicate,
            };
        });
        if (!this.db)
            return { imported: rawWrite.eventsToAppend.length, skippedDuplicate: rawWrite.skippedDuplicate, touchedSessions: [] };
        try {
            this.db.exec("BEGIN IMMEDIATE");
        }
        catch (error) {
            this.indexError = error instanceof Error ? error.message : String(error);
            throw new DerivedIndexError(error);
        }
        const touchedSessions = new Set();
        try {
            const indexSeen = this.knownEventIds(events.map((event) => event.event_id));
            for (const event of events) {
                if (indexSeen.has(event.event_id))
                    continue;
                indexSeen.add(event.event_id);
                const result = this.indexEventInTransaction(event, { rebuildSummary: summaryRebuild === "event" }, rawWrite.locationsByEventId.get(event.event_id));
                if (result.summaryTouched)
                    touchedSessions.add(event.session_id);
            }
            const rebuiltSessions = summaryRebuild === "sessions"
                ? this.rebuildTouchedSummarySessions(touchedSessions)
                : sortedSessionIds(touchedSessions);
            if (rawWrite.rawLogState)
                this.recordRawLogState(rawWrite.rawLogState);
            this.db.exec("COMMIT");
            if (rawWrite.rawLogState)
                this.indexError = undefined;
            return {
                imported: rawWrite.eventsToAppend.length,
                skippedDuplicate: rawWrite.skippedDuplicate,
                touchedSessions: rebuiltSessions,
            };
        }
        catch (error) {
            let failure = error;
            const rollback = rollbackPreservingError(this.db, error);
            if (rollback.kind !== "rolled_back") {
                failure = new AggregateError([rollback.original, rollback.rollbackError], "Bulk ingest rollback failed after indexing failure.");
            }
            this.indexError = failure instanceof Error ? failure.message : String(failure);
            throw new DerivedIndexError(failure);
        }
    }
    readRawEventIds() {
        return new Set(Array.from(readAllRawEvents(this.config), (event) => event.event_id));
    }
    storeRawEventIds(eventIds) {
        this.rawEventIdCache = cacheRawEventIds(this.config.rawLogPath, eventIds);
    }
    rebuildSessionMemorySummaries(sessionIds) {
        if (!this.db)
            return [];
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const rebuiltSessions = this.rebuildTouchedSummarySessions(sessionIds);
            this.db.exec("COMMIT");
            return rebuiltSessions;
        }
        catch (error) {
            const rollback = rollbackPreservingError(this.db, error);
            const message = error instanceof Error ? error.message : String(error);
            this.indexError = rollback.kind === "rolled_back" ? message : `${message}; rollback failed: ${rollback.rollbackError instanceof Error ? rollback.rollbackError.message : String(rollback.rollbackError)}`;
            return [];
        }
    }
    cleanupIndex(options = {}) {
        if (!this.db && !fs.existsSync(this.config.rawLogPath) && !fs.existsSync(this.config.indexPath)) {
            return emptyCleanupReport(this.config.indexPath);
        }
        if (!this.db)
            throw new Error("SQLite index is unavailable; the raw event log was not changed.");
        const apply = options.apply === true;
        if (apply && this.readOnly)
            throw new Error("Cleanup --apply requires writable storage.");
        if (!apply) {
            return previewCleanupReport(this.config.indexPath, inspectIndexForCleanup(this.db, this.config.indexPath));
        }
        this.db.exec("BEGIN IMMEDIATE");
        let inspection;
        try {
            inspection = inspectIndexForCleanup(this.db, this.config.indexPath);
            replaceCleanupSearchIndex(this.db, inspection.searchableEvents);
            this.db.exec("COMMIT");
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch {
                throw error;
            }
            throw error;
        }
        for (const sessionBatch of chunkArray(inspection.sessionIds, 10)) {
            this.reopenWritableIndex();
            this.db?.exec("BEGIN IMMEDIATE");
            try {
                for (const sessionId of sessionBatch)
                    this.rebuildSessionMemorySummary(sessionId);
                this.db?.exec("COMMIT");
            }
            catch (error) {
                try {
                    this.db?.exec("ROLLBACK");
                }
                catch {
                    throw error;
                }
                throw error;
            }
        }
        optimizeIndex(this.db);
        return appliedCleanupReport(this.db, this.config.indexPath, inspection);
    }
    reopenWritableIndex() {
        this.db?.close();
        this.db = new DatabaseSync(this.config.indexPath, { timeout: 5_000 });
        registerStoredEventReader(this.db, this.config);
    }
    health() {
        if (!this.db)
            return this.rawHealth();
        try {
            return writableIndexHealth(this.db, this.config, this.indexError, derivedGraphNodeCounts(this.db), derivedGraphEdgeCounts(this.db));
        }
        catch (error) {
            this.indexError = error instanceof Error ? error.message : String(error);
            try {
                this.db.close();
            }
            catch {
                this.db = undefined;
                return this.rawHealth();
            }
            this.db = undefined;
            return this.rawHealth();
        }
    }
    rawHealth() {
        return readRawHealth(this.config, this.indexError);
    }
    replayRawLogToIndex() {
        if (!this.db)
            return;
        if (this.rawLogIsIndexed())
            return;
        const snapshot = withRawLogLock(this.config.rawLogPath, () => ({
            rawLog: readAllRawLog(this.config),
            state: this.rawLogState(),
        }));
        const rawLog = snapshot.rawLog;
        const rawEvents = rawLog.events;
        const indexedEvents = this.indexedEventsById();
        const indexedIds = new Set(indexedEvents.keys());
        if (rawLog.malformedLineCount > 0) {
            const noun = rawLog.malformedLineCount === 1 ? "line" : "lines";
            this.indexError = `Raw JSONL contains ${rawLog.malformedLineCount} malformed ${noun}; destructive index reconciliation is disabled until the log is repaired.`;
        }
        if (rawEvents.length === 0) {
            if (indexedIds.size > 0 && rawLog.malformedLineCount === 0)
                this.rebuildIndexFromRawStream();
            else if (rawLog.malformedLineCount === 0)
                this.recordRawLogState(snapshot.state);
            return;
        }
        const rawIds = new Set(rawEvents.map((event) => event.event_id));
        const hasStaleIndexedRows = [...indexedIds].some((eventId) => !rawIds.has(eventId));
        const hasChangedIndexedRows = rawEvents.some((event) => {
            const indexedRaw = indexedEvents.get(event.event_id);
            return indexedRaw !== undefined && indexedRaw !== JSON.stringify(event);
        });
        if ((hasStaleIndexedRows || hasChangedIndexedRows) && rawLog.malformedLineCount === 0) {
            this.rebuildIndexFromRawStream();
            return;
        }
        const missingEvents = rawEvents.filter((event) => !indexedIds.has(event.event_id));
        if (missingEvents.length === 0) {
            if (rawLog.malformedLineCount === 0)
                this.recordRawLogState(snapshot.state);
            return;
        }
        const touchedSessions = new Set();
        const missingIds = new Set(missingEvents.map((event) => event.event_id));
        this.db.exec("BEGIN IMMEDIATE");
        try {
            for (const located of readAllLocatedRawEvents(this.config)) {
                if (!missingIds.has(located.event.event_id))
                    continue;
                const result = this.indexEventInTransaction(located.event, { rebuildSummary: false }, located.location);
                if (result.summaryTouched)
                    touchedSessions.add(located.event.session_id);
            }
            this.rebuildTouchedSummarySessions(touchedSessions);
            if (rawLog.malformedLineCount === 0)
                this.recordRawLogState(snapshot.state);
            this.db.exec("COMMIT");
        }
        catch (error) {
            const failure = rollbackPreservingError(this.db, error).original;
            this.indexError = failure instanceof Error ? failure.message : String(failure);
        }
    }
    replayActiveRawLogToIndex() {
        if (!this.db)
            return;
        const rawLog = withRawLogLock(this.config.rawLogPath, () => readRawLog(this.config.rawLogPath));
        if (rawLog.malformedLineCount > 0) {
            this.indexError = `Active raw JSONL contains ${rawLog.malformedLineCount} malformed lines.`;
        }
        const indexedIds = this.knownEventIds(rawLog.events.map((event) => event.event_id));
        const missingIds = new Set(rawLog.events.filter((event) => !indexedIds.has(event.event_id)).map((event) => event.event_id));
        if (missingIds.size === 0)
            return;
        const touchedSessions = new Set();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            for (const located of readActiveRawEvents(this.config)) {
                if (!missingIds.has(located.event.event_id))
                    continue;
                const result = this.indexEventInTransaction(located.event, { rebuildSummary: false }, located.location);
                if (result.summaryTouched)
                    touchedSessions.add(located.event.session_id);
            }
            this.rebuildTouchedSummarySessions(touchedSessions);
            this.db.exec("COMMIT");
        }
        catch (error) {
            const failure = rollbackPreservingError(this.db, error).original;
            this.indexError = failure instanceof Error ? failure.message : String(failure);
        }
    }
    rebuildIndexFromRawStream() {
        if (!this.db)
            return;
        const state = withRawLogLock(this.config.rawLogPath, () => this.rawLogState());
        const touchedSessions = new Set();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.clearDerivedIndex();
            for (const located of readAllLocatedRawEvents(this.config)) {
                const result = this.indexEventInTransaction(located.event, { rebuildSummary: false }, located.location);
                if (result.summaryTouched)
                    touchedSessions.add(located.event.session_id);
            }
            this.rebuildTouchedSummarySessions(touchedSessions);
            this.recordRawLogState(state);
            this.db.exec("COMMIT");
        }
        catch (error) {
            const rollback = rollbackPreservingError(this.db, error);
            const message = error instanceof Error ? error.message : String(error);
            this.indexError = rollback.kind === "rolled_back"
                ? message
                : `${message}; rollback failed: ${rollback.rollbackError instanceof Error ? rollback.rollbackError.message : String(rollback.rollbackError)}`;
        }
    }
    clearDerivedIndex() {
        if (this.db)
            clearStoredDerivedIndex(this.db);
    }
    knownEventIds(eventIds) {
        return readKnownEventIds(this.db, this.config.rawLogPath, eventIds);
    }
    indexedEventsById() {
        return this.db ? readIndexedEventsById(this.db) : new Map();
    }
    rawLogIsIndexed() {
        return this.db ? isRawLogIndexed(this.db, this.config) : false;
    }
    indexedRawLogState() {
        return this.db ? readIndexedRawLogState(this.db) : undefined;
    }
    recordRawLogState(state) {
        if (this.db)
            storeRawLogState(this.db, state);
    }
    rawLogState() {
        return currentRawLogState(this.config);
    }
    rebuildTouchedSummarySessions(sessionIds) {
        const rebuiltSessions = sortedSessionIds(sessionIds);
        for (const sessionId of rebuiltSessions)
            this.rebuildSessionMemorySummary(sessionId);
        return rebuiltSessions;
    }
    stats() {
        const health = this.health();
        return storageStats(this.db, this.config.rawLogPath, health, derivedGraphNodeCounts(this.db), derivedGraphEdgeCounts(this.db));
    }
    listSessions(args = {}) {
        const limit = clampLimit(args.limit, 50, 500);
        const offset = parseCursor(args.cursor);
        const since = parseTimestamp(args.since, "since");
        const until = parseTimestamp(args.until, "until");
        return listStoredSessions(this.db, this.config.rawLogPath, args, limit, offset, since, until);
    }
    usage(args = {}) {
        const since = parseTimestamp(args.since, "since");
        const until = parseTimestamp(args.until, "until");
        return storedUsage(this.db, this.config.rawLogPath, args, since, until);
    }
    searchSessions(args) {
        return searchStoredSessions(this.db, this.config.rawLogPath, args);
    }
    searchOverflow(args) {
        return searchStoredOverflow(this.db, this.config.rawLogPath, this.config.overflowDir, args);
    }
    getCurrentSession(args = {}) {
        return getCurrentStoredSession(this.db, this.config.rawLogPath, args);
    }
    getSession(sessionId, args = {}) {
        const offset = parseCursor(args.cursor);
        const limit = args.limit === undefined ? undefined : clampLimit(args.limit, 200);
        return getStoredSession(this.db, this.config.rawLogPath, sessionId, limit, offset);
    }
    getSessionGraph(sessionId, args = {}) {
        const limit = clampLimit(args.limit, 200, 1_000);
        return getStoredSessionGraph(this.db, this.config.rawLogPath, sessionId, limit);
    }
    getRecentContext(args = {}) {
        return readRecentContext(this.db, this.config.rawLogPath, args);
    }
    getContextPlan(args = {}) {
        try {
            return readContextPlan(this.db, this.config.rawLogPath, args);
        }
        catch (error) {
            this.indexError = error instanceof Error ? error.message : String(error);
            try {
                this.db?.close();
            }
            catch {
                this.db = undefined;
                return readContextPlan(this.db, this.config.rawLogPath, args);
            }
            this.db = undefined;
            return readContextPlan(this.db, this.config.rawLogPath, args);
        }
    }
    recordNote(args) {
        const event = createNoteEvent({
            sessionId: args.sessionId,
            cwd: args.cwd,
            text: args.text,
        });
        this.ingest(event);
        return event;
    }
    getSessionMemorySummary(sessionId) {
        return readSessionMemorySummary(this.db, this.config.rawLogPath, sessionId);
    }
    getSummaryNodesForSession(sessionId, limit = 200) {
        return readSummaryNodesForSession(this.db, sessionId, limit);
    }
    getFileRefsForSession(sessionId, limit = 50) {
        return readFileRefsForSession(this.db, sessionId, limit);
    }
    getFileRef(fileRefId) {
        return readFileRef(this.db, fileRefId);
    }
    getOverflowRef(fileRefId) {
        return readOverflowRef(this.db, this.config.rawLogPath, fileRefId);
    }
    describeMemory(args) {
        return describeStoredMemory(this.db, this.config.rawLogPath, this.config.overflowDir, args);
    }
    expandMemory(args) {
        return expandStoredMemory(this.db, args);
    }
    expandQuery(args) {
        return expandStoredQuery(this.db, this.config.rawLogPath, args);
    }
    packContext(args = {}) {
        return packStoredContext(this.db, this.config.rawLogPath, args);
    }
    initialize() {
        if (this.db)
            initializeIndex(this.db);
    }
    indexEventInTransaction(event, options, location) {
        return indexStoredEventInTransaction(this.db, event, options.rebuildSummary, location);
    }
    backfillDelegationParents() {
        this.indexError = runDelegationParentBackfill(this.db) ?? this.indexError;
    }
    backfillFileRefs() {
        this.indexError = runFileRefBackfill(this.db) ?? this.indexError;
    }
    backfillSessionMemorySummaries() {
        this.indexError = runSummaryBackfill(this.db) ?? this.indexError;
    }
    rebuildSessionMemorySummary(sessionId) {
        materializeSessionMemorySummary(this.db, sessionId);
    }
}
export function createStorage(options = {}) {
    return new LcmStorage(options);
}
function chunkArray(values, size) {
    const chunks = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}
