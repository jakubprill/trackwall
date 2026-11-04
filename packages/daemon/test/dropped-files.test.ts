import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { ApiEnvelope, DROP_NAME_HEADER, DROP_PATH, DroppedFile, MAX_DROP_BYTES } from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { DroppedFiles } from "../src/modules/terminals/dropped-files.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "d".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

function drop(name: string | undefined, body: string, opts: { token?: string; headers?: Record<string, string> } = {}) {
  return loopbackRequest(daemon.api.port, DROP_PATH, {
    method: "POST",
    token: opts.token ?? TOKEN,
    headers: {
      "content-type": "application/octet-stream",
      ...(name === undefined ? {} : { [DROP_NAME_HEADER]: encodeURIComponent(name) }),
      ...opts.headers,
    },
    body,
    timeoutMs: 10_000,
  });
}

function envelopeOf(res: { body: string }) {
  return ApiEnvelope.parse(JSON.parse(res.body));
}

/** The path of the saved copy; a refusal fails the test with the daemon's message. */
function savedPath(res: { body: string }): string {
  const envelope = envelopeOf(res);
  if (!envelope.ok) throw new Error(envelope.error.message);
  return DroppedFile.parse(envelope.data).path;
}

describe("a file dropped on a terminal from another computer", () => {
  test("is saved under .trackwall/drops of the projects folder, in a folder of its own, and its path comes back", async () => {
    const path = savedPath(await drop("build log.txt", "BUILD FAILED\n"));
    expect(dirname(dirname(path))).toBe(join(daemon.projects, ".trackwall", "drops"));
    expect(path.endsWith("build log.txt")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("BUILD FAILED\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("of the same name twice gives two files, the first one untouched", async () => {
    const first = savedPath(await drop("notes.md", "one"));
    const second = savedPath(await drop("notes.md", "two"));
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readFileSync(second, "utf8")).toBe("two");
  });

  test("with a name that is a path, or no name, is refused and nothing is written outside drops", async () => {
    for (const name of ["../escape.txt", "..", "a/b.txt", "a\\b.txt", "evil\u0000.txt"]) {
      const envelope = envelopeOf(await drop(name, "x"));
      expect(envelope.ok ? "saved" : envelope.error.code).toBe("bad_request");
    }
    const missing = envelopeOf(await drop(undefined, "x"));
    expect(missing.ok ? "saved" : missing.error.code).toBe("bad_request");
    expect(existsSync(join(daemon.projects, ".trackwall", "escape.txt"))).toBe(false);
  });

  test("that says it is larger than the limit is refused before its body is read", async () => {
    const envelope = envelopeOf(
      await drop("dump.hprof", "x", { headers: { "content-length": String(MAX_DROP_BYTES + 1) } }).catch(() => ({ body: "{}" })),
    );
    expect(envelope.ok ? "saved" : envelope.error.code).toBe("bad_request");
  });

  test("needs the daemon token", async () => {
    const res = await drop("secret.txt", "x", { token: "w".repeat(43) });
    expect(res.status).toBe(401);
  });
});

describe("the store of dropped files", () => {
  test("cuts a body over the limit and leaves no part of it behind", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-drops-"));
    const files = new DroppedFiles({ projectsDir: async () => projects, now: () => new Date(), maxBytes: 4 });
    await expect(files.save("big.bin", Readable.from([Buffer.from("12345")]))).rejects.toThrow("docker cp");
    expect(readdirSync(join(projects, ".trackwall", "drops"))).toEqual([]);
  });

  test("removes drops older than a week at the next drop and leaves other entries alone", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-drops-"));
    const drops = join(projects, ".trackwall", "drops");
    const now = new Date("2026-11-04T12:00:00Z");
    const files = new DroppedFiles({ projectsDir: async () => projects, now: () => now, maxBytes: 100 });
    const old = await files.save("old.txt", Readable.from([Buffer.from("old")]));
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(dirname(old), eightDaysAgo, eightDaysAgo);
    mkdirSync(join(drops, "kept-by-the-user"));
    utimesSync(join(drops, "kept-by-the-user"), eightDaysAgo, eightDaysAgo);
    writeFileSync(join(drops, "README.txt"), "");
    const fresh = await files.save("fresh.txt", Readable.from([Buffer.from("fresh")]));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(drops).sort()).toEqual([dirname(fresh).slice(drops.length + 1), "README.txt", "kept-by-the-user"].sort());
  });
});
