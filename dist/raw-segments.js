import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./redact.js";
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export function segmentTimestampBounds(timestamps) {
    let firstTimestamp = timestamps[0] ?? EPOCH_TIMESTAMP;
    let lastTimestamp = firstTimestamp;
    for (const timestamp of timestamps) {
        if (timestamp < firstTimestamp)
            firstTimestamp = timestamp;
        if (timestamp > lastTimestamp)
            lastTimestamp = timestamp;
    }
    return { firstTimestamp, lastTimestamp };
}
export function emptySegmentManifest() {
    return { version: 1, segments: [] };
}
export function readManifest(manifestPath) {
    if (!fs.existsSync(manifestPath))
        return emptySegmentManifest();
    try {
        return validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    }
    catch (error) {
        throw new Error("Invalid segment manifest.", { cause: error });
    }
}
export function writeManifestAtomic(manifestPath, manifest) {
    const serialized = JSON.stringify(validateManifest(manifest));
    const directory = path.dirname(manifestPath);
    const temporaryPath = `${manifestPath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(temporaryPath, "w", 0o600);
    try {
        fs.writeFileSync(descriptor, serialized, "utf8");
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, manifestPath);
    fsyncDirectory(directory);
}
export function segmentStoreState(manifest) {
    return sha256(JSON.stringify(manifest));
}
export function segmentStorageHealth(config) {
    const manifestExists = fs.existsSync(config.manifestPath);
    const manifest = readManifest(config.manifestPath);
    const migration = manifest.migration;
    const migrationState = !manifestExists || !migration
        ? "none"
        : migration.error ? "error" : migration.complete ? "complete" : "pending";
    return {
        storage_layout: "segmented-v1",
        migration_state: migrationState,
        active_bytes: fs.existsSync(config.rawLogPath) ? fs.statSync(config.rawLogPath).size : 0,
        archive_bytes: manifest.segments.reduce((total, record) => {
            const segmentPath = path.join(config.home, record.path);
            return total + (fs.existsSync(segmentPath) ? fs.statSync(segmentPath).size : 0);
        }, 0),
        plain_segment_count: manifest.segments.filter((record) => !record.compressed).length,
        compressed_segment_count: manifest.segments.filter((record) => record.compressed).length,
        ...(config.configError ? { config_error: config.configError } : {}),
    };
}
function validateManifest(value) {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments))
        fail();
    const migration = value.migration === undefined ? undefined : validateMigration(value.migration);
    return {
        version: 1,
        ...(migration === undefined ? {} : { migration }),
        segments: value.segments.map(validateSegment),
    };
}
function validateMigration(value) {
    if (!isRecord(value) || !isRelativePath(value.legacy_path) || !isNonNegativeInteger(value.offset) || typeof value.complete !== "boolean") {
        fail();
    }
    if (value.error !== undefined && !isNonEmptyString(value.error))
        fail();
    return {
        legacy_path: value.legacy_path,
        offset: value.offset,
        complete: value.complete,
        ...(value.error === undefined ? {} : { error: value.error }),
    };
}
function validateSegment(value) {
    if (!isRecord(value)
        || !isNonEmptyString(value.id)
        || !isRelativePath(value.path)
        || typeof value.compressed !== "boolean"
        || !isNonNegativeInteger(value.byte_count)
        || !isNonNegativeInteger(value.event_count)
        || !isNonEmptyString(value.first_timestamp)
        || !isNonEmptyString(value.last_timestamp)
        || !isNonEmptyString(value.sha256)
        || !/^[a-f0-9]{64}$/iu.test(value.sha256)) {
        fail();
    }
    return {
        id: value.id,
        path: value.path,
        compressed: value.compressed,
        byte_count: value.byte_count,
        event_count: value.event_count,
        first_timestamp: value.first_timestamp,
        last_timestamp: value.last_timestamp,
        sha256: value.sha256,
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRelativePath(value) {
    return isNonEmptyString(value)
        && !path.isAbsolute(value)
        && !path.win32.isAbsolute(value)
        && !value.split(/[\\/]+/u).includes("..");
}
function fail() {
    throw new Error("Malformed segment manifest.");
}
function fsyncDirectory(directory) {
    if (process.platform === "win32")
        return;
    const descriptor = fs.openSync(directory, "r");
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
