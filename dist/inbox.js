import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodePersistedEvent } from "./event-codec.js";
export function publishInboxEvent(config, event) {
    ensureInboxDirectories(config);
    const targetPath = path.join(config.inboxDir, `${event.event_id}.json`);
    const temporaryPath = path.join(config.inboxDir, `.${event.event_id}.${crypto.randomUUID()}.tmp`);
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
        fs.writeFileSync(descriptor, JSON.stringify(event));
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    try {
        fs.linkSync(temporaryPath, targetPath);
        fs.unlinkSync(temporaryPath);
        fsyncDirectory(config.inboxDir);
    }
    catch (error) {
        if (!isAlreadyExists(error))
            throw error;
        resolveExistingPublication(config, temporaryPath, targetPath, event);
    }
    return targetPath;
}
export async function drainInbox(config, ingest, limit = 100) {
    ensureInboxDirectories(config);
    const report = { ingested: 0, duplicates: 0, quarantined: 0 };
    const pending = [];
    for (const name of fs.readdirSync(config.inboxDir).filter((entry) => entry.endsWith(".json")).sort().slice(0, limit)) {
        const inboxPath = path.join(config.inboxDir, name);
        try {
            const event = decodePersistedEvent(fs.readFileSync(inboxPath, "utf8"));
            if (path.basename(inboxPath, ".json") !== event.event_id)
                throw new Error("Inbox filename does not match event ID.");
            pending.push({ event, inboxPath });
        }
        catch {
            quarantine(config, inboxPath, name);
            report.quarantined += 1;
        }
    }
    if (pending.length > 0) {
        const result = await ingest(pending.map(({ event }) => event));
        report.ingested += result.imported;
        report.duplicates += result.skippedDuplicate;
        try {
            for (const { inboxPath } of pending)
                fs.unlinkSync(inboxPath);
        }
        finally {
            fsyncDirectory(config.inboxDir);
        }
    }
    return report;
}
function ensureInboxDirectories(config) {
    for (const directory of [config.home, config.inboxDir, config.quarantineDir, config.runtimeDir]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
    }
}
function resolveExistingPublication(config, temporaryPath, targetPath, event) {
    try {
        const existing = decodePersistedEvent(fs.readFileSync(targetPath, "utf8"));
        if (existing.event_id === event.event_id && existing.raw_input_sha256 === event.raw_input_sha256) {
            fs.unlinkSync(temporaryPath);
            fsyncDirectory(config.inboxDir);
            return;
        }
    }
    catch {
        // A missing or malformed original is handled below without exposing its contents.
    }
    quarantine(config, temporaryPath, `${path.basename(targetPath, ".json")}.conflict.json`);
    quarantineIfPresent(config, targetPath, path.basename(targetPath));
}
function quarantineIfPresent(config, sourcePath, targetName) {
    try {
        quarantine(config, sourcePath, targetName);
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
    }
}
function quarantine(config, sourcePath, targetName) {
    for (let attempt = 0;; attempt += 1) {
        const targetPath = quarantinePath(config.quarantineDir, targetName, attempt);
        try {
            fs.linkSync(sourcePath, targetPath);
        }
        catch (error) {
            if (isAlreadyExists(error))
                continue;
            throw error;
        }
        fs.chmodSync(targetPath, 0o600);
        fs.unlinkSync(sourcePath);
        fsyncDirectory(path.dirname(sourcePath));
        fsyncDirectory(config.quarantineDir);
        return;
    }
}
function quarantinePath(directory, name, attempt) {
    const base = path.basename(name);
    if (attempt === 0)
        return path.join(directory, base);
    const extension = path.extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    return path.join(directory, `${stem}.${attempt}${extension}`);
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
function isAlreadyExists(error) {
    return error instanceof Error && Reflect.get(error, "code") === "EEXIST";
}
function isMissing(error) {
    return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}
