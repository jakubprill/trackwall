import { describe, expect, test } from "bun:test";
import type { ConsumedHttp, ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { resolvePlaceholders } from "../src/modules/cards/placeholders.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { snapshotOf } from "./support/snapshot.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

const parsers = await loadSyntaxParsers();

const POM = "<project><groupId>com.example</groupId><artifactId>app</artifactId></project>";

function card(files: Record<string, string>): RepoCard {
  return extractCard(snapshotOf({ "pom.xml": POM, ...files }), parsers);
}

function endpoints(c: RepoCard): string[] {
  return c.provides
    .filter((p): p is ProvidedEndpoint => p.kind === "endpoint")
    .map((e) => `${e.method ?? "*"} ${e.path} ${e.handler}:${e.evidence.line}`);
}

function clients(c: RepoCard): ConsumedHttp[] {
  return c.consumes.filter((p): p is ConsumedHttp => p.kind === "http");
}

function summary(c: RepoCard): string[] {
  return clients(c).map((h) => {
    const calls = h.calls.map((call) => `${call.method ?? "*"} ${call.path}`).join(", ");
    return `${h.via} ${h.name} app=${h.app} url=${h.url} [${h.profiles.join(",")}] {${calls}}`;
  });
}

describe("karta repo Spring z fixture'ów sklepu", () => {
  test(`orders-api: aplikacja z portem z \${PORT:8081}, endpointy ze stałymi ścieżek, bez kodu z src/test i adnotacji w komentarzach`, () => {
    const c = extractCard(snapshotOf(fixtureFiles("orders-api")), parsers);
    expect(c.provides.filter((p) => p.kind === "app")).toEqual([
      { kind: "app", name: "orders-api", port: 8081, module: "", evidence: { path: "src/main/resources/application.yml", line: 3 } },
    ]);
    expect(endpoints(c)).toEqual([
      "GET /api/orders/{id} OrdersController.get:19",
      "POST /api/orders OrdersController.create:27",
      "PUT /api/orders/{id}/cancel OrdersController.cancel:33",
    ]);
    expect(c.problems).toEqual([]);
  });

  test("orders-bff: klient Feign w Kotlinie z adresem w każdym profilu, WebClient z @Value i adres Zipkina z konfiguracji", () => {
    expect(summary(extractCard(snapshotOf(fixtureFiles("orders-bff")), parsers))).toEqual([
      "webclient PaymentsGateway app=null url=http://payments-service:8080/api [default] {POST /payments/{orderId}}",
      "feign OrdersClient app=orders-api url=http://localhost:8081 [default] {GET /api/orders/{id}, POST /api/orders}",
      "feign OrdersClient app=orders-api url=http://orders-api.shop.svc.cluster.local [prod] {GET /api/orders/{id}, POST /api/orders}",
      "config management.zipkin.tracing.endpoint app=null url=http://zipkin:9411/api/v2/spans [default] {}",
    ]);
  });

  test("payments: application.properties z dokumentem #--- dla profilu prod i Gradle", () => {
    const c = extractCard(snapshotOf(fixtureFiles("payments")), parsers);
    expect(c.provides.filter((p) => p.kind === "app").map((a) => [a.name, a.port])).toEqual([["payments-service", 8082]]);
    expect(endpoints(c)).toEqual(["POST /api/payments/{orderId} PaymentsController.pay:12"]);
  });

  test("legacy-reports: RestTemplate bez adresu bazowego daje wywołania ze zmienną w miejscu sklejanego argumentu", () => {
    expect(summary(extractCard(snapshotOf(fixtureFiles("legacy-reports")), parsers))).toEqual([
      "rest-template OrdersReport app=null url=null [] {GET /api/orders/{}, PUT /api/orders/{}/cancel}",
    ]);
  });

  test("shop-web: adres API z .env i cel proxy Vite", () => {
    expect(summary(extractCard(snapshotOf(fixtureFiles("shop-web")), parsers))).toEqual([
      "env VITE_API_URL app=null url=http://localhost:8090 [] {}",
      "proxy vite.config.mjs app=null url=http://localhost:8090 [] {}",
    ]);
  });
});

describe("endpointy Spring", () => {
  test("interfejs API-first: adnotacje mapowań z interfejsu, ścieżka kontrolera i server.servlet.context-path; /items i /items/ to jeden endpoint", () => {
    const c = card({
      "src/main/resources/application.properties": "spring.application.name=catalog\nserver.servlet.context-path=/catalog\n",
      "src/main/java/a/CatalogApi.java": [
        "package a;",
        "public interface CatalogApi {",
        '  @GetMapping(value = {"/items", "/items/"}, produces = "application/json")',
        "  List<Item> list();",
        '  @RequestMapping(path = "/items/{id}", method = {RequestMethod.DELETE, RequestMethod.PATCH})',
        "  void remove(@PathVariable String id);",
        "}",
      ].join("\n"),
      "src/main/java/a/CatalogController.java": [
        "package a;",
        "@RestController",
        '@RequestMapping("/v1")',
        "public class CatalogController implements CatalogApi {",
        "  public List<Item> list() { return List.of(); }",
        "}",
      ].join("\n"),
    });
    expect(endpoints(c)).toEqual([
      "GET /catalog/v1/items CatalogController.list:3",
      "DELETE /catalog/v1/items/{id} CatalogController.remove:5",
      "PATCH /catalog/v1/items/{id} CatalogController.remove:5",
    ]);
  });

  test("konstruktor główny Kotlina z klientem Feign nie daje kontrolerowi endpointów klienta", () => {
    const c = card({
      "src/main/kotlin/a/PaymentsClient.kt":
        '@FeignClient(name = "payments")\ninterface PaymentsClient {\n  @GetMapping("/payments/{id}") fun get(@PathVariable id: String): String\n}\n',
      "src/main/kotlin/a/Checkout.kt": [
        "@RestController",
        '@RequestMapping("/bff")',
        "class CheckoutController(private val payments: PaymentsClient) : BaseController() {",
        '  @PostMapping("/checkout") fun checkout() = payments.get("1")',
        "}",
        "class Other @Inject constructor(val p: PaymentsClient)",
      ].join("\n"),
    });
    expect(endpoints(c)).toEqual(["POST /bff/checkout CheckoutController.checkout:4"]);
  });

  test("moduł w katalogu src/ ma endpointy z src/main, a kod testów z src/test nie", () => {
    const c = card({
      "src/orders/src/main/resources/application.yml": "spring:\n  application:\n    name: orders\n",
      "src/orders/src/main/java/a/Api.java": '@RestController\nclass Api {\n  @GetMapping("/orders") String list() { return ""; }\n}\n',
      "src/orders/src/test/java/a/Fake.java": '@RestController\nclass Fake {\n  @GetMapping("/fake") String fake() { return ""; }\n}\n',
    });
    expect(
      c.provides.filter((p) => p.kind !== "package").map((p) => (p.kind === "app" ? `app ${p.name} ${p.module}` : `${p.kind} ${p.path}`)),
    ).toEqual(["app orders src/orders", "endpoint /orders"]);
  });

  test("projekt przykładowy w zasobach testów (src/test/resources/…/src/main) to kod testów, także jego konfiguracja", () => {
    const c = card({
      "src/main/java/a/Api.java": '@RestController\nclass Api {\n  @GetMapping("/orders") String list() { return ""; }\n}\n',
      "src/test/resources/demo/src/main/java/a/Demo.java":
        '@RestController\nclass Demo {\n  @GetMapping("/demo") String demo() { return ""; }\n}\n',
      "src/test/resources/demo/src/main/resources/application.yml": "spring.application.name: demo\nusers.url: http://users\n",
    });
    expect(endpoints(c)).toEqual(["GET /orders Api.list:3"]);
    expect(c.provides.filter((p) => p.kind === "app")).toEqual([]);
    expect(summary(c)).toEqual([]);
  });

  test("klasa generyczna Kotlina: parametry konstruktora głównego za <T> nie są nadtypami", () => {
    const c = card({
      "src/main/kotlin/a/Base.kt": '@RequestMapping("/base")\ninterface Base {\n  @GetMapping("/x") fun x(): String\n}\n',
      "src/main/kotlin/a/Api.kt": "@RestController\nclass Api<T : Any>(private val base: Base) {\n}\n",
    });
    expect(endpoints(c)).toEqual([]);
  });

  test("@RequestMapping bez metody to endpoint dla każdej metody, a klasa bez @Controller nie ma endpointów", () => {
    const c = card({
      "src/main/java/a/Any.java": '@Controller\nclass Any {\n  @RequestMapping("/any")\n  String any() { return ""; }\n}\n',
      "src/main/java/a/NotAController.java": 'class NotAController {\n  @GetMapping("/nope")\n  String nope() { return ""; }\n}\n',
    });
    expect(endpoints(c)).toEqual(["* /any Any.any:3"]);
  });

  test("ścieżka ze stałej z innej klasy i sklejenia, a nieznana stała zostaje jako <Klasa.NAZWA>", () => {
    const c = card({
      "src/main/java/a/Paths.java":
        'final class Paths {\n  static final String ROOT = "/api";\n  static final String USERS = ROOT + "/users";\n}\n',
      "src/main/java/a/Users.java": [
        "@RestController",
        "class Users {",
        '  @GetMapping(Paths.USERS + "/{id}")',
        "  User get() { return null; }",
        "  @PostMapping(Missing.PATH)",
        "  void post() {}",
        "}",
      ].join("\n"),
    });
    expect(endpoints(c)).toEqual(["GET /api/users/{id} Users.get:3", "POST /<Missing.PATH> Users.post:5"]);
  });
});

describe("klienci HTTP Spring", () => {
  test("Feign z url z adnotacji, adres z spring.cloud.openfeign.client.config i path; lb:// daje nazwę aplikacji", () => {
    const c = card({
      "src/main/resources/application.yml": [
        "spring:",
        "  cloud:",
        "    openfeign:",
        "      client:",
        "        config:",
        "          stock:",
        "            url: http://stock.internal:9000",
        "gateway:",
        "  uri: lb://pricing",
      ].join("\n"),
      "src/main/java/a/StockClient.java": [
        '@FeignClient(name = "stock", path = "/v2")',
        '@RequestMapping("/stock")',
        "interface StockClient {",
        '  @GetMapping("/{sku}") Stock get(@PathVariable String sku);',
        "}",
      ].join("\n"),
      "src/main/java/a/Direct.java": `@FeignClient(value = "direct", url = "\${direct.url:http://localhost:7000}")\ninterface Direct {\n  @DeleteMapping("/x") void x();\n}\n`,
    });
    expect(summary(c)).toEqual([
      "feign StockClient app=stock url=http://stock.internal:9000 [default] {GET /v2/stock/{sku}}",
      "feign Direct app=direct url=http://localhost:7000 [default] {DELETE /x}",
      "config gateway.uri app=pricing url=lb://pricing [default] {}",
    ]);
  });

  test("wywołanie z długim ciałem żądania zachowuje adres i metodę, a moduł z ponad 32 profilami ma problem karty", () => {
    const body = Array.from({ length: 100 }, (_, i) => `"k${i}", ${i}`).join(", ");
    const profiles = Array.from(
      { length: 33 },
      (_, i) => `---\nspring.config.activate.on-profile: p${String(i).padStart(2, "0")}\nx: ${i}`,
    ).join("\n");
    const c = card({
      "src/main/resources/application.yml": `x: 0\n${profiles}\n`,
      "src/main/java/a/Rest.java": `class Rest {\n  RestTemplate rest;\n  void x() { rest.exchange("/api/orders", HttpMethod.POST, new HttpEntity<>(Map.of(${body})), String.class); }\n}\n`,
    });
    expect(summary(c)).toEqual(["rest-template Rest app=null url=null [] {POST /api/orders}"]);
    expect(c.problems).toEqual([{ path: "", message: "profiles skipped over the limit of 32 in this module: 1 (the last ones by name)" }]);
  });

  test("plik profilu (application-prod.yml) nadpisuje dokument on-profile z application.yml, jak w Spring Boot", () => {
    const c = card({
      "src/main/resources/application.yml":
        "orders:\n  url: http://localhost:8081\n---\nspring:\n  config:\n    activate:\n      on-profile: prod\norders:\n  url: http://old-prod\n",
      "src/main/resources/application-prod.yml": "orders:\n  url: http://new-prod\n",
    });
    expect(summary(c)).toEqual([
      "config orders.url app=null url=http://localhost:8081 [default] {}",
      "config orders.url app=null url=http://new-prod [prod] {}",
    ]);
  });

  test("interfejs @HttpExchange i RestClient z adresem z konfiguracji", () => {
    const c = card({
      "src/main/resources/application.properties": "clients.users.base-url=http://users:8080\n",
      "src/main/java/a/UsersApi.java":
        '@HttpExchange("/users")\ninterface UsersApi {\n  @GetExchange("/{id}") User get(@PathVariable long id);\n  @PostExchange void create(@RequestBody User u);\n}\n',
      "src/main/java/a/Users.java": [
        "class Users {",
        `  @Value("\${clients.users.base-url}") String base;`,
        "  RestClient client = RestClient.builder().baseUrl(base).build();",
        '  User me() { return client.get().uri("/users/me").retrieve().body(User.class); }',
        "}",
      ].join("\n"),
    });
    expect(summary(c)).toEqual([
      "http-interface UsersApi app=null url=null [] {GET /users/{id}, POST /users}",
      "rest-client Users app=null url=http://users:8080 [default] {GET /users/me}",
    ]);
  });

  test("klucz z @Value wiązany na luzie (baseUrl = base-url), profil z spring.config.activate.on-profile w tym samym pliku, a klucz klienta nie jest osobnym adresem z konfiguracji", () => {
    const c = card({
      "src/main/resources/application.yml": [
        "orders:",
        "  baseUrl: http://localhost:8081",
        "---",
        "spring:",
        "  config:",
        "    activate:",
        "      on-profile: k8s",
        "orders:",
        "  base-url: http://orders",
      ].join("\n"),
      "src/main/java/a/Orders.java": [
        "class Orders {",
        "  WebClient client;",
        `  Orders(@Value("\${orders.base-url}") String url) { client = WebClient.create(url); }`,
        '  void load() { client.get().uri("/api/orders").retrieve(); }',
        "}",
      ].join("\n"),
    });
    expect(summary(c)).toEqual([
      "webclient Orders app=null url=http://localhost:8081 [default] {GET /api/orders}",
      "webclient Orders app=null url=http://orders [k8s] {GET /api/orders}",
    ]);
  });

  test("dwa adresy w jednej linii YAML ({a: …, b: …}): adres klienta z kodu (z doklejoną ścieżką) nie ukrywa drugiego adresu z konfiguracji", () => {
    const c = card({
      "src/main/resources/application.yml": "clients: {orders: http://orders, users: http://users}\n",
      "src/main/java/a/Orders.java": [
        "class Orders {",
        "  WebClient client;",
        `  Orders(@Value("\${clients.orders}/v1") String url) { client = WebClient.create(url); }`,
        '  void load() { client.get().uri("/api/orders").retrieve(); }',
        "}",
      ].join("\n"),
    });
    expect(summary(c)).toEqual([
      "webclient Orders app=null url=http://orders/v1 [default] {GET /api/orders}",
      "config clients.users app=null url=http://users [default] {}",
    ]);
  });
});

describe("sekrety w adresach", () => {
  test("użytkownik, hasło i zapytanie z adresu w application.yml, .env i kodzie nie trafiają na kartę", () => {
    const c = card({
      "src/main/resources/application.yml": "orders:\n  url: http://svc:tajne1@orders:8080/api?token=tajne2\n",
      "src/main/java/a/Rest.java":
        'class Rest {\n  RestTemplate rest;\n  void x() { rest.getForObject("http://ja:tajne3@legacy/api/x?key=tajne4", String.class); }\n}\n',
      "web/package.json": "{}",
      "web/.env": "VITE_API=https://ja:tajne5@api.example.com/v1?k=tajne6\n",
    });
    const text = JSON.stringify(card({}).consumes) + JSON.stringify(c.consumes);
    expect(text).not.toMatch(/tajne/);
    expect(summary(c)).toEqual([
      "rest-template Rest app=null url=http://***@legacy [] {GET /api/x}",
      "config orders.url app=null url=http://***@orders:8080/api [default] {}",
      "env VITE_API app=null url=https://***@api.example.com/v1 [] {}",
    ]);
  });
});

describe(`rozwiązywanie \${...}`, () => {
  const values: Record<string, string> = { a: `\${b}`, b: `\${a}`, host: "orders", url: `http://\${host}:\${port:8080}/\${missing}` };
  const get = (key: string) => (key in values ? { value: values[key] ?? "", path: "application.yml", line: 1 } : undefined);

  test("wartość domyślna po dwukropku, zagnieżdżone klucze i nierozwiązany klucz zostaje tekstem", () => {
    expect(resolvePlaceholders(`\${url}`, get).value).toBe(`http://orders:8080/\${missing}`);
    expect(resolvePlaceholders(`\${nope:\${host}}`, get).value).toBe("orders");
  });

  test("cykl między kluczami nie zapętla rozwiązywania", () => {
    expect(resolvePlaceholders(`\${a}`, get).value).toContain(`\${`);
  });
});
