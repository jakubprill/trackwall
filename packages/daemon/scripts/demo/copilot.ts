// A stand-in for Copilot CLI in the screenshots of the documentation site: it draws a short, believable agent turn
// for the repo it starts in and reports its state through the session plugin's hooks, as Copilot CLI does, so a
// session lands in "working", "waiting for you" or "asking for approval". It never calls a model or changes a file.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

const HooksFile = z.object({
  hooks: z.record(z.string(), z.array(z.object({ exec: z.string(), args: z.array(z.string()), cwd: z.string() }))),
});

const pluginDir = process.argv[process.argv.indexOf("--plugin-dir") + 1];
if (pluginDir === undefined) throw new Error("no --plugin-dir");
const { hooks } = HooksFile.parse(JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8")));

function fire(event: string, payload: Record<string, unknown>): void {
  for (const hook of hooks[event] ?? []) {
    spawnSync(hook.exec, hook.args, { cwd: hook.cwd, input: JSON.stringify({ sessionId: "demo", timestamp: Date.now(), ...payload }) });
  }
}

type Ending = "working" | "waiting" | "approval";

interface Turn {
  prompt: string;
  steps: string[];
  answer: string[];
  ending: Ending;
}

/** The turn each repo shows; a repo without one gets the last. */
const TURNS: Record<string, Turn> = {
  "orders-api": {
    prompt: "Retry a failed payment twice before the order is cancelled",
    steps: [
      "Read src/main/java/com/example/shop/ordersapi/clients/PaymentsClient.java",
      "Read src/main/resources/application.yml",
      "Edit src/main/java/com/example/shop/ordersapi/OrdersController.java (+18 -3)",
    ],
    answer: [],
    ending: "approval",
  },
  payments: {
    prompt: "Who calls POST /api/payments and what do they send?",
    steps: ["trackwall-who_calls payments", "trackwall-find_endpoint POST /api/payments"],
    answer: [
      "Three repos call it: orders-api, shop-bff and admin-bff (through billing).",
      "All of them send PaymentsDto with an order id and an amount in cents.",
    ],
    ending: "waiting",
  },
  "shop-web": {
    prompt: "Add a checkout summary with the delivery estimate from shipping",
    steps: ["Read src/Checkout.tsx", "trackwall-subgraph_for shop-web", "Edit src/Checkout.tsx (+42)"],
    answer: [],
    ending: "working",
  },
  catalog: {
    prompt: "Why does the product page show stale prices?",
    steps: ["trackwall-get_errors catalog", "Read src/main/java/com/example/shop/catalog/clients/PricingClient.java"],
    answer: [
      "The pricing client caches answers for an hour; pricing changes every 15 minutes.",
      "Shorten the cache to 5 minutes, or listen to price-changed events?",
    ],
    ending: "waiting",
  },
  inventory: {
    prompt: "Run the tests and fix what fails",
    steps: ["trackwall-run_mise_task inventory build"],
    answer: [],
    ending: "approval",
  },
  search: {
    prompt: "Index reviews together with products",
    steps: [
      "Read src/main/java/com/example/shop/search/clients/ReviewsClient.java",
      "Edit src/main/java/com/example/shop/search/SearchController.java (+27 -4)",
    ],
    answer: [],
    ending: "working",
  },
  "api-gateway": {
    prompt: "List the routes that have no rate limit",
    steps: ["Read src/main/resources/application.yml", "trackwall-subgraph_for api-gateway"],
    answer: ["Five routes go out without a limit: /api/products, /api/orders, /api/customers, /api/search and /api/tokens."],
    ending: "waiting",
  },
  "admin-bff": {
    prompt: "Start admin-bff with its dependencies and check GET /api/admin",
    steps: ["trackwall-start_service admin-bff", "trackwall-call_endpoint GET /api/admin/42"],
    answer: [],
    ending: "working",
  },
  shipping: {
    prompt: "Rename ShipmentsDto.eta to estimatedDelivery everywhere it is used",
    steps: ["trackwall-search_code ShipmentsDto", "Edit 4 files"],
    answer: ["Renamed in shipping and in its two callers, orders-api and admin-bff."],
    ending: "waiting",
  },
};

/** An agent task starts with its prompt (`--interactive=`) in its own worktree, and works on it. */
const taskPrompt = process.argv.find((arg) => arg.startsWith("--interactive="))?.slice("--interactive=".length);
const taskTurn = (prompt: string): Turn => ({
  prompt,
  steps: ["Read README.md", "Edit 3 files (+64 -12)", "trackwall-run_mise_task build: BUILD SUCCESS"],
  answer: [],
  ending: "working",
});
const repoTurn = TURNS[basename(process.cwd())] ?? TURNS.shipping;
const turn = taskPrompt === undefined ? repoTurn : taskTurn(taskPrompt);
if (turn === undefined) throw new Error("no demo turn");

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const accent = (text: string) => `\x1b[36m${text}\x1b[0m`;
const ok = (text: string) => `\x1b[32m${text}\x1b[0m`;
const warn = (text: string) => `\x1b[33m${text}\x1b[0m`;
const line = (text = "") => process.stdout.write(`${text}\r\n`);

process.stdout.write(`\x1b]0;${turn.prompt}\x07`);
line(`${accent("●")} GitHub Copilot ${dim("v1.0.103")}`);
line(dim(`  ${basename(process.cwd())} [${taskPrompt === undefined ? "main" : "task branch"}]`));
line();
fire("sessionStart", { source: "new" });
line(`${accent(">")} ${turn.prompt}`);
line();
fire("userPromptSubmitted", { prompt: turn.prompt });
for (const step of turn.steps) {
  line(`${ok("✓")} ${step}`);
  fire("postToolUse", { toolName: step.split(" ")[0] });
}
line();
if (turn.ending === "working") {
  process.stdout.write("\x1b]9;4;3;0\x07");
  // A working agent keeps writing; a silent one would turn "not responding" after a minute.
  const startedAt = Date.now();
  const spinner = ["∴", "∵"];
  const think = (tick: number) => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r\x1b[K${accent(spinner[tick % spinner.length] ?? "∴")} Thinking… ${dim(`(${seconds}s · Esc to interrupt)`)}`);
  };
  let tick = 0;
  think(tick);
  setInterval(() => think(++tick), 2000);
} else if (turn.ending === "approval") {
  line(warn("Allow this command?"));
  line(dim("  mvn -q test -pl ."));
  line();
  line(`  ${accent("1. Yes")}   2. Yes, and don't ask again   3. No`);
  fire("notification", { notification_type: "permission_prompt", message: "Allow bash: mvn -q test -pl ." });
} else {
  for (const text of turn.answer) line(text);
  line();
  line(`${accent(">")} `);
  fire("agentStop", { stopReason: "end_turn" });
}

// Keep the session open until Trackwall stops it, as an interactive Copilot CLI does.
process.stdin.resume();
process.on("SIGTERM", () => process.exit(143));
