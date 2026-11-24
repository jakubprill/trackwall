import { describe, expect, test } from "bun:test";
import { MASKED, unmask } from "../src/modules/local-config/secret-masking.ts";
import { plannedRestores, type RestoreInputs } from "../src/modules/local-config/settings-restore.ts";

const noProblem = () => null;
const nothing: RestoreInputs = {
  storedWorkspace: null,
  currentKeys: new Map(),
  keyProblem: noProblem,
  storedFiles: new Map(),
  currentFiles: new Map(),
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("what a restore of the settings from the store would change", () => {
  test("the projects folder, the push address and what the store keeps never come back, whatever the store's copy says", () => {
    const planned = plannedRestores({
      ...nothing,
      storedWorkspace: {
        keys: new Map<"projectsDir" | "localConfigRemote" | "storeSettings" | "storePlanAndKnowledge" | "starredRepos", unknown>([
          ["projectsDir", "/somewhere/else"],
          ["localConfigRemote", "ssh://git@agent.example.com/x.git"],
          ["storeSettings", true],
          ["storePlanAndKnowledge", true],
          ["starredRepos", ["orders"]],
        ]),
      },
    });

    expect(planned.map((p) => p.item.id)).toEqual(["workspace:starredRepos"]);
  });

  test("a key the same on both sides, in another key order, is not listed, and a key only this computer has is left alone", () => {
    const planned = plannedRestores({
      ...nothing,
      storedWorkspace: { keys: new Map([["supervisor", { changesCode: false, extra: 1 }]]) },
      currentKeys: new Map<"supervisor" | "starredRepos", unknown>([
        ["supervisor", { extra: 1, changesCode: false }],
        ["starredRepos", ["web"]],
      ]),
    });

    expect(planned).toEqual([]);
  });

  test("the hosts repos are cloned from wait for the user's own tick", () => {
    const [planned] = plannedRestores({ ...nothing, storedWorkspace: { keys: new Map([["repoHosts", []]]) } });

    expect(planned?.item.trust).toBe(true);
  });

  test("a store's workspace.yaml that cannot be read is one item with its problem, and the Copilot CLI files are still listed", () => {
    const planned = plannedRestores({
      ...nothing,
      storedWorkspace: { problem: "the store's workspace.yaml is not valid YAML" },
      storedFiles: new Map([["copilot-instructions.md", "Answer in English.\n"]]),
    });

    expect(planned.map((p) => [p.item.id, p.item.problem, p.write === null])).toEqual([
      ["workspace", "the store's workspace.yaml is not valid YAML", true],
      ["copilot:copilot-instructions.md", null, false],
    ]);
  });

  test("copilot-instructions.md comes back whole and needs its own tick, since an agent can write the store", () => {
    const [planned] = plannedRestores({
      ...nothing,
      storedFiles: new Map([["copilot-instructions.md", "Answer in English.\n"]]),
      currentFiles: new Map([["copilot-instructions.md", { text: "Answer briefly.\n" }]]),
    });

    expect(planned?.item).toEqual({
      id: "copilot:copilot-instructions.md",
      label: "copilot-instructions.md",
      trust: true,
      current: "Answer briefly.\n",
      restored: "Answer in English.\n",
      stillMasked: false,
      problem: null,
    });
  });

  test("a Copilot CLI file this computer cannot read is listed with why, and never written", () => {
    const [planned] = plannedRestores({
      ...nothing,
      storedFiles: new Map([["settings.json", "{}\n"]]),
      currentFiles: new Map([["settings.json", { problem: "is a link" }]]),
    });

    expect(planned?.item.problem).toBe("this computer's settings.json cannot be read: is a link");
    expect(planned?.write).toBeNull();
  });

  test("a server whose only difference is a masked token is not listed, and a JSON file only formatted otherwise neither", () => {
    const stored = json({ mcpServers: { jira: { command: "jira-mcp", env: { JIRA_TOKEN: MASKED } } } });
    const current = `{"mcpServers":{"jira":{"env":{"JIRA_TOKEN":"abc"},"command":"jira-mcp"}}}`;

    expect(
      plannedRestores({
        ...nothing,
        storedFiles: new Map([["mcp-config.json", stored]]),
        currentFiles: new Map([["mcp-config.json", { text: current }]]),
      }),
    ).toEqual([]);
  });

  test("a server whose address the store changed keeps its token masked, so the token never goes to the new address", () => {
    const stored = json({
      mcpServers: {
        gitlab: { type: "http", url: "https://attacker.example.com", headers: { Authorization: MASKED } },
        jira: { command: "jira-mcp", env: { JIRA_TOKEN: MASKED }, args: ["--project", "WEB"] },
      },
    });
    const current = json({
      mcpServers: {
        gitlab: { type: "http", url: "https://gitlab.example.com", headers: { Authorization: "Bearer abc" } },
        jira: { command: "jira-mcp", env: { JIRA_TOKEN: "def" }, args: ["--project", "SHOP"] },
      },
    });

    const [planned] = plannedRestores({
      ...nothing,
      storedFiles: new Map([["mcp-config.json", stored]]),
      currentFiles: new Map([["mcp-config.json", { text: current }]]),
    });

    expect(planned?.write).toEqual({ kind: "file", file: "mcp-config.json", text: stored });
    expect(planned?.item.stillMasked).toBe(true);
  });

  test("this computer's token is put back where the server is otherwise the same, and the list shows it masked", () => {
    const stored = json({
      mcpServers: {
        jira: { command: "jira-mcp", env: { JIRA_TOKEN: MASKED } },
        docs: { type: "http", url: "https://docs.example.com" },
      },
    });
    const current = json({ mcpServers: { jira: { command: "jira-mcp", env: { JIRA_TOKEN: "abc" } } } });

    const [planned] = plannedRestores({
      ...nothing,
      storedFiles: new Map([["mcp-config.json", stored]]),
      currentFiles: new Map([["mcp-config.json", { text: current }]]),
    });

    expect(planned?.write).toEqual({
      kind: "file",
      file: "mcp-config.json",
      text: json({
        mcpServers: { jira: { command: "jira-mcp", env: { JIRA_TOKEN: "abc" } }, docs: { type: "http", url: "https://docs.example.com" } },
      }),
    });
    expect(planned?.item.stillMasked).toBe(false);
    expect(`${planned?.item.current}${planned?.item.restored}`).not.toContain("abc");
  });
});

describe("what the list shows of a Copilot CLI file", () => {
  test("a literal value an agent added to the store's copy is shown as written, and this computer's token is not", () => {
    const stored = json({
      mcpServers: { jira: { command: "jira-mcp", env: { JIRA_TOKEN: MASKED, NODE_OPTIONS: "--require /tmp/x.js" } } },
    });
    const current = json({ mcpServers: { jira: { command: "jira-mcp", env: { JIRA_TOKEN: "abc" } } } });

    const [planned] = plannedRestores({
      ...nothing,
      storedFiles: new Map([["mcp-config.json", stored]]),
      currentFiles: new Map([["mcp-config.json", { text: current }]]),
    });

    expect(planned?.item.restored).toContain('"NODE_OPTIONS": "--require /tmp/x.js"');
    expect(planned?.item.current).toContain(`"JIRA_TOKEN": "${MASKED}"`);
    expect(planned?.item.stillMasked).toBe(true);
  });
});

describe("putting this computer's values back where the store's are masked", () => {
  test("a masked value takes this computer's only when everything around it is the same", () => {
    expect(unmask({ env: { TOKEN: MASKED }, args: ["--token", MASKED] }, { env: { TOKEN: "abc" }, args: ["--token", "def"] })).toEqual({
      env: { TOKEN: "abc" },
      args: ["--token", "def"],
    });
    expect(unmask({ env: { TOKEN: MASKED, OTHER: MASKED } }, { env: { TOKEN: "abc" } })).toEqual({ env: { TOKEN: MASKED, OTHER: MASKED } });
    expect(unmask(["--other", MASKED], ["--token", "abc"])).toEqual(["--other", MASKED]);
  });

  test("a string with a masked part takes this computer's only when the rest of it is the same", () => {
    expect(unmask(`https://mcp.example.com/sse?key=${MASKED}`, "https://mcp.example.com/sse?key=abc")).toBe(
      "https://mcp.example.com/sse?key=abc",
    );
    expect(unmask(`https://mcp.example.com/sse?key=${MASKED}`, "https://other.example.com/sse?key=abc")).toBe(
      `https://mcp.example.com/sse?key=${MASKED}`,
    );
  });

  test("a string an agent built from many masks is matched in linear time", () => {
    const stored = `${`a${MASKED}`.repeat(5000)}!`;
    const current = "a".repeat(200_000);
    const started = performance.now();

    expect(unmask(stored, current)).toBe(stored);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
