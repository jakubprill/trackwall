import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiEnvelope, agentsApi, DOWNLOAD_PATH, terminalsApi } from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { placeNames } from "../src/modules/terminals/folder-files.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "f".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] });
  const shop = join(daemon.projects, "shop");
  mkdirSync(join(shop, "build", "libs"), { recursive: true });
  writeFileSync(join(shop, "build", "libs", "shop-1.0.jar"), "PK jar bytes");
  writeFileSync(join(shop, "build", "report10.txt"), "");
  writeFileSync(join(shop, "build", "report2.txt"), "two");
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

function download(body: unknown, token: string | null = TOKEN) {
  return loopbackRequest(daemon.api.port, DOWNLOAD_PATH, {
    method: "POST",
    token: token ?? undefined,
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });
}

/** The error code of an action that must fail. */
async function errorOf(path: string, body: unknown): Promise<string> {
  const res = await loopbackRequest(daemon.api.port, path, { method: "POST", token: TOKEN, body: JSON.stringify(body), timeoutMs: 10_000 });
  const result = ApiEnvelope.parse(JSON.parse(res.body));
  if (result.ok) throw new Error(`${path} succeeded`);
  return result.error.code;
}

describe("the files of a place", () => {
  test("a repo's folder lists folders first, then files by name as a person sorts them, with sizes", async () => {
    expect(await daemon.post(terminalsApi.files, { repo: "shop", task: null, path: "build" })).toEqual({
      path: "build",
      entries: [
        { name: "libs", kind: "folder", size: null },
        { name: "report2.txt", kind: "file", size: 3 },
        { name: "report10.txt", kind: "file", size: 0 },
      ],
      truncated: false,
    });
    const root = await daemon.post(terminalsApi.files, { repo: "shop", task: null, path: "" });
    expect(root.entries).toContainEqual({ name: "README.md", kind: "file", size: 7 });
  });

  test("a file downloads as its bytes, with its length and as an attachment", async () => {
    const res = await download({ repo: "shop", task: null, path: "build/libs/shop-1.0.jar" });

    expect(res.status).toBe(200);
    expect(res.body).toBe("PK jar bytes");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-length"]).toBe("12");
    expect(res.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''shop-1.0.jar");
    expect((await download({ repo: "shop", task: null, path: "build/report10.txt" })).body).toBe("");
  });

  test("a task's worktree has its own files", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "change nothing", approvals: "ask" });
    writeFileSync(join(task.worktree, "only-in-task.log"), "task log\n");

    const listed = await daemon.post(terminalsApi.files, { repo: "shop", task: task.id, path: "" });
    expect(listed.entries).toContainEqual({ name: "only-in-task.log", kind: "file", size: 9 });
    expect((await download({ repo: "shop", task: task.id, path: "only-in-task.log" })).body).toBe("task log\n");

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
    if (session) await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a path that climbs out, or names nothing, is refused before anything is read", async () => {
    for (const path of ["..", "../shop", "build/../..", "/etc/passwd", "build//libs", "./build", "build/"])
      expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: null, path })).toBe("bad_request");
    expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: null, path: "nowhere" })).toBe("not_found");
    expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: null, path: "README.md" })).toBe("bad_request");
    expect(await errorOf(terminalsApi.files.path, { repo: "nowhere", task: null, path: "" })).toBe("not_found");
    expect(JSON.parse((await download({ repo: "shop", task: null, path: "" })).body)).toMatchObject({ error: { code: "bad_request" } });
    expect(JSON.parse((await download({ repo: "shop", task: null, path: "build" })).body)).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(JSON.parse((await download({ repo: "shop", task: null, path: "build/none.jar" })).body)).toMatchObject({
      error: { code: "not_found" },
    });
  });

  test("without the token nothing is listed or downloaded", async () => {
    expect((await download({ repo: "shop", task: null, path: "README.md" }, null)).status).toBe(401);
    const res = await loopbackRequest(daemon.api.port, terminalsApi.files.path, {
      method: "POST",
      body: JSON.stringify({ repo: "shop", task: null, path: "" }),
    });
    expect(res.status).toBe(401);
  });
});

// A symbolic link on Windows needs developer mode.
describe.skipIf(process.platform === "win32")("links in a place", () => {
  test("a link is listed as a link and never followed, to a folder or a file, inside the folder or out of it", async () => {
    const shop = join(daemon.projects, "shop");
    symlinkSync("/", join(shop, "build", "root"), "dir");
    symlinkSync(join(shop, "README.md"), join(shop, "build", "readme-link"), "file");

    const listed = await daemon.post(terminalsApi.files, { repo: "shop", task: null, path: "build" });
    expect(listed.entries).toContainEqual({ name: "root", kind: "link", size: null });
    expect(listed.entries).toContainEqual({ name: "readme-link", kind: "link", size: null });
    expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: null, path: "build/root" })).toBe("bad_request");
    expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: null, path: "build/root/etc" })).toBe("bad_request");
    expect(JSON.parse((await download({ repo: "shop", task: null, path: "build/readme-link" })).body)).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(JSON.parse((await download({ repo: "shop", task: null, path: "build/root/etc/hostname" })).body)).toMatchObject({
      error: { code: "bad_request" },
    });
  });
});

describe("place paths", () => {
  test("a path is names under the folder: none of them empty, `.` or `..`", () => {
    expect(placeNames("")).toEqual([]);
    expect(placeNames("build/libs/shop-1.0.jar")).toEqual(["build", "libs", "shop-1.0.jar"]);
    expect(placeNames(".env")).toEqual([".env"]);
    for (const path of ["/", "a//b", ".", "..", "a/../b", "a/./b", "a/", "a\0b"]) expect(() => placeNames(path)).toThrow();
  });

  test.skipIf(process.platform !== "win32")("on Windows a backslash or a colon is refused too", () => {
    for (const path of ["a\\..\\b", "C:", "file.txt:stream"]) expect(() => placeNames(path)).toThrow();
  });
});
