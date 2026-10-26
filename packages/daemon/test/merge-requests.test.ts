import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRequestsApi } from "@trackwall/protocol";
import { gitIn } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "m".repeat(43);
const GITLAB_MRS = "projects/shop%2Fshop/merge_requests";

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let remote: string;
const opened: string[] = [];
const hosting = fakeHostingClis({ apiResponses: { [GITLAB_MRS]: [] } });

/**
 * The repo `shop` fetches from a GitLab address and pushes to a bare repo on disk (`pushurl`), so the daemon sees a
 * GitLab remote and a push really lands somewhere it can be checked.
 */
beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n", "src/cart.ts": "export const cart = [];\n" } },
    miseCommand: ["mise"],
    hostingClis: hosting.clis,
    openUrl: (url) => opened.push(url),
  });
  remote = join(mkdtempSync(join(tmpdir(), "trackwall-remote-")), "shop.git");
  gitIn(daemon.projects, "init", "-q", "--bare", remote);
  const shop = join(daemon.projects, "shop");
  gitIn(shop, "remote", "add", "origin", "https://gitlab.example.com/shop/shop.git");
  gitIn(shop, "config", "remote.origin.pushurl", remote);
  gitIn(shop, "push", "-q", "origin", "main");
  daemon.facade.workspace.setRepoHosts([{ kind: "gitlab", host: "gitlab.example.com" }]);
});

afterAll(async () => {
  await daemon.stop();
});

describe.skipIf(process.versions.bun === undefined)("a merge request from a task (real git, fake Copilot CLI and glab)", () => {
  test("push the task branch, open GitLab's form with the draft, then follow the merge request and its pipeline", async () => {
    const task = await daemon.facade.agents.createTask("shop", "add a discount");
    writeFileSync(join(task.worktree, "src", "cart.ts"), "export const cart = [];\nexport const discount = 0.1;\n");
    gitIn(task.worktree, "commit", "-qam", "Add a discount");
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

    const pushed = await daemon.post(mergeRequestsApi.push, { task: task.id });
    expect(pushed.push).toEqual({ remote: "origin", commits: 1, published: true, unpushed: 0, behind: 0, uncommitted: 1 });
    expect(pushed.lookup).toEqual({ kind: "none" });
    expect(gitIn(remote, "log", "-1", "--format=%s", task.branch).trim()).toBe("Add a discount");

    await daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Add a discount", description: "Adds 10% off." });
    const form = new URL(opened.at(-1) ?? "");
    expect(`${form.origin}${form.pathname}`).toBe("https://gitlab.example.com/shop/shop/-/merge_requests/new");
    expect(form.searchParams.get("merge_request[source_branch]")).toBe(task.branch);
    expect(form.searchParams.get("merge_request[target_branch]")).toBe("main");
    expect(form.searchParams.get("merge_request[description]")).toBe("Adds 10% off.");

    // The user created the merge request in the form; the next push or a read after the cache sees it.
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
    gitIn(task.worktree, "commit", "-qam", "Fix the discount", "--allow-empty");
    const again = await daemon.post(mergeRequestsApi.push, { task: task.id });
    expect(again.push).toMatchObject({ commits: 2, unpushed: 0 });
    expect(again.lookup).toEqual({
      kind: "found",
      mergeRequest: {
        number: 3,
        title: "Add a discount",
        url: "https://gitlab.example.com/shop/shop/-/merge_requests/3",
        state: "open",
        pipeline: { state: "failed", url: "https://gitlab.example.com/shop/shop/-/pipelines/9" },
      },
    });
    await expect(daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Again", description: "" })).rejects.toThrow(
      "already has an open merge request: https://gitlab.example.com/shop/shop/-/merge_requests/3",
    );
    expect(opened).toHaveLength(1);
  }, 60_000);

  test("a branch without commits is not pushed", async () => {
    const task = await daemon.facade.agents.createTask("shop", "nothing yet");

    await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow(
      `branch ${task.branch} has no commits yet; ask the agent to commit its changes`,
    );
    expect(gitIn(remote, "branch", "--list", task.branch).trim()).toBe("");
  }, 60_000);

  test("a remote that moved on refuses the push, which is never forced, and the panel shows the branch behind", async () => {
    const task = await daemon.facade.agents.createTask("shop", "change the cart");
    writeFileSync(join(task.worktree, "src", "cart.ts"), "export const cart = [1];\n");
    gitIn(task.worktree, "commit", "-qam", "Change the cart");
    await daemon.post(mergeRequestsApi.push, { task: task.id });
    // Someone else pushes to the task branch, and the task's agent amends its own commit.
    const other = join(mkdtempSync(join(tmpdir(), "trackwall-other-")), "shop");
    gitIn(daemon.projects, "clone", "-q", "--branch", task.branch, remote, other);
    gitIn(other, "commit", "-q", "--allow-empty", "-m", "A colleague's commit");
    gitIn(other, "push", "-q", "origin", task.branch);
    gitIn(task.worktree, "commit", "-q", "--amend", "-m", "Change the cart, amended");

    await expect(daemon.post(mergeRequestsApi.push, { task: task.id })).rejects.toThrow("rejected");
    expect(gitIn(remote, "log", "-1", "--format=%s", task.branch).trim()).toBe("A colleague's commit");
    // A sync would fetch from the GitLab address; the test fetches from the bare repo into the same remote-tracking branch.
    gitIn(task.worktree, "fetch", "-q", remote, `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`);
    const state = await daemon.post(mergeRequestsApi.get, { task: task.id });
    expect(state.push).toMatchObject({ published: true, unpushed: 1, behind: 2 });
  }, 60_000);
});

describe.skipIf(process.versions.bun === undefined)("a task whose remote is on no known repo host", () => {
  test("can be pushed, but the form is refused with what to set", async () => {
    const task = await daemon.facade.agents.createTask("shop", "remote elsewhere");
    writeFileSync(join(task.worktree, "a.txt"), "a\n");
    gitIn(task.worktree, "add", "a.txt");
    gitIn(task.worktree, "commit", "-qm", "Add a");
    daemon.facade.workspace.setRepoHosts([]);
    try {
      const pushed = await daemon.post(mergeRequestsApi.push, { task: task.id });
      expect(pushed).toMatchObject({ project: null, lookup: null, push: { published: true } });
      await expect(daemon.post(mergeRequestsApi.openForm, { task: task.id, title: "Add a", description: "" })).rejects.toThrow(
        "the main remote of shop is not on GitHub or on a repo host from the settings",
      );
    } finally {
      daemon.facade.workspace.setRepoHosts([{ kind: "gitlab", host: "gitlab.example.com" }]);
    }
  }, 60_000);
});
