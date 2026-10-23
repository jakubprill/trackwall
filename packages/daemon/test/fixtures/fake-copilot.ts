/**
 * Atrapa Copilot CLI dla testu `copilot-record`: czyta wtyczkę z `--plugin-dir`, wywołuje jej hooki tak jak
 * Copilot CLI (program z `exec` + `args`, payload JSON na stdin) i wypisuje pasek postępu OSC 9;4.
 * Kończy się kodem z `FAKE_COPILOT_EXIT`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const HooksFile = z.object({ hooks: z.record(z.string(), z.array(z.object({ exec: z.string(), args: z.array(z.string()) }))) });

const dirIndex = process.argv.indexOf("--plugin-dir");
const pluginDir = process.argv[dirIndex + 1];
if (dirIndex < 0 || !pluginDir) throw new Error("brak --plugin-dir");
const { hooks } = HooksFile.parse(JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8")));

function fire(event: string, payload: Record<string, unknown>): void {
  for (const hook of hooks[event] ?? []) {
    spawnSync(hook.exec, hook.args, { input: JSON.stringify({ sessionId: "s1", timestamp: Date.now(), cwd: process.cwd(), ...payload }) });
  }
}

fire("sessionStart", { source: "new" });
process.stdout.write("\x1b]0;Naprawa testu\x07> ");
fire("userPromptSubmitted", { prompt: "tajny prompt" });
process.stdout.write("\x1b]9;4;3;0\x07Thinking");
fire("notification", { notification_type: "permission_prompt", message: "Allow bash?" });
fire("postToolUse", { toolName: "bash", toolResult: { textResultForLlm: "HASLO=tajne" } });
fire("agentStop", { stopReason: "end_turn" });
process.stdout.write("\x1b]9;4;0;0\x07Gotowe\r\n");
fire("sessionEnd", { reason: "user_exit" });
process.exit(Number(process.env.FAKE_COPILOT_EXIT ?? "0"));
