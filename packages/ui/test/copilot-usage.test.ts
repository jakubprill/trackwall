import { describe, expect, test } from "bun:test";
import type { CopilotUsage, Session } from "@trackwall/protocol";
import { listedUsage, usageDetails, usageLabel } from "../src/lib/copilot-usage";

const usage = (u: Partial<CopilotUsage>): CopilotUsage => ({
  modelCalls: 3,
  inputTokens: 12_000,
  outputTokens: 800,
  aiCredits: null,
  aiCreditsPartial: false,
  premiumRequests: 0,
  ...u,
});

describe("what a session used, as the UI shows it (ADR-190)", () => {
  test("AI credits when Copilot CLI reported them, rounded like its footer", () => {
    expect(usageLabel(usage({ aiCredits: 1.234 }))).toBe("1.23 AI credits");
    expect(usageLabel(usage({ aiCredits: 1 }))).toBe("1 AI credit");
    expect(usageLabel(usage({ aiCredits: 45.67 }))).toBe("45.7 AI credits");
    expect(usageLabel(usage({ aiCredits: 312.4 }))).toBe("312 AI credits");
    expect(usageLabel(usage({ aiCredits: 2, aiCreditsPartial: true }))).toBe("at least 2 AI credits");
  });

  test("premium requests on the legacy billing, and only tokens with a model of your own provider", () => {
    expect(usageLabel(usage({ premiumRequests: 4 }))).toBe("4 premium requests");
    expect(usageLabel(usage({}))).toBe("12.8k tokens");
  });

  test("the details say how many calls and tokens, and why there are no credits", () => {
    expect(usageDetails(usage({}))).toBe(
      "3 model calls in this conversation\n12k tokens in, 800 out\nCopilot CLI reported no AI credits: a model of your own provider, or a plan without them",
    );
  });

  test("the listed sessions add up, a task's older sessions of the same conversation count once", () => {
    const session = (id: string, task: string | null, u: CopilotUsage | null) => ({ id, task, usage: u }) as Session;
    const sessions = [
      session("s3", "t1", usage({ aiCredits: 5, modelCalls: 4 })),
      session("s2", "t1", usage({ aiCredits: 3, modelCalls: 2 })),
      session("s1", null, usage({ aiCredits: 1, modelCalls: 1 })),
      session("s0", null, null),
    ];

    expect(listedUsage(sessions)).toMatchObject({ aiCredits: 6, modelCalls: 5, aiCreditsPartial: false });
    expect(listedUsage([session("s0", null, null)])).toBeNull();
  });
});
