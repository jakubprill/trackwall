import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copilotCopies,
  MASKED,
  maskAddress,
  maskCopilotSettings,
  maskMcpConfig,
  maskWorkspaceFile,
} from "../src/modules/local-config/settings-copies.ts";

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

    expect(maskWorkspaceFile(file).toString("utf8")).toBe(
      "# my workspace\nprojectsDir: /home/me/Dev\nlocalConfigRemote: https://git.example.com/me/store.git # allowed\n",
    );
  });

  test("workspace.yaml without a token in it is copied byte for byte", () => {
    const file = Buffer.from("projectsDir:   /home/me/Dev\nlocalConfigRemote: ssh://git@git.example.com/me/store.git\n");

    expect(maskWorkspaceFile(file)).toBe(file);
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
    expect(copies.problems?.[0]).toContain("not valid JSON");
  });

  test("a header or variable passed as an argument loses its value, as does a variable written NAME=value", () => {
    const config = {
      mcpServers: {
        remote: { command: "npx", args: ["mcp-remote", "https://mcp.example.com/sse", "--header", "Authorization: Bearer abc"] },
        docker: {
          command: "docker",
          args: ["run", "-e", "GITHUB_TOKEN=ghp_x", "-e", `GITHUB_HOST=\${GITHUB_HOST}`, "API_KEY=def", "image"],
        },
        kept: { command: "npx", args: ["mcp-remote", "--header", `Authorization: Bearer \${TOKEN}`] },
      },
    };

    const servers = parsed(maskMcpConfig(json(config))).mcpServers;

    expect(servers.remote.args).toEqual(["mcp-remote", "https://mcp.example.com/sse", "--header", MASKED]);
    expect(servers.docker.args).toEqual(["run", "-e", MASKED, "-e", `GITHUB_HOST=\${GITHUB_HOST}`, `API_KEY=${MASKED}`, "image"]);
    expect(servers.kept.args).toEqual(["mcp-remote", "--header", `Authorization: Bearer \${TOKEN}`]);
  });

  test("an address of any scheme loses its user and token, its query values and its fragment, wherever it is", () => {
    expect(maskAddress("https://mcp.example.com/sse?api_key=abc&team=shop#token=def")).toBe(
      `https://mcp.example.com/sse?api_key=${MASKED}&team=${MASKED}#${MASKED}`,
    );
    expect(maskAddress("postgresql://app:pw@db.example.com/orders")).toBe("postgresql://db.example.com/orders");
    expect(maskAddress(`https://mcp.example.com/sse?key=\${KEY}`)).toBe(`https://mcp.example.com/sse?key=\${KEY}`);
    expect(maskAddress("not an address")).toBe("not an address");
    const config = { mcpServers: { db: { command: "pg-mcp", args: ["postgresql://app:pw@db.example.com/orders"] } } };
    expect(parsed(maskMcpConfig(json(config))).mcpServers.db.args).toEqual(["postgresql://db.example.com/orders"]);
  });

  test("a key the masking has no rule for holds the file rather than copying a secret it cannot see", () => {
    const oauth = { mcpServers: { jira: { type: "http", url: "https://mcp.example.com", oauth: { clientSecret: "abc" } } } };
    const otherShape = { servers: { jira: { env: { JIRA_TOKEN: "abc" } } } };

    expect(() => maskMcpConfig(json(oauth))).toThrow("server jira has oauth, which Trackwall does not know");
    expect(() => maskMcpConfig(json(otherShape))).toThrow("has servers, which Trackwall does not know");
    expect(maskMcpConfig(Buffer.from("{}\n")).toString("utf8")).toBe("{}\n");
  });

  test("a parse error never quotes the file, since the quote could be a token", () => {
    expect(() => maskMcpConfig(Buffer.from('{ "mcpServers": { "a": { "env": { "T": "glpat-abc" } }, }'))).toThrow(
      /^not valid JSON, so its secrets cannot be masked$/,
    );
    expect(() =>
      maskWorkspaceFile(Buffer.from("localConfigRemote: https://me:glpat-abc@git.example.com/x\nlocalConfigRemote: y\n")),
    ).toThrow(/^not valid YAML at line \d+, so its secrets cannot be masked$/);
  });

  test("Copilot CLI's settings.json keeps its settings and loses the string value of any key named like a secret", () => {
    const settings = { model: "gpt-5", sandbox: { readonlyPaths: ["~/.gitconfig"] }, provider: { apiKey: "sk-abc", useToken: true } };

    expect(parsed(maskCopilotSettings(json(settings)))).toEqual({
      model: "gpt-5",
      sandbox: { readonlyPaths: ["~/.gitconfig"] },
      provider: { apiKey: MASKED, useToken: true },
    });
  });
});
