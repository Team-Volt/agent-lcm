import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeForStorage } from "../src/redact.ts";

test("redacts secret assignments nested inside JSON-like command strings", () => {
  const result = sanitizeForStorage({
    command: '{"text":"CLI password=test_cli_password token_budget=4096"}',
  });

  assert.deepEqual(result.value, {
    command: '{"text":"CLI password=[REDACTED:secret] token_budget=4096"}',
  });
  assert.equal(result.redactions.length, 1);
});

test("redacts shell-quoted secret assignments", () => {
  const result = sanitizeForStorage({
    command: "run --env 'password=test_cli_password' --env \"api_token=test_cli_token\"",
  });

  assert.deepEqual(result.value, {
    command: "run --env 'password=[REDACTED:secret]' --env \"api_token=[REDACTED:secret]\"",
  });
  assert.equal(result.redactions.length, 2);
});

test("redacts quotes inside unquoted secret values without leaking suffixes", () => {
  const result = sanitizeForStorage({
    command: "password=abc'def api_token=abc\"def",
  });

  assert.deepEqual(result.value, {
    command: "password=[REDACTED:secret] api_token=[REDACTED:secret]",
  });
});

test("preserves empty assignments and scans the following assignment", () => {
  const result = sanitizeForStorage({
    command: "password= api_token='' token_budget=4096 password= actual_secret",
  });

  assert.deepEqual(result.value, {
    command: "password= api_token='' token_budget=4096 password= [REDACTED:secret]",
  });
});

test("preserves closing quotes after an even number of backslashes", () => {
  const cases = [
    {
      input: String.raw`password="abc\\" token_budget=4096 api_token="actual_secret"`,
      expected: 'password="[REDACTED:secret]" token_budget=4096 api_token="[REDACTED:secret]"',
    },
    {
      input: String.raw`password="abc\"def" token_budget=4096`,
      expected: 'password="[REDACTED:secret]" token_budget=4096',
    },
    {
      input: String.raw`{"text":"password=\"abc\\\" token_budget=4096"}`,
      expected: String.raw`{"text":"password=\"[REDACTED:secret]\" token_budget=4096"}`,
    },
  ];

  for (const testCase of cases) {
    const result = sanitizeForStorage({ command: testCase.input });
    assert.deepEqual(result.value, { command: testCase.expected });
  }
});

test("redacts deeply nested assignments without overflowing the call stack", () => {
  const result = sanitizeForStorage({
    command: `${"x=".repeat(1000)}password=deep_secret`,
  });

  assert.equal(
    (result.value as { command: string }).command,
    `${"x=".repeat(1000)}password=[REDACTED:secret]`,
  );
});

test("preserves escaped JSON structure and benign metrics while redacting nested secrets", () => {
  const result = sanitizeForStorage({
    command: '{"command":"{\\"text\\":\\"password=deep_secret token_budget=4096\\"}"}',
  });

  assert.deepEqual(result.value, {
    command: '{"command":"{\\"text\\":\\"password=[REDACTED:secret] token_budget=4096\\"}"}',
  });
});

test("preserves enclosing quotes for terminal nested assignments", () => {
  const cases = [
    '{"text":"CLI password=actual_secret"}',
    String.raw`{\"text\":\"CLI password=actual_secret\"}`,
  ];

  for (const command of cases) {
    const result = sanitizeForStorage({ command });
    assert.equal(
      (result.value as { command: string }).command,
      command.replace("actual_secret", "[REDACTED:secret]"),
    );
  }
});

test("scans many secret assignments in linear time", () => {
  const command = "password=value ".repeat(25_000);
  const startedAt = performance.now();
  const result = sanitizeForStorage(
    { command },
    { maxStringBytes: 1024 * 1024, maxPayloadBytes: 2 * 1024 * 1024 },
  );

  assert.equal(result.redactions.length, 25_000);
  assert.ok(
    performance.now() - startedAt < 1_000,
    "expected 25,000 assignments to sanitize within one second",
  );
});
