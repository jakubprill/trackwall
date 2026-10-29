import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, configFilesApi, DaemonInfoResult, mergeRequestsApi, workspaceApi } from "@trackwall/protocol";
import { hasDesktop } from "../src/infra/desktop.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { gitIn } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

describe("hasDesktop", () => {
  const nothing = () => false;

  test("Windows and macOS always have a desktop", () => {
    expect(hasDesktop({ platform: "win32", env: {}, exists: nothing })).toBe(true);
    expect(hasDesktop({ platform: "darwin", env: {}, exists: nothing })).toBe(true);
  });

  test("Linux has a desktop when a graphical session is there", () => {
    expect(hasDesktop({ platform: "linux", env: { DISPLAY: ":0" }, exists: nothing })).toBe(true);
    expect(hasDesktop({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, exists: nothing })).toBe(true);
    expect(hasDesktop({ platform: "linux", env: {}, exists: nothing })).toBe(false);
  });

  test("a Docker or Podman container has no desktop, even with a display socket of the host", () => {
    const docker = (path: string) => path === "/.dockerenv";
    const podman = (path: string) => path === "/run/.containerenv";
    expect(hasDesktop({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, exists: docker })).toBe(false);
    expect(hasDesktop({ platform: "linux", env: { DISPLAY: ":0" }, exists: podman })).toBe(false);
  });
});

describe("a daemon without a desktop", () => {
  const TOKEN = "t".repeat(43);
  const opened: string[] = [];
  let daemon: Awaited<ReturnType<typeof startSessionApi>>;

  beforeAll(async () => {
    daemon = await startSessionApi(TOKEN, {
      repos: { shop: { "README.md": "# shop\n" } },
      miseCommand: ["mise"],
      hostingClis: fakeHostingClis({ apiResponses: { "projects/shop%2Fshop/merge_requests": [] } }).clis,
      openUrl: (url) => opened.push(url),
      desktop: false,
    });
    gitIn(join(daemon.projects, "shop"), "remote", "add", "origin", "https://gitlab.example.com/shop/shop.git");
    daemon.facade.workspace.setRepoHosts([{ kind: "gitlab", host: "gitlab.example.com" }]);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await daemon.stop();
  });

  const post = (path: string, body: unknown) =>
    loopbackRequest(daemon.api.port, path, {
      token: TOKEN,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 10_000,
    });

  test("says so in its info, so the page opens web links itself", async () => {
    const res = await loopbackRequest(daemon.api.port, "/api/daemon/info", { token: TOKEN });
    expect(DaemonInfoResult.parse(JSON.parse(res.body))).toMatchObject({ ok: true, data: { desktop: false } });
  });

  test("refuses to open a link, a repo folder, VS Code or a config file with no_desktop instead of failing unseen", async () => {
    for (const [path, body] of [
      [workspaceApi.openLink.path, { url: "https://example.com/docs" }],
      [workspaceApi.openFolder.path, { repo: "shop" }],
      [workspaceApi.openEditor.path, { repo: "shop" }],
      [configFilesApi.openInEditor.path, { id: "workspace-file" }],
      [configFilesApi.showInFolder.path, { id: "workspace-file" }],
    ] as const) {
      const res = await post(path, body);
      expect({ path, status: res.status }).toEqual({ path, status: 409 });
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: { code: "no_desktop", message: expect.stringContaining("container") },
      });
    }
    expect(opened).toEqual([]);
  });

  test.skipIf(process.versions.bun === undefined)(
    "gives the merge request form's address to the page, and refuses to open the form itself",
    async () => {
      const task = await daemon.facade.agents.createTask("shop", "Add a discount");
      writeFileSync(join(task.worktree, "change.txt"), "10% off\n");
      gitIn(task.worktree, "add", "change.txt");
      gitIn(task.worktree, "commit", "-qm", "Add a discount");
      gitIn(task.worktree, "update-ref", `refs/remotes/origin/${task.branch}`, "HEAD");
      const draft = { task: task.id, title: "Add a discount", description: "Adds 10% off." };

      const asked = await daemon.post(mergeRequestsApi.formUrl, draft);
      expect(asked.url).toStartWith("https://gitlab.example.com/shop/shop/-/merge_requests/new?");
      for (const [path, body] of [
        [mergeRequestsApi.openForm.path, draft],
        [agentsApi.openTaskEditor.path, { task: task.id }],
      ] as const) {
        const res = await post(path, body);
        expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: "no_desktop" } });
      }
      expect(opened).toEqual([]);
    },
    60_000,
  );
});
