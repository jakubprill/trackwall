import { describe, expect, test } from "bun:test";
import { appConfigView, isSecretKey } from "../src/modules/cards/app-config.ts";
import { expandPlaceholders } from "../src/modules/cards/placeholders.ts";
import { readSpringConfigs } from "../src/modules/cards/spring-config.ts";

function configsOf(files: Record<string, string>) {
  const out = { problems: [] };
  return readSpringConfigs({ paths: Object.keys(files), text: (path) => files[path] }, out);
}

function view(files: Record<string, string>, vars: NodeJS.ProcessEnv = {}, request: { profile?: string; key?: string } = {}) {
  return appConfigView(
    configsOf(files),
    { profile: request.profile ?? "default", key: request.key },
    { vars, mask: (text) => text.replaceAll("known-secret-value", "***") },
  );
}

const APP = "src/main/resources/application.yml";

describe("expanding placeholders against the environment", () => {
  test("a key the environment sets wins over its default and stays as its placeholder; a key without any value is missing", () => {
    const expanded = expandPlaceholders(`jdbc:\${DB_HOST:localhost}/\${DB_NAME}?\${opts:x}`, () => undefined, {
      outside: (key) => key === "DB_HOST",
      hidden: () => false,
      budget: { left: 100 },
    });
    expect(expanded).toEqual({
      value: `jdbc:\${DB_HOST}/\${DB_NAME}?x`,
      source: undefined,
      outside: ["DB_HOST"],
      defaulted: ["opts"],
      missing: ["DB_NAME"],
    });
  });

  test("a hidden key is never expanded, from the files or from its default", () => {
    const entry = { value: "plain-file-secret", path: "application.yml", line: 1 };
    const expanded = expandPlaceholders(
      `Password=\${db.password};Token=\${API_TOKEN:dev-token}`,
      (key) => (key === "db.password" ? entry : undefined),
      {
        outside: () => false,
        hidden: (key) => key === "db.password" || key === "API_TOKEN",
        budget: { left: 100 },
      },
    );
    expect(expanded).toMatchObject({ value: `Password=\${db.password};Token=\${API_TOKEN}`, defaulted: ["API_TOKEN"], missing: [] });
  });
});

describe("expanding with a budget", () => {
  test("past the budget of placeholders they stay in the text, and the budget is shared by every expansion", () => {
    const budget = { left: 2 };
    const keys = { outside: () => false, hidden: () => false, budget };
    const get = () => ({ value: "v", path: "application.yml", line: 1 });
    expect(expandPlaceholders(`\${a}\${b}`, get, keys).value).toBe("vv");
    expect(expandPlaceholders(`\${c}`, get, keys).value).toBe(`\${c}`);
    expect(budget.left).toBeLessThan(0);
  });
});

