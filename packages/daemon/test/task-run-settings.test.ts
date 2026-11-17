import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { agentsApi } from "@trackwall/protocol";
import { countedEntries } from "../src/modules/vcs/run-settings.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { sandboxProgramsFolder } from "./support/sandbox-programs.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A task in Copilot CLI's sandbox can still write the repo's `.git`, so the daemon guards the settings there that make
// git run a program (ADR-181 addendum, `run-settings.ts`): a clean filter written into `.git/config` would otherwise run
// on the daemon's next read of the task's changes, outside the sandbox.

const TOKEN = "r".repeat(43);
/** The clean filter tees the file's content into this file in the worktree, so its run leaves a trace. */
const TRACE = "ran-by-the-filter.txt";

let daemon: Awaited<ReturnType<typeof startSessionApi>> | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
}, 30_000);

function sandboxed(sandboxTasks: "all" | "off") {
  const path = `${sandboxProgramsFolder()}${delimiter}${process.env.PATH ?? ""}`;
  return startSessionApi(TOKEN, {
    ...ONE_REPO,
    sandboxTasks,
    copilot: { command: FAKE_COPILOT.command, env: () => ({ ...process.env, PATH: path }) },
  });
}

/** What the agent can do from the sandbox: a filter in the repo's own config and an attribute in the worktree. */
function writeFilter(repoDir: string, worktree: string): void {
  execFileSync("git", ["-C", repoDir, "config", "filter.trace.clean", `tee ${TRACE}`]);
  writeFileSync(join(worktree, ".gitattributes"), "*.md filter=trace\n");
  writeFileSync(join(worktree, "README.md"), "# shop, changed\n");
}

/** Git as the user runs it in a test repo: with an identity, and with clones of local folders allowed for submodules. */
function gitAsUser(dir: string, ...args: string[]): void {
  const config = ["protocol.file.allow=always", "user.name=Test", "user.email=test@example.com"].flatMap((entry) => ["-c", entry]);
  execFileSync("git", ["-C", dir, ...config, ...args], { stdio: "pipe" });
}

