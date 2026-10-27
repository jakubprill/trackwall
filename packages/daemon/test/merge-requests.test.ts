import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRequestsApi } from "@trackwall/protocol";
import { gitIn } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "m".repeat(43);
const GITLAB_MRS = "projects/shop%2Fshop/merge_requests";
const FAKE_SSH = join(import.meta.dir, "fixtures", "fake-ssh.ts");
const ORDERS_REMOTE = "ssh://git@gitlab.example.com/shop/orders.git";

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** The bare repo `orders` pushes to, through the fake ssh. */
let bare: string;
const opened: string[] = [];
const hosting = fakeHostingClis({ apiResponses: { [GITLAB_MRS]: [] } });

/**
 * Two repos: `shop` has its remote on a GitLab from the settings, which the test cannot push to, so a push there is
 * simulated by setting the remote-tracking branch; `orders` has an SSH address on the same GitLab, and a fake ssh
 * (`core.sshCommand`) takes its pushes to a bare repo on disk, so they really land somewhere they can be checked.
 */
beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      shop: { "README.md": "# shop\n", "src/cart.ts": "export const cart = [];\n" },
      orders: { "README.md": "# orders\n" },
    },
    miseCommand: ["mise"],
    hostingClis: hosting.clis,
    openUrl: (url) => opened.push(url),
  });
  gitIn(join(daemon.projects, "shop"), "remote", "add", "origin", "https://gitlab.example.com/shop/shop.git");
  const sshRoot = mkdtempSync(join(tmpdir(), "trackwall-remote-"));
  bare = join(sshRoot, "shop", "orders.git");
  gitIn(daemon.projects, "init", "-q", "--bare", bare);
  const orders = join(daemon.projects, "orders");
  gitIn(orders, "remote", "add", "origin", ORDERS_REMOTE);
  const quoted = (path: string) => `"${path.replaceAll("\\", "/")}"`;
  gitIn(orders, "config", "core.sshCommand", [process.execPath, FAKE_SSH, sshRoot].map(quoted).join(" "));
  gitIn(orders, "config", "ssh.variant", "simple");
  gitIn(orders, "push", "-q", "origin", "main");
  daemon.facade.workspace.setRepoHosts([{ kind: "gitlab", host: "gitlab.example.com" }]);
});

afterAll(async () => {
  await daemon.stop();
});

/** A task with one commit that adds `file`. */
async function taskWithCommit(repo: string, prompt: string, file = "change.txt") {
  const task = await daemon.facade.agents.createTask(repo, prompt);
  writeFileSync(join(task.worktree, file), `${prompt}\n`);
  gitIn(task.worktree, "add", file);
  gitIn(task.worktree, "commit", "-qm", prompt);
  return task;
}

