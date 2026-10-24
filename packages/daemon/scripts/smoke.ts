/**
 * Test dymny skompilowanej binarki daemona: start, health, info z tokenem, `initialize` przez most MCP (`mcp-stdio`),
 * karta repo z kontraktem endpointu i DTO (parser tree-sitter osadzony w binarce, ADR-37, ADR-38), shutdown,
 * sprzątnięty daemon.json.
 *
 *   bun scripts/smoke.ts <ścieżka do trackwall-daemon>
 *
 * Na Windowsie `.exe` jest dopisywane, gdy go brakuje, więc ta sama komenda działa na obu systemach.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apiResult, cardsApi, DaemonInfoResult, HealthResult, MCP_SERVER_NAME, workspaceApi } from "@trackwall/protocol";
import { z } from "zod";
import { daemonFilePath, readDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";

const arg = Bun.argv[2];
if (!arg) throw new Error("użycie: bun scripts/smoke.ts <ścieżka do trackwall-daemon>");
const given = resolve(arg);
const bin = process.platform === "win32" && !given.toLowerCase().endsWith(".exe") ? `${given}.exe` : given;
if (!existsSync(bin)) throw new Error(`brak binarki ${bin}`);
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

// Most stdio z komendy, którą UI pokazuje do `copilot mcp add` (w binarce: sama binarka i `mcp-stdio`), tak jak
// uruchamia go Copilot CLI: jedna linia JSON-RPC na wejściu, odpowiedź w pierwszej linii wyjścia.
const bridge = Bun.spawn(info.data.mcpStdioCommand, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const initialize = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } };
bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })}\n`);
await bridge.stdin.end();
const firstLine = (await new Response(bridge.stdout).text()).split("\n")[0] ?? "";
const InitializeReply = z.object({ id: z.literal(1), result: z.object({ serverInfo: z.object({ name: z.literal(MCP_SERVER_NAME) }) }) });
if (!InitializeReply.safeParse(JSON.parse(firstLine)).success) throw new Error(`mcp-stdio initialize: ${firstLine}`);
console.log(`mcp-stdio (${info.data.mcpStdioCommand.join(" ")}): initialize OK`);

// Karta repo z kontrolerem i DTO: tylko to sprawdza, że binarka ma u siebie parser i gramatyki (ADR-37).
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
  // Bez podpisu i hooków z globalnej konfiguracji gita osoby, która uruchamia smoke.
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
// Folder z projektami ma tylko to repo; ścieżka z listy może mieć inny zapis (krótkie nazwy na Windowsie, /private na macOS).
const orders = listed.ok && listed.data.repos.length === 1 ? listed.data.repos[0] : undefined;
if (!settings.ok || !orders) throw new Error(`repo ${repo} nie jest jedynym na liście: ${JSON.stringify({ settings, listed })}`);
const result = apiResult(cardsApi.card.data).parse(await post(cardsApi.card.path, { repo: orders.id }));
const card = result.ok ? result.data.card : null;
const endpoint = card?.provides.find((p) => p.kind === "endpoint");
const contract = `${endpoint?.kind === "endpoint" ? `${endpoint.request} -> ${endpoint.response}` : "brak endpointu"}; DTO: ${card?.dtos.map((d) => d.name).join(", ")}`;
if (contract !== "OrderDto -> OrderDto; DTO: OrderDto") throw new Error(`karta repo: ${contract}; ${JSON.stringify(result)}`);
console.log(`karta repo: ${contract}`);

// The Windows app update renames the running daemon exe (ADR-53); Windows allows that only if the process did not
// open its own exe without delete sharing, which this checks for the Bun-compiled binary.
renameSync(bin, `${bin}.renamed-by-smoke`);
renameSync(`${bin}.renamed-by-smoke`, bin);
console.log("running binary renamed and put back");

await get("/api/daemon/shutdown", "POST");
const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout")]);
if (code !== 0) throw new Error(`daemon zakończył się: ${code}`);
if (existsSync(file)) throw new Error("daemon.json nie został usunięty");
console.log("smoke OK");
