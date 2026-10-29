/**
 * Smoke test of the compiled daemon binary: start, health, info with the token, `initialize` through the Stdio bridge
 * (`mcp-stdio`), a repo card with an endpoint contract and a DTO (the tree-sitter parser embedded in the binary, ADR-37,
 * ADR-38), shutdown, daemon.json cleaned up.
 *
 *   bun scripts/smoke.ts <path to trackwall-daemon>
 *
 * On Windows `.exe` is appended when it is missing, so the same command works on both systems.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apiResult, cardsApi, DaemonInfoResult, HealthResult, MCP_SERVER_NAME, workspaceApi } from "@trackwall/protocol";
import { z } from "zod";
import { CONTAINER_MARKERS } from "../src/infra/desktop.ts";
import { daemonFilePath, readDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";

const arg = Bun.argv[2];
if (!arg) throw new Error("usage: bun scripts/smoke.ts <path to trackwall-daemon>");
const given = resolve(arg);
const bin = process.platform === "win32" && !given.toLowerCase().endsWith(".exe") ? `${given}.exe` : given;
if (!existsSync(bin)) throw new Error(`no binary at ${bin}`);
const home = mkdtempSync(join(tmpdir(), "trackwall-smoke-"));
const file = daemonFilePath(home);

const version = Bun.spawnSync([bin, "--version"]).stdout.toString().trim();
console.log(`--version: ${version}`);

const proc = Bun.spawn([bin], { env: { ...process.env, TRACKWALL_HOME: home }, stdout: "inherit", stderr: "inherit" });
const deadline = Date.now() + 15_000;
async function waitForDaemonFile() {
  for (;;) {
    const daemon = readDaemonFile(home);
    if (daemon) return daemon;
    if (Date.now() > deadline) throw new Error("no valid daemon.json appeared within 15 s");
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
// In a container (the `container` job of CI, ADR-128) the binary must see it: no desktop to open links on (ADR-120) and
// the container's id for VS Code links into it (ADR-121).
if (CONTAINER_MARKERS.some((marker) => existsSync(marker))) {
  if (info.data.desktop || info.data.container === null) throw new Error(`in a container: ${JSON.stringify(info.data)}`);
  console.log(`container: ${info.data.container}, no desktop`);
}

// The Stdio bridge from the command the UI shows for `copilot mcp add` (in the binary: the binary itself and `mcp-stdio`),
// started the way Copilot CLI starts it: one JSON-RPC line on input, the reply in the first line of output.
const bridge = Bun.spawn(info.data.mcpStdioCommand, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const initialize = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } };
bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })}\n`);
await bridge.stdin.end();
const firstLine = (await new Response(bridge.stdout).text()).split("\n")[0] ?? "";
const InitializeReply = z.object({ id: z.literal(1), result: z.object({ serverInfo: z.object({ name: z.literal(MCP_SERVER_NAME) }) }) });
if (!InitializeReply.safeParse(JSON.parse(firstLine)).success) throw new Error(`mcp-stdio initialize: ${firstLine}`);
console.log(`mcp-stdio (${info.data.mcpStdioCommand.join(" ")}): initialize OK`);

// A repo card with a controller and a DTO: only this checks that the binary carries the parser and grammars (ADR-37).
const projects = mkdtempSync(join(tmpdir(), "trackwall-smoke-projects-"));
const repo = join(projects, "orders");
const sources = join(repo, "src", "main", "java", "a");
mkdirSync(sources, { recursive: true });
writeFileSync(
  join(sources, "Api.java"),
  '@RestController class Api { @PostMapping("/orders") OrderDto create(@RequestBody OrderDto body) { return body; } }\n',
);
writeFileSync(join(sources, "OrderDto.java"), "public record OrderDto(String id, int quantity) {}\n");
for (const args of [
  ["init", "-q"],
  ["add", "."],
  // Without signing and hooks from the global git configuration of whoever runs the smoke test.
  [
    "-c",
    "user.name=smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-q",
    "-m",
    "smoke",
  ],
]) {
  const git = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git ${args.join(" ")}: ${git.stderr}`);
}
const post = async (path: string, body: unknown): Promise<unknown> =>
  JSON.parse((await loopbackRequest(port, path, { method: "POST", token, body: JSON.stringify(body), timeoutMs: 15_000 })).body);
const settings = apiResult(workspaceApi.setProjectsDir.data).parse(await post(workspaceApi.setProjectsDir.path, { path: projects }));
const listed = apiResult(workspaceApi.list.data).parse(await post(workspaceApi.list.path, {}));
// The projects folder has only this repo; the path on the list may be spelled differently (short names on Windows, /private on macOS).
const orders = listed.ok && listed.data.repos.length === 1 ? listed.data.repos[0] : undefined;
if (!settings.ok || !orders) throw new Error(`repo ${repo} is not the only one on the list: ${JSON.stringify({ settings, listed })}`);
const result = apiResult(cardsApi.card.data).parse(await post(cardsApi.card.path, { repo: orders.id }));
const card = result.ok ? result.data.card : null;
const endpoint = card?.provides.find((p) => p.kind === "endpoint");
const contract = `${endpoint?.kind === "endpoint" ? `${endpoint.request} -> ${endpoint.response}` : "no endpoint"}; DTO: ${card?.dtos.map((d) => d.name).join(", ")}`;
if (contract !== "OrderDto -> OrderDto; DTO: OrderDto") throw new Error(`repo card: ${contract}; ${JSON.stringify(result)}`);
console.log(`repo card: ${contract}`);

// The Windows app update renames the running daemon exe (ADR-53); Windows allows that only if the process did not
// open its own exe without delete sharing, which this checks for the Bun-compiled binary.
renameSync(bin, `${bin}.renamed-by-smoke`);
renameSync(`${bin}.renamed-by-smoke`, bin);
console.log("running binary renamed and put back");

await get("/api/daemon/shutdown", "POST");
const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout")]);
if (code !== 0) throw new Error(`daemon exited: ${code}`);
if (existsSync(file)) throw new Error("daemon.json was not removed");
console.log("smoke OK");
