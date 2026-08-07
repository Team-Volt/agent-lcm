import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PACKAGE_NAME = "@team-volt/agent-lcm";
const MANIFESTS = ["plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"] as const;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(file: string): JsonRecord {
  const value: unknown = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (!isRecord(value)) throw new TypeError(`${file} must contain a JSON object.`);
  return value;
}

function readVersion(record: JsonRecord, file: string): string {
  const version = record["version"];
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new TypeError(`${file} has an invalid semantic version.`);
  }
  return version;
}

function writeRecord(file: string, record: JsonRecord): void {
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(record, null, 2)}\n`);
}

function checkRelease(tag: string | undefined): void {
  const packageJson = readRecord("package.json");
  const version = readVersion(packageJson, "package.json");
  assert.equal(packageJson["name"], PACKAGE_NAME, "unexpected npm package name");

  const lock = readRecord("package-lock.json");
  assert.equal(lock["name"], PACKAGE_NAME, "package-lock.json name differs");
  assert.equal(readVersion(lock, "package-lock.json"), version, "package-lock.json version differs");
  const packages = lock["packages"];
  assert.ok(isRecord(packages) && isRecord(packages[""]), "package-lock.json root package is missing");
  assert.equal(packages[""]["name"], PACKAGE_NAME, "package-lock.json root name differs");
  assert.equal(packages[""]["version"], version, "package-lock.json root version differs");

  for (const file of MANIFESTS) {
    assert.equal(readVersion(readRecord(file), file), version, `${file} version differs`);
  }
  if (tag !== undefined) assert.equal(tag, `v${version}`, "release tag must match package version");
  process.stdout.write(`${PACKAGE_NAME}@${version} is ready${tag === undefined ? "" : ` for ${tag}`}\n`);
}

function setVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new TypeError(`Invalid semantic version: ${version}`);
  for (const file of ["package.json", ...MANIFESTS]) {
    writeRecord(file, { ...readRecord(file), version });
  }

  const lock = readRecord("package-lock.json");
  const packages = lock["packages"];
  assert.ok(isRecord(packages) && isRecord(packages[""]), "package-lock.json root package is missing");
  writeRecord("package-lock.json", {
    ...lock,
    version,
    packages: { ...packages, "": { ...packages[""], version } },
  });
  checkRelease(undefined);
}

const [command, value, extra] = process.argv.slice(2);
assert.equal(extra, undefined, "too many release arguments");
switch (command) {
  case "check":
    checkRelease(value);
    break;
  case "set":
    if (value === undefined) throw new TypeError("release version is required");
    setVersion(value);
    break;
  default:
    throw new TypeError("usage: release.ts check [tag] | set <version>");
}
