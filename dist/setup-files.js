import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function readSetupConfiguration(target) {
    let text;
    try {
        text = fs.readFileSync(target, "utf8");
    }
    catch (error) {
        if (hasCode(error, "ENOENT"))
            return undefined;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new Error(`Cannot update invalid setup configuration: ${target}`);
    }
    if (!isRecord(value))
        throw new Error(`Cannot update invalid setup configuration: ${target}`);
    return value;
}
export function writeSetupConfiguration(target, configuration) {
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(configuration, null, 2)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
}
export function backupSetupConfiguration(target) {
    const extension = path.extname(target);
    const stem = extension ? target.slice(0, -extension.length) : target;
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    for (let suffix = 0;; suffix += 1) {
        const candidate = `${stem}-pre-agent-lcm-${timestamp}${suffix ? `-${suffix}` : ""}${extension}`;
        try {
            fs.copyFileSync(target, candidate, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(candidate, 0o600);
            return;
        }
        catch (error) {
            if (!hasCode(error, "EEXIST"))
                throw error;
        }
    }
}
function hasCode(error, code) {
    return error instanceof Error && Reflect.get(error, "code") === code;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
