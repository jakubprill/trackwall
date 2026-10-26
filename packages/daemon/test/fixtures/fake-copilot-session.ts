/**
 * An interactive fake Copilot CLI for the daemon's session tests: it runs in a PTY, reads the plugin from `--plugin-dir`
 * and calls its hooks the way Copilot CLI does (the program from `exec` + `args`, a JSON payload on stdin). What it
 * sends and draws comes from the Copilot CLI reference of this system (`test/support/copilot-reference.ts`, ADR-67):
 * the hooks with their payloads, the window titles, the input box and the approval dialog. The flow: a
 * welcome screen with the input box and no hook (waiting for you, read from the screen), a line from the user starts a
 * turn with an approval request (the first turn after `sessionStart`, at once with a prompt from `--interactive=`),
 * a "Yes" option or Enter approves and ends the turn, and `/exit` ends the session. The line `PARALLEL_TOOLS_PROMPT` starts
 * a turn in which the agent calls two such commands at once: as in Copilot CLI (the contract test of ADR-66), both
 * approval requests come at once, the second dialog follows the first answer, and the first command's `postToolUse`
 * comes while the second dialog waits. The fake also prints what the tests check
 * (MCP servers, instructions, directory, arguments, the prompt) and, on every turn, starts a helper process (like an
 * agent's tool) and prints its PID, so that the test can check that stopping the session ends the whole group. The
 * helper starts only after input from the user, because on Windows the leader joins the job a moment after the start.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ESCAPE } from "../../src/modules/agents/copilot-keys.ts";
import { stripAnsi } from "../../src/modules/logs/stream-lines.ts";
import { PARALLEL_TOOLS_PROMPT, PROMPT_PLACEHOLDER, type ReferenceHook, reference } from "../support/copilot-reference.ts";
import { pluginHooks } from "../support/plugin-hooks.ts";

const fire = pluginHooks(process.argv, "s1");

/**
 * MCP servers from the user's `$COPILOT_HOME/mcp-config.json` and then from `--additional-mcp-config @<file>`, which
 * adds to them, as in Copilot CLI (the contract test of ADR-70); the fake only prints their names.
 */
const McpConfig = z.object({ mcpServers: z.record(z.string(), z.unknown()) });
const serversIn = (file: string) => Object.keys(McpConfig.parse(JSON.parse(readFileSync(file, "utf8"))).mcpServers);
const userMcpConfig = process.env.COPILOT_HOME ? join(process.env.COPILOT_HOME, "mcp-config.json") : undefined;
const mcpArg = process.argv[process.argv.indexOf("--additional-mcp-config") + 1] ?? "";
const mcpServers = [
  ...(userMcpConfig !== undefined && existsSync(userMcpConfig) ? serversIn(userMcpConfig) : []),
  ...(mcpArg.startsWith("@") ? serversIn(mcpArg.slice(1)) : []),
];

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

const real = reference();
const title = (text: string) => process.stdout.write(`\x1b]0;${text}\x07`);
const draw = (lines: readonly string[]) => process.stdout.write(`${lines.join("\r\n")}\r\n`);

const initialPrompt = taskArgs.find((a) => a.startsWith("--interactive="))?.slice("--interactive=".length);

/**
 * Fires the reference's hooks with their payloads. Of the fields the reference leaves out, the directory and the prompts
 * get their values; the rest (tool arguments and results, the transcript) an empty string, since the daemon keeps only
 * their names.
 */
function replay(hooks: readonly ReferenceHook[], prompt = ""): void {
  const values: Record<string, string> = { cwd: process.cwd(), prompt, initialPrompt: initialPrompt ?? "" };
  for (const { event, payload, omitted } of hooks) {
    fire(event, { ...Object.fromEntries(omitted.map((name) => [name, values[name] ?? ""])), ...payload });
  }
}

