import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// What a contract test of Copilot CLI's sandbox (ADR-181) runs in a task: a script committed into the repo, so that
// Copilot CLI's check of the paths in a command cannot see what it writes, as with a build script. It tries to write
// outside the worktree in the places that would matter: a folder of the user's home (outside the temporary folder,
// which the sandbox lets commands write in), and the main repo's git hooks and config, which would run outside the
// sandbox on the next git command there.

const PROBE_DIR = join(homedir(), ".trackwall-sandbox-contract");
const ESCAPED = join(PROBE_DIR, "escaped.txt");
const SCRIPT_NAME = "escape.mjs";

/**
 * What Copilot CLI answers every command with on a Windows without BaseContainer, such as GitHub's Windows runners: the
 * sandbox fails closed there, so the test checks that nothing ran instead of what the sandbox let through.
 */
const WINDOWS_WITHOUT_SANDBOX = "Windows sandboxing requires BaseContainer";

/** Whether the shell's answers to the model say the sandbox could not run, so every command was refused. */
export function sandboxRefusedEverything(answers: readonly string[]): boolean {
  return process.platform === "win32" && answers.length > 0 && answers.every((a) => a.includes(WINDOWS_WITHOUT_SANDBOX));
}

/** The command the model runs in the task's worktree. */
export const ESCAPE_COMMAND = `node ${SCRIPT_NAME}`;

const SCRIPT = `import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const attempt = (write) => { try { write(); } catch {} };
attempt(() => writeFileSync(${JSON.stringify(ESCAPED)}, "x"));
const common = resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
attempt(() => writeFileSync(join(common, "hooks", "post-checkout"), "#!/bin/sh\\n"));
attempt(() => appendFileSync(join(common, "config"), "[core]\\n\\thooksPath = escaped\\n"));
`;

/** The escape script committed into `repo`, and how to take it out again and see what it reached. */
export function commitEscapeScript(repo: string) {
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout;
  };
  mkdirSync(PROBE_DIR, { recursive: true });
  const config = join(repo, ".git", "config");
  const configBefore = readFileSync(config, "utf8");
  writeFileSync(join(repo, SCRIPT_NAME), SCRIPT);
  git("add", SCRIPT_NAME);
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "add the escape script");
  return {
    /** Each place outside the worktree the script wrote into. */
    escapes: () =>
      [
        existsSync(ESCAPED) && "the user's home",
        existsSync(join(repo, ".git", "hooks", "post-checkout")) && "the repo's git hooks",
        readFileSync(config, "utf8") !== configBefore && "the repo's git config",
      ].filter((place) => place !== false),
    /**
     * The repo as it was, its git hooks and config included, so that later tests start from the same commit and the
     * daemon, which refuses git in a repo whose run settings a sandboxed task changed, runs git there again.
     */
    remove: () => {
      writeFileSync(config, configBefore);
      rmSync(join(repo, ".git", "hooks", "post-checkout"), { force: true });
      git("reset", "-q", "--hard", "HEAD~1");
      rmSync(PROBE_DIR, { recursive: true, force: true });
    },
  };
}
