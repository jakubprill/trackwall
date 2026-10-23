import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAsciicast } from "../src/modules/agents/asciicast.ts";
import { replayCopilotRecording } from "../src/modules/agents/copilot-recording.ts";

const fixture = (name: string) => parseAsciicast(readFileSync(join(import.meta.dir, "fixtures", "copilot", name), "utf8"));
const summary = (changes: ReturnType<typeof replayCopilotRecording>) =>
  changes.map((c) => `${c.state} ${c.source} ${c.confidence} ${c.reason}`);

describe("stan sesji Copilot CLI z nagrania", () => {
  test("sesja z hookami: prośba o zgodę trwa ponad minutę bez Stale, a zdjęcie paska postępu kończy pracę przed hookiem końca tury", () => {
    const changes = replayCopilotRecording(fixture("approval-session.cast"), { staleAfterMs: 60_000 });

    expect(summary(changes)).toEqual([
      "Input hook medium hook sessionStart",
      "Working hook high hook userPromptSubmitted",
      "Approval hook medium hook notification permission_prompt",
      "Working hook high hook postToolUse",
      "Input osc low osc 9;4;0",
      "Input hook high hook agentStop",
      "Done hook high hook sessionEnd user_exit",
    ]);
    expect(changes[2]?.at).toBe("2026-10-23T12:00:04.000Z");
  });

  test("sesja bez hooków: stan z paska postępu OSC 9;4, Stale po ciszy i kod wyjścia na końcu", () => {
    const cast = parseAsciicast(
      [
        '{"version": 2, "width": 80, "height": 24, "timestamp": 0}',
        '[1.0, "o", "\\u001b]9;4;3;0\\u0007Thinking"]',
        '[2.0, "o", "."]',
        '[70.0, "o", "."]',
        '[71.0, "o", "\\u001b]9;4;0;0\\u0007> "]',
        '[80.0, "m", "{\\"kind\\":\\"exit\\",\\"code\\":0}"]',
      ].join("\n"),
    );

    expect(summary(replayCopilotRecording(cast, { staleAfterMs: 60_000 }))).toEqual([
      "Working osc high osc 9;4;3",
      "Stale timeout medium brak wyjścia przez 60 s",
      "Working osc high osc 9;4;3",
      "Input osc low osc 9;4;0",
      "Done exit exact kod wyjścia 0",
    ]);
    // Stale ma czas progu (62 s), a nie następnego wyjścia (70 s), tak jak na żywo.
    expect(replayCopilotRecording(cast, { staleAfterMs: 60_000 })[1]?.at).toBe("1970-01-01T00:01:02.000Z");
  });

  test("znacznik, który nie jest rekordem sesji, jest pomijany, a zła linia nagrania jest błędem z numerem", () => {
    const withManualMarker = parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.0, "m", "tu się zawiesza"]\n');
    expect(replayCopilotRecording(withManualMarker, { staleAfterMs: 60_000 })).toEqual([]);

    expect(() => parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.0, "x", "?"]\n')).toThrow("zła linia 2");
    expect(() => parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.0, "o", \n')).toThrow("zła linia 2");
  });
});
