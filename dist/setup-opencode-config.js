import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, visit } from "jsonc-parser";
import { assertSafeSetupCommand } from "./setup-hook-status.js";
import { mutateSetupConfiguration, mutateSetupFile, readSetupFileBytes, } from "./setup-files.js";
import { openCodeJsoncPath } from "./setup-targets.js";
export function readOpenCodeConfigurationSnapshot(target, action) {
    try {
        const bytes = readSetupFileBytes(target);
        return {
            configuration: bytes === undefined ? undefined : target.endsWith(".jsonc")
                ? parseOpenCodeJsonc(bytes, target)
                : parseOpenCodeJson(bytes, target),
            hash: bytes === undefined ? "missing" : createHash("sha256").update(bytes).digest("hex"),
        };
    }
    catch (error) {
        throw new Error(`Cannot safely ${action} OpenCode configuration ${target}; fix it as valid JSON before rerunning.`, { cause: error });
    }
}
export function mutateOpenCodeMcp(target, action, command, snapshot) {
    if (!target.endsWith(".jsonc")) {
        return mutateSetupConfiguration(target, (existing) => action === "setup"
            ? updateOpenCodeMcp(existing, command)
            : removeOpenCodeMcp(existing, command), snapshot.hash);
    }
    return mutateSetupFile(target, (current) => {
        const source = current?.toString("utf8") ?? "{}\n";
        const existing = parseOpenCodeJsonc(Buffer.from(source), target);
        const currentMcp = isRecord(existing.mcp) ? existing.mcp["agent-lcm"] : undefined;
        if (action === "remove" && !isOwnedOpenCodeMcp(currentMcp, command))
            return current;
        const formattingOptions = {
            formattingOptions: {
                insertSpaces: true,
                tabSize: 2,
                eol: source.includes("\r\n") ? "\r\n" : "\n",
            },
        };
        const removeSoleMcpEntry = action === "remove" && isRecord(existing.mcp)
            && Object.keys(existing.mcp).length === 1;
        const edits = removeSoleMcpEntry
            ? modify(source, ["mcp"], {}, formattingOptions)
            : modify(source, ["mcp", "agent-lcm"], action === "setup" ? openCodeMcpEntry(command) : undefined, formattingOptions);
        const candidate = Buffer.from(applyEdits(source, edits), "utf8");
        parseOpenCodeJsonc(candidate, target);
        return candidate;
    }, snapshot.hash);
}
export function updateOpenCodeMcp(existing, command) {
    const servers = isRecord(existing?.mcp) ? existing.mcp : {};
    return {
        ...(existing ?? {}),
        mcp: {
            ...servers,
            "agent-lcm": openCodeMcpEntry(command),
        },
    };
}
export function removeOpenCodeMcp(existing, expectedCommand) {
    if (expectedCommand === undefined || existing === undefined || !isRecord(existing.mcp)
        || !isOwnedOpenCodeMcp(existing.mcp["agent-lcm"], expectedCommand))
        return existing;
    const servers = { ...existing.mcp };
    delete servers["agent-lcm"];
    return { ...existing, mcp: servers };
}
export function validateOpenCodeConfiguration(configuration, target, action, expectedCommand) {
    if (configuration === undefined)
        return;
    if (configuration.mcp !== undefined && !isRecord(configuration.mcp)) {
        throw new Error(`Cannot safely ${action} OpenCode MCP configuration: mcp must be an object in ${target}.`);
    }
    const mcp = configuration.mcp;
    if (action === "setup" && isRecord(mcp) && mcp["agent-lcm"] !== undefined
        && !isOwnedOpenCodeMcp(mcp["agent-lcm"], expectedCommand)) {
        throw new Error(`Refusing to overwrite unmanaged OpenCode MCP entry: ${target}`);
    }
}
export function isOwnedOpenCodeMcp(value, expectedCommand) {
    if (!isRecord(value) || value.type !== "local" || value.enabled !== true || !Array.isArray(value.command))
        return false;
    const keys = Object.keys(value);
    if (keys.length !== 3 || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "command") || !Object.hasOwn(value, "enabled"))
        return false;
    if (value.command.length !== 3 || value.command[0] !== "node" || value.command[2] !== "mcp")
        return false;
    const command = value.command[1];
    if (typeof command !== "string" || !path.isAbsolute(command) || (expectedCommand !== undefined && command !== expectedCommand))
        return false;
    try {
        assertSafeSetupCommand(command);
        return true;
    }
    catch {
        return false;
    }
}
export function openCodeJsoncExists(home) {
    try {
        fs.lstatSync(openCodeJsoncPath(home));
        return true;
    }
    catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT")
            return false;
        throw error;
    }
}
function openCodeMcpEntry(command) {
    return { type: "local", command: ["node", command, "mcp"], enabled: true };
}
function parseOpenCodeJsonc(bytes, target) {
    return parseOpenCodeConfiguration(bytes, target, true);
}
function parseOpenCodeJson(bytes, target) {
    return parseOpenCodeConfiguration(bytes, target, false);
}
function parseOpenCodeConfiguration(bytes, target, allowJsonc) {
    const source = bytes.toString("utf8");
    const errors = [];
    const options = { disallowComments: !allowJsonc, allowTrailingComma: allowJsonc };
    const value = parse(source, errors, options);
    if (errors.length > 0 || !isRecord(value)) {
        const issue = errors[0];
        const detail = issue === undefined ? "root must be an object" : `${printParseErrorCode(issue.error)} at offset ${String(issue.offset)}`;
        throw new Error(`Cannot update invalid setup configuration: ${target} (${detail})`);
    }
    assertUnambiguousOpenCodePaths(source, target, options);
    return value;
}
function assertUnambiguousOpenCodePaths(source, target, options) {
    const paths = new Set();
    let duplicate;
    visit(source, {
        onObjectProperty: (property, _offset, _length, _line, _character, pathSupplier) => {
            const parentPath = pathSupplier();
            const key = property === "mcp" && parentPath.length === 0
                ? "mcp"
                : property === "agent-lcm" && parentPath.length === 1 && parentPath[0] === "mcp"
                    ? "mcp.agent-lcm"
                    : undefined;
            if (key === undefined || duplicate !== undefined)
                return;
            if (paths.has(key))
                duplicate = key;
            else
                paths.add(key);
        },
    }, options);
    if (duplicate !== undefined) {
        throw new Error(`Cannot update ambiguous OpenCode configuration: ${target} (duplicate ${duplicate} key)`);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