describe.skipIf(process.versions.bun === undefined)("a merge request from a task on GitLab (fake Copilot CLI and glab)", () => {
  test("the form opens only once every commit is pushed, with the draft, and then the merge request and its pipeline show", async () => {
    const task = await taskWithCommit("shop", "Add a discount");
    writeFileSync(join(task.worktree, "notes.md"), "not committed\n");

    const before = await daemon.post(mergeRequestsApi.get, { task: task.id });
    expect(before).toEqual({
      task: task.id,
      push: { remote: "origin", commits: 1, published: false, unpushed: 1, behind: 0, uncommitted: 1 },
      project: { kind: "gitlab", host: "gitlab.example.com", path: "shop/shop" },
      lookup: null,
      targetBranch: "main",
    });
    await expect(daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Add a discount", description: "" })).rejects.toThrow(
      `push branch ${task.branch} first`,
    );

    // What a push leaves behind: the remote-tracking branch at the task branch's commit.
    gitIn(task.worktree, "update-ref", `refs/remotes/origin/${task.branch}`, "HEAD");
    const pushed = await daemon.post(mergeRequestsApi.get, { task: task.id });
    expect(pushed.push).toMatchObject({ published: true, unpushed: 0 });
    expect(pushed.lookup).toEqual({ kind: "none" });

    await daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Add a discount", description: "Adds 10% off." });
    const form = new URL(opened.at(-1) ?? "");
    expect(`${form.origin}${form.pathname}`).toBe("https://gitlab.example.com/shop/shop/-/merge_requests/new");
    expect(form.searchParams.get("merge_request[source_branch]")).toBe(task.branch);
    expect(form.searchParams.get("merge_request[target_branch]")).toBe("main");
    expect(form.searchParams.get("merge_request[title]")).toBe("Add a discount");
    expect(form.searchParams.get("merge_request[description]")).toBe("Adds 10% off.");

    // The user created the merge request in the form; a task whose answer is not cached yet sees it at once.
    hosting.reconfigure({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 3 }],
        [`${GITLAB_MRS}/3`]: {
          iid: 3,
          title: "Add a discount",
          web_url: "https://gitlab.example.com/shop/shop/-/merge_requests/3",
          state: "opened",
          head_pipeline: { status: "failed", web_url: "https://gitlab.example.com/shop/shop/-/pipelines/9" },
        },
      },
    });
    const other = await taskWithCommit("shop", "Another task");
    gitIn(other.worktree, "update-ref", `refs/remotes/origin/${other.branch}`, "HEAD");
    const found = await daemon.post(mergeRequestsApi.get, { task: other.id });
    expect(found.lookup).toEqual({
      kind: "found",
      mergeRequest: {
        number: 3,
        title: "Add a discount",
        url: "https://gitlab.example.com/shop/shop/-/merge_requests/3",
        state: "open",
        pipeline: { state: "failed", url: "https://gitlab.example.com/shop/shop/-/pipelines/9" },
      },
    });
    await expect(daemon.post(mergeRequestsApi.openForm, { task: other.id, title: "Again", description: "" })).rejects.toThrow(
      "already has an open merge request: https://gitlab.example.com/shop/shop/-/merge_requests/3",
    );
    expect(opened).toHaveLength(1);
  }, 60_000);

  test("a description too long for an address is cut in the form, never inside a character", async () => {
    hosting.reconfigure({ apiResponses: { [GITLAB_MRS]: [] } });
    const task = await taskWithCommit("shop", "Write long notes");
    gitIn(task.worktree, "update-ref", `refs/remotes/origin/${task.branch}`, "HEAD");

    await daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Long notes", description: "Zażółć gęślą jaźń 🦊 ".repeat(190) });

    const url = opened.at(-1) ?? "";
    expect(url.length).toBeLessThanOrEqual(7000);
    const description = new URL(url).searchParams.get("merge_request[description]") ?? "";
    expect(description.startsWith("Zażółć gęślą jaźń 🦊 ")).toBe(true);
    expect(description.endsWith("…")).toBe(true);
    expect(description).not.toContain("�");
  }, 60_000);
});

