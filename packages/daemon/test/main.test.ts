import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonInfoResult } from "@pitwall/protocol";
import { readDaemonFile } from "../src/discovery.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timeout");
}

describe("proces daemona", () => {
  test("start, drugi start z tą samą wersją kończy się 0, shutdown sprząta daemon.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-e2e-"));
    const env = { ...process.env, PITWALL_HOME: home };
    const daemon = Bun.spawn(["bun", MAIN], { env, stdout: "ignore", stderr: "pipe" });
    const file = await waitFor(() => readDaemonFile(home));
    expect(file.pid).toBe(daemon.pid);

    const second = Bun.spawn(["bun", MAIN], { env, stdout: "ignore", stderr: "pipe" });
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stderr).text()).toContain("już działa");

    const auth = { authorization: `Bearer ${file.token}` };
    const info = DaemonInfoResult.parse(await (await fetch(`http://127.0.0.1:${file.port}/api/daemon/info`, { headers: auth })).json());
    expect(info.ok && info.data.launchedBy).toBe("manual");

    await fetch(`http://127.0.0.1:${file.port}/api/daemon/shutdown`, { method: "POST", headers: auth });
    expect(await daemon.exited).toBe(0);
    expect(readDaemonFile(home)).toBeUndefined();
  }, 20_000);

  test("zły argument kończy się kodem 2", async () => {
    const p = Bun.spawn(["bun", MAIN, "--port", "abc"], { stdout: "ignore", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });
});