describe.skipIf(process.versions.bun === undefined)(
  "the run settings of a repo with a task in the sandbox (real git, fake Copilot CLI)",
  () => {
    test(
      "without the sandbox the daemon's read of a task's changes runs a filter written into .git/config, which is the gap the guard closes",
      async () => {
        daemon = await sandboxed("off");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        expect(task.sandbox).toBe(false);
        writeFilter(join(daemon.projects, "shop"), task.worktree);

        await daemon.facade.agents.taskChanges(task.id);

        expect(existsSync(join(task.worktree, TRACE))).toBe(true);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "with a task in the sandbox git in the repo is refused once a filter is written into .git/config, also by a restarted daemon, until the change is undone",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        expect(task.sandbox).toBe(true);
        await daemon.facade.agents.taskChanges(task.id);
        writeFilter(repoDir, task.worktree);

        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");
        await expect(new Vcs(systemTempFolder).status(repoDir, "fresh")).rejects.toThrow("changed since a task in the sandbox started");
        expect(existsSync(join(task.worktree, TRACE))).toBe(false);

        const dirs = { home: daemon.home, projects: daemon.projects };
        await daemon.stop();
        daemon = await startSessionApi(TOKEN, { ...ONE_REPO, restartOf: dirs, copilot: FAKE_COPILOT });
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");

        execFileSync("git", ["-C", repoDir, "config", "--unset", "filter.trace.clean"]);
        expect((await daemon.facade.agents.taskChanges(task.id)).files.map((f) => f.path)).toContain("README.md");
        expect(existsSync(join(task.worktree, TRACE))).toBe(false);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "a task's worktree whose .git the agent points at a git directory of its own is refused, and so is a config rewritten in place with its old times",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        execFileSync("git", ["-C", repoDir, "config", "filter.trace.clean", "cat -u"]);
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        await daemon.facade.agents.taskChanges(task.id);

        // The same size and modification time, as an agent's write followed by `touch -d` leaves it.
        const config = join(repoDir, ".git", "config");
        const before = statSync(config);
        writeFileSync(config, readFileSync(config, "utf8").replace("cat -u", `tee ${TRACE.slice(0, 2)}`));
        utimesSync(config, before.atime, before.mtime);
        expect(statSync(config).size).toBe(before.size);
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");
        execFileSync("git", ["-C", repoDir, "config", "filter.trace.clean", "cat -u"]);
        await daemon.facade.agents.taskChanges(task.id);

        // A git directory of the agent's own, inside the worktree it can write.
        const own = join(task.worktree, "own-git");
        execFileSync("git", ["init", "--quiet", "--bare", own]);
        writeFileSync(join(task.worktree, ".git"), `gitdir: ${own}\n`);
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("no longer leads to its repo's git directory");
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "settings git writes in ordinary work, husky's hooks path and a second task's worktree do not refuse git, while a new hook does",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://example.com/shop.git"]);
        execFileSync("git", ["-C", repoDir, "config", "branch.main.remote", "origin"]);
        execFileSync("git", ["-C", repoDir, "config", "branch.main.merge", "refs/heads/main"]);
        execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", ".husky"]);
        execFileSync("git", ["-C", repoDir, "config", "lfs.repositoryformatversion", "0"]);
        await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "list the tests", approvals: "auto" });

        await daemon.facade.agents.taskChanges(task.id);

        writeFileSync(join(repoDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "a hook in the folder a relative hooks path names does not run on the daemon's git in a repo with a task in the sandbox: not on a read of the task's changes, not on a fetch",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        await daemon.facade.agents.taskChanges(task.id);
        // What the agent can do from the sandbox: a hooks path that does not count as a run setting (husky writes one),
        // naming a folder of its worktree and one of the repo's git directory, both of which it writes.
        execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", "tw-hooks"]);
        const ran = join(daemon.projects, "ran-by-a-hook.txt");
        for (const folder of [join(task.worktree, "tw-hooks"), join(repoDir, "tw-hooks")]) {
          mkdirSync(folder);
          for (const hook of ["post-index-change", "reference-transaction"]) {
            writeFileSync(join(folder, hook), `#!/bin/sh\necho ${hook} >> "${ran.replaceAll("\\", "/")}"\n`);
            chmodSync(join(folder, hook), 0o755);
          }
        }
        writeFileSync(join(task.worktree, "new-file.txt"), "untracked, so the read writes an index of its own\n");
        const upstream = join(daemon.projects, "..", `upstream-${task.id}.git`);
        execFileSync("git", ["clone", "--quiet", "--bare", repoDir, upstream]);
        execFileSync("git", ["-C", repoDir, "-c", "core.hooksPath=", "remote", "add", "origin", upstream]);

        expect((await daemon.facade.agents.taskChanges(task.id)).files.map((f) => f.path)).toContain("new-file.txt");
        await new Vcs(systemTempFolder).sync(repoDir);

        expect(existsSync(ran)).toBe(false);
        // The same fetch by the user's own git runs the hook: the folder and the hooks are in place.
        execFileSync("git", ["-C", repoDir, "update-ref", "refs/heads/by-the-user", "HEAD"]);
        expect(readFileSync(ran, "utf8")).toContain("reference-transaction");
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "a remote address that names a program, a proxy for git's requests and a transfer program of git-lfs written into .git/config refuse git",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://example.com/shop.git"]);
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        await daemon.facade.agents.taskChanges(task.id);
        const ran = join(daemon.projects, "ran-by-the-remote.txt");
        writeFileSync(join(task.worktree, "remote.sh"), `echo ran > "${ran.replaceAll("\\", "/")}"\n`);
        const refused = "changed since a task in the sandbox started";

        // `ext::` runs its command as the transport of a fetch, once the repo allows the protocol.
        execFileSync("git", ["-C", repoDir, "config", "protocol.ext.allow", "always"]);
        execFileSync("git", [
          "-C",
          repoDir,
          "config",
          "remote.origin.url",
          `ext::sh ${join(task.worktree, "remote.sh").replaceAll("\\", "/")}`,
        ]);
        await expect(new Vcs(systemTempFolder).sync(repoDir)).rejects.toThrow(refused);
        expect(existsSync(ran)).toBe(false);
        execFileSync("git", ["-C", repoDir, "config", "--unset", "protocol.ext.allow"]);
        execFileSync("git", ["-C", repoDir, "config", "remote.origin.url", "https://example.com/shop.git"]);
        await daemon.facade.agents.taskChanges(task.id);

        // A proxy without a certificate check would get the user's credentials for the repo host.
        execFileSync("git", ["-C", repoDir, "config", "http.proxy", "http://127.0.0.1:9"]);
        execFileSync("git", ["-C", repoDir, "config", "http.sslVerify", "false"]);
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow(refused);
        execFileSync("git", ["-C", repoDir, "config", "--remove-section", "http"]);
        await daemon.facade.agents.taskChanges(task.id);

        // git-lfs runs this program at the next checkout of an LFS file.
        execFileSync("git", ["-C", repoDir, "config", "lfs.customtransfer.own.path", join(task.worktree, "remote.sh")]);
        execFileSync("git", ["-C", repoDir, "config", "lfs.standalonetransferagent", "own"]);
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow(refused);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "a fetch in a repo with a task in the sandbox does not go into a submodule, whose own git config the task can write",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const outside = join(daemon.projects, "..");
        const unique = `${Date.now()}-${process.pid}`;
        // A repo with a submodule, cloned from a remote that moves on to a new commit of the submodule.
        const library = join(outside, `library-${unique}`);
        const libraryRemote = join(outside, `library-${unique}.git`);
        execFileSync("git", ["init", "--quiet", library]);
        writeFileSync(join(library, "a.txt"), "one\n");
        gitAsUser(library, "add", ".");
        gitAsUser(library, "commit", "--quiet", "-m", "one");
        execFileSync("git", ["clone", "--quiet", "--bare", library, libraryRemote]);
        gitAsUser(repoDir, "submodule", "add", "--quiet", libraryRemote, "library");
        gitAsUser(repoDir, "commit", "--quiet", "-m", "add the library");
        const remote = join(outside, `shop-${unique}.git`);
        execFileSync("git", ["clone", "--quiet", "--bare", repoDir, remote]);
        gitAsUser(repoDir, "remote", "add", "origin", remote);
        gitAsUser(repoDir, "fetch", "--quiet", "origin");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        await daemon.facade.agents.taskChanges(task.id);
        writeFileSync(join(library, "a.txt"), "two\n");
        gitAsUser(library, "commit", "--quiet", "-am", "two");
        gitAsUser(library, "push", "--quiet", libraryRemote, "HEAD");
        const colleague = join(outside, `colleague-${unique}`);
        gitAsUser(outside, "clone", "--quiet", "--recurse-submodules", remote, colleague);
        gitAsUser(join(colleague, "library"), "pull", "--quiet", "origin", "HEAD");
        gitAsUser(colleague, "commit", "--quiet", "-am", "newer library");
        gitAsUser(colleague, "push", "--quiet", "origin", "HEAD");

        // What the agent can do from the sandbox: the submodule's git directory lies in the repo's `.git`.
        const ran = join(daemon.projects, "ran-by-the-submodule.txt");
        writeFileSync(join(task.worktree, "remote.sh"), `echo ran > "${ran.replaceAll("\\", "/")}"\n`);
        const config = join(repoDir, ".git", "modules", "library", "config");
        execFileSync("git", ["config", "--file", config, "protocol.ext.allow", "always"]);
        execFileSync("git", [
          "config",
          "--file",
          config,
          "remote.origin.url",
          `ext::sh ${join(task.worktree, "remote.sh").replaceAll("\\", "/")}`,
        ]);

        await new Vcs(systemTempFolder).sync(repoDir);

        expect(existsSync(ran)).toBe(false);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  },
);

describe("the entries of a repo configuration that count as run settings", () => {
  test("keys with which git runs a program or reads another file count, in their order, and the rest is left out", () => {
    const list = [
      "core.bare\nfalse",
      "core.filemode\ntrue",
      "remote.origin.url\nhttps://example.com/shop.git",
      "remote.origin.uploadpack\nsh -c id",
      "branch.main.remote\norigin",
      "branch.main.vscode-merge-base\norigin/main",
      "lfs.https://example.com/shop.git/info/lfs.access\nbasic",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "core.fsmonitor\n./watch",
      "include.path\n../shared.gitconfig",
      "core.hookspath\n.husky",
      "core.hookspath\n../elsewhere",
      "core.hookspath\n/tmp/hooks",
      "protocol.ext.allow\nalways",
      "http.proxy\nhttp://127.0.0.1:8080",
      "http.https://example.com/.sslverify\nfalse",
      "lfs.repositoryformatversion\n0",
      "lfs.standalonetransferagent\nown",
      "lfs.customtransfer.own.path\n/tmp/transfer",
      "",
    ].join("\0");

    expect(countedEntries(list)).toEqual([
      "core.bare\nfalse",
      "remote.origin.uploadpack\nsh -c id",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "core.fsmonitor\n./watch",
      "include.path\n../shared.gitconfig",
      "core.hookspath\n../elsewhere",
      "core.hookspath\n/tmp/hooks",
      "protocol.ext.allow\nalways",
      "http.proxy\nhttp://127.0.0.1:8080",
      "http.https://example.com/.sslverify\nfalse",
      "lfs.standalonetransferagent\nown",
      "lfs.customtransfer.own.path\n/tmp/transfer",
    ]);
  });
});
