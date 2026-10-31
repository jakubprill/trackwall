import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { AppConfig } from "@trackwall/protocol";
import { gitIn } from "./support/git-repo.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "q".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const APP = "src/main/resources/application.yml";
const LOCAL = "src/main/resources/application-local.yml";

const SHOP_APPLICATION = `spring:
  application:
    name: shop
  datasource:
    url: \${SHOP_DB_URL:jdbc:postgresql://shop:committed-db-pw@localhost/shop?password=committed-db-pw}
    password: \${SHOP_DB_PASSWORD}
orders:
  base-url: \${SHOP_ORDERS_URL}
  api-key: committed-api-key-value
`;

/** What mise sets in the repo root of `shop`: the database password, which mise redacts. */
const SHOP_MISE = { tasks: [], env: { SHOP_DB_PASSWORD: "mise-db-password-value" }, redacted: ["SHOP_DB_PASSWORD"] };

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      shop: { ".gitignore": "application-local.yml\n", [APP]: SHOP_APPLICATION, "fake-mise.json": JSON.stringify(SHOP_MISE) },
      warehouse: { "README.md": "# warehouse\n" },
    },
    miseCommand: FAKE_MISE,
  });
  client = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await daemon.stop();
});

async function appConfig(args: Record<string, string>): Promise<{ config: AppConfig; text: string }> {
  const result = await client.callTool({ name: "get_app_config", arguments: args });
  return { config: AppConfig.parse(result.structuredContent), text: JSON.stringify(result) };
}

describe.skipIf(process.versions.bun === undefined)("get_app_config (real git working directory, fake mise)", () => {
  test("reads the files a run reads now, also a git-ignored local profile, and never returns a secret's value", async () => {
    const shop = join(daemon.projects, "shop");
    writeFileSync(join(shop, LOCAL), "orders:\n  api-key: local-api-key-value\nserver.port: 8081\n");

    const { config, text } = await appConfig({ repo: "shop", profile: "local" });

    expect(config.files).toEqual([APP, LOCAL]);
    expect(config.envProblem).toBeNull();
    const [module] = config.modules;
    expect(module).toMatchObject({ module: "", app: "shop", profiles: ["local"], profileFound: true, activeProfiles: null });
    expect(module?.entries.map((e) => [e.key, e.value, e.secret, e.set, e.env, `${e.path}:${e.line}`])).toEqual([
      ["spring.application.name", "shop", false, true, [], `${APP}:3`],
      ["spring.datasource.url", "jdbc:postgresql://***@localhost/shop", false, true, [{ name: "SHOP_DB_URL", set: false }], `${APP}:5`],
      ["spring.datasource.password", null, true, true, [{ name: "SHOP_DB_PASSWORD", set: true }], `${APP}:6`],
      ["orders.base-url", `\${SHOP_ORDERS_URL}`, false, false, [{ name: "SHOP_ORDERS_URL", set: false }], `${APP}:8`],
      ["orders.api-key", null, true, true, [], `${LOCAL}:2`],
      ["server.port", "8081", false, true, [], `${LOCAL}:3`],
    ]);
    for (const secret of ["local-api-key-value", "committed-api-key-value", "mise-db-password-value", "committed-db-pw"])
      expect(text).not.toContain(secret);
  }, 60_000);

  test("with task reads that task's worktree, not the repo root; a task of another repo is bad_request", async () => {
    const task = await daemon.facade.agents.createTask("shop", "rename the app");
    writeFileSync(join(task.worktree, APP), "spring.application.name: shop-renamed\n");

    const { config } = await appConfig({ repo: "shop", task: task.id, key: "spring.application" });
    expect(config).toMatchObject({ repo: "shop", task: task.id, profile: "default" });
    expect(config.modules.map((m) => [m.app, m.entries.map((e) => e.key)])).toEqual([["shop-renamed", ["spring.application.name"]]]);

    const other = await client.callTool({ name: "get_app_config", arguments: { repo: "warehouse", task: task.id } });
    expect(other.content).toEqual([{ type: "text", text: `bad_request: task ${task.id} is in shop, not in warehouse` }]);
  }, 60_000);

  test.skipIf(process.platform === "win32")(
    "a resource folder that a link leads outside the repo is not read",
    async () => {
      const shop = join(daemon.projects, "shop");
      const outside = mkdtempSync(join(tmpdir(), "trackwall-outside-"));
      writeFileSync(join(outside, "application.yml"), "leaked.key: outside-value\n");
      mkdirSync(join(shop, "evil", "src", "main", "resources"), { recursive: true });
      writeFileSync(join(shop, "evil", APP), "evil.key: tracked\n");
      gitIn(shop, "add", "evil");
      renameSync(join(shop, "evil", "src", "main", "resources"), join(outside, "tracked-resources"));
      symlinkSync(outside, join(shop, "evil", "src", "main", "resources"));

      const { config, text } = await appConfig({ repo: "shop" });
      expect(config.problems).toContainEqual({
        code: "files-not-read",
        path: "evil/src/main/resources",
        message: "the folder leads outside the repo through a link",
      });
      expect(text).not.toContain("outside-value");
    },
    60_000,
  );
});
