/**
 * An interactive fake Copilot CLI for the daemon's session tests: it runs in a PTY, reads the plugin from `--plugin-dir`
 * and calls its hooks the way Copilot CLI does (the program from `exec` + `args`, a JSON payload on stdin). What it
 * sends and draws comes from the recording of the real Copilot CLI on this system (`test/support/copilot-recorded.ts`,
 * ADR-69): the hooks with their payloads, the window titles, the input box and the approval dialog. The flow: a
 * welcome screen with the input box and no hook (waiting for you, read from the screen), a line from the user starts a
 * turn with an approval request (the first turn after `sessionStart`, at once with a prompt from `--interactive=`),
 * the key `1` approves and ends the turn, and `/exit` ends the session. The fake also prints what the tests check
 * (MCP servers, instructions, directory, arguments, the prompt) and, on every turn, starts a helper process (like an
 * agent's tool) and prints its PID, so that the test can check that stopping the session ends the whole group. The
 * helper starts only after input from the user, because on Windows the leader joins the job a moment after the start.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PROMPT_PLACEHOLDER, type RecordedHook, recorded } from "../support/copilot-recorded.ts";
import { pluginHooks } from "../support/plugin-hooks.ts";

const fire = pluginHooks(process.argv, "s1");

/** MCP servers from `--additional-mcp-config @<file>`, as in Copilot CLI; the fake only prints their names. */
const McpConfig = z.object({ mcpServers: z.record(z.string(), z.object({ command: z.string() })) });
const mcpArg = process.argv[process.argv.indexOf("--additional-mcp-config") + 1] ?? "";
const mcpServers = mcpArg.startsWith("@") ? Object.keys(McpConfig.parse(JSON.parse(readFileSync(mcpArg.slice(1), "utf8"))).mcpServers) : [];

/** Instruction files from the `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` directories (comma-separated), as in Copilot CLI; the fake prints their names. */
const instructionFiles = (process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "")
  .split(",")
  .filter((dir) => dir !== "" && existsSync(dir))
  .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".instructions.md")));

/**
 * Task arguments (`--interactive=`, `--resume=`, `--session-id=`) and tool permissions (`--allow-tool=`, `--deny-tool=`)
 * the fake prints, so that the test sees them.
 */
const taskArgs = process.argv.filter((a) => /^--(interactive|resume|session-id|allow-tool|deny-tool)=/.test(a));

const real = recorded();
const title = (text: string) => process.stdout.write(`\x1b]0;${text}\x07`);
const draw = (lines: readonly string[]) => process.stdout.write(`${lines.join("\r\n")}\r\n`);

/** Fires recorded hooks with their payloads; the fields the record leaves out get values of the right kind. */
function replay(hooks: readonly RecordedHook[], prompt = ""): void {
  for (const { event, payload, omitted } of hooks) {
    const left = Object.fromEntries(omitted.map((name) => [name, name === "cwd" ? process.cwd() : name === "prompt" ? prompt : ""]));
    fire(event, { ...left, ...payload });
  }
}

/** The recorded turn with an approval, split where the fake waits for the answer: after the approval request. */
const asked = real.approval.hooks.findIndex((h) => h.event === "notification") + 1;
const [firstHook, secondHook] = real.approval.hooks;
if (firstHook?.event !== "sessionStart" || secondHook?.event !== "userPromptSubmitted" || asked === 0) {
  throw new Error("the recorded approval turn does not start with sessionStart and userPromptSubmitted, or asks nothing");
}
const startHook: RecordedHook = firstHook;
const promptHook: RecordedHook = secondHook;

title(real.titles[0] ?? "");
process.stdout.write(`Welcome to the fake, MCP: ${mcpServers.join(", ")}\r\n`);
process.stdout.write(`Instructions: ${instructionFiles.join(", ")}\r\n`);
/** Half the session screen (`INITIAL_COLS` in `agents.ts`, 120 columns). */
const CWD_LINE_CHARS = 60;
// The directory in lines shorter than the screen: ConPTY on Windows wraps a longer line its own way, and the test joins the lines.
process.stdout.write(`Directory:\r\n${process.cwd().replace(new RegExp(`.{${CWD_LINE_CHARS}}`, "g"), "$&\r\n")}\r\n`);
for (const arg of taskArgs) process.stdout.write(`Argument: ${arg}\r\n`);
draw(real.promptBox);

// A prompt given at the start (`--interactive=`, a task's session) is the first prompt, so it starts the hooks at once.
let started = taskArgs.some((a) => a.startsWith("--interactive="));
if (started) replay([startHook]);
let awaitingApproval = false;
let typed = "";

function submit(line: string): void {
  if (line === "/exit") {
    replay(real.exit);
    process.exit(0);
  }
  // Copilot CLI starts the session's hooks only with the first prompt (ADR-69).
  replay(started ? [promptHook] : [startHook, promptHook], line);
  started = true;
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  process.stdout.write(`helper PID: ${helper.pid}\r\n`);
  title(real.titles.at(-1)?.replaceAll(PROMPT_PLACEHOLDER, line) ?? line);
  process.stdout.write(`Thinking about: ${line}\r\n`);
  draw(real.approval.dialog);
  awaitingApproval = true;
  replay(real.approval.hooks.slice(2, asked));
}

/** Option 1 of the approval: the command runs and the turn ends. */
function approve(): void {
  awaitingApproval = false;
  replay(real.approval.hooks.slice(asked));
  draw(real.promptBox);
}

// Keys one by one, as Copilot CLI reads them: a digit answers the approval without Enter. Terminal sequences (ESC …,
// such as a bracketed paste's markers or a focus report) are not typed text.
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  if (text.startsWith("\x1b")) return;
  for (const key of text) {
    if (awaitingApproval) {
      if (key === "1") approve();
    } else if (key === "\r" || key === "\n") {
      process.stdout.write("\r\n");
      const line = typed;
      typed = "";
      submit(line);
    } else {
      typed += key;
      process.stdout.write(key);
    }
  }
});
// A stop from the UI (SIGTERM to the group) ends the fake like Copilot CLI: without the end-of-session hook.
process.on("SIGTERM", () => process.exit(143));
