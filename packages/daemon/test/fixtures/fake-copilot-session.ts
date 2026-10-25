/**
 * An interactive fake Copilot CLI for the daemon's session tests: it runs in a PTY, reads the plugin from `--plugin-dir`
 * and calls its hooks the way Copilot CLI does (the program from `exec` + `args`, a JSON payload on stdin). The flow:
 * a welcome screen and `sessionStart` (waiting for you), a line from the user starts a turn with an approval request
 * (`notification` `permission_prompt`), `y` ends the turn (`agentStop`), and `/exit` ends the session (`sessionEnd`).
 * The window title and the progress bar go as OSC sequences, as in Copilot CLI. The first turn starts a helper process
 * (like an agent's tool) and prints its PID, so that the test can check that stopping the session ends the whole group.
 * The helper starts only after input from the user, because on Windows the leader joins the job a moment after the start.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
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

/** Task arguments (`--interactive=`, `--resume=`, `--session-id=`) the fake prints, so that the test sees them. */
const taskArgs = process.argv.filter((a) => /^--(interactive|resume|session-id)=/.test(a));

process.stdout.write(`\x1b]0;Fake Copilot\x07Welcome to the fake, MCP: ${mcpServers.join(", ")}\r\n`);
process.stdout.write(`Instructions: ${instructionFiles.join(", ")}\r\n`);
/** Half the session screen (`INITIAL_COLS` in `agents.ts`, 120 columns). */
const CWD_LINE_CHARS = 60;
// The directory in lines shorter than the screen: ConPTY on Windows wraps a longer line its own way, and the test joins the lines.
process.stdout.write(`Directory:\r\n${process.cwd().replace(new RegExp(`.{${CWD_LINE_CHARS}}`, "g"), "$&\r\n")}\r\n`);
for (const arg of taskArgs) process.stdout.write(`Argument: ${arg}\r\n`);
process.stdout.write("> ");
fire("sessionStart", { source: "new" });

let awaitingApproval = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line === "/exit") {
    fire("sessionEnd", { reason: "user_exit" });
    process.exit(0);
  }
  if (awaitingApproval) {
    awaitingApproval = false;
    fire("postToolUse", { toolName: "bash" });
    process.stdout.write("\x1b]9;4;0;0\x07Done\r\n> ");
    fire("agentStop", { stopReason: "end_turn" });
    return;
  }
  fire("userPromptSubmitted", { prompt: line });
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  process.stdout.write(`helper PID: ${helper.pid}\r\n`);
  process.stdout.write(`\x1b]0;Working on: ${line}\x07\x1b]9;4;3;0\x07Thinking about: ${line}\r\nAllow bash? (y/n) `);
  awaitingApproval = true;
  fire("notification", { notification_type: "permission_prompt", message: "Allow bash?" });
});
// A stop from the UI (SIGTERM to the group) ends the fake like Copilot CLI: without the end-of-session hook.
process.on("SIGTERM", () => process.exit(143));
