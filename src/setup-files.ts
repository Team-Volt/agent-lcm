import fs from "node:fs";
import path from "node:path";

export function readSetupConfiguration(target: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Cannot update invalid setup configuration: ${target}`);
  }
  if (!isRecord(value)) throw new Error(`Cannot update invalid setup configuration: ${target}`);
  return value;
}

export function writeSetupConfiguration(target: string, configuration: Record<string, unknown>): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

export function backupSetupConfiguration(target: string): void {
  const extension = path.extname(target);
  const stem = extension ? target.slice(0, -extension.length) : target;
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  for (let suffix = 0; ; suffix += 1) {
    const candidate = `${stem}-pre-agent-lcm-${timestamp}${suffix ? `-${suffix}` : ""}${extension}`;
    try {
      fs.copyFileSync(target, candidate, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(candidate, 0o600);
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
