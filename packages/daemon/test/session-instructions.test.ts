import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_INSTRUCTIONS } from "@trackwall/protocol";
import { writeSessionInstructions } from "../src/modules/agents/session-instructions.ts";

describe("instrukcje sesji Copilot CLI (ADR-46)", () => {
  test("katalog instrukcji sesji dochodzi do katalogów użytkownika po przecinku, a reszta środowiska zostaje", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "trackwall-instructions-")), "instructions");
    const env = writeSessionInstructions(dir, { repo: "sklep", task: null }, { PATH: "/bin", COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/moje" });
    expect(env).toEqual({ PATH: "/bin", COPILOT_CUSTOM_INSTRUCTIONS_DIRS: `/moje,${dir}` });
    expect(writeSessionInstructions(dir, { repo: "sklep", task: null }, {})).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: dir });
  });

  test("plik obowiązuje w całej sesji i niesie rolę sesji oraz instrukcję serwera MCP", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "trackwall-instructions-")), "instructions");
    writeSessionInstructions(dir, { repo: "sklep", task: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" }, {});
    const text = readFileSync(join(dir, "trackwall.instructions.md"), "utf8");
    expect(text.startsWith('---\napplyTo: "**"\n---\n# Working in Trackwall\n')).toBe(true);
    expect(text).toContain("You run the task `1b4e28ba-2fa1-11d2-883f-0016d3cca427` in the repo `sklep`");
    expect(text).toContain("Do not switch branches, push, merge or open pull requests unless the task asks for it.");
    expect(text).toContain(MCP_INSTRUCTIONS);
  });

  test("katalogu z przecinkiem w ścieżce nie da się podać w zmiennej, więc sesja startuje bez pliku instrukcji", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "trackwall-instructions-")), "a,b");
    expect(writeSessionInstructions(dir, { repo: "sklep", task: null }, { PATH: "/bin" })).toEqual({ PATH: "/bin" });
    expect(existsSync(dir)).toBe(false);
  });
});
