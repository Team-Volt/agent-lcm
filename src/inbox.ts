import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { LcmConfig } from "./config.ts";
import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";

export type DrainInboxReport = {
  ingested: number;
  duplicates: number;
  quarantined: number;
};

export function publishInboxEvent(config: LcmConfig, event: NormalizedEvent): string {
  ensureInboxDirectories(config);
  const targetPath = path.join(config.inboxDir, `${event.event_id}.json`);
  const temporaryPath = path.join(config.inboxDir, `.${event.event_id}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(event));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (fs.existsSync(targetPath)) {
    resolveExistingPublication(config, temporaryPath, targetPath, event);
  } else {
    try {
      fs.renameSync(temporaryPath, targetPath);
      fsyncDirectory(config.inboxDir);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      resolveExistingPublication(config, temporaryPath, targetPath, event);
    }
  }
  return targetPath;
}

export function drainInbox(
  config: LcmConfig,
  ingest: (event: NormalizedEvent) => "ingested" | "duplicate",
): DrainInboxReport {
  ensureInboxDirectories(config);
  const report: DrainInboxReport = { ingested: 0, duplicates: 0, quarantined: 0 };
  for (const name of fs.readdirSync(config.inboxDir).filter((entry) => entry.endsWith(".json")).sort()) {
    const inboxPath = path.join(config.inboxDir, name);
    let event: NormalizedEvent;
    try {
      event = decodePersistedEvent(fs.readFileSync(inboxPath, "utf8"));
      if (path.basename(inboxPath, ".json") !== event.event_id) throw new Error("Inbox filename does not match event ID.");
    } catch {
      quarantine(config, inboxPath, name);
      report.quarantined += 1;
      continue;
    }
    const result = ingest(event);
    if (result === "ingested") report.ingested += 1;
    else report.duplicates += 1;
    fs.unlinkSync(inboxPath);
    fsyncDirectory(config.inboxDir);
  }
  return report;
}

function ensureInboxDirectories(config: LcmConfig): void {
  for (const directory of [config.home, config.inboxDir, config.quarantineDir, config.runtimeDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
}

function resolveExistingPublication(
  config: LcmConfig,
  temporaryPath: string,
  targetPath: string,
  event: NormalizedEvent,
): void {
  try {
    const existing = decodePersistedEvent(fs.readFileSync(targetPath, "utf8"));
    if (existing.event_id === event.event_id && existing.raw_input_sha256 === event.raw_input_sha256) {
      fs.unlinkSync(temporaryPath);
      fsyncDirectory(config.inboxDir);
      return;
    }
  } catch {
    // A malformed existing item is quarantined with the conflicting publication.
  }
  quarantine(config, targetPath, path.basename(targetPath));
  quarantine(config, temporaryPath, `${path.basename(targetPath, ".json")}.conflict.json`);
}

function quarantine(config: LcmConfig, sourcePath: string, targetName: string): void {
  const targetPath = uniquePath(config.quarantineDir, targetName);
  fs.renameSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o600);
  fsyncDirectory(path.dirname(sourcePath));
  fsyncDirectory(config.quarantineDir);
}

function uniquePath(directory: string, name: string): string {
  const base = path.basename(name);
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  let index = 0;
  let candidate = path.join(directory, base);
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(directory, `${stem}.${index}${extension}`);
  }
  return candidate;
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "EEXIST";
}
