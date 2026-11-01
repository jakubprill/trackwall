import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { linuxArchiveName, TRACKWALL_RELEASES_URL } from "@trackwall/protocol";
import { parseCommandLine } from "../src/infra/args.ts";
import { supervisorPidFile } from "../src/infra/container-supervisor.ts";
import { applyUpdate, binDir, CURRENT_FILE, currentVersion } from "../src/infra/container-update.ts";
import { readDaemonFile } from "../src/infra/discovery.ts";
import { trustedFields, verifyMinisign } from "../src/infra/minisign.ts";
import { selfCommand } from "../src/infra/self-command.ts";
import { UPDATE_PUBLIC_KEY } from "../src/infra/update-key.ts";
import { VERSION } from "../src/infra/version.ts";
import { minisignKey } from "./support/minisign.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "minisign");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

describe("checking a release signature (ADR-165)", () => {
  // A file signed with `tauri signer sign --app-version 9.9.9` and a throwaway key whose private half is not kept.
  const pubkey = fixture("key.pub").toString();
  const signature = fixture("trackwall-9.9.9-linux-x64.tar.gz.sig").toString();
  const data = fixture("trackwall-9.9.9-linux-x64.tar.gz");

  test("a Tauri signature checks out and names the file and version it was made for", () => {
    const fields = trustedFields(verifyMinisign({ pubkey, signature, data }));
    expect(fields).toMatchObject({ file: "trackwall-9.9.9-linux-x64.tar.gz", version: "9.9.9" });
  });

  test("a changed file, a changed trusted comment or another key is refused", () => {
    expect(() => verifyMinisign({ pubkey, signature, data: Buffer.concat([data, Buffer.from("x")]) })).toThrow(
      "the signature does not match the file",
    );
    const text = Buffer.from(signature, "base64").toString().replace("version:9.9.9", "version:9.9.8");
    expect(() => verifyMinisign({ pubkey, signature: Buffer.from(text).toString("base64"), data })).toThrow(
      "the trusted comment does not match the signature",
    );
    expect(() => verifyMinisign({ pubkey: minisignKey().pubkey, signature, data })).toThrow("the signature was made with another key");
  });

  test("the key compiled into the daemon is the one the app's updater trusts, and releases are where its updates are", () => {
    const conf = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    );
    expect(UPDATE_PUBLIC_KEY).toBe(conf.plugins.updater.pubkey);
    expect(conf.plugins.updater.endpoints[0]).toStartWith(`${TRACKWALL_RELEASES_URL}/`);
  });

  test("update takes one version", () => {
    expect(parseCommandLine(["container", "update", "1.2.3"])).toEqual({
      command: "container",
      action: "update",
      target: "1.2.3",
      port: 7700,
      home: undefined,
    });
    expect(() => parseCommandLine(["container", "update"])).toThrow("update expects one version");
    expect(() => parseCommandLine(["container", "update", "../1.2.3"])).toThrow("update expects one version");
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error("timeout");
}

/** A release folder with a Linux archive whose `trackwall-daemon` is `script`, and its signature. */
function release(script: string, sign: (data: Buffer) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-release-"));
  const stage = join(dir, "stage", "trackwall");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "trackwall-daemon"), script);
  chmodSync(join(stage, "trackwall-daemon"), 0o755);
  const name = linuxArchiveName(VERSION, ARCH);
  Bun.spawnSync(["tar", "-czf", join(dir, name), "-C", join(dir, "stage"), "trackwall"]);
  writeFileSync(join(dir, `${name}.sig`), sign(readFileSync(join(dir, name))));
  return dir;
}

/** This daemon from source, under the same runtime, as the binary of the "new" version. */
const DELEGATE = `#!/bin/sh\nexec ${[...selfCommand([]).args].reduce((cmd, arg) => `${cmd} '${arg}'`, `'${process.execPath}'`)} "$@"\n`;
const BROKEN = `#!/bin/sh\nif [ "$1" = --version ]; then echo ${VERSION}; exit 0; fi\nexit 1\n`;

async function runningOld(home: string, port: number) {
  const start = Bun.spawn(["bun", MAIN, "container", "start", "--home", home, "--port", String(port)], { stdout: "pipe" });
  await start.exited;
  return waitFor(() => readDaemonFile(home));
}

