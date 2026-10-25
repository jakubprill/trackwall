import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsciicast } from "../src/modules/agents/asciicast.ts";
import { replayCopilotRecording, StatesLine } from "../src/modules/agents/copilot-recording.ts";
import { jsonOf } from "../src/modules/agents/json.ts";

const script = join(import.meta.dir, "..", "scripts", "copilot-record.ts");
const fakeCopilot = join(import.meta.dir, "fixtures", "fake-copilot.ts");

async function recordFakeSession(exitCode: number) {
  const out = mkdtempSync(join(tmpdir(), "trackwall-record-"));
  const proc = Bun.spawn([process.execPath, script, "record", "--out", out, "--copilot", process.execPath, "--", fakeCopilot], {
    env: { ...process.env, FAKE_COPILOT_EXIT: String(exitCode) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const states = readFileSync(join(out, "states.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => jsonOf(StatesLine).parse(line));
  return { out, code, stdout, stderr, states };
}

describe("recording a Copilot CLI session (a real PTY and hook processes)", () => {
  test("hooks from the session plugin give the state, the recording replays the same changes to the millisecond, and the session's content does not reach the records", async () => {
    const { out, code, stdout, stderr, states } = await recordFakeSession(0);

    expect(code).toBe(0);
    expect(stdout).toContain("Thinking");
    expect(stderr).toContain("State changes");
    const hookStates = states.filter((s) => s.source === "hook").map((s) => `${s.state} ${s.reason}`);
    expect(hookStates).toEqual([
      "Input hook sessionStart",
      "Working hook userPromptSubmitted",
      "Approval hook notification permission_prompt",
      "Working hook postToolUse",
      "Input hook agentStop",
      "Done hook sessionEnd user_exit",
    ]);

    const replayed = replayCopilotRecording(parseAsciicast(readFileSync(join(out, "session.cast"), "utf8")), { staleAfterMs: 60_000 });
    expect(replayed.map((c) => `${c.at} ${c.state} ${c.source} ${c.reason}`)).toEqual(
      states.map((s) => `${s.at} ${s.state} ${s.source} ${s.reason}`),
    );

    const hooks = readFileSync(join(out, "hooks.jsonl"), "utf8");
    expect(hooks).not.toContain("secret prompt");
    expect(hooks).not.toContain("PASSWORD");
    expect(states.at(-1)?.windowTitle).toBe("Fixing the test");
  }, 30_000);

  test("a non-zero session exit code is the recording's exit code", async () => {
    const { code, states } = await recordFakeSession(3);

    expect(code).toBe(3);
    // The hook reported the end of the session, so the state from the hook stays, and the exit code does not override it.
    expect(states.at(-1)).toMatchObject({ state: "Done", source: "hook" });
  }, 30_000);
});
