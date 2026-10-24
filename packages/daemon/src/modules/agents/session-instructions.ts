import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_INSTRUCTIONS, mcpTools } from "@trackwall/protocol";

/**
 * Instrukcje sesji (§4.4, ADR-46): plik `*.instructions.md` w katalogu sesji, który Copilot CLI wczytuje jako
 * instrukcję repo, bo daemon dopisuje ten katalog do `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` w środowisku sesji. Nie
 * zmienia plików repo użytkownika ani `~/.copilot`. Treść to rola sesji (sesja w korzeniu repo albo sesja zadania
 * w worktree) i wspólna instrukcja MCP (`MCP_INSTRUCTIONS`), której Copilot CLI z serwera MCP nie bierze.
 */

/** Zmienna Copilot CLI 1.0.103 z katalogami instrukcji, oddzielonymi przecinkiem (sprawdzone `copilot instruction list`). */
const INSTRUCTIONS_DIRS_ENV = "COPILOT_CUSTOM_INSTRUCTIONS_DIRS";
const INSTRUCTIONS_FILE = "trackwall.instructions.md";

/** Kim jest sesja: w korzeniu repo (`task: null`) albo w worktree zadania. */
export interface SessionRole {
  repo: string;
  task: string | null;
}

/**
 * Zapisuje plik instrukcji w `dir` i zwraca środowisko sesji z `dir` dopisanym do katalogów instrukcji użytkownika.
 * Katalogu z przecinkiem w ścieżce nie da się podać w tej zmiennej, więc sesja startuje wtedy bez instrukcji Trackwall
 * (dalej z narzędziami MCP), a nie z cudzym katalogiem z połowy ścieżki.
 */
export function writeSessionInstructions(dir: string, role: SessionRole, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (dir.includes(",")) return env;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INSTRUCTIONS_FILE), sessionInstructions(role));
  const own = env[INSTRUCTIONS_DIRS_ENV];
  return { ...env, [INSTRUCTIONS_DIRS_ENV]: own ? `${own},${dir}` : dir };
}

function sessionInstructions({ repo, task }: SessionRole): string {
  return [
    // `applyTo: "**"`: instrukcja dla każdego pliku, czyli dla całej sesji, jak `.github/instructions` w repo.
    "---",
    'applyTo: "**"',
    "---",
    "# Working in Trackwall",
    "",
    "Trackwall started this Copilot CLI session, and its `trackwall` MCP server is connected.",
    "",
    "## Your session",
    "",
    ...(task === null ? repoRole(repo) : taskRole(repo, task)),
    "",
    "## Trackwall tools",
    "",
    MCP_INSTRUCTIONS,
    "",
  ].join("\n");
}

function repoRole(repo: string): string[] {
  return [
    `You work in the root of the repo \`${repo}\` (its id in Trackwall tools): the user's own working copy.`,
    `- A larger piece of work, work in another repo or work that can run in parallel goes to another agent: propose it with ${mcpTools.proposeTask.name} and follow it with ${mcpTools.waitForSession.name}.`,
    `- ${mcpTools.reportResult.name} is only for task sessions; here you answer the user directly.`,
  ];
}

function taskRole(repo: string, task: string): string[] {
  return [
    `You run the task \`${task}\` in the repo \`${repo}\` (its id in Trackwall tools), in the task's own git worktree on its own branch. The user reviews the task's changes in Trackwall.`,
    "- Work only in this worktree: the repo root and other worktrees belong to the user and to other agents.",
    "- Commit your changes on the task branch. Do not switch branches, push, merge or open pull requests unless the task asks for it.",
    `- Work that belongs to another repo is not yours: propose it with ${mcpTools.proposeTask.name} and say so in your result.`,
    `- When you are done, or stuck and need the user, call ${mcpTools.reportResult.name}: what you did, what is left and what to check. Call it again if the result changes.`,
  ];
}