/** The supervisor takes its daemon down with it; the daemon is signalled too in case a test left it alone. */
function stopEverything(home: string) {
  const pids = [readDaemonFile(home)?.pid];
  try {
    pids.unshift(Number(readFileSync(supervisorPidFile(home), "utf8")));
  } catch {
    // no supervisor
  }
  for (const pid of pids) {
    try {
      if (pid !== undefined) process.kill(pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
}

// The update runs in a Linux dev container; the supervisor's signals are POSIX, so Windows does not run these.
describe.skipIf(process.platform === "win32")("trackwall-container update (ADR-165)", () => {
  test("a signed version is unpacked into bin/, becomes current and runs in place of the old daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-update-"));
    const port = await freePort();
    const key = minisignKey();
    const dir = release(DELEGATE, (data) => key.signFile(data, { file: linuxArchiveName(VERSION, ARCH), version: VERSION }));
    const notes: string[] = [];
    try {
      const old = await runningOld(home, port);
      const outcome = await applyUpdate({
        home,
        port,
        target: VERSION,
        self: { version: VERSION, command: selfCommand([]) },
        source: { url: (_version, file) => pathToFileURL(join(dir, file)).href, pubkey: key.pubkey },
        note: (msg) => notes.push(msg),
      });
      expect(notes).toContain(`updated to ${VERSION}`);
      expect(outcome).toBe("updated");
      expect(currentVersion(home)).toBe(VERSION);
      expect(existsSync(join(binDir(home), VERSION, "trackwall-daemon"))).toBe(true);
      const now = readDaemonFile(home);
      expect(now?.pid).not.toBe(old.pid);
      expect(now?.port).toBe(port);
    } finally {
      stopEverything(home);
    }
  }, 120_000);

  test("a version that does not start is undone: the old one runs again and bin/current is as before", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-update-"));
    const port = await freePort();
    const key = minisignKey();
    const dir = release(BROKEN, (data) => key.signFile(data, { file: linuxArchiveName(VERSION, ARCH), version: VERSION }));
    const notes: string[] = [];
    try {
      const old = await runningOld(home, port);
      const outcome = await applyUpdate({
        home,
        port,
        target: VERSION,
        self: { version: VERSION, command: selfCommand([]) },
        source: { url: (_version, file) => pathToFileURL(join(dir, file)).href, pubkey: key.pubkey },
        note: (msg) => notes.push(msg),
      });
      expect(outcome).toBe("rolled-back");
      expect(notes).toContain(`back on ${VERSION}`);
      expect(existsSync(join(binDir(home), CURRENT_FILE))).toBe(false);
      const now = await waitFor(() => readDaemonFile(home));
      expect(now.pid).not.toBe(old.pid);
    } finally {
      stopEverything(home);
    }
  }, 120_000);

  test("an archive signed with another key, or signed for another version, is refused and the running daemon is left alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-update-"));
    const port = await freePort();
    const trusted = minisignKey();
    const other = minisignKey();
    const notes: string[] = [];
    try {
      const old = await runningOld(home, port);
      const cases = [
        release(DELEGATE, (data) => other.signFile(data, { file: linuxArchiveName(VERSION, ARCH), version: VERSION })),
        release(DELEGATE, (data) => trusted.signFile(data, { file: linuxArchiveName(VERSION, ARCH), version: "0.0.1" })),
      ];
      for (const dir of cases) {
        const outcome = await applyUpdate({
          home,
          port,
          target: VERSION,
          self: { version: VERSION, command: selfCommand([]) },
          source: { url: (_version, file) => pathToFileURL(join(dir, file)).href, pubkey: trusted.pubkey },
          note: (msg) => notes.push(msg),
        });
        expect(outcome).toBe("failed");
      }
      expect(notes.join("\n")).toContain("the signature was made with another key");
      expect(notes.join("\n")).toContain(`the signature is for ${linuxArchiveName(VERSION, ARCH)} 0.0.1`);
      expect(readDaemonFile(home)?.pid).toBe(old.pid);
      expect(existsSync(join(binDir(home), VERSION))).toBe(false);
    } finally {
      stopEverything(home);
    }
  }, 60_000);
});