describe.skipIf(process.versions.bun === undefined)("pushing a task branch (real git, fake Copilot CLI)", () => {
  test("pushes the branch to the repo host it fetches from", async () => {
    const task = await taskWithCommit("orders", "Add an order note");

    const pushed = await daemon.post(mergeRequestsApi.push, { task: task.id });

    expect(pushed).toMatchObject({
      project: { kind: "gitlab", host: "gitlab.example.com", path: "shop/orders" },
      lookup: { kind: "none" },
      push: { remote: "origin", commits: 1, published: true, unpushed: 0, behind: 0 },
    });
    expect(gitIn(bare, "log", "-1", "--format=%s", task.branch).trim()).toBe("Add an order note");
  }, 60_000);

  test("a remote on no known repo host is not pushed to, and gets no form", async () => {
    const task = await taskWithCommit("orders", "Unknown host");
    daemon.facade.workspace.setRepoHosts([]);
    try {
      const unknown = "the main remote of orders is not on GitHub or on a repo host from the settings";
      await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow(unknown);
      await expect(daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Note", description: "" })).rejects.toThrow(unknown);
    } finally {
      daemon.facade.workspace.setRepoHosts([{ kind: "gitlab", host: "gitlab.example.com" }]);
    }
    expect(gitIn(bare, "branch", "--list", task.branch).trim()).toBe("");
  }, 60_000);

  test("a branch without commits is not pushed", async () => {
    const task = await daemon.facade.agents.createTask("orders", "nothing yet");

    await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow(
      `branch ${task.branch} has no commits yet; ask the agent to commit its changes`,
    );
    expect(gitIn(bare, "branch", "--list", task.branch).trim()).toBe("");
  }, 60_000);

  test("a remote that moved on refuses the push, which is never forced, and the branch shows behind", async () => {
    const task = await taskWithCommit("orders", "Change the order");
    await daemon.post(mergeRequestsApi.push, { task: task.id });
    // Someone else pushes to the task branch, and the task's agent amends its own commit.
    const colleague = join(mkdtempSync(join(tmpdir(), "trackwall-colleague-")), "orders");
    gitIn(daemon.projects, "clone", "-q", "--branch", task.branch, bare, colleague);
    gitIn(colleague, "commit", "-q", "--allow-empty", "-m", "A colleague's commit");
    gitIn(colleague, "push", "-q", "origin", task.branch);
    gitIn(task.worktree, "commit", "-q", "--amend", "-m", "Change the order, amended");

    await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow("rejected");
    expect(gitIn(bare, "log", "-1", "--format=%s", task.branch).trim()).toBe("A colleague's commit");
    gitIn(task.worktree, "fetch", "-q", "origin");
    const state = await daemon.post(mergeRequestsApi.get, { task: task.id });
    expect(state.push).toMatchObject({ published: true, unpushed: 1, behind: 2 });
  }, 60_000);

  test("hooks the agent wrote in the worktree do not run, not even when git updates the remote-tracking branch", async () => {
    const task = await taskWithCommit("orders", "Plant a hook");
    const marker = join(mkdtempSync(join(tmpdir(), "trackwall-hook-")), "ran");
    mkdirSync(join(task.worktree, ".hooks"));
    for (const hook of ["pre-push", "reference-transaction"]) {
      writeFileSync(join(task.worktree, ".hooks", hook), `#!/bin/sh\necho ${hook} >> "${marker.replaceAll("\\", "/")}"\n`);
      chmodSync(join(task.worktree, ".hooks", hook), 0o755);
    }
    gitIn(task.worktree, "config", "core.hooksPath", ".hooks");
    try {
      await daemon.post(mergeRequestsApi.push, { task: task.id });
    } finally {
      gitIn(task.worktree, "config", "--unset", "core.hooksPath");
    }

    expect(gitIn(bare, "log", "-1", "--format=%s", task.branch).trim()).toBe("Plant a hook");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("a push address the agent could set, other than where the remote fetches from, is refused", async () => {
    const task = await taskWithCommit("orders", "Push elsewhere");
    const elsewhere = join(mkdtempSync(join(tmpdir(), "trackwall-elsewhere-")), "orders.git");
    gitIn(daemon.projects, "init", "-q", "--bare", elsewhere);
    const refused = async (key: string, value: string, message: string) => {
      gitIn(task.worktree, "config", "--add", key, value);
      try {
        await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow(message);
      } finally {
        gitIn(task.worktree, "config", "--unset", "--fixed-value", key, value);
      }
    };

    await refused("remote.origin.pushurl", elsewhere, "origin pushes to a local or unusual address, not to gitlab.example.com/shop/orders");
    // A second address: git pushes to every `url` of a remote without a `pushurl`.
    await refused("remote.origin.url", "ssh://git@evil.example.com/shop/orders.git", "origin pushes to evil.example.com/shop/orders");

    expect(gitIn(elsewhere, "branch", "--list", task.branch).trim()).toBe("");
    expect(gitIn(bare, "branch", "--list", task.branch).trim()).toBe("");
  }, 60_000);

  test("a remote that is a local path, a command or plain git:// is never pushed to", async () => {
    const task = await taskWithCommit("orders", "Local remote");
    const unknown = "the main remote of orders is not on GitHub or on a repo host from the settings";
    const cases: [string, string][] = [
      [bare, unknown],
      ["ext::sh -c touch% /tmp/trackwall-ext-ran", unknown],
      // `git://` names the same project, but connects through `core.gitProxy`, a program the repo's config can name.
      ["git://gitlab.example.com/shop/orders.git", "origin is not an HTTPS or SSH address of a repo host"],
    ];
    for (const [url, message] of cases) {
      gitIn(task.worktree, "remote", "set-url", "origin", url);
      try {
        await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow(message);
      } finally {
        gitIn(task.worktree, "remote", "set-url", "origin", ORDERS_REMOTE);
      }
    }
    expect(gitIn(bare, "branch", "--list", task.branch).trim()).toBe("");
  }, 60_000);
});
