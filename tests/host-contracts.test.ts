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

test("hook schemas reject null and malformed event values", () => {
  for (const host of Object.values(HOST_CONTRACTS)) {
    for (const file of host.files.filter((file) => file.path.includes("hooks"))) {
      const schema = readJson(file.path);
      assertHookSchema(host, file.path, schema);
      const nested = host.hookSchema !== "portable-v1";
      const malformedCommands = [
        null,
        {},
        { type: "invalid", command: "node" },
        { type: "command", command: null },
        { type: "command", command: "" },
        { type: "command", command: "node", args: "capture" },
        { type: "command", command: "node", args: [null] },
        ...(host.hookSchema === "claude-args" ? [{ type: "command", command: "node" }] : []),
      ];
      const malformedValues = [
        null, {}, [], [null], [{}],
        ...(nested ? [{ hooks: null }, { hooks: [] }].map((entry) => [entry]) : []),
        ...malformedCommands.map((command) => nested ? [{ hooks: [command] }] : [command]),
      ];
      for (const event of hookEventKeys(host.hookSchema)) {
        for (const malformed of malformedValues) {
          const mutated = structuredClone(schema);
          mutated.hooks[event] = malformed;
          assert.throws(() => assertHookSchema(host, file.path, mutated), assert.AssertionError);
        }
      }
    }
  }
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
  for (const entries of Object.values(value.hooks)) {
    assert.ok(Array.isArray(entries) && entries.length > 0);
    for (const entry of entries) {
      assert.ok(isRecord(entry));
      const commands = host.hookSchema === "portable-v1" ? [entry] : entry.hooks;
      assert.ok(Array.isArray(commands) && commands.length > 0);
      for (const command of commands) {
        assert.ok(isRecord(command));
        assert.equal(command.type, "command");
        assert.ok(typeof command.command === "string" && command.command.length > 0);
        if (host.hookSchema === "claude-args" || "args" in command) {
          assert.ok(Array.isArray(command.args));
          assert.ok(command.args.every((arg: unknown) => typeof arg === "string"));
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