describe("a Spring app's configuration for an agent", () => {
  test("a secret gives only whether it is set, never its value, also when a placeholder's default holds it", () => {
    const [shop] = view({ [APP]: `spring:\n  datasource:\n    password: \${DB_PASSWORD:hunter2-default}\napi-key:\n` }).modules;
    expect(shop?.entries).toEqual([
      {
        key: "spring.datasource.password",
        value: null,
        secret: true,
        set: true,
        env: [{ name: "DB_PASSWORD", set: false }],
        overriddenBy: null,
        path: APP,
        line: 3,
      },
      { key: "api-key", value: null, secret: true, set: false, env: [], overriddenBy: null, path: APP, line: 4 },
    ]);
  });

  test("a secret's value does not reach another entry through a placeholder or a secret placeholder's default", () => {
    const [shop] = view({
      [APP]: `db.password: plain-file-secret\nconn: Server=x;Password=\${db.password}\nfoo: \${API_TOKEN:default-token-abc}\n`,
    }).modules;
    expect(shop?.entries.map((e) => [e.key, e.value, e.set])).toEqual([
      ["db.password", null, true],
      ["conn", `Server=x;Password=\${db.password}`, true],
      ["foo", `\${API_TOKEN}`, true],
    ]);
    expect(JSON.stringify(shop)).not.toMatch(/plain-file-secret|default-token-abc/);
  });

  test("a secret written into a value under an ordinary key hides the value: a JAAS line, a connection string, password=", () => {
    const [shop] = view({
      [APP]: [
        `spring.kafka.properties.sasl.jaas.config: PlainLoginModule required username="u" password="kafkapw";`,
        "spring.cloud.azure.servicebus.connection-string: Endpoint=sb://ns.example/;SharedAccessKeyName=Root;SharedAccessKey=abc=",
        "app.legacy-dsn: host=db;user=shop;pwd=shoppw",
        "encrypt.key: config-server-key",
        "server.port: 8080",
      ].join("\n"),
    }).modules;
    expect(shop?.entries.map((e) => [e.key, e.value, e.secret])).toEqual([
      ["spring.kafka.properties.sasl.jaas.config", null, true],
      ["spring.cloud.azure.servicebus.connection-string", null, true],
      ["app.legacy-dsn", null, true],
      ["encrypt.key", null, true],
      ["server.port", "8080", false],
    ]);
  });

  test("a secret key's default does not show when an expansion stops at its length limit", () => {
    const [shop] = view({ [APP]: `a: ${"x".repeat(4095)}\nv: \${a} Bearer \${jwt.key:s3cr3tDefault}\n` }).modules;
    expect(JSON.stringify(shop)).not.toContain("s3cr3tDefault");
  });

  test("a literal password starting with $ hides the value, a placeholder after password= does not", () => {
    const [shop] = view({ [APP]: `a: host=db;password=$up3rS3cret\nb: host=db;password=\${DB_PASS}\n` }).modules;
    expect(shop?.entries.map((e) => e.value)).toEqual([null, `host=db;password=\${DB_PASS}`]);
  });

  test("a value longer than 2000 characters is cut", () => {
    const [shop] = view({ [APP]: `banner: ${"x".repeat(5000)}\n` }).modules;
    expect(shop?.entries[0]?.value).toBe(`${"x".repeat(2000)}…`);
  });

  test("thousands of placeholders in every value stop at the budget instead of holding the daemon", () => {
    const keys = Array.from({ length: 300 }, (_, i) => `e${i}: ""`).join("\n");
    const fanOut = Array.from({ length: 300 }, (_, i) => `\${e${i}}`).join("");
    const values = Array.from({ length: 200 }, (_, i) => `v${i}: ${fanOut}`).join("\n");
    const started = performance.now();
    const result = view({ [APP]: `${keys}\n${values}\n` });
    expect(result.expansionCut).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a variable a placeholder would read is named also when its default was taken", () => {
    const [shop] = view({ [APP]: `orders.base-url: \${ORDERS_URL:http://localhost:8081}\n` }).modules;
    expect(shop?.entries[0]).toMatchObject({ value: "http://localhost:8081", set: true, env: [{ name: "ORDERS_URL", set: false }] });
  });

  test("variables a value reads are named with whether the run has them, and the one Spring Boot binds to the key overrides it", () => {
    const [shop] = view(
      { [APP]: `orders:\n  base-url: \${ORDERS_URL}\n  timeout: \${orders.read-timeout}\nspring.datasource.url: jdbc:h2:mem:shop\n` },
      { ORDERS_URL: "http://orders:8080", SPRING_DATASOURCE_URL: "jdbc:postgresql://db/shop" },
    ).modules;
    expect(shop?.entries.map((e) => [e.key, e.value, e.set, e.env, e.overriddenBy])).toEqual([
      ["orders.base-url", `\${ORDERS_URL}`, true, [{ name: "ORDERS_URL", set: true }], null],
      ["orders.timeout", `\${orders.read-timeout}`, false, [{ name: "ORDERS_READ_TIMEOUT", set: false }], null],
      ["spring.datasource.url", "jdbc:h2:mem:shop", true, [], "SPRING_DATASOURCE_URL"],
    ]);
  });

  test("a value's address loses its user, password and query, and a known secret value is masked", () => {
    const [shop] = view({
      [APP]: "spring.datasource.url: jdbc:postgresql://shop:pw@db:5432/shop?password=pw\nnote: token known-secret-value here\n",
    }).modules;
    expect(shop?.entries.map((e) => e.value)).toEqual(["jdbc:postgresql://***@db:5432/shop", "token *** here"]);
  });

  test("a profile's view overrides the files without a profile; a profile the files do not name gives those files alone", () => {
    const files = {
      [APP]: "spring:\n  application.name: shop\n  profiles.active: local\nserver.port: 8080\n",
      "src/main/resources/application-local.yml": "server.port: 8081\n",
    };
    const local = view(files, {}, { profile: "local" }).modules[0];
    expect(local).toMatchObject({ module: "", app: "shop", profiles: ["local"], profileFound: true, activeProfiles: "local" });
    expect(local?.entries.find((e) => e.key === "server.port")).toMatchObject({
      value: "8081",
      path: "src/main/resources/application-local.yml",
    });
    const prod = view(files, {}, { profile: "prod" }).modules[0];
    expect(prod?.profileFound).toBe(false);
    expect(prod?.entries.find((e) => e.key === "server.port")?.value).toBe("8080");
  });

  test("a key filter compares as Spring does, and Spring Boot's random values are not missing variables", () => {
    const [shop] = view(
      { [APP]: `spring:\n  data-source:\n    pool-size: 5\n  application.instance-id: \${random.uuid}\n` },
      {},
      { key: "SPRING.DATASOURCE" },
    ).modules;
    expect(shop?.entries.map((e) => e.key)).toEqual(["spring.data-source.pool-size"]);
    const [all] = view({ [APP]: `id: \${random.uuid}\n` }).modules;
    expect(all?.entries[0]).toMatchObject({ value: `\${random.uuid}`, set: true, env: [] });
  });

  test("entries over the limit of 500 are left out across modules and the result says so", () => {
    const keys = Array.from({ length: 300 }, (_, i) => `k${i}: v`).join("\n");
    const result = view({ [`a/${APP}`]: keys, [`b/${APP}`]: keys });
    expect(result.modules.map((m) => [m.module, m.entries.length])).toEqual([
      ["a", 300],
      ["b", 200],
    ]);
    expect(result.truncated).toBe(true);
  });
});

describe("which keys are secrets", () => {
  test.each([
    ["spring.datasource.password", true],
    ["spring.security.oauth2.client.registration.shop.client-secret", true],
    ["payments.apiKey", true],
    ["jwt.private-key", true],
    ["gitlab.token", true],
    ["jwt.signingKey", true],
    ["spring.kafka.consumer.key-deserializer", false],
    ["spring.datasource.url", false],
    ["server.port", false],
    ["orders.path", false],
  ])("%s is a secret: %p", (key, secret) => {
    expect(isSecretKey(key)).toBe(secret);
  });
});
