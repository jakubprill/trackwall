import { describe, expect, test } from "bun:test";
import { appConfigView, isSecretKey, withoutAddressCredentials } from "../src/modules/cards/app-config.ts";
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
    const expanded = expandPlaceholders(
      `jdbc:\${DB_HOST:localhost}/\${DB_NAME}?\${opts:x}`,
      () => undefined,
      (key) => key === "DB_HOST",
    );
    expect(expanded).toEqual({ value: `jdbc:\${DB_HOST}/\${DB_NAME}?x`, source: undefined, outside: ["DB_HOST"], missing: ["DB_NAME"] });
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
        env: [],
        overriddenBy: null,
        path: APP,
        line: 3,
      },
      { key: "api-key", value: null, secret: true, set: false, env: [], overriddenBy: null, path: APP, line: 4 },
    ]);
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
    expect(local).toMatchObject({ module: "", app: "shop", profiles: ["local"], activeProfiles: "local" });
    expect(local?.entries.find((e) => e.key === "server.port")).toMatchObject({
      value: "8081",
      path: "src/main/resources/application-local.yml",
    });
    expect(view(files, {}, { profile: "prod" }).modules[0]?.entries.find((e) => e.key === "server.port")?.value).toBe("8080");
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
    ["spring.datasource.url", false],
    ["server.port", false],
    ["orders.path", false],
  ])("%s is a secret: %p", (key, secret) => {
    expect(isSecretKey(key)).toBe(secret);
  });
});

describe("addresses in values", () => {
  test.each([
    ["http://me:pw@orders:8080/api?key=x", "http://***@orders:8080/api"],
    ["jdbc:postgresql://db:5432/shop", "jdbc:postgresql://db:5432/shop"],
    ["redis://:pw@cache:6379", "redis://***@cache:6379"],
    ["no address here", "no address here"],
  ])("%s becomes %s", (value, masked) => {
    expect(withoutAddressCredentials(value)).toBe(masked);
  });
});
