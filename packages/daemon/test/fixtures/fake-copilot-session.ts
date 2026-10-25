/**
 * Interaktywna atrapa Copilot CLI dla testów sesji w daemonie: działa w PTY, czyta wtyczkę z `--plugin-dir`
 * i wywołuje jej hooki tak jak Copilot CLI (program z `exec` + `args`, payload JSON na stdin). Przebieg:
 * ekran powitalny i `sessionStart` (czeka na Ciebie), linia od użytkownika uruchamia turę z prośbą o zgodę
 * (`notification` `permission_prompt`), `y` kończy turę (`agentStop`), a `/exit` kończy sesję (`sessionEnd`).
 * Tytuł okna i pasek postępu idą sekwencjami OSC, jak w Copilot CLI. Pierwsza tura uruchamia proces pomocnika
 * (jak narzędzie agenta) i wypisuje jego PID, żeby test sprawdził, że stop sesji kończy całą grupę. Pomocnik startuje
 * dopiero po wejściu od użytkownika, bo na Windowsie lider trafia do joba chwilę po starcie.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { pluginHooks } from "../support/plugin-hooks.ts";

const fire = pluginHooks(process.argv, "s1");

/** Serwery MCP z `--additional-mcp-config @<plik>`, jak w Copilot CLI; atrapa tylko wypisuje ich nazwy. */
const McpConfig = z.object({ mcpServers: z.record(z.string(), z.object({ command: z.string() })) });
const mcpArg = process.argv[process.argv.indexOf("--additional-mcp-config") + 1] ?? "";
const mcpServers = mcpArg.startsWith("@") ? Object.keys(McpConfig.parse(JSON.parse(readFileSync(mcpArg.slice(1), "utf8"))).mcpServers) : [];

/** Instruction files from the `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` directories (comma-separated), as in Copilot CLI; the fake prints their names. */
const instructionFiles = (process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "")
  .split(",")
  .filter((dir) => dir !== "" && existsSync(dir))
  .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".instructions.md")));

/** Argumenty zadania (`--interactive=`, `--resume=`, `--session-id=`), które atrapa wypisuje, żeby test je zobaczył. */
const taskArgs = process.argv.filter((a) => /^--(interactive|resume|session-id)=/.test(a));

process.stdout.write(`\x1b]0;Atrapa Copilot\x07Witaj w atrapie, MCP: ${mcpServers.join(", ")}\r\n`);
process.stdout.write(`Instructions: ${instructionFiles.join(", ")}\r\n`);
/** Połowa ekranu sesji (`INITIAL_COLS` w `agents.ts`, 120 kolumn). */
const CWD_LINE_CHARS = 60;
// Katalog w liniach krótszych niż ekran: ConPTY na Windowsie łamie dłuższą linię po swojemu, a test skleja linie.
process.stdout.write(`Katalog:\r\n${process.cwd().replace(new RegExp(`.{${CWD_LINE_CHARS}}`, "g"), "$&\r\n")}\r\n`);
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
    process.stdout.write("\x1b]9;4;0;0\x07Gotowe\r\n> ");
    fire("agentStop", { stopReason: "end_turn" });
    return;
  }
  fire("userPromptSubmitted", { prompt: line });
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  process.stdout.write(`PID pomocnika: ${helper.pid}\r\n`);
  process.stdout.write(`\x1b]0;Praca nad: ${line}\x07\x1b]9;4;3;0\x07Myślę nad: ${line}\r\nZezwolić na bash? (y/n) `);
  awaitingApproval = true;
  fire("notification", { notification_type: "permission_prompt", message: "Allow bash?" });
});
// Stop z UI (SIGTERM do grupy) kończy atrapę jak Copilot CLI: bez hooka końca sesji.
process.on("SIGTERM", () => process.exit(143));
