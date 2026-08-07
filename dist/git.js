import { spawnSync } from "node:child_process";
export function resolveGitMetadata(cwd) {
    const repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
    if (!repoRoot)
        return {};
    return {
        repoRoot,
        gitBranch: runGit(["branch", "--show-current"], repoRoot),
    };
}
function runGit(args, cwd) {
    const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 500,
    });
    if (result.status !== 0)
        return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
}
