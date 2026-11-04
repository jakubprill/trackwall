import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiEnvelope, agentsApi, DOWNLOAD_PATH, MAX_DOWNLOAD_BYTES, MAX_FOLDER_ENTRIES, terminalsApi } from "@trackwall/protocol";
import { headerFileName } from "../src/api/file-download.ts";
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

describe("links in a place", () => {
  // On Windows a junction, the link to a folder that needs no developer mode; a link to a file needs it, so only elsewhere.
  const windows = process.platform === "win32";

  test("a link is listed as a link and never followed, to a folder or a file, inside the folder or out of it", async () => {
    const shop = join(daemon.projects, "shop");
    mkdirSync(join(shop, "links"));
    symlinkSync(tmpdir(), join(shop, "links", "outside"), windows ? "junction" : "dir");
    symlinkSync(join(shop, "build"), join(shop, "links", "build-again"), windows ? "junction" : "dir");
    if (!windows) symlinkSync(join(shop, "README.md"), join(shop, "links", "readme-link"), "file");
    writeFileSync(join(tmpdir(), "trackwall-outside.txt"), "outside\n");

    const listed = await daemon.post(terminalsApi.files, { repo: "shop", task: null, path: "links" });
    expect(listed.entries).toContainEqual({ name: "outside", kind: "link", size: null });
    expect(listed.entries).toContainEqual({ name: "build-again", kind: "link", size: null });
    for (const path of ["links/outside", "links/build-again", "links/build-again/libs"])
      expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: null, path })).toBe("bad_request");
    for (const path of ["links/outside/trackwall-outside.txt", "links/build-again/report2.txt", ...(windows ? [] : ["links/readme-link"])])
      expect(JSON.parse((await download({ repo: "shop", task: null, path })).body)).toMatchObject({ error: { code: "bad_request" } });
  });

  test("a task's worktree swapped for a link is refused, not followed", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "change nothing", approvals: "ask" });
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
    if (session) await daemon.facade.agents.stop(session.id);
    const moved = `${task.worktree}-moved`;
    renameSync(task.worktree, moved);
    symlinkSync(tmpdir(), task.worktree, windows ? "junction" : "dir");

    expect(await errorOf(terminalsApi.files.path, { repo: "shop", task: task.id, path: "" })).toBe("repo_unavailable");

    rmSync(task.worktree, { recursive: false, force: true });
    renameSync(moved, task.worktree);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);
});

describe("limits of the files of a place", () => {
  test("a folder with more entries than the list shows is cut, and says so", async () => {
    const many = join(daemon.projects, "shop", "many");
    mkdirSync(many);
    for (let i = 0; i <= MAX_FOLDER_ENTRIES; i++) writeFileSync(join(many, `f${i}`), "");

    const listed = await daemon.post(terminalsApi.files, { repo: "shop", task: null, path: "many" });

    expect(listed.entries).toHaveLength(MAX_FOLDER_ENTRIES);
    expect(listed.truncated).toBe(true);
  });

  test("a file over the download limit is refused with what to do instead, named by its place path", async () => {
    const big = join(daemon.projects, "shop", "heap.hprof");
    // A sparse file: its size, without writing a gigabyte.
    writeFileSync(big, "");
    truncateSync(big, MAX_DOWNLOAD_BYTES + 1);

    expect(JSON.parse((await download({ repo: "shop", task: null, path: "heap.hprof" })).body)).toEqual({
      ok: false,
      error: { code: "bad_request", message: "heap.hprof is larger than 1 GB; copy it out with docker cp instead" },
    });
    rmSync(big);
  });

  test("a file name in the answer's header is percent-encoded, also the characters a header must not carry as they are", () => {
    expect(headerFileName("report (1)*.txt")).toBe("report%20%281%29%2A.txt");
    expect(headerFileName("zażółć's.log")).toBe("za%C5%BC%C3%B3%C5%82%C4%87%27s.log");
    expect(headerFileName("a\uD800b")).toBe("a%EF%BF%BDb");
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