/** The reference's turn with an approval, split where the fake waits for the answer: after the approval request. */
const asked = real.approval.hooks.findIndex((h) => h.event === "notification") + 1;
const [firstHook, secondHook] = real.approval.hooks;
if (firstHook?.event !== "sessionStart" || secondHook?.event !== "userPromptSubmitted" || asked === 0) {
  throw new Error("the approval turn of the reference does not start with sessionStart and userPromptSubmitted, or asks nothing");
}
const startHook: ReferenceHook = firstHook;
const promptHook: ReferenceHook = secondHook;
/** The approved command's hook, which the first of two commands at once sends while the second dialog waits. */
const approvedHook = real.approval.hooks[asked];
if (approvedHook?.event !== "postToolUse") throw new Error("the approval turn of the reference has no postToolUse after the approval");
const firstToolDone: ReferenceHook = approvedHook;

/**
 * The second of two commands called at once: the reference's command with another file, in its approval request and
 * its dialog. Of the same length, so the dialog's box keeps its width.
 */
const secondCommand = (text: string) => text.replaceAll("made-by-agent", "made-by-other");
const secondRequest = real.approval.hooks.slice(2, asked).map((h) => ({
  ...h,
  payload: Object.fromEntries(Object.entries(h.payload).map(([k, v]) => [k, typeof v === "string" ? secondCommand(v) : v])),
}));

const [startTitle, ...turnTitles] = real.titles;
if (startTitle === undefined) throw new Error("the reference has no window title");
title(startTitle);
process.stdout.write(`Welcome to the fake, MCP: ${mcpServers.join(", ")}\r\n`);
process.stdout.write(`Instructions: ${instructionFiles.join(", ")}\r\n`);
/** Half the session screen (`INITIAL_COLS` in `agents.ts`, 120 columns). */
const CWD_LINE_CHARS = 60;
// The directory in lines shorter than the screen: ConPTY on Windows wraps a longer line its own way, and the test joins the lines.
process.stdout.write(`Directory:\r\n${process.cwd().replace(new RegExp(`.{${CWD_LINE_CHARS}}`, "g"), "$&\r\n")}\r\n`);
for (const arg of taskArgs) process.stdout.write(`Argument: ${arg}\r\n`);
draw(real.promptBox);

// A prompt given at the start (`--interactive=`, a task's session) is the first prompt, so it starts the hooks at once.
let started = initialPrompt !== undefined;
if (started) replay([startHook]);
/** Approval requests of the turn not answered yet. */
let awaitingApprovals = 0;
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
  for (const turnTitle of turnTitles) title(turnTitle.replaceAll(PROMPT_PLACEHOLDER, line));
  process.stdout.write(`Thinking about: ${line}\r\n`);
  draw(real.approval.dialog);
  const parallel = line === PARALLEL_TOOLS_PROMPT;
  awaitingApprovals = parallel ? 2 : 1;
  replay([...real.approval.hooks.slice(2, asked), ...(parallel ? secondRequest : [])]);
}

/** A "Yes" option of the approval: the command runs, and the next dialog follows or the turn ends. */
function approve(): void {
  awaitingApprovals--;
  if (awaitingApprovals > 0) {
    draw(real.approval.dialog.map(secondCommand));
    replay([firstToolDone]);
    return;
  }
  replay(real.approval.hooks.slice(asked));
  draw(real.promptBox);
}

/**
 * Keys of the approval that run the command: the digits of its "Yes" options (on Windows only `1`, since a PowerShell
 * command has no "don't ask again"), and Enter on the selected first one. Read from the reference's text, not with the
 * daemon's dialog reader, so that the fake does not agree with the daemon by construction.
 */
const APPROVE_KEYS = new Set(["\r", "\n", ...real.approval.dialog.flatMap((line) => /(\d)\. Yes\b/.exec(line)?.[1] ?? [])]);

/**
 * Typed text without terminal input around it: CSI and OSC sequences (a bracketed paste's markers, a focus report, a
 * colour reply) and Esc. A sequence split across two reads is not recognised, which the tests never send.
 */
const typedText = (chunk: Buffer) => stripAnsi(chunk.toString("utf8")).replaceAll(ESCAPE, "");

// Keys one by one, as Copilot CLI reads them: a digit answers the approval without Enter. A rejection ("No", Esc) is not
// in the reference, so the fake keeps waiting for an approval.
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk: Buffer) => {
  for (const key of typedText(chunk)) {
    if (awaitingApprovals > 0) {
      if (APPROVE_KEYS.has(key)) approve();
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
