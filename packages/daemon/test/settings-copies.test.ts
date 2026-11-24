import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotCopies, MASKED, maskMcpConfig, maskWorkspaceFile } from "../src/modules/local-config/settings-copies.ts";

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const parsed = (bytes: Buffer) => JSON.parse(bytes.toString("utf8"));

describe("the user's settings as the workspace store keeps them", () => {
  test("literal env and header values are masked, references to the environment stay", () => {
    const config = {
      mcpServers: {
        gitlab: {
          type: "http",
          url: "https://mcp.example.com/gitlab",
          headers: { Authorization: "Bearer glpat-abc123", "X-Token": `\${GITLAB_TOKEN}`, "X-Auth": `Bearer \${GITLAB_TOKEN}` },
        },
        jira: { type: "local", command: "jira-mcp", env: { JIRA_TOKEN: "abc", JIRA_URL: "https://jira.example.com", HOME: "$HOME" } },
      },
    };

    expect(parsed(maskMcpConfig(json(config))).mcpServers).toEqual({
      gitlab: {
        type: "http",
        url: "https://mcp.example.com/gitlab",
        headers: { Authorization: MASKED, "X-Token": `\${GITLAB_TOKEN}`, "X-Auth": `Bearer \${GITLAB_TOKEN}` },
      },
      jira: { type: "local", command: "jira-mcp", env: { JIRA_TOKEN: MASKED, JIRA_URL: MASKED, HOME: "$HOME" } },
    });
  });

  test("an argument named like a secret loses its value, in both spellings, and other arguments stay", () => {
    const config = {
      mcpServers: {
        jira: { command: "jira-mcp", args: ["--token", "abc", "--api-key=def", `--password=\${PW}`, "--verbose", "--project", "SHOP"] },
      },
    };

    expect(parsed(maskMcpConfig(json(config))).mcpServers.jira.args).toEqual([
      "--token",
      MASKED,
      `--api-key=${MASKED}`,
      `--password=\${PW}`,
      "--verbose",
      "--project",
      "SHOP",
    ]);
  });

  test("a server address loses its user and token", () => {
    const config = { mcpServers: { docs: { type: "http", url: "https://me:secret@mcp.example.com/docs" } } };

    expect(parsed(maskMcpConfig(json(config))).mcpServers.docs.url).toBe("https://mcp.example.com/docs");
  });

  test("a file with nothing to mask is copied byte for byte, its formatting kept", () => {
    const bytes = Buffer.from(`{"mcpServers": {"git": {"command": "git-mcp", "env": {"GIT_TOKEN": "\${GIT_TOKEN}"}}}}`);

    expect(maskMcpConfig(bytes)).toBe(bytes);
  });

  test("a file that is not JSON is refused, since its secrets cannot be found", () => {
    expect(() => maskMcpConfig(Buffer.from('{ "mcpServers": { "a": { "env": { "T": "abc" } }, }'))).toThrow(
      "not valid JSON, so its secrets cannot be masked",
    );
  });

  test("workspace.yaml loses only the user and token of the store's remote, and keeps its comments", () => {
    const file = Buffer.from(
      "# my workspace\nprojectsDir: /home/me/Dev\nlocalConfigRemote: https://me:glpat-abc@git.example.com/me/store.git # allowed\n",
    );

    expect(maskWorkspaceFile("workspace.yaml", file).toString("utf8")).toBe(
      "# my workspace\nprojectsDir: /home/me/Dev\nlocalConfigRemote: https://git.example.com/me/store.git # allowed\n",
    );
  });

  test("workspace.yaml without a token in it is copied byte for byte", () => {
    const file = Buffer.from("projectsDir:   /home/me/Dev\nlocalConfigRemote: ssh://git@git.example.com/me/store.git\n");

    expect(maskWorkspaceFile("workspace.yaml", file)).toBe(file);
  });

  test("only the user's three Copilot CLI files are copied, and a missing one is simply not there", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-copilot-"));
    writeFileSync(join(home, "settings.json"), "{}\n");
    writeFileSync(join(home, "config.json"), '{ "logged_in_users": ["me"] }\n');

    const copies = await copilotCopies(home);

    expect(copies).toEqual({ copies: [{ file: "settings.json", bytes: Buffer.from("{}\n") }], held: [], problems: [] });
  });

  test("an mcp-config.json that cannot be masked is held with the reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-copilot-"));
    writeFileSync(join(home, "mcp-config.json"), "not json");

    const copies = await copilotCopies(home);

    expect(copies.copies).toEqual([]);
    expect(copies.held).toEqual(["mcp-config.json"]);
    expect(copies.problems[0]).toContain("not valid JSON");
  });
});
