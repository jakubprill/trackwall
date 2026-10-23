/**
 * Test dymny skompilowanej binarki daemona: start, health, info z tokenem, shutdown, sprzątnięty daemon.json.
 *
 *   bun scripts/smoke.ts <ścieżka do pitwall-daemon>
 *
 * Na Windowsie `.exe` jest dopisywane, gdy go brakuje, więc ta sama komenda działa na obu systemach.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonInfoResult, HealthResult } from "@pitwall/protocol";
import { daemonFilePath, readDaemonFile } from "../src/discovery.ts";
import { loopbackRequest } from "../src/loopback.ts";

const given = resolve(Bun.argv[2] ?? "");
const bin = process.platform === "win32" && !given.toLowerCase().endsWith(".exe") ? `${given}.exe` : given;
if (!existsSync(bin)) throw new Error(`brak binarki ${bin}`);
const home = mkdtempSync(join(tmpdir(), "pitwall-smoke-"));
const file = daemonFilePath(home);

const version = Bun.spawnSync([bin, "--version"]).stdout.toString().trim();
console.log(`--version: ${version}`);

const proc = Bun.spawn([bin], { env: { ...process.env, PITWALL_HOME: home }, stdout: "inherit", stderr: "inherit" });
const deadline = Date.now() + 15_000;
async function waitForDaemonFile() {
  for (;;) {
    const daemon = readDaemonFile(home);
    if (daemon) return daemon;
    if (Date.now() > deadline) throw new Error("poprawny daemon.json nie powstał w 15 s");
    await Bun.sleep(100);
  }
}
const { port, token } = await waitForDaemonFile();
const get = async (path: string, method = "GET"): Promise<unknown> =>
  JSON.parse((await loopbackRequest(port, path, { method, token })).body);

const health = HealthResult.parse(await get("/api/health"));
if (!health.ok || health.data.version !== version) throw new Error(`health: ${JSON.stringify(health)}`);
const info = DaemonInfoResult.parse(await get("/api/daemon/info"));
if (!info.ok || info.data.runtime.name !== "bun") throw new Error(`info: ${JSON.stringify(info)}`);
console.log(`info: ${info.data.platform}/${info.data.arch}, ${info.data.runtime.name} ${info.data.runtime.version}`);

await get("/api/daemon/shutdown", "POST");
const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout")]);
if (code !== 0) throw new Error(`daemon zakończył się: ${code}`);
if (existsSync(file)) throw new Error("daemon.json nie został usunięty");
console.log("smoke OK");
