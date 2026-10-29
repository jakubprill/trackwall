import { describe, expect, test } from "bun:test";
import type { ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { methodName } from "../src/modules/cards/openapi-endpoints.ts";
import { isSpecCandidate, MAX_OPERATIONS, mayBeSpec } from "../src/modules/cards/openapi-spec.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { NO_REACH, snapshotOf } from "./support/snapshot.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

const parsers = await loadSyntaxParsers();

const POM = "<project><groupId>com.example</groupId><artifactId>app</artifactId></project>";
const CONFIG = "spring:\n  application:\n    name: orders\n";

function card(files: Record<string, string>): RepoCard {
  return extractCard(snapshotOf({ "pom.xml": POM, "src/main/resources/application.yml": CONFIG, ...files }), parsers, NO_REACH);
}

/** Each endpoint as `<source> <method> <path> <handler> <request> → <response> <operation id>: <summary> @<evidence>`. */
function endpoints(c: RepoCard): string[] {
  return c.provides
    .filter((p): p is ProvidedEndpoint => p.kind === "endpoint")
    .map(
      (e) =>
        `${e.source} ${e.method} ${e.path} ${e.handler} ${e.request} → ${e.response} ${e.operation?.id}: ${e.operation?.summary} @${e.evidence.path}:${e.evidence.line}`,
    );
}

const ORDERS_SPEC = `openapi: 3.0.1
info: { title: Orders, version: "1" }
paths:
  /api/orders/{id}:
    get:
      operationId: getOrder
      responses:
        "200": { description: ok }
`;

describe("endpoints from OpenAPI specs (ADR-87)", () => {
  test("catalog: operations of a spec the build generates an interface from, under the context path and the mapping of the controller implementing it; the client spec gives none", () => {
    const c = extractCard(snapshotOf(fixtureFiles("catalog")), parsers, NO_REACH);
    const spec = "src/main/resources/openapi/catalog.yaml";
    expect(endpoints(c)).toEqual([
      // The mapping in the code, with ${catalog.api-prefix} expanded, gets the operation that describes it.
      "code GET /catalog/api/categories CategoriesController.listCategories null → List<String> listCategories: List product categories @src/main/java/com/example/catalog/CategoriesController.java:9",
      `openapi GET /catalog/api/products/{productId} ProductsController.getProduct null → Product getProduct: Get a product by its id @${spec}:12`,
      `openapi POST /catalog/api/products ProductsController.createProduct NewProduct → Product createProduct: Add a product to the catalog @${spec}:31`,
      `openapi GET /catalog/api/products/{productId}/stock ProductsController.getProductStock null → List<StockLevel> get-product-stock: Stock level of a product in every warehouse. @${spec}:44`,
      // No controller method is named like the operation, so the endpoint has no handler.
      // No handler, so no controller mapping in front: the app serves it where the generated interface maps it.
      `openapi GET /catalog/products/search null null → null searchProducts: Search products by name @${spec}:59`,
    ]);
    expect(c.problems).toEqual([]);
  });

  test("a Swagger 2 JSON spec in the root with basePath, a body parameter and a 200 schema belongs to the repo's only app", () => {
    const c = card({
      "swagger.json": JSON.stringify(
        {
          swagger: "2.0",
          basePath: "/v1",
          paths: {
            "/orders": {
              post: {
                operationId: "placeOrder",
                parameters: [{ in: "body", name: "order", schema: { $ref: "#/definitions/NewOrder" } }],
                responses: { "200": { schema: { type: "array", items: { $ref: "#/definitions/Order" } } } },
              },
              trace: { operationId: "traceOrders" },
            },
          },
        },
        null,
        2,
      ),
    });
    expect(endpoints(c)).toEqual(["openapi POST /v1/orders null NewOrder → List<Order> placeOrder: null @swagger.json:6"]);
    expect(c.provides.find((p) => p.kind === "endpoint")?.app).toBe("orders");
  });

  test("a spec whose server address already has the context path does not get it twice", () => {
    const c = card({
      "src/main/resources/application.yml": `${CONFIG}server:\n  servlet:\n    context-path: /orders\n`,
      "src/main/resources/openapi.yaml": ORDERS_SPEC.replace("paths:", "servers:\n  - url: https://orders.example.com/orders\npaths:"),
    });
    expect(endpoints(c)).toEqual([
      "openapi GET /orders/api/orders/{id} null null → null getOrder: null @src/main/resources/openapi.yaml:7",
    ]);
  });

  test("a spec the build generates a client from (Maven java, Spring Cloud Feign, Gradle with $rootDir, a property in front of the path) is not an endpoint of the repo", () => {
    const pom = (generator: string, library: string, spec: string) =>
      `<project><groupId>g</groupId><artifactId>a</artifactId><build><plugins><plugin>
        <artifactId>openapi-generator-maven-plugin</artifactId>
        <configuration><generatorName>${generator}</generatorName><library>${library}</library></configuration>
        <executions><execution><configuration><inputSpec>${spec}</inputSpec></configuration></execution></executions>
      </plugin></plugins></build></project>`;
    const specFile = "src/main/resources/api/orders-api.yaml";
    expect(endpoints(card({ "pom.xml": pom("java", "restclient", specFile), [specFile]: ORDERS_SPEC }))).toEqual([]);
    expect(endpoints(card({ "pom.xml": pom("spring", "spring-cloud", `\${basedir}/${specFile}`), [specFile]: ORDERS_SPEC }))).toEqual([]);
    expect(endpoints(card({ "pom.xml": pom("java", "native", `\${specs.dir}/orders-api.yaml`), [specFile]: ORDERS_SPEC }))).toEqual([]);
    const gradle = `plugins { id("org.openapi.generator") version "7.8.0" }
openApiGenerate {
    generatorName.set("java")
    inputSpec.set("$rootDir/specs/orders-api.yaml")
}`;
    expect(endpoints(card({ "build.gradle.kts": gradle, "specs/orders-api.yaml": ORDERS_SPEC }))).toEqual([]);
    const throughFile = `openApiGenerate {
    generatorName.set("java")
    inputSpec.set(layout.projectDirectory.file("specs/orders-api.yaml").asFile.path)
}`;
    expect(endpoints(card({ "build.gradle.kts": throughFile, "specs/orders-api.yaml": ORDERS_SPEC }))).toEqual([]);
    // The same spec with a server generator describes this repo's API.
    expect(endpoints(card({ "pom.xml": pom("spring", "spring-boot", specFile), [specFile]: ORDERS_SPEC }))).toHaveLength(1);
  });

  test("the generated controller (without interfaceOnly) serves the operations under openapi.<title>.base-path, by default the server path", () => {
    const spec = ORDERS_SPEC.replace("paths:", "servers:\n  - url: http://localhost:8080/api\npaths:").replace(
      "/api/orders/{id}",
      "/orders/{id}",
    );
    const pom = (options: string) =>
      `<project><groupId>g</groupId><artifactId>a</artifactId><build><plugins><plugin>
        <artifactId>openapi-generator-maven-plugin</artifactId>
        <configuration><inputSpec>openapi.yaml</inputSpec><generatorName>spring</generatorName><configOptions>${options}</configOptions></configuration>
      </plugin></plugins></build></project>`;
    const paths = (files: Record<string, string>) => endpoints(card({ "openapi.yaml": spec, ...files })).map((e) => e.split(" ")[2]);
    expect(paths({ "pom.xml": pom("<delegatePattern>true</delegatePattern>") })).toEqual(["/api/orders/{id}"]);
    expect(
      paths({
        "pom.xml": pom("<delegatePattern>true</delegatePattern>"),
        "src/main/resources/application.yml": `${CONFIG}openapi:\n  orders:\n    base-path: /v2\n`,
      }),
    ).toEqual(["/v2/orders/{id}"]);
    // With interfaceOnly the interface maps the bare path, under the implementing controller's own mapping.
    expect(paths({ "pom.xml": pom("<interfaceOnly>true</interfaceOnly>") })).toEqual(["/orders/{id}"]);
    const gradle = `openApiGenerate {
    generatorName.set("spring")
    inputSpec.set("$projectDir/openapi.yaml")
    configOptions.set(mapOf("interfaceOnly" to "true"))
}`;
    const controller =
      '@RestController @RequestMapping("/shop") public class Orders implements OrdersApi { public Order getOrder(String id) { return null; } }';
    expect(paths({ "build.gradle.kts": gradle, "src/main/java/a/Orders.java": controller })).toEqual(["/shop/orders/{id}"]);
  });

  test("the handler is a class implementing the generated delegate, and no handler when two controllers of the module have the method", () => {
    const delegate = `@Service public class OrdersService implements OrdersApiDelegate {
  @Override public ResponseEntity<Order> getOrder(String id) { return null; }
}`;
    expect(
      card({ "openapi.yaml": ORDERS_SPEC, "src/main/java/a/OrdersService.java": delegate }).provides.find((p) => p.kind === "endpoint"),
    ).toMatchObject({
      handler: "OrdersService.getOrder",
    });
    const controller = (name: string) =>
      `@RestController public class ${name} implements OrdersApi { public Order getOrder(String id) { return null; } }`;
    const ambiguous = card({
      "openapi.yaml": ORDERS_SPEC,
      "src/main/java/a/A.java": controller("A"),
      "src/main/java/a/B.java": controller("B"),
    });
    expect(ambiguous.provides.find((p) => p.kind === "endpoint")).toMatchObject({ handler: null });
  });

  test("YAML that is not a spec gives nothing, and a spec that is not valid YAML is a card problem", () => {
    const c = card({ "src/main/resources/api.yaml": "rate-limit: 10\n", "openapi.yaml": "openapi: 3.0.0\npaths: [unclosed\n" });
    expect(endpoints(c)).toEqual([]);
    expect(c.problems.map((p) => [p.code, p.path])).toEqual([["file-invalid", "openapi.yaml"]]);
  });

  test("a spec with more operations than the card keeps gives the first ones and a card problem", () => {
    const paths = Array.from({ length: MAX_OPERATIONS + 1 }, (_, i) => `  /items/${i}:\n    get: {}\n`).join("");
    const c = card({ "openapi.yaml": `openapi: 3.1.0\npaths:\n${paths}` });
    expect(endpoints(c)).toHaveLength(MAX_OPERATIONS);
    expect(c.problems.map((p) => [p.code, p.path])).toEqual([["truncated", "openapi.yaml"]]);
  });

  test("a spec is found by its openapi or swagger key whatever its name, in YAML or JSON outside test code", () => {
    expect(
      ["openapi.yaml", "docs/orders.yml", "src/main/resources/static/v1.json", "src/test/resources/openapi.yaml", "README.md"].filter(
        isSpecCandidate,
      ),
    ).toEqual(["openapi.yaml", "docs/orders.yml", "src/main/resources/static/v1.json"]);
    expect(
      ["openapi: 3.0.3\n", '{\n  "swagger": "2.0",\n', '{"openapi":"3.1.0","paths":{}}', "spring:\n  openapi: x\n", "name: openapi\n"].map(
        mayBeSpec,
      ),
    ).toEqual([true, true, true, false, false]);
    const c = card({ "contracts-v2/shop.yml": ORDERS_SPEC });
    expect(endpoints(c)).toEqual(["openapi GET /api/orders/{id} null null → null getOrder: null @contracts-v2/shop.yml:5"]);
  });

  test("a file of blank lines, or one long line of blanks, is checked for a spec key in linear time", () => {
    const started = performance.now();
    expect(mayBeSpec(`${"\n".repeat(1_000_000)}x`)).toBe(false);
    expect(mayBeSpec(`${" ".repeat(1_000_000)}x`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("operations sharing an operationId describe the mapped endpoints by path, not by the first handler with that name", () => {
    const spec = `openapi: 3.0.3
paths:
  /orders:
    get:
      operationId: list
      summary: List orders
  /users:
    get:
      operationId: list
      summary: List users
`;
    const c = card({
      "openapi.yaml": spec,
      "src/main/java/a/Users.java": '@RestController class Users { @GetMapping("/users") List<User> list() {} }',
      "src/main/java/a/Orders.java": '@RestController class Orders { @GetMapping("/orders") List<Order> list() {} }',
    });
    expect(c.provides.flatMap((p) => (p.kind === "endpoint" ? [`${p.source} ${p.path} ${p.operation?.summary}`] : [])).sort()).toEqual([
      "code /orders List orders",
      "code /users List users",
    ]);
  });

  test("a frontend repo without a Java build keeps the specs of the backends it calls, so they give no endpoints", () => {
    const c = extractCard(snapshotOf({ "package.json": '{"name":"shop-web"}', "openapi.yaml": ORDERS_SPEC }), parsers, NO_REACH);
    expect(endpoints(c)).toEqual([]);
  });

  test("the method name of an operation is its operationId in camelCase, as the OpenAPI generator names it", () => {
    expect(["getOrder", "get-order", "get_order", "GetOrder", "orders.list"].map(methodName)).toEqual([
      "getOrder",
      "getOrder",
      "getOrder",
      "getOrder",
      "ordersList",
    ]);
  });
});

describe("clients from the OpenAPI specs of other apps (ADR-129)", () => {
  /** Each spec client as `<name> <url>: <method> <path> <operationId> @<line>, …`. */
  function specClients(c: RepoCard): string[] {
    return c.consumes.flatMap((h) =>
      h.kind === "http" && h.via === "openapi"
        ? [
            `${h.name} ${h.url} @${h.evidence.path}: ${h.calls.map((x) => `${x.method} ${x.path} ${x.operationId} @${x.evidence.line}`).join(", ")}`,
          ]
        : [],
    );
  }

  test("a frontend's spec is a client named by its title, with the server address and every operation as a call", () => {
    const spec = `openapi: 3.0.1
info: { title: Orders BFF, version: "1" }
servers:
  - url: https://user:secret@{host}/shop
    variables:
      host: { default: gateway.example.com }
paths:
  /v1/orders/{orderId}:
    get:
      operationId: getOrder
      responses: { "200": { description: ok } }
    delete:
      responses: { "204": { description: gone } }
`;
    const c = extractCard(snapshotOf({ "package.json": '{"name":"shop-web"}', "src/api/orders.yaml": spec }), parsers, NO_REACH);
    expect(specClients(c)).toEqual([
      "Orders BFF https://***@gateway.example.com/shop @src/api/orders.yaml: GET /v1/orders/{orderId} getOrder @9, DELETE /v1/orders/{orderId} null @12",
    ]);
  });

  test("a relative server path goes in front of the calls, and a spec without a title is named by its file", () => {
    const spec = ORDERS_SPEC.replace('info: { title: Orders, version: "1" }\n', "servers: [{ url: /orders-bff }]\n");
    const c = extractCard(snapshotOf({ "package.json": '{"name":"shop-web"}', "openapi/orders-bff.yaml": spec }), parsers, NO_REACH);
    expect(specClients(c)).toEqual(["orders-bff null @openapi/orders-bff.yaml: GET /orders-bff/api/orders/{id} getOrder @5"]);
  });

  test("catalog: the spec the build generates a client from is a client, and the spec it generates its interface from is not", () => {
    const c = extractCard(snapshotOf(fixtureFiles("catalog")), parsers, NO_REACH);
    expect(specClients(c)).toEqual(["Orders null @src/main/resources/openapi/orders-api.yaml: GET /api/orders/{id} getOrder @7"]);
  });
});
