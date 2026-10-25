// A stand-in for Copilot CLI in the screenshots of the documentation site: it draws a short, believable agent turn
// for the repo it starts in and reports its state through the session plugin's hooks, as Copilot CLI does, so a
// session lands in "working", "waiting for you" or "asking for approval". It never calls a model or changes a file.
import { basename } from "node:path";
import { pluginHooks } from "../../test/support/plugin-hooks.ts";
import { TURNS, type Turn } from "./turns.ts";

const fire = pluginHooks(process.argv, "demo");

/** An agent task starts with its prompt (`--interactive=`) in its own worktree, and works on it. */
const taskPrompt = process.argv.find((arg) => arg.startsWith("--interactive="))?.slice("--interactive=".length);
const taskTurn = (prompt: string): Turn => ({
  prompt,
  steps: ["Read README.md", "Edit 3 files (+64 -12)", "trackwall-run_mise_task build: BUILD SUCCESS"],
  answer: [],
  ending: "working",
});
const turn = taskPrompt === undefined ? TURNS[basename(process.cwd())] : taskTurn(taskPrompt);
if (turn === undefined) throw new Error(`no demo turn for ${basename(process.cwd())}`);

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const accent = (text: string) => `\x1b[36m${text}\x1b[0m`;
const ok = (text: string) => `\x1b[32m${text}\x1b[0m`;
const line = (text = "") => process.stdout.write(`${text}\r\n`);

process.stdout.write(`\x1b]0;${turn.prompt}\x07`);
line(`${accent("●")} Copilot CLI ${dim("(demo stand-in)")}`);
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
  approvalDialog("Run the tests", "mvn -q test -pl .");
  fire("notification", { notification_type: "permission_prompt", message: "Run command: mvn -q test -pl ." });
} else {
  for (const text of turn.answer) line(text);
  line();
  line(`${accent(">")} `);
  fire("agentStop", { stopReason: "end_turn" });
}

/**
 * The approval box of Copilot CLI 1.0.103, in the layout the daemon reads as an agent dialog (ADR-66), so the tray panel
 * and Home show it in the screenshots.
 */
function approvalDialog(title: string, command: string): void {
  const width = Math.min(process.stdout.columns || 100, 100);
  const inner = width - 4;
  const row = (text = "") => line(`│ ${text.padEnd(inner)} │`);
  line(`╭${"─".repeat(width - 2)}╮`);
  row(title);
  row("─".repeat(inner));
  row(`╭${"─".repeat(inner - 2)}╮`);
  row(`│ ${command.padEnd(inner - 4)} │`);
  row(`╰${"─".repeat(inner - 2)}╯`);
  row();
  row("Do you want to run this command?");
  row();
  row("❯ 1. Yes");
  row("  2. Yes, and don't ask again for `mvn` in this repo");
  row("  3. No, and tell Copilot what to do differently (Esc to stop)");
  row();
  row("↑/↓ to navigate · enter to select · esc to cancel");
  line(`╰${"─".repeat(width - 2)}╯`);
}

// Keep the session open until Trackwall stops it, as an interactive Copilot CLI does.
process.stdin.resume();
process.on("SIGTERM", () => process.exit(143));
