import { describe, expect, test } from "bun:test";
import { AcpSessionInfo } from "../src/modules/agents/acp-session-info.ts";

const MODES = "https://agentclientprotocol.com/protocol/session-modes#";
const option = (mode: string, name: string) => ({ value: `${MODES}${mode}`, name, description: `${name} mode` });
const modeSetting = (current: string) => ({
  id: "mode",
  currentValue: `${MODES}${current}`,
  options: [option("agent", "Agent"), option("plan", "Plan"), option("autopilot", "Autopilot")],
});

describe("the agent's mode", () => {
  test("the view offers Agent and Plan, not autopilot, which drops the questions about paths and URLs", () => {
    const info = new AcpSessionInfo();

    expect(info.settings([{ id: "allow_all", currentValue: "off" }, modeSetting("agent")])).toEqual({
      mode: {
        current: `${MODES}agent`,
        options: [
          { id: `${MODES}agent`, name: "Agent", description: "Agent mode" },
          { id: `${MODES}plan`, name: "Plan", description: "Plan mode" },
        ],
      },
    });
    expect(info.offers(`${MODES}plan`)).toBe(true);
    expect(info.offers(`${MODES}autopilot`)).toBe(false);
  });

  test("autopilot the user turned on with /autopilot shows as the mode the agent works in", () => {
    const info = new AcpSessionInfo();
    info.settings([modeSetting("autopilot")]);

    expect(info.get().mode?.current).toBe(`${MODES}autopilot`);
    expect(info.get().mode?.options.map((o) => o.name)).toEqual(["Agent", "Plan", "Autopilot"]);
  });

  test("settings without a mode, or a mode without a value, change nothing", () => {
    const info = new AcpSessionInfo();

    expect(info.settings(undefined)).toBeUndefined();
    expect(info.settings([{ id: "mode", currentValue: 3 }])).toBeUndefined();
    expect(info.get().mode).toBeNull();
  });

  test("the same mode again is no change, so the views get no frame for it", () => {
    const info = new AcpSessionInfo();
    info.settings([modeSetting("agent")]);

    expect(info.apply({ sessionUpdate: "config_option_update", configOptions: [modeSetting("agent")] })).toBeUndefined();
    expect(info.apply({ sessionUpdate: "config_option_update", configOptions: [modeSetting("plan")] })?.mode?.current).toBe(`${MODES}plan`);
  });
});

describe("the context use and the slash commands", () => {
  test("a usage update is whole tokens of a window, and one without a window size is none", () => {
    const info = new AcpSessionInfo();

    expect(info.apply({ sessionUpdate: "usage_update", used: 10_777.4, size: 128_000 })).toEqual({
      context: { used: 10_777, size: 128_000 },
    });
    expect(info.apply({ sessionUpdate: "usage_update", used: 5, size: 0 })).toEqual({ context: null });
  });

  test("a command keeps its name without a slash, its description and its hint, and a command without a name is left out", () => {
    const info = new AcpSessionInfo();

    expect(
      info.apply({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "/compact", description: "Summarize", input: { hint: "focus instructions" } },
          { name: "review", description: null, input: null },
          { name: "" },
        ],
      }),
    ).toEqual({
      commands: [
        { name: "compact", description: "Summarize", hint: "focus instructions" },
        { name: "review", description: "", hint: "" },
      ],
    });
  });

  test("other updates are not about the session's info", () => {
    expect(new AcpSessionInfo().apply({ sessionUpdate: "session_info_update", title: "Fix" })).toBeUndefined();
  });
});
