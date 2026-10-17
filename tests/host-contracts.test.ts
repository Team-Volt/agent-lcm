import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertPackedFileHonorsContract,
  HOST_CONTRACTS,
  HOST_IDS,
  hookEventKeys,
  type HostContract,
} from "../src/host-contracts.ts";
import { readJson } from "./helpers.ts";

test("every host id has one contract row", () => {
  assert.deepEqual(Object.keys(HOST_CONTRACTS).sort(), [...HOST_IDS].sort());
});

test("packed host files keep their own plugin-root token and reject foreign tokens", () => {
  for (const host of Object.values(HOST_CONTRACTS)) {
    for (const file of host.files) {
      const text = fs.readFileSync(file.path, "utf8");
      assertPackedFileHonorsContract(file, text);
      assertHookSchema(host, file.path, readJson(file.path));
    }
  }
});

test("replacing Cursor CURSOR_PLUGIN_ROOT with PLUGIN_ROOT fails the contract", () => {
  const cursorHooks = HOST_CONTRACTS.cursorPlugin.files[0];
  assert.equal(cursorHooks?.path, "hooks/cursor.json");
  const unified = fs.readFileSync("hooks/cursor.json", "utf8").replaceAll("${CURSOR_PLUGIN_ROOT}", "${PLUGIN_ROOT}");
  assert.throws(
    () => assertPackedFileHonorsContract(cursorHooks, unified),
    /foreign plugin-root token \$\{PLUGIN_ROOT\}/u,
  );
});

test("copying Cursor hooks onto the Codex contract fails", () => {
  const codexHooks = HOST_CONTRACTS.codex.files[0];
  assert.equal(codexHooks?.path, "hooks/codex.json");
  const copied = fs.readFileSync("hooks/cursor.json", "utf8");
  assert.throws(
    () => assertPackedFileHonorsContract(codexHooks, copied),
    /foreign plugin-root token \$\{CURSOR_PLUGIN_ROOT\}/u,
  );
});

function assertHookSchema(host: HostContract, filePath: string, value: unknown): void {
  if (!filePath.includes("hooks")) return;
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) return;
  if (host.hookSchema === "portable-v1") assert.equal(value.version, 1);
  else assert.equal("version" in value, false);
  assert.equal(isRecord(value.hooks), true);
  if (!isRecord(value.hooks)) return;
  assert.deepEqual(Object.keys(value.hooks).sort(), [...hookEventKeys(host.hookSchema)].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
